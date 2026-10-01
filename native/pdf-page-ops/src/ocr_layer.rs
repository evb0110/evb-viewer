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
use lopdf::content::{Content, Operation as ContentOperation};
use serde::Serialize;
use std::path::Path;

const EVB_OCR_LAYER_BEGIN: &[u8] = b"% EVB_VIEWER_OCR_LAYER_BEGIN\n";
const EVB_OCR_LAYER_END: &[u8] = b"\n% EVB_VIEWER_OCR_LAYER_END\n";
const MAX_OCR_CONTENT_STREAM_BYTES: usize = 64 * 1024 * 1024;
/// Tesseract writes one small page per raster. The bound keeps a damaged or
/// unexpected sidecar from being loaded eagerly.
const MAX_OCR_SOURCE_PDF_BYTES: u64 = 16 * 1024 * 1024;

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

pub(crate) fn read_ocr_text_layer_file(path: &Path) -> Result<OcrTextLayerFile> {
    let instructions: OcrTextLayerFile = read_json_sidecar(path, "OCR text-layer instructions")?;
    if instructions.pages.is_empty() {
        return Err("ocr-text-layer requires at least one page".into());
    }
    let mut pages = HashSet::new();
    for page in &instructions.pages {
        if page.page_number == 0 || !pages.insert(page.page_number) {
            return Err("ocr-text-layer page numbers must be positive and unique".into());
        }
        if let Some(inverse) = page.preprocess_inverse {
            if !(inverse.raster_width_px.is_finite()
                && inverse.raster_height_px.is_finite()
                && inverse.raster_width_px > 0.0
                && inverse.raster_height_px > 0.0)
            {
                return Err("ocr-text-layer raster dimensions must be positive".into());
            }
            if !inverse
                .matrix
                .iter()
                .flatten()
                .all(|value| value.is_finite())
                || determinant(inverse.matrix).abs() <= 1e-12
            {
                return Err(
                    "ocr-text-layer preprocessing inverse must be a finite invertible 3x3 matrix"
                        .into(),
                );
            }
        }
    }
    Ok(instructions)
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

fn is_text_show(operator: &str) -> bool {
    matches!(operator, "Tj" | "TJ" | "'" | "\"")
}

fn paints(operator: &str) -> bool {
    is_text_show(operator)
        || matches!(
            operator,
            "Do" | "sh" | "BI" | "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*"
        )
}

fn unsupported_replacement(detail: &str) -> Box<dyn Error> {
    domain_error(
        NativeErrorCode::InvalidRequest,
        format!("OCR page replacement is unsupported: {detail}"),
    )
}

/// EVB appends its OCR text as a content stream of its own between the marker
/// comments; earlier versions drew a Form XObject inside the same frame. A
/// comment that only names the marker, or a frame merged into other content,
/// is not an EVB layer, so it is never removed as one.
fn is_evb_ocr_layer_stream(bytes: &[u8]) -> bool {
    fn is_marker_comment(line: Option<&[u8]>, marker: &[u8]) -> bool {
        line.and_then(|line| line.strip_prefix(b"%"))
            .is_some_and(|comment| comment.trim_ascii() == marker)
    }
    let is_line_end = |byte: &u8| matches!(byte, b'\n' | b'\r');
    let framed = bytes.trim_ascii();
    is_marker_comment(
        framed.split(is_line_end).next(),
        b"EVB_VIEWER_OCR_LAYER_BEGIN",
    ) && is_marker_comment(
        framed.rsplit(is_line_end).next(),
        b"EVB_VIEWER_OCR_LAYER_END",
    )
}

fn rendering_mode(operation: &ContentOperation) -> Option<i64> {
    operation
        .operands
        .first()
        .and_then(|value| object_to_f64(value).ok())
        .filter(|value| value.fract() == 0.0 && (0.0..=7.0).contains(value))
        .map(|value| value as i64)
}

/// One page's text read the way a PDF consumer paints it. The rendering mode
/// is graphics state: `q` saves it and `Q` restores it, across the page's
/// content streams as a consumer concatenates them. The writer removes text
/// through this scan and the OCR eligibility inspection reports through it,
/// so a page the inspection offers for replacement is one the writer accepts.
#[derive(Default)]
struct PageTextScan {
    mode: i64,
    saved_modes: Vec<i64>,
    painted: bool,
    hidden: bool,
    /// Why removing this page's hidden text could change what it paints.
    unsupported: Option<&'static str>,
}

impl PageTextScan {
    /// Reads one content stream and returns the indices of its hidden
    /// (`3 Tr`) text-show operations. `on_draw` receives each `Do` operand
    /// with the rendering mode a Form XObject drawn there inherits.
    fn scan_stream(
        &mut self,
        operations: &[ContentOperation],
        mut on_draw: impl FnMut(&Object, i64),
    ) -> Vec<usize> {
        let mut hidden = Vec::new();
        let (mut object_hidden, mut object_other) = (false, false);
        for (index, operation) in operations.iter().enumerate() {
            match operation.operator.as_str() {
                "q" => self.saved_modes.push(self.mode),
                "Q" => self.mode = self.saved_modes.pop().unwrap_or(self.mode),
                "BT" => (object_hidden, object_other) = (false, false),
                "Tr" => match rendering_mode(operation) {
                    Some(mode) => self.mode = mode,
                    None => self.refuse("a Tr operator is malformed"),
                },
                "Do" => {
                    if let Some(name) = operation.operands.first() {
                        on_draw(name, self.mode);
                    }
                }
                operator if is_text_show(operator) => {
                    if self.mode == 3 {
                        hidden.push(index);
                        self.hidden = true;
                        object_hidden = true;
                    } else {
                        // Modes 4 to 6 paint and clip; mode 7 only clips.
                        self.painted |= self.mode != 7;
                        object_other = true;
                    }
                    if self.mode >= 4 {
                        self.refuse("text clipping rendering modes cannot be replaced safely");
                    }
                    if object_hidden && object_other {
                        // Removing part of a text object moves the text after it.
                        self.refuse("hidden and visible text share one text object");
                    }
                }
                _ => {}
            }
        }
        if !hidden.is_empty()
            && operations
                .iter()
                .any(|operation| operation.operator == "BI")
        {
            self.refuse("hidden text shares a content stream with an inline image");
        }
        hidden
    }

    fn refuse(&mut self, reason: &'static str) {
        self.unsupported.get_or_insert(reason);
    }
}

fn read_content_stream(
    incremental: &mut IncrementalDocument,
    input_path: &Path,
    qpdf_path: Option<&Path>,
    object_id: ObjectId,
) -> Result<Option<Vec<u8>>> {
    if !incremental.new_document.has_object(object_id) {
        if let Some(qpdf_path) = qpdf_path {
            incremental.materialize_base_stream(
                input_path,
                qpdf_path,
                object_id,
                MAX_OCR_CONTENT_STREAM_BYTES,
            )?;
        }
    }
    let document = if incremental.new_document.has_object(object_id) {
        &incremental.new_document
    } else {
        &incremental.previous_document
    };
    let Ok(Object::Stream(stream)) = document.get_object(object_id) else {
        return Ok(None);
    };
    Ok(stream
        .get_plain_content_with_limit(MAX_OCR_CONTENT_STREAM_BYTES)
        .ok())
}

/// Remove previous OCR text from a page whose dictionary is already in the
/// incremental revision. EVB layers go by their marker. Hidden text from
/// other producers goes by rendering mode; a stream left with nothing that
/// paints is dropped, a stream that still paints is rewritten without it.
fn strip_previous_ocr_text(
    incremental: &mut IncrementalDocument,
    input_path: &Path,
    qpdf_path: Option<&Path>,
    page_id: ObjectId,
) -> Result<()> {
    let content_ids = incremental.new_document.get_page_contents(page_id);
    let mut kept = Vec::with_capacity(content_ids.len());
    let mut changed = false;
    let mut scan = PageTextScan::default();
    for content_id in content_ids {
        let Some(bytes) = read_content_stream(incremental, input_path, qpdf_path, content_id)?
        else {
            kept.push(content_id);
            continue;
        };
        if is_evb_ocr_layer_stream(&bytes) {
            changed = true;
            continue;
        }
        let Ok(content) = Content::decode(&bytes) else {
            kept.push(content_id);
            continue;
        };
        let hidden = scan.scan_stream(&content.operations, |_, _| {});
        if let Some(reason) = scan.unsupported {
            return Err(unsupported_replacement(reason));
        }
        if hidden.is_empty() {
            kept.push(content_id);
            continue;
        }
        changed = true;
        let remaining = content
            .operations
            .into_iter()
            .enumerate()
            .filter(|(index, _)| hidden.binary_search(index).is_err())
            .map(|(_, operation)| operation)
            .collect::<Vec<_>>();
        if !remaining
            .iter()
            .any(|operation| paints(&operation.operator))
        {
            continue;
        }
        let mut stream = Stream::new(
            Dictionary::new(),
            Content {
                operations: remaining,
            }
            .encode()?,
        );
        stream.compress()?;
        kept.push(incremental.new_document.add_object(stream));
    }
    if changed {
        incremental.new_document.get_dictionary_mut(page_id)?.set(
            "Contents",
            Object::Array(kept.into_iter().map(Object::Reference).collect()),
        );
    }
    Ok(())
}

const OCR_TEXT_VISIBILITY_FORMAT: &str = "evb-pdf-ocr-text-visibility";
const OCR_TEXT_VISIBILITY_SCHEMA_VERSION: u32 = 1;
/// Form XObjects nest; deeper drawing is unusual and is reported as uncertain.
const MAX_OCR_VISIBILITY_FORM_DEPTH: usize = 16;
/// Decoded Form XObject content one page inspection reads before it stops
/// and reports the rest of the page as uncertain.
const MAX_OCR_VISIBILITY_FORM_BYTES: usize = MAX_OCR_CONTENT_STREAM_BYTES;

/// `ocr-text-visibility` stdout; `@contracts/pdfOcrTextVisibility` decodes it.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrTextVisibilityReport {
    format: String,
    schema_version: u32,
    pages: Vec<OcrPageTextVisibility>,
}

/// What OCR may replace on one page, in the writer's own terms.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OcrPageTextVisibility {
    page_number: u32,
    /// The page carries a layer EVB's OCR wrote, which the writer removes whole.
    evb_ocr_layer: bool,
    /// The page paints text, in its own content or in a Form XObject it draws.
    painted_text: bool,
    /// The page's own content shows hidden (`3 Tr`) text, which the writer removes.
    hidden_text: bool,
    /// Text the inspection could not read, or hidden text the writer keeps.
    uncertain: Option<String>,
    /// Why the writer refuses to replace this page's text.
    unsupported: Option<String>,
}

/// What one page shows beyond the scan of its own content: text in the Form
/// XObjects it draws, and content that could not be read. The writer leaves
/// forms alone, so their text decides whether the page paints text, and
/// hidden text in a form is text a replacement would keep beside the new layer.
struct PageTextInspection<'a> {
    input_path: &'a Path,
    qpdf_path: Option<&'a Path>,
    visited: HashSet<ObjectId>,
    decoded_bytes: usize,
    painted: bool,
    uncertain: Option<&'static str>,
}

impl PageTextInspection<'_> {
    fn doubt(&mut self, reason: &'static str) {
        self.uncertain.get_or_insert(reason);
    }

    fn inspect(
        &mut self,
        incremental: &mut IncrementalDocument,
        resources: &Dictionary,
        name: &Object,
        mode: i64,
        depth: usize,
    ) -> Result<()> {
        let document = &incremental.previous_document;
        let Some(form_id) = name.as_name().ok().and_then(|name| {
            let xobjects = resources.get(b"XObject").ok()?;
            let (_, xobjects) = document.dereference(xobjects).ok()?;
            xobjects.as_dict().ok()?.get(name).ok()?.as_reference().ok()
        }) else {
            return Ok(());
        };
        let Ok(Object::Stream(stream)) = document.get_object(form_id) else {
            return Ok(());
        };
        if stream.dict.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Form") {
            return Ok(());
        }
        if !self.visited.insert(form_id) {
            return Ok(());
        }
        if depth >= MAX_OCR_VISIBILITY_FORM_DEPTH {
            self.doubt("Form XObjects are nested too deeply to inspect");
            return Ok(());
        }
        // A form without its own resources uses those of the content drawing it.
        let form_resources = stream
            .dict
            .get(b"Resources")
            .ok()
            .and_then(|object| document.dereference(object).ok())
            .and_then(|(_, object)| object.as_dict().ok())
            .unwrap_or(resources)
            .clone();
        let Some(bytes) =
            read_content_stream(incremental, self.input_path, self.qpdf_path, form_id)?
        else {
            self.doubt("a Form XObject's content could not be read");
            return Ok(());
        };
        self.decoded_bytes = self.decoded_bytes.saturating_add(bytes.len());
        if self.decoded_bytes > MAX_OCR_VISIBILITY_FORM_BYTES {
            self.doubt("the page's Form XObjects exceed the inspection budget");
            return Ok(());
        }
        let Ok(content) = Content::decode(&bytes) else {
            self.doubt("a Form XObject's content could not be parsed");
            return Ok(());
        };
        // A form starts from the graphics state at its `Do` and cannot change
        // the state of the content that draws it.
        let mut scan = PageTextScan {
            mode,
            ..PageTextScan::default()
        };
        let mut draws = Vec::new();
        scan.scan_stream(&content.operations, |name, mode| {
            draws.push((name.clone(), mode))
        });
        self.painted |= scan.painted;
        if scan.hidden {
            self.doubt("hidden text inside a Form XObject is not removed by OCR replacement");
        }
        for (name, mode) in draws {
            self.inspect(incremental, &form_resources, &name, mode, depth + 1)?;
        }
        Ok(())
    }
}

fn inspect_page_text_visibility(
    incremental: &mut IncrementalDocument,
    inspection: &mut PageTextInspection,
    page_number: u32,
    page_id: ObjectId,
) -> Result<OcrPageTextVisibility> {
    let resources = page_resources(&incremental.previous_document, page_id)?;
    let mut scan = PageTextScan::default();
    let mut evb_ocr_layer = false;
    for content_id in incremental.previous_document.get_page_contents(page_id) {
        let Some(bytes) = read_content_stream(
            incremental,
            inspection.input_path,
            inspection.qpdf_path,
            content_id,
        )?
        else {
            inspection.doubt("a page content stream could not be read");
            continue;
        };
        if is_evb_ocr_layer_stream(&bytes) {
            evb_ocr_layer = true;
            continue;
        }
        let Ok(content) = Content::decode(&bytes) else {
            inspection.doubt("a page content stream could not be parsed");
            continue;
        };
        let mut draws = Vec::new();
        scan.scan_stream(&content.operations, |name, mode| {
            draws.push((name.clone(), mode))
        });
        for (name, mode) in draws {
            inspection.inspect(incremental, &resources, &name, mode, 0)?;
        }
    }
    Ok(OcrPageTextVisibility {
        page_number,
        evb_ocr_layer,
        painted_text: scan.painted || inspection.painted,
        hidden_text: scan.hidden,
        uncertain: inspection.uncertain.map(str::to_string),
        unsupported: scan.unsupported.map(str::to_string),
    })
}

/// Reports, per requested page, the evidence OCR page selection needs about
/// existing text, read with the scan the writer replaces text through.
pub(crate) fn write_ocr_text_visibility(
    input_path: &Path,
    page_numbers: &[u32],
    qpdf_path: Option<&Path>,
    output: &mut impl Write,
) -> Result<()> {
    let mut incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let resolver = PageTreeResolver::new(&incremental.previous_document)?;
    let mut pages = Vec::with_capacity(page_numbers.len());
    for &page_number in page_numbers {
        let page_id = resolver.page_id(&incremental.previous_document, page_number)?;
        let mut inspection = PageTextInspection {
            input_path,
            qpdf_path,
            visited: HashSet::new(),
            decoded_bytes: 0,
            painted: false,
            uncertain: None,
        };
        pages.push(inspect_page_text_visibility(
            &mut incremental,
            &mut inspection,
            page_number,
            page_id,
        )?);
    }
    serde_json::to_writer(
        output,
        &OcrTextVisibilityReport {
            format: OCR_TEXT_VISIBILITY_FORMAT.to_string(),
            schema_version: OCR_TEXT_VISIBILITY_SCHEMA_VERSION,
            pages,
        },
    )?;
    Ok(())
}

fn load_ocr_source(path: &Path) -> Result<Document> {
    let length = fs::metadata(path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    if length == 0 || length > MAX_OCR_SOURCE_PDF_BYTES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!(
                "OCR page PDF must be between 1 and {MAX_OCR_SOURCE_PDF_BYTES} bytes: {}",
                path.display()
            ),
        ));
    }
    let source = load_pdf_path(path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse OCR page PDF"))?;
    assert_plaintext_base(&source, "Encrypted OCR page PDFs are not supported")?;
    Ok(source)
}

pub(crate) fn write_ocr_text_layer_path(
    input_path: &Path,
    output_path: &Path,
    instructions: &OcrTextLayerFile,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let mut incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let resolver = PageTreeResolver::new(&incremental.previous_document)?;
    for page in &instructions.pages {
        let source = load_ocr_source(&page.source_path)?;
        let source_resolver = PageTreeResolver::new(&source)?;
        if source_resolver.page_count() != 1 {
            return Err("OCR page PDF must contain exactly one page".into());
        }
        let source_page_id = source_resolver.page_id(&source, 1)?;
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
            prepare_incremental_overlay_page(&mut incremental, page_id)?;
        }
        strip_previous_ocr_text(&mut incremental, input_path, qpdf_path, page_id)?;
        append_text_layer(
            &mut incremental.new_document,
            &source,
            page_id,
            source_page_id,
            matrix,
            false,
            page.normalize_greek_micro_sign,
            Some((EVB_OCR_LAYER_BEGIN, EVB_OCR_LAYER_END)),
            &mut HashMap::new(),
        )?;
    }
    incremental.new_document.version = incremental.get_prev_documents().version.clone();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x1: f64, y1: f64, x2: f64, y2: f64) -> PdfRect {
        PdfRect { x1, y1, x2, y2 }
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
