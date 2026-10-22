//! Replaces the images of scanned pages in place with smaller re-encodings.
//!
//! Each instruction pairs a page of the input with a page of a replacement PDF
//! that holds the same page rendered in display orientation and encoded more
//! compactly. A page qualifies when everything it paints comes from images:
//! text on it must be hidden OCR text, and it must not draw Form XObjects. A
//! qualifying page keeps its dictionary, so bookmarks, links, page labels and
//! annotations that name it stay valid; only its content and resources change
//! to the replacement drawn over the page view plus the page's own hidden text.
//! A page keeps its content when the replacement does not save enough bytes.

use super::*;
use crate::split_pages::PdfMatrix;
use lopdf::content::{Content, Operation as ContentOperation};
use lopdf::dictionary;
use serde::Serialize;
use std::path::PathBuf;

const REPLACEMENT_XOBJECT_NAME: &str = "EvbOptimizedPage";
const MAX_REPLACEMENT_CONTENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_STREAM_GRAPH_DEPTH: usize = 64;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplacePageImagesFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) pages: Vec<ReplacePageImagesPage>,
    /// A replacement is used only when its bytes are at most this fraction of
    /// the bytes the page's own content and images take.
    pub(crate) max_byte_ratio: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplacePageImagesPage {
    /// One-based page number in the input.
    pub(crate) page_number: u32,
    pub(crate) replacement: PathBuf,
    /// One-based page number in `replacement`.
    pub(crate) replacement_page_number: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ReplacePageOutcome {
    Replaced,
    NotSmaller,
    NoImages,
    VisibleText,
    VisibleDrawing,
    FormXobject,
    UnsupportedText,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplacePageReport {
    page_number: u32,
    outcome: ReplacePageOutcome,
    source_bytes: u64,
    replacement_bytes: u64,
}

pub(crate) fn read_replace_page_images_file(path: &Path) -> Result<ReplacePageImagesFile> {
    let instructions: ReplacePageImagesFile =
        read_json_sidecar(path, "replace-page-images instructions")?;
    if !(instructions.max_byte_ratio > 0.0 && instructions.max_byte_ratio <= 1.0) {
        return Err("replace-page-images maxByteRatio must be in (0, 1]".into());
    }
    let mut seen = HashSet::new();
    for page in &instructions.pages {
        if page.page_number == 0 || page.replacement_page_number == 0 {
            return Err("replace-page-images page numbers are one-based".into());
        }
        if !seen.insert(page.page_number) {
            return Err("replace-page-images names a page more than once".into());
        }
    }
    Ok(instructions)
}

struct LoadedReplacement {
    path: PathBuf,
    document: Document,
    resolver: PageTreeResolver,
    copied: HashMap<ObjectId, ObjectId>,
}

pub(crate) fn write_replace_page_images_path(
    input_path: &Path,
    output_path: &Path,
    instructions: &ReplacePageImagesFile,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let mut incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let structural = StructuralSource::for_path(input_path, qpdf_path);
    let resolver = PageTreeResolver::new(&incremental.previous_document)?;
    let mut replacement: Option<LoadedReplacement> = None;
    let mut reports = Vec::with_capacity(instructions.pages.len());
    for page in &instructions.pages {
        if replacement
            .as_ref()
            .is_none_or(|loaded| loaded.path != page.replacement)
        {
            let document = load_pdf_path(&page.replacement).map_err(|error| {
                classify_pdf_load_error(error, "Failed to parse replacement PDF")
            })?;
            replacement = Some(LoadedReplacement {
                path: page.replacement.clone(),
                resolver: PageTreeResolver::new(&document)?,
                document,
                copied: HashMap::new(),
            });
        }
        let loaded = replacement
            .as_mut()
            .ok_or("replace-page-images replacement is not loaded")?;
        let page_id = resolver.page_id(&incremental.previous_document, page.page_number)?;
        let replacement_page_id = loaded
            .resolver
            .page_id(&loaded.document, page.replacement_page_number)?;
        let (outcome, source_bytes, replacement_bytes) = replace_page_images(
            &mut incremental,
            structural,
            page_id,
            loaded,
            replacement_page_id,
            instructions.max_byte_ratio,
        )?;
        reports.push(ReplacePageReport {
            page_number: page.page_number,
            outcome,
            source_bytes,
            replacement_bytes,
        });
    }

    if reports
        .iter()
        .any(|report| report.outcome == ReplacePageOutcome::Replaced)
    {
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
        })?;
    }
    serde_json::to_writer(
        std::io::stdout().lock(),
        &serde_json::json!({
            "format": "evb-pdf-replace-page-images",
            "pages": reports,
        }),
    )?;
    Ok(())
}

/// Encoded bytes of a stream as stored in the file. A structural load keeps
/// only the dictionary of an unread stream, so its declared length stands in.
fn encoded_stream_len(document: &Document, stream: &Stream) -> u64 {
    if !is_unread_base_stream(document, stream) {
        return stream.content.len() as u64;
    }
    stream
        .dict
        .get(b"Length")
        .ok()
        .and_then(|length| document.dereference(length).ok())
        .and_then(|(_, length)| length.as_i64().ok())
        .map_or(0, |length| length.max(0) as u64)
}

/// Sums the encoded bytes of every stream reachable from `roots`, counting a
/// shared stream once. Page and page-tree dictionaries are not followed.
fn reachable_stream_bytes(document: &Document, roots: &[&Object]) -> Result<u64> {
    fn visit(
        document: &Document,
        object: &Object,
        seen: &mut HashSet<ObjectId>,
        total: &mut u64,
        depth: usize,
    ) -> Result<()> {
        if depth > MAX_STREAM_GRAPH_DEPTH {
            return Err("replace-page-images resource graph is too deep".into());
        }
        match object {
            Object::Reference(id) => {
                if !seen.insert(*id) {
                    return Ok(());
                }
                if let Ok(target) = document.get_object(*id) {
                    visit(document, target, seen, total, depth + 1)?;
                }
            }
            Object::Array(items) => {
                for item in items {
                    visit(document, item, seen, total, depth + 1)?;
                }
            }
            Object::Dictionary(dictionary) => {
                if matches!(
                    dictionary.get(b"Type").and_then(Object::as_name),
                    Ok(b"Page" | b"Pages")
                ) {
                    return Ok(());
                }
                for (_, value) in dictionary.iter() {
                    visit(document, value, seen, total, depth + 1)?;
                }
            }
            Object::Stream(stream) => {
                *total += encoded_stream_len(document, stream);
                for (key, value) in stream.dict.iter() {
                    if key.as_slice() != b"Length" {
                        visit(document, value, seen, total, depth + 1)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut seen = HashSet::new();
    let mut total = 0;
    for root in roots {
        visit(document, root, &mut seen, &mut total, 0)?;
    }
    Ok(total)
}

/// The page's effective /XObject resource dictionary, nearest first.
fn page_xobjects(document: &Document, page_id: ObjectId) -> Result<Option<Dictionary>> {
    let (direct, inherited) = document.get_page_resources(page_id)?;
    let candidates = direct.into_iter().chain(
        inherited
            .into_iter()
            .filter_map(|id| document.get_dictionary(id).ok()),
    );
    for resources in candidates {
        if let Ok(xobjects) = resources.get(b"XObject") {
            if let Ok((_, Object::Dictionary(xobjects))) = document.dereference(xobjects) {
                return Ok(Some(xobjects.clone()));
            }
        }
    }
    Ok(None)
}

/// Reads the page's content streams that a structural load left unread.
fn materialize_page_contents(
    incremental: &mut IncrementalDocument,
    structural: Option<StructuralSource<'_>>,
    page_id: ObjectId,
) -> Result<()> {
    let Some(source) = structural else {
        return Ok(());
    };
    for content_id in incremental.previous_document.get_page_contents(page_id) {
        incremental.materialize_base_stream(
            source.input_path,
            source.qpdf_path,
            content_id,
            MAX_REPLACEMENT_CONTENT_BYTES,
        )?;
    }
    Ok(())
}

/// Whether an image draws over the whole page view with nothing showing
/// through it, which hides anything painted before it.
fn is_opaque_cover(image: &Dictionary, placement: PdfMatrix, view: PdfRect) -> bool {
    let transparent = image.has(b"SMask")
        || image.has(b"Mask")
        || image
            .get(b"ImageMask")
            .and_then(Object::as_bool)
            .unwrap_or(false);
    let drawn = placement.bounds(PdfRect {
        x1: 0.0,
        y1: 0.0,
        x2: 1.0,
        y2: 1.0,
    });
    let tolerance = (view.width().min(view.height()) * 0.005).max(1.0);
    !transparent
        && drawn.x1 <= view.x1 + tolerance
        && drawn.y1 <= view.y1 + tolerance
        && drawn.x2 >= view.x2 - tolerance
        && drawn.y2 >= view.y2 - tolerance
}

/// Whether everything the page shows comes from images. Text and drawings
/// may be hidden by an opaque image drawn over the whole page after them, as
/// searchable-image scans from Acrobat do; text also by rendering mode 3.
fn classify_page(
    document: &Document,
    page_id: ObjectId,
    operations: &[ContentOperation],
) -> Result<Option<ReplacePageOutcome>> {
    let xobjects = page_xobjects(document, page_id)?;
    let view = resolve_page_view(document, page_id)?;
    let mut placement = PdfMatrix::IDENTITY;
    let mut mode = 0;
    let mut saved = Vec::new();
    let mut draws_image = false;
    let mut shows_text = false;
    let mut shows_drawing = false;
    for operation in operations {
        match operation.operator.as_str() {
            "q" => saved.push((placement, mode)),
            "Q" => (placement, mode) = saved.pop().unwrap_or((placement, mode)),
            "cm" => match PdfMatrix::from_operation(operation) {
                Some(matrix) => placement = placement.concat(matrix),
                None => return Ok(Some(ReplacePageOutcome::UnsupportedText)),
            },
            "Tr" => match operation
                .operands
                .first()
                .and_then(|value| object_to_f64(value).ok())
            {
                Some(value) if value.fract() == 0.0 && (0.0..=7.0).contains(&value) => {
                    mode = value as i64;
                }
                _ => return Ok(Some(ReplacePageOutcome::UnsupportedText)),
            },
            "Tj" | "TJ" | "'" | "\"" => {
                // Clipping text shapes what is painted after it.
                if mode >= 4 {
                    return Ok(Some(ReplacePageOutcome::UnsupportedText));
                }
                shows_text |= mode != 3;
            }
            // Paths and shadings would be flattened into the page image.
            "f" | "F" | "f*" | "S" | "s" | "B" | "B*" | "b" | "b*" | "sh" => {
                shows_drawing = true;
            }
            "BI" => draws_image = true,
            "Do" => {
                let xobject = operation
                    .operands
                    .first()
                    .and_then(|name| name.as_name().ok())
                    .and_then(|name| xobjects.as_ref()?.get(name).ok())
                    .and_then(|xobject| document.dereference(xobject).ok())
                    .and_then(|(_, xobject)| xobject.as_stream().ok());
                let Some(xobject) = xobject else {
                    return Ok(Some(ReplacePageOutcome::FormXobject));
                };
                // A Form XObject may paint text or vectors this page cannot keep.
                if xobject.dict.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Image") {
                    return Ok(Some(ReplacePageOutcome::FormXobject));
                }
                draws_image = true;
                if is_opaque_cover(&xobject.dict, placement, view) {
                    shows_text = false;
                    shows_drawing = false;
                }
            }
            _ => {}
        }
    }
    if shows_text {
        return Ok(Some(ReplacePageOutcome::VisibleText));
    }
    if shows_drawing {
        return Ok(Some(ReplacePageOutcome::VisibleDrawing));
    }
    Ok((!draws_image).then_some(ReplacePageOutcome::NoImages))
}

fn replace_page_images(
    incremental: &mut IncrementalDocument,
    structural: Option<StructuralSource<'_>>,
    page_id: ObjectId,
    replacement: &mut LoadedReplacement,
    replacement_page_id: ObjectId,
    max_byte_ratio: f64,
) -> Result<(ReplacePageOutcome, u64, u64)> {
    let source_bytes = {
        let document = &incremental.previous_document;
        let page = document.get_dictionary(page_id)?;
        let contents = page.get(b"Contents").cloned().unwrap_or(Object::Null);
        let xobjects = page_xobjects(document, page_id)?
            .map(Object::Dictionary)
            .unwrap_or(Object::Null);
        reachable_stream_bytes(document, &[&contents, &xobjects])?
    };

    materialize_page_contents(incremental, structural, page_id)?;
    let document = &incremental.previous_document;
    let page_content =
        match page_content_with_limit(document, page_id, MAX_REPLACEMENT_CONTENT_BYTES) {
            Ok(bytes) => bytes,
            Err(_) => return Ok((ReplacePageOutcome::UnsupportedText, source_bytes, 0)),
        };
    let Ok(content) = Content::decode(&page_content) else {
        return Ok((ReplacePageOutcome::UnsupportedText, source_bytes, 0));
    };
    if let Some(outcome) = classify_page(document, page_id, &content.operations)? {
        return Ok((outcome, source_bytes, 0));
    }

    // The page's hidden text, kept in its own coordinates. Its fonts are the
    // page's own objects, so the new resources only name them again.
    let (text_operations, used_fonts) = text_operations(document, page_id, None)?;
    let has_text = text_operations
        .iter()
        .any(|operation| operation.operator == "BT");
    let mut fonts = Dictionary::new();
    if has_text {
        let page_fonts = page_fonts(document, page_id)?;
        for name in used_fonts {
            let Some(font) = page_fonts.get(&name) else {
                return Ok((ReplacePageOutcome::UnsupportedText, source_bytes, 0));
            };
            fonts.set(name, font.clone());
        }
    }

    let view = resolve_page_view(document, page_id)?;
    let rotation = resolve_page_rotation(document, page_id)?;
    let replacement_view = resolve_page_view(&replacement.document, replacement_page_id)?;
    let matrix = ocr_layer_matrix(view, rotation, replacement_view, None)?;

    let mut operations = vec![
        ContentOperation::new("q", vec![]),
        ContentOperation::new("cm", matrix.iter().map(|&value| value.into()).collect()),
        ContentOperation::new("Do", vec![Object::Name(REPLACEMENT_XOBJECT_NAME.into())]),
        ContentOperation::new("Q", vec![]),
    ];
    if has_text {
        operations.push(ContentOperation::new("q", vec![]));
        operations.extend(text_operations);
        operations.push(ContentOperation::new("Q", vec![]));
    }
    let mut page_stream = Stream::new(Dictionary::new(), Content { operations }.encode()?);
    page_stream.compress()?;

    let replacement_page = replacement.document.get_dictionary(replacement_page_id)?;
    let replacement_resources = replacement_page
        .get(b"Resources")
        .cloned()
        .unwrap_or_else(|_| Object::Dictionary(Dictionary::new()));
    let mut form = Stream::new(
        Dictionary::new(),
        page_content_with_limit(
            &replacement.document,
            replacement_page_id,
            MAX_REPLACEMENT_CONTENT_BYTES,
        )?,
    );
    form.compress()?;
    let replacement_bytes =
        reachable_stream_bytes(&replacement.document, &[&replacement_resources])?
            + form.content.len() as u64
            + page_stream.content.len() as u64;
    if source_bytes == 0 || replacement_bytes as f64 > source_bytes as f64 * max_byte_ratio {
        return Ok((
            ReplacePageOutcome::NotSmaller,
            source_bytes,
            replacement_bytes,
        ));
    }

    let resources = clone_object_graph(
        &replacement.document,
        &mut incremental.new_document,
        &replacement_resources,
        &mut replacement.copied,
        (&[], &|_| Ok(None)),
        &|_, _| Ok(()),
        0,
    )?;
    form.dict.set("Type", "XObject");
    form.dict.set("Subtype", "Form");
    form.dict.set(
        "BBox",
        vec![
            replacement_view.x1.into(),
            replacement_view.y1.into(),
            replacement_view.x2.into(),
            replacement_view.y2.into(),
        ],
    );
    form.dict.set("Resources", resources);
    let form_id = incremental.new_document.add_object(form);
    let content_id = incremental.new_document.add_object(page_stream);

    if !incremental.new_document.has_object(page_id) {
        prepare_incremental_overlay_page(incremental, page_id)?;
    }
    let mut page_resources = dictionary! {
        "XObject" => dictionary! { REPLACEMENT_XOBJECT_NAME => form_id },
    };
    if !fonts.is_empty() {
        page_resources.set("Font", fonts);
    }
    let page = incremental.new_document.get_dictionary_mut(page_id)?;
    page.set("Contents", Object::Reference(content_id));
    page.set("Resources", page_resources);
    Ok((
        ReplacePageOutcome::Replaced,
        source_bytes,
        replacement_bytes,
    ))
}
