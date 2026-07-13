import { describe, expect, test } from "bun:test";
import { createUiCards } from "../src/ai/ui/uiCards";
import {
  BUILTIN_UI_CARDS,
  CARD_ID_MAX_CHARS,
  chartCard,
  CHOICE_MAX_OPTIONS,
  CONFIRM_CONSEQUENCE_MAX_CHARS,
  CREDENTIAL_MAX_KEYS,
  DIFF_MAX_FILES,
  DIFF_MAX_LINES,
  FORM_MAX_FIELDS,
  parseChartSpec,
  parseChoiceSpec,
  parseConfirmSpec,
  parseCredentialSpec,
  parseDiffSpec,
  parseFormSpec,
  parsePlanSpec,
  parseStatTilesSpec,
  parseTableSpec,
  PLAN_MAX_STEPS,
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

describe("parseFormSpec", () => {
  const FORM_INPUT = {
    description: "I'll create the task once you confirm the details.",
    fields: [
      {
        label: "Task title",
        name: "title",
        required: true,
        type: "text",
        value: "Follow up with Brendan",
      },
      { label: "Due date", name: "dueDate", type: "date" },
      {
        label: "Priority",
        name: "priority",
        options: ["low", "medium", "high"],
        type: "select",
      },
    ],
    submit: {
      input: { matchId: "m1" },
      label: "Create task",
      tool: "create_task",
    },
    title: "New follow-up task",
  };

  test("parses a valid form with prefill, options, and submit binding", () => {
    const spec = parseFormSpec(FORM_INPUT);
    expect(spec).not.toBeNull();
    expect(spec?.fields).toHaveLength(3);
    expect(spec?.fields[0]?.value).toBe("Follow up with Brendan");
    expect(spec?.fields[2]?.options).toEqual(["low", "medium", "high"]);
    expect(spec?.submit.tool).toBe("create_task");
    expect(spec?.submit.input).toEqual({ matchId: "m1" });
  });

  test("rejects selects without options, duplicate names, bad field names", () => {
    expect(
      parseFormSpec({
        ...FORM_INPUT,
        fields: [{ label: "Priority", name: "priority", type: "select" }],
      }),
    ).toBeNull();
    expect(
      parseFormSpec({
        ...FORM_INPUT,
        fields: [
          { label: "A", name: "title", type: "text" },
          { label: "B", name: "title", type: "text" },
        ],
      }),
    ).toBeNull();
    expect(
      parseFormSpec({
        ...FORM_INPUT,
        fields: [{ label: "A", name: "Drop Tables!", type: "text" }],
      }),
    ).toBeNull();
  });

  test("parses password fields but drops any prefill value", () => {
    const spec = parseFormSpec({
      ...FORM_INPUT,
      fields: [
        {
          label: "API key",
          name: "apiKey",
          required: true,
          type: "password",
          value: "sk-should-never-prefill",
        },
      ],
    });
    expect(spec).not.toBeNull();
    expect(spec?.fields[0]?.type).toBe("password");
    expect(spec?.fields[0]?.value).toBeUndefined();
  });

  test("rejects a missing or malformed submit binding", () => {
    expect(parseFormSpec({ ...FORM_INPUT, submit: undefined })).toBeNull();
    expect(
      parseFormSpec({
        ...FORM_INPUT,
        submit: { input: {}, label: "Go", tool: "Not A Tool" },
      }),
    ).toBeNull();
  });

  test("caps fields at the maximum", () => {
    const spec = parseFormSpec({
      ...FORM_INPUT,
      fields: Array.from({ length: FORM_MAX_FIELDS + 4 }, (_, i) => ({
        label: `Field ${i}`,
        name: `field${i}`,
        type: "text",
      })),
    });
    expect(spec?.fields).toHaveLength(FORM_MAX_FIELDS);
  });
});

describe("parseChoiceSpec", () => {
  const CHOICE_INPUT = {
    options: [
      { badge: "recommended", id: "keep_newest", label: "Keep the newest" },
      {
        description: "Merges notes and activity into one record",
        id: "merge",
        label: "Merge both",
      },
    ],
    submit: {
      input: { recordId: "r1" },
      label: "Apply",
      tool: "resolve_duplicate",
    },
    title: "How should I resolve the duplicate?",
  };

  test("parses options, badges, multi, and the submit binding", () => {
    const spec = parseChoiceSpec(CHOICE_INPUT);
    expect(spec).not.toBeNull();
    expect(spec?.options).toHaveLength(2);
    expect(spec?.options[0]?.badge).toBe("recommended");
    expect(spec?.options[1]?.description).toContain("Merges notes");
    expect(spec?.submit.tool).toBe("resolve_duplicate");
    expect(spec?.multi).toBeUndefined();
    expect(parseChoiceSpec({ ...CHOICE_INPUT, multi: true })?.multi).toBe(true);
  });

  test("caps options and sinks duplicates or malformed entries", () => {
    const spec = parseChoiceSpec({
      ...CHOICE_INPUT,
      options: Array.from({ length: CHOICE_MAX_OPTIONS + 4 }, (_, i) => ({
        id: `option${i}`,
        label: `Option ${i}`,
      })),
    });
    expect(spec?.options).toHaveLength(CHOICE_MAX_OPTIONS);
    expect(
      parseChoiceSpec({
        ...CHOICE_INPUT,
        options: [
          { id: "same", label: "A" },
          { id: "same", label: "B" },
        ],
      }),
    ).toBeNull();
    expect(
      parseChoiceSpec({
        ...CHOICE_INPUT,
        options: [{ id: "not an id!", label: "A" }],
      }),
    ).toBeNull();
    expect(
      parseChoiceSpec({ ...CHOICE_INPUT, options: [{ id: "ok" }] }),
    ).toBeNull();
  });

  test("rejects a missing or malformed submit binding", () => {
    expect(parseChoiceSpec({ ...CHOICE_INPUT, submit: undefined })).toBeNull();
    expect(
      parseChoiceSpec({
        ...CHOICE_INPUT,
        submit: { input: {}, label: "Go", tool: "Not A Tool" },
      }),
    ).toBeNull();
  });
});

describe("parseConfirmSpec", () => {
  const CONFIRM_INPUT = {
    confirm: {
      input: { projectId: "p1" },
      label: "Delete",
      tool: "delete_project",
    },
    confirmLabel: "Delete project",
    consequence:
      "This permanently deletes the project and its 14 deployments. It cannot be undone.",
    danger: true,
    title: "Delete production project?",
  };

  test("parses the consent shape; danger only when exactly true", () => {
    const spec = parseConfirmSpec(CONFIRM_INPUT);
    expect(spec).not.toBeNull();
    expect(spec?.confirm.tool).toBe("delete_project");
    expect(spec?.danger).toBe(true);
    expect(
      parseConfirmSpec({ ...CONFIRM_INPUT, danger: "yes" })?.danger,
    ).toBeUndefined();
    const withCancel = parseConfirmSpec({
      ...CONFIRM_INPUT,
      cancelLabel: "Keep project",
    });
    expect(withCancel?.cancelLabel).toBe("Keep project");
  });

  test("caps consequence length", () => {
    const spec = parseConfirmSpec({
      ...CONFIRM_INPUT,
      consequence: "x".repeat(CONFIRM_CONSEQUENCE_MAX_CHARS + 200),
    });
    expect(spec?.consequence).toHaveLength(CONFIRM_CONSEQUENCE_MAX_CHARS);
  });

  test("rejects a missing consequence or confirm binding", () => {
    expect(
      parseConfirmSpec({ ...CONFIRM_INPUT, consequence: undefined }),
    ).toBeNull();
    expect(
      parseConfirmSpec({ ...CONFIRM_INPUT, confirm: undefined }),
    ).toBeNull();
  });
});

describe("parseDiffSpec", () => {
  const DIFF_INPUT = {
    apply: {
      input: { changeSetId: "cs1" },
      label: "Apply changes",
      tool: "apply_change_set",
    },
    files: [
      {
        diff: "--- a/src/index.ts\n+++ b/src/index.ts\n+export const answer = 42;",
        path: "src/index.ts",
      },
    ],
    title: "Add the answer constant",
  };

  test("parses files with apply and optional reject bindings", () => {
    const spec = parseDiffSpec({
      ...DIFF_INPUT,
      note: "Touches one file only.",
      reject: {
        input: { changeSetId: "cs1" },
        label: "Discard",
        tool: "discard_change_set",
      },
    });
    expect(spec).not.toBeNull();
    expect(spec?.files[0]?.path).toBe("src/index.ts");
    expect(spec?.files[0]?.truncated).toBeUndefined();
    expect(spec?.apply.tool).toBe("apply_change_set");
    expect(spec?.reject?.tool).toBe("discard_change_set");
    expect(spec?.note).toBe("Touches one file only.");
  });

  test("truncates oversized diffs instead of rejecting", () => {
    const bigDiff = Array.from(
      { length: DIFF_MAX_LINES + 50 },
      (_, i) => `+line ${i}`,
    ).join("\n");
    const spec = parseDiffSpec({
      ...DIFF_INPUT,
      files: [{ diff: bigDiff, path: "big.ts" }],
    });
    expect(spec).not.toBeNull();
    expect(spec?.files[0]?.diff.split("\n")).toHaveLength(DIFF_MAX_LINES);
    expect(spec?.files[0]?.truncated).toBe(true);

    // The budget is shared across files, in order.
    const first = Array.from({ length: DIFF_MAX_LINES - 10 }, () => "+x").join(
      "\n",
    );
    const second = Array.from({ length: 40 }, () => "+y").join("\n");
    const shared = parseDiffSpec({
      ...DIFF_INPUT,
      files: [
        { diff: first, path: "first.ts" },
        { diff: second, path: "second.ts" },
      ],
    });
    expect(shared?.files[0]?.truncated).toBeUndefined();
    expect(shared?.files[1]?.diff.split("\n")).toHaveLength(10);
    expect(shared?.files[1]?.truncated).toBe(true);
  });

  test("caps files at the maximum", () => {
    const spec = parseDiffSpec({
      ...DIFF_INPUT,
      files: Array.from({ length: DIFF_MAX_FILES + 3 }, (_, i) => ({
        diff: `+file ${i}`,
        path: `file${i}.ts`,
      })),
    });
    expect(spec?.files).toHaveLength(DIFF_MAX_FILES);
  });

  test("rejects malformed files and a missing apply binding", () => {
    expect(
      parseDiffSpec({ ...DIFF_INPUT, files: [{ diff: "+x" }] }),
    ).toBeNull();
    expect(
      parseDiffSpec({ ...DIFF_INPUT, files: [{ diff: "", path: "a.ts" }] }),
    ).toBeNull();
    expect(parseDiffSpec({ ...DIFF_INPUT, apply: undefined })).toBeNull();
  });
});

describe("parsePlanSpec", () => {
  const PLAN_INPUT = {
    steps: [
      { id: "fetch", label: "Fetch the data", status: "done" },
      {
        detail: "22 of 40 rows processed",
        id: "analyze",
        label: "Analyze rows",
        status: "active",
      },
      { id: "report", label: "Write the report", status: "pending" },
    ],
    title: "Analysis plan",
  };

  test("parses statuses and details", () => {
    const spec = parsePlanSpec(PLAN_INPUT);
    expect(spec).not.toBeNull();
    expect(spec?.steps.map((step) => step.status)).toEqual([
      "done",
      "active",
      "pending",
    ]);
    expect(spec?.steps[1]?.detail).toBe("22 of 40 rows processed");
  });

  test("sinks unknown statuses and duplicate step ids", () => {
    expect(
      parsePlanSpec({
        ...PLAN_INPUT,
        steps: [{ id: "a", label: "A", status: "running" }],
      }),
    ).toBeNull();
    expect(
      parsePlanSpec({
        ...PLAN_INPUT,
        steps: [
          { id: "same", label: "A", status: "pending" },
          { id: "same", label: "B", status: "pending" },
        ],
      }),
    ).toBeNull();
  });

  test("caps steps at the maximum", () => {
    const spec = parsePlanSpec({
      ...PLAN_INPUT,
      steps: Array.from({ length: PLAN_MAX_STEPS + 5 }, (_, i) => ({
        id: `step${i}`,
        label: `Step ${i}`,
        status: "pending",
      })),
    });
    expect(spec?.steps).toHaveLength(PLAN_MAX_STEPS);
  });
});

describe("parseCredentialSpec", () => {
  const CREDENTIAL_INPUT = {
    keys: [
      {
        docsUrl: "https://dashboard.stripe.com/apikeys",
        key: "STRIPE_SECRET_KEY",
        label: "Stripe secret key",
      },
      { isSet: true, key: "STRIPE_WEBHOOK_SECRET" },
    ],
    title: "Connect Stripe",
  };

  test("parses keys and normalizes secret to an explicit default-true", () => {
    const spec = parseCredentialSpec(CREDENTIAL_INPUT);
    expect(spec).not.toBeNull();
    expect(spec?.keys[0]?.secret).toBe(true);
    expect(spec?.keys[0]?.docsUrl).toBe("https://dashboard.stripe.com/apikeys");
    expect(spec?.keys[1]?.isSet).toBe(true);
    const publicKey = parseCredentialSpec({
      ...CREDENTIAL_INPUT,
      keys: [{ key: "PUBLIC_BASE_URL", secret: false }],
    });
    expect(publicKey?.keys[0]?.secret).toBe(false);
  });

  test("drops any value-like field a model attaches", () => {
    const spec = parseCredentialSpec({
      ...CREDENTIAL_INPUT,
      keys: [
        {
          default: "sk-nope",
          key: "STRIPE_SECRET_KEY",
          prefill: "sk-nope",
          value: "sk-should-never-ride-this-card",
        },
      ],
    });
    expect(spec).not.toBeNull();
    expect(Object.keys(spec?.keys[0] ?? {}).sort()).toEqual(["key", "secret"]);
  });

  test("rejects non-ENV key names and duplicates; caps at the max", () => {
    expect(
      parseCredentialSpec({
        ...CREDENTIAL_INPUT,
        keys: [{ key: "not-an-env-name" }],
      }),
    ).toBeNull();
    expect(
      parseCredentialSpec({
        ...CREDENTIAL_INPUT,
        keys: [{ key: "SAME_KEY" }, { key: "SAME_KEY" }],
      }),
    ).toBeNull();
    const spec = parseCredentialSpec({
      ...CREDENTIAL_INPUT,
      keys: Array.from({ length: CREDENTIAL_MAX_KEYS + 4 }, (_, i) => ({
        key: `KEY_${i}`,
      })),
    });
    expect(spec?.keys).toHaveLength(CREDENTIAL_MAX_KEYS);
  });

  test("drops docsUrl values that are not http(s) URLs", () => {
    const spec = parseCredentialSpec({
      ...CREDENTIAL_INPUT,
      keys: [{ docsUrl: "javascript:alert(1)", key: "SOME_KEY" }],
    });
    expect(spec?.keys[0]?.docsUrl).toBeUndefined();
  });
});

describe("cardId", () => {
  test("accepts valid ids on any card, caps length, drops invalid", () => {
    const chart = parseChartSpec({ ...CHART_INPUT, cardId: "kpis-1" });
    expect(chart?.cardId).toBe("kpis-1");
    const sliced = parseChartSpec({
      ...CHART_INPUT,
      cardId: "a".repeat(CARD_ID_MAX_CHARS + 6),
    });
    expect(sliced?.cardId).toHaveLength(CARD_ID_MAX_CHARS);
    const invalid = parseChartSpec({
      ...CHART_INPUT,
      cardId: "not a card id!",
    });
    expect(invalid).not.toBeNull();
    expect(invalid?.cardId).toBeUndefined();
  });

  test("survives a planCard re-emit (the in-place update flow)", () => {
    const first = parsePlanSpec({
      cardId: "plan-1",
      steps: [{ id: "fetch", label: "Fetch", status: "active" }],
      title: "Plan",
    });
    const second = parsePlanSpec({
      cardId: "plan-1",
      steps: [{ id: "fetch", label: "Fetch", status: "done" }],
      title: "Plan",
    });
    expect(first?.cardId).toBe("plan-1");
    expect(second?.cardId).toBe("plan-1");
    expect(second?.steps[0]?.status).toBe("done");
  });
});

describe("createUiCards", () => {
  test("builds ack tools and collects only valid card calls in order", async () => {
    const cards = createUiCards(BUILTIN_UI_CARDS);
    expect(cards.has("render_chart")).toBe(true);
    expect(cards.has("render_choice")).toBe(true);
    expect(cards.has("render_confirm")).toBe(true);
    expect(cards.has("render_diff")).toBe(true);
    expect(cards.has("render_plan")).toBe(true);
    expect(cards.has("request_credentials")).toBe(true);
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
      {
        input: { keys: [{ key: "STRIPE_SECRET_KEY" }], title: "Connect" },
        name: "request_credentials",
      },
    ]);
    expect(events.map((event) => event.card)).toEqual([
      "render_chart",
      "render_stat_tiles",
      "request_credentials",
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
