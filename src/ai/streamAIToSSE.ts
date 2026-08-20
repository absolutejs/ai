import type {
  AIChunk,
  AIProviderContentBlock,
  AIProviderMessage,
  AIStreamFinishReason,
  AIStreamStopReason,
  AIToolMap,
  AIUsage,
  StreamAIOptions,
} from "../../types/ai";
import type { ResolvedRenderers } from "./htmxRenderers";

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_HEARTBEAT_MS = 15_000;

type SSEEvent = { data: string; event: string };

// Unique sentinel for "the silence timer fired" — distinguishable from any
// IteratorResult the source could yield.
const HEARTBEAT_TICK = Symbol("heartbeat-tick");

/**
 * Wrap an SSE event generator and emit a `ping` keepalive whenever the source
 * stays silent longer than `intervalMs`. Agentic turns go silent during tool
 * execution and while waiting on the next turn's first token; a silent SSE
 * socket gets reaped by idle-timeout intermediaries (reverse proxies, Bun's own
 * default), hanging the client with no error. The ping is a real (empty-data)
 * SSE event — bytes on the wire reset the idle timer — and downstream code that
 * only handles known event types ignores it.
 *
 * Pings fire ONLY during genuine silence: each loop races the SAME pending
 * `next()` against a fresh timer, so an active stream (events arriving faster
 * than `intervalMs`) emits zero pings and a ping can never split a real event.
 * `intervalMs <= 0` disables the wrapper entirely. The source generator is
 * always finalized (early return / abort included) so it can't leak.
 */
const withHeartbeat = async function* (
  source: AsyncGenerator<SSEEvent>,
  signal: AbortSignal,
  intervalMs: number,
): AsyncGenerator<SSEEvent> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    yield* source;

    return;
  }

  try {
    let next = source.next();
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<typeof HEARTBEAT_TICK>((resolve) => {
        timer = setTimeout(() => resolve(HEARTBEAT_TICK), intervalMs);
      });

      let winner: IteratorResult<SSEEvent> | typeof HEARTBEAT_TICK;
      try {
        winner = await Promise.race([next, tick]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (winner === HEARTBEAT_TICK) {
        if (signal.aborted) return;
        yield { data: "", event: "ping" };

        continue;
      }

      if (winner.done) return;
      yield winner.value;
      next = source.next();
    }
  } finally {
    await source.return?.(undefined);
  }
};

type PendingToolCall = {
  id: string;
  input: unknown;
  name: string;
};

type ThinkingAccumulator = {
  signature: string;
  text: string;
};

const buildToolDefinitions = (tools: AIToolMap) =>
  Object.entries(tools).map(([name, def]) => ({
    description: def.description,
    input_schema: def.input,
    name,
  }));

const executeTool = async (
  options: StreamAIOptions,
  toolName: string,
  toolInput: unknown,
) => {
  const toolDef = options.tools?.[toolName];

  if (!toolDef) {
    return `Error: unknown tool "${toolName}"`;
  }

  try {
    return await toolDef.handler(toolInput);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
};

const serializeToolCall = (name: string, input: unknown) =>
  `${name}:${JSON.stringify(input)}`;

// Event builders — the ONE place the HTML-vs-structured decision lives. With
// `structuredEvents`, `data` is a JSON payload (see the AISSE*Payload types) and
// the overloaded `status` terminal splits into `complete`/`stopped`/`error`;
// otherwise every builder reproduces the pre-existing renderer HTML on `status`.

const contentEvent = (
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
  delta: string,
  full: string,
): SSEEvent =>
  options.structuredEvents
    ? { data: JSON.stringify({ delta, full }), event: "content" }
    : { data: renderers.chunk(delta, full), event: "content" };

const thinkingEvent = (
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
  text: string,
): SSEEvent =>
  options.structuredEvents
    ? { data: JSON.stringify({ text }), event: "thinking" }
    : { data: renderers.thinking(text), event: "thinking" };

const imageEvent = (
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
  data: string,
  format: string,
  revisedPrompt: string | undefined,
): SSEEvent =>
  options.structuredEvents
    ? { data: JSON.stringify({ data, format, revisedPrompt }), event: "images" }
    : { data: renderers.image(data, format, revisedPrompt), event: "images" };

// Terminal builder: normal completion. Preserves the `onComplete` side effect
// that used to live in `yieldCompletion`.
const completeEvent = (
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
  fullResponse: string,
  usage: AIUsage | undefined,
  durationMs: number,
): SSEEvent => {
  options.onComplete?.(fullResponse, usage);

  return options.structuredEvents
    ? {
        data: JSON.stringify({ durationMs, model: options.model, usage }),
        event: "complete",
      }
    : {
        data: renderers.complete(usage, durationMs, options.model),
        event: "status",
      };
};

// Terminal builder: a ceiling/limit/abort stop (not an error). Legacy renders an
// abort with the (previously dead) `canceled` renderer and every other stop as
// an error chip.
const stoppedEvent = (
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
  reason: AIStreamStopReason,
  detail: string,
): SSEEvent => {
  if (options.structuredEvents) {
    return { data: JSON.stringify({ detail, reason }), event: "stopped" };
  }

  return reason === "aborted"
    ? { data: renderers.canceled(), event: "status" }
    : { data: renderers.error(detail), event: "status" };
};

// Terminal builder: a genuine thrown/lookup error.
const errorEvent = (
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
  message: string,
): SSEEvent =>
  options.structuredEvents
    ? { data: JSON.stringify({ message }), event: "error" }
    : { data: renderers.error(message), event: "status" };

export const streamAIToSSE = async function* (
  conversationId: string,
  messageId: string,
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
) {
  const signal = options.signal ?? new AbortController().signal;
  const startTime = Date.now();
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  const messages: AIProviderMessage[] = options.messages
    ? [...options.messages]
    : [];

  try {
    yield* withHeartbeat(
      streamTurns(options, renderers, messages, signal, startTime, maxTurns),
      signal,
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    );
  } catch (err) {
    // A throw during an abort still gets one clean terminal — distinguishable
    // from a natural completion — instead of being silently swallowed.
    if (signal.aborted) {
      yield stoppedEvent(options, renderers, "aborted", "Aborted by caller.");

      return;
    }

    yield errorEvent(
      options,
      renderers,
      err instanceof Error ? err.message : String(err),
    );
  }
};

type TurnState = {
  allToolsHtml: string;
  currentMessages: AIProviderMessage[];
  executedToolKeys: Set<string>;
  fullResponse: string;
  turn: number;
};

type ChunkState = {
  contentBlocks: AIProviderContentBlock[];
  currentThinking: ThinkingAccumulator | null;
  pendingToolCalls: PendingToolCall[];
  stopReason: string | undefined;
  usage: AIUsage | undefined;
};

const flushThinking = (
  thinking: ThinkingAccumulator,
  contentBlocks: AIProviderContentBlock[],
) => {
  contentBlocks.push({
    signature: thinking.signature || undefined,
    thinking: thinking.text,
    type: "thinking",
  });
};

const processThinkingChunk = function* (
  content: string,
  signature: string | undefined,
  chunkState: ChunkState,
  renderers: ResolvedRenderers,
  options: StreamAIOptions,
) {
  chunkState.currentThinking ??= { signature: "", text: "" };
  chunkState.currentThinking.text += content;
  chunkState.currentThinking.signature =
    signature ?? chunkState.currentThinking.signature;
  yield thinkingEvent(options, renderers, chunkState.currentThinking.text);
};

const maybeFlushThinking = (chunkState: ChunkState) => {
  if (!chunkState.currentThinking) return;

  flushThinking(chunkState.currentThinking, chunkState.contentBlocks);
  chunkState.currentThinking = null;
};

const processTextChunk = function* (
  content: string,
  chunkState: ChunkState,
  renderers: ResolvedRenderers,
  fullResponse: string,
  options: StreamAIOptions,
) {
  maybeFlushThinking(chunkState);
  chunkState.contentBlocks.push({
    content,
    type: "text",
  });
  yield contentEvent(options, renderers, content, fullResponse + content);
};

const processImageChunk = function* (
  chunk: AIChunk & { type: "image" },
  renderers: ResolvedRenderers,
  options: StreamAIOptions,
) {
  yield imageEvent(
    options,
    renderers,
    chunk.data,
    chunk.format,
    chunk.revisedPrompt,
  );
  options.onImage?.({
    data: chunk.data,
    format: chunk.format,
    imageId: chunk.imageId,
    isPartial: chunk.isPartial,
    revisedPrompt: chunk.revisedPrompt,
  });
};

const processToolUseChunk = (
  chunk: AIChunk & { type: "tool_use" },
  chunkState: ChunkState,
) => {
  maybeFlushThinking(chunkState);
  chunkState.pendingToolCalls.push({
    id: chunk.id,
    input: chunk.input,
    name: chunk.name,
  });
  chunkState.contentBlocks.push({
    id: chunk.id,
    input:
      typeof chunk.input === "object" && chunk.input !== null
        ? chunk.input
        : {},
    name: chunk.name,
    type: "tool_use",
  });
};

const processChunk = function* (
  chunk: AIChunk,
  chunkState: ChunkState,
  renderers: ResolvedRenderers,
  options: StreamAIOptions,
  fullResponse: string,
) {
  switch (chunk.type) {
    case "thinking":
      yield* processThinkingChunk(
        chunk.content,
        chunk.signature,
        chunkState,
        renderers,
        options,
      );
      break;

    case "text":
      yield* processTextChunk(
        chunk.content,
        chunkState,
        renderers,
        fullResponse,
        options,
      );
      break;

    case "image":
      yield* processImageChunk(chunk, renderers, options);
      break;

    case "tool_use":
      processToolUseChunk(chunk, chunkState);
      break;

    case "done":
      maybeFlushThinking(chunkState);
      chunkState.usage = chunk.usage;
      chunkState.stopReason = chunk.stopReason;
      break;
  }
};

// Clip an oversized tool result to head+tail with a marker so the model knows
// it was clipped. Bounds what re-enters the message array (and thus input cost)
// on every subsequent turn.
const truncateToolResult = (result: string, max: number) => {
  if (result.length <= max) return result;

  const omitted = result.length - max;
  const headLen = Math.ceil(max / 2);
  const tailLen = max - headLen;
  const marker = `\n<result truncated to ${max} chars; ${omitted} omitted — re-read a narrower slice if needed>\n`;

  return (
    result.slice(0, headLen) + marker + result.slice(result.length - tailLen)
  );
};

const executeToolCalls = async function* (
  pendingToolCalls: PendingToolCall[],
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
  turnState: TurnState,
) {
  const toolResultBlocks: Array<{
    content: string;
    tool_use_id: string;
    type: "tool_result";
  }> = [];

  for (const toolCall of pendingToolCalls) {
    // Structured mode emits one granular event per transition; legacy mode
    // accumulates and re-emits the full HTML blob (unchanged behavior).
    if (options.structuredEvents) {
      yield {
        data: JSON.stringify({
          input: toolCall.input,
          name: toolCall.name,
          status: "running",
        }),
        event: "tools",
      };
    } else {
      turnState.allToolsHtml += renderers.toolRunning(
        toolCall.name,
        toolCall.input,
      );
      yield { data: turnState.allToolsHtml, event: "tools" };
    }

    // eslint-disable-next-line no-await-in-loop
    const result = await executeTool(options, toolCall.name, toolCall.input);

    if (options.structuredEvents) {
      yield {
        data: JSON.stringify({
          input: toolCall.input,
          name: toolCall.name,
          result,
          status: "complete",
        }),
        event: "tools",
      };
    } else {
      turnState.allToolsHtml = turnState.allToolsHtml.replace(
        renderers.toolRunning(toolCall.name, toolCall.input),
        renderers.toolComplete(toolCall.name, result),
      );
      yield { data: turnState.allToolsHtml, event: "tools" };
    }

    options.onToolUse?.(toolCall.name, toolCall.input, result);

    // The live UI (toolComplete) and onToolUse see the full result; only the
    // copy fed back into the message array is clipped.
    const resultContent =
      options.maxToolResultChars !== undefined
        ? truncateToolResult(result, options.maxToolResultChars)
        : result;

    toolResultBlocks.push({
      content: resultContent,
      tool_use_id: toolCall.id,
      type: "tool_result",
    });

    turnState.executedToolKeys.add(
      serializeToolCall(toolCall.name, toolCall.input),
    );
  }

  return toolResultBlocks;
};

const consumeStream = async function* (
  stream: AsyncIterable<AIChunk>,
  chunkState: ChunkState,
  renderers: ResolvedRenderers,
  options: StreamAIOptions,
  turnState: TurnState,
  signal: AbortSignal,
) {
  for await (const chunk of stream) {
    if (signal.aborted) break;

    const prevResponse = turnState.fullResponse;
    yield* processChunk(
      chunk,
      chunkState,
      renderers,
      options,
      turnState.fullResponse,
    );
    if (chunk.type !== "text") continue;

    turnState.fullResponse = prevResponse + chunk.content;
  }
};

const shouldStopToolLoop = (
  chunkState: ChunkState,
  turnState: TurnState,
  signal: AbortSignal,
) => {
  if (chunkState.pendingToolCalls.length === 0 || signal.aborted) {
    return true;
  }

  return chunkState.pendingToolCalls.every((toolCall) =>
    turnState.executedToolKeys.has(
      serializeToolCall(toolCall.name, toolCall.input),
    ),
  );
};

const processTurn = async function* (
  chunkState: ChunkState,
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
  turnState: TurnState,
) {
  turnState.currentMessages.push({
    content: chunkState.contentBlocks,
    role: "assistant",
  });

  const toolResults = yield* executeToolCalls(
    chunkState.pendingToolCalls,
    options,
    renderers,
    turnState,
  );

  turnState.currentMessages.push({
    content: toolResults,
    role: "user",
  });
};

const streamTurns = async function* (
  options: StreamAIOptions,
  renderers: ResolvedRenderers,
  messages: AIProviderMessage[],
  signal: AbortSignal,
  startTime: number,
  maxTurns: number,
) {
  const turnState: TurnState = {
    allToolsHtml: "",
    currentMessages: [...messages],
    executedToolKeys: new Set<string>(),
    fullResponse: "",
    turn: 0,
  };

  const toolDefs = options.tools
    ? buildToolDefinitions(options.tools)
    : undefined;

  const aggregateUsage: AIUsage = { inputTokens: 0, outputTokens: 0 };
  let finishReason: AIStreamFinishReason = "max_turns";
  let completedTurns = 0;

  try {
    for (; turnState.turn <= maxTurns && !signal.aborted; turnState.turn++) {
      const chunkState: ChunkState = {
        contentBlocks: [],
        currentThinking: null,
        pendingToolCalls: [],
        stopReason: undefined,
        usage: undefined,
      };

      const responseBeforeTurn = turnState.fullResponse;

      const stream = options.provider.stream({
        cacheSystemPrompt: options.cacheSystemPrompt,
        maxTokens: options.maxTokens,
        messages: turnState.currentMessages,
        model: options.model,
        promptCaching: options.promptCaching,
        providerOptions: options.providerOptions,
        reasoning: options.reasoning,
        signal,
        systemPrompt: options.systemPrompt,
        tools: toolDefs,
      });

      yield* consumeStream(
        stream,
        chunkState,
        renderers,
        options,
        turnState,
        signal,
      );

      // Per-turn observability — fires on every turn, including a truncated
      // one, BEFORE the turn's tools execute. The third argument is exactly the
      // text this turn appended, so onTurn + onToolUse interleave in true
      // transcript order (turn text → that turn's tools → next turn's text…).
      options.onTurn?.(
        turnState.turn,
        chunkState.usage,
        turnState.fullResponse.slice(responseBeforeTurn.length),
      );
      completedTurns += 1;
      aggregateUsage.inputTokens += chunkState.usage?.inputTokens ?? 0;
      aggregateUsage.outputTokens += chunkState.usage?.outputTokens ?? 0;
      aggregateUsage.cacheReadInputTokens =
        (aggregateUsage.cacheReadInputTokens ?? 0) +
        (chunkState.usage?.cacheReadInputTokens ?? 0);
      aggregateUsage.cacheWriteInputTokens =
        (aggregateUsage.cacheWriteInputTokens ?? 0) +
        (chunkState.usage?.cacheWriteInputTokens ?? 0);
      aggregateUsage.costCredits =
        (aggregateUsage.costCredits ?? 0) +
        (chunkState.usage?.costCredits ?? 0);
      aggregateUsage.reasoningTokens =
        (aggregateUsage.reasoningTokens ?? 0) +
        (chunkState.usage?.reasoningTokens ?? 0);
      for (const [key, value] of Object.entries(
        chunkState.usage?.serverToolUse ?? {},
      )) {
        aggregateUsage.serverToolUse ??= {};
        aggregateUsage.serverToolUse[key] =
          (aggregateUsage.serverToolUse[key] ?? 0) + value;
      }
      aggregateUsage.upstreamInferenceCostCredits =
        (aggregateUsage.upstreamInferenceCostCredits ?? 0) +
        (chunkState.usage?.upstreamInferenceCostCredits ?? 0);
      const runningTotalTokens =
        aggregateUsage.inputTokens + aggregateUsage.outputTokens;

      if (chunkState.stopReason === "max_tokens") {
        finishReason = "max_tokens";
        yield stoppedEvent(
          options,
          renderers,
          "max_tokens",
          `Response truncated at max_tokens (output=${chunkState.usage?.outputTokens ?? "?"}). ` +
            `Raise maxTokens on the provider/options, split the request, or reduce upstream context.`,
        );

        return;
      }

      if (
        options.maxTotalTokens &&
        runningTotalTokens >= options.maxTotalTokens
      ) {
        finishReason = "max_total_tokens";
        yield stoppedEvent(
          options,
          renderers,
          "max_total_tokens",
          `Stopped: token budget reached (${runningTotalTokens}/${options.maxTotalTokens} tokens over ` +
            `${turnState.turn} turns). Narrow the request or raise maxTotalTokens.`,
        );

        return;
      }

      if (
        options.maxDurationMs &&
        Date.now() - startTime >= options.maxDurationMs
      ) {
        finishReason = "max_duration";
        yield stoppedEvent(
          options,
          renderers,
          "max_duration_ms",
          `Stopped: time budget reached (${Math.round((Date.now() - startTime) / 1000)}s over ` +
            `${turnState.turn} turns). Narrow the request or raise maxDurationMs.`,
        );

        return;
      }

      if (shouldStopToolLoop(chunkState, turnState, signal)) {
        if (signal.aborted) {
          finishReason = "aborted";
          yield stoppedEvent(
            options,
            renderers,
            "aborted",
            "Aborted by caller.",
          );
        } else {
          finishReason = "complete";
          yield completeEvent(
            options,
            renderers,
            turnState.fullResponse,
            chunkState.usage,
            Date.now() - startTime,
          );
        }

        return;
      }

      yield* processTurn(chunkState, options, renderers, turnState);
    }

    // Fell out of the loop without an inline terminal: either the caller aborted
    // between turns, or maxTurns was exhausted. Emit the one terminal each path
    // used to be missing.
    if (signal.aborted) {
      finishReason = "aborted";
      yield stoppedEvent(options, renderers, "aborted", "Aborted by caller.");
    } else {
      finishReason = "max_turns";
      yield stoppedEvent(
        options,
        renderers,
        "max_turns",
        `Stopped: reached maxTurns (${maxTurns}) without a final answer.`,
      );
    }
  } catch (error) {
    finishReason = signal.aborted ? "aborted" : "error";
    throw error;
  } finally {
    try {
      await options.onFinish?.({
        durationMs: Date.now() - startTime,
        fullResponse: turnState.fullResponse,
        reason: finishReason,
        turns: completedTurns,
        usage: aggregateUsage,
      });
    } catch (error) {
      console.error("[absolute-ai] onFinish rejected:", error);
    }
  }
};
