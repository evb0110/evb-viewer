#[test]
fn crops_pages_using_inherited_media_box() {
    let (mut document, page_id) = create_test_document();

    crop_pages(
        &mut document,
        &[1],
        CropMargins {
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
    .expect("path crop should append a revision");

    let cropped = Document::load(&pdf).unwrap();
    let cropped_page = cropped.get_dictionary(page_id).unwrap();
    assert_eq!(crop_box(&cropped, page_id), vec![2.0, 3.0, 199.0, 96.0]);
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
    let (mut document, _page_id) = create_test_document();
    document.save(&pdf).unwrap();

    let mut output = Vec::new();
    write_page_geometry(&pdf, 1, None, &mut output).unwrap();

    let geometry: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(geometry["mediaBox"]["x"], 0.0);
    assert_eq!(geometry["mediaBox"]["y"], 0.0);
    assert_eq!(geometry["mediaBox"]["width"], 200.0);
    assert_eq!(geometry["mediaBox"]["height"], 100.0);
    assert_eq!(geometry["cropBox"], serde_json::Value::Null);
    assert_eq!(geometry["rotation"], 0);

    remove_file(pdf).unwrap();
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

#[cfg(unix)]
#[test]
fn large_path_crop_and_remove_crop_use_qpdf_without_reading_the_source() {
    use std::{
        fs::File,
        io::{Read, Seek, SeekFrom, Write},
    };

    const LARGE_SOURCE_OFFSET: u64 = 512 * 1024 * 1024 + 1024;
    let pdf = temp_pdf_path("large-path-crop");
    let pages_file = temp_pdf_path("large-path-crop-pages");
    let qpdf = temp_pdf_path("large-path-crop-qpdf");

    let mut source = File::create(&pdf).unwrap();
    source.write_all(b"%PDF-1.4\n").unwrap();
    source.seek(SeekFrom::Start(LARGE_SOURCE_OFFSET)).unwrap();
    source
        .write_all(b"xref\n0 1\n0000000000 65535 f \ntrailer\n<</Size 1/Root 1 0 R>>\nstartxref\n")
        .unwrap();
    writeln!(source, "{LARGE_SOURCE_OFFSET}").unwrap();
    source.write_all(b"%%EOF\n").unwrap();
    source.sync_all().unwrap();
    assert!(source.metadata().unwrap().len() > MAX_ENCODED_PDF_BYTES as u64);
    drop(source);

    std::fs::write(&pages_file, b"1\n").unwrap();
    let qpdf_json = r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":3},{"trailer":{"value":{"/Root":"1 0 R"}},"obj:1 0 R":{"value":{"/Type":"/Catalog","/Pages":"2 0 R"}},"obj:2 0 R":{"value":{"/Type":"/Pages","/Count":1,"/Kids":["3 0 R"],"/MediaBox":[0,0,200,100]}},"obj:3 0 R":{"value":{"/Type":"/Page","/Parent":"2 0 R","/MediaBox":[0,0,200,100],"/CustomKey":"/keep"}}}]}"#;
    let script = format!("#!/bin/sh\nprintf '%s' '{qpdf_json}'\n");
    let _fake_executable = crate::write_fake_executable(&qpdf, &script);

    let original_len = std::fs::metadata(&pdf).unwrap().len();
    mutate_pdf(Config {
        operation: Operation::Crop {
            pages_file: pages_file.clone(),
            margins: CropMargins {
                top: 4.0,
                bottom: 3.0,
                left: 2.0,
                right: 1.0,
            },
        },
        input_path: pdf.clone(),
        output_path: Some(pdf.clone()),
        qpdf_path: Some(qpdf.clone()),
    })
    .expect("large path crop should use structural qpdf loading");

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
        qpdf_path: Some(qpdf.clone()),
    })
    .expect("large path crop removal should use structural qpdf loading");

    let mut appended_removal = Vec::new();
    let mut output = File::open(&pdf).unwrap();
    output.seek(SeekFrom::Start(after_crop_len)).unwrap();
    output.read_to_end(&mut appended_removal).unwrap();
    let appended_removal_text = String::from_utf8_lossy(&appended_removal);
    assert!(appended_removal_text.contains("/CropBox"));
    assert!(appended_removal_text.contains("0 0 200 100"));
    assert!(appended_removal_text.contains("/CustomKey/keep"));

    std::fs::remove_file(pdf).unwrap();
    std::fs::remove_file(pages_file).unwrap();
    std::fs::remove_file(qpdf).unwrap();
}

#[test]
fn remove_crop_restores_media_box() {
    let (mut document, page_id) = create_test_document();

    crop_pages(
        &mut document,
        &[1],
        CropMargins {
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
