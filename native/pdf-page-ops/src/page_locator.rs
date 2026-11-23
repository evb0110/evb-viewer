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
}

fn page_index_error(index: u32) -> Box<dyn Error> {
    domain_error(
        NativeErrorCode::InvalidRequest,
        format!("Page index {index} is outside the PDF page tree"),
    )
}
