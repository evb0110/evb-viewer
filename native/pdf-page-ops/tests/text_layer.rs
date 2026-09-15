use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use std::{
    env,
    fs::{self, remove_file, write, File},
    io::{Seek, SeekFrom, Write},
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn path(label: &str, extension: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!("evb-pdf-page-ops-{label}-{nonce}.{extension}"))
}

fn save_single_page(path: &Path, content: Vec<u8>, resources: Dictionary) -> Document {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let content_id = document.add_object(Stream::new(dictionary! {}, content));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
        "Resources" => resources,
        "Contents" => content_id,
    });
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    document.trailer.set("Root", catalog_id);
    document.save(path).unwrap();
    document
}

fn save_two_pages(path: &Path, contents: [Vec<u8>; 2], resources: Dictionary) -> Document {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let page_ids = contents
        .into_iter()
        .map(|content| {
            let content_id = document.add_object(Stream::new(dictionary! {}, content));
            document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
                "Resources" => resources.clone(),
                "Contents" => content_id,
            })
        })
        .collect::<Vec<_>>();
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.into_iter().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => 2,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    document.trailer.set("Root", catalog_id);
    document.save(path).unwrap();
    document
}

fn save_empty_pages(path: &Path, count: usize) {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let page_ids = (0..count)
        .map(|_| {
            document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
                "Resources" => Dictionary::new(),
            })
        })
        .collect::<Vec<_>>();
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids.into_iter().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => count as i64,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    document.trailer.set("Root", catalog_id);
    document.save(path).unwrap();
}

fn run_overlay_text(
    input: &Path,
    source: &Path,
    output: &Path,
    instructions: &Path,
) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["overlay-text", "--input"])
        .arg(input)
        .arg("--source")
        .arg(source)
        .arg("--output")
        .arg(output)
        .arg("--instructions-file")
        .arg(instructions)
        .output()
        .unwrap()
}

fn qpdf_path() -> std::path::PathBuf {
    env::var_os("QPDF_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("qpdf"))
}

fn run_overlay_text_with_qpdf(
    input: &Path,
    source: &Path,
    output: &Path,
    instructions: &Path,
) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"));
    command
        .args(["overlay-text", "--input"])
        .arg(input)
        .arg("--source")
        .arg(source)
        .arg("--output")
        .arg(output)
        .arg("--instructions-file")
        .arg(instructions)
        .arg("--qpdf")
        .arg(qpdf_path());
    command.output().unwrap()
}

fn write_raw_object(file: &mut File, offsets: &mut [u64], object_number: usize, body: &[u8]) {
    offsets[object_number] = file.stream_position().unwrap();
    writeln!(file, "{object_number} 0 obj").unwrap();
    file.write_all(body).unwrap();
    file.write_all(b"\nendobj\n").unwrap();
}

fn write_sparse_source(
    path: &Path,
    page_count: usize,
    ocr_source_page_index: Option<usize>,
    malformed_source_page_index: Option<usize>,
) -> u64 {
    const SPARSE_UNREFERENCED_BYTES: u64 = 600 * 1024 * 1024;
    let first_page_object = 3;
    let last_page_object = first_page_object + page_count - 1;
    let empty_content_object = last_page_object + 1;
    let ocr_content_object = empty_content_object + 1;
    let malformed_content_object = ocr_content_object + 1;
    let font_object = malformed_content_object + 1;
    let sparse_object = font_object + 1;
    let mut offsets = vec![0_u64; sparse_object + 1];
    let mut file = File::create(path).unwrap();
    file.write_all(b"%PDF-1.4\n%\x80\x81\x82\x83\n").unwrap();
    write_raw_object(&mut file, &mut offsets, 1, b"<</Type/Catalog/Pages 2 0 R>>");
    let kids = (first_page_object..=last_page_object)
        .map(|object| format!("{object} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    let pages = format!("<</Type/Pages/Kids[{kids}]/Count {page_count}>>");
    write_raw_object(&mut file, &mut offsets, 2, pages.as_bytes());
    for (page_index, object_number) in (first_page_object..=last_page_object).enumerate() {
        let content_object = if malformed_source_page_index == Some(page_index) {
            malformed_content_object
        } else if ocr_source_page_index == Some(page_index) {
            ocr_content_object
        } else {
            empty_content_object
        };
        let page = format!(
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Resources<< /Font<< /F1 {font_object} 0 R>> >>/Contents {content_object} 0 R>>"
        );
        write_raw_object(&mut file, &mut offsets, object_number, page.as_bytes());
    }
    write_raw_object(
        &mut file,
        &mut offsets,
        empty_content_object,
        b"<</Length 0>>\nstream\n\nendstream",
    );
    const OCR_CONTENT: &[u8] = b"BT /F1 12 Tf 3 Tr 10 20 Td (HIGH INDEX OCR) Tj ET";
    let mut ocr_stream = format!("<</Length {}>>\nstream\n", OCR_CONTENT.len()).into_bytes();
    ocr_stream.extend_from_slice(OCR_CONTENT);
    ocr_stream.extend_from_slice(b"\nendstream");
    write_raw_object(&mut file, &mut offsets, ocr_content_object, &ocr_stream);
    const MALFORMED_CONTENT: &[u8] = b"BT /FMissing 12 Tf 3 Tr 10 20 Td (MALFORMED OCR) Tj ET";
    let mut malformed_stream =
        format!("<</Length {}>>\nstream\n", MALFORMED_CONTENT.len()).into_bytes();
    malformed_stream.extend_from_slice(MALFORMED_CONTENT);
    malformed_stream.extend_from_slice(b"\nendstream");
    write_raw_object(
        &mut file,
        &mut offsets,
        malformed_content_object,
        &malformed_stream,
    );
    write_raw_object(
        &mut file,
        &mut offsets,
        font_object,
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    );
    offsets[sparse_object] = file.stream_position().unwrap();
    write!(
        file,
        "{sparse_object} 0 obj\n<</Length {SPARSE_UNREFERENCED_BYTES}>>\nstream\n"
    )
    .unwrap();
    file.seek(SeekFrom::Current(
        i64::try_from(SPARSE_UNREFERENCED_BYTES).unwrap(),
    ))
    .unwrap();
    file.write_all(b"\nendstream\nendobj\n").unwrap();

    let xref_offset = file.stream_position().unwrap();
    let xref_size = sparse_object + 1;
    write!(file, "xref\n0 {xref_size}\n0000000000 65535 f \n").unwrap();
    for offset in offsets.iter().skip(1) {
        writeln!(file, "{offset:010} 00000 n ").unwrap();
    }
    write!(
        file,
        "trailer\n<</Size {xref_size}/Root 1 0 R>>\nstartxref\n{xref_offset}\n%%EOF\n"
    )
    .unwrap();
    file.sync_all().unwrap();
    fs::metadata(path).unwrap().len()
}

fn write_sparse_high_index_source(path: &Path) -> u64 {
    write_sparse_source(path, 1_235, Some(1_234), None)
}

fn write_sparse_malformed_source(path: &Path) -> u64 {
    write_sparse_source(path, 65, None, Some(64))
}

fn atomic_output_siblings(output: &Path) -> Vec<std::path::PathBuf> {
    let prefix = format!(
        ".{}.evb-tmp-",
        output.file_name().unwrap().to_string_lossy(),
    );
    output
        .parent()
        .unwrap()
        .read_dir()
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(&prefix))
        })
        .collect()
}

fn pdftotext_page(pdf: &Path, page: usize, extra_args: &[&str]) -> std::process::Output {
    let mut command = Command::new("pdftotext");
    command.args(extra_args);
    command
        .args(["-f", &page.to_string(), "-l", &page.to_string()])
        .arg(pdf)
        .arg("-")
        .output()
        .expect("pdftotext must be installed for PDF text-layer integration tests")
}

fn bbox_word_x(xml: &str, word: &str) -> f64 {
    let word_end = xml
        .find(&format!(">{word}</word>"))
        .unwrap_or_else(|| panic!("word {word:?} is absent from bbox output"));
    let tag = &xml[xml[..word_end].rfind("<word ").unwrap()..word_end];
    let value = tag.split_once("xMin=\"").unwrap().1;
    value[..value.find('"').unwrap()].parse().unwrap()
}

fn measurable_helvetica_font() -> Dictionary {
    dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "FirstChar" => 0,
        "LastChar" => 255,
        "Widths" => (0..256).map(|_| Object::Integer(1_000)).collect::<Vec<_>>(),
    }
}

fn identity_pdf_text(text: &str) -> String {
    text.encode_utf16()
        .map(|unit| format!("{unit:04x}"))
        .collect()
}

#[test]
fn overlay_text_repairs_visual_order_without_changing_glyph_positions() {
    let source = path("bidi-text-source", "pdf");
    let input = path("bidi-text-input", "pdf");
    let output = path("bidi-text-output", "pdf");
    let instructions = path("bidi-text-instructions", "json");
    let source_text = "Latin .كلذ 123";
    let cmap = b"/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nend\nend";

    let mut source_document = save_single_page(
        &source,
        format!(
            "BT /F1 20 Tf 1 0 0 1 10 80 Tm <{}> Tj ET",
            identity_pdf_text(source_text)
        )
        .into_bytes(),
        Dictionary::new(),
    );
    let cmap_id = source_document.add_object(Stream::new(dictionary! {}, cmap.to_vec()));
    let descendant_id = source_document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => "OCR",
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => 0,
        },
        "DW" => 1_000,
        "CIDToGIDMap" => "Identity",
    });
    let font_id = source_document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "OCR",
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![descendant_id.into()],
        "ToUnicode" => cmap_id,
    });
    let source_page_id = *source_document.get_pages().get(&1).unwrap();
    source_document
        .get_dictionary_mut(source_page_id)
        .unwrap()
        .set(
            "Resources",
            dictionary! { "Font" => dictionary! { "F1" => font_id } },
        );
    source_document.save(&source).unwrap();

    let mut input_document = save_single_page(&input, Vec::new(), Dictionary::new());
    let input_page_id = *input_document.get_pages().get(&1).unwrap();
    input_document
        .get_dictionary_mut(input_page_id)
        .unwrap()
        .set("MediaBox", vec![0.into(), 0.into(), 400.into(), 120.into()]);
    input_document.save(&input).unwrap();
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let extracted = pdftotext_page(&output, 1, &[]);
    assert!(extracted.status.success());
    let extracted = String::from_utf8_lossy(&extracted.stdout);
    assert!(extracted.contains("Latin"), "extracted text: {extracted}");
    assert!(extracted.contains("ذلك"), "extracted text: {extracted}");
    assert!(extracted.contains("123"), "extracted text: {extracted}");
    assert!(!extracted.contains(".كلذ"), "extracted text: {extracted}");

    let positioned_content = source_document.add_object(Stream::new(
        dictionary! {},
        b"BT /F1 10 Tf 60 Tz 1 0 0 1 30 80 Tm <00410042> Tj 1 0 0 1 55 80 Tm <00430044> Tj /F1 20 Tf 40 Tz 1 0 0 1 30 40 Tm <00450046> Tj 1 0 0 1 65 40 Tm <00470048> Tj ET".to_vec(),
    ));
    source_document
        .get_dictionary_mut(source_page_id)
        .unwrap()
        .set("Contents", positioned_content);
    source_document.save(&source).unwrap();
    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let source_bbox = pdftotext_page(&source, 1, &["-bbox"]);
    let saved_bbox = pdftotext_page(&output, 1, &["-bbox"]);
    assert!(source_bbox.status.success());
    assert!(saved_bbox.status.success());
    let source_bbox = String::from_utf8_lossy(&source_bbox.stdout);
    let saved_bbox = String::from_utf8_lossy(&saved_bbox.stdout);
    for word in ["AB", "CD", "EF", "GH"] {
        assert!(
            (bbox_word_x(&source_bbox, word) - bbox_word_x(&saved_bbox, word)).abs() < 0.01,
            "saved word {word} moved away from its raster position: {saved_bbox}"
        );
    }

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_copies_only_invisible_text_and_renames_colliding_fonts() {
    let source = path("text-source", "pdf");
    let input = path("text-input", "pdf");
    let output = path("text-output", "pdf");
    let instructions = path("text-instructions", "json");

    let source_font = dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    };
    let source_resources = dictionary! {
        "Font" => dictionary! { "F1" => source_font },
    };
    let repeated_ocr = "0 0 Td (Searchable OCR) Tj ".repeat(64);
    let mut source_page = save_single_page(
        &source,
        format!("q 2 0 0 2 1 2 cm BT /F1 12 Tf 0 Tr 5 8 Td {repeated_ocr}ET Q 0 0 100 100 re f")
            .into_bytes(),
        source_resources,
    );
    // Replace the direct fixture resource with an indirect object so the test
    // exercises the font graph copier rather than only dictionary cloning.
    let local_font_id = source_page.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let source_page_id = *source_page.get_pages().get(&1).unwrap();
    source_page.get_dictionary_mut(source_page_id).unwrap().set(
        "Resources",
        dictionary! { "Font" => dictionary! { "F1" => local_font_id } },
    );
    source_page.save(&source).unwrap();

    let target_font = dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Courier",
    };
    save_single_page(
        &input,
        b"0 0 20 20 re f".to_vec(),
        dictionary! { "Font" => dictionary! { "EVBOcr_F1" => target_font } },
    );
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1.5,0,0,1.5,4,7]}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let overlaid = Document::load(&output).unwrap();
    let page_id = *overlaid.get_pages().get(&1).unwrap();
    let operations = overlaid
        .get_and_decode_page_content(page_id)
        .unwrap()
        .operations;
    assert_eq!(
        operations
            .iter()
            .filter(|operation| operation.operator == "re")
            .count(),
        1,
        "source drawing operators must not cross into the cleaned page"
    );
    assert!(operations
        .iter()
        .all(|operation| operation.operator != "Do"));
    assert!(operations
        .iter()
        .filter(|operation| operation.operator == "Tr")
        .all(|operation| operation.operands == vec![Object::Integer(3)]));
    let matrices = operations
        .iter()
        .filter(|operation| operation.operator == "cm")
        .map(|operation| {
            operation
                .operands
                .iter()
                .map(|operand| f64::from(operand.as_float().unwrap()))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    assert!(matrices.contains(&vec![1.5, 0.0, 0.0, 1.5, 4.0, 7.0]));
    assert!(matrices.contains(&vec![2.0, 0.0, 0.0, 2.0, 1.0, 2.0]));

    let page = overlaid.get_dictionary(page_id).unwrap();
    let resources = page.get(b"Resources").unwrap().as_dict().unwrap();
    let fonts = resources.get(b"Font").unwrap().as_dict().unwrap();
    assert!(fonts.get(b"EVBOcr_F1").is_ok());
    assert!(fonts.get(b"EVBOcr_F1_1").is_ok());
    assert!(overlaid
        .extract_text(&[1])
        .unwrap()
        .contains("Searchable OCR"));

    let content_ids = page
        .get(b"Contents")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|object| object.as_reference().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(content_ids.len(), 2);
    let overlay_stream = overlaid
        .objects
        .get(content_ids.last().unwrap())
        .unwrap()
        .as_stream()
        .unwrap();
    assert_eq!(
        overlay_stream
            .dict
            .get(b"Filter")
            .and_then(Object::as_name)
            .unwrap(),
        b"FlateDecode",
        "the decoded OCR operator stream must be recompressed before save"
    );

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_small_rewrite_is_safe_for_same_path_and_hardlink_output() {
    for hardlink_output in [false, true] {
        let label = if hardlink_output {
            "text-alias-hardlink"
        } else {
            "text-alias-same-path"
        };
        let source = path(&format!("{label}-source"), "pdf");
        let input = path(&format!("{label}-input"), "pdf");
        let output = path(&format!("{label}-output"), "pdf");
        let instructions = path(&format!("{label}-instructions"), "json");
        save_single_page(
            &source,
            b"BT /F1 12 Tf 3 Tr 10 20 Td (Alias safe OCR) Tj ET".to_vec(),
            dictionary! { "Font" => dictionary! { "F1" => measurable_helvetica_font() } },
        );
        save_single_page(&input, Vec::new(), Dictionary::new());
        let original_input = fs::read(&input).unwrap();
        let destination = if hardlink_output {
            fs::hard_link(&input, &output).unwrap();
            output.clone()
        } else {
            input.clone()
        };
        write(
            &instructions,
            r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}]}"#,
        )
        .unwrap();

        let result = run_overlay_text(&input, &source, &destination, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );

        let overlaid = Document::load(&destination).unwrap();
        assert!(overlaid
            .extract_text(&[1])
            .unwrap()
            .contains("Alias safe OCR"));
        if hardlink_output {
            assert_eq!(fs::read(&input).unwrap(), original_input);
            assert!(Document::load(&input).is_ok());
        }

        for file in [source, input, output, instructions] {
            let _ = remove_file(file);
        }
    }
}

#[test]
fn overlay_text_rejects_singular_affines_before_mutating_the_pdf() {
    let source = path("singular-source", "pdf");
    let input = path("singular-input", "pdf");
    let output = path("singular-output", "pdf");
    let instructions = path("singular-instructions", "json");
    save_single_page(&source, Vec::new(), Dictionary::new());
    save_single_page(&input, Vec::new(), Dictionary::new());
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,2,0,4,7]}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("matrix must be invertible"));
    assert!(!output.exists());

    for path in [source, input, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_rejects_page_index_overflow_before_seeding_path_output() {
    let source = path("overflow-source", "pdf");
    let input = path("overflow-input", "pdf");
    let output = path("overflow-output", "pdf");
    let instructions = path("overflow-instructions", "json");
    save_single_page(&source, Vec::new(), Dictionary::new());
    save_single_page(&input, Vec::new(), Dictionary::new());
    write(
        &instructions,
        format!(
            r#"{{"pages":[{{"sourcePageIndex":{},"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}}]}}"#,
            usize::MAX
        ),
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("sourcePageIndex is too large"));
    assert!(!output.exists());

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_shares_one_cloned_font_program_across_pages() {
    let source = path("shared-font-source", "pdf");
    let input = path("shared-font-input", "pdf");
    let output = path("shared-font-output", "pdf");
    let instructions = path("shared-font-instructions", "json");

    let mut source_document = Document::with_version("1.7");
    let pages_id = source_document.new_object_id();
    let font_program = b"shared-font-program".to_vec();
    let font_program_id = source_document.add_object(Stream::new(
        dictionary! { "Length1" => font_program.len() as i64 },
        font_program.clone(),
    ));
    let descriptor_id = source_document.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "Helvetica",
        "Flags" => 32,
        "FontBBox" => vec![0.into(), (-200).into(), 1_000.into(), 900.into()],
        "ItalicAngle" => 0,
        "Ascent" => 800,
        "Descent" => -200,
        "CapHeight" => 700,
        "StemV" => 80,
        "FontFile" => font_program_id,
    });
    let font_id = source_document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
        "FontDescriptor" => descriptor_id,
    });
    let source_page_ids = ["First", "Second"]
        .into_iter()
        .map(|text| {
            let content_id = source_document.add_object(Stream::new(
                dictionary! {},
                format!("BT /F1 12 Tf 10 20 Td ({text}) Tj ET").into_bytes(),
            ));
            source_document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
                "Contents" => content_id,
            })
        })
        .collect::<Vec<_>>();
    source_document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => source_page_ids.into_iter().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => 2,
        }
        .into(),
    );
    let catalog_id =
        source_document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    source_document.trailer.set("Root", catalog_id);
    source_document.save(&source).unwrap();

    save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]},{"sourcePageIndex":1,"outputPageIndex":1,"matrix":[1,0,0,1,0,0]}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let overlaid = Document::load(&output).unwrap();
    let font_references = overlaid
        .get_pages()
        .into_values()
        .map(|page_id| {
            overlaid
                .get_dictionary(page_id)
                .unwrap()
                .get(b"Resources")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"Font")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"EVBOcr_F1")
                .unwrap()
                .as_reference()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(font_references.len(), 2);
    assert_eq!(font_references[0], font_references[1]);
    assert_eq!(
        overlaid
            .objects
            .values()
            .filter(|object| object
                .as_stream()
                .is_ok_and(|stream| stream.content == font_program))
            .count(),
        1,
        "the shared embedded font program must be cloned only once"
    );
    assert!(overlaid.extract_text(&[1]).unwrap().contains("First"));
    assert!(overlaid.extract_text(&[2]).unwrap().contains("Second"));

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_filters_each_split_page_to_its_visible_source_half() {
    let source = path("split-text-source", "pdf");
    let input = path("split-text-input", "pdf");
    let output = path("split-text-output", "pdf");
    let instructions = path("split-text-instructions", "json");

    save_single_page(
        &source,
        b"q 1 0 0 1 5 0 cm BT /F1 6 Tf 3 Tr 1 0 0 1 15 60 Tm (LEFT_ONLY) Tj 1 0 0 1 115 60 Tm (RIGHT_ONLY) Tj ET Q"
            .to_vec(),
        dictionary! {
            "Font" => dictionary! {
                "F1" => measurable_helvetica_font()
            }
        },
    );
    let mut target = save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
    for page_id in target.get_pages().into_values() {
        target
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
    }
    target.save(&input).unwrap();
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},{"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"filterToOutputPage":true}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let left = pdftotext_page(&output, 1, &[]);
    let right = pdftotext_page(&output, 2, &[]);
    assert!(left.status.success());
    assert!(right.status.success());
    let left = String::from_utf8_lossy(&left.stdout);
    let right = String::from_utf8_lossy(&right.stdout);
    assert!(left.contains("LEFT_ONLY"), "left page text: {left}");
    assert!(!left.contains("RIGHT_ONLY"), "left page text: {left}");
    assert!(right.contains("RIGHT_ONLY"), "right page text: {right}");
    assert!(!right.contains("LEFT_ONLY"), "right page text: {right}");

    let left_bbox = pdftotext_page(&output, 1, &["-bbox"]);
    let right_bbox = pdftotext_page(&output, 2, &["-bbox"]);
    assert!(left_bbox.status.success());
    assert!(right_bbox.status.success());
    let left_bbox = String::from_utf8_lossy(&left_bbox.stdout);
    let right_bbox = String::from_utf8_lossy(&right_bbox.stdout);
    assert!(left_bbox.contains("LEFT_ONLY"), "left bbox: {left_bbox}");
    assert!(!left_bbox.contains("RIGHT_ONLY"), "left bbox: {left_bbox}");
    assert!(
        right_bbox.contains("RIGHT_ONLY"),
        "right bbox: {right_bbox}"
    );
    assert!(
        !right_bbox.contains("LEFT_ONLY"),
        "right bbox: {right_bbox}"
    );
    assert!((bbox_word_x(&left_bbox, "LEFT_ONLY") - 20.0).abs() < 0.1);
    assert!((bbox_word_x(&right_bbox, "RIGHT_ONLY") - 20.0).abs() < 0.1);

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn split_text_filter_tracks_consecutive_shows_and_splits_strings_and_tj_arrays_at_the_seam() {
    let source = path("split-glyph-source", "pdf");
    let input = path("split-glyph-input", "pdf");
    let output = path("split-glyph-output", "pdf");
    let instructions = path("split-glyph-instructions", "json");

    save_single_page(
        &source,
        b"BT /F1 10 Tf 3 Tr 1 0 0 1 80 90 Tm (AB) Tj (CD) Tj 1 0 0 1 80 60 Tm [(N) -1000 (R)] TJ 1 0 0 1 80 30 Tm (WXYZ) Tj ET"
            .to_vec(),
        dictionary! { "Font" => dictionary! { "F1" => measurable_helvetica_font() } },
    );
    let mut target = save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
    for page_id in target.get_pages().into_values() {
        target
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
    }
    target.save(&input).unwrap();
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},{"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"filterToOutputPage":true}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let left = pdftotext_page(&output, 1, &[]);
    let right = pdftotext_page(&output, 2, &[]);
    let left = String::from_utf8_lossy(&left.stdout);
    let right = String::from_utf8_lossy(&right.stdout);
    assert!(left.contains("AB"), "left page text: {left}");
    assert!(!left.contains("CD"), "left page text: {left}");
    assert!(right.contains("CD"), "right page text: {right}");
    assert!(!right.contains("AB"), "right page text: {right}");
    assert!(left.contains('N'), "left page text: {left}");
    assert!(!left.contains('R'), "left page text: {left}");
    assert!(right.contains('R'), "right page text: {right}");
    assert!(!right.contains('N'), "right page text: {right}");
    assert!(left.contains("WX"), "left page text: {left}");
    assert!(right.contains("YZ"), "right page text: {right}");

    let left_bbox = pdftotext_page(&output, 1, &["-bbox"]);
    let right_bbox = pdftotext_page(&output, 2, &["-bbox"]);
    let left_bbox = String::from_utf8_lossy(&left_bbox.stdout);
    let right_bbox = String::from_utf8_lossy(&right_bbox.stdout);
    assert!((bbox_word_x(&left_bbox, "AB") - 80.0).abs() < 0.1);
    assert!((bbox_word_x(&right_bbox, "CD") - 0.0).abs() < 0.1);
    assert!((bbox_word_x(&left_bbox, "N") - 80.0).abs() < 0.1);
    assert!((bbox_word_x(&right_bbox, "R") - 0.0).abs() < 0.1);
    assert!((bbox_word_x(&left_bbox, "WX") - 80.0).abs() < 0.1);
    assert!((bbox_word_x(&right_bbox, "YZ") - 0.0).abs() < 0.1);

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn split_text_filter_skips_an_unbalanced_graphics_state_without_aborting_cleanup() {
    let source = path("split-malformed-source", "pdf");
    let input = path("split-malformed-input", "pdf");
    let output = path("split-malformed-output", "pdf");
    let instructions = path("split-malformed-instructions", "json");
    save_single_page(
        &source,
        b"Q BT /F1 10 Tf 10 20 Td (MUST_NOT_LEAK) Tj ET".to_vec(),
        dictionary! { "Font" => dictionary! { "F1" => measurable_helvetica_font() } },
    );
    save_single_page(&input, b"0 0 20 20 re f".to_vec(), Dictionary::new());
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let warning = String::from_utf8_lossy(&result.stderr);
    assert!(warning.contains("scan_cleanup_text_overlay_skipped"));
    assert!(warning.contains("unmatched Q"));
    let text = pdftotext_page(&output, 1, &[]);
    assert!(text.status.success());
    assert!(!String::from_utf8_lossy(&text.stdout).contains("MUST_NOT_LEAK"));

    let document = Document::load(&output).unwrap();
    let page_id = *document.get_pages().get(&1).unwrap();
    let operations = document
        .get_and_decode_page_content(page_id)
        .unwrap()
        .operations;
    assert_eq!(
        operations
            .iter()
            .filter(|operation| operation.operator == "q")
            .count(),
        operations
            .iter()
            .filter(|operation| operation.operator == "Q")
            .count()
    );

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_extracts_a_high_index_page_from_a_sparse_source_above_the_byte_budget() {
    const HIGH_SOURCE_PAGE_INDEX: usize = 1_234;
    let source = path("large-source-high-page", "pdf");
    let input = path("large-source-high-page-input", "pdf");
    let output = path("large-source-high-page-output", "pdf");
    let instructions = path("large-source-high-page-instructions", "json");
    let source_len = write_sparse_high_index_source(&source);
    assert!(source_len > 512 * 1024 * 1024);
    save_empty_pages(&input, 66);
    let mut page_instructions = (0..65)
        .map(|page_index| {
            format!(
                r#"{{"sourcePageIndex":{page_index},"outputPageIndex":{page_index},"matrix":[1,0,0,1,0,0]}}"#
            )
        })
        .collect::<Vec<_>>();
    page_instructions.push(format!(
        r#"{{"sourcePageIndex":{HIGH_SOURCE_PAGE_INDEX},"outputPageIndex":65,"matrix":[1,0,0,1,0,0]}}"#
    ));
    write(
        &instructions,
        format!(r#"{{"pages":[{}]}}"#, page_instructions.join(",")),
    )
    .unwrap();

    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "overlay-text failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let text = pdftotext_page(&output, 66, &[]);
    assert!(
        text.status.success(),
        "pdftotext failed: {}",
        String::from_utf8_lossy(&text.stderr)
    );
    assert!(String::from_utf8_lossy(&text.stdout).contains("HIGH INDEX OCR"));
    let overlaid = Document::load(&output).unwrap();
    let page_id = *overlaid.get_pages().get(&66).unwrap();
    let parent_id = overlaid
        .get_dictionary(page_id)
        .unwrap()
        .get(b"Parent")
        .unwrap()
        .as_reference()
        .unwrap();
    assert_eq!(
        overlaid
            .get_dictionary(parent_id)
            .unwrap()
            .get(b"Type")
            .unwrap()
            .as_name()
            .unwrap(),
        b"Pages"
    );

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_failure_preserves_existing_output_after_a_prior_batch() {
    let source = path("large-source-malformed", "pdf");
    let input = path("large-source-malformed-input", "pdf");
    let output = path("large-source-malformed-output", "pdf");
    let instructions = path("large-source-malformed-instructions", "json");
    let source_len = write_sparse_malformed_source(&source);
    assert!(source_len > 512 * 1024 * 1024);
    save_empty_pages(&input, 65);
    let page_instructions = (0..65)
        .map(|page_index| {
            format!(
                r#"{{"sourcePageIndex":{page_index},"outputPageIndex":{page_index},"matrix":[1,0,0,1,0,0]}}"#
            )
        })
        .collect::<Vec<_>>();
    write(
        &instructions,
        format!(r#"{{"pages":[{}]}}"#, page_instructions.join(",")),
    )
    .unwrap();
    let existing_output = b"existing-overlay-output";
    write(&output, existing_output).unwrap();

    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("missing from Resources"),
        "unexpected overlay-text error: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(fs::read(&output).unwrap(), existing_output);
    assert!(atomic_output_siblings(&output).is_empty());

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}
