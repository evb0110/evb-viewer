use super::*;
pub(crate) use evb_native_support::pdf_catalog::normalize_bookmark_entries;
use evb_native_support::pdf_catalog::{
    BookmarkActionTag, BookmarkActionValue, BookmarkOriginalDestination, BookmarkSourceTarget,
    MAX_BOOKMARK_ACTION_SIZE,
};
use lopdf::dictionary;

mod actions;
mod names;
use actions::kept_bookmark_action;
pub(crate) use actions::{bookmark_action_object, bookmark_name_object};
use names::{find_named_destination, named_dest_object, pdf_name_or_string, read_named_dest};

type BookmarkPageTarget = (ObjectId, Option<f64>, Option<BookmarkOriginalDestination>);

struct RawPdfCombineBookmarkEntry {
    title: String,
    page_id: Option<ObjectId>,
    page_y_ratio: Option<f64>,
    original_destination: Option<BookmarkOriginalDestination>,
    named_dest: Option<(String, Option<BookmarkActionValue>)>,
    original_action: Option<BookmarkActionValue>,
    items: Vec<RawPdfCombineBookmarkEntry>,
    bold: bool,
    italic: bool,
    color: Option<String>,
}

fn read_outline_items<'a>(
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
        // Only a GoTo action targets this document; the /D of GoToR names a
        // place in another file and must not resolve against local names.
        let action = dictionary
            .get(b"A")
            .ok()
            .and_then(|action| resolve_catalog_dictionary(document, action, "outline action").ok());
        let is_go_to = action.is_some_and(|action| {
            action
                .get(b"S")
                .and_then(Object::as_name)
                .is_ok_and(|kind| kind == b"GoTo")
        });
        let destination = dictionary.get(b"Dest").ok().cloned().or_else(|| {
            action
                .filter(|_| is_go_to)
                .and_then(|action| action.get(b"D").ok().cloned())
        });
        let page_target = destination.as_ref().and_then(|value| {
            destination_page_target(document, catalog, named_destinations, value)
        });
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
            original_action: action
                .filter(|_| !is_go_to)
                .and_then(|action| kept_bookmark_action(document, action, &title)),
            title,
            page_id,
            page_y_ratio: page_target.as_ref().and_then(|(_, ratio, _)| *ratio),
            original_destination: page_target.and_then(|(_, _, destination)| destination),
            named_dest: destination
                .as_ref()
                .and_then(|value| read_named_dest(document, value)),
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

/// A destination that cannot be resolved leaves only its own entry without a
/// target; its siblings and children read as they are.
fn destination_page_target<'a>(
    document: &'a impl PdfObjectSource,
    catalog: &'a Dictionary,
    named_destinations: &mut Option<HashMap<String, &'a Object>>,
    value: &Object,
) -> Option<BookmarkPageTarget> {
    let mut destination = document.resolved(value).ok()?.clone();
    if let Some(name) = pdf_name_or_string(&destination) {
        let named = find_named_destination(document, catalog, named_destinations, &name).ok()??;
        destination = document.resolved(&named).ok()?.clone();
    }
    if let Object::Dictionary(dictionary) = &destination {
        destination = document.resolved(dictionary.get(b"D").ok()?).ok()?.clone();
    }
    let array = destination.as_array().ok()?;
    let page_id = array.first()?.as_reference().ok()?;
    let ratio = destination_page_y_ratio(document, page_id, array)
        .ok()
        .flatten();
    let original_destination = if array.len() > 6 {
        None
    } else {
        serde_json::from_value(serde_json::json!({
        "sourceTarget": {"num": page_id.0, "gen": page_id.1},
        "kind": array.get(1).and_then(|value| value.as_name().ok()).and_then(|value| std::str::from_utf8(value).ok()),
        "coordinates": array.iter().skip(2).map(|value| if value.is_null() { Ok(None) } else { value.as_float().map(|number| Some(f64::from(number))) }).collect::<std::result::Result<Vec<_>, _>>().ok(),
    })).ok()
    };
    Some((page_id, ratio, original_destination))
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

/// Reads the outline. A name stays an entry's target only within its own
/// document; a combine resolves it, because the combined output does not carry
/// the source's name tree.
pub(crate) fn read_pdf_outline(
    document: &impl PdfObjectSource,
    keep_names: bool,
) -> Result<Vec<BookmarkEntry>> {
    let catalog = document.dictionary(document.root_id()?)?;
    let _page_resolver = PageTreeResolver::new(document)?;
    let Ok(outlines_object) = catalog.get(b"Outlines") else {
        return Ok(Vec::new());
    };
    let outlines = resolve_catalog_dictionary(document, outlines_object, "Outlines")?;
    let first = outlines.get(b"First").ok().cloned();
    let mut page_ids = HashSet::new();
    let bookmarks = read_outline_items(
        document,
        catalog,
        first.as_ref(),
        0,
        &mut CatalogWalkState::new(),
        &mut None,
        &mut page_ids,
    )?;
    let page_indices = collect_catalog_page_indices(document, &page_ids)?;
    Ok(bookmarks
        .into_iter()
        .map(|bookmark| finalize_bookmark(bookmark, &page_indices, keep_names))
        .collect())
}

fn finalize_bookmark(
    bookmark: RawPdfCombineBookmarkEntry,
    page_indices: &HashMap<ObjectId, u32>,
    keep_names: bool,
) -> BookmarkEntry {
    let page_index = bookmark
        .page_id
        .and_then(|page_id| page_indices.get(&page_id).copied());
    let (named_dest, original_named_dest) = bookmark.named_dest.filter(|_| keep_names).unzip();
    BookmarkEntry {
        title: bookmark.title,
        page_index,
        original_destination: bookmark
            .original_destination
            .filter(|_| named_dest.is_none())
            .and_then(|mut destination| {
                destination.source_target = BookmarkSourceTarget::PageIndex(page_index?);
                Some(destination)
            }),
        page_y_ratio: bookmark.page_y_ratio,
        named_dest,
        original_named_dest: original_named_dest.flatten(),
        original_action: bookmark.original_action,
        bold: bookmark.bold,
        italic: bookmark.italic,
        color: bookmark.color,
        items: bookmark
            .items
            .into_iter()
            .map(|item| finalize_bookmark(item, page_indices, keep_names))
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

fn validate_bookmark_source_references(
    document: &impl PdfObjectSource,
    items: &[BookmarkEntry],
) -> Result<()> {
    fn collect(items: &[BookmarkEntry], references: &mut HashSet<ObjectId>) {
        for item in items {
            if item.page_index.is_none() && item.named_dest.is_none() {
                if let Some(BookmarkOriginalDestination {
                    source_target: BookmarkSourceTarget::Reference { num, gen },
                    ..
                }) = &item.original_destination
                {
                    references.insert((*num, *gen));
                }
            }
            collect(&item.items, references);
        }
    }
    let mut references = HashSet::new();
    collect(items, &mut references);
    if collect_catalog_page_indices(document, &references)?.len() != references.len() {
        return Err("Original bookmark destination is not in the current page tree".into());
    }
    Ok(())
}

fn source_bookmark_destination(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    item: &BookmarkEntry,
) -> Result<Option<Object>> {
    use evb_native_support::pdf_catalog::BookmarkSourceTarget;
    if let Some(name) = item.named_dest.as_deref() {
        let original = item.original_named_dest.as_ref();
        return Ok(Some(named_dest_object(name, original)));
    }
    let Some(original) = &item.original_destination else {
        return Ok(None);
    };
    let page_id = match (item.page_index, &original.source_target) {
        (None, BookmarkSourceTarget::Reference { num, gen }) => (*num, *gen),
        (Some(index), _) | (None, &BookmarkSourceTarget::PageIndex(index)) => page_resolver
            .page_id(
                document,
                index.checked_add(1).ok_or("Invalid bookmark page index")?,
            )?,
    };
    let mut destination = vec![
        Object::Reference(page_id),
        Object::Name(original.kind.pdf_name()),
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
    if let Some(destination) = source_bookmark_destination(document, page_resolver, item)? {
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

    if bookmark.get(b"Dest").is_ok() {
        return Err("Bookmark unexpectedly retained a destination".into());
    }
    if let Some(action) = &item.original_action {
        if bookmark.get(b"A")? != &bookmark_action_object(action)? {
            return Err("Bookmark action did not match the request".into());
        }
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

pub(crate) fn set_bookmark_destination(
    base_document: &Document,
    page_resolver: &PageTreeResolver,
    dict: &mut Dictionary,
    item: &BookmarkEntry,
) -> Result<()> {
    if let Some(destination) = source_bookmark_destination(base_document, page_resolver, item)? {
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
    if let Some(action) = &item.original_action {
        dict.set("A", bookmark_action_object(action)?);
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

struct OutlineLevel {
    first: Option<ObjectId>,
    last: Option<ObjectId>,
    visible_count: i64,
}

/// New outline objects, numbered after the target's highest object number.
struct OutlineObjects {
    max_id: u32,
    objects: Vec<(ObjectId, Dictionary)>,
}

impl OutlineObjects {
    fn after(target: &Document) -> Self {
        Self {
            max_id: target.max_id,
            objects: Vec::new(),
        }
    }

    fn next_id(&mut self) -> ObjectId {
        self.max_id += 1;
        (self.max_id, 0)
    }

    /// Builds `items` under `parent_ref`, reading page targets from `source`.
    /// Siblings take consecutive numbers before any of their children.
    fn level(
        &mut self,
        source: &Document,
        page_resolver: &PageTreeResolver,
        items: &[BookmarkEntry],
        parent_ref: ObjectId,
    ) -> Result<OutlineLevel> {
        let ids = items.iter().map(|_| self.next_id()).collect::<Vec<_>>();
        let mut visible_count = 0;
        for (index, item) in items.iter().enumerate() {
            let title = encode_pdf_text_string(&item.title);
            let mut dict =
                dictionary! {"Title" => Object::String(title, StringFormat::Hexadecimal)};
            set_bookmark_destination(source, page_resolver, &mut dict, item)?;
            set_bookmark_style(&mut dict, item);
            dict.set("Parent", Object::Reference(parent_ref));
            if let Some(previous) = index.checked_sub(1).map(|previous| ids[previous]) {
                dict.set("Prev", Object::Reference(previous));
            }
            if let Some(next) = ids.get(index + 1) {
                dict.set("Next", Object::Reference(*next));
            }
            let children = self.level(source, page_resolver, &item.items, ids[index])?;
            if let (Some(first), Some(last)) = (children.first, children.last) {
                dict.set("First", Object::Reference(first));
                dict.set("Last", Object::Reference(last));
                if children.visible_count > 0 {
                    dict.set("Count", Object::Integer(children.visible_count));
                }
            }
            visible_count += 1 + children.visible_count;
            self.objects.push((ids[index], dict));
        }
        Ok(OutlineLevel {
            first: ids.first().copied(),
            last: ids.last().copied(),
            visible_count,
        })
    }

    /// Builds the whole outline and returns its `/Outlines` reference, or
    /// `None` for an empty outline.
    fn outline(
        &mut self,
        source: &Document,
        page_resolver: &PageTreeResolver,
        items: &[BookmarkEntry],
    ) -> Result<Option<ObjectId>> {
        if items.is_empty() {
            return Ok(None);
        }
        let outlines_ref = self.next_id();
        let level = self.level(source, page_resolver, items, outlines_ref)?;
        let Some((first, last)) = level.first.zip(level.last) else {
            return Ok(None);
        };
        self.objects.push((
            outlines_ref,
            dictionary! {
                "Type" => "Outlines",
                "First" => first,
                "Last" => last,
                "Count" => level.visible_count,
            },
        ));
        Ok(Some(outlines_ref))
    }

    fn add_to(self, target: &mut Document) {
        target.max_id = self.max_id;
        for (id, dict) in self.objects {
            target.set_object(id, dict);
        }
    }
}

fn set_catalog_outlines(catalog: &mut Dictionary, outlines: Option<ObjectId>) {
    match outlines {
        Some(outlines) => catalog.set("Outlines", Object::Reference(outlines)),
        None => drop(catalog.remove(b"Outlines")),
    }
}

fn normalized_bookmarks(
    source: &Document,
    page_resolver: &PageTreeResolver,
    bookmarks: &BookmarksMutation,
) -> Result<Vec<BookmarkEntry>> {
    assert_mutation_page_count_with_resolver(
        page_resolver,
        bookmarks.total_pages,
        "Bookmark mutation",
    )?;
    let normalized = normalize_bookmark_entries(
        &bookmarks.items,
        bookmarks.total_pages,
        &bookmarks.untitled_label,
    );
    validate_bookmark_source_references(source, &normalized)?;
    Ok(normalized)
}

pub(crate) fn set_bookmarks(document: &mut Document, bookmarks: &BookmarksMutation) -> Result<()> {
    let page_resolver = PageTreeResolver::new(document)?;
    let normalized = normalized_bookmarks(document, &page_resolver, bookmarks)?;
    let mut objects = OutlineObjects::after(document);
    let outlines = objects.outline(document, &page_resolver, &normalized)?;
    objects.add_to(document);
    set_catalog_outlines(document.catalog_mut()?, outlines);
    Ok(())
}

pub(crate) fn set_bookmarks_incremental(
    incremental: &mut IncrementalDocument,
    bookmarks: &BookmarksMutation,
    continuation: Option<&NativeMutationContinuation>,
) -> Result<()> {
    let page_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
    let normalized =
        normalized_bookmarks(incremental.get_prev_documents(), &page_resolver, bookmarks)?;
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
    let catalog_id = incremental.get_prev_documents().root_id()?;
    incremental.opt_clone_object_to_new_document(catalog_id)?;
    let mut objects = OutlineObjects::after(&incremental.new_document);
    let outlines = objects.outline(
        incremental.get_prev_documents(),
        &page_resolver,
        &normalized,
    )?;
    objects.add_to(&mut incremental.new_document);
    set_catalog_outlines(
        incremental.new_document.get_dictionary_mut(catalog_id)?,
        outlines,
    );
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
    let mut objects = OutlineObjects::after(&incremental.new_document);
    let tree = objects.level(
        incremental.get_prev_documents(),
        page_resolver,
        items,
        parent_id,
    )?;
    objects.add_to(&mut incremental.new_document);
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
