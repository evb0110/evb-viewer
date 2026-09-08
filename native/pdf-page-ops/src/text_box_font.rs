//! Portable text-box layout and PDF fonts. The renderer loads these exact font
//! bytes. Shaping never depends on fonts installed on the host.
use super::*;
use lopdf::dictionary;
use rustybuzz::{Direction, Face, UnicodeBuffer};
use std::ops::Range;
use unicode_bidi::{BidiInfo, ParagraphInfo};
use unicode_normalization::UnicodeNormalization;
use unicode_script::{Script, UnicodeScript};
use unicode_segmentation::UnicodeSegmentation;

const FONT: &[u8] = include_bytes!("../../../public/fonts/annotation/DejaVuSans.ttf");
const FONT_VERSION: &str = "DejaVuSans-2.37-7da195a74c55bef9-v1";
pub(crate) const LINE_HEIGHT: f64 = 1.35;
pub(crate) const PADDING_X: f64 = 0.3;
pub(crate) const PADDING_Y: f64 = 0.15;

fn face() -> Face<'static> {
    Face::from_slice(FONT, 0).expect("the bundled DejaVu Sans font is valid")
}

fn invisible(character: char) -> bool {
    matches!(character, '\n' | '\r' | '\t' | '\u{00ad}' | '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{fe00}'..='\u{fe0f}' | '\u{feff}')
}

pub(crate) fn validate_text(text: &str) -> Result<()> {
    let font = face();
    for character in text.chars() {
        if invisible(character) {
            continue;
        }
        if character.is_control() || font.glyph_index(character).is_none() {
            return Err(format!(
                "Text box font DejaVu Sans does not support U+{:04X}",
                u32::from(character)
            )
            .into());
        }
    }
    Ok(())
}

pub(crate) fn baseline_from_top(font_size: f64) -> f64 {
    let font = face();
    (PADDING_Y
        + LINE_HEIGHT / 2.0
        + f64::from(font.ascender() + font.descender()) / (2.0 * f64::from(font.units_per_em())))
        * font_size
}

#[derive(Debug)]
pub(crate) struct Glyph {
    pub id: u16,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug)]
pub(crate) struct Line {
    pub text: String,
    pub glyphs: Vec<Glyph>,
    pub width: f64,
    pub rtl: bool,
}

// Bidi runs may contain several scripts. HarfBuzz requires one script per run;
// Common/Inherited characters retain their surrounding script.
fn script_runs(text: &str, range: Range<usize>) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = range.start;
    let mut script = Script::Common;
    for (offset, character) in text[range.clone()].char_indices() {
        let next = character.script();
        if matches!(next, Script::Common | Script::Inherited) {
            continue;
        }
        if script != Script::Common && script != next {
            ranges.push(start..range.start + offset);
            start = range.start + offset;
        }
        script = next;
    }
    if start < range.end {
        ranges.push(start..range.end);
    }
    ranges
}

fn shape_line(
    font: &Face<'_>,
    text: &str,
    bidi: &BidiInfo<'_>,
    paragraph: &ParagraphInfo,
    range: Range<usize>,
    font_size: f64,
) -> Line {
    if range.is_empty() {
        return Line {
            text: String::new(),
            glyphs: Vec::new(),
            width: 0.0,
            rtl: paragraph.level.is_rtl(),
        };
    }
    let logical_text = &text[range.clone()];
    let show_hyphen = range.end < text.len() && logical_text.ends_with('\u{00ad}');
    let rendered_text = if show_hyphen {
        format!("{}-", logical_text.trim_end_matches('\u{00ad}'))
    } else {
        logical_text.to_string()
    };
    let text = rendered_text.as_str();
    // Preserve paragraph-resolved levels across wraps, but only copy the line
    // being measured. visual_runs otherwise copies the entire paragraph for
    // every width probe, which becomes quadratic in narrow text boxes.
    let line_paragraph = ParagraphInfo {
        range: 0..text.len(),
        level: paragraph.level,
    };
    let line_bidi = BidiInfo {
        text,
        original_classes: bidi.original_classes[range.start..range.start + text.len()].to_vec(),
        levels: bidi.levels[range.start..range.start + text.len()].to_vec(),
        paragraphs: vec![line_paragraph.clone()],
    };
    let scale = font_size / f64::from(font.units_per_em());
    let mut glyphs = Vec::new();
    let mut advance = 0.0;
    let (levels, runs) = line_bidi.visual_runs(&line_paragraph, 0..text.len());
    for run in runs {
        let rtl = levels[run.start].is_rtl();
        let mut scripts = script_runs(text, run);
        if rtl {
            scripts.reverse();
        }
        for script in scripts {
            let mut buffer = UnicodeBuffer::new();
            let segment = &text[script];
            buffer.push_str(segment);
            buffer.guess_segment_properties();
            buffer.set_direction(if rtl {
                Direction::RightToLeft
            } else {
                Direction::LeftToRight
            });
            let shaped = rustybuzz::shape(font, &[], buffer);
            for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
                if segment.as_bytes().get(info.cluster as usize) == Some(&b'\t') {
                    let space = font
                        .glyph_index(' ')
                        .and_then(|id| font.glyph_hor_advance(id))
                        .unwrap_or(0);
                    let tab_stop = 4.0 * f64::from(space) * scale;
                    if tab_stop > 0.0 {
                        advance = ((advance / tab_stop).floor() + 1.0) * tab_stop;
                    }
                    continue;
                }
                glyphs.push(Glyph {
                    id: info.glyph_id as u16,
                    x: advance + f64::from(position.x_offset) * scale,
                    y: f64::from(position.y_offset) * scale,
                });
                advance += f64::from(position.x_advance) * scale;
            }
        }
    }
    Line {
        text: logical_text.to_string(),
        glyphs,
        width: advance,
        rtl: paragraph.level.is_rtl(),
    }
}

pub(crate) fn layout(text: &str, width: f64, font_size: f64) -> Vec<Line> {
    let font = face();
    // Match CSS segment-break normalization. Contents retains the original text.
    let normalized = text
        .replace("\r\n", "\n")
        .replace(['\r', '\u{2028}', '\u{2029}'], "\n");
    let mut result = Vec::new();
    for paragraph_text in normalized.split('\n') {
        if paragraph_text.is_empty() {
            result.push(Line {
                text: String::new(),
                glyphs: Vec::new(),
                width: 0.0,
                rtl: false,
            });
            continue;
        }
        let bidi = BidiInfo::new(paragraph_text, None);
        let paragraph = &bidi.paragraphs[0];
        let boundaries: Vec<usize> = paragraph_text
            .grapheme_indices(true)
            .map(|(offset, _)| offset)
            .chain(std::iter::once(paragraph_text.len()))
            .collect();
        let breaks: HashSet<usize> = unicode_linebreak::linebreaks(paragraph_text)
            .map(|(offset, _)| offset)
            .collect();
        let mut start = 0;
        while start + 1 < boundaries.len() {
            let fits = |end: usize| {
                let trimmed = paragraph_text[boundaries[start]..boundaries[end]]
                    .trim_end_matches([' ', '\t']);
                shape_line(
                    &font,
                    paragraph_text,
                    &bidi,
                    paragraph,
                    boundaries[start]..boundaries[start] + trimmed.len(),
                    font_size,
                )
                .width
                    <= width
            };
            // Exponential search keeps a 64 KiB paragraph in a narrow box linear
            // in paragraph size, rather than reshaping its entire tail per line.
            let mut fit = start + 1;
            let mut probe = fit;
            let last = boundaries.len() - 1;
            while probe < last && fits(probe) {
                fit = probe;
                probe = (start + 2 * (probe - start)).min(last);
            }
            if fits(probe) {
                fit = probe;
            } else {
                let mut upper = probe;
                while fit + 1 < upper {
                    let middle = fit + (upper - fit) / 2;
                    if fits(middle) {
                        fit = middle;
                    } else {
                        upper = middle;
                    }
                }
            }
            let end = if fit == last {
                last
            } else {
                (start + 1..=fit)
                    .rev()
                    .find(|index| breaks.contains(&boundaries[*index]))
                    .unwrap_or(fit)
            };
            result.push(shape_line(
                &font,
                paragraph_text,
                &bidi,
                paragraph,
                boundaries[start]..boundaries[end],
                font_size,
            ));
            start = end;
        }
    }
    result
}

fn trusted_font() -> &'static (Document, ObjectId) {
    static TRUSTED: std::sync::OnceLock<(Document, ObjectId)> = std::sync::OnceLock::new();
    TRUSTED.get_or_init(|| {
        let mut document = Document::new();
        let id = embed_font(&mut document);
        (document, id)
    })
}

fn font_objects_match(
    actual_document: &impl PdfObjectSource,
    actual: &Object,
    expected_document: &Document,
    expected: &Object,
    depth: usize,
) -> bool {
    if depth > 12 {
        return false;
    }
    let (Ok(actual), Ok(expected)) = (
        actual_document.resolved(actual),
        expected_document.resolved(expected),
    ) else {
        return false;
    };
    match (actual, expected) {
        (Object::Dictionary(actual), Object::Dictionary(expected)) => {
            actual.len() == expected.len()
                && expected.iter().all(|(key, value)| {
                    actual.get(key).is_ok_and(|actual| {
                        font_objects_match(
                            actual_document,
                            actual,
                            expected_document,
                            value,
                            depth + 1,
                        )
                    })
                })
        }
        (Object::Array(actual), Object::Array(expected)) => {
            actual.len() == expected.len()
                && actual.iter().zip(expected).all(|(actual, expected)| {
                    font_objects_match(
                        actual_document,
                        actual,
                        expected_document,
                        expected,
                        depth + 1,
                    )
                })
        }
        (Object::Stream(actual), Object::Stream(expected)) => {
            // Recompression by another PDF editor is harmless. Missing stream
            // bytes, a changed cmap, or a replaced program are never trusted.
            if actual.content.is_empty() {
                return false;
            }
            let bytes_match = match (
                actual.decompressed_content_with_limit(1024 * 1024),
                expected.decompressed_content_with_limit(1024 * 1024),
            ) {
                (Ok(actual), Ok(expected)) => actual == expected,
                _ => false,
            };
            let semantic_key = |key: &[u8]| !matches!(key, b"Length" | b"Filter" | b"DecodeParms");
            let same_keys = actual
                .dict
                .iter()
                .filter(|(key, _)| semantic_key(key))
                .count()
                == expected
                    .dict
                    .iter()
                    .filter(|(key, _)| semantic_key(key))
                    .count();
            bytes_match
                && same_keys
                && expected
                    .dict
                    .iter()
                    .filter(|(key, _)| {
                        !matches!(key.as_slice(), b"Length" | b"Filter" | b"DecodeParms")
                    })
                    .all(|(key, value)| {
                        actual.dict.get(key).is_ok_and(|actual| {
                            font_objects_match(
                                actual_document,
                                actual,
                                expected_document,
                                value,
                                depth + 1,
                            )
                        })
                    })
        }
        (Object::String(_, _), Object::String(_, _)) => {
            pdf_string_to_text(actual) == pdf_string_to_text(expected)
        }
        (Object::Integer(actual), Object::Real(expected)) => *actual as f64 == f64::from(*expected),
        (Object::Real(actual), Object::Integer(expected)) => f64::from(*actual) == *expected as f64,
        _ => actual == expected,
    }
}

pub(crate) fn font_candidates(document: &Document) -> impl Iterator<Item = ObjectId> + '_ {
    document
        .objects
        .iter()
        .filter_map(|(id, object)| {
            object
                .as_dict()
                .ok()
                .and_then(|dict| dict.get(b"EVBTextFontVersion").ok())
                .and_then(pdf_string_to_text)
                .filter(|version| version == FONT_VERSION)
                .map(|_| *id)
        })
        .take(4)
}

pub(crate) fn candidate_streams(document: &Document) -> Vec<ObjectId> {
    let mut streams = Vec::new();
    for id in font_candidates(document) {
        let Ok(font) = document.get_dictionary(id) else {
            continue;
        };
        let collect = || -> Result<[ObjectId; 2]> {
            let cmap = font.get(b"ToUnicode")?.as_reference()?;
            let descendant = document
                .resolved(
                    font.get(b"DescendantFonts")?
                        .as_array()?
                        .first()
                        .ok_or("Missing font descendant")?,
                )?
                .as_dict()?;
            let descriptor = document
                .resolved(descendant.get(b"FontDescriptor")?)?
                .as_dict()?;
            Ok([cmap, descriptor.get(b"FontFile2")?.as_reference()?])
        };
        if let Ok(resources) = collect() {
            streams.extend(resources);
        }
    }
    streams.sort_unstable();
    streams.dedup();
    streams
}

pub(crate) fn existing_font(document: &Document) -> Option<ObjectId> {
    let (expected, id) = trusted_font();
    font_candidates(document).find(|candidate| {
        font_objects_match(
            document,
            &Object::Reference(*candidate),
            expected,
            &Object::Reference(*id),
            0,
        )
    })
}

fn compressed_stream(document: &mut Document, dictionary: Dictionary, bytes: Vec<u8>) -> ObjectId {
    let mut stream = Stream::new(dictionary, bytes);
    // Compression failure does not affect semantics or permit font substitution.
    let _ = stream.compress();
    document.add_object(stream)
}

pub(crate) fn embed_font(document: &mut Document) -> ObjectId {
    let font = face();
    let units = f64::from(font.units_per_em());
    let metric = |value: i16| number_object(f64::from(value) * 1000.0 / units);
    let program = compressed_stream(
        document,
        lopdf::dictionary! { "Length1" => FONT.len() as i64 },
        FONT.to_vec(),
    );
    let bounds = font.global_bounding_box();
    let descriptor = document.add_object(lopdf::dictionary! {
        "Type" => "FontDescriptor", "FontName" => "DejaVuSans", "Flags" => 32,
        "FontBBox" => vec![metric(bounds.x_min), metric(bounds.y_min), metric(bounds.x_max), metric(bounds.y_max)],
        "ItalicAngle" => 0, "Ascent" => metric(font.ascender()), "Descent" => metric(font.descender()),
        "CapHeight" => metric(font.capital_height().unwrap_or(font.ascender())), "StemV" => 80,
        "FontFile2" => program,
    });
    let widths: Vec<Object> = (0..font.number_of_glyphs())
        .map(|id| {
            number_object(
                f64::from(
                    font.glyph_hor_advance(rustybuzz::ttf_parser::GlyphId(id))
                        .unwrap_or(0),
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
    let mut mapping = BTreeMap::<u16, String>::new();
    if let Some(cmap) = font.tables().cmap {
        for table in cmap
            .subtables
            .into_iter()
            .filter(|table| table.is_unicode())
        {
            table.codepoints(|codepoint| {
                if let Some(character) = char::from_u32(codepoint) {
                    if let Some(glyph) = font.glyph_index(character) {
                        // Presentation forms and standard ligatures extract as
                        // their logical Unicode sequence even without ActualText.
                        let text = if matches!(codepoint, 0xfb00..=0xfdff | 0xfe70..=0xfeff) {
                            character.to_string().nfkc().collect()
                        } else {
                            character.to_string()
                        };
                        mapping.entry(glyph.0).or_insert(text);
                    }
                }
            });
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

pub(crate) fn unicode_hex(text: &str, bom: bool) -> String {
    let mut result = if bom {
        String::from("FEFF")
    } else {
        String::new()
    };
    for unit in text.encode_utf16() {
        result.push_str(&format!("{unit:04X}"));
    }
    result
}

pub(crate) fn validate_appearance_font(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
) -> Result<()> {
    let appearance = document.resolved(annotation.get(b"AP")?)?.as_dict()?;
    let normal = document.resolved(appearance.get(b"N")?)?.as_stream()?;
    let resources = document
        .resolved(normal.dict.get(b"Resources")?)?
        .as_dict()?;
    let fonts = document.resolved(resources.get(b"Font")?)?.as_dict()?;
    let font = document.resolved(fonts.get(b"Helv")?)?.as_dict()?;
    let (expected, id) = trusted_font();
    if !font_objects_match(
        document,
        &Object::Dictionary(font.clone()),
        expected,
        &Object::Reference(*id),
        0,
    ) {
        return Err("Text box appearance does not use the verified portable font graph".into());
    }
    Ok(())
}

pub(crate) struct Geometry {
    pub bounds: PdfRect,
    pub width: f64,
    pub height: f64,
    pub matrix: [f64; 6],
}

pub(crate) fn geometry(source: PdfRect, rotation: i64, page_rotation: i64) -> Result<Geometry> {
    if ![source.x1, source.y1, source.x2, source.y2]
        .iter()
        .all(|value| value.is_finite())
        || source.width() <= 0.0
        || source.height() <= 0.0
        || !matches!(rotation, 0 | 90 | 180 | 270)
    {
        return Err("Invalid text box geometry".into());
    }
    let (width, height) = if page_rotation % 180 == 0 {
        (source.width(), source.height())
    } else {
        (source.height(), source.width())
    };
    // PDF y is upward, whereas canonical rotation follows CSS clockwise.
    // Page /Rotate is already part of the canonical coordinate frame.
    let (a, b, c, d) = match (page_rotation - rotation).rem_euclid(360) {
        0 => (1.0, 0.0, 0.0, 1.0),
        90 => (0.0, 1.0, -1.0, 0.0),
        180 => (-1.0, 0.0, 0.0, -1.0),
        270 => (0.0, -1.0, 1.0, 0.0),
        _ => return Err("Invalid text box page rotation".into()),
    };
    let center_x = source.x1 + source.width() / 2.0;
    let center_y = source.y1 + source.height() / 2.0;
    let visual_width = f64::abs(a) * width + f64::abs(c) * height;
    let visual_height = f64::abs(b) * width + f64::abs(d) * height;
    Ok(Geometry {
        bounds: PdfRect {
            x1: center_x - visual_width / 2.0,
            y1: center_y - visual_height / 2.0,
            x2: center_x + visual_width / 2.0,
            y2: center_y + visual_height / 2.0,
        },
        width,
        height,
        matrix: [
            a,
            b,
            c,
            d,
            center_x - a * width / 2.0 - c * height / 2.0,
            center_y - b * width / 2.0 - d * height / 2.0,
        ],
    })
}

pub(crate) fn stored_source_rect(
    document: &impl PdfObjectSource,
    dictionary: &Dictionary,
    visible_rect: PdfRect,
    rotation: i64,
    page_rotation: i64,
) -> Result<PdfRect> {
    let Ok(metadata) = dictionary.get(b"EVBTextGeometry") else {
        if rotation != 0 {
            return Err("Imported rotated FreeText has no recoverable canonical geometry".into());
        }
        return Ok(visible_rect);
    };
    let metadata = document.resolved(metadata)?.as_dict()?;
    if metadata.get(b"Version")?.as_i64()? != 1
        || metadata.get(b"Rotation")?.as_i64()? != rotation
        || metadata.get(b"PageRotation")?.as_i64()? != page_rotation
    {
        return Err("Text box geometry metadata is stale".into());
    }
    let source = parse_rect(document.resolved(metadata.get(b"Rect")?)?)?;
    let expected = geometry(source, rotation, page_rotation)?.bounds;
    if [
        expected.x1 - visible_rect.x1,
        expected.y1 - visible_rect.y1,
        expected.x2 - visible_rect.x2,
        expected.y2 - visible_rect.y2,
    ]
    .iter()
    .any(|delta| delta.abs() > 0.01)
    {
        return Err("Text box geometry metadata does not match the visible rectangle".into());
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_cyrillic_diacritics_hebrew_arabic_and_mixed_runs() {
        for text in [
            "Привет мир",
            "Cafe\u{301} naïve Ελληνικά",
            "שָׁלוֹם",
            "العَرَبِيَّة",
            "Latin שלום العربية 123",
        ] {
            validate_text(text).unwrap();
            let lines = layout(text, 500.0, 16.0);
            assert_eq!(lines.len(), 1, "{text}");
            assert!(lines[0].width > 0.0);
            assert!(lines[0].glyphs.iter().all(|glyph| glyph.id != 0), "{text}");
        }
        let arabic = layout("سلام", 500.0, 16.0);
        assert!(arabic[0].rtl);
        assert!(
            arabic[0].glyphs.len() < "سلام".chars().count(),
            "lam-alef must form its ligature"
        );
        let font = face();
        assert_ne!(
            arabic[0].glyphs.last().unwrap().id,
            font.glyph_index('س').unwrap().0,
            "Arabic initial letter must use its contextual form"
        );
    }

    #[test]
    fn wraps_at_graphemes_and_preserves_whitespace_and_paragraph_direction() {
        let text = "Cafe\u{301}  Привет мир\nשלום abc 123\nالعربية";
        let lines = layout(text, 60.0, 16.0);
        assert!(lines.len() > 3);
        assert_eq!(
            lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<String>(),
            text.replace('\n', "")
        );
        assert!(lines.iter().all(|line| !line.text.starts_with('\u{301}')));
        assert!(lines.iter().any(|line| line.rtl));
        for line in &lines {
            let trimmed = line.text.trim_end();
            assert!(layout(trimmed, f64::MAX, 16.0)[0].width <= 60.0);
        }
    }

    #[test]
    fn renders_discretionary_hyphen_only_at_a_selected_wrap() {
        let lines = layout("extra\u{00ad}ordinary", 107.4, 21.0);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "extra\u{00ad}");
        let hyphen = face().glyph_index('-').unwrap().0;
        assert_eq!(lines[0].glyphs.last().unwrap().id, hyphen);
        assert!(lines[0].width <= 107.4);
        let unbroken = layout("extra\u{00ad}ordinary", 400.0, 21.0);
        assert!(!unbroken[0].glyphs.iter().any(|glyph| glyph.id == hyphen));
    }

    #[test]
    fn reembeds_after_an_external_editor_replaces_the_font_mapping() {
        let mut document = Document::new();
        let id = embed_font(&mut document);
        assert_eq!(existing_font(&document), Some(id));
        let descendant = document
            .get_dictionary(id)
            .unwrap()
            .get(b"DescendantFonts")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .as_reference()
            .unwrap();
        document
            .get_dictionary_mut(descendant)
            .unwrap()
            .set("CIDToGIDMap", "ExternalMapping");
        assert_eq!(existing_font(&document), None);
    }

    #[test]
    fn rejects_missing_glyphs_and_controls_before_writing() {
        assert!(validate_text("中文")
            .unwrap_err()
            .to_string()
            .contains("U+4E2D"));
        assert!(validate_text("a\0b").is_err());
        validate_text("a\r\nb\t\u{200f}שלום").unwrap();
    }

    #[test]
    fn font_is_reused_by_object_identity_across_revisions() {
        let mut document = Document::new();
        let id = embed_font(&mut document);
        assert_eq!(existing_font(&document), Some(id));
        let incremental = IncrementalDocument::from_document(document, 0, None);
        assert_eq!(existing_font(incremental.get_prev_documents()), Some(id));
        assert!(existing_font(&incremental.new_document).is_none());
    }
}
