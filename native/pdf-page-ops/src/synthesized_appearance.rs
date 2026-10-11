//! The appearance a stock reader draws for an annotation that has no /AP. Print
//! layout is its only caller; saving and editing shapes lives in `shapes`.

use super::*;
use lopdf::dictionary;

/// The appearance a stock reader synthesizes for an annotation that has no
/// /AP, for the subtypes EVB can draw itself. `None` leaves the annotation
/// without a printable appearance, so print layout fails closed.
pub(crate) fn synthesized_appearance(
    document: &mut Document,
    annotation: &Dictionary,
) -> Option<ObjectId> {
    let subtype = annotation.get(b"Subtype").and_then(Object::as_name).ok()?;
    let content = match subtype {
        b"Text" => return synthesized_note_icon(document, annotation),
        b"Square" | b"Circle" | b"Line" | b"PolyLine" | b"Polygon" => {
            synthesized_shape_content(document, annotation, subtype)?
        }
        _ => return None,
    };
    // The BBox is the annotation's own /Rect, so flattening maps the drawing 1:1.
    let rect = read_shape_annotation_rect(document, annotation)?;
    let bbox = [
        rect.x1.min(rect.x2),
        rect.y1.min(rect.y2),
        rect.x1.max(rect.x2),
        rect.y1.max(rect.y2),
    ];
    Some(document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => bbox.map(number_object).to_vec(),
            "Resources" => Dictionary::new(),
        },
        content.into_bytes(),
    )))
}

/// The Note icon, drawn for any /Text annotation without /AP whatever its
/// /Name. Saved notes rely on viewers drawing an icon; print layout must
/// materialize one before flattening the page, and EVB does not draw each
/// standard icon's own glyph.
fn synthesized_note_icon(document: &mut Document, annotation: &Dictionary) -> Option<ObjectId> {
    let color = match annotation.get(b"C") {
        Ok(color) => {
            let count = document.dereference(color).ok()?.1.as_array().ok()?.len();
            let operator = match count {
                1 => "g",
                3 => "rg",
                4 => "k",
                _ => return None,
            };
            let components = numbers(document, color, count)?;
            if components.iter().any(|value| !(0.0..=1.0).contains(value)) {
                return None;
            }
            format!("{} {operator}", format_operands(&components))
        }
        Err(_) => "1 1 0 rg".to_string(),
    };
    let content = format!(
        "q {color} 0 G 0.8 w 1 1 m 19 1 l 19 15 l 15 19 l 1 19 l h B\n\
         15 19 m 15 15 l 19 15 l S\n\
         4 12 m 16 12 l 4 9 m 16 9 l 4 6 m 12 6 l S Q\n"
    );
    Some(document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 20.into(), 20.into()],
            "Resources" => Dictionary::new(),
        },
        content.into_bytes(),
    )))
}

/// Content for an EVB-supported shape without /AP, in page space. The stroke
/// follows /C (black when absent), the fill /IC, and the width /BS or /Border.
/// Rectangles and ellipses are inset by half the width so the stroke stays
/// inside /Rect; the line-based shapes already pad /Rect by the stroke.
fn synthesized_shape_content(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    subtype: &[u8],
) -> Option<String> {
    let width = shape_stroke_width(document, annotation).unwrap_or(1.0);
    if !(width.is_finite() && width >= 0.0) {
        return None;
    }
    let dash = border_dash(document, annotation)?;
    // A zero width draws no border; PDF `0 w` would be a one-pixel hairline.
    let stroke = if width == 0.0 {
        None
    } else if annotation.has(b"C") {
        annotation_colour(document, annotation, b"C")?
    } else {
        Some(vec![0.0])
    };
    let fill = annotation_colour(document, annotation, b"IC")?;
    let mut content = String::from("q\n");
    if let Some(stroke) = &stroke {
        // A dash needs butt caps: round caps would add half a width to each end
        // of every dash and fill the gaps.
        let cap = if dash.is_some() { 0 } else { 1 };
        content.push_str(&format!(
            "{} {} w {cap} J 1 j\n",
            colour_operands(stroke, false),
            format_operands(&[width])
        ));
        if let Some(dash) = &dash {
            content.push_str(&format!("[{}] 0 d\n", format_operands(dash)));
        }
    }
    if let Some(fill) = &fill {
        content.push_str(&format!("{}\n", colour_operands(fill, true)));
    }
    let inset = width / 2.0;
    match subtype {
        b"Square" | b"Circle" => {
            let rect = read_shape_annotation_rect(document, annotation)?;
            let x1 = rect.x1.min(rect.x2) + inset;
            let y1 = rect.y1.min(rect.y2) + inset;
            let x2 = rect.x1.max(rect.x2) - inset;
            let y2 = rect.y1.max(rect.y2) - inset;
            let paint = match (stroke.is_some(), fill.is_some()) {
                (true, true) => "B",
                (true, false) => "S",
                (false, true) => "f",
                (false, false) => "n",
            };
            if subtype == b"Square" {
                content.push_str(&format!("{x1} {y1} {} {} re {paint}\n", x2 - x1, y2 - y1));
            } else {
                let center = ((x1 + x2) / 2.0, (y1 + y2) / 2.0);
                content.push_str(&ellipse_path(center, ((x2 - x1) / 2.0, (y2 - y1) / 2.0)));
                content.push_str(&format!("{paint}\n"));
            }
        }
        _ => {
            let points = annotation_points(document, annotation, subtype)?;
            let (start, rest) = points.split_first()?;
            content.push_str(&format!("{} {} m\n", start.0, start.1));
            for point in rest {
                content.push_str(&format!("{} {} l\n", point.0, point.1));
            }
            let paint = match (subtype, stroke.is_some(), fill.is_some()) {
                (b"Polygon", true, true) => "b",
                (b"Polygon", true, false) => "s",
                (b"Polygon", false, true) => "f",
                (_, true, _) => "S",
                _ => "n",
            };
            if subtype == b"Polygon" {
                content.push_str("h\n");
            }
            content.push_str(&format!("{paint}\n"));
            if subtype != b"Polygon" {
                content.push_str(&line_ending_appearance(
                    document,
                    annotation,
                    &points,
                    width,
                    stroke.as_deref(),
                    fill.as_deref(),
                )?);
            }
        }
    }
    content.push_str("Q\n");
    Some(content)
}

/// The dash pattern of an annotation's border: `None` for a solid border, and
/// the outer `None` for a style the synthesis does not draw faithfully (beveled,
/// inset, underline and cloudy borders, or an invalid pattern). Refusing those
/// keeps print from showing a mark a stock reader would not draw.
fn border_dash(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
) -> Option<Option<Vec<f64>>> {
    if let Ok(effect) = annotation.get(b"BE") {
        let effect = document.resolved(effect).ok()?.as_dict().ok()?;
        if effect
            .get(b"S")
            .ok()
            .and_then(|style| document.resolved(style).ok()?.as_name().ok())
            == Some(b"C".as_slice())
        {
            return None;
        }
    }
    let dash = if let Ok(style) = annotation.get(b"BS") {
        let style = document.resolved(style).ok()?.as_dict().ok()?;
        let kind = match style.get(b"S") {
            Ok(kind) => document.resolved(kind).ok()?.as_name().ok()?,
            Err(_) => b"S".as_slice(),
        };
        match kind {
            b"S" => return Some(None),
            b"D" => match style.get(b"D") {
                Ok(pattern) => annotation_numbers(document, pattern)?,
                Err(_) => vec![3.0],
            },
            _ => return None,
        }
    } else {
        let Ok(border) = annotation.get(b"Border") else {
            return Some(None);
        };
        let border = document.resolved(border).ok()?.as_array().ok()?;
        match border.get(3) {
            Some(pattern) => annotation_numbers(document, pattern)?,
            None => return Some(None),
        }
    };
    let valid = !dash.is_empty()
        && dash.iter().all(|value| value.is_finite() && *value >= 0.0)
        && dash.iter().sum::<f64>() > 0.0;
    valid.then_some(Some(dash))
}

/// `/C` or `/IC`: `Some(None)` when absent or transparent (an empty array),
/// `None` when the colour is not one or three or four components in range.
fn annotation_colour(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    key: &[u8],
) -> Option<Option<Vec<f64>>> {
    let Ok(object) = annotation.get(key) else {
        return Some(None);
    };
    let components = annotation_numbers(document, object)?;
    if components.is_empty() {
        return Some(None);
    }
    let valid = matches!(components.len(), 1 | 3 | 4)
        && components.iter().all(|value| (0.0..=1.0).contains(value));
    valid.then_some(Some(components))
}

/// The colour operator for gray, RGB or CMYK components, stroking or filling.
fn colour_operands(components: &[f64], fill: bool) -> String {
    let operator = match (components.len(), fill) {
        (1, false) => "G",
        (1, true) => "g",
        (3, false) => "RG",
        (3, true) => "rg",
        (_, false) => "K",
        (_, true) => "k",
    };
    format!("{} {operator}", format_operands(components))
}

fn annotation_numbers(document: &impl PdfObjectSource, object: &Object) -> Option<Vec<f64>> {
    document
        .resolved(object)
        .ok()?
        .as_array()
        .ok()?
        .iter()
        .map(|value| object_to_f64(document.resolved(value).ok()?).ok())
        .collect()
}

/// `/L` for a Line (exactly two points) or `/Vertices` for a PolyLine or Polygon.
fn annotation_points(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    subtype: &[u8],
) -> Option<Vec<(f64, f64)>> {
    let key: &[u8] = if subtype == b"Line" {
        b"L"
    } else {
        b"Vertices"
    };
    let values = annotation_numbers(document, annotation.get(key).ok()?)?;
    let valid =
        values.len() % 2 == 0 && values.len() >= 4 && (subtype != b"Line" || values.len() == 4);
    valid.then(|| {
        values
            .chunks_exact(2)
            .map(|pair| (pair[0], pair[1]))
            .collect()
    })
}

/// Arrowheads from `/LE`: an open arrow is stroked, a closed arrow is filled
/// with /IC or, failing that, the stroke colour.
fn line_ending_appearance(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    points: &[(f64, f64)],
    width: f64,
    stroke: Option<&[f64]>,
    fill: Option<&[f64]>,
) -> Option<String> {
    let endings = annotation
        .get(b"LE")
        .ok()
        .and_then(|value| document.resolved(value).ok())
        .and_then(|value| value.as_array().ok());
    let ending = |index: usize| {
        endings
            .and_then(|values| values.get(index))
            .and_then(|value| document.resolved(value).ok())
            .and_then(|value| value.as_name().ok())
    };
    let (first, last) = (*points.first()?, *points.last()?);
    let mut content = String::new();
    for (style, tip, other) in [(ending(0), first, last), (ending(1), last, first)] {
        let Some(arms) = arrow_head_arms(tip, other, width) else {
            continue;
        };
        let [left, right] = arms;
        match style {
            Some(b"OpenArrow") => {
                if stroke.is_some() {
                    // Solid even on a dashed border: reset the dash, and use the round
                    // ends a solid border uses, not the butt ends a dash needs.
                    content.push_str(&format!(
                        "1 J [] 0 d\n{} {} m {} {} l {} {} l S\n",
                        left.0, left.1, tip.0, tip.1, right.0, right.1
                    ));
                }
            }
            Some(b"ClosedArrow") => {
                let Some(colour) = fill.or(stroke) else {
                    continue;
                };
                content.push_str(&format!(
                    "{}\n{} {} m {} {} l {} {} l h f\n",
                    colour_operands(colour, true),
                    left.0,
                    left.1,
                    tip.0,
                    tip.1,
                    right.0,
                    right.1
                ));
            }
            _ => {}
        }
    }
    Some(content)
}

/// Four Bézier curves approximating the ellipse inscribed in the given radii.
fn ellipse_path((cx, cy): (f64, f64), (rx, ry): (f64, f64)) -> String {
    const KAPPA: f64 = 0.552_284_75;
    let (kx, ky) = (rx * KAPPA, ry * KAPPA);
    format!(
        "{} {} m\n{} {} {} {} {} {} c\n{} {} {} {} {} {} c\n{} {} {} {} {} {} c\n{} {} {} {} {} {} c\nh\n",
        cx + rx, cy,
        cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry,
        cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy,
        cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry,
        cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy,
    )
}
