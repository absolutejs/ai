import { Elysia } from "elysia";
import type {
  AIAttachment,
  AIChatPluginConfig,
  AIConversation,
  AIConversationStore,
  AIMessage,
} from "../../types/ai";
import { createMemoryStore } from "../ai/memoryStore";
import { createConversationTurnQueue } from "../ai/client/turnQueue";
import { generateId, parseAIMessage } from "../ai/protocol";
import { streamAI } from "../ai/streamAI";
import { streamAIToSSE } from "../ai/streamAIToSSE";
import { resolveRenderers } from "../ai/htmxRenderers";
import { EXCLUDE_LAST_OFFSET } from "../constants";

const DEFAULT_PATH = "/chat";
const MAX_PREFIX_LEN = 12;
const TITLE_MAX_LENGTH = 80;
const NOT_FOUND = -1;

const defaultParseProvider = (content: string) => {
  const colonIdx = content.indexOf(":");
  const hasPrefix = colonIdx > 0 && colonIdx < MAX_PREFIX_LEN;

  return {
    content: hasPrefix ? content.slice(colonIdx + 1) : content,
    providerName: hasPrefix ? content.slice(0, colonIdx) : "anthropic",
  };
};

const appendMessage = (conversation: AIConversation, message: AIMessage) => {
  conversation.messages.push(message);
  conversation.lastMessageAt = Date.now();

  if (!conversation.title && message.role === "user") {
    conversation.title = message.content.slice(0, TITLE_MAX_LENGTH);
  }
};

const getHistory = (conversation: AIConversation) =>
  conversation.messages.map((msg) => ({
    content: msg.content,
    role: msg.role,
  }));

const branchConversation = (source: AIConversation, fromMessageId: string) => {
  const cutoffIndex = source.messages.findIndex(
    (msg) => msg.id === fromMessageId,
  );

  if (cutoffIndex === NOT_FOUND) {
    return null;
  }

  const newId = generateId();
  const branchedMessages = source.messages
    .slice(0, cutoffIndex + 1)
    .map((msg) => ({ ...msg, conversationId: newId }));

  const newConversation: AIConversation = {
    createdAt: Date.now(),
    id: newId,
    messages: branchedMessages,
  };

  return newConversation;
};

const buildUserMessage = (content: string, attachments?: AIAttachment[]) => {
  if (attachments && attachments.length > 0) {
    return {
      content: [
        ...attachments.map((att) => {
          if (att.media_type === "application/pdf") {
            return {
              name: att.name,
              source: {
                data: att.data,
                media_type: att.media_type,
                type: "base64" as const,
              },
              type: "document" as const,
            };
          }

          return {
            source: {
              data: att.data,
              media_type: att.media_type,
              type: "base64" as const,
            },
            type: "image" as const,
          };
        }),
        { content, type: "text" as const },
      ],
      role: "user" as const,
    };
  }

  return { content, role: "user" as const };
};

const resolveModel = (
  config: AIChatPluginConfig,
  parsed: { model?: string; providerName: string },
) => {
  if (parsed.model) {
    return parsed.model;
  }

  if (typeof config.model === "string") {
    return config.model;
  }

  if (typeof config.model === "function") {
    return config.model(parsed.providerName);
  }

  return parsed.providerName;
};

const resolveTools = (
  config: AIChatPluginConfig,
  providerName: string,
  model: string,
) =>
  typeof config.tools === "function"
    ? config.tools(providerName, model)
    : config.tools;

const resolveReasoning = (
  config: AIChatPluginConfig,
  providerName: string,
  model: string,
) =>
  typeof config.reasoning === "function"
    ? config.reasoning(providerName, model)
    : config.reasoning;

export const aiChat = (config: AIChatPluginConfig) => {
  const path = config.path ?? DEFAULT_PATH;
  const store: AIConversationStore = config.store ?? createMemoryStore();
  const parseProvider = config.parseProvider ?? defaultParseProvider;
  const abortControllers = new Map<string, AbortController>();
  type ChatSocket = { readyState: number; send: (data: string) => void };
  type QueuedUserTurn = {
    attachments?: AIAttachment[];
    clientMessageId: string;
    content: string;
    conversationId: string;
    ws: ChatSocket;
  };
  const turnQueues = new Map<
    string,
    ReturnType<typeof createConversationTurnQueue<QueuedUserTurn>>
  >();

  const sendServerEvent = (ws: ChatSocket, event: Record<string, unknown>) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(event));
  };

  const handleCancel = (conversationId: string) => {
    turnQueues.get(conversationId)?.cancel({ clearPending: true });
    const controller = abortControllers.get(conversationId);

    if (controller) {
      controller.abort();
      abortControllers.delete(conversationId);
    }
  };

  const handleBranch = async (
    ws: ChatSocket,
    messageId: string,
    conversationId: string,
    content: string,
  ) => {
    const source = await store.get(conversationId);

    if (!source) {
      return;
    }

    const newConv = branchConversation(source, messageId);

    if (newConv) {
      await store.set(newConv.id, newConv);
      const clientMessageId = generateId();
      sendServerEvent(ws, {
        content,
        fromMessageId: messageId,
        messageId: clientMessageId,
        newConversationId: newConv.id,
        oldConversationId: conversationId,
        type: "branched",
      });
      enqueueUserMessage({
        clientMessageId,
        content,
        conversationId: newConv.id,
        ws,
      });
    }
  };

  const handleUserMessage = async (
    ws: ChatSocket,
    rawContent: string,
    conversationId: string,
    clientMessageId: string,
    attachments?: AIAttachment[],
    queueSignal?: AbortSignal,
  ) => {
    const assistantMessageId = generateId();
    const parsed = parseProvider(rawContent);
    const { content, providerName } = parsed;

    const conversation = await store.getOrCreate(conversationId);
    const history = getHistory(conversation);

    const controller = new AbortController();
    abortControllers.set(conversationId, controller);
    const abortFromQueue = () => controller.abort();
    queueSignal?.addEventListener("abort", abortFromQueue, { once: true });

    appendMessage(conversation, {
      attachments,
      content,
      conversationId,
      id: clientMessageId,
      role: "user",
      timestamp: Date.now(),
    });
    await store.set(conversationId, conversation);

    const model = resolveModel(config, parsed);
    const userMessage = buildUserMessage(content, attachments);

    try {
      await streamAI(ws, conversationId, assistantMessageId, {
        maxTurns: config.maxTurns,
        messages: [...history, userMessage],
        model,
        provider: config.provider(providerName),
        signal: controller.signal,
        systemPrompt: config.systemPrompt,
        reasoning: resolveReasoning(config, providerName, model),
        tools: resolveTools(config, providerName, model),
        onComplete: async (fullResponse, usage) => {
          const conv = await store.get(conversationId);

          if (conv) {
            appendMessage(conv, {
              content: fullResponse,
              conversationId,
              id: assistantMessageId,
              role: "assistant",
              timestamp: Date.now(),
            });
            await store.set(conversationId, conv);
          }

          config.onComplete?.(conversationId, fullResponse, usage);
        },
      });
    } finally {
      queueSignal?.removeEventListener("abort", abortFromQueue);
      if (abortControllers.get(conversationId) === controller) {
        abortControllers.delete(conversationId);
      }
    }
  };

  const queueForConversation = (conversationId: string) => {
    const existing = turnQueues.get(conversationId);
    if (existing) return existing;
    const queue = createConversationTurnQueue<QueuedUserTurn>({
      execute: async (turn, { signal }) => {
        sendServerEvent(turn.ws, {
          conversationId: turn.conversationId,
          messageId: turn.clientMessageId,
          type: "turn_started",
        });
        await handleUserMessage(
          turn.ws,
          turn.content,
          turn.conversationId,
          turn.clientMessageId,
          turn.attachments,
          signal,
        );
      },
      onError: (error, turn) => {
        sendServerEvent(turn.input.ws, {
          message: error instanceof Error ? error.message : "AI turn failed",
          type: "error",
        });
      },
    });
    turnQueues.set(conversationId, queue);
    let unsubscribe: () => void = () => undefined;
    unsubscribe = queue.subscribe(({ items }) => {
      if (items.length === 0 && turnQueues.get(conversationId) === queue) {
        turnQueues.delete(conversationId);
        unsubscribe();
      }
    });

    return queue;
  };

  function enqueueUserMessage(turn: QueuedUserTurn) {
    const queue = queueForConversation(turn.conversationId);
    const wasBusy = queue.getSnapshot().items.length > 0;
    queue.enqueue(turn, turn.clientMessageId);
    if (wasBusy) {
      const queued = queue
        .getSnapshot()
        .items.filter(({ status }) => status === "queued");
      const position =
        queued.findIndex(({ id }) => id === turn.clientMessageId) + 1;
      sendServerEvent(turn.ws, {
        conversationId: turn.conversationId,
        messageId: turn.clientMessageId,
        position,
        type: "turn_queued",
      });
    }
  }

  const htmxRoutes = () => {
    if (!config.htmx) {
      return new Elysia();
    }

    const renderers = resolveRenderers(
      typeof config.htmx === "object" ? config.htmx.render : undefined,
    );

    return new Elysia()
      .post(`${path}/message`, async ({ body }) => {
        const requestBody = body && typeof body === "object" ? body : {};
        const rawContent =
          "content" in requestBody ? String(requestBody.content) : undefined;
        const rawConvId =
          "conversationId" in requestBody
            ? String(requestBody.conversationId)
            : undefined;
        const rawAttachmentsValue =
          "attachments" in requestBody ? requestBody.attachments : undefined;
        const rawAttachments: AIAttachment[] | undefined = Array.isArray(
          rawAttachmentsValue,
        )
          ? rawAttachmentsValue
          : undefined;

        if (!rawContent) {
          return new Response("Missing content", { status: 400 });
        }

        const conversationId = rawConvId || generateId();
        const messageId = generateId();
        const parsed = parseProvider(rawContent);
        const { content } = parsed;

        const conversation = await store.getOrCreate(conversationId);

        appendMessage(conversation, {
          attachments: rawAttachments,
          content,
          conversationId,
          id: messageId,
          role: "user",
          timestamp: Date.now(),
        });
        await store.set(conversationId, conversation);

        const sseUrl = `${path}/sse/${conversationId}/${messageId}`;

        return new Response(
          `<div id="msg-${messageId}" class="message user">` +
            `<div>${content}</div>` +
            `</div>` +
            `<div id="response-${messageId}" ` +
            `hx-ext="sse" ` +
            `sse-connect="${sseUrl}" ` +
            `hx-swap="innerHTML">` +
            `<div id="sse-content-${messageId}" sse-swap="content" hx-swap="innerHTML"></div>` +
            `<div id="sse-thinking-${messageId}" sse-swap="thinking" hx-swap="innerHTML"></div>` +
            `<div id="sse-tools-${messageId}" sse-swap="tools" hx-swap="innerHTML"></div>` +
            `<div id="sse-images-${messageId}" sse-swap="images" hx-swap="innerHTML"></div>` +
            `<div id="sse-status-${messageId}" sse-swap="status" hx-swap="innerHTML"></div>` +
            `</div>`,
          { headers: { "Content-Type": "text/html" } },
        );
      })
      .get(
        `${path}/sse/:conversationId/:messageId`,
        async function* ({ params }) {
          const { conversationId, messageId } = params;
          const conversation = await store.get(conversationId);

          if (!conversation) {
            yield {
              data: renderers.error("Conversation not found"),
              event: "status",
            };

            return;
          }

          const parsed = parseProvider(
            conversation.messages.at(EXCLUDE_LAST_OFFSET)?.content ?? "",
          );
          const { providerName } = parsed;
          const model = resolveModel(config, parsed);

          const controller = new AbortController();
          abortControllers.set(conversationId, controller);

          const history = getHistory(conversation);

          const lastMsg = conversation.messages.at(EXCLUDE_LAST_OFFSET);
          const userMessage = buildUserMessage(
            lastMsg?.content ?? "",
            lastMsg?.attachments,
          );

          const sseStream = streamAIToSSE(
            conversationId,
            messageId,
            {
              maxTurns: config.maxTurns,
              messages: [...history.slice(0, EXCLUDE_LAST_OFFSET), userMessage],
              model,
              provider: config.provider(providerName),
              signal: controller.signal,
              systemPrompt: config.systemPrompt,
              reasoning: resolveReasoning(config, providerName, model),
              tools: resolveTools(config, providerName, model),
            },
            renderers,
          );

          for await (const event of sseStream) {
            yield event;
          }

          const conv = await store.get(conversationId);

          if (conv) {
            await store.set(conversationId, conv);
          }

          abortControllers.delete(conversationId);
        },
      )
      .get(`${path}/history/:conversationId`, async ({ params }) => {
        const conv = await store.get(params.conversationId);

        if (!conv) {
          return new Response("", { status: 404 });
        }

        const html = conv.messages
          .map(
            (msg) =>
              `<div class="message ${msg.role}"><div>${msg.content}</div></div>`,
          )
          .join("");

        return new Response(html, {
          headers: { "Content-Type": "text/html" },
        });
      })
      .get(`${path}/conversations/list`, async () => {
        const convos = await store.list();
        const html = convos
          .map(
            (c) =>
              `<div class="conversation-item" ` +
              `hx-get="${path}/history/${c.id}" ` +
              `hx-target="#messages" ` +
              `hx-swap="innerHTML">` +
              `<span class="title">${c.title}</span>` +
              `<span class="count">${c.messageCount} messages</span>` +
              `</div>`,
          )
          .join("");

        return new Response(
          html || '<div class="empty">No conversations</div>',
          { headers: { "Content-Type": "text/html" } },
        );
      });
  };

  const app = new Elysia()
    .ws(path, {
      message: async (ws, raw) => {
        const msg = parseAIMessage(raw);

        if (!msg) {
          return;
        }

        if (msg.type === "cancel" && msg.conversationId) {
          handleCancel(msg.conversationId);

          return;
        }

        if (msg.type === "branch") {
          await handleBranch(
            ws,
            msg.messageId,
            msg.conversationId,
            msg.content,
          );

          return;
        }

        if (msg.type === "message") {
          const conversationId = msg.conversationId ?? generateId();
          enqueueUserMessage({
            attachments: msg.attachments,
            clientMessageId: msg.messageId ?? generateId(),
            content: msg.content,
            conversationId,
            ws,
          });
        }
      },
    })
    .get(`${path}/conversations`, () => store.list())
    .get(`${path}/conversations/:id`, async ({ params }) => {
      const conv = await store.get(params.id);

      if (!conv) {
        return new Response("Not found", { status: 404 });
      }

      return {
        id: conv.id,
        messages: conv.messages,
        title: conv.title ?? "Untitled",
      };
    })
    .delete(`${path}/conversations/:id`, async ({ params }) => {
      await store.remove(params.id);

      return { ok: true };
    })
    .use(htmxRoutes());

  // aiChat mounts chat/SSE/WS routes whose paths are CONFIGURABLE (config.path
  // → Elysia keys them by `string`) and the htmx branch is a conditional union
  // — so the inferred return both can't be precisely typed and explodes a
  // consumer's server type. It exposes no global context, so the honest public
  // type is a base Elysia (routes reached by path at runtime).
  return app as unknown as Elysia;
};
