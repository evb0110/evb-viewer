use super::*;

/// The quad points of a text markup (highlight, underline, strike-out or
/// squiggly), or `None` for any other annotation. A quad is eight numbers, so
/// an array of any other length is malformed and is not trusted as coverage.
fn text_markup_quad_points(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
) -> Option<Vec<f64>> {
    let Ok(Object::Name(subtype)) = annotation.get(b"Subtype") else {
        return None;
    };
    if !matches!(
        subtype.as_slice(),
        b"Highlight" | b"Underline" | b"StrikeOut" | b"Squiggly"
    ) {
        return None;
    }
    numbers(document, annotation.get(b"QuadPoints").ok())
        .filter(|quads| !quads.is_empty() && quads.len() % 8 == 0)
}

fn numbers(document: &impl PdfObjectSource, object: Option<&Object>) -> Option<Vec<f64>> {
    let Object::Array(values) = document.resolved(object?).ok()? else {
        return None;
    };
    values
        .iter()
        .map(|value| {
            document
                .resolved(value)
                .ok()?
                .as_float()
                .ok()
                .map(f64::from)
        })
        .collect()
}

fn quad_bounds(quad: &[f64]) -> PdfRect {
    let (xs, ys) = (
        [quad[0], quad[2], quad[4], quad[6]],
        [quad[1], quad[3], quad[5], quad[7]],
    );
    let low = |values: [f64; 4]| values.iter().copied().fold(f64::INFINITY, f64::min);
    let high = |values: [f64; 4]| values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    PdfRect {
        x1: low(xs),
        y1: low(ys),
        x2: high(xs),
        y2: high(ys),
    }
}

/// The bounds a split admits an annotation by: its Rect, or for a text markup
/// without one, the bounds of its quads.
pub(crate) fn annotation_bounds(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
) -> Option<PdfRect> {
    read_pdf_rect_from_dict(document, annotation).or_else(|| {
        let quads = text_markup_quad_points(document, annotation)?;
        let coordinate = |axis: usize| quads.iter().skip(axis).step_by(2).copied();
        Some(PdfRect {
            x1: coordinate(0).fold(f64::INFINITY, f64::min),
            y1: coordinate(1).fold(f64::INFINITY, f64::min),
            x2: coordinate(0).fold(f64::NEG_INFINITY, f64::max),
            y2: coordinate(1).fold(f64::NEG_INFINITY, f64::max),
        })
    })
}

/// Whether a split moves an annotation's geometry: it has a Rect or quads, and
/// a Rect-less text markup still has its quads moved.
pub(crate) fn annotation_has_geometry(annotation: &Dictionary) -> bool {
    annotation.has(b"Rect") || annotation.has(b"QuadPoints")
}

/// Whether an annotation, mapped by `matrix`, keeps any area on `view`. A
/// reader edits a text markup by its quads, so the quads decide for it; any
/// other annotation is judged by its mapped `rect`.
pub(crate) fn annotation_meets_view(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    matrix: [f64; 6],
    rect: PdfRect,
    view: PdfRect,
) -> bool {
    let matrix = PdfMatrix::from_values(matrix);
    let Some(quads) = text_markup_quad_points(document, annotation) else {
        return intersect_rect(rect, view).is_some();
    };
    quads.chunks_exact(8).any(|quad| {
        intersect_rect(matrix.bounds(quad_bounds(quad)), view)
            .is_some_and(|area| area.x2 > area.x1 && area.y2 > area.y1)
    })
}

/// Clip a text-markup annotation to the output page it lands on. A quad is read
/// as its bounding box, so clamping each corner clips that box, and a quad with
/// no area left on the page is dropped. The Rect is clamped the same way, and
/// its appearance box follows it. `annotation_meets_view` admits only a markup
/// with a quad on the page.
pub(crate) fn clip_text_markup_to_view(
    target: &mut Document,
    annotation: &mut Dictionary,
    view: Option<PdfRect>,
) {
    let (Some(view), Some(quads)) = (view, text_markup_quad_points(target, annotation)) else {
        return;
    };
    let mut clipped = Vec::with_capacity(quads.len());
    for quad in quads.chunks_exact(8) {
        let xs = [quad[0], quad[2], quad[4], quad[6]].map(|x| x.clamp(view.x1, view.x2));
        let ys = [quad[1], quad[3], quad[5], quad[7]].map(|y| y.clamp(view.y1, view.y2));
        let points: Vec<f64> = xs.iter().zip(ys).flat_map(|(&x, y)| [x, y]).collect();
        let bounds = quad_bounds(&points);
        if bounds.x2 > bounds.x1 && bounds.y2 > bounds.y1 {
            clipped.extend(points);
        }
    }
    if clipped.is_empty() {
        return;
    }
    annotation.set(
        "QuadPoints",
        Object::Array(clipped.into_iter().map(number_object).collect()),
    );
    if let Some(rect) = numbers(target, annotation.get(b"Rect").ok()).filter(|rect| rect.len() == 4)
    {
        let clipped = PdfRect {
            x1: rect[0].clamp(view.x1, view.x2),
            y1: rect[1].clamp(view.y1, view.y2),
            x2: rect[2].clamp(view.x1, view.x2),
            y2: rect[3].clamp(view.y1, view.y2),
        };
        annotation.set("Rect", rect_object(clipped));
        if let Ok(appearance) = annotation.get(b"AP") {
            let appearance = appearance.clone();
            clip_appearance_bbox(target, &appearance, clipped);
        }
    }
}

/// Split appearance wrappers span their annotation's Rect, and a viewer fits
/// that BBox to the Rect. Moving the BBox with the clipped Rect keeps the fit at
/// scale one, so the painted marks stay where they were on the half they land on.
fn clip_appearance_bbox(target: &mut Document, appearance: &Object, rect: PdfRect) {
    match appearance {
        Object::Reference(id) => {
            if let Ok(Object::Stream(stream)) = target.get_object_mut(*id) {
                stream.dict.set("BBox", rect_object(rect));
            }
        }
        Object::Dictionary(states) => {
            for (_, state) in states.iter() {
                clip_appearance_bbox(target, state, rect);
            }
        }
        _ => {}
    }
}
