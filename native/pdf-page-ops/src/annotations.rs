use super::*;

/// PDF's standard sticky-note icon is a 20 point square. The mutation
/// protocol still carries the marker's normalized anchor, so the writer
/// expands that anchor into the physical icon rectangle on disk.
pub(crate) const TEXT_NOTE_ICON_SIZE_PT: f64 = 20.0;

pub(crate) struct NoteTarget {
    pub(crate) annotation_id: ObjectId,
    pub(crate) annotation_subtype: String,
    pub(crate) popup_ref: Option<ObjectId>,
    pub(crate) target_is_popup: bool,
    pub(crate) page_id: Option<ObjectId>,
}

pub(crate) fn resolve_note_target(
    document: &impl PdfObjectSource,
    target_id: ObjectId,
) -> Result<NoteTarget> {
    let target_dict = document.dictionary(target_id)?;
    let target_subtype = annotation_subtype(target_dict);
    if target_subtype == "popup" {
        let parent_id = annotation_related_ref(target_dict, b"Parent")
            .ok_or("Popup note target is missing its Parent reference")?;
        let parent_dict = document.dictionary(parent_id)?;
        let page_id = find_annotation_page_from_annots(document, target_id)
            .or_else(|_| find_annotation_page_from_annots(document, parent_id))
            .ok();
        return Ok(NoteTarget {
            annotation_id: parent_id,
            annotation_subtype: annotation_subtype(parent_dict),
            popup_ref: Some(target_id),
            target_is_popup: true,
            page_id,
        });
    }

    Ok(NoteTarget {
        annotation_id: target_id,
        annotation_subtype: target_subtype,
        popup_ref: annotation_related_ref(target_dict, b"Popup"),
        target_is_popup: false,
        page_id: find_annotation_page_from_annots(document, target_id).ok(),
    })
}

pub(crate) fn text_note_pdf_rect(
    marker_rect: MarkerRect,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<PdfRect> {
    // A quarter-turn swaps the normalized axes. Account for that swap so the
    // resulting PDF-space rectangle remains a 20 point square on rectangular
    // pages as well as square pages.
    let (width, height) = match normalize_page_rotation(page_rotation) {
        90 | 270 => (
            TEXT_NOTE_ICON_SIZE_PT / page_view.height(),
            TEXT_NOTE_ICON_SIZE_PT / page_view.width(),
        ),
        _ => (
            TEXT_NOTE_ICON_SIZE_PT / page_view.width(),
            TEXT_NOTE_ICON_SIZE_PT / page_view.height(),
        ),
    };
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > 1.0
        || height > 1.0
    {
        return Err("Text note icon does not fit within the PDF page dimensions".into());
    }

    // Keep the icon in the normalized page box when the click lands within
    // one icon of an edge. The anchor remains the requested point everywhere
    // else, and the physical rectangle is always exactly 20 points square.
    let anchor = MarkerRect {
        left: marker_rect.left.min(1.0 - width),
        top: marker_rect.top.min(1.0 - height),
        width,
        height,
    };
    marker_rect_to_pdf_rect(anchor, page_view, page_rotation)
}

fn text_note_pdf_rect_from_existing(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<PdfRect> {
    let existing_rect = parse_rect(document.resolved(dict.get(b"Rect")?)?)?;
    let marker_rect = pdf_rect_to_marker_rect(existing_rect, page_view, page_rotation)?;
    text_note_pdf_rect(marker_rect, page_view, page_rotation)
}

pub(crate) fn update_note_text(
    document: &mut Document,
    updates: &[NoteTextUpdate],
    modified_at: &str,
) -> Result<()> {
    let mut updated_count = 0;
    for update in updates {
        let target_id = (update.object_number, update.generation_number);
        if update_annotation_text_by_ref(document, target_id, &update.text, modified_at)? {
            updated_count += 1;
        }
    }
    if updated_count != updates.len() {
        return Err(format!(
            "Updated {updated_count} of {} requested note annotation(s)",
            updates.len()
        )
        .into());
    }
    Ok(())
}

fn find_annotation_page_from_annots(
    document: &impl PdfObjectSource,
    target_id: ObjectId,
) -> Result<ObjectId> {
    for page_id in document.page_ids().into_values() {
        if get_page_annots(document, page_id)?
            .iter()
            .any(|object| object.as_reference().ok() == Some(target_id))
        {
            return Ok(page_id);
        }
    }
    Err(format!(
        "Note geometry target {}R{} is not referenced from page Annots",
        target_id.0, target_id.1
    )
    .into())
}

fn set_annotation_geometry_dict(dict: &mut Dictionary, page_id: ObjectId, pdf_rect: PdfRect) {
    dict.set("Rect", rect_object(pdf_rect));
    dict.set("P", Object::Reference(page_id));
}

fn remove_annotation_refs_from_page(
    document: &mut Document,
    page_id: ObjectId,
    refs: &[ObjectId],
) -> Result<bool> {
    let refs_to_remove: HashSet<ObjectId> = refs.iter().copied().collect();
    let annots = get_page_annots(document, page_id)?;
    let (filtered, removed) = filter_annots_without_refs(annots, &refs_to_remove);
    if removed {
        document
            .get_dictionary_mut(page_id)?
            .set("Annots", Object::Array(filtered));
    }
    Ok(removed)
}

fn append_missing_annotation_refs_to_page(
    document: &mut Document,
    page_id: ObjectId,
    refs: &[ObjectId],
) -> Result<()> {
    let mut annots = get_page_annots(document, page_id)?;
    let initial_len = annots.len();
    for object_id in refs {
        if !annots
            .iter()
            .any(|object| object.as_reference().ok() == Some(*object_id))
        {
            annots.push(Object::Reference(*object_id));
        }
    }
    if annots.len() == initial_len {
        return Ok(());
    }
    document
        .get_dictionary_mut(page_id)?
        .set("Annots", Object::Array(annots));
    Ok(())
}

pub(crate) fn update_note_geometry(
    document: &mut Document,
    updates: &[NoteGeometryUpdate],
    modified_at: &str,
) -> Result<()> {
    if updates.is_empty() {
        return Ok(());
    }
    let page_resolver = PageTreeResolver::new(document)?;
    let mut updated_count = 0;
    for update in updates {
        let target_id = (update.object_number, update.generation_number);
        let target = resolve_note_target(document, target_id)?;
        if target.annotation_subtype != "text" && target.annotation_subtype != "freetext" {
            return Err(format!(
                "Note geometry target {}R{} is not a Text annotation",
                target_id.0, target_id.1
            )
            .into());
        }
        let source_page_id = target
            .page_id
            .ok_or("Note geometry target is not referenced from page Annots")?;
        let page_number = update
            .page_index
            .checked_add(1)
            .ok_or("Invalid note geometry page index")?;
        let destination_page_id = page_resolver.page_id(document, page_number)?;
        let page_view = resolve_page_view(document, destination_page_id)?;
        let page_rotation = resolve_page_rotation(document, destination_page_id)?;
        let source_page_view = resolve_page_view(document, source_page_id)?;
        let source_page_rotation = resolve_page_rotation(document, source_page_id)?;
        let marker_form = target.annotation_subtype == "freetext"
            && is_free_text_note_marker(
                document,
                document.get_dictionary(target.annotation_id)?,
                source_page_view,
                source_page_rotation,
            );
        let pdf_rect = if target.annotation_subtype == "text" || marker_form {
            text_note_pdf_rect(update.marker_rect, page_view, page_rotation)?
        } else {
            marker_rect_to_pdf_rect(update.marker_rect, page_view, page_rotation)?
        };

        if marker_form {
            let target_dict = document.get_dictionary_mut(target.annotation_id)?;
            convert_free_text_marker_to_text(target_dict, pdf_rect, modified_at);
        }

        {
            let target_dict = document.get_dictionary_mut(target.annotation_id)?;
            set_annotation_geometry_dict(target_dict, destination_page_id, pdf_rect);
            if let Ok(Object::Dictionary(popup_dict)) = target_dict.get_mut(b"Popup") {
                set_annotation_geometry_dict(popup_dict, destination_page_id, pdf_rect);
            }
        }
        if let Some(popup_id) = target.popup_ref {
            let popup_dict = document.get_dictionary_mut(popup_id)?;
            set_annotation_geometry_dict(popup_dict, destination_page_id, pdf_rect);
        }

        let mut refs = vec![target.annotation_id];
        if let Some(popup_id) = target.popup_ref {
            refs.push(popup_id);
        }
        if source_page_id != destination_page_id {
            remove_annotation_refs_from_page(document, source_page_id, &refs)?;
        }
        append_missing_annotation_refs_to_page(document, destination_page_id, &refs)?;
        updated_count += 1;
    }
    if updated_count != updates.len() {
        return Err(format!(
            "Updated {updated_count} of {} requested note geometry annotation(s)",
            updates.len()
        )
        .into());
    }
    Ok(())
}

fn get_incremental_page_annots(
    incremental: &IncrementalDocument,
    page_id: ObjectId,
) -> Result<Vec<Object>> {
    get_page_annots(&incremental.new_document, page_id)
        .or_else(|_| get_page_annots(incremental.get_prev_documents(), page_id))
}

fn remove_annotation_refs_from_page_incremental(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
    refs: &[ObjectId],
) -> Result<bool> {
    let refs_to_remove: HashSet<ObjectId> = refs.iter().copied().collect();
    let annots = get_incremental_page_annots(incremental, page_id)?;
    let (filtered, removed) = filter_annots_without_refs(annots, &refs_to_remove);
    if removed {
        incremental.opt_clone_object_to_new_document(page_id)?;
        incremental
            .new_document
            .get_dictionary_mut(page_id)?
            .set("Annots", Object::Array(filtered));
    }
    Ok(removed)
}

fn append_missing_annotation_refs_to_page_incremental(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
    refs: &[ObjectId],
) -> Result<()> {
    let mut annots = get_incremental_page_annots(incremental, page_id)?;
    let initial_len = annots.len();
    for object_id in refs {
        if !annots
            .iter()
            .any(|object| object.as_reference().ok() == Some(*object_id))
        {
            annots.push(Object::Reference(*object_id));
        }
    }
    if annots.len() == initial_len {
        return Ok(());
    }
    incremental.opt_clone_object_to_new_document(page_id)?;
    incremental
        .new_document
        .get_dictionary_mut(page_id)?
        .set("Annots", Object::Array(annots));
    Ok(())
}

pub(crate) fn update_note_geometry_incremental(
    incremental: &mut IncrementalDocument,
    updates: &[NoteGeometryUpdate],
    modified_at: &str,
) -> Result<()> {
    if updates.is_empty() {
        return Ok(());
    }
    let page_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
    for update in updates {
        let target_id = (update.object_number, update.generation_number);
        let target = resolve_note_target(incremental.get_prev_documents(), target_id)?;
        if target.annotation_subtype != "text" && target.annotation_subtype != "freetext" {
            return Err(format!(
                "Note geometry target {}R{} is not a Text annotation",
                target_id.0, target_id.1
            )
            .into());
        }
        let source_page_id = target
            .page_id
            .ok_or("Note geometry target is not referenced from page Annots")?;
        let page_number = update
            .page_index
            .checked_add(1)
            .ok_or("Invalid note geometry page index")?;
        let destination_page_id =
            page_resolver.page_id(incremental.get_prev_documents(), page_number)?;
        let page_view = resolve_page_view(incremental.get_prev_documents(), destination_page_id)?;
        let page_rotation =
            resolve_page_rotation(incremental.get_prev_documents(), destination_page_id)?;
        let source_page_view = resolve_page_view(incremental.get_prev_documents(), source_page_id)?;
        let source_page_rotation =
            resolve_page_rotation(incremental.get_prev_documents(), source_page_id)?;
        let marker_form = target.annotation_subtype == "freetext"
            && is_free_text_note_marker(
                incremental.get_prev_documents(),
                incremental
                    .get_prev_documents()
                    .get_dictionary(target.annotation_id)?,
                source_page_view,
                source_page_rotation,
            );
        let pdf_rect = if target.annotation_subtype == "text" || marker_form {
            text_note_pdf_rect(update.marker_rect, page_view, page_rotation)?
        } else {
            marker_rect_to_pdf_rect(update.marker_rect, page_view, page_rotation)?
        };

        incremental.opt_clone_object_to_new_document(target.annotation_id)?;
        if marker_form {
            let target_dict = incremental
                .new_document
                .get_dictionary_mut(target.annotation_id)?;
            convert_free_text_marker_to_text(target_dict, pdf_rect, modified_at);
        }

        {
            let target_dict = incremental
                .new_document
                .get_dictionary_mut(target.annotation_id)?;
            set_annotation_geometry_dict(target_dict, destination_page_id, pdf_rect);
            if let Ok(Object::Dictionary(popup_dict)) = target_dict.get_mut(b"Popup") {
                set_annotation_geometry_dict(popup_dict, destination_page_id, pdf_rect);
            }
        }
        if let Some(popup_id) = target.popup_ref {
            incremental.opt_clone_object_to_new_document(popup_id)?;
            let popup_dict = incremental.new_document.get_dictionary_mut(popup_id)?;
            set_annotation_geometry_dict(popup_dict, destination_page_id, pdf_rect);
        }

        let mut refs = vec![target.annotation_id];
        if let Some(popup_id) = target.popup_ref {
            refs.push(popup_id);
        }
        if source_page_id != destination_page_id {
            remove_annotation_refs_from_page_incremental(incremental, source_page_id, &refs)?;
        }
        append_missing_annotation_refs_to_page_incremental(
            incremental,
            destination_page_id,
            &refs,
        )?;
    }
    Ok(())
}

pub(crate) fn upsert_text_notes_with_counter<'a, I>(
    document: &mut Document,
    notes: I,
    modified_at: &str,
    annotation_visits: &mut usize,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()>
where
    I: IntoIterator<Item = &'a TextNote>,
{
    let notes = notes.into_iter().collect::<Vec<_>>();
    if notes.is_empty() {
        return Ok(());
    }

    let page_resolver = PageTreeResolver::new(document)?;
    let mut note_pages = Vec::with_capacity(notes.len());
    let mut annotation_indexes = HashMap::new();
    for note in &notes {
        let page_number = note
            .page_index
            .checked_add(1)
            .ok_or("Invalid Text note page index")?;
        let page_id = page_resolver.page_id(document, page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            let (index, scanned) = build_page_annotation_index(document, page_id)?;
            *annotation_visits = (*annotation_visits).saturating_add(scanned);
            entry.insert(index);
        }
        note_pages.push(page_id);
    }

    for (note, page_id) in notes.iter().zip(note_pages) {
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let pdf_rect = text_note_pdf_rect(note.marker_rect, page_view, page_rotation)?;
        let note_name = replayable_free_text_note_name(note);
        let existing = annotation_indexes
            .get(&page_id)
            .and_then(|index| index.first_text_note_named(&note_name));

        if let Some(annot_id) = existing {
            let (subtype, popup_ref) = {
                let annot_dict = document.get_dictionary(annot_id)?;
                (
                    annotation_subtype(annot_dict),
                    annotation_related_ref(annot_dict, b"Popup"),
                )
            };
            let popup_ref = popup_ref.unwrap_or_else(|| document.new_object_id());
            {
                let annot_dict = document.get_dictionary_mut(annot_id)?;
                if subtype == "freetext" {
                    convert_free_text_marker_to_text(annot_dict, pdf_rect, modified_at);
                } else {
                    annot_dict.remove(b"AP");
                    annot_dict.remove(b"DA");
                }
                set_text_note_annotation_fields(
                    annot_dict,
                    note,
                    &note_name,
                    pdf_rect,
                    modified_at,
                );
                annot_dict.set("Popup", Object::Reference(popup_ref));
                annot_dict.set("P", Object::Reference(page_id));
            }
            if document.get_object(popup_ref).is_err() {
                let mut popup_dict =
                    build_popup_annotation_dict(note, pdf_rect, modified_at, annot_id);
                popup_dict.set("P", Object::Reference(page_id));
                document.set_object(popup_ref, Object::Dictionary(popup_dict));
            } else {
                let popup_dict = document.get_dictionary_mut(popup_ref)?;
                set_popup_annotation_fields(popup_dict, note, pdf_rect, modified_at, annot_id);
                popup_dict.set("P", Object::Reference(page_id));
            }
            annotation_indexes
                .get_mut(&page_id)
                .expect("Text note pages are indexed before mutation")
                .append_missing_refs(&[popup_ref]);
            continue;
        }

        let annot_ref = document.new_object_id();
        let popup_ref = document.new_object_id();
        let mut annot_dict =
            build_text_note_annotation_dict(note, &note_name, pdf_rect, modified_at);
        annot_dict.set("P", Object::Reference(page_id));
        annot_dict.set("Popup", Object::Reference(popup_ref));
        let mut popup_dict = build_popup_annotation_dict(note, pdf_rect, modified_at, annot_ref);
        popup_dict.set("P", Object::Reference(page_id));
        document.set_object(annot_ref, Object::Dictionary(annot_dict));
        document.set_object(popup_ref, Object::Dictionary(popup_dict));
        report_annotation_identity_binding(identity_bindings, &note.stable_key, annot_ref);
        annotation_indexes
            .get_mut(&page_id)
            .expect("Text note pages are indexed before mutation")
            .append_text_note(&note_name, annot_ref, popup_ref);
    }
    for (page_id, index) in annotation_indexes {
        write_page_annotation_index(document, page_id, index)?;
    }
    Ok(())
}

/// Report a newly created note or text box's durable identity so the caller
/// can refresh its object references after the save. Both writers identify
/// their annotations by stable key; the writer keeps no other canonical
/// identity.
fn report_annotation_identity_binding(
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
    stable_key: &str,
    annot_ref: ObjectId,
) {
    append_annotation_identity_binding(identity_bindings, Some(stable_key), None, annot_ref);
}

/// Keep the legacy Rust entry point for callers and tests while routing both
/// field names through the canonical `/Text` writer.
#[allow(dead_code)]
pub(crate) fn upsert_free_text_notes_with_counter(
    document: &mut Document,
    notes: &[FreeTextNote],
    modified_at: &str,
    annotation_visits: &mut usize,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()> {
    upsert_text_notes_with_counter(
        document,
        notes.iter(),
        modified_at,
        annotation_visits,
        identity_bindings,
    )
}

pub(crate) fn upsert_text_notes_incremental_with_counter<'a, I>(
    incremental: &mut IncrementalDocument,
    notes: I,
    modified_at: &str,
    annotation_visits: &mut usize,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()>
where
    I: IntoIterator<Item = &'a TextNote>,
{
    let notes = notes.into_iter().collect::<Vec<_>>();
    if notes.is_empty() {
        return Ok(());
    }

    let page_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
    let mut note_pages = Vec::with_capacity(notes.len());
    let mut annotation_indexes = HashMap::new();
    for note in &notes {
        let page_number = note
            .page_index
            .checked_add(1)
            .ok_or("Invalid Text note page index")?;
        let page_id = page_resolver.page_id(incremental.get_prev_documents(), page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            let (index, scanned) = build_incremental_page_annotation_index(incremental, page_id)?;
            *annotation_visits = (*annotation_visits).saturating_add(scanned);
            entry.insert(index);
        }
        note_pages.push(page_id);
    }

    for (note, page_id) in notes.iter().zip(note_pages) {
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let pdf_rect = text_note_pdf_rect(note.marker_rect, page_view, page_rotation)?;
        let note_name = replayable_free_text_note_name(note);
        let existing = annotation_indexes
            .get(&page_id)
            .and_then(|index| index.first_text_note_named(&note_name));

        if let Some(annot_id) = existing {
            let (subtype, popup_ref) = {
                let revision = AppendedRevision::new(incremental);
                let annot_dict = revision.dictionary(annot_id)?;
                (
                    annotation_subtype(annot_dict),
                    annotation_related_ref(annot_dict, b"Popup"),
                )
            };
            let popup_ref = match popup_ref {
                Some(popup_ref) => popup_ref,
                None => incremental.new_document.new_object_id(),
            };
            incremental.opt_clone_object_to_new_document(annot_id)?;
            {
                let annot_dict = incremental.new_document.get_dictionary_mut(annot_id)?;
                if subtype == "freetext" {
                    convert_free_text_marker_to_text(annot_dict, pdf_rect, modified_at);
                } else {
                    annot_dict.remove(b"AP");
                    annot_dict.remove(b"DA");
                }
                set_text_note_annotation_fields(
                    annot_dict,
                    note,
                    &note_name,
                    pdf_rect,
                    modified_at,
                );
                annot_dict.set("Popup", Object::Reference(popup_ref));
                annot_dict.set("P", Object::Reference(page_id));
            }
            if incremental
                .get_prev_documents()
                .get_object(popup_ref)
                .is_ok()
            {
                incremental.opt_clone_object_to_new_document(popup_ref)?;
            }
            if incremental.new_document.get_object(popup_ref).is_err() {
                let mut popup_dict =
                    build_popup_annotation_dict(note, pdf_rect, modified_at, annot_id);
                popup_dict.set("P", Object::Reference(page_id));
                incremental
                    .new_document
                    .set_object(popup_ref, Object::Dictionary(popup_dict));
            } else {
                let popup_dict = incremental.new_document.get_dictionary_mut(popup_ref)?;
                set_popup_annotation_fields(popup_dict, note, pdf_rect, modified_at, annot_id);
                popup_dict.set("P", Object::Reference(page_id));
            }
            annotation_indexes
                .get_mut(&page_id)
                .expect("Text note pages are indexed before mutation")
                .append_missing_refs(&[popup_ref]);
            continue;
        }

        let annot_ref = incremental.new_document.new_object_id();
        let popup_ref = incremental.new_document.new_object_id();
        let mut annot_dict =
            build_text_note_annotation_dict(note, &note_name, pdf_rect, modified_at);
        annot_dict.set("P", Object::Reference(page_id));
        annot_dict.set("Popup", Object::Reference(popup_ref));
        let mut popup_dict = build_popup_annotation_dict(note, pdf_rect, modified_at, annot_ref);
        popup_dict.set("P", Object::Reference(page_id));
        incremental
            .new_document
            .set_object(annot_ref, Object::Dictionary(annot_dict));
        incremental
            .new_document
            .set_object(popup_ref, Object::Dictionary(popup_dict));
        report_annotation_identity_binding(identity_bindings, &note.stable_key, annot_ref);
        annotation_indexes
            .get_mut(&page_id)
            .expect("Text note pages are indexed before mutation")
            .append_text_note(&note_name, annot_ref, popup_ref);
    }
    for (page_id, index) in annotation_indexes {
        write_page_annotation_index_incremental(incremental, page_id, index)?;
    }
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn upsert_free_text_notes_incremental_with_counter(
    incremental: &mut IncrementalDocument,
    notes: &[FreeTextNote],
    modified_at: &str,
    annotation_visits: &mut usize,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()> {
    upsert_text_notes_incremental_with_counter(
        incremental,
        notes.iter(),
        modified_at,
        annotation_visits,
        identity_bindings,
    )
}

pub(crate) fn upsert_text_boxes_with_counter(
    document: &mut Document,
    editors: &[TextBoxMutation],
    modified_at: &str,
    annotation_visits: &mut usize,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()> {
    if editors.is_empty() {
        return Ok(());
    }
    let page_resolver = PageTreeResolver::new(document)?;
    let mut annotation_indexes = HashMap::new();
    for editor in editors {
        let page_number = editor
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText editor page index")?;
        let page_id = page_resolver.page_id(document, page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            let (index, scanned) = build_page_annotation_index(document, page_id)?;
            *annotation_visits = (*annotation_visits).saturating_add(scanned);
            entry.insert(index);
        }
        let page_view = resolve_page_view(document, page_id)?;
        let rect = validate_text_box_rect(editor, page_view)?;
        let name = text_box_name(editor);
        let appearance_ref = build_text_box_appearance(document, editor, rect)?;
        let existing_annotation_ref = resolve_text_box_target(document, page_id, editor)?;
        if let Some(annotation_ref) = existing_annotation_ref.or_else(|| {
            annotation_indexes
                .get(&page_id)
                .and_then(|index| index.first_free_text_named(&name))
        }) {
            let (existing_appearance, existing_default_appearance) =
                existing_text_box_values(document, annotation_ref)?;
            let dict = document.get_dictionary_mut(annotation_ref)?;
            set_text_box_fields(
                dict,
                editor,
                &name,
                rect,
                modified_at,
                appearance_ref,
                false,
                existing_appearance,
                existing_default_appearance,
            );
            continue;
        }
        let annotation_ref = document.new_object_id();
        let mut dict = Dictionary::new();
        dict.set("Type", Object::Name(b"Annot".to_vec()));
        dict.set("Subtype", Object::Name(b"FreeText".to_vec()));
        dict.set("F", Object::Integer(4));
        set_text_box_fields(
            &mut dict,
            editor,
            &name,
            rect,
            modified_at,
            appearance_ref,
            true,
            None,
            None,
        );
        document.set_object(annotation_ref, Object::Dictionary(dict));
        report_annotation_identity_binding(identity_bindings, &editor.stable_key, annotation_ref);
        annotation_indexes
            .get_mut(&page_id)
            .expect("FreeText editor pages are indexed before mutation")
            .append_free_text_without_popup(&name, annotation_ref);
    }
    for (page_id, index) in annotation_indexes {
        write_page_annotation_index(document, page_id, index)?;
    }
    Ok(())
}

pub(crate) fn upsert_text_boxes_incremental_with_counter(
    incremental: &mut IncrementalDocument,
    editors: &[TextBoxMutation],
    modified_at: &str,
    annotation_visits: &mut usize,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()> {
    if editors.is_empty() {
        return Ok(());
    }
    let page_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
    let mut annotation_indexes = HashMap::new();
    for editor in editors {
        let page_number = editor
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText editor page index")?;
        let page_id = page_resolver.page_id(incremental.get_prev_documents(), page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            let (index, scanned) = build_incremental_page_annotation_index(incremental, page_id)?;
            *annotation_visits = (*annotation_visits).saturating_add(scanned);
            entry.insert(index);
        }
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let rect = validate_text_box_rect(editor, page_view)?;
        let name = text_box_name(editor);
        let appearance_ref =
            build_text_box_appearance(&mut incremental.new_document, editor, rect)?;
        let existing_annotation_ref =
            resolve_text_box_target(&AppendedRevision::new(incremental), page_id, editor)?;
        if let Some(annotation_ref) = existing_annotation_ref.or_else(|| {
            annotation_indexes
                .get(&page_id)
                .and_then(|index| index.first_free_text_named(&name))
        }) {
            let (existing_appearance, existing_default_appearance) =
                existing_text_box_values(&AppendedRevision::new(incremental), annotation_ref)?;
            incremental.opt_clone_object_to_new_document(annotation_ref)?;
            let dict = incremental
                .new_document
                .get_dictionary_mut(annotation_ref)?;
            set_text_box_fields(
                dict,
                editor,
                &name,
                rect,
                modified_at,
                appearance_ref,
                false,
                existing_appearance,
                existing_default_appearance,
            );
            continue;
        }
        let annotation_ref = incremental.new_document.new_object_id();
        let mut dict = Dictionary::new();
        dict.set("Type", Object::Name(b"Annot".to_vec()));
        dict.set("Subtype", Object::Name(b"FreeText".to_vec()));
        dict.set("F", Object::Integer(4));
        set_text_box_fields(
            &mut dict,
            editor,
            &name,
            rect,
            modified_at,
            appearance_ref,
            true,
            None,
            None,
        );
        incremental
            .new_document
            .set_object(annotation_ref, Object::Dictionary(dict));
        report_annotation_identity_binding(identity_bindings, &editor.stable_key, annotation_ref);
        annotation_indexes
            .get_mut(&page_id)
            .expect("FreeText editor pages are indexed before mutation")
            .append_free_text_without_popup(&name, annotation_ref);
    }
    for (page_id, index) in annotation_indexes {
        write_page_annotation_index_incremental(incremental, page_id, index)?;
    }
    Ok(())
}

pub(crate) fn text_box_name(editor: &TextBoxMutation) -> String {
    editor.stable_key.trim().to_string()
}

fn resolve_text_box_target(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
    editor: &TextBoxMutation,
) -> Result<Option<ObjectId>> {
    let Some(annotation_id) = editor.annotation_id.as_deref() else {
        return Ok(None);
    };
    let object_id = parse_pdfjs_annotation_object_id(annotation_id)
        .ok_or("Invalid imported FreeText annotation id")?;
    if !get_page_annots(document, page_id)?
        .iter()
        .any(|annotation| annotation.as_reference().ok() == Some(object_id))
    {
        return Err("Imported FreeText annotation is not owned by the requested page".into());
    }
    let dict = document.dictionary(object_id)?;
    if dict
        .get(b"Subtype")
        .ok()
        .and_then(|value| value.as_name().ok())
        != Some(b"FreeText")
    {
        return Err("Imported FreeText target is not a FreeText annotation".into());
    }
    Ok(Some(object_id))
}

pub(crate) fn validate_text_box_rect(
    editor: &TextBoxMutation,
    page_view: PdfRect,
) -> Result<PdfRect> {
    if !matches!(editor.rotation, 0 | 90 | 180 | 270) {
        return Err("Invalid FreeText editor rotation".into());
    }
    if !editor.font_size.is_finite() || editor.font_size <= 0.0 || editor.font_size > 512.0 {
        return Err("Invalid FreeText editor font size".into());
    }
    let rect = PdfRect {
        x1: editor.rect[0],
        y1: editor.rect[1],
        x2: editor.rect[2],
        y2: editor.rect[3],
    };
    // PDF.js can place the editor border a couple of points beyond the page
    // box after viewport-to-PDF coordinate conversion. Preserve that exact
    // rectangle, but reject larger excursions that cannot be border rounding.
    const PAGE_EDGE_TOLERANCE: f64 = 4.0;
    if rect.x1 < page_view.x1 - PAGE_EDGE_TOLERANCE
        || rect.y1 < page_view.y1 - PAGE_EDGE_TOLERANCE
        || rect.x2 > page_view.x2 + PAGE_EDGE_TOLERANCE
        || rect.y2 > page_view.y2 + PAGE_EDGE_TOLERANCE
        || rect.width() <= 0.0
        || rect.height() <= 0.0
    {
        return Err("FreeText editor rectangle is outside the PDF page bounds".into());
    }
    Ok(rect)
}

fn escape_free_text_appearance_line(line: &str) -> String {
    let mut escaped = String::with_capacity(line.len());
    for byte in line.bytes() {
        match byte {
            b'(' | b')' | b'\\' => {
                escaped.push('\\');
                escaped.push(char::from(byte));
            }
            b'\t' => escaped.push_str("\\t"),
            0x20..=0x7e => escaped.push(char::from(byte)),
            _ => escaped.push_str(&format!("\\{byte:03o}")),
        }
    }
    escaped
}

fn helvetica_char_width(ch: char) -> f64 {
    match ch {
        ' ' => 278.0,
        '!' => 278.0,
        '"' => 355.0,
        '#' => 556.0,
        '$' => 556.0,
        '%' => 889.0,
        '&' => 667.0,
        '\'' => 191.0,
        '(' | ')' => 333.0,
        '*' => 389.0,
        '+' => 584.0,
        ',' | '.' => 278.0,
        '-' => 333.0,
        '/' => 278.0,
        '0'..='9' => 556.0,
        ':' | ';' => 278.0,
        '<' | '=' | '>' => 584.0,
        '?' => 556.0,
        '@' => 1_015.0,
        'A' => 667.0,
        'B' => 667.0,
        'C' => 722.0,
        'D' => 722.0,
        'E' => 667.0,
        'F' => 611.0,
        'G' => 778.0,
        'H' => 722.0,
        'I' => 278.0,
        'J' => 500.0,
        'K' => 667.0,
        'L' => 556.0,
        'M' => 833.0,
        'N' => 722.0,
        'O' => 778.0,
        'P' => 667.0,
        'Q' => 778.0,
        'R' => 722.0,
        'S' => 667.0,
        'T' => 611.0,
        'U' => 722.0,
        'V' => 667.0,
        'W' => 944.0,
        'X' => 667.0,
        'Y' => 667.0,
        'Z' => 611.0,
        '[' | ']' => 278.0,
        '\\' => 278.0,
        '^' => 469.0,
        '_' => 556.0,
        '`' => 333.0,
        'a' => 556.0,
        'b' => 556.0,
        'c' => 500.0,
        'd' => 556.0,
        'e' => 556.0,
        'f' => 278.0,
        'g' => 556.0,
        'h' => 556.0,
        'i' => 222.0,
        'j' => 222.0,
        'k' => 500.0,
        'l' => 222.0,
        'm' => 833.0,
        'n' => 556.0,
        'o' => 556.0,
        'p' => 556.0,
        'q' => 556.0,
        'r' => 333.0,
        's' => 500.0,
        't' => 278.0,
        'u' => 556.0,
        'v' => 500.0,
        'w' => 722.0,
        'x' => 500.0,
        'y' => 500.0,
        'z' => 500.0,
        '{' | '}' => 334.0,
        '|' => 260.0,
        '~' => 584.0,
        _ => 556.0,
    }
}

fn text_box_character_width(character: char, font_size: f64) -> f64 {
    let glyph_width = if character == '\t' {
        4.0 * helvetica_char_width(' ')
    } else {
        helvetica_char_width(character)
    };
    glyph_width * font_size / 1_000.0
}

#[cfg(test)]
pub(crate) fn free_text_line_width(line: &str, font_size: f64) -> f64 {
    line.chars()
        .map(|character| text_box_character_width(character, font_size))
        .sum()
}

fn wrap_free_text_line(line: &str, width: f64, font_size: f64) -> Vec<String> {
    if line.is_empty() {
        return vec![String::new()];
    }

    let characters = line.chars().collect::<Vec<_>>();
    let mut lines = Vec::new();
    let mut start = 0usize;
    while start < characters.len() {
        let mut end = start;
        let mut line_width = 0.0;
        let mut last_break = None;
        while end < characters.len() {
            let character = characters[end];
            let character_width = text_box_character_width(character, font_size);
            if end > start && line_width + character_width > width {
                break;
            }
            line_width += character_width;
            end += 1;
            if character.is_whitespace() {
                last_break = Some(end);
            }
        }
        if end == characters.len() {
            lines.push(characters[start..end].iter().collect());
            break;
        }

        let split_at = last_break
            .filter(|break_at| *break_at > start)
            .unwrap_or(end.max(start + 1));
        let mut output_end = split_at;
        while output_end > start && characters[output_end - 1].is_whitespace() {
            output_end -= 1;
        }
        lines.push(characters[start..output_end].iter().collect());
        start = split_at;
        while start < characters.len() && characters[start].is_whitespace() {
            start += 1;
        }
    }
    lines
}

pub(crate) fn wrap_free_text_lines(text: &str, width: f64, font_size: f64) -> Vec<String> {
    text.split('\n')
        .flat_map(|line| wrap_free_text_line(line, width, font_size))
        .collect()
}

fn build_text_box_appearance(
    document: &mut Document,
    editor: &TextBoxMutation,
    rect: PdfRect,
) -> Result<ObjectId> {
    const LINE_FACTOR: f64 = 1.35;
    const LINE_DESCENT_FACTOR: f64 = 0.35;
    let mut width = rect.width();
    let mut height = rect.height();
    if editor.rotation % 180 != 0 {
        std::mem::swap(&mut width, &mut height);
    }
    let line_ascent = (LINE_FACTOR - LINE_DESCENT_FACTOR) * editor.font_size;
    let (matrix, clip_box, first_point): ([f64; 4], [f64; 4], [f64; 2]) = match editor.rotation {
        0 => (
            [1.0, 0.0, 0.0, 1.0],
            [rect.x1, rect.y1, width, height],
            [rect.x1, rect.y2 - line_ascent],
        ),
        90 => (
            [0.0, 1.0, -1.0, 0.0],
            [rect.y1, -rect.x2, width, height],
            [rect.y1, -rect.x1 - line_ascent],
        ),
        180 => (
            [-1.0, 0.0, 0.0, -1.0],
            [-rect.x2, -rect.y2, width, height],
            [-rect.x2, -rect.y1 - line_ascent],
        ),
        270 => (
            [0.0, -1.0, 1.0, 0.0],
            [-rect.y2, rect.x1, width, height],
            [-rect.y2, rect.x2 - line_ascent],
        ),
        _ => return Err("Invalid FreeText editor rotation".into()),
    };
    let color = editor.color.map(|component| f64::from(component) / 255.0);
    let mut content = format!(
        "q\n{} {} {} {} 0 0 cm\n{} {} {} {} re W n\nBT\n{} {} {} rg\n0 Tc /Helv {} Tf\n{} {} Td",
        number_to_content(matrix[0]),
        number_to_content(matrix[1]),
        number_to_content(matrix[2]),
        number_to_content(matrix[3]),
        number_to_content(clip_box[0]),
        number_to_content(clip_box[1]),
        number_to_content(clip_box[2]),
        number_to_content(clip_box[3]),
        number_to_content(color[0]),
        number_to_content(color[1]),
        number_to_content(color[2]),
        number_to_content(editor.font_size),
        number_to_content(first_point[0]),
        number_to_content(first_point[1]),
    );
    for (index, line) in wrap_free_text_lines(&editor.text, width, editor.font_size)
        .iter()
        .enumerate()
    {
        if index > 0 {
            content.push_str(&format!(
                "\n0 -{} Td",
                number_to_content(LINE_FACTOR * editor.font_size)
            ));
        }
        content.push_str(&format!(
            "\n({}) Tj",
            escape_free_text_appearance_line(line)
        ));
    }
    content.push_str("\nET\nQ");

    let mut font = Dictionary::new();
    font.set("Type", Object::Name(b"Font".to_vec()));
    font.set("Subtype", Object::Name(b"Type1".to_vec()));
    font.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
    font.set("Encoding", Object::Name(b"WinAnsiEncoding".to_vec()));
    let mut fonts = Dictionary::new();
    fonts.set("Helv", Object::Dictionary(font));
    let mut resources = Dictionary::new();
    resources.set("Font", Object::Dictionary(fonts));
    let mut stream_dict = Dictionary::new();
    stream_dict.set("Type", Object::Name(b"XObject".to_vec()));
    stream_dict.set("Subtype", Object::Name(b"Form".to_vec()));
    stream_dict.set("FormType", Object::Integer(1));
    stream_dict.set("BBox", rect_object(rect));
    stream_dict.set("Resources", Object::Dictionary(resources));
    stream_dict.set(
        "Matrix",
        Object::Array(vec![
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(1),
            number_object(-rect.x1),
            number_object(-rect.y1),
        ]),
    );
    Ok(document.add_object(Stream::new(stream_dict, content.into_bytes())))
}

fn existing_text_box_values(
    document: &impl PdfObjectSource,
    annotation_ref: ObjectId,
) -> Result<(Option<Dictionary>, Option<Vec<u8>>)> {
    let dict = document.dictionary(annotation_ref)?;
    let appearance = dict
        .get(b"AP")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_dict().ok())
        .cloned();
    let default_appearance = dict
        .get(b"DA")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_str().ok())
        .map(ToOwned::to_owned);
    Ok((appearance, default_appearance))
}

fn appearance_with_normal_stream(mut appearance: Dictionary, appearance_ref: ObjectId) -> Object {
    appearance.set("N", Object::Reference(appearance_ref));
    Object::Dictionary(appearance)
}

pub(crate) fn tokenize_default_appearance(bytes: &[u8]) -> Vec<(usize, usize)> {
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let start = index;
        match bytes[index] {
            b'(' => {
                index += 1;
                let mut depth = 1usize;
                while index < bytes.len() && depth > 0 {
                    match bytes[index] {
                        b'\\' => index = index.saturating_add(2).min(bytes.len()),
                        b'(' => {
                            depth += 1;
                            index += 1;
                        }
                        b')' => {
                            depth = depth.saturating_sub(1);
                            index += 1;
                        }
                        _ => index += 1,
                    }
                }
            }
            b'<' => {
                index += 1;
                while index < bytes.len() && bytes[index] != b'>' {
                    index += 1;
                }
                if index < bytes.len() {
                    index += 1;
                }
            }
            b'[' | b']' | b'>' => index += 1,
            _ => {
                while index < bytes.len()
                    && !bytes[index].is_ascii_whitespace()
                    && !matches!(bytes[index], b'[' | b']' | b'<' | b'>')
                {
                    index += 1;
                }
            }
        }
        tokens.push((start, index));
    }
    tokens
}

fn patch_default_appearance(existing: Option<&[u8]>, font_size: f64, color: [f64; 3]) -> Vec<u8> {
    let mut bytes = existing.unwrap_or_default().to_vec();
    let tokens = tokenize_default_appearance(&bytes);
    let mut replacements = Vec::<(usize, usize, Vec<u8>)>::new();
    let mut replaced_tf = false;
    let mut replaced_rg = false;
    for (index, &(start, end)) in tokens.iter().enumerate() {
        let token = &bytes[start..end];
        if token == b"Tf" {
            if let Some(&(size_start, size_end)) = index.checked_sub(1).and_then(|i| tokens.get(i))
            {
                let is_finite_number = std::str::from_utf8(&bytes[size_start..size_end])
                    .ok()
                    .and_then(|value| value.parse::<f64>().ok())
                    .is_some_and(f64::is_finite);
                if !is_finite_number {
                    continue;
                }
                replacements.push((
                    size_start,
                    size_end,
                    number_to_content(font_size).into_bytes(),
                ));
                replaced_tf = true;
            }
        } else if token == b"rg" {
            if let Some(first) = index.checked_sub(3) {
                let operands_are_numbers = tokens[first..index].iter().all(|&(start, end)| {
                    std::str::from_utf8(&bytes[start..end])
                        .ok()
                        .and_then(|value| value.parse::<f64>().ok())
                        .is_some_and(f64::is_finite)
                });
                if operands_are_numbers {
                    for (component, token_index) in color.into_iter().zip(first..index) {
                        let (start, end) = tokens[token_index];
                        replacements.push((start, end, number_to_content(component).into_bytes()));
                    }
                    replaced_rg = true;
                }
            }
        }
    }
    if replacements.is_empty() {
        bytes.extend_from_slice(
            format!(
                " /Helv {} Tf {} {} {} rg",
                number_to_content(font_size),
                number_to_content(color[0]),
                number_to_content(color[1]),
                number_to_content(color[2]),
            )
            .as_bytes(),
        );
        return bytes;
    }
    replacements.sort_unstable_by_key(|(start, _, _)| *start);
    for (start, end, replacement) in replacements.into_iter().rev() {
        bytes.splice(start..end, replacement);
    }
    if !replaced_tf {
        bytes.extend_from_slice(format!(" /Helv {} Tf", number_to_content(font_size)).as_bytes());
    }
    if !replaced_rg {
        bytes.extend_from_slice(
            format!(
                " {} {} {} rg",
                number_to_content(color[0]),
                number_to_content(color[1]),
                number_to_content(color[2]),
            )
            .as_bytes(),
        );
    }
    bytes
}

#[allow(clippy::too_many_arguments)]
fn set_text_box_fields(
    dict: &mut Dictionary,
    editor: &TextBoxMutation,
    name: &str,
    rect: PdfRect,
    modified_at: &str,
    appearance_ref: ObjectId,
    is_new: bool,
    existing_appearance: Option<Dictionary>,
    existing_default_appearance: Option<Vec<u8>>,
) {
    dict.set("Rect", rect_object(rect));
    dict.set(
        "Contents",
        Object::String(
            encode_pdf_text_string(&editor.text),
            StringFormat::Hexadecimal,
        ),
    );
    let effective_modified_at = shape_pdf_date(editor.modified_at, modified_at);
    dict.set(
        "M",
        Object::string_literal(effective_modified_at.into_bytes()),
    );
    if read_annotation_name(dict).is_none() {
        write_annotation_name(dict, name);
    }
    if is_new {
        dict.set(
            "Border",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(0),
            ]),
        );
    }
    dict.set("Rotate", Object::Integer(i64::from(editor.rotation)));
    let color = editor.color.map(|component| f64::from(component) / 255.0);
    let default_appearance = if is_new {
        format!(
            "/Helv {} Tf {} {} {} rg",
            number_to_content(editor.font_size),
            number_to_content(color[0]),
            number_to_content(color[1]),
            number_to_content(color[2]),
        )
        .into_bytes()
    } else {
        patch_default_appearance(
            existing_default_appearance.as_deref(),
            editor.font_size,
            color,
        )
    };
    dict.set("DA", Object::string_literal(default_appearance));
    dict.set(
        "AP",
        appearance_with_normal_stream(existing_appearance.unwrap_or_default(), appearance_ref),
    );
    if is_new || editor.author.is_some() {
        dict.set(
            "T",
            Object::String(
                encode_pdf_text_string(editor.author.as_deref().unwrap_or("")),
                StringFormat::Hexadecimal,
            ),
        );
    }
    if is_new || editor.created_at.is_some() {
        dict.set(
            "CreationDate",
            Object::string_literal(shape_pdf_date(editor.created_at, modified_at).into_bytes()),
        );
    }
}

#[allow(dead_code)]
pub(crate) fn ensure_free_text_annotation_fields(
    document: &mut Document,
    annot_id: ObjectId,
    popup_ref: Option<ObjectId>,
    note: &FreeTextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
    blank_ap_ref: &mut Option<ObjectId>,
) -> Result<Option<ObjectId>> {
    let popup_ref = match popup_ref {
        Some(popup_id) => Some(popup_id),
        None => Some(document.new_object_id()),
    };
    let ap_ref = get_or_create_blank_appearance_ref(document, blank_ap_ref);
    {
        let annot_dict = document.get_dictionary_mut(annot_id)?;
        set_free_text_annotation_fields(
            annot_dict,
            note,
            note_name,
            pdf_rect,
            modified_at,
            ap_ref,
            popup_ref,
        );
    }
    if let Some(popup_id) = popup_ref {
        if document.get_object(popup_id).is_err() {
            let popup_dict = build_popup_annotation_dict(note, pdf_rect, modified_at, annot_id);
            document.set_object(popup_id, Object::Dictionary(popup_dict));
        } else if let Ok(popup_dict) = document.get_dictionary_mut(popup_id) {
            set_popup_annotation_fields(popup_dict, note, pdf_rect, modified_at, annot_id);
        }
    }
    Ok(popup_ref)
}

/// Populate the fields owned by the canonical sticky-note writer. The
/// caller owns the page and Popup references, so this helper deliberately
/// leaves those keys alone.
pub(crate) fn set_text_note_annotation_fields(
    dict: &mut Dictionary,
    note: &TextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
) {
    dict.set("Subtype", Object::Name(b"Text".to_vec()));
    dict.set("Name", Object::Name(b"Note".to_vec()));
    dict.set("F", Object::Integer(4));
    dict.set("Rect", rect_object(pdf_rect));
    dict.set(
        "Contents",
        Object::String(
            encode_pdf_text_string(&note.text),
            StringFormat::Hexadecimal,
        ),
    );
    dict.set(
        "T",
        Object::String(
            encode_pdf_text_string(note.author.as_deref().unwrap_or("")),
            StringFormat::Hexadecimal,
        ),
    );
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
    if dict
        .get(b"CreationDate")
        .ok()
        .and_then(pdf_string_to_text)
        .is_none()
    {
        let created_at = shape_pdf_date(note.created_at, modified_at);
        dict.set(
            "CreationDate",
            Object::string_literal(created_at.into_bytes()),
        );
    }
    if read_annotation_name(dict).is_none() {
        write_annotation_name(dict, note_name);
    }
    set_rgb_color(dict, "C", note.color.as_deref());
    dict.set("Open", Object::Boolean(false));
}

pub(crate) fn build_text_note_annotation_dict(
    note: &TextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
) -> Dictionary {
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Annot".to_vec()));
    set_text_note_annotation_fields(&mut dict, note, note_name, pdf_rect, modified_at);
    dict
}

/// Convert the legacy marker representation in place. Only fields owned by
/// the representation change. Replies, `/NM`, Popup links, and foreign keys
/// remain untouched.
pub(crate) fn convert_free_text_marker_to_text(
    dict: &mut Dictionary,
    pdf_rect: PdfRect,
    modified_at: &str,
) {
    let creation_date = dict
        .get(b"CreationDate")
        .ok()
        .and_then(pdf_string_to_text)
        .or_else(|| dict.get(b"M").ok().and_then(pdf_string_to_text))
        .unwrap_or_else(|| modified_at.to_string());
    dict.set("Subtype", Object::Name(b"Text".to_vec()));
    dict.set("Name", Object::Name(b"Note".to_vec()));
    dict.set("F", Object::Integer(4));
    dict.set("Rect", rect_object(pdf_rect));
    dict.set(
        "CreationDate",
        Object::string_literal(creation_date.into_bytes()),
    );
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
    dict.remove(b"AP");
    dict.remove(b"DA");
}

#[allow(dead_code)]
pub(crate) fn ensure_free_text_incremental_annotation_fields(
    incremental: &mut IncrementalDocument,
    annot_id: ObjectId,
    popup_ref: Option<ObjectId>,
    note: &FreeTextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
    blank_ap_ref: &mut Option<ObjectId>,
) -> Result<Option<ObjectId>> {
    let popup_ref = match popup_ref {
        Some(popup_id) => {
            if incremental
                .get_prev_documents()
                .get_object(popup_id)
                .is_ok()
            {
                incremental.opt_clone_object_to_new_document(popup_id)?;
            }
            Some(popup_id)
        }
        None => Some(incremental.new_document.new_object_id()),
    };
    let ap_ref = get_or_create_blank_appearance_ref(&mut incremental.new_document, blank_ap_ref);
    {
        let annot_dict = incremental.new_document.get_dictionary_mut(annot_id)?;
        set_free_text_annotation_fields(
            annot_dict,
            note,
            note_name,
            pdf_rect,
            modified_at,
            ap_ref,
            popup_ref,
        );
    }
    if let Some(popup_id) = popup_ref {
        if incremental.new_document.get_object(popup_id).is_err() {
            let popup_dict = build_popup_annotation_dict(note, pdf_rect, modified_at, annot_id);
            incremental
                .new_document
                .set_object(popup_id, Object::Dictionary(popup_dict));
        } else if let Ok(popup_dict) = incremental.new_document.get_dictionary_mut(popup_id) {
            set_popup_annotation_fields(popup_dict, note, pdf_rect, modified_at, annot_id);
        }
    }
    Ok(popup_ref)
}

#[allow(dead_code)]
pub(crate) fn build_free_text_annotation_dict(
    note: &FreeTextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
    ap_ref: ObjectId,
    popup_ref: Option<ObjectId>,
) -> Dictionary {
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Annot".to_vec()));
    dict.set("Subtype", Object::Name(b"FreeText".to_vec()));
    dict.set("F", Object::Integer(4));
    set_free_text_annotation_fields(
        &mut dict,
        note,
        note_name,
        pdf_rect,
        modified_at,
        ap_ref,
        popup_ref,
    );
    dict
}

#[allow(dead_code)]
pub(crate) fn set_free_text_annotation_fields(
    dict: &mut Dictionary,
    note: &FreeTextNote,
    note_name: &str,
    pdf_rect: PdfRect,
    modified_at: &str,
    ap_ref: ObjectId,
    popup_ref: Option<ObjectId>,
) {
    dict.set("Rect", rect_object(pdf_rect));
    dict.set(
        "Contents",
        Object::String(
            encode_pdf_text_string(&note.text),
            StringFormat::Hexadecimal,
        ),
    );
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
    dict.set(
        "T",
        Object::String(
            encode_pdf_text_string(note.author.as_deref().unwrap_or("")),
            StringFormat::Hexadecimal,
        ),
    );
    let mut ap_dict = Dictionary::new();
    ap_dict.set("N", Object::Reference(ap_ref));
    dict.set("AP", Object::Dictionary(ap_dict));
    dict.set(
        "NM",
        Object::String(encode_pdf_text_string(note_name), StringFormat::Hexadecimal),
    );
    if let Some(popup_id) = popup_ref {
        dict.set("Popup", Object::Reference(popup_id));
    }
    set_rgb_color(dict, "C", note.color.as_deref());
    set_rgb_color(dict, "IC", note.color.as_deref());
}

pub(crate) fn build_popup_annotation_dict(
    note: &FreeTextNote,
    pdf_rect: PdfRect,
    modified_at: &str,
    parent_ref: ObjectId,
) -> Dictionary {
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Annot".to_vec()));
    dict.set("Subtype", Object::Name(b"Popup".to_vec()));
    dict.set("F", Object::Integer(28));
    set_popup_annotation_fields(&mut dict, note, pdf_rect, modified_at, parent_ref);
    dict
}

pub(crate) fn set_popup_annotation_fields(
    dict: &mut Dictionary,
    note: &FreeTextNote,
    pdf_rect: PdfRect,
    modified_at: &str,
    parent_ref: ObjectId,
) {
    dict.set("Parent", Object::Reference(parent_ref));
    dict.set("Rect", rect_object(pdf_rect));
    dict.set(
        "Contents",
        Object::String(
            encode_pdf_text_string(&note.text),
            StringFormat::Hexadecimal,
        ),
    );
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
    dict.set(
        "T",
        Object::String(
            encode_pdf_text_string(note.author.as_deref().unwrap_or("")),
            StringFormat::Hexadecimal,
        ),
    );
}

#[allow(dead_code)]
pub(crate) fn get_or_create_blank_appearance_ref(
    document: &mut Document,
    blank_ap_ref: &mut Option<ObjectId>,
) -> ObjectId {
    if let Some(object_id) = *blank_ap_ref {
        return object_id;
    }

    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Form".to_vec()));
    dict.set(
        "BBox",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(0),
        ]),
    );
    dict.set(
        "Matrix",
        Object::Array(vec![
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
        ]),
    );
    dict.set("Resources", Object::Dictionary(Dictionary::new()));
    let object_id = document.add_object(Stream::new(dict, Vec::new()));
    *blank_ap_ref = Some(object_id);
    object_id
}

pub(crate) fn replayable_free_text_note_name_from_parts(
    stable_key: &str,
    _created_at: Option<u64>,
) -> String {
    stable_key.trim().to_string()
}

pub(crate) fn replayable_free_text_note_name(note: &FreeTextNote) -> String {
    replayable_free_text_note_name_from_parts(&note.stable_key, note.created_at)
}

pub(crate) struct PageAnnotationIndex {
    annots: Vec<Object>,
    annotation_refs: HashSet<ObjectId>,
    first_text_note_by_name: HashMap<String, ObjectId>,
    named_text_notes: Vec<(ObjectId, String)>,
    first_free_text_by_name: HashMap<String, ObjectId>,
    named_free_text: Vec<(ObjectId, String)>,
    dirty: bool,
}

impl PageAnnotationIndex {
    fn first_text_note_named(&self, note_name: &str) -> Option<ObjectId> {
        self.first_text_note_by_name
            .get(note_name)
            .copied()
            .or_else(|| {
                self.named_text_notes.iter().find_map(|(object_id, name)| {
                    text_note_names_match(name, note_name).then_some(*object_id)
                })
            })
    }

    fn first_free_text_named(&self, note_name: &str) -> Option<ObjectId> {
        self.first_free_text_by_name
            .get(note_name)
            .copied()
            .or_else(|| {
                self.named_free_text.iter().find_map(|(object_id, name)| {
                    annotation_names_match(name, note_name, &["evb-freetext:"])
                        .then_some(*object_id)
                })
            })
    }

    pub(crate) fn append_missing_refs(&mut self, refs: &[ObjectId]) {
        for object_id in refs {
            if self.annotation_refs.insert(*object_id) {
                self.annots.push(Object::Reference(*object_id));
                self.dirty = true;
            }
        }
    }

    #[allow(dead_code)]
    fn append_free_text(&mut self, note_name: &str, annot_ref: ObjectId, popup_ref: ObjectId) {
        self.first_free_text_by_name
            .entry(note_name.to_string())
            .or_insert(annot_ref);
        self.named_free_text
            .push((annot_ref, note_name.to_string()));
        self.append_missing_refs(&[annot_ref, popup_ref]);
    }

    fn append_text_note(&mut self, note_name: &str, annot_ref: ObjectId, popup_ref: ObjectId) {
        self.first_text_note_by_name
            .entry(note_name.to_string())
            .or_insert(annot_ref);
        self.named_text_notes
            .push((annot_ref, note_name.to_string()));
        self.append_missing_refs(&[annot_ref, popup_ref]);
    }

    fn append_free_text_without_popup(&mut self, name: &str, annot_ref: ObjectId) {
        self.first_free_text_by_name
            .entry(name.to_string())
            .or_insert(annot_ref);
        self.named_free_text.push((annot_ref, name.to_string()));
        self.append_missing_refs(&[annot_ref]);
    }

    fn matching_stable_delete_refs(&self, delete: &AnnotationDelete) -> Vec<ObjectId> {
        let Some(stable_key) = delete.stable_key.as_deref().map(str::trim) else {
            return Vec::new();
        };
        if stable_key.is_empty() {
            return Vec::new();
        }
        let requested_name =
            replayable_free_text_note_name_from_parts(stable_key, delete.created_at);
        self.named_text_notes
            .iter()
            .chain(self.named_free_text.iter())
            .filter_map(|(object_id, note_name)| {
                let matches =
                    text_note_delete_name_matches(note_name, &requested_name, delete.created_at)
                        || annotation_names_match(note_name, &requested_name, &["evb-freetext:"]);
                matches.then_some(*object_id)
            })
            .collect()
    }
}

pub(crate) fn build_page_annotation_index(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
) -> Result<(PageAnnotationIndex, usize)> {
    let annots = get_page_annots(document, page_id)?;
    let mut annotation_refs = HashSet::new();
    let mut first_text_note_by_name = HashMap::new();
    let mut named_text_notes = Vec::new();
    let mut first_free_text_by_name = HashMap::new();
    let mut named_free_text = Vec::new();
    let mut page_geometry = None;
    let mut scanned = 0usize;
    for object in &annots {
        scanned += 1;
        let Ok(object_id) = object.as_reference() else {
            continue;
        };
        annotation_refs.insert(object_id);
        let Ok(dictionary) = document.dictionary(object_id) else {
            continue;
        };
        let subtype = annotation_subtype(dictionary);
        let marker_form =
            if subtype == "freetext" && annotation_related_ref(dictionary, b"Popup").is_some() {
                let geometry = page_geometry.get_or_insert_with(|| {
                    resolve_page_view(document, page_id).and_then(|page_view| {
                        resolve_page_rotation(document, page_id)
                            .map(|page_rotation| (page_view, page_rotation))
                    })
                });
                geometry.as_ref().is_ok_and(|(page_view, page_rotation)| {
                    is_free_text_note_marker(document, dictionary, *page_view, *page_rotation)
                })
            } else {
                false
            };
        if subtype == "text" || marker_form {
            if annotation_related_ref(dictionary, b"IRT").is_some() {
                continue;
            }
            let Some(note_name) = read_annotation_name(dictionary) else {
                continue;
            };
            first_text_note_by_name
                .entry(note_name.clone())
                .or_insert(object_id);
            named_text_notes.push((object_id, note_name));
            continue;
        }
        if subtype != "freetext" {
            continue;
        }
        let Some(note_name) = read_annotation_name(dictionary) else {
            continue;
        };
        first_free_text_by_name
            .entry(note_name.clone())
            .or_insert(object_id);
        named_free_text.push((object_id, note_name));
    }
    Ok((
        PageAnnotationIndex {
            annots,
            annotation_refs,
            first_text_note_by_name,
            named_text_notes,
            first_free_text_by_name,
            named_free_text,
            dirty: false,
        },
        scanned,
    ))
}

pub(crate) fn build_incremental_page_annotation_index(
    incremental: &IncrementalDocument,
    page_id: ObjectId,
) -> Result<(PageAnnotationIndex, usize)> {
    build_page_annotation_index(&AppendedRevision::new(incremental), page_id)
}

pub(crate) fn write_page_annotation_index(
    document: &mut Document,
    page_id: ObjectId,
    index: PageAnnotationIndex,
) -> Result<()> {
    if index.dirty {
        document
            .get_dictionary_mut(page_id)?
            .set("Annots", Object::Array(index.annots));
    }
    Ok(())
}

pub(crate) fn write_page_annotation_index_incremental(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
    index: PageAnnotationIndex,
) -> Result<()> {
    if index.dirty {
        incremental.opt_clone_object_to_new_document(page_id)?;
        incremental
            .new_document
            .get_dictionary_mut(page_id)?
            .set("Annots", Object::Array(index.annots));
    }
    Ok(())
}

pub(crate) fn get_page_annots(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
) -> Result<Vec<Object>> {
    let page = document.dictionary(page_id)?;
    let annots = match page.get(b"Annots") {
        Ok(object) => object,
        Err(_) => return Ok(Vec::new()),
    };
    let resolved = document.resolved(annots)?;
    Ok(resolved.as_array().cloned().unwrap_or_default())
}

pub(crate) fn append_annots_to_page(
    document: &mut Document,
    page_id: ObjectId,
    refs: &[ObjectId],
) -> Result<()> {
    let mut annots = get_page_annots(document, page_id)?;
    annots.extend(refs.iter().copied().map(Object::Reference));
    let page = document.get_dictionary_mut(page_id)?;
    page.set("Annots", Object::Array(annots));
    Ok(())
}

pub(crate) fn append_annots_to_page_incremental(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
    refs: &[ObjectId],
) -> Result<()> {
    incremental.opt_clone_object_to_new_document(page_id)?;
    let mut annots = match get_page_annots(&incremental.new_document, page_id) {
        Ok(annots) => annots,
        Err(_) => get_page_annots(incremental.get_prev_documents(), page_id)?,
    };
    annots.extend(refs.iter().copied().map(Object::Reference));
    let page = incremental.new_document.get_dictionary_mut(page_id)?;
    page.set("Annots", Object::Array(annots));
    Ok(())
}

pub(crate) fn collect_annotation_refs_to_delete(
    document: &impl PdfObjectSource,
    target_id: ObjectId,
    // Callers that already have the owning page's `/Annots` list provide it
    // for annotations without a `/P` back-reference. This keeps reply
    // discovery page-local without walking the document's page tree.
    page_annots_hint: Option<&[Object]>,
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
    let owner_page_annots = annotation_page_id(document, target_id)
        .map(|page_id| get_page_annots(document, page_id))
        .transpose()?;
    let page_annots = owner_page_annots.as_deref().or(page_annots_hint);
    let replies_by_parent = page_annots.map(|page_annots| {
        let mut replies_by_parent: HashMap<ObjectId, Vec<ObjectId>> = HashMap::new();
        for reply_id in page_annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
        {
            let Ok(reply_dict) = document.dictionary(reply_id) else {
                continue;
            };
            if annotation_subtype(reply_dict) != "popup" {
                if let Some(parent_id) = annotation_related_ref(reply_dict, b"IRT") {
                    replies_by_parent
                        .entry(parent_id)
                        .or_default()
                        .push(reply_id);
                }
            }
        }
        replies_by_parent
    });
    while let Some(object_id) = pending.pop() {
        if !seen.insert(object_id) {
            continue;
        }
        refs.push(object_id);

        let dict = match document.dictionary(object_id) {
            Ok(dict) => dict,
            Err(_) => continue,
        };
        if annotation_subtype(dict) == "stamp"
            && is_managed_placed_image_stamp(dict)
            && placed_image_appearance_refs(document, object_id).is_some()
        {
            if let Ok(appearance) = dict.get(b"AP") {
                if let Some(appearance_dict) = document
                    .resolved(appearance)
                    .ok()
                    .and_then(|value| value.as_dict().ok())
                {
                    if let Some(appearance_id) = annotation_related_ref(appearance_dict, b"N") {
                        pending.push(appearance_id);
                        if let Ok(Object::Stream(appearance_stream)) =
                            document.object(appearance_id)
                        {
                            if let Some(resources) = appearance_stream
                                .dict
                                .get(b"Resources")
                                .ok()
                                .and_then(|value| document.resolved(value).ok())
                                .and_then(|value| value.as_dict().ok())
                            {
                                if let Some(xobjects) = resources
                                    .get(b"XObject")
                                    .ok()
                                    .and_then(|value| document.resolved(value).ok())
                                    .and_then(|value| value.as_dict().ok())
                                {
                                    pending.extend(
                                        xobjects
                                            .iter()
                                            .filter_map(|(_, value)| value.as_reference().ok()),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
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
        if let Some(reply_ids) = replies_by_parent
            .as_ref()
            .and_then(|replies| replies.get(&object_id))
        {
            pending.extend(reply_ids.iter().copied());
        }
    }

    Ok(refs)
}

/// Return the page that owns an annotation when the annotation carries the
/// optional PDF `/P` back-reference. This is the authoritative owner for
/// explicit object-reference deletes, even when the request's page hint is
/// stale or points at another page.
pub(crate) fn annotation_page_id(
    document: &impl PdfObjectSource,
    annotation_id: ObjectId,
) -> Option<ObjectId> {
    let annotation = document.dictionary(annotation_id).ok()?;
    let page = annotation.get(b"P").ok()?;
    page.as_reference().ok()
}

pub(crate) fn annotation_matches_stable_delete_name(
    document: &impl PdfObjectSource,
    object_id: ObjectId,
    delete: &AnnotationDelete,
) -> Result<bool> {
    let stable_key = match delete.stable_key.as_deref().map(str::trim) {
        Some(stable_key) if !stable_key.is_empty() => stable_key,
        _ => return Ok(false),
    };
    let dict = match document.dictionary(object_id) {
        Ok(dict) => dict,
        Err(_) => return Ok(false),
    };
    let target_dict = if annotation_subtype(dict) == "popup" {
        match annotation_related_ref(dict, b"Parent") {
            Some(parent_id) => match document.dictionary(parent_id) {
                Ok(parent_dict) => parent_dict,
                Err(_) => return Ok(false),
            },
            None => return Ok(false),
        }
    } else {
        dict
    };
    let target_subtype = annotation_subtype(target_dict);
    if target_subtype != "text" && target_subtype != "freetext" {
        return Ok(false);
    }
    let Some(note_name) = read_annotation_name(target_dict) else {
        return Ok(false);
    };
    let requested_name = replayable_free_text_note_name_from_parts(stable_key, delete.created_at);
    Ok(
        text_note_delete_name_matches(&note_name, &requested_name, delete.created_at)
            || annotation_names_match(&note_name, &requested_name, &["evb-freetext:"]),
    )
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

fn resolve_annotation_delete_page_ids(
    document: &impl PdfObjectSource,
    deletes: &[AnnotationDelete],
    refs_to_delete: &HashSet<ObjectId>,
    page_resolver: &PageTreeResolver,
) -> Result<Vec<ObjectId>> {
    let mut page_ids = HashSet::new();
    for delete in deletes {
        let page_number = delete
            .page_index
            .checked_add(1)
            .ok_or("Invalid annotation delete page index")?;
        page_ids.insert(page_resolver.page_id(document, page_number)?);
    }

    // Related popup/parent annotations can carry their own page reference.
    // Include those pages when the source provides one, while keeping the
    // mutation bounded by the object references already named by the delete.
    for object_id in refs_to_delete {
        if let Some(page_id) = annotation_page_id(document, *object_id) {
            page_ids.insert(page_id);
        }
    }

    Ok(page_ids.into_iter().collect())
}

pub(crate) fn collect_delete_refs(
    document: &Document,
    deletes: &[AnnotationDelete],
    page_resolver: &PageTreeResolver,
) -> Result<HashSet<ObjectId>> {
    let mut refs_to_delete = HashSet::new();
    let mut annotation_indexes = HashMap::new();
    for delete in deletes {
        let page_number = delete
            .page_index
            .checked_add(1)
            .ok_or("Invalid annotation delete page index")?;
        let page_id = page_resolver.page_id(document, page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            entry.insert(build_page_annotation_index(document, page_id)?.0);
        }
        let index = annotation_indexes
            .get(&page_id)
            .expect("Annotation-delete pages are indexed before lookup");
        let target_refs = if let (Some(object_number), Some(generation_number)) =
            (delete.object_number, delete.generation_number)
        {
            vec![(object_number, generation_number)]
        } else {
            resolve_annotation_delete_target_refs_from_index(index, delete)?
        };
        for target_id in target_refs {
            for object_id in
                collect_annotation_refs_to_delete(document, target_id, Some(&index.annots))?
            {
                refs_to_delete.insert(object_id);
            }
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

    let page_resolver = PageTreeResolver::new(document)?;
    let refs_to_delete = collect_delete_refs(document, deletes, &page_resolver)?;
    let page_ids =
        resolve_annotation_delete_page_ids(document, deletes, &refs_to_delete, &page_resolver)?;
    let mut removed_any = false;
    for page_id in page_ids {
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

    let page_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
    let refs_to_delete =
        collect_delete_refs(incremental.get_prev_documents(), deletes, &page_resolver)?;
    let page_ids = resolve_annotation_delete_page_ids(
        incremental.get_prev_documents(),
        deletes,
        &refs_to_delete,
        &page_resolver,
    )?;
    let mut removed_any = false;
    for page_id in page_ids {
        let annots = get_page_annots(&incremental.new_document, page_id)
            .or_else(|_| get_page_annots(incremental.get_prev_documents(), page_id))?;
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

pub(crate) fn update_note_text_incremental(
    incremental: &mut IncrementalDocument,
    updates: &[NoteTextUpdate],
    modified_at: &str,
) -> Result<()> {
    let mut updated_count = 0;
    for update in updates {
        let target_id = (update.object_number, update.generation_number);
        if update_annotation_text_incremental_by_ref(
            incremental,
            target_id,
            &update.text,
            modified_at,
        )? {
            updated_count += 1;
        }
    }
    if updated_count != updates.len() {
        return Err(format!(
            "Updated {updated_count} of {} requested note annotation(s)",
            updates.len()
        )
        .into());
    }
    Ok(())
}

pub(crate) fn update_annotation_text_by_ref(
    document: &mut Document,
    target_id: ObjectId,
    text: &str,
    modified_at: &str,
) -> Result<bool> {
    let target = match resolve_note_target(document, target_id) {
        Ok(target) => target,
        Err(_) => return Ok(false),
    };
    if target.annotation_subtype == "freetext" {
        if let Some(page_id) = target.page_id {
            let page_view = resolve_page_view(document, page_id)?;
            let page_rotation = resolve_page_rotation(document, page_id)?;
            let marker_form = is_free_text_note_marker(
                document,
                document.get_dictionary(target.annotation_id)?,
                page_view,
                page_rotation,
            );
            if marker_form {
                if let Ok(pdf_rect) = text_note_pdf_rect_from_existing(
                    document,
                    document.get_dictionary(target.annotation_id)?,
                    page_view,
                    page_rotation,
                ) {
                    convert_free_text_marker_to_text(
                        document.get_dictionary_mut(target.annotation_id)?,
                        pdf_rect,
                        modified_at,
                    );
                }
            }
        }
    }

    if target.target_is_popup {
        set_annotation_object_contents(document, target.annotation_id, text, modified_at)?;
    }
    {
        let target_dict = document.get_dictionary_mut(target_id)?;
        set_annotation_dict_contents(target_dict, text, modified_at);
        if let Ok(Object::Dictionary(popup_dict)) = target_dict.get_mut(b"Popup") {
            set_annotation_dict_contents(popup_dict, text, modified_at);
        }
    }
    if let Some(popup_id) = target.popup_ref {
        if popup_id != target_id {
            set_annotation_object_contents(document, popup_id, text, modified_at)?;
        }
    }
    Ok(true)
}

pub(crate) fn update_annotation_text_incremental_by_ref(
    incremental: &mut IncrementalDocument,
    target_id: ObjectId,
    text: &str,
    modified_at: &str,
) -> Result<bool> {
    let target = match resolve_note_target(incremental.get_prev_documents(), target_id) {
        Ok(target) => target,
        Err(_) => return Ok(false),
    };
    if target.annotation_subtype == "freetext" {
        if let Some(page_id) = target.page_id {
            let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
            let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
            let marker_form = is_free_text_note_marker(
                incremental.get_prev_documents(),
                incremental
                    .get_prev_documents()
                    .get_dictionary(target.annotation_id)?,
                page_view,
                page_rotation,
            );
            if marker_form {
                if let Ok(pdf_rect) = text_note_pdf_rect_from_existing(
                    incremental.get_prev_documents(),
                    incremental
                        .get_prev_documents()
                        .get_dictionary(target.annotation_id)?,
                    page_view,
                    page_rotation,
                ) {
                    incremental.opt_clone_object_to_new_document(target.annotation_id)?;
                    convert_free_text_marker_to_text(
                        incremental
                            .new_document
                            .get_dictionary_mut(target.annotation_id)?,
                        pdf_rect,
                        modified_at,
                    );
                }
            }
        }
    }

    if target.target_is_popup {
        set_annotation_incremental_object_contents(
            incremental,
            target.annotation_id,
            text,
            modified_at,
        )?;
    }
    incremental.opt_clone_object_to_new_document(target_id)?;
    {
        let target_dict = incremental.new_document.get_dictionary_mut(target_id)?;
        set_annotation_dict_contents(target_dict, text, modified_at);
        if let Ok(Object::Dictionary(popup_dict)) = target_dict.get_mut(b"Popup") {
            set_annotation_dict_contents(popup_dict, text, modified_at);
        }
    }
    if let Some(popup_id) = target.popup_ref {
        if popup_id != target_id {
            set_annotation_incremental_object_contents(incremental, popup_id, text, modified_at)?;
        }
    }
    Ok(true)
}

pub(crate) fn set_annotation_object_contents(
    document: &mut Document,
    object_id: ObjectId,
    text: &str,
    modified_at: &str,
) -> Result<()> {
    if let Ok(dict) = document.get_dictionary_mut(object_id) {
        set_annotation_dict_contents(dict, text, modified_at);
    }
    Ok(())
}

pub(crate) fn set_annotation_incremental_object_contents(
    incremental: &mut IncrementalDocument,
    object_id: ObjectId,
    text: &str,
    modified_at: &str,
) -> Result<()> {
    if incremental
        .get_prev_documents()
        .get_dictionary(object_id)
        .is_err()
    {
        return Ok(());
    }
    incremental.opt_clone_object_to_new_document(object_id)?;
    let dict = incremental.new_document.get_dictionary_mut(object_id)?;
    set_annotation_dict_contents(dict, text, modified_at);
    Ok(())
}

pub(crate) fn set_annotation_dict_contents(dict: &mut Dictionary, text: &str, modified_at: &str) {
    dict.set(
        "Contents",
        Object::String(encode_pdf_text_string(text), StringFormat::Hexadecimal),
    );
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
}

pub(crate) fn pdf_string_to_text(object: &Object) -> Option<String> {
    let bytes = object.as_str().ok()?;
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let mut units = Vec::with_capacity((bytes.len() - 2) / 2);
        for chunk in bytes[2..].chunks_exact(2) {
            units.push(u16::from_be_bytes([chunk[0], chunk[1]]));
        }
        return String::from_utf16(&units).ok();
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

pub(crate) fn encode_pdf_text_string(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 + (text.len() * 2));
    bytes.push(0xFE);
    bytes.push(0xFF);
    for code_unit in text.encode_utf16() {
        bytes.push((code_unit >> 8) as u8);
        bytes.push((code_unit & 0xFF) as u8);
    }
    bytes
}

pub(crate) fn rect_object(rect: PdfRect) -> Object {
    Object::Array(vec![
        number_object(rect.x1),
        number_object(rect.y1),
        number_object(rect.x2),
        number_object(rect.y2),
    ])
}

pub(crate) fn annotation_related_ref(dict: &Dictionary, key: &[u8]) -> Option<ObjectId> {
    dict.get(key).and_then(Object::as_reference).ok()
}

pub(crate) fn annotation_subtype(dict: &Dictionary) -> String {
    dict.get(b"Subtype")
        .and_then(Object::as_name)
        .ok()
        .map(|name| {
            String::from_utf8_lossy(name)
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn parse_hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn parse_hex_color_component(high: u8, low: u8) -> Option<f64> {
    let high = parse_hex_digit(high)?;
    let low = parse_hex_digit(low)?;
    Some(f64::from(high * 16 + low) / 255.0)
}

pub(crate) fn parse_rgb_number(value: &str) -> Option<f64> {
    let parsed = value.trim().parse::<f64>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.clamp(0.0, 255.0) / 255.0)
}

pub(crate) fn parse_pdf_color(color: Option<&str>) -> Option<[f64; 3]> {
    let trimmed = color?.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("transparent")
        || trimmed.eq_ignore_ascii_case("none")
    {
        return None;
    }

    if let Some(hex) = trimmed.strip_prefix('#') {
        let bytes = hex.as_bytes();
        if bytes.len() == 3 {
            return Some([
                parse_hex_color_component(bytes[0], bytes[0])?,
                parse_hex_color_component(bytes[1], bytes[1])?,
                parse_hex_color_component(bytes[2], bytes[2])?,
            ]);
        }
        if bytes.len() == 6 {
            return Some([
                parse_hex_color_component(bytes[0], bytes[1])?,
                parse_hex_color_component(bytes[2], bytes[3])?,
                parse_hex_color_component(bytes[4], bytes[5])?,
            ]);
        }
    }

    let lower = trimmed.to_ascii_lowercase();
    let args = lower
        .strip_prefix("rgb(")
        .and_then(|value| value.strip_suffix(')'))
        .or_else(|| {
            lower
                .strip_prefix("rgba(")
                .and_then(|value| value.strip_suffix(')'))
        })?;
    let mut parts = args.split(',');
    Some([
        parse_rgb_number(parts.next()?)?,
        parse_rgb_number(parts.next()?)?,
        parse_rgb_number(parts.next()?)?,
    ])
}

pub(crate) fn set_rgb_color(dict: &mut Dictionary, key: &str, color: Option<&str>) {
    if let Some(rgb) = parse_pdf_color(color) {
        dict.set(
            key,
            Object::Array(vec![
                number_object(rgb[0]),
                number_object(rgb[1]),
                number_object(rgb[2]),
            ]),
        );
        return;
    }
    dict.remove(key.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_text_and_named_free_text_without_page_geometry() {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        let text_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "NM" => Object::string_literal("text-note"),
        });
        let popup_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Popup",
        });
        let free_text_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "FreeText",
            "NM" => Object::string_literal("named-free-text"),
            "Popup" => popup_id,
        });
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            vec![Object::Reference(text_id), Object::Reference(free_text_id)],
        );
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);

        let (index, scanned) = build_page_annotation_index(&document, page_id).unwrap();

        assert_eq!(scanned, 2);
        assert_eq!(index.first_text_note_named("text-note"), Some(text_id));
        assert_eq!(
            index.first_free_text_named("named-free-text"),
            Some(free_text_id)
        );
    }

    #[test]
    fn stable_key_delete_matches_bare_names_after_prefix_removal() {
        let index = PageAnnotationIndex {
            annots: Vec::new(),
            annotation_refs: HashSet::new(),
            first_text_note_by_name: HashMap::new(),
            named_text_notes: vec![((10, 0), "same-key".to_string())],
            first_free_text_by_name: HashMap::new(),
            named_free_text: vec![((20, 0), "same-key".to_string())],
            dirty: false,
        };
        let delete = AnnotationDelete {
            page_index: 0,
            object_number: None,
            generation_number: None,
            stable_key: Some("same-key".to_string()),
            created_at: None,
        };

        assert_eq!(
            index.matching_stable_delete_refs(&delete),
            vec![(10, 0), (20, 0)]
        );
    }

    #[test]
    fn default_appearance_tokenizer_clamps_a_trailing_escape() {
        let bytes = b"(unterminated\\";
        let tokens = tokenize_default_appearance(bytes);

        assert_eq!(tokens, vec![(0, bytes.len())]);
    }

    #[test]
    fn default_appearance_tokenizer_advances_past_a_stray_closing_delimiter() {
        let bytes = b"> /Helv 16 Tf";
        let tokens = tokenize_default_appearance(bytes);

        assert_eq!(
            tokens
                .iter()
                .map(|&(start, end)| &bytes[start..end])
                .collect::<Vec<_>>(),
            vec![b">".as_slice(), b"/Helv", b"16", b"Tf"]
        );
    }

    #[test]
    fn patch_default_appearance_appends_a_font_when_existing_size_is_not_numeric() {
        let patched = patch_default_appearance(Some(b"/Helv nope Tf"), 16.0, [0.1, 0.2, 0.3]);
        let patched = std::str::from_utf8(&patched).unwrap();

        assert!(patched.contains("/Helv nope Tf"));
        assert!(patched.contains("/Helv 16 Tf"));
    }

    #[test]
    fn patch_default_appearance_does_not_replace_a_malformed_color_operand() {
        let patched = patch_default_appearance(Some(b"/Helv 12 Tf 0 0 rg"), 16.0, [0.1, 0.2, 0.3]);
        let patched = std::str::from_utf8(&patched).unwrap();

        assert!(patched.contains("/Helv 16 Tf 0 0 rg"));
        assert!(patched.contains("/Helv 16 Tf"));
        assert!(patched.contains("0.1 0.2 0.3 rg"));
    }
}
