//! Standard endpoint decorations for synthesized Line and PolyLine appearances.

use super::*;

pub(super) fn line_ending_appearance(
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
        .and_then(|v| document.resolved(v).ok()?.as_array().ok());
    let style = |i| {
        endings
            .and_then(|e| e.get(i))
            .and_then(|v| document.resolved(v).ok()?.as_name().ok())
    };
    let first = *points.first()?;
    let last = *points.last()?;
    let first_segment = points.iter().copied().find(|p| *p != first);
    let last_segment = points.iter().rev().copied().find(|p| *p != last);
    let mut content = String::new();
    for (kind, tip, other) in [
        (style(0), first, first_segment),
        (style(1), last, last_segment),
    ] {
        let (ux, uy, size) = if let Some(other) = other {
            let (dx, dy) = (tip.0 - other.0, tip.1 - other.1);
            let length = dx.hypot(dy);
            (
                dx / length,
                dy / length,
                (6.0 * width).max(6.0).min(length * 0.4),
            )
        } else if matches!(kind, Some(b"Square" | b"Circle" | b"Diamond")) {
            // These endings need a size, not a line direction. Use a fixed
            // horizontal frame and center the geometry on coincident tips.
            (1.0, 0.0, (6.0 * width).max(6.0))
        } else {
            continue;
        };
        let radius = size / 2.0;
        let closed = matches!(
            kind,
            Some(b"Square" | b"Circle" | b"Diamond" | b"ClosedArrow" | b"RClosedArrow")
        );
        let interior = if closed { fill } else { None };
        let paint = match (stroke.is_some(), interior.is_some()) {
            (true, true) => "B",
            (true, false) => "S",
            (false, true) => "f",
            _ => "n",
        };
        let path = match kind {
            Some(b"Square") => format!("{} {} {} {} re\n", -size, -radius, size, size),
            Some(b"Circle") => ellipse_path((-radius, 0.0), (radius, radius)),
            Some(b"Diamond") => format!(
                "0 0 m {} {} l {} 0 l {} {} l h\n",
                -radius, radius, -size, -radius, -radius
            ),
            Some(b"OpenArrow" | b"ClosedArrow" | b"ROpenArrow" | b"RClosedArrow") => {
                let back = if matches!(kind, Some(b"ROpenArrow" | b"RClosedArrow")) {
                    size
                } else {
                    -size
                };
                let half = size / 3.0_f64.sqrt();
                format!(
                    "{back} {half} m 0 0 l {back} {} l {}\n",
                    -half,
                    if closed { "h" } else { "" }
                )
            }
            Some(b"Butt") => format!("0 {} m 0 {radius} l\n", -radius),
            Some(b"Slash") => format!(
                "{} {} m {} {} l\n",
                -radius / 2.0,
                -radius,
                radius / 2.0,
                radius
            ),
            _ => continue,
        };
        // Each decoration follows its adjacent segment. The orthonormal matrix
        // preserves width and the inherited dash; butt caps and miter joins
        // agree with Poppler's synthesized endpoint paths.
        content.push_str(&format!(
            "q 0 J 0 j {} cm\n",
            format_operands(&[
                ux,
                uy,
                -uy,
                ux,
                tip.0 + if other.is_none() { radius } else { 0.0 },
                tip.1
            ])
        ));
        if let Some(interior) = interior {
            content.push_str(&format!("{}\n", colour_operands(interior, true)));
        }
        content.push_str(&format!("{path}{paint}\nQ\n"));
    }
    Some(content)
}

/// `/L` for a Line (exactly two points) or `/Vertices` for a PolyLine or Polygon.
pub(super) fn annotation_points(
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

/// Native synthesis stays in page space, including decorations beyond /Rect.
pub(super) fn line_print_rect(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    subtype: &[u8],
) -> Option<PdfRect> {
    let mut rect = read_shape_annotation_rect(document, annotation)?;
    let width = shape_stroke_width(document, annotation)
        .filter(|w| w.is_finite() && *w >= 0.0)
        .unwrap_or(1.0);
    let padding = 7.0 * width.max(1.0);
    for (x, y) in annotation_points(document, annotation, subtype)? {
        rect.x1 = rect.x1.min(x - padding);
        rect.y1 = rect.y1.min(y - padding);
        rect.x2 = rect.x2.max(x + padding);
        rect.y2 = rect.y2.max(y + padding);
    }
    Some(rect)
}

/// Closed geometric endings replace the body beneath their hollow interiors.
pub(super) fn line_body_path(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    points: &[(f64, f64)],
    width: f64,
) -> Option<String> {
    let mut body = points.to_vec();
    body.dedup();
    if body.len() < 2 {
        return pdf_polyline_path(points);
    }
    let vertices = body.clone();
    let endings = annotation
        .get(b"LE")
        .ok()
        .and_then(|v| document.resolved(v).ok()?.as_array().ok());
    for (style, index, adjacent) in [
        (0, 0, 1),
        (1, body.len().checked_sub(1)?, body.len().checked_sub(2)?),
    ] {
        let kind = endings
            .and_then(|e| e.get(style))
            .and_then(|v| document.resolved(v).ok()?.as_name().ok());
        if matches!(kind, Some(b"Square" | b"Circle" | b"Diamond")) {
            let tip = vertices[index];
            let other = vertices[adjacent];
            let length = (tip.0 - other.0).hypot(tip.1 - other.1);
            let size = (6.0 * width).max(6.0).min(length * 0.4);
            body[index] = (
                tip.0 + (other.0 - tip.0) * size / length,
                tip.1 + (other.1 - tip.1) * size / length,
            );
        }
    }
    pdf_polyline_path(&body)
}
