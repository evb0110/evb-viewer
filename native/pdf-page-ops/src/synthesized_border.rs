//! Border style resolution for synthesized annotation appearances.

use super::*;

/// The dash pattern of an annotation's border: `None` for a solid border, and
/// the outer `None` for a style the synthesis does not draw faithfully (beveled,
/// inset, underline and cloudy borders, or an invalid pattern). Refusing those
/// keeps print from showing a mark a stock reader would not draw.
pub(super) fn border_dash(
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
