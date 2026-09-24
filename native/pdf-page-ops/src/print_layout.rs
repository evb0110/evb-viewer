use super::*;
use evb_native_support::output::AtomicOutput;

/// Print layout places each selected page, with its printable annotation
/// appearances flattened, on an A4 sheet as a Form XObject: one page per sheet
/// in single view, or a spread of two in the facing modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrintViewMode {
    Single,
    Facing,
    FacingFirstSingle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrintOrientation {
    Auto,
    Portrait,
    Landscape,
}

impl PrintViewMode {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "single" => Ok(Self::Single),
            "facing" => Ok(Self::Facing),
            "facing-first-single" => Ok(Self::FacingFirstSingle),
            _ => Err(format!("Invalid print view mode: {value}").into()),
        }
    }
}

impl PrintOrientation {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "auto" => Ok(Self::Auto),
            "portrait" => Ok(Self::Portrait),
            "landscape" => Ok(Self::Landscape),
            _ => Err(format!("Invalid print orientation: {value}").into()),
        }
    }
}

const A4_WIDTH: f64 = 595.28;
const A4_HEIGHT: f64 = 841.89;
const ANNOTATION_FLAG_INVISIBLE: i64 = 1;
const ANNOTATION_FLAG_HIDDEN: i64 = 2;
const ANNOTATION_FLAG_PRINT: i64 = 4;

struct PlacedPage {
    form_id: ObjectId,
    width: f64,
    height: f64,
    rotation: i64,
}

impl PlacedPage {
    fn display_size(&self) -> (f64, f64) {
        if self.rotation == 90 || self.rotation == 270 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        }
    }

    /// `cm` operands that draw the form, turned clockwise by the page's
    /// /Rotate, with its displayed lower-left corner at (x, y).
    fn placement(&self, x: f64, y: f64, scale: f64) -> [f64; 6] {
        let width = self.width * scale;
        let height = self.height * scale;
        match self.rotation {
            90 => [0.0, -scale, scale, 0.0, x, y + width],
            180 => [-scale, 0.0, 0.0, -scale, x + width, y + height],
            270 => [0.0, scale, -scale, 0.0, x + height, y],
            _ => [scale, 0.0, 0.0, scale, x, y],
        }
    }
}

pub(crate) fn write_print_layout_path(
    input_path: &Path,
    output_path: &Path,
    pages: Option<&[u32]>,
    view_mode: PrintViewMode,
    orientation: PrintOrientation,
) -> Result<()> {
    let mut document = load_print_layout_pdf_path(input_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    build_print_layout(&mut document, pages, view_mode, orientation)?;
    let mut output = AtomicOutput::create(output_path)?;
    document.save_to(output.file_mut()?)?;
    output.publish_if_unchanged()?;
    Ok(())
}

pub(crate) fn build_print_layout(
    document: &mut Document,
    pages: Option<&[u32]>,
    view_mode: PrintViewMode,
    orientation: PrintOrientation,
) -> Result<()> {
    assert_plaintext_base(document, "Encrypted PDFs cannot be laid out for printing")?;
    let page_ids = document.get_pages();
    let page_numbers = normalize_print_page_numbers(pages, page_ids.len());
    if page_numbers.is_empty() {
        return Err("PDF print layout produced no pages".into());
    }
    let mut placed = Vec::with_capacity(page_numbers.len());
    for &page_number in &page_numbers {
        let page_id = resolve_page_id(&page_ids, page_number)?;
        placed.push(embed_page_as_form(document, page_id, page_number)?);
    }

    let pages_id = document.new_object_id();
    let mut sheet_ids = Vec::new();
    for spread in print_spreads(placed.len(), view_mode) {
        let sheet = if view_mode == PrintViewMode::Single {
            single_page_sheet(&placed[spread[0].unwrap()], orientation)
        } else {
            spread_sheet(&placed, spread, orientation)
        };
        sheet_ids.push(add_sheet(document, pages_id, sheet)?);
    }
    document.objects.insert(
        pages_id,
        Object::Dictionary(Dictionary::from_iter([
            ("Type", Object::Name(b"Pages".to_vec())),
            (
                "Kids",
                Object::Array(sheet_ids.iter().copied().map(Object::Reference).collect()),
            ),
            ("Count", Object::Integer(sheet_ids.len() as i64)),
        ])),
    );
    let catalog_id = document.add_object(Dictionary::from_iter([
        ("Type", Object::Name(b"Catalog".to_vec())),
        ("Pages", Object::Reference(pages_id)),
    ]));
    document.trailer = Dictionary::from_iter([("Root", Object::Reference(catalog_id))]);
    document.prune_objects();
    Ok(())
}

fn normalize_print_page_numbers(pages: Option<&[u32]>, total_pages: usize) -> Vec<u32> {
    let total_pages = u32::try_from(total_pages).unwrap_or(u32::MAX);
    let mut numbers = match pages {
        Some(pages) if !pages.is_empty() => pages
            .iter()
            .copied()
            .filter(|page| (1..=total_pages).contains(page))
            .collect::<Vec<_>>(),
        _ => (1..=total_pages).collect(),
    };
    numbers.sort_unstable();
    numbers.dedup();
    numbers
}

/// Indexes into the placed pages, two slots per spread. A lone page takes the
/// right slot on the first-single cover and the left slot everywhere else.
fn print_spreads(count: usize, view_mode: PrintViewMode) -> Vec<[Option<usize>; 2]> {
    if view_mode == PrintViewMode::Single {
        return (0..count).map(|index| [Some(index), None]).collect();
    }
    let mut spreads = Vec::new();
    let mut index = 0;
    if view_mode == PrintViewMode::FacingFirstSingle && count > 0 {
        spreads.push([None, Some(0)]);
        index = 1;
    }
    while index < count {
        let next = (index + 1 < count).then_some(index + 1);
        spreads.push([Some(index), next]);
        index += 2;
    }
    spreads
}

struct Sheet {
    width: f64,
    height: f64,
    draws: Vec<(ObjectId, [f64; 6])>,
}

fn a4_sheet(landscape: bool) -> (f64, f64) {
    if landscape {
        (A4_HEIGHT, A4_WIDTH)
    } else {
        (A4_WIDTH, A4_HEIGHT)
    }
}

fn is_landscape(orientation: PrintOrientation, width: f64, height: f64) -> bool {
    match orientation {
        PrintOrientation::Landscape => true,
        PrintOrientation::Portrait => false,
        PrintOrientation::Auto => width > height,
    }
}

fn single_page_sheet(page: &PlacedPage, orientation: PrintOrientation) -> Sheet {
    let (display_width, display_height) = page.display_size();
    let (width, height) = a4_sheet(is_landscape(orientation, display_width, display_height));
    let scale = (width / display_width.max(1.0)).min(height / display_height.max(1.0));
    let x = (width - display_width * scale) / 2.0;
    let y = (height - display_height * scale) / 2.0;
    Sheet {
        width,
        height,
        draws: vec![(page.form_id, page.placement(x, y, scale))],
    }
}

fn spread_sheet(
    placed: &[PlacedPage],
    spread: [Option<usize>; 2],
    orientation: PrintOrientation,
) -> Sheet {
    let pages = spread.map(|slot| slot.map(|index| &placed[index]));
    let visible = pages.iter().flatten().collect::<Vec<_>>();
    let blank_width = visible[0].display_size().0;
    let slot_widths = pages.map(|page| page.map_or(blank_width, |page| page.display_size().0));
    let natural_width = slot_widths[0] + slot_widths[1];
    let natural_height = visible
        .iter()
        .map(|page| page.display_size().1)
        .fold(f64::MIN, f64::max);
    // A spread prints landscape unless portrait is asked for.
    let (width, height) = a4_sheet(orientation != PrintOrientation::Portrait);
    let scale = (width / natural_width).min(height / natural_height);
    let top_inset = (height - natural_height * scale) / 2.0;
    let mut cursor_x = (width - natural_width * scale) / 2.0;
    let mut draws = Vec::new();
    for (page, slot_width) in pages.into_iter().zip(slot_widths) {
        if let Some(page) = page {
            let draw_height = page.display_size().1 * scale;
            draws.push((
                page.form_id,
                page.placement(cursor_x, height - top_inset - draw_height, scale),
            ));
        }
        cursor_x += slot_width * scale;
    }
    Sheet {
        width,
        height,
        draws,
    }
}

fn add_sheet(document: &mut Document, pages_id: ObjectId, sheet: Sheet) -> Result<ObjectId> {
    let mut content = String::new();
    let mut xobjects = Dictionary::new();
    for (index, (form_id, matrix)) in sheet.draws.into_iter().enumerate() {
        let name = format!("P{index}");
        content.push_str(&format!("q {} cm /{name} Do Q\n", format_operands(&matrix)));
        xobjects.set(name, Object::Reference(form_id));
    }
    let mut contents = Stream::new(Dictionary::new(), content.into_bytes());
    let _ = contents.compress();
    let contents_id = document.add_object(contents);
    Ok(document.add_object(Dictionary::from_iter([
        ("Type", Object::Name(b"Page".to_vec())),
        ("Parent", Object::Reference(pages_id)),
        (
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                number_object(sheet.width),
                number_object(sheet.height),
            ]),
        ),
        (
            "Resources",
            Object::Dictionary(Dictionary::from_iter([(
                "XObject",
                Object::Dictionary(xobjects),
            )])),
        ),
        ("Contents", Object::Reference(contents_id)),
    ])))
}

fn format_operands(values: &[f64]) -> String {
    values
        .iter()
        .map(|value| {
            let rounded = format!("{value:.4}");
            let trimmed = rounded.trim_end_matches('0').trim_end_matches('.');
            if trimmed == "-0" {
                "0".to_string()
            } else {
                trimmed.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn read_box(document: &Document, page: &Dictionary, key: &[u8]) -> Result<Option<PdfRect>> {
    let Ok(object) = page.get(key) else {
        return Ok(None);
    };
    let values = document.dereference(object)?.1.as_array()?;
    if values.len() != 4 {
        return Ok(None);
    }
    let mut numbers = [0.0; 4];
    for (slot, value) in numbers.iter_mut().zip(values) {
        *slot = object_to_f64(document.dereference(value)?.1)?;
    }
    let rect = PdfRect {
        x1: numbers[0].min(numbers[2]),
        y1: numbers[1].min(numbers[3]),
        x2: numbers[0].max(numbers[2]),
        y2: numbers[1].max(numbers[3]),
    };
    Ok((rect.width() > 0.0 && rect.height() > 0.0).then_some(rect))
}

/// The visible box is the CropBox clipped to the MediaBox.
fn visible_box(document: &Document, page: &Dictionary) -> Result<PdfRect> {
    let media =
        read_box(document, page, b"MediaBox")?.ok_or("PDF page has an invalid media box")?;
    let Some(crop) = read_box(document, page, b"CropBox")? else {
        return Ok(media);
    };
    let clipped = PdfRect {
        x1: crop.x1.max(media.x1),
        y1: crop.y1.max(media.y1),
        x2: crop.x2.min(media.x2),
        y2: crop.y2.min(media.y2),
    };
    Ok(if clipped.width() > 0.0 && clipped.height() > 0.0 {
        clipped
    } else {
        media
    })
}

fn resolved_dictionary(document: &Document, object: Option<&Object>) -> Result<Dictionary> {
    match object {
        Some(object) => Ok(document.dereference(object)?.1.as_dict()?.clone()),
        None => Ok(Dictionary::new()),
    }
}

fn decoded_page_content(document: &Document, page: &Dictionary) -> Result<Vec<u8>> {
    let Ok(contents) = page.get(b"Contents") else {
        return Ok(Vec::new());
    };
    let streams = match document.dereference(contents)?.1 {
        Object::Array(items) => items.clone(),
        _ => vec![contents.clone()],
    };
    let mut content = Vec::new();
    for item in &streams {
        let stream = document.dereference(item)?.1.as_stream()?;
        content.extend(stream.decompressed_content_with_limit(MAX_DECOMPRESSED_PDF_STREAM_BYTES)?);
        content.push(b'\n');
    }
    Ok(content)
}

fn embed_page_as_form(
    document: &mut Document,
    page_id: ObjectId,
    page_number: u32,
) -> Result<PlacedPage> {
    let page = materialized_page_dictionary(document, page_id)?;
    let bounds = visible_box(document, &page)?;
    let rotation = normalize_page_rotation(match page.get(b"Rotate") {
        Ok(object) => document.dereference(object)?.1.as_i64()?,
        Err(_) => 0,
    });
    let mut resources = resolved_dictionary(document, page.get(b"Resources").ok())?;
    let mut content = b"q\n".to_vec();
    content.extend(decoded_page_content(document, &page)?);
    content.extend_from_slice(b"Q\n");
    flatten_printable_annotations(document, &page, page_number, &mut resources, &mut content)?;
    let mut form = Stream::new(
        Dictionary::from_iter([
            ("Type", Object::Name(b"XObject".to_vec())),
            ("Subtype", Object::Name(b"Form".to_vec())),
            ("FormType", Object::Integer(1)),
            (
                "BBox",
                Object::Array(
                    [bounds.x1, bounds.y1, bounds.x2, bounds.y2]
                        .map(number_object)
                        .to_vec(),
                ),
            ),
            (
                "Matrix",
                Object::Array(
                    [1.0, 0.0, 0.0, 1.0, -bounds.x1, -bounds.y1]
                        .map(number_object)
                        .to_vec(),
                ),
            ),
            ("Resources", Object::Dictionary(resources)),
        ]),
        content,
    );
    let _ = form.compress();
    Ok(PlacedPage {
        form_id: document.add_object(form),
        width: bounds.width(),
        height: bounds.height(),
        rotation,
    })
}

fn unused_resource_name(category: &Dictionary, prefix: &str) -> String {
    (0..)
        .map(|index| format!("{prefix}{index}"))
        .find(|name| !category.has(name.as_bytes()))
        .expect("an unused resource name exists")
}

fn numbers(document: &Document, object: &Object, count: usize) -> Option<Vec<f64>> {
    let values = document.dereference(object).ok()?.1.as_array().ok()?;
    if values.len() != count {
        return None;
    }
    values
        .iter()
        .map(|value| {
            document
                .dereference(value)
                .ok()
                .and_then(|(_, value)| object_to_f64(value).ok())
        })
        .collect()
}

/// The normal appearance of an annotation: the /N stream, or the /AS state of
/// an /N subdictionary.
fn normal_appearance(document: &Document, annotation: &Dictionary) -> Option<ObjectId> {
    let appearances = document
        .dereference(annotation.get(b"AP").ok()?)
        .ok()?
        .1
        .as_dict()
        .ok()?;
    let normal = appearances.get(b"N").ok()?;
    let (normal_id, resolved) = document.dereference(normal).ok()?;
    if resolved.as_stream().is_ok() {
        return normal_id;
    }
    let state = annotation.get(b"AS").ok()?.as_name().ok()?;
    let state_object = resolved.as_dict().ok()?.get(state).ok()?;
    let (state_id, state_resolved) = document.dereference(state_object).ok()?;
    state_resolved.as_stream().ok().and(state_id)
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
fn flatten_printable_annotations(
    document: &mut Document,
    page: &Dictionary,
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
    let mut drew = false;
    for item in &annotations {
        let annotation = document.dereference(item)?.1.as_dict()?.clone();
        let flags = annotation
            .get(b"F")
            .ok()
            .and_then(|flags| document.dereference(flags).ok())
            .and_then(|(_, flags)| flags.as_i64().ok())
            .unwrap_or(0);
        let printable = flags & ANNOTATION_FLAG_PRINT != 0
            && flags & (ANNOTATION_FLAG_INVISIBLE | ANNOTATION_FLAG_HIDDEN) == 0;
        let is_popup = annotation
            .get(b"Subtype")
            .and_then(Object::as_name)
            .is_ok_and(|subtype| subtype == b"Popup");
        if !printable || is_popup {
            continue;
        }
        let appearance_id = normal_appearance(document, &annotation).ok_or_else(|| {
            format!("Printable annotation on page {page_number} has no normal appearance")
        })?;
        let appearance = document.get_object(appearance_id)?.as_stream()?;
        if appearance.content.is_empty() {
            continue;
        }
        let invalid_bbox =
            || format!("Printable annotation on page {page_number} has an invalid appearance BBox");
        let bbox = appearance
            .dict
            .get(b"BBox")
            .ok()
            .and_then(|bbox| numbers(document, bbox, 4))
            .ok_or_else(invalid_bbox)?;
        if bbox[2] <= bbox[0] || bbox[3] <= bbox[1] {
            return Err(invalid_bbox().into());
        }
        let matrix = match appearance.dict.get(b"Matrix") {
            Ok(matrix) => numbers(document, matrix, 6).ok_or_else(|| {
                format!(
                    "Printable annotation on page {page_number} has an invalid appearance Matrix"
                )
            })?,
            Err(_) => vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        };
        let rect = annotation
            .get(b"Rect")
            .ok()
            .and_then(|rect| numbers(document, rect, 4))
            .filter(|rect| rect[2] > rect[0] && rect[3] > rect[1])
            .ok_or_else(|| {
                format!("Printable annotation on page {page_number} has an invalid Rect")
            })?;
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
            return Err(format!(
                "Printable annotation on page {page_number} has a degenerate appearance BBox"
            )
            .into());
        }
        let rect_width = rect[2] - rect[0];
        let rect_height = rect[3] - rect[1];
        let scale_x = rect_width / width;
        let scale_y = rect_height / height;

        let appearance_name = unused_resource_name(&xobjects, "PrintAnnot");
        xobjects.set(appearance_name.clone(), Object::Reference(appearance_id));
        let graphics_state = match annotation_graphics_state(document, &annotation, page_number)? {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn page_document(pages: &[(PdfRect, i64)]) -> Document {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let mut kids = Vec::new();
        for (media_box, rotation) in pages {
            let content = document.add_object(Stream::new(
                Dictionary::new(),
                b"0 0 1 rg 0 0 10 10 re f".to_vec(),
            ));
            kids.push(Object::Reference(
                document.add_object(Dictionary::from_iter([
                    ("Type", Object::Name(b"Page".to_vec())),
                    ("Parent", Object::Reference(pages_id)),
                    (
                        "MediaBox",
                        Object::Array(
                            [media_box.x1, media_box.y1, media_box.x2, media_box.y2]
                                .map(number_object)
                                .to_vec(),
                        ),
                    ),
                    ("Rotate", Object::Integer(*rotation)),
                    ("Contents", Object::Reference(content)),
                ])),
            ));
        }
        let count = kids.len() as i64;
        document.objects.insert(
            pages_id,
            Object::Dictionary(Dictionary::from_iter([
                ("Type", Object::Name(b"Pages".to_vec())),
                ("Kids", Object::Array(kids)),
                ("Count", Object::Integer(count)),
            ])),
        );
        let catalog = document.add_object(Dictionary::from_iter([
            ("Type", Object::Name(b"Catalog".to_vec())),
            ("Pages", Object::Reference(pages_id)),
        ]));
        document.trailer.set("Root", catalog);
        document
    }

    fn letter() -> PdfRect {
        PdfRect {
            x1: 0.0,
            y1: 0.0,
            x2: 612.0,
            y2: 792.0,
        }
    }

    const A4: (i64, i64) = (595, 842);
    const A4_LANDSCAPE: (i64, i64) = (842, 595);

    fn sheet_sizes(document: &Document) -> Vec<(i64, i64)> {
        document
            .get_pages()
            .values()
            .map(|page_id| {
                let page = document.get_dictionary(*page_id).unwrap();
                let media = read_box(document, page, b"MediaBox").unwrap().unwrap();
                (media.width().round() as i64, media.height().round() as i64)
            })
            .collect()
    }

    #[test]
    fn single_view_puts_each_selected_page_on_its_own_sheet_in_page_order() {
        let mut document = page_document(&[(letter(), 0), (letter(), 90), (letter(), 0)]);
        build_print_layout(
            &mut document,
            Some(&[3, 2, 3, 9]),
            PrintViewMode::Single,
            PrintOrientation::Auto,
        )
        .unwrap();

        // Page 2 is turned a quarter, so it displays landscape.
        assert_eq!(sheet_sizes(&document), vec![A4_LANDSCAPE, A4]);
    }

    #[test]
    fn facing_first_single_leaves_the_cover_alone_on_a_landscape_sheet() {
        let mut document = page_document(&[(letter(), 0), (letter(), 0), (letter(), 0)]);
        build_print_layout(
            &mut document,
            None,
            PrintViewMode::FacingFirstSingle,
            PrintOrientation::Auto,
        )
        .unwrap();

        assert_eq!(sheet_sizes(&document), vec![A4_LANDSCAPE, A4_LANDSCAPE]);
        assert_eq!(
            print_spreads(3, PrintViewMode::FacingFirstSingle),
            vec![[None, Some(0)], [Some(1), Some(2)],]
        );
        assert_eq!(
            print_spreads(3, PrintViewMode::Facing),
            vec![[Some(0), Some(1)], [Some(2), None],]
        );
    }

    #[test]
    fn flattens_printable_appearances_at_their_rect_in_page_space() {
        let mut document = page_document(&[(letter(), 0)]);
        let page_id = *document.get_pages().get(&1).unwrap();
        let mut annotations = Vec::new();
        for (flags, rect) in [(4, [100, 400, 300, 500]), (6, [10, 10, 20, 20])] {
            let appearance = document.add_object(Stream::new(
                Dictionary::from_iter([(
                    "BBox",
                    Object::Array([0, 0, 100, 50].map(Object::Integer).to_vec()),
                )]),
                b"1 0 0 rg 0 0 100 50 re f".to_vec(),
            ));
            annotations.push(Object::Reference(document.add_object(
                Dictionary::from_iter([
                    ("Subtype", Object::Name(b"Square".to_vec())),
                    ("F", Object::Integer(flags)),
                    ("Rect", Object::Array(rect.map(Object::Integer).to_vec())),
                    ("CA", Object::Real(0.5)),
                    (
                        "AP",
                        Object::Dictionary(Dictionary::from_iter([(
                            "N",
                            Object::Reference(appearance),
                        )])),
                    ),
                ]),
            )));
        }
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set("Annots", Object::Array(annotations));
        page.set(
            "CropBox",
            Object::Array([50, 60, 500, 700].map(Object::Integer).to_vec()),
        );

        build_print_layout(
            &mut document,
            None,
            PrintViewMode::Single,
            PrintOrientation::Auto,
        )
        .unwrap();

        let sheet_id = *document.get_pages().get(&1).unwrap();
        let sheet = document.get_dictionary(sheet_id).unwrap();
        let form_id = sheet
            .get(b"Resources")
            .and_then(Object::as_dict)
            .and_then(|resources| resources.get(b"XObject"))
            .and_then(Object::as_dict)
            .and_then(|xobjects| xobjects.get(b"P0"))
            .and_then(Object::as_reference)
            .unwrap();
        let form = document.get_object(form_id).unwrap().as_stream().unwrap();
        let content = String::from_utf8(form.decompressed_content().unwrap()).unwrap();
        // The form's Matrix moves the CropBox origin, so the annotation keeps
        // its /Rect in page space; the hidden one is not drawn.
        assert!(content.contains(
            "q /PrintAnnot0 gs 100 400 200 100 re W n 2 0 0 2 100 400 cm /PrintAnnot0 Do Q"
        ));
        assert_eq!(content.matches(" Do Q").count(), 1);
        assert!(sheet.get(b"Annots").is_err());
    }

    #[test]
    fn placement_turns_the_form_clockwise_into_the_displayed_box() {
        let page = PlacedPage {
            form_id: (1, 0),
            width: 100.0,
            height: 50.0,
            rotation: 90,
        };
        let [a, b, c, d, e, f] = page.placement(10.0, 20.0, 1.0);
        let map = |x: f64, y: f64| (a * x + c * y + e, b * x + d * y + f);
        // The form's top-left corner lands on the displayed top-right corner.
        assert_eq!(map(0.0, 50.0), (60.0, 120.0));
        assert_eq!(map(100.0, 0.0), (10.0, 20.0));
    }
}
