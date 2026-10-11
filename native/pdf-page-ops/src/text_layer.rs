use super::*;
use crate::split_pages::validate_crop_rect;
use lopdf::{
    content::{Content, Operation as ContentOperation},
    dictionary, DecompressError, Error as LopdfError,
};
use std::{collections::VecDeque, rc::Rc};

const MAX_TEXT_CONTENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_OBJECT_GRAPH_DEPTH: usize = 128;
fn resolved_dictionary<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    document
        .dereference(object)
        .ok()
        .and_then(|(_, object)| object.as_dict().ok())
}

fn resolved_array<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Vec<Object>> {
    document
        .dereference(object)
        .ok()
        .and_then(|(_, object)| object.as_array().ok())
}

fn resolved_name<'a>(document: &'a Document, object: &'a Object) -> Option<&'a [u8]> {
    document
        .dereference(object)
        .ok()
        .and_then(|(_, object)| object.as_name().ok())
}

fn resolved_number(document: &Document, object: &Object) -> Option<f64> {
    document
        .dereference(object)
        .ok()
        .and_then(|(_, object)| object_to_f64(object).ok())
}

fn collect_fonts_from_resources(
    document: &Document,
    resources: &Dictionary,
    fonts: &mut BTreeMap<Vec<u8>, Object>,
) {
    let Some(font_dictionary) = resources
        .get(b"Font")
        .ok()
        .and_then(|object| resolved_dictionary(document, object))
    else {
        return;
    };
    for (name, font) in font_dictionary {
        fonts.insert(name.clone(), font.clone());
    }
}

fn page_fonts(document: &Document, page_id: ObjectId) -> Result<BTreeMap<Vec<u8>, Object>> {
    let (direct_resources, inherited_resource_ids) = document.get_page_resources(page_id)?;
    let mut fonts = BTreeMap::new();
    // A nearer resource dictionary shadows the inherited one with the same name.
    for resource_id in inherited_resource_ids.into_iter().rev() {
        if let Ok(resources) = document.get_dictionary(resource_id) {
            collect_fonts_from_resources(document, resources, &mut fonts);
        }
    }
    if let Some(resources) = direct_resources {
        collect_fonts_from_resources(document, resources, &mut fonts);
    }
    Ok(fonts)
}

pub(crate) fn page_resources(document: &Document, page_id: ObjectId) -> Result<Dictionary> {
    // Incremental page dictionaries live in `new_document`, while their
    // preserved `/Parent` points into the base document. Resolve a direct
    // `/Resources` value before walking parents so materialized pages do not
    // require copying the entire base page tree into the new revision.
    if let Ok(page) = document.get_dictionary(page_id) {
        if let Ok(resources) = page.get(b"Resources") {
            if let Ok((_, resources)) = document.dereference(resources) {
                if let Ok(resources) = resources.as_dict() {
                    return Ok(resources.clone());
                }
            }
        }
    }
    let (direct_resources, inherited_resource_ids) = document.get_page_resources(page_id)?;
    if let Some(resources) = direct_resources {
        return Ok(resources.clone());
    }
    for resource_id in inherited_resource_ids {
        if let Ok(resources) = document.get_dictionary(resource_id) {
            return Ok(resources.clone());
        }
    }
    Ok(Dictionary::new())
}

enum FontMetrics {
    Simple {
        first_char: u8,
        widths: Vec<f64>,
        missing_width: Option<f64>,
    },
    IdentityH {
        default_width: f64,
        widths: HashMap<u16, f64>,
    },
}

impl FontMetrics {
    fn glyphs<'a>(&self, bytes: &'a [u8]) -> Result<Vec<(u16, &'a [u8])>> {
        match self {
            Self::Simple { .. } => Ok(bytes
                .iter()
                .enumerate()
                .map(|(index, code)| (u16::from(*code), &bytes[index..index + 1]))
                .collect()),
            Self::IdentityH { .. } => {
                if !bytes.len().is_multiple_of(2) {
                    return Err("overlay-text Identity-H string has an odd byte count".into());
                }
                Ok(bytes
                    .chunks_exact(2)
                    .map(|glyph| (u16::from_be_bytes([glyph[0], glyph[1]]), glyph))
                    .collect())
            }
        }
    }

    fn width(&self, code: u16) -> Result<f64> {
        let width = match self {
            Self::Simple {
                first_char,
                widths,
                missing_width,
            } => code
                .checked_sub(u16::from(*first_char))
                .and_then(|index| widths.get(usize::from(index)).copied())
                .or(*missing_width),
            Self::IdentityH {
                default_width,
                widths,
            } => Some(widths.get(&code).copied().unwrap_or(*default_width)),
        }
        .ok_or_else(|| format!("overlay-text font has no width for character code {code}"))?;
        if !width.is_finite() {
            return Err("overlay-text font contains a non-finite width".into());
        }
        Ok(width)
    }

    fn word_spacing_applies(&self, code: u16) -> bool {
        matches!(self, Self::Simple { .. }) && code == 32
    }
}

struct UnicodeMap {
    code_to_char: HashMap<u16, char>,
    char_to_code: HashMap<char, u16>,
}

impl UnicodeMap {
    fn from_font(document: &Document, font: &Object) -> Option<Self> {
        let dictionary = resolved_dictionary(document, font)?;
        let to_unicode = dictionary.get(b"ToUnicode").ok()?;
        let (_, to_unicode) = document.dereference(to_unicode).ok()?;
        // A CMap past the per-stream ceiling is dropped like any unreadable map.
        let cmap = decompressed_stream_with_limit(
            to_unicode.as_stream().ok()?,
            MAX_DECOMPRESSED_PDF_STREAM_BYTES,
        )
        .ok()?;
        let code_to_char = parse_unicode_cmap(&cmap)?;
        let mut char_to_code = HashMap::with_capacity(code_to_char.len());
        for (&code, &character) in &code_to_char {
            if char_to_code.insert(character, code).is_some() {
                // A character with two source codes cannot be placed back at
                // its original glyph position without choosing one encoding.
                return None;
            }
        }
        Some(Self {
            code_to_char,
            char_to_code,
        })
    }

    fn character(&self, code: u16) -> Option<char> {
        self.code_to_char.get(&code).copied()
    }

    fn code(&self, character: char) -> Option<u16> {
        self.char_to_code.get(&character).copied()
    }
}

fn hex_token_value(token: &str) -> Option<Vec<u8>> {
    let value = token.strip_prefix('<')?.strip_suffix('>')?;
    if value.is_empty()
        || value.len() % 2 != 0
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).ok())
        .collect()
}

fn unicode_from_cmap_bytes(bytes: &[u8]) -> Option<char> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let mut characters = char::decode_utf16(units);
    let character = characters.next()?.ok()?;
    characters.next().is_none().then_some(character)
}

fn parse_unicode_cmap(bytes: &[u8]) -> Option<HashMap<u16, char>> {
    let text = String::from_utf8(bytes.to_vec()).ok()?;
    let mut map = HashMap::new();
    let mut mode = None;
    for line in text.lines() {
        if line.contains("beginbfchar") {
            mode = Some("char");
            continue;
        }
        if line.contains("beginbfrange") {
            mode = Some("range");
            continue;
        }
        if line.contains("endbfchar") || line.contains("endbfrange") {
            mode = None;
            continue;
        }
        let tokens = line.split_ascii_whitespace().collect::<Vec<_>>();
        match mode {
            Some("char") if tokens.len() >= 2 => {
                let code = hex_token_value(tokens[0])?;
                let character = unicode_from_cmap_bytes(&hex_token_value(tokens[1])?)?;
                let code = match code.as_slice() {
                    [value] => u16::from(*value),
                    [high, low] => u16::from_be_bytes([*high, *low]),
                    _ => continue,
                };
                map.insert(code, character);
            }
            Some("range") if tokens.len() >= 3 => {
                let first = hex_token_value(tokens[0])?;
                let last = hex_token_value(tokens[1])?;
                let destination = hex_token_value(tokens[2])?;
                let code = match first.as_slice() {
                    [value] => u16::from(*value),
                    [high, low] => u16::from_be_bytes([*high, *low]),
                    _ => continue,
                };
                let last = match last.as_slice() {
                    [value] => u16::from(*value),
                    [high, low] => u16::from_be_bytes([*high, *low]),
                    _ => continue,
                };
                let destination = match destination.as_slice() {
                    [value] => u16::from(*value),
                    [high, low] => u16::from_be_bytes([*high, *low]),
                    _ => continue,
                };
                for offset in 0..=last.saturating_sub(code) {
                    let Some(character) =
                        char::from_u32(u32::from(destination) + u32::from(offset))
                    else {
                        continue;
                    };
                    map.insert(code + offset, character);
                }
            }
            _ => {}
        }
    }
    (!map.is_empty()).then_some(map)
}

fn visualize_logical_text(text: &str) -> String {
    let mut visual = String::with_capacity(text.len());
    let mut word = String::new();
    let flush_word = |word: &mut String, visual: &mut String| {
        if word.is_empty() {
            return;
        }
        let bidi = unicode_bidi::BidiInfo::new(word.as_str(), None);
        if let Some(paragraph) = bidi.paragraphs.first() {
            visual.push_str(&bidi.reorder_line(paragraph, 0..word.len()));
        } else {
            visual.push_str(word);
        }
        word.clear();
    };
    for character in text.chars() {
        if character.is_whitespace() {
            flush_word(&mut word, &mut visual);
            visual.push(character);
        } else {
            word.push(character);
        }
    }
    flush_word(&mut word, &mut visual);
    visual
}

fn contains_rtl(text: &str) -> bool {
    text.chars().any(|character| {
        matches!(
            unicode_bidi::bidi_class(character),
            unicode_bidi::BidiClass::R
                | unicode_bidi::BidiClass::AL
                | unicode_bidi::BidiClass::RLE
                | unicode_bidi::BidiClass::RLO
                | unicode_bidi::BidiClass::RLI
        )
    })
}

struct TextFont {
    metrics: FontMetrics,
    unicode: Option<UnicodeMap>,
}

/// Parses a source page font once per resource name for the page's text walk
/// and its LTR marking pass, which share `parsed`. A parsed font is immutable
/// and shared: Tesseract's ToUnicode CMap covers all 65,536 codes, so copying
/// or reparsing it per show string or per `Tf` dominated the walk. A font that
/// fails to parse is not kept, so every use reports the same error.
fn parsed_font(
    parsed: &mut HashMap<Vec<u8>, Rc<TextFont>>,
    document: &Document,
    name: &[u8],
    font: &Object,
) -> Result<Rc<TextFont>> {
    if let Some(font) = parsed.get(name) {
        return Ok(Rc::clone(font));
    }
    let font = Rc::new(TextFont {
        metrics: parse_font_metrics(document, font)?,
        unicode: UnicodeMap::from_font(document, font),
    });
    parsed.insert(name.to_vec(), Rc::clone(&font));
    Ok(font)
}

fn dictionary_number(document: &Document, dictionary: &Dictionary, key: &[u8]) -> Option<f64> {
    dictionary
        .get(key)
        .ok()
        .and_then(|value| resolved_number(document, value))
}

fn parse_font_metrics(document: &Document, font: &Object) -> Result<FontMetrics> {
    let dictionary = resolved_dictionary(document, font)
        .ok_or("overlay-text source font is not a dictionary")?;
    let subtype = dictionary
        .get(b"Subtype")
        .ok()
        .and_then(|value| resolved_name(document, value))
        .ok_or("overlay-text source font has no valid Subtype")?;
    if subtype == b"Type0" {
        let encoding = dictionary
            .get(b"Encoding")
            .ok()
            .and_then(|value| resolved_name(document, value))
            .ok_or("overlay-text Type0 font has no named Encoding")?;
        if encoding != b"Identity-H" {
            return Err(format!(
                "overlay-text cannot safely measure Type0 encoding /{}",
                String::from_utf8_lossy(encoding)
            )
            .into());
        }
        let descendants = dictionary
            .get(b"DescendantFonts")
            .ok()
            .and_then(|value| resolved_array(document, value))
            .ok_or("overlay-text Type0 DescendantFonts is not an array")?;
        if descendants.len() != 1 {
            return Err("overlay-text Type0 font must have one descendant".into());
        }
        let descendant = resolved_dictionary(document, &descendants[0])
            .ok_or("overlay-text Type0 descendant is not a dictionary")?;
        let default_width = dictionary_number(document, descendant, b"DW").unwrap_or(1_000.0);
        let mut widths = HashMap::new();
        if let Some(entries) = descendant
            .get(b"W")
            .ok()
            .and_then(|value| resolved_array(document, value))
        {
            let mut index = 0;
            while index < entries.len() {
                let first = entries[index]
                    .as_i64()
                    .map_err(|_| "overlay-text CID width range has an invalid first code")?;
                let first = u16::try_from(first)
                    .map_err(|_| "overlay-text CID width code is out of range")?;
                index += 1;
                let Some(next) = entries.get(index) else {
                    return Err("overlay-text CID width range is truncated".into());
                };
                if let Some(array) = resolved_array(document, next) {
                    for (offset, value) in array.iter().enumerate() {
                        let code = u16::try_from(u32::from(first) + offset as u32)
                            .map_err(|_| "overlay-text CID width code is out of range")?;
                        widths.insert(
                            code,
                            resolved_number(document, value)
                                .ok_or("overlay-text CID width is not numeric")?,
                        );
                    }
                    index += 1;
                } else {
                    let last = next
                        .as_i64()
                        .map_err(|_| "overlay-text CID width range has an invalid last code")?;
                    let last = u16::try_from(last)
                        .map_err(|_| "overlay-text CID width code is out of range")?;
                    let width = resolved_number(
                        document,
                        entries
                            .get(index + 1)
                            .ok_or("overlay-text CID width range is truncated")?,
                    )
                    .ok_or("overlay-text CID width is not numeric")?;
                    if last < first {
                        return Err("overlay-text CID width range is reversed".into());
                    }
                    for code in first..=last {
                        widths.insert(code, width);
                    }
                    index += 2;
                }
            }
        }
        if !default_width.is_finite() || widths.values().any(|width| !width.is_finite()) {
            return Err("overlay-text Type0 font contains a non-finite width".into());
        }
        return Ok(FontMetrics::IdentityH {
            default_width,
            widths,
        });
    }

    let first = dictionary
        .get(b"FirstChar")
        .ok()
        .and_then(|value| resolved_number(document, value))
        .filter(|value| value.fract().abs() <= f64::EPSILON)
        .map(|value| value as i64)
        .and_then(|value| u8::try_from(value).ok())
        .ok_or("overlay-text simple font has no valid FirstChar")?;
    let widths = dictionary
        .get(b"Widths")
        .ok()
        .and_then(|value| resolved_array(document, value))
        .ok_or("overlay-text simple font has no measurable Widths")?
        .iter()
        .map(|value| {
            resolved_number(document, value)
                .ok_or_else(|| "overlay-text simple font contains a non-numeric width".into())
        })
        .collect::<Result<Vec<_>>>()?;
    if widths.is_empty() {
        return Err("overlay-text simple font has an empty Widths array".into());
    }
    let missing_width = dictionary
        .get(b"FontDescriptor")
        .ok()
        .and_then(|value| resolved_dictionary(document, value))
        .and_then(|descriptor| dictionary_number(document, descriptor, b"MissingWidth"));
    Ok(FontMetrics::Simple {
        first_char: first,
        widths,
        missing_width,
    })
}

use crate::split_pages::PdfMatrix as TextMatrix;

#[derive(Clone)]
struct TextFilterState {
    line_matrix: Option<TextMatrix>,
    text_matrix: Option<TextMatrix>,
    leading: Option<f64>,
    font: Option<Rc<TextFont>>,
    font_name: Option<Vec<u8>>,
    font_size: f64,
    char_spacing: f64,
    word_spacing: f64,
    horizontal_scale: f64,
    rise: f64,
}

#[derive(Clone)]
struct TextGlyph {
    code: u16,
    bytes: Vec<u8>,
    start: TextMatrix,
    advance: f64,
    character: Option<char>,
}

impl TextFilterState {
    fn new() -> Self {
        Self {
            line_matrix: Some(TextMatrix::IDENTITY),
            text_matrix: Some(TextMatrix::IDENTITY),
            leading: Some(0.0),
            font: None,
            font_name: None,
            font_size: 0.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            horizontal_scale: 1.0,
            rise: 0.0,
        }
    }

    fn set_matrix(&mut self, matrix: Option<TextMatrix>) {
        self.line_matrix = matrix;
        self.text_matrix = matrix;
    }

    fn begin_text(&mut self) {
        self.line_matrix = Some(TextMatrix::IDENTITY);
        self.text_matrix = Some(TextMatrix::IDENTITY);
    }

    fn end_text(&mut self) {
        self.line_matrix = None;
        self.text_matrix = None;
    }

    fn move_line(&mut self, x: f64, y: f64) {
        self.set_matrix(
            self.line_matrix
                .map(|line| line.concat(TextMatrix::translation(x, y))),
        );
    }

    fn next_line(&mut self) {
        let Some(leading) = self.leading else {
            self.set_matrix(None);
            return;
        };
        self.move_line(0.0, -leading);
    }

    fn advance(&mut self, amount: f64) -> Result<()> {
        if !amount.is_finite() {
            return Err("overlay-text computed a non-finite text advance".into());
        }
        self.text_matrix = Some(
            self.text_matrix
                .ok_or("overlay-text show operator has no valid text matrix")?
                .concat(TextMatrix::translation(amount, 0.0)),
        );
        Ok(())
    }

    fn glyph_advance(&self, metrics: &FontMetrics, code: u16) -> Result<f64> {
        let width = metrics.width(code)?;
        let advance = ((width / 1_000.0) * self.font_size
            + self.char_spacing
            + if metrics.word_spacing_applies(code) {
                self.word_spacing
            } else {
                0.0
            })
            * self.horizontal_scale;
        if !advance.is_finite() {
            return Err("overlay-text computed a non-finite glyph advance".into());
        }
        Ok(advance)
    }

    fn measure_glyphs(&mut self, bytes: &[u8]) -> Result<Vec<TextGlyph>> {
        let font = Rc::clone(
            self.font
                .as_ref()
                .ok_or("overlay-text show operator has no selected font")?,
        );
        let mut glyphs = Vec::new();
        for (code, glyph) in font.metrics.glyphs(bytes)? {
            let start = self
                .text_matrix
                .ok_or("overlay-text show operator has no valid text matrix")?;
            let advance = self.glyph_advance(&font.metrics, code)?;
            glyphs.push(TextGlyph {
                code,
                bytes: glyph.to_vec(),
                start,
                advance,
                character: font.unicode.as_ref().and_then(|map| map.character(code)),
            });
            self.advance(advance)?;
        }
        Ok(glyphs)
    }
}

fn target_point_is_visible(
    text_matrix: TextMatrix,
    rise: f64,
    graphics: TextMatrix,
    overlay: TextMatrix,
    target_view: PdfRect,
) -> Result<bool> {
    let (text_x, text_y) = text_matrix.transform(0.0, rise);
    let (source_x, source_y) = graphics.transform(text_x, text_y);
    let (target_x, target_y) = overlay.transform(source_x, source_y);
    // Use half-open page bounds: adjacent split outputs then have one
    // deterministic owner for a glyph origin exactly on their shared seam.
    Ok(target_x >= target_view.x1
        && target_x < target_view.x2
        && target_y >= target_view.y1
        && target_y < target_view.y2)
}

fn push_string(array: &mut Vec<Object>, bytes: &[u8], format: lopdf::StringFormat) {
    if let Some(Object::String(previous, previous_format)) = array.last_mut() {
        if *previous_format == format {
            previous.extend_from_slice(bytes);
            return;
        }
    }
    array.push(Object::String(bytes.to_vec(), format));
}

fn push_adjustment(array: &mut Vec<Object>, adjustment: f64) {
    if adjustment.abs() <= f64::EPSILON {
        return;
    }
    if let Some(previous) = array.last_mut().and_then(|value| value.as_float().ok()) {
        let combined = f64::from(previous) + adjustment;
        *array.last_mut().unwrap() = number_object(combined);
    } else {
        array.push(number_object(adjustment));
    }
}

fn encode_font_code(metrics: &FontMetrics, code: u16) -> Option<Vec<u8>> {
    match metrics {
        FontMetrics::Simple { .. } => u8::try_from(code).ok().map(|value| vec![value]),
        FontMetrics::IdentityH { .. } => Some(code.to_be_bytes().to_vec()),
    }
}

fn reorder_glyphs(glyphs: &[TextGlyph], font: &TextFont) -> Option<Vec<TextGlyph>> {
    let unicode = font.unicode.as_ref()?;
    let source = glyphs
        .iter()
        .map(|glyph| glyph.character)
        .collect::<Option<String>>()?;
    if !contains_rtl(&source) {
        return None;
    }
    let visual = visualize_logical_text(&source);
    let mut positions = HashMap::<char, VecDeque<usize>>::new();
    for (index, character) in source.chars().enumerate() {
        positions.entry(character).or_default().push_back(index);
    }
    let mut reordered = Vec::with_capacity(glyphs.len());
    for character in visual.chars() {
        let index = positions.get_mut(&character)?.pop_front()?;
        let mut glyph = glyphs.get(index)?.clone();
        glyph.code = unicode.code(character)?;
        glyph.bytes = encode_font_code(&font.metrics, glyph.code)?;
        reordered.push(glyph);
    }
    (reordered.len() == glyphs.len()).then_some(reordered)
}

fn repaired_show_operations(
    glyphs: &[TextGlyph],
    text: &TextFilterState,
    line_matrix: TextMatrix,
    final_matrix: TextMatrix,
    format: lopdf::StringFormat,
    force_pdfjs_item_breaks: bool,
    visible: impl Fn(usize) -> Result<bool>,
) -> Result<Option<Vec<ContentOperation>>> {
    let mut operations = Vec::with_capacity(glyphs.len() * 2 + 3);
    for (index, glyph) in glyphs.iter().enumerate() {
        if visible(index)? {
            // PDF.js combines adjacent text operators before running its bidi
            // pass. Tesseract's RTL operators already carry logical codepoints
            // at right-to-left origins, so make each CID its own run while
            // keeping those origins unchanged. The sub-point size delta is
            // below the visible layer's precision but changes PDF.js's run
            // boundary, not the Unicode data or glyph placement.
            if force_pdfjs_item_breaks
                && !glyph.character.is_some_and(|character| {
                    unicode_bidi::bidi_class(character) == unicode_bidi::BidiClass::NSM
                })
            {
                let font_name = text
                    .font_name
                    .as_ref()
                    .ok_or("overlay-text repaired RTL text has no selected font name")?;
                operations.push(ContentOperation::new(
                    "Tf",
                    vec![
                        Object::Name(font_name.clone()),
                        number_object(text.font_size + (index as f64 + 1.0) * 0.001),
                    ],
                ));
            }
            operations.push(ContentOperation::new("Tm", glyph.start.operands()));
            operations.push(ContentOperation::new(
                "Tj",
                vec![Object::String(glyph.bytes.clone(), format)],
            ));
        }
    }

    let scale = text.font_size * text.horizontal_scale;
    if !scale.is_finite() || scale.abs() <= f64::EPSILON {
        return Ok(None);
    }
    let offset = final_matrix
        .local_horizontal_offset(line_matrix)
        .ok_or("overlay-text could not preserve the final text position")?;
    operations.push(ContentOperation::new("Tm", line_matrix.operands()));
    let adjustment = -offset * 1_000.0 / scale;
    if adjustment.abs() > f64::EPSILON {
        operations.push(ContentOperation::new(
            "TJ",
            vec![Object::Array(vec![number_object(adjustment)])],
        ));
    }
    if force_pdfjs_item_breaks {
        let font_name = text
            .font_name
            .as_ref()
            .ok_or("overlay-text repaired RTL text has no selected font name")?;
        operations.push(ContentOperation::new(
            "Tf",
            vec![
                Object::Name(font_name.clone()),
                number_object(text.font_size),
            ],
        ));
    }
    Ok(Some(operations))
}

fn repair_show_string(
    bytes: &[u8],
    format: lopdf::StringFormat,
    text: &mut TextFilterState,
) -> Result<Option<Vec<ContentOperation>>> {
    let original = text.clone();
    let result = match text.font.as_ref().cloned() {
        Some(font) => {
            let glyphs = match text.measure_glyphs(bytes) {
                Ok(glyphs) => glyphs,
                Err(_) => {
                    *text = original;
                    return Ok(None);
                }
            };
            let Some(line_matrix) = text.line_matrix else {
                return Ok(None);
            };
            let Some(final_matrix) = text.text_matrix else {
                return Ok(None);
            };
            let source = glyphs
                .iter()
                .filter_map(|glyph| glyph.character)
                .collect::<String>();
            let has_rtl = contains_rtl(&source);
            let ordered = if has_rtl && line_matrix.a >= 0.0 {
                let Some(reordered) = reorder_glyphs(&glyphs, &font) else {
                    return Ok(None);
                };
                reordered
            } else {
                glyphs
            };
            repaired_show_operations(
                &ordered,
                text,
                line_matrix,
                final_matrix,
                format,
                has_rtl && line_matrix.a < 0.0,
                |_| Ok(true),
            )?
        }
        None => None,
    };
    Ok(result)
}

fn repair_filtered_show_string(
    bytes: &[u8],
    format: lopdf::StringFormat,
    text: &mut TextFilterState,
    graphics: TextMatrix,
    overlay: TextMatrix,
    target_view: PdfRect,
) -> Result<Option<Vec<ContentOperation>>> {
    let original = text.clone();
    let glyphs = match text.measure_glyphs(bytes) {
        Ok(glyphs) => glyphs,
        Err(error) => {
            *text = original;
            return Err(error);
        }
    };
    let font = text
        .font
        .as_ref()
        .cloned()
        .ok_or("overlay-text show operator has no selected font")?;
    let Some(line_matrix) = text.line_matrix else {
        *text = original;
        return Ok(None);
    };
    let Some(final_matrix) = text.text_matrix else {
        *text = original;
        return Ok(None);
    };
    let visibility_glyphs = glyphs.clone();
    let source = glyphs
        .iter()
        .filter_map(|glyph| glyph.character)
        .collect::<String>();
    let has_rtl = contains_rtl(&source);
    let ordered = if has_rtl && line_matrix.a >= 0.0 {
        let Some(reordered) = reorder_glyphs(&glyphs, &font) else {
            *text = original;
            return Ok(None);
        };
        reordered
    } else {
        glyphs
    };
    let operations = repaired_show_operations(
        &ordered,
        text,
        line_matrix,
        final_matrix,
        format,
        has_rtl && line_matrix.a < 0.0,
        |index| {
            target_point_is_visible(
                visibility_glyphs[index].start,
                text.rise,
                graphics,
                overlay,
                target_view,
            )
        },
    )?;
    Ok(operations)
}

fn same_text_line(left: TextMatrix, right: TextMatrix) -> bool {
    let Some(offset) = right.local_horizontal_offset(left) else {
        return false;
    };
    let determinant = left.a * left.d - left.b * left.c;
    if determinant.abs() <= f64::EPSILON {
        return false;
    }
    let delta_x = right.e - left.e;
    let delta_y = right.f - left.f;
    let perpendicular = (left.a * delta_y - left.b * delta_x) / determinant;
    offset.is_finite() && perpendicular.abs() <= 0.01
}

fn marked_ltr_text_object(
    source: &Document,
    source_fonts: &Option<BTreeMap<Vec<u8>, Object>>,
    parsed_fonts: &mut HashMap<Vec<u8>, Rc<TextFont>>,
    block: &[ContentOperation],
) -> Result<Option<Vec<ContentOperation>>> {
    let mut text = TextFilterState::new();
    let mut lines: Vec<(usize, TextMatrix, String)> = Vec::new();
    let mut previous_end: Option<TextMatrix> = None;
    for (index, operation) in block.iter().enumerate() {
        if operation.operator == "Tf" && operation.operands.len() == 2 {
            let Ok(name) = operation.operands[0].as_name() else {
                return Ok(None);
            };
            if text.font_name.as_deref() != Some(name) {
                let Some(source_font) = source_fonts.as_ref().and_then(|fonts| fonts.get(name))
                else {
                    return Ok(None);
                };
                let Ok(font) = parsed_font(parsed_fonts, source, name, source_font) else {
                    return Ok(None);
                };
                text.font = Some(font);
                text.font_name = Some(name.to_vec());
            }
            text.font_size = object_to_f64(&operation.operands[1])?;
        } else if operation.operands.len() == 1 {
            match operation.operator.as_str() {
                "Tc" => text.char_spacing = object_to_f64(&operation.operands[0])?,
                "Tw" => text.word_spacing = object_to_f64(&operation.operands[0])?,
                "Tz" => text.horizontal_scale = object_to_f64(&operation.operands[0])? / 100.0,
                _ => {}
            }
        }
        if operation.operator != "Tj" {
            if operation.operator == "TJ"
                && operation.operands.iter().any(|operand| {
                    operand.as_array().is_ok_and(|values| {
                        values
                            .iter()
                            .any(|value| matches!(value, Object::String(..)))
                    })
                })
            {
                return Ok(None);
            }
            continue;
        }
        let Some(matrix) = index.checked_sub(1).and_then(|index| block.get(index)) else {
            return Ok(None);
        };
        if matrix.operator != "Tm" || operation.operands.len() != 1 {
            return Ok(None);
        }
        let Some(matrix) = TextMatrix::from_operation(matrix) else {
            return Ok(None);
        };
        if matrix.a < 0.0 {
            return Ok(None);
        }
        let Object::String(bytes, _) = &operation.operands[0] else {
            return Ok(None);
        };
        text.set_matrix(Some(matrix));
        let Ok(glyphs) = text.measure_glyphs(bytes) else {
            return Ok(None);
        };
        let Some(characters) = glyphs
            .iter()
            .map(|glyph| glyph.character)
            .collect::<Option<String>>()
        else {
            return Ok(None);
        };
        if contains_rtl(&characters) {
            return Ok(None);
        }
        if lines
            .last()
            .is_none_or(|line| !same_text_line(line.1, matrix))
        {
            lines.push((index - 1, matrix, String::new()));
            previous_end = None;
        }
        let line = &mut lines.last_mut().unwrap().2;
        if previous_end
            .and_then(|end| matrix.local_horizontal_offset(end))
            .is_some_and(|gap| gap > 0.01)
            && !line.ends_with(char::is_whitespace)
            && !characters.starts_with(char::is_whitespace)
        {
            return Ok(None);
        }
        line.push_str(&characters);
        previous_end = text.text_matrix;
    }
    if lines.is_empty() {
        return Ok(None);
    }
    // Give geometry-sorting extractors a complete logical line without moving
    // the glyphs or changing their font sizes and horizontal scaling.
    let mut rewritten = Vec::with_capacity(block.len() + lines.len() * 2);
    rewritten.extend_from_slice(&block[..lines[0].0]);
    for (index, (start, _, characters)) in lines.iter().enumerate() {
        let end = lines.get(index + 1).map_or(block.len() - 1, |line| line.0);
        let mut actual_text = vec![0xfe, 0xff];
        for unit in characters.encode_utf16() {
            actual_text.extend_from_slice(&unit.to_be_bytes());
        }
        rewritten.push(ContentOperation::new(
            "BDC",
            vec![
                Object::Name(b"Span".to_vec()),
                Object::Dictionary(dictionary! {
                    "ActualText" => Object::String(actual_text, lopdf::StringFormat::Hexadecimal),
                }),
            ],
        ));
        rewritten.extend_from_slice(&block[*start..end]);
        rewritten.push(ContentOperation::new("EMC", Vec::new()));
    }
    rewritten.push(block.last().unwrap().clone());
    Ok(Some(rewritten))
}

fn mark_ltr_text_objects(
    source: &Document,
    source_fonts: &Option<BTreeMap<Vec<u8>, Object>>,
    parsed_fonts: &mut HashMap<Vec<u8>, Rc<TextFont>>,
    operations: Vec<ContentOperation>,
) -> Result<Vec<ContentOperation>> {
    let mut rewritten = Vec::with_capacity(operations.len());
    let mut index = 0;
    while index < operations.len() {
        if operations[index].operator == "BT" {
            if let Some(relative_end) = operations[index + 1..]
                .iter()
                .position(|operation| operation.operator == "ET")
            {
                let end = index + relative_end + 1;
                if let Some(block) = marked_ltr_text_object(
                    source,
                    source_fonts,
                    parsed_fonts,
                    &operations[index..=end],
                )? {
                    rewritten.extend(block);
                    index = end + 1;
                    continue;
                }
            }
        }
        rewritten.push(operations[index].clone());
        index += 1;
    }
    Ok(rewritten)
}

fn filter_string(
    bytes: &[u8],
    format: lopdf::StringFormat,
    text: &mut TextFilterState,
    graphics: TextMatrix,
    overlay: TextMatrix,
    target_view: PdfRect,
    output: &mut Vec<Object>,
) -> Result<()> {
    let glyphs = text.measure_glyphs(bytes)?;
    for glyph in glyphs {
        let visible =
            target_point_is_visible(glyph.start, text.rise, graphics, overlay, target_view)?;
        if visible {
            push_string(output, &glyph.bytes, format);
        } else if glyph.advance.abs() > f64::EPSILON {
            let scale = text.font_size * text.horizontal_scale;
            if !scale.is_finite() || scale.abs() <= f64::EPSILON {
                return Err(
                    "overlay-text cannot preserve a hidden glyph advance at zero text scale".into(),
                );
            }
            push_adjustment(output, -glyph.advance * 1_000.0 / scale);
        }
    }
    Ok(())
}

fn filter_show_array(
    values: &[Object],
    text: &mut TextFilterState,
    graphics: TextMatrix,
    overlay: TextMatrix,
    target_view: PdfRect,
) -> Result<Vec<Object>> {
    let mut output = Vec::new();
    for value in values {
        match value {
            Object::String(bytes, format) => filter_string(
                bytes,
                *format,
                text,
                graphics,
                overlay,
                target_view,
                &mut output,
            )?,
            Object::Integer(_) | Object::Real(_) => {
                let adjustment = object_to_f64(value)?;
                push_adjustment(&mut output, adjustment);
                text.advance(-adjustment / 1_000.0 * text.font_size * text.horizontal_scale)?;
            }
            _ => return Err("overlay-text TJ array contains an unsupported value".into()),
        }
    }
    Ok(output)
}

fn normalize_greek_micro_sign_in_text(bytes: &mut [u8]) {
    for pair in bytes.chunks_exact_mut(2) {
        if pair == [0x00, 0xB5] {
            pair[0] = 0x03;
            pair[1] = 0xBC;
        }
    }
}

fn normalize_greek_micro_sign_in_operations(operations: &mut [ContentOperation]) {
    for operation in operations {
        for operand in &mut operation.operands {
            match operand {
                Object::String(bytes, _) => normalize_greek_micro_sign_in_text(bytes),
                Object::Array(values) if operation.operator == "TJ" => {
                    for value in values {
                        if let Object::String(bytes, _) = value {
                            normalize_greek_micro_sign_in_text(bytes);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

pub(crate) fn clone_object_graph(
    source: &Document,
    target: &mut Document,
    object: &Object,
    copied: &mut HashMap<ObjectId, ObjectId>,
    pages: &[OverlayPage<'_>],
    transform: &impl Fn(&mut Document, &mut Dictionary) -> Result<()>,
    depth: usize,
) -> Result<Object> {
    if depth > MAX_OBJECT_GRAPH_DEPTH {
        return Err("overlay-text object graph exceeded the dereference limit".into());
    }
    match object {
        Object::Reference(source_id) => {
            if let Some(target_id) = copied.get(source_id).copied().or_else(|| {
                pages
                    .iter()
                    .find(|page| page.0 == *source_id)
                    .map(|page| page.1)
            }) {
                return Ok(Object::Reference(target_id));
            }
            let target_id = target.new_object_id();
            copied.insert(*source_id, target_id);
            let mut cloned = clone_object_graph(
                source,
                target,
                source.objects.get(source_id).ok_or_else(|| {
                    format!("overlay-text source object {source_id:?} is missing")
                })?,
                copied,
                pages,
                transform,
                depth + 1,
            )?;
            if let Ok(annotation) = cloned.as_dict_mut() {
                if annotation.has(b"Subtype") && annotation_has_geometry(annotation) {
                    transform(target, annotation)?;
                }
            }
            target.objects.insert(target_id, cloned);
            Ok(Object::Reference(target_id))
        }
        Object::Array(items) => Ok(Object::Array(
            items
                .iter()
                .map(|item| {
                    clone_object_graph(source, target, item, copied, pages, transform, depth + 1)
                })
                .collect::<Result<Vec<_>>>()?,
        )),
        Object::Dictionary(_) | Object::Stream(_) => {
            let mut cloned = object.clone();
            let dictionary = match &mut cloned {
                Object::Dictionary(dictionary) => dictionary,
                Object::Stream(stream) => {
                    stream.start_position = None;
                    &mut stream.dict
                }
                _ => unreachable!(),
            };
            if matches!(
                resolved_name(source, dictionary.get(b"Type").unwrap_or(&Object::Null)),
                Some(b"Page" | b"Pages")
            ) {
                return Err("overlay-text references an unmapped source page or tree".into());
            }
            let key: &[u8] = if resolved_name(source, dictionary.get(b"S").unwrap_or(&Object::Null))
                == Some(b"GoTo")
            {
                b"D"
            } else {
                b"Dest"
            };
            let destination = dictionary.remove(key);
            for (_, value) in dictionary.iter_mut() {
                *value =
                    clone_object_graph(source, target, value, copied, pages, transform, depth + 1)?;
            }
            // A destination no output shows is dropped; the annotation stays.
            if let Some(destination) = destination {
                if let Some(remapped) = crate::internal_destinations::remap_internal_destination(
                    source,
                    &destination,
                    pages,
                )? {
                    dictionary.set(key, remapped);
                }
            }
            Ok(cloned)
        }
        value => Ok(value.clone()),
    }
}

fn text_operations(
    source: &Document,
    page_id: ObjectId,
    filter: Option<(TextMatrix, PdfRect)>,
) -> Result<(Vec<ContentOperation>, HashSet<Vec<u8>>)> {
    let bytes = crate::page_content_with_limit(source, page_id, MAX_TEXT_CONTENT_BYTES)
        .map_err(|error| match error {
            LopdfError::Decompress(DecompressError::MemoryLimitExceeded { limit }) => {
                domain_error(
                    NativeErrorCode::TooLarge,
                    format!(
                        "overlay-text source page content exceeds the {limit}-byte decompression ceiling"
                    ),
                )
            }
            error => Box::new(error) as Box<dyn Error>,
        })?;
    let content = Content::decode(&bytes)?;
    let strict = filter.is_some();
    let source_fonts = if strict {
        Some(page_fonts(source, page_id)?)
    } else {
        page_fonts(source, page_id).ok()
    };
    let mut parsed_fonts = HashMap::new();
    let mut operations = Vec::new();
    let mut fonts = HashSet::new();
    let mut in_text = false;
    let mut graphics = TextMatrix::IDENTITY;
    let mut graphics_stack = Vec::new();
    let mut text = TextFilterState::new();
    for operation in content.operations {
        match operation.operator.as_str() {
            // Preserve affine graphics state around text objects. Image, path,
            // and paint operators are deliberately discarded.
            "q" if !in_text => {
                if strict && !operation.operands.is_empty() {
                    return Err("overlay-text q operator has operands".into());
                }
                graphics_stack.push((graphics, text.clone()));
                operations.push(operation);
            }
            "Q" if !in_text => {
                if strict && !operation.operands.is_empty() {
                    return Err("overlay-text Q operator has operands".into());
                }
                let Some((restored_graphics, restored_text)) = graphics_stack.pop() else {
                    if strict {
                        return Err("overlay-text source has an unmatched Q operator".into());
                    }
                    graphics = TextMatrix::IDENTITY;
                    operations.push(operation);
                    continue;
                };
                graphics = restored_graphics;
                text = restored_text;
                operations.push(operation);
            }
            "cm" if !in_text => {
                let next = TextMatrix::from_operation(&operation);
                if strict && next.is_none() {
                    return Err("overlay-text source has a malformed cm operator".into());
                }
                if let Some(next) = next {
                    graphics = graphics.concat(next);
                }
                operations.push(operation);
            }
            "BT" if !in_text => {
                if strict && !operation.operands.is_empty() {
                    return Err("overlay-text BT operator has operands".into());
                }
                in_text = true;
                text.begin_text();
                operations.push(operation);
                operations.push(ContentOperation::new("Tr", vec![3.into()]));
            }
            "ET" if in_text => {
                if strict && !operation.operands.is_empty() {
                    return Err("overlay-text ET operator has operands".into());
                }
                in_text = false;
                text.end_text();
                operations.push(operation);
            }
            "Tr" if in_text => {
                if strict
                    && (operation.operands.len() != 1
                        || object_to_f64(&operation.operands[0]).is_err())
                {
                    return Err("overlay-text source has a malformed Tr operator".into());
                }
                // The overlay is search data, never visible page ink.
                operations.push(ContentOperation::new("Tr", vec![3.into()]));
            }
            "Tf" if in_text => {
                let parsed = operation
                    .operands
                    .first()
                    .and_then(|value| value.as_name().ok())
                    .zip(
                        operation
                            .operands
                            .get(1)
                            .and_then(|value| object_to_f64(value).ok()),
                    );
                if strict && (operation.operands.len() != 2 || parsed.is_none()) {
                    return Err("overlay-text source has a malformed Tf operator".into());
                }
                if let Some((name, size)) = parsed {
                    text.font_name = Some(name.to_vec());
                    fonts.insert(name.to_vec());
                    if strict {
                        let source_fonts = source_fonts
                            .as_ref()
                            .ok_or("overlay-text source fonts are unavailable")?;
                        let font = source_fonts.get(name).ok_or_else(|| {
                            format!(
                                "overlay-text source page font /{} is missing from Resources",
                                String::from_utf8_lossy(name)
                            )
                        })?;
                        text.font = Some(parsed_font(&mut parsed_fonts, source, name, font)?);
                        text.font_size = size;
                    } else if let Some(source_fonts) = &source_fonts {
                        if let Some(font) = source_fonts.get(name) {
                            if let Ok(font) = parsed_font(&mut parsed_fonts, source, name, font) {
                                text.font = Some(font);
                            }
                        }
                    }
                    text.font_size = size;
                }
                operations.push(operation);
            }
            "TL" if in_text => {
                let value = operation
                    .operands
                    .first()
                    .and_then(|value| object_to_f64(value).ok());
                if strict && (operation.operands.len() != 1 || value.is_none()) {
                    return Err("overlay-text source has a malformed TL operator".into());
                }
                text.leading = value;
                operations.push(operation);
            }
            "Tm" if in_text => {
                let matrix = TextMatrix::from_operation(&operation);
                if strict && matrix.is_none() {
                    return Err("overlay-text source has a malformed Tm operator".into());
                }
                text.set_matrix(matrix);
                operations.push(operation);
            }
            "Td" | "TD" if in_text => {
                let displacement = operation
                    .operands
                    .first()
                    .and_then(|x| object_to_f64(x).ok())
                    .zip(
                        operation
                            .operands
                            .get(1)
                            .and_then(|y| object_to_f64(y).ok()),
                    );
                if let Some((x, y)) = displacement {
                    if strict && operation.operands.len() != 2 {
                        return Err(format!(
                            "overlay-text source has a malformed {} operator",
                            operation.operator
                        )
                        .into());
                    }
                    if operation.operator == "TD" {
                        text.leading = Some(-y);
                    }
                    text.move_line(x, y);
                } else {
                    if strict {
                        return Err(format!(
                            "overlay-text source has a malformed {} operator",
                            operation.operator
                        )
                        .into());
                    }
                    text.set_matrix(None);
                }
                operations.push(operation);
            }
            "T*" if in_text => {
                if strict && !operation.operands.is_empty() {
                    return Err("overlay-text T* operator has operands".into());
                }
                text.next_line();
                operations.push(operation);
            }
            "Tj" | "TJ" if in_text => {
                if let Some((overlay, target_view)) = filter {
                    let repaired = if operation.operator == "Tj" && operation.operands.len() == 1 {
                        match &operation.operands[0] {
                            Object::String(bytes, format) => repair_filtered_show_string(
                                bytes,
                                *format,
                                &mut text,
                                graphics,
                                overlay,
                                target_view,
                            )?,
                            _ => None,
                        }
                    } else if operation.operator == "TJ" && operation.operands.len() == 1 {
                        match operation.operands[0].as_array() {
                            Ok(values) if values.len() == 1 => match values.first() {
                                Some(Object::String(bytes, format)) => repair_filtered_show_string(
                                    bytes,
                                    *format,
                                    &mut text,
                                    graphics,
                                    overlay,
                                    target_view,
                                )?,
                                _ => None,
                            },
                            _ => None,
                        }
                    } else {
                        None
                    };
                    if let Some(repaired) = repaired {
                        operations.extend(repaired);
                        continue;
                    }
                    let source_values = if operation.operator == "Tj" {
                        if operation.operands.len() != 1 {
                            return Err("overlay-text source has a malformed Tj operator".into());
                        }
                        match &operation.operands[0] {
                            Object::String(bytes, format) => {
                                vec![Object::String(bytes.clone(), *format)]
                            }
                            _ => {
                                return Err("overlay-text source has a non-string Tj operand".into())
                            }
                        }
                    } else {
                        if operation.operands.len() != 1 {
                            return Err("overlay-text source has a malformed TJ operator".into());
                        }
                        operation.operands[0]
                            .as_array()
                            .map_err(|_| "overlay-text source has a non-array TJ operand")?
                            .clone()
                    };
                    let filtered = filter_show_array(
                        &source_values,
                        &mut text,
                        graphics,
                        overlay,
                        target_view,
                    )?;
                    if !filtered.is_empty() {
                        operations.push(ContentOperation::new("TJ", vec![Object::Array(filtered)]));
                    }
                } else {
                    let repaired = if operation.operator == "Tj" && operation.operands.len() == 1 {
                        match &operation.operands[0] {
                            Object::String(bytes, format) => {
                                repair_show_string(bytes, *format, &mut text)?
                            }
                            _ => None,
                        }
                    } else if operation.operator == "TJ" && operation.operands.len() == 1 {
                        match operation.operands[0].as_array() {
                            Ok(values) if values.len() == 1 => match values.first() {
                                Some(Object::String(bytes, format)) => {
                                    repair_show_string(bytes, *format, &mut text)?
                                }
                                _ => None,
                            },
                            _ => None,
                        }
                    } else {
                        None
                    };
                    if let Some(repaired) = repaired {
                        operations.extend(repaired);
                    } else {
                        operations.push(operation);
                    }
                }
            }
            "'" if in_text => {
                text.next_line();
                if let Some((overlay, target_view)) = filter {
                    if operation.operands.len() != 1 {
                        return Err("overlay-text source has a malformed ' operator".into());
                    }
                    let Object::String(bytes, format) = &operation.operands[0] else {
                        return Err("overlay-text source has a non-string ' operand".into());
                    };
                    operations.push(ContentOperation::new("T*", Vec::new()));
                    let mut filtered = Vec::new();
                    filter_string(
                        bytes,
                        *format,
                        &mut text,
                        graphics,
                        overlay,
                        target_view,
                        &mut filtered,
                    )?;
                    if !filtered.is_empty() {
                        operations.push(ContentOperation::new("TJ", vec![Object::Array(filtered)]));
                    }
                } else {
                    operations.push(operation);
                }
            }
            "\"" if in_text => {
                text.next_line();
                if let Some((overlay, target_view)) = filter {
                    if operation.operands.len() != 3 {
                        return Err("overlay-text source has a malformed \" operator".into());
                    }
                    let word_spacing = object_to_f64(&operation.operands[0])?;
                    let char_spacing = object_to_f64(&operation.operands[1])?;
                    let Object::String(bytes, format) = &operation.operands[2] else {
                        return Err("overlay-text source has a non-string \" operand".into());
                    };
                    text.word_spacing = word_spacing;
                    text.char_spacing = char_spacing;
                    operations.push(ContentOperation::new(
                        "Tw",
                        vec![number_object(word_spacing)],
                    ));
                    operations.push(ContentOperation::new(
                        "Tc",
                        vec![number_object(char_spacing)],
                    ));
                    operations.push(ContentOperation::new("T*", Vec::new()));
                    let mut filtered = Vec::new();
                    filter_string(
                        bytes,
                        *format,
                        &mut text,
                        graphics,
                        overlay,
                        target_view,
                        &mut filtered,
                    )?;
                    if !filtered.is_empty() {
                        operations.push(ContentOperation::new("TJ", vec![Object::Array(filtered)]));
                    }
                } else {
                    operations.push(operation);
                }
            }
            "Tc" | "Tw" | "Tz" | "Ts" if in_text => {
                let value = operation
                    .operands
                    .first()
                    .and_then(|value| object_to_f64(value).ok());
                if strict && (operation.operands.len() != 1 || value.is_none()) {
                    return Err(format!(
                        "overlay-text source has a malformed {} operator",
                        operation.operator
                    )
                    .into());
                }
                if let Some(value) = value {
                    match operation.operator.as_str() {
                        "Tc" => text.char_spacing = value,
                        "Tw" => text.word_spacing = value,
                        "Tz" => text.horizontal_scale = value / 100.0,
                        "Ts" => text.rise = value,
                        _ => unreachable!(),
                    }
                }
                operations.push(operation);
            }
            "BT" | "ET" | "q" | "Q" | "cm" if strict => {
                return Err(format!(
                    "overlay-text source has invalid {} nesting",
                    operation.operator
                )
                .into());
            }
            "Tj" | "TJ" | "'" | "\"" | "Tf" | "TL" | "Tm" | "Td" | "TD" | "T*" | "Tc" | "Tw"
            | "Tz" | "Ts" | "Tr"
                if strict =>
            {
                return Err(format!(
                    "overlay-text source uses {} outside a text object",
                    operation.operator
                )
                .into());
            }
            _ => {}
        }
    }
    if in_text {
        if strict {
            return Err("overlay-text source has an unterminated text object".into());
        }
        // A malformed trailing BT must not leak its text state into target content.
        operations.push(ContentOperation::new("ET", Vec::new()));
    }
    if strict && !graphics_stack.is_empty() {
        return Err("overlay-text source has an unmatched q operator".into());
    }
    Ok((
        mark_ltr_text_objects(source, &source_fonts, &mut parsed_fonts, operations)?,
        fonts,
    ))
}

fn unique_font_name(existing: &Dictionary, source_name: &[u8]) -> Vec<u8> {
    let sanitized = source_name
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() {
                *byte
            } else {
                b'_'
            }
        })
        .collect::<Vec<_>>();
    for suffix in 0_u32.. {
        let mut candidate = b"EVBOcr_".to_vec();
        candidate.extend_from_slice(&sanitized);
        if suffix > 0 {
            candidate.extend_from_slice(format!("_{suffix}").as_bytes());
        }
        if existing.get(&candidate).is_err() {
            return candidate;
        }
    }
    unreachable!("u32 font-name namespace is exhausted")
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn append_text_layer(
    target: &mut Document,
    source: &Document,
    target_page_id: ObjectId,
    source_page_id: ObjectId,
    matrix: [f64; 6],
    filter_to_output_page: bool,
    normalize_greek_micro_sign: bool,
    marker: Option<(&[u8], &[u8])>,
    copied: &mut HashMap<ObjectId, ObjectId>,
) -> Result<Option<String>> {
    let filter = filter_to_output_page
        .then(|| resolve_page_view(target, target_page_id))
        .transpose()?
        .map(|target_view| (TextMatrix::from_values(matrix), target_view));
    let (mut operations, used_fonts) = match text_operations(source, source_page_id, filter) {
        Ok(result) => result,
        Err(error) if filter_to_output_page => return Ok(Some(error.to_string())),
        Err(error) => return Err(error),
    };
    if normalize_greek_micro_sign {
        normalize_greek_micro_sign_in_operations(&mut operations);
    }
    if operations
        .iter()
        .all(|operation| operation.operator != "BT")
    {
        return Ok(None);
    }
    let source_fonts = match page_fonts(source, source_page_id) {
        Ok(fonts) => fonts,
        Err(error) if filter_to_output_page => return Ok(Some(error.to_string())),
        Err(error) => return Err(error),
    };
    let mut resources = page_resources(target, target_page_id)?;
    let mut target_fonts = resources
        .get(b"Font")
        .ok()
        .and_then(|object| resolved_dictionary(target, object))
        .cloned()
        .unwrap_or_default();
    let mut renamed = HashMap::new();
    let mut staged_copied = copied.clone();
    for source_name in used_fonts {
        let Some(source_font) = source_fonts.get(&source_name) else {
            let reason = format!(
                "overlay-text source page font /{} is missing from Resources",
                String::from_utf8_lossy(&source_name)
            );
            if filter_to_output_page {
                return Ok(Some(reason));
            }
            return Err(reason.into());
        };
        let target_name = unique_font_name(&target_fonts, &source_name);
        let cloned = match clone_object_graph(
            source,
            target,
            source_font,
            &mut staged_copied,
            &[],
            &|_, _| Ok(()),
            0,
        ) {
            Ok(cloned) => cloned,
            Err(error) if filter_to_output_page => return Ok(Some(error.to_string())),
            Err(error) => return Err(error),
        };
        target_fonts.set(target_name.clone(), cloned);
        renamed.insert(source_name, target_name);
    }
    for operation in &mut operations {
        if operation.operator != "Tf" {
            continue;
        }
        if let Some(Object::Name(name)) = operation.operands.first_mut() {
            if let Some(target_name) = renamed.get(name) {
                *name = target_name.clone();
            }
        }
    }
    resources.set("Font", target_fonts);
    target
        .get_dictionary_mut(target_page_id)?
        .set("Resources", resources);

    let mut wrapped = vec![ContentOperation::new("q", Vec::new())];
    wrapped.push(ContentOperation::new(
        "cm",
        matrix.into_iter().map(number_object).collect::<Vec<_>>(),
    ));
    wrapped.extend(operations);
    wrapped.push(ContentOperation::new("Q", Vec::new()));
    target.add_to_page_content(
        target_page_id,
        Content {
            operations: wrapped,
        },
    )?;
    // The full-rewrite path compresses all eligible streams at the end of the
    // operation. A path-backed incremental revision must compress only the
    // stream just added here. Calling `Document::compress` would touch qpdf's
    // structural stream placeholders and could write an empty replacement for
    // an unavailable base stream.
    let content_id = target
        .get_page_contents(target_page_id)
        .last()
        .copied()
        .ok_or("overlay-text failed to locate its new content stream")?;
    let stream = target.get_object_mut(content_id)?.as_stream_mut()?;
    if stream.dict.get(b"Filter").is_ok() {
        return Err("overlay-text located an already filtered content stream".into());
    }
    if let Some((begin, end)) = marker {
        stream.set_content([begin, stream.content.as_slice(), end].concat());
    }
    stream.compress()?;
    *copied = staged_copied;
    Ok(None)
}

/// Carry the source annotation graph with the same geometry as its text and
/// pixels. A page-local copy keeps split outputs independent; seeding /P avoids
/// cloning the source page tree through notes, popups and reply links.
pub(crate) fn append_source_annotations(
    target: &mut Document,
    source: &Document,
    target_page_id: ObjectId,
    source_page_id: ObjectId,
    instruction: &TextLayerInstruction,
    pages: &[OverlayPage<'_>],
) -> Result<()> {
    let Ok(annots) = source.get_dictionary(source_page_id)?.get(b"Annots") else {
        return Ok(());
    };
    let annotations = source.dereference(annots)?.1.as_array()?;
    let view = resolve_page_view(target, target_page_id)?;
    let output_view = instruction.filter_to_output_page.then_some(view);
    let filter = match (instruction.source_region, output_view) {
        (Some(region), Some(_)) => Some((region.matrix, validate_crop_rect(region.rect)?)),
        (_, view) => view.map(|view| (instruction.matrix, view)),
    };
    let rotation = resolve_page_rotation(target, target_page_id)?;
    let copy = NoteCopy {
        source,
        source_page_id,
        matrix: instruction.matrix,
        view,
        rotation,
    };
    let transform = |target: &mut Document, annotation: &mut Dictionary| {
        place_note_copy(target, annotation, None, &copy)?;
        clip_text_markup_to_view(target, annotation, output_view);
        annotation.set("P", target_page_id);
        Ok(())
    };
    let mut copied = HashMap::from([(source_page_id, target_page_id)]);
    let mut output = match target.get_dictionary(target_page_id)?.get(b"Annots") {
        Ok(annots) => target.dereference(annots)?.1.as_array()?.clone(),
        Err(_) => Vec::new(),
    };
    for annotation in annotations {
        let Some(mut owner) = resolved_dictionary(source, annotation) else {
            continue;
        };
        let subtype = resolved_name(source, owner.get(b"Subtype").unwrap_or(&Object::Null));
        // The terminal owner places the whole reply and popup thread.
        if let Some((matrix, view)) = filter {
            let mut owners = HashSet::from([owner as *const Dictionary]);
            while let Some(next) = owner
                .get(b"IRT")
                .or_else(|_| owner.get(b"Parent"))
                .ok()
                .and_then(|object| resolved_dictionary(source, object))
            {
                if owners.len() >= MAX_OBJECT_GRAPH_DEPTH || !owners.insert(next as *const _) {
                    return Err("overlay-text annotation ownership is cyclic or too deep".into());
                }
                owner = next;
            }
            let legacy_marker = legacy_marker_on_page(source, owner, source, source_page_id)?;
            if annotation_bounds(source, owner).is_some_and(|rect| {
                let rect = TextMatrix::from_values(matrix).bounds(rect);
                if matches!(subtype, Some(b"Text" | b"Popup")) || legacy_marker {
                    let (x, y) = ((rect.x1 + rect.x2) / 2.0, (rect.y1 + rect.y2) / 2.0);
                    !(x >= view.x1 && x < view.x2 && y >= view.y1 && y < view.y2)
                } else {
                    !annotation_meets_view(source, owner, matrix, rect, view)
                }
            }) {
                continue;
            }
        }
        output.push(clone_object_graph(
            source,
            target,
            annotation,
            &mut copied,
            pages,
            &transform,
            0,
        )?);
        if let Some(Object::Dictionary(annotation)) = output.last_mut() {
            transform(target, annotation)?;
        }
    }
    target
        .get_dictionary_mut(target_page_id)?
        .set("Annots", output);
    Ok(())
}
