import type { UiCardDefinition } from "./uiCards";

/**
 * Built-in UI card catalog: chart, table, stat tiles, form, choice, confirm,
 * diff, plan, and credential-request cards. Declarative specs the model
 * authors and the host renders — see svg.ts for the dependency-free default
 * chart renderer. Caps are hard product guards (a model can't render a
 * 400-row table into a chat bubble).
 *
 * Card identity: every spec carries an optional `cardId`. When a host
 * receives a card whose cardId it has already rendered in the conversation,
 * it MUST replace that earlier render in place instead of appending a new
 * card. This is a pure host rendering contract — no loop-side state — and it
 * is how planCard progresses: the model re-emits the same cardId with
 * updated step statuses. The field lives here, in the shared spec layer, so
 * every host implements the same semantics.
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
  /** Stable card identity — see the card-identity contract in module docs. */
  cardId?: string;
};

export type TableSpec = {
  title?: string;
  columns: string[];
  rows: string[][];
  /** Optional action buttons rendered under the card (≤ 3). */
  actions?: UiAction[];
  /** Stable card identity — see the card-identity contract in module docs. */
  cardId?: string;
};

export type StatTile = {
  label: string;
  value: string;
  /** Optional change annotation, e.g. "+12% vs last month". */
  delta?: string;
  deltaDirection?: "up" | "down" | "flat";
};

export type StatTilesSpec = {
  tiles: StatTile[];
  actions?: UiAction[];
  /** Stable card identity — see the card-identity contract in module docs. */
  cardId?: string;
};

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
  "password",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export type FormField = {
  /** Key the value is submitted under — a valid tool-input property name. */
  name: string;
  label: string;
  /**
   * "password" marks a sensitive field: hosts MUST render it masked (an
   * `<input type="password">`-equivalent) and SHOULD route the submitted
   * value outside the model loop entirely (e.g. straight to the host's own
   * secret store) so it never enters the transcript. Password fields never
   * carry a prefill `value` — parseFormSpec drops it.
   */
  type: FormFieldType;
  placeholder?: string;
  required?: boolean;
  /** Choices — select fields only. */
  options?: string[];
  /** Prefill (checkbox: "true"/"false"; never present on password fields). */
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
  /** Stable card identity — see the card-identity contract in module docs. */
  cardId?: string;
};

export type ChoiceOption = {
  /** Stable option id — merged into submit.input on selection. */
  id: string;
  label: string;
  description?: string;
  /** Tiny annotation rendered beside the label, e.g. "recommended". */
  badge?: string;
};

/**
 * A structured decision card: the member picks one option (or several when
 * `multi`) and the host merges `{ choice: id }` — or `{ choices: id[] }` —
 * into `submit.input`, then invokes `submit.tool` exactly like a clicked
 * UiAction. Same through-loop flow as FormSpec: a choice between
 * model-authored options is non-secret by definition, so loop-visible
 * submission is correct here.
 */
export type ChoiceSpec = {
  title: string;
  description?: string;
  /** ≤ 8 options. */
  options: ChoiceOption[];
  /** Allow selecting several options (`{ choices: id[] }` on submit). */
  multi?: boolean;
  submit: UiAction;
  /** Stable card identity — see the card-identity contract in module docs. */
  cardId?: string;
};

/**
 * An explicit-consent card for destructive or irreversible actions.
 *
 * TRUST CONTRACT: the host must invoke `confirm` ONLY on a real user click
 * of the confirm button — never programmatically, and never because the
 * model claims consent was given. Hosts SHOULD mint an unforgeable
 * server-side confirmation token at click time and require it on the
 * downstream action, so a model can never fabricate a confirmation: the
 * token exists only if the click happened.
 */
export type ConfirmSpec = {
  title: string;
  /** What will happen, in plain language (≤ 500 chars). */
  consequence: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirm: UiAction;
  /** Render destructive styling (e.g. a red confirm button). */
  danger?: boolean;
  /** Stable card identity — see the card-identity contract in module docs. */
  cardId?: string;
};

export type DiffFile = {
  path: string;
  /** Unified diff text — DISPLAY data only (the host renders the +/-
   *  coloring); nothing is ever executed or applied from the text itself. */
  diff: string;
  /** The shown diff was cut to fit the display caps. */
  truncated?: boolean;
};

/**
 * Proposed file changes for review. Diffs are display data; the actual
 * change happens through `apply` — a normal UiAction against a host tool
 * with fully-resolved input. Applying files is destructive, so hosts SHOULD
 * route `apply` through a click-minted server-side token exactly like
 * ConfirmSpec. Oversized diffs are truncated by the parser, never rejected:
 * files beyond 6 drop, and diff bodies are cut to a 400-line total budget
 * with `truncated: true` set on every file that was cut.
 */
export type DiffSpec = {
  title: string;
  /** ≤ 6 files, ≤ 400 diff lines total across them. */
  files: DiffFile[];
  apply: UiAction;
  reject?: UiAction;
  note?: string;
  /** Stable card identity — see the card-identity contract in module docs. */
  cardId?: string;
};

export const PLAN_STEP_STATUSES = [
  "pending",
  "active",
  "done",
  "error",
] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export type PlanStep = {
  /** Stable step id — keep it identical across re-emits of the same plan. */
  id: string;
  label: string;
  status: PlanStepStatus;
  /** One-line progress or error note under the label. */
  detail?: string;
};

/**
 * A live multi-step plan. Display-only — no submit action. Progress works
 * through the card-identity contract: the model re-emits the SAME cardId
 * with updated step statuses and the host replaces the earlier render in
 * place, so the member sees one live plan instead of a stack of copies.
 */
export type PlanSpec = {
  title: string;
  /** ≤ 12 steps. */
  steps: PlanStep[];
  note?: string;
  /** Stable card identity — see the card-identity contract in module docs. */
  cardId?: string;
};

export type CredentialKey = {
  /** Environment variable name, e.g. "STRIPE_SECRET_KEY". */
  key: string;
  /** Human label, e.g. "Stripe secret key". */
  label?: string;
  /** Where to obtain the credential (provider dashboard URL). */
  docsUrl?: string;
  /** Mask and never echo. Defaults to TRUE — parseCredentialSpec normalizes
   *  it to an explicit boolean so hosts never have to guess. */
  secret?: boolean;
  /** Already configured on the host — render as set, offer replace. */
  isSet?: boolean;
};

/**
 * A credential-request card. Deliberately has NO submit UiAction — the type
 * makes through-loop submission impossible. The host UI collects the values
 * and stores them OUTSIDE the model loop (its own .env or secret store),
 * then sends a names-only continuation message ("STRIPE_SECRET_KEY was
 * set") so the model can proceed. Values never enter the transcript in
 * either direction: parseCredentialSpec drops any value-like field a model
 * attaches (the password-prefill-drop precedent), and hosts never echo
 * stored values back.
 */
export type CredentialSpec = {
  title: string;
  /** ≤ 8 keys. */
  keys: CredentialKey[];
  /** Stable card identity — see the card-identity contract in module docs. */
  cardId?: string;
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
export const CHOICE_MAX_OPTIONS = 8;
export const CONFIRM_CONSEQUENCE_MAX_CHARS = 500;
export const DIFF_MAX_FILES = 6;
export const DIFF_MAX_LINES = 400;
export const PLAN_MAX_STEPS = 12;
export const CREDENTIAL_MAX_KEYS = 8;
export const CARD_ID_MAX_CHARS = 64;
const LABEL_MAX_CHARS = 80;
const TITLE_MAX_CHARS = 120;
const CELL_MAX_CHARS = 160;
const UNIT_MAX_CHARS = 8;
const ACTION_LABEL_MAX_CHARS = 40;
const DESCRIPTION_MAX_CHARS = 280;
const BADGE_MAX_CHARS = 24;
const DIFF_PATH_MAX_CHARS = 260;
const DIFF_LINE_MAX_CHARS = 300;
const DOCS_URL_MAX_CHARS = 300;
// Tool names are host identifiers, not prose.
const ACTION_TOOL_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
// Field names become tool-input property keys.
const FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;
// Card / option / step ids: opaque identity tokens, not prose.
const CARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Credential keys are environment variable names.
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DOCS_URL_PATTERN = /^https?:\/\//;

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

/** Trim, cap at 64 chars, then require the id charset; null when invalid. */
const cleanId = (value: unknown) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, CARD_ID_MAX_CHARS);

  return CARD_ID_PATTERN.test(trimmed) ? trimmed : null;
};

/** Attach a validated cardId to a spec; invalid ids drop silently — identity
 *  is an enhancement, never a reason to sink a card. */
const applyCardId = (spec: { cardId?: string }, raw: unknown) => {
  const cardId = cleanId(raw);
  if (cardId) spec.cardId = cardId;
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

const CARD_ID_SCHEMA = {
  description:
    "Optional stable card identity (letters/digits/_/-, max 64 chars). Re-emit a card with the SAME cardId to update the earlier render in place instead of adding a new card.",
  type: "string",
};

// Reusable single-action binding schema (choice submit, confirm, diff apply).
const ACTION_BINDING_SCHEMA = {
  properties: {
    input: {
      description:
        "The exact tool input to send (real ids you looked up, never placeholders)",
      type: "object",
    },
    label: { description: "Button label", type: "string" },
    tool: { description: "The tool name to invoke", type: "string" },
  },
  required: ["label", "tool", "input"],
  type: "object",
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
  applyCardId(spec, input.cardId);

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
  applyCardId(spec, input.cardId);

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
  applyCardId(spec, input.cardId);

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
  // A password prefill would put a secret in the model transcript — drop it.
  const value =
    type === "password" ? null : cleanString(raw.value, CELL_MAX_CHARS);
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
  applyCardId(spec, input.cardId);

  return spec;
};

const parseChoiceOption = (raw: unknown): ChoiceOption | null => {
  if (!isRecord(raw)) return null;
  const id = cleanId(raw.id);
  const label = cleanString(raw.label, LABEL_MAX_CHARS);
  if (!id || !label) return null;

  const option: ChoiceOption = { id, label };
  const description = cleanString(raw.description, DESCRIPTION_MAX_CHARS);
  if (description) option.description = description;
  const badge = cleanString(raw.badge, BADGE_MAX_CHARS);
  if (badge) option.badge = badge;

  return option;
};

export const parseChoiceSpec = (input: unknown): ChoiceSpec | null => {
  if (!isRecord(input)) return null;
  const title = cleanString(input.title, TITLE_MAX_CHARS);
  const [submit] = parseUiActions([input.submit]) ?? [];
  if (!title || !submit) return null;
  if (!Array.isArray(input.options) || input.options.length === 0) return null;
  const options: ChoiceOption[] = [];
  const seen = new Set<string>();
  for (const raw of input.options.slice(0, CHOICE_MAX_OPTIONS)) {
    const option = parseChoiceOption(raw);
    // One malformed or duplicate option sinks the card — a partial option
    // set misrepresents the decision.
    if (!option || seen.has(option.id)) return null;
    seen.add(option.id);
    options.push(option);
  }

  const spec: ChoiceSpec = { options, submit, title };
  const description = cleanString(input.description, DESCRIPTION_MAX_CHARS);
  if (description) spec.description = description;
  if (input.multi === true) spec.multi = true;
  applyCardId(spec, input.cardId);

  return spec;
};

export const parseConfirmSpec = (input: unknown): ConfirmSpec | null => {
  if (!isRecord(input)) return null;
  const title = cleanString(input.title, TITLE_MAX_CHARS);
  const consequence = cleanString(
    input.consequence,
    CONFIRM_CONSEQUENCE_MAX_CHARS,
  );
  const confirmLabel = cleanString(input.confirmLabel, ACTION_LABEL_MAX_CHARS);
  const [confirm] = parseUiActions([input.confirm]) ?? [];
  if (!title || !consequence || !confirmLabel || !confirm) return null;

  const spec: ConfirmSpec = { confirm, confirmLabel, consequence, title };
  const cancelLabel = cleanString(input.cancelLabel, ACTION_LABEL_MAX_CHARS);
  if (cancelLabel) spec.cancelLabel = cancelLabel;
  if (input.danger === true) spec.danger = true;
  applyCardId(spec, input.cardId);

  return spec;
};

/** Shared line budget across a diff card's files — mutated as files parse. */
type DiffBudget = { remaining: number };

const parseDiffFile = (raw: unknown, budget: DiffBudget): DiffFile | null => {
  if (!isRecord(raw)) return null;
  const path = cleanString(raw.path, DIFF_PATH_MAX_CHARS);
  if (!path || typeof raw.diff !== "string" || raw.diff.trim().length === 0) {
    return null;
  }
  const lines = raw.diff
    .split(/\r?\n/)
    .map((line) => line.slice(0, DIFF_LINE_MAX_CHARS));
  const kept = lines.slice(0, Math.max(budget.remaining, 0));
  budget.remaining -= kept.length;

  const file: DiffFile = { diff: kept.join("\n"), path };
  // Size never rejects: over-budget diffs are cut and flagged instead.
  if (raw.truncated === true || kept.length < lines.length) {
    file.truncated = true;
  }

  return file;
};

export const parseDiffSpec = (input: unknown): DiffSpec | null => {
  if (!isRecord(input)) return null;
  const title = cleanString(input.title, TITLE_MAX_CHARS);
  const [apply] = parseUiActions([input.apply]) ?? [];
  if (!title || !apply) return null;
  if (!Array.isArray(input.files) || input.files.length === 0) return null;
  const budget: DiffBudget = { remaining: DIFF_MAX_LINES };
  const files: DiffFile[] = [];
  for (const raw of input.files.slice(0, DIFF_MAX_FILES)) {
    const file = parseDiffFile(raw, budget);
    // A malformed file sinks the card — the member would otherwise review
    // (and apply) a change set they can't actually see in full.
    if (!file) return null;
    files.push(file);
  }

  const spec: DiffSpec = { apply, files, title };
  const [reject] = parseUiActions([input.reject]) ?? [];
  if (reject) spec.reject = reject;
  const note = cleanString(input.note, DESCRIPTION_MAX_CHARS);
  if (note) spec.note = note;
  applyCardId(spec, input.cardId);

  return spec;
};

const parsePlanStep = (raw: unknown): PlanStep | null => {
  if (!isRecord(raw)) return null;
  const id = cleanId(raw.id);
  const label = cleanString(raw.label, LABEL_MAX_CHARS);
  const status = PLAN_STEP_STATUSES.find((entry) => entry === raw.status);
  if (!id || !label || !status) return null;

  const step: PlanStep = { id, label, status };
  const detail = cleanString(raw.detail, CELL_MAX_CHARS);
  if (detail) step.detail = detail;

  return step;
};

export const parsePlanSpec = (input: unknown): PlanSpec | null => {
  if (!isRecord(input)) return null;
  const title = cleanString(input.title, TITLE_MAX_CHARS);
  if (!title) return null;
  if (!Array.isArray(input.steps) || input.steps.length === 0) return null;
  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  for (const raw of input.steps.slice(0, PLAN_MAX_STEPS)) {
    const step = parsePlanStep(raw);
    // Malformed or duplicate step ids sink the card — stable ids are what
    // lets an in-place update line up with the previous render.
    if (!step || seen.has(step.id)) return null;
    seen.add(step.id);
    steps.push(step);
  }

  const spec: PlanSpec = { steps, title };
  const note = cleanString(input.note, DESCRIPTION_MAX_CHARS);
  if (note) spec.note = note;
  applyCardId(spec, input.cardId);

  return spec;
};

const parseCredentialKey = (raw: unknown): CredentialKey | null => {
  if (!isRecord(raw)) return null;
  const key =
    typeof raw.key === "string" && ENV_KEY_PATTERN.test(raw.key)
      ? raw.key
      : null;
  if (!key) return null;

  // Only the known display fields survive: any value-like field a model
  // attaches (value, prefill, default…) is dropped here, mirroring the
  // password-prefill drop in parseFormField. Values NEVER ride this card.
  // secret defaults to TRUE — it is normalized explicit so hosts never guess.
  const entry: CredentialKey = { key, secret: raw.secret !== false };
  const label = cleanString(raw.label, LABEL_MAX_CHARS);
  if (label) entry.label = label;
  const docsUrl = cleanString(raw.docsUrl, DOCS_URL_MAX_CHARS);
  if (docsUrl && DOCS_URL_PATTERN.test(docsUrl)) entry.docsUrl = docsUrl;
  if (typeof raw.isSet === "boolean") entry.isSet = raw.isSet;

  return entry;
};

export const parseCredentialSpec = (input: unknown): CredentialSpec | null => {
  if (!isRecord(input)) return null;
  const title = cleanString(input.title, TITLE_MAX_CHARS);
  if (!title) return null;
  if (!Array.isArray(input.keys) || input.keys.length === 0) return null;
  const keys: CredentialKey[] = [];
  const seen = new Set<string>();
  for (const raw of input.keys.slice(0, CREDENTIAL_MAX_KEYS)) {
    const entry = parseCredentialKey(raw);
    // A malformed or duplicate key sinks the card — a partial credential
    // request would leave setup silently incomplete.
    if (!entry || seen.has(entry.key)) return null;
    seen.add(entry.key);
    keys.push(entry);
  }

  const spec: CredentialSpec = { keys, title };
  applyCardId(spec, input.cardId);

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
      cardId: CARD_ID_SCHEMA,
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
      cardId: CARD_ID_SCHEMA,
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
      cardId: CARD_ID_SCHEMA,
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
    "Render an inline form when you need SEVERAL structured inputs from the member before running a tool (task details, scheduling constraints, outreach parameters) — one form beats asking field-by-field in prose. Bind submit to one of YOUR tools with any values you already know pre-filled in submit.input; on submit the member's field values are merged into submit.input under each field's name and the tool runs exactly like a clicked action button. Field names must therefore be the tool's actual input property names. Never use it for values you could look up yourself. Use type \"password\" for sensitive values (API keys, secrets, credentials) — the host renders it masked and never pre-fill a value for it.",
  inputSchema: {
    properties: {
      cardId: CARD_ID_SCHEMA,
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

/** render_choice — a structured decision instead of "reply 1 or 2". */
export const choiceCard: UiCardDefinition<ChoiceSpec> = {
  ack: "(choice card rendered inline — the member picks an option, which runs the bound tool with their selection merged in. Do not re-ask in text; wait for the selection)",
  description:
    "Render a structured choice card whenever the member must pick between concrete options (which plan, which duplicate record to keep, which time slot) — never ask them to 'reply 1 or 2' in prose. Give every option a stable id; on selection the host merges { choice: id } (or { choices: [ids] } when multi is true) into submit.input and invokes submit.tool exactly like a clicked action button, so put everything you already resolved into submit.input. Max 8 options.",
  inputSchema: {
    properties: {
      cardId: CARD_ID_SCHEMA,
      description: {
        description: "Optional one-line helper text under the title",
        type: "string",
      },
      multi: {
        description:
          "Allow selecting several options — submits { choices: [ids] } instead of { choice: id }",
        type: "boolean",
      },
      options: {
        description: "The options to choose between (max 8)",
        items: {
          properties: {
            badge: {
              description:
                'Tiny annotation beside the label, e.g. "recommended"',
              type: "string",
            },
            description: {
              description: "One-line explanation of the option",
              type: "string",
            },
            id: {
              description:
                "Stable option id merged into submit.input on selection (letters/digits/_/-)",
              type: "string",
            },
            label: { description: "What the member sees", type: "string" },
          },
          required: ["id", "label"],
          type: "object",
        },
        type: "array",
      },
      submit: {
        ...ACTION_BINDING_SCHEMA,
        description:
          "The submit binding: the tool to run once a choice is made. The selection is merged into input as { choice: id } (or { choices: [ids] })",
      },
      title: { description: "The decision being made", type: "string" },
    },
    required: ["title", "options", "submit"],
    type: "object",
  },
  name: "render_choice",
  parse: parseChoiceSpec,
};

/** render_confirm — explicit consent for destructive/irreversible actions. */
export const confirmCard: UiCardDefinition<ConfirmSpec> = {
  ack: "(confirmation card rendered inline — NOTHING has run yet; the action only runs if the member clicks confirm. Do not claim or assume it happened; wait for the outcome)",
  description:
    "Render an explicit confirmation card before any destructive or irreversible action (deleting data, sending money or bulk email, cancelling a subscription). State the consequence in plain language — exactly what will happen. TRUST CONTRACT: the host invokes confirm ONLY on a real member click, never on your say-so; hosts SHOULD mint an unforgeable server-side confirmation token at click time and require it on the downstream action, so a confirmation can never be fabricated in text. Set danger: true for destructive styling. Rendering this card is never itself consent.",
  inputSchema: {
    properties: {
      cancelLabel: {
        description: 'Optional dismiss label, e.g. "Keep project"',
        type: "string",
      },
      cardId: CARD_ID_SCHEMA,
      confirm: {
        ...ACTION_BINDING_SCHEMA,
        description:
          "The action to run ONLY when the member clicks confirm (fully-resolved input, real ids)",
      },
      confirmLabel: {
        description: 'The confirm button label, e.g. "Delete project"',
        type: "string",
      },
      consequence: {
        description:
          "What will happen if confirmed, in plain language (max 500 chars)",
        type: "string",
      },
      danger: {
        description: "Render destructive (red) styling",
        type: "boolean",
      },
      title: { description: "Short question being confirmed", type: "string" },
    },
    required: ["title", "consequence", "confirmLabel", "confirm"],
    type: "object",
  },
  name: "render_confirm",
  parse: parseConfirmSpec,
};

/** render_diff — proposed file changes for review before applying. */
export const diffCard: UiCardDefinition<DiffSpec> = {
  ack: "(diff card rendered inline — the member reviews the changes and clicks apply or reject. Do not restate the diff in text and do not assume it was applied; wait for their decision)",
  description:
    "Render proposed file changes as reviewable unified diffs before applying them (max 6 files and 400 diff lines total — oversized diffs are truncated for display with truncated: true, never rejected). The diffs are DISPLAY data: the host renders the +/- coloring and nothing executes from the text. Bind apply (and optionally reject) to YOUR tools with fully-resolved input; hosts SHOULD route apply through a click-minted server-side token exactly like a confirmation card, because applying changes is destructive.",
  inputSchema: {
    properties: {
      apply: {
        ...ACTION_BINDING_SCHEMA,
        description:
          "The action that applies the changes when the member clicks it",
      },
      cardId: CARD_ID_SCHEMA,
      files: {
        description: "The changed files (max 6, 400 diff lines total)",
        items: {
          properties: {
            diff: {
              description: "Unified diff text for this file (display only)",
              type: "string",
            },
            path: { description: "File path being changed", type: "string" },
            truncated: {
              description: "Set true if you already cut the diff for size",
              type: "boolean",
            },
          },
          required: ["path", "diff"],
          type: "object",
        },
        type: "array",
      },
      note: {
        description: "Optional one-line note under the diffs",
        type: "string",
      },
      reject: {
        ...ACTION_BINDING_SCHEMA,
        description: "Optional action to run when the member rejects",
      },
      title: { description: "What the change set does", type: "string" },
    },
    required: ["title", "files", "apply"],
    type: "object",
  },
  name: "render_diff",
  parse: parseDiffSpec,
};

/** render_plan — a live multi-step plan, updated in place via cardId. */
export const planCard: UiCardDefinition<PlanSpec> = {
  ack: "(plan rendered inline — as you work, re-emit render_plan with the SAME cardId and updated step statuses instead of narrating progress; do not restate the steps as text)",
  description:
    "Render a live multi-step plan card (max 12 steps) when you start multi-step work. Display-only — it has no buttons. Set a cardId and give every step a stable id, then as you progress RE-EMIT this card with the SAME cardId and updated step statuses (pending / active / done / error): the host replaces the earlier render in place, so the member sees one live plan instead of a stack of copies.",
  inputSchema: {
    properties: {
      cardId: CARD_ID_SCHEMA,
      note: {
        description: "Optional one-line note under the steps",
        type: "string",
      },
      steps: {
        description: "The plan steps in order (max 12)",
        items: {
          properties: {
            detail: {
              description: "One-line progress or error note under the label",
              type: "string",
            },
            id: {
              description:
                "Stable step id — keep it identical across re-emits (letters/digits/_/-)",
              type: "string",
            },
            label: { description: "What this step does", type: "string" },
            status: { enum: [...PLAN_STEP_STATUSES], type: "string" },
          },
          required: ["id", "label", "status"],
          type: "object",
        },
        type: "array",
      },
      title: { description: "What the plan accomplishes", type: "string" },
    },
    required: ["title", "steps"],
    type: "object",
  },
  name: "render_plan",
  parse: parsePlanSpec,
};

/** request_credentials — ask for env values WITHOUT a through-loop submit. */
export const credentialCard: UiCardDefinition<CredentialSpec> = {
  ack: "(credential request rendered inline — the member enters the values in the host UI and they are stored outside this conversation; you will receive a message naming which keys were set, never the values. Do not ask for the values in text)",
  description:
    "Render a credential-request card when setup needs environment values from the member (API keys, secrets, connection strings) — max 8 keys, each an ENV_STYLE name with an optional label and docs link. This card deliberately has NO submit binding and collects NOTHING through you: the host UI gathers the values and stores them outside the model loop (its own .env or secret store), then sends a continuation message naming WHICH keys were set — never the values. Never ask for secret values in plain text, and never attach values to this card (any value-like field is dropped).",
  inputSchema: {
    properties: {
      cardId: CARD_ID_SCHEMA,
      keys: {
        description: "The environment keys to request (max 8)",
        items: {
          properties: {
            docsUrl: {
              description:
                "Where to obtain the credential (provider dashboard URL)",
              type: "string",
            },
            isSet: {
              description:
                "Already configured on the host — rendered as set, with a replace affordance",
              type: "boolean",
            },
            key: {
              description:
                'Environment variable name, e.g. "STRIPE_SECRET_KEY"',
              type: "string",
            },
            label: {
              description: 'Human label, e.g. "Stripe secret key"',
              type: "string",
            },
            secret: {
              description:
                "Mask and never echo (default true — only set false for genuinely public values)",
              type: "boolean",
            },
          },
          required: ["key"],
          type: "object",
        },
        type: "array",
      },
      title: {
        description: 'What the credentials unlock, e.g. "Connect Stripe"',
        type: "string",
      },
    },
    required: ["title", "keys"],
    type: "object",
  },
  name: "request_credentials",
  parse: parseCredentialSpec,
};

/** The built-in catalog, ready for createUiCards. */
export const BUILTIN_UI_CARDS = [
  chartCard,
  tableCard,
  statTilesCard,
  formCard,
  choiceCard,
  confirmCard,
  diffCard,
  planCard,
  credentialCard,
] as const;
