//! `exchange-paths STAGED DESTINATION`: swaps two regular files in one
//! directory in a single atomic step, so a checked desktop Save never leaves
//! the saved path missing (#353). It prints `{"status":"exchanged"}` or
//! `{"status":"unsupported","reason":...}` on stdout; any other failure is the
//! usual error envelope with nothing moved. It is not a general rename.

use super::*;

pub(crate) fn run_exchange_paths(args: &[String]) -> Result<()> {
    let [staged, destination] = args else {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "exchange-paths takes exactly a staged file and a destination",
        ));
    };
    let (staged, destination) = (Path::new(staged), Path::new(destination));
    check_sibling_files(staged, destination)?;
    let report = match exchange(staged, destination)? {
        None => serde_json::json!({"status": "exchanged"}),
        Some(reason) => serde_json::json!({"status": "unsupported", "reason": reason}),
    };
    println!("{report}");
    Ok(())
}

/// Both names must be existing regular files, not links, in one directory.
fn check_sibling_files(staged: &Path, destination: &Path) -> Result<()> {
    for path in [staged, destination] {
        if !fs::symlink_metadata(path)?.file_type().is_file() {
            return Err(domain_error(
                NativeErrorCode::InvalidRequest,
                format!("exchange-paths needs a regular file: {}", path.display()),
            ));
        }
    }
    let folder = |path: &Path| match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => fs::canonicalize(parent),
        _ => fs::canonicalize("."),
    };
    if staged.file_name() == destination.file_name() || folder(staged)? != folder(destination)? {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "exchange-paths needs two different files in one directory",
        ));
    }
    Ok(())
}

/// `None` once exchanged; the reason when this volume or platform has no exchange, with nothing moved.
#[cfg(target_os = "macos")]
fn exchange(staged: &Path, destination: &Path) -> Result<Option<&'static str>> {
    let (from, to) = (c_path(staged)?, c_path(destination)?);
    // FAT volumes accept RENAME_SWAP and perform a plain rename over the
    // destination, so only an affirmative volume capability is trusted.
    #[repr(C)]
    struct VolumeCapabilities {
        length: u32,
        capabilities: libc::vol_capabilities_attr_t,
    }
    let mut request = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_CAPABILITIES,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut answer = std::mem::MaybeUninit::<VolumeCapabilities>::zeroed();
    // SAFETY: both pointers name live buffers of the sizes passed.
    let status = unsafe {
        libc::getattrlist(
            to.as_ptr(),
            (&raw mut request).cast(),
            answer.as_mut_ptr().cast(),
            std::mem::size_of::<VolumeCapabilities>(),
            libc::FSOPT_NOFOLLOW,
        )
    };
    if status != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: zero-initialized plain integers, filled by a successful call.
    let interfaces = unsafe { answer.assume_init() }.capabilities;
    let index = libc::VOL_CAPABILITIES_INTERFACES;
    let swap = libc::VOL_CAP_INT_RENAME_SWAP;
    if interfaces.valid[index] & swap == 0 || interfaces.capabilities[index] & swap == 0 {
        return Ok(Some("volume-has-no-rename-swap"));
    }
    // SAFETY: both arguments are NUL-terminated paths that outlive the call.
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_SWAP) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(None)
}

#[cfg(target_os = "linux")]
fn exchange(staged: &Path, destination: &Path) -> Result<Option<&'static str>> {
    const EXFAT_SUPER_MAGIC: u64 = 0x2011_BAB0;
    let (from, to) = (c_path(staged)?, c_path(destination)?);
    // FAT-family volumes number inodes in memory, so the staged file's
    // witness would not survive a restart; they keep the present sequence.
    let mut volume = std::mem::MaybeUninit::<libc::statfs>::zeroed();
    // SAFETY: a NUL-terminated path and a buffer of the type statfs fills.
    if unsafe { libc::statfs(to.as_ptr(), volume.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: zero-initialized plain integers, filled by a successful call.
    let kind = unsafe { volume.assume_init() }.f_type as u64;
    if kind == libc::MSDOS_SUPER_MAGIC as u64 || kind == EXFAT_SUPER_MAGIC {
        return Ok(Some("fat-volume"));
    }
    // The raw system call does not depend on the glibc version shipping renameat2.
    // SAFETY: two NUL-terminated paths that outlive the call, relative to the working directory.
    let status = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    if status == 0 {
        return Ok(None);
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EINVAL | libc::ENOSYS | libc::EOPNOTSUPP) => {
            Ok(Some("filesystem-has-no-rename-exchange"))
        }
        _ => Err(error.into()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn exchange(_staged: &Path, _destination: &Path) -> Result<Option<&'static str>> {
    Ok(Some("platform-has-no-exchange"))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn c_path(path: &Path) -> Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    Ok(std::ffi::CString::new(path.as_os_str().as_bytes())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "evb-exchange-paths-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn exchanges_two_files_whole() {
        let dir = folder("swap");
        let (staged, destination) = (dir.join(".0123456789abcdef.tmp"), dir.join("a.pdf"));
        fs::write(&staged, b"new bytes").unwrap();
        fs::write(&destination, b"old").unwrap();
        let identity = |path: &Path| {
            let metadata = fs::symlink_metadata(path).unwrap();
            #[cfg(unix)]
            return std::os::unix::fs::MetadataExt::ino(&metadata);
            #[cfg(not(unix))]
            return metadata.len();
        };
        let (staged_id, destination_id) = (identity(&staged), identity(&destination));
        check_sibling_files(&staged, &destination).unwrap();
        let outcome = exchange(&staged, &destination).unwrap();
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            assert_eq!(outcome, None, "the temp folder's volume should exchange");
            assert_eq!(fs::read(&destination).unwrap(), b"new bytes");
            assert_eq!(fs::read(&staged).unwrap(), b"old");
            assert_eq!(identity(&destination), staged_id);
            assert_eq!(identity(&staged), destination_id);
        } else {
            assert!(outcome.is_some());
            assert_eq!(fs::read(&destination).unwrap(), b"old");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_anything_but_two_sibling_files_and_moves_nothing() {
        let dir = folder("refuse");
        let other = folder("refuse-other");
        let staged = dir.join(".0123456789abcdef.tmp");
        fs::write(&staged, b"new").unwrap();
        fs::write(other.join("a.pdf"), b"old").unwrap();
        let args = |destination: PathBuf| {
            vec![
                staged.display().to_string(),
                destination.display().to_string(),
            ]
        };
        assert!(run_exchange_paths(&args(dir.join("missing.pdf"))).is_err());
        assert!(run_exchange_paths(&args(other.join("a.pdf"))).is_err());
        assert!(run_exchange_paths(&args(dir.clone())).is_err());
        assert!(run_exchange_paths(&args(staged.clone())).is_err());
        assert!(run_exchange_paths(&[staged.display().to_string()]).is_err());
        assert_eq!(fs::read(&staged).unwrap(), b"new");
        assert!(!dir.join("missing.pdf").exists());
        assert_eq!(fs::read(other.join("a.pdf")).unwrap(), b"old");
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(other).unwrap();
    }
}
