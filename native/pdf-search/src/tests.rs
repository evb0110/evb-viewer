use super::*;
use std::io::Cursor;

const REVISION: &str = "test-revision";

fn index_input(pages: &[(u32, &str)]) -> String {
    pages
        .iter()
        .map(|(page_number, text)| {
            format!(
                "{}\n",
                serde_json::json!({"pageNumber": page_number, "text": text})
            )
        })
        .collect()
}

fn read_input(
    input: &str,
    page_count: Option<u32>,
    budget: TextBudget,
) -> Result<SearchIndex, NativeError> {
    read_index_input(&mut Cursor::new(input), page_count, REVISION, budget)
}

fn build_index(page_count: u32, pages: &[(u32, &str)]) -> SearchIndex {
    read_input(&index_input(pages), Some(page_count), TextBudget::default()).expect("build index")
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
        let mut search_options = options(case["query"].as_str().expect("query"));
        search_options.context_chars = case["contextChars"].as_u64().expect("context") as usize;
        search_options.match_case = case["options"]["matchCase"].as_bool().unwrap_or(false);
        search_options.whole_word = case["options"]["wholeWord"].as_bool().unwrap_or(false);
        search_options.use_regex = case["options"]["useRegex"].as_bool().unwrap_or(false);
        let response = search_index(
            &mut build_index(1, &[(1, case["text"].as_str().expect("text"))]),
            &search_options,
        )
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
    }
}

#[test]
fn written_index_reads_back_for_its_revision_only() {
    let directory = std::env::temp_dir().join(format!("evb-pdf-search-test-{}", process::id()));
    fs::create_dir_all(&directory).expect("create test directory");
    let path = directory.join("document.pdf.evb-search-index");
    let first_page = format!("first page{}", " padding".repeat(2048));
    let index = build_index(4, &[(1, &first_page), (2, ""), (4, "fourth page")]);
    write_index(&index, REVISION, &path).expect("write index");

    let mut loaded = load_index(&path, REVISION)
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
    assert!(load_index(&path, "other-revision")
        .expect("read index")
        .is_none());
    assert!(load_index(&directory.join("missing"), REVISION)
        .expect("missing index")
        .is_none());

    // Atomic replacement for another revision cannot retarget an admitted read.
    write_index(
        &build_index(4, &[(4, "replacement")]),
        "new-revision",
        &path,
    )
    .expect("publish replacement index");
    assert_eq!(
        offsets(&search_index(&mut loaded, &options("page")).expect("search admitted revision")),
        vec![(1, 6, 10), (4, 7, 11)],
    );
    assert!(load_index(&path, REVISION)
        .expect("old revision is stale")
        .is_none());
    assert_eq!(
        offsets(
            &search_index(
                &mut load_index(&path, "new-revision").unwrap().unwrap(),
                &options("replacement")
            )
            .unwrap()
        ),
        vec![(4, 0, 11)],
    );
    write_index(&index, REVISION, &path).expect("restore original index");

    let mut older_format = fs::read(&path).expect("read index bytes");
    older_format[..8].copy_from_slice(b"EVBSIDX3");
    fs::write(&path, &older_format).expect("write older format");
    assert!(load_index(&path, REVISION).expect("read index").is_none());
    fs::remove_dir_all(&directory).expect("remove test directory");
}

fn index_bytes(index: &SearchIndex, name: &str) -> Vec<u8> {
    let directory = std::env::temp_dir().join(format!("evb-pdf-search-{name}-{}", process::id()));
    fs::create_dir_all(&directory).expect("create test directory");
    let path = directory.join("document.pdf.evb-search-index");
    write_index(index, REVISION, &path).expect("write index");
    let bytes = fs::read(&path).expect("read index bytes");
    fs::remove_dir_all(&directory).expect("remove test directory");
    bytes
}

#[test]
fn treats_a_header_claiming_an_impossible_record_table_as_stale() {
    let valid = index_bytes(
        &build_index(4, &[(1, "first page"), (3, "third page")]),
        "header",
    );
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
    let index = read_input(
        &index_input(&[(1, "a"), (2, ""), (3, "")]),
        None,
        TextBudget::default(),
    )
    .expect("build index");
    assert_eq!(index.coverage().page_count, 3);
    assert_eq!(index.coverage().pages_written, 1);
}

#[test]
fn index_input_rejects_out_of_order_pages() {
    let error = read_input(
        &index_input(&[(2, "b"), (1, "a")]),
        Some(2),
        TextBudget::default(),
    )
    .expect_err("pages must increase");
    assert!(error.message.contains("out of order"));
}

#[test]
fn a_page_over_the_budget_ends_the_index_as_truncated() {
    let budget = TextBudget { page: 8, total: 10 };
    let read = |input: &str| {
        read_input(input, Some(5), budget)
            .expect("build index")
            .coverage()
    };
    for input in [
        // Producer report, over-page-budget text, and over-total-budget text.
        format!(
            "{}{{\"pageNumber\":2,\"overBudget\":true}}\n",
            index_input(&[(1, "first")])
        ),
        index_input(&[(1, "first"), (2, "nine char"), (3, "x")]),
        index_input(&[(1, "first"), (2, "second"), (3, "x")]),
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
fn an_input_page_needs_text_or_an_over_budget_report() {
    for line in [
        "{\"pageNumber\":1}\n",
        "{\"pageNumber\":1,\"text\":\"a\",\"overBudget\":true}\n",
        "{\"pageNumber\":1,\"overBudget\":false}\n",
        // The over-budget report is the producer's last line.
        "{\"pageNumber\":1,\"overBudget\":true}\n{\"pageNumber\":2,\"text\":\"a\"}\n",
    ] {
        let error = read_input(line, None, TextBudget::default()).expect_err("ambiguous page line");
        assert_eq!(error.code, NativeErrorCode::InvalidRequest, "{line}");
    }
}

#[test]
fn a_caller_budget_must_stay_within_the_ceilings() {
    let budget = |raw: &str| {
        CliArgs::parse(["--max-page-text-bytes".to_string(), raw.to_string()].into_iter())
            .expect("parse")
            .byte_budget("--max-page-text-bytes", MAX_PAGE_TEXT_BYTES)
    };
    assert_eq!(budget("8388608").expect("in range"), 8 * 1024 * 1024);
    for refused in ["0", "33554433"] {
        assert_eq!(
            budget(refused).expect_err("out of range").code,
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
    let directory =
        std::env::temp_dir().join(format!("evb-pdf-search-chunks-test-{}", process::id()));
    fs::create_dir_all(&directory).expect("create test directory");
    let path = directory.join("document.pdf.evb-search-index");
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
    write_index(&build_index(7, &pages), REVISION, &path).expect("write index");
    let mut loaded = load_index(&path, REVISION).unwrap().unwrap();
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
    fs::remove_dir_all(&directory).expect("remove test directory");
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
fn searching_written_pages_refuses_a_regex_before_reading_them() {
    struct PanicReader;

    impl Read for PanicReader {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            panic!("stdin must not be read when --regex is rejected");
        }
    }

    impl BufRead for PanicReader {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            panic!("stdin must not be read when --regex is rejected");
        }

        fn consume(&mut self, _amt: usize) {}
    }

    let error = run_cli_with_stdin(
        [
            "search",
            "--pages-from-stdin",
            "--document-revision",
            REVISION,
            "--query",
            "[A-Z]+B|",
            "--regex",
        ]
        .into_iter()
        .map(String::from),
        PanicReader,
    )
    .expect_err("a regex over written pages is refused");
    let error = error.downcast_ref::<NativeError>().expect("a native error");
    assert_eq!(error.code, NativeErrorCode::InvalidRequest);
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

    let directory =
        std::env::temp_dir().join(format!("evb-pdf-search-sparse-test-{}", process::id()));
    fs::create_dir_all(&directory).expect("create test directory");
    let path = directory.join("document.pdf.evb-search-index");
    let skipped = format!("{}unselected", "y".repeat(16 * 1024));
    let built = build_index(
        3,
        &[(1, "alpha needle"), (2, &skipped), (3, "omega needle")],
    );
    write_index(&built, REVISION, &path).expect("write index");
    let raw = fs::read(&path).expect("read index bytes");
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

    fs::remove_dir_all(&directory).expect("remove test directory");
}
