use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn timing_env_emits_one_jbig2_record_for_a_bilevel_page() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "evb-pdf-image-combine-timing-{}-{nonce}",
        std::process::id()
    ));
    let manifest_path = base.with_extension("tsv");
    let output_path = base.with_extension("pdf");
    let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../jbig2-codec/tests/fixtures/scan-page-000-body.pbm");
    fs::write(
        &manifest_path,
        format!("image-bilevel\t144\t144\t{}\n", fixture_path.display()),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-image-combine"))
        .args(["--output"])
        .arg(&output_path)
        .args(["--compact-manifest"])
        .arg(&manifest_path)
        .env("EVB_PDF_COMBINE_TIMING", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stderr = String::from_utf8(output.stderr).unwrap();
    let records = stderr
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    let timing = records
        .iter()
        .find(|record| record["type"] == "jbig2-encode-timing")
        .expect("timing mode must emit its per-mask record");
    assert_eq!(timing["type"], "jbig2-encode-timing");
    assert_eq!(timing["width"], 512);
    assert_eq!(timing["height"], 512);
    assert!(timing["elapsedMs"].as_f64().unwrap() >= 0.0);

    let _ = fs::remove_file(manifest_path);
    let _ = fs::remove_file(output_path);
}
