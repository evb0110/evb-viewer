//! Document text search for EVB Viewer.
//!
//! `index` reads one JSON line per page (`{"pageNumber":1,"text":"..."}`) on
//! stdin and writes the document's search index; a last line
//! `{"pageNumber":n,"overBudget":true}` says the producer stopped at page n
//! because its text is over the budget. `search` matches a query against the
//! index and `stat` reports its coverage. The index is a derived cache: a
//! missing or unreadable file, another document revision, or another format
//! answers `{"stale":true}` so the caller rebuilds it from the document.

use evb_native_support::{NativeError, NativeErrorCode};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};
use std::env;
use std::error::Error;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::OnceLock;
use unicode_normalization::{is_nfc_quick, IsNormalized, UnicodeNormalization};

const MAGIC: &[u8; 8] = b"EVBSIDX4";
/// magic, page count, pages scanned, flags, revision length, record count, reserved.
const HEADER_SIZE: usize = 32;
/// page number and UTF-8 byte length.
const RECORD_SIZE: usize = 8;
const FLAG_TRUNCATED: u32 = 1;
const MAX_INDEX_BYTES: usize = 320 * 1024 * 1024;
/// Ceilings on the text budget a caller may ask `index` to hold.
const MAX_PAGE_TEXT_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES: usize = 256 * 1024 * 1024;
const MAX_DOCUMENT_REVISION_BYTES: usize = 8_192;
const MAX_QUERY_UTF16_UNITS: usize = 2_048;
const MAX_RESULT_LIMIT: usize = 500;
const MAX_CONTEXT_CHARS: usize = 56;
const MISSING_TEXT_PAGE_SAMPLE: usize = 80;
/// Letters, numbers, marks, underscore and apostrophes join a word, as in
/// `packages/pdf-core/pdfSearchAlgorithms.ts`.
const WORD_CHARACTER_CLASS: &str = r"\p{L}\p{N}\p{M}_'’";

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
struct SearchIndex<R = Cursor<Vec<u8>>> {
    page_count: u32,
    pages_scanned: u32,
    truncated: bool,
    records: Vec<PageRecord>,
    data: R,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Coverage {
    page_count: u32,
    pages_scanned: u32,
    pages_written: u32,
    truncated: bool,
    /// The first scanned pages that carry no text, for OCR recommendations.
    missing_text_page_sample: Vec<u32>,
}

impl<R: Read + Seek> SearchIndex<R> {
    fn coverage(&self) -> Coverage {
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

    fn page_text(&mut self, record: &PageRecord) -> Result<String, NativeError> {
        self.data
            .seek(SeekFrom::Start(record.offset as u64))
            .map_err(|error| NativeError::new(NativeErrorCode::Io, error.to_string()))?;
        let mut bytes = vec![0; record.byte_len];
        self.data
            .read_exact(&mut bytes)
            .map_err(|error| NativeError::new(NativeErrorCode::Io, error.to_string()))?;
        String::from_utf8(bytes).map_err(|_| {
            NativeError::new(
                NativeErrorCode::CorruptXref,
                "Search index text is not UTF-8",
            )
        })
    }
}

/// Reads only the header and table; page bytes stay in the admitted open file.
fn parse_index<R: Read + Seek>(
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

fn load_index(
    path: &Path,
    expected_revision: &str,
) -> Result<Option<SearchIndex<BufReader<File>>>, NativeError> {
    let result = (|| {
        let file = File::open(path)?;
        let length = file.metadata()?.len();
        if length > MAX_INDEX_BYTES as u64 {
            return Ok(Err(too_large(format!(
                "Search index exceeds the {MAX_INDEX_BYTES}-byte admission ceiling"
            ))));
        }
        parse_index(BufReader::new(file), length as usize, expected_revision).map(Ok)
    })();
    match result {
        Ok(index) => index,
        Err(error) => match error.kind() {
            io::ErrorKind::NotFound | io::ErrorKind::UnexpectedEof => Ok(None),
            _ => Err(NativeError::new(
                NativeErrorCode::Io,
                format!("Search index could not be read: {error}"),
            )),
        },
    }
}

/// The text one index holds, in UTF-8 bytes: the caller's budget, within the
/// ceilings above.
#[derive(Debug, Clone, Copy)]
struct TextBudget {
    page: usize,
    total: usize,
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
    /// A page within the budget always fits a line: JSON escapes a byte into
    /// at most six (`\u001f`), and the rest is the page number and field names.
    fn max_input_line_bytes(self) -> usize {
        self.page.saturating_mul(6).saturating_add(1024)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexInputPage {
    page_number: u32,
    text: Option<String>,
    #[serde(default)]
    over_budget: bool,
}

/// Reads bounded JSON lines and builds the index in memory. Pages must arrive
/// in increasing order; a page with no text is scanned but not stored. The
/// first page over the budget, received or reported, ends what is stored; a
/// reported one is the producer's last line, so anything after it is refused.
fn read_index_input(
    input: &mut impl BufRead,
    page_count: Option<u32>,
    revision: &str,
    budget: TextBudget,
) -> Result<SearchIndex, NativeError> {
    let mut records = Vec::new();
    let mut data = Vec::new();
    let mut pages_seen = 0u32;
    let mut pages_scanned = 0u32;
    let mut truncated = false;
    let mut reported_over_budget = false;
    let mut line = Vec::new();
    let max_line_bytes = budget.max_input_line_bytes();
    loop {
        line.clear();
        let limit = u64::try_from(max_line_bytes.saturating_add(1)).unwrap_or(u64::MAX);
        let read = input
            .by_ref()
            .take(limit)
            .read_until(b'\n', &mut line)
            .map_err(|error| NativeError::new(NativeErrorCode::Io, error.to_string()))?;
        if read == 0 {
            break;
        }
        if line.len() > max_line_bytes {
            return Err(too_large(
                "Search index input line exceeds its admission ceiling",
            ));
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let page: IndexInputPage = serde_json::from_slice(&line).map_err(|error| {
            invalid_request(format!("Invalid search index input page: {error}"))
        })?;
        if reported_over_budget {
            return Err(invalid_request(format!(
                "Search index page {} follows the page reported over the budget",
                page.page_number
            )));
        }
        if page.page_number <= pages_seen || page.page_number > page_count.unwrap_or(u32::MAX) {
            return Err(invalid_request(format!(
                "Search index page {} is out of order or outside the document",
                page.page_number
            )));
        }
        pages_seen = page.page_number;
        let text = match (page.text, page.over_budget) {
            (Some(text), false) => text,
            (None, true) => {
                (truncated, reported_over_budget) = (true, true);
                continue;
            }
            _ => {
                return Err(invalid_request(format!(
                    "Search index page {} needs either text or overBudget",
                    page.page_number
                )))
            }
        };
        if truncated {
            continue;
        }
        let text_len = text.len();
        if text_len > budget.page || data.len() + text_len > budget.total {
            truncated = true;
            continue;
        }
        pages_scanned = page.page_number;
        if text_len > 0 {
            records.push(PageRecord {
                page_number: page.page_number,
                offset: data.len(),
                byte_len: text_len,
            });
            data.extend_from_slice(text.as_bytes());
        }
    }
    if revision.is_empty() || revision.len() > MAX_DOCUMENT_REVISION_BYTES {
        return Err(invalid_request(
            "Search index document revision has an invalid length",
        ));
    }
    Ok(SearchIndex {
        page_count: page_count.unwrap_or(pages_seen),
        pages_scanned,
        truncated,
        records,
        data: Cursor::new(data),
    })
}

fn write_index(index: &SearchIndex, revision: &str, out: &Path) -> Result<(), Box<dyn Error>> {
    let temporary = PathBuf::from(format!("{}.tmp-{}", out.display(), process::id()));
    let result = (|| -> Result<(), Box<dyn Error>> {
        let mut writer = BufWriter::new(File::create(&temporary)?);
        writer.write_all(MAGIC)?;
        for value in [
            index.page_count,
            index.pages_scanned,
            if index.truncated { FLAG_TRUNCATED } else { 0 },
            u32::try_from(revision.len())?,
            u32::try_from(index.records.len())?,
            0,
        ] {
            writer.write_all(&value.to_le_bytes())?;
        }
        writer.write_all(revision.as_bytes())?;
        for record in &index.records {
            writer.write_all(&record.page_number.to_le_bytes())?;
            writer.write_all(&u32::try_from(record.byte_len)?.to_le_bytes())?;
        }
        writer.write_all(index.data.get_ref())?;
        writer.into_inner().map_err(|error| error.into_error())?;
        fs::rename(&temporary, out)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

struct SearchOptions {
    query: String,
    limit: usize,
    context_chars: usize,
    result_offset: Option<usize>,
    match_case: bool,
    whole_word: bool,
    use_regex: bool,
    pages: Option<BTreeSet<u32>>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
struct SearchExcerpt {
    prefix: bool,
    suffix: bool,
    before: String,
    #[serde(rename = "match")]
    matched_text: String,
    after: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    page_number: u32,
    page_match_index: usize,
    match_index: usize,
    start_offset: usize,
    end_offset: usize,
    excerpt: SearchExcerpt,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    results: Vec<SearchMatch>,
    truncated: bool,
    page_count: u32,
    coverage: Coverage,
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
        for group in groups.find_iter(value) {
            let text = normalize_search_fragment(group.as_str());
            let normalized_start = normalized.text.len();
            normalized.text.push_str(&text);
            if text != group.as_str() {
                normalized
                    .spans
                    .push((normalized_start..normalized.text.len(), group.range()));
            }
        }
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

/// Most page text is already composed and free of ligatures, so matching can
/// run on it directly and keep its offsets.
fn needs_normalization(text: &str) -> bool {
    !text.is_ascii()
        && (is_nfc_quick(text.chars()) != IsNormalized::Yes
            || text
                .chars()
                .any(|character| fold_search_ligature(character).is_some()))
}

fn contains_unsegmented_script(value: &str) -> bool {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"[\p{Han}\p{Hiragana}\p{Katakana}\p{Hangul}]").ok())
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(value))
}

/// The query as a regex, with the same rules as the renderer's JavaScript
/// matcher: literal or regex query over normalized text, optional case
/// folding, and whole-word boundaries except for literal queries in
/// unsegmented scripts. With boundaries, group 1 is the match and the
/// characters around it only delimit it.
struct Matcher {
    regex: Regex,
    bounded: bool,
}

impl Matcher {
    fn new(options: &SearchOptions) -> Result<Self, NativeError> {
        let query = normalize_search_fragment(&options.query);
        let pattern = if options.use_regex {
            query.clone()
        } else {
            regex::escape(&query)
        };
        let bounded =
            options.whole_word && (options.use_regex || !contains_unsegmented_script(&query));
        let pattern = if bounded {
            format!(r"(?:\A|[^{WORD_CHARACTER_CLASS}])({pattern})(?:[^{WORD_CHARACTER_CLASS}]|\z)")
        } else {
            pattern
        };
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(!options.match_case)
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

fn search_index<R: Read + Seek>(
    index: &mut SearchIndex<R>,
    options: &SearchOptions,
) -> Result<SearchResponse, NativeError> {
    let matcher = Matcher::new(options)?;
    let mut results = VecDeque::new();
    let mut truncated = false;
    let mut match_count = 0;
    'pages: for record_index in 0..index.records.len() {
        let record = index.records[record_index];
        if options
            .pages
            .as_ref()
            .is_some_and(|pages| !pages.contains(&record.page_number))
        {
            continue;
        }
        let text = index.page_text(&record)?;
        let normalized = needs_normalization(&text).then(|| NormalizedText::new(&text));
        let haystack = normalized
            .as_ref()
            .map_or(text.as_str(), |value| value.text.as_str());
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
                break 'pages;
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
            results.push_back(SearchMatch {
                page_number: record.page_number,
                page_match_index,
                match_index,
                start_offset: utf16.0,
                end_offset: utf16.1,
                excerpt: build_excerpt(&text, bytes, utf16.0, options.context_chars),
            });
            if results.len() > options.limit {
                results.pop_front();
            }
        }
    }
    Ok(SearchResponse {
        results: results.into(),
        truncated,
        page_count: index.page_count,
        coverage: index.coverage(),
    })
}

fn usage() -> &'static str {
    "Usage:\n  evb-pdf-search index --out <path> --document-revision <token> [--page-count <n>] [--max-page-text-bytes <n>] [--max-total-text-bytes <n>]  (page JSON lines on stdin)\n  evb-pdf-search search --index <path> --document-revision <token> --query <text> [--match-case] [--whole-word] [--regex] [--limit <n>] [--context <n>] [--pages <n,n,...>] [--result-offset <n|-1>]\n  evb-pdf-search stat --index <path> --document-revision <token>"
}

struct CliArgs {
    values: Vec<(String, String)>,
}

impl CliArgs {
    fn parse(mut args: impl Iterator<Item = String>) -> Result<Self, NativeError> {
        let mut values = Vec::new();
        while let Some(name) = args.next() {
            if !name.starts_with("--") {
                return Err(invalid_request(format!("Unexpected argument: {name}")));
            }
            let value = if ["--match-case", "--whole-word", "--regex"].contains(&name.as_str()) {
                String::new()
            } else {
                args.next()
                    .ok_or_else(|| invalid_request(format!("Missing value for {name}")))?
            };
            values.push((name, value));
        }
        Ok(Self { values })
    }

    fn take(&mut self, name: &str) -> Option<String> {
        let index = self.values.iter().position(|(key, _)| key == name)?;
        Some(self.values.remove(index).1)
    }

    fn flag(&mut self, name: &str) -> bool {
        self.take(name).is_some()
    }

    fn required(&mut self, name: &str) -> Result<String, NativeError> {
        self.take(name)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid_request(format!("Missing required {name}")))
    }

    fn number<T: std::str::FromStr>(&mut self, name: &str, default: T) -> Result<T, NativeError> {
        match self.take(name) {
            None => Ok(default),
            Some(raw) => raw
                .parse()
                .map_err(|_| invalid_request(format!("Invalid numeric value for {name}: {raw}"))),
        }
    }

    /// A byte budget no larger than `ceiling`, which is also the default.
    fn byte_budget(&mut self, name: &str, ceiling: usize) -> Result<usize, NativeError> {
        let budget = self.number(name, ceiling)?;
        if budget == 0 || budget > ceiling {
            return Err(too_large(format!(
                "{name} must be between 1 and {ceiling} bytes"
            )));
        }
        Ok(budget)
    }

    fn finish(self) -> Result<(), NativeError> {
        match self.values.first() {
            Some((name, _)) => Err(invalid_request(format!("Unknown argument: {name}"))),
            None => Ok(()),
        }
    }
}

fn parse_pages(raw: &str) -> Result<BTreeSet<u32>, NativeError> {
    raw.split(',')
        .map(|page| match page.trim().parse::<u32>() {
            Ok(value) if value > 0 => Ok(value),
            _ => Err(invalid_request(format!(
                "Invalid page number in --pages: {page}"
            ))),
        })
        .collect()
}

fn parse_search_options(args: &mut CliArgs) -> Result<SearchOptions, NativeError> {
    let query = args.required("--query")?;
    if query.encode_utf16().count() > MAX_QUERY_UTF16_UNITS {
        return Err(too_large(format!(
            "Search query exceeds the {MAX_QUERY_UTF16_UNITS}-character admission ceiling"
        )));
    }
    let limit = args.number("--limit", MAX_RESULT_LIMIT)?;
    let context_chars = args.number("--context", 24usize)?;
    let result_offset: i64 = args.number("--result-offset", 0)?;
    if limit > MAX_RESULT_LIMIT || context_chars > MAX_CONTEXT_CHARS || result_offset < -1 {
        return Err(too_large(
            "Search limit, context or result offset exceeds its admission ceiling",
        ));
    }
    Ok(SearchOptions {
        query,
        limit,
        context_chars,
        result_offset: (result_offset >= 0).then_some(result_offset as usize),
        match_case: args.flag("--match-case"),
        whole_word: args.flag("--whole-word"),
        use_regex: args.flag("--regex"),
        pages: args
            .take("--pages")
            .as_deref()
            .map(parse_pages)
            .transpose()?,
    })
}

fn print_json(value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

fn run_cli(mut args: impl Iterator<Item = String>) -> Result<(), Box<dyn Error>> {
    let command = args
        .next()
        .ok_or_else(|| invalid_request(usage().to_string()))?;
    let mut args = CliArgs::parse(args)?;
    match command.as_str() {
        "index" => {
            let out = PathBuf::from(args.required("--out")?);
            let revision = args.required("--document-revision")?;
            let page_count = args
                .take("--page-count")
                .map(|raw| match raw.parse::<u32>() {
                    Ok(value) if value > 0 => Ok(value),
                    _ => Err(invalid_request(format!("Invalid --page-count: {raw}"))),
                })
                .transpose()?;
            let ceiling = TextBudget::default();
            let budget = TextBudget {
                page: args.byte_budget("--max-page-text-bytes", ceiling.page)?,
                total: args.byte_budget("--max-total-text-bytes", ceiling.total)?,
            };
            args.finish()?;
            let index = read_index_input(&mut io::stdin().lock(), page_count, &revision, budget)?;
            write_index(&index, &revision, &out)?;
            print_json(&index.coverage())
        }
        "search" | "stat" => {
            let index_path = PathBuf::from(args.required("--index")?);
            let revision = args.required("--document-revision")?;
            let options = if command == "search" {
                Some(parse_search_options(&mut args)?)
            } else {
                None
            };
            args.finish()?;
            match (load_index(&index_path, &revision)?, options) {
                (None, _) => print_json(&serde_json::json!({"stale": true})),
                (Some(mut index), Some(options)) => {
                    print_json(&search_index(&mut index, &options)?)
                }
                (Some(index), None) => print_json(&index.coverage()),
            }
        }
        _ => Err(Box::new(invalid_request(format!(
            "Unknown command: {command}\n{}",
            usage()
        )))),
    }
}

fn main() {
    evb_native_support::run_native_cli(
        "evb-pdf-search",
        env!("CARGO_PKG_VERSION"),
        option_env!("EVB_NATIVE_BUILD_ID"),
        env::args().skip(1),
        |args| run_cli(args.into_iter()),
    );
}

#[cfg(test)]
mod tests;
