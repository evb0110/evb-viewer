struct RemovePdfFilesOnDrop<const N: usize>([PathBuf; N]);

impl<const N: usize> Drop for RemovePdfFilesOnDrop<N> {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = remove_file(path);
        }
    }
}

#[test]
fn updates_note_text_on_target_and_popup() {
    let mut document = Document::with_version("1.7");
    let popup_id = document.add_object(dictionary! {
        "Subtype" => "Popup",
        "Contents" => Object::string_literal("old popup"),
    });
    let target_id = document.add_object(dictionary! {
        "Subtype" => "FreeText",
        "Contents" => Object::string_literal("old target"),
        "Popup" => popup_id,
    });

    update_annotation_text_by_ref(
        &mut document,
        target_id,
        "hello \u{1F642}",
        "D:20260609123456+03'00'",
    )
    .unwrap();

    assert_eq!(
        string_bytes(&document, target_id, b"Contents"),
        encode_pdf_text_string("hello \u{1F642}")
    );
    assert_eq!(
        string_bytes(&document, popup_id, b"Contents"),
        encode_pdf_text_string("hello \u{1F642}")
    );
    assert_eq!(
        string_bytes(&document, target_id, b"M"),
        b"D:20260609123456+03'00'".to_vec()
    );
}

#[test]
fn updates_popup_parent_when_target_is_popup() {
    let mut document = Document::with_version("1.7");
    let parent_id = document.add_object(dictionary! {
        "Subtype" => "Text",
        "Contents" => Object::string_literal("old parent"),
    });
    let popup_id = document.add_object(dictionary! {
        "Subtype" => "Popup",
        "Contents" => Object::string_literal("old popup"),
        "Parent" => parent_id,
    });

    update_annotation_text_by_ref(&mut document, popup_id, "edited", "D:20260609123456Z").unwrap();

    assert_eq!(
        string_bytes(&document, popup_id, b"Contents"),
        encode_pdf_text_string("edited")
    );
    assert_eq!(
        string_bytes(&document, parent_id, b"Contents"),
        encode_pdf_text_string("edited")
    );
}

#[test]
fn appends_imported_text_note_geometry_and_linked_popup_to_new_page() {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let page_one_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    let page_two_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_one_id), Object::Reference(page_two_id)],
            "Count" => 2,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);

    let popup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "P" => page_one_id,
        "Rect" => vec![10.into(), 60.into(), 40.into(), 90.into()],
    });
    let target_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Text",
        "P" => page_one_id,
        "Rect" => vec![10.into(), 60.into(), 40.into(), 90.into()],
        "Popup" => popup_id,
        "Contents" => Object::string_literal("note"),
    });
    document
        .get_dictionary_mut(popup_id)
        .unwrap()
        .set("Parent", Object::Reference(target_id));
    document.get_dictionary_mut(page_one_id).unwrap().set(
        "Annots",
        vec![Object::Reference(target_id), Object::Reference(popup_id)],
    );

    let input_path = temp_pdf_path("append-note-geometry-input");
    let output_path = temp_pdf_path("append-note-geometry-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            geometry_updates: vec![NoteGeometryUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                page_index: 1,
                marker_rect: MarkerRect {
                    left: 0.6,
                    top: 0.25,
                    width: 0.15,
                    height: 0.12,
                },
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456Z",
    )
    .unwrap();

    let loaded = Document::load(&output_path).unwrap();
    let page_one_annots = get_page_annots(&loaded, page_one_id).unwrap();
    let page_two_annots = get_page_annots(&loaded, page_two_id).unwrap();
    assert!(!page_one_annots.iter().any(|object| {
        object.as_reference().ok() == Some(target_id)
            || object.as_reference().ok() == Some(popup_id)
    }));
    assert!(page_two_annots
        .iter()
        .any(|object| object.as_reference().ok() == Some(target_id)));
    assert!(page_two_annots
        .iter()
        .any(|object| object.as_reference().ok() == Some(popup_id)));

    let expected_rect = PdfRect {
        x1: 120.0,
        y1: 55.0,
        x2: 140.0,
        y2: 75.0,
    };
    let target = loaded.get_dictionary(target_id).unwrap();
    assert_eq!(
        target.get(b"P").unwrap().as_reference().unwrap(),
        page_two_id
    );
    assert_approximately(
        parse_rect(target.get(b"Rect").unwrap()).unwrap().x1,
        expected_rect.x1,
    );
    assert_approximately(
        parse_rect(target.get(b"Rect").unwrap()).unwrap().y1,
        expected_rect.y1,
    );
    let popup = loaded.get_dictionary(popup_id).unwrap();
    assert_eq!(
        popup.get(b"P").unwrap().as_reference().unwrap(),
        page_two_id
    );
    let popup_rect = parse_rect(popup.get(b"Rect").unwrap()).unwrap();
    assert_approximately(popup_rect.x1, expected_rect.x1);
    assert_approximately(popup_rect.y1, expected_rect.y1);
    assert_approximately(popup_rect.x2, expected_rect.x2);
    assert_approximately(popup_rect.y2, expected_rect.y2);

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn reports_missing_note_text_update_targets() {
    let mut document = Document::with_version("1.7");
    let updates = vec![NoteTextUpdate {
        object_number: 404,
        generation_number: 0,
        text: "missing".to_string(),
    }];

    assert!(update_note_text(&mut document, &updates, "D:20260609123456Z").is_err());
}

#[test]
fn appends_note_text_update_as_incremental_revision() {
    let (mut document, target_id, popup_id) = create_test_note_pdf();
    let input_path = temp_pdf_path("append-input");
    let output_path = temp_pdf_path("append-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "incremental hello".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let output_bytes = read(&output_path).unwrap();
    assert!(output_bytes.starts_with(&original_bytes));
    assert!(output_bytes.len() > original_bytes.len());
    assert!(output_bytes
        .windows(b"/Prev".len())
        .any(|window| window == b"/Prev"));

    let loaded = Document::load(&output_path).unwrap();
    assert_eq!(
        string_bytes(&loaded, target_id, b"Contents"),
        encode_pdf_text_string("incremental hello")
    );
    assert_eq!(
        string_bytes(&loaded, popup_id, b"Contents"),
        encode_pdf_text_string("incremental hello")
    );

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn validates_incremental_append_tail_without_full_document_load() {
    let (mut document, target_id, popup_id) = create_test_note_pdf();
    let input_path = temp_pdf_path("append-tail-valid-input");
    let output_path = temp_pdf_path("append-tail-valid-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();
    let previous_document = Document::load(&input_path).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "tail validation".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    validate_incremental_append_output(
        &output_path,
        u64::try_from(original_bytes.len()).unwrap(),
        previous_document.xref_start,
        &[target_id, popup_id],
    )
    .unwrap();

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn rejects_incremental_append_tail_with_corrupt_object_header() {
    let (mut document, target_id, popup_id) = create_test_note_pdf();
    document.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
    let input_path = temp_pdf_path("append-tail-corrupt-input");
    let output_path = temp_pdf_path("append-tail-corrupt-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();
    let previous_document = Document::load(&input_path).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "tail corruption".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let mut output_bytes = read(&output_path).unwrap();
    let object_header = format!("{} {} obj", target_id.0, target_id.1);
    let appended_offset = output_bytes[original_bytes.len()..]
        .windows(object_header.len())
        .position(|window| window == object_header.as_bytes())
        .unwrap()
        + original_bytes.len();
    let corrupt_header = vec![b'x'; object_header.len()];
    output_bytes[appended_offset..appended_offset + object_header.len()]
        .copy_from_slice(&corrupt_header);
    write(&output_path, &output_bytes).unwrap();

    let error = validate_incremental_append_output(
        &output_path,
        u64::try_from(original_bytes.len()).unwrap(),
        previous_document.xref_start,
        &[target_id, popup_id],
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("does not point to its object header"));

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn append_note_text_update_requires_output_copy() {
    let (mut document, target_id, _) = create_test_note_pdf();
    let input_path = temp_pdf_path("append-copy-input");
    let output_path = temp_pdf_path("append-copy-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    let wrong_same_size_bytes = vec![b'x'; original_bytes.len()];
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &wrong_same_size_bytes).unwrap();

    let error = append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "incremental hello".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
    )
    .unwrap_err()
    .to_string();

    assert!(error.contains("byte-for-byte copy"));

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn rolls_back_target_bytes_when_incremental_append_fails_mid_write() {
    struct FaultInjectingTarget {
        bytes: Vec<u8>,
        remaining_before_failure: usize,
        rollback_count: usize,
        sync_count: usize,
    }

    impl Write for FaultInjectingTarget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.remaining_before_failure == 0 {
                return Err(std::io::Error::other("injected append failure"));
            }
            let written = bytes.len().min(self.remaining_before_failure);
            self.bytes.extend_from_slice(&bytes[..written]);
            self.remaining_before_failure -= written;
            Ok(written)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl AppendRollback for FaultInjectingTarget {
        fn rollback_to(&mut self, len: u64) -> std::io::Result<()> {
            self.bytes.truncate(usize::try_from(len).unwrap());
            self.rollback_count += 1;
            Ok(())
        }

        fn sync_all(&mut self) -> std::io::Result<()> {
            self.sync_count += 1;
            Ok(())
        }
    }

    let original = b"%PDF-1.7\noriginal revision\n%%EOF\n";
    let mut target = FaultInjectingTarget {
        bytes: original.to_vec(),
        remaining_before_failure: 7,
        rollback_count: 0,
        sync_count: 0,
    };

    let error = write_incremental_revision_transactionally(
        &mut target,
        u64::try_from(original.len()).unwrap(),
        |writer| {
            writer.write_all(b"partial incremental revision that must be rolled back")?;
            Ok(())
        },
    )
    .unwrap_err();

    assert!(error.to_string().contains("injected append failure"));
    assert_eq!(target.bytes, original);
    assert_eq!(target.rollback_count, 1);
    assert_eq!(target.sync_count, 1);
}

#[test]
fn append_seed_check_detects_same_file_aliases() {
    let input_path = temp_pdf_path("append-same-file-detect");
    write(&input_path, b"%PDF-1.7\n").unwrap();
    let alias_path = input_path
        .parent()
        .unwrap()
        .join(".")
        .join(input_path.file_name().unwrap());
    let other_path = temp_pdf_path("append-other-file-detect");
    write(&other_path, b"%PDF-1.7\n").unwrap();

    assert!(append_paths_refer_to_same_file(&input_path, &input_path));
    assert!(append_paths_refer_to_same_file(&input_path, &alias_path));
    assert!(!append_paths_refer_to_same_file(&input_path, &other_path));

    let _ = remove_file(input_path);
    let _ = remove_file(other_path);
}

#[test]
fn appends_note_text_update_when_input_and_output_are_same_file() {
    let (mut document, target_id, popup_id) = create_test_note_pdf();
    let pdf_path = temp_pdf_path("append-in-place");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "same path update".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let output_bytes = read(&pdf_path).unwrap();
    assert!(output_bytes.starts_with(&original_bytes));
    assert!(output_bytes.len() > original_bytes.len());

    let loaded = Document::load(&pdf_path).unwrap();
    assert_eq!(
        string_bytes(&loaded, target_id, b"Contents"),
        encode_pdf_text_string("same path update")
    );
    assert_eq!(
        string_bytes(&loaded, popup_id, b"Contents"),
        encode_pdf_text_string("same path update")
    );

    let _ = remove_file(pdf_path);
}

#[test]
fn appends_private_staged_mutations_in_place_and_rolls_back_failed_revisions() {
    let (mut document, target_id, _) = create_test_note_pdf();
    let pdf_path = temp_pdf_path("append-private-stage-in-place");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations_in_place_with_qpdf(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "private staged update".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
        None,
        None,
    )
    .unwrap();

    let after_success = read(&pdf_path).unwrap();
    assert!(after_success.starts_with(&original_bytes));
    assert!(after_success.len() > original_bytes.len());

    let failed_revision = append_native_mutations_in_place_with_qpdf(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: 404,
                generation_number: 0,
                text: "must roll back".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
        None,
        None,
    );
    assert!(failed_revision.is_err());
    assert_eq!(read(&pdf_path).unwrap(), after_success);

    let prefix = format!(
        ".{}.evb-tmp-",
        pdf_path.file_name().unwrap().to_string_lossy()
    );
    assert!(!fs::read_dir(pdf_path.parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)));
    let _ = remove_file(pdf_path);
}

#[cfg(windows)]
#[test]
fn windows_in_place_append_succeeds_when_delete_sharing_is_denied() {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;

    let (mut document, target_id, _) = create_test_note_pdf();
    let pdf_path = temp_pdf_path("append-no-delete-share");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();
    let held_reader = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&pdf_path)
        .unwrap();
    let mutations = NativeMutationsFile {
        updates: vec![NoteTextUpdate {
            object_number: target_id.0,
            generation_number: target_id.1,
            text: "update without delete sharing".to_string(),
        }],
        ..NativeMutationsFile::default()
    };

    let staged_error = append_native_mutations_with_qpdf(
        &pdf_path,
        &pdf_path,
        &mutations,
        "D:20260609123456Z",
        None,
        None,
    )
    .expect_err("staged publication must require delete sharing");
    assert!(
        staged_error.to_string().contains("os error 5"),
        "unexpected staged publication error: {staged_error}",
    );
    assert_eq!(read(&pdf_path).unwrap(), original_bytes);

    append_native_mutations_in_place_with_qpdf(
        &pdf_path,
        &pdf_path,
        &mutations,
        "D:20260609123456Z",
        None,
        None,
    )
    .unwrap();

    let updated_bytes = read(&pdf_path).unwrap();
    assert!(updated_bytes.starts_with(&original_bytes));
    let updated = Document::load(&pdf_path).unwrap();
    assert_eq!(
        string_bytes(&updated, target_id, b"Contents"),
        encode_pdf_text_string("update without delete sharing"),
    );

    drop(held_reader);
    let _ = remove_file(pdf_path);
}

#[test]
fn rejects_private_staged_append_to_a_distinct_output_path() {
    let (mut document, target_id, _) = create_test_note_pdf();
    let input_path = temp_pdf_path("append-private-stage-input");
    let output_path = temp_pdf_path("append-private-stage-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();

    let error = append_native_mutations_in_place_with_qpdf(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "must be rejected".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456Z",
        None,
        None,
    )
    .unwrap_err();

    assert!(error.to_string().contains("identical input and output paths"));
    assert_eq!(read(&input_path).unwrap(), original_bytes);
    assert_eq!(read(&output_path).unwrap(), original_bytes);
    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn appends_annotation_delete_as_incremental_revision() {
    let (mut document, page_id) = create_test_document();
    let popup_id = document.add_object(dictionary! {
        "Subtype" => "Popup",
        "Contents" => Object::string_literal("popup"),
    });
    let target_id = document.add_object(dictionary! {
        "Subtype" => "Text",
        "Contents" => Object::string_literal("note"),
        "Popup" => popup_id,
    });
    let unrelated_id = document.add_object(dictionary! {
        "Subtype" => "Highlight",
        "Contents" => Object::string_literal("keep"),
    });
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        vec![
            Object::Reference(target_id),
            Object::Reference(popup_id),
            Object::Reference(unrelated_id),
        ],
    );
    let input_path = temp_pdf_path("append-delete-input");
    let output_path = temp_pdf_path("append-delete-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            free_text_notes: Vec::new(),
            deletes: vec![AnnotationDelete {
                page_index: 0,
                object_number: Some(target_id.0),
                generation_number: Some(target_id.1),
                stable_key: None,
                created_at: None,
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let output_bytes = read(&output_path).unwrap();
    assert!(output_bytes.starts_with(&original_bytes));
    assert!(output_bytes.len() > original_bytes.len());

    let loaded = Document::load(&output_path).unwrap();
    let annots = get_page_annots(&loaded, page_id).unwrap();
    let refs: Vec<ObjectId> = annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .collect();
    assert!(!refs.contains(&target_id));
    assert!(!refs.contains(&popup_id));
    assert!(refs.contains(&unrelated_id));

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn deletes_popup_free_text_by_stable_key_when_page_geometry_is_unavailable() {
    let (mut document, page_id) = create_test_document();
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("MediaBox", vec![0.into(), 0.into(), 1.into()]);
    assert!(resolve_page_view(&document, page_id).is_err());

    let text_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Text",
        "Rect" => vec![10.into(), 60.into(), 30.into(), 80.into()],
        "NM" => Object::string_literal("text-note"),
        "P" => page_id,
    });
    let popup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Rect" => vec![10.into(), 60.into(), 30.into(), 80.into()],
        "P" => page_id,
    });
    let free_text_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "FreeText",
        "Rect" => vec![10.into(), 60.into(), 11.into(), 61.into()],
        "NM" => Object::string_literal("evb-note:missing-geometry"),
        "Popup" => popup_id,
        "P" => page_id,
    });
    document
        .get_dictionary_mut(popup_id)
        .unwrap()
        .set("Parent", Object::Reference(free_text_id));
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        vec![
            Object::Reference(text_id),
            Object::Reference(free_text_id),
            Object::Reference(popup_id),
        ],
    );

    let temp_paths = RemovePdfFilesOnDrop([
        temp_pdf_path("delete-free-text-missing-geometry-input"),
        temp_pdf_path("delete-free-text-missing-geometry-output"),
    ]);
    let input_path = &temp_paths.0[0];
    let output_path = &temp_paths.0[1];
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(input_path, &original_bytes).unwrap();
    write(output_path, &original_bytes).unwrap();

    append_native_mutations(
        input_path,
        output_path,
        &NativeMutationsFile {
            deletes: vec![AnnotationDelete {
                page_index: 0,
                object_number: None,
                generation_number: None,
                stable_key: Some("missing-geometry".to_string()),
                created_at: None,
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260831130000Z",
    )
    .unwrap();

    let loaded = Document::load(output_path).unwrap();
    let refs: Vec<ObjectId> = get_page_annots(&loaded, page_id)
        .unwrap()
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .collect();
    assert!(refs.contains(&text_id));
    assert!(!refs.contains(&free_text_id));
    assert!(!refs.contains(&popup_id));
}

#[test]
fn deletes_a_note_popup_and_transitive_reply_chain() {
    fn fixture() -> (Document, ObjectId, [ObjectId; 4], ObjectId) {
        let (mut document, page_id) = create_test_document();
        let popup_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Popup",
            "Contents" => Object::string_literal("popup"),
            "P" => Object::Reference(page_id),
        });
        let note_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "NM" => Object::string_literal("note-with-replies"),
            "Contents" => Object::string_literal("note"),
            "Popup" => Object::Reference(popup_id),
            "P" => Object::Reference(page_id),
        });
        document
            .get_dictionary_mut(popup_id)
            .unwrap()
            .set("Parent", Object::Reference(note_id));
        let reply_one_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "IRT" => Object::Reference(note_id),
            "Contents" => Object::string_literal("reply one"),
            "P" => Object::Reference(page_id),
        });
        let reply_two_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "IRT" => Object::Reference(reply_one_id),
            "Contents" => Object::string_literal("reply two"),
            "P" => Object::Reference(page_id),
        });
        let unrelated_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Highlight",
            "Contents" => Object::string_literal("keep"),
            "P" => Object::Reference(page_id),
        });
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            vec![
                Object::Reference(note_id),
                Object::Reference(popup_id),
                Object::Reference(reply_one_id),
                Object::Reference(reply_two_id),
                Object::Reference(unrelated_id),
            ],
        );
        (
            document,
            page_id,
            [note_id, popup_id, reply_one_id, reply_two_id],
            unrelated_id,
        )
    }

    let (mut document, page_id, deleted_ids, unrelated_id) = fixture();
    delete_annotations(
        &mut document,
        &[AnnotationDelete {
            page_index: 0,
            object_number: Some(deleted_ids[0].0),
            generation_number: Some(deleted_ids[0].1),
            stable_key: None,
            created_at: None,
        }],
    )
    .unwrap();
    assert_eq!(
        get_page_annots(&document, page_id).unwrap(),
        vec![Object::Reference(unrelated_id)]
    );
    for object_id in deleted_ids {
        assert!(!document.objects.contains_key(&object_id));
    }

    let (document, page_id, deleted_ids, unrelated_id) = fixture();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    delete_annotations_incremental(
        &mut incremental,
        &[AnnotationDelete {
            page_index: 0,
            object_number: Some(deleted_ids[0].0),
            generation_number: Some(deleted_ids[0].1),
            stable_key: None,
            created_at: None,
        }],
    )
    .unwrap();
    let revision = AppendedRevision::new(&incremental);
    assert_eq!(
        get_page_annots(&revision, page_id).unwrap(),
        vec![Object::Reference(unrelated_id)]
    );
    for object_id in deleted_ids {
        assert!(matches!(revision.object(object_id), Ok(Object::Null)));
    }
}

#[test]
fn deletes_explicit_annotation_ref_from_its_p_page_when_page_hint_is_stale() {
    let (mut document, _first_page_id, last_page_id) = create_sparse_million_page_document();
    let target_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Text",
        "P" => Object::Reference(last_page_id),
        "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
    });
    document
        .get_dictionary_mut(last_page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(target_id)]);
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    let delete = AnnotationDelete {
        page_index: 0,
        object_number: Some(target_id.0),
        generation_number: Some(target_id.1),
        stable_key: None,
        created_at: None,
    };

    assert!(incremental.previous_document.get_object(target_id).is_ok());
    assert_eq!(
        annotation_page_id(&incremental.previous_document, target_id),
        Some(last_page_id)
    );
    assert_eq!(
        get_page_annots(&incremental.previous_document, last_page_id)
            .unwrap()
            .as_slice(),
        [Object::Reference(target_id)]
    );
    reset_page_tree_node_read_count();
    delete_annotations_incremental(&mut incremental, std::slice::from_ref(&delete)).unwrap();

    let revision = AppendedRevision::new(&incremental);
    assert!(get_page_annots(&revision, last_page_id).unwrap().is_empty());
    assert!(page_tree_node_read_count() < 100);
}

#[test]
fn annotation_delete_postconditions_check_the_explicit_p_page() {
    let (mut document, _first_page_id, last_page_id) = create_sparse_million_page_document();
    let target_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Text",
        "P" => Object::Reference(last_page_id),
        "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
    });
    document
        .get_dictionary_mut(last_page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(target_id)]);
    let delete = AnnotationDelete {
        page_index: 0,
        object_number: Some(target_id.0),
        generation_number: Some(target_id.1),
        stable_key: None,
        created_at: None,
    };
    let source = NoDensePageIds(&document);

    reset_page_tree_node_read_count();
    let error = validate_annotation_delete_document_postconditions(&source, &[delete])
        .expect_err("a referenced annotation must fail delete postconditions");

    assert!(error
        .to_string()
        .contains("Deleted annotation is still referenced"));
    assert!(page_tree_node_read_count() < 100);
}

#[test]
fn appends_free_text_note_delete_by_stable_key_as_incremental_revision() {
    let (mut document, page_id) = create_test_document();
    let pdf_path = temp_pdf_path("append-free-text-delete-stable-key");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            free_text_notes: vec![FreeTextNote {
                page_index: 0,
                stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                text: "delete me".to_string(),
                marker_rect: MarkerRect {
                    left: 0.1,
                    top: 0.2,
                    width: 0.0016,
                    height: 0.0016,
                },
                author: None,
                color: None,
                created_at: Some(1781009077000),
            }],
            deletes: Vec::new(),
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            free_text_notes: Vec::new(),
            deletes: vec![AnnotationDelete {
                page_index: 0,
                object_number: None,
                generation_number: None,
                stable_key: Some("uid:0:pdfjs_internal_editor_0".to_string()),
                created_at: Some(1781009077000),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123500+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let annots = get_page_annots(&loaded, page_id).unwrap();
    let refs: Vec<ObjectId> = annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .collect();
    assert!(refs.iter().all(|object_id| {
        !annotation_matches_stable_delete_name(
            &loaded,
            *object_id,
            &AnnotationDelete {
                page_index: 0,
                object_number: None,
                generation_number: None,
                stable_key: Some("uid:0:pdfjs_internal_editor_0".to_string()),
                created_at: Some(1781009077000),
            },
        )
        .unwrap()
    }));

    let _ = remove_file(pdf_path);
}

#[test]
fn appends_free_text_note_as_text_annotation_for_legacy_callers() {
    let (mut document, page_id) = create_test_document();
    let input_path = temp_pdf_path("append-free-text-input");
    let output_path = temp_pdf_path("append-free-text-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            free_text_notes: vec![FreeTextNote {
                page_index: 0,
                stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                text: "native editor note".to_string(),
                marker_rect: MarkerRect {
                    left: 0.1,
                    top: 0.2,
                    width: 0.0016,
                    height: 0.0016,
                },
                author: Some("Tester".to_string()),
                color: Some("rgba(255, 204, 0, 0.8)".to_string()),
                created_at: Some(1781009077000),
            }],
            deletes: Vec::new(),
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let output_bytes = read(&output_path).unwrap();
    assert!(output_bytes.starts_with(&original_bytes));
    assert!(output_bytes
        .windows(b"/Prev".len())
        .any(|window| window == b"/Prev"));

    let loaded = Document::load(&output_path).unwrap();
    let annots = get_page_annots(&loaded, page_id).unwrap();
    let text_ref = annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .find(|object_id| {
            loaded
                .get_dictionary(*object_id)
                .map(|dict| annotation_subtype(dict) == "text")
                .unwrap_or(false)
        })
        .unwrap();
    assert!(!annots.iter().filter_map(|object| object.as_reference().ok()).any(|object_id| {
        loaded
            .get_dictionary(object_id)
            .map(|dict| annotation_subtype(dict) == "freetext")
            .unwrap_or(false)
    }));
    let popup_ref = annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .find(|object_id| {
            loaded
                .get_dictionary(*object_id)
                .map(|dict| annotation_subtype(dict) == "popup")
                .unwrap_or(false)
        })
        .unwrap();
    let text_note = loaded.get_dictionary(text_ref).unwrap();
    let popup = loaded.get_dictionary(popup_ref).unwrap();
    let rect = parse_rect(text_note.get(b"Rect").unwrap()).unwrap();

    assert_eq!(
        string_bytes(&loaded, text_ref, b"Contents"),
        encode_pdf_text_string("native editor note")
    );
    assert_eq!(
        string_bytes(&loaded, popup_ref, b"Contents"),
        encode_pdf_text_string("native editor note")
    );
    assert_eq!(
        pdf_string_to_text(text_note.get(b"NM").unwrap()).unwrap(),
        "uid:0:pdfjs_internal_editor_0"
    );
    assert_eq!(text_note.get(b"Name").unwrap().as_name().unwrap(), b"Note");
    assert_eq!(
        pdf_string_to_text(text_note.get(b"CreationDate").unwrap()).unwrap(),
        "D:20260609124437Z"
    );
    assert_eq!(annotation_related_ref(text_note, b"Popup"), Some(popup_ref));
    assert_eq!(
        annotation_related_ref(popup, b"Parent"),
        Some(text_ref)
    );
    assert!(text_note.get(b"AP").is_err());
    assert_approximately(rect.width(), 20.0);
    assert_approximately(rect.height(), 20.0);
    assert_approximately(rect.x1, 20.0);
    assert_approximately(rect.y1, 60.0);

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn canonical_notes_input_also_writes_a_text_annotation() {
    let (mut document, page_id) = create_test_document();
    let input_path = temp_pdf_path("append-canonical-text-note-input");
    let output_path = temp_pdf_path("append-canonical-text-note-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            notes: vec![TextNote {
                page_index: 0,
                stable_key: "canonical-note".to_string(),
                text: "canonical text".to_string(),
                marker_rect: MarkerRect {
                    left: 0.3,
                    top: 0.4,
                    width: 0.001,
                    height: 0.001,
                },
                author: Some("Canonical author".to_string()),
                color: Some("#336699".to_string()),
                created_at: None,
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260831120000Z",
    )
    .unwrap();

    let loaded = Document::load(&output_path).unwrap();
    let note_refs = get_page_annots(&loaded, page_id)
        .unwrap()
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter(|object_id| {
            loaded
                .get_dictionary(*object_id)
                .map(|dict| annotation_subtype(dict) == "text")
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    assert_eq!(note_refs.len(), 1);
    let note = loaded.get_dictionary(note_refs[0]).unwrap();
    assert_eq!(
        pdf_string_to_text(note.get(b"Contents").unwrap()).as_deref(),
        Some("canonical text")
    );
    assert_eq!(
        pdf_string_to_text(note.get(b"NM").unwrap()).as_deref(),
        Some("canonical-note")
    );
    assert_eq!(
        pdf_string_to_text(note.get(b"T").unwrap()).as_deref(),
        Some("Canonical author")
    );
    assert_eq!(note.get(b"Name").unwrap().as_name().unwrap(), b"Note");
    let rect = parse_rect(note.get(b"Rect").unwrap()).unwrap();
    assert_approximately(rect.width(), 20.0);
    assert_approximately(rect.height(), 20.0);

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn first_edit_converts_only_the_target_marker_and_preserves_its_payload() {
    let (mut document, page_id) = create_test_document();
    let blank_appearance = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        },
        Vec::new(),
    ));
    let target_popup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Parent" => (0, 0),
        "Rect" => vec![20.into(), 60.into(), 21.into(), 61.into()],
        "Contents" => Object::string_literal("legacy note"),
    });
    let target_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "FreeText",
        "Rect" => vec![20.into(), 60.into(), 21.into(), 61.into()],
        "NM" => Object::string_literal("legacy-target"),
        "Contents" => Object::string_literal("legacy note"),
        "DA" => Object::string_literal("/Helv 12 Tf 0 0 0 rg"),
        "AP" => dictionary! {"N" => blank_appearance},
        "Popup" => target_popup_id,
        "IRT" => (900, 0),
        "UnknownKey" => Object::string_literal("keep me"),
        "P" => page_id,
    });
    document
        .get_dictionary_mut(target_popup_id)
        .unwrap()
        .set("Parent", Object::Reference(target_id));

    let untouched_popup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Rect" => vec![40.into(), 60.into(), 41.into(), 61.into()],
        "Contents" => Object::string_literal("untouched note"),
    });
    let untouched_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "FreeText",
        "Rect" => vec![40.into(), 60.into(), 41.into(), 61.into()],
        "NM" => Object::string_literal("legacy-untouched"),
        "Contents" => Object::string_literal("untouched note"),
        "AP" => dictionary! {"N" => blank_appearance},
        "Popup" => untouched_popup_id,
        "P" => page_id,
    });
    document
        .get_dictionary_mut(untouched_popup_id)
        .unwrap()
        .set("Parent", Object::Reference(untouched_id));
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set(
            "Annots",
            vec![
                Object::Reference(target_id),
                Object::Reference(target_popup_id),
                Object::Reference(untouched_id),
                Object::Reference(untouched_popup_id),
            ],
        );

    let target_before = document.get_dictionary(target_id).unwrap().clone();
    let untouched_before = document.get_object(untouched_id).unwrap().clone();
    let input_path = temp_pdf_path("marker-conversion-input");
    let output_path = temp_pdf_path("marker-conversion-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "edited note".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260831123000Z",
    )
    .unwrap();

    let loaded = Document::load(&output_path).unwrap();
    let target = loaded.get_dictionary(target_id).unwrap();
    assert_eq!(annotation_subtype(target), "text");
    assert_unowned_keys_unchanged(
        &target_before,
        target,
        &[
            b"Subtype",
            b"Name",
            b"F",
            b"Rect",
            b"CreationDate",
            b"AP",
            b"DA",
            b"Contents",
            b"M",
        ],
    )
    .unwrap();
    assert!(target.get(b"AP").is_err());
    assert!(target.get(b"DA").is_err());
    assert_eq!(
        string_bytes(&loaded, target_id, b"Contents"),
        encode_pdf_text_string("edited note")
    );
    assert_eq!(
        string_bytes(&loaded, target_popup_id, b"Contents"),
        encode_pdf_text_string("edited note")
    );
    assert_eq!(
        loaded.get_object(untouched_id).unwrap(),
        &untouched_before,
        "a sibling marker must not be rewritten"
    );
    assert_eq!(
        annotation_subtype(loaded.get_dictionary(untouched_id).unwrap()),
        "freetext"
    );

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn editing_a_marker_through_its_popup_converts_the_parent_note() {
    let (mut document, page_id) = create_test_document();
    let blank_appearance = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        },
        Vec::new(),
    ));
    let popup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Rect" => vec![20.into(), 60.into(), 21.into(), 61.into()],
        "Contents" => Object::string_literal("legacy note"),
    });
    let marker_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "FreeText",
        "Rect" => vec![20.into(), 60.into(), 21.into(), 61.into()],
        "NM" => Object::string_literal("popup-target"),
        "Contents" => Object::string_literal("legacy note"),
        "AP" => dictionary! {"N" => blank_appearance},
        "Popup" => popup_id,
        "P" => page_id,
    });
    document
        .get_dictionary_mut(popup_id)
        .unwrap()
        .set("Parent", Object::Reference(marker_id));
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(marker_id), Object::Reference(popup_id)]);

    let input_path = temp_pdf_path("popup-marker-conversion-input");
    let output_path = temp_pdf_path("popup-marker-conversion-output");
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    write(&input_path, &bytes).unwrap();
    write(&output_path, &bytes).unwrap();
    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: popup_id.0,
                generation_number: popup_id.1,
                text: "popup edit".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260831123100Z",
    )
    .unwrap();

    let loaded = Document::load(&output_path).unwrap();
    assert_eq!(
        annotation_subtype(loaded.get_dictionary(marker_id).unwrap()),
        "text"
    );
    assert_eq!(
        string_bytes(&loaded, marker_id, b"Contents"),
        encode_pdf_text_string("popup edit")
    );
    assert_eq!(
        string_bytes(&loaded, popup_id, b"Contents"),
        encode_pdf_text_string("popup edit")
    );

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn geometry_edit_uses_the_save_timestamp_when_converting_a_marker() {
    let (mut document, page_id) = create_test_document();
    let blank_appearance = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 0.into(), 0.into()],
        },
        Vec::new(),
    ));
    let popup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Rect" => vec![20.into(), 60.into(), 21.into(), 61.into()],
        "Parent" => (0, 0),
    });
    let marker_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "FreeText",
        "Rect" => vec![20.into(), 60.into(), 21.into(), 61.into()],
        "NM" => Object::string_literal("geometry-target"),
        "DA" => Object::string_literal("/F1 12 Tf"),
        "AP" => dictionary! {"N" => blank_appearance},
        "Popup" => popup_id,
        "P" => page_id,
    });
    document
        .get_dictionary_mut(popup_id)
        .unwrap()
        .set("Parent", Object::Reference(marker_id));
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(marker_id), Object::Reference(popup_id)]);

    let modified_at = "D:20260831124000Z";
    update_note_geometry(
        &mut document,
        &[NoteGeometryUpdate {
            object_number: marker_id.0,
            generation_number: marker_id.1,
            page_index: 0,
            marker_rect: MarkerRect {
                left: 0.1,
                top: 0.2,
                width: 0.001,
                height: 0.001,
            },
        }],
        modified_at,
    )
    .unwrap();

    let marker = document.get_dictionary(marker_id).unwrap();
    assert_eq!(annotation_subtype(marker), "text");
    assert_eq!(
        pdf_string_to_text(marker.get(b"M").unwrap()),
        Some(modified_at.to_string())
    );
    assert_eq!(marker.get(b"Name").unwrap().as_name().unwrap(), b"Note");
    assert!(marker.get(b"AP").is_err());
    assert!(marker.get(b"DA").is_err());
    let rect = parse_rect(marker.get(b"Rect").unwrap()).unwrap();
    assert_approximately(rect.width(), 20.0);
    assert_approximately(rect.height(), 20.0);
    let popup_rect = parse_rect(
        document.get_dictionary(popup_id).unwrap().get(b"Rect").unwrap(),
    )
    .unwrap();
    assert_approximately(popup_rect.width(), 20.0);
    assert_approximately(popup_rect.height(), 20.0);
}

#[test]
fn text_edit_keeps_a_marker_when_the_note_icon_does_not_fit() {
    let build_document = || {
        let (mut document, page_id) = create_test_document();
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 10.into(), 10.into()]);
        let blank_appearance = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 0.into(), 0.into()],
            },
            Vec::new(),
        ));
        let popup_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Popup",
            "Rect" => vec![1.into(), 8.into(), 1.1.into(), 8.1.into()],
        });
        let marker_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "FreeText",
            "Rect" => vec![1.into(), 8.into(), 1.1.into(), 8.1.into()],
            "NM" => Object::string_literal("tiny-marker"),
            "Contents" => Object::string_literal("old text"),
            "AP" => dictionary! {"N" => blank_appearance},
            "Popup" => popup_id,
            "P" => page_id,
        });
        document
            .get_dictionary_mut(popup_id)
            .unwrap()
            .set("Parent", Object::Reference(marker_id));
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(marker_id), Object::Reference(popup_id)]);
        (document, marker_id, popup_id)
    };

    let modified_at = "D:20260831124500Z";
    let (mut document, marker_id, popup_id) = build_document();
    assert!(update_annotation_text_by_ref(&mut document, marker_id, "edited", modified_at).unwrap());
    assert_eq!(
        annotation_subtype(document.get_dictionary(marker_id).unwrap()),
        "freetext"
    );
    assert_eq!(
        string_bytes(&document, marker_id, b"Contents"),
        encode_pdf_text_string("edited")
    );
    assert_eq!(
        string_bytes(&document, popup_id, b"Contents"),
        encode_pdf_text_string("edited")
    );

    let (document, marker_id, popup_id) = build_document();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    assert!(update_annotation_text_incremental_by_ref(
        &mut incremental,
        marker_id,
        "edited",
        modified_at,
    )
    .unwrap());
    let revision = AppendedRevision::new(&incremental);
    assert_eq!(annotation_subtype(revision.dictionary(marker_id).unwrap()), "freetext");
    assert_eq!(
        revision
            .dictionary(marker_id)
            .unwrap()
            .get(b"Contents")
            .unwrap()
            .as_str()
            .unwrap(),
        encode_pdf_text_string("edited").as_slice()
    );
    assert_eq!(
        revision
            .dictionary(popup_id)
            .unwrap()
            .get(b"Contents")
            .unwrap()
            .as_str()
            .unwrap(),
        encode_pdf_text_string("edited").as_slice()
    );
}

#[test]
fn appends_and_updates_visible_free_text_editor_as_incremental_revision() {
    let (mut document, page_id) = create_test_document();
    let pdf_path = temp_pdf_path("append-visible-free-text-editor");
    let _cleanup = RemovePdfFilesOnDrop([pdf_path.clone()]);
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    for (text, modified_at) in [
        ("asdfadf", "D:20260826161128+04'00'"),
        ("saved text", "D:20260826161200+04'00'"),
    ] {
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                text_boxes: vec![TextBoxMutation {
                    page_index: 0,
                    stable_key: "pdfjs_internal_editor_0".to_string(),
                    annotation_id: None,
                    text: text.to_string(),
                    rect: [2.0, 54.0, 59.0, 80.0],
                    rotation: 0,
                    font_size: 16.0,
                    color: [245, 158, 11],
                    author: None,
                    created_at: None,
                    modified_at: None,
                }],
                ..NativeMutationsFile::default()
            },
            modified_at,
        )
        .unwrap();
    }

    let loaded = Document::load(&pdf_path).unwrap();
    let free_text_refs: Vec<ObjectId> = get_page_annots(&loaded, page_id)
        .unwrap()
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter(|object_id| {
            loaded
                .get_dictionary(*object_id)
                .map(|dict| annotation_subtype(dict) == "freetext")
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(free_text_refs.len(), 1);
    let dict = loaded.get_dictionary(free_text_refs[0]).unwrap();
    assert_eq!(
        dict.get(b"Contents").unwrap().as_str().unwrap(),
        encode_pdf_text_string("saved text"),
    );
    assert!(dict.get(b"Popup").is_err());
    assert!(
        String::from_utf8_lossy(dict.get(b"DA").unwrap().as_str().unwrap()).contains("/Helv 16 Tf")
    );
    let appearance_ref = dict
        .get(b"AP")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"N")
        .unwrap()
        .as_reference()
        .unwrap();
    let appearance = loaded
        .get_object(appearance_ref)
        .unwrap()
        .as_stream()
        .unwrap();
    let appearance_text = String::from_utf8_lossy(&appearance.content);
    assert!(appearance_text.contains("0.9608 0.6196 0.0431 rg"));
    assert!(appearance_text.contains("(saved) Tj"));
    assert!(appearance_text.contains("(text) Tj"));

}

#[test]
fn text_box_create_round_trips_canonical_properties_and_metadata() {
    let (mut document, page_id) = create_test_document();
    let pdf_path = temp_pdf_path("append-text-box-create-parse");
    let _cleanup = RemovePdfFilesOnDrop([pdf_path.clone()]);
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    let text = "A long text box line that wraps at the requested width without changing its font size";
    let created_at = 1_780_000_000_000;
    let modified_at = 1_780_000_060_000;
    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            text_boxes: vec![TextBoxMutation {
                page_index: 0,
                stable_key: "text-box-create".to_string(),
                annotation_id: None,
                text: text.to_string(),
                rect: [10.0, 20.0, 110.0, 80.0],
                rotation: 0,
                font_size: 16.0,
                color: [17, 24, 39],
                author: Some("Ada Lovelace".to_string()),
                created_at: Some(created_at),
                modified_at: Some(modified_at),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260831120000Z",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let text_box_id = get_page_annots(&loaded, page_id)
        .unwrap()
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .find(|object_id| {
            loaded
                .get_dictionary(*object_id)
                .ok()
                .and_then(read_annotation_name)
                .as_deref()
                == Some("text-box-create")
        })
        .expect("created text box should be referenced by the page");
    let dict = loaded.get_dictionary(text_box_id).unwrap();
    assert_eq!(pdf_string_to_text(dict.get(b"T").unwrap()).as_deref(), Some("Ada Lovelace"));
    assert_eq!(
        pdf_string_to_text(dict.get(b"CreationDate").unwrap()).as_deref(),
        Some(shape_pdf_date(Some(created_at), "D:19700101000000Z").as_str()),
    );
    assert_eq!(
        pdf_string_to_text(dict.get(b"M").unwrap()).as_deref(),
        Some(shape_pdf_date(Some(modified_at), "D:19700101000000Z").as_str()),
    );

    let parsed = collect_parsed_annotations(&loaded, "D:20260831120000Z").unwrap();
    let parsed_text_box = parsed
        .iter()
        .find_map(|entry| match entry {
            PdfAnnotationParseEntry::TextBox(value) if value.name == "text-box-create" => {
                Some(value)
            }
            _ => None,
        })
        .expect("created text box should parse as a text box");
    assert_eq!(parsed_text_box.text, text);
    assert_eq!(parsed_text_box.author.as_deref(), Some("Ada Lovelace"));
    assert_eq!(parsed_text_box.created_at, Some(created_at as i64));
    assert_eq!(parsed_text_box.modified_at, Some(modified_at as i64));
    assert_eq!(parsed_text_box.rotation, 0);
    assert_eq!(parsed_text_box.font_size, 16.0);
    assert_eq!(parsed_text_box.color, "#111827");
    assert_approximately(parsed_text_box.rect.left, 0.05);
    assert_approximately(parsed_text_box.rect.top, 0.2);
    assert_approximately(parsed_text_box.rect.width, 0.5);
    assert_approximately(parsed_text_box.rect.height, 0.6);

    let appearance_ref = dict
        .get(b"AP")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"N")
        .unwrap()
        .as_reference()
        .unwrap();
    let appearance = loaded
        .get_object(appearance_ref)
        .unwrap()
        .as_stream()
        .unwrap();
    let appearance_text = String::from_utf8_lossy(&appearance.content);
    assert!(appearance_text.matches(" Tj").count() > 1);
    for line in wrap_free_text_lines(text, 100.0, 16.0) {
        // This mirrors the writer's line-break measurement; rendered fit is checked by the PDF appearance assertions above.
        assert!(free_text_line_width(&line, 16.0) <= 100.0);
    }
    let lines = wrap_free_text_lines("aaa    bbb", 35.0, 16.0);
    assert_eq!(lines, vec!["aaa", "bbb"]);
    for line in lines {
        assert!(free_text_line_width(&line, 16.0) <= 35.0);
    }
}

#[test]
fn updates_foreign_text_box_in_place_and_preserves_unowned_keys_and_popup() {
    let (mut document, page_id) = create_test_document();
    let old_appearance = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
        },
        b"q old appearance Q".to_vec(),
    ));
    let popup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Contents" => Object::string_literal("foreign popup"),
        "Rect" => vec![20.into(), 60.into(), 100.into(), 80.into()],
        "P" => page_id,
    });
    let foreign_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "FreeText",
        "Rect" => vec![20.into(), 30.into(), 160.into(), 80.into()],
        "NM" => Object::string_literal("foreign-text-box"),
        "Contents" => Object::string_literal("foreign text"),
        "T" => Object::string_literal("Foreign author"),
        "CreationDate" => Object::string_literal("D:20260101000000Z"),
        "M" => Object::string_literal("D:20260102000000Z"),
        "DA" => Object::string_literal("/Courier 12 Tf 0.2 0.3 0.4 rg 2 Tc 3 Tr"),
        "AP" => dictionary! {
            "N" => old_appearance,
            "R" => Object::string_literal("rollover"),
            "D" => Object::string_literal("down"),
            "UnknownAP" => Object::Integer(42),
        },
        "RC" => Object::string_literal("<b>foreign rich text</b>"),
        "DS" => Object::string_literal("font: Courier"),
        "Q" => Object::Integer(2),
        "Border" => vec![1.into(), 2.into(), 3.into(), 4.into()],
        "BS" => dictionary! {"W" => 7},
        "IC" => vec![0.1.into(), 0.2.into(), 0.3.into()],
        "CL" => vec![1.into(), 2.into(), 3.into(), 4.into()],
        "IT" => Object::Name(b"FreeTextTypeWriter".to_vec()),
        "Popup" => popup_id,
        "UnknownKey" => Object::string_literal("keep me"),
        "P" => page_id,
    });
    document
        .get_dictionary_mut(popup_id)
        .unwrap()
        .set("Parent", Object::Reference(foreign_id));
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(foreign_id), Object::Reference(popup_id)]);
    let before = document.get_dictionary(foreign_id).unwrap().clone();
    let before_popup = document.get_dictionary(popup_id).unwrap().clone();
    let before_ap = before.get(b"AP").unwrap().as_dict().unwrap().clone();

    let input_path = temp_pdf_path("foreign-text-box-input");
    let output_path = temp_pdf_path("foreign-text-box-output");
    let _cleanup = RemovePdfFilesOnDrop([input_path.clone(), output_path.clone()]);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    write(&input_path, &bytes).unwrap();
    write(&output_path, &bytes).unwrap();
    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            text_boxes: vec![TextBoxMutation {
                page_index: 0,
                stable_key: "foreign-text-box".to_string(),
                annotation_id: Some(format_pdfjs_annotation_ref(foreign_id)),
                text: "edited foreign text".to_string(),
                rect: [20.0, 30.0, 160.0, 80.0],
                rotation: 0,
                font_size: 18.0,
                color: [17, 24, 39],
                author: None,
                created_at: None,
                modified_at: None,
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260831130000Z",
    )
    .unwrap();

    let loaded = Document::load(&output_path).unwrap();
    let after = loaded.get_dictionary(foreign_id).unwrap();
    assert_unowned_keys_unchanged(
        &before,
        after,
        &[b"Rect", b"Contents", b"M", b"Rotate", b"DA", b"AP"],
    )
    .unwrap();
    assert_eq!(pdf_string_to_text(after.get(b"T").unwrap()).as_deref(), Some("Foreign author"));
    assert_eq!(
        pdf_string_to_text(after.get(b"CreationDate").unwrap()).as_deref(),
        Some("D:20260101000000Z")
    );
    assert!(after.get(b"Popup").is_ok());
    let after_ap = after.get(b"AP").unwrap().as_dict().unwrap();
    assert_eq!(after_ap.get(b"R").unwrap(), before_ap.get(b"R").unwrap());
    assert_eq!(after_ap.get(b"D").unwrap(), before_ap.get(b"D").unwrap());
    assert_eq!(
        after_ap.get(b"UnknownAP").unwrap(),
        before_ap.get(b"UnknownAP").unwrap()
    );
    let da = String::from_utf8_lossy(after.get(b"DA").unwrap().as_str().unwrap());
    assert!(da.contains("/Courier 18 Tf"));
    assert!(da.contains("2 Tc 3 Tr"));
    assert!(da.contains("0.0667 0.0941 0.1529 rg"));
    assert_eq!(loaded.get_dictionary(popup_id).unwrap(), &before_popup);

}

#[test]
fn deletes_text_box_and_its_popup_by_canonical_stable_key() {
    let (mut document, page_id) = create_test_document();
    let popup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Rect" => vec![10.into(), 10.into(), 20.into(), 20.into()],
        "P" => page_id,
    });
    let text_box_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "FreeText",
        "NM" => Object::string_literal("delete-text-box"),
        "Rect" => vec![10.into(), 10.into(), 100.into(), 30.into()],
        "Popup" => popup_id,
        "P" => page_id,
    });
    document
        .get_dictionary_mut(popup_id)
        .unwrap()
        .set("Parent", Object::Reference(text_box_id));
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        vec![Object::Reference(text_box_id), Object::Reference(popup_id)],
    );
    let input_path = temp_pdf_path("delete-text-box-input");
    let output_path = temp_pdf_path("delete-text-box-output");
    let _cleanup = RemovePdfFilesOnDrop([input_path.clone(), output_path.clone()]);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    write(&input_path, &bytes).unwrap();
    write(&output_path, &bytes).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            deletes: vec![AnnotationDelete {
                page_index: 0,
                object_number: None,
                generation_number: None,
                stable_key: Some("delete-text-box".to_string()),
                created_at: None,
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260831140000Z",
    )
    .unwrap();

    let loaded = Document::load(&output_path).unwrap();
    let page_annotation_refs: Vec<ObjectId> = get_page_annots(&loaded, page_id)
        .unwrap()
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .collect();
    assert!(!page_annotation_refs.contains(&text_box_id));
    assert!(!page_annotation_refs.contains(&popup_id));

}

#[test]
fn updates_imported_free_text_editor_by_pdf_reference_without_duplication() {
    let (mut document, page_id) = create_test_document();
    let imported_ref = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "FreeText",
        "Rect" => vec![20.into(), 30.into(), 180.into(), 80.into()],
        "Contents" => Object::string_literal("original imported text"),
    });
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(imported_ref)]);
    let pdf_path = temp_pdf_path("append-imported-free-text-editor");
    let _cleanup = RemovePdfFilesOnDrop([pdf_path.clone()]);
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            text_boxes: vec![TextBoxMutation {
                page_index: 0,
                stable_key: "pdf-ref-imported".to_string(),
                annotation_id: Some(format_pdfjs_annotation_ref(imported_ref)),
                text: "edited imported text".to_string(),
                rect: [20.0, 30.0, 180.0, 80.0],
                rotation: 0,
                font_size: 18.0,
                color: [17, 24, 39],
                author: None,
                created_at: None,
                modified_at: None,
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260829120000+04'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let annots = get_page_annots(&loaded, page_id).unwrap();
    assert_eq!(annots, vec![Object::Reference(imported_ref)]);
    let dict = loaded.get_dictionary(imported_ref).unwrap();
    assert_eq!(
        dict.get(b"Contents").unwrap().as_str().unwrap(),
        encode_pdf_text_string("edited imported text"),
    );
    assert_eq!(
        pdf_string_to_text(dict.get(b"NM").unwrap()).as_deref(),
        Some("pdf-ref-imported"),
    );
    assert!(dict.get(b"AP").is_ok());

}

#[test]
fn incremental_mixed_free_text_mutations_preserve_every_page_annotation() {
    let (mut document, page_id) = create_test_document();
    let pdf_path = temp_pdf_path("append-mixed-free-text-mutations");
    let _cleanup = RemovePdfFilesOnDrop([pdf_path.clone()]);
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            free_text_notes: vec![FreeTextNote {
                page_index: 0,
                stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                text: "popup note".to_string(),
                marker_rect: MarkerRect {
                    left: 0.1,
                    top: 0.2,
                    width: 0.0016,
                    height: 0.0016,
                },
                author: None,
                color: None,
                created_at: Some(1_787_783_296_280),
            }],
            text_boxes: vec![
                TextBoxMutation {
                    page_index: 0,
                    stable_key: "freetext-first".to_string(),
                    annotation_id: None,
                    text: "first editor".to_string(),
                    rect: [2.0, 54.0, 59.0, 80.0],
                    rotation: 0,
                    font_size: 16.0,
                    color: [17, 24, 39],
                    author: None,
                    created_at: None,
                    modified_at: None,
                },
                TextBoxMutation {
                    page_index: 0,
                    stable_key: "freetext-second".to_string(),
                    annotation_id: None,
                    text: "second editor".to_string(),
                    rect: [62.0, 54.0, 119.0, 80.0],
                    rotation: 0,
                    font_size: 16.0,
                    color: [34, 197, 94],
                    author: None,
                    created_at: None,
                    modified_at: None,
                },
            ],
            ..NativeMutationsFile::default()
        },
        "D:20260826222851+04'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let text_names: Vec<String> = get_page_annots(&loaded, page_id)
        .unwrap()
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter_map(|object_id| loaded.get_dictionary(object_id).ok())
        .filter(|dict| annotation_subtype(dict) == "text")
        .filter_map(|dict| dict.get(b"NM").ok().and_then(pdf_string_to_text))
        .collect();
    let free_text_names: Vec<String> = get_page_annots(&loaded, page_id)
        .unwrap()
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter_map(|object_id| loaded.get_dictionary(object_id).ok())
        .filter(|dict| annotation_subtype(dict) == "freetext")
        .filter_map(|dict| dict.get(b"NM").ok().and_then(pdf_string_to_text))
        .collect();
    assert_eq!(
        text_names,
        vec!["uid:0:pdfjs_internal_editor_0"]
    );
    assert_eq!(
        free_text_names,
        vec![
            "freetext-first",
            "freetext-second",
        ]
    );

}

#[test]
fn accepts_pdfjs_free_text_border_rounding_past_the_page_edge() {
    let editor = TextBoxMutation {
        page_index: 0,
        stable_key: "pdfjs_internal_editor_0".to_string(),
        annotation_id: None,
        text: "saved text".to_string(),
        rect: [20.0, 30.0, 202.0, 60.0],
        rotation: 0,
        font_size: 16.0,
        color: [0, 0, 0],
        author: None,
        created_at: None,
        modified_at: None,
    };
    let page_view = PdfRect {
        x1: 0.0,
        y1: 0.0,
        x2: 200.0,
        y2: 100.0,
    };

    let accepted = validate_text_box_rect(&editor, page_view).unwrap();
    assert_approximately(accepted.x1, 20.0);
    assert_approximately(accepted.y1, 30.0);
    assert_approximately(accepted.x2, 202.0);
    assert_approximately(accepted.y2, 60.0);

    let outside = TextBoxMutation {
        rect: [20.0, 30.0, 205.0, 60.0],
        ..editor
    };
    assert!(validate_text_box_rect(&outside, page_view).is_err());
}

#[test]
fn repeated_free_text_note_append_updates_existing_named_note() {
    let (mut document, page_id) = create_test_document();
    let pdf_path = temp_pdf_path("append-free-text-repeat");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            free_text_notes: vec![FreeTextNote {
                page_index: 0,
                stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                text: "first text".to_string(),
                marker_rect: MarkerRect {
                    left: 0.1,
                    top: 0.2,
                    width: 0.0016,
                    height: 0.0016,
                },
                author: None,
                color: None,
                created_at: None,
            }],
            deletes: Vec::new(),
            ..NativeMutationsFile::default()
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();
    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            free_text_notes: vec![FreeTextNote {
                page_index: 0,
                stable_key: "uid:0:pdfjs_internal_editor_0".to_string(),
                text: "second text".to_string(),
                marker_rect: MarkerRect {
                    left: 0.1,
                    top: 0.2,
                    width: 0.0016,
                    height: 0.0016,
                },
                author: None,
                color: None,
                created_at: None,
            }],
            deletes: Vec::new(),
            ..NativeMutationsFile::default()
        },
        "D:20260609123500+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let annots = get_page_annots(&loaded, page_id).unwrap();
    let text_refs: Vec<ObjectId> = annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter(|object_id| {
            loaded
                .get_dictionary(*object_id)
                .map(|dict| annotation_subtype(dict) == "text")
                .unwrap_or(false)
        })
        .collect();

    assert_eq!(text_refs.len(), 1);
    assert_eq!(
        string_bytes(&loaded, text_refs[0], b"Contents"),
        encode_pdf_text_string("second text")
    );

    let _ = remove_file(pdf_path);
}

#[test]
fn same_page_free_text_batch_indexes_initial_annots_once_and_preserves_order() {
    let (mut document, page_id) = create_test_document();
    let mut initial_refs = Vec::new();
    for index in 0..24 {
        let annot_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "NM" => Object::string_literal(format!("evb-note:existing-{index}")),
            "Contents" => Object::string_literal("old"),
        });
        initial_refs.push(annot_id);
    }
    document
        .get_object_mut(page_id)
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .set(
            "Annots",
            Object::Array(
                initial_refs
                    .iter()
                    .copied()
                    .map(Object::Reference)
                    .collect(),
            ),
        );

    let notes: Vec<FreeTextNote> = (0..28)
        .map(|index| FreeTextNote {
            page_index: 0,
            stable_key: format!("existing-{index}"),
            text: format!("updated-{index}"),
            marker_rect: MarkerRect {
                left: 0.1,
                top: 0.2,
                width: 0.2,
                height: 0.1,
            },
            author: None,
            color: None,
            created_at: None,
        })
        .collect();
    let mut annotation_visits = 0;

    upsert_free_text_notes_with_counter(
        &mut document,
        &notes,
        "D:20260609123456Z",
        &mut annotation_visits,
        &mut None,
    )
    .unwrap();

    let final_refs: Vec<ObjectId> = get_page_annots(&document, page_id)
        .unwrap()
        .iter()
        .map(|object| object.as_reference().unwrap())
        .collect();
    assert_eq!(annotation_visits, initial_refs.len());
    assert_eq!(&final_refs[..initial_refs.len()], initial_refs.as_slice());
    assert_eq!(final_refs.len(), initial_refs.len() * 2 + 4 * 2);
    for (index, annot_id) in initial_refs.iter().enumerate() {
        assert_eq!(
            string_bytes(&document, *annot_id, b"Contents"),
            encode_pdf_text_string(&format!("updated-{index}"))
        );
    }
}

#[test]
fn incremental_same_batch_duplicate_note_reuses_the_indexed_annotation() {
    let (mut document, page_id) = create_test_document();
    let pdf_path = temp_pdf_path("incremental-free-text-same-batch");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, original_bytes).unwrap();
    let mut incremental = IncrementalDocument::load(&pdf_path).unwrap();
    let notes: Vec<FreeTextNote> = ["first", "second"]
        .into_iter()
        .map(|text| FreeTextNote {
            page_index: 0,
            stable_key: "same-batch".to_string(),
            text: text.to_string(),
            marker_rect: MarkerRect {
                left: 0.1,
                top: 0.2,
                width: 0.2,
                height: 0.1,
            },
            author: None,
            color: None,
            created_at: None,
        })
        .collect();
    let mut annotation_visits = 0;

    upsert_free_text_notes_incremental_with_counter(
        &mut incremental,
        &notes,
        "D:20260609123456Z",
        &mut annotation_visits,
        &mut None,
    )
    .unwrap();

    let revision = AppendedRevision::new(&incremental);
    let annots = get_page_annots(&revision, page_id).unwrap();
    let text_refs: Vec<ObjectId> = annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter(|object_id| {
            revision
                .dictionary(*object_id)
                .map(|dict| annotation_subtype(dict) == "text")
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(annotation_visits, 0);
    assert_eq!(text_refs.len(), 1);
    assert_eq!(
        revision
            .dictionary(text_refs[0])
            .unwrap()
            .get(b"Contents")
            .ok()
            .and_then(pdf_string_to_text)
            .as_deref(),
        Some("second")
    );

    let _ = remove_file(pdf_path);
}

#[test]
fn appended_revision_reads_written_objects_over_the_untouched_base_revision() {
    let (mut document, target_id, _) = create_test_note_pdf();
    let pdf_path = temp_pdf_path("appended-revision-overlay");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    let mut incremental = IncrementalDocument::load(&pdf_path).unwrap();
    update_note_text_incremental(
        &mut incremental,
        &[NoteTextUpdate {
            object_number: target_id.0,
            generation_number: target_id.1,
            text: "overlaid text".to_string(),
        }],
        "D:20260609123456Z",
    )
    .unwrap();

    let revision = AppendedRevision::new(&incremental);
    let catalog_id = revision.root_id().unwrap();
    assert!(!incremental.new_document.objects.contains_key(&catalog_id));
    assert_eq!(
        revision
            .dictionary(catalog_id)
            .unwrap()
            .get(b"Type")
            .unwrap()
            .as_name()
            .unwrap(),
        b"Catalog"
    );
    assert_eq!(
        revision
            .dictionary(target_id)
            .unwrap()
            .get(b"Contents")
            .unwrap()
            .as_str()
            .unwrap(),
        encode_pdf_text_string("overlaid text").as_slice()
    );
    assert_eq!(revision.page_ids().len(), 1);

    let _ = remove_file(pdf_path);
}

#[test]
fn appended_revision_postconditions_reject_text_that_was_not_written() {
    let (mut document, target_id, _) = create_test_note_pdf();
    let pdf_path = temp_pdf_path("appended-revision-mismatch");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    let mut incremental = IncrementalDocument::load(&pdf_path).unwrap();
    update_note_text_incremental(
        &mut incremental,
        &[NoteTextUpdate {
            object_number: target_id.0,
            generation_number: target_id.1,
            text: "written text".to_string(),
        }],
        "D:20260609123456Z",
    )
    .unwrap();

    let error = validate_appended_revision_postconditions(
        &AppendedRevision::new(&incremental),
        &NativeMutationsFile {
            updates: vec![NoteTextUpdate {
                object_number: target_id.0,
                generation_number: target_id.1,
                text: "some other text".to_string(),
            }],
            ..NativeMutationsFile::default()
        },
        "D:20260609123456Z",
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("Contents did not match requested text"));

    let _ = remove_file(pdf_path);
}

#[test]
fn rejects_the_removed_incremental_validation_flag() {
    let error = parse_args(
        [
            "save-mutations",
            "--input",
            "input.pdf",
            "--output",
            "output.pdf",
            "--mutations-file",
            "mutations.json",
            "--modified-at",
            "D:20260609123456Z",
            "--append",
            "--incremental-validation",
            "tail-only",
        ]
        .into_iter()
        .map(String::from),
    )
    .err()
    .unwrap()
    .to_string();
    assert!(error.contains("Unknown argument: --incremental-validation"));
}

#[test]
fn append_compares_a_seeded_output_past_the_first_read_chunk() {
    let (mut document, target_id, _) = create_test_note_pdf();
    document.add_object(Object::Stream(Stream::new(
        dictionary! {},
        vec![b'p'; 96 * 1024],
    )));
    let input_path = temp_pdf_path("append-seed-chunked-input");
    let output_path = temp_pdf_path("append-seed-chunked-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    assert!(original_bytes.len() > 64 * 1024);
    write(&input_path, &original_bytes).unwrap();

    let mut divergent_bytes = original_bytes.clone();
    divergent_bytes[70 * 1024] ^= 0xff;
    write(&output_path, &divergent_bytes).unwrap();
    let mutations = NativeMutationsFile {
        updates: vec![NoteTextUpdate {
            object_number: target_id.0,
            generation_number: target_id.1,
            text: "chunked seed".to_string(),
        }],
        ..NativeMutationsFile::default()
    };
    let error = append_native_mutations(&input_path, &output_path, &mutations, "D:20260609123456Z")
        .unwrap_err()
        .to_string();
    assert!(error.contains("byte-for-byte copy"));

    write(&output_path, &original_bytes).unwrap();
    append_native_mutations(&input_path, &output_path, &mutations, "D:20260609123456Z").unwrap();
    let appended_bytes = read(&output_path).unwrap();
    assert!(appended_bytes.starts_with(&original_bytes));
    assert!(appended_bytes.len() > original_bytes.len());

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn reports_an_unreadable_append_payload_as_an_invalid_request() {
    let (mut document, _, _) = create_test_note_pdf();
    let pdf_path = temp_pdf_path("append-invalid-payload");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();
    let mutations_path = pdf_path.with_extension("mutations.json");
    write(&mutations_path, b"{\"updates\":\"not-a-list\"}").unwrap();

    let error = mutate_pdf(Config {
        operation: Operation::SaveMutations {
            mutations_file: mutations_path.clone(),
            modified_at: "D:20260609123456Z".to_string(),
            append: true,
            append_in_place: false,
            identity_bindings_file: None,
        },
        input_path: pdf_path.clone(),
        output_path: pdf_path.clone(),
        qpdf_path: None,
    })
    .unwrap_err();
    assert_eq!(
        evb_native_support::NativeErrorEnvelope::from_error(error.as_ref()).code,
        NativeErrorCode::InvalidRequest
    );

    let _ = remove_file(pdf_path);
    let _ = remove_file(mutations_path);
}
