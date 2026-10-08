use super::*;

const TERMINAL_TAIL_BYTES: u64 = 1024 * 1024;
// lopdf 0.44, which reads every append base up to MAX_ENCODED_PDF_BYTES, looks
// for the last %%EOF only in a file's final 512 bytes and for startxref only in
// the 25 bytes before that marker.
const LOPDF_EOF_SEARCH_BYTES: usize = 512;
const LOPDF_STARTXREF_SEARCH_BYTES: usize = 25;
const LOPDF_HEADER_LINE_BYTES: usize = 64 * 1024;
const QPDF_PAGE_COUNT_OUTPUT_BYTES: usize = 1024;

struct TerminalXref {
    offset: u64,
}

fn read_tail(file: &mut File, file_len: u64) -> std::io::Result<(u64, Vec<u8>)> {
    let tail_start = file_len.saturating_sub(TERMINAL_TAIL_BYTES);
    file.seek(SeekFrom::Start(tail_start))?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail)?;
    Ok((tail_start, tail))
}

fn find_terminal_xref(
    tail: &[u8],
    file_len: u64,
) -> std::result::Result<TerminalXref, &'static str> {
    let eof = find_last_bytes(tail, b"%%EOF").ok_or("PDF terminal EOF marker is missing")?;
    // Bytes after the last EOF marker, such as NUL padding or a download
    // trailer, belong to no revision and an append can follow them. A later
    // startxref among them would make qpdf and this reader disagree on which
    // revision the append extends.
    if find_last_bytes(&tail[eof + b"%%EOF".len()..], b"startxref").is_some() {
        return Err("PDF has a startxref marker after its terminal EOF marker");
    }
    let marker = find_last_bytes(&tail[..eof], b"startxref")
        .ok_or("PDF terminal startxref marker is missing")?;
    let offset = parse_u64_token(tail, marker + b"startxref".len())
        .map(|(value, _)| value)
        .ok_or("PDF terminal startxref value is invalid")?;
    if offset >= file_len {
        return Err("PDF terminal startxref points outside the file");
    }
    Ok(TerminalXref { offset })
}

pub(crate) fn read_terminal_xref(
    path: &Path,
    file_len: u64,
) -> Result<(u64, lopdf::xref::XrefType)> {
    let mut file = File::open(path).map_err(io_domain_error)?;
    read_terminal_xref_from_file(&mut file, file_len)
}

pub(crate) fn read_terminal_xref_from_file(
    file: &mut File,
    file_len: u64,
) -> Result<(u64, lopdf::xref::XrefType)> {
    let (_, tail) = read_tail(file, file_len)?;
    let terminal = find_terminal_xref(&tail, file_len)?;
    file.seek(SeekFrom::Start(terminal.offset))?;
    let mut marker = [0_u8; 4];
    let count = file.read(&mut marker)?;
    let xref_type = if marker[..count].starts_with(b"xref") {
        lopdf::xref::XrefType::CrossReferenceTable
    } else {
        lopdf::xref::XrefType::CrossReferenceStream
    };
    Ok((terminal.offset, xref_type))
}

/// What the append path would make of a file, judged before anything edits it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AppendAdmission {
    Appendable,
    /// The append loaders cannot find or follow the cross-reference chain, a
    /// damage a full rewrite repairs.
    Repairable(String),
    /// A resource ceiling refuses the file; a rewrite would not change that.
    Limited(String),
    /// The chain reads without recovery, but the loader's object and retained
    /// structure ceilings for a base this large are met only by the full
    /// structural read a save runs.
    Unverified(String),
}

fn classify_refusal(error: Box<dyn Error>) -> Result<AppendAdmission> {
    match error.downcast_ref::<NativeError>().map(|error| error.code) {
        Some(NativeErrorCode::CorruptXref) => Ok(AppendAdmission::Repairable(error.to_string())),
        Some(NativeErrorCode::TooLarge) => Ok(AppendAdmission::Limited(error.to_string())),
        _ => Err(error),
    }
}

/// Runs the append loaders' structural acceptance without loading the
/// document: the terminal-xref guard, then for an eager base lopdf's
/// startxref locator and the loader's cross-reference chain preflight. A
/// larger base gets qpdf's page-tree read with recovery off and the loader's
/// page ceiling; its full structural read costs seconds, so it is not run here
/// and such a base is never called appendable. Object-level damage that only a
/// full load meets is not judged either.
pub(crate) fn append_admission(path: &Path, qpdf_path: Option<&Path>) -> Result<AppendAdmission> {
    let mut file = File::open(path).map_err(io_domain_error)?;
    let file_len = file.metadata().map_err(io_domain_error)?.len();
    let (tail_start, tail) = read_tail(&mut file, file_len).map_err(io_domain_error)?;
    let terminal = match find_terminal_xref(&tail, file_len) {
        Ok(terminal) => terminal,
        Err(refusal) => return Ok(AppendAdmission::Repairable(refusal.to_string())),
    };
    if file_len > MAX_ENCODED_PDF_BYTES as u64 {
        let qpdf_path = qpdf_path.ok_or_else(|| {
            domain_error(
                NativeErrorCode::InvalidRequest,
                "Large PDF append admission requires the bundled qpdf",
            )
        })?;
        let temp = TempQpdfFiles::create()?;
        return match run_qpdf_bounded(
            path,
            qpdf_path,
            &["--suppress-recovery", "--show-npages"],
            &temp,
            QPDF_PAGE_COUNT_OUTPUT_BYTES,
        ) {
            Ok(()) => large_base_admission(&temp),
            Err(error) => classify_refusal(error),
        };
    }
    if !lopdf_reads_header(&mut file)? {
        return Ok(AppendAdmission::Repairable(
            "PDF does not start with a header line the PDF reader accepts".to_string(),
        ));
    }
    if lopdf_terminal_xref(&tail, tail_start) != Some(terminal.offset) {
        return Ok(AppendAdmission::Repairable(
            "PDF terminal startxref is not where or in the form the PDF reader reads it"
                .to_string(),
        ));
    }
    let input_len = usize::try_from(file_len)?;
    let root = usize::try_from(terminal.offset)?;
    match check_xref_chain(
        root,
        input_len,
        PDF_PATH_LOAD_POLICY,
        |offset, window_len| {
            let window = read_window(&mut file, offset, window_len.min(input_len - offset))?;
            let truncated = offset + window.len() < input_len;
            Ok((std::borrow::Cow::Owned(window), truncated))
        },
    ) {
        Ok(_) => Ok(AppendAdmission::Appendable),
        Err(error) => classify_refusal(error),
    }
}

// lopdf 0.44 keeps its prologue parser and terminal-revision locator private
// (`parser::header`, `Reader::get_xref_start`, `parser::xref_start`). These two
// functions repeat their rules; the admission tests hold them against lopdf's
// own load.

/// lopdf reads offsets from the first `%PDF-`, so any byte before it shifts
/// every cross-reference offset, and the header line must end in an EOL.
fn lopdf_reads_header(file: &mut File) -> Result<bool> {
    file.seek(SeekFrom::Start(0)).map_err(io_domain_error)?;
    let mut head = Vec::new();
    file.take(LOPDF_HEADER_LINE_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(io_domain_error)?;
    Ok(head.starts_with(b"%PDF-") && head.iter().any(|byte| matches!(*byte, b'\r' | b'\n')))
}

/// The offset lopdf's locator reads: the last `%%EOF` starting in the final
/// 512 bytes, the last `startxref` starting within 25 bytes before it, then
/// `startxref`, an optional space, an EOL, a spaced integer, an EOL and `%%EOF`.
fn lopdf_terminal_xref(tail: &[u8], tail_start: u64) -> Option<u64> {
    let window_start = tail.len().saturating_sub(LOPDF_EOF_SEARCH_BYTES);
    let eof = window_start + find_last_bytes(&tail[window_start..], b"%%EOF")?;
    if tail_start + (eof as u64) <= LOPDF_STARTXREF_SEARCH_BYTES as u64 {
        return None;
    }
    let search_start = eof.saturating_sub(LOPDF_STARTXREF_SEARCH_BYTES);
    let marker = search_start + find_last_bytes(&tail[search_start..eof], b"startxref")?;
    let rest = &tail[marker + b"startxref".len()..];
    let rest = strip_lopdf_eol(rest.strip_prefix(b" ").unwrap_or(rest))?;
    let rest = &rest[rest.iter().take_while(|byte| **byte == b' ').count()..];
    let rest = rest.strip_prefix(b"+").unwrap_or(rest);
    let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
    let value = std::str::from_utf8(&rest[..digits])
        .ok()?
        .parse::<i64>()
        .ok()?;
    let rest = &rest[digits..];
    let rest = &rest[rest.iter().take_while(|byte| **byte == b' ').count()..];
    strip_lopdf_eol(rest)?.starts_with(b"%%EOF").then_some(())?;
    u64::try_from(value).ok()
}

fn strip_lopdf_eol(bytes: &[u8]) -> Option<&[u8]> {
    bytes
        .strip_prefix(b"\r\n")
        .or_else(|| bytes.strip_prefix(b"\n"))
        .or_else(|| bytes.strip_prefix(b"\r"))
}

fn large_base_admission(temp: &TempQpdfFiles) -> Result<AppendAdmission> {
    let output = read_file_bounded(
        &temp.structure,
        QPDF_PAGE_COUNT_OUTPUT_BYTES,
        "qpdf page count",
    )?;
    let page_count = std::str::from_utf8(&output)?.trim().parse::<usize>()?;
    Ok(if page_count > MAX_PATH_INPUT_PDF_PAGES {
        AppendAdmission::Limited(format!(
            "PDF page count {page_count} exceeds the native path-load limit"
        ))
    } else {
        AppendAdmission::Unverified(
            "The object and structure ceilings of a base this large are checked when an edit is saved"
                .to_string(),
        )
    })
}

pub(crate) fn read_window(file: &mut File, offset: usize, len: usize) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(io_domain_error)?;
    let mut window = vec![0; len];
    file.read_exact(&mut window).map_err(io_domain_error)?;
    Ok(window)
}

pub(crate) fn write_append_admission(
    input_path: &Path,
    qpdf_path: Option<&Path>,
    output: &mut impl Write,
) -> Result<()> {
    let (verdict, reason) = match append_admission(input_path, qpdf_path)? {
        AppendAdmission::Appendable => ("appendable", None),
        AppendAdmission::Repairable(reason) => ("repairable", Some(reason)),
        AppendAdmission::Limited(reason) => ("limited", Some(reason)),
        AppendAdmission::Unverified(reason) => ("unverified", Some(reason)),
    };
    serde_json::to_writer(
        output,
        &serde_json::json!({
            "verdict": verdict,
            "reason": reason,
        }),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("evb-terminal-xref-{label}-{nonce}.pdf"))
    }

    #[test]
    fn terminal_xref_rejects_a_later_marker_after_eof() {
        let path = temp_path("later-marker");
        fs::write(
            &path,
            b"%PDF-1.4\nxref\nstartxref\n9\n%%EOF\n% startxref\n1\n",
        )
        .unwrap();
        let mut file = File::open(&path).unwrap();
        let len = file.metadata().unwrap().len();
        let error = read_terminal_xref_from_file(&mut file, len).unwrap_err();
        assert!(error.to_string().contains("after its terminal EOF"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn terminal_xref_reads_through_bytes_after_eof() {
        for trailer in [&b"\0\0\0\0"[..], b"<html>download trailer</html>\n"] {
            let path = temp_path("trailer");
            fs::write(
                &path,
                [&b"%PDF-1.4\nxref\nstartxref\n9\n%%EOF\n"[..], trailer].concat(),
            )
            .unwrap();
            let mut file = File::open(&path).unwrap();
            let len = file.metadata().unwrap().len();
            let (offset, xref_type) = read_terminal_xref_from_file(&mut file, len).unwrap();
            assert_eq!(offset, 9);
            assert!(matches!(
                xref_type,
                lopdf::xref::XrefType::CrossReferenceTable
            ));
            fs::remove_file(path).unwrap();
        }
    }

    fn one_page_document() -> Document {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            "Resources" => dictionary! {},
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document
    }

    fn one_page_pdf() -> Vec<u8> {
        let mut bytes = Vec::new();
        one_page_document().save_to(&mut bytes).unwrap();
        bytes
    }

    fn terminal_offset(pdf: &[u8]) -> usize {
        let marker = find_last_bytes(pdf, b"startxref").unwrap();
        parse_u64_token(pdf, marker + b"startxref".len()).unwrap().0 as usize
    }

    /// Appends an empty revision whose trailer links to `prev`.
    fn with_revision(pdf: &[u8], prev: usize) -> Vec<u8> {
        let text = String::from_utf8_lossy(pdf);
        let after_root = &text[text.rfind("/Root").unwrap() + b"/Root".len()..];
        let root = &after_root[..after_root.find('R').unwrap()];
        let mut bytes = pdf.to_vec();
        let offset = bytes.len();
        bytes.extend_from_slice(
            format!(
                "xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 5 /Root {root}R /Prev {prev} >>\nstartxref\n{offset}\n%%EOF\n"
            )
            .as_bytes(),
        );
        bytes
    }

    fn assert_admission_matches_appender(label: &str, bytes: &[u8], expected_appendable: bool) {
        let path = temp_path(label);
        fs::write(&path, bytes).unwrap();
        let admission = append_admission(&path, None).unwrap();
        let len = fs::metadata(&path).unwrap().len();
        let appender_accepts = load_incremental_pdf_path(&path, None).is_ok()
            && read_terminal_xref(&path, len).is_ok();
        fs::remove_file(&path).unwrap();
        assert_eq!(
            admission == AppendAdmission::Appendable,
            expected_appendable,
            "{label}: {admission:?}"
        );
        if !expected_appendable {
            assert!(
                matches!(admission, AppendAdmission::Repairable(_)),
                "{label}: {admission:?}"
            );
        }
        assert_eq!(
            appender_accepts, expected_appendable,
            "{label}: append loader disagrees"
        );
    }

    /// Admission must refuse exactly the files the append path cannot extend,
    /// and call that damage repairable.
    #[test]
    fn append_admission_matches_the_append_loader_and_terminal_guard() {
        let clean = one_page_pdf();
        let root = terminal_offset(&clean);
        let cases: [(&str, Vec<u8>, bool); 10] = [
            ("clean", clean.clone(), true),
            ("nul-padding", [clean.as_slice(), &[0; 100]].concat(), true),
            (
                "long-trailer",
                [clean.as_slice(), &[b'x'; 4096]].concat(),
                false,
            ),
            (
                "lopdf-window-trailer",
                [clean.as_slice(), &[b'x'; 700]].concat(),
                false,
            ),
            (
                "later-startxref",
                [clean.as_slice(), b"\n% startxref\n1\n"].concat(),
                false,
            ),
            (
                "unterminated-startxref",
                [clean.as_slice(), b"\nstartxref\n9\n"].concat(),
                false,
            ),
            ("valid-revision", with_revision(&clean, root), true),
            (
                "prev-outside-file",
                with_revision(&clean, 999_999_999),
                false,
            ),
            ("prev-into-garbage", with_revision(&clean, 1), false),
            ("prev-cycle", with_revision(&clean, clean.len()), false),
        ];
        for (label, bytes, expected) in cases {
            assert_admission_matches_appender(label, &bytes, expected);
        }
    }

    /// A damaged section is damaged however much of the file follows it: a
    /// /Prev into the header of a file larger than the probe ceiling must be
    /// repaired, not reported as a resource limit.
    #[test]
    fn append_admission_calls_an_early_bad_prev_in_a_large_file_repairable() {
        let clean = one_page_pdf();
        let mut padded = clean.clone();
        padded.extend_from_slice(b"\n%");
        padded.resize(padded.len() + 65 * 1024 * 1024, b'x');
        padded.push(b'\n');
        assert_admission_matches_appender("early-bad-prev", &with_revision(&padded, 1), false);
    }

    #[test]
    fn append_admission_refuses_a_startxref_that_points_at_no_section() {
        let clean = one_page_pdf();
        let marker = find_last_bytes(&clean, b"startxref").unwrap();
        let mut damaged = clean[..marker].to_vec();
        damaged.extend_from_slice(b"startxref\n1\n%%EOF\n");
        assert_admission_matches_appender("wrong-offset", &damaged, false);
    }

    /// PDF whitespace includes NUL, so a stream header written `8 0\0obj` is a
    /// valid base that must not be rewritten.
    #[test]
    fn append_admission_accepts_an_xref_stream_header_with_a_nul_separator() {
        let mut bytes = Vec::new();
        one_page_document().save_modern(&mut bytes).unwrap();
        let offset = terminal_offset(&bytes);
        let header_end = offset + find_bytes(&bytes[offset..], b"obj").unwrap();
        assert_eq!(bytes[header_end - 1], b' ');
        bytes[header_end - 1] = 0;
        assert_admission_matches_appender("nul-stream-header", &bytes, true);
    }

    /// A cross-reference table larger than the first probe window is read
    /// again through the wider window instead of being called damaged.
    #[test]
    fn append_admission_reads_a_cross_reference_table_past_its_first_window() {
        let mut document = one_page_document();
        document.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
        for index in 0..60_000_i64 {
            document.add_object(Object::Integer(index));
        }
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();
        let section_len = bytes.len() - terminal_offset(&bytes);
        assert!(section_len > 1024 * 1024, "{section_len}");
        assert_admission_matches_appender("large-xref-table", &bytes, true);
    }

    /// lopdf finds the terminal revision only when %%EOF starts within the last
    /// 512 bytes and startxref within the 25 bytes before it; admission must
    /// draw both lines exactly where the loader does.
    #[test]
    fn append_admission_draws_the_lopdf_locator_limits_where_the_loader_does() {
        let clean = one_page_pdf();
        let eof = find_last_bytes(&clean, b"%%EOF").unwrap();
        let after_eof = clean.len() - eof;
        for (trailing, expected) in [(512, true), (513, false)] {
            let mut bytes = clean.clone();
            bytes.resize(eof + trailing, 0);
            bytes[eof..eof + after_eof].copy_from_slice(&clean[eof..]);
            assert_admission_matches_appender(&format!("eof-{trailing}"), &bytes, expected);
        }
        let marker = find_last_bytes(&clean, b"startxref").unwrap();
        let offset = terminal_offset(&clean);
        let with_terminal = |terminal: String| [&clean[..marker], terminal.as_bytes()].concat();
        let digits = offset.to_string().len();
        let spaced = |distance: usize| {
            let spaces = " ".repeat(distance - b"startxref\n\n".len() - digits);
            format!("startxref\n{spaces}{offset}\n%%EOF\n")
        };
        let cases = [
            ("startxref-25", spaced(25), true),
            ("startxref-26", spaced(26), false),
            (
                "space-before-eol",
                format!("startxref \n{offset}\n%%EOF\n"),
                true,
            ),
            ("crlf", format!("startxref\r\n{offset}\r\n%%EOF\r\n"), true),
            (
                "tab-before-eol",
                format!("startxref\t\n{offset}\n%%EOF\n"),
                false,
            ),
            (
                "no-eol-before-eof",
                format!("startxref\n{offset} %%EOF\n"),
                false,
            ),
            (
                "signed-value",
                format!("startxref\n+{offset}\n%%EOF\n"),
                false,
            ),
        ];
        for (label, terminal, expected) in cases {
            assert_admission_matches_appender(label, &with_terminal(terminal), expected);
        }
        let shifted = [b"junk\n".as_slice(), clean.as_slice()].concat();
        assert_admission_matches_appender("bytes-before-header", &shifted, false);
    }

    /// Above the eager-load ceiling admission reads the page tree without
    /// recovery and applies the loader's page ceiling, but does not call the
    /// base appendable.
    #[cfg(unix)]
    #[test]
    fn large_base_admission_reports_repair_limit_or_unverified() {
        let path = temp_path("large-sparse");
        let mut file = File::create(&path).unwrap();
        let tail = b"startxref\n9\n%%EOF\n";
        let len = MAX_ENCODED_PDF_BYTES as u64 + 1024;
        file.set_len(len - tail.len() as u64).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all(tail).unwrap();
        drop(file);
        let qpdf_path = temp_path("large-fake-qpdf");
        for (script, expected) in [
            ("printf '3\\n'", "unverified"),
            ("printf '250000\\n'", "limited"),
            (
                "echo \"qpdf: can't find startxref\" >&2; exit 2",
                "repairable",
            ),
        ] {
            let _fake = crate::write_fake_executable(&qpdf_path, &format!("#!/bin/sh\n{script}\n"));
            let admission = append_admission(&path, Some(&qpdf_path)).unwrap();
            let verdict = match admission {
                AppendAdmission::Appendable => "appendable",
                AppendAdmission::Repairable(_) => "repairable",
                AppendAdmission::Limited(_) => "limited",
                AppendAdmission::Unverified(_) => "unverified",
            };
            assert_eq!(verdict, expected, "{script}: {admission:?}");
        }
        let _ = fs::remove_file(&qpdf_path);
        fs::remove_file(&path).unwrap();
    }
}
