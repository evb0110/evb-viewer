//! Portable text-box layout and PDF fonts. The renderer loads these exact font
//! bytes. Shaping never depends on fonts installed on the host.
use super::*;
use lopdf::dictionary;
use skrifa::{
    instance::{LocationRef, Size},
    FontRef, GlyphId, MetadataProvider,
};
use unicode_normalization::UnicodeNormalization;

pub(crate) const FONT: &[u8] = include_bytes!("../../../public/fonts/annotation/DejaVuSans.ttf");
pub(crate) const LINE_HEIGHT: f64 = 1.35;
pub(crate) const PADDING_X: f64 = 0.3;
pub(crate) const PADDING_Y: f64 = 0.15;

fn face() -> FontRef<'static> {
    FontRef::from_index(FONT, 0).expect("the bundled DejaVu Sans font is valid")
}

fn invisible(character: char) -> bool {
    matches!(character, '\n' | '\r' | '\t' | '\u{00ad}' | '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{fe00}'..='\u{fe0f}' | '\u{feff}')
}

pub(crate) fn validate_text(text: &str) -> Result<()> {
    let fonts = FONTS.map(|bytes| FontRef::from_index(bytes, 0).expect("bundled font"));
    for character in text.chars().filter(|c| !invisible(*c)) {
        let covered = fonts
            .iter()
            .any(|font| font.charmap().map(character).is_some());
        if character.is_control() || !covered {
            return Err(format!(
                "Text box fonts DejaVu Sans, Noto Sans Hebrew, Noto Sans Syriac do not support U+{:04X}",
                u32::from(character)
            )
            .into());
        }
    }
    Ok(())
}

pub(crate) fn baseline_from_top(font_size: f64) -> f64 {
    let metrics = face().metrics(Size::unscaled(), LocationRef::default());
    (PADDING_Y
        + LINE_HEIGHT / 2.0
        + f64::from(metrics.ascent + metrics.descent) / (2.0 * f64::from(metrics.units_per_em)))
        * font_size
}

#[path = "text_layout.rs"]
mod text_layout;
pub(crate) use text_layout::{layout, layout_simple, layout_with_fonts};

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
                crate::decompressed_stream_with_limit(actual, 1024 * 1024),
                crate::decompressed_stream_with_limit(expected, 1024 * 1024),
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

#[path = "text_font_program.rs"]
mod text_font_program;
pub(crate) use text_font_program::{simple_font_advances, FONTS};

pub(crate) fn embed_fonts(
    document: &mut Document,
    lines: &[text_layout::Line],
    programs: &[&[u8]],
) -> Result<Dictionary> {
    use sha2::{Digest, Sha256};
    let mut fonts = Dictionary::new();
    let mut glyphs = BTreeMap::<usize, std::collections::BTreeSet<u16>>::new();
    for glyph in lines.iter().flat_map(|line| &line.glyphs) {
        glyphs.entry(glyph.font).or_default().insert(glyph.id);
    }
    for (index, glyphs) in glyphs {
        let mut digest = Sha256::new();
        digest.update(programs[index]);
        for glyph in &glyphs {
            digest.update(glyph.to_be_bytes());
        }
        let tag: String = digest.finalize()[..6]
            .iter()
            .map(|byte| char::from(b'A' + byte % 26))
            .collect();
        let name = format!("{tag}+TextFont{index}");
        let reference =
            text_font_program::embed_font_program(document, programs[index], &name, &glyphs)?;
        fonts.set(format!("TextFont{index}"), reference);
    }
    Ok(fonts)
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
    editor: &TextBoxMutation,
    page_rotation: i64,
) -> Result<()> {
    crate::postconditions::validate_appearance(document, annotation)?;
    let appearance = document.resolved(annotation.get(b"AP")?)?.as_dict()?;
    let normal = document.resolved(appearance.get(b"N")?)?.as_stream()?;
    let resources = document
        .resolved(normal.dict.get(b"Resources")?)?
        .as_dict()?;
    let mut expected = Document::new();
    let id = crate::annotations::build_text_box_appearance(
        &mut expected,
        editor,
        parse_rect(annotation.get(b"Rect")?)?,
        page_rotation,
    )?;
    let reference = expected.get_object(id)?.as_stream()?;
    let fonts = reference.dict.get(b"Resources")?.as_dict()?.get(b"Font")?;
    if !font_objects_match(document, resources.get(b"Font")?, &expected, fonts, 0) {
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
    let matrix = [
        a,
        b,
        c,
        d,
        center_x - a * width / 2.0 - c * height / 2.0,
        center_y - b * width / 2.0 - d * height / 2.0,
    ];
    Ok(Geometry {
        bounds: crate::split_pages::PdfMatrix::from_values(matrix).bounds(PdfRect {
            x1: 0.0,
            y1: 0.0,
            x2: width,
            y2: height,
        }),
        width,
        height,
        matrix,
    })
}

/// One writer keeps the private layout rectangle and visible PDF bounds in
/// the same canonical frame for saves and page-coordinate operations.
pub(crate) fn write_editor_geometry(
    annotation: &mut Dictionary,
    rect: [f64; 4],
    rotation: i64,
    page_rotation: i64,
    bounds: PdfRect,
) {
    annotation.set("Rect", rect_object(bounds));
    annotation.set("Rotate", rotation);
    annotation.set(
        "EVBTextGeometry",
        dictionary! {
            "Version" => 1, "Rotation" => rotation, "PageRotation" => page_rotation,
            "Rect" => Object::Array(rect.into_iter().map(number_object).collect()),
        },
    );
}

pub(crate) fn transform_editor_geometry(
    document: &impl PdfObjectSource,
    annotation: &mut Dictionary,
    visible: PdfRect,
    matrix: [f64; 6],
    page_rotation: i64,
) -> Result<()> {
    if annotation.get(b"EVBTextGeometry").is_err() {
        return Ok(());
    }
    let rotation = document
        .resolved(annotation.get(b"Rotate").unwrap_or(&Object::Integer(0)))?
        .as_i64()?
        .rem_euclid(360);
    let (source, rotation) =
        stored_editor_geometry(document, annotation, visible, rotation, page_rotation)?;
    let original = geometry(source, rotation, page_rotation)?;
    let transform = crate::split_pages::PdfMatrix::from_values(matrix);
    let scale = transform.a.hypot(transform.b);
    let angle = transform.b.atan2(transform.a).to_degrees();
    let quarter_turn = (angle / 90.0).round() * 90.0;
    let tolerance = 1e-6 * scale.max(1.0);
    if (angle - quarter_turn).abs() > 1e-6
        || scale <= 0.0
        || (transform.c + transform.b).abs() > tolerance
        || (transform.d - transform.a).abs() > tolerance
    {
        return Err("Affine transform cannot preserve editable text-box geometry".into());
    }
    let orientation = transform.concat(crate::split_pages::PdfMatrix::from_values(original.matrix));
    let rotation = (page_rotation
        - (orientation.b.atan2(orientation.a).to_degrees() / 90.0).round() as i64 * 90)
        .rem_euclid(360);
    let (width, height) = if page_rotation % 180 == 0 {
        (original.width * scale, original.height * scale)
    } else {
        (original.height * scale, original.width * scale)
    };
    let (x, y) = transform.transform((source.x1 + source.x2) / 2.0, (source.y1 + source.y2) / 2.0);
    if (scale - 1.0).abs() > 1e-6 {
        let mut bytes = document
            .resolved(annotation.get(b"DA")?)?
            .as_str()?
            .to_vec();
        let tokens = crate::annotations::tokenize_default_appearance(&bytes);
        for (index, &(start, end)) in tokens.iter().enumerate().rev() {
            if &bytes[start..end] == b"Tf" {
                let &(start, end) = tokens[..index].last().ok_or("Missing text-box font size")?;
                let size = std::str::from_utf8(&bytes[start..end])?.parse::<f64>()? * scale;
                if !size.is_finite() || size <= 0.0 || size > 512.0 {
                    return Err("Transformed text-box font size is unsupported".into());
                }
                bytes.splice(start..end, number_to_content(size).into_bytes());
            }
        }
        annotation.set("DA", Object::string_literal(bytes));
    }
    write_editor_geometry(
        annotation,
        [
            x - width / 2.0,
            y - height / 2.0,
            x + width / 2.0,
            y + height / 2.0,
        ],
        rotation,
        page_rotation,
        transform.bounds(visible),
    );
    Ok(())
}

pub(crate) fn stored_editor_geometry(
    document: &impl PdfObjectSource,
    dictionary: &Dictionary,
    visible_rect: PdfRect,
    rotation: i64,
    page_rotation: i64,
) -> Result<(PdfRect, i64)> {
    let Ok(metadata) = dictionary.get(b"EVBTextGeometry") else {
        if rotation != 0 || page_rotation.rem_euclid(360) != 0 {
            return Err("Imported rotated FreeText has no recoverable canonical geometry".into());
        }
        return Ok((visible_rect, rotation));
    };
    let metadata = document.resolved(metadata)?.as_dict()?;
    if metadata.get(b"Version")?.as_i64()? != 1 || metadata.get(b"Rotation")?.as_i64()? != rotation
    {
        return Err("Text box geometry metadata is stale".into());
    }
    // A page operation changes /Rotate without rewriting the annotation's
    // PDF-space /Rect. The private source rectangle was written in the page
    // frame recorded here, so validate the visible rectangle against that
    // frame, then recover the layout rectangle and angle in the current frame.
    // If an external viewer moved the annotation, this comparison still
    // fails closed instead of letting stale private metadata win.
    let metadata_page_rotation = metadata.get(b"PageRotation")?.as_i64()?.rem_euclid(360);
    let source = parse_rect(document.resolved(metadata.get(b"Rect")?)?)?;
    let expected = geometry(source, rotation, metadata_page_rotation)?.bounds;
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
    // The source rectangle describes unrotated text layout in its authored
    // page frame. Keep those layout dimensions when the page's axes swap;
    // rotating only its bounding rectangle would rewrap upright text.
    let source = if metadata_page_rotation % 180 != page_rotation % 180 {
        let center_x = (source.x1 + source.x2) / 2.0;
        let center_y = (source.y1 + source.y2) / 2.0;
        PdfRect {
            x1: center_x - source.height() / 2.0,
            y1: center_y - source.width() / 2.0,
            x2: center_x + source.height() / 2.0,
            y2: center_y + source.width() / 2.0,
        }
    } else {
        source
    };
    Ok((
        source,
        (rotation + page_rotation - metadata_page_rotation).rem_euclid(360),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_box_layout_and_angle_follow_changes_to_page_rotation() {
        for authored_page_rotation in [0, 90, 180, 270] {
            for authored_rotation in [0, 90, 180, 270] {
                for page_rotation in [0, 90, 180, 270] {
                    let mut document = Document::with_version("1.7");
                    let pages_id = document.new_object_id();
                    let page_id = document.add_object(dictionary! {
                        "Type" => "Page", "Parent" => pages_id,
                    });
                    document.set_object(pages_id, dictionary! {
                        "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1,
                    });
                    let catalog_id =
                        document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
                    document.trailer.set("Root", catalog_id);
                    let page = document.get_dictionary_mut(page_id).unwrap();
                    page.set(
                        "MediaBox",
                        rect_object(PdfRect {
                            x1: 0.0,
                            y1: 0.0,
                            x2: 620.0,
                            y2: 840.0,
                        }),
                    );
                    page.set(
                        "CropBox",
                        rect_object(PdfRect {
                            x1: 10.0,
                            y1: 20.0,
                            x2: 610.0,
                            y2: 820.0,
                        }),
                    );
                    page.set("Rotate", authored_page_rotation);
                    let (width, height) = if authored_page_rotation % 180 == 0 {
                        (360.0, 36.0)
                    } else {
                        (36.0, 360.0)
                    };
                    let source = PdfRect {
                        x1: 340.0 - width / 2.0,
                        y1: 440.0 - height / 2.0,
                        x2: 340.0 + width / 2.0,
                        y2: 440.0 + height / 2.0,
                    };
                    let mut editor = TextBoxMutation {
                        page_index: 0,
                        stable_key: "page-rotated-text".to_string(),
                        annotation_id: None,
                        text: "Project 8 recovered annotation".to_string(),
                        rect: [source.x1, source.y1, source.x2, source.y2],
                        rotation: authored_rotation,
                        font_size: 22.0,
                        color: [17, 24, 39],
                        author: None,
                        created_at: None,
                        modified_at: None,
                    };
                    let mut visits = 0;
                    upsert_text_boxes_with_counter(
                        &mut document,
                        std::slice::from_ref(&editor),
                        "D:20261010000000Z",
                        &mut visits,
                        &mut None,
                    )
                    .unwrap();
                    document
                        .get_dictionary_mut(page_id)
                        .unwrap()
                        .set("Rotate", page_rotation);
                    let entries =
                        collect_parsed_annotations(&document, "D:20261010000000Z").unwrap();
                    let PdfAnnotationParseEntry::TextBox(parsed) = &entries[0] else {
                        panic!("expected text box, got {:?}", entries[0]);
                    };
                    let (page_width, page_height, center_x, center_y) = match page_rotation {
                        0 => (600.0, 800.0, 0.55, 0.475),
                        90 => (800.0, 600.0, 0.525, 0.55),
                        180 => (600.0, 800.0, 0.45, 0.525),
                        _ => (800.0, 600.0, 0.475, 0.45),
                    };
                    assert_eq!(
                        parsed.rotation,
                        (i64::from(authored_rotation) + page_rotation - authored_page_rotation)
                            .rem_euclid(360)
                    );
                    for (actual, expected) in [
                        (parsed.rect.left, center_x - 180.0 / page_width),
                        (parsed.rect.top, center_y - 18.0 / page_height),
                        (parsed.rect.width, 360.0 / page_width),
                        (parsed.rect.height, 36.0 / page_height),
                    ] {
                        assert!((actual - expected).abs() < 1e-9);
                    }
                    let rewritten_source = marker_rect_to_pdf_rect(
                        parsed.rect,
                        resolve_page_view(&document, page_id).unwrap(),
                        page_rotation,
                    )
                    .unwrap();
                    let original = crate::text_box_font::geometry(
                        source,
                        i64::from(authored_rotation),
                        authored_page_rotation,
                    )
                    .unwrap();
                    let rewritten = crate::text_box_font::geometry(
                        rewritten_source,
                        parsed.rotation,
                        page_rotation,
                    )
                    .unwrap();
                    assert!((rewritten.width - original.width).abs() < 1e-9);
                    assert!((rewritten.height - original.height).abs() < 1e-9);
                    for (actual, expected) in rewritten.matrix.iter().zip(original.matrix) {
                        assert!((actual - expected).abs() < 1e-9);
                    }
                    editor.rect = [
                        rewritten_source.x1,
                        rewritten_source.y1,
                        rewritten_source.x2,
                        rewritten_source.y2,
                    ];
                    editor.rotation = u16::try_from(parsed.rotation).unwrap();
                    editor.text.push_str(" edited");
                    let mutations = NativeMutationsFile {
                        geometry_updates: vec![NoteGeometryUpdate {
                            object_number: u32::try_from(parsed.object_number).unwrap(),
                            generation_number: u16::try_from(parsed.generation_number).unwrap(),
                            page_index: 0,
                            marker_rect: parsed.rect,
                            color: None,
                            open: None,
                        }],
                        text_boxes: vec![editor],
                        ..NativeMutationsFile::default()
                    };
                    update_note_geometry(
                        &mut document,
                        &mutations.geometry_updates,
                        "D:20261010000100Z",
                    )
                    .unwrap();
                    upsert_text_boxes_with_counter(
                        &mut document,
                        &mutations.text_boxes,
                        "D:20261010000100Z",
                        &mut visits,
                        &mut None,
                    )
                    .unwrap();
                    validate_appended_revision_postconditions(
                        &document,
                        &mutations,
                        "D:20261010000100Z",
                    )
                    .unwrap();
                    let edited =
                        collect_parsed_annotations(&document, "D:20261010000100Z").unwrap();
                    assert!(
                        matches!(&edited[0], PdfAnnotationParseEntry::TextBox(value) if value.rect == parsed.rect && value.rotation == parsed.rotation && value.text.ends_with(" edited"))
                    );
                }
            }
        }
    }

    #[test]
    fn portable_font_preserves_covered_script_shaping_contract() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/portable-text-font-contract.json"
        ))
        .unwrap();
        assert_eq!(
            baseline_from_top(16.0),
            expected["baseline16"].as_f64().unwrap()
        );
        for sample in expected["layouts"].as_array().unwrap() {
            let text = sample["input"].as_str().unwrap();
            // Hebrew now uses its complete Noto program, checked against the
            // independent HarfBuzz page references in annotation_round_trip.
            if text.chars().any(|c| matches!(c, '\u{0590}'..='\u{05ff}')) {
                continue;
            }
            let lines: Vec<_> = layout(text, sample["width"].as_f64().unwrap(), 16.0)
                .into_iter().map(|line| {
                    let glyphs: Vec<_> = line.glyphs.into_iter().map(|glyph| {
                        serde_json::json!([glyph.id, glyph.x, glyph.y])
                    }).collect();
                    serde_json::json!({"text": line.text, "width": line.width, "rtl": line.rtl, "glyphs": glyphs})
                }).collect();
            assert_eq!(serde_json::json!(lines), sample["lines"], "{text}");
        }
    }

    #[test]
    fn shapes_cyrillic_diacritics_hebrew_arabic_and_mixed_runs() {
        for text in [
            "Привет мир",
            "Cafe\u{301} naïve Ελληνικά",
            "שָׁלוֹם",
            "العَرَبِيَّة",
            "ܫܠܵܡܵܐ",
            "בְּרֵאשִׁ֖ית",
            "بَسْمِ لَا بــِسْمِ",
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
            font.charmap().map('س').unwrap().to_u32() as u16,
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
        let hyphen = face().charmap().map('-').unwrap().to_u32() as u16;
        assert_eq!(lines[0].glyphs.last().unwrap().id, hyphen);
        assert!(lines[0].width <= 107.4);
        let unbroken = layout("extra\u{00ad}ordinary", 400.0, 21.0);
        assert!(!unbroken[0].glyphs.iter().any(|glyph| glyph.id == hyphen));
    }

    #[test]
    fn rejects_missing_glyphs_and_controls_before_writing() {
        assert!(validate_text("中文")
            .unwrap_err()
            .to_string()
            .contains("U+4E2D"));
        assert!(validate_text("a\0b").is_err());
        validate_text("a\r\nb\t\u{200f}שלום\nܫܠܵܡܵܐ\nבְּרֵאשִׁ֖ית\nبَسْمِ لَا بــِسْمِ").unwrap();
    }
    #[test]
    fn admits_the_bundled_semitic_characters() {
        let rejected: Vec<_> = ["ܫܠܵܡܵܐ", "בְּרֵאשִׁ֖ית", "بَسْمِ لَا بــِسْمِ"]
            .into_iter()
            .filter_map(|text| {
                validate_text(text)
                    .err()
                    .map(|error| format!("{text}: {error}"))
            })
            .collect();
        assert!(rejected.is_empty(), "{}", rejected.join("\n"));
    }

    #[test]
    fn contract_coverage_equals_the_bundled_programs() {
        let contract: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/annotationFontCoverage.json"
        ))
        .unwrap();
        let expected: std::collections::BTreeSet<_> = contract["ranges"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|range| range[0].as_u64().unwrap() as u32..=range[1].as_u64().unwrap() as u32)
            .collect();
        let actual: std::collections::BTreeSet<_> = FONTS
            .into_iter()
            .flat_map(|program| {
                FontRef::from_index(program, 0)
                    .unwrap()
                    .charmap()
                    .mappings()
                    .map(|(codepoint, _)| codepoint)
                    .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(
            actual, expected,
            "regenerate coverage from the shipped font programs"
        );
    }
}
