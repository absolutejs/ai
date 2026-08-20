import type { AIClientMessage, AIServerMessage } from "./ai";

export const isValidAIClientMessage = (
  data: unknown,
): data is AIClientMessage => {
  if (!data || typeof data !== "object") {
    return false;
  }

  if (!("type" in data) || typeof data.type !== "string") {
    return false;
  }

  switch (data.type) {
    case "message":
      return "content" in data && typeof data.content === "string";
    case "cancel":
      return (
        "conversationId" in data && typeof data.conversationId === "string"
      );
    case "branch":
    case "edit":
      return (
        "messageId" in data &&
        typeof data.messageId === "string" &&
        "content" in data &&
        typeof data.content === "string" &&
        "conversationId" in data &&
        typeof data.conversationId === "string"
      );
    default:
      return false;
  }
};

export const isValidAIServerMessage = (
  data: unknown,
): data is AIServerMessage => {
  if (!data || typeof data !== "object") {
    return false;
  }

  if (!("type" in data) || typeof data.type !== "string") {
    return false;
  }

  switch (data.type) {
    case "chunk":
    case "thinking":
      return (
        "content" in data &&
        typeof data.content === "string" &&
        "messageId" in data &&
        "conversationId" in data
      );
    case "tool_status":
      return (
        "name" in data &&
        "status" in data &&
        "messageId" in data &&
        "conversationId" in data
      );
    case "image":
      return (
        "data" in data &&
        typeof data.data === "string" &&
        "format" in data &&
        typeof data.format === "string" &&
        "isPartial" in data &&
        typeof data.isPartial === "boolean" &&
        "messageId" in data &&
        "conversationId" in data
      );
    case "audio":
      return (
        "data" in data &&
        typeof data.data === "string" &&
        "format" in data &&
        typeof data.format === "string" &&
        "messageId" in data &&
        "conversationId" in data
      );
    case "complete":
      return "messageId" in data && "conversationId" in data;
    case "turn_queued":
      return (
        "conversationId" in data &&
        typeof data.conversationId === "string" &&
        "messageId" in data &&
        typeof data.messageId === "string" &&
        "position" in data &&
        typeof data.position === "number"
      );
    case "turn_started":
      return (
        "conversationId" in data &&
        typeof data.conversationId === "string" &&
        "messageId" in data &&
        typeof data.messageId === "string"
      );
    case "branched":
      return (
        "content" in data &&
        typeof data.content === "string" &&
        "fromMessageId" in data &&
        typeof data.fromMessageId === "string" &&
        "messageId" in data &&
        typeof data.messageId === "string" &&
        "newConversationId" in data &&
        typeof data.newConversationId === "string" &&
        "oldConversationId" in data &&
        typeof data.oldConversationId === "string" &&
        (!("mode" in data) || data.mode === "append" || data.mode === "replace")
      );
    case "rag_retrieved":
      return (
        "conversationId" in data &&
        "messageId" in data &&
        "sources" in data &&
        Array.isArray(data.sources)
      );
    case "error":
      return "message" in data && typeof data.message === "string";
    default:
      return false;
  }
};
