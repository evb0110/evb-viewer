#[test]
fn page_rotation_normalization_handles_extreme_pdf_integers() {
    assert_eq!(normalize_page_rotation(i64::MAX), 0);
    assert_eq!(normalize_page_rotation(i64::MIN), 0);
    assert_eq!(normalize_page_rotation(-45), 270);
}

#[test]
fn incremental_rotation_normalizes_inherited_values_and_keeps_other_metadata() {
    let mut source = Document::with_version("1.7");
    let pages_id = source.new_object_id();
    let first_page_id = source.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    let second_page_id = source.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
        "Rotate" => 90,
    });
    source.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(first_page_id), Object::Reference(second_page_id)],
            "Count" => 2,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            "Rotate" => 270,
        },
    );
    let catalog_id = source.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    source.trailer.set("Root", catalog_id);
    set_page_labels(
        &mut source,
        &PageLabelsMutation {
            total_pages: 2,
            ranges: vec![PageLabelRange {
                start_page: 1,
                style: Some("D".to_string()),
                prefix: "sheet-".to_string(),
                start_number: 1,
            }],
        },
    )
    .unwrap();
    set_bookmarks(
        &mut source,
        &BookmarksMutation {
            total_pages: 2,
            untitled_label: "Untitled".to_string(),
            items: vec![BookmarkEntry {
                title: "First page".to_string(),
                page_index: Some(0),
                page_y_ratio: None,
                named_dest: None,
                bold: false,
                italic: false,
                color: None,
                items: Vec::new(),
            }],
        },
    )
    .unwrap();
    let original_catalog = source.catalog().unwrap();
    let original_page_labels = original_catalog.get(b"PageLabels").unwrap().clone();
    let original_outlines = original_catalog.get(b"Outlines").unwrap().clone();
    let mut input = Vec::new();
    source.save_to(&mut input).unwrap();

    let mutations =
        read_native_mutations_bytes(br#"{"pageRotations":[{"pageIndex":0,"angle":90}]}"#).unwrap();
    let output = append_native_mutations_to_bytes(&input, &mutations, "D:20260923000000Z")
        .expect("rotation should write an incremental revision");
    let rotated = Document::load_mem(&output.data).unwrap();
    let pages = PageTreeResolver::new(&rotated).unwrap();
    let first_page_id = pages.page_id(&rotated, 1).unwrap();
    let second_page_id = pages.page_id(&rotated, 2).unwrap();

    assert_eq!(resolve_page_rotation(&rotated, first_page_id).unwrap(), 0);
    assert_eq!(
        rotated
            .get_dictionary(first_page_id)
            .unwrap()
            .get(b"Rotate")
            .unwrap()
            .as_i64()
            .unwrap(),
        0,
        "inherited rotation should be materialized on the selected leaf"
    );
    assert_eq!(resolve_page_rotation(&rotated, second_page_id).unwrap(), 90);
    let rotated_catalog = rotated.catalog().unwrap();
    assert_eq!(
        rotated_catalog.get(b"PageLabels").unwrap(),
        &original_page_labels
    );
    assert_eq!(
        rotated_catalog.get(b"Outlines").unwrap(),
        &original_outlines
    );
    assert_eq!(output.page_count, 2);
    assert!(output.data.len() - input.len() < 16 * 1024);
}

#[test]
fn native_rotation_payload_rejects_non_quarter_turn_angles() {
    let error =
        match read_native_mutations_bytes(br#"{"pageRotations":[{"pageIndex":0,"angle":45}]}"#) {
            Ok(_) => panic!("rotation increments must be valid quarter turns"),
            Err(error) => error,
        };

    assert!(error.to_string().contains("90, 180, or 270"));

    let duplicate = match read_native_mutations_bytes(
        br#"{"pageRotations":[{"pageIndex":0,"angle":90},{"pageIndex":0,"angle":270}]}"#,
    ) {
        Ok(_) => panic!("a page must occur at most once in a rotation mutation"),
        Err(error) => error,
    };
    assert!(duplicate.to_string().contains("duplicate page index"));
}
