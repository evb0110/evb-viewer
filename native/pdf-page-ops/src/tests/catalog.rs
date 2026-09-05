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

        apply_native_mutations(&mut document, &NativeMutationsFile::default(), "D:20260609123456Z").unwrap();

        let after = catalog(&document);
        assert_eq!(after.get(b"PageLabels").unwrap(), before.get(b"PageLabels").unwrap());
        assert_eq!(after.get(b"Outlines").unwrap(), before.get(b"Outlines").unwrap());
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
        let root_id = document.trailer.get(b"Root").unwrap().as_reference().unwrap();
        document
            .get_dictionary_mut(root_id)
            .unwrap()
            .set("Outlines", Object::Reference(outlines_id));

        let catalog = read_pdf_combine_catalog(&document).unwrap();
        assert_eq!(catalog.bookmarks.len(), 1);
        assert!(catalog.bookmarks[0].items.is_empty());
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
        document
            .get_dictionary_mut(first_group_id)
            .unwrap()
            .set(
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
        apply_shape_annotations(&mut document, &shape_mutation, "D:20260609123456Z", &mut None).unwrap();

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
        apply_shape_annotations(&mut document, &shape_mutation, "D:20260609123456Z", &mut None).unwrap();
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
                },
                TextLayerInstruction {
                    source_page_index: 1,
                    output_page_index: 1,
                    matrix: [1.0, 0.0, 0.0, 1.0, 20.0, 0.0],
                    filter_to_output_page: false,
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
