use super::*;
use evb_native_support::output::write_bytes_atomically;
use serde::Serialize;

const CATALOG_WALK_DEPTH_LIMIT: usize = 256;
const CATALOG_WALK_NODE_LIMIT: usize = 100_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfCombineCatalog {
    pub(crate) bookmarks: Vec<PdfCombineBookmarkEntry>,
    pub(crate) page_labels: Vec<PdfCombinePageLabelRange>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfCombineBookmarkEntry {
    pub(crate) title: String,
    pub(crate) page_index: Option<u32>,
    pub(crate) named_dest: Option<String>,
    pub(crate) bold: bool,
    pub(crate) italic: bool,
    pub(crate) color: Option<String>,
    pub(crate) items: Vec<PdfCombineBookmarkEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfCombinePageLabelRange {
    pub(crate) page_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) start: Option<u32>,
}

struct CatalogWalkState {
    visited: HashSet<ObjectId>,
    nodes: usize,
}

impl CatalogWalkState {
    fn new() -> Self {
        Self {
            visited: HashSet::new(),
            nodes: 0,
        }
    }

    fn enter(&mut self, object: &Object) -> bool {
        if self.nodes >= CATALOG_WALK_NODE_LIMIT {
            return false;
        }
        if let Ok(object_id) = object.as_reference() {
            if !self.visited.insert(object_id) {
                return false;
            }
        }
        self.nodes += 1;
        true
    }
}

struct RawPdfCombineBookmarkEntry {
    title: String,
    page_id: Option<ObjectId>,
    items: Vec<RawPdfCombineBookmarkEntry>,
    bold: bool,
    italic: bool,
    color: Option<String>,
}

/// Reads the subset of a source catalog that the PDF combine paths preserve.
///
/// The PDF catalog structures are attacker-controlled linked graphs. Cycles
/// terminate the relevant walk, and both depth and node limits bound work on a
/// large or malformed catalog. Page references are indexed only when an
/// outline points at them, so a sparse page tree does not force a dense map.
pub(crate) fn read_pdf_combine_catalog(
    document: &impl PdfObjectSource,
) -> Result<PdfCombineCatalog> {
    let catalog = document.dictionary(document.root_id()?)?;
    validate_pdf_combine_catalog(document, catalog)?;
    let _page_resolver = PageTreeResolver::new(document)?;

    let mut page_ids = HashSet::new();
    let bookmarks = match catalog.get(b"Outlines") {
        Ok(outlines_object) => {
            let outlines = resolve_catalog_dictionary(document, outlines_object, "Outlines")?;
            let first = outlines.get(b"First").ok().cloned();
            let mut state = CatalogWalkState::new();
            read_outline_items(
                document,
                catalog,
                first.as_ref(),
                0,
                &mut state,
                &mut page_ids,
            )?
        }
        Err(_) => Vec::new(),
    };

    let page_indices = collect_catalog_page_indices(document, &page_ids)?;
    let bookmarks = bookmarks
        .into_iter()
        .map(|bookmark| finalize_bookmark(bookmark, &page_indices))
        .collect();

    let page_labels = match catalog.get(b"PageLabels") {
        Ok(page_labels_object) => read_page_label_ranges(document, page_labels_object)?,
        Err(_) => Vec::new(),
    };

    Ok(PdfCombineCatalog {
        bookmarks,
        page_labels,
    })
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
#[allow(dead_code)]
pub(crate) fn read_pdf_combine_catalog_from_bytes(data: &[u8]) -> Result<PdfCombineCatalog> {
    let document = load_browser_pdf(data)?;
    read_pdf_combine_catalog(&document)
}

pub(crate) fn write_pdf_combine_catalog_path(
    input_path: &Path,
    output_path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let incremental = load_incremental_pdf_path(input_path, qpdf_path)?;
    let source = AppendedRevision::new(&incremental);
    let catalog = read_pdf_combine_catalog(&source)?;
    write_bytes_atomically(output_path, &serde_json::to_vec(&catalog)?)?;
    Ok(())
}

fn validate_pdf_combine_catalog(
    document: &impl PdfObjectSource,
    catalog: &Dictionary,
) -> Result<()> {
    if catalog.has(b"AcroForm") {
        return Err("PDF combine does not support source forms".into());
    }
    let names = match catalog.get(b"Names") {
        Ok(names_object) => Some(resolve_catalog_dictionary(document, names_object, "Names")?),
        Err(_) => None,
    };
    if catalog.has(b"AF") || names.is_some_and(|names| names.has(b"EmbeddedFiles")) {
        return Err("PDF combine does not support source attachments".into());
    }
    if names.is_some_and(|names| names.has(b"JavaScript")) {
        return Err("PDF combine does not support source JavaScript".into());
    }
    Ok(())
}

fn resolve_catalog_dictionary<'a>(
    document: &'a impl PdfObjectSource,
    object: &'a Object,
    label: &str,
) -> Result<&'a Dictionary> {
    document
        .resolved(object)?
        .as_dict()
        .map_err(|error| format!("PDF catalog /{label} must be a dictionary: {error}").into())
}

fn read_outline_items(
    document: &impl PdfObjectSource,
    catalog: &Dictionary,
    first: Option<&Object>,
    depth: usize,
    state: &mut CatalogWalkState,
    page_ids: &mut HashSet<ObjectId>,
) -> Result<Vec<RawPdfCombineBookmarkEntry>> {
    if depth >= CATALOG_WALK_DEPTH_LIMIT {
        return Ok(Vec::new());
    }

    let mut output = Vec::new();
    let mut current = first.cloned();
    while let Some(current_object) = current {
        if !state.enter(&current_object) {
            break;
        }
        let Ok(dictionary) = resolve_catalog_dictionary(document, &current_object, "outline")
        else {
            break;
        };
        let title = dictionary
            .get(b"Title")
            .ok()
            .and_then(|value| document.resolved(value).ok())
            .and_then(pdf_string_to_text)
            .unwrap_or_else(|| "Untitled".to_string());
        let destination = dictionary.get(b"Dest").ok().cloned().or_else(|| {
            dictionary
                .get(b"A")
                .ok()
                .and_then(|action| {
                    resolve_catalog_dictionary(document, action, "outline action").ok()
                })
                .and_then(|action| action.get(b"D").ok().cloned())
        });
        let page_id = destination
            .as_ref()
            .map(|value| destination_page_id(document, catalog, value))
            .transpose()?
            .flatten();
        if let Some(page_id) = page_id {
            page_ids.insert(page_id);
        }
        let first_child = dictionary.get(b"First").ok().cloned();
        let next = dictionary.get(b"Next").ok().cloned();
        let flags = dictionary
            .get(b"F")
            .ok()
            .and_then(|value| document.resolved(value).ok())
            .and_then(|value| value.as_i64().ok())
            .unwrap_or_default();
        output.push(RawPdfCombineBookmarkEntry {
            title,
            page_id,
            items: read_outline_items(
                document,
                catalog,
                first_child.as_ref(),
                depth + 1,
                state,
                page_ids,
            )?,
            bold: flags & 2 != 0,
            italic: flags & 1 != 0,
            color: dictionary
                .get(b"C")
                .ok()
                .and_then(|value| document.resolved(value).ok())
                .and_then(pdf_color_to_hex),
        });
        current = next;
    }
    Ok(output)
}

fn destination_page_id(
    document: &impl PdfObjectSource,
    catalog: &Dictionary,
    value: &Object,
) -> Result<Option<ObjectId>> {
    let mut destination = document.resolved(value)?.clone();
    if let Some(name) = pdf_name_or_string(&destination) {
        let Some(named_destination) = find_named_destination(document, catalog, &name)? else {
            return Ok(None);
        };
        destination = document.resolved(&named_destination)?.clone();
    }
    if let Object::Dictionary(dictionary) = &destination {
        let Some(value) = dictionary.get(b"D").ok().cloned() else {
            return Ok(None);
        };
        destination = document.resolved(&value)?.clone();
    }
    let Object::Array(array) = &destination else {
        return Ok(None);
    };
    let Some(first) = array.first() else {
        return Ok(None);
    };
    Ok(first.as_reference().ok())
}

fn find_named_destination(
    document: &impl PdfObjectSource,
    catalog: &Dictionary,
    name: &str,
) -> Result<Option<Object>> {
    if let Ok(dests_object) = catalog.get(b"Dests") {
        let dests = resolve_catalog_dictionary(document, dests_object, "Dests")?;
        if let Ok(destination) = dests.get(name.as_bytes()) {
            return Ok(Some(destination.clone()));
        }
    }

    let names_object = match catalog.get(b"Names") {
        Ok(names_object) => names_object,
        Err(_) => return Ok(None),
    };
    let names = resolve_catalog_dictionary(document, names_object, "Names")?;
    let dests_object = match names.get(b"Dests") {
        Ok(dests_object) => dests_object,
        Err(_) => return Ok(None),
    };
    let mut state = CatalogWalkState::new();
    find_named_destination_in_tree(document, dests_object, name, 0, &mut state)
}

fn find_named_destination_in_tree(
    document: &impl PdfObjectSource,
    node_object: &Object,
    name: &str,
    depth: usize,
    state: &mut CatalogWalkState,
) -> Result<Option<Object>> {
    if depth >= CATALOG_WALK_DEPTH_LIMIT || !state.enter(node_object) {
        return Ok(None);
    }
    let Ok(node) = resolve_catalog_dictionary(document, node_object, "destination name tree")
    else {
        return Ok(None);
    };
    if let Ok(entries_object) = node.get(b"Names") {
        let Some(entries) = document
            .resolved(entries_object)
            .ok()
            .and_then(|value| value.as_array().ok())
        else {
            return Ok(None);
        };
        for pair in entries.chunks_exact(2) {
            if pdf_name_or_string(&pair[0]).as_deref() == Some(name) {
                return Ok(Some(pair[1].clone()));
            }
        }
    }
    let Ok(kids_object) = node.get(b"Kids") else {
        return Ok(None);
    };
    let Some(kids) = document
        .resolved(kids_object)
        .ok()
        .and_then(|value| value.as_array().ok())
    else {
        return Ok(None);
    };
    for kid in kids {
        if let Some(found) = find_named_destination_in_tree(document, kid, name, depth + 1, state)?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn collect_catalog_page_indices(
    document: &impl PdfObjectSource,
    page_ids: &HashSet<ObjectId>,
) -> Result<HashMap<ObjectId, u32>> {
    if page_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let resolver = PageTreeResolver::new(document)?;
    let mut output = HashMap::with_capacity(page_ids.len());
    let mut page_index = 0_u32;
    resolver.for_each_page_id_with_count(document, |page_id| {
        if page_ids.contains(&page_id) {
            output.insert(page_id, page_index);
        }
        page_index = page_index
            .checked_add(1)
            .ok_or("PDF catalog page index exceeded the supported integer range")?;
        Ok(())
    })?;
    Ok(output)
}

fn finalize_bookmark(
    bookmark: RawPdfCombineBookmarkEntry,
    page_indices: &HashMap<ObjectId, u32>,
) -> PdfCombineBookmarkEntry {
    PdfCombineBookmarkEntry {
        title: bookmark.title,
        page_index: bookmark
            .page_id
            .and_then(|page_id| page_indices.get(&page_id).copied()),
        named_dest: None,
        bold: bookmark.bold,
        italic: bookmark.italic,
        color: bookmark.color,
        items: bookmark
            .items
            .into_iter()
            .map(|item| finalize_bookmark(item, page_indices))
            .collect(),
    }
}

fn pdf_color_to_hex(value: &Object) -> Option<String> {
    let values = value.as_array().ok()?;
    if values.len() != 3 {
        return None;
    }
    let channels = values
        .iter()
        .map(|value| value.as_float().ok())
        .collect::<Option<Vec<_>>>()?;
    if channels.iter().any(|channel| !channel.is_finite()) {
        return None;
    }
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        (channels[0].clamp(0.0, 1.0) * 255.0).round() as u8,
        (channels[1].clamp(0.0, 1.0) * 255.0).round() as u8,
        (channels[2].clamp(0.0, 1.0) * 255.0).round() as u8,
    ))
}

fn read_page_label_ranges(
    document: &impl PdfObjectSource,
    page_labels_object: &Object,
) -> Result<Vec<PdfCombinePageLabelRange>> {
    let mut entries = Vec::new();
    let mut state = CatalogWalkState::new();
    read_number_tree(document, page_labels_object, 0, &mut state, &mut entries)?;
    entries.sort_by_key(|(page_index, _)| *page_index);
    let mut output = Vec::new();
    for (page_index, value) in entries {
        let Ok(page_index) = u32::try_from(page_index) else {
            continue;
        };
        let Ok(dictionary) = resolve_catalog_dictionary(document, &value, "PageLabel") else {
            continue;
        };
        let style = dictionary
            .get(b"S")
            .ok()
            .and_then(|value| document.resolved(value).ok())
            .and_then(|value| value.as_name().ok())
            .map(|value| String::from_utf8_lossy(value).into_owned());
        let prefix = dictionary
            .get(b"P")
            .ok()
            .and_then(|value| document.resolved(value).ok())
            .and_then(|value| match value {
                Object::String(_, _) => pdf_string_to_text(value),
                _ => None,
            });
        let start = dictionary
            .get(b"St")
            .ok()
            .and_then(|value| document.resolved(value).ok())
            .and_then(|value| value.as_i64().ok())
            .and_then(|value| u32::try_from(value).ok());
        output.push(PdfCombinePageLabelRange {
            page_index,
            style,
            prefix,
            start,
        });
    }
    Ok(output)
}

fn read_number_tree(
    document: &impl PdfObjectSource,
    node_object: &Object,
    depth: usize,
    state: &mut CatalogWalkState,
    output: &mut Vec<(i64, Object)>,
) -> Result<()> {
    if depth >= CATALOG_WALK_DEPTH_LIMIT
        || output.len() >= CATALOG_WALK_NODE_LIMIT
        || !state.enter(node_object)
    {
        return Ok(());
    }
    let Ok(node) = resolve_catalog_dictionary(document, node_object, "PageLabels") else {
        return Ok(());
    };
    if let Ok(nums_object) = node.get(b"Nums") {
        let Some(nums) = document
            .resolved(nums_object)
            .ok()
            .and_then(|value| value.as_array().ok())
        else {
            return Ok(());
        };
        for pair in nums.chunks_exact(2) {
            if output.len() >= CATALOG_WALK_NODE_LIMIT {
                break;
            }
            let Ok(start_page) = pair[0].as_i64() else {
                continue;
            };
            output.push((start_page, pair[1].clone()));
        }
    }
    if let Ok(kids_object) = node.get(b"Kids") {
        let Some(kids) = document
            .resolved(kids_object)
            .ok()
            .and_then(|value| value.as_array().ok())
        else {
            return Ok(());
        };
        for kid in kids {
            read_number_tree(document, kid, depth + 1, state, output)?;
            if output.len() >= CATALOG_WALK_NODE_LIMIT {
                break;
            }
        }
    }
    Ok(())
}

fn pdf_name_or_string(object: &Object) -> Option<String> {
    pdf_string_to_text(object).or_else(|| {
        object
            .as_name()
            .ok()
            .map(|value| String::from_utf8_lossy(value).into_owned())
    })
}

pub(crate) fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.max(min).min(max)
}

pub(crate) fn normalize_page_label_style(style: Option<&str>) -> Option<String> {
    match style {
        Some("D" | "R" | "r" | "A" | "a") => style.map(ToOwned::to_owned),
        Some(_) => Some("D".to_string()),
        None => None,
    }
}

pub(crate) fn normalize_page_label_ranges(
    ranges: &[PageLabelRange],
    total_pages: u32,
) -> Vec<PageLabelRange> {
    if total_pages == 0 {
        return Vec::new();
    }

    let mut deduped = std::collections::BTreeMap::new();
    for range in ranges {
        let start_page = clamp_u32(range.start_page.max(1), 1, total_pages);
        deduped.insert(
            start_page,
            PageLabelRange {
                start_page,
                style: normalize_page_label_style(range.style.as_deref()),
                prefix: range.prefix.clone(),
                start_number: range.start_number.max(1),
            },
        );
    }
    deduped.entry(1).or_insert_with(|| PageLabelRange {
        start_page: 1,
        style: Some("D".to_string()),
        prefix: String::new(),
        start_number: 1,
    });
    deduped.into_values().collect()
}

pub(crate) fn is_implicit_default_page_labels(ranges: &[PageLabelRange], total_pages: u32) -> bool {
    let normalized = normalize_page_label_ranges(ranges, total_pages);
    normalized.len() == 1
        && normalized[0].start_page == 1
        && normalized[0].style.as_deref() == Some("D")
        && normalized[0].prefix.is_empty()
        && normalized[0].start_number == 1
}

pub(crate) fn assert_mutation_page_count(
    document: &impl PdfObjectSource,
    total_pages: u32,
    label: &str,
) -> Result<()> {
    let page_resolver = PageTreeResolver::new(document)?;
    assert_mutation_page_count_with_resolver(&page_resolver, total_pages, label)
}

fn assert_mutation_page_count_with_resolver(
    page_resolver: &PageTreeResolver,
    total_pages: u32,
    label: &str,
) -> Result<()> {
    let actual_pages = page_resolver.page_count();
    if total_pages != actual_pages {
        return Err(format!(
            "{label} page count {total_pages} does not match document page count {actual_pages}"
        )
        .into());
    }
    Ok(())
}

pub(crate) fn set_page_labels_on_catalog(
    catalog: &mut Dictionary,
    page_labels: &PageLabelsMutation,
) {
    if is_implicit_default_page_labels(&page_labels.ranges, page_labels.total_pages) {
        catalog.remove(b"PageLabels");
        return;
    }

    let normalized = normalize_page_label_ranges(&page_labels.ranges, page_labels.total_pages);
    let mut nums = Vec::with_capacity(normalized.len() * 2);
    for range in normalized {
        nums.push(Object::Integer(i64::from(
            range.start_page.saturating_sub(1),
        )));
        nums.push(page_label_dictionary(&range));
    }

    let mut page_labels_dict = Dictionary::new();
    page_labels_dict.set("Nums", Object::Array(nums));
    catalog.set("PageLabels", Object::Dictionary(page_labels_dict));
}

fn page_label_dictionary(range: &PageLabelRange) -> Object {
    let mut label_dict = Dictionary::new();
    label_dict.set("Type", Object::Name(b"PageLabel".to_vec()));
    if let Some(style) = range.style.as_deref() {
        label_dict.set("S", Object::Name(style.as_bytes().to_vec()));
    }
    if !range.prefix.is_empty() {
        label_dict.set(
            "P",
            Object::String(
                encode_pdf_text_string(&range.prefix),
                StringFormat::Hexadecimal,
            ),
        );
    }
    if range.style.is_some() && range.start_number > 1 {
        label_dict.set("St", Object::Integer(i64::from(range.start_number)));
    }
    Object::Dictionary(label_dict)
}

fn normalize_page_label_range_for_continuation(
    range: &PageLabelRange,
    total_pages: u32,
) -> PageLabelRange {
    PageLabelRange {
        start_page: clamp_u32(range.start_page.max(1), 1, total_pages),
        style: normalize_page_label_style(range.style.as_deref()),
        prefix: range.prefix.clone(),
        start_number: range.start_number.max(1),
    }
}

fn collect_existing_page_label_entries(
    document: &Document,
    catalog: &Dictionary,
) -> Result<BTreeMap<i64, Object>> {
    let mut entries = BTreeMap::new();
    let Ok(page_labels_object) = catalog.get(b"PageLabels") else {
        return Ok(entries);
    };
    let page_labels = resolve_dictionary_object(document, page_labels_object, "PageLabels")?;
    let nums = page_labels.get(b"Nums")?.as_array()?;
    if nums.len() % 2 != 0 {
        return Err("PageLabels Nums must contain key/value pairs".into());
    }
    for pair in nums.chunks_exact(2) {
        entries.insert(pair[0].as_i64()?, pair[1].clone());
    }
    Ok(entries)
}

pub(crate) fn set_page_labels(
    document: &mut Document,
    page_labels: &PageLabelsMutation,
) -> Result<()> {
    assert_mutation_page_count(document, page_labels.total_pages, "Page-label mutation")?;
    let catalog_id = document.root_id()?;
    let catalog = document.get_dictionary_mut(catalog_id)?;
    set_page_labels_on_catalog(catalog, page_labels);
    Ok(())
}

pub(crate) fn set_page_labels_incremental(
    incremental: &mut IncrementalDocument,
    page_labels: &PageLabelsMutation,
    continuation: bool,
) -> Result<()> {
    assert_mutation_page_count(
        incremental.get_prev_documents(),
        page_labels.total_pages,
        "Page-label mutation",
    )?;
    let catalog_id = incremental.get_prev_documents().root_id()?;
    if continuation {
        let previous_catalog = incremental.get_prev_documents().dictionary(catalog_id)?;
        let mut entries = collect_existing_page_label_entries(
            incremental.get_prev_documents(),
            previous_catalog,
        )?;
        if entries.is_empty() {
            for range in normalize_page_label_ranges(&page_labels.ranges, page_labels.total_pages) {
                entries.insert(
                    i64::from(range.start_page.saturating_sub(1)),
                    page_label_dictionary(&range),
                );
            }
        } else {
            for range in &page_labels.ranges {
                let normalized =
                    normalize_page_label_range_for_continuation(range, page_labels.total_pages);
                entries.insert(
                    i64::from(normalized.start_page.saturating_sub(1)),
                    page_label_dictionary(&normalized),
                );
            }
        }
        incremental.opt_clone_object_to_new_document(catalog_id)?;
        let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
        if entries.is_empty() {
            catalog.remove(b"PageLabels");
        } else {
            let nums = entries
                .into_iter()
                .flat_map(|(start_page, label)| [Object::Integer(start_page), label])
                .collect();
            let mut page_labels_dict = Dictionary::new();
            page_labels_dict.set("Nums", Object::Array(nums));
            catalog.set("PageLabels", Object::Dictionary(page_labels_dict));
        }
        return Ok(());
    }
    incremental.opt_clone_object_to_new_document(catalog_id)?;
    let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
    set_page_labels_on_catalog(catalog, page_labels);
    Ok(())
}

pub(crate) fn normalize_bookmark_color(color: Option<&str>) -> Option<String> {
    parse_pdf_color(color).map(|rgb| {
        let to_byte = |value: f64| -> u8 { (value.clamp(0.0, 1.0) * 255.0).round() as u8 };
        format!(
            "#{:02x}{:02x}{:02x}",
            to_byte(rgb[0]),
            to_byte(rgb[1]),
            to_byte(rgb[2])
        )
    })
}

pub(crate) fn normalize_bookmark_entries(
    items: &[BookmarkEntry],
    total_pages: u32,
    untitled_label: &str,
) -> Vec<BookmarkEntry> {
    if total_pages == 0 {
        return Vec::new();
    }
    let max_page_index = total_pages - 1;
    items
        .iter()
        .map(|item| {
            let title = item.title.trim();
            let named_dest = item
                .named_dest
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            BookmarkEntry {
                title: if title.is_empty() {
                    untitled_label.to_string()
                } else {
                    title.to_string()
                },
                page_index: item
                    .page_index
                    .map(|page_index| page_index.min(max_page_index)),
                page_y_ratio: item
                    .page_y_ratio
                    .filter(|value| value.is_finite())
                    .map(|value| value.clamp(0.0, 1.0)),
                named_dest,
                bold: item.bold,
                italic: item.italic,
                color: normalize_bookmark_color(item.color.as_deref()),
                items: normalize_bookmark_entries(&item.items, total_pages, untitled_label),
            }
        })
        .collect()
}

pub(crate) fn resolve_bookmark_destination_top(
    page_view: &PdfRect,
    page_y_ratio: Option<f64>,
) -> f64 {
    let Some(page_y_ratio) = page_y_ratio else {
        return page_view.y2;
    };
    page_view.y2 - page_y_ratio.clamp(0.0, 1.0) * page_view.height().max(0.0)
}

pub(crate) struct OutlineBuildResult {
    pub(crate) first: Option<ObjectId>,
    pub(crate) last: Option<ObjectId>,
    pub(crate) visible_count: i64,
}

pub(crate) struct BookmarkNode<'a> {
    pub(crate) object_id: ObjectId,
    pub(crate) item: &'a BookmarkEntry,
    pub(crate) visible_count: i64,
}

pub(crate) fn set_bookmark_destination(
    base_document: &Document,
    page_resolver: &PageTreeResolver,
    dict: &mut Dictionary,
    item: &BookmarkEntry,
) -> Result<()> {
    if let Some(page_index) = item.page_index {
        let page_number = page_index
            .checked_add(1)
            .ok_or("Invalid bookmark page index")?;
        let page_id = page_resolver.page_id(base_document, page_number)?;
        let page_view = resolve_page_view(base_document, page_id)?;
        let destination_top = resolve_bookmark_destination_top(&page_view, item.page_y_ratio);
        dict.set(
            "Dest",
            Object::Array(vec![
                Object::Reference(page_id),
                Object::Name(b"XYZ".to_vec()),
                Object::Null,
                number_object(destination_top),
                Object::Null,
            ]),
        );
        return Ok(());
    }

    if let Some(named_dest) = item.named_dest.as_deref() {
        dict.set(
            "Dest",
            Object::String(named_dest.as_bytes().to_vec(), StringFormat::Literal),
        );
    }
    Ok(())
}

pub(crate) fn set_bookmark_style(dict: &mut Dictionary, item: &BookmarkEntry) {
    let flags = (if item.italic { 1 } else { 0 }) | (if item.bold { 2 } else { 0 });
    if flags > 0 {
        dict.set("F", Object::Integer(flags));
    }
    if let Some(rgb) = parse_pdf_color(item.color.as_deref()) {
        dict.set(
            "C",
            Object::Array(vec![
                number_object(rgb[0]),
                number_object(rgb[1]),
                number_object(rgb[2]),
            ]),
        );
    }
}

pub(crate) fn build_bookmark_dict(
    base_document: &Document,
    page_resolver: &PageTreeResolver,
    item: &BookmarkEntry,
) -> Result<Dictionary> {
    let mut dict = Dictionary::new();
    dict.set(
        "Title",
        Object::String(
            encode_pdf_text_string(&item.title),
            StringFormat::Hexadecimal,
        ),
    );
    set_bookmark_destination(base_document, page_resolver, &mut dict, item)?;
    set_bookmark_style(&mut dict, item);
    Ok(dict)
}

pub(crate) fn build_outline_level(
    document: &mut Document,
    page_resolver: &PageTreeResolver,
    items: &[BookmarkEntry],
    parent_ref: ObjectId,
) -> Result<OutlineBuildResult> {
    if items.is_empty() {
        return Ok(OutlineBuildResult {
            first: None,
            last: None,
            visible_count: 0,
        });
    }

    let mut nodes = Vec::with_capacity(items.len());
    for item in items {
        let dict = build_bookmark_dict(document, page_resolver, item)?;
        let object_id = document.new_object_id();
        document.set_object(object_id, Object::Dictionary(dict));
        nodes.push(BookmarkNode {
            object_id,
            item,
            visible_count: 1,
        });
    }

    for index in 0..nodes.len() {
        let previous = index
            .checked_sub(1)
            .and_then(|previous_index| nodes.get(previous_index))
            .map(|node| node.object_id);
        let next = nodes.get(index + 1).map(|node| node.object_id);
        let dict = document.get_dictionary_mut(nodes[index].object_id)?;
        dict.set("Parent", Object::Reference(parent_ref));
        if let Some(previous) = previous {
            dict.set("Prev", Object::Reference(previous));
        }
        if let Some(next) = next {
            dict.set("Next", Object::Reference(next));
        }
    }

    for node in &mut nodes {
        let child_result =
            build_outline_level(document, page_resolver, &node.item.items, node.object_id)?;
        if let (Some(first), Some(last)) = (child_result.first, child_result.last) {
            let dict = document.get_dictionary_mut(node.object_id)?;
            dict.set("First", Object::Reference(first));
            dict.set("Last", Object::Reference(last));
            if child_result.visible_count > 0 {
                dict.set("Count", Object::Integer(child_result.visible_count));
            }
            node.visible_count += child_result.visible_count;
        }
    }

    Ok(OutlineBuildResult {
        first: nodes.first().map(|node| node.object_id),
        last: nodes.last().map(|node| node.object_id),
        visible_count: nodes.iter().map(|node| node.visible_count).sum(),
    })
}

pub(crate) fn build_outline_level_incremental(
    incremental: &mut IncrementalDocument,
    page_resolver: &PageTreeResolver,
    items: &[BookmarkEntry],
    parent_ref: ObjectId,
) -> Result<OutlineBuildResult> {
    if items.is_empty() {
        return Ok(OutlineBuildResult {
            first: None,
            last: None,
            visible_count: 0,
        });
    }

    let mut nodes = Vec::with_capacity(items.len());
    for item in items {
        let dict = build_bookmark_dict(incremental.get_prev_documents(), page_resolver, item)?;
        let object_id = incremental.new_document.new_object_id();
        incremental
            .new_document
            .set_object(object_id, Object::Dictionary(dict));
        nodes.push(BookmarkNode {
            object_id,
            item,
            visible_count: 1,
        });
    }

    for index in 0..nodes.len() {
        let previous = index
            .checked_sub(1)
            .and_then(|previous_index| nodes.get(previous_index))
            .map(|node| node.object_id);
        let next = nodes.get(index + 1).map(|node| node.object_id);
        let dict = incremental
            .new_document
            .get_dictionary_mut(nodes[index].object_id)?;
        dict.set("Parent", Object::Reference(parent_ref));
        if let Some(previous) = previous {
            dict.set("Prev", Object::Reference(previous));
        }
        if let Some(next) = next {
            dict.set("Next", Object::Reference(next));
        }
    }

    for node in &mut nodes {
        let child_result = build_outline_level_incremental(
            incremental,
            page_resolver,
            &node.item.items,
            node.object_id,
        )?;
        if let (Some(first), Some(last)) = (child_result.first, child_result.last) {
            let dict = incremental
                .new_document
                .get_dictionary_mut(node.object_id)?;
            dict.set("First", Object::Reference(first));
            dict.set("Last", Object::Reference(last));
            if child_result.visible_count > 0 {
                dict.set("Count", Object::Integer(child_result.visible_count));
            }
            node.visible_count += child_result.visible_count;
        }
    }

    Ok(OutlineBuildResult {
        first: nodes.first().map(|node| node.object_id),
        last: nodes.last().map(|node| node.object_id),
        visible_count: nodes.iter().map(|node| node.visible_count).sum(),
    })
}

pub(crate) fn set_bookmarks_on_catalog(
    document: &mut Document,
    bookmarks: &BookmarksMutation,
) -> Result<()> {
    let page_resolver = PageTreeResolver::new(document)?;
    assert_mutation_page_count_with_resolver(
        &page_resolver,
        bookmarks.total_pages,
        "Bookmark mutation",
    )?;
    let normalized = normalize_bookmark_entries(
        &bookmarks.items,
        bookmarks.total_pages,
        &bookmarks.untitled_label,
    );
    let catalog_id = document.root_id()?;
    if normalized.is_empty() {
        let catalog = document.get_dictionary_mut(catalog_id)?;
        catalog.remove(b"Outlines");
        return Ok(());
    }

    let outlines_ref = document.new_object_id();
    let mut outlines_dict = Dictionary::new();
    outlines_dict.set("Type", Object::Name(b"Outlines".to_vec()));
    document.set_object(outlines_ref, Object::Dictionary(outlines_dict));
    let tree = build_outline_level(document, &page_resolver, &normalized, outlines_ref)?;
    let outlines_dict = document.get_dictionary_mut(outlines_ref)?;
    let (Some(first), Some(last)) = (tree.first, tree.last) else {
        let catalog = document.get_dictionary_mut(catalog_id)?;
        catalog.remove(b"Outlines");
        return Ok(());
    };
    outlines_dict.set("First", Object::Reference(first));
    outlines_dict.set("Last", Object::Reference(last));
    outlines_dict.set("Count", Object::Integer(tree.visible_count));
    let catalog = document.get_dictionary_mut(catalog_id)?;
    catalog.set("Outlines", Object::Reference(outlines_ref));
    Ok(())
}

pub(crate) fn set_bookmarks(document: &mut Document, bookmarks: &BookmarksMutation) -> Result<()> {
    set_bookmarks_on_catalog(document, bookmarks)
}

pub(crate) fn set_bookmarks_incremental(
    incremental: &mut IncrementalDocument,
    bookmarks: &BookmarksMutation,
    continuation: Option<&NativeMutationContinuation>,
) -> Result<()> {
    let page_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
    assert_mutation_page_count_with_resolver(
        &page_resolver,
        bookmarks.total_pages,
        "Bookmark mutation",
    )?;
    let normalized = normalize_bookmark_entries(
        &bookmarks.items,
        bookmarks.total_pages,
        &bookmarks.untitled_label,
    );
    let catalog_id = incremental.get_prev_documents().root_id()?;
    if continuation.is_some_and(|value| value.family == NativeMutationContinuationFamily::Bookmarks)
    {
        return append_bookmarks_incremental(
            incremental,
            &page_resolver,
            &normalized,
            continuation.and_then(|value| {
                (!value.bookmark_path.is_empty()).then_some(value.bookmark_path.as_slice())
            }),
        );
    }
    incremental.opt_clone_object_to_new_document(catalog_id)?;
    if normalized.is_empty() {
        let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
        catalog.remove(b"Outlines");
        return Ok(());
    }

    let outlines_ref = incremental.new_document.new_object_id();
    let mut outlines_dict = Dictionary::new();
    outlines_dict.set("Type", Object::Name(b"Outlines".to_vec()));
    incremental
        .new_document
        .set_object(outlines_ref, Object::Dictionary(outlines_dict));
    let tree =
        build_outline_level_incremental(incremental, &page_resolver, &normalized, outlines_ref)?;
    let outlines_dict = incremental.new_document.get_dictionary_mut(outlines_ref)?;
    let (Some(first), Some(last)) = (tree.first, tree.last) else {
        let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
        catalog.remove(b"Outlines");
        return Ok(());
    };
    outlines_dict.set("First", Object::Reference(first));
    outlines_dict.set("Last", Object::Reference(last));
    outlines_dict.set("Count", Object::Integer(tree.visible_count));
    let catalog = incremental.new_document.get_dictionary_mut(catalog_id)?;
    catalog.set("Outlines", Object::Reference(outlines_ref));
    Ok(())
}

fn outline_level_item_at(document: &Document, parent_id: ObjectId, index: u32) -> Result<ObjectId> {
    let parent = document.dictionary(parent_id)?;
    let mut current = parent.get(b"First")?.as_reference()?;
    for _ in 0..index {
        current = document.dictionary(current)?.get(b"Next")?.as_reference()?;
    }
    Ok(current)
}

fn append_bookmarks_incremental(
    incremental: &mut IncrementalDocument,
    page_resolver: &PageTreeResolver,
    items: &[BookmarkEntry],
    bookmark_path: Option<&[u32]>,
) -> Result<()> {
    let catalog_id = incremental.get_prev_documents().root_id()?;
    let previous_catalog = incremental.get_prev_documents().dictionary(catalog_id)?;
    let outlines_id = previous_catalog.get(b"Outlines")?.as_reference()?;
    let mut parent_id = outlines_id;
    let mut ancestor_ids = vec![outlines_id];
    incremental.opt_clone_object_to_new_document(catalog_id)?;
    incremental.opt_clone_object_to_new_document(outlines_id)?;
    if let Some(path) = bookmark_path {
        for index in path {
            parent_id = outline_level_item_at(incremental.get_prev_documents(), parent_id, *index)?;
            incremental.opt_clone_object_to_new_document(parent_id)?;
            ancestor_ids.push(parent_id);
        }
    }
    if items.is_empty() {
        return Ok(());
    }
    let tree = build_outline_level_incremental(incremental, page_resolver, items, parent_id)?;
    let (Some(first), Some(last)) = (tree.first, tree.last) else {
        return Ok(());
    };
    let previous_last = incremental
        .get_prev_documents()
        .dictionary(parent_id)
        .ok()
        .and_then(|dict| dict.get(b"Last").ok())
        .and_then(|value| value.as_reference().ok());
    if let Some(previous_last) = previous_last {
        incremental.opt_clone_object_to_new_document(previous_last)?;
        incremental
            .new_document
            .get_dictionary_mut(previous_last)?
            .set("Next", Object::Reference(first));
        incremental
            .new_document
            .get_dictionary_mut(first)?
            .set("Prev", Object::Reference(previous_last));
    } else {
        incremental
            .new_document
            .get_dictionary_mut(parent_id)?
            .set("First", Object::Reference(first));
    }
    let parent = incremental.new_document.get_dictionary_mut(parent_id)?;
    parent.set("Last", Object::Reference(last));
    add_outline_visible_count(parent, tree.visible_count);
    for ancestor_id in ancestor_ids
        .iter()
        .take(ancestor_ids.len().saturating_sub(1))
    {
        let ancestor = incremental.new_document.get_dictionary_mut(*ancestor_id)?;
        add_outline_visible_count(ancestor, tree.visible_count);
    }
    Ok(())
}

fn add_outline_visible_count(dictionary: &mut Dictionary, delta: i64) {
    let previous_count: i64 = dictionary
        .get(b"Count")
        .ok()
        .and_then(|value| value.as_i64().ok())
        .unwrap_or(0);
    let count = if previous_count < 0 {
        previous_count.saturating_sub(delta)
    } else {
        previous_count.saturating_add(delta)
    };
    dictionary.set("Count", Object::Integer(count));
}
