#[path = "../../../test-support/external_tool.rs"]
mod markup_external_tool;

fn assert_quad_points_approximately(actual: &[f64], expected: &[f64]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_approximately(*actual, *expected);
    }
}

#[test]
fn appends_markup_subtype_rewrite_as_incremental_revision() {
    let (mut document, _page_id, markup_id) = create_test_markup_pdf("Highlight");
    let input_path = temp_pdf_path("append-markup-input");
    let output_path = temp_pdf_path("append-markup-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            geometry_updates: Vec::new(),
            notes: Vec::new(),
            free_text_notes: Vec::new(),
            text_boxes: Vec::new(),
            deletes: Vec::new(),
            page_rotations: Vec::new(),
            page_labels: None,
            bookmarks: None,
            shapes: None,
            markup: Some(MarkupMutation {
                hints: vec![MarkupSubtypeHint {
                    subtype: "Squiggly".to_string(),
                    page_index: 0,
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.5,
                        width: 0.4,
                        height: 0.3,
                    },
                    markup_geometry: None,
                    app_annotation_id: None,
                    annotation_id: Some(format!("{} {} R", markup_id.0, markup_id.1)),
                    color: Some("#00ff00".to_string()),
                    opacity: Some(0.45),
                    author: None,
                    created_at: None,
                    modified_at: None,
                    contents: None,
                    id: None,
                    page_markup_index: Some(0),
                    source: Some("editor-live".to_string()),
                }],
            }),
            placed_images: Vec::new(),
            placed_image_geometry_updates: Vec::new(),
            continuation: None,
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
    let markup = loaded.get_dictionary(markup_id).unwrap();
    assert_eq!(
        canonical_markup_subtype(markup).as_deref(),
        Some("Squiggly")
    );
    assert!(markup.get(b"QuadPoints").is_ok());
    assert!(markup.get(b"AP").is_ok());
    let color = markup.get(b"C").unwrap().as_array().unwrap();
    assert_approximately(color[0].as_float().unwrap() as f64, 0.0);
    assert_approximately(color[1].as_float().unwrap() as f64, 1.0);
    assert_approximately(color[2].as_float().unwrap() as f64, 0.0);
    assert_approximately(
        markup.get(b"CA").unwrap().as_float().unwrap() as f64,
        0.45,
    );

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn patches_highlight_without_dropping_rich_text_review_reply_or_unknown_keys() {
    let (mut document, _page_id, markup_id) = create_test_markup_pdf("Highlight");
    let foreign_reply_id = document.new_object_id();
    let markup = document.get_dictionary_mut(markup_id).unwrap();
    markup.set("RC", Object::string_literal("<p>rich text</p>"));
    markup.set("State", Object::Name(b"Accepted".to_vec()));
    markup.set("IRT", Object::Reference(foreign_reply_id));
    markup.set(
        "UnknownKey",
        Object::String(vec![1, 2, 3], StringFormat::Hexadecimal),
    );
    let before = markup.clone();

    apply_markup_mutations(
        &mut document,
        &MarkupMutation {
            hints: vec![MarkupSubtypeHint {
                subtype: "Highlight".to_string(),
                page_index: 0,
                marker_rect: MarkerRect {
                    left: 0.1,
                    top: 0.5,
                    width: 0.4,
                    height: 0.3,
                },
                markup_geometry: None,
                app_annotation_id: None,
                annotation_id: Some(format!("{} {} R", markup_id.0, markup_id.1)),
                color: Some("#00ff00".to_string()),
                author: None,
                created_at: None,
                modified_at: None,
                contents: Some("updated contents".to_string()),
                id: Some("markup-preserve".to_string()),
                page_markup_index: Some(0),
                source: Some("editor".to_string()),
                opacity: None,
            }],
        },
        "D:20260831130000Z",
    )
    .unwrap();

    let after = document.get_dictionary(markup_id).unwrap();
    assert_unowned_keys_unchanged(
        &before,
        after,
        &[b"C", b"CA", b"AP", b"Contents", b"M", b"NM", b"QuadPoints"],
    )
    .unwrap();
    assert_eq!(read_annotation_name(after).as_deref(), Some("markup-preserve"));
}

#[test]
fn resolves_a_legacy_markup_prefix_without_rewriting_it() {
    let (mut document, page_id, markup_id) = create_test_markup_pdf("Highlight");
    document
        .get_dictionary_mut(markup_id)
        .unwrap()
        .set("NM", Object::string_literal("evb-markup:legacy-markup"));
    let page_view = resolve_page_view(&document, page_id).unwrap();
    let candidate = create_markup_candidate(&document, page_view, 0, markup_id, 0).unwrap();
    let hint = MarkupSubtypeHint {
        subtype: "Underline".to_string(),
        page_index: 0,
        marker_rect: MarkerRect {
            left: 0.1,
            top: 0.5,
            width: 0.4,
            height: 0.3,
        },
        markup_geometry: None,
        app_annotation_id: None,
        annotation_id: None,
        color: Some("#00ff00".to_string()),
        author: None,
        created_at: None,
        modified_at: None,
        contents: None,
        id: Some("legacy-markup".to_string()),
        page_markup_index: Some(0),
        source: Some("editor".to_string()),
        opacity: None,
    };
    let mut states = vec![MarkupHintState {
        annotation_ref: None,
        color: None,
        hint,
        consumed: false,
    }];
    assert!(rewrite_page_markup_subtypes(
        &mut document,
        &[candidate],
        &mut states,
        page_view,
        0,
        "D:20260831130000Z",
    )
    .unwrap());
    assert!(states[0].consumed);
    let after = document.get_dictionary(markup_id).unwrap();
    assert_eq!(read_annotation_name(after).as_deref(), Some("evb-markup:legacy-markup"));
    assert_eq!(canonical_markup_subtype(after).as_deref(), Some("Underline"));
}

#[test]
fn rewrites_existing_markup_geometry_for_all_text_markup_subtypes() {
    let marker_rect = MarkerRect {
        left: 0.2,
        top: 0.2,
        width: 0.5,
        height: 0.1,
    };
    let expected_quad_points = [40.0, 80.0, 140.0, 80.0, 40.0, 70.0, 140.0, 70.0];

    for subtype in ["Highlight", "Underline", "StrikeOut", "Squiggly"] {
        let (mut document, _page_id, markup_id) = create_test_markup_pdf(subtype);
        let stale_appearance_id = document.add_object(Stream::new(Dictionary::new(), Vec::new()));
        document
            .get_dictionary_mut(markup_id)
            .unwrap()
            .set("AP", dictionary! {"N" => stale_appearance_id});
        apply_markup_mutations(
            &mut document,
            &MarkupMutation {
                hints: vec![MarkupSubtypeHint {
                    subtype: subtype.to_string(),
                    page_index: 0,
                    marker_rect,
                    markup_geometry: Some(vec![marker_rect]),
                    app_annotation_id: None,
                    annotation_id: Some(format!("{} {} R", markup_id.0, markup_id.1)),
                    color: None,
                    opacity: None,
                    author: None,
                    created_at: None,
                    modified_at: None,
                    contents: None,
                    id: None,
                    page_markup_index: Some(0),
                    source: Some("editor".to_string()),
                }],
            },
            "D:20260831130000Z",
        )
        .unwrap();

        let annotation = document.get_dictionary(markup_id).unwrap();
        let quad_points = read_markup_quad_points(&document, annotation).unwrap();
        assert_quad_points_approximately(&quad_points, &expected_quad_points);
        let rect = annotation.get(b"Rect").unwrap().as_array().unwrap();
        assert_quad_points_approximately(
            &rect
                .iter()
                .map(|value| value.as_float().unwrap() as f64)
                .collect::<Vec<_>>(),
            &[40.0, 70.0, 140.0, 80.0],
        );
        assert!(annotation.get(b"AP").is_ok(), "{subtype} appearance");
    }
}

#[test]
fn keeps_existing_multiline_geometry_for_style_only_markup_hints() {
    for subtype in ["Highlight", "Underline", "StrikeOut", "Squiggly"] {
        for rotation in [0, 90] {
            for multiline in [false, true] {
                let (mut document, page_id, markup_id) = create_test_markup_pdf(subtype);
                document
                    .get_dictionary_mut(page_id)
                    .unwrap()
                    .set("MediaBox", vec![0.into(), 0.into(), 200.into(), 200.into()]);
                document
                    .get_dictionary_mut(page_id)
                    .unwrap()
                    .set("Rotate", rotation);
                let mut quads = vec![20.0, 140.0, 120.0, 160.0, 20.0, 130.0, 120.0, 150.0];
                if multiline {
                    quads.extend([20.0, 120.0, 120.0, 140.0, 20.0, 110.0, 120.0, 130.0]);
                }
                let mut annotation = document.get_dictionary(markup_id).unwrap().clone();
                annotation.set("QuadPoints", quad_points_object(&quads));
                annotation.set(
                    "Rect",
                    vec![
                        20.into(),
                        if multiline { 110.into() } else { 130.into() },
                        120.into(),
                        160.into(),
                    ],
                );
                annotation.set("C", vec![1.into(), 0.into(), 0.into()]);
                annotation.set("CA", 1);
                let appearances = regression_appearance(&mut document, &mut annotation);
                document.set_object(markup_id, annotation.clone());
                let entries = collect_parsed_annotations(&document, "D:20261104000000Z").unwrap();
                let parsed = entries
                    .iter()
                    .find_map(|entry| match entry {
                        PdfAnnotationParseEntry::Highlight(value) => Some(value),
                        _ => None,
                    })
                    .expect("real parser exposes the source bounds");
                for projected_bounds in [true, false] {
                    let mut hint = serde_json::json!({
                        "subtype": subtype, "pageIndex": 0,
                        "markerRect": parsed.quad_points[0],
                        "annotationId": format!("{} 0 R", markup_id.0),
                        "color": "#ff0000", "opacity": 1,
                        "contents": "Comment-only edit", "source": "pdf",
                    });
                    if projected_bounds {
                        hint["markupGeometry"] = serde_json::to_value(&parsed.quad_points).unwrap();
                    }
                    let mutation = NativeMutationsFile {
                        markup: Some(MarkupMutation {
                            hints: vec![serde_json::from_value(hint).unwrap()],
                        }),
                        ..NativeMutationsFile::default()
                    };
                    for route in ["full", "path", "bytes"] {
                        let saved = saved_annotation_regression(
                            &document,
                            &mutation,
                            route,
                            "D:20261104000100Z",
                        );
                        let after = saved.get_dictionary(markup_id).unwrap();
                        for key in [b"QuadPoints".as_slice(), b"Rect", b"AP"] {
                            assert_eq!(
                                after.get(key).unwrap(),
                                annotation.get(key).unwrap(),
                                "{subtype}, {rotation}, multiline={multiline}, projected={projected_bounds}, {route}: {key:?}"
                            );
                        }
                        assert_regression_appearance(&document, &saved, appearances);
                        assert_eq!(
                            pdf_string_to_text(after.get(b"Contents").unwrap()).as_deref(),
                            Some("Comment-only edit")
                        );
                        assert_eq!(
                            pdf_string_to_text(after.get(b"M").unwrap()).as_deref(),
                            Some("D:20261104000100Z")
                        );
                    }
                }
            }
        }
    }

    let painted_pixels = |document: &Document, page_id, markup_id| {
        let mut document = document.clone();
        let appearance = document
            .get_dictionary(markup_id)
            .unwrap()
            .get(b"AP")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"N")
            .unwrap()
            .clone();
        // Render the saved /AP itself: readers can synthesize a highlight
        // from /QuadPoints and conceal a broken appearance stream.
        let contents = document.add_object(Stream::new(
            dictionary! {},
            b"q /MarkupAppearance Do Q\n".to_vec(),
        ));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.remove(b"Annots");
        page.set(
            "Resources",
            dictionary! {"XObject" => dictionary! {"MarkupAppearance" => appearance}},
        );
        page.set("Contents", contents);
        let path = temp_pdf_path("markup-style-coverage");
        document.save(&path).unwrap();
        let rendered = std::process::Command::new(markup_external_tool::tool_path(
            "PDFTOPPM_PATH",
            "poppler",
            "pdftoppm",
        ))
        .args(["-r", "72", "-aa", "no", "-aaVector", "no", "-singlefile"])
        .arg(&path)
        .output()
        .unwrap();
        remove_file(path).unwrap();
        assert!(
            rendered.status.success(),
            "{}",
            String::from_utf8_lossy(&rendered.stderr)
        );
        let mut header = rendered.stdout.splitn(4, |byte| *byte == b'\n');
        assert_eq!(header.next().unwrap(), b"P6");
        assert_eq!(header.next().unwrap(), b"200 100");
        assert_eq!(header.next().unwrap(), b"255");
        header
            .next()
            .unwrap()
            .chunks_exact(3)
            .filter(|rgb| {
                let low = *rgb.iter().min().unwrap();
                let high = *rgb.iter().max().unwrap();
                low < 32 && high > 224 && high - low > 192
            })
            .count()
    };
    for (order, quads) in [
        (
            "z-order",
            [20.0, 50.0, 120.0, 50.0, 20.0, 20.0, 120.0, 20.0],
        ),
        (
            "counterclockwise",
            [20.0, 20.0, 120.0, 20.0, 120.0, 50.0, 20.0, 50.0],
        ),
    ] {
        let (mut document, page_id, markup_id) = create_test_markup_pdf("Highlight");
        let appearance = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => vec![20.into(), 20.into(), 120.into(), 50.into()],
                "Resources" => dictionary! {},
            },
            b"q 1 0 0 rg 20 20 m 120 20 l 120 50 l 20 50 l h f Q\n".to_vec(),
        ));
        let annotation = document.get_dictionary_mut(markup_id).unwrap();
        annotation.set("Rect", vec![20.into(), 20.into(), 120.into(), 50.into()]);
        annotation.set("QuadPoints", quad_points_object(&quads));
        annotation.set("C", vec![1.into(), 0.into(), 0.into()]);
        annotation.set("CA", 1);
        annotation.set("F", 4);
        annotation.set("P", page_id);
        annotation.set("Contents", Object::string_literal(""));
        annotation.set("NM", Object::string_literal("iso-counterclockwise"));
        annotation.set("AP", dictionary! {"N" => appearance});
        let original = annotation.clone();
        let source_pixels = painted_pixels(&document, page_id, markup_id);
        assert_eq!(source_pixels, 3000, "{order} source rectangle");
        let parsed = collect_parsed_annotations(&document, "D:20261104000000Z").unwrap();
        let parsed = parsed
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::Highlight(value) => Some(value),
                _ => None,
            })
            .expect("the real parser admits both corner orders");
        let hint = serde_json::json!({
            "subtype": "Highlight", "pageIndex": 0,
            "annotationId": format!("{} {} R", markup_id.0, markup_id.1),
            "markerRect": parsed.quad_points[0], "markupGeometry": parsed.quad_points,
            "color": "#0000ff", "opacity": 1, "contents": "", "source": "pdf",
        });
        let mutation = NativeMutationsFile {
            markup: Some(MarkupMutation {
                hints: vec![serde_json::from_value(hint).unwrap()],
            }),
            ..NativeMutationsFile::default()
        };
        let mut coverage = Vec::new();
        for route in ["full", "path", "bytes"] {
            let saved =
                saved_annotation_regression(&document, &mutation, route, "D:20261104000100Z");
            let after = saved.get_dictionary(markup_id).unwrap();
            for key in [b"QuadPoints".as_slice(), b"Rect"] {
                assert_eq!(
                    after.get(key).unwrap(),
                    original.get(key).unwrap(),
                    "{order} {route} {key:?}"
                );
            }
            assert_eq!(
                pdf_string_to_text(after.get(b"Contents").unwrap()).as_deref(),
                Some(""),
                "{order} {route} keeps the empty comment"
            );
            let color: Vec<_> = after
                .get(b"C")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|value| f64::from(value.as_float().unwrap()))
                .collect();
            assert_quad_points_approximately(&color, &[0.0, 0.0, 1.0]);
            if order == "z-order" {
                let ap = after
                    .get(b"AP")
                    .unwrap()
                    .as_dict()
                    .unwrap()
                    .get(b"N")
                    .unwrap()
                    .as_reference()
                    .unwrap();
                let stream = saved.get_object(ap).unwrap().as_stream().unwrap();
                let content = stream
                    .decompressed_content()
                    .unwrap_or_else(|_| stream.content.clone());
                assert_eq!(content, b"q\n/GS0 gs\n0 0 1 RG\n0 0 1 rg\n20 50 m\n120 50 l\n120 20 l\n20 20 l\nh\nf\nQ\n", "{route} retains the Z-order saved appearance bytes");
            }
            coverage.push((route, painted_pixels(&saved, page_id, markup_id)));
        }
        println!("{order} saved appearance coverage: {coverage:?}");
        assert_eq!(
            coverage,
            vec![
                ("full", source_pixels),
                ("path", source_pixels),
                ("bytes", source_pixels)
            ],
            "{order} style-only Save must keep the complete filled rectangle"
        );
    }
}

fn saves_new_markup_dates_on_all_writer_routes() {
    let save_time = "D:20261105000000Z";
    let cases = [
        ("missing", None, None, save_time, save_time),
        (
            "explicit",
            Some(1_793_750_400_000u64),
            Some(1_793_750_460_000u64),
            "D:20261104000000Z",
            "D:20261104000100Z",
        ),
        ("null", None, None, save_time, save_time),
        (
            "epoch",
            Some(0),
            Some(0),
            "D:19700101000000Z",
            "D:19700101000000Z",
        ),
        (
            "subsecond",
            Some(1_793_750_400_999),
            Some(1_793_750_460_999),
            "D:20261104000000Z",
            "D:20261104000100Z",
        ),
        (
            "modified-only",
            None,
            Some(1_793_750_460_000),
            "D:20261104000100Z",
            "D:20261104000100Z",
        ),
        (
            "created-only",
            Some(1_793_750_400_000),
            None,
            "D:20261104000000Z",
            save_time,
        ),
    ];
    for subtype in ["Highlight", "Underline", "StrikeOut", "Squiggly"] {
        for (label, created, modified, expected_created, expected_modified) in cases {
            let id = format!("dates-{subtype}-{label}");
            let mut hint = serde_json::json!({
                "subtype": subtype, "pageIndex": 0,
                "markerRect": {"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.1},
                "markupGeometry": [{"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.1}],
                "id": id, "appAnnotationId": id, "source": "editor", "contents": "New dated markup",
                "color": "#ff0000", "opacity": 1,
            });
            if label != "missing" {
                hint["createdAt"] = serde_json::json!(created);
                hint["modifiedAt"] = serde_json::json!(modified);
            }
            let mutation = NativeMutationsFile {
                markup: Some(MarkupMutation {
                    hints: vec![serde_json::from_value(hint).unwrap()],
                }),
                ..NativeMutationsFile::default()
            };
            for route in ["full", "path", "bytes"] {
                let (source, page_id) = create_test_document();
                let saved = saved_annotation_regression(&source, &mutation, route, save_time);
                let annots = get_page_annots(&saved, page_id).unwrap();
                assert_eq!(annots.len(), 1);
                let annotation = saved
                    .get_dictionary(annots[0].as_reference().unwrap())
                    .unwrap();
                assert_eq!(
                    pdf_string_to_text(annotation.get(b"CreationDate").unwrap()).as_deref(),
                    Some(expected_created),
                    "{subtype}, {label}, {route}"
                );
                assert_eq!(
                    pdf_string_to_text(annotation.get(b"M").unwrap()).as_deref(),
                    Some(expected_modified),
                    "{subtype}, {label}, {route}"
                );
                let parsed = collect_parsed_annotations(&saved, save_time).unwrap();
                let parsed = parsed
                    .iter()
                    .find_map(|entry| match entry {
                        PdfAnnotationParseEntry::Highlight(value) => Some(value),
                        _ => None,
                    })
                    .unwrap();
                let expected_epoch = |value: &str| parse_pdf_date_timestamp(value).unwrap();
                assert_eq!(parsed.created_at, Some(expected_epoch(expected_created)));
                assert_eq!(parsed.modified_at, Some(expected_epoch(expected_modified)));
                let repeated =
                    saved_annotation_regression(&saved, &mutation, route, "D:20261106000000Z");
                let annots = get_page_annots(&repeated, page_id).unwrap();
                assert_eq!(
                    annots.len(),
                    1,
                    "identity upsert must not duplicate {subtype}"
                );
                let annotation = repeated
                    .get_dictionary(annots[0].as_reference().unwrap())
                    .unwrap();
                assert_eq!(
                    pdf_string_to_text(annotation.get(b"CreationDate").unwrap()).as_deref(),
                    Some(expected_created)
                );
            }
        }
        for created in [
            serde_json::Value::Null,
            serde_json::json!(1_793_750_400_000u64),
        ] {
            let (mut source, _page_id, markup_id) = create_test_markup_pdf(subtype);
            let original = Object::string_literal("D:19691231235959Z");
            source
                .get_dictionary_mut(markup_id)
                .unwrap()
                .set("CreationDate", original.clone());
            let hint = serde_json::json!({
                "subtype": subtype, "pageIndex": 0,
                "markerRect": {"left": 0.1, "top": 0.5, "width": 0.4, "height": 0.3},
                "annotationId": format!("{} 0 R", markup_id.0),
                "contents": "Changed imported comment", "createdAt": created,
            });
            let mutation = NativeMutationsFile {
                markup: Some(MarkupMutation {
                    hints: vec![serde_json::from_value(hint).unwrap()],
                }),
                ..NativeMutationsFile::default()
            };
            for route in ["full", "path", "bytes"] {
                let saved = saved_annotation_regression(&source, &mutation, route, save_time);
                let annotation = saved.get_dictionary(markup_id).unwrap();
                assert_eq!(annotation.get(b"CreationDate").unwrap(), &original);
                assert_eq!(
                    pdf_string_to_text(annotation.get(b"Contents").unwrap()).as_deref(),
                    Some("Changed imported comment")
                );
            }
        }
    }
}

#[test]
fn creates_new_text_markup_annotations_with_quad_geometry() {
    saves_new_markup_dates_on_all_writer_routes();
    let (document, page_id) = create_test_document();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    let marker_rect = MarkerRect {
        left: 0.1,
        top: 0.2,
        width: 0.3,
        height: 0.1,
    };
    let hints = [
        ("Highlight", "new-highlight", "#ff0000"),
        ("Underline", "new-underline", "#00ff00"),
        ("StrikeOut", "new-strikeout", "#0000ff"),
        ("Squiggly", "new-squiggly", "#336699"),
    ]
    .into_iter()
    .map(|(subtype, id, color)| MarkupSubtypeHint {
        subtype: subtype.to_string(),
        page_index: 0,
        marker_rect,
        markup_geometry: Some(if subtype == "Underline" {
            vec![
                marker_rect,
                MarkerRect {
                    left: 0.6,
                    top: 0.6,
                    width: 0.2,
                    height: 0.1,
                },
            ]
        } else {
            vec![marker_rect]
        }),
        annotation_id: None,
        app_annotation_id: None,
        color: Some(color.to_string()),
        author: None,
        created_at: None,
        modified_at: None,
        contents: None,
        id: Some(id.to_string()),
        page_markup_index: None,
        source: Some("editor".to_string()),
        opacity: None,
    })
    .collect();

    apply_markup_mutations_incremental(
        &mut incremental,
        &MarkupMutation { hints },
        "D:20260829120500+04'00'",
    )
    .expect("new text markup annotations should be created");

    let revision = &incremental;
    let annots = get_page_annots(revision, page_id).expect("page annotations");
    assert_eq!(annots.len(), 4);
    for (index, subtype) in ["Highlight", "Underline", "StrikeOut", "Squiggly"]
        .into_iter()
        .enumerate()
    {
        let object_id = annots[index].as_reference().expect("annotation reference");
        let annotation = revision
            .dictionary(object_id)
            .expect("annotation dictionary");
        assert_eq!(
            canonical_markup_subtype(annotation).as_deref(),
            Some(subtype)
        );
        assert_eq!(
            annotation.get(b"Type").unwrap().as_name().unwrap(),
            b"Annot"
        );
        assert_eq!(annotation.get(b"F").unwrap().as_i64().unwrap() & 4, 4);
        assert_eq!(
            annotation.get(b"P").unwrap().as_reference().unwrap(),
            page_id
        );
        assert!(annotation.get(b"NM").is_ok());
        assert!(annotation.get(b"Rect").is_ok());
        assert!(annotation.get(b"QuadPoints").is_ok());
        assert!(annotation.get(b"C").is_ok());
        let quad_points = read_markup_quad_points(revision, annotation).unwrap();
        let expected_quad_points = if subtype == "Underline" {
            vec![
                20.0, 80.0, 80.0, 80.0, 20.0, 70.0, 80.0, 70.0, 120.0, 40.0, 160.0, 40.0, 120.0,
                30.0, 160.0, 30.0,
            ]
        } else {
            vec![20.0, 80.0, 80.0, 80.0, 20.0, 70.0, 80.0, 70.0]
        };
        assert_quad_points_approximately(&quad_points, &expected_quad_points);
        if subtype == "Underline" {
            let rect = read_pdf_rect_from_dict(revision, annotation).unwrap();
            assert_approximately(rect.x1, 20.0);
            assert_approximately(rect.y1, 30.0);
            assert_approximately(rect.x2, 160.0);
            assert_approximately(rect.y2, 80.0);
        }
        assert!(annotation.get(b"AP").is_ok(), "{subtype} appearance");
    }
}

#[test]
fn recreates_markup_after_deleted_pdf_ref_in_the_same_revision() {
    let (document, page_id, markup_id) = create_test_markup_pdf("Highlight");
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    let delete = AnnotationDelete {
        page_index: 0,
        object_number: Some(markup_id.0),
        generation_number: Some(markup_id.1),
        stable_key: None,
        created_at: None,
    };
    delete_annotations(&mut incremental, std::slice::from_ref(&delete)).unwrap();

    let mutation = MarkupMutation {
        hints: vec![MarkupSubtypeHint {
            subtype: "Highlight".to_string(),
            page_index: 0,
            marker_rect: MarkerRect {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            },
            markup_geometry: None,
            app_annotation_id: Some("annotation-1".to_string()),
            annotation_id: None,
            color: Some("#ff0000".to_string()),
            author: None,
            created_at: None,
            modified_at: None,
            contents: None,
            id: Some(format_pdfjs_annotation_ref(markup_id)),
            page_markup_index: None,
            source: Some("editor".to_string()),
            opacity: None,
        }],
    };
    apply_markup_mutations_incremental(&mut incremental, &mutation, "D:20260829120500+04'00'")
        .unwrap();

    let revision = &incremental;
    validate_markup_document_postconditions(revision, &mutation)
        .expect("a recreated editor markup must not validate a deleted PDF ref");

    let annots = get_page_annots(revision, page_id).unwrap();
    let refs: Vec<ObjectId> = annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .collect();
    assert_eq!(refs.len(), 1);
    assert_ne!(refs[0], markup_id);
    assert!(matches!(revision.object(markup_id), Ok(Object::Null)));
}

#[test]
fn emits_exact_identity_binding_for_new_native_markup() {
    let (document, page_id) = create_test_document();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    let mutation = MarkupMutation {
        hints: vec![MarkupSubtypeHint {
            subtype: "Highlight".to_string(),
            page_index: 0,
            marker_rect: MarkerRect {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            },
            markup_geometry: None,
            app_annotation_id: Some("app-annotation-1".to_string()),
            annotation_id: None,
            color: Some("#ff0000".to_string()),
            author: None,
            created_at: None,
            modified_at: None,
            contents: None,
            id: Some("new-highlight".to_string()),
            page_markup_index: None,
            source: Some("editor".to_string()),
            opacity: None,
        }],
    };
    let mut bindings = Vec::new();
    apply_markup_mutations_incremental_with_bindings(
        &mut incremental,
        &mutation,
        "D:20260609123456Z",
        &mut bindings,
    )
    .expect("native markup should produce an identity binding");

    assert_eq!(bindings.len(), 1);
    let annots = get_page_annots(&incremental, page_id).unwrap();
    let object_id = annots[0].as_reference().unwrap();
    assert_eq!(
        bindings[0],
        AnnotationIdentityBinding {
            annotation_id: "app-annotation-1".to_string(),
            pdf_ref: format!("{} {} R", object_id.0, object_id.1),
        }
    );

    let report_path = temp_pdf_path("markup-identity-report").with_extension("json");
    write_annotation_identity_bindings_report(&report_path, &bindings).unwrap();
    assert_eq!(
        read(&report_path).unwrap(),
        format!(
            "[{{\"annotationId\":\"app-annotation-1\",\"pdfRef\":\"{} {} R\"}}]",
            object_id.0, object_id.1,
        )
        .as_bytes()
    );
    let _ = remove_file(report_path);
}

#[test]
fn rejects_new_native_markup_without_a_canonical_identity_binding() {
    let (document, _page_id) = create_test_document();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    let mutation = MarkupMutation {
        hints: vec![MarkupSubtypeHint {
            subtype: "Highlight".to_string(),
            page_index: 0,
            marker_rect: MarkerRect {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            },
            markup_geometry: None,
            app_annotation_id: None,
            annotation_id: None,
            color: Some("#ff0000".to_string()),
            author: None,
            created_at: None,
            modified_at: None,
            contents: None,
            id: Some("new-highlight".to_string()),
            page_markup_index: None,
            source: Some("editor".to_string()),
            opacity: None,
        }],
    };
    let error = apply_markup_mutations_incremental_with_bindings(
        &mut incremental,
        &mutation,
        "D:20260609123456Z",
        &mut Vec::new(),
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("missing canonical annotation identity"));
}

#[test]
fn rejects_malformed_or_duplicate_native_markup_identity_reports() {
    let report_path = temp_pdf_path("invalid-markup-identity-report").with_extension("json");
    let reject = |bindings: Vec<AnnotationIdentityBinding>| {
        assert!(write_annotation_identity_bindings_report(&report_path, &bindings).is_err());
    };

    reject(vec![AnnotationIdentityBinding {
        annotation_id: String::new(),
        pdf_ref: "700 0 R".to_string(),
    }]);
    reject(vec![AnnotationIdentityBinding {
        annotation_id: "app-annotation-1".to_string(),
        pdf_ref: "700R".to_string(),
    }]);
    reject(vec![
        AnnotationIdentityBinding {
            annotation_id: "app-annotation-1".to_string(),
            pdf_ref: "700 0 R".to_string(),
        },
        AnnotationIdentityBinding {
            annotation_id: "app-annotation-1".to_string(),
            pdf_ref: "701 0 R".to_string(),
        },
    ]);
    reject(vec![
        AnnotationIdentityBinding {
            annotation_id: "app-annotation-1".to_string(),
            pdf_ref: "700 0 R".to_string(),
        },
        AnnotationIdentityBinding {
            annotation_id: "app-annotation-2".to_string(),
            pdf_ref: "700 0 R".to_string(),
        },
    ]);

    let _ = remove_file(report_path);
}

#[test]
fn appends_and_upserts_all_new_text_markup_subtypes() {
    let (mut document, page_id) = create_test_document();
    let input_path = temp_pdf_path("append-new-markup-input");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();

    let marker_rect = MarkerRect {
        left: 0.1,
        top: 0.2,
        width: 0.3,
        height: 0.1,
    };
    let mutation = NativeMutationsFile {
        updates: Vec::new(),
        geometry_updates: Vec::new(),
        notes: Vec::new(),
        free_text_notes: Vec::new(),
        text_boxes: Vec::new(),
        deletes: Vec::new(),
        page_rotations: Vec::new(),
        page_labels: None,
        bookmarks: None,
        shapes: None,
        markup: Some(MarkupMutation {
            hints: [
                ("Highlight", "persisted-highlight", "#ff0000"),
                ("Underline", "persisted-underline", "#00ff00"),
                ("StrikeOut", "persisted-strikeout", "#0000ff"),
                ("Squiggly", "persisted-squiggly", "#336699"),
            ]
            .into_iter()
            .map(|(subtype, id, color)| MarkupSubtypeHint {
                subtype: subtype.to_string(),
                page_index: 0,
                marker_rect,
                markup_geometry: Some(vec![marker_rect]),
                app_annotation_id: None,
                annotation_id: None,
                color: Some(color.to_string()),
                author: None,
                created_at: None,
                modified_at: None,
                contents: None,
                id: Some(id.to_string()),
                page_markup_index: None,
                source: Some("editor".to_string()),
                opacity: None,
            })
            .collect(),
        }),
        placed_images: Vec::new(),
        placed_image_geometry_updates: Vec::new(),
        continuation: None,
    };

    append_native_mutations(&input_path, &input_path, &mutation, "D:20260609123456Z").unwrap();
    append_native_mutations(&input_path, &input_path, &mutation, "D:20260609123500Z").unwrap();

    let saved_bytes = read(&input_path).unwrap();
    // The path-backed native route appends only the annotation objects. A
    // renderer save would rewrite the source body instead of staying within
    // this bounded revision growth.
    assert!(saved_bytes.starts_with(&original_bytes));
    assert!(saved_bytes.len() - original_bytes.len() < 64 * 1024);
    let loaded = Document::load(&input_path).unwrap();
    let annots = get_page_annots(&loaded, page_id).unwrap();
    assert_eq!(annots.len(), 4);
    for (index, (subtype, id, color)) in [
        ("Highlight", "persisted-highlight", "#ff0000"),
        ("Underline", "persisted-underline", "#00ff00"),
        ("StrikeOut", "persisted-strikeout", "#0000ff"),
        ("Squiggly", "persisted-squiggly", "#336699"),
    ]
    .into_iter()
    .enumerate()
    {
        let object_id = annots[index].as_reference().unwrap();
        let annotation = loaded.get_dictionary(object_id).unwrap();
        assert_eq!(canonical_markup_subtype(annotation).as_deref(), Some(subtype));
        assert_eq!(
            pdf_string_to_text(annotation.get(b"NM").unwrap()).as_deref(),
            Some(id)
        );
        assert!(annotation.get(b"QuadPoints").is_ok());
        let quad_points = read_markup_quad_points(&loaded, annotation).unwrap();
        assert_quad_points_approximately(
            &quad_points,
            &[20.0, 80.0, 80.0, 80.0, 20.0, 70.0, 80.0, 70.0],
        );
        let appearance_ref = annotation
            .get(b"AP").unwrap().as_dict().unwrap()
            .get(b"N").unwrap().as_reference().unwrap();
        let appearance = loaded.get_object(appearance_ref).unwrap().as_stream().unwrap();
        let content = String::from_utf8(appearance.content.clone()).unwrap();
        assert!(content.contains("/GS0 gs"), "{subtype} opacity graphics state");
        let ext_gstate = appearance.dict.get(b"Resources").unwrap().as_dict().unwrap()
            .get(b"ExtGState").unwrap().as_dict().unwrap()
            .get(b"GS0").unwrap().as_dict().unwrap();
        assert_approximately(ext_gstate.get(b"CA").unwrap().as_float().unwrap() as f64, 1.0);
        assert_approximately(ext_gstate.get(b"ca").unwrap().as_float().unwrap() as f64, 1.0);
        let annotation_opacity = annotation.get(b"CA").unwrap();
        assert!(annotation_opacity.as_i64().is_ok_and(|value| value == 1)
            || annotation_opacity.as_float().is_ok_and(|value| value == 1.0));
        if subtype == "Highlight" {
            assert_eq!(ext_gstate.get(b"BM").unwrap().as_name().unwrap(), b"Multiply");
            assert!(content.lines().any(|line| line == "f"));
        } else if subtype == "Underline" || subtype == "StrikeOut" {
            assert!(content.lines().any(|line| line == "S"));
        }
        let expected = parse_css_rgb_color(Some(color)).unwrap();
        assert!(content.contains(&format!("{} {} {} rg", number_to_content(f64::from(expected.r) / 255.0), number_to_content(f64::from(expected.g) / 255.0), number_to_content(f64::from(expected.b) / 255.0))) || content.contains(&format!("{} {} {} RG", number_to_content(f64::from(expected.r) / 255.0), number_to_content(f64::from(expected.g) / 255.0), number_to_content(f64::from(expected.b) / 255.0))));
    }

    let _ = remove_file(input_path);
}

#[test]
fn appends_highlight_color_rewrite_as_display_rgb() {
    let (mut document, _page_id, markup_id) = create_test_markup_pdf("Highlight");
    let pdf_path = temp_pdf_path("append-highlight-color");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            geometry_updates: Vec::new(),
            notes: Vec::new(),
            free_text_notes: Vec::new(),
            text_boxes: Vec::new(),
            deletes: Vec::new(),
            page_rotations: Vec::new(),
            page_labels: None,
            bookmarks: None,
            shapes: None,
            markup: Some(MarkupMutation {
                hints: vec![MarkupSubtypeHint {
                    subtype: "Highlight".to_string(),
                    page_index: 0,
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.5,
                        width: 0.4,
                        height: 0.3,
                    },
                    markup_geometry: None,
                    app_annotation_id: None,
                    annotation_id: Some(format!("{} {} R", markup_id.0, markup_id.1)),
                    color: Some("#ff0000".to_string()),
                    author: None,
                    created_at: None,
                    modified_at: None,
                    contents: None,
                    id: None,
                    page_markup_index: Some(0),
                    source: Some("pdf".to_string()),
                    opacity: None,
                }],
            }),
            placed_images: Vec::new(),
            placed_image_geometry_updates: Vec::new(),
            continuation: None,
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let markup = loaded.get_dictionary(markup_id).unwrap();
    let color = markup.get(b"C").unwrap().as_array().unwrap();
    assert_approximately(color[0].as_float().unwrap() as f64, 1.0);
    assert_approximately(color[1].as_float().unwrap() as f64, 0.0);
    assert_approximately(color[2].as_float().unwrap() as f64, 0.0);
    assert!(markup.get(b"CA").unwrap().as_i64().is_ok_and(|value| value == 1));

    let _ = remove_file(pdf_path);
}

#[test]
fn appends_existing_markup_geometry_for_all_text_markup_subtypes() {
    let marker_rect = MarkerRect {
        left: 0.2,
        top: 0.2,
        width: 0.5,
        height: 0.1,
    };
    let expected_quad_points = [40.0, 80.0, 140.0, 80.0, 40.0, 70.0, 140.0, 70.0];

    for subtype in ["Highlight", "Underline", "StrikeOut", "Squiggly"] {
        let (mut document, _page_id, markup_id) = create_test_markup_pdf(subtype);
        let stale_appearance_id = document.add_object(Stream::new(Dictionary::new(), Vec::new()));
        document
            .get_dictionary_mut(markup_id)
            .unwrap()
            .set("AP", dictionary! {"N" => stale_appearance_id});
        let pdf_path = temp_pdf_path("append-existing-markup-geometry");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                markup: Some(MarkupMutation {
                    hints: vec![MarkupSubtypeHint {
                        subtype: subtype.to_string(),
                        page_index: 0,
                        marker_rect,
                        markup_geometry: Some(vec![marker_rect]),
                        app_annotation_id: None,
                        annotation_id: Some(format!("{} {} R", markup_id.0, markup_id.1)),
                        color: None,
                        opacity: None,
                        author: None,
                        created_at: None,
                        modified_at: None,
                        contents: None,
                        id: None,
                        page_markup_index: Some(0),
                        source: Some("editor".to_string()),
                    }],
                }),
                ..NativeMutationsFile::default()
            },
            "D:20260831130000Z",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let annotation = loaded.get_dictionary(markup_id).unwrap();
        let quad_points = read_markup_quad_points(&loaded, annotation).unwrap();
        assert_quad_points_approximately(&quad_points, &expected_quad_points);
        let rect = annotation.get(b"Rect").unwrap().as_array().unwrap();
        assert_quad_points_approximately(
            &rect
                .iter()
                .map(|value| value.as_float().unwrap() as f64)
                .collect::<Vec<_>>(),
            &[40.0, 70.0, 140.0, 80.0],
        );
        assert!(annotation.get(b"AP").is_ok(), "{subtype} appearance");
        let _ = remove_file(pdf_path);
    }
}

#[test]
fn opacity_only_markup_rewrite_updates_a_foreign_appearance() {
    let (mut document, page_id, markup_id) = create_test_markup_pdf("Highlight");
    let appearance_id = document.add_object(Stream::new(Dictionary::new(), Vec::new()));
    document
        .get_dictionary_mut(markup_id)
        .unwrap()
        .set("AP", dictionary! {"N" => appearance_id});

    apply_markup_mutations(
        &mut document,
        &MarkupMutation {
            hints: vec![MarkupSubtypeHint {
                subtype: "Highlight".to_string(),
                page_index: 0,
                marker_rect: MarkerRect {
                    left: 0.1,
                    top: 0.5,
                    width: 0.4,
                    height: 0.3,
                },
                markup_geometry: None,
                app_annotation_id: None,
                annotation_id: Some(format!("{} {} R", markup_id.0, markup_id.1)),
                color: None,
                opacity: Some(0.45),
                author: None,
                created_at: None,
                modified_at: None,
                contents: None,
                id: None,
                page_markup_index: Some(0),
                source: Some("pdf".to_string()),
            }],
        },
        "D:20260831123456Z",
    )
    .unwrap();

    let updated = document.get_dictionary(markup_id).unwrap();
    assert_approximately(updated.get(b"CA").unwrap().as_float().unwrap() as f64, 0.45);
    let appearance_ref = updated.get(b"AP").unwrap().as_dict().unwrap()
        .get(b"N").unwrap().as_reference().unwrap();
    let appearance = document.get_object(appearance_ref).unwrap().as_stream().unwrap();
    let graphics_state = appearance.dict.get(b"Resources").unwrap().as_dict().unwrap()
        .get(b"ExtGState").unwrap().as_dict().unwrap()
        .get(b"GS0").unwrap().as_dict().unwrap();
    assert_approximately(graphics_state.get(b"CA").unwrap().as_float().unwrap() as f64, 0.45);
    assert_approximately(graphics_state.get(b"ca").unwrap().as_float().unwrap() as f64, 0.45);
    assert!(document.get_dictionary(page_id).is_ok());
}

#[test]
fn recreates_managed_markup_after_an_incremental_delete_retired_its_object() {
    let (mut document, page_id) = create_test_document();
    let pdf_path = temp_pdf_path("recreate-deleted-managed-markup");
    let bindings_path = pdf_path.with_extension("bindings.json");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    let managed_highlight = |app_annotation_id: &str| NativeMutationsFile {
        markup: Some(MarkupMutation {
            hints: vec![MarkupSubtypeHint {
                subtype: "Highlight".to_string(),
                page_index: 0,
                marker_rect: MarkerRect {
                    left: 0.1,
                    top: 0.5,
                    width: 0.4,
                    height: 0.3,
                },
                markup_geometry: None,
                app_annotation_id: Some(app_annotation_id.to_string()),
                annotation_id: None,
                color: Some("#ffd400".to_string()),
                author: None,
                created_at: None,
                modified_at: None,
                contents: Some(String::new()),
                id: Some("9R".to_string()),
                page_markup_index: Some(0),
                source: Some("editor".to_string()),
                opacity: None,
            }],
        }),
        ..NativeMutationsFile::default()
    };

    append_native_mutations_with_qpdf(
        &pdf_path,
        &pdf_path,
        &managed_highlight("initial-highlight"),
        "D:20260829120400+04'00'",
        None,
        Some(&bindings_path),
    )
    .unwrap();
    let created = Document::load(&pdf_path).unwrap();
    let markup_id = get_page_annots(&created, page_id).unwrap()[0]
        .as_reference()
        .unwrap();

    append_native_mutations_with_qpdf(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            deletes: vec![AnnotationDelete {
                page_index: 0,
                object_number: Some(markup_id.0),
                generation_number: Some(markup_id.1),
                stable_key: None,
                created_at: None,
            }],
            markup: managed_highlight("recreated-highlight").markup,
            ..NativeMutationsFile::default()
        },
        "D:20260829120500+04'00'",
        None,
        Some(&bindings_path),
    )
    .expect("managed markup should be recreated under a fresh object ref");

    let recreated = Document::load(&pdf_path).unwrap();
    let annots = get_page_annots(&recreated, page_id).unwrap();
    assert_eq!(annots.len(), 1);
    let recreated_id = annots[0].as_reference().unwrap();
    assert!(matches!(recreated.get_object(markup_id), Ok(Object::Null)));
    assert_ne!(recreated_id, markup_id);
    assert_eq!(
        recreated
            .get_dictionary(recreated_id)
            .unwrap()
            .get(b"NM")
            .ok()
            .and_then(pdf_string_to_text)
            .as_deref(),
        Some("9R"),
    );

    let _ = remove_file(pdf_path);
    let _ = remove_file(bindings_path);
}

fn attach_markup_popup(
    document: &mut Document,
    page_id: ObjectId,
    markup_id: ObjectId,
) -> ObjectId {
    let popup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Rect" => vec![20.into(), 50.into(), 160.into(), 130.into()],
        "Parent" => Object::Reference(markup_id),
        "Contents" => Object::string_literal("old popup note"),
        "M" => Object::string_literal("D:20260828090000+04'00'"),
    });
    document
        .get_dictionary_mut(markup_id)
        .unwrap()
        .set("Popup", Object::Reference(popup_id));
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .get_mut(b"Annots")
        .unwrap()
        .as_array_mut()
        .unwrap()
        .push(Object::Reference(popup_id));
    popup_id
}

fn imported_markup_note_mutation(markup_id: ObjectId) -> NativeMutationsFile {
    NativeMutationsFile {
        markup: Some(MarkupMutation {
            hints: vec![MarkupSubtypeHint {
                subtype: "Highlight".to_string(),
                page_index: 0,
                marker_rect: MarkerRect {
                    left: 0.1,
                    top: 0.5,
                    width: 0.4,
                    height: 0.3,
                },
                markup_geometry: None,
                app_annotation_id: None,
                annotation_id: Some(format!("{} {} R", markup_id.0, markup_id.1)),
                color: None,
                author: None,
                created_at: None,
                modified_at: None,
                contents: Some("edited imported markup note".to_string()),
                id: None,
                page_markup_index: Some(0),
                source: Some("pdf".to_string()),
                opacity: None,
            }],
        }),
        ..NativeMutationsFile::default()
    }
}

fn assert_markup_note_and_popup(
    document: &Document,
    markup_id: ObjectId,
    popup_id: ObjectId,
) {
    let markup = document.get_dictionary(markup_id).unwrap();
    assert_eq!(
        markup.get(b"Contents").ok().and_then(pdf_string_to_text).as_deref(),
        Some("edited imported markup note"),
    );
    assert_eq!(
        markup.get(b"M").ok().and_then(pdf_string_to_text).as_deref(),
        Some("D:20260829120500+04'00'"),
    );
    let popup = document.get_dictionary(popup_id).unwrap();
    assert_eq!(
        popup.get(b"Contents").ok().and_then(pdf_string_to_text).as_deref(),
        Some("edited imported markup note"),
    );
    assert_eq!(
        popup.get(b"M").ok().and_then(pdf_string_to_text).as_deref(),
        Some("D:20260829120500+04'00'"),
    );
    assert_eq!(annotation_related_ref(popup, b"Parent"), Some(markup_id));
}

#[test]
fn rewrites_imported_markup_note_text_and_linked_popup_in_memory() {
    let (mut document, page_id, markup_id) = create_test_markup_pdf("Highlight");
    let popup_id = attach_markup_popup(&mut document, page_id, markup_id);

    apply_native_mutations(
        &mut document,
        &imported_markup_note_mutation(markup_id),
        "D:20260829120500+04'00'",
    )
    .unwrap();

    assert_markup_note_and_popup(&document, markup_id, popup_id);
}

#[test]
fn rewrites_imported_markup_using_the_canonical_identity_when_id_is_a_pdf_ref() {
    let (mut document, _page_id, markup_id) = create_test_markup_pdf("Highlight");
    document
        .get_dictionary_mut(markup_id)
        .unwrap()
        .set("NM", Object::string_literal("canonical-markup-id"));

    let mut mutation = imported_markup_note_mutation(markup_id);
    let hint = mutation
        .markup
        .as_mut()
        .expect("markup mutation exists")
        .hints
        .first_mut()
        .expect("markup hint exists");
    hint.app_annotation_id = Some("canonical-markup-id".to_string());
    hint.id = Some(format_pdfjs_annotation_ref(markup_id));

    apply_native_mutations(&mut document, &mutation, "D:20260829120500+04'00'").unwrap();

    let markup = document.get_dictionary(markup_id).unwrap();
    assert_eq!(
        markup.get(b"Contents").ok().and_then(pdf_string_to_text).as_deref(),
        Some("edited imported markup note"),
    );
}

#[test]
fn appends_imported_markup_note_text_without_materializing_the_document() {
    let (mut document, page_id, markup_id) = create_test_markup_pdf("Highlight");
    let popup_id = attach_markup_popup(&mut document, page_id, markup_id);
    let pdf_path = temp_pdf_path("append-highlight-note-text");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &imported_markup_note_mutation(markup_id),
        "D:20260829120500+04'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    assert_markup_note_and_popup(&loaded, markup_id, popup_id);
    assert!(read(&pdf_path).unwrap().starts_with(&original_bytes));

    let _ = remove_file(pdf_path);
}

#[test]
fn rejects_imported_markup_when_linked_popup_note_text_is_stale() {
    let (mut document, page_id, markup_id) = create_test_markup_pdf("Highlight");
    let popup_id = attach_markup_popup(&mut document, page_id, markup_id);
    document.get_dictionary_mut(markup_id).unwrap().set(
        "Contents",
        Object::string_literal("edited imported markup note"),
    );

    let mutation = imported_markup_note_mutation(markup_id);
    let error = validate_markup_document_postconditions(
        &document,
        mutation.markup.as_ref().expect("markup mutation exists"),
    )
    .expect_err("stale linked Popup text must fail the native postcondition");

    assert!(error.to_string().contains("popup annotation Contents"));
    assert_eq!(
        document
            .get_dictionary(popup_id)
            .unwrap()
            .get(b"Contents")
            .ok()
            .and_then(pdf_string_to_text)
            .as_deref(),
        Some("old popup note"),
    );
}

fn create_sparse_high_index_markup() -> (Document, ObjectId, ObjectId) {
    let (mut document, _first_page_id, last_page_id) = create_sparse_million_page_document();
    let markup_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Highlight",
        "Rect" => vec![20.into(), 20.into(), 100.into(), 50.into()],
        "C" => vec![1.into(), 1.into(), 0.into()],
        "P" => Object::Reference(last_page_id),
    });
    document
        .get_dictionary_mut(last_page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(markup_id)]);
    (document, last_page_id, markup_id)
}

#[test]
fn rewrites_high_index_markup_by_page_hint_without_a_page_walk() {
    let (document, last_page_id, markup_id) = create_sparse_high_index_markup();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    let mutation = MarkupMutation {
        hints: vec![MarkupSubtypeHint {
            subtype: "Underline".to_string(),
            page_index: 999_999,
            marker_rect: MarkerRect {
                left: 0.1,
                top: 0.5,
                width: 0.4,
                height: 0.3,
            },
            markup_geometry: None,
            app_annotation_id: None,
            annotation_id: None,
            color: Some("#336699".to_string()),
            author: None,
            created_at: None,
            modified_at: None,
            contents: None,
            id: Some("high-index-page-hint".to_string()),
            page_markup_index: Some(0),
            source: None,
            opacity: None,
        }],
    };

    reset_page_tree_node_read_count();
    apply_markup_mutations_incremental(
        &mut incremental,
        &mutation,
        "D:20260829120500+04'00'",
    )
    .unwrap();

    let revision = &incremental;
    let markup = revision.dictionary(markup_id).unwrap();
    assert_eq!(
        canonical_markup_subtype(markup).as_deref(),
        Some("Underline")
    );
    assert!(markup.get(b"QuadPoints").is_ok());
    assert!(get_page_annots(revision, last_page_id)
        .unwrap()
        .iter()
        .any(|object| object.as_reference().ok() == Some(markup_id)));
    assert!(
        page_tree_node_read_count() < 100,
        "high-index markup page hint walked too many page-tree nodes: {}",
        page_tree_node_read_count()
    );
}

#[test]
fn stale_markup_page_hint_uses_the_annotation_owner_without_a_page_walk() {
    let (document, last_page_id, markup_id) = create_sparse_high_index_markup();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    let mutation = MarkupMutation {
        hints: vec![MarkupSubtypeHint {
            subtype: "Squiggly".to_string(),
            page_index: 0,
            marker_rect: MarkerRect {
                left: 0.1,
                top: 0.5,
                width: 0.4,
                height: 0.3,
            },
            markup_geometry: None,
            app_annotation_id: None,
            annotation_id: Some(format!("{} {} R", markup_id.0, markup_id.1)),
            color: Some("#00ff00".to_string()),
            author: None,
            created_at: None,
            modified_at: None,
            contents: None,
            id: Some("stale-markup-page-hint".to_string()),
            page_markup_index: Some(0),
            source: Some("editor-live".to_string()),
            opacity: None,
        }],
    };

    reset_page_tree_node_read_count();
    apply_markup_mutations_incremental(
        &mut incremental,
        &mutation,
        "D:20260829120500+04'00'",
    )
    .unwrap();

    let revision = &incremental;
    let markup = revision.dictionary(markup_id).unwrap();
    assert_eq!(
        canonical_markup_subtype(markup).as_deref(),
        Some("Squiggly")
    );
    assert!(markup.get(b"AP").is_ok());
    assert!(get_page_annots(revision, last_page_id)
        .unwrap()
        .iter()
        .any(|object| object.as_reference().ok() == Some(markup_id)));
    assert!(
        page_tree_node_read_count() < 100,
        "stale markup owner lookup walked too many page-tree nodes: {}",
        page_tree_node_read_count()
    );
}

#[test]
fn appends_managed_shape_as_incremental_revision() {
    let (mut document, page_id) = create_test_document();
    let input_path = temp_pdf_path("append-shape-input");
    let output_path = temp_pdf_path("append-shape-output");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();
    write(&output_path, &original_bytes).unwrap();

    append_native_mutations(
        &input_path,
        &output_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            geometry_updates: Vec::new(),
            notes: Vec::new(),
            free_text_notes: Vec::new(),
            text_boxes: Vec::new(),
            deletes: Vec::new(),
            page_rotations: Vec::new(),
            page_labels: None,
            bookmarks: None,
            shapes: Some(ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes: vec![rectangle_shape("evb-shape:rect-1", "#336699")],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            }),
            markup: None,
            placed_images: Vec::new(),
            placed_image_geometry_updates: Vec::new(),
            continuation: None,
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
    let annots = get_page_annots(&loaded, page_id).unwrap();
    assert_eq!(annots.len(), 1);
    let shape_ref = annots[0].as_reference().unwrap();
    let shape = loaded.get_dictionary(shape_ref).unwrap();
    assert_eq!(annotation_subtype(shape), "square");
    assert_eq!(
        read_managed_shape_stable_key(shape).as_deref(),
        Some("evb-shape:rect-1")
    );
    assert_eq!(
        pdf_string_to_text(shape.get(b"EVBShapeKey").unwrap()).unwrap(),
        "evb-shape:rect-1"
    );
    assert!(shape.get(b"Rect").is_ok());
    assert!(shape.get(b"C").is_ok());
    assert!(shape.get(b"IC").is_ok());
    assert_eq!(shape.get(b"CA").unwrap().as_float().unwrap(), 0.5);

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn appends_ink_with_a_preview_compatible_normal_appearance() {
    let (mut document, page_id) = create_test_document();
    let pdf_path = temp_pdf_path("append-ink-appearance");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            geometry_updates: Vec::new(),
            notes: Vec::new(),
            free_text_notes: Vec::new(),
            text_boxes: Vec::new(),
            deletes: Vec::new(),
            page_rotations: Vec::new(),
            page_labels: None,
            bookmarks: None,
            shapes: Some(ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes: vec![ink_shape("evb-shape:ink-1", "#2563eb")],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            }),
            markup: None,
            placed_images: Vec::new(),
            placed_image_geometry_updates: Vec::new(),
            continuation: None,
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let annots = get_page_annots(&loaded, page_id).unwrap();
    let ink_ref = annots[0].as_reference().unwrap();
    let ink = loaded.get_dictionary(ink_ref).unwrap();
    assert_eq!(annotation_subtype(ink), "ink");
    assert_eq!(ink.get(b"F").unwrap().as_i64().unwrap() & 4, 4);
    assert_eq!(ink.get(b"CA").unwrap().as_float().unwrap(), 0.65);
    let appearance_ref = ink
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
    assert_eq!(
        appearance.dict.get(b"Subtype").unwrap().as_name().unwrap(),
        b"Form"
    );
    assert!(appearance.dict.get(b"BBox").is_ok());
    assert!(appearance.dict.get(b"Resources").is_ok());
    let ink_graphics_state = appearance.dict.get(b"Resources").unwrap().as_dict().unwrap()
        .get(b"ExtGState").unwrap().as_dict().unwrap()
        .get(b"GS0").unwrap().as_dict().unwrap();
    assert_approximately(ink_graphics_state.get(b"CA").unwrap().as_float().unwrap() as f64, 0.65);
    assert_approximately(ink_graphics_state.get(b"ca").unwrap().as_float().unwrap() as f64, 0.65);
    let content = String::from_utf8(appearance.content.clone()).unwrap();
    assert!(content.contains("/GS0 gs"));
    assert!(content.contains("1 J"));
    assert!(content.contains("1 j"));
    assert!(content.contains(" m\n"));
    assert!(content.contains(" l\n"));
    assert!(content.ends_with("S\nQ\n"));

    let _ = remove_file(pdf_path);
}

#[test]
fn parse_pdf_color_rejects_non_ascii_hex_without_panic() {
    let parsed = std::panic::catch_unwind(|| parse_pdf_color(Some("#\u{e9}a")));

    assert!(parsed.is_ok());
    assert!(parsed.unwrap().is_none());
    assert!(parse_pdf_color(Some("#abc")).is_some());
    assert!(parse_pdf_color(Some("#aabbcc")).is_some());
}

#[test]
fn validates_required_shape_color() {
    for color in ["#\u{e9}a", "transparent", "none", ""] {
        let mut shape = rectangle_shape("evb-shape:invalid-color", color);
        shape.fill_color = Some("transparent".to_string());

        let error = validate_shapes_mutation(&ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![shape],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        })
        .unwrap_err()
        .to_string();

        assert!(error.contains("Invalid shape color"));
    }
}

fn test_markup_hint(index: usize) -> MarkupSubtypeHint {
    MarkupSubtypeHint {
        subtype: "Highlight".to_string(),
        page_index: 0,
        marker_rect: MarkerRect {
            left: 0.0,
            top: 0.0,
            width: 1.0,
            height: 1.0,
        },
        markup_geometry: None,
        app_annotation_id: None,
        annotation_id: None,
        color: Some("#ffff00".to_string()),
        author: None,
        created_at: None,
        modified_at: None,
        contents: None,
        id: Some(format!("hint-{index}")),
        page_markup_index: Some(index as u32),
        source: None,
        opacity: None,
    }
}

#[test]
fn preserves_distinct_markup_identities_when_geometry_is_identical() {
    for subtype in ["Highlight", "Underline", "StrikeOut", "Squiggly"] {
        let mut first = test_markup_hint(0);
        first.subtype = subtype.to_string();
        first.app_annotation_id = Some(format!("{subtype}-app-first"));
        first.id = Some(format!("{subtype}-first"));

        let mut second = first.clone();
        second.app_annotation_id = Some(format!("{subtype}-app-second"));
        second.id = Some(format!("{subtype}-second"));

        let states = dedupe_markup_subtype_hints(&[first, second])
            .expect("identical geometry hints should remain bounded");
        assert_eq!(
            states.len(),
            2,
            "distinct {subtype} identities must not be merged by geometry"
        );
    }

    let mut first = test_markup_hint(0);
    first.id = None;
    let mut second = first.clone();
    second.page_markup_index = Some(1);
    let states = dedupe_markup_subtype_hints(&[first, second])
        .expect("legacy idless geometry hints should remain supported");
    assert_eq!(states.len(), 1);
}

#[test]
fn validates_each_distinct_new_markup_identity_after_save() {
    let (mut document, page_id, foreign_id) = create_test_markup_pdf("Highlight");
    let foreign = document.get_dictionary_mut(foreign_id).unwrap();
    foreign.set("Rect", vec![0.into(), 0.into(), 200.into(), 100.into()]);
    foreign.set("NM", Object::string_literal("foreign-highlight"));
    foreign.set("Contents", Object::string_literal("Foreign highlight"));
    let foreign_before = foreign.clone();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    let mut first = test_markup_hint(0);
    first.app_annotation_id = Some("highlight-app-first".to_string());
    first.id = Some("highlight-first".to_string());
    first.source = Some("editor".to_string());
    let mut second = first.clone();
    second.app_annotation_id = Some("highlight-app-second".to_string());
    second.id = Some("highlight-second".to_string());
    let mutation = MarkupMutation {
        hints: vec![first, second],
    };

    apply_markup_mutations_incremental(&mut incremental, &mutation, "D:20260831130000Z")
        .expect("same-geometry markup annotations should be saved");
    let revision = &incremental;
    validate_markup_document_postconditions(revision, &mutation)
        .expect("each requested markup identity should survive save validation");

    let names: Vec<_> = get_page_annots(revision, page_id)
        .expect("page annotations")
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter_map(|object_id| revision.dictionary(object_id).ok())
        .filter_map(|dict| dict.get(b"NM").ok().and_then(pdf_string_to_text))
        .collect();
    assert_eq!(names.len(), 3);
    assert!(names.iter().any(|name| name == "foreign-highlight"));
    assert_eq!(revision.dictionary(foreign_id).unwrap(), &foreign_before);
    assert!(names.iter().any(|name| name == "highlight-first"));
    assert!(names.iter().any(|name| name == "highlight-second"));
}

#[test]
fn accepts_editor_sized_multilingual_markup_contents() {
    let mut hint = test_markup_hint(0);
    hint.contents = Some("я".repeat(1_025));
    validate_markup_mutation(&MarkupMutation { hints: vec![hint.clone()] }).unwrap();
    hint.contents = Some("界".repeat(65_536));
    validate_markup_mutation(&MarkupMutation { hints: vec![hint.clone()] }).unwrap();
    hint.contents = Some(format!("{}a", "界".repeat(65_536)));
    assert!(validate_markup_mutation(&MarkupMutation { hints: vec![hint] }).is_err());
}

#[test]
fn caps_text_markup_hints_before_matching() {
    let hints = (0..=MAX_MARKUP_SUBTYPE_HINTS)
        .map(test_markup_hint)
        .collect();

    let error = validate_markup_mutation(&MarkupMutation {
        hints,
    })
    .expect_err("oversized hint list must fail");

    assert!(error.to_string().contains("Too many text-markup mutations"));
}

#[test]
fn rejects_text_markup_geometry_budget_during_deserialization() {
    let marker_rect = r#"{"left":0.1,"top":0.2,"width":0.3,"height":0.1}"#;
    let geometry = std::iter::repeat_n(marker_rect, MAX_MARKUP_GEOMETRY_ITEMS).collect::<Vec<_>>().join(",");
    let source = format!(
        r#"{{"hints":[{{"subtype":"Highlight","pageIndex":0,"markerRect":{marker_rect},"markupGeometry":[{geometry}]}},{{"subtype":"Underline","pageIndex":0,"markerRect":{marker_rect},"markupGeometry":[{marker_rect}]}}]}}"#,
    );

    let error = serde_json::from_str::<MarkupMutation>(&source)
        .err()
        .expect("the mutation-wide geometry budget must reject one item over");

    assert!(error
        .to_string()
        .contains("text-markup geometry exceeds the 512-item admission ceiling"));
}

#[test]
fn rejects_text_markup_geometry_budget_during_validation() {
    let marker_rect = MarkerRect {
        left: 0.1,
        top: 0.2,
        width: 0.3,
        height: 0.1,
    };
    let mut first_hint = test_markup_hint(0);
    first_hint.markup_geometry = Some(vec![marker_rect; MAX_MARKUP_GEOMETRY_ITEMS]);
    let mut second_hint = test_markup_hint(1);
    second_hint.markup_geometry = Some(vec![marker_rect]);

    let error = validate_markup_mutation(&MarkupMutation {
        hints: vec![first_hint, second_hint],
    })
    .expect_err("validation must enforce the mutation-wide geometry budget");

    assert!(error
        .to_string()
        .contains("Too many text-markup geometry rectangles"));
}

#[test]
fn rejects_text_markup_opacity_outside_unit_range() {
    let mut hint = test_markup_hint(0);
    hint.opacity = Some(1.01);

    let error = validate_markup_mutation(&MarkupMutation {
        hints: vec![hint],
    })
    .expect_err("text-markup opacity must stay within the PDF unit range");

    assert!(error.to_string().contains("Invalid text-markup opacity"));
}

#[test]
fn bounds_dense_markup_assignment_comparisons() {
    let hints: Vec<_> = (0..MAX_MARKUP_SUBTYPE_HINTS)
        .map(|index| {
            let hint = test_markup_hint(index);
            MarkupHintState {
                annotation_ref: None,
                color: parse_css_rgb_color(hint.color.as_deref()),
                hint,
                consumed: false,
            }
        })
        .collect();
    let candidates: Vec<_> = (0..129)
        .map(|index| MarkupAnnotationCandidate {
            color: Some(RgbColor {
                r: 255,
                g: 255,
                b: 0,
            }),
            opacity: None,
            has_appearance: false,
            marker_rect: Some(MarkerRect {
                left: 0.0,
                top: 0.0,
                width: 1.0,
                height: 1.0,
            }),
            object_id: (index + 1, 0),
            page_markup_index: index,
            quad_points: None,
            rect: Some(PdfRect {
                x1: 0.0,
                y1: 0.0,
                x2: 1.0,
                y2: 1.0,
            }),
            ref_tag: format!("{index}R"),
            subtype: "Highlight".to_string(),
        })
        .collect();

    let error = assign_subtype_hints_to_candidates(&hints, &candidates)
        .expect_err("pathological overlap must stop at the work budget");

    assert!(error.to_string().contains("comparison budget exceeded"));
}

#[test]
fn spatial_markup_assignment_preserves_best_geometry_matches() {
    let marker_rects = [
        MarkerRect {
            left: 0.05,
            top: 0.1,
            width: 0.2,
            height: 0.1,
        },
        MarkerRect {
            left: 0.7,
            top: 0.8,
            width: 0.2,
            height: 0.1,
        },
    ];
    let hints = marker_rects
        .iter()
        .copied()
        .enumerate()
        .map(|(index, marker_rect)| MarkupSubtypeHint {
            subtype: if index == 0 { "Underline" } else { "StrikeOut" }.to_string(),
            page_index: 0,
            marker_rect,
            markup_geometry: None,
            app_annotation_id: None,
            annotation_id: None,
            color: Some("#336699".to_string()),
            author: None,
            created_at: None,
            modified_at: None,
            contents: None,
            id: Some(format!("spatial-{index}")),
            page_markup_index: Some(index as u32),
            source: None,
            opacity: None,
        })
        .collect::<Vec<_>>();
    let hint_states = dedupe_markup_subtype_hints(&hints).expect("dedupe hints");
    let candidates = marker_rects
        .iter()
        .copied()
        .enumerate()
        .map(|(index, marker_rect)| MarkupAnnotationCandidate {
            color: Some(RgbColor {
                r: 0x33,
                g: 0x66,
                b: 0x99,
            }),
            opacity: None,
            has_appearance: false,
            marker_rect: Some(marker_rect),
            object_id: (index as u32 + 1, 0),
            page_markup_index: index as u32,
            quad_points: None,
            rect: None,
            ref_tag: format!("{}R", index + 1),
            subtype: "Highlight".to_string(),
        })
        .collect::<Vec<_>>();

    let assignments = assign_subtype_hints_to_candidates(&hint_states, &candidates)
        .expect("bounded spatial assignment");

    assert_eq!(assignments, vec![(0, 0), (1, 1)]);
}

#[test]
fn updates_and_deletes_managed_shapes_as_incremental_revision() {
    let (mut document, page_id) = create_test_document();
    let pdf_path = temp_pdf_path("append-shape-update-delete");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&pdf_path, &original_bytes).unwrap();

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            geometry_updates: Vec::new(),
            notes: Vec::new(),
            free_text_notes: Vec::new(),
            text_boxes: Vec::new(),
            deletes: Vec::new(),
            page_rotations: Vec::new(),
            page_labels: None,
            bookmarks: None,
            shapes: Some(ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes: vec![
                    rectangle_shape("evb-shape:keep", "#336699"),
                    rectangle_shape("evb-shape:delete", "#ff0000"),
                ],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            }),
            markup: None,
            placed_images: Vec::new(),
            placed_image_geometry_updates: Vec::new(),
            continuation: None,
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let mut updated = rectangle_shape("evb-shape:keep", "#112233");
    updated.x = 0.2;
    updated.y = 0.25;
    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            geometry_updates: Vec::new(),
            notes: Vec::new(),
            free_text_notes: Vec::new(),
            text_boxes: Vec::new(),
            deletes: Vec::new(),
            page_rotations: Vec::new(),
            page_labels: None,
            bookmarks: None,
            shapes: Some(ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes: vec![updated],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: vec!["evb-shape:delete".to_string()],
            }),
            markup: None,
            placed_images: Vec::new(),
            placed_image_geometry_updates: Vec::new(),
            continuation: None,
        },
        "D:20260609123500+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let annots = get_page_annots(&loaded, page_id).unwrap();
    let shape_refs: Vec<ObjectId> = annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
        .filter(|object_id| {
            loaded
                .get_dictionary(*object_id)
                .map(|dict| is_supported_shape_subtype(&annotation_subtype(dict)))
                .unwrap_or(false)
        })
        .collect();
    assert_eq!(shape_refs.len(), 1);
    let shape = loaded.get_dictionary(shape_refs[0]).unwrap();
    assert_eq!(
        read_managed_shape_stable_key(shape).as_deref(),
        Some("evb-shape:keep")
    );
    let color = shape.get(b"C").unwrap().as_array().unwrap();
    assert_approximately(color[0].as_float().unwrap() as f64, 0x11 as f64 / 255.0);
    assert!(annots.iter().all(|object| {
        object
            .as_reference()
            .ok()
            .and_then(|object_id| loaded.get_dictionary(object_id).ok())
            .and_then(read_managed_shape_stable_key)
            .as_deref()
            != Some("evb-shape:delete")
    }));

    let _ = remove_file(pdf_path);
}

#[test]
fn deletes_explicit_shapes_without_page_backrefs_from_full_and_incremental_documents() {
    let (mut document, page_id) = create_test_document();
    let mut shape = shape_with_stale_appearance("Square");
    shape.set("NM", Object::string_literal("shape-without-page"));
    let shape_id = document.add_object(Object::Dictionary(shape));
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(shape_id)]);
    apply_shape_annotations(
        &mut document,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: Vec::new(),
            deleted_annotation_ids: vec![format!("{} {} R", shape_id.0, shape_id.1)],
            deleted_stable_keys: Vec::new(),
        },
        "D:20260831130000Z",
        &mut None,
    )
    .unwrap();
    assert!(get_page_annots(&document, page_id).unwrap().is_empty());

    let (mut document, page_id) = create_test_document();
    let mut shape = shape_with_stale_appearance("Square");
    shape.set(
        "NM",
        Object::string_literal("shape-without-page-incremental"),
    );
    let shape_id = document.add_object(Object::Dictionary(shape));
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(shape_id)]);
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    apply_shape_annotations_incremental(
        &mut incremental,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: Vec::new(),
            deleted_annotation_ids: vec![format!("{} {} R", shape_id.0, shape_id.1)],
            deleted_stable_keys: Vec::new(),
        },
        "D:20260831130000Z",
        &mut None,
    )
    .unwrap();
    let revision = &incremental;
    assert!(get_page_annots(revision, page_id).unwrap().is_empty());
}

fn saved_annotation_regression(
    source: &Document,
    mutations: &NativeMutationsFile,
    route: &str,
    modified_at: &str,
) -> Document {
    let mut source = source.clone();
    let mut bytes = Vec::new();
    source.save_to(&mut bytes).unwrap();
    let saved = match route {
        "full" => {
            let mut document = Document::load_mem(&bytes).unwrap();
            apply_native_mutations(&mut document, mutations, modified_at).unwrap();
            let mut saved = Vec::new();
            document.save_to(&mut saved).unwrap();
            saved
        }
        "path" => {
            let path = temp_pdf_path("annotation-fidelity");
            write(&path, &bytes).unwrap();
            append_native_mutations(&path, &path, mutations, modified_at).unwrap();
            let saved = read(&path).unwrap();
            remove_file(path).unwrap();
            assert!(saved.starts_with(&bytes));
            saved
        }
        "bytes" => {
            append_native_mutations_to_bytes(&bytes, mutations, modified_at)
                .unwrap()
                .data
        }
        _ => panic!("unknown save route"),
    };
    Document::load_mem(&saved).unwrap()
}

fn add_shape_discussion(
    document: &mut Document,
    page_id: ObjectId,
    parent: ObjectId,
) -> (ObjectId, ObjectId) {
    let popup = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Popup", "Parent" => parent,
        "P" => page_id, "Rect" => vec![10.into(), 10.into(), 40.into(), 40.into()],
    });
    let reply = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "IRT" => parent,
        "P" => page_id, "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
        "Contents" => Object::string_literal("Important reply"),
    });
    document
        .get_dictionary_mut(parent)
        .unwrap()
        .set("Popup", popup);
    (popup, reply)
}

#[test]
fn patches_a_bare_shape_without_dropping_rich_text_review_reply_or_unknown_keys() {
    let (mut document, page_id) = create_test_document();
    let mut shape = shape_with_stale_appearance("Square");
    shape.remove(b"AP");
    shape.set("NM", Object::string_literal("acrobat-square"));
    shape.set("Contents", Object::string_literal("Parent discussion"));
    shape.set("RC", Object::string_literal("<p>Parent discussion</p>"));
    shape.set("State", Object::Name(b"Accepted".to_vec()));
    shape.set("CreationDate", Object::string_literal("D:19691231235959Z"));
    shape.set("UnknownKey", Object::Integer(77));
    let shape_id = document.add_object(shape);
    let (popup_id, reply_id) = add_shape_discussion(&mut document, page_id, shape_id);
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        vec![shape_id.into(), popup_id.into(), reply_id.into()],
    );
    let before = document.get_dictionary(shape_id).unwrap().clone();
    for route in ["full", "path", "bytes"] {
        for key in ["evb-shape:acrobat-square", "acrobat-square"] {
            let mut requested = rectangle_shape(key, "#112233");
            requested.annotation_id = Some(format!("{} {} R", shape_id.0, shape_id.1));
            requested.created_at = None;
            let loaded = saved_annotation_regression(
                &document,
                &shapes_mutation(vec![requested]),
                route,
                "D:20260831130000Z",
            );
            let annots = get_page_annots(&loaded, page_id).unwrap();
            assert_eq!(
                annots,
                vec![shape_id.into(), popup_id.into(), reply_id.into()],
                "{route}: original parent and listed thread"
            );
            let after = loaded.get_dictionary(shape_id).unwrap();
            for key in [
                b"NM".as_slice(),
                b"Contents",
                b"RC",
                b"State",
                b"UnknownKey",
                b"CreationDate",
                b"Popup",
            ] {
                assert_eq!(
                    after.get(key).unwrap(),
                    before.get(key).unwrap(),
                    "{route}: {key:?}"
                );
            }
            assert_eq!(
                after.get(b"C").unwrap(),
                &Object::Array(vec![
                    number_object(17.0 / 255.0),
                    number_object(34.0 / 255.0),
                    number_object(51.0 / 255.0)
                ])
            );
            assert_eq!(
                loaded
                    .get_dictionary(popup_id)
                    .unwrap()
                    .get(b"Parent")
                    .unwrap()
                    .as_reference()
                    .unwrap(),
                shape_id
            );
            let reply = loaded.get_dictionary(reply_id).unwrap();
            assert_eq!(reply.get(b"IRT").unwrap().as_reference().unwrap(), shape_id);
            assert_eq!(
                pdf_string_to_text(reply.get(b"Contents").unwrap()).as_deref(),
                Some("Important reply")
            );
        }
    }
}

#[test]
fn keeps_an_existing_creation_date_the_edit_does_not_know() {
    let original = Object::string_literal("D:19691231235959Z");
    let edit = |shape_id: (u32, u16)| {
        let mut requested = rectangle_shape("dated-shape", "#112233");
        requested.annotation_id = Some(format!("{} {} R", shape_id.0, shape_id.1));
        requested.created_at = None;
        ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![requested],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        }
    };
    let dated_document = || {
        let (mut document, page_id) = create_test_document();
        let mut shape = shape_with_stale_appearance("Square");
        shape.set("NM", Object::string_literal("dated-shape"));
        shape.set("CreationDate", original.clone());
        let shape_id = document.add_object(Object::Dictionary(shape));
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(shape_id)]);
        (document, shape_id)
    };
    let assert_dates = |after: &Dictionary| {
        assert_eq!(after.get(b"CreationDate").unwrap(), &original);
        assert_ne!(after.get(b"M").unwrap(), &original);
    };

    let (mut document, shape_id) = dated_document();
    apply_shape_annotations(&mut document, &edit(shape_id), "D:20260831130000Z", &mut None)
        .unwrap();
    assert_dates(document.get_dictionary(shape_id).unwrap());

    let (document, shape_id) = dated_document();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    apply_shape_annotations_incremental(
        &mut incremental,
        &edit(shape_id),
        "D:20260831130000Z",
        &mut None,
    )
    .unwrap();
    assert_dates(incremental.dictionary(shape_id).unwrap());
}

#[test]
fn writes_the_supplied_shape_identity_to_nm_without_a_generated_prefix() {
    let shape = rectangle_shape("shape-created-bare", "#112233");
    let dict = create_shape_annotation_dict(
        &shape,
        PdfRect {
            x1: 0.0,
            y1: 0.0,
            x2: 200.0,
            y2: 100.0,
        },
        0,
        "D:20260831130000Z",
    )
    .unwrap();
    assert_eq!(
        read_annotation_name(&dict).as_deref(),
        Some("shape-created-bare")
    );
    assert!(read_managed_shape_stable_key(&dict).is_none());
}

#[test]
fn deletes_high_index_shapes_by_evb_key_or_managed_nm_without_a_page_walk() {
    for (stable_key, use_private_key) in [
        ("evb-shape:delete-high-index-private", true),
        ("evb-shape:delete-high-index-nm", false),
    ] {
        let (mut document, _first_page_id, last_page_id) = create_sparse_million_page_document();
        let mut shape = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Square",
            "Rect" => vec![0.into(), 0.into(), 100.into(), 50.into()],
            "P" => Object::Reference(last_page_id),
        };
        shape.set(
            if use_private_key { "EVBShapeKey" } else { "NM" },
            Object::string_literal(stable_key),
        );
        let shape_id = document.add_object(shape);
        document
            .get_dictionary_mut(last_page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(shape_id)]);

        reset_page_tree_node_read_count();
        apply_shape_annotations(
            &mut document,
            &ShapesMutation {
                total_pages: 1_000_000,
                rewrite_shape_state: true,
                shapes: Vec::new(),
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: vec![stable_key.to_string()],
            },
            "D:20260609123456Z",
        &mut None,
)
        .unwrap();
        assert!(get_page_annots(&document, last_page_id).unwrap().is_empty());
        assert!(
            page_tree_node_read_count() < 100,
            "stable-key shape deletion walked too many page-tree nodes: {}",
            page_tree_node_read_count()
        );

        let (mut document, _first_page_id, last_page_id) = create_sparse_million_page_document();
        let mut shape = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Square",
            "Rect" => vec![0.into(), 0.into(), 100.into(), 50.into()],
            "P" => Object::Reference(last_page_id),
        };
        shape.set(
            if use_private_key { "EVBShapeKey" } else { "NM" },
            Object::string_literal(stable_key),
        );
        let shape_id = document.add_object(shape);
        document
            .get_dictionary_mut(last_page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(shape_id)]);
        let mut incremental = IncrementalDocument::from_document(document, 0, None);

        apply_shape_annotations_incremental(
            &mut incremental,
            &ShapesMutation {
                total_pages: 1_000_000,
                rewrite_shape_state: true,
                shapes: Vec::new(),
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: vec![stable_key.to_string()],
            },
            "D:20260609123456Z",
        &mut None,
)
        .unwrap();
        let revision = &incremental;
        assert!(get_page_annots(revision, last_page_id).unwrap().is_empty());
    }
}

fn embedded_shape_pdf(annotations: &[(&str, Dictionary)]) -> (Document, ObjectId) {
    let (mut document, page_id) = create_test_document();
    let mut annots = Vec::new();
    for (stable_key, dict) in annotations {
        let object_id = document.add_object(Object::Dictionary(dict.clone()));
        write_managed_shape_stable_key(
            document.get_dictionary_mut(object_id).unwrap(),
            Some(stable_key),
        );
        annots.push(Object::Reference(object_id));
    }
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", annots);
    (document, page_id)
}

fn seed_shape_pdf(document: &mut Document, label: &str) -> PathBuf {
    let path = temp_pdf_path(label);
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    write(&path, &bytes).unwrap();
    path
}

fn shape_rect_values(document: &Document, stable_key: &str) -> Vec<f64> {
    let page_id = *document.get_pages().values().next().unwrap();
    for object in get_page_annots(document, page_id).unwrap() {
        let Ok(object_id) = object.as_reference() else {
            continue;
        };
        let Ok(dict) = document.get_dictionary(object_id) else {
            continue;
        };
        if read_managed_shape_stable_key(dict).as_deref() != Some(stable_key) {
            continue;
        }
        return dict
            .get(b"Rect")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_float().unwrap() as f64)
            .collect();
    }
    panic!("shape {stable_key} is missing from the saved document");
}

fn shape_dict<'a>(document: &'a Document, stable_key: &str) -> &'a Dictionary {
    let page_id = *document.get_pages().values().next().unwrap();
    for object in get_page_annots(document, page_id).unwrap() {
        let Ok(object_id) = object.as_reference() else {
            continue;
        };
        let Ok(dict) = document.get_dictionary(object_id) else {
            continue;
        };
        if read_managed_shape_stable_key(dict).as_deref() == Some(stable_key) {
            return dict;
        }
    }
    panic!("shape {stable_key} is missing from the saved document");
}

fn off_page_square_dict() -> Dictionary {
    dictionary! {
        "Type" => "Annot",
        "Subtype" => "Square",
        // Crosses the left and top page edges of the 200x100 test page.
        "Rect" => vec![(-20).into(), 40.into(), 60.into(), 120.into()],
        "C" => vec![0.into(), 0.into(), 0.into()],
    }
}

fn on_page_square_dict() -> Dictionary {
    dictionary! {
        "Type" => "Annot",
        "Subtype" => "Square",
        "Rect" => vec![20.into(), 20.into(), 100.into(), 60.into()],
        "C" => vec![0.into(), 0.into(), 0.into()],
    }
}

/// Marker geometry the importer derives from `off_page_square_dict`: the
/// rect is clamped into the unit page box, which shifts its left/top edges.
fn imported_off_page_square(stable_key: &str) -> ShapeAnnotation {
    let mut shape = rectangle_shape(stable_key, "#336699");
    shape.fill_color = None;
    shape.x = 0.0;
    shape.y = 0.0;
    shape.width = 0.4;
    shape.height = 0.8;
    shape
}

fn imported_on_page_square(stable_key: &str) -> ShapeAnnotation {
    let mut shape = rectangle_shape(stable_key, "#336699");
    shape.fill_color = None;
    shape.x = 0.1;
    shape.y = 0.4;
    shape.width = 0.4;
    shape.height = 0.4;
    shape
}

fn shapes_mutation(shapes: Vec<ShapeAnnotation>) -> NativeMutationsFile {
    NativeMutationsFile {
        updates: Vec::new(),
        geometry_updates: Vec::new(),
        notes: Vec::new(),
        free_text_notes: Vec::new(),
        text_boxes: Vec::new(),
        deletes: Vec::new(),
        page_rotations: Vec::new(),
        page_labels: None,
        bookmarks: None,
        shapes: Some(ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes,
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        }),
        markup: None,
        placed_images: Vec::new(),
        placed_image_geometry_updates: Vec::new(),
        continuation: None,
    }
}

#[test]
fn keeps_the_source_rect_of_an_untouched_off_page_square() {
    let (mut document, _page_id) = embedded_shape_pdf(&[
        ("evb-shape:off-page", off_page_square_dict()),
        ("evb-shape:on-page", on_page_square_dict()),
    ]);
    let pdf_path = seed_shape_pdf(&mut document, "shape-off-page-preserve");

    let mut edited = imported_on_page_square("evb-shape:on-page");
    edited.x = 0.2;
    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &shapes_mutation(vec![imported_off_page_square("evb-shape:off-page"), edited]),
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    assert_eq!(
        shape_rect_values(&loaded, "evb-shape:off-page"),
        vec![-20.0, 40.0, 60.0, 120.0]
    );
    let edited_rect = shape_rect_values(&loaded, "evb-shape:on-page");
    assert_approximately(edited_rect[0], 40.0);
    assert_approximately(edited_rect[2], 120.0);

    let _ = remove_file(pdf_path);
}

#[test]
fn rewrites_the_rect_of_an_edited_off_page_square() {
    let (mut document, _page_id) =
        embedded_shape_pdf(&[("evb-shape:off-page", off_page_square_dict())]);
    let pdf_path = seed_shape_pdf(&mut document, "shape-off-page-edited");

    let mut moved = imported_off_page_square("evb-shape:off-page");
    moved.x = 0.15;
    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &shapes_mutation(vec![moved]),
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let rect = shape_rect_values(&loaded, "evb-shape:off-page");
    assert_approximately(rect[0], 30.0);
    assert_approximately(rect[2], 110.0);

    let _ = remove_file(pdf_path);
}

#[test]
fn drops_a_stale_line_interior_color_and_keeps_a_polygon_fill() {
    let line_dict = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Line",
        "Rect" => vec![20.into(), 20.into(), 100.into(), 60.into()],
        "L" => vec![20.into(), 20.into(), 100.into(), 60.into()],
        "C" => vec![0.into(), 0.into(), 0.into()],
        // A Line has no interior; the value is stale metadata.
        "IC" => vec![1.into(), 0.into(), 0.into()],
    };
    let polygon_dict = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Polygon",
        "Rect" => vec![20.into(), 20.into(), 100.into(), 60.into()],
        "Vertices" => vec![20.into(), 20.into(), 100.into(), 60.into(), 60.into(), 80.into()],
        "C" => vec![0.into(), 0.into(), 0.into()],
        "IC" => vec![0.into(), 0.into(), 1.into()],
    };
    let (mut document, _page_id) = embedded_shape_pdf(&[
        ("evb-shape:line", line_dict),
        ("evb-shape:polygon", polygon_dict),
    ]);
    let pdf_path = seed_shape_pdf(&mut document, "shape-line-interior-color");

    let mut line = rectangle_shape("evb-shape:line", "#000000");
    line.shape_type = "line".to_string();
    line.fill_color = None;
    line.x = 0.1;
    line.y = 0.4;
    line.x2 = Some(0.5);
    line.y2 = Some(0.8);
    let mut polygon = rectangle_shape("evb-shape:polygon", "#000000");
    polygon.shape_type = "polygon".to_string();
    polygon.fill_color = Some("#0000ff".to_string());
    polygon.points = vec![
        ShapePoint { x: 0.1, y: 0.8 },
        ShapePoint { x: 0.5, y: 0.4 },
        ShapePoint { x: 0.3, y: 0.2 },
    ];

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &shapes_mutation(vec![line, polygon]),
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    assert!(shape_dict(&loaded, "evb-shape:line").get(b"IC").is_err());
    let polygon_interior = shape_dict(&loaded, "evb-shape:polygon")
        .get(b"IC")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_float().unwrap() as f64)
        .collect::<Vec<_>>();
    assert_approximately(polygon_interior[0], 0.0);
    assert_approximately(polygon_interior[1], 0.0);
    assert_approximately(polygon_interior[2], 1.0);

    let _ = remove_file(pdf_path);
}

fn shape_with_stale_appearance(subtype: &str) -> Dictionary {
    let mut appearance_stream = Dictionary::new();
    appearance_stream.set("Type", Object::Name(b"XObject".to_vec()));
    appearance_stream.set("Subtype", Object::Name(b"Form".to_vec()));
    appearance_stream.set(
        "BBox",
        Object::Array(vec![0.into(), 0.into(), 200.into(), 100.into()]),
    );

    let mut dict = dictionary! {
        "Type" => "Annot",
        "Subtype" => subtype,
        "Rect" => vec![20.into(), 20.into(), 100.into(), 60.into()],
        "C" => vec![1.into(), 0.into(), 0.into()],
        "CA" => 1,
        "Border" => vec![0.into(), 0.into(), 2.into()],
        "AP" => Object::Dictionary(dictionary! {
            "N" => Object::Stream(Stream::new(
                appearance_stream,
                b"1 0 0 RG\nOLD_AP\n".to_vec(),
            )),
        }),
    };
    match subtype {
        "Line" => {
            dict.set("L", vec![20.into(), 20.into(), 100.into(), 60.into()]);
            dict.set("Rect", vec![18.into(), 18.into(), 102.into(), 62.into()]);
            // A Line has no interior. Some producers still leave /IC behind.
            dict.set("IC", vec![0.into(), 1.into(), 0.into()]);
        }
        "PolyLine" => {
            dict.set(
                "Vertices",
                vec![
                    20.into(),
                    20.into(),
                    100.into(),
                    60.into(),
                    60.into(),
                    80.into(),
                ],
            );
        }
        "Polygon" => {
            dict.set(
                "Vertices",
                vec![
                    20.into(),
                    20.into(),
                    100.into(),
                    60.into(),
                    60.into(),
                    80.into(),
                ],
            );
            dict.set("IC", vec![1.into(), 0.into(), 0.into()]);
        }
        _ => {}
    }
    dict
}

fn embedded_shape_pdf_with_indirect_appearances(
    annotations: &[(&str, Dictionary)],
) -> (Document, ObjectId) {
    let (mut document, page_id) = create_test_document();
    let annots = annotations
        .iter()
        .map(|(stable_key, source_dict)| {
            let mut dict = source_dict.clone();
            let appearance = dict.remove(b"AP").expect("stale appearance fixture");
            let appearance_ref = document.add_object(appearance);
            dict.set(
                "AP",
                Object::Dictionary(dictionary! {
                    "N" => Object::Reference(appearance_ref),
                }),
            );
            let object_id = document.add_object(Object::Dictionary(dict));
            write_managed_shape_stable_key(
                document.get_dictionary_mut(object_id).unwrap(),
                Some(stable_key),
            );
            Object::Reference(object_id)
        })
        .collect::<Vec<_>>();
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", annots);
    (document, page_id)
}

#[test]
fn removes_stale_appearances_when_updating_imported_shapes() {
    let shape_specs = [
        ("evb-shape:stale-square", "Square", "rectangle"),
        ("evb-shape:stale-circle", "Circle", "circle"),
        ("evb-shape:stale-line", "Line", "line"),
        ("evb-shape:stale-polyline", "PolyLine", "polyline"),
        ("evb-shape:stale-polygon", "Polygon", "polygon"),
    ];
    let annotations = shape_specs
        .iter()
        .map(|(stable_key, subtype, _)| (*stable_key, shape_with_stale_appearance(subtype)))
        .collect::<Vec<_>>();
    let (mut document, _page_id) = embedded_shape_pdf_with_indirect_appearances(&annotations);
    let pdf_path = seed_shape_pdf(&mut document, "shape-stale-appearance-update");

    let shapes = shape_specs
        .iter()
        .enumerate()
        .map(|(index, (stable_key, _, shape_type))| {
            let mut shape = rectangle_shape(stable_key, "#112233");
            shape.shape_type = (*shape_type).to_string();
            shape.x = 0.1 + (index as f64 * 0.05);
            shape.y = 0.15 + (index as f64 * 0.05);
            match *shape_type {
                "line" => {
                    shape.fill_color = None;
                    shape.x2 = Some(shape.x + 0.3);
                    shape.y2 = Some(shape.y + 0.25);
                }
                "polyline" | "polygon" => {
                    shape.points = vec![
                        ShapePoint {
                            x: shape.x,
                            y: shape.y,
                        },
                        ShapePoint {
                            x: shape.x + 0.25,
                            y: shape.y + 0.1,
                        },
                        ShapePoint {
                            x: shape.x + 0.1,
                            y: shape.y + 0.3,
                        },
                    ];
                    if *shape_type == "polyline" {
                        shape.fill_color = None;
                    }
                }
                _ => {}
            }
            shape
        })
        .collect::<Vec<_>>();

    for (stable_key, _, _) in shape_specs {
        assert!(shape_dict(&document, stable_key).get(b"AP").is_ok());
    }

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &shapes_mutation(shapes),
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    for (stable_key, _, _) in shape_specs {
        assert!(
            shape_dict(&loaded, stable_key).get(b"AP").is_err(),
            "updated shape {stable_key} still has a stale appearance"
        );
    }

    let _ = remove_file(pdf_path);
}

fn regression_appearance(document: &mut Document, dict: &mut Dictionary) -> (ObjectId, ObjectId) {
    let resources = document.add_object(dictionary! {
        "ExtGState" => dictionary! {"GS0" => dictionary! {"Type" => "ExtGState", "CA" => 1, "ca" => 1}},
    });
    let appearance = document.add_object(Stream::new(dictionary! {
        "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        "Resources" => resources,
    }, b"q /GS0 gs 1 0 0 RG 0 1 0 rg 20 20 80 40 re B Q\n".to_vec()));
    dict.set("AP", dictionary! {"N" => appearance});
    (appearance, resources)
}

fn assert_regression_appearance(source: &Document, saved: &Document, refs: (ObjectId, ObjectId)) {
    for id in [refs.0, refs.1] {
        assert_eq!(
            saved.get_object(id).unwrap(),
            source.get_object(id).unwrap(),
            "appearance graph {id:?}"
        );
    }
}

#[test]
fn preserves_an_untouched_imported_appearance_when_a_sibling_shape_changes() {
    let (mut document, page_id) = create_test_document();
    let mut foreign = shape_with_stale_appearance("Square");
    foreign.set("NM", Object::string_literal("foreign-dashed"));
    foreign.set("P", page_id);
    foreign.set(
        "BS",
        dictionary! {"W" => 2, "S" => "D", "D" => vec![3.into(), 2.into()]},
    );
    foreign.set("Contents", Object::string_literal("Foreign discussion"));
    let appearances = regression_appearance(&mut document, &mut foreign);
    let foreign_id = document.add_object(foreign);
    let (popup, reply) = add_shape_discussion(&mut document, page_id, foreign_id);
    let mut editable = shape_with_stale_appearance("Square");
    editable.remove(b"AP");
    editable.set("NM", Object::string_literal("evb-shape:editable"));
    editable.set("P", page_id);
    let editable_id = document.add_object(editable);
    let (editable_popup, editable_reply) =
        add_shape_discussion(&mut document, page_id, editable_id);
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        vec![
            foreign_id.into(),
            popup.into(),
            reply.into(),
            editable_id.into(),
            editable_popup.into(),
            editable_reply.into(),
        ],
    );
    let parsed = collect_parsed_annotations(&document, "D:20261104000000Z").unwrap();
    assert!(parsed.iter().any(|entry| matches!(entry, PdfAnnotationParseEntry::Foreign(value) if value.object_number == u64::from(foreign_id.0))), "real parser must reject the dashed Square as foreign");
    let mut changed = imported_on_page_square("evb-shape:editable");
    changed.annotation_id = Some(format!("{} 0 R", editable_id.0));
    changed.color = "#112233".to_string();
    for route in ["full", "path", "bytes"] {
        for rewrite in [false, true] {
            let mut mutation = shapes_mutation(vec![changed.clone()]);
            mutation.shapes.as_mut().unwrap().rewrite_shape_state = rewrite;
            let saved =
                saved_annotation_regression(&document, &mutation, route, "D:20261104000100Z");
            assert_eq!(
                get_page_annots(&saved, page_id).unwrap(),
                get_page_annots(&document, page_id).unwrap(),
                "{route}, rewrite={rewrite}: the foreign thread remains listed on the page"
            );
            for id in [foreign_id, popup, reply] {
                assert_eq!(
                    saved.get_dictionary(id).unwrap(),
                    document.get_dictionary(id).unwrap(),
                    "{route}, rewrite={rewrite}: foreign thread {id:?}"
                );
            }
            assert_regression_appearance(&document, &saved, appearances);
            assert_ne!(
                saved
                    .get_dictionary(editable_id)
                    .unwrap()
                    .get(b"C")
                    .unwrap(),
                document
                    .get_dictionary(editable_id)
                    .unwrap()
                    .get(b"C")
                    .unwrap()
            );
        }
        for by_key in [false, true] {
            let mut deletion = shapes_mutation(Vec::new());
            let shapes = deletion.shapes.as_mut().unwrap();
            shapes.rewrite_shape_state = false;
            if by_key {
                shapes
                    .deleted_stable_keys
                    .push("evb-shape:editable".to_string());
            } else {
                shapes
                    .deleted_annotation_ids
                    .push(format!("{} 0 R", editable_id.0));
            }
            let saved =
                saved_annotation_regression(&document, &deletion, route, "D:20261104000100Z");
            let annots = get_page_annots(&saved, page_id).unwrap();
            assert_eq!(
                annots,
                vec![foreign_id.into(), popup.into(), reply.into()],
                "{route}: only the explicitly selected editable thread is deleted"
            );
            assert_regression_appearance(&document, &saved, appearances);
        }
    }
}

#[test]
fn preserves_restricted_and_two_color_shapes_when_a_sibling_changes() {
    let (mut document, page_id) = create_test_document();
    let mut locked = shape_with_stale_appearance("Square");
    locked.set("F", 132);
    let locked_appearances = regression_appearance(&mut document, &mut locked);
    let locked_id = document.add_object(locked);
    let mut arrow = shape_with_stale_appearance("Line");
    arrow.set("C", vec![1.into(), 0.into(), 0.into()]);
    arrow.set("IC", vec![0.into(), 0.into(), 1.into()]);
    arrow.set("LE", vec![Object::Name(b"None".to_vec()), Object::Name(b"ClosedArrow".to_vec())]);
    let appearances = regression_appearance(&mut document, &mut arrow);
    let arrow_id = document.add_object(arrow);
    let mut editable = shape_with_stale_appearance("Square");
    editable.remove(b"AP");
    editable.set("NM", Object::string_literal("evb-shape:changed-square"));
    let editable_id = document.add_object(editable);
    document.get_dictionary_mut(page_id).unwrap().set("Annots", vec![locked_id.into(), arrow_id.into(), editable_id.into()]);
    let parsed = collect_parsed_annotations(&document, "").unwrap();
    for id in [locked_id, arrow_id] {
        assert!(parsed.iter().any(|entry| matches!(entry, PdfAnnotationParseEntry::Foreign(value) if value.object_number == u64::from(id.0))));
    }
    let mut changed = imported_on_page_square("evb-shape:changed-square");
    changed.annotation_id = Some(format!("{} 0 R", editable_id.0));
    changed.color = "#112233".to_string();
    for route in ["full", "path", "bytes"] {
        for rewrite in [false, true] {
            let mut mutation = shapes_mutation(vec![changed.clone()]);
            mutation.shapes.as_mut().unwrap().rewrite_shape_state = rewrite;
            let saved = saved_annotation_regression(&document, &mutation, route, "D:20261104000100Z");
            assert_eq!(get_page_annots(&saved, page_id).unwrap(), get_page_annots(&document, page_id).unwrap(), "{route}, rewrite={rewrite}");
            for id in [locked_id, arrow_id] {
                assert_eq!(saved.get_dictionary(id).unwrap(), document.get_dictionary(id).unwrap(), "{route}, rewrite={rewrite}");
            }
            assert_regression_appearance(&document, &saved, appearances);
            assert_regression_appearance(&document, &saved, locked_appearances);
        }
    }
}

#[test]
fn preserves_an_untouched_line_appearance_when_a_sibling_shape_changes() {
    let (mut document, page_id) = create_test_document();
    let mut arrow = shape_with_stale_appearance("Line");
    arrow.set("NM", Object::string_literal("evb-shape:untouched-arrow"));
    arrow.set(
        "LE",
        vec![
            Object::Name(b"None".to_vec()),
            Object::Name(b"ClosedArrow".to_vec()),
        ],
    );
    arrow.set("CreationDate", Object::string_literal("D:20260101000000Z"));
    arrow.set("M", Object::string_literal("D:20260102000000Z"));
    arrow.set("P", page_id);
    let appearances = regression_appearance(&mut document, &mut arrow);
    let arrow_id = document.add_object(arrow);
    let mut editable = shape_with_stale_appearance("Square");
    editable.remove(b"AP");
    editable.set("NM", Object::string_literal("evb-shape:changed-square"));
    editable.set("P", page_id);
    let editable_id = document.add_object(editable);
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![arrow_id.into(), editable_id.into()]);
    let mut changed = imported_on_page_square("evb-shape:changed-square");
    changed.annotation_id = Some(format!("{} 0 R", editable_id.0));
    changed.color = "#112233".to_string();
    let mut mutation = shapes_mutation(vec![changed]);
    mutation.shapes.as_mut().unwrap().rewrite_shape_state = false;
    for route in ["full", "path", "bytes"] {
        let saved = saved_annotation_regression(&document, &mutation, route, "D:20261104000100Z");
        assert_eq!(
            get_page_annots(&saved, page_id).unwrap(),
            get_page_annots(&document, page_id).unwrap(),
            "{route}: untouched arrow remains listed beside its edited sibling"
        );
        assert_eq!(
            saved.get_dictionary(arrow_id).unwrap(),
            document.get_dictionary(arrow_id).unwrap(),
            "{route}: raw IC, L, Rect, dates and AP"
        );
        assert_regression_appearance(&document, &saved, appearances);
        assert_ne!(
            saved
                .get_dictionary(editable_id)
                .unwrap()
                .get(b"C")
                .unwrap(),
            document
                .get_dictionary(editable_id)
                .unwrap()
                .get(b"C")
                .unwrap()
        );
    }
}

#[test]
fn removes_stale_appearance_on_the_full_rewrite_shape_route() {
    let (mut document, _page_id) = embedded_shape_pdf_with_indirect_appearances(&[(
        "evb-shape:stale-full-rewrite-square",
        shape_with_stale_appearance("Square"),
    )]);
    let mut shape = rectangle_shape("evb-shape:stale-full-rewrite-square", "#112233");
    shape.x = 0.25;
    shape.y = 0.3;

    apply_shape_annotations(
        &mut document,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![shape],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        },
        "D:20260609123456+03'00'",
    &mut None,
)
    .unwrap();

    assert!(shape_dict(&document, "evb-shape:stale-full-rewrite-square")
        .get(b"AP")
        .is_err());
}

#[test]
fn keeps_the_source_rect_on_the_full_rewrite_shape_route() {
    let (mut document, _page_id) = embedded_shape_pdf(&[
        ("evb-shape:off-page", off_page_square_dict()),
        ("evb-shape:on-page", on_page_square_dict()),
    ]);

    let mut edited = imported_on_page_square("evb-shape:on-page");
    edited.y = 0.5;
    apply_shape_annotations(
        &mut document,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![imported_off_page_square("evb-shape:off-page"), edited],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        },
        "D:20260609123456+03'00'",
    &mut None,
)
    .unwrap();

    assert_eq!(
        shape_rect_values(&document, "evb-shape:off-page"),
        vec![-20.0, 40.0, 60.0, 120.0]
    );
    let edited_rect = shape_rect_values(&document, "evb-shape:on-page");
    assert_approximately(edited_rect[1], 10.0);
    assert_approximately(edited_rect[3], 50.0);
}

fn off_page_circle_dict() -> Dictionary {
    dictionary! {
        "Type" => "Annot",
        "Subtype" => "Circle",
        // Crosses the left and top page edges of the 200x100 test page.
        "Rect" => vec![(-20).into(), 40.into(), 60.into(), 120.into()],
        "C" => vec![0.into(), 0.into(), 0.into()],
    }
}

/// Square and Circle share one branch of the shape writer, so an assertion
/// that only covers Square proves nothing about the ellipse subtype.
#[test]
fn keeps_the_source_rect_of_an_untouched_off_page_circle() {
    let (mut document, _page_id) =
        embedded_shape_pdf(&[("evb-shape:off-page-circle", off_page_circle_dict())]);
    let pdf_path = seed_shape_pdf(&mut document, "shape-off-page-circle-preserve");

    let mut circle = imported_off_page_square("evb-shape:off-page-circle");
    circle.shape_type = "circle".to_string();
    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &shapes_mutation(vec![circle]),
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    assert_eq!(
        shape_rect_values(&loaded, "evb-shape:off-page-circle"),
        vec![-20.0, 40.0, 60.0, 120.0]
    );

    let _ = remove_file(pdf_path);
}

#[test]
fn rewrites_the_rect_of_an_edited_off_page_circle() {
    let (mut document, _page_id) =
        embedded_shape_pdf(&[("evb-shape:off-page-circle", off_page_circle_dict())]);
    let pdf_path = seed_shape_pdf(&mut document, "shape-off-page-circle-edited");

    let mut circle = imported_off_page_square("evb-shape:off-page-circle");
    circle.shape_type = "circle".to_string();
    circle.x = 0.15;
    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &shapes_mutation(vec![circle]),
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let rect = shape_rect_values(&loaded, "evb-shape:off-page-circle");
    assert_approximately(rect[0], 30.0);
    assert_approximately(rect[2], 110.0);

    let _ = remove_file(pdf_path);
}

#[test]
fn keeps_the_source_rect_of_an_untouched_off_page_circle_on_the_full_rewrite_route() {
    let (mut document, _page_id) =
        embedded_shape_pdf(&[("evb-shape:off-page-circle", off_page_circle_dict())]);

    let mut circle = imported_off_page_square("evb-shape:off-page-circle");
    circle.shape_type = "circle".to_string();
    apply_shape_annotations(
        &mut document,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![circle],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        },
        "D:20260609123456+03'00'",
    &mut None,
)
    .unwrap();

    assert_eq!(
        shape_rect_values(&document, "evb-shape:off-page-circle"),
        vec![-20.0, 40.0, 60.0, 120.0]
    );
}

/// `/Rect` may be an indirect array. Reading it off the dictionary alone
/// sees a reference, reports "no rect", and rewrites geometry nobody edited.
fn embedded_shape_pdf_with_indirect_rect(
    stable_key: &str,
    subtype: &str,
    rect: Vec<Object>,
) -> (Document, ObjectId) {
    let (mut document, page_id) = create_test_document();
    let rect_id = document.add_object(Object::Array(rect));
    let object_id = document.add_object(Object::Dictionary(dictionary! {
        "Type" => "Annot",
        "Subtype" => subtype,
        "Rect" => Object::Reference(rect_id),
        "C" => vec![0.into(), 0.into(), 0.into()],
    }));
    write_managed_shape_stable_key(
        document.get_dictionary_mut(object_id).unwrap(),
        Some(stable_key),
    );
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(object_id)]);
    (document, object_id)
}

fn resolved_shape_rect_values(document: &Document, object_id: ObjectId) -> Vec<f64> {
    let dict = document.get_dictionary(object_id).unwrap();
    let rect = document.resolved(dict.get(b"Rect").unwrap()).unwrap();
    rect.as_array()
        .unwrap()
        .iter()
        .map(|value| {
            document
                .resolved(value)
                .unwrap()
                .as_float()
                .unwrap_or_else(|_| value.as_i64().unwrap() as f32) as f64
        })
        .collect()
}

#[test]
fn keeps_an_indirect_source_rect_of_an_untouched_off_page_square() {
    let (mut document, object_id) = embedded_shape_pdf_with_indirect_rect(
        "evb-shape:indirect",
        "Square",
        vec![(-20).into(), 40.into(), 60.into(), 120.into()],
    );
    let pdf_path = seed_shape_pdf(&mut document, "shape-indirect-rect-preserve");

    append_native_mutations(
        &pdf_path,
        &pdf_path,
        &shapes_mutation(vec![imported_off_page_square("evb-shape:indirect")]),
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    assert_eq!(
        resolved_shape_rect_values(&loaded, object_id),
        vec![-20.0, 40.0, 60.0, 120.0]
    );

    let _ = remove_file(pdf_path);
}

#[test]
fn keeps_an_indirect_source_rect_on_the_full_rewrite_shape_route() {
    let (mut document, object_id) = embedded_shape_pdf_with_indirect_rect(
        "evb-shape:indirect",
        "Circle",
        vec![(-20).into(), 40.into(), 60.into(), 120.into()],
    );

    apply_shape_annotations(
        &mut document,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![imported_off_page_square("evb-shape:indirect")],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        },
        "D:20260609123456+03'00'",
    &mut None,
)
    .unwrap();

    assert_eq!(
        resolved_shape_rect_values(&document, object_id),
        vec![-20.0, 40.0, 60.0, 120.0]
    );
}

#[test]
fn rewrites_an_indirect_source_rect_when_the_shape_moved() {
    let (mut document, object_id) = embedded_shape_pdf_with_indirect_rect(
        "evb-shape:indirect",
        "Square",
        vec![(-20).into(), 40.into(), 60.into(), 120.into()],
    );

    let mut moved = imported_off_page_square("evb-shape:indirect");
    moved.x = 0.15;
    apply_shape_annotations(
        &mut document,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![moved],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        },
        "D:20260609123456+03'00'",
    &mut None,
)
    .unwrap();

    let rect = resolved_shape_rect_values(&document, object_id);
    assert_approximately(rect[0], 30.0);
    assert_approximately(rect[2], 110.0);
}

#[test]
fn print_layout_draws_each_evb_shape_saved_without_appearance() {
    let rect = || vec![20.into(), 20.into(), 100.into(), 80.into()];
    let line_endings = |start: &[u8], end: &[u8]| {
        Object::Array(vec![
            Object::Name(start.to_vec()),
            Object::Name(end.to_vec()),
        ])
    };
    let shapes = [
        ("Square", dictionary! {
            "Subtype" => "Square", "Rect" => rect(), "C" => vec![1.into(), 0.into(), 0.into()],
            "Border" => vec![0.into(), 0.into(), 2.into()],
        }, b"re".as_slice()),
        ("Circle", dictionary! {
            "Subtype" => "Circle", "Rect" => rect(), "C" => vec![0.into(), 0.into(), 1.into()],
            "IC" => vec![1.into(), 1.into(), 0.into()],
        }, b" c\n".as_slice()),
        ("Line", dictionary! {
            "Subtype" => "Line", "Rect" => rect(), "L" => vec![20.into(), 20.into(), 100.into(), 80.into()],
            "C" => vec![0.into(), 0.into(), 0.into()], "LE" => line_endings(b"None", b"OpenArrow"),
        }, b" l\nS\n".as_slice()),
        ("PolyLine", dictionary! {
            "Subtype" => "PolyLine", "Rect" => rect(),
            "Vertices" => vec![20.into(), 20.into(), 60.into(), 80.into(), 100.into(), 20.into()],
            "C" => vec![0.into(), 0.into(), 0.into()],
        }, b" l\nS\n".as_slice()),
        ("Polygon", dictionary! {
            "Subtype" => "Polygon", "Rect" => rect(),
            "Vertices" => vec![20.into(), 20.into(), 60.into(), 80.into(), 100.into(), 20.into()],
            "C" => vec![0.into(), 0.into(), 0.into()], "IC" => vec![0.into(), 1.into(), 0.into()],
        }, b"h\nb\n".as_slice()),
    ];
    for (label, mut annotation, expected_operator) in shapes {
        let (mut document, page_id) = create_test_document();
        annotation.set("F", 4);
        let annot_id = document.add_object(annotation);
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(annot_id)]);

        build_print_layout(&mut document, None, PrintViewMode::Single, PrintOrientation::Auto)
            .unwrap_or_else(|error| panic!("{label} saved without appearance failed to print: {error}"));
        let appearance = print_annotation_appearance(&document)
            .unwrap_or_else(|| panic!("{label} was not drawn"));
        assert!(
            appearance.windows(expected_operator.len()).any(|window| window == expected_operator),
            "{label} appearance lacks {:?}: {}",
            String::from_utf8_lossy(expected_operator),
            String::from_utf8_lossy(&appearance)
        );
    }
}

#[test]
fn print_layout_skips_a_shape_without_the_print_flag() {
    let (mut document, page_id) = create_test_document();
    let annot_id = document.add_object(dictionary! {
        "Subtype" => "Square",
        "Rect" => vec![20.into(), 20.into(), 100.into(), 80.into()],
        "F" => 0,
    });
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(annot_id)]);

    build_print_layout(&mut document, None, PrintViewMode::Single, PrintOrientation::Auto).unwrap();
    assert!(print_annotation_appearance(&document).is_none());
}

#[test]
fn print_layout_draws_an_evb_shape_saved_before_the_print_flag_but_not_a_foreign_one() {
    let square = || {
        dictionary! {
            "Subtype" => "Square", "Rect" => vec![20.into(), 20.into(), 100.into(), 80.into()],
            "C" => vec![1.into(), 0.into(), 0.into()], "Border" => vec![0.into(), 0.into(), 2.into()],
        }
    };

    let (mut evb_document, _) = embedded_shape_pdf(&[("evb-shape:legacy-square", square())]);
    build_print_layout(&mut evb_document, None, PrintViewMode::Single, PrintOrientation::Auto)
        .unwrap();
    assert!(
        print_annotation_appearance(&evb_document).is_some(),
        "EVB-owned Square without /F was not printed"
    );

    let (mut foreign_document, foreign_page_id) = create_test_document();
    let annot_id = foreign_document.add_object(square());
    foreign_document
        .get_dictionary_mut(foreign_page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(annot_id)]);
    build_print_layout(&mut foreign_document, None, PrintViewMode::Single, PrintOrientation::Auto)
        .unwrap();
    assert!(print_annotation_appearance(&foreign_document).is_none());
}

fn ordinary_shape(shape_type: &str, stable_key: &str) -> ShapeAnnotation {
    let mut shape = rectangle_shape(stable_key, "#336699");
    shape.shape_type = shape_type.to_string();
    shape.x2 = Some(0.7);
    shape.y2 = Some(0.6);
    shape.points = vec![
        ShapePoint { x: 0.1, y: 0.2 },
        ShapePoint { x: 0.4, y: 0.6 },
        ShapePoint { x: 0.8, y: 0.3 },
    ];
    shape
}

fn assert_every_page_annotation_prints(document: &Document, page_id: ObjectId, expected: usize) {
    let annots = get_page_annots(document, page_id).unwrap();
    assert_eq!(annots.len(), expected);
    for annot in annots {
        let dict = document.get_dictionary(annot.as_reference().unwrap()).unwrap();
        let flags = dict.get(b"F").ok().and_then(|value| value.as_i64().ok()).unwrap_or(0);
        assert_eq!(flags & 4, 4, "{} saved without the Print flag: {dict:?}", annotation_subtype(dict));
    }
}

#[test]
fn saves_every_ordinary_shape_with_the_print_flag_on_both_routes() {
    let shapes = vec![
        ordinary_shape("rectangle", "evb-shape:print-rectangle"),
        ordinary_shape("circle", "evb-shape:print-circle"),
        ordinary_shape("line", "evb-shape:print-line"),
        ordinary_shape("polyline", "evb-shape:print-polyline"),
        ordinary_shape("polygon", "evb-shape:print-polygon"),
    ];

    let (mut document, page_id) = create_test_document();
    apply_shape_annotations(
        &mut document,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: shapes.clone(),
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        },
        "D:20260609123456+03'00'",
        &mut None,
    )
    .unwrap();
    assert_every_page_annotation_prints(&document, page_id, shapes.len());

    let (mut seed, _page_id) = create_test_document();
    let input_path = seed_shape_pdf(&mut seed, "print-flag-incremental");
    let output_path = temp_pdf_path("print-flag-incremental-output");
    write(&output_path, read(&input_path).unwrap()).unwrap();
    append_native_mutations(
        &input_path,
        &output_path,
        &shapes_mutation(shapes.clone()),
        "D:20260609123456+03'00'",
    )
    .unwrap();
    let loaded = Document::load(&output_path).unwrap();
    assert_every_page_annotation_prints(&loaded, page_id, shapes.len());
}

#[test]
fn an_edited_evb_shape_saved_without_the_print_flag_prints_after_the_edit() {
    let legacy_square = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Square",
        "Rect" => vec![20.into(), 20.into(), 100.into(), 60.into()],
        "C" => vec![1.into(), 0.into(), 0.into()],
        "Border" => vec![0.into(), 0.into(), 2.into()],
    };
    let (mut document, page_id) =
        embedded_shape_pdf(&[("evb-shape:legacy-square", legacy_square)]);
    assert!(get_page_annots(&document, page_id).unwrap().len() == 1);

    let mut shape = rectangle_shape("evb-shape:legacy-square", "#112233");
    shape.x = 0.25;
    apply_shape_annotations(
        &mut document,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![shape],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        },
        "D:20260609123456+03'00'",
        &mut None,
    )
    .unwrap();
    assert_every_page_annotation_prints(&document, page_id, 1);
}

fn embedded_shape_pdf_with_indirect_flags(stable_key: &str) -> (Document, ObjectId) {
    let (mut document, page_id) = create_test_document();
    let flags_id = document.add_object(Object::Integer(34));
    let object_id = document.add_object(Object::Dictionary(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Square",
        "Rect" => vec![20.into(), 20.into(), 100.into(), 60.into()],
        "C" => vec![1.into(), 0.into(), 0.into()],
        "Border" => vec![0.into(), 0.into(), 2.into()],
        "F" => Object::Reference(flags_id),
    }));
    write_managed_shape_stable_key(
        document.get_dictionary_mut(object_id).unwrap(),
        Some(stable_key),
    );
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(object_id)]);
    (document, page_id)
}

fn assert_only_annotation_flags(document: &Document, expected: i64) {
    let page_id = *document.get_pages().values().next().unwrap();
    let annots = get_page_annots(document, page_id).unwrap();
    assert_eq!(annots.len(), 1);
    let dict = document
        .get_dictionary(annots[0].as_reference().unwrap())
        .unwrap();
    let flags = document
        .dereference(dict.get(b"F").unwrap())
        .unwrap()
        .1
        .as_i64()
        .unwrap();
    assert_eq!(flags, expected, "annotation kept {flags}, expected {expected}");
}

#[test]
fn adding_print_keeps_indirect_hidden_and_noview_flags_on_both_save_routes() {
    let stable_key = "evb-shape:indirect-flags";
    let shape = rectangle_shape(stable_key, "#112233");

    let (mut document, _page_id) = embedded_shape_pdf_with_indirect_flags(stable_key);
    apply_shape_annotations(
        &mut document,
        &ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![shape.clone()],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        },
        "D:20260609123456+03'00'",
        &mut None,
    )
    .unwrap();
    assert_only_annotation_flags(&document, 38);

    let (mut seed, _page_id) = embedded_shape_pdf_with_indirect_flags(stable_key);
    let input_path = seed_shape_pdf(&mut seed, "indirect-flags-incremental");
    let output_path = temp_pdf_path("indirect-flags-incremental-output");
    write(&output_path, read(&input_path).unwrap()).unwrap();
    append_native_mutations(
        &input_path,
        &output_path,
        &shapes_mutation(vec![shape]),
        "D:20260609123456+03'00'",
    )
    .unwrap();
    assert_only_annotation_flags(&Document::load(&output_path).unwrap(), 38);
}
