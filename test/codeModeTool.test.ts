/**
 * `codeModeTool` — Code Mode wrapper. Model sees typed TS signatures of N
 * host tools and emits ONE function chaining several calls. We exercise
 * the AIToolDefinition contract directly: pass `{code}`, get a stringified
 * JSON result with `result`, `log`, `toolCalls[]`.
 */

import { describe, expect, test } from "bun:test";
import { codeModeTool } from "../src/ai/tools";

type ToolCall = {
  name: string;
  args: unknown[];
  durationMs: number;
  ok: boolean;
  error?: string;
};

type Run = {
  ok: boolean;
  result?: unknown;
  log: string[];
  toolCalls: ToolCall[];
  error?: { name: string; message: string };
  cpuMs: number;
  heapBytes: number;
};

const call = async (
  tool: ReturnType<typeof codeModeTool>,
  code: unknown,
): Promise<Run> => {
  const raw = await tool.handler({ code });
  return JSON.parse(raw) as Run;
};

describe("codeModeTool", () => {
  test("description includes typed declarations for each host tool", () => {
    const tool = codeModeTool({
      tools: {
        get_user: {
          description: "Fetch a user by id.",
          handler: () => null,
          tsSignature: "(id: string) => Promise<User | null>",
        },
      },
      types: "type User = { id: string; name: string };",
    });
    expect(tool.description).toContain(
      "declare const get_user: (id: string) => Promise<User | null>;",
    );
    expect(tool.description).toContain("Fetch a user by id.");
    expect(tool.description).toContain(
      "type User = { id: string; name: string };",
    );
  });

  test("chains multiple host tool calls in one sandbox run", async () => {
    const tool = codeModeTool({
      tools: {
        add: {
          description: "Add two numbers.",
          handler: (a: unknown, b: unknown) => (a as number) + (b as number),
          tsSignature: "(a: number, b: number) => number",
        },
        triple: {
          description: "Multiply by three.",
          handler: (n: unknown) => (n as number) * 3,
          tsSignature: "(n: number) => number",
        },
      },
    });
    const run = await call(
      tool,
      "const sum = await add(2, 3); return triple(sum);",
    );
    expect(run.ok).toBe(true);
    expect(run.result).toBe(15);
    expect(run.toolCalls.length).toBe(2);
    expect(run.toolCalls[0]?.name).toBe("add");
    expect(run.toolCalls[0]?.args).toEqual([2, 3]);
    expect(run.toolCalls[1]?.name).toBe("triple");
    expect(run.toolCalls[1]?.args).toEqual([5]);
  });

  test("async host tools work (isolated-jsc 0.4+ pump)", async () => {
    const tool = codeModeTool({
      tools: {
        slow_double: {
          description: "Double a number after a tick.",
          handler: async (n: unknown) => {
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
            return (n as number) * 2;
          },
          tsSignature: "(n: number) => Promise<number>",
        },
      },
    });
    const run = await call(tool, "return await slow_double(21);");
    expect(run.ok).toBe(true);
    expect(run.result).toBe(42);
    expect(run.toolCalls.length).toBe(1);
    expect(run.toolCalls[0]?.ok).toBe(true);
  });

  test("log(...) captures debug output without entering result", async () => {
    const tool = codeModeTool({
      tools: {
        echo: {
          description: "Echo input.",
          handler: (x: unknown) => x,
          tsSignature: "(x: unknown) => unknown",
        },
      },
    });
    const run = await call(
      tool,
      "log('about to call'); const v = await echo('hi'); log('got', v); return v;",
    );
    expect(run.ok).toBe(true);
    expect(run.result).toBe("hi");
    expect(run.log).toEqual(["about to call", "got hi"]);
  });

  test("host tool error surfaces in toolCalls AND propagates to model", async () => {
    const tool = codeModeTool({
      tools: {
        boom: {
          description: "Always throws.",
          handler: () => {
            throw new Error("kaboom");
          },
          tsSignature: "() => never",
        },
      },
    });
    const run = await call(tool, "return boom();");
    expect(run.ok).toBe(false);
    expect(run.error?.message).toContain("kaboom");
    expect(run.toolCalls.length).toBe(1);
    expect(run.toolCalls[0]?.ok).toBe(false);
    expect(run.toolCalls[0]?.error).toContain("kaboom");
  });

  test("invalid input shape returns ok=false without spawning a sandbox", async () => {
    const tool = codeModeTool({
      tools: {
        noop: {
          description: "No-op.",
          handler: () => null,
          tsSignature: "() => null",
        },
      },
    });
    const raw = await tool.handler({ wrong: "field" });
    const parsed = JSON.parse(raw) as Run;
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.name).toBe("InvalidInput");
  });

  test("code-mode advantages: ONE tool call, model context gets only the final return", async () => {
    // This is the qualitative win — programmatic style: model emits 'fetch
    // 3 IDs in parallel, sort by score, return top 1' as one snippet
    // instead of 5 round-trips.
    const records = new Map([
      ["a", { id: "a", score: 7 }],
      ["b", { id: "b", score: 3 }],
      ["c", { id: "c", score: 9 }],
    ]);
    const tool = codeModeTool({
      tools: {
        fetch_record: {
          description: "Look up a record by id.",
          handler: (id: unknown) => records.get(id as string) ?? null,
          tsSignature:
            "(id: string) => Promise<{ id: string; score: number } | null>",
        },
      },
    });
    const run = await call(
      tool,
      `
      const ids = ['a', 'b', 'c'];
      const rows = await Promise.all(ids.map((id) => fetch_record(id)));
      rows.sort((x, y) => y.score - x.score);
      return rows[0];
      `,
    );
    expect(run.ok).toBe(true);
    expect(run.result).toEqual({ id: "c", score: 9 });
    expect(run.toolCalls.length).toBe(3);
    // The model only sees one tool response (the final return). Three host
    // calls happened but only ONE entered the conversation context.
  });
});
