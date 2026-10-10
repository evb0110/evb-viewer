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
    // A note that overhangs the page but is centred on it belongs to the
    // page, a centre on the bottom edge included, as when a split places it;
    // one centred off the page is not this page's note.
    let annotations = [
        ("cli-note", [10, 20, 30, 40]),
        ("overhanging-note", [85, 20, 105, 40]),
        ("bottom-edge-note", [40, -10, 60, 10]),
        ("off-page-note", [300, 20, 320, 40]),
    ]
    .map(|(name, rect)| {
        Object::Reference(document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "Rect" => rect.map(Object::from).to_vec(),
            "NM" => Object::string_literal(name),
            "Contents" => Object::string_literal("CLI note"),
            "P" => page_id,
        }))
    });
    document.set_object(
        page_id,
        dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Annots" => annotations.to_vec(),
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
    let kind_of = |name: &str| {
        chunk["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == name)
            .map(|entry| entry["kind"].clone())
    };
    assert_eq!(kind_of("cli-note").unwrap(), "note");
    assert_eq!(kind_of("overhanging-note").unwrap(), "note");
    assert_eq!(kind_of("bottom-edge-note").unwrap(), "note");
    assert_ne!(kind_of("off-page-note").unwrap(), "note");
    assert!(lines.next().is_none());

    fs::remove_file(input).unwrap();
    fs::remove_file(output).unwrap();
}
