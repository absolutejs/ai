import { change } from "@absolutejs/changelog";

export default change({
  kind: "breaking",
  summary:
    "codeExecutionTool and codeModeTool refuse to run model-written code on a Worker isolate that is not locked down",
  symbols: ["codeExecutionTool", "codeModeTool"],
  detail:
    "Both tools take a new `requireLockdown` option, default `true`. On the Worker backend, stock Bun lets sandboxed code reach the `Bun` global through indirect eval and load any module with `import()`, so model-written code could spawn processes or read files. isolated-jsc 0.13 locks Worker isolates down on AbsoluteJS patched Bun 1.4.4+absolute.2 and later, and these tools now insist on it: on stock Bun without libJavaScriptCore a run fails with `LockdownUnavailableError` instead of running escapable code. The FFI backend is unaffected. The `@absolutejs/isolated-jsc` peer range is now `>=0.13.0`, since older versions ignore the option.",
  migration: {
    instruction:
      "Run on AbsoluteJS patched Bun 1.4.4+absolute.2 or later (the AbsoluteJS CLI installs it), or install libJavaScriptCore so the FFI backend is used, and upgrade @absolutejs/isolated-jsc to 0.13 or later. To keep the old behavior for code you trust, pass `requireLockdown: false`.",
    manual: true,
  },
});
