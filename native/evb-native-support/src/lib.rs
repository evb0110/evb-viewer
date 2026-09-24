use serde::Serialize;
use std::{any::Any, error::Error};
use thiserror::Error;

pub mod bounded_io;
pub mod output;
pub mod pdf_catalog;
pub mod wasm_request_allocation;

pub const MAX_WORKER_THREADS: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Error)]
#[serde(rename_all = "kebab-case")]
pub enum NativeErrorCode {
    #[error("encrypted")]
    Encrypted,
    #[error("needs-password")]
    NeedsPassword,
    #[error("too-large")]
    TooLarge,
    #[error("corrupt-xref")]
    CorruptXref,
    #[error("unsupported-filter")]
    UnsupportedFilter,
    #[error("invalid-request")]
    InvalidRequest,
    #[error("io")]
    Io,
    #[error("timeout")]
    Timeout,
    #[error("panic")]
    Panic,
    #[error("native-failure")]
    NativeFailure,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct NativeError {
    pub code: NativeErrorCode,
    pub message: String,
}

impl NativeError {
    pub fn new(code: NativeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeErrorEnvelope {
    pub code: NativeErrorCode,
    pub message: String,
}

impl NativeErrorEnvelope {
    pub fn from_error(error: &(dyn Error + 'static)) -> Self {
        let code = if let Some(native_error) = error.downcast_ref::<NativeError>() {
            native_error.code
        } else if error.downcast_ref::<std::io::Error>().is_some() {
            NativeErrorCode::Io
        } else {
            NativeErrorCode::NativeFailure
        };
        Self {
            code,
            message: error.to_string(),
        }
    }

    pub fn from_panic(payload: Box<dyn Any + Send>) -> Self {
        let message = payload
            .downcast_ref::<&str>()
            .map(|message| (*message).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "Native tool panicked".to_string());
        Self {
            code: NativeErrorCode::Panic,
            message,
        }
    }

    pub fn write_stderr(&self) {
        eprintln!("{}", self.to_json());
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"code":"native-failure","message":"Failed to serialize native error"}"#.to_string()
        })
    }
}

pub fn run_cli_caught<F>(operation: F)
where
    F: FnOnce() -> Result<(), Box<dyn Error>> + std::panic::UnwindSafe,
{
    match std::panic::catch_unwind(operation) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            NativeErrorEnvelope::from_error(error.as_ref()).write_stderr();
            std::process::exit(1);
        }
        Err(payload) => {
            NativeErrorEnvelope::from_panic(payload).write_stderr();
            std::process::exit(70);
        }
    }
}

/// Runs a native tool's CLI. `--version` and `--build-id` are answered here;
/// the build ID is the source hash `scripts/native-build-id.mjs` passes to the
/// build, which Electron compares before it first runs the binary.
pub fn run_native_cli<F>(
    binary_name: &'static str,
    package_version: &'static str,
    build_id: Option<&'static str>,
    args: impl IntoIterator<Item = String>,
    operation: F,
) where
    F: FnOnce(Vec<String>) -> Result<(), Box<dyn Error>> + std::panic::UnwindSafe,
{
    let args = args.into_iter().collect::<Vec<_>>();
    run_cli_caught(move || {
        if let Some(output) = standard_cli_output(binary_name, package_version, build_id, &args) {
            print!("{output}");
            return Ok(());
        }
        operation(args)
    });
}

fn standard_cli_output(
    binary_name: &str,
    package_version: &str,
    build_id: Option<&str>,
    args: &[String],
) -> Option<String> {
    match args {
        [flag] if flag == "--build-id" => Some(format!("{}\n", build_id.unwrap_or("none"))),
        [flag] if flag == "--version" || flag == "-V" => {
            Some(format!("{binary_name} {package_version}\n"))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_typed_domain_codes_in_serialized_envelopes() {
        for code in [
            NativeErrorCode::Encrypted,
            NativeErrorCode::NeedsPassword,
            NativeErrorCode::TooLarge,
            NativeErrorCode::CorruptXref,
            NativeErrorCode::UnsupportedFilter,
            NativeErrorCode::InvalidRequest,
        ] {
            let error = NativeError::new(code, "localized detail");
            let envelope = NativeErrorEnvelope::from_error(&error);
            assert_eq!(envelope.code, code);
            assert!(envelope.to_json().contains("localized detail"));
        }
    }

    #[test]
    fn answers_standard_flags_only_when_they_are_the_sole_argument() {
        let output = |args: &[&str], build_id| {
            let args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
            standard_cli_output("evb-tool", "9.8.7", build_id, &args)
        };
        assert_eq!(output(&["--build-id"], Some("abc")), Some("abc\n".into()));
        assert_eq!(output(&["--build-id"], None), Some("none\n".into()));
        assert_eq!(
            output(&["--version"], None),
            Some("evb-tool 9.8.7\n".into())
        );
        assert_eq!(output(&["-V"], None), Some("evb-tool 9.8.7\n".into()));
        assert_eq!(output(&["--build-id", "extra"], Some("abc")), None);
    }
}
