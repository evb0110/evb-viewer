//! FreeText print synthesis, independent of editor admission.

use super::*;
use crate::annotations::line_origin;
use crate::free_text_frame::{colour, default_appearance, free_text_frame, FreeTextFrame};
use crate::text_box_font::{layout_simple, layout_with_fonts};

/// Synthesize foreign FreeText in PDF space; an empty text area retains its colors.
pub(super) fn missing_free_text_appearance(
    document: &mut Document,
    annotation: &Dictionary,
    page_id: ObjectId,
) -> Result<ObjectId> {
    let rect =
        read_box(document, annotation, b"Rect")?.ok_or("Invalid FreeText print rectangle")?;
    let da = default_appearance(document, annotation).unwrap_or_default();
    let size = da.font_size().unwrap_or(12.0);
    let font_name = da.font.unwrap_or_else(|| b"Helv".to_vec());
    let color = da.fill.unwrap_or_else(|| vec![0.0]);
    let frame = free_text_frame(document, annotation, rect);
    let page_rotation = resolve_page_rotation(document, page_id)?;
    let geometry = print_text_geometry(document, annotation, rect, page_rotation);
    let geometry = geometry.map(|geometry| FreeTextFrame::fit(Some(&frame), geometry));
    let mut content = frame.content;
    let text = annotation
        .get(b"Contents")
        .ok()
        .and_then(|v| pdf_string_to_text(document.dereference(v).ok()?.1))
        .unwrap_or_default();
    let font_resources = free_text_fonts(document, annotation, page_id)?;
    let mut resources = Dictionary::new();
    let color = colour(&color, true);
    if let Ok(geometry) = geometry {
        if let Some((font, advances)) = font_resources.iter().find_map(|fonts| {
            let font = fonts.get(&font_name).ok()?;
            crate::text_box_font::simple_font_advances(document, font, &text)
                .map(|advances| (font.clone(), advances))
        }) {
            resources.set("Font", Dictionary::from_iter([("PrintText", font)]));
            let lay_out = |width, size| layout_simple(&text, width, size, &advances);
            let (size, lines) = crate::annotations::fit_text_box(size, &geometry, &[], lay_out);
            content.push_str(&format!(
                "q {} cm 0 0 {} {} re W n BT {color} /PrintText {size} Tf\n",
                format_operands(&geometry.matrix),
                geometry.width,
                geometry.height,
            ));
            for (index, line) in lines.iter().enumerate() {
                let (left, baseline) = line_origin(&geometry, line, index, size);
                let text = line
                    .text
                    .replace('\\', "\\\\")
                    .replace('(', "\\(")
                    .replace(')', "\\)");
                content.push_str(&format!("1 0 0 1 {left} {baseline} Tm ({text}) Tj\n"));
            }
            content.push_str("ET Q\n");
        } else {
            let mut programs = Vec::new();
            for fonts in &font_resources {
                // Complete document programs precede the portable script fonts.
                for (_, font) in fonts
                    .iter()
                    .filter(|(name, _)| *name == &font_name)
                    .chain(fonts.iter().filter(|(name, _)| *name != &font_name))
                {
                    let program = (|| -> Result<Vec<u8>> {
                        let id = font_program_id(document, font).ok_or("No font program")?;
                        let stream = document.get_object(id)?.as_stream()?;
                        let bytes =
                            crate::decompressed_stream_with_limit(stream, FONT_PROGRAM_BYTES)?;
                        use skrifa::{raw::TableProvider, MetadataProvider};
                        let face = skrifa::FontRef::from_index(&bytes, 0)?;
                        let metrics = face.metrics(
                            skrifa::instance::Size::unscaled(),
                            skrifa::instance::LocationRef::default(),
                        );
                        if face.glyf().is_err()
                            || metrics.bounds.is_none()
                            || metrics.units_per_em == 0
                        {
                            return Err("Unusable print font program".into());
                        }
                        Ok(bytes)
                    })();
                    if let Some(program) = program.ok().filter(|p| !programs.contains(p)) {
                        programs.push(program);
                    }
                }
            }
            let programs: Vec<&[u8]> = programs
                .iter()
                .map(Vec::as_slice)
                .chain(crate::text_box_font::FONTS)
                .collect();
            let lay_out = |width, size| layout_with_fonts(&text, width, size, &programs, None);
            let (size, lines) =
                crate::annotations::fit_text_box(size, &geometry, &programs, lay_out);
            let fonts = crate::text_box_font::embed_fonts(document, &lines, &programs)?;
            content.push_str(&crate::annotations::text_box_content(
                &geometry, &color, &lines, size,
            ));
            resources.set("Font", fonts);
        }
    }
    Ok(document.add_object(Stream::new(lopdf::dictionary! {"Type"=>"XObject", "Subtype"=>"Form", "BBox"=>rect_object(rect), "Resources"=>resources},content.into_bytes())))
}

fn print_text_geometry(
    document: &Document,
    annotation: &Dictionary,
    rect: PdfRect,
    page_rotation: i64,
) -> Result<crate::text_box_font::Geometry> {
    let rotation = annotation
        .get(b"Rotate")
        .ok()
        .and_then(|v| document.dereference(v).ok()?.1.as_i64().ok())
        .unwrap_or(0)
        .rem_euclid(360);
    if crate::text_box_font::editor_geometry(annotation).is_some() {
        let visible =
            read_box(document, annotation, b"Rect")?.ok_or("Invalid FreeText rectangle")?;
        let (source, rotation) = crate::text_box_font::stored_editor_geometry(
            document,
            annotation,
            visible,
            rotation,
            page_rotation,
        )?;
        crate::text_box_font::geometry(source, rotation, page_rotation)
    } else {
        // Foreign /Rect is already in PDF space. Own rotation turns the text
        // counterclockwise within that rectangle; page /Rotate is applied when
        // placing the page, not while laying out its annotation.
        crate::text_box_font::geometry(rect, 0, rotation)
    }
}
