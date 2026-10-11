//! Catalog and trailer policy of a split output, distinct from combine edits.
use super::*;
use crate::catalog::{has_valid_oc_properties, read_number_tree, CatalogWalkState};
use crate::internal_destinations::{remap_internal_destination, resolve_destination};
use crate::split_output::{split_annotation_matrix, SplitAnnotationMap, SplitOutputPage};
use lopdf::dictionary;

/// Source mode publishes the split. Assembly carries page labels, forms and
/// optional-content configuration needed by preserved pages into qpdf.
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
    if let Ok(labels) = source_catalog.get(b"PageLabels") {
        let mut ranges = Vec::new();
        read_number_tree(source, labels, 0, &mut CatalogWalkState::new(), &mut ranges)?;
        ranges.sort_by_key(|(index, _)| *index);
        let source_indices = page_index_by_id(&source.get_pages());
        let mut nums = Vec::with_capacity(pages.len() * 2);
        for (index, page) in pages.iter().enumerate() {
            let source_index = i64::try_from(source_indices[&page.source_id])?;
            let mut label = match ranges
                .iter()
                .rev()
                .find(|(start, _)| *start <= source_index)
            {
                Some((start, value)) => {
                    let mut label = source.resolved(value)?.as_dict()?.clone();
                    if label.has(b"S") {
                        let number = label
                            .get(b"St")
                            .ok()
                            .map(|value| -> Result<i64> { Ok(source.resolved(value)?.as_i64()?) })
                            .transpose()?
                            .unwrap_or(1);
                        label.set(
                            "St",
                            number
                                .checked_add(source_index - start)
                                .ok_or("Page label number overflow")?,
                        );
                    }
                    label
                }
                None => dictionary! {"S" => "D", "St" => source_index + 1},
            };
            // Materialize scalar label entries, not source number-tree identities.
            for key in [b"S".as_slice(), b"P", b"St"] {
                if let Ok(value) = label.get(key) {
                    label.set(key, source.resolved(value)?.clone());
                }
            }
            nums.extend([Object::Integer(i64::try_from(index)?), label.into()]);
        }
        catalog.set("PageLabels", dictionary! {"Nums" => nums});
    }
    if matches!(kind, SplitCatalog::Source) {
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
        let mut by_source: HashMap<ObjectId, Vec<OverlayPage<'_>>> = HashMap::new();
        for (page, instruction) in pages.iter().zip(&geometry) {
            by_source.entry(page.source_id).or_default().push((
                page.source_id,
                page.id,
                instruction,
                page.crop,
            ));
        }
        let remap = |destination: &Object| -> Result<Option<Object>> {
            let Some(array) = resolve_destination(source, destination)? else {
                return Ok(None);
            };
            let id = array
                .first()
                .ok_or("Missing destination page")?
                .as_reference()?;
            let Some(outputs) = by_source.get(&id) else {
                return Ok(None);
            };
            let selected = outputs
                .iter()
                .find(|page| split_destination_in_view(source, &array, page));
            match selected {
                Some(page) => remap_internal_destination(
                    source,
                    &Object::Array(array),
                    std::slice::from_ref(page),
                ),
                None => Ok(None),
            }
        };
        if let Ok(dests) = source_catalog.get(b"Dests") {
            let mut mapped = Dictionary::new();
            for (key, destination) in source.resolved(dests)?.as_dict()?.iter() {
                if let Some(destination) = remap(destination)? {
                    mapped.set(key.clone(), destination);
                }
            }
            catalog.set("Dests", mapped);
        }
        if let Ok(names) = source_catalog.get(b"Names") {
            let mut names = source.resolved(names)?.as_dict()?.clone();
            if let Ok(tree) = names.get(b"Dests") {
                let mut pairs = Vec::new();
                split_destination_names(
                    source,
                    tree,
                    &remap,
                    &mut pairs,
                    &mut CatalogWalkState::new(),
                    0,
                )?;
                if pairs.is_empty() {
                    names.remove(b"Dests");
                } else {
                    names.set("Dests", dictionary! {"Names" => pairs});
                }
            }
            catalog.set("Names", names);
        }
        if let Ok(outlines) = source_catalog.get(b"Outlines") {
            split_outlines(source, target, outlines, &remap)?;
        }
        if let Some(action) = catalog.remove(b"OpenAction") {
            let action = source.resolved(&action)?.clone();
            if let Object::Dictionary(mut action) = action {
                if goto_destination(source, &action).is_some() {
                    remap_split_navigation(source, &mut action, b"D", &remap)?;
                }
                if !action
                    .get(b"S")
                    .and_then(Object::as_name)
                    .is_ok_and(|kind| kind == b"GoTo")
                    || action.has(b"D")
                {
                    catalog.set("OpenAction", action);
                }
            } else if let Some(destination) = remap(&action)? {
                catalog.set("OpenAction", destination);
            }
        }
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

/// Whole-page targets choose the first surviving output. Coordinates select
/// the first output containing the point, including repeated source pages.
fn split_destination_in_view(source: &Document, array: &[Object], page: &OverlayPage<'_>) -> bool {
    let number = |index: usize| {
        array
            .get(index)
            .and_then(|value| source.resolved(value).ok())
            .and_then(|value| value.as_float().ok())
            .map(f64::from)
    };
    let mode = array
        .get(1)
        .and_then(|value| source.resolved(value).ok())
        .and_then(|value| value.as_name().ok());
    let (x, y) = match mode {
        Some(b"XYZ") => (number(2), number(3)),
        Some(b"FitH" | b"FitBH") => (None, number(2)),
        Some(b"FitV" | b"FitBV") => (number(2), None),
        Some(b"FitR") => (
            number(2).zip(number(4)).map(|(a, b)| (a + b) / 2.0),
            number(3).zip(number(5)).map(|(a, b)| (a + b) / 2.0),
        ),
        _ => (None, None),
    };
    x.is_none_or(|x| {
        let x = page.2.matrix[0] * x + page.2.matrix[4];
        x >= page.3.x1 && x <= page.3.x2
    }) && y.is_none_or(|y| {
        let y = page.2.matrix[3] * y + page.2.matrix[5];
        y >= page.3.y1 && y <= page.3.y2
    })
}

fn split_destination_names(
    source: &Document,
    node: &Object,
    remap: &impl Fn(&Object) -> Result<Option<Object>>,
    pairs: &mut Vec<Object>,
    state: &mut CatalogWalkState,
    depth: usize,
) -> Result<()> {
    if depth >= 256 || !state.enter(node) {
        return Err("Split destination name tree exceeds catalog traversal limits".into());
    }
    let node = source.resolved(node)?.as_dict()?;
    if let Ok(names) = node.get(b"Names") {
        for pair in source.resolved(names)?.as_array()?.chunks_exact(2) {
            if pairs.len() >= MAX_COLLECTION_ITEMS * 2 {
                return Err("Split destination name tree exceeds catalog entry limit".into());
            }
            if let Some(destination) = remap(&pair[1])? {
                pairs.extend([source.resolved(&pair[0])?.clone(), destination]);
            }
        }
    }
    if let Ok(kids) = node.get(b"Kids") {
        for kid in source.resolved(kids)?.as_array()? {
            split_destination_names(source, kid, remap, pairs, state, depth + 1)?;
        }
    }
    Ok(())
}

fn remap_split_navigation(
    source: &Document,
    node: &mut Dictionary,
    key: &[u8],
    remap: &impl Fn(&Object) -> Result<Option<Object>>,
) -> Result<()> {
    if let Some(destination) = node.remove(key) {
        if let Some(destination) = remap(&destination)? {
            node.set(key, destination);
        }
    }
    if let Ok(action) = node.get(b"A") {
        let mut action = source.resolved(action)?.as_dict()?.clone();
        if goto_destination(source, &action).is_some() {
            match remap(action.get(b"D")?)? {
                Some(destination) => {
                    action.set("D", destination);
                    node.set("A", action);
                }
                None => {
                    node.remove(b"A");
                }
            }
        }
    }
    Ok(())
}

fn split_outlines(
    source: &Document,
    target: &mut Document,
    root: &Object,
    remap: &impl Fn(&Object) -> Result<Option<Object>>,
) -> Result<()> {
    let mut stack = vec![root.clone()];
    let mut state = CatalogWalkState::new();
    while let Some(object) = stack.pop() {
        if !state.enter(&object) {
            return Err("Split outlines contain a cycle or exceed catalog traversal limits".into());
        }
        let id = object.as_reference()?;
        let mut node = source.get_dictionary(id)?.clone();
        for key in [b"First".as_slice(), b"Next"] {
            if let Ok(child) = node.get(key) {
                stack.push(child.clone());
            }
        }
        remap_split_navigation(source, &mut node, b"Dest", remap)?;
        target.set_object(id, node);
    }
    Ok(())
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
