//! Bounded dependency completion for page-local annotation edits.
use super::*;

#[path = "page_local_mutations.rs"]
mod mutations;
pub(crate) use mutations::*;
#[path = "page_local_deletes.rs"]
mod deletes;
pub(crate) use deletes::*;

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
        let missing = page_local_dependencies(
            document,
            &pages,
            &annotation_pages,
            &edit.annotations,
            &edit.closure,
        )?
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
    if let Some(path) = &edit.outline {
        load_outline_path(document, path, |document, id| {
            if requested.insert(id) {
                if requested.len() > MAX_QPDF_OBJECT_ELEMENTS {
                    return Err(domain_error(
                        NativeErrorCode::TooLarge,
                        "Page-local PDF objects exceed their object ceiling",
                    ));
                }
                fetch(document, &BTreeSet::from([id]), &mut retained)?;
            }
            Ok(())
        })?;
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
    closure: &BTreeSet<ObjectId>,
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
        .chain(closure)
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
            ..PageLocalEdit::default()
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
    fn a_later_outline_chunk_reads_its_path_alone_and_rejects_a_cycle() {
        let mut whole = Document::with_version("1.7");
        whole.trailer.set("Root", (1, 0));
        whole.set_object(
            (1, 0),
            dictionary! {"Type"=>"Catalog","Pages"=>(2,0),"Outlines"=>(10,0)},
        );
        whole.set_object(
            (2, 0),
            dictionary! {"Type"=>"Pages","Count"=>1,"Kids"=>vec![Object::Reference((3,0))]},
        );
        whole.set_object((3, 0), dictionary! {"Type"=>"Page","Parent"=>(2,0)});
        whole.set_object(
            (10, 0),
            dictionary! {"First"=>(11,0),"Last"=>(13,0),"Count"=>3},
        );
        whole.set_object(
            (11, 0),
            dictionary! {"Title"=>"One","Next"=>(12,0),"SE"=>(20,0)},
        );
        whole.set_object(
            (12, 0),
            dictionary! {"Title"=>"Two","Next"=>(13,0),"First"=>(14,0),"Last"=>(15,0)},
        );
        whole.set_object((13, 0), dictionary! {"Title"=>"Three"});
        whole.set_object((14, 0), dictionary! {"Title"=>"Child","Next"=>(15,0)});
        whole.set_object((15, 0), dictionary! {"Title"=>"Last child"});
        whole.set_object((20, 0), dictionary! {"Type"=>"StructElem"});
        let located = LocatedPages {
            count: 1,
            ids: BTreeMap::from([(0, (3, 0))]),
        };
        let load = |whole: &Document, path: Vec<u32>| {
            let mut partial = Document::with_version("1.7");
            partial.trailer = whole.trailer.clone();
            let edit = PageLocalEdit {
                outline: Some(path),
                ..PageLocalEdit::default()
            };
            complete_page_local_objects(&mut partial, &located, &edit, |document, ids, _| {
                for id in ids {
                    document.set_object(*id, whole.get_object(*id)?.clone());
                }
                Ok(())
            })
            .map(|()| partial.objects.keys().map(|id| id.0).collect::<Vec<_>>())
        };
        assert_eq!(load(&whole, vec![1]).unwrap(), [1, 10, 11, 12, 15]);
        assert_eq!(load(&whole, vec![]).unwrap(), [1, 10, 13]);
        whole
            .get_object_mut((12, 0))
            .and_then(Object::as_dict_mut)
            .unwrap()
            .set("Next", (11, 0));
        assert!(load(&whole, vec![u32::MAX]).is_err());
    }

    #[test]
    fn scanned_upserts_reject_duplicate_payload_targets() {
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
        document.set_object(
            (5, 0),
            dictionary! {"Subtype"=>"FreeText","NM"=>Object::string_literal("evb-freetext:old-box")},
        );
        document
            .get_object_mut((3, 0))
            .and_then(Object::as_dict_mut)
            .unwrap()
            .set(
                "Annots",
                vec![Object::Reference((4, 0)), Object::Reference((5, 0))],
            );
        let base = IncrementalDocument::from_document(document, 0, None);
        let shape = json!({"type":"rectangle","pageIndex":0,"x":0.1,"y":0.2,"width":0.3,"height":0.1,"color":"#123456","opacity":1,"strokeWidth":2,"stableKey":"taken"});
        let payload = |items| {
            serde_json::from_value(json!({"shapes":{"totalPages":1,"shapes":items}})).unwrap()
        };
        assert!(!additive_targets_are_new(&base, &payload(vec![shape.clone()]), false).unwrap());
        let mut fresh = shape;
        fresh["stableKey"] = json!("fresh");
        assert!(additive_targets_are_new(&base, &payload(vec![fresh.clone()]), false).unwrap());
        assert!(
            !additive_targets_are_new(&base, &payload(vec![fresh.clone(), fresh]), false).unwrap()
        );
        // The text-box writer finds `evb-freetext:old-box` by the bare name.
        let text_box = |key: &str| {
            serde_json::from_value(json!({"textBoxes":[{"pageIndex":0,"stableKey":key,"text":"t","rect":[10,20,80,60],"rotation":0,"fontSize":12,"color":[0,0,0]}]})).unwrap()
        };
        assert!(!additive_targets_are_new(&base, &text_box("old-box"), false).unwrap());
        assert!(additive_targets_are_new(&base, &text_box("new-box"), false).unwrap());
        // After the ownership scan resolved existing targets, an existing key
        // is an upsert, while a payload naming one target twice stays rejected.
        let taken = json!({"type":"rectangle","pageIndex":0,"x":0.1,"y":0.2,"width":0.3,"height":0.1,"color":"#123456","opacity":1,"strokeWidth":2,"stableKey":"taken"});
        assert!(additive_targets_are_new(&base, &payload(vec![taken.clone()]), true).unwrap());
        assert!(
            !additive_targets_are_new(&base, &payload(vec![taken.clone(), taken]), true).unwrap()
        );
    }
}
