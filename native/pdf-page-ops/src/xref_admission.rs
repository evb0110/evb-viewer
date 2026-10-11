//! Cross-reference section admission, shared by eager loads and path probes.

use super::*;

/// Walks a path's cross-reference chain with the eager preflight's parsers,
/// reading each section through a window that grows only when it runs out.
pub(super) fn path_xref_chain(path: &Path, encoded_len: u64) -> Result<XrefChain> {
    let mut file =
        File::open(path).map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    let (root, _) = read_terminal_xref(path, encoded_len)?;
    let input_len = usize::try_from(encoded_len)?;
    check_xref_chain(
        usize::try_from(root)?,
        input_len,
        PDF_PATH_LOAD_POLICY,
        |offset, window_len| {
            let window = read_window(&mut file, offset, window_len.min(input_len - offset))?;
            let truncated = offset + window.len() < input_len;
            Ok((std::borrow::Cow::Owned(window), truncated))
        },
    )
}

pub(super) fn preflight_pdf_xref_chain(bytes: &[u8], policy: PdfLoadPolicy) -> Result<()> {
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
    check_xref_chain(root, bytes.len(), policy, |offset, _window_len| {
        Ok((std::borrow::Cow::Borrowed(&bytes[offset..]), false))
    })
    .map(|_| ())
}

/// Walks a cross-reference chain from its terminal section through every
/// `/Prev` and `/XRefStm` link with the append loader's section parsers and
/// ceilings. `section_at(offset, window_len)` returns the input from `offset`,
/// either to its end or as a window of at most `window_len` bytes, and says
/// whether the window was cut short. Only a parse that failed after running
/// out of a cut-short window is retried with a longer one; any other failure
/// keeps its own classification. A section that still runs out at the probe
/// ceiling exceeds it.
pub(crate) fn check_xref_chain<'a>(
    root: usize,
    input_len: usize,
    policy: PdfLoadPolicy,
    mut section_at: impl FnMut(usize, usize) -> Result<(std::borrow::Cow<'a, [u8]>, bool)>,
) -> Result<XrefChain> {
    let mut pending = Vec::with_capacity(MAX_PDF_XREF_REVISIONS);
    let mut visited = HashSet::with_capacity(MAX_PDF_XREF_REVISIONS);
    let mut spans = Vec::new();
    let mut chain = XrefChain {
        encrypted: false,
        size: None,
    };
    pending.push(root);

    while let Some(offset) = pending.pop() {
        if offset >= input_len {
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

        let mut window_len = FIRST_XREF_SECTION_WINDOW_BYTES;
        let (dictionary, consumed) = loop {
            let (section, truncated) = section_at(offset, window_len)?;
            INPUT_END_REACHED.with(|reached| reached.set(false));
            let parsed = if section.starts_with(b"xref") {
                parse_classic_xref_section(&section, 0, policy)
            } else {
                parse_xref_stream_section(&section, 0, policy)
            };
            let ran_out = truncated && INPUT_END_REACHED.with(std::cell::Cell::get);
            match parsed {
                Ok(parsed) => break parsed,
                Err(_error) if ran_out && window_len < MAX_XREF_PROBE_BYTES => {
                    window_len = window_len.saturating_mul(8).min(MAX_XREF_PROBE_BYTES);
                }
                Err(_error) if ran_out => {
                    return Err(limit_error(
                        "PDF cross-reference section exceeds the structural probe ceiling",
                    ));
                }
                Err(error) => return Err(error),
            }
        };
        spans.push((offset, consumed));
        if offset == root {
            chain.size = dictionary.size;
        }
        chain.encrypted |= dictionary.has_encrypt;

        for linked in [dictionary.prev, dictionary.xref_stm].into_iter().flatten() {
            let linked = usize::try_from(linked)
                .map_err(|_| xref_error("PDF cross-reference link is too large"))?;
            if linked >= input_len {
                return Err(xref_error("PDF cross-reference link is outside the file"));
            }
            if pending.len() == MAX_PDF_XREF_REVISIONS {
                return Err(limit_error(format!(
                    "PDF cross-reference chain exceeds the {MAX_PDF_XREF_REVISIONS}-revision admission ceiling"
                )));
            }
            pending.push(linked);
        }
    }
    check_xref_spans(spans, input_len)?;
    Ok(chain)
}

/// Rejects a chain whose sections overlap or run past the input. Each section's
/// span is the bytes its parser consumed. The window a section was read through
/// may run into later sections, so the window does not count.
fn check_xref_spans(mut spans: Vec<(usize, usize)>, input_len: usize) -> Result<()> {
    spans.sort_unstable();
    let mut previous_end = 0;
    for (start, consumed) in spans {
        match start.checked_add(consumed).filter(|end| *end <= input_len) {
            Some(end) if start >= previous_end => previous_end = end,
            _ => {
                return Err(xref_error(
                    "PDF cross-reference sections overlap or exceed the input",
                ))
            }
        }
    }
    Ok(())
}

/// What a cross-reference chain says about a file without loading its body.
pub(crate) struct XrefChain {
    /// A real `/Encrypt` entry in any revision's trailer.
    pub(crate) encrypted: bool,
    /// The terminal trailer's `/Size`, one more than the highest object number.
    pub(crate) size: Option<u64>,
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
    // A direct /Length says where the section's data ends, so the span covers
    // the data and `check_xref_spans` checks it against the file. An indirect
    // /Length is not resolved here, and the span stops at the dictionary.
    let data = match bytes.get(stream_cursor.cursor..) {
        Some([b'\r', b'\n', ..]) => stream_cursor.cursor + 2,
        Some([b'\r' | b'\n', ..]) => stream_cursor.cursor + 1,
        _ => stream_cursor.cursor,
    };
    let end = match dictionary.length.filter(|_| dictionary.length_is_direct) {
        Some(length) => usize::try_from(length)
            .ok()
            .and_then(|length| data.checked_add(length))
            .ok_or_else(|| xref_error("PDF cross-reference stream data is outside the file"))?,
        None => dictionary_end,
    };
    Ok((dictionary, end.saturating_sub(offset)))
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
    // A revision's direct /DecodeParms, read here because the structural scan
    // can stop before it reaches this stream.
    let mut decode_parms: Option<(AdmissionPredictorParms, Option<AdmissionKey>)> = None;

    while let Some(token) = lexer.next_token() {
        match token {
            AdmissionToken::DictionaryStart => {
                if dictionary_depth == 1
                    && array_depth == 0
                    && dictionary
                        .pending_key
                        .take_if(|key| *key == AdmissionKey::DecodeParms)
                        .is_some()
                {
                    decode_parms = Some((AdmissionPredictorParms::default(), None));
                }
                dictionary_depth = dictionary_depth.saturating_add(1);
                enforce_structural_nesting(dictionary_depth, array_depth, policy)?;
            }
            AdmissionToken::DictionaryEnd => {
                dictionary_depth = dictionary_depth.saturating_sub(1);
                if dictionary_depth == 1 {
                    if let Some((parms, _)) = decode_parms.take() {
                        dictionary.decode_parms = Some(parms);
                    }
                }
                if dictionary_depth == 0 {
                    validate_admission_dictionary(&dictionary, policy, &mut 0)?;
                    return Ok((dictionary, offset.saturating_add(lexer.cursor)));
                }
            }
            AdmissionToken::ArrayStart if dictionary_depth == 1 => {
                array_depth = array_depth.saturating_add(1);
                enforce_structural_nesting(dictionary_depth, array_depth, policy)?;
                if let Some(key) = dictionary
                    .pending_key
                    .take()
                    .and_then(AdmissionArrayKey::from_key)
                {
                    dictionary.array = Some(AdmissionArray {
                        depth: array_depth,
                        key,
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
                        || (array.key == AdmissionArrayKey::Index && array.item_count % 2 != 0)
                    {
                        return Err(xref_error("PDF cross-reference array is invalid"));
                    }
                    match array.key {
                        AdmissionArrayKey::Index => {
                            dictionary.index_total = Some(array.range_total);
                            dictionary.largest_index_end = Some(array.largest_range_end);
                        }
                        AdmissionArrayKey::W => {
                            dictionary.width_count = Some(array.item_count);
                            dictionary.largest_width = Some(array.largest_range_end);
                        }
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
                    if array.key == AdmissionArrayKey::Index {
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
                        Some(AdmissionKey::Length) => {
                            dictionary.length = Some(value);
                            dictionary.length_is_direct = !lexer.next_is_reference();
                        }
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
            AdmissionToken::Name(name) if dictionary_depth == 2 && array_depth == 0 => {
                if let Some((_, key)) = decode_parms.as_mut() {
                    *key = admission_key(name);
                }
            }
            AdmissionToken::Integer(value) if dictionary_depth == 2 && array_depth == 0 => {
                if let Some((parms, key)) = decode_parms.as_mut() {
                    match key.take() {
                        Some(AdmissionKey::Predictor) => parms.predictor = Some(value),
                        Some(AdmissionKey::Columns) => parms.columns = Some(value),
                        Some(AdmissionKey::Colors) => parms.colors = Some(value),
                        Some(AdmissionKey::BitsPerComponent) => {
                            parms.bits_per_component = Some(value)
                        }
                        _ => {}
                    }
                }
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
    Ok(path_xref_chain(path, file_len)?.encrypted)
}

fn xref_error(message: impl Into<String>) -> Box<dyn Error> {
    domain_error(NativeErrorCode::CorruptXref, message)
}

impl AdmissionLexer<'_> {
    /// The remaining tokens of this integer value, not later dictionary entries.
    pub(super) fn next_is_reference(&self) -> bool {
        let mut value = AdmissionLexer::new(&self.bytes[self.cursor..]);
        matches!(
            (value.next_token(), value.next_token()),
            (
                Some(AdmissionToken::Integer(_)),
                Some(AdmissionToken::Keyword(b"R"))
            )
        )
    }
}
