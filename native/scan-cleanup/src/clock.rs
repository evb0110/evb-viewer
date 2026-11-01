//! Monotonic time for stage timings.
//!
//! Native builds use `std::time::Instant` itself. `wasm32-unknown-unknown` has
//! no clock (`Instant::now` traps there), so the browser engine imports the
//! host's monotonic millisecond clock, `performance.now()`, as `env.evb_now_ms`.
//! Timings only feed diagnostics; no cleanup decision reads them.

#[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
pub(crate) use std::time::Instant;

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
pub(crate) use host::Instant;

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
mod host {
    use std::time::Duration;

    #[link(wasm_import_module = "env")]
    extern "C" {
        fn evb_now_ms() -> f64;
    }

    fn now_ms() -> f64 {
        // SAFETY: the import takes no arguments and returns a plain number.
        unsafe { evb_now_ms() }
    }

    #[derive(Clone, Copy, Debug)]
    pub(crate) struct Instant(f64);

    impl Instant {
        pub(crate) fn now() -> Self {
            Self(now_ms())
        }

        pub(crate) fn elapsed(&self) -> Duration {
            let elapsed_ms = now_ms() - self.0;
            // A host that returns a non-finite or earlier value yields zero,
            // the same as a native clock that did not advance.
            if elapsed_ms.is_finite() && elapsed_ms > 0.0 {
                Duration::from_secs_f64(elapsed_ms / 1_000.0)
            } else {
                Duration::ZERO
            }
        }
    }
}
