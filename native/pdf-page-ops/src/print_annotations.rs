//! Flatten printable annotations into page content before sheet placement.

use super::*;

/// Resolve a usable normal appearance; synthesis handles missing or damaged AP.
fn normal_appearance(document: &mut Document, annotation: &Dictionary) -> Option<ObjectId> {
    let appearances = document
        .dereference(annotation.get(b"AP").ok()?)
        .ok()?
        .1
        .as_dict()
        .ok()?;
    let normal = appearances.get(b"N").ok()?;
    let (id, resolved) = document.dereference(normal).ok()?;
    let (id, stream) = if let Ok(stream) = resolved.as_stream() {
        (id, stream)
    } else {
        let state = document
            .dereference(annotation.get(b"AS").ok()?)
            .ok()?
            .1
            .as_name()
            .ok()?;
        let (id, value) = document
            .dereference(resolved.as_dict().ok()?.get(state).ok()?)
            .ok()?;
        (id, value.as_stream().ok()?)
    };
    if !stream.content.is_empty() {
        let bbox = numbers(document, stream.dict.get(b"BBox").ok()?, 4)?;
        if !bbox.iter().all(|v| v.is_finite()) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] {
            return None;
        }
        if let Ok(matrix) = stream.dict.get(b"Matrix") {
            let m = numbers(document, matrix, 6)?;
            if !m.iter().all(|v| v.is_finite()) || m[0] * m[3] - m[1] * m[2] == 0.0 {
                return None;
            }
        }
    }
    let stream = stream.clone();
    Some(id.unwrap_or_else(|| document.add_object(stream)))
}

/// Foreign FreeText without /AP uses the same parser, font admission and
/// shaped appearance as the text editor. Only the print document gets a Form;
/// the annotation's contents, identity, geometry and legacy status stay intact.
fn missing_free_text_appearance(
    document: &mut Document,
    annotation: &Dictionary,
    page_id: ObjectId,
    font_ref: &mut Option<ObjectId>,
) -> Result<ObjectId> {
    let page_view = resolve_page_view(document, page_id)?;
    let page_rotation = resolve_page_rotation(document, page_id)?;
    let parsed = parse_text_box_entry(
        document,
        annotation,
        (0, 0),
        0,
        page_view,
        page_rotation,
        "",
    )?;
    crate::text_box_font::validate_text(&parsed.text)?;
    let source = marker_rect_to_pdf_rect_unbounded(parsed.rect, page_view, page_rotation)?;
    let color = parse_css_rgb_color(Some(&parsed.color)).ok_or("Invalid FreeText print color")?;
    let editor = TextBoxMutation {
        page_index: 0,
        stable_key: String::new(),
        annotation_id: None,
        text: parsed.text,
        rect: [source.x1, source.y1, source.x2, source.y2],
        rotation: u16::try_from(parsed.rotation)?,
        font_size: parsed.font_size,
        color: [color.r, color.g, color.b],
        author: None,
        created_at: None,
        modified_at: None,
    };
    let rect =
        read_box(document, annotation, b"Rect")?.ok_or("Invalid FreeText print rectangle")?;
    let font_ref = *font_ref.get_or_insert_with(|| {
        crate::text_box_font::existing_font(document)
            .unwrap_or_else(|| crate::text_box_font::embed_font(document))
    });
    build_text_box_appearance(document, &editor, rect, font_ref, page_rotation)
}

fn annotation_graphics_state(
    document: &Document,
    annotation: &Dictionary,
    page_number: u32,
) -> Result<Option<Dictionary>> {
    let mut state = Dictionary::new();
    if let Ok(opacity) = annotation.get(b"CA") {
        let value = document.dereference(opacity)?.1;
        let opacity = object_to_f64(value)
            .ok()
            .filter(|value| (0.0..=1.0).contains(value));
        let Some(opacity) = opacity else {
            return Err(format!(
                "Printable annotation on page {page_number} has an invalid opacity"
            )
            .into());
        };
        state.set("ca", number_object(opacity));
        state.set("CA", number_object(opacity));
    }
    if let Ok(blend_mode) = annotation.get(b"BM") {
        let value = document.dereference(blend_mode)?.1.clone();
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
            return Err(format!(
                "Printable annotation on page {page_number} has an invalid blend mode"
            )
            .into());
        }
        state.set("BM", value);
    }
    if state.is_empty() {
        return Ok(None);
    }
    state.set("Type", Object::Name(b"ExtGState".to_vec()));
    Ok(Some(state))
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
/// describes. Popups and empty appearances draw nothing.
pub(super) fn flatten_printable_annotations(
    document: &mut Document,
    page: &Dictionary,
    page_id: ObjectId,
    page_number: u32,
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
    let mut text_font = None;
    let mut drew = false;
    for item in &annotations {
        let Ok(annotation) = document
            .dereference(item)
            .and_then(|(_, value)| value.as_dict())
        else {
            continue;
        };
        let annotation = annotation.clone();
        let flags = annotation_print_flags(document, &annotation);
        let printable = flags & ANNOTATION_FLAG_PRINT != 0
            && flags & (ANNOTATION_FLAG_INVISIBLE | ANNOTATION_FLAG_HIDDEN) == 0;
        let is_popup = annotation
            .get(b"Subtype")
            .and_then(Object::as_name)
            .is_ok_and(|subtype| subtype == b"Popup");
        if !printable || is_popup {
            continue;
        }
        let appearance = normal_appearance(document, &annotation)
            .or_else(|| {
                if annotation.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"FreeText") {
                    missing_free_text_appearance(document, &annotation, page_id, &mut text_font)
                        .ok()
                } else {
                    None
                }
            })
            .or_else(|| synthesized_appearance(document, &annotation));
        // An annotation with no drawable geometry cannot be placed. It does
        // not invalidate the page's content or another annotation's print.
        let Some(appearance_id) = appearance else {
            continue;
        };
        let appearance = document.get_object(appearance_id)?.as_stream()?;
        if appearance.content.is_empty() {
            continue;
        }
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
        xobjects.set(appearance_name.clone(), Object::Reference(appearance_id));
        let graphics_state =
            match annotation_graphics_state(document, &annotation, page_number).unwrap_or(None) {
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
