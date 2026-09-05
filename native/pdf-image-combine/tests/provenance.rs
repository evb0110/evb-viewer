use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use evb_pdf_image_combine::{
    write_pdf, FramePolicy, ImageCompression, ImageProcessing, ImageSpec, InputSource, PageSpec,
    PdfBuildOptions,
};

const PPM: &[u8] = b"P6\n1 1\n255\n\xff\0\0";
const STAMP_JSON: &str = r#"{"schemaVersion":1,"sourceSha256":"0000000000000000000000000000000000000000000000000000000000000000"}"#;

#[test]
fn unstamped_output_is_pinned_to_the_legacy_writer_bytes() {
    let output = write_fixture(None);
    let expected = decode_hex(include_str!("fixtures/provenance-small-legacy.pdf.hex"));
    assert_eq!(output, expected);
}

#[test]
fn the_same_stamp_and_inputs_are_byte_identical_across_runs() {
    let stamp = stamp_hex();
    assert_eq!(write_fixture(Some(&stamp)), write_fixture(Some(&stamp)));
}

#[test]
fn stamping_preserves_every_image_stream_byte() {
    let unstamped = write_fixture(None);
    let stamp = stamp_hex();
    let stamped = write_fixture(Some(&stamp));

    assert_eq!(image_streams(&unstamped), image_streams(&stamped));
    let stamp_marker = format!("/EVBScanCleanup ({stamp})");
    assert!(stamped
        .windows(stamp_marker.len())
        .any(|window| window == stamp_marker.as_bytes()));
    assert!(stamped
        .windows(b"/Info 6 0 R".len())
        .any(|window| window == b"/Info 6 0 R"));
}

#[test]
fn json_manifest_stamp_reaches_the_native_writer() {
    let temp = TempDir::new("json-manifest");
    let input_path = temp.path().join("input.ppm");
    let manifest_path = temp.path().join("manifest.json");
    let output_path = temp.path().join("output.pdf");
    fs::write(&input_path, PPM).unwrap();
    let stamp = stamp_hex();
    fs::write(
        &manifest_path,
        serde_json::json!({
            "provenanceStampHex": stamp,
            "pages": [format!("image\t72\t72\t{}", input_path.display())],
        })
        .to_string(),
    )
    .unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--output", output_path.to_str().unwrap()])
        .args(["--compact-manifest", manifest_path.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let output = fs::read(output_path).unwrap();
    assert!(output
        .windows(b"/EVBScanCleanup (".len())
        .any(|window| { window == b"/EVBScanCleanup (" }));
}

fn write_fixture(stamp: Option<&str>) -> Vec<u8> {
    let options = PdfBuildOptions {
        provenance_stamp_hex: stamp.map(str::to_owned),
        ..PdfBuildOptions::default()
    };
    write_pdf(
        Vec::new(),
        [PageSpec::Image {
            page_size: None,
            placement: None,
            rotation_degrees: 0,
            image: ImageSpec {
                source: InputSource::Bytes {
                    file_name: "input.ppm",
                    data: PPM,
                },
                compression: ImageCompression::Auto,
                processing: ImageProcessing::None,
                size_guardrail: None,
            },
            frames: FramePolicy::All,
        }],
        &options,
        |_| {},
    )
    .unwrap()
}

fn stamp_hex() -> String {
    STAMP_JSON
        .as_bytes()
        .iter()
        .flat_map(|byte| [format!("{byte:02x}")])
        .collect()
}

fn decode_hex(source: &str) -> Vec<u8> {
    let bytes = source
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    bytes
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16).unwrap();
            let low = (pair[1] as char).to_digit(16).unwrap();
            ((high << 4) | low) as u8
        })
        .collect()
}

fn image_streams(pdf: &[u8]) -> Vec<Vec<u8>> {
    let mut streams = Vec::new();
    let mut search_from = 0;
    while let Some(relative_image) = find_bytes(&pdf[search_from..], b"/Subtype /Image") {
        let image_start = search_from + relative_image;
        let stream_marker = find_bytes(&pdf[image_start..], b"\nstream\n").unwrap();
        let stream_start = image_start + stream_marker + b"\nstream\n".len();
        let stream_end = stream_start + find_bytes(&pdf[stream_start..], b"\nendstream").unwrap();
        streams.push(pdf[stream_start..stream_end].to_vec());
        search_from = stream_end;
    }
    streams
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("evb-pdf-image-combine-provenance-{label}-{nonce}"));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
