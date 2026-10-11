//! Encode a verified TrueType program and its glyph advances as a PDF font.

use super::*;

fn compressed_stream(document: &mut Document, dictionary: Dictionary, bytes: Vec<u8>) -> ObjectId {
    let mut stream = Stream::new(dictionary, bytes);
    // Compression failure does not affect semantics or permit font substitution.
    let _ = stream.compress();
    document.add_object(stream)
}

pub(crate) fn embed_font(document: &mut Document) -> ObjectId {
    embed_font_program(document, FONT, "DejaVuSans", true)
}

pub(crate) fn embed_font_program(
    document: &mut Document,
    program: &[u8],
    name: &str,
    editor: bool,
) -> ObjectId {
    let font = FontRef::from_index(program, 0).expect("resolved font program");
    let metrics = font.metrics(Size::unscaled(), LocationRef::default());
    let glyph_metrics = font.glyph_metrics(Size::unscaled(), LocationRef::default());
    let units = f64::from(metrics.units_per_em);
    let metric = |value: f32| number_object(f64::from(value) * 1000.0 / units);
    let program = compressed_stream(
        document,
        lopdf::dictionary! { "Length1" => program.len() as i64 },
        program.to_vec(),
    );
    let bounds = metrics.bounds.expect("the bundled font has global bounds");
    let descriptor = document.add_object(lopdf::dictionary! {
        "Type" => "FontDescriptor", "FontName" => name, "Flags" => 32,
        "FontBBox" => vec![metric(bounds.x_min), metric(bounds.y_min), metric(bounds.x_max), metric(bounds.y_max)],
        "ItalicAngle" => 0, "Ascent" => metric(metrics.ascent), "Descent" => metric(metrics.descent),
        "CapHeight" => metric(metrics.cap_height.unwrap_or(metrics.ascent)), "StemV" => 80,
        "FontFile2" => program,
    });
    let widths: Vec<Object> = (0..metrics.glyph_count)
        .map(|id| {
            number_object(
                f64::from(
                    glyph_metrics
                        .advance_width(GlyphId::new(u32::from(id)))
                        .unwrap_or(0.0),
                ) * 1000.0
                    / units,
            )
        })
        .collect();
    let descendant = document.add_object(lopdf::dictionary! {
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => name,
        "CIDSystemInfo" => lopdf::dictionary! { "Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("Identity"), "Supplement" => 0 },
        "FontDescriptor" => descriptor, "CIDToGIDMap" => "Identity",
        "W" => vec![Object::Integer(0), Object::Array(widths)],
    });
    // The bundled font's format-4 cmap maps U+0000 to glyph 0. Preserve the
    // previous writer's entry so existing embedded font graphs remain reusable;
    // skrifa intentionally omits .notdef from its public mapping iterator.
    let mut mapping = BTreeMap::<u16, String>::from([(0, "\0".to_string())]);
    for (codepoint, glyph) in font.charmap().mappings() {
        if let Some(character) = char::from_u32(codepoint) {
            // Presentation forms and standard ligatures extract as
            // their logical Unicode sequence even without ActualText.
            let text = if matches!(codepoint, 0xfb00..=0xfdff | 0xfe70..=0xfeff) {
                character.to_string().nfkc().collect()
            } else {
                character.to_string()
            };
            mapping.entry(glyph.to_u32() as u16).or_insert(text);
        }
    }
    let mut cmap = String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /EVBDejaVuSans def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");
    let entries: Vec<_> = mapping.into_iter().collect();
    for chunk in entries.chunks(100) {
        cmap.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (glyph, text) in chunk {
            cmap.push_str(&format!("<{glyph:04X}> <{}>\n", unicode_hex(text, false)));
        }
        cmap.push_str("endbfchar\n");
    }
    cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend");
    let to_unicode = compressed_stream(document, Dictionary::new(), cmap.into_bytes());
    let mut dictionary = lopdf::dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => name,
        "Encoding" => "Identity-H", "DescendantFonts" => vec![Object::Reference(descendant)],
        "ToUnicode" => to_unicode,
    };
    if editor {
        dictionary.set("EVBTextFontVersion", Object::string_literal(FONT_VERSION));
    }
    document.add_object(dictionary)
}

/// Retain a simple source font only when its painted advances can be measured.
/// Otherwise both wrapping and painting use the portable Unicode font.
pub(crate) fn simple_font_advances(
    document: &Document,
    font: &Object,
    text: &str,
) -> Option<[f64; 128]> {
    let dictionary = document.dereference(font).ok()?.1.as_dict().ok()?;
    if !text.is_ascii()
        || text
            .chars()
            .any(|c| c.is_ascii_control() && !matches!(c, '\n' | '\r'))
        || !matches!(
            dictionary.get(b"Subtype").and_then(Object::as_name).ok(),
            Some(b"Type1" | b"TrueType")
        )
    {
        return None;
    }
    let encoding = dictionary
        .get(b"Encoding")
        .ok()
        .map(|v| document.dereference(v).ok()?.1.as_name().ok())
        .unwrap_or(Some(b"StandardEncoding"));
    if !matches!(
        encoding,
        Some(b"StandardEncoding" | b"WinAnsiEncoding" | b"MacRomanEncoding")
    ) {
        return None;
    }
    let base = dictionary
        .get(b"BaseFont")
        .and_then(Object::as_name)
        .ok()
        .unwrap_or_default();
    let program: Option<&[u8]> = match base {
        b"Helvetica" => Some(include_bytes!(
            "../../../public/pdf/standard_fonts/LiberationSans-Regular.ttf"
        )),
        b"Helvetica-Bold" => Some(include_bytes!(
            "../../../public/pdf/standard_fonts/LiberationSans-Bold.ttf"
        )),
        b"Helvetica-Oblique" => Some(include_bytes!(
            "../../../public/pdf/standard_fonts/LiberationSans-Italic.ttf"
        )),
        b"Helvetica-BoldOblique" => Some(include_bytes!(
            "../../../public/pdf/standard_fonts/LiberationSans-BoldItalic.ttf"
        )),
        _ => None,
    };
    let widths = dictionary
        .get(b"Widths")
        .ok()
        .and_then(|v| document.dereference(v).ok()?.1.as_array().ok());
    let first = dictionary
        .get(b"FirstChar")
        .ok()
        .and_then(|v| document.dereference(v).ok()?.1.as_i64().ok())
        .unwrap_or(0);
    let missing = dictionary
        .get(b"FontDescriptor")
        .ok()
        .and_then(|v| document.dereference(v).ok()?.1.as_dict().ok())
        .and_then(|d| {
            object_to_f64(document.dereference(d.get(b"MissingWidth").ok()?).ok()?.1).ok()
        });
    let mut advances = [0.0; 128];
    for c in text.chars().filter(|c| !matches!(c, '\n' | '\r')) {
        let value = if let Some(widths) = widths {
            i64::from(c as u32)
                .checked_sub(first)
                .and_then(|i| usize::try_from(i).ok())
                .and_then(|i| widths.get(i))
                .and_then(|v| object_to_f64(document.dereference(v).ok()?.1).ok())
                .or(missing)?
        } else if matches!(
            base,
            b"Courier" | b"Courier-Bold" | b"Courier-Oblique" | b"Courier-BoldOblique"
        ) {
            600.0
        } else {
            let face = FontRef::from_index(program?, 0).ok()?;
            f64::from(
                face.glyph_metrics(Size::unscaled(), LocationRef::default())
                    .advance_width(face.charmap().map(c)?)?,
            ) * 1000.0
                / f64::from(
                    face.metrics(Size::unscaled(), LocationRef::default())
                        .units_per_em,
                )
        };
        if !value.is_finite() || value < 0.0 {
            return None;
        }
        advances[c as usize] = if widths.is_none() {
            value.round()
        } else {
            value
        };
    }
    Some(advances)
}
