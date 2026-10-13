//! The frame a FreeText draws around its text, and the DA it draws with. Save,
//! print and the editor's reader take both from the same dictionary entries,
//! so a label keeps the border and background its producer gave it wherever
//! it is drawn.

use super::*;
use crate::text_box_font::Geometry;

/// A colour's fill or stroke operator, by its component count.
pub(crate) fn colour(components: &[f64], fill: bool) -> String {
    let operator = ["G", "RG", "K", "g", "rg", "k"][components.len() / 2 + 3 * usize::from(fill)];
    format!("{} {operator}", format_operands(components))
}

/// A dictionary entry, resolved.
fn entry<'a>(
    document: &'a impl PdfObjectSource,
    dict: &'a Dictionary,
    key: &[u8],
) -> Option<&'a Object> {
    document.resolved(dict.get(key).ok()?).ok()
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

/// The editor draws a solid border: one in another style, dashed or cloudy
/// keeps the appearance its producer drew.
pub(crate) fn border_is_editable(document: &impl PdfObjectSource, dict: &Dictionary) -> bool {
    let name = |dict, key| Some(entry(document, dict, key)?.as_name().ok()?.to_vec());
    let style = entry(document, dict, b"BS").and_then(|style| style.as_dict().ok());
    let border = entry(document, dict, b"Border").and_then(|border| border.as_array().ok());
    let dash = border.and_then(|border| document.resolved(border.get(3)?).ok());
    let effect = entry(document, dict, b"BE").and_then(|effect| effect.as_dict().ok());
    let intensity = effect.and_then(|effect| object_to_f64(entry(document, effect, b"I")?).ok());
    let cloudy = effect.is_some_and(|effect| name(effect, b"S").as_deref() == Some(b"C"));
    style.is_none_or(|style| name(style, b"S").is_none_or(|style| style == b"S"))
        && (style.is_some() || dash.is_none_or(|dash| dash.as_array().is_ok_and(Vec::is_empty)))
        && !(cloudy && intensity.unwrap_or(0.0) > 0.0)
}

/// The frame as the editor draws it: /RD's top, right, bottom and left insets
/// on the box's own sides, the solid border inside them and the background
/// under it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextBoxFrame {
    pub(crate) insets: [f64; 4],
    pub(crate) border_width: f64,
    pub(crate) border_color: Option<String>,
    pub(crate) background: Option<String>,
}

/// What a FreeText draws around its text at `rect`, in page space. /C fills
/// the box less /RD. A declared /BS or /Border width strokes that box with
/// mitred corners, as PDF joins lines by default, in the DA's stroking colour
/// or else its text colour; a FreeText that declares no border draws none.
/// The text fits inside the stroke, on whichever sides the box is turned to.
pub(crate) struct FreeTextFrame {
    pub(crate) content: String,
    pub(crate) border: Option<Vec<f64>>,
    /// /C is no fill: the text colour EVB once wrote on a box it saved, or a
    /// colour its producer's own appearance does not paint. Save drops it.
    pub(crate) stale_fill: bool,
    /// /RD's left, bottom, right and top in page space, and the border width.
    rd: [f64; 4],
    width: f64,
    background: Option<Vec<f64>>,
}

/// Page-space left, bottom, right and top values on the sides of a box turned
/// counterclockwise by `turn` degrees, in the same order.
fn box_sides(sides: [f64; 4], turn: i64) -> [f64; 4] {
    let quarter = turn.rem_euclid(360) as usize / 90;
    [0, 1, 2, 3].map(|side| sides[(side + quarter) % 4])
}

impl FreeTextFrame {
    /// Keeps the frame through an edit. The border keeps its colour when the
    /// text changes colour: a DA without a stroking colour gains the one the
    /// border is drawn in. A stale /C goes.
    pub(crate) fn keep_in(&self, annotation: &mut Dictionary, da: &mut Vec<u8>) {
        let tokens = tokenize_default_appearance(da);
        let stroked = tokens
            .iter()
            .any(|&(start, end)| matches!(&da[start..end], b"G" | b"RG" | b"K"));
        if let Some(border) = self.border.as_ref().filter(|_| !stroked) {
            da.extend(format!(" {}", colour(border, false)).into_bytes());
        }
        if self.stale_fill {
            annotation.remove(b"C");
        }
    }

    /// The box the text fits: `geometry`'s box less /RD and the border.
    pub(crate) fn fit(frame: Option<&Self>, geometry: Geometry) -> Geometry {
        let Some(frame) = frame else {
            return geometry;
        };
        let [a, b, c, d, e, f] = geometry.matrix;
        let turn = (b.atan2(a).to_degrees().round() as i64).rem_euclid(360);
        let [left, bottom, right, top] = box_sides(frame.rd.map(|rd| rd + frame.width), turn);
        let (width, height) = (
            geometry.width - left - right,
            geometry.height - bottom - top,
        );
        if width <= 0.0 || height <= 0.0 {
            return geometry;
        }
        let matrix = [
            a,
            b,
            c,
            d,
            e + a * left + c * bottom,
            f + b * left + d * bottom,
        ];
        let (x1, y1, x2, y2) = (0.0, 0.0, width, height);
        let bounds =
            crate::split_pages::PdfMatrix::from_values(matrix).bounds(PdfRect { x1, y1, x2, y2 });
        Geometry {
            bounds,
            width,
            height,
            matrix,
        }
    }

    /// The frame as the editor draws it on a box turned by `turn` degrees.
    pub(crate) fn editor(&self, turn: i64) -> Option<TextBoxFrame> {
        let [left, bottom, right, top] = box_sides(self.rd, turn);
        let hex = |colour: &Vec<f64>| pdf_color_to_hex(Some(colour), "#000000");
        (!self.content.is_empty() || self.rd.iter().any(|rd| *rd > 0.0)).then(|| TextBoxFrame {
            insets: [top, right, bottom, left],
            border_width: self.width,
            border_color: self.border.as_ref().map(hex),
            background: self.background.as_ref().map(hex),
        })
    }
}

/// Whether a label's normal appearance can paint a fill: a filled path, a
/// shading or a form. One that is absent or unread is unknown, so it can.
fn appearance_fills(document: &impl PdfObjectSource, annotation: &Dictionary) -> bool {
    let ap = entry(document, annotation, b"AP").and_then(|ap| ap.as_dict().ok());
    let normal = ap.and_then(|ap| entry(document, ap, b"N")?.as_stream().ok());
    let limit = MAX_STAMP_APPEARANCE_STREAM_BYTES;
    let bytes = normal.and_then(|n| plain_stream_with_limit(n, limit).ok());
    let content = bytes.and_then(|bytes| lopdf::content::Content::decode(&bytes).ok());
    let fills = |o: &lopdf::content::Operation| {
        ["f", "F", "f*", "B", "B*", "b", "b*", "sh", "Do"].contains(&o.operator.as_str())
    };
    content.is_none_or(|c| c.operations.iter().any(fills))
}

pub(crate) fn free_text_frame(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    rect: PdfRect,
) -> FreeTextFrame {
    let mut frame = annotation.clone();
    frame.set("Rect", rect_object(rect));
    let inner = annotation_inner_rect(document, &frame).unwrap_or(rect);
    let da = default_appearance(document, annotation).unwrap_or_default();
    let number = |value| object_to_f64(document.resolved(value).ok()?).ok();
    let values = entry(document, annotation, b"C").and_then(|c| c.as_array().ok());
    let background: Option<Vec<f64>> = values.and_then(|c| c.iter().map(number).collect());
    let background = background
        .filter(|v| matches!(v.len(), 1 | 3 | 4) && v.iter().all(|n| (0.0..=1.0).contains(n)));
    let hex = |colour: &Vec<f64>| pdf_color_to_hex(Some(colour), "#000000");
    // A box EVB saved, which carries its private geometry, may hold /C in the
    // text colour EVB once wrote there. A producer's /C is its fill where its
    // own appearance paints one, or where it drew none (review-b8f).
    let stale_fill = background.is_some()
        && match crate::text_box_font::editor_geometry(annotation) {
            Some(_) => background.as_ref().map(hex) == da.fill.as_ref().map(hex),
            None => !appearance_fills(document, annotation),
        };
    let background = background.filter(|_| !stale_fill);
    let (x, y, w, h) = (inner.x1, inner.y1, inner.width(), inner.height());
    let mut content = String::new();
    if let Some(background) = &background {
        let area = format_operands(&[x, y, w, h]);
        content.push_str(&format!("q {} {area} re f Q\n", colour(background, true)));
    }
    let width = shape_stroke_width(document, annotation).filter(|w| w.is_finite() && *w > 0.0);
    let border = width.map(|_| da.stroke.or(da.fill).unwrap_or_else(|| vec![0.0]));
    if let Some(colour) = &border {
        let components: Vec<_> = colour.iter().map(|c| number_object(*c)).collect();
        frame.set("C", components);
        frame.remove(b"IC");
        content.extend(synthesized_shape_content(document, &frame, b"Square"));
    }
    FreeTextFrame {
        content,
        border,
        stale_fill,
        rd: [
            inner.x1 - rect.x1,
            inner.y1 - rect.y1,
            rect.x2 - inner.x2,
            rect.y2 - inner.y2,
        ],
        width: width.unwrap_or(0.0),
        background,
    }
}
