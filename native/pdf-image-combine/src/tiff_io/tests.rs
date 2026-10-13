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
