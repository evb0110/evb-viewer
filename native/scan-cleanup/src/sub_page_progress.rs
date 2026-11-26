//! Lock-free sub-page progress reporting for scan-cleanup workers.
//!
//! Long-running page operations (decode, background normalization, layout/mode
//! analysis, deskew, region rendering, and plane encoding) report their active
//! stage through this module without blocking or allocating:
//!
//! - On `wasm32-wasip1-threads` (`target_os = "wasi"`), Rayon worker threads
//!   store a single packed `u64` into an `AtomicU64`. The calling thread inside
//!   `wasm_threads::execute_on_pool` polls that cell on its 10 ms wake loop and
//!   relays changes through the `env.evb_progress` WASM import.
//! - On `wasm32-unknown-unknown`, the calling thread directly invokes
//!   `env.evb_progress` when the packed stage/counter tuple changes.
//! - On native targets (CLI and tests), an optional thread-local observer
//!   receives stage transitions synchronously on the worker thread.

use serde::{Deserialize, Serialize};
#[cfg(not(all(target_os = "wasi", feature = "wasm-exports")))]
use std::cell::Cell;
#[cfg(not(all(target_family = "wasm", feature = "wasm-exports")))]
use std::cell::RefCell;
#[cfg(all(target_os = "wasi", feature = "wasm-exports"))]
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) const SUB_PAGE_STAGE_DECODE: u32 = 1;
pub(crate) const SUB_PAGE_STAGE_BACKGROUND: u32 = 2;
pub(crate) const SUB_PAGE_STAGE_ANALYZE: u32 = 3;
pub(crate) const SUB_PAGE_STAGE_DESKEW: u32 = 4;
pub(crate) const SUB_PAGE_STAGE_RENDER: u32 = 5;
pub(crate) const SUB_PAGE_STAGE_ENCODE: u32 = 6;

const COUNTER_MASK: u32 = 0x00ff_ffff;

/// Fine-grained processing stage inside a single page's analysis or render.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum SubPageStage {
    Decode = SUB_PAGE_STAGE_DECODE,
    Background = SUB_PAGE_STAGE_BACKGROUND,
    Analyze = SUB_PAGE_STAGE_ANALYZE,
    Deskew = SUB_PAGE_STAGE_DESKEW,
    Render = SUB_PAGE_STAGE_RENDER,
    Encode = SUB_PAGE_STAGE_ENCODE,
}

pub(crate) fn pack_sub_page_progress(stage: SubPageStage, completed: u32, total: u32) -> u64 {
    ((stage as u64) << 48)
        | (u64::from(completed.min(COUNTER_MASK)) << 24)
        | u64::from(total.min(COUNTER_MASK))
}

#[cfg(any(test, all(target_os = "wasi", feature = "wasm-exports")))]
pub(crate) fn unpack_sub_page_progress(packed: u64) -> (u32, u32, u32) {
    let stage = (packed >> 48) as u32;
    let completed = ((packed >> 24) & u64::from(COUNTER_MASK)) as u32;
    let total = (packed & u64::from(COUNTER_MASK)) as u32;
    (stage, completed, total)
}

#[cfg(all(target_family = "wasm", feature = "wasm-exports"))]
#[link(wasm_import_module = "env")]
extern "C" {
    fn evb_progress(stage: u32, completed: u32, total: u32);
}

#[cfg(all(target_os = "wasi", feature = "wasm-exports"))]
static SUB_PAGE_PROGRESS: AtomicU64 = AtomicU64::new(0);

#[cfg(all(
    target_family = "wasm",
    target_os = "unknown",
    feature = "wasm-exports"
))]
thread_local! {
    static LAST_REPORTED_PROGRESS: Cell<u64> = const { Cell::new(0) };
}

#[cfg(not(all(target_family = "wasm", feature = "wasm-exports")))]
type NativeProgressCallback = dyn Fn(SubPageStage, u32, u32) + 'static;

#[cfg(not(all(target_family = "wasm", feature = "wasm-exports")))]
thread_local! {
    static NATIVE_LAST_REPORTED: Cell<u64> = const { Cell::new(0) };
    static NATIVE_OBSERVER: RefCell<Option<*const NativeProgressCallback>> = const { RefCell::new(None) };
}

/// Resets per-request sub-page progress deduplication before a WASM request runs.
#[cfg(all(target_family = "wasm", feature = "wasm-exports"))]
pub(crate) fn reset_sub_page_progress() {
    #[cfg(target_os = "wasi")]
    SUB_PAGE_PROGRESS.store(0, Ordering::Relaxed);
    #[cfg(target_os = "unknown")]
    LAST_REPORTED_PROGRESS.with(|cell| cell.set(0));
}

/// Polls the atomic progress cell on the calling thread of `wasm32-wasip1-threads`
/// and invokes `env.evb_progress` when the worker pool advanced to a new state.
#[cfg(all(target_os = "wasi", feature = "wasm-exports"))]
pub(crate) fn relay_sub_page_progress(last_reported: &mut u64) {
    let packed = SUB_PAGE_PROGRESS.load(Ordering::Relaxed);
    if packed == 0 || packed == *last_reported {
        return;
    }
    *last_reported = packed;
    let (stage, completed, total) = unpack_sub_page_progress(packed);
    // SAFETY: `env.evb_progress` takes three plain `u32` values and returns nothing.
    unsafe { evb_progress(stage, completed, total) };
}

/// Reports entry into a sub-page stage without a sub-unit counter.
pub(crate) fn report_sub_page_stage(stage: SubPageStage) {
    report_sub_page_progress(stage, 0, 0);
}

/// Reports sub-page stage progress (`stage`, `completed`, `total`).
pub(crate) fn report_sub_page_progress(stage: SubPageStage, completed: u32, total: u32) {
    let packed = pack_sub_page_progress(stage, completed, total);
    #[cfg(all(target_os = "wasi", feature = "wasm-exports"))]
    {
        SUB_PAGE_PROGRESS.store(packed, Ordering::Relaxed);
    }
    #[cfg(all(
        target_family = "wasm",
        target_os = "unknown",
        feature = "wasm-exports"
    ))]
    {
        let changed = LAST_REPORTED_PROGRESS.with(|cell| {
            if cell.get() == packed {
                false
            } else {
                cell.set(packed);
                true
            }
        });
        if changed {
            // SAFETY: `env.evb_progress` takes three plain `u32` values and returns nothing.
            unsafe {
                evb_progress(
                    stage as u32,
                    completed.min(COUNTER_MASK),
                    total.min(COUNTER_MASK),
                );
            }
        }
    }
    #[cfg(not(all(target_family = "wasm", feature = "wasm-exports")))]
    {
        let changed = NATIVE_LAST_REPORTED.with(|cell| {
            if cell.get() == packed {
                false
            } else {
                cell.set(packed);
                true
            }
        });
        if !changed {
            return;
        }
        NATIVE_OBSERVER.with(|slot| {
            if let Some(callback) = *slot.borrow() {
                // SAFETY: `with_sub_page_progress_observer` restores the prior slot
                // via an RAII guard before the borrowed closure leaves scope.
                unsafe { (*callback)(stage, completed.min(COUNTER_MASK), total.min(COUNTER_MASK)) };
            }
        });
    }
}

/// Runs `work` with a thread-local sub-page progress observer on native targets.
/// On WASM targets, progress is emitted through `env.evb_progress`, so this
/// runs `work` directly.
#[cfg(all(target_family = "wasm", feature = "wasm-exports"))]
pub(crate) fn with_sub_page_progress_observer<R>(
    _observer: &(impl Fn(SubPageStage, u32, u32) + ?Sized),
    work: impl FnOnce() -> R,
) -> R {
    work()
}

/// Runs `work` with a thread-local sub-page progress observer on native targets.
#[cfg(not(all(target_family = "wasm", feature = "wasm-exports")))]
pub(crate) fn with_sub_page_progress_observer<R>(
    observer: &(impl Fn(SubPageStage, u32, u32) + ?Sized),
    work: impl FnOnce() -> R,
) -> R {
    struct Guard {
        previous_observer: Option<*const NativeProgressCallback>,
        previous_last: u64,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            NATIVE_OBSERVER.with(|slot| *slot.borrow_mut() = self.previous_observer);
            NATIVE_LAST_REPORTED.with(|cell| cell.set(self.previous_last));
        }
    }

    let closure = |stage, completed, total| {
        observer(stage, completed, total);
    };
    let trait_object: &(dyn Fn(SubPageStage, u32, u32) + '_) = &closure;
    // SAFETY: erased lifetime is strictly bounded by `Guard`, which clears the
    // thread-local slot on normal return or unwind before `closure` drops.
    let raw_observer: *const NativeProgressCallback = unsafe {
        std::mem::transmute::<
            *const (dyn Fn(SubPageStage, u32, u32) + '_),
            *const NativeProgressCallback,
        >(trait_object)
    };
    let previous_observer = NATIVE_OBSERVER.with(|slot| slot.borrow_mut().replace(raw_observer));
    let previous_last = NATIVE_LAST_REPORTED.with(|cell| cell.replace(0));
    let _guard = Guard {
        previous_observer,
        previous_last,
    };
    work()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn packs_and_unpacks_stage_and_counters() {
        let packed = pack_sub_page_progress(SubPageStage::Render, 12, 34);
        assert_eq!(
            unpack_sub_page_progress(packed),
            (SUB_PAGE_STAGE_RENDER, 12, 34)
        );
        let clamped = pack_sub_page_progress(SubPageStage::Encode, u32::MAX, u32::MAX);
        assert_eq!(
            unpack_sub_page_progress(clamped),
            (SUB_PAGE_STAGE_ENCODE, COUNTER_MASK, COUNTER_MASK)
        );
    }

    #[test]
    fn native_observer_receives_deduplicated_stage_transitions() {
        let observed = RefCell::new(Vec::new());
        with_sub_page_progress_observer(
            &|stage, completed, total| observed.borrow_mut().push((stage, completed, total)),
            || {
                report_sub_page_stage(SubPageStage::Decode);
                report_sub_page_stage(SubPageStage::Decode);
                report_sub_page_stage(SubPageStage::Background);
                report_sub_page_progress(SubPageStage::Render, 1, 2);
                report_sub_page_progress(SubPageStage::Render, 2, 2);
            },
        );
        assert_eq!(
            *observed.borrow(),
            vec![
                (SubPageStage::Decode, 0, 0),
                (SubPageStage::Background, 0, 0),
                (SubPageStage::Render, 1, 2),
                (SubPageStage::Render, 2, 2),
            ]
        );
    }
}
