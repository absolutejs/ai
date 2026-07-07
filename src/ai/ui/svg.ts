import type { ChartSpec } from "./catalog";

/**
 * Dependency-free default chart renderer: a validated ChartSpec in, a
 * self-contained SVG string out. Pure — no DOM — so it runs server-side or in
 * any framework component (call it client-side with the viewer's mode so dark
 * themes get the dark-stepped palette, not an automatic flip).
 *
 * Design method: thin marks with rounded data-ends, 2px surface gaps between
 * adjacent fills, recessive horizontal grid, a legend for ≥2 series plus
 * direct labels, all text in text tokens (never series colors), native <title>
 * hover tooltips per mark. The default palette is the validated reference set
 * (worst adjacent CVD ΔE 24.2 light / 10.3 dark) — override `palette` with
 * your brand's VALIDATED hues, in their fixed slot order.
 */

export type UiSvgTheme = {
  /** Categorical hues in fixed slot order (series 1..n). */
  palette: string[];
  surface: string;
  textPrimary: string;
  textSecondary: string;
  grid: string;
};

export const LIGHT_UI_THEME: UiSvgTheme = {
  grid: "#e4e4e0",
  palette: [
    "#2a78d6",
    "#1baf7a",
    "#eda100",
    "#008300",
    "#4a3aa7",
    "#e34948",
    "#e87ba4",
    "#eb6834",
  ],
  surface: "#fcfcfb",
  textPrimary: "#0b0b0b",
  textSecondary: "#52514e",
};

export const DARK_UI_THEME: UiSvgTheme = {
  grid: "#333331",
  palette: [
    "#3987e5",
    "#199e70",
    "#c98500",
    "#008300",
    "#9085e9",
    "#e66767",
    "#d55181",
    "#d95926",
  ],
  surface: "#1a1a19",
  textPrimary: "#ffffff",
  textSecondary: "#c3c2b7",
};

export type RenderChartSvgOptions = {
  mode?: "light" | "dark";
  /** Override any theme slot (e.g. your brand palette / chat-bubble surface). */
  theme?: Partial<UiSvgTheme>;
  width?: number;
  height?: number;
};

const WIDTH = 640;
const HEIGHT = 340;
const MARGIN = { bottom: 42, left: 56, right: 16, top: 64 };
const BAR_END_RADIUS = 4;
const MARK_GAP = 2;
const LINE_WIDTH = 2;
const MAX_DIRECT_LABELED_SERIES = 4;
const TICK_TARGET = 4;
const FONT =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const formatValue = (value: number, spec: ChartSpec) => {
  // Sign leads the unit ("-$4k", not "$-4000").
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const compact =
    abs >= 1_000_000
      ? `${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
      : abs >= 10_000
        ? `${(abs / 1_000).toFixed(1).replace(/\.0$/, "")}k`
        : abs >= 1_000
          ? abs.toLocaleString("en-US")
          : `${Number.isInteger(abs) ? abs : abs.toFixed(1)}`;

  return `${sign}${spec.unitPrefix ?? ""}${compact}${spec.unitSuffix ?? ""}`;
};

// "Nice" tick step: 1/2/5 × 10^n covering the domain in ~TICK_TARGET steps.
const niceTicks = (min: number, max: number) => {
  const span = max - min || 1;
  const rough = span / TICK_TARGET;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const candidates = [1, 2, 5, 10].map((step) => step * power);
  const step =
    candidates.find((candidate) => candidate >= rough) ??
    candidates[candidates.length - 1] ??
    rough;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let tick = start; tick <= max + step / 2; tick += step) {
    ticks.push(Math.abs(tick) < step / 1e6 ? 0 : tick);
  }

  return ticks;
};

type Frame = {
  theme: UiSvgTheme;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
};

const headerSvg = (spec: ChartSpec, frame: Frame) => {
  const { theme } = frame;
  const parts = [
    `<text x="${frame.plotLeft}" y="24" fill="${theme.textPrimary}" font-size="15" font-weight="600">${escapeXml(spec.title)}</text>`,
  ];
  // Legend only when identity needs it: 2+ series (a single series is named
  // by the title). Swatch + name in text ink, never colored text.
  if (spec.series.length > 1) {
    let x = frame.plotLeft;
    const swatches = spec.series.map((series, index) => {
      const color = theme.palette[index % theme.palette.length];
      const label = escapeXml(series.name);
      const item = `<rect x="${x}" y="38" width="10" height="10" rx="2" fill="${color}"/><text x="${x + 14}" y="47" fill="${theme.textSecondary}" font-size="11">${label}</text>`;
      x += 14 + series.name.length * 6 + 18;

      return item;
    });
    parts.push(...swatches);
  }

  return parts.join("");
};

const gridSvg = (
  ticks: number[],
  yFor: (value: number) => number,
  spec: ChartSpec,
  frame: Frame,
) =>
  ticks
    .map((tick) => {
      const y = yFor(tick);
      const isZero = tick === 0;

      return `<line x1="${frame.plotLeft}" y1="${y}" x2="${frame.plotRight}" y2="${y}" stroke="${isZero ? frame.theme.textSecondary : frame.theme.grid}" stroke-width="1"/><text x="${frame.plotLeft - 8}" y="${y + 3.5}" fill="${frame.theme.textSecondary}" font-size="10" text-anchor="end">${escapeXml(formatValue(tick, spec))}</text>`;
    })
    .join("");

const xLabelsSvg = (
  spec: ChartSpec,
  xCenter: (index: number) => number,
  frame: Frame,
) => {
  // Thin out crowded label axes instead of colliding.
  const every = Math.ceil(spec.labels.length / 12);

  return spec.labels
    .map((label, index) => {
      if (index % every !== 0) return "";
      const short = label.length > 12 ? `${label.slice(0, 11)}…` : label;

      return `<text x="${xCenter(index)}" y="${frame.plotBottom + 18}" fill="${frame.theme.textSecondary}" font-size="10" text-anchor="middle">${escapeXml(short)}</text>`;
    })
    .join("");
};

// Bar with a rounded TOP data-end anchored to the baseline (flipped when the
// value is negative). Radius collapses on very short bars.
const barPath = (
  x: number,
  yValue: number,
  yBase: number,
  width: number,
): string => {
  const up = yValue <= yBase;
  const top = Math.min(yValue, yBase);
  const bottom = Math.max(yValue, yBase);
  const radius = Math.min(BAR_END_RADIUS, width / 2, bottom - top);
  if (radius <= 0) return "";
  if (up) {
    return `M${x},${bottom} L${x},${top + radius} Q${x},${top} ${x + radius},${top} L${x + width - radius},${top} Q${x + width},${top} ${x + width},${top + radius} L${x + width},${bottom} Z`;
  }

  return `M${x},${top} L${x},${bottom - radius} Q${x},${bottom} ${x + radius},${bottom} L${x + width - radius},${bottom} Q${x + width},${bottom} ${x + width},${bottom - radius} L${x + width},${top} Z`;
};

const valueDomain = (spec: ChartSpec) => {
  const all = spec.series.flatMap((series) => series.values);
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);

  return max === min ? { max: min + 1, min } : { max, min };
};

const cartesianSvg = (spec: ChartSpec, frame: Frame) => {
  const { theme } = frame;
  const domain = valueDomain(spec);
  const ticks = niceTicks(domain.min, domain.max);
  const lo = Math.min(domain.min, ticks[0] ?? domain.min);
  const hi = Math.max(domain.max, ticks[ticks.length - 1] ?? domain.max);
  const yFor = (value: number) =>
    frame.plotBottom -
    ((value - lo) / (hi - lo)) * (frame.plotBottom - frame.plotTop);
  const slot = (frame.plotRight - frame.plotLeft) / spec.labels.length;
  const xCenter = (index: number) => frame.plotLeft + slot * (index + 0.5);

  const parts: string[] = [gridSvg(ticks, yFor, spec, frame)];

  if (spec.type === "bar") {
    const group = Math.min(slot * 0.72, 64);
    const barWidth = Math.max(
      2,
      (group - MARK_GAP * (spec.series.length - 1)) / spec.series.length,
    );
    const yBase = yFor(Math.max(lo, Math.min(hi, 0)));
    spec.series.forEach((series, seriesIndex) => {
      const color = theme.palette[seriesIndex % theme.palette.length];
      series.values.forEach((value, index) => {
        const x =
          xCenter(index) - group / 2 + seriesIndex * (barWidth + MARK_GAP);
        const tooltip = `${escapeXml(series.name)} · ${escapeXml(spec.labels[index] ?? "")}: ${escapeXml(formatValue(value, spec))}`;

        parts.push(
          `<path d="${barPath(x, yFor(value), yBase, barWidth)}" fill="${color}"><title>${tooltip}</title></path>`,
        );
      });
    });
    // Selective direct labels: single series with few bars gets its values.
    const [only] = spec.series;
    if (spec.series.length === 1 && only && spec.labels.length <= 8) {
      only.values.forEach((value, index) => {
        const above = value >= 0;
        parts.push(
          `<text x="${xCenter(index)}" y="${yFor(value) + (above ? -6 : 14)}" fill="${theme.textSecondary}" font-size="10" text-anchor="middle">${escapeXml(formatValue(value, spec))}</text>`,
        );
      });
    }
  } else {
    spec.series.forEach((series, seriesIndex) => {
      const color = theme.palette[seriesIndex % theme.palette.length];
      const points = series.values.map(
        (value, index) => `${xCenter(index)},${yFor(value)}`,
      );
      parts.push(
        `<polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="${LINE_WIDTH}" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
      series.values.forEach((value, index) => {
        const tooltip = `${escapeXml(series.name)} · ${escapeXml(spec.labels[index] ?? "")}: ${escapeXml(formatValue(value, spec))}`;
        // ≥8px hover targets with a 2px surface ring where marks may overlap.
        parts.push(
          `<circle cx="${xCenter(index)}" cy="${yFor(value)}" r="4" fill="${color}" stroke="${theme.surface}" stroke-width="2"><title>${tooltip}</title></circle>`,
        );
      });
      // Direct series label at the line's end for small multiples.
      const last = series.values[series.values.length - 1];
      if (
        spec.series.length <= MAX_DIRECT_LABELED_SERIES &&
        last !== undefined
      ) {
        parts.push(
          `<text x="${frame.plotRight + 4}" y="${yFor(last) + 3.5}" fill="${theme.textSecondary}" font-size="10">${escapeXml(series.name)}</text>`,
        );
      }
    });
  }
  parts.push(xLabelsSvg(spec, xCenter, frame));

  return parts.join("");
};

const donutSvg = (spec: ChartSpec, frame: Frame) => {
  const { theme } = frame;
  const [series] = spec.series;
  if (!series) return "";
  const total = series.values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return "";
  const cx = (frame.plotLeft + frame.plotRight) / 2;
  const cy = (frame.plotTop + frame.plotBottom) / 2 + 4;
  const radius = Math.min(
    (frame.plotBottom - frame.plotTop) / 2 - 4,
    (frame.plotRight - frame.plotLeft) / 4,
  );
  const ring = Math.max(14, radius * 0.34);
  const mid = radius - ring / 2;
  // 2px surface gap between segments, expressed as an angle at mid-radius.
  const gapAngle = MARK_GAP / mid;

  const parts: string[] = [];
  let angle = -Math.PI / 2;
  series.values.forEach((value, index) => {
    const sweep = (value / total) * Math.PI * 2;
    const start = angle + gapAngle / 2;
    const end = angle + sweep - gapAngle / 2;
    angle += sweep;
    if (end <= start) return;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + mid * Math.cos(start);
    const y1 = cy + mid * Math.sin(start);
    const x2 = cx + mid * Math.cos(end);
    const y2 = cy + mid * Math.sin(end);
    const color = theme.palette[index % theme.palette.length];
    const share = `${Math.round((value / total) * 100)}%`;
    const tooltip = `${escapeXml(spec.labels[index] ?? "")}: ${escapeXml(formatValue(value, spec))} (${share})`;
    parts.push(
      `<path d="M${x1},${y1} A${mid},${mid} 0 ${large} 1 ${x2},${y2}" fill="none" stroke="${color}" stroke-width="${ring}"><title>${tooltip}</title></path>`,
    );
  });
  parts.push(
    `<text x="${cx}" y="${cy + 5}" fill="${theme.textPrimary}" font-size="16" font-weight="600" text-anchor="middle">${escapeXml(formatValue(total, spec))}</text>`,
  );
  // Slice identity lives in the legend row for donuts.
  let x = frame.plotLeft;
  spec.labels.forEach((label, index) => {
    const color = theme.palette[index % theme.palette.length];
    parts.push(
      `<rect x="${x}" y="38" width="10" height="10" rx="2" fill="${color}"/><text x="${x + 14}" y="47" fill="${theme.textSecondary}" font-size="11">${escapeXml(label)}</text>`,
    );
    x += 14 + label.length * 6 + 18;
  });

  return parts.join("");
};

/** Render a validated ChartSpec to a self-contained SVG string. */
export const renderChartSvg = (
  spec: ChartSpec,
  options: RenderChartSvgOptions = {},
) => {
  const base = options.mode === "dark" ? DARK_UI_THEME : LIGHT_UI_THEME;
  const theme: UiSvgTheme = { ...base, ...options.theme };
  const width = options.width ?? WIDTH;
  const height = options.height ?? HEIGHT;
  const frame: Frame = {
    plotBottom: height - MARGIN.bottom,
    plotLeft: MARGIN.left,
    plotRight:
      width -
      MARGIN.right -
      // Room for end-of-line direct labels.
      (spec.type === "line" ? 64 : 0),
    plotTop: MARGIN.top,
    theme,
  };

  const body =
    spec.type === "donut" ? donutSvg(spec, frame) : cartesianSvg(spec, frame);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(spec.title)}" font-family="${FONT}"><rect width="${width}" height="${height}" fill="${theme.surface}" rx="12"/>${spec.type === "donut" ? headerSvg({ ...spec, series: [] }, frame) : headerSvg(spec, frame)}${body}</svg>`;
};
