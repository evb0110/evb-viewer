use super::*;
use lopdf::{encryption::DecryptionError, DecompressError, Error as LopdfError, LoadOptions};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering},
    Mutex,
};

pub(crate) const MAX_ENCODED_PDF_BYTES: usize = 512 * 1024 * 1024;
pub(crate) const MAX_DECOMPRESSED_PDF_STREAM_BYTES: usize = 64 * 1024 * 1024;
const MAX_PDF_OBJECTS: usize = 1_000_000;
// Eager byte-array and WASM loads keep their existing page admission budget.
const MAX_BYTE_INPUT_PDF_PAGES: usize = 100_000;
// Path-backed loads need to admit the xlarge acceptance document, but they
// still need a finite page-count guard before lopdf builds its object graph.
const MAX_PATH_INPUT_PDF_PAGES: usize = 200_000;
const MAX_PDF_STRUCTURAL_NESTING: usize = 256;
const MAX_PDF_XREF_REVISIONS: usize = 4_096;
const MAX_XREF_PROBE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PdfLoadPolicy {
    max_encoded_bytes: usize,
    max_decompressed_stream_bytes: usize,
    max_objects: usize,
    max_pages: Option<usize>,
    max_structural_nesting: usize,
}

const PDF_LOAD_POLICY: PdfLoadPolicy = PdfLoadPolicy {
    max_encoded_bytes: MAX_ENCODED_PDF_BYTES,
    max_decompressed_stream_bytes: MAX_DECOMPRESSED_PDF_STREAM_BYTES,
    max_objects: MAX_PDF_OBJECTS,
    max_pages: Some(MAX_BYTE_INPUT_PDF_PAGES),
    max_structural_nesting: MAX_PDF_STRUCTURAL_NESTING,
};

const PDF_PATH_LOAD_POLICY: PdfLoadPolicy = PdfLoadPolicy {
    max_pages: Some(MAX_PATH_INPUT_PDF_PAGES),
    ..PDF_LOAD_POLICY
};

static PDF_LOAD_GUARD: Mutex<()> = Mutex::new(());
static ACTIVE_STREAM_LIMIT: AtomicUsize = AtomicUsize::new(MAX_DECOMPRESSED_PDF_STREAM_BYTES);
static OBJECT_STREAM_LIMIT_HIT: AtomicBool = AtomicBool::new(false);

impl PdfLoadPolicy {
    fn lopdf_options(self) -> LoadOptions {
        let mut options =
            LoadOptions::with_max_decompressed_size(self.max_decompressed_stream_bytes);
        options.filter = Some(admit_loaded_object);
        options
    }
}

fn admit_loaded_object(object_id: ObjectId, object: &mut Object) -> Option<(ObjectId, Object)> {
    if let Ok(stream) = object.as_stream() {
        let limit_exceeded = stream.dict.has_type(b"ObjStm")
            && matches!(
                stream.decompressed_content_with_limit(
                    ACTIVE_STREAM_LIMIT.load(AtomicOrdering::SeqCst)
                ),
                Err(LopdfError::Decompress(
                    DecompressError::MemoryLimitExceeded { .. }
                ))
            );
        if limit_exceeded {
            OBJECT_STREAM_LIMIT_HIT.store(true, AtomicOrdering::SeqCst);
            return None;
        }
    }
    Some((object_id, object.clone()))
}

pub(crate) fn load_pdf_path(path: &Path) -> Result<Document> {
    load_pdf_path_with_password(path, None)
}

pub(crate) fn load_pdf_path_with_password(path: &Path, password: Option<&str>) -> Result<Document> {
    let bytes = read_file_bounded(path, PDF_PATH_LOAD_POLICY.max_encoded_bytes, "PDF input")
        .map_err(|error| Box::new(error) as Box<dyn Error>)?;
    load_pdf_bytes_with_policy_and_password(&bytes, PDF_PATH_LOAD_POLICY, password)
}

/// Loads a compatibility-sized raw PDF input through the standard byte-input
/// policy with an optional password. The decrypt operation and the wasm
/// decrypt op share this entry point.
pub(crate) fn load_pdf_bytes_bounded(bytes: &[u8], password: Option<&str>) -> Result<Document> {
    load_pdf_bytes_with_policy_and_password(bytes, PDF_LOAD_POLICY, password)
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn load_pdf_bytes(bytes: &[u8]) -> Result<Document> {
    load_pdf_bytes_with_policy(bytes, PDF_LOAD_POLICY)
}

/// Loads raw PDF bytes with an optional decryption password for encrypted inputs.
///
/// lopdf skips `LoadOptions.filter` on the encrypted-load path (reader.rs keeps
/// the raw-object loader), so the ObjStm admission filter below does not run for
/// an encrypted input. `max_decompressed_size` still bounds every stream the
/// encrypted loader inflates, `preflight_pdf_structure` still runs before the
/// load, and `validate_loaded_document` still runs after it. Callers that admit
/// an encrypted base must therefore re-check `assert_plaintext_base` before
/// writing anything onto it.
pub(crate) fn load_pdf_bytes_with_policy_and_password(
    bytes: &[u8],
    policy: PdfLoadPolicy,
    password: Option<&str>,
) -> Result<Document> {
    if bytes.len() > policy.max_encoded_bytes {
        return Err(limit_error(format!(
            "Encoded PDF input exceeds the {}-byte admission ceiling",
            policy.max_encoded_bytes
        )));
    }
    preflight_pdf_structure(bytes, policy)?;
    let _load_guard = PDF_LOAD_GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ACTIVE_STREAM_LIMIT.store(policy.max_decompressed_stream_bytes, AtomicOrdering::SeqCst);
    OBJECT_STREAM_LIMIT_HIT.store(false, AtomicOrdering::SeqCst);
    let mut options = policy.lopdf_options();
    options.password = password.map(str::to_string);
    let loaded = Document::load_mem_with_options(bytes, options);
    if OBJECT_STREAM_LIMIT_HIT.load(AtomicOrdering::SeqCst) {
        return Err(limit_error(format!(
            "PDF object stream exceeds the {}-byte decompression ceiling",
            policy.max_decompressed_stream_bytes
        )));
    }
    let document = loaded.map_err(|error| classify_lopdf_load_error(error, policy, bytes))?;
    validate_loaded_document(&document, policy)?;
    Ok(document)
}

/// The one owner of the plaintext-base rule: a document whose base revision
/// carries encryption must be refused even when lopdf auto-decrypted it at
/// load. `Document::is_encrypted()` alone admits empty-user-password files,
/// because lopdf strips `/Encrypt` from the trailer after authenticating the
/// empty password; `was_encrypted()` catches exactly those files.
pub(crate) fn assert_plaintext_base(document: &Document, message: &str) -> Result<()> {
    if document.was_encrypted() || document.is_encrypted() {
        return Err(domain_error(
            NativeErrorCode::Encrypted,
            message.to_string(),
        ));
    }
    Ok(())
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn load_pdf_bytes_with_password(
    bytes: &[u8],
    password: Option<&str>,
) -> Result<Document> {
    load_pdf_bytes_with_policy_and_password(bytes, PDF_LOAD_POLICY, password)
}

pub(crate) fn load_incremental_pdf_path(
    path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<IncrementalDocument> {
    load_incremental_pdf_path_with_policy(path, qpdf_path, PDF_PATH_LOAD_POLICY)
}

pub(crate) fn load_annotation_index_pdf_path(
    path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<IncrementalDocument> {
    load_incremental_pdf_path_with_policy(path, qpdf_path, PDF_PATH_LOAD_POLICY)
}

fn load_incremental_pdf_path_with_policy(
    path: &Path,
    qpdf_path: Option<&Path>,
    policy: PdfLoadPolicy,
) -> Result<IncrementalDocument> {
    let encoded_len = fs::metadata(path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    let incremental = if encoded_len <= policy.max_encoded_bytes as u64 {
        let bytes = read_file_bounded(path, policy.max_encoded_bytes, "PDF input")
            .map_err(|error| Box::new(error) as Box<dyn Error>)?;
        let document = load_pdf_bytes_with_policy(&bytes, policy)?;
        IncrementalDocument::from_document(
            document,
            u64::try_from(bytes.len())?,
            bytes.last().copied(),
        )
    } else {
        let qpdf_path = qpdf_path.ok_or_else(|| {
            domain_error(
                NativeErrorCode::TooLarge,
                "Large incremental PDF input requires the bundled qpdf structural reader",
            )
        })?;
        load_qpdf_structural_incremental_pdf(path, qpdf_path)?
    };
    validate_loaded_document(incremental.get_prev_documents(), policy)?;
    Ok(incremental)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AdmissionKey {
    Count,
    First,
    Index,
    Length,
    N,
    Prev,
    Size,
    Type,
    W,
    XrefStm,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AdmissionDictionaryType {
    ObjectStream,
    PageTree,
    Xref,
}

#[derive(Clone, Copy, Debug)]
struct AdmissionArray {
    depth: usize,
    key: AdmissionKey,
    item_count: usize,
    range_total: u64,
    pending_range_start: u64,
    largest_range_end: u64,
}

#[derive(Default)]
struct AdmissionDictionary {
    dictionary_type: Option<AdmissionDictionaryType>,
    has_encrypt: bool,
    pending_key: Option<AdmissionKey>,
    count: Option<u64>,
    first: Option<u64>,
    n: Option<u64>,
    prev: Option<u64>,
    size: Option<u64>,
    xref_stm: Option<u64>,
    index_total: Option<u64>,
    length: Option<u64>,
    length_is_direct: bool,
    largest_index_end: Option<u64>,
    width_count: Option<usize>,
    largest_width: Option<u64>,
    array: Option<AdmissionArray>,
}

#[derive(Clone, Copy, Debug)]
enum AdmissionToken<'a> {
    ArrayEnd,
    ArrayStart,
    DictionaryEnd,
    DictionaryStart,
    Integer(u64),
    Keyword(&'a [u8]),
    Name(&'a [u8]),
}

struct AdmissionLexer<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> AdmissionLexer<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, cursor: 0 }
    }

    fn next_token(&mut self) -> Option<AdmissionToken<'a>> {
        loop {
            self.skip_whitespace_and_comments();
            let start = self.cursor;
            let byte = *self.bytes.get(start)?;
            match byte {
                b'<' if self.bytes.get(start + 1) == Some(&b'<') => {
                    self.cursor += 2;
                    return Some(AdmissionToken::DictionaryStart);
                }
                b'>' if self.bytes.get(start + 1) == Some(&b'>') => {
                    self.cursor += 2;
                    return Some(AdmissionToken::DictionaryEnd);
                }
                b'[' => {
                    self.cursor += 1;
                    return Some(AdmissionToken::ArrayStart);
                }
                b']' => {
                    self.cursor += 1;
                    return Some(AdmissionToken::ArrayEnd);
                }
                b'/' => {
                    self.cursor += 1;
                    let name_start = self.cursor;
                    self.skip_regular_bytes();
                    return Some(AdmissionToken::Name(&self.bytes[name_start..self.cursor]));
                }
                b'(' => {
                    self.skip_literal_string();
                }
                b'<' => {
                    self.skip_hex_string();
                }
                b'+' | b'0'..=b'9' => {
                    if let Some(integer) = self.read_unsigned_integer() {
                        return Some(AdmissionToken::Integer(integer));
                    }
                }
                b'-' => {
                    self.cursor += 1;
                    self.skip_digits();
                }
                _ if is_pdf_delimiter(byte) => {
                    self.cursor += 1;
                }
                _ => {
                    self.skip_regular_bytes();
                    let keyword = &self.bytes[start..self.cursor];
                    return Some(AdmissionToken::Keyword(keyword));
                }
            }
        }
    }

    fn skip_whitespace_and_comments(&mut self) {
        loop {
            while self
                .bytes
                .get(self.cursor)
                .is_some_and(|byte| is_pdf_whitespace(*byte))
            {
                self.cursor += 1;
            }
            if self.bytes.get(self.cursor) != Some(&b'%') {
                return;
            }
            while self
                .bytes
                .get(self.cursor)
                .is_some_and(|byte| !matches!(*byte, b'\r' | b'\n'))
            {
                self.cursor += 1;
            }
        }
    }

    fn skip_regular_bytes(&mut self) {
        while self
            .bytes
            .get(self.cursor)
            .is_some_and(|byte| !is_pdf_whitespace(*byte) && !is_pdf_delimiter(*byte))
        {
            self.cursor += 1;
        }
    }

    fn skip_digits(&mut self) {
        while self.bytes.get(self.cursor).is_some_and(u8::is_ascii_digit) {
            self.cursor += 1;
        }
    }

    fn read_unsigned_integer(&mut self) -> Option<u64> {
        if self.bytes.get(self.cursor) == Some(&b'+') {
            self.cursor += 1;
        }
        let digit_start = self.cursor;
        self.skip_digits();
        if self.cursor == digit_start {
            return None;
        }
        Some(
            self.bytes[digit_start..self.cursor]
                .iter()
                .fold(0_u64, |value, digit| {
                    value
                        .saturating_mul(10)
                        .saturating_add(u64::from(digit - b'0'))
                }),
        )
    }

    fn skip_literal_string(&mut self) {
        self.cursor += 1;
        let mut depth = 1_usize;
        while let Some(byte) = self.bytes.get(self.cursor).copied() {
            self.cursor += 1;
            match byte {
                b'\\' => {
                    if self.cursor < self.bytes.len() {
                        self.cursor += 1;
                    }
                }
                b'(' => depth = depth.saturating_add(1),
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return;
                    }
                }
                _ => {}
            }
        }
    }

    fn skip_hex_string(&mut self) {
        self.cursor += 1;
        while let Some(byte) = self.bytes.get(self.cursor).copied() {
            self.cursor += 1;
            if byte == b'>' {
                return;
            }
        }
    }

    fn skip_stream_body(&mut self, declared_length: usize) -> bool {
        if self.bytes.get(self.cursor) == Some(&b'\r') {
            self.cursor += 1;
        }
        if self.bytes.get(self.cursor) == Some(&b'\n') {
            self.cursor += 1;
        }
        let Some(stream_end) = self.cursor.checked_add(declared_length) else {
            self.cursor = self.bytes.len();
            return false;
        };
        if stream_end > self.bytes.len() {
            self.cursor = self.bytes.len();
            return false;
        }
        self.cursor = stream_end;
        self.skip_whitespace_and_comments();
        let marker_end = self.cursor.saturating_add(b"endstream".len());
        if self.bytes.get(self.cursor..marker_end) != Some(b"endstream") {
            return false;
        }
        self.cursor = marker_end;
        true
    }

    fn skip_remaining_bytes(&mut self) {
        self.cursor = self.bytes.len();
    }
}

fn is_pdf_whitespace(byte: u8) -> bool {
    matches!(byte, 0 | b'\t' | b'\n' | 12 | b'\r' | b' ')
}

fn is_pdf_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn decoded_name_matches(mut encoded: &[u8], expected: &[u8]) -> bool {
    let mut expected_index = 0_usize;
    while !encoded.is_empty() {
        let value = if encoded.len() >= 3 && encoded[0] == b'#' {
            let Some(high) = hex_value(encoded[1]) else {
                return false;
            };
            let Some(low) = hex_value(encoded[2]) else {
                return false;
            };
            encoded = &encoded[3..];
            (high << 4) | low
        } else {
            let value = encoded[0];
            encoded = &encoded[1..];
            value
        };
        if expected.get(expected_index) != Some(&value) {
            return false;
        }
        expected_index += 1;
    }
    expected_index == expected.len()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn admission_key(name: &[u8]) -> Option<AdmissionKey> {
    [
        (b"Count".as_slice(), AdmissionKey::Count),
        (b"First".as_slice(), AdmissionKey::First),
        (b"Index".as_slice(), AdmissionKey::Index),
        (b"Length".as_slice(), AdmissionKey::Length),
        (b"N".as_slice(), AdmissionKey::N),
        (b"Prev".as_slice(), AdmissionKey::Prev),
        (b"Size".as_slice(), AdmissionKey::Size),
        (b"Type".as_slice(), AdmissionKey::Type),
        (b"W".as_slice(), AdmissionKey::W),
        (b"XRefStm".as_slice(), AdmissionKey::XrefStm),
    ]
    .into_iter()
    .find_map(|(expected, key)| decoded_name_matches(name, expected).then_some(key))
}

fn admission_dictionary_type(name: &[u8]) -> Option<AdmissionDictionaryType> {
    [
        (b"ObjStm".as_slice(), AdmissionDictionaryType::ObjectStream),
        (b"Pages".as_slice(), AdmissionDictionaryType::PageTree),
        (b"XRef".as_slice(), AdmissionDictionaryType::Xref),
    ]
    .into_iter()
    .find_map(|(expected, kind)| decoded_name_matches(name, expected).then_some(kind))
}

fn preflight_pdf_structure(bytes: &[u8], policy: PdfLoadPolicy) -> Result<()> {
    let mut lexer = AdmissionLexer::new(bytes);
    let mut dictionaries = Vec::<AdmissionDictionary>::new();
    let mut array_depth = 0_usize;
    let mut previous_integers = [None, None];
    let mut indirect_object_count = 0_usize;
    let mut declared_object_stream_objects = 0_u64;
    let mut pending_stream_length = None;
    let mut pending_stream_dictionary = false;

    while let Some(token) = lexer.next_token() {
        match token {
            AdmissionToken::DictionaryStart => {
                pending_stream_length = None;
                pending_stream_dictionary = false;
                dictionaries.push(AdmissionDictionary::default());
                enforce_structural_nesting(dictionaries.len(), array_depth, policy)?;
                previous_integers = [None, None];
            }
            AdmissionToken::DictionaryEnd => {
                let Some(dictionary) = dictionaries.pop() else {
                    previous_integers = [None, None];
                    continue;
                };
                validate_admission_dictionary(
                    &dictionary,
                    policy,
                    &mut declared_object_stream_objects,
                )?;
                if dictionaries.is_empty() {
                    pending_stream_dictionary = true;
                    pending_stream_length = dictionary
                        .length
                        .filter(|_| dictionary.length_is_direct)
                        .and_then(|length| usize::try_from(length).ok());
                }
                previous_integers = [None, None];
            }
            AdmissionToken::ArrayStart => {
                array_depth = array_depth.saturating_add(1);
                enforce_structural_nesting(dictionaries.len(), array_depth, policy)?;
                if let Some(dictionary) = dictionaries.last_mut() {
                    if matches!(
                        dictionary.pending_key,
                        Some(AdmissionKey::Index | AdmissionKey::W)
                    ) {
                        dictionary.array = Some(AdmissionArray {
                            depth: array_depth,
                            key: dictionary.pending_key.take().unwrap(),
                            item_count: 0,
                            range_total: 0,
                            pending_range_start: 0,
                            largest_range_end: 0,
                        });
                    }
                }
                previous_integers = [None, None];
            }
            AdmissionToken::ArrayEnd => {
                if let Some(dictionary) = dictionaries.last_mut() {
                    if dictionary
                        .array
                        .is_some_and(|array| array.depth == array_depth)
                    {
                        let array = dictionary.array.take().unwrap();
                        match array.key {
                            AdmissionKey::Index => {
                                dictionary.index_total = Some(array.range_total);
                                dictionary.largest_index_end = Some(array.largest_range_end);
                            }
                            AdmissionKey::W => {
                                dictionary.width_count = Some(array.item_count);
                                dictionary.largest_width = Some(array.largest_range_end);
                            }
                            _ => unreachable!(),
                        }
                    }
                }
                array_depth = array_depth.saturating_sub(1);
                previous_integers = [None, None];
            }
            AdmissionToken::Name(name) => {
                if let Some(dictionary) = dictionaries.last_mut() {
                    if dictionary.pending_key == Some(AdmissionKey::Type) {
                        dictionary.dictionary_type = admission_dictionary_type(name);
                        dictionary.pending_key = None;
                    } else {
                        dictionary.pending_key = admission_key(name);
                    }
                }
                pending_stream_dictionary = false;
                previous_integers = [None, None];
            }
            AdmissionToken::Integer(value) => {
                if let Some(dictionary) = dictionaries.last_mut() {
                    if dictionary
                        .array
                        .is_some_and(|array| array.depth == array_depth)
                    {
                        let array = dictionary.array.as_mut().unwrap();
                        if array.key == AdmissionKey::Index {
                            if array.item_count % 2 == 0 {
                                array.pending_range_start = value;
                            } else {
                                array.range_total = array.range_total.saturating_add(value);
                                array.largest_range_end = array
                                    .largest_range_end
                                    .max(array.pending_range_start.saturating_add(value));
                            }
                        } else {
                            array.largest_range_end = array.largest_range_end.max(value);
                        }
                        array.item_count += 1;
                    } else if let Some(key) = dictionary.pending_key.take() {
                        match key {
                            AdmissionKey::Count => dictionary.count = Some(value),
                            AdmissionKey::First => dictionary.first = Some(value),
                            AdmissionKey::Length => {
                                dictionary.length = Some(value);
                                dictionary.length_is_direct = true;
                            }
                            AdmissionKey::N => dictionary.n = Some(value),
                            AdmissionKey::Prev => dictionary.prev = Some(value),
                            AdmissionKey::Size => dictionary.size = Some(value),
                            AdmissionKey::XrefStm => dictionary.xref_stm = Some(value),
                            _ => {}
                        }
                    } else if dictionary.length_is_direct {
                        dictionary.length_is_direct = false;
                    }
                }
                previous_integers = [previous_integers[1], Some(value)];
            }
            AdmissionToken::Keyword(keyword) => {
                if keyword == b"stream" {
                    if let Some(length) = pending_stream_length.take() {
                        if !lexer.skip_stream_body(length) {
                            return Err(limit_error(
                                "PDF stream body exceeds its declared bounds or is missing endstream",
                            ));
                        }
                    } else if pending_stream_dictionary {
                        // An indirect /Length cannot be resolved without materializing the
                        // cross-reference graph. Treat the body as opaque instead of guessing
                        // at an attacker-controlled `endstream` byte sequence.
                        lexer.skip_remaining_bytes();
                    }
                    pending_stream_dictionary = false;
                    previous_integers = [None, None];
                    continue;
                }
                pending_stream_length = None;
                pending_stream_dictionary = false;
                if keyword == b"obj" && previous_integers.iter().all(Option::is_some) {
                    indirect_object_count = indirect_object_count.saturating_add(1);
                    if indirect_object_count > policy.max_objects {
                        return Err(limit_error(format!(
                            "PDF indirect object declarations exceed the {}-object admission ceiling",
                            policy.max_objects
                        )));
                    }
                }
                if let Some(dictionary) = dictionaries.last_mut() {
                    if dictionary.length_is_direct {
                        dictionary.length_is_direct = false;
                    }
                    dictionary.pending_key = None;
                }
                previous_integers = [None, None];
            }
        }
    }

    if declared_object_stream_objects > policy.max_objects as u64 {
        return Err(limit_error(format!(
            "PDF object streams declare more than the {}-object admission ceiling",
            policy.max_objects
        )));
    }
    preflight_pdf_xref_chain(bytes, policy)?;
    Ok(())
}

struct XrefCursor<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> XrefCursor<'a> {
    fn at(bytes: &'a [u8], cursor: usize) -> Self {
        Self { bytes, cursor }
    }

    fn skip_whitespace_and_comments(&mut self) {
        loop {
            while self
                .bytes
                .get(self.cursor)
                .is_some_and(|byte| is_pdf_whitespace(*byte))
            {
                self.cursor += 1;
            }
            if self.bytes.get(self.cursor) != Some(&b'%') {
                return;
            }
            while self
                .bytes
                .get(self.cursor)
                .is_some_and(|byte| !matches!(*byte, b'\r' | b'\n'))
            {
                self.cursor += 1;
            }
        }
    }

    fn token(&mut self) -> Option<&'a [u8]> {
        self.skip_whitespace_and_comments();
        let start = self.cursor;
        let first = *self.bytes.get(start)?;
        if is_pdf_delimiter(first) {
            self.cursor += 1;
            if matches!(first, b'<' | b'>') && self.bytes.get(self.cursor) == Some(&first) {
                self.cursor += 1;
            }
        } else {
            while self
                .bytes
                .get(self.cursor)
                .is_some_and(|byte| !is_pdf_whitespace(*byte) && !is_pdf_delimiter(*byte))
            {
                self.cursor += 1;
            }
        }
        Some(&self.bytes[start..self.cursor])
    }

    fn unsigned(&mut self) -> Option<u64> {
        let token = self.token()?;
        if token.is_empty() || !token.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(token.iter().fold(0_u64, |value, digit| {
            value
                .saturating_mul(10)
                .saturating_add(u64::from(digit - b'0'))
        }))
    }

    fn consume(&mut self, expected: &[u8]) -> bool {
        let saved = self.cursor;
        if self.token() == Some(expected) {
            true
        } else {
            self.cursor = saved;
            false
        }
    }
}

fn preflight_pdf_xref_chain(bytes: &[u8], policy: PdfLoadPolicy) -> Result<()> {
    let eof_offset = bytes
        .windows(b"%%EOF".len())
        .rposition(|window| window == b"%%EOF")
        .unwrap_or(bytes.len());
    let Some(marker_offset) = bytes[..eof_offset]
        .windows(b"startxref".len())
        .enumerate()
        .rfind(|(offset, window)| {
            *window == b"startxref"
                && (*offset == 0
                    || bytes
                        .get(offset - 1)
                        .is_some_and(|byte| is_pdf_whitespace(*byte) || is_pdf_delimiter(*byte)))
                && bytes
                    .get(offset + b"startxref".len())
                    .is_some_and(|byte| is_pdf_whitespace(*byte))
        })
        .map(|(offset, _)| offset)
    else {
        // lopdf remains responsible for classifying documents without a terminal
        // cross-reference pointer. The structural scanner above still applies its
        // cheap declaration limits to these malformed inputs.
        return Ok(());
    };
    let mut root_cursor = XrefCursor::at(bytes, marker_offset + b"startxref".len());
    let root = root_cursor
        .unsigned()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| xref_error("PDF startxref pointer is invalid"))?;

    let mut pending = [usize::MAX; MAX_PDF_XREF_REVISIONS];
    let mut visited = HashSet::with_capacity(MAX_PDF_XREF_REVISIONS);
    let mut pending_len = 1_usize;
    let mut scanned_bytes = 0_usize;
    pending[0] = root;

    while pending_len > 0 {
        pending_len -= 1;
        let offset = pending[pending_len];
        if offset >= bytes.len() {
            return Err(xref_error("PDF cross-reference offset is outside the file"));
        }
        if visited.len() == MAX_PDF_XREF_REVISIONS && !visited.contains(&offset) {
            return Err(limit_error(format!(
                "PDF cross-reference chain exceeds the {MAX_PDF_XREF_REVISIONS}-revision admission ceiling"
            )));
        }
        if !visited.insert(offset) {
            return Err(xref_error(
                "PDF cross-reference revision chain contains a repeated offset",
            ));
        }

        let (dictionary, consumed) = if bytes
            .get(offset..)
            .is_some_and(|tail| tail.starts_with(b"xref"))
        {
            parse_classic_xref_section(bytes, offset, policy)?
        } else {
            parse_xref_stream_section(bytes, offset, policy)?
        };
        scanned_bytes = scanned_bytes
            .checked_add(consumed)
            .ok_or_else(|| limit_error("PDF cross-reference scan length overflow"))?;
        if scanned_bytes > bytes.len() {
            return Err(xref_error(
                "PDF cross-reference sections overlap or exceed the input",
            ));
        }

        for linked in [dictionary.prev, dictionary.xref_stm].into_iter().flatten() {
            let linked = usize::try_from(linked)
                .map_err(|_| xref_error("PDF cross-reference link is too large"))?;
            if linked >= bytes.len() {
                return Err(xref_error("PDF cross-reference link is outside the file"));
            }
            if pending_len == MAX_PDF_XREF_REVISIONS {
                return Err(limit_error(format!(
                    "PDF cross-reference chain exceeds the {MAX_PDF_XREF_REVISIONS}-revision admission ceiling"
                )));
            }
            pending[pending_len] = linked;
            pending_len += 1;
        }
    }
    Ok(())
}

fn parse_classic_xref_section(
    bytes: &[u8],
    offset: usize,
    policy: PdfLoadPolicy,
) -> Result<(AdmissionDictionary, usize)> {
    let mut cursor = XrefCursor::at(bytes, offset);
    if !cursor.consume(b"xref") {
        return Err(xref_error("PDF classic cross-reference marker is invalid"));
    }
    let mut declared_rows = 0_u64;
    let mut actual_rows = 0_u64;
    let mut largest_end = 0_u64;

    loop {
        if cursor.consume(b"trailer") {
            break;
        }
        let start = cursor
            .unsigned()
            .ok_or_else(|| xref_error("PDF cross-reference subsection start is invalid"))?;
        let count = cursor
            .unsigned()
            .ok_or_else(|| xref_error("PDF cross-reference subsection count is invalid"))?;
        let end = start
            .checked_add(count)
            .ok_or_else(|| limit_error("PDF cross-reference subsection range overflow"))?;
        declared_rows = declared_rows
            .checked_add(count)
            .ok_or_else(|| limit_error("PDF cross-reference row count overflow"))?;
        largest_end = largest_end.max(end);
        if declared_rows > policy.max_objects as u64 || end > policy.max_objects as u64 {
            return Err(limit_error(format!(
                "PDF classic cross-reference table exceeds the {}-object admission ceiling",
                policy.max_objects
            )));
        }
        for _ in 0..count {
            cursor
                .unsigned()
                .ok_or_else(|| xref_error("PDF cross-reference entry offset is invalid"))?;
            cursor
                .unsigned()
                .ok_or_else(|| xref_error("PDF cross-reference entry generation is invalid"))?;
            if !matches!(cursor.token(), Some(b"n" | b"f")) {
                return Err(xref_error("PDF cross-reference entry type is invalid"));
            }
            actual_rows = actual_rows
                .checked_add(1)
                .ok_or_else(|| limit_error("PDF cross-reference row count overflow"))?;
            if actual_rows > policy.max_objects as u64 {
                return Err(limit_error(format!(
                    "PDF classic cross-reference table exceeds the {}-object admission ceiling",
                    policy.max_objects
                )));
            }
        }
    }

    if actual_rows != declared_rows {
        return Err(xref_error(
            "PDF cross-reference row count does not match its declarations",
        ));
    }
    let (dictionary, dictionary_end) = parse_xref_dictionary(bytes, cursor.cursor, policy)?;
    let size = dictionary
        .size
        .ok_or_else(|| xref_error("PDF cross-reference trailer is missing /Size"))?;
    if size > policy.max_objects as u64 || largest_end > size {
        return Err(limit_error(format!(
            "PDF classic cross-reference table exceeds the {}-object admission ceiling",
            policy.max_objects
        )));
    }
    Ok((dictionary, dictionary_end.saturating_sub(offset)))
}

fn parse_xref_stream_section(
    bytes: &[u8],
    offset: usize,
    policy: PdfLoadPolicy,
) -> Result<(AdmissionDictionary, usize)> {
    let mut cursor = XrefCursor::at(bytes, offset);
    cursor
        .unsigned()
        .ok_or_else(|| xref_error("PDF cross-reference stream object number is invalid"))?;
    cursor
        .unsigned()
        .ok_or_else(|| xref_error("PDF cross-reference stream generation is invalid"))?;
    if !cursor.consume(b"obj") {
        return Err(xref_error(
            "PDF cross-reference offset does not point to an xref table or object",
        ));
    }
    let (dictionary, dictionary_end) = parse_xref_dictionary(bytes, cursor.cursor, policy)?;
    if dictionary.dictionary_type != Some(AdmissionDictionaryType::Xref) {
        return Err(xref_error(
            "PDF cross-reference stream is missing /Type /XRef",
        ));
    }
    let size = dictionary
        .size
        .ok_or_else(|| xref_error("PDF cross-reference stream is missing /Size"))?;
    if size > policy.max_objects as u64
        || dictionary
            .index_total
            .unwrap_or(size)
            .gt(&(policy.max_objects as u64))
        || dictionary.largest_index_end.unwrap_or(size).gt(&size)
    {
        return Err(limit_error(format!(
            "PDF cross-reference stream exceeds the {}-object admission ceiling",
            policy.max_objects
        )));
    }
    if dictionary.width_count != Some(3) || dictionary.largest_width.is_some_and(|width| width > 8)
    {
        return Err(limit_error(
            "PDF cross-reference stream has an unsafe field-width declaration",
        ));
    }
    let mut stream_cursor = XrefCursor::at(bytes, dictionary_end);
    if !stream_cursor.consume(b"stream") {
        return Err(xref_error("PDF cross-reference stream data is missing"));
    }
    Ok((dictionary, dictionary_end.saturating_sub(offset)))
}

fn parse_xref_dictionary(
    bytes: &[u8],
    offset: usize,
    policy: PdfLoadPolicy,
) -> Result<(AdmissionDictionary, usize)> {
    let mut lexer = AdmissionLexer::new(
        bytes
            .get(offset..)
            .ok_or_else(|| xref_error("PDF cross-reference dictionary offset is invalid"))?,
    );
    if !matches!(lexer.next_token(), Some(AdmissionToken::DictionaryStart)) {
        return Err(xref_error("PDF cross-reference dictionary is missing"));
    }
    let mut dictionary = AdmissionDictionary::default();
    let mut dictionary_depth = 1_usize;
    let mut array_depth = 0_usize;

    while let Some(token) = lexer.next_token() {
        match token {
            AdmissionToken::DictionaryStart => {
                dictionary_depth = dictionary_depth.saturating_add(1);
                enforce_structural_nesting(dictionary_depth, array_depth, policy)?;
            }
            AdmissionToken::DictionaryEnd => {
                dictionary_depth = dictionary_depth.saturating_sub(1);
                if dictionary_depth == 0 {
                    validate_admission_dictionary(&dictionary, policy, &mut 0)?;
                    return Ok((dictionary, offset.saturating_add(lexer.cursor)));
                }
            }
            AdmissionToken::ArrayStart if dictionary_depth == 1 => {
                array_depth = array_depth.saturating_add(1);
                enforce_structural_nesting(dictionary_depth, array_depth, policy)?;
                if matches!(
                    dictionary.pending_key,
                    Some(AdmissionKey::Index | AdmissionKey::W)
                ) {
                    dictionary.array = Some(AdmissionArray {
                        depth: array_depth,
                        key: dictionary.pending_key.take().unwrap(),
                        item_count: 0,
                        range_total: 0,
                        pending_range_start: 0,
                        largest_range_end: 0,
                    });
                }
            }
            AdmissionToken::ArrayEnd if dictionary_depth == 1 => {
                if dictionary
                    .array
                    .is_some_and(|array| array.depth == array_depth)
                {
                    let array = dictionary.array.take().unwrap();
                    if array.item_count == 0
                        || (array.key == AdmissionKey::Index && array.item_count % 2 != 0)
                    {
                        return Err(xref_error("PDF cross-reference array is invalid"));
                    }
                    match array.key {
                        AdmissionKey::Index => {
                            dictionary.index_total = Some(array.range_total);
                            dictionary.largest_index_end = Some(array.largest_range_end);
                        }
                        AdmissionKey::W => {
                            dictionary.width_count = Some(array.item_count);
                            dictionary.largest_width = Some(array.largest_range_end);
                        }
                        _ => unreachable!(),
                    }
                }
                array_depth = array_depth.saturating_sub(1);
            }
            AdmissionToken::Name(name) if dictionary_depth == 1 && array_depth == 0 => {
                if decoded_name_matches(name, b"Encrypt") {
                    dictionary.has_encrypt = true;
                }
                if dictionary.pending_key == Some(AdmissionKey::Type) {
                    dictionary.dictionary_type = admission_dictionary_type(name);
                    dictionary.pending_key = None;
                } else {
                    dictionary.pending_key = admission_key(name);
                }
            }
            AdmissionToken::Integer(value) if dictionary_depth == 1 => {
                if dictionary
                    .array
                    .is_some_and(|array| array.depth == array_depth)
                {
                    let array = dictionary.array.as_mut().unwrap();
                    if array.key == AdmissionKey::Index {
                        if array.item_count % 2 == 0 {
                            array.pending_range_start = value;
                        } else {
                            array.range_total =
                                array.range_total.checked_add(value).ok_or_else(|| {
                                    limit_error("PDF cross-reference index count overflow")
                                })?;
                            let end =
                                array
                                    .pending_range_start
                                    .checked_add(value)
                                    .ok_or_else(|| {
                                        limit_error("PDF cross-reference index range overflow")
                                    })?;
                            array.largest_range_end = array.largest_range_end.max(end);
                        }
                    } else {
                        array.largest_range_end = array.largest_range_end.max(value);
                    }
                    array.item_count += 1;
                } else if array_depth == 0 {
                    match dictionary.pending_key.take() {
                        Some(AdmissionKey::Length) => dictionary.length = Some(value),
                        Some(AdmissionKey::Prev) => dictionary.prev = Some(value),
                        Some(AdmissionKey::Size) => dictionary.size = Some(value),
                        Some(AdmissionKey::XrefStm) => dictionary.xref_stm = Some(value),
                        _ => {}
                    }
                }
            }
            AdmissionToken::Keyword(_) if dictionary_depth == 1 && array_depth == 0 => {
                dictionary.pending_key = None;
            }
            _ => {}
        }
    }
    Err(xref_error("PDF cross-reference dictionary is unterminated"))
}

/// Checks the terminal xref chain for a real `/Encrypt` entry without loading
/// the PDF body. This is used only after the byte-input ceiling has rejected an
/// eager load, where a raw byte search could mistake page content for trailer
/// metadata or miss encryption inherited through an earlier revision.
pub(crate) fn path_has_encryption_entry(path: &Path) -> Result<bool> {
    let file_len = fs::metadata(path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    let (terminal_xref, _) = read_terminal_xref(path, file_len)?;
    let mut pending = vec![terminal_xref];
    let mut visited = HashSet::new();
    let mut scanned_bytes = 0_u64;

    while let Some(offset) = pending.pop() {
        if offset >= file_len {
            return Err(xref_error("PDF cross-reference offset is outside the file"));
        }
        if !visited.insert(offset) {
            return Err(xref_error(
                "PDF cross-reference revision chain contains a repeated offset",
            ));
        }
        if visited.len() > MAX_PDF_XREF_REVISIONS {
            return Err(limit_error(format!(
                "PDF cross-reference chain exceeds the {MAX_PDF_XREF_REVISIONS}-revision admission ceiling"
            )));
        }

        let section = read_xref_probe_window(path, offset)?;
        scanned_bytes = scanned_bytes
            .checked_add(u64::try_from(section.len()).map_err(|_| {
                limit_error("PDF cross-reference scan length exceeds the addressable range")
            })?)
            .ok_or_else(|| limit_error("PDF cross-reference scan length overflow"))?;
        if scanned_bytes > file_len {
            return Err(xref_error(
                "PDF cross-reference sections overlap or exceed the input",
            ));
        }
        let parsed = if section.starts_with(b"xref") {
            parse_classic_xref_section(&section, 0, PDF_PATH_LOAD_POLICY)
        } else {
            parse_xref_stream_section(&section, 0, PDF_PATH_LOAD_POLICY)
        };
        let (dictionary, consumed) = match parsed {
            Ok(parsed) => parsed,
            Err(_error) if section.len() == MAX_XREF_PROBE_BYTES => {
                return Err(limit_error(
                    "PDF cross-reference section exceeds the structural probe ceiling",
                ));
            }
            Err(error) => return Err(error),
        };
        if dictionary.has_encrypt {
            return Ok(true);
        }
        if consumed == 0 {
            return Err(xref_error("PDF cross-reference section consumed no bytes"));
        }
        for linked in [dictionary.prev, dictionary.xref_stm].into_iter().flatten() {
            if linked >= file_len {
                return Err(xref_error("PDF cross-reference link is outside the file"));
            }
            pending.push(linked);
        }
    }

    Ok(false)
}

fn read_xref_probe_window(path: &Path, offset: u64) -> Result<Vec<u8>> {
    let mut file =
        File::open(path).map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    let mut bytes = Vec::new();
    file.take(MAX_XREF_PROBE_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    Ok(bytes)
}

fn xref_error(message: impl Into<String>) -> Box<dyn Error> {
    domain_error(NativeErrorCode::CorruptXref, message)
}

fn enforce_structural_nesting(
    dictionary_depth: usize,
    array_depth: usize,
    policy: PdfLoadPolicy,
) -> Result<()> {
    if dictionary_depth.saturating_add(array_depth) > policy.max_structural_nesting {
        return Err(limit_error(format!(
            "PDF structural nesting exceeds the {}-level admission ceiling",
            policy.max_structural_nesting
        )));
    }
    Ok(())
}

fn validate_admission_dictionary(
    dictionary: &AdmissionDictionary,
    policy: PdfLoadPolicy,
    declared_object_stream_objects: &mut u64,
) -> Result<()> {
    match dictionary.dictionary_type {
        Some(AdmissionDictionaryType::ObjectStream) => {
            let declared = dictionary.n.unwrap_or(0);
            if declared > policy.max_objects as u64 {
                return Err(limit_error(format!(
                    "PDF object stream declares more than the {}-object admission ceiling",
                    policy.max_objects
                )));
            }
            if dictionary
                .first
                .is_some_and(|first| first > policy.max_decompressed_stream_bytes as u64)
            {
                return Err(limit_error(format!(
                    "PDF object stream header exceeds the {}-byte decompression ceiling",
                    policy.max_decompressed_stream_bytes
                )));
            }
            *declared_object_stream_objects =
                declared_object_stream_objects.saturating_add(declared);
        }
        Some(AdmissionDictionaryType::PageTree) => {
            if let Some(count) = dictionary.count {
                validate_page_count(count, policy)?;
            }
        }
        Some(AdmissionDictionaryType::Xref) => {
            if dictionary
                .size
                .is_some_and(|size| size > policy.max_objects as u64)
                || dictionary
                    .index_total
                    .is_some_and(|total| total > policy.max_objects as u64)
                || dictionary
                    .largest_index_end
                    .is_some_and(|end| end > policy.max_objects as u64)
            {
                return Err(limit_error(format!(
                    "PDF cross-reference stream exceeds the {}-object admission ceiling",
                    policy.max_objects
                )));
            }
            if dictionary.width_count.is_some_and(|count| count != 3)
                || dictionary.largest_width.is_some_and(|width| width > 8)
            {
                return Err(limit_error(
                    "PDF cross-reference stream has an unsafe field-width declaration",
                ));
            }
        }
        None => {}
    }
    Ok(())
}

fn validate_loaded_document(document: &Document, policy: PdfLoadPolicy) -> Result<()> {
    let object_count = document
        .objects
        .len()
        .max(document.reference_table.entries.len());
    if object_count > policy.max_objects {
        return Err(limit_error(format!(
            "PDF object count exceeds the {}-object admission ceiling",
            policy.max_objects
        )));
    }

    let page_resolver = PageTreeResolver::new(document)?;
    let page_count = page_resolver.page_count();
    if page_count > 0 {
        // Check both ends of the declared tree without iterating every leaf.
        // This catches a stale /Count or an unreachable branch while keeping
        // path-backed admission independent of document page count.
        page_resolver.page_id(document, 1)?;
        if page_count > 1 {
            page_resolver.page_id(document, page_count)?;
        }
    }
    validate_page_count(u64::from(page_count), policy)
}

fn validate_page_count(page_count: u64, policy: PdfLoadPolicy) -> Result<()> {
    let page_count = usize::try_from(page_count)
        .map_err(|_| limit_error("PDF page count exceeds the supported integer range"))?;
    if let Some(max_pages) = policy.max_pages {
        if page_count > max_pages {
            return Err(limit_error(format!(
                "PDF page count exceeds the {}-page admission ceiling",
                max_pages
            )));
        }
    }
    Ok(())
}

pub(crate) fn load_pdf_bytes_with_policy(bytes: &[u8], policy: PdfLoadPolicy) -> Result<Document> {
    load_pdf_bytes_with_policy_and_password(bytes, policy, None)
}

/// Best-effort read of the `/Encrypt` dictionary's `/Filter` name for inputs
/// whose password authentication failed. Returns the handler name when it is
/// present and not the built-in `Standard` password handler, `None` otherwise.
fn probe_unsupported_security_handler(bytes: &[u8], policy: PdfLoadPolicy) -> Option<String> {
    let options = LoadOptions {
        max_decompressed_size: Some(policy.max_decompressed_stream_bytes),
        ..LoadOptions::default()
    };
    let document = Document::load_mem_with_options(bytes, options).ok()?;
    let dictionary = document.get_encrypted().ok()?;
    let filter = dictionary.get(b"Filter").ok()?;
    let name = filter.as_name().ok()?;
    if name == b"Standard" {
        None
    } else {
        Some(String::from_utf8_lossy(name).into_owned())
    }
}

fn classify_lopdf_load_error(
    error: LopdfError,
    policy: PdfLoadPolicy,
    bytes: &[u8],
) -> Box<dyn Error> {
    if matches!(
        error,
        LopdfError::Decompress(DecompressError::MemoryLimitExceeded { .. })
    ) {
        return limit_error(format!(
            "PDF stream exceeds the {}-byte decompression ceiling",
            policy.max_decompressed_stream_bytes
        ));
    }
    if matches!(error, LopdfError::InvalidPassword) {
        // lopdf only checks the security handler name inside
        // `EncryptionState::decode`, which runs after a successful password
        // authentication, so a public-key handler surfaces here as
        // `InvalidPassword`. A raw load without a password returns the trailer
        // intact, letting us read the `/Filter` name it refused to decrypt.
        if let Some(handler) = probe_unsupported_security_handler(bytes, policy) {
            return domain_error(
                NativeErrorCode::UnsupportedFilter,
                format!("Unsupported PDF security handler: {handler}"),
            );
        }
        return domain_error(
            NativeErrorCode::NeedsPassword,
            "The supplied password was not accepted by the encrypted PDF",
        );
    }
    if let LopdfError::UnsupportedSecurityHandler(handler) = &error {
        return domain_error(
            NativeErrorCode::UnsupportedFilter,
            format!(
                "Unsupported PDF security handler: {}",
                String::from_utf8_lossy(handler)
            ),
        );
    }
    if matches!(
        error,
        LopdfError::Decryption(DecryptionError::UnsupportedVersion)
            | LopdfError::Decryption(DecryptionError::UnsupportedRevision)
    ) {
        return domain_error(
            NativeErrorCode::UnsupportedFilter,
            "The encrypted PDF uses an encryption revision that is not supported",
        );
    }
    Box::new(error)
}

fn limit_error(message: impl Into<String>) -> Box<dyn Error> {
    domain_error(NativeErrorCode::TooLarge, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn policy(
        max_encoded_bytes: usize,
        max_decompressed_stream_bytes: usize,
        max_objects: usize,
        max_pages: usize,
    ) -> PdfLoadPolicy {
        PdfLoadPolicy {
            max_encoded_bytes,
            max_decompressed_stream_bytes,
            max_objects,
            max_pages: Some(max_pages),
            max_structural_nesting: 32,
        }
    }

    fn document_bytes(page_count: usize, include_object_stream: bool) -> Vec<u8> {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let mut kids = Vec::new();
        for _ in 0..page_count {
            let page_id = document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 72.into(), 72.into()],
            });
            kids.push(Object::Reference(page_id));
        }
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => page_count as i64,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        if include_object_stream {
            document.add_object(Object::String(vec![b'A'; 4_096], StringFormat::Literal));
        }
        let mut bytes = Vec::new();
        if include_object_stream {
            document.save_modern(&mut bytes).unwrap();
        } else {
            document.save_to(&mut bytes).unwrap();
        }
        bytes
    }

    fn assert_too_large(error: Box<dyn Error>) {
        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::TooLarge
        );
    }

    fn assert_corrupt_xref(error: Box<dyn Error>) {
        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::CorruptXref
        );
    }

    fn classic_xref_pdf(section: &[u8], trailer: &[u8], startxref: usize) -> Vec<u8> {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend_from_slice(section);
        bytes.extend_from_slice(b"trailer\n");
        bytes.extend_from_slice(trailer);
        bytes.extend_from_slice(format!("\nstartxref\n{startxref}\n%%EOF\n").as_bytes());
        bytes
    }

    #[test]
    fn byte_input_policy_accepts_small_documents_and_caps_encoded_bytes() {
        let bytes = document_bytes(1, false);
        load_pdf_bytes_with_policy(&bytes, policy(bytes.len(), 1_024, 16, 2)).unwrap();
        assert_too_large(
            load_pdf_bytes_with_policy(&bytes, policy(bytes.len() - 1, 1_024, 16, 2)).unwrap_err(),
        );
    }

    #[test]
    fn full_rewrite_policy_keeps_its_encoded_input_budget() {
        assert_eq!(PDF_LOAD_POLICY.max_encoded_bytes, 512 * 1024 * 1024);
    }

    #[test]
    fn incremental_path_loads_small_input_with_path_policy() {
        struct RemoveOnDrop(std::path::PathBuf);

        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }

        let bytes = document_bytes(1, false);
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_file = RemoveOnDrop(std::env::temp_dir().join(format!(
            "evb-pdf-page-ops-incremental-load-policy-{unique}.pdf"
        )));
        std::fs::write(&temp_file.0, &bytes).unwrap();

        let loaded = load_incremental_pdf_path(&temp_file.0, None).unwrap();
        assert_eq!(
            PageTreeResolver::new(loaded.get_prev_documents())
                .unwrap()
                .page_count(),
            1
        );
        assert_eq!(loaded.previous_len(), u64::try_from(bytes.len()).unwrap());
    }

    #[test]
    fn xref_probe_rejects_revision_windows_that_revisit_input_bytes() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("evb-pdf-page-ops-xref-probe-overlap-{nonce}.pdf"));
        let mut bytes = b"%PDF-1.7\n".to_vec();
        let first_offset = bytes.len();
        bytes.extend_from_slice(b"xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\n");
        bytes.extend_from_slice(format!("startxref\n{first_offset}\n%%EOF\n").as_bytes());
        let second_offset = bytes.len();
        bytes.extend_from_slice(b"xref\n0 1\n0000000000 65535 f \ntrailer\n");
        bytes.extend_from_slice(format!("<< /Size 1 /Prev {first_offset} >>\n").as_bytes());
        bytes.extend_from_slice(format!("startxref\n{second_offset}\n%%EOF\n").as_bytes());
        std::fs::write(&path, bytes).unwrap();

        let error = path_has_encryption_entry(&path)
            .expect_err("overlapping revision probe windows must fail closed");
        assert_corrupt_xref(error);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn page_path_load_accepts_a_document_above_the_byte_input_page_ceiling() {
        const PAGE_COUNT: usize = 100_001;
        struct RemoveOnDrop(std::path::PathBuf);

        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }

        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(lopdf::dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
        });
        document.set_object(
            pages_id,
            lopdf::dictionary! {
                "Type" => "Pages",
                "Kids" => Object::Array(vec![Object::Reference(page_id); PAGE_COUNT]),
                "Count" => i64::try_from(PAGE_COUNT).unwrap(),
            },
        );
        let catalog_id = document.add_object(lopdf::dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_file = RemoveOnDrop(std::env::temp_dir().join(format!(
            "evb-pdf-page-ops-page-size-load-policy-{unique}.pdf"
        )));
        std::fs::write(&temp_file.0, bytes).unwrap();

        let loaded = load_pdf_path(&temp_file.0).unwrap();
        assert_eq!(
            PageTreeResolver::new(&loaded).unwrap().page_count(),
            u32::try_from(PAGE_COUNT).unwrap()
        );
    }

    #[test]
    fn byte_input_policy_caps_objects_and_pages_after_loading() {
        let bytes = document_bytes(2, false);
        assert_too_large(
            load_pdf_bytes_with_policy(&bytes, policy(bytes.len(), 1_024, 2, 10)).unwrap_err(),
        );
        assert_too_large(
            load_pdf_bytes_with_policy(&bytes, policy(bytes.len(), 1_024, 32, 1)).unwrap_err(),
        );
    }

    #[test]
    fn path_policy_accepts_declared_page_count_above_byte_input_budget() {
        let bytes = b"%PDF-1.7\n1 0 obj << /Type /Pages /Count 100001 /Kids [] >> endobj";

        assert_too_large(
            preflight_pdf_structure(&bytes[..], policy(1_024, 1_024, 10, 100_000)).unwrap_err(),
        );
        preflight_pdf_structure(&bytes[..], PDF_PATH_LOAD_POLICY).unwrap();
        validate_page_count(100_001, PDF_PATH_LOAD_POLICY).unwrap();
    }

    #[test]
    fn path_policy_keeps_xlarge_page_admission_finite() {
        assert_eq!(
            PDF_PATH_LOAD_POLICY.max_pages,
            Some(MAX_PATH_INPUT_PDF_PAGES)
        );
        validate_page_count(138_000, PDF_PATH_LOAD_POLICY).unwrap();
        assert_too_large(
            validate_page_count(
                u64::try_from(MAX_PATH_INPUT_PDF_PAGES + 1).unwrap(),
                PDF_PATH_LOAD_POLICY,
            )
            .unwrap_err(),
        );
    }

    #[test]
    fn path_validation_checks_sparse_declared_pages_without_a_full_page_walk() {
        const PAGE_COUNT: i64 = 1_000_000;
        let mut document = Document::with_version("1.7");
        let root_pages_id = document.new_object_id();
        let first_group_id = document.new_object_id();
        let last_group_id = document.new_object_id();
        let first_page_id = document.new_object_id();
        let last_page_id = document.new_object_id();
        for (page_id, parent_id) in [
            (first_page_id, first_group_id),
            (last_page_id, last_group_id),
        ] {
            document.set_object(
                page_id,
                dictionary! {
                    "Type" => "Page",
                    "Parent" => parent_id,
                    "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                },
            );
        }
        document.set_object(
            first_group_id,
            dictionary! {
                "Type" => "Pages",
                "Parent" => root_pages_id,
                "Kids" => vec![Object::Reference(first_page_id)],
                "Count" => PAGE_COUNT - 1,
            },
        );
        document.set_object(
            last_group_id,
            dictionary! {
                "Type" => "Pages",
                "Parent" => root_pages_id,
                "Kids" => vec![Object::Reference(last_page_id)],
                "Count" => 1,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => root_pages_id,
        });
        document.set_object(
            root_pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![
                    Object::Reference(first_group_id),
                    Object::Reference(last_group_id),
                ],
                "Count" => PAGE_COUNT,
            },
        );
        document.trailer.set("Root", catalog_id);

        reset_page_tree_node_read_count();
        let sparse_tree_policy = PdfLoadPolicy {
            max_pages: Some(PAGE_COUNT as usize),
            ..PDF_PATH_LOAD_POLICY
        };
        validate_loaded_document(&document, sparse_tree_policy).unwrap();

        assert_eq!(
            document
                .get_dictionary(first_page_id)
                .unwrap()
                .get(b"Type")
                .unwrap()
                .as_name()
                .unwrap(),
            b"Page"
        );
        assert_eq!(
            document
                .get_dictionary(last_page_id)
                .unwrap()
                .get(b"Type")
                .unwrap()
                .as_name()
                .unwrap(),
            b"Page"
        );
        assert!(page_tree_node_read_count() < 100);
    }

    #[test]
    fn byte_input_policy_detects_lopdf_skipped_oversized_object_streams() {
        let bytes = document_bytes(1, true);
        assert_too_large(
            load_pdf_bytes_with_policy(&bytes, policy(bytes.len(), 64, 32, 2)).unwrap_err(),
        );
    }

    #[test]
    fn preflight_rejects_compact_xref_iteration_bombs_before_lopdf() {
        let bytes = b"%PDF-1.7\n1 0 obj\n<< /Type /XRef /Size 2 /Index [0 1001] /W [0 0 0] /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n9\n%%EOF\n";
        assert_too_large(
            preflight_pdf_structure(bytes, policy(bytes.len(), 1_024, 1_000, 10)).unwrap_err(),
        );

        let sparse_range = b"%PDF-1.7\n1 0 obj << /Type /XRef /Size 2 /Index [2000 1 0 1] /W [0 0 0] /Length 0 >> stream\n\nendstream\nendobj";
        assert_too_large(
            preflight_pdf_structure(sparse_range, policy(1_024, 1_024, 1_000, 10)).unwrap_err(),
        );
    }

    #[test]
    fn preflight_bounds_classic_xref_declared_and_actual_rows() {
        let oversized =
            classic_xref_pdf(b"xref\n0 1001\n", b"<< /Size 1001 >>", b"%PDF-1.7\n".len());
        assert_too_large(
            preflight_pdf_structure(&oversized, policy(4_096, 1_024, 1_000, 10)).unwrap_err(),
        );

        let truncated = classic_xref_pdf(
            b"xref\n0 2\n0000000000 65535 f\n",
            b"<< /Size 2 >>",
            b"%PDF-1.7\n".len(),
        );
        assert_corrupt_xref(
            preflight_pdf_structure(&truncated, policy(4_096, 1_024, 10, 10)).unwrap_err(),
        );

        let undeclared_row = classic_xref_pdf(
            b"xref\n0 1\n0000000000 65535 f\n0000000009 00000 n\n",
            b"<< /Size 2 >>",
            b"%PDF-1.7\n".len(),
        );
        assert_corrupt_xref(
            preflight_pdf_structure(&undeclared_row, policy(4_096, 1_024, 10, 10)).unwrap_err(),
        );
    }

    #[test]
    fn preflight_checks_classic_xref_ranges_and_trailer_size() {
        let overflow = classic_xref_pdf(
            b"xref\n18446744073709551615 2\n",
            b"<< /Size 2 >>",
            b"%PDF-1.7\n".len(),
        );
        assert_too_large(
            preflight_pdf_structure(&overflow, policy(4_096, 1_024, 10, 10)).unwrap_err(),
        );

        let oversized_size = classic_xref_pdf(
            b"xref\n0 1\n0000000000 65535 f\n",
            b"<< /Size 11 >>",
            b"%PDF-1.7\n".len(),
        );
        assert_too_large(
            preflight_pdf_structure(&oversized_size, policy(4_096, 1_024, 10, 10)).unwrap_err(),
        );

        let missing_size = classic_xref_pdf(
            b"xref\n0 1\n0000000000 65535 f\n",
            b"<< /Root 1 0 R >>",
            b"%PDF-1.7\n".len(),
        );
        assert_corrupt_xref(
            preflight_pdf_structure(&missing_size, policy(4_096, 1_024, 10, 10)).unwrap_err(),
        );
    }

    #[test]
    fn preflight_rejects_repeated_prev_and_xrefstm_offsets() {
        let root = b"%PDF-1.7\n".len();
        let prev_cycle = classic_xref_pdf(
            b"xref\n0 1\n0000000000 65535 f\n",
            format!("<< /Size 1 /Prev {root} >>").as_bytes(),
            root,
        );
        assert_corrupt_xref(
            preflight_pdf_structure(&prev_cycle, policy(4_096, 1_024, 10, 10)).unwrap_err(),
        );

        let duplicate_hybrid = classic_xref_pdf(
            b"xref\n0 1\n0000000000 65535 f\n",
            format!("<< /Size 1 /Prev {root} /XRefStm {root} >>").as_bytes(),
            root,
        );
        assert_corrupt_xref(
            preflight_pdf_structure(&duplicate_hybrid, policy(4_096, 1_024, 10, 10)).unwrap_err(),
        );
    }

    #[test]
    fn preflight_follows_and_validates_hybrid_xref_streams() {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        let stream_offset = bytes.len();
        bytes.extend_from_slice(
            b"1 0 obj\n<< /Type /XRef /Size 2 /Index [0 1] /W [1 1 1] /Length 3 >>\nstream\n\0\0\0\nendstream\nendobj\n",
        );
        let table_offset = bytes.len();
        bytes.extend_from_slice(b"xref\n0 2\n0000000000 65535 f\n0000000009 00000 n\ntrailer\n");
        bytes.extend_from_slice(format!("<< /Size 2 /XRefStm {stream_offset} >>").as_bytes());
        bytes.extend_from_slice(format!("\nstartxref\n{table_offset}\n%%EOF\n").as_bytes());
        preflight_pdf_structure(&bytes, policy(bytes.len(), 1_024, 10, 10)).unwrap();

        let unsafe_width = bytes
            .windows(b"/W [1 1 1]".len())
            .position(|window| window == b"/W [1 1 1]")
            .unwrap();
        let mut unsafe_bytes = bytes;
        unsafe_bytes.splice(
            unsafe_width..unsafe_width + b"/W [1 1 1]".len(),
            b"/W [1 9 1]".iter().copied(),
        );
        assert_too_large(
            preflight_pdf_structure(&unsafe_bytes, policy(unsafe_bytes.len(), 1_024, 10, 10))
                .unwrap_err(),
        );
    }

    #[test]
    fn preflight_rejects_compact_object_stream_and_page_tree_bombs() {
        let object_stream = b"%PDF-1.7\n1 0 obj << /Ty#70e /ObjStm /N 101 /First 0 /Length 0 >> stream\n\nendstream\nendobj";
        assert_too_large(
            preflight_pdf_structure(object_stream, policy(1_024, 1_024, 100, 10)).unwrap_err(),
        );

        let page_tree = b"%PDF-1.7\n1 0 obj << /Type /Pages /Count 11 /Kids [] >> endobj";
        assert_too_large(
            preflight_pdf_structure(page_tree, policy(1_024, 1_024, 100, 10)).unwrap_err(),
        );
    }

    #[test]
    fn preflight_bounds_direct_objects_and_structural_nesting() {
        let direct_objects =
            b"%PDF-1.7\n1 0 obj null endobj\n2 0 obj null endobj\n3 0 obj null endobj";
        assert_too_large(
            preflight_pdf_structure(direct_objects, policy(1_024, 1_024, 2, 10)).unwrap_err(),
        );

        let deeply_nested = b"%PDF-1.7\n1 0 obj << /A [ [ [ [ 0 ] ] ] ] >> endobj";
        let mut shallow_policy = policy(1_024, 1_024, 10, 10);
        shallow_policy.max_structural_nesting = 4;
        assert_too_large(preflight_pdf_structure(deeply_nested, shallow_policy).unwrap_err());
    }

    #[test]
    fn preflight_ignores_structural_decoys_in_comments_strings_and_streams() {
        let bytes = b"%PDF-1.7\n% 1 0 obj << /Type /Pages /Count 999 >>\n1 0 obj << /Note (2 0 obj /Type /Pages /Count 999) /Length 34 >>\nstream\n3 0 obj << /Type /ObjStm /N 999 >>\nendstream\nendobj";
        preflight_pdf_structure(bytes, policy(1_024, 1_024, 2, 2)).unwrap();
    }

    #[test]
    fn preflight_uses_declared_stream_length_not_embedded_endstream_bytes() {
        let stream_data = b"prefix endstream 9 0 obj << /Type /ObjStm /N 999 >> suffix";
        let mut bytes = format!(
            "%PDF-1.7\n1 0 obj << /Length {} >>\nstream\n",
            stream_data.len()
        )
        .into_bytes();
        bytes.extend_from_slice(stream_data);
        bytes.extend_from_slice(b"\nendstream\nendobj\n");
        preflight_pdf_structure(&bytes, policy(bytes.len(), 1_024, 2, 2)).unwrap();
    }

    #[test]
    fn preflight_treats_indirect_length_stream_data_as_opaque() {
        let stream_data = b"prefix endstream 9 0 obj << /Type /ObjStm /N 999 >> suffix";
        let mut bytes = b"%PDF-1.7\n1 0 obj << /Length 2 0 R >>\nstream\n".to_vec();
        bytes.extend_from_slice(stream_data);
        bytes.extend_from_slice(b"\nendstream\nendobj\n2 0 obj 62 endobj\n");
        preflight_pdf_structure(&bytes, policy(bytes.len(), 1_024, 2, 2)).unwrap();
    }

    #[test]
    fn preflight_does_not_let_a_bare_stream_keyword_hide_structure() {
        let bytes = b"%PDF-1.7\nstream\n1 0 obj << /Type /ObjStm /N 999 >>\nendstream";
        assert_too_large(
            preflight_pdf_structure(bytes, policy(bytes.len(), 1_024, 10, 2)).unwrap_err(),
        );
    }

    #[test]
    fn admission_lexer_preserves_the_delimiter_after_an_overflowing_integer() {
        let mut lexer = AdmissionLexer::new(b"184467440737095516160/Count");

        assert!(matches!(
            lexer.next_token(),
            Some(AdmissionToken::Integer(u64::MAX))
        ));
        assert!(matches!(
            lexer.next_token(),
            Some(AdmissionToken::Name(b"Count"))
        ));
    }

    #[test]
    fn preflight_rejects_a_direct_stream_length_outside_the_input() {
        let bytes = b"%PDF-1.7\n1 0 obj << /Length 999999 >>\nstream\nx\nendstream\nendobj\n2 0 obj << /Type /ObjStm /N 101 /First 0 /Length 0 >>\nstream\n\nendstream\nendobj";

        assert_too_large(
            preflight_pdf_structure(bytes, policy(bytes.len(), 1_024, 100, 10)).unwrap_err(),
        );
    }
}
