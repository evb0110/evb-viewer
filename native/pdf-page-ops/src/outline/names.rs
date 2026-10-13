use super::actions::{bookmark_action_value, bookmark_name_object};
use super::*;

/// Looks a name up in the legacy `/Dests` dictionary, then in the `/Names
/// /Dests` tree. The tree is walked once per catalog read, on the first named
/// destination, so each further bookmark costs one map lookup.
pub(super) fn find_named_destination<'a>(
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

/// Reads a destination name with its source form. The form is kept only when
/// the writer would encode the name differently, as for a PDFDocEncoding string
/// or an ASCII name in UTF-16, so that an untouched name is written back with
/// the bytes its name tree key has. A form over the action size ceiling is not
/// kept, and its name is written as an edited one.
pub(super) fn read_named_dest(
    document: &impl PdfObjectSource,
    destination: &Object,
) -> Option<(String, Option<BookmarkActionValue>)> {
    let source = document.resolved(destination).ok()?;
    let name = pdf_name_or_string(source)?;
    let original = Some(source)
        .filter(|source| **source != named_dest_object(&name, None))
        .and_then(|source| {
            bookmark_action_value(document, source, 0, &mut { MAX_BOOKMARK_ACTION_SIZE }).ok()
        });
    Some((name, original))
}

/// Writes a destination name. An untouched name keeps its source form. An
/// edited or new one is written as readers match it by its bytes: an ASCII
/// name with its literal bytes, and any other as the UTF-16 text string
/// producers write for it.
pub(super) fn named_dest_object(name: &str, original: Option<&BookmarkActionValue>) -> Object {
    original
        .and_then(|original| bookmark_name_object(original).ok())
        .filter(|object| pdf_name_or_string(object).as_deref() == Some(name))
        .unwrap_or_else(|| match name.is_ascii() {
            true => Object::String(name.as_bytes().to_vec(), StringFormat::Literal),
            false => Object::String(encode_pdf_text_string(name), StringFormat::Hexadecimal),
        })
}

pub(super) fn pdf_name_or_string(object: &Object) -> Option<String> {
    pdf_string_to_text(object).or_else(|| {
        object
            .as_name()
            .ok()
            .map(|value| String::from_utf8_lossy(value).into_owned())
    })
}

// A /Page dictionary can survive deletion while no longer belonging to the
// page tree. Resolve all pending identities in one bounded source-tree walk.

/// Resolve accepted outline targets before whole-file page operations change
/// object identities. An unknown target keeps its entry and original intent.
pub(crate) fn resolve_bookmark_source_targets(
    document: &impl PdfObjectSource,
    items: &mut [BookmarkEntry],
) -> Result<()> {
    use evb_native_support::pdf_catalog::BookmarkSourceTarget;
    let catalog = document.dictionary(document.root_id()?)?;
    let mut indices = HashMap::new();
    let mut index = 0_u32;
    PageTreeResolver::new(document)?.for_each_page_id(document, |id| {
        indices.insert(id, index);
        index = index.checked_add(1).ok_or("Invalid bookmark page index")?;
        Ok(())
    })?;
    fn resolve<'a>(
        document: &'a impl PdfObjectSource,
        catalog: &'a Dictionary,
        names: &mut Option<HashMap<String, &'a Object>>,
        indices: &HashMap<ObjectId, u32>,
        items: &mut [BookmarkEntry],
    ) -> Result<()> {
        for item in items {
            let target = if let Some(name) = item.named_dest.as_deref() {
                destination_page_target(
                    document,
                    catalog,
                    names,
                    &named_dest_object(name, item.original_named_dest.as_ref()),
                )
                .map(|target| target.0)
            } else if item.page_index.is_none() {
                match item.original_destination.as_ref().map(|d| &d.source_target) {
                    Some(BookmarkSourceTarget::Reference { num, gen }) => Some((*num, *gen)),
                    _ => None,
                }
            } else {
                None
            };
            if let Some(index) = target.and_then(|id| indices.get(&id)) {
                item.page_index = Some(*index);
                if let Some(destination) = &mut item.original_destination {
                    destination.source_target = BookmarkSourceTarget::PageIndex(*index);
                }
            }
            resolve(document, catalog, names, indices, &mut item.items)?;
        }
        Ok(())
    }
    resolve(document, catalog, &mut None, &indices, items)
}
