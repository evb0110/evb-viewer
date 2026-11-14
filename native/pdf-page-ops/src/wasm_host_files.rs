//! Files the browser host holds for the engine: sources read by range and one
//! sink the edit writes and then verifies. wasm32 memory cannot hold a large
//! document, so only objects cross into it, as the reader asks for them.
//! A page-structure edit reads no stream data: each copy is left to the
//! host, which reads Blobs asynchronously (a synchronous read in one long
//! task keeps every buffer it allocated until the task ends), and a second
//! request verifies the output once the host has copied the streams. A save
//! appends to its source's own file and reads only the few streams a
//! mutation reuses, by range.
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

thread_local! {
    /// The length of the sink, including the copies the host still has to make.
    static SINK_LEN: Cell<u64> = const { Cell::new(0) };
    /// An edit written and awaiting its host's copies, then OP_VERIFY_WRITTEN.
    static WRITTEN: RefCell<Option<(Vec<SourcePdf<HostSource>>, PageSubset)>> = const { RefCell::new(None) };
}

fn host_result(status: i32) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::other(
            "The browser host could not read or write the file",
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
    let source_count = read_u32_at(request, FILE_REQUEST_HEADER.source_count)?;
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
        OP_SAVE_MUTATIONS => return save_mutations(tail, source_count),
        OP_OCR_TEXT_LAYER => return ocr_text_layer(tail, source_count),
        OP_PARSE_ANNOTATIONS | OP_READ_CATALOG | OP_OCR_TEXT_VISIBILITY => {
            return read_source(operation, &pages, tail, source_count)
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
        OP_INSERT_PAGES => PageStructureEdit::Insert {
            after_page: read_u32_at(request, FILE_REQUEST_HEADER.after_page)?,
        },
        OP_MERGE_PAGES => PageStructureEdit::Merge,
        operation => {
            return Err(format!("Page-op WASM operation {operation} takes no file framing").into())
        }
    };
    let sources = (0..read_u32_at(request, FILE_REQUEST_HEADER.source_count)?)
        .map(|index| SourcePdf::open(HostSource(index), host_source_len(index)?))
        .collect::<Result<Vec<_>>>()?;
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

/// Reads source 0, the one source a read takes.
fn read_source(operation: u32, pages: &[u32], tail: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count != 1
        || (operation != OP_OCR_TEXT_VISIBILITY && !(pages.is_empty() && tail.is_empty()))
    {
        return Err("A read takes one source and no other input".into());
    }
    let len = host_source_len(0)?;
    match operation {
        OP_PARSE_ANNOTATIONS => encode_bytes(
            RESPONSE_ANNOTATION_PARSE,
            annotation_parse_from_source(
                HostSource(0),
                len,
                PAGE_OP_WASM_MAX_BUFFER_BYTES - BYTES_HEADER.bytes,
            )?,
        ),
        OP_READ_CATALOG => encode_bytes(
            RESPONSE_JSON,
            serde_json::to_vec(&read_pdf_document_catalog(
                &SourcePdf::open(HostSource(0), len)?.document,
            ))?,
        ),
        _ => {
            let with_evb_ocr_text = match tail {
                b"" => false,
                b"with-evb-ocr-text" => true,
                _ => return Err("OCR text visibility takes no option but with-evb-ocr-text".into()),
            };
            encode_bytes(
                RESPONSE_JSON,
                ocr_text_visibility_from_source(HostSource(0), len, pages, with_evb_ocr_text)?,
            )
        }
    }
}

/// Appends the searchable text layer the JSON instructions in `payload`
/// describe to source 0, whose file is also the sink, from the Tesseract page
/// PDFs in the sources after it.
fn ocr_text_layer(payload: &[u8], source_count: u32) -> Result<Vec<u8>> {
    if source_count < 2 {
        return Err("An OCR text layer reads its document and at least one page PDF".into());
    }
    let len = host_source_len(0)?;
    let page_count = ocr_text_layer_to_source(
        HostSource(0),
        len,
        payload,
        |index| {
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
        },
        |revision| append_to_source_file(len, revision),
    )?;
    Ok(written_response(page_count, SINK_LEN.get()))
}

/// Writes `revision` after the `len` bytes of source 0's file and returns what
/// the file then holds there.
fn append_to_source_file(len: u64, revision: &[u8]) -> Result<Vec<u8>> {
    SINK_LEN.set(len);
    HostSink.write_all(revision).map_err(io_domain_error)?;
    let mut written = vec![0; revision.len()];
    HostSink
        .read_at(len, &mut written)
        .map_err(io_domain_error)?;
    Ok(written)
}

fn host_source_len(index: u32) -> Result<u64> {
    // SAFETY: a plain call; the host answers with the source's length.
    let len = unsafe { evb_host_source_len(index) };
    if !(len.is_finite() && len >= 0.0) {
        return Err(io_domain_error(io::Error::other(
            "The browser host has no such source",
        )));
    }
    Ok(len as u64)
}

/// Appends the revision a mutation payload makes to source 0, whose file is
/// also the sink: the bytes it writes past the source's length are the host's
/// to commit or cut. Source 1, when given, holds the original appearances its
/// text boxes restore. Answers WRITTEN_HEADER, then the identity bindings as
/// JSON.
fn save_mutations(payload: &[u8], source_count: u32) -> Result<Vec<u8>> {
    let (mut mutations, modified_at) = crate::wasm::parse_wasm_mutation_payload(payload)?;
    match source_count {
        1 => {}
        2 => hydrate_text_box_original_appearances_from_source(
            &mut mutations,
            SourcePdf::open(HostSource(1), host_source_len(1)?)?,
        )?,
        _ => return Err("A save reads its document and at most one appearance source".into()),
    }
    let len = host_source_len(0)?;
    let append = append_native_mutations_to_source(
        HostSource(0),
        len,
        &mutations,
        &modified_at,
        |revision| append_to_source_file(len, revision),
    )?;
    let mut response = written_response(append.page_count, SINK_LEN.get());
    response.extend(serde_json::to_vec(&append.identity_bindings)?);
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
