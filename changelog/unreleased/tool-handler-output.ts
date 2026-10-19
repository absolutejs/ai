import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  kind: "breaking",
  migration: {
    manual: true,
    instruction:
      "Code that calls a tool's handler itself (a wrapper, a test) now receives AIToolOutput, a string or { text, images }. Read its text with toolOutputText(output). Handlers that return a string need no change.",
  },
  summary:
    "AIToolDefinition.handler may return { text, images } as well as a string",
  symbols: ["AIToolDefinition", "toolOutputText"],
};
