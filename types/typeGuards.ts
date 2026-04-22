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
    case "complete":
      return "messageId" in data && "conversationId" in data;
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
