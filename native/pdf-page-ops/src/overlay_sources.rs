use super::*;
use crate::overlay_destinations::{carry_named_destinations, OverlayDestinations};
use evb_native_support::output::AtomicOutput;
use std::path::Path;

pub(crate) const MAX_SOURCE_PAGE_BATCH_PAGES: usize = 64;
const MAX_CLASSIC_XREF_OFFSET: u64 = 9_999_999_999;

pub(crate) fn read_text_layer_file(path: &Path) -> Result<TextLayerFile> {
    validate_text_layer(read_json_sidecar(path, "text-layer instructions")?)
}

fn validate_text_layer(instructions: TextLayerFile) -> Result<TextLayerFile> {
    if instructions.pages.is_empty() {
        return Err("overlay-text requires at least one page instruction".into());
    }
    let mut output_pages = HashSet::new();
    for instruction in &instructions.pages {
        overlay_page_number(instruction.source_page_index, "sourcePageIndex")?;
        overlay_page_number(instruction.output_page_index, "outputPageIndex")?;
        if !instruction
            .matrix
            .into_iter()
            .all(crate::split_pages::is_instruction_number)
        {
            return Err(
                "overlay-text matrix values must be finite and within the instruction range".into(),
            );
        }
        let determinant = instruction.matrix[0] * instruction.matrix[3]
            - instruction.matrix[1] * instruction.matrix[2];
        if determinant.abs() <= f64::EPSILON {
            return Err("overlay-text matrix must be invertible".into());
        }
        if let Some(region) = instruction.source_region {
            crate::split_pages::validate_crop_rect(region.rect)?;
            let determinant =
                region.matrix[0] * region.matrix[3] - region.matrix[1] * region.matrix[2];
            if !region
                .matrix
                .into_iter()
                .all(crate::split_pages::is_instruction_number)
                || !determinant.is_finite()
                || determinant.abs() <= f64::EPSILON
            {
                return Err(
                    "overlay-text sourceRegion matrix must be finite, in range and invertible"
                        .into(),
                );
            }
        }
        if !output_pages.insert(instruction.output_page_index) {
            return Err("overlay-text outputPageIndex values must be unique".into());
        }
    }
    if let Some(stamp) = instructions.provenance_stamp_hex.as_deref() {
        crate::split_pages::validate_provenance_stamp_hex(stamp)?;
    }
    Ok(instructions)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextLayerFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) pages: Vec<TextLayerInstruction>,
    /// A run assembled from several batches has one provenance stamp for the
    /// whole document; the overlay is the one pass over that document.
    #[serde(default)]
    pub(crate) provenance_stamp_hex: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextLayerInstruction {
    pub(crate) source_page_index: usize,
    pub(crate) output_page_index: usize,
    /// PDF `cm` operands mapping source-page user space into output-page user space.
    pub(crate) matrix: [f64; 6],
    /// Source half before cleanup and canvas placement, in cleanup raster space.
    #[serde(default)]
    pub(crate) source_region: Option<TextLayerSourceRegion>,
    /// PDF text extraction commonly ignores clipping. Split pages therefore
    /// filter show operators by their positioned origin in target-page space.
    #[serde(default)]
    pub(crate) filter_to_output_page: bool,
    /// Tesseract's Greek OCR output uses U+00B5 for Greek mu in its PDF text
    /// stream. The glyph-less Identity-H font makes the CID the Unicode
    /// scalar, so normalize that scalar before embedding the stream.
    #[serde(default)]
    pub(crate) normalize_greek_micro_sign: bool,
    /// The output page is named by links only. Its text and annotations are
    /// copied by another subset; this run maps its destinations and nothing more.
    #[serde(default)]
    pub(crate) link_only: bool,
    /// Without affine geometry the page's `matrix` is a placeholder. Only a
    /// destination that names no coordinate resolves to this output page.
    #[serde(default)]
    pub(crate) unmapped_geometry: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextLayerSourceRegion {
    pub(crate) rect: SplitCropRect,
    pub(crate) matrix: [f64; 6],
}

pub(crate) type OverlayPage<'a> = (ObjectId, ObjectId, &'a TextLayerInstruction, PdfRect);

/// Returns the output pages whose source text could not be measured onto
/// them and was therefore left off.
fn append_overlay_pages(
    target: &mut Document,
    source: &Document,
    instructions: &TextLayerFile,
    base: Option<&Document>,
    cached_target_resolver: Option<&PageTreeResolver>,
) -> Result<Vec<usize>> {
    let source_resolver = PageTreeResolver::new(source)?;
    let owned_target_resolver;
    let target_resolver = match cached_target_resolver {
        Some(resolver) => resolver,
        None => {
            owned_target_resolver = PageTreeResolver::new(base.unwrap_or(target))?;
            &owned_target_resolver
        }
    };
    let pages: Vec<OverlayPage<'_>> = instructions
        .pages
        .iter()
        .map(|instruction| {
            let source_number =
                overlay_page_number(instruction.source_page_index, "sourcePageIndex")?;
            let target_number =
                overlay_page_number(instruction.output_page_index, "outputPageIndex")?;
            let target_page = target_resolver.page_id(base.unwrap_or(target), target_number)?;
            Ok((
                source_resolver.page_id(source, source_number)?,
                target_page,
                instruction,
                resolve_page_view(base.unwrap_or(target), target_page)?,
            ))
        })
        .collect::<Result<_>>()?;
    let remap = crate::split_navigation::split_destination_mapper(source, &pages);
    let mut copied = HashMap::new();
    let mut omitted = Vec::new();
    for &(source_id, target_id, instruction, _) in pages.iter().filter(|p| !p.2.link_only) {
        crate::ocr_layer_contents::form_text_omission(source, source_id)?;
        // The new-document object map already owns materialization.
        if let Some(base) = base.filter(|_| !target.has_object(target_id)) {
            prepare_overlay_page(base, target, target_id)?;
        }
        append_source_annotations(
            target,
            source,
            target_id,
            source_id,
            instruction,
            (&pages, &remap),
        )?;
        let skipped = append_text_layer(
            target,
            source,
            target_id,
            source_id,
            instruction.matrix,
            instruction.filter_to_output_page,
            instruction.normalize_greek_micro_sign,
            None,
            &mut copied,
        )?;
        if let Some(reason) = skipped {
            eprintln!(
                "{}",
                serde_json::json!({
                    "level": "warning",
                    "event": "scan_cleanup_text_overlay_skipped",
                    "sourcePageIndex": instruction.source_page_index,
                    "outputPageIndex": instruction.output_page_index,
                    "reason": reason,
                })
            );
            omitted.push(instruction.output_page_index);
        }
    }
    Ok(omitted)
}

pub(crate) fn overlay_text_layers(
    target: &mut Document,
    source: &Document,
    instructions: &TextLayerFile,
) -> Result<Vec<usize>> {
    let omitted = append_overlay_pages(target, source, instructions, None, None)?;
    target.prune_objects();
    // Compress new OCR streams without changing already-compressed images.
    target.compress();
    Ok(omitted)
}

/// Materialize only the target page dictionaries touched by an overlay. The
/// source page content remains in the base revision, while new OCR streams and
/// copied font objects go into the incremental revision.
pub(crate) fn prepare_incremental_overlay_page(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
) -> Result<()> {
    prepare_overlay_page(
        &incremental.previous_document,
        &mut incremental.new_document,
        page_id,
    )
}

fn prepare_overlay_page(base: &Document, target: &mut Document, page_id: ObjectId) -> Result<()> {
    let parent = base.get_dictionary(page_id)?.get(b"Parent").ok().cloned();
    let mut page = materialized_page_dictionary(base, page_id)?;
    page.set("Rotate", resolve_page_rotation(base, page_id)?);
    if let Some(parent) = parent {
        page.set("Parent", parent);
    }
    if let Some(resources) = page.get(b"Resources").ok().cloned() {
        let (_, resources) = base.dereference(&resources)?;
        let mut resources = resources.as_dict()?.clone();
        if let Some(fonts) = resources.get(b"Font").ok().cloned() {
            if let Ok((_, fonts)) = base.dereference(&fonts) {
                if let Ok(fonts) = fonts.as_dict() {
                    resources.set("Font", Object::Dictionary(fonts.clone()));
                }
            }
        }
        page.set("Resources", Object::Dictionary(resources));
    }

    if let Ok(annotations) = page.get(b"Annots") {
        page.set(
            "Annots",
            base.dereference(annotations)?.1.as_array()?.clone(),
        );
    }

    // Normalize nested /Contents arrays while the base structure is available.
    // This keeps `Document::add_page_contents` from treating an indirect array
    // as if it were a stream reference in the new revision.
    if page.get(b"Contents").is_ok() {
        let content_ids = content_stream_ids_from_base(base, target, &page)?;
        page.set(
            "Contents",
            Object::Array(content_ids.into_iter().map(Object::Reference).collect()),
        );
    }
    target.set_object(page_id, Object::Dictionary(page));
    Ok(())
}

#[cfg(test)]
pub(crate) fn overlay_text_layers_incremental(
    incremental: &mut IncrementalDocument,
    source: &Document,
    instructions: &TextLayerFile,
) -> Result<Vec<usize>> {
    overlay_text_layers_incremental_with_resolver(incremental, source, instructions, None)
}

fn overlay_text_layers_incremental_with_resolver(
    incremental: &mut IncrementalDocument,
    source: &Document,
    instructions: &TextLayerFile,
    target_resolver: Option<&PageTreeResolver>,
) -> Result<Vec<usize>> {
    append_overlay_pages(
        &mut incremental.new_document,
        source,
        instructions,
        Some(&incremental.previous_document),
        target_resolver,
    )
}

enum OverlaySourceBatchFailure {
    TooLarge,
    Failed(Box<dyn Error>),
}

pub(crate) fn overlay_page_number(index: usize, label: &str) -> Result<u32> {
    let number = index
        .checked_add(1)
        .ok_or_else(|| format!("overlay-text {label} is too large"))?;
    u32::try_from(number).map_err(|_| format!("overlay-text {label} is too large").into())
}

fn is_too_large_error(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<NativeError>()
        .is_some_and(|error| error.code == NativeErrorCode::TooLarge)
}

/// The destination an annotation navigates to, unresolved: its `/Dest`, or else
/// the `/D` of its `/A` action.
pub(crate) fn annotation_destination(
    document: &Document,
    annotation: &Dictionary,
) -> Option<Object> {
    let action = annotation
        .get(b"A")
        .ok()
        .and_then(|action| document.dereference(action).ok())
        .and_then(|(_, action)| goto_destination(document, action.as_dict().ok()?));
    let destination = annotation.get(b"Dest").ok().or(action)?;
    Some(document.dereference(destination).ok()?.1.clone())
}

fn referenced_source_pages(instructions: &TextLayerFile) -> Result<Vec<usize>> {
    let mut pages = instructions
        .pages
        .iter()
        .filter(|instruction| !instruction.link_only)
        .map(|instruction| instruction.source_page_index)
        .collect::<Vec<_>>();
    pages.sort_unstable();
    pages.dedup();
    for page in &pages {
        overlay_page_number(*page, "sourcePageIndex")?;
    }
    Ok(pages)
}

#[cfg(test)]
thread_local! {
    static OVERLAY_REBASE_INSTRUCTION_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_overlay_rebase_instruction_visits() {
    OVERLAY_REBASE_INSTRUCTION_VISITS.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn overlay_rebase_instruction_visits() -> usize {
    OVERLAY_REBASE_INSTRUCTION_VISITS.with(std::cell::Cell::get)
}

/// Instructions indexed once by source page, preserving each instruction's
/// original position so subset rebasing runs in O(subset) instead of O(I).
struct IndexedTextLayerInstructions<'a> {
    by_source_page: HashMap<usize, Vec<(usize, &'a TextLayerInstruction)>>,
}

impl<'a> IndexedTextLayerInstructions<'a> {
    fn new(instructions: &'a TextLayerFile) -> Self {
        let mut by_source_page: HashMap<usize, Vec<(usize, &'a TextLayerInstruction)>> =
            HashMap::new();
        for (order, instruction) in instructions.pages.iter().enumerate() {
            by_source_page
                .entry(instruction.source_page_index)
                .or_default()
                .push((order, instruction));
        }
        Self { by_source_page }
    }

    /// The instructions of one subset: every output page whose source page the
    /// subset extracts, retaining their original order in `instructions.pages`.
    /// Only the batch's own pages copy text; the destination pages it also
    /// holds are mapped as link-only.
    fn rebase_subset(&self, pages: &[usize], text_pages: &[usize]) -> Result<TextLayerFile> {
        let text_pages = text_pages.iter().copied().collect::<HashSet<_>>();
        let mut ordered = Vec::new();
        for (local_index, &source_page) in pages.iter().enumerate() {
            if let Some(entries) = self.by_source_page.get(&source_page) {
                let copy_text = text_pages.contains(&source_page);
                for &(order, instruction) in entries {
                    #[cfg(test)]
                    OVERLAY_REBASE_INSTRUCTION_VISITS
                        .with(|count| count.set(count.get().saturating_add(1)));
                    ordered.push((
                        order,
                        TextLayerInstruction {
                            source_page_index: local_index,
                            output_page_index: instruction.output_page_index,
                            matrix: instruction.matrix,
                            filter_to_output_page: instruction.filter_to_output_page,
                            normalize_greek_micro_sign: instruction.normalize_greek_micro_sign,
                            source_region: instruction.source_region,
                            link_only: instruction.link_only || !copy_text,
                            unmapped_geometry: instruction.unmapped_geometry,
                        },
                    ));
                }
            }
        }
        if ordered.is_empty() {
            return Err("overlay-text source batch has no matching instructions".into());
        }
        ordered.sort_unstable_by_key(|(order, _)| *order);
        // A source batch copies text only; the run stamp is written once, with
        // the final navigation.
        Ok(TextLayerFile {
            pages: ordered
                .into_iter()
                .map(|(_, instruction)| instruction)
                .collect(),
            provenance_stamp_hex: None,
        })
    }
}

fn parse_revision_startxref(revision_bytes: &[u8]) -> Result<u64> {
    let marker = b"startxref";
    let pos = revision_bytes
        .windows(marker.len())
        .rposition(|window| window == marker)
        .ok_or("overlay-text appended revision is missing startxref")?;
    let tail = &revision_bytes[pos + marker.len()..];
    let digits_start = tail
        .iter()
        .position(|byte| byte.is_ascii_digit())
        .ok_or("overlay-text appended revision has invalid startxref offset")?;
    let digits_end = tail[digits_start..]
        .iter()
        .position(|byte| !byte.is_ascii_digit())
        .map_or(tail.len(), |end| digits_start + end);
    let text = std::str::from_utf8(&tail[digits_start..digits_end])
        .map_err(|_| "overlay-text appended revision has non-UTF8 startxref")?;
    text.parse::<u64>()
        .map_err(|_| "overlay-text appended revision startxref overflow".into())
}

fn reset_pending_overlay_revision(incremental: &mut IncrementalDocument) -> Result<()> {
    let previous_xref_start = incremental.previous_xref_start();
    incremental.new_document = Document::new_from_prev(&incremental.previous_document);
    incremental
        .new_document
        .trailer
        .set("Prev", i64::try_from(previous_xref_start)?);
    Ok(())
}

fn check_overlay_xref_budget(
    budget: &mut crate::pdf_source::IndexedXrefBudget,
    incremental: &IncrementalDocument,
    revision_bytes: &[u8],
    expected_object_ids: &[ObjectId],
) -> Result<()> {
    if revision_bytes.is_empty() {
        return Ok(());
    }
    let new_xref_start = parse_revision_startxref(revision_bytes)?;
    let was_xref_stream = matches!(
        incremental
            .get_prev_documents()
            .reference_table
            .cross_reference_type,
        lopdf::xref::XrefType::CrossReferenceStream
    );
    let wrote_xref_stream = was_xref_stream || new_xref_start > MAX_CLASSIC_XREF_OFFSET;
    let previous_objects = &incremental.get_prev_documents().objects;
    let new_objects = &incremental.new_document.objects;
    let mut new_object_numbers = 0usize;
    let mut net_value_delta = 0isize;
    let reopened_value_count = |object: &Object| -> isize {
        let stream_length_extra =
            usize::from(matches!(object, Object::Stream(stream) if !stream.dict.has(b"Length")));
        (crate::pdf_source::object_value_count(object) + stream_length_extra) as isize
    };
    for id in expected_object_ids {
        let Some(new_obj) = new_objects.get(id) else {
            continue;
        };
        let new_values = reopened_value_count(new_obj);
        if (new_values as usize).saturating_sub(1) > crate::pdf_source::MAX_OBJECT_ELEMENTS {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!(
                    "PDF object {} {} exceeds the {}-element ceiling",
                    id.0,
                    id.1,
                    crate::pdf_source::MAX_OBJECT_ELEMENTS
                ),
            ));
        }
        let old_values = match previous_objects.get(id) {
            Some(old_obj) => reopened_value_count(old_obj),
            None => {
                new_object_numbers += 1;
                0
            }
        };
        net_value_delta = net_value_delta.saturating_add(new_values - old_values);
    }
    budget.check_and_record_revision(
        expected_object_ids.len(),
        new_object_numbers,
        net_value_delta,
        wrote_xref_stream,
    )
}

/// Advances the indexed append base in place after a revision has been written
/// and verified, updating only objects touched by this revision (O(batch)).
fn advance_verified_overlay_append_base(
    incremental: &mut IncrementalDocument,
    revision_bytes: &[u8],
) -> Result<()> {
    if revision_bytes.is_empty() {
        return reset_pending_overlay_revision(incremental);
    }
    let new_len = incremental
        .previous_len()
        .checked_add(u64::try_from(revision_bytes.len())?)
        .ok_or("overlay-text output size overflow")?;
    let new_last_byte = revision_bytes.last().copied();
    let new_xref_start = parse_revision_startxref(revision_bytes)?;
    let was_xref_stream = matches!(
        incremental
            .get_prev_documents()
            .reference_table
            .cross_reference_type,
        lopdf::xref::XrefType::CrossReferenceStream
    );
    let wrote_xref_stream = was_xref_stream || new_xref_start > MAX_CLASSIC_XREF_OFFSET;
    incremental.advance_verified_revision(new_len, new_last_byte, new_xref_start, wrote_xref_stream)
}

struct PathBoundedVecWriter {
    buf: Vec<u8>,
    limit: usize,
}

impl Write for PathBoundedVecWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.buf.len().saturating_add(data.len()) > self.limit {
            return Err(std::io::Error::other(format!(
                "extracted overlay-text source exceeds byte admission ceiling ({} bytes)",
                self.limit
            )));
        }
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn try_write_overlay_source_batch(
    output_path: &Path,
    incremental: &mut IncrementalDocument,
    target_resolver: &PageTreeResolver,
    xref_budget: &mut crate::pdf_source::IndexedXrefBudget,
    source_pdf: &SourcePdf<File>,
    source_page_ids: &[ObjectId],
    pages: &[usize],
    indexed_instructions: &IndexedTextLayerInstructions<'_>,
    destinations: &OverlayDestinations,
    omitted: &mut Vec<usize>,
) -> std::result::Result<(), OverlaySourceBatchFailure> {
    let subset = destinations
        .subset_pages(pages)
        .map_err(OverlaySourceBatchFailure::Failed)?;
    let subset_pages_u32 = subset
        .pages
        .iter()
        .map(|&page| {
            u32::try_from(page + 1).map_err(|_| {
                OverlaySourceBatchFailure::Failed("overlay-text source page exceeds u32".into())
            })
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let extracted = crate::page_structure_edit::extract_validated_pages_for_overlay(
        &source_pdf.document,
        source_page_ids,
        &subset_pages_u32,
        destinations.named_destinations(),
    )
    .map_err(OverlaySourceBatchFailure::Failed)?;
    let subset_writer = extracted
        .write(
            std::slice::from_ref(source_pdf),
            PathBoundedVecWriter {
                buf: Vec::new(),
                limit: MAX_ENCODED_PDF_BYTES,
            },
        )
        .map_err(|error| {
            if is_too_large_error(error.as_ref())
                || error.to_string().contains("exceeds byte admission ceiling")
            {
                OverlaySourceBatchFailure::TooLarge
            } else {
                OverlaySourceBatchFailure::Failed(error)
            }
        })?;
    let mut source = match load_pdf_bytes_with_policy(&subset_writer.buf, PDF_PATH_LOAD_POLICY) {
        Ok(source) => source,
        Err(error) => {
            let error = classify_pdf_load_error(
                error,
                "Failed to parse extracted overlay-text source PDF structure",
            );
            return Err(if is_too_large_error(error.as_ref()) {
                OverlaySourceBatchFailure::TooLarge
            } else {
                OverlaySourceBatchFailure::Failed(error)
            });
        }
    };
    assert_plaintext_base(
        &source,
        "Encrypted source PDFs are not supported by native page ops",
    )
    .map_err(OverlaySourceBatchFailure::Failed)?;
    carry_named_destinations(&mut source, &subset).map_err(OverlaySourceBatchFailure::Failed)?;
    let batch_instructions = indexed_instructions
        .rebase_subset(&subset.pages, pages)
        .map_err(OverlaySourceBatchFailure::Failed)?;
    reset_pending_overlay_revision(incremental).map_err(OverlaySourceBatchFailure::Failed)?;
    let batch_omitted = match overlay_text_layers_incremental_with_resolver(
        incremental,
        &source,
        &batch_instructions,
        Some(target_resolver),
    ) {
        Ok(batch_omitted) => batch_omitted,
        Err(error) => {
            let _ = reset_pending_overlay_revision(incremental);
            return Err(if is_too_large_error(error.as_ref()) {
                OverlaySourceBatchFailure::TooLarge
            } else {
                OverlaySourceBatchFailure::Failed(error)
            });
        }
    };
    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    let revision_bytes = match build_incremental_revision(incremental) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = reset_pending_overlay_revision(incremental);
            return Err(OverlaySourceBatchFailure::Failed(error));
        }
    };
    let expected_object_ids = collect_incremental_append_object_ids(incremental);
    let mut next_budget = *xref_budget;
    if let Err(error) = check_overlay_xref_budget(
        &mut next_budget,
        incremental,
        &revision_bytes,
        &expected_object_ids,
    ) {
        let _ = reset_pending_overlay_revision(incremental);
        return Err(OverlaySourceBatchFailure::Failed(error));
    }
    if let Err(error) = write_incremental_revision(
        output_path,
        incremental,
        &revision_bytes,
        &expected_object_ids,
    ) {
        let _ = reset_pending_overlay_revision(incremental);
        return Err(OverlaySourceBatchFailure::Failed(error));
    }
    advance_verified_overlay_append_base(incremental, &revision_bytes)
        .map_err(OverlaySourceBatchFailure::Failed)?;
    *xref_budget = next_budget;
    omitted.extend(batch_omitted);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_overlay_source_batch_with_split(
    output_path: &Path,
    incremental: &mut IncrementalDocument,
    target_resolver: &PageTreeResolver,
    xref_budget: &mut crate::pdf_source::IndexedXrefBudget,
    source_pdf: &SourcePdf<File>,
    source_page_ids: &[ObjectId],
    pages: &[usize],
    indexed_instructions: &IndexedTextLayerInstructions<'_>,
    destinations: &OverlayDestinations,
    omitted: &mut Vec<usize>,
) -> Result<()> {
    match try_write_overlay_source_batch(
        output_path,
        incremental,
        target_resolver,
        xref_budget,
        source_pdf,
        source_page_ids,
        pages,
        indexed_instructions,
        destinations,
        omitted,
    ) {
        Ok(()) => Ok(()),
        Err(OverlaySourceBatchFailure::Failed(error)) => Err(error),
        Err(OverlaySourceBatchFailure::TooLarge) if pages.len() > 1 => {
            let midpoint = pages.len() / 2;
            write_overlay_source_batch_with_split(
                output_path,
                incremental,
                target_resolver,
                xref_budget,
                source_pdf,
                source_page_ids,
                &pages[..midpoint],
                indexed_instructions,
                destinations,
                omitted,
            )?;
            write_overlay_source_batch_with_split(
                output_path,
                incremental,
                target_resolver,
                xref_budget,
                source_pdf,
                source_page_ids,
                &pages[midpoint..],
                indexed_instructions,
                destinations,
                omitted,
            )
        }
        Err(OverlaySourceBatchFailure::TooLarge) => {
            let page = pages
                .first()
                .copied()
                .ok_or("overlay-text source batch cannot be empty")?;
            Err(domain_error(
                NativeErrorCode::TooLarge,
                format!(
                    "overlay-text source page {page} exceeds the bounded decoder resource limit"
                ),
            ))
        }
    }
}

/// The browser's `overlayText`: what `write_overlay_text_layers_path` writes
/// when both documents are below the byte budget. The text layers are copied
/// in a full rewrite, then retained destinations, the source catalog and the
/// provenance stamp are appended over it as one revision.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn overlay_text_bytes(
    data: &[u8],
    source_data: &[u8],
    instructions: &[u8],
) -> Result<ReportedBytes> {
    let instructions = validate_text_layer(parse_json_sidecar_bytes(
        instructions,
        "text-layer instructions",
    )?)?;
    let mut target = load_pdf_bytes(data)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        &target,
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let source = load_pdf_bytes(source_data)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse source PDF structure"))?;
    assert_plaintext_base(
        &source,
        "Encrypted source PDFs are not supported by native page ops",
    )?;
    let omitted = overlay_text_layers(&mut target, &source, &instructions)?;
    // The rebind reads the source again by range; its eager copy goes first.
    drop(source);
    let mut output = save_document_to_bytes(&mut target)?;
    drop(target);
    let (_, mut incremental) = incremental_from_bytes(&output)?;
    let rebind = crate::split_navigation::rebind_retained_destinations_in(
        &mut incremental,
        crate::split_navigation::navigation_source(source_data, source_data.len() as u64)?,
        &instructions,
    )?;
    if rebind.appends_revision {
        let revision = appended_revision_bytes(&mut incremental)?;
        output
            .try_reserve_exact(revision.len())
            .map_err(|_| crate::wasm_abi::page_op_output_limit())?;
        output.extend_from_slice(&revision);
    }
    Ok(ReportedBytes {
        page_count: page_count(&incremental.previous_document),
        data: output,
        report: crate::split_pages::scan_cleanup_page_ops_report(
            rebind.accessibility_tags_removed,
            &omitted_source_pages(&instructions, &omitted),
        )?,
    })
}

/// Appends an overlay `revision` at `offset` in `sink` and returns the bytes
/// read back from `offset`. Unlike the shared append helper (which leaves empty
/// revisions as no-ops so no-op saves copy 0 bytes), an empty slice here calls
/// `Write::write(&[])` so `overlay_text_to_sink`'s staging seed materializes a
/// lazy-cloning host sink before the first batched read.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn write_overlay_append_revision_to_sink<S: Write + ByteSource>(
    sink: &mut S,
    offset: u64,
    revision: &[u8],
) -> Result<Vec<u8>> {
    if revision.is_empty() {
        sink.write(&[]).map_err(io_domain_error)?;
        return Ok(Vec::new());
    }
    sink.write_all(revision).map_err(io_domain_error)?;
    let mut written = vec![0; revision.len()];
    sink.read_at(offset, &mut written)
        .map_err(io_domain_error)?;
    Ok(written)
}

/// Adapter whose `copy_range` reads through `read_at` in chunks into any
/// `Write` (e.g. an in-memory `Vec<u8>`) instead of targeting `HostSink`.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
struct BufferedByteSource<S>(S);

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
impl<S: ByteSource> ByteSource for BufferedByteSource<S> {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> std::io::Result<()> {
        self.0.read_at(offset, buffer)
    }

    fn copy_range(&self, offset: u64, len: u64, output: &mut impl Write) -> std::io::Result<()> {
        let mut remaining = len;
        let mut cursor = offset;
        let mut buf = [0u8; 64 * 1024];
        while remaining > 0 {
            let chunk_len = remaining.min(buf.len() as u64) as usize;
            self.0.read_at(cursor, &mut buf[..chunk_len])?;
            output.write_all(&buf[..chunk_len])?;
            cursor += chunk_len as u64;
            remaining -= chunk_len as u64;
        }
        Ok(())
    }
}

/// Bounded in-memory sink so extracting a huge source batch fails fast with
/// `TooLarge` instead of allocating unbounded memory before `load_pdf_bytes`.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
struct BoundedVecWriter {
    buf: Vec<u8>,
    limit: usize,
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
impl Write for BoundedVecWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.buf.len().saturating_add(data.len()) > self.limit {
            return Err(std::io::Error::other(
                "Extracted overlay-text source batch exceeds byte admission ceiling",
            ));
        }
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
#[allow(clippy::too_many_arguments)]
fn write_overlay_source_batch_to_sink_with_split<S: ByteSource>(
    source_pdf: &SourcePdf<BufferedByteSource<S>>,
    source_page_ids: &[ObjectId],
    incremental: &mut IncrementalDocument,
    target_resolver: &PageTreeResolver,
    xref_budget: &mut crate::pdf_source::IndexedXrefBudget,
    current_len: &mut u64,
    pages: &[usize],
    indexed_instructions: &IndexedTextLayerInstructions<'_>,
    destinations: &OverlayDestinations,
    omitted: &mut Vec<usize>,
    append_at: &mut impl FnMut(u64, &[u8]) -> Result<Vec<u8>>,
) -> Result<()> {
    let attempt = (|| -> std::result::Result<(), OverlaySourceBatchFailure> {
        let subset = destinations
            .subset_pages(pages)
            .map_err(OverlaySourceBatchFailure::Failed)?;
        let subset_pages_u32 = subset
            .pages
            .iter()
            .map(|&page| {
                u32::try_from(page + 1).map_err(|_| {
                    OverlaySourceBatchFailure::Failed("overlay-text source page exceeds u32".into())
                })
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let extracted = crate::page_structure_edit::extract_validated_pages_for_overlay(
            &source_pdf.document,
            source_page_ids,
            &subset_pages_u32,
            destinations.named_destinations(),
        )
        .map_err(OverlaySourceBatchFailure::Failed)?;
        let subset_writer = extracted
            .write(
                std::slice::from_ref(source_pdf),
                BoundedVecWriter {
                    buf: Vec::new(),
                    limit: MAX_ENCODED_PDF_BYTES,
                },
            )
            .map_err(|error| {
                if is_too_large_error(error.as_ref())
                    || error.to_string().contains("exceeds byte admission ceiling")
                {
                    OverlaySourceBatchFailure::TooLarge
                } else {
                    OverlaySourceBatchFailure::Failed(error)
                }
            })?;
        let subset_bytes = subset_writer.buf;
        let mut source = match load_pdf_bytes(&subset_bytes) {
            Ok(source) => source,
            Err(error) => {
                let error = classify_pdf_load_error(
                    error,
                    "Failed to parse extracted overlay-text source PDF structure",
                );
                return Err(if is_too_large_error(error.as_ref()) {
                    OverlaySourceBatchFailure::TooLarge
                } else {
                    OverlaySourceBatchFailure::Failed(error)
                });
            }
        };
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )
        .map_err(OverlaySourceBatchFailure::Failed)?;
        carry_named_destinations(&mut source, &subset)
            .map_err(OverlaySourceBatchFailure::Failed)?;
        let batch_instructions = indexed_instructions
            .rebase_subset(&subset.pages, pages)
            .map_err(OverlaySourceBatchFailure::Failed)?;
        reset_pending_overlay_revision(incremental).map_err(OverlaySourceBatchFailure::Failed)?;
        let batch_omitted = match overlay_text_layers_incremental_with_resolver(
            incremental,
            &source,
            &batch_instructions,
            Some(target_resolver),
        ) {
            Ok(batch_omitted) => batch_omitted,
            Err(error) => {
                let _ = reset_pending_overlay_revision(incremental);
                return Err(if is_too_large_error(error.as_ref()) {
                    OverlaySourceBatchFailure::TooLarge
                } else {
                    OverlaySourceBatchFailure::Failed(error)
                });
            }
        };
        incremental.new_document.version = incremental.get_prev_documents().version.clone();
        let revision = match appended_revision_bytes(incremental) {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = reset_pending_overlay_revision(incremental);
                return Err(OverlaySourceBatchFailure::Failed(error));
            }
        };
        let expected_object_ids = collect_incremental_append_object_ids(incremental);
        let mut next_budget = *xref_budget;
        if let Err(error) = check_overlay_xref_budget(
            &mut next_budget,
            incremental,
            &revision,
            &expected_object_ids,
        ) {
            let _ = reset_pending_overlay_revision(incremental);
            return Err(OverlaySourceBatchFailure::Failed(error));
        }
        let written = match append_at(*current_len, &revision) {
            Ok(written) => written,
            Err(error) => {
                let _ = reset_pending_overlay_revision(incremental);
                return Err(OverlaySourceBatchFailure::Failed(error));
            }
        };
        if let Err(error) = validate_incremental_append_bytes(
            &written,
            *current_len,
            incremental.previous_xref_start(),
            &expected_object_ids,
        ) {
            let _ = reset_pending_overlay_revision(incremental);
            return Err(OverlaySourceBatchFailure::Failed(error));
        }
        advance_verified_overlay_append_base(incremental, &revision)
            .map_err(OverlaySourceBatchFailure::Failed)?;
        *xref_budget = next_budget;
        *current_len = current_len
            .checked_add(revision.len() as u64)
            .ok_or_else(|| {
                OverlaySourceBatchFailure::Failed("overlay-text output size overflow".into())
            })?;
        omitted.extend(batch_omitted);
        Ok(())
    })();
    match attempt {
        Ok(()) => Ok(()),
        Err(OverlaySourceBatchFailure::Failed(error)) => Err(error),
        Err(OverlaySourceBatchFailure::TooLarge) if pages.len() > 1 => {
            let midpoint = pages.len() / 2;
            write_overlay_source_batch_to_sink_with_split(
                source_pdf,
                source_page_ids,
                incremental,
                target_resolver,
                xref_budget,
                current_len,
                &pages[..midpoint],
                indexed_instructions,
                destinations,
                omitted,
                append_at,
            )?;
            write_overlay_source_batch_to_sink_with_split(
                source_pdf,
                source_page_ids,
                incremental,
                target_resolver,
                xref_budget,
                current_len,
                &pages[midpoint..],
                indexed_instructions,
                destinations,
                omitted,
                append_at,
            )
        }
        Err(OverlaySourceBatchFailure::TooLarge) => {
            let page = pages
                .first()
                .copied()
                .ok_or("overlay-text source batch cannot be empty")?;
            Err(domain_error(
                NativeErrorCode::TooLarge,
                format!(
                    "overlay-text source page {page} exceeds the bounded decoder resource limit"
                ),
            ))
        }
    }
}

/// Host-file `overlay-text`: preserves rewrite semantics when both documents
/// fit `MAX_ENCODED_PDF_BYTES`, and streams incremental revisions directly via
/// range-backed `SourcePdf` when either document exceeds 512 MiB.
#[cfg(all(target_family = "wasm", target_os = "unknown"))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn overlay_text_to_sink<S: ByteSource, K: ByteSource, W: Write>(
    target_source: impl Fn() -> S,
    target_len: u64,
    orig_source: impl Fn() -> S,
    orig_len: u64,
    sink_source: impl Fn() -> K,
    instructions: &[u8],
    sink: &mut W,
    append_at: impl FnMut(u64, &[u8]) -> Result<Vec<u8>>,
) -> Result<(u32, Vec<u8>)> {
    overlay_text_to_sink_with_limit(
        target_source,
        target_len,
        orig_source,
        orig_len,
        sink_source,
        instructions,
        sink,
        append_at,
        MAX_ENCODED_PDF_BYTES as u64,
    )
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
#[allow(clippy::too_many_arguments)]
fn overlay_text_to_sink_with_limit<S: ByteSource, K: ByteSource, W: Write>(
    target_source: impl Fn() -> S,
    target_len: u64,
    orig_source: impl Fn() -> S,
    orig_len: u64,
    sink_source: impl Fn() -> K,
    instructions: &[u8],
    sink: &mut W,
    mut append_at: impl FnMut(u64, &[u8]) -> Result<Vec<u8>>,
    max_in_memory_bytes: u64,
) -> Result<(u32, Vec<u8>)> {
    let read_all = |src: &S, len: u64| -> Result<Vec<u8>> {
        let len_usize = usize::try_from(len)?;
        let mut buf = Vec::new();
        buf.try_reserve_exact(len_usize).map_err(|_| {
            domain_error(
                NativeErrorCode::TooLarge,
                "PDF input exceeds available memory",
            )
        })?;
        buf.resize(len_usize, 0);
        src.read_at(0, &mut buf).map_err(io_domain_error)?;
        Ok(buf)
    };
    if target_len <= max_in_memory_bytes && orig_len <= max_in_memory_bytes {
        let data = read_all(&target_source(), target_len)?;
        let source_data = read_all(&orig_source(), orig_len)?;
        let reported = overlay_text_bytes(&data, &source_data, instructions)?;
        sink.write_all(&reported.data)
            .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
        sink.flush()
            .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
        return Ok((reported.page_count, reported.report));
    }

    let parsed = validate_text_layer(parse_json_sidecar_bytes(
        instructions,
        "text-layer instructions",
    )?)?;
    let mut current_len = target_len;
    let mut omitted = Vec::new();
    let mut target_pdf = SourcePdf::open_append_base(target_source(), target_len)?;
    let mut xref_budget = target_pdf.xref_budget();
    let mut incremental = target_pdf.take_append_base()?;
    let target_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
    let pages_out = page_count(incremental.get_prev_documents());
    let _ = sink_source;

    let rebind = if orig_len <= max_in_memory_bytes {
        let source_data = read_all(&orig_source(), orig_len)?;
        let source = load_pdf_bytes(&source_data).map_err(|error| {
            classify_pdf_load_error(error, "Failed to parse source PDF structure")
        })?;
        drop(source_data);
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )?;
        omitted = overlay_text_layers_incremental_with_resolver(
            &mut incremental,
            &source,
            &parsed,
            Some(&target_resolver),
        )?;
        drop(source);
        incremental.new_document.version = incremental.get_prev_documents().version.clone();
        let revision = appended_revision_bytes(&mut incremental)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
        let mut next_budget = xref_budget;
        check_overlay_xref_budget(
            &mut next_budget,
            &incremental,
            &revision,
            &expected_object_ids,
        )?;
        let written = append_at(current_len, &revision)?;
        validate_incremental_append_bytes(
            &written,
            current_len,
            incremental.previous_xref_start(),
            &expected_object_ids,
        )?;
        advance_verified_overlay_append_base(&mut incremental, &revision)?;
        xref_budget = next_budget;
        current_len = current_len
            .checked_add(revision.len() as u64)
            .ok_or("overlay-text output size overflow")?;
        crate::split_navigation::rebind_retained_destinations_in(
            &mut incremental,
            crate::split_navigation::navigation_source(orig_source(), orig_len)?,
            &parsed,
        )?
    } else {
        let source_pdf = SourcePdf::open_plaintext(BufferedByteSource(orig_source()), orig_len)?;
        let source_tree = PageTreeResolver::validated(&source_pdf.document)?;
        let source_page_ids = source_tree
            .validated_pages()
            .expect("validated page tree holds its leaf page list");
        let indexed_instructions = IndexedTextLayerInstructions::new(&parsed);
        let source_pages = referenced_source_pages(&parsed)?;
        let destinations =
            OverlayDestinations::new(&source_pdf.document, source_page_ids, &parsed)?;
        // First write ensures the sink starts with target_len bytes before any
        // incremental revision is appended (and materializes a lazy host sink
        // even when all instructions are link-only).
        let _ = append_at(target_len, &[])?;
        for batch in source_pages.chunks(MAX_SOURCE_PAGE_BATCH_PAGES) {
            write_overlay_source_batch_to_sink_with_split(
                &source_pdf,
                source_page_ids,
                &mut incremental,
                &target_resolver,
                &mut xref_budget,
                &mut current_len,
                batch,
                &indexed_instructions,
                &destinations,
                &mut omitted,
                &mut append_at,
            )?;
        }
        crate::split_navigation::rebind_retained_destinations_in(
            &mut incremental,
            source_pdf,
            &parsed,
        )?
    };
    if rebind.appends_revision {
        let revision = appended_revision_bytes(&mut incremental)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
        check_overlay_xref_budget(
            &mut xref_budget,
            &incremental,
            &revision,
            &expected_object_ids,
        )?;
        let written = append_at(current_len, &revision)?;
        validate_incremental_append_bytes(
            &written,
            current_len,
            incremental.previous_xref_start(),
            &expected_object_ids,
        )?;
    }
    let omitted_pages = omitted_source_pages(&parsed, &omitted);
    let report = if rebind.accessibility_tags_removed || !omitted_pages.is_empty() {
        crate::split_pages::scan_cleanup_page_ops_report(
            rebind.accessibility_tags_removed,
            &omitted_pages,
        )?
    } else {
        Vec::new()
    };
    Ok((pages_out, report))
}

pub(crate) fn write_overlay_text_layers_path(
    input_path: &Path,
    source_path: &Path,
    output_path: &Path,
    instructions: &TextLayerFile,
) -> Result<()> {
    with_staged_incremental_output(input_path, output_path, |staged| {
        let (omitted, incremental, source_pdf) =
            write_overlay_text_layer_copies(input_path, source_path, staged, instructions)?;
        let tags_removed = match incremental {
            Some((mut incremental, mut xref_budget)) => {
                let source = match source_pdf {
                    Some(source_pdf) => source_pdf,
                    None => {
                        let (file, len) = open_source_file(source_path)?;
                        crate::split_navigation::navigation_source(file, len)?
                    }
                };
                let rebind = crate::split_navigation::rebind_retained_destinations_in(
                    &mut incremental,
                    source,
                    instructions,
                )?;
                if rebind.appends_revision {
                    let revision_bytes = build_incremental_revision(&mut incremental)?;
                    let expected_object_ids = collect_incremental_append_object_ids(&incremental);
                    check_overlay_xref_budget(
                        &mut xref_budget,
                        &incremental,
                        &revision_bytes,
                        &expected_object_ids,
                    )?;
                    write_incremental_revision(
                        staged,
                        &incremental,
                        &revision_bytes,
                        &expected_object_ids,
                    )?;
                }
                rebind.accessibility_tags_removed
            }
            None => rebind_retained_destinations(staged, source_path, instructions)?,
        };
        let omitted = omitted_source_pages(instructions, &omitted);
        if tags_removed || !omitted.is_empty() {
            let report = crate::split_pages::scan_cleanup_page_ops_report(tags_removed, &omitted)?;
            println!("{}", String::from_utf8(report)?);
        }
        Ok(())
    })
}

/// The source page numbers, one-based and ascending, whose text was left off
/// some output page. Output indices name the run's own instructions, which a
/// rebased source batch does not renumber.
fn omitted_source_pages(instructions: &TextLayerFile, omitted_outputs: &[usize]) -> Vec<usize> {
    let omitted_outputs = omitted_outputs.iter().copied().collect::<HashSet<_>>();
    let mut pages = instructions
        .pages
        .iter()
        .filter(|instruction| omitted_outputs.contains(&instruction.output_page_index))
        .map(|instruction| instruction.source_page_index + 1)
        .collect::<Vec<_>>();
    pages.sort_unstable();
    pages.dedup();
    pages
}

#[allow(clippy::type_complexity)]
fn write_overlay_text_layer_copies(
    input_path: &Path,
    source_path: &Path,
    output_path: &Path,
    instructions: &TextLayerFile,
) -> Result<(
    Vec<usize>,
    Option<(IncrementalDocument, crate::pdf_source::IndexedXrefBudget)>,
    Option<SourcePdf<File>>,
)> {
    // Preserve the established rewrite semantics only when both documents fit
    // the byte-input compatibility budget. A large source is just as unsafe to
    // eagerly load as a large target, even when the target itself is small.
    let encoded_len = fs::metadata(input_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    let source_encoded_len = fs::metadata(source_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    if encoded_len <= MAX_ENCODED_PDF_BYTES as u64
        && source_encoded_len <= MAX_ENCODED_PDF_BYTES as u64
    {
        let mut target = load_pdf_path(input_path)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        assert_plaintext_base(
            &target,
            "Encrypted PDFs are not supported by native page ops",
        )?;
        let source = load_pdf_path(source_path).map_err(|error| {
            classify_pdf_load_error(error, "Failed to parse source PDF structure")
        })?;
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )?;
        let omitted = overlay_text_layers(&mut target, &source, instructions)?;
        let mut output = AtomicOutput::create(output_path)?;
        target.save_to(output.file_mut()?)?;
        output.publish_if_unchanged()?;
        return Ok((omitted, None, None));
    }

    // A compatibility-sized source can still be held in memory while the
    // target uses the indexed incremental writer. This keeps the ordinary
    // source semantics, while avoiding a target-wide rewrite.
    if source_encoded_len <= MAX_ENCODED_PDF_BYTES as u64 {
        let (target_source, mut incremental) = SourcePdf::open_append_base_path(output_path)?;
        let mut xref_budget = target_source.xref_budget();
        let target_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
        let source = load_pdf_path(source_path).map_err(|error| {
            classify_pdf_load_error(error, "Failed to parse source PDF structure")
        })?;
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )?;
        let omitted = overlay_text_layers_incremental_with_resolver(
            &mut incremental,
            &source,
            instructions,
            Some(&target_resolver),
        )?;
        incremental.new_document.version = incremental.get_prev_documents().version.clone();
        let revision_bytes = build_incremental_revision(&mut incremental)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
        let mut next_budget = xref_budget;
        check_overlay_xref_budget(
            &mut next_budget,
            &incremental,
            &revision_bytes,
            &expected_object_ids,
        )?;
        write_incremental_revision(
            output_path,
            &incremental,
            &revision_bytes,
            &expected_object_ids,
        )?;
        advance_verified_overlay_append_base(&mut incremental, &revision_bytes)?;
        xref_budget = next_budget;
        return Ok((omitted, Some((incremental, xref_budget)), None));
    }

    let (target_source, mut incremental) = SourcePdf::open_append_base_path(output_path)?;
    let mut xref_budget = target_source.xref_budget();
    let target_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
    let source_pdf = SourcePdf::open_path(source_path)?;
    assert_plaintext_base(
        &source_pdf.document,
        "Encrypted source PDFs are not supported by native page ops",
    )?;
    let source_tree = PageTreeResolver::validated(&source_pdf.document)?;
    let source_page_ids = source_tree
        .validated_pages()
        .expect("validated page tree holds its leaf page list");
    let indexed_instructions = IndexedTextLayerInstructions::new(instructions);
    let source_pages = referenced_source_pages(instructions)?;
    let destinations =
        OverlayDestinations::new(&source_pdf.document, source_page_ids, instructions)?;
    let mut omitted = Vec::new();
    for pages in source_pages.chunks(MAX_SOURCE_PAGE_BATCH_PAGES) {
        write_overlay_source_batch_with_split(
            output_path,
            &mut incremental,
            &target_resolver,
            &mut xref_budget,
            &source_pdf,
            source_page_ids,
            pages,
            &indexed_instructions,
            &destinations,
            &mut omitted,
        )?;
    }
    Ok((omitted, Some((incremental, xref_budget)), Some(source_pdf)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object, Stream};
    use std::{cell::RefCell, rc::Rc};

    #[derive(Clone)]
    struct LazyHostSink {
        inner: Rc<RefCell<LazyHostSinkState>>,
    }

    struct LazyHostSinkState {
        base: Vec<u8>,
        staged: Option<Vec<u8>>,
        cursor: u64,
        write_calls: usize,
    }

    impl LazyHostSink {
        fn new(base: Vec<u8>) -> Self {
            Self {
                inner: Rc::new(RefCell::new(LazyHostSinkState {
                    base,
                    staged: None,
                    cursor: 0,
                    write_calls: 0,
                })),
            }
        }

        fn set_cursor(&self, offset: u64) {
            self.inner.borrow_mut().cursor = offset;
        }

        fn write_calls(&self) -> usize {
            self.inner.borrow().write_calls
        }

        fn staged_bytes(&self) -> Option<Vec<u8>> {
            self.inner.borrow().staged.clone()
        }
    }

    impl Write for LazyHostSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let mut state = self.inner.borrow_mut();
            state.write_calls += 1;
            let offset = usize::try_from(state.cursor)
                .map_err(|_| std::io::Error::other("sink offset overflow"))?;
            if state.staged.is_none() && offset >= state.base.len() {
                state.staged = Some(state.base.clone());
            }
            let staged = state.staged.get_or_insert_with(Vec::new);
            if offset > staged.len() {
                staged.resize(offset, 0);
            }
            let end = offset + buf.len();
            if end > staged.len() {
                staged.resize(end, 0);
            }
            if !buf.is_empty() {
                staged[offset..end].copy_from_slice(buf);
            }
            state.cursor += buf.len() as u64;
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl ByteSource for LazyHostSink {
        fn read_at(&self, offset: u64, buffer: &mut [u8]) -> std::io::Result<()> {
            let state = self.inner.borrow();
            let staged = state.staged.as_ref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "lazy host sink has not been materialized yet",
                )
            })?;
            let start = usize::try_from(offset)
                .map_err(|_| std::io::Error::other("sink read offset overflow"))?;
            let end = start
                .checked_add(buffer.len())
                .filter(|&end| end <= staged.len())
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "sink read past materialized length",
                    )
                })?;
            buffer.copy_from_slice(&staged[start..end]);
            Ok(())
        }

        fn copy_range(
            &self,
            _offset: u64,
            _len: u64,
            _output: &mut impl Write,
        ) -> std::io::Result<()> {
            Err(std::io::Error::other("lazy host sink cannot be copied"))
        }
    }

    fn build_single_page_pdf(text: Option<&str>) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let mut resources = lopdf::Dictionary::new();
        let content_bytes = if let Some(text) = text {
            let font_id = doc.add_object(dictionary! {
                "Type" => "Font",
                "Subtype" => "Type1",
                "BaseFont" => "Helvetica",
                "Encoding" => "WinAnsiEncoding",
            });
            resources.set("Font", dictionary! { "F1" => font_id });
            format!("BT /F1 12 Tf 20 60 Td ({text}) Tj ET").into_bytes()
        } else {
            Vec::new()
        };
        let contents_id = doc.add_object(Stream::new(dictionary! {}, content_bytes));
        doc.objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                "Resources" => resources,
                "Contents" => contents_id,
            }),
        );
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn empty_append_to_sink_materializes_lazy_host_before_first_read() {
        let base = b"%PDF-1.5\n%lazy-seed-check\n%%EOF\n".to_vec();
        let mut sink = LazyHostSink::new(base.clone());
        let len = base.len() as u64;
        sink.set_cursor(len);

        let written = write_overlay_append_revision_to_sink(&mut sink, len, &[]).unwrap();
        assert!(written.is_empty());
        assert_eq!(sink.write_calls(), 1);

        let mut read_back = vec![0u8; base.len()];
        sink.read_at(0, &mut read_back).unwrap();
        assert_eq!(read_back, base);
    }

    #[test]
    fn batched_overlay_text_to_sink_seeds_lazy_host_before_reading_and_copies_text() {
        let target = build_single_page_pdf(None);
        let source = build_single_page_pdf(Some("Batched overlay sentinel"));
        let instructions = serde_json::json!({
            "pages": [{
                "sourcePageIndex": 0,
                "outputPageIndex": 0,
                "matrix": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            }]
        })
        .to_string();

        let sink = LazyHostSink::new(target.clone());
        let mut direct_sink = sink.clone();
        let append_sink = sink.clone();
        let (pages_out, _report) = overlay_text_to_sink_with_limit(
            || target.as_slice(),
            target.len() as u64,
            || source.as_slice(),
            source.len() as u64,
            || sink.clone(),
            instructions.as_bytes(),
            &mut direct_sink,
            |offset, revision| {
                let mut writer = append_sink.clone();
                writer.set_cursor(offset);
                write_overlay_append_revision_to_sink(&mut writer, offset, revision)
            },
            1,
        )
        .unwrap();

        assert_eq!(pages_out, 1);
        let output = sink
            .staged_bytes()
            .expect("lazy host sink must be materialized");
        assert!(output.len() > target.len());
        let loaded = Document::load_mem(&output).unwrap();
        assert_eq!(loaded.get_pages().len(), 1);
        let extracted = loaded.extract_text(&[1]).unwrap();
        assert!(
            extracted.contains("Batched overlay sentinel"),
            "expected overlaid text in output PDF, got: {extracted:?}"
        );
    }

    #[test]
    fn batched_overlay_text_to_sink_link_only_still_seeds_lazy_host() {
        let target = build_single_page_pdf(None);
        let source = build_single_page_pdf(Some("Ignored link-only text"));
        let instructions = serde_json::json!({
            "pages": [{
                "sourcePageIndex": 0,
                "outputPageIndex": 0,
                "matrix": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                "linkOnly": true,
            }]
        })
        .to_string();

        let sink = LazyHostSink::new(target.clone());
        let mut direct_sink = sink.clone();
        let append_sink = sink.clone();
        let (pages_out, _report) = overlay_text_to_sink_with_limit(
            || target.as_slice(),
            target.len() as u64,
            || source.as_slice(),
            source.len() as u64,
            || sink.clone(),
            instructions.as_bytes(),
            &mut direct_sink,
            |offset, revision| {
                let mut writer = append_sink.clone();
                writer.set_cursor(offset);
                write_overlay_append_revision_to_sink(&mut writer, offset, revision)
            },
            1,
        )
        .unwrap();

        assert_eq!(pages_out, 1);
        let output = sink
            .staged_bytes()
            .expect("lazy host sink must be materialized");
        let loaded = Document::load_mem(&output).unwrap();
        assert_eq!(loaded.get_pages().len(), 1);
    }

    fn build_multi_page_pdf(page_count: usize, with_text_and_links: bool) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        });
        let mut page_ids = Vec::with_capacity(page_count);
        for index in 0..page_count {
            let page_id = doc.new_object_id();
            page_ids.push(page_id);
            let content = if with_text_and_links {
                format!("BT /F1 12 Tf 20 60 Td (PageToken_{index}) Tj ET").into_bytes()
            } else {
                Vec::new()
            };
            let contents_id = doc.add_object(Stream::new(dictionary! {}, content));
            let mut resources = dictionary! {};
            if with_text_and_links {
                resources.set("Font", dictionary! { "F1" => font_id });
            }
            doc.objects.insert(
                page_id,
                Object::Dictionary(dictionary! {
                    "Type" => "Page",
                    "Parent" => pages_id,
                    "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                    "Resources" => resources,
                    "Contents" => contents_id,
                }),
            );
        }
        if with_text_and_links && page_count >= 130 {
            // Cross-batch internal link: page 0 links to page 129 (different 64-page batch).
            let target_page = page_ids[129];
            let link_id = doc.add_object(dictionary! {
                "Type" => "Annot",
                "Subtype" => "Link",
                "Rect" => vec![10.into(), 10.into(), 50.into(), 30.into()],
                "Dest" => vec![Object::Reference(target_page), Object::Name(b"Fit".to_vec())],
            });
            // Annotation thread on page 0: root note + reply (/IRT).
            let note_id = doc.add_object(dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => vec![60.into(), 60.into(), 80.into(), 80.into()],
                "Contents" => Object::string_literal("Root note"),
                "P" => page_ids[0],
            });
            let reply_id = doc.add_object(dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => vec![60.into(), 60.into(), 80.into(), 80.into()],
                "Contents" => Object::string_literal("Reply note"),
                "IRT" => note_id,
                "P" => page_ids[0],
            });
            doc.get_dictionary_mut(page_ids[0]).unwrap().set(
                "Annots",
                vec![
                    Object::Reference(link_id),
                    Object::Reference(note_id),
                    Object::Reference(reply_id),
                ],
            );
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
                "Count" => i64::try_from(page_count).unwrap(),
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
            "PageLabels" => dictionary! {
                "Nums" => vec![
                    Object::Integer(0),
                    Object::Dictionary(dictionary! { "S" => "r", "St" => 1 }),
                    Object::Integer(10),
                    Object::Dictionary(dictionary! { "S" => "D", "St" => 1 }),
                ],
            },
        });
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn multi_batch_overlay_matches_rewrite_and_keeps_constant_opens_and_linear_instruction_visits()
    {
        let page_count = MAX_SOURCE_PAGE_BATCH_PAGES * 3; // 192 pages -> 3 batches
        let target = build_multi_page_pdf(page_count, false);
        let source = build_multi_page_pdf(page_count, true);
        // Reverse instruction order to prove subset rebasing retains original order.
        let pages_json: Vec<_> = (0..page_count)
            .rev()
            .map(|index| {
                serde_json::json!({
                    "sourcePageIndex": index,
                    "outputPageIndex": index,
                    "matrix": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                })
            })
            .collect();
        let instructions = serde_json::json!({ "pages": pages_json }).to_string();

        let reference = overlay_text_bytes(&target, &source, instructions.as_bytes()).unwrap();
        let ref_doc = Document::load_mem(&reference.data).unwrap();

        let sink = LazyHostSink::new(target.clone());
        let mut direct_sink = sink.clone();
        let append_sink = sink.clone();
        crate::pdf_source::reset_source_pdf_open_count();
        reset_overlay_rebase_instruction_visits();
        let (pages_out, _report) = overlay_text_to_sink_with_limit(
            || target.as_slice(),
            target.len() as u64,
            || source.as_slice(),
            source.len() as u64,
            || sink.clone(),
            instructions.as_bytes(),
            &mut direct_sink,
            |offset, revision| {
                let mut writer = append_sink.clone();
                writer.set_cursor(offset);
                write_overlay_append_revision_to_sink(&mut writer, offset, revision)
            },
            1,
        )
        .unwrap();

        assert_eq!(pages_out as usize, page_count);
        // Constant opens across 3 batches: 1 target open + 1 source open (0 staged reopens).
        assert_eq!(
            crate::pdf_source::source_pdf_open_count(),
            2,
            "batched overlay must not reopen growing staged output per batch"
        );
        // 192 pages + 1 cross-batch destination page (page 129 carried into batch 0) = 193 visits,
        // NOT 3 * 192 = 576 visits.
        let visits = overlay_rebase_instruction_visits();
        assert_eq!(
            visits,
            page_count + 1,
            "indexed rebasing must visit only instructions in each subset, got {visits}"
        );

        let output = sink.staged_bytes().expect("staged bytes materialized");
        let batched_doc = Document::load_mem(&output).unwrap();
        assert_eq!(batched_doc.get_pages().len(), page_count);
        for sample_page in [1_u32, 64, 65, 128, 129, 130, 192] {
            assert_eq!(
                batched_doc.extract_text(&[sample_page]).unwrap(),
                ref_doc.extract_text(&[sample_page]).unwrap(),
                "extracted text mismatch on page {sample_page}"
            );
        }

        // Verify cross-batch link destination and annotation thread reply ownership survived.
        let batched_pages = batched_doc.get_pages();
        let page1_annots = page_annotation_array(
            &batched_doc,
            batched_doc.get_dictionary(batched_pages[&1]).unwrap(),
        )
        .unwrap();
        let mut saw_link_to_page_130 = false;
        let mut saw_reply_with_irt = false;
        for entry in page1_annots {
            let annot_id = entry.as_reference().unwrap();
            let dict = batched_doc.get_dictionary(annot_id).unwrap();
            let subtype = dict.get(b"Subtype").unwrap().as_name().unwrap();
            if subtype == b"Link" {
                let dest = dict.get(b"Dest").unwrap().as_array().unwrap();
                assert_eq!(dest[0].as_reference().unwrap(), batched_pages[&130]);
                saw_link_to_page_130 = true;
            } else if subtype == b"Text" && dict.has(b"IRT") {
                let irt = dict.get(b"IRT").unwrap().as_reference().unwrap();
                let parent = batched_doc.get_dictionary(irt).unwrap();
                assert_eq!(
                    parent.get(b"Contents").unwrap().as_str().unwrap(),
                    b"Root note"
                );
                saw_reply_with_irt = true;
            }
        }
        assert!(saw_link_to_page_130, "cross-batch link destination lost");
        assert!(saw_reply_with_irt, "annotation reply /IRT ownership lost");
        assert!(batched_doc.catalog().unwrap().has(b"PageLabels"));
    }

    #[test]
    fn batched_overlay_preserves_nested_next_action_named_destinations_and_enforces_xref_budget() {
        // 1. Nested /Next GoTo action with a named destination targeting a same-batch page.
        let mut src = Document::with_version("1.5");
        let pages_id = src.new_object_id();
        let page0 = src.new_object_id();
        let page1 = src.new_object_id();
        let link_id = src.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => vec![10.into(), 10.into(), 50.into(), 30.into()],
            "A" => dictionary! {
                "S" => "URI",
                "URI" => Object::string_literal("https://example.test"),
                "Next" => dictionary! {
                    "S" => "GoTo",
                    "D" => Object::Name(b"ChapterTwo".to_vec()),
                },
            },
        });
        src.objects.insert(
            page0,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                "Resources" => dictionary! {},
                "Annots" => vec![Object::Reference(link_id)],
            }),
        );
        src.objects.insert(
            page1,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                "Resources" => dictionary! {},
            }),
        );
        src.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page0), Object::Reference(page1)],
                "Count" => 2,
            }),
        );
        let catalog_id = src.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
            "Dests" => dictionary! {
                "ChapterTwo" => vec![Object::Reference(page1), Object::Name(b"Fit".to_vec())],
            },
        });
        src.trailer.set("Root", catalog_id);
        let mut source_bytes = Vec::new();
        src.save_to(&mut source_bytes).unwrap();

        let target_bytes = build_multi_page_pdf(2, false);
        let instructions = serde_json::json!({
            "pages": [
                { "sourcePageIndex": 0, "outputPageIndex": 0, "matrix": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] },
                { "sourcePageIndex": 1, "outputPageIndex": 1, "matrix": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] },
            ]
        })
        .to_string();

        let sink = LazyHostSink::new(target_bytes.clone());
        let mut direct_sink = sink.clone();
        let append_sink = sink.clone();
        overlay_text_to_sink_with_limit(
            || target_bytes.as_slice(),
            target_bytes.len() as u64,
            || source_bytes.as_slice(),
            source_bytes.len() as u64,
            || sink.clone(),
            instructions.as_bytes(),
            &mut direct_sink,
            |offset, revision| {
                let mut writer = append_sink.clone();
                writer.set_cursor(offset);
                write_overlay_append_revision_to_sink(&mut writer, offset, revision)
            },
            1,
        )
        .unwrap();

        let loaded = Document::load_mem(&sink.staged_bytes().unwrap()).unwrap();
        let out_pages = loaded.get_pages();
        let annots =
            page_annotation_array(&loaded, loaded.get_dictionary(out_pages[&1]).unwrap()).unwrap();
        let annot = loaded
            .get_dictionary(annots[0].as_reference().unwrap())
            .unwrap();
        let action = loaded
            .resolved(annot.get(b"A").unwrap())
            .unwrap()
            .as_dict()
            .unwrap();
        let next = loaded
            .resolved(action.get(b"Next").unwrap())
            .unwrap()
            .as_dict()
            .unwrap();
        let dest = loaded
            .resolved(next.get(b"D").unwrap())
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(dest[0].as_reference().unwrap(), out_pages[&2]);

        // 1b. Cross-batch nested /Next GoTo action with a named destination
        // targeting page 65 from page 1 (across the 64-page batch boundary).
        let mut cross_src = Document::with_version("1.5");
        let cross_pages_id = cross_src.new_object_id();
        let mut cross_page_ids = Vec::with_capacity(65);
        for _ in 0..65 {
            cross_page_ids.push(cross_src.new_object_id());
        }
        let cross_link_id = cross_src.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => vec![10.into(), 10.into(), 50.into(), 30.into()],
            "A" => dictionary! {
                "S" => "URI",
                "URI" => Object::string_literal("https://example.test/cross"),
                "Next" => dictionary! {
                    "S" => "GoTo",
                    "D" => Object::Name(b"ChapterSixtyFive".to_vec()),
                },
            },
        });
        for (idx, &pid) in cross_page_ids.iter().enumerate() {
            let mut page_dict = dictionary! {
                "Type" => "Page",
                "Parent" => cross_pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                "Resources" => dictionary! {},
            };
            if idx == 0 {
                page_dict.set("Annots", vec![Object::Reference(cross_link_id)]);
            }
            cross_src.objects.insert(pid, Object::Dictionary(page_dict));
        }
        cross_src.objects.insert(
            cross_pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => cross_page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
                "Count" => 65,
            }),
        );
        let cross_catalog = cross_src.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => cross_pages_id,
            "Dests" => dictionary! {
                "ChapterSixtyFive" => vec![Object::Reference(cross_page_ids[64]), Object::Name(b"Fit".to_vec())],
            },
        });
        cross_src.trailer.set("Root", cross_catalog);
        let mut cross_source_bytes = Vec::new();
        cross_src.save_to(&mut cross_source_bytes).unwrap();
        let cross_target_bytes = build_multi_page_pdf(65, false);
        let cross_instructions = serde_json::json!({
            "pages": (0..65).map(|i| serde_json::json!({
                "sourcePageIndex": i,
                "outputPageIndex": i,
                "matrix": [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            })).collect::<Vec<_>>()
        })
        .to_string();
        let cross_sink = LazyHostSink::new(cross_target_bytes.clone());
        let mut cross_direct_sink = cross_sink.clone();
        let cross_append_sink = cross_sink.clone();
        overlay_text_to_sink_with_limit(
            || cross_target_bytes.as_slice(),
            cross_target_bytes.len() as u64,
            || cross_source_bytes.as_slice(),
            cross_source_bytes.len() as u64,
            || cross_sink.clone(),
            cross_instructions.as_bytes(),
            &mut cross_direct_sink,
            |offset, revision| {
                let mut writer = cross_append_sink.clone();
                writer.set_cursor(offset);
                write_overlay_append_revision_to_sink(&mut writer, offset, revision)
            },
            1,
        )
        .unwrap();
        let cross_loaded = Document::load_mem(&cross_sink.staged_bytes().unwrap()).unwrap();
        let cross_out_pages = cross_loaded.get_pages();
        let cross_annots = page_annotation_array(
            &cross_loaded,
            cross_loaded.get_dictionary(cross_out_pages[&1]).unwrap(),
        )
        .unwrap();
        let cross_annot = cross_loaded
            .get_dictionary(cross_annots[0].as_reference().unwrap())
            .unwrap();
        let cross_action = cross_loaded
            .resolved(cross_annot.get(b"A").unwrap())
            .unwrap()
            .as_dict()
            .unwrap();
        let cross_next = cross_loaded
            .resolved(cross_action.get(b"Next").unwrap())
            .unwrap()
            .as_dict()
            .unwrap();
        let cross_dest = cross_loaded
            .resolved(cross_next.get(b"D").unwrap())
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(cross_dest[0].as_reference().unwrap(), cross_out_pages[&65]);

        // 2. Cumulative xref section budget refuses exceeding 4,096 sections before writing,
        // and cumulative object-value budget refuses crossing the 20M-value ceiling.
        let mut budget = crate::pdf_source::IndexedXrefBudget {
            sections: 4_095,
            offsets: 4_095,
            entries: 10,
            values: 100,
        };
        budget.check_and_record_revision(3, 2, 10, false).unwrap();
        assert_eq!(budget.sections, 4_096);
        assert_eq!(budget.values, 110);
        let err = budget
            .check_and_record_revision(3, 2, 10, false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("cross-reference chain"));

        let mut value_budget = crate::pdf_source::IndexedXrefBudget {
            sections: 1,
            offsets: 10,
            entries: 10,
            values: 19_999_995,
        };
        value_budget
            .check_and_record_revision(1, 1, 5, false)
            .unwrap();
        assert_eq!(value_budget.values, 20_000_000);
        let err = value_budget
            .check_and_record_revision(1, 1, 1, false)
            .unwrap_err();
        assert!(is_too_large_error(err.as_ref()));
        assert!(err.to_string().contains("20000000-value ceiling"));

        let mut xref_stream_budget = crate::pdf_source::IndexedXrefBudget {
            sections: 1,
            offsets: 10,
            entries: 10,
            values: 19_999_990,
        };
        let err = xref_stream_budget
            .check_and_record_revision(1, 1, 0, true)
            .unwrap_err();
        assert!(is_too_large_error(err.as_ref()));
    }
}
