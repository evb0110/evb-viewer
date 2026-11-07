use evb_native_support::output::AtomicOutput;
use lopdf::{
    content::{Content, Operation},
    DecompressError, Dictionary, Document, Error as LopdfError, Object, ObjectId,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Seek, SeekFrom, Write},
    path::Path,
};

use crate::{
    assert_plaintext_base, classify_pdf_load_error, domain_error, intersect_rect, load_pdf_path,
    load_readonly_metadata_pdf_path, reclassify_domain_error, resolve_inherited_box,
    resolve_page_rotation, resolve_page_user_unit, resolve_page_view, AppendedRevision,
    NativeErrorCode, PageTreeResolver, PdfObjectSource, PdfRect, QpdfMetadataPurpose, Result,
    MAX_DECOMPRESSED_PDF_STREAM_BYTES, MAX_ENCODED_PDF_BYTES,
};

pub(crate) const PAGE_SIZES_SIDECAR_FORMAT: &str = "evb-pdf-page-sizes";
pub(crate) const PAGE_SIZES_SIDECAR_SCHEMA_VERSION: u64 = 1;
pub(crate) const PAGE_SIZES_SIDECAR_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const PAGE_COUNT_FIELD_WIDTH: usize = 20;

#[derive(Clone, Copy)]
enum DominantImageAnalysis {
    Performed,
    Unavailable,
    #[cfg(test)]
    Skipped,
}

impl DominantImageAnalysis {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Performed => "performed",
            Self::Unavailable => "unavailable",
            #[cfg(test)]
            Self::Skipped => "skipped",
        }
    }
}

#[cfg(test)]
struct PageSizesOutput {
    pages: Vec<PageSizeEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageSizeEntry {
    page_number: u32,
    x_points: f64,
    y_points: f64,
    width_points: f64,
    height_points: f64,
    width_inches: f64,
    height_inches: f64,
    rotation: i64,
    user_unit: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_x_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_y_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_width_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_height_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    crop_x_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    crop_y_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    crop_width_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    crop_height_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dominant_image_width_px: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dominant_image_height_px: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dominant_image_width_points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dominant_image_height_points: Option<f64>,
}

#[derive(Clone, Copy)]
struct Matrix {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Matrix {
    const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    fn concat(self, rhs: Self) -> Self {
        Self {
            a: self.a * rhs.a + self.c * rhs.b,
            b: self.b * rhs.a + self.d * rhs.b,
            c: self.a * rhs.c + self.c * rhs.d,
            d: self.b * rhs.c + self.d * rhs.d,
            e: self.a * rhs.e + self.c * rhs.f + self.e,
            f: self.b * rhs.e + self.d * rhs.f + self.f,
        }
    }

    /// This matrix applied inside `outer`: the CTM after `outer` concatenates it.
    #[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
    fn concat_onto(self, outer: Self) -> Self {
        outer.concat(self)
    }

    fn transform(self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }
}

#[derive(Clone, Copy, Debug)]
struct FullPageImage {
    width_px: i64,
    height_px: i64,
    width_points: f64,
    height_points: f64,
}

pub(crate) fn resolved_dictionary<'a>(
    document: &'a Document,
    object: &'a Object,
) -> Option<&'a Dictionary> {
    document.resolved(object).ok()?.as_dict().ok()
}

fn collect_image_dimensions(
    document: &Document,
    resources: &Dictionary,
    images: &mut HashMap<Vec<u8>, (i64, i64)>,
) {
    let Some(xobjects) = resources
        .get(b"XObject")
        .ok()
        .and_then(|object| resolved_dictionary(document, object))
    else {
        return;
    };
    for (name, object) in xobjects {
        let stream = match object {
            Object::Reference(id) => document.get_object(*id).and_then(Object::as_stream).ok(),
            Object::Stream(stream) => Some(stream),
            _ => None,
        };
        let Some(stream) = stream else {
            continue;
        };
        if stream.dict.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Image") {
            continue;
        }
        let width = stream.dict.get(b"Width").and_then(Object::as_i64).ok();
        let height = stream.dict.get(b"Height").and_then(Object::as_i64).ok();
        if let (Some(width), Some(height)) = (width, height) {
            if width > 0 && height > 0 {
                images.insert(name.clone(), (width, height));
            }
        }
    }
}

fn page_image_dimensions(
    document: &Document,
    page_id: ObjectId,
) -> Result<HashMap<Vec<u8>, (i64, i64)>> {
    let (direct_resources, resource_ids) = document.get_page_resources(page_id)?;
    let mut images = HashMap::new();
    // Inherited resources are the fallback; a nearer page resource with the
    // same name overrides them.
    for resource_id in resource_ids.into_iter().rev() {
        if let Ok(resources) = document.get_dictionary(resource_id) {
            collect_image_dimensions(document, resources, &mut images);
        }
    }
    if let Some(resources) = direct_resources {
        collect_image_dimensions(document, resources, &mut images);
    }
    Ok(images)
}

fn object_number(object: &Object) -> Option<f64> {
    object.as_float().ok().map(f64::from)
}

fn covers_page(matrix: Matrix, page_view: PdfRect) -> bool {
    let corners = [
        matrix.transform(0.0, 0.0),
        matrix.transform(1.0, 0.0),
        matrix.transform(0.0, 1.0),
        matrix.transform(1.0, 1.0),
    ];
    let min_x = corners
        .iter()
        .map(|(x, _)| *x)
        .fold(f64::INFINITY, f64::min);
    let max_x = corners
        .iter()
        .map(|(x, _)| *x)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = corners
        .iter()
        .map(|(_, y)| *y)
        .fold(f64::INFINITY, f64::min);
    let max_y = corners
        .iter()
        .map(|(_, y)| *y)
        .fold(f64::NEG_INFINITY, f64::max);
    let overlap_width = (max_x.min(page_view.x2) - min_x.max(page_view.x1)).max(0.0);
    let overlap_height = (max_y.min(page_view.y2) - min_y.max(page_view.y1)).max(0.0);
    overlap_width >= page_view.width() * 0.98 && overlap_height >= page_view.height() * 0.98
}

fn decode_page_content_with_limit(
    document: &Document,
    page_id: ObjectId,
    max_decompressed_bytes: usize,
) -> Result<Content<Vec<Operation>>> {
    Ok(decode_page_content_with_inline_images(document, page_id, max_decompressed_bytes)?.0)
}

/// Each inline image's declared facts, in content order.
type InlineImages = Vec<crate::content_parse::TInlineImageFacts>;

fn decode_page_content_with_inline_images(
    document: &Document,
    page_id: ObjectId,
    max_decompressed_bytes: usize,
) -> Result<(Content<Vec<Operation>>, InlineImages)> {
    let bytes = crate::page_content_with_limit(document, page_id, max_decompressed_bytes)
        .map_err(|error| {
            if matches!(
                error,
                LopdfError::Decompress(DecompressError::MemoryLimitExceeded { .. })
            ) {
                domain_error(
                    NativeErrorCode::TooLarge,
                    format!(
                        "PDF page content exceeds the {max_decompressed_bytes}-byte decompression ceiling"
                    ),
                )
            } else {
                domain_error(
                    NativeErrorCode::CorruptXref,
                    format!("Failed to decode PDF page content: {error}"),
                )
            }
        })?;
    let (content, inline_images) = crate::content_parse::parse_content_with_inline_images(&bytes)?;
    let content = content.map_err(|error| {
        domain_error(
            NativeErrorCode::CorruptXref,
            format!("Failed to parse PDF page content: {error}"),
        )
    })?;
    Ok((content, inline_images))
}

fn dominant_full_page_image_with_limit(
    document: &Document,
    page_id: ObjectId,
    page_view: PdfRect,
    max_decompressed_bytes: usize,
) -> Result<Option<FullPageImage>> {
    let images = page_image_dimensions(document, page_id)
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::CorruptXref))?;
    if images.is_empty() {
        return Ok(None);
    }
    let content = decode_page_content_with_limit(document, page_id, max_decompressed_bytes)?;
    let mut matrix = Matrix::IDENTITY;
    let mut stack = Vec::new();
    let mut dominant: Option<FullPageImage> = None;

    for operation in content.operations {
        match operation.operator.as_str() {
            "q" => stack.push(matrix),
            "Q" => matrix = stack.pop().unwrap_or(Matrix::IDENTITY),
            "cm" if operation.operands.len() == 6 => {
                let values = operation
                    .operands
                    .iter()
                    .map(object_number)
                    .collect::<Option<Vec<_>>>();
                if let Some(values) = values {
                    matrix = matrix.concat(Matrix {
                        a: values[0],
                        b: values[1],
                        c: values[2],
                        d: values[3],
                        e: values[4],
                        f: values[5],
                    });
                }
            }
            "Do" if operation.operands.len() == 1 && covers_page(matrix, page_view) => {
                let Ok(name) = operation.operands[0].as_name() else {
                    continue;
                };
                let Some(&(width_px, height_px)) = images.get(name) else {
                    continue;
                };
                let candidate = FullPageImage {
                    width_px,
                    height_px,
                    width_points: matrix.a.hypot(matrix.b),
                    height_points: matrix.c.hypot(matrix.d),
                };
                if candidate.width_points <= 0.0 || candidate.height_points <= 0.0 {
                    continue;
                }
                let candidate_area = candidate.width_px.saturating_mul(candidate.height_px);
                let dominant_area = dominant
                    .map(|image| image.width_px.saturating_mul(image.height_px))
                    .unwrap_or(0);
                if candidate_area > dominant_area {
                    dominant = Some(candidate);
                }
            }
            _ => {}
        }
    }
    Ok(dominant)
}

fn dominant_full_page_image(
    document: &Document,
    page_id: ObjectId,
    page_view: PdfRect,
) -> Result<Option<FullPageImage>> {
    dominant_full_page_image_with_limit(
        document,
        page_id,
        page_view,
        MAX_DECOMPRESSED_PDF_STREAM_BYTES,
    )
}

#[cfg(test)]
fn collect_page_sizes(document: &Document) -> Result<PageSizesOutput> {
    let page_resolver = PageTreeResolver::new(document)?;
    let mut pages = Vec::new();
    page_resolver.for_each_page_id(document, |page_id| {
        let page_number = u32::try_from(pages.len())
            .ok()
            .and_then(|number| number.checked_add(1))
            .ok_or("Page-size page number overflow")?;
        let page_view = resolve_page_view(document, page_id)?;
        let rotation = resolve_page_rotation(document, page_id)?;
        let dominant_image = dominant_full_page_image(document, page_id, page_view)?;
        pages.push(page_size_entry(
            document,
            page_number,
            page_id,
            rotation,
            page_view,
            dominant_image,
        )?);
        Ok(())
    })?;

    Ok(PageSizesOutput { pages })
}

fn page_size_entry(
    document: &impl PdfObjectSource,
    page_number: u32,
    page_id: ObjectId,
    rotation: i64,
    page_view: PdfRect,
    dominant_image: Option<FullPageImage>,
) -> Result<PageSizeEntry> {
    let media_box = resolve_inherited_box(document, page_id, b"MediaBox")?;
    let crop_box = resolve_inherited_box(document, page_id, b"CropBox")
        .ok()
        .and_then(|crop_box| intersect_rect(crop_box, media_box));

    Ok(PageSizeEntry {
        page_number,
        x_points: page_view.x1,
        y_points: page_view.y1,
        width_points: page_view.width(),
        height_points: page_view.height(),
        width_inches: page_view.width() / 72.0,
        height_inches: page_view.height() / 72.0,
        rotation,
        user_unit: resolve_page_user_unit(document, page_id)?,
        media_x_points: Some(media_box.x1),
        media_y_points: Some(media_box.y1),
        media_width_points: Some(media_box.width()),
        media_height_points: Some(media_box.height()),
        crop_x_points: crop_box.map(|rect| rect.x1),
        crop_y_points: crop_box.map(|rect| rect.y1),
        crop_width_points: crop_box.map(PdfRect::width),
        crop_height_points: crop_box.map(PdfRect::height),
        dominant_image_width_px: dominant_image.map(|image| image.width_px),
        dominant_image_height_px: dominant_image.map(|image| image.height_px),
        dominant_image_width_points: dominant_image.map(|image| image.width_points),
        dominant_image_height_points: dominant_image.map(|image| image.height_points),
    })
}

/// One image a page paints, as `pdfimages -list` reports it: an image or
/// stencil, or the active soft or explicit mask attached to an image, which
/// carries its parent image's object number (zero for an inline image).
/// Resolution is the image's pixels over the placement it is painted at, as
/// the listing prints it and desktop parses it back.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RasterUse {
    kind: &'static str,
    width_px: i64,
    height_px: i64,
    bits_per_component: i64,
    object_number: u32,
    x_ppi: i64,
    y_ppi: i64,
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
const MAX_FORM_XOBJECT_DEPTH: usize = 12;

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
struct RasterInventory {
    uses: Vec<RasterUse>,
    /// False where the page may paint images this walk could not read or
    /// measure, as where pdfimages skips content.
    complete: bool,
}

/// The names a content stream resolves: its XObjects and marked-content properties.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
struct ResourceScope<'a> {
    xobjects: HashMap<Vec<u8>, &'a Object>,
    properties: HashMap<Vec<u8>, &'a Object>,
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn resource_scope<'a>(
    document: &'a Document,
    resources: impl Iterator<Item = &'a Dictionary>,
) -> ResourceScope<'a> {
    let mut scope = ResourceScope {
        xobjects: HashMap::new(),
        properties: HashMap::new(),
    };
    for resources in resources {
        for (key, names) in [
            (b"XObject".as_slice(), &mut scope.xobjects),
            (b"Properties".as_slice(), &mut scope.properties),
        ] {
            if let Some(dictionary) = resources
                .get(key)
                .ok()
                .and_then(|object| resolved_dictionary(document, object))
            {
                for (name, object) in dictionary {
                    names.insert(name.clone(), object);
                }
            }
        }
    }
    scope
}

/// The document's default optional-content configuration, which decides
/// whether marked content and XObjects in a layer are painted at all.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
struct OptionalContent {
    base_off: bool,
    on: Vec<ObjectId>,
    off: Vec<ObjectId>,
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
impl OptionalContent {
    fn read(document: &Document) -> Self {
        let configuration = document
            .catalog()
            .ok()
            .and_then(|catalog| catalog.get(b"OCProperties").ok())
            .and_then(|object| resolved_dictionary(document, object))
            .and_then(|properties| properties.get(b"D").ok())
            .and_then(|object| resolved_dictionary(document, object));
        let references = |key: &[u8]| {
            configuration
                .and_then(|configuration| configuration.get(key).ok())
                .and_then(|object| document.resolved(object).ok())
                .and_then(|object| object.as_array().ok())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_reference().ok())
                        .collect()
                })
                .unwrap_or_default()
        };
        Self {
            base_off: configuration
                .and_then(|configuration| configuration.get(b"BaseState").ok())
                .and_then(|object| object.as_name().ok())
                == Some(b"OFF".as_slice()),
            on: references(b"ON"),
            off: references(b"OFF"),
        }
    }

    fn group_visible(&self, id: ObjectId) -> bool {
        if self.base_off {
            self.on.contains(&id)
        } else {
            !self.off.contains(&id)
        }
    }

    /// Whether an optional-content group or membership dictionary is shown.
    fn visible(&self, document: &Document, object: &Object, complete: &mut bool) -> bool {
        let Some(dictionary) = resolved_dictionary(document, object) else {
            return true;
        };
        match dictionary.get(b"Type").and_then(Object::as_name).ok() {
            Some(b"OCG") => object
                .as_reference()
                .map_or(true, |id| self.group_visible(id)),
            Some(b"OCMD") => {
                if dictionary.has(b"VE") {
                    *complete = false;
                    return true;
                }
                let groups: Vec<ObjectId> = match dictionary.get(b"OCGs").ok().and_then(|object| {
                    document
                        .resolved(object)
                        .ok()
                        .map(|resolved| (object, resolved))
                }) {
                    Some((_, Object::Array(values))) => values
                        .iter()
                        .filter_map(|value| value.as_reference().ok())
                        .collect(),
                    Some((Object::Reference(id), _)) => vec![*id],
                    _ => return true,
                };
                let shown = groups.iter().map(|id| self.group_visible(*id));
                match dictionary.get(b"P").and_then(Object::as_name).ok() {
                    Some(b"AllOn") => shown.into_iter().all(|on| on),
                    Some(b"AnyOff") => shown.into_iter().any(|on| !on),
                    Some(b"AllOff") => shown.into_iter().all(|on| !on),
                    _ => shown.into_iter().any(|on| on),
                }
            }
            _ => true,
        }
    }
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn dictionary_value<'a>(
    document: &'a Document,
    dictionary: &'a Dictionary,
    keys: &[&[u8]],
) -> Option<&'a Object> {
    keys.iter()
        .find_map(|key| dictionary.get(key).ok())
        .and_then(|object| document.resolved(object).ok())
}

/// Pixels over painted points, as pdfimages prints it and desktop parses it
/// back: a whole number rounded half to even, and zero below one.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn image_ppi(pixels: i64, matrix_x: f64, matrix_y: f64) -> i64 {
    let points = matrix_x.hypot(matrix_y);
    if points <= 0.0 || !points.is_finite() {
        return 0;
    }
    let ppi = pixels as f64 * 72.0 / points;
    if ppi >= 1.0 {
        ppi.round_ties_even() as i64
    } else {
        0
    }
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn push_raster_use(
    document: &Document,
    inventory: &mut RasterInventory,
    kind: &'static str,
    dictionary: &Dictionary,
    bits_per_component: i64,
    object_number: u32,
    matrix: Matrix,
) {
    let dimension = |keys: &[&[u8]]| {
        dictionary_value(document, dictionary, keys)
            .and_then(|object| object.as_i64().ok())
            .filter(|value| *value > 0)
    };
    let (Some(width_px), Some(height_px)) =
        (dimension(&[b"Width", b"W"]), dimension(&[b"Height", b"H"]))
    else {
        inventory.complete = false;
        return;
    };
    inventory.uses.push(RasterUse {
        kind,
        width_px,
        height_px,
        bits_per_component,
        object_number,
        x_ppi: image_ppi(width_px, matrix.a, matrix.b),
        y_ppi: image_ppi(height_px, matrix.c, matrix.d),
    });
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn image_bits(document: &Document, dictionary: &Dictionary, default_bits: i64) -> (bool, i64) {
    let stencil = dictionary_value(document, dictionary, &[b"ImageMask", b"IM"])
        .and_then(|object| object.as_bool().ok())
        .unwrap_or(false);
    let bits = dictionary_value(document, dictionary, &[b"BitsPerComponent", b"BPC"])
        .and_then(|object| object.as_i64().ok())
        .unwrap_or(default_bits);
    (stencil, if stencil { 1 } else { bits })
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn record_image_use(
    document: &Document,
    inventory: &mut RasterInventory,
    dictionary: &Dictionary,
    object_number: u32,
    matrix: Matrix,
) {
    let (stencil, bits) = image_bits(document, dictionary, 8);
    push_raster_use(
        document,
        inventory,
        if stencil { "stencil" } else { "image" },
        dictionary,
        bits,
        object_number,
        matrix,
    );
    // A soft mask takes the place of an explicit one; only the active mask is painted.
    let mask = |key: &[u8]| {
        dictionary_value(document, dictionary, &[key]).and_then(|object| object.as_stream().ok())
    };
    let active = mask(b"SMask")
        .map(|stream| ("smask", stream))
        .or_else(|| mask(b"Mask").map(|stream| ("mask", stream)));
    if let Some((kind, stream)) = active {
        let (_, mask_bits) = image_bits(document, &stream.dict, 1);
        push_raster_use(
            document,
            inventory,
            kind,
            &stream.dict,
            mask_bits,
            object_number,
            matrix,
        );
    }
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn read_matrix(object: Option<&Object>) -> Option<Matrix> {
    object
        .and_then(|object| object.as_array().ok())
        .and_then(|values| values.iter().map(object_number).collect::<Option<Vec<_>>>())
        .filter(|values| values.len() == 6)
        .map(|values| Matrix {
            a: values[0],
            b: values[1],
            c: values[2],
            d: values[3],
            e: values[4],
            f: values[5],
        })
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
struct InventoryWalk<'a> {
    document: &'a Document,
    optional_content: OptionalContent,
    form_path: Vec<ObjectId>,
    max_decompressed_bytes: usize,
    inventory: RasterInventory,
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
impl InventoryWalk<'_> {
    fn walk(
        &mut self,
        operations: &[Operation],
        inline_images: &[crate::content_parse::TInlineImageFacts],
        scope: &ResourceScope<'_>,
        base: Matrix,
    ) -> Result<()> {
        let mut inline_images = inline_images.iter();
        let document = self.document;
        let mut matrix = base;
        let mut stack = Vec::new();
        // Each open marked-content sequence, true where its layer is hidden.
        let mut hidden = Vec::<bool>::new();
        for operation in operations {
            let is_hidden = hidden.last().copied().unwrap_or(false);
            match operation.operator.as_str() {
                "q" => stack.push(matrix),
                "Q" => matrix = stack.pop().unwrap_or(base),
                "cm" => {
                    if let Some(values) =
                        read_matrix(Some(&Object::Array(operation.operands.clone())))
                    {
                        matrix = values.concat_onto(matrix);
                    }
                }
                "BMC" => hidden.push(is_hidden),
                "BDC" => {
                    let layer = (operation
                        .operands
                        .first()
                        .and_then(|tag| tag.as_name().ok())
                        == Some(b"OC".as_slice()))
                    .then(|| operation.operands.get(1))
                    .flatten();
                    let shown = match layer {
                        Some(Object::Name(name)) => {
                            scope.properties.get(name).is_none_or(|object| {
                                self.optional_content.visible(
                                    document,
                                    object,
                                    &mut self.inventory.complete,
                                )
                            })
                        }
                        Some(object) => self.optional_content.visible(
                            document,
                            object,
                            &mut self.inventory.complete,
                        ),
                        None => true,
                    };
                    hidden.push(is_hidden || !shown);
                }
                "EMC" => {
                    hidden.pop();
                }
                // The dictionary's declared facts, as pdfimages lists them,
                // whether or not lopdf could decode the image itself.
                "BI" => match inline_images.next() {
                    _ if is_hidden => {}
                    Some(&Some((width, height, bits, stencil))) => {
                        self.inventory.uses.push(RasterUse {
                            kind: if stencil { "stencil" } else { "image" },
                            width_px: i64::from(width),
                            height_px: i64::from(height),
                            bits_per_component: i64::from(bits),
                            object_number: 0,
                            x_ppi: image_ppi(i64::from(width), matrix.a, matrix.b),
                            y_ppi: image_ppi(i64::from(height), matrix.c, matrix.d),
                        })
                    }
                    _ => self.inventory.complete = false,
                },
                _ if is_hidden => {}
                "Do" if operation.operands.len() == 1 => {
                    let Ok(name) = operation.operands[0].as_name() else {
                        continue;
                    };
                    let Some(&object) = scope.xobjects.get(name) else {
                        self.inventory.complete = false;
                        continue;
                    };
                    let object_id = object.as_reference().ok();
                    let Some(stream) = document
                        .resolved(object)
                        .ok()
                        .and_then(|object| object.as_stream().ok())
                    else {
                        self.inventory.complete = false;
                        continue;
                    };
                    if let Ok(layer) = stream.dict.get(b"OC") {
                        if !self.optional_content.visible(
                            document,
                            layer,
                            &mut self.inventory.complete,
                        ) {
                            continue;
                        }
                    }
                    match stream.dict.get(b"Subtype").and_then(Object::as_name).ok() {
                        Some(b"Image") => record_image_use(
                            document,
                            &mut self.inventory,
                            &stream.dict,
                            object_id.map_or(0, |id| id.0),
                            matrix,
                        ),
                        Some(b"Form") => self.walk_form(stream, object_id, matrix, scope)?,
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn walk_form(
        &mut self,
        stream: &lopdf::Stream,
        object_id: Option<ObjectId>,
        outer: Matrix,
        parent_scope: &ResourceScope<'_>,
    ) -> Result<()> {
        // A cycle is a repeat along the current path, not a form painted
        // twice: both uses of a repeated form are real images.
        if object_id.is_some_and(|id| self.form_path.contains(&id))
            || self.form_path.len() >= MAX_FORM_XOBJECT_DEPTH
        {
            self.inventory.complete = false;
            return Ok(());
        }
        let document = self.document;
        let form_matrix = read_matrix(stream.dict.get(b"Matrix").ok()).unwrap_or(Matrix::IDENTITY);
        let own_scope = stream
            .dict
            .get(b"Resources")
            .ok()
            .and_then(|object| resolved_dictionary(document, object))
            .map(|resources| resource_scope(document, std::iter::once(resources)));
        let Ok(bytes) =
            crate::load_policy::plain_stream_with_limit(stream, self.max_decompressed_bytes)
        else {
            self.inventory.complete = false;
            return Ok(());
        };
        let Ok((Ok(content), inline_images)) =
            crate::content_parse::parse_content_with_inline_images(&bytes)
        else {
            self.inventory.complete = false;
            return Ok(());
        };
        self.form_path.extend(object_id);
        let walked = self.walk(
            &content.operations,
            &inline_images,
            own_scope.as_ref().unwrap_or(parent_scope),
            form_matrix.concat_onto(outer),
        );
        if object_id.is_some() {
            self.form_path.pop();
        }
        walked
    }

    /// The images a page's visible annotation appearances paint, placed as
    /// a viewer places them: the appearance box mapped onto the annotation's rectangle.
    fn walk_annotations(
        &mut self,
        page: &Dictionary,
        page_scope: &ResourceScope<'_>,
    ) -> Result<()> {
        const HIDDEN: i64 = 2;
        const NO_VIEW: i64 = 32;
        let document = self.document;
        let Some(annotations) = page
            .get(b"Annots")
            .ok()
            .and_then(|object| document.resolved(object).ok())
            .and_then(|object| object.as_array().ok())
        else {
            return Ok(());
        };
        for annotation in annotations {
            let Some(annotation) = resolved_dictionary(document, annotation) else {
                continue;
            };
            let flags = annotation.get(b"F").and_then(Object::as_i64).unwrap_or(0);
            if flags & (HIDDEN | NO_VIEW) != 0 {
                continue;
            }
            if let Ok(layer) = annotation.get(b"OC") {
                if !self
                    .optional_content
                    .visible(document, layer, &mut self.inventory.complete)
                {
                    continue;
                }
            }
            let Some(normal) = annotation
                .get(b"AP")
                .ok()
                .and_then(|object| resolved_dictionary(document, object))
                .and_then(|appearances| appearances.get(b"N").ok())
            else {
                continue;
            };
            // A normal appearance is a form, or one form per appearance state.
            let appearance = match document.resolved(normal).ok() {
                Some(Object::Stream(_)) => normal,
                Some(Object::Dictionary(states)) => {
                    // Without a state, viewers such as Poppler show the Off appearance.
                    let state = annotation
                        .get(b"AS")
                        .and_then(Object::as_name)
                        .unwrap_or(b"Off");
                    let Ok(appearance) = states.get(state) else {
                        continue;
                    };
                    appearance
                }
                _ => continue,
            };
            let object_id = appearance.as_reference().ok();
            let Some(stream) = document
                .resolved(appearance)
                .ok()
                .and_then(|object| object.as_stream().ok())
            else {
                continue;
            };
            let rect = annotation
                .get(b"Rect")
                .ok()
                .and_then(|object| object.as_array().ok())
                .and_then(|values| values.iter().map(object_number).collect::<Option<Vec<_>>>())
                .filter(|values| values.len() == 4);
            let bbox = stream
                .dict
                .get(b"BBox")
                .ok()
                .and_then(|object| object.as_array().ok())
                .and_then(|values| values.iter().map(object_number).collect::<Option<Vec<_>>>())
                .filter(|values| values.len() == 4);
            let (Some(rect), Some(bbox)) = (rect, bbox) else {
                self.inventory.complete = false;
                continue;
            };
            let form_matrix =
                read_matrix(stream.dict.get(b"Matrix").ok()).unwrap_or(Matrix::IDENTITY);
            let corners = [
                form_matrix.transform(bbox[0], bbox[1]),
                form_matrix.transform(bbox[2], bbox[1]),
                form_matrix.transform(bbox[0], bbox[3]),
                form_matrix.transform(bbox[2], bbox[3]),
            ];
            let (min_x, max_x, min_y, max_y) = corners.iter().fold(
                (
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                ),
                |(min_x, max_x, min_y, max_y), (x, y)| {
                    (min_x.min(*x), max_x.max(*x), min_y.min(*y), max_y.max(*y))
                },
            );
            let (rect_x, rect_y) = (rect[0].min(rect[2]), rect[1].min(rect[3]));
            let (rect_width, rect_height) = ((rect[2] - rect[0]).abs(), (rect[3] - rect[1]).abs());
            if max_x <= min_x || max_y <= min_y {
                continue;
            }
            let scale_x = rect_width / (max_x - min_x);
            let scale_y = rect_height / (max_y - min_y);
            let placement = Matrix {
                a: scale_x,
                b: 0.0,
                c: 0.0,
                d: scale_y,
                e: rect_x - scale_x * min_x,
                f: rect_y - scale_y * min_y,
            };
            self.walk_form(stream, object_id, placement, page_scope)?;
        }
        Ok(())
    }
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn page_raster_inventory(
    document: &Document,
    page_id: ObjectId,
    max_decompressed_bytes: usize,
) -> Result<RasterInventory> {
    let (direct_resources, resource_ids) = document
        .get_page_resources(page_id)
        .map_err(|error| reclassify_domain_error(error.into(), NativeErrorCode::CorruptXref))?;
    // Inherited resources are the fallback; nearer page resources override them.
    let inherited = resource_ids
        .into_iter()
        .rev()
        .filter_map(|id| document.get_dictionary(id).ok());
    let scope = resource_scope(document, inherited.chain(direct_resources));
    let mut walk = InventoryWalk {
        document,
        optional_content: OptionalContent::read(document),
        form_path: Vec::new(),
        max_decompressed_bytes,
        inventory: RasterInventory {
            uses: Vec::new(),
            complete: true,
        },
    };
    match decode_page_content_with_inline_images(document, page_id, max_decompressed_bytes) {
        Ok((content, images)) => {
            walk.walk(&content.operations, &images, &scope, Matrix::IDENTITY)?
        }
        Err(_) => walk.inventory.complete = false,
    }
    if let Ok(page) = document.get_dictionary(page_id) {
        walk.walk_annotations(page, &scope)?;
    }
    Ok(walk.inventory)
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn page_has_annotations(document: &Document, page_id: ObjectId) -> bool {
    document
        .get_dictionary(page_id)
        .ok()
        .and_then(|page| page.get(b"Annots").ok())
        .and_then(|annotations| document.resolved(annotations).ok())
        .and_then(|annotations| annotations.as_array().ok())
        .is_some_and(|annotations| !annotations.is_empty())
}

/// Scan cleanup's page facts for the browser, which has no sidecar file: the
/// requested pages' records exactly as `write_page_sizes_sidecar_document` writes them,
/// under the document's page count. No requested pages lists every page.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn inspect_scan_cleanup_pdf_bytes(data: &[u8], page_numbers: &[u32]) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InspectedPage {
        #[serde(flatten)]
        entry: PageSizeEntry,
        raster_uses: Vec<RasterUse>,
        raster_inventory_complete: bool,
        has_annotations: bool,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InspectedPages {
        page_count: u32,
        pages: Vec<InspectedPage>,
    }

    let document = crate::load_browser_pdf(data)?;
    let resolver = PageTreeResolver::new(&document)?;
    let entry = |page_number: u32, page_id: ObjectId| {
        let page_view = resolve_page_view(&document, page_id)?;
        let rotation = resolve_page_rotation(&document, page_id)?;
        let dominant_image = dominant_full_page_image(&document, page_id, page_view)?;
        let inventory =
            page_raster_inventory(&document, page_id, MAX_DECOMPRESSED_PDF_STREAM_BYTES)?;
        Ok::<_, Box<dyn std::error::Error>>(InspectedPage {
            entry: page_size_entry(
                &document,
                page_number,
                page_id,
                rotation,
                page_view,
                dominant_image,
            )?,
            raster_uses: inventory.uses,
            raster_inventory_complete: inventory.complete,
            has_annotations: page_has_annotations(&document, page_id),
        })
    };
    let mut pages = Vec::new();
    if page_numbers.is_empty() {
        resolver.for_each_page_id(&document, |page_id| {
            let page_number =
                u32::try_from(pages.len() + 1).map_err(|_| "Page-size page number overflow")?;
            pages.push(entry(page_number, page_id)?);
            Ok(())
        })?;
    } else {
        for &page_number in page_numbers {
            pages.push(entry(
                page_number,
                resolver.page_id(&document, page_number)?,
            )?);
        }
    }
    Ok(serde_json::to_vec(&InspectedPages {
        page_count: resolver.page_count(),
        pages,
    })?)
}

/// Write page geometry as a bounded JSONL sidecar. The header is one line and
/// every following line is one bounded page chunk. Only the current chunk is
/// held in memory, so sidecar size and page count do not turn into one JSON
/// allocation.
pub(crate) fn write_page_sizes_sidecar(
    document: &impl PdfObjectSource,
    output_path: &Path,
) -> Result<()> {
    let page_resolver = PageTreeResolver::new(document)?;
    write_page_sizes_from_resolver(
        document,
        &page_resolver,
        output_path,
        PAGE_SIZES_SIDECAR_CHUNK_BYTES,
        DominantImageAnalysis::Unavailable,
        |page_number, page_id| {
            let page_view = resolve_page_view(document, page_id)?;
            let rotation = resolve_page_rotation(document, page_id)?;
            page_size_entry(document, page_number, page_id, rotation, page_view, None)
        },
    )
}

fn write_page_sizes_sidecar_document(document: &Document, output_path: &Path) -> Result<()> {
    let page_resolver = PageTreeResolver::new(document)?;
    write_page_sizes_from_resolver(
        document,
        &page_resolver,
        output_path,
        PAGE_SIZES_SIDECAR_CHUNK_BYTES,
        DominantImageAnalysis::Performed,
        |page_number, page_id| {
            let page_view = resolve_page_view(document, page_id)?;
            let rotation = resolve_page_rotation(document, page_id)?;
            let dominant_image = dominant_full_page_image(document, page_id, page_view)?;
            page_size_entry(
                document,
                page_number,
                page_id,
                rotation,
                page_view,
                dominant_image,
            )
        },
    )
}

#[cfg(test)]
fn write_page_sizes_sidecar_with_chunk_limit(
    document: &impl PdfObjectSource,
    output_path: &Path,
    chunk_limit: usize,
) -> Result<()> {
    let page_resolver = PageTreeResolver::new(document)?;
    write_page_sizes_from_resolver(
        document,
        &page_resolver,
        output_path,
        chunk_limit,
        DominantImageAnalysis::Skipped,
        |page_number, page_id| {
            let page_view = resolve_page_view(document, page_id)?;
            let rotation = resolve_page_rotation(document, page_id)?;
            page_size_entry(document, page_number, page_id, rotation, page_view, None)
        },
    )
}

fn write_page_sizes_from_resolver<F>(
    document: &impl PdfObjectSource,
    page_resolver: &PageTreeResolver,
    output_path: &Path,
    chunk_limit: usize,
    dominant_image_analysis: DominantImageAnalysis,
    mut make_entry: F,
) -> Result<()>
where
    F: FnMut(u32, ObjectId) -> Result<PageSizeEntry>,
{
    let declared_page_count = u64::from(page_resolver.page_count());
    if declared_page_count == 0 {
        return Err(domain_error(
            NativeErrorCode::CorruptXref,
            "PDF contains no pages",
        ));
    }

    let mut writer = PageSizesSidecarWriter::new(
        output_path,
        declared_page_count,
        chunk_limit,
        dominant_image_analysis,
    )?;
    let mut page_number = 0_u32;
    let reachable_page_count = page_resolver.for_each_page_id_with_count(document, |page_id| {
        page_number = page_number
            .checked_add(1)
            .ok_or("Page-size page number overflow")?;
        let entry = make_entry(page_number, page_id)?;
        writer.push(page_number, entry)
    })?;
    writer.finish(reachable_page_count)
}

pub(crate) fn write_page_sizes_path(
    input_path: &Path,
    output_path: &Path,
    qpdf_path: Option<&Path>,
    metadata_only: bool,
) -> Result<()> {
    if page_sizes_paths_alias(input_path, output_path)? {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Page-size output must not alias the PDF input",
        ));
    }
    let encoded_len = fs::metadata(input_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    let eager_sized = encoded_len <= MAX_ENCODED_PDF_BYTES as u64;
    if eager_sized && !metadata_only {
        let document = load_pdf_path(input_path)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        assert_plaintext_base(
            &document,
            "Encrypted PDFs are not supported by native page ops",
        )?;
        return write_page_sizes_sidecar_document(&document, output_path);
    }

    // Box metadata reads only dictionaries, and above the eager-load ceiling it
    // is all a page-size read reports, so both take the dictionary load.
    if !eager_sized && qpdf_path.is_none() {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Large page-size input requires the bundled qpdf structural reader",
        ));
    }
    let incremental =
        load_readonly_metadata_pdf_path(input_path, qpdf_path, QpdfMetadataPurpose::Geometry)
            .map_err(|error| {
                if eager_sized {
                    classify_pdf_load_error(error, "Failed to parse PDF structure")
                } else {
                    error
                }
            })?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    write_page_sizes_sidecar(&AppendedRevision::new(&incremental), output_path)
}

fn page_sizes_paths_alias(input_path: &Path, output_path: &Path) -> Result<bool> {
    if input_path == output_path {
        return Ok(true);
    }
    let input_path = fs::canonicalize(input_path).map_err(|error| {
        domain_error(
            NativeErrorCode::Io,
            format!("Failed to resolve PDF input path: {error}"),
        )
    })?;
    let output_path = match fs::canonicalize(output_path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(domain_error(
                NativeErrorCode::Io,
                format!("Failed to resolve page-size output path: {error}"),
            ))
        }
    };
    Ok(input_path == output_path)
}

struct PageSizesSidecarWriter {
    output: AtomicOutput,
    chunk_limit: usize,
    chunk: Option<PageSizesSidecarChunk>,
    next_chunk_index: u64,
    total_bytes: u64,
    declared_page_count: u64,
    reachable_page_count_offset: u64,
}

impl PageSizesSidecarWriter {
    fn new(
        output_path: &Path,
        page_count: u64,
        chunk_limit: usize,
        dominant_image_analysis: DominantImageAnalysis,
    ) -> Result<Self> {
        if !(64..=PAGE_SIZES_SIDECAR_CHUNK_BYTES).contains(&chunk_limit) {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Page-size sidecar chunk limit must fit its JSON envelope and stay within 4 MiB",
            ));
        }
        let output = AtomicOutput::create(output_path)?;
        #[cfg(unix)]
        output
            .file()?
            .set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        let mut writer = Self {
            output,
            chunk_limit,
            chunk: None,
            next_chunk_index: 0,
            total_bytes: 0,
            declared_page_count: page_count,
            reachable_page_count_offset: 0,
        };
        let header_prefix = format!(
            "{{\"format\":\"{PAGE_SIZES_SIDECAR_FORMAT}\",\"schemaVersion\":{PAGE_SIZES_SIDECAR_SCHEMA_VERSION},\"pageCount\":{page_count},\"declaredPageCount\":{page_count},\"reachablePageCount\":"
        );
        writer.reachable_page_count_offset = u64::try_from(header_prefix.len())?;
        let reachable_page_count_placeholder =
            format!("{:>width$}", 0, width = PAGE_COUNT_FIELD_WIDTH);
        let header_suffix = format!(
            ",\"chunkBytes\":{chunk_limit},\"dominantImageAnalysis\":\"{}\"}}\n",
            dominant_image_analysis.as_str(),
        );
        let mut header = header_prefix.into_bytes();
        header.extend_from_slice(reachable_page_count_placeholder.as_bytes());
        header.extend_from_slice(header_suffix.as_bytes());
        writer.write_bounded(&header)?;
        Ok(writer)
    }

    fn push(&mut self, page_number: u32, entry: PageSizeEntry) -> Result<()> {
        let encoded_entry = serde_json::to_vec(&entry)?;
        if self.chunk.is_none() {
            self.chunk = Some(PageSizesSidecarChunk::new(
                self.next_chunk_index,
                page_number,
            ));
        }
        if !self
            .chunk
            .as_mut()
            .expect("page-size sidecar chunk exists")
            .try_push(&encoded_entry, self.chunk_limit)
        {
            if self
                .chunk
                .as_ref()
                .is_some_and(|chunk| chunk.entry_count == 0)
            {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Page-size entry exceeds the 4 MiB sidecar chunk limit",
                ));
            }
            self.flush_chunk()?;
            self.chunk = Some(PageSizesSidecarChunk::new(
                self.next_chunk_index,
                page_number,
            ));
            if !self
                .chunk
                .as_mut()
                .expect("page-size sidecar chunk exists")
                .try_push(&encoded_entry, self.chunk_limit)
            {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Page-size entry exceeds the 4 MiB sidecar chunk limit",
                ));
            }
        }
        Ok(())
    }

    fn flush_chunk(&mut self) -> Result<()> {
        let Some(chunk) = self.chunk.take() else {
            return Ok(());
        };
        if chunk.entry_count == 0 {
            return Ok(());
        }
        self.write_bounded(&chunk.finish())?;
        self.next_chunk_index = self
            .next_chunk_index
            .checked_add(1)
            .ok_or("Page-size sidecar chunk number overflow")?;
        Ok(())
    }

    fn write_bounded(&mut self, bytes: &[u8]) -> Result<()> {
        let byte_count = u64::try_from(bytes.len())?;
        let next_total = self
            .total_bytes
            .checked_add(byte_count)
            .ok_or("Page-size sidecar byte count overflow")?;
        self.output.file_mut()?.write_all(bytes)?;
        self.total_bytes = next_total;
        Ok(())
    }

    fn finish(mut self, reachable_page_count: u64) -> Result<()> {
        if reachable_page_count != self.declared_page_count {
            return Err(domain_error(
                NativeErrorCode::CorruptXref,
                format!(
                    "PDF page tree declared {} pages but contains {reachable_page_count}",
                    self.declared_page_count
                ),
            ));
        }
        self.flush_chunk()?;
        let encoded_reachable_page_count = format!(
            "{:>width$}",
            reachable_page_count,
            width = PAGE_COUNT_FIELD_WIDTH
        );
        if encoded_reachable_page_count.len() > PAGE_COUNT_FIELD_WIDTH {
            return Err("Page-size reachable page count exceeds the sidecar header width".into());
        }
        let output_offset = self.output.file()?.stream_position()?;
        self.output
            .file_mut()?
            .seek(SeekFrom::Start(self.reachable_page_count_offset))?;
        self.output
            .file_mut()?
            .write_all(encoded_reachable_page_count.as_bytes())?;
        self.output
            .file_mut()?
            .seek(SeekFrom::Start(output_offset))?;
        self.output.publish()?;
        Ok(())
    }
}

struct PageSizesSidecarChunk {
    bytes: Vec<u8>,
    entry_count: usize,
}

impl PageSizesSidecarChunk {
    fn new(index: u64, first_page_number: u32) -> Self {
        Self {
            bytes: format!(
                "{{\"chunkIndex\":{index},\"firstPageNumber\":{first_page_number},\"pages\":["
            )
            .into_bytes(),
            entry_count: 0,
        }
    }

    fn try_push(&mut self, entry: &[u8], chunk_limit: usize) -> bool {
        let separator_bytes = usize::from(self.entry_count > 0);
        let Some(candidate_len) = self
            .bytes
            .len()
            .checked_add(separator_bytes)
            .and_then(|length| length.checked_add(entry.len()))
            .and_then(|length| length.checked_add(3))
        else {
            return false;
        };
        if candidate_len > chunk_limit {
            return false;
        }
        if separator_bytes != 0 {
            self.bytes.push(b',');
        }
        self.bytes.extend_from_slice(entry);
        self.entry_count += 1;
        true
    }

    fn finish(mut self) -> Vec<u8> {
        self.bytes.extend_from_slice(b"]}\n");
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{page_tree_node_read_count, reset_page_tree_node_read_count};
    use lopdf::{dictionary, Stream};

    fn create_test_document() -> (Document, ObjectId) {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        (document, page_id)
    }

    fn create_test_document_with_pages(page_count: usize) -> Document {
        assert!(page_count > 0);
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let page_ids = (0..page_count)
            .map(|_| {
                document.add_object(dictionary! {
                    "Type" => "Page",
                    "Parent" => pages_id,
                })
            })
            .collect::<Vec<_>>();
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
                "Count" => i64::try_from(page_count).unwrap(),
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document
    }

    fn create_repeated_page_tree(page_count: usize) -> Document {
        assert!(page_count > 0);
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
        });
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(vec![Object::Reference(page_id); page_count]),
                "Count" => i64::try_from(page_count).unwrap(),
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document
    }

    struct NoDensePageIds<'a>(&'a Document);

    impl PdfObjectSource for NoDensePageIds<'_> {
        fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
            self.0.objects.get(&object_id)
        }

        fn page_ids(&self) -> std::collections::BTreeMap<u32, ObjectId> {
            panic!("page-size sidecar must not request a dense page map")
        }

        fn root_id(&self) -> Result<ObjectId> {
            Ok(self.0.trailer.get(b"Root")?.as_reference()?)
        }
    }

    #[test]
    fn collects_page_sizes_from_inherited_boxes() {
        let (mut document, page_id) = create_test_document();
        document.get_dictionary_mut(page_id).unwrap().set(
            "CropBox",
            vec![10.into(), 20.into(), 190.into(), 100.into()],
        );
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Rotate", 90);

        let output = collect_page_sizes(&document).unwrap();

        assert_eq!(output.pages.len(), 1);
        assert_eq!(output.pages[0].page_number, 1);
        assert_eq!(output.pages[0].x_points, 10.0);
        assert_eq!(output.pages[0].y_points, 20.0);
        assert_eq!(output.pages[0].width_points, 180.0);
        assert_eq!(output.pages[0].height_points, 80.0);
        assert_eq!(output.pages[0].width_inches, 2.5);
        assert!((output.pages[0].height_inches - (80.0 / 72.0)).abs() < 0.000_001);
        assert_eq!(output.pages[0].rotation, 90);
    }

    #[test]
    fn collects_structural_page_sizes_without_decoding_page_streams() {
        let (mut document, page_id) = create_test_document();
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Rotate", 270);

        let page_view = resolve_page_view(&document, page_id).unwrap();
        let rotation = resolve_page_rotation(&document, page_id).unwrap();
        let output = page_size_entry(&document, 1, page_id, rotation, page_view, None).unwrap();

        assert_eq!(output.width_points, 200.0);
        assert_eq!(output.height_points, 100.0);
        assert_eq!(output.rotation, 270);
        assert_eq!(output.dominant_image_width_px, None);
    }

    #[test]
    fn inventories_masked_layers_inside_forms_like_pdfimages() {
        let (mut document, page_id) = create_test_document();
        let mask_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 2000,
                "Height" => 1000,
                "ImageMask" => true,
            },
            Vec::new(),
        ));
        let foreground_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 100,
                "Height" => 50,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Mask" => mask_id,
            },
            Vec::new(),
        ));
        let background_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 500,
                "Height" => 250,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
            },
            Vec::new(),
        ));
        let form_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                "Matrix" => vec![2.into(), 0.into(), 0.into(), 2.into(), 0.into(), 0.into()],
                "Resources" => dictionary! {"XObject" => dictionary! {"Fg" => foreground_id}},
            },
            b"/Fg Do".to_vec(),
        ));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 200 0 0 100 0 0 cm /Bg Do Q q 100 0 0 50 0 0 cm /Layer Do /Layer Do Q".to_vec(),
        ));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set(
            "Resources",
            dictionary! {"XObject" => dictionary! {"Bg" => background_id, "Layer" => form_id}},
        );
        page.set("Contents", content_id);
        page.set("Annots", vec![]);

        let inventory = page_raster_inventory(&document, page_id, 1 << 20).unwrap();

        assert!(inventory.complete);
        assert!(!page_has_annotations(&document, page_id));
        let row = |kind, width_px, height_px, bits_per_component, object_number, ppi| RasterUse {
            kind,
            width_px,
            height_px,
            bits_per_component,
            object_number,
            x_ppi: ppi,
            y_ppi: ppi,
        };
        let foreground = row("image", 100, 50, 8, foreground_id.0, 36);
        let mask = row("mask", 2000, 1000, 1, foreground_id.0, 720);
        assert_eq!(
            inventory.uses,
            vec![
                row("image", 500, 250, 8, background_id.0, 180),
                foreground,
                mask,
                row("image", 100, 50, 8, foreground_id.0, 36),
                row("mask", 2000, 1000, 1, foreground_id.0, 720),
            ],
        );
    }

    #[test]
    fn inventories_what_pdfimages_lists_beyond_page_content() {
        let (mut document, page_id) = create_test_document();
        let image = |document: &mut Document, extra: Dictionary| {
            let mut dictionary = dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 10,
                "Height" => 10,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            };
            for (key, value) in extra {
                dictionary.set(key, value);
            }
            document.add_object(Stream::new(dictionary, Vec::new()))
        };
        // Indirect facts: a one-bit image whose size and depth are references.
        let width_id = document.add_object(10);
        let bits_id = document.add_object(1);
        let indirect = image(
            &mut document,
            dictionary! {"Width" => width_id, "BitsPerComponent" => bits_id},
        );
        // An explicit mask overridden by a soft mask is not painted.
        let hard_mask = image(&mut document, dictionary! {"ImageMask" => true});
        let soft_mask = image(&mut document, Dictionary::new());
        let masked = image(
            &mut document,
            dictionary! {"Mask" => hard_mask, "SMask" => soft_mask},
        );
        // An image in a layer the default configuration turns off.
        let layer = document.add_object(dictionary! {"Type" => "OCG", "Name" => "Hidden"});
        let hidden = image(&mut document, Dictionary::new());
        document.objects.insert(
            document
                .trailer
                .get(b"Root")
                .unwrap()
                .as_reference()
                .unwrap(),
            Object::Dictionary({
                let mut catalog = document.catalog().unwrap().clone();
                catalog.set(
                    "OCProperties",
                    dictionary! {
                        "OCGs" => vec![layer.into()],
                        "D" => dictionary! {"OFF" => vec![layer.into()]},
                    },
                );
                catalog
            }),
        );
        // A stamp's appearance painting an image at 36 points per 10 pixels.
        let stamp_image = image(&mut document, Dictionary::new());
        let appearance = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                "Resources" => dictionary! {"XObject" => dictionary! {"S" => stamp_image}},
            },
            b"/S Do".to_vec(),
        ));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            [
                b"q 7.2 0 0 7.2 0 0 cm /I Do Q".as_slice(),
                b"q 288 0 0 288 0 0 cm /M Do Q",
                b"/OC /L BDC q 72 0 0 72 0 0 cm /H Do BI /W 5 /H 5 /BPC 1 /CS /G ID \x00\x00\x00\x00\x00 EI Q EMC",
                b"q 1440 0 0 1440 0 0 cm BI /W 2 /H 2 /BPC 8 /CS /DeviceGray ID \x00\x00\x00\x00 EI Q",
            ]
            .join(&b' '),
        ));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! {"I" => indirect, "M" => masked, "H" => hidden},
                "Properties" => dictionary! {"L" => layer},
            },
        );
        page.set("Contents", content_id);
        page.set(
            "Annots",
            vec![dictionary! {
                "Subtype" => "Stamp",
                "Rect" => vec![0.into(), 0.into(), 36.into(), 36.into()],
                "AP" => dictionary! {"N" => appearance},
            }
            .into()],
        );

        let inventory = page_raster_inventory(&document, page_id, 1 << 20).unwrap();

        assert!(inventory.complete);
        let row = |kind, bits, object_number: u32, ppi| RasterUse {
            kind,
            width_px: 10,
            height_px: 10,
            bits_per_component: bits,
            object_number,
            x_ppi: ppi,
            y_ppi: ppi,
        };
        let mut inline = row("image", 8, 0, 0);
        inline.width_px = 2;
        inline.height_px = 2;
        assert_eq!(
            inventory.uses,
            vec![
                row("image", 1, indirect.0, 100),
                // 10 pixels over 288 points is 2.5, printed as 2.
                row("image", 8, masked.0, 2),
                row("smask", 8, masked.0, 2),
                // 2 pixels over 1,440 points prints below one, parsed as zero.
                inline,
                row("image", 8, stamp_image.0, 20),
            ],
        );
    }

    #[test]
    fn lists_inline_images_lopdf_cannot_decode_and_off_appearances() {
        let (mut document, page_id) = create_test_document();
        let image = |document: &mut Document, width: i64| {
            document.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Image",
                    "Width" => width,
                    "Height" => 10,
                    "ColorSpace" => "DeviceGray",
                    "BitsPerComponent" => 8,
                },
                Vec::new(),
            ))
        };
        let form = |document: &mut Document, image_id: ObjectId| {
            document.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Form",
                    "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                    "Resources" => dictionary! {"XObject" => dictionary! {"S" => image_id}},
                },
                b"/S Do".to_vec(),
            ))
        };
        let on_image = image(&mut document, 20);
        let off_image = image(&mut document, 30);
        let on = form(&mut document, on_image);
        let off = form(&mut document, off_image);
        // An abbreviated colour space and a filter: lopdf skips this image.
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 72 0 0 72 0 0 cm BI /W 3 /H 4 /BPC 8 /CS /G /F /DCT ID \xff\xd8\xff\xd9 EI Q"
                .to_vec(),
        ));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set("Contents", content_id);
        page.set(
            "Annots",
            vec![dictionary! {
                "Subtype" => "Widget",
                "Rect" => vec![0.into(), 0.into(), 72.into(), 72.into()],
                "AP" => dictionary! {"N" => dictionary! {"On" => on, "Off" => off}},
            }
            .into()],
        );

        let inventory = page_raster_inventory(&document, page_id, 1 << 20).unwrap();

        assert!(inventory.complete);
        assert_eq!(
            inventory.uses,
            vec![
                RasterUse {
                    kind: "image",
                    width_px: 3,
                    height_px: 4,
                    bits_per_component: 8,
                    object_number: 0,
                    x_ppi: 3,
                    y_ppi: 4,
                },
                // Without /AS the Off appearance is the one shown.
                RasterUse {
                    kind: "image",
                    width_px: 30,
                    height_px: 10,
                    bits_per_component: 8,
                    object_number: off_image.0,
                    x_ppi: 30,
                    y_ppi: 10,
                },
            ],
        );
    }

    #[test]
    fn marks_inline_images_and_form_cycles_as_unmeasured() {
        let (mut document, page_id) = create_test_document();
        let form_id = document.new_object_id();
        document.objects.insert(
            form_id,
            Object::Stream(Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Form",
                    "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                    "Resources" => dictionary! {"XObject" => dictionary! {"Self" => form_id}},
                },
                b"/Self Do".to_vec(),
            )),
        );
        let content_id = document.add_object(Stream::new(Dictionary::new(), b"/Loop Do".to_vec()));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set(
            "Resources",
            dictionary! {"XObject" => dictionary! {"Loop" => form_id}},
        );
        page.set("Contents", content_id);
        page.set("Annots", vec![dictionary! {"Subtype" => "Link"}.into()]);

        let inventory = page_raster_inventory(&document, page_id, 1 << 20).unwrap();

        assert!(!inventory.complete);
        assert!(inventory.uses.is_empty());
        assert!(page_has_annotations(&document, page_id));
    }

    #[test]
    fn reports_a_raster_that_covers_the_page() {
        let (mut document, page_id) = create_test_document();
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1000,
                "Height" => 500,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
            },
            Vec::new(),
        ));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 200 0 0 100 0 0 cm /Scan Do Q".to_vec(),
        ));
        document.get_dictionary_mut(page_id).unwrap().set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! {
                    "Scan" => image_id,
                },
            },
        );
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Contents", content_id);

        let output = collect_page_sizes(&document).unwrap();
        let page = &output.pages[0];

        assert_eq!(page.dominant_image_width_px, Some(1000));
        assert_eq!(page.dominant_image_height_px, Some(500));
        assert_eq!(page.dominant_image_width_points, Some(200.0));
        assert_eq!(page.dominant_image_height_points, Some(100.0));
    }

    #[test]
    fn inspects_the_pages_a_browser_asks_for_as_the_sidecar_records_them() {
        let mut document = create_test_document_with_pages(3);
        // The browser record is the sidecar record plus the facts desktop
        // reads from pdfimages and the annotation index.
        let sidecar = serde_json::Value::Array(
            serde_json::to_value(collect_page_sizes(&document).unwrap().pages)
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|page| {
                    let mut page = page.clone();
                    let record = page.as_object_mut().unwrap();
                    record.insert("rasterUses".into(), serde_json::json!([]));
                    record.insert("rasterInventoryComplete".into(), true.into());
                    record.insert("hasAnnotations".into(), false.into());
                    page
                })
                .collect(),
        );
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let every_page: serde_json::Value =
            serde_json::from_slice(&inspect_scan_cleanup_pdf_bytes(&bytes, &[]).unwrap()).unwrap();
        assert_eq!(every_page["pageCount"], 3);
        assert_eq!(every_page["pages"], sidecar);

        let selected: serde_json::Value =
            serde_json::from_slice(&inspect_scan_cleanup_pdf_bytes(&bytes, &[3, 1]).unwrap())
                .unwrap();
        assert_eq!(selected["pageCount"], 3);
        assert_eq!(
            selected["pages"],
            serde_json::json!([sidecar[2], sidecar[0]])
        );
        assert!(inspect_scan_cleanup_pdf_bytes(&bytes, &[4]).is_err());
    }

    #[test]
    fn ignores_a_raster_that_does_not_cover_the_page() {
        let (mut document, page_id) = create_test_document();
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1000,
                "Height" => 500,
            },
            Vec::new(),
        ));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 100 0 0 50 0 0 cm /Thumbnail Do Q".to_vec(),
        ));
        document.get_dictionary_mut(page_id).unwrap().set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! {
                    "Thumbnail" => image_id,
                },
            },
        );
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Contents", content_id);

        let output = collect_page_sizes(&document).unwrap();
        let page = &output.pages[0];

        assert_eq!(page.dominant_image_width_px, None);
        assert_eq!(page.dominant_image_height_px, None);
    }

    #[test]
    fn rejects_expanding_page_content_during_page_size_inspection() {
        let (mut document, page_id) = create_test_document();
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
            },
            Vec::new(),
        ));
        let mut content = Stream::new(Dictionary::new(), vec![b' '; 1_024]);
        content.compress().unwrap();
        let content_id = document.add_object(content);
        document.get_dictionary_mut(page_id).unwrap().set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! {
                    "Scan" => image_id,
                },
            },
        );
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Contents", content_id);
        let page_view = resolve_page_view(&document, page_id).unwrap();

        let error =
            dominant_full_page_image_with_limit(&document, page_id, page_view, 32).unwrap_err();
        let native_error = error.downcast_ref::<crate::NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        assert!(native_error
            .message
            .contains("32-byte decompression ceiling"));
    }

    #[test]
    fn writes_high_page_count_geometry_in_bounded_chunks() {
        let document = create_test_document_with_pages(513);
        let output_path = std::env::temp_dir().join(format!(
            "evb-page-sizes-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        write_page_sizes_sidecar_with_chunk_limit(&document, &output_path, 1_024).unwrap();
        let output = fs::read_to_string(&output_path).unwrap();
        fs::remove_file(&output_path).unwrap();

        let mut lines = output.lines();
        let header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(header["format"], PAGE_SIZES_SIDECAR_FORMAT);
        assert_eq!(header["schemaVersion"], PAGE_SIZES_SIDECAR_SCHEMA_VERSION);
        assert_eq!(header["pageCount"], 513);
        assert_eq!(header["declaredPageCount"], 513);
        assert_eq!(header["reachablePageCount"], 513);
        assert_eq!(header["chunkBytes"], 1_024);
        assert_eq!(header["dominantImageAnalysis"], "skipped");

        let mut expected_page = 1_u64;
        let mut chunk_count = 0;
        for (expected_chunk, line) in lines.enumerate() {
            assert!(line.len() <= 1_024);
            let chunk: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(chunk["chunkIndex"], u64::try_from(expected_chunk).unwrap());
            assert_eq!(chunk["firstPageNumber"], expected_page);
            let pages = chunk["pages"].as_array().unwrap();
            assert!(!pages.is_empty());
            for page in pages {
                assert_eq!(page["pageNumber"], expected_page);
                expected_page += 1;
            }
            chunk_count += 1;
        }
        assert!(chunk_count > 1);
        assert_eq!(expected_page, 514);
    }

    #[test]
    fn sidecar_header_reports_performed_dominant_image_analysis() {
        let (document, _) = create_test_document();
        let output_path = std::env::temp_dir().join(format!(
            "evb-page-sizes-analysis-performed-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        write_page_sizes_sidecar_document(&document, &output_path).unwrap();
        let output = fs::read_to_string(&output_path).unwrap();
        fs::remove_file(&output_path).unwrap();
        let header: serde_json::Value =
            serde_json::from_str(output.lines().next().unwrap()).unwrap();

        assert_eq!(header["declaredPageCount"], 1);
        assert_eq!(header["reachablePageCount"], 1);
        assert_eq!(header["dominantImageAnalysis"], "performed");
    }

    #[test]
    fn sidecar_header_reports_unavailable_dominant_image_analysis_for_structural_input() {
        let (document, _) = create_test_document();
        let source = NoDensePageIds(&document);
        let output_path = std::env::temp_dir().join(format!(
            "evb-page-sizes-analysis-unavailable-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        write_page_sizes_sidecar(&source, &output_path).unwrap();
        let output = fs::read_to_string(&output_path).unwrap();
        fs::remove_file(&output_path).unwrap();
        let header: serde_json::Value =
            serde_json::from_str(output.lines().next().unwrap()).unwrap();

        assert_eq!(header["declaredPageCount"], 1);
        assert_eq!(header["reachablePageCount"], 1);
        assert_eq!(header["dominantImageAnalysis"], "unavailable");
    }

    #[test]
    fn rejects_a_page_size_sidecar_when_declared_count_differs_from_reachable_pages() {
        let (mut document, _) = create_test_document();
        let pages_id = document
            .root_id()
            .and_then(|root_id| document.get_dictionary(root_id).map_err(Into::into))
            .unwrap()
            .get(b"Pages")
            .unwrap()
            .as_reference()
            .unwrap();
        document
            .get_dictionary_mut(pages_id)
            .unwrap()
            .set("Count", 2);
        let output_path = std::env::temp_dir().join(format!(
            "evb-page-sizes-count-mismatch-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let error = write_page_sizes_sidecar_with_chunk_limit(&document, &output_path, 1_024)
            .expect_err("mismatched page-tree counts must not publish a sidecar");

        assert!(error
            .to_string()
            .contains("PDF page tree declared 2 pages but contains 1"));
        assert!(!output_path.exists());
    }

    #[test]
    fn starts_streaming_a_million_page_sidecar_without_a_dense_page_map() {
        let document = create_repeated_page_tree(1_000_000);
        let source = NoDensePageIds(&document);
        let resolver = PageTreeResolver::new(&source).unwrap();
        let output_path = std::env::temp_dir().join(format!(
            "evb-page-sizes-million-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut entries = 0;

        reset_page_tree_node_read_count();
        let error = write_page_sizes_from_resolver(
            &source,
            &resolver,
            &output_path,
            1_024,
            DominantImageAnalysis::Skipped,
            |_, _| {
                entries += 1;
                Err::<PageSizeEntry, _>("stop after the first streamed page".into())
            },
        )
        .unwrap_err();

        assert_eq!(entries, 1);
        assert!(error.to_string().contains("first streamed page"));
        assert!(
            page_tree_node_read_count() < 100,
            "page-size sidecar resolved too many page-tree nodes before streaming: {}",
            page_tree_node_read_count()
        );
        let _ = fs::remove_file(output_path);
    }

    #[test]
    fn resolves_the_last_page_of_a_flat_million_page_tree_without_scanning_prior_pages() {
        let document = create_repeated_page_tree(1_000_000);
        let source = NoDensePageIds(&document);
        let resolver = PageTreeResolver::new(&source).unwrap();
        let catalog_id = document.root_id().unwrap();
        let root_pages_id = document
            .get_dictionary(catalog_id)
            .unwrap()
            .get(b"Pages")
            .unwrap()
            .as_reference()
            .unwrap();
        let expected_page_id = document
            .get_dictionary(root_pages_id)
            .unwrap()
            .get(b"Kids")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .as_reference()
            .unwrap();

        reset_page_tree_node_read_count();
        assert_eq!(
            resolver.page_id(&source, 1_000_000).unwrap(),
            expected_page_id
        );
        assert!(
            page_tree_node_read_count() < 100,
            "last-page resolution scanned too many page-tree nodes: {}",
            page_tree_node_read_count()
        );
    }
}
