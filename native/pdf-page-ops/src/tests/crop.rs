fn crop_pages(document: &mut Document, pages: &[u32], margins: CropMargins) -> Result<()> {
    let source = save_document_to_bytes(document)?;
    let result = crop_browser_pdf_bytes(&source, pages, margins)?;
    *document = Document::load_mem(&result.data)?;
    Ok(())
}

fn remove_crop_from_pages(document: &mut Document, pages: &[u32]) -> Result<()> {
    let source = save_document_to_bytes(document)?;
    let result = remove_crop_browser_pdf_bytes(&source, pages)?;
    *document = Document::load_mem(&result.data)?;
    Ok(())
}

#[test]
fn crops_pages_using_inherited_media_box() {
    let (mut document, page_id) = create_test_document();

    crop_pages(
        &mut document,
        &[1],
        CropMargins {
            physical: false,
            top: 4.0,
            bottom: 3.0,
            left: 2.0,
            right: 1.0,
        },
    )
    .unwrap();

    assert_eq!(crop_box(&document, page_id), vec![2.0, 3.0, 199.0, 96.0]);
}

#[test]
fn reversed_and_inherited_crop_boxes_preserve_visible_geometry_and_saved_crop() {
    for inherited in [false, true] {
        for corners in [
            [20.0_f32, 10.0, 180.0, 90.0],
            [180.0, 90.0, 20.0, 10.0],
            [180.0, 10.0, 20.0, 90.0],
            [20.0, 90.0, 180.0, 10.0],
        ] {
            let (mut document, page_id) = create_test_document();
            let parent_id = document
                .get_dictionary(page_id)
                .unwrap()
                .get(b"Parent")
                .unwrap()
                .as_reference()
                .unwrap();
            document
                .get_dictionary_mut(if inherited { parent_id } else { page_id })
                .unwrap()
                .set("CropBox", corners.map(Object::Real).to_vec());
            let geometry = get_page_geometry(&document, 1).unwrap();
            let visible = geometry.crop_box.expect("valid CropBox must remain visible");
            assert_eq!([visible.x1, visible.y1, visible.x2, visible.y2], [20.0, 10.0, 180.0, 90.0]);

            // The renderer selects the middle of the visible CropBox; the
            // mutation protocol expresses that selection as MediaBox margins.
            let margins = CropMargins {
            physical: false,
                top: geometry.media_box.y2 - (visible.y1 + visible.height() * 0.75),
                bottom: visible.y1 + visible.height() * 0.25 - geometry.media_box.y1,
                left: visible.x1 + visible.width() * 0.375 - geometry.media_box.x1,
                right: geometry.media_box.x2 - (visible.x1 + visible.width() * 0.75),
            };
            let mut original_bytes = Vec::new();
            document.save_to(&mut original_bytes).unwrap();
            let mut incremental = IncrementalDocument::from_document(
                Document::load_mem(&original_bytes).unwrap(),
                original_bytes.len() as u64,
                original_bytes.last().copied(),
            );
            crop_pages(&mut document, &[1], margins).unwrap();
            crop_pages_incremental(&mut incremental, &[1], margins).unwrap();
            assert_eq!(crop_box(&document, page_id), [80.0, 30.0, 140.0, 70.0]);
            assert_eq!(crop_box(&incremental.new_document, page_id), [80.0, 30.0, 140.0, 70.0]);
            let mut rewritten_bytes = Vec::new();
            document.save_to(&mut rewritten_bytes).unwrap();
            let revision = build_incremental_revision(&mut incremental).unwrap();
            original_bytes.extend(revision);
            for bytes in [rewritten_bytes, original_bytes] {
                let saved = Document::load_mem(&bytes).unwrap();
                assert_eq!(crop_box(&saved, page_id), [80.0, 30.0, 140.0, 70.0]);
                let visible = get_page_geometry(&saved, 1).unwrap().crop_box.unwrap();
                assert_eq!([visible.width(), visible.height()], [60.0, 40.0]);
            }
        }
    }
}

#[test]
fn page_boxes_still_reject_zero_area_and_nonfinite_corners() {
    for corners in [
        [20.0_f32, 10.0, 20.0, 90.0],
        [20.0, 10.0, 180.0, 10.0],
        [f32::NAN, 10.0, 180.0, 90.0],
        [20.0, 10.0, f32::INFINITY, 90.0],
        [20.0, f32::NEG_INFINITY, 180.0, 90.0],
    ] {
        let (mut document, page_id) = create_test_document();
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("CropBox", corners.map(Object::Real).to_vec());
        assert!(resolve_inherited_box(&document, page_id, b"CropBox").is_err());
        // Invalid optional CropBoxes retain the established MediaBox fallback.
        assert!(get_page_geometry(&document, 1).unwrap().crop_box.is_none());
    }
}

#[test]
fn annotation_rectangles_keep_strict_corner_validation() {
    let ascending = Object::Array([20.0_f32, 10.0, 180.0, 90.0].map(Object::Real).to_vec());
    let rect = parse_rect(&ascending).unwrap();
    assert_eq!([rect.x1, rect.y1, rect.x2, rect.y2], [20.0, 10.0, 180.0, 90.0]);
    for corners in [
        [180.0_f32, 90.0, 20.0, 10.0],
        [180.0, 10.0, 20.0, 90.0],
        [20.0, 90.0, 180.0, 10.0],
        [20.0, 10.0, 20.0, 90.0],
        [20.0, 10.0, 180.0, 10.0],
        [f32::NAN, 10.0, 180.0, 90.0],
        [20.0, 10.0, f32::INFINITY, 90.0],
    ] {
        assert!(parse_rect(&Object::Array(corners.map(Object::Real).to_vec())).is_err());
    }
}

#[test]
fn reversed_and_inherited_media_boxes_preserve_visible_geometry_and_saved_crop() {
    for inherited in [false, true] {
        for corners in [
            [20.0_f32, 10.0, 180.0, 90.0],
            [180.0, 90.0, 20.0, 10.0],
            [180.0, 10.0, 20.0, 90.0],
            [20.0, 90.0, 180.0, 10.0],
        ] {
            let (mut document, page_id) = create_test_document();
            let parent_id = document
                .get_dictionary(page_id)
                .unwrap()
                .get(b"Parent")
                .unwrap()
                .as_reference()
                .unwrap();
            document.get_dictionary_mut(page_id).unwrap().remove(b"MediaBox");
            document
                .get_dictionary_mut(if inherited { parent_id } else { page_id })
                .unwrap()
                .set("MediaBox", corners.map(Object::Real).to_vec());
            let geometry = get_page_geometry(&document, 1).unwrap();
            let media = geometry.media_box;
            assert_eq!([media.x1, media.y1, media.x2, media.y2], [20.0, 10.0, 180.0, 90.0]);
            assert!(geometry.crop_box.is_none());
            let margins = CropMargins {
            physical: false, top: 4.0, bottom: 3.0, left: 2.0, right: 1.0 };
            let mut original_bytes = Vec::new();
            document.save_to(&mut original_bytes).unwrap();
            let mut incremental = IncrementalDocument::from_document(
                Document::load_mem(&original_bytes).unwrap(),
                original_bytes.len() as u64,
                original_bytes.last().copied(),
            );
            crop_pages(&mut document, &[1], margins).unwrap();
            crop_pages_incremental(&mut incremental, &[1], margins).unwrap();
            let mut rewritten_bytes = Vec::new();
            document.save_to(&mut rewritten_bytes).unwrap();
            original_bytes.extend(build_incremental_revision(&mut incremental).unwrap());
            for bytes in [rewritten_bytes, original_bytes] {
                let saved = Document::load_mem(&bytes).unwrap();
                assert_eq!(crop_box(&saved, page_id), [22.0, 13.0, 179.0, 86.0]);
                let visible = get_page_geometry(&saved, 1).unwrap().crop_box.unwrap();
                assert_eq!([visible.width(), visible.height()], [157.0, 73.0]);
            }
        }
    }
}

#[test]
fn page_box_validation_covers_both_keys_inheritance_and_every_nonfinite_coordinate() {
    let mut invalid = vec![
        vec![Object::Integer(0); 3],
        vec![Object::Integer(0); 5],
        vec![Object::Null; 4],
        [20.0_f32, 10.0, 20.0, 90.0].map(Object::Real).to_vec(),
        [20.0_f32, 10.0, 180.0, 10.0].map(Object::Real).to_vec(),
    ];
    for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        for coordinate in 0..4 {
            let mut corners = [20.0_f32, 10.0, 180.0, 90.0];
            corners[coordinate] = value;
            invalid.push(corners.map(Object::Real).to_vec());
        }
    }
    for key in [b"CropBox".as_slice(), b"MediaBox"] {
        for inherited in [false, true] {
            for corners in &invalid {
                let (mut document, page_id) = create_test_document();
                let parent_id = document.get_dictionary(page_id).unwrap()
                    .get(b"Parent").unwrap().as_reference().unwrap();
                document.get_dictionary_mut(page_id).unwrap().remove(key);
                document.get_dictionary_mut(if inherited { parent_id } else { page_id })
                    .unwrap().set(key, corners.clone());
                assert!(resolve_inherited_box(&document, page_id, key).is_err());
                if key == b"CropBox" {
                    assert!(get_page_geometry(&document, 1).unwrap().crop_box.is_none());
                } else {
                    assert!(get_page_geometry(&document, 1).is_err());
                }
            }
        }
    }
}

#[test]
fn finite_pdf_number_extremes_keep_finite_rectangle_extents() {
    let object = Object::Array(
        [f32::MIN, f32::MIN, f32::MAX, f32::MAX].map(Object::Real).to_vec(),
    );
    let rect = parse_rect(&object).unwrap();
    assert!(rect.width().is_finite() && rect.height().is_finite());
    let (mut document, page_id) = create_test_document();
    document.get_dictionary_mut(page_id).unwrap().set("MediaBox", object);
    let media = resolve_inherited_box(&document, page_id, b"MediaBox").unwrap();
    assert_eq!([media.width(), media.height()], [rect.width(), rect.height()]);
}

#[test]
fn path_crop_and_remove_crop_append_page_dictionary_revisions() {
    let pdf = temp_pdf_path("path-crop");
    let pages_file = temp_pdf_path("path-crop-pages");
    let (mut document, page_id) = create_test_document();
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Rotate", 180);
    document
        .save(&pdf)
        .expect("test PDF should be serializable");
    std::fs::write(&pages_file, b"1\n").unwrap();

    mutate_pdf(Config {
        operation: Operation::Crop {
            pages_file: pages_file.clone(),
            margins: CropMargins {
            physical: false,
                top: 4.1,
                bottom: 3.2,
                left: 2.3,
                right: 1.4,
            },
        },
        input_path: pdf.clone(),
        output_path: Some(pdf.clone()),
        qpdf_path: None,
    })
    .expect("path crop should append a revision");

    let cropped = Document::load(&pdf).unwrap();
    let cropped_page = cropped.get_dictionary(page_id).unwrap();
    assert_eq!(crop_box(&cropped, page_id), [2.3_f32, 3.2, 198.6, 95.9].map(f64::from).to_vec());
    assert_eq!(cropped_page.get(b"Rotate").unwrap().as_i64().unwrap(), 180);

    mutate_pdf(Config {
        operation: Operation::RemoveCrop {
            pages_file: pages_file.clone(),
        },
        input_path: pdf.clone(),
        output_path: Some(pdf.clone()),
        qpdf_path: None,
    })
    .expect("path crop removal should append a revision");

    let restored = Document::load(&pdf).unwrap();
    let restored_page = restored.get_dictionary(page_id).unwrap();
    assert_eq!(crop_box(&restored, page_id), vec![0.0, 0.0, 200.0, 100.0]);
    assert_eq!(restored_page.get(b"Rotate").unwrap().as_i64().unwrap(), 180);

    std::fs::remove_file(pdf).unwrap();
    std::fs::remove_file(pages_file).unwrap();
}

#[test]
fn page_geometry_writes_json() {
    let pdf = temp_pdf_path("page-geometry-input");
    let (mut document, page_id) = create_test_document();
    document.get_dictionary_mut(page_id).unwrap().set("UserUnit", 2);
    document.save(&pdf).unwrap();

    let mut output = Vec::new();
    write_page_geometry(&pdf, 1, &mut output).unwrap();

    let geometry: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(geometry["mediaBox"]["x"], 0.0);
    assert_eq!(geometry["mediaBox"]["y"], 0.0);
    assert_eq!(geometry["mediaBox"]["width"], 200.0);
    assert_eq!(geometry["mediaBox"]["height"], 100.0);
    assert_eq!(geometry["cropBox"], serde_json::Value::Null);
    assert_eq!(geometry["rotation"], 0);
    assert_eq!(geometry["userUnit"], 2.0);

    remove_file(pdf).unwrap();
}

#[test]
fn cli_crops_a_physical_inch_on_a_user_unit_two_page() {
    let pdf = temp_pdf_path("physical-crop");
    let pages = temp_pdf_path("physical-crop-pages");
    let (mut document, page_id) = create_test_document();
    document.get_dictionary_mut(page_id).unwrap().set("UserUnit", 2);
    document.save(&pdf).unwrap();
    std::fs::write(&pages, b"1\n").unwrap();
    run_cli_entry(vec![
        "crop".into(), "--input".into(), pdf.to_string_lossy().into_owned(),
        "--output".into(), pdf.to_string_lossy().into_owned(),
        "--pages-file".into(), pages.to_string_lossy().into_owned(),
        "--physical".into(), "--left".into(), "72".into(),
        "--top".into(), "0".into(), "--bottom".into(), "0".into(),
        "--right".into(), "0".into(),
    ]).unwrap();
    let reopened = Document::load(&pdf).unwrap();
    assert_eq!(crop_box(&reopened, page_id), vec![36.0, 0.0, 200.0, 100.0]);
    let geometry = get_page_geometry(&reopened, 1).unwrap();
    assert_eq!(geometry.user_unit, 2.0);
    assert_eq!(geometry.crop_box.unwrap().x1 * geometry.user_unit / 72.0, 1.0);
    remove_file(pdf).unwrap();
    remove_file(pages).unwrap();
}

#[test]
fn resolves_high_index_geometry_without_a_dense_page_map() {
    let (document, _first_page_id, last_page_id) = create_sparse_million_page_document();
    let source = NoDensePageIds(&document);

    reset_page_tree_node_read_count();
    let geometry = get_page_geometry(&source, 1_000_000).unwrap();

    assert_eq!(geometry.media_box.width(), 200.0);
    assert_eq!(geometry.media_box.height(), 100.0);
    assert_eq!(geometry.rotation, 0);
    assert!(page_tree_node_read_count() < 100);
    assert_eq!(
        PageTreeResolver::new(&source)
            .unwrap()
            .page_id(&source, 1_000_000)
            .unwrap(),
        last_page_id
    );
}

#[test]
fn crops_high_index_page_without_walking_the_page_tree() {
    let (document, _first_page_id, last_page_id) = create_sparse_million_page_document();
    let mut incremental = IncrementalDocument::from_document(document, 0, None);

    reset_page_tree_node_read_count();
    crop_pages_incremental(
        &mut incremental,
        &[1_000_000],
        CropMargins {
            physical: false,
            top: 4.0,
            bottom: 3.0,
            left: 2.0,
            right: 1.0,
        },
    )
    .unwrap();

    assert!(page_tree_node_read_count() < 100);
    assert_eq!(
        crop_box(&incremental.new_document, last_page_id),
        vec![2.0, 3.0, 199.0, 96.0]
    );
}

#[test]
fn remove_crop_preflights_every_selected_page_before_mutating_any_page() {
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let first_page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    let second_page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
    });
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(first_page_id), Object::Reference(second_page_id)],
            "Count" => 2,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);
    let mut incremental = IncrementalDocument::from_document(document, 0, None);

    let error = remove_crop_from_pages_incremental(&mut incremental, &[1, 2])
        .expect_err("a missing second-page media box must reject the operation");

    assert!(error.to_string().contains("Missing inherited MediaBox"));
    assert!(!incremental.new_document.has_object(first_page_id));
    assert!(!incremental.new_document.has_object(second_page_id));
}

#[test]
fn crop_postcondition_failure_does_not_publish_staged_output() {
    let input = temp_pdf_path("crop-postcondition-input");
    let output = temp_pdf_path("crop-postcondition-output");
    let (mut document, page_id) = create_test_document();
    document.save(&input).unwrap();
    write(&output, b"keep this output").unwrap();

    let mut incremental = IncrementalDocument::load(&input).unwrap();
    crop_pages_incremental(
        &mut incremental,
        &[1],
        CropMargins {
            physical: false,
            top: 4.0,
            bottom: 3.0,
            left: 2.0,
            right: 1.0,
        },
    )
    .unwrap();
    set_page_crop_box_on_dictionary(
        incremental
            .new_document
            .get_dictionary_mut(page_id)
            .unwrap(),
        PdfRect {
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        },
    );

    let error = append_incremental_page_revision(
        &input,
        &output,
        &mut incremental,
        &[1],
        CropRevisionExpectation::Margins(CropMargins {
            physical: false,
            top: 4.0,
            bottom: 3.0,
            left: 2.0,
            right: 1.0,
        }),
    )
    .expect_err("invalid crop postconditions must prevent publication");

    assert!(error
        .to_string()
        .contains("Crop postcondition failed for page 1"));
    assert_eq!(read(&output).unwrap(), b"keep this output");
    remove_file(input).unwrap();
    remove_file(output).unwrap();
}

/// A one-page PDF whose objects sit before a sparse gap that stands in for
/// page images, with its cross-reference table past the old eager ceiling.
/// `suffix` follows the startxref value and `trailing` the terminal %%EOF.
#[cfg(unix)]
fn write_large_sparse_pdf(pdf: &Path, suffix: &str, trailing: &[u8]) {
    use std::{
        fs::File,
        io::{Seek, SeekFrom, Write},
    };
    const LARGE_SOURCE_OFFSET: u64 = 512 * 1024 * 1024 + 1024;
    let mut source = File::create(pdf).unwrap();
    source.write_all(b"%PDF-1.4\n").unwrap();
    let mut offsets = Vec::new();
    for object in [
        "1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
        "2 0 obj\n<</Type/Pages/Count 1/Kids[3 0 R]/MediaBox[0 0 200 100]>>\nendobj\n",
        "3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/CustomKey/keep>>\nendobj\n",
    ] {
        offsets.push(source.stream_position().unwrap());
        source.write_all(object.as_bytes()).unwrap();
    }
    source.seek(SeekFrom::Start(LARGE_SOURCE_OFFSET)).unwrap();
    source.write_all(b"xref\n0 4\n0000000000 65535 f \n").unwrap();
    for offset in offsets {
        writeln!(source, "{offset:010} 00000 n ").unwrap();
    }
    source
        .write_all(b"trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n")
        .unwrap();
    writeln!(source, "{LARGE_SOURCE_OFFSET}{suffix}").unwrap();
    source.write_all(b"%%EOF\n").unwrap();
    source.write_all(trailing).unwrap();
    source.sync_all().unwrap();
    assert!(source.metadata().unwrap().len() > MAX_ENCODED_PDF_BYTES as u64);
}

#[cfg(unix)]
#[test]
fn a_large_base_whose_startxref_value_is_not_an_integer_takes_no_append() {
    let pdf = temp_pdf_path("large-startxref-suffix");
    let pages_file = temp_pdf_path("large-startxref-suffix-pages");
    write_large_sparse_pdf(&pdf, "x", b"");
    std::fs::write(&pages_file, b"1\n").unwrap();
    let len = std::fs::metadata(&pdf).unwrap().len();
    assert!(matches!(
        append_admission(&pdf, None).unwrap(),
        AppendAdmission::Repairable(_)
    ));
    let error = mutate_pdf(Config {
        operation: Operation::RemoveCrop {
            pages_file: pages_file.clone(),
        },
        input_path: pdf.clone(),
        output_path: Some(pdf.clone()),
        qpdf_path: None,
    })
    .unwrap_err();
    assert_eq!(
        error.downcast_ref::<NativeError>().unwrap().code,
        NativeErrorCode::CorruptXref
    );
    assert_eq!(std::fs::metadata(&pdf).unwrap().len(), len);
    std::fs::remove_file(pdf).unwrap();
    std::fs::remove_file(pages_file).unwrap();
}

#[cfg(unix)]
#[test]
fn large_path_crop_and_remove_crop_read_the_source_by_index() {
    use std::{
        fs::File,
        io::{Read, Seek, SeekFrom, Write},
    };

    let pdf = temp_pdf_path("large-path-crop");
    let pages_file = temp_pdf_path("large-path-crop-pages");
    // 600 NUL bytes follow the terminal %%EOF, as qpdf reads without recovery.
    write_large_sparse_pdf(&pdf, "", &[0; 600]);

    let mut geometry = Vec::new();
    write_page_geometry(&pdf, 1, &mut geometry).expect("large path geometry reads by index");
    let geometry: serde_json::Value = serde_json::from_slice(&geometry).unwrap();
    assert_eq!(geometry["mediaBox"]["width"], 200.0);
    assert_eq!(geometry["mediaBox"]["height"], 100.0);
    for metadata_only in [true, false] {
        let sizes = temp_pdf_path("large-path-crop-sizes");
        write_page_sizes_path(&pdf, &sizes, metadata_only).expect("large path sizes read by index");
        let lines = std::fs::read_to_string(&sizes).unwrap();
        std::fs::remove_file(&sizes).unwrap();
        let chunk: serde_json::Value =
            serde_json::from_str(lines.lines().nth(1).unwrap()).unwrap();
        let page = &chunk["pages"][0];
        assert_eq!(page["widthPoints"], 200.0, "{lines}");
        assert_eq!(page["heightPoints"], 100.0, "{lines}");
    }

    std::fs::write(&pages_file, b"1\n").unwrap();
    let original_len = std::fs::metadata(&pdf).unwrap().len();
    mutate_pdf(Config {
        operation: Operation::Crop {
            pages_file: pages_file.clone(),
            margins: CropMargins {
            physical: false,
                top: 4.0,
                bottom: 3.0,
                left: 2.0,
                right: 1.0,
            },
        },
        input_path: pdf.clone(),
        output_path: Some(pdf.clone()),
        qpdf_path: None,
    })
    .expect("large path crop should read the source by index");

    let after_crop_len = std::fs::metadata(&pdf).unwrap().len();
    let mut appended = Vec::new();
    let mut output = File::open(&pdf).unwrap();
    output.seek(SeekFrom::Start(original_len)).unwrap();
    output.read_to_end(&mut appended).unwrap();
    assert!(after_crop_len > original_len);
    let appended_text = String::from_utf8_lossy(&appended);
    assert!(appended_text.contains("/CropBox"));
    assert!(appended_text.contains("2 3 199 96"));
    assert!(appended_text.contains("/CustomKey/keep"));

    mutate_pdf(Config {
        operation: Operation::RemoveCrop {
            pages_file: pages_file.clone(),
        },
        input_path: pdf.clone(),
        output_path: Some(pdf.clone()),
        qpdf_path: None,
    })
    .expect("large path crop removal should read the source by index");

    let mut appended_removal = Vec::new();
    let mut output = File::open(&pdf).unwrap();
    output.seek(SeekFrom::Start(after_crop_len)).unwrap();
    output.read_to_end(&mut appended_removal).unwrap();
    let appended_removal_text = String::from_utf8_lossy(&appended_removal);
    assert!(appended_removal_text.contains("/CropBox"));
    assert!(appended_removal_text.contains("0 0 200 100"));
    assert!(appended_removal_text.contains("/CustomKey/keep"));

    // Junk past qpdf's startxref window leaves no revision both read: no append.
    let mut junk = std::fs::OpenOptions::new().write(true).open(&pdf).unwrap();
    junk.seek(SeekFrom::End(0)).unwrap();
    junk.write_all(&[b'x'; 4096]).unwrap();
    drop(junk);
    let error = mutate_pdf(Config {
        operation: Operation::RemoveCrop {
            pages_file: pages_file.clone(),
        },
        input_path: pdf.clone(),
        output_path: Some(pdf.clone()),
        qpdf_path: None,
    })
    .unwrap_err();
    assert_eq!(
        error.downcast_ref::<NativeError>().unwrap().code,
        NativeErrorCode::CorruptXref
    );

    std::fs::remove_file(pdf).unwrap();
    std::fs::remove_file(pages_file).unwrap();
}

#[test]
fn remove_crop_restores_media_box() {
    let (mut document, page_id) = create_test_document();

    crop_pages(
        &mut document,
        &[1],
        CropMargins {
            physical: false,
            top: 4.0,
            bottom: 3.0,
            left: 2.0,
            right: 1.0,
        },
    )
    .unwrap();
    remove_crop_from_pages(&mut document, &[1]).unwrap();

    assert_eq!(crop_box(&document, page_id), vec![0.0, 0.0, 200.0, 100.0]);
}

#[test]
fn rejects_crop_when_margins_consume_page() {
    let (mut document, page_id) = create_test_document();

    let error = crop_pages(
        &mut document,
        &[1],
        CropMargins {
            physical: false,
            top: 100.0,
            bottom: 0.0,
            left: 0.0,
            right: 0.0,
        },
    )
    .expect_err("consuming margins must reject the whole operation");

    assert!(error.to_string().contains("consume page 1"));
    assert!(document
        .get_dictionary(page_id)
        .unwrap()
        .get(b"CropBox")
        .is_err());
}

#[test]
fn preflights_every_selected_page_before_mutating_any_page() {
    let mut document = Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let first_page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
    let second_page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 20.into(), 20.into()],
    });
    document.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(first_page_id), Object::Reference(second_page_id)],
            "Count" => 2,
        },
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);

    let error = crop_pages(
        &mut document,
        &[1, 2],
        CropMargins {
            physical: false,
            top: 11.0,
            bottom: 10.0,
            left: 1.0,
            right: 1.0,
        },
    )
    .expect_err("second-page preflight must reject the whole operation");

    assert!(error.to_string().contains("consume page 2"));
    assert!(document
        .get_dictionary(first_page_id)
        .unwrap()
        .get(b"CropBox")
        .is_err());
    assert!(document
        .get_dictionary(second_page_id)
        .unwrap()
        .get(b"CropBox")
        .is_err());
}

#[test]
fn rejects_non_finite_or_negative_margins_before_mutation() {
    for invalid_margin in [f64::NAN, f64::INFINITY, -1.0] {
        let (mut document, page_id) = create_test_document();
        let error = crop_pages(
            &mut document,
            &[1],
            CropMargins {
            physical: false,
                top: invalid_margin,
                bottom: 0.0,
                left: 0.0,
                right: 0.0,
            },
        )
        .expect_err("invalid margin must fail");

        assert!(error.to_string().contains("Invalid top crop margin"));
        assert!(document
            .get_dictionary(page_id)
            .unwrap()
            .get(b"CropBox")
            .is_err());
    }
}

/// Width each form draws at on the printed sheet: the sheet's `cm` scale times
/// the form's own /Matrix, times its /BBox width.
fn printed_form_widths(document: &Document) -> Vec<f64> {
    let page_id = *document.get_pages().values().next().unwrap();
    let page = document.get_dictionary(page_id).unwrap();
    let xobjects = page
        .get(b"Resources")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"XObject")
        .unwrap()
        .as_dict()
        .unwrap();
    let contents = page.get(b"Contents").unwrap().as_reference().unwrap();
    let content = document
        .get_object(contents)
        .unwrap()
        .as_stream()
        .unwrap()
        .decompressed_content()
        .unwrap();
    let tokens = String::from_utf8(content).unwrap();
    let tokens = tokens.split_whitespace().collect::<Vec<_>>();
    let number = |token: &str| token.parse::<f64>().unwrap();
    let mut widths = Vec::new();
    for index in tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| **token == "cm")
        .map(|(index, _)| index)
    {
        let placement = number(tokens[index - 6]);
        let name = tokens[index + 1].trim_start_matches('/').as_bytes();
        let form = document
            .get_object(xobjects.get(name).unwrap().as_reference().unwrap())
            .unwrap()
            .as_stream()
            .unwrap();
        let matrix = form.dict.get(b"Matrix").unwrap().as_array().unwrap();
        let bbox = form.dict.get(b"BBox").unwrap().as_array().unwrap();
        let [x1, _, x2, _] = [0, 1, 2, 3].map(|slot| {
            number_value(document, &bbox[slot])
        });
        widths.push(placement * number_value(document, &matrix[0]) * (x2 - x1));
    }
    widths
}

fn number_value(document: &Document, object: &Object) -> f64 {
    let object = document.dereference(object).unwrap().1;
    match object {
        Object::Integer(value) => *value as f64,
        Object::Real(value) => f64::from(*value),
        _ => panic!("expected a number, found {object:?}"),
    }
}

#[test]
fn facing_print_keeps_a_user_unit_two_page_at_twice_the_size_of_a_user_unit_one_page() {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let mut kids = Vec::new();
    for user_unit in [1, 2] {
        let content = document.add_object(Stream::new(Dictionary::new(), b"0 0 1 rg 0 0 10 10 re f".to_vec()));
        kids.push(Object::Reference(document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
            "UserUnit" => user_unit,
            "Contents" => content,
        })));
    }
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => 2,
        }),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);

    build_print_layout(&mut document, None, PrintViewMode::Facing, PrintOrientation::Portrait)
        .unwrap();
    let widths = printed_form_widths(&document);
    assert_eq!(widths.len(), 2);
    assert_approximately(widths[1] / widths[0], 2.0);
}

#[cfg(unix)]
#[test]
fn a_large_base_whose_startxref_value_ends_at_a_vertical_tab_takes_an_append() {
    let pdf = temp_pdf_path("large-startxref-vertical-tab");
    let pages_file = temp_pdf_path("large-startxref-vertical-tab-pages");
    // qpdf's tokenizer ends the integer at \v, as it does at any space.
    write_large_sparse_pdf(&pdf, "\x0b", b"");
    std::fs::write(&pages_file, b"1\n").unwrap();
    let len = std::fs::metadata(&pdf).unwrap().len();
    mutate_pdf(Config {
        operation: Operation::RemoveCrop {
            pages_file: pages_file.clone(),
        },
        input_path: pdf.clone(),
        output_path: Some(pdf.clone()),
        qpdf_path: None,
    })
    .expect("a startxref value ended by \\v is qpdf's terminal revision");
    let new_len = std::fs::metadata(&pdf).unwrap().len();
    assert!(new_len > len);
    let (xref, _) = read_terminal_xref(&pdf, new_len).unwrap();
    assert!(xref >= len);
    let mut geometry = Vec::new();
    write_page_geometry(&pdf, 1, &mut geometry).unwrap();
    let geometry: serde_json::Value = serde_json::from_slice(&geometry).unwrap();
    assert_eq!(geometry["cropBox"], serde_json::Value::Null);
    std::fs::remove_file(pdf).unwrap();
    std::fs::remove_file(pages_file).unwrap();
}

#[test]
fn page_geometry_refuses_a_page_tree_whose_count_disagrees_with_its_leaves() {
    let pdf = temp_pdf_path("page-geometry-stale-count");
    let (mut document, _) = create_test_document();
    let pages = document
        .catalog()
        .unwrap()
        .get(b"Pages")
        .unwrap()
        .as_reference()
        .unwrap();
    document.get_dictionary_mut(pages).unwrap().set("Count", 2);
    document.save(&pdf).unwrap();
    for page in [1, 2] {
        let error = write_page_geometry(&pdf, page, &mut Vec::new()).unwrap_err();
        let error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(error.code, NativeErrorCode::InvalidRequest, "page {page}");
        assert!(
            error.message.starts_with("The page tree is damaged"),
            "page {page}: {}",
            error.message
        );
    }
    remove_file(pdf).unwrap();
}

#[test]
fn range_read_geometry_table_single_page_and_append_admission_skip_stream_payloads() {
    use std::cell::RefCell;

    struct GuardedSlice<'a> {
        bytes: &'a [u8],
        forbidden: (u64, u64),
        read_bytes: RefCell<u64>,
    }

    impl crate::pdf_source::ByteSource for &GuardedSlice<'_> {
        fn read_at(&self, offset: u64, dst: &mut [u8]) -> std::io::Result<()> {
            let end = offset
                .checked_add(dst.len() as u64)
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "overflow"))?;
            let (forbid_start, forbid_end) = self.forbidden;
            assert!(
                end <= forbid_start || offset >= forbid_end,
                "range read touched stream payload bytes ({offset}..{end} overlaps {forbid_start}..{forbid_end})"
            );
            let start = usize::try_from(offset).unwrap();
            let stop = usize::try_from(end).unwrap();
            dst.copy_from_slice(&self.bytes[start..stop]);
            *self.read_bytes.borrow_mut() += dst.len() as u64;
            Ok(())
        }

        fn copy_range(
            &self,
            _offset: u64,
            _len: u64,
            _output: &mut impl std::io::Write,
        ) -> std::io::Result<()> {
            panic!("range-read metadata inspection must not copy stream ranges")
        }
    }

    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let payload_marker = b"EVB_FORBIDDEN_STREAM_PAYLOAD_START";
    let mut payload = Vec::with_capacity(2 * 1024 * 1024);
    payload.extend_from_slice(payload_marker);
    payload.resize(2 * 1024 * 1024, b'Z');
    let mut stream_dict = Dictionary::new();
    stream_dict.set("Length", payload.len() as i64);
    let content_id = document.add_object(Stream::new(stream_dict, payload));
    let page1_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => content_id,
    });
    let page2_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 500.into(), 700.into()],
        "CropBox" => vec![20.into(), 30.into(), 420.into(), 630.into()],
        "Rotate" => 90,
        "UserUnit" => 2,
        "Contents" => content_id,
    });
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page1_id.into(), page2_id.into()],
            "Count" => 2,
        }),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);

    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let marker_pos = bytes
        .windows(payload_marker.len())
        .position(|window| window == payload_marker)
        .expect("stream payload must appear verbatim");
    // Leave headroom for the 64 KiB header line scan and the 1 MiB terminal-xref tail window.
    let forbidden = ((marker_pos + 128 * 1024) as u64, (marker_pos + 900 * 1024) as u64);
    let guarded = GuardedSlice {
        bytes: &bytes,
        forbidden,
        read_bytes: RefCell::new(0),
    };
    let len = bytes.len() as u64;

    let table_json = crate::read_page_geometry_table(&guarded, len).unwrap();
    let table: serde_json::Value = serde_json::from_slice(&table_json).unwrap();
    assert_eq!(table["pageCount"], 2);
    assert_eq!(table["pages"][0]["pageNumber"], 1);
    assert_eq!(table["pages"][0]["widthPoints"], 612.0);
    assert_eq!(table["pages"][0]["heightPoints"], 792.0);
    assert_eq!(table["pages"][0]["rotation"], 0);
    assert_eq!(table["pages"][0]["userUnit"], 1.0);
    assert_eq!(table["pages"][1]["pageNumber"], 2);
    assert_eq!(table["pages"][1]["xPoints"], 20.0);
    assert_eq!(table["pages"][1]["yPoints"], 30.0);
    assert_eq!(table["pages"][1]["widthPoints"], 400.0);
    assert_eq!(table["pages"][1]["heightPoints"], 600.0);
    assert_eq!(table["pages"][1]["rotation"], 90);
    assert_eq!(table["pages"][1]["userUnit"], 2.0);
    assert!(*guarded.read_bytes.borrow() < len / 4);

    let single = crate::page_geometry::get_page_geometry_from_source(&guarded, len, 2).unwrap();
    assert_eq!(single.rotation, 90);
    assert_eq!(single.user_unit, 2.0);
    assert_eq!(single.media_box.width(), 500.0);
    assert_eq!(single.crop_box.unwrap().width(), 400.0);

    let admission = crate::terminal_xref::append_admission_of_source(&guarded, len).unwrap();
    let byte_admission = crate::terminal_xref::append_admission_of_bytes(&bytes).unwrap();
    assert!(matches!(admission, crate::terminal_xref::AppendAdmission::Appendable));
    assert!(matches!(byte_admission, crate::terminal_xref::AppendAdmission::Appendable));

    // Corrupt startxref so append admission reports repairable by range too.
    let mut damaged = bytes.clone();
    let startxref_pos = damaged
        .windows(b"startxref".len())
        .rposition(|window| window == b"startxref")
        .unwrap();
    damaged.truncate(startxref_pos);
    damaged.extend_from_slice(b"startxref\n9\n%%EOF\n");
    let damaged_guarded = GuardedSlice {
        bytes: &damaged,
        forbidden,
        read_bytes: RefCell::new(0),
    };
    let damaged_admission =
        crate::terminal_xref::append_admission_of_source(&damaged_guarded, damaged.len() as u64)
            .unwrap();
    assert!(matches!(
        damaged_admission,
        crate::terminal_xref::AppendAdmission::Repairable(_)
    ));
}

#[test]
fn range_read_geometry_resolves_chained_indirect_references() {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let width_num_id = document.add_object(Object::Real(480.0));
    let width_chain_id = document.add_object(Object::Reference(width_num_id));
    let media_box_id = document.add_object(Object::Array(vec![
        0.into(),
        0.into(),
        width_chain_id.into(),
        640.into(),
    ]));
    let media_box_chain_id = document.add_object(Object::Reference(media_box_id));
    let count_num_id = document.add_object(Object::Integer(1));
    let count_chain_id = document.add_object(Object::Reference(count_num_id));
    let rotate_num_id = document.add_object(Object::Integer(270));
    let rotate_chain_id = document.add_object(Object::Reference(rotate_num_id));
    let user_unit_num_id = document.add_object(Object::Real(1.5));
    let user_unit_chain_id = document.add_object(Object::Reference(user_unit_num_id));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => media_box_chain_id,
        "Rotate" => rotate_chain_id,
        "UserUnit" => user_unit_chain_id,
    });
    let kids_array_id = document.add_object(Object::Array(vec![page_id.into()]));
    let kids_chain_id = document.add_object(Object::Reference(kids_array_id));
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids_chain_id,
            "Count" => count_chain_id,
        }),
    );
    let pages_chain_id = document.add_object(Object::Reference(pages_id));
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_chain_id,
    });
    document.trailer.set("Root", catalog_id);

    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    let len = bytes.len() as u64;

    crate::pdf_source::validate_page_tree_source(bytes.as_slice(), len).unwrap();

    let table_json = crate::read_page_geometry_table(bytes.as_slice(), len).unwrap();
    let table: serde_json::Value = serde_json::from_slice(&table_json).unwrap();
    assert_eq!(table["pageCount"], 1);
    assert_eq!(table["pages"][0]["widthPoints"], 480.0);
    assert_eq!(table["pages"][0]["heightPoints"], 640.0);
    assert_eq!(table["pages"][0]["rotation"], 270);
    assert_eq!(table["pages"][0]["userUnit"], 1.5);

    let single =
        crate::page_geometry::get_page_geometry_from_source(bytes.as_slice(), len, 1).unwrap();
    assert_eq!(single.media_box.width(), 480.0);
    assert_eq!(single.media_box.height(), 640.0);
    assert_eq!(single.rotation, 270);
    assert_eq!(single.user_unit, 1.5);
}

#[test]
fn read_page_geometry_table_stops_immediately_on_shared_kids_dag_or_count_mismatch() {
    // 25-level binary DAG has 2^25 (~33.5M) virtual leaves while declaring /Count 1.
    let mut dag_doc = Document::with_version("1.7");
    let leaf_id = dag_doc.add_object(dictionary! {
        "Type" => "Page",
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
    });
    let mut child_id = leaf_id;
    for _ in 0..25 {
        let node_id = dag_doc.new_object_id();
        dag_doc.objects.insert(
            node_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![child_id.into(), child_id.into()],
                "Count" => 1,
            }),
        );
        child_id = node_id;
    }
    let catalog_id = dag_doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => child_id,
    });
    dag_doc.trailer.set("Root", catalog_id);

    let mut dag_bytes = Vec::new();
    dag_doc.save_to(&mut dag_bytes).unwrap();
    let error = crate::read_page_geometry_table(dag_bytes.as_slice(), dag_bytes.len() as u64)
        .expect_err("shared-subtree DAG exceeding /Count must fail immediately");
    let native_error = error
        .downcast_ref::<NativeError>()
        .expect("DAG refusal must carry NativeError");
    assert_eq!(native_error.code, NativeErrorCode::CorruptXref);

    // Fewer reachable leaves than declared /Count (e.g. an empty middle branch claiming
    // /Count 1, so both-ends validation passes but the full walk visits only 2 of 3 pages)
    // must also fail with CorruptXref.
    let mut short_doc = Document::with_version("1.7");
    let pages_id = short_doc.new_object_id();
    let left_page_id = short_doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
    });
    let empty_middle_id = short_doc.add_object(dictionary! {
        "Type" => "Pages",
        "Parent" => pages_id,
        "Kids" => Vec::<Object>::new(),
        "Count" => 1,
    });
    let right_page_id = short_doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
    });
    short_doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![left_page_id.into(), empty_middle_id.into(), right_page_id.into()],
            "Count" => 3,
        }),
    );
    let short_catalog_id = short_doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    short_doc.trailer.set("Root", short_catalog_id);

    let mut short_bytes = Vec::new();
    short_doc.save_to(&mut short_bytes).unwrap();
    let short_error =
        crate::read_page_geometry_table(short_bytes.as_slice(), short_bytes.len() as u64)
            .expect_err("under-populated page tree must fail");
    let short_native = short_error
        .downcast_ref::<NativeError>()
        .expect("count mismatch must carry NativeError");
    assert_eq!(short_native.code, NativeErrorCode::CorruptXref);

    // 45-level empty-subtree shared /Pages DAG (2^45 internal visits if revisited)
    // alongside 1 valid leaf page with root /Count 1 must fail immediately with CorruptXref.
    let mut empty_dag_doc = Document::with_version("1.7");
    let leaf_page_id = empty_dag_doc.add_object(dictionary! {
        "Type" => "Page",
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
    });
    let mut dag_child_id = empty_dag_doc.add_object(dictionary! {
        "Type" => "Pages",
        "Kids" => Vec::<Object>::new(),
        "Count" => 0,
    });
    for _ in 0..45 {
        let node_id = empty_dag_doc.new_object_id();
        empty_dag_doc.objects.insert(
            node_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![dag_child_id.into(), dag_child_id.into()],
                "Count" => 0,
            }),
        );
        dag_child_id = node_id;
    }
    let empty_dag_root_id = empty_dag_doc.add_object(dictionary! {
        "Type" => "Pages",
        "Kids" => vec![leaf_page_id.into(), dag_child_id.into()],
        "Count" => 1,
    });
    let empty_dag_catalog_id = empty_dag_doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => empty_dag_root_id,
    });
    empty_dag_doc.trailer.set("Root", empty_dag_catalog_id);

    let mut empty_dag_bytes = Vec::new();
    empty_dag_doc.save_to(&mut empty_dag_bytes).unwrap();
    let empty_dag_error = crate::read_page_geometry_table(
        empty_dag_bytes.as_slice(),
        empty_dag_bytes.len() as u64,
    )
    .expect_err("empty-subtree shared /Pages DAG must fail immediately");
    let empty_dag_native = empty_dag_error
        .downcast_ref::<NativeError>()
        .expect("empty-subtree DAG refusal must carry NativeError");
    assert_eq!(empty_dag_native.code, NativeErrorCode::CorruptXref);

    // Consistent-count leaf-duplicating DAG (17-level binary DAG -> 2^17 = 131,072
    // duplicated leaves matching /Count 131072) must be rejected as a non-tree DAG.
    let mut dup_dag_doc = Document::with_version("1.7");
    let dup_leaf_id = dup_dag_doc.add_object(dictionary! {
        "Type" => "Page",
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
    });
    let mut dup_child_id = dup_leaf_id;
    let mut dup_count: i64 = 1;
    for _ in 0..17 {
        dup_count *= 2;
        let node_id = dup_dag_doc.new_object_id();
        dup_dag_doc.objects.insert(
            node_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![dup_child_id.into(), dup_child_id.into()],
                "Count" => dup_count,
            }),
        );
        dup_child_id = node_id;
    }
    let dup_catalog_id = dup_dag_doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => dup_child_id,
    });
    dup_dag_doc.trailer.set("Root", dup_catalog_id);

    let mut dup_dag_bytes = Vec::new();
    dup_dag_doc.save_to(&mut dup_dag_bytes).unwrap();
    let dup_dag_error =
        crate::read_page_geometry_table(dup_dag_bytes.as_slice(), dup_dag_bytes.len() as u64)
            .expect_err("consistent-count shared /Kids DAG must be rejected");
    let dup_dag_native = dup_dag_error
        .downcast_ref::<NativeError>()
        .expect("consistent-count DAG refusal must carry NativeError");
    assert_eq!(dup_dag_native.code, NativeErrorCode::CorruptXref);
}
