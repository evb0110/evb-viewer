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
    let result = crate::cli::parse_args(
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
