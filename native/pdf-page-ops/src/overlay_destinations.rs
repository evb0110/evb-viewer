use super::*;
use crate::internal_destinations::resolve_destination;
use crate::split_navigation::page_index_by_id;

/// The source document's destinations as source page indices. Built from the
/// structural probe, which reads dictionaries and no stream bodies.
pub(crate) struct OverlayDestinations<'a> {
    probe: &'a Document,
    page_index_by_id: HashMap<ObjectId, usize>,
    /// The source pages an instruction maps. A link to any other page resolves nowhere.
    mapped: HashSet<usize>,
}

impl<'a> OverlayDestinations<'a> {
    pub(crate) fn new(probe: &'a Document, instructions: &TextLayerFile) -> Result<Self> {
        let page_index_by_id = page_index_by_id(&probe.get_pages());
        let mapped = instructions
            .pages
            .iter()
            .map(|instruction| instruction.source_page_index)
            .collect();
        Ok(Self {
            probe,
            page_index_by_id,
            mapped,
        })
    }

    /// The pages a subset extracts for its copied pages: those pages plus every
    /// mapped page their links name, so each link resolves inside the subset.
    /// A subset adds at most `MAX_SOURCE_PAGE_BATCH_PAGES` such pages; a link
    /// past that cap keeps its annotation and loses its navigation, which keeps
    /// one linking page from making the subset too large to extract. A link
    /// that names its target also carries the name, since `--empty` drops the
    /// catalog that defines it.
    pub(crate) fn subset_pages(&self, pages: &[usize]) -> Result<OverlaySubset> {
        let resolver = PageTreeResolver::new(self.probe)?;
        let mut extra = HashSet::new();
        let mut named = Vec::new();
        for &page in pages {
            let page_id =
                resolver.page_id(self.probe, overlay_page_number(page, "sourcePageIndex")?)?;
            let Ok(annotations) = self.probe.get_dictionary(page_id)?.get(b"Annots") else {
                continue;
            };
            for annotation in self.probe.dereference(annotations)?.1.as_array()? {
                let Ok((_, annotation)) = self.probe.dereference(annotation) else {
                    continue;
                };
                let Ok(annotation) = annotation.as_dict() else {
                    continue;
                };
                let Some(destination) = annotation_destination(self.probe, annotation) else {
                    continue;
                };
                let Some(array) = resolve_destination(self.probe, &destination)? else {
                    continue;
                };
                let target = array.first().and_then(|object| object.as_reference().ok());
                if let Some(&index) = target.and_then(|id| self.page_index_by_id.get(&id)) {
                    if !self.mapped.contains(&index) {
                        continue;
                    }
                    if !pages.contains(&index) && !extra.contains(&index) {
                        if extra.len() >= MAX_SOURCE_PAGE_BATCH_PAGES {
                            continue;
                        }
                        extra.insert(index);
                    }
                    if let Object::Name(name) | Object::String(name, _) = &destination {
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
