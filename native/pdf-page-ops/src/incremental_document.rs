use super::*;
#[path = "qpdf_metadata.rs"]
mod qpdf_metadata;
use evb_native_support::bounded_io::{
    clear_deserialization_error, record_deserialization_error, take_deserialization_error,
};
pub(crate) use qpdf_metadata::*;
use serde::de::{self, MapAccess, Visitor};
use serde_json::{value::RawValue, Value};
use std::{
    collections::BTreeSet,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_QPDF_STRUCTURE_BYTES: usize = 512 * 1024 * 1024;
pub(crate) const MAX_QPDF_RETAINED_STRUCTURE_BYTES: usize = 256 * 1024 * 1024;
/// A ceiling breach has to abort the parse rather than be collected and reported
/// at the end: the reason for the ceiling is that reading the rest of the object
/// table costs the memory being refused. serde carries only the rendered message
/// out of a visitor, so the code travels beside it.
fn resource_limit<E: de::Error>(message: impl Into<String>) -> E {
    record_deserialization_error(NativeErrorCode::TooLarge);
    E::custom(message.into())
}

pub(crate) const MAX_QPDF_OBJECT_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_QPDF_OBJECT_ELEMENTS: usize = 1_000_000;
pub(crate) const QPDF_ESTIMATED_BYTES_PER_VALUE: usize = 64;
const MAX_QPDF_NEW_OBJECT_HEADROOM: u32 = 1_000_000;
pub(crate) const MAX_QPDF_DIAGNOSTIC_BYTES: usize = 1024 * 1024;
const QPDF_STRUCTURE_TIMEOUT: Duration = Duration::from_secs(110);
const QPDF_STALE_FILE_AGE: Duration = Duration::from_secs(10 * 60);
const QPDF_TEMP_PREFIX: &str = "evb-qpdf-structure-";
static QPDF_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
// Only the Unix fake-qpdf fixtures use this namespace.
#[cfg(all(test, unix))]
static TEST_QPDF_SEQUENCE: AtomicU64 = AtomicU64::new(0);
// Keep this argument set compatible with the oldest qpdf shipped by the
// supported Linux packaging image. qpdf 10 rejects the newer
// --decode-level/--json-stream-data options; the JSON object section already
// omits stream bytes in the qpdf 10 and qpdf 12 formats we parse below.
const QPDF_STRUCTURE_ARGS: &[&str] = &["--suppress-recovery", "--json"];
// A read that appends nothing may use the cross-reference table qpdf
// reconstructs for a damaged file, which is the view the opening check accepts.
const QPDF_RECOVERED_STRUCTURE_ARGS: &[&str] = &["--json"];

/// Where a structural path load reads the base streams it left unloaded:
/// the source file, through qpdf. A document loaded from bytes holds every
/// base stream and has none.
#[derive(Clone, Copy)]
pub(crate) struct StructuralSource<'a> {
    pub(crate) input_path: &'a Path,
    pub(crate) qpdf_path: &'a Path,
}

impl<'a> StructuralSource<'a> {
    pub(crate) fn for_path(input_path: &'a Path, qpdf_path: Option<&'a Path>) -> Option<Self> {
        qpdf_path.map(|qpdf_path| Self {
            input_path,
            qpdf_path,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct IncrementalDocument {
    previous_len: u64,
    previous_last_byte: Option<u8>,
    pub(crate) previous_document: Document,
    pub(crate) unavailable_base_streams: HashSet<ObjectId>,
    /// Present only when qpdf's page-tree walk supplied the physical page order
    /// for a rotation-only path load. That path intentionally retains only the
    /// touched page dictionaries and their inherited-attribute ancestors.
    pub(crate) page_ids_by_number: Option<Vec<ObjectId>>,
    pub(crate) new_document: Document,
}

impl IncrementalDocument {
    pub(crate) fn from_document(
        document: Document,
        previous_len: u64,
        previous_last_byte: Option<u8>,
    ) -> Self {
        let new_document = Document::new_from_prev(&document);
        Self {
            previous_len,
            previous_last_byte,
            previous_document: document,
            unavailable_base_streams: HashSet::new(),
            page_ids_by_number: None,
            new_document,
        }
    }

    #[cfg(test)]
    pub(crate) fn load(path: &Path) -> Result<Self> {
        let document = Document::load(path)?;
        let metadata = fs::metadata(path)?;
        let previous_last_byte = read_last_byte(path, metadata.len())?;
        Ok(Self::from_document(
            document,
            metadata.len(),
            previous_last_byte,
        ))
    }

    pub(crate) fn get_prev_documents(&self) -> &Document {
        &self.previous_document
    }

    pub(crate) fn previous_len(&self) -> u64 {
        self.previous_len
    }

    pub(crate) fn previous_last_byte(&self) -> Option<u8> {
        self.previous_last_byte
    }

    /// Read-only consumers decode a transient stream instead of retaining it.
    pub(crate) fn read_base_stream_bounded(
        &self,
        structural: Option<StructuralSource<'_>>,
        object_id: ObjectId,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>> {
        let Ok(Object::Stream(stream)) = self.previous_document.get_object(object_id) else {
            return Ok(None);
        };
        if self.unavailable_base_streams.contains(&object_id) {
            if let Some(source) = structural {
                let mut transient = stream.clone();
                transient.set_content(read_qpdf_stream_bounded(
                    source.input_path,
                    source.qpdf_path,
                    object_id,
                    max_bytes,
                )?);
                return Ok(
                    if transient.filters().is_ok_and(|filters| !filters.is_empty()) {
                        decompressed_stream_with_limit(&transient, max_bytes).ok()
                    } else {
                        Some(transient.content)
                    },
                );
            }
        }
        Ok(plain_stream_with_limit(stream, max_bytes).ok())
    }

    pub(crate) fn materialize_base_stream(
        &mut self,
        path: &Path,
        qpdf_path: &Path,
        object_id: ObjectId,
        max_bytes: usize,
    ) -> Result<()> {
        if !self.unavailable_base_streams.contains(&object_id) {
            return Ok(());
        }
        let bytes = read_qpdf_stream_bounded(path, qpdf_path, object_id, max_bytes)?;
        self.set_base_stream_bytes(object_id, bytes)
    }

    pub(crate) fn opt_clone_object_to_new_document(&mut self, object_id: ObjectId) -> Result<()> {
        if self.new_document.has_object(object_id) {
            return Ok(());
        }
        if self.unavailable_base_streams.contains(&object_id) {
            return Err(format!(
                "Cannot rewrite unavailable base stream object {} {}",
                object_id.0, object_id.1
            )
            .into());
        }
        let old_object = self.previous_document.get_object(object_id)?;
        self.new_document.set_object(object_id, old_object.clone());
        Ok(())
    }
}

/// The structural reader stands each base stream in as its dictionary with no
/// bytes at position 0; an eager load always records the stream's real file
/// offset. Such a stand-in's bytes are unknown, unless its declared /Length
/// says there are none.
pub(crate) fn is_unread_base_stream(document: &impl PdfObjectSource, stream: &Stream) -> bool {
    stream.content.is_empty()
        && stream.start_position == Some(0)
        && stream
            .dict
            .get(b"Length")
            .ok()
            .and_then(|length| document.resolved(length).ok())
            .and_then(|length| length.as_i64().ok())
            != Some(0)
}

pub(crate) struct TempQpdfFiles {
    pub(crate) structure: PathBuf,
    diagnostics: PathBuf,
}

impl TempQpdfFiles {
    pub(crate) fn create() -> Result<Self> {
        remove_stale_qpdf_files(&std::env::temp_dir(), SystemTime::now());
        let nonce = qpdf_temp_nonce()?;
        let stem = format!("{QPDF_TEMP_PREFIX}{nonce}");
        Ok(Self {
            structure: std::env::temp_dir().join(format!("{stem}.json")),
            diagnostics: std::env::temp_dir().join(format!("{stem}.stderr")),
        })
    }
}

fn qpdf_temp_nonce() -> Result<String> {
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let sequence = QPDF_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(format!("{}-{timestamp}-{sequence}", std::process::id()))
}

#[cfg(all(test, unix))]
fn test_qpdf_temp_nonce() -> Result<String> {
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let sequence = TEST_QPDF_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(format!("{}-{timestamp}-{sequence}", std::process::id()))
}

fn remove_stale_qpdf_files(directory: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(QPDF_TEMP_PREFIX)
            || !(name.ends_with(".json") || name.ends_with(".stderr"))
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let is_stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= QPDF_STALE_FILE_AGE);
        if metadata.is_file() && is_stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

impl Drop for TempQpdfFiles {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.structure);
        let _ = fs::remove_file(&self.diagnostics);
    }
}

fn read_qpdf_structure(
    path: &Path,
    qpdf_path: &Path,
    arguments: &[&str],
) -> Result<(fs::Metadata, Document, HashSet<ObjectId>, bool)> {
    let initial_metadata = fs::metadata(path).map_err(io_domain_error)?;
    if initial_metadata.len() == 0 {
        return Err(domain_error(
            NativeErrorCode::CorruptXref,
            "PDF input is empty",
        ));
    }
    let temp = TempQpdfFiles::create()?;
    // qpdf uses exit code 3 for warnings that did not prevent JSON generation.
    // Keep that output on the normal bounded parse and structural-validation
    // path. Any malformed or incomplete JSON still fails below; only a clean
    // exit or qpdf's warning-only exit may reach the structural loader.
    let warned = run_qpdf_bounded(path, qpdf_path, arguments, &temp, MAX_QPDF_STRUCTURE_BYTES)?;
    let (document, unavailable_base_streams) = parse_qpdf_structure(&temp.structure, Some(path))?;
    Ok((initial_metadata, document, unavailable_base_streams, warned))
}

/// qpdf's structural view of a PDF for a caller that only reads it. Unlike
/// the incremental loader it accepts a reconstructed cross-reference table and
/// never asks whether the file could take an appended revision.
pub(crate) fn load_qpdf_structural_document(path: &Path, qpdf_path: &Path) -> Result<Document> {
    let (initial_metadata, document, _, _) =
        read_qpdf_structure(path, qpdf_path, QPDF_RECOVERED_STRUCTURE_ARGS)?;
    ensure_input_unchanged(path, &initial_metadata)?;
    Ok(document)
}

fn ensure_input_unchanged(path: &Path, initial_metadata: &fs::Metadata) -> Result<()> {
    let current_metadata = fs::metadata(path).map_err(io_domain_error)?;
    if current_metadata.len() != initial_metadata.len()
        || current_metadata.modified().ok() != initial_metadata.modified().ok()
    {
        return Err("PDF input changed while qpdf was reading its structure".into());
    }
    Ok(())
}

/// qpdf's structural view as the base of an incremental append, and whether
/// qpdf read it only with warnings: it then reads a damaged object as null.
pub(crate) fn load_qpdf_structural_incremental_pdf(
    path: &Path,
    qpdf_path: &Path,
) -> Result<(IncrementalDocument, bool)> {
    let (initial_metadata, mut document, unavailable_base_streams, warned) =
        read_qpdf_structure(path, qpdf_path, QPDF_STRUCTURE_ARGS)?;
    let previous_len = initial_metadata.len();
    let (previous_xref_start, xref_type) = read_terminal_xref(path, previous_len)?;
    document.xref_start = usize::try_from(previous_xref_start)
        .map_err(|_| "Previous PDF xref offset exceeds this platform's address space")?;
    document.reference_table = lopdf::xref::Xref::new(document.max_id.saturating_add(1), xref_type);
    ensure_input_unchanged(path, &initial_metadata)?;
    let previous_last_byte = read_last_byte(path, previous_len)?;
    let mut incremental =
        IncrementalDocument::from_document(document, previous_len, previous_last_byte);
    incremental.unavailable_base_streams = unavailable_base_streams;
    Ok((incremental, warned))
}

/// What a page-local edit touches: page indexes it rewrites, the pages whose
/// annotations it reads, and annotations it addresses by object, whose pages
/// are found through their `/P`.
#[derive(Default)]
pub(crate) struct PageLocalEdit {
    pub(crate) pages: BTreeSet<u32>,
    pub(crate) annotation_pages: BTreeSet<u32>,
    pub(crate) annotations: BTreeSet<ObjectId>,
}

/// Load only what a page-local edit reads (see `page_local_dependencies`)
/// rather than every object of a large PDF. The bundled library reads each
/// object on demand; without it, qpdf's page-tree walk supplies the pages and
/// each round of the walk is one JSON query. None means an annotation the edit
/// addresses is not listed on the page its `/P` names, so only a load of the
/// whole document can find it.
pub(crate) fn load_qpdf_page_local_incremental_pdf(
    path: &Path,
    qpdf_path: &Path,
    edit: &PageLocalEdit,
) -> Result<Option<IncrementalDocument>> {
    let initial_metadata = fs::metadata(path).map_err(io_domain_error)?;
    let previous_len = initial_metadata.len();
    if previous_len == 0 {
        return Err(domain_error(
            NativeErrorCode::CorruptXref,
            "PDF input is empty",
        ));
    }

    let (mut document, page_ids_by_number) =
        match load_qpdf_page_local_objects(path, qpdf_path, edit)? {
            Some(loaded) => loaded,
            None => {
                let temp = TempQpdfFiles::create()?;
                run_qpdf_bounded(
                    path,
                    qpdf_path,
                    &["--suppress-recovery", "--show-pages"],
                    &temp,
                    MAX_QPDF_PAGE_LIST_BYTES,
                )?;
                let page_ids_by_number = parse_qpdf_page_ids(&read_file_bounded(
                    &temp.structure,
                    MAX_QPDF_PAGE_LIST_BYTES,
                    "qpdf page tree",
                )?)?;
                if page_ids_by_number.len() > crate::load_policy::MAX_PATH_INPUT_PDF_PAGES {
                    return Err(domain_error(
                        NativeErrorCode::TooLarge,
                        "PDF page count exceeds the native path-load limit",
                    ));
                }
                let first = select_page_ids(&page_ids_by_number, &edit.pages)?
                    .into_iter()
                    .chain(edit.annotations.iter().copied());
                let mut document = load_qpdf_selected_objects(path, qpdf_path, &temp, first)?;
                complete_page_local_objects(
                    &mut document,
                    &page_ids_by_number,
                    edit,
                    |document, batch| {
                        let additional = load_qpdf_selected_objects(
                            path,
                            qpdf_path,
                            &temp,
                            batch.iter().copied(),
                        )?;
                        merge_qpdf_selected_objects(document, additional)
                    },
                )?;
                (document, page_ids_by_number)
            }
        };
    if !page_local_annotations_located(&document, &page_ids_by_number, edit)? {
        return Ok(None);
    }

    let (previous_xref_start, xref_type) = read_terminal_xref(path, previous_len)?;
    document.xref_start = usize::try_from(previous_xref_start)
        .map_err(|_| "Previous PDF xref offset exceeds this platform's address space")?;
    document.reference_table = lopdf::xref::Xref::new(document.max_id.saturating_add(1), xref_type);
    let current_metadata = fs::metadata(path).map_err(io_domain_error)?;
    if current_metadata.len() != previous_len
        || current_metadata.modified().ok() != initial_metadata.modified().ok()
    {
        return Err("PDF input changed while qpdf was reading its page tree".into());
    }
    let previous_last_byte = read_last_byte(path, previous_len)?;
    // Both readers stand each stream in as its dictionary without bytes.
    let unavailable_base_streams = document
        .objects
        .iter()
        .filter_map(|(id, object)| matches!(object, Object::Stream(_)).then_some(*id))
        .collect();
    let mut incremental =
        IncrementalDocument::from_document(document, previous_len, previous_last_byte);
    incremental.unavailable_base_streams = unavailable_base_streams;
    incremental.page_ids_by_number = Some(page_ids_by_number);
    Ok(Some(incremental))
}

fn select_page_ids(
    page_ids_by_number: &[ObjectId],
    page_indexes: &BTreeSet<u32>,
) -> Result<BTreeSet<ObjectId>> {
    page_indexes
        .iter()
        .map(|index| {
            page_ids_by_number
                .get(*index as usize)
                .copied()
                .ok_or_else(|| {
                    domain_error(
                        NativeErrorCode::InvalidRequest,
                        format!("Page index {index} is outside the PDF page tree"),
                    )
                })
        })
        .collect()
}

/// Fetches, in rounds, every object `page_local_dependencies` names until
/// the loaded part of `document` names nothing new. qpdf leaves out an object
/// that does not exist, so each object is requested at most once.
fn complete_page_local_objects(
    document: &mut Document,
    page_ids_by_number: &[ObjectId],
    edit: &PageLocalEdit,
    mut fetch: impl FnMut(&mut Document, &BTreeSet<ObjectId>) -> Result<()>,
) -> Result<()> {
    let pages = select_page_ids(page_ids_by_number, &edit.pages)?;
    let annotation_pages = select_page_ids(page_ids_by_number, &edit.annotation_pages)?;
    let known_pages = page_ids_by_number.iter().copied().collect::<HashSet<_>>();
    let mut requested = document.objects.keys().copied().collect::<BTreeSet<_>>();
    // One ceiling covers every round and query batch: each retains its objects.
    let mut retained = retained_cost(&Object::Dictionary(document.trailer.clone()))?;
    for object in document.objects.values() {
        retained = charge_retained(retained, object)?;
    }
    loop {
        let missing = page_local_dependencies(
            document,
            &pages,
            &annotation_pages,
            &edit.annotations,
            &known_pages,
        )?
        .difference(&requested)
        .copied()
        .collect::<BTreeSet<_>>();
        if missing.is_empty() {
            break;
        }
        if requested.len().saturating_add(missing.len()) > MAX_QPDF_OBJECT_ELEMENTS {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Page-local PDF objects exceed their object ceiling",
            ));
        }
        fetch(document, &missing)?;
        for id in &missing {
            if let Ok(object) = document.get_object(*id) {
                retained = charge_retained(retained, object)?;
            }
        }
        requested.extend(missing);
    }
    for page_id in &pages {
        if document.dictionary(*page_id)?.get(b"Type")?.as_name()? != b"Page" {
            return Err("qpdf page-tree walk returned a non-page object".into());
        }
    }
    Ok(())
}

fn charge_retained(retained: usize, object: &Object) -> Result<usize> {
    retained
        .checked_add(retained_cost(object)?)
        .filter(|retained| *retained <= MAX_QPDF_RETAINED_STRUCTURE_BYTES)
        .ok_or_else(|| {
            domain_error(
                NativeErrorCode::TooLarge,
                "Page-local PDF objects exceed their retained memory ceiling",
            )
        })
}

/// The page an addressed annotation names through its own `/P`, or a popup
/// through its parent's.
fn addressed_annotation_page(
    document: &Document,
    annotation_id: ObjectId,
    known_pages: &HashSet<ObjectId>,
) -> Option<ObjectId> {
    let annotation = document.get_dictionary(annotation_id).ok()?;
    let page = |dictionary: &Dictionary| {
        dictionary
            .get(b"P")
            .and_then(Object::as_reference)
            .ok()
            .filter(|page| known_pages.contains(page))
    };
    page(annotation).or_else(|| {
        let parent = annotation
            .get(b"Parent")
            .and_then(Object::as_reference)
            .ok()?;
        page(document.get_dictionary(parent).ok()?)
    })
}

/// Whether every addressed annotation, or the parent of an addressed popup,
/// is listed on the page its `/P` names, where the edit's writers look.
fn page_local_annotations_located(
    document: &Document,
    page_ids_by_number: &[ObjectId],
    edit: &PageLocalEdit,
) -> Result<bool> {
    let known_pages = page_ids_by_number.iter().copied().collect::<HashSet<_>>();
    for annotation_id in &edit.annotations {
        let Some(page_id) = addressed_annotation_page(document, *annotation_id, &known_pages)
        else {
            return Ok(false);
        };
        let listed = get_page_annots(document, page_id)?;
        let parent = document
            .get_dictionary(*annotation_id)
            .and_then(|annotation| annotation.get(b"Parent"))
            .and_then(Object::as_reference)
            .ok();
        if !listed.iter().any(|object| {
            object
                .as_reference()
                .is_ok_and(|id| id == *annotation_id || Some(id) == parent)
        }) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The base objects a page-local edit reads, as far as the loaded part of
/// `document` names them: each page and its `/Pages` ancestors with their
/// inheritable boxes and rotation; for `annotation_pages`, and the pages that
/// addressed `annotations` name, the `/Annots` entries with everything they
/// reference. A stream adds only its `/Length`, and a page-tree node or
/// catalog reached from an annotation is read but not followed, so the walk
/// stays on the edited pages.
fn page_local_dependencies(
    document: &Document,
    pages: &BTreeSet<ObjectId>,
    annotation_pages: &BTreeSet<ObjectId>,
    annotations: &BTreeSet<ObjectId>,
    known_pages: &HashSet<ObjectId>,
) -> Result<BTreeSet<ObjectId>> {
    let mut needed = BTreeSet::new();
    let mut values = Vec::new();
    let mut pages = pages.clone();
    let mut annotation_pages = annotation_pages.clone();
    for annotation_id in annotations {
        if let Some(page_id) = addressed_annotation_page(document, *annotation_id, known_pages) {
            pages.insert(page_id);
            annotation_pages.insert(page_id);
        }
    }
    for page_id in &pages {
        let mut node_id = *page_id;
        for depth in 0..=MAX_PDF_STRUCTURAL_NESTING + 1 {
            if depth > MAX_PDF_STRUCTURAL_NESTING {
                return Err("PDF page-tree ancestry exceeds its structural depth limit".into());
            }
            needed.insert(node_id);
            let Ok(node) = document.get_dictionary(node_id) else {
                break;
            };
            if depth > 0 && node.get(b"Type")?.as_name()? != b"Pages" {
                return Err("PDF page /Parent does not reference a /Pages node".into());
            }
            for key in [b"MediaBox".as_slice(), b"CropBox", b"Rotate"] {
                values.extend(node.get(key).ok());
            }
            if depth == 0 && annotation_pages.contains(page_id) {
                values.extend(node.get(b"Annots").ok());
            }
            let Ok(parent) = node.get(b"Parent") else {
                break;
            };
            node_id = parent
                .as_reference()
                .map_err(|_| "PDF page /Parent must be an indirect reference")?;
        }
    }
    let addressed = annotations
        .iter()
        .map(|id| Object::Reference(*id))
        .collect::<Vec<_>>();
    values.extend(&addressed);
    while let Some(value) = values.pop() {
        match value {
            Object::Reference(id) => {
                if !needed.insert(*id) {
                    continue;
                }
                let Ok(object) = document.get_object(*id) else {
                    continue;
                };
                let page_tree_or_catalog = object.as_dict().is_ok_and(|dictionary| {
                    dictionary
                        .get(b"Type")
                        .and_then(Object::as_name)
                        .is_ok_and(|kind| matches!(kind, b"Page" | b"Pages" | b"Catalog"))
                });
                if !page_tree_or_catalog {
                    values.push(object);
                }
            }
            Object::Array(items) => values.extend(items),
            Object::Dictionary(dictionary) => {
                values.extend(dictionary.iter().map(|(_, value)| value))
            }
            Object::Stream(stream) => values.extend(stream.dict.get(b"Length").ok()),
            _ => {}
        }
    }
    Ok(needed)
}

const MAX_QPDF_PAGE_LIST_BYTES: usize = 64 * 1024 * 1024;
const MAX_QPDF_OBJECTS_PER_QUERY: usize = 2_048;
const MAX_QPDF_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(5);

pub(crate) fn run_qpdf_bounded(
    path: &Path,
    qpdf_path: &Path,
    arguments: &[&str],
    temp: &TempQpdfFiles,
    max_output_bytes: usize,
) -> Result<bool> {
    for temp_path in [&temp.structure, &temp.diagnostics] {
        match fs::remove_file(temp_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_domain_error(error)),
        }
    }
    let structure_output = create_private_temp_file(&temp.structure)?;
    let diagnostic_output = create_private_temp_file(&temp.diagnostics)?;
    let mut child = Command::new(qpdf_path)
        .args(arguments)
        .arg("--")
        .arg(path)
        .stdout(Stdio::from(structure_output))
        .stderr(Stdio::from(diagnostic_output))
        .spawn()
        .map_err(io_domain_error)?;
    let started = Instant::now();
    let status = loop {
        let status = child.try_wait().map_err(io_domain_error)?;
        if status.is_none() && started.elapsed() > QPDF_STRUCTURE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "qpdf structural parsing exceeded the 110-second resource limit",
            ));
        }
        if fs::metadata(&temp.structure)
            .map(|metadata| metadata.len() > max_output_bytes as u64)
            .unwrap_or(false)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!(
                    "qpdf structural output exceeds the {max_output_bytes}-byte resource limit"
                ),
            ));
        }
        if fs::metadata(&temp.diagnostics)
            .map(|metadata| metadata.len() > MAX_QPDF_DIAGNOSTIC_BYTES as u64)
            .unwrap_or(false)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "qpdf diagnostics exceeded the 1048576-byte resource limit",
            ));
        }
        if let Some(status) = status {
            break status;
        }
        thread::sleep(MAX_QPDF_COMMAND_POLL_INTERVAL);
    };
    if !status.success() && status.code() != Some(3) {
        let diagnostics = read_file_bounded(
            &temp.diagnostics,
            MAX_QPDF_DIAGNOSTIC_BYTES,
            "qpdf diagnostics",
        )
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .unwrap_or_else(|error| error.to_string());
        return Err(domain_error(
            NativeErrorCode::CorruptXref,
            if diagnostics.is_empty() {
                format!("qpdf structural parsing failed with status {status}")
            } else {
                format!("qpdf structural parsing failed: {diagnostics}")
            },
        ));
    }
    Ok(status.code() == Some(3))
}

fn parse_qpdf_page_ids(output: &[u8]) -> Result<Vec<ObjectId>> {
    let output = std::str::from_utf8(output)?;
    let mut page_ids = Vec::new();
    let mut seen = HashSet::new();
    for line in output.lines() {
        let Some(page) = line.strip_prefix("page ") else {
            continue;
        };
        let (number, reference) = page
            .split_once(": ")
            .ok_or("qpdf page-tree output contains a malformed page line")?;
        let number = number.parse::<usize>()?;
        if number != page_ids.len() + 1 {
            return Err("qpdf page-tree output is not in sequential page order".into());
        }
        let mut fields = reference.split_ascii_whitespace();
        let object_number = fields
            .next()
            .ok_or("qpdf page-tree output is missing an object number")?
            .parse::<u32>()?;
        let generation_number = fields
            .next()
            .ok_or("qpdf page-tree output is missing a generation number")?
            .parse::<u16>()?;
        if fields.next() != Some("R") || fields.next().is_some() || object_number == 0 {
            return Err("qpdf page-tree output contains an invalid page reference".into());
        }
        let page_id = (object_number, generation_number);
        if !seen.insert(page_id) {
            return Err("qpdf page-tree output repeats a page object".into());
        }
        page_ids.push(page_id);
    }
    if page_ids.is_empty() {
        return Err("qpdf page-tree output contains no pages".into());
    }
    Ok(page_ids)
}

fn load_qpdf_selected_objects(
    path: &Path,
    qpdf_path: &Path,
    temp: &TempQpdfFiles,
    object_ids: impl IntoIterator<Item = ObjectId>,
) -> Result<Document> {
    let mut unique_ids = BTreeSet::new();
    unique_ids.extend(object_ids);
    if unique_ids.is_empty() {
        return Err("qpdf object query has no selected objects".into());
    }
    let requested = unique_ids.into_iter().collect::<Vec<_>>();
    let mut document = None;
    for chunk in requested.chunks(MAX_QPDF_OBJECTS_PER_QUERY) {
        let additional = load_qpdf_selected_objects_batch(path, qpdf_path, temp, chunk)?;
        if let Some(document) = document.as_mut() {
            merge_qpdf_selected_objects(document, additional)?;
        } else {
            document = Some(additional);
        }
    }
    document.ok_or_else(|| "qpdf object query produced no structural data".into())
}

fn load_qpdf_selected_objects_batch(
    path: &Path,
    qpdf_path: &Path,
    temp: &TempQpdfFiles,
    object_ids: &[ObjectId],
) -> Result<Document> {
    let mut arguments = vec![
        "--suppress-recovery".to_string(),
        "--json".to_string(),
        "--json-key=qpdf".to_string(),
        "--json-object=trailer".to_string(),
    ];
    for (object_number, generation_number) in object_ids {
        arguments.push(format!("--json-object={object_number},{generation_number}"));
    }
    run_qpdf_bounded(
        path,
        qpdf_path,
        &arguments.iter().map(String::as_str).collect::<Vec<_>>(),
        temp,
        MAX_QPDF_STRUCTURE_BYTES,
    )?;
    parse_qpdf_structure(&temp.structure, Some(path)).map(|(document, _)| document)
}

fn merge_qpdf_selected_objects(document: &mut Document, additional: Document) -> Result<()> {
    if document.version != additional.version
        || document.max_id != additional.max_id
        || document.trailer != additional.trailer
    {
        return Err("PDF structure changed between qpdf page-tree queries".into());
    }
    for (object_id, object) in additional.objects {
        if document.objects.insert(object_id, object).is_some() {
            return Err(format!(
                "qpdf page-tree query returned duplicate object {} {}",
                object_id.0, object_id.1
            )
            .into());
        }
    }
    Ok(())
}

/// Reads one encoded PDF stream with bounded memory and a subprocess deadline.
/// Callers select a small number of resource references after structural parsing.
pub(crate) fn read_qpdf_stream_bounded(
    path: &Path,
    qpdf_path: &Path,
    object_id: ObjectId,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let temp = TempQpdfFiles::create()?;
    let diagnostics = create_private_temp_file(&temp.diagnostics)?;
    let mut child = Command::new(qpdf_path)
        .arg("--suppress-recovery")
        .arg(format!("--show-object={},{}", object_id.0, object_id.1))
        .arg("--raw-stream-data")
        .arg("--")
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::from(diagnostics))
        .spawn()
        .map_err(io_domain_error)?;
    let stdout = child
        .stdout
        .take()
        .ok_or("qpdf stream reader has no stdout")?;
    let limit = u64::try_from(max_bytes)?
        .checked_add(1)
        .ok_or("Invalid stream byte limit")?;
    let (send, receive) = std::sync::mpsc::channel();
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(limit).read_to_end(&mut bytes).map(|_| bytes);
        let _ = send.send(result);
    });
    let started = Instant::now();
    let mut output = None;
    let result = loop {
        if output.is_none() {
            match receive.try_recv() {
                Ok(Ok(bytes)) => {
                    if bytes.len() > max_bytes {
                        break Err("qpdf resource stream exceeds its byte limit".into());
                    }
                    output = Some(bytes);
                }
                Ok(Err(error)) => break Err(io_domain_error(error)),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    break Err("qpdf resource reader stopped".into());
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() && status.code() != Some(3) {
                    break Err("qpdf resource stream read failed".into());
                }
                if let Some(bytes) = output.take() {
                    break Ok(bytes);
                }
            }
            Ok(None) => {}
            Err(error) => break Err(io_domain_error(error)),
        }
        if started.elapsed() > QPDF_STRUCTURE_TIMEOUT
            || fs::metadata(&temp.diagnostics)
                .is_ok_and(|metadata| metadata.len() > MAX_QPDF_DIAGNOSTIC_BYTES as u64)
        {
            break Err("qpdf resource stream read exceeded its resource limit".into());
        }
        thread::sleep(Duration::from_millis(10));
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = reader.join();
    result
}

fn create_private_temp_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io_domain_error)
}

enum QpdfRoot {
    V2(QpdfRootV2),
    V1(QpdfRootV1),
}

#[derive(Deserialize)]
struct QpdfRootV2 {
    qpdf: (QpdfMetadata, QpdfObjects),
}

#[derive(Deserialize)]
struct QpdfRootV1 {
    version: u64,
    objects: QpdfLegacyObjects,
}

impl<'de> Deserialize<'de> for QpdfRoot {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct QpdfRootVisitor;

        impl<'de> Visitor<'de> for QpdfRootVisitor {
            type Value = QpdfRoot;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("qpdf JSON version 1 or 2")
            }

            fn visit_map<M>(self, mut map: M) -> std::result::Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut qpdf = None;
                let mut version = None;
                let mut objects = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "qpdf" => {
                            if qpdf.is_some() {
                                return Err(de::Error::duplicate_field("qpdf"));
                            }
                            qpdf = Some(map.next_value::<(QpdfMetadata, QpdfObjects)>()?);
                        }
                        "version" => {
                            if version.is_some() {
                                return Err(de::Error::duplicate_field("version"));
                            }
                            version = Some(map.next_value::<u64>()?);
                        }
                        "objects" => {
                            if objects.is_some() {
                                return Err(de::Error::duplicate_field("objects"));
                            }
                            objects = Some(map.next_value::<QpdfLegacyObjects>()?);
                        }
                        _ => {
                            let _: serde::de::IgnoredAny = map.next_value()?;
                        }
                    }
                }
                if let Some(qpdf) = qpdf {
                    return Ok(QpdfRoot::V2(QpdfRootV2 { qpdf }));
                }
                if let (Some(version), Some(objects)) = (version, objects) {
                    return Ok(QpdfRoot::V1(QpdfRootV1 { version, objects }));
                }
                Err(de::Error::custom(
                    "qpdf JSON is missing its versioned object section",
                ))
            }
        }

        deserializer.deserialize_map(QpdfRootVisitor)
    }
}

#[derive(Deserialize)]
struct QpdfMetadata {
    jsonversion: u64,
    pdfversion: String,
    maxobjectid: u64,
}

struct QpdfObjects {
    document: Document,
    unavailable_base_streams: HashSet<ObjectId>,
}

struct QpdfLegacyObjects(QpdfObjects);

impl<'de> Deserialize<'de> for QpdfObjects {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserialize_qpdf_objects(deserializer, false)
    }
}

impl<'de> Deserialize<'de> for QpdfLegacyObjects {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserialize_qpdf_objects(deserializer, true).map(Self)
    }
}

fn deserialize_qpdf_objects<'de, D>(
    deserializer: D,
    allow_legacy_encoding: bool,
) -> std::result::Result<QpdfObjects, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct QpdfObjectsVisitor {
        allow_legacy_encoding: bool,
    }

    impl<'de> Visitor<'de> for QpdfObjectsVisitor {
        type Value = QpdfObjects;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a qpdf JSON object section")
        }

        fn visit_map<M>(self, mut map: M) -> std::result::Result<Self::Value, M::Error>
        where
            M: MapAccess<'de>,
        {
            let mut document = Document::with_version("1.7");
            let mut unavailable_base_streams = HashSet::new();
            let mut trailer_seen = false;
            let mut retained_structure_cost = 0_usize;
            while let Some((key, raw_envelope)) = map.next_entry::<String, Box<RawValue>>()? {
                let Some(object_bytes) = key.len().checked_add(raw_envelope.get().len()) else {
                    return Err(resource_limit("qpdf object size overflow"));
                };
                if object_bytes > MAX_QPDF_OBJECT_BYTES {
                    return Err(resource_limit(format!(
                        "qpdf object exceeds the {MAX_QPDF_OBJECT_BYTES}-byte resource limit"
                    )));
                }
                let envelope: Value =
                    serde_json::from_str(raw_envelope.get()).map_err(de::Error::custom)?;
                let Some(envelope_cost) =
                    qpdf_value_retained_cost(&envelope, MAX_QPDF_OBJECT_ELEMENTS)
                else {
                    return Err(resource_limit(format!(
                        "qpdf object exceeds the {MAX_QPDF_OBJECT_ELEMENTS}-element resource limit"
                    )));
                };
                let Some(next_cost) = retained_structure_cost
                    .checked_add(key.len())
                    .and_then(|cost| cost.checked_add(envelope_cost))
                else {
                    return Err(resource_limit("qpdf structural size overflow"));
                };
                retained_structure_cost = next_cost;
                if retained_structure_cost > MAX_QPDF_RETAINED_STRUCTURE_BYTES {
                    return Err(resource_limit(format!(
                        "retained qpdf structure exceeds the {MAX_QPDF_RETAINED_STRUCTURE_BYTES}-byte estimated memory limit"
                    )));
                }
                if key == "trailer" {
                    if trailer_seen {
                        return Err(de::Error::custom("qpdf JSON contains two trailers"));
                    }
                    let value = if self.allow_legacy_encoding {
                        &envelope
                    } else {
                        envelope
                            .get("value")
                            .ok_or_else(|| de::Error::custom("qpdf trailer is missing its value"))?
                    };
                    document.trailer = qpdf_dictionary_with_mode(value, self.allow_legacy_encoding)
                        .map_err(de::Error::custom)?;
                    trailer_seen = true;
                    continue;
                }
                if document.objects.len() == 1_000_000 {
                    return Err(resource_limit(
                        "qpdf structural output exceeds the 1000000-object resource limit",
                    ));
                }
                let object_id = parse_qpdf_object_key(&key, self.allow_legacy_encoding)
                    .map_err(de::Error::custom)?;
                if document.objects.contains_key(&object_id) {
                    return Err(de::Error::custom(format!(
                        "qpdf JSON repeats object {} {}",
                        object_id.0, object_id.1
                    )));
                }
                let object = if let Some(value) = envelope.get("value") {
                    qpdf_object_with_mode(value, self.allow_legacy_encoding)
                        .map_err(de::Error::custom)?
                } else if let Some(stream) = envelope.get("stream") {
                    let (stream, is_unread) =
                        qpdf_stream_from_json(stream, object_id).map_err(de::Error::custom)?;
                    if is_unread {
                        unavailable_base_streams.insert(object_id);
                    }
                    Object::Stream(stream)
                } else if self.allow_legacy_encoding {
                    let is_stream = envelope
                        .as_object()
                        .is_some_and(|values| values.contains_key("/Length"));
                    if is_stream {
                        unavailable_base_streams.insert(object_id);
                        Object::Stream(Stream::with_position(
                            qpdf_dictionary_with_mode(&envelope, true)
                                .map_err(de::Error::custom)?,
                            0,
                        ))
                    } else {
                        qpdf_object_with_mode(&envelope, true).map_err(de::Error::custom)?
                    }
                } else {
                    return Err(de::Error::custom(format!(
                        "qpdf object {key} has no value or stream"
                    )));
                };
                document.objects.insert(object_id, object);
            }
            if !trailer_seen {
                return Err(de::Error::custom("qpdf JSON is missing its trailer"));
            }
            Ok(QpdfObjects {
                document,
                unavailable_base_streams,
            })
        }
    }

    deserializer.deserialize_map(QpdfObjectsVisitor {
        allow_legacy_encoding,
    })
}

fn qpdf_value_retained_cost(value: &Value, element_limit: usize) -> Option<usize> {
    let mut pending = vec![value];
    let mut count = 0_usize;
    let mut estimated_bytes = 0_usize;
    while let Some(value) = pending.pop() {
        count = count.checked_add(1)?;
        if count > element_limit {
            return None;
        }
        estimated_bytes = estimated_bytes.checked_add(QPDF_ESTIMATED_BYTES_PER_VALUE)?;
        match value {
            Value::Array(values) => pending.extend(values),
            Value::Object(values) => {
                for (key, value) in values {
                    estimated_bytes = estimated_bytes.checked_add(key.len())?;
                    pending.push(value);
                }
            }
            Value::String(value) => {
                estimated_bytes = estimated_bytes.checked_add(value.len())?;
            }
            _ => {}
        }
    }
    Some(estimated_bytes)
}

pub(crate) fn parse_qpdf_structure(
    path: &Path,
    source_pdf_path: Option<&Path>,
) -> Result<(Document, HashSet<ObjectId>)> {
    let file = File::open(path).map_err(io_domain_error)?;
    if file.metadata().map_err(io_domain_error)?.len() > MAX_QPDF_STRUCTURE_BYTES as u64 {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!(
                "qpdf structural output exceeds the {MAX_QPDF_STRUCTURE_BYTES}-byte resource limit"
            ),
        ));
    }
    let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
    clear_deserialization_error();
    let root = QpdfRoot::deserialize(&mut deserializer)
        .and_then(|root| deserializer.end().map(|_| root))
        .map_err(|error| match take_deserialization_error() {
            Some(code) => domain_error(code, error.to_string()),
            None => Box::new(error) as Box<dyn Error>,
        })?;
    let (mut document, unavailable_base_streams, max_id, pdf_version) = match root {
        QpdfRoot::V2(QpdfRootV2 {
            qpdf: (metadata, objects),
        }) => {
            if metadata.jsonversion != 2 {
                return Err("qpdf JSON version is not 2".into());
            }
            let max_id = checked_qpdf_max_id(metadata.maxobjectid)?;
            let QpdfObjects {
                document,
                unavailable_base_streams,
            } = objects;
            (
                document,
                unavailable_base_streams,
                max_id,
                metadata.pdfversion,
            )
        }
        QpdfRoot::V1(QpdfRootV1 { version, objects }) => {
            if version != 1 {
                return Err("qpdf JSON version is not 1 or 2".into());
            }
            let QpdfObjects {
                document,
                unavailable_base_streams,
            } = objects.0;
            let parsed_max_id = max_qpdf_object_id(&document)?;
            let trailer_size = document
                .trailer
                .get(b"Size")
                .map_err(|_| "qpdf legacy JSON trailer is missing /Size")?
                .as_i64()
                .map_err(|_| "qpdf legacy JSON trailer /Size is not an integer")?;
            if trailer_size <= 0 {
                return Err("qpdf legacy JSON trailer /Size must be positive".into());
            }
            let trailer_max_id = u64::try_from(trailer_size - 1)
                .map_err(|_| "qpdf legacy JSON trailer /Size is invalid")?;
            if trailer_max_id < u64::from(parsed_max_id) {
                return Err(
                    "qpdf legacy JSON trailer /Size is lower than a returned object number".into(),
                );
            }
            let max_id = checked_qpdf_max_id(trailer_max_id)?;
            let source_pdf_path =
                source_pdf_path.ok_or("qpdf legacy JSON requires the source PDF path")?;
            let pdf_version = read_pdf_version(source_pdf_path)?;
            (document, unavailable_base_streams, max_id, pdf_version)
        }
    };
    if document
        .objects
        .keys()
        .any(|object_id| object_id.0 > max_id)
    {
        return Err("qpdf maxobjectid is lower than a returned object number".into());
    }
    document.version = pdf_version;
    document.max_id = max_id;
    if document.trailer.get(b"Root").is_err() {
        return Err("qpdf trailer is missing /Root".into());
    }
    Ok((document, unavailable_base_streams))
}

fn max_qpdf_object_id(document: &Document) -> Result<u32> {
    let max_id = document
        .objects
        .keys()
        .map(|object_id| u64::from(object_id.0))
        .max()
        .unwrap_or(0);
    checked_qpdf_max_id(max_id)
}

fn read_pdf_version(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(io_domain_error)?;
    let mut header = [0_u8; 1024];
    let bytes_read = file.read(&mut header).map_err(io_domain_error)?;
    let header = &header[..bytes_read];
    let marker = b"%PDF-";
    let start = header
        .windows(marker.len())
        .position(|window| window == marker)
        .ok_or("PDF header is missing its version marker")?;
    let version = header
        .get(start + marker.len()..start + marker.len() + 3)
        .ok_or("PDF header version is incomplete")?;
    if !version[0].is_ascii_digit() || version[1] != b'.' || !version[2].is_ascii_digit() {
        return Err("PDF header version is invalid".into());
    }
    Ok(format!("{}.{}", version[0] - b'0', version[2] - b'0'))
}

fn checked_qpdf_max_id(value: u64) -> Result<u32> {
    let max_id = u32::try_from(value).map_err(|_| "qpdf maxobjectid exceeds the PDF limit")?;
    if max_id > u32::MAX - MAX_QPDF_NEW_OBJECT_HEADROOM {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!(
                "qpdf maxobjectid leaves fewer than {MAX_QPDF_NEW_OBJECT_HEADROOM} IDs for native mutations"
            ),
        ));
    }
    Ok(max_id)
}

fn parse_qpdf_object_key(key: &str, allow_legacy_encoding: bool) -> Result<ObjectId> {
    let reference = match key.strip_prefix("obj:") {
        Some(reference) => reference,
        None if allow_legacy_encoding => key,
        None => return Err("qpdf object key is missing obj prefix".into()),
    };
    parse_qpdf_reference(reference)
        .ok_or_else(|| format!("qpdf object key is invalid: {key}").into())
}

fn parse_qpdf_reference(value: &str) -> Option<ObjectId> {
    let mut parts = value.split_ascii_whitespace();
    let object_number = parts.next()?.parse().ok()?;
    let generation = parts.next()?.parse().ok()?;
    (parts.next() == Some("R") && parts.next().is_none()).then_some((object_number, generation))
}

pub(crate) fn qpdf_dictionary(value: &Value) -> Result<Dictionary> {
    qpdf_dictionary_with_mode(value, false)
}

#[derive(Clone, Copy)]
enum QpdfNameMode {
    Canonical,
    Escaped,
}

fn qpdf_dictionary_with_mode(value: &Value, allow_legacy_encoding: bool) -> Result<Dictionary> {
    let values = value
        .as_object()
        .ok_or("qpdf dictionary value is not an object")?;
    let mut dictionary = Dictionary::new();
    for (key, value) in values {
        let decoded_key = decode_qpdf_name(key, qpdf_name_mode(allow_legacy_encoding))?;
        dictionary.set(
            decoded_key,
            qpdf_object_with_mode(value, allow_legacy_encoding)?,
        );
    }
    Ok(dictionary)
}

fn qpdf_object_with_mode(value: &Value, allow_legacy_encoding: bool) -> Result<Object> {
    Ok(match value {
        Value::Null => Object::Null,
        Value::Bool(value) => Object::Boolean(*value),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                Object::Integer(integer)
            } else if let Some(integer) = value.as_u64() {
                Object::Integer(i64::try_from(integer).map_err(|_| "PDF integer exceeds i64")?)
            } else {
                let real = value
                    .as_f64()
                    .filter(|real| real.is_finite())
                    .ok_or("PDF real number is not finite")?;
                let real = real as f32;
                if !real.is_finite() {
                    return Err("PDF real number exceeds f32".into());
                }
                Object::Real(real)
            }
        }
        Value::String(value) => {
            if allow_legacy_encoding {
                qpdf_string_object_with_mode(value, true)?
            } else {
                qpdf_string_object(value)?
            }
        }
        Value::Array(values) => Object::Array(
            values
                .iter()
                .map(|value| qpdf_object_with_mode(value, allow_legacy_encoding))
                .collect::<Result<Vec<_>>>()?,
        ),
        Value::Object(_) => {
            Object::Dictionary(qpdf_dictionary_with_mode(value, allow_legacy_encoding)?)
        }
    })
}

fn qpdf_string_object(value: &str) -> Result<Object> {
    qpdf_string_object_with_mode(value, false)
}

fn qpdf_string_object_with_mode(value: &str, allow_legacy_encoding: bool) -> Result<Object> {
    if let Some(reference) = parse_qpdf_reference(value) {
        return Ok(Object::Reference(reference));
    }
    if value.starts_with('/') || value.starts_with("n:/") {
        return Ok(Object::Name(decode_qpdf_name(
            value,
            qpdf_name_mode(allow_legacy_encoding),
        )?));
    }
    if let Some(text) = value.strip_prefix("u:") {
        // qpdf writes "u:" for every string it decodes, including an ASCII
        // byte string such as /DA. Printable ASCII, tab and line breaks are
        // their own PDFDocEncoding; other control bytes are not.
        let bytes = if text
            .bytes()
            .all(|byte| matches!(byte, b'\t' | b'\n' | b'\r' | b' '..=b'~'))
        {
            text.as_bytes().to_vec()
        } else {
            encode_pdf_text_string(text)
        };
        return Ok(Object::String(bytes, StringFormat::Hexadecimal));
    }
    if let Some(hex) = value.strip_prefix("b:") {
        return Ok(Object::String(
            decode_hex_bytes(hex)?,
            StringFormat::Hexadecimal,
        ));
    }
    if allow_legacy_encoding {
        return Ok(Object::String(
            value.as_bytes().to_vec(),
            StringFormat::Literal,
        ));
    }
    Err("qpdf JSON string has an unknown PDF encoding".into())
}

fn qpdf_name_mode(allow_legacy_encoding: bool) -> QpdfNameMode {
    if allow_legacy_encoding {
        QpdfNameMode::Escaped
    } else {
        QpdfNameMode::Canonical
    }
}

fn decode_qpdf_name(value: &str, mode: QpdfNameMode) -> Result<Vec<u8>> {
    let explicit_encoding = value.starts_with("n:");
    let encoded = value.strip_prefix("n:").unwrap_or(value);
    let encoded = encoded
        .strip_prefix('/')
        .ok_or("qpdf name is missing its slash")?
        .as_bytes();
    if !explicit_encoding && matches!(mode, QpdfNameMode::Canonical) {
        return Ok(encoded.to_vec());
    }
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'#' {
            let high = *encoded
                .get(index + 1)
                .ok_or("qpdf name escape ended early")?;
            let low = *encoded
                .get(index + 2)
                .ok_or("qpdf name escape ended early")?;
            decoded.push((hex_value(high)? << 4) | hex_value(low)?);
            index += 3;
        } else {
            decoded.push(encoded[index]);
            index += 1;
        }
    }
    Ok(decoded)
}

fn decode_hex_bytes(hex: &str) -> Result<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return Err("qpdf binary string has an odd hex length".into());
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| Ok((hex_value(pair[0])? << 4) | hex_value(pair[1])?))
        .collect()
}

fn hex_value(value: u8) -> Result<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("qpdf JSON contains invalid hex".into()),
    }
}

fn read_last_byte(path: &Path, len: u64) -> Result<Option<u8>> {
    let mut file = File::open(path).map_err(io_domain_error)?;
    read_last_byte_from_file(&mut file, len)
}

pub(crate) fn read_last_byte_from_file(file: &mut File, len: u64) -> Result<Option<u8>> {
    if len == 0 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(len - 1))?;
    let mut byte = [0_u8; 1];
    file.read_exact(&mut byte)?;
    Ok(Some(byte[0]))
}

pub(crate) fn io_domain_error(error: std::io::Error) -> Box<dyn Error> {
    domain_error(NativeErrorCode::Io, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_qpdf_page_walk_in_sequential_physical_order() {
        assert_eq!(
            parse_qpdf_page_ids(b"page 1: 12 0 R\n  content:\n    80 0 R\npage 2: 19 2 R\n")
                .unwrap(),
            vec![(12, 0), (19, 2)]
        );
        assert!(parse_qpdf_page_ids(b"page 2: 12 0 R\n").is_err());
        assert!(parse_qpdf_page_ids(b"page 1: 12 0 R\npage 2: 12 0 R\n").is_err());
    }

    #[test]
    fn parses_qpdf_names_references_and_strings() {
        assert_eq!(
            decode_qpdf_name("/text/plain", QpdfNameMode::Canonical).unwrap(),
            b"text/plain"
        );
        assert_eq!(
            decode_qpdf_name("/one#31", QpdfNameMode::Canonical).unwrap(),
            b"one#31"
        );
        assert_eq!(
            decode_qpdf_name("/one#31", QpdfNameMode::Escaped).unwrap(),
            b"one1"
        );
        assert_eq!(
            decode_qpdf_name("/one#", QpdfNameMode::Canonical).unwrap(),
            b"one#"
        );
        assert_eq!(
            decode_qpdf_name("/one#", QpdfNameMode::Escaped)
                .unwrap_err()
                .to_string(),
            "qpdf name escape ended early"
        );
        assert!(decode_qpdf_name("/one#GG", QpdfNameMode::Escaped).is_err());
        assert_eq!(
            decode_qpdf_name("n:/one#a0two", QpdfNameMode::Canonical).unwrap(),
            b"one\xa0two"
        );
        assert_eq!(
            decode_qpdf_name("n:/one#a0two", QpdfNameMode::Escaped).unwrap(),
            b"one\xa0two"
        );
        assert_eq!(parse_qpdf_reference("12 3 R"), Some((12, 3)));
        assert_eq!(
            qpdf_string_object("b:00ff").unwrap(),
            Object::String(vec![0, 255], StringFormat::Hexadecimal)
        );
    }

    #[test]
    fn preserves_default_appearance_operators_from_qpdf_unicode_strings() {
        let dictionary = qpdf_dictionary(&serde_json::json!({
            "/DA": "u:/Helv 22 Tf 0.0667 0.0941 0.1529 rg",
            "/Contents": "u:canonical text box",
        }))
        .unwrap();

        assert_eq!(
            dictionary.get(b"DA").unwrap().as_str().unwrap(),
            b"/Helv 22 Tf 0.0667 0.0941 0.1529 rg",
        );
        assert_eq!(
            dictionary.get(b"Contents").unwrap().as_str().unwrap(),
            b"canonical text box",
        );
    }

    #[test]
    fn applies_name_mode_to_dictionary_keys_and_values() {
        let canonical = qpdf_dictionary(&serde_json::json!({
            "/F#31": "/F#31",
            "/XObject": {"/Im#32": "n:/Im#32"},
        }))
        .unwrap();
        assert!(canonical.get(b"F#31").is_ok());
        assert_eq!(canonical.get(b"F#31").unwrap().as_name().unwrap(), b"F#31");
        let xobjects = canonical.get(b"XObject").unwrap().as_dict().unwrap();
        assert!(xobjects.get(b"Im#32").is_ok());
        assert_eq!(xobjects.get(b"Im#32").unwrap().as_name().unwrap(), b"Im2");

        let escaped = qpdf_dictionary_with_mode(
            &serde_json::json!({"/F#31": "/F#31", "/X#32": "/X#32"}),
            true,
        )
        .unwrap();
        assert!(escaped.get(b"F1").is_ok());
        assert_eq!(escaped.get(b"F1").unwrap().as_name().unwrap(), b"F1");
        assert!(escaped.get(b"X2").is_ok());
    }

    #[test]
    fn qpdf_retained_cost_stops_at_the_per_object_limit() {
        let value = serde_json::json!({"a": [1, 2, {"b": true}]});
        assert_eq!(
            qpdf_value_retained_cost(&value, 6),
            Some(6 * QPDF_ESTIMATED_BYTES_PER_VALUE + 2)
        );
        assert_eq!(qpdf_value_retained_cost(&value, 5), None);
    }

    #[test]
    fn qpdf_data_cannot_relabel_an_invalid_object_key_as_a_resource_limit() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("evb-qpdf-error-classification-{nonce}.json"));
        fs::write(
            &path,
            br#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.7","maxobjectid":1},{"obj:resource-limit: crafted":{},"trailer":{"value":{"/Root":"1 0 R"}}}]}"#,
        )
        .unwrap();

        let error = parse_qpdf_structure(&path, None).unwrap_err();
        assert_ne!(
            error.downcast_ref::<NativeError>().map(|error| error.code),
            Some(NativeErrorCode::TooLarge),
        );

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn qpdf_maxobjectid_reserves_native_mutation_headroom() {
        assert_eq!(
            checked_qpdf_max_id(u64::from(u32::MAX - MAX_QPDF_NEW_OBJECT_HEADROOM)).unwrap(),
            u32::MAX - MAX_QPDF_NEW_OBJECT_HEADROOM
        );
        let error = checked_qpdf_max_id(u64::from(u32::MAX - MAX_QPDF_NEW_OBJECT_HEADROOM + 1))
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::TooLarge
        );
    }

    #[test]
    fn accepts_structural_sidecar_larger_than_the_old_eight_megabyte_cap() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("evb-qpdf-structural-output-test-{nonce}.json"));
        let mut file = File::create(&path).unwrap();
        file.write_all(
            br#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.7","maxobjectid":1},{"trailer":{"value":{"/Root":"1 0 R","/Producer":"u:"#,
        )
        .unwrap();
        let filler = vec![b'a'; 1024 * 1024];
        for _ in 0..9 {
            file.write_all(&filler).unwrap();
        }
        file.write_all(br#""}},"obj:1 0 R":{"value":{"/Type":"/Catalog"}}}]}"#)
            .unwrap();
        file.sync_all().unwrap();

        let metadata = file.metadata().unwrap();
        assert!(metadata.len() > 8 * 1024 * 1024);
        drop(file);
        let parsed = parse_qpdf_structure(&path, None).unwrap();
        assert_eq!(
            parsed
                .0
                .trailer
                .get(b"Root")
                .unwrap()
                .as_reference()
                .unwrap(),
            (1, 0)
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn stale_qpdf_sidecars_are_removed_without_touching_other_temp_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("evb-qpdf-cleanup-test-{nonce}"));
        fs::create_dir(&directory).unwrap();
        let sidecar = directory.join(format!("{QPDF_TEMP_PREFIX}1-2.json"));
        let unrelated = directory.join("keep.json");
        fs::write(&sidecar, b"sidecar").unwrap();
        fs::write(&unrelated, b"unrelated").unwrap();

        let now = SystemTime::now();
        remove_stale_qpdf_files(&directory, now);
        assert!(sidecar.exists());
        remove_stale_qpdf_files(&directory, now + QPDF_STALE_FILE_AGE);
        assert!(!sidecar.exists());
        assert!(unrelated.exists());

        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    fn load_with_fake_qpdf(status: i32, structure: &str) -> Result<IncrementalDocument> {
        let nonce = test_qpdf_temp_nonce()?;
        let stem = format!("evb-qpdf-status-{}-{nonce}", std::process::id());
        let input_path = std::env::temp_dir().join(format!("{stem}-input.pdf"));
        let qpdf_path = std::env::temp_dir().join(format!("{stem}-command"));

        let mut input = Document::with_version("1.4");
        let catalog_id = input.add_object(dictionary! { "Type" => "Catalog" });
        input.trailer.set("Root", catalog_id);
        input.save(&input_path)?;

        let script = format!("#!/bin/sh\nprintf '%s' '{structure}'\nexit {status}\n");
        let _fake_executable = crate::write_fake_executable(&qpdf_path, &script);

        let result = load_qpdf_structural_incremental_pdf(&input_path, &qpdf_path)
            .map(|(incremental, _)| incremental);
        let _ = fs::remove_file(&input_path);
        let _ = fs::remove_file(&qpdf_path);
        result
    }

    #[cfg(unix)]
    #[test]
    fn page_local_loader_reads_selected_page_ancestry_and_indirect_rotate_values() {
        let nonce = test_qpdf_temp_nonce().unwrap();
        let stem = format!("evb-qpdf-rotation-{nonce}");
        let input_path = std::env::temp_dir().join(format!("{stem}-input.pdf"));
        let qpdf_path = std::env::temp_dir().join(format!("{stem}-command"));
        let mut source = Document::with_version("1.7");
        let catalog_id = source.add_object(dictionary! {
            "Type" => "Catalog",
        });
        let pages_id = source.add_object(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference((3, 0))],
            "Count" => 1,
            "Rotate" => Object::Reference((4, 0)),
        });
        let page_id = source.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        source.add_object(Object::Integer(270));
        source
            .get_dictionary_mut(catalog_id)
            .unwrap()
            .set("Pages", Object::Reference(pages_id));
        source.trailer.set("Root", catalog_id);
        source.save(&input_path).unwrap();

        let qpdf_script = r##"#!/bin/sh
case "$*" in
  *--show-pages*) printf 'page 1: 3 0 R\n' ;;
  *--json-object=4,0*) printf '%s' '{"qpdf":[{"jsonversion":2,"pdfversion":"1.7","maxobjectid":4},{"trailer":{"value":{"/Root":"1 0 R","/Size":5}},"obj:4 0 R":{"value":270}}]}' ;;
  *--json-object=2,0*) printf '%s' '{"qpdf":[{"jsonversion":2,"pdfversion":"1.7","maxobjectid":4},{"trailer":{"value":{"/Root":"1 0 R","/Size":5}},"obj:2 0 R":{"value":{"/Type":"/Pages","/Kids":["3 0 R"],"/Count":1,"/Rotate":"4 0 R"}}}]}' ;;
  *--json-object=3,0*) printf '%s' '{"qpdf":[{"jsonversion":2,"pdfversion":"1.7","maxobjectid":4},{"trailer":{"value":{"/Root":"1 0 R","/Size":5}},"obj:3 0 R":{"value":{"/Type":"/Page","/Parent":"2 0 R"}}}]}' ;;
  *) exit 9 ;;
esac
"##;
        let fake_executable = crate::write_fake_executable(&qpdf_path, qpdf_script);

        let result = load_qpdf_page_local_incremental_pdf(
            &input_path,
            &qpdf_path,
            &PageLocalEdit {
                pages: BTreeSet::from([0]),
                ..PageLocalEdit::default()
            },
        );
        let _ = fs::remove_file(&input_path);
        let _ = fs::remove_file(&qpdf_path);
        drop(fake_executable);
        let mut incremental = result
            .expect("selected page ancestry should load for rotation")
            .expect("a rotation addresses no annotation");
        assert_eq!(incremental.page_ids_by_number, Some(vec![page_id]));
        assert_eq!(
            resolve_page_rotation(incremental.get_prev_documents(), page_id).unwrap(),
            270
        );

        rotate_pages_incremental(
            &mut incremental,
            &[PageRotationMutation {
                page_index: 0,
                angle: 90,
            }],
        )
        .unwrap();
        assert_eq!(
            incremental
                .new_document
                .get_dictionary(page_id)
                .unwrap()
                .get(b"Rotate")
                .unwrap()
                .as_i64()
                .unwrap(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn materialized_stream_updates_declared_length_before_clone_and_save() {
        let nonce = qpdf_temp_nonce().unwrap();
        let qpdf_path = std::env::temp_dir().join(format!("evb-qpdf-stream-length-{nonce}"));
        let _fake_executable =
            crate::write_fake_executable(&qpdf_path, "#!/bin/sh\nprintf 'recovered bytes'\n");
        let mut document = Document::with_version("1.4");
        let root = document.add_object(dictionary! {"Type" => "Catalog"});
        document.trailer.set("Root", root);
        let stream_id = document.add_object(Stream::with_position(
            dictionary! {"Length" => 0, "Filter" => "DCTDecode"},
            0,
        ));
        let mut incremental = IncrementalDocument::from_document(document, 0, None);
        incremental.unavailable_base_streams.insert(stream_id);
        incremental
            .materialize_base_stream(Path::new("unused.pdf"), &qpdf_path, stream_id, 1024)
            .unwrap();
        fs::remove_file(qpdf_path).unwrap();
        incremental
            .opt_clone_object_to_new_document(stream_id)
            .unwrap();
        let stream = incremental
            .new_document
            .get_object(stream_id)
            .unwrap()
            .as_stream()
            .unwrap();
        assert_eq!(stream.content, b"recovered bytes");
        assert_eq!(stream.dict.get(b"Length").unwrap().as_i64().unwrap(), 15);
        assert_eq!(
            stream.dict.get(b"Filter").unwrap().as_name().unwrap(),
            b"DCTDecode"
        );
        let mut bytes = Vec::new();
        incremental.previous_document.save_to(&mut bytes).unwrap();
        let reparsed = Document::load_mem(&bytes).unwrap();
        assert_eq!(
            reparsed
                .get_object(stream_id)
                .unwrap()
                .as_stream()
                .unwrap()
                .content,
            b"recovered bytes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn qpdf_warning_exit_with_valid_json_loads_the_structural_document() {
        let result = load_with_fake_qpdf(
            3,
            r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"/Root":"1 0 R"}},"obj:1 0 R":{"value":{"/Type":"/Catalog"}}}]}"#,
        )
        .expect("qpdf warning-only output with valid JSON should load");

        assert_eq!(result.previous_document.max_id, 1);
        assert_eq!(result.previous_document.root_id().unwrap(), (1, 0));
    }

    #[cfg(unix)]
    #[test]
    fn qpdf_legacy_json_loads_plain_strings_and_marks_streams_unavailable() {
        let mut result = load_with_fake_qpdf(
            0,
            r#"{"version":1,"objects":{"trailer":{"/Size":3,"/Root":"1 0 R"},"1 0 R":{"/Type":"/Catalog","/Title":"Legacy title","/X#23":"/X#23","/Resources":{"/XObject":{"/Im#23":"/Im#23"}}},"2 0 R":{"/Length":4,"/Filter":"/FlateDecode"}}}"#,
        )
        .expect("qpdf legacy JSON should load");

        assert_eq!(result.previous_document.version, "1.4");
        assert_eq!(result.previous_document.max_id, 2);
        assert_eq!(result.previous_document.root_id().unwrap(), (1, 0));
        assert_eq!(
            result
                .previous_document
                .get_object((1, 0))
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"Title")
                .unwrap()
                .as_str()
                .unwrap(),
            b"Legacy title"
        );
        let catalog = result
            .previous_document
            .get_object((1, 0))
            .unwrap()
            .as_dict()
            .unwrap();
        assert_eq!(catalog.get(b"X#").unwrap().as_name().unwrap(), b"X#");
        assert_eq!(
            catalog
                .get(b"Resources")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"XObject")
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"Im#")
                .unwrap()
                .as_name()
                .unwrap(),
            b"Im#"
        );
        assert!(matches!(
            result.previous_document.get_object((2, 0)).unwrap(),
            Object::Stream(_)
        ));
        assert!(result.opt_clone_object_to_new_document((2, 0)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn qpdf_warning_exit_with_truncated_json_fails_closed() {
        let error = load_with_fake_qpdf(
            3,
            r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"#,
        )
            .expect_err("truncated qpdf JSON must fail closed");

        let message = error.to_string();
        assert!(
            message.contains("EOF") || message.contains("expected"),
            "unexpected qpdf JSON parse error: {message}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn qpdf_error_exit_fails_before_accepting_valid_json() {
        let error = load_with_fake_qpdf(
            2,
            r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"/Root":"1 0 R"}},"obj:1 0 R":{"value":{"/Type":"/Catalog"}}}]}"#,
        )
        .expect_err("qpdf error exit must fail closed");

        let native_error = error
            .downcast_ref::<NativeError>()
            .expect("qpdf process failures should carry a native error");
        assert_eq!(native_error.code, NativeErrorCode::CorruptXref);
    }
}
