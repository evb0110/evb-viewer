//! Admission of mutations whose existing writers use a page-local base.
use super::*;

/// The pages and annotations of an edit whose writers read only those:
/// rotations, notes without recovery imports, and additive markup, simple
/// shapes, text boxes and placed images, plus image moves. Loaded creates
/// must also pass `additive_targets_are_new`.
/// Deletes can reach replies on other pages and always need whole discovery.
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
    let page_local = deletes.is_empty()
        && text_boxes
            .iter()
            .all(|editor| editor.annotation_id.is_none() && editor.original_appearance.is_none())
        && page_labels.is_none()
        && bookmarks.is_none()
        && shapes.as_ref().is_none_or(|shapes| {
            !shapes.rewrite_shape_state
                && shapes.deleted_annotation_ids.is_empty()
                && shapes.deleted_stable_keys.is_empty()
                && shapes.shapes.iter().all(|shape| {
                    shape.annotation_id.is_none()
                        && normalize_managed_shape_stable_key(shape.stable_key.as_deref()).is_some()
                        && matches!(
                            shape.shape_type.as_str(),
                            "rectangle" | "circle" | "line" | "arrow"
                        )
                })
        })
        && markup
            .as_ref()
            .is_none_or(|markup| markup.hints.iter().all(is_new_markup_hint_data))
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
        && continuation.is_none()
        && notes.clone().all(|note| note.recovery_data.is_none());
    let mut edit = PageLocalEdit::default();
    edit.annotation_pages
        .extend(notes.map(|note| note.page_index));
    edit.annotation_pages
        .extend(geometry_updates.iter().map(|update| update.page_index));
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
    edit.annotation_pages
        .extend(text_boxes.iter().map(|editor| editor.page_index));
    edit.annotation_pages.extend(
        shapes
            .iter()
            .flat_map(|s| s.shapes.iter().map(|shape| shape.page_index)),
    );
    edit.annotation_pages.extend(
        markup
            .iter()
            .flat_map(|m| m.hints.iter().map(|hint| hint.page_index)),
    );
    edit.annotation_pages
        .extend(placed_images.iter().map(|image| image.page_index));
    edit.annotation_pages.extend(
        placed_image_geometry_updates
            .iter()
            .map(|image| image.page_index),
    );
    edit.pages.clone_from(&edit.annotation_pages);
    edit.pages
        .extend(page_rotations.iter().map(|rotation| rotation.page_index));
    (page_local && !(edit.pages.is_empty() && edit.annotations.is_empty())).then_some(edit)
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
        if !names_on(editor.page_index, text_box_name(editor), &["evb-freetext:"])? {
            return Ok(false);
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
        )? {
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
    fn image_admission_locates_requested_pages_but_never_accepts_deletion_hints() {
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
            assert!(page_local_edit(&payload(json!({"deletes":[delete]}))).is_none());
        }
    }
}
