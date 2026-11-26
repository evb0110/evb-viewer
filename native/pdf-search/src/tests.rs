use super::*;
use std::io::Cursor;

const REVISION: &str = "test-revision";

fn push_page_record(buf: &mut Vec<u8>, page_number: u32, text: Option<&str>) {
    buf.extend_from_slice(&page_number.to_le_bytes());
    match text {
        Some(text) => {
            buf.extend_from_slice(&PAGE_RECORD_FLAG_TEXT.to_le_bytes());
            buf.extend_from_slice(&(text.len() as u32).to_le_bytes());
            buf.extend_from_slice(text.as_bytes());
        }
        None => {
            buf.extend_from_slice(&PAGE_RECORD_FLAG_OVER_BUDGET.to_le_bytes());
            buf.extend_from_slice(&0u32.to_le_bytes());
        }
    }
}

fn encode_pages(pages: &[(u32, &str)]) -> Vec<u8> {
    let mut buf = Vec::new();
    for &(page_number, text) in pages {
        push_page_record(&mut buf, page_number, Some(text));
    }
    buf
}

fn encode_request(header: &serde_json::Value, payload: &[u8]) -> Vec<u8> {
    let header_bytes = serde_json::to_vec(header).expect("serialize header");
    let mut request = Vec::with_capacity(REQUEST_PREFIX_SIZE + header_bytes.len() + payload.len());
    request.extend_from_slice(REQUEST_MAGIC);
    request.extend_from_slice(&REQUEST_VERSION.to_le_bytes());
    request.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    request.extend_from_slice(&header_bytes);
    request.extend_from_slice(payload);
    request
}

fn build_index(page_count: u32, pages: &[(u32, &str)]) -> SearchIndex {
    read_binary_pages(
        &encode_pages(pages),
        Some(page_count),
        REVISION,
        TextBudget::default(),
    )
    .expect("build index")
}

fn options(query: &str) -> SearchOptions {
    SearchOptions {
        query: query.to_string(),
        limit: MAX_RESULT_LIMIT,
        context_chars: 24,
        result_offset: Some(0),
        match_case: false,
        whole_word: false,
        use_regex: false,
        pages: None,
    }
}

fn offsets(response: &SearchResponse) -> Vec<(u32, usize, usize)> {
    response
        .results
        .iter()
        .map(|result| (result.page_number, result.start_offset, result.end_offset))
        .collect()
}

#[test]
fn matches_the_shared_conformance_corpus() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/contracts/searchConformanceCorpus.json"
    ))
    .expect("parse search conformance corpus");
    for case in corpus["cases"].as_array().expect("corpus cases") {
        let text = case["text"].as_str().expect("text");
        let query = case["query"].as_str().expect("query");
        let match_case = case["options"]["matchCase"].as_bool().unwrap_or(false);
        let whole_word = case["options"]["wholeWord"].as_bool().unwrap_or(false);
        let use_regex = case["options"]["useRegex"].as_bool().unwrap_or(false);
        let mut search_options = options(query);
        search_options.context_chars = case["contextChars"].as_u64().expect("context") as usize;
        search_options.match_case = match_case;
        search_options.whole_word = whole_word;
        search_options.use_regex = use_regex;
        let response = search_index(&mut build_index(1, &[(1, text)]), &search_options)
            .expect("search corpus case");
        let actual: Vec<_> = response
            .results
            .iter()
            .map(|result| {
                serde_json::json!({
                    "startOffset": result.start_offset,
                    "endOffset": result.end_offset,
                    "excerpt": result.excerpt,
                })
            })
            .collect();
        assert_eq!(
            serde_json::json!(actual),
            case["expectedMatches"],
            "case {}",
            case["id"]
        );

        let page_window = match_page_window(
            text,
            query,
            match_case,
            whole_word,
            use_regex,
            MAX_RESULT_LIMIT,
            Some(0),
        )
        .expect("match_page_window corpus case");
        let expected_ranges: Vec<_> = response
            .results
            .iter()
            .map(|r| (r.page_match_index, r.start_offset, r.end_offset))
            .collect();
        let actual_ranges: Vec<_> = page_window
            .matches
            .iter()
            .map(|m| (m.page_match_index, m.start_offset, m.end_offset))
            .collect();
        assert_eq!(
            actual_ranges, expected_ranges,
            "matchPage case {}",
            case["id"]
        );
        assert_eq!(page_window.match_count, expected_ranges.len());
        assert!(!page_window.truncated);
    }
}

#[test]
fn serialized_index_reads_back_for_its_revision_only() {
    let first_page = format!("first page{}", " padding".repeat(2048));
    let index = build_index(4, &[(1, &first_page), (2, ""), (4, "fourth page")]);
    let bytes = serialize_index(&index, REVISION).expect("serialize index");

    let mut loaded = load_index_bytes(&bytes, REVISION)
        .expect("read index")
        .expect("index is current");
    assert_eq!(
        loaded.coverage(),
        Coverage {
            page_count: 4,
            pages_scanned: 4,
            pages_written: 2,
            truncated: false,
            missing_text_page_sample: vec![2, 3],
        }
    );
    assert_eq!(
        offsets(&search_index(&mut loaded, &options("page")).expect("search")),
        vec![(1, 6, 10), (4, 7, 11)],
    );
    assert!(load_index_bytes(&bytes, "other-revision")
        .expect("read index")
        .is_none());
    assert!(load_index_bytes(&[], REVISION)
        .expect("empty index is stale")
        .is_none());

    let mut older_format = bytes.clone();
    older_format[..8].copy_from_slice(b"EVBSIDX3");
    assert!(load_index_bytes(&older_format, REVISION)
        .expect("older format is stale")
        .is_none());
}

#[test]
fn treats_a_header_claiming_an_impossible_record_table_as_stale() {
    let valid = serialize_index(
        &build_index(4, &[(1, "first page"), (3, "third page")]),
        REVISION,
    )
    .expect("serialize index");
    let admitted = |bytes: &[u8]| {
        parse_index(Cursor::new(bytes), bytes.len(), REVISION)
            .unwrap()
            .is_some()
    };
    assert!(admitted(&valid));
    for (length, field) in [
        // A header claiming every possible record, without a table behind it.
        (HEADER_SIZE + REVISION.len(), Some((24, u32::MAX))),
        // More records than scanned pages, with real table/text bytes.
        (valid.len(), Some((12, 1))),
        // Text extent cannot escape the admitted file, including on 32-bit hosts.
        (
            valid.len(),
            Some((HEADER_SIZE + REVISION.len() + 4, u32::MAX)),
        ),
        // Text cut off after an otherwise valid table.
        (valid.len() - 3, None),
    ] {
        let mut malformed = valid[..length].to_vec();
        if let Some((offset, value)) = field {
            malformed[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        assert!(!admitted(&malformed), "length {length}, field {field:?}");
    }
}

#[test]
fn page_count_defaults_to_the_pages_received() {
    let index = read_binary_pages(
        &encode_pages(&[(1, "a"), (2, ""), (3, "")]),
        None,
        REVISION,
        TextBudget::default(),
    )
    .expect("build index");
    assert_eq!(index.coverage().page_count, 3);
    assert_eq!(index.coverage().pages_written, 1);
}

#[test]
fn index_input_rejects_out_of_order_pages() {
    let error = read_binary_pages(
        &encode_pages(&[(2, "b"), (1, "a")]),
        Some(2),
        REVISION,
        TextBudget::default(),
    )
    .expect_err("pages must increase");
    assert!(error.message.contains("out of order"));
}

#[test]
fn a_page_over_the_budget_ends_the_index_as_truncated() {
    let budget = TextBudget { page: 8, total: 10 };
    let read = |payload: &[u8]| {
        read_binary_pages(payload, Some(5), REVISION, budget)
            .expect("build index")
            .coverage()
    };
    let mut reported = Vec::new();
    push_page_record(&mut reported, 1, Some("first"));
    push_page_record(&mut reported, 2, None);

    for input in [
        reported,
        encode_pages(&[(1, "first"), (2, "nine char"), (3, "x")]),
        encode_pages(&[(1, "first"), (2, "second"), (3, "x")]),
    ] {
        assert_eq!(
            read(&input),
            Coverage {
                page_count: 5,
                pages_scanned: 1,
                pages_written: 1,
                truncated: true,
                missing_text_page_sample: vec![],
            }
        );
    }
}

#[test]
fn an_input_page_rejects_malformed_over_budget_records() {
    // overBudget with non-empty text
    let mut non_empty_over_budget = Vec::new();
    non_empty_over_budget.extend_from_slice(&1u32.to_le_bytes());
    non_empty_over_budget.extend_from_slice(&PAGE_RECORD_FLAG_OVER_BUDGET.to_le_bytes());
    non_empty_over_budget.extend_from_slice(&1u32.to_le_bytes());
    non_empty_over_budget.push(b'a');

    // Page following overBudget
    let mut trailing_after_over_budget = Vec::new();
    push_page_record(&mut trailing_after_over_budget, 1, None);
    push_page_record(&mut trailing_after_over_budget, 2, Some("a"));

    // Unknown flags
    let mut unknown_flags = Vec::new();
    unknown_flags.extend_from_slice(&1u32.to_le_bytes());
    unknown_flags.extend_from_slice(&2u32.to_le_bytes());
    unknown_flags.extend_from_slice(&0u32.to_le_bytes());

    // Truncated header
    let truncated_header = vec![1, 0, 0, 0];

    for payload in [
        non_empty_over_budget,
        trailing_after_over_budget,
        unknown_flags,
        truncated_header,
    ] {
        let error = read_binary_pages(&payload, None, REVISION, TextBudget::default())
            .expect_err("malformed page record");
        assert_eq!(error.code, NativeErrorCode::InvalidRequest);
    }
}

#[test]
fn a_caller_budget_must_stay_within_the_ceilings() {
    assert_eq!(
        TextBudget::validated(Some(8 * 1024 * 1024), None)
            .expect("in range")
            .page,
        8 * 1024 * 1024
    );
    for refused in [0, MAX_PAGE_TEXT_BYTES + 1] {
        assert_eq!(
            TextBudget::validated(Some(refused), None)
                .expect_err("out of range")
                .code,
            NativeErrorCode::TooLarge
        );
    }
    for refused in [0, MAX_TOTAL_TEXT_BYTES + 1] {
        assert_eq!(
            TextBudget::validated(None, Some(refused))
                .expect_err("out of range")
                .code,
            NativeErrorCode::TooLarge
        );
    }
}

#[test]
fn regex_queries_match_over_normalized_text() {
    let mut index = build_index(1, &[(1, "Chapter 12, chapter 7 and CHAPTER nine")]);
    let mut search_options = options(r"chapter \d+");
    search_options.use_regex = true;
    assert_eq!(
        offsets(&search_index(&mut index, &search_options).expect("search")),
        vec![(1, 0, 10), (1, 12, 21)],
    );
    search_options.match_case = true;
    assert_eq!(
        offsets(&search_index(&mut index, &search_options).expect("search")),
        vec![(1, 12, 21)],
    );
}

#[test]
fn whole_words_preserve_long_s_alternatives_and_adjacent_boundaries() {
    for (text, query, regex, expected) in [
        (
            "Baptiſtæ venerit feſtum",
            "festum",
            false,
            vec![(1, 17, 23)],
        ),
        ("abc ab", "ab|abc", true, vec![(1, 0, 3), (1, 4, 6)]),
        (
            "co co,co",
            "co",
            false,
            vec![(1, 0, 2), (1, 3, 5), (1, 6, 8)],
        ),
    ] {
        let mut search_options = options(query);
        search_options.use_regex = regex;
        search_options.whole_word = true;
        let response = search_index(&mut build_index(1, &[(1, text)]), &search_options)
            .expect("search whole words");
        assert_eq!(offsets(&response), expected, "query {query} on {text}");
    }
}

#[test]
fn invalid_regex_is_an_invalid_request() {
    let mut search_options = options("(unclosed");
    search_options.use_regex = true;
    let error = search_index(&mut build_index(1, &[(1, "text")]), &search_options)
        .expect_err("invalid regex");
    assert_eq!(error.code, NativeErrorCode::InvalidRequest);
}

#[test]
fn empty_regex_matches_are_skipped() {
    let mut search_options = options("x*");
    search_options.use_regex = true;
    assert_eq!(
        offsets(
            &search_index(&mut build_index(1, &[(1, "axxb")]), &search_options).expect("search")
        ),
        vec![(1, 1, 3)],
    );
}

#[test]
fn page_filter_and_result_limit_bound_the_response() {
    let mut index = build_index(3, &[(1, "alpha"), (2, "alpha alpha"), (3, "alpha")]);
    let mut search_options = options("alpha");
    search_options.pages = Some(BTreeSet::from([2, 3]));
    assert_eq!(
        offsets(&search_index(&mut index, &search_options).expect("search")),
        vec![(2, 0, 5), (2, 6, 11), (3, 0, 5)],
    );
    search_options.limit = 2;
    let response = search_index(&mut index, &search_options).expect("search");
    assert!(response.truncated);
    assert_eq!(response.results.len(), 2);
}

#[test]
fn builds_excerpt_with_javascript_whitespace_rules() {
    let response = search_index(
        &mut build_index(1, &[(1, "\u{feff}\u{85}Needle\u{85}\u{feff}")]),
        &options("Needle"),
    )
    .expect("search whitespace excerpt");
    assert_eq!(response.results.len(), 1);
    assert_eq!(response.results[0].excerpt.before, "\u{85}");
    assert_eq!(response.results[0].excerpt.after, "\u{85}");
}

#[test]
fn context_keeps_the_original_utf16_surrogate_boundary_rules() {
    let mut search_options = options("x");
    search_options.context_chars = 1;
    let response = search_index(&mut build_index(1, &[(1, "😀x😀")]), &search_options)
        .expect("search surrogate context");
    assert_eq!(offsets(&response), vec![(1, 2, 3)]);
    assert_eq!(
        response.results[0].excerpt,
        SearchExcerpt {
            prefix: true,
            suffix: true,
            before: "😀".to_string(),
            matched_text: "x".to_string(),
            after: String::new(),
        }
    );
}

#[test]
fn repeated_ligature_ranges_keep_original_offsets_and_snippets() {
    let mut search_options = options("(?:f|é|각)");
    search_options.use_regex = true;
    search_options.context_chars = 1;
    let response = search_index(
        &mut build_index(1, &[(1, "😀 ﬃ e\u{301} 각 ﬃ!")]),
        &search_options,
    )
    .expect("search changed and unchanged spans");
    let expected = [
        (3, 4, "ﬃ"),
        (3, 4, "ﬃ"),
        (5, 7, "e\u{301}"),
        (8, 11, "각"),
        (12, 13, "ﬃ"),
        (12, 13, "ﬃ"),
    ];
    assert_eq!(response.results.len(), expected.len());
    for (index, (result, (start, end, matched))) in
        response.results.iter().zip(expected).enumerate()
    {
        assert_eq!(
            (result.page_number, result.start_offset, result.end_offset),
            (1, start, end)
        );
        assert_eq!(
            (result.match_index, result.page_match_index),
            (index, index)
        );
        assert_eq!(
            serde_json::to_value(&result.excerpt).unwrap(),
            serde_json::json!({
                "prefix": true, "suffix": index < 4, "before": "", "match": matched,
                "after": if index < 4 { "" } else { "!" },
            })
        );
    }
}

#[test]
fn traverses_bounded_windows_within_a_page_and_across_pages() {
    let dense = "valve ".repeat(560);
    let mut index = build_index(80, &[(1, &dense), (64, "valve later"), (80, "valve final")]);
    let mut query = options("valve");
    let first = search_index(&mut index, &query).unwrap();
    assert_eq!(first.results.len(), 500);
    assert!(first.truncated);
    query.result_offset = Some(500);
    let next = search_index(&mut index, &query).unwrap();
    assert_eq!(next.results.len(), 62);
    assert!(!next.truncated);
    assert_eq!(
        (
            next.results[0].match_index,
            next.results[0].page_match_index
        ),
        (500, 500)
    );
    assert_eq!(next.results.last().unwrap().page_number, 80);
    assert_eq!(next.coverage, first.coverage);
    query.result_offset = None;
    let last = search_index(&mut index, &query).unwrap();
    assert_eq!(last.results.len(), 500);
    assert_eq!(last.results[0].match_index, 62);
    assert_eq!(last.results.last().unwrap().match_index, 561);
    assert!(!last.truncated);
    assert_eq!(last.coverage, first.coverage);
    query.result_offset = Some(562);
    assert!(search_index(&mut index, &query).unwrap().results.is_empty());
}

#[test]
fn match_page_window_supports_offsets_and_tail_window() {
    let dense = "valve ".repeat(560);
    let first = match_page_window(&dense, "valve", false, false, false, 500, Some(0)).unwrap();
    assert_eq!(first.matches.len(), 500);
    assert!(first.truncated);
    assert_eq!(first.match_count, 501);

    let next = match_page_window(&dense, "valve", false, false, false, 500, Some(500)).unwrap();
    assert_eq!(next.matches.len(), 60);
    assert!(!next.truncated);
    assert_eq!(next.match_count, 560);
    assert_eq!(next.matches[0].page_match_index, 500);
    assert_eq!(next.matches.last().unwrap().page_match_index, 559);

    let tail = match_page_window(&dense, "valve", false, false, false, 500, None).unwrap();
    assert_eq!(tail.matches.len(), 500);
    assert!(!tail.truncated);
    assert_eq!(tail.match_count, 560);
    assert_eq!(tail.matches[0].page_match_index, 60);
    assert_eq!(tail.matches.last().unwrap().page_match_index, 559);
}

#[test]
fn stable_starters_take_the_quick_check_answer() {
    for character in (0..=0x10ffff).filter_map(char::from_u32) {
        if is_stable_starter(character) {
            assert_eq!(canonical_combining_class(character), 0, "{character:?}");
            assert_eq!(
                is_nfc_quick(std::iter::once(character)),
                IsNormalized::Yes,
                "{character:?}"
            );
            assert!(fold_search_ligature(character).is_none(), "{character:?}");
        }
    }
    let alphabet = [
        "a", "é", "e\u{301}", "\u{316}", "\u{301}", "\u{17f}", "\u{fb01}", "\u{2019}", "\u{2018}",
        "\u{5d0}", "\u{5b8}", "\u{fb2a}", "\u{627}", "\u{654}", "\u{ac00}", "\u{11a8}", "\u{1100}",
        "\u{1161}", "\u{304b}", "\u{3099}", "\u{4e00}", "\u{2126}", "\u{2000}", "\u{438}",
        "\u{306}", "\u{3a9}", "\u{344}", " ",
    ];
    for first in alphabet {
        for second in alphabet {
            for third in alphabet {
                let text = format!("{first}{second}{third}");
                let reference = is_nfc_quick(text.chars()) == IsNormalized::Yes
                    && text
                        .chars()
                        .all(|character| fold_search_ligature(character).is_none());
                assert_eq!(is_search_normalized(&text), reference, "{text:?}");
            }
        }
    }
}

#[test]
fn reads_page_text_in_chunks_across_their_boundaries() {
    let page = |padding: usize| format!("{}marker é", "x".repeat(padding));
    let texts = [
        page(0),
        page(READ_CHUNK_BYTES + 3),
        page(5),
        page(READ_CHUNK_BYTES - 40),
        page(READ_CHUNK_BYTES / 2),
        page(1),
    ];
    let pages: Vec<(u32, &str)> = (1..)
        .zip(&texts)
        .map(|(page_number, text)| (page_number, text.as_str()))
        .collect();
    let bytes = serialize_index(&build_index(7, &pages), REVISION).expect("serialize index");
    let mut loaded = load_index_bytes(&bytes, REVISION).unwrap().unwrap();
    let expected: Vec<_> = (1..)
        .zip(&texts)
        .map(|(page_number, text)| (page_number, text.len() - 9, text.len() - 3))
        .collect();
    assert_eq!(
        offsets(&search_index(&mut loaded, &options("marker")).unwrap()),
        expected
    );
    for filter in [vec![2, 6], vec![1, 4], vec![3, 5, 7]] {
        let mut query = options("marker");
        query.pages = Some(filter.iter().copied().collect());
        assert_eq!(
            offsets(&search_index(&mut loaded, &query).unwrap()),
            expected
                .iter()
                .copied()
                .filter(|(page_number, ..)| filter.contains(page_number))
                .collect::<Vec<_>>(),
            "pages {filter:?}"
        );
    }
    let excerpt = &search_index(&mut loaded, &options("é")).unwrap().results[1].excerpt;
    assert_eq!(
        (
            excerpt.prefix,
            excerpt.before.as_str(),
            excerpt.after.as_str()
        ),
        (true, format!("{}marker ", "x".repeat(17)).as_str(), "")
    );
}

#[test]
fn a_leading_space_query_crosses_long_blank_layout_runs() {
    let blank = " ".repeat(1024 * 1024);
    let text = format!("{blank}x needle");
    let mut index = build_index(1, &[(1, &text)]);
    assert_eq!(
        offsets(&search_index(&mut index, &options(" needle")).unwrap()),
        vec![(1, blank.len() + 1, blank.len() + 8)]
    );
}

#[test]
fn sparse_page_filter_does_not_read_unselected_intermediate_pages() {
    struct SpyReader {
        inner: Cursor<Vec<u8>>,
        bytes_read: usize,
        read_calls: usize,
    }

    impl Read for SpyReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let count = self.inner.read(buf)?;
            self.read_calls += 1;
            self.bytes_read += count;
            Ok(count)
        }
    }

    impl Seek for SpyReader {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            self.inner.seek(pos)
        }
    }

    let skipped = format!("{}unselected", "y".repeat(16 * 1024));
    let raw = serialize_index(
        &build_index(
            3,
            &[(1, "alpha needle"), (2, &skipped), (3, "omega needle")],
        ),
        REVISION,
    )
    .expect("serialize index");
    let len = raw.len();
    let mut index = parse_index(
        SpyReader {
            inner: Cursor::new(raw),
            bytes_read: 0,
            read_calls: 0,
        },
        len,
        REVISION,
    )
    .expect("parse index")
    .expect("index not stale");

    index.data.bytes_read = 0;
    index.data.read_calls = 0;
    let mut query = options("needle");
    query.pages = Some([1, 3].into_iter().collect());
    assert_eq!(
        offsets(&search_index(&mut index, &query).unwrap()),
        vec![(1, 6, 12), (3, 6, 12)]
    );
    assert_eq!(index.data.read_calls, 4);
    assert!(index.data.bytes_read < 128);

    index.data.bytes_read = 0;
    index.data.read_calls = 0;
    let mut consecutive = options("needle");
    consecutive.pages = Some([2, 3].into_iter().collect());
    assert_eq!(
        offsets(&search_index(&mut index, &consecutive).unwrap()),
        vec![(3, 6, 12)]
    );
    assert_eq!(index.data.read_calls, 2);
}

#[test]
fn wasm_request_round_trips_index_stat_search_provisional_and_match_page() {
    let pages_payload = encode_pages(&[(1, "alpha needle"), (2, ""), (3, "omega needle")]);
    let index_req = encode_request(
        &serde_json::json!({
            "op": "index",
            "documentRevision": REVISION,
            "pageCount": 3,
        }),
        &pages_payload,
    );
    let index_out = handle_wasm_request(&index_req).expect("index op");
    let cov_len = u32::from_le_bytes(index_out[0..4].try_into().unwrap()) as usize;
    let coverage: serde_json::Value =
        serde_json::from_slice(&index_out[4..4 + cov_len]).expect("coverage json");
    assert_eq!(
        coverage,
        serde_json::json!({
            "pageCount": 3,
            "pagesScanned": 3,
            "pagesWritten": 2,
            "truncated": false,
            "missingTextPageSample": [2],
        })
    );
    let index_bytes = &index_out[4 + cov_len..];

    let stat_req = encode_request(
        &serde_json::json!({
            "op": "stat",
            "documentRevision": REVISION,
        }),
        index_bytes,
    );
    let stat_out: serde_json::Value =
        serde_json::from_slice(&handle_wasm_request(&stat_req).unwrap()).unwrap();
    assert_eq!(stat_out, coverage);

    let stale_stat_req = encode_request(
        &serde_json::json!({
            "op": "stat",
            "documentRevision": "other-rev",
        }),
        index_bytes,
    );
    let stale_out: serde_json::Value =
        serde_json::from_slice(&handle_wasm_request(&stale_stat_req).unwrap()).unwrap();
    assert_eq!(stale_out, serde_json::json!({ "stale": true }));

    let search_req = encode_request(
        &serde_json::json!({
            "op": "search",
            "documentRevision": REVISION,
            "query": "needle",
            "limit": 500,
            "contextChars": 24,
            "resultOffset": 0,
        }),
        index_bytes,
    );
    let search_out: serde_json::Value =
        serde_json::from_slice(&handle_wasm_request(&search_req).unwrap()).unwrap();
    assert_eq!(search_out["results"].as_array().unwrap().len(), 2);
    assert_eq!(search_out["truncated"], false);

    // Provisional search refuses regex when allowRegex is false.
    let provisional_regex = encode_request(
        &serde_json::json!({
            "op": "searchPages",
            "documentRevision": REVISION,
            "query": "[A-Z]+B|",
            "useRegex": true,
            "allowRegex": false,
        }),
        &pages_payload,
    );
    let err = handle_wasm_request(&provisional_regex).expect_err("refuse provisional regex");
    assert_eq!(err.code, NativeErrorCode::InvalidRequest);

    // MatchPage op
    let match_req = encode_request(
        &serde_json::json!({
            "op": "matchPage",
            "query": "needle",
            "maxMatches": 501,
            "resultOffset": "last",
        }),
        b"alpha needle beta needle",
    );
    let match_out: serde_json::Value =
        serde_json::from_slice(&handle_wasm_request(&match_req).unwrap()).unwrap();
    assert_eq!(match_out["matchCount"], 2);
    assert_eq!(match_out["truncated"], false);
    assert_eq!(match_out["matches"].as_array().unwrap().len(), 2);
}
