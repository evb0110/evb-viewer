//! Rebinds the destinations of links that a preserved page retains, once the
//! output plan is final. Its annotations are placed by `place_split_copy`, which
//! stamps the source page index; this pass maps that index to the output page.

use super::*;
use crate::internal_destinations::{remap_internal_destination, resolve_destination};

/// The `/D` of a GoTo action, the only action whose destination names a page of
/// this document. A remote or launch action's `/D` names something else.
pub(crate) fn goto_destination<'a>(
    document: &Document,
    action: &'a Dictionary,
) -> Option<&'a Object> {
    let (_, kind) = document.dereference(action.get(b"S").ok()?).ok()?;
    if kind.as_name().ok()? != b"GoTo" {
        return None;
    }
    action.get(b"D").ok()
}

/// The page-index key that a retained annotation carries until the overlay
/// rebinds its destination. It is removed when the destination is rebound.
pub(crate) const RETAINED_DESTINATION_PAGE_KEY: &[u8] = b"EVBDestinationPage";

/// Readies a split copy of a source annotation: its retained destination, then
/// its note placement on the output page.
pub(crate) fn place_split_copy(
    target: &mut Document,
    annotation: &mut Dictionary,
    source: &Document,
    note_copy: &crate::note_placement::NoteCopy,
) -> Result<()> {
    prepare_retained(source, annotation)?;
    crate::note_placement::place_note_copy(target, annotation, Some(source), note_copy)
}

/// Readies an annotation that a preserved page retains. Its destination names a
/// source page object, which the split output holds but qpdf renumbers when it
/// interleaves the page. The destination becomes explicit, and the source page
/// index travels with the annotation until the overlay rebinds it. A destination
/// that does not read as a page of the source is left as it is.
pub(crate) fn prepare_retained(source: &Document, annotation: &mut Dictionary) -> Result<()> {
    annotation.remove(RETAINED_DESTINATION_PAGE_KEY);
    // Only a link is retained. A note's navigation stays as it is: a page
    // reference there makes its note recovery read the note as foreign.
    let subtype = annotation
        .get(b"Subtype")
        .ok()
        .and_then(|subtype| source.dereference(subtype).ok())
        .and_then(|(_, subtype)| subtype.as_name().ok());
    if subtype != Some(b"Link") {
        return Ok(());
    }
    let Some((page_id, explicit)) = explicit_retained_destination(source, annotation) else {
        return Ok(());
    };
    let Some(index) = source
        .get_pages()
        .into_iter()
        .find_map(|(number, id)| (id == page_id).then_some(number as usize - 1))
    else {
        return Ok(());
    };
    if annotation.get(b"Dest").is_err() {
        annotation.remove(b"A");
    }
    annotation.set("Dest", Object::Array(explicit));
    annotation.set(RETAINED_DESTINATION_PAGE_KEY, index as i64);
    Ok(())
}

/// The annotation's destination as an explicit array, with its page reference
/// and resolved values, when it names a page object.
fn explicit_retained_destination(
    source: &Document,
    annotation: &Dictionary,
) -> Option<(ObjectId, Vec<Object>)> {
    let destination = annotation_destination(source, annotation)?;
    let array = resolve_destination(source, &destination).ok()??;
    let page_id = array.first()?.as_reference().ok()?;
    let mut explicit = vec![Object::Reference(page_id)];
    for value in &array[1..] {
        explicit.push(source.dereference(value).ok()?.1.clone());
    }
    Some((page_id, explicit))
}

/// The output plan over the output document. A retained destination names its
/// source page by a stand-in id per source index, which the remapper compares
/// but never reads.
fn output_plan_pages<'a>(
    output: &Document,
    instructions: &'a TextLayerFile,
) -> Result<Vec<OverlayPage<'a>>> {
    let resolver = PageTreeResolver::new(output)?;
    instructions
        .pages
        .iter()
        .map(|instruction| {
            let target_number =
                overlay_page_number(instruction.output_page_index, "outputPageIndex")?;
            let target = resolver.page_id(output, target_number)?;
            Ok((
                source_key(instruction.source_page_index)?,
                target,
                instruction,
                resolve_page_view(output, target)?,
            ))
        })
        .collect()
}

fn source_key(source_page_index: usize) -> Result<ObjectId> {
    Ok((
        overlay_page_number(source_page_index, "sourcePageIndex")?,
        0,
    ))
}

/// Rebinds the destinations that preserved pages retain against the final
/// output plan. A destination on a page the output does not show loses only
/// its destination; the annotation and its appearance stay.
pub(crate) fn rebind_retained_destinations(
    output_path: &Path,
    instructions: &TextLayerFile,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    if !instructions
        .pages
        .iter()
        .any(|instruction| instruction.link_only)
    {
        return Ok(());
    }
    let mut incremental = load_incremental_pdf_path(output_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let output = incremental.get_prev_documents();
    let pages = output_plan_pages(output, instructions)?;
    let mut rebound = Vec::new();
    for page in pages.iter().filter(|page| page.2.link_only) {
        let Ok(annots) = output.get_dictionary(page.1)?.get(b"Annots") else {
            continue;
        };
        for entry in output.dereference(annots)?.1.as_array()? {
            let Ok(annotation_id) = entry.as_reference() else {
                continue;
            };
            let mut annotation = output.get_dictionary(annotation_id)?.clone();
            let Some(index) = annotation.remove(RETAINED_DESTINATION_PAGE_KEY) else {
                continue;
            };
            let index = usize::try_from(index.as_i64()?)
                .map_err(|_| "overlay-text retained destination page is invalid")?;
            if let Some(mut array) = annotation
                .get(b"Dest")
                .ok()
                .and_then(|dest| dest.as_array().ok())
                .cloned()
            {
                if let Some(first) = array.first_mut() {
                    *first = Object::Reference(source_key(index)?);
                }
                match remap_internal_destination(output, &Object::Array(array), &pages)? {
                    Some(destination) => annotation.set("Dest", destination),
                    None => {
                        annotation.remove(b"Dest");
                    }
                }
            }
            rebound.push((annotation_id, annotation));
        }
    }
    if rebound.is_empty() {
        return Ok(());
    }
    for (annotation_id, annotation) in rebound {
        incremental
            .new_document
            .set_object(annotation_id, Object::Dictionary(annotation));
    }
    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    let revision_bytes = build_incremental_revision(&mut incremental)?;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);
    with_staged_incremental_output(output_path, output_path, |staged_output_path| {
        write_incremental_revision(
            staged_output_path,
            &incremental,
            &revision_bytes,
            &expected_object_ids,
        )
    })
}
