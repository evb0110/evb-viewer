//! Builds the output page and annotation graph once for both PDF writers.
use super::*;
use crate::annotation_threads::transform_split_annotations;
use crate::split_pages::validate_content_transform;
use lopdf::dictionary;

fn apply_content_transform_incremental(
    base: &Document,
    target: &mut Document,
    page: &mut Dictionary,
    transform: Option<SplitContentTransform>,
) -> Result<()> {
    let transform = transform.map(validate_content_transform).transpose()?;
    if let Some(transform) = transform {
        let mut streams = vec![target.add_object(Object::Stream(Stream::new(
            Dictionary::new(),
            format!(
                "q {} 0 0 {} {} {} cm\n",
                transform.scale, transform.scale, transform.translate_x, transform.translate_y
            )
            .into_bytes(),
        )))];
        streams.extend(content_stream_ids_from_base(base, target, page)?);
        streams.push(target.add_object(Object::Stream(Stream::new(
            Dictionary::new(),
            b"\nQ\n".to_vec(),
        ))));
        page.set(
            "Contents",
            Object::Array(streams.into_iter().map(Object::Reference).collect()),
        );
    }
    Ok(())
}

fn split_source_page_number(source_page_index: usize) -> Result<u32> {
    let page_number = source_page_index.checked_add(1).ok_or_else(|| {
        domain_error(
            NativeErrorCode::InvalidRequest,
            "split-pages sourcePageIndex is too large",
        )
    })?;
    u32::try_from(page_number).map_err(|_| {
        domain_error(
            NativeErrorCode::InvalidRequest,
            "split-pages sourcePageIndex is too large",
        )
    })
}

pub(crate) struct SplitOutputPage {
    pub(crate) source_id: ObjectId,
    pub(crate) id: ObjectId,
    pub(crate) page: Dictionary,
    pub(crate) crop: PdfRect,
    pub(crate) transform: Option<SplitContentTransform>,
}

pub(crate) type SplitAnnotationMap = HashMap<ObjectId, Vec<(ObjectId, ObjectId)>>;

pub(crate) fn build_split_output(
    source: &Document,
    target: &mut Document,
    instructions: &SplitPagesFile,
) -> Result<()> {
    let source_pages = source.get_pages();
    let page_index = page_index_by_id(&source_pages);
    let pages_id = target.new_object_id();
    let mut pages = Vec::new();

    for instruction in &instructions.pages {
        if !(0..=3).contains(&instruction.rotation_quarter_turns) {
            return Err("split-pages rotationQuarterTurns must be between 0 and 3".into());
        }
        if !(1..=2).contains(&instruction.outputs.len()) {
            return Err("split-pages requires one or two outputs per source page".into());
        }
        let page_number = split_source_page_number(instruction.source_page_index)?;
        let source_page_id = resolve_page_id(&source_pages, page_number)?;
        let source_rotation = resolve_page_rotation(source, source_page_id)?;
        for output_instruction in &instruction.outputs {
            let crop = validate_crop_rect(output_instruction.crop_rect)?;
            let mut page = materialized_page_dictionary(source, source_page_id)?;
            let page_id = target.new_object_id();
            apply_content_transform_incremental(
                source,
                target,
                &mut page,
                output_instruction.content_transform,
            )?;
            page.set("MediaBox", rect_object(crop));
            page.set("CropBox", rect_object(crop));
            page.remove(b"BleedBox");
            page.remove(b"TrimBox");
            page.remove(b"ArtBox");
            page.remove(b"StructParents");
            page.set(
                "Rotate",
                normalize_page_rotation(source_rotation + instruction.rotation_quarter_turns * 90),
            );
            page.set("Parent", pages_id);
            pages.push(SplitOutputPage {
                source_id: source_page_id,
                id: page_id,
                page,
                crop,
                transform: output_instruction.content_transform,
            });
        }
    }

    let annotations = transform_split_annotations(source, target, &mut pages, &page_index)?;
    if matches!(instructions.catalog, SplitCatalog::Source) {
        for copies in annotations.values() {
            for (_, id) in copies {
                target
                    .get_dictionary_mut(*id)?
                    .remove(crate::split_navigation::SOURCE_ANNOTATION_SLOT);
            }
        }
    }
    let kids = pages
        .iter()
        .map(|page| Object::Reference(page.id))
        .collect::<Vec<_>>();
    target.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => i64::try_from(pages.len())?,
        }
        .into(),
    );

    let catalog_id = source.trailer.get(b"Root")?.as_reference()?;
    let catalog = split_catalog(
        source,
        target,
        catalog_id,
        pages_id,
        instructions.catalog,
        &pages,
        &annotations,
    )?;
    for page in pages {
        target.set_object(page.id, page.page);
    }
    target.set_object(catalog_id, Object::Dictionary(catalog));
    if matches!(instructions.catalog, SplitCatalog::Assembly) {
        let previous = target.trailer.remove(b"Prev");
        target.trailer = dictionary! {"Root" => catalog_id};
        if let Some(previous) = previous {
            target.trailer.set("Prev", previous);
            // Explicit nulls stop readers inheriting Info/ID from an old trailer.
            target.trailer.set("Info", Object::Null);
            target.trailer.set("ID", Object::Null);
        }
    }
    stamp_split_info(source, target, instructions)?;
    Ok(())
}

pub(crate) fn split_annotation_matrix(transform: Option<SplitContentTransform>) -> [f64; 6] {
    transform.map_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], |transform| {
        [
            transform.scale,
            0.0,
            0.0,
            transform.scale,
            transform.translate_x,
            transform.translate_y,
        ]
    })
}

type PendingSplitAnnotations = Vec<(usize, ObjectId, Dictionary)>;

pub(crate) fn allocate_split_annotations(
    source: &Document,
    target: &mut Document,
    pages: &mut [SplitOutputPage],
) -> Result<(SplitAnnotationMap, PendingSplitAnnotations)> {
    let mut copies = crate::split_output::SplitAnnotationMap::new();
    let mut pending = Vec::new();
    for (index, output) in pages.iter_mut().enumerate() {
        let entries = crate::split_navigation::source_annotation_entries(source, output.source_id);
        let mut kept = Vec::with_capacity(entries.len());
        for (slot, entry) in entries.into_iter().enumerate() {
            let Some((source_id, mut annotation)) = source
                .dereference(&entry)
                .ok()
                .and_then(|(id, object)| Some((id, object.as_dict().ok()?.clone())))
            else {
                kept.push(entry);
                continue;
            };
            if !crate::annotation_threads::keep_split_annotation(source, output, &annotation)? {
                continue;
            }
            let copy_id = match source_id
                .and_then(|id| copies.get(&id))
                .and_then(|copies| copies.iter().find(|(page, _)| *page == output.id))
            {
                Some((_, id)) => {
                    kept.push(Object::Reference(*id));
                    continue;
                }
                None => target.new_object_id(),
            };
            if let Some(source_id) = source_id {
                copies
                    .entry(source_id)
                    .or_default()
                    .push((output.id, copy_id));
            }
            annotation.set(
                crate::split_navigation::SOURCE_ANNOTATION_SLOT,
                i64::try_from(slot)?,
            );
            kept.push(Object::Reference(copy_id));
            pending.push((index, copy_id, annotation));
        }
        if output.page.has(b"Annots") {
            output.page.set("Annots", kept);
        }
    }
    Ok((copies, pending))
}
