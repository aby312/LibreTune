import React, { useMemo } from 'react';

// Imported HERE, by the component that needs it, rather than from a shared
// barrel: nothing imported that barrel, so every rule in this stylesheet was
// dead and the traces fell back to the SVG defaults - fill black, stroke none.
// A plot of 107 correctly-computed paths rendered as one black blob. Keeping
// the import next to the markup it styles is what stops that recurring.
import '../../styles/dialogs.css';

/**
 * Overlaid pulse-width / AFR traces from the AFR delay test.
 *
 * Why an overlay rather than a number per step: an 8% enrichment moves pulse
 * width about 4% and AFR about 1 AFR, while per-trace scatter is +/-2-3 AFR.
 * Single steps genuinely cannot be timed - on a 59-minute drive, per-step
 * threshold detection returned anywhere from 52 ms to 2979 ms for what is one
 * transport delay. Stacked, the same events give a clean curve.
 *
 * The delay is read where the median AFR reaches HALF its excursion. That is
 * the steepest, most repeatable part of the rise, and it is the physically
 * meaningful figure: the step response is the cumulative distribution of
 * transit times, so its half-height is the median transit. The leading edge is
 * only the fastest path, and it sits down in the noise - reading at 15%
 * instead spread the same data over 25-300 ms including a physically
 * impossible 25 ms.
 */
export interface TracePoint {
  tMs: number;
  afr: number;
  pw?: number;
}

export interface DelayTrace {
  step: number;
  points: TracePoint[];
  unusable: boolean;
}

interface Props {
  traces: DelayTrace[];
}

const W = 560;
const H = 300;
const PAD = { l: 44, r: 46, t: 14, b: 28 };
const T_MIN = -400;
const T_MAX = 2000;
/// Where on the rise the delay is read. See the note above.
const ONSET_FRACTION = 0.5;
/// Below this the AFR never really moved, so there is nothing to time.
const MIN_EXCURSION = 0.25;
/// Resample step for the median, in ms.
const BIN = 25;

/** Baseline-subtracted AFR, so traces from different mixtures overlay. */
function normalise(points: TracePoint[]): TracePoint[] {
  const pre = points.filter((p) => p.tMs < 0).map((p) => p.afr);
  if (!pre.length) return [];
  const sorted = [...pre].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length / 2)];
  const pwPre = points.filter((p) => p.tMs < 0 && p.pw != null).map((p) => p.pw as number);
  const pwBase = pwPre.length
    ? [...pwPre].sort((a, b) => a - b)[Math.floor(pwPre.length / 2)]
    : 0;
  return points.map((p) => ({
    tMs: p.tMs,
    afr: p.afr - base,
    pw: p.pw == null ? undefined : p.pw - pwBase,
  }));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** Median across traces on a fixed time grid, plus the 50% crossing. */
function stack(traces: DelayTrace[]) {
  // normalise() returns [] for a trace with no pre-anchor samples — which is
  // every recovery trace captured during the settle window, since those begin
  // after the step. They are already ignored by the median below, but counting
  // them made the dialog claim twice as many traces as it actually drew.
  const usable = traces
    .filter((t) => !t.unusable)
    .map((t) => normalise(t.points))
    .filter((t) => t.length > 0);
  const grid: number[] = [];
  for (let t = T_MIN; t <= T_MAX; t += BIN) grid.push(t);

  const med = grid.map((t) => {
    const vals: number[] = [];
    for (const tr of usable) {
      // Linear interpolation between the samples either side of t. This is
      // what recovers sub-sample timing: each step lands at a random phase
      // relative to the sample clock, so averaging dithers. Bootstrapping a
      // real drive gave +/-20 ms from 34 events at a 49 ms sample period.
      for (let i = 1; i < tr.length; i++) {
        const a = tr[i - 1];
        const b = tr[i];
        if (a.tMs <= t && t <= b.tMs) {
          const f = b.tMs === a.tMs ? 0 : (t - a.tMs) / (b.tMs - a.tMs);
          vals.push(a.afr + f * (b.afr - a.afr));
          break;
        }
      }
    }
    return vals.length ? median(vals) : NaN;
  });

  const after = grid.map((t, i) => (t > 0 ? med[i] : NaN)).filter((v) => !Number.isNaN(v));
  const peak = after.length ? Math.min(...after) : NaN;

  let delayMs: number | null = null;
  if (Number.isFinite(peak) && peak <= -MIN_EXCURSION) {
    const thr = peak * ONSET_FRACTION;
    for (let i = 1; i < grid.length; i++) {
      if (grid[i] <= 0 || Number.isNaN(med[i]) || Number.isNaN(med[i - 1])) continue;
      if (med[i] <= thr) {
        const span = med[i - 1] - med[i];
        const f = span === 0 ? 0 : (med[i - 1] - thr) / span;
        delayMs = grid[i - 1] + f * BIN;
        break;
      }
    }
  }
  return { grid, med, usableCount: usable.length, delayMs, peak };
}

export const DelayTraceOverlay: React.FC<Props> = ({ traces }) => {
  const { grid, med, usableCount, delayMs, peak } = useMemo(() => stack(traces), [traces]);

  const afrLo = -2.5;
  const afrHi = 0.8;
  const x = (t: number) => PAD.l + ((t - T_MIN) / (T_MAX - T_MIN)) * (W - PAD.l - PAD.r);
  const y = (a: number) => PAD.t + ((afrHi - a) / (afrHi - afrLo)) * (H - PAD.t - PAD.b);

  const path = (pts: TracePoint[]) =>
    pts
      .filter((p) => p.tMs >= T_MIN && p.tMs <= T_MAX)
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.tMs).toFixed(1)},${y(p.afr).toFixed(1)}`)
      .join(' ');

  // Pulse width rides along underneath, on its own scale. The delay is read
  // from where AFR moves relative to where the FUEL moved, and those are not
  // the same instant — seeing the commanded step next to the measured
  // response is what makes a mis-anchored trace obvious by eye.
  //
  // Baseline-subtracted milliseconds share the AFR zero line (both are
  // deltas from the pre-step baseline), and the largest excursion in view
  // sets the scale, so a 0.16 ms step off a 2 ms pulse is still legible.
  const drawable = traces.filter((t) => t.points.some((p) => p.tMs < 0));
  const pwTraces = drawable
    .map((t) => normalise(t.points).filter((p) => p.pw != null))
    .filter((pts) => pts.length > 1);
  const pwPeak = Math.max(
    0,
    ...pwTraces.flatMap((pts) => pts.map((p) => Math.abs(p.pw as number))),
  );
  // 0.9 keeps the tallest excursion just inside the plot area.
  const yPw = (v: number) =>
    pwPeak > 0 ? y(0) - (v / pwPeak) * (y(0) - PAD.t) * 0.9 : y(0);
  const pwPath = (pts: TracePoint[]) =>
    pts
      .filter((p) => p.tMs >= T_MIN && p.tMs <= T_MAX)
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.tMs).toFixed(1)},${yPw(p.pw as number).toFixed(1)}`)
      .join(' ');

  const medPath = grid
    .map((t, i) => (Number.isNaN(med[i]) ? null : `${x(t).toFixed(1)},${y(med[i]).toFixed(1)}`))
    .filter(Boolean)
    .map((c, i) => `${i ? 'L' : 'M'}${c}`)
    .join(' ');

  if (!traces.length) {
    return (
      <p className="delay-overlay-empty">
        Traces appear here as steps complete. Each one is drawn faint; the bold line is
        their median, and the delay is read where it reaches half its excursion.
      </p>
    );
  }

  return (
    <div className="delay-overlay">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="AFR response traces">
        {/* zero lines */}
        <line x1={x(0)} y1={PAD.t} x2={x(0)} y2={H - PAD.b} className="delay-overlay-step" />
        <line x1={PAD.l} y1={y(0)} x2={W - PAD.r} y2={y(0)} className="delay-overlay-zero" />

        {pwPeak > 0 &&
          pwTraces.map((pts, i) => (
            <path key={`pw-${i}`} d={pwPath(pts)} className="delay-overlay-pw" />
          ))}

        {drawable.map((t) => (
          <path
            key={t.step}
            d={path(normalise(t.points))}
            className={t.unusable ? 'delay-overlay-trace unusable' : 'delay-overlay-trace'}
          />
        ))}

        {medPath && <path d={medPath} className="delay-overlay-median" />}

        {delayMs != null && (
          <>
            <line
              x1={x(delayMs)}
              y1={PAD.t}
              x2={x(delayMs)}
              y2={H - PAD.b}
              className="delay-overlay-marker"
            />
            <text x={x(delayMs) + 6} y={PAD.t + 14} className="delay-overlay-label">
              {delayMs.toFixed(0)} ms
            </text>
          </>
        )}

        {[0, 500, 1000, 1500, 2000].map((t) => (
          <text key={t} x={x(t)} y={H - 8} className="delay-overlay-tick">
            {t / 1000}s
          </text>
        ))}
        {[0, -1, -2].map((a) => (
          <text key={a} x={8} y={y(a) + 4} className="delay-overlay-tick">
            {a}
          </text>
        ))}
        {pwPeak > 0 && (
          <text x={W - PAD.r + 4} y={PAD.t + 10} className="delay-overlay-pw-label">
            PW +{pwPeak.toFixed(2)}ms
          </text>
        )}
      </svg>

      <p className="delay-overlay-summary">
        {/* Count only traces that could ever have been drawn. Recovery traces
            from the settle window have no pre-step baseline, so they are
            excluded for that reason and not for anything the driver did —
            counting them here reported "2 during fuel cut" on a clean run. */}
        {usableCount} usable of {drawable.length}
        {drawable.length - usableCount > 0 &&
          ` (${drawable.length - usableCount} during fuel cut or throttle movement)`}
        {delayMs != null ? (
          <>
            {' — '}
            <strong>{delayMs.toFixed(0)} ms</strong> at half of a {Math.abs(peak).toFixed(2)} AFR
            excursion
          </>
        ) : (
          ' — not enough movement to read a delay yet'
        )}
      </p>
    </div>
  );
};

export default DelayTraceOverlay;
