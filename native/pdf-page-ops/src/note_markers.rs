use super::*;

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
    let pdf_rect = parse_rect(dict.get(b"Rect")?)?;
    let modified_at = dict
        .get(b"M")
        .ok()
        .and_then(pdf_string_to_text)
        .unwrap_or_default();
    convert_free_text_marker_to_text(dict, pdf_rect, &modified_at);
    Ok(())
}
