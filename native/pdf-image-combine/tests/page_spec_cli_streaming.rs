use std::{
    env, fs,
    fs::File,
    path::{Path, PathBuf},
    process::{self, Command},
    time::{SystemTime, UNIX_EPOCH},
};

use evb_pdf_image_combine::{
    write_pdf, FramePolicy, ImageCompression, ImageProcessing, ImageSpec, InputSource, PageSpec,
    PdfBuildOptions,
};
use jpeg_encoder::{ColorType, Encoder as JpegEncoder};

#[test]
fn cli_streaming_path_matches_the_core_without_vec_staging() {
    let first_path = temp_path("stream-first").with_extension("ppm");
    let second_path = temp_path("stream-second").with_extension("ppm");
    let output_path = temp_path("stream-output").with_extension("pdf");
    let first = b"P6\n1 1\n255\n\xff\0\0";
    let second = b"P6\n1 1\n255\n\0\xff\0";
    fs::write(&first_path, first).unwrap();
    fs::write(&second_path, second).unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--output", output_path.to_str().unwrap(), "--"])
        .args([&first_path, &second_path])
        .status()
        .unwrap();
    assert!(status.success());

    let expected = write_pdf(
        Vec::new(),
        [
            image_bytes("first.ppm", first),
            image_bytes("second.ppm", second),
        ],
        &PdfBuildOptions::default(),
        |_| {},
    )
    .unwrap();
    assert_eq!(fs::read(&output_path).unwrap(), expected);

    remove_files([&first_path, &second_path, &output_path]);
}

#[test]
fn cli_streams_jsonl_compact_manifest_without_staging_all_pages() {
    let first_path = temp_path("jsonl-first").with_extension("ppm");
    let second_path = temp_path("jsonl-second").with_extension("ppm");
    let manifest_path = temp_path("jsonl-manifest").with_extension("jsonl");
    let output_path = temp_path("jsonl-output").with_extension("pdf");
    fs::write(&first_path, b"P6\n1 1\n255\n\xff\0\0").unwrap();
    fs::write(&second_path, b"P6\n1 1\n255\n\0\xff\0").unwrap();
    fs::write(
        &manifest_path,
        format!(
            "{{\"format\":\"evb-pdf-image-combine-jsonl\",\"schemaVersion\":1,\"pageCount\":2}}\nimage\t72\t72\t{}\nimage\t72\t72\t{}\n",
            first_path.display(),
            second_path.display(),
        ),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .env("EVB_PDF_COMBINE_MAX_PAGES", "2")
        .args([
            "--output",
            output_path.to_str().unwrap(),
            "--compact-manifest",
        ])
        .arg(&manifest_path)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fs::read(&output_path).unwrap().starts_with(b"%PDF-"));
    remove_files([&first_path, &second_path, &manifest_path, &output_path]);
}

#[test]
fn cli_preserves_existing_output_and_removes_temporary_on_late_failure() {
    let valid_path = temp_path("late-valid").with_extension("ppm");
    let invalid_path = temp_path("late-invalid").with_extension("ppm");
    let output_path = temp_path("late-output").with_extension("pdf");
    fs::write(&valid_path, b"P6\n1 1\n255\n\xff\0\0").unwrap();
    fs::write(&invalid_path, b"invalid").unwrap();
    fs::write(&output_path, b"existing-output").unwrap();

    let status = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--output", output_path.to_str().unwrap(), "--"])
        .args([&valid_path, &invalid_path])
        .status()
        .unwrap();
    assert!(!status.success());
    assert_eq!(fs::read(&output_path).unwrap(), b"existing-output");
    assert_no_sibling_temporary(&output_path);

    remove_files([&valid_path, &invalid_path, &output_path]);
}

#[test]
fn cli_preserves_existing_output_for_oversized_input() {
    let input_path = temp_path("oversized-input").with_extension("ppm");
    let output_path = temp_path("oversized-output").with_extension("pdf");
    fs::write(&input_path, b"P6\n1001 1000\n255\n").unwrap();
    fs::write(&output_path, b"existing-output").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .env("EVB_PDF_COMBINE_MAX_IMAGE_PIXELS", "1000000")
        .args(["--output", output_path.to_str().unwrap(), "--"])
        .arg(&input_path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["code"], "too-large");
    assert_eq!(fs::read(&output_path).unwrap(), b"existing-output");
    assert_no_sibling_temporary(&output_path);

    remove_files([&input_path, &output_path]);
}

#[test]
fn cli_rejects_compact_manifest_over_configured_page_limit_before_image_io() {
    let manifest_path = temp_path("oversized-manifest").with_extension("tsv");
    let output_path = temp_path("oversized-manifest-output").with_extension("pdf");
    fs::write(
        &manifest_path,
        "image\t72\t72\t/missing-one.ppm\nimage\t72\t72\t/missing-two.ppm\n",
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .env("EVB_PDF_COMBINE_MAX_PAGES", "1")
        .args([
            "--output",
            output_path.to_str().unwrap(),
            "--compact-manifest",
        ])
        .arg(&manifest_path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["code"], "too-large");
    assert!(envelope["message"]
        .as_str()
        .unwrap()
        .contains("1-page admission ceiling"));
    assert!(!output_path.exists());

    remove_files([&manifest_path, &output_path]);
}

#[test]
fn cli_rejects_oversized_jpeg_and_jp2_dimensions_before_pdf_output() {
    let fixtures = [
        ("jpg", oversized_jpeg(2_000, 2_000)),
        ("jp2", oversized_jp2(2_000, 2_000)),
    ];

    for (extension, bytes) in fixtures {
        let input_path = temp_path("oversized-dimensions").with_extension(extension);
        let output_path = temp_path("oversized-dimensions-output").with_extension("pdf");
        fs::write(&input_path, bytes).unwrap();

        let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
            .env("EVB_PDF_COMBINE_MAX_IMAGE_PIXELS", "1000000")
            .args(["--output", output_path.to_str().unwrap(), "--"])
            .arg(&input_path)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "{extension} unexpectedly succeeded"
        );
        let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(envelope["code"], "too-large", "{extension}: {envelope}");
        assert!(!output_path.exists());
        assert_no_sibling_temporary(&output_path);

        remove_files([&input_path, &output_path]);
    }
}

#[test]
fn cli_rejects_jpeg_with_header_but_no_decodable_scan() {
    let input_path = temp_path("fake-jpeg").with_extension("jpg");
    let output_path = temp_path("fake-jpeg-output").with_extension("pdf");
    fs::write(&input_path, oversized_jpeg(1, 1)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--output", output_path.to_str().unwrap(), "--"])
        .arg(&input_path)
        .output()
        .unwrap();

    assert!(!output.status.success(), "fake JPEG unexpectedly succeeded");
    let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["code"], "native-failure");
    assert!(envelope["message"]
        .as_str()
        .unwrap()
        .contains("JPEG scan data is not decodable"));
    assert!(!output_path.exists());
    assert_no_sibling_temporary(&output_path);

    remove_files([&input_path, &output_path]);
}

#[test]
fn cli_rejects_jp2_with_header_but_no_codestream() {
    let input_path = temp_path("fake-jp2").with_extension("jp2");
    let output_path = temp_path("fake-jp2-output").with_extension("pdf");
    fs::write(&input_path, oversized_jp2(1, 1)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--output", output_path.to_str().unwrap(), "--"])
        .arg(&input_path)
        .output()
        .unwrap();

    assert!(
        !output.status.success(),
        "header-only JP2 unexpectedly succeeded"
    );
    let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["code"], "native-failure");
    assert!(envelope["message"]
        .as_str()
        .unwrap()
        .contains("JPEG 2000 payload is not decodable"));
    assert!(!output_path.exists());
    assert_no_sibling_temporary(&output_path);

    remove_files([&input_path, &output_path]);
}

#[test]
fn cli_accepts_decodable_jpeg_and_compatible_jp2() {
    for (label, extension, bytes) in [
        ("jpeg-gray", "jpg", valid_gray_jpeg()),
        ("jpeg-rgb", "jpg", valid_rgb_jpeg()),
        ("jp2-gray", "jp2", valid_gray_jp2()),
        ("jp2-rgb", "jp2", valid_rgb_jp2()),
    ] {
        let input_path = temp_path(label).with_extension(extension);
        let output_path = temp_path(&format!("{label}-output")).with_extension("pdf");
        fs::write(&input_path, bytes).unwrap();

        let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
            .args(["--output", output_path.to_str().unwrap(), "--"])
            .arg(&input_path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{label}: {}",
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(fs::read(&output_path).unwrap().starts_with(b"%PDF-"));

        if let Some(pdftoppm) = bundled_pdftoppm_path() {
            let render_prefix = temp_path("valid-image-render");
            let render = Command::new(pdftoppm)
                .args(["-singlefile", "-scale-to-x", "1", "-scale-to-y", "1"])
                .arg(&output_path)
                .arg(&render_prefix)
                .output()
                .unwrap();
            assert!(
                render.status.success(),
                "{label}: {}",
                String::from_utf8_lossy(&render.stderr),
            );
            let render_path = render_prefix.with_extension("ppm");
            assert!(fs::read(&render_path)
                .unwrap()
                .starts_with(b"P6\n1 1\n255\n"));
            remove_files([&render_path]);
        }

        remove_files([&input_path, &output_path]);
    }
}

#[test]
fn cli_rejects_unsupported_cmyk_and_ycck_jpegs_at_metadata_admission() {
    for (label, bytes) in [
        ("cmyk-jpeg", valid_cmyk_jpeg()),
        ("ycck-jpeg", valid_ycck_jpeg()),
    ] {
        let input_path = temp_path(label).with_extension("jpg");
        let output_path = temp_path(&format!("{label}-output")).with_extension("pdf");
        fs::write(&input_path, bytes).unwrap();

        let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
            .args(["--output", output_path.to_str().unwrap(), "--"])
            .arg(&input_path)
            .output()
            .unwrap();

        assert!(!output.status.success(), "{label} unexpectedly succeeded");
        let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(envelope["code"], "native-failure");
        assert_eq!(envelope["message"], "Unsupported JPEG component count: 4");
        assert!(!output_path.exists());
        assert_no_sibling_temporary(&output_path);

        remove_files([&input_path, &output_path]);
    }
}

#[test]
fn cli_rejects_truncated_mismatched_and_unsupported_image_inputs() {
    for (label, extension, bytes, expected_code) in [
        (
            "truncated-jpeg",
            "jpg",
            vec![0xff, 0xd8, 0xff, 0xc0, 0x00],
            "native-failure",
        ),
        (
            "truncated-jp2",
            "jp2",
            b"\0\0\0\x0cjP  \r\n\x87\n\0\0".to_vec(),
            "native-failure",
        ),
        (
            "png-named-jpeg",
            "jpg",
            b"\x89PNG\r\n\x1a\nnot-a-jpeg".to_vec(),
            "native-failure",
        ),
        ("jpeg-named-png", "png", valid_gray_jpeg(), "native-failure"),
        (
            "corrupt-jp2-tile",
            "jp2",
            corrupt_jp2_tile_data(),
            "native-failure",
        ),
        (
            "mismatched-jp2-components",
            "jp2",
            mismatched_jp2_component_count(),
            "native-failure",
        ),
        (
            "unsupported-gif",
            "gif",
            b"GIF89a\x01\0\x01\0".to_vec(),
            "native-failure",
        ),
    ] {
        let input_path = temp_path(label).with_extension(extension);
        let output_path = temp_path("rejected-image-output").with_extension("pdf");
        fs::write(&input_path, bytes).unwrap();

        let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
            .args(["--output", output_path.to_str().unwrap(), "--"])
            .arg(&input_path)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{label} unexpectedly succeeded");
        let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(envelope["code"], expected_code, "{label}: {envelope}");
        assert!(!output_path.exists());
        assert_no_sibling_temporary(&output_path);

        remove_files([&input_path, &output_path]);
    }
}

#[test]
fn cli_rejects_a_single_compact_manifest_record_above_the_byte_limit() {
    let manifest_path = temp_path("oversized-manifest-record").with_extension("tsv");
    let output_path = temp_path("oversized-manifest-bytes-output").with_extension("pdf");
    File::create(&manifest_path)
        .unwrap()
        .set_len((64 * 1024 * 1024) + 1)
        .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args([
            "--output",
            output_path.to_str().unwrap(),
            "--compact-manifest",
        ])
        .arg(&manifest_path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["code"], "too-large");
    assert!(envelope["message"]
        .as_str()
        .unwrap()
        .contains("65536-byte admission ceiling"));
    assert!(!output_path.exists());

    remove_files([&manifest_path, &output_path]);
}

fn oversized_jpeg(width: u16, height: u16) -> Vec<u8> {
    let [width_high, width_low] = width.to_be_bytes();
    let [height_high, height_low] = height.to_be_bytes();
    vec![
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x0b,
        8,
        height_high,
        height_low,
        width_high,
        width_low,
        0x01,
        0x01,
        0x11,
        0x00,
        0xff,
        0xda,
        0x00,
        0x08,
        0x01,
        0x01,
        0x00,
        0x00,
        0x3f,
        0x00,
        0x11,
        0xff,
        0xd9,
    ]
}

fn oversized_jp2(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\0\0\0\x0cjP  \r\n\x87\n".to_vec();
    bytes.extend_from_slice(&30u32.to_be_bytes());
    bytes.extend_from_slice(b"jp2h");
    bytes.extend_from_slice(&22u32.to_be_bytes());
    bytes.extend_from_slice(b"ihdr");
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&3u16.to_be_bytes());
    bytes.extend_from_slice(&[7, 7, 0, 0]);
    bytes
}

fn valid_gray_jpeg() -> Vec<u8> {
    encode_jpeg(&[0x80], ColorType::Luma)
}

fn valid_rgb_jpeg() -> Vec<u8> {
    encode_jpeg(&[0x10, 0x20, 0x30], ColorType::Rgb)
}

fn valid_cmyk_jpeg() -> Vec<u8> {
    encode_jpeg(&[0x10, 0x20, 0x30, 0x40], ColorType::Cmyk)
}

fn valid_ycck_jpeg() -> Vec<u8> {
    encode_jpeg(&[0x10, 0x20, 0x30, 0x40], ColorType::CmykAsYcck)
}

fn encode_jpeg(pixel: &[u8], color_type: ColorType) -> Vec<u8> {
    let mut bytes = Vec::new();
    JpegEncoder::new(&mut bytes, 90)
        .encode(pixel, 1, 1, color_type)
        .unwrap();
    bytes
}

fn valid_gray_jp2() -> Vec<u8> {
    // OpenJPEG 2.5.4 fixture generated from a 1x1 PGM with:
    // opj_compress -n 1 -i one.pgm -o one.jp2
    const HEX: &str = concat!(
        "0000000c6a5020200d0a870a00000014667479706a703220000000006a703220",
        "0000002d6a703268000000166968647200000001000000010001070700000000",
        "000f636f6c7201000000000011000000846a703263ff4fff510029000000000001",
        "000000010000000000000000000000010000000100000000000000000001070101",
        "ff52000c00000001000004040001ff5c00044040ff640025000143726561746564",
        "206279204f70656e4a5045472076657273696f6e20322e352e34ff90000a000000",
        "0000120001ff93cfb40400ffd9",
    );
    decode_hex(HEX)
}

fn valid_rgb_jp2() -> Vec<u8> {
    // OpenJPEG 2.5.4 fixture generated from a 1x1 PPM with:
    // opj_compress -n 1 -i one.ppm -o one.jp2
    const HEX: &str = concat!(
        "0000000c6a5020200d0a870a00000014667479706a703220000000006a703220",
        "0000002d6a703268000000166968647200000001000000010003070700000000",
        "000f636f6c7201000000000010000000926a703263ff4fff51002f0000000000",
        "01000000010000000000000000000000010000000100000000000000000003",
        "070101070101070101ff52000c00000001010004040001ff5c00044040ff6400",
        "25000143726561746564206279204f70656e4a5045472076657273696f6e2032",
        "2e352e34ff90000a00000000001a0001ff93cfb40408c3e70204c3e70207ffd9",
    );
    decode_hex(HEX)
}

fn corrupt_jp2_tile_data() -> Vec<u8> {
    let mut bytes = valid_gray_jp2();
    let tile_data = bytes
        .windows(2)
        .position(|window| window == [0xff, 0x93])
        .unwrap()
        + 2;
    bytes[tile_data..tile_data + 4].fill(0);
    bytes
}

fn mismatched_jp2_component_count() -> Vec<u8> {
    let mut bytes = valid_rgb_jp2();
    let image_header_type = bytes
        .windows(4)
        .position(|window| window == b"ihdr")
        .unwrap();
    bytes[image_header_type + 12..image_header_type + 14].copy_from_slice(&1u16.to_be_bytes());
    bytes
}

fn decode_hex(hex: &str) -> Vec<u8> {
    assert_eq!(
        hex.len() % 2,
        0,
        "hex fixture must contain complete byte pairs"
    );
    hex.as_bytes()
        .chunks_exact(2)
        .map(|digits| u8::from_str_radix(std::str::from_utf8(digits).unwrap(), 16).unwrap())
        .collect()
}

#[test]
#[should_panic(expected = "hex fixture must contain complete byte pairs")]
fn hex_fixture_decoder_rejects_an_odd_length() {
    decode_hex("000");
}

fn image_bytes<'a>(file_name: &'a str, data: &'a [u8]) -> PageSpec<InputSource<'a>> {
    PageSpec::Image {
        page_size: None,
        placement: None,
        rotation_degrees: 0,
        image: ImageSpec {
            source: InputSource::Bytes { file_name, data },
            compression: ImageCompression::Auto,
            processing: ImageProcessing::None,
            size_guardrail: None,
        },
        frames: FramePolicy::All,
    }
}

fn temp_path(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!(
        "evb-pdf-image-combine-{label}-{}-{nanos}",
        process::id()
    ))
}

fn assert_no_sibling_temporary(output_path: &Path) {
    let marker = format!(
        ".{}.evb-tmp-",
        output_path.file_name().unwrap().to_string_lossy()
    );
    let leftovers = fs::read_dir(output_path.parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&marker))
        .count();
    assert_eq!(leftovers, 0);
}

fn bundled_pdftoppm_path() -> Option<PathBuf> {
    let (tag, executable) = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => ("darwin-arm64", "pdftoppm"),
        ("linux", "x86_64") => ("linux-x64", "pdftoppm"),
        ("windows", "x86_64") => ("win32-x64", "pdftoppm.exe"),
        _ => return None,
    };
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../resources/poppler")
        .join(tag)
        .join("bin")
        .join(executable);
    assert!(
        path.is_file(),
        "bundled pdftoppm is missing for supported host {}-{}",
        env::consts::OS,
        env::consts::ARCH,
    );
    Some(path)
}

fn remove_files<const N: usize>(paths: [&PathBuf; N]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}
