use super::*;

pub(crate) struct PageMutationBytes {
    pub(crate) data: Vec<u8>,
    pub(crate) page_count: u32,
}

struct BoundedPdfWriter {
    bytes: Vec<u8>,
    max_bytes: usize,
    limit_exceeded: bool,
}

impl BoundedPdfWriter {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
            limit_exceeded: false,
        }
    }
}

impl Write for BoundedPdfWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let Some(next_len) = self.bytes.len().checked_add(buffer.len()) else {
            self.limit_exceeded = true;
            return Err(std::io::Error::other("Page-op WASM output limit exceeded"));
        };
        let Some(reserve_len) = buffer.len().checked_add(PAGE_OP_WASM_MUTATION_HEADER_BYTES) else {
            self.limit_exceeded = true;
            return Err(std::io::Error::other("Page-op WASM output limit exceeded"));
        };
        if next_len > self.max_bytes || self.bytes.try_reserve(reserve_len).is_err() {
            self.limit_exceeded = true;
            return Err(std::io::Error::other("Page-op WASM output limit exceeded"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

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
}

struct BrowserPageLabelRange {
    start_page: i64,
    prefix: Option<Vec<u8>>,
    style: Option<Vec<u8>>,
    start_number: i64,
}

const MAX_BROWSER_PAGE_LABEL_NUMBER: i64 = 1_000_000_000;

pub(crate) fn load_browser_pdf(data: &[u8]) -> Result<Document> {
    let document = load_pdf_bytes(data)?;
    assert_plaintext_base(
        &document,
        "Encrypted PDFs are not supported by browser page-op WASM",
    )?;
    Ok(document)
}

/// Decrypts an encrypted browser PDF into plaintext bytes.
///
/// Returns the decrypted rewrite in the mutation frame with its actual page count,
/// or the input bytes unchanged with `page_count = 0` when the input was never
/// encrypted. A rejected password surfaces as `needs-password` and a
/// public-key or unknown security handler as `unsupported-filter`, so the
/// browser build exposes the same three outcomes as the native decrypt CLI.
pub(crate) fn decrypt_browser_pdf_bytes(data: &[u8], password: &[u8]) -> Result<PageMutationBytes> {
    let password =
        std::str::from_utf8(password).map_err(|_| "Page-op WASM password must be UTF-8 text")?;
    // An empty password is an empty-password attempt: lopdf then fails with
    // InvalidPassword instead of returning a partially-loaded document, so the
    // classification below reports needs-password.
    let mut document = load_pdf_bytes_with_password(data, Some(password))?;
    if document.was_encrypted() {
        let page_count = u32::try_from(document.get_pages().len())
            .map_err(|_| "Decrypted PDF page count exceeds u32")?;
        let data = save_document_to_bytes(&mut document)?;
        Ok(PageMutationBytes { data, page_count })
    } else if document.is_encrypted() {
        Err(domain_error(
            NativeErrorCode::NeedsPassword,
            "The supplied password was not accepted by the encrypted PDF",
        ))
    } else {
        Ok(PageMutationBytes {
            data: data.to_vec(),
            page_count: 0,
        })
    }
}

pub(crate) fn save_document_to_bytes(document: &mut Document) -> Result<Vec<u8>> {
    save_document_to_bytes_with_limit(
        document,
        PAGE_OP_WASM_MAX_OUTPUT_BYTES - PAGE_OP_WASM_MUTATION_HEADER_BYTES,
    )
}

pub(crate) fn save_document_to_bytes_with_limit(
    document: &mut Document,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let mut output = BoundedPdfWriter::new(max_bytes);
    let result = document.save_to(&mut output);
    if output.limit_exceeded {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Page-op WASM output exceeds the admission ceiling",
        ));
    }
    result?;
    Ok(output.bytes)
}

pub(crate) fn page_count(document: &Document) -> u32 {
    document.get_pages().len() as u32
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

pub(crate) fn validate_browser_rotation_angle(angle: i64) -> Result<i64> {
    match angle {
        90 | 180 | 270 => Ok(angle),
        _ => Err("Invalid rotation angle".into()),
    }
}

pub(crate) fn rotate_browser_pages(
    document: &mut Document,
    pages: &[u32],
    angle: i64,
) -> Result<()> {
    let angle = validate_browser_rotation_angle(angle)?;
    let page_map = document.get_pages();
    validate_browser_page_numbers(pages, "rotatePages", page_map.len() as u32, true, false)?;

    for page_number in pages {
        let page_id = resolve_page_id(&page_map, *page_number)?;
        let current_rotation = resolve_page_rotation(document, page_id)?;
        document
            .get_dictionary_mut(page_id)?
            .set("Rotate", normalize_page_rotation(current_rotation + angle));
    }

    Ok(())
}

pub(crate) fn get_browser_page_geometry(
    document: &Document,
    page_number: u32,
) -> Result<PageGeometry> {
    get_page_geometry(document, page_number)
}

pub(crate) fn crop_pages(
    document: &mut Document,
    pages: &[u32],
    margins: CropMargins,
) -> Result<()> {
    validate_crop_margins(margins)?;
    let page_map = document.get_pages();
    let mut preflighted_pages = Vec::new();
    preflighted_pages
        .try_reserve_exact(pages.len())
        .map_err(|_| "Too many pages selected for crop")?;
    for page_number in pages {
        let page_id = resolve_page_id(&page_map, *page_number)?;
        let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
        let crop_width = media_box.width() - margins.left - margins.right;
        let crop_height = media_box.height() - margins.top - margins.bottom;
        if crop_width <= 0.0 || crop_height <= 0.0 {
            return Err(format!(
                "Crop margins consume page {page_number} ({} x {})",
                media_box.width(),
                media_box.height()
            )
            .into());
        }
        let crop_box = PdfRect {
            x1: media_box.x1 + margins.left,
            y1: media_box.y1 + margins.bottom,
            x2: media_box.x1 + margins.left + crop_width,
            y2: media_box.y1 + margins.bottom + crop_height,
        };
        preflighted_pages.push((page_id, crop_box));
    }

    for (page_id, crop_box) in preflighted_pages {
        let page = document.get_dictionary_mut(page_id)?;
        set_page_crop_box_on_dictionary(page, crop_box);
    }
    Ok(())
}

pub(crate) fn remove_crop_from_pages(document: &mut Document, pages: &[u32]) -> Result<()> {
    let page_map = document.get_pages();
    for page_number in pages {
        let page_id = resolve_page_id(&page_map, *page_number)?;
        let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
        let page = document.get_dictionary_mut(page_id)?;
        set_page_crop_box_on_dictionary(page, media_box);
    }
    Ok(())
}

pub(crate) fn crop_browser_pdf_bytes(
    data: &[u8],
    pages: &[u32],
    margins: CropMargins,
) -> Result<PageMutationBytes> {
    let mut document = load_browser_pdf(data)?;
    let document_page_count = page_count(&document);
    validate_browser_page_numbers(pages, "cropPages", document_page_count, true, false)?;
    crop_pages(&mut document, pages, margins)?;
    let page_count = page_count(&document);
    Ok(PageMutationBytes {
        data: save_document_to_bytes(&mut document)?,
        page_count,
    })
}

pub(crate) fn remove_crop_browser_pdf_bytes(
    data: &[u8],
    pages: &[u32],
) -> Result<PageMutationBytes> {
    let mut document = load_browser_pdf(data)?;
    let document_page_count = page_count(&document);
    validate_browser_page_numbers(pages, "removeCrop", document_page_count, true, false)?;
    remove_crop_from_pages(&mut document, pages)?;
    let page_count = page_count(&document);
    Ok(PageMutationBytes {
        data: save_document_to_bytes(&mut document)?,
        page_count,
    })
}

pub(crate) fn rotate_browser_pdf_bytes(
    data: &[u8],
    pages: &[u32],
    angle: i64,
) -> Result<PageMutationBytes> {
    let mut document = load_browser_pdf(data)?;
    rotate_browser_pages(&mut document, pages, angle)?;
    let page_count = page_count(&document);
    Ok(PageMutationBytes {
        data: save_document_to_bytes(&mut document)?,
        page_count,
    })
}

pub(crate) fn get_browser_page_geometry_from_bytes(
    data: &[u8],
    page_number: u32,
) -> Result<PageGeometry> {
    let document = load_browser_pdf(data)?;
    get_browser_page_geometry(&document, page_number)
}

pub(crate) fn delete_browser_pdf_pages(data: &[u8], pages: &[u32]) -> Result<PageMutationBytes> {
    let document = load_browser_pdf(data)?;
    let source_pages = document.get_pages();
    let remove_pages = validate_browser_page_numbers(
        pages,
        "deletePages",
        source_pages.len() as u32,
        true,
        false,
    )?;
    if remove_pages.len() == source_pages.len() {
        return Err("deletePages: cannot delete every page".into());
    }
    let kept_pages = source_pages
        .iter()
        .filter_map(|(page_number, page_id)| {
            (!remove_pages.contains(page_number)).then_some(PageCloneSource {
                document_index: 0,
                page_id: *page_id,
            })
        })
        .collect::<Vec<_>>();
    build_browser_page_subset_pdf(&[&document], &kept_pages)
}

pub(crate) fn extract_browser_pdf_pages(data: &[u8], pages: &[u32]) -> Result<PageMutationBytes> {
    let document = load_browser_pdf(data)?;
    let source_pages = document.get_pages();
    validate_browser_page_numbers(
        pages,
        "extractPages",
        source_pages.len() as u32,
        true,
        false,
    )?;
    let selected_pages = pages
        .iter()
        .map(|page_number| {
            Ok(PageCloneSource {
                document_index: 0,
                page_id: resolve_page_id(&source_pages, *page_number)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    build_browser_page_subset_pdf(&[&document], &selected_pages)
}

pub(crate) fn reorder_browser_pdf_pages(
    data: &[u8],
    new_order: &[u32],
) -> Result<PageMutationBytes> {
    let document = load_browser_pdf(data)?;
    let source_pages = document.get_pages();
    validate_browser_page_numbers(
        new_order,
        "reorderPages",
        source_pages.len() as u32,
        true,
        true,
    )?;
    let ordered_pages = new_order
        .iter()
        .map(|page_number| {
            Ok(PageCloneSource {
                document_index: 0,
                page_id: resolve_page_id(&source_pages, *page_number)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    build_browser_page_subset_pdf(&[&document], &ordered_pages)
}

pub(crate) fn insert_browser_pdf_pages(
    data: &[u8],
    insertion_data: &[u8],
    after_page: u32,
) -> Result<PageMutationBytes> {
    let destination = load_browser_pdf(data)?;
    let insertion = load_browser_pdf(insertion_data)?;
    let destination_pages = destination.get_pages();
    let insertion_pages = insertion.get_pages();
    if after_page > destination_pages.len() as u32 {
        return Err("Invalid afterPage".into());
    }

    let mut page_sequence = Vec::with_capacity(destination_pages.len() + insertion_pages.len());
    for (page_number, page_id) in &destination_pages {
        if *page_number <= after_page {
            page_sequence.push(PageCloneSource {
                document_index: 0,
                page_id: *page_id,
            });
        }
    }
    page_sequence.extend(insertion_pages.values().map(|page_id| PageCloneSource {
        document_index: 1,
        page_id: *page_id,
    }));
    for (page_number, page_id) in &destination_pages {
        if *page_number > after_page {
            page_sequence.push(PageCloneSource {
                document_index: 0,
                page_id: *page_id,
            });
        }
    }

    build_browser_page_subset_pdf(&[&destination, &insertion], &page_sequence)
}

pub(crate) fn build_browser_page_subset_pdf(
    sources: &[&Document],
    page_sequence: &[PageCloneSource],
) -> Result<PageMutationBytes> {
    if page_sequence.is_empty() {
        return Err("Browser page subset must contain at least one page".into());
    }

    let version = sources
        .iter()
        .map(|document| document.version.as_str())
        .max()
        .unwrap_or("1.4")
        .to_string();
    let mut target = Document::with_version(version);
    let pages_id = target.new_object_id();
    let mut clone_context = PageCloneContext {
        sources: sources.to_vec(),
        target,
        pages_id,
        object_map: HashMap::new(),
    };
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
    if !sources.is_empty() {
        preserve_single_source_document_metadata(
            &mut clone_context,
            0,
            page_sequence,
            &mut catalog,
        )?;
    }
    let catalog_id = clone_context.target.add_object(catalog);
    clone_context.target.trailer.set("Root", catalog_id);
    clone_context.target.prune_objects();

    Ok(PageMutationBytes {
        page_count: page_ids.len() as u32,
        data: save_document_to_bytes(&mut clone_context.target)?,
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
    let labels = resolve_dictionary_object(source, page_labels, "PageLabels")?;
    let nums = labels.get(b"Nums")?.as_array()?;
    if nums.is_empty() || nums.len() % 2 != 0 {
        return Err("PageLabels has no usable ranges".into());
    }
    let mut ranges = Vec::new();
    for pair in nums.chunks_exact(2) {
        let start_page: i64 = pair[0]
            .as_i64()?
            .checked_add(1)
            .ok_or("Invalid PageLabels range")?;
        let label = resolve_dictionary_object(source, &pair[1], "PageLabel")?;
        ranges.push(BrowserPageLabelRange {
            start_page,
            prefix: label
                .get(b"P")
                .ok()
                .and_then(|value| source.resolved(value).ok())
                .and_then(|value| value.as_str().ok())
                .map(|value| value.to_vec()),
            style: label
                .get(b"S")
                .ok()
                .and_then(|value| source.resolved(value).ok())
                .and_then(|value| value.as_name().ok())
                .map(|value| value.to_vec()),
            start_number: label
                .get(b"St")
                .ok()
                .and_then(|value| source.resolved(value).ok())
                .and_then(|value| value.as_i64().ok())
                .unwrap_or(1)
                .clamp(1, MAX_BROWSER_PAGE_LABEL_NUMBER),
        });
    }
    ranges.sort_by_key(|range| range.start_page);

    let source_page_numbers = source
        .get_pages()
        .into_iter()
        .map(|(page_number, page_id)| (page_id, page_number as i64))
        .collect::<HashMap<_, _>>();
    let mut output_nums = Vec::with_capacity(page_sequence.len() * 2);
    for (output_index, page) in page_sequence.iter().enumerate() {
        let label = if page.document_index == source_index {
            let source_page_number = *source_page_numbers
                .get(&page.page_id)
                .ok_or("Page-label source page was not found")?;
            page_label_for_number(&ranges, source_page_number)
        } else {
            format_decimal((output_index + 1) as i64)
        };
        output_nums.push(Object::Integer(output_index as i64));
        let mut label_dict = Dictionary::new();
        label_dict.set("P", Object::string_literal(label));
        output_nums.push(Object::Dictionary(label_dict));
    }
    Ok(dictionary! {"Nums" => output_nums}.into())
}

fn page_label_for_number(ranges: &[BrowserPageLabelRange], page_number: i64) -> String {
    let range = ranges
        .iter()
        .rev()
        .find(|range| range.start_page <= page_number)
        .or_else(|| ranges.first())
        .expect("PDF page labels must contain a range");
    let number = range
        .start_number
        .saturating_add(page_number.saturating_sub(range.start_page))
        .clamp(1, MAX_BROWSER_PAGE_LABEL_NUMBER);
    let suffix = match range.style.as_deref() {
        None => String::new(),
        Some(b"R") => format_roman(number).to_uppercase(),
        Some(b"r") => format_roman(number),
        Some(b"A") => format_alpha(number).to_uppercase(),
        Some(b"a") => format_alpha(number),
        Some(_) => format_decimal(number),
    };
    format!(
        "{}{}",
        String::from_utf8_lossy(range.prefix.as_deref().unwrap_or_default()),
        suffix
    )
}

fn format_decimal(number: i64) -> String {
    number.to_string()
}

fn format_alpha(mut number: i64) -> String {
    let mut result = String::new();
    while number > 0 {
        number -= 1;
        result.insert(0, char::from(b'A' + (number % 26) as u8));
        number /= 26;
    }
    result
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
        if let Some(new_id) = self
            .object_map
            .get(&(source.document_index, source.page_id))
        {
            return Ok(*new_id);
        }

        let new_page_id = self.target.new_object_id();
        self.object_map
            .insert((source.document_index, source.page_id), new_page_id);

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
        Ok(new_page_id)
    }

    pub(crate) fn clone_indirect_object(
        &mut self,
        source_index: usize,
        object_id: ObjectId,
    ) -> Result<ObjectId> {
        if let Some(new_id) = self.object_map.get(&(source_index, object_id)) {
            return Ok(*new_id);
        }

        let new_id = self.target.new_object_id();
        self.object_map.insert((source_index, object_id), new_id);
        let object = self.source(source_index)?.get_object(object_id)?.clone();
        let cloned_object = self.clone_object_references(source_index, object)?;
        self.target.objects.insert(new_id, cloned_object);
        Ok(new_id)
    }

    pub(crate) fn clone_object_references(
        &mut self,
        source_index: usize,
        object: Object,
    ) -> Result<Object> {
        match object {
            Object::Reference(object_id) => {
                if self.is_unretained_page_tree_object(source_index, object_id)? {
                    return Ok(Object::Null);
                }
                Ok(Object::Reference(
                    self.clone_indirect_object(source_index, object_id)?,
                ))
            }
            Object::Array(items) => Ok(Object::Array(
                items
                    .into_iter()
                    .map(|item| self.clone_object_references(source_index, item))
                    .collect::<Result<Vec<_>>>()?,
            )),
            Object::Dictionary(dictionary) => Ok(Object::Dictionary(
                self.clone_dictionary_references(source_index, dictionary)?,
            )),
            Object::Stream(mut stream) => {
                stream.dict = self.clone_dictionary_references(source_index, stream.dict)?;
                Ok(Object::Stream(stream))
            }
            object => Ok(object),
        }
    }

    pub(crate) fn clone_dictionary_references(
        &mut self,
        source_index: usize,
        dictionary: Dictionary,
    ) -> Result<Dictionary> {
        let mut cloned_dictionary = Dictionary::new();
        for (key, value) in dictionary.iter() {
            cloned_dictionary.set(
                key.clone(),
                self.clone_object_references(source_index, value.clone())?,
            );
        }
        Ok(cloned_dictionary)
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
        page.set(key.to_vec(), object);
        return Ok(());
    }

    if required {
        return Err(format!("Missing inherited {}", String::from_utf8_lossy(key)).into());
    }

    Ok(())
}

pub(crate) fn resolve_inherited_object(
    document: &Document,
    page_id: ObjectId,
    key: &[u8],
) -> Result<Option<Object>> {
    let mut current_id = Some(page_id);
    let mut seen = HashSet::new();

    while let Some(object_id) = current_id {
        if !seen.insert(object_id) {
            return Err(format!(
                "Page tree cycle while resolving {}",
                String::from_utf8_lossy(key)
            )
            .into());
        }

        let dict = document.get_dictionary(object_id)?;
        if let Ok(object) = dict.get(key) {
            return Ok(Some(object.clone()));
        }

        current_id = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }

    Ok(None)
}
