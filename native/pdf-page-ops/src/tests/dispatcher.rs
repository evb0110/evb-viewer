#[test]
fn save_mutations_preserves_geometry_updates_in_both_dispatch_modes() {
    let path = temp_pdf_path("dispatcher-geometry").with_extension("json");
    let _cleanup = RemovePdfFilesOnDrop([path.clone()]);
    std::fs::write(
        &path,
        br#"{"geometryUpdates":[{"objectNumber":42,"generationNumber":0,"pageIndex":1,"markerRect":{"left":0.1,"top":0.2,"width":0.01,"height":0.01}}]}"#,
    )
    .unwrap();

    for append in [true, false] {
        let operation = Operation::SaveMutations {
            mutations_file: path.clone(),
            modified_at: "D:20260831120000Z".to_string(),
            append,
            append_in_place: false,
            identity_bindings_file: None,
            source_path: None,
        };
        let (mutations, _) = if append {
            read_append_mutations(&operation).unwrap().unwrap()
        } else {
            read_non_append_mutations(&operation).unwrap().unwrap()
        };
        assert_eq!(mutations.geometry_updates.len(), 1);
    }
}

#[test]
fn rejects_page_selection_for_print_layout() {
    let result = crate::parse_args(
        [
            "print-layout",
            "--input",
            "input.pdf",
            "--output",
            "print.pdf",
            "--view-mode",
            "single",
            "--orientation",
            "auto",
            "--pages-file",
            "pages.txt",
        ]
        .into_iter()
        .map(String::from),
    );
    assert!(result
        .err()
        .expect("selection must not be ignored")
        .to_string()
        .contains("--pages-file"));
}

#[test]
fn deepest_bookmark_keeps_a_nested_action_through_byte_and_file_admission() {
    let mut action = serde_json::json!({"name": "URI"});
    for _ in 0..16 {
        action = serde_json::json!({"dict": [["K", action]]});
    }
    let mut item = serde_json::json!({"title":"Leaf", "pageIndex":null, "originalAction":action, "items":[]});
    for _ in 1..64 {
        item = serde_json::json!({"title":"Parent", "pageIndex":null, "items":[item]});
    }
    let source = serde_json::to_vec(&serde_json::json!({"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":[item]}})).unwrap();
    let path = temp_pdf_path("action-depth");
    fs::write(&path, &source).unwrap();
    let bytes = read_native_mutations_bytes(&source);
    let file = read_native_mutations(&path);
    fs::remove_file(path).unwrap();
    assert!(bytes.is_ok(), "{}", bytes.err().unwrap());
    assert!(file.is_ok(), "{}", file.err().unwrap());
}

#[test]
fn text_box_appearance_cli_writes_a_pdf_and_fit_metadata_without_a_source_pdf() {
    let request = temp_pdf_path("appearance-request").with_extension("json");
    let pdf = temp_pdf_path("appearance-output");
    let metadata = temp_pdf_path("appearance-metadata").with_extension("json");
    let _cleanup = RemovePdfFilesOnDrop([request.clone(), pdf.clone(), metadata.clone()]);
    write(&request, br#"{"page":{"view":[0,0,200,100],"rotation":0,"userUnit":1},"textBoxes":[{"textBox":{"pageIndex":0,"stableKey":"cli-appearance","text":"Small office","rect":[10,10,35,30],"rotation":0,"fontSize":18,"color":[17,24,39]}}]}"#).unwrap();
    run_cli_entry(vec!["text-box-appearance".to_string(), "--input".to_string(), request.to_str().unwrap().to_string(), "--output".to_string(), pdf.to_str().unwrap().to_string(), "--metadata-file".to_string(), metadata.to_str().unwrap().to_string()]).unwrap();
    let metadata: serde_json::Value = serde_json::from_slice(&read(metadata).unwrap()).unwrap();
    assert!(metadata["textBoxes"][0]["fittedFontSize"].as_f64().unwrap() < 18.0);
    let document = Document::load(pdf).unwrap();
    assert!(matches!(&collect_parsed_annotations(&document, "").unwrap()[0], PdfAnnotationParseEntry::TextBox(value) if value.text == "Small office"));
}
