use std::{
    error::Error,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use crate::{NativeError, NativeErrorCode};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const WITNESS_SAMPLE_BYTES: usize = 64 * 1024;

fn create_exclusive_temporary_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    options.open(path)
}

fn open_existing_temporary_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    options.open(path)
}

fn open_destination_without_following_symlinks(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    options.open(path)
}

/// Owns an unpublished sibling file until it is durably replaced into place.
///
/// An output destination may be the same path as an input or a hard link to an
/// input. Staging never truncates the destination. Publication replaces only
/// the destination directory entry, so other hard links keep the old bytes.
/// A failed or dropped output leaves every existing alias unchanged.
pub struct AtomicOutput {
    file: Option<File>,
    temporary_path: PathBuf,
    destination_path: PathBuf,
    destination_state: Option<DestinationState>,
    published: bool,
}

struct DestinationState {
    permissions: fs::Permissions,
    witness: PathRevisionWitness,
}

struct DestinationSnapshot {
    identity: Option<FileIdentity>,
    length: u64,
    modified: Option<std::time::SystemTime>,
    sample: Vec<u8>,
    #[cfg(unix)]
    changed: (i64, i64),
}

/// Keeps one regular-file revision admitted across a path-backed native operation.
///
/// The witness retains the admitted file descriptor and compares it with a
/// fresh open of the same path. Its samples are bounded, so admission does not
/// become proportional to a multi-gigabyte input.
pub struct PathRevisionWitness {
    file: File,
    path: PathBuf,
    snapshot: DestinationSnapshot,
}

impl PathRevisionWitness {
    pub fn capture(path: &Path) -> io::Result<Self> {
        let path_metadata = fs::symlink_metadata(path)?;
        if !path_metadata.file_type().is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Revision witness path must be a regular file, not a symlink",
            ));
        }
        let file = open_destination_without_following_symlinks(path)?;
        let snapshot = capture_destination_snapshot(&file)?;
        let witness = Self {
            file,
            path: path.to_path_buf(),
            snapshot,
        };
        witness.assert_current()?;
        Ok(witness)
    }

    pub fn assert_current(&self) -> io::Result<()> {
        let path_metadata = fs::symlink_metadata(&self.path)?;
        if !path_metadata.file_type().is_file() {
            return Err(io::Error::other(
                "Revision witness path changed into a symlink or non-file",
            ));
        }
        let path_file = open_destination_without_following_symlinks(&self.path)?;
        let held_snapshot = capture_destination_snapshot(&self.file)?;
        let path_snapshot = capture_destination_snapshot(&path_file)?;
        if !destination_snapshots_match(&self.snapshot, &held_snapshot)
            || !destination_snapshots_match(&self.snapshot, &path_snapshot)
        {
            return Err(io::Error::other("Revision witness path changed"));
        }
        Ok(())
    }
}

impl AtomicOutput {
    pub fn create(destination: &Path) -> io::Result<Self> {
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        let file_name = destination
            .file_name()
            .map(|value| value.to_string_lossy())
            .unwrap_or_else(|| std::borrow::Cow::Borrowed("output"));
        let destination_state = match fs::symlink_metadata(destination) {
            Ok(path_metadata) => {
                if !path_metadata.file_type().is_file() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Atomic output destination must be a regular file, not a symlink",
                    ));
                }
                let witness = PathRevisionWitness::capture(destination)?;
                Some(DestinationState {
                    permissions: path_metadata.permissions(),
                    witness,
                })
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();

        for _ in 0..128 {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temporary_path = parent.join(format!(
                ".{file_name}.evb-tmp-{}-{timestamp}-{sequence}",
                std::process::id()
            ));
            match create_exclusive_temporary_file(&temporary_path) {
                Ok(file) => {
                    return Ok(Self {
                        file: Some(file),
                        temporary_path,
                        destination_path: destination.to_path_buf(),
                        destination_state,
                        published: false,
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }

        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Unable to create a unique sibling output file",
        ))
    }

    pub fn file_mut(&mut self) -> io::Result<&mut File> {
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::other("Temporary output file is already closed"))
    }

    pub fn file(&self) -> io::Result<&File> {
        self.file
            .as_ref()
            .ok_or_else(|| io::Error::other("Temporary output file is already closed"))
    }

    /// Seeds the unpublished sibling with a filesystem copy-on-write clone.
    /// Returns `false` when the platform or filesystem cannot clone so callers
    /// can fall back to a regular streamed copy.
    pub fn seed_from_path_copy_on_write(&mut self, source: &Path) -> io::Result<bool> {
        drop(self.file.take());
        match fs::remove_file(&self.temporary_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let source_length = fs::metadata(source)?.len();

        let cloned = clone_file(source, &self.temporary_path).unwrap_or(false);
        if !cloned {
            let _ = fs::remove_file(&self.temporary_path);
            self.file = Some(create_exclusive_temporary_file(&self.temporary_path)?);
            return Ok(false);
        }

        let metadata = fs::symlink_metadata(&self.temporary_path)?;
        if !metadata.file_type().is_file() || metadata.len() != source_length {
            fs::remove_file(&self.temporary_path)?;
            self.file = Some(create_exclusive_temporary_file(&self.temporary_path)?);
            return Ok(false);
        }
        #[cfg(unix)]
        let metadata = {
            let mut permissions = metadata.permissions();
            permissions.set_mode(permissions.mode() | 0o600);
            fs::set_permissions(&self.temporary_path, permissions)?;
            fs::symlink_metadata(&self.temporary_path)?
        };
        let mut file = open_existing_temporary_file(&self.temporary_path)?;
        let opened_metadata = file.metadata()?;
        if !opened_metadata.is_file()
            || opened_metadata.len() != source_length
            || opened_metadata.len() != metadata.len()
        {
            return Err(io::Error::other(
                "Copy-on-write output changed before it could be opened",
            ));
        }
        file.seek(SeekFrom::End(0))?;
        self.file = Some(file);
        Ok(true)
    }

    pub fn temporary_path(&self) -> &Path {
        &self.temporary_path
    }

    pub fn publish(self) -> io::Result<()> {
        self.publish_after(|| {})
    }

    fn publish_after(mut self, before_replace: impl FnOnce()) -> io::Result<()> {
        {
            let file = self.file_mut()?;
            file.flush()?;
            file.sync_all()?;
        }
        if let Some(state) = &self.destination_state {
            fs::set_permissions(&self.temporary_path, state.permissions.clone())?;
        }
        drop(self.file.take());
        before_replace();
        self.assert_destination_unchanged()?;
        replace_file_atomically(&self.temporary_path, &self.destination_path)?;
        self.published = true;
        sync_parent_directory(&self.destination_path);
        Ok(())
    }

    pub fn publish_if_unchanged(self) -> io::Result<()> {
        self.publish()
    }

    #[cfg(test)]
    fn publish_if_unchanged_after(self, before_replace: impl FnOnce()) -> io::Result<()> {
        self.publish_after(before_replace)
    }

    fn assert_destination_unchanged(&self) -> io::Result<()> {
        match (
            &self.destination_state,
            fs::symlink_metadata(&self.destination_path),
        ) {
            (None, Err(error)) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            (None, Ok(_)) => Err(io::Error::other(
                "Destination appeared during atomic output",
            )),
            (None, Err(error)) => Err(error),
            (Some(_), Err(error)) if error.kind() == io::ErrorKind::NotFound => Err(
                io::Error::other("Destination disappeared during atomic output"),
            ),
            (Some(_), Err(error)) => Err(error),
            (Some(_), Ok(metadata)) if !metadata.file_type().is_file() => Err(io::Error::other(
                "Destination changed into a symlink or non-file during atomic output",
            )),
            (Some(state), Ok(_)) => state.witness.assert_current(),
        }
    }
}

#[cfg(target_os = "linux")]
fn clone_file(source: &Path, destination: &Path) -> io::Result<bool> {
    use std::os::unix::io::AsRawFd;

    let source_file = File::open(source)?;
    let destination_file = create_exclusive_temporary_file(destination)?;
    let result = unsafe {
        libc::ioctl(
            destination_file.as_raw_fd(),
            libc::FICLONE as libc::c_ulong,
            source_file.as_raw_fd(),
        )
    };
    if result == 0 {
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
fn clone_file(source: &Path, destination: &Path) -> io::Result<bool> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source path contains NUL"))?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
    })?;
    let result = unsafe { libc::clonefile(source.as_ptr(), destination.as_ptr(), 0) };
    Ok(result == 0)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn clone_file(_source: &Path, _destination: &Path) -> io::Result<bool> {
    Ok(false)
}

fn capture_destination_snapshot(file: &File) -> io::Result<DestinationSnapshot> {
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(io::Error::other(
            "Atomic output destination is not a regular file",
        ));
    }
    let length = before.len();
    let sample_length = usize::try_from(length.min(WITNESS_SAMPLE_BYTES as u64))
        .map_err(|_| io::Error::other("Atomic output destination is too large to sample"))?;
    let last_offset = length.saturating_sub(sample_length as u64);
    let offsets = [0, last_offset / 2, last_offset];
    let mut sample = Vec::with_capacity(sample_length.saturating_mul(offsets.len()));
    let mut reader = file.try_clone()?;
    let mut previous_offset = None;
    for offset in offsets {
        if previous_offset == Some(offset) {
            continue;
        }
        previous_offset = Some(offset);
        reader.seek(SeekFrom::Start(offset))?;
        let start = sample.len();
        sample.resize(start + sample_length, 0);
        reader.read_exact(&mut sample[start..])?;
    }
    let after = file.metadata()?;
    let identity = file_identity(file)?;
    let before_snapshot =
        destination_snapshot_from_metadata(&before, identity.clone(), sample.clone());
    let after_snapshot = destination_snapshot_from_metadata(&after, identity, sample);
    if !destination_snapshots_match(&before_snapshot, &after_snapshot) {
        return Err(io::Error::other(
            "Destination changed while its atomic output witness was captured",
        ));
    }
    Ok(after_snapshot)
}

fn destination_snapshot_from_metadata(
    metadata: &fs::Metadata,
    identity: Option<FileIdentity>,
    sample: Vec<u8>,
) -> DestinationSnapshot {
    DestinationSnapshot {
        identity,
        length: metadata.len(),
        modified: metadata.modified().ok(),
        sample,
        #[cfg(unix)]
        changed: {
            use std::os::unix::fs::MetadataExt;
            (metadata.ctime(), metadata.ctime_nsec())
        },
    }
}

fn destination_snapshots_match(left: &DestinationSnapshot, right: &DestinationSnapshot) -> bool {
    left.identity == right.identity
        && left.length == right.length
        && left.modified == right.modified
        && left.sample == right.sample
        && {
            #[cfg(unix)]
            {
                left.changed == right.changed
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
}

impl Drop for AtomicOutput {
    fn drop(&mut self) {
        if !self.published {
            drop(self.file.take());
            let _ = fs::remove_file(&self.temporary_path);
        }
    }
}

/// Retains every validated input descriptor for the duration of an output operation.
pub struct ValidatedInputFiles {
    files: Vec<File>,
}

impl ValidatedInputFiles {
    pub fn open(input_paths: &[PathBuf], output_path: &Path) -> Result<Self, NativeError> {
        let output_file = match File::open(output_path) {
            Ok(file) => Some(file),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(native_io_error(error)),
        };
        if output_file
            .as_ref()
            .is_some_and(|file| file.metadata().is_ok_and(|metadata| !metadata.is_file()))
        {
            return Err(native_failure(format!(
                "Output is not a regular file: {}",
                output_path.display()
            )));
        }
        let output_identity = output_file
            .as_ref()
            .map(file_identity)
            .transpose()
            .map_err(native_io_error)?
            .flatten();
        let output_canonical = output_file
            .as_ref()
            .and_then(|_| fs::canonicalize(output_path).ok());

        let mut files = Vec::new();
        files
            .try_reserve_exact(input_paths.len())
            .map_err(|_| native_failure("Too many input files to validate"))?;

        for input_path in input_paths {
            let file = File::open(input_path).map_err(native_io_error)?;
            let metadata = file.metadata().map_err(native_io_error)?;
            if !metadata.is_file() {
                return Err(native_failure(format!(
                    "Input is not a regular file: {}",
                    input_path.display()
                )));
            }
            let input_identity = file_identity(&file).map_err(native_io_error)?;
            let aliases_output = output_identity
                .as_ref()
                .is_some_and(|output| input_identity.as_ref() == Some(output))
                || output_canonical.as_ref().is_some_and(|output| {
                    fs::canonicalize(input_path).ok().as_ref() == Some(output)
                });
            if aliases_output {
                return Err(native_failure(format!(
                    "Output aliases an input file: {}",
                    input_path.display()
                )));
            }
            files.push(file);
        }

        Ok(Self { files })
    }

    pub fn clone_file(&self, index: usize) -> io::Result<File> {
        self.files
            .get(index)
            .ok_or_else(|| {
                io::Error::other(format!(
                    "Missing validated input descriptor at index {index}"
                ))
            })?
            .try_clone()
    }
}

pub fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut output = AtomicOutput::create(path)?;
    output.file_mut()?.write_all(bytes)?;
    output.publish()
}

pub fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), Box<dyn Error>> {
    let mut output = AtomicOutput::create(path)?;
    serde_json::to_writer(output.file_mut()?, value)?;
    output.publish()?;
    Ok(())
}

fn native_io_error(error: io::Error) -> NativeError {
    NativeError::new(NativeErrorCode::Io, error.to_string())
}

fn native_failure(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::NativeFailure, message)
}

#[derive(Clone, Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    index: u64,
}

#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<Option<FileIdentity>> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(Some(FileIdentity {
        volume: metadata.dev(),
        index: metadata.ino(),
    }))
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<Option<FileIdentity>> {
    use std::{ffi::c_void, mem::MaybeUninit, os::windows::io::AsRawHandle};

    #[repr(C)]
    struct FileTime {
        _low: u32,
        _high: u32,
    }

    #[repr(C)]
    struct ByHandleFileInformation {
        _attributes: u32,
        _creation_time: FileTime,
        _last_access_time: FileTime,
        _last_write_time: FileTime,
        volume_serial_number: u32,
        _file_size_high: u32,
        _file_size_low: u32,
        _number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            file: *mut c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    let result = unsafe {
        GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    Ok(Some(FileIdentity {
        volume: u64::from(information.volume_serial_number),
        index: (u64::from(information.file_index_high) << 32)
            | u64::from(information.file_index_low),
    }))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File) -> io::Result<Option<FileIdentity>> {
    // WASI does not currently expose a stable cross-platform file identity.
    // Native desktop targets use the Unix/Windows implementations above.
    Ok(None)
}

#[cfg(not(windows))]
fn replace_file_atomically(temporary_path: &Path, destination_path: &Path) -> io::Result<()> {
    fs::rename(temporary_path, destination_path)
}

#[cfg(windows)]
fn replace_file_atomically(temporary_path: &Path, destination_path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing: Vec<u16> = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let replacement: Vec<u16> = destination_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // The temporary handle is closed before replacement so Windows can publish it.
    let result = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(destination_path: &Path) {
    if let Some(parent) = destination_path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

#[cfg(not(unix))]
fn sync_parent_directory(_destination_path: &Path) {}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
        env, fs,
        io::{BufWriter, Read, Write},
        process,
        sync::{Arc, Barrier},
        thread,
    };

    use serde::Serializer;

    use super::*;

    #[test]
    fn failed_serialization_preserves_existing_output_and_cleans_temporary() {
        struct FailingValue;

        impl Serialize for FailingValue {
            fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                Err(serde::ser::Error::custom("intentional encoding failure"))
            }
        }

        let destination = test_path("serialization-failure");
        fs::write(&destination, b"existing-output").unwrap();

        let error = write_json_atomically(&destination, &FailingValue).unwrap_err();

        assert!(error.to_string().contains("intentional encoding failure"));
        assert_eq!(fs::read(&destination).unwrap(), b"existing-output");
        assert_no_sibling_temporary(&destination);
        fs::remove_file(destination).unwrap();
    }

    #[test]
    fn explicit_drop_removes_unpublished_temporary() {
        let destination = test_path("drop");
        let output = AtomicOutput::create(&destination).unwrap();
        let temporary_path = output.temporary_path.clone();

        drop(output);

        assert!(!temporary_path.exists());
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn copy_on_write_seed_replaces_a_substituted_symlink_without_following_it() {
        use std::os::unix::fs::symlink;

        let source = test_path("clone-source");
        let destination = test_path("clone-destination");
        let victim = test_path("clone-victim");
        fs::write(&source, b"source-bytes").unwrap();
        fs::write(&victim, b"victim-bytes").unwrap();
        let mut output = AtomicOutput::create(&destination).unwrap();
        fs::remove_file(output.temporary_path()).unwrap();
        symlink(&victim, output.temporary_path()).unwrap();

        let _ = output.seed_from_path_copy_on_write(&source).unwrap();

        assert_eq!(fs::read(&victim).unwrap(), b"victim-bytes");
        assert!(fs::symlink_metadata(output.temporary_path())
            .unwrap()
            .file_type()
            .is_file());
        drop(output);
        fs::remove_file(source).unwrap();
        fs::remove_file(victim).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn writer_flush_failure_preserves_existing_output_and_cleans_temporary() {
        use std::os::{fd::OwnedFd, unix::net::UnixStream};

        let destination = test_path("flush-failure");
        fs::write(&destination, b"existing-output").unwrap();
        let mut output = AtomicOutput::create(&destination).unwrap();
        let temporary_path = output.temporary_path.clone();
        let (stream, peer) = UnixStream::pair().unwrap();
        drop(peer);
        let descriptor: OwnedFd = stream.into();
        output.file = Some(File::from(descriptor));

        let flush_result = {
            let mut writer = BufWriter::new(output.file_mut().unwrap());
            writer.write_all(b"buffered replacement").unwrap();
            writer.flush()
        };
        assert!(flush_result.is_err());
        drop(output);
        assert_eq!(fs::read(&destination).unwrap(), b"existing-output");
        assert!(!temporary_path.exists());
        fs::remove_file(destination).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn writer_failure_preserves_hardlinked_input_and_cleans_temporary() {
        use std::os::{fd::OwnedFd, unix::net::UnixStream};

        let input = test_path("flush-failure-alias-input");
        let destination = test_path("flush-failure-alias-output");
        fs::write(&input, b"existing-output").unwrap();
        fs::hard_link(&input, &destination).unwrap();
        let mut output = AtomicOutput::create(&destination).unwrap();
        let temporary_path = output.temporary_path.clone();
        let (stream, peer) = UnixStream::pair().unwrap();
        drop(peer);
        let descriptor: OwnedFd = stream.into();
        output.file = Some(File::from(descriptor));

        let flush_result = {
            let mut writer = BufWriter::new(output.file_mut().unwrap());
            writer.write_all(b"buffered replacement").unwrap();
            writer.flush()
        };
        assert!(flush_result.is_err());
        drop(output);
        assert_eq!(fs::read(&input).unwrap(), b"existing-output");
        assert_eq!(fs::read(&destination).unwrap(), b"existing-output");
        assert!(!temporary_path.exists());
        fs::remove_file(input).unwrap();
        fs::remove_file(destination).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn publish_failure_preserves_existing_destination() {
        let parent = test_path("publish-failure-dir");
        fs::create_dir(&parent).unwrap();
        let destination = parent.join("output");
        fs::write(&destination, b"existing-output").unwrap();
        let mut output = AtomicOutput::create(&destination).unwrap();
        let temporary_path = output.temporary_path.clone();
        output
            .file_mut()
            .unwrap()
            .write_all(b"complete-replacement")
            .unwrap();

        // Replace the staged file with a directory. The publish rename now
        // fails after the file has been flushed, which models a crash-window
        // failure at the final publication boundary.
        fs::remove_file(&temporary_path).unwrap();
        fs::create_dir(&temporary_path).unwrap();
        let publish_result = output.publish_if_unchanged();

        assert!(publish_result.is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing-output");
        fs::remove_dir(temporary_path).unwrap();
        fs::remove_file(destination).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn concurrent_sibling_creation_is_unique() {
        let destination = Arc::new(test_path("concurrent"));
        let thread_count = 16;
        let start = Arc::new(Barrier::new(thread_count));
        let handles = (0..thread_count)
            .map(|_| {
                let destination = Arc::clone(&destination);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    AtomicOutput::create(&destination).unwrap()
                })
            })
            .collect::<Vec<_>>();
        let outputs = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        let paths = outputs
            .iter()
            .map(|output| output.temporary_path.clone())
            .collect::<HashSet<_>>();

        assert_eq!(paths.len(), thread_count);
        drop(outputs);
        assert_no_sibling_temporary(&destination);
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_destination_contributes_to_temporary_name() {
        use std::os::unix::ffi::OsStringExt;

        let destination = env::temp_dir().join(std::ffi::OsString::from_vec(
            format!("evb-native-support-non-utf8-{}", process::id()).into_bytes(),
        ));
        let mut name = format!("page-{}-", process::id()).into_bytes();
        name.extend_from_slice(&[0xff, b'.', b'p', b'n', b'g']);
        let destination = destination.with_file_name(std::ffi::OsString::from_vec(name));
        let output = AtomicOutput::create(&destination).unwrap();

        assert!(output
            .temporary_path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(&format!("page-{}-�.png", process::id())));
        drop(output);
        assert_no_sibling_temporary(&destination);
    }

    #[test]
    fn rejects_same_file_and_hardlink_output_aliases() {
        let input = test_path("alias-input");
        let hardlink = test_path("alias-output");
        fs::write(&input, b"input").unwrap();

        let same_file_error = ValidatedInputFiles::open(std::slice::from_ref(&input), &input)
            .err()
            .unwrap();
        assert!(same_file_error
            .to_string()
            .contains("Output aliases an input"));

        fs::hard_link(&input, &hardlink).unwrap();
        let hardlink_error = ValidatedInputFiles::open(std::slice::from_ref(&input), &hardlink)
            .err()
            .unwrap();
        assert!(hardlink_error
            .to_string()
            .contains("Output aliases an input"));
        assert_eq!(fs::read(&input).unwrap(), b"input");
        assert_eq!(fs::read(&hardlink).unwrap(), b"input");
        fs::remove_file(input).unwrap();
        fs::remove_file(hardlink).unwrap();
    }

    #[test]
    fn retained_descriptor_survives_input_path_replacement() {
        let input = test_path("retained-input");
        let displaced = test_path("retained-displaced");
        let output = test_path("retained-output");
        fs::write(&input, b"validated-input").unwrap();
        let validated = ValidatedInputFiles::open(std::slice::from_ref(&input), &output).unwrap();

        fs::rename(&input, &displaced).unwrap();
        fs::write(&input, b"replacement-input").unwrap();
        let mut retained = validated.clone_file(0).unwrap();
        let mut bytes = Vec::new();
        retained.read_to_end(&mut bytes).unwrap();

        assert_eq!(bytes, b"validated-input");
        fs::remove_file(input).unwrap();
        fs::remove_file(displaced).unwrap();
    }

    #[test]
    fn atomically_replaces_existing_destination() {
        let destination = test_path("replacement");
        fs::write(&destination, b"old-output").unwrap();

        write_bytes_atomically(&destination, b"new-output").unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"new-output");
        assert_no_sibling_temporary(&destination);
        fs::remove_file(destination).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomically_replaces_existing_destination_with_its_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let destination = test_path("replacement-permissions");
        fs::write(&destination, b"old-output").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o600)).unwrap();

        write_bytes_atomically(&destination, b"new-output").unwrap();

        assert_eq!(fs::read(&destination).unwrap(), b"new-output");
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_no_sibling_temporary(&destination);
        fs::remove_file(destination).unwrap();
    }

    #[test]
    fn publication_rejects_a_path_replacement_after_the_first_witness_check() {
        let destination = test_path("replacement-after-witness");
        let displaced = test_path("replacement-after-witness-displaced");
        fs::write(&destination, b"admitted-output").unwrap();
        let mut output = AtomicOutput::create(&destination).unwrap();
        output.file_mut().unwrap().write_all(b"app-output").unwrap();

        let result = output.publish_if_unchanged_after(|| {
            fs::rename(&destination, &displaced).unwrap();
            fs::write(&destination, b"external-output").unwrap();
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"external-output");
        assert_eq!(fs::read(&displaced).unwrap(), b"admitted-output");
        fs::remove_file(destination).unwrap();
        fs::remove_file(displaced).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn publication_rejects_a_symlink_destination_without_replacing_the_link() {
        use std::os::unix::fs::symlink;

        let destination = test_path("symlink-destination");
        let referent = test_path("symlink-referent");
        fs::write(&referent, b"referent-output").unwrap();
        symlink(&referent, &destination).unwrap();

        let result = AtomicOutput::create(&destination);

        assert!(result.is_err());
        assert!(fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&referent).unwrap(), b"referent-output");
        fs::remove_file(destination).unwrap();
        fs::remove_file(referent).unwrap();
    }

    fn test_path(label: &str) -> PathBuf {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        env::temp_dir().join(format!(
            "evb-native-support-{label}-{}-{sequence}",
            process::id()
        ))
    }

    fn assert_no_sibling_temporary(destination: &Path) {
        let parent = destination.parent().unwrap();
        let marker = format!(
            ".{}.evb-tmp-",
            destination.file_name().unwrap().to_string_lossy()
        );
        let leftovers = fs::read_dir(parent)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(&marker))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "temporary output was not cleaned");
    }
}
