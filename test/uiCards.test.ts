import { describe, expect, test } from "bun:test";
import { createUiCards } from "../src/ai/ui/uiCards";
import {
  BUILTIN_UI_CARDS,
  chartCard,
  parseChartSpec,
  parseStatTilesSpec,
  parseTableSpec,
  TABLE_MAX_ROWS,
} from "../src/ai/ui/catalog";
import { renderChartSvg } from "../src/ai/ui/svg";

const CHART_INPUT = {
  labels: ["RevPartners", "SmartBug", "Lawyered"],
  series: [{ name: "Attributed revenue", values: [42000, 18500, 9100] }],
  title: "Revenue by partner",
  type: "bar",
  unitPrefix: "$",
};

describe("ui card parsers", () => {
  test("parses a valid chart spec", () => {
    const spec = parseChartSpec(CHART_INPUT);
    expect(spec).not.toBeNull();
    expect(spec?.type).toBe("bar");
    expect(spec?.series[0]?.values).toEqual([42000, 18500, 9100]);
    expect(spec?.unitPrefix).toBe("$");
  });

  test("rejects misaligned series, bad numbers, unknown types", () => {
    expect(
      parseChartSpec({
        ...CHART_INPUT,
        series: [{ name: "x", values: [1, 2] }],
      }),
    ).toBeNull();
    expect(
      parseChartSpec({
        ...CHART_INPUT,
        series: [{ name: "x", values: [1, 2, Number.NaN] }],
      }),
    ).toBeNull();
    expect(parseChartSpec({ ...CHART_INPUT, type: "scatter" })).toBeNull();
  });

  test("donut requires exactly one non-negative series", () => {
    const donut = {
      labels: ["Won", "Open"],
      series: [{ name: "Deals", values: [3, 5] }],
      title: "Pipeline",
      type: "donut",
    };
    expect(parseChartSpec(donut)).not.toBeNull();
    expect(
      parseChartSpec({
        ...donut,
        series: [{ name: "Deals", values: [3, -5] }],
      }),
    ).toBeNull();
    expect(
      parseChartSpec({
        ...donut,
        series: [
          { name: "a", values: [1, 2] },
          { name: "b", values: [3, 4] },
        ],
      }),
    ).toBeNull();
  });

  test("table caps rows and normalizes ragged cells", () => {
    const spec = parseTableSpec({
      columns: ["Partner", "Stage"],
      rows: [
        ...Array.from({ length: TABLE_MAX_ROWS + 10 }, (_, i) => [`p${i}`]),
      ],
    });
    expect(spec).not.toBeNull();
    expect(spec?.rows).toHaveLength(TABLE_MAX_ROWS);
    expect(spec?.rows[0]).toEqual(["p0", ""]);
  });

  test("stat tiles require label + value", () => {
    expect(
      parseStatTilesSpec({
        tiles: [
          {
            delta: "+12%",
            deltaDirection: "up",
            label: "Revenue",
            value: "$42k",
          },
        ],
      }),
    ).not.toBeNull();
    expect(parseStatTilesSpec({ tiles: [{ label: "Revenue" }] })).toBeNull();
  });
});

describe("createUiCards", () => {
  test("builds ack tools and collects only valid card calls in order", async () => {
    const cards = createUiCards(BUILTIN_UI_CARDS);
    expect(cards.has("render_chart")).toBe(true);
    expect(cards.has("list_matches")).toBe(false);
    const ack = await cards.tools.render_chart?.handler({});
    expect(ack).toBe(chartCard.ack);

    const events = cards.collect([
      { input: { q: "x" }, name: "list_matches" },
      { input: CHART_INPUT, name: "render_chart" },
      { input: { bogus: true }, name: "render_table" },
      {
        input: { tiles: [{ label: "Pipeline", value: "$120k" }] },
        name: "render_stat_tiles",
      },
    ]);
    expect(events.map((event) => event.card)).toEqual([
      "render_chart",
      "render_stat_tiles",
    ]);
  });
});

describe("renderChartSvg", () => {
  test("renders bar/line/donut with legend + tooltips and escapes injection", () => {
    const spec = parseChartSpec({
      ...CHART_INPUT,
      series: [
        { name: 'Q1 <script>"evil"</script>', values: [1, 2, 3] },
        { name: "Q2", values: [4, 5, 6] },
      ],
    });
    if (!spec) throw new Error("spec should parse");
    const svg = renderChartSvg(spec);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<title>");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    // Legend present for 2 series.
    expect(svg).toContain("Q2");

    const line = parseChartSpec({ ...CHART_INPUT, type: "line" });
    if (!line) throw new Error("line spec should parse");
    expect(renderChartSvg(line, { mode: "dark" })).toContain("polyline");

    const donut = parseChartSpec({
      labels: ["Won", "Open"],
      series: [{ name: "Deals", values: [3, 5] }],
      title: "Pipeline",
      type: "donut",
    });
    if (!donut) throw new Error("donut spec should parse");
    const donutSvg = renderChartSvg(donut);
    expect(donutSvg).toContain("A"); // arc paths
    expect(donutSvg).toContain("(38%)");
  });

  test("single-series bar has no legend and direct value labels", () => {
    const spec = parseChartSpec(CHART_INPUT);
    if (!spec) throw new Error("spec should parse");
    const svg = renderChartSvg(spec);
    // Direct labels on ≤8 single-series bars.
    expect(svg).toContain("$42k");
    // No legend swatch row for a single series (title carries identity).
    expect(svg).not.toContain('y="38" width="10"');
  });
});

describe("parseUiActions", () => {
  test("accepts valid bindings, drops malformed ones, caps at 3", () => {
    const chart = parseChartSpec({
      actions: [
        {
          input: { title: "Follow up" },
          label: "Create task",
          tool: "create_task",
        },
        { input: {}, label: "", tool: "create_task" },
        { input: {}, label: "Bad tool", tool: "Drop Tables!" },
        { input: "not-object", label: "Bad input", tool: "create_task" },
        { input: { a: 1 }, label: "B", tool: "b_tool" },
        { input: { c: 1 }, label: "C", tool: "c_tool" },
      ],
      labels: ["A"],
      series: [{ name: "S", values: [1] }],
      title: "T",
      type: "bar",
    });
    expect(chart?.actions?.map((a) => a.tool)).toEqual(["create_task"]);

    const tiles = parseStatTilesSpec({
      actions: [
        { input: { matchId: "m1" }, label: "Nudge", tool: "set_deal_priority" },
      ],
      tiles: [{ label: "Pipeline", value: "$1" }],
    });
    expect(tiles?.actions).toHaveLength(1);
  });

  test("omits actions entirely when none survive", () => {
    const table = parseTableSpec({
      actions: [{ label: "x" }],
      columns: ["A"],
      rows: [["1"]],
    });
    expect(table?.actions).toBeUndefined();
  });
});
