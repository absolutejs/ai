import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  kind: "added",
  summary:
    "Tools can return images for the model to see, such as a screenshot: a handler returns { text, images } and the tool loops send the images inside the tool result, mapped for Anthropic, OpenAI Responses, OpenAI Chat Completions, Gemini and Ollama",
  symbols: [
    "AIToolResult",
    "AIToolOutput",
    "AIProviderContentBlock",
    "anthropic",
    "openai",
    "openaiResponses",
    "gemini",
    "ollama",
    "streamAIToSSE",
    "streamAIWithTools",
    "generateAIWithTools",
    "hardenUntrustedTool",
    "createAIStoredToolResultRecovery",
  ],
};
