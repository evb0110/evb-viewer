use super::*;
use crate::free_text_frame::{free_text_frame, FreeTextFrame};
use crate::text_box_font::{
    self, baseline_from_top, layout, Geometry, Line, FONTS, LINE_HEIGHT, PADDING_X, PADDING_Y,
};
use lopdf::dictionary;
use skrifa::instance::{LocationRef, Size};
use skrifa::{FontRef, MetadataProvider};

/// PDF's standard sticky-note icon is a 20 point square. The mutation
/// protocol still carries the marker's normalized anchor, so the writer
/// expands that anchor into the physical icon rectangle on disk.
pub(crate) const TEXT_NOTE_ICON_SIZE_PT: f64 = 20.0;

pub(crate) struct NoteTarget {
    pub(crate) annotation_id: ObjectId,
    pub(crate) annotation_subtype: String,
    pub(crate) popup_ref: Option<ObjectId>,
    pub(crate) target_is_popup: bool,
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
        return Ok(NoteTarget {
            annotation_id: parent_id,
            annotation_subtype: annotation_subtype(parent_dict),
            popup_ref: Some(target_id),
            target_is_popup: true,
        });
    }

    Ok(NoteTarget {
        annotation_id: target_id,
        annotation_subtype: target_subtype,
        popup_ref: annotation_related_ref(target_dict, b"Popup"),
        target_is_popup: false,
    })
}

/// Scans every page for the one whose `/Annots` lists the note, trying a
/// targeted popup before its parent. Only a geometry move and a text update of
/// a legacy FreeText marker candidate need the page; other text updates do not.
pub(crate) fn find_note_target_page(
    document: &impl PdfObjectSource,
    target: &NoteTarget,
) -> Option<ObjectId> {
    target
        .popup_ref
        .filter(|_| target.target_is_popup)
        .and_then(|popup_id| find_annotation_page_from_annots(document, popup_id).ok())
        .or_else(|| find_annotation_page_from_annots(document, target.annotation_id).ok())
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

    // Expand around the marker's centre, keeping the icon inside the page.
    let anchor = MarkerRect {
        left: (marker_rect.left + (marker_rect.width - width) / 2.0).clamp(0.0, 1.0 - width),
        top: (marker_rect.top + (marker_rect.height - height) / 2.0).clamp(0.0, 1.0 - height),
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

fn set_annotation_geometry_dict(
    dict: &mut Dictionary,
    page_id: ObjectId,
    pdf_rect: PdfRect,
    modified_at: &str,
) {
    dict.set("Rect", rect_object(pdf_rect));
    dict.set("P", Object::Reference(page_id));
    set_annotation_modified_at(dict, modified_at);
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
        let source_page_id = find_note_target_page(document, &target)
            .ok_or("Note geometry target is not referenced from page Annots")?;
        let page_number = mutation_page_number(update.page_index)?;
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

        let target_dict = document.get_dictionary_mut(target.annotation_id)?;
        let placement = (destination_page_id, pdf_rect, modified_at);
        let pdf_rect = place_note_target(target_dict, marker_form, placement, update);
        if let Some(popup_id) = target.popup_ref {
            let popup_dict = document.get_dictionary_mut(popup_id)?;
            set_annotation_geometry_dict(popup_dict, destination_page_id, pdf_rect, modified_at);
        }

        let refs: Vec<_> = std::iter::once(target.annotation_id)
            .chain(target.popup_ref)
            .collect();
        if source_page_id != destination_page_id {
            remove_annotation_refs_from_page(document, source_page_id, &refs)?;
        }
        append_missing_annotation_refs_to_page(document, destination_page_id, &refs)?;
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
        let source_page_id = find_note_target_page(incremental.get_prev_documents(), &target)
            .ok_or("Note geometry target is not referenced from page Annots")?;
        let page_number = mutation_page_number(update.page_index)?;
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
        let target_dict = incremental
            .new_document
            .get_dictionary_mut(target.annotation_id)?;
        let placement = (destination_page_id, pdf_rect, modified_at);
        let pdf_rect = place_note_target(target_dict, marker_form, placement, update);
        if let Some(popup_id) = target.popup_ref {
            incremental.opt_clone_object_to_new_document(popup_id)?;
            let popup_dict = incremental.new_document.get_dictionary_mut(popup_id)?;
            set_annotation_geometry_dict(popup_dict, destination_page_id, pdf_rect, modified_at);
        }

        let refs: Vec<_> = std::iter::once(target.annotation_id)
            .chain(target.popup_ref)
            .collect();
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
        let page_number = mutation_page_number(note.page_index)?;
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
            let note_fields = (*note, note_name.as_str(), pdf_rect, modified_at);
            let annot_dict = document.get_dictionary_mut(annot_id)?;
            rewrite_text_note(
                annot_dict,
                subtype == "freetext",
                note_fields,
                (page_id, popup_ref),
            );
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
        let recovered = if let Some(data) = note.recovery_data.as_deref() {
            restore_note_recovery(document, data, annot_ref, popup_ref, page_id)?
        } else {
            Vec::new()
        };
        annotation_indexes
            .get_mut(&page_id)
            .expect("Text note page is indexed")
            .append_missing_refs(&recovered);
        let note_fields = (*note, note_name.as_str(), pdf_rect, modified_at);
        write_text_note_pair(document, note_fields, page_id, (annot_ref, popup_ref));
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
        let page_number = mutation_page_number(note.page_index)?;
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
            let note_fields = (*note, note_name.as_str(), pdf_rect, modified_at);
            let annot_dict = incremental.new_document.get_dictionary_mut(annot_id)?;
            rewrite_text_note(
                annot_dict,
                subtype == "freetext",
                note_fields,
                (page_id, popup_ref),
            );
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
        let recovered = if let Some(data) = note.recovery_data.as_deref() {
            restore_note_recovery(
                &mut incremental.new_document,
                data,
                annot_ref,
                popup_ref,
                page_id,
            )?
        } else {
            Vec::new()
        };
        annotation_indexes
            .get_mut(&page_id)
            .expect("Text note page is indexed")
            .append_missing_refs(&recovered);
        let note_fields = (*note, note_name.as_str(), pdf_rect, modified_at);
        write_text_note_pair(
            &mut incremental.new_document,
            note_fields,
            page_id,
            (annot_ref, popup_ref),
        );
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
    let mut fonts = crate::text_box_font::SharedFonts::default();
    for editor in editors {
        let page_number = mutation_page_number(editor.page_index)?;
        let page_id = page_resolver.page_id(document, page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            let (index, scanned) = build_page_annotation_index(document, page_id)?;
            *annotation_visits = (*annotation_visits).saturating_add(scanned);
            entry.insert(index);
        }
        let page_view = resolve_page_view(document, page_id)?;
        let mut rect = validate_text_box_rect(editor, page_view)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let name = text_box_name(editor);
        let target = resolve_text_box_target(document, page_id, editor)?.or_else(|| {
            annotation_indexes
                .get(&page_id)
                .and_then(|index| index.first_free_text_named(&name))
        });
        let existing = target
            .map(|id| existing_text_box_values(document, id, editor, &mut rect))
            .transpose()?;
        let frame = existing.as_ref();
        let appearance =
            build_text_box_appearance(document, editor, rect, page_rotation, &mut fonts, frame)?;
        if let Some(annotation_ref) = target {
            let dict = document.get_dictionary_mut(annotation_ref)?;
            set_text_box_fields(
                dict,
                editor,
                &name,
                rect,
                modified_at,
                appearance,
                page_rotation,
                existing,
            );
            continue;
        }
        let annotation_ref = document.new_object_id();
        let mut dict = dictionary! {"Type" => "Annot", "Subtype" => "FreeText", "F" => 4};
        set_text_box_fields(
            &mut dict,
            editor,
            &name,
            rect,
            modified_at,
            appearance,
            page_rotation,
            None,
        );
        document.set_object(annotation_ref, Object::Dictionary(dict));
        report_annotation_identity_binding(identity_bindings, &editor.stable_key, annotation_ref);
        annotation_indexes
            .get_mut(&page_id)
            .expect("FreeText editor pages are indexed before mutation")
            .append_free_text_without_popup(&name, annotation_ref);
    }
    fonts.embed(document, &crate::text_box_font::FONTS)?;
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
    let mut fonts = crate::text_box_font::SharedFonts::default();
    for editor in editors {
        let page_number = mutation_page_number(editor.page_index)?;
        let page_id = page_resolver.page_id(incremental.get_prev_documents(), page_number)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = annotation_indexes.entry(page_id)
        {
            let (index, scanned) = build_incremental_page_annotation_index(incremental, page_id)?;
            *annotation_visits = (*annotation_visits).saturating_add(scanned);
            entry.insert(index);
        }
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let mut rect = validate_text_box_rect(editor, page_view)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let name = text_box_name(editor);
        let revision = AppendedRevision::new(incremental);
        let target = resolve_text_box_target(&revision, page_id, editor)?.or_else(|| {
            annotation_indexes
                .get(&page_id)
                .and_then(|index| index.first_free_text_named(&name))
        });
        let existing = target
            .map(|id| existing_text_box_values(&revision, id, editor, &mut rect))
            .transpose()?;
        let (frame, document) = (existing.as_ref(), &mut incremental.new_document);
        let appearance =
            build_text_box_appearance(document, editor, rect, page_rotation, &mut fonts, frame)?;
        if let Some(annotation_ref) = target {
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
                appearance,
                page_rotation,
                existing,
            );
            continue;
        }
        let annotation_ref = incremental.new_document.new_object_id();
        let mut dict = dictionary! {"Type" => "Annot", "Subtype" => "FreeText", "F" => 4};
        set_text_box_fields(
            &mut dict,
            editor,
            &name,
            rect,
            modified_at,
            appearance,
            page_rotation,
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
    fonts.embed(&mut incremental.new_document, &crate::text_box_font::FONTS)?;
    for (page_id, index) in annotation_indexes {
        write_page_annotation_index_incremental(incremental, page_id, index)?;
    }
    Ok(())
}

pub(crate) fn text_box_name(editor: &TextBoxMutation) -> String {
    editor.stable_key.trim().to_string()
}

/// Classify existing targets before any same-save geometry or text updates.
/// Those updates can temporarily leave canonical layout metadata stale.
/// The 1-based page number of a mutation's 0-based page index.
fn mutation_page_number(page_index: u32) -> Result<u32> {
    Ok(page_index
        .checked_add(1)
        .ok_or("Invalid annotation page index")?)
}

pub(crate) fn validate_text_box_targets(
    document: &impl PdfObjectSource,
    mutations: &NativeMutationsFile,
) -> Result<()> {
    if mutations.text_boxes.is_empty() {
        return Ok(());
    }
    let pages = PageTreeResolver::new(document)?;
    let mut indexes = HashMap::new();
    for editor in &mutations.text_boxes {
        let page_id = pages.page_id(document, mutation_page_number(editor.page_index)?)?;
        if let std::collections::hash_map::Entry::Vacant(entry) = indexes.entry(page_id) {
            entry.insert(build_page_annotation_index(document, page_id)?.0);
        }
        let index = &indexes[&page_id];
        let name = text_box_name(editor);
        let id = match editor.annotation_id.as_deref() {
            Some(id) => Some(
                parse_pdfjs_annotation_object_id(id)
                    .ok_or("Invalid imported FreeText annotation id")?,
            ),
            None => index.first_free_text_named(&name).or_else(|| {
                mutations
                    .geometry_updates
                    .iter()
                    .filter(|update| update.page_index == editor.page_index)
                    .find_map(|update| {
                        let id = (update.object_number, update.generation_number);
                        document
                            .dictionary(id)
                            .ok()
                            .filter(|dict| {
                                annotation_subtype(dict) == "freetext"
                                    && read_annotation_name(dict).as_deref() == Some(name.as_str())
                            })
                            .map(|_| id)
                    })
            }),
        };
        let Some(id) = id else { continue };
        // Geometry updates may move an existing box between pages later in
        // this save. Classification still belongs to its original page frame.
        let source_page = if index.annotation_refs.contains(&id) {
            page_id
        } else {
            find_annotation_page_from_annots(document, id)?
        };
        let dict = document.dictionary(id)?;
        if annotation_subtype(dict) != "freetext" {
            return Err("Imported FreeText target is not a FreeText annotation".into());
        }
        crate::annotation_parse::parse_text_box_entry(
            document,
            dict,
            id,
            u64::from(editor.page_index),
            resolve_page_view(document, source_page)?,
            resolve_page_rotation(document, source_page)?,
            &name,
        )
        .and_then(|entry| match entry.read_only {
            true => Err("its border style is not editable".to_string()),
            false => Ok(()),
        })
        .map_err(|reason| format!("FreeText target {}R{} is read-only: {reason}", id.0, id.1))?;
    }
    Ok(())
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
    let [x1, y1, x2, y2] = editor.rect;
    let source = PdfRect { x1, y1, x2, y2 };
    // Rotating around the center can put the unrotated canonical box outside
    // the page while all visible corners remain inside it.
    let rect = crate::text_box_font::geometry(source, i64::from(editor.rotation), 0)?.bounds;
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

/// Where a fitted line starts and sits in its box. RTL lines align right, and
/// the spaces that hang at their end fall off the start side.
pub(crate) fn line_origin(geometry: &Geometry, line: &Line, index: usize, size: f64) -> (f64, f64) {
    let rest = (geometry.width - 2.0 * PADDING_X * size).max(0.0) - line.width;
    let left = PADDING_X * size + if line.rtl { rest } else { 0.0 };
    let baseline = geometry.height - baseline_from_top(size) - index as f64 * LINE_HEIGHT * size;
    (left, baseline)
}

/// The editor grows a box to its lines. They fit when the box holds their
/// count and every positioned glyph's ink, marks below the baseline and above
/// the cap height included, stays inside the box, which clips the appearance.
/// Where it does not, the size shrinks until it does. The appearance and the
/// DA, which the reopened editor reads, both use that size. Printing fits a
/// box without an appearance the same way, with its own programs and layout.
pub(crate) fn fit_text_box(
    font_size: f64,
    geometry: &Geometry,
    programs: &[&[u8]],
    lay_out: impl Fn(f64, f64) -> Vec<Line>,
) -> (f64, Vec<Line>) {
    let faces: Vec<_> = programs
        .iter()
        .map(|p| FontRef::from_index(p, 0).expect("font"))
        .collect();
    let lines = |size: f64| lay_out(geometry.width - 2.0 * PADDING_X * size, size);
    let fit = |size: f64| {
        let lines = lines(size);
        let (width, height) = (geometry.width, geometry.height);
        let inside = |(index, line): (usize, &Line)| {
            let (left, baseline) = line_origin(geometry, line, index, size);
            // A simple font's line has measured advances, not outlines.
            let measured = !line.glyphs.is_empty() || left + line.width <= width;
            measured
                && line.glyphs.iter().all(|glyph| {
                    let ink =
                        faces[glyph.font].glyph_metrics(Size::new(1.0), LocationRef::default());
                    let ink = ink.bounds(glyph.id.into()).unwrap_or_default();
                    let [x1, y1, x2, y2] =
                        [ink.x_min, ink.y_min, ink.x_max, ink.y_max].map(|em| f64::from(em) * size);
                    let (x, y) = (left + glyph.x, baseline + glyph.y);
                    x1 == x2 || (x + x1).min(y + y1) >= 0.0 && x + x2 <= width && y + y2 <= height
                })
        };
        let height = (lines.len() as f64 * LINE_HEIGHT + PADDING_Y) * size;
        (height <= geometry.height + 0.01 && lines.iter().enumerate().all(inside)).then_some(lines)
    };
    if let Some(lines) = fit(font_size) {
        return (font_size, lines);
    }
    let mut range = (0.0, font_size);
    while range.1 - range.0 > 0.01 {
        let middle = (range.0 + range.1) / 2.0;
        range = if fit(middle).is_some() {
            (middle, range.1)
        } else {
            (range.0, middle)
        };
    }
    let size = ((range.0 * 100.0).floor() / 100.0).max(0.01);
    (size, lines(size))
}

/// Fitted lines clipped to their box. Text state lasts through BT, so each
/// font is selected only where it changes.
pub(crate) fn text_box_content(
    geometry: &Geometry,
    color: &str,
    lines: &[Line],
    size: f64,
) -> String {
    let mut content = format!(
        "q\n{} cm\n0 0 {} {} re W n\nBT\n{color}\n0 Tc\n",
        format_operands(&geometry.matrix),
        number_to_content(geometry.width),
        number_to_content(geometry.height),
    );
    let mut font = None;
    for (index, line) in lines.iter().enumerate() {
        let (left, baseline) = line_origin(geometry, line, index, size);
        content.push_str(&format!(
            "/Span << /ActualText <{}> >> BDC\n",
            text_box_font::unicode_hex(&line.text, true)
        ));
        for run in line.glyphs.chunk_by(|a, b| a.font == b.font) {
            if font.replace(run[0].font) != Some(run[0].font) {
                let size = number_to_content(size);
                content.push_str(&format!("/TextFont{} {size} Tf\n", run[0].font));
            }
            for glyph in run {
                content.push_str(&format!(
                    "1 0 0 1 {} {} Tm <{:04X}> Tj\n",
                    number_to_content(left + glyph.x),
                    number_to_content(baseline + glyph.y),
                    glyph.id,
                ));
            }
        }
        content.push_str("EMC\n");
    }
    content + "ET\nQ"
}

pub(crate) fn build_text_box_appearance(
    document: &mut Document,
    editor: &TextBoxMutation,
    rect: PdfRect,
    page_rotation: i64,
    shared: &mut crate::text_box_font::SharedFonts,
    existing: Option<&ExistingTextBox>,
) -> Result<(ObjectId, f64)> {
    let [x1, y1, x2, y2] = editor.rect;
    let source = PdfRect { x1, y1, x2, y2 };
    // A framed box fits its text inside the frame, which it draws first.
    let frame = existing.and_then(|existing| existing.2.as_ref());
    let geometry = text_box_font::geometry(source, i64::from(editor.rotation), page_rotation)?;
    let geometry = FreeTextFrame::fit(frame, geometry);
    let color = editor.color.map(|component| f64::from(component) / 255.0);
    let text = |width, size| layout(&editor.text, width, size);
    let (size, lines) = fit_text_box(editor.font_size, &geometry, &FONTS, text);
    let fonts = shared.resources(document, &lines);
    let color = format!("{} rg", format_operands(&color));
    let frame = frame.map_or("", |frame| &frame.content);
    let content = frame.to_string() + &text_box_content(&geometry, &color, &lines, size);
    Ok((document.add_object(Stream::new(lopdf::dictionary! {
        "Type" => "XObject", "Subtype" => "Form", "FormType" => 1,
        "BBox" => rect_object(rect), "Resources" => lopdf::dictionary! {"Font" => fonts},
        "Matrix" => vec![number_object(1.0), number_object(0.0), number_object(0.0), number_object(1.0), number_object(-rect.x1), number_object(-rect.y1)],
    }, content.into_bytes())), size))
}

/// An edited box keeps its appearance dictionary, its DA and the frame its
/// producer gave it; an unmoved box keeps its written geometry.
type ExistingTextBox = (Option<Dictionary>, Option<Vec<u8>>, Option<FreeTextFrame>);

fn existing_text_box_values(
    document: &impl PdfObjectSource,
    annotation_ref: ObjectId,
    editor: &TextBoxMutation,
    rect: &mut PdfRect,
) -> Result<ExistingTextBox> {
    let dict = document.dictionary(annotation_ref)?;
    let [x1, y1, x2, y2] = editor.rect;
    let source = crate::text_box_font::settled(dict, PdfRect { x1, y1, x2, y2 });
    *rect = crate::text_box_font::geometry(source, i64::from(editor.rotation), 0)?.bounds;
    let value = |key: &[u8]| document.resolved(dict.get(key).ok()?).ok();
    let appearance = value(b"AP").and_then(|object| object.as_dict().ok().cloned());
    Ok((
        appearance,
        value(b"DA").and_then(|object| object.as_str().ok().map(ToOwned::to_owned)),
        Some(free_text_frame(document, dict, *rect)),
    ))
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
            // A malformed size operand is replaced too, so readers take the
            // size the appearance draws rather than an earlier number.
            let operand = index.checked_sub(1).and_then(|i| tokens.get(i));
            if let Some(&(size_start, size_end)) = operand.filter(|(at, _)| bytes[*at] != b'/') {
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
    replacements.sort_unstable_by_key(|(start, _, _)| *start);
    for (start, end, replacement) in replacements.into_iter().rev() {
        bytes.splice(start..end, replacement);
    }
    if !replaced_tf {
        bytes.extend_from_slice(format!(" /Helv {} Tf", number_to_content(font_size)).as_bytes());
    }
    if !replaced_rg {
        bytes.extend_from_slice(format!(" {} rg", format_operands(&color)).as_bytes());
    }
    bytes.trim_ascii_start().to_vec()
}

#[allow(clippy::too_many_arguments)]
fn set_text_box_fields(
    dict: &mut Dictionary,
    editor: &TextBoxMutation,
    name: &str,
    rect: PdfRect,
    modified_at: &str,
    (appearance_ref, font_size): (ObjectId, f64),
    page_rotation: i64,
    existing: Option<ExistingTextBox>,
) {
    let is_new = existing.is_none();
    let (existing_appearance, existing_default_appearance, frame) = existing.unwrap_or_default();
    crate::text_box_font::write_editor_geometry(
        dict,
        editor.rect,
        i64::from(editor.rotation),
        page_rotation,
        rect,
    );
    dict.set("Contents", text_object(&editor.text));
    let effective_modified_at = shape_pdf_date(editor.modified_at, modified_at);
    dict.set(
        "M",
        Object::string_literal(effective_modified_at.into_bytes()),
    );
    if read_annotation_name(dict).is_none() {
        write_annotation_name(dict, name);
    }
    if is_new {
        dict.set("Border", vec![0.into(), 0.into(), 0.into()]);
    }
    let color = editor.color.map(|component| f64::from(component) / 255.0);
    // A new box starts from an empty DA, which gains the Tf and rg it lacks.
    let default_appearance = existing_default_appearance.as_deref();
    let mut default_appearance = patch_default_appearance(default_appearance, font_size, color);
    frame.inspect(|frame| frame.keep_in(dict, &mut default_appearance));
    dict.set("DA", Object::string_literal(default_appearance));
    let mut appearance = existing_appearance.unwrap_or_default();
    appearance.set("N", Object::Reference(appearance_ref));
    dict.set("AP", appearance);
    if is_new || editor.author.is_some() {
        dict.set("T", text_object(editor.author.as_deref().unwrap_or("")));
    }
    if is_new || editor.created_at.is_some() {
        dict.set(
            "CreationDate",
            Object::string_literal(shape_pdf_date(editor.created_at, modified_at).into_bytes()),
        );
    }
}

/// Rewrites an existing note, or a legacy FreeText marker, in canonical form.
fn rewrite_text_note(
    dict: &mut Dictionary,
    marker: bool,
    (note, note_name, pdf_rect, modified_at): (&TextNote, &str, PdfRect, &str),
    (page_id, popup_ref): (ObjectId, ObjectId),
) {
    if marker {
        convert_free_text_marker_to_text(dict, pdf_rect, modified_at);
    } else {
        dict.remove(b"AP");
        dict.remove(b"DA");
    }
    set_text_note_annotation_fields(dict, note, note_name, pdf_rect, modified_at);
    dict.set("Popup", Object::Reference(popup_ref));
    dict.set("P", Object::Reference(page_id));
}

/// Writes a note and its Popup in canonical form over any earlier ones on `page_id`.
fn write_text_note_pair(
    document: &mut Document,
    (note, note_name, pdf_rect, modified_at): (&TextNote, &str, PdfRect, &str),
    page_id: ObjectId,
    (annot_ref, popup_ref): (ObjectId, ObjectId),
) {
    let existing = |id| document.get_dictionary(id).ok().cloned();
    let mut annot_dict = existing(annot_ref)
        .unwrap_or_else(|| build_text_note_annotation_dict(note, note_name, pdf_rect, modified_at));
    convert_free_text_marker_to_text(&mut annot_dict, pdf_rect, modified_at);
    set_text_note_annotation_fields(&mut annot_dict, note, note_name, pdf_rect, modified_at);
    annot_dict.set("P", Object::Reference(page_id));
    annot_dict.set("Popup", Object::Reference(popup_ref));
    let mut popup_dict = existing(popup_ref)
        .unwrap_or_else(|| build_popup_annotation_dict(note, pdf_rect, modified_at, annot_ref));
    set_popup_annotation_fields(&mut popup_dict, note, pdf_rect, modified_at, annot_ref);
    popup_dict.set("P", Object::Reference(page_id));
    document.set_object(annot_ref, Object::Dictionary(annot_dict));
    document.set_object(popup_ref, Object::Dictionary(popup_dict));
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
    dict.set("Contents", text_object(&note.text));
    dict.set("T", text_object(note.author.as_deref().unwrap_or("")));
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
    dict.set("Open", Object::Boolean(note.open));
}

/// Moves a note's target, a legacy marker converted, and a popup it holds
/// inline to `pdf_rect` on its page, with the update's colour and state.
fn place_note_target(
    dict: &mut Dictionary,
    marker_form: bool,
    (page_id, pdf_rect, modified_at): (ObjectId, PdfRect, &str),
    update: &NoteGeometryUpdate,
) -> PdfRect {
    // A note that did not move keeps its written numbers, as a text box does.
    let pdf_rect = crate::text_box_font::settled(dict, pdf_rect);
    if marker_form {
        convert_free_text_marker_to_text(dict, pdf_rect, modified_at);
    }
    set_annotation_geometry_dict(dict, page_id, pdf_rect, modified_at);
    apply_note_style_update(dict, update);
    if let Ok(Object::Dictionary(popup)) = dict.get_mut(b"Popup") {
        set_annotation_geometry_dict(popup, page_id, pdf_rect, modified_at);
    }
    pdf_rect
}

fn apply_note_style_update(dict: &mut Dictionary, update: &NoteGeometryUpdate) {
    // A FreeText's colour is its DA's, which the text-box writer keeps; /C fills it.
    let free_text = dict
        .get(b"Subtype")
        .and_then(Object::as_name)
        .is_ok_and(|s| s == b"FreeText");
    if let Some(color) = update.color.as_ref().filter(|_| !free_text) {
        set_rgb_color(dict, "C", color.as_deref());
    }
    if let Some(open) = update.open {
        dict.set("Open", Object::Boolean(open));
    }
}

fn set_annotation_modified_at(dict: &mut Dictionary, modified_at: &str) {
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
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

pub(crate) fn build_popup_annotation_dict(
    note: &TextNote,
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
    note: &TextNote,
    pdf_rect: PdfRect,
    modified_at: &str,
    parent_ref: ObjectId,
) {
    dict.set("Parent", Object::Reference(parent_ref));
    dict.set("Rect", rect_object(pdf_rect));
    dict.set("Contents", text_object(&note.text));
    dict.set("M", Object::string_literal(modified_at.as_bytes().to_vec()));
    dict.set("T", text_object(note.author.as_deref().unwrap_or("")));
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
        let page_number = mutation_page_number(delete.page_index)?;
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
        let page_number = mutation_page_number(delete.page_index)?;
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
    if target.annotation_subtype == "freetext"
        && is_free_text_note_marker_candidate(
            document,
            document.get_dictionary(target.annotation_id)?,
        )
    {
        if let Some(page_id) = find_note_target_page(document, &target) {
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
    if target.annotation_subtype == "freetext"
        && is_free_text_note_marker_candidate(
            incremental.get_prev_documents(),
            incremental
                .get_prev_documents()
                .get_dictionary(target.annotation_id)?,
        )
    {
        if let Some(page_id) = find_note_target_page(incremental.get_prev_documents(), &target) {
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
    dict.set("Contents", text_object(text));
    set_annotation_modified_at(dict, modified_at);
}

/// Decodes any PDF text string: UTF-16BE or UTF-8 by BOM, otherwise
/// PDFDocEncoding. Callers share this so one string decodes the same everywhere.
pub(crate) fn pdf_string_to_text(object: &Object) -> Option<String> {
    lopdf::decode_text_string(object).ok()
}

/// A PDF text string in UTF-16BE, written as hexadecimal.
fn text_object(text: &str) -> Object {
    Object::String(encode_pdf_text_string(text), StringFormat::Hexadecimal)
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
    use lopdf::dictionary;

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
    fn patch_default_appearance_replaces_a_size_that_is_not_numeric() {
        let patched = patch_default_appearance(
            Some(b"/Helv 22 Tf 0.2 0.4 0.6 rg /Helv nope Tf"),
            16.0,
            [0.1, 0.2, 0.3],
        );
        assert_eq!(patched, b"/Helv 16 Tf 0.1 0.2 0.3 rg /Helv 16 Tf");
        let patched = patch_default_appearance(Some(b"/Helv Tf"), 16.0, [0.1, 0.2, 0.3]);
        assert_eq!(patched, b"/Helv Tf /Helv 16 Tf 0.1 0.2 0.3 rg");
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
