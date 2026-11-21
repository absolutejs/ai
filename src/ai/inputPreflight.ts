import { ProviderError, isProviderError } from "./errors/providerError";
import { AIInputError, capacityJson } from "./inputCapacity";

const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
const diagnosticCodes = new Set([
  ...transientCodes,
  "ENOTFOUND",
  "ABORT_ERR",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
]);
const transportCode = (error: unknown): string | undefined => {
  for (
    let depth = 0;
    depth < 8 && error instanceof Error;
    depth++, error = error.cause
  ) {
    if (
      "code" in error &&
      typeof error.code === "string" &&
      diagnosticCodes.has(error.code)
    )
      return error.code;
  }
  return undefined;
};
export type AIInputPreflightOperation = "count_tokens" | "model_limits";
/** A failed capacity lookup, before generation. Never evidence of a billable response. */
export class AIInputPreflightError extends AIInputError {
  readonly generationStarted = false;
  constructor(
    readonly provider: string,
    readonly model: string,
    readonly operation: AIInputPreflightOperation,
    readonly attempts: number,
    readonly transportCode: string | undefined,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly billingUnavailable: boolean,
    requestId?: string,
  ) {
    const message = `${provider} ${operation} preflight failed before generation`;
    super(
      "capacity_unavailable",
      message,
      status,
      requestId,
      new ProviderError({
        provider,
        message,
        status,
        retryable,
        type: billingUnavailable ? "credit_balance_exhausted" : undefined,
      }),
    );
    this.name = "AIInputPreflightError";
  }
}
/** Works across independently bundled provider entrypoints. */
export const isAIInputPreflightError = (
  error: unknown,
): error is AIInputPreflightError =>
  error instanceof Error &&
  error.name === "AIInputPreflightError" &&
  "generationStarted" in error &&
  error.generationStarted === false &&
  "operation" in error &&
  (error.operation === "count_tokens" || error.operation === "model_limits") &&
  "provider" in error &&
  typeof error.provider === "string" &&
  "model" in error &&
  typeof error.model === "string" &&
  "attempts" in error &&
  Number.isInteger(error.attempts);

/** Retry only idempotent capacity requests, under one shared deadline. */
export const requestInputPreflight = async (options: {
  provider: string;
  model: string;
  operation: AIInputPreflightOperation;
  signal?: AbortSignal;
  request: (signal: AbortSignal) => Promise<Response>;
}) => {
  const deadline = AbortSignal.timeout(15_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      signal.throwIfAborted();
      return await capacityJson(
        await options.request(signal),
        options.provider,
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      const code = transportCode(error);
      const capacityError = error instanceof AIInputError ? error : undefined;
      const providerError = isProviderError(error)
        ? error
        : capacityError?.providerError;
      const retryable = code
        ? transientCodes.has(code)
        : providerError?.retryable === true;
      if (!retryable || signal.aborted || attempt >= 3)
        throw new AIInputPreflightError(
          options.provider,
          options.model,
          options.operation,
          attempt,
          deadline.aborted ? "ETIMEDOUT" : code,
          providerError?.status ?? undefined,
          retryable,
          providerError?.billingUnavailable === true,
          capacityError?.requestId,
        );
      // Backoff remains inside the same total timeout and respects cancellation.
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, attempt * 100);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }
};
