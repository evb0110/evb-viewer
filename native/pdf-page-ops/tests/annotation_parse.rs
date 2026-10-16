use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use lopdf::{dictionary, Document, Object, StringFormat};

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

#[test]
fn parse_annotations_decodes_pdfdocencoding_text_strings() {
    let input = temporary_path("parse-pdfdocencoding-input", "pdf");
    let output = temporary_path("parse-pdfdocencoding-output", "jsonl");
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let page_id = document.new_object_id();
    // Without a Unicode BOM a PDF text string is PDFDocEncoding, where 0xE9
    // is é. Written by other tools, such strings are valid and must not
    // decode to U+FFFD.
    let note_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Text",
        "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()],
        "NM" => Object::string_literal("pdfdoc-note"),
        "Contents" => Object::String(b"caf\xe9".to_vec(), StringFormat::Hexadecimal),
        "T" => Object::String(b"Jos\xe9".to_vec(), StringFormat::Hexadecimal),
        "P" => page_id,
    });
    document.set_object(
        page_id,
        dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Annots" => vec![Object::Reference(note_id)],
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
    let chunk = serde_json::from_str::<serde_json::Value>(sidecar.lines().nth(1).unwrap()).unwrap();
    let entry = chunk["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "pdfdoc-note")
        .unwrap();
    assert_eq!(entry["kind"], "note");
    assert_eq!(entry["contents"], "café");
    assert_eq!(entry["author"], "José");

    fs::remove_file(input).unwrap();
    fs::remove_file(output).unwrap();
}

#[test]
fn parse_annotations_cli_attaches_reader_replies_to_supported_parents() {
    // PyMuPDF 1.28.2 wrote a highlight and square, each with a /Text /IRT child.
    let input = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/electron/reader-highlight-replies.pdf");
    let fixture = input;
    let input = temporary_path("reader-replies", "pdf");
    let mut document = Document::load(fixture).unwrap();
    for object in document.objects.values_mut() {
        if let Ok(dict) = object.as_dict_mut() {
            if dict.has(b"IRT") {
                dict.set("State", Object::string_literal("Accepted"));
                dict.set("StateModel", Object::string_literal("Review"));
            }
        }
    }
    document.save(&input).unwrap();
    let original = fs::read(&input).unwrap();
    let output = temporary_path("reader-replies", "jsonl");
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
    fs::remove_file(output).unwrap();
    let entries: Vec<serde_json::Value> = sidecar
        .lines()
        .skip(1)
        .flat_map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["entries"]
                .as_array()
                .unwrap()
                .clone()
        })
        .collect();
    assert_eq!(entries.len(), 2, "Replies must not become top-level notes");
    for (kind, contents, author) in [
        ("highlight", "Reader reply on highlight", "Reply author"),
        ("shape", "Reader reply on square", "Square reply author"),
    ] {
        let parent = entries.iter().find(|entry| entry["kind"] == kind).unwrap();
        assert_eq!(parent["replies"].as_array().map(Vec::len), Some(1));
        assert_eq!(parent["replies"][0]["contents"], contents);
        assert_eq!(parent["replies"][0]["author"], author);
        assert_eq!(parent["replies"][0]["state"], "Accepted");
        assert_eq!(parent["replies"][0]["stateModel"], "Review");
    }
    assert_eq!(fs::read(&input).unwrap(), original);
    fs::remove_file(input).unwrap();
}

#[test]
fn malformed_reply_preserves_its_square_and_readable_thread() {
    let input = temporary_path("malformed-reply", "pdf");
    let output = temporary_path("malformed-reply", "jsonl");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/electron/reader-highlight-replies.pdf");
    let mut document = Document::load(fixture).unwrap();
    let page_id = *document.get_pages().values().next().unwrap();
    let square_id = document
        .objects
        .iter()
        .find_map(|(id, object)| {
            let dict = object.as_dict().ok()?;
            (dict.get(b"Subtype").ok()?.as_name().ok()? == b"Square").then_some(*id)
        })
        .unwrap();
    let malformed_id = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "IRT" => square_id,
        "NM" => Object::string_literal("unreadable-reply"), "Contents" => 123,
    });
    let nested_id = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "IRT" => malformed_id,
        "Contents" => Object::string_literal("Readable descendant"),
    });
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .get_mut(b"Annots")
        .unwrap()
        .as_array_mut()
        .unwrap()
        .extend([
            Object::Reference(malformed_id),
            Object::Reference(nested_id),
        ]);
    document.save(&input).unwrap();
    let original = fs::read(&input).unwrap();
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
    let entries: Vec<serde_json::Value> = fs::read_to_string(&output)
        .unwrap()
        .lines()
        .skip(1)
        .flat_map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["entries"]
                .as_array()
                .unwrap()
                .clone()
        })
        .collect();
    let square = entries
        .iter()
        .find(|entry| entry["objectNumber"] == square_id.0)
        .unwrap();
    assert_eq!(
        square["kind"], "shape",
        "Unreadable child must not demote its parent"
    );
    assert_eq!(
        square["replies"]
            .as_array()
            .unwrap()
            .iter()
            .map(|reply| reply["contents"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["Reader reply on square", "Readable descendant"]
    );
    let unreadable = entries
        .iter()
        .find(|entry| entry["objectNumber"] == malformed_id.0)
        .unwrap();
    assert_eq!(unreadable["kind"], "foreign");
    assert_eq!(unreadable["reason"], "/Contents must be a PDF string");
    assert_eq!(entries.len(), 3);
    assert_eq!(
        fs::read(&input).unwrap(),
        original,
        "Import must leave PDF bytes intact"
    );
    fs::remove_file(input).unwrap();
    fs::remove_file(output).unwrap();
}
