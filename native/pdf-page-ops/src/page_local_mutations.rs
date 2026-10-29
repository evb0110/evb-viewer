//! Admission of mutations whose existing writers use a page-local base.
use super::*;

/// What a page-local edit touches: page indexes it rewrites, the pages whose
/// annotations it reads, annotations it addresses by object, whose pages are
/// found through their `/P`, objects it reads with all they reference, and
/// the bookmark path a later outline chunk extends.
#[derive(Default)]
pub(crate) struct PageLocalEdit {
    pub(crate) pages: BTreeSet<u32>,
    pub(crate) annotation_pages: BTreeSet<u32>,
    pub(crate) annotations: BTreeSet<ObjectId>,
    pub(crate) closure: BTreeSet<ObjectId>,
    pub(crate) outline: Option<Vec<u32>>,
}

impl PageLocalEdit {
    /// The page indexes the load locates by number.
    pub(crate) fn located(&self) -> BTreeSet<u32> {
        self.pages.union(&self.annotation_pages).copied().collect()
    }
}

/// Mutations whose writers can use selected pages and dependency closures.
/// Annotation upserts and deletes discover ownership through the page-tree scan;
/// page labels and bookmarks rewrite the catalog.
pub(crate) fn page_local_edit(mutations: &NativeMutationsFile) -> Option<PageLocalEdit> {
    let NativeMutationsFile {
        updates,
        geometry_updates,
        notes,
        free_text_notes,
        text_boxes,
        deletes,
        page_rotations,
        page_labels,
        bookmarks,
        shapes,
        markup,
        placed_images,
        placed_image_geometry_updates,
        continuation,
    } = mutations;
    let notes = notes.iter().chain(free_text_notes);
    let page_local = text_boxes
        .iter()
        .all(|editor| editor.original_appearance.is_none())
        && shapes.as_ref().is_none_or(|shapes| {
            shapes.shapes.iter().all(|shape| {
                shape_annotation_subtype_for_create(shape).is_some()
                    && (shape.annotation_id.is_some()
                        || normalize_managed_shape_stable_key(shape.stable_key.as_deref())
                            .is_some())
            })
        })
        && placed_images.iter().all(|image| {
            image.annotation_id.is_none()
                && image
                    .stable_key
                    .as_deref()
                    .is_some_and(|key| !key.trim().is_empty())
        })
        && placed_image_geometry_updates
            .iter()
            .all(|update| update.source_image.is_none())
        && continuation.as_ref().is_none_or(is_catalog_continuation)
        && notes.clone().all(|note| note.recovery_data.is_none());
    let mut edit = PageLocalEdit::default();
    edit.annotation_pages.extend(
        notes
            .map(|note| note.page_index)
            .chain(geometry_updates.iter().map(|update| update.page_index))
            .chain(text_boxes.iter().map(|editor| editor.page_index))
            .chain(
                shapes
                    .iter()
                    .flat_map(|s| s.shapes.iter().map(|s| s.page_index)),
            )
            .chain(
                markup
                    .iter()
                    .flat_map(|m| m.hints.iter().map(|h| h.page_index)),
            )
            .chain(placed_images.iter().map(|image| image.page_index))
            .chain(placed_image_geometry_updates.iter().map(|i| i.page_index))
            .chain(deletes.iter().map(|delete| delete.page_index)),
    );
    edit.annotations.extend(
        updates
            .iter()
            .map(|update| (update.object_number, update.generation_number))
            .chain(
                geometry_updates
                    .iter()
                    .map(|update| (update.object_number, update.generation_number)),
            ),
    );
    edit.pages.clone_from(&edit.annotation_pages);
    edit.pages
        .extend(page_rotations.iter().map(|rotation| rotation.page_index));
    edit.pages.extend(bookmark_pages(bookmarks.as_ref())?);
    edit.outline = continuation
        .as_ref()
        .filter(|value| value.family == NativeMutationContinuationFamily::Bookmarks)
        .map(|value| value.bookmark_path.clone());
    let writes = page_labels.is_some() || bookmarks.is_some() || shapes.is_some();
    (page_local && (writes || !(edit.pages.is_empty() && edit.annotations.is_empty())))
        .then_some(edit)
}

/// Raster replacement and geometry-only markup matching keep the whole path.
/// Scanned targets may upsert; fresh creates retain target-page admission.
pub(crate) fn additive_targets_are_new(
    incremental: &IncrementalDocument,
    mutations: &NativeMutationsFile,
    scanned: bool,
) -> Result<bool> {
    let source = AppendedRevision::new(incremental);
    let pages = PageLookup::new(&source, source.located_pages())?;
    let mut targets = HashSet::<String>::new();
    let mut names_on =
        |page_index: u32, name: String, prefixes: &[&str], existing: bool| -> Result<bool> {
            if targets
                .iter()
                .any(|existing| annotation_names_match(existing, &name, prefixes))
            {
                return Ok(false);
            }
            targets.insert(name.clone());
            if existing {
                return Ok(true);
            }
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
        if !names_on(
            editor.page_index,
            text_box_name(editor),
            &["evb-freetext:"],
            scanned,
        )? {
            return Ok(false);
        }
    }
    for shape in mutations.shapes.iter().flat_map(|shapes| &shapes.shapes) {
        if let Some(key) = normalize_managed_shape_stable_key(shape.stable_key.as_deref()) {
            if !names_on(shape.page_index, key, &["evb-shape:"], scanned)? {
                return Ok(false);
            }
        }
    }
    for image in &mutations.placed_images {
        if !names_on(
            image.page_index,
            image
                .stable_key
                .as_deref()
                .unwrap_or_default()
                .trim()
                .to_owned(),
            &["placed-image-native:"],
            false,
        )? {
            return Ok(false);
        }
    }
    if let Some(markup) = &mutations.markup {
        for hint in &markup.hints {
            if let Some(name) = markup_annotation_name(hint) {
                if !names_on(hint.page_index, name, &["evb-markup:"], scanned)? {
                    return Ok(false);
                }
            }
            // editor-live hints can also match existing markup by geometry.
            if can_use_geometry_only_subtype_hint(hint)
                && normalize_hint_annotation_ref(hint).is_none()
            {
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

/// Byte-admitted inputs retain the whole writer's orphan-page semantics.
/// Above that ceiling, deletion ownership is the catalog page tree only:
/// orphan pages are outside the document the viewer displays.
pub(crate) fn load_native_mutation_base(
    path: &Path,
    qpdf: Option<&Path>,
    mutations: &NativeMutationsFile,
) -> Result<IncrementalDocument> {
    if fs::metadata(path)?.len() > MAX_ENCODED_PDF_BYTES as u64 {
        if let (Some(qpdf), Some(mut edit)) = (qpdf, page_local_edit(mutations)) {
            let local = (|| {
                let existing = !mutations.deletes.is_empty()
                    || mutations.shapes.as_ref().is_some_and(|shapes| {
                        shapes.rewrite_shape_state
                            || !shapes.deleted_annotation_ids.is_empty()
                            || !shapes.deleted_stable_keys.is_empty()
                            || shapes
                                .shapes
                                .iter()
                                .any(|shape| shape.annotation_id.is_some())
                    })
                    || mutations
                        .text_boxes
                        .iter()
                        .any(|editor| editor.annotation_id.is_some())
                    || mutations.markup.as_ref().is_some_and(|markup| {
                        markup
                            .hints
                            .iter()
                            .any(|hint| !is_new_markup_hint_data(hint))
                    });
                if !existing {
                    if let Some(base) = load_page_local_catalog(path, qpdf, mutations, &mut edit)? {
                        if additive_targets_are_new(&base, mutations, false)? {
                            return Ok(Some(base));
                        }
                    }
                }
                extend_page_local_delete_edit(path, qpdf, mutations, &mut edit)?;
                let incremental = load_qpdf_page_local_incremental_pdf(path, qpdf, &edit)?;
                match incremental {
                    Some(base)
                        if additive_targets_are_new(&base, mutations, true)?
                            && page_local_delete_closure_loaded(&base, mutations, &edit)? =>
                    {
                        Ok(Some(base))
                    }
                    _ => Ok(None),
                }
            })();
            if let Ok(Some(base)) = local as Result<Option<IncrementalDocument>> {
                return Ok(base);
            }
        }
    }
    if is_dictionary_only_mutation(mutations) {
        load_dictionary_incremental_pdf_path(path, qpdf)
    } else {
        load_incremental_pdf_path(path, qpdf)
    }
}
/// The page an addressed annotation names through its own `/P`, or a popup
/// through its parent's: a page dictionary, or an object not loaded yet.
pub(crate) fn addressed_annotation_page(
    document: &Document,
    annotation_id: ObjectId,
) -> Option<ObjectId> {
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
pub(crate) fn page_local_annotations_located(
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn image_and_delete_admission_locates_requested_pages() {
        let image = json!({"pageIndex":21600,"stableKey":"new-image","x":0.1,"y":0.2,"width":0.3,"height":0.1,"mimeType":"image/png","bytesBase64":"AA==","byteLength":1,"sha256":"a".repeat(64)});
        let payload = |value| serde_json::from_value::<NativeMutationsFile>(value).unwrap();
        let edit = page_local_edit(&payload(json!({"placedImages":[image.clone()]}))).unwrap();
        assert_eq!(edit.located(), BTreeSet::from([21600]));
        let mut replacement = image;
        replacement["annotationId"] = json!("50R");
        assert!(page_local_edit(&payload(json!({"placedImages":[replacement]}))).is_none());
        let mut movement = json!({"pageIndex":10800,"stableKey":"image","annotationId":"50R","x":0.2,"y":0.3,"width":0.3,"height":0.1});
        assert_eq!(
            page_local_edit(&payload(
                json!({"placedImageGeometryUpdates":[movement.clone()]})
            ))
            .unwrap()
            .located(),
            BTreeSet::from([10800])
        );
        movement["sourceImage"] =
            json!({"objectNumber":42,"generationNumber":0,"byteLength":20,"sha256":"a".repeat(64)});
        assert!(
            page_local_edit(&payload(json!({"placedImageGeometryUpdates":[movement]}))).is_none()
        );
        for delete in [
            json!({"pageIndex":21600,"objectNumber":50,"generationNumber":0}),
            json!({"pageIndex":0,"stableKey":"note"}),
        ] {
            assert!(page_local_edit(&payload(json!({"deletes":[delete]}))).is_some());
        }
    }
}
