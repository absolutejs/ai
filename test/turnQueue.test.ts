import { describe, expect, test } from "bun:test";
import { createConversationTurnQueue } from "../src/ai/client/turnQueue";

const deferred = () => {
  let resolve = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

describe("conversation turn queue", () => {
  test("runs turns strictly in enqueue order", async () => {
    const first = deferred();
    const started: string[] = [];
    const queue = createConversationTurnQueue<string>({
      execute: async (input) => {
        started.push(input);
        if (input === "first") await first.promise;
      },
    });

    queue.enqueue("first", "turn-1");
    queue.enqueue("second", "turn-2");
    await Bun.sleep(0);
    expect(started).toEqual(["first"]);
    expect(queue.getSnapshot().items.map(({ status }) => status)).toEqual([
      "running",
      "queued",
    ]);

    first.resolve();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(started).toEqual(["first", "second"]);
    expect(queue.getSnapshot().items).toEqual([]);
  });

  test("does not let later turns overtake a failure", async () => {
    const queue = createConversationTurnQueue<string>({
      execute: async (input) => {
        if (input === "broken") throw new Error("nope");
      },
    });

    queue.enqueue("broken", "turn-1");
    queue.enqueue("later", "turn-2");
    await Bun.sleep(0);
    expect(queue.getSnapshot().items.map(({ status }) => status)).toEqual([
      "failed",
      "queued",
    ]);

    expect(queue.remove("turn-1")).toBe(true);
    await Bun.sleep(0);
    expect(queue.getSnapshot().items).toEqual([]);
  });
});
