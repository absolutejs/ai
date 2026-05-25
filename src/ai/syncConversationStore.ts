import { createSyncEngine, defineReactiveQuery } from "@absolutejs/sync/engine";
import type { SyncEngine } from "@absolutejs/sync/engine";
import { createMemoryStore } from "./memoryStore";
import type {
  AIConversation,
  AIConversationStore,
  AIMessage,
} from "../../types/ai";

export type SyncConversationStoreOptions = {
  /** Engine to register on (one is created if omitted). */
  engine?: SyncEngine;
  /** Backing store for persistence (defaults to the in-memory store). */
  inner?: AIConversationStore;
  /** Live messages collection name (subscribe with the conversation id). Default `aiMessages`. */
  collection?: string;
  /** Change-feed table the live collection reads. Default `aiMessages`. */
  table?: string;
};

export type SyncConversationStore = AIConversationStore & {
  /** Mount with `syncSocket` for live conversations. */
  engine: SyncEngine;
  /** Collection name to subscribe to (params = the conversation id). */
  collection: string;
};

const messageChanged = (previous: AIMessage, next: AIMessage) =>
  previous.content !== next.content ||
  previous.isStreaming !== next.isStreaming ||
  previous.thinking !== next.thinking;

/**
 * A sync-backed {@link AIConversationStore}: a drop-in for `createMemoryStore`
 * (or any store via `inner`) that ALSO makes conversations live. Every persisted
 * message flows through the sync engine's change feed, so a second device or tab
 * subscribed to the conversation sees messages appear — and stream — without its
 * own chat socket. Mount `store.engine` with `syncSocket` and subscribe to
 * `store.collection` with the conversation id as params.
 */
export const createSyncConversationStore = (
  options: SyncConversationStoreOptions = {},
): SyncConversationStore => {
  const engine = options.engine ?? createSyncEngine();
  const inner = options.inner ?? createMemoryStore();
  const collection = options.collection ?? "aiMessages";
  const table = options.table ?? "aiMessages";
  const messages = new Map<string, AIMessage>();

  engine.registerReader(table, {
    all: () => [...messages.values()],
    key: (row) => (row as AIMessage).id,
  });
  // Live per-conversation messages: the subscription's params are the
  // conversation id; the result re-runs as messages are persisted/streamed.
  engine.registerReactive(
    defineReactiveQuery<AIMessage, string>({
      name: collection,
      key: (message) => message.id,
      run: async ({ db, params }) => {
        const all = await db.all<AIMessage>(table);

        return all.filter((message) => message.conversationId === params);
      },
    }),
  );

  // Reflect a conversation's current messages into the change feed, emitting only
  // the rows that actually changed (so streaming updates are cheap).
  const syncConversation = async (id: string, conversation: AIConversation) => {
    const current = new Set(conversation.messages.map((message) => message.id));
    for (const [messageId, message] of [...messages]) {
      if (message.conversationId === id && !current.has(messageId)) {
        messages.delete(messageId);
        await engine.applyChange(table, { op: "delete", row: message });
      }
    }
    for (const message of conversation.messages) {
      const previous = messages.get(message.id);
      if (previous && !messageChanged(previous, message)) {
        continue;
      }
      messages.set(message.id, message);
      await engine.applyChange(table, {
        op: previous ? "update" : "insert",
        row: message,
      });
    }
  };

  return {
    collection,
    engine,
    get: (id) => inner.get(id),
    getOrCreate: async (id) => {
      const conversation = await inner.getOrCreate(id);
      await syncConversation(id, conversation);

      return conversation;
    },
    list: () => inner.list(),
    remove: async (id) => {
      for (const [messageId, message] of [...messages]) {
        if (message.conversationId === id) {
          messages.delete(messageId);
          await engine.applyChange(table, { op: "delete", row: message });
        }
      }
      await inner.remove(id);
    },
    set: async (id, conversation) => {
      await inner.set(id, conversation);
      await syncConversation(id, conversation);
    },
  };
};
