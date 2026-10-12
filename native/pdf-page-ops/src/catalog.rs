use super::*;
use serde::Serialize;

pub(super) const CATALOG_WALK_DEPTH_LIMIT: usize = 256;
const CATALOG_WALK_NODE_LIMIT: usize = 100_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfCombineCatalog {
    pub(crate) bookmarks: Vec<BookmarkEntry>,
    pub(crate) page_labels: Vec<PdfCombinePageLabelRange>,
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

pub(crate) struct CatalogWalkState {
    visited: HashSet<ObjectId>,
    nodes: usize,
}

impl CatalogWalkState {
    pub(crate) fn new() -> Self {
        Self {
            visited: HashSet::new(),
            nodes: 0,
        }
    }

    pub(crate) fn enter(&mut self, object: &Object) -> bool {
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

const MAX_OC_GRAPH_DEPTH: usize = 64;
const MAX_OC_GRAPH_NODES: usize = 100_000;

fn optional_content_limit(message: impl Into<String>) -> Box<dyn Error> {
    domain_error(NativeErrorCode::TooLarge, message)
}

fn push_object_graph_children<'a>(
    stack: &mut Vec<(&'a Object, usize)>,
    children: impl IntoIterator<Item = &'a Object>,
    child_depth: usize,
    visited_nodes: usize,
    max_depth: usize,
    max_nodes: usize,
) -> Result<()> {
    if child_depth > max_depth {
        return Err(optional_content_limit(format!(
            "PDF optional-content graph exceeds the {max_depth}-level traversal ceiling"
        )));
    }
    for child in children {
        if visited_nodes.saturating_add(stack.len()) >= max_nodes {
            return Err(optional_content_limit(format!(
                "PDF optional-content graph exceeds the {max_nodes}-node traversal ceiling"
            )));
        }
        stack.push((child, child_depth));
    }
    Ok(())
}

fn object_graph_is_complete_with_limits(
    document: &Document,
    root: &Object,
    max_depth: usize,
    max_nodes: usize,
) -> Result<bool> {
    let mut seen = HashSet::new();
    let mut stack = vec![(root, 0usize)];
    let mut visited_nodes = 0usize;
    while let Some((object, depth)) = stack.pop() {
        if visited_nodes >= max_nodes {
            return Err(optional_content_limit(format!(
                "PDF optional-content graph exceeds the {max_nodes}-node traversal ceiling"
            )));
        }
        visited_nodes += 1;
        let child_depth = depth.saturating_add(1);
        match object {
            Object::Reference(object_id) => {
                if !seen.insert(*object_id) {
                    continue;
                }
                let Some(referenced) = document.objects.get(object_id) else {
                    return Ok(false);
                };
                push_object_graph_children(
                    &mut stack,
                    std::iter::once(referenced),
                    child_depth,
                    visited_nodes,
                    max_depth,
                    max_nodes,
                )?;
            }
            Object::Array(items) => push_object_graph_children(
                &mut stack,
                items,
                child_depth,
                visited_nodes,
                max_depth,
                max_nodes,
            )?,
            Object::Dictionary(dictionary) => push_object_graph_children(
                &mut stack,
                dictionary.iter().map(|(_, value)| value),
                child_depth,
                visited_nodes,
                max_depth,
                max_nodes,
            )?,
            Object::Stream(stream) => push_object_graph_children(
                &mut stack,
                stream.dict.iter().map(|(_, value)| value),
                child_depth,
                visited_nodes,
                max_depth,
                max_nodes,
            )?,
            _ => {}
        }
    }
    Ok(true)
}

fn object_graph_is_complete(document: &Document, root: &Object) -> Result<bool> {
    object_graph_is_complete_with_limits(document, root, MAX_OC_GRAPH_DEPTH, MAX_OC_GRAPH_NODES)
}

fn resolve_object<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    document.dereference(object).ok().map(|(_, value)| value)
}

pub(crate) fn has_valid_oc_properties(document: &Document, catalog_id: ObjectId) -> Result<bool> {
    let Ok(catalog) = document.get_dictionary(catalog_id) else {
        return Ok(false);
    };
    let Ok(properties) = catalog.get(b"OCProperties") else {
        return Ok(true);
    };
    if !object_graph_is_complete(document, properties)? {
        return Ok(false);
    }
    let Some(properties) =
        resolve_object(document, properties).and_then(|value| value.as_dict().ok())
    else {
        return Ok(false);
    };
    let Some(groups) = properties
        .get(b"OCGs")
        .ok()
        .and_then(|value| resolve_object(document, value))
        .and_then(|value| value.as_array().ok())
    else {
        return Ok(false);
    };
    Ok(groups.iter().all(|group| {
        resolve_object(document, group)
            .and_then(|value| value.as_dict().ok())
            .is_some_and(|dictionary| {
                dictionary
                    .get(b"Type")
                    .and_then(Object::as_name)
                    .is_ok_and(|name| name == b"OCG")
            })
    }))
}

/// Reads the subset of a source catalog that the PDF combine paths preserve,
/// refusing the sources they cannot carry.
///
/// The PDF catalog structures are attacker-controlled linked graphs. Cycles
/// terminate the relevant walk, and both depth and node limits bound work on a
/// large or malformed catalog. Page references are indexed only when an
/// outline points at them, so a sparse page tree does not force a dense map.
pub(crate) fn read_pdf_combine_catalog(
    document: &impl PdfObjectSource,
) -> Result<PdfCombineCatalog> {
    validate_pdf_combine_catalog(document, document.dictionary(document.root_id()?)?)?;
    Ok(PdfCombineCatalog {
        bookmarks: read_pdf_outline(document, false)?,
        page_labels: read_pdf_page_labels(document)?,
    })
}

/// The catalog parts a document shows. Each is read on its own and carries
/// either its value or, as `<part>Error`, the reason it could not be read, so a
/// broken outline leaves the page labels readable and the reverse.
pub(crate) fn read_pdf_document_catalog(document: &impl PdfObjectSource) -> serde_json::Value {
    let mut catalog = serde_json::Map::new();
    for (part, read) in [
        (
            "bookmarks",
            read_pdf_outline(document, true).map(|value| serde_json::json!(value)),
        ),
        (
            "pageLabels",
            read_pdf_page_labels(document).map(|value| serde_json::json!(value)),
        ),
    ] {
        match read {
            Ok(value) => catalog.insert(part.to_string(), value),
            Err(error) => catalog.insert(format!("{part}Error"), error.to_string().into()),
        };
    }
    catalog.into()
}

fn read_pdf_page_labels(document: &impl PdfObjectSource) -> Result<Vec<PdfCombinePageLabelRange>> {
    match document.dictionary(document.root_id()?)?.get(b"PageLabels") {
        Ok(page_labels_object) => read_page_label_ranges(document, page_labels_object),
        Err(_) => Ok(Vec::new()),
    }
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
#[allow(dead_code)]
pub(crate) fn read_pdf_combine_catalog_from_bytes(data: &[u8]) -> Result<PdfCombineCatalog> {
    let document = load_browser_pdf(data)?;
    read_pdf_combine_catalog(&document)
}

pub(crate) fn write_pdf_combine_catalog(
    input_path: &Path,
    qpdf_path: Option<&Path>,
    output: &mut impl Write,
) -> Result<()> {
    let incremental = load_dictionary_incremental_pdf_path(input_path, qpdf_path)?;
    let source = AppendedRevision::new(&incremental);
    let catalog = read_pdf_combine_catalog(&source)?;
    serde_json::to_writer(output, &catalog)?;
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

pub(super) fn resolve_catalog_dictionary<'a>(
    document: &'a impl PdfObjectSource,
    object: &'a Object,
    label: &str,
) -> Result<&'a Dictionary> {
    document
        .resolved(object)?
        .as_dict()
        .map_err(|error| format!("PDF catalog /{label} must be a dictionary: {error}").into())
}

pub(crate) fn read_page_label_ranges(
    document: &impl PdfObjectSource,
    page_labels_object: &Object,
) -> Result<Vec<PdfCombinePageLabelRange>> {
    let mut entries = Vec::new();
    let mut state = CatalogWalkState::new();
    read_number_tree(document, page_labels_object, 0, &mut state, &mut entries)?;
    if entries.is_empty() {
        return Err("PageLabels has no usable ranges".into());
    }
    entries.sort_by_key(|(page_index, _)| *page_index);
    let mut output = Vec::new();
    let mut previous_page_index = None;
    for (page_index, value) in entries {
        let page_index = u32::try_from(page_index)
            .map_err(|_| "PageLabels range index is outside the supported bounds")?;
        if previous_page_index == Some(page_index) {
            return Err("PageLabels contains duplicate range indices".into());
        }
        previous_page_index = Some(page_index);
        let dictionary = resolve_catalog_dictionary(document, &value, "PageLabel")?;
        let style = match dictionary.get(b"S") {
            Ok(value) => {
                Some(String::from_utf8_lossy(document.resolved(value)?.as_name()?).into_owned())
            }
            Err(_) => None,
        };
        let prefix = match dictionary.get(b"P") {
            Ok(value) => Some(lopdf::decode_text_string(document.resolved(value)?)?),
            Err(_) => None,
        };
        let start = match dictionary.get(b"St") {
            Ok(value) => {
                let start = document.resolved(value)?.as_i64()?;
                Some(
                    u32::try_from(start)
                        .map_err(|_| "PageLabels start number is outside the supported bounds")?,
                )
            }
            Err(_) => None,
        };
        output.push(PdfCombinePageLabelRange {
            page_index,
            style,
            prefix,
            start,
        });
    }
    Ok(output)
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn add_implicit_default_page_label_range(
    ranges: &mut Vec<PdfCombinePageLabelRange>,
    page_count: u32,
) {
    if page_count > 0 && ranges.first().is_none_or(|range| range.page_index > 0) {
        ranges.insert(
            0,
            PdfCombinePageLabelRange {
                page_index: 0,
                style: None,
                prefix: None,
                start: None,
            },
        );
    }
}

pub(crate) fn read_number_tree(
    document: &impl PdfObjectSource,
    node_object: &Object,
    depth: usize,
    state: &mut CatalogWalkState,
    output: &mut Vec<(i64, Object)>,
) -> Result<()> {
    if depth >= CATALOG_WALK_DEPTH_LIMIT {
        return Err("PageLabels number tree exceeds the depth limit".into());
    }
    if output.len() >= CATALOG_WALK_NODE_LIMIT {
        return Err("PageLabels number tree exceeds the node limit".into());
    }
    if !state.enter(node_object) {
        return Err("PageLabels number tree contains a cycle or exceeds the node limit".into());
    }
    let node = resolve_catalog_dictionary(document, node_object, "PageLabels")?;
    if let Ok(nums_object) = node.get(b"Nums") {
        let nums = document.resolved(nums_object)?.as_array()?;
        if nums.is_empty() || nums.len() % 2 != 0 {
            return Err("PageLabels Nums must contain key/value pairs".into());
        }
        for pair in nums.chunks_exact(2) {
            if output.len() >= CATALOG_WALK_NODE_LIMIT {
                return Err("PageLabels number tree exceeds the node limit".into());
            }
            let start_page = pair[0].as_i64()?;
            if start_page < 0 {
                return Err("PageLabels range index must not be negative".into());
            }
            output.push((start_page, pair[1].clone()));
        }
    }
    if let Ok(kids_object) = node.get(b"Kids") {
        let kids = document.resolved(kids_object)?.as_array()?;
        for kid in kids {
            read_number_tree(document, kid, depth + 1, state, output)?;
        }
    }
    Ok(())
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

pub(super) fn assert_mutation_page_count_with_resolver(
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

#[cfg(test)]
mod optional_content_traversal_tests {
    use super::*;

    fn assert_too_large(result: Result<bool>, message_fragment: &str) {
        let error = result.unwrap_err();
        let native_error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        assert!(native_error.message.contains(message_fragment));
    }

    #[test]
    fn rejects_deep_direct_optional_content_nesting_without_recursion() {
        let document = Document::new();
        let mut nested = Object::Null;
        for _ in 0..65 {
            nested = Object::Array(vec![nested]);
        }

        assert_too_large(
            object_graph_is_complete(&document, &nested),
            "64-level traversal ceiling",
        );
    }

    #[test]
    fn rejects_broad_optional_content_graphs_at_the_node_ceiling() {
        let document = Document::new();
        let broad = Object::Array(vec![Object::Null; 8]);

        assert_too_large(
            object_graph_is_complete_with_limits(&document, &broad, 4, 4),
            "4-node traversal ceiling",
        );
    }

    #[test]
    fn accepts_optional_content_reference_cycles_once_each() {
        let mut document = Document::new();
        document.set_object((1, 0), Object::Reference((2, 0)));
        document.set_object(
            (2, 0),
            dictionary! {
                "Back" => Object::Reference((1, 0)),
            },
        );

        assert!(
            object_graph_is_complete_with_limits(&document, &Object::Reference((1, 0)), 8, 8,)
                .unwrap()
        );
    }

    #[test]
    fn accepts_valid_nested_optional_content_arrays_dictionaries_and_streams() {
        let mut document = Document::new();
        let pages_id = document.add_object(dictionary! {
            "Type" => "Pages",
            "Kids" => Vec::<Object>::new(),
            "Count" => 0,
        });
        let group_id = document.add_object(dictionary! {
            "Type" => "OCG",
            "Name" => Object::string_literal("Layer"),
        });
        let usage_id = document.add_object(Stream::new(
            dictionary! {
                "Nested" => dictionary! {
                    "Values" => vec![Object::Reference(group_id)],
                },
            },
            Vec::new(),
        ));
        let properties_id = document.add_object(dictionary! {
            "OCGs" => vec![Object::Reference(group_id)],
            "D" => dictionary! {
                "Order" => vec![
                    Object::string_literal("Layers"),
                    Object::Array(vec![Object::Reference(group_id)]),
                ],
                "UsageApplication" => usage_id,
            },
        });
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
            "OCProperties" => properties_id,
        });
        document.trailer.set("Root", catalog_id);

        assert!(has_valid_oc_properties(&document, catalog_id).unwrap());
    }
}
