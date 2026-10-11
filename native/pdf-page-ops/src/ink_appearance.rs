//! Ink geometry and its saved and synthesized appearance paths.

use super::*;

pub(crate) fn shape_ink_strokes(shape: &ShapeAnnotation) -> Vec<&[ShapePoint]> {
    if shape.strokes.is_empty() {
        vec![shape.points.as_slice()]
    } else {
        shape.strokes.iter().map(Vec::as_slice).collect()
    }
}

pub(crate) fn set_ink_shape_fields(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<()> {
    let mut all_points = Vec::new();
    let mut ink_list = Vec::new();
    for stroke in shape_ink_strokes(shape) {
        let pdf_points = shape_points_to_pdf_points(stroke, page_view, page_rotation);
        all_points.extend(pdf_points.iter().copied());
        ink_list.push(flat_pdf_points_object(&pdf_points));
    }
    let rect = pdf_points_bounds(&all_points, shape.stroke_width)?;
    dict.set("Rect", rect_object(rect));
    dict.set("InkList", Object::Array(ink_list));
    set_shape_style(dict, shape);
    dict.remove(b"LE");
    dict.remove(b"IC");
    Ok(())
}

pub(crate) fn build_ink_shape_appearance_stream(
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<Stream> {
    let color = parse_pdf_color(Some(&shape.color)).ok_or("Invalid Ink appearance color")?;
    let mut all_points = Vec::new();
    let mut stroke_points = Vec::new();
    for stroke in shape_ink_strokes(shape) {
        let points = shape_points_to_pdf_points(stroke, page_view, page_rotation);
        all_points.extend(points.iter().copied());
        stroke_points.push(points);
    }
    let rect = pdf_points_bounds(&all_points, shape.stroke_width)?;

    let mut content = String::new();
    content.push_str("q\n/GS0 gs\n");
    content.push_str(&format!(
        "{} {} {} RG\n{} w\n1 J\n1 j\n",
        number_to_content(color[0]),
        number_to_content(color[1]),
        number_to_content(color[2]),
        number_to_content(shape.stroke_width),
    ));
    let paths = stroke_points
        .iter()
        .filter_map(|points| pdf_polyline_path(points))
        .collect::<String>();
    if paths.is_empty() {
        return Err("Ink appearance has no drawable path".into());
    }
    content.push_str(&paths);
    content.push_str("S\nQ\n");

    let mut graphics_state = Dictionary::new();
    graphics_state.set("Type", Object::Name(b"ExtGState".to_vec()));
    graphics_state.set("CA", number_object(shape.opacity.clamp(0.0, 1.0)));
    graphics_state.set("ca", number_object(shape.opacity.clamp(0.0, 1.0)));
    let mut graphics_states = Dictionary::new();
    graphics_states.set("GS0", Object::Dictionary(graphics_state));
    let mut resources = Dictionary::new();
    resources.set("ExtGState", Object::Dictionary(graphics_states));

    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Form".to_vec()));
    dict.set("BBox", rect_object(rect));
    dict.set(
        "Matrix",
        Object::Array(vec![
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
            Object::Integer(1),
            Object::Integer(0),
            Object::Integer(0),
        ]),
    );
    dict.set("Resources", Object::Dictionary(resources));
    Ok(Stream::new(dict, content.into_bytes()))
}

/// Shared path painter for saved Ink, foreign Ink and vertex annotations.
pub(crate) fn pdf_polyline_path(points: &[(f64, f64)]) -> Option<String> {
    if points.len() < 2 {
        return None;
    }
    let mut path = format!(
        "{} {} m\n",
        number_to_content(points[0].0),
        number_to_content(points[0].1)
    );
    for point in &points[1..] {
        path.push_str(&format!(
            "{} {} l\n",
            number_to_content(point.0),
            number_to_content(point.1)
        ));
    }
    Some(path)
}
