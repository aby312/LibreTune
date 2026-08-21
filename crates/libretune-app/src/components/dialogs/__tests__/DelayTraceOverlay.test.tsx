import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import DelayTraceOverlay, { DelayTrace } from '../DelayTraceOverlay';

/**
 * A trace that sits at 14.7 until `startMs`, ramps linearly to `startMs + rampMs`
 * ending `depth` AFR richer, then holds. Sampled every 49 ms to match the real
 * logging rate, offset by `phase` so successive traces land at different points
 * relative to the sample clock - that dither is what recovers sub-sample timing.
 */
function ramp(step: number, startMs: number, rampMs: number, depth: number, phase = 0): DelayTrace {
  const points = [];
  for (let t = -400 + phase; t <= 1200; t += 49) {
    let afr = 14.7;
    if (t > startMs) afr = 14.7 - depth * Math.min(1, (t - startMs) / rampMs);
    points.push({ tMs: t, afr, pw: t > startMs ? 1.75 : 1.65 });
  }
  return { step, points, unusable: false };
}

describe('DelayTraceOverlay', () => {
  it('reads the delay at half the excursion, not at the leading edge', () => {
    // Ramp starts at 100 ms and completes at 300 ms, so the half-height is
    // 200 ms. The leading edge would report ~100 ms, which is the fastest gas
    // rather than the median transit time.
    const traces = [0, 7, 13, 21, 33].map((phase, i) => ramp(i + 1, 100, 200, 1.0, phase));
    render(<DelayTraceOverlay traces={traces} />);

    const summary = screen.getByText(/usable of/);
    const ms = Number(summary.textContent?.match(/(\d+)\s*ms/)?.[1]);
    expect(ms).toBeGreaterThan(170);
    expect(ms).toBeLessThan(230);
  });

  it('resolves finer than the 49 ms sample period', () => {
    // Two populations 100 ms apart must be distinguishable even though that is
    // only two samples: dithered phase plus interpolation gets well inside one
    // sample interval.
    const read = (start: number) => {
      const { unmount } = render(
        <DelayTraceOverlay
          traces={[0, 11, 23, 37, 41].map((p, i) => ramp(i + 1, start, 200, 1.0, p))}
        />,
      );
      const ms = Number(
        screen.getByText(/usable of/).textContent?.match(/(\d+)\s*ms/)?.[1],
      );
      unmount();
      return ms;
    };
    expect(read(300) - read(200)).toBeGreaterThan(60);
  });

  it('excludes steps taken during fuel cut or throttle movement', () => {
    const good = [0, 9, 17].map((p, i) => ramp(i + 1, 100, 200, 1.0, p));
    const junk = ramp(99, 900, 100, 3.0);
    junk.unusable = true;

    render(<DelayTraceOverlay traces={[...good, junk]} />);
    const summary = screen.getByText(/usable of/);
    expect(summary.textContent).toContain('3 usable of 4');
    // The junk trace is late and deep; had it counted, the reading would move.
    const ms = Number(summary.textContent?.match(/(\d+)\s*ms/)?.[1]);
    expect(ms).toBeLessThan(300);
  });

  it('says so rather than inventing a number when nothing moved', () => {
    const flat: DelayTrace = {
      step: 1,
      points: Array.from({ length: 30 }, (_, i) => ({ tMs: -400 + i * 49, afr: 14.7 })),
      unusable: false,
    };
    render(<DelayTraceOverlay traces={[flat]} />);
    expect(screen.getByText(/not enough movement/)).toBeInTheDocument();
  });

  it('draws pulse width on its own scale without disturbing the AFR reading', () => {
    // The fixture steps PW 1.65 -> 1.75, i.e. +0.10 ms above the pre-step
    // baseline. PW is milliseconds and AFR is AFR, so it needs a separate
    // scale; the label states the peak so the amber line is readable.
    const traces = [0, 7, 13, 21, 33].map((phase, i) => ramp(i + 1, 100, 200, 1.0, phase));
    const { container } = render(<DelayTraceOverlay traces={traces} />);

    const pw = container.querySelectorAll('path.delay-overlay-pw');
    expect(pw.length).toBe(traces.length);
    expect(screen.getByText(/PW \+0\.10ms/)).toBeTruthy();

    // The line must actually track the step, not sit flat: collapse the scale
    // and this is the only assertion that notices.
    const ys = [...(pw[0].getAttribute('d') ?? '').matchAll(/[ML][\d.]+,([\d.]+)/g)]
      .map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(10);

    // The delay must still be read from AFR alone.
    const ms = Number(screen.getByText(/usable of/).textContent?.match(/(\d+)\s*ms/)?.[1]);
    expect(ms).toBeGreaterThan(170);
    expect(ms).toBeLessThan(230);
  });

  it('omits the pulse-width layer when no trace carries pw', () => {
    const bare: DelayTrace = {
      step: 1,
      unusable: false,
      points: Array.from({ length: 40 }, (_, i) => ({
        tMs: -400 + i * 49,
        afr: i > 12 ? 13.7 : 14.7,
      })),
    };
    const { container } = render(<DelayTraceOverlay traces={[bare]} />);
    expect(container.querySelectorAll('path.delay-overlay-pw').length).toBe(0);
    expect(screen.queryByText(/PW \+/)).toBeNull();
  });

  it('does not blame the settle-window traces on fuel cut', () => {
    // A recovery trace starts after the step, so it has no pre-step baseline
    // and cannot be drawn. It must not appear in the denominator, and must
    // not be attributed to fuel cut or throttle movement.
    const good = ramp(1, 100, 200, 1.0);
    const recovery: DelayTrace = {
      step: 1,
      unusable: false,
      points: Array.from({ length: 20 }, (_, i) => ({
        tMs: 3000 + i * 49,
        afr: 13.7 + i * 0.05,
        pw: 1.65,
      })),
    };
    render(<DelayTraceOverlay traces={[good, recovery]} />);
    const summary = screen.getByText(/usable of/).textContent ?? '';
    expect(summary).toMatch(/1 usable of 1/);
    expect(summary).not.toMatch(/fuel cut/);
  });
});
