#[test]
fn appends_page_labels_and_bookmarks_as_incremental_revision() {
    let (mut document, _page_id) = create_test_document();
    let input_path = temp_pdf_path("append-metadata-input");
    let output_path = temp_pdf_path("append-metadata-output");
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
            page_labels: Some(PageLabelsMutation {
                total_pages: 1,
                ranges: vec![PageLabelRange {
                    start_page: 1,
                    style: Some("r".to_string()),
                    prefix: "intro-".to_string(),
                    start_number: 3,
                }],
            }),
            bookmarks: Some(BookmarksMutation {
                total_pages: 1,
                untitled_label: "Untitled".to_string(),
                items: vec![BookmarkEntry {
                    title: "Chapter 1".to_string(),
                    page_index: Some(0),
                    page_y_ratio: Some(0.5),
                    named_dest: None,
                    original_destination: None,
                    original_action: None,
                    bold: true,
                    italic: false,
                    color: Some("#336699".to_string()),
                    items: Vec::new(),
                }],
            }),
            shapes: None,
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
    assert!(output_bytes
        .windows(b"/Prev".len())
        .any(|window| window == b"/Prev"));

    let loaded = Document::load(&output_path).unwrap();
    let page_labels = resolve_dictionary_object(
        &loaded,
        catalog(&loaded).get(b"PageLabels").unwrap(),
        "PageLabels",
    )
    .unwrap();
    let nums = page_labels.get(b"Nums").unwrap().as_array().unwrap();
    assert_eq!(nums.len(), 2);
    let range = nums[1].as_dict().unwrap();
    assert_eq!(range.get(b"S").unwrap().as_name().unwrap(), b"r");
    assert_eq!(
        pdf_string_to_text(range.get(b"P").unwrap()).unwrap(),
        "intro-"
    );
    assert_eq!(range.get(b"St").unwrap().as_i64().unwrap(), 3);

    let outlines_ref = catalog(&loaded)
        .get(b"Outlines")
        .unwrap()
        .as_reference()
        .unwrap();
    let outlines = loaded.get_dictionary(outlines_ref).unwrap();
    assert_eq!(outlines.get(b"Count").unwrap().as_i64().unwrap(), 1);
    let first_ref = outlines.get(b"First").unwrap().as_reference().unwrap();
    let first = loaded.get_dictionary(first_ref).unwrap();
    assert_eq!(
        pdf_string_to_text(first.get(b"Title").unwrap()).unwrap(),
        "Chapter 1"
    );
    assert!(first.get(b"Dest").is_ok());
    let dest = first.get(b"Dest").unwrap().as_array().unwrap();
    assert_eq!(dest.get(1).unwrap().as_name().unwrap(), b"XYZ");
    assert_eq!(dest.get(3).unwrap(), &Object::Integer(50));
    assert_eq!(first.get(b"F").unwrap().as_i64().unwrap(), 2);

    let _ = remove_file(input_path);
    let _ = remove_file(output_path);
}

#[test]
fn omitted_metadata_mutations_preserve_existing_catalog_metadata() {
    let (mut document, _page_id) = create_outline_fixture();
    let before = catalog(&document).clone();

    apply_native_mutations(
        &mut document,
        &NativeMutationsFile::default(),
        "D:20260609123456Z",
    )
    .unwrap();

    let after = catalog(&document);
    assert_eq!(
        after.get(b"PageLabels").unwrap(),
        before.get(b"PageLabels").unwrap()
    );
    assert_eq!(
        after.get(b"Outlines").unwrap(),
        before.get(b"Outlines").unwrap()
    );
}

#[test]
fn read_catalog_returns_outlines_and_page_labels() {
    let (document, _page_id) = create_outline_fixture();
    let catalog = read_pdf_combine_catalog(&document).unwrap();
    assert_eq!(catalog.page_labels.len(), 1);
    assert_eq!(catalog.bookmarks[0].title, "Parent");
    assert_eq!(catalog.bookmarks[0].page_index, Some(0));
}

#[test]
fn add_implicit_default_page_label_range_only_when_source_needs_a_reset() {
    let mut sparse = vec![PdfCombinePageLabelRange {
        page_index: 2,
        style: Some("r".to_string()),
        prefix: None,
        start: None,
    }];
    add_implicit_default_page_label_range(&mut sparse, 3);
    assert_eq!(sparse[0].page_index, 0);
    assert_eq!(sparse[1].page_index, 2);

    let mut explicit = vec![PdfCombinePageLabelRange {
        page_index: 0,
        style: Some("r".to_string()),
        prefix: None,
        start: None,
    }];
    add_implicit_default_page_label_range(&mut explicit, 3);
    assert_eq!(explicit.len(), 1);

    let mut empty = Vec::new();
    add_implicit_default_page_label_range(&mut empty, 0);
    assert!(empty.is_empty());
}

#[test]
fn read_catalog_terminates_on_cyclic_outline() {
    let mut document = create_test_document().0;
    let item_id = document.new_object_id();
    document.set_object(
        item_id,
        Object::Dictionary(dictionary! {
            "Title" => Object::string_literal("Loop"),
            "Next" => Object::Reference(item_id),
        }),
    );
    let outlines_id = document.new_object_id();
    document.set_object(
        outlines_id,
        Object::Dictionary(dictionary! {"First" => Object::Reference(item_id)}),
    );
    let root_id = document
        .trailer
        .get(b"Root")
        .unwrap()
        .as_reference()
        .unwrap();
    document
        .get_dictionary_mut(root_id)
        .unwrap()
        .set("Outlines", Object::Reference(outlines_id));

    let catalog = read_pdf_combine_catalog(&document).unwrap();
    assert_eq!(catalog.bookmarks.len(), 1);
    assert!(catalog.bookmarks[0].items.is_empty());
}

#[test]
fn read_catalog_resolves_named_destinations_through_the_name_tree() {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let page_ids = (0..3)
        .map(|_| document.add_object(dictionary! {"Type" => "Page", "Parent" => pages_id}))
        .collect::<Vec<_>>();
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => 3,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
        },
    );
    let fit = |page_id: ObjectId| {
        Object::Array(vec![
            Object::Reference(page_id),
            Object::Name(b"Fit".to_vec()),
        ])
    };
    let root_id = document.new_object_id();
    let first_leaf_id = document.add_object(dictionary! {
        "Limits" => vec![Object::string_literal("dup"), Object::string_literal("shared")],
        "Names" => vec![
            Object::string_literal("dup"), fit(page_ids[0]),
            Object::string_literal("legacy"), fit(page_ids[0]),
            Object::string_literal("shared"), fit(page_ids[1]),
        ],
    });
    let second_leaf_id = document.add_object(dictionary! {
        "Limits" => vec![Object::string_literal("dup"), Object::string_literal("wrapped")],
        "Names" => vec![
            Object::string_literal("dup"), fit(page_ids[2]),
            Object::string_literal("wrapped"),
            Object::Dictionary(dictionary! {"D" => fit(page_ids[2])}),
        ],
    });
    // The root lists itself as a kid; the walk must stop rather than loop.
    document.set_object(
        root_id,
        dictionary! {
            "Kids" => vec![
                Object::Reference(first_leaf_id),
                Object::Reference(second_leaf_id),
                Object::Reference(root_id),
            ],
        },
    );
    let outline_titles = ["dup", "legacy", "shared", "wrapped", "missing", "shared"];
    let outlines_id = document.new_object_id();
    let item_ids = outline_titles
        .iter()
        .map(|_| document.new_object_id())
        .collect::<Vec<_>>();
    for (index, (item_id, name)) in item_ids.iter().zip(outline_titles).enumerate() {
        let mut item = dictionary! {
            "Title" => Object::string_literal(name),
            "Parent" => outlines_id,
            "Dest" => Object::string_literal(name),
        };
        if let Some(next_id) = item_ids.get(index + 1) {
            item.set("Next", Object::Reference(*next_id));
        }
        document.set_object(*item_id, item);
    }
    document.set_object(
        outlines_id,
        dictionary! {
            "Type" => "Outlines",
            "First" => Object::Reference(item_ids[0]),
            "Last" => Object::Reference(*item_ids.last().unwrap()),
            "Count" => i64::try_from(item_ids.len()).unwrap(),
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
        "Outlines" => outlines_id,
        "Dests" => dictionary! {"legacy" => fit(page_ids[1])},
        "Names" => dictionary! {"Dests" => root_id},
    });
    document.trailer.set("Root", catalog_id);

    let catalog = read_pdf_combine_catalog(&document).unwrap();
    let resolved = catalog
        .bookmarks
        .iter()
        .map(|bookmark| (bookmark.title.as_str(), bookmark.page_index))
        .collect::<Vec<_>>();
    assert_eq!(
        resolved,
        [
            ("dup", Some(0)),
            ("legacy", Some(1)),
            ("shared", Some(1)),
            ("wrapped", Some(2)),
            ("missing", None),
            ("shared", Some(1)),
        ]
    );
}

#[test]
fn saves_and_reopens_10_001_bookmarks_across_path_addressed_fragments() {
    let (mut document, _page_id) = create_test_document();
    let input_path = temp_pdf_path("append-bookmark-subtree-input");
    let mut original_bytes = Vec::new();
    document.save_to(&mut original_bytes).unwrap();
    write(&input_path, &original_bytes).unwrap();

    let root = BookmarkEntry {
        title: "Root".to_string(),
        page_index: Some(0),
        page_y_ratio: None,
        named_dest: None,
                    original_destination: None,
                    original_action: None,
        bold: false,
        italic: false,
        color: None,
        items: Vec::new(),
    };
    append_native_mutations(
        &input_path,
        &input_path,
        &NativeMutationsFile {
            updates: Vec::new(),
            geometry_updates: Vec::new(),
            notes: Vec::new(),
            free_text_notes: Vec::new(),
            text_boxes: Vec::new(),
            deletes: Vec::new(),
            page_rotations: Vec::new(),
            page_labels: None,
            bookmarks: Some(BookmarksMutation {
                total_pages: 1,
                untitled_label: "Untitled".to_string(),
                items: vec![root],
            }),
            shapes: None,
            markup: None,
            placed_images: Vec::new(),
            placed_image_geometry_updates: Vec::new(),
            continuation: None,
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let mut children = (0..10_000)
        .map(|index| BookmarkEntry {
            title: format!("Child {index}"),
            page_index: Some(0),
            page_y_ratio: None,
            named_dest: None,
                    original_destination: None,
                    original_action: None,
            bold: false,
            italic: false,
            color: None,
            items: Vec::new(),
        })
        .collect::<Vec<_>>();
    for (chunk_index, chunk) in children.chunks_mut(5_000).enumerate() {
        append_native_mutations(
            &input_path,
            &input_path,
            &NativeMutationsFile {
                updates: Vec::new(),
                geometry_updates: Vec::new(),
                notes: Vec::new(),
                free_text_notes: Vec::new(),
                text_boxes: Vec::new(),
                deletes: Vec::new(),
                page_rotations: Vec::new(),
                page_labels: None,
                bookmarks: Some(BookmarksMutation {
                    total_pages: 1,
                    untitled_label: "Untitled".to_string(),
                    items: chunk.to_vec(),
                }),
                shapes: None,
                markup: None,
                placed_images: Vec::new(),
                placed_image_geometry_updates: Vec::new(),
                continuation: Some(NativeMutationContinuation {
                    family: NativeMutationContinuationFamily::Bookmarks,
                    chunk_index: u32::try_from(chunk_index + 1).unwrap(),
                    chunk_count: 3,
                    bookmark_path: vec![0],
                }),
            },
            "D:20260609123456+03'00'",
        )
        .unwrap();
    }

    let loaded = Document::load(&input_path).unwrap();
    let outlines_ref = catalog(&loaded)
        .get(b"Outlines")
        .unwrap()
        .as_reference()
        .unwrap();
    let outlines = loaded.get_dictionary(outlines_ref).unwrap();
    assert_eq!(outlines.get(b"Count").unwrap().as_i64().unwrap(), 10_001);
    let root_ref = outlines.get(b"First").unwrap().as_reference().unwrap();
    let root = loaded.get_dictionary(root_ref).unwrap();
    assert_eq!(root.get(b"Count").unwrap().as_i64().unwrap(), 10_000);
    let mut child_ref = root.get(b"First").unwrap().as_reference().unwrap();
    for expected_index in 0..10_000 {
        let child = loaded.get_dictionary(child_ref).unwrap();
        assert_eq!(
            pdf_string_to_text(child.get(b"Title").unwrap()).unwrap(),
            format!("Child {expected_index}"),
        );
        if expected_index < 9_999 {
            child_ref = child.get(b"Next").unwrap().as_reference().unwrap();
        } else {
            assert!(child.get(b"Next").is_err());
        }
    }

    let _ = remove_file(input_path);
}

#[test]
fn appends_metadata_removal_as_incremental_revision() {
    let (mut document, _page_id) = create_test_document();
    set_page_labels(
        &mut document,
        &PageLabelsMutation {
            total_pages: 1,
            ranges: vec![PageLabelRange {
                start_page: 1,
                style: Some("A".to_string()),
                prefix: "old-".to_string(),
                start_number: 2,
            }],
        },
    )
    .unwrap();
    set_bookmarks(
        &mut document,
        &BookmarksMutation {
            total_pages: 1,
            untitled_label: "Untitled".to_string(),
            items: vec![BookmarkEntry {
                title: "Old".to_string(),
                page_index: Some(0),
                page_y_ratio: None,
                named_dest: None,
                    original_destination: None,
                    original_action: None,
                bold: false,
                italic: false,
                color: None,
                items: Vec::new(),
            }],
        },
    )
    .unwrap();

    let pdf_path = temp_pdf_path("append-metadata-removal");
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
            page_labels: Some(PageLabelsMutation {
                total_pages: 1,
                ranges: vec![PageLabelRange {
                    start_page: 1,
                    style: Some("D".to_string()),
                    prefix: String::new(),
                    start_number: 1,
                }],
            }),
            bookmarks: Some(BookmarksMutation {
                total_pages: 1,
                untitled_label: "Untitled".to_string(),
                items: Vec::new(),
            }),
            shapes: None,
            markup: None,
            placed_images: Vec::new(),
            placed_image_geometry_updates: Vec::new(),
            continuation: None,
        },
        "D:20260609123456+03'00'",
    )
    .unwrap();

    let loaded = Document::load(&pdf_path).unwrap();
    let catalog = catalog(&loaded);
    assert!(catalog.get(b"PageLabels").is_err());
    assert!(catalog.get(b"Outlines").is_err());

    let _ = remove_file(pdf_path);
}

struct NoDensePageIds<'a>(&'a Document);

impl PdfObjectSource for NoDensePageIds<'_> {
    fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
        self.0.objects.get(&object_id)
    }

    fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
        panic!("the bounded page resolver must not request a dense page map")
    }

    fn root_id(&self) -> Result<ObjectId> {
        Ok(self.0.trailer.get(b"Root")?.as_reference()?)
    }
}

struct CountingPageTreeNodes<'a> {
    document: &'a Document,
    page_tree_node_reads: &'a std::sync::atomic::AtomicUsize,
}

impl PdfObjectSource for CountingPageTreeNodes<'_> {
    fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
        let object = self.document.objects.get(&object_id)?;
        let is_page_tree_node = object
            .as_dict()
            .ok()
            .and_then(|dictionary| dictionary.get(b"Type").ok())
            .and_then(|object| object.as_name().ok())
            .is_some_and(|name| name == b"Page" || name == b"Pages");
        if is_page_tree_node {
            self.page_tree_node_reads
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Some(object)
    }

    fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
        panic!("the bounded page resolver must not request a dense page map")
    }

    fn root_id(&self) -> Result<ObjectId> {
        Ok(self.document.trailer.get(b"Root")?.as_reference()?)
    }
}

fn flatten_million_page_tree(document: &mut Document, first_page_id: ObjectId) {
    const PAGE_COUNT: usize = 1_000_000;
    let catalog_id = document.root_id().unwrap();
    let root_pages_id = document
        .get_dictionary(catalog_id)
        .unwrap()
        .get(b"Pages")
        .unwrap()
        .as_reference()
        .unwrap();
    let first_group_id = document
        .get_dictionary(root_pages_id)
        .unwrap()
        .get(b"Kids")
        .unwrap()
        .as_array()
        .unwrap()[0]
        .as_reference()
        .unwrap();

    document
        .get_dictionary_mut(root_pages_id)
        .unwrap()
        .set("Kids", vec![Object::Reference(first_group_id)]);
    document
        .get_dictionary_mut(first_group_id)
        .unwrap()
        .set("Count", Object::Integer(PAGE_COUNT as i64));
    document.get_dictionary_mut(first_group_id).unwrap().set(
        "Kids",
        Object::Array(vec![Object::Reference(first_page_id); PAGE_COUNT]),
    );
}

fn create_sparse_million_page_document() -> (Document, ObjectId, ObjectId) {
    // Keep only the two leaves that the test resolves. The large /Count
    // values model the untouched branches retained by a structural path
    // loader, where constructing a dense page map would defeat the load.
    const PAGE_COUNT: i64 = 1_000_000;
    let mut document = Document::with_version("1.7");
    let root_pages_id = document.new_object_id();
    let first_group_id = document.new_object_id();
    let last_group_id = document.new_object_id();
    let first_page_id = document.new_object_id();
    let last_page_id = document.new_object_id();

    for (page_id, parent_id) in [
        (first_page_id, first_group_id),
        (last_page_id, last_group_id),
    ] {
        document.set_object(
            page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => parent_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            },
        );
    }
    document.set_object(
        first_group_id,
        dictionary! {
            "Type" => "Pages",
            "Parent" => root_pages_id,
            "Kids" => vec![Object::Reference(first_page_id)],
            "Count" => PAGE_COUNT - 1,
        },
    );
    document.set_object(
        last_group_id,
        dictionary! {
            "Type" => "Pages",
            "Parent" => root_pages_id,
            "Kids" => vec![Object::Reference(last_page_id)],
            "Count" => 1,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => root_pages_id,
    });
    document.set_object(
        root_pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![
                Object::Reference(first_group_id),
                Object::Reference(last_group_id),
            ],
            "Count" => PAGE_COUNT,
        },
    );
    document.trailer.set("Root", catalog_id);
    (document, first_page_id, last_page_id)
}

fn create_overlay_source_document() -> Document {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let font_id = document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let page_ids = (0..2)
        .map(|_| {
            let content_id = document.add_object(Stream::new(
                Dictionary::new(),
                b"BT /F1 12 Tf 10 20 Td (OCR) Tj ET".to_vec(),
            ));
            document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                "Resources" => dictionary! {
                    "Font" => dictionary! { "F1" => font_id },
                },
                "Contents" => content_id,
            })
        })
        .collect::<Vec<_>>();
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.into_iter().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => 2,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    document
}

fn create_aliasing_overlay_target() -> (Document, ObjectId) {
    let (mut document, page_id) = create_test_document();
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Resources", Dictionary::new());
    let pages_id = document
        .get_dictionary(page_id)
        .unwrap()
        .get(b"Parent")
        .unwrap()
        .as_reference()
        .unwrap();
    let pages = document.get_dictionary_mut(pages_id).unwrap();
    pages.set(
        "Kids",
        vec![Object::Reference(page_id), Object::Reference(page_id)],
    );
    pages.set("Count", 2);
    (document, page_id)
}

fn create_flat_million_page_overlay_target() -> Document {
    let (mut document, first_page_id, _) = create_sparse_million_page_document();
    document
        .get_dictionary_mut(first_page_id)
        .unwrap()
        .set("Resources", Dictionary::new());
    flatten_million_page_tree(&mut document, first_page_id);
    document
}

#[test]
fn resolves_million_page_tree_counts_without_collecting_page_ids() {
    let (document, first_page_id, last_page_id) = create_sparse_million_page_document();
    let source = NoDensePageIds(&document);
    let resolver = PageTreeResolver::new(&source).unwrap();

    assert_eq!(resolver.page_count(), 1_000_000);
    assert_eq!(resolver.page_id(&source, 1).unwrap(), first_page_id);
    assert_eq!(resolver.page_id(&source, 1_000_000).unwrap(), last_page_id);
    assert!(resolver.page_id(&source, 1_000_001).is_err());
}

#[test]
fn visits_pages_without_retaining_a_dense_page_map() {
    let (document, page_id) = create_test_document();
    let source = NoDensePageIds(&document);
    let resolver = PageTreeResolver::new(&source).unwrap();
    let mut visited = Vec::new();

    resolver
        .for_each_page_id(&source, |visited_page_id| {
            visited.push(visited_page_id);
            Ok(())
        })
        .unwrap();

    assert_eq!(visited, vec![page_id]);
}

#[test]
fn applies_labels_and_bookmarks_to_sparse_million_page_tree() {
    let (mut document, first_page_id, last_page_id) = create_sparse_million_page_document();
    let page_labels = PageLabelsMutation {
        total_pages: 1_000_000,
        ranges: vec![
            PageLabelRange {
                start_page: 1,
                style: Some("D".to_string()),
                prefix: "front-".to_string(),
                start_number: 1,
            },
            PageLabelRange {
                start_page: 1_000_000,
                style: Some("r".to_string()),
                prefix: "back-".to_string(),
                start_number: 7,
            },
        ],
    };
    set_page_labels(&mut document, &page_labels).unwrap();

    let bookmarks = BookmarksMutation {
        total_pages: 1_000_000,
        untitled_label: "Untitled".to_string(),
        items: vec![
            BookmarkEntry {
                title: "First".to_string(),
                page_index: Some(0),
                page_y_ratio: Some(0.25),
                named_dest: None,
                    original_destination: None,
                    original_action: None,
                bold: false,
                italic: false,
                color: None,
                items: Vec::new(),
            },
            BookmarkEntry {
                title: "Last".to_string(),
                page_index: Some(999_999),
                page_y_ratio: Some(0.75),
                named_dest: None,
                    original_destination: None,
                    original_action: None,
                bold: true,
                italic: true,
                color: Some("#336699".to_string()),
                items: Vec::new(),
            },
        ],
    };
    set_bookmarks(&mut document, &bookmarks).unwrap();

    validate_page_labels_document_postconditions(&document, &page_labels).unwrap();
    validate_bookmarks_document_postconditions(&document, &bookmarks).unwrap();

    let outlines_id = catalog(&document)
        .get(b"Outlines")
        .unwrap()
        .as_reference()
        .unwrap();
    let first = document
        .get_dictionary(
            document
                .get_dictionary(outlines_id)
                .unwrap()
                .get(b"First")
                .unwrap()
                .as_reference()
                .unwrap(),
        )
        .unwrap();
    let last = document
        .get_dictionary(first.get(b"Next").unwrap().as_reference().unwrap())
        .unwrap();
    assert_eq!(
        first.get(b"Dest").unwrap().as_array().unwrap()[0],
        Object::Reference(first_page_id)
    );
    assert_eq!(
        last.get(b"Dest").unwrap().as_array().unwrap()[0],
        Object::Reference(last_page_id)
    );
}

#[test]
fn validates_sparse_shape_and_annotation_postconditions_without_a_full_page_walk() {
    let (mut document, first_page_id, _) = create_sparse_million_page_document();
    let shape = rectangle_shape("evb-shape:bounded", "#336699");
    let shape_mutation = ShapesMutation {
        total_pages: 1_000_000,
        rewrite_shape_state: true,
        shapes: vec![shape],
        deleted_annotation_ids: Vec::new(),
        deleted_stable_keys: Vec::new(),
    };
    apply_shape_annotations(
        &mut document,
        &shape_mutation,
        "D:20260609123456Z",
        &mut None,
    )
    .unwrap();

    let note_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Text",
        "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
    });
    let mut annots = get_page_annots(&document, first_page_id).unwrap();
    annots.push(Object::Reference(note_id));
    document
        .get_dictionary_mut(first_page_id)
        .unwrap()
        .set("Annots", Object::Array(annots));

    flatten_million_page_tree(&mut document, first_page_id);

    reset_page_tree_node_read_count();
    apply_shape_annotations(
        &mut document,
        &shape_mutation,
        "D:20260609123456Z",
        &mut None,
    )
    .unwrap();
    assert!(
        page_tree_node_read_count() < 100,
        "shape mutation walked too many page-tree nodes: {}",
        page_tree_node_read_count()
    );

    let delete = AnnotationDelete {
        page_index: 0,
        object_number: Some(note_id.0),
        generation_number: Some(note_id.1),
        stable_key: None,
        created_at: None,
    };
    reset_page_tree_node_read_count();
    delete_annotations(&mut document, std::slice::from_ref(&delete)).unwrap();
    assert!(
        page_tree_node_read_count() < 100,
        "annotation mutation walked too many page-tree nodes: {}",
        page_tree_node_read_count()
    );

    let page_tree_node_reads = std::sync::atomic::AtomicUsize::new(0);
    let source = CountingPageTreeNodes {
        document: &document,
        page_tree_node_reads: &page_tree_node_reads,
    };
    validate_shapes_document_postconditions(&source, &shape_mutation).unwrap();
    validate_annotation_delete_document_postconditions(&source, &[delete]).unwrap();

    assert!(
        page_tree_node_reads.load(std::sync::atomic::Ordering::Relaxed) < 100,
        "bounded postconditions walked too many page-tree nodes: {}",
        page_tree_node_reads.load(std::sync::atomic::Ordering::Relaxed)
    );
}

#[test]
fn applies_sparse_shape_and_annotation_mutations_incrementally_without_a_full_page_walk() {
    let (mut document, first_page_id, _) = create_sparse_million_page_document();
    let note_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Text",
        "Rect" => vec![10.into(), 10.into(), 30.into(), 30.into()],
    });
    document
        .get_dictionary_mut(first_page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(note_id)]);
    flatten_million_page_tree(&mut document, first_page_id);

    let mut incremental = IncrementalDocument::from_document(document, 0, None);
    let shape = rectangle_shape("evb-shape:incremental-bounded", "#336699");
    let shape_mutation = ShapesMutation {
        total_pages: 1_000_000,
        rewrite_shape_state: true,
        shapes: vec![shape],
        deleted_annotation_ids: Vec::new(),
        deleted_stable_keys: Vec::new(),
    };

    reset_page_tree_node_read_count();
    apply_shape_annotations_incremental(
        &mut incremental,
        &shape_mutation,
        "D:20260609123456Z",
        &mut None,
    )
    .unwrap();
    assert!(
        page_tree_node_read_count() < 100,
        "incremental shape mutation walked too many page-tree nodes: {}",
        page_tree_node_read_count()
    );

    let delete = AnnotationDelete {
        page_index: 0,
        object_number: Some(note_id.0),
        generation_number: Some(note_id.1),
        stable_key: None,
        created_at: None,
    };
    reset_page_tree_node_read_count();
    delete_annotations_incremental(&mut incremental, std::slice::from_ref(&delete)).unwrap();
    assert!(
        page_tree_node_read_count() < 100,
        "incremental annotation mutation walked too many page-tree nodes: {}",
        page_tree_node_read_count()
    );

    let revision = AppendedRevision::new(&incremental);
    let annots = get_page_annots(&revision, first_page_id).unwrap();
    assert_eq!(annots.len(), 1);
    let shape_id = annots[0].as_reference().unwrap();
    assert_eq!(
        read_managed_shape_stable_key(revision.dictionary(shape_id).unwrap()).as_deref(),
        Some("evb-shape:incremental-bounded")
    );
}

#[test]
fn overlays_high_index_pages_in_million_page_batches_without_a_full_page_walk() {
    let source = create_overlay_source_document();
    for (source_page_index, output_page_index) in [(0, 999_998), (1, 999_999)] {
        let target = create_flat_million_page_overlay_target();
        let mut incremental = IncrementalDocument::from_document(target, 0, None);
        let instructions = TextLayerFile {
            pages: vec![TextLayerInstruction {
                source_page_index,
                output_page_index,
                matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                filter_to_output_page: false,
                normalize_greek_micro_sign: false,
                link_only: false,
                unmapped_geometry: false,
                source_region: None,
            }],
        };

        reset_page_tree_node_read_count();
        overlay_text_layers_incremental(&mut incremental, &source, &instructions).unwrap();
        assert!(
            page_tree_node_read_count() < 100,
            "overlay-text batch resolved too many page-tree nodes: {}",
            page_tree_node_read_count()
        );

        let target_page_id = PageTreeResolver::new(&incremental.previous_document)
            .unwrap()
            .page_id(
                &incremental.previous_document,
                u32::try_from(output_page_index.checked_add(1).unwrap()).unwrap(),
            )
            .unwrap();
        assert!(!incremental
            .new_document
            .get_page_contents(target_page_id)
            .is_empty());
    }
}

#[test]
fn overlays_multiple_instructions_for_one_target_page_without_resetting_contents() {
    let source = create_overlay_source_document();
    let (target, target_page_id) = create_aliasing_overlay_target();
    let mut incremental = IncrementalDocument::from_document(target, 0, None);
    let instructions = TextLayerFile {
        pages: vec![
            TextLayerInstruction {
                source_page_index: 0,
                output_page_index: 0,
                matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                filter_to_output_page: false,
                normalize_greek_micro_sign: false,
                link_only: false,
                unmapped_geometry: false,
                source_region: None,
            },
            TextLayerInstruction {
                source_page_index: 1,
                output_page_index: 1,
                matrix: [1.0, 0.0, 0.0, 1.0, 20.0, 0.0],
                filter_to_output_page: false,
                normalize_greek_micro_sign: false,
                link_only: false,
                unmapped_geometry: false,
                source_region: None,
            },
        ],
    };

    overlay_text_layers_incremental(&mut incremental, &source, &instructions).unwrap();

    assert_eq!(
        incremental
            .new_document
            .get_page_contents(target_page_id)
            .len(),
        2
    );
}

#[test]
fn overlays_source_batches_for_one_target_page_without_resetting_prior_batch() {
    let source = create_overlay_source_document();
    let (target, target_page_id) = create_aliasing_overlay_target();
    let mut incremental = IncrementalDocument::from_document(target, 0, None);
    let instruction = |source_page_index, output_page_index| TextLayerFile {
        pages: vec![TextLayerInstruction {
            source_page_index,
            output_page_index,
            matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            filter_to_output_page: false,
            normalize_greek_micro_sign: false,
            link_only: false,
            unmapped_geometry: false,
            source_region: None,
        }],
    };

    overlay_text_layers_incremental(&mut incremental, &source, &instruction(0, 0)).unwrap();
    overlay_text_layers_incremental(&mut incremental, &source, &instruction(1, 1)).unwrap();

    assert_eq!(
        incremental
            .new_document
            .get_page_contents(target_page_id)
            .len(),
        2
    );
}

// Inspect the same final publication phase as the path writer, after both
// eager and incremental copy stages have assigned their output identities.
fn finalize_cleanup_copy(target: &mut Document, source: &Document, instructions: &TextLayerFile) {
    let source_path = temp_pdf_path("cleanup-final-source");
    let output_path = temp_pdf_path("cleanup-final-output");
    source.clone().save(&source_path).unwrap();
    target.save(&output_path).unwrap();
    rebind_retained_destinations(&output_path, &source_path, instructions, None).unwrap();
    *target = Document::load(&output_path).unwrap();
    remove_file(source_path).unwrap();
    remove_file(output_path).unwrap();
}

#[test]
fn cleanup_overlay_preserves_notes_replies_and_markup_at_affine_positions() {
    let mut source = create_overlay_source_document();
    let source_page = *source.get_pages().get(&1).unwrap();
    let note = source.new_object_id();
    let popup = source.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Popup", "Parent" => note,
        "P" => source_page, "Rect" => vec![15.into(), 25.into(), 40.into(), 45.into()],
    });
    source.set_object(
        note,
        dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "Name" => "Comment",
            "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()],
            "Contents" => lopdf::text_string("Cleanup note Ω"),
            "T" => Object::string_literal("Reader"), "NM" => Object::string_literal("note-id"),
            "CreationDate" => Object::string_literal("D:20261010120000Z"),
            "Popup" => popup, "P" => source_page,
        },
    );
    let reply = source.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "IRT" => note, "RT" => "R",
        "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()],
        "Contents" => Object::string_literal("Reply"), "P" => source_page,
    });
    let quads = source.add_object(vec![
        10.into(),
        40.into(),
        30.into(),
        40.into(),
        10.into(),
        20.into(),
        30.into(),
        20.into(),
    ]);
    let highlight = source.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Highlight", "P" => source_page,
        "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()], "QuadPoints" => quads,
    });
    let ink = source.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Ink", "P" => source_page,
        "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()],
        "InkList" => vec![Object::Array(vec![10.into(), 20.into(), 30.into(), 40.into()])],
    });
    let annots = source.add_object(vec![
        Object::Reference(note),
        Object::Reference(reply),
        Object::Reference(highlight),
        Object::Reference(ink),
        Object::Dictionary(dictionary! {
            "Subtype" => "Square", "Rect" => vec![10.into(), 20.into(), 30.into(), 40.into()],
            "ForeignProperty" => Object::string_literal("Preserved"),
        }),
    ]);
    source
        .get_dictionary_mut(source_page)
        .unwrap()
        .set("Annots", annots);
    let instructions = TextLayerFile {
        pages: vec![TextLayerInstruction {
            source_page_index: 0,
            output_page_index: 1,
            matrix: [0.0, 2.0, -3.0, 0.0, 180.0, -10.0],
            filter_to_output_page: false,
            normalize_greek_micro_sign: false,
            link_only: false,
            unmapped_geometry: false,
            source_region: None,
        }],
    };
    for append in [false, true] {
        let mut target = create_overlay_source_document();
        let target_page = *target.get_pages().get(&2).unwrap();
        if append {
            let mut base_bytes = Vec::new();
            target.save_to(&mut base_bytes).unwrap();
            let mut incremental = IncrementalDocument::from_document(
                Document::load_mem(&base_bytes).unwrap(),
                base_bytes.len() as u64,
                base_bytes.last().copied(),
            );
            overlay_text_layers_incremental(&mut incremental, &source, &instructions).unwrap();
            base_bytes.extend(build_incremental_revision(&mut incremental).unwrap());
            target = Document::load_mem(&base_bytes).unwrap();
        } else {
            overlay_text_layers(&mut target, &source, &instructions).unwrap();
            let mut bytes = Vec::new();
            target.save_to(&mut bytes).unwrap();
            target = Document::load_mem(&bytes).unwrap();
        }
        finalize_cleanup_copy(&mut target, &source, &instructions);
        let annotations = get_page_annots(&target, target_page).unwrap();
        assert_eq!(annotations.len(), 6);
        let dictionaries = annotations
            .iter()
            .map(|annotation| target.dereference(annotation).unwrap().1.as_dict().unwrap())
            .collect::<Vec<_>>();
        for annotation in dictionaries.iter().filter(|annotation| annotation.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Popup")) {
            assert_eq!(
                annotation.get(b"Rect").unwrap(),
                &Object::Array(vec![60.into(), 10.into(), 120.into(), 50.into()])
            );
        }
        let note_id = annotations[0].as_reference().unwrap();
        let popup_id = dictionaries[0]
            .get(b"Popup")
            .unwrap()
            .as_reference()
            .unwrap();
        assert_eq!(
            lopdf::decode_text_string(dictionaries[0].get(b"Contents").unwrap()).unwrap(),
            "Cleanup note Ω"
        );
        assert_eq!(
            dictionaries[0].get(b"T").unwrap(),
            source.get_dictionary(note).unwrap().get(b"T").unwrap()
        );
        assert_eq!(
            dictionaries[0].get(b"NM").unwrap(),
            source.get_dictionary(note).unwrap().get(b"NM").unwrap()
        );
        assert_eq!(
            dictionaries[0].get(b"P").unwrap(),
            &Object::Reference(target_page)
        );
        assert!(annotations.iter().any(|annotation| annotation.as_reference().ok() == Some(popup_id)));
        assert_eq!(
            target
                .get_dictionary(popup_id)
                .unwrap()
                .get(b"Parent")
                .unwrap(),
            &Object::Reference(note_id)
        );
        assert_eq!(
            target
                .get_dictionary(popup_id)
                .unwrap()
                .get(b"Rect")
                .unwrap(),
            &Object::Array(vec![45.into(), 20.into(), 105.into(), 70.into()])
        );
        assert_eq!(
            dictionaries[1].get(b"IRT").unwrap(),
            &Object::Reference(note_id)
        );
        assert_eq!(
            dictionaries[2].get(b"QuadPoints").unwrap(),
            &Object::Array(vec![
                60.into(),
                10.into(),
                60.into(),
                50.into(),
                120.into(),
                10.into(),
                120.into(),
                50.into()
            ])
        );
        assert_eq!(
            dictionaries[3].get(b"InkList").unwrap(),
            &Object::Array(vec![Object::Array(vec![
                120.into(),
                10.into(),
                60.into(),
                50.into()
            ])])
        );
        assert_eq!(
            dictionaries[4].get(b"ForeignProperty").unwrap(),
            &Object::string_literal("Preserved")
        );
        assert_eq!(
            target
                .objects
                .values()
                .filter(|object| object
                    .as_dict()
                    .ok()
                    .and_then(|dictionary| dictionary.get(b"Type").ok())
                    .and_then(|value| value.as_name().ok())
                    == Some(b"Page"))
                .count(),
            2,
            "append={append}, pages={:?}",
            target.get_pages()
        );
    }
    assert_eq!(
        source.get_dictionary(note).unwrap().get(b"Rect").unwrap(),
        &Object::Array(vec![10.into(), 20.into(), 30.into(), 40.into()])
    );
}

#[test]
fn cleanup_split_keeps_notes_with_their_owner_and_markup_on_both_halves() {
    let mut source = create_overlay_source_document();
    let source_page = *source.get_pages().get(&1).unwrap();
    source
        .get_dictionary_mut(source_page)
        .unwrap()
        .remove(b"Contents");
    let note = source.new_object_id();
    let popup = source.add_object(dictionary! {
        "Subtype" => "Popup", "Parent" => note,
        "Rect" => vec![280.into(), 60.into(), 390.into(), 90.into()],
    });
    source.set_object(
        note,
        dictionary! {
            "Subtype" => "Text", "Rect" => vec![195.into(), 45.into(), 205.into(), 55.into()],
            "Contents" => Object::string_literal("Seam note"), "Popup" => popup,
        },
    );
    let reply = source.add_object(dictionary! {
        "Subtype" => "Text", "IRT" => note,
        "Rect" => vec![20.into(), 20.into(), 30.into(), 30.into()],
        "Contents" => Object::string_literal("Seam reply"),
    });
    let highlight = source.add_object(dictionary! {
        "Subtype" => "Highlight", "Rect" => vec![190.into(), 40.into(), 210.into(), 60.into()],
    });
    source.get_dictionary_mut(source_page).unwrap().set(
        "Annots",
        vec![note.into(), popup.into(), reply.into(), highlight.into()],
    );
    for append in [false, true] {
        let mut target = create_overlay_source_document();
        let first_page = *target.get_pages().get(&1).unwrap();
        let existing = target.add_object(dictionary! {
            "Subtype" => "Text", "Rect" => vec![1.into(), 1.into(), 2.into(), 2.into()],
            "Contents" => Object::string_literal("Existing target note"),
        });
        let annots = target.add_object(vec![Object::Reference(existing)]);
        target
            .get_dictionary_mut(first_page)
            .unwrap()
            .set("Annots", annots);
        let instructions = TextLayerFile {
            pages: (0..2)
                .map(|output_page_index| TextLayerInstruction {
                    source_page_index: 0,
                    output_page_index,
                    matrix: [1.0, 0.0, 0.0, 1.0, -(output_page_index as f64) * 200.0, 0.0],
                    filter_to_output_page: true,
                    normalize_greek_micro_sign: false,
                    link_only: false,
                    unmapped_geometry: false,
                    source_region: None,
                })
                .collect(),
        };
        if append {
            let mut bytes = Vec::new();
            target.save_to(&mut bytes).unwrap();
            let mut incremental = IncrementalDocument::from_document(
                Document::load_mem(&bytes).unwrap(),
                bytes.len() as u64,
                bytes.last().copied(),
            );
            overlay_text_layers_incremental(&mut incremental, &source, &instructions).unwrap();
            bytes.extend(build_incremental_revision(&mut incremental).unwrap());
            target = Document::load_mem(&bytes).unwrap();
        } else {
            overlay_text_layers(&mut target, &source, &instructions).unwrap();
        }
        finalize_cleanup_copy(&mut target, &source, &instructions);
        let pages = target.get_pages();
        let left = get_page_annots(&target, pages[&1]).unwrap();
        let right = get_page_annots(&target, pages[&2]).unwrap();
        assert_eq!(left.len(), 2);
        assert_eq!(right.len(), 4);
        assert_eq!(
            target
                .get_dictionary(left[0].as_reference().unwrap())
                .unwrap()
                .get(b"Contents")
                .unwrap(),
            &Object::string_literal("Existing target note")
        );
        assert_eq!(
            target
                .get_dictionary(right[0].as_reference().unwrap())
                .unwrap()
                .get(b"Contents")
                .unwrap(),
            &Object::string_literal("Seam note")
        );
        assert_eq!(
            target
                .get_dictionary(right[2].as_reference().unwrap())
                .unwrap()
                .get(b"IRT")
                .unwrap(),
            &right[0]
        );
    }
}

#[test]
fn saved_bookmark_anchor_uses_rotated_crop_coordinates() {
    for (rotation, expected) in [
        (0, (None, 260.0)),
        (90, (Some(160.0), 80.0)),
        (180, (None, 140.0)),
        (270, (Some(360.0), 320.0)),
    ] {
        let (mut document, page_id) = create_test_document();
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set("MediaBox", vec![0.into(), 0.into(), 600.into(), 800.into()]);
        page.set(
            "CropBox",
            vec![60.into(), 80.into(), 460.into(), 320.into()],
        );
        page.set("Rotate", rotation);
        let mut input = Vec::new();
        document.save_to(&mut input).unwrap();
        let mutations = read_native_mutations_bytes(
            br#"{"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":[{"title":"Anchor","pageIndex":0,"pageYRatio":0.25,"namedDest":null,"bold":false,"italic":false,"color":null,"items":[]}]}}"#,
        ).unwrap();
        let output =
            append_native_mutations_to_bytes(&input, &mutations, "D:20261011000000Z").unwrap();
        let loaded = Document::load_mem(&output.data).unwrap();
        let outlines = loaded
            .get_dictionary(
                loaded
                    .catalog()
                    .unwrap()
                    .get(b"Outlines")
                    .unwrap()
                    .as_reference()
                    .unwrap(),
            )
            .unwrap();
        let bookmark = loaded
            .get_dictionary(outlines.get(b"First").unwrap().as_reference().unwrap())
            .unwrap();
        let dest = bookmark.get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(dest[1].as_name().unwrap(), b"XYZ");
        match expected.0 {
            Some(left) => assert!(
                (f64::from(dest[2].as_float().unwrap()) - left).abs() < 0.01,
                "rotation {rotation}"
            ),
            None => assert!(dest[2].is_null()),
        }
        assert!(
            (f64::from(dest[3].as_float().unwrap()) - expected.1).abs() < 0.01,
            "rotation {rotation}"
        );
    }
}

#[test]
fn saved_resolved_named_bookmark_keeps_source_name() {
    let (mut document, page_id) = create_test_document();
    document.get_dictionary_mut(document.root_id().unwrap()).unwrap().set("Dests", dictionary! {"chapter" => vec![page_id.into(), Object::Name(b"FitH".to_vec()), Object::Null]});
    let mutations = read_native_mutations_bytes(&serde_json::to_vec(&serde_json::json!({"bookmarks":{
        "totalPages":1,"untitledLabel":"Untitled","items":[{"title":"Named","pageIndex":0,"pageYRatio":0.2,"namedDest":"chapter","items":[]}]
    }})).unwrap()).unwrap();
    let mut input = Vec::new(); document.save_to(&mut input).unwrap();
    let output = append_native_mutations_to_bytes(&input, &mutations, "D:20261012000000Z").unwrap();
    for saved in [Document::load_mem(&output.data).unwrap(), {
        set_bookmarks(&mut document, mutations.bookmarks.as_ref().unwrap()).unwrap(); document
    }] {
        let outlines = saved.get_dictionary(saved.catalog().unwrap().get(b"Outlines").unwrap().as_reference().unwrap()).unwrap();
        let bookmark = saved.get_dictionary(outlines.get(b"First").unwrap().as_reference().unwrap()).unwrap();
        assert_eq!(bookmark.get(b"Dest").unwrap().as_str().unwrap(), b"chapter");
    }
}

#[test]
fn saved_bookmark_refuses_a_page_dictionary_outside_the_page_tree() {
    let (mut document, page_id) = create_test_document();
    let orphan = document.add_object(document.get_dictionary(page_id).unwrap().clone());
    for name in [serde_json::Value::Null, serde_json::json!(""), serde_json::json!("  ")] {
    let mutations = read_native_mutations_bytes(&serde_json::to_vec(&serde_json::json!({"bookmarks":{
        "totalPages":1,"untitledLabel":"Untitled","items":[{"title":"Deleted","pageIndex":null,"namedDest":name,
        "originalDestination":{"sourceTarget":{"num":orphan.0,"gen":orphan.1},"kind":"Fit","coordinates":[]},"items":[]}]
    }})).unwrap()).unwrap();
    let mut input = Vec::new(); document.save_to(&mut input).unwrap();
    let error = append_native_mutations_to_bytes(&input, &mutations, "D:20261012000000Z").err().unwrap();
    assert!(error.to_string().contains("not in the current page tree"));
    assert!(set_bookmarks(&mut document, mutations.bookmarks.as_ref().unwrap()).is_err());
    }
}

#[test]
fn saved_bookmark_preserves_original_destination_before_lookup() {
    for (kind, coordinates) in [
        ("XYZ", serde_json::json!([null, null, null])), ("FitH", serde_json::json!([null])),
        ("FitR", serde_json::json!([100, 200, 500, 600])), ("Fit", serde_json::json!([])),
        ("FitV", serde_json::json!([null])), ("FitB", serde_json::json!([])),
        ("FitBH", serde_json::json!([25])), ("FitBV", serde_json::json!([null])),
    ] {
        let (mut document, page_id) = create_test_document();
        let mut input = Vec::new(); document.save_to(&mut input).unwrap();
        for source_target in [serde_json::json!({"num": page_id.0, "gen": page_id.1}), serde_json::json!(0)] {
            let mutations = read_native_mutations_bytes(&serde_json::to_vec(&serde_json::json!({"bookmarks":{
                "totalPages":1, "untitledLabel":"Untitled", "items":[{"title":"Renamed", "pageIndex":null, "namedDest":null,
                "originalDestination":{"sourceTarget":source_target,"kind":kind,"coordinates":coordinates},
                "bold":true,"italic":false,"color":null,"items":[]}]
            }})).unwrap()).unwrap();
            let output = append_native_mutations_to_bytes(&input, &mutations, "D:20261011000000Z").unwrap();
            let loaded = Document::load_mem(&output.data).unwrap();
            let outlines = loaded.get_dictionary(loaded.catalog().unwrap().get(b"Outlines").unwrap().as_reference().unwrap()).unwrap();
            let bookmark = loaded.get_dictionary(outlines.get(b"First").unwrap().as_reference().unwrap()).unwrap();
            let destination = bookmark.get(b"Dest").unwrap().as_array().unwrap();
            assert_eq!(destination[0].as_reference().unwrap(), page_id);
            assert_eq!(destination[1].as_name().unwrap(), kind.as_bytes());
            for (actual, expected) in destination.iter().skip(2).zip(coordinates.as_array().unwrap()) {
                if expected.is_null() {assert!(actual.is_null(), "{kind}");}
                else {assert_eq!(f64::from(actual.as_float().unwrap()), expected.as_f64().unwrap());}
            }
        }
    }
}

/// The review-b6zk projection fixture: explicit kinds, a name, and remote,
/// launch and URI actions, one of them behind a reference. A local name
/// `remote-chapter` must not capture the GoToR destination of the same name.
fn create_source_intent_outline() -> (Document, ObjectId) {
    let (mut document, page_id) = create_test_document();
    let uri_action = document.add_object(dictionary! {
        "S" => "URI",
        "URI" => Object::String(b"https://example.org/a?b=1".to_vec(), StringFormat::Hexadecimal),
    });
    let fit = |kind: &str| vec![page_id.into(), Object::Name(kind.as_bytes().to_vec())];
    let items = [
        ("Fit", dictionary! {"Dest" => fit("Fit")}),
        ("Named", dictionary! {"Dest" => Object::string_literal("chapter")}),
        ("GoTo", dictionary! {"A" => dictionary! {"S" => "GoTo", "D" => fit("FitB")}}),
        ("Remote", dictionary! {"A" => dictionary! {
            "S" => "GoToR",
            "F" => Object::string_literal("other.pdf"),
            "D" => Object::string_literal("remote-chapter"),
            "NewWindow" => true,
        }}),
        ("Launch", dictionary! {"A" => dictionary! {
            "S" => "Launch",
            "F" => Object::string_literal("tool.exe"),
            "Win" => dictionary! {"F" => Object::string_literal("tool.exe"), "P" => Object::string_literal("-x 1.5")},
        }}),
        ("Uri", dictionary! {"A" => uri_action}),
    ];
    let outlines_id = document.new_object_id();
    let ids = items.iter().map(|_| document.new_object_id()).collect::<Vec<_>>();
    for (index, (title, mut item)) in items.into_iter().enumerate() {
        item.set("Title", Object::string_literal(title));
        item.set("Parent", outlines_id);
        if let Some(next) = ids.get(index + 1) {
            item.set("Next", *next);
        }
        document.set_object(ids[index], item);
    }
    document.set_object(outlines_id, dictionary! {
        "Type" => "Outlines", "First" => ids[0], "Last" => *ids.last().unwrap(), "Count" => 6,
    });
    let catalog = document.get_dictionary_mut(document.root_id().unwrap()).unwrap();
    catalog.set("Outlines", outlines_id);
    catalog.set("Dests", dictionary! {"chapter" => fit("FitH"), "remote-chapter" => fit("Fit")});
    (document, page_id)
}

fn outline_targets(document: &Document) -> Vec<(String, Option<Object>, Option<Object>)> {
    let outlines = document.catalog().unwrap().get(b"Outlines").unwrap().as_reference().unwrap();
    let mut next = document.get_dictionary(outlines).unwrap().get(b"First").ok().cloned();
    let mut targets = Vec::new();
    while let Some(Ok(id)) = next.map(|value| value.as_reference()) {
        let item = document.get_dictionary(id).unwrap();
        let resolve = |key: &[u8]| item.get(key).ok().map(|value| document.dereference(value).unwrap().1.clone());
        let title = lopdf::decode_text_string(item.get(b"Title").unwrap()).unwrap();
        targets.push((title, resolve(b"Dest"), resolve(b"A")));
        next = item.get(b"Next").ok().cloned();
    }
    targets
}

#[test]
fn read_outline_keeps_source_names_and_actions_other_than_go_to() {
    let (document, _page_id) = create_source_intent_outline();
    let outline = read_pdf_outline(&document, true).unwrap();
    let summary = outline
        .iter()
        .map(|item| (item.title.as_str(), item.page_index, item.named_dest.as_deref(), item.original_action.is_some()))
        .collect::<Vec<_>>();
    assert_eq!(summary, [
        ("Fit", Some(0), None, false),
        ("Named", Some(0), Some("chapter"), false),
        ("GoTo", Some(0), None, false),
        ("Remote", None, None, true),
        ("Launch", None, None, true),
        ("Uri", None, None, true),
    ]);
    assert!(outline[1].original_destination.is_none(), "a kept name stays the target");
    let combined = read_pdf_combine_catalog(&document).unwrap().bookmarks;
    assert_eq!(combined[1].named_dest, None, "a combine resolves names it cannot carry");
    assert_eq!(combined[1].page_index, Some(0));
    assert_eq!(combined[3].original_action, outline[3].original_action);
}

#[test]
fn saved_outline_writes_untouched_actions_and_names_back_unchanged() {
    for append in [false, true] {
        let (mut document, _page_id) = create_source_intent_outline();
        let source = outline_targets(&document);
        let mut items = serde_json::to_value(read_pdf_outline(&document, true).unwrap()).unwrap();
        items[0]["title"] = "Fit renamed".into();
        let mutations = read_native_mutations_bytes(&serde_json::to_vec(&serde_json::json!({"bookmarks": {
            "totalPages": 1, "untitledLabel": "Untitled", "items": items,
        }})).unwrap()).unwrap();
        let saved = if append {
            let mut input = Vec::new();
            document.save_to(&mut input).unwrap();
            Document::load_mem(&append_native_mutations_to_bytes(&input, &mutations, "D:20261012000000Z").unwrap().data).unwrap()
        } else {
            set_bookmarks(&mut document, mutations.bookmarks.as_ref().unwrap()).unwrap();
            document
        };
        let mut expected = source;
        expected[0].0 = "Fit renamed".to_string();
        // The renamed item keeps its target, a name stays a name, and a GoTo
        // action is written as the destination it names.
        expected[2] = ("GoTo".to_string(), expected[2].2.as_ref().map(|action| action.as_dict().unwrap().get(b"D").unwrap().clone()), None);
        assert_eq!(outline_targets(&saved), expected, "append {append}");
    }
}

#[test]
fn read_outline_bounds_and_refuses_unrepresentable_actions() {
    let (mut document, page_id) = create_source_intent_outline();
    let first = document.get_dictionary(document.catalog().unwrap().get(b"Outlines").unwrap().as_reference().unwrap()).unwrap().get(b"First").unwrap().as_reference().unwrap();
    for action in [
        dictionary! {"S" => "GoToR", "F" => page_id},
        dictionary! {"S" => "URI", "URI" => Object::String(vec![b'a'; 20_000], StringFormat::Literal)},
        (0..20).fold(dictionary! {"S" => "Named"}, |inner, _| dictionary! {"S" => "Next", "Next" => inner}),
    ] {
        let item = document.get_dictionary_mut(first).unwrap();
        item.remove(b"Dest");
        item.set("A", action);
        let outline = read_pdf_outline(&document, true).unwrap();
        assert_eq!((outline[0].page_index, &outline[0].original_action), (None, &None));
    }
    let oversized = serde_json::json!({"dict": [["S", {"name": "URI"}], ["URI", {"literal": vec![97; 20_000]}]]});
    let error = read_native_mutations_bytes(&serde_json::to_vec(&serde_json::json!({"bookmarks": {
        "totalPages": 1, "untitledLabel": "Untitled", "items": [{"title": "Big", "pageIndex": null, "originalAction": oversized, "items": []}],
    }})).unwrap())
    .and_then(|mutations| set_bookmarks(&mut document, mutations.bookmarks.as_ref().unwrap()));
    assert!(error.unwrap_err().to_string().contains("size ceiling"));
}

#[test]
fn document_catalog_reads_each_part_whatever_happens_to_the_other() {
    let (mut document, _page_id) = create_source_intent_outline();
    let root_id = document.root_id().unwrap();
    let catalog = document.get_dictionary_mut(root_id).unwrap();
    catalog.set("PageLabels", dictionary! {"Nums" => Vec::<Object>::new()});
    let parts = serde_json::to_value(read_pdf_document_catalog(&document)).unwrap();
    assert_eq!(parts["bookmarks"].as_array().unwrap().len(), 6);
    assert!(parts["pageLabelsError"].is_string() && parts.get("pageLabels").is_none());
    assert!(read_pdf_combine_catalog(&document).is_err());

    let catalog = document.get_dictionary_mut(root_id).unwrap();
    catalog.set("PageLabels", dictionary! {"Nums" => vec![0.into(), dictionary! {"S" => "r"}.into()]});
    catalog.set("Outlines", Object::Integer(5));
    let parts = serde_json::to_value(read_pdf_document_catalog(&document)).unwrap();
    assert_eq!(parts["pageLabels"][0]["style"], "r");
    assert!(parts["bookmarksError"].is_string() && parts.get("bookmarks").is_none());
    assert!(read_pdf_combine_catalog(&document).is_err());
}

#[test]
fn dangling_destination_stays_local_to_its_entry() {
    let (mut document, _page_id) = create_source_intent_outline();
    let outlines = document.catalog().unwrap().get(b"Outlines").unwrap().as_reference().unwrap();
    let first = document.get_dictionary(outlines).unwrap().get(b"First").unwrap().as_reference().unwrap();
    let item = document.get_dictionary_mut(first).unwrap();
    item.set("Dest", Object::Reference((9999, 0)));
    let parts = serde_json::to_value(read_pdf_document_catalog(&document)).unwrap();
    let titles = parts["bookmarks"].as_array().unwrap().iter().map(|item| item["title"].as_str().unwrap()).collect::<Vec<_>>();
    assert_eq!(titles, ["Fit", "Named", "GoTo", "Remote", "Launch", "Uri"], "{parts}");
    assert!(parts["bookmarks"][0]["pageIndex"].is_null() && parts["bookmarks"][0].get("originalDestination").is_none());
    assert_eq!(parts["bookmarks"][1]["namedDest"], "chapter");
}
fn save_outline_entries(document: &mut Document, items: serde_json::Value, append: bool) -> Document {
    let mutations = read_native_mutations_bytes(&serde_json::to_vec(&serde_json::json!({"bookmarks": {
        "totalPages": 1, "untitledLabel": "Untitled", "items": items,
    }})).unwrap()).unwrap();
    if append {
        let mut input = Vec::new();
        document.save_to(&mut input).unwrap();
        Document::load_mem(&append_native_mutations_to_bytes(&input, &mutations, "D:20261012000000Z").unwrap().data).unwrap()
    } else {
        set_bookmarks(document, mutations.bookmarks.as_ref().unwrap()).unwrap();
        document.clone()
    }
}

#[test]
fn saved_unicode_named_destination_keeps_its_bytes() {
    for append in [false, true] {
        let (mut document, page_id) = create_test_document();
        let key = Object::String(encode_pdf_text_string("caf\u{e9}"), StringFormat::Hexadecimal);
        let outlines_id = document.new_object_id();
        let item = document.add_object(dictionary! {
            "Title" => Object::string_literal("Named"), "Parent" => outlines_id, "Dest" => key.clone(),
        });
        document.set_object(outlines_id, dictionary! {"Type" => "Outlines", "First" => item, "Last" => item, "Count" => 1});
        let catalog = document.get_dictionary_mut(document.root_id().unwrap()).unwrap();
        catalog.set("Outlines", outlines_id);
        catalog.set("Names", dictionary! {"Dests" => dictionary! {
            "Names" => vec![key.clone(), vec![page_id.into(), Object::Name(b"FitH".to_vec()), Object::Null].into()],
        }});
        let mut items = serde_json::to_value(read_pdf_outline(&document, true).unwrap()).unwrap();
        assert_eq!(items[0]["namedDest"], "caf\u{e9}");
        items[0]["title"] = "Named renamed".into();
        items.as_array_mut().unwrap().push(serde_json::json!({"title": "Typed", "pageIndex": null, "namedDest": "na\u{ef}ve", "items": []}));
        let saved = save_outline_entries(&mut document, items, append);
        let targets = outline_targets(&saved);
        assert_eq!(targets[0].1, Some(key), "append {append}");
        assert_eq!(targets[1].1, Some(Object::String(encode_pdf_text_string("na\u{ef}ve"), StringFormat::Hexadecimal)));
    }
}

