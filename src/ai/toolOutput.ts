import type {
  AIImageSource,
  AIProviderContentBlock,
  AIToolOutput,
} from "../../types/ai";

/** The text of a tool's output: what the UI, `onToolUse` and logs see. */
export const toolOutputText = (output: AIToolOutput) =>
  typeof output === "string" ? output : output.text;

/** Explicit model projection, distinct from the complete UI/audit payload. */
export const toolOutputModelText = (output: AIToolOutput) =>
  typeof output === "string" ? output : (output.modelText ?? output.text);

const toolOutputImages = (output: AIToolOutput) =>
  typeof output === "string" || !output.images?.length
    ? undefined
    : output.images;

/** The tool_result block fed back to the model. `content` may be a clipped
 *  copy of the text; images ride along untouched. */
export const toolResultBlock = (
  toolUseId: string,
  output: AIToolOutput,
  content = toolOutputModelText(output),
): Extract<AIProviderContentBlock, { type: "tool_result" }> => {
  const images: AIImageSource[] | undefined = toolOutputImages(output);

  return images
    ? { content, images, tool_use_id: toolUseId, type: "tool_result" }
    : { content, tool_use_id: toolUseId, type: "tool_result" };
};
