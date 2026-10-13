//! FreeText print synthesis, independent of editor admission.

use super::*;
use crate::annotations::line_origin;
use crate::text_box_font::{layout_simple, layout_with_fonts};

/// Synthesize foreign FreeText in PDF space; an empty text area retains its colors.
pub(super) fn missing_free_text_appearance(
    document: &mut Document,
    annotation: &Dictionary,
    page_id: ObjectId,
) -> Result<ObjectId> {
    use lopdf::content::Content;
    let rect =
        read_box(document, annotation, b"Rect")?.ok_or("Invalid FreeText print rectangle")?;
    let inner = annotation_inner_rect(document, annotation).unwrap_or(rect);
    let da = annotation
        .get(b"DA")
        .ok()
        .and_then(|v| document.dereference(v).ok()?.1.as_str().ok())
        .unwrap_or(b"");
    let operations = Content::decode(da)
        .map(|c| c.operations)
        .unwrap_or_default();
    let mut color = vec![0.0];
    let mut size = 12.0;
    let mut font_name = b"Helv".to_vec();
    for op in operations {
        if op.operator == "Tf" && op.operands.len() == 2 {
            if let Ok(name) = op.operands[0].as_name() {
                font_name = name.to_vec();
            }
            if let Ok(value) = object_to_f64(&op.operands[1]) {
                if value.is_finite() && value > 0.0 && value <= 512.0 {
                    size = value;
                }
            }
        } else if matches!(op.operator.as_str(), "g" | "rg" | "k") {
            let count = match op.operator.as_str() {
                "g" => 1,
                "rg" => 3,
                _ => 4,
            };
            let values = op
                .operands
                .iter()
                .map(object_to_f64)
                .collect::<Result<Vec<_>>>();
            if let Ok(values) = values {
                if values.len() == count && values.iter().all(|v| (0.0..=1.0).contains(v)) {
                    color = values;
                }
            }
        }
    }
    let operator = |components: &[f64]| match components.len() {
        1 => "g",
        3 => "rg",
        _ => "k",
    };
    let mut content = String::new();
    if let Some(background) = annotation
        .get(b"C")
        .ok()
        .and_then(|v| document.dereference(v).ok()?.1.as_array().ok())
        .and_then(|v| {
            v.iter()
                .map(|n| object_to_f64(document.dereference(n).ok()?.1).ok())
                .collect::<Option<Vec<_>>>()
        })
        .filter(|v| matches!(v.len(), 1 | 3 | 4) && v.iter().all(|n| (0.0..=1.0).contains(n)))
    {
        content.push_str(&format!(
            "q {} {} {} re f Q\n",
            format_operands(&background),
            operator(&background),
            format_operands(&[inner.x1, inner.y1, inner.width(), inner.height()])
        ));
    }
    let mut border = annotation.clone();
    border.remove(b"IC");
    border.set(
        "C",
        color.iter().copied().map(number_object).collect::<Vec<_>>(),
    );
    if let Some(draw) = synthesized_shape_content(document, &border, b"Square") {
        content.push_str(&draw);
    }
    let text = annotation
        .get(b"Contents")
        .ok()
        .and_then(|v| pdf_string_to_text(document.dereference(v).ok()?.1))
        .unwrap_or_default();
    let font_resources = free_text_fonts(document, annotation, page_id)?;
    let mut resources = Dictionary::new();
    let width = shape_stroke_width(document, annotation)
        .filter(|w| w.is_finite() && *w >= 0.0)
        .unwrap_or(1.0);
    let text_rect = PdfRect {
        x1: inner.x1 + 2.0 * width,
        y1: inner.y1 + 2.0 * width,
        x2: inner.x2 - 2.0 * width,
        y2: inner.y2 - 2.0 * width,
    };
    let color = format!("{} {}", format_operands(&color), operator(&color));
    if let Ok(geometry) = print_text_geometry(
        document,
        annotation,
        text_rect,
        resolve_page_rotation(document, page_id)?,
    ) {
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
            let level = Some(unicode_bidi::Level::ltr());
            let lay_out = |width, size| layout_with_fonts(&text, width, size, &programs, level);
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
