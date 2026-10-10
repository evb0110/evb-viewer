use super::*;

#[derive(Clone)]
pub(crate) struct TextMarkupQuad {
    pub(crate) bottom: f64,
    pub(crate) center_y: f64,
    pub(crate) index: usize,
    pub(crate) left: f64,
    pub(crate) right: f64,
    pub(crate) top: f64,
}

pub(crate) struct TextMarkupQuadLineGroup {
    pub(crate) average_height: f64,
    pub(crate) bottom: f64,
    pub(crate) center_y: f64,
    pub(crate) quads: Vec<TextMarkupQuad>,
    pub(crate) top: f64,
}

/// The quad points of a text markup (highlight, underline, strike-out or
/// squiggly), or `None` for any other annotation.
fn text_markup_quad_points(annotation: &Dictionary) -> Option<Vec<f64>> {
    let Ok(Object::Name(subtype)) = annotation.get(b"Subtype") else {
        return None;
    };
    if !matches!(
        subtype.as_slice(),
        b"Highlight" | b"Underline" | b"StrikeOut" | b"Squiggly"
    ) {
        return None;
    }
    numbers(annotation.get(b"QuadPoints").ok())
}

fn numbers(object: Option<&Object>) -> Option<Vec<f64>> {
    let Object::Array(values) = object? else {
        return None;
    };
    values
        .iter()
        .map(|value| value.as_float().ok().map(f64::from))
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

/// Whether an annotation, mapped by `matrix`, keeps any area on `view`. A
/// reader edits a text markup by its quads, so the quads decide for it; any
/// other annotation is judged by its mapped `rect`.
pub(crate) fn annotation_meets_view(
    annotation: &Dictionary,
    matrix: [f64; 6],
    rect: PdfRect,
    view: PdfRect,
) -> bool {
    let matrix = PdfMatrix::from_values(matrix);
    let Some(quads) = text_markup_quad_points(annotation) else {
        return intersect_rect(rect, view).is_some();
    };
    quads.chunks_exact(8).any(|quad| {
        intersect_rect(matrix.bounds(quad_bounds(quad)), view)
            .is_some_and(|area| area.x2 > area.x1 && area.y2 > area.y1)
    })
}

/// Clip a text-markup annotation to the output page it lands on. A quad is read
/// as its bounding box, so clamping each corner clips that box, and a quad with
/// no area left on the page is dropped. The Rect is clamped the same way.
/// `annotation_meets_view` admits only a markup with a quad on the page.
pub(crate) fn clip_text_markup_to_view(annotation: &mut Dictionary, view: Option<PdfRect>) {
    let (Some(view), Some(quads)) = (view, text_markup_quad_points(annotation)) else {
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
    if let Some(rect) = numbers(annotation.get(b"Rect").ok()).filter(|rect| rect.len() == 4) {
        annotation.set(
            "Rect",
            rect_object(PdfRect {
                x1: rect[0].clamp(view.x1, view.x2),
                y1: rect[1].clamp(view.y1, view.y2),
                x2: rect[2].clamp(view.x1, view.x2),
                y2: rect[3].clamp(view.y1, view.y2),
            }),
        );
    }
}

pub(crate) fn mean(values: impl Iterator<Item = f64>) -> f64 {
    let mut total = 0.0;
    let mut count = 0.0;
    for value in values {
        total += value;
        count += 1.0;
    }
    if count == 0.0 {
        0.0
    } else {
        total / count
    }
}

pub(crate) fn to_text_markup_quads(values: &[f64]) -> Option<Vec<TextMarkupQuad>> {
    let mut quads = Vec::new();
    for (index, chunk) in values.chunks_exact(8).enumerate() {
        let xs = [chunk[0], chunk[2], chunk[4], chunk[6]];
        let ys = [chunk[1], chunk[3], chunk[5], chunk[7]];
        if xs.iter().chain(ys.iter()).any(|value| !value.is_finite()) {
            return None;
        }
        let left = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let right = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let bottom = ys.iter().copied().fold(f64::INFINITY, f64::min);
        let top = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        if right <= left || top <= bottom {
            return None;
        }
        quads.push(TextMarkupQuad {
            bottom,
            center_y: (top + bottom) / 2.0,
            index,
            left,
            right,
            top,
        });
    }
    Some(quads)
}

pub(crate) fn add_quad_to_line_group(group: &mut TextMarkupQuadLineGroup, quad: TextMarkupQuad) {
    group.quads.push(quad);
    group.bottom = group
        .quads
        .iter()
        .map(|item| item.bottom)
        .fold(f64::INFINITY, f64::min);
    group.top = group
        .quads
        .iter()
        .map(|item| item.top)
        .fold(f64::NEG_INFINITY, f64::max);
    group.center_y = mean(group.quads.iter().map(|item| item.center_y));
    group.average_height = mean(group.quads.iter().map(|item| item.top - item.bottom));
}

pub(crate) fn normalize_markup_quad_points(values: &[f64]) -> Option<Vec<f64>> {
    let mut quads = to_text_markup_quads(values)?;
    if quads.is_empty() {
        return None;
    }
    quads.sort_by(|left, right| {
        right
            .center_y
            .total_cmp(&left.center_y)
            .then_with(|| left.left.total_cmp(&right.left))
    });
    let mut groups: Vec<TextMarkupQuadLineGroup> = Vec::new();
    for quad in quads {
        let belongs_to_previous = groups.last().is_some_and(|group| {
            let tolerance = group.average_height.max(quad.top - quad.bottom)
                * SAME_TEXT_MARKUP_LINE_CENTER_TOLERANCE_RATIO;
            (quad.center_y - group.center_y).abs() <= tolerance
        });
        if belongs_to_previous {
            let group = groups.last_mut().expect("line group exists");
            add_quad_to_line_group(group, quad);
        } else {
            groups.push(TextMarkupQuadLineGroup {
                average_height: quad.top - quad.bottom,
                bottom: quad.bottom,
                center_y: quad.center_y,
                quads: vec![quad.clone()],
                top: quad.top,
            });
        }
    }
    if groups.len() <= 1 {
        return Some(values.to_vec());
    }
    let mut normalized = values.to_vec();
    for group_index in 0..groups.len() {
        let mut line_top = groups[group_index].top;
        let mut line_bottom = groups[group_index].bottom;
        if let Some(previous_group) = group_index
            .checked_sub(1)
            .and_then(|index| groups.get(index))
        {
            line_top = line_top.min((previous_group.center_y + groups[group_index].center_y) / 2.0);
        }
        if let Some(next_group) = groups.get(group_index + 1) {
            line_bottom =
                line_bottom.max((groups[group_index].center_y + next_group.center_y) / 2.0);
        }
        if line_top - line_bottom < MIN_TEXT_MARKUP_QUAD_HEIGHT {
            line_top = groups[group_index].top;
            line_bottom = groups[group_index].bottom;
        }
        for quad in &groups[group_index].quads {
            let offset = quad.index * 8;
            normalized[offset] = quad.left;
            normalized[offset + 1] = line_top;
            normalized[offset + 2] = quad.right;
            normalized[offset + 3] = line_top;
            normalized[offset + 4] = quad.left;
            normalized[offset + 5] = line_bottom;
            normalized[offset + 6] = quad.right;
            normalized[offset + 7] = line_bottom;
        }
    }
    Some(normalized)
}

pub(crate) fn ensure_markup_quad_points(
    candidate: &MarkupAnnotationCandidate,
) -> Option<(Vec<f64>, bool)> {
    if let Some(values) = &candidate.quad_points {
        let normalized = normalize_markup_quad_points(values)?;
        let changed = normalized
            .iter()
            .zip(values.iter())
            .any(|(left, right)| (left - right).abs() > f64::EPSILON);
        return Some((normalized, changed));
    }
    let rect = candidate.rect?;
    Some((rect_to_fallback_quad_points(rect), true))
}

pub(crate) fn number_to_content(value: f64) -> String {
    let rounded = value.round();
    if (value - rounded).abs() < 0.000_001 {
        return format!("{rounded:.0}");
    }
    let formatted = format!("{value:.4}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

pub(crate) fn build_text_markup_appearance_stream(
    subtype: &str,
    values: &[f64],
    rect: PdfRect,
    color: RgbColor,
    opacity: f64,
) -> Option<Stream> {
    if !opacity.is_finite() || values.len() < 8 || values.len() % 8 != 0 {
        return None;
    }
    let red = number_to_content(f64::from(color.r) / 255.0);
    let green = number_to_content(f64::from(color.g) / 255.0);
    let blue = number_to_content(f64::from(color.b) / 255.0);
    let mut content = format!("q\n/GS0 gs\n{red} {green} {blue} RG\n");
    let mut has_path = false;
    match subtype {
        "Highlight" => {
            content.push_str(&format!("{red} {green} {blue} rg\n"));
            for quad in values.chunks_exact(8) {
                content.push_str(&format!(
                    "{} {} m\n{} {} l\n{} {} l\n{} {} l\nh\n",
                    number_to_content(quad[0]),
                    number_to_content(quad[1]),
                    number_to_content(quad[2]),
                    number_to_content(quad[3]),
                    number_to_content(quad[6]),
                    number_to_content(quad[7]),
                    number_to_content(quad[4]),
                    number_to_content(quad[5]),
                ));
                has_path = true;
            }
            content.push_str("f\n");
        }
        "Underline" | "StrikeOut" => {
            content.push_str(&format!("{} w\n1 J\n", number_to_content(1.0)));
            for quad in values.chunks_exact(8) {
                let (start, end) = if subtype == "Underline" {
                    ((quad[4], quad[5]), (quad[6], quad[7]))
                } else {
                    (
                        ((quad[0] + quad[4]) / 2.0, (quad[1] + quad[5]) / 2.0),
                        ((quad[2] + quad[6]) / 2.0, (quad[3] + quad[7]) / 2.0),
                    )
                };
                content.push_str(&format!(
                    "{} {} m\n{} {} l\n",
                    number_to_content(start.0),
                    number_to_content(start.1),
                    number_to_content(end.0),
                    number_to_content(end.1),
                ));
                has_path = true;
            }
            content.push_str("S\n");
        }
        // Quartz/Preview does not synthesize Squiggly appearances from
        // QuadPoints, so keep its existing path in this shared form builder.
        "Squiggly" => {
            content.push_str(&format!(
                "{} w\n1 J\n",
                number_to_content(SQUIGGLY_APPEARANCE_STROKE_WIDTH)
            ));
            for quad in values.chunks_exact(8) {
                let xs = [quad[0], quad[2], quad[4], quad[6]];
                let ys = [quad[1], quad[3], quad[5], quad[7]];
                let left = xs.iter().copied().fold(f64::INFINITY, f64::min);
                let right = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let bottom = ys.iter().copied().fold(f64::INFINITY, f64::min);
                let top = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let height = top - bottom;
                if right <= left || top <= bottom {
                    continue;
                }
                let amplitude = SQUIGGLY_APPEARANCE_MAX_AMPLITUDE.min(
                    SQUIGGLY_APPEARANCE_MIN_AMPLITUDE
                        .max(height * SQUIGGLY_APPEARANCE_AMPLITUDE_RATIO),
                );
                let center = bottom + amplitude;
                let half_step = 1.5_f64.max(amplitude * 1.5);
                content.push_str(&format!(
                    "{} {} m\n",
                    number_to_content(left),
                    number_to_content(center - amplitude)
                ));
                let mut x = left;
                let mut up = true;
                while x < right {
                    x = right.min(x + half_step);
                    content.push_str(&format!(
                        "{} {} l\n",
                        number_to_content(x),
                        number_to_content(if up {
                            center + amplitude
                        } else {
                            center - amplitude
                        })
                    ));
                    up = !up;
                }
                has_path = true;
            }
            content.push_str("S\n");
        }
        _ => return None,
    }
    if !has_path {
        return None;
    }
    content.push_str("Q\n");

    let mut graphics_state = Dictionary::new();
    graphics_state.set("Type", Object::Name(b"ExtGState".to_vec()));
    graphics_state.set("CA", number_object(opacity.clamp(0.0, 1.0)));
    graphics_state.set("ca", number_object(opacity.clamp(0.0, 1.0)));
    if subtype == "Highlight" {
        graphics_state.set("BM", Object::Name(b"Multiply".to_vec()));
    }
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
    Some(Stream::new(dict, content.into_bytes()))
}

pub(crate) fn quad_points_object(values: &[f64]) -> Object {
    Object::Array(values.iter().map(|value| number_object(*value)).collect())
}

/// Return the stable PDF name used for a newly authored markup annotation.
///
/// PDF.js editor ids are not indirect object references, so they cannot be
/// used to find an annotation after a native append. Keeping the editor id in
/// `/NM` gives the next save a bounded page-local upsert key.
pub(crate) fn markup_annotation_name(hint: &MarkupSubtypeHint) -> Option<String> {
    let identity = (if hint.source.as_deref() == Some("pdf") {
        // Imported PDF annotations carry the PDF object reference in `id` and
        // the editor's canonical identity in `app_annotation_id`. Newly
        // authored editor annotations use `id` as their intended PDF name.
        hint.app_annotation_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                hint.id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
    } else {
        hint.id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                hint.app_annotation_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
    })
    .or_else(|| {
        hint.annotation_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && parse_pdfjs_annotation_object_id(value).is_none())
    })?;
    Some(identity.to_string())
}

fn candidate_markup_name(
    document: &impl PdfObjectSource,
    candidate: &MarkupAnnotationCandidate,
) -> Option<String> {
    document
        .dictionary(candidate.object_id)
        .ok()
        .and_then(read_annotation_name)
}

fn find_named_markup_hint_for_candidate(
    document: &impl PdfObjectSource,
    candidate: &MarkupAnnotationCandidate,
    page_hints: &[MarkupHintState],
) -> Option<usize> {
    let candidate_name = candidate_markup_name(document, candidate)?;
    page_hints.iter().enumerate().find_map(|(index, state)| {
        if state.consumed {
            return None;
        }
        markup_annotation_name(&state.hint)
            .is_some_and(|hint_name| {
                annotation_names_match(&candidate_name, &hint_name, &["evb-markup:"])
            })
            .then_some(index)
    })
}

pub(crate) fn is_new_markup_hint(state: &MarkupHintState) -> bool {
    !state.consumed && is_new_markup_hint_data(&state.hint)
}

pub(crate) fn is_new_markup_hint_data(hint: &MarkupSubtypeHint) -> bool {
    if markup_annotation_name(hint).is_none() {
        return false;
    }
    if hint
        .annotation_id
        .as_deref()
        .and_then(parse_pdfjs_annotation_object_id)
        .is_some()
    {
        return false;
    }
    matches!(hint.source.as_deref(), Some("editor") | Some("editor-live"))
}

pub(crate) fn markup_hint_pdf_quads(
    hint: &MarkupSubtypeHint,
    page_view: PdfRect,
    page_rotation: i64,
) -> Result<(Vec<f64>, PdfRect)> {
    let geometry = hint
        .markup_geometry
        .as_deref()
        .filter(|rects| !rects.is_empty());
    if geometry.is_some_and(|rects| rects.len() > MAX_MARKUP_GEOMETRY_ITEMS) {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many text-markup geometry rectangles",
        ));
    }

    let mut values = Vec::new();
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut append_rect = |marker_rect: MarkerRect| -> Result<()> {
        validate_marker_rect(marker_rect)?;
        let marker_right = marker_rect.left + marker_rect.width;
        let marker_bottom = marker_rect.top + marker_rect.height;
        let points = [
            pdf_point_from_marker_point(
                marker_rect.left,
                marker_rect.top,
                page_view,
                page_rotation,
            ),
            pdf_point_from_marker_point(marker_right, marker_rect.top, page_view, page_rotation),
            pdf_point_from_marker_point(marker_rect.left, marker_bottom, page_view, page_rotation),
            pdf_point_from_marker_point(marker_right, marker_bottom, page_view, page_rotation),
        ];
        for (x, y) in points {
            if !x.is_finite() || !y.is_finite() {
                return Err("Text-markup geometry produced a non-finite point".into());
            }
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
        values.extend([
            points[0].0,
            points[0].1,
            points[1].0,
            points[1].1,
            points[2].0,
            points[2].1,
            points[3].0,
            points[3].1,
        ]);
        Ok(())
    };
    if let Some(rects) = geometry {
        for marker_rect in rects {
            append_rect(*marker_rect)?;
        }
    } else {
        append_rect(hint.marker_rect)?;
    }
    if values.is_empty() || max_x <= min_x || max_y <= min_y {
        return Err("Text-markup hint has no usable geometry".into());
    }
    Ok((
        values,
        PdfRect {
            x1: min_x,
            y1: min_y,
            x2: max_x,
            y2: max_y,
        },
    ))
}

fn create_markup_annotation(
    document: &mut Document,
    page_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
    hint: &MarkupSubtypeHint,
) -> Result<ObjectId> {
    let name = markup_annotation_name(hint)
        .ok_or("New text-markup annotation is missing a stable identity")?;
    let subtype_name = markup_subtype_pdf_name(&hint.subtype)
        .ok_or("Invalid text-markup subtype for native creation")?;
    let (quad_points, rect) = markup_hint_pdf_quads(hint, page_view, page_rotation)?;
    let target_color = resolve_hint_target_color(&hint.subtype, hint.color.as_deref());
    let appearance_color = target_color.unwrap_or_else(|| default_markup_color(&hint.subtype));
    let appearance = build_text_markup_appearance_stream(
        &hint.subtype,
        &quad_points,
        rect,
        appearance_color,
        hint.opacity.unwrap_or(1.0),
    )
    .ok_or("Text-markup geometry could not produce an appearance")?;
    let appearance_ref = document.add_object(appearance);

    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Annot".to_vec()));
    dict.set("Subtype", Object::Name(subtype_name.as_bytes().to_vec()));
    dict.set("F", Object::Integer(4));
    dict.set("P", Object::Reference(page_id));
    dict.set("Rect", rect_object(rect));
    dict.set("QuadPoints", quad_points_object(&quad_points));
    dict.set(
        "NM",
        Object::String(encode_pdf_text_string(&name), StringFormat::Hexadecimal),
    );
    if let Some(color) = target_color {
        write_markup_color(&mut dict, color);
    }
    if let Some(author) = hint.author.as_deref() {
        dict.set(
            "T",
            Object::String(encode_pdf_text_string(author), StringFormat::Hexadecimal),
        );
    }
    if let Some(contents) = hint.contents.as_deref() {
        dict.set(
            "Contents",
            Object::String(encode_pdf_text_string(contents), StringFormat::Hexadecimal),
        );
    }
    if let Some(opacity) = hint.opacity {
        dict.set("CA", number_object(opacity));
    } else {
        dict.set("CA", Object::Integer(1));
    }
    attach_markup_appearance(&mut dict, appearance_ref);

    let object_id = document.new_object_id();
    document.set_object(object_id, Object::Dictionary(dict));
    Ok(object_id)
}

fn default_markup_color(subtype: &str) -> RgbColor {
    if subtype == "Highlight" {
        RgbColor {
            r: 255,
            g: 255,
            b: 0,
        }
    } else {
        RgbColor { r: 0, g: 0, b: 0 }
    }
}

fn attach_markup_appearance(dict: &mut Dictionary, appearance_ref: ObjectId) {
    let mut appearance = Dictionary::new();
    appearance.set("N", Object::Reference(appearance_ref));
    dict.set("AP", Object::Dictionary(appearance));
}

struct MarkupRewrite<'a> {
    target_subtype: &'a str,
    color: Option<&'a str>,
    opacity: Option<f64>,
    contents: Option<&'a str>,
    author: Option<&'a str>,
    identity_name: Option<&'a str>,
    modified_at: &'a str,
    geometry: Option<(&'a MarkupSubtypeHint, PdfRect, i64)>,
}

fn apply_markup_rewrite_to_object_with_options(
    document: &mut Document,
    candidate: &MarkupAnnotationCandidate,
    rewrite: MarkupRewrite<'_>,
) -> Result<bool> {
    let MarkupRewrite {
        target_subtype,
        color,
        opacity,
        contents,
        author,
        identity_name,
        modified_at,
        geometry,
    } = rewrite;
    let target_color = resolve_hint_target_color(target_subtype, color);
    let mut modified = false;
    let mut appearance_rect = candidate.rect;
    let authoritative_geometry = geometry.filter(|(hint, _, _)| {
        hint.markup_geometry
            .as_ref()
            .is_some_and(|rects| !rects.is_empty())
    });
    let (quad_points, quad_points_changed) =
        if let Some((hint, page_view, page_rotation)) = authoritative_geometry {
            let (values, rect) = markup_hint_pdf_quads(hint, page_view, page_rotation)?;
            appearance_rect = Some(rect);
            let changed = candidate.quad_points.as_ref().is_none_or(|existing| {
                existing.len() != values.len()
                    || existing
                        .iter()
                        .zip(values.iter())
                        .any(|(left, right)| (left - right).abs() > 0.000_001)
            });
            let rect_changed = candidate.rect.is_none_or(|existing| {
                [
                    (existing.x1, rect.x1),
                    (existing.y1, rect.y1),
                    (existing.x2, rect.x2),
                    (existing.y2, rect.y2),
                ]
                .into_iter()
                .any(|(left, right)| (left - right).abs() > 0.000_001)
            });
            modified |= changed || rect_changed;
            (Some(values), changed || rect_changed)
        } else if let Some((values, changed)) = ensure_markup_quad_points(candidate) {
            (Some(values), changed)
        } else {
            (None, false)
        };
    modified |= candidate.subtype != target_subtype;
    modified |= target_color.is_some_and(|target| Some(target) != candidate.color);
    modified |= opacity.is_some_and(|target| {
        candidate
            .opacity
            .is_none_or(|actual| (actual - target).abs() > 0.000_001)
    });
    modified |= contents.is_some() || author.is_some();
    // A matched explicit style hint is a valid upsert even when its scalar
    // values already match (the append writer still records the revision).
    modified |= color.is_some() || opacity.is_some();
    let identity_name = identity_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let identity_name_needs_write = identity_name.is_some()
        && document
            .get_dictionary(candidate.object_id)
            .ok()
            .and_then(read_annotation_name)
            .is_none();
    modified |= identity_name_needs_write;
    let appearance_changed = quad_points_changed
        || candidate.subtype != target_subtype
        || target_color.is_some_and(|target| Some(target) != candidate.color)
        || opacity.is_some_and(|target| {
            candidate
                .opacity
                .is_none_or(|actual| (actual - target).abs() > 0.000_001)
        })
        || !candidate.has_appearance;
    let appearance_ref = if appearance_changed {
        let values = quad_points
            .as_deref()
            .ok_or("Text-markup annotation has no usable QuadPoints")?;
        let rect = appearance_rect.ok_or("Text-markup annotation has no appearance bounds")?;
        let appearance_color = target_color
            .or(candidate.color)
            .unwrap_or_else(|| default_markup_color(target_subtype));
        let appearance_opacity = opacity.or(candidate.opacity).unwrap_or(1.0);
        Some(
            document.add_object(
                build_text_markup_appearance_stream(
                    target_subtype,
                    values,
                    rect,
                    appearance_color,
                    appearance_opacity,
                )
                .ok_or("Text-markup geometry could not produce an appearance")?,
            ),
        )
    } else {
        None
    };
    modified |= appearance_ref.is_some();
    if !modified {
        return Ok(false);
    }

    let dict = document.get_dictionary_mut(candidate.object_id)?;
    if let Some(author) = author {
        dict.set(
            "T",
            Object::String(encode_pdf_text_string(author), StringFormat::Hexadecimal),
        );
    }
    if identity_name_needs_write {
        write_annotation_name(
            dict,
            identity_name.expect("identity name was checked before mutation"),
        );
    }
    if let Some(color) = target_color {
        if Some(color) != candidate.color {
            write_markup_color(dict, color);
        }
    }
    if let Some(opacity) = opacity {
        if candidate
            .opacity
            .is_none_or(|actual| (actual - opacity).abs() > 0.000_001)
        {
            dict.set("CA", number_object(opacity));
        }
    } else if candidate.opacity.is_none() {
        // Appearance streams are rendered under the annotation opacity. Make
        // that source explicit even for a full-opacity imported annotation.
        dict.set("CA", Object::Integer(1));
    }
    if let Some((hint, _, _)) = authoritative_geometry {
        if let Some(rect) = appearance_rect {
            dict.set("Rect", rect_object(rect));
        }
        let _ = hint;
    }
    if let Some(values) = quad_points {
        if authoritative_geometry.is_some() || candidate.quad_points.is_none() {
            dict.set("QuadPoints", quad_points_object(&values));
        }
    }
    if candidate.subtype != target_subtype {
        let pdf_name =
            markup_subtype_pdf_name(target_subtype).ok_or("Invalid text-markup subtype")?;
        dict.set("Subtype", Object::Name(pdf_name.as_bytes().to_vec()));
    }
    if let Some(ap_ref) = appearance_ref {
        attach_markup_appearance(dict, ap_ref);
    }
    if let Some(contents) = contents {
        update_annotation_text_by_ref(document, candidate.object_id, contents, modified_at)?;
    }
    Ok(true)
}

pub(crate) fn create_markup_candidate(
    document: &Document,
    page_view: PdfRect,
    page_rotation: i64,
    object_id: ObjectId,
    page_markup_index: u32,
) -> Option<MarkupAnnotationCandidate> {
    let dict = document.get_dictionary(object_id).ok()?;
    let subtype = canonical_markup_subtype(dict)?;
    let rect = read_pdf_rect_from_dict(document, dict);
    Some(MarkupAnnotationCandidate {
        color: read_markup_color(document, dict),
        opacity: dict
            .get(b"CA")
            .ok()
            .and_then(|object| document.resolved(object).ok())
            .and_then(|object| object_to_f64(object).ok())
            .filter(|value| value.is_finite()),
        has_appearance: dict.get(b"AP").is_ok(),
        marker_rect: rect
            .and_then(|rect| marker_rect_from_pdf_rect(rect, page_view, page_rotation)),
        object_id,
        page_markup_index,
        quad_points: read_markup_quad_points(document, dict),
        rect,
        ref_tag: format_pdfjs_annotation_ref(object_id),
        subtype,
    })
}

fn markup_hints_by_page(markup: &MarkupMutation) -> Result<HashMap<u32, Vec<MarkupHintState>>> {
    let mut hints_by_page: HashMap<u32, Vec<MarkupHintState>> = HashMap::new();
    for hint_state in dedupe_markup_subtype_hints(&markup.hints)? {
        hints_by_page
            .entry(hint_state.hint.page_index)
            .or_default()
            .push(hint_state);
    }
    Ok(hints_by_page)
}

/// Resolve only the pages that a markup mutation can touch.
///
/// Geometry-only hints identify a page by number. Explicit hint references can
/// identify their owner through the annotation's `/P` back reference, which
/// also lets a stale page hint reach the correct page. The returned map is
/// keyed by page object so an owner page and a numbered page are processed at
/// most once.
fn resolve_markup_page_targets(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    hints_by_page: HashMap<u32, Vec<MarkupHintState>>,
) -> Result<BTreeMap<ObjectId, Vec<MarkupHintState>>> {
    let mut targets: BTreeMap<ObjectId, Vec<MarkupHintState>> = BTreeMap::new();

    for (page_index, hints) in hints_by_page {
        let mut numbered_page_id = None;
        for hint in hints {
            let owner_page_id = hint
                .annotation_ref
                .as_deref()
                .and_then(parse_pdfjs_annotation_object_id)
                .and_then(|annotation_id| annotation_page_id(document, annotation_id));
            let page_id = if let Some(owner_page_id) = owner_page_id {
                owner_page_id
            } else {
                match numbered_page_id {
                    Some(page_id) => page_id,
                    None => {
                        let page_number = page_index
                            .checked_add(1)
                            .ok_or("Invalid text-markup hint page index")?;
                        let page_id = page_resolver.page_id(document, page_number)?;
                        numbered_page_id = Some(page_id);
                        page_id
                    }
                }
            };
            targets.entry(page_id).or_default().push(hint);
        }
    }

    Ok(targets)
}

pub(crate) fn rewrite_page_markup_subtypes(
    document: &mut Document,
    candidates: &[MarkupAnnotationCandidate],
    page_hints: &mut [MarkupHintState],
    page_view: PdfRect,
    page_rotation: i64,
    modified_at: &str,
) -> Result<bool> {
    let mut rewritten = false;
    let mut unmatched_candidates = Vec::new();
    let hints_by_ref = index_markup_hints_by_ref(page_hints);

    for candidate in candidates {
        if let Some(hint_index) =
            find_named_markup_hint_for_candidate(document, candidate, page_hints)
        {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_object_with_options(
                document,
                candidate,
                MarkupRewrite {
                    target_subtype: &hint.subtype,
                    color: hint.color.as_deref(),
                    opacity: hint.opacity,
                    contents: hint.contents.as_deref(),
                    author: hint.author.as_deref(),
                    identity_name: markup_annotation_name(&hint).as_deref(),
                    modified_at,
                    geometry: Some((&hint, page_view, page_rotation)),
                },
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_exact_ref_highlight_preservation_hint(page_hints, candidate, &hints_by_ref)
        {
            let hint = page_hints[hint_index].hint.clone();
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten = apply_markup_rewrite_to_object_with_options(
                document,
                candidate,
                MarkupRewrite {
                    target_subtype: &hint.subtype,
                    color: hint.color.as_deref(),
                    opacity: hint.opacity,
                    contents: hint.contents.as_deref(),
                    author: hint.author.as_deref(),
                    identity_name: markup_annotation_name(&hint).as_deref(),
                    modified_at,
                    geometry: Some((&hint, page_view, page_rotation)),
                },
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_best_exact_ref_hint_for_candidate(page_hints, candidate, &hints_by_ref)
        {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_object_with_options(
                document,
                candidate,
                MarkupRewrite {
                    target_subtype: &hint.subtype,
                    color: hint.color.as_deref(),
                    opacity: hint.opacity,
                    contents: hint.contents.as_deref(),
                    author: hint.author.as_deref(),
                    identity_name: markup_annotation_name(&hint).as_deref(),
                    modified_at,
                    geometry: Some((&hint, page_view, page_rotation)),
                },
            )? || rewritten;
            continue;
        }

        unmatched_candidates.push(candidate.clone());
    }

    if page_hints.is_empty() || unmatched_candidates.is_empty() {
        return Ok(rewritten);
    }

    for (candidate_index, hint_index) in
        assign_subtype_hints_to_candidates(page_hints, &unmatched_candidates)?
    {
        page_hints[hint_index].consumed = true;
        let hint = page_hints[hint_index].hint.clone();
        let candidate = &unmatched_candidates[candidate_index];
        rewritten = apply_markup_rewrite_to_object_with_options(
            document,
            candidate,
            MarkupRewrite {
                target_subtype: &hint.subtype,
                color: hint.color.as_deref(),
                opacity: hint.opacity,
                contents: hint.contents.as_deref(),
                author: hint.author.as_deref(),
                identity_name: markup_annotation_name(&hint).as_deref(),
                modified_at,
                geometry: Some((&hint, page_view, page_rotation)),
            },
        )? || rewritten;
    }
    Ok(rewritten)
}

fn create_new_markup_annotations(
    document: &mut Document,
    page_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
    page_hints: &mut [MarkupHintState],
) -> Result<bool> {
    create_new_markup_annotations_internal(
        document,
        page_id,
        page_view,
        page_rotation,
        page_hints,
        None,
    )
}

fn create_new_markup_annotations_with_bindings(
    document: &mut Document,
    page_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
    page_hints: &mut [MarkupHintState],
    identity_bindings: &mut Vec<AnnotationIdentityBinding>,
) -> Result<bool> {
    create_new_markup_annotations_internal(
        document,
        page_id,
        page_view,
        page_rotation,
        page_hints,
        Some(identity_bindings),
    )
}

fn create_new_markup_annotations_internal(
    document: &mut Document,
    page_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
    page_hints: &mut [MarkupHintState],
    mut identity_bindings: Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<bool> {
    let mut created = Vec::new();
    for state in page_hints.iter_mut() {
        if !is_new_markup_hint(state) {
            continue;
        }
        let app_annotation_id = identity_bindings.as_ref().map(|_| {
            state
                .hint
                .app_annotation_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("New text-markup annotation is missing canonical annotation identity")
        });
        let app_annotation_id = match app_annotation_id {
            Some(result) => Some(result?),
            None => None,
        };
        let object_id =
            create_markup_annotation(document, page_id, page_view, page_rotation, &state.hint)?;
        state.consumed = true;
        created.push(object_id);
        if let Some(bindings) = identity_bindings.as_mut() {
            bindings.push(AnnotationIdentityBinding {
                annotation_id: app_annotation_id
                    .expect("binding mode validates canonical annotation identity")
                    .to_string(),
                pdf_ref: format!("{} {} R", object_id.0, object_id.1),
            });
        }
    }
    if created.is_empty() {
        return Ok(false);
    }
    append_annots_to_page(document, page_id, &created)?;
    Ok(true)
}

fn apply_markup_rewrite_to_incremental_object_with_options(
    incremental: &mut IncrementalDocument,
    candidate: &MarkupAnnotationCandidate,
    rewrite: MarkupRewrite<'_>,
) -> Result<bool> {
    let MarkupRewrite {
        target_subtype,
        color,
        opacity,
        contents,
        author,
        identity_name,
        modified_at,
        geometry,
    } = rewrite;
    incremental.opt_clone_object_to_new_document(candidate.object_id)?;
    let modified = apply_markup_rewrite_to_object_with_options(
        &mut incremental.new_document,
        candidate,
        MarkupRewrite {
            target_subtype,
            color,
            opacity,
            contents: None,
            author,
            identity_name,
            modified_at,
            geometry,
        },
    )?;
    if let Some(contents) = contents {
        update_annotation_text_incremental_by_ref(
            incremental,
            candidate.object_id,
            contents,
            modified_at,
        )?;
    }
    Ok(modified || contents.is_some())
}

pub(crate) fn rewrite_page_markup_subtypes_incremental(
    incremental: &mut IncrementalDocument,
    candidates: &[MarkupAnnotationCandidate],
    page_hints: &mut [MarkupHintState],
    page_view: PdfRect,
    page_rotation: i64,
    modified_at: &str,
) -> Result<bool> {
    let mut rewritten = false;
    let mut unmatched_candidates = Vec::new();
    let hints_by_ref = index_markup_hints_by_ref(page_hints);

    for candidate in candidates {
        // Deletes run before markup replay in the same incremental revision.
        // Keep a live editor hint available to create a fresh annotation when
        // its previous-revision candidate has already become a tombstone.
        if matches!(
            incremental.new_document.get_object(candidate.object_id),
            Ok(Object::Null)
        ) {
            continue;
        }
        if let Some(hint_index) = find_named_markup_hint_for_candidate(
            &AppendedRevision::new(incremental),
            candidate,
            page_hints,
        ) {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_incremental_object_with_options(
                incremental,
                candidate,
                MarkupRewrite {
                    target_subtype: &hint.subtype,
                    color: hint.color.as_deref(),
                    opacity: hint.opacity,
                    contents: hint.contents.as_deref(),
                    author: hint.author.as_deref(),
                    identity_name: markup_annotation_name(&hint).as_deref(),
                    modified_at,
                    geometry: Some((&hint, page_view, page_rotation)),
                },
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_exact_ref_highlight_preservation_hint(page_hints, candidate, &hints_by_ref)
        {
            let hint = page_hints[hint_index].hint.clone();
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten = apply_markup_rewrite_to_incremental_object_with_options(
                incremental,
                candidate,
                MarkupRewrite {
                    target_subtype: &hint.subtype,
                    color: hint.color.as_deref(),
                    opacity: hint.opacity,
                    contents: hint.contents.as_deref(),
                    author: hint.author.as_deref(),
                    identity_name: markup_annotation_name(&hint).as_deref(),
                    modified_at,
                    geometry: Some((&hint, page_view, page_rotation)),
                },
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_best_exact_ref_hint_for_candidate(page_hints, candidate, &hints_by_ref)
        {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_incremental_object_with_options(
                incremental,
                candidate,
                MarkupRewrite {
                    target_subtype: &hint.subtype,
                    color: hint.color.as_deref(),
                    opacity: hint.opacity,
                    contents: hint.contents.as_deref(),
                    author: hint.author.as_deref(),
                    identity_name: markup_annotation_name(&hint).as_deref(),
                    modified_at,
                    geometry: Some((&hint, page_view, page_rotation)),
                },
            )? || rewritten;
            continue;
        }

        unmatched_candidates.push(candidate.clone());
    }

    if page_hints.is_empty() || unmatched_candidates.is_empty() {
        return Ok(rewritten);
    }

    for (candidate_index, hint_index) in
        assign_subtype_hints_to_candidates(page_hints, &unmatched_candidates)?
    {
        page_hints[hint_index].consumed = true;
        let hint = page_hints[hint_index].hint.clone();
        let candidate = &unmatched_candidates[candidate_index];
        rewritten = apply_markup_rewrite_to_incremental_object_with_options(
            incremental,
            candidate,
            MarkupRewrite {
                target_subtype: &hint.subtype,
                color: hint.color.as_deref(),
                opacity: hint.opacity,
                contents: hint.contents.as_deref(),
                author: hint.author.as_deref(),
                identity_name: markup_annotation_name(&hint).as_deref(),
                modified_at,
                geometry: Some((&hint, page_view, page_rotation)),
            },
        )? || rewritten;
    }
    Ok(rewritten)
}

fn create_new_markup_annotations_incremental(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
    page_hints: &mut [MarkupHintState],
) -> Result<bool> {
    create_new_markup_annotations_incremental_internal(
        incremental,
        page_id,
        page_view,
        page_rotation,
        page_hints,
        None,
    )
}

fn create_new_markup_annotations_incremental_with_bindings(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
    page_hints: &mut [MarkupHintState],
    identity_bindings: &mut Vec<AnnotationIdentityBinding>,
) -> Result<bool> {
    create_new_markup_annotations_incremental_internal(
        incremental,
        page_id,
        page_view,
        page_rotation,
        page_hints,
        Some(identity_bindings),
    )
}

fn create_new_markup_annotations_incremental_internal(
    incremental: &mut IncrementalDocument,
    page_id: ObjectId,
    page_view: PdfRect,
    page_rotation: i64,
    page_hints: &mut [MarkupHintState],
    mut identity_bindings: Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<bool> {
    let mut created = Vec::new();
    for state in page_hints.iter_mut() {
        if !is_new_markup_hint(state) {
            continue;
        }
        let app_annotation_id = identity_bindings.as_ref().map(|_| {
            state
                .hint
                .app_annotation_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("New text-markup annotation is missing canonical annotation identity")
        });
        let app_annotation_id = match app_annotation_id {
            Some(result) => Some(result?),
            None => None,
        };
        let object_id = create_markup_annotation(
            &mut incremental.new_document,
            page_id,
            page_view,
            page_rotation,
            &state.hint,
        )?;
        state.consumed = true;
        created.push(object_id);
        if let Some(bindings) = identity_bindings.as_mut() {
            bindings.push(AnnotationIdentityBinding {
                annotation_id: app_annotation_id
                    .expect("binding mode validates canonical annotation identity")
                    .to_string(),
                pdf_ref: format!("{} {} R", object_id.0, object_id.1),
            });
        }
    }
    if created.is_empty() {
        return Ok(false);
    }
    append_annots_to_page_incremental(incremental, page_id, &created)?;
    Ok(true)
}

pub(crate) fn apply_markup_mutations(
    document: &mut Document,
    markup: &MarkupMutation,
    modified_at: &str,
) -> Result<()> {
    apply_markup_mutations_internal(document, markup, modified_at, None)
}

pub(crate) fn apply_markup_mutations_with_bindings(
    document: &mut Document,
    markup: &MarkupMutation,
    modified_at: &str,
    identity_bindings: &mut Vec<AnnotationIdentityBinding>,
) -> Result<()> {
    apply_markup_mutations_internal(document, markup, modified_at, Some(identity_bindings))
}

pub(crate) fn apply_markup_mutations_internal(
    document: &mut Document,
    markup: &MarkupMutation,
    modified_at: &str,
    mut identity_bindings: Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()> {
    let hints_by_page = markup_hints_by_page(markup)?;
    let page_resolver = PageTreeResolver::new(document)?;
    let page_targets = resolve_markup_page_targets(document, &page_resolver, hints_by_page)?;
    let mut modified = false;

    for (page_id, mut page_hints) in page_targets {
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        let annots = get_page_annots(document, page_id)?;
        let mut candidates = Vec::new();
        let mut page_markup_index = 0_u32;
        for object_id in annots
            .iter()
            .filter_map(|object| object.as_reference().ok())
        {
            if let Some(candidate) = create_markup_candidate(
                document,
                page_view,
                page_rotation,
                object_id,
                page_markup_index,
            ) {
                candidates.push(candidate);
                page_markup_index += 1;
            }
        }
        modified = rewrite_page_markup_subtypes(
            document,
            &candidates,
            &mut page_hints,
            page_view,
            page_rotation,
            modified_at,
        )? || modified;
        modified = match identity_bindings.as_mut() {
            Some(bindings) => create_new_markup_annotations_with_bindings(
                document,
                page_id,
                page_view,
                page_rotation,
                &mut page_hints,
                bindings,
            )?,
            None => create_new_markup_annotations(
                document,
                page_id,
                page_view,
                page_rotation,
                &mut page_hints,
            )?,
        } || modified;
    }

    if !modified {
        return Err("Text-markup mutation did not modify the document".into());
    }
    Ok(())
}

pub(crate) fn apply_markup_mutations_incremental(
    incremental: &mut IncrementalDocument,
    markup: &MarkupMutation,
    modified_at: &str,
) -> Result<()> {
    apply_markup_mutations_incremental_internal(incremental, markup, modified_at, None)
}

pub(crate) fn apply_markup_mutations_incremental_with_bindings(
    incremental: &mut IncrementalDocument,
    markup: &MarkupMutation,
    modified_at: &str,
    identity_bindings: &mut Vec<AnnotationIdentityBinding>,
) -> Result<()> {
    apply_markup_mutations_incremental_internal(
        incremental,
        markup,
        modified_at,
        Some(identity_bindings),
    )
}

pub(crate) fn apply_markup_mutations_incremental_internal(
    incremental: &mut IncrementalDocument,
    markup: &MarkupMutation,
    modified_at: &str,
    mut identity_bindings: Option<&mut Vec<AnnotationIdentityBinding>>,
) -> Result<()> {
    let hints_by_page = markup_hints_by_page(markup)?;
    let page_targets = {
        let document = incremental.get_prev_documents();
        let page_resolver = PageTreeResolver::new(document)?;
        resolve_markup_page_targets(document, &page_resolver, hints_by_page)?
    };
    let mut modified = false;

    for (page_id, mut page_hints) in page_targets {
        let (candidates, page_view, page_rotation) = {
            let document = incremental.get_prev_documents();
            let page_view = resolve_page_view(document, page_id)?;
            let page_rotation = resolve_page_rotation(document, page_id)?;
            let annots = get_page_annots(document, page_id)?;
            let mut candidates = Vec::new();
            let mut page_markup_index = 0_u32;
            for object_id in annots
                .iter()
                .filter_map(|object| object.as_reference().ok())
            {
                if let Some(candidate) = create_markup_candidate(
                    document,
                    page_view,
                    page_rotation,
                    object_id,
                    page_markup_index,
                ) {
                    candidates.push(candidate);
                    page_markup_index += 1;
                }
            }
            (candidates, page_view, page_rotation)
        };
        modified = rewrite_page_markup_subtypes_incremental(
            incremental,
            &candidates,
            &mut page_hints,
            page_view,
            page_rotation,
            modified_at,
        )? || modified;
        let document = incremental.get_prev_documents();
        let page_view = resolve_page_view(document, page_id)?;
        let page_rotation = resolve_page_rotation(document, page_id)?;
        modified = match identity_bindings.as_mut() {
            Some(bindings) => create_new_markup_annotations_incremental_with_bindings(
                incremental,
                page_id,
                page_view,
                page_rotation,
                &mut page_hints,
                bindings,
            )?,
            None => create_new_markup_annotations_incremental(
                incremental,
                page_id,
                page_view,
                page_rotation,
                &mut page_hints,
            )?,
        } || modified;
    }

    if !modified {
        return Err("Text-markup mutation did not modify the document".into());
    }
    Ok(())
}
