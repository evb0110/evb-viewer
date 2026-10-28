//! Complete page-tree ownership discovery before a sparse deletion load.
use super::*;

pub(crate) struct DeleteScan {
    pub(crate) document: Document,
    pub(crate) listing: AnnotationListing,
    pub(crate) pages: Vec<ObjectId>,
}

impl DeleteScan {
    /// `candidates` narrows the search to the objects a key index names;
    /// without it, a referenced target is looked up directly (every caller's
    /// `matches` rejects other objects then) and a named one is searched for.
    fn unique_target(
        &self,
        reference: Option<ObjectId>,
        candidates: Option<&[ObjectId]>,
        matches: impl Fn(ObjectId, &Dictionary) -> bool,
        required: bool,
    ) -> Result<Option<ObjectId>> {
        let searched: BTreeSet<ObjectId> = match (candidates, reference) {
            (Some(ids), _) => ids.iter().copied().chain(reference).collect(),
            (None, Some(id)) => BTreeSet::from([id]),
            (None, None) => self.listing.pages.keys().copied().collect(),
        };
        let mut found = searched.into_iter().filter(|id| {
            self.listing.pages.contains_key(id)
                && (Some(*id) == reference
                    || self
                        .document
                        .get_dictionary(*id)
                        .is_ok_and(|dict| matches(*id, dict)))
        });
        let target = found.next();
        if found.next().is_some()
            || (required && target.is_none())
            || reference.is_some_and(|id| target != Some(id))
        {
            return Err("Annotation scan target is ambiguous or has no page-tree owner".into());
        }
        Ok(target)
    }

    fn mutation_targets(
        &self,
        mutations: &NativeMutationsFile,
    ) -> Result<(Vec<ObjectId>, Vec<ObjectId>)> {
        let reference = |id: Option<&str>| -> Result<Option<ObjectId>> {
            id.map(|id| {
                parse_pdfjs_annotation_object_id(id)
                    .ok_or_else(|| "Invalid annotation reference".into())
            })
            .transpose()
        };
        let mut deleted = Vec::new();
        let mut touched = Vec::new();
        for update in mutations
            .updates
            .iter()
            .map(|update| (update.object_number, update.generation_number))
            .chain(
                mutations
                    .geometry_updates
                    .iter()
                    .map(|update| (update.object_number, update.generation_number)),
            )
        {
            touched.extend(self.unique_target(Some(update), None, |_, _| false, true)?);
        }
        for delete in &mutations.deletes {
            let id = delete.object_number.zip(delete.generation_number);
            let target = self.unique_target(
                id,
                None,
                |candidate, dict| {
                    annotation_subtype(dict) != "popup"
                        && id.is_none()
                        && annotation_matches_stable_delete_name(&self.document, candidate, delete)
                            .unwrap_or(false)
                },
                true,
            )?;
            deleted.extend(target);
        }
        for editor in &mutations.text_boxes {
            let id = reference(editor.annotation_id.as_deref())?;
            touched.extend(self.unique_target(
                id,
                None,
                |_, dict| {
                    id.is_none()
                        && annotation_subtype(dict) == "freetext"
                        && read_annotation_name(dict).is_some_and(|name| {
                            annotation_names_match(
                                &name,
                                &text_box_name(editor),
                                &["evb-freetext:"],
                            )
                        })
                },
                id.is_some(),
            )?);
        }
        if let Some(markup) = &mutations.markup {
            for hint in &markup.hints {
                let id = normalize_hint_annotation_ref(hint)
                    .as_deref()
                    .and_then(parse_pdfjs_annotation_object_id);
                let name = markup_annotation_name(hint);
                touched.extend(self.unique_target(
                    id,
                    None,
                    |_, dict| {
                        id.is_none()
                            && canonical_markup_subtype(dict).is_some()
                            && name.as_ref().is_some_and(|name| {
                                read_annotation_name(dict).is_some_and(|existing| {
                                    annotation_names_match(&existing, name, &["evb-markup:"])
                                })
                            })
                    },
                    !is_new_markup_hint_data(hint),
                )?);
            }
        }
        if let Some(shapes) = &mutations.shapes {
            // One pass indexes the managed shapes by stable key; each shape
            // target then checks only the objects its key names.
            let mut by_key: HashMap<String, Vec<ObjectId>> = HashMap::new();
            for id in self.listing.pages.keys() {
                let Ok(dict) = self.document.get_dictionary(*id) else {
                    continue;
                };
                if is_supported_shape_subtype(&annotation_subtype(dict)) {
                    if let Some(key) = read_shape_stable_key(dict) {
                        by_key.entry(key).or_default().push(*id);
                    }
                }
            }
            let owners = |key: Option<&str>| {
                key.and_then(|key| by_key.get(key))
                    .map_or(&[][..], Vec::as_slice)
            };
            for shape in &shapes.shapes {
                let id = reference(shape.annotation_id.as_deref())?;
                let key = normalize_managed_shape_stable_key(shape.stable_key.as_deref());
                touched.extend(self.unique_target(
                    id,
                    Some(owners(key.as_deref())),
                    |_, _| true,
                    id.is_some(),
                )?);
            }
            for id in &shapes.deleted_annotation_ids {
                deleted.extend(self.unique_target(
                    reference(Some(id))?,
                    None,
                    |_, _| false,
                    true,
                )?);
            }
            for key in &shapes.deleted_stable_keys {
                deleted.extend(self.unique_target(
                    None,
                    Some(owners(Some(key.trim()))),
                    |_, _| true,
                    true,
                )?);
            }
            if shapes.rewrite_shape_state {
                touched.extend(by_key.values().flatten().copied());
            }
        }
        Ok((deleted, touched))
    }

    pub(crate) fn extend_edit(
        &self,
        targets: &[ObjectId],
        touched: &[ObjectId],
        edit: &mut PageLocalEdit,
    ) -> Result<()> {
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
        for target in touched {
            pending.extend(collect_annotation_refs_to_delete(
                &self.document,
                *target,
                &self.listing.replies,
            )?);
        }
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
    let scan = scan_qpdf_annotation_deletes(path, qpdf, &[])?
        .ok_or("Bundled qpdf library is required for annotation discovery")?;
    let (deleted, touched) = scan.mutation_targets(mutations)?;
    scan.extend_edit(&deleted, &touched, edit)
}

/// The loaded base must reproduce the scan's closure before writing anything.
pub(crate) fn page_local_delete_closure_loaded(
    base: &IncrementalDocument,
    mutations: &NativeMutationsFile,
    edit: &PageLocalEdit,
) -> Result<bool> {
    let source = AppendedRevision::new(base);
    let listing =
        AnnotationListing::new_for_pages(base.get_prev_documents(), source.located_pages());
    let generic = collect_delete_refs(
        base.get_prev_documents(),
        &mutations.deletes,
        &listing.replies,
        source.located_pages(),
    )?;
    let mut actual = HashSet::new();
    for id in &edit.delete_closure {
        actual.extend(collect_annotation_refs_to_delete(
            base.get_prev_documents(),
            *id,
            &listing.replies,
        )?);
    }
    Ok(generic.is_subset(&actual)
        && actual == edit.delete_closure.iter().copied().collect()
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
