//! EPPO binary frame definitions, shared by the Rust codec and generated TS.
//! The worker-message envelope is a separate contract.

use crate::Result;
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
            // The catalog reader returns at most this many bookmarks or
            // page-label ranges; the browser decodes with desktop's ceiling.
            writeln!(output, "export const MAX_CATALOG_ENTRIES = {};", crate::catalog::CATALOG_WALK_NODE_LIMIT).unwrap();
            output.push_str("\nexport const OPERATION_CODES = {\n");
            $(writeln!(output, "    {}: {},", $ts_operation, $operation).unwrap();)*
            output.push_str("} as const;\n");
            $(
                writeln!(output, "\nexport const {} = {{", stringify!($layout)).unwrap();
                $(writeln!(output, "    {}: {},", camel_case(stringify!($field)), $layout.$field).unwrap();)+
                writeln!(output, "    bytes: {},\n}} as const;", $layout.bytes).unwrap();
            )*
            output
        }
    };
}

abi! {
    constants {
        // Version 2 includes the trailing password length for decrypt.
        REQUEST_VERSION: u32 = 2;
        // INSTRUCTED_REQUEST_HEADER framing.
        REQUEST_VERSION_INSTRUCTED: u32 = 5;
        // FILE_REQUEST_HEADER framing: an edit whose inputs are the host's
        // source files and whose output is its sink file.
        REQUEST_VERSION_FILES: u32 = 6;
        U32_BYTES: usize = std::mem::size_of::<u32>();
        F64_BYTES: usize = std::mem::size_of::<f64>();
        // One request or one framed response, up to the largest single
        // wasm32 allocation; the parsed document shares the address space.
        MAX_BUFFER_BYTES: usize = evb_native_support::wasm_request_allocation::WASM_MAX_BUFFER_BYTES;
        RESPONSE_MUTATION: u32 = 1;
        RESPONSE_ANNOTATION_PARSE: u32 = 3;
        RESPONSE_JSON: u32 = 5;
        RESPONSE_TEXT_BOX_APPEARANCE: u32 = 6;
        // REPORTED_HEADER layout: a whole PDF and its CLI command's JSON report.
        RESPONSE_REPORTED_PDF: u32 = 8;
        // REPORTED_HEADER layout: the appended revision, empty when the pass
        // changed nothing, and its CLI command's JSON report.
        RESPONSE_REPORTED_INCREMENT: u32 = 9;
        // REPORTED_HEADER layout: a page's RGB rows, top-down, and a JSON report
        // of their width, height and sample compatibility, or no rows and the
        // reason the page has no scan raster.
        RESPONSE_REPORTED_RASTER: u32 = 10;
        // WRITTEN_HEADER layout: the page count and byte length of what the
        // engine wrote to the host's sink and verified there; for a save,
        // followed by its identity bindings as JSON.
        RESPONSE_WRITTEN: u32 = 11;
    }
    operations {
        // The five page-structure edits use FILE_REQUEST_HEADER framing.
        OP_DELETE_PAGES = 1 => "deletePages";
        OP_EXTRACT_PAGES = 2 => "extractPages";
        OP_REORDER_PAGES = 3 => "reorderPages";
        OP_INSERT_PAGES = 4 => "insertPages";
        OP_GET_PAGE_GEOMETRY = 8 => "getPageGeometry";
        OP_DECRYPT = 9 => "decrypt";
        // FILE_REQUEST_HEADER framing over source 0. Answers
        // RESPONSE_ANNOTATION_PARSE.
        OP_PARSE_ANNOTATIONS = 10 => "parseAnnotations";
        // FILE_REQUEST_HEADER framing followed by the UTF-8 JSON mutation
        // payload: appends a revision to source 0, whose file is the sink.
        // Source 1, when given, holds the original appearances to restore.
        OP_SAVE_MUTATIONS = 11 => "saveMutations";
        // FILE_REQUEST_HEADER framing over source 0. Answers RESPONSE_JSON.
        OP_READ_CATALOG = 12 => "readCatalog";
        // FILE_REQUEST_HEADER framing over source 0. Answers RESPONSE_JSON.
        OP_CONFORMANCE = 13 => "conformance";
        OP_MERGE_PAGES = 14 => "mergePages";
        // Selected pages use the page list; insertion data is UTF-8
        // "<view mode> <orientation>".
        OP_PRINT_LAYOUT = 15 => "printLayout";
        OP_TEXT_BOX_APPEARANCE = 16 => "textBoxAppearance";
        // FILE_REQUEST_HEADER framing over source 0; the page list selects
        // pages, then an empty tail or the UTF-8 flag "with-evb-ocr-text".
        // Answers RESPONSE_JSON.
        OP_OCR_TEXT_VISIBILITY = 17 => "ocrTextVisibility";
        // FILE_REQUEST_HEADER framing followed by the JSON instructions:
        // appends to source 0, whose file is the sink, from one Tesseract page
        // PDF per source after it. Answers WRITTEN_HEADER.
        OP_OCR_TEXT_LAYER = 18 => "ocrTextLayer";
        // The operations below use INSTRUCTED_REQUEST_HEADER framing.
        // No attachments. Answers RESPONSE_REPORTED_PDF.
        OP_SPLIT_PAGES = 19 => "splitPages";
        // Attaches the source PDF. Answers RESPONSE_REPORTED_PDF.
        OP_OVERLAY_TEXT = 20 => "overlayText";
        // No attachments. Answers RESPONSE_REPORTED_INCREMENT.
        OP_RECOMPRESS_IMAGES = 21 => "recompressImages";
        // Attaches the replacement PDFs. Answers RESPONSE_REPORTED_INCREMENT.
        OP_REPLACE_PAGE_IMAGES = 22 => "replacePageImages";
        // REQUEST_HEADER framing; the page list selects pages, none for every
        // page. Answers RESPONSE_JSON with each page's page-size record.
        OP_INSPECT_SCAN_CLEANUP_PDF = 23 => "inspectScanCleanupPdf";
        // No attachments; the instructions are the raster request. Answers
        // RESPONSE_REPORTED_RASTER.
        OP_RENDER_SCAN_CLEANUP_RASTER = 24 => "renderScanCleanupRaster";
        // FILE_REQUEST_HEADER framing with no sources or pages: verifies the
        // output of the edit before it, once the host has copied its streams.
        OP_VERIFY_WRITTEN = 25 => "verifyWritten";
        // FILE_REQUEST_HEADER framing over source 0. Answers RESPONSE_JSON
        // with the exact page geometry table (crop box, rotation, UserUnit).
        OP_READ_PAGE_SIZES = 26 => "readPageSizes";
        // FILE_REQUEST_HEADER framing over source 0. Answers RESPONSE_JSON
        // with `{"verdict": "appendable" | "repairable" | "limited" | "unverified"}`.
        OP_APPEND_ADMISSION = 27 => "appendAdmission";
        // REQUEST_HEADER framing: `page_number` is the document handle and
        // `data` is the PDF bytes. Parses once and caches the `Document` in
        // this WASM instance until closed or replaced. Answers RESPONSE_JSON.
        OP_OPEN_DOCUMENT = 28 => "openDocument";
        // REQUEST_HEADER framing: `page_number` is the document handle (0
        // clears any cached document). Answers RESPONSE_JSON.
        OP_CLOSE_DOCUMENT = 29 => "closeDocument";
        // REQUEST_HEADER framing: `page_number` is the cached document handle
        // and `insertion_data` is the JSON ScanRasterRequest. Answers
        // RESPONSE_REPORTED_RASTER.
        OP_RENDER_SCAN_CLEANUP_RASTER_CACHED = 30 => "renderScanCleanupRasterCached";
        // FILE_REQUEST_HEADER framing: like OP_SAVE_MUTATIONS, but the trailing
        // JSON payload uses the full NativeSaveReport shape (including
        // annotationDeleteEffects when available).
        OP_SAVE_MUTATIONS_REPORTED = 31 => "saveMutationsReported";
        // FILE_REQUEST_HEADER framing over source 0: streams JSONL annotation
        // parse output directly into the host sink. `pages` optionally restricts
        // to one-based page numbers; `tail` optionally carries UTF-8 modifiedAt.
        OP_PARSE_ANNOTATIONS_TO_SINK = 32 => "parseAnnotationsToSink";
        // FILE_REQUEST_HEADER framing over source 0: streams JSONL annotation
        // name index directly into the host sink.
        OP_ANNOTATION_NAME_INDEX = 33 => "annotationNameIndex";
        // FILE_REQUEST_HEADER framing over source 0: streams JSONL page-sizes
        // sidecar directly into the host sink. `after_page == 1` selects
        // metadata-only; `0` includes dominant raster image analysis.
        OP_READ_PAGE_SIZES_SIDECAR = 34 => "readPageSizesSidecar";
        // FILE_REQUEST_HEADER framing over source 0 with optional UTF-8 password
        // in `tail`: writes decrypted PDF to host sink only when encrypted and
        // rewritten, and answers RESPONSE_JSON with DecryptOutcomeReport.
        OP_DECRYPT_FILE = 35 => "decryptFile";
        // FILE_REQUEST_HEADER framing over source 0 with JSON instructions in
        // `tail`: appends recompressed image revision to host sink when changed
        // and answers WRITTEN_HEADER followed by JSON report.
        OP_RECOMPRESS_IMAGES_FILE = 36 => "recompressImagesFile";
        // FILE_REQUEST_HEADER framing over source 0 and replacement PDFs in
        // sources 1..source_count with JSON instructions in `tail`: appends
        // replacement revision to host sink when changed and answers
        // WRITTEN_HEADER followed by JSON report.
        OP_REPLACE_PAGE_IMAGES_FILE = 37 => "replacePageImagesFile";
        // FILE_REQUEST_HEADER framing over source 0 with JSON instructions in
        // `tail`: writes rewritten PDF (<= budget) or incremental revision
        // (> budget, reported via `incrementalRevision: true`) to host sink.
        OP_SPLIT_PAGES_FILE = 38 => "splitPagesFile";
        // FILE_REQUEST_HEADER framing over target (source 0) and original source
        // (source 1) with JSON instructions in `tail`: writes overlaid PDF to
        // host sink and answers WRITTEN_HEADER followed by JSON report.
        OP_OVERLAY_TEXT_FILE = 39 => "overlayTextFile";
        // FILE_REQUEST_HEADER framing over source 0 with UTF-8
        // "<view mode> <orientation>" in `tail`: writes laid-out print PDF to
        // host sink and answers WRITTEN_HEADER.
        OP_PRINT_LAYOUT_FILE = 40 => "printLayoutFile";
        // FILE_REQUEST_HEADER framing over source 0: streams JSONL embedded
        // shape index sidecar to host sink. Answers WRITTEN_HEADER.
        OP_EMBEDDED_SHAPE_INDEX = 41 => "embeddedShapeIndex";
        // FILE_REQUEST_HEADER framing over source 0: appends crop-box revision
        // to host sink. `pages` selects one-based pages; `after_page != 0` sets
        // physical points; `tail` is JSON `{top, bottom, left, right}`.
        OP_CROP_FILE = 42 => "cropFile";
        // FILE_REQUEST_HEADER framing over source 0: appends remove-crop
        // revision to host sink for one-based `pages`.
        OP_REMOVE_CROP_FILE = 43 => "removeCropFile";
    }
    layouts {
        REQUEST_HEADER: RequestHeader {
            magic: REQUEST_MAGIC.len(), version: U32_BYTES, operation: U32_BYTES,
            page_count: U32_BYTES, page_number: U32_BYTES,
            // For crop, angle is 0 for raw units or 1 for physical points.
            angle: U32_BYTES, top: F64_BYTES, bottom: F64_BYTES,
            left: F64_BYTES, right: F64_BYTES, data_length: U32_BYTES,
            insertion_data_length: U32_BYTES, password_length: U32_BYTES,
        }
        // Followed by the document, the UTF-8 JSON instructions, then each
        // attached PDF as a little-endian u32 length and its bytes.
        INSTRUCTED_REQUEST_HEADER: InstructedRequestHeader {
            magic: REQUEST_MAGIC.len(), version: U32_BYTES, operation: U32_BYTES,
            data_length: U32_BYTES, instructions_length: U32_BYTES,
            attachment_count: U32_BYTES,
        }
        // Followed by the page list. Delete, extract and reorder edit source 0
        // with the listed pages; insert puts source 1 after `after_page` of
        // source 0; merge joins every source in order.
        FILE_REQUEST_HEADER: FileRequestHeader {
            magic: REQUEST_MAGIC.len(), version: U32_BYTES, operation: U32_BYTES,
            source_count: U32_BYTES, after_page: U32_BYTES, page_count: U32_BYTES,
        }
        WRITTEN_HEADER: WrittenHeader {
            kind: U32_BYTES, page_count: U32_BYTES, length: F64_BYTES,
        }
        MUTATION_HEADER: MutationHeader {
            kind: U32_BYTES, page_count: U32_BYTES, data_length: U32_BYTES,
        }
        BYTES_HEADER: BytesHeader {
            kind: U32_BYTES, data_length: U32_BYTES,
        }
        // Followed by the data, then the UTF-8 JSON report.
        REPORTED_HEADER: ReportedHeader {
            kind: U32_BYTES, page_count: U32_BYTES, data_length: U32_BYTES,
            report_length: U32_BYTES,
        }
        TEXT_BOX_APPEARANCE_HEADER: TextBoxAppearanceHeader {
            kind: U32_BYTES, data_length: U32_BYTES, metadata_length: U32_BYTES,
        }
    }
}

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

#[cfg(test)]
fn generated_wire_schema() -> String {
    use crate::conformance::PdfConformanceFacts;
    use crate::decrypt::{
        DecryptOutcome, DecryptOutcomeReport, DECRYPT_OUTCOME_FORMAT,
        DECRYPT_OUTCOME_SCHEMA_VERSION,
    };
    use crate::page_sizes::{
        PAGE_SIZES_SIDECAR_CHUNK_BYTES, PAGE_SIZES_SIDECAR_FORMAT,
        PAGE_SIZES_SIDECAR_SCHEMA_VERSION,
    };
    use crate::AnnotationIdentityBinding;

    // Assert every generated field set and nullability against live serde
    // serialization of the authoritative Rust wire structs so Rust and
    // TypeScript can never drift.
    let assert_exact_keys = |value: &serde_json::Value, expected: &[&str], label: &str| {
        let map = value
            .as_object()
            .unwrap_or_else(|| panic!("{label} did not serialize to a JSON object"));
        let mut actual: Vec<&str> = map.keys().map(String::as_str).collect();
        actual.sort_unstable();
        let mut wanted: Vec<&str> = expected.to_vec();
        wanted.sort_unstable();
        assert_eq!(actual, wanted, "{label} wire keys drifted");
    };

    let conformance_json = serde_json::to_value(PdfConformanceFacts {
        is_signed: false,
        is_encrypted: false,
        is_tagged: false,
        has_acro_form: false,
        has_xfa: false,
    })
    .unwrap();
    assert_exact_keys(
        &conformance_json,
        &[
            "isSigned",
            "isEncrypted",
            "isTagged",
            "hasAcroForm",
            "hasXfa",
        ],
        "PdfConformanceFacts",
    );

    let decrypt_opened_json = serde_json::to_value(DecryptOutcomeReport {
        format: DECRYPT_OUTCOME_FORMAT.to_string(),
        schema_version: DECRYPT_OUTCOME_SCHEMA_VERSION,
        outcome: DecryptOutcome::Opened,
        was_encrypted: false,
        revision: None,
    })
    .unwrap();
    assert_exact_keys(
        &decrypt_opened_json,
        &[
            "format",
            "schemaVersion",
            "outcome",
            "wasEncrypted",
            "revision",
        ],
        "DecryptOutcomeReport(opened)",
    );
    assert_eq!(decrypt_opened_json["outcome"], "opened");
    assert!(decrypt_opened_json["revision"].is_null());

    let decrypt_rewritten_some = serde_json::to_value(DecryptOutcomeReport {
        format: DECRYPT_OUTCOME_FORMAT.to_string(),
        schema_version: DECRYPT_OUTCOME_SCHEMA_VERSION,
        outcome: DecryptOutcome::Rewritten,
        was_encrypted: true,
        revision: Some(6),
    })
    .unwrap();
    assert_exact_keys(
        &decrypt_rewritten_some,
        &[
            "format",
            "schemaVersion",
            "outcome",
            "wasEncrypted",
            "revision",
        ],
        "DecryptOutcomeReport(rewritten/some)",
    );
    assert_eq!(decrypt_rewritten_some["outcome"], "rewritten");
    assert_eq!(decrypt_rewritten_some["revision"], 6);

    let decrypt_rewritten_none = serde_json::to_value(DecryptOutcomeReport {
        format: DECRYPT_OUTCOME_FORMAT.to_string(),
        schema_version: DECRYPT_OUTCOME_SCHEMA_VERSION,
        outcome: DecryptOutcome::Rewritten,
        was_encrypted: true,
        revision: None,
    })
    .unwrap();
    assert_exact_keys(
        &decrypt_rewritten_none,
        &[
            "format",
            "schemaVersion",
            "outcome",
            "wasEncrypted",
            "revision",
        ],
        "DecryptOutcomeReport(rewritten/none)",
    );
    assert!(decrypt_rewritten_none["revision"].is_null());

    let binding_json = serde_json::to_value(AnnotationIdentityBinding {
        annotation_id: "ann-1".to_string(),
        pdf_ref: "1 0 R".to_string(),
    })
    .unwrap();
    assert_exact_keys(
        &binding_json,
        &["annotationId", "pdfRef"],
        "AnnotationIdentityBinding",
    );

    let report_without_effects: serde_json::Value = serde_json::from_slice(
        &crate::serialize_native_save_report(
            &[AnnotationIdentityBinding {
                annotation_id: "ann-1".to_string(),
                pdf_ref: "1 0 R".to_string(),
            }],
            None,
        )
        .unwrap(),
    )
    .unwrap();
    let bare_bindings = report_without_effects
        .as_array()
        .expect("NativeSaveReport(no delete effects) must serialize to a JSON array");
    assert_eq!(bare_bindings.len(), 1);
    assert_exact_keys(
        &bare_bindings[0],
        &["annotationId", "pdfRef"],
        "NativeSaveReport(no delete effects)[0]",
    );

    let report_with_effects: serde_json::Value = serde_json::from_slice(
        &crate::serialize_native_save_report(
            &[],
            Some(&crate::AnnotationDeleteEffects {
                affected_page_indices: vec![0],
                deleted_reply_refs: vec!["2 0 R".to_string()],
            }),
        )
        .unwrap(),
    )
    .unwrap();
    assert_exact_keys(
        &report_with_effects,
        &["identityBindings", "annotationDeleteEffects"],
        "NativeSaveReport(with delete effects)",
    );
    assert_exact_keys(
        &report_with_effects["annotationDeleteEffects"],
        &["affectedPageIndices", "deletedReplyRefs"],
        "AnnotationDeleteEffects",
    );

    format!(
        "// Generated from evb-pdf-page-ops Rust wire structs; do not edit.\n\
         // Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops generated_wire_schema`.\n\n\
         export const PDF_DECRYPT_OUTCOME_FORMAT = '{DECRYPT_OUTCOME_FORMAT}' as const;\n\
         export const PDF_DECRYPT_OUTCOME_SCHEMA_VERSION = {DECRYPT_OUTCOME_SCHEMA_VERSION} as const;\n\
         export const PDF_PAGE_SIZES_SIDECAR_FORMAT = '{PAGE_SIZES_SIDECAR_FORMAT}' as const;\n\
         export const PDF_PAGE_SIZES_SIDECAR_SCHEMA_VERSION = {PAGE_SIZES_SIDECAR_SCHEMA_VERSION} as const;\n\
         export const PDF_PAGE_SIZES_SIDECAR_CHUNK_BYTES = {PAGE_SIZES_SIDECAR_CHUNK_BYTES} as const;\n\n\
         export interface IPdfConformanceFactsWire {{\n\
         \x20   isSigned: boolean;\n\
         \x20   isEncrypted: boolean;\n\
         \x20   isTagged: boolean;\n\
         \x20   hasAcroForm: boolean;\n\
         \x20   hasXfa: boolean;\n\
         }}\n\n\
         export type TPdfDecryptOutcomeWire =\n\
         \x20   | {{\n\
         \x20       format: typeof PDF_DECRYPT_OUTCOME_FORMAT;\n\
         \x20       schemaVersion: typeof PDF_DECRYPT_OUTCOME_SCHEMA_VERSION;\n\
         \x20       outcome: 'opened';\n\
         \x20       wasEncrypted: false;\n\
         \x20       revision: null;\n\
         \x20   }}\n\
         \x20   | {{\n\
         \x20       format: typeof PDF_DECRYPT_OUTCOME_FORMAT;\n\
         \x20       schemaVersion: typeof PDF_DECRYPT_OUTCOME_SCHEMA_VERSION;\n\
         \x20       outcome: 'rewritten';\n\
         \x20       wasEncrypted: true;\n\
         \x20       revision: number | null;\n\
         \x20   }};\n\n\
         export interface IPdfAnnotationIdentityBindingWire {{\n\
         \x20   annotationId: string;\n\
         \x20   pdfRef: string;\n\
         }}\n\n\
         export interface IPdfAnnotationDeleteEffectsWire {{\n\
         \x20   affectedPageIndices: number[];\n\
         \x20   deletedReplyRefs: string[];\n\
         }}\n\n\
         export type TPdfNativeSaveReportWire =\n\
         \x20   | IPdfAnnotationIdentityBindingWire[]\n\
         \x20   | {{\n\
         \x20       identityBindings: IPdfAnnotationIdentityBindingWire[];\n\
         \x20       annotationDeleteEffects: IPdfAnnotationDeleteEffectsWire;\n\
         \x20   }};\n\n\
         export type TPdfAppendAdmissionVerdictWire = 'appendable' | 'repairable' | 'limited' | 'unverified';\n\n\
         export type TPdfDesktopAppendAdmissionWire =\n\
         \x20   | {{\n\
         \x20       verdict: 'appendable';\n\
         \x20       reason: null;\n\
         \x20   }}\n\
         \x20   | {{\n\
         \x20       verdict: Exclude<TPdfAppendAdmissionVerdictWire, 'appendable'>;\n\
         \x20       reason: string;\n\
         \x20   }};\n"
    )
}

#[test]
fn generated_wire_schema_is_current() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/pdfPageOpsWire.generated.ts");
    let current = generated_wire_schema();
    if std::env::var_os("EVB_UPDATE_GENERATED").is_some() {
        std::fs::write(&path, current).unwrap();
        return;
    }
    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        checked_in == current,
        "{} is stale; regenerate it with EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops generated_wire_schema",
        path.display()
    );
}

pub(crate) struct ParsedRequest<'a> {
    pub(crate) operation: u32,
    pub(crate) pages: Vec<u32>,
    pub(crate) page_number: u32,
    pub(crate) data: &'a [u8],
    pub(crate) insertion_data: &'a [u8],
    pub(crate) password: &'a [u8],
}

pub(crate) fn parse_request(request: &[u8]) -> Result<ParsedRequest<'_>> {
    let mut offset = REQUEST_HEADER.magic;
    let magic = take_bytes(request, &mut offset, REQUEST_MAGIC.len())?;
    if magic != REQUEST_MAGIC {
        return Err("Invalid page-op WASM request magic".into());
    }
    let version = read_u32_at(request, REQUEST_HEADER.version)?;
    if version != REQUEST_VERSION {
        return Err(format!("Unsupported page-op WASM request version: {version}").into());
    }

    let operation = read_u32_at(request, REQUEST_HEADER.operation)?;
    let page_count = read_usize_at(request, REQUEST_HEADER.page_count, "page_count")?;
    let page_number = read_u32_at(request, REQUEST_HEADER.page_number)?;
    let _angle = read_u32_at(request, REQUEST_HEADER.angle)?;
    let _top = read_f64_at(request, REQUEST_HEADER.top)?;
    let _bottom = read_f64_at(request, REQUEST_HEADER.bottom)?;
    let _left = read_f64_at(request, REQUEST_HEADER.left)?;
    let _right = read_f64_at(request, REQUEST_HEADER.right)?;
    let data_len = read_usize_at(request, REQUEST_HEADER.data_length, "data_len")?;
    let insertion_data_len = read_usize_at(
        request,
        REQUEST_HEADER.insertion_data_length,
        "insertion_data_len",
    )?;
    let password_len = read_usize_at(request, REQUEST_HEADER.password_length, "password_len")?;
    let mut offset = REQUEST_HEADER.bytes;
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
        data,
        insertion_data,
        password,
    })
}

pub(crate) struct ParsedInstructedRequest<'a> {
    pub(crate) operation: u32,
    pub(crate) data: &'a [u8],
    pub(crate) instructions: &'a [u8],
    pub(crate) attachments: Vec<&'a [u8]>,
}

/// Whether `request` uses INSTRUCTED_REQUEST_HEADER framing.
pub(crate) fn is_instructed_request(request: &[u8]) -> bool {
    request.get(INSTRUCTED_REQUEST_HEADER.magic..INSTRUCTED_REQUEST_HEADER.version)
        == Some(REQUEST_MAGIC.as_slice())
        && read_u32_at(request, INSTRUCTED_REQUEST_HEADER.version)
            .is_ok_and(|version| version == REQUEST_VERSION_INSTRUCTED)
}

pub(crate) fn parse_instructed_request(request: &[u8]) -> Result<ParsedInstructedRequest<'_>> {
    let mut offset = INSTRUCTED_REQUEST_HEADER.magic;
    if take_bytes(request, &mut offset, REQUEST_MAGIC.len())? != REQUEST_MAGIC
        || read_u32_at(request, INSTRUCTED_REQUEST_HEADER.version)? != REQUEST_VERSION_INSTRUCTED
    {
        return Err("Invalid page-op WASM instructed request framing".into());
    }
    let operation = read_u32_at(request, INSTRUCTED_REQUEST_HEADER.operation)?;
    let attachments = match operation {
        // One per page; the request's own bytes bound the count below.
        OP_REPLACE_PAGE_IMAGES => 0..=usize::MAX,
        OP_OVERLAY_TEXT => 1..=1,
        OP_SPLIT_PAGES | OP_RECOMPRESS_IMAGES | OP_RENDER_SCAN_CLEANUP_RASTER => 0..=0,
        _ => {
            return Err(
                format!("Page-op WASM operation {operation} takes no instructed framing").into(),
            )
        }
    };
    let data_len = read_usize_at(request, INSTRUCTED_REQUEST_HEADER.data_length, "data_len")?;
    let instructions_len = read_usize_at(
        request,
        INSTRUCTED_REQUEST_HEADER.instructions_length,
        "instructions_len",
    )?;
    let attachment_count = read_usize_at(
        request,
        INSTRUCTED_REQUEST_HEADER.attachment_count,
        "attachment count",
    )?;
    if !attachments.contains(&attachment_count) {
        return Err(format!(
            "Invalid page-op WASM attachment count {attachment_count} for operation {operation}"
        )
        .into());
    }
    let mut offset = INSTRUCTED_REQUEST_HEADER.bytes;
    let data = take_bytes(request, &mut offset, data_len)?;
    let instructions = take_bytes(request, &mut offset, instructions_len)?;
    // Every attachment carries at least its length, so a count the request
    // cannot hold fails before anything is reserved.
    if attachment_count > (request.len() - offset) / U32_BYTES {
        return Err("Truncated page-op WASM request".into());
    }
    let mut attached = Vec::with_capacity(attachment_count);
    for _ in 0..attachment_count {
        let len = read_usize_le(request, &mut offset, "attachment length")?;
        attached.push(take_bytes(request, &mut offset, len)?);
    }
    if offset != request.len() {
        return Err("Trailing bytes in page-op WASM request".into());
    }
    Ok(ParsedInstructedRequest {
        operation,
        data,
        instructions,
        attachments: attached,
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
    if framed_len > MAX_BUFFER_BYTES {
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
