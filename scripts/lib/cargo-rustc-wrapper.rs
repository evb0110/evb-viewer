use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let result =
        Command::new(std::env::var_os("EVB_CARGO_NODE").expect("EVB_CARGO_NODE is required"))
            .arg(
                std::env::var_os("EVB_CARGO_WRAPPER_SCRIPT")
                    .expect("EVB_CARGO_WRAPPER_SCRIPT is required"),
            )
            .args(std::env::args_os().skip(1))
            .status();
    match result {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(error) => {
            eprintln!("failed to start Cargo rustc wrapper: {error}");
            ExitCode::FAILURE
        }
    }
}
