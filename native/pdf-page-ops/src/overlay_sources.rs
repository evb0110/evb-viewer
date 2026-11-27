use super::*;
use crate::overlay_destinations::{carry_named_destinations, OverlayDestinations};
use evb_native_support::output::AtomicOutput;
use std::path::Path;

pub(crate) const MAX_SOURCE_PAGE_BATCH_PAGES: usize = 64;

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
) -> Result<Vec<usize>> {
    let source_resolver = PageTreeResolver::new(source)?;
    let target_resolver = PageTreeResolver::new(base.unwrap_or(target))?;
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
    let omitted = append_overlay_pages(target, source, instructions, None)?;
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

pub(crate) fn overlay_text_layers_incremental(
    incremental: &mut IncrementalDocument,
    source: &Document,
    instructions: &TextLayerFile,
) -> Result<Vec<usize>> {
    append_overlay_pages(
        &mut incremental.new_document,
        source,
        instructions,
        Some(&incremental.previous_document),
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

/// The instructions of one subset: every output page whose source page the
/// subset extracts. Only the batch's own pages copy text; the destination pages
/// it also holds are mapped as link-only.
fn rebase_overlay_source_instructions(
    instructions: &TextLayerFile,
    pages: &[usize],
    text_pages: &[usize],
) -> Result<TextLayerFile> {
    let local_pages = pages
        .iter()
        .enumerate()
        .map(|(local_index, page)| (*page, local_index))
        .collect::<HashMap<_, _>>();
    let text_pages = text_pages.iter().copied().collect::<HashSet<_>>();
    let batch_pages = instructions
        .pages
        .iter()
        .filter_map(|instruction| {
            local_pages
                .get(&instruction.source_page_index)
                .map(|local_index| TextLayerInstruction {
                    source_page_index: *local_index,
                    output_page_index: instruction.output_page_index,
                    matrix: instruction.matrix,
                    filter_to_output_page: instruction.filter_to_output_page,
                    normalize_greek_micro_sign: instruction.normalize_greek_micro_sign,
                    source_region: instruction.source_region,
                    link_only: instruction.link_only
                        || !text_pages.contains(&instruction.source_page_index),
                    unmapped_geometry: instruction.unmapped_geometry,
                })
        })
        .collect::<Vec<_>>();
    if batch_pages.is_empty() {
        return Err("overlay-text source batch has no matching instructions".into());
    }
    // A source batch copies text only; the run stamp is written once, with
    // the final navigation.
    Ok(TextLayerFile {
        pages: batch_pages,
        provenance_stamp_hex: None,
    })
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

fn try_write_overlay_source_batch(
    output_path: &Path,
    source_pdf: &SourcePdf<File>,
    pages: &[usize],
    instructions: &TextLayerFile,
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
    let extracted = edit_page_structure(
        PageStructureEdit::Extract(&subset_pages_u32),
        std::slice::from_ref(source_pdf),
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
    let batch_instructions = rebase_overlay_source_instructions(instructions, &subset.pages, pages)
        .map_err(OverlaySourceBatchFailure::Failed)?;
    let (_, mut incremental) =
        SourcePdf::open_append_base_path(output_path).map_err(OverlaySourceBatchFailure::Failed)?;
    match overlay_text_layers_incremental(&mut incremental, &source, &batch_instructions) {
        Ok(batch_omitted) => omitted.extend(batch_omitted),
        Err(error) => {
            return Err(if is_too_large_error(error.as_ref()) {
                OverlaySourceBatchFailure::TooLarge
            } else {
                OverlaySourceBatchFailure::Failed(error)
            });
        }
    }
    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    let revision_bytes =
        build_incremental_revision(&mut incremental).map_err(OverlaySourceBatchFailure::Failed)?;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);
    write_incremental_revision(
        output_path,
        &incremental,
        &revision_bytes,
        &expected_object_ids,
    )
    .map_err(OverlaySourceBatchFailure::Failed)
}

fn write_overlay_source_batch_with_split(
    output_path: &Path,
    source_pdf: &SourcePdf<File>,
    pages: &[usize],
    instructions: &TextLayerFile,
    destinations: &OverlayDestinations,
    omitted: &mut Vec<usize>,
) -> Result<()> {
    match try_write_overlay_source_batch(
        output_path,
        source_pdf,
        pages,
        instructions,
        destinations,
        omitted,
    ) {
        Ok(()) => Ok(()),
        Err(OverlaySourceBatchFailure::Failed(error)) => Err(error),
        Err(OverlaySourceBatchFailure::TooLarge) if pages.len() > 1 => {
            let midpoint = pages.len() / 2;
            write_overlay_source_batch_with_split(
                output_path,
                source_pdf,
                &pages[..midpoint],
                instructions,
                destinations,
                omitted,
            )?;
            write_overlay_source_batch_with_split(
                output_path,
                source_pdf,
                &pages[midpoint..],
                instructions,
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

/// Adapter whose `copy_range` reads through `read_at` in chunks into any
/// `Write` (e.g. an in-memory `Vec<u8>`) instead of targeting `HostSink`.
#[cfg(all(target_family = "wasm", target_os = "unknown"))]
struct BufferedByteSource<S>(S);

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
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
#[cfg(all(target_family = "wasm", target_os = "unknown"))]
struct BoundedVecWriter {
    buf: Vec<u8>,
    limit: usize,
}

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
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

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
#[allow(clippy::too_many_arguments)]
fn write_overlay_source_batch_to_sink_with_split<S: ByteSource, K: ByteSource>(
    source_pdf: &SourcePdf<BufferedByteSource<S>>,
    sink_source: &impl Fn() -> K,
    current_len: &mut u64,
    pages: &[usize],
    instructions: &TextLayerFile,
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
        let extracted = edit_page_structure(
            PageStructureEdit::Extract(&subset_pages_u32),
            std::slice::from_ref(source_pdf),
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
        let batch_instructions =
            rebase_overlay_source_instructions(instructions, &subset.pages, pages)
                .map_err(OverlaySourceBatchFailure::Failed)?;
        let mut target_source_pdf = SourcePdf::open_append_base(sink_source(), *current_len)
            .map_err(OverlaySourceBatchFailure::Failed)?;
        let mut incremental = target_source_pdf
            .take_append_base()
            .map_err(OverlaySourceBatchFailure::Failed)?;
        match overlay_text_layers_incremental(&mut incremental, &source, &batch_instructions) {
            Ok(batch_omitted) => omitted.extend(batch_omitted),
            Err(error) => {
                return Err(if is_too_large_error(error.as_ref()) {
                    OverlaySourceBatchFailure::TooLarge
                } else {
                    OverlaySourceBatchFailure::Failed(error)
                });
            }
        }
        incremental.new_document.version = incremental.get_prev_documents().version.clone();
        let revision =
            appended_revision_bytes(&mut incremental).map_err(OverlaySourceBatchFailure::Failed)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
        let written =
            append_at(*current_len, &revision).map_err(OverlaySourceBatchFailure::Failed)?;
        validate_incremental_append_bytes(
            &written,
            *current_len,
            incremental.previous_xref_start(),
            &expected_object_ids,
        )
        .map_err(OverlaySourceBatchFailure::Failed)?;
        *current_len = current_len
            .checked_add(revision.len() as u64)
            .ok_or_else(|| {
                OverlaySourceBatchFailure::Failed("overlay-text output size overflow".into())
            })?;
        Ok(())
    })();
    match attempt {
        Ok(()) => Ok(()),
        Err(OverlaySourceBatchFailure::Failed(error)) => Err(error),
        Err(OverlaySourceBatchFailure::TooLarge) if pages.len() > 1 => {
            let midpoint = pages.len() / 2;
            write_overlay_source_batch_to_sink_with_split(
                source_pdf,
                sink_source,
                current_len,
                &pages[..midpoint],
                instructions,
                destinations,
                omitted,
                append_at,
            )?;
            write_overlay_source_batch_to_sink_with_split(
                source_pdf,
                sink_source,
                current_len,
                &pages[midpoint..],
                instructions,
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
    mut append_at: impl FnMut(u64, &[u8]) -> Result<Vec<u8>>,
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
    if target_len <= MAX_ENCODED_PDF_BYTES as u64 && orig_len <= MAX_ENCODED_PDF_BYTES as u64 {
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
    let pages_out;

    if orig_len <= MAX_ENCODED_PDF_BYTES as u64 {
        let mut target_pdf = SourcePdf::open_append_base(target_source(), target_len)?;
        let mut incremental = target_pdf.take_append_base()?;
        pages_out = page_count(incremental.get_prev_documents());
        let source_data = read_all(&orig_source(), orig_len)?;
        let source = load_pdf_bytes(&source_data).map_err(|error| {
            classify_pdf_load_error(error, "Failed to parse source PDF structure")
        })?;
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )?;
        omitted = overlay_text_layers_incremental(&mut incremental, &source, &parsed)?;
        incremental.new_document.version = incremental.get_prev_documents().version.clone();
        let revision = appended_revision_bytes(&mut incremental)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
        let written = append_at(current_len, &revision)?;
        validate_incremental_append_bytes(
            &written,
            current_len,
            incremental.previous_xref_start(),
            &expected_object_ids,
        )?;
        current_len = current_len
            .checked_add(revision.len() as u64)
            .ok_or("overlay-text output size overflow")?;
    } else {
        let target_probe = SourcePdf::open_append_base(target_source(), target_len)?;
        pages_out = page_count(&target_probe.document);
        drop(target_probe);
        let source_pdf = SourcePdf::open_plaintext(BufferedByteSource(orig_source()), orig_len)?;
        let source_pages = referenced_source_pages(&parsed)?;
        let destinations = OverlayDestinations::new(&source_pdf.document, &parsed)?;
        // First write ensures the sink starts with target_len bytes before reading from sink_source.
        let _ = append_at(target_len, &[])?;
        for batch in source_pages.chunks(MAX_SOURCE_PAGE_BATCH_PAGES) {
            write_overlay_source_batch_to_sink_with_split(
                &source_pdf,
                &sink_source,
                &mut current_len,
                batch,
                &parsed,
                &destinations,
                &mut omitted,
                &mut append_at,
            )?;
        }
    }

    let mut staged_pdf = SourcePdf::open_append_base(sink_source(), current_len)?;
    let mut incremental = staged_pdf.take_append_base()?;
    let rebind = crate::split_navigation::rebind_retained_destinations_in(
        &mut incremental,
        crate::split_navigation::navigation_source(orig_source(), orig_len)?,
        &parsed,
    )?;
    if rebind.appends_revision {
        let revision = appended_revision_bytes(&mut incremental)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
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
        let omitted =
            write_overlay_text_layer_copies(input_path, source_path, staged, instructions)?;
        let tags_removed = rebind_retained_destinations(staged, source_path, instructions)?;
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

fn write_overlay_text_layer_copies(
    input_path: &Path,
    source_path: &Path,
    output_path: &Path,
    instructions: &TextLayerFile,
) -> Result<Vec<usize>> {
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
        return Ok(omitted);
    }

    // A compatibility-sized source can still be held in memory while the
    // target uses the indexed incremental writer. This keeps the ordinary
    // source semantics, while avoiding a target-wide rewrite.
    if source_encoded_len <= MAX_ENCODED_PDF_BYTES as u64 {
        let (_, mut incremental) = SourcePdf::open_append_base_path(input_path)?;
        let source = load_pdf_path(source_path).map_err(|error| {
            classify_pdf_load_error(error, "Failed to parse source PDF structure")
        })?;
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )?;
        let omitted = overlay_text_layers_incremental(&mut incremental, &source, instructions)?;
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
        return Ok(omitted);
    }

    SourcePdf::open_append_base_path(input_path)?;
    let source_pdf = SourcePdf::open_path(source_path)?;
    let source_pages = referenced_source_pages(instructions)?;
    let destinations = OverlayDestinations::new(&source_pdf.document, instructions)?;
    let mut omitted = Vec::new();
    with_staged_incremental_output(input_path, output_path, |staged_output_path| {
        for pages in source_pages.chunks(MAX_SOURCE_PAGE_BATCH_PAGES) {
            write_overlay_source_batch_with_split(
                staged_output_path,
                &source_pdf,
                pages,
                instructions,
                &destinations,
                &mut omitted,
            )?;
        }
        Ok(())
    })?;
    Ok(omitted)
}
