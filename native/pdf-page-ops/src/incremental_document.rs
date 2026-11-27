use super::*;

/// Where a base read through the indexed reader reads the streams it left
/// unread: their byte ranges in its source.
pub(crate) type StructuralSource<'a> = &'a dyn RawStreamSource;

/// A source that reads a stream's encoded bytes, as the file holds them.
pub(crate) trait RawStreamSource {
    fn raw_stream(&self, object_id: ObjectId, max_bytes: usize) -> Result<Vec<u8>>;
}

#[derive(Debug, Clone)]
pub(crate) struct IncrementalDocument {
    previous_len: u64,
    previous_last_byte: Option<u8>,
    /// The terminal cross-reference offset the appended revision names as `/Prev`.
    previous_xref_start: u64,
    pub(crate) previous_document: Document,
    pub(crate) unavailable_base_streams: HashSet<ObjectId>,
    /// Present only for a page-local load, which retains just the touched
    /// page dictionaries and their inherited-attribute ancestors, so it has no
    /// page tree to walk: the pages it located by number.
    pub(crate) located_pages: Option<LocatedPages>,
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
            previous_xref_start: document.xref_start as u64,
            previous_document: document,
            unavailable_base_streams: HashSet::new(),
            located_pages: None,
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

    /// The base of an append read through the indexed reader, whose streams
    /// `unread` stay in the file. Each stands in as its dictionary with no bytes
    /// at position 0, and is unavailable until read: never mistaken for an empty
    /// stream. Offsets stay `u64`, so a base past 4 GiB keeps its `/Prev` on
    /// wasm32 too.
    pub(crate) fn from_indexed_document(
        mut document: Document,
        previous_len: u64,
        previous_last_byte: Option<u8>,
        previous_xref_start: u64,
        unread: impl IntoIterator<Item = ObjectId>,
    ) -> Result<Self> {
        let mut unavailable_base_streams = HashSet::new();
        for id in unread {
            if let Ok(Object::Stream(stream)) = document.get_object_mut(id) {
                stream.start_position = Some(0);
                unavailable_base_streams.insert(id);
            }
        }
        document.xref_start = 0;
        let mut incremental = Self::from_document(document, previous_len, previous_last_byte);
        incremental.previous_xref_start = previous_xref_start;
        incremental
            .new_document
            .trailer
            .set("Prev", i64::try_from(previous_xref_start)?);
        incremental.unavailable_base_streams = unavailable_base_streams;
        Ok(incremental)
    }

    pub(crate) fn get_prev_documents(&self) -> &Document {
        &self.previous_document
    }

    pub(crate) fn previous_xref_start(&self) -> u64 {
        self.previous_xref_start
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
                transient.set_content(source.raw_stream(object_id, max_bytes)?);
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
        source: StructuralSource<'_>,
        object_id: ObjectId,
        max_bytes: usize,
    ) -> Result<()> {
        if !self.unavailable_base_streams.contains(&object_id) {
            return Ok(());
        }
        let bytes = source.raw_stream(object_id, max_bytes)?;
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

/// What a fresh reader sees after an incremental append: the objects the
/// appended revision rewrote, over the base revision that is still in memory.
/// An `IncrementalDocument` is this view of itself; this form pairs two
/// documents that are not held in one.
pub(crate) struct AppendedRevision<'a> {
    base: &'a Document,
    appended: &'a Document,
}

impl<'a> AppendedRevision<'a> {
    pub(crate) fn from_documents(base: &'a Document, appended: &'a Document) -> Self {
        Self { base, appended }
    }
}

fn overlay_object<'a>(
    base: &'a Document,
    appended: &'a Document,
    object_id: ObjectId,
) -> Option<&'a Object> {
    appended
        .objects
        .get(&object_id)
        .or_else(|| base.objects.get(&object_id))
}

/// Appends rewrite page dictionaries, the catalog and annotation objects but
/// never restructure the page tree, so page identity comes from the base
/// revision. A mutation that adds or removes pages would have to walk the
/// appended tree instead. A page-local base holds only the pages it located,
/// by number.
fn overlay_page_ids(base: &Document, located: Option<&LocatedPages>) -> BTreeMap<u32, ObjectId> {
    match located {
        Some(located) => located
            .ids
            .iter()
            .map(|(index, page_id)| (index + 1, *page_id))
            .collect(),
        None => base.get_pages(),
    }
}

impl PdfObjectSource for AppendedRevision<'_> {
    fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
        overlay_object(self.base, self.appended, object_id)
    }

    fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
        overlay_page_ids(self.base, None)
    }

    fn root_id(&self) -> Result<ObjectId> {
        Ok(self.appended.trailer.get(b"Root")?.as_reference()?)
    }
}

impl PdfObjectSource for IncrementalDocument {
    fn located_pages(&self) -> Option<&LocatedPages> {
        self.located_pages.as_ref()
    }

    fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
        overlay_object(&self.previous_document, &self.new_document, object_id)
    }

    fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
        overlay_page_ids(&self.previous_document, self.located_pages.as_ref())
    }

    fn root_id(&self) -> Result<ObjectId> {
        Ok(self.new_document.trailer.get(b"Root")?.as_reference()?)
    }
}

impl PdfObjectStore for IncrementalDocument {
    fn object_mut(&mut self, object_id: ObjectId) -> Result<&mut Object> {
        self.opt_clone_object_to_new_document(object_id)?;
        Ok(self.new_document.get_object_mut(object_id)?)
    }

    fn delete_object(&mut self, object_id: ObjectId) {
        self.new_document.set_object(object_id, Object::Null);
    }

    fn stored_objects(&self) -> impl Iterator<Item = (ObjectId, &Object)> {
        let appended = &self.new_document.objects;
        appended.iter().map(|(id, object)| (*id, object)).chain(
            self.previous_document
                .objects
                .iter()
                .filter(|(id, _)| !appended.contains_key(id))
                .map(|(id, object)| (*id, object)),
        )
    }

    fn max_id(&self) -> u32 {
        self.new_document.max_id
    }

    fn new_object_id(&mut self) -> ObjectId {
        self.new_document.new_object_id()
    }

    fn put_object(&mut self, object_id: ObjectId, object: Object) {
        self.new_document.put_object(object_id, object);
    }
}

#[cfg(test)]
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
    fn indexed_base_reads_indirect_inherited_rotate_values() {
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
        let mut bytes = Vec::new();
        source.save_to(&mut bytes).unwrap();

        let mut incremental = SourcePdf::open_append_base(&bytes[..], bytes.len() as u64)
            .and_then(|mut source| source.take_append_base())
            .unwrap();
        assert_eq!(
            resolve_page_rotation(incremental.get_prev_documents(), page_id).unwrap(),
            270
        );

        rotate_pages(
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

    #[test]
    fn materialized_stream_updates_declared_length_before_clone_and_save() {
        struct Recovered;
        impl RawStreamSource for Recovered {
            fn raw_stream(&self, _: ObjectId, _: usize) -> Result<Vec<u8>> {
                Ok(b"recovered bytes".to_vec())
            }
        }
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
            .materialize_base_stream(&Recovered, stream_id, 1024)
            .unwrap();
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
}
