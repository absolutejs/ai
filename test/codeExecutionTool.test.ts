/**
 * `codeExecutionTool` — runs model-generated JS inside an isolated-jsc
 * sandbox. We exercise the AIToolDefinition contract directly (model
 * passes `{code}`, gets a stringified JSON result).
 */

import { describe, expect, test } from "bun:test";
import { codeExecutionTool } from "../src/ai/tools";
import * as jsc from "bun:jsc";

/* Patched Bun 1.4.4+absolute.2+ provides lockdown(); there the tools run
 * locked down with their defaults. On stock Bun the default refuses to run
 * (see the "requires lockdown by default" test), so the functional tests
 * opt out to keep exercising the tool itself. */
const runtimeHasLockdown =
  typeof (jsc as { lockdown?: unknown }).lockdown === "function";
const lockdownOptions = runtimeHasLockdown ? {} : { requireLockdown: false };
const makeTool = (options: Parameters<typeof codeExecutionTool>[0] = {}) =>
  codeExecutionTool({ ...lockdownOptions, ...options });

type Run = {
  ok: boolean;
  result?: unknown;
  log: string[];
  error?: { name: string; message: string };
  cpuMs: number;
  heapBytes: number;
};

const call = async (
  tool: ReturnType<typeof codeExecutionTool>,
  code: unknown,
): Promise<Run> => {
  const raw = await tool.handler({ code });
  return JSON.parse(raw) as Run;
};

describe("codeExecutionTool", () => {
  test("requires lockdown by default: runs locked down on patched Bun, refuses on stock Bun", async () => {
    const tool = codeExecutionTool();
    const run = await call(
      tool,
      "(async () => [(0, eval)('typeof Bun'), await import('node:fs').then(() => 'loaded', (e) => e.name)])()",
    );
    if (runtimeHasLockdown) {
      expect(run.ok).toBe(true);
      expect(run.result).toEqual(["undefined", "TypeError"]);
    } else {
      expect(run.ok).toBe(false);
      expect(run.error?.name).toBe("LockdownUnavailableError");
    }
  });

  test("happy path: returns the script's last-expression value", async () => {
    const tool = makeTool();
    const run = await call(tool, "1 + 2 * 3");
    expect(run.ok).toBe(true);
    expect(run.result).toBe(7);
  });

  test("log(...) captures stdout into result.log", async () => {
    const tool = makeTool();
    const run = await call(tool, "log('hello'); log('world', 42); 'done'");
    expect(run.ok).toBe(true);
    expect(run.result).toBe("done");
    expect(run.log).toEqual(["hello", "world 42"]);
  });

  test("exposes host fns the model can call", async () => {
    const tool = makeTool({
      expose: {
        double: (n: unknown) => (n as number) * 2,
        round: (n: unknown) => Math.round(n as number),
      },
    });
    const run = await call(
      tool,
      "(async () => await round(await double(3.7)))()",
    );
    expect(run.ok).toBe(true);
    expect(run.result).toBe(7); // double(3.7) = 7.4 → round = 7
  });

  test("script error returns ok=false with error details", async () => {
    const tool = makeTool();
    const run = await call(tool, "throw new Error('boom')");
    expect(run.ok).toBe(false);
    expect(run.error?.message).toContain("boom");
  });

  test("timeout: caps wall-clock at the configured value", async () => {
    const tool = makeTool({ timeout: 100 });
    const run = await call(tool, "while (true) {}");
    expect(run.ok).toBe(false);
    expect(run.error?.name).toBe("TimeoutError");
  });

  test("hardened by default — fetch / Bun / process unreachable inside the sandbox", async () => {
    const tool = makeTool();
    const run = await call(
      tool,
      "typeof fetch + ',' + typeof Bun + ',' + typeof process",
    );
    expect(run.ok).toBe(true);
    expect(run.result).toBe("undefined,undefined,undefined");
  });

  test("invalid input: missing code field", async () => {
    const tool = makeTool();
    const raw = await tool.handler({});
    const run = JSON.parse(raw) as Run;
    expect(run.ok).toBe(false);
    expect(run.error?.name).toBe("InvalidInput");
  });

  test("description includes exposed function names so the model knows them", () => {
    const tool = makeTool({
      expose: { lookup_user: () => null, send_email: () => null },
    });
    expect(tool.description).toContain("lookup_user");
    expect(tool.description).toContain("send_email");
  });

  test("description override wins", () => {
    const tool = makeTool({ description: "custom desc" });
    expect(tool.description).toBe("custom desc");
  });

  test("isolate pool: 10 sequential calls reuse one isolate (no per-call spawn)", async () => {
    const tool = makeTool({ memoryLimit: 128 });
    // 10 quick calls; pool reuse means total time stays well under 10x
    // a cold spawn. We don't assert wall-clock to avoid flake, just that
    // every call succeeds with the expected output.
    for (let i = 0; i < 10; i++) {
      const run = await call(tool, `${i} * 2`);
      expect(run.ok).toBe(true);
      expect(run.result).toBe(i * 2);
    }
  });

  test("per-call telemetry (cpuMs, heapBytes) is non-zero on real work", async () => {
    const tool = makeTool();
    const run = await call(
      tool,
      "let n = 0; for (let i = 0; i < 1_000_000; i++) n += i; n",
    );
    expect(run.ok).toBe(true);
    expect(run.cpuMs).toBeGreaterThan(0);
    expect(run.heapBytes).toBeGreaterThan(0);
  });
});
