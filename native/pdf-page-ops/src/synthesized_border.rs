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
