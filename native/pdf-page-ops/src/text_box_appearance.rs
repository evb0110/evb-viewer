//! Exact text-box source interpretation, fitting and appearance serialization.
//! Save and immutable render projections use the same builder and font subsets.

use super::*;
use crate::annotation_parse::{
    read_annotation_date, read_annotation_rect, read_optional, read_optional_annotation_author,
    read_optional_annotation_text,
};
use crate::free_text_frame::{entry, free_text_frame, FreeTextFrame};
use crate::text_box_font::{
    self, baseline_from_top, layout, Geometry, Line, FONTS, LINE_HEIGHT, PADDING_X, PADDING_Y,
};
use lopdf::dictionary;
use serde::Serialize;
use skrifa::instance::{LocationRef, Size};
use skrifa::{FontRef, MetadataProvider};

const MAX_TEXT_BOXES: usize = 256;
const MAX_TEXT_BOX_TEXT_BYTES: usize = 64 * 1024;

pub(crate) const MAX_TEXT_BOX_APPEARANCE_TEXT_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_TEXT_BOX_APPEARANCE_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_TEXT_BOX_APPEARANCE_REQUEST_BYTES: usize = 8 * 1024 * 1024;

/// A current writer-parse projection, not original-appearance provenance.
/// Raw admitted RD is retained because its effective fallback depends on size.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextBoxSourceDescriptor {
    pub(crate) version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) settlement_rect: Option<[f64; 4]>,
    #[serde(rename = "rawRD", default, skip_serializing_if = "Option::is_none")]
    pub(crate) raw_rd: Option<[f64; 4]>,
    pub(crate) border_width: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) border_color: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) background: Option<Vec<f64>>,
    pub(crate) stale_fill: bool,
}

impl TextBoxSourceDescriptor {
    pub(crate) fn read(source: &impl PdfObjectSource, dict: &Dictionary, rect: PdfRect) -> Self {
        let frame = free_text_frame(source, dict, rect);
        let stored = text_box_font::editor_geometry(dict)
            .and_then(|g| g.as_dict().ok()?.get(b"Rect").ok())
            .or_else(|| dict.get(b"Rect").ok());
        let settlement_rect = stored
            .and_then(|r| parse_rect(r).ok())
            .map(|r| [r.x1, r.y1, r.x2, r.y2]);
        let raw_rd = dict
            .get(b"RD")
            .ok()
            .and_then(|rd| annotation_numbers(source, rd))
            .filter(|rd| rd.len() == 4 && rd.iter().all(|n| n.is_finite() && *n >= 0.0))
            .and_then(|rd| rd.try_into().ok());
        Self {
            version: 1,
            settlement_rect,
            raw_rd,
            border_width: frame.width,
            border_color: frame.border,
            background: frame.background,
            stale_fill: frame.stale_fill,
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        let color = |v: &Option<Vec<f64>>| {
            v.as_ref().is_none_or(|v| {
                matches!(v.len(), 1 | 3 | 4) && v.iter().all(|n| (0.0..=1.0).contains(n))
            })
        };
        if self.version != 1
            || !self.border_width.is_finite()
            || self.border_width < 0.0
            || self.border_width > f64::from(f32::MAX)
            || !color(&self.border_color)
            || !color(&self.background)
            || self.raw_rd.is_some_and(|v| {
                v.iter()
                    .any(|n| !n.is_finite() || *n < 0.0 || *n > f64::from(f32::MAX))
            })
            || self.settlement_rect.is_some_and(|r| {
                r.iter()
                    .any(|n| !n.is_finite() || n.abs() > f64::from(f32::MAX))
                    || r[2] <= r[0]
                    || r[3] <= r[1]
            })
            || (self.border_width > 0.0) != self.border_color.is_some()
        {
            return Err("Invalid text box source descriptor".into());
        }
        Ok(())
    }

    pub(crate) fn settled_bounds(&self, editor: &TextBoxMutation) -> Result<PdfRect> {
        let [x1, y1, x2, y2] = editor.rect;
        let source = PdfRect { x1, y1, x2, y2 };
        let written = self
            .settlement_rect
            .map(|[x1, y1, x2, y2]| PdfRect { x1, y1, x2, y2 });
        text_box_font::geometry(settled_rect(written, source), i64::from(editor.rotation), 0)
            .map(|g| g.bounds)
    }

    pub(crate) fn frame(&self, rect: PdfRect) -> FreeTextFrame {
        let source = Document::new();
        let mut dict = dictionary! {"Rect" => rect_object(rect), "Border" => vec![0.into(), 0.into(), number_object(self.border_width)]};
        if let Some(rd) = self.raw_rd {
            dict.set("RD", rd.map(number_object).to_vec());
        }
        if let Some(color) = &self.border_color {
            dict.set(
                "DA",
                Object::string_literal(crate::free_text_frame::colour(color, false)),
            );
        }
        if let Some(color) = &self.background {
            dict.set(
                "C",
                color.iter().map(|n| number_object(*n)).collect::<Vec<_>>(),
            );
        }
        let mut frame = free_text_frame(&source, &dict, rect);
        frame.stale_fill = self.stale_fill;
        frame
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextBoxAppearanceRequest {
    pub(crate) page: TextBoxAppearancePage,
    #[serde(deserialize_with = "deserialize_appearance_boxes")]
    pub(crate) text_boxes: Vec<TextBoxAppearanceInput>,
}

fn deserialize_appearance_boxes<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Vec<TextBoxAppearanceInput>, D::Error> {
    deserialize_bounded_vec::<D, TextBoxAppearanceInput, 256>(d)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextBoxAppearancePage {
    pub(crate) view: [f64; 4],
    pub(crate) rotation: u16,
    pub(crate) user_unit: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextBoxAppearanceInput {
    pub(crate) text_box: TextBoxMutation,
    #[serde(default)]
    pub(crate) source: Option<TextBoxSourceDescriptor>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextBoxAppearanceMetadata {
    pub(crate) text_boxes: Vec<TextBoxAppearanceEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextBoxAppearanceEntry {
    pub(crate) stable_key: String,
    pub(crate) annotation_id: String,
    /// Appearance bounds. The requested canonical rectangle is never settled.
    pub(crate) rect: [f64; 4],
    pub(crate) fitted_font_size: f64,
    pub(crate) line_count: Option<usize>,
    /// Page-space text clipping bounds after frame insets; unknown for original paint.
    pub(crate) text_bounds: Option<[f64; 4]>,
}

pub(crate) struct TextBoxAppearanceBytes {
    pub(crate) data: Vec<u8>,
    pub(crate) metadata: TextBoxAppearanceMetadata,
}

pub(crate) fn parse_text_box_appearance_request(bytes: &[u8]) -> Result<TextBoxAppearanceRequest> {
    if bytes.len() > MAX_TEXT_BOX_APPEARANCE_REQUEST_BYTES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Text box appearance request exceeds its byte ceiling",
        ));
    }
    Ok(evb_native_support::bounded_io::deserialize_json_slice(
        bytes,
        "text box appearance request",
    )?)
}

pub(crate) fn build_text_box_appearance_pdf(
    request: TextBoxAppearanceRequest,
) -> Result<TextBoxAppearanceBytes> {
    let TextBoxAppearancePage {
        view: [x1, y1, x2, y2],
        rotation,
        user_unit,
    } = request.page;
    let view = PdfRect { x1, y1, x2, y2 };
    if ![x1, y1, x2, y2, user_unit]
        .iter()
        .all(|n| n.is_finite() && n.abs() <= f64::from(f32::MAX))
        || view.width() <= 0.0
        || view.height() <= 0.0
        || !matches!(rotation, 0 | 90 | 180 | 270)
        || user_unit <= 0.0
        || user_unit > 75000.0
        || request.text_boxes.is_empty()
    {
        return Err("Invalid text box appearance page".into());
    }
    let editors = request
        .text_boxes
        .iter()
        .map(|input| &input.text_box)
        .collect::<Vec<_>>();
    let total: usize = editors.iter().map(|editor| editor.text.len()).sum();
    if total > MAX_TEXT_BOX_APPEARANCE_TEXT_BYTES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Text box appearance batch exceeds its 1 MiB text ceiling",
        ));
    }
    let mut names = HashSet::new();
    for input in &request.text_boxes {
        validate_text_boxes(std::slice::from_ref(&input.text_box))?;
        if input
            .text_box
            .original_appearance
            .as_ref()
            .is_some_and(|a| a.source_annotation_id.is_some())
            || !names.insert(input.text_box.stable_key.clone())
        {
            return Err(
                "Text box appearance input must have unique keys and inline or derived paint"
                    .into(),
            );
        }
        if let Some(source) = &input.source {
            source.validate()?;
        }
    }
    let mut document = Document::with_version("1.7");
    let pages = document.new_object_id();
    let page = document.new_object_id();
    let mut fonts = text_box_font::SharedFonts::default();
    let mut entries = Vec::with_capacity(editors.len());
    let mut annots = Vec::with_capacity(editors.len());
    let mut content_bytes = 0usize;
    for input in request.text_boxes {
        let editor = input.text_box;
        let mut rect = validate_text_box_rect(&editor, view)?;
        if let Some(original) = &editor.original_appearance {
            let id = document.new_object_id();
            restore_text_box_recovery(
                &mut document,
                original,
                id,
                page,
                None,
                &editor,
                "D:19700101000000Z",
            )?;
            rect = parse_rect(document.get_dictionary(id)?.get(b"Rect")?)?;
            entries.push(TextBoxAppearanceEntry {
                stable_key: editor.stable_key.clone(),
                annotation_id: format!("{}R", id.0),
                rect: [rect.x1, rect.y1, rect.x2, rect.y2],
                fitted_font_size: editor.font_size,
                line_count: None,
                text_bounds: None,
            });
            annots.push(Object::Reference(id));
            continue;
        }
        let existing = input
            .source
            .map(|source| {
                rect = source.settled_bounds(&editor)?;
                Ok::<_, Box<dyn Error>>((None, None, Some(source.frame(rect))))
            })
            .transpose()?;
        let appearance = build_text_box_appearance(
            &mut document,
            &editor,
            rect,
            i64::from(rotation),
            &mut fonts,
            existing.as_ref(),
        )?;
        content_bytes = content_bytes.saturating_add(
            document
                .get_object(appearance.object_id)?
                .as_stream()?
                .content
                .len(),
        );
        if content_bytes > MAX_TEXT_BOX_APPEARANCE_BYTES {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Text box appearance content exceeds its byte ceiling",
            ));
        }
        let id = document.new_object_id();
        let mut dict =
            dictionary! {"Type" => "Annot", "Subtype" => "FreeText", "F" => 4, "P" => page};
        entries.push(TextBoxAppearanceEntry {
            stable_key: editor.stable_key.clone(),
            annotation_id: format!("{}R", id.0),
            rect: [rect.x1, rect.y1, rect.x2, rect.y2],
            fitted_font_size: appearance.font_size,
            line_count: Some(appearance.line_count),
            text_bounds: Some(appearance.text_bounds),
        });
        crate::annotations::set_text_box_fields(
            &mut dict,
            &editor,
            &text_box_name(&editor),
            rect,
            "D:19700101000000Z",
            appearance,
            i64::from(rotation),
            existing,
        );
        document.set_object(id, dict);
        annots.push(Object::Reference(id));
    }
    fonts.embed(&mut document, &FONTS)?;
    document.set_object(page, dictionary! {"Type" => "Page", "Parent" => pages, "MediaBox" => rect_object(view), "CropBox" => rect_object(view), "Rotate" => i64::from(rotation), "UserUnit" => number_object(user_unit), "Annots" => annots, "Resources" => Dictionary::new()});
    document.set_object(
        pages,
        dictionary! {"Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1},
    );
    let catalog = document.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages});
    document.trailer.set("Root", catalog);
    let mut data = Vec::new();
    document.save_to(&mut data)?;
    if data.len() > MAX_TEXT_BOX_APPEARANCE_BYTES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Text box appearance PDF exceeds its byte ceiling",
        ));
    }
    Ok(TextBoxAppearanceBytes {
        data,
        metadata: TextBoxAppearanceMetadata {
            text_boxes: entries,
        },
    })
}

pub(crate) struct TextBoxAppearance {
    pub(crate) object_id: ObjectId,
    pub(crate) font_size: f64,
    line_count: usize,
    text_bounds: [f64; 4],
}

/// What a DA says, read token by token as the writer patches it: the font and
/// size before each Tf, keeping the last well-formed size when one is
/// malformed, and the components before the last fill and stroke operators.
#[derive(Default)]
pub(crate) struct DefaultAppearance {
    pub(crate) font: Option<Vec<u8>>,
    pub(crate) size: Option<f64>,
    pub(crate) fill: Option<Vec<f64>>,
    pub(crate) stroke: Option<Vec<f64>>,
}

impl DefaultAppearance {
    /// The size, where EVB can draw text at it.
    pub(crate) fn font_size(&self) -> Option<f64> {
        self.size
            .filter(|v| v.is_finite() && *v > 0.0 && *v <= 512.0)
    }
}

pub(crate) fn default_appearance(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
) -> Option<DefaultAppearance> {
    let da = String::from_utf8_lossy(entry(document, annotation, b"DA")?.as_str().ok()?);
    let tokens: Vec<&str> = da.split_whitespace().collect();
    let mut found = DefaultAppearance::default();
    for (index, token) in tokens.iter().enumerate() {
        // Its index is one less than the operator's component count.
        let count = ["g", "", "rg", "k"]
            .iter()
            .position(|o| token.eq_ignore_ascii_case(o));
        let components = count.and_then(|count| {
            let operands = tokens.get(index.checked_sub(count + 1)?..index)?;
            let values: Option<Vec<f64>> = operands.iter().map(|t| t.parse().ok()).collect();
            values.filter(|v| v.iter().all(|c| (0.0..=1.0).contains(c)))
        });
        match *token {
            "Tf" => {
                found.size = tokens[index.saturating_sub(1)].parse().ok().or(found.size);
                let name = tokens
                    .get(index.wrapping_sub(2))
                    .and_then(|t| t.strip_prefix('/'));
                found.font = name.map(|name| name.as_bytes().to_vec()).or(found.font);
            }
            "g" | "rg" | "k" => found.fill = components.or(found.fill),
            "G" | "RG" | "K" => found.stroke = components.or(found.stroke),
            _ => {}
        }
    }
    Some(found)
}

fn parse_default_appearance(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> std::result::Result<(f64, String), String> {
    let da = crate::free_text_frame::default_appearance(document, dict)
        .ok_or_else(|| "FreeText /DA must be a PDF string".to_string())?;
    let font_size = da
        .font_size()
        .ok_or_else(|| "FreeText /DA has no supported font size".to_string())?;
    let color = da
        .fill
        .ok_or_else(|| "FreeText /DA has no supported color".to_string())?;
    Ok((font_size, pdf_color_to_hex(Some(&color), "#000000")))
}

pub(crate) fn parse_text_box_entry(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    object_id: ObjectId,
    page_index: u64,
    page_view: PdfRect,
    page_rotation: i64,
    name: &str,
) -> std::result::Result<PdfAnnotationParseTextBox, String> {
    let rect = read_annotation_rect(document, dict)?;
    // Admit the visible rectangle once before recovering private layout
    // coordinates, which may cross the page edge for rotated text.
    pdf_rect_to_marker_rect(rect, page_view, page_rotation).map_err(|error| error.to_string())?;
    if dict.get(b"Contents").is_err() && dict.get(b"RC").is_ok() {
        return Err("FreeText has rich text without plain text contents".to_string());
    }
    let text = read_optional_annotation_text(document, dict, b"Contents")?.unwrap_or_default();
    let (font_size, color) = parse_default_appearance(document, dict)?;
    // The editor draws a solid border; another style keeps its producer's
    // appearance, and the label is selectable and copyable but not editable.
    let read_only = !crate::free_text_frame::border_is_editable(document, dict);
    let frame = crate::free_text_frame::free_text_frame(document, dict, rect);
    let rotation = read_optional(document, dict, b"Rotate", Object::as_i64)?.unwrap_or(0);
    let rotation = rotation.rem_euclid(360);
    if !matches!(rotation, 0 | 90 | 180 | 270) {
        return Err("Imported FreeText rotation is not a quarter turn".to_string());
    }
    let (rect, rotation) =
        crate::text_box_font::stored_editor_geometry(document, dict, rect, rotation, page_rotation)
            .map_err(|error| error.to_string())?;
    let rect = pdf_rect_to_marker_rect_unbounded(rect, page_view, page_rotation)
        .map_err(|error| error.to_string())?;
    Ok(PdfAnnotationParseTextBox {
        replies: Vec::new(),
        page_index,
        object_number: u64::from(object_id.0),
        generation_number: u64::from(object_id.1),
        name: name.to_string(),
        author: read_optional_annotation_author(document, dict)?,
        created_at: read_annotation_date(document, dict, b"CreationDate"),
        modified_at: read_annotation_date(document, dict, b"M"),
        text,
        rect,
        rotation,
        font_size,
        color,
        // On the page's upright sides: the editor turns them with the box.
        frame: frame.editor(page_rotation),
        source: (!read_only).then(|| {
            TextBoxSourceDescriptor::read(
                document,
                dict,
                read_annotation_rect(document, dict).unwrap(),
            )
        }),
        recovery_data: None,
        read_only,
    })
}

/// Where a fitted line starts and sits in its box. RTL lines align right, and
/// the spaces that hang at their end fall off the start side.
pub(crate) fn line_origin(geometry: &Geometry, line: &Line, index: usize, size: f64) -> (f64, f64) {
    let rest = (geometry.width - 2.0 * PADDING_X * size).max(0.0) - line.width;
    let left = PADDING_X * size + if line.rtl { rest } else { 0.0 };
    let baseline = geometry.height - baseline_from_top(size) - index as f64 * LINE_HEIGHT * size;
    (left, baseline)
}

/// The editor grows a box to its lines. They fit when the box holds their
/// count and every positioned glyph's ink, marks below the baseline and above
/// the cap height included, stays inside the box, which clips the appearance.
/// Where it does not, the size shrinks until it does. The appearance and the
/// DA, which the reopened editor reads, both use that size. Printing fits a
/// box without an appearance the same way, with its own programs and layout.
pub(crate) fn fit_text_box(
    font_size: f64,
    geometry: &Geometry,
    programs: &[&[u8]],
    lay_out: impl Fn(f64, f64) -> Vec<Line>,
) -> (f64, Vec<Line>) {
    let faces: Vec<_> = programs
        .iter()
        .map(|p| FontRef::from_index(p, 0).expect("font"))
        .collect();
    let lines = |size: f64| lay_out(geometry.width - 2.0 * PADDING_X * size, size);
    let fit = |size: f64| {
        let lines = lines(size);
        let (width, height) = (geometry.width, geometry.height);
        let inside = |(index, line): (usize, &Line)| {
            let (left, baseline) = line_origin(geometry, line, index, size);
            // A simple font's line has measured advances, not outlines.
            let measured = !line.glyphs.is_empty() || left + line.width <= width;
            measured
                && line.glyphs.iter().all(|glyph| {
                    let ink =
                        faces[glyph.font].glyph_metrics(Size::new(1.0), LocationRef::default());
                    let ink = ink.bounds(glyph.id.into()).unwrap_or_default();
                    let [x1, y1, x2, y2] =
                        [ink.x_min, ink.y_min, ink.x_max, ink.y_max].map(|em| f64::from(em) * size);
                    let (x, y) = (left + glyph.x, baseline + glyph.y);
                    x1 == x2 || (x + x1).min(y + y1) >= 0.0 && x + x2 <= width && y + y2 <= height
                })
        };
        let height = (lines.len() as f64 * LINE_HEIGHT + PADDING_Y) * size;
        (height <= geometry.height + 0.01 && lines.iter().enumerate().all(inside)).then_some(lines)
    };
    if let Some(lines) = fit(font_size) {
        return (font_size, lines);
    }
    let mut range = (0.0, font_size);
    while range.1 - range.0 > 0.01 {
        let middle = (range.0 + range.1) / 2.0;
        range = if fit(middle).is_some() {
            (middle, range.1)
        } else {
            (range.0, middle)
        };
    }
    let size = ((range.0 * 100.0).floor() / 100.0).max(0.01);
    (size, lines(size))
}

/// Fitted lines clipped to their box. Text state lasts through BT, so each
/// font is selected only where it changes.
pub(crate) fn text_box_content(
    geometry: &Geometry,
    color: &str,
    lines: &[Line],
    size: f64,
) -> String {
    let mut content = format!(
        "q\n{} cm\n0 0 {} {} re W n\nBT\n{color}\n0 Tc\n",
        format_operands(&geometry.matrix),
        number_to_content(geometry.width),
        number_to_content(geometry.height),
    );
    let mut font = None;
    for (index, line) in lines.iter().enumerate() {
        let (left, baseline) = line_origin(geometry, line, index, size);
        content.push_str(&format!(
            "/Span << /ActualText <{}> >> BDC\n",
            text_box_font::unicode_hex(&line.text, true)
        ));
        for run in line.glyphs.chunk_by(|a, b| a.font == b.font) {
            if font.replace(run[0].font) != Some(run[0].font) {
                let size = number_to_content(size);
                content.push_str(&format!("/TextFont{} {size} Tf\n", run[0].font));
            }
            for glyph in run {
                content.push_str(&format!(
                    "1 0 0 1 {} {} Tm <{:04X}> Tj\n",
                    number_to_content(left + glyph.x),
                    number_to_content(baseline + glyph.y),
                    glyph.id,
                ));
            }
        }
        content.push_str("EMC\n");
    }
    content + "ET\nQ"
}

pub(crate) fn build_text_box_appearance(
    document: &mut Document,
    editor: &TextBoxMutation,
    rect: PdfRect,
    page_rotation: i64,
    shared: &mut crate::text_box_font::SharedFonts,
    existing: Option<&ExistingTextBox>,
) -> Result<TextBoxAppearance> {
    let [x1, y1, x2, y2] = editor.rect;
    let source = PdfRect { x1, y1, x2, y2 };
    // A framed box fits its text inside the frame, which it draws first.
    let frame = existing.and_then(|existing| existing.2.as_ref());
    let geometry = text_box_font::geometry(source, i64::from(editor.rotation), page_rotation)?;
    let geometry = FreeTextFrame::fit(frame, geometry);
    let color = editor.color.map(|component| f64::from(component) / 255.0);
    let text = |width, size| layout(&editor.text, width, size);
    let (size, lines) = fit_text_box(editor.font_size, &geometry, &FONTS, text);
    let fonts = shared.resources(document, &lines);
    let color = format!("{} rg", format_operands(&color));
    let frame = frame.map_or("", |frame| &frame.content);
    let content = frame.to_string() + &text_box_content(&geometry, &color, &lines, size);
    let object_id = document.add_object(Stream::new(lopdf::dictionary! {
        "Type" => "XObject", "Subtype" => "Form", "FormType" => 1,
        "BBox" => rect_object(rect), "Resources" => lopdf::dictionary! {"Font" => fonts},
        "Matrix" => vec![number_object(1.0), number_object(0.0), number_object(0.0), number_object(1.0), number_object(-rect.x1), number_object(-rect.y1)],
    }, content.into_bytes()));
    Ok(TextBoxAppearance {
        object_id,
        font_size: size,
        line_count: lines.len(),
        text_bounds: [
            geometry.bounds.x1,
            geometry.bounds.y1,
            geometry.bounds.x2,
            geometry.bounds.y2,
        ],
    })
}

/// An edited box keeps its appearance dictionary, its DA and the frame its
/// producer gave it; an unmoved box keeps its written geometry.
pub(crate) type ExistingTextBox = (Option<Dictionary>, Option<Vec<u8>>, Option<FreeTextFrame>);

pub(crate) fn existing_text_box_values(
    document: &impl PdfObjectSource,
    annotation_ref: ObjectId,
    editor: &TextBoxMutation,
    rect: &mut PdfRect,
) -> Result<ExistingTextBox> {
    let dict = document.dictionary(annotation_ref)?;
    let [x1, y1, x2, y2] = editor.rect;
    let source = settled(dict, PdfRect { x1, y1, x2, y2 });
    *rect = crate::text_box_font::geometry(source, i64::from(editor.rotation), 0)?.bounds;
    let value = |key: &[u8]| document.resolved(dict.get(key).ok()?).ok();
    let appearance = value(b"AP").and_then(|object| object.as_dict().ok().cloned());
    Ok((
        appearance,
        value(b"DA").and_then(|object| object.as_str().ok().map(ToOwned::to_owned)),
        Some(free_text_frame(document, dict, *rect)),
    ))
}

pub(crate) fn validate_text_boxes(editors: &[TextBoxMutation]) -> Result<()> {
    if editors.len() > MAX_TEXT_BOXES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Too many text boxes (maximum {MAX_TEXT_BOXES})"),
        ));
    }
    for editor in editors {
        if editor.stable_key.trim().is_empty() || editor.stable_key.len() > 512 {
            return Err("Invalid text box stable key".into());
        }
        if editor
            .annotation_id
            .as_deref()
            .is_some_and(|value| parse_pdfjs_annotation_object_id(value).is_none())
        {
            return Err("Invalid text box annotation id".into());
        }
        if editor.text.len() > MAX_TEXT_BOX_TEXT_BYTES {
            return Err("Text box text exceeds the 64 KiB admission ceiling".into());
        }
        if !editor.rect.iter().all(|coordinate| coordinate.is_finite())
            || editor.rect[2] <= editor.rect[0]
            || editor.rect[3] <= editor.rect[1]
        {
            return Err("Invalid text box rectangle".into());
        }
        if !matches!(editor.rotation, 0 | 90 | 180 | 270) {
            return Err("Invalid text box rotation".into());
        }
        if !editor.font_size.is_finite() || editor.font_size <= 0.0 || editor.font_size > 512.0 {
            return Err("Invalid text box font size".into());
        }
        if let Some(original) = &editor.original_appearance {
            match (&original.recovery_data, &original.source_annotation_id) {
                (Some(data), None) => {
                    let graph = decode_note_recovery(data)?;
                    let root = graph.trailer.get(b"Root")?.as_reference()?;
                    if annotation_subtype(graph.get_dictionary(root)?) != "freetext" { return Err("Original appearance root is not FreeText".into()); }
                }
                (None, Some(id)) if parse_pdfjs_annotation_object_id(id).is_some() => {}
                _ => return Err("Original appearance must identify one recovery graph or retained source annotation".into()),
            }
        } else {
            crate::text_box_font::validate_text(&editor.text)?;
        }
    }
    Ok(())
}

pub(crate) fn validate_text_box_document_postconditions(
    document: &impl PdfObjectSource,
    editors: &[TextBoxMutation],
    modified_at: &str,
) -> Result<()> {
    if editors.is_empty() {
        return Ok(());
    }
    let page_resolver = PageTreeResolver::new(document)?;
    for editor in editors {
        let page_number = editor
            .page_index
            .checked_add(1)
            .ok_or("Invalid FreeText editor page index")?;
        let page_id = page_resolver.page_id(document, page_number)?;
        let page_view = resolve_page_view(document, page_id)?;
        let expected_rect = validate_text_box_rect(editor, page_view)?;
        let expected_name = text_box_name(editor);
        let page_annotation_refs = get_page_annots(document, page_id)?
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .collect::<Vec<_>>();
        let matching_refs: Vec<ObjectId> = if let Some(annotation_id) =
            editor.annotation_id.as_deref()
        {
            let object_id = parse_pdfjs_annotation_object_id(annotation_id)
                .ok_or("Invalid imported FreeText annotation id")?;
            page_annotation_refs
                .into_iter()
                .filter(|candidate| *candidate == object_id)
                .collect()
        } else {
            page_annotation_refs
                .into_iter()
                .filter(|object_id| {
                    document
                        .dictionary(*object_id)
                        .ok()
                        .filter(|dict| annotation_subtype(dict) == "freetext")
                        .and_then(read_annotation_name)
                        .is_some_and(|actual_name| {
                            annotation_names_match(&actual_name, &expected_name, &["evb-freetext:"])
                        })
                })
                .collect()
        };
        if matching_refs.len() != 1 {
            return Err(format!(
                "Expected exactly one FreeText editor named {expected_name}, found {}",
                matching_refs.len()
            )
            .into());
        }
        let dict = document.dictionary(matching_refs[0])?;
        let effective_modified_at = shape_pdf_date(editor.modified_at, modified_at);
        validate_annotation_text_fields(
            dict,
            &editor.text,
            &effective_modified_at,
            "FreeText editor",
        )?;
        if editor.author.is_some() {
            validate_optional_author(dict, editor.author.as_deref(), "FreeText editor")?;
        }
        if let Some(created_at) = editor.created_at {
            let actual_creation_date = dict
                .get(b"CreationDate")
                .ok()
                .and_then(pdf_string_to_text)
                .ok_or("FreeText editor is missing creation timestamp")?;
            if actual_creation_date != shape_pdf_date(Some(created_at), modified_at) {
                return Err("FreeText editor creation timestamp did not match".into());
            }
        }
        let actual_rect = parse_rect(dict.get(b"Rect")?)?;
        validate_rect_approximately(actual_rect, expected_rect, "FreeText editor Rect")?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let rotation = i64::from(editor.rotation);
        let (source_rect, _) = crate::text_box_font::stored_editor_geometry(
            document,
            dict,
            actual_rect,
            rotation,
            page_rotation,
        )?;
        let [x1, y1, x2, y2] = editor.rect;
        let requested = PdfRect { x1, y1, x2, y2 };
        validate_rect_approximately(source_rect, requested, "FreeText canonical Rect")?;
        if editor.original_appearance.is_none() && dict.get(b"Rotate")?.as_i64()? != rotation {
            return Err("FreeText editor rotation did not match the requested rotation".into());
        }
        // The box reopens at the size its appearance draws, and in its color.
        let reopened = crate::annotation_parse::parse_text_box_entry(
            document,
            dict,
            matching_refs[0],
            0,
            page_view,
            page_rotation,
            &expected_name,
        )?;
        if editor.original_appearance.is_some() {
            let [r, g, b] = editor.color;
            if (reopened.font_size - editor.font_size).abs() > 0.0001
                || reopened.rotation != rotation
                || reopened.color != format!("#{r:02x}{g:02x}{b:02x}")
            {
                return Err(
                    "Restored text box differs from its canonical size, rotation or color".into(),
                );
            }
            continue;
        }
        let appearance = document.resolved(dict.get(b"AP")?)?.as_dict()?;
        let content = &document
            .resolved(appearance.get(b"N")?)?
            .as_stream()?
            .content;
        let drawn = String::from_utf8_lossy(content)
            .split_once(" Tf")
            .map(|(operands, _)| {
                operands
                    .rsplit(char::is_whitespace)
                    .next()
                    .and_then(|size| size.parse().ok())
            });
        let [r, g, b] = editor.color;
        if drawn.is_some_and(|size| size != Some(reopened.font_size))
            || reopened.font_size > editor.font_size + 0.0001
            || reopened.color != format!("#{r:02x}{g:02x}{b:02x}")
        {
            return Err("FreeText editor does not reopen at its saved size and color".into());
        }
        validate_appearance(document, dict)?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextBoxOriginalAppearance {
    #[serde(default)]
    pub(crate) recovery_data: Option<String>,
    #[serde(default)]
    pub(crate) source_annotation_id: Option<String>,
    #[serde(skip)]
    pub(crate) source_graph: Option<Document>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextBoxMutation {
    #[serde(default)]
    pub(crate) original_appearance: Option<TextBoxOriginalAppearance>,
    pub(crate) page_index: u32,
    pub(crate) stable_key: String,
    #[serde(default)]
    pub(crate) annotation_id: Option<String>,
    pub(crate) text: String,
    pub(crate) rect: [f64; 4],
    pub(crate) rotation: u16,
    pub(crate) font_size: f64,
    pub(crate) color: [u8; 3],
    #[serde(default)]
    pub(crate) author: Option<String>,
    #[serde(default)]
    pub(crate) created_at: Option<u64>,
    #[serde(default)]
    pub(crate) modified_at: Option<u64>,
}

/// The layout rectangle `annotation` was written with, EVB's or else its
/// /Rect, when `rect` lies within a thousandth of a point of it, so a box or
/// note that did not move keeps its numbers and never drifts.
pub(crate) fn settled(annotation: &Dictionary, rect: PdfRect) -> PdfRect {
    let stored = text_box_font::editor_geometry(annotation)
        .and_then(|g| g.as_dict().ok()?.get(b"Rect").ok());
    let written = stored.or(annotation.get(b"Rect").ok());
    settled_rect(written.and_then(|written| parse_rect(written).ok()), rect)
}

pub(crate) fn settled_rect(written: Option<PdfRect>, rect: PdfRect) -> PdfRect {
    written
        .filter(|written| near(*written, rect, 1e-3))
        .unwrap_or(rect)
}

/// Whether two rectangles agree within `tolerance` points on every side.
pub(crate) fn near(a: PdfRect, b: PdfRect, tolerance: f64) -> bool {
    [a.x1 - b.x1, a.y1 - b.y1, a.x2 - b.x2, a.y2 - b.y2]
        .iter()
        .all(|d| d.abs() <= tolerance)
}
