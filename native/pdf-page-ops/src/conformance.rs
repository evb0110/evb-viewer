use super::*;
use serde::Serialize;

const PDF_REFERENCE_LIMIT: usize = 128;
pub(crate) const PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// Upper bound for a single `<pdfaid:part>` or `<pdfaid:conformance>` token so
/// malformed/oversized XMP claims never grow WASM memory or exceed the 64 KiB
/// native conformance JSON response cap.
pub(crate) const MAX_PDFA_MARKER_TOKEN_BYTES: usize = 256;
const PDFA_PART_OPEN_TAG: &[u8] = b"<pdfaid:part>";
const PDFA_PART_CLOSE_TAG: &[u8] = b"</pdfaid:part>";
const PDFA_CONFORMANCE_OPEN_TAG: &[u8] = b"<pdfaid:conformance>";
const PDFA_CONFORMANCE_CLOSE_TAG: &[u8] = b"</pdfaid:conformance>";
const PDF_ENCRYPT_MARKER: &[u8] = b"/Encrypt";

/// WHATWG `TextDecoder('latin1')` (Windows-1252) mapping for bytes `0x80..=0x9F`.
const WINDOWS_1252_80_9F: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfConformanceFacts {
    pub(crate) is_signed: bool,
    pub(crate) is_encrypted: bool,
    pub(crate) is_tagged: bool,
    pub(crate) has_acro_form: bool,
    pub(crate) has_xfa: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfMarkerEvidence {
    pub(crate) is_encrypted: bool,
    pub(crate) pdfa_level: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfConformanceFactsWithMarkers {
    pub(crate) is_signed: bool,
    pub(crate) is_encrypted: bool,
    pub(crate) is_tagged: bool,
    pub(crate) has_acro_form: bool,
    pub(crate) has_xfa: bool,
    pub(crate) pdfa_level: Option<String>,
}

impl PdfConformanceFacts {
    pub(crate) fn with_markers(self, markers: PdfMarkerEvidence) -> PdfConformanceFactsWithMarkers {
        PdfConformanceFactsWithMarkers {
            is_signed: self.is_signed,
            is_encrypted: self.is_encrypted || markers.is_encrypted,
            is_tagged: self.is_tagged,
            has_acro_form: self.has_acro_form,
            has_xfa: self.has_xfa,
            pdfa_level: markers.pdfa_level,
        }
    }
}

/// Matches JS `/\s/u` over WHATWG `latin1` (Windows-1252) decoded bytes (`0x00..=0xFF`).
#[inline]
fn is_latin1_js_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | 0x0B | 0x0C | b'\r' | 0xA0)
}

/// Matches JS `/\w/u` over WHATWG `latin1` (Windows-1252) decoded bytes (`0x00..=0xFF`).
#[inline]
fn is_latin1_js_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

#[inline]
fn decode_windows_1252_byte(byte: u8) -> char {
    if (0x80..=0x9F).contains(&byte) {
        WINDOWS_1252_80_9F[(byte - 0x80) as usize]
    } else {
        char::from(byte)
    }
}

fn decode_latin1_token(bytes: &[u8], uppercase: bool) -> String {
    if uppercase {
        let mut out = String::with_capacity(bytes.len());
        for &byte in bytes {
            for ch in decode_windows_1252_byte(byte).to_uppercase() {
                out.push(ch);
            }
        }
        out
    } else {
        bytes
            .iter()
            .map(|&byte| decode_windows_1252_byte(byte))
            .collect()
    }
}

/// Exact streaming state machine for `/Encrypt\b` across arbitrary chunk boundaries.
struct EncryptMarkerScanner {
    matched: usize,
    found: bool,
}

impl EncryptMarkerScanner {
    fn new(already_encrypted: bool) -> Self {
        Self {
            matched: 0,
            found: already_encrypted,
        }
    }

    #[inline]
    fn is_idle(&self) -> bool {
        self.found || self.matched == 0
    }

    #[inline]
    fn feed_byte(&mut self, byte: u8) {
        if self.found {
            return;
        }
        if self.matched == 0 {
            if byte == b'/' {
                self.matched = 1;
            }
            return;
        }
        if self.matched == PDF_ENCRYPT_MARKER.len() {
            if !is_latin1_js_word(byte) {
                self.found = true;
                return;
            }
            self.matched = usize::from(byte == b'/');
        } else if byte == PDF_ENCRYPT_MARKER[self.matched] {
            self.matched += 1;
        } else {
            self.matched = usize::from(byte == b'/');
        }
    }

    fn finish(&mut self) {
        if !self.found && self.matched == PDF_ENCRYPT_MARKER.len() {
            self.found = true;
        }
    }
}

#[derive(Clone, Copy)]
enum XmlTagScanState {
    SeekOpen(usize),
    SkipLeadingWs,
    ReadToken,
    SkipTrailingWs,
    MatchClose(usize),
}

/// Exact streaming state machine for `<tag>\s*([^<\s]{1,256})\s*</tag>` (case-insensitive
/// tag names) across arbitrary chunk boundaries and arbitrary whitespace lengths.
struct XmlTagTokenScanner {
    open_tag: &'static [u8],
    close_tag: &'static [u8],
    uppercase: bool,
    state: XmlTagScanState,
    token_buf: Vec<u8>,
    found: Option<String>,
}

impl XmlTagTokenScanner {
    fn new(open_tag: &'static [u8], close_tag: &'static [u8], uppercase: bool) -> Self {
        Self {
            open_tag,
            close_tag,
            uppercase,
            state: XmlTagScanState::SeekOpen(0),
            token_buf: Vec::new(),
            found: None,
        }
    }

    #[inline]
    fn is_idle(&self) -> bool {
        self.found.is_some() || matches!(self.state, XmlTagScanState::SeekOpen(0))
    }

    #[inline]
    fn feed_byte(&mut self, byte: u8) {
        if self.found.is_some() {
            return;
        }
        match self.state {
            XmlTagScanState::SeekOpen(0) => {
                if byte == b'<' {
                    self.state = XmlTagScanState::SeekOpen(1);
                }
            }
            XmlTagScanState::SeekOpen(matched) => {
                if byte.eq_ignore_ascii_case(&self.open_tag[matched]) {
                    let next = matched + 1;
                    if next == self.open_tag.len() {
                        self.token_buf.clear();
                        self.state = XmlTagScanState::SkipLeadingWs;
                    } else {
                        self.state = XmlTagScanState::SeekOpen(next);
                    }
                } else {
                    self.state = XmlTagScanState::SeekOpen(usize::from(byte == b'<'));
                }
            }
            XmlTagScanState::SkipLeadingWs => {
                if is_latin1_js_whitespace(byte) {
                    // Arbitrary whitespace length is accepted in O(1) memory.
                } else if byte == b'<' {
                    self.state = XmlTagScanState::SeekOpen(1);
                } else {
                    self.token_buf.clear();
                    self.token_buf.push(byte);
                    self.state = XmlTagScanState::ReadToken;
                }
            }
            XmlTagScanState::ReadToken => {
                if byte == b'<' {
                    self.state = XmlTagScanState::MatchClose(1);
                } else if is_latin1_js_whitespace(byte) {
                    self.state = XmlTagScanState::SkipTrailingWs;
                } else if self.token_buf.len() < MAX_PDFA_MARKER_TOKEN_BYTES {
                    self.token_buf.push(byte);
                } else {
                    // Oversized token: discard candidate so malformed XMP never
                    // blows past bounded memory or the 64 KiB stdout response cap.
                    self.token_buf.clear();
                    self.state = XmlTagScanState::SeekOpen(0);
                }
            }
            XmlTagScanState::SkipTrailingWs => {
                if is_latin1_js_whitespace(byte) {
                    // Arbitrary trailing whitespace is accepted in O(1) memory.
                } else if byte == b'<' {
                    self.state = XmlTagScanState::MatchClose(1);
                } else {
                    self.token_buf.clear();
                    self.state = XmlTagScanState::SeekOpen(0);
                }
            }
            XmlTagScanState::MatchClose(matched) => {
                if byte.eq_ignore_ascii_case(&self.close_tag[matched]) {
                    let next = matched + 1;
                    if next == self.close_tag.len() {
                        self.found = Some(decode_latin1_token(&self.token_buf, self.uppercase));
                        self.token_buf.clear();
                        return;
                    }
                    self.state = XmlTagScanState::MatchClose(next);
                } else if matched == 1 && byte.eq_ignore_ascii_case(&self.open_tag[1]) {
                    // Handles nested `<pdfaid:part>foo<pdfaid:part>2</pdfaid:part>`
                    // and `<pdfaid:part>foo <pdfaid:part>2</pdfaid:part>`.
                    self.token_buf.clear();
                    self.state = XmlTagScanState::SeekOpen(2);
                } else {
                    self.token_buf.clear();
                    self.state = XmlTagScanState::SeekOpen(usize::from(byte == b'<'));
                }
            }
        }
    }
}

/// Finds the first byte in `slice` that could start a remaining marker (`/E` or `<p`/`<P`)
/// in a single vectorized pass (64 bytes/iter via wasm32 `simd128`, 8 bytes/iter SWAR elsewhere).
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn find_next_marker_trigger(slice: &[u8], seek_slash: bool, seek_lt: bool) -> Option<usize> {
    use core::arch::wasm32::{
        u8x16_bitmask, u8x16_eq, u8x16_splat, v128, v128_and, v128_any_true, v128_load, v128_or,
    };

    if !seek_slash && !seek_lt {
        return None;
    }

    let len = slice.len();
    let ptr = slice.as_ptr();
    let slash = u8x16_splat(b'/');
    let cap_e = u8x16_splat(b'E');
    let lt = u8x16_splat(b'<');
    let lower_p = u8x16_splat(b'p');
    let ascii_case_bit = u8x16_splat(0x20);
    let mut i = 0;

    // Match 2-byte prefixes ("/E" for /Encrypt, "<p"/"<P" for <pdfaid:*) so
    // PDFs packed with hex strings (<0041>) or PDF names (/Type) do not stall
    // the scanner on every '<' or '/'.
    let match_pair = |v0: v128, v1: v128| -> v128 {
        if seek_slash && seek_lt {
            let slash_hit = v128_and(u8x16_eq(v0, slash), u8x16_eq(v1, cap_e));
            let lt_hit = v128_and(
                u8x16_eq(v0, lt),
                u8x16_eq(v128_or(v1, ascii_case_bit), lower_p),
            );
            v128_or(slash_hit, lt_hit)
        } else if seek_slash {
            v128_and(u8x16_eq(v0, slash), u8x16_eq(v1, cap_e))
        } else {
            v128_and(
                u8x16_eq(v0, lt),
                u8x16_eq(v128_or(v1, ascii_case_bit), lower_p),
            )
        }
    };

    // Unrolled 64-byte fast path (requires i + 65 <= len for the +1 lookahead load).
    while i + 65 <= len {
        // SAFETY: `i + 65 <= len` ensures all loads at offsets `i..i+65` stay in bounds.
        let (h0, h1, h2, h3) = unsafe {
            (
                match_pair(
                    v128_load(ptr.add(i).cast::<v128>()),
                    v128_load(ptr.add(i + 1).cast::<v128>()),
                ),
                match_pair(
                    v128_load(ptr.add(i + 16).cast::<v128>()),
                    v128_load(ptr.add(i + 17).cast::<v128>()),
                ),
                match_pair(
                    v128_load(ptr.add(i + 32).cast::<v128>()),
                    v128_load(ptr.add(i + 33).cast::<v128>()),
                ),
                match_pair(
                    v128_load(ptr.add(i + 48).cast::<v128>()),
                    v128_load(ptr.add(i + 49).cast::<v128>()),
                ),
            )
        };
        let combined = v128_or(v128_or(h0, h1), v128_or(h2, h3));
        if v128_any_true(combined) {
            let m0 = u8x16_bitmask(h0);
            if m0 != 0 {
                return Some(i + m0.trailing_zeros() as usize);
            }
            let m1 = u8x16_bitmask(h1);
            if m1 != 0 {
                return Some(i + 16 + m1.trailing_zeros() as usize);
            }
            let m2 = u8x16_bitmask(h2);
            if m2 != 0 {
                return Some(i + 32 + m2.trailing_zeros() as usize);
            }
            let m3 = u8x16_bitmask(h3);
            return Some(i + 48 + m3.trailing_zeros() as usize);
        }
        i += 64;
    }

    while i + 17 <= len {
        // SAFETY: `i + 17 <= len` ensures both 16-byte loads at `i` and `i + 1` stay in bounds.
        let h = unsafe {
            match_pair(
                v128_load(ptr.add(i).cast::<v128>()),
                v128_load(ptr.add(i + 1).cast::<v128>()),
            )
        };
        let mask = u8x16_bitmask(h);
        if mask != 0 {
            return Some(i + mask.trailing_zeros() as usize);
        }
        i += 16;
    }

    // Scalar tail: treat a trailing '/' or '<' at the very end of the chunk
    // as a trigger so chunk-boundary splits transition the scanner cleanly.
    while i < len {
        let byte = slice[i];
        let next = slice.get(i + 1).copied();
        if (seek_slash && byte == b'/' && next.is_none_or(|b| b == b'E'))
            || (seek_lt && byte == b'<' && next.is_none_or(|b| (b | 0x20) == b'p'))
        {
            return Some(i);
        }
        i += 1;
    }
    None
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
#[inline]
fn find_next_marker_trigger(slice: &[u8], seek_slash: bool, seek_lt: bool) -> Option<usize> {
    if !seek_slash && !seek_lt {
        return None;
    }
    const LO_BITS: u64 = 0x0101_0101_0101_0101;
    const HI_BITS: u64 = 0x8080_8080_8080_8080;
    const SLASH_MASK: u64 = LO_BITS * (b'/' as u64);
    const CAP_E_MASK: u64 = LO_BITS * (b'E' as u64);
    const LT_MASK: u64 = LO_BITS * (b'<' as u64);
    const LOWER_P_MASK: u64 = LO_BITS * (b'p' as u64);
    const CASE_BIT_MASK: u64 = LO_BITS * 0x20;

    #[inline]
    fn zero_byte_lanes(word: u64) -> u64 {
        word.wrapping_sub(LO_BITS) & !word & HI_BITS
    }

    let len = slice.len();
    let mut i = 0;
    while i + 9 <= len {
        let w0 = u64::from_ne_bytes([
            slice[i],
            slice[i + 1],
            slice[i + 2],
            slice[i + 3],
            slice[i + 4],
            slice[i + 5],
            slice[i + 6],
            slice[i + 7],
        ]);
        let w1 = u64::from_ne_bytes([
            slice[i + 1],
            slice[i + 2],
            slice[i + 3],
            slice[i + 4],
            slice[i + 5],
            slice[i + 6],
            slice[i + 7],
            slice[i + 8],
        ]);
        let slash_hit = if seek_slash {
            zero_byte_lanes(w0 ^ SLASH_MASK) & zero_byte_lanes(w1 ^ CAP_E_MASK)
        } else {
            0
        };
        let lt_hit = if seek_lt {
            zero_byte_lanes(w0 ^ LT_MASK) & zero_byte_lanes((w1 | CASE_BIT_MASK) ^ LOWER_P_MASK)
        } else {
            0
        };
        if (slash_hit | lt_hit) != 0 {
            for j in 0..8 {
                let byte = slice[i + j];
                let next = slice[i + j + 1];
                if (seek_slash && byte == b'/' && next == b'E')
                    || (seek_lt && byte == b'<' && (next | 0x20) == b'p')
                {
                    return Some(i + j);
                }
            }
        }
        i += 8;
    }
    while i < len {
        let byte = slice[i];
        let next = slice.get(i + 1).copied();
        if (seek_slash && byte == b'/' && next.is_none_or(|b| b == b'E'))
            || (seek_lt && byte == b'<' && next.is_none_or(|b| (b | 0x20) == b'p'))
        {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn scan_chunk_single_pass(
    slice: &[u8],
    encrypt: &mut EncryptMarkerScanner,
    part: &mut XmlTagTokenScanner,
    conformance: &mut XmlTagTokenScanner,
) {
    let mut i = 0;
    while i < slice.len() {
        if encrypt.found && part.found.is_some() && conformance.found.is_some() {
            return;
        }
        if encrypt.is_idle() && part.is_idle() && conformance.is_idle() {
            let seek_slash = !encrypt.found;
            let seek_lt = part.found.is_none() || conformance.found.is_none();
            let Some(rel) = find_next_marker_trigger(&slice[i..], seek_slash, seek_lt) else {
                return;
            };
            i += rel;
        }
        let byte = slice[i];
        i += 1;
        encrypt.feed_byte(byte);
        part.feed_byte(byte);
        conformance.feed_byte(byte);
    }
}

/// Streams raw PDF bytes in bounded chunks to detect `/Encrypt\b` and XMP PDF/A
/// markers (`<pdfaid:part>` / `<pdfaid:conformance>`), short-circuiting as soon
/// as both encryption and full PDF/A part+conformance are definitively determined.
pub(crate) fn scan_pdf_marker_evidence<S: ByteSource>(
    bytes: &S,
    len: u64,
    already_encrypted: bool,
) -> Result<PdfMarkerEvidence> {
    scan_pdf_marker_evidence_with_chunk_size(
        bytes,
        len,
        already_encrypted,
        PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES,
    )
}

fn scan_pdf_marker_evidence_with_chunk_size<S: ByteSource>(
    bytes: &S,
    len: u64,
    already_encrypted: bool,
    chunk_bytes: usize,
) -> Result<PdfMarkerEvidence> {
    if len == 0 {
        return Ok(PdfMarkerEvidence {
            is_encrypted: already_encrypted,
            pdfa_level: None,
        });
    }

    let mut encrypt = EncryptMarkerScanner::new(already_encrypted);
    let mut part = XmlTagTokenScanner::new(PDFA_PART_OPEN_TAG, PDFA_PART_CLOSE_TAG, false);
    let mut conformance =
        XmlTagTokenScanner::new(PDFA_CONFORMANCE_OPEN_TAG, PDFA_CONFORMANCE_CLOSE_TAG, true);

    let chunk_size = chunk_bytes.max(1);
    let buf_len = len.min(chunk_size as u64) as usize;
    let mut buf = vec![0u8; buf_len];
    let mut offset: u64 = 0;

    while offset < len {
        let to_read = (len - offset).min(chunk_size as u64) as usize;
        let slice = &mut buf[..to_read];
        bytes.read_at(offset, slice).map_err(io_domain_error)?;
        offset += to_read as u64;

        scan_chunk_single_pass(slice, &mut encrypt, &mut part, &mut conformance);

        if encrypt.found && part.found.is_some() && conformance.found.is_some() {
            break;
        }
    }

    if offset >= len {
        encrypt.finish();
    }

    let pdfa_level = part.found.map(|part_value| {
        let conformance_value = conformance.found.unwrap_or_default();
        format!("PDF/A-{part_value}{conformance_value}")
    });

    Ok(PdfMarkerEvidence {
        is_encrypted: encrypt.found,
        pdfa_level,
    })
}

fn resolved_object<'a>(document: &'a Document, object: &'a Object) -> Result<&'a Object> {
    let mut current = object;
    for _ in 0..PDF_REFERENCE_LIMIT {
        let Ok(object_id) = current.as_reference() else {
            return Ok(current);
        };
        current = document
            .get_object(object_id)
            .map_err(|error| format!("Failed to resolve PDF object {object_id:?}: {error}"))?;
    }
    Err("PDF reference chain exceeded the conformance dereference limit".into())
}

fn dictionary_is_signature(document: &Document, dictionary: &Dictionary) -> bool {
    let is_signature_dictionary = |candidate: &Dictionary| {
        candidate
            .get(b"Type")
            .ok()
            .and_then(|value| value.as_name().ok())
            .is_some_and(|value| value == b"Sig")
            || (candidate.has(b"ByteRange") && candidate.has(b"Contents"))
    };
    is_signature_dictionary(dictionary)
        || dictionary
            .get(b"V")
            .ok()
            .and_then(|value| resolved_object(document, value).ok())
            .and_then(|value| value.as_dict().ok())
            .is_some_and(is_signature_dictionary)
}

fn optional_dictionary<'a>(
    document: &'a Document,
    value: Option<&'a Object>,
    field_name: &str,
) -> Result<Option<&'a Dictionary>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if matches!(value, Object::Null) {
        return Ok(None);
    }
    let object = resolved_object(document, value)?;
    if matches!(object, Object::Null) {
        return Ok(None);
    }
    object.as_dict().map(Some).map_err(|error| {
        format!("PDF conformance {field_name} is not a dictionary: {error}").into()
    })
}

pub(crate) fn pdf_conformance_facts(document: &Document) -> Result<PdfConformanceFacts> {
    let root = document
        .trailer
        .get(b"Root")
        .map_err(|error| format!("PDF trailer is missing /Root: {error}"))?;
    let catalog =
        optional_dictionary(document, Some(root), "catalog")?.ok_or("PDF catalog is missing")?;
    let acro_form = optional_dictionary(document, catalog.get(b"AcroForm").ok(), "AcroForm")?;
    let struct_tree_root = optional_dictionary(
        document,
        catalog.get(b"StructTreeRoot").ok(),
        "StructTreeRoot",
    )?;
    Ok(PdfConformanceFacts {
        is_signed: document.objects.values().any(|object| match object {
            Object::Dictionary(dictionary) => dictionary_is_signature(document, dictionary),
            Object::Stream(stream) => dictionary_is_signature(document, &stream.dict),
            _ => false,
        }),
        is_encrypted: document
            .trailer
            .get(b"Encrypt")
            .is_ok_and(|value| !matches!(value, Object::Null)),
        is_tagged: struct_tree_root.is_some(),
        has_acro_form: acro_form.is_some(),
        has_xfa: acro_form.is_some_and(|dictionary| dictionary.has(b"XFA")),
    })
}

pub(crate) fn write_pdf_conformance(
    input_path: &Path,
    strict: bool,
    with_markers: bool,
    markers_only: bool,
    output: &mut impl Write,
) -> Result<()> {
    if markers_only {
        let (file, len) = open_source_file(input_path)?;
        let markers = scan_pdf_marker_evidence(&file, len, false)?;
        serde_json::to_writer(output, &markers)?;
        return Ok(());
    }
    let source = if strict {
        SourcePdf::open_strict_verify_path(input_path)?
    } else {
        SourcePdf::open_conformance_path(input_path)?
    };
    let facts = pdf_conformance_facts(&source.document)?;
    if with_markers {
        let (bytes, len) = source.raw_source();
        let markers = scan_pdf_marker_evidence(bytes, len, facts.is_encrypted)?;
        serde_json::to_writer(output, &facts.with_markers(markers))?;
    } else {
        serde_json::to_writer(output, &facts)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct CountingByteSource<'a> {
        bytes: &'a [u8],
        reads: Cell<usize>,
    }

    impl<'a> CountingByteSource<'a> {
        fn new(bytes: &'a [u8]) -> Self {
            Self {
                bytes,
                reads: Cell::new(0),
            }
        }
    }

    impl ByteSource for CountingByteSource<'_> {
        fn read_at(&self, offset: u64, buffer: &mut [u8]) -> std::io::Result<()> {
            self.reads.set(self.reads.get() + 1);
            self.bytes.read_at(offset, buffer)
        }

        fn copy_range(
            &self,
            offset: u64,
            len: u64,
            output: &mut impl Write,
        ) -> std::io::Result<()> {
            self.bytes.copy_range(offset, len, output)
        }
    }

    #[test]
    fn unsigned_signature_field_is_not_a_signed_document() {
        let document = Document::with_version("1.7");
        let mut field = Dictionary::new();
        field.set("FT", Object::Name(b"Sig".to_vec()));

        assert!(!dictionary_is_signature(&document, &field));
    }

    #[test]
    fn populated_signature_field_is_a_signed_document() {
        let mut document = Document::with_version("1.7");
        let signature_id = document.add_object(dictionary! {
            "Type" => "Sig",
            "ByteRange" => vec![0.into(), 10.into(), 20.into(), 30.into()],
            "Contents" => Object::String(Vec::new(), StringFormat::Hexadecimal),
        });
        let mut field = Dictionary::new();
        field.set("FT", Object::Name(b"Sig".to_vec()));
        field.set("V", Object::Reference(signature_id));

        assert!(dictionary_is_signature(&document, &field));
    }

    #[test]
    fn marker_scan_detects_pdfa_variants_and_encrypt() {
        for (payload, expected_encrypted, expected_level) in [
            (
                b"%PDF-1.7\nplain body\n%%EOF".as_slice(),
                false,
                None,
            ),
            (
                b"<pdfaid:part>1</pdfaid:part><pdfaid:conformance>b</pdfaid:conformance>".as_slice(),
                false,
                Some("PDF/A-1B"),
            ),
            (
                b"<PDFAID:PART>\t2\n</PDFAID:PART><PdfAid:Conformance>\r\x0c u \xA0</PdfAid:Conformance>"
                    .as_slice(),
                false,
                Some("PDF/A-2U"),
            ),
            (
                b"<pdfaid:conformance>b</pdfaid:conformance> filler <pdfaid:part>3</pdfaid:part>"
                    .as_slice(),
                false,
                Some("PDF/A-3B"),
            ),
            (
                b"<pdfaid:part>4</pdfaid:part>".as_slice(),
                false,
                Some("PDF/A-4"),
            ),
            (
                b"<pdfaid:part>4</pdfaid:part><pdfaid:conformance>f</pdfaid:conformance>".as_slice(),
                false,
                Some("PDF/A-4F"),
            ),
            (
                b"/Encrypted 1 0 R /Encrypt_Flag 2 0 R /Encrypt123 3 0 R".as_slice(),
                false,
                None,
            ),
            (
                b"/Encrypt 42 0 R".as_slice(),
                true,
                None,
            ),
            (
                b"trailing /Encrypt".as_slice(),
                true,
                None,
            ),
            (
                b"<pdfaid:part></pdfaid:part><pdfaid:part>a b</pdfaid:part><pdfaid:part>2</pdfaid:part><pdfaid:conformance>a</pdfaid:conformance>"
                    .as_slice(),
                false,
                Some("PDF/A-2A"),
            ),
            (
                b"<pdfaid:part>foo<pdfaid:part>2</pdfaid:part><pdfaid:conformance>bar <pdfaid:conformance>b</pdfaid:conformance>"
                    .as_slice(),
                false,
                Some("PDF/A-2B"),
            ),
            (
                b"<pdfaid:part>2</pdfaid:part><pdfaid:conformance>\x9A</pdfaid:conformance>"
                    .as_slice(),
                false,
                Some("PDF/A-2\u{0160}"),
            ),
        ] {
            for chunk_size in [1, 7, 64, PDF_CONFORMANCE_MARKER_SCAN_CHUNK_BYTES] {
                let evidence = scan_pdf_marker_evidence_with_chunk_size(
                    &payload,
                    payload.len() as u64,
                    false,
                    chunk_size,
                )
                .unwrap();
                assert_eq!(
                    evidence.is_encrypted, expected_encrypted,
                    "encrypt mismatch (chunk={chunk_size}) for {:?}",
                    String::from_utf8_lossy(payload)
                );
                assert_eq!(
                    evidence.pdfa_level.as_deref(),
                    expected_level,
                    "pdfa mismatch (chunk={chunk_size}) for {:?}",
                    String::from_utf8_lossy(payload)
                );
            }
        }
    }

    #[test]
    fn marker_scan_handles_chunk_boundary_splits_without_false_positives() {
        // Place `/Encrypt` split right across a 64-byte chunk edge.
        let mut encrypt_split = vec![b' '; 128];
        encrypt_split[60..75].copy_from_slice(b"/Encrypt 4 0 R ");
        let res = scan_pdf_marker_evidence_with_chunk_size(
            &encrypt_split.as_slice(),
            encrypt_split.len() as u64,
            false,
            64,
        )
        .unwrap();
        assert!(res.is_encrypted);

        // Place `/Encrypted` with `/Encrypt` ending AT the exact chunk edge (byte 64) and `ed` at byte 64.
        // Must NOT false-positive as `/Encrypt\b`.
        let mut encrypted_word_split = vec![b' '; 128];
        encrypted_word_split[56..66].copy_from_slice(b"/Encrypted");
        let res = scan_pdf_marker_evidence_with_chunk_size(
            &encrypted_word_split.as_slice(),
            encrypted_word_split.len() as u64,
            false,
            64,
        )
        .unwrap();
        assert!(!res.is_encrypted);

        // Split `<pdfaid:part>2</pdfaid:part>` and `<pdfaid:conformance>b</pdfaid:conformance>` across chunk edges.
        let part_tag = b"<pdfaid:part>2</pdfaid:part>";
        let conf_tag = b"<pdfaid:conformance>b</pdfaid:conformance>";
        let mut pdfa_split = vec![b' '; 256];
        pdfa_split[54..54 + part_tag.len()].copy_from_slice(part_tag);
        pdfa_split[178..178 + conf_tag.len()].copy_from_slice(conf_tag);
        let res = scan_pdf_marker_evidence_with_chunk_size(
            &pdfa_split.as_slice(),
            pdfa_split.len() as u64,
            false,
            64,
        )
        .unwrap();
        assert_eq!(res.pdfa_level.as_deref(), Some("PDF/A-2B"));

        // Arbitrary whitespace (9,000+ spaces) inside `<pdfaid:part>` spanning multiple chunk edges.
        let mut long_ws = Vec::new();
        long_ws.extend_from_slice(b"<pdfaid:part>");
        long_ws.resize(long_ws.len() + 9_500, b' ');
        long_ws.extend_from_slice(b"2");
        long_ws.resize(long_ws.len() + 5_000, b' ');
        long_ws.extend_from_slice(b"</pdfaid:part><pdfaid:conformance>");
        long_ws.resize(long_ws.len() + 5_000, b'\t');
        long_ws.extend_from_slice(b"b</pdfaid:conformance>");
        let res = scan_pdf_marker_evidence_with_chunk_size(
            &long_ws.as_slice(),
            long_ws.len() as u64,
            false,
            4096,
        )
        .unwrap();
        assert_eq!(res.pdfa_level.as_deref(), Some("PDF/A-2B"));
    }

    #[test]
    fn marker_scan_ignores_oversized_tokens_and_recovers_subsequent_valid_tags() {
        let mut huge_only = Vec::new();
        huge_only.extend_from_slice(b"<pdfaid:part>");
        huge_only.resize(huge_only.len() + 65_536, b'X');
        huge_only.extend_from_slice(b"</pdfaid:part>");
        let res = scan_pdf_marker_evidence_with_chunk_size(
            &huge_only.as_slice(),
            huge_only.len() as u64,
            false,
            4096,
        )
        .unwrap();
        assert_eq!(res.pdfa_level, None);

        let mut huge_then_valid = huge_only;
        huge_then_valid.extend_from_slice(
            b"<pdfaid:part>2</pdfaid:part><pdfaid:conformance>b</pdfaid:conformance>",
        );
        let res = scan_pdf_marker_evidence_with_chunk_size(
            &huge_then_valid.as_slice(),
            huge_then_valid.len() as u64,
            false,
            4096,
        )
        .unwrap();
        assert_eq!(res.pdfa_level.as_deref(), Some("PDF/A-2B"));
    }

    #[test]
    fn marker_scan_short_circuits_once_encrypted_and_pdfa_are_determined() {
        let mut data = vec![b' '; 64 * 10];
        let header = b"/Encrypt 5 0 R <pdfaid:part>2</pdfaid:part><pdfaid:conformance>b</pdfaid:conformance>";
        // Put everything in the first chunk (bytes 0..header.len()).
        data[..header.len()].copy_from_slice(header);
        let source = CountingByteSource::new(&data);
        let res = scan_pdf_marker_evidence_with_chunk_size(&source, data.len() as u64, false, 128)
            .unwrap();
        assert!(res.is_encrypted);
        assert_eq!(res.pdfa_level.as_deref(), Some("PDF/A-2B"));
        assert_eq!(
            source.reads.get(),
            1,
            "must short-circuit after the first chunk once both isEncrypted and pdfaLevel are known"
        );

        // When structural facts already proved encryption, finding PDF/A tags in chunk 0
        // short-circuits immediately without scanning for `/Encrypt`.
        let mut data_struct_enc = vec![b' '; 128 * 8];
        let xmp = b"<pdfaid:part>3</pdfaid:part><pdfaid:conformance>u</pdfaid:conformance>";
        data_struct_enc[..xmp.len()].copy_from_slice(xmp);
        let source_struct_enc = CountingByteSource::new(&data_struct_enc);
        let res = scan_pdf_marker_evidence_with_chunk_size(
            &source_struct_enc,
            data_struct_enc.len() as u64,
            true,
            128,
        )
        .unwrap();
        assert!(res.is_encrypted);
        assert_eq!(res.pdfa_level.as_deref(), Some("PDF/A-3U"));
        assert_eq!(source_struct_enc.reads.get(), 1);
    }

    #[test]
    fn marker_scan_propagates_truncated_source_as_io_error() {
        let bytes = b"%PDF-1.7\n".as_slice();
        let error = scan_pdf_marker_evidence_with_chunk_size(&bytes, 1024, false, 128)
            .expect_err("truncated source must fail closed");
        let native = error
            .downcast_ref::<NativeError>()
            .expect("expected NativeError");
        assert_eq!(native.code, NativeErrorCode::Io);
    }

    #[test]
    fn write_pdf_conformance_toggles_marker_fields_cleanly() {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let xmp = b"<?xpacket begin=''?><x:xmpmeta><pdfaid:part>2</pdfaid:part><pdfaid:conformance>b</pdfaid:conformance></x:xmpmeta>";
        let metadata_id = document.add_object(Stream::new(
            dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
            xmp.to_vec(),
        ));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
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
            "Metadata" => metadata_id,
        });
        document.trailer.set("Root", catalog_id);

        let path = std::env::temp_dir().join(format!(
            "evb-conformance-with-markers-{}.pdf",
            std::process::id()
        ));
        document.save(&path).unwrap();

        let mut structural_out = Vec::new();
        let structural_result =
            write_pdf_conformance(&path, false, false, false, &mut structural_out);
        let mut full_out = Vec::new();
        let full_result = write_pdf_conformance(&path, false, true, false, &mut full_out);
        let mut markers_only_out = Vec::new();
        let markers_only_result =
            write_pdf_conformance(&path, false, false, true, &mut markers_only_out);
        let _ = std::fs::remove_file(&path);

        structural_result.unwrap();
        let structural_json: serde_json::Value = serde_json::from_slice(&structural_out).unwrap();
        assert!(structural_json.get("pdfaLevel").is_none());
        assert_eq!(structural_json["isEncrypted"], false);

        full_result.unwrap();
        let full_json: serde_json::Value = serde_json::from_slice(&full_out).unwrap();
        assert_eq!(full_json["pdfaLevel"], "PDF/A-2B");
        assert_eq!(full_json["isEncrypted"], false);

        markers_only_result.unwrap();
        let markers_json: serde_json::Value = serde_json::from_slice(&markers_only_out).unwrap();
        assert_eq!(markers_json["pdfaLevel"], "PDF/A-2B");
        assert_eq!(markers_json["isEncrypted"], false);
        assert!(markers_json.get("isSigned").is_none());
    }
}
