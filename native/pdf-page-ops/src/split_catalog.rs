//! Catalog and trailer policy of a split output, distinct from combine edits.
use super::*;
use crate::catalog::has_valid_oc_properties;

/// Which catalog a split writes. Lossless cleanup publishes the split itself, so
/// it keeps the source's catalog. The compact assembler's split is only the
/// primary input of its qpdf interleave, and the compact output takes its
/// document-level entries from it, so that split writes only its page tree and
/// the source's page labels.
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SplitCatalog {
    #[default]
    Source,
    Assembly,
}

/// The trailer a split writes. A source trailer keeps the source's Info and /ID.
/// The assembly trailer names only the root, so qpdf generates the output /ID
/// and the split's provenance stamp is its only Info.
pub(crate) fn split_trailer(
    source: &Document,
    catalog_id: ObjectId,
    kind: SplitCatalog,
) -> Dictionary {
    match kind {
        SplitCatalog::Source => source.trailer.clone(),
        SplitCatalog::Assembly => {
            let mut trailer = Dictionary::new();
            trailer.set("Root", catalog_id);
            trailer
        }
    }
}

/// The catalog a split page tree writes, with its page tree set to `pages_id`.
/// The source catalog keeps outlines, names, viewer preferences, metadata and
/// optional content. Optional content whose graph is incomplete or lacks valid
/// groups is dropped; a graph beyond the traversal ceilings fails the split.
pub(crate) fn split_catalog(
    source: &Document,
    catalog_id: ObjectId,
    pages_id: ObjectId,
    kind: SplitCatalog,
) -> Result<Dictionary> {
    let source_catalog = source.get_dictionary(catalog_id)?;
    let mut catalog = match kind {
        SplitCatalog::Source => {
            let mut catalog = source_catalog.clone();
            if !has_valid_oc_properties(source, catalog_id)? {
                catalog.remove(b"OCProperties");
            }
            catalog
        }
        SplitCatalog::Assembly => {
            let mut catalog = Dictionary::new();
            catalog.set("Type", "Catalog");
            if let Ok(page_labels) = source_catalog.get(b"PageLabels") {
                catalog.set("PageLabels", page_labels.clone());
            }
            catalog
        }
    };
    catalog.set("Pages", pages_id);
    Ok(catalog)
}
