//! Keeps unchanged structure graphs or reports their removal at publication.
use super::*;

pub(super) fn split_tags(
    source: &Document,
    target: &mut Document,
    catalog: &mut Dictionary,
    kind: SplitCatalog,
    pages: &mut [SplitOutputPage],
    annotations: &SplitAnnotationMap,
) -> Result<()> {
    let source_catalog = source.catalog()?;
    let source_pages = source.get_pages();
    let safe_tags = matches!(kind, SplitCatalog::Source)
        && pages.len() == source_pages.len()
        && pages
            .iter()
            .zip(source_pages.values())
            .all(|(page, source_id)| {
                let Ok(view) = resolve_page_view(source, *source_id) else {
                    return false;
                };
                page.source_id == *source_id
                    && [page.crop.x1, page.crop.y1, page.crop.x2, page.crop.y2]
                        == [view.x1, view.y1, view.x2, view.y2]
                    && split_annotation_matrix(page.transform) == [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
            });
    if safe_tags {
        if let Ok(root) = source_catalog.get(b"StructTreeRoot") {
            // Painted streams keep their source identities in both PDF writers.
            // Structure nodes are cloned so Pg/OBJR references can be remapped.
            let mut identities = source
                .objects
                .iter()
                .filter_map(|(id, object)| {
                    matches!(object, Object::Stream(_)).then_some((*id, *id))
                })
                .collect::<HashMap<_, _>>();
            identities.extend(pages.iter().map(|page| (page.source_id, page.id)));
            identities.extend(
                annotations
                    .iter()
                    .filter_map(|(source, copies)| copies.first().map(|(_, id)| (*source, *id))),
            );
            let root = crate::text_layer::clone_object_graph(
                source,
                target,
                root,
                &mut identities,
                &[],
                &|_, _| Ok(()),
                0,
            )?;
            catalog.set("StructTreeRoot", root);
        }
    } else {
        catalog.remove(b"StructTreeRoot");
        catalog.remove(b"MarkInfo");
        for page in pages.iter_mut() {
            page.page.remove(b"StructParents");
        }
        for copies in annotations.values() {
            for (_, id) in copies {
                target.get_dictionary_mut(*id)?.remove(b"StructParent");
            }
        }
        if matches!(kind, SplitCatalog::Source) && source_catalog.has(b"StructTreeRoot") {
            println!("{}", serde_json::json!({"accessibilityTagsRemoved": true}));
        }
    }
    Ok(())
}
