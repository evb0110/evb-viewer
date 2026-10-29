//! Annotation ownership and the shared deletion writer.
use super::*;

/// The annotations the pages list, as the parse and Undo admit them: the pages
/// listing each, and the listed annotations that answer each one. It reads
/// page dictionaries among the objects, never walking the page tree.
#[derive(Default)]
pub(crate) struct AnnotationListing {
    pub(crate) pages: HashMap<ObjectId, Vec<ObjectId>>,
    pub(crate) replies: HashMap<ObjectId, Vec<ObjectId>>,
}

impl AnnotationListing {
    pub(crate) fn new(document: &Document) -> Self {
        Self::new_for_pages(document, None)
    }

    pub(crate) fn new_for_pages(document: &Document, located: Option<&LocatedPages>) -> Self {
        let owners = located.map(|pages| pages.ids.values().copied().collect::<HashSet<_>>());
        let mut listing = Self::default();
        for (page, object) in &document.objects {
            if owners.as_ref().is_some_and(|owners| !owners.contains(page)) {
                continue;
            }
            let Ok(dict) = object.as_dict() else {
                continue;
            };
            // One pass over a dictionary's few entries: hashing two keys of
            // every object costs a dense file several times more.
            let (mut page_type, mut annots) = (None, None);
            for (key, value) in dict.iter() {
                match key.as_slice() {
                    b"Type" => page_type = value.as_name().ok(),
                    b"Annots" => annots = document.dereference(value).ok(),
                    _ => {}
                }
            }
            let annots = annots.filter(|_| page_type == Some(b"Page"));
            let annots = annots.and_then(|(_, annots)| annots.as_array().ok());
            for id in annots
                .into_iter()
                .flatten()
                .filter_map(|a| a.as_reference().ok())
            {
                listing.pages.entry(id).or_default().push(*page);
            }
        }
        for id in listing.pages.keys() {
            let dict = document.get_dictionary(*id).ok();
            if let Some(parent) = dict.and_then(|dict| annotation_related_ref(dict, b"IRT")) {
                listing.replies.entry(parent).or_default().push(*id);
            }
        }
        listing
    }

    /// Every page whose /Annots lists one of `refs`.
    pub(crate) fn pages_of(&self, refs: &HashSet<ObjectId>) -> HashSet<ObjectId> {
        refs.iter()
            .filter_map(|id| self.pages.get(id))
            .flatten()
            .copied()
            .collect()
    }
}

pub(crate) fn collect_annotation_refs_to_delete(
    document: &impl PdfObjectSource,
    target_id: ObjectId,
    replies_by_parent: &HashMap<ObjectId, Vec<ObjectId>>,
) -> Result<Vec<ObjectId>> {
    if document.dictionary(target_id).is_err() {
        return Err(format!(
            "Annotation delete target {}R{} was not found",
            target_id.0, target_id.1
        )
        .into());
    }

    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    let mut pending = vec![target_id];
    while let Some(object_id) = pending.pop() {
        if !seen.insert(object_id) {
            continue;
        }
        refs.push(object_id);

        let dict = match document.dictionary(object_id) {
            Ok(dict) => dict,
            Err(_) => continue,
        };
        // AP and image streams are reusable resources. Another annotation
        // can share either object, and saved-deletion undo retains the image
        // identity. Delete only annotation ownership, not those resources.
        if let Some(popup_id) = annotation_related_ref(dict, b"Popup") {
            pending.push(popup_id);
        }
        if let Some(parent_id) = annotation_related_ref(dict, b"Parent") {
            if let Ok(parent_dict) = document.dictionary(parent_id) {
                let parent_subtype = annotation_subtype(parent_dict);
                if parent_subtype == "text"
                    || parent_subtype == "freetext"
                    || parent_subtype == "popup"
                {
                    pending.push(parent_id);
                }
            }
        }
        if let Some(reply_ids) = replies_by_parent.get(&object_id) {
            pending.extend(reply_ids.iter().copied());
        }
    }

    Ok(refs)
}

/// The page an annotation's optional `/P` names, when the file holds it.
pub(crate) fn annotation_page_id(
    document: &impl PdfObjectSource,
    annotation_id: ObjectId,
) -> Option<ObjectId> {
    let page = document
        .dictionary(annotation_id)
        .ok()?
        .get(b"P")
        .ok()?
        .as_reference()
        .ok()?;
    document.dictionary(page).is_ok().then_some(page)
}

pub(crate) fn annotation_matches_stable_delete_name(
    document: &impl PdfObjectSource,
    object_id: ObjectId,
    delete: &AnnotationDelete,
) -> Result<bool> {
    Ok(StableDeleteName::new(delete).is_some_and(|requested| {
        stable_delete_note_name(document, object_id).is_some_and(|name| requested.matches(&name))
    }))
}

/// The name a stable-key delete asks for, prepared once for many annotations.
struct StableDeleteName {
    requested: String,
    created_at: Option<u64>,
}

impl StableDeleteName {
    fn new(delete: &AnnotationDelete) -> Option<Self> {
        let stable_key = delete
            .stable_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())?;
        Some(Self {
            requested: replayable_free_text_note_name_from_parts(stable_key, delete.created_at),
            created_at: delete.created_at,
        })
    }

    fn matches(&self, note_name: &str) -> bool {
        text_note_delete_name_matches(note_name, &self.requested, self.created_at)
            || annotation_names_match(note_name, &self.requested, &["evb-freetext:"])
    }
}

/// The name of the text or FreeText note an annotation is, or whose popup it is.
fn stable_delete_note_name(document: &impl PdfObjectSource, object_id: ObjectId) -> Option<String> {
    let dict = document.dictionary(object_id).ok()?;
    let target_dict = if annotation_subtype(dict) == "popup" {
        document
            .dictionary(annotation_related_ref(dict, b"Parent")?)
            .ok()?
    } else {
        dict
    };
    let target_subtype = annotation_subtype(target_dict);
    if target_subtype != "text" && target_subtype != "freetext" {
        return None;
    }
    read_annotation_name(target_dict)
}

fn resolve_annotation_delete_target_refs_from_index(
    index: &PageAnnotationIndex,
    delete: &AnnotationDelete,
) -> Result<Vec<ObjectId>> {
    let matching_refs = index.matching_stable_delete_refs(delete);

    match matching_refs.len() {
        1 => Ok(matching_refs),
        0 => Err("No annotation matched requested stable-key delete target".into()),
        _ => Err("Stable-key delete target matched multiple annotations".into()),
    }
}

pub(crate) fn collect_delete_refs(
    document: &Document,
    deletes: &[AnnotationDelete],
    replies: &HashMap<ObjectId, Vec<ObjectId>>,
    located: Option<&LocatedPages>,
) -> Result<HashSet<ObjectId>> {
    let page_resolver = PageLookup::new(document, located)?;
    let mut refs_to_delete = HashSet::new();
    let mut annotation_indexes = HashMap::new();
    for delete in deletes {
        let page_number = mutation_page_number(delete.page_index)?;
        let page_id = page_resolver.page_id(document, page_number)?;
        if let Entry::Vacant(entry) = annotation_indexes.entry(page_id) {
            entry.insert(build_page_annotation_index(document, page_id)?.0);
        }
        let index = annotation_indexes
            .get(&page_id)
            .expect("Annotation-delete pages are indexed before lookup");
        let target_refs = annotation_delete_targets(index, delete)?;
        for target_id in target_refs {
            refs_to_delete.extend(collect_annotation_refs_to_delete(
                document, target_id, replies,
            )?);
        }
    }
    Ok(refs_to_delete)
}

pub(crate) fn filter_annots_without_refs(
    annots: Vec<Object>,
    refs_to_delete: &HashSet<ObjectId>,
) -> (Vec<Object>, bool) {
    let mut removed = false;
    let filtered = annots
        .into_iter()
        .filter(|object| {
            let should_remove = object
                .as_reference()
                .ok()
                .is_some_and(|object_id| refs_to_delete.contains(&object_id));
            if should_remove {
                removed = true;
            }
            !should_remove
        })
        .collect();
    (filtered, removed)
}

pub(crate) fn delete_annotations(
    document: &mut Document,
    deletes: &[AnnotationDelete],
) -> Result<()> {
    if deletes.is_empty() {
        return Ok(());
    }

    let listing = AnnotationListing::new(document);
    let refs_to_delete = collect_delete_refs(document, deletes, &listing.replies, None)?;
    let mut removed_any = false;
    for page_id in listing.pages_of(&refs_to_delete) {
        let annots = get_page_annots(document, page_id)?;
        let (filtered_annots, removed) = filter_annots_without_refs(annots, &refs_to_delete);
        if !removed {
            continue;
        }
        let page = document.get_dictionary_mut(page_id)?;
        page.set("Annots", Object::Array(filtered_annots));
        removed_any = true;
    }

    if !removed_any {
        return Err("No requested annotation delete target was referenced from page Annots".into());
    }
    for object_id in refs_to_delete {
        document.objects.remove(&object_id);
    }
    Ok(())
}

pub(crate) fn delete_annotations_incremental(
    incremental: &mut IncrementalDocument,
    deletes: &[AnnotationDelete],
) -> Result<()> {
    if deletes.is_empty() {
        return Ok(());
    }

    let listing = AnnotationListing::new_for_pages(
        incremental.get_prev_documents(),
        incremental.located_pages.as_ref(),
    );
    let refs_to_delete = collect_delete_refs(
        incremental.get_prev_documents(),
        deletes,
        &listing.replies,
        incremental.located_pages.as_ref(),
    )?;
    let mut removed_any = false;
    for page_id in listing.pages_of(&refs_to_delete) {
        let annots = get_incremental_page_annots(incremental, page_id)?;
        let (filtered_annots, removed) = filter_annots_without_refs(annots, &refs_to_delete);
        if !removed {
            continue;
        }
        incremental.opt_clone_object_to_new_document(page_id)?;
        let page = incremental.new_document.get_dictionary_mut(page_id)?;
        page.set("Annots", Object::Array(filtered_annots));
        removed_any = true;
    }

    if !removed_any {
        return Err("No requested annotation delete target was referenced from page Annots".into());
    }
    for object_id in refs_to_delete {
        incremental.new_document.set_object(object_id, Object::Null);
    }
    Ok(())
}

pub(crate) fn annotation_delete_targets(
    index: &PageAnnotationIndex,
    delete: &AnnotationDelete,
) -> Result<Vec<ObjectId>> {
    if let (Some(number), Some(generation)) = (delete.object_number, delete.generation_number) {
        Ok(vec![(number, generation)])
    } else {
        resolve_annotation_delete_target_refs_from_index(index, delete)
    }
}
pub(crate) fn validate_annotation_delete_document_postconditions(
    document: &impl PdfObjectSource,
    deletes: &[AnnotationDelete],
) -> Result<()> {
    if deletes.is_empty() {
        return Ok(());
    }

    let pages = PageLookup::new(document, document.located_pages())?;
    let mut refs_to_delete = HashSet::new();
    let mut touched_page_ids = HashSet::new();
    for delete in deletes {
        let page_number = delete
            .page_index
            .checked_add(1)
            .ok_or("Invalid annotation delete page index")?;
        let page_id = pages.page_id(document, page_number)?;
        touched_page_ids.insert(page_id);
        if let (Some(object_number), Some(generation_number)) =
            (delete.object_number, delete.generation_number)
        {
            refs_to_delete.insert((object_number, generation_number));
        }
    }
    for object_id in &refs_to_delete {
        if let Some(page_id) = annotation_page_id(document, *object_id) {
            touched_page_ids.insert(page_id);
        }
    }

    // Each survivor's note name is read once and each delete's requested
    // name prepared once; resolving both for every pair made a 256-delete
    // batch over 10,000 surviving annotations take 0.7-1.5 s.
    let stable_names = deletes
        .iter()
        .filter_map(StableDeleteName::new)
        .collect::<Vec<_>>();
    let mut validate_page = |page_id| {
        for object in get_page_annots(document, page_id)? {
            if let Ok(object_id) = object.as_reference() {
                if refs_to_delete.contains(&object_id) {
                    return Err("Deleted annotation is still referenced from page Annots".into());
                }
                let matches_stable_delete = !stable_names.is_empty()
                    && stable_delete_note_name(document, object_id).is_some_and(|name| {
                        stable_names.iter().any(|delete| delete.matches(&name))
                    });
                if matches_stable_delete {
                    return Err(
                        "Stable-key deleted annotation is still referenced from page Annots".into(),
                    );
                }
            }
        }
        Ok(())
    };

    if let Some(located) = document.located_pages() {
        for page_id in located.ids.values() {
            validate_page(*page_id)?;
        }
    } else if crate::postconditions::FULL_POSTCONDITION_AUDIT {
        PageTreeResolver::new(document)?.for_each_page_id(document, &mut validate_page)?;
    } else {
        for page_id in touched_page_ids {
            validate_page(page_id)?;
        }
    }
    Ok(())
}
