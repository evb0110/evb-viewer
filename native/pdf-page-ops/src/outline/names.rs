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
