//! The threads build's pool and its fault cell.
//!
//! The host creates one shared memory, instantiates the module on it, calls
//! `_initialize` once and then `evb_scan_cleanup_start_threads`. Each Rayon
//! worker is a host thread: `wasi.thread-spawn` asks the host for one, and the
//! host runs a second instance of the module on the same memory that enters
//! through `wasi_thread_start` (never `_initialize`).
//!
//! A host thread can die without Rust noticing: a trap (a panic, which aborts
//! on this target, running out of memory, overflowing its stack) ends its
//! `wasi_thread_start` call with an exception in the host, and whatever that
//! thread held or owed stays held or owed. A request blocked inside Rayon would
//! then wait forever, so the calling thread never enters Rayon. It hands the
//! request to the pool and waits in short slices, reading the fault cell the
//! host sets when one of its threads throws.

use super::execute;
use evb_native_support::{NativeErrorCode, NativeErrorEnvelope};
use std::cell::UnsafeCell;
use std::slice;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::{self, Thread};
use std::time::Duration;

/// `evb_scan_cleanup_run`'s result when a host thread has trapped.
pub(super) const ENGINE_FAULT: i32 = -2;

/// Rayon's workers get the stack desktop's workers get by default.
const WORKER_STACK_BYTES: usize = 2 * 1024 * 1024;

/// How long the calling thread sleeps between looks at the request and the
/// fault cell.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Set to 1 by the host when a thread's `wasi_thread_start` throws; never
/// cleared.
static THREAD_FAULT: AtomicU32 = AtomicU32::new(0);

/// Every request's pool. Not Rayon's global pool: building that one waits
/// until each worker runs, and a browser starts a worker's thread only after
/// the thread that created it returns to its event loop.
static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();

/// Builds the Rayon pool every request runs on: exactly `threads` workers,
/// each a host thread with a 2 MiB stack. Call it once, after `_initialize`
/// and before the first request. It returns once the host has accepted every
/// thread, without waiting for them to run; a thread that never comes up
/// shows up as a fault in `evb_scan_cleanup_run`. Returns the worker count, or
/// -1 when the pool could not be built (no threads asked for, the host refused
/// a thread, or a pool already exists).
#[no_mangle]
pub extern "C" fn evb_scan_cleanup_start_threads(threads: usize) -> i32 {
    let Ok(count) = i32::try_from(threads) else {
        return -1;
    };
    if count == 0 || POOL.get().is_some() {
        return -1;
    }
    let built = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .stack_size(WORKER_STACK_BYTES)
        .build();
    match built.map(|pool| POOL.set(pool)) {
        Ok(Ok(())) => count,
        _ => -1,
    }
}

/// The address of the fault cell, one `u32` in linear memory. A host thread
/// whose `wasi_thread_start` call throws stores 1 there (an atomic store, then
/// a notify). The engine never clears it: after a fault every request returns
/// -2 and the host drops the instance.
#[no_mangle]
pub extern "C" fn evb_scan_cleanup_thread_fault_ptr() -> *const u32 {
    THREAD_FAULT.as_ptr().cast_const()
}

pub(super) fn faulted() -> bool {
    THREAD_FAULT.load(Ordering::Acquire) != 0
}

type Outcome = Result<Vec<u8>, NativeErrorEnvelope>;

/// One request handed to the pool, prepared before its job starts: the slot
/// its job fills, the flag it raises after, and the calling thread it wakes.
struct PendingRequest {
    outcome: UnsafeCell<Option<Outcome>>,
    done: AtomicBool,
    caller: Thread,
}

// SAFETY: only the job writes `outcome`, once, before it raises `done` with
// release ordering; the caller reads it only after seeing `done` with acquire
// ordering, and the job never touches it again.
unsafe impl Sync for PendingRequest {}

/// Runs a request on the pool. `None` means a host thread trapped before,
/// during or right after it, and the instance must be dropped.
///
/// While it waits, the calling thread takes no lock and allocates nothing: a
/// thread that died holding the allocator's lock or one of the engine's own
/// cannot stop it from noticing the fault. On a fault it also frees nothing,
/// leaking what it holds, because a free takes the allocator's lock.
pub(super) fn execute_on_pool(request: &[u8]) -> Option<Outcome> {
    let Some(pool) = POOL.get() else {
        return Some(Err(NativeErrorEnvelope {
            code: NativeErrorCode::InvalidRequest,
            message: "Scan-cleanup WASM threads were not started; call \
                      evb_scan_cleanup_start_threads first"
                .to_string(),
        }));
    };
    // SAFETY: the pool reads these bytes from the request allocation, which
    // the host keeps alive until this call returns. The call returns with an
    // outcome only after the job has finished with the bytes. It returns early
    // only with a fault, and after a fault the host drops the whole instance
    // without calling into it again, not even to free the request, so the
    // bytes are never reused while a stuck job could still read them.
    let request: &'static [u8] = unsafe { slice::from_raw_parts(request.as_ptr(), request.len()) };
    let pending = Arc::new(PendingRequest {
        outcome: UnsafeCell::new(None),
        done: AtomicBool::new(false),
        caller: thread::current(),
    });
    let job = Arc::clone(&pending);
    crate::sub_page_progress::reset_sub_page_progress();
    let mut last_progress = 0u64;
    pool.spawn(move || {
        let outcome = execute(request);
        // SAFETY: see `PendingRequest`; the caller does not read the slot
        // before `done` is raised.
        unsafe { *job.outcome.get() = Some(outcome) };
        job.done.store(true, Ordering::Release);
        job.caller.unpark();
    });
    loop {
        if faulted() {
            std::mem::forget(pending);
            return None;
        }
        crate::sub_page_progress::relay_sub_page_progress(&mut last_progress);
        if pending.done.load(Ordering::Acquire) {
            break;
        }
        thread::park_timeout(POLL_INTERVAL);
    }
    // SAFETY: `done` is raised, so the job has written the slot for good.
    let outcome = unsafe { (*pending.outcome.get()).take() };
    if faulted() {
        std::mem::forget(outcome);
        std::mem::forget(pending);
        return None;
    }
    crate::sub_page_progress::relay_sub_page_progress(&mut last_progress);
    outcome
}
