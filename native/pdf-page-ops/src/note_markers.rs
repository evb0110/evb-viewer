use super::*;
use crate::page_geometry::pdf_rect_to_note_marker_rect;

/// The legacy marker test against the page an annotation came from. `dict` may
/// be a copy in `document` whose references already point into the target.
pub(crate) fn legacy_marker_on_page(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    source: &Document,
    source_page_id: ObjectId,
) -> Result<bool> {
    let source_view = resolve_page_view(source, source_page_id)?;
    let source_rotation = resolve_page_rotation(source, source_page_id)?;
    Ok(is_free_text_note_marker(
        document,
        dict,
        source_view,
        source_rotation,
    ))
}

/// A legacy marker is recognized by its size relative to its page, so a split
/// that narrows the page would stop recognizing it. Write a copy that is a
/// marker on its source page as the /Text note the writer produces on the
/// first edit. Call before the copy's geometry moves.
pub(crate) fn legacy_note_marker_as_text(
    document: &impl PdfObjectSource,
    dict: &mut Dictionary,
    source: &Document,
    source_page_id: ObjectId,
) -> Result<()> {
    if !legacy_marker_on_page(document, dict, source, source_page_id)? {
        return Ok(());
    }
    let pdf_rect = parse_rect(document.resolved(dict.get(b"Rect")?)?)?;
    // The shared conversion reads the dates as direct strings, so resolve them
    // here, where the object they refer to can still be read.
    for key in [b"CreationDate".as_slice(), b"M"] {
        if let Some(value) = dict
            .get(key)
            .ok()
            .and_then(|object| document.resolved(object).ok())
            .cloned()
        {
            dict.set(key.to_vec(), value);
        }
    }
    let modified_at = dict
        .get(b"M")
        .ok()
        .and_then(pdf_string_to_text)
        .unwrap_or_default();
    convert_free_text_marker_to_text(dict, pdf_rect, &modified_at);
    Ok(())
}

/// Move a note's marker back onto its output page, keeping its size. The reader
/// admits a note only while its centre lies on the page, so a marker that a
/// split or canvas placement pushed past an edge would import as foreign. A
/// popup has no centre rule of its own and is only moved. A note that cannot
/// fit the page fails the conversion rather than publishing a foreign note.
pub(crate) fn fit_note_to_view(
    document: &Document,
    annotation: &mut Dictionary,
    view: PdfRect,
    page_rotation: i64,
) -> Result<()> {
    let Some(rect) = annotation
        .get(b"Rect")
        .ok()
        .and_then(|value| parse_rect(value).ok())
    else {
        return Ok(());
    };
    let subtype = annotation
        .get(b"Subtype")
        .ok()
        .and_then(|value| value.as_name().ok());
    let is_popup = subtype == Some(b"Popup");
    if !is_popup
        && !matches!(subtype, Some(b"Text"))
        && !is_free_text_note_marker(document, annotation, view, page_rotation)
    {
        return Ok(());
    }
    let (width, height) = (rect.x2 - rect.x1, rect.y2 - rect.y1);
    let x1 = rect.x1.min(view.x2 - width).max(view.x1);
    let y1 = rect.y1.min(view.y2 - height).max(view.y1);
    let fitted = PdfRect {
        x1,
        y1,
        x2: x1 + width,
        y2: y1 + height,
    };
    // Only a thread root is a note; a reply is not admitted by the note reader.
    let is_root = !is_popup && annotation.get(b"IRT").is_err();
    if is_root && pdf_rect_to_note_marker_rect(fitted, view, page_rotation).is_err() {
        return Err("overlay-text cannot keep a note on its output page".into());
    }
    if x1 == rect.x1 && y1 == rect.y1 {
        return Ok(());
    }
    let (centre_x, centre_y) = ((fitted.x1 + fitted.x2) / 2.0, (fitted.y1 + fitted.y2) / 2.0);
    let centred = (view.x1..view.x2).contains(&centre_x) && (view.y1..view.y2).contains(&centre_y);
    if !(is_popup || centred) {
        return Err("overlay-text cannot keep a note centred on its output page".into());
    }
    annotation.set("Rect", rect_object(fitted));
    Ok(())
}
