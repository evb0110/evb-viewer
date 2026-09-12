use crc32fast::Hasher;
use evb_raster_io::{
    decode_png, decode_png_composited_rgb, encode_png, encode_png_fast, read_png_dimensions,
    read_png_metadata, read_png_passthrough, write_png_with_dpi, DecodeLimits, PassthroughLimits,
    PixelBuffer, PngColorType, PngDensity, RasterError,
};
use flate2::{write::ZlibEncoder, Compression};
use std::io::Write;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
const PASSTHROUGH: PassthroughLimits = PassthroughLimits {
    max_pixels: 1_000_000,
    max_dimension: 1_000,
    max_icc_profile_bytes: 1024 * 1024,
};
const DECODE: DecodeLimits = DecodeLimits {
    max_pixels: 1_000_000,
    max_dimension: 1_000,
    max_compressed_bytes: 1024 * 1024,
};
const RGB: &[u8] = &[
    10, 20, 30, 40, 50, 60, 70, 80, 90, 15, 25, 35, 45, 55, 65, 75, 85, 95,
];

#[test]
fn passthrough_preserves_compressed_data_and_metadata_without_decoding() {
    let multi = fixture("multi-idat.png");
    let png = read_png_passthrough(multi.as_slice(), PASSTHROUGH).unwrap();
    assert_eq!(
        (png.width, png.height, png.color_type),
        (3, 2, PngColorType::Rgb8)
    );
    assert_eq!(png.idat, source_idat(&multi));
    assert_eq!(
        read_png_passthrough(fixture("phys.png").as_slice(), PASSTHROUGH)
            .unwrap()
            .density,
        Some(PngDensity {
            x_dpi: 300,
            y_dpi: 300
        })
    );
    assert_eq!(
        read_png_passthrough(fixture("iccp.png").as_slice(), PASSTHROUGH)
            .unwrap()
            .icc_profile
            .unwrap(),
        fixture("iccp-profile.bin")
    );

    let corrupt = fixture("corrupt-crc.png");
    assert!(read_png_passthrough(corrupt.as_slice(), PASSTHROUGH).is_err());
    assert!(decode_png(corrupt.as_slice(), DECODE).is_err());
    assert_eq!(
        read_png_passthrough(fixture("rgba8.png").as_slice(), PASSTHROUGH)
            .unwrap()
            .color_type,
        PngColorType::Rgba8
    );
}

#[test]
fn metadata_reader_preserves_metadata_without_retaining_idat_bytes() {
    let metadata = read_png_metadata(fixture("rgba8.png").as_slice(), PASSTHROUGH).unwrap();
    assert_eq!(
        (metadata.width, metadata.height, metadata.color_type),
        (2, 2, PngColorType::Rgba8)
    );
    assert_eq!(
        read_png_metadata(fixture("phys.png").as_slice(), PASSTHROUGH)
            .unwrap()
            .density,
        Some(PngDensity {
            x_dpi: 300,
            y_dpi: 300
        })
    );
    assert_eq!(
        read_png_metadata(fixture("iccp.png").as_slice(), PASSTHROUGH)
            .unwrap()
            .icc_profile
            .unwrap(),
        fixture("iccp-profile.bin")
    );
}

#[test]
fn metadata_and_passthrough_reject_oversized_dimensions() {
    let oversized = fixture("oversized-dimensions.png");
    let limits = PassthroughLimits {
        max_pixels: u64::MAX,
        ..PASSTHROUGH
    };

    assert!(matches!(
        read_png_metadata(oversized.as_slice(), limits),
        Err(RasterError::TooLarge(_))
    ));
    assert!(matches!(
        read_png_passthrough(oversized.as_slice(), limits),
        Err(RasterError::TooLarge(_))
    ));
}

#[test]
fn composites_alpha_png_onto_white_and_preserves_requested_dpi() {
    let rgba = decode_png_composited_rgb(fixture("rgba8.png").as_slice(), DECODE).unwrap();
    assert_eq!(
        rgba.data(),
        &[255, 255, 255, 40, 50, 60, 182, 186, 190, 190, 181, 186,]
    );

    let encoded = write_png_with_dpi(
        Vec::new(),
        PixelBuffer::Rgb {
            width: 2,
            height: 1,
            stride: 6,
            data: &[1, 2, 3, 4, 5, 6],
        },
        300,
    )
    .unwrap();
    assert_eq!(
        read_png_passthrough(encoded.as_slice(), PASSTHROUGH)
            .unwrap()
            .density,
        Some(PngDensity {
            x_dpi: 300,
            y_dpi: 300
        })
    );
}

#[test]
fn passthrough_rejects_bad_crc_on_every_trusted_chunk_kind() {
    for (fixture_name, chunk_kind) in [
        ("rgb8.png", *b"IHDR"),
        ("multi-idat.png", *b"IDAT"),
        ("phys.png", *b"pHYs"),
        ("rgb8.png", *b"IEND"),
    ] {
        let corrupt = corrupt_chunk_crc(fixture(fixture_name), chunk_kind);
        let error = read_png_passthrough(corrupt.as_slice(), PASSTHROUGH).unwrap_err();
        assert!(
            error.to_string().contains("CRC mismatch"),
            "{fixture_name} {}: {error}",
            String::from_utf8_lossy(&chunk_kind)
        );
    }
}

#[test]
fn decode_matches_scan_cleanup_luma_alpha_and_filter_behavior() {
    let gray = decode_png(fixture("gray8.png").as_slice(), DECODE).unwrap();
    assert_eq!(gray.gray.data(), &[0, 30, 255, 80, 120, 200]);
    assert_eq!(
        gray.rgb.data(),
        &[0, 0, 0, 30, 30, 30, 255, 255, 255, 80, 80, 80, 120, 120, 120, 200, 200, 200]
    );
    let rgb = decode_png(fixture("rgb8.png").as_slice(), DECODE).unwrap();
    assert_eq!(rgb.gray.data(), &[18, 48, 78, 23, 53, 83]);
    assert_eq!(rgb.rgb.data(), RGB);
    let gray_alpha = decode_png(fixture("gray-alpha8.png").as_slice(), DECODE).unwrap();
    assert_eq!(gray_alpha.gray.data(), &[12, 200, 64, 128]);
    assert_eq!(
        gray_alpha.rgb.data(),
        &[12, 12, 12, 200, 200, 200, 64, 64, 64, 128, 128, 128]
    );
    let rgba = decode_png(fixture("rgba8.png").as_slice(), DECODE).unwrap();
    assert_eq!(rgba.gray.data(), &[68, 48, 78, 117]);
    assert_eq!(
        rgba.rgb.data(),
        &[200, 10, 20, 40, 50, 60, 70, 80, 90, 128, 110, 120]
    );
    for filter in 0..=4 {
        assert!(read_png_passthrough(
            fixture(&format!("filter-{filter}.png")).as_slice(),
            PASSTHROUGH
        )
        .is_ok());
        let decoded =
            decode_png(fixture(&format!("filter-{filter}.png")).as_slice(), DECODE).unwrap();
        assert_eq!(decoded.rgb.data(), RGB, "filter {filter}");
        assert_eq!(decoded.gray.data(), &[18, 48, 78, 23, 53, 83]);
    }
}

#[test]
fn decodes_standard_png_variants_into_the_existing_eight_bit_contract() {
    let indexed = encode_variant(
        3,
        1,
        png::ColorType::Indexed,
        png::BitDepth::Two,
        Some(&[10, 20, 30, 200, 210, 220, 40, 50, 60]),
        Some(&[255, 0, 255]),
        &[0b0001_1000],
    );
    assert_eq!(
        decode_png(&indexed[..], DECODE).unwrap().rgb.data(),
        &[10, 20, 30, 200, 210, 220, 40, 50, 60]
    );
    assert_eq!(
        decode_png_composited_rgb(&indexed[..], DECODE)
            .unwrap()
            .data(),
        &[10, 20, 30, 255, 255, 255, 40, 50, 60]
    );

    let gray = encode_variant(
        5,
        1,
        png::ColorType::Grayscale,
        png::BitDepth::One,
        None,
        None,
        &[0b0111_0000],
    );
    assert_eq!(
        decode_png(&gray[..], DECODE).unwrap().gray.data(),
        &[0, 255, 255, 255, 0]
    );

    let rgb16 = encode_variant(
        2,
        1,
        png::ColorType::Rgb,
        png::BitDepth::Sixteen,
        None,
        None,
        &[
            0x12, 0x34, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd,
        ],
    );
    assert_eq!(
        decode_png(&rgb16[..], DECODE).unwrap().rgb.data(),
        &[0x12, 0xab, 0xef, 0x23, 0x67, 0xab]
    );

    let adam7_pixels = (0..60)
        .map(|value| ((value * 7 + 10) % 251) as u8)
        .collect::<Vec<_>>();
    let adam7 = make_adam7_png(5, 4, &adam7_pixels);
    assert_eq!(
        decode_png(&adam7[..], DECODE).unwrap().rgb.data(),
        adam7_pixels
    );
}

#[test]
fn encoder_is_deterministic_and_round_trips() {
    let gray = [0, 30, 255, 80, 120, 200];
    let gray_pixels = PixelBuffer::Gray {
        width: 3,
        height: 2,
        stride: 3,
        data: &gray,
    };
    assert_eq!(encode_png(gray_pixels).unwrap(), fixture("gray8.png"));
    let encoded = encode_png(PixelBuffer::Rgb {
        width: 3,
        height: 2,
        stride: 9,
        data: RGB,
    })
    .unwrap();
    assert_eq!(encoded, fixture("rgb8.png"));
    assert_eq!(
        decode_png(encoded.as_slice(), DECODE).unwrap().rgb.data(),
        RGB
    );
}

#[test]
fn fast_encoder_is_lossless_for_managed_intermediates() {
    for pixels in [
        PixelBuffer::Gray {
            width: 6,
            height: 1,
            stride: 6,
            data: &[0, 30, 255, 80, 120, 200],
        },
        PixelBuffer::Rgb {
            width: 3,
            height: 2,
            stride: 9,
            data: RGB,
        },
    ] {
        let expected = match pixels {
            PixelBuffer::Gray { data, .. } => data
                .iter()
                .flat_map(|value| [*value; 3])
                .collect::<Vec<_>>(),
            PixelBuffer::Rgb { data, .. } => data.to_vec(),
        };
        let encoded = encode_png_fast(pixels).unwrap();
        assert_eq!(
            decode_png(encoded.as_slice(), DECODE).unwrap().rgb.data(),
            expected
        );
    }
}

#[test]
fn admission_precedes_allocation_and_inflate() {
    let oversized = fixture("oversized-dimensions.png");
    let error = decode_png(oversized.as_slice(), DECODE).unwrap_err();
    assert!(matches!(
        error,
        RasterError::TooLarge(message) if message.contains("100000x100000")
    ));
    assert_eq!(
        read_png_dimensions(fixture("rgba8.png").as_slice(), DECODE).unwrap(),
        (2, 2)
    );
    assert!(read_png_dimensions(fixture("corrupt-crc.png").as_slice(), DECODE).is_err());

    let compressed_error = decode_png(
        fixture("rgb8.png").as_slice(),
        DecodeLimits {
            max_compressed_bytes: 1,
            ..DECODE
        },
    )
    .unwrap_err();
    assert!(compressed_error
        .to_string()
        .contains("compressed image data exceeds"));
    assert!(
        read_png_passthrough(fixture("high-compression.png").as_slice(), PASSTHROUGH)
            .unwrap_err()
            .to_string()
            .contains("longer than expected")
    );
}

#[test]
fn rejects_truncation_and_short_or_long_inflated_payloads() {
    for name in [
        "truncated-chunk.png",
        "missing-iend.png",
        "short-idat.png",
        "long-idat.png",
    ] {
        let bytes = fixture(name);
        assert!(
            read_png_passthrough(bytes.as_slice(), PASSTHROUGH).is_err(),
            "{name}"
        );
        assert!(decode_png(bytes.as_slice(), DECODE).is_err(), "{name}");
    }
}

#[test]
fn passthrough_rejects_invalid_scanline_filters_across_stream_boundaries() {
    for (color_type, row_bytes_list) in [
        (PngColorType::Gray8, [8191usize, 8192, 8193]),
        (PngColorType::Rgb8, [8190usize, 8193, 8196]),
    ] {
        for row_bytes in row_bytes_list {
            let mut rows = vec![0; (row_bytes + 1) * 2];
            rows[row_bytes + 1] = 5;
            let png = make_png(
                row_bytes / color_type.channels_for_test(),
                2,
                color_type,
                &rows,
                None,
                true,
            );
            assert!(read_png_passthrough(&png[..], PASSTHROUGH).is_err());
            assert!(decode_png(&png[..], DECODE).is_err());
        }
    }
}

#[test]
fn phys_preserves_horizontal_and_vertical_density() {
    let png = make_png(
        3,
        2,
        PngColorType::Rgb8,
        &[0; 20],
        Some((11811, 23622)),
        true,
    );
    assert_eq!(
        read_png_metadata(&png[..], PASSTHROUGH).unwrap().density,
        Some(PngDensity {
            x_dpi: 300,
            y_dpi: 600
        })
    );
}

#[test]
fn passthrough_rejects_invalid_filter_in_first_middle_and_last_rows() {
    for color_type in [PngColorType::Gray8, PngColorType::Rgb8] {
        let channels = color_type.channels_for_test();
        let width = 3;
        let row_length = width * channels + 1;
        for bad_row in 0..3 {
            let mut rows = vec![0; row_length * 3];
            rows[bad_row * row_length] = 5;
            let png = make_png(width, 3, color_type, &rows, None, true);
            assert!(read_png_passthrough(&png[..], PASSTHROUGH).is_err());
        }
    }
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}/{name}")).unwrap()
}

fn encode_variant(
    width: u32,
    height: u32,
    color: png::ColorType,
    depth: png::BitDepth,
    palette: Option<&[u8]>,
    trns: Option<&[u8]>,
    data: &[u8],
) -> Vec<u8> {
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(color);
        encoder.set_depth(depth);
        if let Some(palette) = palette {
            encoder.set_palette(palette);
        }
        if let Some(trns) = trns {
            encoder.set_trns(trns);
        }
        encoder
            .write_header()
            .unwrap()
            .write_image_data(data)
            .unwrap();
    }
    output
}

fn make_adam7_png(width: usize, height: usize, pixels: &[u8]) -> Vec<u8> {
    const PASSES: [(usize, usize, usize, usize); 7] = [
        (0, 0, 8, 8),
        (4, 0, 8, 8),
        (0, 4, 4, 8),
        (2, 0, 4, 4),
        (0, 2, 2, 4),
        (1, 0, 2, 2),
        (0, 1, 1, 2),
    ];
    let mut rows = Vec::new();
    for (x_start, y_start, x_step, y_step) in PASSES {
        let pass_width = width.saturating_sub(x_start).div_ceil(x_step);
        let pass_height = height.saturating_sub(y_start).div_ceil(y_step);
        for pass_y in 0..pass_height {
            rows.push(0);
            for pass_x in 0..pass_width {
                let x = x_start + pass_x * x_step;
                let y = y_start + pass_y * y_step;
                rows.extend_from_slice(&pixels[(y * width + x) * 3..(y * width + x + 1) * 3]);
            }
        }
    }
    let mut compressed = ZlibEncoder::new(Vec::new(), Compression::default());
    compressed.write_all(&rows).unwrap();
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(width as u32).to_be_bytes());
    ihdr.extend_from_slice(&(height as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 1]);
    append_chunk(&mut png, b"IHDR", &ihdr);
    append_chunk(&mut png, b"IDAT", &compressed.finish().unwrap());
    append_chunk(&mut png, b"IEND", &[]);
    png
}

fn source_idat(bytes: &[u8]) -> Vec<u8> {
    let mut offset = 8;
    let mut idat = Vec::new();
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let data = offset + 8..offset + 8 + length;
        if &bytes[offset + 4..offset + 8] == b"IDAT" {
            idat.extend_from_slice(&bytes[data.clone()]);
        }
        offset = data.end + 4;
    }
    idat
}

fn corrupt_chunk_crc(mut bytes: Vec<u8>, target: [u8; 4]) -> Vec<u8> {
    let mut offset = 8;
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let crc_offset = offset + 8 + length;
        if bytes[offset + 4..offset + 8] == target {
            bytes[crc_offset] ^= 0x01;
            return bytes;
        }
        offset = crc_offset + 4;
    }
    panic!(
        "fixture did not contain chunk {}",
        String::from_utf8_lossy(&target)
    );
}

fn make_png(
    width: usize,
    height: usize,
    color_type: PngColorType,
    filtered_rows: &[u8],
    density: Option<(u32, u32)>,
    split_idat: bool,
) -> Vec<u8> {
    let channels = color_type.channels_for_test();
    assert_eq!(filtered_rows.len(), (width * channels + 1) * height);
    let mut compressed = ZlibEncoder::new(Vec::new(), Compression::default());
    compressed.write_all(filtered_rows).unwrap();
    let compressed = compressed.finish().unwrap();
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&(width as u32).to_be_bytes());
    ihdr.extend_from_slice(&(height as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, color_type as u8, 0, 0, 0]);
    append_chunk(&mut png, b"IHDR", &ihdr);
    if let Some((x, y)) = density {
        let mut phys = Vec::new();
        phys.extend_from_slice(&x.to_be_bytes());
        phys.extend_from_slice(&y.to_be_bytes());
        phys.push(1);
        append_chunk(&mut png, b"pHYs", &phys);
    }
    if split_idat {
        let midpoint = compressed.len() / 2;
        append_chunk(&mut png, b"IDAT", &compressed[..midpoint]);
        append_chunk(&mut png, b"IDAT", &compressed[midpoint..]);
    } else {
        append_chunk(&mut png, b"IDAT", &compressed);
    }
    append_chunk(&mut png, b"IEND", &[]);
    png
}

fn append_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    png.extend_from_slice(kind);
    png.extend_from_slice(data);
    let mut hasher = Hasher::new();
    hasher.update(kind);
    hasher.update(data);
    png.extend_from_slice(&hasher.finalize().to_be_bytes());
}

trait TestColorType {
    fn channels_for_test(self) -> usize;
}

impl TestColorType for PngColorType {
    fn channels_for_test(self) -> usize {
        match self {
            PngColorType::Gray8 => 1,
            PngColorType::Rgb8 => 3,
            PngColorType::Indexed => 1,
            PngColorType::GrayAlpha8 => 2,
            PngColorType::Rgba8 => 4,
        }
    }
}
