use super::*;

const MAX_NOTE_TEXT_UPDATES: usize = 256;
const MAX_NOTE_GEOMETRY_UPDATES: usize = 256;
const MAX_NOTE_CHANGES: usize = 256;
const MAX_TEXT_BOXES: usize = 256;
const MAX_TEXT_BOX_TEXT_BYTES: usize = 64 * 1024;
const MAX_PAGE_LABEL_RANGES: usize = 2_048;

pub(crate) fn parse_margin(value: &str, label: &str) -> Result<f64> {
    let parsed = value.parse::<f64>()?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(format!("Invalid {label} margin").into());
    }
    Ok(parsed)
}

pub(crate) fn read_pages_file(path: &Path) -> Result<Vec<u32>> {
    read_pages_file_with_limits(path, MAX_SIDECAR_BYTES, MAX_COLLECTION_ITEMS)
}

fn read_pages_file_with_limits(
    path: &Path,
    max_bytes: usize,
    max_items: usize,
) -> Result<Vec<u32>> {
    let bytes = read_file_bounded(path, max_bytes, "page selection file").map_err(|error| {
        if error.code == NativeErrorCode::Io {
            domain_error(NativeErrorCode::InvalidRequest, error.message)
        } else {
            Box::new(error)
        }
    })?;
    let contents = std::str::from_utf8(&bytes).map_err(|error| {
        domain_error(
            NativeErrorCode::InvalidRequest,
            format!("Invalid page selection file UTF-8: {error}"),
        )
    })?;
    let mut pages = Vec::new();
    for (index, line) in contents.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let page = trimmed
            .parse::<u32>()
            .map_err(|_| format!("Invalid page number on line {}", index + 1))?;
        if page == 0 {
            return Err(format!("Invalid page number on line {}", index + 1).into());
        }
        if pages.len() == max_items {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("Page selection exceeds the {max_items}-item admission ceiling"),
            ));
        }
        pages.push(page);
    }
    if pages.is_empty() {
        return Err("At least one page must be selected".into());
    }
    Ok(pages)
}

pub(crate) fn read_note_text_updates(path: &Path) -> Result<Vec<NoteTextUpdate>> {
    let parsed: NoteTextUpdatesFile = read_json_sidecar(path, "note text updates")?;
    if parsed.updates.is_empty() {
        return Err("At least one note text update is required".into());
    }
    if parsed.updates.len() > MAX_NOTE_TEXT_UPDATES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Too many note text updates (maximum {MAX_NOTE_TEXT_UPDATES})"),
        ));
    }
    for update in &parsed.updates {
        if update.object_number == 0 {
            return Err("Invalid note update object number".into());
        }
    }
    validate_note_text_budget(&parsed.updates)?;
    Ok(parsed.updates)
}

pub(crate) fn validate_text_notes(notes: &[TextNote]) -> Result<()> {
    for note in notes {
        if note.stable_key.trim().is_empty() {
            return Err("Invalid text note stable key".into());
        }
        validate_marker_rect(note.marker_rect)?;
    }
    Ok(())
}

pub(crate) fn validate_free_text_notes(notes: &[FreeTextNote]) -> Result<()> {
    validate_text_notes(notes)
}

pub(crate) fn validate_text_boxes(editors: &[TextBoxMutation]) -> Result<()> {
    if editors.len() > MAX_TEXT_BOXES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Too many text boxes (maximum {MAX_TEXT_BOXES})"),
        ));
    }
    for editor in editors {
        if editor.stable_key.trim().is_empty() || editor.stable_key.len() > 512 {
            return Err("Invalid text box stable key".into());
        }
        if editor
            .annotation_id
            .as_deref()
            .is_some_and(|value| parse_pdfjs_annotation_object_id(value).is_none())
        {
            return Err("Invalid text box annotation id".into());
        }
        if editor.text.len() > MAX_TEXT_BOX_TEXT_BYTES {
            return Err("Text box text exceeds the 64 KiB admission ceiling".into());
        }
        if !editor.rect.iter().all(|coordinate| coordinate.is_finite())
            || editor.rect[2] <= editor.rect[0]
            || editor.rect[3] <= editor.rect[1]
        {
            return Err("Invalid text box rectangle".into());
        }
        if !matches!(editor.rotation, 0 | 90 | 180 | 270) {
            return Err("Invalid text box rotation".into());
        }
        if !editor.font_size.is_finite() || editor.font_size <= 0.0 || editor.font_size > 512.0 {
            return Err("Invalid text box font size".into());
        }
        if !editor.text.chars().all(|character| {
            character == '\n' || character == '\t' || (' '..='~').contains(&character)
        }) {
            return Err("Text box text is unsupported by the bounded Helvetica appearance".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_annotation_deletes(deletes: &[AnnotationDelete]) -> Result<()> {
    for delete in deletes {
        let has_ref = delete.object_number.is_some() || delete.generation_number.is_some();
        let has_valid_ref = matches!(
            (delete.object_number, delete.generation_number),
            (Some(object_number), Some(_generation_number)) if object_number > 0
        );
        let has_stable_key = delete
            .stable_key
            .as_deref()
            .is_some_and(|stable_key| !stable_key.trim().is_empty());
        if (!has_stable_key || has_ref) && !has_valid_ref {
            return Err("Annotation delete must include a valid object ref or stable key".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_marker_rect(rect: MarkerRect) -> Result<()> {
    if !rect.left.is_finite()
        || !rect.top.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.left < 0.0
        || rect.top < 0.0
        || rect.width <= 0.0
        || rect.height <= 0.0
        || rect.left + rect.width > 1.0
        || rect.top + rect.height > 1.0
    {
        return Err("Invalid FreeText note marker rectangle".into());
    }
    Ok(())
}

pub(crate) fn validate_note_geometry_updates(updates: &[NoteGeometryUpdate]) -> Result<()> {
    if updates.len() > MAX_NOTE_GEOMETRY_UPDATES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Too many note geometry updates (maximum {MAX_NOTE_GEOMETRY_UPDATES})"),
        ));
    }
    for update in updates {
        if update.object_number == 0 {
            return Err("Invalid note geometry update object number".into());
        }
        validate_marker_rect(update.marker_rect)?;
    }
    Ok(())
}

pub(crate) fn read_note_changes(path: &Path) -> Result<NoteChangesFile> {
    let parsed: NoteChangesFile = read_json_sidecar(path, "note changes")?;
    if parsed.updates.is_empty()
        && parsed.geometry_updates.is_empty()
        && parsed.notes.is_empty()
        && parsed.free_text_notes.is_empty()
        && parsed.deletes.is_empty()
    {
        return Err("At least one note change is required".into());
    }
    for update in &parsed.updates {
        if update.object_number == 0 {
            return Err("Invalid note update object number".into());
        }
    }
    validate_note_geometry_updates(&parsed.geometry_updates)?;
    validate_text_notes(&parsed.notes)?;
    validate_free_text_notes(&parsed.free_text_notes)?;
    let note_count = parsed
        .notes
        .len()
        .saturating_add(parsed.free_text_notes.len());
    validate_note_change_caps(
        parsed.updates.len(),
        parsed.geometry_updates.len(),
        note_count,
        parsed.deletes.len(),
    )?;
    validate_annotation_deletes(&parsed.deletes)?;
    validate_mutation_collection_budget(&[
        parsed.updates.len(),
        parsed.geometry_updates.len(),
        parsed.notes.len(),
        parsed.free_text_notes.len(),
        parsed.deletes.len(),
    ])?;
    validate_note_changes_text_budget(&parsed)?;
    Ok(parsed)
}

pub(crate) fn validate_page_labels_mutation(page_labels: &PageLabelsMutation) -> Result<()> {
    if page_labels.total_pages == 0 {
        return Err("Invalid page-label page count".into());
    }
    if page_labels.ranges.len() > MAX_PAGE_LABEL_RANGES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Too many page-label ranges (maximum {MAX_PAGE_LABEL_RANGES})"),
        ));
    }
    for range in &page_labels.ranges {
        if range.start_page == 0 || range.start_number == 0 {
            return Err("Invalid page-label range".into());
        }
        if let Some(style) = range.style.as_deref() {
            if !matches!(style, "D" | "R" | "r" | "A" | "a") {
                return Err("Invalid page-label style".into());
            }
        }
    }
    Ok(())
}

pub(crate) fn count_bookmark_items(items: &[BookmarkEntry]) -> usize {
    items.iter().fold(0usize, |total, item| {
        total
            .saturating_add(1)
            .saturating_add(count_bookmark_items(&item.items))
    })
}

pub(crate) fn validate_bookmark_items(items: &[BookmarkEntry], depth: usize) -> Result<()> {
    if depth > 64 {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Bookmark tree is too deeply nested",
        ));
    }
    for item in items {
        if item.title.len() > 4_096 {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Bookmark title exceeds the 4096-byte admission ceiling",
            ));
        }
        if let Some(color) = item.color.as_deref() {
            if parse_pdf_color(Some(color)).is_none() {
                return Err("Invalid bookmark color".into());
            }
        }
        validate_bookmark_items(&item.items, depth + 1)?;
    }
    Ok(())
}

pub(crate) fn validate_bookmarks_mutation(bookmarks: &BookmarksMutation) -> Result<()> {
    if bookmarks.total_pages == 0 {
        return Err("Invalid bookmark page count".into());
    }
    if count_bookmark_items(&bookmarks.items) > 5_000 {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many bookmark items",
        ));
    }
    validate_bookmark_items(&bookmarks.items, 0)
}

pub(crate) fn is_unit_number(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

pub(crate) fn validate_shape_point(point: &ShapePoint) -> Result<()> {
    if !is_unit_number(point.x) || !is_unit_number(point.y) {
        return Err("Invalid shape point".into());
    }
    Ok(())
}

pub(crate) fn validate_shape_points(points: &[ShapePoint], min_len: usize) -> Result<()> {
    if points.len() < min_len {
        return Err("Shape has too few points".into());
    }
    for point in points {
        validate_shape_point(point)?;
    }
    Ok(())
}

pub(crate) fn validate_shape_geometry(shape: &ShapeAnnotation) -> Result<()> {
    if !matches!(
        shape.shape_type.as_str(),
        "rectangle" | "circle" | "line" | "arrow" | "polyline" | "polygon"
    ) {
        return Err("Invalid shape type".into());
    }
    if !is_unit_number(shape.x)
        || !is_unit_number(shape.y)
        || !shape.width.is_finite()
        || shape.width < 0.0
        || !shape.height.is_finite()
        || shape.height < 0.0
        || !shape.stroke_width.is_finite()
        || shape.stroke_width < 0.0
        || !is_unit_number(shape.opacity)
    {
        return Err("Invalid shape style or bounds".into());
    }
    if shape.color.trim().is_empty()
        || shape.color.eq_ignore_ascii_case("transparent")
        || shape.color.eq_ignore_ascii_case("none")
        || parse_pdf_color(Some(&shape.color)).is_none()
    {
        return Err("Invalid shape color".into());
    }
    if let Some(fill_color) = shape.fill_color.as_deref() {
        if !fill_color.trim().is_empty()
            && !fill_color.eq_ignore_ascii_case("transparent")
            && !fill_color.eq_ignore_ascii_case("none")
            && parse_pdf_color(Some(fill_color)).is_none()
        {
            return Err("Invalid shape fill color".into());
        }
    }
    if let Some(pdf_subtype) = shape.pdf_subtype.as_deref() {
        if !matches!(
            pdf_subtype,
            "Square" | "Circle" | "Line" | "PolyLine" | "Polygon" | "Ink"
        ) {
            return Err("Invalid shape PDF subtype".into());
        }
    }
    for line_end_style in [
        shape.line_start_style.as_deref(),
        shape.line_end_style.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !matches!(line_end_style, "none" | "openArrow" | "closedArrow") {
            return Err("Invalid shape line ending style".into());
        }
    }

    match shape.shape_type.as_str() {
        "rectangle" | "circle" => {
            if shape.width <= 0.0
                || shape.height <= 0.0
                || shape.x + shape.width > 1.0
                || shape.y + shape.height > 1.0
            {
                return Err("Invalid rectangular shape geometry".into());
            }
        }
        "line" | "arrow" => {
            if !shape.x2.is_some_and(is_unit_number) || !shape.y2.is_some_and(is_unit_number) {
                return Err("Invalid line shape geometry".into());
            }
        }
        "polyline" if shape.pdf_subtype.as_deref() == Some("Ink") => {
            if shape.strokes.is_empty() {
                validate_shape_points(&shape.points, 2)?;
            } else {
                for stroke in &shape.strokes {
                    validate_shape_points(stroke, 2)?;
                }
            }
        }
        "polyline" | "polygon" => validate_shape_points(&shape.points, 2)?,
        _ => {}
    }
    Ok(())
}

pub(crate) fn validate_shapes_mutation(shapes: &ShapesMutation) -> Result<()> {
    if shapes.total_pages == 0 {
        return Err("Invalid shape page count".into());
    }
    if shapes.shapes.len() > 4_096
        || shapes.deleted_annotation_ids.len() > 4_096
        || shapes.deleted_stable_keys.len() > 4_096
    {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many shape mutations",
        ));
    }
    let mut point_count = 0usize;
    for shape in &shapes.shapes {
        if shape.page_index >= shapes.total_pages {
            return Err("Shape page index is outside the mutation page count".into());
        }
        if shape.strokes.len() > MAX_SHAPE_MUTATION_STROKES {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Too many shape strokes per shape",
            ));
        }
        let shape_stroke_point_count = shape
            .strokes
            .iter()
            .try_fold(0usize, |total, stroke| total.checked_add(stroke.len()))
            .unwrap_or(usize::MAX);
        let shape_point_count = shape.points.len().saturating_add(shape_stroke_point_count);
        if shape_point_count > MAX_SHAPE_MUTATION_POINTS {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Too many shape points per shape",
            ));
        }
        point_count = point_count.saturating_add(shape_point_count);
        if point_count > MAX_COLLECTION_ITEMS {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Too many shape points",
            ));
        }
        validate_shape_geometry(shape)?;
    }
    Ok(())
}

pub(crate) fn is_supported_markup_subtype(subtype: &str) -> bool {
    matches!(
        subtype,
        "Highlight" | "Underline" | "StrikeOut" | "Squiggly"
    )
}

pub(crate) fn validate_markup_mutation(markup: &MarkupMutation) -> Result<()> {
    if markup.overrides.len() > 4_096 || markup.hints.len() > MAX_MARKUP_SUBTYPE_HINTS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many text-markup mutations",
        ));
    }
    let geometry_count = markup.hints.iter().try_fold(0usize, |total, hint| {
        total
            .checked_add(hint.markup_geometry.as_ref().map_or(0, Vec::len))
            .ok_or_else(|| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "Text-markup geometry item count overflowed",
                )
            })
    })?;
    if geometry_count > MAX_MARKUP_GEOMETRY_ITEMS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many text-markup geometry rectangles",
        ));
    }
    if markup.overrides.is_empty() && markup.hints.is_empty() {
        return Err("Text-markup mutation must include at least one rewrite".into());
    }
    for (annotation_id, subtype) in &markup.overrides {
        if annotation_id.trim().is_empty() || annotation_id.len() > 2_048 {
            return Err("Invalid text-markup override annotation id".into());
        }
        if !is_supported_markup_subtype(subtype) {
            return Err("Invalid text-markup override subtype".into());
        }
    }
    for hint in &markup.hints {
        if !is_supported_markup_subtype(&hint.subtype) {
            return Err("Invalid text-markup hint subtype".into());
        }
        validate_marker_rect(hint.marker_rect)?;
        if hint
            .markup_geometry
            .as_ref()
            .is_some_and(|rects| rects.len() > MAX_MARKUP_GEOMETRY_ITEMS)
        {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Too many text-markup geometry rectangles",
            ));
        }
        if let Some(rects) = &hint.markup_geometry {
            for rect in rects {
                validate_marker_rect(*rect)?;
            }
        }
        for value in [
            hint.annotation_id.as_deref(),
            hint.color.as_deref(),
            hint.contents.as_deref(),
            hint.id.as_deref(),
            hint.source.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.len() > 2_048 {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Text-markup hint string is too long",
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_placed_images(images: &[PlacedImage]) -> Result<()> {
    if images.len() > MAX_PLACED_IMAGE_MUTATIONS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many placed image mutations",
        ));
    }
    for image in images {
        if image
            .stable_key
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 2_048)
        {
            return Err("Invalid placed image stable key".into());
        }
        if image
            .annotation_id
            .as_deref()
            .is_some_and(|value| parse_pdfjs_annotation_object_id(value).is_none())
        {
            return Err("Invalid placed image annotation id".into());
        }
        if !image.mime_type.eq_ignore_ascii_case("image/jpeg") {
            return Err("Native placed images only support JPEG payloads".into());
        }
        validate_marker_rect(MarkerRect {
            left: image.x,
            top: image.y,
            width: image.width,
            height: image.height,
        })?;
        if image
            .rotation_degrees
            .is_some_and(|rotation| !rotation.is_finite())
        {
            return Err("Invalid placed image rotation".into());
        }
    }
    let payloads = validate_placed_image_payloads(images)?;
    for (image, bytes) in images.iter().zip(payloads) {
        *image.validated_bytes.borrow_mut() = Some(bytes);
    }
    Ok(())
}

pub(crate) fn read_native_mutations(path: &Path) -> Result<NativeMutationsFile> {
    let parsed: NativeMutationsFile = read_json_sidecar(path, "native PDF mutations")?;
    validate_native_mutations(parsed)
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn read_native_mutations_bytes(bytes: &[u8]) -> Result<NativeMutationsFile> {
    if bytes.len() > MAX_SIDECAR_BYTES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Native PDF mutation payload exceeds the admission ceiling",
        ));
    }
    let parsed = serde_json::from_slice(bytes).map_err(|error| {
        domain_error(
            NativeErrorCode::InvalidRequest,
            format!("Invalid native PDF mutation payload: {error}"),
        )
    })?;
    validate_native_mutations(parsed)
}

fn validate_native_mutations(parsed: NativeMutationsFile) -> Result<NativeMutationsFile> {
    if parsed.updates.is_empty()
        && parsed.geometry_updates.is_empty()
        && parsed.notes.is_empty()
        && parsed.free_text_notes.is_empty()
        && parsed.text_boxes.is_empty()
        && parsed.deletes.is_empty()
        && parsed.page_labels.is_none()
        && parsed.bookmarks.is_none()
        && parsed.shapes.is_none()
        && parsed.markup.is_none()
        && parsed.placed_images.is_empty()
        && parsed.placed_image_geometry_updates.is_empty()
    {
        return Err("At least one native PDF mutation is required".into());
    }
    validate_native_mutation_continuation(&parsed)?;
    for update in &parsed.updates {
        if update.object_number == 0 {
            return Err("Invalid note update object number".into());
        }
    }
    validate_note_geometry_updates(&parsed.geometry_updates)?;
    validate_text_notes(&parsed.notes)?;
    validate_free_text_notes(&parsed.free_text_notes)?;
    validate_text_boxes(&parsed.text_boxes)?;
    validate_annotation_deletes(&parsed.deletes)?;
    let note_count = parsed
        .notes
        .len()
        .saturating_add(parsed.free_text_notes.len());
    validate_note_change_caps(
        parsed.updates.len(),
        parsed.geometry_updates.len(),
        note_count,
        parsed.deletes.len(),
    )?;
    if let Some(page_labels) = &parsed.page_labels {
        validate_page_labels_mutation(page_labels)?;
    }
    if let Some(bookmarks) = &parsed.bookmarks {
        validate_bookmarks_mutation(bookmarks)?;
    }
    if let Some(shapes) = &parsed.shapes {
        validate_shapes_mutation(shapes)?;
    }
    if let Some(markup) = &parsed.markup {
        validate_markup_mutation(markup)?;
    }
    validate_placed_images(&parsed.placed_images)?;
    if parsed.placed_image_geometry_updates.len() > MAX_PLACED_IMAGE_GEOMETRY_UPDATES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Too many placed image geometry updates",
        ));
    }
    validate_mutation_collection_budget(&[
        parsed.updates.len(),
        parsed.geometry_updates.len(),
        parsed.notes.len(),
        parsed.free_text_notes.len(),
        parsed.text_boxes.len(),
        parsed.deletes.len(),
        parsed.placed_images.len(),
        parsed.placed_image_geometry_updates.len(),
    ])?;
    validate_native_mutation_collection_budget(&parsed)?;
    validate_native_mutation_text_budget(&parsed)?;
    Ok(parsed)
}

fn validate_mutation_collection_budget(lengths: &[usize]) -> Result<()> {
    let total = lengths
        .iter()
        .try_fold(0usize, |total, length| total.checked_add(*length))
        .unwrap_or(usize::MAX);
    if total > MAX_COLLECTION_ITEMS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!(
                "Mutation collections exceed the {MAX_COLLECTION_ITEMS}-item admission ceiling"
            ),
        ));
    }
    Ok(())
}

fn count_native_mutation_items(mutations: &NativeMutationsFile) -> usize {
    let mut total = 0usize;
    let mut add = |count: usize| {
        total = total
            .saturating_add(count)
            .min(MAX_COLLECTION_ITEMS.saturating_add(1));
    };

    add(mutations.updates.len());
    add(mutations.geometry_updates.len());
    add(mutations.notes.len());
    add(mutations.free_text_notes.len());
    add(mutations.text_boxes.len());
    add(mutations.deletes.len());
    if let Some(page_labels) = &mutations.page_labels {
        add(page_labels.ranges.len());
    }
    if let Some(bookmarks) = &mutations.bookmarks {
        add(count_bookmark_items(&bookmarks.items));
    }
    if let Some(shapes) = &mutations.shapes {
        add(shapes.shapes.len());
        add(shapes.deleted_annotation_ids.len());
        add(shapes.deleted_stable_keys.len());
        for shape in &shapes.shapes {
            add(shape.strokes.len());
            add(shape.points.len());
            for stroke in &shape.strokes {
                add(stroke.len());
            }
        }
    }
    if let Some(markup) = &mutations.markup {
        add(markup.overrides.len());
        add(markup.hints.len());
        for hint in &markup.hints {
            add(hint.markup_geometry.as_ref().map_or(0, Vec::len));
        }
    }
    add(mutations.placed_images.len());
    add(mutations.placed_image_geometry_updates.len());
    total
}

fn validate_native_mutation_collection_budget(mutations: &NativeMutationsFile) -> Result<()> {
    if count_native_mutation_items(mutations) > MAX_COLLECTION_ITEMS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!(
                "Native mutation sidecar exceeds the {MAX_COLLECTION_ITEMS}-item aggregate admission ceiling"
            ),
        ));
    }
    Ok(())
}

fn validate_note_change_caps(
    updates: usize,
    geometry_updates: usize,
    text_notes: usize,
    deletes: usize,
) -> Result<()> {
    if updates > MAX_NOTE_TEXT_UPDATES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Too many note text updates (maximum {MAX_NOTE_TEXT_UPDATES})"),
        ));
    }
    if geometry_updates > MAX_NOTE_GEOMETRY_UPDATES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Too many note geometry updates (maximum {MAX_NOTE_GEOMETRY_UPDATES})"),
        ));
    }
    if text_notes > MAX_NOTE_CHANGES || deletes > MAX_NOTE_CHANGES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Too many note changes (maximum {MAX_NOTE_CHANGES} per family)"),
        ));
    }
    let total = updates
        .checked_add(geometry_updates)
        .and_then(|value| value.checked_add(text_notes))
        .and_then(|value| value.checked_add(deletes))
        .unwrap_or(usize::MAX);
    if total > MAX_NOTE_CHANGES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Too many note changes (maximum {MAX_NOTE_CHANGES})"),
        ));
    }
    Ok(())
}

fn validate_native_mutation_continuation(mutations: &NativeMutationsFile) -> Result<()> {
    let Some(continuation) = mutations.continuation.as_ref() else {
        return Ok(());
    };
    if continuation.chunk_count < 2
        || continuation.chunk_index == 0
        || continuation.chunk_index >= continuation.chunk_count
    {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Invalid native mutation continuation bounds",
        ));
    }
    if continuation.bookmark_path.len() > 64
        || continuation
            .bookmark_path
            .iter()
            .any(|index| *index >= u32::try_from(MAX_COLLECTION_ITEMS).unwrap_or(u32::MAX))
        || continuation.family != NativeMutationContinuationFamily::Bookmarks
            && !continuation.bookmark_path.is_empty()
    {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Invalid native bookmark continuation path",
        ));
    }
    let has_family_payload = match continuation.family {
        NativeMutationContinuationFamily::Notes => {
            !mutations.updates.is_empty()
                || !mutations.geometry_updates.is_empty()
                || !mutations.notes.is_empty()
                || !mutations.free_text_notes.is_empty()
                || !mutations.deletes.is_empty()
        }
        NativeMutationContinuationFamily::TextBoxes => !mutations.text_boxes.is_empty(),
        NativeMutationContinuationFamily::PageLabels => mutations.page_labels.is_some(),
        NativeMutationContinuationFamily::Bookmarks => mutations.bookmarks.is_some(),
        NativeMutationContinuationFamily::Shapes => mutations.shapes.is_some(),
        NativeMutationContinuationFamily::Markup => mutations.markup.is_some(),
        NativeMutationContinuationFamily::PlacedImages => !mutations.placed_images.is_empty(),
    };
    if !has_family_payload {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Native mutation continuation does not contain its family payload",
        ));
    }
    Ok(())
}

fn consume_text_bytes(total: &mut usize, value: &str) -> Result<()> {
    *total = total.checked_add(value.len()).unwrap_or(usize::MAX);
    if *total > MAX_AGGREGATE_TEXT_BYTES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("Mutation text exceeds the {MAX_AGGREGATE_TEXT_BYTES}-byte admission ceiling"),
        ));
    }
    Ok(())
}

fn validate_note_text_budget(updates: &[NoteTextUpdate]) -> Result<()> {
    let mut total = 0usize;
    for update in updates {
        consume_text_bytes(&mut total, &update.text)?;
    }
    Ok(())
}

fn validate_note_changes_text_budget(changes: &NoteChangesFile) -> Result<()> {
    let mut total = 0usize;
    for update in &changes.updates {
        consume_text_bytes(&mut total, &update.text)?;
    }
    for note in changes.notes.iter().chain(changes.free_text_notes.iter()) {
        consume_text_bytes(&mut total, &note.stable_key)?;
        consume_text_bytes(&mut total, &note.text)?;
        for value in [note.author.as_deref(), note.color.as_deref()]
            .into_iter()
            .flatten()
        {
            consume_text_bytes(&mut total, value)?;
        }
    }
    for delete in &changes.deletes {
        if let Some(stable_key) = delete.stable_key.as_deref() {
            consume_text_bytes(&mut total, stable_key)?;
        }
    }
    Ok(())
}

fn consume_bookmark_text(total: &mut usize, items: &[BookmarkEntry]) -> Result<()> {
    for item in items {
        consume_text_bytes(total, &item.title)?;
        for value in [item.named_dest.as_deref(), item.color.as_deref()]
            .into_iter()
            .flatten()
        {
            consume_text_bytes(total, value)?;
        }
        consume_bookmark_text(total, &item.items)?;
    }
    Ok(())
}

fn validate_native_mutation_text_budget(mutations: &NativeMutationsFile) -> Result<()> {
    let mut total = 0usize;
    for update in &mutations.updates {
        consume_text_bytes(&mut total, &update.text)?;
    }
    for note in mutations
        .notes
        .iter()
        .chain(mutations.free_text_notes.iter())
    {
        consume_text_bytes(&mut total, &note.stable_key)?;
        consume_text_bytes(&mut total, &note.text)?;
        for value in [note.author.as_deref(), note.color.as_deref()]
            .into_iter()
            .flatten()
        {
            consume_text_bytes(&mut total, value)?;
        }
    }
    for editor in &mutations.text_boxes {
        consume_text_bytes(&mut total, &editor.stable_key)?;
        if let Some(annotation_id) = editor.annotation_id.as_deref() {
            consume_text_bytes(&mut total, annotation_id)?;
        }
        consume_text_bytes(&mut total, &editor.text)?;
        if let Some(author) = editor.author.as_deref() {
            consume_text_bytes(&mut total, author)?;
        }
    }
    for delete in &mutations.deletes {
        if let Some(stable_key) = delete.stable_key.as_deref() {
            consume_text_bytes(&mut total, stable_key)?;
        }
    }
    if let Some(labels) = &mutations.page_labels {
        for range in &labels.ranges {
            consume_text_bytes(&mut total, &range.prefix)?;
            if let Some(style) = range.style.as_deref() {
                consume_text_bytes(&mut total, style)?;
            }
        }
    }
    if let Some(bookmarks) = &mutations.bookmarks {
        consume_text_bytes(&mut total, &bookmarks.untitled_label)?;
        consume_bookmark_text(&mut total, &bookmarks.items)?;
    }
    if let Some(shapes) = &mutations.shapes {
        for shape in &shapes.shapes {
            for value in [
                Some(shape.shape_type.as_str()),
                Some(shape.color.as_str()),
                shape.fill_color.as_deref(),
                shape.annotation_id.as_deref(),
                shape.stable_key.as_deref(),
                shape.pdf_subtype.as_deref(),
                shape.line_start_style.as_deref(),
                shape.line_end_style.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                consume_text_bytes(&mut total, value)?;
            }
        }
        for value in shapes
            .deleted_annotation_ids
            .iter()
            .chain(&shapes.deleted_stable_keys)
        {
            consume_text_bytes(&mut total, value)?;
        }
    }
    if let Some(markup) = &mutations.markup {
        for (annotation_id, subtype) in &markup.overrides {
            consume_text_bytes(&mut total, annotation_id)?;
            consume_text_bytes(&mut total, subtype)?;
        }
        for hint in &markup.hints {
            consume_text_bytes(&mut total, &hint.subtype)?;
            for value in [
                hint.annotation_id.as_deref(),
                hint.color.as_deref(),
                hint.id.as_deref(),
                hint.source.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                consume_text_bytes(&mut total, value)?;
            }
        }
    }
    for image in &mutations.placed_images {
        consume_text_bytes(&mut total, &image.mime_type)?;
        consume_text_bytes(&mut total, &image.bytes_path.to_string_lossy())?;
        consume_text_bytes(&mut total, &image.sha256)?;
    }
    Ok(())
}

#[cfg(test)]
mod bounded_input_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn ink_shape_with_strokes(strokes: Vec<Vec<ShapePoint>>) -> ShapeAnnotation {
        ShapeAnnotation {
            shape_type: "polyline".to_string(),
            page_index: 0,
            x: 0.1,
            y: 0.1,
            width: 0.3,
            height: 0.3,
            x2: None,
            y2: None,
            color: "#336699".to_string(),
            fill_color: None,
            opacity: 1.0,
            stroke_width: 1.0,
            points: Vec::new(),
            strokes,
            annotation_id: None,
            stable_key: Some("sec-006-ink".to_string()),
            pdf_subtype: Some("Ink".to_string()),
            line_start_style: None,
            line_end_style: None,
            created_at: None,
            modified_at: None,
        }
    }

    fn unit_shape_points(count: usize) -> Vec<ShapePoint> {
        (0..count).map(|_| ShapePoint { x: 0.2, y: 0.2 }).collect()
    }

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "evb-page-ops-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn page_selection_admission_reports_typed_byte_and_item_limits() {
        let path = temp_path("page-selection-limit");
        fs::write(&path, b"1\n2\n").unwrap();

        for error in [
            read_pages_file_with_limits(&path, 3, 10).unwrap_err(),
            read_pages_file_with_limits(&path, 16, 1).unwrap_err(),
        ] {
            let native = error.downcast_ref::<NativeError>().unwrap();
            assert_eq!(native.code, NativeErrorCode::TooLarge);
        }
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn native_mutation_decode_rejects_a_deep_bookmark_tree_without_stack_overflow() {
        let path = temp_path("deep-bookmark");
        let mut source =
            String::from(r#"{"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":["#);
        for index in 0..=10_000 {
            source.push_str(&format!(
                r#"{{"title":"Bookmark {index}","pageIndex":0,"pageYRatio":null,"namedDest":null,"bold":false,"italic":false,"color":null,"items":["#
            ));
        }
        for _ in 0..=10_000 {
            source.push_str("]}");
        }
        source.push_str("]}}");
        fs::write(&path, source).unwrap();

        let error = match read_native_mutations(&path) {
            Ok(_) => panic!("deep bookmark mutations must be rejected before native output"),
            Err(error) => error,
        };
        let native_error = error
            .downcast_ref::<NativeError>()
            .expect("sidecar decode failures should carry a native error");
        assert_eq!(native_error.code, NativeErrorCode::InvalidRequest);
        assert!(
            native_error.message.contains("recursion limit exceeded"),
            "unexpected deep bookmark error: {}",
            native_error.message
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn native_mutation_collection_budget_counts_nested_shape_geometry() {
        let shapes = (0..5)
            .map(|_| ink_shape_with_strokes(vec![unit_shape_points(MAX_SHAPE_MUTATION_POINTS - 1)]))
            .collect::<Vec<_>>();
        let mutations = NativeMutationsFile {
            shapes: Some(ShapesMutation {
                total_pages: 1,
                rewrite_shape_state: true,
                shapes,
                deleted_annotation_ids: vec!["deleted-shape".to_string()],
                deleted_stable_keys: Vec::new(),
            }),
            ..NativeMutationsFile::default()
        };

        validate_shapes_mutation(mutations.shapes.as_ref().unwrap())
            .expect("each shape and the aggregate point count should be individually bounded");
        let error = validate_native_mutation_collection_budget(&mutations)
            .expect_err("nested shape geometry must count toward the request budget");
        let native_error = error
            .downcast_ref::<NativeError>()
            .expect("aggregate budget errors should carry a native error");
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        assert!(native_error.message.contains("aggregate admission ceiling"));
    }

    #[test]
    fn native_mutations_accept_the_text_boxes_alias_but_reject_both_keys() {
        let editor = r#"{"pageIndex":0,"stableKey":"box","text":"text","rect":[1,1,20,20],"rotation":0,"fontSize":12,"color":[0,0,0]}"#;
        let canonical = format!(r#"{{"textBoxes":[{editor}]}}"#);
        let legacy = format!(r#"{{"freeTextEditors":[{editor}]}}"#);
        let duplicate = format!(r#"{{"textBoxes":[{editor}],"freeTextEditors":[{editor}]}}"#);

        let mut canonical: NativeMutationsFile = serde_json::from_str(&canonical).unwrap();
        assert_eq!(canonical.text_boxes.len(), 1);
        let legacy: NativeMutationsFile = serde_json::from_str(&legacy).unwrap();
        assert_eq!(legacy.text_boxes.len(), 1);
        let error = match serde_json::from_str::<NativeMutationsFile>(&duplicate) {
            Ok(_) => panic!("canonical and legacy text-box keys must not coexist"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("duplicate field"));

        canonical.text_boxes[0].annotation_id = Some("not-a-pdf-reference".to_string());
        let error = validate_text_boxes(&canonical.text_boxes).unwrap_err();
        assert_eq!(error.to_string(), "Invalid text box annotation id");
    }

    #[test]
    fn native_ink_shape_limits_bound_strokes_and_points_per_shape() {
        let point = ShapePoint { x: 0.2, y: 0.2 };
        let too_many_strokes = ink_shape_with_strokes(vec![
            vec![point.clone(), point.clone()];
            MAX_SHAPE_MUTATION_STROKES + 1
        ]);
        let stroke_error = validate_shapes_mutation(&ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![too_many_strokes],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        })
        .expect_err("an ink shape must reject an oversized stroke collection");
        assert!(stroke_error.to_string().contains("shape strokes"));

        let half_point_count = MAX_SHAPE_MUTATION_POINTS / 2 + 1;
        let too_many_points = ink_shape_with_strokes(vec![
            unit_shape_points(half_point_count),
            unit_shape_points(half_point_count),
        ]);
        let point_error = validate_shapes_mutation(&ShapesMutation {
            total_pages: 1,
            rewrite_shape_state: true,
            shapes: vec![too_many_points],
            deleted_annotation_ids: Vec::new(),
            deleted_stable_keys: Vec::new(),
        })
        .expect_err("an ink shape must reject an oversized per-shape point collection");
        assert!(point_error.to_string().contains("points per shape"));
    }
}
