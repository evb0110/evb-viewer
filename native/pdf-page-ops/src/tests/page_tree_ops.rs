#[test]
fn deleting_an_outlined_page_does_not_resurrect_it() {
    let mut source = Document::with_version("1.4");
    let pages_id = source.new_object_id();
    let page_ids = [200i64, 300, 400]
        .iter()
        .map(|width| {
            source.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), (*width).into(), 100.into()],
            })
        })
        .collect::<Vec<_>>();
    source.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => page_ids.len() as i64,
        },
    );
    let outline_item = source.add_object(dictionary! {
        "Title" => Object::string_literal("Deleted page"),
        "Dest" => vec![Object::Reference(page_ids[1]), Object::Name(b"Fit".to_vec())],
    });
    let outlines = source.add_object(dictionary! {
        "Type" => "Outlines",
        "First" => outline_item,
        "Last" => outline_item,
        "Count" => 1,
    });
    source
        .get_dictionary_mut(outline_item)
        .unwrap()
        .set("Parent", outlines);
    let catalog = source.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
        "Outlines" => outlines,
    });
    source.trailer.set("Root", catalog);
    let mut source_bytes = Vec::new();
    source.save_to(&mut source_bytes).unwrap();

    let result = delete_browser_pdf_pages(&source_bytes, &[2]).unwrap();
    let output = Document::load_mem(&result.data).unwrap();

    let page_object_count = output
        .objects
        .values()
        .filter(|object| {
            object
                .as_dict()
                .ok()
                .and_then(|dictionary| dictionary.get(b"Type").ok())
                .and_then(|value| value.as_name().ok())
                == Some(b"Page")
        })
        .count();
    assert_eq!(page_object_count, 2);
    assert_eq!(output.get_pages().len(), 2);
    let outlines_id = output
        .catalog()
        .unwrap()
        .get(b"Outlines")
        .unwrap()
        .as_reference()
        .unwrap();
    let first_id = output
        .get_dictionary(outlines_id)
        .unwrap()
        .get(b"First")
        .unwrap()
        .as_reference()
        .unwrap();
    let destination = output
        .get_dictionary(first_id)
        .unwrap()
        .get(b"Dest")
        .unwrap()
        .as_array()
        .unwrap()[0]
        .clone();
    assert_eq!(destination, Object::Null);
}

#[test]
fn page_subset_operations_preserve_and_remap_outlines_and_page_labels() {
    fn document_with_pages(widths: &[i64]) -> (Document, ObjectId, Vec<ObjectId>) {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let page_ids = widths
            .iter()
            .map(|width| {
                document.add_object(dictionary! {
                    "Type" => "Page",
                    "Parent" => pages_id,
                    "MediaBox" => vec![0.into(), 0.into(), (*width).into(), 100.into()],
                })
            })
            .collect::<Vec<_>>();
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
                "Count" => page_ids.len() as i64,
            },
        );
        (document, pages_id, page_ids)
    }

    let (mut source, pages_id, source_pages) = document_with_pages(&[200, 300, 400]);
    let page_label_nums = source.add_object(vec![
            Object::Integer(0),
            Object::Dictionary(dictionary! {"S" => "D", "St" => 1}),
            Object::Integer(1),
            Object::Dictionary(dictionary! {"S" => "R", "St" => 1}),
        ]);
    let page_label_leaf = source.add_object(dictionary! {
        "Limits" => vec![Object::Integer(0), Object::Integer(1)],
        "Nums" => page_label_nums,
    });
    let page_label_branch = source.add_object(dictionary! {
        "Limits" => vec![Object::Integer(0), Object::Integer(1)],
        "Kids" => vec![Object::Reference(page_label_leaf)],
    });
    let page_labels = source.add_object(dictionary! {
        "Kids" => vec![Object::Reference(page_label_branch)],
    });
    let outline_item = source.add_object(dictionary! {
        "Title" => Object::string_literal("Page three"),
        "Dest" => vec![Object::Reference(source_pages[2]), Object::Name(b"Fit".to_vec())],
    });
    let outlines = source.add_object(dictionary! {
        "Type" => "Outlines",
        "First" => outline_item,
        "Last" => outline_item,
        "Count" => 1,
    });
    source
        .get_dictionary_mut(outline_item)
        .unwrap()
        .set("Parent", outlines);
    let catalog = source.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
        "PageLabels" => page_labels,
        "Outlines" => outlines,
    });
    source.trailer.set("Root", catalog);

    let (mut insertion, insertion_pages_id, insertion_pages) = document_with_pages(&[500]);
    let insertion_catalog = insertion.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => insertion_pages_id,
    });
    insertion.trailer.set("Root", insertion_catalog);

    let mut source_bytes = Vec::new();
    source.save_to(&mut source_bytes).unwrap();
    let mut insertion_bytes = Vec::new();
    insertion.save_to(&mut insertion_bytes).unwrap();

    let cases = [
        (
            delete_browser_pdf_pages(&source_bytes, &[2]).unwrap(),
            2,
            400.0,
            vec!["1", "II"],
        ),
        (
            reorder_browser_pdf_pages(&source_bytes, &[3, 1, 2]).unwrap(),
            1,
            400.0,
            vec!["II", "1", "I"],
        ),
        (
            insert_browser_pdf_pages(&source_bytes, &insertion_bytes, 1).unwrap(),
            4,
            400.0,
            vec!["1", "2", "I", "II"],
        ),
    ];
    let _ = insertion_pages;

    for (result, expected_page_number, expected_width, expected_labels) in cases {
        let output = Document::load_mem(&result.data).unwrap();
        let catalog = output.catalog().unwrap();
        let page_labels = resolve_dictionary_object(
            &output,
            catalog.get(b"PageLabels").unwrap(),
            "PageLabels",
        )
        .unwrap();
        let page_label_values = page_labels
            .get(b"Nums")
            .unwrap()
            .as_array()
            .unwrap()
            .chunks_exact(2)
            .map(|pair| {
                resolve_dictionary_object(&output, &pair[1], "PageLabel")
                    .unwrap()
                    .get(b"P")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_vec()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            page_label_values,
            expected_labels
                .iter()
                .map(|label| label.as_bytes().to_vec())
                .collect::<Vec<_>>()
        );
        let outlines_id = catalog.get(b"Outlines").unwrap().as_reference().unwrap();
        let outlines = output.get_dictionary(outlines_id).unwrap();
        let first_id = outlines.get(b"First").unwrap().as_reference().unwrap();
        let destination = output
            .get_dictionary(first_id)
            .unwrap()
            .get(b"Dest")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .as_reference()
            .unwrap();
        assert_eq!(
            resolve_inherited_box(&output, destination, b"MediaBox")
                .unwrap()
                .width(),
            expected_width,
        );
        assert_eq!(output.get_pages().get(&expected_page_number), Some(&destination));
    }
}

#[test]
fn browser_page_label_rewrites_preserve_text_encoding_and_pdf_alphabetic_sequence() {
    let mut source = Document::with_version("1.4");
    let pages_id = source.new_object_id();
    let page_ids = (0..109)
        .map(|_| {
            source.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            })
        })
        .collect::<Vec<_>>();
    source.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => page_ids.len() as i64,
        },
    );
    let page_labels = source.add_object(dictionary! {
        "Nums" => vec![
            Object::Integer(0),
            dictionary! {
                "S" => "a",
                "P" => Object::String(vec![0x8b], StringFormat::Literal),
            }
            .into(),
            Object::Integer(54),
            dictionary! {
                "S" => "A",
                "P" => lopdf::text_string("№"),
            }
            .into(),
            Object::Integer(107),
            dictionary! {"P" => lopdf::text_string("front-")}.into(),
        ],
    });
    let catalog = source.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
        "PageLabels" => page_labels,
    });
    source.trailer.set("Root", catalog);

    let mut source_bytes = Vec::new();
    source.save_to(&mut source_bytes).unwrap();
    let selected_pages = [1, 26, 27, 28, 52, 53, 55, 80, 81, 82, 106, 107, 108];
    let result = extract_browser_pdf_pages(&source_bytes, &selected_pages).unwrap();
    let output = Document::load_mem(&result.data).unwrap();
    let page_labels = resolve_dictionary_object(
        &output,
        output.catalog().unwrap().get(b"PageLabels").unwrap(),
        "PageLabels",
    )
    .unwrap();
    let labels = page_labels
        .get(b"Nums")
        .unwrap()
        .as_array()
        .unwrap()
        .chunks_exact(2)
        .map(|pair| {
            let label = resolve_dictionary_object(&output, &pair[1], "PageLabel").unwrap();
            lopdf::decode_text_string(label.get(b"P").unwrap()).unwrap()
        })
        .collect::<Vec<_>>();

    assert_eq!(
        labels,
        [
            "‰a", "‰z", "‰aa", "‰bb", "‰zz", "‰aaa", "№A", "№Z", "№AA", "№BB", "№ZZ",
            "№AAA", "front-",
        ]
    );
}

#[test]
fn browser_page_label_rewrites_preserve_utf16_prefixes() {
    let mut source = Document::with_version("1.4");
    let pages_id = source.new_object_id();
    let page_ids = (0..3)
        .map(|_| {
            source.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            })
        })
        .collect::<Vec<_>>();
    source.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => page_ids.len() as i64,
        },
    );
    let page_labels = source.add_object(dictionary! {
        "Nums" => vec![
            Object::Integer(0),
            dictionary! {
                "S" => "D",
                "P" => Object::String(
                    vec![0xfe, 0xff, 0x04, 0x13],
                    StringFormat::Hexadecimal,
                ),
            }
            .into(),
            Object::Integer(1),
            dictionary! {
                "S" => "a",
                "P" => Object::String(vec![0x8b], StringFormat::Literal),
            }
            .into(),
        ],
    });
    let catalog = source.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
        "PageLabels" => page_labels,
    });
    source.trailer.set("Root", catalog);

    let mut source_bytes = Vec::new();
    source.save_to(&mut source_bytes).unwrap();
    let result = extract_browser_pdf_pages(&source_bytes, &[1, 2, 3]).unwrap();
    let output = Document::load_mem(&result.data).unwrap();
    let page_labels = resolve_dictionary_object(
        &output,
        output.catalog().unwrap().get(b"PageLabels").unwrap(),
        "PageLabels",
    )
    .unwrap();
    let labels = page_labels
        .get(b"Nums")
        .unwrap()
        .as_array()
        .unwrap()
        .chunks_exact(2)
        .map(|pair| {
            let label = resolve_dictionary_object(&output, &pair[1], "PageLabel").unwrap();
            lopdf::decode_text_string(label.get(b"P").unwrap()).unwrap()
        })
        .collect::<Vec<_>>();

    assert_eq!(labels, ["Г1", "‰a", "‰b"]);
}

#[test]
fn browser_page_label_rewrites_reject_malformed_prefixes() {
    let (mut source, _) = create_test_document();
    let page_labels = source.add_object(dictionary! {
        "Nums" => vec![
            Object::Integer(0),
            dictionary! {
                "S" => "D",
                "P" => Object::String(
                    vec![0xfe, 0xff, 0xd8, 0x00],
                    StringFormat::Hexadecimal,
                ),
            }
            .into(),
        ],
    });
    source
        .get_dictionary_mut(source.root_id().unwrap())
        .unwrap()
        .set("PageLabels", page_labels);
    let mut source_bytes = Vec::new();
    source.save_to(&mut source_bytes).unwrap();
    let original_bytes = source_bytes.clone();

    assert!(extract_browser_pdf_pages(&source_bytes, &[1]).is_err());
    assert_eq!(source_bytes, original_bytes);
}

#[test]
fn page_subset_operations_preserve_forward_page_owned_destinations() {
    fn destination(page_id: ObjectId) -> Object {
        vec![Object::Reference(page_id), Object::Name(b"Fit".to_vec())].into()
    }

    let mut source = Document::with_version("1.4");
    let pages_id = source.new_object_id();
    let page_ids = [200i64, 300, 400]
        .iter()
        .map(|width| {
            source.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), (*width).into(), 100.into()],
            })
        })
        .collect::<Vec<_>>();
    source.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => page_ids.len() as i64,
        },
    );
    let link = source.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Link",
        "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
        "Dest" => destination(page_ids[1]),
        "A" => dictionary! {"S" => "GoTo", "D" => destination(page_ids[1])},
    });
    source
        .get_dictionary_mut(page_ids[0])
        .unwrap()
        .set("Annots", vec![Object::Reference(link)]);
    let catalog = source.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    source.trailer.set("Root", catalog);
    let mut source_bytes = Vec::new();
    source.save_to(&mut source_bytes).unwrap();

    for result in [
        extract_browser_pdf_pages(&source_bytes, &[1, 2]).unwrap(),
        delete_browser_pdf_pages(&source_bytes, &[3]).unwrap(),
    ] {
        let output = Document::load_mem(&result.data).unwrap();
        assert_eq!(output.get_pages().len(), 2);
        let first_page = *output.get_pages().get(&1).unwrap();
        let second_page = *output.get_pages().get(&2).unwrap();
        let annots = output
            .get_dictionary(first_page)
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        let annotation = output
            .get_dictionary(annots[0].as_reference().unwrap())
            .unwrap();
        assert_eq!(
            annotation
                .get(b"Dest")
                .unwrap()
                .as_array()
                .unwrap()[0],
            Object::Reference(second_page)
        );
        assert_eq!(
            annotation
                .get(b"A")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"D")
                .unwrap()
                .as_array()
                .unwrap()[0],
            Object::Reference(second_page)
        );
    }
}

#[test]
fn page_subset_operations_detach_removed_and_reorder_retained_destinations() {
    fn destination(page_id: ObjectId) -> Object {
        vec![Object::Reference(page_id), Object::Name(b"Fit".to_vec())].into()
    }

    fn link(page_id: ObjectId) -> Object {
        dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Dest" => destination(page_id),
            "A" => dictionary! {"S" => "GoTo", "D" => destination(page_id)},
        }
        .into()
    }

    fn assert_link_target(document: &Document, page_id: ObjectId, target: Object) {
        let annotation_id = document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .as_reference()
            .unwrap();
        let annotation = document.get_dictionary(annotation_id).unwrap();
        assert_eq!(annotation.get(b"Dest").unwrap().as_array().unwrap()[0], target);
        assert_eq!(
            annotation
                .get(b"A")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"D")
                .unwrap()
                .as_array()
                .unwrap()[0],
            target
        );
    }

    let mut source = Document::with_version("1.4");
    let pages_id = source.new_object_id();
    let page_ids = [200i64, 300, 400]
        .iter()
        .map(|width| {
            source.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), (*width).into(), 100.into()],
            })
        })
        .collect::<Vec<_>>();
    source.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => page_ids.len() as i64,
        },
    );
    let first_link = source.add_object(link(page_ids[2]));
    let self_link = source.add_object(link(page_ids[1]));
    let third_link = source.add_object(link(page_ids[0]));
    source
        .get_dictionary_mut(page_ids[0])
        .unwrap()
        .set("Annots", vec![Object::Reference(first_link)]);
    source
        .get_dictionary_mut(page_ids[1])
        .unwrap()
        .set("Annots", vec![Object::Reference(self_link)]);
    source
        .get_dictionary_mut(page_ids[2])
        .unwrap()
        .set("Annots", vec![Object::Reference(third_link)]);
    let catalog = source.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    source.trailer.set("Root", catalog);
    let mut source_bytes = Vec::new();
    source.save_to(&mut source_bytes).unwrap();

    for result in [
        extract_browser_pdf_pages(&source_bytes, &[1, 2]).unwrap(),
        delete_browser_pdf_pages(&source_bytes, &[3]).unwrap(),
    ] {
        let output = Document::load_mem(&result.data).unwrap();
        let pages = output.get_pages();
        assert_eq!(result.page_count, 2);
        assert_link_target(
            &output,
            *pages.get(&1).unwrap(),
            Object::Null,
        );
        assert_link_target(
            &output,
            *pages.get(&2).unwrap(),
            Object::Reference(*pages.get(&2).unwrap()),
        );
        assert_eq!(
            output
                .objects
                .values()
                .filter(|object| {
                    object
                        .as_dict()
                        .ok()
                        .and_then(|dictionary| dictionary.get(b"Type").ok())
                        .and_then(|value| value.as_name().ok())
                        == Some(b"Page")
                })
                .count(),
            2
        );
    }

    let result = reorder_browser_pdf_pages(&source_bytes, &[3, 2, 1]).unwrap();
    let output = Document::load_mem(&result.data).unwrap();
    let pages = output.get_pages();
    assert_eq!(result.page_count, 3);
    assert_link_target(
        &output,
        *pages.get(&1).unwrap(),
        Object::Reference(*pages.get(&3).unwrap()),
    );
    assert_link_target(
        &output,
        *pages.get(&2).unwrap(),
        Object::Reference(*pages.get(&2).unwrap()),
    );
    assert_link_target(
        &output,
        *pages.get(&3).unwrap(),
        Object::Reference(*pages.get(&1).unwrap()),
    );
}

#[test]
fn browser_page_labels_accept_flat_indirect_nums() {
    let mut source = Document::with_version("1.4");
    let pages_id = source.new_object_id();
    let page_ids = (0..3)
        .map(|_| {
            source.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            })
        })
        .collect::<Vec<_>>();
    source.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => page_ids.len() as i64,
        },
    );
    let nums = source.add_object(vec![
        Object::Integer(0),
        dictionary! {"S" => "D", "P" => lopdf::text_string("front-")}.into(),
        Object::Integer(2),
        dictionary! {"S" => "R", "St" => 4}.into(),
    ]);
    let page_labels = source.add_object(dictionary! {"Nums" => nums});
    let catalog = source.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
        "PageLabels" => page_labels,
    });
    source.trailer.set("Root", catalog);

    let mut source_bytes = Vec::new();
    source.save_to(&mut source_bytes).unwrap();
    let result = delete_browser_pdf_pages(&source_bytes, &[2]).unwrap();
    let output = Document::load_mem(&result.data).unwrap();
    let page_labels = resolve_dictionary_object(
        &output,
        output.catalog().unwrap().get(b"PageLabels").unwrap(),
        "PageLabels",
    )
    .unwrap();
    let labels = page_labels
        .get(b"Nums")
        .unwrap()
        .as_array()
        .unwrap()
        .chunks_exact(2)
        .map(|pair| {
            let label = resolve_dictionary_object(&output, &pair[1], "PageLabel").unwrap();
            lopdf::decode_text_string(label.get(b"P").unwrap()).unwrap()
        })
        .collect::<Vec<_>>();

    assert_eq!(labels, ["front-1", "IV"]);
}

    #[test]
    fn reorders_pages_by_cloning_selected_page_tree() {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let first_page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 200.into()],
        });
        let second_page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 300.into(), 400.into()],
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![
                    Object::Reference(first_page_id),
                    Object::Reference(second_page_id),
                ],
                "Count" => 2,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let result = reorder_browser_pdf_pages(&bytes, &[2, 1]).unwrap();
        let reordered = Document::load_mem(&result.data).unwrap();
        let pages = reordered.get_pages();

        assert_eq!(result.page_count, 2);
        assert_eq!(
            resolve_inherited_box(&reordered, *pages.get(&1).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            300.0,
        );
        assert_eq!(
            resolve_inherited_box(&reordered, *pages.get(&2).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            100.0,
        );
    }

    #[test]
    fn rejects_delete_all_browser_pages() {
        let (mut document, _) = create_test_document();
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let error = match delete_browser_pdf_pages(&bytes, &[1]) {
            Ok(_) => panic!("delete-all should be rejected"),
            Err(error) => error.to_string(),
        };

        assert!(error.contains("cannot delete every page"));
    }

    #[test]
    fn reorder_preserves_catalog_and_info_metadata() {
        let (mut document, first_page_id) = create_test_document();
        let pages_id = document
            .catalog()
            .unwrap()
            .get(b"Pages")
            .unwrap()
            .as_reference()
            .unwrap();
        let second_page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 300.into(), 100.into()],
        });
        let pages = document.get_dictionary_mut(pages_id).unwrap();
        pages.set(
            "Kids",
            vec![
                Object::Reference(first_page_id),
                Object::Reference(second_page_id),
            ],
        );
        pages.set("Count", 2);

        let info_id = document.add_object(dictionary! {
            "Title" => Object::string_literal("Preserved title"),
            "Author" => Object::string_literal("EVB"),
        });
        document.trailer.set("Info", info_id);
        let catalog_id = document.root_id().unwrap();
        let catalog = document.get_dictionary_mut(catalog_id).unwrap();
        catalog.set("PageMode", Object::Name(b"UseOutlines".to_vec()));
        catalog.set("PageLayout", Object::Name(b"TwoColumnLeft".to_vec()));
        catalog.set("Lang", Object::string_literal("en-US"));
        catalog.set("OpenAction", Object::Reference(second_page_id));

        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let result = reorder_browser_pdf_pages(&bytes, &[2, 1]).unwrap();
        let reordered = Document::load_mem(&result.data).unwrap();
        let reordered_pages = reordered.get_pages();
        let catalog = reordered.catalog().unwrap();
        let info_id = reordered
            .trailer
            .get(b"Info")
            .unwrap()
            .as_reference()
            .unwrap();
        let info = reordered.get_dictionary(info_id).unwrap();

        assert_eq!(catalog.get(b"PageMode").unwrap().as_name().unwrap(), b"UseOutlines");
        assert_eq!(
            catalog.get(b"PageLayout").unwrap().as_name().unwrap(),
            b"TwoColumnLeft"
        );
        assert_eq!(
            pdf_string_to_text(catalog.get(b"Lang").unwrap()).unwrap(),
            "en-US"
        );
        assert_eq!(
            catalog.get(b"OpenAction").unwrap().as_reference().unwrap(),
            *reordered_pages.get(&1).unwrap()
        );
        assert_eq!(
            pdf_string_to_text(info.get(b"Title").unwrap()).unwrap(),
            "Preserved title"
        );
        assert_eq!(pdf_string_to_text(info.get(b"Author").unwrap()).unwrap(), "EVB");
    }

    #[test]
    fn inserts_pages_between_destination_pages() {
        fn destination(page_id: ObjectId) -> Object {
            vec![Object::Reference(page_id), Object::Name(b"Fit".to_vec())].into()
        }

        fn link(page_id: ObjectId) -> Object {
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Link",
                "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                "Dest" => destination(page_id),
                "A" => dictionary! {"S" => "GoTo", "D" => destination(page_id)},
            }
            .into()
        }

        fn assert_link_target(document: &Document, page_id: ObjectId, target_id: ObjectId) {
            let annotation_id = document
                .get_dictionary(page_id)
                .unwrap()
                .get(b"Annots")
                .unwrap()
                .as_array()
                .unwrap()[0]
                .as_reference()
                .unwrap();
            let annotation = document.get_dictionary(annotation_id).unwrap();
            assert_eq!(
                annotation
                    .get(b"Dest")
                    .unwrap()
                    .as_array()
                    .unwrap()[0]
                    .as_reference()
                    .unwrap(),
                target_id
            );
            assert_eq!(
                annotation
                    .get(b"A")
                    .unwrap()
                    .as_dict()
                    .unwrap()
                    .get(b"D")
                    .unwrap()
                    .as_array()
                    .unwrap()[0]
                    .as_reference()
                    .unwrap(),
                target_id
            );
        }

        let (mut destination, _) = create_test_document();
        let second_destination_page = destination.add_object(dictionary! {
            "Type" => "Page",
            "MediaBox" => vec![0.into(), 0.into(), 300.into(), 100.into()],
        });
        let destination_pages_id = destination.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
        destination
            .get_dictionary_mut(second_destination_page)
            .unwrap()
            .set("Parent", destination_pages_id);
        let first_destination_page = *destination.get_pages().get(&1).unwrap();
        let destination_pages = destination.get_dictionary_mut(destination_pages_id).unwrap();
        destination_pages.set("Kids", vec![
            Object::Reference(first_destination_page),
            Object::Reference(second_destination_page),
        ]);
        destination_pages.set("Count", 2);
        let destination_link = destination.add_object(link(second_destination_page));
        destination
            .get_dictionary_mut(first_destination_page)
            .unwrap()
            .set("Annots", vec![Object::Reference(destination_link)]);
        let mut destination_bytes = Vec::new();
        destination.save_to(&mut destination_bytes).unwrap();

        let (mut insertion, insertion_page_id) = create_test_document();
        let second_insertion_page = insertion.add_object(dictionary! {
            "Type" => "Page",
            "MediaBox" => vec![0.into(), 0.into(), 600.into(), 100.into()],
            "Parent" => insertion.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap(),
        });
        let insertion_pages_id = insertion.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
        insertion
            .get_dictionary_mut(insertion_pages_id)
            .unwrap()
            .set("Kids", vec![Object::Reference(insertion_page_id), Object::Reference(second_insertion_page)]);
        insertion
            .get_dictionary_mut(insertion_pages_id)
            .unwrap()
            .set("Count", 2);
        insertion
            .get_dictionary_mut(insertion_page_id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 500.into(), 100.into()]);
        let insertion_link = insertion.add_object(link(second_insertion_page));
        insertion
            .get_dictionary_mut(insertion_page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(insertion_link)]);
        assert_eq!(first_destination_page, insertion_page_id);
        assert_eq!(second_destination_page, second_insertion_page);
        let mut insertion_bytes = Vec::new();
        insertion.save_to(&mut insertion_bytes).unwrap();

        let result = insert_browser_pdf_pages(&destination_bytes, &insertion_bytes, 1).unwrap();
        let inserted = Document::load_mem(&result.data).unwrap();
        let pages = inserted.get_pages();

        assert_eq!(result.page_count, 4);
        assert_eq!(
            resolve_inherited_box(&inserted, *pages.get(&1).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            200.0,
        );
        assert_eq!(
            resolve_inherited_box(&inserted, *pages.get(&2).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            500.0,
        );
        assert_eq!(
            resolve_inherited_box(&inserted, *pages.get(&3).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            600.0,
        );
        assert_eq!(
            resolve_inherited_box(&inserted, *pages.get(&4).unwrap(), b"MediaBox")
                .unwrap()
                .width(),
            300.0,
        );
        assert_link_target(
            &inserted,
            *pages.get(&1).unwrap(),
            *pages.get(&4).unwrap(),
        );
        assert_link_target(
            &inserted,
            *pages.get(&2).unwrap(),
            *pages.get(&3).unwrap(),
        );
    }

    #[test]
    fn reports_effective_geometry_for_inherited_crop_box() {
        let (mut document, page_id) = create_test_document();
        let pages_id = document.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
        document
            .get_dictionary_mut(pages_id)
            .unwrap()
            .set("CropBox", vec![20.into(), 10.into(), 180.into(), 90.into()]);
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Rotate", 90);
        let geometry = get_browser_page_geometry(&document, 1).unwrap();

        assert_eq!(geometry.media_box.width(), 200.0);
        assert_eq!(geometry.media_box.height(), 100.0);
        assert_eq!(geometry.crop_box.unwrap().width(), 160.0);
        assert_eq!(geometry.crop_box.unwrap().height(), 80.0);
        assert_eq!(geometry.rotation, 90);
    }
