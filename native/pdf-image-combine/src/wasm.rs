use evb_native_support::{
    pdf_catalog::{
        BookmarkEntry, PageLabelRange, MAX_BOOKMARK_DEPTH, MAX_BOOKMARK_ITEMS,
        MAX_PAGE_LABEL_RANGES,
    },
    wasm_request_allocation::{WasmRequestAllocation, WASM_REQUEST_ALLOCATION_ABI_VERSION},
    NativeError, NativeErrorCode, NativeErrorEnvelope,
};
use std::{cell::RefCell, slice, str};

use crate::{
    is_output_limit_exceeded, write_pdf, FramePolicy, ImageCompression, ImageProcessing, ImageSpec,
    InputSource, JpegSizeGuardrail, PageSpec, PdfBuildOptions, PdfPageSize, PdfPageSpec, Result,
    PDF_COMBINE_MAX_OUTPUT_BYTES,
};

const REQUEST_MAGIC: &[u8; 4] = b"EPIC";
const REQUEST_VERSION_V1: u32 = 1;
const REQUEST_VERSION_V2: u32 = 2;
const REQUEST_VERSION_V3: u32 = 3;
const REQUEST_VERSION_V4: u32 = 4;
const REQUEST_VERSION_V5: u32 = REQUEST_VERSION_V4 + 1;
const PAGE_KIND_IMAGE: u32 = 1;
const PAGE_KIND_MASK: u32 = 2;
const PAGE_KIND_LAYERED: u32 = 3;
const PAGE_KIND_LAYERED_COLOR: u32 = 4;
const MAX_REQUEST_BYTES: usize = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = PDF_COMBINE_MAX_OUTPUT_BYTES as usize;
const OPTIONAL_CATALOG_VALUE: u32 = u32::MAX;
const MAX_CATALOG_STRING_BYTES: usize = 64 * 1024;
const MAX_BOOKMARK_TITLE_BYTES: usize = 4 * 1024;

thread_local! {
    static REQUEST_ALLOCATION: WasmRequestAllocation = const { WasmRequestAllocation::new(MAX_REQUEST_BYTES) };
    static LAST_OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

struct RequestHeader {
    options: PdfBuildOptions,
    item_count: usize,
}

#[no_mangle]
pub extern "C" fn evb_wasm_request_allocation_abi_version() -> u32 {
    WASM_REQUEST_ALLOCATION_ABI_VERSION
}

#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_alloc(len: usize) -> *mut u8 {
    REQUEST_ALLOCATION.with(|allocation| allocation.allocate(len))
}

#[no_mangle]
pub unsafe extern "C" fn evb_pdf_image_combine_free(pointer: *mut u8, byte_length: usize) {
    REQUEST_ALLOCATION.with(|allocation| allocation.free(pointer, byte_length));
}

#[no_mangle]
pub unsafe extern "C" fn evb_pdf_image_combine_build_pdf(
    request_pointer: *const u8,
    request_len: usize,
) -> i32 {
    clear_last_result();
    if request_pointer.is_null() || request_len == 0 || request_len > MAX_REQUEST_BYTES {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::TooLarge,
            message: "Image-combine WASM request exceeds the admission ceiling".to_string(),
        });
        return -1;
    }
    if !REQUEST_ALLOCATION.with(|allocation| allocation.matches(request_pointer, request_len)) {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::InvalidRequest,
            message: "Image-combine WASM request does not match the live allocation".to_string(),
        });
        return -1;
    }
    let request = slice::from_raw_parts(request_pointer, request_len);
    match std::panic::catch_unwind(|| build_pdf_from_request(request)) {
        Ok(Ok(output)) if output.len() <= MAX_OUTPUT_BYTES => {
            LAST_OUTPUT.with(|slot| *slot.borrow_mut() = output);
            0
        }
        Ok(Ok(_)) => {
            set_error_envelope(output_ceiling_error());
            -1
        }
        Ok(Err(error)) => {
            set_error_envelope(NativeErrorEnvelope::from_error(error.as_ref()));
            -1
        }
        Err(_) => {
            set_error_envelope(NativeErrorEnvelope {
                code: NativeErrorCode::Panic,
                message: "Native image combine panicked".to_string(),
            });
            -1
        }
    }
}

fn set_error_envelope(envelope: NativeErrorEnvelope) {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = envelope.to_json().into_bytes());
}
fn output_ceiling_error() -> NativeErrorEnvelope {
    NativeErrorEnvelope {
        code: NativeErrorCode::TooLarge,
        message: "Image-combine WASM output exceeds the admission ceiling".to_string(),
    }
}
#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_output_ptr() -> *const u8 {
    LAST_OUTPUT.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_output_len() -> usize {
    LAST_OUTPUT.with(|slot| slot.borrow().len())
}

#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_image_combine_error_len() -> usize {
    LAST_ERROR.with(|slot| slot.borrow().len())
}

fn clear_last_result() {
    LAST_OUTPUT.with(|slot| *slot.borrow_mut() = Vec::new());
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
}

fn build_pdf_from_request(request: &[u8]) -> Result<Vec<u8>> {
    build_pdf_from_request_with_limit(request, MAX_OUTPUT_BYTES as u64)
}

fn build_pdf_from_request_with_limit(request: &[u8], max_output_bytes: u64) -> Result<Vec<u8>> {
    let (page_specs, mut options) = parse_request(request)?;
    options.max_output_bytes = max_output_bytes;
    let output_capacity = usize::try_from(max_output_bytes)
        .unwrap_or(MAX_OUTPUT_BYTES)
        .min(MAX_OUTPUT_BYTES);
    write_pdf(
        Vec::with_capacity(output_capacity),
        page_specs,
        &options,
        |_| {},
    )
    .map_err(|error| {
        let is_typed_output_limit =
            error
                .downcast_ref::<NativeError>()
                .is_some_and(|native_error| {
                    native_error.code == NativeErrorCode::TooLarge
                        && native_error.message.contains("Combined PDF output exceeds")
                });
        if is_output_limit_exceeded(error.as_ref()) || is_typed_output_limit {
            Box::new(NativeError::new(
                NativeErrorCode::TooLarge,
                "Image-combine WASM output exceeds the admission ceiling",
            )) as Box<dyn std::error::Error>
        } else {
            error
        }
    })
}

fn parse_request(request: &[u8]) -> Result<(Vec<PdfPageSpec<'_>>, PdfBuildOptions)> {
    let mut offset = 0usize;
    if take_bytes(request, &mut offset, REQUEST_MAGIC.len())? != REQUEST_MAGIC {
        return Err("Invalid image-combine WASM request magic".into());
    }
    let version = read_u32_le(request, &mut offset)?;
    if !(REQUEST_VERSION_V1..=REQUEST_VERSION_V5).contains(&version) {
        return Err(format!("Unsupported image-combine WASM request version: {version}").into());
    }

    let mut header = parse_request_header(request, &mut offset)?;
    if version == REQUEST_VERSION_V5 {
        let (outlines, page_labels) = parse_catalog_block(request, &mut offset)?;
        header.options.outlines = outlines;
        header.options.page_labels = page_labels;
    }
    let page_specs = if version <= REQUEST_VERSION_V2 {
        parse_v1_v2_page_specs(request, &mut offset, header.item_count, version)?
    } else {
        parse_v3_v5_page_specs(request, &mut offset, header.item_count, version)?
    };
    if offset != request.len() {
        return Err("Trailing bytes in image-combine WASM request".into());
    }
    Ok((page_specs, header.options))
}

fn parse_request_header(request: &[u8], offset: &mut usize) -> Result<RequestHeader> {
    let default_dpi = match read_u32_le(request, offset)? {
        0 => None,
        value => Some(value),
    };
    let max_pages = read_usize_le(request, offset, "max_pages")?;
    let max_pixels = u64::from(read_u32_le(request, offset)?);
    let options = PdfBuildOptions {
        default_dpi,
        max_pages,
        max_pixels,
        max_bilevel_pixels: max_pixels,
        max_output_bytes: MAX_OUTPUT_BYTES as u64,
        max_tiff_frames: read_usize_le(request, offset, "max_tiff_frames")?,
        provenance_stamp_hex: None,
        worker_threads: 1,
        enable_shared_symbol_encoding: false,
        outlines: Vec::new(),
        page_labels: Vec::new(),
    };
    let item_count = read_usize_le(request, offset, "item_count")?;
    if item_count == 0 {
        return Err("At least one image input is required".into());
    }
    Ok(RequestHeader {
        options,
        item_count,
    })
}

// EPIC v5 places this block after the common request header and before the
// page specs. Counts and string lengths are little-endian u32 values. A
// missing optional string uses u32::MAX, and a missing page-y ratio uses a
// quiet NaN. V5 page specs retain the v4 fields and add rotation_degrees as a
// u32 immediately after ppi_cap.
fn parse_catalog_block(
    request: &[u8],
    offset: &mut usize,
) -> Result<(Vec<BookmarkEntry>, Vec<PageLabelRange>)> {
    let outline_count = read_bounded_count(request, offset, "outline count", MAX_BOOKMARK_ITEMS)?;
    let page_label_count =
        read_bounded_count(request, offset, "page label count", MAX_PAGE_LABEL_RANGES)?;
    let mut bookmark_total = 0usize;
    let mut outlines = Vec::with_capacity(outline_count);
    for _ in 0..outline_count {
        outlines.push(read_bookmark_entry(
            request,
            offset,
            0,
            &mut bookmark_total,
        )?);
    }

    let mut page_labels = Vec::with_capacity(page_label_count);
    for _ in 0..page_label_count {
        page_labels.push(read_page_label_range(request, offset)?);
    }
    Ok((outlines, page_labels))
}

fn read_bookmark_entry(
    request: &[u8],
    offset: &mut usize,
    depth: usize,
    total: &mut usize,
) -> Result<BookmarkEntry> {
    if depth > MAX_BOOKMARK_DEPTH {
        return Err("Image-combine WASM bookmark nesting exceeds the admission limit".into());
    }
    if *total >= MAX_BOOKMARK_ITEMS {
        return Err("Image-combine WASM bookmark count exceeds the admission limit".into());
    }
    *total += 1;

    let title = read_catalog_string(
        request,
        offset,
        "bookmark title",
        false,
        MAX_BOOKMARK_TITLE_BYTES,
    )?
    .ok_or("Missing image-combine WASM bookmark title")?;
    let page_index = match read_u32_le(request, offset)? {
        OPTIONAL_CATALOG_VALUE => None,
        value => Some(value),
    };
    let page_y_ratio = match read_f64_le(request, offset)? {
        value if value.is_nan() => None,
        value if value.is_finite() => Some(value),
        _ => return Err("Invalid image-combine WASM bookmark y ratio".into()),
    };
    let named_dest = read_catalog_string(
        request,
        offset,
        "bookmark named destination",
        true,
        MAX_CATALOG_STRING_BYTES,
    )?;
    let bold = read_bool(request, offset, "bookmark bold flag")?;
    let italic = read_bool(request, offset, "bookmark italic flag")?;
    let color = read_catalog_string(
        request,
        offset,
        "bookmark color",
        true,
        MAX_CATALOG_STRING_BYTES,
    )?;
    let child_count =
        read_bounded_count(request, offset, "bookmark child count", MAX_BOOKMARK_ITEMS)?;
    if child_count > MAX_BOOKMARK_ITEMS.saturating_sub(*total) {
        return Err("Image-combine WASM bookmark count exceeds the admission limit".into());
    }
    let mut items = Vec::with_capacity(child_count);
    for _ in 0..child_count {
        items.push(read_bookmark_entry(request, offset, depth + 1, total)?);
    }

    Ok(BookmarkEntry {
        title,
        page_index,
        page_y_ratio,
        named_dest,
        bold,
        italic,
        color,
        items,
    })
}

fn read_page_label_range(request: &[u8], offset: &mut usize) -> Result<PageLabelRange> {
    let start_page = read_u32_le(request, offset)?;
    let style = read_catalog_string(
        request,
        offset,
        "page label style",
        true,
        MAX_CATALOG_STRING_BYTES,
    )?;
    let prefix = read_catalog_string(
        request,
        offset,
        "page label prefix",
        false,
        MAX_CATALOG_STRING_BYTES,
    )?
    .ok_or("Missing image-combine WASM page label prefix")?;
    let start_number = read_u32_le(request, offset)?;
    Ok(PageLabelRange {
        start_page,
        style,
        prefix,
        start_number,
    })
}

fn read_catalog_string(
    request: &[u8],
    offset: &mut usize,
    label: &str,
    optional: bool,
    max_bytes: usize,
) -> Result<Option<String>> {
    let length = read_u32_le(request, offset)?;
    if optional && length == OPTIONAL_CATALOG_VALUE {
        return Ok(None);
    }
    let length =
        usize::try_from(length).map_err(|_| format!("Invalid image-combine WASM {label}"))?;
    if length > max_bytes {
        return Err(format!("Image-combine WASM {label} exceeds the admission limit").into());
    }
    let value = str::from_utf8(take_bytes(request, offset, length)?)?.to_owned();
    Ok(Some(value))
}

fn read_bool(request: &[u8], offset: &mut usize, label: &str) -> Result<bool> {
    match read_u32_le(request, offset)? {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(format!("Invalid image-combine WASM {label}").into()),
    }
}

fn read_bounded_count(
    request: &[u8],
    offset: &mut usize,
    label: &str,
    max: usize,
) -> Result<usize> {
    let count = read_usize_le(request, offset, label)?;
    if count > max {
        return Err(format!("Image-combine WASM {label} exceeds the admission limit").into());
    }
    Ok(count)
}

fn parse_v1_v2_page_specs<'a>(
    request: &'a [u8],
    offset: &mut usize,
    input_count: usize,
    version: u32,
) -> Result<Vec<PdfPageSpec<'a>>> {
    let mut page_specs = Vec::with_capacity(input_count);
    for _ in 0..input_count {
        let mut compression = ImageCompression::Auto;
        let mut processing = ImageProcessing::None;
        let mut page_size = None;
        if version == REQUEST_VERSION_V2 {
            let target_ppi = read_u16_range(request, offset, "target_ppi", 0, 600)?;
            let max_scale = read_u8_range(request, offset, "max_scale", 1, 4)?;
            let dark_speckle_area = read_u16_range(request, offset, "dark_speckle_area", 0, 256)?;
            let jpeg_quality = read_u8_range(request, offset, "jpeg_quality", 0, 100)?;
            let width_points = read_f64_le(request, offset)?;
            let height_points = read_f64_le(request, offset)?;
            if width_points != 0.0 || height_points != 0.0 {
                if !width_points.is_finite()
                    || !height_points.is_finite()
                    || width_points <= 0.0
                    || height_points <= 0.0
                {
                    return Err("Invalid image-combine WASM page size".into());
                }
                page_size = Some(PdfPageSize {
                    width_points,
                    height_points,
                });
            }
            if jpeg_quality > 0 {
                compression = ImageCompression::Jpeg {
                    quality: jpeg_quality,
                };
            }
            if target_ppi > 0 || dark_speckle_area > 0 {
                if jpeg_quality == 0 {
                    return Err("WASM image preprocessing requires JPEG quality".into());
                }
                let _ = max_scale;
                let _ = dark_speckle_area;
                processing = ImageProcessing::DownscaleToPpi {
                    ppi_cap: target_ppi.max(1),
                };
            }
        }
        page_specs.push(PageSpec::Image {
            page_size,
            placement: None,
            rotation_degrees: 0,
            image: ImageSpec {
                source: read_input_source(request, offset)?,
                compression,
                processing,
                size_guardrail: None,
            },
            frames: FramePolicy::All,
        });
    }
    Ok(page_specs)
}

fn parse_v3_v5_page_specs<'a>(
    request: &'a [u8],
    offset: &mut usize,
    page_count: usize,
    version: u32,
) -> Result<Vec<PdfPageSpec<'a>>> {
    let mut page_specs = Vec::with_capacity(page_count);
    for page_index in 0..page_count {
        let kind = read_u32_le(request, offset)?;
        let page_size = read_page_size(request, offset)?;
        let jpeg_quality = read_u8_range(request, offset, "jpeg_quality", 0, 100)?;
        let ppi_cap = read_u16_range(request, offset, "ppi_cap", 0, 1200)?;
        if version == REQUEST_VERSION_V3 {
            let _ = read_u32_le(request, offset)?;
        }
        let rotation_degrees = if version == REQUEST_VERSION_V5 {
            read_rotation_degrees(request, offset)?
        } else {
            0
        };
        let compression = if jpeg_quality > 0 {
            ImageCompression::Jpeg {
                quality: jpeg_quality,
            }
        } else {
            ImageCompression::Auto
        };
        let processing = if ppi_cap > 0 {
            ImageProcessing::DownscaleToPpi { ppi_cap }
        } else {
            ImageProcessing::None
        };

        page_specs.push(match kind {
            PAGE_KIND_IMAGE => PageSpec::Image {
                page_size: Some(page_size),
                placement: None,
                rotation_degrees,
                image: ImageSpec {
                    source: read_input_source(request, offset)?,
                    compression,
                    processing,
                    size_guardrail: (ppi_cap > 0).then_some(JpegSizeGuardrail {
                        page: page_index + 1,
                        log_json_progress: false,
                    }),
                },
                frames: FramePolicy::ExactlyOne,
            },
            PAGE_KIND_MASK => PageSpec::Mask {
                page_size,
                foreground_mask: read_input_source(request, offset)?,
            },
            PAGE_KIND_LAYERED => PageSpec::Layered {
                page_size,
                background: ImageSpec {
                    source: read_input_source(request, offset)?,
                    compression,
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                foreground_mask: read_input_source(request, offset)?,
                foreground_color: None,
            },
            PAGE_KIND_LAYERED_COLOR => PageSpec::Layered {
                page_size,
                background: ImageSpec {
                    source: read_input_source(request, offset)?,
                    compression,
                    processing: ImageProcessing::None,
                    size_guardrail: None,
                },
                foreground_mask: read_input_source(request, offset)?,
                foreground_color: if version == REQUEST_VERSION_V3 {
                    let _ = read_input_source(request, offset)?;
                    None
                } else {
                    Some([
                        read_u8_range(request, offset, "foreground_red", 0, 255)?,
                        read_u8_range(request, offset, "foreground_green", 0, 255)?,
                        read_u8_range(request, offset, "foreground_blue", 0, 255)?,
                    ])
                },
            },
            _ => return Err(format!("Unsupported image-combine WASM page kind: {kind}").into()),
        });
    }
    Ok(page_specs)
}

fn read_page_size(request: &[u8], offset: &mut usize) -> Result<PdfPageSize> {
    let width_points = read_f64_le(request, offset)?;
    let height_points = read_f64_le(request, offset)?;
    if !width_points.is_finite()
        || !height_points.is_finite()
        || width_points <= 0.0
        || height_points <= 0.0
    {
        return Err("Invalid image-combine WASM page size".into());
    }
    Ok(PdfPageSize {
        width_points,
        height_points,
    })
}

fn read_input_source<'a>(request: &'a [u8], offset: &mut usize) -> Result<InputSource<'a>> {
    let name_len = read_usize_le(request, offset, "name_len")?;
    let data_len = read_usize_le(request, offset, "data_len")?;
    let file_name = str::from_utf8(take_bytes(request, offset, name_len)?)?;
    let data = take_bytes(request, offset, data_len)?;
    Ok(InputSource::Bytes { file_name, data })
}

fn read_usize_le(request: &[u8], offset: &mut usize, label: &str) -> Result<usize> {
    usize::try_from(read_u32_le(request, offset)?)
        .map_err(|_| format!("Invalid image-combine WASM {label}").into())
}

fn read_u16_range(
    request: &[u8],
    offset: &mut usize,
    label: &str,
    min_value: u16,
    max_value: u16,
) -> Result<u16> {
    let value = read_u32_le(request, offset)?;
    let parsed = u16::try_from(value).map_err(|_| format!("Invalid image-combine WASM {label}"))?;
    if parsed < min_value || parsed > max_value {
        return Err(format!("Invalid image-combine WASM {label}").into());
    }
    Ok(parsed)
}

fn read_u8_range(
    request: &[u8],
    offset: &mut usize,
    label: &str,
    min_value: u8,
    max_value: u8,
) -> Result<u8> {
    let value = read_u32_le(request, offset)?;
    let parsed = u8::try_from(value).map_err(|_| format!("Invalid image-combine WASM {label}"))?;
    if parsed < min_value || parsed > max_value {
        return Err(format!("Invalid image-combine WASM {label}").into());
    }
    Ok(parsed)
}

fn read_rotation_degrees(request: &[u8], offset: &mut usize) -> Result<u16> {
    let value = read_u32_le(request, offset)?;
    match value {
        0 | 90 | 180 | 270 => Ok(value as u16),
        _ => Err("Invalid image-combine WASM rotation_degrees".into()),
    }
}

fn read_u32_le(request: &[u8], offset: &mut usize) -> Result<u32> {
    let bytes = take_bytes(request, offset, 4)?;
    Ok(u32::from_le_bytes(bytes.try_into()?))
}

fn read_f64_le(request: &[u8], offset: &mut usize) -> Result<f64> {
    let bytes = take_bytes(request, offset, 8)?;
    Ok(f64::from_le_bytes(bytes.try_into()?))
}

fn take_bytes<'a>(request: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(len)
        .ok_or("Invalid image-combine WASM request length")?;
    let bytes = request
        .get(*offset..end)
        .ok_or("Truncated image-combine WASM request")?;
    *offset = end;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PPM: &[u8] = b"P6\n1 1\n255\n\x10\x20\x30";
    const PBM: &[u8] = b"P4\n8 1\n\x80";

    #[test]
    fn allocator_requires_one_exact_live_pointer_and_length() {
        assert!(evb_pdf_image_combine_alloc(0).is_null());
        assert!(evb_pdf_image_combine_alloc(MAX_REQUEST_BYTES + 1).is_null());
        let pointer = evb_pdf_image_combine_alloc(17);
        assert!(!pointer.is_null());
        assert!(evb_pdf_image_combine_alloc(1).is_null());

        let status = unsafe { evb_pdf_image_combine_build_pdf(pointer, 16) };
        assert_eq!(status, -1);
        let envelope = LAST_ERROR.with(|slot| String::from_utf8(slot.borrow().clone()).unwrap());
        assert_eq!(
            envelope,
            r#"{"code":"invalid-request","message":"Image-combine WASM request does not match the live allocation"}"#
        );

        unsafe { evb_pdf_image_combine_free(pointer, 16) };
        assert!(evb_pdf_image_combine_alloc(1).is_null());
        unsafe { evb_pdf_image_combine_free(pointer, 17) };
        let next_pointer = evb_pdf_image_combine_alloc(1);
        assert!(!next_pointer.is_null());
        unsafe { evb_pdf_image_combine_free(next_pointer, 1) };
    }

    #[test]
    fn framing_offsets_reject_checked_arithmetic_overflow() {
        let mut offset = usize::MAX;
        let error = take_bytes(&[], &mut offset, 1).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid image-combine WASM request length"
        );
    }

    #[test]
    fn writer_stops_at_the_output_cap_with_a_typed_error() {
        let request = image_request(REQUEST_VERSION_V1, false);
        let error = build_pdf_from_request_with_limit(&request, 64).unwrap_err();
        let native_error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        assert_eq!(
            native_error.message,
            "Image-combine WASM output exceeds the admission ceiling"
        );
    }

    #[test]
    fn wasm_uses_the_shared_sixteen_mib_output_cap() {
        assert_eq!(MAX_OUTPUT_BYTES, 16 * 1024 * 1024);
    }

    #[test]
    fn clearing_wasm_output_does_not_retain_capacity_above_the_shared_cap() {
        LAST_OUTPUT.with(|slot| {
            *slot.borrow_mut() = Vec::with_capacity(MAX_OUTPUT_BYTES.saturating_mul(2));
        });

        clear_last_result();

        LAST_OUTPUT.with(|slot| {
            assert!(slot.borrow().capacity() <= MAX_OUTPUT_BYTES);
        });
    }

    #[test]
    fn versions_one_through_five_map_to_page_specs_and_build() {
        let v1 = image_request(REQUEST_VERSION_V1, false);
        let (specs, options) = parse_request(&v1).unwrap();
        assert!(matches!(
            specs.as_slice(),
            [PageSpec::Image {
                frames: FramePolicy::All,
                ..
            }]
        ));
        assert!(write_pdf(Vec::new(), specs, &options, |_| {})
            .unwrap()
            .starts_with(b"%PDF-1.4"));

        let v2 = image_request(REQUEST_VERSION_V2, true);
        let (specs, options) = parse_request(&v2).unwrap();
        assert!(write_pdf(Vec::new(), specs, &options, |_| {})
            .unwrap()
            .windows(b"/DCTDecode".len())
            .any(|window| window == b"/DCTDecode"));

        let v3 = layered_color_request(REQUEST_VERSION_V3);
        let (specs, options) = parse_request(&v3).unwrap();
        assert!(matches!(
            specs.as_slice(),
            [PageSpec::Layered {
                foreground_color: None,
                ..
            }]
        ));
        assert!(write_pdf(Vec::new(), specs, &options, |_| {}).is_ok());

        let v4 = layered_color_request(REQUEST_VERSION_V4);
        let (specs, options) = parse_request(&v4).unwrap();
        assert!(matches!(
            specs.as_slice(),
            [PageSpec::Layered {
                foreground_color: Some([128, 16, 8]),
                ..
            }]
        ));
        let pdf = write_pdf(Vec::new(), specs, &options, |_| {}).unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("0.5020 0.0627 0.0314 rg"));

        let v5 = v5_image_request();
        let (specs, options) = parse_request(&v5).unwrap();
        assert_eq!(options.outlines.len(), 1);
        assert_eq!(options.page_labels.len(), 1);
        assert!(matches!(
            specs.as_slice(),
            [PageSpec::Image {
                rotation_degrees: 90,
                frames: FramePolicy::ExactlyOne,
                ..
            }]
        ));
        let pdf = write_pdf(Vec::new(), specs, &options, |_| {}).unwrap();
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/PageMode /UseOutlines"));
        assert!(text.contains("/PageLabels"));
        assert!(text.contains("/Rotate 90"));
    }

    #[test]
    fn preserves_parser_errors_and_request_ceiling_envelope() {
        let mut unsupported = request_header(99, 1);
        push_input(&mut unsupported, "page.ppm", PPM);
        assert_eq!(
            parse_request(&unsupported).err().unwrap().to_string(),
            "Unsupported image-combine WASM request version: 99"
        );

        let mut trailing = image_request(REQUEST_VERSION_V1, false);
        trailing.push(0);
        assert_eq!(
            parse_request(&trailing).err().unwrap().to_string(),
            "Trailing bytes in image-combine WASM request"
        );
        let mut truncated = image_request(REQUEST_VERSION_V1, false);
        truncated.pop();
        assert_eq!(
            parse_request(&truncated).err().unwrap().to_string(),
            "Truncated image-combine WASM request"
        );

        let dangling = std::ptr::NonNull::<u8>::dangling().as_ptr();
        let result = unsafe { evb_pdf_image_combine_build_pdf(dangling, MAX_REQUEST_BYTES + 1) };
        assert_eq!(result, -1);
        let envelope = LAST_ERROR.with(|slot| String::from_utf8(slot.borrow().clone()).unwrap());
        assert_eq!(
            envelope,
            r#"{"code":"too-large","message":"Image-combine WASM request exceeds the admission ceiling"}"#
        );
        assert_eq!(
            output_ceiling_error().to_json(),
            r#"{"code":"too-large","message":"Image-combine WASM output exceeds the admission ceiling"}"#
        );
    }

    #[test]
    fn browser_wasm_request_rejects_fake_jpeg_scan_data() {
        let mut request = request_header(REQUEST_VERSION_V1, 1);
        push_input(
            &mut request,
            "fake.jpg",
            &[
                0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8,
                1, 1, 0, 0, 0x3f, 0, 0x11, 0xff, 0xd9,
            ],
        );

        let error = build_pdf_from_request_with_limit(&request, u64::MAX).unwrap_err();
        let envelope = NativeErrorEnvelope::from_error(error.as_ref());

        assert_eq!(envelope.code, NativeErrorCode::NativeFailure);
        assert!(envelope.message.contains("not decodable"));
    }

    fn image_request(version: u32, processed: bool) -> Vec<u8> {
        let mut request = request_header(version, 1);
        if version == REQUEST_VERSION_V2 {
            push_u32(&mut request, if processed { 300 } else { 0 });
            push_u32(&mut request, 1);
            push_u32(&mut request, 0);
            push_u32(&mut request, if processed { 85 } else { 0 });
            request.extend_from_slice(&72f64.to_le_bytes());
            request.extend_from_slice(&72f64.to_le_bytes());
        }
        push_input(&mut request, "page.ppm", PPM);
        request
    }

    fn v5_image_request() -> Vec<u8> {
        let mut request = request_header(REQUEST_VERSION_V5, 1);
        push_u32(&mut request, 1);
        push_u32(&mut request, 1);
        push_bookmark(
            &mut request,
            "Chapter 1",
            Some(0),
            Some(0.25),
            None,
            true,
            false,
            Some("#336699"),
            &[],
        );
        push_u32(&mut request, 0);
        push_optional_string(&mut request, Some("D"));
        push_string(&mut request, "Page ");
        push_u32(&mut request, 1);

        push_u32(&mut request, PAGE_KIND_IMAGE);
        request.extend_from_slice(&72f64.to_le_bytes());
        request.extend_from_slice(&36f64.to_le_bytes());
        push_u32(&mut request, 0);
        push_u32(&mut request, 0);
        push_u32(&mut request, 90);
        push_input(&mut request, "page.ppm", PPM);
        request
    }

    fn layered_color_request(version: u32) -> Vec<u8> {
        let mut request = request_header(version, 1);
        push_u32(&mut request, PAGE_KIND_LAYERED_COLOR);
        request.extend_from_slice(&72f64.to_le_bytes());
        request.extend_from_slice(&72f64.to_le_bytes());
        push_u32(&mut request, 0);
        push_u32(&mut request, 0);
        if version == REQUEST_VERSION_V3 {
            push_u32(&mut request, 0xfeed_beef);
        }
        push_input(&mut request, "background.ppm", PPM);
        push_input(&mut request, "mask.pbm", PBM);
        if version == REQUEST_VERSION_V3 {
            push_input(&mut request, "legacy.pbm", b"discarded");
        } else {
            push_u32(&mut request, 128);
            push_u32(&mut request, 16);
            push_u32(&mut request, 8);
        }
        request
    }

    fn request_header(version: u32, count: u32) -> Vec<u8> {
        let mut request = REQUEST_MAGIC.to_vec();
        for value in [version, 72, 10, 1_000_000, 10, count] {
            push_u32(&mut request, value);
        }
        request
    }

    fn push_input(request: &mut Vec<u8>, name: &str, data: &[u8]) {
        push_u32(request, name.len() as u32);
        push_u32(request, data.len() as u32);
        request.extend_from_slice(name.as_bytes());
        request.extend_from_slice(data);
    }

    fn push_bookmark(
        request: &mut Vec<u8>,
        title: &str,
        page_index: Option<u32>,
        page_y_ratio: Option<f64>,
        named_dest: Option<&str>,
        bold: bool,
        italic: bool,
        color: Option<&str>,
        children: &[BookmarkEntry],
    ) {
        push_string(request, title);
        push_u32(request, page_index.unwrap_or(u32::MAX));
        request.extend_from_slice(&page_y_ratio.unwrap_or(f64::NAN).to_le_bytes());
        push_optional_string(request, named_dest);
        push_u32(request, u32::from(bold));
        push_u32(request, u32::from(italic));
        push_optional_string(request, color);
        push_u32(request, children.len() as u32);
        for child in children {
            push_bookmark(
                request,
                &child.title,
                child.page_index,
                child.page_y_ratio,
                child.named_dest.as_deref(),
                child.bold,
                child.italic,
                child.color.as_deref(),
                &child.items,
            );
        }
    }

    fn push_string(request: &mut Vec<u8>, value: &str) {
        push_u32(request, value.len() as u32);
        request.extend_from_slice(value.as_bytes());
    }

    fn push_optional_string(request: &mut Vec<u8>, value: Option<&str>) {
        match value {
            Some(value) => push_string(request, value),
            None => push_u32(request, OPTIONAL_CATALOG_VALUE),
        }
    }

    fn push_u32(request: &mut Vec<u8>, value: u32) {
        request.extend_from_slice(&value.to_le_bytes());
    }
}
