//! Locates an external tool that native integration tests drive. Test targets
//! include this file with `#[path]`, so `CARGO_MANIFEST_DIR` is the including
//! crate's directory under `native/`.

use std::{env, path::PathBuf};

/// Resolve an external tool: an explicit `override_var`, then `PATH` (CI
/// installs `poppler-utils` and `qpdf`), then the copy the app bundles under
/// `resources/<bundle>/<platform>/bin` after `pnpm fetch:runtime-binaries`.
/// Windows has no system package for these tools, so the bundle is how a
/// Windows checkout runs the suite.
pub fn tool_path(override_var: &str, bundle: &str, name: &str) -> PathBuf {
    if let Some(path) = env::var_os(override_var) {
        return PathBuf::from(path);
    }
    let executable = format!("{name}{}", env::consts::EXE_SUFFIX);
    if let Some(path) = env::var_os("PATH") {
        if env::split_paths(&path).any(|directory| directory.join(&executable).is_file()) {
            return PathBuf::from(name);
        }
    }
    let os = match env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        os => os,
    };
    let arch = match env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        arch => arch,
    };
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../resources")
        .join(bundle)
        .join(format!("{os}-{arch}"))
        .join("bin")
        .join(&executable);
    assert!(
        bundled.is_file(),
        "{name} is not on PATH and {} is absent; install it, set {override_var}, \
         or run `pnpm fetch:runtime-binaries`",
        bundled.display(),
    );
    bundled
}
