//! Unified document text search for EVB Viewer (desktop and browser WASM).
//!
//! `evb-pdf-search` builds and searches binary `EVBSIDX4` document text
//! indexes and raw page streams in memory. The index is a derived cache keyed
//! by document revision: a missing, malformed, older-format, or foreign-revision
//! index answers `{"stale":true}` so the caller rebuilds it from the document.

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
mod wasm;

use evb_native_support::{NativeError, NativeErrorCode};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};
use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::sync::OnceLock;
use unicode_normalization::char::canonical_combining_class;
use unicode_normalization::{is_nfc_quick, IsNormalized, UnicodeNormalization};

pub const MAGIC: &[u8; 8] = b"EVBSIDX4";
/// magic, page count, pages scanned, flags, revision length, record count, reserved.
pub const HEADER_SIZE: usize = 32;
/// page number and UTF-8 byte length.
pub const RECORD_SIZE: usize = 8;
const FLAG_TRUNCATED: u32 = 1;
pub const MAX_INDEX_BYTES: usize = 320 * 1024 * 1024;
/// Search reads stored page text in chunks of about this size; a larger page
/// is read whole.
pub const READ_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// Ceilings on the text budget a caller may ask `index` to hold.
pub const MAX_PAGE_TEXT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TOTAL_TEXT_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_DOCUMENT_REVISION_BYTES: usize = 8_192;
pub const MAX_QUERY_UTF16_UNITS: usize = 2_048;
pub const MAX_RESULT_LIMIT: usize = 500;
pub const MAX_MATCH_PAGE_LIMIT: usize = MAX_RESULT_LIMIT + 1;
pub const MAX_CONTEXT_CHARS: usize = 56;
const MISSING_TEXT_PAGE_SAMPLE: usize = 80;
/// Letters, numbers, marks, underscore and apostrophes join a word, as in
/// `packages/pdf-core/pdfSearchAlgorithms.ts`.
const WORD_CHARACTER_CLASS: &str = r"\p{L}\p{N}\p{M}_'’";

/// Binary page-record header: page_number (u32), flags (u32), text_byte_len (u32).
const PAGE_RECORD_HEADER_SIZE: usize = 12;
const PAGE_RECORD_FLAG_TEXT: u32 = 0;
const PAGE_RECORD_FLAG_OVER_BUDGET: u32 = 1;

pub const REQUEST_MAGIC: &[u8; 4] = b"EPSR";
pub const REQUEST_VERSION: u32 = 1;
const REQUEST_PREFIX_SIZE: usize = 12;

fn invalid_request(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message)
}

fn too_large(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::TooLarge, message)
}

#[derive(Debug, Clone, Copy)]
struct PageRecord {
    page_number: u32,
    offset: usize,
    byte_len: usize,
}

#[derive(Debug)]
pub struct SearchIndex<R = Cursor<Vec<u8>>> {
    page_count: u32,
    pages_scanned: u32,
    truncated: bool,
    records: Vec<PageRecord>,
    data: R,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub page_count: u32,
    pub pages_scanned: u32,
    pub pages_written: u32,
    pub truncated: bool,
    /// The first scanned pages that carry no text, for OCR recommendations.
    pub missing_text_page_sample: Vec<u32>,
}

impl<R: Read + Seek> SearchIndex<R> {
    pub fn coverage(&self) -> Coverage {
        let mut written = self
            .records
            .iter()
            .map(|record| record.page_number)
            .peekable();
        let missing_text_page_sample = (1..=self.pages_scanned)
            .filter(|page_number| {
                while written
                    .next_if(|written_page| written_page < page_number)
                    .is_some()
                {}
                written.next_if_eq(page_number).is_none()
            })
            .take(MISSING_TEXT_PAGE_SAMPLE)
            .collect();
        Coverage {
            page_count: self.page_count,
            pages_scanned: self.pages_scanned,
            pages_written: u32::try_from(self.records.len()).unwrap_or(u32::MAX),
            truncated: self.truncated,
            missing_text_page_sample,
        }
    }

    /// Visits the text of the given records, in increasing record order. Page
    /// text is stored back to back, so consecutive selected records that fit
    /// one bounded chunk are read with one seek and one read. Stopping a batch
    /// when a record index is skipped ensures a sparse page filter never reads
    /// unselected pages in between.
    fn visit_pages(
        &mut self,
        record_indices: &[usize],
        mut visit: impl FnMut(usize, u32, &str) -> Result<bool, NativeError>,
    ) -> Result<(), NativeError> {
        let io_error = |error: io::Error| NativeError::new(NativeErrorCode::Io, error.to_string());
        let mut buffer = Vec::new();
        let mut next = 0;
        while let Some(&first) = record_indices.get(next) {
            let start = self.records[first].offset;
            let mut previous = first;
            let span = record_indices[next..]
                .iter()
                .take_while(|&&index| {
                    let record = self.records[index];
                    let batched = index == first
                        || (index == previous + 1
                            && record.offset + record.byte_len - start <= READ_CHUNK_BYTES);
                    previous = index;
                    batched
                })
                .count();
            let last = self.records[record_indices[next + span - 1]];
            buffer.resize(last.offset + last.byte_len - start, 0);
            self.data
                .seek(SeekFrom::Start(start as u64))
                .map_err(io_error)?;
            self.data.read_exact(&mut buffer).map_err(io_error)?;
            for &index in &record_indices[next..next + span] {
                let record = self.records[index];
                let bytes = &buffer[record.offset - start..record.offset - start + record.byte_len];
                let text = std::str::from_utf8(bytes).map_err(|_| {
                    NativeError::new(
                        NativeErrorCode::CorruptXref,
                        "Search index text is not UTF-8",
                    )
                })?;
                if !visit(index, record.page_number, text)? {
                    return Ok(());
                }
            }
            next += span;
        }
        Ok(())
    }
}

/// Reads only the header and table; page bytes stay in the reader.
pub fn parse_index<R: Read + Seek>(
    mut data: R,
    file_len: usize,
    expected_revision: &str,
) -> io::Result<Option<SearchIndex<R>>> {
    let mut header = [0; HEADER_SIZE];
    data.read_exact(&mut header)?;
    let [page_count, pages_scanned, flags, revision_len, record_count, reserved] =
        std::array::from_fn(|i| {
            u32::from_le_bytes(header[8 + i * 4..12 + i * 4].try_into().unwrap())
        });
    let (revision_len, record_count) = (revision_len as usize, record_count as usize);
    let Some(payload_len) = file_len
        .checked_sub(HEADER_SIZE)
        .and_then(|len| len.checked_sub(revision_len))
    else {
        return Ok(None);
    };
    // Each distinct scanned page owns a table entry and at least one text byte.
    if &header[..8] != MAGIC
        || reserved != 0
        || pages_scanned > page_count
        || flags & !FLAG_TRUNCATED != 0
        || revision_len != expected_revision.len()
        || record_count > pages_scanned as usize
        || record_count > payload_len / (RECORD_SIZE + 1)
    {
        return Ok(None);
    }
    let mut revision = vec![0; revision_len];
    data.read_exact(&mut revision)?;
    if revision != expected_revision.as_bytes() {
        return Ok(None);
    }
    let mut records = Vec::with_capacity(record_count);
    let mut offset = HEADER_SIZE + revision_len + record_count * RECORD_SIZE;
    let mut previous_page = 0;
    for _ in 0..record_count {
        let mut bytes = [0; RECORD_SIZE];
        data.read_exact(&mut bytes)?;
        let page_number = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        let byte_len = u32::from_le_bytes(bytes[4..].try_into().unwrap()) as usize;
        if page_number <= previous_page
            || page_number > pages_scanned
            || byte_len == 0
            || byte_len > file_len - offset
        {
            return Ok(None);
        }
        records.push(PageRecord {
            page_number,
            offset,
            byte_len,
        });
        previous_page = page_number;
        offset += byte_len;
    }
    Ok((offset == file_len).then_some(SearchIndex {
        page_count,
        pages_scanned,
        truncated: flags & FLAG_TRUNCATED != 0,
        records,
        data,
    }))
}

pub fn load_index_bytes<'a>(
    bytes: &'a [u8],
    expected_revision: &str,
) -> Result<Option<SearchIndex<Cursor<&'a [u8]>>>, NativeError> {
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(too_large(format!(
            "Search index exceeds the {MAX_INDEX_BYTES}-byte admission ceiling"
        )));
    }
    match parse_index(Cursor::new(bytes), bytes.len(), expected_revision) {
        Ok(index) => Ok(index),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(NativeError::new(
            NativeErrorCode::Io,
            format!("Search index could not be read: {error}"),
        )),
    }
}

/// The text one index holds, in UTF-8 bytes: the caller's budget, within the
/// ceilings above.
#[derive(Debug, Clone, Copy)]
pub struct TextBudget {
    pub page: usize,
    pub total: usize,
}

impl Default for TextBudget {
    fn default() -> Self {
        Self {
            page: MAX_PAGE_TEXT_BYTES,
            total: MAX_TOTAL_TEXT_BYTES,
        }
    }
}

impl TextBudget {
    pub fn validated(
        max_page_text_bytes: Option<usize>,
        max_total_text_bytes: Option<usize>,
    ) -> Result<Self, NativeError> {
        let ceiling = Self::default();
        let page = match max_page_text_bytes {
            None => ceiling.page,
            Some(value) if value == 0 || value > ceiling.page => {
                return Err(too_large(format!(
                    "maxPageTextBytes must be between 1 and {} bytes",
                    ceiling.page
                )));
            }
            Some(value) => value,
        };
        let total = match max_total_text_bytes {
            None => ceiling.total,
            Some(value) if value == 0 || value > ceiling.total => {
                return Err(too_large(format!(
                    "maxTotalTextBytes must be between 1 and {} bytes",
                    ceiling.total
                )));
            }
            Some(value) => value,
        };
        Ok(Self { page, total })
    }
}

/// Reads binary page records `[page_number: u32 LE][flags: u32 LE][byte_len: u32 LE][utf8]`
/// and builds the index in memory. Pages must arrive in increasing order; a
/// page with no text is scanned but not stored. The first page over the budget,
/// received or reported, ends what is stored; a reported one is the producer's
/// last record, so anything after it is refused.
pub fn read_binary_pages(
    payload: &[u8],
    page_count: Option<u32>,
    revision: &str,
    budget: TextBudget,
) -> Result<SearchIndex, NativeError> {
    if revision.is_empty() || revision.len() > MAX_DOCUMENT_REVISION_BYTES {
        return Err(invalid_request(
            "Search index document revision has an invalid length",
        ));
    }
    if page_count == Some(0) {
        return Err(invalid_request("Invalid pageCount: 0"));
    }
    let mut records = Vec::new();
    let mut data = Vec::new();
    let mut pages_seen = 0u32;
    let mut pages_scanned = 0u32;
    let mut truncated = false;
    let mut reported_over_budget = false;
    let mut offset = 0usize;

    while offset < payload.len() {
        let header_end = offset
            .checked_add(PAGE_RECORD_HEADER_SIZE)
            .filter(|&end| end <= payload.len())
            .ok_or_else(|| invalid_request("Invalid search index input page: truncated header"))?;
        let page_number = u32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
        let flags = u32::from_le_bytes(payload[offset + 4..offset + 8].try_into().unwrap());
        let text_len =
            u32::from_le_bytes(payload[offset + 8..offset + 12].try_into().unwrap()) as usize;
        offset = header_end;

        let text_end = offset
            .checked_add(text_len)
            .filter(|&end| end <= payload.len())
            .ok_or_else(|| invalid_request("Invalid search index input page: truncated text"))?;
        let text_bytes = &payload[offset..text_end];
        offset = text_end;

        if reported_over_budget {
            return Err(invalid_request(format!(
                "Search index page {page_number} follows the page reported over the budget"
            )));
        }
        if page_number <= pages_seen || page_number > page_count.unwrap_or(u32::MAX) {
            return Err(invalid_request(format!(
                "Search index page {page_number} is out of order or outside the document"
            )));
        }
        pages_seen = page_number;

        match flags {
            PAGE_RECORD_FLAG_OVER_BUDGET => {
                if text_len != 0 {
                    return Err(invalid_request(format!(
                        "Search index page {page_number} needs either text or overBudget"
                    )));
                }
                (truncated, reported_over_budget) = (true, true);
                continue;
            }
            PAGE_RECORD_FLAG_TEXT => {
                if std::str::from_utf8(text_bytes).is_err() {
                    return Err(invalid_request(format!(
                        "Invalid search index input page {page_number}: text is not UTF-8"
                    )));
                }
            }
            _ => {
                return Err(invalid_request(format!(
                    "Invalid search index input page {page_number}: unknown record flags {flags}"
                )));
            }
        }
        if truncated {
            continue;
        }
        if text_len > budget.page || data.len() + text_len > budget.total {
            truncated = true;
            continue;
        }
        pages_scanned = page_number;
        if text_len > 0 {
            records.push(PageRecord {
                page_number,
                offset: data.len(),
                byte_len: text_len,
            });
            data.extend_from_slice(text_bytes);
        }
    }

    Ok(SearchIndex {
        page_count: page_count.unwrap_or(pages_seen),
        pages_scanned,
        truncated,
        records,
        data: Cursor::new(data),
    })
}

/// Serializes an in-memory `SearchIndex` into `EVBSIDX4` bytes.
pub fn serialize_index(index: &SearchIndex, revision: &str) -> Result<Vec<u8>, NativeError> {
    let revision_len = u32::try_from(revision.len())
        .map_err(|_| invalid_request("Search index document revision exceeds u32 length"))?;
    let record_count = u32::try_from(index.records.len())
        .map_err(|_| too_large("Search index record count exceeds u32 limit"))?;
    let text_bytes = index.data.get_ref();
    let total_len = HEADER_SIZE
        .checked_add(revision.len())
        .and_then(|len| len.checked_add(index.records.len().checked_mul(RECORD_SIZE)?))
        .and_then(|len| len.checked_add(text_bytes.len()))
        .ok_or_else(|| too_large("Search index size overflow"))?;
    if total_len > MAX_INDEX_BYTES {
        return Err(too_large(format!(
            "Search index exceeds the {MAX_INDEX_BYTES}-byte admission ceiling"
        )));
    }
    let mut output = Vec::with_capacity(total_len);
    output.extend_from_slice(MAGIC);
    for value in [
        index.page_count,
        index.pages_scanned,
        if index.truncated { FLAG_TRUNCATED } else { 0 },
        revision_len,
        record_count,
        0,
    ] {
        output.extend_from_slice(&value.to_le_bytes());
    }
    output.extend_from_slice(revision.as_bytes());
    for record in &index.records {
        output.extend_from_slice(&record.page_number.to_le_bytes());
        let byte_len = u32::try_from(record.byte_len)
            .map_err(|_| too_large("Search index page exceeds u32 byte length"))?;
        output.extend_from_slice(&byte_len.to_le_bytes());
    }
    output.extend_from_slice(text_bytes);
    Ok(output)
}

pub struct SearchOptions {
    pub query: String,
    pub limit: usize,
    pub context_chars: usize,
    pub result_offset: Option<usize>,
    pub match_case: bool,
    pub whole_word: bool,
    pub use_regex: bool,
    pub pages: Option<BTreeSet<u32>>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct SearchExcerpt {
    pub prefix: bool,
    pub suffix: bool,
    pub before: String,
    #[serde(rename = "match")]
    pub matched_text: String,
    pub after: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub page_number: u32,
    pub page_match_index: usize,
    pub match_index: usize,
    pub start_offset: usize,
    pub end_offset: usize,
    pub excerpt: SearchExcerpt,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<SearchMatch>,
    pub truncated: bool,
    pub page_count: u32,
    pub coverage: Coverage,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageWindowMatch {
    pub page_match_index: usize,
    pub start_offset: usize,
    pub end_offset: usize,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MatchPageResponse {
    pub matches: Vec<PageWindowMatch>,
    pub truncated: bool,
    pub match_count: usize,
}

fn fold_search_ligature(character: char) -> Option<&'static str> {
    match character {
        '\u{fb00}' => Some("ff"),
        '\u{fb01}' => Some("fi"),
        '\u{fb02}' => Some("fl"),
        '\u{fb03}' => Some("ffi"),
        '\u{fb04}' => Some("ffl"),
        '\u{fb05}' | '\u{fb06}' => Some("st"),
        // Long s, as early printed books and their OCR spell it.
        '\u{17f}' => Some("s"),
        // A typographic apostrophe is the ASCII one. The left quote stays apart:
        // transliteration writes ayin with it and aleph with the apostrophe.
        '\u{2019}' => Some("'"),
        _ => None,
    }
}

/// Canonical composition plus the presentation ligatures PDF fonts emit and
/// long s; deliberately narrower than NFKC.
fn normalize_search_fragment(value: &str) -> String {
    let mut folded = String::with_capacity(value.len());
    for character in value.chars() {
        match fold_search_ligature(character) {
            Some(replacement) => folded.push_str(replacement),
            None => folded.push(character),
        }
    }
    folded.nfc().collect()
}

/// Only changed composition spans need a mapping back to original bytes.
#[derive(Debug)]
struct NormalizedText {
    text: String,
    spans: Vec<(std::ops::Range<usize>, std::ops::Range<usize>)>,
}

impl NormalizedText {
    fn new(value: &str) -> Self {
        let mut normalized = Self {
            text: String::with_capacity(value.len()),
            spans: Vec::new(),
        };
        static GROUPS: OnceLock<Regex> = OnceLock::new();
        let groups = GROUPS.get_or_init(|| Regex::new(
            r"(?:[\u{1100}-\u{1112}][\u{1161}-\u{1175}][\u{11a8}-\u{11c2}]?|[\u{ac00}-\u{d7a3}][\u{11a8}-\u{11c2}]|\P{M})\p{M}*|\p{M}+",
        ).expect("canonical search grouping is valid"));
        let bytes = value.as_bytes();
        let mut copied = 0;
        while let Some(first) = bytes[copied..].iter().position(|byte| !byte.is_ascii()) {
            let first = copied + first;
            let start = first.saturating_sub(1).max(copied);
            let end = bytes[first..]
                .iter()
                .position(u8::is_ascii)
                .map_or(bytes.len(), |offset| first + offset);
            if is_search_normalized(&value[start..end]) {
                normalized.text.push_str(&value[copied..end]);
                copied = end;
                continue;
            }
            normalized.text.push_str(&value[copied..start]);
            for group in groups.find_iter(&value[start..end]) {
                let original = group.as_str();
                if is_search_normalized(original) {
                    normalized.text.push_str(original);
                    continue;
                }
                let text = normalize_search_fragment(original);
                let normalized_start = normalized.text.len();
                normalized.text.push_str(&text);
                if text != original {
                    normalized.spans.push((
                        normalized_start..normalized.text.len(),
                        start + group.start()..start + group.end(),
                    ));
                }
            }
            copied = end;
        }
        normalized.text.push_str(&value[copied..]);
        normalized
    }

    fn original_byte_range(&self, start: usize, end: usize) -> (usize, usize) {
        let original_offset = |offset, end_boundary| {
            let index = self.spans.partition_point(|(range, _)| {
                if end_boundary {
                    range.start < offset
                } else {
                    range.start <= offset
                }
            });
            self.spans
                .get(index.wrapping_sub(1))
                .map_or(offset, |(range, original)| {
                    if offset >= range.end {
                        original.end + (offset - range.end)
                    } else if end_boundary {
                        original.end
                    } else {
                        original.start
                    }
                })
        };
        (original_offset(start, false), original_offset(end, true))
    }
}

/// Scalars that are their own composition, combine with nothing before them
/// and start a new combining sequence: Latin, Cyrillic, Hebrew and Arabic
/// letters, kana, CJK ideographs and Hangul syllables, but not long s.
fn is_stable_starter(character: char) -> bool {
    matches!(
        character,
        '\0'..='\u{17e}'
            | '\u{180}'..='\u{2ff}'
            | '\u{400}'..='\u{482}'
            | '\u{48a}'..='\u{52f}'
            | '\u{5d0}'..='\u{5ea}'
            | '\u{620}'..='\u{64a}'
            | '\u{3041}'..='\u{3096}'
            | '\u{30a1}'..='\u{30fa}'
            | '\u{4e00}'..='\u{9fff}'
            | '\u{ac00}'..='\u{d7a3}'
    )
}

/// Whether `text` is already composed and free of search folds: the NFC
/// quick check answering yes, with stable starters taking its ASCII path.
fn is_search_normalized(text: &str) -> bool {
    let mut last_class = 0;
    for character in text.chars() {
        if is_stable_starter(character) {
            last_class = 0;
            continue;
        }
        let class = canonical_combining_class(character);
        if (class != 0 && last_class > class)
            || fold_search_ligature(character).is_some()
            || is_nfc_quick(std::iter::once(character)) != IsNormalized::Yes
        {
            return false;
        }
        last_class = class;
    }
    true
}

/// Most page text is already composed and free of ligatures, so matching can
/// run on it directly and keep its offsets.
fn needs_normalization(text: &str) -> bool {
    !text.is_ascii() && !is_search_normalized(text)
}

fn contains_unsegmented_script(value: &str) -> bool {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"[\p{Han}\p{Hiragana}\p{Katakana}\p{Hangul}]").ok())
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(value))
}

/// The query as a regex: literal or regex query over normalized text, optional
/// case folding, and whole-word boundaries except for literal queries in
/// unsegmented scripts. With boundaries, group 1 is the match and the
/// characters around it only delimit it.
struct Matcher {
    regex: Regex,
    bounded: bool,
}

impl Matcher {
    fn new(
        query: &str,
        match_case: bool,
        whole_word: bool,
        use_regex: bool,
    ) -> Result<Self, NativeError> {
        let query = normalize_search_fragment(query);
        // Each run of whitespace in a literal query matches any run of
        // whitespace in the page, across a line break or a no-break space.
        let pattern = if use_regex {
            query.clone()
        } else {
            static WHITESPACE: OnceLock<Regex> = OnceLock::new();
            WHITESPACE
                .get_or_init(|| Regex::new(r"\s+").expect("whitespace pattern is valid"))
                .split(&query)
                .map(regex::escape)
                .collect::<Vec<_>>()
                .join(r"\s+")
        };
        let bounded = whole_word && (use_regex || !contains_unsegmented_script(&query));
        let pattern = if bounded {
            format!(r"(?:\A|[^{WORD_CHARACTER_CLASS}])({pattern})(?:[^{WORD_CHARACTER_CLASS}]|\z)")
        } else {
            pattern
        };
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(!match_case)
            .build()
            .map_err(|error| invalid_request(format!("Invalid search regex: {error}")))?;
        Ok(Self { regex, bounded })
    }

    /// Non-empty match byte ranges in `text`. Each search resumes at the end
    /// of the previous match, so one boundary character can close a whole
    /// word and open the next.
    fn matches<'a>(&'a self, text: &'a str) -> impl Iterator<Item = (usize, usize)> + 'a {
        let mut position = 0usize;
        std::iter::from_fn(move || {
            while position <= text.len() {
                let found = if self.bounded {
                    self.regex.captures_at(text, position)?.get(1)?
                } else {
                    self.regex.find_at(text, position)?
                };
                let (start, end) = (found.start(), found.end());
                if start == end {
                    position = start + text[start..].chars().next().map_or(1, char::len_utf8);
                    continue;
                }
                position = end;
                return Some((start, end));
            }
            None
        })
    }
}

fn is_js_whitespace(character: char) -> bool {
    character == '\u{feff}' || (character != '\u{85}' && character.is_whitespace())
}

fn collapse_whitespace(value: &str) -> String {
    let mut collapsed = String::with_capacity(value.len());
    let mut in_whitespace = false;
    for character in value.chars() {
        if is_js_whitespace(character) {
            if !in_whitespace {
                collapsed.push(' ');
                in_whitespace = true;
            }
            continue;
        }
        collapsed.push(character);
        in_whitespace = false;
    }
    collapsed
}

fn build_excerpt(
    text: &str,
    (start_byte, end_byte): (usize, usize),
    start_utf16: usize,
    context_chars: usize,
) -> SearchExcerpt {
    // Context boundaries round down in UTF-16, including a scalar whose
    // trailing surrogate precedes the match and excluding one after it.
    let excerpt_start_byte = text[..start_byte]
        .char_indices()
        .rev()
        .scan(0, |units, (byte, character)| {
            if *units >= context_chars {
                return None;
            }
            *units += character.len_utf16();
            Some(byte)
        })
        .last()
        .unwrap_or(start_byte);
    let excerpt_end_byte = end_byte
        + text[end_byte..]
            .chars()
            .scan(0, |units, character| {
                *units += character.len_utf16();
                (*units <= context_chars).then_some(character.len_utf8())
            })
            .sum::<usize>();
    let before = collapse_whitespace(&text[excerpt_start_byte..start_byte]);
    let after = collapse_whitespace(&text[end_byte..excerpt_end_byte]);
    SearchExcerpt {
        prefix: start_utf16 > context_chars,
        suffix: text[end_byte..]
            .encode_utf16()
            .take(context_chars + 1)
            .count()
            > context_chars,
        before: before.trim_start_matches(is_js_whitespace).to_string(),
        matched_text: text[start_byte..end_byte].to_string(),
        after: after.trim_end_matches(is_js_whitespace).to_string(),
    }
}

pub fn search_index<R: Read + Seek>(
    index: &mut SearchIndex<R>,
    options: &SearchOptions,
) -> Result<SearchResponse, NativeError> {
    let matcher = Matcher::new(
        &options.query,
        options.match_case,
        options.whole_word,
        options.use_regex,
    )?;
    let mut results = VecDeque::new();
    let mut truncated = false;
    let mut match_count = 0;
    let selected: Vec<usize> = (0..index.records.len())
        .filter(|&record_index| {
            options
                .pages
                .as_ref()
                .is_none_or(|pages| pages.contains(&index.records[record_index].page_number))
        })
        .collect();
    index.visit_pages(&selected, |record_index, _, text| {
        let normalized = needs_normalization(text).then(|| NormalizedText::new(text));
        let haystack = normalized
            .as_ref()
            .map_or(text, |value| value.text.as_str());
        let mut ascii = None;
        let (mut mapped_byte, mut mapped_utf16) = (0, 0);
        for (page_match_index, (start, end)) in matcher.matches(haystack).enumerate() {
            let match_index = match_count;
            match_count += 1;
            if options
                .result_offset
                .is_some_and(|offset| match_index < offset)
            {
                continue;
            }
            if options.result_offset.is_some() && results.len() >= options.limit {
                truncated = true;
                return Ok(false);
            }
            let bytes = match &normalized {
                Some(value) => value.original_byte_range(start, end),
                None => (start, end),
            };
            let utf16 = if *ascii.get_or_insert_with(|| text.is_ascii()) {
                bytes
            } else {
                // Matches advance in source order, including repeated ranges
                // inside an expanded ligature. Count each preceding scalar once.
                mapped_utf16 += text[mapped_byte..bytes.0].encode_utf16().count();
                mapped_byte = bytes.0;
                (
                    mapped_utf16,
                    mapped_utf16 + text[bytes.0..bytes.1].encode_utf16().count(),
                )
            };
            results.push_back((record_index, page_match_index, match_index, utf16, bytes));
            if results.len() > options.limit {
                results.pop_front();
            }
        }
        Ok(true)
    })?;
    let mut kept_pages: Vec<usize> = results.iter().map(|result| result.0).collect();
    kept_pages.dedup();
    let mut kept = Vec::with_capacity(results.len());
    let mut results = results.into_iter().peekable();
    index.visit_pages(&kept_pages, |record_index, page_number, text| {
        while let Some((_, page_match_index, match_index, utf16, bytes)) =
            results.next_if(|result| result.0 == record_index)
        {
            kept.push(SearchMatch {
                page_number,
                page_match_index,
                match_index,
                start_offset: utf16.0,
                end_offset: utf16.1,
                excerpt: build_excerpt(text, bytes, utf16.0, options.context_chars),
            });
        }
        Ok(true)
    })?;
    Ok(SearchResponse {
        results: kept,
        truncated,
        page_count: index.page_count,
        coverage: index.coverage(),
    })
}

/// Matches a single page's UTF-8 text into a bounded UTF-16 range window.
pub fn match_page_window(
    text: &str,
    query: &str,
    match_case: bool,
    whole_word: bool,
    use_regex: bool,
    max_matches: usize,
    result_offset: Option<usize>,
) -> Result<MatchPageResponse, NativeError> {
    if query.is_empty() {
        return Err(invalid_request("Missing required query"));
    }
    if query.encode_utf16().count() > MAX_QUERY_UTF16_UNITS {
        return Err(too_large(format!(
            "Search query exceeds the {MAX_QUERY_UTF16_UNITS}-character admission ceiling"
        )));
    }
    if max_matches == 0 || max_matches > MAX_MATCH_PAGE_LIMIT {
        return Err(too_large("Search maxMatches exceeds its admission ceiling"));
    }
    if text.len() > MAX_PAGE_TEXT_BYTES {
        return Err(too_large(format!(
            "Page text exceeds the {MAX_PAGE_TEXT_BYTES}-byte admission ceiling"
        )));
    }
    let matcher = Matcher::new(query, match_case, whole_word, use_regex)?;
    let normalized = needs_normalization(text).then(|| NormalizedText::new(text));
    let haystack = normalized
        .as_ref()
        .map_or(text, |value| value.text.as_str());
    let mut ascii = None;
    let (mut mapped_byte, mut mapped_utf16) = (0, 0);
    let mut matches = VecDeque::new();
    let mut match_count = 0usize;
    let mut truncated = false;

    for (start, end) in matcher.matches(haystack) {
        let page_match_index = match_count;
        match_count += 1;
        if result_offset.is_some_and(|offset| page_match_index < offset) {
            continue;
        }
        if result_offset.is_some() && matches.len() >= max_matches {
            truncated = true;
            break;
        }
        let bytes = match &normalized {
            Some(value) => value.original_byte_range(start, end),
            None => (start, end),
        };
        let utf16 = if *ascii.get_or_insert_with(|| text.is_ascii()) {
            bytes
        } else {
            mapped_utf16 += text[mapped_byte..bytes.0].encode_utf16().count();
            mapped_byte = bytes.0;
            (
                mapped_utf16,
                mapped_utf16 + text[bytes.0..bytes.1].encode_utf16().count(),
            )
        };
        matches.push_back(PageWindowMatch {
            page_match_index,
            start_offset: utf16.0,
            end_offset: utf16.1,
        });
        if matches.len() > max_matches {
            matches.pop_front();
        }
    }

    Ok(MatchPageResponse {
        matches: matches.into_iter().collect(),
        truncated,
        match_count,
    })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireResultOffset {
    Number(usize),
    Tag(String),
}

impl WireResultOffset {
    fn into_option(self) -> Result<Option<usize>, NativeError> {
        match self {
            Self::Number(value) => Ok(Some(value)),
            Self::Tag(tag) if tag == "last" => Ok(None),
            Self::Tag(tag) => Err(invalid_request(format!("Invalid resultOffset: {tag}"))),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSearchQuery {
    query: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    context_chars: Option<usize>,
    #[serde(default)]
    result_offset: Option<WireResultOffset>,
    #[serde(default)]
    match_case: bool,
    #[serde(default)]
    whole_word: bool,
    #[serde(default)]
    use_regex: bool,
    #[serde(default)]
    pages: Option<Vec<u32>>,
}

impl WireSearchQuery {
    fn into_options(self) -> Result<SearchOptions, NativeError> {
        if self.query.is_empty() {
            return Err(invalid_request("Missing required query"));
        }
        if self.query.encode_utf16().count() > MAX_QUERY_UTF16_UNITS {
            return Err(too_large(format!(
                "Search query exceeds the {MAX_QUERY_UTF16_UNITS}-character admission ceiling"
            )));
        }
        let limit = self.limit.unwrap_or(MAX_RESULT_LIMIT);
        let context_chars = self.context_chars.unwrap_or(24);
        if limit > MAX_RESULT_LIMIT || context_chars > MAX_CONTEXT_CHARS {
            return Err(too_large(
                "Search limit, context or result offset exceeds its admission ceiling",
            ));
        }
        let result_offset = match self.result_offset {
            None => Some(0),
            Some(offset) => offset.into_option()?,
        };
        let pages = match self.pages {
            None => None,
            Some(list) if list.is_empty() => None,
            Some(list) => {
                let mut set = BTreeSet::new();
                for page in list {
                    if page == 0 {
                        return Err(invalid_request("Invalid page number in pages: 0"));
                    }
                    set.insert(page);
                }
                Some(set)
            }
        };
        Ok(SearchOptions {
            query: self.query,
            limit,
            context_chars,
            result_offset,
            match_case: self.match_case,
            whole_word: self.whole_word,
            use_regex: self.use_regex,
            pages,
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum WasmRequestHeader {
    #[serde(rename_all = "camelCase")]
    Index {
        document_revision: String,
        #[serde(default)]
        page_count: Option<u32>,
        #[serde(default)]
        max_page_text_bytes: Option<usize>,
        #[serde(default)]
        max_total_text_bytes: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    Stat { document_revision: String },
    #[serde(rename_all = "camelCase")]
    Search {
        document_revision: String,
        #[serde(flatten)]
        search: WireSearchQuery,
    },
    #[serde(rename_all = "camelCase")]
    SearchPages {
        document_revision: String,
        #[serde(default)]
        page_count: Option<u32>,
        #[serde(default)]
        max_page_text_bytes: Option<usize>,
        #[serde(default)]
        max_total_text_bytes: Option<usize>,
        #[serde(default = "default_true")]
        allow_regex: bool,
        #[serde(flatten)]
        search: WireSearchQuery,
    },
    #[serde(rename_all = "camelCase")]
    MatchPage {
        query: String,
        #[serde(default)]
        match_case: bool,
        #[serde(default)]
        whole_word: bool,
        #[serde(default)]
        use_regex: bool,
        max_matches: usize,
        #[serde(default)]
        result_offset: Option<WireResultOffset>,
    },
}

fn default_true() -> bool {
    true
}

fn encode_json(value: &impl Serialize) -> Result<Vec<u8>, NativeError> {
    serde_json::to_vec(value)
        .map_err(|error| NativeError::new(NativeErrorCode::NativeFailure, error.to_string()))
}

/// Dispatches one binary-framed WASM request (`EPSR` + version + header_len + JSON + payload).
pub fn handle_wasm_request(request: &[u8]) -> Result<Vec<u8>, NativeError> {
    if request.len() < REQUEST_PREFIX_SIZE {
        return Err(invalid_request("Truncated pdf-search WASM request"));
    }
    if &request[0..4] != REQUEST_MAGIC {
        return Err(invalid_request("Invalid pdf-search WASM request magic"));
    }
    let version = u32::from_le_bytes(request[4..8].try_into().unwrap());
    if version != REQUEST_VERSION {
        return Err(invalid_request(format!(
            "Unsupported pdf-search WASM request version: {version}"
        )));
    }
    let header_len = u32::from_le_bytes(request[8..12].try_into().unwrap()) as usize;
    let header_end = REQUEST_PREFIX_SIZE
        .checked_add(header_len)
        .filter(|&end| end <= request.len())
        .ok_or_else(|| invalid_request("Truncated pdf-search WASM request header"))?;
    let header: WasmRequestHeader =
        serde_json::from_slice(&request[REQUEST_PREFIX_SIZE..header_end]).map_err(|error| {
            invalid_request(format!("Invalid pdf-search WASM request header: {error}"))
        })?;
    let payload = &request[header_end..];

    match header {
        WasmRequestHeader::Index {
            document_revision,
            page_count,
            max_page_text_bytes,
            max_total_text_bytes,
        } => {
            let budget = TextBudget::validated(max_page_text_bytes, max_total_text_bytes)?;
            let index = read_binary_pages(payload, page_count, &document_revision, budget)?;
            let coverage_json = encode_json(&index.coverage())?;
            let index_bytes = serialize_index(&index, &document_revision)?;
            let coverage_len = u32::try_from(coverage_json.len())
                .map_err(|_| too_large("Search coverage JSON exceeds u32 length"))?;
            let mut output = Vec::with_capacity(4 + coverage_json.len() + index_bytes.len());
            output.extend_from_slice(&coverage_len.to_le_bytes());
            output.extend_from_slice(&coverage_json);
            output.extend_from_slice(&index_bytes);
            Ok(output)
        }
        WasmRequestHeader::Stat { document_revision } => {
            if document_revision.is_empty() || document_revision.len() > MAX_DOCUMENT_REVISION_BYTES
            {
                return Err(invalid_request(
                    "Search index document revision has an invalid length",
                ));
            }
            match load_index_bytes(payload, &document_revision)? {
                None => encode_json(&serde_json::json!({ "stale": true })),
                Some(index) => encode_json(&index.coverage()),
            }
        }
        WasmRequestHeader::Search {
            document_revision,
            search,
        } => {
            if document_revision.is_empty() || document_revision.len() > MAX_DOCUMENT_REVISION_BYTES
            {
                return Err(invalid_request(
                    "Search index document revision has an invalid length",
                ));
            }
            let options = search.into_options()?;
            match load_index_bytes(payload, &document_revision)? {
                None => encode_json(&serde_json::json!({ "stale": true })),
                Some(mut index) => encode_json(&search_index(&mut index, &options)?),
            }
        }
        WasmRequestHeader::SearchPages {
            document_revision,
            page_count,
            max_page_text_bytes,
            max_total_text_bytes,
            allow_regex,
            search,
        } => {
            let options = search.into_options()?;
            if !allow_regex && options.use_regex {
                return Err(invalid_request(
                    "Provisional page search does not support regex queries",
                ));
            }
            let budget = TextBudget::validated(max_page_text_bytes, max_total_text_bytes)?;
            let mut index = read_binary_pages(payload, page_count, &document_revision, budget)?;
            encode_json(&search_index(&mut index, &options)?)
        }
        WasmRequestHeader::MatchPage {
            query,
            match_case,
            whole_word,
            use_regex,
            max_matches,
            result_offset,
        } => {
            let text = std::str::from_utf8(payload)
                .map_err(|_| invalid_request("Match page payload is not valid UTF-8"))?;
            let offset = match result_offset {
                None => Some(0),
                Some(value) => value.into_option()?,
            };
            encode_json(&match_page_window(
                text,
                &query,
                match_case,
                whole_word,
                use_regex,
                max_matches,
                offset,
            )?)
        }
    }
}

#[cfg(test)]
mod tests;
