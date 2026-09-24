//! Document text search for EVB Viewer.
//!
//! `index` reads one JSON line per page (`{"pageNumber":1,"text":"..."}`) on
//! stdin and writes the document's search index. `search` matches a query
//! against it and `stat` reports its coverage. The index is a derived cache:
//! a missing or unreadable file, another document revision, or another format
//! answers `{"stale":true}` so the caller rebuilds it from the document.

use evb_native_support::{bounded_io::read_open_file_bounded, NativeError, NativeErrorCode};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::env;
use std::error::Error;
use std::fs::{self, File};
use std::io::{self, BufRead, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::OnceLock;
use unicode_normalization::{
    char::canonical_combining_class, is_nfc_quick, IsNormalized, UnicodeNormalization,
};

const MAGIC: &[u8; 8] = b"EVBSIDX4";
/// magic, page count, pages scanned, flags, revision length, record count, reserved.
const HEADER_SIZE: usize = 32;
/// page number and UTF-8 byte length.
const RECORD_SIZE: usize = 8;
const FLAG_TRUNCATED: u32 = 1;
const MAX_INDEX_BYTES: usize = 320 * 1024 * 1024;
const MAX_PAGE_TEXT_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES: usize = 256 * 1024 * 1024;
const MAX_INPUT_LINE_BYTES: usize = 2 * MAX_PAGE_TEXT_BYTES;
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
struct SearchIndex {
    page_count: u32,
    pages_scanned: u32,
    truncated: bool,
    records: Vec<PageRecord>,
    data: Vec<u8>,
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

impl SearchIndex {
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

    fn page_text(&self, record: &PageRecord) -> Result<&str, NativeError> {
        std::str::from_utf8(&self.data[record.offset..record.offset + record.byte_len]).map_err(
            |_| {
                NativeError::new(
                    NativeErrorCode::CorruptXref,
                    "Search index text is not UTF-8",
                )
            },
        )
    }
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset.checked_add(4)?)?;
    Some(u32::from_le_bytes(slice.try_into().ok()?))
}

/// Parses an index file. `None` means the file does not describe this
/// document revision in the current format, which callers treat as stale.
fn parse_index(data: Vec<u8>, expected_revision: &str) -> Option<SearchIndex> {
    if data.get(..8) != Some(&MAGIC[..]) || read_u32(&data, 28)? != 0 {
        return None;
    }
    let page_count = read_u32(&data, 8)?;
    let pages_scanned = read_u32(&data, 12)?;
    let flags = read_u32(&data, 16)?;
    let revision_len = usize::try_from(read_u32(&data, 20)?).ok()?;
    let record_count = usize::try_from(read_u32(&data, 24)?).ok()?;
    if pages_scanned > page_count || flags & !FLAG_TRUNCATED != 0 {
        return None;
    }
    let records_offset = HEADER_SIZE.checked_add(revision_len)?;
    if data.get(HEADER_SIZE..records_offset)? != expected_revision.as_bytes() {
        return None;
    }
    let text_offset = records_offset.checked_add(record_count.checked_mul(RECORD_SIZE)?)?;
    let mut records = Vec::with_capacity(record_count);
    let mut offset = text_offset;
    let mut previous_page = 0u32;
    for index in 0..record_count {
        let record_offset = records_offset + index * RECORD_SIZE;
        let page_number = read_u32(&data, record_offset)?;
        let byte_len = usize::try_from(read_u32(&data, record_offset + 4)?).ok()?;
        if page_number <= previous_page || page_number > page_count || byte_len == 0 {
            return None;
        }
        records.push(PageRecord {
            page_number,
            offset,
            byte_len,
        });
        previous_page = page_number;
        offset = offset.checked_add(byte_len)?;
    }
    if offset != data.len() {
        return None;
    }
    Some(SearchIndex {
        page_count,
        pages_scanned,
        truncated: flags & FLAG_TRUNCATED != 0,
        records,
        data,
    })
}

fn load_index(path: &Path, expected_revision: &str) -> Result<Option<SearchIndex>, NativeError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(NativeError::new(
                NativeErrorCode::Io,
                format!("Search index could not be opened: {error}"),
            ))
        }
    };
    let data = read_open_file_bounded(file, MAX_INDEX_BYTES, "Search index")?;
    Ok(parse_index(data, expected_revision))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexInputPage {
    page_number: u32,
    text: String,
}

/// Reads bounded JSON lines and builds the index in memory. Pages must arrive
/// in increasing order; a page with no text is scanned but not stored.
fn read_index_input(
    input: &mut impl BufRead,
    page_count: Option<u32>,
    revision: &str,
) -> Result<SearchIndex, NativeError> {
    let mut records = Vec::new();
    let mut data = Vec::new();
    let mut pages_seen = 0u32;
    let mut pages_scanned = 0u32;
    let mut truncated = false;
    let mut line = Vec::new();
    loop {
        line.clear();
        let limit = u64::try_from(MAX_INPUT_LINE_BYTES + 1).unwrap_or(u64::MAX);
        let read = input
            .by_ref()
            .take(limit)
            .read_until(b'\n', &mut line)
            .map_err(|error| NativeError::new(NativeErrorCode::Io, error.to_string()))?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_INPUT_LINE_BYTES {
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
        if page.page_number <= pages_seen || page.page_number > page_count.unwrap_or(u32::MAX) {
            return Err(invalid_request(format!(
                "Search index page {} is out of order or outside the document",
                page.page_number
            )));
        }
        pages_seen = page.page_number;
        if truncated {
            continue;
        }
        let text_len = page.text.len();
        if text_len > MAX_PAGE_TEXT_BYTES || data.len() + text_len > MAX_TOTAL_TEXT_BYTES {
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
            data.extend_from_slice(page.text.as_bytes());
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
        data,
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
        writer.write_all(&index.data)?;
        writer.into_inner().map_err(|error| error.into_error())?;
        fs::rename(&temporary, out)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Debug, Clone)]
struct SearchOptions {
    query: String,
    limit: usize,
    context_chars: usize,
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
        _ => None,
    }
}

/// Canonical composition plus the presentation ligatures PDF fonts emit;
/// deliberately narrower than NFKC.
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

#[derive(Debug)]
struct NormalizedCharSpan {
    normalized_start: usize,
    normalized_end: usize,
    original_start: usize,
    original_end: usize,
}

/// Page text normalized per grapheme, with each normalized character mapped
/// back to the original bytes it came from.
#[derive(Debug)]
struct NormalizedText {
    text: String,
    spans: Vec<NormalizedCharSpan>,
}

impl NormalizedText {
    fn new(value: &str) -> Self {
        let mut normalized = Self {
            text: String::with_capacity(value.len()),
            spans: Vec::with_capacity(value.len()),
        };
        let mut group_start = 0usize;
        for (byte_offset, character) in value.char_indices() {
            if byte_offset > group_start && canonical_combining_class(character) == 0 {
                normalized.append(&value[group_start..byte_offset], group_start, byte_offset);
                group_start = byte_offset;
            }
        }
        if group_start < value.len() {
            normalized.append(&value[group_start..], group_start, value.len());
        }
        normalized
    }

    fn append(&mut self, group: &str, original_start: usize, original_end: usize) {
        for character in normalize_search_fragment(group).chars() {
            let normalized_start = self.text.len();
            self.text.push(character);
            self.spans.push(NormalizedCharSpan {
                normalized_start,
                normalized_end: self.text.len(),
                original_start,
                original_end,
            });
        }
    }

    fn original_byte_range(&self, start: usize, end: usize) -> Option<(usize, usize)> {
        let start_span = self
            .spans
            .binary_search_by_key(&start, |span| span.normalized_start)
            .ok()?;
        let end_span = self
            .spans
            .binary_search_by_key(&end, |span| span.normalized_end)
            .ok()?;
        Some((
            self.spans[start_span].original_start,
            self.spans[end_span].original_end,
        ))
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

    fn match_at(&self, text: &str, position: usize) -> Option<(usize, usize)> {
        let found = if self.bounded {
            self.regex.captures_at(text, position)?.get(1)?
        } else {
            self.regex.find_at(text, position)?
        };
        Some((found.start(), found.end()))
    }

    /// Non-empty match byte ranges in `text`. Each search resumes at the end
    /// of the previous match, so one boundary character can close a whole
    /// word and open the next.
    fn matches<'a>(&'a self, text: &'a str) -> impl Iterator<Item = (usize, usize)> + 'a {
        let mut position = 0usize;
        std::iter::from_fn(move || {
            while position <= text.len() {
                let (start, end) = self.match_at(text, position)?;
                if start == end {
                    position = next_char_boundary(text, start);
                    continue;
                }
                position = end;
                return Some((start, end));
            }
            None
        })
    }
}

fn next_char_boundary(text: &str, offset: usize) -> usize {
    text[offset..]
        .chars()
        .next()
        .map_or(text.len() + 1, |character| offset + character.len_utf8())
}

struct PageTextMap {
    byte_offsets: Vec<usize>,
    utf16_offsets: Vec<usize>,
}

impl PageTextMap {
    fn new(text: &str) -> Self {
        let mut byte_offsets = Vec::new();
        let mut utf16_offsets = Vec::new();
        let mut utf16_offset = 0usize;
        for (byte_offset, character) in text.char_indices() {
            byte_offsets.push(byte_offset);
            utf16_offsets.push(utf16_offset);
            utf16_offset += character.len_utf16();
        }
        byte_offsets.push(text.len());
        utf16_offsets.push(utf16_offset);
        Self {
            byte_offsets,
            utf16_offsets,
        }
    }

    fn utf16_offset_for_byte(&self, byte_offset: usize) -> usize {
        match self.byte_offsets.binary_search(&byte_offset) {
            Ok(index) | Err(index) => self.utf16_offsets[index.min(self.utf16_offsets.len() - 1)],
        }
    }

    fn byte_index_for_utf16_offset(&self, target_offset: usize) -> usize {
        match self.utf16_offsets.binary_search(&target_offset) {
            Ok(index) => self.byte_offsets[index],
            Err(0) => 0,
            Err(index) => self.byte_offsets[index - 1],
        }
    }

    fn utf16_len(&self) -> usize {
        self.utf16_offsets.last().copied().unwrap_or(0)
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
    text_map: &PageTextMap,
    (start_byte, end_byte): (usize, usize),
    (start_utf16, end_utf16): (usize, usize),
    context_chars: usize,
) -> SearchExcerpt {
    let text_utf16_len = text_map.utf16_len();
    let excerpt_start_utf16 = start_utf16.saturating_sub(context_chars);
    let excerpt_end_utf16 = text_utf16_len.min(end_utf16.saturating_add(context_chars));
    let excerpt_start_byte = text_map.byte_index_for_utf16_offset(excerpt_start_utf16);
    let excerpt_end_byte = text_map.byte_index_for_utf16_offset(excerpt_end_utf16);
    let before = collapse_whitespace(&text[excerpt_start_byte..start_byte]);
    let after = collapse_whitespace(&text[end_byte..excerpt_end_byte]);
    SearchExcerpt {
        prefix: excerpt_start_utf16 > 0,
        suffix: excerpt_end_utf16 < text_utf16_len,
        before: before.trim_start_matches(is_js_whitespace).to_string(),
        matched_text: text[start_byte..end_byte].to_string(),
        after: after.trim_end_matches(is_js_whitespace).to_string(),
    }
}

fn search_index(
    index: &SearchIndex,
    options: &SearchOptions,
) -> Result<SearchResponse, NativeError> {
    let matcher = Matcher::new(options)?;
    let mut results = Vec::new();
    let mut truncated = false;
    'pages: for record in &index.records {
        if options
            .pages
            .as_ref()
            .is_some_and(|pages| !pages.contains(&record.page_number))
        {
            continue;
        }
        let text = index.page_text(record)?;
        let normalized = needs_normalization(text).then(|| NormalizedText::new(text));
        let haystack = normalized
            .as_ref()
            .map_or(text, |value| value.text.as_str());
        let mut text_map: Option<PageTextMap> = None;
        for (page_match_index, (start, end)) in matcher.matches(haystack).enumerate() {
            if results.len() >= options.limit {
                truncated = true;
                break 'pages;
            }
            let bytes = match &normalized {
                Some(value) => value.original_byte_range(start, end).ok_or_else(|| {
                    NativeError::new(
                        NativeErrorCode::NativeFailure,
                        "Normalized search match offset is invalid",
                    )
                })?,
                None => (start, end),
            };
            let text_map = text_map.get_or_insert_with(|| PageTextMap::new(text));
            let utf16 = (
                text_map.utf16_offset_for_byte(bytes.0),
                text_map.utf16_offset_for_byte(bytes.1),
            );
            results.push(SearchMatch {
                page_number: record.page_number,
                page_match_index,
                match_index: results.len(),
                start_offset: utf16.0,
                end_offset: utf16.1,
                excerpt: build_excerpt(text, text_map, bytes, utf16, options.context_chars),
            });
        }
    }
    Ok(SearchResponse {
        results,
        truncated,
        page_count: index.page_count,
        coverage: index.coverage(),
    })
}

fn usage() -> &'static str {
    "Usage:\n  evb-pdf-search index --out <path> --document-revision <token> [--page-count <n>]  (page JSON lines on stdin)\n  evb-pdf-search search --index <path> --document-revision <token> --query <text> [--match-case] [--whole-word] [--regex] [--limit <n>] [--context <n>] [--pages <n,n,...>]\n  evb-pdf-search stat --index <path> --document-revision <token>"
}

struct CliArgs {
    values: Vec<(String, Option<String>)>,
}

impl CliArgs {
    const FLAGS: [&'static str; 3] = ["--match-case", "--whole-word", "--regex"];

    fn parse(mut args: impl Iterator<Item = String>) -> Result<Self, NativeError> {
        let mut values = Vec::new();
        while let Some(name) = args.next() {
            if !name.starts_with("--") {
                return Err(invalid_request(format!("Unexpected argument: {name}")));
            }
            let value = if Self::FLAGS.contains(&name.as_str()) {
                None
            } else {
                Some(
                    args.next()
                        .ok_or_else(|| invalid_request(format!("Missing value for {name}")))?,
                )
            };
            values.push((name, value));
        }
        Ok(Self { values })
    }

    fn take(&mut self, name: &str) -> Option<String> {
        let index = self.values.iter().position(|(key, _)| key == name)?;
        self.values.remove(index).1
    }

    fn flag(&mut self, name: &str) -> bool {
        let index = self.values.iter().position(|(key, _)| key == name);
        index.map(|index| self.values.remove(index)).is_some()
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
    if limit > MAX_RESULT_LIMIT || context_chars > MAX_CONTEXT_CHARS {
        return Err(too_large(
            "Search limit or context exceeds its admission ceiling",
        ));
    }
    Ok(SearchOptions {
        query,
        limit,
        context_chars,
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

#[derive(Serialize)]
struct StaleResponse {
    stale: bool,
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
            args.finish()?;
            let index = read_index_input(&mut io::stdin().lock(), page_count, &revision)?;
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
                (None, _) => print_json(&StaleResponse { stale: true }),
                (Some(index), Some(options)) => print_json(&search_index(&index, &options)?),
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
