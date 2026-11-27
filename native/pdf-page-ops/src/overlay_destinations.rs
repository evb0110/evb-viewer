use super::*;
use crate::internal_destinations::NamedDestinations;

/// The source document's destinations as source page indices. Built from the
/// structural probe, which reads dictionaries and no stream bodies.
pub(crate) struct OverlayDestinations<'a> {
    probe: &'a Document,
    names: NamedDestinations<'a>,
    page_id_by_index: Vec<ObjectId>,
    page_index_by_id: HashMap<ObjectId, usize>,
    /// The source pages an instruction maps. A link to any other page resolves nowhere.
    mapped: HashSet<usize>,
}

impl<'a> OverlayDestinations<'a> {
    pub(crate) fn new(
        probe: &'a Document,
        source_page_ids: &[ObjectId],
        instructions: &TextLayerFile,
    ) -> Result<Self> {
        let mut page_index_by_id = HashMap::with_capacity(source_page_ids.len());
        for (index, &id) in source_page_ids.iter().enumerate() {
            page_index_by_id.entry(id).or_insert(index);
        }
        let mapped = instructions
            .pages
            .iter()
            .map(|instruction| instruction.source_page_index)
            .collect();
        Ok(Self {
            probe,
            names: NamedDestinations::new(probe),
            page_id_by_index: source_page_ids.to_vec(),
            page_index_by_id,
            mapped,
        })
    }

    pub(crate) fn named_destinations(&self) -> &NamedDestinations<'a> {
        &self.names
    }

    /// The pages a subset extracts for its copied pages: those pages plus every
    /// mapped page their links name, so each link resolves inside the subset.
    /// A subset adds at most `MAX_SOURCE_PAGE_BATCH_PAGES` such pages; a link
    /// past that cap keeps its annotation and loses its navigation, which keeps
    /// one linking page from making the subset too large to extract. A link
    /// that names its target also carries the name, since `--empty` drops the
    /// catalog that defines it.
    pub(crate) fn subset_pages(&self, pages: &[usize]) -> Result<OverlaySubset> {
        let batch_pages = pages.iter().copied().collect::<HashSet<_>>();
        let mut extra = HashSet::new();
        let mut named = Vec::new();
        let mut seen_named: HashSet<Vec<u8>> = HashSet::new();
        let mut visited_annotations: HashSet<ObjectId> = HashSet::new();
        let mut visited_action_ids: HashSet<ObjectId> = HashSet::new();
        for &page in pages {
            let page_number = overlay_page_number(page, "sourcePageIndex")?;
            let page_id = *self.page_id_by_index.get(page).ok_or_else(|| {
                format!(
                    "Page {page_number} is outside the document page range 1-{}",
                    self.page_id_by_index.len()
                )
            })?;
            let Ok(annotations) = self.probe.get_dictionary(page_id)?.get(b"Annots") else {
                continue;
            };
            for annotation in self.probe.dereference(annotations)?.1.as_array()? {
                let Ok((annot_id, annotation)) = self.probe.dereference(annotation) else {
                    continue;
                };
                if let Some(annot_id) = annot_id {
                    if !visited_annotations.insert(annot_id) {
                        continue;
                    }
                }
                let Ok(annotation) = annotation.as_dict() else {
                    continue;
                };
                for destination in
                    annotation_action_destinations(self.probe, annotation, &mut visited_action_ids)
                {
                    let Some(array) = self.names.resolve(destination)? else {
                        continue;
                    };
                    let target = array.first().and_then(|object| object.as_reference().ok());
                    if let Some(&index) = target.and_then(|id| self.page_index_by_id.get(&id)) {
                        if !self.mapped.contains(&index) {
                            continue;
                        }
                        if !batch_pages.contains(&index) && !extra.contains(&index) {
                            if extra.len() >= MAX_SOURCE_PAGE_BATCH_PAGES {
                                continue;
                            }
                            extra.insert(index);
                        }
                        if let Object::Name(name) | Object::String(name, _) = destination {
                            if !seen_named.insert(name.clone()) {
                                continue;
                            }
                            let rest = array[1..]
                                .iter()
                                .map(|object| {
                                    self.probe
                                        .dereference(object)
                                        .map(|(_, value)| value.clone())
                                })
                                .collect::<std::result::Result<Vec<_>, _>>();
                            if let Ok(rest) = rest {
                                named.push(NamedDestination {
                                    name: name.clone(),
                                    page_index: index,
                                    rest,
                                });
                            }
                        }
                    }
                }
            }
        }
        let mut subset = pages.to_vec();
        subset.extend(extra);
        subset.sort_unstable();
        subset.dedup();
        Ok(OverlaySubset {
            pages: subset,
            named,
        })
    }
}

/// Collects every unresolved internal destination reachable from `annotation`,
/// including `/Dest`, `/A`, `/AA`, and chained `/Next` actions (dictionaries or arrays).
/// `visited_ids` is shared across the batch so shared indirect action graphs are
/// walked once rather than once per annotation.
fn annotation_action_destinations<'a>(
    document: &'a Document,
    annotation: &'a Dictionary,
    visited_ids: &mut HashSet<ObjectId>,
) -> Vec<&'a Object> {
    let mut destinations = Vec::new();
    if let Ok(dest) = annotation.get(b"Dest") {
        if let Ok((_, resolved)) = document.dereference(dest) {
            destinations.push(resolved);
        }
    }
    let mut pending = Vec::new();
    if let Ok(root_action) = annotation.get(b"A") {
        pending.push(root_action);
    }
    if let Ok(additional_actions) = annotation.get(b"AA") {
        if let Ok((_, Object::Dictionary(aa_dict))) = document.dereference(additional_actions) {
            for (_, action) in aa_dict.iter() {
                pending.push(action);
            }
        }
    }
    while let Some(item) = pending.pop() {
        let Ok((id, resolved)) = document.dereference(item) else {
            continue;
        };
        if let Some(id) = id {
            if !visited_ids.insert(id) {
                continue;
            }
        }
        match resolved {
            Object::Array(items) => {
                for next_item in items {
                    pending.push(next_item);
                }
            }
            Object::Dictionary(action) => {
                if let Some(dest) = goto_destination(document, action) {
                    if let Ok((_, resolved_dest)) = document.dereference(dest) {
                        destinations.push(resolved_dest);
                    }
                }
                if let Ok(next) = action.get(b"Next") {
                    pending.push(next);
                }
            }
            _ => {}
        }
    }
    destinations
}

/// A named destination that a subset's links resolve. The subset's catalog
/// does not define the name, so the subset defines it as an explicit array.
struct NamedDestination {
    name: Vec<u8>,
    /// The target page's index in the source document.
    page_index: usize,
    /// The destination array after its page, with indirect values resolved.
    rest: Vec<Object>,
}

pub(crate) struct OverlaySubset {
    pub(crate) pages: Vec<usize>,
    named: Vec<NamedDestination>,
}

/// Defines the subset's named destinations in its catalog, each on the
/// subset's copy of its target page.
pub(crate) fn carry_named_destinations(
    source: &mut Document,
    subset: &OverlaySubset,
) -> Result<()> {
    if subset.named.is_empty() {
        return Ok(());
    }
    let resolver = PageTreeResolver::new(source)?;
    let mut dests = Dictionary::new();
    for named in &subset.named {
        let local = subset
            .pages
            .binary_search(&named.page_index)
            .map_err(|_| "overlay-text named destination target is outside its source subset")?;
        let page = resolver.page_id(source, overlay_page_number(local, "sourcePageIndex")?)?;
        let mut array = vec![Object::Reference(page)];
        array.extend(named.rest.iter().cloned());
        dests.set(named.name.clone(), Object::Array(array));
    }
    let root = source.trailer.get(b"Root")?.as_reference()?;
    source.get_dictionary_mut(root)?.set("Dests", dests);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PageTreeResolver;

    #[test]
    fn shared_action_graphs_deduplicate_traversal_and_named_destinations() {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let page0 = doc.new_object_id();
        let page1 = doc.new_object_id();
        let shared_next: Vec<Object> = (0..1_000)
            .map(|_| {
                Object::Dictionary(dictionary! {
                    "S" => "GoTo",
                    "D" => Object::Name(b"SharedTarget".to_vec()),
                })
            })
            .collect();
        let shared_action = doc.add_object(dictionary! {
            "S" => "URI",
            "URI" => Object::string_literal("https://example.test"),
            "Next" => shared_next,
        });
        let annots: Vec<Object> = (0..1_000)
            .map(|_| {
                Object::Reference(doc.add_object(dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Link",
                    "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                    "A" => Object::Reference(shared_action),
                }))
            })
            .collect();
        doc.objects.insert(
            page0,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
                "Annots" => annots,
            }),
        );
        doc.objects.insert(
            page1,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            }),
        );
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page0), Object::Reference(page1)],
                "Count" => 2,
            }),
        );
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
            "Dests" => dictionary! {
                "SharedTarget" => vec![Object::Reference(page1), Object::Name(b"Fit".to_vec())],
            },
        });
        doc.trailer.set("Root", catalog);

        let instructions = TextLayerFile {
            pages: vec![
                TextLayerInstruction {
                    source_page_index: 0,
                    output_page_index: 0,
                    matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                    source_region: None,
                    filter_to_output_page: false,
                    normalize_greek_micro_sign: false,
                    link_only: false,
                    unmapped_geometry: false,
                },
                TextLayerInstruction {
                    source_page_index: 1,
                    output_page_index: 1,
                    matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                    source_region: None,
                    filter_to_output_page: false,
                    normalize_greek_micro_sign: false,
                    link_only: false,
                    unmapped_geometry: false,
                },
            ],
            provenance_stamp_hex: None,
        };
        let tree = PageTreeResolver::validated(&doc).unwrap();
        let destinations =
            OverlayDestinations::new(&doc, tree.validated_pages().unwrap(), &instructions).unwrap();
        let subset = destinations.subset_pages(&[0]).unwrap();
        assert_eq!(subset.pages, vec![0, 1]);
        assert_eq!(subset.named.len(), 1);
        assert_eq!(subset.named[0].name, b"SharedTarget");
    }
}
