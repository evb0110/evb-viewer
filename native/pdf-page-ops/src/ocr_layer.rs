//! Searchable OCR layer for a whole document in one incremental revision.
//!
//! Each instruction names a target page and the one-page text-only PDF that
//! Tesseract produced for the raster of that page. The writer removes any
//! previous invisible text from the target page (EVB layers by their marker,
//! other producers' hidden text objects by their rendering mode), maps the
//! Tesseract page into the target page view, and appends the text as an
//! invisible, marked content stream.

use super::*;
use lopdf::content::{Content, Operation as ContentOperation};
use std::path::Path;

pub(crate) const EVB_OCR_LAYER_MARKER: &[u8] = b"EVB_VIEWER_OCR_LAYER";
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

/// Indices of hidden (`3 Tr`) text-show operations. Fails when one text object
/// mixes hidden and visible text, or clips with text, because removing part
/// of it could change what the page paints.
fn hidden_text_operations(operations: &[ContentOperation], mode: &mut i64) -> Result<Vec<usize>> {
    let mut modes = Vec::new();
    let mut hidden = Vec::new();
    let (mut object_hidden, mut object_visible) = (false, false);
    for (index, operation) in operations.iter().enumerate() {
        match operation.operator.as_str() {
            "q" => modes.push(*mode),
            "Q" => *mode = modes.pop().unwrap_or(*mode),
            "BT" => (object_hidden, object_visible) = (false, false),
            "Tr" => {
                *mode = operation
                    .operands
                    .first()
                    .and_then(|value| object_to_f64(value).ok())
                    .filter(|value| value.fract() == 0.0 && (0.0..=7.0).contains(value))
                    .map(|value| value as i64)
                    .ok_or("OCR page replacement found a malformed Tr operator")?;
            }
            operator if is_text_show(operator) => match *mode {
                3 if object_visible => {
                    return Err(unsupported_replacement(
                        "hidden and visible text share one text object",
                    ))
                }
                3 => {
                    object_hidden = true;
                    hidden.push(index);
                }
                4..=7 => {
                    return Err(unsupported_replacement(
                        "text clipping rendering modes cannot be replaced safely",
                    ))
                }
                _ if object_hidden => {
                    return Err(unsupported_replacement(
                        "hidden and visible text share one text object",
                    ))
                }
                _ => object_visible = true,
            },
            _ => {}
        }
    }
    Ok(hidden)
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
    let mut mode = 0;
    for content_id in content_ids {
        let Some(bytes) = read_content_stream(incremental, input_path, qpdf_path, content_id)?
        else {
            kept.push(content_id);
            continue;
        };
        if bytes
            .windows(EVB_OCR_LAYER_MARKER.len())
            .any(|window| window == EVB_OCR_LAYER_MARKER)
        {
            changed = true;
            continue;
        }
        let Ok(content) = Content::decode(&bytes) else {
            kept.push(content_id);
            continue;
        };
        let hidden = hidden_text_operations(&content.operations, &mut mode)?;
        if hidden.is_empty() {
            kept.push(content_id);
            continue;
        }
        if content
            .operations
            .iter()
            .any(|operation| operation.operator == "BI")
        {
            return Err(unsupported_replacement(
                "hidden text shares a content stream with an inline image",
            ));
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
    fn finds_hidden_text_and_rejects_mixed_text_objects() {
        let hidden = Content::decode(b"q BT 3 Tr (a) Tj ET Q BT (b) Tj ET").unwrap();
        let mut mode = 0;
        assert_eq!(
            hidden_text_operations(&hidden.operations, &mut mode).unwrap(),
            vec![3]
        );
        let mixed = Content::decode(b"BT 3 Tr (a) Tj 0 Tr (b) Tj ET").unwrap();
        let mut mode = 0;
        assert!(hidden_text_operations(&mixed.operations, &mut mode).is_err());
    }
}
