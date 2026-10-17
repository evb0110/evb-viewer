#[path = "../../test-support/external_tool.rs"]
mod external_tool;

use std::{
    fs::{self, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use lopdf::{dictionary, Document, Object, Stream, StringFormat};
use serde_json::Value;

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
    let vendor = document.add_object(dictionary! {
        "OpaqueBytes" => Object::String(vec![0, 255, 128, 65], StringFormat::Hexadecimal),
    });
    let action = document.add_object(dictionary! {
        "S" => "URI", "URI" => Object::string_literal("https://example.test/reference"),
        "Vendor" => vendor,
    });
    let link = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link", "NM" => Object::string_literal("cli-note"),
        "Rect" => vec![0.into(), 0.into(), 20.into(), 20.into()], "A" => action,
    });
    let mut page_annotations = annotations.to_vec();
    page_annotations.insert(0, Object::Reference(link));
    for name in [None, Some(" \t\n ")] {
        let mut entry = dictionary! {
            "Type" => "Annot", "Subtype" => "link",
            "Rect" => vec![0.into(), 0.into(), 20.into(), 20.into()], "A" => action,
        };
        if let Some(name) = name {
            entry.set("NM", Object::string_literal(name));
        }
        page_annotations.insert(0, Object::Reference(document.add_object(entry)));
    }
    document.set_object(
        page_id,
        dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Annots" => page_annotations,
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
    let renamed_note = chunk["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["objectNumber"] == annotations[0].as_reference().unwrap().0)
        .unwrap();
    assert_eq!(renamed_note["kind"], "note");
    assert_ne!(renamed_note["name"], "cli-note");
    assert_eq!(kind_of("overhanging-note").unwrap(), "note");
    assert_eq!(kind_of("bottom-edge-note").unwrap(), "note");
    assert_ne!(kind_of("off-page-note").unwrap(), "note");
    assert!(kind_of("cli-note").is_none());
    assert!(lines.next().is_none());

    let mutations = temporary_path("foreign-link-edit", "json");
    let saved = temporary_path("foreign-link-saved", "pdf");
    fs::copy(&input, &saved).unwrap();
    fs::write(&mutations, r#"{"freeTextNotes":[{"pageIndex":0,"stableKey":"overhanging-note","text":"Edited note","markerRect":{"left":0.1,"top":0.1,"width":0.2,"height":0.2}}]}"#).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["save-mutations", "--append", "--input"])
        .arg(&input)
        .arg("--output")
        .arg(&saved)
        .arg("--mutations-file")
        .arg(&mutations)
        .args(["--modified-at", "D:20260830140000Z"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let saved_document = Document::load(&saved).unwrap();
    for id in [link, action, vendor] {
        assert_eq!(
            saved_document.get_object(id).unwrap(),
            document.get_object(id).unwrap()
        );
    }
    let edited = saved_document
        .get_dictionary(page_id)
        .unwrap()
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|value| {
            saved_document
                .get_dictionary(value.as_reference().ok()?)
                .ok()
        })
        .find(|dict| {
            dict.get(b"NM").ok().and_then(|value| value.as_str().ok())
                == Some(b"overhanging-note".as_slice())
        })
        .unwrap();
    assert_eq!(
        lopdf::decode_text_string(edited.get(b"Contents").unwrap()).unwrap(),
        "Edited note"
    );

    fs::remove_file(input).unwrap();
    fs::remove_file(output).unwrap();
    fs::remove_file(mutations).unwrap();
    fs::remove_file(saved).unwrap();
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

fn metadata_qpdf_path() -> PathBuf {
    if let Some(path) = std::env::var_os("QPDF_PATH") {
        return PathBuf::from(path);
    }
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        arch => arch,
    };
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../resources/qpdf/{os}-{arch}/bin"))
        .join(format!("qpdf{}", std::env::consts::EXE_SUFFIX));
    if bundled.is_file() {
        bundled
    } else {
        external_tool::tool_path("QPDF_PATH", "qpdf", "qpdf")
    }
}

fn metadata_command(operation: &str, input: &Path, output: Option<&Path>) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"));
    command.args([operation, "--input"]).arg(input);
    command.arg("--qpdf").arg(metadata_qpdf_path());
    if let Some(output) = output {
        command.arg("--output").arg(output);
    }
    if operation == "page-sizes" {
        command.arg("--metadata-only");
    }
    if operation == "parse-annotations" {
        command.args(["--modified-at", "D:20260830130000Z"]);
    }
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{operation}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    match output {
        None => serde_json::from_slice(&result.stdout).unwrap(),
        Some(output) => Value::Array(
            fs::read_to_string(output)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect(),
        ),
    }
}

/// A valid sparse stream keeps this fixture above the eager-load ceiling
/// without allocating or writing half a GiB of bytes in the test process.
fn save_large_metadata_fixture(document: &mut Document, input: &Path) {
    document.save(input).unwrap();
    let bytes = fs::read(input).unwrap();
    let marker = b"startxref\n";
    let offset = bytes
        .windows(marker.len())
        .rposition(|part| part == marker)
        .unwrap();
    let previous_xref: u64 = std::str::from_utf8(&bytes[offset + marker.len()..])
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let root = document
        .trailer
        .get(b"Root")
        .unwrap()
        .as_reference()
        .unwrap();
    let padding_id = document.max_id + 1;
    let mut file = OpenOptions::new().write(true).open(input).unwrap();
    let object_offset = file.seek(SeekFrom::End(0)).unwrap();
    let stream_bytes = 512 * 1024 * 1024 + 1;
    write!(
        file,
        "{padding_id} 0 obj\n<< /Length {stream_bytes} >>\nstream\n"
    )
    .unwrap();
    file.seek(SeekFrom::Current(stream_bytes)).unwrap();
    write!(file, "\nendstream\nendobj\n").unwrap();
    let xref = file.stream_position().unwrap();
    write!(file, "xref\n{padding_id} 1\n{object_offset:010} 00000 n \ntrailer\n<< /Size {} /Root {} {} R /Prev {previous_xref} >>\nstartxref\n{xref}\n%%EOF\n", padding_id + 1, root.0, root.1).unwrap();
}

#[test]
fn large_metadata_reads_keep_inherited_geometry_catalog_and_note_recovery_dependencies() {
    let input = temporary_path("metadata-graph", "pdf");
    let sizes = temporary_path("metadata-geometry", "jsonl");
    let annotations = temporary_path("metadata-annotations", "jsonl");
    let index = temporary_path("metadata-index", "jsonl");
    let mut document = Document::with_version("1.7");
    let pages = document.new_object_id();
    let first = document.new_object_id();
    let second = document.new_object_id();
    let media = document.add_object(Object::Array(vec![
        (-10).into(),
        (-20).into(),
        200.into(),
        100.into(),
    ]));
    let crop = document.add_object(Object::Array(vec![
        0.into(),
        0.into(),
        190.into(),
        90.into(),
    ]));
    let rotate = document.add_object(Object::Integer(90));
    let user_unit = document.add_object(Object::Real(2.0));
    let font_bytes = b"private font bytes\0retained";
    let font_stream = document.add_object(Stream::new(dictionary! {}, font_bytes.to_vec()));
    let descriptor =
        document.add_object(dictionary! {"Type" => "FontDescriptor", "FontFile2" => font_stream});
    let font = document.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "TrueType", "FontDescriptor" => descriptor},
    );
    let image_bytes = b"\xff\xd8private image bytes\xff\xd9";
    let image = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
            "Filter" => "DCTDecode", "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        },
        image_bytes.to_vec(),
    ));
    let nested_form = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "Resources" => dictionary! {"XObject" => dictionary! {"Picture" => image}},
        },
        b"/Picture Do".to_vec(),
    ));
    let appearance = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 20.into(), 20.into()],
            "Resources" => dictionary! {
                "Font" => dictionary! {"PrivateFont" => font},
                "XObject" => dictionary! {"Nested" => nested_form},
            },
        },
        b"BT /PrivateFont 10 Tf (note) Tj ET /Nested Do".to_vec(),
    ));
    let vendor_child = document.add_object(dictionary! {
        "Payload" => Object::String(vec![0xaa, 0, 0x55], StringFormat::Hexadecimal),
    });
    let private_value = document.add_object(dictionary! {
        "VendorValue" => Object::String(vec![0xff, 0, 0x41], StringFormat::Hexadecimal),
        "Nested" => dictionary! {"Type" => "Catalog", "VendorChild" => vendor_child, "P" => vendor_child},
        "NestedPage" => dictionary! {"Type" => "Page", "VendorChild" => vendor_child},
    });
    document.get_dictionary_mut(private_value).unwrap().set(
        b"Opaque Key".to_vec(),
        Object::String(vec![17, 0, 240], StringFormat::Hexadecimal),
    );
    let popup = document.new_object_id();
    let note = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "P" => first,
        "Rect" => vec![20.into(), 20.into(), 40.into(), 40.into()],
        "NM" => Object::string_literal("private-note"),
        "Contents" => Object::string_literal("A note with complete recovery"),
        "Popup" => popup, "AP" => dictionary! {"N" => appearance}, "VendorDetails" => private_value,
    });
    document.set_object(
        popup,
        dictionary! {"Type" => "Annot", "Subtype" => "Popup", "Parent" => note, "P" => first},
    );
    let reply = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link", "P" => second, "IRT" => note,
        "Contents" => Object::string_literal("A reply on another page"),
    });
    // Dense producer link payloads are foreign to the annotation editor. Their
    // metadata must stream without retaining unused actions and private arrays.
    let link_subtype = document.add_object(Object::Name(b"Link".to_vec()));
    let links = (0..1024)
        .map(|index| {
            Object::Reference(document.add_object(dictionary! {
                "Type" => "Annot", "Subtype" => link_subtype,
                "NM" => Object::string_literal(format!("producer-link-{index}")),
                "A" => dictionary! {"S" => "URI", "URI" => Object::string_literal("https://example.test/reference")},
                "ProducerPayload" => vec![Object::Integer(7); 4096],
            }))
        })
        .collect::<Vec<_>>();
    document
        .get_dictionary_mut(private_value)
        .unwrap()
        .set("VendorLink", links[0].clone());
    let mut page_annots = vec![Object::Reference(note), Object::Reference(popup)];
    page_annots.extend(links);
    let irrelevant = document.add_object(Object::Array(vec![Object::Integer(9); 1_000_000]));
    let mut direct_link = dictionary! {
        "Type" => "Annot", "Subtype" => link_subtype,
        "NM" => Object::string_literal("direct-(text)\\box"),
    };
    direct_link.set(b"Discarded\0Key".to_vec(), Object::Reference(irrelevant));
    page_annots.push(Object::Dictionary(direct_link));
    let mut direct_box = dictionary! {
        "Type" => "Annot", "Subtype" => "FreeText",
        "NM" => Object::string_literal("direct-(text)\\box"),
        "Rect" => vec![20.into(), 20.into(), 40.into(), 40.into()],
        "Contents" => Object::string_literal("Direct text box"),
        "DA" => Object::string_literal("/Helv 12 Tf 0 g"),
    };
    direct_box.set(
        b"Managed\0Key".to_vec(),
        Object::String(vec![34, 0, 255], StringFormat::Hexadecimal),
    );
    page_annots.push(Object::Dictionary(direct_box));
    let annots = document.add_object(Object::Array(page_annots));
    document.set_object(first, dictionary! {"Type" => "Page", "Parent" => pages, "Annots" => annots, "UserUnit" => user_unit});
    let deep_value = (0..80).fold(Object::Integer(7), |value, _| Object::Array(vec![value]));
    document
        .get_dictionary_mut(first)
        .unwrap()
        .set("EVBDeep", deep_value);
    let later_note = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "P" => second,
        "NM" => Object::string_literal("direct-(text)\\box"),
        "Rect" => vec![20.into(), 20.into(), 40.into(), 40.into()],
        "Contents" => Object::string_literal("Later note"),
    });
    document.set_object(
        second,
        dictionary! {
            "Type" => "Page", "Parent" => pages, "Annots" => vec![Object::Reference(reply), Object::Reference(later_note)],
            "MediaBox" => vec![0.into(), 0.into(), 400.into(), 300.into()],
            "CropBox" => vec![0.into(), 0.into(), 400.into(), 300.into()], "Rotate" => 0,
        },
    );
    document.set_object(
        pages,
        dictionary! {
            "Type" => "Pages", "Kids" => vec![Object::Reference(first), Object::Reference(second)],
            "Count" => 2, "MediaBox" => media, "CropBox" => crop, "Rotate" => rotate,
        },
    );
    let label = document.add_object(dictionary! {"Type" => "PageLabel", "S" => "r", "P" => Object::string_literal("Part-"), "St" => 3});
    let labels = document
        .add_object(dictionary! {"Nums" => vec![Object::Integer(0), Object::Reference(label)]});
    let file_spec = document.add_object(dictionary! {
        "Type" => "Filespec", "F" => Object::string_literal("reference.pdf"),
        "VendorDetails" => private_value,
    });
    let action = document.add_object(dictionary! {"S" => "GoToR", "F" => file_spec, "D" => vec![0.into(), Object::Name(b"Fit".to_vec())]});
    let outline = document.add_object(
        dictionary! {"Title" => Object::string_literal("External reference"), "A" => action},
    );
    let outlines = document.add_object(dictionary! {"First" => outline});
    let root = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages, "PageLabels" => labels, "Outlines" => outlines});
    document.trailer.set("Root", root);
    save_large_metadata_fixture(&mut document, &input);

    let geometry = metadata_command("page-sizes", &input, Some(&sizes));
    assert_eq!(geometry[0]["pageCount"], 2);
    assert_eq!(geometry[1]["pages"][0]["widthPoints"], 190.0);
    assert_eq!(geometry[1]["pages"][0]["heightPoints"], 90.0);
    assert_eq!(geometry[1]["pages"][0]["rotation"], 90);
    assert_eq!(geometry[1]["pages"][0]["userUnit"], 2.0);
    assert_eq!(geometry[1]["pages"][1]["widthPoints"], 400.0);
    let catalog = metadata_command("read-document-catalog", &input, None);
    assert_eq!(catalog["pageLabels"][0]["prefix"], "Part-");
    assert_eq!(catalog["pageLabels"][0]["start"], 3);
    assert!(
        catalog["bookmarks"][0]["originalAction"].is_object(),
        "The external bookmark action must retain its vendor dependency graph"
    );
    fn member<'a>(value: &'a Value, key: &str) -> &'a Value {
        &value["dict"]
            .as_array()
            .unwrap()
            .iter()
            .find(|pair| pair[0] == key)
            .unwrap()[1]
    }
    let file_spec = member(&catalog["bookmarks"][0]["originalAction"], "F");
    let filename = member(file_spec, "F");
    assert_eq!(
        filename.get("literal").or_else(|| filename.get("hex")),
        Some(&serde_json::json!(b"reference.pdf"))
    );
    let vendor_value = member(member(file_spec, "VendorDetails"), "VendorValue");
    assert_eq!(
        vendor_value
            .get("literal")
            .or_else(|| vendor_value.get("hex")),
        Some(&serde_json::json!([255, 0, 65]))
    );
    let vendor_payload = member(
        member(
            member(member(file_spec, "VendorDetails"), "Nested"),
            "VendorChild",
        ),
        "Payload",
    );
    assert_eq!(
        vendor_payload.get("hex"),
        Some(&serde_json::json!([170, 0, 85]))
    );
    let vendor_payload = member(
        member(
            member(member(file_spec, "VendorDetails"), "NestedPage"),
            "VendorChild",
        ),
        "Payload",
    );
    assert_eq!(
        vendor_payload.get("hex"),
        Some(&serde_json::json!([170, 0, 85]))
    );
    let parsed = metadata_command("parse-annotations", &input, Some(&annotations));
    let note = &parsed[1]["entries"][0];
    assert_eq!(note["kind"], "note");
    assert_eq!(note["replies"][0]["contents"], "A reply on another page");
    assert_eq!(parsed[1]["entries"].as_array().unwrap().len(), 3);
    assert_eq!(parsed[1]["entries"][1]["kind"], "foreign");
    assert_eq!(parsed[1]["entries"][1]["subtype"], "FreeText");
    assert_ne!(parsed[1]["entries"][1]["name"], "direct-(text)\\box");
    assert_eq!(parsed[1]["entries"][2]["kind"], "note");
    assert_eq!(parsed[1]["entries"][2]["contents"], "Later note");
    assert_ne!(parsed[1]["entries"][2]["name"], "direct-(text)\\box");
    let recovery = note["recoveryData"].as_str().unwrap();
    let recovery: Vec<u8> = recovery
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect();
    let recovered = Document::load_mem(&recovery).unwrap();
    let note = recovered
        .get_object(
            recovered
                .trailer
                .get(b"Root")
                .unwrap()
                .as_reference()
                .unwrap(),
        )
        .unwrap()
        .as_dict()
        .unwrap();
    let vendor = recovered
        .get_object(note.get(b"VendorDetails").unwrap().as_reference().unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(
        vendor.get(b"VendorValue").unwrap().as_str().unwrap(),
        &[0xff, 0, 0x41]
    );
    assert_eq!(
        vendor.get(b"Opaque Key").unwrap().as_str().unwrap(),
        &[17, 0, 240]
    );
    let nested = vendor.get(b"Nested").unwrap().as_dict().unwrap();
    let child = recovered
        .get_object(nested.get(b"VendorChild").unwrap().as_reference().unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(
        child.get(b"Payload").unwrap().as_str().unwrap(),
        &[0xaa, 0, 0x55]
    );
    let child = recovered
        .get_object(nested.get(b"P").unwrap().as_reference().unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(
        child.get(b"Payload").unwrap().as_str().unwrap(),
        &[0xaa, 0, 0x55]
    );
    let recovered_link = recovered
        .get_object(vendor.get(b"VendorLink").unwrap().as_reference().unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(
        recovered_link
            .get(b"ProducerPayload")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        4096
    );
    let nested = vendor.get(b"NestedPage").unwrap().as_dict().unwrap();
    let child = recovered
        .get_object(nested.get(b"VendorChild").unwrap().as_reference().unwrap())
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(
        child.get(b"Payload").unwrap().as_str().unwrap(),
        &[0xaa, 0, 0x55]
    );
    assert!(recovered.objects.values().any(|object| object
        .as_stream()
        .is_ok_and(|stream| stream.content == font_bytes)));
    assert!(recovered.objects.values().any(|object| object
        .as_stream()
        .is_ok_and(|stream| stream.content == image_bytes)));
    let indexed = metadata_command("annotation-name-index", &input, Some(&index));
    assert_eq!(indexed[0]["pageCount"], 2);
    assert!(indexed[1]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "private-note"));
    assert_eq!(
        indexed[1]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("producer-link-")))
            .count(),
        1024
    );
    assert_eq!(
        indexed[1]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["objectNumber"] == 0 && entry["name"] == "direct-(text)\\box")
            .count(),
        2
    );
    document
        .get_dictionary_mut(root)
        .unwrap()
        .set("Outlines", 7);
    save_large_metadata_fixture(&mut document, &input);
    let broken_outline = metadata_command("read-document-catalog", &input, None);
    assert!(broken_outline["bookmarksError"].is_string());
    assert_eq!(broken_outline["pageLabels"][0]["prefix"], "Part-");
    document
        .get_dictionary_mut(root)
        .unwrap()
        .set("Outlines", outlines);
    document
        .get_dictionary_mut(label)
        .unwrap()
        .set("S", "invalid");
    save_large_metadata_fixture(&mut document, &input);
    let broken_labels = metadata_command("read-document-catalog", &input, None);
    assert!(broken_labels["pageLabelsError"].is_string());
    assert_eq!(broken_labels["bookmarks"][0]["title"], "External reference");
    for path in [input, sizes, annotations, index] {
        fs::remove_file(path).unwrap();
    }
}

#[test]
fn selected_metadata_fields_keep_object_resource_limits() {
    for elements in [false, true] {
        let input = temporary_path("metadata-limits", "pdf");
        let output = temporary_path("metadata-limits", "jsonl");
        let mut document = Document::with_version("1.7");
        let pages = document.new_object_id();
        let (subtype, name) = if elements {
            let values = vec![Object::Integer(1); 600_000];
            (Object::Array(values.clone()), Object::Array(values))
        } else {
            let bytes = vec![b'x'; 33 * 1024 * 1024];
            (
                Object::Name(bytes.clone()),
                Object::String(bytes, StringFormat::Literal),
            )
        };
        let annotation = document.add_object(dictionary! {"Subtype" => subtype, "NM" => name});
        let page = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Annots" => vec![Object::Reference(annotation)],
        });
        document.set_object(
            pages,
            dictionary! {"Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1},
        );
        let root = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages});
        document.trailer.set("Root", root);
        save_large_metadata_fixture(&mut document, &input);
        let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
            .args(["parse-annotations", "--input"])
            .arg(&input)
            .arg("--qpdf")
            .arg(metadata_qpdf_path())
            .arg("--output")
            .arg(&output)
            .args(["--modified-at", "D:20260830130000Z"])
            .output()
            .unwrap();
        assert!(!result.status.success());
        let error: Value = serde_json::from_slice(&result.stderr).unwrap();
        assert_eq!(error["code"], "too-large");
        assert!(!output.exists());
        fs::remove_file(input).unwrap();
    }
}

#[test]
fn conformance_keeps_unreachable_signatures_and_validates_optional_catalog_dictionaries() {
    let input = temporary_path("metadata-conformance", "pdf");
    let mut document = Document::with_version("1.7");
    let pages = document.new_object_id();
    let page = document.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages,
        "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
    });
    document.set_object(
        pages,
        dictionary! {
            "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1,
        },
    );
    let signature = document.add_object(dictionary! {"Type" => "Sig", "ByteRange" => vec![0.into(), 1.into(), 2.into(), 3.into()], "Contents" => Object::string_literal("signature")});
    let root = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages, "AcroForm" => dictionary! {"XFA" => Object::string_literal("XFA payload")}, "StructTreeRoot" => dictionary! {}});
    document.trailer.set("Root", root);
    document.save(&input).unwrap();
    let facts = metadata_command("pdf-conformance", &input, None);
    assert_eq!(facts["isSigned"], true);
    assert_eq!(facts["hasAcroForm"], true);
    assert_eq!(facts["hasXfa"], true);
    assert_eq!(facts["isTagged"], true);
    document.objects.remove(&signature);
    document.add_object(dictionary! {"FT" => "Sig"});
    document.add_object(dictionary! {"V" => Object::Reference((999_999, 0))});
    document.save(&input).unwrap();
    assert_eq!(
        metadata_command("pdf-conformance", &input, None)["isSigned"],
        false
    );
    document
        .get_dictionary_mut(root)
        .unwrap()
        .set("AcroForm", 7);
    document.save(&input).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["pdf-conformance", "--input"])
        .arg(&input)
        .arg("--qpdf")
        .arg(metadata_qpdf_path())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("AcroForm is not a dictionary"));
    document
        .get_dictionary_mut(root)
        .unwrap()
        .remove(b"AcroForm");
    document.save(&input).unwrap();
    let bundle = temporary_path("metadata-invalid-runtime", "dir");
    let bin = bundle.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let qpdf = bin.join(format!("qpdf{}", std::env::consts::EXE_SUFFIX));
    fs::write(&qpdf, b"invalid executable").unwrap();
    #[cfg(windows)]
    let library = bin.join("qpdf30.dll");
    #[cfg(target_os = "macos")]
    let library = bundle.join("lib/libqpdf.30.dylib");
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let library = bundle.join("lib/libqpdf.so.30");
    fs::create_dir_all(library.parent().unwrap()).unwrap();
    fs::write(library, b"invalid shared library").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["pdf-conformance", "--input"])
        .arg(&input)
        .arg("--qpdf")
        .arg(&qpdf)
        .output()
        .unwrap();
    assert!(!result.status.success());
    let error: Value = serde_json::from_slice(&result.stderr).unwrap();
    assert_eq!(error["code"], "native-failure");
    assert!(error["message"]
        .as_str()
        .unwrap()
        .contains("Cannot load bundled qpdf library"));
    fs::remove_dir_all(bundle).unwrap();
    fs::remove_file(input).unwrap();
}
