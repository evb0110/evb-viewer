//! Rebinds the destinations of links that a preserved page retains, once the
//! output plan is final. Its annotations are placed by `place_split_copy`, which
//! stamps the source page index; this pass maps that index to the output page.

use super::*;
use crate::internal_destinations::remap_internal_destination;

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
