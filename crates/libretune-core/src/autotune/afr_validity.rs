//! Rejects wideband readings that are being *held* rather than measured.
//!
//! A wideband on a running engine always dithers: combustion is never identical
//! cycle to cycle, so the reading moves. A value that sits perfectly still is
//! the controller reporting something other than a mixture:
//!
//! - **Out of range.** The sensor rails (19.7 on a Speeduino's 0.1-resolution
//!   AFR channel) and stays there. In one 59-minute drive this was **12.9 % of
//!   all running samples**, with holds up to 36 seconds — every one of them fed
//!   into VE learning as though it were a real lean reading.
//! - **Startup / calibration status.** A 14Point7 Spartan 2 emits fixed values
//!   (13.33 and 16.67 AFR) while it warms up and calibrates, before it is
//!   measuring anything.
//! - **A dead or frozen channel.** Observed once in the same drive: exactly
//!   14.70 for 12.2 seconds while rpm and load moved underneath it.
//!
//! Blacklisting the values does not work, because at 0.1 AFR resolution 13.3
//! and 16.7 are also perfectly ordinary readings. In that same drive 13.3
//! occurred 588 times and 16.7 141 times as genuine measurements, spread across
//! the whole session at up to 5000 rpm. What separates them is **duration**:
//! those real readings never held longer than **0.46 s**, while the rail held
//! for tens of seconds. So the test is how long a value has stood still, not
//! what the value is.

/// Why a wideband sample cannot be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfrInvalid {
    /// Parked on a known status value (rail, or a controller's calibration
    /// output) for longer than a real reading ever holds.
    HeldStatusValue,
    /// Any value standing perfectly still for far longer than combustion
    /// scatter allows — a frozen or disconnected channel.
    Frozen,
}

impl AfrInvalid {
    pub fn label(&self) -> &'static str {
        match self {
            AfrInvalid::HeldStatusValue => "wideband not measuring (held at a status value)",
            AfrInvalid::Frozen => "wideband reading frozen",
        }
    }
}

/// How long a known status value may persist before the sample is refused.
/// Real readings that happen to land on one of these never held beyond 0.46 s
/// in the reference drive, so 0.75 s clears genuine data comfortably.
const STATUS_HOLD_MS: u64 = 750;

/// How long *any* unchanged value is tolerated before the channel is presumed
/// frozen. Steady idle can legitimately repeat a value for a second or two, so
/// this is deliberately well clear of that.
const FROZEN_HOLD_MS: u64 = 3_000;

/// Values a controller emits when it is not reporting a mixture. The rail is
/// supplied by the caller because it depends on the channel's scaling; the
/// others are 14Point7 Spartan calibration outputs.
const STATUS_VALUES: [f64; 2] = [13.33, 16.67];
const STATUS_TOLERANCE: f64 = 0.06;

/// Tracks how long the wideband has been sitting on the same reading.
#[derive(Debug, Default, Clone)]
pub struct AfrValidity {
    /// The current value and the timestamp it was first seen at.
    held: Option<(f64, u64)>,
}

impl AfrValidity {
    pub fn new() -> Self {
        Self::default()
    }

    /// Forget the current run — call when the stream reconnects or a new
    /// session starts, so a stale reading cannot carry across the gap.
    pub fn reset(&mut self) {
        self.held = None;
    }

    /// Feed one sample. Returns `None` when it is usable, or the reason it
    /// must be dropped.
    ///
    /// `rail_afr` is the channel's out-of-range value (19.7 for Speeduino's
    /// byte-scaled AFR); pass `f64::NAN` if the channel has none.
    pub fn check(&mut self, afr: f64, t_ms: u64, rail_afr: f64) -> Option<AfrInvalid> {
        let same = matches!(self.held, Some((v, _)) if (v - afr).abs() < f64::EPSILON);
        if !same {
            self.held = Some((afr, t_ms));
            return None;
        }

        let since = self
            .held
            .map(|(_, t0)| t_ms.saturating_sub(t0))
            .unwrap_or(0);

        let is_status = (!rail_afr.is_nan() && (afr - rail_afr).abs() < STATUS_TOLERANCE)
            || STATUS_VALUES
                .iter()
                .any(|v| (afr - v).abs() < STATUS_TOLERANCE);

        if is_status && since >= STATUS_HOLD_MS {
            return Some(AfrInvalid::HeldStatusValue);
        }
        if since >= FROZEN_HOLD_MS {
            return Some(AfrInvalid::Frozen);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 19.7 held for tens of seconds is the sensor out of range, not a lean
    /// mixture. 12.9 % of one drive's running samples looked like this.
    #[test]
    fn railed_reading_is_refused_once_it_persists() {
        let mut v = AfrValidity::new();
        assert_eq!(
            v.check(19.7, 0, 19.7),
            None,
            "first sample cannot be judged"
        );
        assert_eq!(
            v.check(19.7, 400, 19.7),
            None,
            "brief rail is still allowed"
        );
        assert_eq!(
            v.check(19.7, 1_000, 19.7),
            Some(AfrInvalid::HeldStatusValue)
        );
    }

    /// The Spartan 2's calibration outputs, held while it warms up.
    #[test]
    fn spartan_calibration_values_are_refused_when_held() {
        for value in [13.33, 16.67] {
            let mut v = AfrValidity::new();
            v.check(value, 0, 19.7);
            assert_eq!(
                v.check(value, 900, 19.7),
                Some(AfrInvalid::HeldStatusValue),
                "{value} held for 0.9 s is the controller, not a mixture"
            );
        }
    }

    /// The critical negative case: those same values occur as REAL readings —
    /// 588 samples of 13.3 and 141 of 16.7 in one drive, at up to 5000 rpm.
    /// They never held beyond 0.46 s, so a brief one must pass.
    #[test]
    fn genuine_readings_on_a_status_value_are_kept() {
        let mut v = AfrValidity::new();
        // 13.3 for ~0.46 s, the longest genuine run observed, then moving on.
        v.check(13.3, 0, 19.7);
        assert_eq!(v.check(13.3, 200, 19.7), None);
        assert_eq!(v.check(13.3, 460, 19.7), None, "0.46 s is real data");
        assert_eq!(v.check(13.4, 520, 19.7), None);
    }

    /// A channel stuck at an ordinary value is still broken — this one sat at
    /// exactly 14.70 for 12.2 s while rpm and load moved.
    #[test]
    fn frozen_channel_is_refused_even_at_a_plausible_value() {
        let mut v = AfrValidity::new();
        v.check(14.70, 0, 19.7);
        assert_eq!(v.check(14.70, 2_000, 19.7), None, "steady idle is allowed");
        assert_eq!(v.check(14.70, 3_500, 19.7), Some(AfrInvalid::Frozen));
    }

    /// Normal dithering never trips anything.
    #[test]
    fn dithering_reading_always_passes() {
        let mut v = AfrValidity::new();
        for (i, afr) in [14.6, 14.7, 14.6, 14.8, 14.7, 14.9].iter().enumerate() {
            assert_eq!(v.check(*afr, i as u64 * 60, 19.7), None);
        }
    }

    #[test]
    fn reset_forgets_the_current_run() {
        let mut v = AfrValidity::new();
        v.check(19.7, 0, 19.7);
        v.reset();
        assert_eq!(
            v.check(19.7, 10_000, 19.7),
            None,
            "after a reset the run starts again rather than judging across the gap"
        );
    }
}
