import type { FormSpec } from "./catalog";
export type FormSubmission =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };
/** Convert typed fields once for every renderer. Final tool-schema validation
 * and authorization remain the host's responsibility. Never include secrets in errors. */
export const prepareFormSubmission = (
  form: FormSpec,
  values: Record<string, unknown>,
): FormSubmission => {
  const input: Record<string, unknown> = { ...form.submit.input };
  const errors: Record<string, string> = {};
  for (const field of form.fields) {
    if (["__proto__", "constructor", "prototype"].includes(field.name)) {
      errors.form = "Invalid field name";
      continue;
    }
    const raw = values[field.name];
    if (
      raw === undefined ||
      raw === null ||
      (typeof raw === "string" && !raw.trim())
    ) {
      if (field.required) errors[field.name] = "This field is required";
      continue;
    }
    if (field.type === "select" && !field.options?.includes(String(raw))) {
      errors[field.name] = "Choose one of the available options";
      continue;
    }
    const type =
      field.valueType ??
      (field.type === "number"
        ? "number"
        : field.type === "checkbox"
          ? "boolean"
          : "string");
    let value: unknown = raw;
    if (type === "number" || type === "integer") {
      value =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" &&
              /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(raw.trim())
            ? Number(raw)
            : NaN;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (type === "integer" && !Number.isSafeInteger(value))
      ) {
        errors[field.name] =
          type === "integer" ? "Enter a whole number" : "Enter a number";
        continue;
      }
    } else if (type === "boolean") {
      if (![true, false, "true", "false"].includes(raw as boolean | string)) {
        errors[field.name] = "Choose yes or no";
        continue;
      }
      value = raw === true || raw === "true";
      if (field.type === "checkbox" && field.required && !value) {
        errors[field.name] = "This field is required";
        continue;
      }
    } else {
      if (typeof raw !== "string") {
        errors[field.name] = "Enter text";
        continue;
      }
      value = field.type === "password" ? raw : raw.trim();
    }
    input[field.name] = value;
  }
  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, input };
};
