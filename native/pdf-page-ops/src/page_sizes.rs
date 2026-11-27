use evb_native_support::output::AtomicOutput;
use lopdf::{
    content::{Content, Operation},
    DecompressError, Dictionary, Document, Error as LopdfError, Object, ObjectId, Stream,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Seek, SeekFrom, Write},
    path::Path,
};

use crate::{
    classify_pdf_load_error, domain_error, intersect_rect, reclassify_domain_error,
    resolve_inherited_box, resolve_page_rotation, resolve_page_user_unit, resolve_page_view,
    ByteSource, NativeErrorCode, PageTreeResolver, PdfObjectSource, PdfRect, Result, SourcePdf,
    MAX_DECOMPRESSED_PDF_STREAM_BYTES,
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
pub(crate) struct PageSizesOutput {
    pub(crate) pages: Vec<PageSizeEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageSizeEntry {
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
    #[serde(flatten)]
    dominant_image: Option<FullPageImage>,
}

#[derive(Clone, Copy)]
pub(crate) struct Matrix {
    pub(crate) a: f64,
    pub(crate) b: f64,
    pub(crate) c: f64,
    pub(crate) d: f64,
    pub(crate) e: f64,
    pub(crate) f: f64,
}

impl Matrix {
    pub(crate) const IDENTITY: Self = Self {
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
    pub(crate) fn concat_onto(self, outer: Self) -> Self {
        outer.concat(self)
    }

    #[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
    pub(crate) fn transform(self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) struct FullPageImage {
    #[serde(rename = "dominantImageWidthPx")]
    width_px: i64,
    #[serde(rename = "dominantImageHeightPx")]
    height_px: i64,
    #[serde(rename = "dominantImageWidthPoints")]
    width_points: f64,
    #[serde(rename = "dominantImageHeightPoints")]
    height_points: f64,
    #[serde(rename = "allImagesPageAligned")]
    all_images_page_aligned: bool,
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
        images.remove(name);
        let Some(stream) = document
            .resolved(object)
            .ok()
            .and_then(|value| value.as_stream().ok())
        else {
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

pub(crate) fn object_number(object: &Object) -> Option<f64> {
    object.as_float().ok().map(f64::from)
}

fn covers_page(matrix: Matrix, page_view: PdfRect) -> bool {
    let min_x = matrix.e + matrix.a.min(0.0) + matrix.c.min(0.0);
    let min_y = matrix.f + matrix.b.min(0.0) + matrix.d.min(0.0);
    let max_x = matrix.e + matrix.a.max(0.0) + matrix.c.max(0.0);
    let max_y = matrix.f + matrix.b.max(0.0) + matrix.d.max(0.0);
    max_x.min(page_view.x2) - min_x.max(page_view.x1) >= page_view.width() * 0.98
        && max_y.min(page_view.y2) - min_y.max(page_view.y1) >= page_view.height() * 0.98
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn decode_page_content_with_inline_images(
    document: &Document,
    page_id: ObjectId,
    max_decompressed_bytes: usize,
) -> Result<(
    Content<Vec<Operation>>,
    Vec<crate::content_parse::TInlineImageFacts>,
)> {
    decode_page_content_read(document, page_id, max_decompressed_bytes, borrowed_stream)
}

/// A stream whose document holds its bytes.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
fn borrowed_stream(
    _: ObjectId,
    stream: &Stream,
    _: usize,
) -> lopdf::Result<std::borrow::Cow<'_, Stream>> {
    Ok(std::borrow::Cow::Borrowed(stream))
}

fn decode_page_content_read<'d>(
    document: &'d Document,
    page_id: ObjectId,
    max_decompressed_bytes: usize,
    read: impl Fn(ObjectId, &'d Stream, usize) -> lopdf::Result<std::borrow::Cow<'d, Stream>>,
) -> Result<(
    Content<Vec<Operation>>,
    Vec<crate::content_parse::TInlineImageFacts>,
)> {
    let bytes =
        crate::page_content_read_with_limit(document, page_id, max_decompressed_bytes, read)
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

fn dominant_full_page_image_with_limit<'d>(
    document: &'d Document,
    page_id: ObjectId,
    page_view: PdfRect,
    max_decompressed_bytes: usize,
    read: impl Fn(ObjectId, &'d Stream, usize) -> lopdf::Result<std::borrow::Cow<'d, Stream>>,
) -> Result<Option<FullPageImage>> {
    let images = page_image_dimensions(document, page_id)
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::CorruptXref))?;
    if images.is_empty() {
        return Ok(None);
    }
    let (content, inline_images) =
        decode_page_content_read(document, page_id, max_decompressed_bytes, read)?;
    let mut aligned = inline_images.is_empty();
    let mut matrix = Matrix::IDENTITY;
    let mut stack = Vec::new();
    let mut dominant: Option<FullPageImage> = None;
    for operation in content.operations {
        match operation.operator.as_str() {
            "q" if operation.operands.is_empty() => stack.push(matrix),
            "Q" if operation.operands.is_empty() => match stack.pop() {
                Some(saved) => matrix = saved,
                None => aligned = false,
            },
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
                } else {
                    aligned = false;
                }
            }
            "cm" => aligned = false,
            "Do" => {
                let same = |a: f64, b: f64| (a - b).abs() <= 0.001;
                aligned &= operation.operands.len() == 1
                    && matrix.a > 0.0
                    && matrix.d > 0.0
                    && same(matrix.b, 0.0)
                    && same(matrix.c, 0.0)
                    && same(matrix.a, page_view.width())
                    && same(matrix.d, page_view.height())
                    && same(matrix.e, page_view.x1)
                    && same(matrix.f, page_view.y1);
                if operation.operands.len() != 1 || !covers_page(matrix, page_view) {
                    continue;
                }
                let Ok(name) = operation.operands[0].as_name() else {
                    aligned = false;
                    continue;
                };
                let Some(&(width_px, height_px)) = images.get(name) else {
                    aligned = false;
                    continue;
                };
                let candidate = FullPageImage {
                    width_px,
                    height_px,
                    width_points: matrix.a.hypot(matrix.b),
                    height_points: matrix.c.hypot(matrix.d),
                    all_images_page_aligned: false,
                };
                let candidate_area = candidate.width_px.saturating_mul(candidate.height_px);
                if candidate_area
                    > dominant.map_or(0, |image| image.width_px.saturating_mul(image.height_px))
                {
                    dominant = Some(candidate);
                }
            }
            "w" | "J" | "j" | "M" | "d" | "ri" | "i" | "g" | "G" | "rg" | "RG" | "k" | "K"
            | "cs" | "CS" | "sc" | "SC" | "scn" | "SCN" | "BMC" | "BDC" | "EMC" => {}
            _ => aligned = false,
        }
    }
    if let Some(image) = &mut dominant {
        image.all_images_page_aligned = aligned && stack.is_empty();
    }
    Ok(dominant)
}
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn dominant_full_page_image(
    document: &Document,
    page_id: ObjectId,
    page_view: PdfRect,
) -> Result<Option<FullPageImage>> {
    dominant_full_page_image_with_limit(
        document,
        page_id,
        page_view,
        MAX_DECOMPRESSED_PDF_STREAM_BYTES,
        borrowed_stream,
    )
}

#[cfg(test)]
pub(crate) fn collect_page_sizes(document: &Document) -> Result<PageSizesOutput> {
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

pub(crate) fn page_size_entry(
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
        dominant_image,
    })
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

/// Page sizes with the dominant image of each page, whose content streams
/// `source` reads by range one page at a time.
fn write_page_sizes_sidecar_source<S: ByteSource>(
    source: &SourcePdf<S>,
    output_path: &Path,
) -> Result<()> {
    let document = &source.document;
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
            let dominant_image = dominant_full_page_image_with_limit(
                document,
                page_id,
                page_view,
                MAX_DECOMPRESSED_PDF_STREAM_BYTES,
                |id, stream, max_bytes| source.with_bytes(id, stream, max_bytes),
            )?;
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
    metadata_only: bool,
) -> Result<()> {
    if page_sizes_paths_alias(input_path, output_path)? {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Page-size output must not alias the PDF input",
        ));
    }
    // Encryption is refused from the index, before any decryption.
    if metadata_only {
        let (file, len) = crate::open_source_file(input_path)?;
        let document = crate::load_page_geometry_source(file, len)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        return write_page_sizes_sidecar(&document, output_path);
    }
    let source = SourcePdf::open_plaintext_path(input_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    write_page_sizes_sidecar_source(&source, output_path)
}

/// Reads the complete metadata-only page geometry table (effective crop box,
/// rotation, and direct `/UserUnit` per page) by range from `bytes`, touching
/// only the cross-reference index and page-tree objects.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn read_page_geometry_table<S: ByteSource>(bytes: S, len: u64) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ExactPageGeometryEntry {
        page_number: u32,
        x_points: f64,
        y_points: f64,
        width_points: f64,
        height_points: f64,
        rotation: i64,
        user_unit: f64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ExactPageGeometryTable {
        page_count: u32,
        pages: Vec<ExactPageGeometryEntry>,
    }

    let document = crate::load_page_geometry_source(bytes, len)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    let page_resolver = PageTreeResolver::new(&document)?;
    let declared_page_count = page_resolver.page_count();
    if declared_page_count == 0 {
        return Err(domain_error(
            NativeErrorCode::CorruptXref,
            "PDF contains no pages",
        ));
    }
    let mut pages = Vec::new();
    pages
        .try_reserve_exact(declared_page_count as usize)
        .map_err(|_| "Page-geometry table exceeds available memory")?;
    let mut page_number = 0_u32;
    page_resolver
        .for_each_page_id_with_count(&document, |page_id| {
            page_number = page_number
                .checked_add(1)
                .ok_or("Page-size page number overflow")?;
            if page_number > declared_page_count || pages.len() >= declared_page_count as usize {
                return Err(domain_error(
                    NativeErrorCode::CorruptXref,
                    format!(
                        "PDF page tree declared {declared_page_count} pages but contains more than {declared_page_count}"
                    ),
                ));
            }
            let page_view = resolve_page_view(&document, page_id)?;
            let rotation = resolve_page_rotation(&document, page_id)?;
            let user_unit = resolve_page_user_unit(&document, page_id)?;
            pages.push(ExactPageGeometryEntry {
                page_number,
                x_points: page_view.x1,
                y_points: page_view.y1,
                width_points: page_view.width(),
                height_points: page_view.height(),
                rotation,
                user_unit,
            });
            Ok(())
        })
        .map_err(|error| {
            if error.is::<crate::NativeError>() {
                error
            } else {
                domain_error(NativeErrorCode::CorruptXref, error.to_string())
            }
        })?;
    Ok(serde_json::to_vec(&ExactPageGeometryTable {
        page_count: declared_page_count,
        pages,
    })?)
}

/// Streams the exact JSONL page-sizes sidecar (with or without dominant-image
/// raster analysis) from `bytes` into `write_chunk`. When `metadata_only` is
/// set, reads only the cross-reference index and page-tree geometry objects;
/// otherwise opens the full indexed graph and reads one page's content stream
/// at a time.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn write_page_sizes_sidecar_to_sink<S: ByteSource>(
    bytes: S,
    len: u64,
    metadata_only: bool,
    mut write_chunk: impl FnMut(&[u8]) -> Result<()>,
) -> Result<u32> {
    let (metadata_document, full_source) = if metadata_only {
        let document = crate::load_page_geometry_source(bytes, len)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        (Some(document), None)
    } else {
        let source = SourcePdf::open_plaintext(bytes, len)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        PageTreeResolver::with_both_ends(&source.document).map_err(crate::page_tree_damaged)?;
        (None, Some(source))
    };
    let document = metadata_document
        .as_ref()
        .unwrap_or_else(|| &full_source.as_ref().unwrap().document);
    let page_resolver = PageTreeResolver::new(document)?;
    let declared_page_count = u64::from(page_resolver.page_count());
    if declared_page_count == 0 {
        return Err(domain_error(
            NativeErrorCode::CorruptXref,
            "PDF contains no pages",
        ));
    }
    let chunk_limit = PAGE_SIZES_SIDECAR_CHUNK_BYTES;
    let dominant_image_analysis = if metadata_only {
        DominantImageAnalysis::Unavailable
    } else {
        DominantImageAnalysis::Performed
    };
    let encoded_reachable = format!(
        "{declared_page_count:>width$}",
        width = PAGE_COUNT_FIELD_WIDTH
    );
    let header = format!(
        "{{\"format\":\"{PAGE_SIZES_SIDECAR_FORMAT}\",\"schemaVersion\":{PAGE_SIZES_SIDECAR_SCHEMA_VERSION},\"pageCount\":{declared_page_count},\"declaredPageCount\":{declared_page_count},\"reachablePageCount\":{encoded_reachable},\"chunkBytes\":{chunk_limit},\"dominantImageAnalysis\":\"{}\"}}\n",
        dominant_image_analysis.as_str(),
    );
    write_chunk(header.as_bytes())?;
    let mut chunk: Option<PageSizesSidecarChunk> = None;
    let mut next_chunk_index = 0_u64;
    let mut page_number = 0_u32;
    let reachable_page_count = page_resolver
        .for_each_page_id_with_count(document, |page_id| {
            page_number = page_number
                .checked_add(1)
                .ok_or("Page-size page number overflow")?;
            if u64::from(page_number) > declared_page_count {
                return Err(domain_error(
                    NativeErrorCode::CorruptXref,
                    format!(
                        "PDF page tree declared {declared_page_count} pages but contains more than {declared_page_count}"
                    ),
                ));
            }
            let page_view = resolve_page_view(document, page_id)?;
            let rotation = resolve_page_rotation(document, page_id)?;
            let dominant_image = match full_source.as_ref() {
                None => None,
                Some(source) => dominant_full_page_image_with_limit(
                    document,
                    page_id,
                    page_view,
                    MAX_DECOMPRESSED_PDF_STREAM_BYTES,
                    |id, stream, max_bytes| source.with_bytes(id, stream, max_bytes),
                )?,
            };
            let entry = page_size_entry(
                document,
                page_number,
                page_id,
                rotation,
                page_view,
                dominant_image,
            )?;
            let encoded_entry = serde_json::to_vec(&entry)?;
            if chunk.is_none() {
                chunk = Some(PageSizesSidecarChunk::new(next_chunk_index, page_number));
            }
            if !chunk
                .as_mut()
                .unwrap()
                .try_push(&encoded_entry, chunk_limit)
            {
                if chunk.as_ref().is_some_and(|c| c.entry_count == 0) {
                    return Err(domain_error(
                        NativeErrorCode::TooLarge,
                        "Page-size entry exceeds the 4 MiB sidecar chunk limit",
                    ));
                }
                let finished = chunk.take().unwrap().finish();
                write_chunk(&finished)?;
                next_chunk_index = next_chunk_index
                    .checked_add(1)
                    .ok_or("Page-size sidecar chunk number overflow")?;
                chunk = Some(PageSizesSidecarChunk::new(next_chunk_index, page_number));
                if !chunk
                    .as_mut()
                    .unwrap()
                    .try_push(&encoded_entry, chunk_limit)
                {
                    return Err(domain_error(
                        NativeErrorCode::TooLarge,
                        "Page-size entry exceeds the 4 MiB sidecar chunk limit",
                    ));
                }
            }
            Ok(())
        })
        .map_err(|error| {
            if error.is::<crate::NativeError>() {
                error
            } else {
                domain_error(NativeErrorCode::CorruptXref, error.to_string())
            }
        })?;
    if reachable_page_count != declared_page_count {
        return Err(domain_error(
            NativeErrorCode::CorruptXref,
            format!(
                "PDF page tree declared {declared_page_count} pages but contains {reachable_page_count}"
            ),
        ));
    }
    if let Some(last) = chunk.take() {
        if last.entry_count > 0 {
            write_chunk(&last.finish())?;
        }
    }
    Ok(u32::try_from(declared_page_count)?)
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
pub(crate) mod tests {
    use super::*;
    use crate::{page_tree_node_read_count, reset_page_tree_node_read_count};
    use lopdf::{dictionary, Stream};

    pub(crate) fn create_test_document() -> (Document, ObjectId) {
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

    pub(crate) fn create_test_document_with_pages(page_count: usize) -> Document {
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
        assert_eq!(output.dominant_image.map(|image| image.width_px), None);
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

        assert_eq!(page.dominant_image.map(|image| image.width_px), Some(1000));
        assert_eq!(page.dominant_image.map(|image| image.height_px), Some(500));
        assert_eq!(
            page.dominant_image.map(|image| image.width_points),
            Some(200.0)
        );
        assert_eq!(
            page.dominant_image.map(|image| image.height_points),
            Some(100.0)
        );
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

        assert_eq!(page.dominant_image.map(|image| image.width_px), None);
        assert_eq!(page.dominant_image.map(|image| image.height_px), None);
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
            dominant_full_page_image_with_limit(&document, page_id, page_view, 32, borrowed_stream)
                .unwrap_err();
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

    /// zlib's stored (uncompressed) form of `data`, which is larger than it.
    pub(crate) fn stored_zlib(data: &[u8]) -> Vec<u8> {
        let (mut a, mut b) = (1_u32, 0_u32);
        for byte in data {
            a = (a + u32::from(*byte)) % 65_521;
            b = (b + a) % 65_521;
        }
        let len = data.len() as u16;
        let mut zlib = vec![0x78, 0x01, 0x01];
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(data);
        zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
        zlib
    }

    /// A 200 x 100 page that draws a 40 x 20 image over itself through
    /// `contents`, saved and read back through the indexed reader.
    fn image_page_source(contents: Vec<Stream>) -> (Vec<u8>, ObjectId) {
        let (mut document, page_id) = create_test_document();
        let image = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 40, "Height" => 20,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
            },
            vec![0; 800],
        ));
        let contents = contents
            .into_iter()
            .map(|stream| Object::Reference(document.add_object(stream)))
            .collect::<Vec<_>>();
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set(
            "Resources",
            dictionary! { "XObject" => dictionary! { "Im0" => image } },
        );
        page.set("Contents", contents);
        let bytes = crate::save_document_to_bytes(&mut document).unwrap();
        (bytes, page_id)
    }

    #[test]
    fn sidecar_header_reports_performed_dominant_image_analysis() {
        let (bytes, _) = image_page_source(vec![Stream::new(
            Dictionary::new(),
            b"q 200 0 0 100 0 0 cm /Im0 Do Q".to_vec(),
        )]);
        let output_path = std::env::temp_dir().join(format!(
            "evb-page-sizes-analysis-performed-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let source = SourcePdf::open(&bytes[..], bytes.len() as u64).unwrap();
        write_page_sizes_sidecar_source(&source, &output_path).unwrap();
        let output = fs::read_to_string(&output_path).unwrap();
        fs::remove_file(&output_path).unwrap();
        let mut lines = output.lines();
        let header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        let chunk: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();

        assert_eq!(header["declaredPageCount"], 1);
        assert_eq!(header["reachablePageCount"], 1);
        assert_eq!(header["dominantImageAnalysis"], "performed");
        // The page's content, which the source left unread, was read by range.
        let page = &chunk["pages"][0];
        assert_eq!(page["dominantImageWidthPx"], 40, "{output}");
        assert_eq!(page["dominantImageHeightPx"], 20, "{output}");
    }

    #[test]
    fn a_content_stream_larger_encoded_than_the_budget_it_decodes_within_is_read() {
        // 22 of 34 budget bytes go to the first stream and its newline; the
        // second decodes to 9 of the 12 left from 20 encoded bytes.
        let tail = b"/Im0 Do Q";
        let encoded = stored_zlib(tail);
        assert!(encoded.len() > 12);
        let (bytes, page_id) = image_page_source(vec![
            Stream::new(Dictionary::new(), b"q 200 0 0 100 0 0 cm\n".to_vec()),
            Stream::new(dictionary! { "Filter" => "FlateDecode" }, encoded),
        ]);
        let source = SourcePdf::open(&bytes[..], bytes.len() as u64).unwrap();
        let view = resolve_page_view(&source.document, page_id).unwrap();
        let image = dominant_full_page_image_with_limit(
            &source.document,
            page_id,
            view,
            34,
            |id, stream, max_bytes| source.with_bytes(id, stream, max_bytes),
        )
        .unwrap()
        .unwrap();
        assert_eq!((image.width_px, image.height_px), (40, 20));
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

    #[test]
    fn metadata_only_sidecar_to_sink_uses_page_geometry_source_and_matches_full_contract() {
        use std::cell::RefCell;

        struct GuardedSlice<'a> {
            bytes: &'a [u8],
            forbidden: (u64, u64),
            read_bytes: RefCell<u64>,
        }

        impl ByteSource for &GuardedSlice<'_> {
            fn read_at(&self, offset: u64, buffer: &mut [u8]) -> std::io::Result<()> {
                let end = offset + buffer.len() as u64;
                assert!(
                    end <= self.forbidden.0 || offset >= self.forbidden.1,
                    "metadata-only sidecar read forbidden non-geometry payload [{offset}..{end})"
                );
                *self.read_bytes.borrow_mut() += buffer.len() as u64;
                buffer.copy_from_slice(&self.bytes[offset as usize..end as usize]);
                Ok(())
            }

            fn copy_range(
                &self,
                _offset: u64,
                _len: u64,
                _output: &mut impl Write,
            ) -> std::io::Result<()> {
                Err(std::io::Error::other(
                    "metadata-only sidecar must not copy stream ranges",
                ))
            }
        }

        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let marker = b"EVB_FORBIDDEN_METADATA_ONLY_CONTENT_STREAM_MARKER";
        let mut payload = Vec::with_capacity(2 * 1024 * 1024);
        payload.extend_from_slice(marker);
        payload.resize(2 * 1024 * 1024, b'Z');
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 800,
                "Height" => 600,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            payload,
        ));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 500 0 0 700 0 0 cm /Scan Do Q".to_vec(),
        ));
        let page1_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 500.into(), 700.into()],
            "CropBox" => vec![10.into(), 20.into(), 410.into(), 620.into()],
            "Rotate" => 90,
            "UserUnit" => 2.0,
            "Resources" => dictionary! { "XObject" => dictionary! { "Scan" => image_id } },
            "Contents" => content_id,
        });
        let page2_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page1_id.into(), page2_id.into()],
                "Count" => 2,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let marker_pos = bytes
            .windows(marker.len())
            .position(|window| window == marker)
            .expect("stream payload must appear verbatim");
        let guarded = GuardedSlice {
            bytes: &bytes,
            forbidden: (
                (marker_pos + 128 * 1024) as u64,
                (marker_pos + 900 * 1024) as u64,
            ),
            read_bytes: RefCell::new(0),
        };
        let len = bytes.len() as u64;

        crate::pdf_source::reset_source_pdf_open_count();
        let mut metadata_out = Vec::new();
        let page_count = write_page_sizes_sidecar_to_sink(&guarded, len, true, |chunk| {
            metadata_out.extend_from_slice(chunk);
            Ok(())
        })
        .unwrap();
        assert_eq!(page_count, 2);
        assert_eq!(
            crate::pdf_source::source_pdf_open_count(),
            0,
            "metadata_only sidecar must use load_page_geometry_source rather than SourcePdf::open_plaintext"
        );
        assert!(*guarded.read_bytes.borrow() < len / 4);

        let lines: Vec<serde_json::Value> = std::str::from_utf8(&metadata_out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["format"], PAGE_SIZES_SIDECAR_FORMAT);
        assert_eq!(lines[0]["schemaVersion"], PAGE_SIZES_SIDECAR_SCHEMA_VERSION);
        assert_eq!(lines[0]["pageCount"], 2);
        assert_eq!(lines[0]["declaredPageCount"], 2);
        assert_eq!(lines[0]["reachablePageCount"], 2);
        assert_eq!(lines[0]["dominantImageAnalysis"], "unavailable");
        assert_eq!(lines[1]["chunkIndex"], 0);
        assert_eq!(lines[1]["firstPageNumber"], 1);
        assert_eq!(lines[1]["pages"][0]["xPoints"], 10.0);
        assert_eq!(lines[1]["pages"][0]["yPoints"], 20.0);
        assert_eq!(lines[1]["pages"][0]["widthPoints"], 400.0);
        assert_eq!(lines[1]["pages"][0]["heightPoints"], 600.0);
        assert_eq!(lines[1]["pages"][0]["rotation"], 90);
        assert_eq!(lines[1]["pages"][0]["userUnit"], 2.0);
        assert_eq!(lines[1]["pages"][0]["mediaWidthPoints"], 500.0);
        assert_eq!(lines[1]["pages"][0]["mediaHeightPoints"], 700.0);
        assert_eq!(lines[1]["pages"][0]["cropWidthPoints"], 400.0);
        assert_eq!(lines[1]["pages"][0]["cropHeightPoints"], 600.0);
        assert!(lines[1]["pages"][0].get("dominantImageWidthPx").is_none());
        assert_eq!(lines[1]["pages"][1]["widthPoints"], 612.0);
        assert_eq!(lines[1]["pages"][1]["heightPoints"], 792.0);

        // Non-metadata-only still opens full source and performs dominant image analysis.
        let mut full_out = Vec::new();
        let full_count = write_page_sizes_sidecar_to_sink(bytes.as_slice(), len, false, |chunk| {
            full_out.extend_from_slice(chunk);
            Ok(())
        })
        .unwrap();
        assert_eq!(full_count, 2);
        let full_lines: Vec<serde_json::Value> = std::str::from_utf8(&full_out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(full_lines[0]["dominantImageAnalysis"], "performed");
        assert_eq!(full_lines[1]["pages"][0]["dominantImageWidthPx"], 800);
        assert_eq!(full_lines[1]["pages"][0]["dominantImageHeightPx"], 600);
    }

    #[test]
    fn metadata_only_sidecar_to_sink_refuses_corrupt_xref_and_malformed_page_trees_equivalently() {
        let assert_same_code = |pdf_bytes: &[u8], expected: NativeErrorCode, label: &str| {
            let meta_err =
                write_page_sizes_sidecar_to_sink(pdf_bytes, pdf_bytes.len() as u64, true, |_| {
                    Ok(())
                })
                .expect_err(&format!("{label} must fail for metadata_only=true"));
            let full_err =
                write_page_sizes_sidecar_to_sink(pdf_bytes, pdf_bytes.len() as u64, false, |_| {
                    Ok(())
                })
                .expect_err(&format!("{label} must fail for metadata_only=false"));
            let meta_code = meta_err
                .downcast_ref::<crate::NativeError>()
                .unwrap_or_else(|| panic!("{label} metadata_only missing NativeError: {meta_err}"))
                .code;
            let full_code = full_err
                .downcast_ref::<crate::NativeError>()
                .unwrap_or_else(|| panic!("{label} full missing NativeError: {full_err}"))
                .code;
            assert_eq!(meta_code, expected, "{label} metadata_only code mismatch");
            assert_eq!(full_code, expected, "{label} full code mismatch");
        };

        // 1. Corrupt xref / invalid PDF bytes -> CorruptXref.
        assert_same_code(
            b"%PDF-1.7\ngarbage\n",
            NativeErrorCode::CorruptXref,
            "corrupt xref",
        );

        // 1b. Corrupt xref entry pointing a page-tree geometry object to the wrong object ID -> CorruptXref.
        let mut wrong_id_doc = Document::with_version("1.7");
        wrong_id_doc.reference_table.cross_reference_type =
            lopdf::xref::XrefType::CrossReferenceTable;
        let pages_id = wrong_id_doc.new_object_id();
        let media_box_id = wrong_id_doc.add_object(Object::Array(vec![
            0.into(),
            0.into(),
            200.into(),
            300.into(),
        ]));
        let page_id = wrong_id_doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => media_box_id,
        });
        wrong_id_doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = wrong_id_doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        wrong_id_doc.trailer.set("Root", catalog_id);
        let mut wrong_id_bytes = Vec::new();
        wrong_id_doc.save_to(&mut wrong_id_bytes).unwrap();
        let header = format!("{} 0 obj", media_box_id.0);
        let replacement = format!("{} 0 obj", media_box_id.0 + 7);
        assert_eq!(header.len(), replacement.len());
        let header_pos = wrong_id_bytes
            .windows(header.len())
            .position(|window| window == header.as_bytes())
            .expect("indirect MediaBox object header must exist");
        wrong_id_bytes[header_pos..header_pos + header.len()]
            .copy_from_slice(replacement.as_bytes());
        assert_same_code(
            &wrong_id_bytes,
            NativeErrorCode::CorruptXref,
            "xref entry pointing to mismatched geometry object ID",
        );

        // 2. Encrypted PDF -> Encrypted (refused from index).
        let mut encrypted_doc = create_test_document().0;
        let encrypt_id = encrypted_doc.add_object(dictionary! {
            "Filter" => "Standard",
            "V" => 2,
            "R" => 3,
            "Length" => 128,
            "P" => -4,
            "O" => Object::string_literal("01234567890123456789012345678901"),
            "U" => Object::string_literal("01234567890123456789012345678901"),
        });
        encrypted_doc.trailer.set("Encrypt", encrypt_id);
        let mut encrypted_bytes = Vec::new();
        encrypted_doc.save_to(&mut encrypted_bytes).unwrap();
        assert_same_code(
            &encrypted_bytes,
            NativeErrorCode::Encrypted,
            "encrypted PDF",
        );

        // 3. Empty page tree (/Pages exists with /Count 0) -> InvalidRequest (page_tree_damaged).
        let mut empty_tree = Document::with_version("1.7");
        let pages_id = empty_tree.add_object(dictionary! {
            "Type" => "Pages",
            "Kids" => Vec::<Object>::new(),
            "Count" => 0,
        });
        let catalog_id = empty_tree.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        empty_tree.trailer.set("Root", catalog_id);
        let mut empty_bytes = Vec::new();
        empty_tree.save_to(&mut empty_bytes).unwrap();
        assert_same_code(
            &empty_bytes,
            NativeErrorCode::InvalidRequest,
            "empty page tree",
        );

        // 4. Dangling /Pages reference (missing from xref) -> CorruptXref.
        let mut dangling = Document::with_version("1.7");
        let catalog_id = dangling.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference((999, 0)),
        });
        dangling.trailer.set("Root", catalog_id);
        let mut dangling_bytes = Vec::new();
        dangling.save_to(&mut dangling_bytes).unwrap();
        assert_same_code(
            &dangling_bytes,
            NativeErrorCode::CorruptXref,
            "dangling /Pages",
        );

        // 5. Shared /Kids DAG exceeding /Count -> CorruptXref immediately.
        let mut dag = Document::with_version("1.7");
        let leaf_id = dag.add_object(dictionary! {
            "Type" => "Page",
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
        });
        let mut child_id = leaf_id;
        for _ in 0..25 {
            let node_id = dag.new_object_id();
            dag.objects.insert(
                node_id,
                Object::Dictionary(dictionary! {
                    "Type" => "Pages",
                    "Kids" => vec![child_id.into(), child_id.into()],
                    "Count" => 1,
                }),
            );
            child_id = node_id;
        }
        let catalog_id = dag.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => child_id,
        });
        dag.trailer.set("Root", catalog_id);
        let mut dag_bytes = Vec::new();
        dag.save_to(&mut dag_bytes).unwrap();
        assert_same_code(&dag_bytes, NativeErrorCode::CorruptXref, "shared-kids DAG");

        // 6. Fewer reachable leaves than declared /Count (both ends valid, middle branch empty) -> CorruptXref.
        let mut short_doc = Document::with_version("1.7");
        let root_pages = short_doc.new_object_id();
        let left_page = short_doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => root_pages,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
        });
        let empty_middle = short_doc.add_object(dictionary! {
            "Type" => "Pages",
            "Parent" => root_pages,
            "Kids" => Vec::<Object>::new(),
            "Count" => 1,
        });
        let right_page = short_doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => root_pages,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
        });
        short_doc.objects.insert(
            root_pages,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![left_page.into(), empty_middle.into(), right_page.into()],
                "Count" => 3,
            }),
        );
        let catalog_id = short_doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => root_pages,
        });
        short_doc.trailer.set("Root", catalog_id);
        let mut short_bytes = Vec::new();
        short_doc.save_to(&mut short_bytes).unwrap();
        assert_same_code(
            &short_bytes,
            NativeErrorCode::CorruptXref,
            "declared count exceeds reachable pages",
        );
    }
}
