//! Standard endpoint decorations for synthesized Line and PolyLine appearances.

use super::*;

/// Arrowheads from `/LE`: an open arrow is stroked, a closed arrow is filled
/// with /IC or, failing that, the stroke colour.
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
                    content.push_str(&format!(
                        "{} {} m {} {} l {} {} l S\n",
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
