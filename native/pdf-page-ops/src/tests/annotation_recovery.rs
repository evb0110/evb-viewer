fn recovery_save(mut document: Document, mutations: &NativeMutationsFile, append: bool) -> Document {
    let modified = "D:20260908120000Z";
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let mut saved = if append {
        let input = temp_pdf_path("recovery-input");
        let output = temp_pdf_path("recovery-output");
        write(&input, &bytes).unwrap();
        write(&output, &bytes).unwrap();
        append_native_mutations(&input, &output, mutations, modified).unwrap();
        let saved = Document::load(&output).unwrap();
        remove_file(input).unwrap();
        remove_file(output).unwrap();
        saved
    } else {
        let mut loaded = Document::load_mem(&bytes).unwrap();
        apply_native_mutations(&mut loaded, mutations, modified).unwrap();
        validate_appended_revision_postconditions(&loaded, mutations, modified).unwrap();
        loaded
    };
    let mut bytes = Vec::new();
    saved.save_to(&mut bytes).unwrap();
    let loaded = Document::load_mem(&bytes).unwrap();
    validate_appended_revision_postconditions(&loaded, mutations, modified).unwrap();
    loaded
}

#[test]
fn saved_deleted_stamp_recreates_after_hard_parse_in_both_writers() {
    let _cleanup = PlacedImageTestCleanup;
    for append in [false, true] {
        let (document, page) = create_test_document();
        let mut image = placed_jpeg_mutation();
        let key = "recovery-stamp".to_string();
        image.stable_key = Some(key.clone());
        image.rotation_degrees = Some(0.0);
        image.author = Some("Image author Հայ".to_string());
        let mut document = recovery_save(document, &NativeMutationsFile { placed_images: vec![image], ..Default::default() }, append);
        let parsed = collect_parsed_annotations(&document, "").unwrap();
        let stamp = parsed.iter().find_map(|entry| match entry { PdfAnnotationParseEntry::Stamp(value) => Some(value.clone()), _ => None }).unwrap();
        document = recovery_save(document, &NativeMutationsFile { deletes: vec![AnnotationDelete {
            page_index: 0, object_number: Some(stamp.object_number as u32), generation_number: Some(stamp.generation_number as u16), stable_key: Some(key.clone()), created_at: None,
        }], ..Default::default() }, append);
        assert!(collect_parsed_annotations(&document, "").unwrap().is_empty());
        let restore: PlacedImageGeometryUpdate = serde_json::from_value(serde_json::json!({
            "pageIndex": 0, "stableKey": key, "sourceImage": stamp.image, "author": stamp.author,
            "x": 0.2, "y": 0.3, "width": 0.3, "height": 0.2, "rotationDegrees": 90,
        })).unwrap();
        let mutations = NativeMutationsFile { placed_image_geometry_updates: vec![restore], ..Default::default() };
        document = recovery_save(document, &mutations, append);
        let parsed = collect_parsed_annotations(&document, "").unwrap();
        let restored = parsed.iter().find_map(|entry| match entry { PdfAnnotationParseEntry::Stamp(value) => Some(value), _ => None }).unwrap();
        assert_ne!(restored.object_number, stamp.object_number);
        assert_eq!(restored.image.sha256, stamp.image.sha256);
        assert_eq!(restored.rotation, 90.0);
        assert_eq!(restored.author.as_deref(), Some("Image author Հայ"));
        let new_ref = (restored.object_number as u32, restored.generation_number as u16);
        let (appearance, _) = placed_image_appearance_refs(&document, new_ref).unwrap();
        document.get_object_mut(appearance).unwrap().as_stream_mut().unwrap().content = b"q Q".to_vec();
        assert!(validate_appended_revision_postconditions(&document, &mutations, "D:20260908120000Z").is_err());
        assert_eq!(get_page_annots(&document, page).unwrap().len(), 1);
    }
}

#[test]
fn saved_deleted_note_restores_nested_read_only_replies_in_both_writers() {
    for append in [false, true] {
        let (document, page) = create_test_document();
        let note = binding_note();
        let mut document = recovery_save(document, &NativeMutationsFile { notes: vec![note], ..Default::default() }, append);
        let root = get_page_annots(&document, page).unwrap().into_iter().filter_map(|object| object.as_reference().ok()).find(|id| annotation_subtype(document.get_dictionary(*id).unwrap()) == "text").unwrap();
        let reply = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "IRT" => root, "P" => page,
            "NM" => Object::string_literal("reply-one"), "Contents" => Object::string_literal("original reply"),
            "T" => Object::string_literal("First author"), "Rect" => vec![10.into(), 10.into(), 20.into(), 20.into()],
            "PrivateField" => Object::string_literal("preserve me"),
        });
        let child = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "IRT" => reply, "P" => page,
            "NM" => Object::string_literal("reply-two"), "Contents" => Object::string_literal("nested reply"),
            "T" => Object::string_literal("Second author"), "Rect" => vec![10.into(), 10.into(), 20.into(), 20.into()],
        });
        let mut annots = get_page_annots(&document, page).unwrap();
        annots.extend([Object::Reference(reply), Object::Reference(child)]);
        document.get_dictionary_mut(page).unwrap().set("Annots", annots);
        let mut bytes = Vec::new(); document.save_to(&mut bytes).unwrap();
        document = Document::load_mem(&bytes).unwrap();
        let parsed = collect_parsed_annotations(&document, "").unwrap();
        let saved_note = parsed.iter().find_map(|entry| match entry { PdfAnnotationParseEntry::Note(value) => Some(value.clone()), _ => None }).unwrap();
        assert_eq!(saved_note.replies.len(), 2);
        document = recovery_save(document, &NativeMutationsFile { deletes: vec![AnnotationDelete {
            page_index: 0, object_number: Some(root.0), generation_number: Some(root.1), stable_key: None, created_at: None,
        }], ..Default::default() }, append);
        assert!(collect_parsed_annotations(&document, "").unwrap().is_empty());
        let mut note = binding_note(); note.recovery_data = saved_note.recovery_data;
        let mutations = NativeMutationsFile { notes: vec![note], ..Default::default() };
        document = recovery_save(document, &mutations, append);
        let parsed = collect_parsed_annotations(&document, "").unwrap();
        let restored = parsed.iter().find_map(|entry| match entry { PdfAnnotationParseEntry::Note(value) => Some(value), _ => None }).unwrap();
        assert_ne!(restored.object_number, root.0 as u64);
        assert_eq!(restored.replies.len(), 2);
        let reply_ref = (restored.replies[0].object_number as u32, restored.replies[0].generation_number as u16);
        assert_eq!(pdf_string_to_text(document.get_dictionary(reply_ref).unwrap().get(b"PrivateField").unwrap()).unwrap(), "preserve me");
        document.get_dictionary_mut(reply_ref).unwrap().set("Contents", Object::string_literal("corrupted reply"));
        assert!(validate_appended_revision_postconditions(&document, &mutations, "D:20260908120000Z").is_err());
    }
}

#[test]
fn native_shape_postconditions_reject_style_and_geometry_corruption() {
    let (mut document, page) = create_test_document();
    let mut shape = rectangle_shape("shape-semantic", "#123456");
    shape.shape_type = "arrow".into(); shape.x = 0.8; shape.y = 0.7; shape.x2 = Some(0.2); shape.y2 = Some(0.1);
    shape.fill_color = None; shape.line_start_style = Some("openArrow".into()); shape.line_end_style = Some("closedArrow".into());
    let view = resolve_page_view(&document, page).unwrap();
    let dict = create_shape_annotation_dict(&shape, view, 0, "").unwrap();
    validate_shape_semantics(&document, &dict, &shape, view, 0).unwrap();
    for (key, bad) in [
        ("Subtype", Object::Name(b"Square".to_vec())),
        ("L", Object::Array(vec![0.into(), 0.into(), 1.into(), 1.into()])),
        ("LE", Object::Array(vec![Object::Name(b"None".to_vec()), Object::Name(b"None".to_vec())])),
        ("CA", number_object(0.9)),
        ("C", Object::Array(vec![0.into(), 0.into(), 0.into()])),
        ("BS", Object::Dictionary(dictionary! {"W" => 50})),
    ] {
        let mut corrupted = dict.clone(); corrupted.set(key, bad);
        assert!(validate_shape_semantics(&document, &corrupted, &shape, view, 0).is_err(), "accepted corrupted {key}");
    }
    let mut unsupported = dict;
    unsupported.set("LE", vec![Object::Name(b"Circle".to_vec()), Object::Name(b"None".to_vec())]);
    let id = document.add_object(unsupported);
    document.get_dictionary_mut(page).unwrap().set("Annots", vec![Object::Reference(id)]);
    assert!(matches!(collect_parsed_annotations(&document, "").unwrap()[0], PdfAnnotationParseEntry::Foreign(_)));
}

#[test]
fn rotated_stamp_keeps_unrotated_rect_across_intrinsic_page_rotations_and_writers() {
    let _cleanup = PlacedImageTestCleanup;
    for append in [false, true] {
        for page_rotation in [0, 90, 180, 270] {
            let (mut document, page) = create_test_document();
            document.get_dictionary_mut(page).unwrap().set("CropBox", vec![10.into(), 20.into(), 610.into(), 920.into()]);
            document.get_dictionary_mut(page).unwrap().set("MediaBox", vec![10.into(), 20.into(), 610.into(), 920.into()]);
            document.get_dictionary_mut(page).unwrap().set("Rotate", Object::Integer(page_rotation));
            let mut image = placed_jpeg_mutation();
            image.stable_key = Some("rotated-canonical-image".into());
            image.x = -0.05; image.y = 0.4; image.width = 0.3; image.height = 0.05;
            image.rotation_degrees = Some(90.0);
            validate_placed_images(std::slice::from_ref(&image)).unwrap();
            document = recovery_save(document, &NativeMutationsFile { placed_images: vec![image], ..Default::default() }, append);
            for _ in 0..2 {
                let entries = collect_parsed_annotations(&document, "").unwrap();
                let stamp = match &entries[0] { PdfAnnotationParseEntry::Stamp(stamp) => stamp, other => panic!("expected stamp, got {other:?}") };
                for (actual, expected) in [(stamp.rect.left, -0.05), (stamp.rect.top, 0.4), (stamp.rect.width, 0.3), (stamp.rect.height, 0.05)] {
                    assert!((actual - expected).abs() < 1e-6, "canonical image rect drifted: {actual} vs {expected}, page rotation {page_rotation}");
                }
                assert_eq!(stamp.rotation, 90.0);
                let mutation: PlacedImageGeometryUpdate = serde_json::from_value(serde_json::json!({
                    "pageIndex": 0, "stableKey": "rotated-canonical-image",
                    "annotationId": format!("{}R{}", stamp.object_number, stamp.generation_number),
                    "x": stamp.rect.left, "y": stamp.rect.top, "width": stamp.rect.width, "height": stamp.rect.height, "rotationDegrees": stamp.rotation,
                })).unwrap();
                document = recovery_save(document, &NativeMutationsFile { placed_image_geometry_updates: vec![mutation], ..Default::default() }, append);
            }
        }
    }
}

#[test]
fn rotated_stamp_rejects_a_painted_footprint_outside_the_page() {
    let _cleanup = PlacedImageTestCleanup;
    let (document, page) = create_test_document();
    let mut image = placed_jpeg_mutation();
    image.x = 0.2; image.y = 0.1; image.width = 0.6; image.height = 0.8; image.rotation_degrees = Some(90.0);
    assert!(placed_image_geometry(&image, resolve_page_view(&document, page).unwrap(), 0).is_err());
}

#[test]
fn solid_bs_width_is_authoritative_and_dashed_shapes_stay_foreign() {
    let (mut document, page) = create_test_document();
    let shape = rectangle_shape("border-style", "#123456");
    let mut dict = create_shape_annotation_dict(&shape, resolve_page_view(&document, page).unwrap(), 0, "").unwrap();
    dict.set("BS", dictionary! { "W" => 7, "S" => "S" });
    let id = document.add_object(dict);
    document.get_dictionary_mut(page).unwrap().set("Annots", vec![Object::Reference(id)]);
    let entries = collect_parsed_annotations(&document, "").unwrap();
    assert!(matches!(&entries[0], PdfAnnotationParseEntry::Shape(shape) if shape.stroke_width == 7.0));
    document.get_dictionary_mut(id).unwrap().set("BS", dictionary! { "W" => 7, "S" => "D", "D" => vec![3.into(), 2.into()] });
    assert!(matches!(collect_parsed_annotations(&document, "").unwrap()[0], PdfAnnotationParseEntry::Foreign(_)));
}

#[test]
fn deleting_a_managed_stamp_preserves_a_siblings_shared_appearance() {
    let _cleanup = PlacedImageTestCleanup;
    for append in [false, true] {
        let (document, page) = create_test_document();
        let mut image = placed_jpeg_mutation();
        image.rotation_degrees = Some(0.0);
        let mut document = recovery_save(document, &NativeMutationsFile { placed_images: vec![image], ..Default::default() }, append);
        let original = get_page_annots(&document, page).unwrap()[0].as_reference().unwrap();
        let (appearance, _) = placed_image_appearance_refs(&document, original).unwrap();
        let before = document.get_object(appearance).unwrap().clone();
        let mut sibling = document.get_dictionary(original).unwrap().clone();
        sibling.set("NM", Object::string_literal("shared-appearance-sibling"));
        let sibling = document.add_object(sibling);
        document.get_dictionary_mut(page).unwrap().set("Annots", vec![Object::Reference(original), Object::Reference(sibling)]);
        let document = recovery_save(document, &NativeMutationsFile { deletes: vec![AnnotationDelete {
            page_index: 0, object_number: Some(original.0), generation_number: Some(original.1), stable_key: None, created_at: None,
        }], ..Default::default() }, append);
        assert_eq!(document.get_object(appearance).unwrap(), &before);
        assert_eq!(get_page_annots(&document, page).unwrap(), vec![Object::Reference(sibling)]);
        assert!(matches!(collect_parsed_annotations(&document, "").unwrap()[0], PdfAnnotationParseEntry::Stamp(_)));
    }
}

#[test]
fn unavailable_note_recovery_streams_stay_foreign_instead_of_becoming_empty() {
    let (mut document, page) = create_test_document();
    let appearance = document.add_object(Object::Stream(Stream::with_position(dictionary! {"Length" => 128}, 0)));
    let note = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "NM" => Object::string_literal("unavailable-note"),
        "Rect" => vec![10.into(), 10.into(), 20.into(), 20.into()],
        "Contents" => Object::string_literal("preserve source"),
        "AP" => dictionary! {"N" => appearance},
    });
    document.get_dictionary_mut(page).unwrap().set("Annots", vec![Object::Reference(note)]);
    assert!(matches!(&collect_parsed_annotations(&document, "").unwrap()[0], PdfAnnotationParseEntry::Foreign(entry) if entry.reason.contains("unavailable source stream")));
}

#[test]
fn arbitrary_managed_stamp_angles_survive_repeated_save_and_parse_exactly() {
    let _cleanup = PlacedImageTestCleanup;
    for append in [false, true] {
        for page_rotation in [0, 90, 180, 270] {
            for authored_rotation in [32.0, 45.0, 32.123_456_789] {
                let (mut document, page) = create_test_document();
                document.get_dictionary_mut(page).unwrap().set("MediaBox", vec![10.into(), 20.into(), 610.into(), 920.into()]);
                document.get_dictionary_mut(page).unwrap().set("Rotate", Object::Integer(page_rotation));
                let mut image = placed_jpeg_mutation();
                image.stable_key = Some("arbitrary-angle-image".into());
                image.x = 0.3; image.y = 0.3; image.width = 0.2; image.height = 0.1;
                image.rotation_degrees = Some(authored_rotation);
                document = recovery_save(document, &NativeMutationsFile { placed_images: vec![image], ..Default::default() }, append);
                for _ in 0..2 {
                    let entries = collect_parsed_annotations(&document, "").unwrap();
                    let stamp = match &entries[0] { PdfAnnotationParseEntry::Stamp(stamp) => stamp, other => panic!("expected arbitrary-angle stamp, got {other:?}") };
                    assert_eq!(stamp.rotation, authored_rotation);
                    for (actual, expected) in [(stamp.rect.left, 0.3), (stamp.rect.top, 0.3), (stamp.rect.width, 0.2), (stamp.rect.height, 0.1)] {
                        assert!((actual - expected).abs() < 1e-6);
                    }
                    let mutation: PlacedImageGeometryUpdate = serde_json::from_value(serde_json::json!({
                        "pageIndex": 0, "stableKey": "arbitrary-angle-image",
                        "annotationId": format!("{}R{}", stamp.object_number, stamp.generation_number),
                        "x": stamp.rect.left, "y": stamp.rect.top, "width": stamp.rect.width, "height": stamp.rect.height, "rotationDegrees": stamp.rotation,
                    })).unwrap();
                    document = recovery_save(document, &NativeMutationsFile { placed_image_geometry_updates: vec![mutation], ..Default::default() }, append);
                }
                let stamp_ref = get_page_annots(&document, page).unwrap()[0].as_reference().unwrap();
                document.get_dictionary_mut(stamp_ref).unwrap().remove(b"EVBImageRotation");
                let entries = collect_parsed_annotations(&document, "").unwrap();
                assert!(matches!(&entries[0], PdfAnnotationParseEntry::Stamp(stamp) if (stamp.rotation - authored_rotation).abs() < 0.0001));
                document.get_dictionary_mut(stamp_ref).unwrap().set("EVBImageRotation", Object::string_literal("7"));
                assert!(matches!(&collect_parsed_annotations(&document, "").unwrap()[0], PdfAnnotationParseEntry::Foreign(entry) if entry.reason.contains("rotation metadata differs")));
            }
        }
    }
}

#[test]
fn markup_author_survives_creation_updates_and_omission_in_both_writers() {
    for append in [false, true] {
        let (document, _) = create_test_document();
        let hint: MarkupSubtypeHint = serde_json::from_value(serde_json::json!({
            "subtype": "Highlight", "pageIndex": 0,
            "markerRect": {"left": 0.2, "top": 0.2, "width": 0.3, "height": 0.1},
            "appAnnotationId": "author-roundtrip", "source": "editor", "author": "Автор Հայ",
            "color": "#ffd400", "opacity": 0.35
        })).unwrap();
        let mut mutations = NativeMutationsFile { markup: Some(MarkupMutation {overrides: vec![], hints: vec![hint]}), ..Default::default() };
        let mut document = recovery_save(document, &mutations, append);
        for author in [Some("Автор Հայ"), Some("Updated author"), None] {
            let parsed = collect_parsed_annotations(&document, "").unwrap();
            let highlight = parsed.iter().find_map(|entry| match entry {PdfAnnotationParseEntry::Highlight(value) => Some(value), _ => None}).unwrap();
            let object_id = (highlight.object_number as u32, highlight.generation_number as u16);
            let hint = &mut mutations.markup.as_mut().unwrap().hints[0];
            hint.annotation_id = Some(format_pdfjs_annotation_ref(object_id));
            hint.author = author.map(str::to_string);
            hint.opacity = Some(0.35);
            document = recovery_save(document, &mutations, append);
            let parsed = collect_parsed_annotations(&document, "").unwrap();
            let highlight = parsed.iter().find_map(|entry| match entry {PdfAnnotationParseEntry::Highlight(value) => Some(value), _ => None}).unwrap();
            assert_eq!(highlight.author.as_deref(), Some(author.unwrap_or("Updated author")));
            assert_eq!(highlight.color, "#ffd400");
            assert!((highlight.opacity - 0.35).abs() < 0.000001);
            if author.is_some() {
                let mut corrupted = document.clone();
                corrupted.get_dictionary_mut(object_id).unwrap().set("T", Object::string_literal("Wrong author"));
                assert!(validate_markup_document_postconditions(&corrupted, mutations.markup.as_ref().unwrap()).is_err());
            }
        }
    }
}

#[test]
fn shape_author_survives_both_writers_and_omitted_updates() {
    for append in [false, true] {
        let (document, _) = create_test_document();
        let mut shape = rectangle_shape("evb-shape:author", "#ff0000");
        shape.author = Some("Shape author Հայ".to_string());
        let mut mutations = NativeMutationsFile {shapes: Some(ShapesMutation { total_pages: 1, rewrite_shape_state: false, shapes: vec![shape], deleted_annotation_ids: vec![], deleted_stable_keys: vec![] }), ..Default::default()};
        let mut document = recovery_save(document, &mutations, append);
        for author in [Some("Updated shape author"), None] {
            mutations.shapes.as_mut().unwrap().shapes[0].author = author.map(str::to_string);
            document = recovery_save(document, &mutations, append);
            let parsed = collect_parsed_annotations(&document, "").unwrap();
            let shape = parsed.iter().find_map(|entry| match entry {PdfAnnotationParseEntry::Shape(value) => Some(value), _ => None}).unwrap();
            assert_eq!(shape.author.as_deref(), Some("Updated shape author"));
            if author.is_some() {
                let mut corrupted = document.clone();
                corrupted.get_dictionary_mut((shape.object_number as u32, shape.generation_number as u16)).unwrap().set("T", Object::string_literal("Wrong author"));
                assert!(validate_shapes_document_postconditions(&corrupted, mutations.shapes.as_ref().unwrap()).is_err());
            }
        }
    }
}
