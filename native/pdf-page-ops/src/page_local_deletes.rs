//! Complete page-tree ownership discovery before a sparse deletion load.
use super::*;

pub(crate) struct DeleteScan {
    pub(crate) document: Document,
    pub(crate) listing: AnnotationListing,
    pub(crate) pages: Vec<ObjectId>,
}

impl DeleteScan {
    pub(crate) fn extend_edit(&self, targets: &[ObjectId], edit: &mut PageLocalEdit) -> Result<()> {
        let mut deleted = HashSet::new();
        for target in targets {
            deleted.extend(collect_annotation_refs_to_delete(
                &self.document,
                *target,
                &self.listing.replies,
            )?);
        }
        let mut thread = HashSet::new();
        let mut pending = deleted.iter().copied().collect::<Vec<_>>();
        // A surviving parent and all its replies must be reparsed together.
        // Walk both directions, including recursive replies and unlisted roots.
        while let Some(id) = pending.pop() {
            if !thread.insert(id) {
                continue;
            }
            if let Ok(dict) = self.document.get_dictionary(id) {
                if let Ok(parent) = dict.get(b"IRT").and_then(Object::as_reference) {
                    pending.push(parent);
                }
            }
            if let Some(replies) = self.listing.replies.get(&id) {
                pending.extend(replies);
            }
        }
        let owners = self.listing.pages_of(&thread);
        for (index, page) in self.pages.iter().enumerate() {
            if owners.contains(page) {
                edit.annotation_pages.insert(u32::try_from(index)?);
            }
        }
        edit.pages.extend(&edit.annotation_pages);
        edit.delete_closure.extend(deleted);
        Ok(())
    }
}

pub(crate) fn extend_page_local_delete_edit(
    path: &Path,
    qpdf: &Path,
    mutations: &NativeMutationsFile,
    edit: &mut PageLocalEdit,
) -> Result<()> {
    // Resolve names with the actual page-local index, including legacy marker
    // recognition. Explicit refs retain the writer's stale-hint compatibility.
    let targets = {
        let base = load_qpdf_page_local_incremental_pdf(path, qpdf, edit)?
            .ok_or("Delete target pages could not be loaded")?;
        let source = AppendedRevision::new(&base);
        let pages = PageLookup::new(&source, source.located_pages())?;
        let mut targets = Vec::new();
        for delete in &mutations.deletes {
            let page = pages.page_id(&source, mutation_page_number(delete.page_index)?)?;
            targets.extend(annotation_delete_targets(
                &build_page_annotation_index(&source, page)?.0,
                delete,
            )?);
        }
        targets
    };
    let scan = scan_qpdf_annotation_deletes(path, qpdf, &targets)?
        .ok_or("Bundled qpdf library is required for deletion discovery")?;
    scan.extend_edit(&targets, edit)
}

/// The loaded base must reproduce the scan's closure before writing anything.
pub(crate) fn page_local_delete_closure_loaded(
    base: &IncrementalDocument,
    mutations: &NativeMutationsFile,
    edit: &PageLocalEdit,
) -> Result<bool> {
    if mutations.deletes.is_empty() {
        return Ok(true);
    }
    let source = AppendedRevision::new(base);
    let listing =
        AnnotationListing::new_for_pages(base.get_prev_documents(), source.located_pages());
    let actual = collect_delete_refs(
        base.get_prev_documents(),
        &mutations.deletes,
        &listing.replies,
        source.located_pages(),
    )?;
    Ok(actual == edit.delete_closure.iter().copied().collect()
        && actual
            .iter()
            .all(|id| base.get_prev_documents().objects.contains_key(id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_scan_listing_and_closures_equal_whole_in_tree_ownership() {
        let mut whole = Document::with_version("1.7");
        whole.trailer.set("Root", (1, 0));
        whole.set_object((1, 0), dictionary! {"Type"=>"Catalog","Pages"=>(2,0)});
        whole.set_object((2,0), dictionary!{"Type"=>"Pages","Count"=>2,"Kids"=>vec![Object::Reference((3,0)),Object::Reference((4,0))]});
        whole.set_object((3,0), dictionary!{"Type"=>"Page","Parent"=>(2,0),"MediaBox"=>vec![Object::Integer(0),Object::Integer(0),Object::Integer(200),Object::Integer(100)],"Annots"=>vec![Object::Reference((10,0)),Object::Reference((11,0)),Object::Reference((14,0))]});
        whole.set_object((4,0), dictionary!{"Type"=>"Page","Parent"=>(2,0),"MediaBox"=>vec![Object::Integer(0),Object::Integer(0),Object::Integer(200),Object::Integer(100)],"Annots"=>vec![Object::Reference((10,0)),Object::Reference((12,0)),Object::Reference((13,0))]});
        whole.set_object(
            (5, 0),
            dictionary! {"Type"=>"Page","Annots"=>vec![Object::Reference((15,0))]},
        );
        for (id, dict) in [
            (
                10,
                dictionary! {"Subtype"=>"Text","NM"=>Object::string_literal("root"),"Popup"=>(11,0),"Contents"=>Object::string_literal("unneeded".repeat(10000))},
            ),
            (11, dictionary! {"Subtype"=>"Popup","Parent"=>(10,0)}),
            (12, dictionary! {"Subtype"=>"Square","IRT"=>(10,0)}),
            (13, dictionary! {"Subtype"=>"Text","IRT"=>(12,0)}),
            (14, dictionary! {"Subtype"=>"Square","Parent"=>(16,0)}),
            (15, dictionary! {"Subtype"=>"Text","IRT"=>(10,0)}),
            (16, dictionary! {"Subtype"=>(17,0)}),
        ] {
            whole.set_object((id, 0), dict);
        }
        let path = std::env::temp_dir().join(format!(
            "delete-scan-{}-{}.pdf",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        whole.set_object((17, 0), Object::Name(b"Text".to_vec()));
        whole.max_id = 17;
        whole.save(&path).unwrap();
        let qpdf = std::env::var_os("QPDF_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("qpdf"));
        let Some(scan) = scan_qpdf_annotation_deletes(&path, &qpdf, &[(10, 0), (14, 0)]).unwrap()
        else {
            fs::remove_file(path).unwrap();
            // Platforms without an adjacent library exercise the whole fallback.
            return;
        };
        fs::remove_file(path).unwrap();
        let located =
            LocatedPages::from_list(&[(3, 0), (4, 0)], &std::collections::BTreeSet::from([0, 1]))
                .unwrap();
        let expected = AnnotationListing::new_for_pages(&whole, Some(&located));
        assert_eq!(scan.listing.pages, expected.pages);
        assert_eq!(scan.listing.replies, expected.replies);
        for id in [(10, 0), (11, 0), (12, 0), (14, 0)] {
            let closure = |source: &Document, listing: &AnnotationListing| {
                collect_annotation_refs_to_delete(source, id, &listing.replies)
                    .unwrap()
                    .into_iter()
                    .collect::<HashSet<_>>()
            };
            assert_eq!(
                closure(&scan.document, &scan.listing),
                closure(&whole, &expected)
            );
        }
        assert!(!scan.document.objects.contains_key(&(15, 0)));
        assert!(scan
            .document
            .get_dictionary((10, 0))
            .unwrap()
            .get(b"Contents")
            .is_err());
        assert!(AnnotationListing::new(&whole).replies[&(10, 0)].contains(&(15, 0)));
        assert!(
            !collect_annotation_refs_to_delete(&scan.document, (14, 0), &scan.listing.replies)
                .unwrap()
                .contains(&(16, 0))
        );
    }
}
