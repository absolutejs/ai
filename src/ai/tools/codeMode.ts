/**
 * `codeModeTool` — Code Mode for AI agents.
 *
 * Instead of exposing N tools to the model and having it call them one
 * at a time (N round-trips per turn, N tool-call tokens, the model has
 * to track intermediate state in context), Code Mode exposes ONE tool:
 * `run_code`. The model sees the typed TypeScript signatures of all
 * underlying tools and emits a single function that chains them.
 *
 * Pattern was popularized by Cloudflare's Dynamic Workers (April 2026
 * blog post: "100× faster than containers"). Anthropic's programmatic
 * tool calling is the same idea — execution pauses on a sub-tool call,
 * the API yields a tool_use, you return a result, execution resumes.
 * Both vendors report ~80% token reduction on multi-tool turns.
 *
 * ```ts
 * import { codeModeTool } from '@absolutejs/ai/tools';
 *
 * const tools = {
 *   run_code: codeModeTool({
 *     timeout: 5000,
 *     tools: {
 *       search_products: {
 *         description: 'Full-text search the product catalogue.',
 *         tsSignature: '(query: string) => Promise<Product[]>',
 *         handler: async (q) => db.products.search(q as string),
 *       },
 *       get_product: {
 *         description: 'Fetch one product by id.',
 *         tsSignature: '(id: string) => Promise<Product | null>',
 *         handler: async (id) => db.products.findById(id as string),
 *       },
 *     },
 *     types: `
 *       type Product = { id: string; name: string; price: number };
 *     `,
 *   }),
 * };
 * ```
 *
 * The model emits a single function:
 *
 * ```js
 * const items = await search_products('hat');
 * const cheapest = items.sort((a, b) => a.price - b.price)[0];
 * const detail = await get_product(cheapest.id);
 * return { name: detail.name, price: detail.price };
 * ```
 *
 * One sandbox eval. Two host-fn calls. One returned value. The model's
 * context only ever sees the final return — intermediate tool results
 * don't enter the conversation window, so multi-step workflows are
 * dramatically cheaper.
 *
 * Each underlying tool's `handler` runs on the HOST side (not in the
 * sandbox). Async host fns work on both FFI (via the 0.4 pump) and
 * Worker backends since isolated-jsc 0.4+. Errors thrown by host
 * handlers propagate into the sandbox as JS Errors the model can
 * catch and recover from.
 */

import type { AIToolDefinition } from "../../../types/ai";

/**
 * One callable surfaced to the sandbox. The `tsSignature` shows up in
 * the model-visible description; `handler` runs on the host when the
 * sandbox calls it.
 */
export type CodeModeHostTool = {
  /** One-line human description of what this tool does. */
  description: string;
  /** TypeScript signature shown to the model. Example:
   * `'(query: string, options?: { limit?: number }) => Promise<Item[]>'`.
   * The model writes JS against this signature; we don't enforce it at
   * runtime — type-check is the model's responsibility. */
  tsSignature: string;
  /** Host implementation. Receives positional args as the model passed
   * them. Return value is structure-cloned back into the sandbox. */
  handler: (...args: unknown[]) => unknown;
};

/** Options for {@link codeModeTool}. */
export type CodeModeToolOptions = {
  /** Map of host-tool name → {@link CodeModeHostTool}. */
  tools: Record<string, CodeModeHostTool>;
  /**
   * Optional shared TypeScript declarations stitched into the prompt
   * (type aliases, interfaces, etc.) so signatures can reference them.
   * Use raw TS source; no parsing happens host-side.
   */
  types?: string;
  /**
   * Per-isolate heap memory cap (MB). Default 64. As with the regular
   * code-execution tool, FFI's cold heap is much smaller than Worker's,
   * but per-call retention scales similarly.
   */
  memoryLimit?: number;
  /** Wall-clock timeout per `run_code` call (ms). Default 5000. */
  timeout?: number;
  /**
   * isolated-jsc backend. Defaults to `'auto'`. Since isolated-jsc 0.4
   * both backends support async host fns, so the choice is purely
   * about cold spawn (FFI wins ~6×) vs Web APIs availability (Worker
   * has `URL` / `TextEncoder` / `WebSocket`; FFI does not).
   */
  backend?: "auto" | "ffi" | "worker";
  /**
   * Override the auto-generated description. By default we emit the
   * model-facing prompt: a short instruction header + the host fn
   * signatures + any shared `types`.
   */
  description?: string;
  /** Pool size cap. Default 8. */
  poolSize?: number;
  /** Recycle the isolate after N successful runs. Default 50. */
  recycleAfter?: number;
};

type RunResult = {
  ok: boolean;
  result?: unknown;
  log: string[];
  toolCalls: Array<{
    name: string;
    args: unknown[];
    durationMs: number;
    ok: boolean;
    error?: string;
  }>;
  error?: { name: string; message: string };
  cpuMs: number;
  heapBytes: number;
};

const buildDescription = (
  tools: Record<string, CodeModeHostTool>,
  types: string | undefined,
): string => {
  const lines: string[] = [
    "Execute JavaScript that calls one or more host tools, returning a",
    "single value. Prefer this over calling individual tools when you'd",
    "otherwise need multiple sequential tool calls — one Code Mode call",
    "replaces N tool calls plus the intermediate context.",
    "",
    "Input: `{ code: string }`. The code is a function BODY (not a full",
    "function). It can use `await`, `const`/`let`, control flow, etc.",
    "Whatever you `return` becomes the tool output.",
    "",
    "Built-in: `log(...args)` captures messages for debugging. Logs are",
    "returned alongside the result; they don't enter the model context.",
    "",
    "Available host functions (calling these from your code is what runs",
    "the real work; everything else is plain JS):",
    "",
  ];
  for (const [name, tool] of Object.entries(tools)) {
    lines.push(`// ${tool.description}`);
    lines.push(`declare const ${name}: ${tool.tsSignature};`);
    lines.push("");
  }
  if (types !== undefined && types.trim().length > 0) {
    lines.push("// Shared types referenced by the signatures above:");
    lines.push(types.trim());
    lines.push("");
  }
  lines.push("Example:");
  lines.push("```js");
  lines.push("// Get the cheapest matching product and its full record.");
  const firstTool = Object.keys(tools)[0];
  if (firstTool !== undefined) {
    lines.push(`const items = await ${firstTool}('search query');`);
    lines.push(
      "const cheapest = items.sort((a, b) => a.price - b.price)[0];",
    );
    lines.push("return cheapest;");
  } else {
    lines.push("return 42;");
  }
  lines.push("```");
  lines.push("");
  lines.push("Output: JSON with `{ result, log, toolCalls, cpuMs, heapBytes }`.");
  return lines.join("\n");
};

export const codeModeTool = (
  options: CodeModeToolOptions,
): AIToolDefinition => {
  const memoryLimit = options.memoryLimit ?? 64;
  const timeout = options.timeout ?? 5000;
  const backend = options.backend ?? "auto";
  const poolSize = options.poolSize ?? 8;
  const recycleAfter = options.recycleAfter ?? 50;
  const tools = options.tools;
  const description =
    options.description ?? buildDescription(tools, options.types);

  type IsolatedJsc = typeof import("@absolutejs/isolated-jsc");
  let cachedPool:
    | { pool: ReturnType<IsolatedJsc["createIsolatePool"]>; jsc: IsolatedJsc }
    | null = null;
  let cachedPoolPromise: Promise<{
    pool: ReturnType<IsolatedJsc["createIsolatePool"]>;
    jsc: IsolatedJsc;
  }> | null = null;

  const loadPool = async () => {
    if (cachedPool !== null) return cachedPool;
    if (cachedPoolPromise !== null) return cachedPoolPromise;
    cachedPoolPromise = (async () => {
      const jsc = (await import("@absolutejs/isolated-jsc")) as IsolatedJsc;
      const pool = jsc.createIsolatePool({
        isolate: { backend, memoryLimit },
        maxSize: poolSize,
        recycleAfter,
      });
      cachedPool = { pool, jsc };
      return cachedPool;
    })();
    return cachedPoolPromise;
  };

  const runCode = async (code: string): Promise<RunResult> => {
    const log: string[] = [];
    const toolCalls: RunResult["toolCalls"] = [];
    let cpuMs = 0;
    let heapBytes = 0;
    try {
      const { pool, jsc } = await loadPool();
      return await pool.run("default", async (isolate) => {
        const context = await isolate.createContext();
        try {
          // Built-in log capture.
          await context.setGlobal(
            "log",
            new jsc.Reference((...args: unknown[]) => {
              log.push(
                args
                  .map((a) =>
                    typeof a === "string" ? a : JSON.stringify(a),
                  )
                  .join(" "),
              );
            }),
          );

          // Bind each host tool as a global Reference. Wrap so we
          // capture per-call telemetry (durationMs, error). Async
          // host fns work on both FFI (0.4+) and Worker backends.
          for (const [name, tool] of Object.entries(tools)) {
            await context.setGlobal(
              name,
              new jsc.Reference(((...args: unknown[]) => {
                const startedAt = performance.now();
                const recordSuccess = () => {
                  toolCalls.push({
                    args,
                    durationMs: performance.now() - startedAt,
                    name,
                    ok: true,
                  });
                };
                const recordError = (err: unknown) => {
                  toolCalls.push({
                    args,
                    durationMs: performance.now() - startedAt,
                    error: err instanceof Error ? err.message : String(err),
                    name,
                    ok: false,
                  });
                };
                let outcome: unknown;
                try {
                  outcome = tool.handler(...args);
                } catch (err) {
                  recordError(err);
                  throw err;
                }
                if (
                  outcome !== null &&
                  typeof outcome === "object" &&
                  "then" in outcome &&
                  typeof (outcome as { then: unknown }).then === "function"
                ) {
                  return (outcome as Promise<unknown>).then(
                    (v) => {
                      recordSuccess();
                      return v;
                    },
                    (err) => {
                      recordError(err);
                      throw err;
                    },
                  );
                }
                recordSuccess();
                return outcome;
              }) as (...args: unknown[]) => unknown),
            );
          }

          // Wrap the model's code as an async function body. Whatever
          // it `return`s becomes the tool output.
          const wrapped = `(async () => { ${code}\n})()`;
          const script = await isolate.compileScript(wrapped);
          const { result, metrics } = await script.runWithMetrics(context, {
            timeout,
          });
          cpuMs = metrics.cpuMs;
          heapBytes = metrics.heapBytes;
          return { cpuMs, heapBytes, log, ok: true, result, toolCalls };
        } finally {
          await context.dispose().catch(() => {
            /* ok */
          });
        }
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        cpuMs,
        error: { message, name },
        heapBytes,
        log,
        ok: false,
        toolCalls,
      };
    }
  };

  return {
    description,
    handler: async (input: unknown) => {
      const code =
        input !== null &&
        typeof input === "object" &&
        "code" in input
          ? (input as { code: unknown }).code
          : undefined;
      if (typeof code !== "string") {
        return JSON.stringify({
          cpuMs: 0,
          error: {
            message: "expected `{ code: string }`",
            name: "InvalidInput",
          },
          heapBytes: 0,
          log: [],
          ok: false,
          toolCalls: [],
        });
      }
      const run = await runCode(code);
      return JSON.stringify(run);
    },
    input: {
      properties: {
        code: {
          description:
            "JavaScript function-body source. Use `await` to call host " +
            "tools; `return` the final value. Multiple tool calls in one " +
            "block are encouraged — that's the whole point of Code Mode.",
          type: "string",
        },
      },
      required: ["code"],
      type: "object",
    },
  };
};
