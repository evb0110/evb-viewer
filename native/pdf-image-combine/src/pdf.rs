use fax::{encoder::Encoder as FaxEncoder, slice_bits, Color, VecWriter};
use flate2::{write::ZlibEncoder, Compression};
use jbig2_codec::Bilevel;
use std::{collections::HashMap, fmt::Write as FmtWrite, io::Write as IoWrite, sync::Arc};

use evb_native_support::pdf_catalog::{
    normalize_bookmark_entries, normalize_page_label_ranges, resolve_bookmark_destination_top,
    BookmarkEntry, PageLabelRange, MAX_BOOKMARK_DEPTH, MAX_BOOKMARK_ITEMS, MAX_PAGE_LABEL_RANGES,
};

use crate::{flate::deflate_up_filtered_slices, netpbm::PbmP4Image, PdfBilevelDecode, Result};

pub(crate) enum ImagePayload {
    RawFlate {
        data: Vec<u8>,
        decode_params: String,
    },
    Jpeg {
        data: Vec<u8>,
    },
    Jpx {
        data: Vec<u8>,
    },
    Bilevel(BilevelStream),
}

pub(crate) struct ImagePage {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) dpi: u32,
    pub(crate) color_space: &'static str,
    pub(crate) icc_profile: Option<Vec<u8>>,
    pub(crate) payload: ImagePayload,
}

#[derive(Clone, Copy)]
pub struct PdfPageSize {
    pub width_points: f64,
    pub height_points: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PdfImagePlacement {
    pub x_points: f64,
    pub y_points: f64,
    pub width_points: f64,
    pub height_points: f64,
}

pub enum LayeredImagePayload {
    RawFlate {
        data: Vec<u8>,
        decode_params: String,
    },
    Jpeg {
        data: Vec<u8>,
    },
    Jpx {
        data: Vec<u8>,
    },
}

pub struct LayeredPdfImage {
    pub width: u32,
    pub height: u32,
    pub color_space: &'static str,
    pub payload: LayeredImagePayload,
}

pub struct LayeredPdfPage {
    pub page_size: PdfPageSize,
    pub background: LayeredPdfImage,
    pub foreground_mask: BilevelStream,
    pub foreground_color: Option<[u8; 3]>,
}

pub struct SoftMaskStream {
    width: u32,
    height: u32,
    data: Vec<u8>,
    decode_params: String,
}

impl SoftMaskStream {
    pub(crate) fn encode(width: u32, height: u32, pixels: &[u8]) -> Result<Self> {
        let expected = width as usize * height as usize;
        if width == 0 || height == 0 || pixels.len() != expected {
            return Err("Invalid soft foreground alpha dimensions".into());
        }
        Ok(Self {
            width,
            height,
            data: deflate_up_filtered_slices(pixels, width as usize, height as usize)?,
            decode_params: format!(
                "<< /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns {width} >>"
            ),
        })
    }
}

pub struct SoftLayeredPdfPage {
    pub page_size: PdfPageSize,
    pub background: LayeredPdfImage,
    pub foreground_alpha: SoftMaskStream,
    pub foreground_color: Option<[u8; 3]>,
}

pub struct AffineMaskedLayeredPdfPage {
    pub page_size: PdfPageSize,
    pub background: LayeredPdfImage,
    pub foreground: LayeredPdfImage,
    pub foreground_mask: BilevelStream,
    /// PDF user-space matrix mapping the foreground image's unit square to
    /// the cleaned page. The foreground image and mask remain in their compact
    /// source grid; crop, deskew, and page placement live in this matrix.
    pub foreground_matrix: [f64; 6],
}

pub struct MaskPdfPage {
    pub page_size: PdfPageSize,
    pub foreground_mask: BilevelStream,
}

/// A validated bilevel bitmap already reduced to the single PDF stream that
/// will be written for it. Encoding happens while pages are prepared, so page
/// preparation can run off the writer's thread and the writer only serializes
/// bytes.
pub struct BilevelStream {
    width: u32,
    height: u32,
    payload: BilevelPayload,
    /// Retained only until a bounded writer chunk has evaluated shared symbol
    /// coding. Source-authored JBIG2 streams never populate this field.
    raw_mask: Option<PbmP4Image>,
}

impl BilevelStream {
    pub(crate) fn supports_symbol_encoding(&self) -> bool {
        self.raw_mask.is_some()
    }

    pub(crate) fn encode(mask: &PbmP4Image) -> Result<Self> {
        validate_image_mask(mask)?;
        Ok(Self {
            width: mask.width,
            height: mask.height,
            payload: encode_mask_payload(mask)?,
            raw_mask: Some(mask.clone()),
        })
    }

    pub(crate) fn from_pdf_jbig2(
        width: u32,
        height: u32,
        data: Vec<u8>,
        decode: PdfBilevelDecode,
    ) -> Result<Self> {
        if width == 0 || height == 0 || data.is_empty() {
            return Err("Invalid source JBIG2 selection mask".into());
        }
        Ok(Self {
            width,
            height,
            payload: BilevelPayload::PdfJbig2 { data, decode },
            raw_mask: None,
        })
    }
}

/// Evaluates one bounded cross-page symbol dictionary against the already
/// selected lossless per-page payloads. Any classifier, encoder, decoder, or
/// strict verification failure leaves every page on its existing generic/G4/
/// Flate payload and emits a structured fallback record.
const SHARED_SYMBOL_GLOBAL_OBJECT_OVERHEAD: usize = 128;
const SHARED_SYMBOL_PAGE_REFERENCE_OVERHEAD: usize = 64;

fn shared_symbol_encoding_saves_pdf_bytes(
    fallback_bytes: usize,
    symbol_bytes: usize,
    selected_pages: usize,
) -> bool {
    let pdf_overhead = SHARED_SYMBOL_GLOBAL_OBJECT_OVERHEAD
        .saturating_add(selected_pages.saturating_mul(SHARED_SYMBOL_PAGE_REFERENCE_OVERHEAD));
    symbol_bytes.saturating_add(pdf_overhead) < fallback_bytes
}

pub(crate) fn apply_shared_symbol_encoding(streams: &mut [&mut BilevelStream]) {
    if streams.is_empty() || streams.iter().any(|stream| stream.raw_mask.is_none()) {
        return;
    }
    let encoded = {
        let pages = streams
            .iter()
            .filter_map(|stream| stream.raw_mask.as_ref())
            .map(|mask| Bilevel {
                width: mask.width,
                height: mask.height,
                rows: &mask.bitmap,
            })
            .collect::<Vec<_>>();
        jbig2_codec::encode_pdf_symbol_pages_verified(
            &pages,
            jbig2_codec::SymbolEncodeLimits::default(),
        )
    };
    let encoded = match encoded {
        Ok(encoded) => encoded,
        Err(_error) => {
            #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
            eprintln!(
                "{}",
                symbol_fallback_record(streams.len(), &_error.to_string())
            );
            return;
        }
    };
    if encoded.pages.len() != streams.len() {
        #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
        eprintln!(
            "{}",
            symbol_fallback_record(
                streams.len(),
                "verified symbol encoder returned the wrong page count",
            )
        );
        return;
    }

    let fallback_bytes = streams
        .iter()
        .map(|stream| stream.payload.data().len())
        .sum::<usize>();
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    for fallback in &encoded.fallback_pages {
        eprintln!(
            "{}",
            symbol_page_fallback_record(fallback.page_index, &fallback.reason.to_string())
        );
    }
    let symbol_bytes = encoded.globals.len()
        + encoded
            .pages
            .iter()
            .zip(streams.iter())
            .map(|(page, stream)| {
                page.as_ref()
                    .map_or_else(|| stream.payload.data().len(), |page| page.data.len())
            })
            .sum::<usize>();
    let selected_pages = encoded.pages.iter().filter(|page| page.is_some()).count();
    if !shared_symbol_encoding_saves_pdf_bytes(fallback_bytes, symbol_bytes, selected_pages) {
        #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
        eprintln!(
            "{}",
            symbol_size_record(
                "jbig2-symbol-not-selected",
                encoded.pages.iter().filter(|page| page.is_some()).count(),
                streams.len() - encoded.pages.iter().filter(|page| page.is_some()).count(),
                encoded.symbol_count,
                encoded.component_count,
                encoded.class_comparison_count,
                fallback_bytes,
                symbol_bytes,
            )
        );
        return;
    }

    let globals = Arc::new(encoded.globals);
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    let symbol_count = encoded.symbol_count;
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    let component_count = encoded.component_count;
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    let class_comparison_count = encoded.class_comparison_count;
    for (stream, page) in streams.iter_mut().zip(encoded.pages) {
        if let Some(page) = page {
            stream.payload = BilevelPayload::Jbig2Symbol {
                data: page.data,
                globals: Arc::clone(&globals),
            };
            stream.raw_mask = None;
        }
    }
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    eprintln!(
        "{}",
        symbol_size_record(
            "jbig2-symbol-selected",
            selected_pages,
            streams.len() - selected_pages,
            symbol_count,
            component_count,
            class_comparison_count,
            fallback_bytes,
            symbol_bytes,
        )
    );
}

#[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
fn symbol_fallback_record(pages: usize, reason: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "jbig2-symbol-fallback",
        "pages": pages,
        "reason": reason,
    })
}

#[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
fn symbol_page_fallback_record(page: usize, reason: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "jbig2-symbol-page-fallback",
        "pageInChunk": page,
        "reason": reason,
    })
}

#[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
fn symbol_size_record(
    record_type: &str,
    pages: usize,
    fallback_pages: usize,
    symbols: usize,
    components: usize,
    class_comparisons: usize,
    fallback_bytes: usize,
    symbol_bytes: usize,
) -> serde_json::Value {
    serde_json::json!({
        "type": record_type,
        "pages": pages,
        "fallbackPages": fallback_pages,
        "symbols": symbols,
        "components": components,
        "classComparisons": class_comparisons,
        "fallbackBytes": fallback_bytes,
        "symbolBytes": symbol_bytes,
    })
}

#[cfg(test)]
pub(crate) fn build_pdf(pages: &[ImagePage]) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new(), None)?;
    for page in pages {
        writer.add_page(page)?;
    }
    writer.finish()
}

#[cfg(test)]
pub(crate) fn build_layered_pdf_page(page: &LayeredPdfPage) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new(), None)?;
    writer.add_layered_page(page)?;
    writer.finish()
}

#[cfg(test)]
pub(crate) fn build_soft_layered_pdf_page(page: &SoftLayeredPdfPage) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new(), None)?;
    writer.add_soft_layered_page(page)?;
    writer.finish()
}

#[cfg(test)]
pub(crate) fn build_affine_masked_layered_pdf_page(
    page: &AffineMaskedLayeredPdfPage,
) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new(), None)?;
    writer.add_affine_masked_layered_page(page)?;
    writer.finish()
}

#[cfg(test)]
pub(crate) fn build_mask_pdf_page(page: &MaskPdfPage) -> Result<Vec<u8>> {
    let mut writer = PdfWriter::new(Vec::new(), None)?;
    writer.add_mask_page(page)?;
    writer.finish()
}

pub(crate) fn write_pdf_to_writer<W: IoWrite>(
    writer: W,
    provenance_stamp_hex: Option<&str>,
    outlines: &[BookmarkEntry],
    page_labels: &[PageLabelRange],
    mut write_pages: impl FnMut(&mut PdfWriter<W>) -> Result<()>,
) -> Result<W> {
    let mut writer =
        PdfWriter::new_with_catalog(writer, provenance_stamp_hex, outlines, page_labels)?;
    write_pages(&mut writer)?;
    writer.finish()
}

pub(crate) struct PdfWriter<W: IoWrite> {
    inner: W,
    offsets: Vec<Option<usize>>,
    page_objects: Vec<usize>,
    next_object: usize,
    bytes_written: usize,
    provenance_stamp_hex: Option<String>,
    outlines: Vec<BookmarkEntry>,
    page_labels: Vec<PageLabelRange>,
    outlines_object: Option<usize>,
    page_labels_object: Option<usize>,
    page_dimensions: Vec<(f64, f64)>,
    // Key by the dictionary bytes, not an allocation address. Writer chunks
    // release their page-owned `Arc`s after serialization, so a later chunk
    // may otherwise reuse the same address for different globals and point at
    // the wrong PDF object. Retaining the `Arc` keys also keeps lookup cheap
    // for every page that shares one dictionary.
    jbig2_globals_objects: HashMap<Arc<Vec<u8>>, usize>,
}

impl<W: IoWrite> PdfWriter<W> {
    #[allow(dead_code)]
    fn new(inner: W, provenance_stamp_hex: Option<&str>) -> Result<Self> {
        Self::new_with_catalog(inner, provenance_stamp_hex, &[], &[])
    }

    fn new_with_catalog(
        inner: W,
        provenance_stamp_hex: Option<&str>,
        outlines: &[BookmarkEntry],
        page_labels: &[PageLabelRange],
    ) -> Result<Self> {
        if let Some(stamp) = provenance_stamp_hex {
            validate_provenance_stamp_hex(stamp)?;
        }
        validate_catalog_inputs(outlines, page_labels)?;
        let mut next_object = 3;
        let outlines_object = if outlines.is_empty() {
            None
        } else {
            let object = next_object;
            next_object += 1;
            Some(object)
        };
        let page_labels_object = if page_labels.is_empty() {
            None
        } else {
            let object = next_object;
            next_object += 1;
            Some(object)
        };
        let mut catalog_body = String::from("<< /Type /Catalog /Pages 2 0 R");
        if let Some(object) = outlines_object {
            let _ = write!(
                catalog_body,
                " /Outlines {object} 0 R /PageMode /UseOutlines"
            );
        }
        if let Some(object) = page_labels_object {
            let _ = write!(catalog_body, " /PageLabels {object} 0 R");
        }
        catalog_body.push_str(" >>");
        let mut writer = Self {
            inner,
            offsets: Vec::new(),
            page_objects: Vec::new(),
            next_object,
            bytes_written: 0,
            provenance_stamp_hex: provenance_stamp_hex.map(str::to_owned),
            outlines: outlines.to_vec(),
            page_labels: page_labels.to_vec(),
            outlines_object,
            page_labels_object,
            page_dimensions: Vec::new(),
            jbig2_globals_objects: HashMap::new(),
        };

        writer.write_all(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")?;
        writer.push_object(1, catalog_body.as_bytes())?;
        Ok(writer)
    }

    #[allow(dead_code)]
    pub(crate) fn add_page(&mut self, page: &ImagePage) -> Result<()> {
        self.add_page_with_rotation(page, 0)
    }

    pub(crate) fn add_page_with_rotation(
        &mut self,
        page: &ImagePage,
        rotation_degrees: u16,
    ) -> Result<()> {
        self.add_image_page(page, None, None, rotation_degrees)
    }

    #[allow(dead_code)]
    pub(crate) fn add_page_with_size(
        &mut self,
        page: &ImagePage,
        page_size: &PdfPageSize,
        placement: Option<&PdfImagePlacement>,
    ) -> Result<()> {
        self.add_page_with_size_and_rotation(page, page_size, placement, 0)
    }

    pub(crate) fn add_page_with_size_and_rotation(
        &mut self,
        page: &ImagePage,
        page_size: &PdfPageSize,
        placement: Option<&PdfImagePlacement>,
        rotation_degrees: u16,
    ) -> Result<()> {
        self.add_image_page(page, Some(page_size), placement, rotation_degrees)
    }

    fn add_image_page(
        &mut self,
        page: &ImagePage,
        page_size: Option<&PdfPageSize>,
        placement: Option<&PdfImagePlacement>,
        rotation_degrees: u16,
    ) -> Result<()> {
        validate_rotation_degrees(rotation_degrees)?;
        if let Some(size) = page_size {
            validate_page_size(size)?;
        }
        if let Some(placement) = placement {
            let page_size = page_size.ok_or("Image placement requires an explicit page size")?;
            validate_image_placement(placement, page_size)?;
        }
        if let ImagePayload::Bilevel(stream) = &page.payload {
            self.ensure_jbig2_globals(stream)?;
        }
        let page_object = self.next_object;
        let image_object = page_object + 1;
        let content_object = page_object + 2;
        let icc_object = page.icc_profile.as_ref().map(|_| page_object + 3);
        self.next_object += if icc_object.is_some() { 4 } else { 3 };
        self.page_objects.push(page_object);

        let image_name = format!("Im{}", self.page_objects.len());
        let page_width = page_size
            .map(|size| size.width_points)
            .unwrap_or_else(|| points(page.width, page.dpi));
        let page_height = page_size
            .map(|size| size.height_points)
            .unwrap_or_else(|| points(page.height, page.dpi));
        let rotation = if rotation_degrees == 0 {
            String::new()
        } else {
            format!(" /Rotate {rotation_degrees}")
        };
        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}]{} /Resources << /XObject << /{} {} 0 R >> >> /Contents {} 0 R >>",
            page_width, page_height, rotation, image_name, image_object, content_object
        );
        self.push_object(page_object, page_body.as_bytes())?;
        self.page_dimensions.push((page_width, page_height));
        self.push_image_object(image_object, page, icc_object)?;
        if let (Some(object_number), Some(profile)) = (icc_object, page.icc_profile.as_ref()) {
            let components = if page.color_space == "DeviceGray" {
                1
            } else {
                3
            };
            let dict = format!(
                "<< /N {} /Alternate /{} /Length {} >>",
                components,
                page.color_space,
                profile.len()
            );
            self.push_stream_object(object_number, dict.as_bytes(), profile)?;
        }

        let content_stream = if let Some(placement) = placement {
            format!(
                "q {:.4} 0 0 {:.4} {:.4} {:.4} cm /{} Do Q\n",
                placement.width_points,
                placement.height_points,
                placement.x_points,
                placement.y_points,
                image_name
            )
        } else {
            format!(
                "q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
                page_width, page_height, image_name
            )
        };
        let content_dict = format!("<< /Length {} >>", content_stream.len());
        self.push_stream_object(
            content_object,
            content_dict.as_bytes(),
            content_stream.as_bytes(),
        )?;
        Ok(())
    }

    pub(crate) fn add_layered_page(&mut self, page: &LayeredPdfPage) -> Result<()> {
        validate_page_size(&page.page_size)?;
        self.ensure_jbig2_globals(&page.foreground_mask)?;
        let page_object = self.next_object;
        let background_object = page_object + 1;
        let mask_object = page_object + 2;
        let content_object = page_object + 3;
        self.next_object = content_object + 1;
        self.page_objects.push(page_object);

        let page_index = self.page_objects.len();
        let background_name = format!("Bg{page_index}");
        let mask_name = format!("FgMask{page_index}");
        let page_width = page.page_size.width_points;
        let page_height = page.page_size.height_points;
        let xobjects = format!(
            "/{} {} 0 R /{} {} 0 R",
            background_name, background_object, mask_name, mask_object
        );
        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}] /Resources << /XObject << {} >> >> /Contents {} 0 R >>",
            page_width, page_height, xobjects, content_object
        );
        self.push_object(page_object, page_body.as_bytes())?;
        self.page_dimensions.push((page_width, page_height));
        self.push_layered_image_object(background_object, &page.background)?;
        self.push_image_mask_object(mask_object, &page.foreground_mask)?;

        let foreground_fill = if let Some([red, green, blue]) = page.foreground_color {
            format!(
                "{:.4} {:.4} {:.4} rg\n",
                f64::from(red) / 255.0,
                f64::from(green) / 255.0,
                f64::from(blue) / 255.0
            )
        } else {
            "0 g\n".to_string()
        };
        let content_stream = format!(
            "q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n{}q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
            page_width,
            page_height,
            background_name,
            foreground_fill,
            page_width,
            page_height,
            mask_name
        );
        let content_dict = format!("<< /Length {} >>", content_stream.len());
        self.push_stream_object(
            content_object,
            content_dict.as_bytes(),
            content_stream.as_bytes(),
        )?;
        Ok(())
    }

    pub(crate) fn add_soft_layered_page(&mut self, page: &SoftLayeredPdfPage) -> Result<()> {
        validate_page_size(&page.page_size)?;
        let page_object = self.next_object;
        let background_object = page_object + 1;
        let foreground_object = page_object + 2;
        let alpha_object = page_object + 3;
        let content_object = page_object + 4;
        self.next_object = content_object + 1;
        self.page_objects.push(page_object);

        let page_index = self.page_objects.len();
        let background_name = format!("Bg{page_index}");
        let foreground_name = format!("FgSoft{page_index}");
        let page_width = page.page_size.width_points;
        let page_height = page.page_size.height_points;
        let xobjects = format!(
            "/{} {} 0 R /{} {} 0 R",
            background_name, background_object, foreground_name, foreground_object
        );
        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}] /Resources << /XObject << {} >> >> /Contents {} 0 R >>",
            page_width, page_height, xobjects, content_object
        );
        self.push_object(page_object, page_body.as_bytes())?;
        self.page_dimensions.push((page_width, page_height));
        self.push_layered_image_object(background_object, &page.background)?;
        self.push_soft_foreground_object(
            foreground_object,
            alpha_object,
            &page.foreground_alpha,
            page.foreground_color.unwrap_or([0; 3]),
        )?;
        self.push_soft_mask_object(alpha_object, &page.foreground_alpha)?;

        let content_stream = format!(
            "q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\nq {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
            page_width, page_height, background_name, page_width, page_height, foreground_name
        );
        let content_dict = format!("<< /Length {} >>", content_stream.len());
        self.push_stream_object(
            content_object,
            content_dict.as_bytes(),
            content_stream.as_bytes(),
        )?;
        Ok(())
    }

    pub(crate) fn add_affine_masked_layered_page(
        &mut self,
        page: &AffineMaskedLayeredPdfPage,
    ) -> Result<()> {
        validate_page_size(&page.page_size)?;
        if page.foreground.width != page.foreground_mask.width
            || page.foreground.height != page.foreground_mask.height
        {
            return Err("Masked foreground image and selection mask dimensions differ".into());
        }
        if page
            .foreground_matrix
            .iter()
            .any(|value| !value.is_finite())
        {
            return Err("Masked foreground matrix contains a non-finite value".into());
        }
        self.ensure_jbig2_globals(&page.foreground_mask)?;

        let page_object = self.next_object;
        let background_object = page_object + 1;
        let foreground_object = page_object + 2;
        let mask_object = page_object + 3;
        let content_object = page_object + 4;
        self.next_object = content_object + 1;
        self.page_objects.push(page_object);

        let page_index = self.page_objects.len();
        let background_name = format!("Bg{page_index}");
        let foreground_name = format!("FgMrc{page_index}");
        let page_width = page.page_size.width_points;
        let page_height = page.page_size.height_points;
        let xobjects = format!(
            "/{} {} 0 R /{} {} 0 R",
            background_name, background_object, foreground_name, foreground_object
        );
        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}] /Resources << /XObject << {} >> >> /Contents {} 0 R >>",
            page_width, page_height, xobjects, content_object
        );
        self.push_object(page_object, page_body.as_bytes())?;
        self.page_dimensions.push((page_width, page_height));
        self.push_layered_image_object(background_object, &page.background)?;
        self.push_masked_layered_image_object(foreground_object, mask_object, &page.foreground)?;
        self.push_bilevel_image_object(mask_object, &page.foreground_mask)?;

        let [a, b, c, d, e, f] = page.foreground_matrix;
        let content_stream = format!(
            "q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\nq {:.8} {:.8} {:.8} {:.8} {:.8} {:.8} cm /{} Do Q\n",
            page_width,
            page_height,
            background_name,
            a,
            b,
            c,
            d,
            e,
            f,
            foreground_name
        );
        let content_dict = format!("<< /Length {} >>", content_stream.len());
        self.push_stream_object(
            content_object,
            content_dict.as_bytes(),
            content_stream.as_bytes(),
        )?;
        Ok(())
    }

    pub(crate) fn add_mask_page(&mut self, page: &MaskPdfPage) -> Result<()> {
        validate_page_size(&page.page_size)?;
        self.ensure_jbig2_globals(&page.foreground_mask)?;
        let page_object = self.next_object;
        let mask_object = page_object + 1;
        let content_object = page_object + 2;
        self.next_object += 3;
        self.page_objects.push(page_object);

        let page_index = self.page_objects.len();
        let mask_name = format!("FgMask{page_index}");
        let page_width = page.page_size.width_points;
        let page_height = page.page_size.height_points;
        let page_body = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.4} {:.4}] /Resources << /XObject << /{} {} 0 R >> >> /Contents {} 0 R >>",
            page_width, page_height, mask_name, mask_object, content_object
        );
        self.push_object(page_object, page_body.as_bytes())?;
        self.page_dimensions.push((page_width, page_height));
        self.push_image_mask_object(mask_object, &page.foreground_mask)?;

        let content_stream = format!(
            "1 g\n0 0 {:.4} {:.4} re f\n0 g\nq {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
            page_width, page_height, page_width, page_height, mask_name
        );
        let content_dict = format!("<< /Length {} >>", content_stream.len());
        self.push_stream_object(
            content_object,
            content_dict.as_bytes(),
            content_stream.as_bytes(),
        )?;
        Ok(())
    }

    fn finish(mut self) -> Result<W> {
        let mut kids = String::new();
        for page_object in &self.page_objects {
            let _ = write!(kids, "{page_object} 0 R ");
        }
        let pages_body = format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.trim_end(),
            self.page_objects.len()
        );
        self.push_object(2, pages_body.as_bytes())?;

        if let Some(object_number) = self.outlines_object {
            self.write_outlines(object_number)?;
        }
        if let Some(object_number) = self.page_labels_object {
            self.write_page_labels(object_number)?;
        }

        let info_object = if let Some(stamp) = self.provenance_stamp_hex.take() {
            let object_number = self.next_object;
            self.next_object += 1;
            let info_body = format!("<< /EVBScanCleanup ({stamp}) >>");
            self.push_object(object_number, info_body.as_bytes())?;
            Some(object_number)
        } else {
            None
        };

        let object_count = self.next_object - 1;
        let xref_offset = self.bytes_written;
        writeln!(&mut self, "xref")?;
        writeln!(&mut self, "0 {}", object_count + 1)?;
        writeln!(&mut self, "0000000000 65535 f ")?;
        for object_number in 1..=object_count {
            let offset = self
                .offsets
                .get(object_number)
                .and_then(|offset| *offset)
                .ok_or_else(|| format!("Missing PDF object offset: {object_number}"))?;
            writeln!(&mut self, "{offset:010} 00000 n ")?;
        }
        match info_object {
            Some(info_object) => write!(
                &mut self,
                "trailer\n<< /Size {} /Root 1 0 R /Info {} 0 R >>\nstartxref\n{}\n%%EOF\n",
                object_count + 1,
                info_object,
                xref_offset
            )?,
            None => write!(
                &mut self,
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                object_count + 1,
                xref_offset
            )?,
        }
        self.flush()?;

        Ok(self.inner)
    }

    fn write_outlines(&mut self, root_object: usize) -> Result<()> {
        let total_pages = u32::try_from(self.page_objects.len())
            .map_err(|_| "Too many pages for PDF outline destinations")?;
        let outlines = normalize_bookmark_entries(&self.outlines, total_pages, "Untitled");
        let mut nodes = Vec::new();
        let outline_level =
            allocate_outline_level(&outlines, root_object, &mut self.next_object, &mut nodes)?;

        for node in &nodes {
            let body = self.outline_node_body(node);
            self.push_object(node.object_number, body.as_bytes())?;
        }

        let mut root_body = format!("<< /Type /Outlines /Count {}", outline_level.visible_count);
        if let Some(first) = outline_level.first {
            let _ = write!(root_body, " /First {first} 0 R");
        }
        if let Some(last) = outline_level.last {
            let _ = write!(root_body, " /Last {last} 0 R");
        }
        root_body.push_str(" >>");
        self.push_object(root_object, root_body.as_bytes())
    }

    fn outline_node_body(&self, node: &OutlineNode<'_>) -> String {
        let mut body = format!(
            "<< /Title {} /Parent {} 0 R",
            encode_pdf_text_hex(&node.item.title),
            node.parent,
        );
        if let Some(previous) = node.previous {
            let _ = write!(body, " /Prev {previous} 0 R");
        }
        if let Some(next) = node.next {
            let _ = write!(body, " /Next {next} 0 R");
        }
        if let Some(first_child) = node.first_child {
            let _ = write!(body, " /First {first_child} 0 R");
        }
        if let Some(last_child) = node.last_child {
            let _ = write!(body, " /Last {last_child} 0 R");
        }
        if node.child_visible_count > 0 {
            let _ = write!(body, " /Count {}", node.child_visible_count);
        }

        if let Some(page_index) = node.item.page_index {
            if let (Some(page_object), Some((_, page_height))) = (
                self.page_objects.get(page_index as usize),
                self.page_dimensions.get(page_index as usize),
            ) {
                let top = resolve_bookmark_destination_top(*page_height, node.item.page_y_ratio);
                let _ = write!(body, " /Dest [{page_object} 0 R /XYZ null {top:.4} null]");
            }
        } else if let Some(named_dest) = node.item.named_dest.as_deref() {
            let _ = write!(body, " /Dest {}", encode_pdf_text_hex(named_dest));
        }

        let flags = (if node.item.italic { 1 } else { 0 }) | (if node.item.bold { 2 } else { 0 });
        if flags > 0 {
            let _ = write!(body, " /F {flags}");
        }
        if let Some([red, green, blue]) = normalized_bookmark_color(node.item.color.as_deref()) {
            let _ = write!(body, " /C {red:.4} {green:.4} {blue:.4}");
        }
        body.push_str(" >>");
        body
    }

    fn write_page_labels(&mut self, object_number: usize) -> Result<()> {
        let total_pages = u32::try_from(self.page_objects.len())
            .map_err(|_| "Too many pages for PDF page labels")?;
        let ranges = normalize_page_label_ranges(&self.page_labels, total_pages);
        let mut body = String::from("<< /Nums [");
        for range in ranges {
            let _ = write!(
                body,
                " {} << /Type /PageLabel",
                range.start_page.saturating_sub(1)
            );
            if let Some(style) = range.style.as_deref() {
                let _ = write!(body, " /S /{style}");
            }
            if !range.prefix.is_empty() {
                let _ = write!(body, " /P {}", encode_pdf_text_hex(&range.prefix));
            }
            if range.style.is_some() && range.start_number > 1 {
                let _ = write!(body, " /St {}", range.start_number);
            }
            body.push_str(" >>");
        }
        body.push_str(" ] >>");
        self.push_object(object_number, body.as_bytes())
    }

    fn ensure_jbig2_globals(&mut self, stream: &BilevelStream) -> Result<Option<usize>> {
        let BilevelPayload::Jbig2Symbol { globals, .. } = &stream.payload else {
            return Ok(None);
        };
        if let Some(&object) = self.jbig2_globals_objects.get(globals) {
            return Ok(Some(object));
        }
        let object = self.next_object;
        self.next_object += 1;
        let dictionary = format!("<< /Length {} >>", globals.len());
        self.push_stream_object(object, dictionary.as_bytes(), globals)?;
        self.jbig2_globals_objects
            .insert(Arc::clone(globals), object);
        Ok(Some(object))
    }

    fn jbig2_globals_object(&self, payload: &BilevelPayload) -> Option<usize> {
        let BilevelPayload::Jbig2Symbol { globals, .. } = payload else {
            return None;
        };
        self.jbig2_globals_objects.get(globals).copied()
    }

    fn push_image_object(
        &mut self,
        object_number: usize,
        page: &ImagePage,
        icc_object: Option<usize>,
    ) -> Result<()> {
        let payload = match &page.payload {
            ImagePayload::Bilevel(stream) => {
                let dict = bilevel_image_dictionary(
                    stream.width,
                    stream.height,
                    &stream.payload,
                    self.jbig2_globals_object(&stream.payload),
                );
                return self.push_stream_object(
                    object_number,
                    dict.as_bytes(),
                    stream.payload.data(),
                );
            }
            ImagePayload::RawFlate {
                data,
                decode_params,
            } => ColorImagePayloadRef::RawFlate {
                data,
                decode_params,
            },
            ImagePayload::Jpeg { data } => ColorImagePayloadRef::Jpeg { data },
            ImagePayload::Jpx { data } => ColorImagePayloadRef::Jpx { data },
        };
        self.push_color_image_stream(
            object_number,
            page.width,
            page.height,
            page.color_space,
            icc_object,
            payload,
        )
    }

    fn push_layered_image_object(
        &mut self,
        object_number: usize,
        image: &LayeredPdfImage,
    ) -> Result<()> {
        self.push_color_image_stream(
            object_number,
            image.width,
            image.height,
            image.color_space,
            None,
            ColorImagePayloadRef::from(&image.payload),
        )
    }

    fn push_masked_layered_image_object(
        &mut self,
        object_number: usize,
        mask_object: usize,
        image: &LayeredPdfImage,
    ) -> Result<()> {
        let (filter, decode_params, data) = match &image.payload {
            LayeredImagePayload::RawFlate {
                data,
                decode_params,
            } => (
                "/FlateDecode",
                format!(" /DecodeParms {decode_params}"),
                data,
            ),
            LayeredImagePayload::Jpeg { data } => ("/DCTDecode", String::new(), data),
            LayeredImagePayload::Jpx { data } => ("/JPXDecode", String::new(), data),
        };
        let dict = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} /BitsPerComponent 8 /SMask {} 0 R /Filter {}{} /Length {} >>",
            image.width,
            image.height,
            image.color_space,
            mask_object,
            filter,
            decode_params,
            data.len()
        );
        self.push_stream_object(object_number, dict.as_bytes(), data)
    }

    fn push_color_image_stream(
        &mut self,
        object_number: usize,
        width: u32,
        height: u32,
        color_space: &str,
        icc_object: Option<usize>,
        payload: ColorImagePayloadRef<'_>,
    ) -> Result<()> {
        let color_space_value = icc_object
            .map(|object| format!("[/ICCBased {object} 0 R]"))
            .unwrap_or_else(|| format!("/{color_space}"));
        match payload {
            ColorImagePayloadRef::RawFlate {
                data,
                decode_params,
            } => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {} /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms {} /Length {} >>",
                    width,
                    height,
                    color_space_value,
                    decode_params,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), data)
            }
            ColorImagePayloadRef::Jpeg { data } => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {} /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>",
                    width,
                    height,
                    color_space_value,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), data)
            }
            ColorImagePayloadRef::Jpx { data } => {
                let dict = format!(
                    "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {} /BitsPerComponent 8 /Filter /JPXDecode /Length {} >>",
                    width,
                    height,
                    color_space_value,
                    data.len()
                );
                self.push_stream_object(object_number, dict.as_bytes(), data)
            }
        }
    }

    fn push_image_mask_object(&mut self, object_number: usize, mask: &BilevelStream) -> Result<()> {
        let dict = image_mask_dictionary(
            mask.width,
            mask.height,
            &mask.payload,
            self.jbig2_globals_object(&mask.payload),
        );
        self.push_stream_object(object_number, dict.as_bytes(), mask.payload.data())
    }

    fn push_bilevel_image_object(
        &mut self,
        object_number: usize,
        mask: &BilevelStream,
    ) -> Result<()> {
        let dict = bilevel_soft_mask_dictionary(
            mask.width,
            mask.height,
            &mask.payload,
            self.jbig2_globals_object(&mask.payload),
        );
        self.push_stream_object(object_number, dict.as_bytes(), mask.payload.data())
    }

    fn push_soft_foreground_object(
        &mut self,
        object_number: usize,
        alpha_object: usize,
        alpha: &SoftMaskStream,
        color: [u8; 3],
    ) -> Result<()> {
        let is_gray = color[0] == color[1] && color[1] == color[2];
        let colors = if is_gray { 1usize } else { 3usize };
        let mut pixels = vec![0u8; alpha.width as usize * colors];
        if is_gray {
            pixels.fill(color[0]);
        } else {
            for pixel in pixels.chunks_exact_mut(3) {
                pixel.copy_from_slice(&color);
            }
        }
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        let zero_delta = vec![0u8; pixels.len()];
        for row in 0..alpha.height {
            encoder.write_all(&[2])?;
            encoder.write_all(if row == 0 { &pixels } else { &zero_delta })?;
        }
        let data = encoder.finish()?;
        let color_space = if is_gray { "DeviceGray" } else { "DeviceRGB" };
        let decode_params = format!(
            "<< /Predictor 12 /Colors {colors} /BitsPerComponent 8 /Columns {} >>",
            alpha.width
        );
        let dict = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} /BitsPerComponent 8 /SMask {} 0 R /Filter /FlateDecode /DecodeParms {} /Length {} >>",
            alpha.width,
            alpha.height,
            color_space,
            alpha_object,
            decode_params,
            data.len()
        );
        self.push_stream_object(object_number, dict.as_bytes(), &data)
    }

    fn push_soft_mask_object(
        &mut self,
        object_number: usize,
        alpha: &SoftMaskStream,
    ) -> Result<()> {
        let dict = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms {} /Length {} >>",
            alpha.width,
            alpha.height,
            alpha.decode_params,
            alpha.data.len()
        );
        self.push_stream_object(object_number, dict.as_bytes(), &alpha.data)
    }

    fn push_object(&mut self, object_number: usize, body: &[u8]) -> Result<()> {
        self.record_object_offset(object_number);
        writeln!(self, "{object_number} 0 obj")?;
        self.write_all(body)?;
        self.write_all(b"\nendobj\n")?;
        Ok(())
    }

    fn push_stream_object(
        &mut self,
        object_number: usize,
        dict: &[u8],
        stream: &[u8],
    ) -> Result<()> {
        self.record_object_offset(object_number);
        writeln!(self, "{object_number} 0 obj")?;
        self.write_all(dict)?;
        self.write_all(b"\nstream\n")?;
        self.write_all(stream)?;
        self.write_all(b"\nendstream\nendobj\n")?;
        Ok(())
    }

    fn record_object_offset(&mut self, object_number: usize) {
        if self.offsets.len() <= object_number {
            self.offsets.resize(object_number + 1, None);
        }
        self.offsets[object_number] = Some(self.bytes_written);
    }
}

struct OutlineNode<'a> {
    object_number: usize,
    parent: usize,
    previous: Option<usize>,
    next: Option<usize>,
    first_child: Option<usize>,
    last_child: Option<usize>,
    child_visible_count: usize,
    item: &'a BookmarkEntry,
}

struct OutlineLevel {
    first: Option<usize>,
    last: Option<usize>,
    visible_count: usize,
}

fn allocate_outline_level<'a>(
    items: &'a [BookmarkEntry],
    parent: usize,
    next_object: &mut usize,
    nodes: &mut Vec<OutlineNode<'a>>,
) -> Result<OutlineLevel> {
    if items.is_empty() {
        return Ok(OutlineLevel {
            first: None,
            last: None,
            visible_count: 0,
        });
    }

    let mut node_indices: Vec<usize> = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let object_number = *next_object;
        *next_object = (*next_object)
            .checked_add(1)
            .ok_or("Too many PDF outline objects")?;
        let previous = index
            .checked_sub(1)
            .and_then(|previous_index| node_indices.get(previous_index))
            .map(|&previous_index| nodes[previous_index].object_number);
        node_indices.push(nodes.len());
        nodes.push(OutlineNode {
            object_number,
            parent,
            previous,
            next: None,
            first_child: None,
            last_child: None,
            child_visible_count: 0,
            item,
        });
        if previous.is_some() {
            nodes
                .get_mut(node_indices[index - 1])
                .expect("outline sibling was just allocated")
                .next = Some(object_number);
        }
    }

    let mut visible_count = 0usize;
    for (index, item) in items.iter().enumerate() {
        let node_index = node_indices[index];
        let child_level = allocate_outline_level(
            &item.items,
            nodes[node_index].object_number,
            next_object,
            nodes,
        )?;
        let node = nodes
            .get_mut(node_index)
            .expect("outline node was just allocated");
        node.first_child = child_level.first;
        node.last_child = child_level.last;
        node.child_visible_count = child_level.visible_count;
        visible_count = visible_count
            .checked_add(1)
            .and_then(|count| count.checked_add(child_level.visible_count))
            .ok_or("Too many PDF outline entries")?;
    }

    Ok(OutlineLevel {
        first: node_indices
            .first()
            .map(|&node_index| nodes[node_index].object_number),
        last: node_indices
            .last()
            .map(|&node_index| nodes[node_index].object_number),
        visible_count,
    })
}

fn validate_catalog_inputs(
    outlines: &[BookmarkEntry],
    page_labels: &[PageLabelRange],
) -> Result<()> {
    if page_labels.len() > MAX_PAGE_LABEL_RANGES {
        return Err(format!("Too many page-label ranges (maximum {MAX_PAGE_LABEL_RANGES})").into());
    }

    let mut bookmark_count = 0usize;
    validate_bookmark_entries(outlines, 0, &mut bookmark_count)
}

fn validate_bookmark_entries(
    items: &[BookmarkEntry],
    depth: usize,
    count: &mut usize,
) -> Result<()> {
    if depth > MAX_BOOKMARK_DEPTH {
        return Err("Bookmark tree is too deeply nested".into());
    }
    for item in items {
        if item.title.len() > 4_096 {
            return Err("Bookmark title exceeds the 4096-byte admission ceiling".into());
        }
        *count = count.checked_add(1).ok_or("Too many bookmark items")?;
        if *count > MAX_BOOKMARK_ITEMS {
            return Err(format!("Too many bookmark items (maximum {MAX_BOOKMARK_ITEMS})").into());
        }
        validate_bookmark_entries(&item.items, depth + 1, count)?;
    }
    Ok(())
}

fn encode_pdf_text_hex(text: &str) -> String {
    let mut encoded = String::with_capacity(4 + text.len() * 4);
    encoded.push_str("<FEFF");
    for code_unit in text.encode_utf16() {
        let _ = write!(encoded, "{code_unit:04X}");
    }
    encoded.push('>');
    encoded
}

fn normalized_bookmark_color(color: Option<&str>) -> Option<[f64; 3]> {
    let color = color?.strip_prefix('#')?;
    if color.len() != 6 {
        return None;
    }
    let red = u8::from_str_radix(&color[0..2], 16).ok()?;
    let green = u8::from_str_radix(&color[2..4], 16).ok()?;
    let blue = u8::from_str_radix(&color[4..6], 16).ok()?;
    Some([
        f64::from(red) / 255.0,
        f64::from(green) / 255.0,
        f64::from(blue) / 255.0,
    ])
}

fn validate_provenance_stamp_hex(stamp: &str) -> Result<()> {
    if stamp.is_empty()
        || !stamp.len().is_multiple_of(2)
        || stamp
            .bytes()
            .any(|byte| !matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("provenanceStampHex must be a non-empty lowercase hexadecimal string".into());
    }
    Ok(())
}

fn validate_rotation_degrees(rotation_degrees: u16) -> Result<()> {
    if matches!(rotation_degrees, 0 | 90 | 180 | 270) {
        Ok(())
    } else {
        Err("Image rotation must be 0, 90, 180, or 270 degrees".into())
    }
}

impl<W: IoWrite> IoWrite for PdfWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.bytes_written += written;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn points(pixels: u32, dpi: u32) -> f64 {
    pixels as f64 / dpi.max(1) as f64 * 72.0
}

fn validate_page_size(size: &PdfPageSize) -> Result<()> {
    if !size.width_points.is_finite()
        || !size.height_points.is_finite()
        || size.width_points <= 0.0
        || size.height_points <= 0.0
    {
        return Err("Layered PDF page size must be finite positive points".into());
    }
    Ok(())
}

fn validate_image_placement(placement: &PdfImagePlacement, page_size: &PdfPageSize) -> Result<()> {
    let values = [
        placement.x_points,
        placement.y_points,
        placement.width_points,
        placement.height_points,
    ];
    if !values.into_iter().all(f64::is_finite)
        || placement.x_points < 0.0
        || placement.y_points < 0.0
        || placement.width_points <= 0.0
        || placement.height_points <= 0.0
        || placement.x_points + placement.width_points > page_size.width_points + 0.0001
        || placement.y_points + placement.height_points > page_size.height_points + 0.0001
    {
        return Err("Invalid image placement rectangle".into());
    }
    Ok(())
}

fn validate_image_mask(mask: &PbmP4Image) -> Result<()> {
    if mask.width == 0 || mask.height == 0 {
        return Err("Layered PDF image mask dimensions must be positive".into());
    }
    let expected_stride = (mask.width as usize)
        .checked_add(7)
        .ok_or("Invalid layered PDF image mask row stride")?
        / 8;
    if mask.row_stride != expected_stride {
        return Err(format!(
            "Invalid layered PDF image mask row stride: expected {expected_stride}, got {}",
            mask.row_stride
        )
        .into());
    }
    let expected_len = expected_stride
        .checked_mul(mask.height as usize)
        .ok_or("Invalid layered PDF image mask payload size")?;
    if mask.bitmap.len() != expected_len {
        return Err(format!(
            "Invalid layered PDF image mask payload size: expected {expected_len}, got {}",
            mask.bitmap.len()
        )
        .into());
    }
    Ok(())
}

fn deflate_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(data)?;
    Ok(encoder.finish()?)
}

#[derive(Debug, Eq, PartialEq)]
enum BilevelPayload {
    /// A JBIG2 stream copied from an existing PDF image. Its PDF sample
    /// polarity is already authored for that image dictionary.
    PdfJbig2 {
        data: Vec<u8>,
        decode: PdfBilevelDecode,
    },
    /// A JBIG2 stream encoded from PBM black/selected pixels by this crate.
    Jbig2(Vec<u8>),
    /// A verified symbol-coded page and its shared PDF `/JBIG2Globals`
    /// dictionary. Every page in a bounded chunk shares the same `Arc`.
    Jbig2Symbol {
        data: Vec<u8>,
        globals: Arc<Vec<u8>>,
    },
    CcittG4(Vec<u8>),
    Flate(Vec<u8>),
}

impl BilevelPayload {
    fn data(&self) -> &[u8] {
        match self {
            Self::PdfJbig2 { data, .. }
            | Self::Jbig2(data)
            | Self::Jbig2Symbol { data, .. }
            | Self::CcittG4(data)
            | Self::Flate(data) => data,
        }
    }
}

fn encode_mask_payload(mask: &PbmP4Image) -> Result<BilevelPayload> {
    let width = mask.width;
    let height = mask.height;
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    let jbig2_started_at = std::time::Instant::now();
    let jbig2 = jbig2_codec::encode_pdf_generic_verified(Bilevel {
        width,
        height,
        rows: &mask.bitmap,
    });
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    if std::env::var_os("EVB_PDF_COMBINE_TIMING").is_some() {
        eprintln!(
            "{{\"type\":\"jbig2-encode-timing\",\"width\":{width},\"height\":{height},\"elapsedMs\":{:.3}}}",
            jbig2_started_at.elapsed().as_secs_f64() * 1_000.0
        );
    }

    // Strict comparisons give equal-length candidates a stable priority:
    // Flate, then Group 4, then JBIG2.
    let fallback = encode_fallback_bilevel_payload(mask)?;
    match jbig2 {
        Ok(data) if data.len() < fallback.data().len() => Ok(BilevelPayload::Jbig2(data)),
        Ok(_) => Ok(fallback),
        Err(error) => {
            // Keep the verified source stencil and select the smallest remaining
            // lossless payload; a JBIG2 failure is not a reason to discard valid
            // MRC layers.
            eprintln!(
                "warning: verified JBIG2 encoding failed for {width}x{height} bilevel image; falling back: {error}"
            );
            Ok(fallback)
        }
    }
}

fn encode_fallback_bilevel_payload(mask: &PbmP4Image) -> Result<BilevelPayload> {
    let flate = deflate_bytes(&mask.bitmap)?;
    let ccitt = match encode_mask_ccitt_g4(mask) {
        Ok(data) => data,
        Err(error) => {
            eprintln!(
                "warning: CCITT Group 4 encoding failed for {}x{} bilevel image; falling back: {error}",
                mask.width, mask.height
            );
            None
        }
    };
    Ok(match ccitt {
        Some(ccitt) if ccitt.len() < flate.len() => BilevelPayload::CcittG4(ccitt),
        _ => BilevelPayload::Flate(flate),
    })
}

fn bilevel_image_dictionary(
    width: u32,
    height: u32,
    payload: &BilevelPayload,
    globals_object: Option<usize>,
) -> String {
    let filter = match payload {
        BilevelPayload::PdfJbig2 { .. } | BilevelPayload::Jbig2(_) => {
            "/Filter /JBIG2Decode".to_string()
        }
        BilevelPayload::Jbig2Symbol { .. } => format!(
            "/Filter /JBIG2Decode /DecodeParms << /JBIG2Globals {} 0 R >>",
            globals_object.expect("registered symbol dictionary")
        ),
        BilevelPayload::CcittG4(_) => format!(
            "/Decode [1 0] /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {width} /Rows {height} /BlackIs1 true >>"
        ),
        BilevelPayload::Flate(_) => "/Decode [1 0] /Filter /FlateDecode".to_string(),
    };
    format!(
        "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 1 {filter} /Length {} >>",
        payload.data().len()
    )
}

/// A PDF soft mask is opacity data, not a paint stencil. All three encoders
/// represent PBM black/selected pixels identically, but PDF's JBIG2 decoder
/// exposes that value with the opposite sample polarity to raw Flate and the
/// configured CCITT stream. Invert exactly the JBIG2 samples encoded from PBM
/// so every generated payload maps selected foreground to opacity one. A raw
/// soft mask copied from a PDF already has PDF sample polarity and must retain
/// the source dictionary's default decode mapping.
fn bilevel_soft_mask_dictionary(
    width: u32,
    height: u32,
    payload: &BilevelPayload,
    globals_object: Option<usize>,
) -> String {
    let filter = match payload {
        BilevelPayload::PdfJbig2 {
            decode: PdfBilevelDecode::Default,
            ..
        } => "/Filter /JBIG2Decode".to_string(),
        BilevelPayload::PdfJbig2 {
            decode: PdfBilevelDecode::Inverted,
            ..
        } => "/Decode [1 0] /Filter /JBIG2Decode".to_string(),
        BilevelPayload::Jbig2(_) => "/Decode [1 0] /Filter /JBIG2Decode".to_string(),
        BilevelPayload::Jbig2Symbol { .. } => format!(
            "/Decode [1 0] /Filter /JBIG2Decode /DecodeParms << /JBIG2Globals {} 0 R >>",
            globals_object.expect("registered symbol dictionary")
        ),
        BilevelPayload::CcittG4(_) => format!(
            "/Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {width} /Rows {height} /BlackIs1 true >>"
        ),
        BilevelPayload::Flate(_) => "/Filter /FlateDecode".to_string(),
    };
    format!(
        "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 1 {filter} /Length {} >>",
        payload.data().len()
    )
}

fn image_mask_dictionary(
    width: u32,
    height: u32,
    payload: &BilevelPayload,
    globals_object: Option<usize>,
) -> String {
    let filter = match payload {
        BilevelPayload::PdfJbig2 { .. } | BilevelPayload::Jbig2(_) => {
            "/Filter /JBIG2Decode".to_string()
        }
        BilevelPayload::Jbig2Symbol { .. } => format!(
            "/Filter /JBIG2Decode /DecodeParms << /JBIG2Globals {} 0 R >>",
            globals_object.expect("registered symbol dictionary")
        ),
        BilevelPayload::CcittG4(_) => format!(
            "/Decode [1 0] /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {width} /Rows {height} /BlackIs1 true >>"
        ),
        BilevelPayload::Flate(_) => "/Decode [1 0] /Filter /FlateDecode".to_string(),
    };
    format!(
        "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ImageMask true /BitsPerComponent 1 {filter} /Length {} >>",
        payload.data().len()
    )
}

fn encode_mask_ccitt_g4(mask: &PbmP4Image) -> Result<Option<Vec<u8>>> {
    let Ok(width) = u16::try_from(mask.width) else {
        return Ok(None);
    };
    let writer = VecWriter::with_capacity(mask.bitmap.len() * 8);
    let mut encoder = FaxEncoder::new(writer);
    for row in mask
        .bitmap
        .chunks(mask.row_stride)
        .take(mask.height as usize)
    {
        let colors = slice_bits(row).take(mask.width as usize).map(|bit| {
            if bit {
                Color::Black
            } else {
                Color::White
            }
        });
        encoder
            .encode_line(colors, width)
            .map_err(|_| "Failed to encode CCITT Group 4 mask line")?;
    }
    let writer = encoder
        .finish()
        .map_err(|_| "Failed to finish CCITT Group 4 mask")?;
    Ok(Some(writer.finish()))
}

enum ColorImagePayloadRef<'a> {
    RawFlate {
        data: &'a [u8],
        decode_params: &'a str,
    },
    Jpeg {
        data: &'a [u8],
    },
    Jpx {
        data: &'a [u8],
    },
}

impl<'a> From<&'a LayeredImagePayload> for ColorImagePayloadRef<'a> {
    fn from(payload: &'a LayeredImagePayload) -> Self {
        match payload {
            LayeredImagePayload::RawFlate {
                data,
                decode_params,
            } => Self::RawFlate {
                data,
                decode_params,
            },
            LayeredImagePayload::Jpeg { data } => Self::Jpeg { data },
            LayeredImagePayload::Jpx { data } => Self::Jpx { data },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_points_from_dpi() {
        assert_eq!(points(300, 300), 72.0);
        assert_eq!(points(144, 72), 144.0);
    }

    #[test]
    fn image_placement_changes_only_the_xobject_matrix_inside_the_media_box() {
        let page = ImagePage {
            width: 2,
            height: 2,
            dpi: 72,
            color_space: "DeviceGray",
            icc_profile: None,
            payload: ImagePayload::RawFlate {
                data: vec![0],
                decode_params: String::new(),
            },
        };
        let page_size = PdfPageSize {
            width_points: 100.0,
            height_points: 200.0,
        };
        let mut legacy = PdfWriter::new(Vec::new(), None).unwrap();
        legacy.add_page_with_size(&page, &page_size, None).unwrap();
        let legacy = String::from_utf8_lossy(&legacy.finish().unwrap()).into_owned();
        assert!(legacy.contains("/MediaBox [0 0 100.0000 200.0000]"));
        assert!(legacy.contains("q 100.0000 0 0 200.0000 0 0 cm /Im1 Do Q"));

        let mut placed = PdfWriter::new(Vec::new(), None).unwrap();
        placed
            .add_page_with_size(
                &page,
                &page_size,
                Some(&PdfImagePlacement {
                    x_points: 5.0,
                    y_points: 7.0,
                    width_points: 80.0,
                    height_points: 170.0,
                }),
            )
            .unwrap();
        let placed = String::from_utf8_lossy(&placed.finish().unwrap()).into_owned();
        assert!(placed.contains("/MediaBox [0 0 100.0000 200.0000]"));
        assert!(placed.contains("q 80.0000 0 0 170.0000 5.0000 7.0000 cm /Im1 Do Q"));
    }

    #[test]
    fn image_rotation_emits_rotate_without_swapping_the_media_box() {
        let page = ImagePage {
            width: 2,
            height: 2,
            dpi: 72,
            color_space: "DeviceGray",
            icc_profile: None,
            payload: ImagePayload::RawFlate {
                data: vec![0],
                decode_params: String::new(),
            },
        };
        let page_size = PdfPageSize {
            width_points: 100.0,
            height_points: 200.0,
        };

        for rotation in [90, 270] {
            let mut writer = PdfWriter::new(Vec::new(), None).unwrap();
            writer
                .add_page_with_size_and_rotation(&page, &page_size, None, rotation)
                .unwrap();
            let pdf = String::from_utf8_lossy(&writer.finish().unwrap()).into_owned();
            assert!(pdf.contains(&format!(
                "/MediaBox [0 0 100.0000 200.0000] /Rotate {rotation}"
            )));
            assert!(pdf.contains("q 100.0000 0 0 200.0000 0 0 cm /Im1 Do Q"));
        }

        let mut unrotated = PdfWriter::new(Vec::new(), None).unwrap();
        unrotated
            .add_page_with_size_and_rotation(&page, &page_size, None, 0)
            .unwrap();
        let unrotated = String::from_utf8_lossy(&unrotated.finish().unwrap()).into_owned();
        assert!(unrotated.contains("/MediaBox [0 0 100.0000 200.0000]"));
        assert!(!unrotated.contains("/Rotate"));

        let mut invalid = PdfWriter::new(Vec::new(), None).unwrap();
        assert!(invalid
            .add_page_with_size_and_rotation(&page, &page_size, None, 45)
            .is_err());
    }

    #[test]
    fn catalog_writer_emits_outlines_and_page_labels() {
        let page = ImagePage {
            width: 2,
            height: 2,
            dpi: 72,
            color_space: "DeviceGray",
            icc_profile: None,
            payload: ImagePayload::RawFlate {
                data: vec![0],
                decode_params: String::new(),
            },
        };
        let outlines = [BookmarkEntry {
            title: " Chapter 1 ".to_string(),
            page_index: Some(0),
            page_y_ratio: Some(0.25),
            named_dest: None,
            bold: true,
            italic: false,
            color: Some("#336699".to_string()),
            items: vec![BookmarkEntry {
                title: "Section".to_string(),
                page_index: Some(0),
                page_y_ratio: None,
                named_dest: None,
                bold: false,
                italic: true,
                color: None,
                items: Vec::new(),
            }],
        }];
        let labels = [PageLabelRange {
            start_page: 1,
            style: Some("r".to_string()),
            prefix: "Part ".to_string(),
            start_number: 4,
        }];
        let page_size = PdfPageSize {
            width_points: 72.0,
            height_points: 36.0,
        };
        let mut writer = PdfWriter::new_with_catalog(Vec::new(), None, &outlines, &labels).unwrap();
        writer.add_page_with_size(&page, &page_size, None).unwrap();
        let pdf = String::from_utf8_lossy(&writer.finish().unwrap()).into_owned();

        assert!(pdf.contains("/Outlines 3 0 R /PageMode /UseOutlines"));
        assert!(pdf.contains("/PageLabels 4 0 R"));
        assert!(pdf.contains("/Type /Outlines /Count 2"));
        assert!(pdf.contains("/Title <FEFF004300680061007000740065007200200031>"));
        assert!(pdf.contains("/Dest [5 0 R /XYZ null 27.0000 null]"));
        assert!(pdf.contains("/S /r /P <FEFF00500061007200740020> /St 4"));
        assert!(pdf.contains("/F 2 /C 0.2000 0.4000 0.6000"));
    }

    #[test]
    fn empty_catalog_preserves_the_legacy_writer_bytes() {
        let page = ImagePage {
            width: 2,
            height: 2,
            dpi: 72,
            color_space: "DeviceGray",
            icc_profile: None,
            payload: ImagePayload::RawFlate {
                data: vec![0],
                decode_params: String::new(),
            },
        };
        let mut legacy = PdfWriter::new(Vec::new(), None).unwrap();
        legacy.add_page(&page).unwrap();
        let legacy = legacy.finish().unwrap();

        let mut current = PdfWriter::new_with_catalog(Vec::new(), None, &[], &[]).unwrap();
        current.add_page(&page).unwrap();
        let current = current.finish().unwrap();

        assert_eq!(current, legacy);
        assert!(!String::from_utf8_lossy(&current).contains("/Outlines"));
        assert!(!String::from_utf8_lossy(&current).contains("/PageLabels"));
    }

    #[test]
    fn soft_layered_page_uses_an_eight_bit_smask_instead_of_a_binary_image_mask() {
        let background_pixels = vec![255u8; 8];
        let page = SoftLayeredPdfPage {
            page_size: PdfPageSize {
                width_points: 4.0,
                height_points: 2.0,
            },
            background: LayeredPdfImage {
                width: 4,
                height: 2,
                color_space: "DeviceGray",
                payload: LayeredImagePayload::RawFlate {
                    data: deflate_up_filtered_slices(&background_pixels, 4, 2).unwrap(),
                    decode_params: "<< /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 4 >>"
                        .to_string(),
                },
            },
            foreground_alpha: SoftMaskStream::encode(4, 2, &[0, 64, 128, 255, 255, 128, 64, 0])
                .unwrap(),
            foreground_color: None,
        };

        let pdf = build_soft_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/SMask "));
        assert!(text.contains("/Width 4 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8"));
        assert!(!text.contains("/ImageMask true"));
    }

    #[test]
    fn affine_masked_page_preserves_foreground_stream_and_uses_noninverted_opacity_mask() {
        let foreground_mask = sample_mask();
        let expected_mask_filter = match &foreground_mask.payload {
            BilevelPayload::CcittG4(_) => "/Filter /CCITTFaxDecode",
            BilevelPayload::Flate(_) => "/Filter /FlateDecode",
            payload => panic!("the tiny fixture must select a fallback payload, got {payload:?}"),
        };
        let page = AffineMaskedLayeredPdfPage {
            page_size: PdfPageSize {
                width_points: 144.0,
                height_points: 72.0,
            },
            background: LayeredPdfImage {
                width: 4,
                height: 2,
                color_space: "DeviceGray",
                payload: LayeredImagePayload::RawFlate {
                    data: deflate_up_filtered_slices(&[255; 8], 4, 2).unwrap(),
                    decode_params: "<< /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 4 >>"
                        .to_string(),
                },
            },
            foreground: LayeredPdfImage {
                width: 8,
                height: 2,
                color_space: "DeviceRGB",
                payload: LayeredImagePayload::Jpx {
                    data: vec![0, 1, 2, 3],
                },
            },
            foreground_mask,
            foreground_matrix: [120.0, 0.0, 0.0, 60.0, 12.0, 6.0],
        };

        let pdf = build_affine_masked_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/FgMrc1"));
        assert!(text.contains("/Filter /JPXDecode"));
        assert!(text.contains("/SMask "));
        assert!(!text.contains("/ImageMask true"));
        assert!(text.contains(expected_mask_filter));
        assert!(!text.contains("/Decode [1 0]"));
        assert!(text.contains(
            "120.00000000 0.00000000 0.00000000 60.00000000 12.00000000 6.00000000 cm /FgMrc1 Do"
        ));
    }

    #[test]
    fn bundled_poppler_composites_binary_smask_with_selected_foreground_polarity() {
        use std::{
            fs,
            path::PathBuf,
            process::Command,
            time::{SystemTime, UNIX_EPOCH},
        };

        let tag = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "darwin-arm64",
            ("linux", "x86_64") => "linux-x64",
            ("windows", "x86_64") => "win32-x64",
            _ => return,
        };
        let executable = if std::env::consts::OS == "windows" {
            "pdftoppm.exe"
        } else {
            "pdftoppm"
        };
        let pdftoppm = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../resources/poppler")
            .join(tag)
            .join("bin")
            .join(executable);
        if !pdftoppm.is_file() {
            eprintln!("bundled pdftoppm is unavailable for this host");
            return;
        }

        const WIDTH: u32 = 8;
        const HEIGHT: u32 = 8;
        let foreground_pixels = [255, 0, 0].repeat((WIDTH * HEIGHT) as usize);
        let page = AffineMaskedLayeredPdfPage {
            page_size: PdfPageSize {
                width_points: f64::from(WIDTH),
                height_points: f64::from(HEIGHT),
            },
            background: LayeredPdfImage {
                width: WIDTH,
                height: HEIGHT,
                color_space: "DeviceRGB",
                payload: LayeredImagePayload::RawFlate {
                    data: deflate_up_filtered_slices(
                        &[255; (WIDTH * HEIGHT * 3) as usize],
                        WIDTH as usize * 3,
                        HEIGHT as usize,
                    )
                    .unwrap(),
                    decode_params: format!(
                        "<< /Predictor 12 /Colors 3 /BitsPerComponent 8 /Columns {WIDTH} >>"
                    ),
                },
            },
            foreground: LayeredPdfImage {
                width: WIDTH,
                height: HEIGHT,
                color_space: "DeviceRGB",
                payload: LayeredImagePayload::RawFlate {
                    data: deflate_up_filtered_slices(
                        &foreground_pixels,
                        WIDTH as usize * 3,
                        HEIGHT as usize,
                    )
                    .unwrap(),
                    decode_params: format!(
                        "<< /Predictor 12 /Colors 3 /BitsPerComponent 8 /Columns {WIDTH} >>"
                    ),
                },
            },
            foreground_mask: BilevelStream::encode(&PbmP4Image {
                width: WIDTH,
                height: HEIGHT,
                row_stride: 1,
                bitmap: vec![
                    0,
                    0,
                    0b0011_1100,
                    0b0011_1100,
                    0b0011_1100,
                    0b0011_1100,
                    0,
                    0,
                ],
            })
            .unwrap(),
            foreground_matrix: [f64::from(WIDTH), 0.0, 0.0, f64::from(HEIGHT), 0.0, 0.0],
        };

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "evb-binary-smask-render-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let pdf_path = directory.join("binary-smask.pdf");
        let output_prefix = directory.join("binary-smask");
        fs::write(
            &pdf_path,
            build_affine_masked_layered_pdf_page(&page).unwrap(),
        )
        .unwrap();
        let output = Command::new(pdftoppm)
            .args(["-r", "72", "-singlefile"])
            .arg(&pdf_path)
            .arg(&output_prefix)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );

        let ppm = fs::read(output_prefix.with_extension("ppm")).unwrap();
        let raster =
            crate::netpbm::parse_netpbm(&ppm, u64::from(WIDTH) * u64::from(HEIGHT)).unwrap();
        let red_pixels = raster
            .pixels
            .chunks_exact(3)
            .filter(|pixel| pixel[0] >= 245 && pixel[1] <= 10 && pixel[2] <= 10)
            .count();
        assert!(
            (8..=16).contains(&red_pixels),
            "only the selected 4x4 mask block may expose foreground; got {red_pixels} red pixels"
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn bundled_poppler_composites_soft_alpha_with_the_expected_polarity() {
        use std::{
            fs,
            path::PathBuf,
            process::Command,
            time::{SystemTime, UNIX_EPOCH},
        };

        let tag = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "darwin-arm64",
            ("linux", "x86_64") => "linux-x64",
            ("windows", "x86_64") => "win32-x64",
            _ => return,
        };
        let executable = if std::env::consts::OS == "windows" {
            "pdftoppm.exe"
        } else {
            "pdftoppm"
        };
        let pdftoppm = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../resources/poppler")
            .join(tag)
            .join("bin")
            .join(executable);
        if !pdftoppm.is_file() {
            eprintln!("bundled pdftoppm is unavailable for this host");
            return;
        }

        const WIDTH: u32 = 40;
        const HEIGHT: u32 = 10;
        let background_pixels = vec![255u8; (WIDTH * HEIGHT) as usize];
        let mut alpha = Vec::with_capacity((WIDTH * HEIGHT) as usize);
        for _ in 0..HEIGHT {
            alpha.extend(std::iter::repeat_n(0, 10));
            alpha.extend(std::iter::repeat_n(64, 10));
            alpha.extend(std::iter::repeat_n(128, 10));
            alpha.extend(std::iter::repeat_n(255, 10));
        }
        let page = SoftLayeredPdfPage {
            page_size: PdfPageSize {
                width_points: f64::from(WIDTH),
                height_points: f64::from(HEIGHT),
            },
            background: LayeredPdfImage {
                width: WIDTH,
                height: HEIGHT,
                color_space: "DeviceGray",
                payload: LayeredImagePayload::RawFlate {
                    data: deflate_up_filtered_slices(
                        &background_pixels,
                        WIDTH as usize,
                        HEIGHT as usize,
                    )
                    .unwrap(),
                    decode_params: format!(
                        "<< /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns {WIDTH} >>"
                    ),
                },
            },
            foreground_alpha: SoftMaskStream::encode(WIDTH, HEIGHT, &alpha).unwrap(),
            foreground_color: None,
        };

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "evb-soft-mask-render-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let pdf_path = directory.join("soft-alpha.pdf");
        let output_prefix = directory.join("soft-alpha");
        fs::write(&pdf_path, build_soft_layered_pdf_page(&page).unwrap()).unwrap();
        let output = Command::new(pdftoppm)
            .args(["-r", "72", "-gray", "-singlefile"])
            .arg(&pdf_path)
            .arg(&output_prefix)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );

        let pgm = fs::read(output_prefix.with_extension("pgm")).unwrap();
        let raster =
            crate::netpbm::parse_netpbm(&pgm, u64::from(WIDTH) * u64::from(HEIGHT)).unwrap();
        assert_eq!((raster.width, raster.height), (WIDTH, HEIGHT));
        assert_eq!(raster.channels, 1);
        let row = (HEIGHT / 2 * WIDTH) as usize;
        let samples = [
            raster.pixels[row + 5],
            raster.pixels[row + 15],
            raster.pixels[row + 25],
            raster.pixels[row + 35],
        ];
        assert!(
            samples[0] >= 250,
            "transparent foreground must leave white: {samples:?}"
        );
        assert!(
            (185..=195).contains(&samples[1]),
            "25% black must composite near 191: {samples:?}"
        );
        assert!(
            (122..=132).contains(&samples[2]),
            "50% black must composite near 127: {samples:?}"
        );
        assert!(
            samples[3] <= 5,
            "opaque foreground must render black: {samples:?}"
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn writes_xref_offsets_by_object_number() {
        let page = ImagePage {
            width: 1,
            height: 1,
            dpi: 72,
            color_space: "DeviceGray",
            icc_profile: None,
            payload: ImagePayload::RawFlate {
                data: vec![0],
                decode_params: "<< /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 1 >>"
                    .to_string(),
            },
        };

        let pdf = build_pdf(&[page]).unwrap();
        let xref_offset = find_bytes(&pdf, b"xref\n").unwrap();
        let xref = std::str::from_utf8(&pdf[xref_offset..]).unwrap();
        let mut lines = xref.lines();
        assert_eq!(lines.next(), Some("xref"));
        assert_eq!(lines.next(), Some("0 6"));
        assert_eq!(lines.next(), Some("0000000000 65535 f "));

        for object_number in 1..=5 {
            let line = lines.next().unwrap();
            let offset = line[0..10].parse::<usize>().unwrap();
            let expected_prefix = format!("{object_number} 0 obj");
            assert!(pdf[offset..].starts_with(expected_prefix.as_bytes()));
        }
    }

    #[test]
    fn writes_layered_page_with_background_and_mask_xobjects() {
        let page = sample_layered_page(LayeredImagePayload::RawFlate {
            data: vec![0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1],
            decode_params: "<< /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns 4 >>"
                .to_string(),
        });

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/MediaBox [0 0 144.0000 72.0000]"));
        assert!(text.contains("/Bg1"));
        assert!(text.contains("/FgMask1"));
        assert!(text.contains("/ImageMask true"));
        assert!(text.contains("/BitsPerComponent 1"));
        assert!(!mask_object_dictionary(&text).contains("/ColorSpace"));
    }

    #[test]
    fn writes_mask_only_page_on_explicit_white_canvas() {
        let page = MaskPdfPage {
            page_size: PdfPageSize {
                width_points: 144.0,
                height_points: 72.0,
            },
            foreground_mask: sample_mask(),
        };

        let pdf = build_mask_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/MediaBox [0 0 144.0000 72.0000]"));
        assert!(text.contains("/FgMask1"));
        assert!(!text.contains("/Bg1"));
        assert!(text.contains("/ImageMask true"));
        assert!(!text.contains("/DCTDecode"));
        assert!(!mask_object_dictionary(&text).contains("/ColorSpace"));
        assert!(text.contains("1 g\n0 0 144.0000 72.0000 re f\n0 g\n"));
    }

    #[test]
    fn writes_layered_page_with_jpeg_background() {
        let page = sample_layered_page(LayeredImagePayload::Jpeg {
            data: vec![0xff, 0xd8, 0xff, 0xd9],
        });

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Filter /DCTDecode"));
        assert!(text.contains("/ImageMask true"));
    }

    #[test]
    fn layered_jpeg_uses_jbig2_when_it_is_the_smallest_verified_mask_payload() {
        let foreground_mask = BilevelStream::encode(
            &crate::netpbm::parse_pbm_p4(
                include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-000-body.pbm"),
                u64::MAX,
            )
            .unwrap(),
        )
        .unwrap();
        let page = LayeredPdfPage {
            page_size: PdfPageSize {
                width_points: 612.0,
                height_points: 792.0,
            },
            background: LayeredPdfImage {
                width: 1,
                height: 1,
                color_space: "DeviceGray",
                payload: LayeredImagePayload::Jpeg {
                    data: vec![0xff, 0xd8, 0xff, 0xd9],
                },
            },
            foreground_mask,
            foreground_color: None,
        };

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Filter /DCTDecode"));
        assert!(mask_object_dictionary(&text).contains("/Filter /JBIG2Decode"));
    }

    #[test]
    fn writes_layered_color_page_with_rgb_fill_and_image_mask() {
        let mut page = sample_layered_page(LayeredImagePayload::Jpeg {
            data: vec![0xff, 0xd8, 0xff, 0xd9],
        });
        page.foreground_color = Some([128, 16, 16]);

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Bg1"));
        assert!(text.contains("/FgMask1"));
        assert!(!text.contains("/Fg1"));
        assert!(!text.contains("/Mask "));
        assert_eq!(text.matches("/ImageMask true").count(), 1);
        assert_eq!(text.matches("/Filter /DCTDecode").count(), 1);
        assert!(text.contains(
            "q 144.0000 0 0 72.0000 0 0 cm /Bg1 Do Q\n0.5020 0.0627 0.0627 rg\nq 144.0000 0 0 72.0000 0 0 cm /FgMask1 Do Q\n"
        ));
    }

    #[test]
    fn maps_different_background_and_mask_dimensions_to_same_page_rect() {
        let page = LayeredPdfPage {
            page_size: PdfPageSize {
                width_points: 612.0,
                height_points: 792.0,
            },
            background: LayeredPdfImage {
                width: 1200,
                height: 1600,
                color_space: "DeviceRGB",
                payload: LayeredImagePayload::Jpeg {
                    data: vec![0xff, 0xd8, 0xff, 0xd9],
                },
            },
            foreground_mask: BilevelStream::encode(&PbmP4Image {
                width: 2550,
                height: 3300,
                row_stride: 319,
                bitmap: vec![0; 319 * 3300],
            })
            .unwrap(),
            foreground_color: None,
        };

        let pdf = build_layered_pdf_page(&page).unwrap();
        let text = String::from_utf8_lossy(&pdf);

        assert!(text.contains("/Width 1200 /Height 1600"));
        assert!(text.contains("/Width 2550 /Height 3300 /ImageMask true"));
        assert!(text.contains(
            "q 612.0000 0 0 792.0000 0 0 cm /Bg1 Do Q\n0 g\nq 612.0000 0 0 792.0000 0 0 cm /FgMask1 Do Q\n"
        ));
    }

    #[test]
    fn rejects_invalid_layered_page_size() {
        let mut page = sample_layered_page(LayeredImagePayload::Jpeg {
            data: vec![0xff, 0xd8, 0xff, 0xd9],
        });
        page.page_size.width_points = 0.0;

        let result = build_layered_pdf_page(&page);

        assert!(result.is_err());
    }

    #[test]
    fn rejects_inconsistent_manual_layered_mask() {
        let mut mask = PbmP4Image {
            width: 8,
            height: 2,
            row_stride: 1,
            bitmap: vec![0b1000_0000, 0b0100_0000],
        };
        mask.row_stride = 2;
        assert!(BilevelStream::encode(&mask).is_err());

        let mut mask = PbmP4Image {
            width: 8,
            height: 2,
            row_stride: 1,
            bitmap: vec![0b1000_0000, 0b0100_0000],
        };
        mask.bitmap.pop();
        assert!(BilevelStream::encode(&mask).is_err());
    }

    #[test]
    fn the_smallest_verified_mask_encoding_wins() {
        let mask = PbmP4Image {
            width: 8,
            height: 2,
            row_stride: 1,
            bitmap: vec![0b1000_0000, 0b0100_0000],
        };

        let jbig2 = jbig2_codec::encode_pdf_generic_verified(Bilevel {
            width: mask.width,
            height: mask.height,
            rows: &mask.bitmap,
        })
        .unwrap();
        let group4 = encode_mask_ccitt_g4(&mask).unwrap().unwrap();
        let flate = deflate_bytes(&mask.bitmap).unwrap();
        assert!(
            flate.len() < jbig2.len(),
            "the fixture must be one where a non-JBIG2 candidate wins"
        );

        let expected = if group4.len() < flate.len() {
            BilevelPayload::CcittG4(group4)
        } else {
            BilevelPayload::Flate(flate)
        };
        assert_eq!(encode_mask_payload(&mask).unwrap(), expected);
    }

    #[test]
    fn the_fallback_payload_prefers_group4_over_deflate_when_it_is_smaller() {
        let mask = crate::netpbm::parse_pbm_p4(
            include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-000-body.pbm"),
            u64::MAX,
        )
        .unwrap();

        let payload = encode_fallback_bilevel_payload(&mask).unwrap();

        assert!(payload.data().len() < deflate_bytes(&mask.bitmap).unwrap().len());
        assert!(matches!(payload, BilevelPayload::CcittG4(_)));
    }

    #[test]
    fn writes_bilevel_base_image_dictionaries_for_every_filter() {
        for (payload, expected_filter) in [
            (
                BilevelPayload::PdfJbig2 {
                    data: vec![1, 2],
                    decode: PdfBilevelDecode::Default,
                },
                "/Filter /JBIG2Decode",
            ),
            (BilevelPayload::Jbig2(vec![1, 2]), "/Filter /JBIG2Decode"),
            (
                BilevelPayload::CcittG4(vec![1, 2]),
                "/Filter /CCITTFaxDecode",
            ),
            (BilevelPayload::Flate(vec![1, 2]), "/Filter /FlateDecode"),
        ] {
            let dictionary = bilevel_image_dictionary(13, 7, &payload, None);
            assert!(dictionary.contains("/ColorSpace /DeviceGray"));
            assert!(dictionary.contains("/BitsPerComponent 1"));
            assert_eq!(
                dictionary.contains("/Decode [1 0]"),
                !matches!(
                    payload,
                    BilevelPayload::PdfJbig2 { .. } | BilevelPayload::Jbig2(_)
                )
            );
            assert!(dictionary.contains(expected_filter));
            assert!(!dictionary.contains("/ImageMask true"));
            if matches!(payload, BilevelPayload::CcittG4(_)) {
                assert!(dictionary
                    .contains("/DecodeParms << /K -1 /Columns 13 /Rows 7 /BlackIs1 true >>"));
            } else {
                assert!(!dictionary.contains("/DecodeParms"));
            }
        }
    }

    #[test]
    fn writes_image_mask_dictionaries_for_every_filter_and_polarity() {
        for (payload, expected_filter) in [
            (
                BilevelPayload::PdfJbig2 {
                    data: vec![1, 2],
                    decode: PdfBilevelDecode::Default,
                },
                "/Filter /JBIG2Decode",
            ),
            (BilevelPayload::Jbig2(vec![1, 2]), "/Filter /JBIG2Decode"),
            (
                BilevelPayload::CcittG4(vec![1, 2]),
                "/Filter /CCITTFaxDecode",
            ),
            (BilevelPayload::Flate(vec![1, 2]), "/Filter /FlateDecode"),
        ] {
            let dictionary = image_mask_dictionary(13, 7, &payload, None);
            assert!(dictionary.contains("/ImageMask true"));
            assert!(dictionary.contains("/BitsPerComponent 1"));
            assert!(!dictionary.contains("/ColorSpace"));
            assert_eq!(
                dictionary.contains("/Decode [1 0]"),
                !matches!(
                    payload,
                    BilevelPayload::PdfJbig2 { .. } | BilevelPayload::Jbig2(_)
                )
            );
            assert!(dictionary.contains(expected_filter));
            if matches!(payload, BilevelPayload::CcittG4(_)) {
                assert!(dictionary
                    .contains("/DecodeParms << /K -1 /Columns 13 /Rows 7 /BlackIs1 true >>"));
            } else {
                assert!(!dictionary.contains("/DecodeParms"));
            }
        }
    }

    #[test]
    fn all_image_mask_filters_decode_to_the_same_paint_bitmap() {
        use fax::decoder::{decode_g4, pels};
        use flate2::read::ZlibDecoder;
        use std::io::Read;

        let mask = PbmP4Image {
            width: 13,
            height: 7,
            row_stride: 2,
            bitmap: vec![
                0b1010_0101,
                0b1010_0000,
                0b0101_1010,
                0b0101_0000,
                0b1111_0000,
                0b1111_0000,
                0b0000_1111,
                0b0000_1000,
                0b1000_0000,
                0b0000_0000,
                0b0000_0000,
                0b1000_0000,
                0b1111_1111,
                0b1111_1000,
            ],
        };

        let flate = deflate_bytes(&mask.bitmap).unwrap();
        let mut flate_rows = Vec::new();
        ZlibDecoder::new(flate.as_slice())
            .read_to_end(&mut flate_rows)
            .unwrap();

        let ccitt = encode_mask_ccitt_g4(&mask).unwrap().unwrap();
        let mut ccitt_rows = vec![0; mask.bitmap.len()];
        let mut row = 0usize;
        assert!(decode_g4(
            ccitt.iter().copied(),
            mask.width as u16,
            Some(mask.height as u16),
            |transitions| {
                for (x, color) in pels(transitions, mask.width as u16).enumerate() {
                    if color == Color::Black {
                        ccitt_rows[row * mask.row_stride + x / 8] |= 1 << (7 - x % 8);
                    }
                }
                row += 1;
            }
        )
        .is_some());

        let jbig2 = jbig2_codec::encode_pdf_generic_verified(Bilevel {
            width: mask.width,
            height: mask.height,
            rows: &mask.bitmap,
        })
        .unwrap();
        let jbig2_rows =
            jbig2_codec::decode_pdf_generic(&jbig2, jbig2_codec::DecodeLimits::default())
                .unwrap()
                .rows;

        assert_eq!(flate_rows, mask.bitmap);
        assert_eq!(ccitt_rows, mask.bitmap);
        assert_eq!(jbig2_rows, mask.bitmap);
    }

    #[test]
    fn bundled_poppler_renders_all_image_mask_filters_identically() {
        use std::{
            fs,
            path::PathBuf,
            process::Command,
            time::{SystemTime, UNIX_EPOCH},
        };

        let Some(pdftoppm) = bundled_pdftoppm_path() else {
            eprintln!("bundled pdftoppm is unavailable for this host");
            return;
        };
        let mask = PbmP4Image {
            width: 13,
            height: 7,
            row_stride: 2,
            bitmap: vec![
                0b1010_0101,
                0b1010_0000,
                0b0101_1010,
                0b0101_0000,
                0b1111_0000,
                0b1111_0000,
                0b0000_1111,
                0b0000_1000,
                0b1000_0000,
                0b0000_0000,
                0b0000_0000,
                0b1000_0000,
                0b1111_1111,
                0b1111_1000,
            ],
        };
        let payloads = [
            (
                "flate",
                BilevelPayload::Flate(deflate_bytes(&mask.bitmap).unwrap()),
            ),
            (
                "group4",
                BilevelPayload::CcittG4(encode_mask_ccitt_g4(&mask).unwrap().unwrap()),
            ),
            (
                "jbig2",
                BilevelPayload::Jbig2(
                    jbig2_codec::encode_pdf_generic_verified(Bilevel {
                        width: mask.width,
                        height: mask.height,
                        rows: &mask.bitmap,
                    })
                    .unwrap(),
                ),
            ),
        ];
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "evb-image-mask-render-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();

        let mut renders = Vec::new();
        for (name, payload) in payloads {
            let pdf_path = directory.join(format!("{name}.pdf"));
            let output_prefix = directory.join(name);
            fs::write(&pdf_path, build_test_mask_pdf(&mask, &payload)).unwrap();
            let output = Command::new(&pdftoppm)
                .args(["-r", "72", "-gray", "-singlefile"])
                .arg(&pdf_path)
                .arg(&output_prefix)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{name}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            renders.push(fs::read(output_prefix.with_extension("pgm")).unwrap());
        }
        assert_eq!(renders[0], renders[1]);
        assert_eq!(renders[0], renders[2]);

        fs::remove_dir_all(directory).unwrap();

        fn bundled_pdftoppm_path() -> Option<PathBuf> {
            let tag = match (std::env::consts::OS, std::env::consts::ARCH) {
                ("macos", "aarch64") => "darwin-arm64",
                ("linux", "x86_64") => "linux-x64",
                ("windows", "x86_64") => "win32-x64",
                _ => return None,
            };
            let executable = if std::env::consts::OS == "windows" {
                "pdftoppm.exe"
            } else {
                "pdftoppm"
            };
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../resources/poppler")
                .join(tag)
                .join("bin")
                .join(executable);
            path.is_file().then_some(path)
        }
    }

    #[test]
    fn real_scan_masks_select_jbig2_over_flate_and_group4() {
        use crate::netpbm::parse_pbm_p4;

        for (name, pbm) in [
            (
                "scan-page-000-body",
                include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-000-body.pbm")
                    .as_slice(),
            ),
            (
                "scan-page-002-body",
                include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-002-body.pbm")
                    .as_slice(),
            ),
            (
                "scan-page-007-notes",
                include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-007-notes.pbm")
                    .as_slice(),
            ),
            (
                "scan-page-000-body-509",
                include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-000-body-509.pbm")
                    .as_slice(),
            ),
        ] {
            let mask = parse_pbm_p4(pbm, u64::MAX).unwrap();
            let flate = deflate_bytes(&mask.bitmap).unwrap();
            let group4 = encode_mask_ccitt_g4(&mask).unwrap().unwrap();
            let jbig2 = jbig2_codec::encode_pdf_generic_verified(Bilevel {
                width: mask.width,
                height: mask.height,
                rows: &mask.bitmap,
            })
            .unwrap();
            eprintln!(
                "{name}: Flate={} bytes, G4={} bytes, JBIG2={} bytes",
                flate.len(),
                group4.len(),
                jbig2.len()
            );

            assert!(jbig2.len() < flate.len());
            assert!(jbig2.len() < group4.len());
            assert!(matches!(
                encode_mask_payload(&mask).unwrap(),
                BilevelPayload::Jbig2(_)
            ));
        }
    }

    #[test]
    fn repeated_text_masks_share_one_verified_symbol_dictionary() {
        let mask = crate::netpbm::parse_pbm_p4(
            include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-007-notes.pbm"),
            u64::MAX,
        )
        .unwrap();
        let mut first = BilevelStream::encode(&mask).unwrap();
        let mut second = BilevelStream::encode(&mask).unwrap();
        let fallback_bytes = first.payload.data().len() + second.payload.data().len();
        apply_shared_symbol_encoding(&mut [&mut first, &mut second]);

        let (first_globals, second_globals) = match (&first.payload, &second.payload) {
            (
                BilevelPayload::Jbig2Symbol {
                    globals: first_globals,
                    ..
                },
                BilevelPayload::Jbig2Symbol {
                    globals: second_globals,
                    ..
                },
            ) => (first_globals, second_globals),
            payloads => panic!("expected shared symbol payloads, got {payloads:?}"),
        };
        assert!(Arc::ptr_eq(first_globals, second_globals));
        assert!(
            first_globals.len() + first.payload.data().len() + second.payload.data().len()
                < fallback_bytes
        );

        let pages = [first, second].map(|stream| ImagePage {
            width: stream.width,
            height: stream.height,
            dpi: 300,
            color_space: "DeviceGray",
            icc_profile: None,
            payload: ImagePayload::Bilevel(stream),
        });
        let pdf = build_pdf(&pages).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert_eq!(text.matches("/JBIG2Globals").count(), 2);
        assert_eq!(text.matches("/Filter /JBIG2Decode").count(), 2);
        assert_eq!(text.matches("/DecodeParms << /JBIG2Globals").count(), 2);
    }

    #[test]
    fn later_symbol_chunk_keeps_its_distinct_globals_reference() {
        let mut writer = PdfWriter::new(Vec::new(), None).unwrap();
        let first_globals = Arc::new(b"first verified globals".to_vec());
        let mut first_object = None;

        // Match the production 50-page chunk boundary, then release every
        // page-owned Arc before constructing the next chunk. The writer must
        // not identify dictionaries by a recyclable allocation address.
        for page_index in 0..50 {
            let page = ImagePage {
                width: 8,
                height: 8,
                dpi: 300,
                color_space: "DeviceGray",
                icc_profile: None,
                payload: ImagePayload::Bilevel(BilevelStream {
                    width: 8,
                    height: 8,
                    payload: BilevelPayload::Jbig2Symbol {
                        data: vec![page_index],
                        globals: Arc::clone(&first_globals),
                    },
                    raw_mask: None,
                }),
            };
            writer.add_page(&page).unwrap();
            let ImagePayload::Bilevel(stream) = &page.payload else {
                unreachable!();
            };
            let object = writer.jbig2_globals_object(&stream.payload).unwrap();
            assert_eq!(*first_object.get_or_insert(object), object);
        }
        drop(first_globals);

        let second_globals = Arc::new(b"second, different verified globals".to_vec());
        let last_page = ImagePage {
            width: 8,
            height: 8,
            dpi: 300,
            color_space: "DeviceGray",
            icc_profile: None,
            payload: ImagePayload::Bilevel(BilevelStream {
                width: 8,
                height: 8,
                payload: BilevelPayload::Jbig2Symbol {
                    data: vec![50],
                    globals: second_globals,
                },
                raw_mask: None,
            }),
        };
        writer.add_page(&last_page).unwrap();
        let ImagePayload::Bilevel(last_stream) = &last_page.payload else {
            unreachable!();
        };
        let second_object = writer.jbig2_globals_object(&last_stream.payload).unwrap();
        let first_object = first_object.unwrap();

        assert_ne!(first_object, second_object);
        assert_eq!(writer.jbig2_globals_objects.len(), 2);

        let pdf = writer.finish().unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert_eq!(
            text.matches(&format!("/JBIG2Globals {first_object} 0 R"))
                .count(),
            50
        );
        assert_eq!(
            text.matches(&format!("/JBIG2Globals {second_object} 0 R"))
                .count(),
            1
        );
    }

    #[test]
    fn symbol_encoder_failure_keeps_the_existing_smallest_payload() {
        let mask = PbmP4Image {
            width: 8,
            height: 8,
            row_stride: 1,
            bitmap: vec![0; 8],
        };
        let mut stream = BilevelStream::encode(&mask).unwrap();
        let before = stream.payload.data().to_vec();

        apply_shared_symbol_encoding(&mut [&mut stream]);

        assert_eq!(stream.payload.data(), before);
        assert!(!matches!(
            stream.payload,
            BilevelPayload::Jbig2Symbol { .. }
        ));
    }

    #[test]
    fn shared_symbols_must_save_their_pdf_container_overhead() {
        assert!(!shared_symbol_encoding_saves_pdf_bytes(10_000, 9_999, 2));
        assert!(!shared_symbol_encoding_saves_pdf_bytes(
            10_000,
            10_000
                - SHARED_SYMBOL_GLOBAL_OBJECT_OVERHEAD
                - 2 * SHARED_SYMBOL_PAGE_REFERENCE_OVERHEAD,
            2,
        ));
        assert!(shared_symbol_encoding_saves_pdf_bytes(10_000, 9_000, 2));
    }

    #[test]
    fn symbol_safety_records_keep_stable_machine_readable_fields() {
        assert_eq!(
            symbol_fallback_record(3, "dictionary rejected"),
            serde_json::json!({
                "type": "jbig2-symbol-fallback",
                "pages": 3,
                "reason": "dictionary rejected",
            })
        );
        assert_eq!(
            symbol_fallback_record(
                50,
                "unsupported JBIG2 feature: symbol classifier comparison budget exceeded",
            ),
            serde_json::json!({
                "type": "jbig2-symbol-fallback",
                "pages": 50,
                "reason": "unsupported JBIG2 feature: symbol classifier comparison budget exceeded",
            })
        );
        assert_eq!(
            symbol_page_fallback_record(2, "whole-page verification failed"),
            serde_json::json!({
                "type": "jbig2-symbol-page-fallback",
                "pageInChunk": 2,
                "reason": "whole-page verification failed",
            })
        );
        assert_eq!(
            symbol_size_record("jbig2-symbol-selected", 2, 1, 17, 91, 123, 400, 220),
            serde_json::json!({
                "type": "jbig2-symbol-selected",
                "pages": 2,
                "fallbackPages": 1,
                "symbols": 17,
                "components": 91,
                "classComparisons": 123,
                "fallbackBytes": 400,
                "symbolBytes": 220,
            })
        );
    }

    fn build_test_mask_pdf(mask: &PbmP4Image, payload: &BilevelPayload) -> Vec<u8> {
        let mut writer = PdfWriter::new(Vec::new(), None).unwrap();
        writer.page_objects.push(3);
        writer.next_object = 6;
        writer
            .push_object(
                3,
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources << /XObject << /Mask 4 0 R >> >> /Contents 5 0 R >>",
                    mask.width, mask.height
                )
                .as_bytes(),
            )
            .unwrap();
        let dictionary = image_mask_dictionary(mask.width, mask.height, payload, None);
        writer
            .push_stream_object(4, dictionary.as_bytes(), payload.data())
            .unwrap();
        let content = format!(
            "1 g\n0 0 {} {} re f\n0 g\nq {} 0 0 {} 0 0 cm /Mask Do Q\n",
            mask.width, mask.height, mask.width, mask.height
        );
        writer
            .push_stream_object(
                5,
                format!("<< /Length {} >>", content.len()).as_bytes(),
                content.as_bytes(),
            )
            .unwrap();
        writer.finish().unwrap()
    }

    fn sample_layered_page(payload: LayeredImagePayload) -> LayeredPdfPage {
        LayeredPdfPage {
            page_size: PdfPageSize {
                width_points: 144.0,
                height_points: 72.0,
            },
            background: LayeredPdfImage {
                width: 4,
                height: 2,
                color_space: "DeviceGray",
                payload,
            },
            foreground_mask: sample_mask(),
            foreground_color: None,
        }
    }

    fn sample_mask() -> BilevelStream {
        BilevelStream::encode(&PbmP4Image {
            width: 8,
            height: 2,
            row_stride: 1,
            bitmap: vec![0b1000_0000, 0b0100_0000],
        })
        .unwrap()
    }

    fn mask_object_dictionary(pdf: &str) -> &str {
        let image_mask = pdf.find("/ImageMask true").unwrap();
        let object_start = pdf[..image_mask].rfind("<<").unwrap();
        let object_end = pdf[image_mask..].find(">>").unwrap() + image_mask + 2;
        &pdf[object_start..object_end]
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }
}
