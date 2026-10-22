const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Losslessly lower finite-key records (including Zod partialRecord) into
 * named optional properties. Never discard arbitrary key constraints. */
export const openaiSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...schema };
  for (const key of [
    "properties",
    "$defs",
    "definitions",
    "patternProperties",
  ]) {
    const value = result[key];
    if (record(value))
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          record(child) ? openaiSchema(child) : child,
        ]),
      );
  }
  for (const key of [
    "items",
    "additionalProperties",
    "not",
    "if",
    "then",
    "else",
  ])
    if (record(result[key])) result[key] = openaiSchema(result[key]);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
    if (Array.isArray(result[key]))
      result[key] = result[key].map((child: unknown) =>
        record(child) ? openaiSchema(child) : child,
      );
  const names = result.propertyNames;
  if (
    record(names) &&
    Array.isArray(names.enum) &&
    names.enum.every((key) => typeof key === "string") &&
    Object.keys(names).every((key) =>
      ["enum", "type", "description", "title"].includes(key),
    ) &&
    !result.patternProperties
  ) {
    const existing = record(result.properties) ? result.properties : {};
    const additional = result.additionalProperties;
    const entries = names.enum
      .filter(
        (key: string) => Object.hasOwn(existing, key) || additional !== false,
      )
      .map((key: string) => [
        key,
        Object.hasOwn(existing, key)
          ? existing[key]
          : record(additional)
            ? additional
            : {},
      ]);
    result.properties = Object.fromEntries(entries);
    result.additionalProperties = false;
    delete result.propertyNames;
  }
  return result;
};

export const isStrictCompatible = (schema: unknown): boolean => {
  if (Array.isArray(schema)) return schema.every(isStrictCompatible);
  if (!record(schema)) return true;
  if (schema.propertyNames || schema.patternProperties) return false;
  const properties = record(schema.properties) ? schema.properties : {};
  if (
    schema.type === "object" ||
    schema.properties ||
    schema.additionalProperties !== undefined
  ) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (
      schema.additionalProperties !== false ||
      !Object.keys(properties).every((key) => required.includes(key))
    )
      return false;
  }
  const nested = [
    schema.items,
    schema.anyOf,
    schema.oneOf,
    schema.allOf,
    schema.additionalProperties,
  ];
  for (const map of [properties, schema.$defs, schema.definitions])
    if (record(map)) nested.push(...Object.values(map));
  return nested.every(isStrictCompatible);
};
