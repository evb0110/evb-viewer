//! Stream and staged raster input coordination.
use crate::io::{copy_bounded_cancelable, raster, BoundedIoError};
use evb_native_support::{NativeError, NativeErrorCode};
use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::path::Component;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::sync_channel,
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LeaseEvent {
    Required,
    Released,
}

pub(crate) type LeaseAnnouncer<'a> =
    &'a (dyn Fn(LeaseEvent, usize, usize) -> Result<(), NativeError> + Sync);

#[derive(Clone, Debug)]
pub(crate) struct StagedPageDescriptor {
    pub(crate) input_path: PathBuf,
    pub(crate) metadata_path: PathBuf,
    pub(crate) source_page_index: usize,
    pub(crate) max_bytes: usize,
    pub(crate) stream_input: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct StagedInputBatch {
    pub(crate) pages: Vec<StagedPageDescriptor>,
    pub(crate) raster_window: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct StagedPathPlan {
    pub(crate) input_paths: Vec<PathBuf>,
    pub(crate) destination_paths: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
pub(crate) struct StagedLeaseDescriptor {
    pub(crate) input_path: PathBuf,
    pub(crate) page_number: usize,
    pub(crate) total_pages: usize,
    pub(crate) enabled: bool,
}

fn normalized_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                } else if !normalized.has_root() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    #[cfg(windows)]
    {
        return PathBuf::from(normalized.to_string_lossy().to_lowercase());
    }
    #[cfg(not(windows))]
    normalized
}

pub(crate) fn invalid(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message.into())
}

pub(crate) fn map_raster_error(
    error: raster::RasterReadError,
    path: &Path,
    page_index: usize,
) -> NativeError {
    NativeError::new(
        match error {
            raster::RasterReadError::Io(_) => NativeErrorCode::Io,
            raster::RasterReadError::Invalid(_) => NativeErrorCode::InvalidRequest,
            raster::RasterReadError::TooLarge(_) => NativeErrorCode::TooLarge,
        },
        format!(
            "Unable to read scan-cleanup raster for page {} ({}): {error}",
            page_index + 1,
            path.display(),
        ),
    )
}

pub(crate) struct MaterializedStreamPage {
    page: StagedPageDescriptor,
    temporary_input: Option<PathBuf>,
}

impl Drop for MaterializedStreamPage {
    fn drop(&mut self) {
        if let Some(path) = &self.temporary_input {
            let _ = fs::remove_file(path);
        }
    }
}

pub(crate) fn assert_paths_within_root(
    paths: &StagedPathPlan,
    root: &Path,
) -> Result<(), NativeError> {
    let canonical_root = fs::canonicalize(root).map_err(|error| {
        invalid(format!(
            "Allowed path root is not an existing directory: {} ({error})",
            root.display()
        ))
    })?;
    if !canonical_root.is_dir() {
        return Err(invalid(format!(
            "Allowed path root is not a directory: {}",
            root.display()
        )));
    }
    let canonical_root = normalized_path(&canonical_root);
    for path in paths.input_paths.iter().chain(&paths.destination_paths) {
        if fs::symlink_metadata(path).is_ok() && fs::canonicalize(path).is_err() {
            return Err(invalid(format!(
                "Manifest path cannot be resolved: {}",
                path.display()
            )));
        }
        if !resolved_manifest_path(path).starts_with(&canonical_root) {
            return Err(invalid(format!(
                "Manifest path escapes the allowed path root: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn preflight_paths(paths: &StagedPathPlan) -> Result<(), NativeError> {
    let mut input_paths = HashSet::new();
    let mut input_files = HashSet::new();
    for path in &paths.input_paths {
        input_paths.insert(resolved_manifest_path(path));
        if let Some(identity) = existing_file_identity(path) {
            input_files.insert(identity);
        }
    }
    let mut destination_paths = HashSet::new();
    let mut destination_files = HashSet::new();
    for path in &paths.destination_paths {
        let resolved = resolved_manifest_path(path);
        if input_paths.contains(&resolved)
            || existing_file_identity(path).is_some_and(|identity| input_files.contains(&identity))
        {
            return Err(invalid(format!(
                "Output destination aliases an input file: {}",
                path.display()
            )));
        }
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_dir() || metadata.is_file() => {}
            Ok(_) => {
                return Err(invalid(format!(
                    "Output destination must be a regular file or directory: {}",
                    path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(NativeError::new(
                    NativeErrorCode::Io,
                    format!(
                        "Unable to inspect output destination {}: {error}",
                        path.display()
                    ),
                ));
            }
        }
        if !destination_paths.insert(resolved)
            || existing_file_identity(path)
                .is_some_and(|identity| !destination_files.insert(identity))
        {
            return Err(invalid(format!(
                "Output destinations must refer to different files: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn resolved_manifest_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        normalized_path(path)
    } else {
        std::env::current_dir()
            .map(|directory| normalized_path(&directory.join(path)))
            .unwrap_or_else(|_| normalized_path(path))
    };
    let mut ancestor = absolute.as_path();
    let mut missing = Vec::<OsString>::new();
    loop {
        if let Ok(mut resolved) = fs::canonicalize(ancestor) {
            for component in missing.iter().rev() {
                resolved.push(component);
            }
            return normalized_path(&resolved);
        }
        let Some(file_name) = ancestor.file_name() else {
            return absolute;
        };
        missing.push(file_name.to_owned());
        let Some(parent) = ancestor.parent() else {
            return absolute;
        };
        ancestor = parent;
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ExistingFileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
fn existing_file_identity(path: &Path) -> Option<ExistingFileIdentity> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path)
        .ok()
        .map(|metadata| ExistingFileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
}

#[cfg(not(unix))]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ExistingFileIdentity;

#[cfg(not(unix))]
fn existing_file_identity(_path: &Path) -> Option<ExistingFileIdentity> {
    None
}

pub(crate) fn stream_materialized_path(page: &StagedPageDescriptor, index: usize) -> PathBuf {
    let parent = page
        .metadata_path
        .parent()
        .unwrap_or_else(|| Path::new("."));
    parent.join(format!(
        ".scan-cleanup-stream-{}-{index}.raster",
        std::process::id()
    ))
}

pub(crate) fn materialize_stream_page(
    index: usize,
    page: &StagedPageDescriptor,
    is_canceled: impl Fn() -> bool,
) -> Result<MaterializedStreamPage, NativeError> {
    let mut materialized = page.clone();
    if !page.stream_input {
        return Ok(MaterializedStreamPage {
            page: materialized,
            temporary_input: None,
        });
    }
    let temporary_input = stream_materialized_path(page, index);
    let copy_result = (|| -> Result<(), BoundedIoError> {
        if is_canceled() {
            return Err(BoundedIoError::Canceled);
        }
        let mut destination = fs::File::create(&temporary_input)?;
        #[cfg(unix)]
        {
            use crate::io::copy_bounded_nonblocking_stream_cancelable;
            use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};

            if fs::metadata(&page.input_path)?.file_type().is_fifo() {
                let mut source = fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&page.input_path)?;
                copy_bounded_nonblocking_stream_cancelable(
                    &mut source,
                    &mut destination,
                    page.max_bytes,
                    &is_canceled,
                )?;
                return Ok(());
            }
        }
        let mut source = fs::File::open(&page.input_path)?;
        copy_bounded_cancelable(&mut source, &mut destination, page.max_bytes, &is_canceled)?;
        Ok(())
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_file(&temporary_input);
        let code = match &error {
            BoundedIoError::TooLarge { .. } => NativeErrorCode::TooLarge,
            BoundedIoError::Canceled | BoundedIoError::Io(_) => NativeErrorCode::Io,
        };
        return Err(NativeError::new(
            code,
            format!(
                "Unable to materialize streamed scan-cleanup page {}: {error}",
                page.source_page_index.saturating_add(1)
            ),
        ));
    }
    materialized.input_path = temporary_input.clone();
    materialized.stream_input = false;
    Ok(MaterializedStreamPage {
        page: materialized,
        temporary_input: Some(temporary_input),
    })
}

/// How often an absent staged page input is re-probed while its producer
/// renders it. The wait is a rendezvous, not a poll loop over useful work: the
/// page worker owning this lease has nothing else to do until the raster is on
/// disk.
const STAGED_INPUT_POLL_INTERVAL: Duration = Duration::from_millis(20);
/// Upper bound on one staged page input. A producer that has neither published
/// the raster nor terminated this process by then is a broken owner, and
/// failing is better than a worker that never returns.
const STAGED_INPUT_WAIT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub(crate) fn staged_input_is_ready(path: &Path, page_number: usize) -> Result<bool, NativeError> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err(invalid(format!(
            "Page {page_number} inputPath must be a regular file"
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(NativeError::new(
            NativeErrorCode::Io,
            format!("Unable to read staged scan-cleanup page {page_number} input: {error}"),
        )),
    }
}

/// Announces that this page's staged-input lease is required, then waits for
/// its producer to publish a readable raster.
///
/// Under `stagedInputWindow` the owning process keeps only a bounded number of
/// replayable rasters on disk, so a page the sidecar is about to read may have
/// been released back to it already. Announcing the lease lets that process
/// re-render the identical raster before the read, which is what makes a
/// bounded window produce exactly the pixels whole-document staging would.
pub(crate) fn acquire_staged_page_input(
    lease: &StagedLeaseDescriptor,
    announce: LeaseAnnouncer<'_>,
) -> Result<(), NativeError> {
    if !lease.enabled {
        return Ok(());
    }
    announce(LeaseEvent::Required, lease.page_number, lease.total_pages)?;
    wait_for_staged_page_input(
        &lease.input_path,
        lease.page_number,
        STAGED_INPUT_WAIT_TIMEOUT,
        STAGED_INPUT_POLL_INTERVAL,
    )
}

/// Block until the producer has published this page's raster.
///
/// The wait is deliberately a filesystem rendezvous rather than a second
/// control channel: the producer publishes the raster by atomically replacing
/// the manifest path, so the appearance of a regular file at that path is the
/// same "complete and readable" signal every other staged input carries.
pub(crate) fn wait_for_staged_page_input(
    path: &Path,
    page_number: usize,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<(), NativeError> {
    let deadline = Instant::now() + timeout;
    loop {
        if staged_input_is_ready(path, page_number)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(NativeError::new(
                NativeErrorCode::Io,
                format!(
                    "Staged scan-cleanup page {page_number} input was not published within {}s",
                    timeout.as_secs()
                ),
            ));
        }
        thread::sleep(poll_interval);
    }
}

/// Drop this page's staged-input lease. Every acquisition is paired with one
/// release, including the reconciliation rerun, so the owning process always
/// knows exactly which rasters the sidecar still holds.
pub(crate) fn release_staged_page_input(
    lease: &StagedLeaseDescriptor,
    announce: LeaseAnnouncer<'_>,
) -> Result<(), NativeError> {
    if !lease.enabled {
        return Ok(());
    }
    announce(LeaseEvent::Released, lease.page_number, lease.total_pages)
}

pub(crate) fn with_announced_staged_page_input<T>(
    lease: &StagedLeaseDescriptor,
    announce: LeaseAnnouncer<'_>,
    read: impl FnOnce() -> Result<T, NativeError>,
) -> Result<T, NativeError> {
    acquire_staged_page_input(lease, announce)?;
    let outcome = read();
    // The lease is released even when the read failed: the owning process must
    // be able to reclaim that scratch raster before it rolls the run back.
    let released = release_staged_page_input(lease, announce);
    outcome.and_then(|value| released.map(|()| value))
}

pub(crate) fn run_stream_page_jobs<T, F>(
    batch: &StagedInputBatch,
    task: F,
) -> Result<Vec<T>, Box<dyn Error>>
where
    T: Send,
    F: Fn((usize, &StagedPageDescriptor)) -> Result<T, NativeError> + Send + Sync,
{
    if batch.raster_window <= 1 {
        // A FIFO is a one-shot transport, not a replayable page file. Direct
        // callers coordinate no producer window, so keep the conservative
        // acknowledgement turnstile: it never opens an unwritten future FIFO
        // after a task failure and bounds scratch to one raster.
        return thread::scope(|scope| {
            let (sender, receiver) = sync_channel(0);
            let (acknowledge, acknowledged) = sync_channel(0);
            let canceled = Arc::new(AtomicBool::new(false));
            let reader_canceled = Arc::clone(&canceled);
            scope.spawn(move || {
                for (index, page) in batch.pages.iter().enumerate() {
                    let materialized = materialize_stream_page(index, page, || {
                        reader_canceled.load(Ordering::Acquire)
                    });
                    let failed = materialized.is_err();
                    if sender.send(materialized).is_err() || failed {
                        break;
                    }
                    // Taking a rendezvous message does not mean page processing
                    // succeeded. Wait for its explicit acknowledgement before
                    // opening the next FIFO, otherwise a task failure can strand
                    // this scoped thread forever in an unwritten future stream.
                    if acknowledged.recv() != Ok(true) {
                        break;
                    }
                }
            });

            let mut results = Vec::with_capacity(batch.pages.len());
            let mut first_error = None;
            for (index, materialized) in receiver.into_iter().enumerate() {
                match materialized {
                    Ok(materialized) if first_error.is_none() => {
                        match task((index, &materialized.page)) {
                            Ok(result) => {
                                results.push(result);
                                if acknowledge.send(true).is_err() {
                                    first_error = Some(NativeError::new(
                                        NativeErrorCode::Io,
                                        "Streamed scan-cleanup reader stopped before acknowledgement",
                                    ));
                                }
                            }
                            Err(error) => {
                                canceled.store(true, Ordering::Release);
                                first_error = Some(error);
                                let _ = acknowledge.send(false);
                            }
                        }
                    }
                    Ok(_) => {
                        let _ = acknowledge.send(false);
                    }
                    Err(error) => {
                        canceled.store(true, Ordering::Release);
                        first_error.get_or_insert(error);
                        break;
                    }
                }
            }
            match first_error {
                Some(error) => Err(error.into()),
                None if results.len() == batch.pages.len() => Ok(results),
                None => Err(invalid("Streamed scan-cleanup input ended before every page").into()),
            }
        });
    }

    // The owning process has promised this many concurrent producers. Keep
    // page processing serial (nested Rayon work still owns the native pool),
    // but let the dedicated reader materialize the next pages while the
    // current page is processed. The channel is two slots smaller than the
    // window because the processing page and the reader's in-progress page
    // are both live outside it.
    let channel_capacity = batch.raster_window.saturating_sub(2);
    thread::scope(|scope| {
        let (sender, receiver) = sync_channel(channel_capacity);
        let canceled = Arc::new(AtomicBool::new(false));
        let reader_canceled = Arc::clone(&canceled);
        scope.spawn(move || {
            for (index, page) in batch.pages.iter().enumerate() {
                if reader_canceled.load(Ordering::Acquire) {
                    break;
                }
                let materialized = materialize_stream_page(index, page, || {
                    reader_canceled.load(Ordering::Acquire)
                });
                let failed = materialized.is_err();
                if sender.send(materialized).is_err() || failed {
                    break;
                }
            }
        });

        let mut results = Vec::with_capacity(batch.pages.len());
        let mut first_error = None;
        for (index, materialized) in receiver.into_iter().enumerate() {
            match materialized {
                Ok(materialized) => match task((index, &materialized.page)) {
                    Ok(result) => results.push(result),
                    Err(error) => {
                        canceled.store(true, Ordering::Release);
                        first_error = Some(error);
                        break;
                    }
                },
                Err(error) => {
                    canceled.store(true, Ordering::Release);
                    first_error = Some(error);
                    break;
                }
            }
        }
        match first_error {
            Some(error) => Err(error.into()),
            None if results.len() == batch.pages.len() => Ok(results),
            None => Err(invalid("Streamed scan-cleanup input ended before every page").into()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use evb_native_support::{NativeError, NativeErrorCode};
    use std::{
        fs,
        path::PathBuf,
        sync::{atomic::AtomicUsize, Mutex},
        thread,
        time::Duration,
    };

    fn staged_page(
        input_path: PathBuf,
        metadata_path: PathBuf,
        source_page_index: usize,
        stream_input: bool,
        max_bytes: usize,
    ) -> StagedPageDescriptor {
        StagedPageDescriptor {
            input_path,
            metadata_path,
            source_page_index,
            max_bytes,
            stream_input,
        }
    }

    fn staged_batch(pages: Vec<StagedPageDescriptor>, raster_window: usize) -> StagedInputBatch {
        StagedInputBatch {
            raster_window,
            pages,
        }
    }

    fn staged_lease(
        input_path: PathBuf,
        page_number: usize,
        total_pages: usize,
        enabled: bool,
    ) -> StagedLeaseDescriptor {
        StagedLeaseDescriptor {
            input_path,
            page_number,
            total_pages,
            enabled,
        }
    }

    #[cfg(unix)]
    #[test]
    fn streamed_pages_are_bounded_materialized_files_during_processing() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-materialization-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo_paths = (0..3)
            .map(|index| dir.join(format!("page-{index}.fifo")))
            .collect::<Vec<_>>();
        for fifo in &fifo_paths {
            assert!(std::process::Command::new("mkfifo")
                .arg(fifo)
                .status()
                .unwrap()
                .success());
        }
        let batch = staged_batch(
            fifo_paths
                .iter()
                .enumerate()
                .map(|(index, input_path)| {
                    staged_page(
                        input_path.clone(),
                        dir.join(format!("page-{index}.json")),
                        index,
                        true,
                        crate::io::MAX_STREAM_INPUT_BYTES,
                    )
                })
                .collect(),
            1,
        );
        let producer_paths = fifo_paths.clone();
        let producer = std::thread::spawn(move || {
            for (index, path) in producer_paths.iter().enumerate() {
                fs::write(path, format!("page-{index}")).unwrap();
            }
        });

        let processed = run_stream_page_jobs(&batch, |(index, page)| {
            let metadata = fs::metadata(&page.input_path).unwrap();
            assert!(metadata.is_file(), "the task must never reopen a FIFO");
            let bytes = fs::read(&page.input_path).unwrap();
            assert_eq!(bytes, format!("page-{index}").as_bytes());
            Ok::<_, NativeError>(bytes)
        })
        .unwrap();

        producer.join().unwrap();
        assert_eq!(processed.len(), 3);
        assert!(
            fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".raster")),
            "bounded materializations must be removed after processing"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn streamed_page_window_overlaps_materialization_without_exceeding_its_bound() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-window-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo_paths = (0..5)
            .map(|index| dir.join(format!("page-{index}.fifo")))
            .collect::<Vec<_>>();
        for fifo in &fifo_paths {
            assert!(std::process::Command::new("mkfifo")
                .arg(fifo)
                .status()
                .unwrap()
                .success());
        }
        let batch = staged_batch(
            fifo_paths
                .iter()
                .enumerate()
                .map(|(index, input_path)| {
                    staged_page(
                        input_path.clone(),
                        dir.join(format!("page-{index}.json")),
                        index,
                        true,
                        crate::io::MAX_STREAM_INPUT_BYTES,
                    )
                })
                .collect(),
            3,
        );
        let producer_paths = fifo_paths.clone();
        let producer = std::thread::spawn(move || {
            for (index, path) in producer_paths.iter().enumerate() {
                fs::write(path, format!("page-{index}")).unwrap();
            }
        });
        let observed_lookahead = AtomicBool::new(false);
        let peak_materializations = AtomicUsize::new(0);
        let count_materializations = || {
            fs::read_dir(&dir)
                .unwrap()
                .filter(|entry| {
                    entry
                        .as_ref()
                        .is_ok_and(|entry| entry.file_name().to_string_lossy().contains(".raster"))
                })
                .count()
        };

        let processed = run_stream_page_jobs(&batch, |(index, page)| {
            if index == 0 {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                loop {
                    let live = count_materializations();
                    peak_materializations.fetch_max(live, Ordering::AcqRel);
                    if live == batch.raster_window {
                        observed_lookahead.store(true, Ordering::Release);
                        break;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "reader did not fill the promised raster window"
                    );
                    std::thread::yield_now();
                }
            }
            let live = count_materializations();
            peak_materializations.fetch_max(live, Ordering::AcqRel);
            assert!(live <= batch.raster_window);
            let bytes = fs::read(&page.input_path).unwrap();
            assert_eq!(bytes, format!("page-{index}").as_bytes());
            Ok::<_, NativeError>(bytes)
        })
        .unwrap();

        producer.join().unwrap();
        assert_eq!(processed.len(), 5);
        assert!(observed_lookahead.load(Ordering::Acquire));
        assert_eq!(peak_materializations.load(Ordering::Acquire), 3);
        assert!(
            fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".raster")),
            "windowed materializations must be removed after processing"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_released_staged_input_is_replayable_for_a_second_read() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-staged-replay-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input_path = dir.join("page-0.png");
        let lease = staged_lease(input_path.clone(), 1, 1, true);
        let renders = AtomicUsize::new(0);
        let announce = |stage: LeaseEvent, page_number: usize, _total: usize| {
            assert_eq!(page_number, 1);
            match stage {
                LeaseEvent::Required => {
                    renders.fetch_add(1, Ordering::AcqRel);
                    fs::write(&input_path, b"deterministic").unwrap();
                }
                // Releasing drops the raster, exactly as a one-page window does.
                LeaseEvent::Released => {
                    fs::remove_file(&input_path).unwrap();
                }
            }
            Ok(())
        };
        for _ in 0..2 {
            let bytes = with_announced_staged_page_input(&lease, &announce, || {
                Ok(fs::read(&input_path).unwrap())
            })
            .unwrap();
            assert_eq!(bytes, b"deterministic");
        }
        assert_eq!(renders.load(Ordering::Acquire), 2);
        assert!(!input_path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_staged_page_read_still_releases_its_lease() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-staged-failure-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input_path = dir.join("page-0.png");
        fs::write(&input_path, b"page").unwrap();
        let lease = staged_lease(input_path, 1, 1, true);
        let leases: Mutex<Vec<LeaseEvent>> = Mutex::new(Vec::new());
        let announce = |stage: LeaseEvent, _page: usize, _total: usize| {
            leases.lock().unwrap().push(stage);
            Ok(())
        };
        let error = with_announced_staged_page_input(&lease, &announce, || {
            Err::<(), _>(NativeError::new(NativeErrorCode::Io, "page failed"))
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "page failed");
        assert_eq!(
            leases.into_inner().unwrap(),
            vec![LeaseEvent::Required, LeaseEvent::Released]
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_manifest_without_a_staged_window_announces_no_leases() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-staged-absent-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input_path = dir.join("page-0.png");
        let lease = staged_lease(input_path, 1, 1, false);
        let announced = AtomicUsize::new(0);
        let announce = |_stage: LeaseEvent, _page: usize, _total: usize| {
            announced.fetch_add(1, Ordering::AcqRel);
            Ok(())
        };
        with_announced_staged_page_input(&lease, &announce, || Ok(())).unwrap();
        assert_eq!(announced.load(Ordering::Acquire), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_staged_input_that_is_never_published_fails_instead_of_hanging() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-staged-timeout-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let error = wait_for_staged_page_input(
            &dir.join("absent.png"),
            7,
            Duration::from_millis(40),
            Duration::from_millis(5),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("page 7 input was not published"),
            "{error}"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_staged_input_published_after_a_delay_is_awaited() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-staged-delay-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("late.png");
        let producer_path = path.clone();
        let producer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(60));
            fs::write(&producer_path, b"late").unwrap();
        });
        wait_for_staged_page_input(&path, 1, Duration::from_secs(30), Duration::from_millis(5))
            .unwrap();
        producer.join().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"late");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn oversized_stream_removes_its_partial_materialization() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-oversize-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("page.fifo");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let descriptor = staged_page(fifo.clone(), dir.join("page.json"), 0, true, 8);
        let producer = std::thread::spawn(move || {
            let _ = fs::write(fifo, b"this stream is larger than eight bytes");
        });

        let error = match materialize_stream_page(0, &descriptor, || false) {
            Ok(_) => panic!("oversize stream unexpectedly materialized"),
            Err(error) => error,
        };

        producer.join().unwrap();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".raster")));
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn first_stream_task_failure_never_opens_an_unwritten_next_fifo() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-turnstile-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo_paths = [dir.join("page-0.fifo"), dir.join("page-1.fifo")];
        for fifo in &fifo_paths {
            assert!(std::process::Command::new("mkfifo")
                .arg(fifo)
                .status()
                .unwrap()
                .success());
        }
        let batch = staged_batch(
            fifo_paths
                .iter()
                .enumerate()
                .map(|(index, input_path)| {
                    staged_page(
                        input_path.clone(),
                        dir.join(format!("page-{index}.json")),
                        index,
                        true,
                        crate::io::MAX_STREAM_INPUT_BYTES,
                    )
                })
                .collect(),
            1,
        );
        let first_fifo = fifo_paths[0].clone();
        let producer = std::thread::spawn(move || fs::write(first_fifo, b"first page"));

        let error = run_stream_page_jobs(&batch, |(index, _)| {
            Err::<(), _>(NativeError::new(
                NativeErrorCode::NativeFailure,
                format!("page {} failed", index + 1),
            ))
        })
        .unwrap_err();

        producer.join().unwrap().unwrap();
        assert!(error.to_string().contains("page 1 failed"));
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".raster")));
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn windowed_stream_task_failure_cancels_an_open_unwritten_fifo() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-window-failure-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo_paths = (0..3)
            .map(|index| dir.join(format!("page-{index}.fifo")))
            .collect::<Vec<_>>();
        for fifo in &fifo_paths {
            assert!(std::process::Command::new("mkfifo")
                .arg(fifo)
                .status()
                .unwrap()
                .success());
        }
        let batch = staged_batch(
            fifo_paths
                .iter()
                .enumerate()
                .map(|(index, input_path)| {
                    staged_page(
                        input_path.clone(),
                        dir.join(format!("page-{index}.json")),
                        index,
                        true,
                        crate::io::MAX_STREAM_INPUT_BYTES,
                    )
                })
                .collect(),
            3,
        );
        let first_fifo = fifo_paths[0].clone();
        let producer = std::thread::spawn(move || fs::write(first_fifo, b"first page"));
        let (finished_sender, finished_receiver) = std::sync::mpsc::channel();
        let run = std::thread::spawn(move || {
            let result = run_stream_page_jobs(&batch, |(index, _)| {
                Err::<(), _>(NativeError::new(
                    NativeErrorCode::NativeFailure,
                    format!("page {} failed", index + 1),
                ))
            });
            let _ = finished_sender.send(result.map_err(|error| error.to_string()));
        });

        producer.join().unwrap().unwrap();
        let error = finished_receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("windowed reader remained blocked on an unwritten future FIFO")
            .unwrap_err();
        run.join().unwrap();
        assert!(error.contains("page 1 failed"));
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".raster")));
        let _ = fs::remove_dir_all(dir);
    }
}
