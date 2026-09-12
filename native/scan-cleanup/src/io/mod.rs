use evb_raster_io::DecodeLimits;
use std::{
    error::Error,
    fmt::{self, Write as FmtWrite},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
#[cfg(unix)]
use std::{
    os::fd::AsRawFd,
    thread,
    time::{Duration, Instant},
};

pub mod pbm;
pub mod png;
pub mod raster;

pub(crate) const MAX_COMPRESSED_BYTES: usize = 512 * 1024 * 1024;
pub(crate) const MAX_STREAM_INPUT_BYTES: usize = MAX_COMPRESSED_BYTES;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const ATOMIC_TEMP_ATTEMPTS: usize = 16;
const ATOMIC_TEMP_RANDOM_BYTES: usize = 16;
#[cfg(unix)]
const STREAM_CANCEL_SELECT_INTERVAL_US: libc::suseconds_t = 50_000;
#[cfg(unix)]
const STREAM_UNCONNECTED_RETRY_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(unix)]
const STREAM_INITIAL_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub(crate) enum BoundedIoError {
    Canceled,
    ConnectTimeout,
    Io(std::io::Error),
    TooLarge { limit: usize },
}

impl fmt::Display for BoundedIoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Canceled => formatter.write_str("input copy was canceled"),
            Self::ConnectTimeout => {
                formatter.write_str("stream producer did not connect before the deadline")
            }
            Self::Io(error) => error.fmt(formatter),
            Self::TooLarge { limit } => {
                write!(formatter, "input exceeds guardrails ({limit}-byte limit)")
            }
        }
    }
}

impl Error for BoundedIoError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Canceled | Self::ConnectTimeout | Self::TooLarge { .. } => None,
        }
    }
}

impl From<std::io::Error> for BoundedIoError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub(crate) fn copy_bounded_cancelable(
    source: &mut impl Read,
    destination: &mut impl Write,
    max_bytes: usize,
    is_canceled: impl Fn() -> bool,
) -> Result<u64, BoundedIoError> {
    let mut copied = 0usize;
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    loop {
        if is_canceled() {
            return Err(BoundedIoError::Canceled);
        }
        // Probe at most one byte past the allowance, and never publish that
        // byte, so streams cannot grow either memory or scratch without bound.
        let remaining_with_probe = max_bytes.saturating_sub(copied).saturating_add(1);
        let read_limit = remaining_with_probe.min(buffer.len());
        let count = loop {
            match source.read(&mut buffer[..read_limit]) {
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                result => break result?,
            }
        };
        if is_canceled() {
            return Err(BoundedIoError::Canceled);
        }
        if count == 0 {
            return Ok(copied as u64);
        }
        if count > max_bytes.saturating_sub(copied) {
            return Err(BoundedIoError::TooLarge { limit: max_bytes });
        }
        destination.write_all(&buffer[..count])?;
        copied += count;
    }
}

/// Copy a non-blocking FIFO while retaining cancellation between producer
/// writes. Opening a FIFO in blocking mode can strand the scoped reader when
/// an earlier page fails before the producer ever opens this stream.
#[cfg(unix)]
pub(crate) fn copy_bounded_nonblocking_stream_cancelable(
    source: &mut (impl Read + AsRawFd),
    destination: &mut impl Write,
    max_bytes: usize,
    is_canceled: impl Fn() -> bool,
) -> Result<u64, BoundedIoError> {
    copy_bounded_nonblocking_stream_cancelable_until(
        source,
        destination,
        max_bytes,
        is_canceled,
        Instant::now() + STREAM_INITIAL_CONNECT_TIMEOUT,
    )
}

#[cfg(unix)]
fn copy_bounded_nonblocking_stream_cancelable_until(
    source: &mut (impl Read + AsRawFd),
    destination: &mut impl Write,
    max_bytes: usize,
    is_canceled: impl Fn() -> bool,
    initial_connect_deadline: Instant,
) -> Result<u64, BoundedIoError> {
    let mut copied = 0usize;
    let mut received_data = false;
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    loop {
        if is_canceled() {
            return Err(BoundedIoError::Canceled);
        }
        let remaining_with_probe = max_bytes.saturating_sub(copied).saturating_add(1);
        let read_limit = remaining_with_probe.min(buffer.len());
        let count = match source.read(&mut buffer[..read_limit]) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if !received_data && Instant::now() >= initial_connect_deadline {
                    return Err(BoundedIoError::ConnectTimeout);
                }
                let descriptor = source.as_raw_fd();
                if descriptor < 0 || descriptor as usize >= libc::FD_SETSIZE {
                    return Err(std::io::Error::other(format!(
                        "stream descriptor {descriptor} exceeds select guardrails",
                    ))
                    .into());
                }
                // SAFETY: fd_set is a plain C bitset and all-zero is its empty
                // state. The source descriptor stays valid through select.
                let mut read_descriptors = unsafe { std::mem::zeroed::<libc::fd_set>() };
                // SAFETY: `descriptor` is owned by source and fd_set points to
                // initialized storage for the duration of both calls.
                unsafe { libc::FD_SET(descriptor, &raw mut read_descriptors) };
                let mut timeout = libc::timeval {
                    tv_sec: 0,
                    tv_usec: STREAM_CANCEL_SELECT_INTERVAL_US,
                };
                let ready = unsafe {
                    libc::select(
                        descriptor + 1,
                        &raw mut read_descriptors,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        &raw mut timeout,
                    )
                };
                if ready < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error.into());
                }
                continue;
            }
            Err(error) => return Err(error.into()),
            Ok(0) if !received_data => {
                // O_NONBLOCK reports EOF while no writer is connected. Wait
                // for a producer without spinning on the persistent POLLHUP.
                // Once connected, data is drained immediately; this delay is
                // never applied between producer writes.
                let remaining = initial_connect_deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(BoundedIoError::ConnectTimeout);
                }
                thread::sleep(STREAM_UNCONNECTED_RETRY_INTERVAL.min(remaining));
                continue;
            }
            Ok(count) => count,
        };
        if is_canceled() {
            return Err(BoundedIoError::Canceled);
        }
        if count == 0 {
            return Ok(copied as u64);
        }
        received_data = true;
        if count > max_bytes.saturating_sub(copied) {
            return Err(BoundedIoError::TooLarge { limit: max_bytes });
        }
        destination.write_all(&buffer[..count])?;
        copied += count;
    }
}

pub(crate) fn decode_limits(max_pixels: u64, max_dimension: u32) -> DecodeLimits {
    DecodeLimits {
        max_pixels,
        max_dimension,
        max_compressed_bytes: MAX_COMPRESSED_BYTES,
    }
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_with(path, |file| {
        file.write_all(bytes).map_err(|error| error.to_string())
    })
}

pub(crate) fn write_atomic_with(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    write_atomic_with_random(path, write, |bytes| {
        getrandom::fill(bytes).map_err(|error| format!("unable to obtain random bytes: {error}"))
    })
}

fn randomized_temporary_path(path: &Path, random: &[u8]) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    let mut suffix = String::with_capacity(random.len() * 2);
    for byte in random {
        write!(&mut suffix, "{byte:02x}").expect("writing to a String cannot fail");
    }
    name.push(format!(".evb-tmp-{suffix}"));
    path.with_file_name(PathBuf::from(name))
}

fn open_randomized_temporary(
    path: &Path,
    fill_random: &mut impl FnMut(&mut [u8]) -> Result<(), String>,
) -> Result<(File, PathBuf), String> {
    for _ in 0..ATOMIC_TEMP_ATTEMPTS {
        let mut random = [0u8; ATOMIC_TEMP_RANDOM_BYTES];
        fill_random(&mut random)?;
        let temporary = randomized_temporary_path(path, &random);
        // create_new is one atomic "does not exist + create" operation. An
        // existing symlink is therefore a collision, never something opened
        // and followed between a metadata check and this call.
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((file, temporary)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!(
        "unable to reserve randomized publication temporary after {ATOMIC_TEMP_ATTEMPTS} attempts"
    ))
}

pub(crate) struct StagedFileBackup {
    original: PathBuf,
    backup: PathBuf,
    permissions: fs::Permissions,
}

impl StagedFileBackup {
    pub(crate) fn stage(original: &Path) -> Result<Self, String> {
        let mut source = File::open(original).map_err(|error| error.to_string())?;
        let metadata = source.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err(format!(
                "cannot snapshot non-regular destination {}",
                original.display()
            ));
        }
        let (mut backup_file, backup) = open_randomized_temporary(original, &mut |bytes| {
            getrandom::fill(bytes)
                .map_err(|error| format!("unable to obtain random bytes: {error}"))
        })?;
        let snapshot_result = std::io::copy(&mut source, &mut backup_file)
            .map(|_| ())
            .and_then(|()| backup_file.sync_all());
        // Close both handles before removing the original so staging also
        // works on Windows.
        drop(source);
        drop(backup_file);
        if let Err(error) = snapshot_result {
            let _ = fs::remove_file(&backup);
            return Err(error.to_string());
        }
        if let Err(error) = fs::remove_file(original) {
            let _ = fs::remove_file(&backup);
            return Err(error.to_string());
        }
        Ok(Self {
            original: original.to_path_buf(),
            backup,
            permissions: metadata.permissions(),
        })
    }

    pub(crate) fn original(&self) -> &Path {
        &self.original
    }

    pub(crate) fn restore(self) -> Result<(), String> {
        match fs::symlink_metadata(&self.original) {
            Ok(metadata) if metadata.is_dir() => {
                return Err(format!(
                    "cannot restore {} over a directory",
                    self.original.display()
                ));
            }
            Ok(_) => fs::remove_file(&self.original).map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        fs::rename(&self.backup, &self.original).map_err(|error| error.to_string())?;
        fs::set_permissions(&self.original, self.permissions).map_err(|error| error.to_string())
    }

    pub(crate) fn discard(self) -> Result<(), String> {
        fs::remove_file(&self.backup).map_err(|error| error.to_string())
    }
}

fn write_atomic_with_random(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), String>,
    mut fill_random: impl FnMut(&mut [u8]) -> Result<(), String>,
) -> Result<(), String> {
    let (mut file, temporary) = open_randomized_temporary(path, &mut fill_random)?;
    let write_result =
        write(&mut file).and_then(|()| file.sync_all().map_err(|error| error.to_string()));
    // Windows cannot unlink an open file. Close before either rename or
    // error cleanup so the no-partial-temp guarantee is cross-platform.
    drop(file);
    let result =
        write_result.and_then(|()| fs::rename(&temporary, path).map_err(|error| error.to_string()));
    // A successful rename consumed the temporary; every other exit removes
    // the partial file. Never leave an attacker-predictable reusable path.
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        io::Cursor,
        sync::atomic::{AtomicBool, AtomicU64, Ordering},
    };

    static TEST_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    fn test_directory(label: &str) -> PathBuf {
        let id = TEST_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-atomic-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn bounded_copy_rejects_an_oversize_stream_without_crossing_the_limit() {
        let mut source = Cursor::new(b"12345");
        let mut destination = Vec::new();

        let error =
            copy_bounded_cancelable(&mut source, &mut destination, 4, || false).unwrap_err();

        assert!(matches!(error, BoundedIoError::TooLarge { limit: 4 }));
        assert!(destination.len() <= 4);
    }

    #[test]
    fn bounded_copy_checks_cancellation_after_each_read() {
        struct CancelingReader<'a> {
            canceled: &'a AtomicBool,
        }
        impl Read for CancelingReader<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                buffer[..4].copy_from_slice(b"data");
                self.canceled.store(true, Ordering::Release);
                Ok(4)
            }
        }
        let canceled = AtomicBool::new(false);
        let mut source = CancelingReader {
            canceled: &canceled,
        };
        let mut destination = Vec::new();

        let error = copy_bounded_cancelable(&mut source, &mut destination, 16, || {
            canceled.load(Ordering::Acquire)
        })
        .unwrap_err();

        assert!(matches!(error, BoundedIoError::Canceled));
        assert!(destination.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn nonblocking_fifo_copy_does_not_throttle_a_ready_large_stream() {
        use std::os::unix::fs::OpenOptionsExt;

        const STREAM_BYTES: usize = 32 * 1024 * 1024;
        const MAX_ELAPSED: Duration = Duration::from_secs(2);

        let directory = test_directory("fifo-throughput");
        let fifo = directory.join("source.fifo");
        let output = directory.join("materialized.ppm");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());

        let producer_fifo = fifo.clone();
        let producer = std::thread::spawn(move || {
            let mut writer = OpenOptions::new().write(true).open(producer_fifo).unwrap();
            let block = [0x5au8; COPY_BUFFER_BYTES];
            for _ in 0..STREAM_BYTES / block.len() {
                writer.write_all(&block).unwrap();
            }
        });
        let mut source = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
            .unwrap();
        let mut destination = File::create(&output).unwrap();
        let started_at = std::time::Instant::now();
        let copied = copy_bounded_nonblocking_stream_cancelable(
            &mut source,
            &mut destination,
            STREAM_BYTES,
            || false,
        )
        .unwrap();
        let elapsed = started_at.elapsed();
        producer.join().unwrap();
        drop(destination);
        drop(source);
        fs::remove_dir_all(&directory).unwrap();

        assert_eq!(copied, STREAM_BYTES as u64);
        assert!(
            elapsed < MAX_ELAPSED,
            "ready FIFO copy took {elapsed:?}; fixed sleep polling is throttling the stream",
        );
    }

    #[cfg(unix)]
    #[test]
    fn nonblocking_fifo_copy_reports_an_initial_connect_timeout() {
        use std::os::unix::fs::OpenOptionsExt;

        let directory = test_directory("fifo-connect-timeout");
        let fifo = directory.join("source.fifo");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let mut source = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
            .unwrap();
        let mut destination = Vec::new();

        let error = copy_bounded_nonblocking_stream_cancelable_until(
            &mut source,
            &mut destination,
            16,
            || false,
            std::time::Instant::now(),
        )
        .unwrap_err();

        assert!(matches!(error, BoundedIoError::ConnectTimeout));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn atomic_publication_retries_a_preexisting_random_temporary() {
        let directory = test_directory("collision");
        let output = directory.join("page.png");
        let collision = randomized_temporary_path(&output, &[0; ATOMIC_TEMP_RANDOM_BYTES]);
        fs::write(&collision, b"preexisting").unwrap();
        let fills = Cell::new(0usize);

        write_atomic_with_random(
            &output,
            |file| {
                file.write_all(b"published")
                    .map_err(|error| error.to_string())
            },
            |bytes| {
                let value = u8::from(fills.get() > 0);
                fills.set(fills.get() + 1);
                bytes.fill(value);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(fs::read(&output).unwrap(), b"published");
        assert_eq!(fs::read(&collision).unwrap(), b"preexisting");
        assert_eq!(fills.get(), 2);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn atomic_publication_bounds_repeated_collisions_without_touching_them() {
        let directory = test_directory("bounded-collision");
        let output = directory.join("page.png");
        let collision = randomized_temporary_path(&output, &[0; ATOMIC_TEMP_RANDOM_BYTES]);
        fs::write(&collision, b"preexisting").unwrap();
        let wrote = Cell::new(false);

        let error = write_atomic_with_random(
            &output,
            |_| {
                wrote.set(true);
                Ok(())
            },
            |bytes| {
                bytes.fill(0);
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("after 16 attempts"));
        assert!(!wrote.get());
        assert_eq!(fs::read(&collision).unwrap(), b"preexisting");
        assert!(!output.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_publication_never_follows_a_temporary_symlink() {
        use std::os::unix::fs::symlink;

        let directory = test_directory("symlink");
        let output = directory.join("page.png");
        let victim = directory.join("victim");
        fs::write(&victim, b"victim").unwrap();
        let collision = randomized_temporary_path(&output, &[0; ATOMIC_TEMP_RANDOM_BYTES]);
        symlink(&victim, &collision).unwrap();
        let fills = Cell::new(0usize);

        write_atomic_with_random(
            &output,
            |file| {
                file.write_all(b"published")
                    .map_err(|error| error.to_string())
            },
            |bytes| {
                bytes.fill(u8::from(fills.get() > 0));
                fills.set(fills.get() + 1);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(fs::read(&victim).unwrap(), b"victim");
        assert_eq!(fs::read(&output).unwrap(), b"published");
        assert!(fs::symlink_metadata(&collision)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn atomic_publication_removes_partial_files_after_write_and_rename_errors() {
        let directory = test_directory("cleanup");
        let output = directory.join("page.png");
        let random = [7u8; ATOMIC_TEMP_RANDOM_BYTES];
        let temporary = randomized_temporary_path(&output, &random);
        let error = write_atomic_with_random(
            &output,
            |file| {
                file.write_all(b"partial").unwrap();
                Err("forced write failure".into())
            },
            |bytes| {
                bytes.copy_from_slice(&random);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error, "forced write failure");
        assert!(!temporary.exists());
        assert!(!output.exists());

        fs::create_dir(&output).unwrap();
        fs::write(output.join("child"), b"occupied").unwrap();
        let error = write_atomic_with_random(
            &output,
            |file| {
                file.write_all(b"partial")
                    .map_err(|error| error.to_string())
            },
            |bytes| {
                bytes.copy_from_slice(&random);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(!error.is_empty());
        assert!(!temporary.exists());
        assert!(output.join("child").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
