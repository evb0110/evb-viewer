use super::*;

/// The terminal owner of an annotation's thread, found by following reply and
/// popup links to the note that every member answers to.
pub(crate) fn thread_owner<'a>(
    source: &'a Document,
    annotation: &'a Dictionary,
    page: ObjectId,
) -> Result<&'a Dictionary> {
    let listed = page_annotation_array(source, source.get_dictionary(page)?)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| entry.as_reference().ok())
        .collect::<HashSet<_>>();
    let mut owner = annotation;
    let mut seen = HashSet::new();
    while let Some((id, parent)) = [b"IRT".as_slice(), b"Parent".as_slice()]
        .into_iter()
        .filter_map(|key| annotation_related_ref(owner, key))
        .filter_map(|id| source.get_dictionary(id).ok().map(|parent| (id, parent)))
        .find(|(id, parent)| {
            parent.has(b"Subtype")
                && (listed.contains(id)
                    || parent.get(b"P").and_then(Object::as_reference).ok() == Some(page))
        })
    {
        if seen.len() >= 127 || !seen.insert(id) {
            return Err("annotation ownership is cyclic or too deep".into());
        }
        owner = parent;
    }
    Ok(owner)
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

pub(crate) fn keep_split_annotation(
    source: &Document,
    output: &crate::split_output::SplitOutputPage,
    annotation: &Dictionary,
) -> Result<bool> {
    let owner = thread_owner(source, annotation, output.source_id)?;
    let subtype = owner
        .get(b"Subtype")
        .ok()
        .and_then(|object| source.resolved(object).ok())
        .and_then(|object| object.as_name().ok());
    let note_owner = matches!(subtype, Some(b"Text" | b"Popup"))
        || is_free_text_note_marker(
            source,
            owner,
            resolve_page_view(source, output.source_id)?,
            resolve_page_rotation(source, output.source_id)?,
        );
    Ok(!note_owner
        || owner_centre_in_crop(
            source,
            owner,
            crate::split_output::split_annotation_matrix(output.transform),
            output.crop,
        ))
}

/// Allocate from all retained page lists before rebinding any thread link.
/// Each related annotation resolves to its listed copy on this output, or to
/// its first listed output on another page. A removed target loses its link,
/// leaving the text intact instead of inventing an unlisted annotation.
pub(crate) fn transform_split_annotations(
    source: &Document,
    target: &mut Document,
    pages: &mut [crate::split_output::SplitOutputPage],
    page_index: &HashMap<ObjectId, usize>,
) -> Result<crate::split_output::SplitAnnotationMap> {
    let (copies, pending) = crate::split_output::allocate_split_annotations(source, target, pages)?;
    for (index, copy_id, mut annotation) in pending {
        let output = &pages[index];
        for key in [b"IRT".as_slice(), b"Parent".as_slice(), b"Popup".as_slice()] {
            let Some(related) = annotation_related_ref(&annotation, key) else {
                continue;
            };
            // Widget /Parent links are field-tree edges, rewritten by the form owner.
            if !source
                .get_dictionary(related)
                .is_ok_and(|member| member.has(b"Subtype"))
            {
                continue;
            }
            match copies.get(&related).and_then(|copies| {
                copies
                    .iter()
                    .find(|(page, _)| *page == output.id)
                    .or_else(|| copies.first())
            }) {
                Some((_, id)) => annotation.set(key, *id),
                None => {
                    annotation.remove(key);
                    if key == b"IRT" {
                        annotation.remove(b"RT");
                    }
                }
            }
        }
        if annotation.has(b"P") {
            annotation.set("P", output.id);
        }
        let note_copy = NoteCopy {
            source,
            source_page_id: output.source_id,
            matrix: crate::split_output::split_annotation_matrix(output.transform),
            view: output.crop,
            rotation: resolve_page_rotation(source, output.source_id)?,
        };
        crate::split_navigation::place_split_copy(
            target,
            &mut annotation,
            source,
            &note_copy,
            page_index,
        )?;
        target.set_object(copy_id, annotation);
    }
    Ok(copies)
}
