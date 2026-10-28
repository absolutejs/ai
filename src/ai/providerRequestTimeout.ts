import type { AIChunk, AIProviderConfig } from "../../types/ai";

/** Bound each provider request, excluding time spent executing host tools or funding approval. */
export const withProviderRequestTimeout = (
  provider: AIProviderConfig,
  timeoutMs: number,
): AIProviderConfig => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError(
      "Provider request timeout must be positive and finite",
    );
  return {
    ...provider,
    stream: async function* (params) {
      params.signal?.throwIfAborted();
      const controller = new AbortController();
      const signal = params.signal
        ? AbortSignal.any([params.signal, controller.signal])
        : controller.signal;
      let rejectAbort: (reason: unknown) => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      // Observe rejection even while the consumer is processing a yielded chunk.
      void aborted.catch(() => undefined);
      const onAbort = () => rejectAbort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(
        () =>
          controller.abort(
            new DOMException("AI provider request timed out", "TimeoutError"),
          ),
        timeoutMs,
      );
      let iterator: AsyncIterator<AIChunk> | undefined;
      let complete = false;
      try {
        signal.throwIfAborted();
        iterator = provider
          .stream({ ...params, signal })
          [Symbol.asyncIterator]();
        while (true) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next.done) {
            complete = true;
            return;
          }
          yield next.value;
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (!complete) {
          controller.abort(
            new DOMException("AI provider request closed", "AbortError"),
          );
          // A broken transport must not prevent timeout/cancellation from returning.
          // Its paid-work owner must retain uncertain usage rather than assume no charge.
          if (iterator?.return)
            void Promise.resolve()
              .then(() => iterator?.return?.())
              .catch(() => undefined);
        }
      }
    },
  };
};
