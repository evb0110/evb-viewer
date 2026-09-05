#![cfg(target_family = "unix")]

use lopdf::{dictionary, Document, Object, Stream};
use serde_json::Value;
use std::{
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

const SPARSE_STREAM_BYTES: u64 = 900 * 1024 * 1024;
const SPARSE_STREAM_COUNT: u32 = 6;
const STRUCTURAL_LOADER_STREAM_BYTES: u64 = 513 * 1024 * 1024;

struct TempFiles(Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

fn temp_path(label: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!(
        "evb-pdf-page-ops-{label}-{}-{nonce}.{extension}",
        std::process::id()
    ))
}

fn write_object(file: &mut File, offsets: &mut Vec<u64>, object: &[u8]) {
    offsets.push(file.stream_position().unwrap());
    file.write_all(object).unwrap();
}

fn write_sparse_five_gib_pdf(path: &Path) -> u64 {
    let mut file = File::create(path).unwrap();
    file.write_all(b"%PDF-1.4\n%\x80\x81\x82\x83\n").unwrap();
    let mut offsets = Vec::new();
    write_object(
        &mut file,
        &mut offsets,
        b"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<<>>/Contents 4 0 R>>\nendobj\n",
    );
    for object_number in 4..4 + SPARSE_STREAM_COUNT {
        offsets.push(file.stream_position().unwrap());
        file.write_all(
            format!("{object_number} 0 obj\n<</Length {SPARSE_STREAM_BYTES}>>\nstream\n")
                .as_bytes(),
        )
        .unwrap();
        file.seek(SeekFrom::Current(
            i64::try_from(SPARSE_STREAM_BYTES).unwrap(),
        ))
        .unwrap();
        file.write_all(b"\nendstream\nendobj\n").unwrap();
    }

    let xref_offset = file.stream_position().unwrap();
    assert!(xref_offset > u64::from(u32::MAX));
    let xref_size = 4 + SPARSE_STREAM_COUNT;
    file.write_all(format!("xref\n0 {xref_size}\n0000000000 65535 f \n").as_bytes())
        .unwrap();
    for offset in offsets {
        file.write_all(format!("{offset:010} 00000 n \n").as_bytes())
            .unwrap();
    }
    file.write_all(
        format!("trailer\n<</Size {xref_size}/Root 1 0 R>>\nstartxref\n{xref_offset}\n%%EOF\n")
            .as_bytes(),
    )
    .unwrap();
    file.sync_all().unwrap();
    fs::metadata(path).unwrap().len()
}

fn write_sparse_structural_loader_pdf(path: &Path) -> u64 {
    let mut file = File::create(path).unwrap();
    file.write_all(b"%PDF-1.4\n%\x80\x81\x82\x83\n").unwrap();
    let mut offsets = Vec::new();
    write_object(
        &mut file,
        &mut offsets,
        b"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<<>>/Contents 4 0 R>>\nendobj\n",
    );
    offsets.push(file.stream_position().unwrap());
    file.write_all(
        format!("4 0 obj\n<</Length {STRUCTURAL_LOADER_STREAM_BYTES}>>\nstream\n").as_bytes(),
    )
    .unwrap();
    file.seek(SeekFrom::Current(
        i64::try_from(STRUCTURAL_LOADER_STREAM_BYTES).unwrap(),
    ))
    .unwrap();
    file.write_all(b"\nendstream\nendobj\n").unwrap();

    let xref_offset = file.stream_position().unwrap();
    file.write_all(b"xref\n0 5\n0000000000 65535 f \n").unwrap();
    for offset in offsets {
        file.write_all(format!("{offset:010} 00000 n \n").as_bytes())
            .unwrap();
    }
    file.write_all(
        format!("trailer\n<</Size 5/Root 1 0 R>>\nstartxref\n{xref_offset}\n%%EOF\n").as_bytes(),
    )
    .unwrap();
    file.sync_all().unwrap();
    let len = fs::metadata(path).unwrap().len();
    assert!(len > 512 * 1024 * 1024);
    len
}

fn write_sparse_ten_gib_xref_stream_pdf(path: &Path) -> u64 {
    const STREAM_COUNT: u32 = 12;
    let mut file = File::create(path).unwrap();
    file.write_all(b"%PDF-1.7\n%\x80\x81\x82\x83\n").unwrap();
    let mut offsets = vec![0_u64];
    write_object(
        &mut file,
        &mut offsets,
        b"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<<>>>>\nendobj\n",
    );
    for object_number in 4..4 + STREAM_COUNT {
        offsets.push(file.stream_position().unwrap());
        file.write_all(
            format!("{object_number} 0 obj\n<</Length {SPARSE_STREAM_BYTES}>>\nstream\n")
                .as_bytes(),
        )
        .unwrap();
        file.seek(SeekFrom::Current(
            i64::try_from(SPARSE_STREAM_BYTES).unwrap(),
        ))
        .unwrap();
        file.write_all(b"\nendstream\nendobj\n").unwrap();
    }

    let xref_object_number = 4 + STREAM_COUNT;
    let xref_offset = file.stream_position().unwrap();
    assert!(xref_offset > 10_000_000_000);
    offsets.push(xref_offset);
    let mut xref_content = Vec::with_capacity(offsets.len() * 11);
    xref_content.push(0);
    xref_content.extend_from_slice(&0_u64.to_be_bytes());
    xref_content.extend_from_slice(&u16::MAX.to_be_bytes());
    for offset in offsets.iter().skip(1) {
        xref_content.push(1);
        xref_content.extend_from_slice(&offset.to_be_bytes());
        xref_content.extend_from_slice(&0_u16.to_be_bytes());
    }
    let xref_size = xref_object_number + 1;
    file.write_all(
        format!(
            "{xref_object_number} 0 obj\n<</Type/XRef/Size {xref_size}/Root 1 0 R/W[1 8 2]/Index[0 {xref_size}]/Length {}>>\nstream\n",
            xref_content.len()
        )
        .as_bytes(),
    )
    .unwrap();
    file.write_all(&xref_content).unwrap();
    file.write_all(format!("\nendstream\nendobj\nstartxref\n{xref_offset}\n%%EOF\n").as_bytes())
        .unwrap();
    file.sync_all().unwrap();
    fs::metadata(path).unwrap().len()
}

fn write_sparse_near_ten_gib_classic_pdf(path: &Path) -> u64 {
    const TARGET_XREF_OFFSET: u64 = 9_999_999_700;
    let mut file = File::create(path).unwrap();
    file.write_all(b"%PDF-1.4\n%\x80\x81\x82\x83\n").unwrap();
    let mut offsets = Vec::new();
    write_object(
        &mut file,
        &mut offsets,
        b"1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n",
    );
    write_object(
        &mut file,
        &mut offsets,
        b"3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<<>>>>\nendobj\n",
    );
    offsets.push(file.stream_position().unwrap());
    let stream_prefix = b"4 0 obj\n<</Length ";
    let stream_suffix = b">>\nstream\n";
    let object_suffix = b"\nendstream\nendobj\n";
    let mut stream_len = TARGET_XREF_OFFSET - file.stream_position().unwrap() - 64;
    loop {
        let header_len = stream_prefix.len() as u64
            + stream_len.to_string().len() as u64
            + stream_suffix.len() as u64;
        let end =
            file.stream_position().unwrap() + header_len + stream_len + object_suffix.len() as u64;
        if end == TARGET_XREF_OFFSET {
            break;
        }
        stream_len = stream_len
            .checked_add_signed(TARGET_XREF_OFFSET as i64 - end as i64)
            .unwrap();
    }
    file.write_all(stream_prefix).unwrap();
    write!(file, "{stream_len}").unwrap();
    file.write_all(stream_suffix).unwrap();
    file.seek(SeekFrom::Current(i64::try_from(stream_len).unwrap()))
        .unwrap();
    file.write_all(object_suffix).unwrap();
    assert_eq!(file.stream_position().unwrap(), TARGET_XREF_OFFSET);

    file.write_all(b"xref\n0 5\n0000000000 65535 f \n").unwrap();
    for offset in offsets {
        file.write_all(format!("{offset:010} 00000 n \n").as_bytes())
            .unwrap();
    }
    file.write_all(
        format!("trailer\n<</Size 5/Root 1 0 R>>\nstartxref\n{TARGET_XREF_OFFSET}\n%%EOF\n")
            .as_bytes(),
    )
    .unwrap();
    file.sync_all().unwrap();
    let len = fs::metadata(path).unwrap().len();
    assert!(len < 10_000_000_000);
    len
}

fn qpdf_path() -> PathBuf {
    env::var_os("QPDF_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("qpdf"))
}

fn append_bookmark(pdf: &Path, mutations: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["save-mutations", "--input"])
        .arg(pdf)
        .arg("--output")
        .arg(pdf)
        .arg("--mutations-file")
        .arg(mutations)
        .arg("--qpdf")
        .arg(qpdf_path())
        .args(["--modified-at", "D:20260826120000Z", "--append"])
        .output()
        .unwrap()
}

fn append_mutations(pdf: &Path, mutations: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["save-mutations", "--input"])
        .arg(pdf)
        .arg("--output")
        .arg(pdf)
        .arg("--mutations-file")
        .arg(mutations)
        .arg("--qpdf")
        .arg(qpdf_path())
        .args(["--modified-at", "D:20260827230000Z", "--append"])
        .output()
        .unwrap()
}

fn qpdf_objects_json(pdf: &Path) -> String {
    let output = Command::new(qpdf_path())
        .args(["--json=1", "--json-key=objects", "--json-stream-data=none"])
        .arg("--")
        .arg(pdf)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "qpdf object JSON read failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn qpdf_contains_pdf_text(pdf: &Path, text: &str) -> bool {
    let objects = qpdf_objects_json(pdf).to_lowercase();
    objects.contains(&pdf_utf16be_hex(text)) || objects.contains(&text.to_lowercase())
}

fn qpdf_text_note_objects(pdf: &Path) -> Vec<((u32, u16), String)> {
    let value: Value = serde_json::from_str(&qpdf_objects_json(pdf)).unwrap();
    let objects = value
        .get("objects")
        .and_then(Value::as_object)
        .expect("qpdf object JSON must contain an objects map");
    let page = objects
        .values()
        .find(|object| object.get("/Type") == Some(&Value::String("/Page".to_string())))
        .expect("qpdf object JSON must contain a page");
    let annotation_refs = page
        .get("/Annots")
        .and_then(Value::as_array)
        .expect("qpdf page object must contain an Annots array");

    annotation_refs
        .iter()
        .filter_map(|reference| {
            let reference = reference.as_str()?;
            let mut parts = reference.split_whitespace();
            let object_number = parts.next()?.parse().ok()?;
            let generation_number = parts.next()?.parse().ok()?;
            if parts.next()? != "R" {
                return None;
            }
            let object = objects.get(reference)?;
            if object.get("/Subtype") != Some(&Value::String("/Text".to_string())) {
                return None;
            }
            let contents = object.get("/Contents")?.as_str()?.to_string();
            Some(((object_number, generation_number), contents))
        })
        .collect()
}

fn pdf_utf16be_hex(value: &str) -> String {
    let mut bytes = vec![0xfe, 0xff];
    for code_unit in value.encode_utf16() {
        bytes.extend_from_slice(&code_unit.to_be_bytes());
    }
    bytes
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn split_pages_to_new_path(pdf: &Path, output: &Path, instructions: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["split-pages", "--input"])
        .arg(pdf)
        .args(["--output"])
        .arg(output)
        .args(["--instructions-file"])
        .arg(instructions)
        .args(["--qpdf"])
        .arg(qpdf_path())
        .output()
        .unwrap()
}

fn save_overlay_source(path: &Path) {
    let mut document = Document::with_version("1.7");
    let pages_id = document.new_object_id();
    let font_id = document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let content_id = document.add_object(Stream::new(
        dictionary! {},
        b"BT /F1 12 Tf 3 Tr 10 20 Td (Sparse OCR) Tj ET".to_vec(),
    ));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => font_id } },
        "Contents" => content_id,
    });
    document.objects.insert(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        }
        .into(),
    );
    let catalog_id = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog_id);
    document.save(path).unwrap();
}

fn save_bookmark_mutations(path: &Path) {
    fs::write(
        path,
        br#"{"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":[{"title":"A","pageIndex":0,"pageYRatio":0.5,"namedDest":null,"bold":false,"italic":false,"color":null,"items":[]}]}}"#,
    )
    .unwrap();
}

fn save_overlay_instructions(path: &Path) {
    fs::write(
        path,
        br#"{"pages":[{"sourcePageIndex":0,"outputPageIndex":0,"matrix":[1,0,0,1,0,0]}]}"#,
    )
    .unwrap();
}

fn assert_qpdf_page_count(pdf: &Path, expected: &str) {
    let output = Command::new(qpdf_path())
        .args(["--show-npages", "--suppress-recovery", "--"])
        .arg(pdf)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "qpdf page-count check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), expected);
}

fn assert_qpdf_check(pdf: &Path) {
    let output = Command::new(qpdf_path())
        .args(["--check", "--suppress-recovery", "--"])
        .arg(pdf)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "qpdf --check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn terminal_xref_marker(pdf: &Path) -> [u8; 4] {
    let mut file = File::open(pdf).unwrap();
    let len = file.metadata().unwrap().len();
    file.seek(SeekFrom::Start(len.saturating_sub(1_024)))
        .unwrap();
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).unwrap();
    let marker = tail
        .windows(b"startxref".len())
        .rposition(|window| window == b"startxref")
        .unwrap();
    let xref_offset = std::str::from_utf8(&tail[marker + b"startxref".len()..])
        .unwrap()
        .trim_start()
        .split_ascii_whitespace()
        .next()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    file.seek(SeekFrom::Start(xref_offset)).unwrap();
    let mut bytes = [0_u8; 4];
    file.read_exact(&mut bytes).unwrap();
    bytes
}

#[test]
fn split_pages_writes_a_new_revision_for_a_sparse_pdf_beyond_four_gib() {
    let pdf = temp_path("five-gib-split", "pdf");
    let output_pdf = temp_path("five-gib-split-output", "pdf");
    let instructions = temp_path("five-gib-split", "json");
    let _cleanup = TempFiles(vec![pdf.clone(), output_pdf.clone(), instructions.clone()]);
    let original_len = write_sparse_five_gib_pdf(&pdf);
    fs::write(
        &instructions,
        br#"{"pages":[{"sourcePageIndex":0,"rotationQuarterTurns":0,"outputs":[{"cropRect":{"x":0,"y":0,"width":200,"height":100},"contentTransform":{"scale":1,"translateX":0,"translateY":0}}]}]}"#,
    )
    .unwrap();

    let result = split_pages_to_new_path(&pdf, &output_pdf, &instructions);
    assert!(
        result.status.success(),
        "split-pages failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(fs::metadata(&output_pdf).unwrap().len() > original_len);
    assert_eq!(terminal_xref_marker(&output_pdf), *b"xref");
    assert_qpdf_page_count(&output_pdf, "1");
    assert_qpdf_check(&output_pdf);
}

#[test]
fn overlay_text_writes_a_new_revision_for_a_sparse_pdf_beyond_four_gib() {
    let pdf = temp_path("five-gib-overlay", "pdf");
    let output_pdf = temp_path("five-gib-overlay-output", "pdf");
    let source_pdf = temp_path("five-gib-overlay-source", "pdf");
    let instructions = temp_path("five-gib-overlay", "json");
    let _cleanup = TempFiles(vec![
        pdf.clone(),
        output_pdf.clone(),
        source_pdf.clone(),
        instructions.clone(),
    ]);
    let original_len = write_sparse_five_gib_pdf(&pdf);
    save_overlay_source(&source_pdf);
    save_overlay_instructions(&instructions);

    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["overlay-text", "--input"])
        .arg(&pdf)
        .args(["--source"])
        .arg(&source_pdf)
        .args(["--output"])
        .arg(&output_pdf)
        .args(["--instructions-file"])
        .arg(&instructions)
        .args(["--qpdf"])
        .arg(qpdf_path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "overlay-text failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(fs::metadata(&output_pdf).unwrap().len() > original_len);
    assert_eq!(terminal_xref_marker(&output_pdf), *b"xref");
    assert_qpdf_page_count(&output_pdf, "1");
    assert_qpdf_check(&output_pdf);
}

#[test]
fn non_append_mutations_write_a_new_revision_for_a_sparse_pdf_beyond_four_gib() {
    let pdf = temp_path("five-gib-non-append", "pdf");
    let output_pdf = temp_path("five-gib-non-append-output", "pdf");
    let mutations = temp_path("five-gib-non-append", "json");
    let _cleanup = TempFiles(vec![pdf.clone(), output_pdf.clone(), mutations.clone()]);
    let original_len = write_sparse_five_gib_pdf(&pdf);
    save_bookmark_mutations(&mutations);

    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["save-mutations", "--input"])
        .arg(&pdf)
        .args(["--output"])
        .arg(&output_pdf)
        .args(["--mutations-file"])
        .arg(&mutations)
        .args(["--qpdf"])
        .arg(qpdf_path())
        .args(["--modified-at", "D:20260826120000Z"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "non-append save-mutations failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(fs::metadata(&output_pdf).unwrap().len() > original_len);
    assert_eq!(terminal_xref_marker(&output_pdf), *b"xref");
    assert_qpdf_page_count(&output_pdf, "1");
    assert_qpdf_check(&output_pdf);
}

#[test]
fn appends_metadata_to_a_sparse_pdf_beyond_four_gib() {
    let pdf = temp_path("five-gib-append", "pdf");
    let mutations = temp_path("five-gib-append", "json");
    let _cleanup = TempFiles(vec![pdf.clone(), mutations.clone()]);
    let original_len = write_sparse_five_gib_pdf(&pdf);
    fs::write(
        &mutations,
        br#"{"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":[{"title":"A","pageIndex":0,"pageYRatio":0.5,"namedDest":null,"bold":false,"italic":false,"color":null,"items":[]}]}}"#,
    )
    .unwrap();

    let output = append_bookmark(&pdf, &mutations);
    assert!(
        output.status.success(),
        "append failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fs::metadata(&pdf).unwrap().len() > original_len);
    assert_qpdf_check(&pdf);
}

#[test]
fn qpdf_structural_loader_resolves_repeated_native_mutations() {
    let pdf = temp_path("structural-loader-repeated-mutations", "pdf");
    let first_mutations = temp_path("structural-loader-first-mutations", "json");
    let second_mutations = temp_path("structural-loader-second-mutations", "json");
    let _cleanup = TempFiles(vec![
        pdf.clone(),
        first_mutations.clone(),
        second_mutations.clone(),
    ]);
    write_sparse_structural_loader_pdf(&pdf);
    fs::write(
        &first_mutations,
        br#"{"freeTextNotes":[{"pageIndex":0,"stableKey":"uid:0:first","text":"first text","markerRect":{"left":0.1,"top":0.2,"width":0.01,"height":0.01},"author":null,"color":null,"createdAt":1}]}"#,
    )
    .unwrap();

    let first = append_mutations(&pdf, &first_mutations);
    assert!(
        first.status.success(),
        "first append failed: {}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first_notes = qpdf_text_note_objects(&pdf);
    assert_eq!(first_notes.len(), 1);
    assert_eq!(first_notes[0].1, "first text");

    fs::write(
        &second_mutations,
        format!(
            r#"{{"updates":[{{"objectNumber":{},"generationNumber":{},"text":"edited text"}}],"freeTextNotes":[{{"pageIndex":0,"stableKey":"uid:0:second","text":"second text","markerRect":{{"left":0.3,"top":0.4,"width":0.01,"height":0.01}},"author":null,"color":null,"createdAt":2}}]}}"#,
            first_notes[0].0.0,
            first_notes[0].0.1,
        )
        .as_bytes(),
    )
    .unwrap();

    let second = append_mutations(&pdf, &second_mutations);
    assert!(
        second.status.success(),
        "second append failed: {}",
        String::from_utf8_lossy(&second.stderr)
    );
    let text_notes = qpdf_text_note_objects(&pdf);
    assert_eq!(text_notes.len(), 2);
    assert!(text_notes
        .iter()
        .any(|(object_id, contents)| *object_id == first_notes[0].0 && contents == "edited text"));
    assert!(text_notes
        .iter()
        .any(|(_, contents)| contents == "second text"));
    assert!(!qpdf_contains_pdf_text(&pdf, "first text"));
    assert_qpdf_check(&pdf);
}

#[test]
fn appends_metadata_beyond_the_ten_gb_classic_xref_limit() {
    let pdf = temp_path("ten-gb-xref-stream-append", "pdf");
    let mutations = temp_path("ten-gb-xref-stream-append", "json");
    let _cleanup = TempFiles(vec![pdf.clone(), mutations.clone()]);
    let original_len = write_sparse_ten_gib_xref_stream_pdf(&pdf);
    fs::write(
        &mutations,
        br#"{"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":[{"title":"A","pageIndex":0,"pageYRatio":0.5,"namedDest":null,"bold":false,"italic":false,"color":null,"items":[]}]}}"#,
    )
    .unwrap();

    let output = append_bookmark(&pdf, &mutations);
    assert!(
        output.status.success(),
        "append failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fs::metadata(&pdf).unwrap().len() > original_len);
    assert_qpdf_check(&pdf);
}

#[test]
fn upgrades_a_classic_xref_when_the_append_crosses_ten_billion_bytes() {
    let pdf = temp_path("classic-xref-ceiling-append", "pdf");
    let mutations = temp_path("classic-xref-ceiling-append", "json");
    let _cleanup = TempFiles(vec![pdf.clone(), mutations.clone()]);
    let original_len = write_sparse_near_ten_gib_classic_pdf(&pdf);
    fs::write(
        &mutations,
        br#"{"bookmarks":{"totalPages":1,"untitledLabel":"Untitled","items":[{"title":"A","pageIndex":0,"pageYRatio":0.5,"namedDest":null,"bold":false,"italic":false,"color":null,"items":[]}]}}"#,
    )
    .unwrap();

    let output = append_bookmark(&pdf, &mutations);
    assert!(
        output.status.success(),
        "append failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let final_len = fs::metadata(&pdf).unwrap().len();
    assert!(final_len > original_len);
    assert!(final_len > 10_000_000_000);
    assert_ne!(terminal_xref_marker(&pdf), *b"xref");
    let catalog = Command::new(qpdf_path())
        .args(["--show-object=1", "--"])
        .arg(&pdf)
        .output()
        .unwrap();
    assert!(catalog.status.success());
    assert!(String::from_utf8_lossy(&catalog.stdout).contains("/Version /1.5"));
    assert_qpdf_check(&pdf);
}
