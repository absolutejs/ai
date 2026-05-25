import { describe, expect, test } from "bun:test";
import type { ViewDiff } from "@absolutejs/sync/engine";
import { createSyncConversationStore } from "../src/ai/syncConversationStore";
import type { AIConversation } from "../types/ai";

type Hit = { id: string; conversationId: string };

const conversation = (
  id: string,
  messages: AIConversation["messages"],
): AIConversation => ({ createdAt: 1, id, messages });

const message = (id: string, conversationId: string, content: string) => ({
  content,
  conversationId,
  id,
  role: "assistant" as const,
});

describe("createSyncConversationStore", () => {
  test("persists conversations like a normal store", async () => {
    const store = createSyncConversationStore();
    await store.set("c1", conversation("c1", [message("m1", "c1", "hi")]));

    const loaded = await store.get("c1");
    expect(loaded?.messages.length).toBe(1);
    expect((await store.list()).map((summary) => summary.id)).toContain("c1");

    await store.remove("c1");
    expect(await store.get("c1")).toBeUndefined();
  });

  test("streams a conversation's messages live to subscribers", async () => {
    const store = createSyncConversationStore();
    const diffs: ViewDiff<Hit>[] = [];
    const sub = await store.engine.subscribe<Hit, string>({
      collection: store.collection,
      ctx: {},
      onDiff: (diff) => {
        diffs.push(diff);
      },
      params: "c1",
    });
    expect(sub.initial).toEqual([]);

    // A user message lands live for this conversation.
    await store.set("c1", conversation("c1", [message("u1", "c1", "hello")]));
    expect((diffs.at(-1)?.added ?? []).map((row) => row.id)).toContain("u1");

    // An assistant message streams in (content grows) — seen as a live change.
    await store.set(
      "c1",
      conversation("c1", [
        message("u1", "c1", "hello"),
        { ...message("a1", "c1", "Hi"), isStreaming: true },
      ]),
    );
    expect((diffs.at(-1)?.added ?? []).map((row) => row.id)).toContain("a1");

    await store.set(
      "c1",
      conversation("c1", [
        message("u1", "c1", "hello"),
        { ...message("a1", "c1", "Hi there!"), isStreaming: false },
      ]),
    );
    expect((diffs.at(-1)?.changed ?? []).map((row) => row.id)).toContain("a1");

    // A different conversation never reaches this subscriber.
    const before = diffs.length;
    await store.set("c2", conversation("c2", [message("x", "c2", "other")]));
    expect(diffs.length).toBe(before);

    sub.unsubscribe();
  });
});
