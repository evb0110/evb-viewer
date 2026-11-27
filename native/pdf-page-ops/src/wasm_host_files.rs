//! Files the host holds for the engine: sources read by range and one
//! sink the edit writes and then verifies. wasm32 memory cannot hold a large
//! document, so only objects cross into it, as the reader asks for them.
//! A page-structure edit reads no stream data: each copy is left to the
//! host, which copies stream ranges asynchronously or via positional fd I/O,
//! and a second request verifies the output once the host has copied the
//! streams. A save appends to its source's own file and reads only the few
//! streams a mutation reuses, by range.
use super::*;
use crate::wasm_abi::*;
use std::{
    cell::{Cell, RefCell},
    io,
};

// Offsets are f64 so that the host needs no BigInt; they are exact below 2^53.
#[link(wasm_import_module = "evb_host")]
extern "C" {
    fn evb_host_source_len(source: u32) -> f64;
    fn evb_host_source_read(source: u32, offset: f64, pointer: *mut u8, len: usize) -> i32;
    /// Asks the host to copy `len` bytes of `source` at `offset` to the sink at `at`.
    fn evb_host_source_copy(source: u32, offset: f64, len: f64, at: f64) -> i32;
    fn evb_host_sink_write(at: f64, pointer: *const u8, len: usize) -> i32;
    fn evb_host_sink_read(offset: f64, pointer: *mut u8, len: usize) -> i32;
}

/// Bounded LRU capacity for cached single-open OCR visibility sessions per WASM
/// instance so multi-window desktop search parses each source graph once while
/// keeping WASM memory bounded.
const MAX_CACHED_VISIBILITY_SESSIONS: usize = 4;

thread_local! {
    /// The length of the sink, including the copies the host still has to make.
    static SINK_LEN: Cell<u64> = const { Cell::new(0) };
    /// An edit written and awaiting its host's copies, then OP_VERIFY_WRITTEN.
    static WRITTEN: RefCell<Option<(Vec<SourcePdf<HostSource>>, PageSubset)>> = const { RefCell::new(None) };
    /// Single-open OCR text visibility sessions keyed by caller session id (LRU at front).
    static VISIBILITY_SESSIONS: RefCell<Vec<(u32, OcrTextVisibilitySession<HostSource>)>> =
        const { RefCell::new(Vec::new()) };
}

fn host_result(status: i32) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::other(
            "The host could not read or write the file",
        ))
    }
}

/// The host's source file `index`: the document, or a PDF to insert or merge.
pub(crate) struct HostSource(u32);

impl ByteSource for HostSource {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        // SAFETY: the host writes at most `buffer.len()` bytes at its pointer.
        host_result(unsafe {
            evb_host_source_read(self.0, offset as f64, buffer.as_mut_ptr(), buffer.len())
        })
    }

    /// Stream data goes only to the sink: `output` is flushed into it, and the
    /// range is appended there by the host.
    fn copy_range(&self, offset: u64, len: u64, output: &mut impl Write) -> io::Result<()> {
        output.flush()?;
        let at = SINK_LEN.get();
        // SAFETY: a plain call; the host records the copy.
        host_result(unsafe { evb_host_source_copy(self.0, offset as f64, len as f64, at as f64) })?;
        SINK_LEN.set(at + len);
        Ok(())
    }
}

/// The host's output file, written from its start.
struct HostSink;

impl Write for HostSink {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let at = SINK_LEN.get();
        // SAFETY: the host reads `buffer.len()` bytes at its pointer.
        host_result(unsafe { evb_host_sink_write(at as f64, buffer.as_ptr(), buffer.len()) })?;
        SINK_LEN.set(at + buffer.len() as u64);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl ByteSource for HostSink {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        // SAFETY: the host writes at most `buffer.len()` bytes at its pointer.
        host_result(unsafe { evb_host_sink_read(offset as f64, buffer.as_mut_ptr(), buffer.len()) })
    }

    fn copy_range(&self, _offset: u64, _len: u64, _output: &mut impl Write) -> io::Result<()> {
        Err(io::Error::other("The output is not copied from"))
    }
}

/// Whether `request` uses FILE_REQUEST_HEADER framing.
pub(crate) fn is_file_request(request: &[u8]) -> bool {
    request.get(FILE_REQUEST_HEADER.magic..FILE_REQUEST_HEADER.version)
        == Some(REQUEST_MAGIC.as_slice())
        && read_u32_at(request, FILE_REQUEST_HEADER.version)
            .is_ok_and(|version| version == REQUEST_VERSION_FILES)
}

/// Runs a FILE_REQUEST_HEADER request. An edit answers WRITTEN_HEADER, and
/// the host completes its output with the copies it was asked for before
/// OP_VERIFY_WRITTEN checks that output as desktop checks its file. A save
/// or an OCR text layer appends its revision to source 0 in one request; a
/// read of source 0 answers as its byte-request form did.
pub(crate) fn run_file_request(request: &[u8]) -> Result<Vec<u8>> {
    let written = WRITTEN.take();
    let operation = read_u32_at(request, FILE_REQUEST_HEADER.operation)?;
    if operation != OP_VERIFY_WRITTEN {
        SINK_LEN.set(0);
    }
    let source_count = read_u32_at(request, FILE_REQUEST_HEADER.source_count)?;
    let after_page = read_u32_at(request, FILE_REQUEST_HEADER.after_page)?;
    let page_list_len = read_usize_at(request, FILE_REQUEST_HEADER.page_count, "page_count")?
        .checked_mul(U32_BYTES)
        .ok_or("Invalid page-op WASM page count")?;
    let tail_start = FILE_REQUEST_HEADER
        .bytes
        .checked_add(page_list_len)
        .filter(|end| *end <= request.len())
        .ok_or("Invalid page-op WASM file request length")?;
    let pages = request[FILE_REQUEST_HEADER.bytes..tail_start]
        .chunks_exact(U32_BYTES)
        .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect::<Vec<_>>();
    let tail = &request[tail_start..];
    match operation {
        OP_SAVE_MUTATIONS => return save_mutations(after_page, tail, source_count, false),
        OP_SAVE_MUTATIONS_REPORTED => return save_mutations(after_page, tail, source_count, true),
        OP_OCR_TEXT_LAYER => return ocr_text_layer(after_page, tail, source_count),
        OP_PARSE_ANNOTATIONS_TO_SINK => {
            return parse_annotations_to_sink(&pages, tail, source_count)
        }
        OP_ANNOTATION_NAME_INDEX => {
            return annotation_name_index_to_sink(&pages, tail, source_count)
        }
        OP_READ_PAGE_SIZES_SIDECAR => {
            return read_page_sizes_sidecar_to_sink(after_page != 0, &pages, tail, source_count)
        }
        OP_DECRYPT_FILE => return decrypt_file(&pages, tail, source_count),
        OP_RECOMPRESS_IMAGES_FILE => return recompress_images_file(&pages, tail, source_count),
        OP_REPLACE_PAGE_IMAGES_FILE => return replace_page_images_file(&pages, tail, source_count),
        OP_SPLIT_PAGES_FILE => return split_pages_file(&pages, tail, source_count),
        OP_OVERLAY_TEXT_FILE => return overlay_text_file(&pages, tail, source_count),
        OP_PRINT_LAYOUT_FILE => return print_layout_file(&pages, tail, source_count),
        OP_EMBEDDED_SHAPE_INDEX => return embedded_shape_index_to_sink(&pages, tail, source_count),
        OP_CROP_FILE => return crop_file(after_page != 0, &pages, tail, source_count),
        OP_REMOVE_CROP_FILE => return remove_crop_file(&pages, tail, source_count),
        OP_GET_PAGE_GEOMETRY
        | OP_PARSE_ANNOTATIONS
        | OP_READ_CATALOG
        | OP_CONFORMANCE
        | OP_OCR_TEXT_VISIBILITY
        | OP_READ_PAGE_SIZES
        | OP_APPEND_ADMISSION => {
            return read_source(operation, after_page, &pages, tail, source_count)
        }
        _ if !tail.is_empty() => return Err("Invalid page-op WASM file request length".into()),
        _ => {}
    }
    let edit = match operation {
        OP_VERIFY_WRITTEN => {
            let (sources, subset) =
                written.ok_or("No page-structure output awaits verification")?;
            subset.verify(&sources, &HostSink, SINK_LEN.get())?;
            return Ok(written_response(subset.page_count, SINK_LEN.get()));
        }
        OP_DELETE_PAGES => PageStructureEdit::Delete(&pages),
        OP_EXTRACT_PAGES => PageStructureEdit::Extract(&pages),
        OP_REORDER_PAGES => PageStructureEdit::Reorder(&pages),
        OP_INSERT_PAGES => PageStructureEdit::Insert { after_page },
        OP_MERGE_PAGES => PageStructureEdit::Merge,
        operation => {
            return Err(format!("Page-op WASM operation {operation} takes no file framing").into())
        }
    };
    let sources = open_page_structure_sources(
        (0..source_count).map(|index| Ok((HostSource(index), host_source_len(index)?))),
    )?;
    let subset = edit_page_structure(edit, &sources)?;
    SINK_LEN.set(0);
    subset
        .write(&sources, io::BufWriter::with_capacity(1 << 20, HostSink))?
        .into_inner()
        .map_err(|error| io_domain_error(error.into_error()))?;
    let response = written_response(subset.page_count, SINK_LEN.get());
    WRITTEN.set(Some((sources, subset)));
    Ok(response)
}

/// Reads source 0, the one source a read takes (or closes a cached visibility session).
fn read_source(
    operation: u32,
    after_page: u32,
    pages: &[u32],
    tail: &[u8],
    source_count: u32,
) -> Result<Vec<u8>> {
    if operation == OP_OCR_TEXT_VISIBILITY
        && after_page != 0
        && source_count == 0
        && pages.is_empty()
        && tail == b"close"
    {
        VISIBILITY_SESSIONS.with(|sessions| {
            sessions.borrow_mut().retain(|(id, _)| *id != after_page);
        });
        return encode_bytes(RESPONSE_JSON, b"{}".to_vec());
    }
    let valid_shape = source_count == 1
        && match operation {
            OP_OCR_TEXT_VISIBILITY => true,
            OP_READ_CATALOG => pages.is_empty(),
            OP_GET_PAGE_GEOMETRY => pages.len() == 1 && tail.is_empty(),
            _ => pages.is_empty() && tail.is_empty(),
        };
    if !valid_shape {
        return Err("A read takes one source and no other input".into());
    }
    let len = host_source_len(0)?;
    match operation {
        OP_GET_PAGE_GEOMETRY => encode_bytes(
            RESPONSE_JSON,
            serde_json::to_vec(&get_page_geometry_from_source(
                HostSource(0),
                len,
                pages[0],
            )?)?,
        ),
        OP_READ_PAGE_SIZES => {
            encode_bytes(RESPONSE_JSON, read_page_geometry_table(HostSource(0), len)?)
        }
        OP_APPEND_ADMISSION => {
            let admission = if after_page == 0 {
                append_admission_of_source(HostSource(0), len)?
            } else {
                append_admission_of_source_desktop(HostSource(0), len)?
            };
            let json = match admission {
                AppendAdmission::Appendable => {
                    if after_page == 0 {
                        serde_json::json!({ "verdict": "appendable" })
                    } else {
                        serde_json::json!({ "verdict": "appendable", "reason": null })
                    }
                }
                AppendAdmission::Repairable(reason) => {
                    if after_page == 0 {
                        serde_json::json!({ "verdict": "repairable" })
                    } else {
                        serde_json::json!({ "verdict": "repairable", "reason": reason })
                    }
                }
                AppendAdmission::Limited(reason) => {
                    if after_page == 0 {
                        serde_json::json!({ "verdict": "limited" })
                    } else {
                        serde_json::json!({ "verdict": "limited", "reason": reason })
                    }
                }
                AppendAdmission::Unverified(reason) => {
                    if after_page == 0 {
                        serde_json::json!({ "verdict": "unverified" })
                    } else {
                        serde_json::json!({ "verdict": "unverified", "reason": reason })
                    }
                }
            };
            encode_bytes(RESPONSE_JSON, serde_json::to_vec(&json)?)
        }
        OP_PARSE_ANNOTATIONS => encode_bytes(
            RESPONSE_ANNOTATION_PARSE,
            annotation_parse_from_source(
                HostSource(0),
                len,
                PAGE_OP_WASM_MAX_BUFFER_BYTES - BYTES_HEADER.bytes,
            )?,
        ),
        OP_READ_CATALOG => {
            let source = &SourcePdf::open(HostSource(0), len)?.document;
            let catalog = if tail.is_empty() {
                read_pdf_document_catalog(source)
            } else {
                let mutations: NativeMutationsFile =
                    parse_json_sidecar_bytes(tail, "native mutations")?;
                let mut bookmarks = mutations.bookmarks.ok_or("Missing bookmarks")?;
                outline::names::resolve_bookmark_source_targets(source, &mut bookmarks.items)?;
                serde_json::json!({ "bookmarks": bookmarks.items })
            };
            encode_bytes(RESPONSE_JSON, serde_json::to_vec(&catalog)?)
        }
        OP_CONFORMANCE => {
            let source = if after_page != 0 {
                SourcePdf::open_strict_verify(HostSource(0), len)?
            } else {
                SourcePdf::open_conformance(HostSource(0), len)?
            };
            encode_bytes(
                RESPONSE_JSON,
                serde_json::to_vec(&pdf_conformance_facts(&source.document)?)?,
            )
        }
        _ => {
            let with_evb_ocr_text = match tail {
                b"" => false,
                b"with-evb-ocr-text" => true,
                _ => return Err("OCR text visibility takes no option but with-evb-ocr-text".into()),
            };
            let report = if after_page == 0 {
                ocr_text_visibility_from_source(HostSource(0), len, pages, with_evb_ocr_text)?
            } else {
                let cached = VISIBILITY_SESSIONS.with(|sessions| {
                    let mut sessions = sessions.borrow_mut();
                    sessions
                        .iter()
                        .position(|(id, _)| *id == after_page)
                        .map(|index| sessions.remove(index).1)
                });
                let mut session = match cached {
                    Some(session) if session.source_len() == len => session,
                    _ => OcrTextVisibilitySession::open(HostSource(0), len)?,
                };
                let report = session.inspect_pages_json(pages, with_evb_ocr_text)?;
                VISIBILITY_SESSIONS.with(|sessions| {
                    let mut sessions = sessions.borrow_mut();
                    sessions.retain(|(id, _)| *id != after_page);
                    if sessions.len() >= MAX_CACHED_VISIBILITY_SESSIONS {
                        sessions.remove(0);
                    }
                    sessions.push((after_page, session));
                });
                report
            };
            encode_bytes(RESPONSE_JSON, report)
        }
    }
}

fn parse_annotations_to_sink(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1 {
        return Err("Annotation parse takes one source".into());
    }
    let modified_at = if tail.is_empty() {
        "D:19700101000000Z"
    } else {
        std::str::from_utf8(tail).map_err(|_| "modifiedAt must be UTF-8 text")?
    };
    let len = host_source_len(0)?;
    SINK_LEN.set(0);
    let page_slice = if pages.is_empty() { None } else { Some(pages) };
    let page_count =
        write_annotation_parse_from_source(HostSource(0), len, modified_at, page_slice, |bytes| {
            HostSink.write_all(bytes).map_err(io_domain_error)
        })?;
    Ok(written_response(page_count, SINK_LEN.get()))
}

fn annotation_name_index_to_sink(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1 || !pages.is_empty() || !tail.is_empty() {
        return Err("Annotation name index takes one source and no other input".into());
    }
    let len = host_source_len(0)?;
    SINK_LEN.set(0);
    let page_count = write_annotation_name_index_to_sink(HostSource(0), len, |bytes| {
        HostSink.write_all(bytes).map_err(io_domain_error)
    })?;
    Ok(written_response(page_count, SINK_LEN.get()))
}

fn read_page_sizes_sidecar_to_sink(
    metadata_only: bool,
    pages: &[u32],
    tail: &[u8],
    source_count: u32,
) -> Result<Vec<u8>> {
    if source_count != 1 || !pages.is_empty() || !tail.is_empty() {
        return Err("Page sizes sidecar takes one source and no other input".into());
    }
    let len = host_source_len(0)?;
    SINK_LEN.set(0);
    let page_count =
        write_page_sizes_sidecar_to_sink(HostSource(0), len, metadata_only, |bytes| {
            HostSink.write_all(bytes).map_err(io_domain_error)
        })?;
    Ok(written_response(page_count, SINK_LEN.get()))
}

fn decrypt_file(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1 || !pages.is_empty() {
        return Err("Decrypt takes one source and optional password bytes".into());
    }
    if tail.len() > MAX_WASM_PASSWORD_BYTES {
        return Err(format!(
            "Page-op WASM password exceeds the {MAX_WASM_PASSWORD_BYTES}-byte ceiling"
        )
        .into());
    }
    let password = if tail.is_empty() {
        None
    } else {
        Some(std::str::from_utf8(tail).map_err(|_| {
            domain_error(
                NativeErrorCode::InvalidRequest,
                "PDF password must be UTF-8 text",
            )
        })?)
    };
    let len = host_source_len(0)?;
    SINK_LEN.set(0);
    let mut writer = io::BufWriter::with_capacity(1 << 20, HostSink);
    let report = decrypt_source_to_sink(HostSource(0), len, password, &mut writer)?;
    writer
        .into_inner()
        .map_err(|error| io_domain_error(error.into_error()))?;
    encode_bytes(RESPONSE_JSON, serde_json::to_vec(&report)?)
}

fn recompress_images_file(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1 || !pages.is_empty() {
        return Err("recompress-images takes one source and JSON instructions".into());
    }
    let len = host_source_len(0)?;
    SINK_LEN.set(len);
    let (page_count, report) = recompress_images_to_source(HostSource(0), len, tail, |revision| {
        append_to_source_file(len, revision)
    })?;
    let mut response = written_response(page_count, SINK_LEN.get());
    response.extend(report);
    Ok(response)
}

fn replace_page_images_file(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count < 1 || !pages.is_empty() {
        return Err("replace-page-images takes a source and JSON instructions".into());
    }
    let len = host_source_len(0)?;
    SINK_LEN.set(len);
    let (page_count, report) = replace_page_images_to_source(
        HostSource(0),
        len,
        tail,
        |index| {
            let source = u32::try_from(index)
                .ok()
                .and_then(|index| index.checked_add(1))
                .filter(|source| *source < source_count)
                .ok_or_else(|| {
                    domain_error(
                        NativeErrorCode::InvalidRequest,
                        "replace-page-images names a replacement PDF the request does not carry",
                    )
                })?;
            let rep_len = host_source_len(source)?;
            if rep_len > MAX_ENCODED_PDF_BYTES as u64 {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Replacement PDF exceeds the byte admission ceiling",
                ));
            }
            let mut bytes = vec![0; rep_len as usize];
            HostSource(source)
                .read_at(0, &mut bytes)
                .map_err(io_domain_error)?;
            Ok(bytes)
        },
        |revision| append_to_source_file(len, revision),
    )?;
    let mut response = written_response(page_count, SINK_LEN.get());
    response.extend(report);
    Ok(response)
}

fn split_pages_file(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1 || !pages.is_empty() {
        return Err("split-pages takes one source and JSON instructions".into());
    }
    let len = host_source_len(0)?;
    SINK_LEN.set(0);
    let mut writer = io::BufWriter::with_capacity(1 << 20, HostSink);
    let (page_count, report) =
        split_pages_to_sink(HostSource(0), len, tail, &mut writer, |revision| {
            append_to_source_file(len, revision)
        })?;
    writer
        .into_inner()
        .map_err(|error| io_domain_error(error.into_error()))?;
    let mut response = written_response(page_count, SINK_LEN.get());
    response.extend(report);
    Ok(response)
}

fn overlay_text_file(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 2 || !pages.is_empty() {
        return Err("overlay-text takes target and original sources plus JSON instructions".into());
    }
    let target_len = host_source_len(0)?;
    let orig_len = host_source_len(1)?;
    SINK_LEN.set(0);
    let mut writer = io::BufWriter::with_capacity(1 << 20, HostSink);
    let (page_count, report) = overlay_text_to_sink(
        || HostSource(0),
        target_len,
        || HostSource(1),
        orig_len,
        || HostSink,
        tail,
        &mut writer,
        append_overlay_to_source_file,
    )?;
    writer
        .into_inner()
        .map_err(|error| io_domain_error(error.into_error()))?;
    let mut response = written_response(page_count, SINK_LEN.get());
    response.extend(report);
    Ok(response)
}

fn embedded_shape_index_to_sink(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1 || !pages.is_empty() || !tail.is_empty() {
        return Err("Embedded shape index takes one source and no other input".into());
    }
    let len = host_source_len(0)?;
    SINK_LEN.set(0);
    let page_count = write_embedded_shape_index_to_sink(HostSource(0), len, |bytes| {
        HostSink.write_all(bytes).map_err(io_domain_error)
    })?;
    Ok(written_response(page_count, SINK_LEN.get()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CropMarginsPayload {
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
}

fn crop_file(physical: bool, pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1 || pages.is_empty() {
        return Err("crop takes one source and at least one page".into());
    }
    let payload: CropMarginsPayload = parse_json_sidecar_bytes(tail, "crop margins")?;
    let margins = CropMargins {
        physical,
        top: payload.top,
        bottom: payload.bottom,
        left: payload.left,
        right: payload.right,
    };
    let len = host_source_len(0)?;
    let page_count = crop_pages_to_source(HostSource(0), len, pages, margins, |revision| {
        append_to_source_file(len, revision)
    })?;
    Ok(written_response(page_count, SINK_LEN.get()))
}

fn remove_crop_file(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1 || pages.is_empty() || !tail.is_empty() {
        return Err("remove-crop takes one source and at least one page".into());
    }
    let len = host_source_len(0)?;
    let page_count = remove_crop_from_pages_to_source(HostSource(0), len, pages, |revision| {
        append_to_source_file(len, revision)
    })?;
    Ok(written_response(page_count, SINK_LEN.get()))
}

fn print_layout_file(pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1 {
        return Err("print-layout takes one source".into());
    }
    let options =
        std::str::from_utf8(tail).map_err(|_| "Print layout options must be UTF-8 text")?;
    let (view_mode, orientation) = options
        .split_once(' ')
        .ok_or("Print layout options need a view mode and an orientation")?;
    let parsed_view = PrintViewMode::parse(view_mode)?;
    let parsed_orientation = PrintOrientation::parse(orientation)?;
    let len = host_source_len(0)?;
    if pages.is_empty()
        && (parsed_view, parsed_orientation) == (PrintViewMode::Single, PrintOrientation::Auto)
    {
        SINK_LEN.set(0);
        let (pages_out, changed) =
            print_layout::write_print_appearances_to_source(HostSource(0), len, |revision| {
                append_to_source_file(len, revision)
            })?;
        return Ok(written_response(
            pages_out,
            if changed { SINK_LEN.get() } else { 0 },
        ));
    }
    if len > PRINT_LAYOUT_LOAD_POLICY.max_encoded_bytes() as u64 {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "PDF input exceeds the print-layout byte ceiling",
        ));
    }
    let len_usize = usize::try_from(len)?;
    let mut data = Vec::new();
    data.try_reserve_exact(len_usize).map_err(|_| {
        domain_error(
            NativeErrorCode::TooLarge,
            "PDF input exceeds available memory",
        )
    })?;
    data.resize(len_usize, 0);
    HostSource(0)
        .read_at(0, &mut data)
        .map_err(io_domain_error)?;
    let mut document = load_pdf_bytes_with_policy(&data, PRINT_LAYOUT_LOAD_POLICY)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    let selected = if pages.is_empty() { None } else { Some(pages) };
    build_print_layout(&mut document, selected, parsed_view, parsed_orientation)?;
    let pages_out = page_count(&document);
    SINK_LEN.set(0);
    let mut writer = io::BufWriter::with_capacity(1 << 20, HostSink);
    document
        .save_to(&mut writer)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    writer
        .into_inner()
        .map_err(|error| io_domain_error(error.into_error()))?;
    Ok(written_response(pages_out, SINK_LEN.get()))
}

/// Appends the searchable text layer the JSON instructions in `payload`
/// describe to source 0, whose file is also the sink, from the Tesseract page
/// PDFs in the sources after it. When `after_page != 0` (desktop), streams
/// 64-page batches onto `HostSink` with one shared OCR font cache.
fn ocr_text_layer(after_page: u32, payload: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count < 2 {
        return Err("An OCR text layer reads its document and at least one page PDF".into());
    }
    let len = host_source_len(0)?;
    let read_page = |index: usize| {
        let source = u32::try_from(index)
            .ok()
            .and_then(|index| index.checked_add(1))
            .filter(|source| *source < source_count)
            .ok_or("ocr-text-layer names an OCR page PDF the request does not carry")?;
        // An empty or oversized page PDF is refused by its length, unread.
        let page_len = host_source_len(source)?;
        if page_len == 0 || page_len > MAX_OCR_SOURCE_PDF_BYTES {
            return Err(ocr_source_length_error(
                page_len,
                format!("page PDF {index}"),
            ));
        }
        let mut bytes = vec![0; page_len as usize];
        HostSource(source)
            .read_at(0, &mut bytes)
            .map_err(io_domain_error)?;
        Ok(bytes)
    };
    let page_count = if after_page != 0 {
        ocr_text_layer_to_source_batched(
            HostSource(0),
            len,
            || HostSink,
            payload,
            read_page,
            append_to_source_file,
        )?
    } else {
        ocr_text_layer_to_source(HostSource(0), len, payload, read_page, |revision| {
            append_to_source_file(len, revision)
        })?
    };
    Ok(written_response(page_count, SINK_LEN.get()))
}

/// Writes `revision` after the `len` bytes of source 0's file and returns what
/// the file then holds there. Empty revisions remain a no-op so no-op saves
/// copy 0 bytes and do not publish a staged file.
fn append_to_source_file(len: u64, revision: &[u8]) -> Result<Vec<u8>> {
    SINK_LEN.set(len);
    HostSink.write_all(revision).map_err(io_domain_error)?;
    let mut written = vec![0; revision.len()];
    if !revision.is_empty() {
        HostSink
            .read_at(len, &mut written)
            .map_err(io_domain_error)?;
    }
    Ok(written)
}

/// Overlay-staging variant of `append_to_source_file`: a 0-byte revision still
/// invokes `HostSink::write(&[])` so the host materializes source 0 into the
/// staging sink before the batched overlay reads it back.
fn append_overlay_to_source_file(len: u64, revision: &[u8]) -> Result<Vec<u8>> {
    SINK_LEN.set(len);
    write_overlay_append_revision_to_sink(&mut HostSink, len, revision)
}

fn host_source_len(index: u32) -> Result<u64> {
    // SAFETY: a plain call; the host answers with the source's length.
    let len = unsafe { evb_host_source_len(index) };
    if !(len.is_finite() && len >= 0.0) {
        return Err(io_domain_error(io::Error::other(
            "The host has no such source",
        )));
    }
    Ok(len as u64)
}

/// Appends the revision a mutation payload makes to source 0, whose file is
/// also the sink: the bytes it writes past the source's length are the host's
/// to commit or cut. For `OP_SAVE_MUTATIONS` (`include_delete_effects == false`),
/// source 1 when given holds original appearances. For `OP_SAVE_MUTATIONS_REPORTED`
/// (`include_delete_effects == true`), `after_page != 0` means source 1 holds
/// original appearances, and any additional sources carry placed-image sidecars
/// referenced by `bytesSourceIndex`.
fn save_mutations(
    after_page: u32,
    payload: &[u8],
    source_count: u32,
    include_delete_effects: bool,
) -> Result<Vec<u8>> {
    let (mut mutations, modified_at) = crate::wasm::parse_wasm_mutation_payload(payload)?;
    let has_appearance_source = if include_delete_effects {
        after_page != 0
    } else {
        source_count == 2
    };
    if !include_delete_effects && source_count > 2 {
        return Err("A save reads its document and at most one appearance source".into());
    }
    if source_count < 1 || (has_appearance_source && source_count < 2) {
        return Err("A save requires its document source".into());
    }
    if has_appearance_source {
        hydrate_text_box_original_appearances_from_source(
            &mut mutations,
            SourcePdf::open(HostSource(1), host_source_len(1)?)?,
        )?;
    }
    let first_image_source = if has_appearance_source { 2 } else { 1 };
    hydrate_placed_images_from_host_sources(
        &mutations.placed_images,
        |index| {
            if index < first_image_source || index >= source_count {
                return Err(domain_error(
                    NativeErrorCode::InvalidRequest,
                    "Placed image references an out-of-range host source",
                ));
            }
            host_source_len(index)
        },
        HostSource,
    )?;
    let len = host_source_len(0)?;
    let append = append_native_mutations_to_source(
        HostSource(0),
        len,
        &mutations,
        &modified_at,
        |revision| append_to_source_file(len, revision),
    )?;
    let mut response = written_response(append.page_count, SINK_LEN.get());
    if include_delete_effects {
        response.extend(serialize_native_save_report(
            &append.identity_bindings,
            append.annotation_delete_effects.as_ref(),
        )?);
    } else {
        response.extend(serde_json::to_vec(&append.identity_bindings)?);
    }
    Ok(response)
}

fn written_response(page_count: u32, len: u64) -> Vec<u8> {
    let mut output = vec![0; WRITTEN_HEADER.bytes];
    output[WRITTEN_HEADER.kind..WRITTEN_HEADER.kind + U32_BYTES]
        .copy_from_slice(&RESPONSE_WRITTEN.to_le_bytes());
    output[WRITTEN_HEADER.page_count..WRITTEN_HEADER.page_count + U32_BYTES]
        .copy_from_slice(&page_count.to_le_bytes());
    output[WRITTEN_HEADER.length..WRITTEN_HEADER.length + F64_BYTES]
        .copy_from_slice(&(len as f64).to_le_bytes());
    output
}
