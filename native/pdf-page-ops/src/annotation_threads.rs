use super::*;
use crate::note_markers::legacy_note_marker_as_text;
use crate::split_pages::{page_annotation_array, transform_annotation_geometry};

/// The annotation a reply or popup answers to: the thread root for a reply,
/// the note for a popup. A form field is not a thread member, so a widget's
/// `/Parent` is never followed.
fn thread_parent(source: &Document, annotation: &Dictionary) -> Option<ObjectId> {
    [b"IRT".as_slice(), b"Parent".as_slice()]
        .into_iter()
        .find_map(|key| {
            let parent = annotation_related_ref(annotation, key)?;
            source
                .get_dictionary(parent)
                .ok()?
                .has(b"Subtype")
                .then_some(parent)
        })
}

/// The terminal owner of an annotation's thread, found by following reply and
/// popup links to the note that every member answers to.
fn thread_owner(source: &Document, annotation: &Dictionary) -> Dictionary {
    let mut owner = annotation.clone();
    let mut seen = HashSet::new();
    while let Some(parent) = thread_parent(source, &owner) {
        if !seen.insert(parent) {
            break;
        }
        match source.get_dictionary(parent) {
            Ok(dictionary) => owner = dictionary.clone(),
            Err(_) => break,
        }
    }
    owner
}

/// A note sits on the output that holds its marker centre, as an overlay note
/// does, so a thread is placed as a unit by the centre of its owner. An owner
/// without a readable rectangle is kept rather than dropped.
fn owner_centre_in_crop(
    source: &Document,
    owner: &Dictionary,
    matrix: [f64; 6],
    crop: PdfRect,
) -> bool {
    let Some(rect) = read_pdf_rect_from_dict(source, owner) else {
        return true;
    };
    let rect = PdfMatrix::from_values(matrix).bounds(rect);
    let (x, y) = ((rect.x1 + rect.x2) / 2.0, (rect.y1 + rect.y2) / 2.0);
    x >= crop.x1 && x < crop.x2 && y >= crop.y1 && y < crop.y2
}

/// Copies the source page's annotations into the output page `page`, which is
/// `page_id` in `target`. Each thread is copied whole: reply, popup and
/// thread root get fresh objects, and `/IRT`, `/Parent` and `/Popup` point at
/// those copies, not at the source. `/P` points at the output page. A thread
/// whose owner is a note is written only to the output that holds the owner's
/// centre; other annotations are written to every output, as before. A
/// crop-only output has no transform, which leaves every annotation in place.
pub(crate) fn transform_page_annotations(
    source: &Document,
    target: &mut Document,
    source_page_id: ObjectId,
    page_id: ObjectId,
    page: &mut Dictionary,
    transform: Option<SplitContentTransform>,
    crop: PdfRect,
) -> Result<()> {
    let Some(entries) = page_annotation_array(source, page) else {
        return Ok(());
    };
    let matrix = transform.map_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], |transform| {
        [
            transform.scale,
            0.0,
            0.0,
            transform.scale,
            transform.translate_x,
            transform.translate_y,
        ]
    });
    let rotation = page
        .get(b"Rotate")
        .ok()
        .and_then(|value| value.as_i64().ok())
        .unwrap_or(0);
    let source_view = resolve_page_view(source, source_page_id)?;
    let mut copies = HashMap::new();
    let mut pending = Vec::new();
    let mut kept = Vec::with_capacity(entries.len());
    for entry in entries {
        // An entry this tool cannot read as an annotation dictionary is carried
        // over exactly as it was, as it always has been.
        let (source_id, annotation) = match source.dereference(&entry) {
            Ok((source_id, object)) => match object.as_dict() {
                Ok(annotation) => (source_id, annotation.clone()),
                Err(_) => {
                    kept.push(entry);
                    continue;
                }
            },
            Err(_) => {
                kept.push(entry);
                continue;
            }
        };
        let owner = thread_owner(source, &annotation);
        let subtype = owner
            .get(b"Subtype")
            .ok()
            .and_then(|object| source.resolved(object).ok())
            .and_then(|object| object.as_name().ok());
        let note_owner = matches!(subtype, Some(b"Text" | b"Popup"))
            || is_free_text_note_marker(source, &owner, source_view, rotation);
        if note_owner && !owner_centre_in_crop(source, &owner, matrix, crop) {
            continue;
        }
        let copy_id = match source_id {
            Some(source_id) => match copies.get(&source_id) {
                // Already written with its thread by an earlier entry.
                Some(&copy_id) => {
                    kept.push(Object::Reference(copy_id));
                    continue;
                }
                None => {
                    let copy_id = target.new_object_id();
                    copies.insert(source_id, copy_id);
                    copy_id
                }
            },
            None => target.new_object_id(),
        };
        kept.push(Object::Reference(copy_id));
        pending.push((copy_id, annotation));
    }

    while let Some((copy_id, mut annotation)) = pending.pop() {
        for key in [b"IRT".as_slice(), b"Parent".as_slice(), b"Popup".as_slice()] {
            let Some(related) = annotation_related_ref(&annotation, key) else {
                continue;
            };
            let copy = match copies.get(&related) {
                Some(&copy) => copy,
                None => {
                    let Ok(member) = source.get_dictionary(related) else {
                        continue;
                    };
                    if !member.has(b"Subtype") {
                        continue;
                    }
                    let copy = target.new_object_id();
                    copies.insert(related, copy);
                    pending.push((copy, member.clone()));
                    copy
                }
            };
            annotation.set(key, Object::Reference(copy));
        }
        if annotation.has(b"P") {
            annotation.set("P", page_id);
        }
        // A legacy marker is recognized by its size on its page, which the
        // split may narrow, so it becomes a /Text note before it moves.
        legacy_note_marker_as_text(source, &mut annotation, source, source_page_id)?;
        transform_annotation_geometry(target, &mut annotation, matrix, Some(source), rotation)?;
        target
            .objects
            .insert(copy_id, Object::Dictionary(annotation));
    }
    page.set("Annots", Object::Array(kept));
    Ok(())
}
