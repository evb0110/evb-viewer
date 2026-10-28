//! Bounded page-local reads through the bundled qpdf reader.
use super::*;
pub(crate) fn load_page_local(
    path: &Path,
    qpdf: &Path,
    edit: &PageLocalEdit,
) -> Result<Option<(Document, LocatedPages)>> {
    let Some(library) = adjacent_library(qpdf)? else {
        return Ok(None);
    };
    // Whole-object reads never consult the projection purpose.
    let reader = Reader::open(&library, path, QpdfMetadataPurpose::Geometry)?;
    let mut document = Document::with_version(reader.version()?);
    document.trailer = reader.trailer()?;
    // qpdf counts objects only after resolving every one of them. The
    // admitted cross-reference chain bounds object numbers without that.
    let largest_size = path_xref_chain(path, fs::metadata(path)?.len())
        .ok()
        .and_then(|chain| chain.largest_size);
    document.max_id = match largest_size {
        Some(size) => u32::try_from(size.saturating_sub(1))?,
        None => reader.max_object_number()?,
    };
    let fetch = |document: &mut Document, batch: &BTreeSet<ObjectId>, retained: &mut usize| {
        for id in batch {
            // qpdf reads a missing object as null; leave it absent,
            // as the eager reader and the JSON query do.
            let object = reader.object(*id, Context::Value)?;
            if !matches!(object, Object::Null) {
                *retained = charge_retained(*retained, &object)?;
                document.objects.insert(*id, object);
            }
        }
        Ok(())
    };
    // qpdf numbers pages only after reading every page dictionary.
    let located = match locate_pages_by_count(&mut document, &edit.located(), fetch)? {
        Some(located) => located,
        None => LocatedPages::from_list(&reader.page_ids()?, &edit.located())?,
    };
    complete_page_local_objects(&mut document, &located, edit, fetch)?;
    Ok(Some((document, located)))
}
pub(crate) fn scan_deletes(
    path: &Path,
    qpdf: &Path,
    targets: &[ObjectId],
) -> Result<Option<DeleteScan>> {
    let Some(library) = adjacent_library(qpdf)? else {
        return Ok(None);
    };
    let reader = Reader::open(&library, path, QpdfMetadataPurpose::AnnotationIndex)?;
    let pages = delete_page_tree_ids(&reader)?;
    let mut document = Document::new();
    let mut listing = AnnotationListing::default();
    let mut retained = pages.len().saturating_mul(std::mem::size_of::<ObjectId>());
    let mut edges = 0usize;
    let mut pending = targets.to_vec();
    for page in &pages {
        let handle = reader.object_handle(*page)?;
        let annots = reader.handle(unsafe {
            (reader.api.get_key)(reader.data, handle.value, c"/Annots".as_ptr())
        })?;
        let count = unsafe { (reader.api.array_length)(reader.data, annots.value) };
        reader.checkpoint()?;
        if count < 0 {
            return Err(corrupt("Invalid page annotation array"));
        }
        for index in 0..count {
            edges = edges
                .checked_add(1)
                .filter(|count| *count <= MAX_QPDF_OBJECT_ELEMENTS)
                .ok_or_else(|| limited("Delete scan exceeds its annotation ownership ceiling"))?;
            let entry = reader
                .handle(unsafe { (reader.api.array_item)(reader.data, annots.value, index) })?;
            if unsafe { (reader.api.is_indirect)(reader.data, entry.value) } == 0 {
                continue;
            }
            let id = (
                u32::try_from(unsafe { (reader.api.object_id)(reader.data, entry.value) })?,
                u16::try_from(unsafe { (reader.api.generation)(reader.data, entry.value) })?,
            );
            // A generous per-edge charge covers both hash-map ownership and
            // pending IDs; the same aggregate ceiling also charges metadata.
            retained = retained
                .checked_add(QPDF_ESTIMATED_BYTES_PER_VALUE * 4)
                .filter(|bytes| *bytes <= MAX_QPDF_RETAINED_STRUCTURE_BYTES)
                .ok_or_else(|| limited("Delete scan exceeds its retained listing ceiling"))?;
            listing.pages.entry(id).or_default().push(*page);
            pending.push(id);
        }
        reader.checkpoint()?;
    }
    let mut seen = HashSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        if seen.len() > MAX_QPDF_OBJECT_ELEMENTS {
            return Err(limited("Delete scan exceeds its object ceiling"));
        }
        let handle = reader.object_handle(id)?;
        if unsafe { (reader.api.object_type)(reader.data, handle.value) } != 9 {
            reader.checkpoint()?;
            continue;
        }
        let mut dict = Dictionary::new();
        for key in [
            c"/IRT",
            c"/Popup",
            c"/Parent",
            c"/Subtype",
            c"/NM",
            c"/EVBShapeKey",
        ] {
            if unsafe { (reader.api.has_key)(reader.data, handle.value, key.as_ptr()) } == 0 {
                continue;
            }
            let value = reader
                .handle(unsafe { (reader.api.get_key)(reader.data, handle.value, key.as_ptr()) })?;
            let object = reader.typed(value.value, false, 0, &mut 0, &mut 0, Context::Value)?;
            if matches!(key.to_bytes(), b"/IRT" | b"/Popup" | b"/Parent") {
                if let Ok(related) = object.as_reference() {
                    pending.push(related);
                }
            }
            dict.set(&key.to_bytes()[1..], object);
        }
        let object = Object::Dictionary(dict);
        retained = charge_retained(retained, &object)?;
        document.objects.insert(id, object);
        reader.checkpoint()?;
    }
    for id in listing.pages.keys() {
        if let Ok(parent) = document
            .get_dictionary(*id)
            .and_then(|dict| dict.get(b"IRT"))
            .and_then(Object::as_reference)
        {
            listing.replies.entry(parent).or_default().push(*id);
        }
    }
    Ok(Some(DeleteScan {
        document,
        listing,
        pages,
    }))
}

/// Visit /Kids directly: qpdf_get_num_pages also normalizes inherited page
/// attributes and can materialize resources that deletion never reads.
fn delete_page_tree_ids(reader: &Reader) -> Result<Vec<ObjectId>> {
    let trailer = reader.handle(unsafe { (reader.api.trailer)(reader.data) })?;
    let root = reader
        .handle(unsafe { (reader.api.get_key)(reader.data, trailer.value, c"/Root".as_ptr()) })?;
    let pages = reader
        .handle(unsafe { (reader.api.get_key)(reader.data, root.value, c"/Pages".as_ptr()) })?;
    let reference = |value: Handle| -> Result<ObjectId> {
        if unsafe { (reader.api.is_indirect)(reader.data, value) } == 0 {
            return Err(corrupt("Page-tree node is not indirect"));
        }
        Ok((
            u32::try_from(unsafe { (reader.api.object_id)(reader.data, value) })?,
            u16::try_from(unsafe { (reader.api.generation)(reader.data, value) })?,
        ))
    };
    let mut pending = vec![(reference(pages.value)?, 0)];
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    while let Some((id, depth)) = pending.pop() {
        if depth > MAX_PDF_STRUCTURAL_NESTING
            || !seen.insert(id)
            || seen.len() > MAX_QPDF_OBJECT_ELEMENTS
        {
            return Err(limited(
                "Delete page-tree scan exceeds its depth/object ceiling or repeats a node",
            ));
        }
        let node = reader.object_handle(id)?;
        let kind = reader
            .handle(unsafe { (reader.api.get_key)(reader.data, node.value, c"/Type".as_ptr()) })?;
        if unsafe { (reader.api.name_equals)(reader.data, kind.value, c"/Page".as_ptr()) } != 0 {
            if result.len() >= crate::load_policy::MAX_PATH_INPUT_PDF_PAGES {
                return Err(limited("Delete scan exceeds its page ceiling"));
            }
            result.push(id);
        } else if unsafe { (reader.api.name_equals)(reader.data, kind.value, c"/Pages".as_ptr()) }
            != 0
        {
            let kids = reader.handle(unsafe {
                (reader.api.get_key)(reader.data, node.value, c"/Kids".as_ptr())
            })?;
            let count = unsafe { (reader.api.array_length)(reader.data, kids.value) };
            if count < 0 || pending.len().saturating_add(count as usize) > MAX_QPDF_OBJECT_ELEMENTS
            {
                return Err(limited(
                    "Delete scan page-tree children exceed their ceiling",
                ));
            }
            for index in (0..count).rev() {
                let child = reader
                    .handle(unsafe { (reader.api.array_item)(reader.data, kids.value, index) })?;
                pending.push((reference(child.value)?, depth + 1));
            }
        } else {
            return Err(corrupt("Delete scan found a non-page-tree node"));
        }
        reader.checkpoint()?;
    }
    Ok(result)
}
