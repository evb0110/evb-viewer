    /// Notes, text boxes, stamps and shapes must report newly created objects
    /// through the same identity-binding report the markup writer already
    /// feeds, so the app can refresh its object references after every save.
    fn binding_note() -> FreeTextNote {
        FreeTextNote {
            page_index: 0,
            stable_key: "uid:0:note-one".to_string(),
            text: "hello".to_string(),
            marker_rect: MarkerRect {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
            author: None,
            color: None,
            created_at: Some(1_781_009_077_000),
        }
    }

    fn binding_editor() -> TextBoxMutation {
        TextBoxMutation {
            page_index: 0,
            stable_key: "uid:0:text-box-one".to_string(),
            annotation_id: None,
            text: "box".to_string(),
            rect: [10.0, 60.0, 90.0, 80.0],
            rotation: 0,
            font_size: 12.0,
            color: [0, 0, 255],
            author: None,
            created_at: None,
            modified_at: None,
        }
    }

    fn assert_binding_ref(binding: &AnnotationIdentityBinding, expected_id: &str) -> ObjectId {
        assert_eq!(binding.annotation_id, expected_id);
        let parts: Vec<&str> = binding.pdf_ref.split(' ').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[2], "R");
        let object_number: u32 = parts[0].parse().unwrap();
        let generation: u16 = parts[1].parse().unwrap();
        assert!(object_number > 0);
        (object_number, generation)
    }

    #[test]
    fn note_and_text_box_writers_report_identity_bindings() {
        // Full-document path.
        let (mut document, page_id) = create_test_document();
        let mut bindings = Vec::new();
        upsert_free_text_notes_with_counter(
            &mut document,
            &[binding_note()],
            "D:20260830130000Z",
            &mut 0,
            &mut Some(&mut bindings),
        )
        .unwrap();
        upsert_text_boxes_with_counter(
            &mut document,
            &[binding_editor()],
            "D:20260830130000Z",
            &mut 0,
            &mut Some(&mut bindings),
        )
        .unwrap();
        assert_eq!(bindings.len(), 2);
        let note_id = assert_binding_ref(&bindings[0], "uid:0:note-one");
        let editor_id = assert_binding_ref(&bindings[1], "uid:0:text-box-one");
        // The bound refs resolve to the objects the writers created.
        assert!(document.get_object(note_id).is_ok());
        assert!(document.get_object(editor_id).is_ok());
        assert!(get_page_annots(&document, page_id)
            .unwrap()
            .iter()
            .filter_map(|annot| annot.as_reference().ok())
            .any(|annot_id| annot_id == note_id));

        // Incremental path.
        let (document, _) = create_test_document();
        let mut incremental = IncrementalDocument::from_document(document, 0, None);
        let mut bindings = Vec::new();
        upsert_free_text_notes_incremental_with_counter(
            &mut incremental,
            &[binding_note()],
            "D:20260830130000Z",
            &mut 0,
            &mut Some(&mut bindings),
        )
        .unwrap();
        upsert_text_boxes_incremental_with_counter(
            &mut incremental,
            &[binding_editor()],
            "D:20260830130000Z",
            &mut 0,
            &mut Some(&mut bindings),
        )
        .unwrap();
        assert_eq!(bindings.len(), 2);
        assert_binding_ref(&bindings[0], "uid:0:note-one");
        assert_binding_ref(&bindings[1], "uid:0:text-box-one");
    }

    #[test]
    fn writers_create_annotations_when_no_report_is_requested() {
        let (mut document, page_id) = create_test_document();
        upsert_free_text_notes_with_counter(
            &mut document,
            &[binding_note()],
            "D:20260830130000Z",
            &mut 0,
            &mut None,
        )
        .unwrap();
        upsert_text_boxes_with_counter(
            &mut document,
            &[binding_editor()],
            "D:20260830130000Z",
            &mut 0,
            &mut None,
        )
        .unwrap();
        let annotation_names = get_page_annots(&document, page_id)
            .unwrap()
            .iter()
            .filter_map(|annotation| annotation.as_reference().ok())
            .filter_map(|object_id| document.get_dictionary(object_id).ok())
            .filter_map(read_annotation_name)
            .collect::<Vec<_>>();
        assert!(annotation_names
            .iter()
            .any(|name| name == "uid:0:note-one"));
        assert!(annotation_names
            .iter()
            .any(|name| name == "uid:0:text-box-one"));
    }

    #[test]
    fn accepts_more_than_text_markup_hint_limit_in_identity_binding_report() {
        let report_path = temp_pdf_path("annotation-identity-report-cap").with_extension("json");
        let bindings = (1..=513)
            .map(|object_number| AnnotationIdentityBinding {
                annotation_id: format!("annotation-{object_number}"),
                pdf_ref: format!("{object_number} 0 R"),
            })
            .collect::<Vec<_>>();
        write_annotation_identity_bindings_report(&report_path, &bindings).unwrap();
        assert!(!read(&report_path).unwrap().is_empty());
        let _ = remove_file(report_path);
    }

    #[test]
    fn rejects_invalid_identity_report_before_in_place_append() {
        let (mut document, _) = create_test_document();
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        let pdf_path = temp_pdf_path("invalid-identity-in-place");
        let report_path =
            temp_pdf_path("invalid-identity-in-place-report").with_extension("json");
        write(&pdf_path, &original_bytes).unwrap();

        let duplicate_key = "uid:0:duplicate";
        let mut note = binding_note();
        note.stable_key = duplicate_key.to_string();
        let mut editor = binding_editor();
        editor.stable_key = duplicate_key.to_string();
        let error = append_native_mutations_in_place_with_qpdf(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                free_text_notes: vec![note],
                text_boxes: vec![editor],
                ..NativeMutationsFile::default()
            },
            "D:20260830130000Z",
            None,
            Some(&report_path),
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("duplicate or invalid binding"));
        assert_eq!(read(&pdf_path).unwrap(), original_bytes);
        assert!(!report_path.exists());
        let _ = remove_file(pdf_path);
        let _ = remove_file(report_path);
    }
