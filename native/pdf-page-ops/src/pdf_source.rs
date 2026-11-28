//! A PDF read through its cross-reference index, for page-structure writes.
//!
//! Every object the trailer reaches is parsed at its offset into a skeleton
//! `Document` whose streams keep their dictionaries only: stream data is
//! located, never read, and a writer copies it by byte range. Memory follows
//! the object structure, not the file size. Desktop files, range-backed WASM
//! host files (`HostSource`), and byte-buffer requests all use the same code.
use super::*;
use lopdf::xref::{Xref, XrefType};
use std::{io, rc::Rc};

/// The largest object, cross-reference section or object stream read whole.
const MAX_OBJECT_BYTES: usize = MAX_DECOMPRESSED_PDF_STREAM_BYTES;
/// The most values one object's arrays and dictionaries hold, which bounds
/// the memory it parses into as its byte ceiling alone does not. A reader
/// that selected the keys it uses allowed a million values; this one parses
/// the keys it leaves unused too.
pub(crate) const MAX_OBJECT_ELEMENTS: usize = 2_000_000;
/// The most values all the objects one read parses hold together: room for
/// a document at the object and page ceilings, well below what wasm32 memory
/// holds once parsed.
const MAX_SOURCE_VALUES: usize = 20_000_000;
const FIRST_WINDOW_BYTES: usize = 4 * 1024;
const MAX_XREF_SECTIONS: usize = 4_096;
/// Where the terminal `startxref` is looked for, past any trailing padding.
const TAIL_BYTES: usize = 64 * 1024;

/// Bytes read at an offset: a desktop file, a range-backed WASM `HostSource`,
/// or an in-memory request buffer.
pub(crate) trait ByteSource {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()>;
    fn copy_range(&self, offset: u64, len: u64, output: &mut impl Write) -> io::Result<()>;
}

impl<T: ByteSource + ?Sized> ByteSource for &T {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        (**self).read_at(offset, buffer)
    }

    fn copy_range(&self, offset: u64, len: u64, output: &mut impl Write) -> io::Result<()> {
        (**self).copy_range(offset, len, output)
    }
}

fn slice_range(bytes: &[u8], offset: u64, len: u64) -> io::Result<&[u8]> {
    usize::try_from(offset)
        .ok()
        .zip(usize::try_from(len).ok())
        .and_then(|(start, len)| bytes.get(start..start.checked_add(len)?))
        .ok_or_else(|| io::ErrorKind::UnexpectedEof.into())
}

impl ByteSource for [u8] {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        buffer.copy_from_slice(slice_range(self, offset, buffer.len() as u64)?);
        Ok(())
    }

    fn copy_range(&self, offset: u64, len: u64, output: &mut impl Write) -> io::Result<()> {
        output.write_all(slice_range(self, offset, len)?)
    }
}

/// One read at `offset` that leaves the handle's cursor alone, so reads
/// through a shared handle never race over where it points.
#[cfg(unix)]
fn read_file_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buffer, offset)
}

/// Windows moves the cursor on a positioned read, but no read here uses it.
#[cfg(windows)]
fn read_file_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buffer, offset)
}

/// Targets without positioned reads have no file sources in use.
#[cfg(not(any(unix, windows)))]
fn read_file_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    let mut file = file;
    file.seek(SeekFrom::Start(offset))?;
    file.read(buffer)
}

/// Fills `buffer` from `offset`, across short reads; the file ending first
/// is `UnexpectedEof`.
fn read_file_exact_at(file: &File, mut buffer: &mut [u8], mut offset: u64) -> io::Result<()> {
    while !buffer.is_empty() {
        match read_file_at(file, buffer, offset) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => {
                buffer = &mut buffer[read..];
                offset += read as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// The chunk a range copy moves through memory at once.
const COPY_CHUNK_BYTES: usize = 256 * 1024;

impl ByteSource for File {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        read_file_exact_at(self, buffer, offset)
    }

    fn copy_range(&self, mut offset: u64, len: u64, output: &mut impl Write) -> io::Result<()> {
        let mut buffer = vec![0; len.min(COPY_CHUNK_BYTES as u64) as usize];
        let mut left = len;
        while left > 0 {
            let chunk = &mut buffer[..left.min(COPY_CHUNK_BYTES as u64) as usize];
            read_file_exact_at(self, chunk, offset)?;
            output.write_all(chunk)?;
            offset += chunk.len() as u64;
            left -= chunk.len() as u64;
        }
        Ok(())
    }
}

/// What an open accepts of a file's encryption and terminal revision.
#[derive(Clone, Copy)]
enum OpenMode {
    /// Any terminal revision; an encrypted file read with the empty password.
    Decrypting,
    /// Any terminal revision; encryption refused from the index.
    Plaintext,
    /// Any terminal revision for conformance inspection: preserves `/Encrypt`
    /// in the trailer even when empty-password decryption succeeds, and tolerates
    /// unreadable encrypted object streams when a user password is required.
    Conformance,
    /// Strict structural verification for save promotion: qpdf's terminal
    /// revision, no bytes before the header, exact declared stream lengths
    /// with no endstream recovery scan, and no duplicate dictionary keys.
    StrictVerify,
    /// The base of an append: qpdf's terminal revision, no bytes before the
    /// header, encryption refused from the index.
    AppendBase,
}

#[cfg(test)]
thread_local! {
    static SOURCE_PDF_OPEN_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static SOURCE_PDF_LOADED_OBJECT_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_source_pdf_open_count() {
    SOURCE_PDF_OPEN_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn source_pdf_open_count() -> usize {
    SOURCE_PDF_OPEN_COUNT.with(std::cell::Cell::get)
}

#[cfg(test)]
pub(crate) fn reset_source_pdf_loaded_object_count() {
    SOURCE_PDF_LOADED_OBJECT_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn source_pdf_loaded_object_count() -> usize {
    SOURCE_PDF_LOADED_OBJECT_COUNT.with(std::cell::Cell::get)
}

/// Cumulative cross-reference budget carried across in-memory incremental
/// appends so the writer enforces the exact same limits as `Reader::index_at`
/// before publishing a revision.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct IndexedXrefBudget {
    pub(crate) sections: usize,
    pub(crate) offsets: usize,
    pub(crate) entries: usize,
    pub(crate) values: usize,
}

impl IndexedXrefBudget {
    /// Verifies that appending one non-empty revision with `written_objects`
    /// objects (`new_object_numbers` of which were not previously in the base)
    /// and `net_value_delta` change in total PDF object values stays within the
    /// indexed reader's cumulative limits, and advances the budget on success.
    pub(crate) fn check_and_record_revision(
        &mut self,
        written_objects: usize,
        new_object_numbers: usize,
        net_value_delta: isize,
        wrote_xref_stream: bool,
    ) -> Result<()> {
        let next_sections = self.sections.saturating_add(1);
        if next_sections > MAX_XREF_SECTIONS {
            return Err(corrupt("PDF cross-reference chain loops or is too long"));
        }
        let added_offsets = 1usize
            .saturating_add(written_objects)
            .saturating_add(usize::from(wrote_xref_stream));
        let next_offsets = self.offsets.saturating_add(added_offsets);
        if next_offsets > MAX_SOURCE_VALUES {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("PDF cross-references list more than {MAX_SOURCE_VALUES} entries"),
            ));
        }
        let added_entries = new_object_numbers.saturating_add(usize::from(wrote_xref_stream));
        let next_entries = self.entries.saturating_add(added_entries);
        if next_entries > MAX_PDF_OBJECTS {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("PDF exceeds the {MAX_PDF_OBJECTS}-object admission ceiling"),
            ));
        }
        let xref_stream_values = if wrote_xref_stream {
            // An appended cross-reference stream dictionary adds /Type, /Size,
            // /W [1 8 2], /Root, /Prev, /Length, optional /Info+/ID, and an
            // /Index array with at most one [start count] pair per written object.
            16usize.saturating_add(written_objects.saturating_mul(2))
        } else {
            0
        };
        let next_values = if net_value_delta >= 0 {
            self.values
                .saturating_add(net_value_delta as usize)
                .saturating_add(xref_stream_values)
        } else {
            self.values
                .saturating_sub(net_value_delta.unsigned_abs())
                .saturating_add(xref_stream_values)
        };
        if next_values > MAX_SOURCE_VALUES {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("PDF objects exceed the {MAX_SOURCE_VALUES}-value ceiling"),
            ));
        }
        self.sections = next_sections;
        self.offsets = next_offsets;
        self.entries = next_entries;
        self.values = next_values;
        Ok(())
    }
}

/// Counts PDF values held by `object`, matching `Loader::values_of`.
pub(crate) fn object_value_count(object: &Object) -> usize {
    Loader::<[u8]>::values_of(object)
}

/// A parsed PDF whose stream data stays in its source.
pub(crate) struct SourcePdf<S> {
    pub(crate) document: Document,
    /// Each stream's data as an absolute byte range of `bytes`.
    streams: HashMap<ObjectId, (u64, u64)>,
    /// The reals of each object that `f32` does not print back exactly.
    reals: HashMap<ObjectId, RealSpellings>,
    bytes: S,
    len: u64,
    /// The terminal `startxref` offset, which an appended revision names as `/Prev`.
    xref_start: u64,
    /// Cumulative xref chain counts read at open time.
    xref_budget: IndexedXrefBudget,
}

impl SourcePdf<File> {
    /// The PDF in the file at `path`, as `open` reads it, whose page tree
    /// yields its first and last pages, as an append base's must.
    pub(crate) fn open_path(path: &Path) -> Result<Self> {
        let (file, len) = open_source_file(path)?;
        let pdf = Self::open(file, len)?;
        PageTreeResolver::with_both_ends(&pdf.document).map_err(page_tree_damaged)?;
        Ok(pdf)
    }

    /// The PDF in the file at `path`, as `open_plaintext` reads it, whose page
    /// tree yields its first and last pages.
    pub(crate) fn open_plaintext_path(path: &Path) -> Result<Self> {
        let (file, len) = open_source_file(path)?;
        let pdf = Self::open_plaintext(file, len)?;
        PageTreeResolver::with_both_ends(&pdf.document).map_err(page_tree_damaged)?;
        Ok(pdf)
    }

    /// The PDF in the file at `path` for conformance inspection.
    pub(crate) fn open_conformance_path(path: &Path) -> Result<Self> {
        let (file, len) = open_source_file(path)?;
        Self::open_conformance(file, len)
    }

    /// Strict structural verification of the file at `path` without stream decoding.
    pub(crate) fn open_strict_verify_path(path: &Path) -> Result<Self> {
        let (file, len) = open_source_file(path)?;
        Self::open_strict_verify(file, len)
    }

    /// The PDF in the file at `path` as the base of an incremental append,
    /// with the source that reads the streams the base leaves unread.
    pub(crate) fn open_append_base_path(path: &Path) -> Result<(Self, IncrementalDocument)> {
        let (file, len) = open_source_file(path)?;
        let mut source = Self::open_append_base(file, len)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        let base = source
            .take_append_base()
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        Ok((source, base))
    }

    /// The PDF in the file at `path` as a validated page-geometry append base
    /// (for crop and remove-crop), reading only the catalog, page tree, and
    /// inherited page geometry attributes.
    pub(crate) fn open_page_geometry_append_base_path(
        path: &Path,
    ) -> Result<(IncrementalDocument, PageTreeResolver)> {
        let (file, len) = open_source_file(path)?;
        let (_, base, resolver) = Self::open_page_geometry_append_base(file, len)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        Ok((base, resolver))
    }

    /// The PDF in the file at `path` as a targeted append base for replacing
    /// images on `page_numbers`, loading only the page tree and the targeted
    /// pages' content and resource graphs.
    pub(crate) fn open_page_content_append_base_path(
        path: &Path,
        page_numbers: &[u32],
    ) -> Result<(Self, IncrementalDocument)> {
        let (file, len) = open_source_file(path)?;
        Self::open_page_content_append_base(file, len, page_numbers)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))
    }
}

/// The file at `path` as a source, with its length.
pub(crate) fn open_source_file(path: &Path) -> Result<(File, u64)> {
    let file = File::open(path).map_err(io_domain_error)?;
    let len = file.metadata().map_err(io_domain_error)?.len();
    Ok((file, len))
}

impl<S: ByteSource> SourcePdf<S> {
    /// Indexes `bytes` and parses every object its trailer reaches. An
    /// encrypted input is read decrypted when the empty password opens it;
    /// otherwise it needs a password this route does not take.
    pub(crate) fn open(bytes: S, len: u64) -> Result<Self> {
        Self::open_indexed(bytes, len, OpenMode::Decrypting, &[])
    }

    /// A read that takes only plaintext: encryption, which the index shows,
    /// is refused before any object is read or decrypted. Any terminal
    /// revision the index reads will do, since nothing is appended.
    pub(crate) fn open_plaintext(bytes: S, len: u64) -> Result<Self> {
        Self::open_indexed(bytes, len, OpenMode::Plaintext, &[])
    }

    /// Reads trailer, catalog, form and signature structure for conformance
    /// inspection without requiring a user password or loading stream bytes.
    pub(crate) fn open_conformance(bytes: S, len: u64) -> Result<Self> {
        Self::open_indexed(bytes, len, OpenMode::Conformance, &[])
    }

    /// Strict structural verification without stream decoding: enforces qpdf's
    /// terminal xref locator, exact declared stream lengths (no recovery),
    /// unique dictionary keys, and a readable page tree.
    pub(crate) fn open_strict_verify(bytes: S, len: u64) -> Result<Self> {
        let pdf = Self::open_indexed(bytes, len, OpenMode::StrictVerify, &[])?;
        PageTreeResolver::with_both_ends(&pdf.document).map_err(page_tree_damaged)?;
        Ok(pdf)
    }

    /// The base of an incremental append. Plaintext objects appended to an
    /// encrypted file would be unreadable, so encryption, which the index
    /// shows, is refused before any object is read: the unlock flow rewrites
    /// such a file first, an empty password included. Bytes before the header
    /// are refused too: this reader counts offsets from the header, as lopdf
    /// does, but an appended revision records them from the start of the file.
    pub(crate) fn open_append_base(bytes: S, len: u64) -> Result<Self> {
        Self::open_indexed(bytes, len, OpenMode::AppendBase, &[])
    }

    /// An append base that also holds the objects in `named`, with what they
    /// reference, where the index lists them. An append can name an object
    /// the trailer no longer reaches, such as the image of a deleted stamp
    /// that an undo restores.
    #[cfg(test)]
    pub(crate) fn open_append_base_naming(bytes: S, len: u64, named: &[ObjectId]) -> Result<Self> {
        Self::open_indexed(bytes, len, OpenMode::AppendBase, named)
    }

    /// A validated page-geometry append base for crop and crop-removal edits:
    /// reads only the catalog, page tree, and inherited geometry attributes
    /// without parsing content streams, resources, annotations, or outlines.
    /// Untouched page content and resource objects are intentionally not read
    /// during targeted appends; full-document structural verification remains
    /// the responsibility of `open_strict_verify` and whole-document rewrites.
    pub(crate) fn open_page_geometry_append_base(
        bytes: S,
        len: u64,
    ) -> Result<(Self, IncrementalDocument, PageTreeResolver)> {
        let (source, resolver) = {
            let (reader, index) = open_append_base_index(&bytes, len)?;
            let mut target = TargetedLoader::new(&reader, &index);
            target.load_page_tree_all(true)?;
            let resolver = target.validate_full_page_tree()?;
            (target.into_parts(), resolver)
        };
        let mut pdf = Self::from_targeted_parts(source, bytes, len);
        let base = pdf.take_append_base()?;
        Ok((pdf, base, resolver))
    }

    /// A targeted append base for page-content edits (`replace-page-images`):
    /// reads the page tree, inherited geometry attributes, and only the
    /// `/Contents` and `/Resources` subgraphs (including inherited `/Resources`)
    /// of the requested 1-based `page_numbers`.
    pub(crate) fn open_page_content_append_base(
        bytes: S,
        len: u64,
        page_numbers: &[u32],
    ) -> Result<(Self, IncrementalDocument)> {
        let parts = {
            let (reader, index) = open_append_base_index(&bytes, len)?;
            let mut target = TargetedLoader::new(&reader, &index);
            target.load_page_tree_all(true)?;
            let (resolver, _) = target.validate_page_tree_ends()?;
            let mut seen_pages = HashSet::new();
            for &page_number in page_numbers {
                let Ok(page_id) = resolver.page_id(&target.document, page_number) else {
                    continue;
                };
                if seen_pages.insert(page_id) {
                    target.load_page_contents_and_resources(page_id)?;
                }
            }
            target.into_parts()
        };
        let mut pdf = Self::from_targeted_parts(parts, bytes, len);
        let base = pdf.take_append_base()?;
        Ok((pdf, base))
    }

    /// A targeted append base for `save-mutations`: reads the catalog, page
    /// tree, and inherited geometry attributes without parsing page `/Contents`,
    /// `/Resources`, `/StructTreeRoot`, or untouched appearance graphs.
    /// Catalog-only saves, geometry-only saves on unannotated pages, and
    /// clean-page additive annotation saves also skip `/Annots` on untouched
    /// pages (recording `located_pages`); saves touching existing annotations
    /// load the shallow annotation ownership graph plus full subgraphs of
    /// touched/addressed annotations and named recovery images, escalating to
    /// the full graph only when an existing placed-image stamp requires global
    /// exclusivity verification. Untouched page `/Contents` and `/Resources`
    /// objects are intentionally not read on page-local appends; full-document
    /// object-graph verification remains the role of `open_strict_verify` and
    /// whole-document operations.
    pub(crate) fn open_mutation_append_base(
        bytes: S,
        len: u64,
        mutations: &NativeMutationsFile,
    ) -> Result<(Self, IncrementalDocument)> {
        let (parts, located_pages) = {
            let (reader, index) = open_append_base_index(&bytes, len)?;
            let mut target = TargetedLoader::new(&reader, &index);
            let located_pages = target.load_for_mutations(mutations)?;
            (target.into_parts(), located_pages)
        };
        let mut pdf = Self::from_targeted_parts(parts, bytes, len);
        let mut base = pdf.take_append_base()?;
        base.located_pages = located_pages;
        Ok((pdf, base))
    }

    fn from_targeted_parts(parts: TargetedParts, bytes: S, len: u64) -> Self {
        Self {
            document: parts.document,
            streams: parts.streams,
            reals: parts.reals,
            bytes,
            len,
            xref_start: parts.xref_start,
            xref_budget: parts.xref_budget,
        }
    }

    fn open_indexed(bytes: S, len: u64, mode: OpenMode, named: &[ObjectId]) -> Result<Self> {
        #[cfg(test)]
        SOURCE_PDF_OPEN_COUNT.with(|count| count.set(count.get().saturating_add(1)));
        let mut reader = Reader::new(&bytes, len)?;
        reader.strict = matches!(mode, OpenMode::StrictVerify);
        let index = match mode {
            // An append extends the revision every reader takes as the last
            // one: the one qpdf's locator finds, as admission at open
            // requires of every base.
            OpenMode::AppendBase | OpenMode::StrictVerify => {
                if reader.base != 0 {
                    return Err(corrupt("PDF has bytes before its header"));
                }
                reader.index_at(reader.qpdf_start()?)?
            }
            OpenMode::Decrypting | OpenMode::Plaintext | OpenMode::Conformance => reader.index()?,
        };
        let trailer_encrypted = index.trailer.has(b"Encrypt");
        if trailer_encrypted {
            match mode {
                OpenMode::Decrypting => return Self::open_decrypted(bytes, len, index.start),
                OpenMode::Conformance | OpenMode::StrictVerify => {
                    if matches!(mode, OpenMode::Conformance) {
                        if let Some(encrypt_entry) = index.trailer.get(b"Encrypt").ok().cloned() {
                            if let Ok(len_usize) = usize::try_from(len) {
                                if len_usize <= MAX_ENCODED_PDF_BYTES {
                                    let mut data = vec![0; len_usize];
                                    bytes.read_at(0, &mut data).map_err(io_domain_error)?;
                                    if let Ok(mut document) =
                                        load_pdf_bytes_bounded(&data, Some(""))
                                    {
                                        if !document.is_encrypted() {
                                            document.trailer.set(b"Encrypt", encrypt_entry);
                                            return Ok(Self {
                                                document,
                                                streams: HashMap::new(),
                                                reals: HashMap::new(),
                                                bytes,
                                                len,
                                                xref_start: index.start,
                                                xref_budget: index.budget,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                OpenMode::Plaintext => {
                    return Err(domain_error(
                        NativeErrorCode::Encrypted,
                        "Encrypted PDFs are not supported by native page ops",
                    ));
                }
                OpenMode::AppendBase => {
                    return Err(domain_error(
                        NativeErrorCode::Encrypted,
                        "Unlock the encrypted PDF before editing it",
                    ));
                }
            }
        }
        let mut document = Document::with_version(reader.version.clone());
        document.max_id = index.max_number;
        document.reference_table = Xref::new(document.max_id.saturating_add(1), index.xref_type);
        document.trailer = index.trailer.clone();
        let mut loader = Loader::new(&reader, &index);
        let mut pending = Vec::new();
        collect_references(&document.trailer, &mut pending);
        let mut named = named
            .iter()
            .filter(|id| match index.entries.get(&id.0) {
                Some(XrefEntry::Offset { generation, .. }) => *generation == id.1,
                Some(XrefEntry::InStream { .. }) => id.1 == 0,
                _ => false,
            })
            .copied()
            .collect::<Vec<_>>();
        if matches!(mode, OpenMode::Conformance | OpenMode::StrictVerify) {
            for (&number, entry) in &index.entries {
                match entry {
                    XrefEntry::Offset { generation, .. } => named.push((number, *generation)),
                    XrefEntry::InStream { .. } => named.push((number, 0)),
                    XrefEntry::Free => {}
                }
            }
        }
        while let Some(id) = pending.pop().or_else(|| named.pop()) {
            if document.objects.contains_key(&id) {
                continue;
            }
            if document.objects.len() >= MAX_PDF_OBJECTS {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    format!("PDF exceeds the {MAX_PDF_OBJECTS}-object admission ceiling"),
                ));
            }
            let object = match loader.load(id) {
                Ok(object) => object,
                Err(error) if matches!(mode, OpenMode::Conformance) && trailer_encrypted => {
                    // Fail closed on resource-limit or I/O errors so partial scans
                    // never masquerade as complete conformance facts.
                    let fatal = error.downcast_ref::<NativeError>().is_some_and(|native| {
                        matches!(native.code, NativeErrorCode::TooLarge | NativeErrorCode::Io)
                    });
                    if fatal {
                        return Err(error);
                    }
                    continue;
                }
                Err(error) => return Err(error),
            };
            collect_object_references(&object, &mut pending);
            document.objects.insert(id, object);
        }
        if !(matches!(mode, OpenMode::Conformance) && trailer_encrypted) {
            let pages = document.get_pages().len();
            if pages == 0 {
                // A page tree that lists no page is damaged; a catalog or tree
                // root the index cannot find is the index's damage.
                let tree = document
                    .catalog()
                    .and_then(|catalog| catalog.get(b"Pages"))
                    .and_then(Object::as_reference)
                    .and_then(|pages| document.get_dictionary(pages));
                return Err(match tree {
                    Ok(_) => page_tree_damaged("it lists no pages".into()),
                    Err(_) => corrupt("PDF has no pages"),
                });
            }
            if pages > MAX_PATH_INPUT_PDF_PAGES {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    format!("PDF page count exceeds the {MAX_PATH_INPUT_PDF_PAGES}-page ceiling"),
                ));
            }
        }
        let mut xref_budget = index.budget;
        xref_budget.values = loader.values;
        Ok(Self {
            document,
            streams: loader.streams,
            reals: loader.reals,
            bytes,
            len,
            xref_start: index.start,
            xref_budget,
        })
    }

    fn open_decrypted(bytes: S, len: u64, xref_start: u64) -> Result<Self> {
        let len = usize::try_from(len)
            .ok()
            .filter(|len| *len <= MAX_ENCODED_PDF_BYTES)
            .ok_or_else(|| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "Encrypted PDF input exceeds the byte ceiling of the decrypting reader",
                )
            })?;
        let mut data = vec![0; len];
        bytes.read_at(0, &mut data).map_err(io_domain_error)?;
        let document = load_pdf_bytes_bounded(&data, Some(""))?;
        if document.is_encrypted() {
            return Err(domain_error(
                NativeErrorCode::NeedsPassword,
                "The encrypted PDF requires a password",
            ));
        }
        let values = document.objects.values().map(object_value_count).sum();
        Ok(Self {
            document,
            streams: HashMap::new(),
            reals: HashMap::new(),
            bytes,
            len: len as u64,
            xref_start,
            xref_budget: IndexedXrefBudget {
                sections: 1,
                offsets: 1,
                entries: 0,
                values,
            },
        })
    }

    /// The source byte length recorded when this index was opened.
    #[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
    pub(crate) fn len(&self) -> u64 {
        self.len
    }

    /// The cumulative cross-reference section, offset, and entry counts parsed
    /// when this source was opened.
    pub(crate) fn xref_budget(&self) -> IndexedXrefBudget {
        self.xref_budget
    }

    /// Rebinds stream range reads to another backing source holding the same
    /// initial `self.len` bytes (for example, a private staged snapshot of the
    /// input file).
    pub(crate) fn with_byte_source<T: ByteSource>(self, bytes: T) -> SourcePdf<T> {
        SourcePdf {
            document: self.document,
            streams: self.streams,
            reals: self.reals,
            bytes,
            len: self.len,
            xref_start: self.xref_start,
            xref_budget: self.xref_budget,
        }
    }

    /// The source byte range of a stream whose data this source holds.
    pub(crate) fn stream_range(&self, id: ObjectId) -> Option<(&S, u64, u64)> {
        self.streams
            .get(&id)
            .map(|(offset, len)| (&self.bytes, *offset, *len))
    }

    /// Reads into `document`, which holds this source's objects, the bytes
    /// of each stream the source left unread that `root` reaches, without
    /// entering a page or page-tree node or an object `mapped` names, at most
    /// `max_bytes` in all, so a writer that copies that graph copies its data.
    pub(crate) fn read_streams_into(
        &self,
        document: &mut Document,
        root: &Object,
        mapped: impl Fn(ObjectId) -> bool,
        max_bytes: usize,
    ) -> Result<()> {
        let mut pending = Vec::new();
        collect_object_references(root, &mut pending);
        let mut seen = HashSet::new();
        let mut left = max_bytes;
        while let Some(id) = pending.pop() {
            if mapped(id) || !seen.insert(id) {
                continue;
            }
            let Some(object) = document.objects.get_mut(&id) else {
                continue;
            };
            let dictionary = match &*object {
                Object::Dictionary(dictionary) => dictionary,
                Object::Stream(stream) => &stream.dict,
                object => {
                    collect_object_references(object, &mut pending);
                    continue;
                }
            };
            if matches!(
                dictionary.get(b"Type").and_then(Object::as_name),
                Ok(b"Page" | b"Pages")
            ) {
                continue;
            }
            collect_references(dictionary, &mut pending);
            if let Object::Stream(stream) = object {
                if stream.content.is_empty() && self.streams.contains_key(&id) {
                    let bytes = self.raw_stream(id, left)?;
                    left -= bytes.len();
                    stream.set_content(bytes);
                }
            }
        }
        Ok(())
    }

    /// `stream`, object `id` of this source's document, with its encoded
    /// bytes: read by range when the source holds them, refused above
    /// `max_bytes` as a decoder refuses an oversized stream.
    pub(crate) fn with_bytes<'d>(
        &self,
        id: ObjectId,
        stream: &'d Stream,
        max_bytes: usize,
    ) -> lopdf::Result<std::borrow::Cow<'d, Stream>> {
        if !stream.content.is_empty() || !self.streams.contains_key(&id) {
            return Ok(std::borrow::Cow::Borrowed(stream));
        }
        let bytes = self.raw_stream(id, max_bytes).map_err(|error| {
            match error.downcast_ref::<NativeError>().map(|error| error.code) {
                Some(NativeErrorCode::TooLarge) => {
                    lopdf::Error::from(lopdf::DecompressError::MemoryLimitExceeded {
                        limit: max_bytes,
                    })
                }
                _ => lopdf::Error::IO(io::Error::other(error.to_string())),
            }
        })?;
        let mut stream = stream.clone();
        stream.set_content(bytes);
        Ok(std::borrow::Cow::Owned(stream))
    }

    /// How object `id` spelled the real at `path`, when `value` is still the
    /// number read there.
    pub(crate) fn spelling(&self, id: ObjectId, path: &[u8], value: f32) -> Option<&str> {
        let (bits, text) = self.reals.get(&id)?.get(path)?;
        (*bits == value.to_bits()).then_some(&**text)
    }

    /// Moves the skeleton into the base of an incremental append. This source
    /// keeps its stream ranges, which read what the base left unread. A page
    /// tree whose first or last page cannot be found is damaged: writers and
    /// readers number pages through it.
    pub(crate) fn take_append_base(&mut self) -> Result<IncrementalDocument> {
        PageTreeResolver::with_both_ends(&self.document).map_err(page_tree_damaged)?;
        let mut last = [0];
        if self.len > 0 {
            self.bytes
                .read_at(self.len - 1, &mut last)
                .map_err(io_domain_error)?;
        }
        IncrementalDocument::from_indexed_document(
            std::mem::take(&mut self.document),
            self.len,
            (self.len > 0).then_some(last[0]),
            self.xref_start,
            self.streams.keys().copied(),
        )
    }
}

impl<S: ByteSource> RawStreamSource for SourcePdf<S> {
    fn raw_stream(&self, object_id: ObjectId, max_bytes: usize) -> Result<Vec<u8>> {
        let (offset, len) = self
            .streams
            .get(&object_id)
            .copied()
            .ok_or("PDF stream data is not in its source")?;
        let len = usize::try_from(len)
            .ok()
            .filter(|len| *len <= max_bytes)
            .ok_or_else(|| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "PDF stream exceeds its byte ceiling",
                )
            })?;
        let mut bytes = vec![0; len];
        self.bytes
            .read_at(offset, &mut bytes)
            .map_err(io_domain_error)?;
        Ok(bytes)
    }
}

/// Bytes compared at each end of a written stream.
const STREAM_SAMPLE_BYTES: u64 = 16;

/// Reopens the written form of `document` (whose streams `raw` locates as
/// the writer took them) and checks what a writer that copies byte ranges can
/// get wrong, in time that follows the object count rather than the bytes:
/// every cross-reference entry names the object at its offset; every
/// stream's length ends at its `endstream`, and its data begins and ends
/// with the bytes it was written from; every object of `document` is there
/// and every reference from the trailer resolves; and the page tree yields
/// `document`'s pages, each with a parent, a media box and resources.
pub(crate) fn verify_written<'a, S: ByteSource + 'a, O: ByteSource>(
    document: &Document,
    raw: impl Fn(ObjectId) -> Option<(&'a S, u64, u64)>,
    output: &O,
    len: u64,
) -> Result<()> {
    let reader = Reader::new(output, len)?;
    if !Reader::read(output, len, len.saturating_sub(6), 6)?.ends_with(b"%%EOF\n") {
        return Err(corrupt("The written PDF does not end with %%EOF"));
    }
    let index = reader.index()?;
    let mut written = Document::with_version(reader.version.clone());
    written.trailer = index.trailer.clone();
    for (&number, entry) in &index.entries {
        let XrefEntry::Offset { offset, generation } = *entry else {
            return Err(corrupt("The written PDF has a compressed object"));
        };
        let id = (number, generation);
        let (_, object, data, _) = reader.indirect_object(offset, Some(id))?;
        if let (Object::Dictionary(dictionary), Some(data)) = (&object, data) {
            let start = reader.base + data;
            let declared = dictionary
                .get(b"Length")
                .and_then(Object::as_i64)
                .ok()
                .and_then(|length| u64::try_from(length).ok())
                .filter(|length| reader.ends_at_endstream(start, *length).unwrap_or(false))
                .ok_or_else(|| {
                    corrupt(format!(
                        "Written stream {number} does not end at its length"
                    ))
                })?;
            if let Some(Object::Stream(stream)) = document.objects.get(&id) {
                let same = match raw(id).filter(|_| stream.content.is_empty()) {
                    Some((source, origin, source_len)) => {
                        same_ends(output, start, declared, source, origin, source_len)
                    }
                    None => same_ends(
                        output,
                        start,
                        declared,
                        &stream.content[..],
                        0,
                        stream.content.len() as u64,
                    ),
                };
                if !same.map_err(io_domain_error)? {
                    return Err(corrupt(format!(
                        "Written stream {number} differs from its source"
                    )));
                }
            }
        }
        written.objects.insert(id, object);
    }
    if let Some(id) = document
        .objects
        .keys()
        .find(|id| !written.objects.contains_key(id))
    {
        return Err(corrupt(format!(
            "The written PDF lacks object {} {}",
            id.0, id.1
        )));
    }
    let mut pending = Vec::new();
    let mut reached = HashSet::new();
    collect_references(&written.trailer, &mut pending);
    while let Some(id) = pending.pop() {
        if reached.insert(id) {
            let object = written.objects.get(&id).ok_or_else(|| {
                corrupt(format!(
                    "Written reference {} {} R resolves to nothing",
                    id.0, id.1
                ))
            })?;
            collect_object_references(object, &mut pending);
        }
    }
    let pages = written.get_pages();
    if pages.len() != document.get_pages().len() {
        return Err(corrupt("The written page tree lost pages"));
    }
    for page in pages.into_values() {
        let parent = written
            .get_dictionary(page)?
            .get(b"Parent")?
            .as_reference()?;
        written.get_dictionary(parent)?;
        for key in [b"MediaBox".as_slice(), b"Resources"] {
            resolve_inherited_object(&written, page, key)?
                .ok_or_else(|| corrupt("A written page lacks its media box or resources"))?;
        }
    }
    Ok(())
}

/// Whether `len` written bytes at `start` have the length of the `source_len`
/// bytes at `origin` of `source` they were written from, and the same first and
/// last bytes.
fn same_ends<O: ByteSource, S: ByteSource + ?Sized>(
    output: &O,
    start: u64,
    len: u64,
    source: &S,
    origin: u64,
    source_len: u64,
) -> io::Result<bool> {
    if len != source_len {
        return Ok(false);
    }
    let sample = len.min(STREAM_SAMPLE_BYTES);
    for at in [0, len - sample] {
        let (mut written, mut wanted) = (vec![0; sample as usize], vec![0; sample as usize]);
        output.read_at(start + at, &mut written)?;
        source.read_at(origin + at, &mut wanted)?;
        if written != wanted {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Every reference a direct object holds, without following any.
/// Refuses a page edit on a damaged page tree. Only the tree is read through
/// the index: the catalog, each node and leaf, and the kids and counts they
/// reference, never content or other objects, so the cost follows the page
/// tree and not the file.
#[cfg(test)]
pub(crate) fn validate_page_tree_source<S: ByteSource>(bytes: S, len: u64) -> Result<()> {
    let reader = Reader::new(&bytes, len)?;
    let index = reader.index()?;
    if index.trailer.has(b"Encrypt") {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            "Unlock the encrypted PDF before editing it",
        ));
    }
    let mut document = Document::with_version(reader.version.clone());
    document.trailer = index.trailer.clone();
    let mut loader = Loader::new(&reader, &index);
    let mut pending = Vec::new();
    collect_object_references(document.trailer.get(b"Root")?, &mut pending);
    while let Some(id) = pending.pop() {
        if document.objects.contains_key(&id) {
            continue;
        }
        if document.objects.len() >= MAX_PDF_OBJECTS {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("PDF page tree exceeds the {MAX_PDF_OBJECTS}-object admission ceiling"),
            ));
        }
        let object = loader.load(id)?;
        match &object {
            Object::Dictionary(node) => [b"Pages".as_slice(), b"Kids", b"Count"]
                .into_iter()
                .filter_map(|key| node.get(key).ok())
                .for_each(|value| collect_object_references(value, &mut pending)),
            // An indirect /Kids array.
            Object::Array(_) | Object::Reference(_) => {
                collect_object_references(&object, &mut pending)
            }
            _ => {}
        }
        document.objects.insert(id, object);
    }
    PageTreeResolver::validated(&document).map(|_| ())
}

const PAGE_GEOMETRY_KEYS: &[&[u8]] = &[
    b"Pages",
    b"Kids",
    b"Count",
    b"Parent",
    b"MediaBox",
    b"CropBox",
    b"Rotate",
    b"UserUnit",
];

const SHALLOW_ANNOTATION_KEYS: &[&[u8]] = &[b"Subtype", b"NM", b"EVBShapeKey", b"Rect", b"F"];

fn index_has_object(index: &XrefIndex, id: ObjectId) -> bool {
    matches!(
        index.entry(id.0),
        Some(XrefEntry::Offset { generation, .. }) if generation == id.1
    ) || matches!(
        index.entry(id.0),
        Some(XrefEntry::InStream { .. }) if id.1 == 0
    )
}

/// Whether the catalog's `/Pages` entry is indexed in `index` (or a direct
/// non-reference value inside a readable catalog), distinguishing page-tree
/// damage (`invalid-request`) from missing/unindexed roots (`corrupt-xref`).
fn has_indexed_pages_entry(document: &Document, index: &XrefIndex) -> bool {
    document
        .catalog()
        .ok()
        .and_then(|catalog| catalog.get(b"Pages").ok())
        .is_some_and(|pages| match pages {
            Object::Reference(id) => index_has_object(index, *id),
            // A non-reference /Pages value inside a readable catalog is page-tree damage.
            _ => true,
        })
}

fn classify_page_tree_error(has_indexed_pages: bool, error: Box<dyn Error>) -> Box<dyn Error> {
    if error.downcast_ref::<NativeError>().is_some() {
        return error;
    }
    if has_indexed_pages {
        page_tree_damaged(error)
    } else {
        corrupt(format!("PDF has no pages: {error}"))
    }
}

fn open_append_base_index<'a, S: ByteSource>(
    bytes: &'a S,
    len: u64,
) -> Result<(Reader<'a, S>, XrefIndex)> {
    let reader = Reader::new(bytes, len)?;
    if reader.base != 0 {
        return Err(corrupt("PDF has bytes before its header"));
    }
    let index = reader.index_at(reader.qpdf_start()?)?;
    if index.trailer.has(b"Encrypt") {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            "Unlock the encrypted PDF before editing it",
        ));
    }
    Ok((reader, index))
}

struct TargetedParts {
    document: Document,
    streams: HashMap<ObjectId, (u64, u64)>,
    reals: HashMap<ObjectId, RealSpellings>,
    xref_start: u64,
    xref_budget: IndexedXrefBudget,
}

struct TargetedLoader<'r, 'a, S: ?Sized> {
    loader: Loader<'r, 'a, S>,
    index: &'r XrefIndex,
    document: Document,
    deep_loaded: HashSet<ObjectId>,
}

impl<'r, 'a, S: ByteSource + ?Sized> TargetedLoader<'r, 'a, S> {
    fn new(reader: &'r Reader<'a, S>, index: &'r XrefIndex) -> Self {
        let mut document = Document::with_version(reader.version.clone());
        document.max_id = index.max_number;
        document.reference_table = Xref::new(document.max_id.saturating_add(1), index.xref_type);
        document.trailer = index.trailer.clone();
        Self {
            loader: Loader::new(reader, index),
            index,
            document,
            deep_loaded: HashSet::new(),
        }
    }

    fn into_parts(self) -> TargetedParts {
        let mut xref_budget = self.index.budget;
        xref_budget.values = self.loader.values;
        TargetedParts {
            document: self.document,
            streams: self.loader.streams,
            reals: self.loader.reals,
            xref_start: self.index.start,
            xref_budget,
        }
    }

    fn ensure_object(&mut self, id: ObjectId) -> Result<()> {
        if self.document.objects.contains_key(&id) {
            return Ok(());
        }
        if self.document.objects.len() >= MAX_PDF_OBJECTS {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("PDF exceeds the {MAX_PDF_OBJECTS}-object admission ceiling"),
            ));
        }
        let object = self.loader.load(id)?;
        self.document.objects.insert(id, object);
        Ok(())
    }

    /// Follows indirect references on `value` (loading each hopped object into
    /// `self.document`) up to the reference limit and returns the resolved clone.
    fn ensure_resolved_object(&mut self, mut value: Object) -> Result<Object> {
        for _ in 0..128 {
            let Ok(id) = value.as_reference() else {
                return Ok(value);
            };
            self.ensure_object(id)?;
            value = self
                .document
                .objects
                .get(&id)
                .cloned()
                .ok_or_else(|| format!("Object {}R{} was not found", id.0, id.1))?;
        }
        Err("PDF reference chain exceeded the dereference limit".into())
    }

    /// Follows indirect reference chains starting at `id`, loading each hopped
    /// object into `self.document`, and returns the final object ID.
    fn resolve_object_id(&mut self, mut id: ObjectId) -> Result<ObjectId> {
        let mut hops = HashSet::new();
        for _ in 0..128 {
            if !hops.insert(id) {
                return Ok(id);
            }
            self.ensure_object(id)?;
            match self.document.objects.get(&id) {
                Some(Object::Reference(next_id)) => id = *next_id,
                _ => return Ok(id),
            }
        }
        Ok(id)
    }

    fn resolve_dict_at(&mut self, id: ObjectId) -> Result<Dictionary> {
        let resolved = self.ensure_resolved_object(Object::Reference(id))?;
        resolved.as_dict().cloned().map_err(|error| {
            format!("PDF object {}R{} is not a dictionary: {error}", id.0, id.1).into()
        })
    }

    /// Loads indirect targets of `keys` on `dict_id`, recursively loading
    /// indirect `Array` / `Reference` containers (for indirect `/Kids`,
    /// `/MediaBox`, `/CropBox`, `/Rotate`, `/UserUnit`, `/NM`, etc.) without
    /// descending into unrelated dictionaries.
    fn load_direct_keys(&mut self, dict_id: ObjectId, keys: &[&[u8]]) -> Result<()> {
        self.ensure_object(dict_id)?;
        let mut pending = Vec::new();
        if let Some(Object::Dictionary(dict)) = self.document.objects.get(&dict_id) {
            for &key in keys {
                if let Ok(value) = dict.get(key) {
                    collect_object_references(value, &mut pending);
                }
            }
        }
        let mut seen = HashSet::new();
        while let Some(id) = pending.pop() {
            if !seen.insert(id) {
                continue;
            }
            self.ensure_object(id)?;
            if let Some(object) = self.document.objects.get(&id) {
                if matches!(object, Object::Array(_) | Object::Reference(_)) {
                    collect_object_references(object, &mut pending);
                }
            }
        }
        Ok(())
    }

    /// Loads catalog + every `/Pages` and `/Page` node in the page tree, and
    /// optionally their inherited geometry keys. Never follows `/Contents`,
    /// `/Resources`, `/Annots`, `/StructTreeRoot`, or `/Outlines`.
    fn load_page_tree_all(&mut self, with_geometry: bool) -> Result<()> {
        let keys: &[&[u8]] = if with_geometry {
            PAGE_GEOMETRY_KEYS
        } else {
            &[b"Pages", b"Kids", b"Count"]
        };
        let mut pending = Vec::new();
        if let Ok(root) = self.document.trailer.get(b"Root") {
            collect_object_references(root, &mut pending);
        }
        let mut visited = HashSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id) {
                continue;
            }
            self.ensure_object(id)?;
            if let Some(object) = self.document.objects.get(&id) {
                match object {
                    Object::Dictionary(node) => {
                        for &key in keys {
                            if let Ok(value) = node.get(key) {
                                collect_object_references(value, &mut pending);
                            }
                        }
                    }
                    Object::Array(_) | Object::Reference(_) => {
                        collect_object_references(object, &mut pending);
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }

    fn validate_full_page_tree(&self) -> Result<PageTreeResolver> {
        let has_indexed_pages = has_indexed_pages_entry(&self.document, self.index);
        if !has_indexed_pages {
            return Err(corrupt("PDF has no pages"));
        }
        let resolver = PageTreeResolver::validated(&self.document)
            .map_err(|error| classify_page_tree_error(true, error))?;
        if resolver.page_count() == 0 {
            return Err(page_tree_damaged("it lists no pages".into()));
        }
        if resolver.page_count() as usize > MAX_PATH_INPUT_PDF_PAGES {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("PDF page count exceeds the {MAX_PATH_INPUT_PDF_PAGES}-page ceiling"),
            ));
        }
        Ok(resolver)
    }

    fn validate_page_tree_ends(&self) -> Result<(PageTreeResolver, BTreeMap<u32, ObjectId>)> {
        let has_indexed_pages = has_indexed_pages_entry(&self.document, self.index);
        let resolver = PageTreeResolver::with_both_ends(&self.document)
            .map_err(|error| classify_page_tree_error(has_indexed_pages, error))?;
        if resolver.page_count() == 0 {
            return Err(if has_indexed_pages {
                page_tree_damaged("it lists no pages".into())
            } else {
                corrupt("PDF has no pages")
            });
        }
        if resolver.page_count() as usize > MAX_PATH_INPUT_PDF_PAGES {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("PDF page count exceeds the {MAX_PATH_INPUT_PDF_PAGES}-page ceiling"),
            ));
        }
        let actual_pages =
            collect_document_pages_bounded(&self.document, Some(MAX_PATH_INPUT_PDF_PAGES))?;
        if actual_pages.is_empty() {
            return Err(if has_indexed_pages {
                page_tree_damaged("it lists no pages".into())
            } else {
                corrupt("PDF has no pages")
            });
        }
        Ok((resolver, actual_pages))
    }

    /// Recursively loads every object reachable from `seeds`, stopping at
    /// `/Page`, `/Pages`, and `/Catalog` dictionaries so page-local subgraphs
    /// never pull in unrelated pages or document-wide structures.
    fn load_subgraph_stopping_at_pages(
        &mut self,
        seeds: impl IntoIterator<Item = ObjectId>,
    ) -> Result<()> {
        let mut pending: Vec<ObjectId> = seeds.into_iter().collect();
        while let Some(id) = pending.pop() {
            if !self.deep_loaded.insert(id) {
                continue;
            }
            self.ensure_object(id)?;
            if let Some(object) = self.document.objects.get(&id) {
                if let Object::Dictionary(dict) = object {
                    if matches!(
                        dict.get(b"Type").and_then(Object::as_name),
                        Ok(b"Page" | b"Pages" | b"Catalog")
                    ) {
                        continue;
                    }
                }
                collect_object_references(object, &mut pending);
            }
        }
        Ok(())
    }

    /// Loads `/Contents`, `/Resources` (including inherited `/Resources` on
    /// ancestor `/Pages` nodes, following indirect `/Parent` aliases), and the
    /// `/Annots` array container (without loading the annotation dictionaries
    /// themselves) for `page_id`.
    fn load_page_contents_and_resources(&mut self, page_id: ObjectId) -> Result<()> {
        let resolved_page_id = self.resolve_object_id(page_id)?;
        let mut seeds = Vec::new();
        let mut annots_obj = None;
        if let Some(Object::Dictionary(page)) = self.document.objects.get(&resolved_page_id) {
            if let Ok(contents) = page.get(b"Contents") {
                collect_object_references(contents, &mut seeds);
            }
            if let Ok(annots) = page.get(b"Annots") {
                annots_obj = Some(annots.clone());
            }
        }
        if let Some(annots_obj) = annots_obj {
            // `prepare_overlay_page` dereferences `/Annots` to copy the array container;
            // resolve only the array indirection without loading annotation dictionaries.
            let _ = self.ensure_resolved_object(annots_obj)?;
        }
        let mut current = Some(resolved_page_id);
        let mut seen = HashSet::new();
        while let Some(id) = current {
            if !seen.insert(id) {
                break;
            }
            let resolved_id = self.resolve_object_id(id)?;
            if resolved_id != id && !seen.insert(resolved_id) {
                break;
            }
            if let Some(Object::Dictionary(dict)) = self.document.objects.get(&resolved_id) {
                if let Ok(resources) = dict.get(b"Resources") {
                    collect_object_references(resources, &mut seeds);
                }
                current = dict
                    .get(b"Parent")
                    .ok()
                    .and_then(|value| value.as_reference().ok());
            } else {
                break;
            }
        }
        self.load_subgraph_stopping_at_pages(seeds)
    }

    /// Returns `true` when `page_id` carries an `/Annots` entry whose resolved
    /// value is non-empty (or malformed/non-array).
    fn page_has_non_empty_annots(&mut self, page_id: ObjectId) -> Result<bool> {
        let resolved_page_id = self.resolve_object_id(page_id)?;
        let annots_obj = self
            .document
            .objects
            .get(&resolved_page_id)
            .and_then(|object| object.as_dict().ok())
            .and_then(|dict| dict.get(b"Annots").ok())
            .cloned();
        let Some(annots_obj) = annots_obj else {
            return Ok(false);
        };
        let resolved = self.ensure_resolved_object(annots_obj)?;
        Ok(!matches!(resolved, Object::Array(items) if items.is_empty()))
    }

    /// Loads a page's `/Annots` array and shallow dictionaries for every
    /// annotation listed there (plus `/IRT`, `/Popup`, `/Parent` thread links
    /// and indirect identity keys), without following `/AP` appearance streams
    /// or resources on untouched pages.
    fn load_shallow_page_annotations(
        &mut self,
        page_id: ObjectId,
        shallow_seen: &mut HashSet<ObjectId>,
    ) -> Result<Vec<ObjectId>> {
        let resolved_page_id = self.resolve_object_id(page_id)?;
        let annots_obj = self
            .document
            .objects
            .get(&resolved_page_id)
            .and_then(|object| object.as_dict().ok())
            .and_then(|dict| dict.get(b"Annots").ok())
            .cloned();
        let Some(annots_obj) = annots_obj else {
            return Ok(Vec::new());
        };
        let resolved = self.ensure_resolved_object(annots_obj)?;
        let Object::Array(items) = resolved else {
            return Ok(Vec::new());
        };
        let listed: Vec<ObjectId> = items
            .iter()
            .filter_map(|item| item.as_reference().ok())
            .collect();
        let mut pending = listed.clone();
        while let Some(id) = pending.pop() {
            if !shallow_seen.insert(id) {
                continue;
            }
            let resolved_id = self.resolve_object_id(id)?;
            if resolved_id != id && !shallow_seen.insert(resolved_id) {
                continue;
            }
            if let Some(Object::Dictionary(dict)) = self.document.objects.get(&resolved_id) {
                if matches!(
                    dict.get(b"Type").and_then(Object::as_name),
                    Ok(b"Page" | b"Pages" | b"Catalog")
                ) {
                    continue;
                }
                for key in [b"IRT".as_slice(), b"Popup", b"Parent"] {
                    if let Some(related) = annotation_related_ref(dict, key) {
                        pending.push(related);
                    }
                }
            }
            self.load_direct_keys(resolved_id, SHALLOW_ANNOTATION_KEYS)?;
        }
        Ok(listed)
    }

    fn load_page_labels_continuation(&mut self) -> Result<()> {
        let labels_ref = self
            .document
            .catalog()
            .ok()
            .and_then(|catalog| catalog.get(b"PageLabels").ok())
            .and_then(|value| value.as_reference().ok());
        if let Some(id) = labels_ref {
            self.load_subgraph_stopping_at_pages([id])?;
        }
        Ok(())
    }

    fn load_outlines_continuation_path(&mut self, bookmark_path: &[u32]) -> Result<()> {
        let Some(outlines_id) = self
            .document
            .catalog()
            .ok()
            .and_then(|catalog| catalog.get(b"Outlines").ok())
            .and_then(|value| value.as_reference().ok())
        else {
            return Ok(());
        };
        let Ok(mut parent_dict) = self.resolve_dict_at(outlines_id) else {
            return Ok(());
        };
        let mut seen = HashSet::from([outlines_id]);
        for &index in bookmark_path {
            let Ok(first_id) = parent_dict.get(b"First").and_then(Object::as_reference) else {
                return Ok(());
            };
            let mut current_id = first_id;
            for _ in 0..index {
                if !seen.insert(current_id) || seen.len() >= CATALOG_WALK_NODE_LIMIT {
                    return Ok(());
                }
                let dict = match self.resolve_dict_at(current_id) {
                    Ok(dict) => dict,
                    Err(error) if error.downcast_ref::<NativeError>().is_some() => {
                        return Err(error)
                    }
                    Err(_) => return Ok(()),
                };
                let Ok(next_id) = dict.get(b"Next").and_then(Object::as_reference) else {
                    return Ok(());
                };
                current_id = next_id;
            }
            parent_dict = match self.resolve_dict_at(current_id) {
                Ok(dict) => dict,
                Err(error) if error.downcast_ref::<NativeError>().is_some() => return Err(error),
                Err(_) => return Ok(()),
            };
        }
        if let Ok(last_id) = parent_dict.get(b"Last").and_then(Object::as_reference) {
            self.ensure_object(last_id)?;
        }
        Ok(())
    }

    /// Finishes loading all remaining reachable objects from the trailer and
    /// `named` (used for Tier 3 escalation when an existing placed-image stamp
    /// requires global exclusivity proof).
    fn load_remaining_reachable(&mut self, named: &[ObjectId]) -> Result<()> {
        let mut pending = Vec::new();
        collect_references(&self.document.trailer, &mut pending);
        for &id in named {
            if index_has_object(self.index, id) {
                pending.push(id);
            }
        }
        let mut visited = HashSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id) {
                continue;
            }
            self.ensure_object(id)?;
            if let Some(object) = self.document.objects.get(&id) {
                collect_object_references(object, &mut pending);
            }
        }
        Ok(())
    }

    fn load_for_mutations(
        &mut self,
        mutations: &NativeMutationsFile,
    ) -> Result<Option<LocatedPages>> {
        // 1. Load catalog, full page tree, and inherited geometry keys without
        //    touching page /Contents, /Resources, /Annots, /StructTreeRoot, or
        //    /Outlines. Loading every page-tree node also ensures corrupt leaf
        //    page objects are refused before writing and gives exact leaf counts.
        self.load_page_tree_all(true)?;

        let plan = MutationLoadPlan::from_mutations(mutations);
        let (resolver, actual_pages) = if plan.validate_page_tree {
            (self.validate_full_page_tree()?, None)
        } else {
            let (resolver, pages) = self.validate_page_tree_ends()?;
            (resolver, Some(pages))
        };

        if plan.needs_page_labels_continuation {
            self.load_page_labels_continuation()?;
        }
        if let Some(path) = plan.bookmarks_continuation_path {
            self.load_outlines_continuation_path(path)?;
        }

        let mut touched_located_ids = BTreeMap::new();
        let mut touched_page_ids = HashSet::new();
        for &page_index in &plan.touched_pages {
            if let Some(page_number) = page_index.checked_add(1) {
                if let Ok(page_id) = resolver.page_id(&self.document, page_number) {
                    let resolved_page_id = self.resolve_object_id(page_id)?;
                    touched_located_ids.insert(page_index, page_id);
                    touched_page_ids.insert(page_id);
                    touched_page_ids.insert(resolved_page_id);
                }
            }
        }

        // 2. Clean-page fast path: catalog-only saves, geometry-only saves on
        //    unannotated pages, and clean-page additive annotation saves never
        //    need to parse `/Annots` on untouched pages.
        if plan.can_skip_untouched_annots
            && !plan.has_bookmark_raw_refs
            && touched_located_ids.len() == plan.touched_pages.len()
        {
            let all_clean = if plan.catalog_only {
                true
            } else {
                let mut clean = true;
                for &page_id in &touched_page_ids {
                    if self.page_has_non_empty_annots(page_id)? {
                        clean = false;
                        break;
                    }
                }
                clean
            };
            if all_clean {
                return Ok(Some(LocatedPages {
                    count: resolver.page_count(),
                    ids: touched_located_ids,
                }));
            }
        }

        // 3. Targeted annotation graph: shallow annotation ownership across all
        //    unique leaf pages (for cross-page /IRT /Popup /Parent threads and
        //    stable-key resolution) plus full subgraphs of touched/reachable
        //    addressed annotations and named recovery images (skipping page
        //    /Contents, /Resources, /StructTreeRoot, and untouched appearance
        //    streams).
        let mut seen_pages = HashSet::new();
        let mut all_page_ids = Vec::new();
        if let Some(validated) = resolver.validated_pages() {
            for &page_id in validated {
                if seen_pages.insert(page_id) {
                    all_page_ids.push(page_id);
                }
            }
        } else if let Some(pages) = actual_pages {
            for page_id in pages.into_values() {
                if seen_pages.insert(page_id) {
                    all_page_ids.push(page_id);
                }
            }
        }

        let mut shallow_seen = HashSet::new();
        let mut deep_seeds = Vec::new();
        for page_id in all_page_ids {
            let listed = self.load_shallow_page_annotations(page_id, &mut shallow_seen)?;
            if touched_page_ids.contains(&page_id) {
                deep_seeds.extend(listed);
            }
        }
        // Only deep-load addressed annotations that are actually reachable from
        // the document's page /Annots graph (never revive unlinked orphans).
        for &id in &plan.addressed_annotations {
            if shallow_seen.contains(&id) {
                deep_seeds.push(id);
            }
        }
        for &id in &plan.restored_images {
            if index_has_object(self.index, id) {
                deep_seeds.push(id);
            }
        }
        self.load_subgraph_stopping_at_pages(deep_seeds)?;

        // 4. Placed-image exclusivity escalation: if an existing placed-image
        //    stamp is being edited in place, `private_placed_image_refs` proves
        //    exclusivity across the whole catalog graph; finish loading
        //    remaining reachable objects using the same already-opened reader
        //    and loader.
        if has_existing_placed_image_target(&self.document, &resolver, mutations) {
            self.load_remaining_reachable(&plan.restored_images)?;
        }

        Ok(None)
    }
}

struct MutationLoadPlan<'a> {
    validate_page_tree: bool,
    catalog_only: bool,
    can_skip_untouched_annots: bool,
    has_bookmark_raw_refs: bool,
    needs_page_labels_continuation: bool,
    bookmarks_continuation_path: Option<&'a [u32]>,
    touched_pages: std::collections::BTreeSet<u32>,
    addressed_annotations: Vec<ObjectId>,
    restored_images: Vec<ObjectId>,
}

impl<'a> MutationLoadPlan<'a> {
    fn from_mutations(mutations: &'a NativeMutationsFile) -> Self {
        let validate_page_tree = !mutations.page_rotations.is_empty()
            || !mutations.page_crops.is_empty()
            || !mutations.page_crop_removals.is_empty();
        let has_annotation_mutations = !mutations.updates.is_empty()
            || !mutations.geometry_updates.is_empty()
            || !mutations.notes.is_empty()
            || !mutations.free_text_notes.is_empty()
            || !mutations.text_boxes.is_empty()
            || !mutations.deletes.is_empty()
            || mutations.shapes.is_some()
            || mutations.markup.is_some()
            || !mutations.placed_images.is_empty()
            || !mutations.placed_image_geometry_updates.is_empty();
        let geometry_or_catalog_only = !has_annotation_mutations;
        let catalog_only = geometry_or_catalog_only && !validate_page_tree;

        let mut touched_pages = std::collections::BTreeSet::new();
        let mut addressed_annotations = Vec::new();
        let mut restored_images = Vec::new();

        for update in &mutations.updates {
            addressed_annotations.push((update.object_number, update.generation_number));
        }
        for update in &mutations.geometry_updates {
            touched_pages.insert(update.page_index);
            addressed_annotations.push((update.object_number, update.generation_number));
        }
        let mut has_note_recovery = false;
        for note in mutations
            .notes
            .iter()
            .chain(mutations.free_text_notes.iter())
        {
            touched_pages.insert(note.page_index);
            if note.recovery_data.is_some() {
                has_note_recovery = true;
            }
        }
        for editor in &mutations.text_boxes {
            touched_pages.insert(editor.page_index);
            if let Some(id) = editor
                .annotation_id
                .as_deref()
                .and_then(parse_pdfjs_annotation_object_id)
            {
                addressed_annotations.push(id);
            }
        }
        for delete in &mutations.deletes {
            touched_pages.insert(delete.page_index);
            if let (Some(num), Some(gen)) = (delete.object_number, delete.generation_number) {
                addressed_annotations.push((num, gen));
            }
        }
        for rotation in &mutations.page_rotations {
            touched_pages.insert(rotation.page_index);
        }
        for crop in &mutations.page_crops {
            touched_pages.insert(crop.page_index);
        }
        for &page_index in &mutations.page_crop_removals {
            touched_pages.insert(page_index);
        }
        let mut has_bookmark_raw_refs = false;
        if let Some(bookmarks) = &mutations.bookmarks {
            collect_bookmark_load_targets(
                &bookmarks.items,
                &mut touched_pages,
                &mut has_bookmark_raw_refs,
            );
        }
        let mut has_shape_deletes = false;
        if let Some(shapes) = &mutations.shapes {
            if !shapes.deleted_annotation_ids.is_empty() || !shapes.deleted_stable_keys.is_empty() {
                has_shape_deletes = true;
            }
            for shape in &shapes.shapes {
                touched_pages.insert(shape.page_index);
                if let Some(id) = shape
                    .annotation_id
                    .as_deref()
                    .and_then(parse_pdfjs_annotation_object_id)
                {
                    addressed_annotations.push(id);
                }
            }
            for id_str in &shapes.deleted_annotation_ids {
                if let Some(id) = parse_pdfjs_annotation_object_id(id_str) {
                    addressed_annotations.push(id);
                }
            }
        }
        if let Some(markup) = &mutations.markup {
            for hint in &markup.hints {
                touched_pages.insert(hint.page_index);
                if let Some(id) = hint
                    .annotation_id
                    .as_deref()
                    .and_then(parse_pdfjs_annotation_object_id)
                {
                    addressed_annotations.push(id);
                }
            }
        }
        for image in &mutations.placed_images {
            touched_pages.insert(image.page_index);
            if let Some(id) = image
                .annotation_id
                .as_deref()
                .and_then(parse_pdfjs_annotation_object_id)
            {
                addressed_annotations.push(id);
            }
        }
        for update in &mutations.placed_image_geometry_updates {
            touched_pages.insert(update.page_index);
            if let Some(id) = update
                .annotation_id
                .as_deref()
                .and_then(parse_pdfjs_annotation_object_id)
            {
                addressed_annotations.push(id);
            }
            if let Some(source) = &update.source_image {
                if let (Ok(num), Ok(gen)) = (
                    u32::try_from(source.object_number),
                    u16::try_from(source.generation_number),
                ) {
                    restored_images.push((num, gen));
                }
            }
        }

        let needs_page_labels_continuation = mutations.page_labels.is_some()
            && mutations.continuation.as_ref().is_some_and(|continuation| {
                continuation.family == NativeMutationContinuationFamily::PageLabels
            });
        let bookmarks_continuation_path = mutations
            .bookmarks
            .as_ref()
            .and(mutations.continuation.as_ref())
            .filter(|continuation| {
                continuation.family == NativeMutationContinuationFamily::Bookmarks
            })
            .map(|continuation| continuation.bookmark_path.as_slice());

        let can_skip_untouched_annots = geometry_or_catalog_only
            || (mutations.updates.is_empty()
                && mutations.geometry_updates.is_empty()
                && mutations.deletes.is_empty()
                && addressed_annotations.is_empty()
                && mutations.placed_image_geometry_updates.is_empty()
                && !has_note_recovery
                && !has_shape_deletes);

        Self {
            validate_page_tree,
            catalog_only,
            can_skip_untouched_annots,
            has_bookmark_raw_refs,
            needs_page_labels_continuation,
            bookmarks_continuation_path,
            touched_pages,
            addressed_annotations,
            restored_images,
        }
    }
}

fn collect_bookmark_load_targets(
    items: &[BookmarkEntry],
    touched_pages: &mut std::collections::BTreeSet<u32>,
    has_raw_refs: &mut bool,
) {
    use evb_native_support::pdf_catalog::BookmarkSourceTarget;
    for item in items {
        if let Some(index) = item.page_index {
            touched_pages.insert(index);
        }
        if let Some(original) = &item.original_destination {
            match original.source_target {
                BookmarkSourceTarget::PageIndex(index) => {
                    touched_pages.insert(index);
                }
                BookmarkSourceTarget::Reference { .. }
                    if item.page_index.is_none()
                        && item
                            .named_dest
                            .as_deref()
                            .is_none_or(|name| name.trim().is_empty()) =>
                {
                    *has_raw_refs = true;
                }
                BookmarkSourceTarget::Reference { .. } => {}
            }
        }
        collect_bookmark_load_targets(&item.items, touched_pages, has_raw_refs);
    }
}

fn has_existing_placed_image_target(
    document: &Document,
    resolver: &PageTreeResolver,
    mutations: &NativeMutationsFile,
) -> bool {
    if mutations.placed_images.is_empty() && mutations.placed_image_geometry_updates.is_empty() {
        return false;
    }
    let chunk_index = placed_image_chunk_index(mutations);
    for (index, image) in mutations.placed_images.iter().enumerate() {
        let Ok(page_number) = mutation_page_number(image.page_index) else {
            continue;
        };
        let Ok(page_id) = resolver.page_id(document, page_number) else {
            continue;
        };
        if image.stable_key.is_none() && image.annotation_id.is_none() {
            if get_page_annots(document, page_id)
                .ok()
                .is_some_and(|annots| {
                    annots.iter().any(|item| {
                        item.as_reference()
                            .ok()
                            .and_then(|id| document.dictionary(id).ok())
                            .is_some_and(|dict| annotation_subtype(dict) == "stamp")
                    })
                })
            {
                return true;
            }
            continue;
        }
        let expected_name = placed_image_annotation_name(image, index, chunk_index, "");
        if matches!(
            resolve_placed_image_target(document, page_id, image, &expected_name),
            Ok(Some(_))
        ) {
            return true;
        }
    }
    for update in &mutations.placed_image_geometry_updates {
        let Ok(page_number) = mutation_page_number(update.page_index) else {
            continue;
        };
        let Ok(page_id) = resolver.page_id(document, page_number) else {
            continue;
        };
        let probe = placed_image_geometry_probe(update);
        let expected_name = update.stable_key.as_deref().unwrap_or_default();
        if matches!(
            resolve_placed_image_target(document, page_id, &probe, expected_name),
            Ok(Some(_))
        ) {
            return true;
        }
    }
    false
}

/// Walks the document's `/Catalog /Pages` tree in order without lopdf's
/// `objects.len()` traversal cap, returning 1-based page numbers mapped to leaf
/// `/Page` object IDs. Memoizes zero-leaf `/Pages` branches and bounds internal
/// node visits so shared-branch DAGs cannot stall traversal; when `max_pages`
/// is `Some(limit)`, stops immediately with `NativeErrorCode::TooLarge` as soon
/// as the tree exceeds `limit` leaves.
pub(crate) fn collect_document_pages_bounded(
    document: &Document,
    max_pages: Option<usize>,
) -> Result<BTreeMap<u32, ObjectId>> {
    enum Frame {
        Enter {
            object: Object,
            depth: usize,
        },
        Leave {
            node_id: ObjectId,
            leaves_before: u32,
        },
    }

    let Ok(catalog) = document.catalog() else {
        return Ok(BTreeMap::new());
    };
    let Ok(pages_root) = catalog.get(b"Pages") else {
        return Ok(BTreeMap::new());
    };

    let mut pages = BTreeMap::new();
    let mut active_ancestors = HashSet::new();
    let mut zero_leaf_nodes = HashSet::new();
    let max_internal_visits = max_pages
        .map(|limit| limit.saturating_mul(2).max(16_384))
        .unwrap_or(MAX_PDF_OBJECTS);
    let mut visited_internal = 0usize;
    let mut stack = vec![Frame::Enter {
        object: pages_root.clone(),
        depth: 0,
    }];
    let mut page_number = 0u32;

    while let Some(frame) = stack.pop() {
        match frame {
            Frame::Leave {
                node_id,
                leaves_before,
            } => {
                active_ancestors.remove(&node_id);
                if page_number == leaves_before {
                    zero_leaf_nodes.insert(node_id);
                }
            }
            Frame::Enter { object, depth } => {
                if depth >= 256 {
                    continue;
                }
                let Ok((resolved_id, resolved)) = document.dereference(&object) else {
                    continue;
                };
                let Ok(dict) = resolved.as_dict() else {
                    continue;
                };
                let type_name = dict
                    .get(b"Type")
                    .ok()
                    .and_then(|value| document.dereference(value).ok())
                    .and_then(|(_, value)| value.as_name().ok());
                match type_name {
                    Some(b"Page") => {
                        let Some(page_id) = resolved_id else {
                            continue;
                        };
                        let Some(next_number) = page_number.checked_add(1) else {
                            return Err(domain_error(
                                NativeErrorCode::TooLarge,
                                "PDF page count exceeds the supported integer range",
                            ));
                        };
                        if let Some(limit) = max_pages {
                            if next_number as usize > limit {
                                return Err(domain_error(
                                    NativeErrorCode::TooLarge,
                                    format!("PDF page count exceeds the {limit}-page ceiling"),
                                ));
                            }
                        }
                        page_number = next_number;
                        pages.insert(page_number, page_id);
                    }
                    Some(b"Pages") => {
                        if let Some(node_id) = resolved_id {
                            if zero_leaf_nodes.contains(&node_id)
                                || !active_ancestors.insert(node_id)
                            {
                                continue;
                            }
                            stack.push(Frame::Leave {
                                node_id,
                                leaves_before: page_number,
                            });
                        }
                        visited_internal = visited_internal.saturating_add(1);
                        if visited_internal > max_internal_visits {
                            return Err(domain_error(
                                NativeErrorCode::TooLarge,
                                "PDF page tree exceeds the internal node traversal ceiling",
                            ));
                        }
                        let Ok(kids_obj) = dict.get(b"Kids") else {
                            continue;
                        };
                        let Ok((_, kids_resolved)) = document.dereference(kids_obj) else {
                            continue;
                        };
                        let Ok(kids) = kids_resolved.as_array() else {
                            continue;
                        };
                        for kid in kids.iter().rev() {
                            stack.push(Frame::Enter {
                                object: kid.clone(),
                                depth: depth + 1,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(pages)
}

pub(crate) fn collect_document_pages(document: &Document) -> BTreeMap<u32, ObjectId> {
    collect_document_pages_bounded(document, Some(MAX_PATH_INPUT_PDF_PAGES))
        .unwrap_or_else(|_| document.get_pages())
}

/// Loads only the catalog, page-tree nodes, leaf page dictionaries, and the
/// indirect values their geometry attributes reference, never touching content
/// streams, fonts, XObjects, annotations, or outlines. Refuses encrypted PDFs
/// from the cross-reference index and checks both ends of the page tree.
pub(crate) fn load_page_geometry_source<S: ByteSource>(bytes: S, len: u64) -> Result<Document> {
    let reader = Reader::new(&bytes, len)?;
    let index = reader.index()?;
    if index.trailer.has(b"Encrypt") {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            "Encrypted PDFs are not supported by native page ops",
        ));
    }
    let mut target = TargetedLoader::new(&reader, &index);
    target.load_page_tree_all(true)?;
    // A page tree that lists no page, has an indexed wrong-type /Pages target,
    // or has broken ends is page-tree damage (`invalid-request`); a catalog or
    // /Pages root the cross-reference index cannot find is index damage (`corrupt-xref`).
    let has_indexed_pages = has_indexed_pages_entry(&target.document, &index);
    let resolver = PageTreeResolver::with_both_ends(&target.document)
        .map_err(|error| classify_page_tree_error(has_indexed_pages, error))?;
    if resolver.page_count() as usize > MAX_PATH_INPUT_PDF_PAGES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("PDF page count exceeds the {MAX_PATH_INPUT_PDF_PAGES}-page ceiling"),
        ));
    }
    Ok(target.document)
}

fn collect_object_references(object: &Object, pending: &mut Vec<ObjectId>) {
    match object {
        Object::Reference(id) => pending.push(*id),
        Object::Array(items) => {
            for item in items {
                collect_object_references(item, pending);
            }
        }
        Object::Dictionary(dictionary) => collect_references(dictionary, pending),
        Object::Stream(stream) => collect_references(&stream.dict, pending),
        _ => {}
    }
}

fn collect_references(dictionary: &Dictionary, pending: &mut Vec<ObjectId>) {
    for (_, value) in dictionary.iter() {
        collect_object_references(value, pending);
    }
}

#[derive(Clone, Copy)]
enum XrefEntry {
    Free,
    Offset {
        offset: u64,
        generation: u16,
    },
    /// Object stream `container`, as its member in header slot `index`.
    InStream {
        container: u32,
        index: u32,
    },
}

/// One cross-reference section's entries, its trailer and its form.
type XrefSection = (Vec<(u32, XrefEntry)>, Dictionary, XrefType);

struct XrefIndex {
    entries: HashMap<u32, XrefEntry>,
    /// The terminal `startxref` offset.
    start: u64,
    /// The highest object number any section lists, free ones included, so a
    /// new object never takes a freed number.
    max_number: u32,
    /// Ascending offsets of every object any revision wrote and of every
    /// cross-reference section, which bound each stream's data.
    offsets: Vec<u64>,
    trailer: Dictionary,
    xref_type: XrefType,
    budget: IndexedXrefBudget,
}

fn corrupt(message: impl Into<String>) -> Box<dyn Error> {
    domain_error(NativeErrorCode::CorruptXref, message)
}

struct Reader<'a, S: ?Sized> {
    bytes: &'a S,
    len: u64,
    /// Where `%PDF-` starts. Offsets count from it, as lopdf reads them.
    base: u64,
    version: String,
    strict: bool,
}

impl<'a, S: ByteSource + ?Sized> Reader<'a, S> {
    fn new(bytes: &'a S, len: u64) -> Result<Self> {
        let head = Self::read(bytes, len, 0, 1024)?;
        let base = find_bytes(&head, b"%PDF-").ok_or_else(|| corrupt("PDF header is missing"))?;
        let version = head[base + 5..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit() || **byte == b'.')
            .map(|byte| char::from(*byte))
            .collect::<String>();
        if version.is_empty() {
            return Err(corrupt("PDF header has no version"));
        }
        Ok(Self {
            bytes,
            len,
            base: base as u64,
            version,
            strict: false,
        })
    }

    fn read(bytes: &S, len: u64, offset: u64, max: usize) -> Result<Vec<u8>> {
        let available = len.saturating_sub(offset).min(max as u64) as usize;
        let mut buffer = vec![0; available];
        bytes
            .read_at(offset, &mut buffer)
            .map_err(io_domain_error)?;
        Ok(buffer)
    }

    /// Parses from `offset` (counted from the header) through a window that
    /// grows while the parse runs out of input.
    fn parse_at<T>(
        &self,
        offset: u64,
        mut parse: impl FnMut(&mut Cursor) -> ParseResult<T>,
    ) -> Result<T> {
        let start = self
            .base
            .checked_add(offset)
            .filter(|start| *start < self.len)
            .ok_or_else(|| corrupt(format!("PDF offset {offset} is outside the file")))?;
        let mut window = FIRST_WINDOW_BYTES;
        loop {
            let bytes = Self::read(self.bytes, self.len, start, window)?;
            let truncated = (bytes.len() as u64) < self.len - start;
            match parse(&mut Cursor {
                bytes: &bytes,
                strict: self.strict,
                ..Cursor::default()
            }) {
                Ok(value) => return Ok(value),
                Err(Incomplete) if truncated && window < MAX_OBJECT_BYTES => {
                    window = window.saturating_mul(8).min(MAX_OBJECT_BYTES);
                }
                Err(Incomplete) if truncated => {
                    return Err(domain_error(
                        NativeErrorCode::TooLarge,
                        format!(
                        "PDF object at offset {offset} exceeds the {MAX_OBJECT_BYTES}-byte ceiling"
                    ),
                    ))
                }
                Err(Crowded) => return Err(too_many_elements(format!("at offset {offset}"))),
                Err(TooManyObjects) => {
                    return Err(domain_error(
                        NativeErrorCode::TooLarge,
                        format!("PDF exceeds the {MAX_PDF_OBJECTS}-object admission ceiling"),
                    ))
                }
                Err(DuplicateKey(key)) => {
                    return Err(corrupt(format!(
                        "PDF object at offset {offset} has duplicate dictionary key /{key}"
                    )))
                }
                Err(_) => {
                    return Err(corrupt(format!(
                        "PDF object at offset {offset} is malformed"
                    )))
                }
            }
        }
    }

    /// The offset the last `startxref` in the file's tail names.
    fn terminal_start(&self) -> Result<u64> {
        let tail_start = self.len.saturating_sub(TAIL_BYTES as u64);
        let tail = Self::read(self.bytes, self.len, tail_start, TAIL_BYTES)?;
        let marker = find_last_bytes(&tail, b"startxref")
            .ok_or_else(|| corrupt("PDF startxref marker is missing"))?;
        parse_u64_token(&tail, marker + b"startxref".len())
            .map(|(offset, _)| offset)
            .ok_or_else(|| corrupt("PDF startxref value is invalid"))
    }

    /// The terminal startxref qpdf's locator finds, which an append extends:
    /// a base without one leaves no revision every reader takes as the last.
    fn qpdf_start(&self) -> Result<u64> {
        let tail_start = self.len.saturating_sub(QPDF_STARTXREF_SEARCH_BYTES);
        let tail = Self::read(
            self.bytes,
            self.len,
            tail_start,
            QPDF_STARTXREF_SEARCH_BYTES as usize,
        )?;
        qpdf_terminal_xref(&tail, tail_start, self.len)
            .ok_or_else(|| corrupt("PDF terminal startxref is not where qpdf reads it"))
    }

    fn index(&self) -> Result<XrefIndex> {
        self.index_at(self.terminal_start()?)
    }

    /// The cross-reference chain from the section at `start`, merged.
    fn index_at(&self, start: u64) -> Result<XrefIndex> {
        let mut next = start;
        let mut entries = HashMap::new();
        // The newest revision that names a document-level entry decides it.
        let mut trailer = Dictionary::new();
        let mut visited = HashSet::new();
        let mut xref_type = None;
        // Where every object any revision wrote, superseded and freed ones
        // included, and every section starts: a stream's data ends before
        // the next of them.
        let mut offsets = Vec::new();
        loop {
            if !visited.insert(next) || visited.len() > MAX_XREF_SECTIONS {
                return Err(corrupt("PDF cross-reference chain loops or is too long"));
            }
            let (section, section_trailer, kind) = self.xref_section(next)?;
            offsets.push(next);
            xref_type.get_or_insert(kind);
            // A hybrid file's table lists its compressed objects as free;
            // its XRefStm entries take precedence over those.
            let hybrid = match section_trailer.get(b"XRefStm").and_then(Object::as_i64) {
                Ok(stream) => {
                    let offset = u64::try_from(stream).map_err(|_| corrupt("Invalid /XRefStm"))?;
                    offsets.push(offset);
                    self.xref_section(offset)?.0
                }
                Err(_) => Vec::new(),
            };
            for (number, entry) in hybrid.into_iter().chain(section) {
                if let XrefEntry::Offset { offset, .. } = entry {
                    offsets.push(offset);
                }
                entries.entry(number).or_insert(entry);
            }
            if offsets.len() > MAX_SOURCE_VALUES {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    format!("PDF cross-references list more than {MAX_SOURCE_VALUES} entries"),
                ));
            }
            if entries.len() > MAX_PDF_OBJECTS {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    format!("PDF exceeds the {MAX_PDF_OBJECTS}-object admission ceiling"),
                ));
            }
            let previous = section_trailer.get(b"Prev").and_then(Object::as_i64).ok();
            for key in [b"Root".as_slice(), b"Info", b"Encrypt", b"ID"] {
                if !trailer.has(key) {
                    if let Ok(value) = section_trailer.get(key) {
                        trailer.set(key.to_vec(), value.clone());
                    }
                }
            }
            match previous {
                Some(previous) => {
                    next = u64::try_from(previous).map_err(|_| corrupt("Invalid /Prev"))?
                }
                None => break,
            }
        }
        if !trailer.has(b"Root") {
            return Err(corrupt("PDF trailer has no /Root"));
        }
        let budget = IndexedXrefBudget {
            sections: visited.len(),
            offsets: offsets.len(),
            entries: entries.len(),
            values: 0,
        };
        let max_number = entries.keys().copied().max().unwrap_or(0);
        entries.retain(|_, entry| !matches!(entry, XrefEntry::Free));
        offsets.sort_unstable();
        offsets.dedup();
        offsets.shrink_to_fit();
        Ok(XrefIndex {
            entries,
            start,
            max_number,
            offsets,
            trailer,
            xref_type: xref_type.unwrap_or(XrefType::CrossReferenceTable),
            budget,
        })
    }

    /// Visits each cross-reference revision's entries from `start` as
    /// `visit(revision, number, entry)`, newest revision first, numbering
    /// them from 0; a hybrid section's stream entries come before its
    /// table's. One revision's entries are dropped once visited. Returns
    /// where each section, `/XRefStm` ones included, starts.
    fn walk_revisions(
        &self,
        start: u64,
        mut visit: impl FnMut(usize, u32, XrefEntry),
    ) -> Result<Vec<u64>> {
        let mut sections = Vec::new();
        let mut next = start;
        let mut visited = HashSet::new();
        let mut listed = 0_usize;
        for revision in 0.. {
            if !visited.insert(next) || visited.len() > MAX_XREF_SECTIONS {
                return Err(corrupt("PDF cross-reference chain loops or is too long"));
            }
            let (entries, trailer, _) = self.xref_section(next)?;
            sections.push(next);
            let hybrid = match trailer.get(b"XRefStm").and_then(Object::as_i64) {
                Ok(stream) => {
                    let offset = u64::try_from(stream).map_err(|_| corrupt("Invalid /XRefStm"))?;
                    sections.push(offset);
                    self.xref_section(offset)?.0
                }
                Err(_) => Vec::new(),
            };
            listed = listed.saturating_add(hybrid.len() + entries.len());
            if listed > MAX_SOURCE_VALUES {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    format!("PDF cross-references list more than {MAX_SOURCE_VALUES} entries"),
                ));
            }
            for (number, entry) in hybrid.into_iter().chain(entries) {
                visit(revision, number, entry);
            }
            match trailer.get(b"Prev").and_then(Object::as_i64).ok() {
                Some(previous) => {
                    next = u64::try_from(previous).map_err(|_| corrupt("Invalid /Prev"))?
                }
                None => break,
            }
        }
        Ok(sections)
    }

    fn xref_section(&self, offset: u64) -> Result<XrefSection> {
        let classic = self.parse_at(offset, |cursor| {
            if !cursor.keyword(b"xref")? {
                return Ok(None);
            }
            let mut entries = Vec::new();
            while !cursor.keyword(b"trailer")? {
                let start = cursor.unsigned()?;
                let count = cursor.unsigned()?;
                for number in start..start.checked_add(count).ok_or(Invalid)? {
                    let entry_offset = cursor.unsigned()?;
                    let generation = cursor.unsigned()?;
                    let entry = match cursor.token()? {
                        b"n" => XrefEntry::Offset {
                            offset: entry_offset,
                            generation: u16::try_from(generation).map_err(|_| Invalid)?,
                        },
                        b"f" => XrefEntry::Free,
                        _ => return Err(Invalid),
                    };
                    entries.push((u32::try_from(number).map_err(|_| Invalid)?, entry));
                    if entries.len() > MAX_PDF_OBJECTS {
                        return Err(TooManyObjects);
                    }
                }
            }
            match cursor.object(0)? {
                Object::Dictionary(trailer) => Ok(Some((entries, trailer))),
                _ => Err(Invalid),
            }
        })?;
        if let Some((entries, trailer)) = classic {
            return Ok((entries, trailer, XrefType::CrossReferenceTable));
        }
        let (_, dictionary, data, _) = self.indirect_object(offset, None)?;
        let dictionary = dictionary
            .as_dict()
            .map_err(|_| corrupt("Invalid xref stream"))?;
        if dictionary.get(b"Type").and_then(Object::as_name).ok() != Some(b"XRef") {
            return Err(corrupt(
                "PDF cross-reference offset points at no xref section",
            ));
        }
        let length = match dictionary.get(b"Length") {
            Ok(Object::Integer(length)) => u64::try_from(*length).ok(),
            _ => None,
        };
        let (data_start, data_len) = self.stream_extent(
            data.ok_or_else(|| corrupt("Xref stream has no data"))?,
            length,
            None,
        )?;
        let content = self.stream_content(dictionary, data_start, data_len)?;
        let widths = dictionary
            .get(b"W")
            .and_then(Object::as_array)
            .map_err(|_| corrupt("Xref stream has no /W"))?
            .iter()
            .map(|width| {
                width
                    .as_i64()
                    .ok()
                    .and_then(|width| usize::try_from(width).ok())
                    .filter(|width| *width <= 8)
            })
            .collect::<Option<Vec<_>>>()
            .filter(|widths| widths.len() == 3 && widths.iter().sum::<usize>() > 0)
            .ok_or_else(|| corrupt("Xref stream has invalid /W"))?;
        let size = dictionary
            .get(b"Size")
            .and_then(Object::as_i64)
            .map_err(|_| corrupt("Xref stream has no /Size"))?;
        let index = match dictionary.get(b"Index").and_then(Object::as_array) {
            Ok(index) => index
                .iter()
                .map(|value| {
                    value
                        .as_i64()
                        .ok()
                        .and_then(|value| u32::try_from(value).ok())
                })
                .collect::<Option<Vec<_>>>()
                .filter(|index| index.len() % 2 == 0)
                .ok_or_else(|| corrupt("Xref stream has invalid /Index"))?,
            Err(_) => vec![
                0,
                u32::try_from(size).map_err(|_| corrupt("Invalid xref /Size"))?,
            ],
        };
        let stride = widths.iter().sum::<usize>();
        let mut rows = content.chunks_exact(stride);
        let mut entries = Vec::new();
        for pair in index.chunks_exact(2) {
            for number in pair[0]
                ..pair[0]
                    .checked_add(pair[1])
                    .ok_or_else(|| corrupt("Invalid xref /Index"))?
            {
                let row = rows
                    .next()
                    .ok_or_else(|| corrupt("Xref stream ended early"))?;
                let mut fields = [1_u64, 0, 0];
                let mut cursor = 0;
                for (field, width) in fields.iter_mut().zip(&widths) {
                    if *width > 0 {
                        *field = read_xref_stream_field(row, &mut cursor, *width)?;
                    }
                }
                let entry = match fields[0] {
                    0 => XrefEntry::Free,
                    1 => XrefEntry::Offset {
                        offset: fields[1],
                        generation: u16::try_from(fields[2])
                            .map_err(|_| corrupt("Invalid xref generation"))?,
                    },
                    2 => XrefEntry::InStream {
                        container: u32::try_from(fields[1])
                            .map_err(|_| corrupt("Invalid object stream number"))?,
                        // An index past u32 names no slot, so any usable one counts.
                        index: u32::try_from(fields[2]).unwrap_or(u32::MAX),
                    },
                    // Unknown entry types read as null objects.
                    _ => XrefEntry::Free,
                };
                entries.push((number, entry));
                if entries.len() > MAX_PDF_OBJECTS {
                    return Err(domain_error(
                        NativeErrorCode::TooLarge,
                        "Xref stream exceeds the object ceiling",
                    ));
                }
            }
        }
        Ok((entries, dictionary.clone(), XrefType::CrossReferenceStream))
    }

    /// The object at `offset`, its number, where its stream data starts when
    /// it is a stream, and the reals it spells beyond `f32`.
    fn indirect_object(
        &self,
        offset: u64,
        expected: Option<ObjectId>,
    ) -> Result<(ObjectId, Object, Option<u64>, RealSpellings)> {
        let (id, object, data, reals) = self.parse_at(offset, |cursor| {
            let number = u32::try_from(cursor.unsigned()?).map_err(|_| Invalid)?;
            let generation = u16::try_from(cursor.unsigned()?).map_err(|_| Invalid)?;
            if !cursor.keyword(b"obj")? {
                return Err(Invalid);
            }
            let object = cursor.object(0)?;
            let data = match object {
                Object::Dictionary(_) if cursor.keyword(b"stream")? => {
                    Some(cursor.stream_data_start()? as u64)
                }
                _ => None,
            };
            Ok((
                (number, generation),
                object,
                data,
                std::mem::take(&mut cursor.reals),
            ))
        })?;
        if expected.is_some_and(|expected| expected != id) {
            return Err(corrupt(format!(
                "PDF object {} {} is not at its xref offset",
                id.0, id.1
            )));
        }
        Ok((id, object, data.map(|data| offset + data), reals))
    }

    /// The data range of a stream starting at `data` (counted from the
    /// header) as absolute file offsets. A declared length must end at
    /// `endstream` before `bound`, where the next object starts; otherwise
    /// the data ends at the only `endstream` before it, as lopdf recovers it.
    fn stream_extent(
        &self,
        data: u64,
        declared: Option<u64>,
        bound: Option<u64>,
    ) -> Result<(u64, u64)> {
        let start = self.base + data;
        // A declared length that runs into the next object would hide it.
        let within =
            |len: u64| bound.is_none_or(|bound| start.saturating_add(len) <= self.base + bound);
        if let Some(len) = declared.filter(|len| within(*len)) {
            if self.ends_at_endstream(start, len)? {
                return Ok((start, len));
            }
        }
        if self.strict {
            return Err(corrupt("PDF stream /Length does not end at endstream"));
        }
        const ENDSTREAM: &[u8] = b"endstream";
        let end = bound.map_or(self.len, |bound| (self.base + bound).min(self.len));
        let mut found = None;
        let mut position = start;
        while position < end {
            let chunk = Self::read(self.bytes, end, position, 1 << 20)?;
            let mut search = 0;
            while let Some(hit) = find_bytes(&chunk[search..], ENDSTREAM) {
                let at = position + (search + hit) as u64;
                search += hit + 1;
                let around = Self::read(self.bytes, self.len, at.saturating_sub(2), 64)?;
                let eol = match &around[..2.min(around.len())] {
                    [b'\r', b'\n'] => 2,
                    [_, b'\n' | b'\r'] => 1,
                    _ => continue,
                };
                let after = &around[(2 + ENDSTREAM.len()).min(around.len())..];
                let skipped = after
                    .iter()
                    .take_while(|byte| is_pdf_whitespace(**byte))
                    .count();
                if at - eol < start || !after[skipped..].starts_with(b"endobj") {
                    continue;
                }
                if found.is_some() {
                    return Err(corrupt(
                        "PDF stream length is wrong and its end is ambiguous",
                    ));
                }
                found = Some(at - eol);
            }
            // Consecutive chunks share all but one byte of a marker, so each
            // marker is found once, whole.
            position += chunk.len().saturating_sub(ENDSTREAM.len() - 1).max(1) as u64;
        }
        found
            .map(|end| (start, end - start))
            .ok_or_else(|| corrupt("PDF stream has no endstream"))
    }

    /// Whether `len` bytes of stream data from absolute offset `start` end
    /// where `endstream` follows (and, in strict mode, a properly delimited
    /// `endstream` followed by `endobj`).
    fn ends_at_endstream(&self, start: u64, len: u64) -> Result<bool> {
        let Some(end) = start.checked_add(len).filter(|end| *end <= self.len) else {
            return Ok(false);
        };
        let after = Self::read(
            self.bytes,
            self.len,
            end,
            if self.strict { 256 } else { 64 },
        )?;
        let skipped = after
            .iter()
            .take_while(|byte| is_pdf_whitespace(**byte))
            .count();
        let Some(rest) = after[skipped..].strip_prefix(b"endstream") else {
            return Ok(false);
        };
        if !self.strict {
            return Ok(true);
        }
        // Strict verification rejects trailing tokens glued onto `endstream`
        // (e.g. `endstreamJUNK`) and requires a properly delimited `endobj`.
        let Some(&next) = rest.first() else {
            return Ok(false);
        };
        if !is_pdf_whitespace(next) && !is_pdf_delimiter(next) {
            return Ok(false);
        }
        let mut cursor = Cursor {
            bytes: rest,
            strict: true,
            ..Cursor::default()
        };
        cursor.skip_space();
        let Some(after_endobj) = cursor.bytes[cursor.pos..].strip_prefix(b"endobj") else {
            return Ok(false);
        };
        Ok(after_endobj
            .first()
            .is_none_or(|&byte| is_pdf_whitespace(byte) || is_pdf_delimiter(byte)))
    }

    /// A stream's decoded data, for the cross-reference and object streams
    /// this reader decodes itself.
    fn stream_content(&self, dictionary: &Dictionary, start: u64, len: u64) -> Result<Vec<u8>> {
        let len = usize::try_from(len)
            .ok()
            .filter(|len| *len <= MAX_OBJECT_BYTES)
            .ok_or_else(|| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "PDF structure stream exceeds its ceiling",
                )
            })?;
        let raw = Self::read(self.bytes, self.len, start, len)?;
        Ok(plain_stream_with_limit(
            &Stream::new(dictionary.clone(), raw),
            MAX_OBJECT_BYTES,
        )?)
    }
}

/// The most decoded object streams one read keeps at once.
const MAX_CACHED_OBJECT_STREAMS: usize = 64;
/// The decoded bytes those streams may hold together. A stream larger than
/// this alone is decoded for each read and never kept.
const OBJECT_STREAM_CACHE_BYTES: usize = 32 * 1024 * 1024;

/// How many object streams may be decoding at once, each to read the
/// `/Length` of the one before.
const MAX_OBJECT_STREAM_NESTING: usize = 4;

/// One decoded object stream: its data, ending as an indirect object does,
/// and where its header places each member. It holds what any revision
/// reads of the stream, so revisions that read it share one decoding.
struct ObjectStreamData {
    content: Vec<u8>,
    /// Each header slot's object number and start, `usize::MAX` for a slot
    /// whose offset is unparseable or outside the data.
    slots: Vec<(u32, usize)>,
    /// Each object number's first usable slot start.
    first: HashMap<u32, usize>,
}

impl ObjectStreamData {
    /// The memory it holds: what each buffer allocated, not what it uses,
    /// with a byte of hash-table control per bucket of `first`.
    fn bytes(&self) -> usize {
        let slot = std::mem::size_of::<(u32, usize)>();
        self.content.capacity() + self.slots.capacity() * slot + self.first.capacity() * (slot + 1)
    }

    fn shrink(&mut self) {
        self.content.shrink_to_fit();
        self.slots.shrink_to_fit();
        self.first.shrink_to_fit();
    }

    /// Where member `number` starts: at `slot`, the one the cross-reference
    /// names, when it lists the member at an offset inside the data, else at
    /// the first slot that does, so a duplicate entry that points nowhere
    /// hides nothing.
    fn member_start(&self, number: u32, slot: u32) -> Option<usize> {
        self.slots
            .get(slot as usize)
            .filter(|(listed, start)| *listed == number && *start != usize::MAX)
            .map(|(_, start)| *start)
            .or_else(|| self.first.get(&number).copied())
    }
}

/// Decoded object streams, least recently used first, within
/// `MAX_CACHED_OBJECT_STREAMS` and `OBJECT_STREAM_CACHE_BYTES`. A member is
/// parsed from its stream when it is read, so a stream evicted while some of
/// its members are unread is decoded again only when one of them is.
#[derive(Default)]
struct ObjectStreamCache {
    /// Each stream by the extent of its data, as the reading revision
    /// resolved its `/Length`: the same bytes decode the same way, whichever
    /// revision reads them.
    entries: Vec<((u64, u64), Rc<ObjectStreamData>)>,
    bytes: usize,
}

impl ObjectStreamCache {
    fn get(&mut self, extent: (u64, u64)) -> Option<Rc<ObjectStreamData>> {
        let at = self.entries.iter().position(|(at, _)| *at == extent)?;
        let entry = self.entries.remove(at);
        let data = entry.1.clone();
        self.entries.push(entry);
        Some(data)
    }

    /// Keeps `data` as the most recent stream, unless it alone exceeds the
    /// byte budget: then it serves the read at hand and is not kept.
    fn insert(&mut self, extent: (u64, u64), mut data: ObjectStreamData) -> Rc<ObjectStreamData> {
        data.shrink();
        let data = Rc::new(data);
        if data.bytes() > OBJECT_STREAM_CACHE_BYTES {
            return data;
        }
        self.bytes += data.bytes();
        self.entries.push((extent, data.clone()));
        while self.entries.len() > MAX_CACHED_OBJECT_STREAMS
            || self.bytes > OBJECT_STREAM_CACHE_BYTES
        {
            let (_, evicted) = self.entries.remove(0);
            self.bytes -= evicted.bytes();
        }
        data
    }
}

/// The cross-references a loader reads objects through: the terminal
/// revision's merged index, or one revision's view of a file's history.
trait XrefView {
    /// The entry that places object `number`, unless it is free or unlisted.
    fn entry(&self, number: u32) -> Option<XrefEntry>;
    /// Where the next object after the one at `offset` starts, which bounds
    /// that object's stream data.
    fn next_offset(&self, offset: u64) -> Option<u64>;
}

impl XrefView for XrefIndex {
    fn entry(&self, number: u32) -> Option<XrefEntry> {
        self.entries.get(&number).copied()
    }

    fn next_offset(&self, offset: u64) -> Option<u64> {
        let next = self.offsets.partition_point(|next| *next <= offset);
        self.offsets.get(next).copied()
    }
}

/// An object read at its offset, its reals, and a stream's data range.
type DirectObject = (Object, RealSpellings, Option<(u64, u64)>);

struct Loader<'r, 'a, S: ?Sized> {
    reader: &'r Reader<'a, S>,
    index: &'r dyn XrefView,
    object_streams: ObjectStreamCache,
    /// Object streams being decoded, which read as empty meanwhile, so a
    /// stream whose `/Length` lives in itself cannot recurse.
    decoding: HashSet<u32>,
    /// Each object stream read so far, by its object's offset: its
    /// dictionary and the extent of its data, as this loader's view resolves
    /// its `/Length`.
    containers: HashMap<u64, (Dictionary, (u64, u64))>,
    /// Object streams too large to keep decoded, whose members this view
    /// places in them were parsed at once, and those members not yet taken.
    prefetched_streams: HashSet<u32>,
    prefetched: HashMap<u32, (Object, RealSpellings)>,
    streams: HashMap<ObjectId, (u64, u64)>,
    reals: HashMap<ObjectId, RealSpellings>,
    /// The values every object parsed so far holds.
    values: usize,
}

impl<'r, 'a, S: ByteSource + ?Sized> Loader<'r, 'a, S> {
    fn new(reader: &'r Reader<'a, S>, index: &'r dyn XrefView) -> Self {
        Self {
            reader,
            index,
            object_streams: ObjectStreamCache::default(),
            decoding: HashSet::new(),
            containers: HashMap::new(),
            prefetched_streams: HashSet::new(),
            prefetched: HashMap::new(),
            streams: HashMap::new(),
            reals: HashMap::new(),
            values: 0,
        }
    }

    /// How many values `object` holds.
    fn values_of(object: &Object) -> usize {
        let mut pending = vec![object];
        let mut values = 0;
        while let Some(object) = pending.pop() {
            values += 1;
            match object {
                Object::Array(items) => pending.extend(items),
                Object::Dictionary(dict) => pending.extend(dict.iter().map(|(_, value)| value)),
                Object::Stream(stream) => {
                    pending.extend(stream.dict.iter().map(|(_, value)| value))
                }
                _ => {}
            }
        }
        values
    }

    /// Counts `object`'s values against the read's aggregate ceiling.
    fn charge(&mut self, object: &Object) -> Result<()> {
        self.values += Self::values_of(object);
        if self.values > MAX_SOURCE_VALUES {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("PDF objects exceed the {MAX_SOURCE_VALUES}-value ceiling"),
            ));
        }
        Ok(())
    }

    /// One object as the document holds it: a missing or free one reads as
    /// null, a stream as its dictionary with an empty body.
    fn load(&mut self, id: ObjectId) -> Result<Object> {
        let (object, reals) = match self.index.entry(id.0) {
            Some(XrefEntry::Offset { offset, generation }) if generation == id.1 => {
                #[cfg(test)]
                SOURCE_PDF_LOADED_OBJECT_COUNT
                    .with(|count| count.set(count.get().saturating_add(1)));
                let (object, reals, extent) = self.direct(id, offset)?;
                if let Some(extent) = extent {
                    self.streams.insert(id, extent);
                }
                (object, reals)
            }
            Some(XrefEntry::InStream { container, index }) if id.1 == 0 => {
                #[cfg(test)]
                SOURCE_PDF_LOADED_OBJECT_COUNT
                    .with(|count| count.set(count.get().saturating_add(1)));
                match self.member(container, id.0, index, true)? {
                    Some(member) => member,
                    None => return Ok(Object::Null),
                }
            }
            _ => return Ok(Object::Null),
        };
        self.charge(&object)?;
        if !reals.is_empty() {
            self.reals.insert(id, reals);
        }
        Ok(object)
    }

    /// The object at `offset`, a stream as its dictionary with an empty
    /// body, with its reals and, for a stream, its data's range.
    fn direct(&mut self, id: ObjectId, offset: u64) -> Result<DirectObject> {
        let (_, object, data, reals) = self.reader.indirect_object(offset, Some(id))?;
        let (data, mut dict) = match (data, object) {
            (Some(data), Object::Dictionary(dict)) => (data, dict),
            (_, object) => return Ok((object, reals, None)),
        };
        let declared = match dict.get(b"Length") {
            Ok(Object::Reference(length)) => self.length(*length)?,
            Ok(length) => length.as_i64().ok(),
            Err(_) => None,
        }
        .and_then(|length| u64::try_from(length).ok());
        let bound = self.index.next_offset(offset);
        let (start, len) = self.reader.stream_extent(data, declared, bound)?;
        dict.set("Length", i64::try_from(len)?);
        let stream = Object::Stream(Stream {
            dict,
            content: Vec::new(),
            allows_compression: false,
            start_position: None,
        });
        Ok((stream, reals, Some((start, len))))
    }

    /// An indirect `/Length`: read without following it as a stream.
    fn length(&mut self, id: ObjectId) -> Result<Option<i64>> {
        let length = match self.index.entry(id.0) {
            Some(XrefEntry::Offset { offset, generation }) if generation == id.1 => {
                self.reader.indirect_object(offset, Some(id))?.1
            }
            Some(XrefEntry::InStream { container, index }) if id.1 == 0 => self
                .member(container, id.0, index, false)?
                .map_or(Object::Null, |(object, _)| object),
            _ => Object::Null,
        };
        // Lengths are read without being kept, so repeated lookups of
        // large ones count against the same ceiling as the objects.
        self.charge(&length)?;
        Ok(length.as_i64().ok())
    }

    /// Member `number` of object stream `container`, which the
    /// cross-reference lists at header slot `slot`, with its reals; `take`
    /// when the document keeps it. As lopdf reads one, a member that does not
    /// parse is missing.
    fn member(
        &mut self,
        container: u32,
        number: u32,
        slot: u32,
        take: bool,
    ) -> Result<Option<(Object, RealSpellings)>> {
        if self.prefetched_streams.contains(&container) {
            if !take {
                return Ok(self.prefetched.get(&number).cloned());
            }
            // Charged when parsed; `load` charges what it keeps.
            let member = self.prefetched.remove(&number);
            if let Some((object, _)) = &member {
                self.values -= Self::values_of(object);
            }
            return Ok(member);
        }
        let Some(data) = self.compressed(container)? else {
            return Ok(None);
        };
        if data.bytes() > OBJECT_STREAM_CACHE_BYTES {
            self.prefetch(container, &data)?;
            return self.member(container, number, slot, take);
        }
        let Some(pos) = data.member_start(number, slot) else {
            return Ok(None);
        };
        Self::parse_member(&data, pos, container, number, self.reader.strict)
    }

    fn parse_member(
        data: &ObjectStreamData,
        pos: usize,
        container: u32,
        number: u32,
        strict: bool,
    ) -> Result<Option<(Object, RealSpellings)>> {
        let mut cursor = Cursor {
            bytes: &data.content,
            pos,
            strict,
            ..Cursor::default()
        };
        match cursor.object(0) {
            Ok(object) => Ok(Some((object, cursor.reals))),
            Err(Crowded) => Err(too_many_elements(format!(
                "{number} 0 in stream {container}"
            ))),
            Err(DuplicateKey(key)) => Err(corrupt(format!(
                "PDF object {number} 0 in stream {container} has duplicate dictionary key /{key}"
            ))),
            Err(_) if strict => Err(corrupt(format!(
                "PDF object {number} 0 in stream {container} is malformed"
            ))),
            Err(_) => Ok(None),
        }
    }

    /// Parses at once every member this view places in `container`, a
    /// stream too large to keep decoded, so its members do not each decode
    /// it again. What it parses counts against the read's value ceiling.
    fn prefetch(&mut self, container: u32, data: &ObjectStreamData) -> Result<()> {
        self.prefetched_streams.insert(container);
        for &(number, _) in &data.slots {
            let Some(XrefEntry::InStream {
                container: owner,
                index,
            }) = self.index.entry(number)
            else {
                continue;
            };
            if owner != container || self.prefetched.contains_key(&number) {
                continue;
            }
            let Some(pos) = data.member_start(number, index) else {
                continue;
            };
            if let Some(member) =
                Self::parse_member(data, pos, container, number, self.reader.strict)?
            {
                self.charge(&member.0)?;
                self.prefetched.insert(number, member);
            }
        }
        Ok(())
    }

    /// Object stream `container`, decoded once while it stays cached. One
    /// being decoded reads as empty.
    fn compressed(&mut self, container: u32) -> Result<Option<Rc<ObjectStreamData>>> {
        let Some(XrefEntry::Offset {
            offset,
            generation: 0,
        }) = self.index.entry(container)
        else {
            return Err(corrupt(format!("PDF object stream {container} is missing")));
        };
        if let Some((_, extent)) = self.containers.get(&offset) {
            if let Some(data) = self.object_streams.get(*extent) {
                return Ok(Some(data));
            }
        }
        if self.decoding.contains(&container) {
            return Ok(None);
        }
        // Only a damaged file keeps one object stream's `/Length` in another;
        // a chain of them would otherwise recurse once per stream.
        if self.decoding.len() >= MAX_OBJECT_STREAM_NESTING {
            return Err(corrupt("PDF object streams nest their lengths too deeply"));
        }
        self.decoding.insert(container);
        let data = self.object_stream(container, offset);
        self.decoding.remove(&container);
        data.map(Some)
    }

    /// Object stream `container` at `offset`, from the cache when its data's
    /// extent, as this view resolves it, is there.
    fn object_stream(&mut self, container: u32, offset: u64) -> Result<Rc<ObjectStreamData>> {
        let (dict, extent) = match self.containers.get(&offset) {
            Some(found) => found.clone(),
            None => {
                let (Object::Stream(stream), _, Some(extent)) =
                    self.direct((container, 0), offset)?
                else {
                    return Err(corrupt(format!(
                        "PDF object stream {container} is not a stream"
                    )));
                };
                self.containers
                    .insert(offset, (stream.dict.clone(), extent));
                (stream.dict, extent)
            }
        };
        if let Some(data) = self.object_streams.get(extent) {
            return Ok(data);
        }
        let mut content = self.reader.stream_content(&dict, extent.0, extent.1)?;
        let first = dict
            .get(b"First")
            .and_then(Object::as_i64)
            .ok()
            .and_then(|first| usize::try_from(first).ok())
            .filter(|first| *first <= content.len())
            .ok_or_else(|| corrupt(format!("PDF object stream {container} has no valid /First")))?;
        let mut tokens = std::str::from_utf8(&content[..first])
            .map_err(|_| corrupt(format!("PDF object stream {container} has no valid header")))?
            .split_whitespace();
        let mut slots = Vec::new();
        let mut usable = HashMap::new();
        while let (Some(number), Some(offset)) = (tokens.next(), tokens.next()) {
            if slots.len() >= MAX_OBJECT_ELEMENTS {
                return Err(too_many_elements(format!("stream {container}")));
            }
            let number = number.parse::<u32>().ok();
            let start = offset
                .parse::<u32>()
                .ok()
                .and_then(|offset| first.checked_add(offset as usize))
                .filter(|start| *start < content.len());
            match (number, start) {
                (Some(number), Some(start)) => {
                    usable.entry(number).or_insert(start);
                    slots.push((number, start));
                }
                (number, _) => slots.push((number.unwrap_or(u32::MAX), usize::MAX)),
            }
        }
        // The data ends as an indirect object does (with a trailing delimiter so
        // lookahead tokenization never hits Incomplete at EOF), so a token that
        // ends it ends there, and a number that ends it is not the start of a
        // reference the lookahead must wait for.
        content.extend_from_slice(b"\nendobj\n");
        let data = ObjectStreamData {
            content,
            slots,
            first: usable,
        };
        Ok(self.object_streams.insert(extent, data))
    }
}

/// Where the bodies of streams end, for a scan of `bytes` that steps over
/// every physical object, those of earlier revisions included, and meets one
/// whose `/Length` is indirect or unusable. Each body is measured as the
/// revision that wrote it reads it: an indirect `/Length` resolves through
/// that revision's cross-references, and a body ends before the next object
/// any revision lists. The chain is read when the first such stream is met.
/// What it keeps follows the entries the cross-references list, not the
/// revisions times the objects.
pub(crate) struct IndirectStreamEnds<'a> {
    bytes: &'a [u8],
    indexed: Option<RevisionHistory<'a>>,
}

struct RevisionHistory<'a> {
    reader: Reader<'a, [u8]>,
    /// Each object's entries, newest revision first, one per revision that
    /// lists it.
    entries: HashMap<u32, Vec<(usize, XrefEntry)>>,
    /// Every offset any revision lists an object at, ascending, with the
    /// oldest revision that lists one there: the one that wrote it.
    objects: Vec<(u64, usize)>,
    /// Those offsets and every cross-reference section's, ascending: a
    /// body ends before the next of them.
    boundaries: Vec<u64>,
    /// The object streams any revision's lookups decoded, by their extent.
    object_streams: ObjectStreamCache,
    /// The values every lookup parsed, against one read-wide ceiling.
    values: usize,
}

/// What revision `revision` and those before it list.
struct RevisionView<'h> {
    entries: &'h HashMap<u32, Vec<(usize, XrefEntry)>>,
    boundaries: &'h [u64],
    revision: usize,
}

impl XrefView for RevisionView<'_> {
    fn entry(&self, number: u32) -> Option<XrefEntry> {
        let entries = self.entries.get(&number)?;
        let at = entries.partition_point(|(revision, _)| *revision < self.revision);
        match entries.get(at)?.1 {
            XrefEntry::Free => None,
            entry => Some(entry),
        }
    }

    fn next_offset(&self, offset: u64) -> Option<u64> {
        let next = self.boundaries.partition_point(|next| *next <= offset);
        self.boundaries.get(next).copied()
    }
}

impl<'a> IndirectStreamEnds<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            indexed: None,
        }
    }

    fn indexed(&mut self) -> Result<&mut RevisionHistory<'a>> {
        if self.indexed.is_none() {
            let reader = Reader::new(self.bytes, self.bytes.len() as u64)?;
            let mut entries = HashMap::<u32, Vec<(usize, XrefEntry)>>::new();
            let mut objects = Vec::new();
            let sections =
                reader.walk_revisions(reader.terminal_start()?, |revision, number, entry| {
                    let listed = entries.entry(number).or_default();
                    // The first entry for a number in one revision decides it.
                    if listed.last().is_some_and(|(last, _)| *last == revision) {
                        return;
                    }
                    listed.push((revision, entry));
                    if let XrefEntry::Offset { offset, .. } = entry {
                        objects.push((offset, revision));
                    }
                })?;
            // The oldest revision listing an offset sorts first and stays.
            objects
                .sort_unstable_by_key(|(offset, revision)| (*offset, std::cmp::Reverse(*revision)));
            objects.dedup_by_key(|(offset, _)| *offset);
            entries.shrink_to_fit();
            objects.shrink_to_fit();
            let mut boundaries = objects
                .iter()
                .map(|(offset, _)| *offset)
                .chain(sections)
                .collect::<Vec<_>>();
            boundaries.sort_unstable();
            boundaries.dedup();
            self.indexed = Some(RevisionHistory {
                reader,
                entries,
                objects,
                boundaries,
                object_streams: ObjectStreamCache::default(),
                values: 0,
            });
        }
        Ok(self.indexed.as_mut().unwrap())
    }

    /// What the measuring keeps: listed entries, object offsets, the
    /// decoded bytes of cached object streams and the values it parsed.
    #[cfg(test)]
    pub(crate) fn retained(&self) -> (usize, usize, usize, usize) {
        self.indexed.as_ref().map_or((0, 0, 0, 0), |indexed| {
            (
                indexed.entries.values().map(Vec::len).sum(),
                indexed.objects.len(),
                indexed.object_streams.bytes,
                indexed.values,
            )
        })
    }

    /// The length of the body that starts at absolute offset `data` and
    /// whose `/Length` is `length`, if any: its value in the revision that
    /// wrote the body, when the body ends there at `endstream` before the
    /// next object; otherwise, as the indexed reader recovers it, the only
    /// `endstream` before the next object. A file whose cross-references
    /// cannot be read, or a body with no single end, is refused.
    pub(crate) fn body_len(&mut self, length: Option<ObjectId>, data: u64) -> Result<u64> {
        let indexed = self.indexed()?;
        let data = data
            .checked_sub(indexed.reader.base)
            .ok_or_else(|| corrupt("PDF stream data starts before its header"))?;
        let next = indexed
            .objects
            .partition_point(|(offset, _)| *offset <= data);
        let view = RevisionView {
            entries: &indexed.entries,
            boundaries: &indexed.boundaries,
            revision: next
                .checked_sub(1)
                .map_or(0, |holder| indexed.objects[holder].1),
        };
        let mut loader = Loader::new(&indexed.reader, &view);
        loader.object_streams = std::mem::take(&mut indexed.object_streams);
        loader.values = indexed.values;
        // A length the index cannot read, such as one in an encrypted object
        // stream, is recovered from the body's end; one past the read's
        // value ceiling refuses the file.
        let declared = match length.map(|length| loader.length(length)) {
            Some(Err(error))
                if error.downcast_ref::<NativeError>().map(|error| error.code)
                    == Some(NativeErrorCode::TooLarge) =>
            {
                return Err(error)
            }
            Some(Ok(declared)) => declared,
            _ => None,
        }
        .and_then(|length| u64::try_from(length).ok());
        indexed.values = loader.values;
        let object_streams = std::mem::take(&mut loader.object_streams);
        let bound = view.next_offset(data);
        let extent = indexed.reader.stream_extent(data, declared, bound);
        indexed.object_streams = object_streams;
        Ok(extent?.1)
    }
}

#[derive(Debug)]
enum ParseFailure {
    /// The window ended inside the object.
    Incomplete,
    Invalid,
    /// The object holds more than `MAX_OBJECT_ELEMENTS` values.
    Crowded,
    /// A cross-reference table lists more than `MAX_PDF_OBJECTS` objects.
    TooManyObjects,
    /// Strict verification encountered a duplicate dictionary key.
    DuplicateKey(String),
}
use ParseFailure::{Crowded, DuplicateKey, Incomplete, Invalid, TooManyObjects};

fn too_many_elements(object: String) -> Box<dyn Error> {
    domain_error(
        NativeErrorCode::TooLarge,
        format!("PDF object {object} exceeds the {MAX_OBJECT_ELEMENTS}-value ceiling"),
    )
}
type ParseResult<T> = std::result::Result<T, ParseFailure>;

/// The reals of one object that `f32` does not print back exactly: by their
/// path in the object, the bits read and the source token.
pub(crate) type RealSpellings = HashMap<Box<[u8]>, (u32, Box<str>)>;

/// Extends `path`, where a value sits in its object, by a dictionary key.
/// Each step is tagged and length-prefixed, so two paths never spell alike.
pub(crate) fn path_key(path: &mut Vec<u8>, key: &[u8]) {
    path.push(b'/');
    path.extend((key.len() as u32).to_le_bytes());
    path.extend(key);
}

pub(crate) fn path_index(path: &mut Vec<u8>, index: usize) {
    path.push(b'[');
    path.extend((index as u32).to_le_bytes());
}

pub(crate) fn path_first_key(path: &[u8]) -> Option<&[u8]> {
    let len = u32::from_le_bytes(path.get(1..5)?.try_into().ok()?) as usize;
    (path[0] == b'/').then(|| path.get(5..5 + len)).flatten()
}

/// A real token as (negative, whole digits, fraction digits) without
/// leading or trailing zeros, so two spellings of one number compare equal.
fn decimal(text: &str) -> (bool, &str, &str) {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(digits) => (true, digits),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let (whole, fraction) = (
        whole.trim_start_matches('0'),
        fraction.trim_end_matches('0'),
    );
    (
        negative && !(whole.is_empty() && fraction.is_empty()),
        whole,
        fraction,
    )
}

/// A PDF object parser over a window of the file, with lopdf's value rules.
/// It keeps the spelling of each real `f32` does not print back exactly.
#[derive(Default)]
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
    path: Vec<u8>,
    reals: RealSpellings,
    elements: usize,
    strict: bool,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> ParseResult<u8> {
        self.bytes.get(self.pos).copied().ok_or(Incomplete)
    }

    fn skip_space(&mut self) {
        loop {
            while self
                .bytes
                .get(self.pos)
                .is_some_and(|byte| is_pdf_whitespace(*byte))
            {
                self.pos += 1;
            }
            if self.bytes.get(self.pos) != Some(&b'%') {
                return;
            }
            while self
                .bytes
                .get(self.pos)
                .is_some_and(|byte| !matches!(byte, b'\r' | b'\n'))
            {
                self.pos += 1;
            }
        }
    }

    /// The next run of regular characters, which must end inside the window.
    fn token(&mut self) -> ParseResult<&'a [u8]> {
        self.skip_space();
        let start = self.pos;
        while !is_pdf_whitespace(self.peek()?) && !is_pdf_delimiter(self.peek()?) {
            self.pos += 1;
        }
        Ok(&self.bytes[start..self.pos])
    }

    /// Consumes `word` when it is the next token.
    fn keyword(&mut self, word: &[u8]) -> ParseResult<bool> {
        let start = self.pos;
        if self.token()? == word {
            return Ok(true);
        }
        self.pos = start;
        Ok(false)
    }

    fn unsigned(&mut self) -> ParseResult<u64> {
        let token = self.token()?;
        if token.is_empty() || !token.iter().all(u8::is_ascii_digit) {
            return Err(Invalid);
        }
        std::str::from_utf8(token)
            .ok()
            .and_then(|text| text.parse().ok())
            .ok_or(Invalid)
    }

    /// After `stream`: where its data starts, by `stream_data_offset`.
    fn stream_data_start(&mut self) -> ParseResult<usize> {
        self.pos = stream_data_offset(self.bytes, self.pos).map_err(|ran_out| {
            if ran_out {
                Incomplete
            } else {
                Invalid
            }
        })?;
        Ok(self.pos)
    }

    fn object(&mut self, depth: usize) -> ParseResult<Object> {
        if depth > MAX_PDF_STRUCTURAL_NESTING {
            return Err(Invalid);
        }
        if depth > 0 {
            self.elements += 1;
            if self.elements > MAX_OBJECT_ELEMENTS {
                return Err(Crowded);
            }
        }
        self.skip_space();
        match self.peek()? {
            b'/' => Ok(Object::Name(self.name()?)),
            b'(' => Ok(Object::string_literal(self.literal_string()?)),
            b'<' if self.bytes.get(self.pos + 1).ok_or(Incomplete)? == &b'<' => {
                self.pos += 2;
                let mut dictionary = Dictionary::new();
                loop {
                    self.skip_space();
                    match self.peek()? {
                        b'>' if *self.bytes.get(self.pos + 1).ok_or(Incomplete)? == b'>' => {
                            self.pos += 2;
                            return Ok(Object::Dictionary(dictionary));
                        }
                        b'/' => {
                            let key = self.name()?;
                            let mark = self.path.len();
                            path_key(&mut self.path, &key);
                            let value = self.object(depth + 1)?;
                            self.path.truncate(mark);
                            // The first of duplicate keys counts, as qpdf
                            // and pypdf read it. Strict verification refuses
                            // duplicate keys just as strict qpdf exit 0 does.
                            if !dictionary.has(&key) {
                                dictionary.set(key, value);
                            } else if self.strict {
                                return Err(DuplicateKey(
                                    String::from_utf8_lossy(&key).into_owned(),
                                ));
                            }
                        }
                        _ => return Err(Invalid),
                    }
                }
            }
            b'<' => self.hex_string(),
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_space();
                    if self.peek()? == b']' {
                        self.pos += 1;
                        return Ok(Object::Array(items));
                    }
                    let mark = self.path.len();
                    path_index(&mut self.path, items.len());
                    items.push(self.object(depth + 1)?);
                    self.path.truncate(mark);
                }
            }
            _ => self.number_or_keyword(),
        }
    }

    fn number_or_keyword(&mut self) -> ParseResult<Object> {
        let token = self.token()?;
        match token {
            b"null" => return Ok(Object::Null),
            b"true" => return Ok(Object::Boolean(true)),
            b"false" => return Ok(Object::Boolean(false)),
            _ => {}
        }
        let text = std::str::from_utf8(token).map_err(|_| Invalid)?;
        let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
        if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
            if let Ok(value) = text.parse::<i64>() {
                if digits.len() == text.len() {
                    if let Some(reference) = self.reference_tail(value)? {
                        return Ok(reference);
                    }
                }
                return Ok(Object::Integer(value));
            }
        } else {
            let (whole, fraction) = digits.split_once('.').ok_or(Invalid)?;
            if whole.len() + fraction.len() == 0
                || !whole
                    .bytes()
                    .chain(fraction.bytes())
                    .all(|byte| byte.is_ascii_digit())
            {
                return Err(Invalid);
            }
        }
        let value = text.parse::<f32>().map_err(|_| Invalid)?;
        if decimal(text) != decimal(&value.to_string()) {
            self.reals
                .entry(self.path.as_slice().into())
                .or_insert_with(|| (value.to_bits(), text.into()));
        }
        Ok(Object::Real(value))
    }

    /// `G R` after an object number makes a reference.
    fn reference_tail(&mut self, number: i64) -> ParseResult<Option<Object>> {
        let start = self.pos;
        self.skip_space();
        if self.peek()?.is_ascii_digit() {
            let generation = self.token()?;
            if generation.iter().all(u8::is_ascii_digit) && self.keyword(b"R")? {
                let generation = std::str::from_utf8(generation)
                    .ok()
                    .and_then(|text| text.parse::<u16>().ok());
                if let (Ok(number), Some(generation)) = (u32::try_from(number), generation) {
                    return Ok(Some(Object::Reference((number, generation))));
                }
            }
        }
        self.pos = start;
        Ok(None)
    }

    fn name(&mut self) -> ParseResult<Vec<u8>> {
        self.pos += 1;
        let mut name = Vec::new();
        loop {
            let byte = self.peek()?;
            if is_pdf_whitespace(byte) || is_pdf_delimiter(byte) {
                return Ok(name);
            }
            self.pos += 1;
            let escaped = (byte == b'#')
                .then(|| self.bytes.get(self.pos..self.pos + 2))
                .flatten()
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok());
            match escaped {
                Some(value) => {
                    self.pos += 2;
                    name.push(value);
                }
                None => name.push(byte),
            }
        }
    }

    fn literal_string(&mut self) -> ParseResult<Vec<u8>> {
        self.pos += 1;
        let mut text = Vec::new();
        let mut depth = 1_usize;
        loop {
            let byte = self.peek()?;
            self.pos += 1;
            match byte {
                b'\\' => {
                    let escaped = self.peek()?;
                    self.pos += 1;
                    match escaped {
                        b'0'..=b'7' => {
                            let mut value = u16::from(escaped - b'0');
                            for _ in 0..2 {
                                match self.peek()? {
                                    digit @ b'0'..=b'7' => {
                                        self.pos += 1;
                                        value = value * 8 + u16::from(digit - b'0');
                                    }
                                    _ => break,
                                }
                            }
                            text.push(value as u8);
                        }
                        b'\r' => {
                            if self.peek()? == b'\n' {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {}
                        b'n' => text.push(b'\n'),
                        b'r' => text.push(b'\r'),
                        b't' => text.push(b'\t'),
                        b'b' => text.push(0x08),
                        b'f' => text.push(0x0c),
                        other => text.push(other),
                    }
                }
                b'(' => {
                    depth += 1;
                    text.push(byte);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(text);
                    }
                    text.push(byte);
                }
                _ => text.push(byte),
            }
        }
    }

    fn hex_string(&mut self) -> ParseResult<Object> {
        self.pos += 1;
        let mut bytes = Vec::new();
        let mut high = None;
        loop {
            let byte = self.peek()?;
            self.pos += 1;
            let digit = match byte {
                b'>' => break,
                _ if is_pdf_whitespace(byte) => continue,
                _ => char::from(byte).to_digit(16).ok_or(Invalid)? as u8,
            };
            match high.take() {
                Some(high) => bytes.push(high << 4 | digit),
                None => high = Some(digit),
            }
        }
        if let Some(high) = high {
            bytes.push(high << 4);
        }
        Ok(Object::String(bytes, StringFormat::Hexadecimal))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|index| (index * 31 % 251) as u8).collect()
    }

    struct TempFile(PathBuf);

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn temp_file(label: &str, bytes: &[u8]) -> (TempFile, File) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "evb-pdf-source-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::write(&path, bytes).unwrap();
        let file = File::open(&path).unwrap();
        (TempFile(path), file)
    }

    #[test]
    fn file_reads_through_one_handle_from_many_threads_in_any_order() {
        let bytes = pattern(3 * COPY_CHUNK_BYTES + 17);
        let (_path, file) = temp_file("concurrent", &bytes);
        let ranges = (0..64_u64)
            .map(|index| {
                let start = (index * 48_611) % (bytes.len() as u64 - 4_096);
                (start, 1 + (index * 997) % 4_096)
            })
            .collect::<Vec<_>>();
        std::thread::scope(|scope| {
            for thread in 0..8 {
                let (file, bytes, ranges) = (&file, &bytes, &ranges);
                scope.spawn(move || {
                    // Each thread walks the ranges from its own start, backwards
                    // on odd threads, so reads interleave out of order.
                    for step in 0..ranges.len() {
                        let at = (thread * 7 + step) % ranges.len();
                        let at = if thread % 2 == 1 {
                            ranges.len() - 1 - at
                        } else {
                            at
                        };
                        let (start, len) = ranges[at];
                        let mut read = vec![0; len as usize];
                        file.read_at(start, &mut read).unwrap();
                        assert_eq!(read, bytes[start as usize..(start + len) as usize]);
                    }
                    let mut copied = Vec::new();
                    file.copy_range(5, bytes.len() as u64 - 9, &mut copied)
                        .unwrap();
                    assert_eq!(copied, bytes[5..bytes.len() - 4]);
                });
            }
        });
    }

    #[test]
    fn file_reads_past_the_end_are_unexpected_eof() {
        let bytes = pattern(100);
        let (_path, file) = temp_file("eof", &bytes);
        let mut buffer = [0; 4];
        let error = file.read_at(98, &mut buffer).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        let error = file.copy_range(90, 11, &mut Vec::new()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        file.read_at(96, &mut buffer).unwrap();
        assert_eq!(buffer, bytes[96..]);
    }

    fn stream_data(bytes: usize) -> ObjectStreamData {
        ObjectStreamData {
            content: vec![0; bytes],
            slots: Vec::new(),
            first: HashMap::new(),
        }
    }

    /// The extent of a stream's data, as the cache keys it.
    fn extent(start: u64) -> (u64, u64) {
        (start, 7)
    }

    #[test]
    fn object_stream_cache_reuses_a_decoded_stream_and_evicts_the_least_recent() {
        let mut cache = ObjectStreamCache::default();
        let first = cache.insert(extent(1), stream_data(10));
        assert!(Rc::ptr_eq(&cache.get(extent(1)).unwrap(), &first));
        // The same object read to a different length is another stream.
        assert!(cache.get((1, 8)).is_none());
        for start in 2..=MAX_CACHED_OBJECT_STREAMS as u64 {
            cache.insert(extent(start), stream_data(10));
        }
        // Reading the first keeps it; the second is now the least recent.
        cache.get(extent(1)).unwrap();
        cache.insert(extent(1_000), stream_data(10));
        assert!(cache.get(extent(2)).is_none());
        assert!(Rc::ptr_eq(&cache.get(extent(1)).unwrap(), &first));
        assert_eq!(cache.entries.len(), MAX_CACHED_OBJECT_STREAMS);
    }

    #[test]
    fn object_stream_cache_holds_its_byte_budget_and_keeps_no_stream_above_it() {
        let mut cache = ObjectStreamCache::default();
        let half = OBJECT_STREAM_CACHE_BYTES / 2;
        cache.insert(extent(1), stream_data(half));
        cache.insert(extent(2), stream_data(half - 1));
        assert!(cache.get(extent(1)).is_some());
        cache.insert(extent(3), stream_data(half));
        assert!(cache.get(extent(2)).is_none());
        assert!(cache.bytes <= OBJECT_STREAM_CACHE_BYTES);
        // A stream above the whole budget serves its read and is not kept,
        // nor does it evict what is.
        let large = cache.insert(extent(4), stream_data(OBJECT_STREAM_CACHE_BYTES + 1));
        assert_eq!(large.content.len(), OBJECT_STREAM_CACHE_BYTES + 1);
        assert!(cache.get(extent(4)).is_none());
        assert!(cache.get(extent(1)).is_some() && cache.get(extent(3)).is_some());
        assert!(cache.bytes <= OBJECT_STREAM_CACHE_BYTES);
    }

    #[test]
    fn object_stream_cache_counts_and_trims_what_a_stream_allocated() {
        let mut cache = ObjectStreamCache::default();
        // Ten bytes in a buffer that allocated more than the whole budget.
        let mut content = Vec::with_capacity(OBJECT_STREAM_CACHE_BYTES + 1);
        content.extend_from_slice(&[0; 10]);
        let mut first = HashMap::with_capacity(100_000);
        first.insert(1, 0);
        let data = ObjectStreamData {
            content,
            slots: Vec::with_capacity(100_000),
            first,
        };
        assert!(data.bytes() > OBJECT_STREAM_CACHE_BYTES);
        let kept = cache.insert(extent(1), data);
        assert!(cache.get(extent(1)).is_some());
        assert_eq!(cache.bytes, kept.bytes());
        assert!(cache.bytes < 1_024, "{}", cache.bytes);
    }

    /// Member `index` of object stream `stream` holds `<< /Value ... >>`.
    fn member_number(stream: usize, index: usize) -> u32 {
        1_000 + (stream * 100 + index) as u32
    }

    /// A PDF whose catalog lists, in `order`, members of `streams` object
    /// streams of `members` each, behind a cross-reference stream. Stream `k`
    /// declares its `/Length` through `length(k)`: `None` for a direct one,
    /// or the member whose value holds it.
    fn object_stream_pdf(
        streams: usize,
        members: usize,
        order: &[(usize, usize)],
        length: impl Fn(usize) -> Option<(usize, usize)>,
    ) -> Vec<u8> {
        let mut bodies = (0..streams)
            .map(|stream| {
                (0..members)
                    .map(|index| format!("<< /Value {} >>", member_number(stream, index)))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let encode = |bodies: &[String], number: usize| {
            let mut header = String::new();
            let mut objects = String::new();
            for (index, body) in bodies.iter().enumerate() {
                header.push_str(&format!(
                    "{} {} ",
                    member_number(number, index),
                    objects.len()
                ));
                objects.push_str(body);
                objects.push(' ');
            }
            (header.len(), format!("{header}{objects}"))
        };
        // A member that holds a length is a fixed-width integer, so the
        // lengths measured with placeholders hold once the values are in.
        let holders = (0..streams).filter_map(|stream| Some((stream, length(stream)?)));
        for (_, (holder, index)) in holders.clone() {
            bodies[holder][index] = format!("{:08}", 0);
        }
        let lengths = bodies
            .iter()
            .enumerate()
            .map(|(stream, bodies)| encode(bodies, stream).1.len())
            .collect::<Vec<_>>();
        for (stream, (holder, index)) in holders {
            bodies[holder][index] = format!("{:08}", lengths[stream]);
        }
        let container = |stream: usize| 10 + stream as u32;
        let mut pdf = b"%PDF-1.7\n".to_vec();
        let mut offsets = BTreeMap::new();
        let refs = order
            .iter()
            .map(|(stream, index)| format!("{} 0 R", member_number(*stream, *index)))
            .collect::<Vec<_>>()
            .join(" ");
        for (number, body) in [
            (
                1,
                format!("<< /Type /Catalog /Pages 2 0 R /Refs [{refs}] >>"),
            ),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>".to_string(),
            ),
        ] {
            offsets.insert(number, pdf.len());
            pdf.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
        }
        for (stream, bodies) in bodies.iter().enumerate() {
            let (first, encoded) = encode(bodies, stream);
            let declared = match length(stream) {
                Some((holder, index)) => format!("{} 0 R", member_number(holder, index)),
                None => encoded.len().to_string(),
            };
            offsets.insert(container(stream), pdf.len());
            pdf.extend_from_slice(
                format!(
                    "{} 0 obj\n<< /Type /ObjStm /N {members} /First {first} /Length {declared} >>\nstream\n{encoded}\nendstream\nendobj\n",
                    container(stream)
                )
                .as_bytes(),
            );
        }
        let compressed = (0..streams)
            .flat_map(|stream| {
                (0..members).map(move |index| {
                    (
                        member_number(stream, index),
                        container(stream),
                        index as u16,
                    )
                })
            })
            .collect::<Vec<_>>();
        finish_with_xref_stream(pdf, &offsets, &compressed)
    }

    /// Ends `pdf` with a cross-reference stream listing the objects at
    /// `offsets` and the `compressed` members, as (number, stream, slot).
    fn finish_with_xref_stream(
        mut pdf: Vec<u8>,
        offsets: &BTreeMap<u32, usize>,
        compressed: &[(u32, u32, u16)],
    ) -> Vec<u8> {
        let xref_number = 9_000_u32;
        let xref_offset = pdf.len();
        let mut rows = Vec::new();
        for number in 0..=xref_number {
            let (kind, field, index) = if number == xref_number {
                (1, xref_offset as u64, 0)
            } else if let Some(offset) = offsets.get(&number) {
                (1, *offset as u64, 0)
            } else if let Some((_, container, index)) =
                compressed.iter().find(|(member, ..)| *member == number)
            {
                (2, u64::from(*container), *index)
            } else {
                (0, 0, 0)
            };
            rows.push(kind);
            rows.extend_from_slice(&field.to_be_bytes());
            rows.extend_from_slice(&index.to_be_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "{xref_number} 0 obj\n<< /Type /XRef /Size {} /W [1 8 2] /Root 1 0 R /Length {} >>\nstream\n",
                xref_number + 1,
                rows.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(&rows);
        pdf.extend_from_slice(
            format!("\nendstream\nendobj\nstartxref\n{xref_offset}\n%%EOF\n").as_bytes(),
        );
        pdf
    }

    /// A one-page PDF whose catalog also names object 20, with object
    /// stream 10 holding `header` then `members` as its data.
    fn page_with_object_stream(
        header: &str,
        members: &str,
        compressed: &[(u32, u32, u16)],
    ) -> Vec<u8> {
        let mut pdf = b"%PDF-1.7\n".to_vec();
        let mut offsets = BTreeMap::new();
        let page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>";
        let direct = [
            (1, "<< /Type /Catalog /Pages 2 0 R /Extra 20 0 R >>"),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
            (3, page),
        ];
        for (number, body) in direct {
            if compressed.iter().any(|(member, ..)| *member == number) {
                continue;
            }
            offsets.insert(number, pdf.len());
            pdf.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
        }
        offsets.insert(10, pdf.len());
        let data = format!("{header}{members}");
        pdf.extend_from_slice(
            format!(
                "10 0 obj\n<< /Type /ObjStm /N {} /First {} /Length {} >>\nstream\n",
                header.split_whitespace().count() / 2,
                header.len(),
                data.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(data.as_bytes());
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        finish_with_xref_stream(pdf, &offsets, compressed)
    }

    #[test]
    fn an_object_stream_larger_than_the_cache_serves_its_read_without_being_kept() {
        let pad = "A".repeat(OBJECT_STREAM_CACHE_BYTES + 1);
        let pdf = page_with_object_stream("20 0 ", &format!("<< /Pad ({pad}) >>"), &[(20, 10, 0)]);
        let reader = Reader::new(&pdf[..], pdf.len() as u64).unwrap();
        let index = reader.index().unwrap();
        let mut loader = Loader::new(&reader, &index);
        let member = loader.load((20, 0)).unwrap();
        let read = member
            .as_dict()
            .unwrap()
            .get(b"Pad")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(read.len(), OBJECT_STREAM_CACHE_BYTES + 1);
        assert!(loader.object_streams.entries.is_empty());
        assert_eq!(loader.object_streams.bytes, 0);
        let source = SourcePdf::open(&pdf[..], pdf.len() as u64).unwrap();
        assert!(source.document.get_object((20, 0)).is_ok());
    }

    #[test]
    fn members_of_an_object_stream_too_large_to_keep_are_parsed_from_one_decoding() {
        let pad = "A".repeat(OBJECT_STREAM_CACHE_BYTES + 1);
        let members = format!("<< /Pad ({pad}) /Kids [21 0 R 22 0 R 23 0 R] >> 21 22 23");
        let at = |member: &str| members.rfind(member).unwrap() + 1;
        let header = format!("20 0 21 {} 22 {} 23 {} ", at(" 21"), at(" 22"), at(" 23"));
        let pdf = page_with_object_stream(
            &header,
            &members,
            &[(20, 10, 0), (21, 10, 1), (22, 10, 2), (23, 10, 3)],
        );
        let reader = Reader::new(&pdf[..], pdf.len() as u64).unwrap();
        let index = reader.index().unwrap();
        let mut loader = Loader::new(&reader, &index);
        loader.load((20, 0)).unwrap();
        // The first read parsed every member, kept nothing decoded, and
        // serves the rest without decoding again.
        assert!(loader.prefetched_streams.contains(&10));
        assert_eq!(loader.prefetched.len(), 3);
        assert!(loader.object_streams.entries.is_empty());
        for (number, value) in [(21, 21), (22, 22), (23, 23)] {
            assert_eq!(loader.load((number, 0)).unwrap().as_i64().unwrap(), value);
        }
        assert!(loader.prefetched.is_empty());
        // Each member counted once against the read's ceiling.
        assert_eq!(loader.values, 6 + 3);
    }

    #[test]
    fn a_duplicate_object_stream_entry_that_points_nowhere_hides_no_member() {
        let page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>";
        // Slot 0 lists the page where it is; slot 1, which the cross-reference
        // names, lists it again past the data.
        let pdf = page_with_object_stream("3 0 3 999999 ", page, &[(3, 10, 1)]);
        let source = SourcePdf::open(&pdf[..], pdf.len() as u64).unwrap();
        assert_eq!(source.document.get_pages().len(), 1);
        assert!(read_pdf_document_catalog(&source.document).is_object());
        // The slot the cross-reference names wins over an earlier usable one.
        let other = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] >>";
        let pdf = page_with_object_stream(
            &format!("3 0 3 {} ", page.len() + 1),
            &format!("{page} {other}"),
            &[(3, 10, 1)],
        );
        let source = SourcePdf::open(&pdf[..], pdf.len() as u64).unwrap();
        let media_box = source
            .document
            .get_dictionary((3, 0))
            .unwrap()
            .get(b"MediaBox")
            .unwrap();
        assert_eq!(media_box.as_array().unwrap()[2].as_i64().unwrap(), 20);
    }

    fn member_value(document: &Document, stream: usize, index: usize) -> i64 {
        document
            .get_dictionary((member_number(stream, index), 0))
            .and_then(|member| member.get(b"Value"))
            .and_then(Object::as_i64)
            .unwrap()
    }

    #[test]
    fn members_of_more_object_streams_than_the_cache_holds_read_in_any_order() {
        let streams = MAX_CACHED_OBJECT_STREAMS + 6;
        // Consecutive reads alternate between streams, so each finds its
        // stream evicted and decodes it again.
        let order = (0..3)
            .flat_map(|index| (0..streams).map(move |stream| (stream, index)))
            .collect::<Vec<_>>();
        let pdf = object_stream_pdf(streams, 3, &order, |_| None);
        let source = SourcePdf::open(&pdf[..], pdf.len() as u64).unwrap();
        let eager = Document::load_mem(&pdf).unwrap();
        for &(stream, index) in &order {
            let value = i64::from(member_number(stream, index));
            assert_eq!(member_value(&source.document, stream, index), value);
            assert_eq!(member_value(&eager, stream, index), value);
        }
    }

    #[test]
    fn an_object_stream_whose_length_it_holds_itself_reads_by_its_end() {
        let pdf = object_stream_pdf(2, 3, &[(0, 0), (1, 2)], |stream| {
            (stream == 0).then_some((0, 1))
        });
        let source = SourcePdf::open(&pdf[..], pdf.len() as u64).unwrap();
        assert_eq!(member_value(&source.document, 0, 0), 1_000);
        assert_eq!(member_value(&source.document, 1, 2), 1_102);
    }

    #[test]
    fn object_stream_lengths_held_in_a_chain_of_streams_stop_at_their_nesting_ceiling() {
        // Stream k keeps its /Length in stream k + 1; the last one is direct.
        let chain = |streams: usize| {
            object_stream_pdf(streams, 2, &[(0, 0)], move |stream| {
                (stream + 1 < streams).then_some((stream + 1, 1))
            })
        };
        let shallow = chain(MAX_OBJECT_STREAM_NESTING);
        let source = SourcePdf::open(&shallow[..], shallow.len() as u64).unwrap();
        assert_eq!(member_value(&source.document, 0, 0), 1_000);
        let deep = chain(MAX_OBJECT_STREAM_NESTING + 2);
        let error = SourcePdf::open(&deep[..], deep.len() as u64).err().unwrap();
        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::CorruptXref
        );
    }

    #[test]
    fn streams_a_catalog_reaches_are_read_but_not_its_pages_or_mapped_objects() {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let content = document.add_object(Stream::new(Dictionary::new(), b"page".to_vec()));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content,
            "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
        });
        document.set_object(
            pages_id,
            dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 },
        );
        let metadata = document.add_object(Stream::new(
            dictionary! { "Type" => "Metadata" },
            b"<x:xmpmeta/>".to_vec(),
        ));
        let catalog = document.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id, "Metadata" => metadata,
        });
        document.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let source = SourcePdf::open(&bytes[..], bytes.len() as u64).unwrap();
        let root = source.document.trailer.get(b"Root").unwrap().clone();
        let read = |mapped: &dyn Fn(ObjectId) -> bool, max_bytes| {
            let mut copy = source.document.clone();
            source
                .read_streams_into(&mut copy, &root, mapped, max_bytes)
                .map(|()| copy)
        };
        let copy = read(&|_| false, 1_024).unwrap();
        let stream = |id| copy.get_object(id).unwrap().as_stream().unwrap();
        assert_eq!(stream(metadata).content, b"<x:xmpmeta/>");
        assert!(stream(content).content.is_empty());
        // An object the copy maps elsewhere is neither read nor charged.
        let copy = read(&|id| id == metadata, 0).unwrap();
        assert!(copy
            .get_object(metadata)
            .unwrap()
            .as_stream()
            .unwrap()
            .content
            .is_empty());
        let error = read(&|_| false, 4).unwrap_err();
        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::TooLarge
        );
    }

    #[test]
    fn strict_verify_rejects_duplicate_dictionary_keys_and_bad_stream_lengths() {
        let dup_pdf = include_bytes!("../tests/fixtures/page-engine/duplicate-info-dates.pdf");
        assert!(
            SourcePdf::open(&dup_pdf[..], dup_pdf.len() as u64).is_ok(),
            "normal open tolerates duplicate dictionary keys"
        );
        let dup_err = SourcePdf::open_strict_verify(&dup_pdf[..], dup_pdf.len() as u64)
            .err()
            .expect("strict verify must reject duplicate dictionary keys");
        assert!(
            dup_err.to_string().contains("duplicate dictionary key"),
            "unexpected strict verify error: {dup_err}"
        );

        // Stream with declared /Length 50 but actual data is 4 bytes ("test").
        let mut bad_stream = b"%PDF-1.7\n".to_vec();
        let o1 = bad_stream.len();
        bad_stream.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        let o2 = bad_stream.len();
        bad_stream
            .extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
        let o3 = bad_stream.len();
        bad_stream.extend_from_slice(
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>\nendobj\n",
        );
        let o4 = bad_stream.len();
        bad_stream
            .extend_from_slice(b"4 0 obj\n<< /Length 50 >>\nstream\ntest\nendstream\nendobj\n");
        let xref = bad_stream.len();
        bad_stream.extend_from_slice(
            format!(
                "xref\n0 5\n0000000000 65535 f \n{o1:010} 00000 n \n{o2:010} 00000 n \n{o3:010} 00000 n \n{o4:010} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
            )
            .as_bytes(),
        );
        assert!(
            SourcePdf::open_strict_verify(&bad_stream[..], bad_stream.len() as u64).is_err(),
            "strict verify must reject a mismatched declared stream /Length"
        );

        // Stream with trailing junk glued onto endstream ("endstreamJUNK") or missing endobj.
        let make_stream_ending_pdf = |ending: &[u8]| {
            let mut pdf = b"%PDF-1.7\n".to_vec();
            let o1 = pdf.len();
            pdf.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
            let o2 = pdf.len();
            pdf.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
            let o3 = pdf.len();
            pdf.extend_from_slice(
                b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>\nendobj\n",
            );
            let o4 = pdf.len();
            pdf.extend_from_slice(b"4 0 obj\n<< /Length 4 >>\nstream\ntest\n");
            pdf.extend_from_slice(ending);
            let xref = pdf.len();
            pdf.extend_from_slice(
                format!(
                    "xref\n0 5\n0000000000 65535 f \n{o1:010} 00000 n \n{o2:010} 00000 n \n{o3:010} 00000 n \n{o4:010} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
                )
                .as_bytes(),
            );
            pdf
        };
        let valid_ending = make_stream_ending_pdf(b"endstream\nendobj\n");
        assert!(
            SourcePdf::open_strict_verify(&valid_ending[..], valid_ending.len() as u64).is_ok(),
            "strict verify must accept a valid endstream/endobj ending"
        );
        let junk_ending = make_stream_ending_pdf(b"endstreamJUNK\nendobj\n");
        assert!(
            SourcePdf::open_strict_verify(&junk_ending[..], junk_ending.len() as u64).is_err(),
            "strict verify must reject endstreamJUNK"
        );
        let missing_endobj = make_stream_ending_pdf(b"endstream\n");
        assert!(
            SourcePdf::open_strict_verify(&missing_endobj[..], missing_endobj.len() as u64)
                .is_err(),
            "strict verify must reject stream missing endobj"
        );
    }
}
