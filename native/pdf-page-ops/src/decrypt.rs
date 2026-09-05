use evb_native_support::output::{AtomicOutput, ValidatedInputFiles};
use serde::{Deserialize, Serialize};

use super::*;

const DECRYPT_OUTCOME_FORMAT: &str = "evb-pdf-decrypt";
const DECRYPT_OUTCOME_SCHEMA_VERSION: u32 = 1;
const DECRYPT_OUTCOME_SIDECAR_SUFFIX: &str = ".decrypt.json";
const MAX_DECRYPT_PASSWORD_FILE_BYTES: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DecryptOutcome {
    Opened,
    Rewritten,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DecryptOutcomeReport {
    format: String,
    schema_version: u32,
    outcome: DecryptOutcome,
    was_encrypted: bool,
    revision: Option<i64>,
}

/// The outcome sidecar lives next to the decrypted output and mirrors the
/// `evb-pdf-annotation-*` sidecar pattern: one JSON document the Electron host
/// reads after the process exits successfully. `opened` means the input needed
/// no decryption and no output PDF was published; `rewritten` means the output
/// PDF is the decrypted working copy.
pub(crate) fn decrypt_outcome_sidecar_path(output_path: &Path) -> PathBuf {
    let file_name = match output_path.file_name() {
        Some(name) => format!("{}{DECRYPT_OUTCOME_SIDECAR_SUFFIX}", name.to_string_lossy()),
        None => format!("output{DECRYPT_OUTCOME_SIDECAR_SUFFIX}"),
    };
    output_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(file_name)
}

pub(crate) fn read_password_file(path: &Path) -> Result<String> {
    let bytes = read_file_bounded(path, MAX_DECRYPT_PASSWORD_FILE_BYTES, "PDF password")
        .map_err(|error| Box::new(error) as Box<dyn Error>)?;
    let mut password = String::from_utf8(bytes).map_err(|_| {
        domain_error(
            NativeErrorCode::InvalidRequest,
            "PDF password file must be UTF-8 text",
        )
    })?;
    // Trim one trailing newline so an editor-saved password file survives;
    // every other byte is part of the password.
    if password.ends_with('\n') {
        password.pop();
        if password.ends_with('\r') {
            password.pop();
        }
    }
    Ok(password)
}

fn input_exceeds_ceiling(path: &Path) -> Result<bool> {
    let length = fs::metadata(path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    Ok(length > MAX_ENCODED_PDF_BYTES as u64)
}

fn write_outcome_sidecar(output_path: &Path, report: &DecryptOutcomeReport) -> Result<()> {
    let mut output = AtomicOutput::create(&decrypt_outcome_sidecar_path(output_path))
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    serde_json::to_writer(
        output
            .file_mut()
            .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?,
        report,
    )?;
    output
        .publish()
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    Ok(())
}

fn opened_report() -> DecryptOutcomeReport {
    DecryptOutcomeReport {
        format: DECRYPT_OUTCOME_FORMAT.to_string(),
        schema_version: DECRYPT_OUTCOME_SCHEMA_VERSION,
        outcome: DecryptOutcome::Opened,
        was_encrypted: false,
        revision: None,
    }
}

/// Decrypts a password-protected PDF into a plaintext working copy.
///
/// The password arrives as a file path (`--password-file`), never on argv, so
/// it stays out of process listings. An absent password is an empty-password
/// attempt: lopdf then fails with `InvalidPassword` and the command reports
/// `needs-password`, while an owner-restricted file that uses the empty user
/// password decrypts silently. A file that was never encrypted reports
/// `opened` and publishes nothing, so an unprotected input is never
/// gratuitously reserialized.
pub(crate) fn write_decrypted_pdf_path(
    input_path: &Path,
    output_path: &Path,
    password_file: Option<&Path>,
) -> Result<()> {
    let _validated_input = validate_decrypt_paths(input_path, output_path, password_file)?;
    let password = password_file.map(read_password_file).transpose()?;

    write_decrypted_pdf_with_password(input_path, output_path, password.as_deref())
}

pub(crate) fn write_decrypted_pdf_with_password(
    input_path: &Path,
    output_path: &Path,
    password: Option<&str>,
) -> Result<()> {
    let _validated_input = ValidatedInputFiles::open(&[input_path.to_path_buf()], output_path)?;

    if input_exceeds_ceiling(input_path)? {
        if path_has_encryption_entry(input_path)? {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!(
                    "Encrypted PDF input exceeds the {}-byte admission ceiling and cannot be decrypted by the bounded reader",
                    MAX_ENCODED_PDF_BYTES
                ),
            ));
        }
        // Above the ceiling the bounded structural probe found no encryption
        // entry, so report the file as opened without reserializing it.
        return write_outcome_sidecar(output_path, &opened_report());
    }

    let bytes = read_file_bounded(input_path, MAX_ENCODED_PDF_BYTES, "PDF input")
        .map_err(|error| Box::new(error) as Box<dyn Error>)?;
    let mut document = load_pdf_bytes_bounded(&bytes, Some(password.unwrap_or("")))?;
    if document.is_encrypted() {
        return Err(domain_error(
            NativeErrorCode::NeedsPassword,
            "The encrypted PDF requires the correct password",
        ));
    }
    if !document.was_encrypted() {
        return write_outcome_sidecar(output_path, &opened_report());
    }

    let revision = document
        .encryption_state
        .as_ref()
        .map(|state| state.revision());
    let mut staged = AtomicOutput::create(output_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    document
        .save_to(
            staged
                .file_mut()
                .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?,
        )
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    staged
        .publish_if_unchanged()
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?;
    let report = DecryptOutcomeReport {
        format: DECRYPT_OUTCOME_FORMAT.to_string(),
        schema_version: DECRYPT_OUTCOME_SCHEMA_VERSION,
        outcome: DecryptOutcome::Rewritten,
        was_encrypted: true,
        revision,
    };
    if let Err(error) = write_outcome_sidecar(output_path, &report) {
        // The PDF and its outcome sidecar form one result. Do not leave a
        // published plaintext working copy behind when its receipt failed.
        let _ = fs::remove_file(output_path);
        return Err(error);
    }
    Ok(())
}

fn validate_decrypt_paths(
    input_path: &Path,
    output_path: &Path,
    password_file: Option<&Path>,
) -> Result<ValidatedInputFiles> {
    let validated_input = ValidatedInputFiles::open(&[input_path.to_path_buf()], output_path)?;
    if let Some(password_file) = password_file {
        ValidatedInputFiles::open(&[input_path.to_path_buf()], password_file)?;
        ValidatedInputFiles::open(&[password_file.to_path_buf()], output_path)?;
    }
    Ok(validated_input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_report_fixture_round_trips_and_rejects_unknown_fields() {
        let source = include_str!("../../protocol-fixtures/pdf-page-ops-decrypt.json");
        let parsed: DecryptOutcomeReport = serde_json::from_str(source).unwrap();
        assert_eq!(parsed.format, DECRYPT_OUTCOME_FORMAT);
        assert_eq!(parsed.schema_version, DECRYPT_OUTCOME_SCHEMA_VERSION);
        assert_eq!(parsed.outcome, DecryptOutcome::Rewritten);
        assert_eq!(parsed.revision, Some(6));

        let with_unknown = source.replacen("{", r#"{"unknownField":true,"#, 1);
        assert!(serde_json::from_str::<DecryptOutcomeReport>(&with_unknown).is_err());
    }

    #[test]
    fn outcome_report_accepts_the_opened_variant() {
        let report: DecryptOutcomeReport = serde_json::from_str(
            r#"{"format":"evb-pdf-decrypt","schemaVersion":1,"outcome":"opened","wasEncrypted":false,"revision":null}"#,
        )
        .unwrap();
        assert_eq!(report.outcome, DecryptOutcome::Opened);
        assert!(!report.was_encrypted);
    }

    #[test]
    fn outcome_sidecar_is_derived_from_the_output_path() {
        assert_eq!(
            decrypt_outcome_sidecar_path(Path::new("/tmp/work/decrypted.pdf")),
            PathBuf::from("/tmp/work/decrypted.pdf.decrypt.json")
        );
    }
}
