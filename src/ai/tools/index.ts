/**
 * `@absolutejs/ai/tools` — first-party `AIToolDefinition`s ready to drop
 * into the `tools: {...}` map you hand to `streamAI` / `generateAI`.
 *
 * - {@link codeExecutionTool} — execute model-generated JavaScript in a
 *   sandboxed `@absolutejs/isolated-jsc` isolate. Optional peer; install
 *   `@absolutejs/isolated-jsc` to use it.
 * - {@link codeModeTool} — "Code Mode" wrapper for N host tools: model
 *   sees typed TS signatures, emits one function chaining several
 *   tool calls, ~80% token reduction vs N separate tool calls.
 */

export {
  codeExecutionTool,
  type CodeExecutionToolOptions,
} from "./codeExecution";
export {
  type CodeModeHostTool,
  codeModeTool,
  type CodeModeToolOptions,
} from "./codeMode";
