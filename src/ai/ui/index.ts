/**
 * `@absolutejs/ai` UI cards — generative UI for agent chats.
 *
 * A UI card is a schema-only tool: the model calls it with a structured spec,
 * the loop feeds back a steering ack, and the HOST renders the validated spec
 * with real components. {@link createUiCards} builds the tool map + collector
 * for any card set; {@link BUILTIN_UI_CARDS} ships chart / table / stat-tile /
 * form / choice / confirm / diff / plan / credential-request cards with hard
 * caps, and {@link renderChartSvg} is a dependency-free default chart renderer
 * (pure string — server or client, light/dark). Every spec carries an optional
 * `cardId`: re-emitting a card with the same cardId tells the host to replace
 * the earlier render in place (how planCard progresses).
 */

export {
  createUiCards,
  type UiCardDefinition,
  type UiCardEvent,
  type UiCards,
} from "./uiCards";
export {
  BUILTIN_UI_CARDS,
  CARD_ID_MAX_CHARS,
  chartCard,
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  CHART_TYPES,
  CHOICE_MAX_OPTIONS,
  choiceCard,
  CONFIRM_CONSEQUENCE_MAX_CHARS,
  confirmCard,
  CREDENTIAL_MAX_KEYS,
  credentialCard,
  DIFF_MAX_FILES,
  DIFF_MAX_LINES,
  diffCard,
  FORM_FIELD_TYPES,
  FORM_MAX_FIELDS,
  FORM_SELECT_MAX_OPTIONS,
  formCard,
  parseChartSpec,
  parseChoiceSpec,
  parseConfirmSpec,
  parseCredentialSpec,
  parseDiffSpec,
  parseFormSpec,
  parsePlanSpec,
  parseStatTilesSpec,
  parseTableSpec,
  parseUiActions,
  PLAN_MAX_STEPS,
  PLAN_STEP_STATUSES,
  planCard,
  STAT_TILES_MAX,
  statTilesCard,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  tableCard,
  UI_ACTIONS_MAX,
  type ChartSeries,
  type ChartSpec,
  type ChartType,
  type ChoiceOption,
  type ChoiceSpec,
  type ConfirmSpec,
  type CredentialKey,
  type CredentialSpec,
  type DiffFile,
  type DiffSpec,
  type FormField,
  type FormFieldType,
  type FormSpec,
  type PlanSpec,
  type PlanStep,
  type PlanStepStatus,
  type StatTile,
  type StatTilesSpec,
  type TableSpec,
  type UiAction,
} from "./catalog";
export {
  DARK_UI_THEME,
  LIGHT_UI_THEME,
  renderChartSvg,
  type RenderChartSvgOptions,
  type UiSvgTheme,
} from "./svg";
