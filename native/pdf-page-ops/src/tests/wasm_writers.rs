//! Each browser writer against its desktop command on the same input: the CLI
//! entry the native binary runs writes files, and the WASM request entry answers
//! with bytes. Whole-document writers must return the desktop output file;
//! appending writers must return what the desktop appends to its copy of the
//! input.

use super::*;
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "evb-wasm-writer-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn arg(path: &Path) -> String {
    path.to_str().unwrap().to_string()
}

/// Runs a desktop command as the binary would; `None` when it wrote no file.
fn run_cli(
    scratch: &Scratch,
    command: &str,
    input: &[u8],
    instructions: &str,
    source: Option<&[u8]>,
) -> Option<Vec<u8>> {
    let output = scratch.0.join(format!("{command}-output.pdf"));
    let _ = fs::remove_file(&output);
    let mut args = vec![
        command.to_string(),
        "--input".into(),
        arg(&scratch.write(&format!("{command}-input.pdf"), input)),
        "--output".into(),
        arg(&output),
        "--instructions-file".into(),
        arg(&scratch.write(
            &format!("{command}-instructions.json"),
            instructions.as_bytes(),
        )),
    ];
    if let Some(source) = source {
        args.extend([
            "--source".into(),
            arg(&scratch.write(&format!("{command}-source.pdf"), source)),
        ]);
    }
    crate::run_cli_entry(args).unwrap();
    fs::read(output).ok()
}

struct Reported {
    kind: u32,
    page_count: u32,
    data: Vec<u8>,
    report: serde_json::Value,
}

fn run_wasm(operation: u32, data: &[u8], instructions: &str, attachments: &[&[u8]]) -> Reported {
    let output = run_request(&instructed_request(
        operation,
        data,
        instructions,
        attachments,
    ))
    .unwrap();
    let field = |offset| read_u32_at(&output, offset).unwrap();
    let data_len = field(REPORTED_HEADER.data_length) as usize;
    let report_len = field(REPORTED_HEADER.report_length) as usize;
    assert_eq!(output.len(), REPORTED_HEADER.bytes + data_len + report_len);
    let report_start = REPORTED_HEADER.bytes + data_len;
    Reported {
        kind: field(REPORTED_HEADER.kind),
        page_count: field(REPORTED_HEADER.page_count),
        data: output[REPORTED_HEADER.bytes..report_start].to_vec(),
        report: serde_json::from_slice(&output[report_start..]).unwrap(),
    }
}

fn save(document: &mut Document) -> Vec<u8> {
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

/// The public synthetic three-page catalog_probe.py source from review-b6h:
/// labels, destinations, a form, structure tags, Info and two OCGs.
fn catalog_source() -> Vec<u8> {
    let hex = include_str!("../../tests/fixtures/scan-cleanup-catalog.pdf.hex");
    let hex = hex.split_whitespace().collect::<String>();
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

/// The catalog source with searchable text on its first page, so an overlay
/// copies text as well as annotations.
fn catalog_source_with_text() -> Vec<u8> {
    let mut document = Document::load_mem(&catalog_source()).unwrap();
    let page = *document.get_pages().get(&1).unwrap();
    let font = document.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    });
    let text = document.add_object(Stream::new(
        dictionary! {},
        b"BT /EvbParityFont 12 Tf 20 60 Td (Source text) Tj ET".to_vec(),
    ));
    let mut resources = match document.get_dictionary(page).unwrap().get(b"Resources") {
        Ok(resources) => document
            .dereference(resources)
            .unwrap()
            .1
            .as_dict()
            .unwrap()
            .clone(),
        Err(_) => lopdf::Dictionary::new(),
    };
    resources.set("Font", dictionary! { "EvbParityFont" => font });
    let page = document.get_dictionary_mut(page).unwrap();
    page.set("Resources", resources);
    page.set("Contents", Object::Reference(text));
    save(&mut document)
}

fn split_instructions(order: [usize; 3], crop_width: u32, assembly: bool, stamp: bool) -> String {
    let mut value = serde_json::json!({"pages": order.iter().map(|index| serde_json::json!({
        "sourcePageIndex": index, "rotationQuarterTurns": 0,
        "outputs": [{"cropRect": {"x": 0, "y": 0, "width": crop_width, "height": 120},
            "contentTransform": {"scale": 1, "translateX": 0, "translateY": 0}}],
    })).collect::<Vec<_>>()});
    if assembly {
        value["catalog"] = "assembly".into();
    }
    if stamp {
        value["provenanceStampHex"] = "54455354".into();
    }
    value.to_string()
}

#[test]
fn split_pages_returns_the_file_the_desktop_command_writes() {
    let scratch = Scratch::new("split");
    let source = catalog_source();
    for (crop_width, assembly, stamp, tags_removed) in [
        // Reordered pages keep no structure tree: the report says so.
        (200, false, false, true),
        (100, false, true, true),
        // An assembly never had the source's tags to keep.
        (200, true, true, false),
    ] {
        let instructions = split_instructions([2, 0, 1], crop_width, assembly, stamp);
        let desktop = run_cli(&scratch, "split-pages", &source, &instructions, None).unwrap();
        let browser = run_wasm(OP_SPLIT_PAGES, &source, &instructions, &[]);
        assert_eq!(browser.kind, RESPONSE_REPORTED_PDF);
        assert!(
            browser.data == desktop,
            "split-pages bytes differ: {instructions}"
        );
        assert_eq!(browser.page_count, 3);
        let expected = if tags_removed {
            serde_json::json!({"accessibilityTagsRemoved": true})
        } else {
            serde_json::json!({})
        };
        assert_eq!(browser.report, expected, "{instructions}");
        let tagged = Document::load_mem(&browser.data)
            .unwrap()
            .catalog()
            .unwrap()
            .has(b"StructTreeRoot");
        assert!(!tagged);
    }
}

#[test]
fn split_pages_keeps_tags_for_an_unchanged_page_order_and_says_nothing() {
    let scratch = Scratch::new("split-tags");
    let source = catalog_source();
    let instructions = split_instructions([0, 1, 2], 200, false, false);
    let desktop = run_cli(&scratch, "split-pages", &source, &instructions, None).unwrap();
    let browser = run_wasm(OP_SPLIT_PAGES, &source, &instructions, &[]);
    assert!(browser.data == desktop);
    assert_eq!(browser.report, serde_json::json!({}));
    assert!(Document::load_mem(&browser.data)
        .unwrap()
        .catalog()
        .unwrap()
        .has(b"StructTreeRoot"));
}

#[test]
fn overlay_text_returns_the_file_the_desktop_command_writes() {
    let scratch = Scratch::new("overlay");
    let source = catalog_source_with_text();
    // The staged output, as compact assembly writes it: the source pages in
    // order under an assembly catalog.
    let staged = run_wasm(
        OP_SPLIT_PAGES,
        &source,
        &split_instructions([0, 1, 2], 200, true, false),
        &[],
    )
    .data;
    let identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    for stamp in [None, Some("54455354")] {
        let mut instructions = serde_json::json!({"pages": [
            {"sourcePageIndex": 0, "outputPageIndex": 0, "matrix": identity,
             "filterToOutputPage": true},
            {"sourcePageIndex": 1, "outputPageIndex": 1, "matrix": identity},
            {"sourcePageIndex": 2, "outputPageIndex": 2, "matrix": identity, "linkOnly": true},
        ]});
        if let Some(stamp) = stamp {
            instructions["provenanceStampHex"] = stamp.into();
        }
        let instructions = instructions.to_string();
        let desktop = run_cli(
            &scratch,
            "overlay-text",
            &staged,
            &instructions,
            Some(&source),
        )
        .unwrap();
        let browser = run_wasm(OP_OVERLAY_TEXT, &staged, &instructions, &[&source]);
        assert_eq!(browser.kind, RESPONSE_REPORTED_PDF);
        assert!(
            browser.data == desktop,
            "overlay-text bytes differ: {instructions}"
        );
        assert_eq!(browser.page_count, 3);
        assert_eq!(
            browser.report,
            serde_json::json!({"accessibilityTagsRemoved": true})
        );
        let raw = String::from_utf8_lossy(&browser.data);
        assert!(raw.contains("EVBScanCleanup") == stamp.is_some());
        let overlaid = Document::load_mem(&browser.data).unwrap();
        let first_page = *overlaid.get_pages().get(&1).unwrap();
        let content = overlaid.get_page_content(first_page);
        assert!(String::from_utf8_lossy(&content).contains("Source text"));
    }
}

// A smooth color field with deterministic texture, compressible as a photo is.
fn photo_jpeg(width: u16, height: u16, quality: u8) -> Vec<u8> {
    let mut pixels = Vec::new();
    for y in 0..u32::from(height) {
        for x in 0..u32::from(width) {
            let texture = ((x * 17 + y * 31 + x * y % 23) % 13) as u8;
            pixels.extend_from_slice(&[
                (30 + x * 160 / u32::from(width)) as u8 + texture,
                (40 + y * 150 / u32::from(height)) as u8 + texture,
                (50 + (x + y) * 120 / u32::from(width + height)) as u8 + texture,
            ]);
        }
    }
    let mut bytes = Vec::new();
    jpeg_encoder::Encoder::new(&mut bytes, quality)
        .encode(&pixels, width, height, jpeg_encoder::ColorType::Rgb)
        .unwrap();
    bytes
}

fn jpeg_object(document: &mut Document, width: u16, height: u16, quality: u8) -> ObjectId {
    let mut stream = Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => i64::from(width),
            "Height" => i64::from(height), "BitsPerComponent" => 8,
            "Filter" => "DCTDecode", "ColorSpace" => "DeviceRGB",
        },
        photo_jpeg(width, height, quality),
    );
    stream.allows_compression = false;
    document.add_object(stream)
}

/// One page per entry: its image under `/Im` and the content that draws it.
fn image_pdf(pages: &[(u16, u16, u8, &str)]) -> Vec<u8> {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let font = document.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let mut kids = Vec::new();
    for &(width, height, quality, content) in pages {
        let image = jpeg_object(&mut document, width, height, quality);
        let contents =
            document.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
        kids.push(Object::Reference(document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => font },
                "XObject" => dictionary! { "Im" => image },
            },
            "Contents" => contents,
        })));
    }
    document.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Count" => kids.len() as i64, "Kids" => kids },
    );
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog);
    save(&mut document)
}

const SCAN: &str = "q 200 0 0 120 0 0 cm /Im Do Q\n";

/// What the desktop file holds after an appending pass: its input followed by
/// the revision, or no file when the pass changed nothing.
fn appended(input: &[u8], revision: &[u8]) -> Option<Vec<u8>> {
    (!revision.is_empty()).then(|| [input, revision].concat())
}

#[test]
fn recompress_images_appends_the_revision_the_desktop_command_appends() {
    let scratch = Scratch::new("recompress");
    let input = image_pdf(&[
        (800, 480, 95, SCAN),
        (
            120,
            72,
            60,
            "q 200 0 0 120 0 0 cm /Im Do Q BT /F1 9 Tf 10 10 Td (Photo) Tj ET\n",
        ),
    ]);
    for (max_byte_ratio, changed) in [(0.9, true), (0.0001, false)] {
        let instructions = serde_json::json!({
            "targetDpi": 72, "quality": 70, "maxByteRatio": max_byte_ratio, "skipPages": [],
        })
        .to_string();
        let desktop = run_cli(&scratch, "recompress-images", &input, &instructions, None);
        let browser = run_wasm(OP_RECOMPRESS_IMAGES, &input, &instructions, &[]);
        assert_eq!(browser.kind, RESPONSE_REPORTED_INCREMENT);
        assert_eq!(browser.page_count, 2);
        assert_eq!(!browser.data.is_empty(), changed);
        assert!(appended(&input, &browser.data) == desktop, "{instructions}");
        assert_eq!(browser.report["format"], "evb-pdf-recompress-images");
        assert_eq!(
            browser.report["images"][0]["outcome"],
            if changed {
                "recompressed"
            } else {
                "not-smaller"
            }
        );
        assert_eq!(
            browser.report["pages"],
            if changed {
                serde_json::json!([1])
            } else {
                serde_json::json!([])
            }
        );
        if let Some(desktop) = desktop {
            Document::load_mem(&desktop).unwrap();
        }
    }
}

#[test]
fn recompress_images_leaves_jpegs_without_usable_dimensions_alone() {
    for width in [Some(Object::Integer(4_294_967_296)), None] {
        let mut document = Document::load_mem(&image_pdf(&[(800, 480, 95, SCAN)])).unwrap();
        let image = document
            .objects
            .values_mut()
            .find_map(|object| {
                object
                    .as_stream_mut()
                    .ok()
                    .filter(|stream| stream.dict.has(b"Width"))
            })
            .unwrap();
        match width.clone() {
            Some(width) => image.dict.set("Width", width),
            None => {
                image.dict.remove(b"Width");
            }
        }
        let input = save(&mut document);
        let instructions = r#"{"targetDpi":150,"quality":75,"maxByteRatio":1,"skipPages":[]}"#;
        let browser = run_wasm(OP_RECOMPRESS_IMAGES, &input, instructions, &[]);
        assert!(browser.data.is_empty(), "{width:?}");
        // An image without /Width is not a candidate at all; one that no u32 holds is unsupported.
        let outcome = &browser.report["images"][0]["outcome"];
        assert!(
            if width.is_some() {
                outcome == "unsupported"
            } else {
                outcome.is_null()
            },
            "{width:?}: {outcome}"
        );
    }
}

#[test]
fn pdf_numbers_saturate_what_f32_cannot_carry() {
    for (value, expected) in [
        (1e44, f32::MAX),
        (-1e44, f32::MIN),
        (f64::INFINITY, f32::MAX),
        (f64::NAN, 0.0),
    ] {
        assert_eq!(
            crate::page_geometry::number_object(value),
            Object::Real(expected),
            "{value}"
        );
    }
}

#[test]
fn replace_page_images_appends_the_revision_the_desktop_command_appends() {
    let scratch = Scratch::new("replace");
    let input = image_pdf(&[
        (
            800,
            480,
            95,
            &format!("BT /F1 9 Tf 3 Tr 10 10 Td (Scan) Tj ET {SCAN}"),
        ),
        (800, 480, 95, &format!("{SCAN}0 0 10 10 re f\n")),
    ]);
    let replacements = [
        image_pdf(&[(1, 1, 50, SCAN)]),
        image_pdf(&[(200, 120, 40, SCAN)]),
    ];
    let paths = replacements
        .iter()
        .enumerate()
        .map(|(index, bytes)| arg(&scratch.write(&format!("replacement-{index}.pdf"), bytes)))
        .collect::<Vec<_>>();
    let instructions = |replacement: [serde_json::Value; 2]| {
        serde_json::json!({"maxByteRatio": 0.9, "pages": [
            {"pageNumber": 1, "replacement": replacement[0], "replacementPageNumber": 1},
            {"pageNumber": 2, "replacement": replacement[1], "replacementPageNumber": 1},
        ]})
        .to_string()
    };
    let desktop = run_cli(
        &scratch,
        "replace-page-images",
        &input,
        &instructions([paths[1].clone().into(), paths[0].clone().into()]),
        None,
    );
    let browser = run_wasm(
        OP_REPLACE_PAGE_IMAGES,
        &input,
        &instructions([1.into(), 0.into()]),
        &[&replacements[0], &replacements[1]],
    );
    assert_eq!(browser.kind, RESPONSE_REPORTED_INCREMENT);
    assert_eq!(browser.page_count, 2);
    assert!(!browser.data.is_empty());
    assert!(appended(&input, &browser.data) == desktop);
    let outcomes = browser.report["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|page| page["outcome"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(outcomes, ["replaced", "visible-drawing"]);
    Document::load_mem(&desktop.unwrap()).unwrap();
}

#[test]
fn instructed_writers_reject_attachments_they_do_not_take() {
    let source = catalog_source();
    let split = split_instructions([0, 1, 2], 200, false, false);
    let error = run_request(&instructed_request(
        OP_SPLIT_PAGES,
        &source,
        &split,
        &[&source],
    ))
    .unwrap_err()
    .to_string();
    assert!(error.contains("attachment count"), "{error}");
    let overlay = r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}]}"#;
    let error = run_request(&instructed_request(OP_OVERLAY_TEXT, &source, overlay, &[]))
        .unwrap_err()
        .to_string();
    assert!(error.contains("attachment count"), "{error}");
    let replace = r#"{"maxByteRatio":0.9,"pages":[{"pageNumber":1,"replacement":1,"replacementPageNumber":1}]}"#;
    let error = run_request(&instructed_request(
        OP_REPLACE_PAGE_IMAGES,
        &source,
        replace,
        &[&source],
    ))
    .unwrap_err();
    assert!(error.to_string().contains("does not carry"), "{error}");
    let error = run_request(&instructed_request(OP_DELETE_PAGES, &source, "{}", &[])).unwrap_err();
    assert!(
        error.to_string().contains("no instructed framing"),
        "{error}"
    );
}

#[test]
fn instructed_writers_validate_instructions_as_the_desktop_commands_do() {
    let source = catalog_source();
    for (operation, instructions, attachments, expected) in [
        (OP_SPLIT_PAGES, r#"{"pages":[]}"#, 0, "at least one"),
        (
            OP_RECOMPRESS_IMAGES,
            r#"{"targetDpi":10,"quality":70,"maxByteRatio":0.9}"#,
            0,
            "targetDpi",
        ),
        (
            OP_REPLACE_PAGE_IMAGES,
            r#"{"maxByteRatio":2,"pages":[]}"#,
            0,
            "maxByteRatio",
        ),
        (
            OP_OVERLAY_TEXT,
            r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[0,0,0,0,0,0]}]}"#,
            1,
            "invertible",
        ),
        // Finite numbers no PDF real can carry fail validation, not the writer.
        (
            OP_OVERLAY_TEXT,
            r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,1e40,0]}]}"#,
            1,
            "instruction range",
        ),
        (
            OP_SPLIT_PAGES,
            r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":1e40,"height":120}}]}]}"#,
            0,
            "cropRect",
        ),
        (
            OP_SPLIT_PAGES,
            r#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":100,"height":120},"contentTransform":{"scale":1,"translateX":1e40,"translateY":0}}]}]}"#,
            0,
            "contentTransform",
        ),
    ] {
        let attached: Vec<&[u8]> = vec![&source; attachments];
        let error = run_request(&instructed_request(
            operation,
            &source,
            instructions,
            &attached,
        ))
        .unwrap_err()
        .to_string();
        assert!(error.contains(expected), "{operation}: {error}");
    }
}

const WORDS: &str = "BT /F1 9 Tf 10 10 Td (Words) Tj ET\n";
const OCR_PAGE_ONE: &str = r#"{"pages":[{"pageNumber":1,"source":0}]}"#;

/// The error a writer request ends with, which it must end with.
fn refused(operation: u32, data: &[u8], instructions: &str, attachments: &[&[u8]]) -> String {
    match run_request(&instructed_request(
        operation,
        data,
        instructions,
        attachments,
    )) {
        Ok(_) => panic!("operation {operation} succeeded: {instructions}"),
        Err(error) => error.to_string(),
    }
}

fn first_page_content(bytes: &[u8]) -> Vec<u8> {
    let document = Document::load_mem(bytes).unwrap();
    document.get_page_content(*document.get_pages().get(&1).unwrap())
}

#[test]
fn ocr_text_layer_without_recognized_text_leaves_the_page_painting_as_it_did() {
    let blank = image_pdf(&[(1, 1, 50, "")]);
    let mut bare = Document::load_mem(&blank).unwrap();
    let page = *bare.get_pages().get(&1).unwrap();
    bare.get_dictionary_mut(page).unwrap().remove(b"Contents");
    let mut layered = Document::load_mem(&blank).unwrap();
    let streams = ["0 0 10 10 re f\n", "1 0 0 rg 5 5 10 10 re f\n"].map(|content| {
        Object::Reference(layered.add_object(Stream::new(dictionary! {}, content.into())))
    });
    let page = *layered.get_pages().get(&1).unwrap();
    layered
        .get_dictionary_mut(page)
        .unwrap()
        .set("Contents", streams.to_vec());
    // A page without contents, and one whose two streams paint in order.
    for target in [save(&mut bare), save(&mut layered)] {
        let output = run_request(&instructed_request(
            OP_OCR_TEXT_LAYER,
            &target,
            OCR_PAGE_ONE,
            &[&blank],
        ))
        .unwrap();
        let saved = [target.as_slice(), &output[MUTATION_HEADER.bytes..]].concat();
        assert_eq!(first_page_content(&saved), first_page_content(&target));
    }
}

#[test]
fn writers_refuse_inline_images_whose_size_no_parser_can_hold() {
    let replacement = image_pdf(&[(1, 1, 50, SCAN)]);
    let source = image_pdf(&[(1, 1, 50, WORDS)]);
    let plain = image_pdf(&[(800, 480, 95, SCAN)]);
    for width in ["-1", "2147483647"] {
        let image = format!("BI /W {width} /H 1 /BPC 8 /CS /RGB ID x EI\n");
        let input = image_pdf(&[(800, 480, 95, &format!("{SCAN}{image}"))]);
        let source_with_image = image_pdf(&[(1, 1, 50, &format!("{WORDS}{image}"))]);
        for (operation, data, instructions, attachment) in [
            (
                OP_RECOMPRESS_IMAGES,
                &input,
                r#"{"targetDpi":72,"quality":70,"maxByteRatio":0.9,"skipPages":[]}"#,
                None,
            ),
            (
                OP_OVERLAY_TEXT,
                &plain,
                r#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}]}"#,
                Some(&source_with_image),
            ),
            (
                OP_REPLACE_PAGE_IMAGES,
                &input,
                r#"{"maxByteRatio":0.9,"pages":[{"pageNumber":1,"replacement":0,"replacementPageNumber":1}]}"#,
                Some(&replacement),
            ),
            (OP_OCR_TEXT_LAYER, &input, OCR_PAGE_ONE, Some(&source)),
        ] {
            let attachments: Vec<&[u8]> = attachment.into_iter().map(Vec::as_slice).collect();
            let error = refused(operation, data, instructions, &attachments);
            assert!(
                error.contains("inline image"),
                "{operation} /W {width}: {error}"
            );
        }
    }
}
