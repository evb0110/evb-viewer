//! Missing print appearances: what a stock reader draws for a printed
//! annotation without a usable /AP, stored as its normal appearance.

use super::*;

#[path = "print_free_text.rs"]
mod free_text;
use free_text::missing_free_text_appearance;

/// The stored normal appearance print draws. Structural sources keep stream
/// dictionaries without reading their bytes.
pub(super) fn annotation_normal_appearance<'a>(
    document: &'a impl PdfObjectSource,
    annotation: &'a Dictionary,
) -> Option<&'a Stream> {
    let appearances = document
        .resolved(annotation.get(b"AP").ok()?)
        .ok()?
        .as_dict()
        .ok()?;
    let normal = document.resolved(appearances.get(b"N").ok()?).ok()?;
    let stream = if let Ok(stream) = normal.as_stream() {
        stream
    } else {
        let state = document
            .resolved(annotation.get(b"AS").ok()?)
            .ok()?
            .as_name()
            .ok()?;
        document
            .resolved(normal.as_dict().ok()?.get(state).ok()?)
            .ok()?
            .as_stream()
            .ok()?
    };
    if !stream.content.is_empty() {
        let bbox = numbers(document, stream.dict.get(b"BBox").ok()?, 4)?;
        if !bbox.iter().all(|v| v.is_finite()) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] {
            return None;
        }
        if let Ok(matrix) = stream.dict.get(b"Matrix") {
            let m = numbers(document, matrix, 6)?;
            if !m.iter().all(|v| v.is_finite()) || m[0] * m[3] - m[1] * m[2] == 0.0 {
                return None;
            }
        }
    }
    Some(stream)
}

/// The subtypes EVB draws itself: FreeText and those `synthesized_appearance`
/// draws. A printer draws any other one, such as a form field from its value.
const EVB_DRAWN_SUBTYPES: [&[u8]; 8] = [
    b"FreeText",
    b"Text",
    b"Square",
    b"Circle",
    b"Line",
    b"PolyLine",
    b"Polygon",
    b"Ink",
];

/// Gives each printed annotation on the page that lacks a usable normal
/// appearance the one a stock reader would draw, with the annotation's opacity
/// and blend mode inside it, as readers expect of a stored appearance. Without
/// `every_subtype` only the subtypes EVB draws get one; composition flattens
/// every subtype and draws the rest as a plain rectangle. Returns the objects it
/// rewrote: indirect annotations, or the page or /Annots array holding a direct
/// one. An annotation with no drawable geometry is unchanged.
pub(crate) fn materialize_print_appearances(
    document: &mut Document,
    page_id: ObjectId,
    text_font: &mut Option<ObjectId>,
    every_subtype: bool,
) -> Result<Vec<ObjectId>> {
    let Ok(annots) = document.get_dictionary(page_id)?.get(b"Annots").cloned() else {
        return Ok(Vec::new());
    };
    let (array_id, mut items) = match document.dereference(&annots)? {
        (array_id, Object::Array(items)) => (array_id, items.clone()),
        _ => return Ok(Vec::new()),
    };
    let mut changed = Vec::new();
    let mut direct_changed = false;
    for item in &mut items {
        let Some(mut annotation) = match &*item {
            Object::Reference(id) => document.get_dictionary(*id).ok().cloned(),
            Object::Dictionary(annotation) => Some(annotation.clone()),
            _ => None,
        }
        .filter(|annotation| {
            let subtype = annotation.get(b"Subtype").and_then(Object::as_name);
            is_printed(document, annotation)
                && (every_subtype || subtype.is_ok_and(|s| EVB_DRAWN_SUBTYPES.contains(&s)))
                && annotation_normal_appearance(document, annotation).is_none()
        }) else {
            continue;
        };
        let free_text =
            annotation.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"FreeText");
        let Some(appearance) = free_text
            .then(|| missing_free_text_appearance(document, &annotation, page_id, text_font).ok())
            .flatten()
            .or_else(|| synthesized_appearance(document, &mut annotation))
        else {
            continue;
        };
        if let Some(state) = annotation_graphics_state(document, &annotation) {
            let stream = document.get_object_mut(appearance)?.as_stream_mut()?;
            if let Ok(Object::Dictionary(resources)) = stream.dict.get_mut(b"Resources") {
                resources.set(
                    "ExtGState",
                    Dictionary::from_iter([("PrintAnnot", Object::Dictionary(state))]),
                );
            }
            let content = [b"/PrintAnnot gs\n".as_slice(), &stream.content].concat();
            stream.set_content(content);
        }
        annotation.remove(b"CA");
        annotation.remove(b"BM");
        annotation.set(
            "AP",
            Dictionary::from_iter([("N", Object::Reference(appearance))]),
        );
        if let Object::Reference(id) = item {
            changed.push(*id);
            document.objects.insert(*id, Object::Dictionary(annotation));
        } else {
            *item = Object::Dictionary(annotation);
            direct_changed = true;
        }
    }
    if direct_changed {
        changed.push(array_id.unwrap_or(page_id));
        if let Some(array_id) = array_id {
            document.objects.insert(array_id, Object::Array(items));
        } else {
            document.get_dictionary_mut(page_id)?.set("Annots", items);
        }
    }
    Ok(changed)
}

/// Auto printing keeps every page, box, rotation and content stream: one
/// incremental revision adds only the missing appearances and the objects that
/// name them, so memory follows those annotations rather than the document.
/// Nothing is written when no printed annotation lacks an appearance; the
/// caller then prints the source itself.
pub(crate) fn write_print_appearances_path(
    input_path: &Path,
    output_path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let mut incremental = load_dictionary_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    let document = &mut incremental.previous_document;
    assert_plaintext_base(document, "Encrypted PDFs cannot be laid out for printing")?;
    let base_max_id = document.max_id;
    let mut text_font = None;
    let mut changed = Vec::new();
    for page_id in document.get_pages().into_values() {
        changed.extend(materialize_print_appearances(
            document,
            page_id,
            &mut text_font,
            false,
        )?);
    }
    if changed.is_empty() {
        return Ok(());
    }
    // The synthesized objects move into the revision with the rewritten ones.
    let added = document.objects.split_off(&(base_max_id + 1, 0));
    let revision = &mut incremental.new_document;
    revision.objects.extend(added);
    for id in changed {
        revision
            .objects
            .insert(id, document.get_object(id)?.clone());
    }
    revision.max_id = document.max_id;
    revision.version = document.version.clone();
    let revision_bytes = build_incremental_revision(&mut incremental)?;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);
    with_staged_incremental_output(input_path, output_path, |staged_output_path| {
        write_incremental_revision(
            staged_output_path,
            &incremental,
            &revision_bytes,
            &expected_object_ids,
        )
    })
}
