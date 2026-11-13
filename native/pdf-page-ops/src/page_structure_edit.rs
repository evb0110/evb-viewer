use super::*;

#[derive(Clone, Copy)]
pub(crate) struct PageCloneSource {
    pub(crate) document_index: usize,
    pub(crate) page_id: ObjectId,
}

pub(crate) struct PageCloneContext<'a> {
    pub(crate) sources: Vec<&'a Document>,
    pub(crate) target: Document,
    pub(crate) pages_id: ObjectId,
    pub(crate) object_map: HashMap<(usize, ObjectId), ObjectId>,
    completed_pages: HashSet<(usize, ObjectId)>,
    pending_objects: Vec<(usize, ObjectId, ObjectId)>,
}

struct BrowserPageLabelRange {
    start_page: i64,
    prefix: Option<String>,
    style: Option<Vec<u8>>,
    start_number: i64,
}

const MAX_BROWSER_PAGE_LABEL_NUMBER: i64 = 1_000_000_000;

pub(crate) fn validate_browser_page_numbers(
    pages: &[u32],
    label: &str,
    document_page_count: u32,
    require_unique: bool,
    require_permutation: bool,
) -> Result<HashSet<u32>> {
    if pages.is_empty() {
        return Err(format!("{label}: must be a non-empty array of page numbers").into());
    }

    let mut page_set = HashSet::new();
    for page in pages {
        if *page == 0 {
            return Err(format!("{label}: invalid page number {page}").into());
        }
        if *page > document_page_count {
            return Err(format!(
                "{label}: page number {page} is out of range 1-{document_page_count}"
            )
            .into());
        }
        if require_unique && !page_set.insert(*page) {
            return Err(format!("{label}: duplicate page number {page}").into());
        }
    }

    if require_permutation {
        for page_number in 1..=document_page_count {
            if !page_set.contains(&page_number) {
                return Err(
                    format!("{label}: missing page {page_number} in reorder payload").into(),
                );
            }
        }
    }

    Ok(page_set)
}

/// What a page-structure edit does; its first input is the document edited.
#[derive(Clone, Copy)]
pub(crate) enum PageStructureEdit<'a> {
    Delete(&'a [u32]),
    Extract(&'a [u32]),
    Reorder(&'a [u32]),
    Insert { after_page: u32 },
    Merge,
}

/// A page-structure output before it is written: its objects, and for each
/// copied object the source object it copies, whose stream data the writer
/// takes from the source by byte range.
pub(crate) struct PageSubset {
    pub(crate) document: Document,
    origins: HashMap<ObjectId, (usize, ObjectId)>,
    pub(crate) page_count: u32,
}

impl PageSubset {
    pub(crate) fn write<S: ByteSource, W: Write>(
        &self,
        sources: &[SourcePdf<S>],
        output: W,
    ) -> Result<W> {
        write_document(
            &self.document,
            |id| {
                let (index, source_id) = self.origins.get(&id)?;
                sources.get(*index)?.stream_range(*source_id)
            },
            output,
        )
    }
}

pub(crate) fn edit_page_structure<S>(
    edit: PageStructureEdit,
    sources: &[SourcePdf<S>],
) -> Result<PageSubset> {
    let documents = sources
        .iter()
        .map(|source| &source.document)
        .collect::<Vec<_>>();
    let (document, others) = documents
        .split_first()
        .ok_or("A page-structure edit needs an input PDF")?;
    let single = |label: &str| {
        if others.is_empty() {
            Ok(&documents[..1])
        } else {
            Err(format!("{label}: takes one input PDF"))
        }
    };
    let source_pages = document.get_pages();
    let page_count = source_pages.len() as u32;
    let selected = |pages: &[u32]| {
        pages
            .iter()
            .map(|page_number| {
                Ok(PageCloneSource {
                    document_index: 0,
                    page_id: resolve_page_id(&source_pages, *page_number)?,
                })
            })
            .collect::<Result<Vec<_>>>()
    };
    let primary = |page_id: &ObjectId| PageCloneSource {
        document_index: 0,
        page_id: *page_id,
    };
    match edit {
        PageStructureEdit::Delete(pages) => {
            let sources = single("deletePages")?;
            let removed =
                validate_browser_page_numbers(pages, "deletePages", page_count, true, false)?;
            if removed.len() == source_pages.len() {
                return Err("deletePages: cannot delete every page".into());
            }
            let kept = source_pages
                .iter()
                .filter(|(page_number, _)| !removed.contains(page_number))
                .map(|(_, page_id)| primary(page_id))
                .collect::<Vec<_>>();
            page_subset(sources, &kept)
        }
        PageStructureEdit::Extract(pages) => {
            let sources = single("extractPages")?;
            validate_browser_page_numbers(pages, "extractPages", page_count, true, false)?;
            page_subset(sources, &selected(pages)?)
        }
        PageStructureEdit::Reorder(pages) => {
            let sources = single("reorderPages")?;
            validate_browser_page_numbers(pages, "reorderPages", page_count, true, true)?;
            page_subset(sources, &selected(pages)?)
        }
        PageStructureEdit::Insert { after_page } => {
            let [insertion] = others else {
                return Err("insertPages: takes the document and one insertion PDF".into());
            };
            read_pdf_combine_catalog(*insertion)?;
            if after_page > page_count {
                return Err("Invalid afterPage".into());
            }
            let (before, after): (Vec<_>, Vec<_>) = source_pages
                .iter()
                .partition(|(page_number, _)| **page_number <= after_page);
            let sequence = before
                .into_iter()
                .map(|(_, page_id)| primary(page_id))
                .chain(
                    insertion
                        .get_pages()
                        .values()
                        .map(|page_id| PageCloneSource {
                            document_index: 1,
                            page_id: *page_id,
                        }),
                )
                .chain(after.into_iter().map(|(_, page_id)| primary(page_id)))
                .collect::<Vec<_>>();
            page_subset(&documents, &sequence)
        }
        PageStructureEdit::Merge => merge_pages(&documents),
    }
}

/// Every page of every input in order, each input's outline and page labels
/// offset to its pages.
fn merge_pages(documents: &[&Document]) -> Result<PageSubset> {
    let catalogs = documents
        .iter()
        .map(|document| read_pdf_combine_catalog(*document))
        .collect::<Result<Vec<_>>>()?;
    let mut sequence = Vec::new();
    for (document_index, document) in documents.iter().enumerate() {
        sequence.extend(
            document
                .get_pages()
                .into_values()
                .map(|page_id| PageCloneSource {
                    document_index,
                    page_id,
                }),
        );
    }
    let mut merged = page_subset(documents, &sequence)?;
    let mut page_offset = 0u32;
    let mut bookmarks = Vec::new();
    let mut page_labels = Vec::new();
    for (document, mut catalog) in documents.iter().zip(catalogs) {
        let pages = document.get_pages().len() as u32;
        add_implicit_default_page_label_range(&mut catalog.page_labels, pages);
        bookmarks.extend(
            catalog
                .bookmarks
                .into_iter()
                .map(|bookmark| offset_bookmark(bookmark, page_offset)),
        );
        page_labels.extend(catalog.page_labels.into_iter().map(|range| {
            PageLabelRange {
                start_page: range
                    .page_index
                    .saturating_add(page_offset)
                    .saturating_add(1),
                style: range.style,
                prefix: range.prefix.unwrap_or_default(),
                start_number: range.start.unwrap_or(1),
            }
        }));
        page_offset = page_offset.saturating_add(pages);
    }
    set_page_labels(
        &mut merged.document,
        &PageLabelsMutation {
            total_pages: merged.page_count,
            ranges: page_labels,
        },
        false,
    )?;
    set_bookmarks(
        &mut merged.document,
        &BookmarksMutation {
            total_pages: merged.page_count,
            untitled_label: "Untitled".to_string(),
            items: bookmarks,
        },
        None,
    )?;
    merged.document.prune_objects();
    Ok(merged)
}

fn offset_bookmark(mut bookmark: BookmarkEntry, page_offset: u32) -> BookmarkEntry {
    use evb_native_support::pdf_catalog::BookmarkSourceTarget::PageIndex;
    if let Some(index) = &mut bookmark.page_index {
        *index = index.saturating_add(page_offset);
    }
    if let Some(PageIndex(index)) = bookmark
        .original_destination
        .as_mut()
        .map(|destination| &mut destination.source_target)
    {
        *index = index.saturating_add(page_offset);
    }
    bookmark.items = bookmark
        .items
        .into_iter()
        .map(|item| offset_bookmark(item, page_offset))
        .collect();
    bookmark
}

/// Edits PDFs on disk into a new file published at `output` only once whole.
pub(crate) fn write_page_structure_path(
    edit: PageStructureEdit,
    inputs: &[PathBuf],
    output: &Path,
) -> Result<()> {
    use evb_native_support::output::AtomicOutput;
    let sources = inputs
        .iter()
        .map(|path| {
            let file = File::open(path).map_err(io_domain_error)?;
            let len = file.metadata().map_err(io_domain_error)?.len();
            SourcePdf::open(file, len)
        })
        .collect::<Result<Vec<_>>>()?;
    let subset = edit_page_structure(edit, &sources)?;
    let staged = AtomicOutput::create(output).map_err(io_domain_error)?;
    subset
        .write(
            &sources,
            std::io::BufWriter::with_capacity(1 << 20, staged.file().map_err(io_domain_error)?),
        )?
        .into_inner()
        .map_err(|error| io_domain_error(error.into_error()))?;
    // Windows cannot replace a file this process still holds open.
    drop(sources);
    staged.publish().map_err(io_domain_error)
}

fn page_subset(sources: &[&Document], page_sequence: &[PageCloneSource]) -> Result<PageSubset> {
    if page_sequence.is_empty() {
        return Err("A page subset must contain at least one page".into());
    }

    let mut target = Document::with_version(
        sources
            .iter()
            .map(|document| document.version.as_str())
            .max()
            .unwrap_or("1.4"),
    );
    let pages_id = target.new_object_id();
    let mut clone_context = PageCloneContext {
        sources: sources.to_vec(),
        target,
        pages_id,
        object_map: HashMap::new(),
        completed_pages: HashSet::new(),
        pending_objects: Vec::new(),
    };
    for source in page_sequence {
        clone_context
            .object_map
            .entry((source.document_index, source.page_id))
            .or_insert_with(|| clone_context.target.new_object_id());
    }
    let page_ids = page_sequence
        .iter()
        .map(|source| clone_context.clone_page(*source))
        .collect::<Result<Vec<_>>>()?;

    let kids = page_ids
        .iter()
        .copied()
        .map(Object::Reference)
        .collect::<Vec<_>>();
    clone_context.target.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => page_ids.len() as u32,
        }
        .into(),
    );
    let mut catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    };
    preserve_single_source_document_metadata(&mut clone_context, 0, page_sequence, &mut catalog)?;
    if sources.len() == 1 {
        let source = sources[0];
        let mut annotations = crate::split_output::SplitAnnotationMap::new();
        for page in page_sequence {
            let output_page = clone_context.object_map[&(0, page.page_id)];
            for entry in crate::split_navigation::source_annotation_entries(source, page.page_id) {
                if let Some(id) = source.dereference(&entry)?.0 {
                    let copy = *clone_context
                        .object_map
                        .get(&(0, id))
                        .ok_or("Retained annotation was not cloned")?;
                    annotations.entry(id).or_default().push((output_page, copy));
                }
            }
        }
        let identities = &clone_context.object_map;
        let form = crate::split_catalog::split_forms::split_form_with_copy(
            source,
            &mut clone_context.target,
            &annotations,
            &mut |object| {
                map_page_object_references(object, None, &mut |id| {
                    if let Some(copy) = identities.get(&(0, id)) {
                        return Ok(Object::Reference(*copy));
                    }
                    // Removed page/tree references were nulled by the worklist cloner.
                    if source
                        .get_dictionary(id)
                        .ok()
                        .and_then(|dict| {
                            dict.get(b"Type")
                                .ok()
                                .and_then(|value| value.as_name().ok())
                        })
                        .is_some_and(|kind| matches!(kind, b"Page" | b"Pages"))
                    {
                        return Ok(Object::Null);
                    }
                    Err("Form property was not cloned".into())
                })
            },
        )?;
        if let Some(form) = form {
            catalog.set("AcroForm", form);
        }
    }
    let catalog_id = clone_context.target.add_object(catalog);
    clone_context.target.trailer.set("Root", catalog_id);
    for (id, object) in crate::split_catalog::page_structure_updates(&clone_context.target)? {
        clone_context.target.set_object(id, object);
    }
    clone_context.target.prune_objects();

    Ok(PageSubset {
        page_count: page_ids.len() as u32,
        origins: clone_context
            .object_map
            .into_iter()
            .map(|(source, target)| (target, source))
            .collect(),
        document: clone_context.target,
    })
}

pub(crate) fn preserve_single_source_document_metadata(
    clone_context: &mut PageCloneContext,
    source_index: usize,
    page_sequence: &[PageCloneSource],
    catalog: &mut Dictionary,
) -> Result<()> {
    let source_document = clone_context.source(source_index)?;
    let source_catalog = source_document.catalog()?.clone();
    for (key, value) in source_catalog.iter() {
        if matches!(key.as_slice(), b"Type" | b"Pages" | b"PageLabels") {
            continue;
        }
        catalog.set(
            key.clone(),
            clone_context.clone_object_references(source_index, value.clone())?,
        );
    }

    let source_info = clone_context
        .source(source_index)?
        .trailer
        .get(b"Info")
        .ok()
        .cloned();
    match source_info {
        Some(Object::Reference(info_id)) => {
            let new_info_id = clone_context.clone_indirect_object(source_index, info_id)?;
            clone_context.target.trailer.set("Info", new_info_id);
        }
        Some(info) => {
            let info = clone_context.clone_object_references(source_index, info)?;
            clone_context.target.trailer.set("Info", info);
        }
        None => {}
    }

    if let Ok(page_labels) = source_catalog.get(b"PageLabels") {
        catalog.set(
            "PageLabels",
            remap_browser_page_labels(clone_context, source_index, page_sequence, page_labels)?,
        );
    }

    Ok(())
}

fn remap_browser_page_labels(
    clone_context: &PageCloneContext,
    source_index: usize,
    page_sequence: &[PageCloneSource],
    page_labels: &Object,
) -> Result<Object> {
    let source = clone_context.source(source_index)?;
    let source_page_numbers = source
        .get_pages()
        .into_iter()
        .map(|(page_number, page_id)| (page_id, page_number as i64))
        .collect::<HashMap<_, _>>();
    let mut ranges = Vec::new();
    for range in read_page_label_ranges(source, page_labels)? {
        if usize::try_from(range.page_index).ok() >= Some(source_page_numbers.len()) {
            return Err("PageLabels range index is outside the source page tree".into());
        }
        let start_page: i64 = i64::from(range.page_index)
            .checked_add(1)
            .ok_or("Invalid PageLabels range")?;
        ranges.push(BrowserPageLabelRange {
            start_page,
            prefix: range.prefix,
            style: range.style.map(|value| value.into_bytes()),
            start_number: i64::from(range.start.unwrap_or(1))
                .clamp(1, MAX_BROWSER_PAGE_LABEL_NUMBER),
        });
    }
    ranges.sort_by_key(|range| range.start_page);

    let mut output_nums = Vec::with_capacity(page_sequence.len() * 2);
    for (output_index, page) in page_sequence.iter().enumerate() {
        let label = if page.document_index == source_index {
            let source_page_number = *source_page_numbers
                .get(&page.page_id)
                .ok_or("Page-label source page was not found")?;
            page_label_for_number(&ranges, source_page_number)?
        } else {
            format_decimal((output_index + 1) as i64)
        };
        output_nums.push(Object::Integer(output_index as i64));
        let mut label_dict = Dictionary::new();
        label_dict.set("P", lopdf::text_string(&label));
        output_nums.push(Object::Dictionary(label_dict));
    }
    Ok(dictionary! {"Nums" => output_nums}.into())
}

fn page_label_for_number(ranges: &[BrowserPageLabelRange], page_number: i64) -> Result<String> {
    // The ranges are sorted by start page; a reverse scan per page made a
    // label on every page quadratic in the document.
    let Some(range) = ranges
        .partition_point(|range| range.start_page <= page_number)
        .checked_sub(1)
        .and_then(|index| ranges.get(index))
        .or_else(|| ranges.first())
    else {
        // An empty label tree labels nothing: the page keeps its number.
        return Ok(format_decimal(page_number));
    };
    let number = range
        .start_number
        .saturating_add(page_number.saturating_sub(range.start_page))
        .clamp(1, MAX_BROWSER_PAGE_LABEL_NUMBER);
    let suffix = match range.style.as_deref() {
        None => String::new(),
        Some(b"R") => format_roman(number).to_uppercase(),
        Some(b"r") => format_roman(number),
        Some(b"A") => format_alpha(number, true)?,
        Some(b"a") => format_alpha(number, false)?,
        Some(_) => format_decimal(number),
    };
    Ok(format!(
        "{}{}",
        range.prefix.as_deref().unwrap_or_default(),
        suffix
    ))
}

fn format_decimal(number: i64) -> String {
    number.to_string()
}

fn format_alpha(number: i64, uppercase: bool) -> Result<String> {
    let index = number
        .checked_sub(1)
        .ok_or("Invalid alphabetic page label number")?;
    let repeat_count =
        usize::try_from(index / 26 + 1).map_err(|_| "Alphabetic page label is too large")?;
    if repeat_count > MAX_AGGREGATE_TEXT_BYTES {
        return Err("Alphabetic page label exceeds the bounded text limit".into());
    }
    let letter = (if uppercase { b'A' } else { b'a' }) + (index % 26) as u8;
    let mut result = String::new();
    result
        .try_reserve(repeat_count)
        .map_err(|_| "Alphabetic page label exceeds the bounded text limit")?;
    result.extend(std::iter::repeat_n(char::from(letter), repeat_count));
    Ok(result)
}

fn format_roman(mut number: i64) -> String {
    let values = [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    let mut result = String::new();
    for (value, text) in values {
        while number >= value {
            number -= value;
            result.push_str(text);
        }
    }
    result
}

impl PageCloneContext<'_> {
    pub(crate) fn clone_page(&mut self, source: PageCloneSource) -> Result<ObjectId> {
        if self
            .completed_pages
            .contains(&(source.document_index, source.page_id))
        {
            return self
                .object_map
                .get(&(source.document_index, source.page_id))
                .copied()
                .ok_or_else(|| "Completed browser page has no object ID".into());
        }

        let new_page_id = *self
            .object_map
            .entry((source.document_index, source.page_id))
            .or_insert_with(|| self.target.new_object_id());

        let source_document = self.source(source.document_index)?;
        let mut page = source_document.get_dictionary(source.page_id)?.clone();
        materialize_page_inherited_object(
            source_document,
            source.page_id,
            &mut page,
            b"MediaBox",
            true,
        )?;
        materialize_page_inherited_object(
            source_document,
            source.page_id,
            &mut page,
            b"CropBox",
            false,
        )?;
        materialize_page_inherited_object(
            source_document,
            source.page_id,
            &mut page,
            b"Resources",
            false,
        )?;
        materialize_page_inherited_object(
            source_document,
            source.page_id,
            &mut page,
            b"Rotate",
            false,
        )?;
        // Resources are required; readers treat a page without any as empty.
        if !page.has(b"Resources") {
            page.set("Resources", Dictionary::new());
        }
        page.remove(b"Parent");
        page.set("Type", "Page");

        let cloned_page =
            self.clone_object_references(source.document_index, Object::Dictionary(page))?;
        let mut cloned_page = cloned_page
            .as_dict()
            .cloned()
            .map_err(|_| "Cloned page object was not a dictionary")?;
        cloned_page.set("Parent", self.pages_id);
        self.target
            .objects
            .insert(new_page_id, Object::Dictionary(cloned_page));
        self.completed_pages
            .insert((source.document_index, source.page_id));
        Ok(new_page_id)
    }

    /// Clones one indirect object and every object it reaches.
    pub(crate) fn clone_indirect_object(
        &mut self,
        source_index: usize,
        object_id: ObjectId,
    ) -> Result<ObjectId> {
        let new_id = self.map_indirect_object(source_index, object_id);
        self.drain_pending_objects()?;
        Ok(new_id)
    }

    /// Clones a direct object and every indirect object it reaches.
    pub(crate) fn clone_object_references(
        &mut self,
        source_index: usize,
        object: Object,
    ) -> Result<Object> {
        let cloned = self.clone_direct_references(source_index, object)?;
        self.drain_pending_objects()?;
        Ok(cloned)
    }

    // A reference takes its target id at once and its object later, from a
    // worklist, so a long chain such as an outline's /Next links cannot
    // exhaust the stack the way recursing through each link did.
    fn map_indirect_object(&mut self, source_index: usize, object_id: ObjectId) -> ObjectId {
        if let Some(new_id) = self.object_map.get(&(source_index, object_id)) {
            return *new_id;
        }
        let new_id = self.target.new_object_id();
        self.object_map.insert((source_index, object_id), new_id);
        self.pending_objects.push((source_index, object_id, new_id));
        new_id
    }

    fn drain_pending_objects(&mut self) -> Result<()> {
        while let Some((source_index, object_id, new_id)) = self.pending_objects.pop() {
            let object = self.source(source_index)?.get_object(object_id)?.clone();
            let cloned_object = self.clone_direct_references(source_index, object)?;
            self.target.objects.insert(new_id, cloned_object);
        }
        Ok(())
    }

    fn clone_direct_references(&mut self, source_index: usize, object: Object) -> Result<Object> {
        let imported = (source_index > 0).then_some(self.sources[source_index]);
        map_page_object_references(object, imported, &mut |object_id| {
            if self.is_unretained_page_tree_object(source_index, object_id)? {
                Ok(Object::Null)
            } else {
                Ok(Object::Reference(
                    self.map_indirect_object(source_index, object_id),
                ))
            }
        })
    }

    /// Catalog metadata such as outlines can point at pages the operation
    /// removed. Cloning one would drag its `Parent` chain and every sibling
    /// page back into the output, so unretained page-tree objects become null.
    fn is_unretained_page_tree_object(
        &self,
        source_index: usize,
        object_id: ObjectId,
    ) -> Result<bool> {
        if self.object_map.contains_key(&(source_index, object_id)) {
            return Ok(false);
        }
        let Ok(dictionary) = self.source(source_index)?.get_dictionary(object_id) else {
            return Ok(false);
        };
        Ok(matches!(
            dictionary
                .get(b"Type")
                .ok()
                .and_then(|value| value.as_name().ok()),
            Some(b"Page" | b"Pages")
        ))
    }

    pub(crate) fn source(&self, source_index: usize) -> Result<&Document> {
        self.sources
            .get(source_index)
            .copied()
            .ok_or_else(|| format!("Invalid PDF source index {source_index}").into())
    }
}

pub(crate) fn materialize_page_inherited_object(
    document: &Document,
    page_id: ObjectId,
    page: &mut Dictionary,
    key: &[u8],
    required: bool,
) -> Result<()> {
    if page.get(key).is_ok() {
        return Ok(());
    }

    if let Some(object) = resolve_inherited_object(document, page_id, key)? {
        page.set(key.to_vec(), object.clone());
        return Ok(());
    }

    if required {
        return Err(format!("Missing inherited {}", String::from_utf8_lossy(key)).into());
    }

    Ok(())
}

/// Walk direct containers only; each caller owns indirect-object identity.
pub(crate) fn map_page_object_references(
    object: Object,
    imported: Option<&Document>,
    reference: &mut impl FnMut(ObjectId) -> Result<Object>,
) -> Result<Object> {
    match object {
        Object::Reference(id) => reference(id),
        Object::Array(items) => Ok(Object::Array(
            items
                .into_iter()
                .map(|item| map_page_object_references(item, imported, reference))
                .collect::<Result<_>>()?,
        )),
        Object::Dictionary(_) | Object::Stream(_) => {
            let mut object = object;
            let dictionary = match &mut object {
                Object::Dictionary(dictionary) => dictionary,
                Object::Stream(stream) => &mut stream.dict,
                _ => unreachable!(),
            };
            // Imported names belong to the source catalog, which is not copied.
            // Resolve them before mapping page identities, including inline links
            // and actions, so a destination catalog's same name cannot capture them.
            if let Some(source) = imported {
                let key = if dictionary.get(b"S").and_then(Object::as_name).ok() == Some(b"GoTo") {
                    b"D".as_slice()
                } else {
                    b"Dest".as_slice()
                };
                if let Ok(destination) = dictionary.get(key) {
                    let destination =
                        crate::internal_destinations::resolve_destination(source, destination)?
                            .ok_or(
                                "Browser insertion cannot resolve an imported named destination",
                            )?;
                    dictionary.set(key, Object::Array(destination));
                }
            }
            for (_, value) in dictionary.iter_mut() {
                *value = map_page_object_references(value.clone(), imported, reference)?;
            }
            Ok(object)
        }
        object => Ok(object),
    }
}
