use super::*;

const TERMINAL_TAIL_BYTES: u64 = 1024 * 1024;
// lopdf 0.44, which reads every append base up to MAX_ENCODED_PDF_BYTES, looks
// for the last %%EOF only in a file's final 512 bytes and for startxref only in
// the 25 bytes before that marker.
const LOPDF_EOF_SEARCH_BYTES: usize = 512;
const LOPDF_STARTXREF_SEARCH_BYTES: usize = 25;
const LOPDF_HEADER_LINE_BYTES: usize = 64 * 1024;
/// qpdf takes the last `startxref` followed by an integer that starts in a
/// file's final 1054 bytes; with recovery off it refuses a file without one.
pub(crate) const QPDF_STARTXREF_SEARCH_BYTES: u64 = 1054;

/// qpdf's tokenizer space: PDF whitespace and vertical tab.
fn is_qpdf_space(byte: u8) -> bool {
    is_pdf_whitespace(byte) || byte == 0x0b
}

/// What ends a qpdf token: a space or a PDF delimiter.
fn is_qpdf_delimiter(byte: u8) -> bool {
    is_qpdf_space(byte) || is_pdf_delimiter(byte)
}

/// The token qpdf reads at `at`, after spaces and `%` comments, when it is
/// an integer: an optional sign, digits, then the end of the input or a
/// delimiter. `Some(None)` is an integer no offset can be, such as `-1`.
fn qpdf_integer(bytes: &[u8], mut at: usize) -> Option<Option<u64>> {
    loop {
        match bytes.get(at) {
            Some(byte) if is_qpdf_space(*byte) => at += 1,
            Some(b'%') => {
                while bytes
                    .get(at)
                    .is_some_and(|byte| !matches!(byte, b'\r' | b'\n'))
                {
                    at += 1;
                }
            }
            _ => break,
        }
    }
    let negative = bytes.get(at) == Some(&b'-');
    if matches!(bytes.get(at), Some(b'+' | b'-')) {
        at += 1;
    }
    let digits = bytes[at.min(bytes.len())..]
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let end = at + digits;
    if digits == 0 || bytes.get(end).is_some_and(|byte| !is_qpdf_delimiter(*byte)) {
        return None;
    }
    let value = std::str::from_utf8(&bytes[at..end])
        .ok()?
        .parse::<u64>()
        .ok();
    Some(value.filter(|_| !negative))
}

/// The terminal cross-reference offset qpdf's locator reads, from `tail`,
/// the file's bytes from `tail_start` to its end at `file_len`: the last
/// `startxref` in the final 1054 bytes that qpdf's tokenizer reads as that
/// word followed by an integer. Every append, of any size, extends this
/// revision: qpdf reads appended files without recovery, and the indexed
/// reader takes the same `startxref` only here. An integer no offset can be
/// stops the search, as it makes qpdf refuse the file.
pub(crate) fn qpdf_terminal_xref(tail: &[u8], tail_start: u64, file_len: u64) -> Option<u64> {
    let window = usize::try_from(
        file_len
            .saturating_sub(QPDF_STARTXREF_SEARCH_BYTES)
            .saturating_sub(tail_start),
    )
    .ok()?
    .min(tail.len());
    let mut end = tail.len();
    while let Some(at) = find_last_bytes(&tail[window..end], b"startxref") {
        let at = window + at;
        let after = at + b"startxref".len();
        let word_ends = tail.get(after).is_none_or(|byte| is_qpdf_delimiter(*byte));
        if let Some(offset) = qpdf_integer(tail, after).filter(|_| word_ends) {
            return offset;
        }
        end = after - 1;
    }
    None
}

struct TerminalXref {
    offset: u64,
}

fn read_tail(file: &mut (impl Read + Seek), file_len: u64) -> std::io::Result<(u64, Vec<u8>)> {
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

/// Runs the append loaders' structural acceptance: the terminal-xref guard,
/// then for an eager base lopdf's startxref locator and the loader's
/// cross-reference chain preflight. Every base then gets the indexed read
/// annotation, label and OCR saves open it with (`indexed_base_admission`).
pub(crate) fn append_admission(path: &Path) -> Result<AppendAdmission> {
    let mut file = File::open(path).map_err(io_domain_error)?;
    let file_len = file.metadata().map_err(io_domain_error)?.len();
    let admission = append_admission_from(&mut file, file_len, PDF_PATH_LOAD_POLICY, || {
        Ok(AppendAdmission::Unverified(
            "PDF exceeds eager append-admission ceiling; verified through indexed reader"
                .to_string(),
        ))
    })?;
    indexed_base_admission(admission, &file, file_len)
}

/// Saves open their base through the cross-reference index, which refuses
/// damage the chain preflight does not reach, such as an entry that points at
/// another object, as `corrupt-xref`: a rewrite repairs that. A resource
/// ceiling the index meets is a limit. Any other refusal, such as encryption
/// the unlock flow removes or a damaged page tree, is the save's to report.
fn indexed_base_admission<S: ByteSource>(
    admission: AppendAdmission,
    source: S,
    len: u64,
) -> Result<AppendAdmission> {
    if !matches!(
        admission,
        AppendAdmission::Appendable | AppendAdmission::Unverified(_)
    ) {
        return Ok(admission);
    }
    let Err(error) =
        SourcePdf::open_append_base(source, len).and_then(|mut pdf| pdf.take_append_base())
    else {
        return Ok(admission);
    };
    match error.downcast_ref::<NativeError>().map(|error| error.code) {
        Some(NativeErrorCode::CorruptXref) => Ok(AppendAdmission::Repairable(error.to_string())),
        Some(NativeErrorCode::TooLarge) => Ok(AppendAdmission::Limited(error.to_string())),
        // A file that cannot be read was not judged.
        Some(NativeErrorCode::Io) => Err(error),
        _ => Ok(admission),
    }
}

/// The same admission for a PDF held in memory, as the browser holds its
/// working copies, judged against the browser buffer's policy: only a base its
/// buffer cannot carry is refused, as the engine limit it is.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn append_admission_of_bytes(bytes: &[u8]) -> Result<AppendAdmission> {
    let admission = append_admission_from(
        &mut std::io::Cursor::new(bytes),
        u64::try_from(bytes.len())?,
        BROWSER_PDF_LOAD_POLICY,
        || {
            Ok(AppendAdmission::Limited(
                "PDF exceeds the browser engine's request buffer".to_string(),
            ))
        },
    )?;
    indexed_base_admission(admission, bytes, u64::try_from(bytes.len())?)
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
struct ByteSourceReadSeek<'a, S> {
    source: &'a S,
    len: u64,
    pos: u64,
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
impl<S: ByteSource> Read for ByteSourceReadSeek<'_, S> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let remaining = self.len.saturating_sub(self.pos);
        let to_read = remaining.min(buf.len() as u64) as usize;
        if to_read == 0 {
            return Ok(0);
        }
        self.source.read_at(self.pos, &mut buf[..to_read])?;
        self.pos += to_read as u64;
        Ok(to_read)
    }
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
impl<S: ByteSource> Seek for ByteSourceReadSeek<'_, S> {
    fn seek(&mut self, style: SeekFrom) -> std::io::Result<u64> {
        let target: i128 = match style {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(delta) => i128::from(self.len) + i128::from(delta),
            SeekFrom::Current(delta) => i128::from(self.pos) + i128::from(delta),
        };
        if target < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid seek to a negative position",
            ));
        }
        self.pos = u64::try_from(target).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "seek position overflows u64",
            )
        })?;
        Ok(self.pos)
    }
}

/// The same append admission as `append_admission_of_bytes`, reading only the
/// header, tail, cross-reference sections, and reachable objects by range from
/// `source`, without copying the full PDF into memory.
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) fn append_admission_of_source<S: ByteSource>(
    source: S,
    len: u64,
) -> Result<AppendAdmission> {
    let mut reader = ByteSourceReadSeek {
        source: &source,
        len,
        pos: 0,
    };
    let admission = append_admission_from(&mut reader, len, BROWSER_PDF_LOAD_POLICY, || {
        Ok(AppendAdmission::Limited(
            "PDF exceeds the browser engine's request buffer".to_string(),
        ))
    })?;
    indexed_base_admission(admission, source, len)
}

/// Desktop-policy append admission over a range-read `ByteSource`. Uses
/// `PDF_PATH_LOAD_POLICY` so files above the eager-load ceiling are not
/// rejected as `limited` by the browser buffer cap and are still checked by
/// `SourcePdf::open_append_base`.
#[cfg(all(target_family = "wasm", target_os = "unknown"))]
pub(crate) fn append_admission_of_source_desktop<S: ByteSource>(
    source: S,
    len: u64,
) -> Result<AppendAdmission> {
    let mut reader = ByteSourceReadSeek {
        source: &source,
        len,
        pos: 0,
    };
    let admission = append_admission_from(&mut reader, len, PDF_PATH_LOAD_POLICY, || {
        Ok(AppendAdmission::Unverified(
            "PDF exceeds eager append-admission ceiling; verified through indexed reader"
                .to_string(),
        ))
    })?;
    indexed_base_admission(admission, source, len)
}

fn append_admission_from(
    file: &mut (impl Read + Seek),
    file_len: u64,
    policy: PdfLoadPolicy,
    large_base: impl FnOnce() -> Result<AppendAdmission>,
) -> Result<AppendAdmission> {
    let (tail_start, tail) = read_tail(file, file_len).map_err(io_domain_error)?;
    let terminal = match find_terminal_xref(&tail, file_len) {
        Ok(terminal) => terminal,
        Err(refusal) => return Ok(AppendAdmission::Repairable(refusal.to_string())),
    };
    if qpdf_terminal_xref(&tail, tail_start, file_len) != Some(terminal.offset) {
        return Ok(AppendAdmission::Repairable(
            "PDF terminal startxref is not where qpdf reads it".to_string(),
        ));
    }
    if file_len > policy.max_encoded_bytes() as u64 {
        return large_base();
    }
    if !lopdf_reads_header(file)? {
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
    match check_xref_chain(root, input_len, policy, |offset, window_len| {
        let window = read_window(file, offset, window_len.min(input_len - offset))?;
        let truncated = offset + window.len() < input_len;
        Ok((std::borrow::Cow::Owned(window), truncated))
    }) {
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
fn lopdf_reads_header(file: &mut (impl Read + Seek)) -> Result<bool> {
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

pub(crate) fn read_window(
    file: &mut (impl Read + Seek),
    offset: usize,
    len: usize,
) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(io_domain_error)?;
    let mut window = vec![0; len];
    file.read_exact(&mut window).map_err(io_domain_error)?;
    Ok(window)
}

pub(crate) fn write_append_admission(input_path: &Path, output: &mut impl Write) -> Result<()> {
    let (verdict, reason) = match append_admission(input_path)? {
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

    /// Appends open their base by index; split, overlay text and print
    /// layout below their byte budgets still load the whole file eagerly.
    fn assert_admission_matches_appender(label: &str, bytes: &[u8], expected_appendable: bool) {
        let path = temp_path(label);
        fs::write(&path, bytes).unwrap();
        let admission = append_admission(&path).unwrap();
        let len = fs::metadata(&path).unwrap().len();
        let appender_accepts = load_pdf_path(&path).is_ok()
            && SourcePdf::open_append_base(bytes, len)
                .and_then(|mut pdf| pdf.take_append_base())
                .is_ok()
            && read_terminal_xref(&path, len).is_ok();
        fs::remove_file(&path).unwrap();
        assert_eq!(
            append_admission_of_bytes(bytes).unwrap(),
            admission,
            "{label}: the browser's in-memory admission disagrees"
        );
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
        // One page over a stream that lifts the file past the eager ceiling,
        // left sparse.
        let mut offsets = Vec::new();
        for object in [
            "<</Type/Catalog/Pages 2 0 R>>",
            "<</Type/Pages/Count 1/Kids[3 0 R]>>",
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>",
        ] {
            if offsets.is_empty() {
                file.write_all(b"%PDF-1.7\n").unwrap();
            }
            offsets.push(file.stream_position().unwrap());
            let number = offsets.len();
            write!(file, "{number} 0 obj\n{object}\nendobj\n").unwrap();
        }
        let padding = MAX_ENCODED_PDF_BYTES as u64;
        offsets.push(file.stream_position().unwrap());
        write!(file, "4 0 obj\n<</Length {padding}>>\nstream\n").unwrap();
        file.seek(SeekFrom::Current(padding as i64)).unwrap();
        file.write_all(b"\nendstream\nendobj\n").unwrap();
        let xref = file.stream_position().unwrap();
        file.write_all(b"xref\n0 5\n0000000000 65535 f \n").unwrap();
        for offset in offsets {
            writeln!(file, "{offset:010} 00000 n ").unwrap();
        }
        write!(
            file,
            "trailer\n<</Size 5/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n"
        )
        .unwrap();
        drop(file);
        let admission = append_admission(&path).unwrap();
        assert!(
            matches!(admission, AppendAdmission::Unverified(_)),
            "expected large valid base to be unverified: {admission:?}"
        );
        fs::remove_file(&path).unwrap();
    }

    /// What qpdf 12 without recovery reads of two revisions whose terminal
    /// `startxref` is spelled each way: the newer one (222), the older one
    /// (111) when the newer spelling is not an integer token, or nothing when
    /// it is an integer no offset can be.
    #[test]
    fn qpdf_locator_tokenizes_the_terminal_offset_as_qpdf_does() {
        let cases: [(&[u8], Option<u64>); 13] = [
            (b"\n222\n", Some(222)),
            (b"\n222\x0b\n", Some(222)),
            (b"\x0b222\n", Some(222)),
            (b"\x00222\n", Some(222)),
            (b"\n%c\n222\n", Some(222)),
            (b"\n%c\r222\n", Some(222)),
            (b"\n222%c\n", Some(222)),
            (b"\n+222\n", Some(222)),
            (b"/222\n", Some(111)),
            (b"222\n", Some(111)),
            (b"\n222x\n", Some(111)),
            (b"\n222.0\n", Some(111)),
            (b"\n-5\n", None),
        ];
        for (terminal, expected) in cases {
            let mut bytes = b"startxref\n111\n%%EOF\nxref\n3 1\n".to_vec();
            bytes.extend_from_slice(b"startxref");
            bytes.extend_from_slice(terminal);
            bytes.extend_from_slice(b"%%EOF\n");
            assert_eq!(
                qpdf_terminal_xref(&bytes, 0, bytes.len() as u64),
                expected,
                "{}",
                String::from_utf8_lossy(terminal).escape_debug()
            );
        }
    }
}
