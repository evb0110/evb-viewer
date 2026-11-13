//! Locates an external tool that native integration tests drive. Test targets
//! include this file with `#[path]`, so `CARGO_MANIFEST_DIR` is the including
//! crate's directory under `native/`.

use std::{
    env,
    path::{Path, PathBuf},
};

/// Resolve an external tool: an explicit `override_var`, then `PATH` (CI
/// installs `poppler-utils` and `qpdf`), then the copy the app bundles under
/// `resources/<bundle>/<platform>/bin` after `pnpm fetch:runtime-binaries`.
/// Windows has no system package for these tools, so the bundle is how a
/// Windows checkout runs the suite. A bare name resolves through `PATH` to an
/// absolute path, because the app looks for qpdf's libraries beside the path
/// it is given.
pub fn tool_path(override_var: &str, bundle: &str, name: &str) -> PathBuf {
    if let Some(path) = env::var_os(override_var).map(PathBuf::from) {
        let bare = path.components().count() == 1;
        return bare.then(|| on_path(&path)).flatten().unwrap_or(path);
    }
    if let Some(path) = on_path(Path::new(name)) {
        return path;
    }
    let bundled = bundled_tool_path(bundle, name);
    assert!(
        bundled.is_file(),
        "{name} is not on PATH and {} is absent; install it, set {override_var}, \
         or run `pnpm fetch:runtime-binaries`",
        bundled.display(),
    );
    bundled
}

/// The copy the app bundles under `resources/<bundle>/<platform>/bin`, which
/// may be absent before `pnpm fetch:runtime-binaries`.
pub fn bundled_tool_path(bundle: &str, name: &str) -> PathBuf {
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../resources")
        .join(bundle)
        .join(format!("{os}-{arch}"))
        .join("bin")
        .join(format!("{name}{}", env::consts::EXE_SUFFIX))
}

/// The absolute path of executable `name` in the first `PATH` directory that
/// has it.
fn on_path(name: &Path) -> Option<PathBuf> {
    let mut executable = name.as_os_str().to_owned();
    if name.extension().is_none() {
        executable.push(env::consts::EXE_SUFFIX);
    }
    env::split_paths(&env::var_os("PATH")?)
        .map(|directory| directory.join(&executable))
        .find(|path| path.is_file())
        .and_then(|path| std::path::absolute(path).ok())
}
