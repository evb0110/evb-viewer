//! The frame a FreeText draws around its text, and the DA it draws with. Save,
//! print and the editor's reader take both from the same dictionary entries,
//! so a label keeps the border and background its producer gave it wherever
//! it is drawn.

use super::*;

/// A colour's fill or stroke operator, by its component count.
pub(crate) fn colour(components: &[f64], fill: bool) -> String {
    let operator = ["G", "RG", "K"][components.len() / 2];
    let operator = if fill {
        operator.to_lowercase()
    } else {
        operator.to_string()
    };
    format!("{} {operator}", format_operands(components))
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

pub(crate) fn default_appearance(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
) -> Option<DefaultAppearance> {
    let da = document
        .resolved(annotation.get(b"DA").ok()?)
        .ok()?
        .as_str()
        .ok()?;
    let da = String::from_utf8_lossy(da);
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
    let name = |dict: &Dictionary, key: &[u8]| {
        let value = document.resolved(dict.get(key).ok()?).ok()?;
        value.as_name().ok().map(<[u8]>::to_vec)
    };
    let entry = |key: &[u8]| document.resolved(dict.get(key).ok()?).ok();
    let style = entry(b"BS").and_then(|style| style.as_dict().ok());
    let border = entry(b"Border").and_then(|border| border.as_array().ok());
    let dash = border.and_then(|border| document.resolved(border.get(3)?).ok());
    let effect = entry(b"BE").and_then(|effect| effect.as_dict().ok());
    let intensity = effect.and_then(|effect| document.resolved(effect.get(b"I").ok()?).ok());
    style.is_none_or(|style| name(style, b"S").is_none_or(|style| style == b"S"))
        && (style.is_some() || dash.is_none_or(|dash| dash.as_array().is_ok_and(Vec::is_empty)))
        && !(effect.is_some_and(|effect| name(effect, b"S").as_deref() == Some(b"C"))
            && intensity
                .and_then(|value| object_to_f64(value).ok())
                .unwrap_or(0.0)
                > 0.0)
}

/// The frame as the editor draws it: /RD's top, right, bottom and left insets
/// from /Rect, the solid border inside them and the background under it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextBoxFrame {
    pub(crate) insets: [f64; 4],
    pub(crate) border_width: f64,
    pub(crate) border_color: Option<String>,
    pub(crate) background: Option<String>,
}

/// What a FreeText draws around its text at `rect`, in page space. /C fills
/// the box less /RD. A declared /BS or /Border width strokes that box in the
/// DA's stroking colour, or else its text colour; a FreeText that declares no
/// border draws none. The text fits inside the stroke.
pub(crate) struct FreeTextFrame {
    pub(crate) content: String,
    pub(crate) text: PdfRect,
    pub(crate) border: Option<Vec<f64>>,
    pub(crate) editor: Option<TextBoxFrame>,
    /// /C repeats the text colour: EVB once wrote a label's colour there, and
    /// as a fill it would hide the text, so it is no background.
    pub(crate) stale_fill: bool,
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
}

pub(crate) fn free_text_frame(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    rect: PdfRect,
) -> FreeTextFrame {
    let mut frame = annotation.clone();
    frame.set("Rect", rect_object(rect));
    frame.remove(b"IC");
    let inner = annotation_inner_rect(document, &frame).unwrap_or(rect);
    let da = default_appearance(document, annotation).unwrap_or_default();
    let background = (|| -> Option<Vec<f64>> {
        let values = document.resolved(annotation.get(b"C").ok()?).ok()?;
        let values = values.as_array().ok()?.iter();
        values
            .map(|v| object_to_f64(document.resolved(v).ok()?).ok())
            .collect()
    })()
    .filter(|v| matches!(v.len(), 1 | 3 | 4) && v.iter().all(|n| (0.0..=1.0).contains(n)));
    let hex = |colour: &Vec<f64>| pdf_color_to_hex(Some(colour), "#000000");
    let stale_fill =
        background.is_some() && background.as_ref().map(hex) == da.fill.as_ref().map(hex);
    let background = background.filter(|_| !stale_fill);
    let mut content = String::new();
    if let Some(background) = &background {
        let area = format_operands(&[inner.x1, inner.y1, inner.width(), inner.height()]);
        content.push_str(&format!("q {} {area} re f Q\n", colour(background, true)));
    }
    let width = shape_stroke_width(document, annotation).filter(|w| w.is_finite() && *w > 0.0);
    let border = width.map(|_| da.stroke.or(da.fill).unwrap_or_else(|| vec![0.0]));
    if let Some(colour) = &border {
        frame.set(
            "C",
            colour
                .iter()
                .copied()
                .map(number_object)
                .collect::<Vec<_>>(),
        );
        content.extend(synthesized_shape_content(document, &frame, b"Square"));
    }
    let inset = width.unwrap_or(0.0);
    let insets = [
        rect.y2 - inner.y2,
        rect.x2 - inner.x2,
        inner.y1 - rect.y1,
        inner.x1 - rect.x1,
    ];
    let drawn = !content.is_empty() || insets.iter().any(|inset| *inset > 0.0);
    FreeTextFrame {
        content,
        text: PdfRect {
            x1: inner.x1 + inset,
            y1: inner.y1 + inset,
            x2: inner.x2 - inset,
            y2: inner.y2 - inset,
        },
        editor: drawn.then(|| TextBoxFrame {
            insets,
            border_width: inset,
            border_color: border.as_ref().map(hex),
            background: background.as_ref().map(hex),
        }),
        border,
        stale_fill,
    }
}
