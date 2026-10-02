import { useRef, useState } from 'preact/hooks';
import type { DailyUptime } from './api';
import { fmtDay, fmtDayLong, fmtInt, fmtUptime } from './format';

export type Level = 'ok' | 'minor' | 'major' | 'none';
export const levelOf = (d: DailyUptime): Level => (!d.checks ? 'none' : d.uptime != null && d.uptime >= 100 ? 'ok' : d.uptime != null && d.uptime >= 95 ? 'minor' : 'major');
export const LEVEL_TEXT: Record<Level, string> = {
  ok: 'All checks passed',
  minor: 'Some checks failed (95% or more passed)',
  major: 'Major disruption (under 95% passed)',
  none: 'No checks recorded',
};

function dayText(d: DailyUptime): string {
  if (!d.checks) return `${fmtDayLong(d.date)}: no checks recorded.`;
  return `${fmtDayLong(d.date)}: ${fmtUptime(d.uptime)} uptime, ${fmtInt(d.ok_checks)} of ${fmtInt(d.checks)} checks passed.`;
}

/** Plain-language summary of a strip, used as its accessible name. */
export function stripSummary(name: string, days: DailyUptime[]): string {
  const withData = days.filter((d) => d.checks > 0);
  if (!withData.length) return `${name}: no checks recorded in the last ${days.length} days.`;
  const bad = withData.filter((d) => (d.uptime ?? 0) < 100);
  const worst = bad.reduce<DailyUptime | null>((w, d) => (!w || (d.uptime ?? 0) < (w.uptime ?? 0) ? d : w), null);
  const first = withData[0].date;
  const head = `${name}: checks recorded on ${withData.length} of the last ${days.length} days, starting ${fmtDayLong(first)}.`;
  if (!bad.length) return `${head} Every check passed on every day.`;
  return `${head} ${bad.length} ${bad.length === 1 ? 'day' : 'days'} had failed checks; the lowest was ${fmtUptime(worst!.uptime)} on ${fmtDayLong(worst!.date)}.`;
}

/**
 * One bar per UTC day, colored by that day's uptime. Hover or tap a bar for the day's numbers.
 * Keyboard: focus the strip, then use the arrow keys, Home and End.
 */
export function UptimeStrip({ name, days }: { name: string; days: DailyUptime[] }) {
  const [active, setActive] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const n = days.length;
  const pick = (clientX: number) => {
    const el = ref.current; if (!el || !n) return;
    const r = el.getBoundingClientRect();
    setActive(Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n))));
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
  const d = active != null ? days[active] : null;
  const left = active != null ? ((active + 0.5) / n) * 100 : 0;
  return (
    <div class="lv-strip-wrap">
      <div
        ref={ref}
        class="lv-strip"
        role="group"
        aria-roledescription="daily uptime chart"
        tabIndex={0}
        aria-label={`${stripSummary(name, days)} Use the left and right arrow keys to read each day.`}
        onMouseMove={(e) => pick(e.clientX)}
        onMouseLeave={() => setActive(null)}
        onPointerDown={(e) => pick(e.clientX)}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? n - 1)}
        onBlur={() => setActive(null)}
      >
        {days.map((x, i) => <span key={x.date} class={`lv-bar ${levelOf(x)}${i === active ? ' on' : ''}`} />)}
      </div>
      {d && (
        <div class={`lv-tip${left < 18 ? ' l' : left > 82 ? ' r' : ''}`} style={{ left: `${left}%` }} aria-hidden="true">
          <strong>{fmtDay(d.date)}</strong>
          <span>{d.checks ? `${fmtUptime(d.uptime)} uptime` : 'No checks recorded'}</span>
          {d.checks > 0 && <span class="lv-tip-sub">{fmtInt(d.ok_checks)} of {fmtInt(d.checks)} checks passed</span>}
        </div>
      )}
      <p class="lv-sr" aria-live="polite">{d ? dayText(d) : ''}</p>
      <div class="lv-strip-axis" aria-hidden="true"><span>{n} days ago</span><span>Today</span></div>
    </div>
  );
}
