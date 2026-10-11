//! Border style resolution for synthesized annotation appearances.

use super::*;

/// Missing, unknown, beveled and inset styles use a solid border. Empty dash
/// arrays are solid; invalid negative or all-zero patterns fall back to solid.
/// Cloud effects use a plain border, with the shape's RD applied by geometry.
pub(super) fn border_dash(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
) -> Option<Vec<f64>> {
    let cloud = annotation
        .get(b"BE")
        .ok()
        .and_then(|v| document.resolved(v).ok()?.as_dict().ok());
    if cloud.is_some_and(|effect| {
        effect
            .get(b"S")
            .ok()
            .and_then(|v| document.resolved(v).ok()?.as_name().ok())
            == Some(b"C".as_slice())
            && effect
                .get(b"I")
                .ok()
                .and_then(|v| object_to_f64(document.resolved(v).ok()?).ok())
                .unwrap_or(0.0)
                > 0.0
    }) {
        return None;
    }
    let dash = if let Ok(style) = annotation.get(b"BS") {
        let style = document.resolved(style).ok()?.as_dict().ok()?;
        if style
            .get(b"S")
            .ok()
            .and_then(|s| document.resolved(s).ok()?.as_name().ok())
            != Some(b"D".as_slice())
        {
            return None;
        }
        match style.get(b"D") {
            Ok(pattern) => annotation_numbers(document, pattern)?,
            Err(_) => vec![3.0],
        }
    } else {
        let border = document
            .resolved(annotation.get(b"Border").ok()?)
            .ok()?
            .as_array()
            .ok()?;
        annotation_numbers(document, border.get(3)?)?
    };
    (!dash.is_empty()
        && dash.iter().all(|v| v.is_finite() && *v >= 0.0)
        && dash.iter().any(|v| *v > 0.0))
    .then_some(dash)
}

pub(super) fn border_is_underlined(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
) -> bool {
    annotation
        .get(b"BS")
        .ok()
        .and_then(|s| document.resolved(s).ok()?.as_dict().ok())
        .and_then(|s| document.resolved(s.get(b"S").ok()?).ok()?.as_name().ok())
        == Some(b"U".as_slice())
}

/// RD is applied to the underlying shape before the stroke-width inset.
pub(crate) fn annotation_inner_rect(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
) -> Option<PdfRect> {
    let rect = read_shape_annotation_rect(document, annotation)?;
    let outer = PdfRect {
        x1: rect.x1.min(rect.x2),
        y1: rect.y1.min(rect.y2),
        x2: rect.x1.max(rect.x2),
        y2: rect.y1.max(rect.y2),
    };
    let rd = annotation
        .get(b"RD")
        .ok()
        .and_then(|v| annotation_numbers(document, v))
        .filter(|v| v.len() == 4 && v.iter().all(|n| n.is_finite() && *n >= 0.0));
    let Some(rd) = rd else {
        return Some(outer);
    };
    let inner = PdfRect {
        x1: outer.x1 + rd[0],
        y1: outer.y1 + rd[1],
        x2: outer.x2 - rd[2],
        y2: outer.y2 - rd[3],
    };
    Some(if inner.width() > 0.0 && inner.height() > 0.0 {
        inner
    } else {
        outer
    })
}

pub(super) fn rectangle_appearance(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    subtype: &[u8],
    width: f64,
    stroke: bool,
    fill: bool,
) -> Option<String> {
    let mut content = String::new();
    let rect = annotation_inner_rect(document, annotation)?;
    let inset = width / 2.0;
    let x1 = rect.x1.min(rect.x2) + inset;
    let y1 = rect.y1.min(rect.y2) + inset;
    let x2 = rect.x1.max(rect.x2) - inset;
    let y2 = rect.y1.max(rect.y2) - inset;
    let paint = match (stroke, fill) {
        (true, true) => "B",
        (true, false) => "S",
        (false, true) => "f",
        (false, false) => "n",
    };
    if border_is_underlined(document, annotation) {
        if fill {
            content.push_str(&format!("{x1} {y1} {} {} re f\n", x2 - x1, y2 - y1));
        }
        if stroke {
            content.push_str(&format!("{x1} {y1} m {x2} {y1} l S\n"));
        }
    } else if subtype == b"Square" {
        content.push_str(&format!("{x1} {y1} {} {} re {paint}\n", x2 - x1, y2 - y1));
    } else {
        let center = ((x1 + x2) / 2.0, (y1 + y2) / 2.0);
        content.push_str(&ellipse_path(center, ((x2 - x1) / 2.0, (y2 - y1) / 2.0)));
        content.push_str(&format!("{paint}\n"));
    }
    Some(content)
}

/// Four Bézier curves approximating the ellipse inscribed in the given radii.
pub(super) fn ellipse_path((cx, cy): (f64, f64), (rx, ry): (f64, f64)) -> String {
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
