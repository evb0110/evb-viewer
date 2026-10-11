#[path = "../../test-support/external_tool.rs"]
mod external_tool;
#[path = "../../test-support/sparse_file.rs"]
mod sparse_file;

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
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

fn save_pages(
    path: &Path,
    contents: impl Iterator<Item = Option<Vec<u8>>>,
    resources: Dictionary,
) -> Document {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let page_ids = contents
        .map(|content| {
            let mut page = dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
                "Resources" => resources.clone(),
            };
            if let Some(content) = content {
                page.set(
                    "Contents",
                    document.add_object(Stream::new(dictionary! {}, content)),
                );
            }
            document.add_object(page)
        })
        .collect::<Vec<_>>();
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages", "Count" => page_ids.len() as i64,
            "Kids" => page_ids.into_iter().map(Object::Reference).collect::<Vec<_>>(),
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    document.trailer.set("Root", catalog_id);
    document.save(path).unwrap();
    document
}

fn save_single_page(path: &Path, content: Vec<u8>, resources: Dictionary) -> Document {
    save_pages(path, std::iter::once(Some(content)), resources)
}

fn save_two_pages(path: &Path, contents: [Vec<u8>; 2], resources: Dictionary) -> Document {
    save_pages(path, contents.into_iter().map(Some), resources)
}

fn save_empty_pages(path: &Path, count: usize) {
    save_pages(path, (0..count).map(|_| None), Dictionary::new());
}

/// Blank pages half as wide as `save_pages`, the output of a seam split.
fn save_half_pages(path: &Path, count: usize) {
    let mut document = save_pages(path, (0..count).map(|_| None), Dictionary::new());
    for page in document.get_pages().into_values() {
        document
            .get_dictionary_mut(page)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
    }
    document.save(path).unwrap();
}

fn run_split_pages(input: &Path, output: &Path, instructions: &Path) {
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["split-pages", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--instructions-file")
        .arg(instructions)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
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
    external_tool::tool_path("QPDF_PATH", "qpdf", "qpdf")
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
    write_sparse_linked_source(
        path,
        page_count,
        ocr_source_page_index,
        malformed_source_page_index,
        None,
    )
}

/// `link` names a (from, to) source page pair: the first page carries a link
/// annotation whose destination is the second page.
fn write_sparse_linked_source(
    path: &Path,
    page_count: usize,
    ocr_source_page_index: Option<usize>,
    malformed_source_page_index: Option<usize>,
    link: Option<(usize, usize, LinkTarget)>,
) -> u64 {
    const SPARSE_UNREFERENCED_BYTES: u64 = 600 * 1024 * 1024;
    let first_page_object = 3;
    let last_page_object = first_page_object + page_count - 1;
    let empty_content_object = last_page_object + 1;
    let ocr_content_object = empty_content_object + 1;
    let malformed_content_object = ocr_content_object + 1;
    let font_object = malformed_content_object + 1;
    let indirect_destination_object = font_object + 1;
    let sparse_object = indirect_destination_object + 1;
    let mut offsets = vec![0_u64; sparse_object + 1];
    let mut file = sparse_file::create_sparse_file(path);
    file.write_all(b"%PDF-1.4\n%\x80\x81\x82\x83\n").unwrap();
    // A named link's target is defined in the catalog, where `--empty` drops it.
    let target_page = |to: usize| format!("[{} 0 R/XYZ 0 120 0]", first_page_object + to);
    let catalog = match link {
        Some((_, to, LinkTarget::LegacyNamed | LinkTarget::IndirectLegacyNamed)) => {
            format!(
                "<</Type/Catalog/Pages 2 0 R/Dests<</target{}>>>>",
                target_page(to)
            )
        }
        Some((_, to, LinkTarget::TreeNamed | LinkTarget::IndirectTreeNamed)) => format!(
            "<</Type/Catalog/Pages 2 0 R/Names<</Dests<</Names[(target){}]>>>>>>",
            target_page(to)
        ),
        _ => "<</Type/Catalog/Pages 2 0 R>>".to_owned(),
    };
    write_raw_object(&mut file, &mut offsets, 1, catalog.as_bytes());
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
        let annots = match link {
            Some((from, to, kind)) if from == page_index => {
                let destination = match kind {
                    LinkTarget::Explicit => format!("/Dest{}", target_page(to)),
                    LinkTarget::Action => format!("/A<</S/GoTo/D{}>>", target_page(to)),
                    LinkTarget::LegacyNamed | LinkTarget::TreeNamed => "/Dest(target)".to_owned(),
                    LinkTarget::IndirectLegacyNamed | LinkTarget::IndirectTreeNamed => {
                        format!("/Dest {indirect_destination_object} 0 R")
                    }
                };
                format!("/Annots[<</Type/Annot/Subtype/Link/Rect[2 2 40 20]/Border[0 0 0]{destination}>>]")
            }
            _ => String::new(),
        };
        let page = format!(
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Resources<< /Font<< /F1 {font_object} 0 R>> >>/Contents {content_object} 0 R{annots}>>"
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
    let indirect_destination: &[u8] = match link {
        Some((_, _, LinkTarget::IndirectTreeNamed)) => b"/target",
        _ => b"(target)",
    };
    write_raw_object(
        &mut file,
        &mut offsets,
        indirect_destination_object,
        indirect_destination,
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

/// Page 0 links to each of `target_count` pages, and every target carries
/// `target_bytes` of content. A subset that keeps all the links exceeds the byte
/// budget, so only the link cap lets the conversion succeed.
fn write_sparse_fanout_source(path: &Path, target_count: usize, target_bytes: u64) -> u64 {
    let first_page_object = 3;
    let last_page_object = first_page_object + target_count;
    let empty_content_object = last_page_object + 1;
    let font_object = empty_content_object + 1;
    let first_target_content_object = font_object + 1;
    let last_object = first_target_content_object + target_count - 1;
    let mut offsets = vec![0_u64; last_object + 1];
    let mut file = sparse_file::create_sparse_file(path);
    file.write_all(b"%PDF-1.4\n%\x80\x81\x82\x83\n").unwrap();
    write_raw_object(&mut file, &mut offsets, 1, b"<</Type/Catalog/Pages 2 0 R>>");
    let kids = (first_page_object..=last_page_object)
        .map(|object| format!("{object} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    write_raw_object(
        &mut file,
        &mut offsets,
        2,
        format!("<</Type/Pages/Kids[{kids}]/Count {}>>", target_count + 1).as_bytes(),
    );
    let links = (1..=target_count)
        .map(|to| {
            format!(
                "<</Type/Annot/Subtype/Link/Rect[2 2 40 20]/Border[0 0 0]/Dest[{} 0 R/XYZ 0 120 0]>>",
                first_page_object + to
            )
        })
        .collect::<String>();
    write_raw_object(
        &mut file,
        &mut offsets,
        first_page_object,
        format!(
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Resources<< /Font<< /F1 {font_object} 0 R>> >>/Contents {empty_content_object} 0 R/Annots[{links}]>>"
        )
        .as_bytes(),
    );
    for to in 1..=target_count {
        let content = first_target_content_object + to - 1;
        write_raw_object(
            &mut file,
            &mut offsets,
            first_page_object + to,
            format!("<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Contents {content} 0 R>>")
                .as_bytes(),
        );
    }
    write_raw_object(
        &mut file,
        &mut offsets,
        empty_content_object,
        b"<</Length 0>>\nstream\n\nendstream",
    );
    write_raw_object(
        &mut file,
        &mut offsets,
        font_object,
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    );
    for content in first_target_content_object..=last_object {
        // DCTDecode stops qpdf from recompressing the zero-filled data, so a subset keeps its size.
        *offsets.get_mut(content).unwrap() = file.stream_position().unwrap();
        write!(
            file,
            "{content} 0 obj\n<</Length {target_bytes}/Filter/DCTDecode>>\nstream\n"
        )
        .unwrap();
        file.seek(SeekFrom::Current(i64::try_from(target_bytes).unwrap()))
            .unwrap();
        file.write_all(b"\nendstream\nendobj\n").unwrap();
    }
    let xref_offset = file.stream_position().unwrap();
    let xref_size = last_object + 1;
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
    let mut command = Command::new(external_tool::tool_path(
        "PDFTOTEXT_PATH",
        "poppler",
        "pdftotext",
    ));
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

/// Tesseract's ToUnicode CMap: every two-byte code maps to the same scalar.
const FULL_RANGE_CMAP: &[u8] = b"/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nend\nend";

/// Saves a one-page source showing `text` in a glyph-less Identity-H font, as
/// Tesseract writes it, with `to_unicode` as the font's ToUnicode stream.
fn save_identity_text_source(path: &Path, text: &str, to_unicode: Option<Stream>) -> Document {
    let mut source_document = save_single_page(
        path,
        format!(
            "BT /F1 20 Tf 1 0 0 1 10 80 Tm <{}> Tj ET",
            identity_pdf_text(text)
        )
        .into_bytes(),
        Dictionary::new(),
    );
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
    let mut font = dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "OCR",
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![descendant_id.into()],
    };
    if let Some(to_unicode) = to_unicode {
        font.set("ToUnicode", source_document.add_object(to_unicode));
    }
    let font_id = source_document.add_object(font);
    let source_page_id = *source_document.get_pages().get(&1).unwrap();
    source_document
        .get_dictionary_mut(source_page_id)
        .unwrap()
        .set(
            "Resources",
            dictionary! { "Font" => dictionary! { "F1" => font_id } },
        );
    source_document.save(path).unwrap();
    source_document
}

/// Saves an empty 400x120 target page and an instruction that overlays source
/// page 1 onto it unchanged.
fn save_identity_overlay_target(input: &Path, instructions: &Path) {
    let mut input_document = save_single_page(input, Vec::new(), Dictionary::new());
    let input_page_id = *input_document.get_pages().get(&1).unwrap();
    input_document
        .get_dictionary_mut(input_page_id)
        .unwrap()
        .set("MediaBox", vec![0.into(), 0.into(), 400.into(), 120.into()]);
    input_document.save(input).unwrap();
    write(
        instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}]}"#,
    )
    .unwrap();
}

#[test]
fn overlay_text_repairs_visual_order_without_changing_glyph_positions() {
    let source = path("bidi-text-source", "pdf");
    let input = path("bidi-text-input", "pdf");
    let output = path("bidi-text-output", "pdf");
    let instructions = path("bidi-text-instructions", "json");
    let mut source_document = save_identity_text_source(
        &source,
        "Latin .كلذ 123",
        Some(Stream::new(dictionary! {}, FULL_RANGE_CMAP.to_vec())),
    );
    let source_page_id = *source_document.get_pages().get(&1).unwrap();
    save_identity_overlay_target(&input, &instructions);

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
fn overlay_text_treats_a_tounicode_cmap_past_the_stream_ceiling_as_unreadable() {
    let input = path("oversized-cmap-input", "pdf");
    let instructions = path("oversized-cmap-instructions", "json");
    save_identity_overlay_target(&input, &instructions);
    // A valid CMap padded past the 64 MiB per-stream ceiling is about 64 KB of
    // Flate. Decoded in full it still parses and reorders the RTL text;
    // bounded, the font must be handled as if it had no ToUnicode.
    let mut padded = FULL_RANGE_CMAP.to_vec();
    padded.resize(64 * 1024 * 1024 + 1, b' ');
    let mut oversized = Stream::new(dictionary! {}, padded);
    oversized.compress().unwrap();
    let overlaid_content = |to_unicode: Option<Stream>, label: &str| {
        let source = path(&format!("{label}-source"), "pdf");
        let output = path(&format!("{label}-output"), "pdf");
        save_identity_text_source(&source, "Latin .كلذ 123", to_unicode);
        let result = run_overlay_text(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let document = Document::load(&output).unwrap();
        let content = document.get_page_content(*document.get_pages().get(&1).unwrap());
        for path in [source, output] {
            let _ = remove_file(path);
        }
        String::from_utf8_lossy(&content).into_owned()
    };

    assert_eq!(
        overlaid_content(Some(oversized), "oversized-cmap"),
        overlaid_content(None, "missing-cmap")
    );

    for path in [input, instructions] {
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
fn split_text_filter_measures_each_source_page_with_its_own_font_of_a_shared_name() {
    let source = path("split-shared-name-source", "pdf");
    let input = path("split-shared-name-input", "pdf");
    let output = path("split-shared-name-output", "pdf");
    let instructions = path("split-shared-name-instructions", "json");

    // Both source pages call their font /F1; the second one is half as wide,
    // so its glyphs all start before the seam at x=100.
    let shows = b"BT /F1 10 Tf 3 Tr 1 0 0 1 80 90 Tm (ABCD) Tj ET".to_vec();
    let mut source_document = save_two_pages(
        &source,
        [shows.clone(), shows],
        dictionary! { "Font" => dictionary! { "F1" => measurable_helvetica_font() } },
    );
    let mut narrow = measurable_helvetica_font();
    narrow.set(
        "Widths",
        (0..256).map(|_| Object::Integer(500)).collect::<Vec<_>>(),
    );
    let second_page = *source_document.get_pages().get(&2).unwrap();
    source_document
        .get_dictionary_mut(second_page)
        .unwrap()
        .set(
            "Resources",
            dictionary! { "Font" => dictionary! { "F1" => narrow } },
        );
    source_document.save(&source).unwrap();
    let mut target = save_pages(&input, (0..4).map(|_| Some(Vec::new())), Dictionary::new());
    for page_id in target.get_pages().into_values() {
        target
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
    }
    target.save(&input).unwrap();
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},{"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"filterToOutputPage":true},{"sourcePageIndex":1,"outputPageIndex":2,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},{"sourcePageIndex":1,"outputPageIndex":3,"matrix":[1,0,0,1,-100,0],"filterToOutputPage":true}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let text =
        |page| String::from_utf8_lossy(&pdftotext_page(&output, page, &[]).stdout).into_owned();
    let (wide_left, wide_right, narrow_left, narrow_right) = (text(1), text(2), text(3), text(4));
    assert!(
        wide_left.contains("AB") && !wide_left.contains('C'),
        "{wide_left}"
    );
    assert!(
        wide_right.contains("CD") && !wide_right.contains('B'),
        "{wide_right}"
    );
    assert!(narrow_left.contains("ABCD"), "{narrow_left}");
    assert!(!narrow_right.contains('D'), "{narrow_right}");

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
fn overlay_text_keeps_a_link_across_source_subsets_above_the_byte_budget() {
    for kind in [
        LinkTarget::Explicit,
        LinkTarget::LegacyNamed,
        LinkTarget::TreeNamed,
        LinkTarget::IndirectLegacyNamed,
        LinkTarget::IndirectTreeNamed,
    ] {
        assert_link_survives_source_subsets(kind);
    }
}

fn assert_link_survives_source_subsets(kind: LinkTarget) {
    const LINK_SOURCE_PAGE_INDEX: usize = 0;
    const LINK_TARGET_PAGE_INDEX: usize = 1_234;
    let source = path("large-source-cross-subset-link", "pdf");
    let input = path("large-source-cross-subset-link-input", "pdf");
    let output = path("large-source-cross-subset-link-output", "pdf");
    let instructions = path("large-source-cross-subset-link-instructions", "json");
    let source_len = write_sparse_linked_source(
        &source,
        1_235,
        Some(LINK_TARGET_PAGE_INDEX),
        None,
        Some((LINK_SOURCE_PAGE_INDEX, LINK_TARGET_PAGE_INDEX, kind)),
    );
    assert!(source_len > 512 * 1024 * 1024);
    save_empty_pages(&input, 66);
    // Source pages 0..=64 span two 64-page subsets; the link target is in a third.
    let mut page_instructions = (0..65)
        .map(|page_index| {
            format!(
                r#"{{"sourcePageIndex":{page_index},"outputPageIndex":{page_index},"matrix":[1,0,0,1,0,0]}}"#
            )
        })
        .collect::<Vec<_>>();
    page_instructions.push(format!(
        r#"{{"sourcePageIndex":{LINK_TARGET_PAGE_INDEX},"outputPageIndex":65,"matrix":[1,0,0,1,0,0]}}"#
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
    let overlaid = Document::load(&output).unwrap();
    let pages = overlaid.get_pages();
    let target_page_id = *pages.get(&66).unwrap();
    let link_page_id = *pages.get(&1).unwrap();
    let annotations = overlaid
        .get_dictionary(link_page_id)
        .unwrap()
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap()
        .clone();
    let destination = annotations
        .iter()
        .find_map(|annotation| {
            overlaid
                .dereference(annotation)
                .unwrap()
                .1
                .as_dict()
                .unwrap()
                .get(b"Dest")
                .ok()
                .cloned()
        })
        .expect("the link keeps its destination across the subset boundary");
    assert_eq!(
        destination.as_array().unwrap()[0].as_reference().unwrap(),
        target_page_id
    );
    // The target page's text comes from its own subset only, not from the
    // subset that holds it as a link destination.
    let text = pdftotext_page(&output, 66, &[]);
    assert_eq!(
        String::from_utf8_lossy(&text.stdout)
            .matches("HIGH INDEX OCR")
            .count(),
        1
    );

    for path in [source, input, output, instructions] {
        let _ = remove_file(path);
    }
}

#[test]
fn overlay_text_caps_the_link_targets_one_source_subset_adds() {
    // One subset adds at most MAX_SOURCE_PAGE_BATCH_PAGES (64) link targets.
    const LINK_TARGET_COUNT: usize = 80;
    const LINK_TARGET_BYTES: u64 = 7 * 1024 * 1024;
    const CAPPED_LINK_COUNT: usize = 64;
    let source = path("large-source-link-fanout", "pdf");
    let input = path("large-source-link-fanout-input", "pdf");
    let output = path("large-source-link-fanout-output", "pdf");
    let instructions = path("large-source-link-fanout-instructions", "json");
    let source_len = write_sparse_fanout_source(&source, LINK_TARGET_COUNT, LINK_TARGET_BYTES);
    assert!(source_len > 512 * 1024 * 1024);
    save_empty_pages(&input, LINK_TARGET_COUNT + 1);
    let mut page_instructions =
        vec![r#"{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}"#.to_owned()];
    page_instructions.extend((1..=LINK_TARGET_COUNT).map(|page_index| {
        format!(
            r#"{{"sourcePageIndex":{page_index},"outputPageIndex":{page_index},"matrix":[1,0,0,1,0,0],"linkOnly":true}}"#
        )
    }));
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
    let overlaid = Document::load(&output).unwrap();
    let link_page_id = *overlaid.get_pages().get(&1).unwrap();
    let annotations = overlaid
        .get_dictionary(link_page_id)
        .unwrap()
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap()
        .clone();
    // Every link keeps its annotation; only the links past the cap lose their destination.
    assert_eq!(annotations.len(), LINK_TARGET_COUNT);
    let destinations = annotations
        .iter()
        .filter(|annotation| {
            overlaid
                .dereference(annotation)
                .unwrap()
                .1
                .as_dict()
                .unwrap()
                .get(b"Dest")
                .is_ok()
        })
        .count();
    assert_eq!(destinations, CAPPED_LINK_COUNT);

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

fn helvetica() -> Dictionary {
    dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" }
}

fn save_ocr_page(
    path: &Path,
    media_box: [i64; 4],
    rotate: Option<i64>,
    contents: Vec<Vec<u8>>,
    resources: Dictionary,
) {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let content_ids = contents
        .into_iter()
        .map(|content| Object::Reference(document.add_object(Stream::new(dictionary! {}, content))))
        .collect::<Vec<_>>();
    let mut page = dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => media_box.iter().map(|value| Object::Integer(*value)).collect::<Vec<_>>(),
        "Resources" => resources,
        "Contents" => content_ids,
    };
    if let Some(rotate) = rotate {
        page.set("Rotate", rotate);
    }
    let page_id = document.add_object(page);
    document.objects.insert(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 }
            .into(),
    );
    let catalog_id = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    document.trailer.set("Root", catalog_id);
    document.save(path).unwrap();
}

fn run_ocr_text_layer(input: &Path, output: &Path, source: &Path) -> std::process::Output {
    let instructions = path("ocr-instructions", "json");
    fs::write(
        &instructions,
        serde_json::json!({"pages": [{"pageNumber": 1, "sourcePath": source}]}).to_string(),
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["ocr-text-layer", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--instructions-file")
        .arg(&instructions)
        .output()
        .unwrap();
    let _ = fs::remove_file(instructions);
    result
}

fn pdftotext_all(pdf: &Path, extra_args: &[&str]) -> String {
    let output = Command::new(external_tool::tool_path(
        "PDFTOTEXT_PATH",
        "poppler",
        "pdftotext",
    ))
    .args(extra_args)
    .arg(pdf)
    .arg("-")
    .output()
    .expect("pdftotext must be installed for OCR text-layer integration tests");
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap()
}

fn page_content(pdf: &Path) -> String {
    let document = Document::load(pdf).unwrap();
    let page_id = *document.get_pages().get(&1).unwrap();
    String::from_utf8_lossy(&document.get_page_content(page_id)).into_owned()
}

fn page_content_stream_count(pdf: &Path) -> usize {
    let document = Document::load(pdf).unwrap();
    let page_id = *document.get_pages().get(&1).unwrap();
    document.get_page_contents(page_id).len()
}

#[test]
fn replaces_previous_ocr_text_and_keeps_the_page_ink() {
    let source = path("ocr-source", "pdf");
    let input = path("ocr-input", "pdf");
    let output = path("ocr-output", "pdf");
    save_ocr_page(
        &source,
        [0, 0, 200, 120],
        None,
        vec![b"BT /F1 12 Tf 3 Tr 10 60 Td (Recognized words) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );
    save_ocr_page(
        &input,
        [0, 0, 200, 120],
        None,
        vec![
            // Page ink and another producer's hidden layer in one stream.
            b"0 0 10 10 re f BT /F1 12 Tf 3 Tr 10 90 Td (Foreign layer) Tj ET".to_vec(),
            b"% EVB_VIEWER_OCR_LAYER_BEGIN\nBT /F1 12 Tf 3 Tr 10 30 Td (Previous run) Tj ET\n% EVB_VIEWER_OCR_LAYER_END\n"
                .to_vec(),
        ],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );

    let result = run_ocr_text_layer(&input, &output, &source);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let text = pdftotext_all(&output, &[]);
    assert!(text.contains("Recognized words"), "{text}");
    assert!(!text.contains("Foreign layer"), "{text}");
    assert!(!text.contains("Previous run"), "{text}");
    let content = page_content(&output);
    assert!(content.contains("re"), "page ink was removed: {content}");
    assert!(content.contains("EVB_VIEWER_OCR_LAYER_BEGIN"), "{content}");
    // One incremental revision: the original bytes are a prefix.
    let (original, written) = (fs::read(&input).unwrap(), fs::read(&output).unwrap());
    assert!(written.starts_with(&original));
    assert_eq!(run_ocr_text_visibility(&output)["evbOcrLayer"], true);

    // Running again replaces the layer written above instead of stacking it.
    let rerun = path("ocr-rerun", "pdf");
    let result = run_ocr_text_layer(&output, &rerun, &source);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        pdftotext_all(&rerun, &[])
            .matches("Recognized words")
            .count(),
        1
    );

    for file in [source, input, output, rerun] {
        let _ = fs::remove_file(file);
    }
}

#[test]
fn places_words_in_the_displayed_orientation_of_a_rotated_page() {
    let source = path("rotated-source", "pdf");
    let input = path("rotated-input", "pdf");
    let output = path("rotated-output", "pdf");
    // The page is 200 wide and 120 tall, shown turned a quarter clockwise.
    // Tesseract saw a raster of the displayed page: 120 wide, 200 tall, here
    // at twice the point size. A word near its top-left corner must land
    // near the top-left corner of the displayed page.
    save_ocr_page(
        &source,
        [0, 0, 240, 400],
        None,
        vec![b"BT /F1 24 Tf 3 Tr 20 360 Td (Corner) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );
    save_ocr_page(
        &input,
        [0, 0, 200, 120],
        Some(90),
        vec![Vec::new()],
        Dictionary::new(),
    );

    let result = run_ocr_text_layer(&input, &output, &source);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let bbox = pdftotext_all(&output, &["-bbox"]);
    let tag = bbox
        .lines()
        .find(|line| line.contains(">Corner</word>"))
        .unwrap_or_else(|| panic!("word is absent: {bbox}"));
    let attribute = |name: &str| -> f64 {
        let value = tag.split_once(&format!("{name}=\"")).unwrap().1;
        value[..value.find('"').unwrap()].parse().unwrap()
    };
    assert!((attribute("xMin") - 10.0).abs() < 1.0, "{tag}");
    assert!(attribute("yMax") < 25.0, "{tag}");

    for file in [source, input, output] {
        let _ = fs::remove_file(file);
    }
}

#[test]
fn keeps_the_ink_of_a_scale_that_an_old_ocr_stream_only_sets() {
    let source = path("state-only-source", "pdf");
    let input = path("state-only-input", "pdf");
    let output = path("state-only-output", "pdf");
    save_ocr_page(
        &source,
        [0, 0, 200, 120],
        None,
        vec![b"BT /F1 12 Tf 3 Tr 10 60 Td (Recognized) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );
    // The first stream's hidden text is the only thing it paints. It scales
    // the second stream's red square to 20 by 20 points, so the square must
    // still cover 400 pixels once the old text is gone.
    save_ocr_page(
        &input,
        [0, 0, 200, 120],
        None,
        vec![
            b"q 2 0 0 2 0 0 cm BT /F1 12 Tf 3 Tr 10 20 Td (old OCR) Tj ET".to_vec(),
            b"1 0 0 rg 0 0 10 10 re f Q".to_vec(),
        ],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );

    let result = run_ocr_text_layer(&input, &output, &source);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let text = pdftotext_all(&output, &[]);
    assert!(text.contains("Recognized"), "{text}");
    assert!(!text.contains("old OCR"), "{text}");
    let before = red_pixels(&input).len();
    let after = red_pixels(&output).len();
    assert_eq!(before, 400);
    assert_eq!(after, before, "the square changed size");

    for file in [source, input, output] {
        let _ = fs::remove_file(file);
    }
}

#[test]
fn keeps_the_spacing_a_removed_hidden_quote_show_sets_for_later_text() {
    let source = path("quote-spacing-source", "pdf");
    let input = path("quote-spacing-input", "pdf");
    let output = path("quote-spacing-output", "pdf");
    save_ocr_page(
        &source,
        [0, 0, 200, 120],
        None,
        vec![b"BT /F1 12 Tf 3 Tr 10 60 Td (Recognized) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );
    // The hidden `"` sets word and character spacing that the red text after
    // it paints with. Replacing the OCR must leave that text where it was.
    save_ocr_page(
        &input,
        [0, 0, 200, 120],
        None,
        vec![
            b"BT /F1 12 Tf 3 Tr 0 0 Td 10 5 (old OCR) \" ET".to_vec(),
            b"1 0 0 rg BT /F1 12 Tf 0 Tr 10 40 Td (A A) Tj ET".to_vec(),
        ],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );

    let result = run_ocr_text_layer(&input, &output, &source);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let text = pdftotext_all(&output, &[]);
    assert!(text.contains("Recognized"), "{text}");
    assert!(!text.contains("old OCR"), "{text}");
    let before = red_pixels(&input);
    assert!(!before.is_empty());
    assert_eq!(red_pixels(&output), before, "visible text moved");

    for file in [source, input, output] {
        let _ = fs::remove_file(file);
    }
}

#[test]
fn places_words_where_the_page_leaves_a_transform_open() {
    let source = path("open-transform-source", "pdf");
    save_ocr_page(
        &source,
        [0, 0, 200, 120],
        None,
        vec![b"BT /F1 12 Tf 3 Tr 10 60 Td (Recognized) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );
    // The page ends with a scale it never restores, as a placed image leaves it.
    // The second page holds an extra Q, which a reader ignores, after the scale.
    for (label, content) in [
        ("open-transform", &b"200 0 0 120 0 0 cm 0 0 1 1 re f"[..]),
        ("unbalanced-restore", &b"2 0 0 2 0 0 cm Q 0 0 1 1 re f"[..]),
    ] {
        let input = path(label, "pdf");
        let output = path(&format!("{label}-output"), "pdf");
        save_ocr_page(
            &input,
            [0, 0, 200, 120],
            None,
            vec![content.to_vec()],
            Dictionary::new(),
        );

        let result = run_ocr_text_layer(&input, &output, &source);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );

        let bbox = pdftotext_all(&output, &["-bbox"]);
        let x = bbox_word_x(&bbox, "Recognized");
        assert!(
            (x - 10.0).abs() < 1.0,
            "{label}: word moved to x={x}: {bbox}"
        );

        for file in [input, output] {
            let _ = fs::remove_file(file);
        }
    }
    let _ = fs::remove_file(source);
}

/// One page whose resources hold a Form XObject `/Fm0` with `form_content`
/// and an image `/Im0` the form and the page may both draw.
fn save_ocr_page_with_form(path: &Path, contents: Vec<Vec<u8>>, form_content: &[u8]) {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let image_id = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        },
        vec![0],
    ));
    let fonts = dictionary! { "F1" => helvetica() };
    let form_id = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
            "Resources" => dictionary! { "Font" => fonts.clone(), "XObject" => dictionary! { "Im0" => image_id } },
        },
        form_content.to_vec(),
    ));
    let content_ids = contents
        .into_iter()
        .map(|content| Object::Reference(document.add_object(Stream::new(dictionary! {}, content))))
        .collect::<Vec<_>>();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
        "Resources" => dictionary! {
            "Font" => fonts,
            "XObject" => dictionary! { "Fm0" => form_id, "Im0" => image_id },
        },
        "Contents" => content_ids,
    });
    document.objects.insert(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 }
            .into(),
    );
    let catalog_id = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    document.trailer.set("Root", catalog_id);
    document.save(path).unwrap();
}

fn run_ocr_text_visibility(input: &Path) -> serde_json::Value {
    let pages = path("ocr-visibility-pages", "txt");
    fs::write(&pages, "1\n").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["ocr-text-visibility", "--input"])
        .arg(input)
        .arg("--pages-file")
        .arg(&pages)
        .arg("--with-evb-ocr-text")
        .output()
        .unwrap();
    let _ = fs::remove_file(pages);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["format"], "evb-pdf-ocr-text-visibility");
    report["pages"][0].clone()
}

fn visibility(
    evb_ocr_layer: bool,
    painted_text: bool,
    hidden_text: bool,
    uncertain: Option<&str>,
    unsupported: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "pageNumber": 1,
        "evbOcrLayer": evb_ocr_layer,
        "paintedText": painted_text,
        "hiddenText": hidden_text,
        "uncertain": uncertain,
        "unsupported": unsupported,
        "evbOcrLines": null,
    })
}

const CLIPPING: &str = "text clipping rendering modes cannot be replaced safely";
const MIXED_OBJECT: &str = "hidden and visible text share one text object";
const FORM_HIDDEN: &str = "hidden text inside a Form XObject is not removed by OCR replacement";

#[test]
fn reports_existing_page_text_the_way_a_reader_paints_it() {
    let cases: [(&str, Vec<&[u8]>, serde_json::Value); 7] = [
        (
            "Q restores visible text after a hidden object",
            vec![b"q BT /F1 12 Tf 3 Tr 10 90 Td (a) Tj ET Q BT /F1 12 Tf 10 30 Td (b) Tj ET"],
            visibility(false, true, true, None, None),
        ),
        (
            "a saved mode is restored in the next content stream",
            vec![
                b"q BT /F1 12 Tf 3 Tr 10 90 Td (a) Tj ET",
                b"Q BT /F1 12 Tf 10 30 Td (b) Tj ET",
            ],
            visibility(false, true, true, None, None),
        ),
        (
            "a comment is not hidden text",
            vec![b"% BT 3 Tr (fake) Tj ET\nBT /F1 12 Tf 10 30 Td (real) Tj ET"],
            visibility(false, true, false, None, None),
        ),
        (
            "clip-only text paints nothing and cannot be replaced",
            vec![b"BT /F1 12 Tf 7 Tr 10 30 Td (a) Tj ET"],
            visibility(false, false, false, None, Some(CLIPPING)),
        ),
        (
            "hidden and visible text in one text object",
            vec![b"BT /F1 12 Tf 3 Tr 10 90 Td (a) Tj 0 Tr (b) Tj ET"],
            visibility(false, true, true, None, Some(MIXED_OBJECT)),
        ),
        (
            "an EVB layer beside page ink",
            vec![
                b"0 0 10 10 re f",
                b"% EVB_VIEWER_OCR_LAYER_BEGIN\nq\nBT /F1 12 Tf 3 Tr (x) Tj ET\nQ\n% EVB_VIEWER_OCR_LAYER_END\n",
            ],
            visibility(true, false, false, None, None),
        ),
        (
            "a comment naming the marker is not an EVB layer",
            vec![b"% copied from EVB_VIEWER_OCR_LAYER_BEGIN\nBT /F1 12 Tf 10 30 Td (visible) Tj ET"],
            visibility(false, true, false, None, None),
        ),
    ];
    for (label, contents, expected) in cases {
        let input = path("ocr-visibility", "pdf");
        save_ocr_page(
            &input,
            [0, 0, 200, 120],
            None,
            contents.into_iter().map(<[u8]>::to_vec).collect(),
            dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
        );
        assert_eq!(run_ocr_text_visibility(&input), expected, "{label}");
        let _ = fs::remove_file(input);
    }
}

#[test]
fn reads_the_text_of_the_form_xobjects_a_page_draws() {
    let cases: [(&str, &[u8], &[u8], serde_json::Value); 7] = [
        (
            "a scan wrapped in a form under a hidden layer is a replaceable layer",
            b"q /Fm0 Do Q BT /F1 12 Tf 3 Tr 10 30 Td (layer) Tj ET",
            b"q 200 0 0 120 0 0 cm /Im0 Do Q",
            visibility(false, false, true, None, None),
        ),
        (
            "visible text in a form is painted text",
            b"q /Fm0 Do Q BT /F1 12 Tf 3 Tr 10 30 Td (layer) Tj ET",
            b"BT /F1 12 Tf 10 90 Td (stamp) Tj ET",
            visibility(false, true, true, None, None),
        ),
        (
            "hidden text in a form stays when the page is replaced",
            b"q /Fm0 Do Q",
            b"BT /F1 12 Tf 3 Tr 10 90 Td (form layer) Tj ET",
            visibility(false, false, false, Some(FORM_HIDDEN), None),
        ),
        (
            "a form inherits the hidden mode of the content drawing it",
            b"3 Tr /Fm0 Do",
            b"BT /F1 12 Tf 10 90 Td (inherited) Tj ET",
            visibility(false, false, false, Some(FORM_HIDDEN), None),
        ),
        (
            "a form drawn hidden and then visible paints its text",
            b"q 3 Tr /Fm0 Do Q /Fm0 Do",
            b"BT /F1 12 Tf 10 90 Td (stamp) Tj ET",
            visibility(false, true, false, Some(FORM_HIDDEN), None),
        ),
        (
            "a form drawn visible and then hidden keeps hidden text",
            b"/Fm0 Do 3 Tr /Fm0 Do",
            b"BT /F1 12 Tf 10 90 Td (stamp) Tj ET",
            visibility(false, true, false, Some(FORM_HIDDEN), None),
        ),
        (
            "an earlier EVB layer drawn as a form is recognized without reading the form",
            b"% EVB_VIEWER_OCR_LAYER_BEGIN\nq\n/Fm0 Do\nQ\n% EVB_VIEWER_OCR_LAYER_END",
            b"BT /F1 12 Tf 3 Tr 10 90 Td (old layer) Tj ET",
            visibility(true, false, false, None, None),
        ),
    ];
    for (label, page_content, form_content, expected) in cases {
        let input = path("ocr-visibility-form", "pdf");
        save_ocr_page_with_form(&input, vec![page_content.to_vec()], form_content);
        assert_eq!(run_ocr_text_visibility(&input), expected, "{label}");
        let _ = fs::remove_file(input);
    }
}

#[test]
fn the_writer_refuses_exactly_the_pages_the_inspection_reports_unsupported() {
    let source = path("ocr-agreement-source", "pdf");
    save_ocr_page(
        &source,
        [0, 0, 200, 120],
        None,
        vec![b"BT /F1 12 Tf 3 Tr 10 60 Td (Recognized words) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );
    for (content, unsupported) in [
        (&b"BT /F1 12 Tf 7 Tr 10 30 Td (a) Tj ET"[..], Some(CLIPPING)),
        (
            b"BT /F1 12 Tf 3 Tr 10 90 Td (a) Tj 0 Tr (b) Tj ET",
            Some(MIXED_OBJECT),
        ),
        (
            b"q BT /F1 12 Tf 3 Tr 10 90 Td (Stale) Tj ET Q BT /F1 12 Tf 10 30 Td (Authored) Tj ET",
            None,
        ),
    ] {
        let input = path("ocr-agreement-input", "pdf");
        let output = path("ocr-agreement-output", "pdf");
        save_ocr_page(
            &input,
            [0, 0, 200, 120],
            None,
            vec![content.to_vec()],
            dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
        );
        let reported = run_ocr_text_visibility(&input)["unsupported"].clone();
        let result = run_ocr_text_layer(&input, &output, &source);
        match unsupported {
            Some(reason) => {
                assert_eq!(reported, reason);
                assert!(!result.status.success());
                assert!(
                    String::from_utf8_lossy(&result.stderr).contains(reason),
                    "{}",
                    String::from_utf8_lossy(&result.stderr)
                );
            }
            None => {
                assert_eq!(reported, serde_json::Value::Null);
                assert!(
                    result.status.success(),
                    "{}",
                    String::from_utf8_lossy(&result.stderr)
                );
                // The hidden object is removed and the visible one stays.
                let text = pdftotext_all(&output, &[]);
                assert!(
                    text.contains("Authored") && !text.contains("Stale"),
                    "{text}"
                );
            }
        }
        for file in [input, output] {
            let _ = fs::remove_file(file);
        }
    }
    let _ = fs::remove_file(source);
}

#[test]
fn keeps_page_content_that_only_mentions_the_ocr_marker() {
    let source = path("ocr-marker-source", "pdf");
    let input = path("ocr-marker-input", "pdf");
    let output = path("ocr-marker-output", "pdf");
    save_ocr_page(
        &source,
        [0, 0, 200, 120],
        None,
        vec![b"BT /F1 12 Tf 3 Tr 10 60 Td (Recognized words) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );
    save_ocr_page(
        &input,
        [0, 0, 200, 120],
        None,
        vec![b"% notes about EVB_VIEWER_OCR_LAYER_BEGIN\nBT /F1 12 Tf 10 90 Td (Authored heading) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );

    let result = run_ocr_text_layer(&input, &output, &source);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let text = pdftotext_all(&output, &[]);
    assert!(text.contains("Authored heading"), "{text}");
    assert!(text.contains("Recognized words"), "{text}");

    for file in [source, input, output] {
        let _ = fs::remove_file(file);
    }
}

#[test]
fn keeps_page_ink_in_a_stream_that_an_evb_layer_shares() {
    let source = path("shared-layer-source", "pdf");
    let input = path("shared-layer-input", "pdf");
    let output = path("shared-layer-output", "pdf");
    save_ocr_page(
        &source,
        [0, 0, 400, 240],
        None,
        vec![b"BT /F1 12 Tf 3 Tr 10 60 Td (Recognized) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );
    // qpdf --coalesce-contents joins a page's streams and keeps the layer's
    // comment lines, so one stream holds the page's ink and a whole layer. The
    // stream does not begin and end with the layer's markers, so it is not one.
    save_ocr_page(
        &input,
        [0, 0, 200, 120],
        None,
        vec![b"1 0 0 rg 0 0 10 10 re f\n% EVB_VIEWER_OCR_LAYER_BEGIN\nq\n2 0 0 2 0 0 cm\nBT /F1 12 Tf 3 Tr 10 20 Td (old OCR) Tj ET\nQ\n% EVB_VIEWER_OCR_LAYER_END\n".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );

    let result = run_ocr_text_layer(&input, &output, &source);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let text = pdftotext_all(&output, &[]);
    assert!(text.contains("Recognized"), "{text}");
    assert!(!text.contains("old OCR"), "{text}");
    let before = red_pixels(&input);
    assert_eq!(before.len(), 100);
    assert_eq!(red_pixels(&output), before, "page ink changed");

    for file in [source, input, output] {
        let _ = fs::remove_file(file);
    }
}

#[test]
fn replacing_a_written_layer_removes_it_whole_and_keeps_the_page_ink() {
    let source = path("written-layer-source", "pdf");
    let input = path("written-layer-input", "pdf");
    let written = path("written-layer-written", "pdf");
    let replaced = path("written-layer-replaced", "pdf");
    // The raster is twice the page's size, so the layer maps it at one half.
    // A scale the layer left open would shrink the ink that follows it.
    save_ocr_page(
        &source,
        [0, 0, 400, 240],
        None,
        vec![b"BT /F1 12 Tf 3 Tr 10 60 Td (Recognized) Tj ET".to_vec()],
        dictionary! { "Font" => dictionary! { "F1" => helvetica() } },
    );
    save_ocr_page(
        &input,
        [0, 0, 200, 120],
        None,
        vec![b"1 0 0 rg 0 0 10 10 re f".to_vec()],
        Dictionary::new(),
    );
    let before = red_pixels(&input);
    assert_eq!(before.len(), 100);

    // The layer is written in front of the page's content, so a graphics state
    // it leaves open would move the ink that follows it.
    let result = run_ocr_text_layer(&input, &written, &source);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        red_pixels(&written),
        before,
        "the written layer moved the page ink"
    );

    // Replacing the layer removes it whole: the page keeps two streams, the new
    // layer and the ink, and the ink stays where it was.
    let result = run_ocr_text_layer(&written, &replaced, &source);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        red_pixels(&replaced),
        before,
        "replacing the layer moved the page ink"
    );
    assert_eq!(
        pdftotext_all(&replaced, &[]).matches("Recognized").count(),
        1
    );
    assert_eq!(
        page_content_stream_count(&replaced),
        2,
        "the replaced layer left a stream behind"
    );

    for file in [source, input, written, replaced] {
        let _ = fs::remove_file(file);
    }
}

#[test]
fn overlay_links_target_output_pages_without_copying_source_page_trees() {
    for action in [false, true] {
        let source = path("link-source", "pdf");
        let input = path("link-input", "pdf");
        let output = path("link-output", "pdf");
        let instructions = path("link-instructions", "json");
        let mut document = save_two_pages(&source, [Vec::new(), Vec::new()], Dictionary::new());
        let source_pages = document.get_pages().into_values().collect::<Vec<_>>();
        for index in 0..2 {
            let destination = vec![source_pages[1 - index].into(), "Fit".into()];
            let mut link = dictionary! {
                "Type" => "Annot", "Subtype" => "Link", "P" => source_pages[index],
                "Rect" => vec![20.into(), 20.into(), 80.into(), 40.into()],
            };
            if action {
                link.set("A", dictionary! {"S" => "GoTo", "D" => destination});
            } else {
                link.set("Dest", destination);
            }
            let link_id = document.add_object(link);
            document
                .get_dictionary_mut(source_pages[index])
                .unwrap()
                .set("Annots", vec![Object::Reference(link_id)]);
        }
        document.save(&source).unwrap();
        save_empty_pages(&input, 2);
        write(&instructions, r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,0,0]},{"sourcePageIndex":1,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}]}"#).unwrap();
        let result = run_overlay_text(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let saved = Document::load(&output).unwrap();
        let pages = saved.get_pages().into_values().collect::<Vec<_>>();
        for index in 0..2 {
            let annots = saved
                .get_dictionary(pages[index])
                .unwrap()
                .get(b"Annots")
                .unwrap()
                .as_array()
                .unwrap();
            let link = saved
                .get_dictionary(annots[0].as_reference().unwrap())
                .unwrap();
            let destination = if action {
                link.get(b"A")
                    .unwrap()
                    .as_dict()
                    .unwrap()
                    .get(b"D")
                    .unwrap()
            } else {
                link.get(b"Dest").unwrap()
            };
            assert_eq!(
                destination.as_array().unwrap()[0].as_reference().unwrap(),
                pages[1 - index]
            );
        }
        assert_eq!(
            saved
                .objects
                .values()
                .filter(|object| object.as_dict().is_ok_and(|dictionary| dictionary
                    .get(b"Type")
                    .and_then(Object::as_name)
                    .is_ok_and(|name| name == b"Page")))
                .count(),
            2
        );
        for file in [source, input, output, instructions] {
            let _ = remove_file(file);
        }
    }
}

/// Which navigation a test link carries, and where the source catalog keeps
/// the destination it names.
#[derive(Clone, Copy)]
enum LinkTarget {
    /// An explicit destination array on the link.
    Explicit,
    /// A name, resolved through the legacy catalog /Dests dictionary.
    LegacyNamed,
    /// A name, resolved through the /Names /Dests name tree.
    TreeNamed,
    /// A GoTo action whose destination is an explicit array.
    Action,
    /// An indirect string naming a legacy catalog /Dests entry.
    IndirectLegacyNamed,
    /// An indirect name naming a /Names /Dests name-tree entry.
    IndirectTreeNamed,
}

fn add_catalog_entry(document: &mut Document, key: &str, value: Object) {
    let root = document
        .trailer
        .get(b"Root")
        .unwrap()
        .as_reference()
        .unwrap();
    document.get_dictionary_mut(root).unwrap().set(key, value);
}

/// Saves two source pages, where page 0 links to page 1 by `target`. A
/// `target` name is defined in the catalog unless the test leaves it dangling.
fn save_link_source(path: &Path, target: LinkTarget, defined: bool) {
    let mut document = save_two_pages(path, [Vec::new(), Vec::new()], Dictionary::new());
    let pages = document.get_pages().into_values().collect::<Vec<_>>();
    let explicit = vec![pages[1].into(), "Fit".into()];
    let mut link = dictionary! {
        "Type" => "Annot", "Subtype" => "Link", "P" => pages[0],
        "Rect" => vec![20.into(), 20.into(), 80.into(), 40.into()],
    };
    let name = Object::String(b"target".to_vec(), lopdf::StringFormat::Literal);
    match target {
        LinkTarget::Explicit => link.set("Dest", explicit.clone()),
        LinkTarget::Action => link.set("A", dictionary! {"S" => "GoTo", "D" => explicit.clone()}),
        LinkTarget::LegacyNamed | LinkTarget::TreeNamed => link.set("Dest", name.clone()),
        LinkTarget::IndirectLegacyNamed | LinkTarget::IndirectTreeNamed => {
            let named = document.add_object(name.clone());
            link.set("Dest", Object::Reference(named));
        }
    }
    if defined {
        match target {
            LinkTarget::LegacyNamed | LinkTarget::IndirectLegacyNamed => {
                add_catalog_entry(
                    &mut document,
                    "Dests",
                    dictionary! {"target" => explicit}.into(),
                );
            }
            LinkTarget::TreeNamed | LinkTarget::IndirectTreeNamed => {
                let tree = dictionary! {"Names" => vec![name, explicit.into()]};
                add_catalog_entry(
                    &mut document,
                    "Names",
                    dictionary! {"Dests" => dictionary! {"Kids" => vec![Object::Dictionary(tree)]}}
                        .into(),
                );
            }
            _ => {}
        }
    }
    let link_id = document.add_object(link);
    document
        .get_dictionary_mut(pages[0])
        .unwrap()
        .set("Annots", vec![Object::Reference(link_id)]);
    document.save(path).unwrap();
}

#[test]
fn overlay_maps_a_link_to_an_output_page_that_copies_no_text() {
    for page_geometry in [
        r#""linkOnly":true"#,
        r#""linkOnly":true,"unmappedGeometry":true"#,
    ] {
        let source = path("link-only-source", "pdf");
        let input = path("link-only-input", "pdf");
        let output = path("link-only-output", "pdf");
        let instructions = path("link-only-instructions", "json");
        save_link_source(&source, LinkTarget::Explicit, true);
        save_empty_pages(&input, 2);
        // Output page 2 is a source page with no text: it only receives the link.
        write(&instructions, format!(r#"{{"pages":[{{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}},{{"sourcePageIndex":1,"outputPageIndex":1,"matrix":[1,0,0,1,0,0],{page_geometry}}}]}}"#)).unwrap();
        let result = run_overlay_text(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let saved = Document::load(&output).unwrap();
        let pages = saved.get_pages().into_values().collect::<Vec<_>>();
        let annots = saved
            .get_dictionary(pages[0])
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        let link = saved
            .get_dictionary(annots[0].as_reference().unwrap())
            .unwrap();
        let destination = link.get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(destination[0].as_reference().unwrap(), pages[1]);
        assert_eq!(destination[1].as_name().unwrap(), b"Fit");
        for file in [source, input, output, instructions] {
            let _ = remove_file(file);
        }
    }
}

#[test]
fn overlay_resolves_named_destinations_to_the_output_page_they_name() {
    for target in [LinkTarget::LegacyNamed, LinkTarget::TreeNamed] {
        let source = path("named-link-source", "pdf");
        let input = path("named-link-input", "pdf");
        let output = path("named-link-output", "pdf");
        let instructions = path("named-link-instructions", "json");
        save_link_source(&source, target, true);
        save_empty_pages(&input, 2);
        write(&instructions, r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]},{"sourcePageIndex":1,"outputPageIndex":1,"matrix":[1,0,0,1,0,0]}]}"#).unwrap();
        let result = run_overlay_text(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let saved = Document::load(&output).unwrap();
        let pages = saved.get_pages().into_values().collect::<Vec<_>>();
        let annots = saved
            .get_dictionary(pages[0])
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        let link = saved
            .get_dictionary(annots[0].as_reference().unwrap())
            .unwrap();
        let destination = link.get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(destination[0].as_reference().unwrap(), pages[1]);
        assert_eq!(destination[1].as_name().unwrap(), b"Fit");
        for file in [source, input, output, instructions] {
            let _ = remove_file(file);
        }
    }
}

/// Two pages that link to each other. Each link names the point (100, 60) on
/// the other page.
fn save_retained_link_source(path: &Path) {
    let mut document = save_two_pages(path, [Vec::new(), Vec::new()], Dictionary::new());
    let pages = document.get_pages().into_values().collect::<Vec<_>>();
    for (from, to) in [(0, 1), (1, 0)] {
        let link = dictionary! {
            "Type" => "Annot", "Subtype" => "Link", "P" => pages[from],
            "Rect" => vec![20.into(), 20.into(), 80.into(), 40.into()],
            "Dest" => vec![pages[to].into(), "XYZ".into(), 100.into(), 60.into(), 0.into()],
        };
        let link_id = document.add_object(link);
        document
            .get_dictionary_mut(pages[from])
            .unwrap()
            .set("Annots", vec![Object::Reference(link_id)]);
    }
    document.save(path).unwrap();
}

/// A preserved page is split with a scale and translation, then interleaved
/// with a blank copied page the way compact cleanup assembles its output. Its
/// retained link names the output page the plan gives its target, at the same
/// point. A link from the copied page into the preserved page lands at the point
/// the preserved page's scaled content puts there.
#[test]
fn overlay_rebinds_a_link_a_preserved_page_retains_to_its_output_page() {
    let source = path("retained-link-source", "pdf");
    let split_instructions = path("retained-link-split", "json");
    let split = path("retained-link-split-output", "pdf");
    let raster = path("retained-link-raster", "pdf");
    let assembled = path("retained-link-assembled", "pdf");
    let instructions = path("retained-link-instructions", "json");
    let output = path("retained-link-output", "pdf");
    save_retained_link_source(&source);
    write(
        &split_instructions,
        r#"{"catalog":"assembly","pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":120},"contentTransform":{"scale":0.5,"translateX":10,"translateY":20}}]}]}"#,
    )
    .unwrap();
    run_split_pages(&source, &split, &split_instructions);
    save_empty_pages(&raster, 1);
    let interleave = Command::new(qpdf_path())
        .arg(&raster)
        .args(["--coalesce-contents", "--pages"])
        .arg(&split)
        .arg("1")
        .arg(&raster)
        .arg("1")
        .arg("--")
        .arg(&assembled)
        .output()
        .unwrap();
    assert!(
        interleave.status.success(),
        "{}",
        String::from_utf8_lossy(&interleave.stderr)
    );
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[0.5,0,0,0.5,10,20],"linkOnly":true},{"sourcePageIndex":1,"outputPageIndex":1,"matrix":[1,0,0,1,0,0]}]}"#,
    )
    .unwrap();

    let result = run_overlay_text(&assembled, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let saved = Document::load(&output).unwrap();
    let pages = saved.get_pages().into_values().collect::<Vec<_>>();
    let link_on = |page: ObjectId| {
        let annots = saved
            .get_dictionary(page)
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        let link = saved
            .get_dictionary(annots[0].as_reference().unwrap())
            .unwrap();
        assert!(!link.has(b"EVBDestinationPage"));
        link.get(b"Dest").unwrap().as_array().unwrap().clone()
    };
    // The preserved page's own link: the target page is an identity copy.
    let outgoing = link_on(pages[0]);
    assert_eq!(outgoing[0].as_reference().unwrap(), pages[1]);
    assert_eq!(outgoing[2].as_float().unwrap(), 100.0);
    assert_eq!(outgoing[3].as_float().unwrap(), 60.0);
    // The copied page's link into the preserved page, through its transform.
    let incoming = link_on(pages[1]);
    assert_eq!(incoming[0].as_reference().unwrap(), pages[0]);
    assert_eq!(incoming[2].as_float().unwrap(), 60.0);
    assert_eq!(incoming[3].as_float().unwrap(), 50.0);
    for file in [
        source,
        split_instructions,
        split,
        raster,
        assembled,
        instructions,
        output,
    ] {
        let _ = remove_file(file);
    }
}

#[test]
fn overlay_keeps_a_link_whose_destination_no_output_shows_and_drops_only_the_destination() {
    for (target, defined) in [
        (LinkTarget::Explicit, true),
        (LinkTarget::Action, true),
        (LinkTarget::LegacyNamed, true),
        (LinkTarget::TreeNamed, true),
        (LinkTarget::LegacyNamed, false),
    ] {
        let source = path("outside-link-source", "pdf");
        let input = path("outside-link-input", "pdf");
        let output = path("outside-link-output", "pdf");
        let instructions = path("outside-link-instructions", "json");
        save_link_source(&source, target, defined);
        save_empty_pages(&input, 1);
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
        let saved = Document::load(&output).unwrap();
        let page = saved.get_pages().into_values().next().unwrap();
        let annots = saved
            .get_dictionary(page)
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(annots.len(), 1);
        let link = saved
            .get_dictionary(annots[0].as_reference().unwrap())
            .unwrap();
        assert_eq!(link.get(b"Subtype").unwrap().as_name().unwrap(), b"Link");
        assert!(link.get(b"Dest").is_err());
        if let Ok(action) = link.get(b"A") {
            assert!(action.as_dict().unwrap().get(b"D").is_err());
        }
        for file in [source, input, output, instructions] {
            let _ = remove_file(file);
        }
    }
}

#[test]
fn overlay_keeps_a_seam_note_and_its_reply_on_the_page_that_owns_it() {
    // The left source region owns a note centred at x=99.5, but the left
    // canvas placement moves it 30 pt past the 100 pt page. The reader would
    // drop it as foreign, so the marker moves back onto the page, keeping its
    // size and its reply.
    let source = path("seam-clamp-note", "pdf");
    let input = path("seam-clamp-target", "pdf");
    let output = path("seam-clamp-output", "pdf");
    let inspected = path("seam-clamp-inspected", "pdf");
    let instructions = path("seam-clamp", "json");
    let parsed = path("seam-clamp-parsed", "jsonl");
    let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
    let page_id = document.get_pages()[&1];
    let root = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "P" => page_id,
        "Rect" => vec![94.into(), 45.into(), 105.into(), 55.into()],
        "Contents" => Object::string_literal("Seam root"),
    });
    let reply = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "P" => page_id, "IRT" => root,
        "Rect" => vec![50.into(), 45.into(), 60.into(), 55.into()],
        "Contents" => Object::string_literal("Seam reply"),
    });
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        vec![Object::Reference(root), Object::Reference(reply)],
    );
    document.save(&source).unwrap();
    let mut target = save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
    for id in target.get_pages().values() {
        target
            .get_dictionary_mut(*id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
    }
    target.save(&input).unwrap();
    let region = |x: i64| {
        serde_json::json!({
            "rect": {"x": x, "y": 0, "width": 100, "height": 120},
            "matrix": [1, 0, 0, -1, 0, 120],
        })
    };
    write(
        &instructions,
        serde_json::to_vec(&serde_json::json!({"pages": [
            {"sourcePageIndex": 0, "outputPageIndex": 0, "matrix": [1, 0, 0, 1, 30, 0],
             "filterToOutputPage": true, "sourceRegion": region(0)},
            {"sourcePageIndex": 0, "outputPageIndex": 1, "matrix": [1, 0, 0, 1, -70, 0],
             "filterToOutputPage": true, "sourceRegion": region(100)},
        ]}))
        .unwrap(),
    )
    .unwrap();
    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    run_text_box_command("parse-annotations", &output, &parsed, None);
    // A note entry carries its reply thread, so the reply is read back with it.
    let notes = fs::read_to_string(&parsed)
        .unwrap()
        .lines()
        .skip(1)
        .flat_map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["entries"]
                .as_array()
                .unwrap()
                .clone()
        })
        .filter(|entry| entry["kind"] == "note")
        .map(|entry| {
            let replies = entry["replies"]
                .as_array()
                .unwrap()
                .iter()
                .map(|reply| reply["contents"].as_str().unwrap().to_string())
                .collect::<Vec<_>>();
            (
                entry["pageIndex"].as_u64().unwrap(),
                entry["contents"].as_str().unwrap().to_string(),
                replies,
            )
        })
        .collect::<Vec<_>>();
    assert!(
        notes.contains(&(0, "Seam root".to_string(), vec!["Seam reply".to_string()])),
        "seam note and its reply are not an editable note on page 0: {notes:?}"
    );
    let compact = Command::new(qpdf_path())
        .arg(&output)
        .arg(&inspected)
        .output()
        .unwrap();
    assert!(compact.status.success());
    let saved = Document::load(&inspected).unwrap();
    let page = saved.get_pages()[&1];
    let annotations = saved
        .get_dictionary(page)
        .unwrap()
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap();
    let root_rect = annotations
        .iter()
        .map(|object| {
            saved
                .get_dictionary(object.as_reference().unwrap())
                .unwrap()
        })
        .find(|annotation| {
            annotation.get(b"Contents").unwrap().as_str().unwrap() == b"Seam root".as_slice()
        })
        .unwrap()
        .get(b"Rect")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|number| f64::from(number.as_float().unwrap()))
        .collect::<Vec<_>>();
    assert!(
        root_rect[0] >= 0.0
            && root_rect[2] <= 100.0
            && root_rect[1] >= 0.0
            && root_rect[3] <= 120.0,
        "seam note Rect {root_rect:?} is outside the 100 x 120 page"
    );
    for file in [source, input, output, inspected, instructions, parsed] {
        remove_file(file).unwrap();
    }
}

#[test]
fn overlay_split_notes_belong_to_source_regions_before_canvas_padding() {
    for (incremental, margin, source_region) in [
        (false, 0, false),
        (false, 0, true),
        (false, 20, true),
        (true, 0, true),
        (true, 20, true),
    ] {
        let source = path("source-region-note", "pdf");
        let input = path("source-region-target", "pdf");
        let output = path("source-region-output", "pdf");
        let inspected = path("source-region-inspected", "pdf");
        let instructions = path("source-region", "json");
        let parsed = path("source-region-parsed", "jsonl");
        let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
        let page_id = document.get_pages()[&1];
        let seam = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "P" => page_id,
            "Rect" => vec![95.into(), 45.into(), 105.into(), 55.into()],
            "Contents" => Object::string_literal("Seam note"),
        });
        let root = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "P" => page_id,
            "Rect" => vec![20.into(), 30.into(), 30.into(), 40.into()],
            "Contents" => Object::string_literal("Root note"),
        });
        let reply = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "P" => page_id, "IRT" => root,
            "Rect" => vec![150.into(), 30.into(), 160.into(), 40.into()],
            "Contents" => Object::string_literal("Reply note"),
        });
        let popup = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Popup", "P" => page_id, "Parent" => reply,
            "Rect" => vec![140.into(), 45.into(), 190.into(), 100.into()],
            "Contents" => Object::string_literal("Reply popup"),
        });
        document
            .get_dictionary_mut(reply)
            .unwrap()
            .set("Popup", popup);
        // A legacy point note (ADR 0003): a blank-appearance FreeText whose
        // 2 pt marker sits on the seam. Its popup follows it to the same half.
        let legacy_appearance = document.add_object(Stream::new(
            dictionary! {"Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 2.into(), 2.into()]},
            Vec::new(),
        ));
        let legacy_popup = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Popup", "P" => page_id,
            "Rect" => vec![140.into(), 60.into(), 190.into(), 100.into()],
            "Contents" => Object::string_literal("Legacy popup"),
        });
        let legacy_root = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "FreeText", "P" => page_id,
            "Rect" => vec![99.into(), 50.into(), 101.into(), 52.into()],
            "Contents" => Object::string_literal("Legacy seam note"),
            "AP" => dictionary! {"N" => legacy_appearance},
            "Popup" => legacy_popup,
        });
        document
            .get_dictionary_mut(legacy_popup)
            .unwrap()
            .set("Parent", legacy_root);
        let markup = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Highlight", "P" => page_id,
            "Rect" => vec![90.into(), 45.into(), 110.into(), 55.into()],
            "QuadPoints" => vec![90.into(), 55.into(), 110.into(), 55.into(), 90.into(), 45.into(), 110.into(), 45.into()],
            "Contents" => Object::string_literal("Cross-seam markup"),
        });
        // Its Rect is padded across the seam, but every quad lies on the left.
        let padded_markup = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Highlight", "P" => page_id,
            "Rect" => vec![40.into(), 45.into(), 104.into(), 55.into()],
            "QuadPoints" => vec![40.into(), 55.into(), 70.into(), 55.into(), 40.into(), 45.into(), 70.into(), 45.into()],
            "Contents" => Object::string_literal("Padded left markup"),
        });
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            vec![
                seam,
                root,
                reply,
                popup,
                legacy_root,
                legacy_popup,
                markup,
                padded_markup,
            ]
            .into_iter()
            .map(Object::Reference)
            .collect::<Vec<_>>(),
        );
        document.save(&source).unwrap();
        if incremental {
            assert!(write_sparse_source(&input, 2, None, None) > 512 * 1024 * 1024);
        } else {
            let mut target = save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
            for id in target.get_pages().values() {
                target.get_dictionary_mut(*id).unwrap().set(
                    "MediaBox",
                    vec![
                        0.into(),
                        0.into(),
                        (100 + 2 * margin).into(),
                        (120 + 2 * margin).into(),
                    ],
                );
            }
            let target_page = target.get_pages()[&1];
            let existing = target.add_object(dictionary! {
                "Type" => "Annot", "Subtype" => "Text", "P" => target_page,
                "Rect" => vec![70.into(), 20.into(), 80.into(), 30.into()],
                "Contents" => Object::string_literal("Existing target note"),
            });
            target
                .get_dictionary_mut(target_page)
                .unwrap()
                .set("Annots", vec![Object::Reference(existing)]);
            target.save(&input).unwrap();
        }
        let pages = (0..2)
            .map(|index| {
                let mut instruction = serde_json::json!({
                    "sourcePageIndex":0,"outputPageIndex":index,
                    "matrix":[1,0,0,1,margin-index*100,margin],"filterToOutputPage":true,
                });
                if source_region {
                    instruction["sourceRegion"] = serde_json::json!({
                        "rect":{"x":index*100,"y":0,"width":100,"height":120},
                        "matrix":[1,0,0,-1,0,120],
                    });
                }
                instruction
            })
            .collect::<Vec<_>>();
        write(
            &instructions,
            serde_json::to_vec(&serde_json::json!({"pages":pages})).unwrap(),
        )
        .unwrap();
        let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let compact = Command::new(qpdf_path())
            .arg(&output)
            .arg(&inspected)
            .output()
            .unwrap();
        assert!(
            compact.status.success(),
            "{}",
            String::from_utf8_lossy(&compact.stderr)
        );
        let saved = Document::load(&inspected).unwrap();
        let annotations = saved
            .get_pages()
            .values()
            .map(|page| {
                saved
                    .get_dictionary(*page)
                    .unwrap()
                    .get(b"Annots")
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|object| {
                        let id = object.as_reference().unwrap();
                        let annotation = saved.get_dictionary(id).unwrap();
                        assert_eq!(annotation.get(b"P").unwrap().as_reference().unwrap(), *page);
                        (
                            String::from_utf8(
                                annotation
                                    .get(b"Contents")
                                    .unwrap()
                                    .as_str()
                                    .unwrap()
                                    .to_vec(),
                            )
                            .unwrap(),
                            id,
                        )
                    })
                    .collect::<std::collections::BTreeMap<_, _>>()
            })
            .collect::<Vec<_>>();
        let mut expected_left = vec![
            "Cross-seam markup",
            "Padded left markup",
            "Reply note",
            "Reply popup",
            "Root note",
        ];
        if !incremental {
            expected_left.insert(1, "Existing target note");
            assert_eq!(
                saved
                    .get_dictionary(annotations[0]["Existing target note"])
                    .unwrap()
                    .get(b"Rect")
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|number| number.as_i64().unwrap())
                    .collect::<Vec<_>>(),
                vec![70, 20, 80, 30]
            );
        }
        assert_eq!(
            annotations[0]
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            expected_left
        );
        assert_eq!(
            annotations[1]
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec![
                "Cross-seam markup",
                "Legacy popup",
                "Legacy seam note",
                "Seam note"
            ]
        );
        let left = &annotations[0];
        let reply = saved.get_dictionary(left["Reply note"]).unwrap();
        assert_eq!(
            reply.get(b"IRT").unwrap().as_reference().unwrap(),
            left["Root note"]
        );
        assert_eq!(
            reply.get(b"Popup").unwrap().as_reference().unwrap(),
            left["Reply popup"]
        );
        assert_eq!(
            saved
                .get_dictionary(left["Reply popup"])
                .unwrap()
                .get(b"Parent")
                .unwrap()
                .as_reference()
                .unwrap(),
            left["Reply note"]
        );
        assert_eq!(
            saved
                .objects
                .values()
                .filter(|object| {
                    object
                        .as_dict()
                        .ok()
                        .and_then(|dict| dict.get(b"Subtype").ok())
                        .and_then(|subtype| subtype.as_name().ok())
                        .is_some_and(|subtype| matches!(subtype, b"Text" | b"Popup"))
                })
                .count(),
            // The legacy seam marker is written as a /Text note as well.
            6 + usize::from(!incremental)
        );
        // Read the split output back as the viewer does: the seam notes must
        // be editable notes on their owning half, not foreign entries.
        run_text_box_command("parse-annotations", &output, &parsed, None);
        let read_back_of_kind = |kind: &str| {
            fs::read_to_string(&parsed)
                .unwrap()
                .lines()
                .skip(1)
                .flat_map(|line| {
                    serde_json::from_str::<serde_json::Value>(line).unwrap()["entries"]
                        .as_array()
                        .unwrap()
                        .clone()
                })
                .filter(|entry| entry["kind"] == kind)
                .map(|entry| {
                    (
                        entry["pageIndex"].as_u64().unwrap(),
                        entry["contents"].as_str().unwrap().to_string(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let read_back = read_back_of_kind("note");
        for (page, contents) in [(0, "Root note"), (1, "Seam note"), (1, "Legacy seam note")] {
            assert!(
                read_back.contains(&(page, contents.to_string())),
                "incremental={incremental} margin={margin} region={source_region}: {contents} is not a note on page {page}: {read_back:?}"
            );
        }
        // The cross-seam highlight is clipped to each output page: both halves
        // read it back as editable markup, and its quads match the highlight drawn
        // inside that page to within a point.
        let highlights = read_back_of_kind("highlight");
        for page in [0, 1] {
            assert!(
                highlights.contains(&(page, "Cross-seam markup".to_string())),
                "incremental={incremental} margin={margin} region={source_region}: highlight is not editable markup on page {page}: {highlights:?}"
            );
        }
        for (page_index, page) in saved.get_pages().values().enumerate() {
            let media = saved
                .get_dictionary(*page)
                .unwrap()
                .get(b"MediaBox")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|value| f64::from(value.as_float().unwrap()))
                .collect::<Vec<_>>();
            // Source highlight 90..110 by 45..55, moved by the instruction's matrix.
            let shift_x = margin as f64 - 100.0 * page_index as f64;
            let shift_y = margin as f64;
            let expected = [
                (90.0 + shift_x).max(0.0),
                (45.0 + shift_y).max(0.0),
                (110.0 + shift_x).min(media[2]),
                (55.0 + shift_y).min(media[3]),
            ];
            assert!(expected[2] > expected[0] && expected[3] > expected[1]);
            let quads = saved
                .get_dictionary(annotations[page_index]["Cross-seam markup"])
                .unwrap()
                .get(b"QuadPoints")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|value| f64::from(value.as_float().unwrap()))
                .collect::<Vec<_>>();
            let xs = quads.iter().step_by(2);
            let ys = quads.iter().skip(1).step_by(2);
            let actual = [
                xs.clone().copied().fold(f64::INFINITY, f64::min),
                ys.clone().copied().fold(f64::INFINITY, f64::min),
                xs.copied().fold(f64::NEG_INFINITY, f64::max),
                ys.copied().fold(f64::NEG_INFINITY, f64::max),
            ];
            for (actual, expected) in actual.iter().zip(expected) {
                assert!(
                    (actual - expected).abs() <= 1.0,
                    "incremental={incremental} margin={margin} region={source_region} page={page_index}: quads {actual:?} != {expected:?}"
                );
            }
        }
        // An ownership cycle has no terminal half. Refuse before publication.
        for owner in [
            root,
            document
                .get_dictionary(popup)
                .unwrap()
                .get(b"Parent")
                .unwrap()
                .as_reference()
                .unwrap(),
        ] {
            document.get_dictionary_mut(root).unwrap().set("IRT", owner);
            document.save(&source).unwrap();
            write(&output, b"existing output").unwrap();
            let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
            assert!(!result.status.success());
            assert_eq!(fs::read(&output).unwrap(), b"existing output");
        }
        document.get_dictionary_mut(root).unwrap().remove(b"IRT");
        let mut deep_owner = root;
        for _ in 0..128 {
            deep_owner = document.add_object(dictionary! {
                "Type" => "Annot", "Subtype" => "Text", "P" => page_id, "IRT" => deep_owner,
                "Rect" => vec![150.into(), 30.into(), 160.into(), 40.into()],
            });
        }
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", vec![Object::Reference(deep_owner)]);
        document.save(&source).unwrap();
        write(&output, b"existing output").unwrap();
        let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
        assert!(!result.status.success());
        assert_eq!(fs::read(&output).unwrap(), b"existing output");
        for file in [source, input, output, inspected, instructions, parsed] {
            remove_file(file).unwrap();
        }
    }
}

fn red_pixels(pdf: &Path) -> Vec<(f64, f64)> {
    red_pixels_on_page(pdf, 1)
}

fn red_pixels_on_page(pdf: &Path, page: u32) -> Vec<(f64, f64)> {
    let rendered = Command::new(external_tool::tool_path(
        "PDFTOPPM_PATH",
        "poppler",
        "pdftoppm",
    ))
    .args(["-r", "72", "-singlefile", "-f"])
    .arg(page.to_string())
    .args(["-l"])
    .arg(page.to_string())
    .arg(pdf)
    .output()
    .unwrap();
    assert!(
        rendered.status.success(),
        "{}",
        String::from_utf8_lossy(&rendered.stderr)
    );
    let mut header = rendered.stdout.splitn(4, |byte| *byte == b'\n');
    assert_eq!(header.next().unwrap(), b"P6");
    let dimensions = std::str::from_utf8(header.next().unwrap()).unwrap();
    let width: usize = dimensions
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(header.next().unwrap(), b"255");
    header
        .next()
        .unwrap()
        .chunks_exact(3)
        .enumerate()
        .filter(|(_, rgb)| rgb[0] > 200 && rgb[1] < 30 && rgb[2] < 30)
        .map(|(index, _)| ((index % width) as f64, (index / width) as f64))
        .collect()
}

#[test]
fn overlay_legacy_point_note_thread_lands_on_one_split_half() {
    for incremental in [false, true] {
        let source = path("legacy-seam-note", "pdf");
        let input = path("legacy-seam-target", "pdf");
        let output = path("legacy-seam-output", "pdf");
        let inspected = path("legacy-seam-inspected", "pdf");
        let instructions = path("legacy-seam", "json");
        let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
        let page_id = document.get_pages()[&1];
        let blank_appearance = document.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()] },
            Vec::new(),
        ));
        // ADR 0003 legacy marker: a FreeText with a blank appearance, a
        // tiny rect centred on the seam, and a Popup child.
        let root = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "FreeText", "P" => page_id,
            "Rect" => vec![99.99_f32.into(), 49.99_f32.into(), 100.01_f32.into(), 50.01_f32.into()],
            "Contents" => Object::string_literal("Legacy root"),
            "AP" => dictionary! { "N" => blank_appearance },
        });
        let popup = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Popup", "P" => page_id, "Parent" => root,
            "Rect" => vec![140.into(), 45.into(), 190.into(), 100.into()],
            "Contents" => Object::string_literal("Legacy popup"),
        });
        document
            .get_dictionary_mut(root)
            .unwrap()
            .set("Popup", popup);
        let reply = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "P" => page_id, "IRT" => root,
            "Rect" => vec![150.into(), 30.into(), 160.into(), 40.into()],
            "Contents" => Object::string_literal("Legacy reply"),
        });
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            vec![root, popup, reply]
                .into_iter()
                .map(Object::Reference)
                .collect::<Vec<_>>(),
        );
        document.save(&source).unwrap();
        if incremental {
            assert!(write_sparse_source(&input, 2, None, None) > 512 * 1024 * 1024);
        } else {
            let mut target = save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
            for id in target.get_pages().values() {
                target
                    .get_dictionary_mut(*id)
                    .unwrap()
                    .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
            }
            target.save(&input).unwrap();
        }
        let pages = (0..2_i64)
            .map(|index| {
                serde_json::json!({
                    "sourcePageIndex":0,"outputPageIndex":index,
                    "matrix":[1,0,0,1,-100 * index,0],"filterToOutputPage":true,
                    "sourceRegion":{
                        "rect":{"x":index*100,"y":0,"width":100,"height":120},
                        "matrix":[1,0,0,-1,0,120],
                    },
                })
            })
            .collect::<Vec<_>>();
        write(
            &instructions,
            serde_json::to_vec(&serde_json::json!({"pages":pages})).unwrap(),
        )
        .unwrap();
        let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let compact = Command::new(qpdf_path())
            .arg(&output)
            .arg(&inspected)
            .output()
            .unwrap();
        assert!(
            compact.status.success(),
            "{}",
            String::from_utf8_lossy(&compact.stderr)
        );
        let saved = Document::load(&inspected).unwrap();
        // Contents per half, in /Annots order. Duplicates stay visible.
        let halves = saved
            .get_pages()
            .values()
            .map(|page| {
                saved
                    .get_dictionary(*page)
                    .unwrap()
                    .get(b"Annots")
                    .map_or_else(|_| Vec::new(), |annots| annots.as_array().unwrap().clone())
                    .iter()
                    .map(|object| {
                        let id = object.as_reference().unwrap();
                        let annotation = saved.get_dictionary(id).unwrap();
                        assert_eq!(annotation.get(b"P").unwrap().as_reference().unwrap(), *page);
                        (
                            id,
                            String::from_utf8(
                                annotation
                                    .get(b"Contents")
                                    .unwrap()
                                    .as_str()
                                    .unwrap()
                                    .to_vec(),
                            )
                            .unwrap(),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert!(halves[0].is_empty());
        assert_eq!(
            halves[1]
                .iter()
                .map(|(_, text)| text.as_str())
                .collect::<Vec<_>>(),
            vec!["Legacy root", "Legacy popup", "Legacy reply"]
        );
        let right = &halves[1];
        let right_root = right[0].0;
        let right_popup = right[1].0;
        assert_eq!(
            saved
                .get_dictionary(right_root)
                .unwrap()
                .get(b"Popup")
                .unwrap()
                .as_reference()
                .unwrap(),
            right_popup
        );
        assert_eq!(
            saved
                .get_dictionary(right[2].0)
                .unwrap()
                .get(b"IRT")
                .unwrap()
                .as_reference()
                .unwrap(),
            right_root
        );
        // The root must exist once: a copy left in the other half would be a
        // second annotation with the same text.
        assert_eq!(
            saved
                .objects
                .values()
                .filter(|object| object.as_dict().is_ok_and(|dictionary| dictionary
                    .get(b"Contents")
                    .and_then(Object::as_str)
                    .is_ok_and(|text| text == b"Legacy root")))
                .count(),
            1
        );
        for file in [source, input, output, inspected, instructions] {
            let _ = remove_file(file);
        }
    }
}

#[test]
fn unfiltered_overlay_keeps_a_legacy_note_marker_a_note_on_a_narrower_page() {
    // Full-page cleanup copies without a page filter; a cropped output page
    // narrower than the source still must not turn the marker foreign.
    let source = path("legacy-marker-unfiltered-note", "pdf");
    let input = path("legacy-marker-unfiltered-target", "pdf");
    let output = path("legacy-marker-unfiltered-output", "pdf");
    let instructions = path("legacy-marker-unfiltered", "json");
    let parsed = path("legacy-marker-unfiltered-parsed", "jsonl");
    let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
    let page_id = document.get_pages()[&1];
    let blank_appearance = document.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 2.2.into(), 2.2.into()] },
        Vec::new(),
    ));
    let root = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "FreeText", "P" => page_id,
        "NM" => Object::string_literal("legacy-marker"),
        "Rect" => vec![48.9_f32.into(), 49.0_f32.into(), 51.1_f32.into(), 51.2_f32.into()],
        "Contents" => Object::string_literal("Legacy margin"),
        "AP" => dictionary! { "N" => blank_appearance },
    });
    let popup = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Popup", "P" => page_id, "Parent" => root,
        "Rect" => vec![30.into(), 60.into(), 80.into(), 100.into()],
    });
    document
        .get_dictionary_mut(root)
        .unwrap()
        .set("Popup", popup);
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        vec![root, popup]
            .into_iter()
            .map(Object::Reference)
            .collect::<Vec<_>>(),
    );
    document.save(&source).unwrap();
    let mut target = save_single_page(&input, Vec::new(), Dictionary::new());
    let target_page = target.get_pages()[&1];
    target
        .get_dictionary_mut(target_page)
        .unwrap()
        .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
    target.save(&input).unwrap();
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
    let parse = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args([
            "parse-annotations",
            "--input",
            output.to_str().unwrap(),
            "--output",
            parsed.to_str().unwrap(),
            "--modified-at",
            "D:20260830130000Z",
        ])
        .output()
        .unwrap();
    assert!(
        parse.status.success(),
        "{}",
        String::from_utf8_lossy(&parse.stderr)
    );
    let sidecar = fs::read_to_string(&parsed).unwrap();
    let chunk = serde_json::from_str::<serde_json::Value>(sidecar.lines().nth(1).unwrap()).unwrap();
    let marker = chunk["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "legacy-marker")
        .expect("the copied marker should parse");
    assert_eq!(marker["kind"], "note");

    for file in [source, input, output, instructions, parsed] {
        let _ = remove_file(file);
    }
}

#[test]
fn overlay_split_keeps_a_legacy_note_marker_a_note_on_the_narrower_half() {
    let source = path("legacy-marker-width-note", "pdf");
    let input = path("legacy-marker-width-target", "pdf");
    let output = path("legacy-marker-width-output", "pdf");
    let instructions = path("legacy-marker-width", "json");
    let parsed = path("legacy-marker-width-parsed", "jsonl");
    let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
    let page_id = document.get_pages()[&1];
    let blank_appearance = document.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 2.2.into(), 2.2.into()] },
        Vec::new(),
    ));
    // ADR 0003 legacy marker: 2.2 points square, blank appearance, Popup child.
    // It reads as a note on the 200-point source page (0.011 wide).
    let root = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "FreeText", "P" => page_id,
        "NM" => Object::string_literal("legacy-marker"),
        "Rect" => vec![148.9_f32.into(), 49.0_f32.into(), 151.1_f32.into(), 51.2_f32.into()],
        "Contents" => Object::string_literal("Legacy interior"),
        "AP" => dictionary! { "N" => blank_appearance },
    });
    let popup = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Popup", "P" => page_id, "Parent" => root,
        "Rect" => vec![130.into(), 60.into(), 180.into(), 100.into()],
    });
    document
        .get_dictionary_mut(root)
        .unwrap()
        .set("Popup", popup);
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        vec![root, popup]
            .into_iter()
            .map(Object::Reference)
            .collect::<Vec<_>>(),
    );
    document.save(&source).unwrap();
    let mut target = save_two_pages(&input, [Vec::new(), Vec::new()], Dictionary::new());
    for id in target.get_pages().values() {
        target
            .get_dictionary_mut(*id)
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 100.into(), 120.into()]);
    }
    target.save(&input).unwrap();
    let pages = (0..2_i64)
        .map(|index| {
            serde_json::json!({
                "sourcePageIndex":0,"outputPageIndex":index,
                "matrix":[1,0,0,1,-100 * index,0],"filterToOutputPage":true,
            })
        })
        .collect::<Vec<_>>();
    write(
        &instructions,
        serde_json::to_vec(&serde_json::json!({"pages":pages})).unwrap(),
    )
    .unwrap();
    let result = run_overlay_text(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );

    let parse = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args([
            "parse-annotations",
            "--input",
            output.to_str().unwrap(),
            "--output",
            parsed.to_str().unwrap(),
            "--modified-at",
            "D:20260830130000Z",
        ])
        .output()
        .unwrap();
    assert!(
        parse.status.success(),
        "{}",
        String::from_utf8_lossy(&parse.stderr)
    );
    let sidecar = fs::read_to_string(&parsed).unwrap();
    let chunk = serde_json::from_str::<serde_json::Value>(sidecar.lines().nth(1).unwrap()).unwrap();
    let marker = chunk["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "legacy-marker")
        .expect("the copied marker should parse on one half");
    assert_eq!(marker["kind"], "note");
    assert_eq!(marker["pageIndex"], 1);

    for file in [source, input, output, instructions, parsed] {
        let _ = remove_file(file);
    }
}

#[test]
fn overlay_composes_appearance_placement_in_rewrite_and_incremental_outputs() {
    for (incremental, flags, form_matrix, transform) in [
        (
            false,
            4,
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            [0.0, 1.0, -1.0, 0.0, 120.0, 0.0],
        ),
        (
            true,
            4,
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            [0.0, 1.0, -1.0, 0.0, 120.0, 0.0],
        ),
        (
            false,
            20,
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            [0.0, 1.0, -1.0, 0.0, 120.0, 0.0],
        ),
        (
            false,
            6,
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            [0.0, 1.0, -1.0, 0.0, 120.0, 0.0],
        ),
        (
            false,
            4,
            [
                0.70710677,
                0.70710677,
                -0.70710677,
                0.70710677,
                35.3553385,
                0.0,
            ],
            [1.0, 0.2, 0.3, 1.0, 0.0, 0.0],
        ),
    ] {
        let source = path("appearance-source", "pdf");
        let input = path("appearance-input", "pdf");
        let output = path("appearance-output", "pdf");
        let expected = path("appearance-expected", "pdf");
        let instructions = path("appearance-instructions", "json");
        let triangle = b"1 0 0 rg 0 0 m 50 0 l 0 50 l h f";
        let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
        let page = document.get_pages()[&1];
        let appearance = document.add_object(Stream::new(dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 50.into(), 50.into()],
            "Matrix" => form_matrix.into_iter().map(|value| Object::Real(value as f32)).collect::<Vec<_>>(),
            "Resources" => Dictionary::new(),
        }, triangle.to_vec()));
        let annotation = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Stamp", "P" => page,
            "Rect" => vec![40.into(), 30.into(), 90.into(), 80.into()], "F" => flags,
            "AP" => dictionary! {"N" => appearance},
        });
        document
            .get_dictionary_mut(page)
            .unwrap()
            .set("Annots", vec![Object::Reference(annotation)]);
        document.save(&source).unwrap();
        if incremental {
            write_sparse_source(&input, 1, None, None);
        } else {
            save_empty_pages(&input, 1);
        }
        write(
            &instructions,
            serde_json::to_vec(&serde_json::json!({"pages":[{
                "sourcePageIndex":0,"outputPageIndex":0,"matrix":transform,
            }]}))
            .unwrap(),
        )
        .unwrap();
        let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        // A page-content control applies the source appearance fitting, then the
        // requested affine. It does not use the annotation writer under test.
        let fit = if form_matrix[0] == 1.0 {
            1.0
        } else {
            0.7071067933730954
        };
        let numbers = |values: &[f64]| {
            values
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(" ")
        };
        let content = if flags & 2 != 0 {
            Vec::new()
        } else {
            format!(
                "q {} cm {fit} 0 0 {fit} 40 30 cm {} cm {} Q",
                numbers(&transform),
                numbers(&form_matrix),
                std::str::from_utf8(triangle).unwrap()
            )
            .into_bytes()
        };
        save_single_page(&expected, content, Dictionary::new());
        let actual = red_pixels(&output);
        let control = red_pixels(&expected);
        if control.is_empty() {
            assert!(actual.is_empty());
        } else {
            assert!(!actual.is_empty());
            let centroid = |pixels: &[(f64, f64)]| {
                pixels
                    .iter()
                    .fold((0.0, 0.0), |sum, point| (sum.0 + point.0, sum.1 + point.1))
            };
            let a = centroid(&actual);
            let c = centroid(&control);
            assert!((a.0 / actual.len() as f64 - c.0 / control.len() as f64).abs() < 0.5);
            assert!((a.1 / actual.len() as f64 - c.1 / control.len() as f64).abs() < 0.5);
        }
        if !incremental {
            let saved = Document::load(&output).unwrap();
            let annotation = saved
                .get_dictionary(saved.get_pages()[&1])
                .unwrap()
                .get(b"Annots")
                .unwrap()
                .as_array()
                .unwrap()[0]
                .as_reference()
                .unwrap();
            assert_eq!(
                saved
                    .get_dictionary(annotation)
                    .unwrap()
                    .get(b"F")
                    .unwrap()
                    .as_i64()
                    .unwrap(),
                flags
            );
        }
        for file in [source, input, output, expected, instructions] {
            remove_file(file).unwrap();
        }
    }
}

#[test]
fn overlay_clips_a_seam_highlight_appearance_without_rescaling_its_marks() {
    let source = path("markup-appearance-source", "pdf");
    let input = path("markup-appearance-input", "pdf");
    let output = path("markup-appearance-output", "pdf");
    let instructions = path("markup-appearance-instructions", "json");
    let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
    let page = document.get_pages()[&1];
    // Four points of red at x 90..94, painted by an appearance that spans the Rect.
    let appearance = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 20.into(), 10.into()],
            "Resources" => Dictionary::new(),
        },
        b"1 0 0 rg 0 0 4 10 re f".to_vec(),
    ));
    let annotation = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Highlight", "P" => page,
        "Rect" => vec![90.into(), 45.into(), 110.into(), 55.into()],
        "QuadPoints" => vec![
            90.into(), 55.into(), 110.into(), 55.into(), 90.into(), 45.into(), 110.into(), 45.into(),
        ],
        "C" => vec![1.into(), 0.into(), 0.into()], "F" => 4,
        "AP" => dictionary! {"N" => appearance},
    });
    document
        .get_dictionary_mut(page)
        .unwrap()
        .set("Annots", vec![Object::Reference(annotation)]);
    document.save(&source).unwrap();
    save_half_pages(&input, 2);
    write(
        &instructions,
        serde_json::to_vec(&serde_json::json!({"pages":[
            {"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},
            {"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"filterToOutputPage":true},
        ]}))
        .unwrap(),
    )
    .unwrap();
    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    // A viewer fits an appearance's BBox to the annotation Rect. Poppler draws
    // a Highlight from its quads, not its appearance, so the saved geometry is
    // checked here: each half's Rect is its clipped part, and the BBox matches it
    // (scale 1). PDF.js pixel counts are recorded in the probe evidence.
    let saved = Document::load(&output).unwrap();
    for (page, expected) in [(1, [90, 45, 100, 55]), (2, [0, 45, 10, 55])] {
        let annotations = saved
            .get_dictionary(saved.get_pages()[&page])
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(annotations.len(), 1);
        let annotation = saved
            .get_dictionary(annotations[0].as_reference().unwrap())
            .unwrap();
        let rect = real_numbers(annotation.get(b"Rect").unwrap());
        assert_eq!(rect, expected.map(f64::from));
        let appearance = annotation
            .get(b"AP")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"N")
            .unwrap()
            .as_reference()
            .unwrap();
        let form = saved.get_object(appearance).unwrap().as_stream().unwrap();
        assert_eq!(real_numbers(form.dict.get(b"BBox").unwrap()), rect);
    }
    for file in [source, input, output, instructions] {
        remove_file(file).unwrap();
    }
}

#[test]
fn overlay_keeps_a_highlight_whose_quad_array_is_malformed() {
    for quads in [
        vec![40, 55, 70, 55],
        vec![40, 55, 70, 55, 40, 45, 70, 45, 999],
    ] {
        let source = path("markup-malformed-source", "pdf");
        let input = path("markup-malformed-input", "pdf");
        let output = path("markup-malformed-output", "pdf");
        let instructions = path("markup-malformed-instructions", "json");
        let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
        let page = document.get_pages()[&1];
        let annotation = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Highlight", "P" => page,
            "Rect" => vec![40.into(), 45.into(), 70.into(), 55.into()],
            "QuadPoints" => quads.iter().map(|&value| Object::Integer(value)).collect::<Vec<_>>(),
            "C" => vec![1.into(), 0.into(), 0.into()], "F" => 4,
            "Contents" => "malformed quads",
        });
        document
            .get_dictionary_mut(page)
            .unwrap()
            .set("Annots", vec![Object::Reference(annotation)]);
        document.save(&source).unwrap();
        save_empty_pages(&input, 1);
        write(
            &instructions,
            serde_json::to_vec(&serde_json::json!({"pages":[{
                "sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],
                "filterToOutputPage":true,
            }]}))
            .unwrap(),
        )
        .unwrap();
        let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        // Readers ignore a quad array that is not whole quads, but the saved
        // annotation keeps its data: the Rect admits it and its quads stay as read.
        let saved = Document::load(&output).unwrap();
        let annotations = saved
            .get_dictionary(saved.get_pages()[&1])
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(annotations.len(), 1);
        let annotation = saved
            .get_dictionary(annotations[0].as_reference().unwrap())
            .unwrap();
        assert_eq!(
            annotation.get(b"Subtype").unwrap().as_name().unwrap(),
            b"Highlight"
        );
        assert_eq!(
            real_numbers(annotation.get(b"QuadPoints").unwrap()),
            quads
                .iter()
                .map(|&value| f64::from(value as i32))
                .collect::<Vec<_>>()
        );
        for file in [source, input, output, instructions] {
            remove_file(file).unwrap();
        }
    }
}

#[test]
fn overlay_admits_a_highlight_by_its_indirect_quads_not_its_rect() {
    let source = path("markup-indirect-source", "pdf");
    let input = path("markup-indirect-input", "pdf");
    let output = path("markup-indirect-output", "pdf");
    let instructions = path("markup-indirect-instructions", "json");
    let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
    let page = document.get_pages()[&1];
    // The quads sit left of the seam at x 100; the Rect straddles it.
    let quads = document.add_object(vec![
        90.into(),
        55.into(),
        95.into(),
        55.into(),
        90.into(),
        45.into(),
        95.into(),
        45.into(),
    ]);
    let annotation = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Highlight", "P" => page,
        "Rect" => vec![85.into(), 45.into(), 104.into(), 55.into()],
        "QuadPoints" => quads,
        "C" => vec![1.into(), 0.into(), 0.into()], "F" => 4,
        "Contents" => "left of the seam",
    });
    document
        .get_dictionary_mut(page)
        .unwrap()
        .set("Annots", vec![Object::Reference(annotation)]);
    document.save(&source).unwrap();
    save_half_pages(&input, 2);
    write(
        &instructions,
        serde_json::to_vec(&serde_json::json!({"pages":[
            {"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},
            {"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"filterToOutputPage":true},
        ]}))
        .unwrap(),
    )
    .unwrap();
    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    // Only the left half holds the highlight; the right half's copy would sit
    // off that page's content.
    let saved = Document::load(&output).unwrap();
    let annotations_on = |page: u32| {
        saved
            .get_dictionary(saved.get_pages()[&page])
            .unwrap()
            .get(b"Annots")
            .map(|annots| annots.as_array().unwrap().len())
            .unwrap_or(0)
    };
    assert_eq!(annotations_on(1), 1);
    assert_eq!(annotations_on(2), 0);
    for file in [source, input, output, instructions] {
        remove_file(file).unwrap();
    }
}

#[test]
fn overlay_places_a_highlight_without_a_rect_by_its_quads() {
    let source = path("markup-no-rect-source", "pdf");
    let input = path("markup-no-rect-input", "pdf");
    let output = path("markup-no-rect-output", "pdf");
    let instructions = path("markup-no-rect-instructions", "json");
    let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
    let page = document.get_pages()[&1];
    let annotation = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Highlight", "P" => page,
        "QuadPoints" => vec![
            40.into(), 55.into(), 70.into(), 55.into(), 40.into(), 45.into(), 70.into(), 45.into(),
        ],
        "C" => vec![1.into(), 0.into(), 0.into()], "F" => 4,
        "Contents" => "no rect",
    });
    document
        .get_dictionary_mut(page)
        .unwrap()
        .set("Annots", vec![Object::Reference(annotation)]);
    document.save(&source).unwrap();
    save_half_pages(&input, 2);
    write(
        &instructions,
        serde_json::to_vec(&serde_json::json!({"pages":[
            {"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,5,0],"filterToOutputPage":true},
            {"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"filterToOutputPage":true},
        ]}))
        .unwrap(),
    )
    .unwrap();
    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    // The left half keeps the highlight at its moved quads; the right half is
    // off the quads' x 40..70 span after its shift, so it is not copied there.
    let saved = Document::load(&output).unwrap();
    let annotations = |page: u32| {
        saved
            .get_dictionary(saved.get_pages()[&page])
            .unwrap()
            .get(b"Annots")
            .map(|annots| annots.as_array().unwrap().clone())
            .unwrap_or_default()
    };
    let left = annotations(1);
    assert_eq!(left.len(), 1);
    let left = saved
        .get_dictionary(left[0].as_reference().unwrap())
        .unwrap();
    assert_eq!(
        real_numbers(left.get(b"QuadPoints").unwrap()),
        [45.0, 55.0, 75.0, 55.0, 45.0, 45.0, 75.0, 45.0]
    );
    assert!(annotations(2).is_empty());
    for file in [source, input, output, instructions] {
        remove_file(file).unwrap();
    }
}

fn real_numbers(object: &Object) -> Vec<f64> {
    object
        .as_array()
        .unwrap()
        .iter()
        .map(|value| f64::from(value.as_float().unwrap()))
        .collect()
}

fn run_text_box_command(operation: &str, input: &Path, output: &Path, mutations: Option<&Path>) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"));
    command
        .args([operation, "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .args(["--modified-at", "D:19700101000000Z", "--qpdf"])
        .arg(qpdf_path());
    if let Some(mutations) = mutations {
        command.arg("--mutations-file").arg(mutations);
    }
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn overlay_preserves_editable_text_box_geometry_and_refuses_unrepresentable_affines() {
    let blank = path("canonical-blank", "pdf");
    let source = path("canonical-source", "pdf");
    let mutations = path("canonical-mutations", "json");
    save_empty_pages(&blank, 1);
    write(&mutations, br#"{"textBoxes":[{"pageIndex":0,"stableKey":"canonical-box","text":"Editable box","rect":[20,30,60,45],"rotation":0,"fontSize":6,"color":[0,0,0]}]}"#).unwrap();
    run_text_box_command("save-mutations", &blank, &source, Some(&mutations));
    for (incremental, matrix, expected_rotation, expected_rect, font_size) in [
        (
            false,
            [1.0, 0.0, 0.0, 1.0, 5.0, 5.0],
            0,
            [25.0, 35.0, 65.0, 50.0],
            6,
        ),
        (
            true,
            [1.0, 0.0, 0.0, 1.0, 5.0, 5.0],
            0,
            [25.0, 35.0, 65.0, 50.0],
            6,
        ),
        (
            false,
            [0.0, 1.0, -1.0, 0.0, 120.0, 0.0],
            270,
            [62.5, 32.5, 102.5, 47.5],
            6,
        ),
        (
            false,
            [2.0, 0.0, 0.0, 2.0, 0.0, 0.0],
            0,
            [40.0, 60.0, 120.0, 90.0],
            12,
        ),
    ] {
        let input = path("canonical-input", "pdf");
        let output = path("canonical-output", "pdf");
        let edited = path("canonical-edited", "pdf");
        let instructions = path("canonical-instructions", "json");
        let parsed = path("canonical-parse", "jsonl");
        if incremental {
            write_sparse_source(&input, 1, None, None);
        } else {
            save_empty_pages(&input, 1);
        }
        write(&instructions, serde_json::to_vec(&serde_json::json!({"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":matrix}]})).unwrap()).unwrap();
        let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        run_text_box_command("parse-annotations", &output, &parsed, None);
        let entries = fs::read_to_string(&parsed)
            .unwrap()
            .lines()
            .skip(1)
            .flat_map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["entries"]
                    .as_array()
                    .unwrap()
                    .clone()
            })
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["kind"], "text-box");
        assert_eq!(
            entries[0]["fontSize"].as_f64().unwrap(),
            f64::from(font_size)
        );
        assert_eq!(entries[0]["rotation"], expected_rotation);
        write(&mutations, serde_json::to_vec(&serde_json::json!({"textBoxes":[{
            "pageIndex":0,"stableKey":"canonical-box","annotationId":format!("{}R{}", entries[0]["objectNumber"], entries[0]["generationNumber"]),
            "text":"Edited after cleanup","rect":expected_rect,"rotation":expected_rotation,"fontSize":font_size,"color":[0,0,0],
        }]})).unwrap()).unwrap();
        run_text_box_command("save-mutations", &output, &edited, Some(&mutations));
        run_text_box_command("parse-annotations", &edited, &parsed, None);
        let saved: serde_json::Value =
            serde_json::from_str(fs::read_to_string(&parsed).unwrap().lines().nth(1).unwrap())
                .unwrap();
        assert_eq!(saved["entries"].as_array().unwrap().len(), 1);
        assert_eq!(saved["entries"][0]["kind"], "text-box");
        assert_eq!(saved["entries"][0]["text"], "Edited after cleanup");
        for file in [input, output, edited, instructions, parsed] {
            remove_file(file).unwrap();
        }
    }
    let output = path("canonical-refused", "pdf");
    let instructions = path("canonical-refused", "json");
    write(&output, b"existing output").unwrap();
    write(
        &instructions,
        br#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0.2,1,0,0]}]}"#,
    )
    .unwrap();
    let result = run_overlay_text(&blank, &source, &output, &instructions);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("cannot preserve editable text-box geometry"));
    assert_eq!(fs::read(&output).unwrap(), b"existing output");
    for file in [blank, source, mutations, output, instructions] {
        remove_file(file).unwrap();
    }
}

fn assert_overlay_accepts_annotation_entries(entries: &[Object]) {
    for malformed in entries {
        let source = path("unreadable-annotation-source", "pdf");
        let input = path("unreadable-annotation-input", "pdf");
        let output = path("unreadable-annotation-output", "pdf");
        let instructions = path("unreadable-annotation-plan", "json");
        let mut doc = save_single_page(&source, Vec::new(), Dictionary::new());
        let page = doc.get_pages()[&1];
        let good = doc.add_object(dictionary! {"Type"=>"Annot", "Subtype"=>"Text", "P"=>page,
            "Rect"=>vec![30.into(),30.into(),40.into(),40.into()], "Contents"=>Object::string_literal("valid note")});
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Annots", vec![malformed.clone(), Object::Reference(good)]);
        doc.save(&source).unwrap();
        save_empty_pages(&input, 1);
        write(&instructions, r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,5,7],"filterToOutputPage":true}]}"#).unwrap();
        let result = run_overlay_text(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let saved = Document::load(&output).unwrap();
        let annots = saved
            .get_dictionary(saved.get_pages()[&1])
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        let note = annots
            .iter()
            .map(|a| saved.dereference(a).unwrap().1.as_dict().unwrap())
            .find(|a| a.get(b"Contents").is_ok())
            .unwrap();
        assert_eq!(
            note.get(b"Contents").unwrap().as_str().unwrap(),
            b"valid note"
        );
        assert_eq!(
            note.get(b"Rect")
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_float().unwrap())
                .collect::<Vec<_>>(),
            vec![35., 37., 45., 47.]
        );
        for file in [source, input, output, instructions] {
            remove_file(file).unwrap();
        }
    }
}

#[test]
fn overlay_skips_unreadable_annotation_entries() {
    assert_overlay_accepts_annotation_entries(&[
        Object::Reference((999_999, 0)),
        Object::Integer(42),
    ]);
}

#[test]
fn overlay_accepts_a_missing_annotation_subtype() {
    assert_overlay_accepts_annotation_entries(&[Object::Dictionary(
        dictionary! {"Rect"=>vec![10.into(),10.into(),20.into(),20.into()]},
    )]);
}

#[test]
fn canonical_text_box_geometry_defaults_only_an_absent_rotation() {
    let blank = path("missing-rotation-blank", "pdf");
    let source = path("missing-rotation-source", "pdf");
    let output = path("missing-rotation-output", "pdf");
    let mutations = path("missing-rotation-mutations", "json");
    let instructions = path("missing-rotation-overlay", "json");
    let parsed = path("missing-rotation-parsed", "jsonl");
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}]}"#,
    )
    .unwrap();
    save_empty_pages(&blank, 1);
    write(&mutations, r#"{"textBoxes":[{"pageIndex":0,"stableKey":"rotation-box","text":"Editable box","rect":[20,30,60,45],"rotation":0,"fontSize":6,"color":[0,0,0]}]}"#).unwrap();
    run_text_box_command("save-mutations", &blank, &source, Some(&mutations));
    let mut original = Document::load(&source).unwrap();
    let id = original
        .get_dictionary(original.get_pages()[&1])
        .unwrap()
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap()[0]
        .as_reference()
        .unwrap();
    write(
        &mutations,
        serde_json::to_vec(&serde_json::json!({"geometryUpdates":[{
            "objectNumber":id.0,"generationNumber":id.1,"pageIndex":0,
            "markerRect":{"left":0.1,"top":0.625,"width":0.2,"height":0.125}
        }]}))
        .unwrap(),
    )
    .unwrap();
    let rotation_id = original.add_object(Object::Integer(0));
    for overlay in [false, true] {
        for rotation in [
            None,
            Some(Object::Integer(0)),
            Some(Object::Reference(rotation_id)),
            Some(Object::string_literal("invalid")),
            Some(Object::Null),
            Some(Object::Real(0.5)),
        ] {
            let invalid = matches!(
                rotation,
                Some(Object::String(..) | Object::Null | Object::Real(..))
            );
            let mut doc = original.clone();
            if let Some(rotation) = rotation {
                doc.get_dictionary_mut(id).unwrap().set("Rotate", rotation);
            } else {
                doc.get_dictionary_mut(id).unwrap().remove(b"Rotate");
            }
            doc.save(&source).unwrap();
            fs::copy(&source, &output).unwrap();
            let previous = fs::read(&output).unwrap();
            let result = if overlay {
                run_overlay_text(&blank, &source, &output, &instructions)
            } else {
                Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
                    .arg("save-mutations")
                    .arg("--input")
                    .arg(&source)
                    .arg("--output")
                    .arg(&output)
                    .arg("--mutations-file")
                    .arg(&mutations)
                    .args(["--append", "--modified-at", "D:19700101000000Z"])
                    .output()
                    .unwrap()
            };
            assert_eq!(
                result.status.success(),
                !invalid,
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            if invalid {
                assert_eq!(fs::read(&output).unwrap(), previous);
            } else {
                run_text_box_command("parse-annotations", &output, &parsed, None);
                let entries: serde_json::Value = serde_json::from_str(
                    fs::read_to_string(&parsed).unwrap().lines().nth(1).unwrap(),
                )
                .unwrap();
                assert_eq!(entries["entries"].as_array().unwrap().len(), 1);
                assert_eq!(entries["entries"][0]["kind"], "text-box");
                assert_eq!(entries["entries"][0]["text"], "Editable box");
                assert_eq!(entries["entries"][0]["rotation"], 0);
                assert_eq!(
                    entries["entries"][0]["rect"],
                    serde_json::json!({
                        "left":0.1,"top":0.625,"width":0.2,"height":0.125,
                    })
                );
            }
        }
    }
    for file in [blank, source, output, mutations, instructions, parsed] {
        remove_file(file).unwrap();
    }
}

#[test]
fn overlay_destinations_choose_the_source_region_independently_of_link_ownership() {
    for incremental in [false, true] {
        let source = path("split-destination-source", "pdf");
        let input = path("split-destination-input", "pdf");
        let output = path("split-destination-output", "pdf");
        let inspected = path("split-destination-inspected", "pdf");
        let instructions = path("split-destination-plan", "json");
        let mut doc = save_two_pages(&source, [Vec::new(), Vec::new()], Dictionary::new());
        let pages = doc.get_pages().into_values().collect::<Vec<_>>();
        doc.get_dictionary_mut(pages[1])
            .unwrap()
            .set("MediaBox", vec![0.into(), 0.into(), 400.into(), 120.into()]);
        for (index, page) in pages.iter().enumerate() {
            let destination = vec![
                Object::Reference(pages[1]),
                "XYZ".into(),
                205.into(),
                120.into(),
                1.into(),
            ];
            let mut link = dictionary! {"Type"=>"Annot","Subtype"=>"Link","P"=>*page,"Rect"=>vec![30.into(),30.into(),40.into(),40.into()]};
            if index == 0 {
                link.set("Dest", destination);
            } else {
                link.set("A", dictionary! {"S"=>"GoTo","D"=>vec![Object::Reference(pages[1]),"FitR".into(),205.into(),30.into(),240.into(),60.into()]});
            }
            let id = doc.add_object(link);
            doc.get_dictionary_mut(*page)
                .unwrap()
                .set("Annots", vec![Object::Reference(id)]);
        }
        doc.save(&source).unwrap();
        if incremental {
            write_sparse_source(&input, 3, None, None);
        } else {
            let mut target = save_pages(&input, (0..3).map(|_| None), Dictionary::new());
            for page in target.get_pages().into_values() {
                target
                    .get_dictionary_mut(page)
                    .unwrap()
                    .set("MediaBox", vec![0.into(), 0.into(), 210.into(), 120.into()]);
            }
            target.save(&input).unwrap();
        }
        write(&instructions, r#"{"pages":[
          {"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},
          {"sourcePageIndex":1,"outputPageIndex":1,"matrix":[1,0,0,1,5,0],"filterToOutputPage":true,"sourceRegion":{"matrix":[1,0,0,1,0,0],"rect":{"x":0,"y":0,"width":200,"height":120}}},
          {"sourcePageIndex":1,"outputPageIndex":2,"matrix":[1,0,0,1,-195,0],"filterToOutputPage":true,"sourceRegion":{"matrix":[1,0,0,1,0,0],"rect":{"x":200,"y":0,"width":200,"height":120}}}
        ]}"#).unwrap();
        let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let compact = Command::new(qpdf_path())
            .arg(&output)
            .arg(&inspected)
            .output()
            .unwrap();
        assert!(compact.status.success());
        let saved = Document::load(&inspected).unwrap();
        let pages = saved.get_pages().into_values().collect::<Vec<_>>();
        for (index, page) in pages.iter().take(2).enumerate() {
            let id = saved
                .get_dictionary(*page)
                .unwrap()
                .get(b"Annots")
                .unwrap()
                .as_array()
                .unwrap()[0]
                .as_reference()
                .unwrap();
            let link = saved.get_dictionary(id).unwrap();
            assert_eq!(link.get(b"P").unwrap().as_reference().unwrap(), *page);
            let destination = if index == 0 {
                link.get(b"Dest").unwrap()
            } else {
                link.get(b"A")
                    .unwrap()
                    .as_dict()
                    .unwrap()
                    .get(b"D")
                    .unwrap()
            }
            .as_array()
            .unwrap();
            assert_eq!(destination[0].as_reference().unwrap(), pages[2]);
            assert_eq!(destination[2].as_float().unwrap(), 10.);
            if index == 0 {
                assert_eq!(destination[1].as_name().unwrap(), b"XYZ");
                assert_eq!(destination[3].as_float().unwrap(), 120.);
            } else {
                assert_eq!(destination[1].as_name().unwrap(), b"FitR");
                assert_eq!(destination[3].as_float().unwrap(), 30.);
                assert_eq!(destination[4].as_float().unwrap(), 45.);
                assert_eq!(destination[5].as_float().unwrap(), 60.);
            }
        }
        assert!(saved
            .get_dictionary(pages[2])
            .unwrap()
            .get(b"Annots")
            .map_or(true, |annots| annots.as_array().unwrap().is_empty()));
        for file in [source, input, output, inspected, instructions] {
            remove_file(file).unwrap();
        }
    }
}

#[test]
fn overlay_selects_the_first_surviving_destination_output() {
    for destination in [
        vec!["Fit".into()],
        vec!["XYZ".into(), Object::Null, Object::Null, Object::Null],
        vec!["FitR".into(), 90.into(), 20.into(), 110.into(), 60.into()],
    ] {
        let source = path("ambiguous-destination-source", "pdf");
        let input = path("ambiguous-destination-input", "pdf");
        let output = path("ambiguous-destination-output", "pdf");
        let instructions = path("ambiguous-destination-plan", "json");
        let mut doc = save_single_page(&source, Vec::new(), Dictionary::new());
        let page = doc.get_pages()[&1];
        let plan = if destination[0].as_name().unwrap() == b"FitR" {
            r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"sourceRegion":{"matrix":[1,0,0,1,0,0],"rect":{"x":0,"y":0,"width":100,"height":120}}},{"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"sourceRegion":{"matrix":[1,0,0,1,0,0],"rect":{"x":100,"y":0,"width":100,"height":120}}}]}"#
        } else {
            r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true},{"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true}]}"#
        };
        let dest = [vec![Object::Reference(page)], destination].concat();
        let link = doc.add_object(dictionary! {"Type"=>"Annot","Subtype"=>"Link","P"=>page,"Rect"=>vec![30.into(),30.into(),40.into(),40.into()],"Dest"=>dest});
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Annots", vec![Object::Reference(link)]);
        doc.save(&source).unwrap();
        save_empty_pages(&input, 2);
        write(&output, b"existing output").unwrap();
        write(&instructions, plan).unwrap();
        let result = run_overlay_text(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let saved = Document::load(&output).unwrap();
        let first = saved.get_pages()[&1];
        let annotation = saved
            .get_dictionary(
                saved
                    .get_dictionary(first)
                    .unwrap()
                    .get(b"Annots")
                    .unwrap()
                    .as_array()
                    .unwrap()[0]
                    .as_reference()
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            annotation.get(b"Dest").unwrap().as_array().unwrap()[0]
                .as_reference()
                .unwrap(),
            first
        );
        assert!(atomic_output_siblings(&output).is_empty());
        for file in [source, input, output, instructions] {
            remove_file(file).unwrap();
        }
    }
}

#[test]
fn overlay_transforms_fitted_and_partial_destination_coordinates() {
    let cases = [
        (
            vec!["XYZ".into(), 30.into(), 60.into(), Object::Null],
            vec!["XYZ".into(), 60.into(), 30.into(), Object::Null],
        ),
        (
            vec!["XYZ".into(), Object::Null, 60.into(), Object::Null],
            vec!["XYZ".into(), 60.into(), Object::Null, Object::Null],
        ),
        (
            vec!["FitH".into(), 60.into()],
            vec!["FitV".into(), 60.into()],
        ),
        (
            vec!["FitBH".into(), 60.into()],
            vec!["FitBV".into(), 60.into()],
        ),
        (
            vec!["FitV".into(), 30.into()],
            vec!["FitH".into(), 30.into()],
        ),
        (
            vec!["FitBV".into(), 30.into()],
            vec!["FitBH".into(), 30.into()],
        ),
        (
            vec!["FitR".into(), 10.into(), 20.into(), 40.into(), 60.into()],
            vec!["FitR".into(), 60.into(), 10.into(), 100.into(), 40.into()],
        ),
        (vec!["Fit".into()], vec!["Fit".into()]),
        (vec!["FitB".into()], vec!["FitB".into()]),
    ];
    for (destination, expected) in cases {
        let source = path("fitted-destination-source", "pdf");
        let input = path("fitted-destination-input", "pdf");
        let output = path("fitted-destination-output", "pdf");
        let instructions = path("fitted-destination-plan", "json");
        let mut doc = save_single_page(&source, Vec::new(), Dictionary::new());
        let page = doc.get_pages()[&1];
        let link=doc.add_object(dictionary! {"Type"=>"Annot","Subtype"=>"Link","P"=>page,
            "Rect"=>vec![30.into(),30.into(),40.into(),40.into()],"Dest"=>[vec![Object::Reference(page)],destination].concat()});
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Annots", vec![Object::Reference(link)]);
        doc.save(&source).unwrap();
        save_empty_pages(&input, 1);
        write(
            &instructions,
            r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[0,1,-1,0,120,0]}]}"#,
        )
        .unwrap();
        let result = run_overlay_text(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let saved = Document::load(&output).unwrap();
        let page = saved.get_pages()[&1];
        let id = saved
            .get_dictionary(page)
            .unwrap()
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .as_reference()
            .unwrap();
        let destination = saved
            .get_dictionary(id)
            .unwrap()
            .get(b"Dest")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(destination[0].as_reference().unwrap(), page);
        assert_eq!(destination.len(), expected.len() + 1);
        for (actual, expected) in destination.iter().skip(1).zip(expected) {
            if let Ok(value) = expected.as_float() {
                assert_eq!(actual.as_float().unwrap(), value);
            } else {
                assert_eq!(*actual, expected);
            }
        }
        for file in [source, input, output, instructions] {
            remove_file(file).unwrap();
        }
    }
}

/// A 200 pt page with one legacy point marker (ADR 0003) and its popup. Each
/// key named in `indirect` is stored as its own object, as qpdf writes it.
fn save_legacy_marker_source(path: &Path, indirect: &[&str]) {
    let mut document = save_single_page(path, Vec::new(), Dictionary::new());
    let page_id = document.get_pages()[&1];
    let appearance = document.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 2.into(), 2.into()]},
        Vec::new(),
    ));
    let popup = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Popup", "P" => page_id,
        "Rect" => vec![30.into(), 60.into(), 80.into(), 100.into()],
        "Contents" => Object::string_literal("Legacy popup"),
    });
    let values = [
        (
            "Rect",
            Object::Array(vec![48.9.into(), 49.into(), 51.1.into(), 51.2.into()]),
        ),
        ("CreationDate", Object::string_literal("D:20260830130000Z")),
        ("M", Object::string_literal("D:20261011000000Z")),
    ];
    let mut root = dictionary! {
        "Type" => "Annot", "Subtype" => "FreeText", "P" => page_id,
        "Contents" => Object::string_literal("Legacy marker"),
        "AP" => dictionary! {"N" => appearance},
        "Popup" => popup,
    };
    for (key, value) in values {
        let value = if indirect.contains(&key) {
            Object::Reference(document.add_object(value))
        } else {
            value
        };
        root.set(key, value);
    }
    let root = document.add_object(root);
    document
        .get_dictionary_mut(popup)
        .unwrap()
        .set("Parent", root);
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        vec![Object::Reference(root), Object::Reference(popup)],
    );
    document.save(path).unwrap();
}

/// Contents of every note entry in a `parse-annotations` output.
fn parsed_note_contents(parsed: &Path) -> Vec<String> {
    fs::read_to_string(parsed)
        .unwrap()
        .lines()
        .skip(1)
        .flat_map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["entries"]
                .as_array()
                .unwrap()
                .clone()
        })
        .filter(|entry| entry["kind"] == "note")
        .map(|entry| entry["contents"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn overlay_keeps_a_legacy_marker_with_an_indirect_rect_as_a_note() {
    let source = path("legacy-indirect-rect-source", "pdf");
    let input = path("legacy-indirect-rect-target", "pdf");
    let output = path("legacy-indirect-rect-output", "pdf");
    let instructions = path("legacy-indirect-rect", "json");
    let parsed = path("legacy-indirect-rect-parsed", "jsonl");
    save_legacy_marker_source(&source, &["Rect"]);
    save_single_page(&input, Vec::new(), Dictionary::new());
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true}]}"#,
    )
    .unwrap();

    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    run_text_box_command("parse-annotations", &output, &parsed, None);
    assert_eq!(parsed_note_contents(&parsed), ["Legacy marker"]);
    for file in [source, input, output, instructions, parsed] {
        remove_file(file).unwrap();
    }
}

#[test]
fn overlay_keeps_indirect_creation_and_modified_dates_on_a_converted_marker() {
    let source = path("legacy-indirect-dates-source", "pdf");
    let input = path("legacy-indirect-dates-target", "pdf");
    let output = path("legacy-indirect-dates-output", "pdf");
    let instructions = path("legacy-indirect-dates", "json");
    save_legacy_marker_source(&source, &["CreationDate", "M"]);
    save_single_page(&input, Vec::new(), Dictionary::new());
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true}]}"#,
    )
    .unwrap();

    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let converted = Document::load(&output).unwrap();
    let note = converted
        .objects
        .values()
        .filter_map(|object| object.as_dict().ok())
        .find(|dictionary| {
            dictionary.get(b"Contents").and_then(Object::as_str).ok() == Some(b"Legacy marker")
                && dictionary.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Text")
        })
        .expect("the legacy marker is written as a /Text note");
    assert_eq!(
        note.get(b"CreationDate").and_then(Object::as_str).unwrap(),
        b"D:20260830130000Z"
    );
    assert_eq!(
        note.get(b"M").and_then(Object::as_str).unwrap(),
        b"D:20261011000000Z"
    );
    for file in [source, input, output, instructions] {
        remove_file(file).unwrap();
    }
}

/// A source note at `rect` and a 10 pt wide output that keeps the note's centre
/// through a 100 pt source region. The note cannot fit the output, so the
/// overlay refuses and publishes nothing rather than a foreign note.
fn assert_overlay_refuses_note_wider_than_output(label: &str, rect: [i64; 4]) {
    let source = path(&format!("{label}-source"), "pdf");
    let input = path(&format!("{label}-target"), "pdf");
    let output = path(&format!("{label}-output"), "pdf");
    let instructions = path(label, "json");
    let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
    let page_id = document.get_pages()[&1];
    let note = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "P" => page_id,
        "Rect" => rect.map(Object::from).to_vec(),
        "Contents" => Object::string_literal("Wide note"),
    });
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(note)]);
    document.save(&source).unwrap();
    let mut target = save_single_page(&input, Vec::new(), Dictionary::new());
    let target_page = target.get_pages()[&1];
    target
        .get_dictionary_mut(target_page)
        .unwrap()
        .set("MediaBox", vec![0.into(), 0.into(), 10.into(), 120.into()]);
    target.save(&input).unwrap();
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true,"sourceRegion":{"matrix":[1,0,0,1,0,0],"rect":{"x":0,"y":0,"width":100,"height":120}}}]}"#,
    )
    .unwrap();

    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(
        !result.status.success(),
        "an 11 pt note on a 10 pt page must be refused"
    );
    assert!(!output.exists(), "a refused overlay publishes no output");
    for file in [source, input, instructions] {
        remove_file(file).unwrap();
    }
}

#[test]
fn overlay_refuses_a_note_wider_than_its_output_page() {
    assert_overlay_refuses_note_wider_than_output("note-too-wide", [45, 45, 56, 55]);
}

#[test]
fn overlay_refuses_an_overwide_note_already_at_the_output_origin() {
    assert_overlay_refuses_note_wider_than_output("note-too-wide-origin", [0, 45, 11, 55]);
}

#[test]
fn overlay_copies_a_text_annotation_its_source_page_already_shows_as_foreign() {
    // A /Text root wider than its own source page is not a note there, so the
    // overlay copies it as it is rather than refusing the whole document.
    let source = path("foreign-wide-text-source", "pdf");
    let input = path("foreign-wide-text-target", "pdf");
    let output = path("foreign-wide-text-output", "pdf");
    let instructions = path("foreign-wide-text", "json");
    let mut document = save_single_page(&source, Vec::new(), Dictionary::new());
    let page_id = document.get_pages()[&1];
    let note = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "P" => page_id,
        "Rect" => vec![(-60).into(), 45.into(), 165.into(), 55.into()],
        "Contents" => Object::string_literal("Foreign wide text"),
    });
    document
        .get_dictionary_mut(page_id)
        .unwrap()
        .set("Annots", vec![Object::Reference(note)]);
    document.save(&source).unwrap();
    let mut target = save_single_page(&input, Vec::new(), Dictionary::new());
    let target_page = target.get_pages()[&1];
    target
        .get_dictionary_mut(target_page)
        .unwrap()
        .set("MediaBox", vec![0.into(), 0.into(), 10.into(), 120.into()]);
    target.save(&input).unwrap();
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true,"sourceRegion":{"matrix":[1,0,0,1,0,0],"rect":{"x":0,"y":0,"width":100,"height":120}}}]}"#,
    )
    .unwrap();

    let result = run_overlay_text_with_qpdf(&input, &source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(output.exists(), "the overlay publishes its output");
    for file in [source, input, output, instructions] {
        remove_file(file).unwrap();
    }
}

/// A 200 x 120 source page holding one note with `rect`. With `indirect_subtype`
/// the /Subtype is an indirect name object, as some writers emit it.
fn save_note_source(path: &Path, indirect_subtype: bool, rect: [i64; 4]) {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let page_id = document.new_object_id();
    let subtype = Object::Name(b"Text".to_vec());
    let subtype = if indirect_subtype {
        Object::Reference(document.add_object(subtype))
    } else {
        subtype
    };
    let note_id = document.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => subtype,
        "P" => page_id,
        "Rect" => rect.map(Object::Integer).to_vec(),
        "Contents" => Object::string_literal("source note"),
    });
    document.objects.insert(
        page_id,
        dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
            "Annots" => vec![Object::Reference(note_id)],
        }
        .into(),
    );
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
}

/// A blank one-page target `width` points wide and 120 points high.
fn save_target_of_width(path: &Path, width: i64) {
    let mut document = save_pages(path, std::iter::once(None), Dictionary::new());
    for page in document.get_pages().into_values() {
        document.get_dictionary_mut(page).unwrap().set(
            "MediaBox",
            vec![0.into(), 0.into(), width.into(), 120.into()],
        );
    }
    document.save(path).unwrap();
}

/// Overlays the whole 200 x 120 source onto the target's page without moving it.
fn overlay_whole_source_instructions() -> &'static str {
    r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"filterToOutputPage":true,"sourceRegion":{"matrix":[1,0,0,1,0,0],"rect":{"x":0,"y":0,"width":200,"height":120}}}]}"#
}

#[test]
fn overlay_refuses_a_note_whose_indirect_subtype_is_wider_than_its_output_page() {
    for indirect_subtype in [false, true] {
        let source = path("overwide-note-source", "pdf");
        let input = path("overwide-note-target", "pdf");
        let output = path("overwide-note-output", "pdf");
        let instructions = path("overwide-note-instructions", "json");
        // An 11 pt note admitted on its 200 pt source page cannot stay a note on a 10 pt page.
        save_note_source(&source, indirect_subtype, [0, 45, 11, 55]);
        save_target_of_width(&input, 10);
        write(&instructions, overlay_whole_source_instructions()).unwrap();

        let result = run_overlay_text(&input, &source, &output, &instructions);

        assert!(
            !result.status.success(),
            "indirect subtype {indirect_subtype}: an admitted note was published on a page it cannot fit"
        );
        for file in [source, input, instructions] {
            remove_file(file).unwrap();
        }
    }
}

#[test]
fn overlay_leaves_a_foreign_note_where_it_is_on_any_output_page() {
    for target_width in [150, 300] {
        let source = path("foreign-note-source", "pdf");
        let input = path("foreign-note-target", "pdf");
        let output = path("foreign-note-output", "pdf");
        let instructions = path("foreign-note-instructions", "json");
        // The 225 pt rectangle is wider than the 200 pt source page, so the reader
        // does not admit it as a note and the overlay must not move or reclassify it.
        save_note_source(&source, false, [-60, 45, 165, 55]);
        save_target_of_width(&input, target_width);
        write(&instructions, overlay_whole_source_instructions()).unwrap();

        let result = run_overlay_text(&input, &source, &output, &instructions);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );

        let saved = Document::load(&output).unwrap();
        let page = saved.get_pages()[&1];
        let annots = saved.get_dictionary(page).unwrap().get(b"Annots").unwrap();
        let (_, annots) = saved.dereference(annots).unwrap();
        let (_, note) = saved.dereference(&annots.as_array().unwrap()[0]).unwrap();
        let rect: Vec<f32> = note
            .as_dict()
            .unwrap()
            .get(b"Rect")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_float().unwrap())
            .collect();
        assert_eq!(
            rect,
            [-60.0, 45.0, 165.0, 55.0],
            "target width {target_width}"
        );

        let parsed = path("foreign-note-parsed", "jsonl");
        let parse = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
            .args(["parse-annotations", "--input"])
            .arg(&output)
            .arg("--output")
            .arg(&parsed)
            .args(["--modified-at", "D:20261011000000Z"])
            .output()
            .unwrap();
        assert!(parse.status.success());
        let kinds: Vec<String> = fs::read_to_string(&parsed)
            .unwrap()
            .lines()
            .skip(1)
            .flat_map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["entries"]
                    .as_array()
                    .unwrap()
                    .clone()
            })
            .map(|entry| entry["kind"].as_str().unwrap().to_string())
            .collect();
        // Only a 150 pt page is too narrow for the 225 pt rectangle. On 300 pt the
        // reader admits it by its own rule, which placement does not decide.
        if target_width == 150 {
            assert_eq!(kinds, ["foreign"]);
        }
        for file in [source, input, output, instructions, parsed] {
            remove_file(file).unwrap();
        }
    }
}

/// A retained destination that the output refuses leaves the output's bytes
/// as they were. The copy and the rebinding publish together, so a refused
/// rebinding cannot leave the copied pages behind. The refused link names a
/// page that two preserved halves show, but has an unsupported destination mode.
#[test]
fn overlay_text_refused_retained_destination_leaves_existing_output_bytes() {
    let source = path("retained-refusal-source", "pdf");
    let split_instructions = path("retained-refusal-split", "json");
    let split = path("retained-refusal-split-output", "pdf");
    let raster = path("retained-refusal-raster", "pdf");
    let assembled = path("retained-refusal-assembled", "pdf");
    let instructions = path("retained-refusal-instructions", "json");
    let output = path("retained-refusal-output", "pdf");

    let mut document = save_two_pages(&source, [Vec::new(), Vec::new()], Dictionary::new());
    let first_page = document.get_pages()[&1];
    let link = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link", "P" => first_page,
        "Rect" => vec![20.into(), 20.into(), 40.into(), 40.into()],
        "Dest" => vec![first_page.into(), "UnsupportedDestination".into()],
    });
    document
        .get_dictionary_mut(first_page)
        .unwrap()
        .set("Annots", vec![Object::Reference(link)]);
    document.save(&source).unwrap();
    write(
        &split_instructions,
        r#"{"catalog":"assembly","pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":100,"height":120},"contentTransform":{"scale":1,"translateX":0,"translateY":0}},{"cropRect":{"x":0,"y":0,"width":100,"height":120},"contentTransform":{"scale":1,"translateX":-100,"translateY":0}}]}]}"#,
    )
    .unwrap();
    run_split_pages(&source, &split, &split_instructions);
    save_empty_pages(&raster, 1);
    let interleave = Command::new(qpdf_path())
        .arg(&raster)
        .args(["--coalesce-contents", "--pages"])
        .arg(&split)
        .arg("1-2")
        .arg(&raster)
        .arg("1")
        .arg("--")
        .arg(&assembled)
        .output()
        .unwrap();
    assert!(
        interleave.status.success(),
        "{}",
        String::from_utf8_lossy(&interleave.stderr)
    );
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"linkOnly":true},{"sourcePageIndex":0,"outputPageIndex":1,"matrix":[1,0,0,1,-100,0],"linkOnly":true},{"sourcePageIndex":1,"outputPageIndex":2,"matrix":[1,0,0,1,0,0]}]}"#,
    )
    .unwrap();

    // A separate output and an input that is also the output: both keep their
    // bytes, the run fails on the retained destination itself, and no staged
    // sibling is left behind.
    let assert_refused_on_destination = |refused: std::process::Output| {
        assert!(!refused.status.success());
        let stderr = String::from_utf8_lossy(&refused.stderr);
        assert!(
            stderr.contains("cannot resolve an internal destination"),
            "unexpected failure: {stderr}"
        );
        assert!(atomic_output_siblings(&output).is_empty());
    };
    write(
        &output,
        b"existing output must survive a refused retained destination",
    )
    .unwrap();
    let separate_before = fs::read(&output).unwrap();
    assert_refused_on_destination(run_overlay_text(
        &assembled,
        &source,
        &output,
        &instructions,
    ));
    assert_eq!(fs::read(&output).unwrap(), separate_before);

    fs::copy(&assembled, &output).unwrap();
    let same_path_before = fs::read(&output).unwrap();
    assert_refused_on_destination(run_overlay_text(&output, &source, &output, &instructions));
    assert_eq!(fs::read(&output).unwrap(), same_path_before);

    for file in [
        source,
        split_instructions,
        split,
        raster,
        assembled,
        instructions,
        output,
    ] {
        let _ = remove_file(file);
    }
}
/// The note shapes that review34 found losing their replies in the qpdf
/// interleave: identical bodies, indirect /M, /Contents and /NM, an /AP stream.
#[derive(Clone, Copy)]
enum NoteShape {
    Single,
    Identical,
    IndirectModified,
    IndirectContents,
    IndirectName,
    Appearance,
}

/// A page with one Text note per root, each with a reply and a popup. A
/// two-root shape puts both roots on the page, so the interleave copies each
/// one; the reply and popup are direct objects in every shape.
fn save_note_thread_source(path: &Path, shape: NoteShape) {
    let mut document = save_single_page(path, Vec::new(), Dictionary::new());
    let page_id = document.get_pages()[&1];
    let root_count = match shape {
        NoteShape::Single | NoteShape::Appearance => 1,
        _ => 2,
    };
    let mut annotations = Vec::new();
    for index in 0..root_count {
        let contents = match shape {
            NoteShape::IndirectContents => Object::Reference(
                document.add_object(Object::string_literal(format!("different body {index}"))),
            ),
            _ => Object::string_literal("same note"),
        };
        let root_id = document.new_object_id();
        let mut root = dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "P" => page_id,
            "Rect" => vec![48.into(), 48.into(), 52.into(), 52.into()],
            "Contents" => contents,
        };
        match shape {
            NoteShape::IndirectModified => root.set(
                "M",
                document.add_object(Object::string_literal(format!("D:2026101100000{index}Z"))),
            ),
            NoteShape::IndirectName => root.set(
                "NM",
                document.add_object(Object::string_literal(format!("unique-{index}"))),
            ),
            NoteShape::Appearance => {
                let normal = document.add_object(Stream::new(
                    dictionary! {
                        "Type" => "XObject", "Subtype" => "Form",
                        "BBox" => vec![0.into(), 0.into(), 4.into(), 4.into()],
                    },
                    b"0 0 1 rg 0 0 4 4 re f".to_vec(),
                ));
                root.set("AP", dictionary! {"N" => normal});
            }
            NoteShape::Single | NoteShape::Identical | NoteShape::IndirectContents => {}
        }
        let reply_id = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "P" => page_id, "IRT" => root_id,
            "Rect" => vec![45.into(), 45.into(), 55.into(), 55.into()],
            "Contents" => Object::string_literal(format!("reply-{index}")),
        });
        let popup_id = document.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Popup", "P" => page_id, "Parent" => root_id,
            "Rect" => vec![30.into(), 60.into(), 80.into(), 100.into()],
        });
        root.set("Popup", popup_id);
        document.set_object(root_id, root);
        annotations.extend([root_id, reply_id, popup_id]);
    }
    document.get_dictionary_mut(page_id).unwrap().set(
        "Annots",
        annotations
            .into_iter()
            .map(Object::Reference)
            .collect::<Vec<_>>(),
    );
    document.save(path).unwrap();
}

/// The compact cleanup of one preserved source page, assembled as the
/// scan-cleanup product does it: split-pages, then the qpdf interleave with the
/// split as the primary input, then the overlay that rebinds retained links.
/// A raster page follows the preserved page when `with_raster` is set. When
/// `copied_text_page` is set, that raster page also has its source page's text
/// and annotations copied over it, as a text layer does.
fn assemble_compact_cleanup(
    source: &Path,
    label: &str,
    with_raster: bool,
    copied_text_page: bool,
) -> std::path::PathBuf {
    let split_instructions = path(&format!("{label}-split"), "json");
    write(
        &split_instructions,
        r#"{"catalog":"assembly","pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":120},"contentTransform":{"scale":1,"translateX":0,"translateY":0}}]}]}"#,
    )
    .unwrap();
    let split = path(&format!("{label}-split-output"), "pdf");
    run_split_pages(source, &split, &split_instructions);
    let raster = path(&format!("{label}-raster"), "pdf");
    save_empty_pages(&raster, 1);
    let assembled = path(&format!("{label}-assembled"), "pdf");
    let mut interleave = Command::new(qpdf_path());
    interleave
        .arg(&split)
        .args(["--coalesce-contents", "--pages", ".", "1"]);
    if with_raster {
        interleave.arg(&raster).arg("1");
    }
    let interleave = interleave.arg("--").arg(&assembled).output().unwrap();
    assert!(
        interleave.status.success(),
        "{}",
        String::from_utf8_lossy(&interleave.stderr)
    );
    let instructions = path(&format!("{label}-instructions"), "json");
    let copied_page = if copied_text_page {
        r#",{"sourcePageIndex":1,"outputPageIndex":1,"matrix":[1,0,0,1,0,0]}"#
    } else {
        ""
    };
    write(
        &instructions,
        format!(
            r#"{{"pages":[{{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0],"linkOnly":true}}{copied_page}]}}"#
        ),
    )
    .unwrap();
    let output = path(&format!("{label}-output"), "pdf");
    let result = run_overlay_text(&assembled, source, &output, &instructions);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let check = Command::new(qpdf_path())
        .arg("--check")
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        check.status.success(),
        "{}",
        String::from_utf8_lossy(&check.stdout)
    );
    let expected_pages = if with_raster { 2 } else { 1 };
    assert_eq!(
        Document::load(&output).unwrap().get_pages().len(),
        expected_pages,
        "the assembled cleanup has no page beyond its plan"
    );
    output
}

/// Each note with its page and the contents of its replies, read the way a reader does.
fn note_threads(pdf: &Path, label: &str) -> Vec<(u64, String, Vec<String>)> {
    let parsed = path(&format!("{label}-threads"), "jsonl");
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["parse-annotations", "--input"])
        .arg(pdf)
        .arg("--output")
        .arg(&parsed)
        .args(["--modified-at", "D:20261011000000Z"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let entries = fs::read_to_string(&parsed)
        .unwrap()
        .lines()
        .skip(1)
        .flat_map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["entries"]
                .as_array()
                .unwrap()
                .clone()
        })
        .collect::<Vec<_>>();
    let _ = remove_file(&parsed);
    let mut threads = entries
        .iter()
        .filter(|entry| entry["kind"] == "note")
        .map(|note| {
            let replies = note["replies"]
                .as_array()
                .unwrap()
                .iter()
                .map(|reply| reply["contents"].as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            (
                note["pageIndex"].as_u64().unwrap(),
                note["contents"].as_str().unwrap_or("").to_string(),
                replies,
            )
        })
        .collect::<Vec<_>>();
    threads.sort();
    threads
}

/// Every note of the source keeps its own replies in the assembled cleanup.
fn assert_compact_cleanup_keeps_note_replies(label: &str, shape: NoteShape, with_raster: bool) {
    let source = path(&format!("{label}-source"), "pdf");
    save_note_thread_source(&source, shape);
    let source_threads = note_threads(&source, &format!("{label}-source"));
    assert!(
        source_threads
            .iter()
            .all(|(_, _, replies)| replies.len() == 1),
        "the source gives each note one reply: {source_threads:?}"
    );
    let output = assemble_compact_cleanup(&source, label, with_raster, false);
    assert_eq!(note_threads(&output, label), source_threads);
}

#[test]
fn compact_cleanup_keeps_a_note_reply_through_the_interleave() {
    assert_compact_cleanup_keeps_note_replies("reply-single", NoteShape::Single, true);
}

#[test]
fn compact_cleanup_keeps_each_reply_of_identical_notes() {
    assert_compact_cleanup_keeps_note_replies("reply-identical", NoteShape::Identical, true);
}

#[test]
fn compact_cleanup_keeps_replies_of_notes_with_indirect_modification_dates() {
    assert_compact_cleanup_keeps_note_replies(
        "reply-indirect-m",
        NoteShape::IndirectModified,
        true,
    );
}

#[test]
fn compact_cleanup_keeps_replies_of_notes_with_indirect_contents() {
    assert_compact_cleanup_keeps_note_replies(
        "reply-indirect-contents",
        NoteShape::IndirectContents,
        true,
    );
}

#[test]
fn compact_cleanup_keeps_replies_of_notes_with_indirect_names() {
    assert_compact_cleanup_keeps_note_replies("reply-indirect-nm", NoteShape::IndirectName, true);
}

#[test]
fn compact_cleanup_keeps_the_reply_of_a_note_with_an_appearance() {
    assert_compact_cleanup_keeps_note_replies("reply-appearance", NoteShape::Appearance, true);
}

#[test]
fn all_preserved_compact_cleanup_keeps_each_note_reply() {
    assert_compact_cleanup_keeps_note_replies("reply-all-preserved", NoteShape::Identical, false);
}

/// Two pages each hold a note with the same body. The reply on page 1 names the
/// page-2 note as its root, so it must not be attached to page 1's own note.
/// Cross-page threads are otherwise unchanged by this fix.
fn save_cross_page_thread_source(path: &Path) {
    let mut document = save_pages(path, (0..2).map(|_| None), Dictionary::new());
    let pages = document.get_pages();
    let (first_page, second_page) = (pages[&1], pages[&2]);
    let unrelated = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "P" => first_page,
        "Rect" => vec![48.into(), 48.into(), 52.into(), 52.into()],
        "Contents" => Object::string_literal("same body"),
    });
    let target = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "P" => second_page,
        "Rect" => vec![48.into(), 48.into(), 52.into(), 52.into()],
        "Contents" => Object::string_literal("same body"),
    });
    let reply = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "P" => first_page, "IRT" => target,
        "Rect" => vec![45.into(), 45.into(), 55.into(), 55.into()],
        "Contents" => Object::string_literal("reply intended for page 2"),
    });
    document
        .get_dictionary_mut(first_page)
        .unwrap()
        .set("Annots", vec![unrelated.into(), reply.into()]);
    document
        .get_dictionary_mut(second_page)
        .unwrap()
        .set("Annots", vec![target.into()]);
    document.save(path).unwrap();
}

#[test]
fn compact_cleanup_does_not_attach_a_cross_page_reply_to_a_same_body_note() {
    let source = path("cross-page-source", "pdf");
    save_cross_page_thread_source(&source);
    let output = assemble_compact_cleanup(&source, "cross-page", true, true);
    let threads = note_threads(&output, "cross-page");
    let page_one_replies = threads
        .iter()
        .filter(|(page, _, _)| *page == 0)
        .flat_map(|(_, _, replies)| replies)
        .collect::<Vec<_>>();
    assert!(
        page_one_replies.is_empty(),
        "a reply for the page-2 note attached to page 1's same-body note: {threads:?}"
    );
}

#[test]
fn lossless_split_keeps_each_note_reply() {
    let source = path("reply-lossless-source", "pdf");
    save_note_thread_source(&source, NoteShape::Identical);
    let instructions = path("reply-lossless-instructions", "json");
    write(
        &instructions,
        r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":120}}]}]}"#,
    )
    .unwrap();
    let output = path("reply-lossless-output", "pdf");
    run_split_pages(&source, &output, &instructions);

    let source_threads = note_threads(&source, "reply-lossless-source");
    assert_eq!(source_threads.len(), 2);
    assert_eq!(note_threads(&output, "reply-lossless"), source_threads);

    for file in [source, instructions, output] {
        let _ = remove_file(file);
    }
}
