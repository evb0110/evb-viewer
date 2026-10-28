//! Finding pages by number in a page-local load, which reads the page tree
//! only on the way down to the pages an edit names.
use super::*;
use std::collections::BTreeSet;

/// The pages a page-local load found by index, and the page count the page
/// tree declares.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct LocatedPages {
    pub(crate) count: u32,
    pub(crate) ids: BTreeMap<u32, ObjectId>,
}

impl LocatedPages {
    /// The `indexes` of a complete page list, such as qpdf's page-tree walk.
    pub(crate) fn from_list(page_ids: &[ObjectId], indexes: &BTreeSet<u32>) -> Result<Self> {
        Ok(Self {
            count: u32::try_from(page_ids.len())?,
            ids: indexes
                .iter()
                .map(|index| {
                    let page_id = page_ids
                        .get(*index as usize)
                        .ok_or_else(|| page_index_error(*index))?;
                    Ok((*index, *page_id))
                })
                .collect::<Result<_>>()?,
        })
    }

    /// The `indexes` of a loaded page tree, as an eager load numbers them.
    pub(crate) fn resolve(
        document: &impl PdfObjectSource,
        indexes: &BTreeSet<u32>,
    ) -> Result<Self> {
        let resolver = PageTreeResolver::new(document)?;
        Ok(Self {
            count: resolver.page_count(),
            ids: indexes
                .iter()
                .map(|index| {
                    if *index >= resolver.page_count() {
                        return Err(page_index_error(*index));
                    }
                    Ok((*index, resolver.page_id(document, index + 1)?))
                })
                .collect::<Result<_>>()?,
        })
    }

    pub(crate) fn select(&self, indexes: &BTreeSet<u32>) -> Result<BTreeSet<ObjectId>> {
        indexes
            .iter()
            .map(|index| {
                self.ids
                    .get(index)
                    .copied()
                    .ok_or_else(|| page_index_error(*index))
            })
            .collect()
    }
}

fn page_index_error(index: u32) -> Box<dyn Error> {
    domain_error(
        NativeErrorCode::InvalidRequest,
        format!("Page index {index} is outside the PDF page tree"),
    )
}

/// Locates `indexes` by the `/Count` of each page-tree node, reading the nodes
/// on the way down and the kids each one counts past instead of every page.
/// The loaded part of the tree then answers through the resolver an eager load
/// uses. None means it cannot, as for a tree whose counts disagree with its
/// kids, so the caller falls back to qpdf's walk of every page.
#[cfg(any(test, not(target_family = "wasm")))]
pub(crate) fn locate_pages_by_count(
    document: &mut Document,
    indexes: &BTreeSet<u32>,
    mut fetch: impl FnMut(&mut Document, &BTreeSet<ObjectId>, &mut usize) -> Result<()>,
) -> Result<Option<LocatedPages>> {
    let mut retained = retained_cost(&Object::Dictionary(document.trailer.clone()))?;
    let mut requested = BTreeSet::new();
    let mut load = |document: &mut Document, ids: &[ObjectId]| -> Result<()> {
        let missing = ids
            .iter()
            .copied()
            .filter(|id| !requested.contains(id) && !document.objects.contains_key(id))
            .collect::<BTreeSet<_>>();
        if !missing.is_empty() {
            fetch(document, &missing, &mut retained)?;
            requested.extend(missing);
        }
        Ok(())
    };
    let Ok(root) = document.trailer.get(b"Root").and_then(Object::as_reference) else {
        return Ok(None);
    };
    load(document, &[root])?;
    let Some(root_pages) = document
        .get_dictionary(root)
        .and_then(|catalog| catalog.get(b"Pages"))
        .and_then(Object::as_reference)
        .ok()
    else {
        return Ok(None);
    };
    // The resolver reads the page count from the root even with no page to find.
    load(document, &[root_pages])?;
    let node_count = |document: &Document, id: ObjectId| {
        let node = document.get_dictionary(id).ok()?;
        match node.get(b"Type").and_then(Object::as_name).ok()? {
            b"Page" => Some(1),
            b"Pages" => u64::try_from(node.get(b"Count").ok()?.as_i64().ok()?).ok(),
            _ => None,
        }
    };
    let mut walked = BTreeMap::new();
    for index in indexes {
        let mut node = root_pages;
        let mut remaining = u64::from(*index);
        for _ in 0..=MAX_PDF_STRUCTURAL_NESTING {
            load(document, &[node])?;
            let Ok(dictionary) = document.get_dictionary(node) else {
                return Ok(None);
            };
            if dictionary.get(b"Type").and_then(Object::as_name).ok() != Some(b"Pages".as_slice()) {
                break;
            }
            let kids = match dictionary.get(b"Kids") {
                Ok(Object::Reference(id)) => {
                    let id = *id;
                    load(document, &[id])?;
                    document
                        .get_object(id)
                        .and_then(Object::as_array)
                        .ok()
                        .cloned()
                }
                Ok(kids) => kids.as_array().ok().cloned(),
                Err(_) => None,
            };
            let Some(kids) = kids
                .unwrap_or_default()
                .iter()
                .map(|kid| kid.as_reference().ok())
                .collect::<Option<Vec<_>>>()
            else {
                return Ok(None);
            };
            // Skip each kid by its count, as PDF.js numbers pages, reading
            // only the kids before the one that holds the page.
            let mut next = None;
            for kid in &kids {
                load(document, &[*kid])?;
                let Some(kid_count) = node_count(document, *kid) else {
                    return Ok(None);
                };
                if remaining < kid_count {
                    next = Some(*kid);
                    break;
                }
                remaining -= kid_count;
            }
            let Some(next) = next else {
                break;
            };
            node = next;
        }
        if remaining == 0 && node_count(document, node) == Some(1) {
            walked.insert(*index, node);
        }
    }
    // The resolver indexes a node's kids directly when its /Count is their
    // number. A tree whose counts disagree with its kids can then name
    // another page than the count walk; qpdf's walk of the pages decides.
    Ok(LocatedPages::resolve(document, indexes)
        .ok()
        .filter(|located| located.ids == walked))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A catalog over two /Pages nodes of 50 pages each; object 1 is the catalog.
    fn two_level_page_tree() -> Document {
        let mut document = Document::with_version("1.7");
        let mut kids = Vec::new();
        for half in 0..2_u32 {
            let node_id = (3 + half * 51, 0);
            let pages = (1..=50)
                .map(|page| (node_id.0 + page, 0))
                .collect::<Vec<ObjectId>>();
            for page_id in &pages {
                document.objects.insert(
                    *page_id,
                    Object::Dictionary(lopdf::dictionary! {
                        "Type" => "Page",
                        "Parent" => node_id,
                    }),
                );
            }
            document.objects.insert(
                node_id,
                Object::Dictionary(lopdf::dictionary! {
                    "Type" => "Pages",
                    "Parent" => (2, 0),
                    "Count" => 50,
                    "Kids" => pages.into_iter().map(Object::Reference).collect::<Vec<_>>(),
                }),
            );
            kids.push(Object::Reference(node_id));
        }
        document.objects.insert(
            (2, 0),
            Object::Dictionary(
                lopdf::dictionary! { "Type" => "Pages", "Count" => 100, "Kids" => kids },
            ),
        );
        document.objects.insert(
            (1, 0),
            Object::Dictionary(lopdf::dictionary! { "Type" => "Catalog", "Pages" => (2, 0) }),
        );
        document.trailer.set("Root", (1, 0));
        document
    }

    fn locate_in(whole: &Document, indexes: &BTreeSet<u32>) -> (Option<LocatedPages>, Document) {
        let mut partial = Document::with_version("1.7");
        partial.trailer = whole.trailer.clone();
        let located = locate_pages_by_count(&mut partial, indexes, |document, batch, _| {
            for id in batch {
                if let Ok(object) = whole.get_object(*id) {
                    document.objects.insert(*id, object.clone());
                }
            }
            Ok(())
        })
        .unwrap();
        (located, partial)
    }

    #[test]
    fn locates_pages_by_count_reading_only_the_nodes_above_them_and_the_kids_before_them() {
        let whole = two_level_page_tree();
        let indexes = BTreeSet::from([0, 73]);
        let (located, partial) = locate_in(&whole, &indexes);

        assert_eq!(
            located,
            Some(LocatedPages::resolve(&whole, &indexes).unwrap())
        );
        assert_eq!(
            located.unwrap().ids,
            BTreeMap::from([(0, (4, 0)), (73, (78, 0))])
        );
        // The catalog, the root and both halves, page 1, and in the second
        // half the 24 pages up to page 74; none of the other 75 pages.
        assert_eq!(partial.objects.len(), 29);
    }

    #[test]
    fn page_count_location_defers_to_the_page_walk_for_a_tree_it_cannot_read() {
        let mut whole = two_level_page_tree();
        whole
            .get_dictionary_mut((2, 0))
            .unwrap()
            .set("Kids", vec![Object::Reference((3, 0)), Object::Integer(7)]);

        assert_eq!(locate_in(&whole, &BTreeSet::from([73])).0, None);
    }

    #[test]
    fn page_count_location_defers_to_the_page_walk_when_counts_disagree_with_kids() {
        // The root counts three pages over three kids, but its first kid
        // holds two. PDF.js puts page 2 inside that kid; indexing the root's
        // kids directly would name the root's second kid instead.
        let mut whole = two_level_page_tree();
        let first_half = whole.get_dictionary_mut((3, 0)).unwrap();
        first_half.set("Count", 2);
        first_half.set(
            "Kids",
            vec![Object::Reference((4, 0)), Object::Reference((5, 0))],
        );
        whole.get_dictionary_mut((2, 0)).unwrap().set("Count", 3);
        whole.get_dictionary_mut((2, 0)).unwrap().set(
            "Kids",
            vec![
                Object::Reference((3, 0)),
                Object::Reference((55, 0)),
                Object::Reference((56, 0)),
            ],
        );
        for page in [55, 56] {
            whole
                .get_dictionary_mut((page, 0))
                .unwrap()
                .set("Parent", (2, 0));
        }

        assert_eq!(locate_in(&whole, &BTreeSet::from([1])).0, None);
    }
}
