use super::*;
use std::{
    env, fs,
    io::BufWriter,
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};
use tiff::{
    encoder::{
        colortype::{self, ColorType},
        Rational, TiffEncoder,
    },
    tags::{ResolutionUnit, Tag},
};

#[test]
fn applies_all_tiff_orientation_transforms() {
    let expected = [
        (1, 3, 2, vec![1, 2, 3, 4, 5, 6]),
        (2, 3, 2, vec![3, 2, 1, 6, 5, 4]),
        (3, 3, 2, vec![6, 5, 4, 3, 2, 1]),
        (4, 3, 2, vec![4, 5, 6, 1, 2, 3]),
        (5, 2, 3, vec![1, 4, 2, 5, 3, 6]),
        (6, 2, 3, vec![4, 1, 5, 2, 6, 3]),
        (7, 2, 3, vec![6, 3, 5, 2, 4, 1]),
        (8, 2, 3, vec![3, 6, 2, 5, 1, 4]),
    ];

    for (orientation, expected_width, expected_height, expected_pixels) in expected {
        let (oriented_width, oriented_height, pixels) =
            orient_tiff_pixels((1..=6).collect(), 3, 2, 1, orientation).unwrap();
        assert_eq!(
            (oriented_width, oriented_height),
            (expected_width, expected_height)
        );
        assert_eq!(pixels, expected_pixels, "orientation {orientation}");
    }
}

#[test]
fn reads_tiff_pages_for_pdf_with_resolution() {
    let input_path = temp_tiff_path("pdf-input");
    write_tiff::<colortype::RGB8>(&input_path, 2, 1, &[255, 0, 0, 0, 255, 0], 300);

    let mut pages = Vec::new();
    visit_tiff_pdf_pages(&input_path, 1_000_000, None, 10, |page| {
        pages.push(page);
        Ok(())
    })
    .unwrap();

    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].width, 2);
    assert_eq!(pages[0].height, 1);
    assert_eq!(pages[0].dpi_x, 300);
    assert_eq!(pages[0].dpi_y, 300);
    assert_eq!(pages[0].color_space, "DeviceRGB");
    match &pages[0].payload {
        ImagePayload::RawFlate {
            data,
            decode_params,
        } => {
            assert!(!data.is_empty());
            assert!(decode_params.contains("/Colors 3"));
            assert!(decode_params.contains("/Columns 2"));
        }
        ImagePayload::Jpeg { .. } | ImagePayload::Jpx { .. } | ImagePayload::Bilevel { .. } => {
            panic!("expected flate payload")
        }
    }

    let _ = fs::remove_file(input_path);
}

#[test]
fn applies_tiff_orientation_before_building_pdf_page() {
    let page = build_tiff_pdf_page(
        2,
        1,
        (300, 300),
        TiffColorType::RGB(8),
        6,
        DecodingResult::U8(vec![255, 0, 0, 0, 255, 0]),
    )
    .unwrap();

    assert_eq!((page.width, page.height), (1, 2));
    assert_eq!((page.dpi_x, page.dpi_y), (300, 300));
}

#[test]
fn combines_tiff_pages_with_their_own_samples_and_resolution() {
    let color_path = temp_tiff_path("combine-color");
    let gray_path = temp_tiff_path("combine-gray-rgb");
    let alpha_path = temp_tiff_path("combine-alpha");
    let output_path = temp_tiff_path("combine-output");
    write_tiff::<colortype::RGB8>(&color_path, 2, 1, &[255, 0, 0, 0, 255, 0], 72);
    write_tiff::<colortype::RGB8>(&gray_path, 2, 1, &[16, 16, 16, 240, 240, 240], 144);
    write_tiff::<colortype::RGBA8>(&alpha_path, 1, 1, &[10, 20, 30, 40], 300);
    fs::write(&output_path, b"old-output").unwrap();

    combine_tiff_pages(
        &[color_path.clone(), gray_path.clone(), alpha_path.clone()],
        &output_path,
        1_000_000,
        10,
        None,
    )
    .unwrap();

    let file = File::open(&output_path).unwrap();
    let mut decoder = Decoder::new(BufReader::new(file)).unwrap();
    assert_next_page(
        &mut decoder,
        TiffColorType::RGB(8),
        &[255, 0, 0, 0, 255, 0],
        72.0,
    );
    decoder.next_image().unwrap();
    assert_next_page(&mut decoder, TiffColorType::Gray(8), &[16, 240], 144.0);
    decoder.next_image().unwrap();
    assert_next_page(
        &mut decoder,
        TiffColorType::RGBA(8),
        &[10, 20, 30, 40],
        300.0,
    );
    assert!(!decoder.more_images());

    let _ = fs::remove_file(color_path);
    let _ = fs::remove_file(gray_path);
    let _ = fs::remove_file(alpha_path);
    let _ = fs::remove_file(output_path);
}

#[test]
fn export_keeps_each_axis_resolution_of_unequal_tiff_pages() {
    // A 600 x 600 frame at 300 x 150 dpi keeps both densities in the export.
    let gray_path = temp_tiff_path("export-axes-gray");
    let rgb_path = temp_tiff_path("export-axes-rgb");
    let output_path = temp_tiff_path("export-axes-output");
    let rgb: Vec<u8> = (0..600 * 600).flat_map(|i| [i as u8, 64, 32]).collect();
    fs::write(
        &gray_path,
        tiff_with_axes::<colortype::Gray8>(&vec![128; 600 * 600], 600, 600, 1),
    )
    .unwrap();
    fs::write(
        &rgb_path,
        tiff_with_axes::<colortype::RGB8>(&rgb, 600, 600, 1),
    )
    .unwrap();

    combine_tiff_pages(
        &[gray_path.clone(), rgb_path.clone()],
        &output_path,
        1_000_000,
        10,
        None,
    )
    .unwrap();

    let mut decoder = Decoder::new(BufReader::new(File::open(&output_path).unwrap())).unwrap();
    for _ in 0..2 {
        assert_eq!(read_resolution_tag(&mut decoder, Tag::XResolution), 300.0);
        assert_eq!(read_resolution_tag(&mut decoder, Tag::YResolution), 150.0);
        if decoder.more_images() {
            decoder.next_image().unwrap();
        }
    }
    assert!(!decoder.more_images());

    let _ = fs::remove_file(gray_path);
    let _ = fs::remove_file(rgb_path);
    let _ = fs::remove_file(output_path);
}

#[test]
fn explicit_export_dpi_sets_both_axes() {
    let input_path = temp_tiff_path("export-dpi-input");
    let output_path = temp_tiff_path("export-dpi-output");
    fs::write(
        &input_path,
        tiff_with_axes::<colortype::Gray8>(&vec![128; 600 * 600], 600, 600, 1),
    )
    .unwrap();

    combine_tiff_pages(
        std::slice::from_ref(&input_path),
        &output_path,
        1_000_000,
        10,
        Some(200),
    )
    .unwrap();

    let mut decoder = Decoder::new(BufReader::new(File::open(&output_path).unwrap())).unwrap();
    assert_eq!(read_resolution_tag(&mut decoder, Tag::XResolution), 200.0);
    assert_eq!(read_resolution_tag(&mut decoder, Tag::YResolution), 200.0);

    let _ = fs::remove_file(input_path);
    let _ = fs::remove_file(output_path);
}

fn read_resolution_tag<R: Read + Seek>(decoder: &mut Decoder<R>, tag: Tag) -> f64 {
    match decoder.find_tag(tag).unwrap() {
        Some(TiffIfdValue::Rational(numerator, denominator)) => {
            f64::from(numerator) / f64::from(denominator)
        }
        other => panic!("{tag:?} is not a rational: {other:?}"),
    }
}

#[test]
fn combines_netpbm_pages_with_their_own_samples() {
    let color_path = temp_tiff_path("combine-ppm-color");
    let gray_rgb_path = temp_tiff_path("combine-ppm-gray");
    let gray_path = temp_tiff_path("combine-pgm-gray");
    let output_path = temp_tiff_path("combine-netpbm-output");
    fs::write(&color_path, b"P6\n2 1\n255\n\xff\x00\x00\x00\xff\x00").unwrap();
    fs::write(&gray_rgb_path, b"P6\n2 1\n255\n\x10\x10\x10\xf0\xf0\xf0").unwrap();
    fs::write(&gray_path, b"P5\n1 1\n255\n\x80").unwrap();

    combine_tiff_pages(
        &[color_path.clone(), gray_rgb_path.clone(), gray_path.clone()],
        &output_path,
        1_000_000,
        10,
        Some(300),
    )
    .unwrap();

    let file = File::open(&output_path).unwrap();
    let mut decoder = Decoder::new(BufReader::new(file)).unwrap();
    assert_next_page(
        &mut decoder,
        TiffColorType::RGB(8),
        &[255, 0, 0, 0, 255, 0],
        300.0,
    );
    decoder.next_image().unwrap();
    assert_next_page(&mut decoder, TiffColorType::Gray(8), &[16, 240], 300.0);
    decoder.next_image().unwrap();
    assert_next_page(&mut decoder, TiffColorType::Gray(8), &[128], 300.0);
    assert!(!decoder.more_images());

    let _ = fs::remove_file(color_path);
    let _ = fs::remove_file(gray_rgb_path);
    let _ = fs::remove_file(gray_path);
    let _ = fs::remove_file(output_path);
}

const BILEVEL_FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/bilevel-tiff");

#[test]
fn bilevel_tiff_frames_keep_their_pixels_polarity_and_orientation() {
    // Each fixture was written by libtiff or ImageMagick and decodes there
    // to the listed patterns; see the fixtures' README.
    for (fixture, expected) in [
        ("g4.tif", &["expected-1.pbm"][..]),
        ("g4-fillorder2.tif", &["expected-1.pbm"]),
        ("g4-minisblack.tif", &["expected-1.pbm"]),
        ("g3-1d.tif", &["expected-1.pbm"]),
        ("g3-2d.tif", &["expected-1.pbm"]),
        ("g3-2d-fax-dpi.tif", &["expected-1.pbm"]),
        ("modified-huffman.tif", &["expected-1.pbm"]),
        ("packbits.tif", &["expected-1.pbm"]),
        ("none-minisblack.tif", &["expected-1.pbm"]),
        ("g4-2frames.tif", &["expected-1.pbm", "expected-2.pbm"]),
        ("g4-orient6.tif", &["expected-1-orient6.pbm"]),
    ] {
        let bytes = fs::read(format!("{BILEVEL_FIXTURES}/{fixture}")).unwrap();
        let mut decoder = Decoder::new(Cursor::new(bytes)).unwrap();
        for (frame, expected) in expected.iter().enumerate() {
            if frame > 0 {
                decoder.next_image().unwrap();
            }
            assert_eq!(decoder.colortype().unwrap(), TiffColorType::Gray(1));
            let (width, height) = decoder.dimensions().unwrap();
            let orientation = read_tiff_orientation(&mut decoder);
            let image = orient_tiff_bilevel(
                read_tiff_bilevel_frame(&mut decoder, width, height).unwrap(),
                orientation,
            )
            .unwrap();
            let expected = crate::netpbm::parse_pbm_p4(
                &fs::read(format!("{BILEVEL_FIXTURES}/{expected}")).unwrap(),
                1_000_000,
            )
            .unwrap();
            assert_eq!(
                (image.width, image.height),
                (expected.width, expected.height),
                "{fixture} frame {frame}"
            );
            for y in 0..image.height as usize {
                for x in 0..image.width as usize {
                    let black = |pbm: &PbmP4Image| {
                        pbm.bitmap[y * pbm.row_stride + x / 8] & (0x80 >> (x % 8)) != 0
                    };
                    assert_eq!(
                        black(&image),
                        black(&expected),
                        "{fixture} frame {frame} pixel ({x}, {y})"
                    );
                }
            }
        }
        assert!(!decoder.more_images(), "{fixture} has extra frames");
    }
}

#[test]
fn bilevel_tiff_frames_become_bilevel_pdf_pages_at_their_resolution() {
    let frames = fs::read(format!("{BILEVEL_FIXTURES}/g4-2frames.tif")).unwrap();
    let fax = fs::read(format!("{BILEVEL_FIXTURES}/g3-2d-fax-dpi.tif")).unwrap();
    let pdf = crate::write_pdf(
        Vec::new(),
        [&frames, &fax].map(|data| crate::PageSpec::Image {
            page_size: None,
            placement: None,
            rotation_degrees: 0,
            image: crate::ImageSpec {
                source: crate::InputSource::Bytes {
                    file_name: "scan.tif",
                    data,
                },
                compression: crate::ImageCompression::Auto,
                processing: crate::ImageProcessing::None,
                size_guardrail: None,
            },
            frames: crate::FramePolicy::All,
        }),
        &crate::PdfBuildOptions::default(),
        |_| {},
    )
    .unwrap();
    let text = String::from_utf8_lossy(&pdf);

    assert!(text.contains("/Count 3"));
    assert_eq!(text.matches("/BitsPerComponent 1").count(), 3);
    // 61x40 pixels at 300 dpi, then at 204 x 98 dpi.
    assert_eq!(text.matches("/MediaBox [0 0 14.6400 9.6000]").count(), 2);
    assert!(text.contains("/MediaBox [0 0 21.5294 29.3878]"));
}

#[test]
fn corrupt_ccitt_strips_are_rejected() {
    let mut bytes = fs::read(format!("{BILEVEL_FIXTURES}/g3-2d.tif")).unwrap();
    let mut decoder = Decoder::new(Cursor::new(bytes.clone())).unwrap();
    let offset = decoder.get_tag_u64_vec(Tag::StripOffsets).unwrap()[0] as usize;
    let count = decoder.get_tag_u64_vec(Tag::StripByteCounts).unwrap()[0] as usize;
    bytes[offset..offset + count].fill(0xff);

    assert!(visit_tiff_pdf_pages_from_bytes(&bytes, 1_000_000, None, 10, |_| Ok(())).is_err());
}

#[test]
fn keeps_existing_tiff_and_cleans_temporary_on_late_failure() {
    let valid_path = temp_tiff_path("atomic-valid");
    let invalid_path = temp_tiff_path("atomic-invalid");
    let output_path = temp_tiff_path("atomic-output");
    write_tiff::<colortype::RGB8>(&valid_path, 1, 1, &[255, 0, 0], 72);
    fs::write(&invalid_path, b"invalid tiff").unwrap();
    fs::write(&output_path, b"existing-tiff-output").unwrap();

    let result = combine_tiff_pages(
        &[valid_path.clone(), invalid_path.clone()],
        &output_path,
        1_000_000,
        10,
        None,
    );

    assert!(result.is_err());
    assert_eq!(fs::read(&output_path).unwrap(), b"existing-tiff-output");
    assert_no_sibling_temporary(&output_path);
    let _ = fs::remove_file(valid_path);
    let _ = fs::remove_file(invalid_path);
    let _ = fs::remove_file(output_path);
}

fn temp_tiff_path(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!(
        "evb-pdf-image-combine-{label}-{}-{nanos}.tiff",
        process::id()
    ))
}

#[test]
fn unequal_axis_resolution_sizes_gray_and_rgb_pages_per_axis() {
    // 600 x 600 pixels at 300 x 150 dpi is 144 x 288 pt. Orientation 6
    // displays the same frame turned, so its page is 288 x 144 pt.
    for (orientation, media_box) in [
        (1, "/MediaBox [0 0 144.0000 288.0000]"),
        (6, "/MediaBox [0 0 288.0000 144.0000]"),
    ] {
        let gray = tiff_with_axes::<colortype::Gray8>(&vec![128; 600 * 600], 600, 600, orientation);
        let rgb =
            tiff_with_axes::<colortype::RGB8>(&vec![128; 600 * 600 * 3], 600, 600, orientation);
        for data in [gray, rgb] {
            let pdf = crate::write_pdf(
                Vec::new(),
                [crate::PageSpec::Image {
                    page_size: None,
                    placement: None,
                    rotation_degrees: 0,
                    image: crate::ImageSpec {
                        source: crate::InputSource::Bytes {
                            file_name: "scan.tif",
                            data: &data,
                        },
                        compression: crate::ImageCompression::Auto,
                        processing: crate::ImageProcessing::None,
                        size_guardrail: None,
                    },
                    frames: crate::FramePolicy::All,
                }],
                &crate::PdfBuildOptions::default(),
                |_| {},
            )
            .unwrap();
            let text = String::from_utf8_lossy(&pdf);
            assert!(
                text.contains(media_box),
                "orientation {orientation}: {media_box} missing"
            );
        }
    }
}

fn tiff_with_axes<C: ColorType<Inner = u8>>(
    pixels: &[u8],
    width: u32,
    height: u32,
    orientation: u16,
) -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    let mut encoder = TiffEncoder::new(&mut bytes).unwrap();
    let mut image = encoder.new_image::<C>(width, height).unwrap();
    image.resolution_unit(ResolutionUnit::Inch);
    image.x_resolution(Rational { n: 300, d: 1 });
    image.y_resolution(Rational { n: 150, d: 1 });
    image
        .encoder()
        .write_tag(Tag::Orientation, orientation)
        .unwrap();
    image.write_data(pixels).unwrap();
    bytes.into_inner()
}

#[test]
fn export_displays_gray_and_rgb_frames_in_each_orientation() {
    // The source frame is 3 x 2 pixels at 300 x 150 dpi, numbered 1 to 6 by
    // row. `order` lists those numbers as the displayed frame shows them.
    // Orientations 5 to 8 turn the frame sideways: a 2 x 3 page at 150 x 300 dpi.
    let cases = [
        (1, 3, 2, vec![1, 2, 3, 4, 5, 6]),
        (2, 3, 2, vec![3, 2, 1, 6, 5, 4]),
        (3, 3, 2, vec![6, 5, 4, 3, 2, 1]),
        (4, 3, 2, vec![4, 5, 6, 1, 2, 3]),
        (5, 2, 3, vec![1, 4, 2, 5, 3, 6]),
        (6, 2, 3, vec![4, 1, 5, 2, 6, 3]),
        (7, 2, 3, vec![6, 3, 5, 2, 4, 1]),
        (8, 2, 3, vec![3, 6, 2, 5, 1, 4]),
    ];
    for (orientation, width, height, order) in cases {
        let (dpi_x, dpi_y) = if (5..=8).contains(&orientation) {
            (150.0, 300.0)
        } else {
            (300.0, 150.0)
        };
        let gray: Vec<u8> = (1..=6).collect();
        let rgb: Vec<u8> = gray.iter().flat_map(|&v| [v, 2 * v, 3 * v]).collect();
        let expected_rgb: Vec<u8> = order.iter().flat_map(|&v| [v, 2 * v, 3 * v]).collect();
        for (color_type, source, expected) in [
            (TiffColorType::Gray(8), gray, order),
            (TiffColorType::RGB(8), rgb, expected_rgb),
        ] {
            let input_path = temp_tiff_path("export-orientation-input");
            let output_path = temp_tiff_path("export-orientation-output");
            let input = match color_type {
                TiffColorType::RGB(8) => {
                    tiff_with_axes::<colortype::RGB8>(&source, 3, 2, orientation)
                }
                _ => tiff_with_axes::<colortype::Gray8>(&source, 3, 2, orientation),
            };
            fs::write(&input_path, input).unwrap();
            combine_tiff_pages(
                std::slice::from_ref(&input_path),
                &output_path,
                1_000_000,
                10,
                None,
            )
            .unwrap();

            let mut decoder =
                Decoder::new(BufReader::new(File::open(&output_path).unwrap())).unwrap();
            assert_eq!(
                decoder.dimensions().unwrap(),
                (width, height),
                "orientation {orientation} {color_type:?}"
            );
            assert_eq!(decoder.colortype().unwrap(), color_type);
            assert_eq!(
                decode_u8(decoder.read_image().unwrap()),
                expected,
                "orientation {orientation} {color_type:?}"
            );
            assert_eq!(read_resolution_tag(&mut decoder, Tag::XResolution), dpi_x);
            assert_eq!(read_resolution_tag(&mut decoder, Tag::YResolution), dpi_y);

            let _ = fs::remove_file(input_path);
            let _ = fs::remove_file(output_path);
        }
    }
}

#[test]
fn an_axis_resolution_below_one_dpi_takes_the_other_axis() {
    let dpi_axes = |x: Rational, y: Rational| {
        let mut bytes = std::io::Cursor::new(Vec::new());
        let mut encoder = TiffEncoder::new(&mut bytes).unwrap();
        let mut image = encoder.new_image::<colortype::Gray8>(1, 1).unwrap();
        image.resolution_unit(ResolutionUnit::Inch);
        image.x_resolution(x);
        image.y_resolution(y);
        image.write_data(&[0]).unwrap();
        let mut decoder = Decoder::new(std::io::Cursor::new(bytes.into_inner())).unwrap();
        read_tiff_dpi_axes(&mut decoder)
    };
    let below_one = || Rational { n: 2, d: 5 };

    assert_eq!(
        dpi_axes(Rational { n: 300, d: 1 }, below_one()),
        Some((300, 300))
    );
    assert_eq!(
        dpi_axes(below_one(), Rational { n: 200, d: 1 }),
        Some((200, 200))
    );
    assert_eq!(dpi_axes(below_one(), below_one()), None);
    assert_eq!(
        dpi_axes(Rational { n: 204, d: 1 }, Rational { n: 98, d: 1 }),
        Some((204, 98))
    );
}

fn write_tiff<C: ColorType<Inner = u8>>(
    path: &Path,
    width: u32,
    height: u32,
    pixels: &[u8],
    dpi: u32,
) {
    let file = File::create(path).unwrap();
    let mut encoder = TiffEncoder::new(BufWriter::new(file)).unwrap();
    let mut image = encoder.new_image::<C>(width, height).unwrap();
    image.resolution(ResolutionUnit::Inch, Rational { n: dpi, d: 1 });
    image.write_data(pixels).unwrap();
}

fn assert_next_page<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    color_type: TiffColorType,
    pixels: &[u8],
    dpi: f64,
) {
    assert_eq!(decoder.colortype().unwrap(), color_type);
    assert_eq!(
        decoder.find_tag_unsigned::<u16>(Tag::Compression).unwrap(),
        Some(8),
        "exported pages are Adobe Deflate compressed"
    );
    assert_eq!(decode_u8(decoder.read_image().unwrap()), pixels);
    assert_eq!(
        decoder
            .find_tag_unsigned::<u16>(Tag::ResolutionUnit)
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        tiff_resolution_value_to_f64(decoder.find_tag(Tag::XResolution).unwrap().unwrap()),
        Some(dpi)
    );
}

fn decode_u8(decoded: DecodingResult) -> Vec<u8> {
    match decoded {
        DecodingResult::U8(pixels) => pixels,
        _ => panic!("expected u8 pixels"),
    }
}

fn assert_no_sibling_temporary(output_path: &Path) {
    let marker = format!(
        ".{}.evb-tmp-",
        output_path.file_name().unwrap().to_string_lossy()
    );
    let leftovers: Vec<_> = fs::read_dir(output_path.parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&marker))
        .collect();
    assert!(leftovers.is_empty(), "temporary output was not cleaned");
}

#[cfg(not(target_family = "wasm"))]
#[test]
fn incompressible_gray8_tiff_reservation_covers_predictor_and_filter_row() {
    const WIDTH: u32 = 512;
    const HEIGHT: u32 = 512;
    let decoded_bytes = u64::from(WIDTH) * u64::from(HEIGHT);
    let filter_row_bytes = u64::from(WIDTH) + 1;

    let mut state = 0x51a7_3c19u32;
    let mut pixels = Vec::with_capacity(decoded_bytes as usize);
    for _ in 0..decoded_bytes {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        pixels.push((state & 0xff) as u8);
    }

    let tiff_bytes = tiff_with_axes::<colortype::Gray8>(&pixels, WIDTH, HEIGHT, 1);

    let budget = crate::PipelineBudget::new(4, 16 * 1024 * 1024);
    let mut reservation = budget.empty_reservation(0);
    let mut actual_stream_len = 0u64;
    let mut actual_stream_capacity = 0u64;
    let pages = visit_tiff_pdf_pages_from_bytes_budgeted(
        &tiff_bytes,
        crate::DEFAULT_MAX_IMAGE_PIXELS,
        None,
        16,
        Some(TiffBudget::Page(&mut reservation)),
        |page| {
            match &page.payload {
                ImagePayload::RawFlate { data, .. } => {
                    actual_stream_len = data.len() as u64;
                    actual_stream_capacity = data.capacity() as u64;
                }
                _ => panic!("expected RawFlate payload for Gray8 TIFF"),
            }
            assert_eq!(page.payload_bytes(), actual_stream_capacity);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(pages, 1);
    // Incompressible 512x512 Gray8 with 1-byte Up-filter predictor per row
    // produces a Flate stream > 262,144 + 512 = 262,656 bytes.
    assert!(
        actual_stream_len > decoded_bytes + u64::from(HEIGHT),
        "expected incompressible Gray8 stream > {}, got {actual_stream_len}",
        decoded_bytes + u64::from(HEIGHT)
    );

    // Growing `Vec` capacity during Flate encoding doubles past 256 KiB to
    // >= 524,480 bytes before `shrink_to_fit()` reclaims the slack.
    let peak_encoder_capacity = actual_stream_len.next_power_of_two().max(524_480);
    let actual_peak = decoded_bytes + filter_row_bytes + peak_encoder_capacity;
    let initial_reservation = budget.metrics().peak_in_flight_bytes;
    assert!(
        initial_reservation >= actual_peak,
        "initial reservation {initial_reservation} < decoded ({decoded_bytes}) + filter_row ({filter_row_bytes}) + peak_encoder_capacity ({peak_encoder_capacity}) = {actual_peak}"
    );
    assert!(
        reservation.held_bytes() >= actual_stream_capacity,
        "retained reservation {} < actual stream capacity {}",
        reservation.held_bytes(),
        actual_stream_capacity
    );
    assert_eq!(
        actual_stream_capacity, actual_stream_len,
        "shrink_to_fit should reclaim Flate Vec doubling slack"
    );

    let retained_upper =
        estimate_tiff_pdf_encoded_stream_upper_bound(WIDTH, HEIGHT, TiffColorType::Gray(8), 1);
    assert!(
        retained_upper >= actual_stream_capacity,
        "retained stream upper bound {retained_upper} < actual stream capacity {actual_stream_capacity}"
    );

    // Multi-frame probe must also add the full retained first-frame stream
    // upper bound (not peak/2) to the second frame's peak.
    let mut two_frame_tiff = Vec::new();
    {
        let mut encoder = TiffEncoder::new(Cursor::new(&mut two_frame_tiff)).unwrap();
        encoder
            .write_image::<colortype::Gray8>(WIDTH, HEIGHT, &pixels)
            .unwrap();
        encoder
            .write_image::<colortype::Gray8>(WIDTH, HEIGHT, &pixels)
            .unwrap();
    }
    let probed_two_frame_peak =
        probe_tiff_pdf_peak_bytes_from_bytes(&two_frame_tiff, crate::DEFAULT_MAX_IMAGE_PIXELS, 16);
    let single_frame_peak =
        estimate_tiff_pdf_frame_peak_bytes(WIDTH, HEIGHT, TiffColorType::Gray(8), 1);
    assert!(
        probed_two_frame_peak >= actual_stream_capacity + single_frame_peak,
        "two-frame probe {probed_two_frame_peak} < retained ({actual_stream_capacity}) + second_peak ({single_frame_peak})"
    );
}

#[cfg(not(target_family = "wasm"))]
fn build_uncompressed_bilevel_tiff(
    width: u32,
    height: u32,
    orientation: u16,
    packed_bitmap: &[u8],
) -> Vec<u8> {
    let strip_offset = 8u32;
    let strip_len = packed_bitmap.len() as u32;
    let ifd_offset = strip_offset + strip_len;
    let mut tiff_bytes = Vec::with_capacity(ifd_offset as usize + 126);
    tiff_bytes.extend_from_slice(b"II");
    tiff_bytes.extend_from_slice(&42u16.to_le_bytes());
    tiff_bytes.extend_from_slice(&ifd_offset.to_le_bytes());
    tiff_bytes.extend_from_slice(packed_bitmap);

    let entries: [(u16, u16, u32, u32); 10] = [
        (256, 4, 1, width),                  // ImageWidth
        (257, 4, 1, height),                 // ImageLength
        (258, 3, 1, 1),                      // BitsPerSample = 1
        (259, 3, 1, 1),                      // Compression = None
        (262, 3, 1, 1),                      // PhotometricInterpretation = BlackIsZero
        (273, 4, 1, strip_offset),           // StripOffsets
        (274, 3, 1, u32::from(orientation)), // Orientation
        (277, 3, 1, 1),                      // SamplesPerPixel = 1
        (278, 4, 1, height),                 // RowsPerStrip
        (279, 4, 1, strip_len),              // StripByteCounts
    ];
    tiff_bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for (tag, field_type, count, value) in entries {
        tiff_bytes.extend_from_slice(&tag.to_le_bytes());
        tiff_bytes.extend_from_slice(&field_type.to_le_bytes());
        tiff_bytes.extend_from_slice(&count.to_le_bytes());
        tiff_bytes.extend_from_slice(&value.to_le_bytes());
    }
    tiff_bytes.extend_from_slice(&0u32.to_le_bytes());
    tiff_bytes
}

#[cfg(not(target_family = "wasm"))]
#[test]
fn rotated_bilevel_tiff_reservation_covers_swapped_stride_and_encoded_stream() {
    const WIDTH: u32 = 8_192;
    const HEIGHT: u32 = 1;
    // Source 8192x1 packs into 1,024 bytes; rotated 1x8192 (orientation 6)
    // packs into 8,192 bytes (1 byte/row * 8,192 rows) => 9,216 bytes coexisting.
    let packed_row: Vec<u8> = (0..1_024usize)
        .map(|index| ((index.wrapping_mul(73) ^ (index >> 2)) & 0xff) as u8)
        .collect();
    let tiff_bytes = build_uncompressed_bilevel_tiff(WIDTH, HEIGHT, 6, &packed_row);

    let budget = crate::PipelineBudget::new(4, 16 * 1024 * 1024);
    let mut reservation = budget.empty_reservation(0);
    let mut encoded_stream_bytes = 0u64;
    let pages = visit_tiff_pdf_pages_from_bytes_budgeted(
        &tiff_bytes,
        crate::DEFAULT_MAX_IMAGE_PIXELS,
        None,
        16,
        Some(TiffBudget::Page(&mut reservation)),
        |page| {
            assert_eq!((page.width, page.height), (HEIGHT, WIDTH));
            encoded_stream_bytes = page.payload_bytes();
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(pages, 1);

    let expected_min = 9_216u64 + encoded_stream_bytes;
    let initial_reservation = budget.metrics().peak_in_flight_bytes;
    assert!(
        initial_reservation >= expected_min,
        "rotated 8192x1 bilevel reservation {initial_reservation} < 9,216 + encoded_stream ({encoded_stream_bytes}) = {expected_min}"
    );
    assert_eq!(
        reservation.held_bytes(),
        encoded_stream_bytes,
        "post-encode reservation must shrink to retained bilevel stream size"
    );

    let probed_peak =
        probe_tiff_pdf_peak_bytes_from_bytes(&tiff_bytes, crate::DEFAULT_MAX_IMAGE_PIXELS, 16);
    assert!(
        probed_peak >= expected_min,
        "probed rotated bilevel peak {probed_peak} < {expected_min}"
    );
}

#[cfg(not(target_family = "wasm"))]
#[test]
fn rotated_4x8192_bilevel_tiff_reservation_covers_encoding_candidates_peak() {
    const WIDTH: u32 = 4;
    const HEIGHT: u32 = 8_192;
    // Source 4x8192 packs into 8,192 bytes (1 byte/row * 8,192 rows);
    // orientation 6 rotates to 8,192x4 (4,096 bytes), where `encode_mask_payload`
    // holds the oriented bitmap + JBIG2 + Flate + CCITT G4 candidates
    // simultaneously (>= 21,868 bytes).
    let mut state = 0x7f4a_7c15u32;
    let packed_bitmap: Vec<u8> = (0..8_192usize)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state as u8) & 0xf0
        })
        .collect();
    let tiff_bytes = build_uncompressed_bilevel_tiff(WIDTH, HEIGHT, 6, &packed_bitmap);

    let budget = crate::PipelineBudget::new(4, 16 * 1024 * 1024);
    let mut reservation = budget.empty_reservation(0);
    let mut retained_bytes = 0u64;
    let pages = visit_tiff_pdf_pages_from_bytes_budgeted(
        &tiff_bytes,
        crate::DEFAULT_MAX_IMAGE_PIXELS,
        None,
        16,
        Some(TiffBudget::Page(&mut reservation)),
        |page| {
            assert_eq!((page.width, page.height), (HEIGHT, WIDTH));
            retained_bytes = page.payload_bytes();
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(pages, 1);

    let initial_reservation = budget.metrics().peak_in_flight_bytes;
    assert!(
        initial_reservation >= 21_868,
        "4x8192 orientation-6 bilevel reservation {initial_reservation} < 21,868 candidate coexistence peak"
    );
    assert_eq!(reservation.held_bytes(), retained_bytes);

    let probed_peak =
        probe_tiff_pdf_peak_bytes_from_bytes(&tiff_bytes, crate::DEFAULT_MAX_IMAGE_PIXELS, 16);
    assert!(
        probed_peak >= 21_868,
        "probed 4x8192 orientation-6 bilevel peak {probed_peak} < 21,868"
    );
}

#[cfg(not(target_family = "wasm"))]
#[test]
fn rotated_2x8192_checkerboard_bilevel_tiff_covers_group4_transition_and_output_buffers() {
    const WIDTH: u32 = 2;
    const HEIGHT: u32 = 8_192;
    // Alternating checkerboard in 2x8192 (orientation 6 -> 8192x2):
    // row y=0..8192 alternates 0b1000_0000 and 0b0100_0000 so the rotated
    // 8,192x2 rows alternate every pixel, forcing `fax::Encoder` to grow both
    // `reference` and `current` `Vec<u32>` buffers to 8,192 * 4 = 32,768 bytes
    // each (65,536 bytes) alongside a 16,384-byte `VecWriter` output buffer
    // (81,920 bytes total for Group 4 alone).
    let packed_bitmap: Vec<u8> = (0..HEIGHT as usize)
        .map(|y| if y % 2 == 0 { 0b1000_0000 } else { 0b0100_0000 })
        .collect();
    let tiff_bytes = build_uncompressed_bilevel_tiff(WIDTH, HEIGHT, 6, &packed_bitmap);

    // Measure the exact peak reservation through `visit_tiff_pdf_pages_from_bytes_budgeted`.
    let group4_measured_peak = 32_768u64 * 2 + 16_384;
    let budget = crate::PipelineBudget::new(4, 16 * 1024 * 1024);
    let mut reservation = budget.empty_reservation(0);
    let mut retained_bytes = 0u64;
    let pages = visit_tiff_pdf_pages_from_bytes_budgeted(
        &tiff_bytes,
        crate::DEFAULT_MAX_IMAGE_PIXELS,
        None,
        16,
        Some(TiffBudget::Page(&mut reservation)),
        |page| {
            assert_eq!((page.width, page.height), (HEIGHT, WIDTH));
            retained_bytes = page.payload_bytes();
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(pages, 1);

    let initial_reservation = budget.metrics().peak_in_flight_bytes;
    assert!(
        initial_reservation >= group4_measured_peak,
        "2x8192 orientation-6 checkerboard reservation {initial_reservation} < Group 4 measured peak {group4_measured_peak}"
    );
    assert_eq!(reservation.held_bytes(), retained_bytes);

    // Also verify end-to-end `write_pdf_impl` in both `FramePolicy::All` and
    // `FramePolicy::ExactlyOne` modes reserves >= Group 4 measured peak.
    for frames in [crate::FramePolicy::All, crate::FramePolicy::ExactlyOne] {
        let (pdf, metrics) = crate::write_pdf_impl(
            Vec::new(),
            [crate::PageSpec::Image {
                page_size: None,
                placement: None,
                rotation_degrees: 0,
                image: crate::ImageSpec {
                    source: crate::InputSource::Bytes {
                        file_name: "checkerboard-2x8192.tif",
                        data: &tiff_bytes,
                    },
                    compression: crate::ImageCompression::Auto,
                    processing: crate::ImageProcessing::None,
                    size_guardrail: None,
                },
                frames,
            }],
            &crate::PdfBuildOptions {
                worker_threads: 2,
                max_in_flight_bytes: 16 * 1024 * 1024,
                ..crate::PdfBuildOptions::default()
            },
            |_| {},
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("/Width 8192 /Height 2"));
        assert!(
            metrics.peak_in_flight_bytes >= group4_measured_peak,
            "frames={frames:?} peak_in_flight_bytes={} < Group 4 measured peak {group4_measured_peak}",
            metrics.peak_in_flight_bytes
        );
    }

    // Also verify a Group-4-dominant fixture (64x8192 orientation 6 -> 8192x64)
    // where CCITT Group 4's transition + output buffers strictly exceed the
    // Flate sub-phase peak (including the 416 KiB Flate encoder allowance),
    // ensuring this test fails if Group 4 accounting is ever removed.
    const G4_DOMINANT_WIDTH: u32 = 64;
    const G4_DOMINANT_HEIGHT: u32 = 8_192;
    let dst_bitmap_bytes = u64::from(G4_DOMINANT_HEIGHT)
        .div_ceil(8)
        .saturating_mul(u64::from(G4_DOMINANT_WIDTH));
    let jbig2_retained_upper = dst_bitmap_bytes.saturating_mul(2).saturating_add(256);
    let encoded_upper = estimate_tiff_pdf_encoded_stream_upper_bound(
        G4_DOMINANT_WIDTH,
        G4_DOMINANT_HEIGHT,
        TiffColorType::Gray(1),
        6,
    );
    let flate_subphase_peak = dst_bitmap_bytes
        .saturating_add(jbig2_retained_upper)
        .saturating_add(FLATE_ENCODER_FIXED_OVERHEAD_BYTES)
        .saturating_add(encoded_upper.saturating_mul(2));
    let g4_dominant_estimate = estimate_tiff_pdf_frame_peak_bytes(
        G4_DOMINANT_WIDTH,
        G4_DOMINANT_HEIGHT,
        TiffColorType::Gray(1),
        6,
    );
    assert!(
        g4_dominant_estimate > flate_subphase_peak,
        "64x8192 Group 4 estimate ({g4_dominant_estimate}) must strictly dominate Flate sub-phase peak ({flate_subphase_peak})"
    );
    let row_bytes = (G4_DOMINANT_WIDTH as usize).div_ceil(8);
    let mut g4_dominant_bitmap = Vec::with_capacity(row_bytes * G4_DOMINANT_HEIGHT as usize);
    for y in 0..G4_DOMINANT_HEIGHT as usize {
        let byte = if y % 2 == 0 { 0xAA } else { 0x55 };
        g4_dominant_bitmap.extend(std::iter::repeat_n(byte, row_bytes));
    }
    let g4_dominant_tiff = build_uncompressed_bilevel_tiff(
        G4_DOMINANT_WIDTH,
        G4_DOMINANT_HEIGHT,
        6,
        &g4_dominant_bitmap,
    );
    let g4_budget = crate::PipelineBudget::new(4, 16 * 1024 * 1024);
    let mut g4_reservation = g4_budget.empty_reservation(0);
    let g4_pages = visit_tiff_pdf_pages_from_bytes_budgeted(
        &g4_dominant_tiff,
        crate::DEFAULT_MAX_IMAGE_PIXELS,
        None,
        16,
        Some(TiffBudget::Page(&mut g4_reservation)),
        |page| {
            assert_eq!(
                (page.width, page.height),
                (G4_DOMINANT_HEIGHT, G4_DOMINANT_WIDTH)
            );
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(g4_pages, 1);
    assert!(
        g4_budget.metrics().peak_in_flight_bytes == g4_dominant_estimate
            && g4_budget.metrics().peak_in_flight_bytes > flate_subphase_peak,
        "64x8192 Group 4 reservation {} must match Group 4 estimate ({g4_dominant_estimate}) and exceed Flate sub-phase peak ({flate_subphase_peak})",
        g4_budget.metrics().peak_in_flight_bytes
    );
}

#[cfg(not(target_family = "wasm"))]
#[test]
fn tiny_gray8_tiff_estimate_accounts_for_flate2_staging_and_zlib_backend_state() {
    use std::sync::mpsc;
    use std::time::Duration;

    const MEASURED_FLATE_ENCODER_FLOOR: u64 = 412_736;
    let estimate = estimate_tiff_pdf_frame_peak_bytes(1, 1, TiffColorType::Gray(8), 1);
    assert!(
        estimate >= MEASURED_FLATE_ENCODER_FLOOR,
        "1x1 Gray8 TIFF estimate {estimate} must cover flate2 staging + zlib-rs backend state (>= {MEASURED_FLATE_ENCODER_FLOOR})"
    );

    let tiff_bytes = tiff_with_axes::<colortype::Gray8>(&[0x42], 1, 1, 1);
    let probed =
        probe_tiff_pdf_peak_bytes_from_bytes(&tiff_bytes, crate::DEFAULT_MAX_IMAGE_PIXELS, 16);
    assert!(
        probed >= MEASURED_FLATE_ENCODER_FLOOR,
        "1x1 Gray8 TIFF probed peak {probed} must cover flate2 staging + zlib-rs backend state (>= {MEASURED_FLATE_ENCODER_FLOOR})"
    );

    // Under a 64 KiB cap, a 1x1 Gray8 TIFF must trigger oversized-page
    // exclusivity (blocking while another reservation is active rather than
    // admitting concurrently).
    let budget = crate::PipelineBudget::new(4, 64 * 1024);
    let hold = budget.reserve_standalone_bytes(0, 1024).unwrap();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::scope(|scope| {
        let budget = &budget;
        let tiff_bytes = &tiff_bytes;
        scope.spawn(move || {
            let pages = visit_tiff_pdf_pages_from_bytes_budgeted(
                tiff_bytes,
                crate::DEFAULT_MAX_IMAGE_PIXELS,
                None,
                16,
                Some(TiffBudget::Standalone(budget, 1)),
                |_| Ok(()),
            )
            .unwrap();
            assert_eq!(pages, 1);
            done_tx.send(()).unwrap();
        });

        assert!(
            done_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "1x1 Gray8 TIFF must wait for oversized-page exclusivity under a 64 KiB budget"
        );
        drop(hold);
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("1x1 Gray8 TIFF must proceed exclusively once active bytes drop to 0");
    });
    assert_eq!(
        budget.metrics().peak_in_flight_bytes,
        estimate,
        "oversized 1x1 Gray8 TIFF must never overlap with the 1 KiB sibling reservation"
    );
}
