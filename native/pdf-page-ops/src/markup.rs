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

pub(crate) fn build_squiggly_appearance_stream(
    values: &[f64],
    rect: PdfRect,
    color: RgbColor,
) -> Option<Stream> {
    // Quartz/Preview does not synthesize Squiggly appearances from QuadPoints,
    // so native rewrites must append a small Form XObject for visibility.
    let mut content = String::new();
    content.push_str("q\n");
    content.push_str(&format!(
        "{} {} {} RG\n",
        number_to_content(f64::from(color.r) / 255.0),
        number_to_content(f64::from(color.g) / 255.0),
        number_to_content(f64::from(color.b) / 255.0)
    ));
    content.push_str(&format!(
        "{} w\n1 J\n",
        number_to_content(SQUIGGLY_APPEARANCE_STROKE_WIDTH)
    ));
    let mut has_path = false;
    for chunk in values.chunks_exact(8) {
        let xs = [chunk[0], chunk[2], chunk[4], chunk[6]];
        let ys = [chunk[1], chunk[3], chunk[5], chunk[7]];
        let left = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let right = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let bottom = ys.iter().copied().fold(f64::INFINITY, f64::min);
        let top = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let height = top - bottom;
        if right - left <= 0.0 || height <= 0.0 {
            continue;
        }
        let amplitude = SQUIGGLY_APPEARANCE_MAX_AMPLITUDE.min(
            SQUIGGLY_APPEARANCE_MIN_AMPLITUDE.max(height * SQUIGGLY_APPEARANCE_AMPLITUDE_RATIO),
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
    if !has_path {
        return None;
    }
    content.push_str("S\nQ\n");
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
    let appearance_ref = if hint.subtype == "Squiggly" {
        let appearance_color = target_color.unwrap_or(RgbColor { r: 0, g: 0, b: 0 });
        let stream = build_squiggly_appearance_stream(&quad_points, rect, appearance_color)
            .ok_or("Squiggly text-markup geometry could not produce an appearance")?;
        Some(document.add_object(stream))
    } else {
        None
    };

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
    if let Some(contents) = hint.contents.as_deref() {
        dict.set(
            "Contents",
            Object::String(encode_pdf_text_string(contents), StringFormat::Hexadecimal),
        );
    }
    if hint.subtype == "Highlight" {
        dict.set("CA", Object::Integer(1));
    }
    if let Some(appearance_ref) = appearance_ref {
        let mut appearance = Dictionary::new();
        appearance.set("N", Object::Reference(appearance_ref));
        dict.set("AP", Object::Dictionary(appearance));
    }

    let object_id = document.new_object_id();
    document.set_object(object_id, Object::Dictionary(dict));
    Ok(object_id)
}

pub(crate) fn apply_markup_rewrite_to_object(
    document: &mut Document,
    candidate: &MarkupAnnotationCandidate,
    target_subtype: &str,
    color: Option<&str>,
    contents: Option<&str>,
    identity_name: Option<&str>,
    modified_at: &str,
) -> Result<bool> {
    let target_color = resolve_hint_target_color(target_subtype, color);
    let mut modified = false;
    let mut ensured_quad_points: Option<(Vec<f64>, bool)> = None;
    let mut squiggly_ap_ref: Option<ObjectId> = None;

    if target_subtype != "Highlight" {
        ensured_quad_points = ensure_markup_quad_points(candidate);
        let subtype_already_applied = candidate.subtype == target_subtype;
        if !subtype_already_applied {
            modified = true;
        }
        if ensured_quad_points
            .as_ref()
            .is_some_and(|(_, changed)| *changed)
        {
            modified = true;
        }
        if target_subtype == "Squiggly" {
            if let (Some((values, _)), Some(rect), Some(color)) = (
                &ensured_quad_points,
                candidate.rect,
                target_color.or(candidate.color),
            ) {
                if let Some(stream) = build_squiggly_appearance_stream(values, rect, color) {
                    squiggly_ap_ref = Some(document.add_object(stream));
                    modified = true;
                }
            }
        }
    }
    if target_color.is_some() {
        modified = true;
    }
    if contents.is_some() {
        modified = true;
    }
    let identity_name = identity_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let identity_name_needs_write = identity_name.is_some()
        && document
            .get_dictionary(candidate.object_id)
            .ok()
            .and_then(read_annotation_name)
            .is_none();
    modified = identity_name_needs_write || modified;
    if !modified {
        return Ok(false);
    }

    let dict = document.get_dictionary_mut(candidate.object_id)?;
    if identity_name_needs_write {
        write_annotation_name(
            dict,
            identity_name.expect("identity name was checked before mutation"),
        );
    }
    if let Some(color) = target_color {
        write_markup_color(dict, color);
        if target_subtype == "Highlight" {
            dict.set("CA", Object::Integer(1));
        }
        dict.remove(b"AP");
    }
    if target_subtype != "Highlight" {
        if let Some((values, _)) = ensured_quad_points {
            dict.set("QuadPoints", quad_points_object(&values));
        }
        if candidate.subtype != target_subtype {
            let pdf_name =
                markup_subtype_pdf_name(target_subtype).ok_or("Invalid text-markup subtype")?;
            dict.set("Subtype", Object::Name(pdf_name.as_bytes().to_vec()));
            dict.remove(b"AP");
        }
        if let Some(ap_ref) = squiggly_ap_ref {
            let mut ap = Dictionary::new();
            ap.set("N", Object::Reference(ap_ref));
            dict.set("AP", Object::Dictionary(ap));
        }
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

pub(crate) type MarkupInputs = (HashMap<String, String>, HashMap<u32, Vec<MarkupHintState>>);

pub(crate) fn build_markup_inputs(markup: &MarkupMutation) -> Result<MarkupInputs> {
    let overrides = markup
        .overrides
        .iter()
        .map(|(annotation_id, subtype)| (annotation_id.clone(), subtype.clone()))
        .collect();
    let mut hints_by_page: HashMap<u32, Vec<MarkupHintState>> = HashMap::new();
    for hint_state in dedupe_markup_subtype_hints(&markup.hints)? {
        hints_by_page
            .entry(hint_state.hint.page_index)
            .or_default()
            .push(hint_state);
    }
    Ok((overrides, hints_by_page))
}

/// Resolve only the pages that a markup mutation can touch.
///
/// Geometry-only hints identify a page by number. Explicit hint and override
/// references can identify their owner through the annotation's `/P` back
/// reference, which also lets a stale page hint reach the correct page. The
/// returned map is keyed by page object so an owner page and a numbered page
/// are processed at most once.
fn resolve_markup_page_targets(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    overrides: &HashMap<String, String>,
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

    for annotation_ref in overrides.keys() {
        let Some(annotation_id) = parse_pdfjs_annotation_object_id(annotation_ref) else {
            continue;
        };
        if let Some(page_id) = annotation_page_id(document, annotation_id) {
            targets.entry(page_id).or_default();
        }
    }

    Ok(targets)
}

pub(crate) fn rewrite_page_markup_subtypes(
    document: &mut Document,
    candidates: &[MarkupAnnotationCandidate],
    overrides: &HashMap<String, String>,
    page_hints: &mut [MarkupHintState],
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
            rewritten = apply_markup_rewrite_to_object(
                document,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
                hint.contents.as_deref(),
                markup_annotation_name(&hint).as_deref(),
                modified_at,
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_exact_ref_highlight_preservation_hint(page_hints, candidate, &hints_by_ref)
        {
            let hint = page_hints[hint_index].hint.clone();
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten = apply_markup_rewrite_to_object(
                document,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
                hint.contents.as_deref(),
                markup_annotation_name(&hint).as_deref(),
                modified_at,
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_best_exact_ref_hint_for_candidate(page_hints, candidate, &hints_by_ref)
        {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_object(
                document,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
                hint.contents.as_deref(),
                markup_annotation_name(&hint).as_deref(),
                modified_at,
            )? || rewritten;
            continue;
        }

        if let Some(override_subtype) = overrides.get(&candidate.ref_tag) {
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten = apply_markup_rewrite_to_object(
                document,
                candidate,
                override_subtype,
                None,
                None,
                None,
                modified_at,
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
        rewritten = apply_markup_rewrite_to_object(
            document,
            candidate,
            &hint.subtype,
            hint.color.as_deref(),
            hint.contents.as_deref(),
            markup_annotation_name(&hint).as_deref(),
            modified_at,
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

pub(crate) fn apply_markup_rewrite_to_incremental_object(
    incremental: &mut IncrementalDocument,
    candidate: &MarkupAnnotationCandidate,
    target_subtype: &str,
    color: Option<&str>,
    contents: Option<&str>,
    identity_name: Option<&str>,
    modified_at: &str,
) -> Result<bool> {
    incremental.opt_clone_object_to_new_document(candidate.object_id)?;
    let modified = apply_markup_rewrite_to_object(
        &mut incremental.new_document,
        candidate,
        target_subtype,
        color,
        None,
        identity_name,
        modified_at,
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
    overrides: &HashMap<String, String>,
    page_hints: &mut [MarkupHintState],
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
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
                hint.contents.as_deref(),
                markup_annotation_name(&hint).as_deref(),
                modified_at,
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_exact_ref_highlight_preservation_hint(page_hints, candidate, &hints_by_ref)
        {
            let hint = page_hints[hint_index].hint.clone();
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
                hint.contents.as_deref(),
                markup_annotation_name(&hint).as_deref(),
                modified_at,
            )? || rewritten;
            continue;
        }

        if let Some(hint_index) =
            find_best_exact_ref_hint_for_candidate(page_hints, candidate, &hints_by_ref)
        {
            page_hints[hint_index].consumed = true;
            let hint = page_hints[hint_index].hint.clone();
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                &hint.subtype,
                hint.color.as_deref(),
                hint.contents.as_deref(),
                markup_annotation_name(&hint).as_deref(),
                modified_at,
            )? || rewritten;
            continue;
        }

        if let Some(override_subtype) = overrides.get(&candidate.ref_tag) {
            consume_exact_ref_hints(page_hints, candidate, &hints_by_ref);
            rewritten = apply_markup_rewrite_to_incremental_object(
                incremental,
                candidate,
                override_subtype,
                None,
                None,
                None,
                modified_at,
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
        rewritten = apply_markup_rewrite_to_incremental_object(
            incremental,
            candidate,
            &hint.subtype,
            hint.color.as_deref(),
            hint.contents.as_deref(),
            markup_annotation_name(&hint).as_deref(),
            modified_at,
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
    let (overrides, hints_by_page) = build_markup_inputs(markup)?;
    let page_resolver = PageTreeResolver::new(document)?;
    let page_targets =
        resolve_markup_page_targets(document, &page_resolver, &overrides, hints_by_page)?;
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
            &overrides,
            &mut page_hints,
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
    let (overrides, hints_by_page) = build_markup_inputs(markup)?;
    let page_targets = {
        let document = incremental.get_prev_documents();
        let page_resolver = PageTreeResolver::new(document)?;
        resolve_markup_page_targets(document, &page_resolver, &overrides, hints_by_page)?
    };
    let mut modified = false;

    for (page_id, mut page_hints) in page_targets {
        let candidates = {
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
            candidates
        };
        modified = rewrite_page_markup_subtypes_incremental(
            incremental,
            &candidates,
            &overrides,
            &mut page_hints,
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
