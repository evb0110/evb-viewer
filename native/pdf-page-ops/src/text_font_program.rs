//! Encode a verified TrueType program and its glyph advances as a PDF font.

use super::*;

fn compressed_stream(document: &mut Document, dictionary: Dictionary, bytes: Vec<u8>) -> ObjectId {
    let mut stream = Stream::new(dictionary, bytes);
    // Compression failure does not affect semantics or permit font substitution.
    let _ = stream.compress();
    document.add_object(stream)
}

pub(crate) fn embed_font(document: &mut Document) -> ObjectId {
    let font = face();
    let metrics = font.metrics(Size::unscaled(), LocationRef::default());
    let glyph_metrics = font.glyph_metrics(Size::unscaled(), LocationRef::default());
    let units = f64::from(metrics.units_per_em);
    let metric = |value: f32| number_object(f64::from(value) * 1000.0 / units);
    let program = compressed_stream(
        document,
        lopdf::dictionary! { "Length1" => FONT.len() as i64 },
        FONT.to_vec(),
    );
    let bounds = metrics.bounds.expect("the bundled font has global bounds");
    let descriptor = document.add_object(lopdf::dictionary! {
        "Type" => "FontDescriptor", "FontName" => "DejaVuSans", "Flags" => 32,
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
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "DejaVuSans",
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
    document.add_object(lopdf::dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "DejaVuSans",
        "Encoding" => "Identity-H", "DescendantFonts" => vec![Object::Reference(descendant)],
        "ToUnicode" => to_unicode,
        "EVBTextFontVersion" => Object::string_literal(FONT_VERSION),
    })
}

