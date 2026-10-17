//! Portable text-box layout and PDF fonts. The renderer loads these exact font
//! bytes. Shaping never depends on fonts installed on the host.
use super::*;
use lopdf::dictionary;
use skrifa::{
    instance::{LocationRef, Size},
    FontRef, GlyphId, MetadataProvider,
};
use unicode_normalization::UnicodeNormalization;

/// Text-box programs in layout order, as the generated face table lists them:
/// script faces claim their own ranges, then DejaVu Sans claims the rest.
pub(crate) static FONTS: [&[u8]; 3] = [
    include_bytes!("../../../public/fonts/annotation/NotoSansHebrew-Regular.ttf"),
    include_bytes!("../../../public/fonts/annotation/NotoSansSyriac-Regular.ttf"),
    include_bytes!("../../../public/fonts/annotation/DejaVuSans.ttf"),
];
pub(crate) const LINE_HEIGHT: f64 = 1.35;
pub(crate) const PADDING_X: f64 = 0.3;
pub(crate) const PADDING_Y: f64 = 0.15;

// The generated face table that also declares the on-screen @font-face ranges.
// DejaVu Sans claims every character it maps; None marks a document program.
fn face_range(program: &[u8]) -> Option<&'static [[u32; 2]]> {
    static RANGES: std::sync::OnceLock<Vec<Option<Vec<[u32; 2]>>>> = std::sync::OnceLock::new();
    let index = FONTS.iter().position(|font| std::ptr::eq(*font, program))?;
    let ranges = RANGES.get_or_init(|| {
        let table = include_str!("../../../packages/contracts/annotationFontCoverage.json");
        let table: serde_json::Value = serde_json::from_str(table).expect("generated face table");
        let fonts = table["fonts"].as_array().into_iter().flatten();
        fonts
            .map(|font| serde_json::from_value(font["unicodeRange"].clone()).ok())
            .collect()
    });
    ranges[index].as_deref().or(Some(&[[0, 0x10ffff]]))
}

fn face() -> FontRef<'static> {
    FontRef::from_index(FONTS[2], 0).expect("the bundled DejaVu Sans font is valid")
}

fn invisible(character: char) -> bool {
    matches!(
        character,
        '\n' | '\r'
            | '\t'
            | '\u{00ad}'
            | '\u{061c}'
            | '\u{200b}'..='\u{200f}'
            | '\u{2028}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{fe00}'..='\u{fe0f}'
            | '\u{feff}'
    )
}

pub(crate) fn validate_text(text: &str) -> Result<()> {
    let faces = FONTS.map(|p| (FontRef::from_index(p, 0).unwrap(), face_range(p)));
    for cluster in unicode_segmentation::UnicodeSegmentation::graphemes(text, true) {
        let drawn = faces
            .iter()
            .any(|(f, r)| text_layout::claims(f, *r, cluster));
        let refused = cluster.chars().find(|c| {
            c.is_control() && !invisible(*c) || !drawn && !text_layout::covers(&face(), *c)
        });
        if let Some(character) = refused {
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
pub(crate) use text_layout::{layout, layout_simple, layout_with_fonts, Line};

#[path = "text_font_program.rs"]
mod text_font_program;
pub(crate) use text_font_program::simple_font_advances;

/// Fonts shared by the text boxes of one save or the labels of one print job.
/// Each appearance names the subsets it draws with; `embed` then writes one
/// subset per program with the glyphs of every appearance, and widths and
/// Unicode mappings for those only.
#[derive(Default)]
pub(crate) struct SharedFonts(BTreeMap<usize, (ObjectId, std::collections::BTreeSet<u16>)>);

impl SharedFonts {
    pub(crate) fn resources(&mut self, document: &mut Document, lines: &[Line]) -> Dictionary {
        let mut fonts = Dictionary::new();
        for glyph in lines.iter().flat_map(|line| &line.glyphs) {
            let (id, glyphs) = self
                .0
                .entry(glyph.font)
                .or_insert_with(|| (document.new_object_id(), Default::default()));
            glyphs.insert(glyph.id);
            fonts.set(format!("TextFont{}", glyph.font), *id);
        }
        fonts
    }

    pub(crate) fn embed(self, document: &mut Document, programs: &[&[u8]]) -> Result<()> {
        use sha2::{Digest, Sha256};
        for (index, (id, glyphs)) in self.0 {
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
            let font =
                text_font_program::embed_font_program(document, programs[index], &name, &glyphs)?;
            document.set_object(id, font);
        }
        Ok(())
    }
}

pub(crate) fn unicode_hex(text: &str, bom: bool) -> String {
    let prefix = if bom { "FEFF" } else { "" };
    let units = text.encode_utf16().map(|unit| format!("{unit:04X}"));
    std::iter::once(prefix.to_string()).chain(units).collect()
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
    // A quarter turn about the centre swaps the bounds' sides.
    let turned = if b == 0.0 {
        (width, height)
    } else {
        (height, width)
    };
    let bounds = centred(center_x, center_y, turned.0, turned.1);
    Ok(Geometry {
        bounds,
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
    let [x1, y1, x2, y2] = rect;
    let stored = rect_object(settled(annotation, PdfRect { x1, y1, x2, y2 }));
    annotation.set("Rect", rect_object(bounds));
    annotation.set("Rotate", rotation);
    annotation.set(
        "EVBTextGeometry",
        dictionary! {
            "Version" => 1,
            "Rotation" => rotation,
            "PageRotation" => page_rotation,
            "Rect" => stored,
        },
    );
}

/// The rectangle of `width` by `height` centred on (`x`, `y`).
fn centred(x: f64, y: f64, width: f64, height: f64) -> PdfRect {
    let (x1, y1, x2, y2) = (
        x - width / 2.0,
        y - height / 2.0,
        x + width / 2.0,
        y + height / 2.0,
    );
    PdfRect { x1, y1, x2, y2 }
}

/// EVB's private layout geometry. PDF reads a key whose value is null as absent.
pub(crate) fn editor_geometry(annotation: &Dictionary) -> Option<&Object> {
    (annotation.get(b"EVBTextGeometry").ok()).filter(|value| !matches!(value, Object::Null))
}

pub(crate) fn transform_editor_geometry(
    document: &impl PdfObjectSource,
    annotation: &mut Dictionary,
    visible: PdfRect,
    matrix: [f64; 6],
    page_rotation: i64,
) -> Result<()> {
    if editor_geometry(annotation).is_none() {
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
    let PdfRect { x1, y1, x2, y2 } = centred(x, y, width, height);
    let bounds = transform.bounds(visible);
    write_editor_geometry(
        annotation,
        [x1, y1, x2, y2],
        rotation,
        page_rotation,
        bounds,
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
    let Some(metadata) = editor_geometry(dictionary) else {
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
    if !near(expected, visible_rect, 0.01) {
        return Err("Text box geometry metadata does not match the visible rectangle".into());
    }
    // The source rectangle describes unrotated text layout in its authored
    // page frame. Keep those layout dimensions when the page's axes swap;
    // rotating only its bounding rectangle would rewrap upright text.
    let (x, y) = ((source.x1 + source.x2) / 2.0, (source.y1 + source.y2) / 2.0);
    let swapped = metadata_page_rotation % 180 != page_rotation % 180;
    let source = if swapped {
        centred(x, y, source.height(), source.width())
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
                    page.set("MediaBox", rect_object(centred(310.0, 420.0, 620.0, 840.0)));
                    page.set("CropBox", rect_object(centred(310.0, 420.0, 600.0, 800.0)));
                    page.set("Rotate", authored_page_rotation);
                    let (width, height) = if authored_page_rotation % 180 == 0 {
                        (360.0, 36.0)
                    } else {
                        (36.0, 360.0)
                    };
                    let source = centred(340.0, 440.0, width, height);
                    let mut editor = TextBoxMutation {
                        original_appearance: None,
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
                    let PdfRect { x1, y1, x2, y2 } = rewritten_source;
                    editor.rect = [x1, y1, x2, y2];
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
                    let PdfAnnotationParseEntry::TextBox(value) = &edited[0] else {
                        panic!("expected text box, got {:?}", edited[0]);
                    };
                    assert_eq!(value.rect, parsed.rect);
                    assert_eq!(value.rotation, parsed.rotation);
                    assert!(value.text.ends_with(" edited"));
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
            let width = sample["width"].as_f64().unwrap();
            let line_json = |line: Line| {
                let glyphs: Vec<_> = line
                    .glyphs
                    .into_iter()
                    .map(|glyph| serde_json::json!([glyph.font, glyph.id, glyph.x, glyph.y]))
                    .collect();
                serde_json::json!({
                    "text": line.text,
                    "width": line.width,
                    "rtl": line.rtl,
                    "glyphs": glyphs,
                })
            };
            let lines: Vec<_> = layout(text, width, 16.0)
                .into_iter()
                .map(line_json)
                .collect();
            // Parse both sides alike: serde_json's default float parsing is not exact.
            let lines: serde_json::Value =
                serde_json::from_str(&serde_json::json!(lines).to_string()).unwrap();
            assert_eq!(lines, sample["lines"], "{text}");
        }
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
    fn contract_coverage_equals_the_bundled_programs() {
        let contract: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/annotationFontCoverage.json"
        ))
        .unwrap();
        let ranges: Vec<[u32; 2]> = serde_json::from_value(contract["ranges"].clone()).unwrap();
        let expected: std::collections::BTreeSet<_> =
            ranges.iter().flat_map(|r| r[0]..=r[1]).collect();
        let actual: std::collections::BTreeSet<_> =
            face().charmap().mappings().map(|m| m.0).collect();
        assert_eq!(
            actual, expected,
            "regenerate coverage from the shipped font programs"
        );
        use sha2::Digest;
        for (font, program) in contract["fonts"].as_array().unwrap().iter().zip(FONTS) {
            let digest = sha2::Sha256::digest(program);
            let digest: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(font["sha256"], digest, "FONTS follows the face table order");
        }
    }
}
