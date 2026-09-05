use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use lopdf::{dictionary, Document, Object};

fn temporary_path(label: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "evb-pdf-page-ops-{label}-{}-{nonce}.{extension}",
        std::process::id()
    ))
}

#[test]
fn parse_annotations_cli_writes_the_streaming_jsonl_sidecar() {
    let input = temporary_path("parse-input", "pdf");
    let output = temporary_path("parse-output", "jsonl");
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let page_id = document.new_object_id();
    let annotation_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Text",
        "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()],
        "NM" => Object::string_literal("cli-note"),
        "Contents" => Object::string_literal("CLI note"),
        "P" => page_id,
    });
    document.set_object(
        page_id,
        dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Annots" => vec![Object::Reference(annotation_id)],
        },
    );
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args([
            "parse-annotations",
            "--input",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
            "--modified-at",
            "D:20260830130000Z",
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let sidecar = fs::read_to_string(&output).unwrap();
    let mut lines = sidecar.lines();
    let header = serde_json::from_str::<serde_json::Value>(lines.next().unwrap()).unwrap();
    assert_eq!(header["format"], "evb-pdf-annotation-parse");
    assert_eq!(header["schemaVersion"], 1);
    let chunk = serde_json::from_str::<serde_json::Value>(lines.next().unwrap()).unwrap();
    assert_eq!(chunk["entries"][0]["kind"], "note");
    assert_eq!(chunk["entries"][0]["name"], "cli-note");
    assert!(lines.next().is_none());

    fs::remove_file(input).unwrap();
    fs::remove_file(output).unwrap();
}
