import type { Change } from "@absolutejs/changelog";
export const change: Change = {
  kind: "added",
  summary:
    "Add one-section text preparation steps for durable workers, with explicit pending/ready outcomes and checkpoint persistence before yielding",
  symbols: ["prepareAITextInputStep", "AITextPreparationStep"],
};
