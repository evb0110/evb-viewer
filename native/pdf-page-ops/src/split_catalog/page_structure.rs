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
        // A direct MCID is a value, not a node: it cannot cycle or grow the walk.
        if let Object::Integer(mcid) = object {
            return (*mcid >= 0 && page.is_some()).then(|| object.clone());
        }
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
fn dictionary_of(object: &Object) -> Option<&Dictionary> {
    match object {
        Object::Dictionary(dictionary) => Some(dictionary),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

/// Whether the structure element names the annotation through an OBJR kid.
fn element_marks_annotation(source: &Document, element: ObjectId, annotation: ObjectId) -> bool {
    let Ok((_, kids)) = source
        .get_dictionary(element)
        .and_then(|element| element.get(b"K"))
        .and_then(|kids| source.dereference(kids))
    else {
        return false;
    };
    let kids = match kids {
        Object::Array(items) => items.as_slice(),
        other => std::slice::from_ref(other),
    };
    kids.iter().any(|kid| {
        source
            .dereference(kid)
            .ok()
            .and_then(|(_, kid)| kid.as_dict().ok())
            .and_then(|kid| kid.get(b"Obj").and_then(Object::as_reference).ok())
            == Some(annotation)
    })
}

pub(crate) fn page_structure_updates(source: &Document) -> Result<Vec<(ObjectId, Object)>> {
    let mut catalog = source.catalog()?.clone();
    if !catalog.has(b"StructTreeRoot")
        && !catalog.has(b"OCProperties")
        && !source.objects.values().any(|object| {
            dictionary_of(object).is_some_and(|dictionary| {
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
    // Form XObjects carry their own ParentTree keys for the content they mark.
    keys.extend(source.objects.values().filter_map(|object| {
        match object {
            Object::Stream(stream) => stream
                .dict
                .get(b"StructParents")
                .and_then(Object::as_i64)
                .ok(),
            _ => None,
        }
    }));
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
    // A tree larger than any of its walks may visit is dropped whole, never
    // saved in part.
    let mut complete = kids.is_some() && !subset.state.exhausted();
    if let (Some(tree), Some(kids), true) = (tree.as_mut(), kids, complete) {
        tree.set("K", kids);
        let mut nums = BTreeMap::new();
        subset.state = CatalogWalkState::new();
        if let Ok(parent_tree) = tree.get(b"ParentTree") {
            subset.parent_tree(parent_tree, 0, &keys, &mut nums);
        }
        complete &= !subset.state.exhausted();
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
                    .is_some_and(|element| {
                        subset.retained.contains(&element)
                            && element_marks_annotation(source, element, *id)
                    });
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
            complete &= !subset.state.exhausted();
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
        if complete {
            if let Ok(id) = root.as_reference() {
                subset.updates.push((id, Object::Dictionary(tree.clone())));
            } else {
                catalog.set("StructTreeRoot", tree.clone());
            }
        }
    }
    if !complete {
        catalog.remove(b"StructTreeRoot");
        catalog.remove(b"MarkInfo");
        for (ids, key) in [
            (&subset.pages, b"StructParents".as_slice()),
            (&subset.annotations, b"StructParent".as_slice()),
        ] {
            for id in ids {
                let mut dictionary = source.get_dictionary(*id)?.clone();
                if dictionary.remove(key).is_some() {
                    subset.updates.push((*id, Object::Dictionary(dictionary)));
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    /// One page whose tag tree has `elements` paragraph elements.
    fn tagged_page(elements: usize) -> (Document, ObjectId, ObjectId) {
        let mut document = Document::with_version("1.7");
        let pages = document.new_object_id();
        let page = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "StructParents" => 0,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
        });
        document.objects.insert(
            pages,
            Object::Dictionary(
                dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1},
            ),
        );
        let kids = (0..elements)
            .map(|mcid| {
                Object::Reference(document.add_object(dictionary! {
                    "S" => "P", "Pg" => page, "K" => mcid as i64,
                }))
            })
            .collect::<Vec<_>>();
        let marks = kids.clone();
        let root = document.add_object(dictionary! {
            "Type" => "StructTreeRoot", "K" => kids,
            "ParentTree" => dictionary! {"Nums" => vec![0.into(), Object::Array(marks)]},
        });
        let catalog = document.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages, "StructTreeRoot" => root,
        });
        document.trailer.set("Root", catalog);
        (document, page, catalog)
    }

    fn updated_catalog(document: &Document, catalog: ObjectId) -> Dictionary {
        page_structure_updates(document)
            .unwrap()
            .into_iter()
            .find(|(id, _)| *id == catalog)
            .map(|(_, object)| object.as_dict().unwrap().clone())
            .unwrap_or_else(|| document.get_dictionary(catalog).unwrap().clone())
    }

    #[test]
    fn a_tree_beyond_the_walk_limit_is_dropped_whole_not_saved_in_part() {
        let (document, _, catalog) = tagged_page(500);
        assert!(updated_catalog(&document, catalog).has(b"StructTreeRoot"));
        let (document, _, catalog) = tagged_page(crate::catalog::CATALOG_WALK_NODE_LIMIT + 1);
        assert!(!updated_catalog(&document, catalog).has(b"StructTreeRoot"));
    }

    #[test]
    fn form_xobject_parent_tree_keys_survive_reconciliation() {
        let (mut document, _, catalog) = tagged_page(1);
        let element = document
            .get_dictionary(catalog)
            .unwrap()
            .get(b"StructTreeRoot")
            .unwrap()
            .as_reference()
            .unwrap();
        let first = document
            .get_dictionary(element)
            .unwrap()
            .get(b"K")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .clone();
        document.add_object(Stream::new(
            dictionary! {"Type" => "XObject", "Subtype" => "Form", "StructParents" => 7},
            Vec::new(),
        ));
        let root = document.get_dictionary_mut(element).unwrap();
        root.set(
            "ParentTree",
            dictionary! {"Nums" => vec![0.into(), Object::Array(vec![first.clone()]), 7.into(), Object::Array(vec![first])]},
        );
        let updates = page_structure_updates(&document).unwrap();
        let tree = updates
            .iter()
            .find(|(id, _)| *id == element)
            .unwrap()
            .1
            .as_dict()
            .unwrap();
        let nums = tree
            .get(b"ParentTree")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Nums")
            .unwrap()
            .as_array()
            .unwrap();
        assert!(
            nums.iter().any(|key| key.as_i64().ok() == Some(7)),
            "{nums:?}"
        );
    }

    #[test]
    fn an_annotation_keeps_struct_parent_only_when_its_element_marks_it() {
        let (mut document, page, catalog) = tagged_page(1);
        let annotation = document
            .add_object(dictionary! {"Type" => "Annot", "Subtype" => "Link", "StructParent" => 1});
        let other = document.add_object(dictionary! {"Type" => "Annot", "Subtype" => "Link"});
        let element = document.add_object(dictionary! {
            "S" => "Link", "Pg" => page,
            "K" => dictionary! {"Type" => "OBJR", "Obj" => other, "Pg" => page},
        });
        document
            .get_dictionary_mut(page)
            .unwrap()
            .set("Annots", vec![annotation.into(), other.into()]);
        let root = document
            .get_dictionary(catalog)
            .unwrap()
            .get(b"StructTreeRoot")
            .unwrap()
            .as_reference()
            .unwrap();
        let tree = document.get_dictionary_mut(root).unwrap();
        tree.get_mut(b"K")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .push(element.into());
        let nums = tree
            .get_mut(b"ParentTree")
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .get_mut(b"Nums")
            .unwrap()
            .as_array_mut()
            .unwrap();
        nums.extend([1.into(), element.into()]);
        let updates = page_structure_updates(&document).unwrap();
        let updated = updates
            .iter()
            .find(|(id, _)| *id == annotation)
            .map(|(_, object)| object.as_dict().unwrap());
        assert!(updated.is_some_and(|annotation| !annotation.has(b"StructParent")));
    }
}
