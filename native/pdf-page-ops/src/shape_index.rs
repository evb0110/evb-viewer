use super::*;
use evb_native_support::output::AtomicOutput;
use serde::Serialize;
use std::{collections::HashSet, fs, io::Write, path::Path};

const EMBEDDED_SHAPE_INDEX_FORMAT: &str = "evb-pdf-embedded-shape-index";
const EMBEDDED_SHAPE_INDEX_SCHEMA_VERSION: u64 = 1;
const EMBEDDED_SHAPE_INDEX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_SHAPE_ARRAY_VALUES: usize = 40_000;
const MAX_SHAPE_POINTS: usize = 100_000;
const MAX_SHAPE_STROKES: usize = 4_096;
const MAX_SHAPE_DIAGNOSTICS: usize = 100_000;

/// One point in the page's normalized marker coordinate space.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedShapeIndexPoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

/// The structural fields needed to rebuild an `IPdfNativeShapeAnnotation`.
///
/// Object and generation numbers are deliberately kept beside the managed
/// key. A PDF can contain perfectly valid shapes with no stable key, and the
/// object reference is the only deterministic identity those shapes have.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedShapeIndexEntry {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) stable_key: Option<String>,
    #[serde(rename = "pdfSubtype")]
    pub(crate) pdf_subtype: String,
    #[serde(rename = "type")]
    pub(crate) shape_type: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) x2: Option<f64>,
    pub(crate) y2: Option<f64>,
    pub(crate) color: String,
    pub(crate) fill_color: Option<String>,
    pub(crate) opacity: f64,
    pub(crate) stroke_width: f64,
    pub(crate) points: Option<Vec<EmbeddedShapeIndexPoint>>,
    pub(crate) strokes: Option<Vec<Vec<EmbeddedShapeIndexPoint>>>,
    pub(crate) line_start_style: Option<String>,
    pub(crate) line_end_style: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EmbeddedShapeIndexDiagnostic {
    pub(crate) page_index: u64,
    pub(crate) object_number: Option<u64>,
    pub(crate) generation_number: Option<u64>,
    pub(crate) subtype: Option<String>,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct EmbeddedShapeIndexScan {
    pub(crate) entry_count: u64,
    pub(crate) diagnostics: Vec<EmbeddedShapeIndexDiagnostic>,
}

#[cfg(test)]
#[derive(Clone, Debug, Default)]
pub(crate) struct EmbeddedShapeIndexCollection {
    pub(crate) page_count: u64,
    pub(crate) entries: Vec<EmbeddedShapeIndexEntry>,
    pub(crate) diagnostics: Vec<EmbeddedShapeIndexDiagnostic>,
}

/// Visit every supported embedded shape without reading page streams or
/// materializing the PDF input. The callback is called in page/annotation
/// order, the same order as the PDF.js importer.
pub(crate) fn scan_embedded_shape_index<F>(
    document: &impl PdfObjectSource,
    mut on_entry: F,
) -> Result<EmbeddedShapeIndexScan>
where
    F: FnMut(EmbeddedShapeIndexEntry) -> Result<()>,
{
    let page_ids = document.page_ids();
    let mut scan = EmbeddedShapeIndexScan::default();

    for (page_number, page_id) in page_ids {
        let page_index = u64::from(
            page_number
                .checked_sub(1)
                .ok_or("PDF page numbering must start at one")?,
        );

        let page_view = match resolve_page_view(document, page_id) {
            Ok(page_view) => page_view,
            Err(error) => {
                push_shape_index_diagnostic(
                    &mut scan,
                    page_index,
                    Some(page_id),
                    None,
                    format!("Cannot resolve page view: {error}"),
                );
                continue;
            }
        };
        let page_rotation = match resolve_page_rotation(document, page_id) {
            Ok(page_rotation) => page_rotation,
            Err(error) => {
                push_shape_index_diagnostic(
                    &mut scan,
                    page_index,
                    Some(page_id),
                    None,
                    format!("Cannot resolve page rotation: {error}"),
                );
                continue;
            }
        };
        let annots = match get_page_annots(document, page_id) {
            Ok(annots) => annots,
            Err(error) => {
                push_shape_index_diagnostic(
                    &mut scan,
                    page_index,
                    Some(page_id),
                    None,
                    format!("Cannot read page annotations: {error}"),
                );
                continue;
            }
        };

        for annot_ref in annots {
            let Some(object_id) = annot_ref.as_reference().ok() else {
                // PDF.js only visits annotation references. Inline
                // dictionaries and other malformed entries are ignored.
                continue;
            };
            let dict = match document.dictionary(object_id) {
                Ok(dict) => dict,
                Err(error) => {
                    push_shape_index_diagnostic(
                        &mut scan,
                        page_index,
                        Some(object_id),
                        None,
                        format!("Cannot read annotation dictionary: {error}"),
                    );
                    continue;
                }
            };
            let Some(raw_subtype) = raw_subtype_name(dict) else {
                continue;
            };
            let Some(subtype) = supported_shape_subtype(&raw_subtype) else {
                continue;
            };

            match parse_shape_index_entry(
                document,
                dict,
                page_index,
                object_id,
                subtype,
                page_view,
                page_rotation,
            ) {
                Ok(entry) => {
                    on_entry(entry)?;
                    scan.entry_count = scan
                        .entry_count
                        .checked_add(1)
                        .ok_or("Embedded shape index entry count overflow")?;
                }
                Err(reason) => push_shape_index_diagnostic(
                    &mut scan,
                    page_index,
                    Some(object_id),
                    Some(subtype.to_string()),
                    reason,
                ),
            }
        }
    }

    Ok(scan)
}

#[derive(Clone, Debug, Default)]
pub(crate) struct EmbeddedShapeDeleteLookup {
    pub(crate) object_ids: HashSet<ObjectId>,
    pub(crate) page_ids: HashSet<ObjectId>,
}

/// Find existing managed shape objects for stable-key deletes without walking
/// the page tree. The structural loader retains every indirect object, so a
/// single ordered object scan can stop as soon as all requested keys resolve.
pub(crate) fn lookup_embedded_shape_delete_targets(
    document: &Document,
    stable_keys: &HashSet<String>,
) -> EmbeddedShapeDeleteLookup {
    lookup_embedded_shape_delete_targets_inner(document, stable_keys).0
}

fn lookup_embedded_shape_delete_targets_inner(
    document: &Document,
    stable_keys: &HashSet<String>,
) -> (EmbeddedShapeDeleteLookup, usize) {
    let mut lookup = EmbeddedShapeDeleteLookup::default();
    if stable_keys.is_empty() {
        return (lookup, 0);
    }

    let mut pending = stable_keys.clone();
    let mut scanned_objects = 0;
    for (object_id, object) in &document.objects {
        if pending.is_empty() {
            break;
        }
        scanned_objects += 1;
        let Ok(dict) = object.as_dict() else {
            continue;
        };
        let Some(raw_subtype) = raw_subtype_name(dict) else {
            continue;
        };
        if supported_shape_subtype(&raw_subtype).is_none() {
            continue;
        }
        let Some(stable_key) = read_shape_stable_key(dict) else {
            continue;
        };
        if !pending.remove(&stable_key) {
            continue;
        }
        lookup.object_ids.insert(*object_id);
        if let Some(page_id) = shape_annotation_page_id(document, *object_id) {
            lookup.page_ids.insert(page_id);
        }
    }
    (lookup, scanned_objects)
}

#[cfg(test)]
fn lookup_embedded_shape_delete_targets_with_scan_count(
    document: &Document,
    stable_keys: &HashSet<String>,
) -> (EmbeddedShapeDeleteLookup, usize) {
    lookup_embedded_shape_delete_targets_inner(document, stable_keys)
}

#[cfg(test)]
pub(crate) fn collect_embedded_shape_index(
    document: &impl PdfObjectSource,
) -> Result<EmbeddedShapeIndexCollection> {
    let page_count = u64::try_from(document.page_ids().len())?;
    let mut entries = Vec::new();
    let scan = scan_embedded_shape_index(document, |entry| {
        entries.push(entry);
        Ok(())
    })?;
    Ok(EmbeddedShapeIndexCollection {
        page_count,
        entries,
        diagnostics: scan.diagnostics,
    })
}

/// Write a bounded JSONL sidecar from an already selected structural source.
/// The caller owns source loading and can therefore use the qpdf stream-free
/// loader for large PDFs.
pub(crate) fn write_embedded_shape_index(
    document: &impl PdfObjectSource,
    output_path: &Path,
) -> Result<()> {
    write_embedded_shape_index_with_chunk_limit(
        document,
        output_path,
        EMBEDDED_SHAPE_INDEX_CHUNK_BYTES,
    )
    .map(|_| ())
}

/// Load a path through the stream-free structural reader when the normal
/// in-memory admission ceiling is exceeded, then write the shape sidecar.
pub(crate) fn write_embedded_shape_index_path(
    input_path: &Path,
    output_path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    if shape_index_paths_alias(input_path, output_path)? {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Embedded shape index output must not alias the PDF input",
        ));
    }

    let incremental = load_annotation_index_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by the embedded shape index operation",
    )?;

    write_embedded_shape_index(&AppendedRevision::new(&incremental), output_path)
}

fn shape_index_paths_alias(input_path: &Path, output_path: &Path) -> Result<bool> {
    if input_path == output_path {
        return Ok(true);
    }

    let input_path = fs::canonicalize(input_path).map_err(|error| {
        domain_error(
            NativeErrorCode::Io,
            format!("Failed to resolve PDF input path: {error}"),
        )
    })?;
    let output_path = match fs::canonicalize(output_path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(domain_error(
                NativeErrorCode::Io,
                format!("Failed to resolve embedded shape index output path: {error}"),
            ))
        }
    };
    Ok(input_path == output_path)
}

fn write_embedded_shape_index_with_chunk_limit(
    document: &impl PdfObjectSource,
    output_path: &Path,
    chunk_limit: usize,
) -> Result<EmbeddedShapeIndexScan> {
    let page_count = u64::try_from(document.page_ids().len())?;
    let mut writer = EmbeddedShapeIndexWriter::new(output_path, page_count, chunk_limit)?;
    let scan = scan_embedded_shape_index(document, |entry| writer.push(entry))?;
    writer.finish()?;
    Ok(scan)
}

fn push_shape_index_diagnostic(
    scan: &mut EmbeddedShapeIndexScan,
    page_index: u64,
    object_id: Option<ObjectId>,
    subtype: Option<String>,
    reason: String,
) {
    if scan.diagnostics.len() >= MAX_SHAPE_DIAGNOSTICS {
        return;
    }
    scan.diagnostics.push(EmbeddedShapeIndexDiagnostic {
        page_index,
        object_number: object_id.map(|object_id| u64::from(object_id.0)),
        generation_number: object_id.map(|object_id| u64::from(object_id.1)),
        subtype,
        reason,
    });
}

fn raw_subtype_name(dict: &Dictionary) -> Option<String> {
    dict.get(b"Subtype")
        .ok()
        .and_then(|object| object.as_name().ok())
        .map(|name| String::from_utf8_lossy(name).into_owned())
}

fn supported_shape_subtype(subtype: &str) -> Option<&'static str> {
    match subtype {
        "Square" => Some("Square"),
        "Circle" => Some("Circle"),
        "Line" => Some("Line"),
        "PolyLine" => Some("PolyLine"),
        "Polygon" => Some("Polygon"),
        "Ink" => Some("Ink"),
        _ => None,
    }
}

pub(crate) fn parse_shape_index_entry(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    page_index: u64,
    object_id: ObjectId,
    subtype: &str,
    page_view: PdfRect,
    page_rotation: i64,
) -> std::result::Result<EmbeddedShapeIndexEntry, String> {
    match subtype {
        "Square" | "Circle" => parse_rect_shape(
            document,
            dict,
            page_index,
            object_id,
            subtype,
            page_view,
            page_rotation,
        ),
        "Line" => parse_line_shape(
            document,
            dict,
            page_index,
            object_id,
            page_view,
            page_rotation,
        ),
        "PolyLine" | "Polygon" => parse_vertices_shape(
            document,
            dict,
            page_index,
            object_id,
            subtype,
            page_view,
            page_rotation,
        ),
        "Ink" => parse_ink_shape(
            document,
            dict,
            page_index,
            object_id,
            page_view,
            page_rotation,
        ),
        _ => Err("Unsupported embedded shape subtype".to_string()),
    }
}

fn parse_rect_shape(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    page_index: u64,
    object_id: ObjectId,
    subtype: &str,
    page_view: PdfRect,
    page_rotation: i64,
) -> std::result::Result<EmbeddedShapeIndexEntry, String> {
    let rect =
        read_shape_rect(document, dict).ok_or_else(|| "Missing or malformed /Rect".to_string())?;
    let marker_rect = marker_rect_from_pdf_rect(rect, page_view, page_rotation)
        .ok_or_else(|| "Cannot project /Rect into marker coordinates".to_string())?;
    let common = read_common_shape_fields(document, dict, true, false);
    Ok(EmbeddedShapeIndexEntry {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        stable_key: read_shape_stable_key(dict),
        pdf_subtype: subtype.to_string(),
        shape_type: if subtype == "Square" {
            "rectangle".to_string()
        } else {
            "circle".to_string()
        },
        x: marker_rect.left,
        y: marker_rect.top,
        width: marker_rect.width,
        height: marker_rect.height,
        x2: None,
        y2: None,
        color: common.color,
        fill_color: common.fill_color,
        opacity: common.opacity,
        stroke_width: common.stroke_width,
        points: None,
        strokes: None,
        line_start_style: common.line_start_style,
        line_end_style: common.line_end_style,
        created_at: common.created_at,
        modified_at: common.modified_at,
    })
}

fn parse_line_shape(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    page_index: u64,
    object_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
) -> std::result::Result<EmbeddedShapeIndexEntry, String> {
    let values = read_shape_number_array(document, dict, b"L")
        .ok_or_else(|| "Missing or malformed /L".to_string())?;
    if values.len() < 4 {
        return Err("/L must contain at least four numbers".to_string());
    }
    let start = marker_point_from_pdf_point(values[0], values[1], page_view, page_rotation);
    let end = marker_point_from_pdf_point(values[2], values[3], page_view, page_rotation);
    if !point_is_finite(start) || !point_is_finite(end) {
        return Err("/L contains non-finite coordinates".to_string());
    }

    let common = read_common_shape_fields(document, dict, false, true);
    let shape_type = if common.line_start_style.as_deref().unwrap_or("none") == "none"
        && common.line_end_style.as_deref().unwrap_or("none") == "none"
    {
        "line"
    } else {
        "arrow"
    };
    Ok(EmbeddedShapeIndexEntry {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        stable_key: read_shape_stable_key(dict),
        pdf_subtype: "Line".to_string(),
        shape_type: shape_type.to_string(),
        x: start.0,
        y: start.1,
        width: (end.0 - start.0).abs(),
        height: (end.1 - start.1).abs(),
        x2: Some(end.0),
        y2: Some(end.1),
        color: common.color,
        fill_color: None,
        opacity: common.opacity,
        stroke_width: common.stroke_width,
        points: None,
        strokes: None,
        line_start_style: common.line_start_style,
        line_end_style: common.line_end_style,
        created_at: common.created_at,
        modified_at: common.modified_at,
    })
}

fn parse_vertices_shape(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    page_index: u64,
    object_id: ObjectId,
    subtype: &str,
    page_view: PdfRect,
    page_rotation: i64,
) -> std::result::Result<EmbeddedShapeIndexEntry, String> {
    let values = read_shape_number_array(document, dict, b"Vertices")
        .ok_or_else(|| "Missing or malformed /Vertices".to_string())?;
    if values.len() < 4 || values.len() % 2 != 0 {
        return Err("/Vertices must contain at least two complete points".to_string());
    }
    let points = marker_points_from_pdf_numbers(&values, page_view, page_rotation)?;
    if points.len() < 2 {
        return Err("/Vertices must contain at least two complete points".to_string());
    }
    let (x, y, width, height) = points_bounds(&points)?;
    let common = read_common_shape_fields(document, dict, subtype == "Polygon", true);
    Ok(EmbeddedShapeIndexEntry {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        stable_key: read_shape_stable_key(dict),
        pdf_subtype: subtype.to_string(),
        shape_type: if subtype == "Polygon" {
            "polygon".to_string()
        } else {
            "polyline".to_string()
        },
        x,
        y,
        width,
        height,
        x2: None,
        y2: None,
        color: common.color,
        fill_color: common.fill_color,
        opacity: common.opacity,
        stroke_width: common.stroke_width,
        points: Some(points),
        strokes: None,
        line_start_style: common.line_start_style,
        line_end_style: common.line_end_style,
        created_at: common.created_at,
        modified_at: common.modified_at,
    })
}

fn parse_ink_shape(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    page_index: u64,
    object_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
) -> std::result::Result<EmbeddedShapeIndexEntry, String> {
    let stable_key = read_shape_stable_key(dict)
        .ok_or_else(|| "Ink shape is missing an EVBShapeKey or managed /NM".to_string())?;
    let ink_list = resolved_array_for_key(document, dict, b"InkList")
        .ok_or_else(|| "Missing or malformed /InkList".to_string())?;
    if ink_list.is_empty() {
        return Err("/InkList is empty".to_string());
    }
    if ink_list.len() > MAX_SHAPE_STROKES {
        return Err("/InkList contains too many strokes".to_string());
    }

    let mut strokes = Vec::new();
    let mut point_count = 0_usize;
    for stroke_object in ink_list {
        let Some(stroke_values) = resolved_array(document, stroke_object) else {
            continue;
        };
        if stroke_values.len() < 4 || stroke_values.len() % 2 != 0 {
            continue;
        }
        let Some(values) = resolved_numbers(document, stroke_values) else {
            continue;
        };
        let Ok(points) = marker_points_from_pdf_numbers(&values, page_view, page_rotation) else {
            continue;
        };
        if points.len() >= 2 {
            point_count = point_count
                .checked_add(points.len())
                .ok_or_else(|| "Ink shape contains too many points".to_string())?;
            if point_count > MAX_SHAPE_POINTS {
                return Err("Ink shape contains too many points".to_string());
            }
            strokes.push(points);
        }
    }
    if strokes.is_empty() {
        return Err("/InkList has no drawable strokes".to_string());
    }
    let all_points = strokes.iter().flatten().cloned().collect::<Vec<_>>();
    let (x, y, width, height) = points_bounds(&all_points)?;
    let common = read_common_shape_fields(document, dict, false, false);
    Ok(EmbeddedShapeIndexEntry {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        stable_key: Some(stable_key),
        pdf_subtype: "Ink".to_string(),
        shape_type: "polyline".to_string(),
        x,
        y,
        width,
        height,
        x2: None,
        y2: None,
        color: common.color,
        fill_color: None,
        opacity: common.opacity,
        stroke_width: common.stroke_width,
        points: Some(strokes[0].clone()),
        strokes: Some(strokes),
        line_start_style: None,
        line_end_style: None,
        created_at: common.created_at,
        modified_at: common.modified_at,
    })
}

#[derive(Default)]
struct CommonShapeFields {
    color: String,
    fill_color: Option<String>,
    opacity: f64,
    stroke_width: f64,
    line_start_style: Option<String>,
    line_end_style: Option<String>,
    created_at: Option<i64>,
    modified_at: Option<i64>,
}

fn read_common_shape_fields(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    include_fill: bool,
    include_line_endings: bool,
) -> CommonShapeFields {
    let fill_color = if include_fill {
        let color = pdf_color_to_hex(read_shape_color(document, dict, b"IC").as_deref(), "");
        (!color.is_empty()).then_some(color)
    } else {
        None
    };
    let (line_start_style, line_end_style) = if include_line_endings {
        read_line_ending_styles(document, dict)
    } else {
        (None, None)
    };
    let (created_at, modified_at) = read_shape_dates(dict);
    CommonShapeFields {
        color: pdf_color_to_hex(read_shape_color(document, dict, b"C").as_deref(), "#ff0000"),
        fill_color,
        opacity: read_shape_opacity(document, dict),
        stroke_width: read_shape_stroke_width(document, dict),
        line_start_style,
        line_end_style,
        created_at,
        modified_at,
    }
}

fn read_shape_rect(document: &impl PdfObjectSource, dict: &Dictionary) -> Option<PdfRect> {
    let values = read_shape_number_array(document, dict, b"Rect")?;
    if values.len() < 4 {
        return None;
    }
    Some(PdfRect {
        x1: values[0],
        y1: values[1],
        x2: values[2],
        y2: values[3],
    })
}

fn read_shape_number_array(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> Option<Vec<f64>> {
    let values = resolved_array_for_key(document, dict, key)?;
    resolved_numbers(document, values)
}

fn resolved_array_for_key<'a>(
    document: &'a impl PdfObjectSource,
    dict: &'a Dictionary,
    key: &[u8],
) -> Option<&'a [Object]> {
    let object = dict.get(key).ok()?;
    resolved_array(document, object)
}

fn resolved_array<'a>(
    document: &'a impl PdfObjectSource,
    object: &'a Object,
) -> Option<&'a [Object]> {
    document
        .resolved(object)
        .ok()?
        .as_array()
        .ok()
        .map(Vec::as_slice)
}

fn resolved_numbers(document: &impl PdfObjectSource, values: &[Object]) -> Option<Vec<f64>> {
    if values.len() > MAX_SHAPE_ARRAY_VALUES {
        return None;
    }
    let mut numbers = Vec::new();
    numbers.try_reserve(values.len()).ok()?;
    for value in values {
        let resolved = document.resolved(value).ok()?;
        let number = object_to_f64(resolved).ok()?;
        if !number.is_finite() {
            return None;
        }
        numbers.push(number);
    }
    Some(numbers)
}

fn marker_points_from_pdf_numbers(
    values: &[f64],
    page_view: PdfRect,
    page_rotation: i64,
) -> std::result::Result<Vec<EmbeddedShapeIndexPoint>, String> {
    if values.len() % 2 != 0 {
        return Err("Point array contains an incomplete coordinate pair".to_string());
    }
    let point_count = values.len() / 2;
    if point_count > MAX_SHAPE_ARRAY_VALUES / 2 {
        return Err("Point array contains too many points".to_string());
    }
    let mut points = Vec::new();
    points
        .try_reserve(point_count)
        .map_err(|_| "Point array is too large")?;
    for pair in values.chunks_exact(2) {
        let point = marker_point_from_pdf_point(pair[0], pair[1], page_view, page_rotation);
        if !point_is_finite(point) {
            return Err("Point array contains non-finite coordinates".to_string());
        }
        points.push(EmbeddedShapeIndexPoint {
            x: point.0,
            y: point.1,
        });
    }
    Ok(points)
}

fn point_is_finite(point: (f64, f64)) -> bool {
    point.0.is_finite() && point.1.is_finite()
}

fn points_bounds(
    points: &[EmbeddedShapeIndexPoint],
) -> std::result::Result<(f64, f64, f64, f64), String> {
    let first = points
        .first()
        .ok_or_else(|| "Shape contains no points".to_string())?;
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (first.x, first.y, first.x, first.y);
    for point in &points[1..] {
        if !point_is_finite((point.x, point.y)) {
            return Err("Shape contains non-finite points".to_string());
        }
        min_x = min_x.min(point.x);
        min_y = min_y.min(point.y);
        max_x = max_x.max(point.x);
        max_y = max_y.max(point.y);
    }
    Ok((
        min_x,
        min_y,
        (max_x - min_x).max(0.0001),
        (max_y - min_y).max(0.0001),
    ))
}

fn read_shape_color(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> Option<Vec<f64>> {
    read_shape_number_array(document, dict, key)
}

pub(crate) fn pdf_color_to_hex(color: Option<&[f64]>, fallback: &str) -> String {
    let Some(color) = color else {
        return fallback.to_string();
    };
    if color.iter().any(|value| !value.is_finite()) {
        return fallback.to_string();
    }
    let channels = match color.len() {
        1 => {
            let gray = normalized_color_component(color[0]) * 255.0;
            [gray, gray, gray]
        }
        3 => [
            normalized_color_component(color[0]) * 255.0,
            normalized_color_component(color[1]) * 255.0,
            normalized_color_component(color[2]) * 255.0,
        ],
        4 => {
            let cyan = normalized_color_component(color[0]);
            let magenta = normalized_color_component(color[1]);
            let yellow = normalized_color_component(color[2]);
            let black = normalized_color_component(color[3]);
            [
                (1.0 - cyan.min(1.0) - black).max(0.0) * 255.0,
                (1.0 - magenta.min(1.0) - black).max(0.0) * 255.0,
                (1.0 - yellow.min(1.0) - black).max(0.0) * 255.0,
            ]
        }
        _ => return fallback.to_string(),
    };
    format!(
        "#{:02x}{:02x}{:02x}",
        channels[0].round().clamp(0.0, 255.0) as u8,
        channels[1].round().clamp(0.0, 255.0) as u8,
        channels[2].round().clamp(0.0, 255.0) as u8,
    )
}

fn normalized_color_component(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

pub(crate) fn read_shape_opacity(document: &impl PdfObjectSource, dict: &Dictionary) -> f64 {
    dict.get(b"CA")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object_to_f64(object).ok())
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0))
        .unwrap_or(1.0)
}

fn read_shape_stroke_width(document: &impl PdfObjectSource, dict: &Dictionary) -> f64 {
    if let Some(border) = resolved_array_for_key(document, dict, b"Border") {
        if border.len() >= 3 {
            if let Some(width) = resolved_number(document, &border[2]).filter(|value| *value >= 0.0)
            {
                return width;
            }
        }
    }
    if let Some(border_style) = dict
        .get(b"BS")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_dict().ok())
    {
        if let Some(width) = border_style
            .get(b"W")
            .ok()
            .and_then(|object| document.resolved(object).ok())
            .and_then(|object| object_to_f64(object).ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
        {
            return width;
        }
    }
    1.0
}

fn resolved_number(document: &impl PdfObjectSource, object: &Object) -> Option<f64> {
    let resolved = document.resolved(object).ok()?;
    let value = object_to_f64(resolved).ok()?;
    value.is_finite().then_some(value)
}

fn read_line_ending_styles(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> (Option<String>, Option<String>) {
    let Some(line_endings) = resolved_array_for_key(document, dict, b"LE") else {
        return (None, None);
    };
    (
        line_ending_style(document, line_endings.first()),
        line_ending_style(document, line_endings.get(1)),
    )
}

fn line_ending_style(document: &impl PdfObjectSource, object: Option<&Object>) -> Option<String> {
    let object = object?;
    let value = document
        .resolved(object)
        .ok()?
        .as_name()
        .ok()
        .map(String::from_utf8_lossy)?;
    match value
        .strip_prefix('/')
        .unwrap_or(&value)
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "openarrow" => Some("openArrow".to_string()),
        "closedarrow" => Some("closedArrow".to_string()),
        "none" | "" => Some("none".to_string()),
        _ => None,
    }
}

fn read_shape_dates(dict: &Dictionary) -> (Option<i64>, Option<i64>) {
    let created = dict
        .get(b"CreationDate")
        .ok()
        .and_then(pdf_string_to_text)
        .and_then(|value| parse_pdf_date_timestamp(&value));
    let modified = dict
        .get(b"M")
        .ok()
        .and_then(pdf_string_to_text)
        .and_then(|value| parse_pdf_date_timestamp(&value))
        .or(created);
    (created.or(modified), modified)
}

pub(crate) fn parse_pdf_date_timestamp(value: &str) -> Option<i64> {
    let normalized = value.trim();
    let body = normalized
        .strip_prefix('D')?
        .strip_prefix(':')
        .unwrap_or_else(|| {
            // The PDF grammar permits the colon after D to be omitted.
            normalized.strip_prefix('D').unwrap_or_default()
        });
    let bytes = body.as_bytes();
    if bytes.len() < 4 || !bytes[..4].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let year = parse_date_digits(&bytes[0..4])?;
    let (month, mut position) = parse_optional_date_part(bytes, 4, 2, 1);
    let (day, next_position) = parse_optional_date_part(bytes, position, 2, 1);
    position = next_position;
    let (hours, next_position) = parse_optional_date_part(bytes, position, 2, 0);
    position = next_position;
    let (minutes, next_position) = parse_optional_date_part(bytes, position, 2, 0);
    position = next_position;
    let (seconds, next_position) = parse_optional_date_part(bytes, position, 2, 0);
    position = next_position;

    let normalized_year = if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    let days = days_from_civil(normalized_year, month, day)?;
    let local_seconds = days
        .checked_mul(86_400)?
        .checked_add(hours.checked_mul(3_600)?)?
        .checked_add(minutes.checked_mul(60)?)?
        .checked_add(seconds)?;
    let offset_minutes = parse_date_timezone(&bytes[position..]).unwrap_or(0);
    local_seconds
        .checked_sub(offset_minutes.checked_mul(60)?)?
        .checked_mul(1_000)
}

fn parse_optional_date_part(
    bytes: &[u8],
    position: usize,
    width: usize,
    fallback: i64,
) -> (i64, usize) {
    if bytes.len() >= position + width
        && bytes[position..position + width]
            .iter()
            .all(u8::is_ascii_digit)
    {
        (
            parse_date_digits(&bytes[position..position + width]).unwrap_or(fallback),
            position + width,
        )
    } else {
        (fallback, position)
    }
}

fn parse_date_digits(bytes: &[u8]) -> Option<i64> {
    bytes.iter().try_fold(0_i64, |value, digit| {
        value
            .checked_mul(10)?
            .checked_add(i64::from(digit.saturating_sub(b'0')))
    })
}

fn parse_date_timezone(bytes: &[u8]) -> Option<i64> {
    match bytes.first().copied()? {
        b'Z' | b'z' => Some(0),
        b'+' | b'-' => {
            if bytes.len() < 5 {
                return None;
            }
            let hours = parse_date_digits(&bytes[1..3])?;
            let minute_start = if bytes.get(3) == Some(&b'\'') { 4 } else { 3 };
            if bytes.len() < minute_start + 2 {
                return None;
            }
            let minutes = parse_date_digits(&bytes[minute_start..minute_start + 2])?;
            let offset = hours.checked_mul(60)?.checked_add(minutes)?;
            Some(if bytes[0] == b'+' { offset } else { -offset })
        }
        _ => None,
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let normalized_year = year.checked_add((month - 1).div_euclid(12))?;
    let normalized_month = (month - 1).rem_euclid(12) + 1;
    let adjusted_year = normalized_year - i64::from(normalized_month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year / 400
    } else {
        (adjusted_year - 399) / 400
    };
    let year_of_era = adjusted_year - era * 400;
    let month_index = normalized_month + if normalized_month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era.checked_mul(146_097)?
        .checked_add(day_of_era)?
        .checked_sub(719_468)
}

struct EmbeddedShapeIndexWriter {
    output: AtomicOutput,
    chunk_limit: usize,
    chunk: EmbeddedShapeIndexChunk,
    next_chunk_index: u64,
    total_bytes: u64,
}

impl EmbeddedShapeIndexWriter {
    fn new(output_path: &Path, page_count: u64, chunk_limit: usize) -> Result<Self> {
        if !(64..=EMBEDDED_SHAPE_INDEX_CHUNK_BYTES).contains(&chunk_limit) {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Embedded shape index chunk limit must fit its JSON envelope and stay within 4 MiB",
            ));
        }
        let output = AtomicOutput::create(output_path)?;
        #[cfg(unix)]
        output
            .file()?
            .set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        let mut writer = Self {
            output,
            chunk_limit,
            chunk: EmbeddedShapeIndexChunk::new(0),
            next_chunk_index: 0,
            total_bytes: 0,
        };
        let header = format!(
            "{{\"format\":\"{EMBEDDED_SHAPE_INDEX_FORMAT}\",\"schemaVersion\":{EMBEDDED_SHAPE_INDEX_SCHEMA_VERSION},\"pageCount\":{page_count},\"chunkBytes\":{chunk_limit}}}\n"
        );
        writer.write_bounded(header.as_bytes())?;
        Ok(writer)
    }

    fn push(&mut self, entry: EmbeddedShapeIndexEntry) -> Result<()> {
        let encoded_entry = serde_json::to_vec(&entry)?;
        if !self.chunk.try_push(&encoded_entry, self.chunk_limit) {
            if self.chunk.entry_count == 0 {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Embedded shape index entry exceeds the 4 MiB chunk limit",
                ));
            }
            self.flush_chunk()?;
            if !self.chunk.try_push(&encoded_entry, self.chunk_limit) {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Embedded shape index entry exceeds the 4 MiB chunk limit",
                ));
            }
        }
        Ok(())
    }

    fn flush_chunk(&mut self) -> Result<()> {
        if self.chunk.entry_count == 0 {
            return Ok(());
        }
        let chunk = std::mem::replace(
            &mut self.chunk,
            EmbeddedShapeIndexChunk::new(self.next_chunk_index),
        )
        .finish();
        self.write_bounded(&chunk)?;
        self.next_chunk_index = self
            .next_chunk_index
            .checked_add(1)
            .ok_or("Embedded shape index chunk number overflow")?;
        self.chunk = EmbeddedShapeIndexChunk::new(self.next_chunk_index);
        Ok(())
    }

    fn write_bounded(&mut self, bytes: &[u8]) -> Result<()> {
        let next_total = self
            .total_bytes
            .checked_add(u64::try_from(bytes.len())?)
            .ok_or("Embedded shape index sidecar byte count overflow")?;
        if next_total > u64::try_from(MAX_SIDECAR_BYTES)? {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Embedded shape index exceeds the sidecar byte limit",
            ));
        }
        self.output.file_mut()?.write_all(bytes)?;
        self.total_bytes = next_total;
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        self.flush_chunk()?;
        self.output.publish()?;
        Ok(())
    }
}

struct EmbeddedShapeIndexChunk {
    bytes: Vec<u8>,
    entry_count: usize,
}

impl EmbeddedShapeIndexChunk {
    fn new(index: u64) -> Self {
        Self {
            bytes: format!("{{\"chunkIndex\":{index},\"entries\":[").into_bytes(),
            entry_count: 0,
        }
    }

    fn try_push(&mut self, entry: &[u8], chunk_limit: usize) -> bool {
        let separator_bytes = usize::from(self.entry_count > 0);
        let Some(candidate_len) = self
            .bytes
            .len()
            .checked_add(separator_bytes)
            .and_then(|length| length.checked_add(entry.len()))
            .and_then(|length| length.checked_add(3))
        else {
            return false;
        };
        if candidate_len > chunk_limit {
            return false;
        }
        if separator_bytes != 0 {
            self.bytes.push(b',');
        }
        self.bytes.extend_from_slice(entry);
        self.entry_count += 1;
        true
    }

    fn finish(mut self) -> Vec<u8> {
        self.bytes.extend_from_slice(b"]}\n");
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object, ObjectId, Stream};
    use serde_json::Value;
    use std::{
        collections::{BTreeMap, HashMap, HashSet},
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct SparsePdfObjectSource {
        objects: HashMap<ObjectId, Object>,
        pages: BTreeMap<u32, ObjectId>,
    }

    impl PdfObjectSource for SparsePdfObjectSource {
        fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
            self.objects.get(&object_id)
        }

        fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
            self.pages.clone()
        }

        fn root_id(&self) -> Result<ObjectId> {
            Err("test source has no catalog".into())
        }
    }

    fn temporary_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "evb-pdf-page-ops-shape-index-{label}-{nonce}.jsonl"
        ))
    }

    fn page_document(rotation: i64) -> (Document, ObjectId) {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            "Rotate" => rotation,
            "Annots" => Object::Array(Vec::new()),
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        (document, page_id)
    }

    fn set_page_annotations(document: &mut Document, page_id: ObjectId, annotations: &[ObjectId]) {
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            Object::Array(annotations.iter().copied().map(Object::Reference).collect()),
        );
    }

    fn read_sidecar(path: &PathBuf) -> Vec<Value> {
        String::from_utf8(fs::read(path).unwrap())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn entries(sidecar: &[Value]) -> Vec<&Value> {
        sidecar
            .iter()
            .skip(1)
            .flat_map(|chunk| chunk["entries"].as_array().unwrap())
            .collect()
    }

    fn shape_key(value: &str) -> Object {
        Object::string_literal(value)
    }

    fn number_array(values: &[f64]) -> Object {
        Object::Array(values.iter().copied().map(number_object).collect())
    }

    fn complete_shape_dict(subtype: &str, stable_key: Option<&str>) -> Dictionary {
        let mut dict = dictionary! {
            "Type" => "Annot",
            "Subtype" => subtype,
            "Rect" => number_array(&[20.0, 20.0, 80.0, 60.0]),
            "C" => number_array(&[1.0, 0.0, 0.0]),
            "IC" => number_array(&[0.0, 1.0, 0.0]),
            "CA" => number_object(0.5),
            "Border" => number_array(&[0.0, 0.0, 2.0]),
            "CreationDate" => Object::string_literal("D:20240102030405Z"),
            "M" => Object::string_literal("D:20240203040506+0200"),
        };
        if let Some(stable_key) = stable_key {
            dict.set("EVBShapeKey", shape_key(stable_key));
        }
        dict
    }

    #[test]
    fn indexes_all_six_shape_subtypes_and_native_fields() {
        let (mut document, page_id) = page_document(0);
        let square = document.add_object(Object::Dictionary(complete_shape_dict(
            "Square",
            Some("evb-shape:square"),
        )));
        let circle = document.add_object(Object::Dictionary(complete_shape_dict(
            "Circle",
            Some("evb-shape:circle"),
        )));
        let mut line = complete_shape_dict("Line", Some("evb-shape:line"));
        line.set("L", number_array(&[0.0, 0.0, 200.0, 100.0]));
        line.set(
            "LE",
            Object::Array(vec![
                Object::Name(b"OpenArrow".to_vec()),
                Object::Name(b"ClosedArrow".to_vec()),
            ]),
        );
        let line = document.add_object(Object::Dictionary(line));
        let mut polyline = complete_shape_dict("PolyLine", Some("evb-shape:polyline"));
        polyline.set(
            "Vertices",
            number_array(&[0.0, 0.0, 100.0, 50.0, 200.0, 0.0]),
        );
        let polyline = document.add_object(Object::Dictionary(polyline));
        let mut polygon = complete_shape_dict("Polygon", Some("evb-shape:polygon"));
        polygon.set(
            "Vertices",
            number_array(&[0.0, 0.0, 100.0, 50.0, 200.0, 0.0]),
        );
        let polygon = document.add_object(Object::Dictionary(polygon));
        let mut ink = complete_shape_dict("Ink", Some("evb-shape:ink"));
        ink.set(
            "InkList",
            Object::Array(vec![
                number_array(&[0.0, 0.0, 100.0, 50.0]),
                number_array(&[200.0, 0.0, 150.0, 50.0]),
            ]),
        );
        let ink = document.add_object(Object::Dictionary(ink));
        let annotation_ids = vec![square, circle, line, polyline, polygon, ink];
        set_page_annotations(&mut document, page_id, &annotation_ids);

        let collection = collect_embedded_shape_index(&document).unwrap();
        assert_eq!(collection.entries.len(), 6);
        assert!(collection.diagnostics.is_empty());
        assert_eq!(
            collection
                .entries
                .iter()
                .map(|entry| entry.pdf_subtype.as_str())
                .collect::<Vec<_>>(),
            vec!["Square", "Circle", "Line", "PolyLine", "Polygon", "Ink"]
        );
        assert_eq!(collection.entries[0].shape_type, "rectangle");
        assert_eq!(collection.entries[1].shape_type, "circle");
        assert_eq!(collection.entries[2].shape_type, "arrow");
        assert_eq!(
            collection.entries[2].line_start_style.as_deref(),
            Some("openArrow")
        );
        assert_eq!(
            collection.entries[2].line_end_style.as_deref(),
            Some("closedArrow")
        );
        assert_eq!(collection.entries[2].x2, Some(1.0));
        assert_eq!(collection.entries[3].shape_type, "polyline");
        assert_eq!(collection.entries[3].points.as_ref().unwrap().len(), 3);
        assert_eq!(collection.entries[4].shape_type, "polygon");
        assert_eq!(collection.entries[4].fill_color.as_deref(), Some("#00ff00"));
        assert_eq!(collection.entries[5].strokes.as_ref().unwrap().len(), 2);
        assert_eq!(collection.entries[0].color, "#ff0000");
        assert_eq!(collection.entries[0].opacity, 0.5);
        assert_eq!(collection.entries[0].stroke_width, 2.0);
        assert_eq!(collection.entries[0].created_at, Some(1_704_164_645_000));
        assert_eq!(collection.entries[0].modified_at, Some(1_706_925_906_000));
        assert_eq!(
            collection.entries[0].stable_key.as_deref(),
            Some("evb-shape:square")
        );

        // Ensure this remains a regular structural-only document. The scanner
        // never follows page contents or other stream-bearing objects.
        document.trailer.get(b"Root").unwrap();
    }

    #[test]
    fn resolves_indirect_arrays_and_numbers() {
        let (mut document, page_id) = page_document(0);
        let rect_numbers = [20.0, 20.0, 80.0, 60.0]
            .into_iter()
            .map(|value| document.add_object(number_object(value)))
            .collect::<Vec<_>>();
        let rect_array = document.add_object(Object::Array(
            rect_numbers
                .iter()
                .copied()
                .map(Object::Reference)
                .collect(),
        ));
        let color_array = document.add_object(number_array(&[0.0, 0.0, 1.0]));
        let border_array = document.add_object(number_array(&[0.0, 0.0, 3.0]));
        let annotation = document.add_object(dictionary! {
            "Subtype" => "Square",
            "Rect" => Object::Reference(rect_array),
            "EVBShapeKey" => shape_key("evb-shape:indirect"),
            "C" => Object::Reference(color_array),
            "Border" => Object::Reference(border_array),
        });
        set_page_annotations(&mut document, page_id, &[annotation]);

        let entries = collect_embedded_shape_index(&document).unwrap().entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].color, "#0000ff");
        assert_eq!(entries[0].stroke_width, 3.0);
        assert!((entries[0].width - 0.3).abs() < f64::EPSILON);
        assert!((entries[0].height - 0.4).abs() < f64::EPSILON);
    }

    #[test]
    fn preserves_pdf_to_marker_rotation_for_line_endpoints() {
        let expected = [
            (0, (0.0, 1.0, 1.0, 0.0)),
            (90, (0.0, 0.0, 1.0, 1.0)),
            (180, (1.0, 0.0, 0.0, 1.0)),
            (270, (1.0, 1.0, 0.0, 0.0)),
        ];
        for (rotation, (start_x, start_y, end_x, end_y)) in expected {
            let (mut document, page_id) = page_document(rotation);
            let mut annotation = complete_shape_dict("Line", Some("evb-shape:rotation"));
            annotation.set("L", number_array(&[0.0, 0.0, 200.0, 100.0]));
            let annotation_id = document.add_object(Object::Dictionary(annotation));
            set_page_annotations(&mut document, page_id, &[annotation_id]);
            let entry = &collect_embedded_shape_index(&document).unwrap().entries[0];
            assert_eq!((entry.x, entry.y), (start_x, start_y));
            assert_eq!((entry.x2.unwrap(), entry.y2.unwrap()), (end_x, end_y));
        }
    }

    #[test]
    fn uses_evb_key_then_managed_nm_and_keeps_unkeyed_identity_explicit() {
        let mut square = complete_shape_dict("Square", None);
        square.set("NM", shape_key("evb-shape:name-fallback"));
        let mut keyed_both = complete_shape_dict("Circle", Some("evb-shape:private"));
        keyed_both.set("NM", shape_key("evb-shape:name-shadowed"));
        let unkeyed = complete_shape_dict("Square", None);
        let mut unkeyed_ink = complete_shape_dict("Ink", None);
        unkeyed_ink.set(
            "InkList",
            Object::Array(vec![number_array(&[0.0, 0.0, 20.0, 20.0])]),
        );
        let (mut document, page_id) = page_document(0);
        let ids = [square, keyed_both, unkeyed, unkeyed_ink]
            .into_iter()
            .map(|dict| document.add_object(Object::Dictionary(dict)))
            .collect::<Vec<_>>();
        set_page_annotations(&mut document, page_id, &ids);

        let collection = collect_embedded_shape_index(&document).unwrap();
        assert_eq!(collection.entries.len(), 3);
        assert_eq!(
            collection.entries[0].stable_key.as_deref(),
            Some("evb-shape:name-fallback")
        );
        assert_eq!(
            collection.entries[1].stable_key.as_deref(),
            Some("evb-shape:private")
        );
        assert_eq!(collection.entries[2].stable_key, None);
        assert_eq!(collection.entries[2].object_number, u64::from(ids[2].0));
        assert!(collection
            .diagnostics
            .iter()
            .any(
                |diagnostic| diagnostic.object_number == Some(u64::from(ids[3].0))
                    && diagnostic.reason.contains("missing")
            ));
    }

    #[test]
    fn reports_malformed_supported_annotations_and_continues() {
        let mut malformed_square = complete_shape_dict("Square", Some("evb-shape:bad-square"));
        malformed_square.remove(b"Rect");
        let mut malformed_line = complete_shape_dict("Line", Some("evb-shape:bad-line"));
        malformed_line.set("L", number_array(&[0.0, 0.0]));
        let mut malformed_polyline = complete_shape_dict("PolyLine", Some("evb-shape:bad-poly"));
        malformed_polyline.set("Vertices", number_array(&[0.0, 0.0, 1.0]));
        let mut malformed_ink = complete_shape_dict("Ink", Some("evb-shape:bad-ink"));
        malformed_ink.set("InkList", Object::Array(vec![Object::Integer(9)]));
        let valid = complete_shape_dict("Circle", Some("evb-shape:valid"));
        let (mut document, page_id) = page_document(0);
        let ids = [
            malformed_square,
            malformed_line,
            malformed_polyline,
            malformed_ink,
            valid,
        ]
        .into_iter()
        .map(|dict| document.add_object(Object::Dictionary(dict)))
        .collect::<Vec<_>>();
        set_page_annotations(&mut document, page_id, &ids);

        let collection = collect_embedded_shape_index(&document).unwrap();
        assert_eq!(collection.entries.len(), 1);
        assert_eq!(
            collection.entries[0].stable_key.as_deref(),
            Some("evb-shape:valid")
        );
        assert_eq!(collection.diagnostics.len(), 4);
        assert!(collection
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.reason.contains("/Rect")));
        assert!(collection
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.reason.contains("/L")));
        assert!(collection
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.reason.contains("/Vertices")));
        assert!(collection
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.reason.contains("/InkList")));
    }

    #[test]
    fn keeps_page_index_above_one_hundred_thousand() {
        let page_id = (7, 0);
        let annotation_id = (8, 0);
        let mut objects = HashMap::new();
        objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                "Annots" => vec![Object::Reference(annotation_id)],
            }),
        );
        objects.insert(
            annotation_id,
            Object::Dictionary(complete_shape_dict("Square", Some("evb-shape:large-page"))),
        );
        let source = SparsePdfObjectSource {
            objects,
            pages: BTreeMap::from([(100_001, page_id)]),
        };

        let collection = collect_embedded_shape_index(&source).unwrap();
        assert_eq!(collection.page_count, 1);
        assert_eq!(collection.entries.len(), 1);
        assert_eq!(collection.entries[0].page_index, 100_000);
    }

    #[test]
    fn bounds_stable_shape_delete_lookup_and_stops_after_matching_keys() {
        let (mut document, page_id) = page_document(0);
        let shape_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Square",
            "Rect" => number_array(&[20.0, 20.0, 80.0, 60.0]),
            "P" => Object::Reference(page_id),
            "NM" => shape_key("evb-shape:lookup"),
        });
        set_page_annotations(&mut document, page_id, &[shape_id]);
        for _ in 0..10_000 {
            document.add_object(dictionary! {"Subtype" => "Text"});
        }

        let stable_keys = HashSet::from(["evb-shape:lookup".to_string()]);
        let (lookup, scanned_objects) =
            lookup_embedded_shape_delete_targets_with_scan_count(&document, &stable_keys);
        assert_eq!(lookup.object_ids, HashSet::from([shape_id]));
        assert_eq!(lookup.page_ids, HashSet::from([page_id]));
        assert!(
            scanned_objects < 100,
            "stable-key lookup retained/scanned past the first match: {scanned_objects} objects"
        );
    }

    #[test]
    fn writes_bounded_jsonl_without_stream_contents() {
        let (mut document, page_id) = page_document(0);
        let annotation_id = document.add_object(Object::Dictionary(complete_shape_dict(
            "Square",
            Some("evb-shape:writer"),
        )));
        set_page_annotations(&mut document, page_id, &[annotation_id]);
        let stream_id = document.add_object(Stream::new(
            dictionary! {"Length" => 21},
            b"secret stream payload".to_vec(),
        ));
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Contents", Object::Reference(stream_id));
        let output = temporary_path("bounded");

        write_embedded_shape_index_with_chunk_limit(&document, &output, 512).unwrap();

        let sidecar = read_sidecar(&output);
        assert_eq!(sidecar[0]["format"], EMBEDDED_SHAPE_INDEX_FORMAT);
        assert_eq!(entries(&sidecar).len(), 1);
        for chunk in sidecar.iter().skip(1) {
            assert!(serde_json::to_vec(chunk).unwrap().len() < 512);
        }
        assert!(!String::from_utf8(fs::read(&output).unwrap())
            .unwrap()
            .contains("secret stream payload"));
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn parses_embedded_shape_index_command_and_alias() {
        for command in ["embedded-shape-index", "shape-index"] {
            let config = parse_args(
                [
                    command.to_string(),
                    "--input".to_string(),
                    "/tmp/input.pdf".to_string(),
                    "--output".to_string(),
                    "/tmp/index.jsonl".to_string(),
                    "--qpdf-path".to_string(),
                    "/opt/qpdf".to_string(),
                ]
                .into_iter(),
            )
            .unwrap();
            assert!(matches!(config.operation, Operation::EmbeddedShapeIndex));
            assert_eq!(config.qpdf_path, Some(PathBuf::from("/opt/qpdf")));
        }
    }

    #[test]
    fn dispatches_embedded_shape_index_for_a_small_pdf() {
        let (mut document, page_id) = page_document(0);
        let annotation_id = document.add_object(Object::Dictionary(complete_shape_dict(
            "Square",
            Some("evb-shape:path"),
        )));
        set_page_annotations(&mut document, page_id, &[annotation_id]);
        let input = temporary_path("path-input");
        let output = temporary_path("path-output");
        document.save(&input).unwrap();

        mutate_pdf(Config {
            operation: Operation::EmbeddedShapeIndex,
            input_path: input.clone(),
            output_path: output.clone(),
            qpdf_path: None,
        })
        .unwrap();

        let sidecar = read_sidecar(&output);
        assert_eq!(sidecar[0]["format"], EMBEDDED_SHAPE_INDEX_FORMAT);
        assert_eq!(entries(&sidecar).len(), 1);
        assert_eq!(entries(&sidecar)[0]["stableKey"], "evb-shape:path");
        fs::remove_file(input).unwrap();
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn large_shape_index_path_requires_the_qpdf_structural_reader() {
        let input = temporary_path("large-input");
        let output = temporary_path("large-output");
        let file = std::fs::File::create(&input).unwrap();
        file.set_len(512 * 1024 * 1024 + 1).unwrap();

        let error = mutate_pdf(Config {
            operation: Operation::EmbeddedShapeIndex,
            input_path: input.clone(),
            output_path: output.clone(),
            qpdf_path: None,
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("Large incremental PDF input requires the bundled qpdf structural reader"));
        assert!(!output.exists());
        fs::remove_file(input).unwrap();
    }

    #[test]
    fn shape_index_rejects_an_output_path_that_aliases_the_input() {
        let (mut document, _) = page_document(0);
        let input = temporary_path("alias-input");
        document.save(&input).unwrap();

        let error = mutate_pdf(Config {
            operation: Operation::EmbeddedShapeIndex,
            input_path: input.clone(),
            output_path: input.clone(),
            qpdf_path: None,
        })
        .unwrap_err();
        assert!(error.to_string().contains("must not alias the PDF input"));
        fs::remove_file(input).unwrap();
    }
}
