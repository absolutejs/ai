/**
 * `@absolutejs/ai/tools` — first-party `AIToolDefinition`s ready to drop
 * into the `tools: {...}` map you hand to `streamAI` / `generateAI`.
 *
 * - {@link codeExecutionTool} — execute model-generated JavaScript in a
 *   sandboxed `@absolutejs/isolated-jsc` isolate. Optional peer; install
 *   `@absolutejs/isolated-jsc` to use it.
 */

export {
  codeExecutionTool,
  type CodeExecutionToolOptions,
} from "./codeExecution";
