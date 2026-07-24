import { describe, expect, test } from "bun:test";
import { serverMessageToAction } from "../src/ai/client/actions";
import { createAIMessageStore } from "../src/ai/client/messageStore";
import { isValidAIServerMessage } from "../types/typeGuards";

describe("queued and branched chat protocol", () => {
  test("accepts queue lifecycle events and marks the local user turn", () => {
    const store = createAIMessageStore();
    store.dispatch({
      content: "first",
      conversationId: "conversation-1",
      messageId: "message-1",
      type: "send",
    });
    const queued = {
      conversationId: "conversation-1",
      messageId: "message-1",
      position: 1,
      type: "turn_queued" as const,
    };

    expect(isValidAIServerMessage(queued)).toBe(true);
    const action = serverMessageToAction(queued);
    if (action) store.dispatch(action);
    expect(
      store.getSnapshot().conversations.get("conversation-1")?.messages[0]
        ?.isQueued,
    ).toBe(true);
  });

  test("creates a usable branch and retains its new prompt", () => {
    const store = createAIMessageStore();
    store.dispatch({
      content: "original",
      conversationId: "conversation-1",
      messageId: "message-1",
      type: "send",
    });
    const branched = {
      content: "explore another approach",
      fromMessageId: "message-1",
      messageId: "message-2",
      newConversationId: "conversation-2",
      oldConversationId: "conversation-1",
      type: "branched" as const,
    };

    expect(isValidAIServerMessage(branched)).toBe(true);
    const action = serverMessageToAction(branched);
    if (action) store.dispatch(action);
    const branch = store.getSnapshot().conversations.get("conversation-2");

    expect(branch?.messages.map(({ content }) => content)).toEqual([
      "original",
      "explore another approach",
    ]);
    expect(store.getSnapshot().activeConversationId).toBe("conversation-2");
  });
});
