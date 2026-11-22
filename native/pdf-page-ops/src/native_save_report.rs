//! Bounded identity, affected-page and confirmed deletion effects after saves.
use super::*;
const MAX_ANNOTATION_IDENTITY_BINDINGS: usize = 4_096;
const MAX_ANNOTATION_IDENTITY_REPORT_BYTES: usize = 256 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationDeleteEffects {
    affected_page_indices: Vec<u32>,
    deleted_reply_refs: Vec<String>,
}

/// What a save changed for a parse of the saved file to re-read, or None, as
/// for a page it cannot read, when only a parse of every page is complete.
pub(crate) fn annotation_delete_effects(
    base: &IncrementalDocument,
) -> Result<Option<AnnotationDeleteEffects>> {
    let Ok(located) = &changed_annotation_pages(base) else {
        return Ok(None);
    };
    let mut remaining = HashSet::new();
    for page in located.ids.values() {
        let Ok(annotations) = get_page_annots(base, *page) else {
            return Ok(None);
        };
        remaining.extend(
            annotations
                .iter()
                .filter_map(|object| object.as_reference().ok()),
        );
    }
    let mut replies = AnnotationListing::new_for_pages(base.get_prev_documents(), Some(located))
        .replies
        .into_values()
        .flatten()
        .filter(|id| !remaining.contains(id))
        .collect::<Vec<_>>();
    replies.sort_unstable();
    replies.dedup();
    // Empty or oversized read-back scopes retain the existing whole-parse
    // fallback (the host contract requires at least one affected page index).
    if located.ids.is_empty()
        || located.ids.len() > MAX_ANNOTATION_IDENTITY_BINDINGS
        || replies.len() > MAX_ANNOTATION_IDENTITY_BINDINGS
    {
        return Ok(None);
    }
    Ok(Some(AnnotationDeleteEffects {
        affected_page_indices: located.ids.keys().copied().collect(),
        deleted_reply_refs: replies
            .into_iter()
            .map(|id| format!("{} {} R", id.0, id.1))
            .collect(),
    }))
}

/// The pages a parse of the saved file can read differently from the base:
/// each page whose dictionary or annotation list the appended revision
/// rewrites, and each page listing an annotation threaded, through /IRT,
/// /Popup or /Parent, to one the revision writes, rewrites or drops from a
/// list or to one listed on a page already in scope. A parse lists replies
/// under their parent, so a reply reads on its parent's page and a scope must
/// hold the parent of every reply it holds.
fn changed_annotation_pages(base: &IncrementalDocument) -> Result<LocatedPages> {
    let document = base.get_prev_documents();
    let rewritten = |id: ObjectId| base.new_document.objects.contains_key(&id);
    let listing = AnnotationListing::new_for_pages(document, None);
    let mut links: HashMap<ObjectId, Vec<ObjectId>> = HashMap::new();
    for id in listing.pages.keys() {
        let Ok(dict) = document.dictionary(*id) else {
            continue;
        };
        for key in [b"IRT".as_slice(), b"Popup", b"Parent"] {
            if let Some(other) =
                annotation_related_ref(dict, key).filter(|other| listing.pages.contains_key(other))
            {
                links.entry(*id).or_default().push(other);
                links.entry(other).or_default().push(*id);
            }
        }
    }
    let mut pages = HashSet::new();
    let mut touched = listing
        .pages
        .keys()
        .copied()
        .filter(|id| rewritten(*id))
        .collect::<Vec<_>>();
    // A written annotation, such as a new reply, threads to the base ones it names.
    for object in base.new_document.objects.values() {
        if let Ok(dict) = object.as_dict() {
            touched.extend(
                [b"IRT".as_slice(), b"Popup", b"Parent"]
                    .into_iter()
                    .filter_map(|key| annotation_related_ref(dict, key))
                    .filter(|id| listing.pages.contains_key(id)),
            );
        }
    }
    let page_numbers = document.page_ids();
    // Each list is compared as it resolves, through every reference to it.
    for page_id in page_numbers.values() {
        let listed = get_page_annots(document, *page_id)?;
        let kept = get_page_annots(base, *page_id)?;
        if rewritten(*page_id) || listed != kept {
            pages.insert(*page_id);
            touched.extend(
                listed
                    .iter()
                    .filter_map(|annotation| annotation.as_reference().ok())
                    .filter(|id| !kept.contains(&Object::Reference(*id))),
            );
        }
    }
    // A parse of a page lists each of its annotations under its thread's
    // root, so every page a scope holds brings the pages of its annotations'
    // threads, until no page is added.
    let mut thread = HashSet::new();
    let mut scanned = HashSet::new();
    loop {
        while let Some(id) = touched.pop() {
            if thread.insert(id) {
                touched.extend(links.get(&id).into_iter().flatten().copied());
            }
        }
        pages.extend(listing.pages_of(&thread));
        for page_id in pages.iter().filter(|page| !scanned.contains(*page)) {
            touched.extend(
                get_page_annots(document, *page_id)?
                    .iter()
                    .filter_map(|annotation| annotation.as_reference().ok())
                    .filter(|id| !thread.contains(id)),
            );
        }
        scanned.extend(pages.iter().copied());
        if pages.len() > MAX_ANNOTATION_IDENTITY_BINDINGS {
            return Err("The changed pages exceed the report's page limit".into());
        }
        if touched.is_empty() {
            break;
        }
    }
    let indexes = page_numbers
        .into_iter()
        .filter(|(_, page_id)| pages.contains(page_id))
        .map(|(number, _)| number.saturating_sub(1))
        .collect();
    LocatedPages::resolve(document, &indexes)
}

pub(crate) fn serialize_native_save_report(
    bindings: &[AnnotationIdentityBinding],
    effects: Option<&AnnotationDeleteEffects>,
) -> Result<Vec<u8>> {
    let Some(effects) = effects else {
        return serialize_annotation_identity_bindings_report(bindings);
    };
    validate_annotation_identity_bindings(bindings)?;
    let bytes = serde_json::to_vec(
        &serde_json::json!({"identityBindings":bindings,"annotationDeleteEffects":effects}),
    )?;
    if bytes.len() > MAX_ANNOTATION_IDENTITY_REPORT_BYTES {
        return serialize_annotation_identity_bindings_report(bindings);
    }
    Ok(bytes)
}

#[cfg(test)]
pub(crate) fn write_annotation_identity_bindings_report(
    path: &Path,
    bindings: &[AnnotationIdentityBinding],
) -> Result<()> {
    let bytes = serialize_annotation_identity_bindings_report(bindings)?;
    fs::write(path, bytes)?;
    Ok(())
}

pub(crate) fn serialize_annotation_identity_bindings_report(
    bindings: &[AnnotationIdentityBinding],
) -> Result<Vec<u8>> {
    validate_annotation_identity_bindings(bindings)?;
    let bytes = serde_json::to_vec(bindings)?;
    if bytes.len() > MAX_ANNOTATION_IDENTITY_REPORT_BYTES {
        return Err("Native annotation identity binding report is too large".into());
    }
    Ok(bytes)
}

pub(crate) fn validate_annotation_identity_bindings(
    bindings: &[AnnotationIdentityBinding],
) -> Result<()> {
    if bindings.len() > MAX_ANNOTATION_IDENTITY_BINDINGS {
        return Err("Native annotation identity binding report exceeds its item limit".into());
    }
    let mut annotation_ids = HashSet::new();
    let mut pdf_refs = HashSet::new();
    for binding in bindings {
        if binding.annotation_id.trim().is_empty()
            || binding.annotation_id.len() > 2_048
            || !annotation_ids.insert(binding.annotation_id.as_str())
            || !pdf_refs.insert(binding.pdf_ref.as_str())
        {
            return Err(
                "Native annotation identity binding report contains a duplicate or invalid binding"
                    .into(),
            );
        }
        let mut ref_parts = binding.pdf_ref.split(' ');
        let object_number = ref_parts.next().and_then(|value| value.parse::<u64>().ok());
        let generation_number = ref_parts.next().and_then(|value| value.parse::<u64>().ok());
        if object_number.is_none()
            || object_number == Some(0)
            || generation_number.is_none()
            || ref_parts.next() != Some("R")
            || ref_parts.next().is_some()
        {
            return Err(
                "Native annotation identity binding report contains an invalid PDF reference"
                    .into(),
            );
        }
    }
    Ok(())
}
