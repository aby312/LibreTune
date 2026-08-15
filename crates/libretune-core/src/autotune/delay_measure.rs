//! AFR transport-delay extraction from an enrichment step.
//!
//! The delay test applies a fuel step at a known instant; the wideband sees it
//! only after the exhaust transport delay plus the sensor's own lag. This
//! module turns the sampled AFR trace around one step into a single measured
//! delay, or declines when the trace can't support one.
//!
//! Pure functions, no I/O — the command layer feeds it samples and an anchor
//! timestamp. Everything here is unit-tested against synthetic traces because
//! the bench simulator's AFR does not respond to fuelling; first live
//! validation happens on a real engine.

use serde::Serialize;

/// One realtime sample: milliseconds (monotonic, same clock as the step
/// anchor) and the AFR reading.
#[derive(Debug, Clone, Copy)]
pub struct AfrSample {
    pub t_ms: u64,
    pub afr: f64,
}

/// A successful delay extraction for one enrichment step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DelayMeasurement {
    /// Milliseconds from the step anchor to the detected AFR response edge.
    pub delay_ms: f64,
    /// AFR drop actually observed at detection relative to baseline.
    pub excursion: f64,
    /// Pre-step baseline the edge was measured against.
    pub baseline_afr: f64,
}

/// Why a step produced no measurement — surfaced to the UI so a silent
/// no-result is distinguishable from a broken run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelayRejection {
    /// Fewer pre-step samples than needed to establish a baseline.
    InsufficientBaseline,
    /// Pre-step AFR was moving too much to anchor a baseline (operator not
    /// steady, or sensor noise beyond usable).
    UnstableBaseline,
    /// No sustained excursion past the threshold inside the window (step too
    /// small for the noise, sensor dead, or — on the bench — a simulator
    /// whose AFR ignores fuelling).
    NoResponse,
}

impl DelayRejection {
    /// Short operator-facing label.
    pub fn label(&self) -> &'static str {
        match self {
            DelayRejection::InsufficientBaseline => "too few baseline samples",
            DelayRejection::UnstableBaseline => "baseline unstable — hold steadier",
            DelayRejection::NoResponse => "no AFR response detected",
        }
    }
}

/// Minimum samples required in the pre-step window.
const MIN_BASELINE_SAMPLES: usize = 4;
/// Baseline scatter (median absolute deviation) above which no edge can be
/// trusted, in AFR points.
const MAX_BASELINE_MAD: f64 = 0.35;
/// The excursion must exceed max(K_MAD * MAD, MIN_EXCURSION_AFR).
const K_MAD: f64 = 3.0;
const MIN_EXCURSION_AFR: f64 = 0.15;
/// An edge only counts when the crossing is sustained for this many samples,
/// so a single noise spike cannot fake a response.
const SUSTAIN_SAMPLES: usize = 2;

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

/// Median absolute deviation — robust scatter estimate for a noisy trace.
fn mad(values: &[f64], med: f64) -> f64 {
    let mut devs: Vec<f64> = values.iter().map(|v| (v - med).abs()).collect();
    median(&mut devs)
}

/// Extract the transport delay for one enrichment step.
///
/// `anchor_ms` is the instant the enriched value finished writing to the ECU.
/// `pre` are samples strictly before the anchor (baseline window); `post` are
/// samples at or after it, in time order. Enrichment drives AFR *down*, so the
/// edge is the first sustained crossing below `baseline - threshold`.
pub fn detect_delay(
    anchor_ms: u64,
    pre: &[AfrSample],
    post: &[AfrSample],
) -> Result<DelayMeasurement, DelayRejection> {
    if pre.len() < MIN_BASELINE_SAMPLES {
        return Err(DelayRejection::InsufficientBaseline);
    }

    let mut base_vals: Vec<f64> = pre.iter().map(|s| s.afr).collect();
    let baseline = median(&mut base_vals);
    let scatter = mad(&base_vals, baseline);
    if scatter > MAX_BASELINE_MAD {
        return Err(DelayRejection::UnstableBaseline);
    }

    let threshold = (K_MAD * scatter).max(MIN_EXCURSION_AFR);
    let trigger = baseline - threshold;

    let mut run = 0usize;
    let mut edge: Option<&AfrSample> = None;
    // Sample immediately before the crossing, for sub-sample interpolation.
    let mut before_edge: Option<&AfrSample> = None;
    let mut prev: Option<&AfrSample> = None;
    for s in post {
        if s.afr < trigger {
            run += 1;
            if run == 1 {
                edge = Some(s);
                before_edge = prev;
            }
            if run >= SUSTAIN_SAMPLES {
                let e = edge.expect("run >= 1 implies edge set");

                // The crossing happened somewhere between the last sample above
                // the trigger and this first one below it, not exactly when the
                // sample landed. Reporting the sample time alone biases every
                // measurement late by half a sample interval on average — 31 ms
                // at the ~16 Hz these logs actually run at, which is a large
                // share of a high-flow delay. Interpolate linearly across the
                // crossing instead.
                let crossing_ms = match before_edge {
                    Some(b) if b.afr > e.afr && b.t_ms < e.t_ms => {
                        let span = (e.t_ms - b.t_ms) as f64;
                        let frac = ((b.afr - trigger) / (b.afr - e.afr)).clamp(0.0, 1.0);
                        b.t_ms as f64 + span * frac
                    }
                    // No usable prior sample (the crossing is the first sample
                    // after the anchor): fall back to the sample's own time.
                    _ => e.t_ms as f64,
                };
                let delay_ms = (crossing_ms - anchor_ms as f64).max(0.0);

                return Ok(DelayMeasurement {
                    delay_ms,
                    excursion: baseline - e.afr,
                    baseline_afr: baseline,
                });
            }
        } else {
            run = 0;
            edge = None;
            before_edge = None;
        }
        prev = Some(s);
    }

    Err(DelayRejection::NoResponse)
}

/// Fixed coarse grid for aggregating measurements by operating point.
/// Bin edges chosen for a small NA engine; a cell is (load_bin, rpm_bin).
pub const RPM_EDGES: [f64; 5] = [1200.0, 2000.0, 3000.0, 4500.0, 6500.0];
pub const LOAD_EDGES: [f64; 4] = [40.0, 60.0, 80.0, 100.0];

/// One aggregated cell of the delay table.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct DelayCell {
    pub n: u32,
    pub mean_ms: f64,
    /// Simple spread indicator: max - min of contributing delays.
    pub range_ms: f64,
    #[serde(skip)]
    min_ms: f64,
    #[serde(skip)]
    max_ms: f64,
}

/// rpm × load grid of aggregated delay measurements.
#[derive(Debug, Clone, Serialize)]
pub struct DelayTable {
    /// Upper edges of the rpm bins; the last bin is open-ended.
    pub rpm_edges: Vec<f64>,
    /// Upper edges of the load bins; the last bin is open-ended.
    pub load_edges: Vec<f64>,
    /// `cells[load_bin][rpm_bin]`
    pub cells: Vec<Vec<DelayCell>>,
}

impl DelayTable {
    pub fn new() -> Self {
        let rows = LOAD_EDGES.len() + 1;
        let cols = RPM_EDGES.len() + 1;
        Self {
            rpm_edges: RPM_EDGES.to_vec(),
            load_edges: LOAD_EDGES.to_vec(),
            cells: vec![vec![DelayCell::default(); cols]; rows],
        }
    }

    fn bin(edges: &[f64], v: f64) -> usize {
        edges.iter().position(|e| v < *e).unwrap_or(edges.len())
    }

    /// Bin indices for an operating point — exposed for tests and callers
    /// that need to address a cell directly.
    pub fn cell_index(&self, rpm: f64, load: f64) -> (usize, usize) {
        (
            Self::bin(&self.load_edges, load),
            Self::bin(&self.rpm_edges, rpm),
        )
    }

    /// Fold one measurement taken at (rpm, load) into its cell.
    pub fn add(&mut self, rpm: f64, load: f64, delay_ms: f64) {
        let (l, r) = self.cell_index(rpm, load);
        let c = &mut self.cells[l][r];
        if c.n == 0 {
            c.min_ms = delay_ms;
            c.max_ms = delay_ms;
        } else {
            c.min_ms = c.min_ms.min(delay_ms);
            c.max_ms = c.max_ms.max(delay_ms);
        }
        c.mean_ms = (c.mean_ms * c.n as f64 + delay_ms) / (c.n as f64 + 1.0);
        c.n += 1;
        c.range_ms = c.max_ms - c.min_ms;
    }
}

impl Default for DelayTable {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace(points: &[(u64, f64)]) -> Vec<AfrSample> {
        points
            .iter()
            .map(|&(t_ms, afr)| AfrSample { t_ms, afr })
            .collect()
    }

    /// The crossing rarely lands exactly on a sample. Reporting the sample's own
    /// time biases every measurement late by up to a full interval — 63 ms at
    /// the ~16 Hz these logs run at, which is a big share of a high-flow delay.
    /// Interpolating across the crossing must land between the two samples and
    /// close to where the AFR genuinely passed the trigger.
    #[test]
    fn crossing_is_interpolated_between_samples() {
        // Baseline 14.70, MAD ~0 so the trigger is baseline - MIN_EXCURSION_AFR.
        let pre = trace(&[(0, 14.70), (60, 14.70), (120, 14.70), (180, 14.70)]);
        // AFR is still at baseline at 240, then well past the trigger at 300:
        // the true crossing lies between, nearer 300 the deeper the last sample.
        let post = trace(&[(240, 14.70), (300, 14.30), (360, 14.10), (420, 14.05)]);

        let m = detect_delay(240, &pre, &post).expect("should measure");
        assert!(
            m.delay_ms > 0.0 && m.delay_ms < 60.0,
            "interpolated crossing {:.0} ms must fall inside the 240-300 ms sample gap",
            m.delay_ms
        );
        // Reporting the raw sample time would have given exactly 60 ms.
        assert!(
            m.delay_ms < 59.0,
            "expected sub-sample resolution, got the sample time itself ({:.0} ms)",
            m.delay_ms
        );
    }

    /// When the very first post-anchor sample is already past the trigger there
    /// is nothing to interpolate from; the sample time is the honest answer and
    /// must not be mangled into a negative or absurd delay.
    #[test]
    fn crossing_on_the_first_sample_falls_back_cleanly() {
        let pre = trace(&[(0, 14.70), (60, 14.70), (120, 14.70), (180, 14.70)]);
        let post = trace(&[(240, 14.20), (300, 14.10), (360, 14.05)]);
        let m = detect_delay(240, &pre, &post).expect("should measure");
        assert_eq!(
            m.delay_ms, 0.0,
            "first sample at the anchor means zero delay"
        );
    }

    /// Clean step: steady 14.7 baseline. AFR is still 14.68 at 320 ms and 14.2
    /// at 380 ms, so it passes the 14.55 trigger at ~336 ms — 136 ms after the
    /// anchor. Reporting the sample time would say 180 ms, 44 ms late.
    #[test]
    fn clean_step_yields_the_transport_delay() {
        let pre = trace(&[
            (0, 14.7),
            (40, 14.68),
            (80, 14.72),
            (120, 14.7),
            (160, 14.69),
        ]);
        let post = trace(&[
            (200, 14.7),
            (240, 14.71),
            (280, 14.69),
            (320, 14.68),
            (380, 14.2), // edge
            (420, 13.9),
            (460, 13.7),
        ]);
        let m = detect_delay(200, &pre, &post).expect("clean step must measure");
        assert!(
            (m.delay_ms - 136.25).abs() < 0.5,
            "interpolated crossing, got {}",
            m.delay_ms
        );
        assert!(m.excursion > 0.4);
        assert!((m.baseline_afr - 14.7).abs() < 0.05);
    }

    /// A single noise spike below threshold must not register as the edge.
    #[test]
    fn single_spike_is_not_an_edge() {
        let pre = trace(&[(0, 14.7), (40, 14.7), (80, 14.7), (120, 14.7)]);
        let post = trace(&[
            (200, 14.7),
            (240, 13.9), // lone spike
            (280, 14.7),
            (320, 14.71),
            (360, 14.69),
        ]);
        assert_eq!(
            detect_delay(200, &pre, &post),
            Err(DelayRejection::NoResponse)
        );
    }

    /// A sustained crossing right after a lone spike anchors on the real run,
    /// not the spike: the crossing is interpolated between 280 ms (14.7) and
    /// 320 ms (14.0), giving ~89 ms — comfortably after the 40 ms spike.
    #[test]
    fn edge_anchors_at_the_sustained_run() {
        let pre = trace(&[(0, 14.7), (40, 14.7), (80, 14.7), (120, 14.7)]);
        let post = trace(&[
            (200, 14.7),
            (240, 13.9), // spike, run resets after
            (280, 14.7),
            (320, 14.0), // real edge starts
            (360, 13.8),
        ]);
        let m = detect_delay(200, &pre, &post).expect("must measure");
        assert!(
            (m.delay_ms - 88.6).abs() < 0.5,
            "must anchor on the sustained run, got {}",
            m.delay_ms
        );
    }

    #[test]
    fn wandering_baseline_is_rejected() {
        let pre = trace(&[(0, 13.2), (40, 15.4), (80, 12.9), (120, 15.8), (160, 13.5)]);
        let post = trace(&[(200, 12.0), (240, 12.0), (280, 12.0)]);
        assert_eq!(
            detect_delay(200, &pre, &post),
            Err(DelayRejection::UnstableBaseline)
        );
    }

    #[test]
    fn too_few_baseline_samples_rejected() {
        let pre = trace(&[(0, 14.7), (40, 14.7)]);
        let post = trace(&[(200, 13.0), (240, 13.0)]);
        assert_eq!(
            detect_delay(200, &pre, &post),
            Err(DelayRejection::InsufficientBaseline)
        );
    }

    /// The dead simulator case: AFR never reacts. Must decline, not invent.
    #[test]
    fn flat_trace_declines() {
        let pre = trace(&[(0, 14.7), (40, 14.7), (80, 14.7), (120, 14.7)]);
        let post: Vec<AfrSample> = (0..40)
            .map(|i| AfrSample {
                t_ms: 200 + i * 40,
                afr: 14.7 + if i % 2 == 0 { 0.02 } else { -0.02 },
            })
            .collect();
        assert_eq!(
            detect_delay(200, &pre, &post),
            Err(DelayRejection::NoResponse)
        );
    }

    #[test]
    fn table_bins_and_aggregates() {
        let mut t = DelayTable::new();
        t.add(900.0, 35.0, 400.0); // idle cell
        t.add(950.0, 38.0, 360.0); // same cell
        t.add(3200.0, 85.0, 140.0); // mid-rpm, high-load
        t.add(7000.0, 105.0, 90.0); // open-ended top bins

        let idle = &t.cells[0][0];
        assert_eq!(idle.n, 2);
        assert!((idle.mean_ms - 380.0).abs() < 1e-9);
        assert!((idle.range_ms - 40.0).abs() < 1e-9);

        let (l, r) = t.cell_index(3200.0, 85.0);
        assert_eq!(t.cells[l][r].n, 1);

        let top = &t.cells[LOAD_EDGES.len()][RPM_EDGES.len()];
        assert_eq!(top.n, 1);
        assert!((top.mean_ms - 90.0).abs() < 1e-9);
    }
}
