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
    assert_plaintext_base, classify_pdf_load_error, domain_error, intersect_rect,
    load_annotation_index_pdf_path, load_pdf_path, reclassify_domain_error, resolve_inherited_box,
    resolve_page_rotation, resolve_page_view, AppendedRevision, NativeErrorCode, PageTreeResolver,
    PdfObjectSource, PdfRect, Result, MAX_DECOMPRESSED_PDF_STREAM_BYTES, MAX_ENCODED_PDF_BYTES,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
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

fn resolved_dictionary<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match object {
        Object::Dictionary(dictionary) => Some(dictionary),
        Object::Reference(id) => document.get_dictionary(*id).ok(),
        _ => None,
    }
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
    let bytes = document
        .get_page_content_with_limit(page_id, max_decompressed_bytes)
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
    Content::decode(&bytes).map_err(|error| {
        domain_error(
            NativeErrorCode::CorruptXref,
            format!("Failed to parse PDF page content: {error}"),
        )
    })
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

#[allow(dead_code)]
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

#[allow(dead_code)]
pub(crate) fn write_page_sizes_json(document: &Document, output_path: &Path) -> Result<()> {
    let page_sizes = collect_page_sizes(document)?;
    fs::write(output_path, serde_json::to_vec(&page_sizes)?)?;
    Ok(())
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
    let declared_page_count = u64::from(page_resolver.declared_page_count());
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
    if encoded_len <= MAX_ENCODED_PDF_BYTES as u64 {
        let document = load_pdf_path(input_path)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        assert_plaintext_base(
            &document,
            "Encrypted PDFs are not supported by native page ops",
        )?;
        return write_page_sizes_sidecar_document(&document, output_path);
    }

    let qpdf_path = qpdf_path.ok_or_else(|| {
        domain_error(
            NativeErrorCode::TooLarge,
            "Large page-size input requires the bundled qpdf structural reader",
        )
    })?;
    let incremental = load_annotation_index_pdf_path(input_path, Some(qpdf_path))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let structural = AppendedRevision::new(&incremental);
    write_page_sizes_sidecar(&structural, output_path)
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
