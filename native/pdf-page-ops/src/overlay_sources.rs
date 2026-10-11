use super::*;
use evb_native_support::output::AtomicOutput;
use std::{
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_SOURCE_PAGE_BATCH_PAGES: usize = 64;
const QPDF_SOURCE_EXTRACTION_TIMEOUT: Duration = Duration::from_secs(110);

pub(crate) fn read_text_layer_file(path: &Path) -> Result<TextLayerFile> {
    let instructions: TextLayerFile = read_json_sidecar(path, "text-layer instructions")?;
    if instructions.pages.is_empty() {
        return Err("overlay-text requires at least one page instruction".into());
    }
    let mut output_pages = HashSet::new();
    for instruction in &instructions.pages {
        overlay_page_number(instruction.source_page_index, "sourcePageIndex")?;
        overlay_page_number(instruction.output_page_index, "outputPageIndex")?;
        if !instruction.matrix.iter().all(|value| value.is_finite()) {
            return Err("overlay-text matrix values must be finite".into());
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
            if !region.matrix.iter().all(|value| value.is_finite())
                || !determinant.is_finite()
                || determinant.abs() <= f64::EPSILON
            {
                return Err(
                    "overlay-text sourceRegion matrix must be finite and invertible".into(),
                );
            }
        }
        if !output_pages.insert(instruction.output_page_index) {
            return Err("overlay-text outputPageIndex values must be unique".into());
        }
    }
    Ok(instructions)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextLayerFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) pages: Vec<TextLayerInstruction>,
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
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextLayerSourceRegion {
    pub(crate) rect: SplitCropRect,
    pub(crate) matrix: [f64; 6],
}

pub(crate) type OverlayPage<'a> = (ObjectId, ObjectId, &'a TextLayerInstruction, PdfRect);

fn append_overlay_pages(
    target: &mut Document,
    source: &Document,
    instructions: &TextLayerFile,
    base: Option<&Document>,
) -> Result<()> {
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
    let mut copied = HashMap::new();
    for &(source_page_id, target_page_id, instruction, _) in &pages {
        // The new-document object map already owns materialization.
        if let Some(base) = base.filter(|_| !target.has_object(target_page_id)) {
            prepare_overlay_page(base, target, target_page_id)?;
        }
        append_source_annotations(
            target,
            source,
            target_page_id,
            source_page_id,
            instruction,
            &pages,
        )?;
        let skipped = append_text_layer(
            target,
            source,
            target_page_id,
            source_page_id,
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
        }
    }
    Ok(())
}

pub(crate) fn overlay_text_layers(
    target: &mut Document,
    source: &Document,
    instructions: &TextLayerFile,
) -> Result<()> {
    append_overlay_pages(target, source, instructions, None)?;
    target.prune_objects();
    // Compress new OCR streams without changing already-compressed images.
    target.compress();
    Ok(())
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
) -> Result<()> {
    append_overlay_pages(
        &mut incremental.new_document,
        source,
        instructions,
        Some(&incremental.previous_document),
    )
}

struct OverlaySourceTempDir {
    path: PathBuf,
}

impl OverlaySourceTempDir {
    fn create() -> Result<Self> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let path =
            std::env::temp_dir().join(format!("evb-overlay-text-{}-{nonce}", std::process::id()));
        fs::create_dir(&path)
            .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
        #[cfg(target_family = "unix")]
        if let Err(error) =
            fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
        {
            let _ = fs::remove_dir_all(&path);
            return Err(domain_error(NativeErrorCode::Io, error.to_string()));
        }
        Ok(Self { path })
    }

    fn subset_path(&self, batch_id: usize) -> PathBuf {
        self.path.join(format!("batch-{batch_id}.pdf"))
    }
}

impl Drop for OverlaySourceTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

enum OverlaySourceBatchFailure {
    TooLarge,
    Failed(Box<dyn Error>),
}

fn overlay_page_number(index: usize, label: &str) -> Result<u32> {
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

fn referenced_source_pages(instructions: &TextLayerFile) -> Result<Vec<usize>> {
    let mut pages = instructions
        .pages
        .iter()
        .map(|instruction| instruction.source_page_index)
        .collect::<Vec<_>>();
    pages.sort_unstable();
    pages.dedup();
    for page in &pages {
        overlay_page_number(*page, "sourcePageIndex")?;
    }
    Ok(pages)
}

fn source_page_ranges(pages: &[usize]) -> Result<Vec<String>> {
    let Some(&first_page) = pages.first() else {
        return Err("overlay-text source batch cannot be empty".into());
    };
    let mut start = overlay_page_number(first_page, "sourcePageIndex")?;
    let mut end = start;
    let mut ranges = Vec::new();
    for page in pages.iter().skip(1) {
        let number = overlay_page_number(*page, "sourcePageIndex")?;
        if end.checked_add(1).is_some_and(|next| number == next) {
            end = number;
            continue;
        }
        ranges.push(if start == end {
            start.to_string()
        } else {
            format!("{start}-{end}")
        });
        start = number;
        end = number;
    }
    ranges.push(if start == end {
        start.to_string()
    } else {
        format!("{start}-{end}")
    });
    Ok(ranges)
}

fn extract_overlay_source_batch(
    source_path: &Path,
    qpdf_path: &Path,
    pages: &[usize],
    temp_dir: &OverlaySourceTempDir,
    batch_id: usize,
) -> std::result::Result<PathBuf, OverlaySourceBatchFailure> {
    let ranges = source_page_ranges(pages).map_err(OverlaySourceBatchFailure::Failed)?;
    let subset_path = temp_dir.subset_path(batch_id);
    let mut child = Command::new(qpdf_path)
        .args([
            "--suppress-recovery",
            "--warning-exit-0",
            "--empty",
            "--pages",
        ])
        .arg(source_path)
        .arg(ranges.join(","))
        .arg("--")
        .arg(&subset_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            OverlaySourceBatchFailure::Failed(domain_error(NativeErrorCode::Io, error.to_string()))
        })?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&subset_path);
                return Err(OverlaySourceBatchFailure::Failed(domain_error(
                    NativeErrorCode::Io,
                    error.to_string(),
                )));
            }
        }
        if started.elapsed() > QPDF_SOURCE_EXTRACTION_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&subset_path);
            return Err(OverlaySourceBatchFailure::TooLarge);
        }
        if fs::metadata(&subset_path)
            .map(|metadata| metadata.len() > MAX_ENCODED_PDF_BYTES as u64)
            .unwrap_or(false)
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&subset_path);
            return Err(OverlaySourceBatchFailure::TooLarge);
        }
        thread::sleep(Duration::from_millis(25));
    };
    if !status.success() {
        let _ = fs::remove_file(&subset_path);
        return Err(OverlaySourceBatchFailure::Failed(domain_error(
            NativeErrorCode::CorruptXref,
            format!("qpdf source-page extraction failed with status {status}"),
        )));
    }
    let encoded_len = fs::metadata(&subset_path)
        .map_err(|error| {
            OverlaySourceBatchFailure::Failed(domain_error(NativeErrorCode::Io, error.to_string()))
        })?
        .len();
    if encoded_len > MAX_ENCODED_PDF_BYTES as u64 {
        let _ = fs::remove_file(&subset_path);
        return Err(OverlaySourceBatchFailure::TooLarge);
    }
    if encoded_len == 0 {
        let _ = fs::remove_file(&subset_path);
        return Err(OverlaySourceBatchFailure::Failed(domain_error(
            NativeErrorCode::CorruptXref,
            "qpdf source-page extraction produced an empty PDF",
        )));
    }
    Ok(subset_path)
}

fn rebase_overlay_source_instructions(
    instructions: &TextLayerFile,
    pages: &[usize],
) -> Result<TextLayerFile> {
    let local_pages = pages
        .iter()
        .enumerate()
        .map(|(local_index, page)| (*page, local_index))
        .collect::<HashMap<_, _>>();
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
                })
        })
        .collect::<Vec<_>>();
    if batch_pages.is_empty() {
        return Err("overlay-text source batch has no matching instructions".into());
    }
    Ok(TextLayerFile { pages: batch_pages })
}

fn try_write_overlay_source_batch(
    output_path: &Path,
    source_path: &Path,
    qpdf_path: &Path,
    pages: &[usize],
    instructions: &TextLayerFile,
    temp_dir: &OverlaySourceTempDir,
    batch_id: usize,
) -> std::result::Result<(), OverlaySourceBatchFailure> {
    let subset_path =
        extract_overlay_source_batch(source_path, qpdf_path, pages, temp_dir, batch_id)?;
    let result = (|| {
        let source = match load_pdf_path(&subset_path) {
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
        let batch_instructions = rebase_overlay_source_instructions(instructions, pages)
            .map_err(OverlaySourceBatchFailure::Failed)?;
        let mut incremental =
            load_incremental_pdf_path(output_path, Some(qpdf_path)).map_err(|error| {
                OverlaySourceBatchFailure::Failed(classify_pdf_load_error(
                    error,
                    "Failed to parse PDF structure",
                ))
            })?;
        assert_plaintext_base(
            incremental.get_prev_documents(),
            "Encrypted PDFs are not supported by native page ops",
        )
        .map_err(OverlaySourceBatchFailure::Failed)?;
        if let Err(error) =
            overlay_text_layers_incremental(&mut incremental, &source, &batch_instructions)
        {
            return Err(if is_too_large_error(error.as_ref()) {
                OverlaySourceBatchFailure::TooLarge
            } else {
                OverlaySourceBatchFailure::Failed(error)
            });
        }
        incremental.new_document.version = incremental.get_prev_documents().version.clone();
        let revision_bytes = build_incremental_revision(&mut incremental)
            .map_err(OverlaySourceBatchFailure::Failed)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
        write_incremental_revision(
            output_path,
            &incremental,
            &revision_bytes,
            &expected_object_ids,
        )
        .map_err(OverlaySourceBatchFailure::Failed)
    })();
    let _ = fs::remove_file(&subset_path);
    result
}

fn write_overlay_source_batch_with_split(
    output_path: &Path,
    source_path: &Path,
    qpdf_path: &Path,
    pages: &[usize],
    instructions: &TextLayerFile,
    temp_dir: &OverlaySourceTempDir,
    next_batch_id: &mut usize,
) -> Result<()> {
    let batch_id = *next_batch_id;
    *next_batch_id = batch_id
        .checked_add(1)
        .ok_or("overlay-text source batch count overflow")?;
    match try_write_overlay_source_batch(
        output_path,
        source_path,
        qpdf_path,
        pages,
        instructions,
        temp_dir,
        batch_id,
    ) {
        Ok(()) => Ok(()),
        Err(OverlaySourceBatchFailure::Failed(error)) => Err(error),
        Err(OverlaySourceBatchFailure::TooLarge) if pages.len() > 1 => {
            let midpoint = pages.len() / 2;
            write_overlay_source_batch_with_split(
                output_path,
                source_path,
                qpdf_path,
                &pages[..midpoint],
                instructions,
                temp_dir,
                next_batch_id,
            )?;
            write_overlay_source_batch_with_split(
                output_path,
                source_path,
                qpdf_path,
                &pages[midpoint..],
                instructions,
                temp_dir,
                next_batch_id,
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

pub(crate) fn write_overlay_text_layers_path(
    input_path: &Path,
    source_path: &Path,
    output_path: &Path,
    instructions: &TextLayerFile,
    qpdf_path: Option<&Path>,
) -> Result<()> {
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
        overlay_text_layers(&mut target, &source, instructions)?;
        let mut output = AtomicOutput::create(output_path)?;
        target.save_to(output.file_mut()?)?;
        output.publish_if_unchanged()?;
        return Ok(());
    }

    let qpdf_path = qpdf_path.ok_or_else(|| {
        domain_error(
            NativeErrorCode::TooLarge,
            "qpdf is required for overlay-text path operations above the byte-input compatibility budget",
        )
    })?;

    // A compatibility-sized source can still be held in memory while the
    // target uses the qpdf-backed incremental writer. This keeps the ordinary
    // source semantics, while avoiding a target-wide rewrite.
    if source_encoded_len <= MAX_ENCODED_PDF_BYTES as u64 {
        let mut incremental = load_incremental_pdf_path(input_path, Some(qpdf_path))
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        assert_plaintext_base(
            incremental.get_prev_documents(),
            "Encrypted PDFs are not supported by native page ops",
        )?;
        let source = load_pdf_path(source_path).map_err(|error| {
            classify_pdf_load_error(error, "Failed to parse source PDF structure")
        })?;
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )?;
        overlay_text_layers_incremental(&mut incremental, &source, instructions)?;
        incremental.new_document.version = incremental.get_prev_documents().version.clone();
        let revision_bytes = build_incremental_revision(&mut incremental)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
        return with_staged_incremental_output(input_path, output_path, |staged_output_path| {
            write_incremental_revision(
                staged_output_path,
                &incremental,
                &revision_bytes,
                &expected_object_ids,
            )
        });
    }

    // Probe both path-backed documents through qpdf before extracting any
    // source page. qpdf reads structure without retaining stream bodies, so a
    // multi-gigabyte source never crosses the eager decoder boundary here.
    let target_probe = load_incremental_pdf_path(input_path, Some(qpdf_path))
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        target_probe.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let source_probe = load_incremental_pdf_path(source_path, Some(qpdf_path))
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse source PDF structure"))?;
    assert_plaintext_base(
        source_probe.get_prev_documents(),
        "Encrypted source PDFs are not supported by native page ops",
    )?;

    let source_pages = referenced_source_pages(instructions)?;
    let temp_dir = OverlaySourceTempDir::create()?;
    with_staged_incremental_output(input_path, output_path, |staged_output_path| {
        let mut next_batch_id = 0;
        for pages in source_pages.chunks(MAX_SOURCE_PAGE_BATCH_PAGES) {
            write_overlay_source_batch_with_split(
                staged_output_path,
                source_path,
                qpdf_path,
                pages,
                instructions,
                &temp_dir,
                &mut next_batch_id,
            )?;
        }
        Ok(())
    })
}
