import { useEffect, useRef, useState } from 'preact/hooks';
import { fmtDay, fmtDayLong } from './format';

/** Rounds a maximum up to a clean axis top with an even step: 0, 5, 10 or 0, 2,000, 4,000. */
export function niceScale(max: number, ticks = 2): { top: number; step: number } {
  if (!(max > 0)) return { top: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const clean = step < 1 ? 1 : step;
  return { top: Math.ceil(max / clean) * clean, step: clean };
}

type Props = {
  title: string;
  days: string[];
  values: number[];
  format: (v: number) => string;
  tickFormat?: (v: number) => string;
  unit: string;
  height?: number;
};

/**
 * A single-series daily column chart drawn to scale in SVG: zero baseline, hairline grid,
 * columns at most 24 px wide with a 2 px gap and a rounded top. Hover, tap or arrow keys show a day.
 */
export function ColumnChart({ title, days, values, format, tickFormat, unit, height = 168 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = values.length;
  const max = Math.max(0, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const { top, step } = niceScale(max);
  const tf = tickFormat ?? format;
  const ticks: number[] = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  const labelW = Math.max(...ticks.map((t) => tf(t).length)) * 6.6 + 10;
  const m = { l: Math.round(labelW), r: 4, t: 10, b: 26 };
  const pw = w - m.l - m.r;
  const ph = height - m.t - m.b;
  const slot = pw / Math.max(1, n);
  const bw = Math.max(1, Math.min(24, slot - 2));
  const y = (v: number) => m.t + ph - (v / top) * ph;
  const peakI = values.indexOf(max);
  const mid = Math.floor((n - 1) / 2);

  const bar = (i: number, v: number) => {
    if (v <= 0) return null;
    const x = m.l + i * slot + (slot - bw) / 2;
    const y0 = m.t + ph; const y1 = y(v);
    const h = y0 - y1;
    const r = Math.min(4, bw / 2, h);
    // Rounded at the data end, square at the baseline.
    const d = `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z`;
    return <path key={i} d={d} class={`lv-col${i === active ? ' on' : ''}`} />;
  };

  const onKey = (e: KeyboardEvent) => {
    const cur = active ?? n - 1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') { setActive(null); return; }
    if (next != null) { e.preventDefault(); setActive(next); }
  };

  const summary = !n ? `${title}: no data.` : max === 0
    ? `${title}, last ${n} days: none recorded.`
    : `${title}, last ${n} days: ${format(total)} in total, peak ${format(max)} on ${fmtDayLong(days[peakI])}.`;
  const tipX = active != null ? m.l + (active + 0.5) * slot : 0;
  const side = tipX < w * 0.2 ? ' l' : tipX > w * 0.8 ? ' r' : '';

  return (
    <div class="lv-chart" ref={box}>
      <div
        class="lv-chart-plot"
        role="group"
        aria-roledescription="column chart"
        aria-label={`${summary} Use the left and right arrow keys to read each day.`}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? n - 1)}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} aria-hidden="true" focusable="false">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} class={t === 0 ? 'lv-axis' : 'lv-grid'} />
              <text x={m.l - 8} y={y(t)} class="lv-tick" text-anchor="end" dominant-baseline="middle">{tf(t)}</text>
            </g>
          ))}
          {values.map((v, i) => bar(i, v))}
          {n > 0 && <>
            <text x={m.l} y={height - 6} class="lv-tick" text-anchor="start">{fmtDay(days[0])}</text>
            {n > 2 && <text x={m.l + (mid + 0.5) * slot} y={height - 6} class="lv-tick" text-anchor="middle">{fmtDay(days[mid])}</text>}
            <text x={w - m.r} y={height - 6} class="lv-tick" text-anchor="end">{fmtDay(days[n - 1])}</text>
          </>}
          {max === 0 && <text x={m.l + pw / 2} y={m.t + ph / 2} class="lv-tick lv-none" text-anchor="middle" dominant-baseline="middle">None recorded in this window</text>}
          {values.map((_, i) => (
            <rect key={i} x={m.l + i * slot} y={m.t} width={slot} height={ph} class="lv-hit"
              onMouseEnter={() => setActive(i)} onPointerDown={() => setActive(i)} />
          ))}
        </svg>
        {active != null && (
          <div class={`lv-tip${side}`} style={{ left: `${tipX}px`, top: `${Math.max(0, y(values[active]) - 8)}px` }} aria-hidden="true">
            <strong>{fmtDay(days[active])}</strong>
            <span>{format(values[active])} {unit}</span>
          </div>
        )}
        <p class="lv-sr" aria-live="polite">{active != null ? `${fmtDayLong(days[active])}: ${format(values[active])} ${unit}.` : ''}</p>
      </div>
    </div>
  );
}
