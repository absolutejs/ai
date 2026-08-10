import { describe, expect, test } from "bun:test";
import {
  isAIComposerSubmitKey,
  resizeAIComposerTextarea,
} from "../src/ai/client/composer";

const textarea = (scrollHeight: number) =>
  ({
    scrollHeight,
    style: {
      boxSizing: "",
      height: "",
      overflowY: "",
      paddingBlock: "",
    },
  }) as unknown as HTMLTextAreaElement;

const keyboardEvent = (input: Partial<KeyboardEvent>) =>
  ({
    isComposing: false,
    key: "",
    shiftKey: false,
    ...input,
  }) as KeyboardEvent;

describe("AI composer helpers", () => {
  test("centers a single line at the minimum control height", () => {
    const field = textarea(20);

    resizeAIComposerTextarea(field, {
      lineHeight: 20,
      maxHeight: 144,
      minHeight: 44,
    });

    expect(field.style.boxSizing).toBe("border-box");
    expect(field.style.paddingBlock).toBe("12px");
    expect(field.style.height).toBe("44px");
    expect(field.style.overflowY).toBe("hidden");
  });

  test("grows to its cap and then enables internal scrolling", () => {
    const field = textarea(180);

    resizeAIComposerTextarea(field, { maxHeight: 144, minHeight: 44 });

    expect(field.style.height).toBe("144px");
    expect(field.style.overflowY).toBe("auto");
  });

  test("submits only plain Enter outside IME composition", () => {
    expect(isAIComposerSubmitKey(keyboardEvent({ key: "Enter" }))).toBe(true);
    expect(
      isAIComposerSubmitKey(keyboardEvent({ isComposing: true, key: "Enter" })),
    ).toBe(false);
    expect(
      isAIComposerSubmitKey(keyboardEvent({ key: "Enter", shiftKey: true })),
    ).toBe(false);
  });
});
