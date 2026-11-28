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

    /// Advances this append base in place after `revision_bytes` has been
    /// written and verified, updating only the objects written in the revision
    /// (O(batch) instead of rescanning every untouched base stream).
    pub(crate) fn advance_verified_revision(
        &mut self,
        new_len: u64,
        new_last_byte: Option<u8>,
        new_xref_start: u64,
        wrote_xref_stream: bool,
    ) -> Result<()> {
        let pending = std::mem::take(&mut self.new_document);
        let combined_max_id = pending.max_id.max(self.previous_document.max_id);
        let next_max_id = if wrote_xref_stream {
            combined_max_id
                .checked_add(1)
                .ok_or("PDF object number overflow")?
        } else {
            combined_max_id
        };
        self.previous_document.max_id = next_max_id;
        self.previous_document.reference_table = lopdf::xref::Xref::new(
            next_max_id.saturating_add(1),
            if wrote_xref_stream {
                lopdf::xref::XrefType::CrossReferenceStream
            } else {
                lopdf::xref::XrefType::CrossReferenceTable
            },
        );
        for (object_id, mut object) in pending.objects {
            if !should_write_incremental_object(&object) {
                continue;
            }
            if let Object::Stream(ref mut stream) = object {
                stream.content.clear();
                stream.content.shrink_to_fit();
                stream.start_position = Some(0);
                self.unavailable_base_streams.insert(object_id);
            } else {
                self.unavailable_base_streams.remove(&object_id);
            }
            self.previous_document.objects.insert(object_id, object);
        }
        let mut next_trailer = pending.trailer;
        for key in [
            b"Prev".as_slice(),
            b"Size",
            b"Type",
            b"W",
            b"Index",
            b"Length",
            b"Filter",
            b"DecodeParms",
        ] {
            next_trailer.remove(key);
        }
        self.previous_document.trailer = next_trailer;
        self.previous_len = new_len;
        self.previous_last_byte = new_last_byte;
        self.previous_xref_start = new_xref_start;
        self.new_document = Document::new_from_prev(&self.previous_document);
        self.new_document
            .trailer
            .set("Prev", i64::try_from(new_xref_start)?);
        Ok(())
    }

    /// Discards pending changes in `new_document`, restoring a clean revision
    /// anchored at `previous_xref_start`.
    pub(crate) fn reset_pending_revision(&mut self) -> Result<()> {
        let previous_xref_start = self.previous_xref_start;
        self.new_document = Document::new_from_prev(&self.previous_document);
        self.new_document
            .trailer
            .set("Prev", i64::try_from(previous_xref_start)?);
        Ok(())
    }

    /// Verifies that appending `revision_bytes` stays within the indexed
    /// reader's cumulative cross-reference section, offset, entry, and value
    /// limits, advancing `budget` on success.
    pub(crate) fn check_xref_budget(
        &self,
        budget: &mut crate::pdf_source::IndexedXrefBudget,
        revision_bytes: &[u8],
        expected_object_ids: &[ObjectId],
    ) -> Result<()> {
        if revision_bytes.is_empty() {
            return Ok(());
        }
        let new_xref_start = parse_number_after_last_marker(revision_bytes, b"startxref")
            .ok_or("Appended incremental revision is missing startxref")?;
        let was_xref_stream = matches!(
            self.get_prev_documents()
                .reference_table
                .cross_reference_type,
            lopdf::xref::XrefType::CrossReferenceStream
        );
        let wrote_xref_stream = was_xref_stream || new_xref_start > MAX_CLASSIC_XREF_OFFSET;
        let previous_objects = &self.get_prev_documents().objects;
        let new_objects = &self.new_document.objects;
        let mut new_object_numbers = 0usize;
        let mut net_value_delta = 0isize;
        let reopened_value_count = |object: &Object| -> isize {
            let stream_length_extra = usize::from(
                matches!(object, Object::Stream(stream) if !stream.dict.has(b"Length")),
            );
            (crate::pdf_source::object_value_count(object) + stream_length_extra) as isize
        };
        for id in expected_object_ids {
            let Some(new_obj) = new_objects.get(id) else {
                continue;
            };
            if object_exceeds_nesting_limit(new_obj, MAX_PDF_STRUCTURAL_NESTING) {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    format!(
                        "PDF object {} {} exceeds the {MAX_PDF_STRUCTURAL_NESTING}-level nesting ceiling",
                        id.0, id.1
                    ),
                ));
            }
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

    /// Advances this append base in place from verified `revision_bytes`,
    /// resetting pending state when the revision is empty.
    pub(crate) fn advance_verified_revision_bytes(&mut self, revision_bytes: &[u8]) -> Result<()> {
        if revision_bytes.is_empty() {
            return self.reset_pending_revision();
        }
        let new_len = self
            .previous_len
            .checked_add(u64::try_from(revision_bytes.len())?)
            .ok_or("Incremental output size overflow")?;
        let new_last_byte = revision_bytes.last().copied();
        let new_xref_start = parse_number_after_last_marker(revision_bytes, b"startxref")
            .ok_or("Appended incremental revision is missing startxref")?;
        let was_xref_stream = matches!(
            self.get_prev_documents()
                .reference_table
                .cross_reference_type,
            lopdf::xref::XrefType::CrossReferenceStream
        );
        let wrote_xref_stream = was_xref_stream || new_xref_start > MAX_CLASSIC_XREF_OFFSET;
        self.advance_verified_revision(new_len, new_last_byte, new_xref_start, wrote_xref_stream)
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

/// Returns true if any direct value inside `object` sits deeper than
/// `max_depth`, matching `pdf_source.rs`'s structural parser depth limit.
fn object_exceeds_nesting_limit(object: &Object, max_depth: usize) -> bool {
    let mut stack = vec![(object, 0usize)];
    while let Some((current, depth)) = stack.pop() {
        if depth > max_depth {
            return true;
        }
        match current {
            Object::Array(items) => {
                for item in items {
                    stack.push((item, depth + 1));
                }
            }
            Object::Dictionary(dictionary) => {
                for (_, value) in dictionary.iter() {
                    stack.push((value, depth + 1));
                }
            }
            Object::Stream(stream) => {
                for (_, value) in stream.dict.iter() {
                    stack.push((value, depth + 1));
                }
            }
            _ => {}
        }
    }
    false
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
        None => crate::pdf_source::collect_document_pages(base),
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

    #[test]
    fn advance_verified_revision_bytes_resets_empty_revision_without_changing_anchor() {
        let mut document = Document::with_version("1.5");
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
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let mut source = SourcePdf::open_append_base(bytes.as_slice(), bytes.len() as u64).unwrap();
        let mut incremental = source.take_append_base().unwrap();
        let initial_len = incremental.previous_len();
        let initial_xref = incremental.previous_xref_start();
        let initial_max_id = incremental.previous_document.max_id;

        // Add a non-emitted object, then advance with empty revision bytes.
        let scratch_id = incremental.new_document.add_object(dictionary! {
            "Type" => "ObjStm",
        });
        assert!(incremental.new_document.has_object(scratch_id));
        incremental.advance_verified_revision_bytes(&[]).unwrap();

        assert_eq!(incremental.previous_len(), initial_len);
        assert_eq!(incremental.previous_xref_start(), initial_xref);
        assert_eq!(incremental.previous_document.max_id, initial_max_id);
        assert!(!incremental.new_document.has_object(scratch_id));
        assert_eq!(
            incremental
                .new_document
                .trailer
                .get(b"Prev")
                .unwrap()
                .as_i64()
                .unwrap(),
            initial_xref as i64
        );
    }

    #[test]
    fn check_xref_budget_rejects_emitted_objects_exceeding_structural_nesting_limit() {
        let mut document = Document::with_version("1.5");
        document.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
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
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let make_nested_dict = |levels: usize| {
            let mut value = Object::Integer(1);
            for _ in 0..levels {
                value = Object::Dictionary(dictionary! { "N" => value });
            }
            value
        };

        // Exactly MAX_PDF_STRUCTURAL_NESTING (256) levels from root to leaf is allowed.
        let mut source = SourcePdf::open_append_base(bytes.as_slice(), bytes.len() as u64).unwrap();
        let mut budget = source.xref_budget();
        let mut inc_ok = source.take_append_base().unwrap();
        let ok_id = inc_ok
            .new_document
            .add_object(make_nested_dict(MAX_PDF_STRUCTURAL_NESTING));
        let ok_rev = build_incremental_revision(&mut inc_ok).unwrap();
        inc_ok
            .check_xref_budget(&mut budget, &ok_rev, &[ok_id])
            .expect("depth == MAX_PDF_STRUCTURAL_NESTING must pass");

        // MAX_PDF_STRUCTURAL_NESTING + 1 (257) levels must be refused before publishing.
        let mut source2 =
            SourcePdf::open_append_base(bytes.as_slice(), bytes.len() as u64).unwrap();
        let mut budget2 = source2.xref_budget();
        let mut inc_too_deep = source2.take_append_base().unwrap();
        let deep_id = inc_too_deep
            .new_document
            .add_object(make_nested_dict(MAX_PDF_STRUCTURAL_NESTING + 1));
        let deep_rev = build_incremental_revision(&mut inc_too_deep).unwrap();
        let err = inc_too_deep
            .check_xref_budget(&mut budget2, &deep_rev, &[deep_id])
            .expect_err("depth > MAX_PDF_STRUCTURAL_NESTING must be refused");
        assert_eq!(
            err.downcast_ref::<NativeError>().map(|e| e.code),
            Some(NativeErrorCode::TooLarge)
        );
    }
}
