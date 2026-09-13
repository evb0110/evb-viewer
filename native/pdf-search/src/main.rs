use evb_native_support::{
    bounded_io::read_open_file_bounded, generated_native_tool_protocols::PDF_SEARCH, NativeError,
    NativeErrorCode, NativeErrorEnvelope,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::error::Error;
#[cfg(test)]
use std::fs;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
#[cfg(test)]
use std::process;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use unicode_casefold::{Locale, UnicodeCaseFold, Variant};
use unicode_normalization::{char::canonical_combining_class, UnicodeNormalization};

const MAGIC: &[u8; 8] = b"EVBSIDX2";
const SCHEMA_VERSION: u32 = 2;
const HEADER_SIZE: usize = 64;
const PAGE_RECORD_SIZE: usize = 24;
const STREAMING_MAGIC: &[u8; 8] = b"EVBSIDX3";
const STREAMING_SCHEMA_VERSION: u32 = 3;
const STREAMING_HEADER_SIZE: usize = 64;
const STREAMING_FOOTER_MAGIC: &[u8; 8] = b"EVBSFTR3";
const STREAMING_FOOTER_SIZE: usize = 64;
const STREAMING_DIRECTORY_ENTRY_SIZE: usize = 24;
const STREAMING_FLAG_COMPLETE: u32 = 1;
const STREAMING_FLAG_PARTIAL_COVERAGE: u32 = 1 << 1;
const STREAMING_FLAG_TRUNCATED_COVERAGE: u32 = 1 << 2;
const STREAMING_KNOWN_FLAGS: u32 =
    STREAMING_FLAG_COMPLETE | STREAMING_FLAG_PARTIAL_COVERAGE | STREAMING_FLAG_TRUNCATED_COVERAGE;
const MAX_SERVICE_WORKERS: usize = 4;
const MAX_SERVICE_CACHED_INDEXES: usize = 8;
const MAX_SERVICE_CACHED_INDEX_BYTES: usize = 512 * 1024 * 1024;
const MAX_SERVICE_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_SEARCH_REQUEST_ID_CHARS: usize = 128;
const MAX_SEARCH_INDEX_PATH_CHARS: usize = 4_096;
const MAX_SEARCH_QUERY_CHARS: usize = 2_048;
const MAX_SEARCH_DOCUMENT_REVISION_CHARS: usize = 8_192;
const MAX_SEARCH_RESULT_LIMIT: usize = 500;
const MAX_SEARCH_CONTEXT_CHARS: usize = 56;
const MAX_SEARCH_INDEX_BYTES: usize = 320 * 1024 * 1024;
const MAX_SEARCH_INDEX_PAGE_RECORDS: usize = 1_000_000;
const MAX_SEARCH_INDEX_PAGE_TEXT_BYTES: usize = 32 * 1024 * 1024;
const MAX_SEARCH_INDEX_TOTAL_TEXT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Copy)]
struct SearchIndexLimits {
    max_index_bytes: usize,
    max_page_records: usize,
    max_page_text_bytes: usize,
    max_total_text_bytes: usize,
}

const SEARCH_INDEX_LIMITS: SearchIndexLimits = SearchIndexLimits {
    max_index_bytes: MAX_SEARCH_INDEX_BYTES,
    max_page_records: MAX_SEARCH_INDEX_PAGE_RECORDS,
    max_page_text_bytes: MAX_SEARCH_INDEX_PAGE_TEXT_BYTES,
    max_total_text_bytes: MAX_SEARCH_INDEX_TOTAL_TEXT_BYTES,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEnvelope {
    code: NativeErrorCode,
    message: String,
}

fn invalid_request(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message)
}

fn corrupt_index(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::CorruptXref, message)
}

fn too_large(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::TooLarge, message)
}

fn native_failure(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::NativeFailure, message)
}

#[derive(Debug, Clone, Copy)]
struct PageRecord {
    page_number: u32,
    offset: usize,
    byte_len: usize,
}

#[derive(Debug, Clone, Copy)]
struct StreamingDirectory {
    directory_offset: usize,
    text_data_offset: usize,
    footer_offset: usize,
    pages_written: u32,
    bytes_written: u64,
    pages_scanned: u32,
    flags: u32,
}

#[derive(Debug)]
enum SearchIndexRecords {
    Legacy(Vec<PageRecord>),
    Streaming(StreamingDirectory),
}

#[derive(Debug)]
struct SearchIndex {
    page_count: u32,
    records: SearchIndexRecords,
    data: SearchIndexData,
}

#[derive(Debug)]
enum SearchIndexData {
    Owned(Vec<u8>),
}

impl AsRef<[u8]> for SearchIndexData {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Owned(data) => data,
        }
    }
}

#[derive(Debug, Clone)]
struct SearchOptions {
    index_path: PathBuf,
    query: String,
    limit: usize,
    context_chars: usize,
    match_case: bool,
    page_count: Option<u32>,
    document_revision: String,
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
struct SearchMatch {
    #[serde(rename = "pageNumber")]
    page_number: u32,
    #[serde(rename = "pageMatchIndex")]
    page_match_index: usize,
    #[serde(rename = "matchIndex")]
    match_index: usize,
    #[serde(rename = "startOffset")]
    start_offset: usize,
    #[serde(rename = "endOffset")]
    end_offset: usize,
    excerpt: SearchExcerpt,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
struct SearchResponse {
    results: Vec<SearchMatch>,
    truncated: bool,
    #[serde(rename = "pageCount")]
    page_count: u32,
}

fn usage() -> &'static str {
    "Usage: evb-pdf-search search --index <path> --query <text> --document-revision <token> [--limit <n>] [--context <n>] [--match-case] [--page-count <n>]"
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32, NativeError> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| too_large("Native search index offset overflow".to_string()))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| corrupt_index("Native search index ended unexpectedly".to_string()))?;
    let array: [u8; 4] = slice
        .try_into()
        .map_err(|_| native_failure("Invalid native search index u32 field".to_string()))?;
    Ok(u32::from_le_bytes(array))
}

fn read_u64_le(bytes: &[u8], offset: usize) -> Result<u64, NativeError> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| too_large("Native search index offset overflow".to_string()))?;
    let slice = bytes
        .get(offset..end)
        .ok_or_else(|| corrupt_index("Native search index ended unexpectedly".to_string()))?;
    let array: [u8; 8] = slice
        .try_into()
        .map_err(|_| native_failure("Invalid native search index u64 field".to_string()))?;
    Ok(u64::from_le_bytes(array))
}

fn usize_from_u64(value: u64, label: &str) -> Result<usize, NativeError> {
    usize::try_from(value).map_err(|_| {
        native_failure(format!(
            "Native search index {label} does not fit this platform"
        ))
    })
}

fn load_index(path: &PathBuf, expected_revision: &str) -> Result<SearchIndex, Box<dyn Error>> {
    let mut file = File::open(path)?;
    let file_len = usize::try_from(file.metadata()?.len())
        .map_err(|_| too_large("Native search index is too large"))?;
    let mut magic = [0u8; 8];
    file.read_exact(&mut magic)?;
    if file_len > SEARCH_INDEX_LIMITS.max_index_bytes && magic != *STREAMING_MAGIC {
        return Err(Box::new(too_large(format!(
            "Native search index exceeds the {}-byte admission ceiling",
            SEARCH_INDEX_LIMITS.max_index_bytes
        ))));
    }
    file.seek(SeekFrom::Start(0))?;
    let bytes = read_open_file_bounded(file, file_len, "Native search index")
        .map_err(|error| Box::new(error) as Box<dyn Error>)?;
    load_index_data(SearchIndexData::Owned(bytes), expected_revision)
}

fn load_index_data(
    data: SearchIndexData,
    expected_revision: &str,
) -> Result<SearchIndex, Box<dyn Error>> {
    load_index_data_with_limits(data, expected_revision, SEARCH_INDEX_LIMITS)
}

fn load_index_data_with_limits(
    data: SearchIndexData,
    expected_revision: &str,
    limits: SearchIndexLimits,
) -> Result<SearchIndex, Box<dyn Error>> {
    let bytes = data.as_ref();
    let is_streaming = bytes.get(0..8) == Some(&STREAMING_MAGIC[..]);
    if !is_streaming && bytes.len() > limits.max_index_bytes {
        return Err(Box::new(too_large(format!(
            "Native search index exceeds the {}-byte admission ceiling",
            limits.max_index_bytes
        ))));
    }
    if bytes.len() < HEADER_SIZE {
        return Err(Box::new(native_failure(
            "Native search index is too small".to_string(),
        )));
    }
    if is_streaming {
        return load_streaming_index_data(data, expected_revision, limits);
    }
    if bytes.get(0..8) != Some(&MAGIC[..]) {
        return Err(Box::new(native_failure(
            "Native search index magic mismatch".to_string(),
        )));
    }

    load_legacy_index_data(data, expected_revision, limits)
}

fn load_legacy_index_data(
    data: SearchIndexData,
    expected_revision: &str,
    limits: SearchIndexLimits,
) -> Result<SearchIndex, Box<dyn Error>> {
    let bytes = data.as_ref();

    let schema_version = read_u32_le(bytes, 8)?;
    if schema_version != SCHEMA_VERSION {
        return Err(Box::new(native_failure(format!(
            "Unsupported native search index schema version {schema_version}",
        ))));
    }

    let header_size = usize::try_from(read_u32_le(bytes, 12)?)
        .map_err(|_| too_large("Native search index header size is too large".to_string()))?;
    if header_size != HEADER_SIZE {
        return Err(Box::new(native_failure(
            "Native search index header size mismatch".to_string(),
        )));
    }

    let page_count = read_u32_le(bytes, 16)?;
    let page_record_count = read_u32_le(bytes, 20)?;
    let revision_token_byte_length = usize::try_from(read_u32_le(bytes, 28)?)
        .map_err(|_| too_large("Native search index revision token is too large".to_string()))?;
    let revision_token_byte_offset =
        usize_from_u64(read_u64_le(bytes, 32)?, "revision token byte offset")?;
    let page_table_offset = usize_from_u64(read_u64_le(bytes, 40)?, "page table offset")?;
    let text_data_offset = usize_from_u64(read_u64_le(bytes, 48)?, "text data offset")?;
    let revision_token_end = revision_token_byte_offset
        .checked_add(revision_token_byte_length)
        .ok_or_else(|| {
            too_large("Native search index revision token offset overflow".to_string())
        })?;
    if revision_token_byte_length == 0
        || revision_token_byte_offset < HEADER_SIZE
        || revision_token_end > page_table_offset
    {
        return Err(Box::new(native_failure(
            "Native search index revision token is invalid".to_string(),
        )));
    }
    let revision_token = std::str::from_utf8(
        bytes
            .get(revision_token_byte_offset..revision_token_end)
            .ok_or_else(|| {
                corrupt_index("Native search index revision token is truncated".to_string())
            })?,
    )?;
    if revision_token != expected_revision {
        return Err(Box::new(native_failure(
            "Native search index document revision mismatch".to_string(),
        )));
    }

    let page_record_count_usize = usize::try_from(page_record_count)
        .map_err(|_| too_large("Native search index page count is too large".to_string()))?;
    if page_record_count_usize > limits.max_page_records {
        return Err(Box::new(too_large(format!(
            "Native search index exceeds the {}-record admission ceiling",
            limits.max_page_records
        ))));
    }
    let table_size = page_record_count_usize
        .checked_mul(PAGE_RECORD_SIZE)
        .ok_or_else(|| too_large("Native search index table is too large".to_string()))?;
    let minimum_size = page_table_offset
        .checked_add(table_size)
        .ok_or_else(|| too_large("Native search index table offset overflow".to_string()))?;
    if text_data_offset < minimum_size || bytes.len() < text_data_offset {
        return Err(Box::new(native_failure(
            "Native search index page table is truncated".to_string(),
        )));
    }
    let total_text_bytes = bytes.len() - text_data_offset;
    if total_text_bytes > limits.max_total_text_bytes {
        return Err(Box::new(too_large(format!(
            "Native search index text exceeds the {}-byte aggregate admission ceiling",
            limits.max_total_text_bytes
        ))));
    }

    let mut records = Vec::with_capacity(page_record_count_usize);
    for record_index in 0..page_record_count_usize {
        let record_offset = page_table_offset + record_index * PAGE_RECORD_SIZE;
        let page_number = read_u32_le(bytes, record_offset)?;
        let byte_offset = usize_from_u64(read_u64_le(bytes, record_offset + 8)?, "byte offset")?;
        let byte_len = usize_from_u64(read_u64_le(bytes, record_offset + 16)?, "byte length")?;
        if byte_len > limits.max_page_text_bytes {
            return Err(Box::new(too_large(format!(
                "Native search index page text exceeds the {}-byte admission ceiling",
                limits.max_page_text_bytes
            ))));
        }
        let byte_end = byte_offset.checked_add(byte_len).ok_or_else(|| {
            too_large("Native search index page text offset overflow".to_string())
        })?;
        if byte_offset < text_data_offset || byte_end > bytes.len() {
            return Err(Box::new(native_failure(
                "Native search index page text is truncated".to_string(),
            )));
        }
        records.push(PageRecord {
            page_number,
            offset: byte_offset,
            byte_len,
        });
    }

    Ok(SearchIndex {
        page_count,
        records: SearchIndexRecords::Legacy(records),
        data,
    })
}

fn load_streaming_index_data(
    data: SearchIndexData,
    expected_revision: &str,
    _limits: SearchIndexLimits,
) -> Result<SearchIndex, Box<dyn Error>> {
    let bytes = data.as_ref();
    let schema_version = read_u32_le(bytes, 8)?;
    if schema_version != STREAMING_SCHEMA_VERSION {
        return Err(Box::new(native_failure(format!(
            "Unsupported native streaming search index schema version {schema_version}",
        ))));
    }

    let header_size = usize::try_from(read_u32_le(bytes, 12)?)
        .map_err(|_| too_large("Native streaming search index header size is too large"))?;
    if header_size != STREAMING_HEADER_SIZE {
        return Err(Box::new(native_failure(
            "Native streaming search index header size mismatch".to_string(),
        )));
    }

    let page_count = read_u32_le(bytes, 16)?;
    if page_count == 0 {
        return Err(Box::new(native_failure(
            "Native streaming search index page count must be positive".to_string(),
        )));
    }
    let header_pages_written = read_u32_le(bytes, 20)?;
    if header_pages_written > page_count {
        return Err(Box::new(native_failure(
            "Native streaming search index pagesWritten exceeds page count".to_string(),
        )));
    }
    let flags = read_u32_le(bytes, 24)?;
    if flags & !STREAMING_KNOWN_FLAGS != 0 {
        return Err(Box::new(native_failure(
            "Native streaming search index contains unknown coverage flags".to_string(),
        )));
    }
    if flags & STREAMING_FLAG_COMPLETE == 0 {
        return Err(Box::new(native_failure(
            "Native streaming search index is incomplete".to_string(),
        )));
    }

    let revision_token_byte_length = usize::try_from(read_u32_le(bytes, 28)?)
        .map_err(|_| too_large("Native streaming search index revision token is too large"))?;
    if revision_token_byte_length == 0
        || revision_token_byte_length > MAX_SEARCH_DOCUMENT_REVISION_CHARS
    {
        return Err(Box::new(too_large(format!(
            "Native streaming search index revision token exceeds the {MAX_SEARCH_DOCUMENT_REVISION_CHARS}-byte admission ceiling"
        ))));
    }

    let revision_token_byte_offset = read_u64_le(bytes, 32)?;
    let directory_offset = read_u64_le(bytes, 40)?;
    let text_data_offset = read_u64_le(bytes, 48)?;
    let footer_offset = read_u64_le(bytes, 56)?;
    let directory_length = u64::from(page_count)
        .checked_mul(STREAMING_DIRECTORY_ENTRY_SIZE as u64)
        .ok_or_else(|| too_large("Native streaming search index directory length overflow"))?;
    let directory_end = directory_offset
        .checked_add(directory_length)
        .ok_or_else(|| too_large("Native streaming search index directory offset overflow"))?;
    let revision_token_end = revision_token_byte_offset
        .checked_add(revision_token_byte_length as u64)
        .ok_or_else(|| too_large("Native streaming search index revision offset overflow"))?;
    let footer_end = footer_offset
        .checked_add(STREAMING_FOOTER_SIZE as u64)
        .ok_or_else(|| too_large("Native streaming search index footer offset overflow"))?;
    let file_len = u64::try_from(bytes.len())
        .map_err(|_| too_large("Native streaming search index is too large"))?;

    let valid_layout = revision_token_byte_offset >= STREAMING_HEADER_SIZE as u64
        && revision_token_end <= directory_offset
        && text_data_offset == directory_end
        && footer_offset >= text_data_offset
        && footer_end == file_len
        && footer_offset != 0;
    if !valid_layout {
        return Err(Box::new(native_failure(
            "Native streaming search index layout is invalid".to_string(),
        )));
    }
    if directory_end > file_len {
        return Err(Box::new(native_failure(
            "Native streaming search index directory is truncated".to_string(),
        )));
    }

    let revision_token_offset = usize_from_u64(
        revision_token_byte_offset,
        "streaming revision token byte offset",
    )?;
    let revision_token_end_usize =
        usize_from_u64(revision_token_end, "streaming revision token end")?;
    let directory_offset_usize = usize_from_u64(directory_offset, "streaming directory offset")?;
    let text_data_offset_usize = usize_from_u64(text_data_offset, "streaming text data offset")?;
    let footer_offset_usize = usize_from_u64(footer_offset, "streaming footer offset")?;
    let revision_token = std::str::from_utf8(
        bytes
            .get(revision_token_offset..revision_token_end_usize)
            .ok_or_else(|| {
                corrupt_index("Native streaming search index revision token is truncated")
            })?,
    )
    .map_err(|_| native_failure("Native streaming search index revision token is not UTF-8"))?;
    if revision_token != expected_revision {
        return Err(Box::new(native_failure(
            "Native search index document revision mismatch".to_string(),
        )));
    }

    let footer_flags = read_u32_le(bytes, footer_offset_usize + 16)?;
    let footer_pages_written = read_u32_le(bytes, footer_offset_usize + 24)?;
    let footer_bytes_written = read_u64_le(bytes, footer_offset_usize + 32)?;
    let footer_file_length = read_u64_le(bytes, footer_offset_usize + 40)?;
    let footer_directory_length = read_u64_le(bytes, footer_offset_usize + 48)?;
    if bytes.get(footer_offset_usize..footer_offset_usize + 8) != Some(&STREAMING_FOOTER_MAGIC[..])
        || read_u32_le(bytes, footer_offset_usize + 8)? != STREAMING_SCHEMA_VERSION
        || read_u32_le(bytes, footer_offset_usize + 12)? != STREAMING_FOOTER_SIZE as u32
        || footer_flags != flags
        || footer_pages_written != header_pages_written
        || footer_file_length != file_len
        || footer_directory_length != directory_length
    {
        return Err(Box::new(native_failure(
            "Native streaming search index completion footer is invalid".to_string(),
        )));
    }

    if read_u32_le(bytes, footer_offset_usize + 28)? != 0 {
        return Err(Box::new(native_failure(
            "Native streaming search index footer reserved field is nonzero".to_string(),
        )));
    }
    let pages_scanned = u32::try_from(read_u64_le(bytes, footer_offset_usize + 56)?)
        .map_err(|_| native_failure("Native streaming search index pagesScanned is too large"))?;
    if pages_scanned > page_count {
        return Err(Box::new(native_failure(
            "Native streaming search index pagesScanned exceeds page count".to_string(),
        )));
    }
    if pages_scanned < page_count && flags & STREAMING_FLAG_PARTIAL_COVERAGE == 0 {
        return Err(Box::new(native_failure(
            "Native streaming search index pagesScanned requires partial coverage".to_string(),
        )));
    }

    let mut counted_pages_written = 0u32;
    let mut counted_bytes_written = 0u64;
    for page_index in 0..page_count {
        let record_offset_u64 = directory_offset
            .checked_add(
                u64::from(page_index)
                    .checked_mul(STREAMING_DIRECTORY_ENTRY_SIZE as u64)
                    .ok_or_else(|| {
                        too_large("Native streaming search index directory entry overflow")
                    })?,
            )
            .ok_or_else(|| too_large("Native streaming search index directory entry overflow"))?;
        let record_offset = usize_from_u64(record_offset_u64, "streaming directory entry offset")?;
        let byte_offset = read_u64_le(bytes, record_offset)?;
        let byte_length = read_u64_le(bytes, record_offset + 8)?;
        let text_utf16_length = read_u32_le(bytes, record_offset + 16)?;
        let entry_marker = read_u32_le(bytes, record_offset + 20)?;
        if entry_marker > 1 {
            return Err(Box::new(native_failure(
                "Native streaming search index directory entry marker is invalid".to_string(),
            )));
        }
        if entry_marker == 0 {
            if byte_offset != 0 || byte_length != 0 || text_utf16_length != 0 {
                return Err(Box::new(native_failure(
                    "Native streaming search index empty directory entry is invalid".to_string(),
                )));
            }
            continue;
        }

        if byte_length == 0 {
            if byte_offset != 0 || text_utf16_length != 0 {
                return Err(Box::new(native_failure(
                    "Native streaming search index empty page record is invalid".to_string(),
                )));
            }
            continue;
        }

        let byte_end = byte_offset
            .checked_add(byte_length)
            .ok_or_else(|| too_large("Native streaming search index page text offset overflow"))?;
        if byte_offset < text_data_offset || byte_end > footer_offset {
            return Err(Box::new(native_failure(
                "Native streaming search index page text is outside the text data range"
                    .to_string(),
            )));
        }
        let byte_offset_usize = usize_from_u64(byte_offset, "streaming page text offset")?;
        let byte_end_usize = usize_from_u64(byte_end, "streaming page text end")?;
        let text = std::str::from_utf8(bytes.get(byte_offset_usize..byte_end_usize).ok_or_else(
            || corrupt_index("Native streaming search index page text is truncated"),
        )?)
        .map_err(|_| native_failure("Native streaming search index page text is not UTF-8"))?;
        if text.encode_utf16().count() != text_utf16_length as usize {
            return Err(Box::new(native_failure(
                "Native streaming search index UTF-16 text length mismatch".to_string(),
            )));
        }
        counted_pages_written = counted_pages_written
            .checked_add(1)
            .ok_or_else(|| too_large("Native streaming search index pagesWritten overflow"))?;
        counted_bytes_written = counted_bytes_written
            .checked_add(byte_length)
            .ok_or_else(|| too_large("Native streaming search index bytesWritten overflow"))?;
    }

    let text_range_length = footer_offset
        .checked_sub(text_data_offset)
        .ok_or_else(|| native_failure("Native streaming search index text range is invalid"))?;
    if counted_pages_written != header_pages_written
        || counted_bytes_written != footer_bytes_written
        || counted_bytes_written != text_range_length
    {
        return Err(Box::new(native_failure(
            "Native streaming search index coverage counts are inconsistent".to_string(),
        )));
    }

    Ok(SearchIndex {
        page_count,
        records: SearchIndexRecords::Streaming(StreamingDirectory {
            directory_offset: directory_offset_usize,
            text_data_offset: text_data_offset_usize,
            footer_offset: footer_offset_usize,
            pages_written: header_pages_written,
            bytes_written: footer_bytes_written,
            pages_scanned,
            flags,
        }),
        data,
    })
}

impl SearchIndex {
    fn cache_weight_bytes(&self) -> usize {
        let record_weight = match &self.records {
            SearchIndexRecords::Legacy(records) => records
                .len()
                .saturating_mul(std::mem::size_of::<PageRecord>()),
            SearchIndexRecords::Streaming(directory) => {
                debug_assert!(directory.text_data_offset <= directory.footer_offset);
                debug_assert!(directory.pages_written <= self.page_count);
                debug_assert!(directory.pages_scanned <= self.page_count);
                debug_assert!(directory.flags & STREAMING_FLAG_COMPLETE != 0);
                debug_assert!(directory.bytes_written <= self.data.as_ref().len() as u64);
                std::mem::size_of_val(directory)
            }
        };
        self.data.as_ref().len().saturating_add(record_weight)
    }

    fn records(&self) -> SearchIndexRecordIter<'_> {
        SearchIndexRecordIter {
            records: &self.records,
            data: &self.data,
            page_count: self.page_count,
            next_page: 0,
            emitted_pages: 0,
        }
    }

    fn page_text(&self, record: &PageRecord) -> Result<&str, Box<dyn Error>> {
        let end = record.offset.checked_add(record.byte_len).ok_or_else(|| {
            too_large("Native search index page text offset overflow".to_string())
        })?;
        Ok(std::str::from_utf8(
            &self.data.as_ref()[record.offset..end],
        )?)
    }
}

struct SearchIndexRecordIter<'a> {
    records: &'a SearchIndexRecords,
    data: &'a SearchIndexData,
    page_count: u32,
    next_page: u32,
    emitted_pages: u32,
}

impl Iterator for SearchIndexRecordIter<'_> {
    type Item = Result<PageRecord, Box<dyn Error>>;

    fn next(&mut self) -> Option<Self::Item> {
        match self.records {
            SearchIndexRecords::Legacy(records) => {
                let record = records.get(self.next_page as usize).copied();
                self.next_page = self.next_page.saturating_add(1);
                record.map(Ok)
            }
            SearchIndexRecords::Streaming(directory) => loop {
                if self.next_page >= self.page_count
                    || self.emitted_pages >= directory.pages_written
                {
                    return None;
                }
                let page_number = self.next_page + 1;
                self.next_page += 1;
                let entry_offset =
                    match (page_number as usize - 1).checked_mul(STREAMING_DIRECTORY_ENTRY_SIZE) {
                        Some(offset) => offset,
                        None => {
                            return Some(Err(Box::new(too_large(
                                "Native streaming search index directory entry overflow",
                            ))))
                        }
                    };
                let record_offset = match directory.directory_offset.checked_add(entry_offset) {
                    Some(offset) => offset,
                    None => {
                        return Some(Err(Box::new(too_large(
                            "Native streaming search index directory entry overflow",
                        ))))
                    }
                };
                let bytes = self.data.as_ref();
                let byte_offset = match read_u64_le(bytes, record_offset) {
                    Ok(value) => value,
                    Err(error) => return Some(Err(Box::new(error))),
                };
                let byte_len = match read_u64_le(bytes, record_offset + 8) {
                    Ok(value) => value,
                    Err(error) => return Some(Err(Box::new(error))),
                };
                let marker = match read_u32_le(bytes, record_offset + 20) {
                    Ok(value) => value,
                    Err(error) => return Some(Err(Box::new(error))),
                };
                if marker == 0 || byte_len == 0 {
                    continue;
                }
                if marker > 1 {
                    return Some(Err(Box::new(native_failure(
                        "Native streaming search index directory entry marker is invalid",
                    ))));
                }
                let offset = match usize_from_u64(byte_offset, "streaming page text offset") {
                    Ok(value) => value,
                    Err(error) => return Some(Err(Box::new(error))),
                };
                let byte_len = match usize_from_u64(byte_len, "streaming page text length") {
                    Ok(value) => value,
                    Err(error) => return Some(Err(Box::new(error))),
                };
                self.emitted_pages = self.emitted_pages.saturating_add(1);
                return Some(Ok(PageRecord {
                    page_number,
                    offset,
                    byte_len,
                }));
            },
        }
    }
}

fn parse_usize(value: Option<String>, label: &str) -> Result<usize, Box<dyn Error>> {
    let raw = value.ok_or_else(|| invalid_request(format!("Missing value for {label}")))?;
    let parsed = raw
        .parse::<usize>()
        .map_err(|_| invalid_request(format!("Invalid numeric value for {label}: {raw}")))?;
    Ok(parsed)
}

fn parse_u32(value: Option<String>, label: &str) -> Result<u32, Box<dyn Error>> {
    let raw = value.ok_or_else(|| invalid_request(format!("Missing value for {label}")))?;
    let parsed = raw
        .parse::<u32>()
        .map_err(|_| invalid_request(format!("Invalid numeric value for {label}: {raw}")))?;
    Ok(parsed)
}

fn parse_search_options(
    mut args: impl Iterator<Item = String>,
) -> Result<SearchOptions, Box<dyn Error>> {
    let mut index_path: Option<PathBuf> = None;
    let mut query: Option<String> = None;
    let mut limit = 500usize;
    let mut context_chars = 32usize;
    let mut match_case = false;
    let mut page_count: Option<u32> = None;
    let mut document_revision: Option<String> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--index" => {
                index_path = Some(PathBuf::from(args.next().ok_or_else(|| {
                    invalid_request("Missing value for --index".to_string())
                })?));
            }
            "--query" => {
                query = Some(
                    args.next()
                        .ok_or_else(|| invalid_request("Missing value for --query".to_string()))?,
                );
            }
            "--limit" => {
                limit = parse_usize(args.next(), "--limit")?;
            }
            "--context" => {
                context_chars = parse_usize(args.next(), "--context")?;
            }
            "--match-case" => {
                match_case = true;
            }
            "--page-count" => {
                page_count = Some(parse_u32(args.next(), "--page-count")?);
            }
            "--document-revision" => {
                document_revision = Some(args.next().ok_or_else(|| {
                    invalid_request("Missing value for --document-revision".to_string())
                })?);
            }
            "--help" | "-h" => {
                return Err(Box::new(invalid_request(usage().to_string())));
            }
            _ => {
                return Err(Box::new(invalid_request(format!(
                    "Unknown search argument: {arg}"
                ))));
            }
        }
    }

    let query = query.ok_or_else(|| invalid_request("Missing required --query".to_string()))?;
    if query.is_empty() {
        return Err(Box::new(invalid_request(
            "Search query must not be empty".to_string(),
        )));
    }

    Ok(SearchOptions {
        index_path: index_path
            .ok_or_else(|| invalid_request("Missing required --index".to_string()))?,
        query,
        limit,
        context_chars,
        match_case,
        page_count,
        document_revision: document_revision
            .filter(|revision| !revision.is_empty())
            .ok_or_else(|| invalid_request("Missing required --document-revision".to_string()))?,
    })
}

fn ascii_bytes_equal_ignore_case(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(left_byte, right_byte)| left_byte.eq_ignore_ascii_case(right_byte))
}

#[derive(Debug, PartialEq, Eq)]
struct FoldedCharSpan {
    folded_start: usize,
    folded_end: usize,
    original_start: usize,
    original_end: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct FoldedText {
    text: String,
    spans: Vec<FoldedCharSpan>,
}

fn simple_case_fold(value: &str) -> String {
    value
        .case_fold_with(Variant::Simple, Locale::NonTurkic)
        .collect()
}

#[derive(Debug)]
struct NormalizedCharSpan {
    normalized_start: usize,
    normalized_end: usize,
    original_start: usize,
    original_end: usize,
}

#[derive(Debug)]
struct NormalizedText {
    text: String,
    spans: Vec<NormalizedCharSpan>,
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

fn normalize_search_fragment(value: &str) -> String {
    let mut folded = String::with_capacity(value.len());
    for character in value.chars() {
        if let Some(replacement) = fold_search_ligature(character) {
            folded.push_str(replacement);
        } else {
            folded.push(character);
        }
    }
    folded.nfc().collect()
}

impl NormalizedText {
    fn new(value: &str) -> Self {
        let mut text = String::with_capacity(value.len());
        let mut spans = Vec::with_capacity(value.chars().count());
        let mut group_start = 0usize;
        let mut group = String::new();

        let append_group = |group: &str,
                            original_start: usize,
                            original_end: usize,
                            text: &mut String,
                            spans: &mut Vec<NormalizedCharSpan>| {
            let normalized = normalize_search_fragment(group);
            for character in normalized.chars() {
                let normalized_start = text.len();
                text.push(character);
                spans.push(NormalizedCharSpan {
                    normalized_start,
                    normalized_end: text.len(),
                    original_start,
                    original_end,
                });
            }
        };

        for (byte_offset, character) in value.char_indices() {
            if !group.is_empty() && canonical_combining_class(character) == 0 {
                append_group(&group, group_start, byte_offset, &mut text, &mut spans);
                group.clear();
                group_start = byte_offset;
            } else if group.is_empty() {
                group_start = byte_offset;
            }
            group.push(character);
        }
        if !group.is_empty() {
            append_group(&group, group_start, value.len(), &mut text, &mut spans);
        }

        Self { text, spans }
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

fn fold_text_with_spans(value: &str) -> FoldedText {
    let mut text = String::with_capacity(value.len());
    let mut spans = Vec::with_capacity(value.chars().count());

    for (original_start, character) in value.char_indices() {
        let original_end = original_start + character.len_utf8();
        let folded_start = text.len();
        for folded_character in character.case_fold_with(Variant::Simple, Locale::NonTurkic) {
            text.push(folded_character);
        }
        spans.push(FoldedCharSpan {
            folded_start,
            folded_end: text.len(),
            original_start,
            original_end,
        });
    }

    FoldedText { text, spans }
}

fn original_byte_range_for_folded_match(
    folded: &FoldedText,
    folded_start: usize,
    folded_end: usize,
) -> Option<(usize, usize)> {
    let start_span_index = folded
        .spans
        .binary_search_by_key(&folded_start, |span| span.folded_start)
        .ok()?;
    let end_span_index = folded
        .spans
        .binary_search_by_key(&folded_end, |span| span.folded_end)
        .ok()?;
    Some((
        folded.spans[start_span_index].original_start,
        folded.spans[end_span_index].original_end,
    ))
}

enum MatchScanner<'a> {
    CaseSensitive {
        cursor: usize,
        needle: &'a str,
        text: &'a str,
    },
    AsciiCaseInsensitive {
        cursor: usize,
        needle: &'a [u8],
        text: &'a str,
    },
    UnicodeCaseInsensitive {
        cursor: usize,
        folded_needle: String,
        folded_text: FoldedText,
    },
}

impl<'a> MatchScanner<'a> {
    fn new(text: &'a str, needle: &'a str, match_case: bool) -> Self {
        if match_case {
            Self::CaseSensitive {
                cursor: 0,
                needle,
                text,
            }
        } else if text.is_ascii() && needle.is_ascii() {
            Self::AsciiCaseInsensitive {
                cursor: 0,
                needle: needle.as_bytes(),
                text,
            }
        } else {
            Self::UnicodeCaseInsensitive {
                cursor: 0,
                folded_needle: simple_case_fold(needle),
                folded_text: fold_text_with_spans(text),
            }
        }
    }
}

impl Iterator for MatchScanner<'_> {
    type Item = (usize, usize);

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::CaseSensitive {
                cursor,
                needle,
                text,
            } => {
                if needle.is_empty() || *cursor >= text.len() {
                    return None;
                }
                let relative_start = text[*cursor..].find(*needle)?;
                let start = *cursor + relative_start;
                let end = start + needle.len();
                *cursor = end;
                Some((start, end))
            }
            Self::AsciiCaseInsensitive {
                cursor,
                needle,
                text,
            } => {
                let haystack = text.as_bytes();
                while !needle.is_empty() && *cursor + needle.len() <= haystack.len() {
                    let start = *cursor;
                    let end = start + needle.len();
                    if ascii_bytes_equal_ignore_case(&haystack[start..end], needle)
                        && text.is_char_boundary(start)
                        && text.is_char_boundary(end)
                    {
                        *cursor = end;
                        return Some((start, end));
                    }
                    *cursor += 1;
                }
                None
            }
            Self::UnicodeCaseInsensitive {
                cursor,
                folded_needle,
                folded_text,
            } => {
                while !folded_needle.is_empty() && *cursor < folded_text.text.len() {
                    let relative_start =
                        folded_text.text[*cursor..].find(folded_needle.as_str())?;
                    let start = *cursor + relative_start;
                    let end = start + folded_needle.len();
                    *cursor = end;
                    if let Some(original_range) =
                        original_byte_range_for_folded_match(folded_text, start, end)
                    {
                        return Some(original_range);
                    }
                }
                None
            }
        }
    }
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

    fn utf16_offset_for_byte(&self, byte_offset: usize) -> Result<usize, NativeError> {
        let index = self.byte_offsets.binary_search(&byte_offset).map_err(|_| {
            corrupt_index("Search match offset is not a character boundary".to_string())
        })?;
        Ok(self.utf16_offsets[index])
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

fn is_js_whitespace(character: char) -> bool {
    character == '\u{feff}' || (character != '\u{85}' && character.is_whitespace())
}

fn trim_js_whitespace_start(value: &str) -> &str {
    let Some((start, _)) = value
        .char_indices()
        .find(|(_, character)| !is_js_whitespace(*character))
    else {
        return "";
    };
    &value[start..]
}

fn trim_js_whitespace_end(value: &str) -> &str {
    let Some((end_start, end_character)) = value
        .char_indices()
        .rev()
        .find(|(_, character)| !is_js_whitespace(*character))
    else {
        return "";
    };
    &value[..end_start + end_character.len_utf8()]
}

fn build_excerpt(
    text: &str,
    text_map: &PageTextMap,
    start_byte_offset: usize,
    end_byte_offset: usize,
    start_utf16_offset: usize,
    end_utf16_offset: usize,
    context_chars: usize,
) -> SearchExcerpt {
    let text_utf16_len = text_map.utf16_len();
    let excerpt_start_utf16 = start_utf16_offset.saturating_sub(context_chars);
    let excerpt_end_utf16 = text_utf16_len.min(end_utf16_offset.saturating_add(context_chars));
    let excerpt_start_byte = text_map.byte_index_for_utf16_offset(excerpt_start_utf16);
    let excerpt_end_byte = text_map.byte_index_for_utf16_offset(excerpt_end_utf16);

    let before_collapsed = collapse_whitespace(&text[excerpt_start_byte..start_byte_offset]);
    let before = trim_js_whitespace_start(&before_collapsed).to_string();
    let after_collapsed = collapse_whitespace(&text[end_byte_offset..excerpt_end_byte]);
    let after = trim_js_whitespace_end(&after_collapsed).to_string();

    SearchExcerpt {
        prefix: excerpt_start_utf16 > 0,
        suffix: excerpt_end_utf16 < text_utf16_len,
        before,
        matched_text: text[start_byte_offset..end_byte_offset].to_string(),
        after,
    }
}

fn search_index(
    index: &SearchIndex,
    options: &SearchOptions,
) -> Result<SearchResponse, Box<dyn Error>> {
    search_index_with_work_count(index, options).map(|(response, _)| response)
}

fn search_index_with_work_count(
    index: &SearchIndex,
    options: &SearchOptions,
) -> Result<(SearchResponse, usize), Box<dyn Error>> {
    search_index_with_cancel(index, options, None)
}

fn search_index_with_cancel(
    index: &SearchIndex,
    options: &SearchOptions,
    canceled: Option<&AtomicBool>,
) -> Result<(SearchResponse, usize), Box<dyn Error>> {
    let total_pages = options.page_count.unwrap_or(index.page_count);
    let mut results = Vec::new();
    let mut truncated = false;
    let mut matches_examined = 0usize;
    let normalized_query = normalize_search_fragment(&options.query);

    'pages: for record_result in index.records() {
        let record = record_result?;
        if canceled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err(Box::new(native_failure("Search canceled".to_string())));
        }
        if record.page_number == 0 || record.page_number > total_pages {
            continue;
        }

        let text = index.page_text(&record)?;
        let normalized_text = NormalizedText::new(text);
        let mut text_map: Option<PageTextMap> = None;
        for (page_match_index, (normalized_start, normalized_end)) in
            MatchScanner::new(&normalized_text.text, &normalized_query, options.match_case)
                .enumerate()
        {
            if canceled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err(Box::new(native_failure("Search canceled".to_string())));
            }
            matches_examined += 1;
            if results.len() >= options.limit {
                truncated = true;
                break 'pages;
            }

            let (start_byte, end_byte) = normalized_text
                .original_byte_range(normalized_start, normalized_end)
                .ok_or_else(|| corrupt_index("Normalized search match offset is invalid"))?;

            let text_map = text_map.get_or_insert_with(|| PageTextMap::new(text));
            let start_offset = text_map.utf16_offset_for_byte(start_byte)?;
            let end_offset = text_map.utf16_offset_for_byte(end_byte)?;
            results.push(SearchMatch {
                page_number: record.page_number,
                page_match_index,
                match_index: results.len(),
                start_offset,
                end_offset,
                excerpt: build_excerpt(
                    text,
                    text_map,
                    start_byte,
                    end_byte,
                    start_offset,
                    end_offset,
                    options.context_chars,
                ),
            });
        }
    }

    Ok((
        SearchResponse {
            results,
            truncated,
            page_count: total_pages,
        },
        matches_examined,
    ))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum ServiceRequest {
    Search {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "indexPath")]
        index_path: PathBuf,
        query: String,
        #[serde(rename = "documentRevision")]
        document_revision: String,
        #[serde(default = "default_search_limit")]
        limit: usize,
        #[serde(rename = "contextChars", default = "default_context_chars")]
        context_chars: usize,
        #[serde(rename = "matchCase", default)]
        match_case: bool,
        #[serde(rename = "pageCount")]
        page_count: Option<u32>,
    },
    Cancel {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    ResetCache,
    Shutdown,
}

enum ServiceFrame {
    Eof,
    Frame(Vec<u8>),
    TooLarge,
}

fn drain_service_frame(reader: &mut impl BufRead) -> io::Result<()> {
    loop {
        let buffered = reader.fill_buf()?;
        if buffered.is_empty() {
            return Ok(());
        }
        let newline = buffered.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(buffered.len(), |position| position + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(());
        }
    }
}

fn read_service_frame(reader: &mut impl BufRead) -> io::Result<ServiceFrame> {
    let mut frame = Vec::new();
    loop {
        let buffered = reader.fill_buf()?;
        if buffered.is_empty() {
            return if frame.is_empty() {
                Ok(ServiceFrame::Eof)
            } else {
                Ok(ServiceFrame::Frame(frame))
            };
        }

        let newline = buffered.iter().position(|byte| *byte == b'\n');
        let frame_part_len = newline.unwrap_or(buffered.len());
        let remaining = MAX_SERVICE_FRAME_BYTES - frame.len();
        if frame_part_len > remaining {
            let consumed = newline.map_or(buffered.len(), |position| position + 1);
            reader.consume(consumed);
            if newline.is_none() {
                drain_service_frame(reader)?;
            }
            return Ok(ServiceFrame::TooLarge);
        }

        frame.extend_from_slice(&buffered[..frame_part_len]);
        let consumed = newline.map_or(buffered.len(), |position| position + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(ServiceFrame::Frame(frame));
        }
    }
}

fn request_id_for_error(request: &ServiceRequest) -> &str {
    match request {
        ServiceRequest::Search { request_id, .. } | ServiceRequest::Cancel { request_id } => {
            request_id
        }
        ServiceRequest::ResetCache | ServiceRequest::Shutdown => "",
    }
}

fn validate_bounded_string(value: &str, label: &str, max_chars: usize) -> Result<(), NativeError> {
    if value.trim().is_empty() {
        return Err(invalid_request(format!("{label} must not be empty")));
    }
    validate_string_length(value, label, max_chars)
}

fn validate_string_length(value: &str, label: &str, max_chars: usize) -> Result<(), NativeError> {
    if value.encode_utf16().count() > max_chars {
        return Err(too_large(format!(
            "{label} exceeds the {max_chars}-character admission ceiling"
        )));
    }
    Ok(())
}

fn validate_service_request(request: &ServiceRequest) -> Result<(), NativeError> {
    match request {
        ServiceRequest::Search {
            request_id,
            index_path,
            query,
            document_revision,
            limit,
            context_chars,
            page_count,
            ..
        } => {
            validate_bounded_string(request_id, "Search request id", MAX_SEARCH_REQUEST_ID_CHARS)?;
            validate_bounded_string(
                &index_path.to_string_lossy(),
                "Search index path",
                MAX_SEARCH_INDEX_PATH_CHARS,
            )?;
            // Whitespace-only queries are valid literal PDF text searches.
            if query.is_empty() {
                return Err(invalid_request("Search query must not be empty"));
            }
            validate_string_length(query, "Search query", MAX_SEARCH_QUERY_CHARS)?;
            validate_bounded_string(
                document_revision,
                "Search document revision",
                MAX_SEARCH_DOCUMENT_REVISION_CHARS,
            )?;
            if *limit > MAX_SEARCH_RESULT_LIMIT {
                return Err(too_large(format!(
                    "Search result limit exceeds the {MAX_SEARCH_RESULT_LIMIT}-result admission ceiling"
                )));
            }
            if *context_chars > MAX_SEARCH_CONTEXT_CHARS {
                return Err(too_large(format!(
                    "Search context exceeds the {MAX_SEARCH_CONTEXT_CHARS}-character admission ceiling"
                )));
            }
            // `page_count` is a u32 on the native wire protocol. Serde
            // rejects values outside that checked native integer range.
            // Sparse sidecars may declare more pages than they retain
            // records for, so this must not be tied to record admission.
            if let Some(page_count) = page_count {
                if *page_count == 0 {
                    return Err(invalid_request("Search page count must be at least 1"));
                }
            }
        }
        ServiceRequest::Cancel { request_id } => {
            validate_bounded_string(request_id, "Search request id", MAX_SEARCH_REQUEST_ID_CHARS)?
        }
        ServiceRequest::ResetCache | ServiceRequest::Shutdown => {}
    }
    Ok(())
}

fn default_search_limit() -> usize {
    500
}

fn default_context_chars() -> usize {
    24
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ServiceResponse<'a> {
    Ready {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    Result {
        #[serde(rename = "requestId")]
        request_id: &'a str,
        result: &'a SearchResponse,
    },
    Canceled {
        #[serde(rename = "requestId")]
        request_id: &'a str,
    },
    Error {
        #[serde(rename = "requestId")]
        request_id: &'a str,
        error: ErrorEnvelope,
    },
}

struct ServiceIndexCacheState {
    entries: HashMap<(PathBuf, String), Arc<SearchIndex>>,
    recency: VecDeque<(PathBuf, String)>,
    max_entries: usize,
    max_bytes: usize,
}

impl Default for ServiceIndexCacheState {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            recency: VecDeque::new(),
            max_entries: MAX_SERVICE_CACHED_INDEXES,
            max_bytes: MAX_SERVICE_CACHED_INDEX_BYTES,
        }
    }
}

impl ServiceIndexCacheState {
    #[cfg(test)]
    fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            max_entries,
            max_bytes,
            ..Self::default()
        }
    }

    fn cached_bytes(&self) -> usize {
        self.entries.values().fold(0usize, |total, index| {
            total.saturating_add(index.cache_weight_bytes())
        })
    }

    fn get(&mut self, key: &(PathBuf, String)) -> Option<Arc<SearchIndex>> {
        let index = self.entries.get(key).cloned()?;
        self.recency.retain(|candidate| candidate != key);
        self.recency.push_back(key.clone());
        Some(index)
    }

    fn insert(&mut self, key: (PathBuf, String), index: Arc<SearchIndex>) {
        self.entries
            .retain(|(cached_path, _), _| cached_path != &key.0);
        self.recency
            .retain(|(cached_path, _)| cached_path != &key.0);
        self.entries.insert(key.clone(), index);
        self.recency.push_back(key);
        while self.entries.len() > self.max_entries || self.cached_bytes() > self.max_bytes {
            if let Some(oldest) = self.recency.pop_front() {
                self.entries.remove(&oldest);
            } else {
                break;
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.recency.clear();
    }
}

type ServiceIndexCache = Arc<Mutex<ServiceIndexCacheState>>;
type ServiceCancellationMap = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;
type ServiceOutput = Arc<Mutex<io::Stdout>>;

fn write_service_response(
    output: &ServiceOutput,
    response: &ServiceResponse<'_>,
) -> Result<(), Box<dyn Error>> {
    let mut output = output
        .lock()
        .map_err(|_| native_failure("Search service output lock poisoned".to_string()))?;
    serde_json::to_writer(&mut *output, response)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn get_cached_index(
    cache: &ServiceIndexCache,
    path: &PathBuf,
    revision: &str,
) -> Result<Arc<SearchIndex>, Box<dyn Error>> {
    let key = (path.clone(), revision.to_string());
    {
        let mut cache = cache
            .lock()
            .map_err(|_| native_failure("Search index cache lock poisoned".to_string()))?;
        if let Some(index) = cache.get(&key) {
            return Ok(index);
        }
    }
    let index = Arc::new(load_index(path, revision)?);
    let mut cache = cache
        .lock()
        .map_err(|_| native_failure("Search index cache lock poisoned".to_string()))?;
    if let Some(existing) = cache.get(&key) {
        return Ok(existing);
    }
    cache.insert(key, Arc::clone(&index));
    Ok(index)
}

fn reap_finished_service_workers(workers: &mut Vec<thread::JoinHandle<()>>) {
    let mut index = 0;
    while index < workers.len() {
        if workers[index].is_finished() {
            let worker = workers.remove(index);
            let _ = worker.join();
        } else {
            index += 1;
        }
    }
}

fn cancel_all_service_requests(
    cancellations: &ServiceCancellationMap,
) -> Result<(), Box<dyn Error>> {
    let cancellations = cancellations
        .lock()
        .map_err(|_| native_failure("Search cancellation lock poisoned".to_string()))?;
    for cancellation in cancellations.values() {
        cancellation.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn stop_service_workers(
    cancellations: &ServiceCancellationMap,
    workers: Vec<thread::JoinHandle<()>>,
) -> Result<(), Box<dyn Error>> {
    cancel_all_service_requests(cancellations)?;
    join_service_workers(workers);
    Ok(())
}

fn join_service_workers(workers: Vec<thread::JoinHandle<()>>) {
    for worker in workers {
        let _ = worker.join();
    }
}

fn run_service() -> Result<(), Box<dyn Error>> {
    let cache: ServiceIndexCache = Arc::new(Mutex::new(ServiceIndexCacheState::default()));
    let cancellations: ServiceCancellationMap = Arc::new(Mutex::new(HashMap::new()));
    let output = Arc::new(Mutex::new(io::stdout()));
    write_service_response(
        &output,
        &ServiceResponse::Ready {
            protocol_version: PDF_SEARCH.protocol_version,
        },
    )?;
    let mut workers: Vec<thread::JoinHandle<()>> = Vec::new();

    let mut input = BufReader::new(io::stdin());
    loop {
        let frame = match read_service_frame(&mut input) {
            Err(error) => {
                stop_service_workers(&cancellations, workers)?;
                return Err(Box::new(error));
            }
            Ok(ServiceFrame::Eof) => break,
            Ok(ServiceFrame::Frame(frame)) => frame,
            Ok(ServiceFrame::TooLarge) => {
                write_service_response(
                    &output,
                    &ServiceResponse::Error {
                        request_id: "",
                        error: ErrorEnvelope {
                            code: NativeErrorCode::TooLarge,
                            message: format!(
                                "Search service frame exceeds the {MAX_SERVICE_FRAME_BYTES}-byte admission ceiling"
                            ),
                        },
                    },
                )?;
                continue;
            }
        };
        if frame.iter().all(|byte| byte.is_ascii_whitespace()) {
            continue;
        }
        let request = match serde_json::from_slice::<ServiceRequest>(&frame) {
            Ok(request) => request,
            Err(error) => {
                write_service_response(
                    &output,
                    &ServiceResponse::Error {
                        request_id: "",
                        error: ErrorEnvelope {
                            code: NativeErrorCode::InvalidRequest,
                            message: format!("Invalid search service frame: {error}"),
                        },
                    },
                )?;
                continue;
            }
        };
        if let Err(error) = validate_service_request(&request) {
            let request_id = if request_id_for_error(&request).encode_utf16().count()
                <= MAX_SEARCH_REQUEST_ID_CHARS
            {
                request_id_for_error(&request)
            } else {
                ""
            };
            write_service_response(
                &output,
                &ServiceResponse::Error {
                    request_id,
                    error: ErrorEnvelope {
                        code: error.code,
                        message: error.message,
                    },
                },
            )?;
            continue;
        }
        match request {
            ServiceRequest::ResetCache => {
                cache
                    .lock()
                    .map_err(|_| native_failure("Search index cache lock poisoned".to_string()))?
                    .clear();
            }
            ServiceRequest::Cancel { request_id } => {
                if let Some(flag) = cancellations
                    .lock()
                    .map_err(|_| native_failure("Search cancellation lock poisoned".to_string()))?
                    .get(&request_id)
                {
                    flag.store(true, Ordering::Relaxed);
                }
            }
            ServiceRequest::Shutdown => {
                break;
            }
            ServiceRequest::Search {
                request_id,
                index_path,
                query,
                document_revision,
                limit,
                context_chars,
                match_case,
                page_count,
            } => {
                reap_finished_service_workers(&mut workers);
                let cancellation_exists = cancellations
                    .lock()
                    .map_err(|_| native_failure("Search cancellation lock poisoned".to_string()))?
                    .contains_key(&request_id);
                if cancellation_exists {
                    write_service_response(
                        &output,
                        &ServiceResponse::Error {
                            request_id: &request_id,
                            error: ErrorEnvelope {
                                code: NativeErrorCode::InvalidRequest,
                                message: "Duplicate active search request id".to_string(),
                            },
                        },
                    )?;
                    continue;
                }
                if workers.len() >= MAX_SERVICE_WORKERS {
                    write_service_response(
                        &output,
                        &ServiceResponse::Error {
                            request_id: &request_id,
                            error: ErrorEnvelope {
                                code: NativeErrorCode::NativeFailure,
                                message: "Persistent native search service is busy".to_string(),
                            },
                        },
                    )?;
                    continue;
                }
                let canceled = Arc::new(AtomicBool::new(false));
                cancellations
                    .lock()
                    .map_err(|_| native_failure("Search cancellation lock poisoned".to_string()))?
                    .insert(request_id.clone(), Arc::clone(&canceled));
                let cache = Arc::clone(&cache);
                let cancellations = Arc::clone(&cancellations);
                let output = Arc::clone(&output);
                workers.push(thread::spawn(move || {
                    let options = SearchOptions {
                        index_path: index_path.clone(),
                        query,
                        limit,
                        context_chars,
                        match_case,
                        page_count,
                        document_revision: document_revision.clone(),
                    };
                    let result = std::panic::catch_unwind(|| {
                        get_cached_index(&cache, &index_path, &document_revision).and_then(
                            |index| {
                                search_index_with_cancel(&index, &options, Some(&canceled))
                                    .map(|value| value.0)
                            },
                        )
                    });
                    let response = match &result {
                        Err(_) => ServiceResponse::Error {
                            request_id: &request_id,
                            error: ErrorEnvelope {
                                code: NativeErrorCode::Panic,
                                message: "Native search worker panicked".to_string(),
                            },
                        },
                        Ok(Ok(result)) => ServiceResponse::Result {
                            request_id: &request_id,
                            result,
                        },
                        Ok(Err(_)) if canceled.load(Ordering::Relaxed) => {
                            ServiceResponse::Canceled {
                                request_id: &request_id,
                            }
                        }
                        Ok(Err(error)) => {
                            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
                            ServiceResponse::Error {
                                request_id: &request_id,
                                error: ErrorEnvelope {
                                    code: envelope.code,
                                    message: envelope.message,
                                },
                            }
                        }
                    };
                    if let Ok(mut map) = cancellations.lock() {
                        map.remove(&request_id);
                    }
                    let _ = write_service_response(&output, &response);
                }));
            }
        }
    }
    stop_service_workers(&cancellations, workers)
}

fn run_cli(mut args: impl Iterator<Item = String>) -> Result<(), Box<dyn Error>> {
    let Some(command) = args.next() else {
        return Err(Box::new(invalid_request(usage().to_string())));
    };

    match command.as_str() {
        "serve" => run_service(),
        "search" => {
            let options = parse_search_options(args)?;
            let index = load_index(&options.index_path, &options.document_revision)?;
            let response = search_index(&index, &options)?;
            println!("{}", serde_json::to_string(&response)?);
            Ok(())
        }
        "--help" | "-h" => Err(Box::new(invalid_request(usage().to_string()))),
        _ => Err(Box::new(invalid_request(format!(
            "Unknown command: {command}"
        )))),
    }
}

fn main() {
    evb_native_support::run_native_cli(
        PDF_SEARCH,
        env!("CARGO_PKG_VERSION"),
        env::args().skip(1),
        |args| run_cli(args.into_iter()),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[test]
    fn service_shutdown_cancels_and_joins_every_active_request() {
        let first = Arc::new(AtomicBool::new(false));
        let second = Arc::new(AtomicBool::new(false));
        let cancellations: ServiceCancellationMap = Arc::new(Mutex::new(HashMap::from([
            ("first".to_string(), Arc::clone(&first)),
            ("second".to_string(), Arc::clone(&second)),
        ])));

        let first_completed = Arc::new(AtomicBool::new(false));
        let second_completed = Arc::new(AtomicBool::new(false));
        let workers = [
            (Arc::clone(&first), Arc::clone(&first_completed)),
            (Arc::clone(&second), Arc::clone(&second_completed)),
        ]
        .map(|(canceled, completed)| {
            thread::spawn(move || {
                while !canceled.load(Ordering::Relaxed) {
                    thread::yield_now();
                }
                completed.store(true, Ordering::Relaxed);
            })
        })
        .into_iter()
        .collect();

        stop_service_workers(&cancellations, workers).expect("stop active service workers");

        assert!(first.load(Ordering::Relaxed));
        assert!(second.load(Ordering::Relaxed));
        assert!(first_completed.load(Ordering::Relaxed));
        assert!(second_completed.load(Ordering::Relaxed));
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SearchConformanceCorpus {
        cases: Vec<SearchConformanceCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SearchConformanceCase {
        id: String,
        text: String,
        query: String,
        options: Option<SearchConformanceOptions>,
        context_chars: usize,
        native_supported: bool,
        expected_matches: Vec<SearchConformanceExpectedMatch>,
    }

    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct SearchConformanceOptions {
        match_case: Option<bool>,
        whole_word: Option<bool>,
        use_regex: Option<bool>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SearchConformanceExpectedMatch {
        start_offset: usize,
        end_offset: usize,
        excerpt: SearchConformanceExpectedExcerpt,
    }

    #[derive(Deserialize, Debug, PartialEq, Eq)]
    struct SearchConformanceExpectedExcerpt {
        prefix: bool,
        suffix: bool,
        before: String,
        #[serde(rename = "match")]
        matched_text: String,
        after: String,
    }

    fn test_index(pages: &[(u32, &str)]) -> SearchIndex {
        let mut data = Vec::new();
        let mut records = Vec::new();
        for (page_number, text) in pages {
            let offset = data.len();
            data.extend_from_slice(text.as_bytes());
            records.push(PageRecord {
                page_number: *page_number,
                offset,
                byte_len: text.len(),
            });
        }
        SearchIndex {
            page_count: pages.len() as u32,
            records: SearchIndexRecords::Legacy(records),
            data: SearchIndexData::Owned(data),
        }
    }

    #[test]
    fn honors_search_cancellation_between_matches() {
        let index = test_index(&[(1, "alpha alpha alpha")]);
        let canceled = AtomicBool::new(true);
        let error = search_index_with_cancel(&index, &options("alpha"), Some(&canceled))
            .expect_err("canceled search must stop");

        assert!(error.to_string().contains("canceled"));
    }

    #[test]
    fn service_worker_reaping_never_joins_active_workers() {
        let release = Arc::new(AtomicBool::new(false));
        let mut workers = (0..MAX_SERVICE_WORKERS)
            .map(|_| {
                let release = Arc::clone(&release);
                thread::spawn(move || {
                    while !release.load(Ordering::Relaxed) {
                        thread::yield_now();
                    }
                })
            })
            .collect::<Vec<_>>();
        reap_finished_service_workers(&mut workers);

        assert_eq!(workers.len(), MAX_SERVICE_WORKERS);
        release.store(true, Ordering::Relaxed);
        for worker in workers {
            worker.join().expect("join released worker");
        }
    }

    #[test]
    fn service_worker_reaping_removes_only_finished_workers() {
        let mut workers = vec![thread::spawn(|| {})];
        while !workers[0].is_finished() {
            thread::yield_now();
        }

        reap_finished_service_workers(&mut workers);

        assert!(workers.is_empty());
    }

    const TEST_DOCUMENT_REVISION: &str = "revision-token";

    fn serialized_index(pages: &[(u32, &str)]) -> Vec<u8> {
        let header_size = HEADER_SIZE;
        let revision_token = TEST_DOCUMENT_REVISION.as_bytes();
        let table_size = pages.len() * PAGE_RECORD_SIZE;
        let page_table_offset = header_size + revision_token.len();
        let text_data_offset = page_table_offset + table_size;
        let mut text_offset = text_data_offset;
        let mut page_text = Vec::new();
        let mut records = Vec::new();

        for (page_number, text) in pages {
            let bytes = text.as_bytes();
            records.push((*page_number, text_offset, bytes.len()));
            page_text.extend_from_slice(bytes);
            text_offset += bytes.len();
        }

        let mut data = Vec::with_capacity(header_size + table_size + page_text.len());
        data.extend_from_slice(MAGIC);
        data.extend_from_slice(&SCHEMA_VERSION.to_le_bytes());
        data.extend_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
        data.extend_from_slice(&(pages.len() as u32).to_le_bytes());
        data.extend_from_slice(&(pages.len() as u32).to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&(revision_token.len() as u32).to_le_bytes());
        data.extend_from_slice(&(HEADER_SIZE as u64).to_le_bytes());
        data.extend_from_slice(&(page_table_offset as u64).to_le_bytes());
        data.extend_from_slice(&(text_data_offset as u64).to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(revision_token);

        for (page_number, offset, byte_len) in records {
            data.extend_from_slice(&page_number.to_le_bytes());
            data.extend_from_slice(&0u32.to_le_bytes());
            data.extend_from_slice(&(offset as u64).to_le_bytes());
            data.extend_from_slice(&(byte_len as u64).to_le_bytes());
        }

        data.extend_from_slice(&page_text);
        data
    }

    fn serialized_streaming_index(
        page_count: u32,
        pages: &[(u32, &str)],
        pages_scanned: u32,
        flags: u32,
    ) -> Vec<u8> {
        let revision_token = TEST_DOCUMENT_REVISION.as_bytes();
        let directory_offset = STREAMING_HEADER_SIZE + revision_token.len();
        let directory_length = page_count as usize * STREAMING_DIRECTORY_ENTRY_SIZE;
        let text_data_offset = directory_offset + directory_length;
        let text_bytes = pages.iter().map(|(_, text)| text.len()).sum::<usize>();
        let pages_written = pages.iter().filter(|(_, text)| !text.is_empty()).count() as u32;
        let footer_offset = text_data_offset + text_bytes;
        let mut data = vec![0u8; footer_offset + STREAMING_FOOTER_SIZE];

        data[0..8].copy_from_slice(STREAMING_MAGIC);
        data[8..12].copy_from_slice(&STREAMING_SCHEMA_VERSION.to_le_bytes());
        data[12..16].copy_from_slice(&(STREAMING_HEADER_SIZE as u32).to_le_bytes());
        data[16..20].copy_from_slice(&page_count.to_le_bytes());
        data[20..24].copy_from_slice(&pages_written.to_le_bytes());
        data[24..28].copy_from_slice(&flags.to_le_bytes());
        data[28..32].copy_from_slice(&(revision_token.len() as u32).to_le_bytes());
        data[32..40].copy_from_slice(&(STREAMING_HEADER_SIZE as u64).to_le_bytes());
        data[40..48].copy_from_slice(&(directory_offset as u64).to_le_bytes());
        data[48..56].copy_from_slice(&(text_data_offset as u64).to_le_bytes());
        data[56..64].copy_from_slice(&(footer_offset as u64).to_le_bytes());
        data[STREAMING_HEADER_SIZE..directory_offset].copy_from_slice(revision_token);

        let mut next_text_offset = text_data_offset;
        for (page_number, text) in pages {
            let record_offset =
                directory_offset + (*page_number as usize - 1) * STREAMING_DIRECTORY_ENTRY_SIZE;
            let byte_offset = if text.is_empty() { 0 } else { next_text_offset };
            data[record_offset..record_offset + 8]
                .copy_from_slice(&(byte_offset as u64).to_le_bytes());
            data[record_offset + 8..record_offset + 16]
                .copy_from_slice(&(text.len() as u64).to_le_bytes());
            data[record_offset + 16..record_offset + 20]
                .copy_from_slice(&(text.encode_utf16().count() as u32).to_le_bytes());
            data[record_offset + 20..record_offset + 24].copy_from_slice(&1u32.to_le_bytes());
            data[next_text_offset..next_text_offset + text.len()].copy_from_slice(text.as_bytes());
            next_text_offset += text.len();
        }

        data[footer_offset..footer_offset + 8].copy_from_slice(STREAMING_FOOTER_MAGIC);
        data[footer_offset + 8..footer_offset + 12]
            .copy_from_slice(&STREAMING_SCHEMA_VERSION.to_le_bytes());
        data[footer_offset + 12..footer_offset + 16]
            .copy_from_slice(&(STREAMING_FOOTER_SIZE as u32).to_le_bytes());
        data[footer_offset + 16..footer_offset + 20].copy_from_slice(&flags.to_le_bytes());
        data[footer_offset + 24..footer_offset + 28].copy_from_slice(&pages_written.to_le_bytes());
        data[footer_offset + 32..footer_offset + 40]
            .copy_from_slice(&(text_bytes as u64).to_le_bytes());
        let file_length = data.len() as u64;
        data[footer_offset + 40..footer_offset + 48].copy_from_slice(&file_length.to_le_bytes());
        data[footer_offset + 48..footer_offset + 56]
            .copy_from_slice(&(directory_length as u64).to_le_bytes());
        data[footer_offset + 56..footer_offset + 64]
            .copy_from_slice(&(pages_scanned as u64).to_le_bytes());

        data
    }

    fn assert_streaming_index_rejected(bytes: Vec<u8>, message: &str) {
        let error = load_index_data(SearchIndexData::Owned(bytes), TEST_DOCUMENT_REVISION)
            .expect_err("malformed streaming search index must be rejected");
        let native_error = error
            .downcast_ref::<NativeError>()
            .expect("streaming index failure should be a native error");
        assert_eq!(native_error.code, NativeErrorCode::NativeFailure);
        assert!(native_error.message.contains(message), "{native_error}");
    }

    fn options(query: &str) -> SearchOptions {
        SearchOptions {
            index_path: PathBuf::new(),
            query: query.to_string(),
            limit: 500,
            context_chars: 8,
            match_case: false,
            page_count: None,
            document_revision: TEST_DOCUMENT_REVISION.to_string(),
        }
    }

    #[test]
    fn loads_native_index_file_and_emits_stable_json_response() {
        let path = env::temp_dir().join(format!("evb-pdf-search-golden-{}", process::id()));
        fs::write(
            &path,
            serialized_index(&[
                (1, "one Alpha two"),
                (2, "zero alpha one alpha"),
                (3, "hidden alpha"),
            ]),
        )
        .expect("write temp native search index");

        let index = load_index(&path, TEST_DOCUMENT_REVISION).expect("load native search index");
        assert!(matches!(index.data, SearchIndexData::Owned(_)));
        fs::remove_file(&path).ok();

        let mut search_options = options("alpha");
        search_options.context_chars = 4;
        search_options.page_count = Some(2);
        let response = search_index(&index, &search_options).expect("search should succeed");

        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            concat!(
                r#"{"results":["#,
                r#"{"pageNumber":1,"pageMatchIndex":0,"matchIndex":0,"startOffset":4,"endOffset":9,"#,
                r#""excerpt":{"prefix":false,"suffix":false,"before":"one ","match":"Alpha","after":" two"}}"#,
                r#",{"pageNumber":2,"pageMatchIndex":0,"matchIndex":1,"startOffset":5,"endOffset":10,"#,
                r#""excerpt":{"prefix":true,"suffix":true,"before":"ero ","match":"alpha","after":" one"}}"#,
                r#",{"pageNumber":2,"pageMatchIndex":1,"matchIndex":2,"startOffset":15,"endOffset":20,"#,
                r#""excerpt":{"prefix":true,"suffix":false,"before":"one ","match":"alpha","after":""}}"#,
                r#"],"truncated":false,"pageCount":2}"#,
            ),
        );
    }

    #[test]
    fn searches_sparse_streaming_index_without_page_count_records() {
        let page_count = 1_000_001;
        let flags = STREAMING_FLAG_COMPLETE;
        let index = load_index_data(
            SearchIndexData::Owned(serialized_streaming_index(
                page_count,
                &[(1, "first needle"), (page_count, "last needle")],
                page_count,
                flags,
            )),
            TEST_DOCUMENT_REVISION,
        )
        .expect("load sparse streaming search index");

        let directory = match &index.records {
            SearchIndexRecords::Streaming(directory) => directory,
            SearchIndexRecords::Legacy(_) => panic!("expected streaming index directory"),
        };
        assert_eq!(directory.pages_written, 2);
        assert_eq!(directory.pages_scanned, page_count);
        assert_eq!(directory.flags, flags);

        let response = search_index(&index, &options("needle")).expect("search sparse index");
        assert_eq!(response.page_count, page_count);
        assert_eq!(response.results.len(), 2);
        assert_eq!(response.results[0].page_number, 1);
        assert_eq!(response.results[1].page_number, page_count);
    }

    #[test]
    fn preserves_streaming_partial_and_truncated_coverage_metadata() {
        let flags = STREAMING_FLAG_COMPLETE
            | STREAMING_FLAG_PARTIAL_COVERAGE
            | STREAMING_FLAG_TRUNCATED_COVERAGE;
        let index = load_index_data(
            SearchIndexData::Owned(serialized_streaming_index(3, &[(1, "needle")], 2, flags)),
            TEST_DOCUMENT_REVISION,
        )
        .expect("load partial streaming search index");

        let directory = match &index.records {
            SearchIndexRecords::Streaming(directory) => directory,
            SearchIndexRecords::Legacy(_) => panic!("expected streaming index directory"),
        };
        assert_eq!(directory.pages_scanned, 2);
        assert_eq!(directory.flags, flags);
        let response = search_index(&index, &options("needle")).expect("search partial index");
        assert_eq!(response.page_count, 3);
        assert_eq!(response.results.len(), 1);
    }

    #[test]
    fn treats_present_empty_streaming_pages_as_blank() {
        let index = load_index_data(
            SearchIndexData::Owned(serialized_streaming_index(
                3,
                &[(1, ""), (2, "needle")],
                3,
                STREAMING_FLAG_COMPLETE,
            )),
            TEST_DOCUMENT_REVISION,
        )
        .expect("load streaming index with blank page");

        let directory = match &index.records {
            SearchIndexRecords::Streaming(directory) => directory,
            SearchIndexRecords::Legacy(_) => panic!("expected streaming index directory"),
        };
        assert_eq!(directory.pages_written, 1);
        let response = search_index(&index, &options("needle")).expect("search blank-page index");
        assert_eq!(response.page_count, 3);
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].page_number, 2);
    }

    #[test]
    fn rejects_malformed_streaming_index_metadata() {
        let flags = STREAMING_FLAG_COMPLETE;
        let valid = serialized_streaming_index(2, &[(1, "needle")], 2, flags);

        let mut bad_footer_offset = valid.clone();
        let bad_footer_offset_value = (bad_footer_offset.len() as u64) - 63;
        bad_footer_offset[56..64].copy_from_slice(&bad_footer_offset_value.to_le_bytes());
        assert_streaming_index_rejected(bad_footer_offset, "layout is invalid");

        let mut bad_bytes_written = valid.clone();
        let footer_offset =
            u64::from_le_bytes(bad_bytes_written[56..64].try_into().unwrap()) as usize;
        bad_bytes_written[footer_offset + 32..footer_offset + 40]
            .copy_from_slice(&0u64.to_le_bytes());
        assert_streaming_index_rejected(bad_bytes_written, "coverage counts are inconsistent");

        let mut bad_pages_scanned = valid;
        let footer_offset =
            u64::from_le_bytes(bad_pages_scanned[56..64].try_into().unwrap()) as usize;
        bad_pages_scanned[footer_offset + 56..footer_offset + 64]
            .copy_from_slice(&3u64.to_le_bytes());
        assert_streaming_index_rejected(bad_pages_scanned, "pagesScanned exceeds page count");
    }

    #[test]
    fn rejects_streaming_index_with_mismatched_document_revision() {
        let bytes = serialized_streaming_index(2, &[(1, "needle")], 2, STREAMING_FLAG_COMPLETE);
        let error = load_index_data(SearchIndexData::Owned(bytes), "other-revision")
            .expect_err("streaming revision mismatch should fail");
        let native_error = error
            .downcast_ref::<NativeError>()
            .expect("streaming revision mismatch should be a native error");
        assert_eq!(native_error.code, NativeErrorCode::NativeFailure);
        assert!(
            native_error.message.contains("document revision mismatch"),
            "{native_error}"
        );
    }

    #[test]
    fn rejects_native_index_with_mismatched_document_revision() {
        let path = env::temp_dir().join(format!("evb-pdf-search-revision-{}", process::id()));
        fs::write(&path, serialized_index(&[(1, "one Alpha two")]))
            .expect("write temp native search index");

        let error = load_index(&path, "other-token").expect_err("revision mismatch should fail");
        fs::remove_file(&path).ok();

        assert!(error.to_string().contains("document revision mismatch"));
    }

    #[test]
    fn searches_ascii_case_insensitive_literals() {
        let index = test_index(&[(1, "Alpha beta alpha"), (2, "ALPHA")]);

        let response = search_index(&index, &options("alpha")).expect("search should succeed");

        assert_eq!(response.results.len(), 3);
        assert_eq!(response.results[0].page_number, 1);
        assert_eq!(response.results[0].page_match_index, 0);
        assert_eq!(response.results[0].start_offset, 0);
        assert_eq!(response.results[1].page_match_index, 1);
        assert_eq!(response.results[2].page_number, 2);
        assert_eq!(response.results[2].matched_text(), "ALPHA");
    }

    #[test]
    fn searches_unicode_case_insensitive_literals() {
        let index = test_index(&[(1, "Привет, ЁЖ"), (2, "CAFÉ Σίσυφος K ſ")]);

        let cyrillic_response =
            search_index(&index, &options("ёж")).expect("search should succeed");
        assert_eq!(cyrillic_response.results.len(), 1);
        assert_eq!(cyrillic_response.results[0].page_number, 1);
        assert_eq!(cyrillic_response.results[0].matched_text(), "ЁЖ");

        let accent_response =
            search_index(&index, &options("café")).expect("search should succeed");
        assert_eq!(accent_response.results.len(), 1);
        assert_eq!(accent_response.results[0].page_number, 2);
        assert_eq!(accent_response.results[0].matched_text(), "CAFÉ");

        let sigma_response = search_index(&index, &options("ς")).expect("search should succeed");
        assert_eq!(sigma_response.results.len(), 3);
        assert_eq!(sigma_response.results[0].matched_text(), "Σ");
        assert_eq!(sigma_response.results[1].matched_text(), "σ");
        assert_eq!(sigma_response.results[2].matched_text(), "ς");

        let kelvin_response = search_index(&index, &options("k")).expect("search should succeed");
        assert_eq!(kelvin_response.results.len(), 1);
        assert_eq!(kelvin_response.results[0].matched_text(), "K");

        let long_s_response = search_index(&index, &options("s")).expect("search should succeed");
        assert_eq!(long_s_response.results.len(), 1);
        assert_eq!(long_s_response.results[0].matched_text(), "ſ");
    }

    #[test]
    fn keeps_simple_case_folding_from_expanding_matches() {
        let index = test_index(&[(1, "İ ß")]);

        let dotted_i_response = search_index(&index, &options("i")).expect("search should succeed");
        assert!(dotted_i_response.results.is_empty());

        let sharp_s_response = search_index(&index, &options("ss")).expect("search should succeed");
        assert!(sharp_s_response.results.is_empty());
    }

    #[test]
    fn reports_utf16_offsets_for_page_text() {
        let index = test_index(&[(1, "\u{1F600} needle")]);
        let mut search_options = options("needle");
        search_options.match_case = true;

        let response = search_index(&index, &search_options).expect("search should succeed");

        assert_eq!(response.results[0].start_offset, 3);
        assert_eq!(response.results[0].end_offset, 9);
        assert_eq!(response.results[0].excerpt.matched_text, "needle");
    }

    #[test]
    fn truncates_at_result_limit() {
        let index = test_index(&[(1, "a a a a")]);
        let mut search_options = options("a");
        search_options.limit = 2;

        let response = search_index(&index, &search_options).expect("search should succeed");

        assert!(response.truncated);
        assert_eq!(response.results.len(), 2);
        assert_eq!(response.results[1].match_index, 1);
    }

    #[test]
    fn limit_one_bounds_dense_page_match_work() {
        let dense_text = "a ".repeat(100_000);
        let index = test_index(&[(1, &dense_text)]);
        let mut search_options = options("a");
        search_options.limit = 1;

        let (response, matches_examined) =
            search_index_with_work_count(&index, &search_options).expect("search should succeed");

        assert_eq!(response.results.len(), 1);
        assert!(response.truncated);
        assert_eq!(
            matches_examined, 2,
            "only the result and truncation probe run"
        );
    }

    #[test]
    fn zero_limit_returns_no_matches_and_tracks_truncation() {
        let index = test_index(&[(1, "alpha"), (2, "beta")]);
        let mut search_options = options("alpha");
        search_options.limit = 0;

        let response = search_index(&index, &search_options).expect("search should succeed");

        assert!(response.results.is_empty());
        assert!(response.truncated);

        search_options.query = "gamma".to_string();
        let response = search_index(&index, &search_options).expect("search should succeed");

        assert!(response.results.is_empty());
        assert!(!response.truncated);
    }

    #[test]
    fn does_not_truncate_when_result_count_equals_limit() {
        let index = test_index(&[(1, "a a")]);
        let mut search_options = options("a");
        search_options.limit = 2;

        let response = search_index(&index, &search_options).expect("search should succeed");

        assert_eq!(response.results.len(), 2);
        assert!(!response.truncated);
    }

    #[test]
    fn builds_excerpt_with_javascript_whitespace_rules() {
        let text = "\u{feff}\u{85}Needle\u{85}\u{feff}";
        let start_byte = text.find("Needle").unwrap();
        let end_byte = start_byte + "Needle".len();
        let text_map = PageTextMap::new(text);

        let excerpt = build_excerpt(
            text,
            &text_map,
            start_byte,
            end_byte,
            text_map.utf16_offset_for_byte(start_byte).unwrap(),
            text_map.utf16_offset_for_byte(end_byte).unwrap(),
            10,
        );

        assert_eq!(excerpt.before, "\u{85}");
        assert_eq!(excerpt.after, "\u{85}");
    }

    #[test]
    fn matches_shared_conformance_corpus_native_subset() {
        let corpus: SearchConformanceCorpus = serde_json::from_str(include_str!(
            "../../../packages/contracts/searchConformanceCorpus.json"
        ))
        .expect("parse search conformance corpus");

        for case in corpus.cases.iter().filter(|case| case.native_supported) {
            let options_ref = case.options.as_ref();
            assert!(
                !options_ref
                    .and_then(|value| value.whole_word)
                    .unwrap_or(false),
                "native corpus case {} must not require whole-word matching",
                case.id,
            );
            assert!(
                !options_ref
                    .and_then(|value| value.use_regex)
                    .unwrap_or(false),
                "native corpus case {} must not require regex matching",
                case.id,
            );
            let mut search_options = options(&case.query);
            search_options.context_chars = case.context_chars;
            search_options.match_case = options_ref
                .and_then(|value| value.match_case)
                .unwrap_or(false);
            let response = search_index(&test_index(&[(1, &case.text)]), &search_options)
                .expect("search corpus case");

            assert_eq!(
                response.results.len(),
                case.expected_matches.len(),
                "case {} result count",
                case.id,
            );
            for (actual, expected) in response.results.iter().zip(&case.expected_matches) {
                assert_eq!(
                    actual.start_offset, expected.start_offset,
                    "case {} start",
                    case.id,
                );
                assert_eq!(
                    actual.end_offset, expected.end_offset,
                    "case {} end",
                    case.id,
                );
                assert_eq!(
                    SearchConformanceExpectedExcerpt {
                        prefix: actual.excerpt.prefix,
                        suffix: actual.excerpt.suffix,
                        before: actual.excerpt.before.clone(),
                        matched_text: actual.excerpt.matched_text.clone(),
                        after: actual.excerpt.after.clone(),
                    },
                    expected.excerpt,
                    "case {} excerpt",
                    case.id,
                );
            }
        }
    }

    #[test]
    fn rejects_bad_index_magic() {
        let path = env::temp_dir().join(format!("evb-pdf-search-bad-magic-{}", process::id(),));
        fs::write(&path, b"not-index").expect("write temp file");
        let result = load_index(&path, TEST_DOCUMENT_REVISION);
        fs::remove_file(&path).ok();

        assert!(result.is_err());
    }

    fn assert_too_large_index(bytes: Vec<u8>, limits: SearchIndexLimits, message: &str) {
        let error = load_index_data_with_limits(
            SearchIndexData::Owned(bytes),
            TEST_DOCUMENT_REVISION,
            limits,
        )
        .unwrap_err();
        let native_error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        assert!(native_error.message.contains(message), "{native_error}");
    }

    #[test]
    fn caps_search_index_records_and_text_before_retention() {
        let tiny_limits = SearchIndexLimits {
            max_index_bytes: 1_024,
            max_page_records: 1,
            max_page_text_bytes: 4,
            max_total_text_bytes: 8,
        };

        let mut too_many_records = serialized_index(&[]);
        too_many_records[20..24].copy_from_slice(&2u32.to_le_bytes());
        assert_too_large_index(too_many_records, tiny_limits, "1-record admission ceiling");

        assert_too_large_index(
            serialized_index(&[(1, "12345")]),
            tiny_limits,
            "4-byte admission ceiling",
        );
        assert_too_large_index(
            serialized_index(&[(1, "1234"), (2, "5678")]),
            SearchIndexLimits {
                max_page_records: 2,
                max_page_text_bytes: 8,
                max_total_text_bytes: 7,
                ..tiny_limits
            },
            "7-byte aggregate admission ceiling",
        );
    }

    #[test]
    fn bounds_service_index_cache_without_invalidating_active_indexes() {
        let active = Arc::new(test_index(&[(1, "active")]));
        let active_key = (
            PathBuf::from("active.search-index.bin"),
            "revision-0".to_string(),
        );
        let mut cache = ServiceIndexCacheState::default();
        cache.insert(active_key.clone(), Arc::clone(&active));

        for index in 1..=MAX_SERVICE_CACHED_INDEXES {
            cache.insert(
                (
                    PathBuf::from(format!("document-{index}.search-index.bin")),
                    format!("revision-{index}"),
                ),
                Arc::new(test_index(&[(1, "cached")])),
            );
        }

        assert_eq!(cache.entries.len(), MAX_SERVICE_CACHED_INDEXES);
        assert!(!cache.entries.contains_key(&active_key));
        assert_eq!(active.page_count, 1);
        assert_eq!(Arc::strong_count(&active), 1);
    }

    #[test]
    fn bounds_service_index_cache_by_retained_bytes() {
        let first = Arc::new(test_index(&[(1, "first")]));
        let weight = first.cache_weight_bytes();
        let mut cache = ServiceIndexCacheState::with_limits(8, weight * 2);
        let first_key = (PathBuf::from("first.bin"), "revision-1".to_string());
        cache.insert(first_key.clone(), Arc::clone(&first));
        cache.insert(
            (PathBuf::from("second.bin"), "revision-2".to_string()),
            Arc::new(test_index(&[(1, "other")])),
        );
        cache.insert(
            (PathBuf::from("third.bin"), "revision-3".to_string()),
            Arc::new(test_index(&[(1, "third")])),
        );

        assert!(cache.cached_bytes() <= weight * 2);
        assert!(!cache.entries.contains_key(&first_key));
        assert_eq!(Arc::strong_count(&first), 1);
    }

    trait MatchText {
        fn matched_text(&self) -> &str;
    }

    impl MatchText for SearchMatch {
        fn matched_text(&self) -> &str {
            &self.excerpt.matched_text
        }
    }
}
