use super::*;
use serde::Deserialize;
use std::io::Cursor;

const REVISION: &str = "test-revision";

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

fn build_index(page_count: u32, pages: &[(u32, &str)]) -> SearchIndex {
    read_index_input(
        &mut Cursor::new(index_input(pages)),
        Some(page_count),
        REVISION,
    )
    .expect("build index")
}

fn options(query: &str) -> SearchOptions {
    SearchOptions {
        query: query.to_string(),
        limit: MAX_RESULT_LIMIT,
        context_chars: 24,
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
    let corpus: SearchConformanceCorpus = serde_json::from_str(include_str!(
        "../../../packages/contracts/searchConformanceCorpus.json"
    ))
    .expect("parse search conformance corpus");

    for case in &corpus.cases {
        let case_options = case.options.as_ref();
        let mut search_options = options(&case.query);
        search_options.context_chars = case.context_chars;
        search_options.match_case = case_options
            .and_then(|value| value.match_case)
            .unwrap_or(false);
        search_options.whole_word = case_options
            .and_then(|value| value.whole_word)
            .unwrap_or(false);
        search_options.use_regex = case_options
            .and_then(|value| value.use_regex)
            .unwrap_or(false);
        let response = search_index(&build_index(1, &[(1, &case.text)]), &search_options)
            .expect("search corpus case");

        assert_eq!(
            response.results.len(),
            case.expected_matches.len(),
            "case {} result count",
            case.id,
        );
        for (actual, expected) in response.results.iter().zip(&case.expected_matches) {
            assert_eq!(
                (actual.start_offset, actual.end_offset),
                (expected.start_offset, expected.end_offset),
                "case {} offsets",
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
fn written_index_reads_back_for_its_revision_only() {
    let directory = std::env::temp_dir().join(format!("evb-pdf-search-test-{}", process::id()));
    fs::create_dir_all(&directory).expect("create test directory");
    let path = directory.join("document.pdf.evb-search-index");
    let index = build_index(4, &[(1, "first page"), (2, ""), (4, "fourth page")]);
    write_index(&index, REVISION, &path).expect("write index");

    let loaded = load_index(&path, REVISION)
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
        offsets(&search_index(&loaded, &options("page")).expect("search")),
        vec![(1, 6, 10), (4, 7, 11)],
    );
    assert!(load_index(&path, "other-revision")
        .expect("read index")
        .is_none());
    assert!(load_index(&directory.join("missing"), REVISION)
        .expect("missing index")
        .is_none());

    let mut older_format = fs::read(&path).expect("read index bytes");
    older_format[..8].copy_from_slice(b"EVBSIDX3");
    fs::write(&path, &older_format).expect("write older format");
    assert!(load_index(&path, REVISION).expect("read index").is_none());
    fs::remove_dir_all(&directory).expect("remove test directory");
}

#[test]
fn page_count_defaults_to_the_pages_received() {
    let index = read_index_input(
        &mut Cursor::new(index_input(&[(1, "a"), (2, ""), (3, "")])),
        None,
        REVISION,
    )
    .expect("build index");
    assert_eq!(index.coverage().page_count, 3);
    assert_eq!(index.coverage().pages_written, 1);
}

#[test]
fn index_input_rejects_out_of_order_pages() {
    let error = read_index_input(
        &mut Cursor::new(index_input(&[(2, "b"), (1, "a")])),
        Some(2),
        REVISION,
    )
    .expect_err("pages must increase");
    assert!(error.message.contains("out of order"));
}

#[test]
fn regex_queries_match_over_normalized_text() {
    let index = build_index(1, &[(1, "Chapter 12, chapter 7 and CHAPTER nine")]);
    let mut search_options = options(r"chapter \d+");
    search_options.use_regex = true;
    assert_eq!(
        offsets(&search_index(&index, &search_options).expect("search")),
        vec![(1, 0, 10), (1, 12, 21)],
    );
    search_options.match_case = true;
    assert_eq!(
        offsets(&search_index(&index, &search_options).expect("search")),
        vec![(1, 12, 21)],
    );
}

#[test]
fn whole_word_regex_backtracks_into_a_bounded_alternative() {
    let index = build_index(1, &[(1, "abc ab")]);
    let mut search_options = options("ab|abc");
    search_options.use_regex = true;
    search_options.whole_word = true;
    assert_eq!(
        offsets(&search_index(&index, &search_options).expect("search")),
        vec![(1, 0, 3), (1, 4, 6)],
    );
}

#[test]
fn adjacent_whole_words_share_one_boundary() {
    let index = build_index(1, &[(1, "co co,co")]);
    let mut search_options = options("co");
    search_options.whole_word = true;
    assert_eq!(
        offsets(&search_index(&index, &search_options).expect("search")),
        vec![(1, 0, 2), (1, 3, 5), (1, 6, 8)],
    );
}

#[test]
fn invalid_regex_is_an_invalid_request() {
    let mut search_options = options("(unclosed");
    search_options.use_regex = true;
    let error =
        search_index(&build_index(1, &[(1, "text")]), &search_options).expect_err("invalid regex");
    assert_eq!(error.code, NativeErrorCode::InvalidRequest);
}

#[test]
fn empty_regex_matches_are_skipped() {
    let mut search_options = options("x*");
    search_options.use_regex = true;
    assert_eq!(
        offsets(&search_index(&build_index(1, &[(1, "axxb")]), &search_options).expect("search")),
        vec![(1, 1, 3)],
    );
}

#[test]
fn page_filter_and_result_limit_bound_the_response() {
    let index = build_index(3, &[(1, "alpha"), (2, "alpha alpha"), (3, "alpha")]);
    let mut search_options = options("alpha");
    search_options.pages = Some(BTreeSet::from([2, 3]));
    assert_eq!(
        offsets(&search_index(&index, &search_options).expect("search")),
        vec![(2, 0, 5), (2, 6, 11), (3, 0, 5)],
    );
    search_options.limit = 2;
    let response = search_index(&index, &search_options).expect("search");
    assert!(response.truncated);
    assert_eq!(response.results.len(), 2);
}

#[test]
fn builds_excerpt_with_javascript_whitespace_rules() {
    let text = "\u{feff}\u{85}Needle\u{85}\u{feff}";
    let start = text.find("Needle").expect("needle");
    let end = start + "Needle".len();
    let text_map = PageTextMap::new(text);
    let excerpt = build_excerpt(
        text,
        &text_map,
        (start, end),
        (
            text_map.utf16_offset_for_byte(start),
            text_map.utf16_offset_for_byte(end),
        ),
        10,
    );
    assert_eq!(excerpt.before, "\u{85}");
    assert_eq!(excerpt.after, "\u{85}");
}
