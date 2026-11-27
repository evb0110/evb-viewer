use super::*;
use evb_native_support::output::{AtomicOutput, PathRevisionWitness};

const SEED_COMPARE_CHUNK_BYTES: usize = 64 * 1024;
pub(crate) const MAX_CLASSIC_XREF_OFFSET: u64 = 9_999_999_999;
const XREF_STREAM_OFFSET_BYTES: usize = 8;
#[path = "native_save_report.rs"]
mod save_report;
pub(crate) use save_report::*;

pub(crate) trait AppendRollback: Write {
    fn rollback_to(&mut self, len: u64) -> std::io::Result<()>;
    fn sync_all(&mut self) -> std::io::Result<()>;
}

impl AppendRollback for File {
    fn rollback_to(&mut self, len: u64) -> std::io::Result<()> {
        self.set_len(len)?;
        self.seek(SeekFrom::End(0))?;
        Ok(())
    }

    fn sync_all(&mut self) -> std::io::Result<()> {
        File::sync_all(self)
    }
}

fn rollback_incremental_write<W: AppendRollback>(
    output: &mut W,
    previous_len: u64,
    error: Box<dyn Error>,
    context: &str,
) -> Result<()> {
    if let Err(rollback_error) = output.rollback_to(previous_len) {
        return Err(format!(
            "{error}; failed to roll back {context} incremental append: {rollback_error}"
        )
        .into());
    }
    if let Err(sync_error) = output.sync_all() {
        return Err(format!(
            "{error}; rolled back {context} incremental append but failed to sync it: {sync_error}"
        )
        .into());
    }
    Err(error)
}

pub(crate) fn write_incremental_revision_transactionally<W>(
    output: &mut W,
    previous_len: u64,
    write_revision: impl FnOnce(&mut W) -> Result<()>,
) -> Result<()>
where
    W: AppendRollback,
{
    let write_result = write_revision(output).and_then(|()| {
        output.flush()?;
        Ok(())
    });

    if let Err(write_error) = write_result {
        return rollback_incremental_write(output, previous_len, write_error, "partial");
    }
    if let Err(sync_error) = output.sync_all() {
        return rollback_incremental_write(output, previous_len, Box::new(sync_error), "partial");
    }

    Ok(())
}

fn rollback_incremental_append(
    output: &mut File,
    previous_len: u64,
    error: Box<dyn Error>,
) -> Result<()> {
    rollback_incremental_write(output, previous_len, error, "invalid")
}

fn assert_append_target_unchanged(
    output: &mut File,
    previous_len: u64,
    previous_last_byte: Option<u8>,
    previous_xref_start: u64,
) -> Result<()> {
    if output.metadata()?.len() != previous_len
        || read_last_byte_from_file(output, previous_len)? != previous_last_byte
    {
        return Err("Append target changed after its PDF structure was parsed".into());
    }
    let (xref_start, _) = read_terminal_xref_from_file(output, previous_len)?;
    if xref_start != previous_xref_start {
        return Err("Append target cross-reference changed after it was parsed".into());
    }
    Ok(())
}

pub(crate) fn assert_append_path_unchanged(
    path: &Path,
    previous_len: u64,
    previous_last_byte: Option<u8>,
    previous_xref_start: u64,
) -> Result<()> {
    let mut output = OpenOptions::new().read(true).open(path)?;
    assert_append_target_unchanged(
        &mut output,
        previous_len,
        previous_last_byte,
        previous_xref_start,
    )
}

pub(crate) fn append_paths_refer_to_same_file(input_path: &Path, output_path: &Path) -> bool {
    if input_path == output_path {
        return true;
    }

    match (fs::canonicalize(input_path), fs::canonicalize(output_path)) {
        (Ok(input), Ok(output)) => input == output,
        _ => false,
    }
}

pub(crate) fn assert_append_output_seeded(
    input_path: &Path,
    output_path: &Path,
    previous_len: u64,
) -> Result<()> {
    if append_paths_refer_to_same_file(input_path, output_path) {
        return Ok(());
    }

    let mismatch =
        "Append output must already contain an exact byte-for-byte copy of the input PDF";
    if fs::metadata(input_path)?.len() != previous_len
        || fs::metadata(output_path)?.len() != previous_len
    {
        return Err(mismatch.into());
    }

    let mut input = BufReader::new(File::open(input_path)?);
    let mut output = BufReader::new(File::open(output_path)?);
    let mut input_chunk = [0u8; SEED_COMPARE_CHUNK_BYTES];
    let mut output_chunk = [0u8; SEED_COMPARE_CHUNK_BYTES];
    let mut compared = 0_u64;
    while compared < previous_len {
        let remaining =
            usize::try_from((previous_len - compared).min(SEED_COMPARE_CHUNK_BYTES as u64))?;
        input.read_exact(&mut input_chunk[..remaining])?;
        output.read_exact(&mut output_chunk[..remaining])?;
        if input_chunk[..remaining] != output_chunk[..remaining] {
            return Err(mismatch.into());
        }
        compared += u64::try_from(remaining)?;
    }
    Ok(())
}

pub(crate) fn assert_append_output_length(output_path: &Path, previous_len: u64) -> Result<()> {
    if fs::metadata(output_path)?.len() != previous_len {
        return Err(
            "Append output must already contain an exact byte-for-byte copy of the input".into(),
        );
    }
    Ok(())
}

/// Run an incremental path operation against an unpublished sibling copy of
/// the input, then replace the requested output only after every revision has
/// been validated. This includes same-file operations, so a working-copy save
/// has the same crash boundary as a save to a distinct output path.
pub(crate) fn with_staged_incremental_output(
    input_path: &Path,
    output_path: &Path,
    write_revisions: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    with_staged_incremental_output_for_revision(input_path, output_path, None, write_revisions)
}

pub(crate) fn with_staged_incremental_output_for_revision(
    input_path: &Path,
    output_path: &Path,
    source_witness: Option<&PathRevisionWitness>,
    write_revisions: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    source_witness
        .map(PathRevisionWitness::assert_current)
        .transpose()
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    let mut staged = AtomicOutput::create(output_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    let seeded = staged
        .seed_from_path(input_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    if !seeded {
        let mut input = File::open(input_path)
            .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
        std::io::copy(
            &mut input,
            staged
                .file_mut()
                .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?,
        )
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    }
    source_witness
        .map(PathRevisionWitness::assert_current)
        .transpose()
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    staged
        .file_mut()
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .flush()
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    let staged_path = staged.temporary_path().to_path_buf();
    write_revisions(&staged_path)?;
    staged
        .publish_if_unchanged()
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))
}

#[cfg(test)]
fn with_staged_incremental_output_after_admission(
    input_path: &Path,
    output_path: &Path,
    after_admission: impl FnOnce(),
    write_revisions: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let source_witness = PathRevisionWitness::capture(input_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    after_admission();
    with_staged_incremental_output_for_revision(
        input_path,
        output_path,
        Some(&source_witness),
        write_revisions,
    )
}

pub(crate) fn apply_native_mutations(
    document: &mut impl PdfObjectStore,
    mutations: &NativeMutationsFile,
    modified_at: &str,
) -> Result<()> {
    apply_native_mutations_internal(document, mutations, modified_at, None)
}

pub(crate) fn apply_native_mutations_with_bindings(
    document: &mut impl PdfObjectStore,
    mutations: &NativeMutationsFile,
    modified_at: &str,
    identity_bindings: &mut Vec<AnnotationIdentityBinding>,
) -> Result<()> {
    apply_native_mutations_internal(document, mutations, modified_at, Some(identity_bindings))
}

/// Applies one mutation payload, in this order, to a loaded document for a
/// full rewrite or to an incremental one for an append.
fn apply_native_mutations_internal(
    document: &mut impl PdfObjectStore,
    mutations: &NativeMutationsFile,
    modified_at: &str,
    mut identity_bindings: Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()> {
    let mut annotation_visits = 0usize;
    validate_text_box_targets(document, mutations)?;
    if !mutations.updates.is_empty() {
        update_note_text(document, &mutations.updates, modified_at)?;
    }
    update_note_geometry(document, &mutations.geometry_updates, modified_at)?;
    upsert_text_notes_with_counter(
        document,
        mutations
            .notes
            .iter()
            .chain(mutations.free_text_notes.iter()),
        modified_at,
        &mut annotation_visits,
        &mut identity_bindings,
    )?;
    upsert_text_boxes_with_counter(
        document,
        &mutations.text_boxes,
        modified_at,
        &mut annotation_visits,
        &mut identity_bindings,
    )?;
    delete_annotations(document, &mutations.deletes)?;
    if !mutations.page_rotations.is_empty() {
        rotate_pages(document, &mutations.page_rotations)?;
    }
    if !mutations.page_crops.is_empty() {
        apply_page_crops(document, &mutations.page_crops)?;
    }
    if !mutations.page_crop_removals.is_empty() {
        apply_page_crop_removals(document, &mutations.page_crop_removals)?;
    }
    if let Some(page_labels) = &mutations.page_labels {
        set_page_labels(document, page_labels, is_page_label_continuation(mutations))?;
    }
    if let Some(bookmarks) = &mutations.bookmarks {
        set_bookmarks(document, bookmarks, mutations.continuation.as_ref())?;
    }
    if let Some(shapes) = &mutations.shapes {
        apply_shape_annotations(document, shapes, modified_at, &mut identity_bindings)?;
    }
    if let Some(markup) = &mutations.markup {
        match identity_bindings.as_mut() {
            Some(bindings) => {
                apply_markup_mutations_with_bindings(document, markup, modified_at, bindings)?;
            }
            None => apply_markup_mutations(document, markup, modified_at)?,
        }
    }
    if !mutations.placed_images.is_empty() {
        let image_bytes = take_or_validate_placed_image_payloads(mutations)?;
        apply_placed_images(
            document,
            &mutations.placed_images,
            image_bytes,
            placed_image_chunk_index(mutations),
            modified_at,
            &mut identity_bindings,
        )?;
    }
    if !mutations.placed_image_geometry_updates.is_empty() {
        apply_placed_image_geometry_updates(
            document,
            &mutations.placed_image_geometry_updates,
            modified_at,
            &mut identity_bindings,
        )?;
    }
    Ok(())
}

fn is_page_label_continuation(mutations: &NativeMutationsFile) -> bool {
    mutations.continuation.as_ref().is_some_and(|continuation| {
        continuation.family == NativeMutationContinuationFamily::PageLabels
    })
}

/// What an append over an indexed source reports.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) struct IndexedAppend {
    pub(crate) page_count: u32,
    pub(crate) identity_bindings: Vec<AnnotationIdentityBinding>,
    #[cfg_attr(
        not(all(target_family = "wasm", target_os = "unknown")),
        allow(dead_code)
    )]
    pub(crate) annotation_delete_effects: Option<AnnotationDeleteEffects>,
}

/// The base an append of `mutations` extends: the PDF `source` holds, read
/// through its cross-reference index, with the objects and streams the
/// mutations reuse: images an undo restores, and the appearances that decide
/// how an edited label keeps its frame. Streams are read by range.
pub(crate) fn open_mutation_base<S: ByteSource>(
    source: S,
    len: u64,
    mutations: &NativeMutationsFile,
) -> Result<IncrementalDocument> {
    if !mutations.page_rotations.is_empty()
        || !mutations.page_crops.is_empty()
        || !mutations.page_crop_removals.is_empty()
    {
        validate_page_tree_source(&source, len)?;
    }
    let restored_images = mutations
        .placed_image_geometry_updates
        .iter()
        .filter_map(|update| update.source_image.as_ref())
        .filter_map(|image| {
            Some((
                u32::try_from(image.object_number).ok()?,
                u16::try_from(image.generation_number).ok()?,
            ))
        })
        .collect::<Vec<_>>();
    let mut source = SourcePdf::open_append_base_naming(source, len, &restored_images)?;
    let mut incremental = source.take_append_base()?;
    let streams = &source as StructuralSource;
    materialize_stamp_recovery_sources(
        &mut incremental,
        Some(streams),
        &mutations.placed_image_geometry_updates,
    )?;
    crate::free_text_frame::materialize_free_text_appearances(
        &mut incremental,
        streams,
        mutations,
    )?;
    Ok(incremental)
}

fn open_mutation_base_path(
    path: &Path,
    mutations: &NativeMutationsFile,
) -> Result<IncrementalDocument> {
    let (file, len) = open_source_file(path)?;
    open_mutation_base(file, len, mutations)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))
}

/// Applies one validated mutation payload to the PDF `source` holds and
/// appends its revision through `write`, which writes it after the base's
/// `len` bytes and returns what the file then holds there: that is what is
/// checked, not the bytes meant for it.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn append_native_mutations_to_source<S: ByteSource>(
    source: S,
    len: u64,
    mutations: &NativeMutationsFile,
    modified_at: &str,
    write: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
) -> Result<IndexedAppend> {
    let mut incremental = open_mutation_base(source, len, mutations)?;
    let page_count = u32::try_from(incremental.get_prev_documents().get_pages().len())
        .map_err(|_| "PDF page count exceeds the WASM response range")?;
    let mut identity_bindings = Vec::new();
    apply_native_mutations_with_bindings(
        &mut incremental,
        mutations,
        modified_at,
        &mut identity_bindings,
    )?;
    let revision = build_incremental_revision(&mut incremental)?;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);
    validate_incremental_append_bytes(
        &revision,
        len,
        incremental.previous_xref_start(),
        &expected_object_ids,
    )?;
    validate_appended_revision_postconditions_with_page_ids(
        &incremental,
        mutations,
        modified_at,
        incremental.located_pages.as_ref(),
    )?;
    validate_annotation_identity_bindings(&identity_bindings)?;
    let annotation_delete_effects = annotation_delete_effects(&incremental)?;
    validate_incremental_append_bytes(
        &write(&revision)?,
        len,
        incremental.previous_xref_start(),
        &expected_object_ids,
    )?;
    Ok(IndexedAppend {
        page_count,
        identity_bindings,
        annotation_delete_effects,
    })
}

#[cfg(test)]
pub(crate) struct NativeMutationBytesResult {
    pub(crate) data: Vec<u8>,
    pub(crate) page_count: u32,
    pub(crate) identity_bindings: Vec<AnnotationIdentityBinding>,
}

/// The whole PDF an append makes of `input`, for tests of the mutation route.
#[cfg(test)]
pub(crate) fn append_native_mutations_to_bytes(
    input: &[u8],
    mutations: &NativeMutationsFile,
    modified_at: &str,
) -> Result<NativeMutationBytesResult> {
    let mut data = input.to_vec();
    let append = append_native_mutations_to_source(
        input,
        u64::try_from(input.len())?,
        mutations,
        modified_at,
        |revision| {
            data.extend_from_slice(revision);
            Ok(revision.to_vec())
        },
    )?;
    Ok(NativeMutationBytesResult {
        data,
        page_count: append.page_count,
        identity_bindings: append.identity_bindings,
    })
}

#[cfg(test)]
pub(crate) fn append_native_mutations(
    input_path: &Path,
    output_path: &Path,
    mutations: &NativeMutationsFile,
    modified_at: &str,
) -> Result<()> {
    append_native_mutations_path(input_path, output_path, mutations, modified_at, None)
}

/// Appends one revision to `output_path`, which must already hold a copy of
/// the input, through an unpublished sibling of it.
pub(crate) fn append_native_mutations_path(
    input_path: &Path,
    output_path: &Path,
    mutations: &NativeMutationsFile,
    modified_at: &str,
    identity_bindings_path: Option<&Path>,
) -> Result<()> {
    stage_native_mutations(
        input_path,
        output_path,
        mutations,
        modified_at,
        Some(output_path),
        identity_bindings_path,
    )
}

/// The non-append CLI form: the requested output is seeded from the input
/// and takes the same appended revision, so no caller loads a PDF whole.
pub(crate) fn write_native_mutations_path(
    input_path: &Path,
    output_path: &Path,
    mutations: &NativeMutationsFile,
    modified_at: &str,
    identity_bindings_path: Option<&Path>,
) -> Result<()> {
    stage_native_mutations(
        input_path,
        output_path,
        mutations,
        modified_at,
        None,
        identity_bindings_path,
    )
}

/// Writes the revision into a staged copy of the input that replaces
/// `output_path` once it is verified. `seeded_destination`, when given, is an
/// output that already holds the input and must still hold it.
fn stage_native_mutations(
    input_path: &Path,
    output_path: &Path,
    mutations: &NativeMutationsFile,
    modified_at: &str,
    seeded_destination: Option<&Path>,
    identity_bindings_path: Option<&Path>,
) -> Result<()> {
    let source_witness = PathRevisionWitness::capture(input_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    let mut incremental = open_mutation_base_path(input_path, mutations)?;
    if let Some(destination) = seeded_destination {
        let previous_len = incremental.previous_len();
        let previous_last_byte = incremental.previous_last_byte();
        let previous_xref_start = incremental.previous_xref_start();
        if !append_paths_refer_to_same_file(input_path, destination) {
            assert_append_output_seeded(input_path, destination, previous_len)?;
        }
        for path in [input_path, destination] {
            assert_append_path_unchanged(
                path,
                previous_len,
                previous_last_byte,
                previous_xref_start,
            )?;
        }
    }

    with_staged_incremental_output_for_revision(
        input_path,
        output_path,
        Some(&source_witness),
        |staged_output_path| {
            write_native_mutations_revision(
                &mut incremental,
                staged_output_path,
                mutations,
                modified_at,
                seeded_destination,
                identity_bindings_path,
            )
        },
    )
}

/// Appends one revision directly to a caller-owned file.
///
/// The caller must provide either an unpublished copy with an outer atomic
/// publication boundary or an exclusively owned working-copy inode covered by
/// a durable copy-on-write backup and recovery journal. Native still validates
/// the admitted file and rolls back a partial revision on every write or
/// postcondition failure, but it does not create another sibling clone.
pub(crate) fn append_native_mutations_in_place(
    input_path: &Path,
    output_path: &Path,
    mutations: &NativeMutationsFile,
    modified_at: &str,
    identity_bindings_path: Option<&Path>,
) -> Result<()> {
    if input_path != output_path {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "In-place native mutation append requires identical input and output paths",
        ));
    }

    let source_witness = PathRevisionWitness::capture(input_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    let mut incremental = open_mutation_base_path(input_path, mutations)?;
    source_witness
        .assert_current()
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    assert_append_path_unchanged(
        input_path,
        incremental.previous_len(),
        incremental.previous_last_byte(),
        incremental.previous_xref_start(),
    )?;
    write_native_mutations_revision(
        &mut incremental,
        output_path,
        mutations,
        modified_at,
        None,
        identity_bindings_path,
    )
}

fn write_native_mutations_revision(
    incremental: &mut IncrementalDocument,
    output_path: &Path,
    mutations: &NativeMutationsFile,
    modified_at: &str,
    destination_fence: Option<&Path>,
    identity_bindings_path: Option<&Path>,
) -> Result<()> {
    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    let mut identity_bindings = Vec::new();
    if identity_bindings_path.is_some() {
        apply_native_mutations_with_bindings(
            incremental,
            mutations,
            modified_at,
            &mut identity_bindings,
        )?;
    } else {
        apply_native_mutations(incremental, mutations, modified_at)?;
    }
    let delete_effects = annotation_delete_effects(incremental)?;
    let identity_bindings_report = identity_bindings_path
        .map(|_| serialize_native_save_report(&identity_bindings, delete_effects.as_ref()))
        .transpose()?;

    let previous_len = incremental.previous_len();
    let previous_last_byte = incremental.previous_last_byte();
    let previous_xref_start = incremental.previous_xref_start();
    assert_append_output_length(output_path, previous_len)?;
    if let Some(destination_path) = destination_fence {
        assert_append_path_unchanged(
            destination_path,
            previous_len,
            previous_last_byte,
            previous_xref_start,
        )?;
    }
    let revision_bytes = build_incremental_revision(incremental)?;
    let expected_object_ids = collect_incremental_append_object_ids(incremental);

    validate_appended_revision_postconditions_with_page_ids(
        incremental,
        mutations,
        modified_at,
        incremental.located_pages.as_ref(),
    )?;

    let result = write_incremental_revision(
        output_path,
        incremental,
        &revision_bytes,
        &expected_object_ids,
    );
    if result.is_ok() {
        if let Some(destination_path) = destination_fence {
            assert_append_path_unchanged(
                destination_path,
                previous_len,
                previous_last_byte,
                previous_xref_start,
            )?;
        }
        if let (Some(path), Some(bytes)) =
            (identity_bindings_path, identity_bindings_report.as_deref())
        {
            fs::write(path, bytes)?;
        }
    }
    result
}

pub(crate) fn write_incremental_revision(
    output_path: &Path,
    incremental: &IncrementalDocument,
    revision_bytes: &[u8],
    expected_object_ids: &[ObjectId],
) -> Result<()> {
    let previous_len = incremental.previous_len();
    let previous_last_byte = incremental.previous_last_byte();
    let previous_xref_start = incremental.previous_xref_start();
    if revision_bytes.is_empty() {
        return validate_incremental_append_bytes(
            revision_bytes,
            previous_len,
            previous_xref_start,
            expected_object_ids,
        );
    }
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(output_path)?;
    assert_append_target_unchanged(
        &mut output,
        previous_len,
        previous_last_byte,
        previous_xref_start,
    )?;
    output.seek(SeekFrom::Start(previous_len))?;
    write_incremental_revision_transactionally(&mut output, previous_len, |writer| {
        writer.write_all(revision_bytes)?;
        Ok(())
    })?;

    let validation_result = validate_incremental_append_output(
        output_path,
        previous_len,
        previous_xref_start,
        expected_object_ids,
    )
    .map_err(|error| reclassify_domain_error(error, NativeErrorCode::CorruptXref));
    if let Err(error) = validation_result {
        return rollback_incremental_append(&mut output, previous_len, error);
    }
    output.sync_all()?;

    Ok(())
}

struct SerializedIncrementalObjects {
    bytes: Vec<u8>,
    entries: Vec<(ObjectId, u64)>,
}

/// A change that writes no object makes no revision: the PDF keeps its bytes.
pub(crate) fn build_incremental_revision(incremental: &mut IncrementalDocument) -> Result<Vec<u8>> {
    if collect_incremental_append_object_ids(incremental).is_empty() {
        return Ok(Vec::new());
    }
    let use_xref_stream = matches!(
        incremental
            .get_prev_documents()
            .reference_table
            .cross_reference_type,
        lopdf::xref::XrefType::CrossReferenceStream
    );
    let mut serialized = serialize_incremental_objects(incremental)?;
    let xref_start = incremental
        .previous_len()
        .checked_add(u64::try_from(serialized.bytes.len())?)
        .ok_or("Incremental PDF offset overflow")?;

    if use_xref_stream || xref_start > MAX_CLASSIC_XREF_OFFSET {
        if !use_xref_stream {
            ensure_pdf_15_catalog_version(incremental)?;
            serialized = serialize_incremental_objects(incremental)?;
        }
        write_xref_stream_revision(incremental, serialized)
    } else {
        write_classic_xref_revision(incremental, serialized)
    }
}

fn ensure_pdf_15_catalog_version(incremental: &mut IncrementalDocument) -> Result<()> {
    let catalog_id = incremental.get_prev_documents().root_id()?;
    incremental.opt_clone_object_to_new_document(catalog_id)?;
    incremental
        .new_document
        .get_dictionary_mut(catalog_id)?
        .set("Version", Object::Name(b"1.5".to_vec()));
    Ok(())
}

fn serialize_incremental_objects(
    incremental: &IncrementalDocument,
) -> Result<SerializedIncrementalObjects> {
    let objects = &incremental.new_document.objects;
    let estimated_bytes = objects
        .values()
        .filter(|object| should_write_incremental_object(object))
        .fold(1usize, |acc, object| {
            let estimate = match object {
                Object::Stream(stream) => stream.content.len().saturating_add(128),
                _ => 128,
            };
            acc.saturating_add(estimate)
        });
    let mut revision = Vec::new();
    let _ = revision.try_reserve(estimated_bytes);
    if incremental
        .previous_last_byte()
        .is_some_and(|byte| byte != b'\n' && byte != b'\r')
    {
        revision.push(b'\n');
    }
    let mut entries = Vec::with_capacity(objects.len());
    for (&object_id, object) in objects {
        if !should_write_incremental_object(object) {
            continue;
        }
        let offset = incremental
            .previous_len()
            .checked_add(u64::try_from(revision.len())?)
            .ok_or("Incremental PDF offset overflow")?;
        entries.push((object_id, offset));
        crate::pdf_writer::write_indirect_object(&mut revision, object_id, object)?;
    }
    Ok(SerializedIncrementalObjects {
        bytes: revision,
        entries,
    })
}

fn write_classic_xref_revision(
    incremental: &IncrementalDocument,
    serialized: SerializedIncrementalObjects,
) -> Result<Vec<u8>> {
    let SerializedIncrementalObjects { mut bytes, entries } = serialized;
    let xref_start = incremental
        .previous_len()
        .checked_add(u64::try_from(bytes.len())?)
        .ok_or("Incremental PDF offset overflow")?;
    if xref_start > MAX_CLASSIC_XREF_OFFSET
        || entries
            .iter()
            .any(|(_, offset)| *offset > MAX_CLASSIC_XREF_OFFSET)
    {
        return Err("Classic PDF cross-reference offset exceeds ten digits".into());
    }

    bytes.extend_from_slice(b"xref\n");
    for run in consecutive_object_runs(&entries) {
        let first_id = run.first().unwrap().0 .0;
        writeln!(bytes, "{} {}", first_id, run.len())?;
        for (object_id, offset) in run {
            writeln!(bytes, "{offset:010} {:05} n ", object_id.1)?;
        }
    }
    let mut trailer = incremental.new_document.trailer.clone();
    sanitize_incremental_trailer(&mut trailer);
    trailer.set(
        "Size",
        i64::from(
            incremental
                .new_document
                .max_id
                .max(incremental.get_prev_documents().max_id),
        ) + 1,
    );
    bytes.extend_from_slice(b"trailer\n");
    crate::pdf_writer::write_direct_dictionary(&mut bytes, &trailer)?;
    write!(bytes, "\nstartxref\n{xref_start}\n%%EOF")?;
    Ok(bytes)
}

fn write_xref_stream_revision(
    incremental: &IncrementalDocument,
    serialized: SerializedIncrementalObjects,
) -> Result<Vec<u8>> {
    let SerializedIncrementalObjects {
        mut bytes,
        mut entries,
    } = serialized;
    let xref_object_id = incremental
        .new_document
        .max_id
        .max(incremental.get_prev_documents().max_id)
        .checked_add(1)
        .ok_or("PDF object number overflow")?;
    let xref_offset = incremental
        .previous_len()
        .checked_add(u64::try_from(bytes.len())?)
        .ok_or("Incremental PDF offset overflow")?;
    entries.push(((xref_object_id, 0), xref_offset));
    entries.sort_unstable_by_key(|(object_id, _)| *object_id);

    let mut content = Vec::with_capacity(entries.len() * (1 + XREF_STREAM_OFFSET_BYTES + 2));
    for (object_id, offset) in &entries {
        content.push(1);
        content.extend_from_slice(&offset.to_be_bytes());
        content.extend_from_slice(&object_id.1.to_be_bytes());
    }
    let mut trailer = incremental.new_document.trailer.clone();
    sanitize_incremental_trailer(&mut trailer);
    trailer.set("Type", Object::Name(b"XRef".to_vec()));
    trailer.set("Size", i64::from(xref_object_id) + 1);
    trailer.set(
        "W",
        Object::Array(vec![
            1.into(),
            (XREF_STREAM_OFFSET_BYTES as i64).into(),
            2.into(),
        ]),
    );
    trailer.set(
        "Index",
        Object::Array(
            consecutive_object_runs(&entries)
                .into_iter()
                .flat_map(|run| {
                    [
                        Object::Integer(i64::from(run.first().unwrap().0 .0)),
                        Object::Integer(i64::try_from(run.len()).unwrap()),
                    ]
                })
                .collect(),
        ),
    );
    let xref_stream = Object::Stream(Stream::new(trailer, content));
    crate::pdf_writer::write_indirect_object(&mut bytes, (xref_object_id, 0), &xref_stream)?;
    write!(bytes, "startxref\n{xref_offset}\n%%EOF")?;
    Ok(bytes)
}

pub(crate) fn consecutive_object_runs(entries: &[(ObjectId, u64)]) -> Vec<&[(ObjectId, u64)]> {
    if entries.is_empty() {
        return Vec::new();
    }
    let mut runs = Vec::new();
    let mut start = 0;
    for index in 1..=entries.len() {
        if index == entries.len()
            || entries[index].0 .0 != entries[index - 1].0 .0.saturating_add(1)
        {
            runs.push(&entries[start..index]);
            start = index;
        }
    }
    runs
}

fn sanitize_incremental_trailer(trailer: &mut Dictionary) {
    for key in [
        b"Type".as_slice(),
        b"W",
        b"Index",
        b"Length",
        b"Filter",
        b"DecodeParms",
    ] {
        trailer.remove(key);
    }
}

pub(crate) fn collect_incremental_append_object_ids(
    incremental: &IncrementalDocument,
) -> Vec<ObjectId> {
    incremental
        .new_document
        .objects
        .iter()
        .filter_map(|(&object_id, object)| {
            if should_write_incremental_object(object) {
                Some(object_id)
            } else {
                None
            }
        })
        .collect()
}

pub(crate) fn should_write_incremental_object(object: &Object) -> bool {
    object
        .type_name()
        .map(|name| {
            ![
                b"ObjStm".as_slice(),
                b"XRef".as_slice(),
                b"Linearized".as_slice(),
            ]
            .contains(&name)
        })
        .unwrap_or(true)
}

#[cfg(test)]
mod writer_boundary_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn incremental_at(previous_len: u64) -> (IncrementalDocument, ObjectId) {
        let mut previous = Document::with_version("1.4");
        let catalog_id = previous.new_object_id();
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        previous.set_object(catalog_id, Object::Dictionary(catalog.clone()));
        previous.trailer.set("Root", catalog_id);
        previous.xref_start = 37;
        previous.reference_table = lopdf::xref::Xref::new(
            previous.max_id.saturating_add(1),
            lopdf::xref::XrefType::CrossReferenceTable,
        );
        let mut incremental =
            IncrementalDocument::from_document(previous, previous_len, Some(b'\n'));
        catalog.set("EVBTest", Object::Integer(1));
        incremental
            .new_document
            .set_object(catalog_id, Object::Dictionary(catalog));
        (incremental, catalog_id)
    }

    fn revision_xref_entries(revision: &[u8], previous_len: u64) -> (bool, HashMap<ObjectId, u64>) {
        let xref_start = parse_number_after_last_marker(revision, b"startxref").unwrap();
        let relative = usize::try_from(xref_start - previous_len).unwrap();
        let classic = revision[relative..].starts_with(b"xref");
        let entries = if classic {
            parse_incremental_xref_table(revision, relative).unwrap()
        } else {
            parse_incremental_xref_stream(revision, relative).unwrap()
        };
        (classic, entries)
    }

    #[test]
    fn classic_xref_preserves_offsets_on_both_sides_of_four_gib() {
        for previous_len in [u64::from(u32::MAX), u64::from(u32::MAX) + 1] {
            let (mut incremental, catalog_id) = incremental_at(previous_len);
            let revision = build_incremental_revision(&mut incremental).unwrap();
            let (classic, entries) = revision_xref_entries(&revision, previous_len);
            assert!(classic);
            assert_eq!(entries.get(&catalog_id), Some(&previous_len));
        }
    }

    #[test]
    fn ten_digit_boundary_switches_to_an_eight_byte_xref_stream() {
        for previous_len in [MAX_CLASSIC_XREF_OFFSET, MAX_CLASSIC_XREF_OFFSET + 1] {
            let (mut incremental, catalog_id) = incremental_at(previous_len);
            let revision = build_incremental_revision(&mut incremental).unwrap();
            let (classic, entries) = revision_xref_entries(&revision, previous_len);
            assert!(!classic);
            assert_eq!(entries.get(&catalog_id), Some(&previous_len));
            assert!(find_bytes(&revision, b"/Version/1.5").is_some());
        }
    }

    #[test]
    fn revision_offset_overflow_fails_before_output() {
        let (mut incremental, _) = incremental_at(u64::MAX);
        let error = build_incremental_revision(&mut incremental).unwrap_err();
        assert!(error.to_string().contains("offset overflow"));
    }

    #[test]
    fn a_change_that_writes_no_object_leaves_the_pdf_bytes_unchanged() {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id =
            document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
        document.trailer.set("Root", catalog_id);
        let mut input = Vec::new();
        document.save_to(&mut input).unwrap();
        let mutations = NativeMutationsFile {
            shapes: Some(serde_json::from_str(
                r#"{"totalPages":1,"rewriteShapeState":false,"shapes":[],"deletedAnnotationIds":[],"deletedStableKeys":[]}"#,
            ).unwrap()),
            ..NativeMutationsFile::default()
        };

        let appended =
            append_native_mutations_to_bytes(&input, &mutations, "D:20261120000000Z").unwrap();
        assert_eq!(appended.data, input);

        let path = std::env::temp_dir().join(format!(
            "evb-incremental-no-object-{}.pdf",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, &input).unwrap();
        append_native_mutations(&path, &path, &mutations, "D:20261120000000Z").unwrap();
        assert_eq!(fs::read(&path).unwrap(), input);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn staged_output_preserves_existing_destination_when_revision_fails() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let input = std::env::temp_dir().join(format!("evb-incremental-stage-input-{nonce}"));
        let output = std::env::temp_dir().join(format!("evb-incremental-stage-output-{nonce}"));
        fs::write(&input, b"source-pdf").unwrap();
        fs::write(&output, b"existing-output").unwrap();

        let error = with_staged_incremental_output(&input, &output, |staged_path| {
            fs::write(staged_path, b"partial-new-output").unwrap();
            Err("intentional incremental failure".into())
        })
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("intentional incremental failure"));
        assert_eq!(fs::read(&output).unwrap(), b"existing-output");
        let prefix = format!(
            ".{}.evb-tmp-",
            output.file_name().unwrap().to_string_lossy()
        );
        assert!(!fs::read_dir(output.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| { entry.file_name().to_string_lossy().starts_with(&prefix) }));

        let _ = fs::remove_file(input);
        let _ = fs::remove_file(output);
    }

    #[test]
    fn staged_output_preserves_same_file_when_revision_fails() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("evb-incremental-same-stage-{nonce}"));
        fs::write(&path, b"existing-output").unwrap();

        let error = with_staged_incremental_output(&path, &path, |staged_path| {
            fs::write(staged_path, b"partial-new-output").unwrap();
            Err("intentional same-file failure".into())
        })
        .unwrap_err();

        assert!(error.to_string().contains("intentional same-file failure"));
        assert_eq!(fs::read(&path).unwrap(), b"existing-output");
        let prefix = format!(".{}.evb-tmp-", path.file_name().unwrap().to_string_lossy());
        assert!(!fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn staged_output_publishes_a_complete_same_file_revision() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("evb-incremental-same-stage-ok-{nonce}"));
        fs::write(&path, b"existing-output").unwrap();

        with_staged_incremental_output(&path, &path, |staged_path| {
            let mut staged = OpenOptions::new().append(true).open(staged_path)?;
            staged.write_all(b"-complete-revision")?;
            staged.flush()?;
            Ok(())
        })
        .unwrap();

        assert_eq!(
            fs::read(&path).unwrap(),
            b"existing-output-complete-revision"
        );
        let prefix = format!(".{}.evb-tmp-", path.file_name().unwrap().to_string_lossy());
        assert!(!fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn staged_output_seed_failure_preserves_existing_destination() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let input = std::env::temp_dir().join(format!("evb-incremental-missing-stage-{nonce}"));
        let output = std::env::temp_dir().join(format!("evb-incremental-seed-stage-{nonce}"));
        fs::write(&output, b"existing-output").unwrap();
        let closure_called = std::cell::Cell::new(false);

        let error = with_staged_incremental_output(&input, &output, |_staged_path| {
            closure_called.set(true);
            Ok(())
        })
        .unwrap_err();

        assert!(!closure_called.get());
        assert_eq!(
            error.downcast_ref::<NativeError>().map(|error| error.code),
            Some(NativeErrorCode::Io)
        );
        assert_eq!(fs::read(&output).unwrap(), b"existing-output");
        let prefix = format!(
            ".{}.evb-tmp-",
            output.file_name().unwrap().to_string_lossy()
        );
        assert!(!fs::read_dir(output.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)));
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn staged_output_validation_failure_preserves_existing_destination() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let input = std::env::temp_dir().join(format!("evb-incremental-validation-input-{nonce}"));
        let output =
            std::env::temp_dir().join(format!("evb-incremental-validation-output-{nonce}"));
        fs::write(&input, b"source-pdf").unwrap();
        fs::write(&output, b"existing-output").unwrap();
        let previous_len = fs::metadata(&input).unwrap().len();

        let error = with_staged_incremental_output(&input, &output, |staged_path| {
            let mut staged = OpenOptions::new().append(true).open(staged_path)?;
            staged.write_all(b"partial-revision")?;
            staged.flush()?;
            validate_incremental_append_output(staged_path, previous_len, 0, &[])
        })
        .unwrap_err();

        assert!(error.to_string().contains("missing an EOF marker"));
        assert_eq!(fs::read(&output).unwrap(), b"existing-output");
        let prefix = format!(
            ".{}.evb-tmp-",
            output.file_name().unwrap().to_string_lossy()
        );
        assert!(!fs::read_dir(output.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)));
        fs::remove_file(input).unwrap();
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn staging_rejects_source_replaced_after_structural_admission() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let input = std::env::temp_dir().join(format!("evb-admitted-source-{nonce}"));
        let displaced = std::env::temp_dir().join(format!("evb-admitted-source-old-{nonce}"));
        let output = std::env::temp_dir().join(format!("evb-admitted-output-{nonce}"));
        fs::write(&input, b"admitted-pdf-tail").unwrap();
        fs::write(&output, b"existing-output").unwrap();

        let result = with_staged_incremental_output_after_admission(
            &input,
            &output,
            || {
                fs::rename(&input, &displaced).unwrap();
                fs::write(&input, b"external-pdf-tail").unwrap();
            },
            |_staged_path| Ok(()),
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&input).unwrap(), b"external-pdf-tail");
        assert_eq!(fs::read(&output).unwrap(), b"existing-output");
        fs::remove_file(input).unwrap();
        fs::remove_file(displaced).unwrap();
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn direct_serialization_round_trips_and_matches_lopdf_across_object_types_and_xref_modes() {
        let mut base_doc = Document::with_version("1.5");
        let pages_id = base_doc.new_object_id();
        let page_id = base_doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        base_doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = base_doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        base_doc.trailer.set("Root", catalog_id);

        let mut classic_doc = base_doc.clone();
        classic_doc.reference_table.cross_reference_type =
            lopdf::xref::XrefType::CrossReferenceTable;
        let mut classic_base = Vec::new();
        classic_doc.save_to(&mut classic_base).unwrap();
        let mut modern_doc = base_doc.clone();
        modern_doc.reference_table.cross_reference_type =
            lopdf::xref::XrefType::CrossReferenceStream;
        let mut modern_base = Vec::new();
        modern_doc.save_modern(&mut modern_base).unwrap();

        let mut compressed_stream = Stream::new(
            dictionary! { "CustomTag" => "CompressedPayload" },
            b"Repeated text payload for FlateDecode verification ".repeat(16),
        );
        compressed_stream.compress().unwrap();

        // Stream with intentionally stale /Length to verify direct serialization repairs /Length.
        let stale_length_stream = Stream {
            dict: dictionary! { "Length" => 999999, "Subtype" => "RawTest" },
            content: b"\x00\x01\x02\r\nendstream-inside-len-check\xFF".to_vec(),
            allows_compression: false,
            start_position: None,
        };
        let empty_stream = Stream::new(dictionary! { "Subtype" => "Empty" }, Vec::new());

        let rich_objects: Vec<(ObjectId, Object)> = vec![
            ((20, 0), Object::Null),
            ((21, 0), Object::Boolean(true)),
            ((22, 0), Object::Boolean(false)),
            ((23, 0), Object::Integer(-987_654_321)),
            ((24, 0), Object::Real(-123.5)),
            ((25, 0), Object::Name(b"PlainName".to_vec())),
            (
                (26, 0),
                Object::Name(b"Name With #Delims/()<>[]%{}\x00\x7F\xFF".to_vec()),
            ),
            (
                (27, 0),
                Object::String(b"Simple literal text".to_vec(), StringFormat::Literal),
            ),
            (
                (28, 0),
                Object::String(
                    b"Balanced (nested (parens)) + unbalanced (( and ) + slash \\ + cr\r + lf\n"
                        .to_vec(),
                    StringFormat::Literal,
                ),
            ),
            (
                (29, 0),
                Object::String(
                    vec![0x00, 0x0A, 0x0D, 0x28, 0x29, 0x5C, 0xAB, 0xFE, 0xFF],
                    StringFormat::Hexadecimal,
                ),
            ),
            (
                (30, 0),
                Object::String(Vec::new(), StringFormat::Hexadecimal),
            ),
            (
                (31, 0),
                Object::Array(vec![
                    Object::Null,
                    Object::Boolean(true),
                    Object::Integer(42),
                    Object::Real(0.25),
                    Object::Name(b"Key#1".to_vec()),
                    Object::String(b"lit(a)".to_vec(), StringFormat::Literal),
                    Object::String(b"\xDE\xAD".to_vec(), StringFormat::Hexadecimal),
                    Object::Reference((20, 0)),
                    Object::Array(vec![Object::Integer(1), Object::Integer(2)]),
                    Object::Dictionary(dictionary! {
                        "NestedBool" => false,
                        "NestedRef" => Object::Reference((21, 0)),
                    }),
                ]),
            ),
            (
                (32, 0),
                Object::Dictionary(dictionary! {
                    "Type" => "EVBTestDict",
                    "NullVal" => Object::Null,
                    "Num" => 7,
                    "Float" => 3.5f32,
                    "Special Key#%" => Object::String(b"val\\(\r)".to_vec(), StringFormat::Literal),
                    "Hex" => Object::String(b"cafe".to_vec(), StringFormat::Hexadecimal),
                    "EmptyDict" => Dictionary::new(),
                    "EmptyArr" => Vec::<Object>::new(),
                    "Ref" => Object::Reference((31, 0)),
                }),
            ),
            ((33, 2), Object::Reference((32, 0))),
            ((34, 0), Object::Stream(compressed_stream)),
            ((35, 0), Object::Stream(stale_length_stream)),
            ((36, 0), Object::Stream(empty_stream)),
        ];

        // Reference serialization via lopdf::Document::save_to to differentially verify parsed equality.
        let mut lopdf_ref = Document::with_version("1.7");
        for (id, object) in &rich_objects {
            let mut normalized = object.clone();
            if let Object::Stream(stream) = &mut normalized {
                stream.dict.set("Length", stream.content.len() as i64);
            }
            lopdf_ref.objects.insert(*id, normalized);
            lopdf_ref.max_id = lopdf_ref.max_id.max(id.0);
        }
        lopdf_ref.trailer.set("Root", catalog_id);
        let mut lopdf_ref_bytes = Vec::new();
        lopdf_ref.save_to(&mut lopdf_ref_bytes).unwrap();
        let lopdf_reparsed = Document::load_mem(&lopdf_ref_bytes).unwrap();

        for (label, expect_classic, base_bytes) in [
            ("classic", true, &classic_base),
            ("xref-stream", false, &modern_base),
        ] {
            let base_xref = parse_number_after_last_marker(base_bytes, b"startxref").unwrap();
            assert_eq!(
                base_bytes[base_xref as usize..].starts_with(b"xref"),
                expect_classic,
                "{label}: base PDF xref format mismatch"
            );
            let mut source =
                SourcePdf::open_append_base(base_bytes.as_slice(), base_bytes.len() as u64)
                    .unwrap();
            let mut incremental = source.take_append_base().unwrap();
            for (id, object) in &rich_objects {
                incremental.new_document.objects.insert(*id, object.clone());
                incremental.new_document.max_id = incremental.new_document.max_id.max(id.0);
            }
            // Add a catalog reference to object 32 so strict verify reaches the objects.
            incremental
                .opt_clone_object_to_new_document(catalog_id)
                .unwrap();
            incremental
                .new_document
                .get_dictionary_mut(catalog_id)
                .unwrap()
                .set(
                    "EVBTestRefs",
                    Object::Array(
                        rich_objects
                            .iter()
                            .map(|(id, _)| Object::Reference(*id))
                            .collect(),
                    ),
                );
            let revision = build_incremental_revision(&mut incremental).unwrap();
            let (is_classic, _) = revision_xref_entries(&revision, incremental.previous_len());
            assert_eq!(
                is_classic, expect_classic,
                "{label}: emitted revision xref format mismatch"
            );
            let expected_ids = collect_incremental_append_object_ids(&incremental);
            validate_incremental_append_bytes(
                &revision,
                incremental.previous_len(),
                incremental.previous_xref_start(),
                &expected_ids,
            )
            .unwrap_or_else(|err| panic!("{label}: revision failed validation: {err}"));

            let mut combined = base_bytes.clone();
            combined.extend_from_slice(&revision);
            SourcePdf::open_strict_verify(combined.as_slice(), combined.len() as u64)
                .unwrap_or_else(|err| panic!("{label}: strict verify failed: {err}"));

            let loaded = Document::load_mem(&combined).unwrap();
            for (id, _) in &rich_objects {
                let actual = loaded
                    .objects
                    .get(id)
                    .unwrap_or_else(|| panic!("{label}: missing object {id:?}"));
                let expected = lopdf_reparsed.objects.get(id).unwrap();
                match (actual, expected) {
                    (Object::Stream(a), Object::Stream(b)) => {
                        assert_eq!(a.dict, b.dict, "{label}: stream dict mismatch for {id:?}");
                        assert_eq!(
                            a.content, b.content,
                            "{label}: stream content mismatch for {id:?}"
                        );
                    }
                    _ => assert_eq!(actual, expected, "{label}: object mismatch for {id:?}"),
                }
            }

            // Second incremental revision stacked on top of the first.
            incremental
                .advance_verified_revision_bytes(&revision)
                .unwrap();
            let second_id = incremental.new_document.add_object(dictionary! {
                "Type" => "SecondRevision",
                "Note" => Object::String(b"chained (rev 2)".to_vec(), StringFormat::Literal),
            });
            let second_revision = build_incremental_revision(&mut incremental).unwrap();
            let second_ids = collect_incremental_append_object_ids(&incremental);
            validate_incremental_append_bytes(
                &second_revision,
                incremental.previous_len(),
                incremental.previous_xref_start(),
                &second_ids,
            )
            .unwrap();
            combined.extend_from_slice(&second_revision);
            SourcePdf::open_strict_verify(combined.as_slice(), combined.len() as u64).unwrap();
            let loaded2 = Document::load_mem(&combined).unwrap();
            assert_eq!(
                loaded2
                    .get_dictionary(second_id)
                    .unwrap()
                    .get(b"Note")
                    .unwrap()
                    .as_str()
                    .unwrap(),
                b"chained (rev 2)"
            );
        }

        // Encrypted PDF must remain refused for incremental append, and after decrypting
        // into plaintext must accept our direct-serialized incremental append cleanly.
        let mut encrypted_doc = base_doc.clone();
        encrypted_doc.trailer.set(
            "ID",
            vec![
                Object::string_literal("0123456789ABCDEF"),
                Object::string_literal("0123456789ABCDEF"),
            ],
        );
        let version = lopdf::encryption::EncryptionVersion::V2 {
            document: &encrypted_doc,
            owner_password: "owner",
            user_password: "",
            key_length: 128,
            permissions: lopdf::encryption::Permissions::PRINTABLE,
        };
        let state: lopdf::encryption::EncryptionState = version.try_into().unwrap();
        encrypted_doc.encrypt(&state).unwrap();
        let mut encrypted_bytes = Vec::new();
        encrypted_doc.save_to(&mut encrypted_bytes).unwrap();
        let enc_err =
            SourcePdf::open_append_base(encrypted_bytes.as_slice(), encrypted_bytes.len() as u64)
                .err()
                .expect("encrypted PDF must be refused as an append base");
        assert_eq!(
            enc_err.downcast_ref::<NativeError>().map(|err| err.code),
            Some(NativeErrorCode::Encrypted)
        );
        let decrypted = decrypt_browser_pdf_bytes(&encrypted_bytes, b"").unwrap();
        let mut dec_source =
            SourcePdf::open_append_base(decrypted.data.as_slice(), decrypted.data.len() as u64)
                .unwrap();
        let mut dec_inc = dec_source.take_append_base().unwrap();
        let note_id = dec_inc.new_document.add_object(dictionary! {
            "Type" => "PostDecryptCheck",
            "Text" => Object::String(b"after decrypt (ok)".to_vec(), StringFormat::Literal),
        });
        let dec_rev = build_incremental_revision(&mut dec_inc).unwrap();
        let dec_ids = collect_incremental_append_object_ids(&dec_inc);
        validate_incremental_append_bytes(
            &dec_rev,
            dec_inc.previous_len(),
            dec_inc.previous_xref_start(),
            &dec_ids,
        )
        .unwrap();
        let mut dec_combined = decrypted.data;
        dec_combined.extend_from_slice(&dec_rev);
        SourcePdf::open_strict_verify(dec_combined.as_slice(), dec_combined.len() as u64).unwrap();
        let dec_loaded = Document::load_mem(&dec_combined).unwrap();
        assert_eq!(
            dec_loaded
                .get_dictionary(note_id)
                .unwrap()
                .get(b"Text")
                .unwrap()
                .as_str()
                .unwrap(),
            b"after decrypt (ok)"
        );
    }
}

pub(crate) fn validate_incremental_append_output(
    output_path: &Path,
    previous_len: u64,
    previous_xref_start: u64,
    expected_object_ids: &[ObjectId],
) -> Result<()> {
    let final_len = fs::metadata(output_path)?.len();
    if final_len <= previous_len {
        return Err("Native incremental append did not grow the PDF".into());
    }

    let mut output = File::open(output_path)?;
    output.seek(SeekFrom::Start(previous_len))?;
    let mut appended_bytes = Vec::new();
    output.read_to_end(&mut appended_bytes)?;
    validate_incremental_append_bytes(
        &appended_bytes,
        previous_len,
        previous_xref_start,
        expected_object_ids,
    )
}

pub(crate) fn validate_incremental_append_bytes(
    appended_bytes: &[u8],
    previous_len: u64,
    previous_xref_start: u64,
    expected_object_ids: &[ObjectId],
) -> Result<()> {
    if appended_bytes.is_empty() {
        if expected_object_ids.is_empty() {
            return Ok(());
        }
        return Err("Native incremental append produced no revision bytes".into());
    }
    let final_len = previous_len
        .checked_add(u64::try_from(appended_bytes.len())?)
        .ok_or("Native incremental append length overflow")?;
    let eof_offset = find_last_bytes(appended_bytes, b"%%EOF")
        .ok_or("Native incremental append is missing an EOF marker")?;
    if !appended_bytes[eof_offset + b"%%EOF".len()..]
        .iter()
        .all(|byte| byte.is_ascii_whitespace())
    {
        return Err("Native incremental append has trailing bytes after EOF".into());
    }

    let prev_offset = parse_number_after_last_marker(appended_bytes, b"/Prev")
        .ok_or("Native incremental append is missing a /Prev pointer")?;
    if prev_offset != previous_xref_start {
        return Err(
            "Native incremental append /Prev pointer does not match the previous revision".into(),
        );
    }

    let startxref_offset = parse_number_after_last_marker(appended_bytes, b"startxref")
        .ok_or("Native incremental append is missing startxref")?;
    if startxref_offset < previous_len || startxref_offset >= final_len {
        return Err("Native incremental append startxref is outside the appended revision".into());
    }

    let xref_relative_offset = usize::try_from(startxref_offset - previous_len)?;
    let xref_entries = if appended_bytes
        .get(xref_relative_offset..)
        .is_some_and(|bytes| bytes.starts_with(b"xref"))
    {
        parse_incremental_xref_table(appended_bytes, xref_relative_offset)?
    } else {
        parse_incremental_xref_stream(appended_bytes, xref_relative_offset)?
    };
    validate_expected_incremental_objects(
        appended_bytes,
        previous_len,
        expected_object_ids,
        &xref_entries,
    )?;

    Ok(())
}

pub(crate) fn validate_expected_incremental_objects(
    appended_bytes: &[u8],
    previous_len: u64,
    expected_object_ids: &[ObjectId],
    xref_entries: &HashMap<ObjectId, u64>,
) -> Result<()> {
    for object_id in expected_object_ids {
        let xref_offset = xref_entries.get(object_id).ok_or_else(|| {
            format!("Native incremental append xref is missing object {object_id:?}")
        })?;
        if *xref_offset < previous_len {
            return Err(format!(
                "Native incremental append xref for object {object_id:?} points before the appended revision"
            )
            .into());
        }
        let relative_offset = usize::try_from(*xref_offset - previous_len)?;
        let object_header = format!("{} {} obj", object_id.0, object_id.1);
        if !appended_bytes
            .get(relative_offset..)
            .is_some_and(|bytes| bytes.starts_with(object_header.as_bytes()))
        {
            return Err(format!(
                "Native incremental append xref for object {object_id:?} does not point to its object header"
            )
            .into());
        }
    }
    Ok(())
}

pub(crate) fn parse_incremental_xref_table(
    appended_bytes: &[u8],
    xref_relative_offset: usize,
) -> Result<HashMap<ObjectId, u64>> {
    let mut cursor = xref_relative_offset + b"xref".len();
    let mut entries = HashMap::new();
    loop {
        cursor = skip_ascii_whitespace(appended_bytes, cursor);
        if appended_bytes
            .get(cursor..)
            .is_some_and(|bytes| bytes.starts_with(b"trailer"))
        {
            let trailer_bytes = &appended_bytes[cursor..];
            parse_number_after_marker(trailer_bytes, b"/Size")
                .ok_or("Native incremental append trailer is missing /Size")?;
            return Ok(entries);
        }

        let (start_object, next_cursor) = parse_u32_token(appended_bytes, cursor)
            .ok_or("Native incremental append xref table has an invalid subsection start")?;
        let (entry_count, next_cursor) = parse_u32_token(appended_bytes, next_cursor)
            .ok_or("Native incremental append xref table has an invalid subsection length")?;
        cursor = next_cursor;

        for index in 0..entry_count {
            let (offset, next_cursor) = parse_u64_token(appended_bytes, cursor)
                .ok_or("Native incremental append xref table has an invalid entry offset")?;
            let (generation, next_cursor) = parse_u16_token(appended_bytes, next_cursor)
                .ok_or("Native incremental append xref table has an invalid generation")?;
            let (kind, next_cursor) = parse_non_whitespace_byte(appended_bytes, next_cursor)
                .ok_or("Native incremental append xref table has an invalid entry type")?;
            cursor = next_cursor;
            if kind == b'n' {
                let object_number = start_object.checked_add(index).ok_or(
                    "Native incremental append xref table subsection exceeds the object-number limit",
                )?;
                entries.insert((object_number, generation), offset);
            }
        }
    }
}

pub(crate) fn parse_incremental_xref_stream(
    appended_bytes: &[u8],
    xref_relative_offset: usize,
) -> Result<HashMap<ObjectId, u64>> {
    let xref_bytes = appended_bytes
        .get(xref_relative_offset..)
        .ok_or("Native incremental append xref stream offset is invalid")?;
    let (xref_object_number, cursor) = parse_u32_token(xref_bytes, 0)
        .ok_or("Native incremental append xref stream has an invalid object number")?;
    let (xref_generation, cursor) = parse_u16_token(xref_bytes, cursor)
        .ok_or("Native incremental append xref stream has an invalid generation")?;
    let (object_marker, _) = parse_non_whitespace_token(xref_bytes, cursor)
        .ok_or("Native incremental append xref stream has an invalid object header")?;
    if object_marker != b"obj" || xref_generation != 0 {
        return Err("Native incremental append xref stream object header is invalid".into());
    }

    let stream_marker_offset = find_bytes(xref_bytes, b"stream")
        .ok_or("Native incremental append xref stream is missing stream data")?;
    let dictionary_bytes = &xref_bytes[..stream_marker_offset];
    if !(contains_bytes(dictionary_bytes, b"/Type/XRef")
        || contains_bytes(dictionary_bytes, b"/Type") && contains_bytes(dictionary_bytes, b"/XRef"))
    {
        return Err("Native incremental append xref stream is missing /Type /XRef".into());
    }
    if contains_bytes(dictionary_bytes, b"/Filter") {
        return Err(domain_error(
            NativeErrorCode::UnsupportedFilter,
            "Native incremental append xref stream uses an unsupported filter",
        ));
    }
    parse_number_after_marker(dictionary_bytes, b"/Size")
        .ok_or("Native incremental append xref stream is missing /Size")?;
    let w_values = parse_number_array_after_marker(dictionary_bytes, b"/W")
        .ok_or("Native incremental append xref stream is missing /W")?;
    if w_values.len() != 3 || w_values.iter().any(|width| *width > 8) {
        return Err("Native incremental append xref stream has unsupported /W widths".into());
    }
    let widths = [
        usize::try_from(w_values[0])?,
        usize::try_from(w_values[1])?,
        usize::try_from(w_values[2])?,
    ];
    let entry_stride = widths
        .iter()
        .try_fold(0usize, |total, width| total.checked_add(*width))
        .filter(|stride| *stride > 0)
        .ok_or("Native incremental append xref stream has an invalid /W stride")?;
    let index_values = parse_number_array_after_marker(dictionary_bytes, b"/Index")
        .ok_or("Native incremental append xref stream is missing /Index")?;
    if index_values.len() % 2 != 0 {
        return Err("Native incremental append xref stream has an invalid /Index array".into());
    }

    let stream_content_start =
        skip_stream_line_ending(xref_bytes, stream_marker_offset + b"stream".len());
    let endstream_offset = find_bytes(&xref_bytes[stream_content_start..], b"endstream")
        .map(|offset| stream_content_start + offset)
        .ok_or("Native incremental append xref stream is missing endstream")?;
    let mut stream_content_end = endstream_offset;
    if stream_content_end > stream_content_start && xref_bytes[stream_content_end - 1] == b'\n' {
        stream_content_end -= 1;
        if stream_content_end > stream_content_start && xref_bytes[stream_content_end - 1] == b'\r'
        {
            stream_content_end -= 1;
        }
    }
    let stream_content = &xref_bytes[stream_content_start..stream_content_end];
    let declared_length = parse_number_after_marker(dictionary_bytes, b"/Length")
        .ok_or("Native incremental append xref stream is missing /Length")?;
    if declared_length != u64::try_from(stream_content.len())? {
        return Err("Native incremental append xref stream length does not match /Length".into());
    }

    let mut entries = HashMap::new();
    let mut content_cursor = 0;
    for pair in index_values.chunks(2) {
        let start_object = u32::try_from(pair[0])?;
        let entry_count = u32::try_from(pair[1])?;
        for object_index in 0..entry_count {
            let entry = stream_content
                .get(content_cursor..content_cursor + entry_stride)
                .ok_or("Native incremental append xref stream ended early")?;
            content_cursor += entry_stride;
            let mut field_cursor = 0usize;
            let entry_type = if widths[0] == 0 {
                1
            } else {
                read_xref_stream_field(entry, &mut field_cursor, widths[0])?
            };
            let offset = read_xref_stream_field(entry, &mut field_cursor, widths[1])?;
            let generation = read_xref_stream_field(entry, &mut field_cursor, widths[2])?;
            if entry_type == 1 {
                let object_number = start_object.checked_add(object_index).ok_or(
                    "Native incremental append xref stream /Index exceeds the object-number limit",
                )?;
                entries.insert((object_number, u16::try_from(generation)?), offset);
            }
        }
    }
    if content_cursor != stream_content.len() {
        return Err("Native incremental append xref stream contains extra entry bytes".into());
    }
    let xref_absolute_offset = parse_number_after_last_marker(appended_bytes, b"startxref")
        .ok_or("Native incremental append is missing startxref")?;
    entries
        .get(&(xref_object_number, 0))
        .filter(|offset| **offset == xref_absolute_offset)
        .ok_or("Native incremental append xref stream does not point to itself")?;

    Ok(entries)
}

#[doc(hidden)]
pub fn fuzz_parse_incremental_xref_table(data: &[u8]) {
    let _ = parse_incremental_xref_table(data, 0);
}

#[doc(hidden)]
pub fn fuzz_parse_incremental_xref_stream(data: &[u8]) {
    let _ = parse_incremental_xref_stream(data, 0);
}

pub(crate) fn read_xref_stream_field(
    entry: &[u8],
    cursor: &mut usize,
    width: usize,
) -> Result<u64> {
    let bytes = entry
        .get(
            *cursor
                ..cursor
                    .checked_add(width)
                    .ok_or("Invalid xref field width")?,
        )
        .ok_or("Native incremental append xref stream field ended early")?;
    *cursor += width;
    bytes.iter().try_fold(0u64, |value, byte| {
        value
            .checked_mul(256)
            .and_then(|value| value.checked_add(u64::from(*byte)))
            .ok_or_else(|| "Native incremental append xref stream field overflow".into())
    })
}

pub(crate) fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

pub(crate) fn find_last_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

pub(crate) fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub(crate) fn parse_number_after_marker(bytes: &[u8], marker: &[u8]) -> Option<u64> {
    let index = find_bytes(bytes, marker)? + marker.len();
    parse_u64_token(bytes, index).map(|(value, _)| value)
}

pub(crate) fn parse_number_after_last_marker(bytes: &[u8], marker: &[u8]) -> Option<u64> {
    let index = find_last_bytes(bytes, marker)? + marker.len();
    parse_u64_token(bytes, index).map(|(value, _)| value)
}

pub(crate) fn parse_number_array_after_marker(bytes: &[u8], marker: &[u8]) -> Option<Vec<u64>> {
    let mut index = skip_ascii_whitespace(bytes, find_bytes(bytes, marker)? + marker.len());
    if bytes.get(index) != Some(&b'[') {
        return None;
    }
    index += 1;
    let mut values = Vec::new();
    loop {
        index = skip_ascii_whitespace(bytes, index);
        match bytes.get(index) {
            Some(b']') => return Some(values),
            Some(_) => {
                let (value, next_index) = parse_u64_token(bytes, index)?;
                values.push(value);
                index = next_index;
            }
            None => return None,
        }
    }
}

pub(crate) fn skip_ascii_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

pub(crate) fn skip_stream_line_ending(bytes: &[u8], index: usize) -> usize {
    match bytes.get(index..) {
        Some(bytes) if bytes.starts_with(b"\r\n") => index + 2,
        Some(bytes) if bytes.starts_with(b"\n") || bytes.starts_with(b"\r") => index + 1,
        _ => index,
    }
}

pub(crate) fn parse_u64_token(bytes: &[u8], index: usize) -> Option<(u64, usize)> {
    let mut index = skip_ascii_whitespace(bytes, index);
    let start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if start == index {
        return None;
    }
    let value = std::str::from_utf8(&bytes[start..index])
        .ok()?
        .parse()
        .ok()?;
    Some((value, index))
}

pub(crate) fn parse_u32_token(bytes: &[u8], index: usize) -> Option<(u32, usize)> {
    let (value, index) = parse_u64_token(bytes, index)?;
    Some((u32::try_from(value).ok()?, index))
}

pub(crate) fn parse_u16_token(bytes: &[u8], index: usize) -> Option<(u16, usize)> {
    let (value, index) = parse_u64_token(bytes, index)?;
    Some((u16::try_from(value).ok()?, index))
}

pub(crate) fn parse_non_whitespace_byte(bytes: &[u8], index: usize) -> Option<(u8, usize)> {
    let index = skip_ascii_whitespace(bytes, index);
    Some((*bytes.get(index)?, index + 1))
}

pub(crate) fn parse_non_whitespace_token(bytes: &[u8], index: usize) -> Option<(&[u8], usize)> {
    let mut index = skip_ascii_whitespace(bytes, index);
    let start = index;
    while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if start == index {
        return None;
    }
    Some((&bytes[start..index], index))
}

#[cfg(test)]
mod xref_stream_canary_tests {
    use super::*;

    #[test]
    fn accepts_dynamic_xref_stream_widths_and_stride() {
        let appended = b"5 0 obj\n<</Type/XRef/Size 6/W[1 2 1]/Index[5 1]/Length 4>>\nstream\n\x01\x00\x00\x00\nendstream\nendobj\nstartxref\n0\n%%EOF\n";
        let entries = parse_incremental_xref_stream(appended, 0).unwrap();
        assert_eq!(entries.get(&(5, 0)), Some(&0));
    }

    #[test]
    fn rejects_xref_table_subsections_that_overflow_object_numbers() {
        let appended = b"xref\n4294967295 2\n0000000000 00000 n \n0000000000 00000 n \ntrailer\n<</Size 4294967295>>\n";
        let error = parse_incremental_xref_table(appended, 0).unwrap_err();
        assert!(error.to_string().contains("object-number limit"));
    }

    #[test]
    fn rejects_xref_stream_indexes_that_overflow_object_numbers() {
        let appended = b"4294967295 0 obj\n<</Type/XRef/Size 4294967295/W[1 1 1]/Index[4294967295 2]/Length 6>>\nstream\n\x01\x00\x00\x01\x00\x00\nendstream\nendobj\nstartxref\n0\n%%EOF\n";
        let error = parse_incremental_xref_stream(appended, 0).unwrap_err();
        assert!(error.to_string().contains("object-number limit"));
    }
}
