import {
  DOMAIN_SLICE_LIMIT,
  domainShares,
  hourlyTotals,
  type UsageDay,
} from "@/lib/usage-charts";

const COLORS = [
  "#2B3675",
  "#6474b8",
  "#9983bd",
  "#c4a35a",
  "#4f899a",
  "#8f6b4a",
  "#a04934",
  "#626b85",
];

const dayLabel = (day: string) =>
  new Date(day + "T12:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const clockLabel = (hour: number) =>
  `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;

/** `YYYY-MM-DDTHH` → a short axis or tooltip label. */
function formatHour(stamp: string, withDate: boolean) {
  const [day, hh] = stamp.split("T");
  const hour = Number(hh);
  const clock = clockLabel(hour);
  if (!withDate) return clock;
  return hour === 0 ? dayLabel(day) : `${dayLabel(day)}, ${clock}`;
}

function formatHourExact(stamp: string) {
  const [day, hh] = stamp.split("T");
  return `${dayLabel(day)}, ${clockLabel(Number(hh))}`;
}

/** About six axis labels, snapped to a readable hour on longer ranges. */
function labelEvery(count: number) {
  if (count <= 1) return 1;
  if (count <= 36) return Math.ceil(count / 6);
  return Math.max(6, Math.round(Math.ceil(count / 6) / 6) * 6);
}

const CHART_WIDTH = 640;
const CHART_PAD = { left: 40, right: 12 };

/** Rough width of an 11px axis label in chart units. */
function labelWidth(text: string) {
  return text.length * 6.4;
}

function axisAnchor(index: number, count: number) {
  if (count === 1) return "middle";
  if (index === 0) return "start";
  if (index === count - 1) return "end";
  return "middle";
}

/** Tick labels that do not collide, keeping the first and last hour when they fit. */
function axisLabels(
  series: { hour: string }[],
  step: number,
  multiDay: boolean,
) {
  const plot = CHART_WIDTH - CHART_PAD.left - CHART_PAD.right;
  const x = (index: number) =>
    series.length === 1
      ? CHART_PAD.left + plot / 2
      : CHART_PAD.left + (index / (series.length - 1)) * plot;
  const bounds = (index: number, text: string) => {
    const width = labelWidth(text);
    const anchor = axisAnchor(index, series.length);
    const left =
      anchor === "start"
        ? x(index)
        : anchor === "end"
          ? x(index) - width
          : x(index) - width / 2;
    return [left, left + width] as const;
  };
  const overlaps = (
    a: { index: number; text: string },
    b: { index: number; text: string },
  ) => bounds(a.index, a.text)[1] + 8 > bounds(b.index, b.text)[0];
  const candidates = series.flatMap((point, index) =>
    index % step === 0 || index === series.length - 1
      ? [{ index, text: formatHour(point.hour, multiDay) }]
      : [],
  );
  const kept: { index: number; text: string }[] = [];
  for (const candidate of candidates) {
    if (candidate.index === series.length - 1)
      while (kept.length > 1 && overlaps(kept.at(-1)!, candidate)) kept.pop();
    if (kept.length && overlaps(kept.at(-1)!, candidate)) continue;
    kept.push(candidate);
  }
  return kept;
}

function UsageTrend({
  series,
}: {
  series: { hour: string; minutes: number }[];
}) {
  const width = CHART_WIDTH;
  const height = 220;
  const pad = { ...CHART_PAD, top: 16, bottom: 32 };
  const max = Math.max(1, ...series.map((point) => point.minutes));
  const x = (index: number) =>
    series.length === 1
      ? pad.left + (width - pad.left - pad.right) / 2
      : pad.left +
        (index / (series.length - 1)) * (width - pad.left - pad.right);
  const y = (minutes: number) =>
    pad.top + (1 - minutes / max) * (height - pad.top - pad.bottom);
  const line = series
    .map(
      (point, index) => `${index ? "L" : "M"}${x(index)},${y(point.minutes)}`,
    )
    .join(" ");
  const area = `${line} L${x(series.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const labelStep = labelEvery(series.length);
  const multiDay =
    series[0].hour.slice(0, 10) !== series.at(-1)!.hour.slice(0, 10);
  const ticks = axisLabels(series, labelStep, multiDay);
  const marked =
    series.length <= 36
      ? series.map((_, index) => index)
      : series.flatMap((point, index) => (point.minutes > 0 ? [index] : []));
  const showMarks = marked.length > 0 && marked.length <= 48;
  const total = series.reduce((sum, point) => sum + point.minutes, 0);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Overall usage, ${total} minutes from ${formatHourExact(series[0].hour)} to ${formatHourExact(series.at(-1)!.hour)}`}
    >
      {[0, 0.5, 1].map((step) => (
        <g key={step}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={y(max * step)}
            y2={y(max * step)}
            stroke="#dde1ef"
          />
          <text
            x={pad.left - 8}
            y={y(max * step) + 4}
            textAnchor="end"
            fill="#626b85"
            fontSize="11"
          >
            {Math.round(max * step)}
          </text>
        </g>
      ))}
      <path d={area} fill="#2B3675" opacity="0.15" />
      <path d={line} fill="none" stroke="#2B3675" strokeWidth="2.5" />
      {showMarks
        ? marked.map((index) => {
            const point = series[index];
            return (
              <circle
                key={point.hour}
                cx={x(index)}
                cy={y(point.minutes)}
                r="3.5"
                fill="#2B3675"
              >
                <title>
                  {formatHourExact(point.hour)}: {point.minutes} min
                </title>
              </circle>
            );
          })
        : null}
      {ticks.map((tick) => (
        <text
          key={series[tick.index].hour}
          x={x(tick.index)}
          y={height - 8}
          textAnchor={axisAnchor(tick.index, series.length)}
          fill="#626b85"
          fontSize="11"
        >
          {tick.text}
        </text>
      ))}
    </svg>
  );
}

function DomainPie({
  slices,
}: {
  slices: { name: string; minutes: number }[];
}) {
  const total = slices.reduce((sum, slice) => sum + slice.minutes, 0);
  const radius = 78;
  const center = 96;
  let angle = -Math.PI / 2;
  const wedges = slices.map((slice, index) => {
    const sweep = (slice.minutes / total) * Math.PI * 2;
    const start = angle;
    angle += sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const from = [
      center + radius * Math.cos(start),
      center + radius * Math.sin(start),
    ];
    const to = [
      center + radius * Math.cos(angle),
      center + radius * Math.sin(angle),
    ];
    return { slice, index, sweep, large, from, to };
  });
  return (
    <svg
      viewBox="0 0 192 192"
      role="img"
      aria-label={`Domain usage: ${slices.map((slice) => `${slice.name} ${slice.minutes} minutes`).join(", ")}`}
    >
      {wedges.length === 1 ? (
        <circle cx={center} cy={center} r={radius} fill={COLORS[0]}>
          <title>
            {wedges[0].slice.name}: {wedges[0].slice.minutes} min
          </title>
        </circle>
      ) : (
        wedges.map((wedge) => (
          <path
            key={wedge.slice.name}
            d={`M ${center} ${center} L ${wedge.from[0]} ${wedge.from[1]} A ${radius} ${radius} 0 ${wedge.large} 1 ${wedge.to[0]} ${wedge.to[1]} Z`}
            fill={COLORS[wedge.index % COLORS.length]}
            stroke="#fff"
            strokeWidth="2"
          >
            <title>
              {wedge.slice.name}: {wedge.slice.minutes} min
            </title>
          </path>
        ))
      )}
    </svg>
  );
}

export function UsageCharts({
  days,
  start,
  end,
  now,
}: {
  days: UsageDay[];
  start: string;
  end: string;
  now?: { day: string; hour: number };
}) {
  const series = hourlyTotals(days, start, end, now);
  const total = series.reduce((sum, point) => sum + point.minutes, 0);
  if (!total) return null;
  const { slices, grouped } = domainShares(days);
  return (
    <div className="usage-charts">
      <article>
        <h3>Usage by hour</h3>
        <p>{total} minutes in this period, counted by hour.</p>
        <UsageTrend series={series} />
      </article>
      <article>
        <h3>Domains</h3>
        {slices.length ? (
          <>
            <p>
              {grouped
                ? `Top ${DOMAIN_SLICE_LIMIT} domains, with the rest grouped as Other.`
                : "Share of observed domain minutes."}
            </p>
            <DomainPie slices={slices} />
            <ul className="pie-legend">
              {slices.map((slice, index) => (
                <li key={slice.name}>
                  <span
                    className="swatch"
                    style={{ background: COLORS[index % COLORS.length] }}
                  />
                  {slice.name} <span>{slice.minutes} min</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No domain activity in this period.</p>
        )}
      </article>
    </div>
  );
}
