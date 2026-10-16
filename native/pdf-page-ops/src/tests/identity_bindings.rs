    /// Notes, text boxes, stamps and shapes must report newly created objects
    /// through the same identity-binding report the markup writer already
    /// feeds, so the app can refresh its object references after every save.
    fn binding_note() -> FreeTextNote {
        FreeTextNote {
            recovery_data: None,
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
            open: false,
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
        let object_id = parse_pdfjs_annotation_object_id(&binding.pdf_ref).unwrap();
        assert_eq!(
            parse_pdfjs_annotation_object_id(&format_pdfjs_annotation_ref(object_id)),
            Some(object_id)
        );
        object_id
    }

    #[test]
    fn note_and_text_box_writers_report_identity_bindings() {
        // Full-document path.
        let (mut document, page_id) = create_test_document();
        let mut bindings = Vec::new();
        upsert_text_notes_with_counter(
            &mut document,
            [binding_note()].iter(),
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
        upsert_text_notes_incremental_with_counter(
            &mut incremental,
            [binding_note()].iter(),
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
        upsert_text_notes_with_counter(
            &mut document,
            [binding_note()].iter(),
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
        assert!(annotation_names.iter().any(|name| name == "uid:0:note-one"));
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
        let report_path = temp_pdf_path("invalid-identity-in-place-report").with_extension("json");
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

    #[test]
    fn saved_note_rect_keeps_the_placement_center_for_every_page_rotation() {
        for rotation in [0, 90, 180, 270] {
            for incremental in [false, true] {
                let (mut document, page_id) = create_test_document();
                document
                    .get_dictionary_mut(page_id)
                    .unwrap()
                    .set("Rotate", rotation);
                let note = binding_note();
                let page_view = resolve_page_view(&document, page_id).unwrap();
                let expected = pdf_point_from_marker_point(
                    note.marker_rect.left + note.marker_rect.width / 2.0,
                    note.marker_rect.top + note.marker_rect.height / 2.0,
                    page_view,
                    rotation,
                );
                let input = temp_pdf_path("note-center-input");
                let output = temp_pdf_path("note-center-output");
                document.save(&input).unwrap();
                write(&output, read(&input).unwrap()).unwrap();
                let mutation = NativeMutationsFile {
                    notes: vec![note],
                    ..NativeMutationsFile::default()
                };
                if incremental {
                    append_native_mutations(&input, &output, &mutation, "D:20261013000000Z")
                        .unwrap();
                } else {
                    apply_native_mutations(&mut document, &mutation, "D:20261013000000Z").unwrap();
                    document.save(&output).unwrap();
                }
                let reopened = Document::load(&output).unwrap();
                let note_id = get_page_annots(&reopened, page_id)
                    .unwrap()
                    .into_iter()
                    .filter_map(|object| object.as_reference().ok())
                    .find(|id| annotation_subtype(reopened.get_dictionary(*id).unwrap()) == "text")
                    .unwrap();
                let rect = parse_rect(
                    reopened
                        .get_dictionary(note_id)
                        .unwrap()
                        .get(b"Rect")
                        .unwrap(),
                )
                .unwrap();
                assert_approximately((rect.x1 + rect.x2) / 2.0, expected.0);
                assert_approximately((rect.y1 + rect.y2) / 2.0, expected.1);
                assert_approximately(rect.width(), 20.0);
                assert_approximately(rect.height(), 20.0);
                remove_file(input).unwrap();
                remove_file(output).unwrap();
            }
        }
    }

    #[test]
    fn unnamed_ink_updates_by_canonical_reference_in_both_writers() {
        for append in [false, true] {
            let (mut document, page) = create_test_document();
            let view = resolve_page_view(&document, page).unwrap();
            let mut dict =
                create_shape_annotation_dict(&ink_shape("foreign-ink", "#2563eb"), view, 0, "")
                    .unwrap();
            dict.remove(b"NM");
            dict.remove(b"EVBShapeKey");
            let annotation = document.add_object(dict);
            document
                .get_dictionary_mut(page)
                .unwrap()
                .set("Annots", vec![Object::Reference(annotation)]);
            let mut requested = ink_shape("edited-ink", "#ef4444");
            requested.annotation_id = Some(format!("{} {} R", annotation.0, annotation.1));
            let saved = recovery_save(
                document,
                &NativeMutationsFile {
                    shapes: Some(ShapesMutation {
                        total_pages: 1,
                        rewrite_shape_state: false,
                        shapes: vec![requested],
                        deleted_annotation_ids: Vec::new(),
                        deleted_stable_keys: Vec::new(),
                    }),
                    ..Default::default()
                },
                append,
            );
            let annots = get_page_annots(&saved, page).unwrap();
            assert_eq!(annots.len(), 1);
            assert_eq!(annots[0].as_reference().unwrap(), annotation);
            let color = saved
                .get_dictionary(annotation)
                .unwrap()
                .get(b"C")
                .unwrap()
                .as_array()
                .unwrap();
            for (actual, expected) in color.iter().zip([239.0, 68.0, 68.0]) {
                assert_approximately(actual.as_float().unwrap() as f64, expected / 255.0);
            }
        }
    }

    #[test]
    fn unrelated_save_keeps_small_zero_and_previously_written_note_rects() {
        let (mut document, page_id) = create_test_document();
        let rects = [
            vec![20.into(), 60.into(), 40.into(), 80.into()], // Base writer's 20-point note.
            vec![
                number_object(60.125),
                number_object(70.25),
                number_object(60.225),
                number_object(70.35),
            ],
            vec![80.into(), 65.into(), 80.into(), 65.into()],
        ];
        let ids = rects
            .iter()
            .enumerate()
            .map(|(index, rect)| {
                document.add_object(dictionary! {
                    "Type" => "Annot", "Subtype" => "Text", "Rect" => rect.clone(),
                    "NM" => Object::string_literal(format!("untouched-{index}")),
                    "Contents" => Object::string_literal("Existing note"),
                })
            })
            .collect::<Vec<_>>();
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            ids.iter()
                .copied()
                .map(Object::Reference)
                .collect::<Vec<_>>(),
        );
        let input = temp_pdf_path("untouched-note-input");
        let output = temp_pdf_path("untouched-note-output");
        document.save(&input).unwrap();
        let original = read(&input).unwrap();
        write(&output, &original).unwrap();
        append_native_mutations(
            &input,
            &output,
            &NativeMutationsFile {
                text_boxes: vec![binding_editor()],
                ..NativeMutationsFile::default()
            },
            "D:20261013000000Z",
        )
        .unwrap();
        let written = read(&output).unwrap();
        assert!(written.starts_with(&original));
        let reopened = Document::load(&output).unwrap();
        for (id, rect) in ids.iter().zip(&rects) {
            assert_eq!(
                reopened.get_dictionary(*id).unwrap().get(b"Rect").unwrap(),
                &Object::Array(rect.clone())
            );
            let object_header = format!("\n{} {} obj", id.0, id.1);
            assert!(
                !written[original.len()..]
                    .windows(object_header.len())
                    .any(|bytes| bytes == object_header.as_bytes()),
                "Unrelated save rewrote note {id:?}"
            );
        }
        remove_file(input).unwrap();
        remove_file(output).unwrap();
    }

    #[test]
    fn full_rewrite_deletion_sizes_the_trailer_from_remaining_objects() {
        let (mut document, page, annotation) = create_test_markup_pdf("Highlight");
        apply_native_mutations(
            &mut document,
            &NativeMutationsFile {
                deletes: vec![AnnotationDelete {
                    page_index: 0,
                    object_number: Some(annotation.0),
                    generation_number: Some(annotation.1),
                    stable_key: None,
                    created_at: None,
                }],
                ..Default::default()
            },
            "D:20261013120000Z",
        )
        .unwrap();
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        let saved = Document::load_mem(&bytes).unwrap();
        assert!(get_page_annots(&saved, page).unwrap().is_empty());
        let highest = saved.objects.keys().next_back().unwrap().0;
        assert_eq!(
            saved.trailer.get(b"Size").unwrap().as_i64().unwrap(),
            i64::from(highest) + 1
        );
    }

    #[test]
    fn canonical_annotation_references_keep_object_and_generation_identity() {
        for (canonical, compact, expected) in [
            ("7 0 R", "7R", (7, 0)),
            ("17 12 R", "17R12", (17, 12)),
            (" 0017\t0\nR ", "17R", (17, 0)),
        ] {
            assert_eq!(parse_pdfjs_annotation_object_id(canonical), Some(expected));
            assert_eq!(parse_pdfjs_annotation_object_id(compact), Some(expected));
            assert_eq!(
                normalize_pdfjs_annotation_id(canonical).as_deref(),
                Some(compact)
            );
        }
        for invalid in [
            "0 0 R",
            "7 -1 R",
            "+7 0 R",
            "7 65536 R",
            "4294967296 0 R",
            "7 0 R extra",
            "7R2R",
            "7R-1",
            "7 0",
            "7 R",
            "",
        ] {
            assert!(
                parse_pdfjs_annotation_object_id(invalid).is_none(),
                "{invalid}"
            );
        }
    }
