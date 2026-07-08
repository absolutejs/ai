import type { UiCardDefinition } from "./uiCards";

/**
 * Built-in UI card catalog: chart, table, stat tiles. Declarative specs the
 * model authors and the host renders — see svg.ts for the dependency-free
 * default renderer. Caps are hard product guards (a model can't render a
 * 400-row table into a chat bubble).
 */

export const CHART_TYPES = ["bar", "line", "donut"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export type ChartSeries = { name: string; values: number[] };

export type ChartSpec = {
  type: ChartType;
  title: string;
  /** Category labels: x-axis (bar/line) or slice names (donut). */
  labels: string[];
  /** ≤ 8 series (fixed hue order). Donut charts use exactly one series. */
  series: ChartSeries[];
  /** Value formatting, e.g. "$" / "%". */
  unitPrefix?: string;
  unitSuffix?: string;
  /** Optional action buttons rendered under the card (≤ 3). */
  actions?: UiAction[];
};

export type TableSpec = {
  title?: string;
  columns: string[];
  rows: string[][];
  /** Optional action buttons rendered under the card (≤ 3). */
  actions?: UiAction[];
};

export type StatTile = {
  label: string;
  value: string;
  /** Optional change annotation, e.g. "+12% vs last month". */
  delta?: string;
  deltaDirection?: "up" | "down" | "flat";
};

export type StatTilesSpec = { tiles: StatTile[]; actions?: UiAction[] };

/**
 * An action binding on a UI card: a button the host renders under the card
 * that, on click, invokes one of the HOST'S OWN tools with a model-authored
 * input. The host decides which tools are click-invokable (approval-gated
 * tools should queue their normal approval flow, and anything like "approve a
 * pending action" should be refused outright) and validates the input against
 * the tool exactly as if the model had called it.
 */
export type UiAction = {
  /** Button label, e.g. "Create follow-up task". */
  label: string;
  /** The host tool to invoke, e.g. "create_task". */
  tool: string;
  /** The tool input, fully resolved by the model (real ids, not placeholders). */
  input: Record<string, unknown>;
};

export const FORM_FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "select",
  "date",
  "checkbox",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export type FormField = {
  /** Key the value is submitted under — a valid tool-input property name. */
  name: string;
  label: string;
  type: FormFieldType;
  placeholder?: string;
  required?: boolean;
  /** Choices — select fields only. */
  options?: string[];
  /** Prefill (checkbox: "true"/"false"). */
  value?: string;
};

/**
 * An inline form the model renders when it needs several structured inputs
 * from the member before running a tool. On submit the host merges the field
 * values into `submit.input` under their field names and invokes `submit.tool`
 * exactly like a clicked UiAction.
 */
export type FormSpec = {
  title: string;
  description?: string;
  fields: FormField[];
  submit: UiAction;
};

// Hard caps — chat-bubble scale, and the fixed 8-slot categorical order.
export const CHART_MAX_SERIES = 8;
export const CHART_MAX_POINTS = 24;
export const TABLE_MAX_COLUMNS = 8;
export const TABLE_MAX_ROWS = 30;
export const STAT_TILES_MAX = 6;
export const UI_ACTIONS_MAX = 3;
export const FORM_MAX_FIELDS = 8;
export const FORM_SELECT_MAX_OPTIONS = 12;
const LABEL_MAX_CHARS = 80;
const TITLE_MAX_CHARS = 120;
const CELL_MAX_CHARS = 160;
const UNIT_MAX_CHARS = 8;
const ACTION_LABEL_MAX_CHARS = 40;
const DESCRIPTION_MAX_CHARS = 280;
// Tool names are host identifiers, not prose.
const ACTION_TOOL_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
// Field names become tool-input property keys.
const FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const cleanString = (value: unknown, maxChars: number) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maxChars)
    : null;

const cleanStringArray = (
  value: unknown,
  maxItems: number,
  maxChars: number,
) => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const cleaned: string[] = [];
  for (const entry of value.slice(0, maxItems)) {
    const text = cleanString(entry, maxChars);
    cleaned.push(text ?? "");
  }

  return cleaned;
};

const cleanNumberArray = (value: unknown, maxItems: number) => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const cleaned: number[] = [];
  for (const entry of value.slice(0, maxItems)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    cleaned.push(entry);
  }

  return cleaned;
};

/** Validate a spec's optional action bindings; undefined when none/invalid.
 *  Malformed entries drop individually — a bad button never sinks the card. */
export const parseUiActions = (value: unknown): UiAction[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const actions: UiAction[] = [];
  for (const raw of value.slice(0, UI_ACTIONS_MAX)) {
    if (!isRecord(raw)) continue;
    const label = cleanString(raw.label, ACTION_LABEL_MAX_CHARS);
    const tool =
      typeof raw.tool === "string" && ACTION_TOOL_PATTERN.test(raw.tool)
        ? raw.tool
        : null;
    if (!label || !tool || !isRecord(raw.input)) continue;
    actions.push({ input: raw.input, label, tool });
  }

  return actions.length > 0 ? actions : undefined;
};

const ACTIONS_SCHEMA = {
  description:
    "Optional action buttons under the card (max 3): each invokes one of YOUR tools with a fully-resolved input when the member clicks it. Use real ids you looked up — never placeholders. Approval-gated tools queue their normal approval card.",
  items: {
    properties: {
      input: {
        description: "The exact tool input to send on click",
        type: "object",
      },
      label: {
        description: 'Short button label, e.g. "Create follow-up task"',
        type: "string",
      },
      tool: { description: "The tool name to invoke", type: "string" },
    },
    required: ["label", "tool", "input"],
    type: "object",
  },
  type: "array",
};

export const parseChartSpec = (input: unknown): ChartSpec | null => {
  if (!isRecord(input)) return null;
  const type = CHART_TYPES.find((entry) => entry === input.type);
  const title = cleanString(input.title, TITLE_MAX_CHARS);
  const labels = cleanStringArray(
    input.labels,
    CHART_MAX_POINTS,
    LABEL_MAX_CHARS,
  );
  if (!type || !title || !labels) return null;

  if (!Array.isArray(input.series) || input.series.length === 0) return null;
  const series: ChartSeries[] = [];
  for (const raw of input.series.slice(0, CHART_MAX_SERIES)) {
    if (!isRecord(raw)) return null;
    const name = cleanString(raw.name, LABEL_MAX_CHARS);
    const values = cleanNumberArray(raw.values, CHART_MAX_POINTS);
    if (!name || !values) return null;
    // Every series aligns with the label axis; pad/trim mismatches drop.
    if (values.length !== labels.length) return null;
    series.push({ name, values });
  }
  // Donut: one series, non-negative slices.
  if (type === "donut") {
    const [only] = series;
    if (series.length !== 1 || !only) return null;
    if (only.values.some((value) => value < 0)) return null;
  }

  const spec: ChartSpec = { labels, series, title, type };
  const unitPrefix = cleanString(input.unitPrefix, UNIT_MAX_CHARS);
  const unitSuffix = cleanString(input.unitSuffix, UNIT_MAX_CHARS);
  if (unitPrefix) spec.unitPrefix = unitPrefix;
  if (unitSuffix) spec.unitSuffix = unitSuffix;
  const actions = parseUiActions(input.actions);
  if (actions) spec.actions = actions;

  return spec;
};

export const parseTableSpec = (input: unknown): TableSpec | null => {
  if (!isRecord(input)) return null;
  const columns = cleanStringArray(
    input.columns,
    TABLE_MAX_COLUMNS,
    LABEL_MAX_CHARS,
  );
  if (!columns) return null;
  if (!Array.isArray(input.rows) || input.rows.length === 0) return null;
  const rows: string[][] = [];
  for (const raw of input.rows.slice(0, TABLE_MAX_ROWS)) {
    const cells = cleanStringArray(raw, TABLE_MAX_COLUMNS, CELL_MAX_CHARS);
    if (!cells) return null;
    // Normalize ragged rows to the header width.
    while (cells.length < columns.length) cells.push("");
    rows.push(cells.slice(0, columns.length));
  }

  const spec: TableSpec = { columns, rows };
  const title = cleanString(input.title, TITLE_MAX_CHARS);
  if (title) spec.title = title;
  const actions = parseUiActions(input.actions);
  if (actions) spec.actions = actions;

  return spec;
};

export const parseStatTilesSpec = (input: unknown): StatTilesSpec | null => {
  if (!isRecord(input)) return null;
  if (!Array.isArray(input.tiles) || input.tiles.length === 0) return null;
  const tiles: StatTile[] = [];
  for (const raw of input.tiles.slice(0, STAT_TILES_MAX)) {
    if (!isRecord(raw)) return null;
    const label = cleanString(raw.label, LABEL_MAX_CHARS);
    const value = cleanString(raw.value, LABEL_MAX_CHARS);
    if (!label || !value) return null;
    const tile: StatTile = { label, value };
    const delta = cleanString(raw.delta, LABEL_MAX_CHARS);
    if (delta) tile.delta = delta;
    if (
      raw.deltaDirection === "up" ||
      raw.deltaDirection === "down" ||
      raw.deltaDirection === "flat"
    ) {
      tile.deltaDirection = raw.deltaDirection;
    }
    tiles.push(tile);
  }

  const spec: StatTilesSpec = { tiles };
  const actions = parseUiActions(input.actions);
  if (actions) spec.actions = actions;

  return spec;
};

const parseFormField = (raw: unknown): FormField | null => {
  if (!isRecord(raw)) return null;
  const name =
    typeof raw.name === "string" && FIELD_NAME_PATTERN.test(raw.name)
      ? raw.name
      : null;
  const label = cleanString(raw.label, LABEL_MAX_CHARS);
  const type = FORM_FIELD_TYPES.find((entry) => entry === raw.type);
  if (!name || !label || !type) return null;

  const field: FormField = { label, name, type };
  const placeholder = cleanString(raw.placeholder, LABEL_MAX_CHARS);
  if (placeholder) field.placeholder = placeholder;
  if (raw.required === true) field.required = true;
  const value = cleanString(raw.value, CELL_MAX_CHARS);
  if (value) field.value = value;
  const options = cleanStringArray(
    raw.options,
    FORM_SELECT_MAX_OPTIONS,
    LABEL_MAX_CHARS,
  );
  if (options) field.options = options;
  // A select without choices can never be filled in.
  if (type === "select" && !options) return null;

  return field;
};

const parseFormFields = (value: unknown): FormField[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const fields: FormField[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, FORM_MAX_FIELDS)) {
    const field = parseFormField(raw);
    // One malformed or duplicate field sinks the form — a partial form would
    // submit a payload the bound tool never expected.
    if (!field || seen.has(field.name)) return null;
    seen.add(field.name);
    fields.push(field);
  }

  return fields;
};

export const parseFormSpec = (input: unknown): FormSpec | null => {
  if (!isRecord(input)) return null;
  const title = cleanString(input.title, TITLE_MAX_CHARS);
  const fields = parseFormFields(input.fields);
  const [submit] = parseUiActions([input.submit]) ?? [];
  if (!title || !fields || !submit) return null;

  const spec: FormSpec = { fields, submit, title };
  const description = cleanString(input.description, DESCRIPTION_MAX_CHARS);
  if (description) spec.description = description;

  return spec;
};

const SERIES_SCHEMA = {
  properties: {
    name: { description: "Series name (shown in the legend)", type: "string" },
    values: {
      description: "One number per label, same order as labels",
      items: { type: "number" },
      type: "array",
    },
  },
  required: ["name", "values"],
  type: "object",
};

/** render_chart — bar / line / donut from data you already have. */
export const chartCard: UiCardDefinition<ChartSpec> = {
  ack: "(chart rendered inline — do not repeat its numbers as text; add at most a 1-2 line takeaway)",
  description:
    "Render a real chart inline in the chat from data you have (tool results, the conversation). Use whenever numbers COMPARE or TREND: revenue by partner (bar), pipeline over time (line), share of a whole (donut). Rules: bar/line take up to 8 series aligned to the same labels; donut takes exactly ONE series of non-negative values (one slice per label). Prefer a chart over a wall of numbers, but never invent data for it.",
  inputSchema: {
    properties: {
      actions: ACTIONS_SCHEMA,
      labels: {
        description:
          "Category labels — x-axis for bar/line, slice names for donut (max 24)",
        items: { type: "string" },
        type: "array",
      },
      series: {
        description: "Data series (max 8; donut exactly 1)",
        items: SERIES_SCHEMA,
        type: "array",
      },
      title: { description: "Short chart title", type: "string" },
      type: { enum: [...CHART_TYPES], type: "string" },
      unitPrefix: {
        description: 'Prepended to values, e.g. "$"',
        type: "string",
      },
      unitSuffix: {
        description: 'Appended to values, e.g. "%"',
        type: "string",
      },
    },
    required: ["type", "title", "labels", "series"],
    type: "object",
  },
  name: "render_chart",
  parse: parseChartSpec,
};

/** render_table — a compact data table. */
export const tableCard: UiCardDefinition<TableSpec> = {
  ack: "(table rendered inline — do not repeat its rows as text)",
  description:
    "Render a compact data table inline in the chat (max 8 columns × 30 rows). Use for structured comparisons the member will scan — matches side by side, deal terms, task lists with dates. All cells are strings; format numbers yourself.",
  inputSchema: {
    properties: {
      actions: ACTIONS_SCHEMA,
      columns: {
        description: "Column headers (max 8)",
        items: { type: "string" },
        type: "array",
      },
      rows: {
        description: "Rows of cells, each aligned to columns (max 30)",
        items: { items: { type: "string" }, type: "array" },
        type: "array",
      },
      title: { description: "Optional table title", type: "string" },
    },
    required: ["columns", "rows"],
    type: "object",
  },
  name: "render_table",
  parse: parseTableSpec,
};

/** render_stat_tiles — a row of headline numbers. */
export const statTilesCard: UiCardDefinition<StatTilesSpec> = {
  ack: "(stat tiles rendered inline — do not repeat the numbers as text)",
  description:
    "Render a row of headline stat tiles inline in the chat (max 6): a label, a big value, and an optional delta with direction. Use for the 2-4 numbers that ARE the answer — total attributed revenue, pipeline value, credits remaining — instead of burying them in prose.",
  inputSchema: {
    properties: {
      actions: ACTIONS_SCHEMA,
      tiles: {
        description: "The tiles (max 6)",
        items: {
          properties: {
            delta: {
              description: 'Optional change note, e.g. "+12% vs last month"',
              type: "string",
            },
            deltaDirection: { enum: ["up", "down", "flat"], type: "string" },
            label: { description: "What the number is", type: "string" },
            value: {
              description: 'The formatted headline value, e.g. "$42,300"',
              type: "string",
            },
          },
          required: ["label", "value"],
          type: "object",
        },
        type: "array",
      },
    },
    required: ["tiles"],
    type: "object",
  },
  name: "render_stat_tiles",
  parse: parseStatTilesSpec,
};

/** render_form — collect structured inputs, then run a bound tool on submit. */
export const formCard: UiCardDefinition<FormSpec> = {
  ack: "(form rendered inline — the member fills and submits it, which runs the bound tool with their values. Do NOT re-ask for these values in text; wait for the submission)",
  description:
    "Render an inline form when you need SEVERAL structured inputs from the member before running a tool (task details, scheduling constraints, outreach parameters) — one form beats asking field-by-field in prose. Bind submit to one of YOUR tools with any values you already know pre-filled in submit.input; on submit the member's field values are merged into submit.input under each field's name and the tool runs exactly like a clicked action button. Field names must therefore be the tool's actual input property names. Never use it for values you could look up yourself.",
  inputSchema: {
    properties: {
      description: {
        description: "Optional one-line helper text under the title",
        type: "string",
      },
      fields: {
        description:
          "The inputs to collect (max 8). Each field's name must be a real input property of the submit tool.",
        items: {
          properties: {
            label: { description: "Human label for the field", type: "string" },
            name: {
              description:
                'Tool-input property name the value submits under, e.g. "title"',
              type: "string",
            },
            options: {
              description: "Choices — required for select fields (max 12)",
              items: { type: "string" },
              type: "array",
            },
            placeholder: { type: "string" },
            required: { type: "boolean" },
            type: { enum: [...FORM_FIELD_TYPES], type: "string" },
            value: {
              description: 'Prefill value (checkbox: "true"/"false")',
              type: "string",
            },
          },
          required: ["name", "label", "type"],
          type: "object",
        },
        type: "array",
      },
      submit: {
        description:
          "The submit binding: label for the button, the tool to run, and any input values you already resolved (real ids, never placeholders)",
        properties: {
          input: {
            description:
              "Pre-resolved input values; field values are merged in on top under their field names",
            type: "object",
          },
          label: {
            description: 'Button label, e.g. "Create task"',
            type: "string",
          },
          tool: { description: "The tool name to invoke", type: "string" },
        },
        required: ["label", "tool", "input"],
        type: "object",
      },
      title: { description: "Short form title", type: "string" },
    },
    required: ["title", "fields", "submit"],
    type: "object",
  },
  name: "render_form",
  parse: parseFormSpec,
};

/** The built-in catalog, ready for createUiCards. */
export const BUILTIN_UI_CARDS = [
  chartCard,
  tableCard,
  statTilesCard,
  formCard,
] as const;
