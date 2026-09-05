use super::*;

pub(crate) fn normalize_managed_shape_stable_key(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    (!trimmed.is_empty()).then_some(trimmed.to_string())
}

pub(crate) fn read_managed_shape_stable_key(dict: &Dictionary) -> Option<String> {
    dict.get(b"EVBShapeKey")
        .ok()
        .and_then(pdf_string_to_text)
        .and_then(|value| normalize_managed_shape_stable_key(Some(&value)))
}

/// Reads the key used to correlate an embedded shape across imports. EVB's
/// private key wins, while `/NM` remains a compatible fallback for files that
/// have no private key but carry the same managed-shape value there.
pub(crate) fn read_shape_stable_key(dict: &Dictionary) -> Option<String> {
    read_managed_shape_stable_key(dict).or_else(|| {
        dict.get(b"NM")
            .ok()
            .and_then(pdf_string_to_text)
            .and_then(|value| normalize_managed_shape_stable_key(Some(&value)))
    })
}

pub(crate) fn write_managed_shape_stable_key(
    dict: &mut Dictionary,
    stable_key: Option<&str>,
) -> bool {
    let Some(stable_key) = normalize_managed_shape_stable_key(stable_key) else {
        return false;
    };
    let mut modified = false;
    if read_annotation_name(dict).is_none() {
        write_annotation_name(dict, &stable_key);
        modified = true;
    }
    if stable_key.starts_with("evb-shape:")
        && read_managed_shape_stable_key(dict).as_deref() != Some(stable_key.as_str())
    {
        dict.set(
            "EVBShapeKey",
            Object::String(
                encode_pdf_text_string(&stable_key),
                StringFormat::Hexadecimal,
            ),
        );
        modified = true;
    }
    modified
}

pub(crate) fn format_pdfjs_annotation_ref(object_id: ObjectId) -> String {
    if object_id.1 == 0 {
        format!("{}R", object_id.0)
    } else {
        format!("{}R{}", object_id.0, object_id.1)
    }
}

pub(crate) fn normalize_pdfjs_annotation_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let (object, generation) = trimmed.split_once('R')?;
    if object.is_empty() || !object.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let object_number = object.parse::<u32>().ok()?;
    if object_number == 0 {
        return None;
    }
    if generation.is_empty() {
        return Some(format!("{object_number}R"));
    }
    if !generation
        .chars()
        .all(|character| character.is_ascii_digit())
    {
        return None;
    }
    let generation_number = generation.parse::<u16>().ok()?;
    if generation_number == 0 {
        Some(format!("{object_number}R"))
    } else {
        Some(format!("{object_number}R{generation_number}"))
    }
}

pub(crate) fn shape_annotation_subtype_for_create(shape: &ShapeAnnotation) -> Option<&'static str> {
    match shape.shape_type.as_str() {
        "rectangle" => Some("Square"),
        "circle" => Some("Circle"),
        "line" | "arrow" => Some("Line"),
        "polyline" if shape.pdf_subtype.as_deref() == Some("Ink") => Some("Ink"),
        "polyline" => Some("PolyLine"),
        "polygon" => Some("Polygon"),
        _ => None,
    }
}

pub(crate) fn is_supported_shape_subtype(subtype: &str) -> bool {
    matches!(
        subtype,
        "square" | "circle" | "line" | "polyline" | "polygon" | "ink"
    )
}

pub(crate) fn timestamp_millis_to_pdf_date_utc(timestamp_millis: u64) -> String {
    let seconds = (timestamp_millis / 1_000).min(i64::MAX as u64) as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_unix_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("D:{year:04}{month:02}{day:02}{hour:02}{minute:02}{second:02}Z")
}

pub(crate) fn civil_from_unix_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

pub(crate) fn shape_pdf_date(timestamp: Option<u64>, fallback: &str) -> String {
    timestamp
        .filter(|value| *value > 0)
        .map(timestamp_millis_to_pdf_date_utc)
        .unwrap_or_else(|| fallback.to_string())
}

pub(crate) fn set_shape_dates(dict: &mut Dictionary, shape: &ShapeAnnotation, modified_at: &str) {
    let created = shape_pdf_date(shape.created_at.or(shape.modified_at), modified_at);
    let modified = shape_pdf_date(shape.modified_at, &created);
    dict.set("CreationDate", Object::string_literal(created.into_bytes()));
    dict.set("M", Object::string_literal(modified.into_bytes()));
}

pub(crate) fn set_shape_style(dict: &mut Dictionary, shape: &ShapeAnnotation) {
    set_rgb_color(dict, "C", Some(&shape.color));
    dict.set("CA", number_object(shape.opacity));
    dict.set(
        "Border",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            number_object(shape.stroke_width),
        ]),
    );
}

pub(crate) fn shape_line_ending_name(style: Option<&str>) -> Object {
    match style {
        Some("openArrow") => Object::Name(b"OpenArrow".to_vec()),
        Some("closedArrow") => Object::Name(b"ClosedArrow".to_vec()),
        _ => Object::Name(b"None".to_vec()),
    }
}

pub(crate) fn set_shape_line_endings(dict: &mut Dictionary, shape: &ShapeAnnotation) {
    let start = shape.line_start_style.as_deref().unwrap_or("none");
    let end = shape.line_end_style.as_deref().unwrap_or("none");
    if start == "none" && end == "none" {
        dict.remove(b"LE");
        return;
    }
    dict.set(
        "LE",
        Object::Array(vec![
            shape_line_ending_name(Some(start)),
            shape_line_ending_name(Some(end)),
        ]),
    );
}

pub(crate) fn shape_rect_from_bounds(
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<PdfRect> {
    marker_rect_to_pdf_rect(
        MarkerRect {
            left,
            top,
            width,
            height,
        },
        page_view,
        page_rotation,
    )
}

pub(crate) fn shape_pdf_point(
    point: &ShapePoint,
    page_view: PdfRect,
    page_rotation: i64,
) -> (f64, f64) {
    pdf_point_from_marker_point(point.x, point.y, page_view, page_rotation)
}

pub(crate) fn shape_points_to_pdf_points(
    points: &[ShapePoint],
    page_view: PdfRect,
    page_rotation: i64,
) -> Vec<(f64, f64)> {
    points
        .iter()
        .map(|point| shape_pdf_point(point, page_view, page_rotation))
        .collect()
}

pub(crate) fn pdf_points_bounds(points: &[(f64, f64)], stroke_width: f64) -> Result<PdfRect> {
    if points.is_empty() {
        return Err("Shape has no PDF points".into());
    }
    let min_x = points
        .iter()
        .map(|point| point.0)
        .fold(f64::INFINITY, f64::min);
    let min_y = points
        .iter()
        .map(|point| point.1)
        .fold(f64::INFINITY, f64::min);
    let max_x = points
        .iter()
        .map(|point| point.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = points
        .iter()
        .map(|point| point.1)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut rect = PdfRect {
        x1: min_x - stroke_width,
        y1: min_y - stroke_width,
        x2: max_x + stroke_width,
        y2: max_y + stroke_width,
    };
    if rect.width() <= 0.0 {
        rect.x1 -= 0.0001;
        rect.x2 += 0.0001;
    }
    if rect.height() <= 0.0 {
        rect.y1 -= 0.0001;
        rect.y2 += 0.0001;
    }
    Ok(rect)
}

pub(crate) fn flat_pdf_points_object(points: &[(f64, f64)]) -> Object {
    Object::Array(
        points
            .iter()
            .flat_map(|point| [number_object(point.0), number_object(point.1)])
            .collect(),
    )
}

/// Reads `/Rect` through the document so an indirect array — or indirect
/// numbers inside it — still resolves; corner order is left to the caller,
/// which normalizes. A dict read straight from `Dictionary::get` would see the
/// reference object instead and silently report no rect at all.
pub(crate) fn read_shape_annotation_rect(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
) -> Option<PdfRect> {
    let object = dict.get(b"Rect").ok()?;
    let values = document.resolved(object).ok()?.as_array().ok()?;
    if values.len() != 4 {
        return None;
    }
    let rect = PdfRect {
        x1: object_to_f64(document.resolved(&values[0]).ok()?).ok()?,
        y1: object_to_f64(document.resolved(&values[1]).ok()?).ok()?,
        x2: object_to_f64(document.resolved(&values[2]).ok()?).ok()?,
        y2: object_to_f64(document.resolved(&values[3]).ok()?).ok()?,
    };
    (rect.width().is_finite() && rect.height().is_finite()).then_some(rect)
}

/// Marker geometry is clamped into the unit page box on import because the
/// overlay renders in that space, so a rect crossing a page edge cannot be
/// rebuilt from it. A shape counts as untouched when replaying that projection
/// over the rect the annotation already carries reproduces its marker geometry;
/// then the file's own rect is what must survive the save.
///
/// The rect is read at the document boundary and passed in, because the caller
/// holds the dictionary mutably by the time the fields are written.
pub(crate) fn is_imported_shape_rect_unchanged(
    existing_rect: Option<PdfRect>,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
) -> bool {
    let Some(existing_rect) = existing_rect else {
        return false;
    };
    let Some(imported) = marker_rect_from_pdf_rect(existing_rect, page_view, page_rotation) else {
        return false;
    };
    const EPSILON: f64 = 1e-9;
    (imported.left - shape.x).abs() <= EPSILON
        && (imported.top - shape.y).abs() <= EPSILON
        && (imported.width - shape.width).abs() <= EPSILON
        && (imported.height - shape.height).abs() <= EPSILON
}

const SHAPE_SEMANTIC_NUMBER_EPSILON: f64 = 0.0001;

fn equivalent_pdf_objects(
    document: &impl PdfObjectSource,
    left: &Object,
    right: &Object,
) -> Result<bool> {
    let left = document.resolved(left)?;
    let right = document.resolved(right)?;
    match (left, right) {
        (Object::Integer(left), Object::Integer(right)) => Ok(left == right),
        (Object::Integer(left), Object::Real(right))
        | (Object::Real(right), Object::Integer(left)) => {
            Ok((*left as f64 - f64::from(*right)).abs() <= SHAPE_SEMANTIC_NUMBER_EPSILON)
        }
        (Object::Real(left), Object::Real(right)) => {
            Ok((f64::from(*left) - f64::from(*right)).abs() <= SHAPE_SEMANTIC_NUMBER_EPSILON)
        }
        (Object::Name(left), Object::Name(right)) => Ok(left == right),
        (Object::String(left, left_format), Object::String(right, right_format)) => {
            Ok(left == right && left_format == right_format)
        }
        (Object::Null, Object::Null) => Ok(true),
        (Object::Array(left), Object::Array(right)) => {
            if left.len() != right.len() {
                return Ok(false);
            }
            left.iter()
                .zip(right)
                .try_fold(true, |same, (left, right)| {
                    Ok(same && equivalent_pdf_objects(document, left, right)?)
                })
        }
        (left, right) => Ok(left == right),
    }
}

fn equivalent_shape_field(
    document: &impl PdfObjectSource,
    before: &Dictionary,
    after: &Dictionary,
    key: &[u8],
) -> Result<bool> {
    match (before.get(key), after.get(key)) {
        (Ok(before), Ok(after)) => equivalent_pdf_objects(document, before, after),
        (Err(_), Err(_)) => Ok(true),
        _ => Ok(false),
    }
}

fn shape_stroke_width(document: &impl PdfObjectSource, dict: &Dictionary) -> Option<f64> {
    if let Ok(border) = dict.get(b"Border") {
        if let Some(values) = document
            .resolved(border)
            .ok()
            .and_then(|value| value.as_array().ok())
        {
            if let Some(width) = values
                .get(2)
                .and_then(|value| document.resolved(value).ok())
                .and_then(|value| object_to_f64(value).ok())
            {
                return Some(width);
            }
        }
    }
    let border_style = dict.get(b"BS").ok()?.clone();
    let border_style = document.resolved(&border_style).ok()?.as_dict().ok()?;
    let width = border_style.get(b"W").ok()?;
    object_to_f64(document.resolved(width).ok()?).ok()
}

fn shape_semantic_change(
    document: &impl PdfObjectSource,
    dict: &Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
    existing_rect: Option<PdfRect>,
) -> Result<bool> {
    let subtype = annotation_subtype(dict);
    if subtype == "ink" {
        return Ok(false);
    }

    // Project the requested fields into a detached dictionary. This reuses
    // the same geometry/style normalization as the actual write, including
    // the off-page rectangle preservation rule. Dates and identity fields are
    // intentionally ignored below because they do not affect the appearance.
    let mut projected = dict.clone();
    match subtype.as_str() {
        "square" | "circle" => {
            set_rect_shape_fields(
                &mut projected,
                shape,
                page_view,
                page_rotation,
                existing_rect,
            )?;
        }
        "line" => set_line_shape_fields(&mut projected, shape, page_view, page_rotation)?,
        "polyline" => {
            set_vertex_shape_fields(&mut projected, shape, page_view, page_rotation, false)?;
        }
        "polygon" => {
            set_vertex_shape_fields(&mut projected, shape, page_view, page_rotation, true)?;
        }
        _ => return Ok(true),
    }

    let keys: &[&[u8]] = match subtype.as_str() {
        "square" | "circle" => &[b"Rect", b"C", b"IC", b"CA"],
        "line" => &[b"Rect", b"L", b"C", b"CA", b"LE"],
        "polyline" => &[b"Rect", b"Vertices", b"C", b"CA", b"LE"],
        "polygon" => &[b"Rect", b"Vertices", b"C", b"IC", b"CA"],
        _ => return Ok(true),
    };
    for key in keys {
        if !equivalent_shape_field(document, dict, &projected, key)? {
            return Ok(true);
        }
    }
    let requested_width = shape.stroke_width;
    let existing_width = shape_stroke_width(document, dict).unwrap_or(1.0);
    Ok((existing_width - requested_width).abs() > SHAPE_SEMANTIC_NUMBER_EPSILON)
}

pub(crate) fn set_rect_shape_fields(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
    existing_rect: Option<PdfRect>,
) -> Result<()> {
    if !is_imported_shape_rect_unchanged(existing_rect, shape, page_view, page_rotation) {
        let rect = shape_rect_from_bounds(
            shape.x,
            shape.y,
            shape.width,
            shape.height,
            page_view,
            page_rotation,
        )?;
        dict.set("Rect", rect_object(rect));
    }
    set_shape_style(dict, shape);
    set_rgb_color(dict, "IC", shape.fill_color.as_deref());
    Ok(())
}

pub(crate) fn set_line_shape_fields(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<()> {
    let end = ShapePoint {
        x: shape.x2.ok_or("Line shape is missing x2")?,
        y: shape.y2.ok_or("Line shape is missing y2")?,
    };
    let points = vec![
        pdf_point_from_marker_point(shape.x, shape.y, page_view, page_rotation),
        shape_pdf_point(&end, page_view, page_rotation),
    ];
    let rect = pdf_points_bounds(&points, shape.stroke_width)?;
    dict.set("Rect", rect_object(rect));
    dict.set("L", flat_pdf_points_object(&points));
    set_shape_style(dict, shape);
    set_shape_line_endings(dict, shape);
    // A Line has no interior. Producers still leave /IC behind, and a viewer
    // that honours it paints a fill the shape never had.
    dict.remove(b"IC");
    Ok(())
}

pub(crate) fn set_vertex_shape_fields(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
    is_polygon: bool,
) -> Result<()> {
    let points = shape_points_to_pdf_points(&shape.points, page_view, page_rotation);
    let rect = pdf_points_bounds(&points, shape.stroke_width)?;
    dict.set("Rect", rect_object(rect));
    dict.set("Vertices", flat_pdf_points_object(&points));
    set_shape_style(dict, shape);
    if is_polygon {
        dict.remove(b"LE");
        set_rgb_color(dict, "IC", shape.fill_color.as_deref());
    } else {
        set_shape_line_endings(dict, shape);
        dict.remove(b"IC");
    }
    Ok(())
}

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
    let mut has_path = false;
    for points in stroke_points {
        let Some(first) = points.first() else {
            continue;
        };
        if points.len() < 2 {
            continue;
        }
        content.push_str(&format!(
            "{} {} m\n",
            number_to_content(first.0),
            number_to_content(first.1),
        ));
        for point in points.iter().skip(1) {
            content.push_str(&format!(
                "{} {} l\n",
                number_to_content(point.0),
                number_to_content(point.1),
            ));
        }
        has_path = true;
    }
    if !has_path {
        return Err("Ink appearance has no drawable path".into());
    }
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

pub(crate) fn attach_ink_shape_appearance(dict: &mut Dictionary, appearance_ref: ObjectId) {
    let mut appearance = Dictionary::new();
    appearance.set("N", Object::Reference(appearance_ref));
    dict.set("AP", Object::Dictionary(appearance));
    let flags = dict
        .get(b"F")
        .ok()
        .and_then(|value| value.as_i64().ok())
        .unwrap_or(0);
    dict.set("F", Object::Integer(flags | 4));
}

/// `existing_rect` is the annotation's own `/Rect`, resolved through the
/// document the caller still owns; `None` for a dict that carries no readable
/// rect and for the create route, where there is nothing to preserve.
pub(crate) fn update_shape_annotation_dict(
    dict: &mut Dictionary,
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
    modified_at: &str,
    existing_rect: Option<PdfRect>,
    remove_appearance: bool,
) -> Result<bool> {
    let subtype = annotation_subtype(dict);
    if !is_supported_shape_subtype(&subtype) {
        return Ok(false);
    }
    match subtype.as_str() {
        "square" | "circle" => {
            set_rect_shape_fields(dict, shape, page_view, page_rotation, existing_rect)?
        }
        "line" => set_line_shape_fields(dict, shape, page_view, page_rotation)?,
        "polyline" => set_vertex_shape_fields(dict, shape, page_view, page_rotation, false)?,
        "polygon" => set_vertex_shape_fields(dict, shape, page_view, page_rotation, true)?,
        "ink" => set_ink_shape_fields(dict, shape, page_view, page_rotation)?,
        _ => return Ok(false),
    }
    if subtype != "ink" && remove_appearance {
        // The semantic shape fields above are the source of truth after an
        // edit. An imported normal appearance describes the old geometry or
        // style, so keeping it would make readers draw stale pixels.
        dict.remove(b"AP");
    }
    set_shape_dates(dict, shape, modified_at);
    write_managed_shape_stable_key(dict, shape.stable_key.as_deref());
    Ok(true)
}

pub(crate) fn create_shape_annotation_dict(
    shape: &ShapeAnnotation,
    page_view: PdfRect,
    page_rotation: i64,
    modified_at: &str,
) -> Result<Dictionary> {
    let subtype = shape_annotation_subtype_for_create(shape).ok_or("Invalid shape subtype")?;
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Annot".to_vec()));
    dict.set("Subtype", Object::Name(subtype.as_bytes().to_vec()));
    match subtype {
        "Square" | "Circle" => {
            set_rect_shape_fields(&mut dict, shape, page_view, page_rotation, None)?
        }
        "Line" => set_line_shape_fields(&mut dict, shape, page_view, page_rotation)?,
        "PolyLine" => set_vertex_shape_fields(&mut dict, shape, page_view, page_rotation, false)?,
        "Polygon" => set_vertex_shape_fields(&mut dict, shape, page_view, page_rotation, true)?,
        "Ink" => set_ink_shape_fields(&mut dict, shape, page_view, page_rotation)?,
        _ => return Err("Invalid shape subtype".into()),
    }
    set_shape_dates(&mut dict, shape, modified_at);
    write_managed_shape_stable_key(&mut dict, shape.stable_key.as_deref());
    Ok(dict)
}

pub(crate) struct ShapeConsumptionState<'a> {
    pub(crate) shapes: &'a [ShapeAnnotation],
    pub(crate) consumed: Vec<bool>,
    pub(crate) by_annotation_id: HashMap<String, usize>,
    pub(crate) by_stable_key: HashMap<String, usize>,
}

impl<'a> ShapeConsumptionState<'a> {
    pub(crate) fn new(shapes: &'a [ShapeAnnotation]) -> Self {
        let mut state = Self {
            shapes,
            consumed: vec![false; shapes.len()],
            by_annotation_id: HashMap::new(),
            by_stable_key: HashMap::new(),
        };
        for (index, shape) in shapes.iter().enumerate() {
            if let Some(annotation_id) = shape
                .annotation_id
                .as_deref()
                .and_then(normalize_pdfjs_annotation_id)
            {
                state.by_annotation_id.insert(annotation_id, index);
            }
            if let Some(stable_key) =
                normalize_managed_shape_stable_key(shape.stable_key.as_deref())
            {
                state.by_stable_key.insert(stable_key, index);
            }
        }
        state
    }

    pub(crate) fn find_by_annotation_id(&self, annotation_id: &str) -> Option<usize> {
        self.by_annotation_id
            .get(annotation_id)
            .copied()
            .filter(|index| !self.consumed[*index])
    }

    pub(crate) fn find_by_stable_key(&self, stable_key: &str) -> Option<usize> {
        self.by_stable_key
            .get(stable_key)
            .copied()
            .filter(|index| !self.consumed[*index])
    }

    pub(crate) fn consume(&mut self, index: usize) {
        if index < self.consumed.len() {
            self.consumed[index] = true;
        }
    }

    pub(crate) fn remaining(&self) -> impl Iterator<Item = &ShapeAnnotation> {
        self.shapes
            .iter()
            .enumerate()
            .filter_map(|(index, shape)| (!self.consumed[index]).then_some(shape))
    }
}

pub(crate) struct DeletedShapeRefs {
    pub(crate) annotation_ids: HashSet<String>,
    pub(crate) stable_keys: HashSet<String>,
}

pub(crate) fn collect_deleted_shape_refs(shapes: &ShapesMutation) -> DeletedShapeRefs {
    DeletedShapeRefs {
        annotation_ids: shapes
            .deleted_annotation_ids
            .iter()
            .filter_map(|value| normalize_pdfjs_annotation_id(value))
            .collect(),
        stable_keys: shapes
            .deleted_stable_keys
            .iter()
            .filter_map(|value| normalize_managed_shape_stable_key(Some(value)))
            .collect(),
    }
}

pub(crate) fn collect_shape_annotation_refs_to_delete(
    document: &Document,
    refs_to_delete: &mut HashSet<ObjectId>,
    object_id: ObjectId,
    page_annots_hint: Option<&[Object]>,
) -> Result<()> {
    for delete_ref in collect_annotation_refs_to_delete(document, object_id, page_annots_hint)? {
        refs_to_delete.insert(delete_ref);
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) struct ShapePageContext {
    page_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
}

pub(crate) fn apply_shape_annotation_decision(
    document: &mut Document,
    state: &mut ShapeConsumptionState,
    deleted_refs: &DeletedShapeRefs,
    refs_to_delete: &mut HashSet<ObjectId>,
    rewrite_shape_state: bool,
    page: ShapePageContext,
    page_annots: &[Object],
    object_id: ObjectId,
    modified_at: &str,
) -> Result<bool> {
    let (annotation_stable_key, annotation_id, subtype) = {
        let dict = match document.get_dictionary(object_id) {
            Ok(dict) => dict,
            Err(_) => return Ok(false),
        };
        (
            read_shape_stable_key(dict),
            format_pdfjs_annotation_ref(object_id),
            annotation_subtype(dict),
        )
    };
    if !is_supported_shape_subtype(&subtype) {
        return Ok(false);
    }
    if deleted_refs.annotation_ids.contains(&annotation_id)
        || annotation_stable_key
            .as_deref()
            .is_some_and(|stable_key| deleted_refs.stable_keys.contains(stable_key))
    {
        collect_shape_annotation_refs_to_delete(
            document,
            refs_to_delete,
            object_id,
            Some(page_annots),
        )?;
        return Ok(true);
    }
    if let Some(stable_key) = annotation_stable_key.as_deref() {
        if let Some(index) = state.find_by_stable_key(stable_key) {
            let shape = state.shapes[index].clone();
            let appearance_ref = if subtype == "ink" {
                let appearance =
                    build_ink_shape_appearance_stream(&shape, page.page_view, page.page_rotation)?;
                Some(document.add_object(appearance))
            } else {
                None
            };
            let existing_rect = document
                .get_dictionary(object_id)
                .ok()
                .and_then(|dict| read_shape_annotation_rect(&*document, dict));
            let remove_appearance = subtype != "ink"
                && shape_semantic_change(
                    &*document,
                    document.get_dictionary(object_id)?,
                    &shape,
                    page.page_view,
                    page.page_rotation,
                    existing_rect,
                )?;
            let dict = document.get_dictionary_mut(object_id)?;
            let modified = update_shape_annotation_dict(
                dict,
                &shape,
                page.page_view,
                page.page_rotation,
                modified_at,
                existing_rect,
                remove_appearance,
            )?;
            dict.set("P", Object::Reference(page.page_id));
            if let Some(appearance_ref) = appearance_ref {
                attach_ink_shape_appearance(dict, appearance_ref);
            }
            state.consume(index);
            return Ok(modified);
        }
        if rewrite_shape_state {
            collect_shape_annotation_refs_to_delete(
                document,
                refs_to_delete,
                object_id,
                Some(page_annots),
            )?;
            return Ok(true);
        }
        return Ok(false);
    }
    if let Some(index) = state.find_by_annotation_id(&annotation_id) {
        let shape = state.shapes[index].clone();
        let appearance_ref = if subtype == "ink" {
            let appearance =
                build_ink_shape_appearance_stream(&shape, page.page_view, page.page_rotation)?;
            Some(document.add_object(appearance))
        } else {
            None
        };
        let existing_rect = document
            .get_dictionary(object_id)
            .ok()
            .and_then(|dict| read_shape_annotation_rect(&*document, dict));
        let remove_appearance = subtype != "ink"
            && shape_semantic_change(
                &*document,
                document.get_dictionary(object_id)?,
                &shape,
                page.page_view,
                page.page_rotation,
                existing_rect,
            )?;
        let dict = document.get_dictionary_mut(object_id)?;
        let modified = update_shape_annotation_dict(
            dict,
            &shape,
            page.page_view,
            page.page_rotation,
            modified_at,
            existing_rect,
            remove_appearance,
        )?;
        dict.set("P", Object::Reference(page.page_id));
        if let Some(appearance_ref) = appearance_ref {
            attach_ink_shape_appearance(dict, appearance_ref);
        }
        state.consume(index);
        return Ok(modified);
    }
    Ok(false)
}

pub(crate) fn apply_shape_annotation_decision_incremental(
    incremental: &mut IncrementalDocument,
    state: &mut ShapeConsumptionState,
    deleted_refs: &DeletedShapeRefs,
    refs_to_delete: &mut HashSet<ObjectId>,
    rewrite_shape_state: bool,
    page: ShapePageContext,
    page_annots: &[Object],
    object_id: ObjectId,
    modified_at: &str,
) -> Result<bool> {
    let (annotation_stable_key, annotation_id, subtype) = {
        let dict = match incremental.get_prev_documents().get_dictionary(object_id) {
            Ok(dict) => dict,
            Err(_) => return Ok(false),
        };
        (
            read_shape_stable_key(dict),
            format_pdfjs_annotation_ref(object_id),
            annotation_subtype(dict),
        )
    };
    if !is_supported_shape_subtype(&subtype) {
        return Ok(false);
    }
    if deleted_refs.annotation_ids.contains(&annotation_id)
        || annotation_stable_key
            .as_deref()
            .is_some_and(|stable_key| deleted_refs.stable_keys.contains(stable_key))
    {
        collect_shape_annotation_refs_to_delete(
            incremental.get_prev_documents(),
            refs_to_delete,
            object_id,
            Some(page_annots),
        )?;
        return Ok(true);
    }
    let shape_index = annotation_stable_key
        .as_deref()
        .and_then(|stable_key| state.find_by_stable_key(stable_key))
        .or_else(|| state.find_by_annotation_id(&annotation_id));
    if let Some(index) = shape_index {
        let shape = state.shapes[index].clone();
        incremental.opt_clone_object_to_new_document(object_id)?;
        let appearance_ref = if subtype == "ink" {
            let appearance =
                build_ink_shape_appearance_stream(&shape, page.page_view, page.page_rotation)?;
            Some(incremental.new_document.add_object(appearance))
        } else {
            None
        };
        let existing_rect = {
            // The appended revision over the base: a `/Rect` reference the
            // clone did not copy still resolves against the loaded original.
            let source = AppendedRevision::new(incremental);
            source
                .dictionary(object_id)
                .ok()
                .and_then(|dict| read_shape_annotation_rect(&source, dict))
        };
        let remove_appearance = if subtype == "ink" {
            false
        } else {
            let source = AppendedRevision::new(incremental);
            shape_semantic_change(
                &source,
                source.dictionary(object_id)?,
                &shape,
                page.page_view,
                page.page_rotation,
                existing_rect,
            )?
        };
        let dict = incremental.new_document.get_dictionary_mut(object_id)?;
        let modified = update_shape_annotation_dict(
            dict,
            &shape,
            page.page_view,
            page.page_rotation,
            modified_at,
            existing_rect,
            remove_appearance,
        )?;
        dict.set("P", Object::Reference(page.page_id));
        if let Some(appearance_ref) = appearance_ref {
            attach_ink_shape_appearance(dict, appearance_ref);
        }
        state.consume(index);
        return Ok(modified);
    }
    if annotation_stable_key.is_some() && rewrite_shape_state {
        collect_shape_annotation_refs_to_delete(
            incremental.get_prev_documents(),
            refs_to_delete,
            object_id,
            Some(page_annots),
        )?;
        return Ok(true);
    }
    Ok(false)
}

struct ShapeDeleteTargets {
    refs_to_delete: HashSet<ObjectId>,
    page_ids: HashSet<ObjectId>,
}

fn collect_known_shape_delete_targets(
    document: &Document,
    deleted_refs: &DeletedShapeRefs,
) -> Result<ShapeDeleteTargets> {
    let mut refs_to_delete = HashSet::new();
    let mut page_ids = HashSet::new();
    for annotation_id in &deleted_refs.annotation_ids {
        let Some(object_id) = parse_pdfjs_annotation_object_id(annotation_id) else {
            continue;
        };
        if document.dictionary(object_id).is_err() {
            continue;
        }
        let (owner_page_id, owner_page_annots) = shape_delete_owner_page(document, object_id)?
            .map_or((None, None), |(page_id, annots)| {
                (Some(page_id), Some(annots))
            });
        if let Some(page_id) = owner_page_id {
            page_ids.insert(page_id);
        }
        for related_id in
            collect_annotation_refs_to_delete(document, object_id, owner_page_annots.as_deref())?
        {
            refs_to_delete.insert(related_id);
        }
    }
    let stable_lookup = lookup_embedded_shape_delete_targets(document, &deleted_refs.stable_keys);
    page_ids.extend(stable_lookup.page_ids);
    for object_id in stable_lookup.object_ids {
        let owner = shape_delete_owner_page(document, object_id)?;
        if let Some((page_id, _)) = owner.as_ref() {
            page_ids.insert(*page_id);
        }
        for related_id in collect_annotation_refs_to_delete(
            document,
            object_id,
            owner.as_ref().map(|(_, annots)| annots.as_slice()),
        )? {
            refs_to_delete.insert(related_id);
        }
    }
    extend_shape_page_ids_from_refs(document, &refs_to_delete, &mut page_ids);
    Ok(ShapeDeleteTargets {
        refs_to_delete,
        page_ids,
    })
}

/// Resolve a shape's page-local annotation list before collecting related
/// popup/reply references. Imported PDFs may omit `/P`, so explicit object
/// deletes need this bounded fallback to remove the object from `/Annots`.
fn shape_delete_owner_page(
    document: &Document,
    object_id: ObjectId,
) -> Result<Option<(ObjectId, Vec<Object>)>> {
    if let Some(page_id) = shape_annotation_page_id(document, object_id) {
        return Ok(Some((page_id, get_page_annots(document, page_id)?)));
    }
    for page_id in document.page_ids().into_values() {
        let annots = get_page_annots(document, page_id)?;
        if annots
            .iter()
            .any(|object| object.as_reference().ok() == Some(object_id))
        {
            return Ok(Some((page_id, annots)));
        }
    }
    Ok(None)
}

pub(crate) fn shape_annotation_page_id(
    document: &impl PdfObjectSource,
    annotation_id: ObjectId,
) -> Option<ObjectId> {
    let annotation = document.dictionary(annotation_id).ok()?;
    let page_id = annotation.get(b"P").ok()?.as_reference().ok()?;
    document.dictionary(page_id).ok()?;
    Some(page_id)
}

fn extend_shape_page_ids_from_refs(
    document: &impl PdfObjectSource,
    refs_to_delete: &HashSet<ObjectId>,
    page_ids: &mut HashSet<ObjectId>,
) {
    for object_id in refs_to_delete {
        if let Some(page_id) = shape_annotation_page_id(document, *object_id) {
            page_ids.insert(page_id);
        }
    }
}

fn resolve_shape_page_ids(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    shapes: &ShapesMutation,
    refs_to_delete: &HashSet<ObjectId>,
) -> Result<HashSet<ObjectId>> {
    let mut page_ids = HashSet::new();
    for shape in &shapes.shapes {
        let page_number = shape
            .page_index
            .checked_add(1)
            .ok_or("Invalid shape page index")?;
        page_ids.insert(page_resolver.page_id(document, page_number)?);
    }
    for shape in &shapes.shapes {
        let Some(annotation_id) = shape
            .annotation_id
            .as_deref()
            .and_then(parse_pdfjs_annotation_object_id)
        else {
            continue;
        };
        if let Some(page_id) = shape_annotation_page_id(document, annotation_id) {
            page_ids.insert(page_id);
        }
    }
    extend_shape_page_ids_from_refs(document, refs_to_delete, &mut page_ids);
    Ok(page_ids)
}

pub(crate) fn remove_shape_refs_from_pages(
    document: &mut Document,
    page_ids: &HashSet<ObjectId>,
    refs_to_delete: &HashSet<ObjectId>,
) -> Result<bool> {
    if refs_to_delete.is_empty() {
        return Ok(false);
    }
    let mut removed_any = false;
    for page_id in page_ids {
        let annots = get_page_annots(document, *page_id)?;
        let (filtered_annots, removed) = filter_annots_without_refs(annots, refs_to_delete);
        if !removed {
            continue;
        }
        let page = document.get_dictionary_mut(*page_id)?;
        page.set("Annots", Object::Array(filtered_annots));
        removed_any = true;
    }
    Ok(removed_any)
}

pub(crate) fn remove_shape_refs_from_pages_incremental(
    incremental: &mut IncrementalDocument,
    page_ids: &HashSet<ObjectId>,
    refs_to_delete: &HashSet<ObjectId>,
) -> Result<bool> {
    if refs_to_delete.is_empty() {
        return Ok(false);
    }
    let mut removed_any = false;
    for page_id in page_ids {
        let annots = get_page_annots(&incremental.new_document, *page_id)
            .or_else(|_| get_page_annots(incremental.get_prev_documents(), *page_id))?;
        let (filtered_annots, removed) = filter_annots_without_refs(annots, refs_to_delete);
        if !removed {
            continue;
        }
        incremental.opt_clone_object_to_new_document(*page_id)?;
        let page = incremental.new_document.get_dictionary_mut(*page_id)?;
        page.set("Annots", Object::Array(filtered_annots));
        removed_any = true;
    }
    Ok(removed_any)
}

pub(crate) fn append_remaining_shape_annotations(
    document: &mut Document,
    page_resolver: &PageTreeResolver,
    shapes: Vec<ShapeAnnotation>,
    modified_at: &str,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<bool> {
    let mut modified = false;
    for shape in shapes {
        let page_number = shape
            .page_index
            .checked_add(1)
            .ok_or("Invalid shape page index")?;
        let page_id = page_resolver.page_id(document, page_number)?;
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let mut dict = create_shape_annotation_dict(&shape, page_view, page_rotation, modified_at)?;
        dict.set("P", Object::Reference(page_id));
        if shape_annotation_subtype_for_create(&shape) == Some("Ink") {
            let appearance = build_ink_shape_appearance_stream(&shape, page_view, page_rotation)?;
            let appearance_ref = document.add_object(appearance);
            attach_ink_shape_appearance(&mut dict, appearance_ref);
        }
        let object_id = document.add_object(Object::Dictionary(dict));
        report_shape_identity_binding(identity_bindings, &shape, object_id);
        append_annots_to_page(document, page_id, &[object_id])?;
        modified = true;
    }
    Ok(modified)
}

pub(crate) fn append_remaining_shape_annotations_incremental(
    incremental: &mut IncrementalDocument,
    page_resolver: &PageTreeResolver,
    shapes: Vec<ShapeAnnotation>,
    modified_at: &str,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<bool> {
    let mut modified = false;
    for shape in shapes {
        let page_number = shape
            .page_index
            .checked_add(1)
            .ok_or("Invalid shape page index")?;
        let page_id = page_resolver.page_id(incremental.get_prev_documents(), page_number)?;
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let mut dict = create_shape_annotation_dict(&shape, page_view, page_rotation, modified_at)?;
        dict.set("P", Object::Reference(page_id));
        if shape_annotation_subtype_for_create(&shape) == Some("Ink") {
            let appearance = build_ink_shape_appearance_stream(&shape, page_view, page_rotation)?;
            let appearance_ref = incremental.new_document.add_object(appearance);
            attach_ink_shape_appearance(&mut dict, appearance_ref);
        }
        let object_id = incremental
            .new_document
            .add_object(Object::Dictionary(dict));
        report_shape_identity_binding(identity_bindings, &shape, object_id);
        append_annots_to_page_incremental(incremental, page_id, &[object_id])?;
        modified = true;
    }
    Ok(modified)
}

/// Report a newly created shape's durable identity. A shape carries its
/// stable key, or falls back to the pdf.js-era annotation id for imported
/// shapes; shapes with neither have no identity to report.
fn report_shape_identity_binding(
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
    shape: &ShapeAnnotation,
    object_id: ObjectId,
) {
    append_annotation_identity_binding(
        identity_bindings,
        shape.stable_key.as_deref(),
        shape.annotation_id.as_deref(),
        object_id,
    );
}

pub(crate) fn apply_shape_annotations(
    document: &mut Document,
    shapes: &ShapesMutation,
    modified_at: &str,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()> {
    assert_mutation_page_count(document, shapes.total_pages, "Shape mutation")?;
    let page_resolver = PageTreeResolver::new(document)?;
    let mut state = ShapeConsumptionState::new(&shapes.shapes);
    let deleted_refs = collect_deleted_shape_refs(shapes);
    let delete_targets = collect_known_shape_delete_targets(document, &deleted_refs)?;
    let mut refs_to_delete = delete_targets.refs_to_delete;
    let mut page_ids = resolve_shape_page_ids(document, &page_resolver, shapes, &refs_to_delete)?;
    page_ids.extend(delete_targets.page_ids);
    let mut modified = false;
    for page_id in page_ids.iter().copied() {
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let annots = get_page_annots(document, page_id)?;
        for object_id in annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
        {
            modified = apply_shape_annotation_decision(
                document,
                &mut state,
                &deleted_refs,
                &mut refs_to_delete,
                shapes.rewrite_shape_state,
                ShapePageContext {
                    page_id,
                    page_view,
                    page_rotation,
                },
                &annots,
                object_id,
                modified_at,
            )? || modified;
        }
    }
    extend_shape_page_ids_from_refs(document, &refs_to_delete, &mut page_ids);
    modified = remove_shape_refs_from_pages(document, &page_ids, &refs_to_delete)? || modified;
    let remaining = state.remaining().cloned().collect::<Vec<_>>();
    modified = append_remaining_shape_annotations(
        document,
        &page_resolver,
        remaining,
        modified_at,
        identity_bindings,
    )? || modified;
    if !modified
        && (shapes.rewrite_shape_state
            || !shapes.shapes.is_empty()
            || !shapes.deleted_annotation_ids.is_empty()
            || !shapes.deleted_stable_keys.is_empty())
    {
        return Err("Shape mutation did not modify the document".into());
    }
    Ok(())
}

pub(crate) fn apply_shape_annotations_incremental(
    incremental: &mut IncrementalDocument,
    shapes: &ShapesMutation,
    modified_at: &str,
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()> {
    assert_mutation_page_count(
        incremental.get_prev_documents(),
        shapes.total_pages,
        "Shape mutation",
    )?;
    let page_resolver = PageTreeResolver::new(incremental.get_prev_documents())?;
    let mut state = ShapeConsumptionState::new(&shapes.shapes);
    let deleted_refs = collect_deleted_shape_refs(shapes);
    let delete_targets =
        collect_known_shape_delete_targets(incremental.get_prev_documents(), &deleted_refs)?;
    let mut refs_to_delete = delete_targets.refs_to_delete;
    let mut page_ids = resolve_shape_page_ids(
        incremental.get_prev_documents(),
        &page_resolver,
        shapes,
        &refs_to_delete,
    )?;
    page_ids.extend(delete_targets.page_ids);
    let mut modified = false;
    for page_id in page_ids.iter().copied() {
        let page_view = resolve_page_view(incremental.get_prev_documents(), page_id)?;
        let page_rotation = resolve_page_rotation(incremental.get_prev_documents(), page_id)?;
        let annots = get_page_annots(incremental.get_prev_documents(), page_id)?;
        for object_id in annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
        {
            modified = apply_shape_annotation_decision_incremental(
                incremental,
                &mut state,
                &deleted_refs,
                &mut refs_to_delete,
                shapes.rewrite_shape_state,
                ShapePageContext {
                    page_id,
                    page_view,
                    page_rotation,
                },
                &annots,
                object_id,
                modified_at,
            )? || modified;
        }
    }
    extend_shape_page_ids_from_refs(
        incremental.get_prev_documents(),
        &refs_to_delete,
        &mut page_ids,
    );
    modified = remove_shape_refs_from_pages_incremental(incremental, &page_ids, &refs_to_delete)?
        || modified;
    let remaining = state.remaining().cloned().collect::<Vec<_>>();
    modified = append_remaining_shape_annotations_incremental(
        incremental,
        &page_resolver,
        remaining,
        modified_at,
        identity_bindings,
    )? || modified;
    if !modified
        && (shapes.rewrite_shape_state
            || !shapes.shapes.is_empty()
            || !shapes.deleted_annotation_ids.is_empty()
            || !shapes.deleted_stable_keys.is_empty())
    {
        return Err("Shape mutation did not modify the document".into());
    }
    Ok(())
}
