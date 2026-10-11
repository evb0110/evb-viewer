//! Builds the output page and annotation graph once for both PDF writers.
use super::*;
use crate::annotation_threads::transform_page_annotations;
use crate::split_pages::validate_content_transform;
use lopdf::dictionary;

fn set_page_box(page: &mut Dictionary, key: &str, rect: PdfRect) {
    page.set(
        key,
        Object::Array(vec![
            number_object(rect.x1),
            number_object(rect.y1),
            number_object(rect.x2),
            number_object(rect.y2),
        ]),
    );
}

fn apply_content_transform_incremental(
    base: &Document,
    target: &mut Document,
    source_page_id: ObjectId,
    page_id: ObjectId,
    page: &mut Dictionary,
    transform: Option<SplitContentTransform>,
    crop: PdfRect,
    page_index: &HashMap<ObjectId, usize>,
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
    transform_page_annotations(
        base,
        target,
        source_page_id,
        page_id,
        page,
        transform,
        crop,
        page_index,
    )
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

pub(crate) fn build_split_output(
    source: &Document,
    target: &mut Document,
    instructions: &SplitPagesFile,
) -> Result<()> {
    let source_pages = source.get_pages();
    let page_index = page_index_by_id(&source_pages);
    let pages_id = target.new_object_id();
    let mut output_page_ids = Vec::new();

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
                source_page_id,
                page_id,
                &mut page,
                output_instruction.content_transform,
                crop,
                &page_index,
            )?;
            set_page_box(&mut page, "MediaBox", crop);
            set_page_box(&mut page, "CropBox", crop);
            page.remove(b"BleedBox");
            page.remove(b"TrimBox");
            page.remove(b"ArtBox");
            page.set(
                "Rotate",
                normalize_page_rotation(source_rotation + instruction.rotation_quarter_turns * 90),
            );
            page.set("Parent", pages_id);
            target.objects.insert(page_id, page.into());
            output_page_ids.push(page_id);
        }
    }

    let kids = output_page_ids
        .iter()
        .copied()
        .map(Object::Reference)
        .collect::<Vec<_>>();
    target.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => i64::try_from(output_page_ids.len())?,
        }
        .into(),
    );

    let catalog_id = source.trailer.get(b"Root")?.as_reference()?;
    let catalog = split_catalog(source, catalog_id, pages_id, instructions.catalog)?;
    target.set_object(catalog_id, Object::Dictionary(catalog));
    if let Some(stamp) = instructions.provenance_stamp_hex.as_deref() {
        let info_id = target.add_object(dictionary! {
            "EVBScanCleanup" => Object::string_literal(stamp.as_bytes().to_vec()),
        });
        target.trailer.set("Info", info_id);
    }
    Ok(())
}
