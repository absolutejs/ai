/**
 * `@absolutejs/ai` UI cards — generative UI for agent chats.
 *
 * A UI card is a schema-only tool: the model calls it with a structured spec,
 * the loop feeds back a steering ack, and the HOST renders the validated spec
 * with real components. {@link createUiCards} builds the tool map + collector
 * for any card set; {@link BUILTIN_UI_CARDS} ships chart / table / stat-tile
 * cards with hard caps, and {@link renderChartSvg} is a dependency-free
 * default chart renderer (pure string — server or client, light/dark).
 */

export {
  createUiCards,
  type UiCardDefinition,
  type UiCardEvent,
  type UiCards,
} from "./uiCards";
export {
  BUILTIN_UI_CARDS,
  chartCard,
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  CHART_TYPES,
  parseChartSpec,
  parseStatTilesSpec,
  parseTableSpec,
  parseUiActions,
  STAT_TILES_MAX,
  statTilesCard,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  tableCard,
  UI_ACTIONS_MAX,
  type ChartSeries,
  type ChartSpec,
  type ChartType,
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
