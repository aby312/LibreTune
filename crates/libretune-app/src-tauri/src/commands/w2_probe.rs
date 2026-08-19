//! Temporary instrumentation for the W2 ~90 s command stall (bench-only
//! branch, never for a PR). Answers one question: when a write/burn invoke
//! stalls, where does the time go — queued before the handler runs, waiting
//! on a lock, or inside the serial I/O — and how many realtime fetches are
//! in flight at that moment.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

pub static REALTIME_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

pub struct Probe {
    cmd: &'static str,
    t0: Instant,
    /// Quiet probes only report when slow, so the 20 Hz realtime path does
    /// not flood the log.
    quiet: bool,
}

impl Probe {
    pub fn new(cmd: &'static str) -> Self {
        let rt = REALTIME_IN_FLIGHT.load(Ordering::Relaxed);
        tracing::info!(target: "w2", cmd, realtime_in_flight = rt, "enter");
        Self {
            cmd,
            t0: Instant::now(),
            quiet: false,
        }
    }

    pub fn quiet(cmd: &'static str) -> Self {
        Self {
            cmd,
            t0: Instant::now(),
            quiet: true,
        }
    }

    pub fn mark(&self, at: &str) {
        if !self.quiet {
            tracing::info!(
                target: "w2",
                cmd = self.cmd,
                at,
                ms = self.t0.elapsed().as_millis() as u64,
                "mark"
            );
        }
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let ms = self.t0.elapsed().as_millis() as u64;
        if !self.quiet || ms > 250 {
            tracing::info!(target: "w2", cmd = self.cmd, total_ms = ms, "exit");
        }
    }
}

/// RAII in-flight counter for get_realtime_data; Drop keeps the count honest
/// across every `?` early return.
pub struct RtGuard;

impl RtGuard {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        REALTIME_IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        RtGuard
    }
}

impl Drop for RtGuard {
    fn drop(&mut self) {
        REALTIME_IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}
