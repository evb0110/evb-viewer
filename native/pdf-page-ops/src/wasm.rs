use evb_native_support::{
    wasm_request_allocation::{WasmRequestAllocation, WASM_REQUEST_ALLOCATION_ABI_VERSION},
    NativeErrorCode, NativeErrorEnvelope,
};
use std::{cell::RefCell, slice};

use crate::pdf_conformance_facts;
use crate::{
    append_native_mutations_to_bytes, crop_browser_pdf_bytes, decrypt_browser_pdf_bytes,
    delete_browser_pdf_pages, extract_browser_pdf_pages, get_browser_page_geometry_from_bytes,
    insert_browser_pdf_pages, load_browser_pdf, read_native_mutations_bytes,
    remove_crop_browser_pdf_bytes, reorder_browser_pdf_pages, rotate_browser_pdf_bytes,
    serialize_annotation_parse, CropMargins, NativeMutationBytesResult, PageGeometry,
    PageMutationBytes, PdfRect, Result, PAGE_OP_WASM_MAX_OUTPUT_BYTES,
    PAGE_OP_WASM_MUTATION_HEADER_BYTES,
};
use crate::{
    build_browser_page_subset_pdf, read_pdf_combine_catalog, save_document_to_bytes, set_bookmarks,
    set_page_labels, BookmarkEntry, BookmarksMutation, PageCloneSource, PageLabelRange,
    PageLabelsMutation,
};

const REQUEST_MAGIC: &[u8; 4] = b"EPPO";
const REQUEST_VERSION: u32 = 2;

const OP_DELETE_PAGES: u32 = 1;
const OP_EXTRACT_PAGES: u32 = 2;
const OP_REORDER_PAGES: u32 = 3;
const OP_INSERT_PAGES: u32 = 4;
const OP_ROTATE: u32 = 5;
const OP_CROP: u32 = 6;
const OP_REMOVE_CROP: u32 = 7;
const OP_GET_PAGE_GEOMETRY: u32 = 8;
// Parsing must stay above the decrypt operation reserved by ticket #171. The
// request frame is version 2 because decrypt carries a trailing password; op 10
// simply sends a zero-length password.
const OP_DECRYPT: u32 = 9;
const OP_PARSE_ANNOTATIONS: u32 = 10;
const OP_SAVE_MUTATIONS: u32 = 11;
const OP_READ_CATALOG: u32 = 12;
const OP_CONFORMANCE: u32 = 13;
const OP_MERGE_PAGES: u32 = 14;
const REQUEST_VERSION_DOCUMENT_LIST: u32 = 3;

const MAX_WASM_PASSWORD_BYTES: usize = 4 * 1024;
const MAX_DOCUMENT_LIST_PAGES: usize = 500;

const RESPONSE_MUTATION: u32 = 1;
const RESPONSE_GEOMETRY: u32 = 2;
const RESPONSE_ANNOTATION_PARSE: u32 = 3;
const RESPONSE_NATIVE_MUTATIONS: u32 = 4;
const RESPONSE_JSON: u32 = 5;
const ANNOTATION_PARSE_RESPONSE_HEADER_BYTES: usize = 8;
const NATIVE_MUTATION_RESPONSE_HEADER_BYTES: usize = 20;
const MAX_REQUEST_BYTES: usize = 256 * 1024 * 1024;
const DEFAULT_WASM_MUTATION_MODIFIED_AT: &str = "D:19700101000000Z";

thread_local! {
    static REQUEST_ALLOCATION: WasmRequestAllocation = const { WasmRequestAllocation::new(MAX_REQUEST_BYTES) };
    static LAST_OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

struct ParsedRequest<'a> {
    operation: u32,
    pages: Vec<u32>,
    page_number: u32,
    after_page: u32,
    angle: i64,
    margins: CropMargins,
    data: &'a [u8],
    insertion_data: &'a [u8],
    password: &'a [u8],
}

#[no_mangle]
pub extern "C" fn evb_wasm_request_allocation_abi_version() -> u32 {
    WASM_REQUEST_ALLOCATION_ABI_VERSION
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_alloc(len: usize) -> *mut u8 {
    REQUEST_ALLOCATION.with(|allocation| allocation.allocate(len))
}

#[no_mangle]
pub unsafe extern "C" fn evb_pdf_page_ops_free(pointer: *mut u8, byte_length: usize) {
    REQUEST_ALLOCATION.with(|allocation| allocation.free(pointer, byte_length));
}

#[no_mangle]
pub unsafe extern "C" fn evb_pdf_page_ops_run(
    request_pointer: *const u8,
    request_len: usize,
) -> i32 {
    clear_last_result();
    if request_pointer.is_null() || request_len == 0 || request_len > MAX_REQUEST_BYTES {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::TooLarge,
            message: "Page-op WASM request exceeds the admission ceiling".to_string(),
        });
        return -1;
    }
    if !REQUEST_ALLOCATION.with(|allocation| allocation.matches(request_pointer, request_len)) {
        set_error_envelope(NativeErrorEnvelope {
            code: NativeErrorCode::InvalidRequest,
            message: "Page-op WASM request does not match the live allocation".to_string(),
        });
        return -1;
    }
    let request = slice::from_raw_parts(request_pointer, request_len);
    match std::panic::catch_unwind(|| run_request(request)) {
        Ok(Ok(output)) if output.len() <= PAGE_OP_WASM_MAX_OUTPUT_BYTES => {
            LAST_OUTPUT.with(|slot| {
                *slot.borrow_mut() = output;
            });
            0
        }
        Ok(Ok(_)) => {
            set_error_envelope(NativeErrorEnvelope {
                code: NativeErrorCode::TooLarge,
                message: "Page-op WASM output exceeds the admission ceiling".to_string(),
            });
            -1
        }
        Ok(Err(error)) => {
            set_error_envelope(NativeErrorEnvelope::from_error(error.as_ref()));
            -1
        }
        Err(_) => {
            set_error_envelope(NativeErrorEnvelope {
                code: NativeErrorCode::Panic,
                message: "Native page operation panicked".to_string(),
            });
            -1
        }
    }
}

fn set_last_error(message: &str) {
    LAST_ERROR.with(|slot| {
        *slot.borrow_mut() = message.as_bytes().to_vec();
    });
}

fn set_error_envelope(envelope: NativeErrorEnvelope) {
    set_last_error(&envelope.to_json());
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_output_ptr() -> *const u8 {
    LAST_OUTPUT.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_output_len() -> usize {
    LAST_OUTPUT.with(|slot| slot.borrow().len())
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_error_ptr() -> *const u8 {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn evb_pdf_page_ops_error_len() -> usize {
    LAST_ERROR.with(|slot| slot.borrow().len())
}

fn clear_last_result() {
    LAST_OUTPUT.with(|slot| slot.borrow_mut().clear());
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
}

fn run_request(request: &[u8]) -> Result<Vec<u8>> {
    if request.len() >= 8
        && &request[..4] == REQUEST_MAGIC
        && u32::from_le_bytes(request[4..8].try_into().unwrap()) == REQUEST_VERSION_DOCUMENT_LIST
    {
        return run_document_list_request(request);
    }
    let parsed = parse_request(request)?;
    match parsed.operation {
        OP_DELETE_PAGES => encode_mutation(delete_browser_pdf_pages(parsed.data, &parsed.pages)?),
        OP_EXTRACT_PAGES => encode_mutation(extract_browser_pdf_pages(parsed.data, &parsed.pages)?),
        OP_REORDER_PAGES => encode_mutation(reorder_browser_pdf_pages(parsed.data, &parsed.pages)?),
        OP_INSERT_PAGES => encode_mutation(insert_browser_pdf_pages(
            parsed.data,
            parsed.insertion_data,
            parsed.after_page,
        )?),
        OP_ROTATE => encode_mutation(rotate_browser_pdf_bytes(
            parsed.data,
            &parsed.pages,
            parsed.angle,
        )?),
        OP_CROP => encode_mutation(crop_browser_pdf_bytes(
            parsed.data,
            &parsed.pages,
            parsed.margins,
        )?),
        OP_REMOVE_CROP => {
            encode_mutation(remove_crop_browser_pdf_bytes(parsed.data, &parsed.pages)?)
        }
        OP_GET_PAGE_GEOMETRY => encode_geometry(get_browser_page_geometry_from_bytes(
            parsed.data,
            parsed.page_number,
        )?),
        OP_DECRYPT => encode_mutation(decrypt_browser_pdf_bytes(parsed.data, parsed.password)?),
        OP_PARSE_ANNOTATIONS => {
            let document = load_browser_pdf(parsed.data)?;
            let bytes = serialize_annotation_parse(
                &document,
                "D:19700101000000Z",
                PAGE_OP_WASM_MAX_OUTPUT_BYTES - ANNOTATION_PARSE_RESPONSE_HEADER_BYTES,
            )?;
            encode_annotation_parse(bytes)
        }
        OP_SAVE_MUTATIONS => {
            let (mutations, modified_at) = parse_wasm_mutation_payload(parsed.insertion_data)?;
            let result = append_native_mutations_to_bytes(parsed.data, &mutations, &modified_at)?;
            encode_native_mutation_save(result)
        }
        _ => Err(format!(
            "Unsupported browser page-op WASM operation {}",
            parsed.operation
        )
        .into()),
    }
}

fn run_document_list_request(request: &[u8]) -> Result<Vec<u8>> {
    let mut offset = 0;
    if take_bytes(request, &mut offset, 4)? != REQUEST_MAGIC {
        return Err("Invalid page-op WASM document-list magic".into());
    }
    let version = read_u32_le(request, &mut offset)?;
    if version != REQUEST_VERSION_DOCUMENT_LIST {
        return Err("Unsupported page-op WASM document-list version".into());
    }
    let operation = read_u32_le(request, &mut offset)?;
    let count = read_usize_le(request, &mut offset, "document count")?;
    if count == 0 || count > 500 {
        return Err("Invalid page-op WASM document count".into());
    }
    let mut documents = Vec::with_capacity(count);
    for _ in 0..count {
        let len = read_usize_le(request, &mut offset, "document length")?;
        documents.push(load_browser_pdf(take_bytes(request, &mut offset, len)?)?);
    }
    let total_pages = documents.iter().try_fold(0usize, |total, document| {
        total
            .checked_add(document.get_pages().len())
            .ok_or("Browser page-op document page count overflow")
    })?;
    if total_pages > MAX_DOCUMENT_LIST_PAGES {
        return Err("Browser page-op document list exceeds the 500-page limit".into());
    }
    if offset != request.len() {
        return Err("Trailing bytes in page-op WASM document-list request".into());
    }
    match operation {
        OP_READ_CATALOG => encode_json_bytes(serde_json::to_vec(&read_pdf_combine_catalog(
            &documents[0],
        )?)?),
        OP_CONFORMANCE => {
            encode_json_bytes(serde_json::to_vec(&pdf_conformance_facts(&documents[0])?)?)
        }
        OP_MERGE_PAGES => {
            let sources = documents.iter().collect::<Vec<_>>();
            let mut sequence = Vec::new();
            for (document_index, document) in documents.iter().enumerate() {
                sequence.extend(document.get_pages().values().copied().map(|page_id| {
                    PageCloneSource {
                        document_index,
                        page_id,
                    }
                }));
            }
            let merged = build_browser_page_subset_pdf(&sources, &sequence)?;
            let mut output = load_browser_pdf(&merged.data)?;
            let mut page_offset = 0u32;
            let mut bookmarks = Vec::new();
            let mut page_labels = Vec::new();
            for (source_index, document) in documents.iter().enumerate() {
                let source_catalog = read_pdf_combine_catalog(document)?;
                bookmarks.extend(
                    source_catalog
                        .bookmarks
                        .into_iter()
                        .map(|bookmark| offset_wasm_bookmark(bookmark, page_offset)),
                );
                page_labels.extend(source_catalog.page_labels.into_iter().map(|range| {
                    PageLabelRange {
                        start_page: range
                            .page_index
                            .saturating_add(page_offset)
                            .saturating_add(1),
                        style: range.style,
                        prefix: range.prefix.unwrap_or_default(),
                        start_number: range.start.unwrap_or(1),
                    }
                }));
                page_offset =
                    page_offset.saturating_add(documents[source_index].get_pages().len() as u32);
            }
            set_page_labels(
                &mut output,
                &PageLabelsMutation {
                    total_pages: merged.page_count,
                    ranges: page_labels,
                },
            )?;
            set_bookmarks(
                &mut output,
                &BookmarksMutation {
                    total_pages: merged.page_count,
                    untitled_label: "Untitled".to_string(),
                    items: bookmarks,
                },
            )?;
            encode_mutation(PageMutationBytes {
                page_count: merged.page_count,
                data: save_document_to_bytes(&mut output)?,
            })
        }
        _ => Err(format!("Unsupported page-op WASM document-list operation {operation}").into()),
    }
}

fn offset_wasm_bookmark(
    bookmark: crate::PdfCombineBookmarkEntry,
    page_offset: u32,
) -> BookmarkEntry {
    BookmarkEntry {
        title: bookmark.title,
        page_index: bookmark
            .page_index
            .map(|page| page.saturating_add(page_offset)),
        page_y_ratio: None,
        named_dest: bookmark.named_dest,
        bold: bookmark.bold,
        italic: bookmark.italic,
        color: bookmark.color,
        items: bookmark
            .items
            .into_iter()
            .map(|item| offset_wasm_bookmark(item, page_offset))
            .collect(),
    }
}

fn encode_json_bytes(bytes: Vec<u8>) -> Result<Vec<u8>> {
    let output_len = bytes
        .len()
        .checked_add(8)
        .ok_or_else(page_op_output_limit)?;
    if output_len > PAGE_OP_WASM_MAX_OUTPUT_BYTES {
        return Err(page_op_output_limit());
    }
    let length = u32::try_from(bytes.len()).map_err(|_| page_op_output_limit())?;
    let mut output = Vec::with_capacity(output_len);
    write_u32_le(&mut output, RESPONSE_JSON);
    write_u32_le(&mut output, length);
    output.extend_from_slice(&bytes);
    Ok(output)
}

fn parse_wasm_mutation_payload(payload: &[u8]) -> Result<(crate::NativeMutationsFile, String)> {
    if payload.len() > crate::MAX_SIDECAR_BYTES {
        return Err(format!(
            "WASM native mutation payload exceeds the {}-byte admission ceiling",
            crate::MAX_SIDECAR_BYTES
        )
        .into());
    }
    let mut value: serde_json::Value = serde_json::from_slice(payload)
        .map_err(|error| format!("Invalid WASM native mutation payload: {error}"))?;
    let is_envelope = value
        .as_object()
        .is_some_and(|object| object.contains_key("mutations"));
    let (mutation_value, modified_at_value) = if is_envelope {
        let object = value
            .as_object_mut()
            .ok_or("WASM native mutation envelope must be an object")?;
        let modified_at = object.remove("modifiedAt");
        let snake_modified_at = object.remove("modified_at");
        if modified_at.is_some() && snake_modified_at.is_some() {
            return Err("WASM native mutation envelope contains duplicate modified-at keys".into());
        }
        if object.keys().any(|key| key != "mutations") {
            return Err("WASM native mutation envelope contains an unknown field".into());
        }
        let mutations = object
            .remove("mutations")
            .ok_or("WASM native mutation envelope is missing mutations")?;
        (mutations, modified_at.or(snake_modified_at))
    } else {
        let object = value
            .as_object_mut()
            .ok_or("WASM native mutation payload must be an object")?;
        let modified_at = object.remove("modifiedAt");
        let snake_modified_at = object.remove("modified_at");
        if modified_at.is_some() && snake_modified_at.is_some() {
            return Err("WASM native mutation payload contains duplicate modified-at keys".into());
        }
        (value, modified_at.or(snake_modified_at))
    };
    let modified_at = match modified_at_value {
        Some(serde_json::Value::String(value)) => {
            validate_wasm_pdf_date(&value)?;
            value
        }
        Some(_) => return Err("WASM native mutation modifiedAt must be a PDF date string".into()),
        None => DEFAULT_WASM_MUTATION_MODIFIED_AT.to_string(),
    };
    let mutations = read_native_mutations_bytes(&serde_json::to_vec(&mutation_value)?)?;
    Ok((mutations, modified_at))
}

fn validate_wasm_pdf_date(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    let has_valid_prefix =
        bytes.len() >= 16 && &bytes[..2] == b"D:" && bytes[2..16].iter().all(u8::is_ascii_digit);
    let calendar_is_valid = if has_valid_prefix {
        let year = parse_wasm_pdf_date_digits(&bytes[2..6]);
        let month = parse_wasm_pdf_date_digits(&bytes[6..8]);
        let day = parse_wasm_pdf_date_digits(&bytes[8..10]);
        let hour = parse_wasm_pdf_date_digits(&bytes[10..12]);
        let minute = parse_wasm_pdf_date_digits(&bytes[12..14]);
        let second = parse_wasm_pdf_date_digits(&bytes[14..16]);
        match (year, month, day, hour, minute, second) {
            (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) => {
                let days_in_month = match month {
                    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
                    4 | 6 | 9 | 11 => 30,
                    2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
                    2 => 28,
                    _ => 0,
                };
                days_in_month > 0
                    && day >= 1
                    && day <= days_in_month
                    && hour <= 23
                    && minute <= 59
                    && second <= 59
            }
            _ => false,
        }
    } else {
        false
    };
    let suffix_is_valid = match bytes.get(16..) {
        Some([]) | Some(b"Z") => true,
        Some([sign, hour_tens, hour_ones, b'\'', minute_tens, minute_ones, b'\''])
            if (*sign == b'+' || *sign == b'-')
                && hour_tens.is_ascii_digit()
                && hour_ones.is_ascii_digit()
                && minute_tens.is_ascii_digit()
                && minute_ones.is_ascii_digit() =>
        {
            let hour = u32::from(*hour_tens - b'0') * 10 + u32::from(*hour_ones - b'0');
            let minute = u32::from(*minute_tens - b'0') * 10 + u32::from(*minute_ones - b'0');
            hour <= 23 && minute <= 59
        }
        _ => false,
    };
    if !calendar_is_valid || !suffix_is_valid {
        return Err("WASM native mutation modifiedAt is not a valid PDF date".into());
    }
    Ok(())
}

fn parse_wasm_pdf_date_digits(bytes: &[u8]) -> Option<u32> {
    bytes.iter().try_fold(0_u32, |value, byte| {
        byte.is_ascii_digit()
            .then_some(value * 10 + u32::from(*byte - b'0'))
    })
}

fn encode_native_mutation_save(result: NativeMutationBytesResult) -> Result<Vec<u8>> {
    let data_len = u32::try_from(result.data.len()).map_err(|_| page_op_output_limit())?;
    let identity_bindings = serde_json::to_vec(&result.identity_bindings)?;
    let identity_bindings_len =
        u32::try_from(identity_bindings.len()).map_err(|_| page_op_output_limit())?;
    let payload_len = result
        .data
        .len()
        .checked_add(identity_bindings.len())
        .ok_or_else(page_op_output_limit)?;
    let framed_len = NATIVE_MUTATION_RESPONSE_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or_else(page_op_output_limit)?;
    if framed_len > PAGE_OP_WASM_MAX_OUTPUT_BYTES {
        return Err(page_op_output_limit());
    }
    let mut output = result.data;
    output
        .try_reserve_exact(framed_len.saturating_sub(output.len()))
        .map_err(|_| page_op_output_limit())?;
    output.resize(data_len as usize + NATIVE_MUTATION_RESPONSE_HEADER_BYTES, 0);
    output.copy_within(0..data_len as usize, NATIVE_MUTATION_RESPONSE_HEADER_BYTES);
    output[0..4].copy_from_slice(&RESPONSE_NATIVE_MUTATIONS.to_le_bytes());
    output[4..8].copy_from_slice(&result.page_count.to_le_bytes());
    output[8..12].copy_from_slice(&data_len.to_le_bytes());
    output[12..16].copy_from_slice(&identity_bindings_len.to_le_bytes());
    // The append path performs semantic postcondition validation before this
    // response is returned. Keep the proof explicit in the wire frame so the
    // browser consumer can fail closed if a future writer changes that rule.
    output[16..20].copy_from_slice(&1_u32.to_le_bytes());
    output.extend_from_slice(&identity_bindings);
    Ok(output)
}

fn parse_request(request: &[u8]) -> Result<ParsedRequest<'_>> {
    let mut offset = 0usize;
    let magic = take_bytes(request, &mut offset, REQUEST_MAGIC.len())?;
    if magic != REQUEST_MAGIC {
        return Err("Invalid page-op WASM request magic".into());
    }
    let version = read_u32_le(request, &mut offset)?;
    if version != REQUEST_VERSION {
        return Err(format!("Unsupported page-op WASM request version: {version}").into());
    }

    let operation = read_u32_le(request, &mut offset)?;
    let page_count = read_usize_le(request, &mut offset, "page_count")?;
    let page_number = read_u32_le(request, &mut offset)?;
    let after_page = read_u32_le(request, &mut offset)?;
    let angle = i64::from(read_u32_le(request, &mut offset)?);
    let margins = CropMargins {
        top: read_f64_le(request, &mut offset)?,
        bottom: read_f64_le(request, &mut offset)?,
        left: read_f64_le(request, &mut offset)?,
        right: read_f64_le(request, &mut offset)?,
    };
    let data_len = read_usize_le(request, &mut offset, "data_len")?;
    let insertion_data_len = read_usize_le(request, &mut offset, "insertion_data_len")?;
    let password_len = read_usize_le(request, &mut offset, "password_len")?;
    if password_len > MAX_WASM_PASSWORD_BYTES {
        return Err(format!(
            "Page-op WASM password exceeds the {MAX_WASM_PASSWORD_BYTES}-byte ceiling"
        )
        .into());
    }

    let page_bytes_len = page_count
        .checked_mul(std::mem::size_of::<u32>())
        .ok_or("Invalid page-op WASM page count")?;
    let required_remaining = page_bytes_len
        .checked_add(data_len)
        .and_then(|length| length.checked_add(insertion_data_len))
        .and_then(|length| length.checked_add(password_len))
        .ok_or("Invalid page-op WASM request length")?;
    let actual_remaining = request
        .len()
        .checked_sub(offset)
        .ok_or("Invalid page-op WASM request length")?;
    if required_remaining != actual_remaining {
        return Err(if required_remaining > actual_remaining {
            "Truncated page-op WASM request"
        } else {
            "Trailing bytes in page-op WASM request"
        }
        .into());
    }

    let mut pages = Vec::new();
    pages
        .try_reserve_exact(page_count)
        .map_err(|_| "Page-op WASM page list is too large")?;
    for _ in 0..page_count {
        pages.push(read_u32_le(request, &mut offset)?);
    }

    let data = take_bytes(request, &mut offset, data_len)?;
    let insertion_data = take_bytes(request, &mut offset, insertion_data_len)?;
    let password = take_bytes(request, &mut offset, password_len)?;
    if offset != request.len() {
        return Err("Trailing bytes in page-op WASM request".into());
    }

    Ok(ParsedRequest {
        operation,
        pages,
        page_number,
        after_page,
        angle,
        margins,
        data,
        insertion_data,
        password,
    })
}

fn encode_mutation(result: PageMutationBytes) -> Result<Vec<u8>> {
    encode_mutation_with_limit(result, PAGE_OP_WASM_MAX_OUTPUT_BYTES)
}

fn mutation_frame_len(data_len: usize, max_output_bytes: usize) -> Result<usize> {
    let framed_len = PAGE_OP_WASM_MUTATION_HEADER_BYTES
        .checked_add(data_len)
        .ok_or_else(page_op_output_limit)?;
    if framed_len > max_output_bytes {
        return Err(page_op_output_limit());
    }
    Ok(framed_len)
}

fn page_op_output_limit() -> Box<dyn std::error::Error> {
    Box::new(evb_native_support::NativeError::new(
        NativeErrorCode::TooLarge,
        "Page-op WASM output exceeds the admission ceiling",
    ))
}

fn encode_mutation_with_limit(
    mut result: PageMutationBytes,
    max_output_bytes: usize,
) -> Result<Vec<u8>> {
    let data_len = u32::try_from(result.data.len()).map_err(|_| page_op_output_limit())?;
    let raw_len = result.data.len();
    let framed_len = mutation_frame_len(raw_len, max_output_bytes)?;
    result
        .data
        .try_reserve_exact(PAGE_OP_WASM_MUTATION_HEADER_BYTES)
        .map_err(|_| page_op_output_limit())?;
    result.data.resize(framed_len, 0);
    result
        .data
        .copy_within(0..raw_len, PAGE_OP_WASM_MUTATION_HEADER_BYTES);
    result.data[0..4].copy_from_slice(&RESPONSE_MUTATION.to_le_bytes());
    result.data[4..8].copy_from_slice(&result.page_count.to_le_bytes());
    result.data[8..12].copy_from_slice(&data_len.to_le_bytes());
    Ok(result.data)
}

fn encode_geometry(geometry: PageGeometry) -> Result<Vec<u8>> {
    let mut output = Vec::with_capacity(84);
    write_u32_le(&mut output, RESPONSE_GEOMETRY);
    write_u32_le(&mut output, u32::try_from(geometry.rotation)?);
    write_rect(&mut output, geometry.media_box);
    match geometry.crop_box {
        Some(crop_box) => {
            write_u32_le(&mut output, 1);
            write_rect(&mut output, crop_box);
        }
        None => {
            write_u32_le(&mut output, 0);
            write_rect(
                &mut output,
                PdfRect {
                    x1: 0.0,
                    y1: 0.0,
                    x2: 0.0,
                    y2: 0.0,
                },
            );
        }
    }
    Ok(output)
}

fn encode_annotation_parse(bytes: Vec<u8>) -> Result<Vec<u8>> {
    let data_len = u32::try_from(bytes.len()).map_err(|_| page_op_output_limit())?;
    let framed_len = ANNOTATION_PARSE_RESPONSE_HEADER_BYTES
        .checked_add(bytes.len())
        .ok_or_else(page_op_output_limit)?;
    if framed_len > PAGE_OP_WASM_MAX_OUTPUT_BYTES {
        return Err(page_op_output_limit());
    }
    let mut output = Vec::with_capacity(framed_len);
    write_u32_le(&mut output, RESPONSE_ANNOTATION_PARSE);
    write_u32_le(&mut output, data_len);
    output.extend_from_slice(&bytes);
    Ok(output)
}

fn write_rect(output: &mut Vec<u8>, rect: PdfRect) {
    write_f64_le(output, rect.x1);
    write_f64_le(output, rect.y1);
    write_f64_le(output, rect.width());
    write_f64_le(output, rect.height());
}

fn read_usize_le(request: &[u8], offset: &mut usize, label: &str) -> Result<usize> {
    usize::try_from(read_u32_le(request, offset)?)
        .map_err(|_| format!("Invalid page-op WASM {label}").into())
}

fn read_u32_le(request: &[u8], offset: &mut usize) -> Result<u32> {
    let bytes = take_bytes(request, offset, 4)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_f64_le(request: &[u8], offset: &mut usize) -> Result<f64> {
    let bytes = take_bytes(request, offset, 8)?;
    Ok(f64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

fn take_bytes<'a>(request: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(len)
        .ok_or("Invalid page-op WASM request length")?;
    let bytes = request
        .get(*offset..end)
        .ok_or("Truncated page-op WASM request")?;
    *offset = end;
    Ok(bytes)
}

fn write_u32_le(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn write_f64_le(output: &mut Vec<u8>, value: f64) {
    output.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        get_page_annots, pdf_string_to_text, read_annotation_name, ANNOTATION_PARSE_FORMAT,
        ANNOTATION_PARSE_SCHEMA_VERSION,
    };
    use lopdf::{
        dictionary, Document, EncryptionState, EncryptionVersion, Object, Permissions, StringFormat,
    };

    fn request_header(page_count: u32, data_len: u32, insertion_data_len: u32) -> Vec<u8> {
        request_header_with_password(OP_DELETE_PAGES, page_count, data_len, insertion_data_len, 0)
    }

    fn request_header_with_password(
        operation: u32,
        page_count: u32,
        data_len: u32,
        insertion_data_len: u32,
        password_len: u32,
    ) -> Vec<u8> {
        let mut request = Vec::new();
        request.extend_from_slice(REQUEST_MAGIC);
        for value in [REQUEST_VERSION, operation, page_count, 0, 0, 0] {
            write_u32_le(&mut request, value);
        }
        for _ in 0..4 {
            write_f64_le(&mut request, 0.0);
        }
        write_u32_le(&mut request, data_len);
        write_u32_le(&mut request, insertion_data_len);
        write_u32_le(&mut request, password_len);
        request
    }

    fn test_pdf_bytes() -> Vec<u8> {
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
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).expect("serialize test PDF");
        bytes
    }

    fn crop_request(data: &[u8], top: f64) -> Vec<u8> {
        let mut request = Vec::new();
        request.extend_from_slice(REQUEST_MAGIC);
        for value in [REQUEST_VERSION, OP_CROP, 1, 0, 0, 0] {
            write_u32_le(&mut request, value);
        }
        for value in [top, 0.0, 0.0, 0.0] {
            write_f64_le(&mut request, value);
        }
        write_u32_le(&mut request, data.len() as u32);
        write_u32_le(&mut request, 0);
        write_u32_le(&mut request, 0);
        write_u32_le(&mut request, 1);
        request.extend_from_slice(data);
        request
    }

    fn annotation_parse_request(data: &[u8]) -> Vec<u8> {
        let mut request = request_header(0, data.len() as u32, 0);
        request[8..12].copy_from_slice(&OP_PARSE_ANNOTATIONS.to_le_bytes());
        request.extend_from_slice(data);
        request
    }

    fn mutation_save_request(data: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut request = request_header_with_password(
            OP_SAVE_MUTATIONS,
            0,
            data.len() as u32,
            payload.len() as u32,
            0,
        );
        request.extend_from_slice(data);
        request.extend_from_slice(payload);
        request
    }

    fn assert_too_large(error: Box<dyn std::error::Error>) {
        assert_eq!(
            error
                .downcast_ref::<evb_native_support::NativeError>()
                .unwrap()
                .code,
            NativeErrorCode::TooLarge
        );
    }

    #[test]
    fn allocator_requires_one_exact_live_pointer_and_length() {
        assert!(evb_pdf_page_ops_alloc(0).is_null());
        assert!(evb_pdf_page_ops_alloc(MAX_REQUEST_BYTES + 1).is_null());
        let pointer = evb_pdf_page_ops_alloc(17);
        assert!(!pointer.is_null());
        assert!(evb_pdf_page_ops_alloc(1).is_null());

        let status = unsafe { evb_pdf_page_ops_run(pointer, 16) };
        assert_eq!(status, -1);
        let envelope = LAST_ERROR.with(|slot| String::from_utf8(slot.borrow().clone()).unwrap());
        assert_eq!(
            envelope,
            r#"{"code":"invalid-request","message":"Page-op WASM request does not match the live allocation"}"#
        );

        unsafe { evb_pdf_page_ops_free(pointer, 16) };
        assert!(evb_pdf_page_ops_alloc(1).is_null());
        unsafe { evb_pdf_page_ops_free(pointer, 17) };
        let next_pointer = evb_pdf_page_ops_alloc(1);
        assert!(!next_pointer.is_null());
        unsafe { evb_pdf_page_ops_free(next_pointer, 1) };
    }

    #[test]
    fn mutation_framing_checks_exact_limits_and_arithmetic_overflow() {
        let framed = encode_mutation_with_limit(
            PageMutationBytes {
                data: vec![1, 2, 3, 4],
                page_count: 2,
            },
            16,
        )
        .unwrap();
        assert_eq!(framed.len(), 16);
        assert_eq!(&framed[0..4], &RESPONSE_MUTATION.to_le_bytes());
        assert_eq!(&framed[4..8], &2u32.to_le_bytes());
        assert_eq!(&framed[8..12], &4u32.to_le_bytes());
        assert_eq!(&framed[12..], &[1, 2, 3, 4]);

        assert_too_large(
            encode_mutation_with_limit(
                PageMutationBytes {
                    data: vec![0; 5],
                    page_count: 1,
                },
                16,
            )
            .unwrap_err(),
        );
        assert_too_large(mutation_frame_len(usize::MAX, usize::MAX).unwrap_err());
    }

    #[test]
    fn document_writer_stops_at_the_output_cap_with_a_typed_error() {
        let mut document = Document::load_mem(&test_pdf_bytes()).unwrap();
        let error = crate::save_document_to_bytes_with_limit(&mut document, 16).unwrap_err();
        assert_too_large(error);
    }

    #[test]
    fn run_rejects_oversized_lengths_before_reading_the_pointer() {
        let dangling = std::ptr::NonNull::<u8>::dangling().as_ptr();
        let status = unsafe { evb_pdf_page_ops_run(dangling, MAX_REQUEST_BYTES + 1) };
        assert_eq!(status, -1);
        let envelope = LAST_ERROR.with(|slot| String::from_utf8(slot.borrow().clone()).unwrap());
        assert_eq!(
            envelope,
            r#"{"code":"too-large","message":"Page-op WASM request exceeds the admission ceiling"}"#
        );
    }

    #[test]
    fn rejects_page_count_that_exceeds_remaining_records_before_reserving() {
        let request = request_header(u32::MAX, 0, 0);

        let error = parse_request(&request)
            .err()
            .expect("oversized page count must fail");

        assert!(error.to_string().contains("Truncated page-op WASM request"));
    }

    #[test]
    fn rejects_combined_record_lengths_that_exceed_remaining_bytes() {
        let mut request = request_header(1, u32::MAX, u32::MAX);
        write_u32_le(&mut request, 1);

        let error = parse_request(&request)
            .err()
            .expect("oversized payload lengths must fail");

        assert!(error.to_string().contains("Truncated page-op WASM request"));
    }

    #[test]
    fn rejects_trailing_bytes_before_allocating_page_records() {
        let mut request = request_header(0, 0, 0);
        request.push(0);

        let error = parse_request(&request)
            .err()
            .expect("trailing bytes must fail");

        assert!(error.to_string().contains("Trailing bytes"));
    }

    #[test]
    fn wasm_crop_rejects_non_finite_margins_through_shared_validation() {
        let request = crop_request(&test_pdf_bytes(), f64::NAN);

        let error = run_request(&request)
            .expect_err("WASM crop must reject non-finite margins through shared validation");

        assert!(error.to_string().contains("Invalid top crop margin"));
    }

    #[test]
    fn wasm_annotation_parse_dispatch_returns_the_jsonl_envelope() {
        let output = run_request(&annotation_parse_request(&test_pdf_bytes())).unwrap();
        assert_eq!(&output[..4], &RESPONSE_ANNOTATION_PARSE.to_le_bytes());
        let data_len = u32::from_le_bytes(output[4..8].try_into().unwrap()) as usize;
        assert_eq!(data_len, output.len() - 8);
        let payload = String::from_utf8(output[8..].to_vec()).unwrap();
        let header = payload.lines().next().unwrap();
        let header = serde_json::from_str::<serde_json::Value>(header).unwrap();
        assert_eq!(header["format"], ANNOTATION_PARSE_FORMAT);
        assert_eq!(header["schemaVersion"], ANNOTATION_PARSE_SCHEMA_VERSION);
    }

    #[test]
    fn wasm_native_mutation_save_appends_text_box_and_returns_identity_proof() {
        let input = test_pdf_bytes();
        let payload = br#"{"modifiedAt":"D:20260831150000Z","mutations":{"textBoxes":[{"pageIndex":0,"stableKey":"wasm-text-box","text":"WASM text box","rect":[10,20,100,60],"rotation":0,"fontSize":16,"color":[17,24,39],"author":"Ada Lovelace","createdAt":1780000000000,"modifiedAt":1780000060000}]}}"#;
        let output = run_request(&mutation_save_request(&input, payload)).unwrap();
        assert_eq!(&output[..4], &RESPONSE_NATIVE_MUTATIONS.to_le_bytes());
        assert_eq!(u32::from_le_bytes(output[4..8].try_into().unwrap()), 1);
        let data_len = u32::from_le_bytes(output[8..12].try_into().unwrap()) as usize;
        let bindings_len = u32::from_le_bytes(output[12..16].try_into().unwrap()) as usize;
        assert_eq!(u32::from_le_bytes(output[16..20].try_into().unwrap()), 1);
        assert_eq!(
            output.len(),
            NATIVE_MUTATION_RESPONSE_HEADER_BYTES + data_len + bindings_len
        );
        assert!(data_len > input.len());
        let saved = &output[NATIVE_MUTATION_RESPONSE_HEADER_BYTES
            ..NATIVE_MUTATION_RESPONSE_HEADER_BYTES + data_len];
        assert!(saved.starts_with(&input));
        let loaded = Document::load_mem(saved).expect("reload appended WASM mutation output");
        let page_id = loaded.get_pages().values().next().copied().unwrap();
        let annotation_id = get_page_annots(&loaded, page_id)
            .unwrap()
            .iter()
            .filter_map(|object| object.as_reference().ok())
            .find(|object_id| {
                loaded
                    .get_dictionary(*object_id)
                    .ok()
                    .and_then(read_annotation_name)
                    .as_deref()
                    == Some("wasm-text-box")
            })
            .expect("WASM save should reference the created text box");
        assert_eq!(
            pdf_string_to_text(
                loaded
                    .get_dictionary(annotation_id)
                    .unwrap()
                    .get(b"Contents")
                    .unwrap()
            )
            .as_deref(),
            Some("WASM text box")
        );
        let bindings = serde_json::from_slice::<Vec<serde_json::Value>>(
            &output[NATIVE_MUTATION_RESPONSE_HEADER_BYTES + data_len..],
        )
        .unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0]["annotationId"], "wasm-text-box");
    }

    #[test]
    fn wasm_native_mutation_dates_require_valid_calendar_and_timezone_values() {
        for value in [
            "D:20260230000000Z",
            "D:20251301000000Z",
            "D:20261201000000+24'00'",
            "D:20261201000000+00'60'",
            "D:20261201240000Z",
            "D:20261201006000Z",
            "D:20261201000060Z",
        ] {
            assert!(
                validate_wasm_pdf_date(value).is_err(),
                "calendar-invalid PDF date should be rejected: {value}"
            );
        }
        for value in [
            "D:20260228000000Z",
            "D:20240229000000+23'59'",
            "D:20261201000000",
        ] {
            validate_wasm_pdf_date(value).expect("valid PDF date should be accepted");
        }
    }

    #[test]
    fn rejects_a_password_above_the_frame_ceiling() {
        let mut request =
            request_header_with_password(OP_DECRYPT, 0, 0, 0, (MAX_WASM_PASSWORD_BYTES + 1) as u32);
        request.extend(std::iter::repeat_n(0u8, MAX_WASM_PASSWORD_BYTES + 1));

        let error = parse_request(&request)
            .err()
            .expect("oversized password must fail");

        assert!(error.to_string().contains("password exceeds"));
    }

    #[test]
    fn rejects_a_v1_request_frame() {
        let mut request = request_header(0, 0, 0);
        // A version-1 frame predates the trailing password length; restore the
        // old version byte to prove it is refused.
        request[4..8].copy_from_slice(&1u32.to_le_bytes());

        let error = parse_request(&request)
            .err()
            .expect("version 1 frames must be rejected");

        assert!(error
            .to_string()
            .contains("Unsupported page-op WASM request version: 1"));
    }

    fn encrypt_fixture_bytes(password: &str) -> Vec<u8> {
        encrypt_fixture_bytes_with_page_count(password, 1)
    }

    fn encrypt_fixture_bytes_with_page_count(password: &str, page_count: usize) -> Vec<u8> {
        let mut document = Document::with_version("1.5");
        document.trailer.set(
            "ID",
            Object::Array(vec![
                Object::String((1u8..=16).collect(), StringFormat::Literal),
                Object::String(((1..=16u8).rev()).collect(), StringFormat::Literal),
            ]),
        );
        let pages_id = document.new_object_id();
        let page_ids = (0..page_count)
            .map(|_| {
                document.add_object(dictionary! {
                    "Type" => "Page",
                    "Parent" => pages_id,
                    "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                })
            })
            .collect::<Vec<_>>();
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => page_ids.into_iter().map(Object::Reference).collect::<Vec<_>>(),
                "Count" => page_count as i64,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let encryption_state = EncryptionState::try_from(EncryptionVersion::V2 {
            document: &document,
            owner_password: "test-owner",
            user_password: password,
            key_length: 128,
            permissions: Permissions::all(),
        })
        .expect("build encryption state");
        document
            .encrypt(&encryption_state)
            .expect("encrypt fixture");
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).expect("serialize fixture");
        bytes
    }

    fn decrypt_request(data: &[u8], password: &str) -> Vec<u8> {
        let mut request = request_header_with_password(
            OP_DECRYPT,
            0,
            data.len() as u32,
            0,
            password.len() as u32,
        );
        request.extend_from_slice(data);
        request.extend_from_slice(password.as_bytes());
        request
    }

    #[test]
    fn wasm_decrypt_rewrites_a_user_password_file() {
        let encrypted = encrypt_fixture_bytes("frame-secret");
        let request = decrypt_request(&encrypted, "frame-secret");

        let output = run_request(&request).expect("decrypt with the user password");

        let page_count = u32::from_le_bytes(output[4..8].try_into().unwrap());
        assert_eq!(page_count, 1);
        let data_len = u32::from_le_bytes(output[8..12].try_into().unwrap()) as usize;
        assert_eq!(output.len(), 12 + data_len);
        let decrypted =
            Document::load_mem_with_options(&output[12..], lopdf::LoadOptions::default())
                .expect("reload decrypted bytes");
        assert!(!decrypted.was_encrypted());
        assert!(!decrypted.is_encrypted());
    }

    #[test]
    fn wasm_decrypt_reports_the_actual_page_count_for_a_multi_page_file() {
        let encrypted = encrypt_fixture_bytes_with_page_count("frame-secret", 3);
        let request = decrypt_request(&encrypted, "frame-secret");

        let output = run_request(&request).expect("decrypt a multi-page PDF");

        let page_count = u32::from_le_bytes(output[4..8].try_into().unwrap());
        assert_eq!(page_count, 3);
        let decrypted =
            Document::load_mem_with_options(&output[12..], lopdf::LoadOptions::default())
                .expect("reload decrypted bytes");
        assert_eq!(decrypted.get_pages().len(), 3);
    }

    #[test]
    fn wasm_decrypt_reports_needs_password_for_a_wrong_password() {
        let encrypted = encrypt_fixture_bytes("frame-secret");
        let request = decrypt_request(&encrypted, "wrong");

        let error = run_request(&request).expect_err("wrong password must fail");

        assert_eq!(
            error
                .downcast_ref::<evb_native_support::NativeError>()
                .expect("typed native error")
                .code,
            NativeErrorCode::NeedsPassword
        );
    }

    #[test]
    fn wasm_decrypt_returns_the_input_unchanged_when_not_encrypted() {
        let plaintext = test_pdf_bytes();
        let request = decrypt_request(&plaintext, "");

        let output = run_request(&request).expect("decrypt of a plaintext file");

        let page_count = u32::from_le_bytes(output[4..8].try_into().unwrap());
        assert_eq!(page_count, 0);
        assert_eq!(&output[12..], &plaintext[..]);
    }

    #[test]
    fn wasm_decrypt_reports_unsupported_filter_for_a_public_key_handler() {
        let mut document = Document::with_version("1.5");
        document.trailer.set(
            "ID",
            Object::Array(vec![
                Object::String((1u8..=16).collect(), StringFormat::Literal),
                Object::String(((1..=16u8).rev()).collect(), StringFormat::Literal),
            ]),
        );
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
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let encrypt_dict = dictionary! {
            "Filter" => "Adobe.PubSec",
            "V" => 4,
            "R" => 4,
            "O" => Object::String(vec![0u8; 32], StringFormat::Literal),
            "U" => Object::String(vec![0u8; 32], StringFormat::Literal),
            "P" => -1,
        };
        let encrypt_id = document.add_object(encrypt_dict);
        document
            .trailer
            .set("Encrypt", Object::Reference(encrypt_id));
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).expect("serialize fixture");

        let request = decrypt_request(&bytes, "");
        let error = run_request(&request).expect_err("public-key handler must fail");

        assert_eq!(
            error
                .downcast_ref::<evb_native_support::NativeError>()
                .expect("typed native error")
                .code,
            NativeErrorCode::UnsupportedFilter
        );
    }
}
