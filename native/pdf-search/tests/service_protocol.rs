use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const HEADER_SIZE: usize = 64;
const PAGE_RECORD_SIZE: usize = 24;
const STREAMING_HEADER_SIZE: usize = 64;
const STREAMING_FOOTER_SIZE: usize = 64;
const STREAMING_DIRECTORY_ENTRY_SIZE: usize = 24;
const REVISION: &str = "service-test-revision";
const MAX_SERVICE_FRAME_BYTES: usize = 4 * 1024 * 1024;

fn write_index(path: &Path, text: &str) {
    let revision = REVISION.as_bytes();
    let page_table_offset = HEADER_SIZE + revision.len();
    let text_offset = page_table_offset + PAGE_RECORD_SIZE;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"EVBSIDX2");
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&(revision.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(HEADER_SIZE as u64).to_le_bytes());
    bytes.extend_from_slice(&(page_table_offset as u64).to_le_bytes());
    bytes.extend_from_slice(&(text_offset as u64).to_le_bytes());
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes.extend_from_slice(revision);
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&(text_offset as u64).to_le_bytes());
    bytes.extend_from_slice(&(text.len() as u64).to_le_bytes());
    bytes.extend_from_slice(text.as_bytes());
    fs::write(path, bytes).expect("write search service index");
}

fn write_sparse_multi_page_index(path: &Path, page_count: u32, page_bytes: usize) {
    let revision = REVISION.as_bytes();
    let page_table_offset = HEADER_SIZE + revision.len();
    let text_offset = page_table_offset + (page_count as usize * PAGE_RECORD_SIZE);
    let mut file = File::create(path).expect("create sparse search service index");
    file.write_all(b"EVBSIDX2").unwrap();
    file.write_all(&2u32.to_le_bytes()).unwrap();
    file.write_all(&(HEADER_SIZE as u32).to_le_bytes()).unwrap();
    file.write_all(&page_count.to_le_bytes()).unwrap();
    file.write_all(&page_count.to_le_bytes()).unwrap();
    file.write_all(&0u32.to_le_bytes()).unwrap();
    file.write_all(&(revision.len() as u32).to_le_bytes())
        .unwrap();
    file.write_all(&(HEADER_SIZE as u64).to_le_bytes()).unwrap();
    file.write_all(&(page_table_offset as u64).to_le_bytes())
        .unwrap();
    file.write_all(&(text_offset as u64).to_le_bytes()).unwrap();
    file.write_all(&0u64.to_le_bytes()).unwrap();
    file.write_all(revision).unwrap();
    for page_index in 0..page_count {
        let byte_offset = text_offset + page_index as usize * page_bytes;
        file.write_all(&(page_index + 1).to_le_bytes()).unwrap();
        file.write_all(&0u32.to_le_bytes()).unwrap();
        file.write_all(&(byte_offset as u64).to_le_bytes()).unwrap();
        file.write_all(&(page_bytes as u64).to_le_bytes()).unwrap();
    }
    file.set_len((text_offset + page_count as usize * page_bytes) as u64)
        .expect("size sparse search service index");
}

fn write_sparse_index(path: &Path, page_count: u32, pages: &[(u32, &str)]) {
    let revision = REVISION.as_bytes();
    let page_table_offset = HEADER_SIZE + revision.len();
    let text_data_offset = page_table_offset + pages.len() * PAGE_RECORD_SIZE;
    let mut file = File::create(path).expect("create sparse search service index");
    file.write_all(b"EVBSIDX2").unwrap();
    file.write_all(&2u32.to_le_bytes()).unwrap();
    file.write_all(&(HEADER_SIZE as u32).to_le_bytes()).unwrap();
    file.write_all(&page_count.to_le_bytes()).unwrap();
    file.write_all(&(pages.len() as u32).to_le_bytes()).unwrap();
    file.write_all(&0u32.to_le_bytes()).unwrap();
    file.write_all(&(revision.len() as u32).to_le_bytes())
        .unwrap();
    file.write_all(&(HEADER_SIZE as u64).to_le_bytes()).unwrap();
    file.write_all(&(page_table_offset as u64).to_le_bytes())
        .unwrap();
    file.write_all(&(text_data_offset as u64).to_le_bytes())
        .unwrap();
    file.write_all(&0u64.to_le_bytes()).unwrap();
    file.write_all(revision).unwrap();

    let mut text_offset = text_data_offset as u64;
    for (page_number, text) in pages {
        file.write_all(&page_number.to_le_bytes()).unwrap();
        file.write_all(&0u32.to_le_bytes()).unwrap();
        file.write_all(&text_offset.to_le_bytes()).unwrap();
        file.write_all(&(text.len() as u64).to_le_bytes()).unwrap();
        text_offset += text.len() as u64;
    }
    for (_, text) in pages {
        file.write_all(text.as_bytes()).unwrap();
    }
}

fn write_streaming_sparse_index(path: &Path, page_count: u32, pages: &[(u32, &str)]) {
    let revision = REVISION.as_bytes();
    let directory_offset = STREAMING_HEADER_SIZE + revision.len();
    let directory_length = page_count as usize * STREAMING_DIRECTORY_ENTRY_SIZE;
    let text_data_offset = directory_offset + directory_length;
    let text_bytes = pages.iter().map(|(_, text)| text.len()).sum::<usize>();
    let footer_offset = text_data_offset + text_bytes;
    let mut file = File::create(path).expect("create streaming search service index");
    file.set_len((footer_offset + STREAMING_FOOTER_SIZE) as u64)
        .expect("size streaming search service index");

    file.write_all(b"EVBSIDX3").unwrap();
    file.write_all(&3u32.to_le_bytes()).unwrap();
    file.write_all(&(STREAMING_HEADER_SIZE as u32).to_le_bytes())
        .unwrap();
    file.write_all(&page_count.to_le_bytes()).unwrap();
    file.write_all(&(pages.len() as u32).to_le_bytes()).unwrap();
    file.write_all(&1u32.to_le_bytes()).unwrap();
    file.write_all(&(revision.len() as u32).to_le_bytes())
        .unwrap();
    file.write_all(&(STREAMING_HEADER_SIZE as u64).to_le_bytes())
        .unwrap();
    file.write_all(&(directory_offset as u64).to_le_bytes())
        .unwrap();
    file.write_all(&(text_data_offset as u64).to_le_bytes())
        .unwrap();
    file.write_all(&(footer_offset as u64).to_le_bytes())
        .unwrap();
    file.write_all(revision).unwrap();

    let mut next_text_offset = text_data_offset;
    for (page_number, text) in pages {
        let record_offset =
            directory_offset + (*page_number as usize - 1) * STREAMING_DIRECTORY_ENTRY_SIZE;
        file.seek(SeekFrom::Start(record_offset as u64)).unwrap();
        file.write_all(&(next_text_offset as u64).to_le_bytes())
            .unwrap();
        file.write_all(&(text.len() as u64).to_le_bytes()).unwrap();
        file.write_all(&(text.encode_utf16().count() as u32).to_le_bytes())
            .unwrap();
        file.write_all(&1u32.to_le_bytes()).unwrap();
        next_text_offset += text.len();
    }
    file.seek(SeekFrom::Start(text_data_offset as u64)).unwrap();
    for (_, text) in pages {
        file.write_all(text.as_bytes()).unwrap();
    }
    file.seek(SeekFrom::Start(footer_offset as u64)).unwrap();
    file.write_all(b"EVBSFTR3").unwrap();
    file.write_all(&3u32.to_le_bytes()).unwrap();
    file.write_all(&(STREAMING_FOOTER_SIZE as u32).to_le_bytes())
        .unwrap();
    file.write_all(&1u32.to_le_bytes()).unwrap();
    file.write_all(&0u32.to_le_bytes()).unwrap();
    file.write_all(&(pages.len() as u32).to_le_bytes()).unwrap();
    file.write_all(&0u32.to_le_bytes()).unwrap();
    file.write_all(&(text_bytes as u64).to_le_bytes()).unwrap();
    file.write_all(&((footer_offset + STREAMING_FOOTER_SIZE) as u64).to_le_bytes())
        .unwrap();
    file.write_all(&(directory_length as u64).to_le_bytes())
        .unwrap();
    file.write_all(&(page_count as u64).to_le_bytes()).unwrap();
}

struct FixtureDirectory(PathBuf);

impl FixtureDirectory {
    fn join(&self, path: impl AsRef<Path>) -> PathBuf {
        self.0.join(path)
    }
}

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture_directory(label: &str) -> FixtureDirectory {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "evb-pdf-search-service-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).expect("create service fixture directory");
    FixtureDirectory(directory)
}

fn search_request(request_id: &str, index_path: &Path, query: &str) -> Value {
    serde_json::json!({
        "type": "search",
        "requestId": request_id,
        "indexPath": index_path,
        "query": query,
        "documentRevision": REVISION,
        "limit": 10,
        "contextChars": 4,
        "matchCase": false,
        "pageCount": 1
    })
}

struct SearchService {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl SearchService {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_evb-pdf-search"))
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn persistent search service");
        let stdin = child.stdin.take().expect("search service stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("search service stdout"));
        let mut line = String::new();
        stdout.read_line(&mut line).expect("read ready frame");
        let ready: Value = serde_json::from_str(&line).expect("parse ready frame");
        assert_eq!(ready["type"], "ready");
        Self {
            child,
            stdin: Some(stdin),
            stdout,
        }
    }

    fn request(&mut self, request: &Value) -> Value {
        self.request_raw(&request.to_string())
    }

    fn request_raw(&mut self, request: &str) -> Value {
        self.send_raw(request);
        self.read_response()
    }

    fn read_response(&mut self) -> Value {
        let mut line = String::new();
        self.stdout
            .read_line(&mut line)
            .expect("read search service response");
        serde_json::from_str(&line).expect("parse search service response")
    }

    fn send_raw(&mut self, request: &str) {
        let stdin = self.stdin.as_mut().expect("search service stdin is open");
        writeln!(stdin, "{request}").expect("write search service frame");
        stdin.flush().expect("flush search service frame");
    }

    fn send_frame_bytes(&mut self, frame: &[u8]) {
        let stdin = self.stdin.as_mut().expect("search service stdin is open");
        stdin
            .write_all(frame)
            .expect("write binary search service frame");
        stdin
            .write_all(b"\n")
            .expect("terminate binary search service frame");
        stdin.flush().expect("flush binary search service frame");
    }

    fn send_oversized_frame_then_request(&mut self, request: &Value) {
        let stdin = self.stdin.as_mut().expect("search service stdin is open");
        stdin
            .write_all(&vec![b'x'; MAX_SERVICE_FRAME_BYTES + 8_192])
            .expect("write newline-free oversized search service frame");
        writeln!(stdin, "\n{request}")
            .expect("terminate oversized frame and write recovery request");
        stdin.flush().expect("flush oversized and recovery frames");
    }

    fn request_raw_at_eof(mut self, request: &str) -> Value {
        let mut stdin = self.stdin.take().expect("search service stdin is open");
        stdin
            .write_all(request.as_bytes())
            .expect("write EOF-terminated search service frame");
        stdin.flush().expect("flush EOF-terminated frame");
        drop(stdin);
        let response = self.read_response();
        let status = self
            .child
            .wait()
            .expect("wait after search service stdin EOF");
        assert!(
            status.success(),
            "search service EOF shutdown failed: {status}"
        );
        response
    }

    fn shutdown(mut self) {
        self.send_raw(r#"{"type":"shutdown"}"#);
        let status = self.child.wait().expect("wait for search service shutdown");
        assert!(status.success(), "search service shutdown failed: {status}");
    }

    fn shutdown_with_active_request(mut self, request: &Value) -> Value {
        let stdin = self.stdin.as_mut().expect("search service stdin is open");
        write!(stdin, "{}\n{{\"type\":\"shutdown\"}}\n", request)
            .expect("write active search and shutdown frames");
        stdin
            .flush()
            .expect("flush active search and shutdown frames");

        let mut response_line = String::new();
        self.stdout
            .read_line(&mut response_line)
            .expect("read active search cancellation frame");
        let response =
            serde_json::from_str(&response_line).expect("parse active search cancellation frame");

        let mut trailing_output = String::new();
        assert_eq!(
            self.stdout
                .read_line(&mut trailing_output)
                .expect("read search service stdout EOF"),
            0,
            "search service emitted output after active request cancellation"
        );
        let status = self.child.wait().expect("wait for search service shutdown");
        assert!(status.success(), "search service shutdown failed: {status}");
        response
    }
}

impl Drop for SearchService {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn persistent_service_searches_over_framed_stdio() {
    let directory = fixture_directory("success");
    let index_path = directory.join("document.search-index.bin");
    write_index(&index_path, "Alpha beta alpha");
    let mut service = SearchService::spawn();

    let result = service.request(&search_request("request-1", &index_path, "alpha"));
    assert_eq!(result["type"], "result");
    assert_eq!(result["requestId"], "request-1");
    assert_eq!(result["result"]["results"].as_array().unwrap().len(), 2);

    drop(service);
}

#[test]
fn persistent_service_accepts_an_explicit_idle_shutdown() {
    SearchService::spawn().shutdown();
}

#[test]
fn persistent_service_accepts_a_sparse_index_above_one_million_declared_pages() {
    let directory = fixture_directory("sparse-large-page-count");
    let index_path = directory.join("sparse-large-page-count.search-index.bin");
    let declared_page_count = 1_000_001;
    write_sparse_index(&index_path, declared_page_count, &[(1, "needle")]);
    let index_size = fs::metadata(&index_path).unwrap().len();
    assert!(
        index_size < 1_024,
        "sparse fixture must retain one record, not allocate a dense page table: {index_size} bytes"
    );

    let mut request = search_request("sparse-large-page-count", &index_path, "needle");
    request["pageCount"] = Value::from(declared_page_count);
    let mut service = SearchService::spawn();
    let response = service.request(&request);

    assert_eq!(response["type"], "result", "{response}");
    assert_eq!(response["result"]["pageCount"], declared_page_count);
    assert_eq!(response["result"]["results"][0]["pageNumber"], 1);
    drop(service);
}

#[test]
fn persistent_service_searches_a_v3_sparse_index_above_one_million_pages() {
    let directory = fixture_directory("v3-sparse-large-page-count");
    let index_path = directory.join("v3-sparse-large-page-count.search-index.bin");
    let declared_page_count = 1_000_001;
    write_streaming_sparse_index(
        &index_path,
        declared_page_count,
        &[(1, "first needle"), (declared_page_count, "last needle")],
    );
    let index_size = fs::metadata(&index_path).unwrap().len();
    assert!(
        index_size < 32 * 1024 * 1024,
        "v3 fixture should retain a fixed directory, not a Rust record vector: {index_size} bytes"
    );

    let mut request = search_request("v3-sparse-large-page-count", &index_path, "needle");
    request["pageCount"] = Value::from(declared_page_count);
    let mut service = SearchService::spawn();
    let response = service.request(&request);

    assert_eq!(response["type"], "result", "{response}");
    assert_eq!(response["result"]["pageCount"], declared_page_count);
    assert_eq!(response["result"]["results"].as_array().unwrap().len(), 2);
    assert_eq!(response["result"]["results"][0]["pageNumber"], 1);
    assert_eq!(
        response["result"]["results"][1]["pageNumber"],
        declared_page_count
    );
    drop(service);
}

#[test]
fn persistent_service_shutdown_cancels_and_joins_an_active_search_before_exit() {
    let directory = fixture_directory("active-shutdown");
    let index_path = directory.join("active.search-index.bin");
    write_sparse_multi_page_index(&index_path, 8, 32 * 1024 * 1024);
    let response = SearchService::spawn().shutdown_with_active_request(&search_request(
        "active-request",
        &index_path,
        "needle",
    ));

    assert_eq!(response["type"], "canceled");
    assert_eq!(response["requestId"], "active-request");
}

#[test]
fn malformed_frames_and_corrupt_or_oversized_indexes_return_exact_codes_without_panicking() {
    let directory = fixture_directory("errors");
    let valid_path = directory.join("valid.search-index.bin");
    let corrupt_path = directory.join("corrupt.search-index.bin");
    let oversized_path = directory.join("oversized.search-index.bin");
    write_index(&valid_path, "still alive");
    fs::write(&corrupt_path, b"not-an-index").unwrap();
    File::create(&oversized_path)
        .unwrap()
        .set_len((320 * 1024 * 1024) + 1)
        .unwrap();
    let mut service = SearchService::spawn();

    let malformed = service.request_raw("{not-json}");
    assert_eq!(malformed["type"], "error");
    assert_eq!(malformed["error"]["code"], "invalid-request");
    assert_ne!(malformed["error"]["code"], "panic");

    let corrupt = service.request(&search_request("corrupt", &corrupt_path, "query"));
    assert_eq!(corrupt["type"], "error");
    assert_eq!(corrupt["error"]["code"], "native-failure");
    assert_ne!(corrupt["error"]["code"], "panic");

    let oversized = service.request(&search_request("oversized", &oversized_path, "query"));
    assert_eq!(oversized["type"], "error");
    assert_eq!(oversized["error"]["code"], "too-large");
    assert!(oversized["error"]["message"]
        .as_str()
        .unwrap()
        .contains("335544320-byte admission ceiling"));

    let recovery = service.request(&search_request("recovery", &valid_path, "alive"));
    assert_eq!(recovery["type"], "result");
    assert_eq!(recovery["requestId"], "recovery");

    drop(service);
}

fn padded_frame(request: &Value, byte_length: usize) -> Vec<u8> {
    let mut frame = request.to_string().into_bytes();
    assert!(
        frame.len() <= byte_length,
        "request does not fit padded frame"
    );
    frame.resize(byte_length, b' ');
    frame
}

#[test]
fn service_accepts_a_frame_at_the_exact_byte_limit() {
    let directory = fixture_directory("exact-frame-limit");
    let index_path = directory.join("document.search-index.bin");
    write_index(&index_path, "exact limit");
    let mut service = SearchService::spawn();
    let request = search_request("exact-limit", &index_path, "limit");

    service.send_frame_bytes(&padded_frame(&request, MAX_SERVICE_FRAME_BYTES));
    let response = service.read_response();

    assert_eq!(response["type"], "result", "{response}");
    assert_eq!(response["requestId"], "exact-limit");
    drop(service);
}

#[test]
fn service_rejects_a_frame_one_byte_over_the_limit() {
    let mut service = SearchService::spawn();
    let request = serde_json::json!({"type": "reset-cache"});

    service.send_frame_bytes(&padded_frame(&request, MAX_SERVICE_FRAME_BYTES + 1));
    let response = service.read_response();

    assert_eq!(response["type"], "error");
    assert_eq!(response["requestId"], "");
    assert_eq!(response["error"]["code"], "too-large");
    assert_eq!(
        response["error"]["message"],
        "Search service frame exceeds the 4194304-byte admission ceiling"
    );
    drop(service);
}

#[test]
fn service_drains_a_newline_free_oversized_frame_and_processes_the_next_request() {
    let directory = fixture_directory("oversized-frame-recovery");
    let index_path = directory.join("document.search-index.bin");
    write_index(&index_path, "still searchable");
    let mut service = SearchService::spawn();
    let recovery_request = search_request("after-oversized", &index_path, "searchable");

    service.send_oversized_frame_then_request(&recovery_request);
    let rejected = service.read_response();
    let recovered = service.read_response();

    assert_eq!(rejected["type"], "error");
    assert_eq!(rejected["error"]["code"], "too-large");
    assert_eq!(
        rejected["error"]["message"],
        "Search service frame exceeds the 4194304-byte admission ceiling"
    );
    assert_eq!(recovered["type"], "result", "{recovered}");
    assert_eq!(recovered["requestId"], "after-oversized");
    drop(service);
}

#[test]
fn service_processes_a_final_frame_terminated_by_eof() {
    let response = SearchService::spawn().request_raw_at_eof("{not-json}");

    assert_eq!(response["type"], "error");
    assert_eq!(response["error"]["code"], "invalid-request");
    assert!(response["error"]["message"]
        .as_str()
        .unwrap()
        .starts_with("Invalid search service frame:"));
}

#[test]
fn service_eof_cancels_and_joins_a_valid_unterminated_search() {
    let directory = fixture_directory("active-eof-frame");
    let index_path = directory.join("document.search-index.bin");
    write_sparse_multi_page_index(&index_path, 8, 32 * 1024 * 1024);
    let request = search_request("eof-search", &index_path, "needle");

    let response = SearchService::spawn().request_raw_at_eof(&request.to_string());

    assert_eq!(response["type"], "canceled", "{response}");
    assert_eq!(response["requestId"], "eof-search");
}

#[test]
fn service_rejects_empty_and_oversized_search_fields_before_dispatch() {
    struct Case {
        field: &'static str,
        value: Value,
        code: &'static str,
        message: &'static str,
    }

    let directory = fixture_directory("request-field-limits");
    let index_path = directory.join("document.search-index.bin");
    write_index(&index_path, "field limits");
    let base = search_request("field-limits", &index_path, "limits");
    let cases = [
        Case {
            field: "requestId",
            value: Value::String(String::new()),
            code: "invalid-request",
            message: "Search request id must not be empty",
        },
        Case {
            field: "requestId",
            value: Value::String("r".repeat(129)),
            code: "too-large",
            message: "Search request id exceeds the 128-character admission ceiling",
        },
        Case {
            field: "indexPath",
            value: Value::String(String::new()),
            code: "invalid-request",
            message: "Search index path must not be empty",
        },
        Case {
            field: "indexPath",
            value: Value::String("p".repeat(4_097)),
            code: "too-large",
            message: "Search index path exceeds the 4096-character admission ceiling",
        },
        Case {
            field: "query",
            value: Value::String(String::new()),
            code: "invalid-request",
            message: "Search query must not be empty",
        },
        Case {
            field: "query",
            value: Value::String("q".repeat(2_049)),
            code: "too-large",
            message: "Search query exceeds the 2048-character admission ceiling",
        },
        Case {
            field: "query",
            value: Value::String("😀".repeat(1_025)),
            code: "too-large",
            message: "Search query exceeds the 2048-character admission ceiling",
        },
        Case {
            field: "documentRevision",
            value: Value::String(String::new()),
            code: "invalid-request",
            message: "Search document revision must not be empty",
        },
        Case {
            field: "documentRevision",
            value: Value::String("d".repeat(8_193)),
            code: "too-large",
            message: "Search document revision exceeds the 8192-character admission ceiling",
        },
        Case {
            field: "limit",
            value: Value::from(501),
            code: "too-large",
            message: "Search result limit exceeds the 500-result admission ceiling",
        },
        Case {
            field: "contextChars",
            value: Value::from(57),
            code: "too-large",
            message: "Search context exceeds the 56-character admission ceiling",
        },
        Case {
            field: "pageCount",
            value: Value::from(0),
            code: "invalid-request",
            message: "Search page count must be at least 1",
        },
    ];
    let mut service = SearchService::spawn();

    for case in cases {
        let mut request = base.clone();
        request[case.field] = case.value;
        let response = service.request(&request);
        assert_eq!(
            response["type"], "error",
            "field {}: {response}",
            case.field
        );
        assert_eq!(response["error"]["code"], case.code, "field {}", case.field);
        assert_eq!(
            response["error"]["message"], case.message,
            "field {}",
            case.field
        );
    }

    let recovery = service.request(&search_request("field-recovery", &index_path, "limits"));
    assert_eq!(recovery["type"], "result", "{recovery}");
    assert_eq!(recovery["requestId"], "field-recovery");

    let whitespace_query = service.request(&search_request("whitespace-query", &index_path, " "));
    assert_eq!(whitespace_query["type"], "result", "{whitespace_query}");

    let mut configured_page_count = search_request("configured-page-count", &index_path, "limits");
    configured_page_count["pageCount"] = Value::from(20_001);
    let configured_page_count = service.request(&configured_page_count);
    assert_eq!(
        configured_page_count["type"], "result",
        "{configured_page_count}"
    );
    assert_eq!(configured_page_count["result"]["pageCount"], 20_001);
    drop(service);
}

#[test]
fn service_validates_cancel_request_ids_before_dispatch() {
    let mut service = SearchService::spawn();

    let empty = service.request(&serde_json::json!({"type": "cancel", "requestId": ""}));
    assert_eq!(empty["error"]["code"], "invalid-request");
    assert_eq!(
        empty["error"]["message"],
        "Search request id must not be empty"
    );

    let oversized = service.request(&serde_json::json!({
        "type": "cancel",
        "requestId": "c".repeat(129)
    }));
    assert_eq!(oversized["error"]["code"], "too-large");
    assert_eq!(
        oversized["error"]["message"],
        "Search request id exceeds the 128-character admission ceiling"
    );
    drop(service);
}

#[test]
fn service_cache_evicts_the_least_recently_used_index_and_reloads_it() {
    let directory = fixture_directory("cache");
    let first_path = directory.join("index-0.bin");
    write_index(&first_path, "original token");
    let mut service = SearchService::spawn();

    let first = service.request(&search_request("first", &first_path, "original"));
    assert_eq!(first["type"], "result");
    for index in 1..=8 {
        let index_path = directory.join(format!("index-{index}.bin"));
        write_index(&index_path, &format!("cache token {index}"));
        let response = service.request(&search_request(
            &format!("fill-{index}"),
            &index_path,
            &index.to_string(),
        ));
        assert_eq!(response["type"], "result", "{response}");
    }

    write_index(&first_path, "replacement token");
    let reloaded = service.request(&search_request("reloaded", &first_path, "replacement"));
    assert_eq!(reloaded["type"], "result", "{reloaded}");
    assert_eq!(reloaded["result"]["results"].as_array().unwrap().len(), 1);

    drop(service);
}

#[test]
fn reset_cache_reloads_an_atomic_same_revision_replacement() {
    let directory = fixture_directory("reset-cache");
    let index_path = directory.join("document.search-index.bin");
    let replacement_path = directory.join("replacement.search-index.bin");
    write_index(&index_path, "original token");
    let mut service = SearchService::spawn();

    let original = service.request(&search_request("original", &index_path, "original"));
    assert_eq!(original["type"], "result");
    assert_eq!(original["result"]["results"].as_array().unwrap().len(), 1);

    write_index(&replacement_path, "replacement token");
    fs::rename(&replacement_path, &index_path).expect("replace search index atomically");
    service.send_raw(r#"{"type":"reset-cache"}"#);

    let replacement = service.request(&search_request("replacement", &index_path, "replacement"));
    assert_eq!(replacement["type"], "result", "{replacement}");
    assert_eq!(
        replacement["result"]["results"].as_array().unwrap().len(),
        1
    );

    drop(service);
}
