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
        write_document(&self.document, |id| self.raw(sources, id), output)
    }

    /// Checks the `len` bytes `write` wrote to `output`; see `verify_written`.
    pub(crate) fn verify<S: ByteSource, O: ByteSource>(
        &self,
        sources: &[SourcePdf<S>],
        output: &O,
        len: u64,
    ) -> Result<()> {
        verify_written(&self.document, |id| self.raw(sources, id), output, len)
    }

    /// The source range of a copied stream.
    pub(crate) fn raw<'a, S: ByteSource>(
        &self,
        sources: &'a [SourcePdf<S>],
        id: ObjectId,
    ) -> Option<(&'a S, u64, u64)> {
        let (index, source_id) = self.origins.get(&id)?;
        sources.get(*index)?.stream_range(*source_id)
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

/// Every page of every input in order, each input's outline offset to its
/// pages.
fn merge_pages(documents: &[&Document]) -> Result<PageSubset> {
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
    for document in documents {
        bookmarks.extend(
            read_pdf_outline(*document, false)?
                .into_iter()
                .map(|bookmark| offset_bookmark(bookmark, page_offset)),
        );
        page_offset = page_offset.saturating_add(document.get_pages().len() as u32);
    }
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
    let file = staged.file().map_err(io_domain_error)?;
    subset
        .write(&sources, std::io::BufWriter::with_capacity(1 << 20, file))?
        .into_inner()
        .map_err(|error| io_domain_error(error.into_error()))?;
    let len = file.metadata().map_err(io_domain_error)?.len();
    subset.verify(&sources, file, len)?;
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
    preserve_single_source_document_metadata(&mut clone_context, 0, &mut catalog)?;
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
    } else {
        add_imported_fields(&mut clone_context, &mut catalog, page_sequence)?;
    }
    let catalog_id = clone_context.target.add_object(catalog);
    clone_context.target.trailer.set("Root", catalog_id);
    set_subset_page_labels(&mut clone_context.target, sources, page_sequence)?;
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

    Ok(())
}

/// Adds the fields of widgets on pages from the other inputs to the output's
/// form; an input's own form, attachments and scripts stay behind. A field
/// whose top-level name the form already holds is renamed `name+N`, as qpdf
/// renames it. A widget without a field type, or with a /Parent loop, keeps
/// its appearance but joins no field.
fn add_imported_fields(
    clone_context: &mut PageCloneContext,
    catalog: &mut Dictionary,
    page_sequence: &[PageCloneSource],
) -> Result<()> {
    let (mut roots, mut seen) = (Vec::new(), HashSet::new());
    for page in page_sequence.iter().filter(|page| page.document_index > 0) {
        let source = clone_context.source(page.document_index)?;
        for entry in crate::split_navigation::source_annotation_entries(source, page.page_id) {
            let root = entry
                .as_reference()
                .ok()
                .and_then(|id| field_root(source, id));
            if let Some(&copy) =
                root.and_then(|root| clone_context.object_map.get(&(page.document_index, root)))
            {
                if seen.insert(copy) {
                    roots.push((page.document_index, copy));
                }
            }
        }
    }
    if roots.is_empty() {
        return Ok(());
    }
    let target = &clone_context.target;
    let resolved = |document: &Document, object: Option<&Object>| {
        object
            .and_then(|object| document.resolved(object).ok())
            .cloned()
    };
    let mut form = resolved(target, catalog.get(b"AcroForm").ok())
        .and_then(|form| form.as_dict().ok().cloned())
        .unwrap_or_default();
    let mut fields = resolved(target, form.get(b"Fields").ok())
        .and_then(|fields| fields.as_array().ok().cloned())
        .unwrap_or_default();
    let field_name = |document: &Document, id: ObjectId| {
        let field = document.get_dictionary(id).ok()?;
        lopdf::decode_text_string(field.get(b"T").ok()?).ok()
    };
    let mut names = fields
        .iter()
        .filter_map(|field| field_name(target, field.as_reference().ok()?))
        .collect::<HashSet<_>>();
    for (source_index, copy) in roots {
        let source = clone_context.source(source_index)?;
        let appearance = resolved(source, source.catalog()?.get(b"AcroForm").ok())
            .and_then(|form| form.as_dict().ok()?.get(b"DA").ok().cloned());
        let name = field_name(&clone_context.target, copy);
        let field = clone_context.target.get_dictionary_mut(copy)?;
        if let (false, Some(appearance)) = (field.has(b"DA"), appearance) {
            field.set("DA", appearance);
        }
        if let Some(name) = name {
            let unique = std::iter::once(name.clone())
                .chain((1..).map(|suffix| format!("{name}+{suffix}")))
                .find(|candidate| !names.contains(candidate))
                .expect("an unused suffix exists");
            if unique != name {
                field.set("T", lopdf::text_string(&unique));
            }
            names.insert(unique);
        }
        fields.push(Object::Reference(copy));
    }
    form.set("Fields", fields);
    catalog.set("AcroForm", form);
    Ok(())
}

/// The top of a widget's /Parent chain when that chain is a field: it ends,
/// and it sets a field type.
fn field_root(source: &Document, widget: ObjectId) -> Option<ObjectId> {
    let annotation = source.get_dictionary(widget).ok()?;
    if annotation.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Widget") {
        return None;
    }
    let (mut id, mut chain, mut typed) = (widget, HashSet::new(), false);
    loop {
        let field = source
            .get_dictionary(id)
            .ok()
            .filter(|_| chain.insert(id))?;
        typed |= field.has(b"FT");
        match field.get(b"Parent") {
            Ok(parent) => id = parent.as_reference().ok()?,
            Err(_) => return typed.then_some(id),
        }
    }
}

/// Labels each output page as its source labels it, in the fewest ranges: a
/// page continues the range before it when it shows that range's style and
/// prefix and, with a style, the next number. Pages of a source without a
/// label tree, or an inserted source whose tree cannot be read, keep their
/// numbers there; with no tree in any source the output has none.
fn set_subset_page_labels(
    target: &mut Document,
    sources: &[&Document],
    page_sequence: &[PageCloneSource],
) -> Result<()> {
    let mut labelled = false;
    let mut labels = Vec::with_capacity(sources.len());
    for (index, document) in sources.iter().enumerate() {
        let pages = document.get_pages();
        let mut ranges = match document.catalog()?.get(b"PageLabels") {
            Ok(tree) => {
                labelled = true;
                match read_page_label_ranges(*document, tree) {
                    Err(_) if index > 0 => Vec::new(),
                    ranges => ranges?,
                }
            }
            Err(_) => Vec::new(),
        };
        add_implicit_default_page_label_range(&mut ranges, pages.len() as u32);
        let indices = pages
            .into_iter()
            .map(|(number, id)| (id, number - 1))
            .collect::<HashMap<_, _>>();
        labels.push((ranges, indices));
    }
    if !labelled {
        return Ok(());
    }
    let mut ranges: Vec<PageLabelRange> = Vec::new();
    let mut previous_number = 0u32;
    for (output_index, page) in page_sequence.iter().enumerate() {
        let (source_ranges, indices) = &labels[page.document_index];
        let index = *indices
            .get(&page.page_id)
            .ok_or("Page-label source page was not found")?;
        let range =
            &source_ranges[source_ranges.partition_point(|range| range.page_index <= index) - 1];
        let number = range
            .start
            .unwrap_or(1)
            .saturating_add(index - range.page_index);
        let prefix = range.prefix.clone().unwrap_or_default();
        let continues = ranges.last().is_some_and(|last| {
            last.style == range.style
                && last.prefix == prefix
                && (range.style.is_none() || previous_number.checked_add(1) == Some(number))
        });
        if !continues {
            ranges.push(PageLabelRange {
                start_page: output_index as u32 + 1,
                style: range.style.clone(),
                prefix,
                start_number: number,
            });
        }
        previous_number = number;
    }
    set_page_labels(
        target,
        &PageLabelsMutation {
            total_pages: page_sequence.len() as u32,
            ranges,
        },
        false,
    )
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
