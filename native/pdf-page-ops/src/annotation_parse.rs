use super::*;
use evb_native_support::output::AtomicOutput;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Write,
    path::Path,
};

pub(crate) const ANNOTATION_PARSE_FORMAT: &str = "evb-pdf-annotation-parse";
pub(crate) const ANNOTATION_PARSE_SCHEMA_VERSION: u64 = 1;
pub(crate) const ANNOTATION_PARSE_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_PAGE_ANNOTATIONS: usize = 100_000;
const MAX_ANNOTATION_REPLIES: usize = 4_096;
const MAX_HIGHLIGHT_QUADS: usize = 512;
const MAX_STAMP_IMAGE_GRAPH_NODES: usize = 32;
const MAX_STAMP_IMAGE_BYTES: usize = 64 * 1024 * 1024;
const MARKER_RECT_THRESHOLD: f64 = 0.02;
const MARKER_RECT_EPSILON: f64 = f64::EPSILON * 16.0;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseTextBox {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) name: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
    pub(crate) text: String,
    pub(crate) rect: MarkerRect,
    pub(crate) rotation: i64,
    pub(crate) font_size: f64,
    pub(crate) color: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseReply {
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) contents: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseNote {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) name: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
    pub(crate) position: MarkerRect,
    pub(crate) contents: String,
    pub(crate) color: Option<String>,
    pub(crate) open: bool,
    pub(crate) replies: Vec<PdfAnnotationParseReply>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseForeign {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) name: String,
    pub(crate) subtype: String,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseHighlight {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) name: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
    pub(crate) subtype: String,
    pub(crate) quad_points: Vec<MarkerRect>,
    pub(crate) color: String,
    pub(crate) opacity: f64,
    pub(crate) contents: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseStampImage {
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseStamp {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) name: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
    pub(crate) rect: MarkerRect,
    pub(crate) rotation: i64,
    pub(crate) image: PdfAnnotationParseStampImage,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseShapePoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PdfAnnotationParseShape {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) name: String,
    pub(crate) author: Option<String>,
    pub(crate) created_at: Option<i64>,
    pub(crate) modified_at: Option<i64>,
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
    pub(crate) points: Option<Vec<PdfAnnotationParseShapePoint>>,
    pub(crate) strokes: Option<Vec<Vec<PdfAnnotationParseShapePoint>>>,
    pub(crate) line_start_style: Option<String>,
    pub(crate) line_end_style: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum PdfAnnotationParseEntry {
    TextBox(PdfAnnotationParseTextBox),
    Note(PdfAnnotationParseNote),
    Highlight(PdfAnnotationParseHighlight),
    Stamp(PdfAnnotationParseStamp),
    Shape(PdfAnnotationParseShape),
    Foreign(PdfAnnotationParseForeign),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct AnnotationParseScan {
    pub(crate) page_count: u64,
    pub(crate) entry_count: u64,
}

/// Scan the document one page at a time. The callback receives only the
/// current entry, so callers can stream a large document without retaining its
/// entity set in the renderer or native process.
pub(crate) fn scan_parsed_annotations<F>(
    document: &impl PdfObjectSource,
    _modified_at: &str,
    mut on_entry: F,
) -> Result<AnnotationParseScan>
where
    F: FnMut(PdfAnnotationParseEntry) -> Result<()>,
{
    let resolver = PageTreeResolver::new(document)?;
    let mut scan = AnnotationParseScan::default();
    let mut page_index = 0_u64;
    let mut existing_names = HashSet::new();
    scan.page_count = resolver.for_each_page_id_with_count(document, |page_id| {
        let current_page_index = page_index;
        scan_page_annotations(
            document,
            page_id,
            current_page_index,
            &mut on_entry,
            &mut scan.entry_count,
            &mut existing_names,
        )?;
        page_index = page_index
            .checked_add(1)
            .ok_or("PDF annotation parse page index overflow")?;
        Ok(())
    })?;
    Ok(scan)
}

/// Write the parse result as the same bounded JSONL envelope used by the
/// existing annotation sidecars. `sink` is called for each header or chunk and
/// owns the destination-specific byte limit.
pub(crate) fn write_annotation_parse_stream<F>(
    document: &impl PdfObjectSource,
    modified_at: &str,
    chunk_limit: usize,
    mut sink: F,
) -> Result<AnnotationParseScan>
where
    F: FnMut(&[u8]) -> Result<()>,
{
    if !(64..=ANNOTATION_PARSE_CHUNK_BYTES).contains(&chunk_limit) {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Annotation parse chunk limit must fit its JSON envelope and stay within 4 MiB",
        ));
    }
    let page_count = u64::from(PageTreeResolver::new(document)?.page_count());
    let header = format!(
        "{{\"format\":\"{ANNOTATION_PARSE_FORMAT}\",\"schemaVersion\":{ANNOTATION_PARSE_SCHEMA_VERSION},\"pageCount\":{page_count},\"chunkBytes\":{chunk_limit}}}\n"
    );
    sink(header.as_bytes())?;

    let mut chunk = AnnotationParseChunk::new(0);
    let mut next_chunk_index = 0_u64;
    let scan = scan_parsed_annotations(document, modified_at, |entry| {
        let encoded_entry = serde_json::to_vec(&entry)?;
        if !chunk.try_push(&encoded_entry, chunk_limit) {
            if chunk.entry_count == 0 {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse entry exceeds the 4 MiB chunk limit",
                ));
            }
            next_chunk_index = next_chunk_index
                .checked_add(1)
                .ok_or("Annotation parse chunk number overflow")?;
            let finished_chunk =
                std::mem::replace(&mut chunk, AnnotationParseChunk::new(next_chunk_index)).finish();
            sink(&finished_chunk)?;
            if !chunk.try_push(&encoded_entry, chunk_limit) {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse entry exceeds the 4 MiB chunk limit",
                ));
            }
        }
        Ok(())
    })?;
    if chunk.entry_count > 0 {
        sink(&chunk.finish())?;
    }
    Ok(scan)
}

pub(crate) fn write_annotation_parse_path(
    input_path: &Path,
    output_path: &Path,
    modified_at: &str,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    if annotation_index_paths_alias(input_path, output_path)? {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Annotation parse output must not alias the PDF input",
        ));
    }

    let incremental = load_annotation_index_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    if incremental.get_prev_documents().is_encrypted() {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            "Encrypted PDFs are not supported by the annotation parse operation",
        ));
    }

    let mut output = AtomicOutput::create(output_path)?;
    #[cfg(unix)]
    output
        .file()?
        .set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    let mut total_bytes = 0_u64;
    write_annotation_parse_stream(
        &AppendedRevision::new(&incremental),
        modified_at,
        ANNOTATION_PARSE_CHUNK_BYTES,
        |bytes| {
            let next_total = total_bytes
                .checked_add(u64::try_from(bytes.len())?)
                .ok_or("Annotation parse sidecar byte count overflow")?;
            if next_total > u64::try_from(MAX_SIDECAR_BYTES)? {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse exceeds the sidecar byte limit",
                ));
            }
            output.file_mut()?.write_all(bytes)?;
            total_bytes = next_total;
            Ok(())
        },
    )?;
    output.publish()?;
    Ok(())
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn serialize_annotation_parse(
    document: &impl PdfObjectSource,
    modified_at: &str,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    write_annotation_parse_stream(
        document,
        modified_at,
        ANNOTATION_PARSE_CHUNK_BYTES,
        |bytes| {
            let next_len = output
                .len()
                .checked_add(bytes.len())
                .ok_or("Annotation parse output length overflow")?;
            if next_len > max_bytes {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse WASM output exceeds the admission ceiling",
                ));
            }
            output.try_reserve(bytes.len()).map_err(|_| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation parse WASM output exceeds the admission ceiling",
                )
            })?;
            output.extend_from_slice(bytes);
            Ok(())
        },
    )?;
    Ok(output)
}

#[cfg(test)]
pub(crate) fn collect_parsed_annotations(
    document: &impl PdfObjectSource,
    modified_at: &str,
) -> Result<Vec<PdfAnnotationParseEntry>> {
    let mut entries = Vec::new();
    scan_parsed_annotations(document, modified_at, |entry| {
        entries.push(entry);
        Ok(())
    })?;
    Ok(entries)
}

#[derive(Clone, Copy)]
struct PageAnnotation<'a> {
    object_id: Option<ObjectId>,
    dict: &'a Dictionary,
}

fn scan_page_annotations<F>(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
    page_index: u64,
    on_entry: &mut F,
    entry_count: &mut u64,
    existing_names: &mut HashSet<String>,
) -> Result<()>
where
    F: FnMut(PdfAnnotationParseEntry) -> Result<()>,
{
    let page_view = resolve_page_view(document, page_id)?;
    let page_rotation = resolve_page_rotation(document, page_id)?;
    let annots = get_page_annots(document, page_id)?;
    if annots.len() > MAX_PAGE_ANNOTATIONS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "PDF page annotation array exceeds the admission ceiling",
        ));
    }

    let mut page_annotations = Vec::with_capacity(annots.len());
    for object in &annots {
        if let Ok(object_id) = object.as_reference() {
            let dict = document.dictionary(object_id)?;
            page_annotations.push(PageAnnotation {
                object_id: Some(object_id),
                dict,
            });
        } else if let Ok(dict) = object.as_dict() {
            // Direct dictionaries have no durable object reference. They still
            // get a deterministic 0R0 identity and remain visible to callers.
            page_annotations.push(PageAnnotation {
                object_id: None,
                dict,
            });
        }
    }

    let mut object_indexes = HashMap::with_capacity(page_annotations.len());
    for (index, annotation) in page_annotations.iter().enumerate() {
        if let Some(object_id) = annotation.object_id {
            object_indexes.insert(object_id, index);
        }
    }

    let mut reply_children: HashMap<ObjectId, Vec<ObjectId>> = HashMap::new();
    for annotation in &page_annotations {
        let (Some(reply_id), Some(parent_id)) = (
            annotation.object_id,
            annotation_related_ref(annotation.dict, b"IRT"),
        ) else {
            continue;
        };
        if object_indexes.contains_key(&parent_id) {
            reply_children.entry(parent_id).or_default().push(reply_id);
        }
    }

    for annotation in &page_annotations {
        let subtype = annotation_subtype_name(document, annotation.dict);
        // `/IRT` marks an annotation as a reply regardless of whether its
        // parent is present on this page, recognized by us, or present at all.
        // A recognized same-page note may emit the reply below its parent, but
        // a reply must never also appear as a top-level entity.
        if subtype.eq_ignore_ascii_case("Popup") || annotation.dict.get(b"IRT").is_ok() {
            continue;
        }

        let object_id = annotation.object_id.unwrap_or((0, 0));
        let name = resolve_or_mint_name(
            annotation.dict,
            existing_names,
            page_index,
            object_id,
            &subtype,
        );
        existing_names.insert(name.clone());

        let entry = match subtype.to_ascii_lowercase().as_str() {
            "text" => parse_note_entry(
                document,
                annotation.dict,
                object_id,
                page_index,
                page_view,
                page_rotation,
                &name,
                &reply_children,
                &object_indexes,
                &page_annotations,
            )
            .map(PdfAnnotationParseEntry::Note),
            "freetext" => {
                if is_free_text_note_marker(document, annotation.dict, page_view, page_rotation) {
                    parse_note_entry(
                        document,
                        annotation.dict,
                        object_id,
                        page_index,
                        page_view,
                        page_rotation,
                        &name,
                        &reply_children,
                        &object_indexes,
                        &page_annotations,
                    )
                    .map(PdfAnnotationParseEntry::Note)
                } else {
                    parse_text_box_entry(
                        document,
                        annotation.dict,
                        object_id,
                        page_index,
                        page_view,
                        page_rotation,
                        &name,
                    )
                    .map(PdfAnnotationParseEntry::TextBox)
                }
            }
            "highlight" | "underline" | "strikeout" | "squiggly" => parse_highlight_entry(
                document,
                annotation.dict,
                object_id,
                page_index,
                page_view,
                page_rotation,
                &subtype,
                &name,
            )
            .map(PdfAnnotationParseEntry::Highlight),
            "stamp" => parse_stamp_entry(
                document,
                annotation.dict,
                object_id,
                page_index,
                page_view,
                page_rotation,
                &name,
            )
            .map(PdfAnnotationParseEntry::Stamp),
            "square" | "circle" | "line" | "polyline" | "polygon" | "ink" => parse_shape_entry(
                document,
                annotation.dict,
                object_id,
                page_index,
                page_view,
                page_rotation,
                &subtype,
                &name,
            )
            .map(PdfAnnotationParseEntry::Shape),
            _ => Err(format!("Unsupported annotation subtype /{subtype}")),
        };

        let entry = entry.unwrap_or_else(|reason| {
            PdfAnnotationParseEntry::Foreign(PdfAnnotationParseForeign {
                page_index,
                object_number: u64::from(object_id.0),
                generation_number: u64::from(object_id.1),
                name,
                subtype: if subtype.is_empty() {
                    "Unknown".to_string()
                } else {
                    subtype
                },
                reason: truncate_reason(&reason),
            })
        });
        on_entry(entry)?;
        *entry_count = entry_count
            .checked_add(1)
            .ok_or("PDF annotation parse entry count overflow")?;
    }
    Ok(())
}

fn parse_text_box_entry(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    object_id: ObjectId,
    page_index: u64,
    page_view: PdfRect,
    page_rotation: i64,
    name: &str,
) -> std::result::Result<PdfAnnotationParseTextBox, String> {
    let rect = read_annotation_rect(document, dict)?;
    let rect = pdf_rect_to_marker_rect(rect, page_view, page_rotation)
        .map_err(|error| error.to_string())?;
    if dict.get(b"Contents").is_err() && dict.get(b"RC").is_ok() {
        return Err("FreeText has rich text without plain text contents".to_string());
    }
    let text = read_optional_annotation_text(document, dict, b"Contents")?.unwrap_or_default();
    let (font_size, color) = parse_default_appearance(document, dict)?;
    let rotation = read_optional_integer(document, dict, b"Rotate")?.unwrap_or(0);
    let rotation = normalize_page_rotation(rotation);
    Ok(PdfAnnotationParseTextBox {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        name: name.to_string(),
        author: read_optional_annotation_author(document, dict)?,
        created_at: read_annotation_date(document, dict, b"CreationDate"),
        modified_at: read_annotation_date(document, dict, b"M"),
        text,
        rect,
        rotation,
        font_size,
        color,
    })
}

/// Parse one of the four text-markup subtypes. The four corner orders found in
/// real files (PDF spec order, lower-left first, and their rotations) all
/// collapse to the same bounding quad, so unusual corner order parses
/// identically. A markup annotation without `/QuadPoints` falls back to one
/// quad derived from `/Rect`, mirroring the writer's fallback.
#[allow(clippy::too_many_arguments)]
fn parse_highlight_entry(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    object_id: ObjectId,
    page_index: u64,
    page_view: PdfRect,
    page_rotation: i64,
    subtype: &str,
    name: &str,
) -> std::result::Result<PdfAnnotationParseHighlight, String> {
    let quad_points = parse_highlight_quad_points(document, dict, page_view, page_rotation)?;
    let color =
        read_annotation_color(document, dict).unwrap_or_else(|| default_markup_color(subtype));
    Ok(PdfAnnotationParseHighlight {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        name: name.to_string(),
        author: read_optional_annotation_author(document, dict)?,
        created_at: read_annotation_date(document, dict, b"CreationDate"),
        modified_at: read_annotation_date(document, dict, b"M"),
        subtype: canonical_markup_subtype_name(subtype).to_string(),
        quad_points,
        color,
        opacity: read_shape_opacity(document, dict),
        contents: read_optional_annotation_text(document, dict, b"Contents")?.unwrap_or_default(),
    })
}

fn parse_highlight_quad_points(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    page_view: PdfRect,
    page_rotation: i64,
) -> std::result::Result<Vec<MarkerRect>, String> {
    let rect = read_annotation_rect(document, dict)?;
    if dict.get(b"QuadPoints").is_err() {
        // No quad points at all: fall back to one quad derived from `/Rect`,
        // mirroring the writer's `ensure_markup_quad_points` fallback.
        return pdf_rect_to_marker_rect(rect, page_view, page_rotation)
            .map(|marker_rect| vec![marker_rect])
            .map_err(|error| error.to_string());
    }
    let values = read_markup_quad_points(document, dict)
        .ok_or_else(|| "Highlight quad points are malformed".to_string())?;
    if values.len() > MAX_HIGHLIGHT_QUADS * 8 {
        return Err("Highlight quad points exceed the admission ceiling".to_string());
    }
    // Corner order inside one quad does not matter: the markup writer reads
    // quads as bounding boxes for the same reason, so parse and write stay
    // inverses regardless of the order a foreign viewer used.
    let quads = to_text_markup_quads(&values)
        .ok_or_else(|| "Highlight quad points are malformed".to_string())?;
    quads
        .iter()
        .map(|quad| {
            pdf_rect_to_marker_rect(
                PdfRect {
                    x1: quad.left,
                    y1: quad.bottom,
                    x2: quad.right,
                    y2: quad.top,
                },
                page_view,
                page_rotation,
            )
            .map_err(|error| error.to_string())
        })
        .collect()
}

/// Color fallback mirrors the renderer's default paint for each markup
/// subtype, so a foreign highlight without `/C` still reports a color.
fn default_markup_color(subtype: &str) -> String {
    if canonical_markup_subtype_name(subtype) == "Highlight" {
        "#ffff00".to_string()
    } else {
        "#ff0000".to_string()
    }
}

fn canonical_markup_subtype_name(subtype: &str) -> &'static str {
    match subtype.to_ascii_lowercase().as_str() {
        "highlight" => "Highlight",
        "underline" => "Underline",
        "strikeout" => "StrikeOut",
        _ => "Squiggly",
    }
}

/// Parse a stamp into its rect, rotation and a reference to the JPEG bytes in
/// its appearance graph. Byte extraction stays with the image; the sidecar
/// only carries the reference, per the bounded-memory rule.
#[allow(clippy::too_many_arguments)]
fn parse_stamp_entry(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    object_id: ObjectId,
    page_index: u64,
    page_view: PdfRect,
    page_rotation: i64,
    name: &str,
) -> std::result::Result<PdfAnnotationParseStamp, String> {
    let rect = read_annotation_rect(document, dict)?;
    let rect = pdf_rect_to_marker_rect(rect, page_view, page_rotation)
        .map_err(|error| error.to_string())?;
    let rotation = stamp_rotation(document, dict).map_err(|error| error.to_string())?;
    let image = resolve_stamp_image(document, dict)?;
    Ok(PdfAnnotationParseStamp {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        name: name.to_string(),
        author: read_optional_annotation_author(document, dict)?,
        created_at: read_annotation_date(document, dict, b"CreationDate"),
        modified_at: read_annotation_date(document, dict, b"M"),
        rect,
        rotation,
        image,
    })
}

/// Stamps carry rotation in two places: `/Rotate` (Acrobat's convention) or
/// inside the appearance stream's `cm` matrix (the writer's convention). The
/// writer negates marker-space rotation for PDF's y-up space, so parse
/// negates it back. Arbitrary degrees are not representable, so the result is
/// snapped to a quarter turn; a stamp rotated by any other angle is still
/// parsed, its visible shape unchanged by the reported rotation.
fn stamp_rotation(document: &impl PdfObjectSource, dict: &Dictionary) -> Result<i64> {
    if let Some(rotate) = read_optional_integer(document, dict, b"Rotate")? {
        return Ok(normalize_page_rotation(rotate));
    }
    if let Some([a, b, ..]) = stamp_appearance_cm_matrix(document, dict) {
        let degrees = -b.atan2(a).to_degrees();
        return Ok(normalize_page_rotation(degrees.round() as i64));
    }
    Ok(0)
}

/// Read the first `cm` matrix from the stamp's appearance stream. Compressed
/// foreign appearance streams are left compressed by the structural loader;
/// without a parseable matrix the rotation falls back to `/Rotate` or 0.
fn stamp_appearance_cm_matrix(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> Option<[f64; 6]> {
    let appearance = dict
        .get(b"AP")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_dict().ok())?;
    let appearance_id = annotation_related_ref(appearance, b"N")?;
    let Object::Stream(appearance_stream) = document.object(appearance_id).ok()? else {
        return None;
    };
    let content = std::str::from_utf8(&appearance_stream.content).ok()?;
    let mut values: Vec<f64> = Vec::with_capacity(6);
    for token in content.split_whitespace() {
        if token == "cm" {
            return (values.len() == 6 && values.iter().all(|value| value.is_finite()))
                .then(|| values.try_into().ok())
                .flatten();
        }
        match token.parse::<f64>() {
            Ok(value) => {
                if values.len() == 6 {
                    values.remove(0);
                }
                values.push(value);
            }
            Err(_) => values.clear(),
        }
    }
    None
}

/// Walk the stamp's `/AP` `/N` `/Resources` `/XObject` graph, the same graph
/// the delete walk traverses, and hash the first JPEG image stream. Unknown
/// stamp forms (no image, a non-JPEG image) must not become a lossy stamp
/// entity, so the caller reports them as foreign.
fn resolve_stamp_image(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> std::result::Result<PdfAnnotationParseStampImage, String> {
    let appearance = dict
        .get(b"AP")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_dict().ok());
    let appearance_id = annotation_related_ref(
        appearance.ok_or("Stamp has no JPEG image in its appearance graph")?,
        b"N",
    )
    .ok_or_else(|| "Stamp has no JPEG image in its appearance graph".to_string())?;

    let mut visited = HashSet::new();
    let mut pending = vec![appearance_id];
    while let Some(object_id) = pending.pop() {
        if visited.contains(&object_id) {
            continue;
        }
        if visited.len() >= MAX_STAMP_IMAGE_GRAPH_NODES {
            return Err("Stamp appearance graph exceeds the admission ceiling".to_string());
        }
        visited.insert(object_id);
        let Ok(Object::Stream(stream)) = document.object(object_id) else {
            continue;
        };
        if stream
            .dict
            .get(b"Subtype")
            .ok()
            .and_then(|value| value.as_name().ok())
            == Some(b"Image".as_slice())
        {
            return stamp_image_reference(object_id, stream);
        }
        if let Some(xobjects) = stream
            .dict
            .get(b"Resources")
            .ok()
            .and_then(|value| document.resolved(value).ok())
            .and_then(|value| value.as_dict().ok())
            .and_then(|resources| resources.get(b"XObject").ok())
            .and_then(|value| document.resolved(value).ok())
            .and_then(|value| value.as_dict().ok())
        {
            pending.extend(
                xobjects
                    .iter()
                    .filter_map(|(_, value)| value.as_reference().ok()),
            );
        }
    }
    Err("Stamp has no JPEG image in its appearance graph".to_string())
}

fn stamp_image_reference(
    object_id: ObjectId,
    stream: &Stream,
) -> std::result::Result<PdfAnnotationParseStampImage, String> {
    let filters = stream
        .dict
        .get(b"Filter")
        .ok()
        .and_then(|value| match value {
            Object::Name(name) => Some(vec![name.clone()]),
            Object::Array(values) => values
                .iter()
                .map(|value| value.as_name().ok().map(<[u8]>::to_vec))
                .collect::<Option<Vec<_>>>(),
            _ => None,
        });
    let filter_is_dct =
        filters.is_some_and(|filters| filters.iter().any(|name| name == b"DCTDecode"));
    if !filter_is_dct {
        return Err("Stamp image is not JPEG-encoded".to_string());
    }
    if stream.content.len() > MAX_STAMP_IMAGE_BYTES {
        return Err("Stamp image exceeds the admission ceiling".to_string());
    }
    Ok(PdfAnnotationParseStampImage {
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        byte_length: u64::try_from(stream.content.len())
            .map_err(|_| "Stamp image length overflow".to_string())?,
        sha256: sha256_hex(&stream.content),
    })
}

/// Delegate shapes to the embedded shape index parser so the two read paths
/// cannot drift. A shape the app cannot represent returns a reason string and
/// is reported as foreign by the caller.
#[allow(clippy::too_many_arguments)]
fn parse_shape_entry(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    object_id: ObjectId,
    page_index: u64,
    page_view: PdfRect,
    page_rotation: i64,
    subtype: &str,
    name: &str,
) -> std::result::Result<PdfAnnotationParseShape, String> {
    let entry = parse_shape_index_entry(
        document,
        dict,
        page_index,
        object_id,
        canonical_shape_subtype_name(subtype),
        page_view,
        page_rotation,
    )?;
    let convert_points = |points: Option<&[EmbeddedShapeIndexPoint]>| {
        points.map(|points| {
            points
                .iter()
                .map(|point| PdfAnnotationParseShapePoint {
                    x: point.x,
                    y: point.y,
                })
                .collect()
        })
    };
    Ok(PdfAnnotationParseShape {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        name: name.to_string(),
        author: read_optional_annotation_author(document, dict)?,
        created_at: read_annotation_date(document, dict, b"CreationDate"),
        modified_at: read_annotation_date(document, dict, b"M"),
        stable_key: entry.stable_key,
        pdf_subtype: entry.pdf_subtype,
        shape_type: entry.shape_type,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
        x2: entry.x2,
        y2: entry.y2,
        color: entry.color,
        fill_color: entry.fill_color,
        opacity: entry.opacity,
        stroke_width: entry.stroke_width,
        points: convert_points(entry.points.as_deref()),
        strokes: entry.strokes.as_deref().map(|strokes| {
            strokes
                .iter()
                .map(|stroke| convert_points(Some(stroke.as_slice())).unwrap_or_default())
                .collect()
        }),
        line_start_style: entry.line_start_style,
        line_end_style: entry.line_end_style,
    })
}

fn canonical_shape_subtype_name(subtype: &str) -> &'static str {
    match subtype.to_ascii_lowercase().as_str() {
        "square" => "Square",
        "circle" => "Circle",
        "line" => "Line",
        "polyline" => "PolyLine",
        "polygon" => "Polygon",
        _ => "Ink",
    }
}

#[allow(clippy::too_many_arguments)]
fn parse_note_entry(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    object_id: ObjectId,
    page_index: u64,
    page_view: PdfRect,
    page_rotation: i64,
    name: &str,
    reply_children: &HashMap<ObjectId, Vec<ObjectId>>,
    object_indexes: &HashMap<ObjectId, usize>,
    page_annotations: &[PageAnnotation<'_>],
) -> std::result::Result<PdfAnnotationParseNote, String> {
    let rect = read_annotation_rect(document, dict)?;
    let position = pdf_rect_to_marker_rect(rect, page_view, page_rotation)
        .map_err(|error| error.to_string())?;
    let contents = read_optional_annotation_text(document, dict, b"Contents")?.unwrap_or_default();
    let color = read_annotation_color(document, dict);
    let open = read_optional_boolean(document, dict, b"Open")?.unwrap_or(false);
    let replies = parse_replies(
        document,
        object_id,
        reply_children,
        object_indexes,
        page_annotations,
    )?;
    Ok(PdfAnnotationParseNote {
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        name: name.to_string(),
        author: read_optional_annotation_author(document, dict)?,
        created_at: read_annotation_date(document, dict, b"CreationDate"),
        modified_at: read_annotation_date(document, dict, b"M"),
        position,
        contents,
        color,
        open,
        replies,
    })
}

fn parse_replies(
    document: &impl PdfObjectSource,
    note_id: ObjectId,
    reply_children: &HashMap<ObjectId, Vec<ObjectId>>,
    object_indexes: &HashMap<ObjectId, usize>,
    page_annotations: &[PageAnnotation<'_>],
) -> std::result::Result<Vec<PdfAnnotationParseReply>, String> {
    let mut replies = Vec::new();
    let mut pending = reply_children
        .get(&note_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect::<VecDeque<_>>();
    let mut seen = HashSet::new();
    while let Some(reply_id) = pending.pop_front() {
        if !seen.insert(reply_id) {
            continue;
        }
        if replies.len() >= MAX_ANNOTATION_REPLIES {
            return Err("Annotation reply chain exceeds the admission ceiling".to_string());
        }
        let Some(index) = object_indexes.get(&reply_id).copied() else {
            continue;
        };
        let annotation = page_annotations
            .get(index)
            .ok_or_else(|| "Annotation reply reference is out of range".to_string())?;
        replies.push(PdfAnnotationParseReply {
            object_number: u64::from(reply_id.0),
            generation_number: u64::from(reply_id.1),
            contents: read_optional_annotation_text(document, annotation.dict, b"Contents")?
                .unwrap_or_default(),
            author: read_optional_annotation_author(document, annotation.dict)?,
            created_at: read_annotation_date(document, annotation.dict, b"CreationDate"),
            modified_at: read_annotation_date(document, annotation.dict, b"M"),
        });
        if let Some(children) = reply_children.get(&reply_id) {
            pending.extend(children.iter().copied());
        }
    }
    Ok(replies)
}

fn annotation_subtype_name(document: &impl PdfObjectSource, dict: &Dictionary) -> String {
    dict.get(b"Subtype")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_name().ok())
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .unwrap_or_default()
}

fn read_annotation_rect(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> std::result::Result<PdfRect, String> {
    let object = dict.get(b"Rect").map_err(|_| "Missing /Rect".to_string())?;
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    parse_rect(resolved).map_err(|error| error.to_string())
}

fn read_optional_annotation_text(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> std::result::Result<Option<String>, String> {
    let Some(object) = dict.get(key).ok() else {
        return Ok(None);
    };
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    if resolved.as_str().is_err() {
        return Err(format!(
            "/{} must be a PDF string",
            String::from_utf8_lossy(key)
        ));
    }
    Ok(pdf_string_to_text(resolved).map(|value| {
        let trimmed = value.trim_matches('\0');
        if trimmed.is_empty() {
            String::new()
        } else {
            trimmed.to_string()
        }
    }))
}

fn read_optional_annotation_author(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> std::result::Result<Option<String>, String> {
    Ok(read_optional_annotation_text(document, dict, b"T")?.filter(|value| !value.is_empty()))
}

fn read_optional_integer(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> std::result::Result<Option<i64>, String> {
    let Some(object) = dict.get(key).ok() else {
        return Ok(None);
    };
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    resolved.as_i64().map(Some).map_err(|error| {
        format!(
            "/{} must be an integer: {error}",
            String::from_utf8_lossy(key)
        )
    })
}

fn read_optional_boolean(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> std::result::Result<Option<bool>, String> {
    let Some(object) = dict.get(key).ok() else {
        return Ok(None);
    };
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    resolved.as_bool().map(Some).map_err(|error| {
        format!(
            "/{} must be a boolean: {error}",
            String::from_utf8_lossy(key)
        )
    })
}

fn read_annotation_date(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    key: &[u8],
) -> Option<i64> {
    dict.get(key)
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(pdf_string_to_text)
        .and_then(|value| parse_pdf_date_timestamp(&value))
}

fn read_annotation_color(document: &impl PdfObjectSource, dict: &Dictionary) -> Option<String> {
    let object = dict.get(b"C").ok()?;
    let values = document.resolved(object).ok()?.as_array().ok()?;
    if !matches!(values.len(), 1 | 3 | 4) {
        return None;
    }
    let mut components = Vec::with_capacity(values.len());
    for value in values {
        let resolved = document.resolved(value).ok()?;
        let number = object_to_f64(resolved).ok()?;
        if !number.is_finite() {
            return None;
        }
        components.push(number);
    }
    Some(pdf_color_to_hex(Some(&components), "#000000"))
}

fn parse_default_appearance(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> std::result::Result<(f64, String), String> {
    let object = dict
        .get(b"DA")
        .map_err(|_| "FreeText is missing /DA".to_string())?;
    let resolved = document
        .resolved(object)
        .map_err(|error| error.to_string())?;
    let bytes = resolved
        .as_str()
        .map_err(|_| "FreeText /DA must be a PDF string".to_string())?;
    let tokens = String::from_utf8_lossy(bytes)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut font_size = None;
    let mut color = None;
    for (index, token) in tokens.iter().enumerate() {
        match token.as_str() {
            "Tf" => {
                font_size = previous_numbers(&tokens, index, 1).first().copied();
            }
            "rg" => {
                let values = previous_numbers(&tokens, index, 3);
                if values.len() == 3 {
                    color = Some(pdf_color_to_hex(Some(&values), "#000000"));
                }
            }
            "g" => {
                let values = previous_numbers(&tokens, index, 1);
                if values.len() == 1 {
                    color = Some(pdf_color_to_hex(Some(&values), "#000000"));
                }
            }
            _ => {}
        }
    }
    let font_size = font_size
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= 512.0)
        .ok_or_else(|| "FreeText /DA has no supported font size".to_string())?;
    let color = color.ok_or_else(|| "FreeText /DA has no supported color".to_string())?;
    Ok((font_size, color))
}

fn previous_numbers(tokens: &[String], operator_index: usize, count: usize) -> Vec<f64> {
    let mut values = Vec::with_capacity(count);
    for token in tokens[..operator_index].iter().rev() {
        let Ok(value) = token.parse::<f64>() else {
            if !values.is_empty() {
                break;
            }
            continue;
        };
        values.push(value);
        if values.len() == count {
            break;
        }
    }
    values.reverse();
    values
}

/// Return true only for the legacy FreeText note representation. The parser
/// and the later marker-rewrite writer share this predicate so the 0.02-point
/// compatibility rule cannot drift between read and edit paths.
pub(crate) fn is_free_text_note_marker(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    page_view: PdfRect,
    page_rotation: i64,
) -> bool {
    if !annotation_subtype_name(document, dict).eq_ignore_ascii_case("FreeText")
        || annotation_related_ref(dict, b"Popup").is_none()
    {
        return false;
    }
    let Ok(rect) = read_annotation_rect(document, dict) else {
        return false;
    };
    let Ok(marker_rect) = pdf_rect_to_marker_rect(rect, page_view, page_rotation) else {
        return false;
    };
    let marker_limit = MARKER_RECT_THRESHOLD + MARKER_RECT_EPSILON;
    if marker_rect.width > marker_limit || marker_rect.height > marker_limit {
        return false;
    }
    let Some(appearance) = dict
        .get(b"AP")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_dict().ok())
        .and_then(|appearance| appearance.get(b"N").ok())
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_stream().ok())
    else {
        return false;
    };
    appearance.content.is_empty()
}

fn truncate_reason(reason: &str) -> String {
    const MAX_REASON_BYTES: usize = 256;
    if reason.len() <= MAX_REASON_BYTES {
        return reason.to_string();
    }
    reason
        .char_indices()
        .take_while(|(index, _)| *index < MAX_REASON_BYTES)
        .map(|(_, character)| character)
        .collect()
}

struct AnnotationParseChunk {
    bytes: Vec<u8>,
    entry_count: usize,
}

impl AnnotationParseChunk {
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
    use lopdf::{dictionary, Document, Object, Stream};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct AnnotationParseProtocolFixture {
        format: String,
        schema_version: u64,
        page_count: u64,
        chunk_bytes: usize,
        chunk_index: u64,
        entries: Vec<PdfAnnotationParseEntry>,
    }

    fn text(value: &str) -> Object {
        Object::String(encode_pdf_text_string(value), StringFormat::Hexadecimal)
    }

    fn rect(left: f64, bottom: f64, right: f64, top: f64) -> Object {
        Object::Array(vec![
            number_object(left),
            number_object(bottom),
            number_object(right),
            number_object(top),
        ])
    }

    fn test_document() -> Document {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.new_object_id();
        let mut annots = Vec::new();

        let note_id = document.new_object_id();
        let popup_id = document.new_object_id();
        document.set_object(
            note_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => rect(10.0, 20.0, 30.0, 40.0),
                "NM" => text("note-name"),
                "Contents" => text("note contents"),
                "T" => text("Author"),
                "CreationDate" => Object::string_literal("D:20260830120000Z"),
                "M" => Object::string_literal("D:20260830120100Z"),
                "C" => vec![1.into(), 0.into(), 0.into()],
                "Open" => true,
                "Popup" => popup_id,
                "P" => page_id,
            },
        );
        document.set_object(
            popup_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Popup",
                "Parent" => note_id,
                "Rect" => rect(10.0, 20.0, 30.0, 40.0),
                "P" => page_id,
            },
        );
        let reply_id = document.new_object_id();
        document.set_object(
            reply_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => rect(10.0, 20.0, 30.0, 40.0),
                "IRT" => note_id,
                "Contents" => text("note reply"),
                "T" => text("Reply Author"),
                "M" => Object::string_literal("D:20260830120200Z"),
                "P" => page_id,
            },
        );
        annots.extend([
            Object::Reference(note_id),
            Object::Reference(popup_id),
            Object::Reference(reply_id),
        ]);

        let second_note_id = document.new_object_id();
        let second_popup_id = document.new_object_id();
        document.set_object(
            second_note_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => rect(40.0, 20.0, 60.0, 40.0),
                "NM" => text("note-name-two"),
                "Contents" => text("second note contents"),
                "T" => text("Second Author"),
                "Open" => false,
                "Popup" => second_popup_id,
                "P" => page_id,
            },
        );
        document.set_object(
            second_popup_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Popup",
                "Parent" => second_note_id,
                "Rect" => rect(40.0, 20.0, 60.0, 40.0),
                "P" => page_id,
            },
        );
        annots.extend([
            Object::Reference(second_note_id),
            Object::Reference(second_popup_id),
        ]);

        let marker_id = document.new_object_id();
        let marker_popup_id = document.new_object_id();
        let blank_ap_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => rect(0.0, 0.0, 0.0, 0.0),
            },
            Vec::new(),
        ));
        document.set_object(
            marker_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "FreeText",
                "Rect" => rect(0.0, 99.99, 0.01, 100.0),
                "NM" => text("marker-name"),
                "Contents" => text("legacy note"),
                "Popup" => marker_popup_id,
                "AP" => dictionary! {"N" => blank_ap_id},
                "P" => page_id,
            },
        );
        document.set_object(
            marker_popup_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Popup",
                "Parent" => marker_id,
                "Rect" => rect(0.0, 99.99, 0.01, 100.0),
                "P" => page_id,
            },
        );
        annots.extend([
            Object::Reference(marker_id),
            Object::Reference(marker_popup_id),
        ]);

        for (name, text_value, rect_value) in [
            ("text-box-one", "first box", rect(10.0, 10.0, 90.0, 30.0)),
            ("text-box-two", "second box", rect(100.0, 50.0, 190.0, 70.0)),
        ] {
            let text_box_id = document.new_object_id();
            document.set_object(
                text_box_id,
                dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "FreeText",
                    "Rect" => rect_value,
                    "NM" => text(name),
                    "Contents" => text(text_value),
                    "DA" => Object::string_literal("/Helv 12 Tf 0 0 1 rg"),
                    "P" => page_id,
                },
            );
            annots.push(Object::Reference(text_box_id));
        }

        let link_id = document.new_object_id();
        document.set_object(
            link_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Link",
                "Rect" => rect(1.0, 1.0, 2.0, 2.0),
                "P" => page_id,
            },
        );
        let widget_id = document.new_object_id();
        document.set_object(
            widget_id,
            dictionary! {
                "Type" => "Annot",
                "Subtype" => "Widget",
                "Rect" => rect(3.0, 3.0, 4.0, 4.0),
                "P" => page_id,
            },
        );
        annots.extend([Object::Reference(link_id), Object::Reference(widget_id)]);

        document.set_object(
            page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
                "Annots" => Object::Array(annots),
            },
        );
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document
    }

    #[test]
    fn parses_text_boxes_notes_and_foreign_annotations() {
        let document = test_document();
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries.len(), 7);
        assert_eq!(
            entries
                .iter()
                .filter(|entry| matches!(entry, PdfAnnotationParseEntry::Note(_)))
                .count(),
            3
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| matches!(entry, PdfAnnotationParseEntry::TextBox(_)))
                .count(),
            2
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| matches!(entry, PdfAnnotationParseEntry::Foreign(_)))
                .count(),
            2
        );
        let text_box = entries
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::TextBox(value) if value.name == "text-box-one" => {
                    Some(value)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(text_box.text, "first box");
        assert_eq!(text_box.author, None);
        assert_eq!(text_box.created_at, None);
        assert_eq!(text_box.rect.left, 0.05);
        assert_eq!(text_box.rect.top, 0.7);
        assert_eq!(text_box.color, "#0000ff");
        let marker = entries
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::Note(value) if value.name == "marker-name" => Some(value),
                _ => None,
            })
            .unwrap();
        assert_eq!(marker.contents, "legacy note");
        let first_note = entries
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::Note(value) if value.name == "note-name" => Some(value),
                _ => None,
            })
            .unwrap();
        assert_eq!(first_note.author.as_deref(), Some("Author"));
        assert_eq!(first_note.created_at, Some(1_788_091_200_000));
        assert_eq!(first_note.modified_at, Some(1_788_091_260_000));
        assert_eq!(first_note.replies.len(), 1);
        assert_eq!(first_note.replies[0].contents, "note reply");
    }

    #[test]
    fn skips_all_irt_annotations_from_top_level_results() {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let first_page_id = document.new_object_id();
        let second_page_id = document.new_object_id();
        let parent_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "Rect" => rect(20.0, 20.0, 40.0, 40.0),
            "NM" => text("parent-on-second-page"),
            "Contents" => text("parent contents"),
        });
        let missing_parent_reply_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "Rect" => rect(1.0, 1.0, 10.0, 10.0),
            "IRT" => Object::Reference((999_999, 0)),
            "Contents" => text("reply with missing parent"),
        });
        let cross_page_reply_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "Rect" => rect(11.0, 1.0, 20.0, 10.0),
            "IRT" => parent_id,
            "Contents" => text("reply to another page"),
        });
        let malformed_reply_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "Rect" => rect(21.0, 1.0, 30.0, 10.0),
            "IRT" => Object::string_literal("not-an-object-reference"),
            "Contents" => text("reply with malformed parent"),
        });
        document.set_object(
            first_page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
                "Annots" => Object::Array(vec![
                    Object::Reference(missing_parent_reply_id),
                    Object::Reference(cross_page_reply_id),
                    Object::Reference(malformed_reply_id),
                ]),
            },
        );
        document.set_object(
            second_page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
                "Annots" => Object::Array(vec![Object::Reference(parent_id)]),
            },
        );
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(vec![
                    Object::Reference(first_page_id),
                    Object::Reference(second_page_id),
                ]),
                "Count" => 2,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries.len(), 1);
        let PdfAnnotationParseEntry::Note(parent) = &entries[0] else {
            panic!("expected the cross-page parent note, got {:?}", entries[0]);
        };
        assert_eq!(parent.contents, "parent contents");
        assert!(entries.iter().all(|entry| {
            !matches!(entry, PdfAnnotationParseEntry::TextBox(text_box)
                if text_box.text.contains("reply"))
        }));
    }

    #[test]
    fn unsupported_annotation_color_array_is_reported_as_absent() {
        let mut document = test_document();
        let page_id = document.get_pages().values().next().copied().unwrap();
        let note_id = get_page_annots(&document, page_id)
            .unwrap()
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                document
                    .get_dictionary(*object_id)
                    .ok()
                    .and_then(read_annotation_name)
                    .as_deref()
                    == Some("note-name")
            })
            .unwrap();
        document
            .get_dictionary_mut(note_id)
            .unwrap()
            .set("C", Object::Array(vec![0.2.into(), 0.8.into()]));

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let note = entries
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::Note(value) if value.name == "note-name" => Some(value),
                _ => None,
            })
            .unwrap();
        assert_eq!(note.color, None);

        document
            .get_dictionary_mut(note_id)
            .unwrap()
            .set("C", Object::Array(Vec::new()));
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let note = entries
            .iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::Note(value) if value.name == "note-name" => Some(value),
                _ => None,
            })
            .unwrap();
        assert_eq!(note.color, None);
    }

    #[test]
    fn oversized_reply_chain_reports_the_note_as_foreign() {
        let mut document = test_document();
        let page_id = document.get_pages().values().next().copied().unwrap();
        let mut annots = get_page_annots(&document, page_id).unwrap();
        let note_id = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                document
                    .get_dictionary(*object_id)
                    .ok()
                    .and_then(read_annotation_name)
                    .as_deref()
                    == Some("note-name")
            })
            .unwrap();

        for _ in 0..MAX_ANNOTATION_REPLIES {
            let reply_id = document.new_object_id();
            document.set_object(
                reply_id,
                dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Text",
                    "Rect" => rect(10.0, 20.0, 30.0, 40.0),
                    "IRT" => note_id,
                    "Contents" => text("oversized reply"),
                    "P" => page_id,
                },
            );
            annots.push(Object::Reference(reply_id));
        }
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", Object::Array(annots));

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries.len(), 7);
        let note = entries
            .iter()
            .find(|entry| match entry {
                PdfAnnotationParseEntry::Foreign(value) => value.name == "note-name",
                _ => false,
            })
            .expect("the oversized note should be reported as foreign");
        let PdfAnnotationParseEntry::Foreign(note) = note else {
            unreachable!("the entry was selected by its foreign name");
        };
        assert!(note
            .reason
            .contains("reply chain exceeds the admission ceiling"));
    }

    #[test]
    fn duplicate_and_missing_names_get_distinct_deterministic_ids() {
        let mut document = test_document();
        let page_id = document.get_pages().values().next().copied().unwrap();
        let mut annots = get_page_annots(&document, page_id).unwrap();
        let source_id = annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                document
                    .get_dictionary(*object_id)
                    .ok()
                    .and_then(read_annotation_name)
                    .as_deref()
                    == Some("text-box-one")
            })
            .unwrap();
        let duplicate_id = document.new_object_id();
        let duplicate = document.get_dictionary(source_id).unwrap().clone();
        document.set_object(duplicate_id, Object::Dictionary(duplicate));
        annots.push(Object::Reference(duplicate_id));
        let missing_id = document.new_object_id();
        let mut missing = document.get_dictionary(source_id).unwrap().clone();
        missing.remove(b"NM");
        document.set_object(missing_id, Object::Dictionary(missing));
        annots.push(Object::Reference(missing_id));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set("Annots", Object::Array(annots));

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let names = entries
            .iter()
            .filter_map(|entry| match entry {
                PdfAnnotationParseEntry::TextBox(value) => Some(value.name.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(names.contains(&"text-box-one".to_string()));
        assert_eq!(
            names.iter().filter(|name| *name == "text-box-one").count(),
            1
        );
        assert_eq!(names.len(), 4);
        assert_eq!(names.iter().filter(|name| name.len() == 36).count(), 2);
        let entries_again = collect_parsed_annotations(&document, "D:20260831130000Z").unwrap();
        assert_eq!(entries, entries_again);
    }

    #[test]
    fn sidecar_has_bounded_jsonl_header_and_chunks() {
        let document = test_document();
        let bytes =
            serialize_annotation_parse(&document, "D:20260830130000Z", 4 * 1024 * 1024).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        let mut lines = text.lines();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines.next().unwrap()).unwrap()["format"],
            ANNOTATION_PARSE_FORMAT
        );
        let chunk = serde_json::from_str::<serde_json::Value>(lines.next().unwrap()).unwrap();
        assert_eq!(chunk["chunkIndex"], 0);
        assert_eq!(chunk["entries"].as_array().unwrap().len(), 7);
        assert!(lines.next().is_none());
    }

    #[test]
    fn marker_requires_popup_and_blank_appearance() {
        let document = test_document();
        let page_id = document.get_pages().values().next().copied().unwrap();
        let marker_id = get_page_annots(&document, page_id)
            .unwrap()
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                document
                    .get_dictionary(*object_id)
                    .ok()
                    .map(|dict| {
                        is_free_text_note_marker(
                            &document,
                            dict,
                            resolve_page_view(&document, page_id).unwrap(),
                            resolve_page_rotation(&document, page_id).unwrap(),
                        )
                    })
                    .unwrap_or(false)
            })
            .unwrap();
        let page_view = resolve_page_view(&document, page_id).unwrap();
        assert!(is_free_text_note_marker(
            &document,
            document.get_dictionary(marker_id).unwrap(),
            page_view,
            resolve_page_rotation(&document, page_id).unwrap(),
        ));
    }

    #[test]
    fn normalized_rect_inverse_matches_all_page_rotations() {
        let page_view = PdfRect {
            x1: 10.0,
            y1: 20.0,
            x2: 210.0,
            y2: 120.0,
        };
        let expected = MarkerRect {
            left: 0.17,
            top: 0.23,
            width: 0.31,
            height: 0.19,
        };
        for rotation in [0, 90, 180, 270] {
            let pdf_rect = marker_rect_to_pdf_rect(expected, page_view, rotation).unwrap();
            let actual = pdf_rect_to_marker_rect(pdf_rect, page_view, rotation).unwrap();
            assert!((actual.left - expected.left).abs() < 1e-12);
            assert!((actual.top - expected.top).abs() < 1e-12);
            assert!((actual.width - expected.width).abs() < 1e-12);
            assert!((actual.height - expected.height).abs() < 1e-12);
        }
    }

    #[test]
    fn shared_protocol_fixture_round_trips_and_rejects_unknown_fields() {
        let source = include_str!("../../protocol-fixtures/pdf-page-ops-parse-annotations.json");
        let fixture: AnnotationParseProtocolFixture = serde_json::from_str(source).unwrap();
        assert_eq!(fixture.format, ANNOTATION_PARSE_FORMAT);
        assert_eq!(fixture.schema_version, ANNOTATION_PARSE_SCHEMA_VERSION);
        assert_eq!(fixture.page_count, 1);
        assert_eq!(fixture.chunk_bytes, 512 * 1024);
        assert_eq!(fixture.chunk_index, 0);
        assert_eq!(fixture.entries.len(), 6);
        assert!(matches!(
            fixture.entries.first(),
            Some(PdfAnnotationParseEntry::TextBox(_))
        ));
        assert!(matches!(
            fixture.entries.get(1),
            Some(PdfAnnotationParseEntry::Note(_))
        ));
        assert!(matches!(
            fixture.entries.get(2),
            Some(PdfAnnotationParseEntry::Highlight(_))
        ));
        assert!(matches!(
            fixture.entries.get(3),
            Some(PdfAnnotationParseEntry::Stamp(_))
        ));
        assert!(matches!(
            fixture.entries.get(4),
            Some(PdfAnnotationParseEntry::Shape(_))
        ));
        assert!(matches!(
            fixture.entries.get(5),
            Some(PdfAnnotationParseEntry::Foreign(_))
        ));

        let with_unknown = source.replacen("{", r#"{"unknownField":true,"#, 1);
        assert!(serde_json::from_str::<AnnotationParseProtocolFixture>(&with_unknown).is_err());
    }

    fn assert_marker_rect_approx(rect: &MarkerRect, left: f64, top: f64, width: f64, height: f64) {
        assert!(
            (rect.left - left).abs() < 1e-9,
            "left {} != {left}",
            rect.left
        );
        assert!((rect.top - top).abs() < 1e-9, "top {} != {top}", rect.top);
        assert!(
            (rect.width - width).abs() < 1e-9,
            "width {} != {width}",
            rect.width
        );
        assert!(
            (rect.height - height).abs() < 1e-9,
            "height {} != {height}",
            rect.height
        );
    }

    fn single_page_document(annotations: Vec<(Dictionary, bool)>) -> Document {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.new_object_id();
        let annots = annotations
            .into_iter()
            .map(|(dict, indirect)| {
                if indirect {
                    Object::Reference(document.add_object(Object::Dictionary(dict)))
                } else {
                    Object::Dictionary(dict)
                }
            })
            .collect::<Vec<_>>();
        document.set_object(
            page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
                "Annots" => Object::Array(annots),
            },
        );
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document
    }

    fn highlight_dict(subtype: &str, quad_values: &[f64]) -> Dictionary {
        dictionary! {
            "Type" => "Annot",
            "Subtype" => subtype,
            "Rect" => rect(20.0, 20.0, 120.0, 35.0),
            "NM" => text("highlight-one"),
            "QuadPoints" => Object::Array(
                quad_values.iter().copied().map(number_object).collect(),
            ),
            "C" => vec![1.into(), 0.8.into(), 0.0.into()],
            "CA" => number_object(0.5),
            "Contents" => text("marked text"),
        }
    }

    #[test]
    fn parses_highlights_with_unusual_corner_order_and_defaults() {
        // PDF spec order (upper-left, upper-right, lower-left, lower-right),
        // then a rotated file's lower-left-first order. Both quads describe
        // the same rectangle and must parse identically.
        let spec_order = highlight_dict(
            "Highlight",
            &[20.0, 80.0, 120.0, 80.0, 20.0, 70.0, 120.0, 70.0],
        );
        let rotated_order = highlight_dict(
            "Underline",
            &[20.0, 70.0, 120.0, 70.0, 20.0, 80.0, 120.0, 80.0],
        );
        let document = single_page_document(vec![(spec_order, true), (rotated_order, true)]);

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries.len(), 2);
        let highlight = match &entries[0] {
            PdfAnnotationParseEntry::Highlight(value) => value,
            other => panic!("expected highlight, got {other:?}"),
        };
        assert_eq!(highlight.subtype, "Highlight");
        assert_eq!(highlight.name, "highlight-one");
        assert_eq!(highlight.quad_points.len(), 1);
        assert_marker_rect_approx(&highlight.quad_points[0], 0.1, 0.2, 0.5, 0.1);
        assert_eq!(highlight.color, "#ffcc00");
        assert_eq!(highlight.opacity, 0.5);
        assert_eq!(highlight.contents, "marked text");
        let underline = match &entries[1] {
            PdfAnnotationParseEntry::Highlight(value) => value,
            other => panic!("expected highlight, got {other:?}"),
        };
        assert_eq!(underline.subtype, "Underline");
        assert_eq!(underline.quad_points, highlight.quad_points);

        // A markup annotation without QuadPoints falls back to its rect, and
        // one without a color falls back to the renderer's default paint.
        let mut bare = highlight_dict("Squiggly", &[]);
        bare.remove(b"QuadPoints");
        bare.remove(b"C");
        bare.remove(b"CA");
        let document = single_page_document(vec![(bare, true)]);
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let squiggly = match &entries[0] {
            PdfAnnotationParseEntry::Highlight(value) => value,
            other => panic!("expected highlight, got {other:?}"),
        };
        assert_eq!(squiggly.subtype, "Squiggly");
        assert_eq!(squiggly.quad_points.len(), 1);
        assert_marker_rect_approx(&squiggly.quad_points[0], 0.1, 0.65, 0.5, 0.15);
        assert_eq!(squiggly.color, "#ff0000");
        assert_eq!(squiggly.opacity, 1.0);

        // Malformed quad points are foreign, never a lossy highlight.
        let malformed = highlight_dict("Highlight", &[1.0, 2.0, 3.0]);
        let document = single_page_document(vec![(malformed, true)]);
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let foreign = match &entries[0] {
            PdfAnnotationParseEntry::Foreign(value) => value,
            other => panic!("expected foreign, got {other:?}"),
        };
        assert!(foreign.reason.contains("quad points are malformed"));
    }

    #[test]
    fn parses_a_stamp_with_its_image_reference_and_rotation() {
        let jpeg_bytes = minimal_stamp_jpeg_bytes();
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.new_object_id();
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "Filter" => "DCTDecode",
            },
            jpeg_bytes.clone(),
        ));
        let appearance_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => rect(0.0, 0.0, 60.0, 20.0),
                "Resources" => dictionary! {
                    "XObject" => dictionary! { "Im5" => image_id },
                },
            },
            b"q\n0 -60 20 0 40 0 cm\n/Im5 Do\nQ\n".to_vec(),
        ));
        let stamp = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Stamp",
            "Rect" => rect(20.0, 50.0, 80.0, 70.0),
            "NM" => text("stamp-one"),
            "AP" => dictionary! { "N" => appearance_id },
        };
        let acrobat_stamp = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Stamp",
            "Rect" => rect(20.0, 20.0, 60.0, 40.0),
            "NM" => text("stamp-two"),
            "Rotate" => 180,
            "AP" => dictionary! { "N" => appearance_id },
        };
        let annots = vec![
            Object::Reference(document.add_object(Object::Dictionary(stamp))),
            Object::Reference(document.add_object(Object::Dictionary(acrobat_stamp))),
        ];
        document.set_object(
            page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
                "Annots" => Object::Array(annots),
            },
        );
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries.len(), 2);
        let stamp_entry = match &entries[0] {
            PdfAnnotationParseEntry::Stamp(value) => value,
            other => panic!("expected stamp, got {other:?}"),
        };
        // The appearance matrix rotates by -90 degrees in PDF space, which is
        // +90 in marker space (the writer negates marker-space rotation).
        assert_eq!(stamp_entry.rotation, 90);
        assert_marker_rect_approx(&stamp_entry.rect, 0.1, 0.3, 0.3, 0.2);
        assert_eq!(stamp_entry.image.object_number, u64::from(image_id.0));
        assert_eq!(stamp_entry.image.generation_number, u64::from(image_id.1));
        assert_eq!(
            stamp_entry.image.byte_length,
            u64::try_from(jpeg_bytes.len()).unwrap()
        );
        assert_eq!(stamp_entry.image.sha256, sha256_hex(&jpeg_bytes));
        let acrobat_entry = match &entries[1] {
            PdfAnnotationParseEntry::Stamp(value) => value,
            other => panic!("expected stamp, got {other:?}"),
        };
        assert_eq!(acrobat_entry.rotation, 180);
    }

    #[test]
    fn reports_unknown_stamp_forms_as_foreign() {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.new_object_id();
        let flate_image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Filter" => "FlateDecode",
            },
            vec![1, 2, 3],
        ));
        let no_image = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Stamp",
            "Rect" => rect(20.0, 50.0, 80.0, 70.0),
            "NM" => text("stamp-no-image"),
        };
        let not_jpeg = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Stamp",
            "Rect" => rect(20.0, 20.0, 60.0, 40.0),
            "NM" => text("stamp-flate"),
            "AP" => dictionary! { "N" => flate_image_id },
        };
        let annots = vec![
            Object::Reference(document.add_object(Object::Dictionary(no_image))),
            Object::Reference(document.add_object(Object::Dictionary(not_jpeg))),
        ];
        document.set_object(
            page_id,
            dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
                "Annots" => Object::Array(annots),
            },
        );
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries.len(), 2);
        for entry in &entries {
            let foreign = match entry {
                PdfAnnotationParseEntry::Foreign(value) => value,
                other => panic!("expected foreign, got {other:?}"),
            };
            assert!(foreign.reason.contains("JPEG"), "{}", foreign.reason);
        }
    }

    #[test]
    fn parses_shapes_by_delegating_to_the_shape_index() {
        let square = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Square",
            "Rect" => rect(20.0, 20.0, 120.0, 60.0),
            "NM" => text("evb-shape:square"),
            "EVBShapeKey" => Object::string_literal("evb-shape:square"),
            "C" => vec![1.into(), 0.0.into(), 0.0.into()],
            "IC" => vec![0.0.into(), 1.into(), 0.0.into()],
            "CA" => number_object(0.5),
            "Border" => vec![0.into(), 0.into(), 2.into()],
            "T" => text("Shape Author"),
        };
        let line = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Line",
            "Rect" => rect(10.0, 10.0, 190.0, 90.0),
            "NM" => text("evb-shape:line"),
            "L" => vec![20.into(), 80.into(), 120.into(), 20.into()],
            "C" => vec![0.into(), 0.into(), 1.into()],
            "LE" => vec![
                Object::Name(b"OpenArrow".to_vec()),
                Object::Name(b"None".to_vec()),
            ],
        };
        let malformed = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Ink",
            "Rect" => rect(10.0, 10.0, 50.0, 50.0),
            "EVBShapeKey" => Object::string_literal("evb-shape:malformed"),
            "InkList" => Object::Array(vec![Object::Integer(9)]),
        };
        let document = single_page_document(vec![(square, true), (line, true), (malformed, true)]);

        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        assert_eq!(entries.len(), 3);
        let square_entry = match &entries[0] {
            PdfAnnotationParseEntry::Shape(value) => value,
            other => panic!("expected shape, got {other:?}"),
        };
        assert_eq!(square_entry.pdf_subtype, "Square");
        assert_eq!(square_entry.shape_type, "rectangle");
        assert_eq!(square_entry.stable_key.as_deref(), Some("evb-shape:square"));
        assert_eq!(square_entry.color, "#ff0000");
        assert_eq!(square_entry.fill_color.as_deref(), Some("#00ff00"));
        assert_eq!(square_entry.opacity, 0.5);
        assert_eq!(square_entry.stroke_width, 2.0);
        assert_eq!(square_entry.author.as_deref(), Some("Shape Author"));
        let line_entry = match &entries[1] {
            PdfAnnotationParseEntry::Shape(value) => value,
            other => panic!("expected shape, got {other:?}"),
        };
        assert_eq!(line_entry.pdf_subtype, "Line");
        assert_eq!(line_entry.shape_type, "arrow");
        let x2 = line_entry.x2.expect("line x2");
        let y2 = line_entry.y2.expect("line y2");
        assert!((x2 - 0.6).abs() < 1e-9);
        assert!((y2 - 0.8).abs() < 1e-9);
        assert_eq!(line_entry.line_start_style.as_deref(), Some("openArrow"));
        assert_eq!(line_entry.line_end_style.as_deref(), Some("none"));
        let foreign = match &entries[2] {
            PdfAnnotationParseEntry::Foreign(value) => value,
            other => panic!("expected foreign, got {other:?}"),
        };
        assert!(foreign.reason.contains("InkList"), "{}", foreign.reason);
    }

    #[test]
    fn caps_highlight_and_shape_opacity_at_one() {
        let mut highlight = highlight_dict(
            "Highlight",
            &[20.0, 80.0, 120.0, 80.0, 20.0, 70.0, 120.0, 70.0],
        );
        highlight.set("CA", number_object(2.0));
        let square = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Square",
            "Rect" => rect(20.0, 20.0, 120.0, 60.0),
            "NM" => text("evb-shape:opacity"),
            "EVBShapeKey" => Object::string_literal("evb-shape:opacity"),
            "CA" => number_object(2.0),
        };
        let document = single_page_document(vec![(highlight, true), (square, true)]);
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();

        let PdfAnnotationParseEntry::Highlight(highlight) = &entries[0] else {
            panic!("expected highlight, got {:?}", entries[0]);
        };
        assert_eq!(highlight.opacity, 1.0);
        let PdfAnnotationParseEntry::Shape(shape) = &entries[1] else {
            panic!("expected shape, got {:?}", entries[1]);
        };
        assert_eq!(shape.opacity, 1.0);
    }

    #[test]
    fn rejects_text_box_font_size_above_512() {
        let text_box = dictionary! {
            "Type" => "Annot",
            "Subtype" => "FreeText",
            "Rect" => rect(20.0, 20.0, 120.0, 60.0),
            "NM" => text("text-box-too-large"),
            "Contents" => text("too large"),
            "DA" => Object::string_literal("/Helv 512.01 Tf 0 0 0 rg"),
        };
        let document = single_page_document(vec![(text_box, true)]);
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let PdfAnnotationParseEntry::Foreign(foreign) = &entries[0] else {
            panic!("expected foreign, got {:?}", entries[0]);
        };
        assert!(foreign.reason.contains("font size"), "{}", foreign.reason);
    }

    #[test]
    fn parses_fixtures_written_by_the_current_app_for_every_new_kind() {
        // Highlight: created through the writer's markup mutation path.
        let (mut document, _) = single_page_writer_document();
        apply_markup_mutations(
            &mut document,
            &MarkupMutation {
                overrides: Vec::new(),
                hints: vec![MarkupSubtypeHint {
                    subtype: "Highlight".to_string(),
                    page_index: 0,
                    marker_rect: MarkerRect {
                        left: 0.1,
                        top: 0.2,
                        width: 0.5,
                        height: 0.1,
                    },
                    markup_geometry: None,
                    annotation_id: None,
                    app_annotation_id: None,
                    color: Some("#ffcc00".to_string()),
                    contents: Some("app text".to_string()),
                    id: Some("app-highlight".to_string()),
                    page_markup_index: Some(0),
                    source: Some("editor".to_string()),
                }],
            },
            "D:20260830130000Z",
        )
        .unwrap();
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let highlight = match &entries[0] {
            PdfAnnotationParseEntry::Highlight(value) => value,
            other => panic!("expected highlight, got {other:?}"),
        };
        assert_eq!(highlight.subtype, "Highlight");
        assert_eq!(highlight.contents, "app text");
        assert_eq!(highlight.quad_points.len(), 1);
        assert!((highlight.quad_points[0].left - 0.1).abs() < 1e-6);
        assert!((highlight.quad_points[0].top - 0.2).abs() < 1e-6);
        assert!((highlight.quad_points[0].width - 0.5).abs() < 1e-6);
        assert!((highlight.quad_points[0].height - 0.1).abs() < 1e-6);
        assert_eq!(highlight.opacity, 1.0);

        // Stamp: created through the placed-image writer path. The writer
        // must also report the new object as an identity binding.
        let (mut document, _) = single_page_writer_document();
        let jpeg_bytes = minimal_stamp_jpeg_bytes();
        let mut stamp_bindings = Vec::new();
        apply_placed_images(
            &mut document,
            &[PlacedImage {
                page_index: 0,
                stable_key: Some("stamp-stable".to_string()),
                annotation_id: None,
                x: 0.1,
                y: 0.3,
                width: 0.3,
                height: 0.2,
                rotation_degrees: None,
                mime_type: "image/jpeg".to_string(),
                bytes_path: PathBuf::from("stamp-fixture.jpg"),
                byte_length: jpeg_bytes.len() as u64,
                sha256: sha256_hex(&jpeg_bytes),
                validated_bytes: std::cell::RefCell::new(None),
            }],
            vec![jpeg_bytes.clone()],
            0,
            "D:20260830130000Z",
            &mut Some(&mut stamp_bindings),
        )
        .unwrap();
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let stamp = match &entries[0] {
            PdfAnnotationParseEntry::Stamp(value) => value,
            other => panic!("expected stamp, got {other:?}"),
        };
        assert_marker_rect_approx(&stamp.rect, 0.1, 0.3, 0.3, 0.2);
        assert_eq!(stamp.rotation, 0);
        assert_eq!(stamp.image.sha256, sha256_hex(&jpeg_bytes));
        assert_eq!(stamp_bindings.len(), 1);
        assert_eq!(stamp_bindings[0].annotation_id, "stamp-stable");

        // Shape: created through the shape writer path, with bindings.
        let (mut document, _) = single_page_writer_document();
        let mut shape_bindings = Vec::new();
        apply_shape_annotations(
            &mut document,
            &ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: false,
                shapes: vec![ShapeAnnotation {
                    shape_type: "rectangle".to_string(),
                    page_index: 0,
                    x: 0.1,
                    y: 0.2,
                    width: 0.5,
                    height: 0.4,
                    x2: None,
                    y2: None,
                    color: "#ff0000".to_string(),
                    fill_color: None,
                    opacity: 1.0,
                    stroke_width: 2.0,
                    points: Vec::new(),
                    strokes: Vec::new(),
                    annotation_id: None,
                    stable_key: Some("shape-stable".to_string()),
                    pdf_subtype: None,
                    line_start_style: None,
                    line_end_style: None,
                    created_at: None,
                    modified_at: None,
                }],
                deleted_annotation_ids: Vec::new(),
                deleted_stable_keys: Vec::new(),
            },
            "D:20260830130000Z",
            &mut Some(&mut shape_bindings),
        )
        .unwrap();
        let entries = collect_parsed_annotations(&document, "D:20260830130000Z").unwrap();
        let shape = match &entries[0] {
            PdfAnnotationParseEntry::Shape(value) => value,
            other => panic!("expected shape, got {other:?}"),
        };
        assert_eq!(shape.pdf_subtype, "Square");
        assert_eq!(shape.shape_type, "rectangle");
        assert!((shape.x - 0.1).abs() < 1e-6);
        assert!((shape.y - 0.2).abs() < 1e-6);
        assert_eq!(shape_bindings.len(), 1);
        assert_eq!(shape_bindings[0].annotation_id, "shape-stable");
        assert_eq!(
            shape_bindings[0].pdf_ref,
            format!("{} {} R", shape.object_number, shape.generation_number)
        );
    }

    fn minimal_stamp_jpeg_bytes() -> Vec<u8> {
        vec![
            0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11,
            0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xFF, 0xD9,
        ]
    }

    fn single_page_writer_document() -> (Document, ObjectId) {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => rect(0.0, 0.0, 200.0, 100.0),
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        (document, page_id)
    }
}
