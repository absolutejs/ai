import type { AIProviderConfig } from "../types/ai";
/** Deliberate capacity stub for transport/tool behavior tests. Real budget
 * boundaries and provider transformations are covered in contextPolicy/inputCapacity tests. */
export const testInputCapacity: NonNullable<AIProviderConfig["inputCapacity"]> =
  {
    getLimits: async () => ({
      maxInputTokens: 1_000_000,
      maxOutputTokens: 100_000,
    }),
    countTokens: async () => 1,
  };
