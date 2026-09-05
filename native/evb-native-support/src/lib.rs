use serde::Serialize;
use std::{any::Any, error::Error};
use thiserror::Error;

pub mod bounded_io;
pub mod generated_native_tool_protocols;
pub mod output;
pub mod pdf_catalog;
pub mod wasm_request_allocation;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeToolDescriptor {
    pub binary_name: &'static str,
    pub protocol_version: u32,
}

impl NativeToolDescriptor {
    pub const fn new(binary_name: &'static str, protocol_version: u32) -> Self {
        Self {
            binary_name,
            protocol_version,
        }
    }
}

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

pub fn run_native_cli<F>(
    descriptor: NativeToolDescriptor,
    package_version: &'static str,
    args: impl IntoIterator<Item = String>,
    operation: F,
) where
    F: FnOnce(Vec<String>) -> Result<(), Box<dyn Error>> + std::panic::UnwindSafe,
{
    let args = args.into_iter().collect::<Vec<_>>();
    run_cli_caught(move || {
        if let Some(output) = standard_cli_output(descriptor, package_version, &args) {
            print!("{output}");
            return Ok(());
        }
        operation(args)
    });
}

fn standard_cli_output(
    descriptor: NativeToolDescriptor,
    package_version: &str,
    args: &[String],
) -> Option<String> {
    match args {
        [flag] if flag == "--protocol-version" => {
            Some(format!("{}\n", descriptor.protocol_version))
        }
        [flag] if flag == "--version" || flag == "-V" => {
            Some(format!("{} {package_version}\n", descriptor.binary_name))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use generated_native_tool_protocols::{
        ALL_NATIVE_TOOL_DESCRIPTORS, PDF_IMAGE_COMBINE, PDF_PAGE_OPS, PDF_SEARCH, SCAN_CLEANUP,
    };

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
    fn generated_descriptors_drive_exact_standard_flag_output() {
        let expected = [
            (PDF_IMAGE_COMBINE, 4),
            (PDF_PAGE_OPS, 1),
            (PDF_SEARCH, 1),
            (SCAN_CLEANUP, 10),
        ];
        assert_eq!(
            ALL_NATIVE_TOOL_DESCRIPTORS,
            expected
                .iter()
                .map(|(descriptor, _)| *descriptor)
                .collect::<Vec<_>>()
        );

        for (descriptor, protocol_version) in expected {
            assert_eq!(descriptor.protocol_version, protocol_version);
            assert_eq!(
                standard_cli_output(descriptor, "9.8.7", &["--protocol-version".to_string()]),
                Some(format!("{protocol_version}\n"))
            );
            for flag in ["--version", "-V"] {
                assert_eq!(
                    standard_cli_output(descriptor, "9.8.7", &[flag.to_string()]),
                    Some(format!("{} 9.8.7\n", descriptor.binary_name))
                );
            }
            assert_eq!(
                standard_cli_output(
                    descriptor,
                    "9.8.7",
                    &["--protocol-version".to_string(), "extra".to_string()]
                ),
                None
            );
        }
    }
}
