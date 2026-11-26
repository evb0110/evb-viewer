use super::*;

pub(crate) struct PageMutationBytes {
    pub(crate) data: Vec<u8>,
    pub(crate) page_count: u32,
}

struct BoundedPdfWriter {
    bytes: Vec<u8>,
    max_bytes: usize,
    limit_exceeded: bool,
}

impl BoundedPdfWriter {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
            limit_exceeded: false,
        }
    }
}

impl Write for BoundedPdfWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let next_len = self.bytes.len().checked_add(buffer.len());
        let reserve_len = buffer.len().checked_add(PAGE_OP_WASM_MUTATION_HEADER_BYTES);
        if !matches!((next_len, reserve_len), (Some(next), Some(reserve))
            if next <= self.max_bytes && self.bytes.try_reserve(reserve).is_ok())
        {
            self.limit_exceeded = true;
            return Err(std::io::Error::other("Page-op WASM output limit exceeded"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) fn load_browser_pdf(data: &[u8]) -> Result<Document> {
    let document = load_pdf_bytes(data)?;
    assert_plaintext_base(
        &document,
        "Encrypted PDFs are not supported by browser page-op WASM",
    )?;
    Ok(document)
}

/// Bytes a writer returns (a whole PDF or an appended revision) with the JSON
/// report its CLI command prints on success.
pub(crate) struct ReportedBytes {
    pub(crate) data: Vec<u8>,
    pub(crate) page_count: u32,
    pub(crate) report: Vec<u8>,
}

/// A browser document as the base of an appended revision, read through its
/// cross-reference index as the path wrappers read theirs, with the source
/// that reads the streams it leaves unread.
pub(crate) fn incremental_from_bytes(
    data: &[u8],
) -> Result<(SourcePdf<&[u8]>, IncrementalDocument)> {
    if data.len() > PAGE_OP_WASM_MAX_BUFFER_BYTES {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Page-op WASM input exceeds the input admission ceiling",
        ));
    }
    let classify = |error| classify_pdf_load_error(error, "Failed to parse PDF structure");
    let mut source =
        SourcePdf::open_append_base(data, u64::try_from(data.len())?).map_err(classify)?;
    let base = source.take_append_base().map_err(classify)?;
    Ok((source, base))
}

/// The revision a path wrapper appends to its staged copy, checked the same
/// way before the browser publishes the base bytes followed by it.
pub(crate) fn appended_revision_bytes(incremental: &mut IncrementalDocument) -> Result<Vec<u8>> {
    let revision = build_incremental_revision(incremental)?;
    validate_incremental_append_bytes(
        &revision,
        incremental.previous_len(),
        incremental.previous_xref_start(),
        &collect_incremental_append_object_ids(incremental),
    )?;
    Ok(revision)
}

/// Decrypts an encrypted browser PDF into plaintext bytes.
///
/// Returns the decrypted rewrite in the mutation frame with its actual page count,
/// or the input bytes unchanged with `page_count = 0` when the input was never
/// encrypted. A rejected password surfaces as `needs-password` and a
/// public-key or unknown security handler as `unsupported-filter`, so the
/// browser build exposes the same three outcomes as the native decrypt CLI.
pub(crate) fn decrypt_browser_pdf_bytes(data: &[u8], password: &[u8]) -> Result<PageMutationBytes> {
    let password =
        std::str::from_utf8(password).map_err(|_| "Page-op WASM password must be UTF-8 text")?;
    // An empty password is an empty-password attempt: lopdf then fails with
    // InvalidPassword instead of returning a partially-loaded document, so the
    // classification below reports needs-password.
    let mut document = load_pdf_bytes_with_password(data, Some(password))?;
    if document.was_encrypted() {
        let page_count = u32::try_from(document.get_pages().len())
            .map_err(|_| "Decrypted PDF page count exceeds u32")?;
        let data = save_document_to_bytes(&mut document)?;
        Ok(PageMutationBytes { data, page_count })
    } else if document.is_encrypted() {
        Err(domain_error(
            NativeErrorCode::NeedsPassword,
            "The supplied password was not accepted by the encrypted PDF",
        ))
    } else {
        Ok(PageMutationBytes {
            data: data.to_vec(),
            page_count: 0,
        })
    }
}

pub(crate) fn save_document_to_bytes(document: &mut Document) -> Result<Vec<u8>> {
    save_document_to_bytes_with_limit(
        document,
        PAGE_OP_WASM_MAX_BUFFER_BYTES - PAGE_OP_WASM_MUTATION_HEADER_BYTES,
    )
}

pub(crate) fn save_document_to_bytes_with_limit(
    document: &mut Document,
    max_bytes: usize,
) -> Result<Vec<u8>> {
    let mut output = BoundedPdfWriter::new(max_bytes);
    let result = document.save_to(&mut output);
    if output.limit_exceeded {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Page-op WASM output exceeds the admission ceiling",
        ));
    }
    result?;
    Ok(output.bytes)
}

pub(crate) fn page_count(document: &Document) -> u32 {
    document.get_pages().len() as u32
}

pub(crate) fn get_browser_page_geometry(
    document: &Document,
    page_number: u32,
) -> Result<PageGeometry> {
    get_page_geometry(document, page_number)
}

pub(crate) fn get_browser_page_geometry_from_bytes(
    data: &[u8],
    page_number: u32,
) -> Result<PageGeometry> {
    let document = load_browser_pdf(data)?;
    get_browser_page_geometry(&document, page_number)
}
