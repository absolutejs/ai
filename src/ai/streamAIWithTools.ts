import type {
  AIProviderContentBlock,
  AIProviderMessage,
  AIProviderToolChoice,
  AIToolMap,
  AIUsage,
} from "../../types/ai";
import {
  mergeUsage,
  toProviderTools,
  type GenerateAIOptions,
  type GenerateAIToolCall,
} from "./generateAI";

const DEFAULT_STREAM_TOOL_MAX_TURNS = 8;

export type StreamAIWithToolsOptions = Omit<
  GenerateAIOptions,
  "tools" | "toolChoice"
> & {
  /** Tools the model may call — each with a `handler` the loop runs on its behalf. */
  tools: AIToolMap;
  /** Max model⇄tool round-trips before forcing a final answer. Default 8. */
  maxTurns?: number;
  toolChoice?: AIProviderToolChoice;
};

export type StreamAIWithToolsSummary = {
  /** All assistant text across every turn, concatenated in stream order. */
  text: string;
  /** Every tool call the model made (executed or not), in order. */
  toolCalls: GenerateAIToolCall[];
  /** Model turns consumed (1 = no tool round-trips). */
  turns: number;
  /** Summed usage across all turns. */
  usage?: AIUsage;
};

export type StreamAIWithToolsEvent =
  | { type: "thinking"; content: string }
  | { type: "text"; content: string }
  /** A model turn finished streaming — carries that turn's own usage, so
   *  metering can bill per-turn instead of waiting for the summed total. */
  | { type: "turn"; usage?: AIUsage }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      input: unknown;
      ms: number;
      /** False when the handler threw or the tool name was unknown. */
      ok: boolean;
      result: string;
    }
  | ({ type: "done" } & StreamAIWithToolsSummary);

const toolCallKey = (call: GenerateAIToolCall) =>
  `${call.name}:${JSON.stringify(call.input)}`;

// Coalesce contiguous text deltas into one content block (providers stream text
// as many small chunks; sending each back as its own block bloats the thread).
const pushText = (blocks: AIProviderContentBlock[], content: string) => {
  const last = blocks[blocks.length - 1];
  if (last && last.type === "text") {
    last.content += content;

    return;
  }
  blocks.push({ content, type: "text" });
};

type ThinkingAccumulator = { signature: string; text: string };

const flushThinking = (
  blocks: AIProviderContentBlock[],
  thinking: ThinkingAccumulator | null,
) => {
  if (!thinking) return null;
  blocks.push({
    signature: thinking.signature || undefined,
    thinking: thinking.text,
    type: "thinking",
  });

  return null;
};

type TurnOutcome = {
  blocks: AIProviderContentBlock[];
  pending: GenerateAIToolCall[];
  usage?: AIUsage;
};

const executeToolHandler = async (
  tools: AIToolMap,
  call: GenerateAIToolCall,
) => {
  const definition = tools[call.name];
  if (!definition) {
    return { ok: false, result: `Error: unknown tool "${call.name}"` };
  }
  try {
    return { ok: true, result: await definition.handler(call.input) };
  } catch (err) {
    return {
      ok: false,
      result: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * Agentic STREAMING generation: text/thinking deltas are yielded live while the
 * model may call the provided handler tools mid-answer — the loop runs them,
 * feeds the results back, and continues streaming until the model finishes (or
 * `maxTurns`). Transport-agnostic (an async generator, unlike the WebSocket
 * `streamAI`), so HTTP/SSE handlers can re-encode events however they like.
 *
 * Event order per turn: thinking/text deltas → turn → tool_start/tool_result
 * pairs → next turn's deltas… → done (with the summed usage + full text).
 */
export const streamAIWithTools = async function* (
  options: StreamAIWithToolsOptions,
): AsyncGenerator<StreamAIWithToolsEvent, StreamAIWithToolsSummary> {
  const {
    maxTurns = DEFAULT_STREAM_TOOL_MAX_TURNS,
    provider,
    toolChoice,
    tools,
    ...base
  } = options;
  const providerTools = toProviderTools(tools);
  const allToolCalls: GenerateAIToolCall[] = [];
  const executedKeys = new Set<string>();
  const messages: AIProviderMessage[] = [...options.messages];
  let usage: AIUsage | undefined;
  let fullText = "";
  let turn = 0;

  const streamOneTurn = async function* (): AsyncGenerator<
    StreamAIWithToolsEvent,
    TurnOutcome
  > {
    const stream = provider.stream({
      cacheSystemPrompt: base.cacheSystemPrompt,
      maxTokens: base.maxTokens,
      messages,
      model: base.model,
      promptCaching: base.promptCaching,
      providerOptions: base.providerOptions,
      reasoning: base.reasoning,
      signal: base.signal,
      stopSequences: base.stopSequences,
      systemPrompt: base.systemPrompt,
      temperature: base.temperature,
      toolChoice: toolChoice ?? "auto",
      tools: providerTools,
      topP: base.topP,
    });

    const blocks: AIProviderContentBlock[] = [];
    const pending: GenerateAIToolCall[] = [];
    let thinking: ThinkingAccumulator | null = null;
    let turnUsage: AIUsage | undefined;

    for await (const chunk of stream) {
      if (base.signal?.aborted) break;
      if (chunk.type === "thinking") {
        if (chunk.content) yield { content: chunk.content, type: "thinking" };
        thinking = thinking ?? { signature: "", text: "" };
        thinking.text += chunk.content;
        if (chunk.signature) thinking.signature = chunk.signature;
      } else if (chunk.type === "text") {
        thinking = flushThinking(blocks, thinking);
        fullText += chunk.content;
        pushText(blocks, chunk.content);
        yield { content: chunk.content, type: "text" };
      } else if (chunk.type === "tool_use") {
        thinking = flushThinking(blocks, thinking);
        pending.push({ id: chunk.id, input: chunk.input, name: chunk.name });
        blocks.push({
          id: chunk.id,
          // Providers (Anthropic) require tool_use.input to be an object on the
          // way back; a no-arg tool can parse to null/undefined, so coerce to {}.
          input:
            chunk.input && typeof chunk.input === "object" ? chunk.input : {},
          name: chunk.name,
          providerData: chunk.providerData,
          type: "tool_use",
        });
      } else if (chunk.type === "provider_event") {
        thinking = flushThinking(blocks, thinking);
        blocks.push({
          data: chunk.data,
          provider: chunk.provider,
          type: "provider_data",
        });
      } else if (chunk.type === "done") {
        thinking = flushThinking(blocks, thinking);
        turnUsage = chunk.usage;
      }
    }
    thinking = flushThinking(blocks, thinking);

    return { blocks, pending, usage: turnUsage };
  };

  while (turn < maxTurns) {
    turn += 1;
    const outcome = yield* streamOneTurn();
    usage = mergeUsage(usage, outcome.usage);
    yield { type: "turn", usage: outcome.usage };

    const { blocks, pending } = outcome;
    allToolCalls.push(...pending);

    // Stop when the model answered without tools, the turn budget is spent, the
    // caller aborted, or every requested call is an exact repeat of one already
    // executed (a stuck model would otherwise loop forever).
    const allRepeats =
      pending.length > 0 &&
      pending.every((call) => executedKeys.has(toolCallKey(call)));
    const finished =
      pending.length === 0 ||
      turn >= maxTurns ||
      allRepeats ||
      base.signal?.aborted === true;
    if (finished) break;

    messages.push({ content: blocks, role: "assistant" });
    const resultBlocks: AIProviderContentBlock[] = [];
    for (const call of pending) {
      yield {
        id: call.id,
        input: call.input,
        name: call.name,
        type: "tool_start",
      };
      const startedAt = Date.now();
      // Sequential on purpose: tool_start/tool_result events stay ordered for
      // live progress UIs, and a caller-side per-tool timeout bounds the cost.
      // eslint-disable-next-line no-await-in-loop
      const { ok, result } = await executeToolHandler(tools, call);
      executedKeys.add(toolCallKey(call));
      yield {
        id: call.id,
        input: call.input,
        ms: Date.now() - startedAt,
        name: call.name,
        ok,
        result,
        type: "tool_result",
      };
      resultBlocks.push({
        content: result,
        tool_use_id: call.id,
        type: "tool_result",
      });
    }
    messages.push({ content: resultBlocks, role: "user" });
  }

  const summary: StreamAIWithToolsSummary = {
    text: fullText,
    toolCalls: allToolCalls,
    turns: turn,
    usage,
  };
  yield { ...summary, type: "done" };

  return summary;
};
