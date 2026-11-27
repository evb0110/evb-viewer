use evb_native_support::{NativeError, NativeErrorCode};
use fax::{encoder::Encoder as FaxEncoder, slice_bits, Color, VecWriter};
use flate2::{write::ZlibEncoder, Compression};
use jbig2_codec::Bilevel;
use std::{fmt::Write as FmtWrite, io::Write as IoWrite};

use crate::{flate::deflate_up_filtered_slices, netpbm::PbmP4Image, PdfBilevelDecode, Result};

/// The largest byte offset representable in a classic 10-digit PDF
/// cross-reference table entry (`0000000000`..=`9999999999`, ~9.31 GiB).
/// Outputs past this offset automatically switch to a PDF 1.5+ `/Type /XRef`
/// stream with 8-byte offsets (`/W [1 8 2]`).
const MAX_CLASSIC_XREF_OFFSET: u64 = 9_999_999_999;

/// The largest byte offset representable losslessly in JavaScript numbers
/// (`Number.MAX_SAFE_INTEGER`, `2^53 - 1`), matching the safe-offset bound
/// enforced by vendored `pdfjs-dist` (`XRef.readXRefStream`).
const MAX_SAFE_PDF_OFFSET: u64 = (1u64 << 53) - 1;

fn pdf_offset_limit_error(offset: Option<u64>) -> Box<dyn std::error::Error> {
    let message = match offset {
        Some(offset) => format!(
            "PDF output offset {offset} exceeds the maximum safe PDF offset ({MAX_SAFE_PDF_OFFSET} bytes)"
        ),
        None => format!(
            "PDF output offset exceeds the maximum safe PDF offset ({MAX_SAFE_PDF_OFFSET} bytes)"
        ),
    };
    Box::new(NativeError::new(NativeErrorCode::TooLarge, message))
}

fn ensure_safe_pdf_offset(offset: u64) -> Result<()> {
    if offset > MAX_SAFE_PDF_OFFSET {
        return Err(pdf_offset_limit_error(Some(offset)));
    }
    Ok(())
}

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
    pub(crate) dpi_x: u32,
    pub(crate) dpi_y: u32,
    pub(crate) color_space: &'static str,
    pub(crate) icc_profile: Option<Vec<u8>>,
    pub(crate) payload: ImagePayload,
}

#[cfg(not(target_family = "wasm"))]
impl ImagePage {
    pub(crate) fn payload_bytes(&self) -> u64 {
        let stream_bytes = match &self.payload {
            ImagePayload::RawFlate { data, .. }
            | ImagePayload::Jpeg { data }
            | ImagePayload::Jpx { data } => data.capacity().max(data.len()) as u64,
            ImagePayload::Bilevel(stream) => stream.payload_bytes(),
        };
        let icc_bytes = self
            .icc_profile
            .as_ref()
            .map_or(0, |profile| profile.capacity().max(profile.len()) as u64);
        stream_bytes.saturating_add(icc_bytes)
    }
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

#[cfg(not(target_family = "wasm"))]
impl LayeredPdfImage {
    pub(crate) fn payload_bytes(&self) -> u64 {
        match &self.payload {
            LayeredImagePayload::RawFlate { data, .. }
            | LayeredImagePayload::Jpeg { data }
            | LayeredImagePayload::Jpx { data } => data.capacity().max(data.len()) as u64,
        }
    }
}

pub struct LayeredPdfPage {
    pub page_size: PdfPageSize,
    pub background: LayeredPdfImage,
    pub foreground_mask: BilevelStream,
    pub foreground_color: Option<[u8; 3]>,
}

#[cfg(not(target_family = "wasm"))]
impl LayeredPdfPage {
    pub(crate) fn payload_bytes(&self) -> u64 {
        self.background
            .payload_bytes()
            .saturating_add(self.foreground_mask.payload_bytes())
    }
}

pub struct SoftMaskStream {
    width: u32,
    height: u32,
    data: Vec<u8>,
    decode_params: String,
}

impl SoftMaskStream {
    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn payload_bytes(&self) -> u64 {
        self.data.capacity().max(self.data.len()) as u64
    }

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

#[cfg(not(target_family = "wasm"))]
impl SoftLayeredPdfPage {
    pub(crate) fn payload_bytes(&self) -> u64 {
        self.background
            .payload_bytes()
            .saturating_add(self.foreground_alpha.payload_bytes())
    }
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

#[cfg(not(target_family = "wasm"))]
impl AffineMaskedLayeredPdfPage {
    pub(crate) fn payload_bytes(&self) -> u64 {
        self.background
            .payload_bytes()
            .saturating_add(self.foreground.payload_bytes())
            .saturating_add(self.foreground_mask.payload_bytes())
    }
}

pub struct MaskPdfPage {
    pub page_size: PdfPageSize,
    pub foreground_mask: BilevelStream,
}

#[cfg(not(target_family = "wasm"))]
impl MaskPdfPage {
    pub(crate) fn payload_bytes(&self) -> u64 {
        self.foreground_mask.payload_bytes()
    }
}

/// A validated bilevel bitmap already reduced to the single PDF stream that
/// will be written for it. Encoding happens while pages are prepared, so page
/// preparation can run off the writer's thread and the writer only serializes
/// bytes.
pub struct BilevelStream {
    width: u32,
    height: u32,
    payload: BilevelPayload,
}

impl BilevelStream {
    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn payload_bytes(&self) -> u64 {
        self.payload.capacity_bytes()
    }

    pub(crate) fn encode(mask: &PbmP4Image) -> Result<Self> {
        validate_image_mask(mask)?;
        Ok(Self {
            width: mask.width,
            height: mask.height,
            payload: encode_mask_payload(mask)?,
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
        })
    }
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
    mut write_pages: impl FnMut(&mut PdfWriter<W>) -> Result<()>,
) -> Result<W> {
    let mut writer = PdfWriter::new(writer, provenance_stamp_hex)?;
    write_pages(&mut writer)?;
    writer.finish()
}

pub(crate) struct PdfWriter<W: IoWrite> {
    inner: W,
    offsets: Vec<Option<u64>>,
    page_objects: Vec<usize>,
    next_object: usize,
    bytes_written: u64,
    provenance_stamp_hex: Option<String>,
}

impl<W: IoWrite> PdfWriter<W> {
    fn new(inner: W, provenance_stamp_hex: Option<&str>) -> Result<Self> {
        if let Some(stamp) = provenance_stamp_hex {
            validate_provenance_stamp_hex(stamp)?;
        }
        let mut writer = Self {
            inner,
            offsets: Vec::new(),
            page_objects: Vec::new(),
            next_object: 3,
            bytes_written: 0,
            provenance_stamp_hex: provenance_stamp_hex.map(str::to_owned),
        };

        writer.write_all(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")?;
        writer.push_object(1, b"<< /Type /Catalog /Pages 2 0 R >>")?;
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
        let (rotation_degrees, mirror_horizontal) = resolve_image_transform(rotation_degrees)?;
        if let Some(size) = page_size {
            validate_page_size(size)?;
        }
        if let Some(placement) = placement {
            let page_size = page_size.ok_or("Image placement requires an explicit page size")?;
            validate_image_placement(placement, page_size)?;
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
            .unwrap_or_else(|| points(page.width, page.dpi_x));
        let page_height = page_size
            .map(|size| size.height_points)
            .unwrap_or_else(|| points(page.height, page.dpi_y));
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
            if mirror_horizontal {
                format!(
                    "q -{:.4} 0 0 {:.4} {:.4} {:.4} cm /{} Do Q\n",
                    placement.width_points,
                    placement.height_points,
                    placement.x_points + placement.width_points,
                    placement.y_points,
                    image_name,
                )
            } else {
                format!(
                    "q {:.4} 0 0 {:.4} {:.4} {:.4} cm /{} Do Q\n",
                    placement.width_points,
                    placement.height_points,
                    placement.x_points,
                    placement.y_points,
                    image_name,
                )
            }
        } else if mirror_horizontal {
            format!(
                "q -{:.4} 0 0 {:.4} {:.4} 0 cm /{} Do Q\n",
                page_width, page_height, page_width, image_name,
            )
        } else {
            format!(
                "q {:.4} 0 0 {:.4} 0 0 cm /{} Do Q\n",
                page_width, page_height, image_name,
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
        let classic_trailer = match info_object {
            Some(info_object) => format!(
                "trailer\n<< /Size {} /Root 1 0 R /Info {} 0 R >>\nstartxref\n{}\n%%EOF\n",
                object_count + 1,
                info_object,
                xref_offset
            ),
            None => format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                object_count + 1,
                xref_offset
            ),
        };
        let classic_xref_header = format!("xref\n0 {}\n", object_count + 1);
        let classic_entries_len = (object_count as u64 + 1).checked_mul(20);
        let classic_end_offset = classic_entries_len
            .and_then(|entries_len| entries_len.checked_add(classic_xref_header.len() as u64))
            .and_then(|table_len| table_len.checked_add(classic_trailer.len() as u64))
            .and_then(|tail_len| xref_offset.checked_add(tail_len));
        let mut needs_xref_stream =
            classic_end_offset.is_none_or(|end_offset| end_offset > MAX_CLASSIC_XREF_OFFSET);
        for object_number in 1..=object_count {
            let offset = self
                .offsets
                .get(object_number)
                .and_then(|offset| *offset)
                .ok_or_else(|| format!("Missing PDF object offset: {object_number}"))?;
            ensure_safe_pdf_offset(offset)?;
            if offset > MAX_CLASSIC_XREF_OFFSET {
                needs_xref_stream = true;
            }
        }

        if needs_xref_stream {
            let root_object = self.next_object;
            self.next_object += 1;
            self.push_object(
                root_object,
                b"<< /Type /Catalog /Version /1.5 /Pages 2 0 R >>",
            )?;

            let xref_object = self.next_object;
            let xref_offset = self.bytes_written;
            ensure_safe_pdf_offset(xref_offset)?;
            let offsets = std::mem::take(&mut self.offsets);
            let total_entries = xref_object + 1;
            let mut xref_stream = Vec::with_capacity(total_entries * 11);
            // Object 0: free head entry (type 0, next free 0, gen 65535).
            xref_stream.extend_from_slice(&[0; 9]);
            xref_stream.extend_from_slice(&u16::MAX.to_be_bytes());
            for object_number in 1..xref_object {
                let offset = offsets
                    .get(object_number)
                    .and_then(|offset| *offset)
                    .ok_or_else(|| format!("Missing PDF object offset: {object_number}"))?;
                ensure_safe_pdf_offset(offset)?;
                xref_stream.push(1);
                xref_stream.extend_from_slice(&offset.to_be_bytes());
                xref_stream.extend_from_slice(&0u16.to_be_bytes());
            }
            // Self-entry for the cross-reference stream object itself.
            xref_stream.push(1);
            xref_stream.extend_from_slice(&xref_offset.to_be_bytes());
            xref_stream.extend_from_slice(&0u16.to_be_bytes());

            let info_entry = info_object
                .map(|object_number| format!(" /Info {object_number} 0 R"))
                .unwrap_or_default();
            let header = format!("{xref_object} 0 obj\n");
            let dict = format!(
                "<< /Type /XRef /Size {total_entries} /W [1 8 2] /Root {root_object} 0 R{info_entry} /Length {} >>",
                xref_stream.len()
            );
            let stream_start = b"\nstream\n";
            let stream_end = format!("\nendstream\nendobj\nstartxref\n{xref_offset}\n%%EOF\n");
            self.ensure_body_write_fits(&[
                header.len(),
                dict.len(),
                stream_start.len(),
                xref_stream.len(),
                stream_end.len(),
            ])?;
            self.write_all(header.as_bytes())?;
            self.write_all(dict.as_bytes())?;
            self.write_all(stream_start)?;
            self.write_all(&xref_stream)?;
            self.write_all(stream_end.as_bytes())?;
        } else {
            let offsets = std::mem::take(&mut self.offsets);
            self.write_all(classic_xref_header.as_bytes())?;
            writeln!(&mut self, "0000000000 65535 f ")?;
            for offset in offsets[1..=object_count].iter().flatten() {
                writeln!(&mut self, "{offset:010} 00000 n ")?;
            }
            self.write_all(classic_trailer.as_bytes())?;
        }
        self.flush()?;

        Ok(self.inner)
    }

    fn push_image_object(
        &mut self,
        object_number: usize,
        page: &ImagePage,
        icc_object: Option<usize>,
    ) -> Result<()> {
        let payload = match &page.payload {
            ImagePayload::Bilevel(stream) => {
                let dict = bilevel_image_dictionary(stream.width, stream.height, &stream.payload);
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
        let dict = image_mask_dictionary(mask.width, mask.height, &mask.payload);
        self.push_stream_object(object_number, dict.as_bytes(), mask.payload.data())
    }

    fn push_bilevel_image_object(
        &mut self,
        object_number: usize,
        mask: &BilevelStream,
    ) -> Result<()> {
        let dict = bilevel_soft_mask_dictionary(mask.width, mask.height, &mask.payload);
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
        let header = format!("{object_number} 0 obj\n");
        let footer = b"\nendobj\n";
        self.ensure_body_write_fits(&[header.len(), body.len(), footer.len()])?;
        self.record_object_offset(object_number);
        self.write_all(header.as_bytes())?;
        self.write_all(body)?;
        self.write_all(footer)?;
        Ok(())
    }

    fn push_stream_object(
        &mut self,
        object_number: usize,
        dict: &[u8],
        stream: &[u8],
    ) -> Result<()> {
        let header = format!("{object_number} 0 obj\n");
        let stream_start = b"\nstream\n";
        let stream_end = b"\nendstream\nendobj\n";
        self.ensure_body_write_fits(&[
            header.len(),
            dict.len(),
            stream_start.len(),
            stream.len(),
            stream_end.len(),
        ])?;
        self.record_object_offset(object_number);
        self.write_all(header.as_bytes())?;
        self.write_all(dict)?;
        self.write_all(stream_start)?;
        self.write_all(stream)?;
        self.write_all(stream_end)?;
        Ok(())
    }

    fn ensure_body_write_fits(&self, part_lengths: &[usize]) -> Result<()> {
        ensure_safe_pdf_offset(self.bytes_written)?;
        let mut end_offset = self.bytes_written;
        for &len in part_lengths {
            end_offset = end_offset
                .checked_add(len as u64)
                .ok_or_else(|| pdf_offset_limit_error(None))?;
            ensure_safe_pdf_offset(end_offset)?;
        }
        Ok(())
    }

    fn record_object_offset(&mut self, object_number: usize) {
        if self.offsets.len() <= object_number {
            self.offsets.resize(object_number + 1, None);
        }
        self.offsets[object_number] = Some(self.bytes_written);
    }
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

fn resolve_image_transform(value: u16) -> Result<(u16, bool)> {
    match value {
        0 | 90 | 180 | 270 => Ok((value, false)),
        360 => Ok((0, true)),
        450 => Ok((90, true)),
        540 => Ok((180, true)),
        630 => Ok((270, true)),
        _ => Err("Image transform must be 0, 90, 180, 270, 360, 450, 540, or 630".into()),
    }
}

impl<W: IoWrite> IoWrite for PdfWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.bytes_written = self
            .bytes_written
            .checked_add(written as u64)
            .ok_or_else(|| std::io::Error::other("PDF byte offset overflow"))?;
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
    let mut compressed = encoder.finish()?;
    compressed.shrink_to_fit();
    Ok(compressed)
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
    CcittG4(Vec<u8>),
    Flate(Vec<u8>),
}

impl BilevelPayload {
    fn data(&self) -> &[u8] {
        match self {
            Self::PdfJbig2 { data, .. }
            | Self::Jbig2(data)
            | Self::CcittG4(data)
            | Self::Flate(data) => data,
        }
    }

    #[cfg(not(target_family = "wasm"))]
    fn capacity_bytes(&self) -> u64 {
        match self {
            Self::PdfJbig2 { data, .. }
            | Self::Jbig2(data)
            | Self::CcittG4(data)
            | Self::Flate(data) => data.capacity().max(data.len()) as u64,
        }
    }

    fn shrink_to_fit(&mut self) {
        match self {
            Self::PdfJbig2 { data, .. }
            | Self::Jbig2(data)
            | Self::CcittG4(data)
            | Self::Flate(data) => data.shrink_to_fit(),
        }
    }
}

/// Minimum raw bitmap size (bytes) for skipping trial Flate/CCITT G4 fallback
/// encodes once JBIG2 already achieves strong compression. Tiny bitmaps still
/// compare all three lossless candidates because JBIG2's segment headers can
/// outweigh a few bytes of bitmap data.
const JBIG2_SKIP_FALLBACK_MIN_RAW_BYTES: usize = 4096;

fn should_verify_jbig2() -> bool {
    if cfg!(any(test, debug_assertions)) {
        return true;
    }
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    {
        static VERIFY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *VERIFY.get_or_init(|| {
            std::env::var("EVB_JBIG2_VERIFY")
                .ok()
                .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        })
    }
    #[cfg(all(target_family = "wasm", target_os = "unknown"))]
    {
        false
    }
}

fn encode_mask_payload(mask: &PbmP4Image) -> Result<BilevelPayload> {
    let width = mask.width;
    let height = mask.height;
    let bilevel = Bilevel {
        width,
        height,
        rows: &mask.bitmap,
    };
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    let jbig2_started_at = std::time::Instant::now();
    let jbig2 = if should_verify_jbig2() {
        jbig2_codec::encode_pdf_generic_verified(bilevel)
    } else {
        jbig2_codec::encode_pdf_generic(bilevel)
    };
    #[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
    if std::env::var_os("EVB_PDF_COMBINE_TIMING").is_some() {
        eprintln!(
            "{{\"type\":\"jbig2-encode-timing\",\"width\":{width},\"height\":{height},\"elapsedMs\":{:.3}}}",
            jbig2_started_at.elapsed().as_secs_f64() * 1_000.0
        );
    }

    if let Ok(mut data) = jbig2 {
        if mask.bitmap.len() >= JBIG2_SKIP_FALLBACK_MIN_RAW_BYTES
            && data.len().saturating_mul(4) <= mask.bitmap.len()
        {
            data.shrink_to_fit();
            return Ok(BilevelPayload::Jbig2(data));
        }

        // Strict comparisons give equal-length candidates a stable priority:
        // Flate, then Group 4, then JBIG2.
        let fallback = encode_fallback_bilevel_payload(mask)?;
        let mut chosen = if data.len() < fallback.data().len() {
            BilevelPayload::Jbig2(data)
        } else {
            fallback
        };
        chosen.shrink_to_fit();
        return Ok(chosen);
    }

    let error = jbig2.unwrap_err();
    // Keep the verified source stencil and select the smallest remaining
    // lossless payload; a JBIG2 failure is not a reason to discard valid
    // MRC layers.
    eprintln!(
        "warning: JBIG2 encoding failed for {width}x{height} bilevel image; falling back: {error}"
    );
    let mut fallback = encode_fallback_bilevel_payload(mask)?;
    fallback.shrink_to_fit();
    Ok(fallback)
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

fn bilevel_image_dictionary(width: u32, height: u32, payload: &BilevelPayload) -> String {
    let filter = match payload {
        BilevelPayload::PdfJbig2 { .. } | BilevelPayload::Jbig2(_) => {
            "/Filter /JBIG2Decode".to_string()
        }
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
fn bilevel_soft_mask_dictionary(width: u32, height: u32, payload: &BilevelPayload) -> String {
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

fn image_mask_dictionary(width: u32, height: u32, payload: &BilevelPayload) -> String {
    let filter = match payload {
        BilevelPayload::PdfJbig2 { .. } | BilevelPayload::Jbig2(_) => {
            "/Filter /JBIG2Decode".to_string()
        }
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

/// Initial bit capacity for `fax::VecWriter::with_capacity` (which reserves
/// `(n + 7) / 8` bytes). Keeps pre-allocation bounded well below the raw 1-bit
/// bitmap size while avoiding tiny initial reallocations.
fn ccitt_initial_capacity_bits(bitmap_len: usize) -> usize {
    (bitmap_len / 4).max(4096)
}

fn encode_mask_ccitt_g4(mask: &PbmP4Image) -> Result<Option<Vec<u8>>> {
    let Ok(width) = u16::try_from(mask.width) else {
        return Ok(None);
    };
    let writer = VecWriter::with_capacity(ccitt_initial_capacity_bits(mask.bitmap.len()));
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
            .encode_line(colors, u32::from(width))
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
            dpi_x: 72,
            dpi_y: 72,
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
            dpi_x: 72,
            dpi_y: 72,
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

        let mut mirrored = PdfWriter::new(Vec::new(), None).unwrap();
        mirrored
            .add_page_with_size_and_rotation(&page, &page_size, None, 360)
            .unwrap();
        let mirrored = String::from_utf8_lossy(&mirrored.finish().unwrap()).into_owned();
        assert!(mirrored.contains("/MediaBox [0 0 100.0000 200.0000]"));
        assert!(mirrored.contains("q -100.0000 0 0 200.0000 100.0000 0 cm /Im1 Do Q"));
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
            dpi_x: 72,
            dpi_y: 72,
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
            let dictionary = bilevel_image_dictionary(13, 7, &payload);
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
            let dictionary = image_mask_dictionary(13, 7, &payload);
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
            mask.width,
            Some(mask.height),
            |transitions| {
                for (x, color) in pels(transitions, mask.width).enumerate() {
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
    fn ccitt_g4_encoder_matches_reference_bytes_without_excessive_preallocation() {
        use crate::netpbm::parse_pbm_p4;

        fn encode_reference(mask: &PbmP4Image) -> Vec<u8> {
            let mut encoder = FaxEncoder::new(VecWriter::new());
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
                encoder.encode_line(colors, mask.width).unwrap();
            }
            encoder.finish().unwrap().finish()
        }

        // Real scanned bilevel fixtures produce byte-identical output.
        for pbm in [
            include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-000-body.pbm").as_slice(),
            include_bytes!("../../jbig2-codec/tests/fixtures/scan-page-007-notes.pbm").as_slice(),
        ] {
            let mask = parse_pbm_p4(pbm, u64::MAX).unwrap();
            let encoded = encode_mask_ccitt_g4(&mask).unwrap().unwrap();
            assert_eq!(encoded, encode_reference(&mask));
        }

        // Large hi-res sparse bitmap (4000x4000, 2 MB raw packed 1-bit):
        // must encode identically without pre-allocating anything near bitmap.len().
        let width = 4_000u32;
        let height = 4_000u32;
        let row_stride = (width as usize).div_ceil(8);
        let mut bitmap = vec![0u8; row_stride * height as usize];
        for y in (100..height as usize).step_by(64) {
            let row = &mut bitmap[y * row_stride..(y + 1) * row_stride];
            row[20..40].fill(0xAA);
            row[200..240].fill(0xFF);
        }
        let large_mask = PbmP4Image {
            width,
            height,
            row_stride,
            bitmap,
        };
        let encoded = encode_mask_ccitt_g4(&large_mask).unwrap().unwrap();
        assert_eq!(encoded, encode_reference(&large_mask));
        let expected_initial_bytes =
            ccitt_initial_capacity_bits(large_mask.bitmap.len()).div_ceil(8);
        assert!(
            encoded.len() <= expected_initial_bytes,
            "sparse test bitmap should fit inside initial capacity"
        );
        assert!(
            encoded.capacity() <= expected_initial_bytes * 2,
            "unexpectedly large CCITT buffer capacity {} for raw bitmap {} bytes",
            encoded.capacity(),
            large_mask.bitmap.len()
        );
        assert!(
            encoded.capacity() < large_mask.bitmap.len() / 8,
            "capacity {} must remain far below raw bitmap size {}",
            encoded.capacity(),
            large_mask.bitmap.len()
        );

        // Edge cases: tiny 1x1 bitmap and capacity bounds.
        assert_eq!(ccitt_initial_capacity_bits(0), 4096);
        assert_eq!(ccitt_initial_capacity_bits(1), 4096);
        assert_eq!(ccitt_initial_capacity_bits(20_000_000), 5_000_000);

        let tiny_mask = PbmP4Image {
            width: 1,
            height: 1,
            row_stride: 1,
            bitmap: vec![0x80],
        };
        assert_eq!(
            encode_mask_ccitt_g4(&tiny_mask).unwrap().unwrap(),
            encode_reference(&tiny_mask)
        );
    }

    #[test]
    fn classic_xref_offset_allows_exact_ten_digit_boundary() {
        ensure_safe_pdf_offset(0).unwrap();
        ensure_safe_pdf_offset(MAX_CLASSIC_XREF_OFFSET).unwrap();
        ensure_safe_pdf_offset(MAX_CLASSIC_XREF_OFFSET + 1).unwrap();
        ensure_safe_pdf_offset(MAX_SAFE_PDF_OFFSET).unwrap();

        let error = ensure_safe_pdf_offset(MAX_SAFE_PDF_OFFSET + 1).unwrap_err();
        let native = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native.code, NativeErrorCode::TooLarge);
        assert!(native.message.contains("maximum safe PDF offset"));

        // Exact ISO 32000-1 Annex C.2 boundary: object 2 is 52 bytes and the
        // 3-entry classic xref table + trailer is 130 bytes (total 182 bytes),
        // placing the finished PDF length at exactly MAX_CLASSIC_XREF_OFFSET
        // (9_999_999_999 bytes).
        let mut writer = PdfWriter::new(Vec::new(), None).unwrap();
        let pages_object_len =
            "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n".len() as u64;
        let classic_tail_len = "xref\n0 3\n".len() as u64
            + 3 * 20
            + "trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n9999999869\n%%EOF\n".len() as u64;
        let start_bytes = MAX_CLASSIC_XREF_OFFSET - pages_object_len - classic_tail_len;
        let expected_xref_offset = start_bytes + pages_object_len;
        writer.bytes_written = start_bytes;
        let pdf = writer.finish().unwrap();
        let xref_start = find_bytes(&pdf, b"xref\n").unwrap();
        let xref_section = std::str::from_utf8(&pdf[xref_start..]).unwrap();
        assert_eq!(xref_section.len() as u64, classic_tail_len);
        assert_eq!(
            expected_xref_offset + xref_section.len() as u64,
            MAX_CLASSIC_XREF_OFFSET
        );
        assert!(xref_section.contains(&format!("{start_bytes:010} 00000 n \n")));
        assert!(xref_section.contains(&format!("startxref\n{expected_xref_offset}\n%%EOF\n")));
        for line in xref_section.lines().skip(2).take(3) {
            assert_eq!(
                line.len(),
                19,
                "classic xref entry must stay 20 bytes incl. LF: {line:?}"
            );
        }
    }

    #[test]
    fn push_object_and_stream_object_allow_past_classic_xref_and_guard_safe_offset_limit() {
        let mut writer = PdfWriter::new(Vec::new(), None).unwrap();
        writer.bytes_written = MAX_CLASSIC_XREF_OFFSET + 123;
        writer.push_object(3, b"<< /Type /Page >>").unwrap();
        assert_eq!(writer.offsets[3], Some(MAX_CLASSIC_XREF_OFFSET + 123));

        let bytes_before = writer.inner.len();
        writer.bytes_written = MAX_SAFE_PDF_OFFSET - 10;

        let error = writer.push_object(4, b"<< /Type /Page >>").unwrap_err();
        let native = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native.code, NativeErrorCode::TooLarge);
        assert!(native.message.contains("maximum safe PDF offset"));
        assert_eq!(writer.inner.len(), bytes_before);
        assert!(writer.offsets.get(4).and_then(|offset| *offset).is_none());

        writer.bytes_written = MAX_SAFE_PDF_OFFSET + 1;
        let error = writer.push_object(4, b"<< >>").unwrap_err();
        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::TooLarge
        );
        assert_eq!(writer.inner.len(), bytes_before);

        writer.bytes_written = MAX_SAFE_PDF_OFFSET - 20;
        let error = writer
            .push_stream_object(5, b"<< /Length 16 >>", &[0u8; 16])
            .unwrap_err();
        let native = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native.code, NativeErrorCode::TooLarge);
        assert!(native.message.contains("maximum safe PDF offset"));
        assert_eq!(writer.inner.len(), bytes_before);
        assert!(writer.offsets.get(5).and_then(|offset| *offset).is_none());
    }

    #[test]
    fn finish_emits_pdf_15_xref_stream_past_classic_xref_limit() {
        fn parse_xref_stream_entries(pdf: &[u8]) -> (String, Vec<(u8, u64, u16)>, u64) {
            let xref_marker = find_bytes(pdf, b"/Type /XRef").unwrap();
            let obj_start = pdf[..xref_marker]
                .windows(2)
                .rposition(|window| window == b"<<")
                .unwrap();
            let stream_marker = find_bytes(&pdf[obj_start..], b"\nstream\n").unwrap();
            let dict = std::str::from_utf8(&pdf[obj_start..obj_start + stream_marker])
                .unwrap()
                .to_string();
            let data_start = obj_start + stream_marker + b"\nstream\n".len();
            let endstream_rel = find_bytes(&pdf[data_start..], b"\nendstream\n").unwrap();
            let data = &pdf[data_start..data_start + endstream_rel];
            assert_eq!(data.len() % 11, 0);
            let entries = data
                .chunks_exact(11)
                .map(|row| {
                    let entry_type = row[0];
                    let offset = u64::from_be_bytes(row[1..9].try_into().unwrap());
                    let gen = u16::from_be_bytes(row[9..11].try_into().unwrap());
                    (entry_type, offset, gen)
                })
                .collect();
            let startxref_pos = find_bytes(&pdf[data_start..], b"startxref\n").unwrap();
            let tail = std::str::from_utf8(&pdf[data_start + startxref_pos..]).unwrap();
            let startxref = tail.lines().nth(1).unwrap().parse::<u64>().unwrap();
            (dict, entries, startxref)
        }

        // 1 byte past the exact classic-file boundary: classic output would be
        // 10_000_000_000 bytes (> MAX_CLASSIC_XREF_OFFSET), so finish() switches
        // automatically to a PDF 1.5+ /Type /XRef stream.
        let pages_object_len =
            "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n".len() as u64;
        let classic_tail_len = "xref\n0 3\n".len() as u64
            + 3 * 20
            + "trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n9999999870\n%%EOF\n".len() as u64;
        let catalog_15_len =
            "3 0 obj\n<< /Type /Catalog /Version /1.5 /Pages 2 0 R >>\nendobj\n".len() as u64;
        let start_bytes = MAX_CLASSIC_XREF_OFFSET - pages_object_len - classic_tail_len + 1;
        let mut writer = PdfWriter::new(Vec::new(), None).unwrap();
        writer.bytes_written = start_bytes;
        let pdf = writer.finish().unwrap();

        assert!(find_bytes(&pdf, b"\nxref\n").is_none());
        assert!(find_bytes(&pdf, b"/Version /1.5").is_some());
        let (dict, entries, startxref) = parse_xref_stream_entries(&pdf);
        let expected_pages_offset = start_bytes;
        let expected_catalog_offset = start_bytes + pages_object_len;
        let expected_xref_offset = expected_catalog_offset + catalog_15_len;
        assert_eq!(
            dict,
            "<< /Type /XRef /Size 5 /W [1 8 2] /Root 3 0 R /Length 55 >>"
        );
        assert_eq!(startxref, expected_xref_offset);
        assert_eq!(
            entries,
            vec![
                (0, 0, 65535),
                (1, 15, 0),
                (1, expected_pages_offset, 0),
                (1, expected_catalog_offset, 0),
                (1, expected_xref_offset, 0),
            ]
        );

        // Provenance Info object is preserved in the XRef stream dictionary.
        let mut writer_with_info = PdfWriter::new(Vec::new(), Some("deadbeef")).unwrap();
        writer_with_info.bytes_written = MAX_CLASSIC_XREF_OFFSET + 100;
        let pdf_with_info = writer_with_info.finish().unwrap();
        let (info_dict, info_entries, _) = parse_xref_stream_entries(&pdf_with_info);
        assert!(info_dict.contains("/Type /XRef /Size 6 /W [1 8 2] /Root 4 0 R /Info 3 0 R"));
        assert_eq!(info_entries.len(), 6);

        // Recorded object offset past the safe-offset limit is refused before writing xref.
        let mut buffer = Vec::new();
        {
            let mut writer = PdfWriter::new(&mut buffer, None).unwrap();
            writer.offsets[1] = Some(MAX_SAFE_PDF_OFFSET + 1);
            let error = writer.finish().unwrap_err();
            let native = error.downcast_ref::<NativeError>().unwrap();
            assert_eq!(native.code, NativeErrorCode::TooLarge);
            assert!(native.message.contains("maximum safe PDF offset"));
        }
        assert!(find_bytes(&buffer, b"/Type /XRef").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn sparse_over_10_gib_xref_stream_pdf_opens_in_qpdf_and_pdfjs() {
        use std::{
            fs::{self, OpenOptions},
            io::{Seek, SeekFrom, Write},
            path::PathBuf,
            process::Command,
            time::{SystemTime, UNIX_EPOCH},
        };

        struct SparseGapWriter {
            file: fs::File,
        }

        impl Write for SparseGapWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.file.write(buf)
            }

            fn flush(&mut self) -> std::io::Result<()> {
                self.file.flush()
            }
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let pdf_path = std::env::temp_dir().join(format!(
            "evb-wide-xref-10gib-{}-{nonce}.pdf",
            std::process::id()
        ));
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&pdf_path)
            .unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(pdf_path.clone());
        let mut writer =
            PdfWriter::new(SparseGapWriter { file }, Some("0123456789abcdef")).unwrap();

        // Emit a valid zero-filled sparse stream object (obj 3) spanning >10 GiB
        // (10 * 2^30 = 10_737_418_240 bytes) using SeekFrom::Current so physical
        // disk usage stays tiny (~16 KiB).
        let filler_len: u64 = 10 * 1024 * 1024 * 1024 + 4096;
        let filler_object = writer.next_object;
        writer.next_object += 1;
        writer.record_object_offset(filler_object);
        let header = format!("{filler_object} 0 obj\n<< /Length {filler_len} >>\nstream\n");
        writer.write_all(header.as_bytes()).unwrap();
        writer
            .inner
            .file
            .seek(SeekFrom::Current(i64::try_from(filler_len).unwrap()))
            .unwrap();
        writer.bytes_written += filler_len;
        writer.write_all(b"\nendstream\nendobj\n").unwrap();

        // Add a real image page AFTER the 10 GiB offset.
        let page = ImagePage {
            width: 2,
            height: 2,
            dpi_x: 72,
            dpi_y: 72,
            color_space: "DeviceGray",
            icc_profile: None,
            payload: ImagePayload::RawFlate {
                data: deflate_bytes(&[0, 10, 20, 0, 30, 40]).unwrap(),
                decode_params: "<< /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns 2 >>"
                    .to_string(),
            },
        };
        writer.add_page(&page).unwrap();
        let finished = writer.finish().unwrap();
        drop(finished);

        let metadata = fs::metadata(&pdf_path).unwrap();
        assert!(metadata.len() > 10 * 1024 * 1024 * 1024);

        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let qpdf = [
            repo_root.join("resources/qpdf/darwin-arm64/bin/qpdf"),
            repo_root.join("resources/qpdf/linux-x64/bin/qpdf"),
            PathBuf::from("qpdf"),
        ]
        .into_iter()
        .find(|candidate| {
            Command::new(candidate)
                .arg("--version")
                .output()
                .is_ok_and(|out| out.status.success())
        });

        if let Some(qpdf_bin) = qpdf {
            let output = Command::new(&qpdf_bin)
                .args(["--check"])
                .arg(&pdf_path)
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                output.status.success(),
                "qpdf --check failed on >10 GiB XRef stream PDF:\nstdout:\n{stdout}\nstderr:\n{stderr}"
            );
            assert!(
                !stderr.contains("WARNING"),
                "qpdf --check emitted warnings:\n{stderr}"
            );
        }

        let pdfjs_entry = repo_root.join("node_modules/pdfjs-dist/legacy/build/pdf.mjs");
        if pdfjs_entry.is_file()
            && Command::new("node")
                .arg("--version")
                .output()
                .is_ok_and(|out| out.status.success())
        {
            let script = r#"
import { open, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [pdfjsPath, pdfPath] = process.argv.slice(1);
const { getDocument, PDFDataRangeTransport } = await import(pathToFileURL(pdfjsPath).href);
const MAX_REQUESTS = 32;
const MAX_REQUESTED_BYTES = 2 * 1024 * 1024;
const { size } = await stat(pdfPath);
const handle = await open(pdfPath, 'r');
let requestCount = 0;
let requestedBytes = 0;
let budgetExceededError = null;
let rejectBudget;
const budgetFailure = new Promise((_, reject) => { rejectBudget = reject; });
class FileRangeTransport extends PDFDataRangeTransport {
    constructor(length) { super(length, null); }
    requestDataRange(begin, end) {
        const clampedBegin = Math.max(0, begin);
        const clampedEnd = Math.min(this.length, end);
        const len = Math.max(0, clampedEnd - clampedBegin);
        requestCount += 1;
        requestedBytes += len;
        if (requestCount > MAX_REQUESTS || requestedBytes > MAX_REQUESTED_BYTES) {
            if (!budgetExceededError) {
                budgetExceededError = new Error(
                    `Range read budget exceeded (${requestCount} requests, ${requestedBytes} bytes; last range [${clampedBegin}, ${clampedEnd}))`,
                );
                rejectBudget(budgetExceededError);
            }
            return;
        }
        const buf = new Uint8Array(len);
        handle.read(buf, 0, len, clampedBegin).then(({ bytesRead }) => {
            this.onDataRange(clampedBegin, buf.subarray(0, bytesRead));
        }, (err) => {
            if (!budgetExceededError) {
                budgetExceededError = err;
                rejectBudget(err);
            }
        });
    }
}
const task = getDocument({
    range: new FileRangeTransport(size),
    rangeChunkSize: 65536,
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
});
task.promise.catch(() => undefined);
try {
    const doc = await Promise.race([task.promise, budgetFailure]);
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const meta = await doc.getMetadata();
    const stamp = meta.info?.Custom instanceof Map
        ? meta.info.Custom.get('EVBScanCleanup')
        : meta.info?.Custom?.EVBScanCleanup ?? null;
    console.log(JSON.stringify({
        size,
        numPages: doc.numPages,
        width: viewport.width,
        height: viewport.height,
        pdfVersion: meta.info?.PDFFormatVersion ?? null,
        stamp,
        requestCount,
        requestedBytes,
    }));
    if (
        doc.numPages !== 1
        || viewport.width !== 2
        || viewport.height !== 2
        || meta.info?.PDFFormatVersion !== '1.5'
        || stamp !== '0123456789abcdef'
        || requestCount > MAX_REQUESTS
        || requestedBytes > MAX_REQUESTED_BYTES
    ) {
        process.exitCode = 1;
    }
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
} finally {
    if (!budgetExceededError) {
        await task.destroy();
    }
    await handle.close();
}
if (budgetExceededError) {
    process.exit(1);
}
"#;
            let output = Command::new("node")
                .args(["--input-type=module", "-e", script])
                .arg(&pdfjs_entry)
                .arg(&pdf_path)
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                output.status.success(),
                "bundled pdfjs-dist failed on >10 GiB XRef stream PDF:\nstdout:\n{stdout}\nstderr:\n{stderr}"
            );
            assert!(
                stdout.contains(
                    r#""numPages":1,"width":2,"height":2,"pdfVersion":"1.5","stamp":"0123456789abcdef""#
                ),
                "unexpected pdfjs-dist verification output: {stdout}"
            );
        }
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
        let dictionary = image_mask_dictionary(mask.width, mask.height, payload);
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
