//! Catalog and trailer policy of a split output, distinct from combine edits.
use super::*;
pub(crate) mod split_forms;
mod split_tags;
use crate::catalog::has_valid_oc_properties;
use crate::split_navigation::{
    remap_split_catalog, remap_split_navigation, split_destination_mapper,
};
use crate::split_output::{split_annotation_matrix, SplitAnnotationMap, SplitOutputPage};
use lopdf::dictionary;

/// Source publishes the split; assembly carries navigation, labels and page
/// dependencies into qpdf. Final raster replacements use the same catalog map.
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SplitCatalog {
    #[default]
    Source,
    Assembly,
}

/// The catalog a split page tree writes, with its page tree set to `pages_id`.
/// The source catalog keeps outlines, names, viewer preferences, metadata and
/// optional content. Optional content whose graph is incomplete or lacks valid
/// groups is dropped; a graph beyond the traversal ceilings fails the split.
pub(crate) fn split_catalog(
    source: &Document,
    target: &mut Document,
    catalog_id: ObjectId,
    pages_id: ObjectId,
    kind: SplitCatalog,
    pages: &mut [SplitOutputPage],
    annotations: &SplitAnnotationMap,
) -> Result<Dictionary> {
    let source_catalog = source.get_dictionary(catalog_id)?;
    let mut catalog = match kind {
        SplitCatalog::Source => source_catalog.clone(),
        SplitCatalog::Assembly => dictionary! {"Type" => "Catalog"},
    };
    catalog.remove(b"OCProperties");
    if has_valid_oc_properties(source, catalog_id)? {
        if let Ok(properties) = source_catalog.get(b"OCProperties") {
            catalog.set("OCProperties", properties.clone());
        }
    }
    let geometry = pages
        .iter()
        .enumerate()
        .map(|(index, page)| TextLayerInstruction {
            source_page_index: 0,
            output_page_index: index,
            matrix: split_annotation_matrix(page.transform),
            source_region: None,
            filter_to_output_page: false,
            normalize_greek_micro_sign: false,
            link_only: true,
            unmapped_geometry: false,
        })
        .collect::<Vec<_>>();
    let navigation = pages
        .iter()
        .zip(&geometry)
        .map(|(page, instruction)| (page.source_id, page.id, instruction, page.crop))
        .collect::<Vec<_>>();
    remap_split_catalog(source, target, &mut catalog, kind, &navigation)?;
    if matches!(kind, SplitCatalog::Source) {
        let remap = split_destination_mapper(source, &navigation);
        for page in pages.iter() {
            if let Ok(annots) = page.page.get(b"Annots").and_then(Object::as_array) {
                for annotation in annots {
                    let Ok(id) = annotation.as_reference() else {
                        continue;
                    };
                    if let Ok(annotation) = target.get_dictionary_mut(id) {
                        if annotation.get(b"Subtype").and_then(Object::as_name).ok()
                            == Some(b"Link")
                        {
                            remap_split_navigation(source, annotation, b"Dest", &remap)?;
                            annotation.remove(RETAINED_DESTINATION_PAGE_KEY);
                        }
                    }
                }
            }
        }
    }
    if let Some(form) = split_forms::split_form(source, target, annotations)? {
        catalog.set("AcroForm", form);
    }
    split_tags::split_tags(source, target, &mut catalog, kind, pages, annotations)?;
    catalog.set("Pages", pages_id);
    Ok(catalog)
}

/// Provenance augments retained source Info; an assembly has stamp-only Info.
pub(crate) fn stamp_split_info(
    source: &Document,
    target: &mut Document,
    instructions: &SplitPagesFile,
) -> Result<()> {
    if let Some(stamp) = instructions.provenance_stamp_hex.as_deref() {
        let mut info = match instructions.catalog {
            SplitCatalog::Source => source
                .trailer
                .get(b"Info")
                .ok()
                .filter(|info| !info.is_null())
                .map(|info| -> Result<Dictionary> { Ok(source.resolved(info)?.as_dict()?.clone()) })
                .transpose()?
                .unwrap_or_default(),
            SplitCatalog::Assembly => Dictionary::new(),
        };
        info.set(
            "EVBScanCleanup",
            Object::string_literal(stamp.as_bytes().to_vec()),
        );
        let id = target.add_object(info);
        target.trailer.set("Info", id);
    }
    Ok(())
}
