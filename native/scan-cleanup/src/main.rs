use std::sync::atomic::{AtomicBool, Ordering};

static SIGTERM_CANCELED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn handle_sigterm(_: libc::c_int) {
    SIGTERM_CANCELED.store(true, Ordering::Release);
}

#[cfg(unix)]
fn install_sigterm_handler() {
    // The handler only performs an atomic store, which is safe to run from a
    // POSIX signal context. The process remains alive long enough for the
    // native transaction to report cancellation and roll back its outputs.
    unsafe {
        libc::signal(libc::SIGTERM, handle_sigterm as libc::sighandler_t);
    }
}

#[cfg(not(unix))]
fn install_sigterm_handler() {}

fn main() {
    install_sigterm_handler();
    evb_native_support::run_native_cli(
        evb_native_support::generated_native_tool_protocols::SCAN_CLEANUP,
        env!("CARGO_PKG_VERSION"),
        std::env::args().skip(1),
        |args| {
            evb_scan_cleanup::adapters::batch_cli::run_with_cancellation(args, &SIGTERM_CANCELED)
        },
    );
}
