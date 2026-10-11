//! Catalog and trailer policy of a split output, distinct from combine edits.
use super::*;
use crate::catalog::{has_valid_oc_properties, CatalogWalkState};
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
    pages: &[SplitOutputPage],
    annotations: &SplitAnnotationMap,
) -> Result<Dictionary> {
    let source_catalog = source.get_dictionary(catalog_id)?;
    let mut catalog = match kind {
        SplitCatalog::Source => source_catalog.clone(),
        SplitCatalog::Assembly => dictionary! {"Type" => "Catalog"},
    };
    if has_valid_oc_properties(source, catalog_id)? {
        if let Ok(properties) = source_catalog.get(b"OCProperties") {
            catalog.set("OCProperties", properties.clone());
        }
    } else {
        catalog.remove(b"OCProperties");
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
        for page in pages {
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
    if let Ok(form) = source_catalog.get(b"AcroForm") {
        let mut form = source.resolved(form)?.as_dict()?.clone();
        let mut state = CatalogWalkState::new();
        let mut fields = HashMap::new();
        let mut roots = Vec::new();
        for field in source.resolved(form.get(b"Fields")?)?.as_array()? {
            if let Some(field) = split_form_field(
                source,
                target,
                field,
                None,
                annotations,
                &mut fields,
                &mut state,
                0,
            )? {
                roots.push(field.into());
            }
        }
        form.set("Fields", roots);
        if let Ok(order) = form.get(b"CO") {
            let order = source
                .resolved(order)?
                .as_array()?
                .iter()
                .filter_map(|field| {
                    field
                        .as_reference()
                        .ok()
                        .and_then(|id| fields.get(&id))
                        .copied()
                        .map(Object::Reference)
                })
                .collect::<Vec<_>>();
            form.set("CO", order);
        }
        catalog.set("AcroForm", form);
    }
    // Crop/split outputs duplicate MCIDs and change page/annotation identity.
    // Without a rebuilt ParentTree/MCR/OBJR graph, retaining Marked is false.
    catalog.remove(b"StructTreeRoot");
    catalog.remove(b"MarkInfo");
    for copies in annotations.values() {
        for (_, id) in copies {
            target.get_dictionary_mut(*id)?.remove(b"StructParent");
        }
    }
    catalog.set("Pages", pages_id);
    Ok(catalog)
}

const FIELD_KEYS: &[&[u8]] = &[
    b"FT", b"T", b"TU", b"TM", b"Ff", b"V", b"DV", b"DA", b"Q", b"DS", b"RV", b"Opt", b"MaxLen",
    b"TI", b"I", b"Lock", b"SV",
];

fn split_form_field(
    source: &Document,
    target: &mut Document,
    object: &Object,
    parent: Option<ObjectId>,
    annotations: &SplitAnnotationMap,
    fields: &mut HashMap<ObjectId, ObjectId>,
    state: &mut CatalogWalkState,
    depth: usize,
) -> Result<Option<ObjectId>> {
    if depth >= 256 || !state.enter(object) {
        return Err("Split field tree contains a cycle or exceeds catalog traversal limits".into());
    }
    let (source_id, field) = source.dereference(object)?;
    let mut field = field.as_dict()?.clone();
    let widget = field
        .get(b"Subtype")
        .ok()
        .and_then(|value| source.resolved(value).ok())
        .and_then(|value| value.as_name().ok())
        == Some(b"Widget");
    let id = if widget {
        let copies = source_id.and_then(|id| annotations.get(&id));
        let Some(copies) = copies.filter(|copies| !copies.is_empty()) else {
            return Ok(None);
        };
        if copies.len() == 1 {
            let id = copies[0].1;
            let widget = target.get_dictionary_mut(id)?;
            if let Some(parent) = parent {
                widget.set("Parent", parent);
            } else {
                widget.remove(b"Parent");
            }
            if let Some(source_id) = source_id {
                fields.insert(source_id, id);
            }
            return Ok(Some(id));
        }
        // A duplicated combined field/widget becomes one field with multiple
        // widget children, preserving its name and value exactly once.
        let id = target.new_object_id();
        let mut combined = Dictionary::new();
        for key in FIELD_KEYS {
            if let Ok(value) = field.get(key) {
                combined.set(key.to_vec(), value.clone());
            }
        }
        if let Ok(actions) = field.get(b"AA") {
            combined.set("AA", actions.clone());
        }
        let mut kids = Vec::new();
        for (_, widget) in copies {
            let dictionary = target.get_dictionary_mut(*widget)?;
            for key in FIELD_KEYS {
                dictionary.remove(key);
            }
            dictionary.set("Parent", id);
            kids.push(Object::Reference(*widget));
        }
        combined.set("Kids", kids);
        field = combined;
        id
    } else {
        let id = target.new_object_id();
        if let Ok(kids) = field.get(b"Kids") {
            let mut kept = Vec::new();
            for child in source.resolved(kids)?.as_array()? {
                if let Some(child) = split_form_field(
                    source,
                    target,
                    child,
                    Some(id),
                    annotations,
                    fields,
                    state,
                    depth + 1,
                )? {
                    kept.push(Object::Reference(child));
                }
            }
            if kept.is_empty() {
                return Ok(None);
            }
            field.set("Kids", kept);
        }
        id
    };
    if let Some(parent) = parent {
        field.set("Parent", parent);
    } else {
        field.remove(b"Parent");
    }
    if let Some(source_id) = source_id {
        fields.insert(source_id, id);
    }
    target.set_object(id, field);
    Ok(Some(id))
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
