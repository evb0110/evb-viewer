//! The gray-only decoders must be a drop-in replacement for the gray plane of
//! the full decoders, and must not allocate the colour plane they replace.
use evb_raster_io::{
    decode_png, decode_png_gray, decode_ppm, decode_ppm_gray, encode_png, DecodeLimits, PixelBuffer,
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    fs,
};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
const DECODE: DecodeLimits = DecodeLimits {
    max_pixels: 1_000_000,
    max_dimension: 1_000,
    max_compressed_bytes: 1024 * 1024,
};
const WIDTH: usize = 200;
const HEIGHT: usize = 180;
const COLOUR_PLANE_BYTES: usize = WIDTH * HEIGHT * 3;

#[test]
fn png_gray_only_decoding_matches_the_full_decoder_on_every_fixture() {
    let mut checked = 0;
    for entry in fs::read_dir(FIXTURES).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "png") {
            continue;
        }
        let bytes = fs::read(&path).unwrap();
        let label = path.display();
        match decode_png(bytes.as_slice(), DECODE) {
            Ok(full) => assert_eq!(
                decode_png_gray(bytes.as_slice(), DECODE).unwrap(),
                full.gray,
                "gray plane diverged for {label}"
            ),
            Err(error) => assert_eq!(
                decode_png_gray(bytes.as_slice(), DECODE)
                    .unwrap_err()
                    .to_string(),
                error.to_string(),
                "error diverged for {label}"
            ),
        }
        checked += 1;
    }
    assert!(checked >= 15, "expected the PNG fixture set, saw {checked}");
}

#[test]
fn png_gray_only_decoding_matches_the_full_decoder_on_generated_pixels() {
    for (width, height) in [(1, 1), (1, 37), (37, 1), (WIDTH, HEIGHT)] {
        let pixels = pseudo_random(width * height * 3);
        let png = encode_png(PixelBuffer::Rgb {
            width,
            height,
            stride: width * 3,
            data: &pixels,
        })
        .unwrap();
        assert_eq!(
            decode_png_gray(png.as_slice(), DECODE).unwrap(),
            decode_png(png.as_slice(), DECODE).unwrap().gray,
            "gray plane diverged for {width}x{height} RGB"
        );

        let gray_pixels = pseudo_random(width * height);
        let gray_png = encode_png(PixelBuffer::Gray {
            width,
            height,
            stride: width,
            data: &gray_pixels,
        })
        .unwrap();
        assert_eq!(
            decode_png_gray(gray_png.as_slice(), DECODE).unwrap(),
            decode_png(gray_png.as_slice(), DECODE).unwrap().gray,
            "gray plane diverged for {width}x{height} gray"
        );
    }
}

#[test]
fn ppm_gray_only_decoding_matches_the_full_decoder_including_scaled_max_values() {
    let cases: &[(&str, Vec<u8>)] = &[
        ("P6\n1 1\n255\n", vec![10, 20, 30]),
        ("P6\n2 2\n255\n", pseudo_random(12)),
        ("P6\n3 1\n15\n", pseudo_random(9)),
        ("P6\n1 3\n1\n", vec![1, 0, 1, 0, 1, 1, 0, 0, 0]),
        ("P6\n5 4\n7\n", pseudo_random(60)),
        (
            "P6 # comment\n# another\n 4\t3 # trailing\n255\n",
            pseudo_random(36),
        ),
        ("P6\n200 180\n255\n", pseudo_random(COLOUR_PLANE_BYTES)),
        ("P6\n200 180\n99\n", pseudo_random(COLOUR_PLANE_BYTES)),
    ];
    for (header, payload) in cases {
        let bytes = p6(header, payload);
        assert_eq!(
            decode_ppm_gray(bytes.as_slice(), DECODE).unwrap(),
            decode_ppm(bytes.as_slice(), DECODE).unwrap().gray,
            "gray plane diverged for {header:?}"
        );
    }
}

#[test]
fn ppm_gray_only_decoding_rejects_exactly_what_the_full_decoder_rejects() {
    let cases: &[(&str, Vec<u8>)] = &[
        ("P5\n1 1\n255\n", vec![10]),
        ("P6\n1 1\n255\n", vec![10, 20]),
        ("P6\n1 1\n255\n", vec![10, 20, 30, 40]),
        ("P6\n1 1\n0\n", vec![10, 20, 30]),
        ("P6\n1 1\n256\n", vec![10, 20, 30]),
        ("P6\n0 1\n255\n", Vec::new()),
        ("P6\n2000 2\n255\n", Vec::new()),
        ("P6\n900 900\n255\n", Vec::new()),
        ("P6\n1 1\n", Vec::new()),
    ];
    for (header, payload) in cases {
        let bytes = p6(header, payload);
        let full = decode_ppm(bytes.as_slice(), DECODE)
            .unwrap_err()
            .to_string();
        assert_eq!(
            decode_ppm_gray(bytes.as_slice(), DECODE)
                .unwrap_err()
                .to_string(),
            full,
            "error diverged for {header:?}"
        );
    }
}

#[test]
fn png_gray_only_decoding_never_allocates_the_discarded_colour_plane() {
    let pixels = pseudo_random(COLOUR_PLANE_BYTES);
    let png = encode_png(PixelBuffer::Rgb {
        width: WIDTH,
        height: HEIGHT,
        stride: WIDTH * 3,
        data: &pixels,
    })
    .unwrap();

    let full = measure(|| {
        decode_png(png.as_slice(), DECODE).unwrap();
    });
    let gray = measure(|| {
        decode_png_gray(png.as_slice(), DECODE).unwrap();
    });

    assert_colour_plane_is_not_allocated(full, gray);
}

#[test]
fn ppm_gray_only_decoding_never_allocates_the_discarded_colour_plane() {
    let ppm = p6("P6\n200 180\n255\n", &pseudo_random(COLOUR_PLANE_BYTES));

    let full = measure(|| {
        decode_ppm(ppm.as_slice(), DECODE).unwrap();
    });
    let gray = measure(|| {
        decode_ppm_gray(ppm.as_slice(), DECODE).unwrap();
    });

    assert_colour_plane_is_not_allocated(full, gray);
}

#[test]
fn ordinary_png_decoding_streams_rows_instead_of_a_filtered_plane() {
    // Smooth pixels compress well, so the request is dominated by decode data
    // rather than by the compressed stream itself.
    let pixels: Vec<u8> = (0..COLOUR_PLANE_BYTES)
        .map(|index| (index / 3 % WIDTH) as u8)
        .collect();
    let png = encode_png(PixelBuffer::Rgb {
        width: WIDTH,
        height: HEIGHT,
        stride: WIDTH * 3,
        data: &pixels,
    })
    .unwrap();
    let gray_plane = (WIDTH * HEIGHT) as u64;
    let filtered_plane = ((WIDTH * 3 + 1) * HEIGHT) as u64;

    let requested = measure(|| {
        decode_png_gray(png.as_slice(), DECODE).unwrap();
    });

    assert!(
        requested < gray_plane + filtered_plane,
        "the gray decode requested {requested} bytes; the output plane is {gray_plane} \
         bytes and a whole filtered plane would add {filtered_plane}"
    );
}

fn assert_colour_plane_is_not_allocated(full: u64, gray: u64) {
    assert_eq!(
        full,
        gray + COLOUR_PLANE_BYTES as u64,
        "the gray decode should request exactly the colour plane less than the full decode: \
         full {full} bytes, gray {gray} bytes"
    );
}

fn p6(header: &str, payload: &[u8]) -> Vec<u8> {
    let mut bytes = header.as_bytes().to_vec();
    bytes.extend_from_slice(payload);
    bytes
}

fn pseudo_random(len: usize) -> Vec<u8> {
    let mut state = 0x4772_6179_5f4f_4e4c_u64;
    (0..len)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) as u8
        })
        .collect()
}

/// Heap bytes one decode asks for, counted on the calling thread only so tests
/// running in parallel cannot contaminate each other.
fn measure(body: impl FnOnce()) -> u64 {
    REQUESTED.set(0);
    ARMED.set(true);
    body();
    ARMED.set(false);
    REQUESTED.get()
}

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    static REQUESTED: Cell<u64> = const { Cell::new(0) };
}

struct CountingAllocator;

impl CountingAllocator {
    fn record_alloc(size: usize) {
        if ARMED.try_with(Cell::get).unwrap_or(false) {
            let _ = REQUESTED.try_with(|total| total.set(total.get() + size as u64));
        }
    }
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        Self::record_alloc(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        Self::record_alloc(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        Self::record_alloc(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;
