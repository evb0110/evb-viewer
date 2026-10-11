use super::*;
use crate::note_markers::{legacy_marker_on_page, legacy_note_marker_as_text};
use crate::page_geometry::pdf_rect_to_note_marker_rect;
use crate::split_pages::transform_annotation_geometry;

/// Where a copied annotation came from and where it lands.
pub(crate) struct NoteCopy<'a> {
    pub(crate) source: &'a Document,
    pub(crate) source_page_id: ObjectId,
    /// The copy is filtered to its output page, so a legacy marker becomes a /Text note.
    pub(crate) filtered: bool,
    pub(crate) matrix: [f64; 6],
    /// The output page's view and rotation.
    pub(crate) view: PdfRect,
    pub(crate) rotation: i64,
}

/// Places one copied annotation on its output page: prepares it, moves it by
/// `copy.matrix` and fits a note onto the output view. The copy's references
/// resolve in `base`, or in `target` when there is no base. Every copy path
/// places notes through here, so a note the source admits is kept or refused the
/// same way wherever it is copied.
pub(crate) fn place_note_copy(
    target: &mut Document,
    annotation: &mut Dictionary,
    base: Option<&Document>,
    copy: &NoteCopy,
) -> Result<()> {
    let note = prepare_note_copy(
        base.unwrap_or(&*target),
        annotation,
        copy.source,
        copy.source_page_id,
        copy.filtered,
    )?;
    transform_annotation_geometry(target, annotation, copy.matrix, base, copy.rotation)?;
    fit_note_to_view(
        base.unwrap_or(&*target),
        annotation,
        copy.view,
        copy.rotation,
        note,
    )
}

/// Readies an overlay copy of a source annotation and says whether it is a
/// note root the reader admits on its source page. Only such a note must stay
/// a note on the output page; one the source already shows as foreign is copied
/// as it is. A legacy marker becomes a /Text note when the overlay filters to
/// an output page, since the narrower page would stop recognizing it.
pub(crate) fn prepare_note_copy(
    document: &Document,
    annotation: &mut Dictionary,
    source: &Document,
    source_page_id: ObjectId,
    filtered: bool,
) -> Result<bool> {
    let resolved = |key: &[u8]| {
        annotation
            .get(key)
            .ok()
            .and_then(|value| document.resolved(value).ok())
    };
    let text_root = resolved(b"Subtype").and_then(|value| value.as_name().ok())
        == Some(b"Text".as_slice())
        && !annotation.has(b"IRT");
    let admitted_text = text_root
        && resolved(b"Rect")
            .and_then(|value| parse_rect(value).ok())
            .is_some_and(|rect| {
                let view = resolve_page_view(source, source_page_id);
                let rotation = resolve_page_rotation(source, source_page_id);
                matches!((view, rotation), (Ok(view), Ok(rotation)) if pdf_rect_to_note_marker_rect(rect, view, rotation).is_ok())
            });
    let source_note =
        admitted_text || legacy_marker_on_page(document, annotation, source, source_page_id)?;
    if filtered {
        legacy_note_marker_as_text(document, annotation, source, source_page_id)?;
    }
    Ok(source_note)
}

/// Move a note's marker back onto its output page, keeping its size. The reader
/// admits a note only while its centre lies on the page, so a marker that a
/// split or canvas placement pushed past an edge would import as foreign. A
/// popup has no centre rule of its own and is only moved. A note its source
/// admits that cannot fit fails the conversion; a foreign one is never moved.
pub(crate) fn fit_note_to_view(
    document: &Document,
    annotation: &mut Dictionary,
    view: PdfRect,
    page_rotation: i64,
    source_note: bool,
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
        .and_then(|value| document.resolved(value).ok())
        .and_then(|value| value.as_name().ok());
    let is_popup = subtype == Some(b"Popup");
    if !source_note && !is_popup {
        return Ok(());
    }
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
    // A note root its source page admits must stay one; a foreign one is copied.
    if source_note && pdf_rect_to_note_marker_rect(fitted, view, page_rotation).is_err() {
        return Err("cannot keep a note on its output page".into());
    }
    if x1 == rect.x1 && y1 == rect.y1 {
        return Ok(());
    }
    let (centre_x, centre_y) = ((fitted.x1 + fitted.x2) / 2.0, (fitted.y1 + fitted.y2) / 2.0);
    let centred = (view.x1..view.x2).contains(&centre_x) && (view.y1..view.y2).contains(&centre_y);
    if !(is_popup || centred) {
        return Ok(());
    }
    annotation.set("Rect", rect_object(fitted));
    Ok(())
}
