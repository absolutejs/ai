import type { AIUsage } from "../../types/ai";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Extract bounded validation diagnostics, never the rejected value. Supports
 * TypeBox/Ajv errors and Zod issues without requiring either validator. */
export const structuredOutputDiagnostics = (error: unknown): string => {
  const source = record(error) && record(error.cause) ? error.cause : error;
  const issues = record(source) ? (source.errors ?? source.issues) : undefined;
  if (Array.isArray(issues)) {
    const details = issues
      .slice(0, 10)
      .filter(record)
      .map((issue) => {
        const path =
          typeof issue.instancePath === "string"
            ? issue.instancePath
            : Array.isArray(issue.path)
              ? issue.path.join(".")
              : "/";
        const expected = record(issue.params)
          ? issue.params.type
          : issue.expected;
        const message =
          typeof expected === "string"
            ? `must be ${expected}`
            : typeof issue.keyword === "string"
              ? `failed ${issue.keyword} validation`
              : typeof issue.code === "string"
                ? `failed ${issue.code} validation`
                : "does not satisfy the schema";
        return `${path.slice(0, 160) || "/"}: ${message.slice(0, 160)}`;
      });
    if (details.length) return details.join("; ").slice(0, 1500);
  }
  return (
    error instanceof Error
      ? error.message
      : "Output does not satisfy the schema"
  ).slice(0, 1500);
};

/** A completed generation produced no valid structured result after bounded
 * repair. Transport/auth/budget failures retain their original error types. */
export class StructuredOutputError extends Error {
  readonly code = "AI_STRUCTURED_OUTPUT_INVALID";
  constructor(
    readonly reason: "validation" | "missing_tool",
    readonly attempts: number,
    readonly usage: AIUsage | undefined,
    cause: unknown,
  ) {
    super(
      `Structured AI output failed after ${attempts} attempt(s): ${structuredOutputDiagnostics(cause)}`,
      { cause },
    );
    this.name = "StructuredOutputError";
  }
}
