import { dailyTotals, domainShares, type UsageDay } from "@/lib/usage-charts";

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

function UsageTrend({
  series,
}: {
  series: { day: string; minutes: number }[];
}) {
  const width = 640;
  const height = 220;
  const pad = { left: 40, right: 12, top: 16, bottom: 32 };
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
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));
  const total = series.reduce((sum, point) => sum + point.minutes, 0);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Overall usage, ${total} minutes from ${dayLabel(series[0].day)} to ${dayLabel(series.at(-1)!.day)}`}
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
      {series.map((point, index) => (
        <circle
          key={point.day}
          cx={x(index)}
          cy={y(point.minutes)}
          r="3.5"
          fill="#2B3675"
        >
          <title>
            {dayLabel(point.day)}: {point.minutes} min
          </title>
        </circle>
      ))}
      {series.map((point, index) =>
        index % labelEvery === 0 || index === series.length - 1 ? (
          <text
            key={point.day}
            x={x(index)}
            y={height - 8}
            textAnchor="middle"
            fill="#626b85"
            fontSize="11"
          >
            {dayLabel(point.day)}
          </text>
        ) : null,
      )}
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
}: {
  days: UsageDay[];
  start: string;
  end: string;
}) {
  const series = dailyTotals(days, start, end);
  const total = series.reduce((sum, point) => sum + point.minutes, 0);
  if (!total) return null;
  const { slices, omitted } = domainShares(days);
  return (
    <div className="usage-charts">
      <article>
        <h3>Overall usage</h3>
        <p>{total} minutes in this period.</p>
        <UsageTrend series={series} />
      </article>
      <article>
        <h3>Domains</h3>
        {slices.length ? (
          <>
            <p>
              {omitted
                ? "Domains under 5% of this period are left off."
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
