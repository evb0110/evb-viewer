#![no_main]
use evb_raster_io::{read_png_passthrough, PassthroughLimits};
use libfuzzer_sys::fuzz_target;
fuzz_target!(|data: &[u8]| {
    let _ = read_png_passthrough(
        data,
        PassthroughLimits {
            max_pixels: 80_000_000,
            max_dimension: u32::MAX,
            max_icc_profile_bytes: 16 * 1024 * 1024,
        },
    );
});
