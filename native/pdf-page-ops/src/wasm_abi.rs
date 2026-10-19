//! EPPO binary frame definitions, shared by the Rust codec and generated TS.
//! The worker-message envelope is a separate contract.

use crate::{CropMargins, Result, PAGE_OP_WASM_MAX_OUTPUT_BYTES};
use evb_native_support::NativeErrorCode;

pub(crate) const MAX_WASM_PASSWORD_BYTES: usize = 4 * 1024;

pub(crate) const REQUEST_MAGIC: &[u8; 4] = b"EPPO";

// Derive offsets and frame sizes from field widths, then emit the same values
// for the handwritten TypeScript codec. No codec implementation is generated.
macro_rules! abi {
    (
        constants { $($constant:ident: $constant_type:ty = $value:expr;)* }
        operations { $($operation:ident = $code:expr => $ts_operation:literal;)* }
        layouts { $($layout:ident: $layout_type:ident { $($field:ident: $width:expr),+ $(,)? })* }
    ) => {
        $(pub(crate) const $constant: $constant_type = $value;)*
        $(pub(crate) const $operation: u32 = $code;)*
        $(
            pub(crate) struct $layout_type {
                $(pub(crate) $field: usize,)+
                pub(crate) bytes: usize,
            }
            pub(crate) const $layout: $layout_type = {
                let mut offset = 0;
                $(let $field = offset; offset += $width;)+
                $layout_type { $($field,)+ bytes: offset }
            };
        )*

        #[cfg(test)]
        fn generated() -> String {
            use std::fmt::Write;
            let mut output = String::from(
                "// Generated from the evb-pdf-page-ops Rust WASM ABI; do not edit.\n\
                 // Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops generated_typescript`.\n\
                 // Layout fields are byte offsets; numeric fields are little-endian.\n\n",
            );
            writeln!(output, "export const REQUEST_MAGIC = '{}';", std::str::from_utf8(REQUEST_MAGIC).unwrap()).unwrap();
            $(writeln!(output, "export const {} = {};", stringify!($constant), $constant).unwrap();)*
            writeln!(output, "export const MAX_U32 = {};", u32::MAX).unwrap();
            output.push_str("\nexport const OPERATION_CODES = {\n");
            $(writeln!(output, "    {}: {},", $ts_operation, $operation).unwrap();)*
            output.push_str("} as const;\n");
            $(
                writeln!(output, "\nexport const {} = {{", stringify!($layout)).unwrap();
                $(writeln!(output, "    {}: {},", camel_case(stringify!($field)), $layout.$field).unwrap();)+
                writeln!(output, "    bytes: {},\n}} as const;", $layout.bytes).unwrap();
            )*
            writeln!(output, "\nexport const REQUEST_ORIGINAL_APPEARANCE_SOURCE_HEADER = {{\n    sourceDataLength: {},\n    bytes: {},\n}} as const;", REQUEST_ORIGINAL_APPEARANCE_SOURCE_HEADER.source_data_length, REQUEST_ORIGINAL_APPEARANCE_SOURCE_HEADER.bytes).unwrap();
            output
        }
    };
}

abi! {
    constants {
        // Version 2 includes the trailing password length for decrypt.
        REQUEST_VERSION: u32 = 2;
        REQUEST_VERSION_DOCUMENT_LIST: u32 = 3;
        REQUEST_VERSION_ORIGINAL_APPEARANCE_SOURCE: u32 = 4;
        REQUEST_VERSION_OCR_TEXT_LAYER: u32 = 5;
        // One per recognized page; an OCR job writes at most this many at once.
        MAX_OCR_PAGE_PDFS: usize = 100_000;
        U32_BYTES: usize = std::mem::size_of::<u32>();
        F64_BYTES: usize = std::mem::size_of::<f64>();
        MAX_DOCUMENTS: usize = 500;
        RESPONSE_MUTATION: u32 = 1;
        RESPONSE_GEOMETRY: u32 = 2;
        RESPONSE_ANNOTATION_PARSE: u32 = 3;
        RESPONSE_NATIVE_MUTATIONS: u32 = 4;
        RESPONSE_JSON: u32 = 5;
        RESPONSE_TEXT_BOX_APPEARANCE: u32 = 6;
        // MUTATION_HEADER layout; the data is only the appended revision.
        RESPONSE_INCREMENT: u32 = 7;
        NATIVE_MUTATION_POSTCONDITIONS_VERIFIED: u32 = 1;
    }
    operations {
        OP_DELETE_PAGES = 1 => "deletePages";
        OP_EXTRACT_PAGES = 2 => "extractPages";
        OP_REORDER_PAGES = 3 => "reorderPages";
        OP_INSERT_PAGES = 4 => "insertPages";
        OP_ROTATE = 5 => "rotate";
        OP_CROP = 6 => "crop";
        OP_REMOVE_CROP = 7 => "removeCrop";
        OP_GET_PAGE_GEOMETRY = 8 => "getPageGeometry";
        OP_DECRYPT = 9 => "decrypt";
        OP_PARSE_ANNOTATIONS = 10 => "parseAnnotations";
        OP_SAVE_MUTATIONS = 11 => "saveMutations";
        OP_READ_CATALOG = 12 => "readCatalog";
        OP_CONFORMANCE = 13 => "conformance";
        OP_MERGE_PAGES = 14 => "mergePages";
        // Selected pages use the page list; insertion data is UTF-8
        // "<view mode> <orientation>".
        OP_PRINT_LAYOUT = 15 => "printLayout";
        OP_TEXT_BOX_APPEARANCE = 16 => "textBoxAppearance";
        // Selected pages use the page list; insertion data is empty or the
        // UTF-8 flag "with-evb-ocr-text". Answers RESPONSE_JSON.
        OP_OCR_TEXT_VISIBILITY = 17 => "ocrTextVisibility";
        // OCR_TEXT_LAYER_HEADER framing. Answers RESPONSE_INCREMENT.
        OP_OCR_TEXT_LAYER = 18 => "ocrTextLayer";
    }
    layouts {
        REQUEST_HEADER: RequestHeader {
            magic: REQUEST_MAGIC.len(), version: U32_BYTES, operation: U32_BYTES,
            page_count: U32_BYTES, page_number: U32_BYTES, after_page: U32_BYTES,
            angle: U32_BYTES, top: F64_BYTES, bottom: F64_BYTES,
            left: F64_BYTES, right: F64_BYTES, data_length: U32_BYTES,
            insertion_data_length: U32_BYTES, password_length: U32_BYTES,
        }
        DOCUMENT_LIST_HEADER: DocumentListHeader {
            magic: REQUEST_MAGIC.len(), version: U32_BYTES,
            operation: U32_BYTES, document_count: U32_BYTES,
        }
        // Followed by the document, the UTF-8 JSON instructions, then each
        // page PDF as a little-endian u32 length and its bytes.
        OCR_TEXT_LAYER_HEADER: OcrTextLayerHeader {
            magic: REQUEST_MAGIC.len(), version: U32_BYTES, operation: U32_BYTES,
            data_length: U32_BYTES, instructions_length: U32_BYTES,
            page_pdf_count: U32_BYTES,
        }
        MUTATION_HEADER: MutationHeader {
            kind: U32_BYTES, page_count: U32_BYTES, data_length: U32_BYTES,
        }
        BOX_LAYOUT: BoxLayout {
            x: F64_BYTES, y: F64_BYTES, width: F64_BYTES, height: F64_BYTES,
        }
        GEOMETRY_HEADER: GeometryHeader {
            kind: U32_BYTES, rotation: U32_BYTES, media_box: BOX_LAYOUT.bytes,
            has_crop_box: U32_BYTES, crop_box: BOX_LAYOUT.bytes,
        }
        BYTES_HEADER: BytesHeader {
            kind: U32_BYTES, data_length: U32_BYTES,
        }
        TEXT_BOX_APPEARANCE_HEADER: TextBoxAppearanceHeader {
            kind: U32_BYTES, data_length: U32_BYTES, metadata_length: U32_BYTES,
        }
        NATIVE_MUTATION_HEADER: NativeMutationHeader {
            kind: U32_BYTES, page_count: U32_BYTES, data_length: U32_BYTES,
            identity_bindings_length: U32_BYTES, postconditions_verified: U32_BYTES,
        }
    }
}

pub(crate) struct OriginalAppearanceSourceHeader {
    pub(crate) source_data_length: usize,
    pub(crate) bytes: usize,
}
pub(crate) const REQUEST_ORIGINAL_APPEARANCE_SOURCE_HEADER: OriginalAppearanceSourceHeader =
    OriginalAppearanceSourceHeader {
        source_data_length: REQUEST_HEADER.bytes,
        bytes: REQUEST_HEADER.bytes + U32_BYTES,
    };

#[cfg(test)]
fn camel_case(name: &str) -> String {
    let mut upper = false;
    name.chars()
        .filter_map(|character| {
            if character == '_' {
                upper = true;
                None
            } else if upper {
                upper = false;
                Some(character.to_ascii_uppercase())
            } else {
                Some(character)
            }
        })
        .collect()
}

#[test]
fn generated_typescript_is_current() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/browserPageOpsWasm.generated.ts");
    let current = generated();
    if std::env::var_os("EVB_UPDATE_GENERATED").is_some() {
        std::fs::write(&path, current).unwrap();
        return;
    }
    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        checked_in == current,
        "{} is stale; regenerate it with EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops generated_typescript",
        path.display()
    );
}

pub(crate) struct ParsedRequest<'a> {
    pub(crate) operation: u32,
    pub(crate) pages: Vec<u32>,
    pub(crate) page_number: u32,
    pub(crate) after_page: u32,
    pub(crate) angle: i64,
    pub(crate) margins: CropMargins,
    pub(crate) data: &'a [u8],
    pub(crate) insertion_data: &'a [u8],
    pub(crate) password: &'a [u8],
    pub(crate) original_appearance_source: &'a [u8],
}

pub(crate) fn parse_request(request: &[u8]) -> Result<ParsedRequest<'_>> {
    let mut offset = REQUEST_HEADER.magic;
    let magic = take_bytes(request, &mut offset, REQUEST_MAGIC.len())?;
    if magic != REQUEST_MAGIC {
        return Err("Invalid page-op WASM request magic".into());
    }
    let version = read_u32_at(request, REQUEST_HEADER.version)?;
    if version != REQUEST_VERSION && version != REQUEST_VERSION_ORIGINAL_APPEARANCE_SOURCE {
        return Err(format!("Unsupported page-op WASM request version: {version}").into());
    }

    let operation = read_u32_at(request, REQUEST_HEADER.operation)?;
    if version == REQUEST_VERSION_ORIGINAL_APPEARANCE_SOURCE && operation != OP_SAVE_MUTATIONS {
        return Err("Original appearance source framing is reserved for Save".into());
    }
    let page_count = read_usize_at(request, REQUEST_HEADER.page_count, "page_count")?;
    let page_number = read_u32_at(request, REQUEST_HEADER.page_number)?;
    let after_page = read_u32_at(request, REQUEST_HEADER.after_page)?;
    let angle = i64::from(read_u32_at(request, REQUEST_HEADER.angle)?);
    let margins = CropMargins {
        top: read_f64_at(request, REQUEST_HEADER.top)?,
        bottom: read_f64_at(request, REQUEST_HEADER.bottom)?,
        left: read_f64_at(request, REQUEST_HEADER.left)?,
        right: read_f64_at(request, REQUEST_HEADER.right)?,
    };
    let data_len = read_usize_at(request, REQUEST_HEADER.data_length, "data_len")?;
    let insertion_data_len = read_usize_at(
        request,
        REQUEST_HEADER.insertion_data_length,
        "insertion_data_len",
    )?;
    let password_len = read_usize_at(request, REQUEST_HEADER.password_length, "password_len")?;
    let (mut offset, source_len) = if version == REQUEST_VERSION_ORIGINAL_APPEARANCE_SOURCE {
        (
            REQUEST_ORIGINAL_APPEARANCE_SOURCE_HEADER.bytes,
            read_usize_at(
                request,
                REQUEST_ORIGINAL_APPEARANCE_SOURCE_HEADER.source_data_length,
                "original appearance source length",
            )?,
        )
    } else {
        (REQUEST_HEADER.bytes, 0)
    };
    if password_len > MAX_WASM_PASSWORD_BYTES {
        return Err(format!(
            "Page-op WASM password exceeds the {MAX_WASM_PASSWORD_BYTES}-byte ceiling"
        )
        .into());
    }

    let page_bytes_len = page_count
        .checked_mul(U32_BYTES)
        .ok_or("Invalid page-op WASM page count")?;
    let required_remaining = page_bytes_len
        .checked_add(data_len)
        .and_then(|length| length.checked_add(insertion_data_len))
        .and_then(|length| length.checked_add(password_len))
        .and_then(|length| length.checked_add(source_len))
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
    let original_appearance_source = take_bytes(request, &mut offset, source_len)?;
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
        original_appearance_source,
    })
}

pub(crate) struct ParsedOcrTextLayerRequest<'a> {
    pub(crate) data: &'a [u8],
    pub(crate) instructions: &'a [u8],
    pub(crate) page_pdfs: Vec<&'a [u8]>,
}

pub(crate) fn parse_ocr_text_layer_request(
    request: &[u8],
) -> Result<ParsedOcrTextLayerRequest<'_>> {
    let mut offset = OCR_TEXT_LAYER_HEADER.magic;
    if take_bytes(request, &mut offset, REQUEST_MAGIC.len())? != REQUEST_MAGIC {
        return Err("Invalid page-op WASM OCR text-layer magic".into());
    }
    if read_u32_at(request, OCR_TEXT_LAYER_HEADER.version)? != REQUEST_VERSION_OCR_TEXT_LAYER
        || read_u32_at(request, OCR_TEXT_LAYER_HEADER.operation)? != OP_OCR_TEXT_LAYER
    {
        return Err("OCR text-layer framing is reserved for the ocrTextLayer operation".into());
    }
    let data_len = read_usize_at(request, OCR_TEXT_LAYER_HEADER.data_length, "data_len")?;
    let instructions_len = read_usize_at(
        request,
        OCR_TEXT_LAYER_HEADER.instructions_length,
        "instructions_len",
    )?;
    let page_pdf_count = read_usize_at(
        request,
        OCR_TEXT_LAYER_HEADER.page_pdf_count,
        "page PDF count",
    )?;
    if page_pdf_count == 0 || page_pdf_count > MAX_OCR_PAGE_PDFS {
        return Err("Invalid page-op WASM OCR page PDF count".into());
    }
    let mut offset = OCR_TEXT_LAYER_HEADER.bytes;
    let data = take_bytes(request, &mut offset, data_len)?;
    let instructions = take_bytes(request, &mut offset, instructions_len)?;
    // Every page PDF carries at least its length, so a count the request
    // cannot hold fails before anything is reserved.
    if page_pdf_count > (request.len() - offset) / U32_BYTES {
        return Err("Truncated page-op WASM request".into());
    }
    let mut page_pdfs = Vec::with_capacity(page_pdf_count);
    for _ in 0..page_pdf_count {
        let len = read_usize_le(request, &mut offset, "page PDF length")?;
        page_pdfs.push(take_bytes(request, &mut offset, len)?);
    }
    if offset != request.len() {
        return Err("Trailing bytes in page-op WASM request".into());
    }
    Ok(ParsedOcrTextLayerRequest {
        data,
        instructions,
        page_pdfs,
    })
}

pub(crate) fn read_u32_at(request: &[u8], mut offset: usize) -> Result<u32> {
    read_u32_le(request, &mut offset)
}

pub(crate) fn read_usize_at(request: &[u8], mut offset: usize, label: &str) -> Result<usize> {
    read_usize_le(request, &mut offset, label)
}

pub(crate) fn read_f64_at(request: &[u8], mut offset: usize) -> Result<f64> {
    read_f64_le(request, &mut offset)
}

pub(crate) fn read_usize_le(request: &[u8], offset: &mut usize, label: &str) -> Result<usize> {
    usize::try_from(read_u32_le(request, offset)?)
        .map_err(|_| format!("Invalid page-op WASM {label}").into())
}

pub(crate) fn read_u32_le(request: &[u8], offset: &mut usize) -> Result<u32> {
    let bytes = take_bytes(request, offset, U32_BYTES)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

pub(crate) fn read_f64_le(request: &[u8], offset: &mut usize) -> Result<f64> {
    let bytes = take_bytes(request, offset, F64_BYTES)?;
    Ok(f64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

pub(crate) fn take_bytes<'a>(
    request: &'a [u8],
    offset: &mut usize,
    len: usize,
) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(len)
        .ok_or("Invalid page-op WASM request length")?;
    let bytes = request
        .get(*offset..end)
        .ok_or("Truncated page-op WASM request")?;
    *offset = end;
    Ok(bytes)
}

pub(crate) fn page_op_output_limit() -> Box<dyn std::error::Error> {
    Box::new(evb_native_support::NativeError::new(
        NativeErrorCode::TooLarge,
        "Page-op WASM output exceeds the admission ceiling",
    ))
}

pub(crate) fn encode_bytes(kind: u32, bytes: Vec<u8>) -> Result<Vec<u8>> {
    let data_len = u32::try_from(bytes.len()).map_err(|_| page_op_output_limit())?;
    let framed_len = BYTES_HEADER
        .bytes
        .checked_add(bytes.len())
        .ok_or_else(page_op_output_limit)?;
    if framed_len > PAGE_OP_WASM_MAX_OUTPUT_BYTES {
        return Err(page_op_output_limit());
    }
    let mut output = Vec::with_capacity(framed_len);
    output.resize(BYTES_HEADER.bytes, 0);
    output[BYTES_HEADER.kind..BYTES_HEADER.kind + U32_BYTES].copy_from_slice(&kind.to_le_bytes());
    output[BYTES_HEADER.data_length..BYTES_HEADER.data_length + U32_BYTES]
        .copy_from_slice(&data_len.to_le_bytes());
    output.extend_from_slice(&bytes);
    Ok(output)
}
