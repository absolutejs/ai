export type AIComposerSizingOptions = {
  /** Text line height in CSS pixels. */
  lineHeight?: number;
  /** Largest rendered textarea height before internal scrolling begins. */
  maxHeight?: number;
  /** Smallest rendered textarea height, normally the adjacent button height. */
  minHeight?: number;
};

const positiveNumber = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;

/**
 * Size an AI chat textarea to its content while keeping its first line
 * vertically centered beside fixed-height composer controls.
 */
export const resizeAIComposerTextarea = (
  field: HTMLTextAreaElement | null | undefined,
  options: AIComposerSizingOptions = {},
) => {
  if (!field) return;

  const lineHeight = positiveNumber(options.lineHeight, 24);
  const minHeight = Math.max(
    lineHeight,
    positiveNumber(options.minHeight, lineHeight),
  );
  const maxHeight = Math.max(minHeight, positiveNumber(options.maxHeight, 168));
  const verticalPadding = Math.max(0, (minHeight - lineHeight) / 2);

  field.style.boxSizing = "border-box";
  field.style.paddingBlock = `${verticalPadding}px`;
  field.style.height = "auto";

  const contentHeight = Math.max(minHeight, field.scrollHeight);
  field.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  field.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
};

/** Plain Enter submits; Shift+Enter and IME confirmation keep editing. */
export const isAIComposerSubmitKey = (event: KeyboardEvent) =>
  event.key === "Enter" && !event.shiftKey && !event.isComposing;
