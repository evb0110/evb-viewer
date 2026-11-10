//! Prunes structure membership against the output page tree, without rewriting content.
use super::*;
use crate::catalog::{CatalogWalkState, CATALOG_WALK_DEPTH_LIMIT};

struct StructureSubset<'a> {
    source: &'a Document,
    pages: HashSet<ObjectId>,
    annotations: HashSet<ObjectId>,
    retained: HashSet<ObjectId>,
    owners: HashMap<ObjectId, ObjectId>,
    state: CatalogWalkState,
    updates: Vec<(ObjectId, Object)>,
}

impl StructureSubset<'_> {
    fn kid(&mut self, object: &Object, page: Option<ObjectId>, depth: usize) -> Option<Object> {
        if depth > CATALOG_WALK_DEPTH_LIMIT || !self.state.enter(object) {
            return None;
        }
        let (id, resolved) = self.source.dereference(object).ok()?;
        let value = match resolved {
            Object::Integer(mcid) if *mcid >= 0 && page.is_some() => resolved.clone(),
            Object::Array(items) => {
                let kept = items
                    .iter()
                    .filter_map(|item| self.kid(item, page, depth + 1))
                    .collect::<Vec<_>>();
                if kept.is_empty() {
                    return None;
                }
                Object::Array(kept)
            }
            Object::Dictionary(dictionary) => {
                let mut dictionary = dictionary.clone();
                let page = match dictionary.get(b"Pg") {
                    Ok(value) => value
                        .as_reference()
                        .ok()
                        .filter(|id| self.pages.contains(id)),
                    Err(_) => page,
                };
                if page.is_none() {
                    dictionary.remove(b"Pg");
                }
                match dictionary.get(b"Type").and_then(Object::as_name).ok() {
                    Some(b"OBJR") => {
                        let object = dictionary.get(b"Obj").and_then(Object::as_reference).ok()?;
                        if !self.annotations.contains(&object) {
                            return None;
                        }
                    }
                    _ if dictionary.has(b"MCID") && page.is_some() => {}
                    Some(b"MCR") => return None,
                    _ => {
                        let kids = dictionary
                            .get(b"K")
                            .ok()
                            .and_then(|kids| self.kid(kids, page, depth + 1));
                        if let Some(kids) = kids {
                            dictionary.set("K", kids);
                        } else if page.is_some() {
                            // ABBYY also emits page-owned Figure leaves without K.
                            dictionary.remove(b"K");
                        } else {
                            return None;
                        }
                    }
                }
                if let (Some(id), Some(page)) = (id, page) {
                    self.owners.insert(id, page);
                }
                Object::Dictionary(dictionary)
            }
            _ => return None,
        };
        if let Some(id) = id {
            self.retained.insert(id);
            self.updates.push((id, value));
            Some(Object::Reference(id))
        } else {
            Some(value)
        }
    }

    fn names(&mut self, object: &Object, depth: usize, names: &mut Vec<Object>) {
        if depth > CATALOG_WALK_DEPTH_LIMIT || !self.state.enter(object) {
            return;
        }
        let Some(dictionary) = self
            .source
            .resolved(object)
            .ok()
            .and_then(|value| value.as_dict().ok())
        else {
            return;
        };
        if let Ok(items) = dictionary.get(b"Names").and_then(Object::as_array) {
            for pair in items.chunks_exact(2) {
                if pair[1]
                    .as_reference()
                    .is_ok_and(|id| self.retained.contains(&id))
                {
                    names.extend_from_slice(pair);
                }
            }
        }
        if let Ok(kids) = dictionary.get(b"Kids").and_then(Object::as_array) {
            for kid in kids {
                self.names(kid, depth + 1, names);
            }
        }
    }

    fn parent_tree(
        &mut self,
        object: &Object,
        depth: usize,
        keys: &HashSet<i64>,
        nums: &mut BTreeMap<i64, Object>,
    ) {
        if depth > CATALOG_WALK_DEPTH_LIMIT || !self.state.enter(object) {
            return;
        }
        let Some(dictionary) = self
            .source
            .resolved(object)
            .ok()
            .and_then(|value| value.as_dict().ok())
        else {
            return;
        };
        if let Ok(items) = dictionary.get(b"Nums").and_then(Object::as_array) {
            for pair in items.chunks_exact(2) {
                let Ok(key) = pair[0].as_i64() else {
                    continue;
                };
                if !keys.contains(&key) {
                    continue;
                }
                let Ok(value) = self.source.resolved(&pair[1]) else {
                    continue;
                };
                let value = match value {
                    Object::Array(items) => Object::Array(
                        items
                            .iter()
                            .map(|item| {
                                if item
                                    .as_reference()
                                    .is_ok_and(|id| self.retained.contains(&id))
                                {
                                    item.clone()
                                } else {
                                    Object::Null
                                }
                            })
                            .collect(),
                    ),
                    _ if pair[1]
                        .as_reference()
                        .is_ok_and(|id| self.retained.contains(&id)) =>
                    {
                        pair[1].clone()
                    }
                    _ => continue,
                };
                nums.insert(key, value);
            }
        }
        if let Ok(kids) = dictionary.get(b"Kids").and_then(Object::as_array) {
            for kid in kids {
                self.parent_tree(kid, depth + 1, keys, nums);
            }
        }
    }
}

/// qpdf and the browser cloner keep stream/MCID identities. Reconcile their
/// surviving structure nodes and number-tree keys with the new page membership.
/// Malformed, cyclic or unrepresentable branches are omitted, never admission gates.
pub(crate) fn page_structure_updates(source: &Document) -> Result<Vec<(ObjectId, Object)>> {
    let mut catalog = source.catalog()?.clone();
    if !catalog.has(b"StructTreeRoot")
        && !catalog.has(b"OCProperties")
        && !source.objects.values().any(|object| {
            object.as_dict().is_ok_and(|dictionary| {
                dictionary.has(b"StructParents")
                    || dictionary.has(b"StructParent")
                    || dictionary.get(b"Type").and_then(Object::as_name).ok() == Some(b"OCG")
            })
        })
    {
        return Ok(Vec::new());
    }
    let root = catalog
        .get(b"StructTreeRoot")
        .cloned()
        .unwrap_or(Object::Null);
    let pages = source.get_pages().into_values().collect::<HashSet<_>>();
    let annotations = pages
        .iter()
        .flat_map(|id| crate::split_navigation::source_annotation_entries(source, *id))
        .filter_map(|item| item.as_reference().ok())
        .collect::<HashSet<_>>();
    let mut keys = HashSet::new();
    for (ids, key) in [
        (&pages, b"StructParents".as_slice()),
        (&annotations, b"StructParent".as_slice()),
    ] {
        for id in ids {
            if let Ok(value) = source
                .get_dictionary(*id)
                .and_then(|dict| dict.get(key))
                .and_then(Object::as_i64)
            {
                keys.insert(value);
            }
        }
    }
    let mut subset = StructureSubset {
        source,
        pages,
        annotations,
        retained: HashSet::new(),
        owners: HashMap::new(),
        state: CatalogWalkState::new(),
        updates: Vec::new(),
    };
    let mut tree = source
        .resolved(&root)
        .ok()
        .and_then(|value| value.as_dict().ok())
        .cloned();
    let kids = tree
        .as_ref()
        .and_then(|tree| tree.get(b"K").ok())
        .and_then(|kids| subset.kid(kids, None, 0));
    if let (Some(tree), Some(kids)) = (tree.as_mut(), kids) {
        tree.set("K", kids);
        let mut nums = BTreeMap::new();
        subset.state = CatalogWalkState::new();
        if let Ok(parent_tree) = tree.get(b"ParentTree") {
            subset.parent_tree(parent_tree, 0, &keys, &mut nums);
        }
        // Imported pages may reuse a primary source's ParentTree key. Only
        // pages actually owning that structure may advertise its membership.
        for id in &subset.pages {
            let page = source.get_dictionary(*id)?;
            if let Ok(key) = page.get(b"StructParents").and_then(Object::as_i64) {
                let owns_tags = nums
                    .get(&key)
                    .and_then(|value| value.as_array().ok())
                    .is_some_and(|items| {
                        items.iter().any(|item| {
                            item.as_reference()
                                .ok()
                                .and_then(|id| subset.owners.get(&id))
                                == Some(id)
                        })
                    });
                if !owns_tags {
                    let mut page = page.clone();
                    page.remove(b"StructParents");
                    subset.updates.push((*id, Object::Dictionary(page)));
                }
            }
        }
        // An annotation's StructParent names one retained element, or nothing.
        for id in &subset.annotations {
            let annotation = source.get_dictionary(*id)?;
            if let Ok(key) = annotation.get(b"StructParent").and_then(Object::as_i64) {
                let owned = nums
                    .get(&key)
                    .and_then(|value| value.as_reference().ok())
                    .is_some_and(|element| subset.retained.contains(&element));
                if !owned {
                    let mut annotation = annotation.clone();
                    annotation.remove(b"StructParent");
                    subset.updates.push((*id, Object::Dictionary(annotation)));
                }
            }
        }
        tree.set("ParentTree", lopdf::dictionary! { "Nums" => nums.into_iter().flat_map(|(key, value)| [Object::Integer(key), value]).collect::<Vec<_>>() });
        if let Ok(ids) = tree.get(b"IDTree") {
            let mut names = Vec::new();
            subset.state = CatalogWalkState::new();
            subset.names(ids, 0, &mut names);
            tree.set("IDTree", lopdf::dictionary! { "Names" => names });
        }
        for (_, object) in &mut subset.updates {
            if let Ok(dictionary) = object.as_dict_mut() {
                if let Ok(references) = dictionary.get(b"Ref").and_then(Object::as_array) {
                    let kept = references
                        .iter()
                        .filter(|item| {
                            item.as_reference()
                                .is_ok_and(|id| subset.retained.contains(&id))
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    dictionary.set("Ref", kept);
                }
            }
        }
        if let Ok(id) = root.as_reference() {
            subset.updates.push((id, Object::Dictionary(tree.clone())));
        } else {
            catalog.set("StructTreeRoot", tree.clone());
        }
    } else {
        catalog.remove(b"StructTreeRoot");
        catalog.remove(b"MarkInfo");
        for id in &subset.pages {
            let mut page = source.get_dictionary(*id)?.clone();
            if page.remove(b"StructParents").is_some() {
                subset.updates.push((*id, Object::Dictionary(page)));
            }
        }
        for id in &subset.annotations {
            let mut annotation = source.get_dictionary(*id)?.clone();
            if annotation.remove(b"StructParent").is_some() {
                subset.updates.push((*id, Object::Dictionary(annotation)));
            }
        }
    }
    // Page resources carry OCG identities even when an imported catalog cannot
    // be carried wholesale. Register those groups, retaining the primary
    // document's default visibility and configuration wherever it is valid.
    let groups = source
        .objects
        .iter()
        .filter_map(|(id, object)| {
            object
                .as_dict()
                .ok()
                .filter(|dictionary| {
                    dictionary.get(b"Type").and_then(Object::as_name).ok() == Some(b"OCG")
                })
                .map(|_| Object::Reference(*id))
        })
        .collect::<Vec<_>>();
    if !groups.is_empty() {
        let mut properties = catalog
            .get(b"OCProperties")
            .ok()
            .and_then(|value| source.resolved(value).ok())
            .and_then(|value| value.as_dict().ok())
            .cloned()
            .unwrap_or_default();
        properties.set("OCGs", groups);
        if !properties.has(b"D") {
            properties.set("D", Dictionary::new());
        }
        catalog.set("OCProperties", properties);
    }
    if &catalog != source.catalog()? {
        subset.updates.push((
            source.trailer.get(b"Root")?.as_reference()?,
            Object::Dictionary(catalog),
        ));
    }
    Ok(subset.updates)
}
