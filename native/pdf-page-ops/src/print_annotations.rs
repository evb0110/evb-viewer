//! Flatten printable annotations into page content before sheet placement.

use super::*;

#[path = "print_appearances.rs"]
mod appearances;
use appearances::annotation_normal_appearance;
pub(super) use appearances::{materialize_print_appearances, write_print_appearances_path};

/// Printable, visible and not a popup: the annotations print draws.
fn is_printed(document: &Document, annotation: &Dictionary) -> bool {
    annotation_print_flags(document, annotation)
        & (ANNOTATION_FLAG_PRINT | ANNOTATION_FLAG_INVISIBLE | ANNOTATION_FLAG_HIDDEN)
        == ANNOTATION_FLAG_PRINT
        && annotation.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Popup")
}

/// The annotation's /CA and /BM as a graphics state; an invalid one is ignored.
fn annotation_graphics_state(document: &Document, annotation: &Dictionary) -> Option<Dictionary> {
    let mut state = Dictionary::new();
    if let Ok(opacity) = annotation.get(b"CA") {
        let opacity = object_to_f64(document.dereference(opacity).ok()?.1)
            .ok()
            .filter(|value| (0.0..=1.0).contains(value))?;
        state.set("ca", number_object(opacity));
        state.set("CA", number_object(opacity));
    }
    if let Ok(blend_mode) = annotation.get(b"BM") {
        let value = document.dereference(blend_mode).ok()?.1.clone();
        let valid = match &value {
            Object::Name(_) => true,
            Object::Array(items) => {
                !items.is_empty()
                    && items.iter().all(|item| {
                        document
                            .dereference(item)
                            .is_ok_and(|(_, item)| item.as_name().is_ok())
                    })
            }
            _ => false,
        };
        if !valid {
            return None;
        }
        state.set("BM", value);
    }
    if state.is_empty() {
        return None;
    }
    state.set("Type", Object::Name(b"ExtGState".to_vec()));
    Some(state)
}

fn resource_category(
    document: &Document,
    resources: &Dictionary,
    key: &[u8],
) -> Result<Dictionary> {
    resolved_dictionary(document, resources.get(key).ok())
}

/// Draws the normal appearance of every printable, visible annotation into
/// the page content, fitted to its /Rect as PDF 32000-1 section 12.5.5
/// describes. `materialize_print_appearances` has given each one it can draw
/// an appearance; popups and empty appearances draw nothing.
pub(super) fn flatten_printable_annotations(
    document: &mut Document,
    page: &Dictionary,
    resources: &mut Dictionary,
    content: &mut Vec<u8>,
) -> Result<()> {
    let Ok(annotations) = page.get(b"Annots") else {
        return Ok(());
    };
    let annotations = match document.dereference(annotations)?.1 {
        Object::Array(items) => items.clone(),
        _ => return Ok(()),
    };
    let mut xobjects = resource_category(document, resources, b"XObject")?;
    let mut graphics_states = resource_category(document, resources, b"ExtGState")?;
    let mut drew = false;
    for item in &annotations {
        let Ok(annotation) = document
            .dereference(item)
            .and_then(|(_, value)| value.as_dict())
        else {
            continue;
        };
        let annotation = annotation.clone();
        let Some(appearance) = annotation_normal_appearance(document, &annotation)
            .filter(|stream| !stream.content.is_empty() && is_printed(document, &annotation))
            .cloned()
        else {
            continue;
        };
        let Some(bbox) = appearance
            .dict
            .get(b"BBox")
            .ok()
            .and_then(|bbox| numbers(document, bbox, 4))
        else {
            continue;
        };
        let matrix = appearance
            .dict
            .get(b"Matrix")
            .ok()
            .and_then(|m| numbers(document, m, 6))
            .unwrap_or_else(|| vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        let Some(rect) = annotation
            .get(b"Rect")
            .ok()
            .and_then(|rect| numbers(document, rect, 4))
            .filter(|rect| {
                rect.iter().all(|v| v.is_finite()) && rect[2] > rect[0] && rect[3] > rect[1]
            })
        else {
            continue;
        };
        let corners = [
            (bbox[0], bbox[1]),
            (bbox[0], bbox[3]),
            (bbox[2], bbox[1]),
            (bbox[2], bbox[3]),
        ]
        .map(|(x, y)| {
            (
                matrix[0] * x + matrix[2] * y + matrix[4],
                matrix[1] * x + matrix[3] * y + matrix[5],
            )
        });
        let left = corners
            .iter()
            .map(|corner| corner.0)
            .fold(f64::MAX, f64::min);
        let bottom = corners
            .iter()
            .map(|corner| corner.1)
            .fold(f64::MAX, f64::min);
        let right = corners
            .iter()
            .map(|corner| corner.0)
            .fold(f64::MIN, f64::max);
        let top = corners
            .iter()
            .map(|corner| corner.1)
            .fold(f64::MIN, f64::max);
        let (width, height) = (right - left, top - bottom);
        if width.is_nan() || height.is_nan() || width <= 0.0 || height <= 0.0 {
            continue;
        }
        let rect_width = rect[2] - rect[0];
        let rect_height = rect[3] - rect[1];
        let scale_x = rect_width / width;
        let scale_y = rect_height / height;

        let appearance_name = unused_resource_name(&xobjects, "PrintAnnot");
        xobjects.set(appearance_name.clone(), document.add_object(appearance));
        let graphics_state = match annotation_graphics_state(document, &annotation) {
            Some(state) => {
                let name = unused_resource_name(&graphics_states, "PrintAnnot");
                graphics_states.set(name.clone(), document.add_object(state));
                format!("/{name} gs ")
            }
            None => String::new(),
        };
        content.extend(
            format!(
                "q {graphics_state}{} re W n {} cm /{appearance_name} Do Q\n",
                format_operands(&[rect[0], rect[1], rect_width, rect_height]),
                format_operands(&[
                    scale_x,
                    0.0,
                    0.0,
                    scale_y,
                    rect[0] - scale_x * left,
                    rect[1] - scale_y * bottom,
                ]),
            )
            .into_bytes(),
        );
        drew = true;
    }
    if drew {
        resources.set("XObject", Object::Dictionary(xobjects));
        if !graphics_states.is_empty() {
            resources.set("ExtGState", Object::Dictionary(graphics_states));
        }
    }
    Ok(())
}
