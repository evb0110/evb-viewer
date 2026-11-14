//! Searchable OCR layer for a whole document in one incremental revision.
//!
//! Each instruction names a target page and the one-page text-only PDF that
//! Tesseract produced for the raster of that page. The writer removes any
//! previous invisible text from the target page (EVB layers by their marker,
//! other producers' hidden text objects by their rendering mode), maps the
//! Tesseract page into the target page view, and appends the text as an
//! invisible, marked content stream.
//!
//! `ocr-text-visibility` reports, before OCR runs, what that removal would
//! find on each page, so page selection and the writer read text one way.

use super::*;
use lopdf::content::Content;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Tesseract writes one small page per raster. The bound keeps a damaged or
/// unexpected sidecar from being loaded eagerly.
pub(crate) const MAX_OCR_SOURCE_PDF_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrTextLayerFile<S> {
    #[serde(
        deserialize_with = "deserialize_collection",
        bound(deserialize = "S: Deserialize<'de>")
    )]
    pub(crate) pages: Vec<OcrTextLayerPage<S>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrTextLayerPage<S> {
    /// One-based page number in the target document.
    pub(crate) page_number: u32,
    /// Tesseract's one-page text-only PDF for this page's raster: its path on
    /// desktop, its index among the request's page PDFs in the browser.
    pub(crate) source: S,
    /// Present when OCR ran on a preprocessed raster whose pixels moved.
    #[serde(default)]
    pub(crate) preprocess_inverse: Option<OcrPreprocessInverse>,
    #[serde(default)]
    pub(crate) normalize_greek_micro_sign: bool,
    /// Words whose recognized text changed after Tesseract wrote its PDF,
    /// in ascending order of `word`.
    #[serde(default)]
    pub(crate) word_edits: Vec<OcrWordEdit>,
    /// Word rectangles in the raster Tesseract read, before preprocessing inverse.
    #[serde(default)]
    pub(crate) word_geometry: Option<OcrWordGeometry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrWordGeometry {
    pub(crate) raster_width_px: f64,
    pub(crate) raster_height_px: f64,
    pub(crate) words: Vec<OcrWordBox>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrWordBox {
    pub(crate) text: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// Replaces one word of Tesseract's page; the writer rescales the word's
/// horizontal scaling to the new glyph count, so the word keeps its box.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrWordEdit {
    /// Position among the page's text-show operators, which Tesseract
    /// writes one per non-empty word in its TSV order.
    pub(crate) word: usize,
    pub(crate) from: String,
    pub(crate) to: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrPreprocessInverse {
    pub(crate) raster_width_px: f64,
    pub(crate) raster_height_px: f64,
    /// Maps preprocessed raster pixels back to rendered raster pixels.
    pub(crate) matrix: [[f64; 3]; 3],
}

type Matrix3 = [[f64; 3]; 3];

fn multiply(left: Matrix3, right: Matrix3) -> Matrix3 {
    let mut result = [[0.0; 3]; 3];
    for (row, result_row) in result.iter_mut().enumerate() {
        for (column, value) in result_row.iter_mut().enumerate() {
            *value = (0..3).map(|k| left[row][k] * right[k][column]).sum();
        }
    }
    result
}

fn determinant(matrix: Matrix3) -> f64 {
    matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
}

fn affine(matrix: [f64; 6]) -> Matrix3 {
    [
        [matrix[0], matrix[2], matrix[4]],
        [matrix[1], matrix[3], matrix[5]],
        [0.0, 0.0, 1.0],
    ]
}

pub(crate) fn read_ocr_text_layer_file(path: &Path) -> Result<OcrTextLayerFile<PathBuf>> {
    let instructions = read_json_sidecar(path, "OCR text-layer instructions")?;
    validate_ocr_text_layer(&instructions)?;
    Ok(instructions)
}

/// The checks every host's instructions pass before any page is written.
fn validate_ocr_text_layer<S>(instructions: &OcrTextLayerFile<S>) -> Result<()> {
    if instructions.pages.is_empty() {
        return Err("ocr-text-layer requires at least one page".into());
    }
    let mut pages = HashSet::new();
    for page in &instructions.pages {
        if page.page_number == 0 || !pages.insert(page.page_number) {
            return Err("ocr-text-layer page numbers must be positive and unique".into());
        }
        if let Some(inverse) = page.preprocess_inverse {
            if !(crate::split_pages::is_instruction_number(inverse.raster_width_px)
                && crate::split_pages::is_instruction_number(inverse.raster_height_px)
                && inverse.raster_width_px >= 1.0
                && inverse.raster_height_px >= 1.0)
            {
                return Err(
                    "ocr-text-layer raster dimensions must be at least one pixel and in range"
                        .into(),
                );
            }
            if !inverse
                .matrix
                .iter()
                .flatten()
                .all(|value| crate::split_pages::is_instruction_number(*value))
                || determinant(inverse.matrix).abs() <= 1e-12
            {
                return Err(
                    "ocr-text-layer preprocessing inverse must be a finite, in-range invertible 3x3 matrix"
                        .into(),
                );
            }
        }
        let mut previous_word = None;
        if let Some(geometry) = &page.word_geometry {
            let positive =
                |value: f64| crate::split_pages::is_instruction_number(value) && value > 0.0;
            if !positive(geometry.raster_width_px)
                || !positive(geometry.raster_height_px)
                || geometry.words.iter().any(|word| {
                    word.text.trim().is_empty()
                        || !positive(word.width)
                        || !positive(word.height)
                        || !crate::split_pages::is_instruction_number(word.x)
                        || word.x < 0.0
                        || !crate::split_pages::is_instruction_number(word.y)
                        || word.y < 0.0
                        || word.x + word.width > geometry.raster_width_px
                        || word.y + word.height > geometry.raster_height_px
                })
            {
                return Err(
                    "ocr-text-layer word rectangles must fit the recognition raster".into(),
                );
            }
        }
        for edit in &page.word_edits {
            if previous_word.is_some_and(|previous| edit.word <= previous) {
                return Err("ocr-text-layer word edits must be in ascending word order".into());
            }
            previous_word = Some(edit.word);
            if edit.from.is_empty() || edit.to.is_empty() {
                return Err("ocr-text-layer word edits must replace a word with text".into());
            }
        }
    }
    Ok(())
}

fn utf16be(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_be_bytes).collect()
}

/// Tesseract writes each word as `[<UTF-16BE text>] TJ`, followed by a space
/// unless the word ends its line.
fn word_text(bytes: &[u8]) -> &[u8] {
    bytes.strip_suffix(&[0x00, 0x20]).unwrap_or(bytes)
}

/// Applies word edits to the text of Tesseract's one-page PDF. An edit names
/// the word's text-show operator. Tesseract leaves out a word whose baseline
/// has no length, so when that operator holds other text the edit goes to the
/// nearest earlier unedited word with its text, and is dropped without one.
/// Tesseract stretches each word's glyphs over its box with `Tz`, so a word
/// that gains or loses glyphs keeps its box by scaling that `Tz` inversely.
fn apply_ocr_word_edits(
    source: &mut Document,
    page_id: ObjectId,
    edits: &[OcrWordEdit],
) -> Result<()> {
    if edits.is_empty() {
        return Ok(());
    }
    let bytes = source.get_page_content_with_limit(page_id, MAX_OCR_CONTENT_STREAM_BYTES)?;
    let mut content = parse_content(&bytes)??;
    // Each word's text-show operator, with the `Tz` set since the previous word.
    let mut words: Vec<(usize, Option<usize>)> = Vec::new();
    let mut scaling = None;
    for (index, operation) in content.operations.iter().enumerate() {
        match operation.operator.as_str() {
            "Tz" => scaling = Some(index),
            "TJ" => words.push((index, scaling.take())),
            _ => {}
        }
    }
    if words.is_empty() {
        return Ok(());
    }
    let word_text_at = |content: &Content, index: usize| -> Option<Vec<u8>> {
        match content.operations[index].operands.as_slice() {
            [Object::Array(values)] => match values.as_slice() {
                [Object::String(text, _)] => Some(text.clone()),
                _ => None,
            },
            _ => None,
        }
    };
    let mut next = 0;
    for edit in edits {
        let from = utf16be(&edit.from);
        let last = edit.word.min(words.len().saturating_sub(1));
        let found = (next..=last).rev().find(|&word| {
            word_text_at(&content, words[word].0)
                .is_some_and(|text| word_text(&text) == from.as_slice())
        });
        let Some(word) = found else {
            continue;
        };
        let (show, scaling) = words[word];
        let Some(text) = word_text_at(&content, show) else {
            continue;
        };
        let mut replaced = utf16be(&edit.to);
        replaced.extend_from_slice(&text[from.len()..]);
        if let Some(scaling) = scaling.filter(|_| replaced.len() != text.len()) {
            if let Some(value) = content.operations[scaling]
                .operands
                .first()
                .and_then(|operand| operand.as_float().ok())
            {
                let scaled = f64::from(value) * text.len() as f64 / replaced.len() as f64;
                content.operations[scaling].operands = vec![Object::Real(scaled as f32)];
            }
        }
        if let [Object::Array(values)] = content.operations[show].operands.as_mut_slice() {
            if let [Object::String(stored, _)] = values.as_mut_slice() {
                *stored = replaced;
            }
        }
        next = word + 1;
    }
    source.change_page_content(page_id, content.encode()?)?;
    Ok(())
}

/// Tesseract's PDF retains word widths but uses a line font height, often much
/// taller than the word's ink. Fit the same word shows to the recognizer's own
/// rectangles before the shared page/preprocessing transform is applied.
fn fit_ocr_word_geometry(
    source: &mut Document,
    page_id: ObjectId,
    geometry: &OcrWordGeometry,
) -> Result<()> {
    use lopdf::content::Operation;
    let view = resolve_page_view(source, page_id)?;
    let scale_x = view.width() / geometry.raster_width_px;
    let scale_y = view.height() / geometry.raster_height_px;
    let fonts = page_fonts(source, page_id)?;
    let bytes = source.get_page_content_with_limit(page_id, MAX_OCR_CONTENT_STREAM_BYTES)?;
    let content = parse_content(&bytes)??;
    // Tesseract writes one show per non-empty TSV word, in TSV order. Fit only
    // when every show pairs with its word: a fitted show changes the text
    // state the next one inherits, so a partial fit would misplace the rest.
    let shows = content
        .operations
        .iter()
        .filter_map(|operation| {
            match (operation.operator.as_str(), operation.operands.as_slice()) {
                ("TJ", [Object::Array(values)]) => match values.as_slice() {
                    [Object::String(bytes, _)] => Some(word_text(bytes).to_vec()),
                    _ => None,
                },
                _ => None,
            }
        })
        .collect::<Vec<_>>();
    let mut words = (shows.len() == geometry.words.len()
        && shows
            .iter()
            .zip(&geometry.words)
            .all(|(show, word)| utf16be(&word.text) == *show))
    .then(|| geometry.words.iter());
    let mut operations = Vec::with_capacity(content.operations.len());
    let mut font_name = None;
    let mut direction = 1.0;
    for mut operation in content.operations {
        if operation.operator == "Tf" {
            font_name = operation
                .operands
                .first()
                .and_then(|font| font.as_name().ok())
                .map(<[u8]>::to_vec);
        }
        if operation.operator == "Tm" {
            direction = operation
                .operands
                .first()
                .and_then(|value| object_to_f64(value).ok())
                .unwrap_or(1.0)
                .signum();
        }
        if let ("TJ", [Object::Array(values)]) =
            (operation.operator.as_str(), operation.operands.as_slice())
        {
            if let [Object::String(bytes, _)] = values.as_slice() {
                let text = word_text(bytes);
                if let Some(word) = words.as_mut().and_then(Iterator::next) {
                    let name = font_name.as_ref().ok_or("OCR word has no selected font")?;
                    let font = fonts.get(name).ok_or("OCR word font is missing")?;
                    let (advance, ascent, descent) =
                        crate::text_layer::ocr_word_metrics(source, font, text)?;
                    let size = word.height * scale_y * 1000.0 / (ascent - descent);
                    let x = view.x1
                        + (word.x + if direction < 0.0 { word.width } else { 0.0 }) * scale_x;
                    let y = view.y2 - (word.y + word.height) * scale_y - descent * size / 1000.0;
                    operations.push(Operation::new(
                        "Tf",
                        vec![Object::Name(name.clone()), number_object(size)],
                    ));
                    operations.push(Operation::new(
                        "Tz",
                        vec![number_object(
                            word.width * scale_x * 100_000.0 / (advance * size),
                        )],
                    ));
                    operations.push(Operation::new(
                        "Tm",
                        vec![
                            number_object(direction),
                            0.into(),
                            0.into(),
                            1.into(),
                            number_object(x),
                            number_object(y),
                        ],
                    ));
                }
                // A real space after each word lets every reader separate
                // words; readers still join a line-end hyphen for search.
                if let [Object::Array(values)] = operation.operands.as_mut_slice() {
                    if let [Object::String(stored, _)] = values.as_mut_slice() {
                        if !stored.ends_with(&[0x00, 0x20]) {
                            stored.extend_from_slice(&[0x00, 0x20]);
                        }
                    }
                }
            }
        }
        operations.push(operation);
    }
    source.change_page_content(page_id, Content { operations }.encode()?)?;
    Ok(())
}

/// Map Tesseract page space into the target page's user space. Tesseract saw
/// the raster pdftoppm rendered from the displayed (rotated, cropped) page,
/// so its page corresponds to the page view in display orientation.
pub(crate) fn ocr_layer_matrix(
    view: PdfRect,
    rotation: i64,
    source: PdfRect,
    inverse: Option<&OcrPreprocessInverse>,
) -> Result<[f64; 6]> {
    let (source_width, source_height) = (source.width(), source.height());
    if !(source_width > 0.0 && source_height > 0.0 && view.width() > 0.0 && view.height() > 0.0) {
        return Err("ocr-text-layer page boxes must have positive extents".into());
    }
    let quarter_turn = rotation == 90 || rotation == 270;
    let displayed_width = if quarter_turn {
        view.height()
    } else {
        view.width()
    };
    let displayed_height = if quarter_turn {
        view.width()
    } else {
        view.height()
    };
    let x_scale = displayed_width / source_width;
    let y_scale = displayed_height / source_height;
    let page = affine(match rotation {
        90 => [0.0, x_scale, -y_scale, 0.0, view.x2, view.y1],
        180 => [-x_scale, 0.0, 0.0, -y_scale, view.x2, view.y2],
        270 => [0.0, -x_scale, y_scale, 0.0, view.x1, view.y2],
        _ => [x_scale, 0.0, 0.0, y_scale, view.x1, view.y1],
    });
    let origin = affine([1.0, 0.0, 0.0, 1.0, -source.x1, -source.y1]);
    let composed = match inverse {
        None => multiply(page, origin),
        Some(inverse) => {
            // Tesseract page points -> preprocessed raster pixels (y down),
            // through the preprocessing inverse to rendered raster pixels,
            // then back to Tesseract page points.
            let (width_px, height_px) = (inverse.raster_width_px, inverse.raster_height_px);
            let to_pixels = [
                [width_px / source_width, 0.0, 0.0],
                [0.0, -height_px / source_height, height_px],
                [0.0, 0.0, 1.0],
            ];
            let from_pixels = [
                [source_width / width_px, 0.0, 0.0],
                [0.0, -source_height / height_px, source_height],
                [0.0, 0.0, 1.0],
            ];
            let preprocess = multiply(from_pixels, multiply(inverse.matrix, to_pixels));
            multiply(page, multiply(preprocess, origin))
        }
    };
    let matrix = [
        composed[0][0],
        composed[1][0],
        composed[0][1],
        composed[1][1],
        composed[0][2],
        composed[1][2],
    ];
    if !matrix.iter().all(|value| value.is_finite())
        || (matrix[0] * matrix[3] - matrix[1] * matrix[2]).abs() <= f64::EPSILON
    {
        return Err("ocr-text-layer page mapping is not invertible".into());
    }
    Ok(matrix)
}

const OCR_TEXT_VISIBILITY_FORMAT: &str = "evb-pdf-ocr-text-visibility";
const OCR_TEXT_VISIBILITY_SCHEMA_VERSION: u32 = 3;

/// `ocr-text-visibility` stdout; `@contracts/pdfOcrTextVisibility` decodes it.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrTextVisibilityReport {
    format: String,
    schema_version: u32,
    pages: Vec<OcrPageTextVisibility>,
}

/// What OCR may replace on one page, in the writer's own terms.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrPageTextVisibility {
    page_number: u32,
    /// The page carries a layer EVB's OCR wrote, which the writer removes whole.
    evb_ocr_layer: bool,
    /// The page paints text, in its own content or in a Form XObject it draws.
    painted_text: bool,
    /// Hidden text needing replacement, including legacy EVB line-wide ActualText.
    hidden_text: bool,
    /// Text the inspection could not read, or hidden text the writer keeps.
    uncertain: Option<String>,
    /// Why the writer refuses to replace this page's text.
    unsupported: Option<String>,
    /// The EVB OCR layer's lines in the order Tesseract wrote them, with where
    /// each stands, when the caller asked for them and the layer is inline.
    evb_ocr_lines: Option<Vec<OcrLayerLine>>,
}

/// One recognized line of an EVB OCR layer, in the layer's text space (y up).
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrLayerLine {
    /// Tesseract's text block, counted from zero; a block is one region of the page.
    block: u32,
    text: String,
    /// Origin of the first glyph.
    left: f64,
    /// Origin of the last glyph.
    right: f64,
    baseline: f64,
    /// Font size, scaled by the text matrix.
    size: f64,
}

fn inspect_page_text_visibility(
    incremental: &mut IncrementalDocument,
    inspection: &mut PageTextInspection,
    page_number: u32,
    page_id: ObjectId,
    with_evb_ocr_text: bool,
) -> Result<OcrPageTextVisibility> {
    let resources = page_resources(&incremental.previous_document, page_id)?;
    let mut scan = PageTextScan::for_page(&incremental.previous_document, page_id);
    let mut evb_ocr_layer = false;
    let mut evb_ocr_lines: Option<Vec<OcrLayerLine>> = None;
    for content_id in incremental.previous_document.get_page_contents(page_id) {
        let Some(bytes) = read_content_stream(incremental, inspection.structural, content_id)?
        else {
            inspection.doubt("a page content stream could not be read");
            continue;
        };
        if is_evb_ocr_layer_stream(&bytes) {
            evb_ocr_layer = true;
            // Earlier writers wrapped positioned glyphs in line-wide ActualText.
            // Readable Unicode alone cannot make those collapsed word boxes
            // usable. Route them through the existing hidden-layer repair path.
            if let Ok(Ok(content)) = parse_content(&bytes) {
                scan.hidden |= content.operations.iter().any(|operation| {
                    operation.operator == "BDC"
                        && operation.operands.get(1).is_some_and(|properties| {
                            properties
                                .as_dict()
                                .is_ok_and(|dict| dict.has(b"ActualText"))
                        })
                });
            }
            if with_evb_ocr_text {
                if let Some(lines) = evb_ocr_layer_lines(&bytes) {
                    evb_ocr_lines.get_or_insert_with(Vec::new).extend(lines);
                }
            }
            continue;
        }
        let Ok(Ok(content)) = parse_content(&bytes) else {
            inspection.doubt("a page content stream could not be parsed");
            continue;
        };
        let mut draws = Vec::new();
        scan.scan_stream(&content.operations, |name, mode| {
            draws.push((name.clone(), mode))
        });
        for (name, mode) in draws {
            inspection.inspect(
                &mut FormInspectionSource::Incremental(incremental),
                &resources,
                &name,
                mode,
                0,
            )?;
        }
    }
    Ok(OcrPageTextVisibility {
        page_number,
        evb_ocr_layer,
        painted_text: scan.painted || inspection.painted,
        hidden_text: scan.hidden,
        uncertain: inspection.uncertain.map(str::to_string),
        unsupported: scan.unsupported.map(str::to_string),
        evb_ocr_lines,
    })
}

/// The lines of an inline EVB OCR layer in content order. Tesseract writes one
/// text object per block and steps `Td` down each line. The writer keeps those
/// word shows and spacing; Poppler layout breaks skewed
/// baselines, so the writer reads recognition order from its own layer, and
/// where each line stands from its `Tm` and `Td` positions. Older layers
/// used a `Tm` per glyph and are read by the same positioning state.
/// A layer drawn as a Form XObject by earlier versions has no inline text.
fn evb_ocr_layer_lines(bytes: &[u8]) -> Option<Vec<OcrLayerLine>> {
    let content = parse_content(bytes).ok()?.ok()?;
    let mut lines: Vec<OcrLayerLine> = Vec::new();
    let mut line: Option<OcrLayerLine> = None;
    let mut block = 0u32;
    let mut blocks_seen = 0u32;
    let mut font_size = 1.0f64;
    let mut matrix = crate::split_pages::PdfMatrix::IDENTITY;
    // Origin and scale of the next word or legacy glyph.
    let mut origin = (0.0f64, 0.0f64, 1.0f64);
    let break_line = |line: &mut Option<OcrLayerLine>, lines: &mut Vec<OcrLayerLine>| {
        if let Some(mut done) = line.take() {
            done.text.truncate(done.text.trim_end().len());
            if !done.text.is_empty() {
                lines.push(done);
            }
        }
    };
    // Tesseract shows Unicode through Identity-H, so every string is UTF-16BE.
    let decode_utf16 = |bytes: &[u8]| -> String {
        char::decode_utf16(
            bytes
                .chunks_exact(2)
                .map(|unit| u16::from_be_bytes([unit[0], unit[1]])),
        )
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
    };
    let round = |value: f64| (value * 10.0).round() / 10.0;
    let show = |object: &Object,
                line: &mut Option<OcrLayerLine>,
                block: u32,
                origin: (f64, f64, f64),
                font_size: f64| {
        let mut text = String::new();
        for item in object
            .as_array()
            .map_or(std::slice::from_ref(object), Vec::as_slice)
        {
            if let Object::String(bytes, _) = item {
                text.push_str(&decode_utf16(bytes));
            }
        }
        if text.is_empty() {
            return;
        }
        let current = line.get_or_insert_with(|| OcrLayerLine {
            block,
            text: String::new(),
            left: round(origin.0),
            right: round(origin.0),
            baseline: round(origin.1),
            size: round(font_size * origin.2),
        });
        current.text.push_str(&text);
        current.right = round(origin.0);
    };
    for operation in &content.operations {
        let number = |index: usize| {
            operation
                .operands
                .get(index)
                .and_then(|operand| operand.as_float().ok())
                .map(f64::from)
        };
        match operation.operator.as_str() {
            // Tesseract's text objects and vertical line steps separate lines.
            "BT" => {
                break_line(&mut line, &mut lines);
                block = blocks_seen;
                blocks_seen += 1;
            }
            "T*" => break_line(&mut line, &mut lines),
            "Tf" => {
                if let Some(size) = number(1) {
                    font_size = size.abs().max(f64::EPSILON);
                }
            }
            "Tm" => {
                if let Some(next) = crate::split_pages::PdfMatrix::from_operation(operation) {
                    matrix = next;
                    origin = (matrix.e, matrix.f, matrix.a.hypot(matrix.b));
                }
            }
            "Td" | "TD" => {
                if let (Some(x), Some(y)) = (number(0), number(1)) {
                    if y.abs() > font_size * 0.5 {
                        break_line(&mut line, &mut lines);
                    }
                    matrix = matrix.concat(crate::split_pages::PdfMatrix::translation(x, y));
                    origin = (matrix.e, matrix.f, matrix.a.hypot(matrix.b));
                }
            }
            "Tj" | "TJ" => {
                if let Some(text) = operation.operands.first() {
                    show(text, &mut line, block, origin, font_size);
                }
            }
            "'" | "\"" => {
                break_line(&mut line, &mut lines);
                if let Some(text) = operation.operands.last() {
                    show(text, &mut line, block, origin, font_size);
                }
            }
            _ => {}
        }
    }
    break_line(&mut line, &mut lines);
    (!lines.is_empty()).then_some(lines)
}

/// Reports, per requested page, the evidence OCR page selection and text
/// extraction need about existing text, read with the scan the writer
/// replaces text through, from one load of the document.
pub(crate) fn write_ocr_text_visibility(
    input_path: &Path,
    page_numbers: &[u32],
    with_evb_ocr_text: bool,
    qpdf_path: Option<&Path>,
    output: &mut impl Write,
) -> Result<()> {
    let mut incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    let report = inspect_ocr_text_visibility(
        &mut incremental,
        StructuralSource::for_path(input_path, qpdf_path),
        page_numbers,
        with_evb_ocr_text,
    )?;
    serde_json::to_writer(output, &report)?;
    Ok(())
}

/// The browser's `ocrTextVisibility` operation over a document read by range,
/// serialized as `ocr-text-visibility` prints it.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn ocr_text_visibility_from_source<S: ByteSource>(
    source: S,
    len: u64,
    page_numbers: &[u32],
    with_evb_ocr_text: bool,
) -> Result<Vec<u8>> {
    let mut source = SourcePdf::open(source, len)?;
    let mut incremental = source.take_append_base()?;
    let report = inspect_ocr_text_visibility(
        &mut incremental,
        Some(StructuralSource::Ranges(&source)),
        page_numbers,
        with_evb_ocr_text,
    )?;
    Ok(serde_json::to_vec(&report)?)
}

fn inspect_ocr_text_visibility(
    incremental: &mut IncrementalDocument,
    structural: Option<StructuralSource<'_>>,
    page_numbers: &[u32],
    with_evb_ocr_text: bool,
) -> Result<OcrTextVisibilityReport> {
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let resolver = PageTreeResolver::new(&incremental.previous_document)?;
    let mut pages = Vec::with_capacity(page_numbers.len());
    let mut text_bytes = 0;
    for &page_number in page_numbers {
        let page_id = resolver.page_id(&incremental.previous_document, page_number)?;
        let mut inspection = PageTextInspection {
            structural,
            visited: HashSet::new(),
            decoded_bytes: 0,
            painted: false,
            uncertain: None,
        };
        let page = inspect_page_text_visibility(
            incremental,
            &mut inspection,
            page_number,
            page_id,
            with_evb_ocr_text,
        )?;
        text_bytes += page.evb_ocr_lines.as_ref().map_or(0, |lines| {
            lines.iter().map(|line| line.text.len() + 64).sum()
        });
        if text_bytes > MAX_AGGREGATE_TEXT_BYTES {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Visibility report text exceeds its byte ceiling",
            ));
        }
        pages.push(page);
    }
    Ok(OcrTextVisibilityReport {
        format: OCR_TEXT_VISIBILITY_FORMAT.to_string(),
        schema_version: OCR_TEXT_VISIBILITY_SCHEMA_VERSION,
        pages,
    })
}

pub(crate) fn ocr_source_length_error(
    length: u64,
    source: impl std::fmt::Display,
) -> Box<dyn Error> {
    domain_error(
        NativeErrorCode::TooLarge,
        format!(
            "OCR page PDF must be between 1 and {MAX_OCR_SOURCE_PDF_BYTES} bytes ({length} bytes): {source}"
        ),
    )
}

fn checked_ocr_source(source: Result<Document>) -> Result<Document> {
    let source =
        source.map_err(|error| classify_pdf_load_error(error, "Failed to parse OCR page PDF"))?;
    assert_plaintext_base(&source, "Encrypted OCR page PDFs are not supported")?;
    Ok(source)
}

fn load_ocr_source(path: &Path) -> Result<Document> {
    let length = fs::metadata(path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    if length == 0 || length > MAX_OCR_SOURCE_PDF_BYTES {
        return Err(ocr_source_length_error(length, path.display()));
    }
    checked_ocr_source(load_pdf_path(path))
}

/// Writes every instruction's page into the incremental revision. `load_source`
/// returns the Tesseract page PDF an instruction names, by path or by index.
fn apply_ocr_text_layer<S>(
    incremental: &mut IncrementalDocument,
    structural: Option<StructuralSource<'_>>,
    instructions: &OcrTextLayerFile<S>,
    mut load_source: impl FnMut(&S) -> Result<Document>,
) -> Result<()> {
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let resolver = PageTreeResolver::new(&incremental.previous_document)?;
    for page in &instructions.pages {
        let mut source = load_source(&page.source)?;
        let source_resolver = PageTreeResolver::new(&source)?;
        if source_resolver.page_count() != 1 {
            return Err("OCR page PDF must contain exactly one page".into());
        }
        let source_page_id = source_resolver.page_id(&source, 1)?;
        apply_ocr_word_edits(&mut source, source_page_id, &page.word_edits)?;
        if let Some(geometry) = &page.word_geometry {
            fit_ocr_word_geometry(&mut source, source_page_id, geometry)?;
        }
        let page_id = resolver.page_id(&incremental.previous_document, page.page_number)?;
        let view = resolve_page_view(&incremental.previous_document, page_id)?;
        let rotation = resolve_page_rotation(&incremental.previous_document, page_id)?;
        let matrix = ocr_layer_matrix(
            view,
            rotation,
            resolve_page_view(&source, source_page_id)?,
            page.preprocess_inverse.as_ref(),
        )?;
        if !incremental.new_document.has_object(page_id) {
            prepare_incremental_overlay_page(incremental, page_id)?;
        }
        replace_page_ocr_text(
            incremental,
            structural,
            &source,
            source_page_id,
            page_id,
            matrix,
            page.normalize_greek_micro_sign,
        )?;
    }
    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    Ok(())
}

pub(crate) fn write_ocr_text_layer_path(
    input_path: &Path,
    output_path: &Path,
    instructions: &OcrTextLayerFile<PathBuf>,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let mut incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    apply_ocr_text_layer(
        &mut incremental,
        StructuralSource::for_path(input_path, qpdf_path),
        instructions,
        |path: &PathBuf| load_ocr_source(path),
    )?;
    let revision_bytes = build_incremental_revision(&mut incremental)?;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);
    with_staged_incremental_output(input_path, output_path, |staged_output_path| {
        write_incremental_revision(
            staged_output_path,
            &incremental,
            &revision_bytes,
            &expected_object_ids,
        )
    })
}

/// The browser's `ocrTextLayer` operation: appends the text layer to the
/// document `source` holds, through `write` as a save appends its revision.
/// Instructions name Tesseract page PDFs by the index `page_pdf` reads them
/// at. Returns the document's page count.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn ocr_text_layer_to_source<S: ByteSource>(
    source: S,
    len: u64,
    instructions: &[u8],
    page_pdf: impl Fn(usize) -> Result<Vec<u8>>,
    write: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
) -> Result<u32> {
    let instructions: OcrTextLayerFile<usize> =
        parse_json_sidecar_bytes(instructions, "OCR text-layer instructions")?;
    validate_ocr_text_layer(&instructions)?;
    let mut source = SourcePdf::open_append_base(source, len)?;
    let mut incremental = source.take_append_base()?;
    let page_count = u32::try_from(incremental.previous_document.get_pages().len())
        .map_err(|_| "PDF page count exceeds the WASM response range")?;
    apply_ocr_text_layer(
        &mut incremental,
        Some(StructuralSource::Ranges(&source)),
        &instructions,
        |&index| {
            let bytes = page_pdf(index)?;
            if bytes.is_empty() || bytes.len() as u64 > MAX_OCR_SOURCE_PDF_BYTES {
                return Err(ocr_source_length_error(
                    bytes.len() as u64,
                    format!("page PDF {index}"),
                ));
            }
            checked_ocr_source(load_pdf_bytes(&bytes))
        },
    )?;
    let revision = appended_revision_bytes(&mut incremental)?;
    validate_incremental_append_bytes(
        &write(&revision)?,
        len,
        incremental.previous_xref_start(),
        &collect_incremental_append_object_ids(&incremental),
    )?;
    Ok(page_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::Operation as ContentOperation;

    fn rect(x1: f64, y1: f64, x2: f64, y2: f64) -> PdfRect {
        PdfRect { x1, y1, x2, y2 }
    }

    /// A page shaped as Tesseract writes it: one `[<UTF-16BE>] TJ` per word.
    fn tesseract_page(words: &[&str]) -> (Document, ObjectId) {
        let mut document = Document::with_version("1.5");
        let operations: Vec<ContentOperation> = words
            .iter()
            .map(|word| {
                ContentOperation::new(
                    "TJ",
                    vec![Object::Array(vec![Object::String(
                        utf16be(&format!("{word} ")),
                        StringFormat::Hexadecimal,
                    )])],
                )
            })
            .collect();
        let content = Content { operations }.encode().unwrap();
        let content_id = document.add_object(Stream::new(dictionary! {}, content));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Contents" => content_id,
        });
        (document, page_id)
    }

    fn page_words(document: &Document, page_id: ObjectId) -> Vec<String> {
        let content = Content::decode(&document.get_page_content(page_id)).unwrap();
        content
            .operations
            .iter()
            .filter(|operation| operation.operator == "TJ")
            .map(|operation| match operation.operands.as_slice() {
                [Object::Array(values)] => match values.as_slice() {
                    [Object::String(bytes, _)] => String::from_utf16(
                        &bytes
                            .chunks_exact(2)
                            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                            .collect::<Vec<_>>(),
                    )
                    .unwrap(),
                    _ => panic!("unexpected TJ operand"),
                },
                _ => panic!("unexpected TJ operands"),
            })
            .collect()
    }

    fn edit(word: usize, from: &str, to: &str) -> OcrWordEdit {
        OcrWordEdit {
            word,
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn word_edits_rewrite_the_named_word_and_keep_its_space() {
        let (mut document, page_id) = tesseract_page(&["fit", "in", "fefto", "fit"]);
        apply_ocr_word_edits(
            &mut document,
            page_id,
            &[edit(2, "fefto", "feſto"), edit(3, "fit", "ſit")],
        )
        .unwrap();
        assert_eq!(
            page_words(&document, page_id),
            ["fit ", "in ", "feſto ", "ſit "]
        );
    }

    #[test]
    fn word_edits_find_their_word_when_tesseract_left_out_an_earlier_one() {
        // The TSV listed a word before "fefto" that the PDF does not draw.
        let (mut document, page_id) = tesseract_page(&["in", "fefto", "Chrifti"]);
        apply_ocr_word_edits(
            &mut document,
            page_id,
            &[edit(2, "fefto", "feſto"), edit(3, "Chrifti", "Chriſti")],
        )
        .unwrap();
        assert_eq!(
            page_words(&document, page_id),
            ["in ", "feſto ", "Chriſti "]
        );
    }

    #[test]
    fn word_edits_that_change_a_words_length_keep_it_on_its_box() {
        // Tesseract stretches each word over its box: `<scale> Tz [<word >] TJ`.
        let mut document = Document::with_version("1.5");
        let operations: Vec<ContentOperation> = [("O&.", 120.0), ("Feſti", 90.0)]
            .iter()
            .flat_map(|(word, scale)| {
                [
                    ContentOperation::new("Tz", vec![Object::Real(*scale)]),
                    ContentOperation::new(
                        "TJ",
                        vec![Object::Array(vec![Object::String(
                            utf16be(&format!("{word} ")),
                            StringFormat::Hexadecimal,
                        )])],
                    ),
                ]
            })
            .collect();
        let content = Content { operations }.encode().unwrap();
        let content_id = document.add_object(Stream::new(dictionary! {}, content));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Contents" => content_id,
        });
        apply_ocr_word_edits(&mut document, page_id, &[edit(0, "O&.", "Oct.")]).unwrap();
        assert_eq!(page_words(&document, page_id), ["Oct. ", "Feſti "]);
        let content = Content::decode(&document.get_page_content(page_id)).unwrap();
        let scales: Vec<f32> = content
            .operations
            .iter()
            .filter(|operation| operation.operator == "Tz")
            .map(|operation| operation.operands[0].as_float().unwrap())
            .collect();
        // Four glyphs and a space now share the width three and a space had.
        assert_eq!(scales, [96.0, 90.0]);
    }

    #[test]
    fn word_edits_on_a_page_without_text_change_nothing() {
        let (mut document, page_id) = tesseract_page(&[]);
        apply_ocr_word_edits(&mut document, page_id, &[edit(0, "fefto", "feſto")]).unwrap();
        assert!(page_words(&document, page_id).is_empty());
    }

    #[test]
    fn word_edits_without_their_word_change_nothing() {
        let (mut document, page_id) = tesseract_page(&["in", "fefto"]);
        apply_ocr_word_edits(&mut document, page_id, &[edit(1, "ufque", "uſque")]).unwrap();
        assert_eq!(page_words(&document, page_id), ["in ", "fefto "]);
    }

    fn apply(matrix: [f64; 6], x: f64, y: f64) -> (f64, f64) {
        (
            matrix[0] * x + matrix[2] * y + matrix[4],
            matrix[1] * x + matrix[3] * y + matrix[5],
        )
    }

    fn assert_point(actual: (f64, f64), expected: (f64, f64)) {
        assert!(
            (actual.0 - expected.0).abs() < 1e-9 && (actual.1 - expected.1).abs() < 1e-9,
            "{actual:?} != {expected:?}"
        );
    }

    #[test]
    fn maps_the_displayed_top_left_corner_for_every_rotation() {
        // A 200x100 page view offset by (10, 20); Tesseract saw the raster
        // in display orientation, so its page is 100x200 when turned.
        let view = rect(10.0, 20.0, 210.0, 120.0);
        let cases = [
            (0, rect(0.0, 0.0, 400.0, 200.0), (10.0, 120.0)),
            (90, rect(0.0, 0.0, 200.0, 400.0), (10.0, 20.0)),
            (180, rect(0.0, 0.0, 400.0, 200.0), (210.0, 20.0)),
            (270, rect(0.0, 0.0, 200.0, 400.0), (210.0, 120.0)),
        ];
        for (rotation, source, top_left) in cases {
            let matrix = ocr_layer_matrix(view, rotation, source, None).unwrap();
            // The displayed top-left corner of the raster is (0, height).
            assert_point(apply(matrix, 0.0, source.height()), top_left);
        }
    }

    #[test]
    fn composes_the_preprocessing_inverse_in_raster_pixels() {
        let view = rect(0.0, 0.0, 100.0, 100.0);
        let source = rect(0.0, 0.0, 100.0, 100.0);
        // The preprocessed raster is the rendered raster shifted right by
        // 10 px; the inverse shifts it back.
        let inverse = OcrPreprocessInverse {
            raster_width_px: 1000.0,
            raster_height_px: 1000.0,
            matrix: [[1.0, 0.0, -10.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        };
        let matrix = ocr_layer_matrix(view, 0, source, Some(&inverse)).unwrap();
        // 10 px of a 1000 px raster over a 100 pt page is 1 pt.
        assert_point(apply(matrix, 50.0, 50.0), (49.0, 50.0));
    }

    #[test]
    fn refuses_preprocessing_inverses_no_pdf_real_can_carry() {
        for inverse in [
            serde_json::json!({"rasterWidthPx": 1e40, "rasterHeightPx": 1000, "matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}),
            serde_json::json!({"rasterWidthPx": 1000, "rasterHeightPx": 1000, "matrix": [[1, 0, 1e40], [0, 1, 0], [0, 0, 1]]}),
            serde_json::json!({"rasterWidthPx": 1e-40, "rasterHeightPx": 1000, "matrix": [[1, 0, 1], [0, 1, 0], [0, 0, 1]]}),
        ] {
            let instructions: OcrTextLayerFile<usize> = serde_json::from_value(serde_json::json!({
                "pages": [{"pageNumber": 1, "source": 0, "preprocessInverse": inverse}],
            }))
            .unwrap();
            assert!(validate_ocr_text_layer(&instructions)
                .unwrap_err()
                .to_string()
                .contains("range"));
        }
    }

    #[test]
    fn restores_the_rendering_mode_and_refuses_mixed_text_objects() {
        let mut scan = PageTextScan::default();
        let restored = Content::decode(b"q BT 3 Tr (a) Tj ET Q BT (b) Tj ET").unwrap();
        assert_eq!(scan.scan_stream(&restored.operations, |_, _| {}), vec![3]);
        assert!(scan.painted && scan.hidden && scan.unsupported.is_none());

        let mut scan = PageTextScan::default();
        let mixed = Content::decode(b"BT 3 Tr (a) Tj 0 Tr (b) Tj ET").unwrap();
        scan.scan_stream(&mixed.operations, |_, _| {});
        assert_eq!(
            scan.unsupported,
            Some("hidden and visible text share one text object")
        );
    }

    #[test]
    fn refuses_a_text_object_split_across_content_streams() {
        let mut scan = PageTextScan::default();
        let first = Content::decode(b"BT 3 Tr (a) Tj").unwrap();
        let second = Content::decode(b"0 Tr (b) Tj ET").unwrap();
        scan.scan_stream(&first.operations, |_, _| {});
        scan.scan_stream(&second.operations, |_, _| {});
        assert_eq!(
            scan.unsupported,
            Some("hidden and visible text share one text object")
        );
    }

    #[test]
    fn clip_only_text_is_neither_painted_nor_hidden_and_cannot_be_replaced() {
        let mut scan = PageTextScan::default();
        let clip = Content::decode(b"BT 7 Tr (a) Tj ET").unwrap();
        assert!(scan.scan_stream(&clip.operations, |_, _| {}).is_empty());
        assert!(!scan.painted && !scan.hidden);
        assert_eq!(
            scan.unsupported,
            Some("text clipping rendering modes cannot be replaced safely")
        );
    }

    #[test]
    fn a_saved_mode_survives_the_end_of_a_content_stream() {
        let mut scan = PageTextScan::default();
        let first = Content::decode(b"q 3 Tr BT (a) Tj ET").unwrap();
        let second = Content::decode(b"Q BT (b) Tj ET").unwrap();
        scan.scan_stream(&first.operations, |_, _| {});
        scan.scan_stream(&second.operations, |_, _| {});
        assert!(scan.hidden && scan.painted);
    }

    #[test]
    fn reports_the_mode_a_form_inherits_where_it_is_drawn() {
        let mut scan = PageTextScan::default();
        let content = Content::decode(b"q 3 Tr /Fm0 Do Q /Fm1 Do").unwrap();
        let mut draws = Vec::new();
        scan.scan_stream(&content.operations, |name, mode| {
            draws.push((name.as_name().unwrap().to_vec(), mode))
        });
        assert_eq!(draws, vec![(b"Fm0".to_vec(), 3), (b"Fm1".to_vec(), 0)]);
    }

    #[test]
    fn recognizes_only_a_whole_stream_framed_as_an_evb_layer() {
        assert!(is_evb_ocr_layer_stream(
            b"% EVB_VIEWER_OCR_LAYER_BEGIN\nq\nBT\n3 Tr\n<0054> Tj\nET\nQ\n% EVB_VIEWER_OCR_LAYER_END\n"
        ));
        assert!(is_evb_ocr_layer_stream(
            b"% EVB_VIEWER_OCR_LAYER_BEGIN\r\n/EvbOcrLayer Do\r\n% EVB_VIEWER_OCR_LAYER_END"
        ));
        for not_a_layer in [
            &b"% copied from EVB_VIEWER_OCR_LAYER_BEGIN in a PDF comment"[..],
            b"% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do",
            b"BT 3 Tr (text) Tj ET\n% EVB_VIEWER_OCR_LAYER_END",
            b"0 0 10 10 re f\n% EVB_VIEWER_OCR_LAYER_BEGIN\nBT 3 Tr (x) Tj ET\n% EVB_VIEWER_OCR_LAYER_END",
        ] {
            assert!(!is_evb_ocr_layer_stream(not_a_layer));
        }
    }

    #[test]
    fn reads_an_evb_layer_one_recognized_line_per_line_with_where_it_stands() {
        // The writer's shape: per-glyph `Tm` on a rotated line, Tesseract's
        // word step with a sub-point baseline shift, a `Td` one line down, and
        // a second block.
        let layer = b"% EVB_VIEWER_OCR_LAYER_BEGIN\nq\nBT\n3 Tr\n/F 34 Tf\n\
0.999 0.038 -0.038 0.999 233 2863 Tm\n<006300750020> Tj\n\
0.999 0.038 -0.038 0.999 260 2864 Tm\n<0052006500660020> Tj\n\
73.061 -0.276 Td\n0.999 0.038 -0.038 0.999 310 2866 Tm\n<0066007500200020> Tj\n\
-663.739 -34.014 Td\n0.999 0.038 -0.038 0.999 236 2829 Tm\n[<0054002E> -200 <0061>] TJ\nET\n\
BT\n/F 34 Tf\n1 0 0 1 1000 2863 Tm\n<017F0069> Tj\nET\nQ\n% EVB_VIEWER_OCR_LAYER_END\n";
        let line = |block, text: &str, left, right, baseline| OcrLayerLine {
            block,
            text: text.into(),
            left,
            right,
            baseline,
            size: 34.0,
        };
        assert_eq!(
            evb_ocr_layer_lines(layer),
            Some(vec![
                line(0, "cu Ref fu", 233.0, 310.0, 2863.0),
                line(0, "T.a", 236.0, 236.0, 2829.0),
                line(1, "\u{17f}i", 1000.0, 1000.0, 2863.0),
            ])
        );
        assert_eq!(
            evb_ocr_layer_lines(
                b"% EVB_VIEWER_OCR_LAYER_BEGIN\n/EvbOcrLayer Do\n% EVB_VIEWER_OCR_LAYER_END\n"
            ),
            None
        );
    }

    /// A one-page PDF whose content draws `/Im0`, an image with `image` added
    /// to its dictionary, and `/F1` text, on a 600 x 800 page.
    fn scanned_page_pdf(content: &[u8], image: Dictionary) -> Vec<u8> {
        let mut document = Document::with_version("1.5");
        let mut image_dict = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 1,
            "Height" => 1,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
        };
        image_dict.extend(&image);
        let image_id = document.add_object(Stream::new(image_dict, vec![0]));
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let content_id = document.add_object(Stream::new(dictionary! {}, content.to_vec()));
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Im0" => image_id },
                "Font" => dictionary! { "F1" => font_id },
            },
            "Contents" => content_id,
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        bytes
    }

    /// What the visibility report says of the page: (painted text, hidden text).
    fn painted_and_hidden(pdf: &[u8]) -> (bool, bool) {
        let report: serde_json::Value = serde_json::from_slice(
            &ocr_text_visibility_from_source(pdf, pdf.len() as u64, &[1], false).unwrap(),
        )
        .unwrap();
        let page = &report["pages"][0];
        (
            page["paintedText"].as_bool().unwrap(),
            page["hiddenText"].as_bool().unwrap(),
        )
    }

    /// The operators the writer leaves on the page after removing earlier OCR text.
    fn operators_after_strip(pdf: &[u8]) -> Vec<String> {
        let mut incremental = incremental_from_bytes(pdf).unwrap();
        let page_id = PageTreeResolver::new(&incremental.previous_document)
            .unwrap()
            .page_id(&incremental.previous_document, 1)
            .unwrap();
        prepare_incremental_overlay_page(&mut incremental, page_id).unwrap();
        strip_previous_ocr_text(&mut incremental, None, page_id).unwrap();
        incremental
            .new_document
            .get_page_contents(page_id)
            .into_iter()
            .flat_map(|id| {
                let bytes = read_content_stream(&mut incremental, None, id)
                    .unwrap()
                    .unwrap();
                Content::decode(&bytes).unwrap().operations
            })
            .map(|operation| operation.operator)
            .collect()
    }

    const UNDER_SCAN: &[u8] =
        b"BT 1 1 1 rg /F1 14 Tf 1 0 0 1 76 700 Tm (temps-la) Tj ET q 600 0 0 800 0 0 cm /Im0 Do Q";

    #[test]
    fn text_under_an_opaque_full_page_scan_is_hidden_ocr_and_removed() {
        let pdf = scanned_page_pdf(UNDER_SCAN, Dictionary::new());
        assert_eq!(painted_and_hidden(&pdf), (false, true));
        let operators = operators_after_strip(&pdf);
        assert!(!operators.iter().any(|operator| operator == "Tj"));
        assert!(operators.iter().any(|operator| operator == "Do"));
    }

    #[test]
    fn text_a_scan_does_not_fully_hide_stays_the_pages_own() {
        let partial = b"BT /F1 14 Tf 1 0 0 1 76 700 Tm (a) Tj ET q 300 0 0 800 0 0 cm /Im0 Do Q";
        let after = b"q 600 0 0 800 0 0 cm /Im0 Do Q BT /F1 14 Tf 1 0 0 1 76 700 Tm (a) Tj ET";
        let clipped = b"BT /F1 14 Tf 1 0 0 1 76 700 Tm (a) Tj ET q 0 0 300 300 re W n 600 0 0 800 0 0 cm /Im0 Do Q";
        let optional = b"BT /F1 14 Tf 1 0 0 1 76 700 Tm (a) Tj ET /OC /L0 BDC q 600 0 0 800 0 0 cm /Im0 Do Q EMC";
        for content in [&partial[..], &after[..], &clipped[..], &optional[..]] {
            let pdf = scanned_page_pdf(content, Dictionary::new());
            assert_eq!(
                painted_and_hidden(&pdf),
                (true, false),
                "{}",
                String::from_utf8_lossy(content)
            );
            assert!(operators_after_strip(&pdf)
                .iter()
                .any(|operator| operator == "Tj"));
        }
        for image in [
            dictionary! { "SMask" => Object::Null },
            dictionary! { "Mask" => vec![0.into(), 0.into()] },
            dictionary! { "ImageMask" => true },
        ] {
            let pdf = scanned_page_pdf(UNDER_SCAN, image);
            assert_eq!(painted_and_hidden(&pdf), (true, false));
        }
    }

    #[test]
    fn text_visibility_report_matches_the_shared_protocol_fixture() {
        let source = include_str!("../../protocol-fixtures/pdf-page-ops-ocr-text-visibility.json");
        let report: OcrTextVisibilityReport = serde_json::from_str(source).unwrap();
        assert_eq!(report.format, OCR_TEXT_VISIBILITY_FORMAT);
        assert_eq!(report.schema_version, OCR_TEXT_VISIBILITY_SCHEMA_VERSION);
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            serde_json::from_str::<serde_json::Value>(source).unwrap()
        );
        let with_unknown =
            source.replacen("\"pageNumber\": 1,", "\"pageNumber\": 1, \"extra\": 1,", 1);
        assert!(serde_json::from_str::<OcrTextVisibilityReport>(&with_unknown).is_err());
    }
}
