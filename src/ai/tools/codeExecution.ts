/**
 * `codeExecutionTool` — an `AIToolDefinition` that runs model-generated
 * JavaScript inside an `@absolutejs/isolated-jsc` sandbox.
 *
 * Drop into any `tools: {...}` map:
 *
 * ```ts
 * import { codeExecutionTool } from '@absolutejs/ai/tools';
 *
 * const tools = {
 *   run_code: codeExecutionTool({
 *     memoryLimit: 64,
 *     timeout: 1000,
 *     expose: {
 *       lookup_user: async (id) => db.users.findById(id as string),
 *       round: (n) => Math.round(n as number),
 *     },
 *   }),
 * };
 * ```
 *
 * The model emits `{ code: '<JS source>' }` as the tool input; the host
 * runs the code in a fresh context inside a pooled isolate and returns
 * a JSON-stringified result containing:
 *
 *   - `result` — the script's return value (JSON-clonable).
 *   - `log` — array of strings captured via the host-injected `log(...)`.
 *   - `error` — error message + name if the script threw or timed out.
 *   - `cpuMs`, `heapBytes` — per-call telemetry (Phase 3 docs / monitoring).
 *
 * Defaults to the FFI backend on macOS + Linux (with libJSC installed),
 * Worker fallback elsewhere. Per-isolate pool is created once per
 * `codeExecutionTool()` call; pool key is `'default'` (one isolate for
 * all calls). For per-tenant isolation, create one tool instance per
 * tenant.
 *
 * Constraint: when using the FFI backend, **exposed host fns must be
 * synchronous**. Async host fns (returning a Promise that doesn't settle
 * synchronously — `fetch`, `setTimeout`-resolved Promises, real I/O)
 * require `backend: 'worker'` per isolated-jsc 0.3 documented limit.
 * Set `backend: 'worker'` in the tool options if any of your `expose`d
 * fns are async-settling.
 */

import type { AIToolDefinition } from "../../../types/ai";

/** Options for {@link codeExecutionTool}. */
export type CodeExecutionToolOptions = {
  /**
   * Per-isolate heap memory cap (MB). Default 64. Note that the
   * sandbox's cold-start baseline differs by backend (FFI ~300 KB vs
   * Worker ~46 MB), so the practical floor for Worker is ~64 MB.
   */
  memoryLimit?: number;
  /** Wall-clock timeout per `run_code` call (ms). Default 1000. */
  timeout?: number;
  /**
   * isolated-jsc backend. Default `"auto"` (FFI when reachable, Worker
   * otherwise). Set to `"worker"` if your `expose`d fns are async-settling
   * — the FFI backend only supports sync host fns (see Reference docs).
   */
  backend?: "auto" | "ffi" | "worker";
  /**
   * Host functions the model can call from inside the sandbox. Names
   * become globals; the model invokes them with `await name(...)`.
   * The function's description (`.toString()` first line, if a doc
   * comment) is included in the tool's description so the model knows
   * what's available.
   */
  expose?: Record<string, (...args: unknown[]) => unknown>;
  /**
   * Override the tool's description string. Default is auto-generated
   * from the exposed function list.
   */
  description?: string;
  /**
   * Pool size cap — max concurrent isolates across all parallel tool
   * calls. Default 8.
   */
  poolSize?: number;
  /**
   * Recycle the isolate after N successful runs to bound per-context
   * heap creep. Default 50.
   */
  recycleAfter?: number;
};

type Run = {
  ok: boolean;
  result?: unknown;
  log: string[];
  error?: { name: string; message: string };
  cpuMs: number;
  heapBytes: number;
};

const defaultDescription = (
  expose: Record<string, (...args: unknown[]) => unknown> | undefined,
): string => {
  const lines = [
    "Execute JavaScript code in a sandboxed environment.",
    "",
    "Input: `{ code: string }` — the JS source to evaluate. The script's last",
    "expression is the return value (vm.Script semantics).",
    "",
    "Output: JSON with `{ result, log, error?, cpuMs, heapBytes }`.",
    "",
    "Built-in: `log(...args)` captures stdout-like output into the result.log",
    "array.",
  ];
  const exposed = expose ? Object.keys(expose) : [];
  if (exposed.length > 0) {
    lines.push("");
    lines.push("Host functions available in the sandbox:");
    for (const name of exposed) {
      lines.push(`  - ${name}(...)`);
    }
  }
  return lines.join("\n");
};

export const codeExecutionTool = (
  options: CodeExecutionToolOptions = {},
): AIToolDefinition => {
  const memoryLimit = options.memoryLimit ?? 64;
  const timeout = options.timeout ?? 1000;
  const backend = options.backend ?? "auto";
  const expose = options.expose ?? {};
  const poolSize = options.poolSize ?? 8;
  const recycleAfter = options.recycleAfter ?? 50;
  const description = options.description ?? defaultDescription(expose);

  // Lazy import isolated-jsc so this module loads without it (consumers
  // who never call the tool don't pay the dep). The first call resolves
  // and caches the pool; later calls reuse it.
  type IsolatedJsc = typeof import("@absolutejs/isolated-jsc");
  let cachedPool: {
    pool: ReturnType<IsolatedJsc["createIsolatePool"]>;
    jsc: IsolatedJsc;
  } | null = null;
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

  const runCode = async (code: string): Promise<Run> => {
    const log: string[] = [];
    let cpuMs = 0;
    let heapBytes = 0;
    try {
      const { pool, jsc } = await loadPool();
      return await pool.run("default", async (isolate) => {
        const context = await isolate.createContext();
        try {
          // Built-in log capture. Sync host fn → works on FFI + Worker.
          await context.setGlobal(
            "log",
            new jsc.Reference((...args: unknown[]) => {
              log.push(
                args
                  .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
                  .join(" "),
              );
            }),
          );
          // Exposed host fns. Names become globals; user code calls them
          // directly (FFI sync path) or with `await` (Worker path).
          for (const [name, fn] of Object.entries(expose)) {
            await context.setGlobal(name, new jsc.Reference(fn));
          }
          // Wrap the user code so the last expression is what's returned
          // (matching the conventional script-result semantics).
          const script = await isolate.compileScript(code);
          const { result, metrics } = await script.runWithMetrics(context, {
            timeout,
          });
          cpuMs = metrics.cpuMs;
          heapBytes = metrics.heapBytes;
          return { ok: true, result, log, cpuMs, heapBytes };
        } finally {
          await context.dispose().catch(() => {
            /* dead context — fine */
          });
        }
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        log,
        error: { name, message },
        cpuMs,
        heapBytes,
      };
    }
  };

  return {
    description,
    input: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript source to evaluate. The script's last expression " +
            "is the return value. Use `log(...)` for stdout-like output.",
        },
      },
      required: ["code"],
    },
    handler: async (input: unknown) => {
      const code =
        input && typeof input === "object" && "code" in input
          ? (input as { code: unknown }).code
          : undefined;
      if (typeof code !== "string") {
        return JSON.stringify({
          ok: false,
          error: {
            name: "InvalidInput",
            message: "expected `{ code: string }`",
          },
          log: [],
          cpuMs: 0,
          heapBytes: 0,
        });
      }
      const run = await runCode(code);
      return JSON.stringify(run);
    },
  };
};
