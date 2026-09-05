use lopdf::{dictionary, Document, Object};
use serde_json::Value;
use std::{
    env,
    fs::{read, remove_file, write},
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

fn path(label: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!(
        "evb-pdf-page-ops-error-{label}-{nonce}.{extension}"
    ))
}

struct RemovePdfFilesOnDrop<const N: usize>([PathBuf; N]);

impl<const N: usize> Drop for RemovePdfFilesOnDrop<N> {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = remove_file(path);
        }
    }
}

fn run_page_sizes(input: &Path, output: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["page-sizes", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .output()
        .unwrap()
}

fn run_page_geometry(input: &Path, output: &Path, page_number: u32) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["page-geometry", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--page")
        .arg(page_number.to_string())
        .output()
        .unwrap()
}

fn run_append(input: &Path, output: &Path, updates: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["update-note-text", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--updates-file")
        .arg(updates)
        .args(["--modified-at", "D:20260809120000Z", "--append"])
        .output()
        .unwrap()
}

fn run_save_mutations(input: &Path, output: &Path, mutations: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["save-mutations", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--mutations-file")
        .arg(mutations)
        .args(["--modified-at", "D:20260809120000Z", "--append"])
        .output()
        .unwrap()
}

fn run_crop(input: &Path, output: &Path, pages: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["crop", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--pages-file")
        .arg(pages)
        .args(["--top", "4", "--bottom", "3", "--left", "2", "--right", "1"])
        .output()
        .unwrap()
}

#[cfg(unix)]
fn run_pdf_conformance(input: &Path, output: &Path, qpdf: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["pdf-conformance", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--qpdf")
        .arg(qpdf)
        .output()
        .unwrap()
}

#[cfg(unix)]
fn write_fake_qpdf(qpdf: &Path, status: i32, structure: &str) {
    use std::os::unix::fs::PermissionsExt;

    let script = format!("#!/bin/sh\nprintf '%s' '{structure}'\nexit {status}\n");
    write(qpdf, script).unwrap();
    let mut permissions = qpdf.metadata().unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(qpdf, permissions).unwrap();
}

fn error_code(output: &Output) -> String {
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let envelope: Value = serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("invalid native error envelope ({error}): {stderr}"));
    envelope["code"].as_str().unwrap().to_string()
}

#[cfg(unix)]
#[test]
fn pdf_conformance_accepts_only_valid_qpdf_warning_output() {
    const VALID_STRUCTURE: &str = r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"/Root":"1 0 R"}},"obj:1 0 R":{"value":{"/Type":"/Catalog"}}}]}"#;
    const TRUNCATED_STRUCTURE: &str =
        r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"#;
    let input = path("qpdf-status-input", "pdf");
    let mut document = Document::with_version("1.4");
    let catalog_id = document.add_object(dictionary! { "Type" => "Catalog" });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();

    let warning_qpdf = path("qpdf-warning", "sh");
    let warning_output = path("qpdf-warning-output", "json");
    write_fake_qpdf(&warning_qpdf, 3, VALID_STRUCTURE);
    let warning_result = run_pdf_conformance(&input, &warning_output, &warning_qpdf);
    assert!(
        warning_result.status.success(),
        "valid warning-only qpdf output failed: {}",
        String::from_utf8_lossy(&warning_result.stderr)
    );
    let facts: Value = serde_json::from_slice(&read(&warning_output).unwrap()).unwrap();
    assert_eq!(facts["isSigned"], false);

    let truncated_qpdf = path("qpdf-truncated-warning", "sh");
    let truncated_output = path("qpdf-truncated-output", "json");
    write_fake_qpdf(&truncated_qpdf, 3, TRUNCATED_STRUCTURE);
    assert_eq!(
        error_code(&run_pdf_conformance(
            &input,
            &truncated_output,
            &truncated_qpdf,
        )),
        "native-failure"
    );

    let error_qpdf = path("qpdf-error", "sh");
    let error_output = path("qpdf-error-output", "json");
    write_fake_qpdf(&error_qpdf, 2, VALID_STRUCTURE);
    assert_eq!(
        error_code(&run_pdf_conformance(&input, &error_output, &error_qpdf)),
        "corrupt-xref"
    );

    for candidate in [
        input,
        warning_qpdf,
        warning_output,
        truncated_qpdf,
        truncated_output,
        error_qpdf,
        error_output,
    ] {
        let _ = remove_file(candidate);
    }
}

#[cfg(unix)]
#[test]
fn pdf_conformance_accepts_legacy_qpdf_json_and_rejects_invalid_trailer_sizes() {
    const VALID_STRUCTURE: &str = r#"{"version":1,"objects":{"trailer":{"/Size":3,"/Root":"1 0 R"},"1 0 R":{"/Type":"/Catalog","/Title":"Legacy title"}}}"#;
    const MISSING_SIZE: &str =
        r#"{"version":1,"objects":{"trailer":{"/Root":"1 0 R"},"1 0 R":{"/Type":"/Catalog"}}}"#;
    const NON_INTEGER_SIZE: &str = r#"{"version":1,"objects":{"trailer":{"/Size":"/three","/Root":"1 0 R"},"1 0 R":{"/Type":"/Catalog"}}}"#;
    const UNDERSIZED: &str = r#"{"version":1,"objects":{"trailer":{"/Size":2,"/Root":"1 0 R"},"1 0 R":{"/Type":"/Catalog"},"2 0 R":null}}"#;
    let input = path("qpdf-legacy-input", "pdf");
    let output = path("qpdf-legacy-output", "json");
    let qpdf = path("qpdf-legacy", "sh");
    let mut document = Document::with_version("1.4");
    let catalog_id = document.add_object(dictionary! { "Type" => "Catalog" });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();

    write_fake_qpdf(&qpdf, 0, VALID_STRUCTURE);
    let result = run_pdf_conformance(&input, &output, &qpdf);
    assert!(
        result.status.success(),
        "legacy qpdf JSON was rejected: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let facts: Value = serde_json::from_slice(&read(&output).unwrap()).unwrap();
    assert_eq!(facts["isSigned"], false);

    for structure in [MISSING_SIZE, NON_INTEGER_SIZE, UNDERSIZED] {
        write_fake_qpdf(&qpdf, 0, structure);
        assert_eq!(
            error_code(&run_pdf_conformance(&input, &output, &qpdf)),
            "native-failure"
        );
    }

    for candidate in [input, output, qpdf] {
        let _ = remove_file(candidate);
    }
}

#[cfg(unix)]
#[test]
fn pdf_conformance_output_is_safe_for_same_path_and_hardlink_output() {
    const VALID_STRUCTURE: &str = r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"/Root":"1 0 R"}},"obj:1 0 R":{"value":{"/Type":"/Catalog"}}}]}"#;
    let qpdf = path("qpdf-alias", "sh");
    write_fake_qpdf(&qpdf, 0, VALID_STRUCTURE);

    for hardlink_output in [false, true] {
        let label = if hardlink_output {
            "conformance-alias-hardlink"
        } else {
            "conformance-alias-same-path"
        };
        let input = path(label, "pdf");
        let output = path(&format!("{label}-output"), "json");
        let mut document = Document::with_version("1.4");
        let catalog_id = document.add_object(dictionary! { "Type" => "Catalog" });
        document.trailer.set("Root", catalog_id);
        document.save(&input).unwrap();
        let original_input = read(&input).unwrap();
        let destination = if hardlink_output {
            std::fs::hard_link(&input, &output).unwrap();
            output.clone()
        } else {
            input.clone()
        };

        let result = run_pdf_conformance(&input, &destination, &qpdf);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let facts: Value = serde_json::from_slice(&read(&destination).unwrap()).unwrap();
        assert_eq!(facts["isSigned"], false);
        if hardlink_output {
            assert_eq!(read(&input).unwrap(), original_input);
            assert!(Document::load(&input).is_ok());
        }

        for file in [input, output] {
            let _ = remove_file(file);
        }
    }

    let _ = remove_file(qpdf);
}

#[test]
fn crop_seeds_a_distinct_output_before_appending() {
    let input = path("crop-distinct-input", "pdf");
    let output = path("crop-distinct-output", "pdf");
    let pages = path("crop-distinct-pages", "txt");
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();
    write(&pages, b"1\n").unwrap();

    let result = run_crop(&input, &output, &pages);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let input_bytes = read(&input).unwrap();
    let output_bytes = read(&output).unwrap();
    assert!(output_bytes.starts_with(&input_bytes));
    assert!(output_bytes.len() > input_bytes.len());
    let cropped = Document::load(&output).unwrap();
    let crop_box = cropped
        .get_dictionary(page_id)
        .unwrap()
        .get(b"CropBox")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_float().unwrap() as f64)
        .collect::<Vec<_>>();
    assert_eq!(crop_box, vec![2.0, 3.0, 199.0, 96.0]);

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(pages);
}

#[test]
fn missing_pdf_is_io_for_direct_and_append_paths() {
    let input = path("missing-input", "pdf");
    let output = path("missing-output", "pdf");
    let updates = path("missing-updates", "json");
    write(
        &updates,
        r#"{"updates":[{"objectNumber":1,"generationNumber":0,"text":"updated"}]}"#,
    )
    .unwrap();

    assert_eq!(error_code(&run_page_sizes(&input, &output)), "io");
    assert_eq!(error_code(&run_append(&input, &output, &updates)), "io");

    let _ = remove_file(output);
    let _ = remove_file(updates);
}

#[test]
fn corrupt_pdf_is_corrupt_xref_for_direct_and_append_paths() {
    let input = path("corrupt-input", "pdf");
    let output = path("corrupt-output", "pdf");
    let updates = path("corrupt-updates", "json");
    write(&input, b"%PDF-1.7\nnot a valid PDF\n").unwrap();
    write(&output, b"%PDF-1.7\nnot a valid PDF\n").unwrap();
    write(
        &updates,
        r#"{"updates":[{"objectNumber":1,"generationNumber":0,"text":"updated"}]}"#,
    )
    .unwrap();

    assert_eq!(error_code(&run_page_sizes(&input, &output)), "corrupt-xref");
    assert_eq!(
        error_code(&run_append(&input, &output, &updates)),
        "corrupt-xref"
    );

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(updates);
}

#[test]
fn page_geometry_reports_inherited_boxes_and_rotation() {
    let input = path("geometry-input", "pdf");
    let output = path("geometry-output", "json");
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
    });
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
            "MediaBox" => vec![10.into(), 20.into(), 210.into(), 120.into()],
            "CropBox" => vec![30.into(), 40.into(), 190.into(), 100.into()],
            "Rotate" => 90,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();

    let result = run_page_geometry(&input, &output, 1);
    assert!(
        result.status.success(),
        "native page geometry failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let geometry: Value = serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
    assert_eq!(
        geometry,
        serde_json::json!({
            "mediaBox": {"x": 10.0, "y": 20.0, "width": 200.0, "height": 100.0},
            "cropBox": {"x": 30.0, "y": 40.0, "width": 160.0, "height": 60.0},
            "rotation": 90,
        })
    );

    let _ = remove_file(input);
    let _ = remove_file(output);
}

#[test]
fn page_geometry_loads_a_path_pdf_above_the_byte_input_page_ceiling() {
    const PAGE_COUNT: usize = 100_001;
    struct RemoveOnDrop(PathBuf);

    impl Drop for RemoveOnDrop {
        fn drop(&mut self) {
            let _ = remove_file(&self.0);
        }
    }

    let input = RemoveOnDrop(path("large-page-count-input", "pdf"));
    let output = RemoveOnDrop(path("large-page-count-output", "json"));
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id); PAGE_COUNT],
            "Count" => i64::try_from(PAGE_COUNT).unwrap(),
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input.0).unwrap();

    let result = run_page_geometry(&input.0, &output.0, PAGE_COUNT as u32);
    assert!(
        result.status.success(),
        "large path-backed page geometry failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let geometry: Value = serde_json::from_slice(&read(&output.0).unwrap()).unwrap();
    assert_eq!(
        geometry,
        serde_json::json!({
            "mediaBox": {"x": 0.0, "y": 0.0, "width": 200.0, "height": 100.0},
            "cropBox": null,
            "rotation": 0,
        })
    );
}

#[test]
fn save_mutations_reports_typed_aggregate_limit_for_nested_shape_sidecar() {
    let input = path("aggregate-shapes-input", "pdf");
    let output = path("aggregate-shapes-output", "pdf");
    let mutations = path("aggregate-shapes-mutations", "json");
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();

    let point = r#"{"x":0.2,"y":0.2}"#;
    let points = std::iter::repeat_n(point, 19_999)
        .collect::<Vec<_>>()
        .join(",");
    let shape = format!(
        r##"{{"type":"polyline","pageIndex":0,"x":0.1,"y":0.1,"width":0.3,"height":0.3,"color":"#336699","opacity":1,"strokeWidth":1,"pdfSubtype":"Ink","strokes":[[{points}]]}}"##,
    );
    let shapes = std::iter::repeat_n(shape.as_str(), 5)
        .collect::<Vec<_>>()
        .join(",");
    let source = format!(
        r#"{{"shapes":{{"totalPages":1,"rewriteShapeState":true,"shapes":[{shapes}],"deletedAnnotationIds":["deleted-shape"],"deletedStableKeys":[]}}}}"#,
    );
    write(&mutations, source.as_bytes()).unwrap();

    let result = run_save_mutations(&input, &output, &mutations);
    assert_eq!(
        error_code(&result),
        "too-large",
        "native stderr: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let envelope: Value = serde_json::from_slice(&result.stderr).unwrap();
    assert!(envelope["message"]
        .as_str()
        .unwrap()
        .contains("aggregate admission ceiling"));
    assert!(
        !output.exists(),
        "validation must fail before native output"
    );

    let _ = remove_file(input);
    let _ = remove_file(output);
    let _ = remove_file(mutations);
}

#[test]
fn save_mutations_cli_dispatches_text_box_and_identity_binding() {
    let input = path("text-box-cli-input", "pdf");
    let output = path("text-box-cli-output", "pdf");
    let mutations = path("text-box-cli-mutations", "json");
    let identity_bindings = path("text-box-cli-bindings", "json");

    let _cleanup = RemovePdfFilesOnDrop([
        input.clone(),
        output.clone(),
        mutations.clone(),
        identity_bindings.clone(),
    ]);

    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();
    std::fs::copy(&input, &output).unwrap();

    write(
        &mutations,
        br#"{"textBoxes":[{"pageIndex":0,"stableKey":"cli-text-box","text":"CLI text box","rect":[10,20,100,60],"rotation":0,"fontSize":16,"color":[17,24,39],"author":"Ada Lovelace","createdAt":1780000000000,"modifiedAt":1780000060000}]}"#,
    )
    .unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["save-mutations", "--input"])
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .arg("--mutations-file")
        .arg(&mutations)
        .args([
            "--modified-at",
            "D:20260831150000Z",
            "--append",
            "--identity-bindings-file",
        ])
        .arg(&identity_bindings)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "save-mutations failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    let saved = Document::load(&output).unwrap();
    let bindings: Vec<Value> = serde_json::from_slice(&read(&identity_bindings).unwrap()).unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0]["annotationId"], "cli-text-box");
    let pdf_ref = bindings[0]["pdfRef"].as_str().unwrap();
    let mut pdf_ref_parts = pdf_ref.split_whitespace();
    let object_number = pdf_ref_parts.next().unwrap().parse::<u32>().unwrap();
    let generation_number = pdf_ref_parts.next().unwrap().parse::<u16>().unwrap();
    assert_eq!(pdf_ref_parts.next(), Some("R"));
    let text_box = saved
        .get_dictionary((object_number, generation_number))
        .expect("identity binding should point to the saved text box");
    let decode_pdf_text = |value: &[u8]| {
        if !value.starts_with(&[0xfe, 0xff]) {
            return String::from_utf8(value.to_vec()).unwrap();
        }
        let chunks = value[2..].chunks_exact(2);
        assert!(
            chunks.remainder().is_empty(),
            "PDF UTF-16 string has an odd byte length"
        );
        let code_units = chunks
            .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
            .collect::<Vec<_>>();
        String::from_utf16(&code_units).unwrap()
    };
    assert_eq!(
        decode_pdf_text(text_box.get(b"NM").unwrap().as_str().unwrap()),
        "cli-text-box"
    );
    assert_eq!(
        decode_pdf_text(text_box.get(b"T").unwrap().as_str().unwrap()),
        "Ada Lovelace"
    );
    assert_eq!(
        decode_pdf_text(text_box.get(b"CreationDate").unwrap().as_str().unwrap()),
        "D:20260528202640Z"
    );
    assert_eq!(
        decode_pdf_text(text_box.get(b"M").unwrap().as_str().unwrap()),
        "D:20260528202740Z"
    );
    assert_eq!(
        decode_pdf_text(text_box.get(b"Contents").unwrap().as_str().unwrap()),
        "CLI text box"
    );
}

#[test]
fn save_mutations_cli_accepts_legacy_text_box_alias() {
    let input = path("legacy-text-box-cli-input", "pdf");
    let output = path("legacy-text-box-cli-output", "pdf");
    let mutations = path("legacy-text-box-cli-mutations", "json");
    let identity_bindings = path("legacy-text-box-cli-bindings", "json");

    let _cleanup = RemovePdfFilesOnDrop([
        input.clone(),
        output.clone(),
        mutations.clone(),
        identity_bindings.clone(),
    ]);
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document.save(&input).unwrap();
    std::fs::copy(&input, &output).unwrap();
    write(
        &mutations,
        br#"{"freeTextEditors":[{"pageIndex":0,"stableKey":"legacy-cli-text-box","text":"Legacy CLI text box","rect":[10,20,100,60],"rotation":0,"fontSize":16,"color":[17,24,39],"author":"Ada Lovelace","createdAt":1780000000000,"modifiedAt":1780000060000}]}"#,
    )
    .unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args([
            "save-mutations",
            "--input",
            input.to_str().unwrap(),
            "--output",
            output.to_str().unwrap(),
            "--mutations-file",
            mutations.to_str().unwrap(),
            "--modified-at",
            "D:20260831150000Z",
            "--append",
            "--identity-bindings-file",
            identity_bindings.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "legacy save-mutations failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    let bindings: Vec<Value> = serde_json::from_slice(&read(&identity_bindings).unwrap()).unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0]["annotationId"], "legacy-cli-text-box");
    let pdf_ref = bindings[0]["pdfRef"].as_str().unwrap();
    let mut pdf_ref_parts = pdf_ref.split_whitespace();
    let object_number = pdf_ref_parts.next().unwrap().parse::<u32>().unwrap();
    let generation_number = pdf_ref_parts.next().unwrap().parse::<u16>().unwrap();
    assert_eq!(pdf_ref_parts.next(), Some("R"));

    let saved = Document::load(&output).unwrap();
    let text_box = saved
        .get_dictionary((object_number, generation_number))
        .expect("legacy identity binding should point to the saved text box");
    assert_eq!(
        text_box.get(b"Subtype").unwrap().as_name().unwrap(),
        b"FreeText"
    );
    assert!(text_box.get(b"Contents").is_ok());
}
