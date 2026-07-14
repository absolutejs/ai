import type {
  AIChunk,
  AIProviderConfig,
  AIProviderStreamParams,
} from "../../types/ai";
import { ProviderError } from "./errors/providerError";

export type ProviderProxyStreamParams = Omit<
  AIProviderStreamParams,
  "onSpan" | "onUsage" | "signal"
>;

export type RemoteProviderConfig = {
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  url: string;
};

export type ProviderProxyResponseOptions = {
  headers?: HeadersInit;
  heartbeatMs?: number;
  onError?: (error: unknown) => void | Promise<void>;
  signal?: AbortSignal;
};

const DEFAULT_HEARTBEAT_MS = 5_000;
const encoder = new TextEncoder();

const wireParams = (
  params: AIProviderStreamParams,
): ProviderProxyStreamParams => ({
  ...(params.cacheSystemPrompt === undefined
    ? {}
    : { cacheSystemPrompt: params.cacheSystemPrompt }),
  ...(params.frequencyPenalty === undefined
    ? {}
    : { frequencyPenalty: params.frequencyPenalty }),
  ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
  messages: params.messages,
  model: params.model,
  ...(params.parallelToolCalls === undefined
    ? {}
    : { parallelToolCalls: params.parallelToolCalls }),
  ...(params.presencePenalty === undefined
    ? {}
    : { presencePenalty: params.presencePenalty }),
  ...(params.promptCaching === undefined
    ? {}
    : { promptCaching: params.promptCaching }),
  ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
  ...(params.responseFormat === undefined
    ? {}
    : { responseFormat: params.responseFormat }),
  ...(params.seed === undefined ? {} : { seed: params.seed }),
  ...(params.stopSequences === undefined
    ? {}
    : { stopSequences: params.stopSequences }),
  ...(params.systemPrompt === undefined
    ? {}
    : { systemPrompt: params.systemPrompt }),
  ...(params.temperature === undefined
    ? {}
    : { temperature: params.temperature }),
  ...(params.toolChoice === undefined ? {} : { toolChoice: params.toolChoice }),
  ...(params.tools === undefined ? {} : { tools: params.tools }),
  ...(params.topP === undefined ? {} : { topP: params.topP }),
});

export const parseProviderProxyParams = (
  value: unknown,
): ProviderProxyStreamParams | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.model !== "string" || input.model.trim() === "") return null;
  if (!Array.isArray(input.messages)) return null;
  // Copy only transport-safe provider fields. Function-valued callbacks and
  // AbortSignal objects can never cross this boundary.
  return wireParams(input as AIProviderStreamParams);
};

const encodeEvent = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const errorPayload = (error: unknown) => {
  const providerError =
    error instanceof ProviderError
      ? error
      : ProviderError.from(error, "remote");
  return {
    message: providerError.message,
    provider: providerError.provider,
    retryable: providerError.retryable,
    status: providerError.status,
    type: providerError.type,
  };
};

const streamResponseBody = (
  iterator: AsyncIterator<AIChunk>,
  heartbeatMs: number,
  onError?: (error: unknown) => void | Promise<void>,
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const pending = iterator.next();
          let next: IteratorResult<AIChunk>;
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const heartbeat = new Promise<"heartbeat">((resolve) => {
              timer = setTimeout(() => resolve("heartbeat"), heartbeatMs);
            });
            const winner =
              heartbeatMs > 0
                ? await Promise.race([pending, heartbeat])
                : await pending;
            if (timer) clearTimeout(timer);
            if (winner === "heartbeat") {
              controller.enqueue(encoder.encode(": ping\n\n"));
              continue;
            }
            next = winner;
            break;
          }
          if (next.done) break;
          controller.enqueue(encodeEvent("chunk", next.value));
        }
      } catch (error) {
        await onError?.(error);
        controller.enqueue(encodeEvent("error", errorPayload(error)));
      } finally {
        await iterator.return?.();
        controller.close();
      }
    },
  });

export const createProviderProxyResponse = async (
  provider: AIProviderConfig,
  value: unknown,
  options: ProviderProxyResponseOptions = {},
): Promise<Response> => {
  const params = parseProviderProxyParams(value);
  if (!params) {
    return Response.json(
      { error: "invalid provider stream request" },
      { status: 400 },
    );
  }
  const iterator = provider
    .stream({ ...params, signal: options.signal })
    [Symbol.asyncIterator]();
  return new Response(
    streamResponseBody(
      iterator,
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      options.onError,
    ),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        ...Object.fromEntries(new Headers(options.headers)),
      },
    },
  );
};

const parseRemoteStream = async function* (
  response: Response,
): AsyncGenerator<AIChunk> {
  if (!response.ok) {
    throw ProviderError.fromResponse(
      "remote",
      response.status,
      await response.text(),
    );
  }
  if (!response.body)
    throw new ProviderError({
      message: "Remote provider returned no response body",
      provider: "remote",
      retryable: true,
    });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.startsWith(":")) continue;
        const event = /^event:\s*(.+)$/m.exec(frame)?.[1];
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const parsed = JSON.parse(data) as
          | AIChunk
          | {
              message?: string;
              provider?: string;
              retryable?: boolean;
              status?: number | null;
              type?: string | null;
            };
        if (event === "error") {
          throw new ProviderError({
            message:
              "message" in parsed && typeof parsed.message === "string"
                ? parsed.message
                : "Remote provider stream failed",
            provider:
              "provider" in parsed && typeof parsed.provider === "string"
                ? parsed.provider
                : "remote",
            retryable:
              "retryable" in parsed && typeof parsed.retryable === "boolean"
                ? parsed.retryable
                : true,
            status:
              "status" in parsed &&
              (typeof parsed.status === "number" || parsed.status === null)
                ? parsed.status
                : null,
            type:
              "type" in parsed &&
              (typeof parsed.type === "string" || parsed.type === null)
                ? parsed.type
                : null,
          });
        }
        if (event === "chunk") yield parsed as AIChunk;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
};

export const remoteProvider = (
  config: RemoteProviderConfig,
): AIProviderConfig => ({
  stream: async function* (params) {
    const headers =
      typeof config.headers === "function"
        ? await config.headers()
        : config.headers;
    const response = await (config.fetch ?? fetch)(config.url, {
      body: JSON.stringify(wireParams(params)),
      headers: {
        "content-type": "application/json",
        ...Object.fromEntries(new Headers(headers)),
      },
      method: "POST",
      signal: params.signal,
    });
    yield* parseRemoteStream(response);
  },
});
