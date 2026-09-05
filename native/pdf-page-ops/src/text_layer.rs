use super::*;
use evb_native_support::output::AtomicOutput;
use lopdf::{
    content::{Content, Operation as ContentOperation},
    DecompressError, Error as LopdfError,
};
use std::{
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_TEXT_CONTENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_OBJECT_GRAPH_DEPTH: usize = 128;
const MAX_SOURCE_PAGE_BATCH_PAGES: usize = 64;
const QPDF_SOURCE_EXTRACTION_TIMEOUT: Duration = Duration::from_secs(110);

pub(crate) fn read_text_layer_file(path: &Path) -> Result<TextLayerFile> {
    let instructions: TextLayerFile = read_json_sidecar(path, "text-layer instructions")?;
    if instructions.pages.is_empty() {
        return Err("overlay-text requires at least one page instruction".into());
    }
    let mut output_pages = HashSet::new();
    for instruction in &instructions.pages {
        if !instruction.matrix.iter().all(|value| value.is_finite()) {
            return Err("overlay-text matrix values must be finite".into());
        }
        let determinant = instruction.matrix[0] * instruction.matrix[3]
            - instruction.matrix[1] * instruction.matrix[2];
        if determinant.abs() <= f64::EPSILON {
            return Err("overlay-text matrix must be invertible".into());
        }
        if !output_pages.insert(instruction.output_page_index) {
            return Err("overlay-text outputPageIndex values must be unique".into());
        }
    }
    Ok(instructions)
}

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

fn page_resources(document: &Document, page_id: ObjectId) -> Result<Dictionary> {
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

#[derive(Clone)]
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

#[derive(Clone, Copy)]
struct TextMatrix {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl TextMatrix {
    const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    fn from_values(values: [f64; 6]) -> Self {
        Self {
            a: values[0],
            b: values[1],
            c: values[2],
            d: values[3],
            e: values[4],
            f: values[5],
        }
    }

    fn from_operation(operation: &ContentOperation) -> Option<Self> {
        let values = operation
            .operands
            .iter()
            .map(|operand| object_to_f64(operand).ok())
            .collect::<Option<Vec<_>>>()?;
        let values: [f64; 6] = values.try_into().ok()?;
        Some(Self::from_values(values))
    }

    fn concat(self, rhs: Self) -> Self {
        Self {
            a: self.a * rhs.a + self.c * rhs.b,
            b: self.b * rhs.a + self.d * rhs.b,
            c: self.a * rhs.c + self.c * rhs.d,
            d: self.b * rhs.c + self.d * rhs.d,
            e: self.a * rhs.e + self.c * rhs.f + self.e,
            f: self.b * rhs.e + self.d * rhs.f + self.f,
        }
    }

    fn translation(x: f64, y: f64) -> Self {
        Self {
            e: x,
            f: y,
            ..Self::IDENTITY
        }
    }

    fn transform(self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }
}

#[derive(Clone)]
struct TextFilterState {
    line_matrix: Option<TextMatrix>,
    text_matrix: Option<TextMatrix>,
    leading: Option<f64>,
    font: Option<(Vec<u8>, FontMetrics)>,
    font_size: f64,
    char_spacing: f64,
    word_spacing: f64,
    horizontal_scale: f64,
    rise: f64,
}

impl TextFilterState {
    fn new() -> Self {
        Self {
            line_matrix: Some(TextMatrix::IDENTITY),
            text_matrix: Some(TextMatrix::IDENTITY),
            leading: Some(0.0),
            font: None,
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
}

fn target_point_is_visible(
    text: &TextFilterState,
    graphics: TextMatrix,
    overlay: TextMatrix,
    target_view: PdfRect,
) -> Result<bool> {
    let text_matrix = text
        .text_matrix
        .ok_or("overlay-text show operator has no valid text matrix")?;
    let (text_x, text_y) = text_matrix.transform(0.0, text.rise);
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

fn filter_string(
    bytes: &[u8],
    format: lopdf::StringFormat,
    text: &mut TextFilterState,
    graphics: TextMatrix,
    overlay: TextMatrix,
    target_view: PdfRect,
    output: &mut Vec<Object>,
) -> Result<()> {
    let metrics = text
        .font
        .as_ref()
        .map(|(_, metrics)| metrics.clone())
        .ok_or("overlay-text show operator has no selected font")?;
    for (code, glyph) in metrics.glyphs(bytes)? {
        let visible = target_point_is_visible(text, graphics, overlay, target_view)?;
        let width = metrics.width(code)?;
        let advance = ((width / 1_000.0) * text.font_size
            + text.char_spacing
            + if metrics.word_spacing_applies(code) {
                text.word_spacing
            } else {
                0.0
            })
            * text.horizontal_scale;
        if visible {
            push_string(output, glyph, format);
        } else if advance.abs() > f64::EPSILON {
            let scale = text.font_size * text.horizontal_scale;
            if !scale.is_finite() || scale.abs() <= f64::EPSILON {
                return Err(
                    "overlay-text cannot preserve a hidden glyph advance at zero text scale".into(),
                );
            }
            push_adjustment(output, -advance * 1_000.0 / scale);
        }
        text.advance(advance)?;
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

fn clone_object_graph(
    source: &Document,
    target: &mut Document,
    object: &Object,
    copied: &mut HashMap<ObjectId, ObjectId>,
    depth: usize,
) -> Result<Object> {
    if depth > MAX_OBJECT_GRAPH_DEPTH {
        return Err("overlay-text font object graph exceeded the dereference limit".into());
    }
    match object {
        Object::Reference(source_id) => {
            if let Some(target_id) = copied.get(source_id) {
                return Ok(Object::Reference(*target_id));
            }
            let target_id = target.new_object_id();
            copied.insert(*source_id, target_id);
            let source_object = source.objects.get(source_id).ok_or_else(|| {
                format!(
                    "overlay-text source font object {}R{} is missing",
                    source_id.0, source_id.1
                )
            })?;
            let cloned = clone_object_graph(source, target, source_object, copied, depth + 1)?;
            target.objects.insert(target_id, cloned);
            Ok(Object::Reference(target_id))
        }
        Object::Array(items) => Ok(Object::Array(
            items
                .iter()
                .map(|item| clone_object_graph(source, target, item, copied, depth + 1))
                .collect::<Result<Vec<_>>>()?,
        )),
        Object::Dictionary(dictionary) => {
            let mut cloned = Dictionary::new();
            for (key, value) in dictionary {
                cloned.set(
                    key.clone(),
                    clone_object_graph(source, target, value, copied, depth + 1)?,
                );
            }
            Ok(Object::Dictionary(cloned))
        }
        Object::Stream(stream) => {
            let mut dictionary = Dictionary::new();
            for (key, value) in &stream.dict {
                dictionary.set(
                    key.clone(),
                    clone_object_graph(source, target, value, copied, depth + 1)?,
                );
            }
            Ok(Object::Stream(Stream {
                dict: dictionary,
                content: stream.content.clone(),
                allows_compression: stream.allows_compression,
                start_position: None,
            }))
        }
        value => Ok(value.clone()),
    }
}

fn text_operations(
    source: &Document,
    page_id: ObjectId,
    filter: Option<(TextMatrix, PdfRect)>,
) -> Result<(Vec<ContentOperation>, HashSet<Vec<u8>>)> {
    let bytes = source
        .get_page_content_with_limit(page_id, MAX_TEXT_CONTENT_BYTES)
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
    let source_fonts = strict.then(|| page_fonts(source, page_id)).transpose()?;
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
                    fonts.insert(name.to_vec());
                    if let Some(source_fonts) = &source_fonts {
                        let font = source_fonts.get(name).ok_or_else(|| {
                            format!(
                                "overlay-text source page font /{} is missing from Resources",
                                String::from_utf8_lossy(name)
                            )
                        })?;
                        text.font = Some((name.to_vec(), parse_font_metrics(source, font)?));
                        text.font_size = size;
                    }
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
                    operations.push(operation);
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
    Ok((operations, fonts))
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

fn append_text_layer(
    target: &mut Document,
    source: &Document,
    target_page_id: ObjectId,
    source_page_id: ObjectId,
    matrix: [f64; 6],
    filter_to_output_page: bool,
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
        let cloned = match clone_object_graph(source, target, source_font, &mut staged_copied, 0) {
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
    stream.compress()?;
    *copied = staged_copied;
    Ok(None)
}

pub(crate) fn overlay_text_layers(
    target: &mut Document,
    source: &Document,
    instructions: &TextLayerFile,
) -> Result<()> {
    let source_resolver = PageTreeResolver::new(source)?;
    let target_resolver = PageTreeResolver::new(target)?;
    // Producer OCR commonly shares one font, descriptor, embedded program and
    // ToUnicode CMap across the whole book. Keep one source-to-target object
    // map for the overlay operation so each source object is cloned once, then
    // referenced from every output page that uses it.
    let mut copied = HashMap::new();
    for instruction in &instructions.pages {
        let source_page_number =
            overlay_page_number(instruction.source_page_index, "sourcePageIndex")?;
        let output_page_number =
            overlay_page_number(instruction.output_page_index, "outputPageIndex")?;
        let source_page_id = source_resolver.page_id(source, source_page_number)?;
        let target_page_id = target_resolver.page_id(target, output_page_number)?;
        let skipped = append_text_layer(
            target,
            source,
            target_page_id,
            source_page_id,
            instruction.matrix,
            instruction.filter_to_output_page,
            &mut copied,
        )?;
        if let Some(reason) = skipped {
            eprintln!(
                "{}",
                serde_json::json!({
                    "level": "warning",
                    "event": "scan_cleanup_text_overlay_skipped",
                    "sourcePageIndex": instruction.source_page_index,
                    "outputPageIndex": instruction.output_page_index,
                    "reason": reason,
                })
            );
        }
    }
    target.prune_objects();
    // `add_to_page_content` stores the decoded OCR operators in a new stream.
    // A full-book OCR layer is large enough that leaving those streams raw can
    // add tens of megabytes even though the source streams were compressed.
    // Lopdf only compresses eligible, currently unfiltered streams here, so
    // existing image/JBIG2/JPX payloads remain byte-for-byte untouched.
    target.compress();
    Ok(())
}

/// Materialize only the target page dictionaries touched by an overlay. The
/// source page content remains in the base revision, while new OCR streams and
/// copied font objects go into the incremental revision.
fn prepare_incremental_overlay_page(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
) -> Result<()> {
    let base = &incremental.previous_document;
    let parent = base.get_dictionary(page_id)?.get(b"Parent").ok().cloned();
    let mut page = materialized_page_dictionary(base, page_id)?;
    if let Some(parent) = parent {
        page.set("Parent", parent);
    }
    if let Some(resources) = page.get(b"Resources").ok().cloned() {
        let (_, resources) = base.dereference(&resources)?;
        let mut resources = resources.as_dict()?.clone();
        if let Some(fonts) = resources.get(b"Font").ok().cloned() {
            if let Ok((_, fonts)) = base.dereference(&fonts) {
                if let Ok(fonts) = fonts.as_dict() {
                    resources.set("Font", Object::Dictionary(fonts.clone()));
                }
            }
        }
        page.set("Resources", Object::Dictionary(resources));
    }

    // Normalize nested /Contents arrays while the base structure is available.
    // This keeps `Document::add_page_contents` from treating an indirect array
    // as if it were a stream reference in the new revision.
    if page.get(b"Contents").is_ok() {
        let content_ids = content_stream_ids_from_base(base, &mut incremental.new_document, &page)?;
        page.set(
            "Contents",
            Object::Array(content_ids.into_iter().map(Object::Reference).collect()),
        );
    }
    incremental
        .new_document
        .set_object(page_id, Object::Dictionary(page));
    Ok(())
}

pub(crate) fn overlay_text_layers_incremental(
    incremental: &mut IncrementalDocument,
    source: &Document,
    instructions: &TextLayerFile,
) -> Result<()> {
    let source_resolver = PageTreeResolver::new(source)?;
    let target_resolver = PageTreeResolver::new(&incremental.previous_document)?;
    let mut copied = HashMap::new();
    let mut prepared_pages = HashSet::new();
    for instruction in &instructions.pages {
        let source_page_number =
            overlay_page_number(instruction.source_page_index, "sourcePageIndex")?;
        let output_page_number =
            overlay_page_number(instruction.output_page_index, "outputPageIndex")?;
        let source_page_id = source_resolver.page_id(source, source_page_number)?;
        let target_page_id =
            target_resolver.page_id(&incremental.previous_document, output_page_number)?;
        // Materializing a page copies its base /Contents into the new
        // revision. Do it once per resolved page, otherwise a later
        // instruction targeting the same page would replace the streams
        // appended by earlier instructions. The object-map check also covers
        // another source batch applied to the same IncrementalDocument.
        if prepared_pages.insert(target_page_id)
            && !incremental.new_document.has_object(target_page_id)
        {
            prepare_incremental_overlay_page(incremental, target_page_id)?;
        }
        let skipped = append_text_layer(
            &mut incremental.new_document,
            source,
            target_page_id,
            source_page_id,
            instruction.matrix,
            instruction.filter_to_output_page,
            &mut copied,
        )?;
        if let Some(reason) = skipped {
            eprintln!(
                "{}",
                serde_json::json!({
                    "level": "warning",
                    "event": "scan_cleanup_text_overlay_skipped",
                    "sourcePageIndex": instruction.source_page_index,
                    "outputPageIndex": instruction.output_page_index,
                    "reason": reason,
                })
            );
        }
    }
    Ok(())
}

struct OverlaySourceTempDir {
    path: PathBuf,
}

impl OverlaySourceTempDir {
    fn create() -> Result<Self> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let path =
            std::env::temp_dir().join(format!("evb-overlay-text-{}-{nonce}", std::process::id()));
        fs::create_dir(&path)
            .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
        #[cfg(target_family = "unix")]
        if let Err(error) =
            fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
        {
            let _ = fs::remove_dir_all(&path);
            return Err(domain_error(NativeErrorCode::Io, error.to_string()));
        }
        Ok(Self { path })
    }

    fn subset_path(&self, batch_id: usize) -> PathBuf {
        self.path.join(format!("batch-{batch_id}.pdf"))
    }
}

impl Drop for OverlaySourceTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

enum OverlaySourceBatchFailure {
    TooLarge,
    Failed(Box<dyn Error>),
}

fn overlay_page_number(index: usize, label: &str) -> Result<u32> {
    let number = index
        .checked_add(1)
        .ok_or_else(|| format!("overlay-text {label} is too large"))?;
    u32::try_from(number).map_err(|_| format!("overlay-text {label} is too large").into())
}

fn is_too_large_error(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<NativeError>()
        .is_some_and(|error| error.code == NativeErrorCode::TooLarge)
}

fn referenced_source_pages(instructions: &TextLayerFile) -> Result<Vec<usize>> {
    let mut pages = instructions
        .pages
        .iter()
        .map(|instruction| instruction.source_page_index)
        .collect::<Vec<_>>();
    pages.sort_unstable();
    pages.dedup();
    for page in &pages {
        overlay_page_number(*page, "sourcePageIndex")?;
    }
    Ok(pages)
}

fn validate_overlay_page_numbers(instructions: &TextLayerFile) -> Result<()> {
    for instruction in &instructions.pages {
        overlay_page_number(instruction.source_page_index, "sourcePageIndex")?;
        overlay_page_number(instruction.output_page_index, "outputPageIndex")?;
    }
    Ok(())
}

fn source_page_ranges(pages: &[usize]) -> Result<Vec<String>> {
    let Some(&first_page) = pages.first() else {
        return Err("overlay-text source batch cannot be empty".into());
    };
    let mut start = overlay_page_number(first_page, "sourcePageIndex")?;
    let mut end = start;
    let mut ranges = Vec::new();
    for page in pages.iter().skip(1) {
        let number = overlay_page_number(*page, "sourcePageIndex")?;
        if end.checked_add(1).is_some_and(|next| number == next) {
            end = number;
            continue;
        }
        ranges.push(if start == end {
            start.to_string()
        } else {
            format!("{start}-{end}")
        });
        start = number;
        end = number;
    }
    ranges.push(if start == end {
        start.to_string()
    } else {
        format!("{start}-{end}")
    });
    Ok(ranges)
}

fn extract_overlay_source_batch(
    source_path: &Path,
    qpdf_path: &Path,
    pages: &[usize],
    temp_dir: &OverlaySourceTempDir,
    batch_id: usize,
) -> std::result::Result<PathBuf, OverlaySourceBatchFailure> {
    let ranges = source_page_ranges(pages).map_err(OverlaySourceBatchFailure::Failed)?;
    let subset_path = temp_dir.subset_path(batch_id);
    let mut child = Command::new(qpdf_path)
        .args([
            "--suppress-recovery",
            "--warning-exit-0",
            "--empty",
            "--pages",
        ])
        .arg(source_path)
        .arg(ranges.join(","))
        .arg("--")
        .arg(&subset_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            OverlaySourceBatchFailure::Failed(domain_error(NativeErrorCode::Io, error.to_string()))
        })?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&subset_path);
                return Err(OverlaySourceBatchFailure::Failed(domain_error(
                    NativeErrorCode::Io,
                    error.to_string(),
                )));
            }
        }
        if started.elapsed() > QPDF_SOURCE_EXTRACTION_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&subset_path);
            return Err(OverlaySourceBatchFailure::TooLarge);
        }
        if fs::metadata(&subset_path)
            .map(|metadata| metadata.len() > MAX_ENCODED_PDF_BYTES as u64)
            .unwrap_or(false)
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&subset_path);
            return Err(OverlaySourceBatchFailure::TooLarge);
        }
        thread::sleep(Duration::from_millis(25));
    };
    if !status.success() {
        let _ = fs::remove_file(&subset_path);
        return Err(OverlaySourceBatchFailure::Failed(domain_error(
            NativeErrorCode::CorruptXref,
            format!("qpdf source-page extraction failed with status {status}"),
        )));
    }
    let encoded_len = fs::metadata(&subset_path)
        .map_err(|error| {
            OverlaySourceBatchFailure::Failed(domain_error(NativeErrorCode::Io, error.to_string()))
        })?
        .len();
    if encoded_len > MAX_ENCODED_PDF_BYTES as u64 {
        let _ = fs::remove_file(&subset_path);
        return Err(OverlaySourceBatchFailure::TooLarge);
    }
    if encoded_len == 0 {
        let _ = fs::remove_file(&subset_path);
        return Err(OverlaySourceBatchFailure::Failed(domain_error(
            NativeErrorCode::CorruptXref,
            "qpdf source-page extraction produced an empty PDF",
        )));
    }
    Ok(subset_path)
}

fn rebase_overlay_source_instructions(
    instructions: &TextLayerFile,
    pages: &[usize],
) -> Result<TextLayerFile> {
    let local_pages = pages
        .iter()
        .enumerate()
        .map(|(local_index, page)| (*page, local_index))
        .collect::<HashMap<_, _>>();
    let batch_pages = instructions
        .pages
        .iter()
        .filter_map(|instruction| {
            local_pages
                .get(&instruction.source_page_index)
                .map(|local_index| TextLayerInstruction {
                    source_page_index: *local_index,
                    output_page_index: instruction.output_page_index,
                    matrix: instruction.matrix,
                    filter_to_output_page: instruction.filter_to_output_page,
                })
        })
        .collect::<Vec<_>>();
    if batch_pages.is_empty() {
        return Err("overlay-text source batch has no matching instructions".into());
    }
    Ok(TextLayerFile { pages: batch_pages })
}

fn try_write_overlay_source_batch(
    output_path: &Path,
    source_path: &Path,
    qpdf_path: &Path,
    pages: &[usize],
    instructions: &TextLayerFile,
    temp_dir: &OverlaySourceTempDir,
    batch_id: usize,
) -> std::result::Result<(), OverlaySourceBatchFailure> {
    let subset_path =
        extract_overlay_source_batch(source_path, qpdf_path, pages, temp_dir, batch_id)?;
    let result = (|| {
        let source = match load_pdf_path(&subset_path) {
            Ok(source) => source,
            Err(error) => {
                let error = classify_pdf_load_error(
                    error,
                    "Failed to parse extracted overlay-text source PDF structure",
                );
                return Err(if is_too_large_error(error.as_ref()) {
                    OverlaySourceBatchFailure::TooLarge
                } else {
                    OverlaySourceBatchFailure::Failed(error)
                });
            }
        };
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )
        .map_err(OverlaySourceBatchFailure::Failed)?;
        let batch_instructions = rebase_overlay_source_instructions(instructions, pages)
            .map_err(OverlaySourceBatchFailure::Failed)?;
        let mut incremental =
            load_incremental_pdf_path(output_path, Some(qpdf_path)).map_err(|error| {
                OverlaySourceBatchFailure::Failed(classify_pdf_load_error(
                    error,
                    "Failed to parse PDF structure",
                ))
            })?;
        assert_plaintext_base(
            incremental.get_prev_documents(),
            "Encrypted PDFs are not supported by native page ops",
        )
        .map_err(OverlaySourceBatchFailure::Failed)?;
        if let Err(error) =
            overlay_text_layers_incremental(&mut incremental, &source, &batch_instructions)
        {
            return Err(if is_too_large_error(error.as_ref()) {
                OverlaySourceBatchFailure::TooLarge
            } else {
                OverlaySourceBatchFailure::Failed(error)
            });
        }
        incremental.new_document.version = incremental.get_prev_documents().version.clone();
        let revision_bytes = build_incremental_revision(&mut incremental)
            .map_err(OverlaySourceBatchFailure::Failed)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
        write_incremental_revision(
            output_path,
            &incremental,
            &revision_bytes,
            &expected_object_ids,
        )
        .map_err(OverlaySourceBatchFailure::Failed)
    })();
    let _ = fs::remove_file(&subset_path);
    result
}

fn write_overlay_source_batch_with_split(
    output_path: &Path,
    source_path: &Path,
    qpdf_path: &Path,
    pages: &[usize],
    instructions: &TextLayerFile,
    temp_dir: &OverlaySourceTempDir,
    next_batch_id: &mut usize,
) -> Result<()> {
    let batch_id = *next_batch_id;
    *next_batch_id = batch_id
        .checked_add(1)
        .ok_or("overlay-text source batch count overflow")?;
    match try_write_overlay_source_batch(
        output_path,
        source_path,
        qpdf_path,
        pages,
        instructions,
        temp_dir,
        batch_id,
    ) {
        Ok(()) => Ok(()),
        Err(OverlaySourceBatchFailure::Failed(error)) => Err(error),
        Err(OverlaySourceBatchFailure::TooLarge) if pages.len() > 1 => {
            let midpoint = pages.len() / 2;
            write_overlay_source_batch_with_split(
                output_path,
                source_path,
                qpdf_path,
                &pages[..midpoint],
                instructions,
                temp_dir,
                next_batch_id,
            )?;
            write_overlay_source_batch_with_split(
                output_path,
                source_path,
                qpdf_path,
                &pages[midpoint..],
                instructions,
                temp_dir,
                next_batch_id,
            )
        }
        Err(OverlaySourceBatchFailure::TooLarge) => {
            let page = pages
                .first()
                .copied()
                .ok_or("overlay-text source batch cannot be empty")?;
            Err(domain_error(
                NativeErrorCode::TooLarge,
                format!(
                    "overlay-text source page {page} exceeds the bounded decoder resource limit"
                ),
            ))
        }
    }
}

pub(crate) fn write_overlay_text_layers_path(
    input_path: &Path,
    source_path: &Path,
    output_path: &Path,
    instructions: &TextLayerFile,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    validate_overlay_page_numbers(instructions)?;
    // Preserve the established rewrite semantics only when both documents fit
    // the byte-input compatibility budget. A large source is just as unsafe to
    // eagerly load as a large target, even when the target itself is small.
    let encoded_len = fs::metadata(input_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    let source_encoded_len = fs::metadata(source_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    if encoded_len <= MAX_ENCODED_PDF_BYTES as u64
        && source_encoded_len <= MAX_ENCODED_PDF_BYTES as u64
    {
        let mut target = load_pdf_path(input_path)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        assert_plaintext_base(
            &target,
            "Encrypted PDFs are not supported by native page ops",
        )?;
        let source = load_pdf_path(source_path).map_err(|error| {
            classify_pdf_load_error(error, "Failed to parse source PDF structure")
        })?;
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )?;
        overlay_text_layers(&mut target, &source, instructions)?;
        let mut output = AtomicOutput::create(output_path)?;
        target.save_to(output.file_mut()?)?;
        output.publish_if_unchanged()?;
        return Ok(());
    }

    let qpdf_path = qpdf_path.ok_or_else(|| {
        domain_error(
            NativeErrorCode::TooLarge,
            "qpdf is required for overlay-text path operations above the byte-input compatibility budget",
        )
    })?;

    // A compatibility-sized source can still be held in memory while the
    // target uses the qpdf-backed incremental writer. This keeps the ordinary
    // source semantics, while avoiding a target-wide rewrite.
    if source_encoded_len <= MAX_ENCODED_PDF_BYTES as u64 {
        let mut incremental = load_incremental_pdf_path(input_path, Some(qpdf_path))
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        assert_plaintext_base(
            incremental.get_prev_documents(),
            "Encrypted PDFs are not supported by native page ops",
        )?;
        let source = load_pdf_path(source_path).map_err(|error| {
            classify_pdf_load_error(error, "Failed to parse source PDF structure")
        })?;
        assert_plaintext_base(
            &source,
            "Encrypted source PDFs are not supported by native page ops",
        )?;
        overlay_text_layers_incremental(&mut incremental, &source, instructions)?;
        incremental.new_document.version = incremental.get_prev_documents().version.clone();
        let revision_bytes = build_incremental_revision(&mut incremental)?;
        let expected_object_ids = collect_incremental_append_object_ids(&incremental);
        return with_staged_incremental_output(input_path, output_path, |staged_output_path| {
            write_incremental_revision(
                staged_output_path,
                &incremental,
                &revision_bytes,
                &expected_object_ids,
            )
        });
    }

    // Probe both path-backed documents through qpdf before extracting any
    // source page. qpdf reads structure without retaining stream bodies, so a
    // multi-gigabyte source never crosses the eager decoder boundary here.
    let target_probe = load_incremental_pdf_path(input_path, Some(qpdf_path))
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        target_probe.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let source_probe = load_incremental_pdf_path(source_path, Some(qpdf_path))
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse source PDF structure"))?;
    assert_plaintext_base(
        source_probe.get_prev_documents(),
        "Encrypted source PDFs are not supported by native page ops",
    )?;

    let source_pages = referenced_source_pages(instructions)?;
    let temp_dir = OverlaySourceTempDir::create()?;
    with_staged_incremental_output(input_path, output_path, |staged_output_path| {
        let mut next_batch_id = 0;
        for pages in source_pages.chunks(MAX_SOURCE_PAGE_BATCH_PAGES) {
            write_overlay_source_batch_with_split(
                staged_output_path,
                source_path,
                qpdf_path,
                pages,
                instructions,
                &temp_dir,
                &mut next_batch_id,
            )?;
        }
        Ok(())
    })
}
