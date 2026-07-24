export type ConversationTurnQueueStatus = "failed" | "queued" | "running";

export type ConversationTurnQueueItem<Input> = {
  error?: unknown;
  id: string;
  input: Input;
  status: ConversationTurnQueueStatus;
};

export type ConversationTurnQueueSnapshot<Input> = {
  items: ReadonlyArray<ConversationTurnQueueItem<Input>>;
  running: boolean;
};

export type ConversationTurnQueueOptions<Input> = {
  execute: (
    input: Input,
    context: { id: string; signal: AbortSignal },
  ) => Promise<void>;
  maxSize?: number;
  onError?: (error: unknown, item: ConversationTurnQueueItem<Input>) => void;
};

const DEFAULT_MAX_SIZE = 100;

export class ConversationTurnQueueFullError extends Error {
  constructor(maxSize: number) {
    super(`Conversation turn queue is full (${maxSize} items)`);
    this.name = "ConversationTurnQueueFullError";
  }
}

/**
 * Serializes turns for one conversation.
 *
 * The queue is transport-agnostic: WebSocket chat, REST/SSE applications, and
 * durable adapters can all provide their own `execute` boundary. Failed turns
 * remain visible and stop the queue until the host retries or removes them, so
 * a later follow-up can never silently overtake a failed earlier message.
 */
export const createConversationTurnQueue = <Input>(
  options: ConversationTurnQueueOptions<Input>,
) => {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const items: ConversationTurnQueueItem<Input>[] = [];
  const listeners = new Set<
    (snapshot: ConversationTurnQueueSnapshot<Input>) => void
  >();
  let activeAbort: AbortController | null = null;
  let draining = false;

  const snapshot = (): ConversationTurnQueueSnapshot<Input> => ({
    items: items.map((item) => ({ ...item })),
    running: items.some(({ status }) => status === "running"),
  });

  const notify = () => {
    const next = snapshot();
    listeners.forEach((listener) => listener(next));
  };

  const drain = async () => {
    if (draining) return;
    const next = items.find(({ status }) => status === "queued");
    if (!next || items.some(({ status }) => status === "failed")) return;
    draining = true;
    next.status = "running";
    activeAbort = new AbortController();
    notify();
    try {
      await options.execute(next.input, {
        id: next.id,
        signal: activeAbort.signal,
      });
      const index = items.findIndex(({ id }) => id === next.id);
      if (index >= 0) items.splice(index, 1);
    } catch (error) {
      if (activeAbort.signal.aborted) {
        const index = items.findIndex(({ id }) => id === next.id);
        if (index >= 0) items.splice(index, 1);
      } else {
        next.error = error;
        next.status = "failed";
        options.onError?.(error, { ...next });
      }
    } finally {
      activeAbort = null;
      draining = false;
      notify();
      void drain();
    }
  };

  const enqueue = (input: Input, id: string = crypto.randomUUID()) => {
    if (items.length >= maxSize) {
      throw new ConversationTurnQueueFullError(maxSize);
    }
    items.push({ id, input, status: "queued" });
    notify();
    void drain();

    return id;
  };

  const remove = (id: string) => {
    const index = items.findIndex(
      (item) => item.id === id && item.status !== "running",
    );
    if (index < 0) return false;
    items.splice(index, 1);
    notify();
    void drain();

    return true;
  };

  const retry = (id: string) => {
    const item = items.find(
      (candidate) => candidate.id === id && candidate.status === "failed",
    );
    if (!item) return false;
    delete item.error;
    item.status = "queued";
    notify();
    void drain();

    return true;
  };

  const cancel = (input: { clearPending?: boolean } = {}) => {
    activeAbort?.abort();
    if (input.clearPending) {
      for (let index = items.length - 1; index >= 0; index--) {
        if (items[index]?.status !== "running") items.splice(index, 1);
      }
    }
    notify();
  };

  return {
    cancel,
    enqueue,
    getSnapshot: snapshot,
    remove,
    retry,
    subscribe: (
      listener: (snapshot: ConversationTurnQueueSnapshot<Input>) => void,
    ) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
};
