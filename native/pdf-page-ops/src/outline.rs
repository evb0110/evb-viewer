use super::*;
use evb_native_support::pdf_catalog::{BookmarkOriginalDestination, BookmarkSourceTarget};
use serde::Serialize;

type BookmarkPageTarget = (ObjectId, Option<f64>, Option<BookmarkOriginalDestination>);
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfCombineBookmarkEntry {
    pub(crate) title: String,
    pub(crate) page_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) page_y_ratio: Option<f64>,
    pub(crate) named_dest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) original_destination: Option<BookmarkOriginalDestination>,
    pub(crate) bold: bool,
    pub(crate) italic: bool,
    pub(crate) color: Option<String>,
    pub(crate) items: Vec<PdfCombineBookmarkEntry>,
}

pub(super) struct RawPdfCombineBookmarkEntry {
    title: String,
    page_id: Option<ObjectId>,
    page_y_ratio: Option<f64>,
    original_destination: Option<BookmarkOriginalDestination>,
    items: Vec<RawPdfCombineBookmarkEntry>,
    bold: bool,
    italic: bool,
    color: Option<String>,
}

pub(super) fn read_outline_items<'a>(
    document: &'a impl PdfObjectSource,
    catalog: &'a Dictionary,
    first: Option<&Object>,
    depth: usize,
    state: &mut CatalogWalkState,
    named_destinations: &mut Option<HashMap<String, &'a Object>>,
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
        let page_target = destination
            .as_ref()
            .map(|value| destination_page_target(document, catalog, named_destinations, value))
            .transpose()?
            .flatten();
        let page_id = page_target.as_ref().map(|(page_id, _, _)| *page_id);
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
            page_y_ratio: page_target.as_ref().and_then(|(_, ratio, _)| *ratio),
            original_destination: page_target.and_then(|(_, _, destination)| destination),
            items: read_outline_items(
                document,
                catalog,
                first_child.as_ref(),
                depth + 1,
                state,
                named_destinations,
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

fn destination_page_target<'a>(
    document: &'a impl PdfObjectSource,
    catalog: &'a Dictionary,
    named_destinations: &mut Option<HashMap<String, &'a Object>>,
    value: &Object,
) -> Result<Option<BookmarkPageTarget>> {
    let mut destination = document.resolved(value)?.clone();
    if let Some(name) = pdf_name_or_string(&destination) {
        let Some(named_destination) =
            find_named_destination(document, catalog, named_destinations, &name)?
        else {
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
    let Ok(page_id) = first.as_reference() else {
        return Ok(None);
    };
    let ratio = destination_page_y_ratio(document, page_id, array)?;
    let original_destination = if array.len() > 6 {
        None
    } else {
        serde_json::from_value(serde_json::json!({
        "sourceTarget": {"num": page_id.0, "gen": page_id.1},
        "kind": array.get(1).and_then(|value| value.as_name().ok()).and_then(|value| std::str::from_utf8(value).ok()),
        "coordinates": array.iter().skip(2).map(|value| if value.is_null() { Ok(None) } else { value.as_float().map(|number| Some(f64::from(number))) }).collect::<std::result::Result<Vec<_>, _>>().ok(),
    })).ok()
    };
    Ok(Some((page_id, ratio, original_destination)))
}

fn destination_page_y_ratio(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
    destination: &[Object],
) -> Result<Option<f64>> {
    let kind = destination.get(1).and_then(|value| value.as_name().ok());
    if matches!(kind, Some(b"Fit" | b"FitB")) {
        return Ok(Some(0.0));
    }
    let number = |index: usize| {
        destination
            .get(index)
            .and_then(|value| value.as_float().ok())
            .map(f64::from)
    };
    let (left, top) = match kind {
        Some(b"XYZ") => (number(2), number(3)),
        Some(b"FitH" | b"FitBH") => (None, number(2)),
        Some(b"FitV" | b"FitBV") => (number(2), None),
        Some(b"FitR") => (number(2), number(5)),
        _ => return Ok(None),
    };
    let view = resolve_page_view(document, page_id)?;
    let rotation = resolve_page_rotation(document, page_id)?;
    let origin = pdf_point_from_marker_point(0.0, 0.0, view, rotation);
    let bottom = pdf_point_from_marker_point(0.0, 1.0, view, rotation);
    let project = |x: Option<f64>, y: Option<f64>| {
        if bottom.0 != origin.0 {
            x.map(|x| (x - origin.0) / (bottom.0 - origin.0))
        } else {
            y.map(|y| (y - origin.1) / (bottom.1 - origin.1))
        }
    };
    let mut ratio = project(left, top);
    if kind == Some(b"FitR") {
        ratio = ratio
            .zip(project(number(4), number(3)))
            .map(|(a, b)| a.min(b));
    }
    Ok(ratio
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0)))
}

/// Looks a name up in the legacy `/Dests` dictionary, then in the `/Names
/// /Dests` tree. The tree is walked once per catalog read, on the first named
/// destination, so each further bookmark costs one map lookup.
fn find_named_destination<'a>(
    document: &'a impl PdfObjectSource,
    catalog: &'a Dictionary,
    named_destinations: &mut Option<HashMap<String, &'a Object>>,
    name: &str,
) -> Result<Option<Object>> {
    if let Ok(dests_object) = catalog.get(b"Dests") {
        let dests = resolve_catalog_dictionary(document, dests_object, "Dests")?;
        if let Ok(destination) = dests.get(name.as_bytes()) {
            return Ok(Some(destination.clone()));
        }
    }

    let named_destinations = match named_destinations {
        Some(named_destinations) => named_destinations,
        None => named_destinations.insert(read_named_destination_tree(document, catalog)?),
    };
    Ok(named_destinations.get(name).copied().cloned())
}

fn read_named_destination_tree<'a>(
    document: &'a impl PdfObjectSource,
    catalog: &'a Dictionary,
) -> Result<HashMap<String, &'a Object>> {
    let mut entries = HashMap::new();
    let names_object = match catalog.get(b"Names") {
        Ok(names_object) => names_object,
        Err(_) => return Ok(entries),
    };
    let names = resolve_catalog_dictionary(document, names_object, "Names")?;
    let dests_object = match names.get(b"Dests") {
        Ok(dests_object) => dests_object,
        Err(_) => return Ok(entries),
    };
    let mut state = CatalogWalkState::new();
    collect_named_destination_tree(document, dests_object, 0, &mut state, &mut entries);
    Ok(entries)
}

/// Collects the tree in depth-first order, keeping the first value of a
/// repeated name. A malformed node ends only its own subtree, and the shared
/// walk state bounds the whole tree by depth, node count and cycles.
fn collect_named_destination_tree<'a>(
    document: &'a impl PdfObjectSource,
    node_object: &'a Object,
    depth: usize,
    state: &mut CatalogWalkState,
    entries: &mut HashMap<String, &'a Object>,
) {
    if depth >= CATALOG_WALK_DEPTH_LIMIT || !state.enter(node_object) {
        return;
    }
    let Ok(node) = resolve_catalog_dictionary(document, node_object, "destination name tree")
    else {
        return;
    };
    if let Ok(entries_object) = node.get(b"Names") {
        let Some(pairs) = document
            .resolved(entries_object)
            .ok()
            .and_then(|value| value.as_array().ok())
        else {
            return;
        };
        for pair in pairs.chunks_exact(2) {
            if let Some(name) = pdf_name_or_string(&pair[0]) {
                entries.entry(name).or_insert(&pair[1]);
            }
        }
    }
    let Ok(kids_object) = node.get(b"Kids") else {
        return;
    };
    let Some(kids) = document
        .resolved(kids_object)
        .ok()
        .and_then(|value| value.as_array().ok())
    else {
        return;
    };
    for kid in kids {
        collect_named_destination_tree(document, kid, depth + 1, state, entries);
    }
}

pub(super) fn collect_catalog_page_indices(
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

pub(super) fn finalize_bookmark(
    bookmark: RawPdfCombineBookmarkEntry,
    page_indices: &HashMap<ObjectId, u32>,
) -> PdfCombineBookmarkEntry {
    let page_index = bookmark
        .page_id
        .and_then(|page_id| page_indices.get(&page_id).copied());
    PdfCombineBookmarkEntry {
        title: bookmark.title,
        page_index,
        original_destination: bookmark.original_destination.and_then(|mut destination| {
            destination.source_target = BookmarkSourceTarget::PageIndex(page_index?);
            Some(destination)
        }),
        page_y_ratio: bookmark.page_y_ratio,
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

fn pdf_name_or_string(object: &Object) -> Option<String> {
    pdf_string_to_text(object).or_else(|| {
        object
            .as_name()
            .ok()
            .map(|value| String::from_utf8_lossy(value).into_owned())
    })
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
                original_destination: item.original_destination.clone(),
                bold: item.bold,
                italic: item.italic,
                color: normalize_bookmark_color(item.color.as_deref()),
                items: normalize_bookmark_entries(&item.items, total_pages, untitled_label),
            }
        })
        .collect()
}

fn original_bookmark_destination(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    item: &BookmarkEntry,
) -> Result<Option<Object>> {
    use evb_native_support::pdf_catalog::BookmarkSourceTarget;
    let Some(original) = &item.original_destination else {
        return Ok(None);
    };
    let page_id = match (item.page_index, &original.source_target) {
        (Some(index), _) => page_resolver.page_id(
            document,
            index.checked_add(1).ok_or("Invalid bookmark page index")?,
        )?,
        (None, BookmarkSourceTarget::PageIndex(index)) => page_resolver.page_id(
            document,
            index.checked_add(1).ok_or("Invalid bookmark page index")?,
        )?,
        (None, BookmarkSourceTarget::Reference { num, gen }) => (*num, *gen),
    };
    // A source reference must still be a page, rather than an arbitrary object.
    let page = document.dictionary(page_id)?;
    if page.get(b"Type")?.as_name()? != b"Page" {
        return Err("Original bookmark destination does not reference a page".into());
    }
    let mut destination = vec![
        Object::Reference(page_id),
        Object::Name(original.kind.pdf_name().to_vec()),
    ];
    destination.extend(
        original
            .coordinates
            .iter()
            .map(|value| value.map(number_object).unwrap_or(Object::Null)),
    );
    Ok(Some(Object::Array(destination)))
}

pub(crate) fn validate_bookmark_destination(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    bookmark: &Dictionary,
    item: &BookmarkEntry,
) -> Result<()> {
    if let Some(destination) = original_bookmark_destination(document, page_resolver, item)? {
        if bookmark.get(b"Dest")? != &destination {
            return Err("Bookmark original destination did not match the request".into());
        }
        return Ok(());
    }
    if let Some(page_index) = item.page_index {
        let page_id = page_resolver.page_id(
            document,
            page_index
                .checked_add(1)
                .ok_or("Invalid bookmark page index")?,
        )?;
        let page_view = resolve_page_view(document, page_id)?;
        let (expected_left, expected_top) = resolve_bookmark_destination_position(
            page_view,
            resolve_page_rotation(document, page_id)?,
            item.page_y_ratio,
        );
        let destination = bookmark.get(b"Dest")?.as_array()?;
        if destination.len() != 5
            || destination[0].as_reference()? != page_id
            || destination[1].as_name()? != b"XYZ"
            || match expected_left {
                Some(left) => (f64::from(destination[2].as_float()?) - left).abs() > 0.01,
                None => !destination[2].is_null(),
            }
            || (f64::from(destination[3].as_float()?) - expected_top).abs() > 0.01
            || !destination[4].is_null()
        {
            return Err("Bookmark destination did not match the requested page position".into());
        }
        return Ok(());
    }

    if let Some(named_dest) = item.named_dest.as_deref() {
        if bookmark.get(b"Dest")?.as_str()? != named_dest.as_bytes() {
            return Err("Bookmark named destination did not match the request".into());
        }
    } else if bookmark.get(b"Dest").is_ok() {
        return Err("Bookmark unexpectedly retained a destination".into());
    }
    Ok(())
}

pub(crate) fn resolve_bookmark_destination_position(
    page_view: PdfRect,
    page_rotation: i64,
    page_y_ratio: Option<f64>,
) -> (Option<f64>, f64) {
    let ratio = page_y_ratio.unwrap_or(0.0).clamp(0.0, 1.0);
    let (left, top) = pdf_point_from_marker_point(0.0, ratio, page_view, page_rotation);
    (matches!(page_rotation, 90 | 270).then_some(left), top)
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
    if let Some(destination) = original_bookmark_destination(base_document, page_resolver, item)? {
        dict.set("Dest", destination);
        return Ok(());
    }
    if let Some(page_index) = item.page_index {
        let page_number = page_index
            .checked_add(1)
            .ok_or("Invalid bookmark page index")?;
        let page_id = page_resolver.page_id(base_document, page_number)?;
        let page_view = resolve_page_view(base_document, page_id)?;
        let page_rotation = resolve_page_rotation(base_document, page_id)?;
        let (destination_left, destination_top) =
            resolve_bookmark_destination_position(page_view, page_rotation, item.page_y_ratio);
        dict.set(
            "Dest",
            Object::Array(vec![
                Object::Reference(page_id),
                Object::Name(b"XYZ".to_vec()),
                destination_left.map(number_object).unwrap_or(Object::Null),
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
