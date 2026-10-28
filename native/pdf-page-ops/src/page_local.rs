//! Bounded dependency completion for page-local annotation edits.
use super::*;

/// Fetches, in rounds, every object `page_local_dependencies` names until
/// the loaded part of `document` names nothing new. qpdf leaves out an object
/// that does not exist, so each object is requested at most once.
pub(crate) fn complete_page_local_objects(
    document: &mut Document,
    located: &LocatedPages,
    edit: &PageLocalEdit,
    mut fetch: impl FnMut(&mut Document, &BTreeSet<ObjectId>, &mut usize) -> Result<()>,
) -> Result<()> {
    let pages = located.select(&edit.pages)?;
    let annotation_pages = located.select(&edit.annotation_pages)?;
    let mut requested = document.objects.keys().copied().collect::<BTreeSet<_>>();
    // One ceiling covers every round: `fetch` charges each object it adds.
    let mut retained = retained_cost(&Object::Dictionary(document.trailer.clone()))?;
    for object in document.objects.values() {
        retained = charge_retained(retained, object)?;
    }
    loop {
        let missing =
            page_local_dependencies(document, &pages, &annotation_pages, &edit.annotations)?
                .difference(&requested)
                .copied()
                .collect::<BTreeSet<_>>();
        if missing.is_empty() {
            break;
        }
        if requested.len().saturating_add(missing.len()) > MAX_QPDF_OBJECT_ELEMENTS {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Page-local PDF objects exceed their object ceiling",
            ));
        }
        fetch(document, &missing, &mut retained)?;
        requested.extend(missing);
    }
    for page_id in &pages {
        if document.dictionary(*page_id)?.get(b"Type")?.as_name()? != b"Page" {
            return Err("qpdf page-tree walk returned a non-page object".into());
        }
    }
    Ok(())
}

pub(crate) fn charge_retained(retained: usize, object: &Object) -> Result<usize> {
    retained
        .checked_add(retained_cost(object)?)
        .filter(|retained| *retained <= MAX_QPDF_RETAINED_STRUCTURE_BYTES)
        .ok_or_else(|| {
            domain_error(
                NativeErrorCode::TooLarge,
                "Page-local PDF objects exceed their retained memory ceiling",
            )
        })
}

/// The page an addressed annotation names through its own `/P`, or a popup
/// through its parent's: a page dictionary, or an object not loaded yet.
fn addressed_annotation_page(document: &Document, annotation_id: ObjectId) -> Option<ObjectId> {
    let annotation = document.get_dictionary(annotation_id).ok()?;
    let page = |dictionary: &Dictionary| {
        dictionary
            .get(b"P")
            .and_then(Object::as_reference)
            .ok()
            .filter(|page| {
                document.get_object(*page).map_or(true, |page| {
                    page.as_dict()
                        .and_then(|page| page.get(b"Type"))
                        .and_then(Object::as_name)
                        .is_ok_and(|kind| kind == b"Page")
                })
            })
    };
    page(annotation).or_else(|| {
        let parent = annotation
            .get(b"Parent")
            .and_then(Object::as_reference)
            .ok()?;
        page(document.get_dictionary(parent).ok()?)
    })
}

/// Whether every addressed annotation, or the parent of an addressed popup,
/// is listed on the page its `/P` names, where the edit's writers look, and
/// that page is in the page tree.
pub(super) fn page_local_annotations_located(
    document: &Document,
    edit: &PageLocalEdit,
) -> Result<bool> {
    for annotation_id in &edit.annotations {
        let Some(page_id) = addressed_annotation_page(document, *annotation_id)
            .filter(|page_id| document.objects.contains_key(page_id))
        else {
            return Ok(false);
        };
        if !page_in_tree(document, page_id) {
            return Ok(false);
        }
        let listed = get_page_annots(document, page_id)?;
        let parent = document
            .get_dictionary(*annotation_id)
            .and_then(|annotation| annotation.get(b"Parent"))
            .and_then(Object::as_reference)
            .ok();
        if !listed.iter().any(|object| {
            object
                .as_reference()
                .is_ok_and(|id| id == *annotation_id || Some(id) == parent)
        }) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Whether each `/Parent` up from `page_id` lists the node below it among its
/// `/Kids`, up to the catalog's `/Pages`: the page is in the page tree rather
/// than an orphan that names a parent.
fn page_in_tree(document: &Document, page_id: ObjectId) -> bool {
    let Some(root_pages) = document
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .and_then(|root| document.get_dictionary(root))
        .and_then(|catalog| catalog.get(b"Pages"))
        .and_then(Object::as_reference)
        .ok()
    else {
        return false;
    };
    let mut child = page_id;
    for _ in 0..=MAX_PDF_STRUCTURAL_NESTING {
        if child == root_pages {
            return true;
        }
        let Some(parent) = document
            .get_dictionary(child)
            .and_then(|node| node.get(b"Parent"))
            .and_then(Object::as_reference)
            .ok()
        else {
            return false;
        };
        let lists_child = document
            .get_dictionary(parent)
            .and_then(|node| node.get(b"Kids"))
            .and_then(|kids| match kids {
                Object::Reference(id) => document.get_object(*id),
                kids => Ok(kids),
            })
            .and_then(Object::as_array)
            .is_ok_and(|kids| kids.contains(&Object::Reference(child)));
        if !lists_child {
            return false;
        }
        child = parent;
    }
    false
}

/// The base objects a page-local edit reads, as far as the loaded part of
/// `document` names them: each page and its `/Pages` ancestors with their
/// inheritable boxes and rotation; for `annotation_pages`, and the pages that
/// addressed `annotations` name, the `/Annots` entries with everything they
/// reference, including stream resources. A page-tree node or
/// catalog reached from an annotation is read but not followed, so the walk
/// stays on the edited pages.
fn page_local_dependencies(
    document: &Document,
    pages: &BTreeSet<ObjectId>,
    annotation_pages: &BTreeSet<ObjectId>,
    annotations: &BTreeSet<ObjectId>,
) -> Result<BTreeSet<ObjectId>> {
    let mut needed = BTreeSet::new();
    let mut values = Vec::new();
    let mut addressed_pages = BTreeSet::new();
    let mut annotation_pages = annotation_pages.clone();
    for annotation_id in annotations {
        if let Some(page_id) = addressed_annotation_page(document, *annotation_id) {
            addressed_pages.insert(page_id);
            annotation_pages.insert(page_id);
        }
    }
    // A located page's ancestry must be a page tree. An addressed page is only
    // what an annotation names, so its ancestry is read until it is not one,
    // and `page_in_tree` decides whether the edit can use it.
    for (page_id, located) in pages.iter().map(|page_id| (page_id, true)).chain(
        addressed_pages
            .difference(pages)
            .map(|page_id| (page_id, false)),
    ) {
        let mut node_id = *page_id;
        for depth in 0..=MAX_PDF_STRUCTURAL_NESTING + 1 {
            if depth > MAX_PDF_STRUCTURAL_NESTING {
                if !located {
                    break;
                }
                return Err("PDF page-tree ancestry exceeds its structural depth limit".into());
            }
            needed.insert(node_id);
            let Ok(node) = document.get_dictionary(node_id) else {
                break;
            };
            if depth > 0 {
                if node.get(b"Type").and_then(Object::as_name).ok() != Some(b"Pages".as_slice()) {
                    if !located {
                        break;
                    }
                    return Err("PDF page /Parent does not reference a /Pages node".into());
                }
                // Read, not followed: `page_in_tree` checks a parent lists its child.
                if let Ok(Object::Reference(kids)) = node.get(b"Kids") {
                    needed.insert(*kids);
                }
            }
            for key in [b"MediaBox".as_slice(), b"CropBox", b"Rotate"] {
                values.extend(node.get(key).ok());
            }
            if depth == 0 && annotation_pages.contains(page_id) {
                values.extend(node.get(b"Annots").ok());
            }
            let Ok(parent) = node.get(b"Parent") else {
                break;
            };
            let Ok(parent) = parent.as_reference() else {
                if !located {
                    break;
                }
                return Err("PDF page /Parent must be an indirect reference".into());
            };
            node_id = parent;
        }
    }
    let addressed = annotations
        .iter()
        .map(|id| Object::Reference(*id))
        .collect::<Vec<_>>();
    values.extend(&addressed);
    // Read but not followed: the writer sets the catalog's /Version when an
    // append moves a classic cross-reference table past ten-digit offsets.
    if let Ok(root) = document.trailer.get(b"Root").and_then(Object::as_reference) {
        needed.insert(root);
    }
    while let Some(value) = values.pop() {
        match value {
            Object::Reference(id) => {
                if !needed.insert(*id) {
                    continue;
                }
                let Ok(object) = document.get_object(*id) else {
                    continue;
                };
                let page_tree_or_catalog = object.as_dict().is_ok_and(|dictionary| {
                    dictionary
                        .get(b"Type")
                        .and_then(Object::as_name)
                        .is_ok_and(|kind| matches!(kind, b"Page" | b"Pages" | b"Catalog"))
                });
                if !page_tree_or_catalog {
                    values.push(object);
                }
            }
            Object::Array(items) => values.extend(items),
            Object::Dictionary(dictionary) => {
                values.extend(dictionary.iter().map(|(_, value)| value))
            }
            Object::Stream(stream) => values.extend(stream.dict.iter().map(|(_, value)| value)),
            _ => {}
        }
    }
    Ok(needed)
}

/// Payload admission cannot distinguish a create from a name-based upsert.
/// Check the same local targets the writers use before allowing a partial base.
/// A duplicate name elsewhere cannot be rewritten by these local writers.
pub(crate) fn additive_targets_are_new(
    incremental: &IncrementalDocument,
    mutations: &NativeMutationsFile,
) -> Result<bool> {
    let source = AppendedRevision::new(incremental);
    let pages = PageLookup::new(&source, source.located_pages())?;
    let mut targets = HashSet::<String>::new();
    let mut names_on = |page_index: u32, name: String, prefixes: &[&str]| -> Result<bool> {
        if targets
            .iter()
            .any(|existing| annotation_names_match(existing, &name, prefixes))
        {
            return Ok(false);
        }
        targets.insert(name.clone());
        let page_id = pages.page_id(
            &source,
            page_index
                .checked_add(1)
                .ok_or("Invalid annotation page index")?,
        )?;
        // Like the writers, skip an entry that is not an annotation dictionary.
        for object in get_page_annots(&source, page_id)? {
            let Some(dict) = source
                .resolved(&object)
                .ok()
                .and_then(|object| object.as_dict().ok())
            else {
                continue;
            };
            if [read_annotation_name(dict), read_shape_stable_key(dict)]
                .into_iter()
                .flatten()
                .any(|existing| annotation_names_match(&existing, &name, prefixes))
            {
                return Ok(false);
            }
        }
        Ok(true)
    };
    for editor in &mutations.text_boxes {
        if !names_on(editor.page_index, text_box_name(editor), &[])? {
            return Ok(false);
        }
    }
    if let Some(shapes) = &mutations.shapes {
        for shape in &shapes.shapes {
            let Some(key) = normalize_managed_shape_stable_key(shape.stable_key.as_deref()) else {
                return Ok(false);
            };
            if !names_on(shape.page_index, key, &["evb-shape:"])? {
                return Ok(false);
            }
        }
    }
    if let Some(markup) = &mutations.markup {
        for hint in &markup.hints {
            let Some(name) = markup_annotation_name(hint) else {
                return Ok(false);
            };
            if !names_on(hint.page_index, name, &["evb-markup:"])? {
                return Ok(false);
            }
            // editor-live hints can also match existing markup by geometry.
            if can_use_geometry_only_subtype_hint(hint) {
                let page = pages.page_id(&source, hint.page_index + 1)?;
                let view = resolve_page_view(&source, page)?;
                let rotation = resolve_page_rotation(&source, page)?;
                for object in get_page_annots(&source, page)? {
                    if object
                        .as_reference()
                        .ok()
                        .and_then(|id| {
                            create_markup_candidate(
                                incremental.get_prev_documents(),
                                view,
                                rotation,
                                id,
                                0,
                            )
                        })
                        .is_some_and(|candidate| {
                            marker_rect_iou(candidate.marker_rect, Some(hint.marker_rect))
                                >= MIN_MARKUP_SUBTYPE_HINT_IOU
                        })
                    {
                        return Ok(false);
                    }
                }
            }
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn completes_form_resources_fonts_and_xobjects_without_walking_other_pages() {
        let mut whole = Document::with_version("1.7");
        whole.trailer.set("Root", (1, 0));
        for (id, object) in [
            (
                1,
                Object::Dictionary(dictionary! {"Type"=>"Catalog","Pages"=>(2,0)}),
            ),
            (
                2,
                Object::Dictionary(
                    dictionary! {"Type"=>"Pages","Count"=>2,"Kids"=>vec![Object::Reference((3,0)),Object::Reference((4,0))]},
                ),
            ),
            (
                3,
                Object::Dictionary(
                    dictionary! {"Type"=>"Page","Parent"=>(2,0),"Annots"=>vec![Object::Reference((5,0))]},
                ),
            ),
            (
                4,
                Object::Dictionary(
                    dictionary! {"Type"=>"Page","Parent"=>(2,0),"Contents"=>(99,0),"Annots"=>vec![Object::Reference((98,0))]},
                ),
            ),
            (
                5,
                Object::Dictionary(
                    dictionary! {"Subtype"=>"FreeText","P"=>(3,0),"AP"=>dictionary!{"N"=>(6,0)}},
                ),
            ),
            (
                6,
                Object::Stream(Stream::with_position(
                    dictionary! {"Subtype"=>"Form","Resources"=>(7,0),"Length"=>0},
                    0,
                )),
            ),
            (
                7,
                Object::Dictionary(
                    dictionary! {"Font"=>dictionary!{"F1"=>(8,0)},"XObject"=>dictionary!{"X1"=>(11,0)}},
                ),
            ),
            (8, Object::Dictionary(dictionary! {"FontDescriptor"=>(9,0)})),
            (9, Object::Dictionary(dictionary! {"FontFile2"=>(10,0)})),
            (
                10,
                Object::Stream(Stream::with_position(dictionary! {"Length"=>0}, 0)),
            ),
            (
                11,
                Object::Stream(Stream::with_position(
                    dictionary! {"Subtype"=>"Form","Resources"=>dictionary!{"OtherPage"=>(4,0)},"Length"=>0},
                    0,
                )),
            ),
        ] {
            whole.set_object((id, 0), object);
        }
        let mut partial = Document::with_version("1.7");
        partial.trailer = whole.trailer.clone();
        let located = LocatedPages {
            count: 2,
            ids: BTreeMap::from([(0, (3, 0))]),
        };
        let edit = PageLocalEdit {
            pages: BTreeSet::from([0]),
            annotation_pages: BTreeSet::from([0]),
            annotations: BTreeSet::new(),
        };
        complete_page_local_objects(&mut partial, &located, &edit, |document, ids, retained| {
            for id in ids {
                let object = whole.get_object(*id)?.clone();
                *retained = charge_retained(*retained, &object)?;
                document.set_object(*id, object);
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(
            partial.objects.keys().copied().collect::<BTreeSet<_>>(),
            whole.objects.keys().copied().collect()
        );
        assert!(!partial.objects.contains_key(&(99, 0)));
        assert!(!partial.objects.contains_key(&(98, 0)));
    }

    #[test]
    fn name_based_upserts_and_duplicate_create_targets_require_whole_loading() {
        let mut document = Document::with_version("1.7");
        document.trailer.set("Root", (1, 0));
        document.set_object((1, 0), dictionary! {"Type"=>"Catalog","Pages"=>(2,0)});
        document.set_object(
            (2, 0),
            dictionary! {"Type"=>"Pages","Count"=>1,"Kids"=>vec![Object::Reference((3,0))]},
        );
        document.set_object(
            (3, 0),
            dictionary! {"Type"=>"Page","Parent"=>(2,0),"Annots"=>vec![Object::Reference((4,0))]},
        );
        document.set_object((4,0),dictionary!{"Subtype"=>"Square","NM"=>Object::string_literal("other-name"),"EVBShapeKey"=>Object::string_literal("taken")});
        let incremental = IncrementalDocument::from_document(document, 0, None);
        let shape = json!({"type":"rectangle","pageIndex":0,"x":0.1,"y":0.2,"width":0.3,"height":0.1,"color":"#123456","opacity":1,"strokeWidth":2,"stableKey":"taken"});
        let payload = |items| {
            serde_json::from_value(json!({"shapes":{"totalPages":1,"shapes":items}})).unwrap()
        };
        assert!(!additive_targets_are_new(&incremental, &payload(vec![shape.clone()])).unwrap());
        let mut fresh = shape;
        fresh["stableKey"] = json!("fresh");
        assert!(additive_targets_are_new(&incremental, &payload(vec![fresh.clone()])).unwrap());
        assert!(
            !additive_targets_are_new(&incremental, &payload(vec![fresh.clone(), fresh])).unwrap()
        );
    }
}
