    fn create_test_document() -> (Document, ObjectId) {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        (document, page_id)
    }

    /// Small metadata fixture shared by page-operation regression tests.
    fn create_outline_fixture() -> (Document, ObjectId) {
        let (mut document, page_id) = create_test_document();
        set_page_labels(
            &mut document,
            &PageLabelsMutation {
                total_pages: 1,
                ranges: vec![PageLabelRange {
                    start_page: 1,
                    style: Some("r".to_string()),
                    prefix: "intro-".to_string(),
                    start_number: 1,
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
                    title: "Parent".to_string(),
                    page_index: Some(0),
                    page_y_ratio: None,
                    named_dest: None,
                    bold: false,
                    italic: false,
                    color: None,
                    items: vec![BookmarkEntry {
                        title: "Child".to_string(),
                        page_index: Some(0),
                        page_y_ratio: None,
                        named_dest: None,
                        bold: false,
                        italic: false,
                        color: None,
                        items: Vec::new(),
                    }],
                }],
            },
        )
        .unwrap();
        (document, page_id)
    }

    fn crop_box(document: &Document, page_id: ObjectId) -> Vec<f64> {
        document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"CropBox")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_float().unwrap() as f64)
            .collect()
    }

    fn string_bytes(document: &Document, object_id: ObjectId, key: &[u8]) -> Vec<u8> {
        document
            .get_dictionary(object_id)
            .unwrap()
            .get(key)
            .unwrap()
            .as_str()
            .unwrap()
            .to_vec()
    }

    fn catalog(document: &Document) -> &Dictionary {
        document
            .get_dictionary(document.root_id().unwrap())
            .unwrap()
    }

    fn temp_pdf_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("evb-pdf-page-ops-{label}-{unique}.pdf"))
    }

    fn create_test_note_pdf() -> (Document, ObjectId, ObjectId) {
        let (mut document, page_id) = create_test_document();
        let popup_id = document.add_object(dictionary! {
            "Subtype" => "Popup",
            "Contents" => Object::string_literal("old popup"),
        });
        let target_id = document.add_object(dictionary! {
            "Subtype" => "FreeText",
            "Contents" => Object::string_literal("old target"),
            "Popup" => popup_id,
        });
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(target_id)]);

        (document, target_id, popup_id)
    }

    fn assert_approximately(left: f64, right: f64) {
        assert!(
            (left - right).abs() < 0.01,
            "expected {left} to be approximately {right}"
        );
    }

    fn rectangle_shape(stable_key: &str, color: &str) -> ShapeAnnotation {
        ShapeAnnotation {
            author: None,
            shape_type: "rectangle".to_string(),
            page_index: 0,
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.2,
            x2: None,
            y2: None,
            color: color.to_string(),
            fill_color: Some("#abcdef".to_string()),
            opacity: 0.5,
            stroke_width: 3.0,
            points: Vec::new(),
            strokes: Vec::new(),
            annotation_id: None,
            stable_key: Some(stable_key.to_string()),
            pdf_subtype: None,
            line_start_style: None,
            line_end_style: None,
            created_at: Some(1_780_000_000_000),
            modified_at: Some(1_780_000_060_000),
        }
    }

    fn ink_shape(stable_key: &str, color: &str) -> ShapeAnnotation {
        let points = vec![
            ShapePoint {x: 0.1, y: 0.7},
            ShapePoint {x: 0.2, y: 0.65},
            ShapePoint {x: 0.3, y: 0.72},
        ];
        ShapeAnnotation {
            author: None,
            shape_type: "polyline".to_string(),
            page_index: 0,
            x: 0.1,
            y: 0.65,
            width: 0.2,
            height: 0.07,
            x2: None,
            y2: None,
            color: color.to_string(),
            fill_color: None,
            opacity: 0.65,
            stroke_width: 2.5,
            points: points.clone(),
            strokes: vec![points],
            annotation_id: None,
            stable_key: Some(stable_key.to_string()),
            pdf_subtype: Some("Ink".to_string()),
            line_start_style: None,
            line_end_style: None,
            created_at: Some(1_780_000_000_000),
            modified_at: Some(1_780_000_060_000),
        }
    }

    fn create_test_markup_pdf(subtype: &str) -> (Document, ObjectId, ObjectId) {
        let (mut document, page_id) = create_test_document();
        let annot_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => subtype,
            "Rect" => vec![20.into(), 20.into(), 100.into(), 50.into()],
            "C" => vec![1.into(), 1.into(), 0.into()],
        });
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(annot_id)]);
        (document, page_id, annot_id)
    }
