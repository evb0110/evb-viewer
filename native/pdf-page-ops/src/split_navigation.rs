//! One catalog/navigation map for source splits and final compact assembly.
//! Retained links carry source indexes until all output pages have identities.

use super::*;
use crate::catalog::{read_number_tree, CatalogWalkState};
use crate::internal_destinations::{remap_internal_destination, resolve_destination};
use crate::split_catalog::SplitCatalog;
use lopdf::dictionary;

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

/// The source page index of each page object, read from the page tree once per
/// run. A page object listed twice keeps its first index, as a tree walk would.
pub(crate) fn page_index_by_id(pages: &BTreeMap<u32, ObjectId>) -> HashMap<ObjectId, usize> {
    let mut index = HashMap::with_capacity(pages.len());
    for (number, id) in pages {
        index.entry(*id).or_insert(*number as usize - 1);
    }
    index
}

/// Readies a split copy of a source annotation: its retained destination, then
/// its note placement on the output page.
pub(crate) fn place_split_copy(
    target: &mut Document,
    annotation: &mut Dictionary,
    source: &Document,
    note_copy: &crate::note_placement::NoteCopy,
    page_index: &HashMap<ObjectId, usize>,
) -> Result<()> {
    prepare_retained(source, annotation, page_index)?;
    crate::note_placement::place_note_copy(target, annotation, Some(source), note_copy)
}

/// Readies an annotation that a preserved page retains. Its destination names a
/// source page object, which the split output holds but qpdf renumbers when it
/// interleaves the page. The destination becomes explicit, and the source page
/// index travels with the annotation until the overlay rebinds it. A destination
/// that does not read as a page of the source is left as it is.
pub(crate) fn prepare_retained(
    source: &Document,
    annotation: &mut Dictionary,
    page_index: &HashMap<ObjectId, usize>,
) -> Result<()> {
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
    let Some(&index) = page_index.get(&page_id) else {
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
    source_path: &Path,
    instructions: &TextLayerFile,
    qpdf_path: Option<&Path>,
) -> Result<()> {
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
    let restored = restore_source_catalog(&mut incremental, source_path, instructions, qpdf_path)?;
    if rebound.is_empty() && !restored {
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
    write_incremental_revision(
        output_path,
        &incremental,
        &revision_bytes,
        &expected_object_ids,
    )
}

/// Rebuild navigation once against the final page tree, after qpdf interleaves
/// preserved pages and raster replacements. Structural loading bounds both
/// large sources and outputs without reading their image stream bodies.
fn restore_source_catalog(
    output: &mut IncrementalDocument,
    source_path: &Path,
    instructions: &TextLayerFile,
    qpdf_path: Option<&Path>,
) -> Result<bool> {
    let mut source = load_incremental_pdf_path(source_path, qpdf_path)?.previous_document;
    let resolver = PageTreeResolver::new(&source)?;
    let mut navigation = Document::with_version(source.version.clone());
    navigation.max_id = source.max_id;
    let output_pages = output_plan_pages(&output.previous_document, instructions)?;
    let mut identities = HashMap::new();
    let pages = output_pages
        .iter()
        .map(|page| {
            let source_id = resolver.page_id(
                &source,
                overlay_page_number(page.2.source_page_index, "sourcePageIndex")?,
            )?;
            let id = navigation.new_object_id();
            identities.insert(id, page.1);
            Ok((source_id, id, page.2, page.3))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut catalog = Dictionary::new();
    remap_split_catalog(
        &source,
        &mut navigation,
        &mut catalog,
        SplitCatalog::Assembly,
        &pages,
    )?;
    if catalog.is_empty() {
        return Ok(false);
    }
    // The mapped nodes replace their source identities before graph import.
    for (id, object) in std::mem::take(&mut source.objects) {
        navigation.objects.entry(id).or_insert(object);
    }
    let identity = TextLayerInstruction {
        source_page_index: 0,
        output_page_index: 0,
        matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        source_region: None,
        filter_to_output_page: false,
        normalize_greek_micro_sign: false,
        link_only: true,
        unmapped_geometry: false,
    };
    let identity_pages = pages
        .iter()
        .zip(&output_pages)
        .map(|(mapped, output)| (mapped.1, output.1, &identity, output.3))
        .collect::<Vec<_>>();
    let catalog = crate::text_layer::clone_object_graph(
        &navigation,
        &mut output.new_document,
        &Object::Dictionary(catalog),
        &mut identities,
        &identity_pages,
        &|_, _| Ok(()),
        0,
    )?;
    let root = output
        .previous_document
        .trailer
        .get(b"Root")?
        .as_reference()?;
    let mut final_catalog = output.previous_document.get_dictionary(root)?.clone();
    for (key, value) in catalog.as_dict()?.iter() {
        final_catalog.set(key.clone(), value.clone());
    }
    output.new_document.set_object(root, final_catalog);
    Ok(true)
}

/// Remap navigation and labels from the same final source-to-output geometry.
pub(crate) fn remap_split_catalog(
    source: &Document,
    target: &mut Document,
    catalog: &mut Dictionary,
    kind: SplitCatalog,
    pages: &[OverlayPage<'_>],
) -> Result<()> {
    let source_catalog = source.catalog()?;
    if let Ok(labels) = source_catalog.get(b"PageLabels") {
        let mut ranges = Vec::new();
        read_number_tree(source, labels, 0, &mut CatalogWalkState::new(), &mut ranges)?;
        ranges.sort_by_key(|(index, _)| *index);
        let source_indices = page_index_by_id(&source.get_pages());
        let mut nums = Vec::with_capacity(pages.len() * 2);
        for page in pages {
            let source_index = i64::try_from(source_indices[&page.0])?;
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
            nums.extend([
                Object::Integer(i64::try_from(page.2.output_page_index)?),
                label.into(),
            ]);
        }
        catalog.set("PageLabels", dictionary! {"Nums" => nums});
    }
    let remap = split_destination_mapper(source, pages);
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
        let mut names = match kind {
            SplitCatalog::Source => source.resolved(names)?.as_dict()?.clone(),
            SplitCatalog::Assembly => {
                let mut dests = Dictionary::new();
                if let Ok(tree) = source.resolved(names)?.as_dict()?.get(b"Dests") {
                    dests.set("Dests", tree.clone());
                }
                dests
            }
        };
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
        catalog.set("Outlines", outlines.clone());
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
    Ok(())
}

/// A split chooses the first surviving output containing a destination, so
/// duplicates and removed pages follow one policy in both catalog modes.
pub(crate) fn split_destination_mapper<'a>(
    source: &'a Document,
    pages: &[OverlayPage<'a>],
) -> impl Fn(&Object) -> Result<Option<Object>> + 'a {
    let mut by_source: HashMap<ObjectId, Vec<OverlayPage<'a>>> = HashMap::new();
    for page in pages {
        by_source.entry(page.0).or_default().push(*page);
    }
    move |destination| {
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
        match outputs
            .iter()
            .find(|page| split_destination_in_view(source, &array, page))
        {
            Some(page) => remap_internal_destination(
                source,
                &Object::Array(array),
                std::slice::from_ref(page),
            ),
            None => Ok(None),
        }
    }
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
    if page.2.unmapped_geometry {
        return x.is_none() && y.is_none();
    }
    let (matrix, view) = match page.2.source_region {
        Some(region) => match validate_crop_rect(region.rect) {
            Ok(view) => (region.matrix, view),
            Err(_) => return false,
        },
        None => (page.2.matrix, page.3),
    };
    let term = |factor: f64, coordinate: Option<f64>| {
        if factor == 0.0 {
            Some(0.0)
        } else {
            coordinate.map(|value| factor * value)
        }
    };
    let tx = term(matrix[0], x)
        .zip(term(matrix[2], y))
        .map(|(a, b)| a + b + matrix[4]);
    let ty = term(matrix[1], x)
        .zip(term(matrix[3], y))
        .map(|(a, b)| a + b + matrix[5]);
    tx.is_none_or(|x| x >= view.x1 && x <= view.x2)
        && ty.is_none_or(|y| y >= view.y1 && y <= view.y2)
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

pub(crate) fn remap_split_navigation(
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
