use super::*;
use evb_native_support::output::{AtomicOutput, ValidatedInputFiles};
use serde::Serialize;

#[derive(Clone, Copy)]
pub(crate) struct PageGeometry {
    pub(crate) media_box: PdfRect,
    pub(crate) crop_box: Option<PdfRect>,
    pub(crate) rotation: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageGeometryBoxOutput {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageGeometryOutput {
    media_box: PageGeometryBoxOutput,
    crop_box: Option<PageGeometryBoxOutput>,
    rotation: i64,
}

fn page_geometry_box_output(rect: PdfRect) -> PageGeometryBoxOutput {
    PageGeometryBoxOutput {
        x: rect.x1,
        y: rect.y1,
        width: rect.width(),
        height: rect.height(),
    }
}

fn page_geometry_output(geometry: PageGeometry) -> PageGeometryOutput {
    PageGeometryOutput {
        media_box: page_geometry_box_output(geometry.media_box),
        crop_box: geometry.crop_box.map(page_geometry_box_output),
        rotation: geometry.rotation,
    }
}

pub(crate) fn get_page_geometry(
    document: &impl PdfObjectSource,
    page_number: u32,
) -> Result<PageGeometry> {
    let page_resolver = PageTreeResolver::new(document)?;
    let page_id = page_resolver.page_id(document, page_number)?;
    let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
    let crop_box = resolve_inherited_box(document, page_id, b"CropBox")
        .ok()
        .and_then(|crop_box| intersect_rect(crop_box, media_box))
        .filter(|crop_box| !pdf_rects_equal(*crop_box, media_box));

    Ok(PageGeometry {
        media_box,
        crop_box,
        rotation: resolve_page_rotation(document, page_id)?,
    })
}

pub(crate) fn write_page_geometry_path(
    input_path: &Path,
    output_path: &Path,
    page_number: u32,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let _validated_input = ValidatedInputFiles::open(&[input_path.to_path_buf()], output_path)?;
    let incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;

    let geometry = get_page_geometry(&AppendedRevision::new(&incremental), page_number)?;
    let mut output = AtomicOutput::create(output_path)?;
    serde_json::to_writer(output.file_mut()?, &page_geometry_output(geometry))?;
    output.publish()?;
    Ok(())
}

pub(crate) fn write_crop_pages_path(
    input_path: &Path,
    output_path: &Path,
    pages: &[u32],
    margins: CropMargins,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let mut incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;

    crop_pages_incremental(&mut incremental, pages, margins)?;
    append_incremental_page_revision(
        input_path,
        output_path,
        &mut incremental,
        pages,
        CropRevisionExpectation::Margins(margins),
    )
}

pub(crate) fn write_remove_crop_pages_path(
    input_path: &Path,
    output_path: &Path,
    pages: &[u32],
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let mut incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;

    remove_crop_from_pages_incremental(&mut incremental, pages)?;
    append_incremental_page_revision(
        input_path,
        output_path,
        &mut incremental,
        pages,
        CropRevisionExpectation::RestoreMediaBox,
    )
}

#[derive(Clone, Copy)]
pub(crate) enum CropRevisionExpectation {
    Margins(CropMargins),
    RestoreMediaBox,
}

pub(crate) fn append_incremental_page_revision(
    input_path: &Path,
    output_path: &Path,
    incremental: &mut IncrementalDocument,
    pages: &[u32],
    expectation: CropRevisionExpectation,
) -> Result<()> {
    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    with_staged_incremental_output(input_path, output_path, |staged_output_path| {
        assert_append_output_length(staged_output_path, incremental.previous_len())?;
        let revision_bytes = build_incremental_revision(incremental)?;
        let expected_object_ids = collect_incremental_append_object_ids(incremental);
        write_incremental_revision(
            staged_output_path,
            incremental,
            &revision_bytes,
            &expected_object_ids,
        )?;
        validate_crop_revision_postconditions(incremental, pages, expectation)
    })
}

fn validate_crop_revision_postconditions(
    incremental: &IncrementalDocument,
    pages: &[u32],
    expectation: CropRevisionExpectation,
) -> Result<()> {
    let revision = AppendedRevision::new(incremental);
    let page_resolver = PageTreeResolver::new(&revision)?;

    for &page_number in pages {
        let page_id = page_resolver.page_id(&revision, page_number)?;
        let media_box = resolve_inherited_box(&revision, page_id, b"MediaBox")?;
        let expected_crop_box = match expectation {
            CropRevisionExpectation::Margins(margins) => {
                let crop_width = media_box.width() - margins.left - margins.right;
                let crop_height = media_box.height() - margins.top - margins.bottom;
                if crop_width <= 0.0 || crop_height <= 0.0 {
                    return Err(
                        format!("Crop postcondition could not resolve page {page_number}").into(),
                    );
                }
                PdfRect {
                    x1: media_box.x1 + margins.left,
                    y1: media_box.y1 + margins.bottom,
                    x2: media_box.x1 + margins.left + crop_width,
                    y2: media_box.y1 + margins.bottom + crop_height,
                }
            }
            CropRevisionExpectation::RestoreMediaBox => media_box,
        };
        let actual_crop_box = resolve_inherited_box(&revision, page_id, b"CropBox")?;
        if !pdf_rects_equal(actual_crop_box, expected_crop_box) {
            return Err(format!("Crop postcondition failed for page {page_number}").into());
        }
    }

    Ok(())
}

pub(crate) fn normalize_page_rotation(value: i64) -> i64 {
    let snapped = ((value as f64) / 90.0).round() as i64 * 90;
    let normalized = ((snapped % 360) + 360) % 360;
    match normalized {
        90 | 180 | 270 => normalized,
        _ => 0,
    }
}

pub(crate) fn resolve_page_rotation(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
) -> Result<i64> {
    let mut current_id = Some(page_id);
    let mut seen = HashSet::new();

    while let Some(object_id) = current_id {
        if !seen.insert(object_id) {
            return Err("Page tree cycle while resolving Rotate".into());
        }

        let dict = document.dictionary(object_id)?;
        if let Ok(object) = dict.get(b"Rotate") {
            let resolved = document.resolved(object)?;
            return Ok(normalize_page_rotation(resolved.as_i64()?));
        }

        current_id = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }

    Ok(0)
}

pub(crate) fn intersect_rect(left: PdfRect, right: PdfRect) -> Option<PdfRect> {
    let rect = PdfRect {
        x1: left.x1.max(right.x1),
        y1: left.y1.max(right.y1),
        x2: left.x2.min(right.x2),
        y2: left.y2.min(right.y2),
    };
    if rect.width() <= 0.0 || rect.height() <= 0.0 {
        return None;
    }
    Some(rect)
}

pub(crate) fn pdf_rects_equal(left: PdfRect, right: PdfRect) -> bool {
    left.x1 == right.x1 && left.y1 == right.y1 && left.x2 == right.x2 && left.y2 == right.y2
}

pub(crate) fn resolve_page_view(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
) -> Result<PdfRect> {
    let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
    match resolve_inherited_box(document, page_id, b"CropBox") {
        Ok(crop_box) => Ok(intersect_rect(crop_box, media_box).unwrap_or(media_box)),
        Err(_) => Ok(media_box),
    }
}

pub(crate) fn pdf_point_from_marker_point(
    marker_x: f64,
    marker_y: f64,
    page_view: PdfRect,
    page_rotation: i64,
) -> (f64, f64) {
    let mut norm_x = marker_x;
    let mut norm_y = 1.0 - marker_y;

    match page_rotation {
        90 => {
            norm_x = marker_y;
            norm_y = marker_x;
        }
        180 => {
            norm_x = 1.0 - marker_x;
            norm_y = marker_y;
        }
        270 => {
            norm_x = 1.0 - marker_y;
            norm_y = 1.0 - marker_x;
        }
        _ => {}
    }

    (
        page_view.x1 + norm_x * page_view.width(),
        page_view.y1 + norm_y * page_view.height(),
    )
}

pub(crate) fn marker_rect_to_pdf_rect(
    marker_rect: MarkerRect,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<PdfRect> {
    validate_marker_rect(marker_rect)?;
    let marker_right = marker_rect.left + marker_rect.width;
    let marker_bottom = marker_rect.top + marker_rect.height;
    let points = [
        pdf_point_from_marker_point(marker_rect.left, marker_rect.top, page_view, page_rotation),
        pdf_point_from_marker_point(marker_right, marker_rect.top, page_view, page_rotation),
        pdf_point_from_marker_point(marker_rect.left, marker_bottom, page_view, page_rotation),
        pdf_point_from_marker_point(marker_right, marker_bottom, page_view, page_rotation),
    ];
    let min_x = points
        .iter()
        .map(|point| point.0)
        .fold(f64::INFINITY, f64::min);
    let min_y = points
        .iter()
        .map(|point| point.1)
        .fold(f64::INFINITY, f64::min);
    let max_x = points
        .iter()
        .map(|point| point.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = points
        .iter()
        .map(|point| point.1)
        .fold(f64::NEG_INFINITY, f64::max);
    parse_rect(&Object::Array(vec![
        number_object(min_x),
        number_object(min_y),
        number_object(max_x),
        number_object(max_y),
    ]))
}

/// Convert a PDF-space annotation rectangle back into the normalized marker
/// coordinates used by the renderer and mutation protocol. Keep this beside
/// `marker_rect_to_pdf_rect` so parse and write cannot quietly choose different
/// rotation conventions.
pub(crate) fn pdf_rect_to_marker_rect(
    rect: PdfRect,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<MarkerRect> {
    if !rect.x1.is_finite()
        || !rect.y1.is_finite()
        || !rect.x2.is_finite()
        || !rect.y2.is_finite()
        || rect.width() <= 0.0
        || rect.height() <= 0.0
        || !page_view.width().is_finite()
        || !page_view.height().is_finite()
        || page_view.width() <= 0.0
        || page_view.height() <= 0.0
    {
        return Err("Invalid PDF rectangle or page view".into());
    }

    let (left, top, width, height) = match normalize_page_rotation(page_rotation) {
        90 => (
            (rect.y1 - page_view.y1) / page_view.height(),
            (rect.x1 - page_view.x1) / page_view.width(),
            rect.height() / page_view.height(),
            rect.width() / page_view.width(),
        ),
        180 => (
            1.0 - (rect.x2 - page_view.x1) / page_view.width(),
            (rect.y1 - page_view.y1) / page_view.height(),
            rect.width() / page_view.width(),
            rect.height() / page_view.height(),
        ),
        270 => (
            1.0 - (rect.y2 - page_view.y1) / page_view.height(),
            1.0 - (rect.x2 - page_view.x1) / page_view.width(),
            rect.height() / page_view.height(),
            rect.width() / page_view.width(),
        ),
        _ => (
            (rect.x1 - page_view.x1) / page_view.width(),
            1.0 - (rect.y2 - page_view.y1) / page_view.height(),
            rect.width() / page_view.width(),
            rect.height() / page_view.height(),
        ),
    };

    let marker_rect = MarkerRect {
        left,
        top,
        width,
        height,
    };
    validate_marker_rect(marker_rect)?;
    Ok(marker_rect)
}

pub(crate) fn crop_pages_incremental(
    incremental: &mut IncrementalDocument,
    pages: &[u32],
    margins: CropMargins,
) -> Result<()> {
    validate_crop_margins(margins)?;
    let selected_pages = resolve_selected_page_ids(incremental.get_prev_documents(), pages)?;
    let mut preflighted_pages = Vec::new();
    preflighted_pages
        .try_reserve_exact(selected_pages.len())
        .map_err(|_| "Too many pages selected for crop")?;
    for (page_number, page_id) in selected_pages {
        let media_box =
            resolve_inherited_box(incremental.get_prev_documents(), page_id, b"MediaBox")?;
        let crop_width = media_box.width() - margins.left - margins.right;
        let crop_height = media_box.height() - margins.top - margins.bottom;
        if crop_width <= 0.0 || crop_height <= 0.0 {
            return Err(format!(
                "Crop margins consume page {page_number} ({} x {})",
                media_box.width(),
                media_box.height()
            )
            .into());
        }
        let crop_box = PdfRect {
            x1: media_box.x1 + margins.left,
            y1: media_box.y1 + margins.bottom,
            x2: media_box.x1 + margins.left + crop_width,
            y2: media_box.y1 + margins.bottom + crop_height,
        };
        preflighted_pages.push((page_id, crop_box));
    }

    for (page_id, crop_box) in preflighted_pages {
        incremental.opt_clone_object_to_new_document(page_id)?;
        let page = incremental.new_document.get_dictionary_mut(page_id)?;
        set_page_crop_box_on_dictionary(page, crop_box);
    }
    Ok(())
}

pub(crate) fn validate_crop_margins(margins: CropMargins) -> Result<()> {
    for (label, value) in [
        ("top", margins.top),
        ("bottom", margins.bottom),
        ("left", margins.left),
        ("right", margins.right),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(format!("Invalid {label} crop margin").into());
        }
    }
    Ok(())
}

pub(crate) fn remove_crop_from_pages_incremental(
    incremental: &mut IncrementalDocument,
    pages: &[u32],
) -> Result<()> {
    let selected_pages = resolve_selected_page_ids(incremental.get_prev_documents(), pages)?;
    let mut preflighted_pages = Vec::new();
    preflighted_pages
        .try_reserve_exact(selected_pages.len())
        .map_err(|_| "Too many pages selected for crop removal")?;
    for (page_number, page_id) in selected_pages {
        let media_box =
            resolve_inherited_box(incremental.get_prev_documents(), page_id, b"MediaBox")?;
        preflighted_pages.push((page_number, page_id, media_box));
    }

    for (_page_number, page_id, media_box) in preflighted_pages {
        incremental.opt_clone_object_to_new_document(page_id)?;
        let page = incremental.new_document.get_dictionary_mut(page_id)?;
        set_page_crop_box_on_dictionary(page, media_box);
    }
    Ok(())
}

fn resolve_selected_page_ids(
    document: &impl PdfObjectSource,
    pages: &[u32],
) -> Result<Vec<(u32, ObjectId)>> {
    let mut selected = Vec::new();
    selected
        .try_reserve_exact(pages.len())
        .map_err(|_| "Too many pages selected for crop")?;
    if pages.is_empty() {
        return Ok(selected);
    }

    let page_resolver = PageTreeResolver::new(document)?;
    for &page_number in pages {
        let page_id = page_resolver.page_id(document, page_number)?;
        selected.push((page_number, page_id));
    }
    Ok(selected)
}

pub(crate) fn resolve_page_id(
    page_map: &std::collections::BTreeMap<u32, ObjectId>,
    page_number: u32,
) -> Result<ObjectId> {
    page_map.get(&page_number).copied().ok_or_else(|| {
        format!(
            "Page {page_number} is outside the document page range 1-{}",
            page_map.len()
        )
        .into()
    })
}

pub(crate) fn resolve_inherited_box(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
    key: &[u8],
) -> Result<PdfRect> {
    let mut current_id = Some(page_id);
    let mut seen = HashSet::new();

    while let Some(object_id) = current_id {
        if !seen.insert(object_id) {
            return Err(format!(
                "Page tree cycle while resolving {}",
                String::from_utf8_lossy(key)
            )
            .into());
        }

        let dict = document.dictionary(object_id)?;
        if let Ok(object) = dict.get(key) {
            let resolved = document.resolved(object)?;
            return parse_rect(resolved);
        }

        current_id = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }

    Err(format!("Missing inherited {}", String::from_utf8_lossy(key)).into())
}

pub(crate) fn parse_rect(object: &Object) -> Result<PdfRect> {
    let values = object.as_array()?;
    if values.len() != 4 {
        return Err("PDF rectangle must contain 4 values".into());
    }

    let rect = PdfRect {
        x1: object_to_f64(&values[0])?,
        y1: object_to_f64(&values[1])?,
        x2: object_to_f64(&values[2])?,
        y2: object_to_f64(&values[3])?,
    };
    if !rect.width().is_finite()
        || !rect.height().is_finite()
        || rect.width() <= 0.0
        || rect.height() <= 0.0
    {
        return Err("Invalid PDF rectangle dimensions".into());
    }
    Ok(rect)
}

pub(crate) fn object_to_f64(object: &Object) -> Result<f64> {
    let value = object.as_float()? as f64;
    if !value.is_finite() {
        return Err("PDF rectangle contains a non-finite value".into());
    }
    Ok(value)
}

pub(crate) fn set_page_crop_box_on_dictionary(page: &mut Dictionary, rect: PdfRect) {
    page.set(
        "CropBox",
        Object::Array(vec![
            number_object(rect.x1),
            number_object(rect.y1),
            number_object(rect.x2),
            number_object(rect.y2),
        ]),
    );
}

pub(crate) fn number_object(value: f64) -> Object {
    let rounded = value.round();
    if (value - rounded).abs() < 0.000_001
        && rounded >= i64::MIN as f64
        && rounded <= i64::MAX as f64
    {
        Object::Integer(rounded as i64)
    } else {
        let real = value as f32;
        assert!(real.is_finite(), "PDF real number exceeds f32");
        Object::Real(real)
    }
}
