import type { AIContextPolicy } from "./contextPolicy";

/** Reclaim older results ONLY for tools that reread immutable saved sources.
 * The caller guarantees these names can reproduce the original at the same
 * authorized version. Other results, calls, thinking and the newest lookup stay
 * intact. This does not delete originals, summarize facts, run tools, or truncate
 * the latest evidence. If that is insufficient, the policy fails explicitly. */
export const createAIStoredToolResultRecovery =
  (toolNames: readonly string[]): NonNullable<AIContextPolicy["recover"]> =>
  async ({ params }) => {
    const names = new Set(toolNames);
    const eligible = new Set<string>();
    for (const message of params.messages) {
      if (typeof message.content === "string") continue;
      for (const block of message.content) {
        if (block.type === "tool_use" && names.has(block.name))
          eligible.add(block.id);
      }
    }
    const results = params.messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.filter(
            (block) =>
              block.type === "tool_result" && eligible.has(block.tool_use_id),
          ),
    );
    const newest = results.at(-1);
    return params.messages.map((message) => ({
      ...message,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((block) => {
              if (
                block.type !== "tool_result" ||
                !eligible.has(block.tool_use_id) ||
                block === newest
              )
                return block;
              const marker =
                "[Earlier lookup removed from working context. Its immutable original remains saved. The original tool call and source/version arguments above are unchanged: repeat that lookup if needed to verify facts. Do not infer facts from this marker.]";
              // Do not replace a small result with a larger marker.
              return block.content.length > marker.length
                ? { ...block, content: marker }
                : block;
            }),
    }));
  };
