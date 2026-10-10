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
