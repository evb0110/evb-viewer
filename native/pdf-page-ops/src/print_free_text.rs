//! FreeText print synthesis, independent of editor admission.

use super::*;

/// Keep foreign FreeText fields in page coordinates. A supported simple source
/// font is retained for ASCII text; other encodings use the editor's Unicode
/// shaping and embedded font, while background, border and RD remain foreign.
pub(super) fn missing_free_text_appearance(
    document: &mut Document,
    annotation: &Dictionary,
    page_id: ObjectId,
    font_ref: &mut Option<ObjectId>,
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
        let operator = match background.len() {
            1 => "g",
            3 => "rg",
            _ => "k",
        };
        content.push_str(&format!(
            "q {} {operator} {} re f Q\n",
            format_operands(&background),
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
        .and_then(|v| document.dereference(v).ok())
        .and_then(|(_, v)| pdf_string_to_text(v))
        .unwrap_or_default();
    let page = materialized_page_dictionary(document, page_id)?;
    let source_font = [annotation.get(b"DR").ok(), page.get(b"Resources").ok()]
        .into_iter()
        .flatten()
        .find_map(|resources| {
            let resources = document.dereference(resources).ok()?.1.as_dict().ok()?;
            let fonts = document
                .dereference(resources.get(b"Font").ok()?)
                .ok()?
                .1
                .as_dict()
                .ok()?;
            let font = fonts.get(&font_name).ok()?;
            let dictionary = document.dereference(font).ok()?.1.as_dict().ok()?;
            let simple = matches!(
                dictionary.get(b"Subtype").and_then(Object::as_name).ok(),
                Some(b"Type1" | b"TrueType")
            );
            let encoding = dictionary
                .get(b"Encoding")
                .ok()
                .map(|v| document.dereference(v).ok()?.1.as_name().ok())
                .unwrap_or(Some(b"StandardEncoding"));
            (simple
                && matches!(
                    encoding,
                    Some(b"StandardEncoding" | b"WinAnsiEncoding" | b"MacRomanEncoding")
                ))
            .then(|| font.clone())
        });
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
    let geometry = print_text_geometry(
        document,
        annotation,
        text_rect,
        resolve_page_rotation(document, page_id)?,
    )?;
    if let Some(font) = source_font.filter(|_| text.is_ascii()) {
        resources.set("Font", Dictionary::from_iter([("PrintText", font)]));
        let color_operator = match color.len() {
            1 => "g",
            3 => "rg",
            _ => "k",
        };
        content.push_str(&format!(
            "q {} cm 0 0 {} {} re W n BT {} {color_operator} /PrintText {size} Tf\n",
            format_operands(&geometry.matrix),
            geometry.width,
            geometry.height,
            format_operands(&color)
        ));
        for (index, line) in crate::text_box_font::layout(&text, geometry.width, size)
            .iter()
            .enumerate()
        {
            let text = line
                .text
                .replace('\\', "\\\\")
                .replace('(', "\\(")
                .replace(')', "\\)");
            content.push_str(&format!(
                "1 0 0 1 {} {} Tm ({text}) Tj\n",
                0,
                geometry.height - size - index as f64 * size * 1.2
            ));
        }
        content.push_str("ET Q\n");
    } else {
        let mut programs = vec![crate::text_box_font::FONT.to_vec()];
        let page = materialized_page_dictionary(document, page_id)?;
        let catalog = document.catalog()?;
        let acroform = catalog
            .get(b"AcroForm")
            .ok()
            .and_then(|v| document.dereference(v).ok()?.1.as_dict().ok());
        for resource in [
            annotation.get(b"DR").ok(),
            page.get(b"Resources").ok(),
            acroform.and_then(|d| d.get(b"DR").ok()),
        ]
        .into_iter()
        .flatten()
        {
            let Some(fonts) = document
                .dereference(resource)
                .ok()
                .and_then(|(_, r)| r.as_dict().ok())
                .and_then(|r| {
                    document
                        .dereference(r.get(b"Font").ok()?)
                        .ok()?
                        .1
                        .as_dict()
                        .ok()
                })
            else {
                continue;
            };
            for (_, font) in fonts {
                let program = (|| -> Result<Vec<u8>> {
                    let mut font = document.dereference(font)?.1.as_dict()?;
                    if let Ok(descendants) = font.get(b"DescendantFonts") {
                        font = document
                            .dereference(
                                document
                                    .dereference(descendants)?
                                    .1
                                    .as_array()?
                                    .first()
                                    .ok_or("No descendant font")?,
                            )?
                            .1
                            .as_dict()?;
                    }
                    let descriptor = document
                        .dereference(font.get(b"FontDescriptor")?)?
                        .1
                        .as_dict()?;
                    let stream = document
                        .dereference(descriptor.get(b"FontFile2")?)?
                        .1
                        .as_stream()?;
                    let bytes = crate::decompressed_stream_with_limit(stream, 16 * 1024 * 1024)?;
                    use skrifa::{raw::TableProvider, MetadataProvider};
                    let face = skrifa::FontRef::from_index(&bytes, 0)?;
                    let metrics = face.metrics(
                        skrifa::instance::Size::unscaled(),
                        skrifa::instance::LocationRef::default(),
                    );
                    if face.glyf().is_err() || metrics.bounds.is_none() || metrics.units_per_em == 0
                    {
                        return Err("Unusable print font program".into());
                    }
                    Ok(bytes)
                })();
                if let Ok(program) = program {
                    if !programs.contains(&program) {
                        programs.push(program);
                    }
                }
            }
        }
        programs.push(
            include_bytes!("../../../public/fonts/annotation/NotoSansSyriac-Regular.ttf").to_vec(),
        );
        let programs: Vec<_> = programs.iter().map(Vec::as_slice).collect();
        let padding = crate::text_box_font::PADDING_X * size;
        let width = (geometry.width - 2.0 * padding).max(0.0);
        let lines = crate::text_box_font::layout_with_fonts(&text, width, size, &programs);
        let mut fonts = Dictionary::new();
        for index in lines
            .iter()
            .flat_map(|l| &l.glyphs)
            .map(|g| g.font)
            .collect::<std::collections::BTreeSet<_>>()
        {
            let reference = if index == 0 {
                *font_ref.get_or_insert_with(|| {
                    crate::text_box_font::existing_font(document)
                        .unwrap_or_else(|| crate::text_box_font::embed_font(document))
                })
            } else {
                crate::text_box_font::embed_font_program(
                    document,
                    programs[index],
                    &format!("PrintFont{index}"),
                    false,
                )
            };
            fonts.set(format!("PrintFont{index}"), reference);
        }
        let color_operator = match color.len() {
            1 => "g",
            3 => "rg",
            _ => "k",
        };
        content.push_str(&format!(
            "q {} cm 0 0 {} {} re W n BT {} {color_operator}\n",
            format_operands(&geometry.matrix),
            geometry.width,
            geometry.height,
            format_operands(&color)
        ));
        for (index, line) in lines.iter().enumerate() {
            let left = padding
                + if line.rtl {
                    (width - line.width).max(0.0)
                } else {
                    0.0
                };
            let baseline = geometry.height
                - crate::text_box_font::baseline_from_top(size)
                - index as f64 * crate::text_box_font::LINE_HEIGHT * size;
            content.push_str(&format!(
                "/Span << /ActualText <{}> >> BDC\n",
                crate::text_box_font::unicode_hex(&line.text, true)
            ));
            for glyph in &line.glyphs {
                content.push_str(&format!(
                    "/PrintFont{} {} Tf 1 0 0 1 {} {} Tm <{:04X}> Tj\n",
                    glyph.font,
                    size,
                    left + glyph.x,
                    baseline + glyph.y,
                    glyph.id
                ));
            }
            content.push_str("EMC\n");
        }
        content.push_str("ET Q\n");
        resources.set("Font", fonts);
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
    if annotation.has(b"EVBTextGeometry") {
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

