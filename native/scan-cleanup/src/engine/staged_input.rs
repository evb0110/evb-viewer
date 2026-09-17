//! Stream and staged raster input coordination.
//!
//! The manifest metadata directory is admitted and preflighted before this
//! module materializes streamed pages. Its randomized `create_new` temporary
//! protects that materialization boundary while the directory is treated as
//! process-owned for the duration of the operation.
use crate::engine::resource_planning::{
    CleanupOptionsView, PageDescriptor, PlanningManifest, PlanningOperation,
};
use crate::io::MAX_STREAM_INPUT_BYTES;
use crate::io::{copy_bounded_cancelable, open_randomized_temporary, raster, BoundedIoError};
use crate::protocol::manifest_v3::{normalized_path, ManifestV3, Operation, Page};
use evb_native_support::{output::existing_file_identity, NativeError, NativeErrorCode};
use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
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

pub(crate) fn planning_page(page: &Page) -> PageDescriptor {
    PageDescriptor {
        input_path: page.input_path.clone(),
        source_page_index: page.source_page_index,
        stream_input: fs::metadata(&page.input_path)
            .is_ok_and(|metadata| !metadata.file_type().is_file()),
        trusted_foreground_mask_path: page.trusted_foreground_mask_path.clone(),
        trusted_mrc_background_path: page.trusted_mrc_background_path.clone(),
        options: CleanupOptionsView {
            max_pixels: page.options.max_pixels,
            max_dimension: page.options.max_dimension,
            output_mode: page.options.output_mode,
            source_has_bilevel_layer: page.options.source_has_bilevel_layer,
            thickness: page.options.thickness,
        },
    }
}

fn planning_page_from_staged(
    original: &PageDescriptor,
    staged: &StagedPageDescriptor,
) -> PageDescriptor {
    PageDescriptor {
        input_path: staged.input_path.clone(),
        stream_input: staged.stream_input,
        ..original.clone()
    }
}

pub(crate) fn page_from_staged(page: &Page, staged: &PageDescriptor) -> Page {
    let mut translated = page.clone();
    translated.input_path = staged.input_path.clone();
    translated
}

fn staged_page_descriptor(page: &Page) -> StagedPageDescriptor {
    let stream_input =
        fs::metadata(&page.input_path).is_ok_and(|metadata| !metadata.file_type().is_file());
    staged_page_descriptor_with_stream(page, stream_input)
}

fn staged_page_descriptor_with_stream(page: &Page, stream_input: bool) -> StagedPageDescriptor {
    StagedPageDescriptor {
        input_path: page.input_path.clone(),
        metadata_path: page.page_metadata_path.clone(),
        source_page_index: page.source_page_index,
        max_bytes: MAX_STREAM_INPUT_BYTES,
        stream_input,
    }
}

fn staged_input_batch(manifest: &ManifestV3) -> StagedInputBatch {
    StagedInputBatch {
        raster_window: manifest.raster_window,
        pages: manifest.pages.iter().map(staged_page_descriptor).collect(),
    }
}

pub(crate) fn run_one_staged_page_job<T, F>(
    manifest: &ManifestV3,
    index: usize,
    stream_input: bool,
    task: F,
) -> Result<T, Box<dyn Error>>
where
    T: Send,
    F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
{
    let batch = StagedInputBatch {
        raster_window: 1,
        pages: vec![staged_page_descriptor_with_stream(
            &manifest.pages[index],
            stream_input,
        )],
    };
    let mut results = crate::engine::staged_input::run_stream_page_jobs(&batch, |(_, staged)| {
        let original = planning_page(&manifest.pages[index]);
        let descriptor = planning_page_from_staged(&original, staged);
        task((index, &descriptor))
    })?;
    results.pop().ok_or_else(|| {
        NativeError::new(
            NativeErrorCode::NativeFailure,
            "Staged scan-cleanup page job produced no result",
        )
        .into()
    })
}

pub(crate) fn staged_path_plan(manifest: &ManifestV3) -> StagedPathPlan {
    StagedPathPlan {
        input_paths: manifest
            .input_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect(),
        destination_paths: manifest
            .destination_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect(),
    }
}

pub(crate) fn staged_lease(
    manifest: &ManifestV3,
    page_index: usize,
    page: &Page,
) -> StagedLeaseDescriptor {
    StagedLeaseDescriptor {
        input_path: page.input_path.clone(),
        page_number: page_index.saturating_add(1),
        total_pages: manifest.pages.len(),
        enabled: manifest.staged_input_window.is_some(),
    }
}

pub(crate) fn planning_operation(operation: Operation) -> PlanningOperation {
    match operation {
        Operation::Analyze => PlanningOperation::Analyze,
        Operation::Render => PlanningOperation::Render,
    }
}

impl PlanningManifest for ManifestV3 {
    fn operation(&self) -> PlanningOperation {
        planning_operation(self.operation)
    }

    fn host_memory_bytes(&self) -> Option<u64> {
        self.host_memory_bytes
    }

    fn staged_input_window(&self) -> Option<usize> {
        self.staged_input_window
    }

    fn staged_input_peak_pixels(&self) -> Option<u64> {
        self.staged_input_peak_pixels
    }

    fn page_count(&self) -> usize {
        self.pages.len()
    }

    fn page(&self, index: usize) -> PageDescriptor {
        planning_page(&self.pages[index])
    }

    fn run_stream_page_jobs<T, F>(&self, task: F) -> Result<Vec<T>, Box<dyn Error>>
    where
        T: Send,
        F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
    {
        let batch = staged_input_batch(self);
        crate::engine::staged_input::run_stream_page_jobs(&batch, |(index, staged)| {
            let original = planning_page(&self.pages[index]);
            let descriptor = planning_page_from_staged(&original, staged);
            task((index, &descriptor))
        })
    }
}

pub(crate) fn finish_staged_rerun<T>(
    rerun_result: Result<T, Box<dyn Error>>,
    release_result: Result<(), NativeError>,
) -> Result<T, Box<dyn Error>> {
    match release_result {
        Ok(()) => rerun_result,
        Err(release_error) => match rerun_result {
            Ok(_) => Err(Box::new(release_error)),
            Err(rerun_error) => {
                eprintln!("Unable to release reconciliation staged input: {release_error}");
                Err(rerun_error)
            }
        },
    }
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
        if let Some(identity) = existing_file_identity(path).map_err(|error| {
            NativeError::new(
                NativeErrorCode::Io,
                format!("Unable to inspect input path {}: {error}", path.display()),
            )
        })? {
            input_files.insert(identity);
        }
    }
    let mut destination_paths = HashSet::new();
    let mut destination_files = HashSet::new();
    for path in &paths.destination_paths {
        let resolved = resolved_manifest_path(path);
        if input_paths.contains(&resolved)
            || existing_file_identity(path)
                .map_err(|error| {
                    NativeError::new(
                        NativeErrorCode::Io,
                        format!("Unable to inspect output path {}: {error}", path.display()),
                    )
                })?
                .is_some_and(|identity| input_files.contains(&identity))
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
                .map_err(|error| {
                    NativeError::new(
                        NativeErrorCode::Io,
                        format!("Unable to inspect output path {}: {error}", path.display()),
                    )
                })?
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
    let temporary_base = stream_materialized_path(page, index);
    let (mut destination, temporary_input) =
        open_randomized_temporary(&temporary_base, &mut |bytes| {
            getrandom::fill(bytes)
                .map_err(|error| format!("unable to obtain random bytes: {error}"))
        })
        .map_err(|error| {
            NativeError::new(
                NativeErrorCode::Io,
                format!(
                    "Unable to reserve streamed scan-cleanup page {}: {error}",
                    page.source_page_index.saturating_add(1)
                ),
            )
        })?;
    let copy_result = (|| -> Result<(), BoundedIoError> {
        if is_canceled() {
            return Err(BoundedIoError::Canceled);
        }
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
        drop(destination);
        let _ = fs::remove_file(&temporary_input);
        let code = match &error {
            #[cfg(unix)]
            BoundedIoError::ConnectTimeout => NativeErrorCode::Timeout,
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
        let (producer_signal, producer_receiver) = std::sync::mpsc::channel();
        let producer_signaled = Mutex::new(producer_receiver);
        let producer = std::thread::spawn(move || {
            for (index, path) in producer_paths.iter().enumerate() {
                fs::write(path, format!("page-{index}")).unwrap();
                producer_signal.send(()).unwrap();
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
                let producer_signaled = producer_signaled.lock().unwrap();
                for _ in 0..batch.raster_window {
                    producer_signaled
                        .recv()
                        .expect("producer did not publish a lookahead page");
                }
                let live = count_materializations();
                peak_materializations.fetch_max(live, Ordering::AcqRel);
                assert_eq!(live, batch.raster_window);
                observed_lookahead.store(true, Ordering::Release);
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
    fn precreated_stream_materialization_path_is_not_followed() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-randomized-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("page.fifo");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let descriptor = staged_page(fifo.clone(), dir.join("page.json"), 0, true, 64);
        let predicted_path = stream_materialized_path(&descriptor, 0);
        let protected = dir.join("protected");
        fs::write(&protected, b"must survive").unwrap();
        std::os::unix::fs::symlink(&protected, &predicted_path).unwrap();
        let producer = std::thread::spawn(move || {
            fs::write(fifo, b"streamed page").unwrap();
        });

        let materialized = materialize_stream_page(0, &descriptor, || false).unwrap();
        producer.join().unwrap();
        assert_eq!(fs::read(&protected).unwrap(), b"must survive");
        assert!(fs::symlink_metadata(&predicted_path)
            .unwrap()
            .file_type()
            .is_symlink());
        let actual_path = materialized.page.input_path.clone();
        assert_ne!(actual_path, predicted_path);
        drop(materialized);
        assert!(!actual_path.exists());
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
#[cfg(test)]
mod moved_tests {
    use super::*;
    use crate::engine::resource_planning::{
        manifest_cache, page_cache_for, PlanningManifest, PlanningOperation,
    };
    use crate::protocol::manifest_v3::{
        AnalysisPurpose, CanvasScope, DetailPixelRect, DetailRenderPlan, ManifestV3, Operation,
        Page, PageOutput, RenderMode, VERSION,
    };
    use crate::CleanupOptions;
    use evb_native_support::NativeError;
    use std::{
        fs,
        io::Write,
        path::{Path, PathBuf},
        thread,
    };

    fn assert_manifest_paths_within_root(
        manifest: &ManifestV3,
        root: &Path,
    ) -> Result<(), NativeError> {
        super::assert_paths_within_root(&super::staged_path_plan(manifest), root)
    }

    fn preflight_manifest_paths(manifest: &ManifestV3) -> Result<(), NativeError> {
        super::preflight_paths(&super::staged_path_plan(manifest))
    }

    #[cfg(unix)]
    #[test]
    fn allowed_path_root_rejects_symlink_escapes_and_keeps_real_descendants() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-allowed-root-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("input.png"), b"input").unwrap();
        fs::write(outside.join("secret.png"), b"secret").unwrap();
        symlink(outside.join("secret.png"), root.join("input-link.png")).unwrap();
        symlink(&outside, root.join("escape-dir")).unwrap();
        symlink(root.join("input.png"), root.join("inside-link.png")).unwrap();
        symlink(outside.join("missing.png"), root.join("dangling.png")).unwrap();

        let manifest_with = |input: PathBuf, output: PathBuf| ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::Classification,
            render_mode: RenderMode::Final,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: vec![Page {
                input_path: input,
                analysis_input_path: None,
                analysis_dpi: None,
                trusted_foreground_mask_path: None,
                trusted_mrc_background_path: None,
                source_page_index: 0,
                page_metadata_path: root.join("page.json"),
                options: CleanupOptions {
                    match_page_size: false,
                    ..CleanupOptions::default()
                },
                document_prior: None,
                detail_render_plan: None,
                outputs: vec![PageOutput {
                    output_path: output,
                    metadata_path: root.join("output.json"),
                    bilevel_output_path: None,
                    background_output_path: None,
                    foreground_mask_output_path: None,
                    foreground_alpha_output_path: None,
                    picture_mask_output_path: None,
                    tone_preservation_alpha_output_path: None,
                }],
            }],
        };

        // A real input and a not-yet-created output below a real directory.
        assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("nested/output.png")),
            &root,
        )
        .unwrap();

        // A symlink that resolves back inside the root stays valid.
        assert_manifest_paths_within_root(
            &manifest_with(root.join("inside-link.png"), root.join("nested/output.png")),
            &root,
        )
        .unwrap();

        // An existing input symlink pointing outside the root.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input-link.png"), root.join("nested/output.png")),
            &root,
        )
        .unwrap_err()
        .to_string()
        .contains("escapes the allowed path root"));

        // A missing output below a symlinked external ancestor.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("escape-dir/output.png")),
            &root,
        )
        .unwrap_err()
        .to_string()
        .contains("escapes the allowed path root"));

        // A lexical escape that never touches the filesystem.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("../outside/output.png")),
            &root,
        )
        .unwrap_err()
        .to_string()
        .contains("escapes the allowed path root"));

        // A dangling symlink resolves to nothing this root can vouch for.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("dangling.png"), root.join("nested/output.png")),
            &root,
        )
        .unwrap_err()
        .to_string()
        .contains("cannot be resolved"));

        // input_paths() and destination_paths() carry more than inputPath and
        // the primary output. Every auxiliary entry is judged by the same root,
        // so each slot is filled twice: once with a symlink that resolves back
        // inside the root, once with one that resolves outside it.
        let inside_link = root.join("inside-link.png");
        let outside_link = root.join("input-link.png");
        let detail_plan = |base_metadata: PathBuf, base_raster: PathBuf, base_cleaned: PathBuf| {
            let region = DetailPixelRect {
                x_px: 0.0,
                y_px: 0.0,
                width_px: 16.0,
                height_px: 16.0,
            };
            DetailRenderPlan {
                base_metadata_path: base_metadata,
                base_raster_path: base_raster,
                base_cleaned_raster_path: Some(base_cleaned),
                source_crop: region.clone(),
                full_source_width_px: 32,
                full_source_height_px: 32,
                scale: 1.0,
                render_region: region.clone(),
                sampled_region: region,
            }
        };
        let detail_slot = |select: fn(PathBuf, PathBuf) -> (PathBuf, PathBuf, PathBuf)| {
            let inside = inside_link.clone();
            move |page: &mut Page, path: PathBuf| {
                let (base_metadata, base_raster, base_cleaned) = select(path, inside.clone());
                page.detail_render_plan =
                    Some(detail_plan(base_metadata, base_raster, base_cleaned));
            }
        };
        type AuxiliarySlot = (&'static str, Box<dyn Fn(&mut Page, PathBuf)>);
        let auxiliary_slots: Vec<AuxiliarySlot> = vec![
            (
                "analysisInputPath",
                Box::new(|page: &mut Page, path| {
                    page.analysis_input_path = Some(path);
                    page.analysis_dpi = Some(150.0);
                }),
            ),
            (
                "trustedForegroundMaskPath",
                Box::new(|page: &mut Page, path| page.trusted_foreground_mask_path = Some(path)),
            ),
            (
                "trustedMrcBackgroundPath",
                Box::new(|page: &mut Page, path| page.trusted_mrc_background_path = Some(path)),
            ),
            (
                "detailRenderPlan.baseMetadataPath",
                Box::new(detail_slot(|path, inside| (path, inside.clone(), inside))),
            ),
            (
                "detailRenderPlan.baseRasterPath",
                Box::new(detail_slot(|path, inside| (inside.clone(), path, inside))),
            ),
            (
                "detailRenderPlan.baseCleanedRasterPath",
                Box::new(detail_slot(|path, inside| (inside.clone(), inside, path))),
            ),
            (
                "pageMetadataPath",
                Box::new(|page: &mut Page, path| page.page_metadata_path = path),
            ),
            (
                "outputs.metadataPath",
                Box::new(|page: &mut Page, path| page.outputs[0].metadata_path = path),
            ),
            (
                "outputs.bilevelOutputPath",
                Box::new(|page: &mut Page, path| page.outputs[0].bilevel_output_path = Some(path)),
            ),
            (
                "outputs.backgroundOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].background_output_path = Some(path)
                }),
            ),
            (
                "outputs.foregroundMaskOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].foreground_mask_output_path = Some(path)
                }),
            ),
            (
                "outputs.foregroundAlphaOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].foreground_alpha_output_path = Some(path)
                }),
            ),
            (
                "outputs.pictureMaskOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].picture_mask_output_path = Some(path)
                }),
            ),
            (
                "outputs.tonePreservationAlphaOutputPath",
                Box::new(|page: &mut Page, path| {
                    page.outputs[0].tone_preservation_alpha_output_path = Some(path)
                }),
            ),
        ];
        for (label, fill) in &auxiliary_slots {
            let mut accepted =
                manifest_with(root.join("input.png"), root.join("nested/output.png"));
            fill(&mut accepted.pages[0], inside_link.clone());
            assert!(
                assert_manifest_paths_within_root(&accepted, &root).is_ok(),
                "{label} resolving inside the root must be accepted",
            );

            let mut rejected =
                manifest_with(root.join("input.png"), root.join("nested/output.png"));
            fill(&mut rejected.pages[0], outside_link.clone());
            let error = assert_manifest_paths_within_root(&rejected, &root)
                .expect_err(&format!(
                    "{label} resolving outside the root must be rejected"
                ))
                .to_string();
            assert!(
                error.contains("escapes the allowed path root"),
                "{label}: {error}"
            );
        }

        // A missing or non-directory root is rejected before any path check.
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("nested/output.png")),
            &base.join("no-such-root"),
        )
        .unwrap_err()
        .to_string()
        .contains("not an existing directory"));
        assert!(assert_manifest_paths_within_root(
            &manifest_with(root.join("input.png"), root.join("nested/output.png")),
            &root.join("input.png"),
        )
        .unwrap_err()
        .to_string()
        .contains("not a directory"));

        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_path_preflight_rejects_hardlink_aliases() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-manifest-aliases-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("input.png");
        let input_alias = dir.join("input-alias.png");
        fs::write(&input, b"input").unwrap();
        fs::hard_link(&input, &input_alias).unwrap();
        let mut manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Analyze,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::default(),
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: vec![Page {
                input_path: input,
                analysis_input_path: None,
                analysis_dpi: None,
                trusted_foreground_mask_path: None,
                trusted_mrc_background_path: None,
                source_page_index: 0,
                page_metadata_path: input_alias,
                options: CleanupOptions::default(),
                document_prior: None,
                detail_render_plan: None,
                outputs: Vec::new(),
            }],
        };
        manifest.validate().unwrap();
        assert!(preflight_manifest_paths(&manifest)
            .unwrap_err()
            .to_string()
            .contains("aliases an input file"));

        let shared_destination = dir.join("shared-destination");
        let destination_alias = dir.join("destination-alias");
        fs::write(&shared_destination, b"old output").unwrap();
        fs::hard_link(&shared_destination, &destination_alias).unwrap();
        manifest.operation = Operation::Render;
        manifest.pages[0].options.match_page_size = false;
        manifest.pages[0].page_metadata_path = shared_destination.clone();
        manifest.pages[0].outputs.push(PageOutput {
            output_path: dir.join("output.png"),
            metadata_path: destination_alias.clone(),
            bilevel_output_path: None,
            background_output_path: None,
            foreground_mask_output_path: None,
            foreground_alpha_output_path: None,
            picture_mask_output_path: None,
            tone_preservation_alpha_output_path: None,
        });
        manifest.validate().unwrap();
        assert!(preflight_manifest_paths(&manifest)
            .unwrap_err()
            .to_string()
            .contains("different files"));
        assert_eq!(fs::read(&shared_destination).unwrap(), b"old output");
        assert_eq!(fs::read(&destination_alias).unwrap(), b"old output");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn staged_translation_passes_materialized_input_to_downstream_once() {
        let original = PageDescriptor {
            input_path: PathBuf::from("/source/page.fifo"),
            source_page_index: 4,
            options: CleanupOptionsView {
                max_pixels: 100,
                max_dimension: 200,
                output_mode: crate::OutputMode::Auto,
                source_has_bilevel_layer: false,
                thickness: 0,
            },
            stream_input: true,
            trusted_foreground_mask_path: None,
            trusted_mrc_background_path: None,
        };
        let staged = StagedPageDescriptor {
            input_path: PathBuf::from("/scratch/materialized-page.raster"),
            metadata_path: PathBuf::from("/scratch/page.json"),
            source_page_index: 4,
            max_bytes: MAX_STREAM_INPUT_BYTES,
            stream_input: false,
        };

        let materialized = std::env::temp_dir().join(format!(
            "scan-cleanup-adapter-staged-{}-{}.raster",
            std::process::id(),
            original.source_page_index
        ));
        fs::write(&materialized, b"materialized page").unwrap();
        let staged = StagedPageDescriptor {
            input_path: materialized.clone(),
            ..staged
        };
        let translated = super::planning_page_from_staged(&original, &staged);
        assert_eq!(translated.input_path, staged.input_path);
        assert!(!translated.stream_input);
        assert_eq!(translated.source_page_index, original.source_page_index);
        let cache = manifest_cache(PlanningOperation::Analyze, None);
        assert!(page_cache_for(&translated, &cache).is_ok());
        assert!(!original.input_path.exists());
        fs::remove_file(materialized).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn production_stream_planning_reads_the_materialized_fifo_copy_once() {
        use crate::protocol::manifest_v3::{
            AnalysisPurpose, CanvasScope, Operation, RenderMode, VERSION,
        };
        use std::os::unix::fs::FileTypeExt;

        let root =
            std::env::temp_dir().join(format!("scan-cleanup-adapter-fifo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let fifo = root.join("source.fifo");
        let fifo_c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert!(fs::metadata(&fifo).unwrap().file_type().is_fifo());

        let page = crate::protocol::manifest_v3::Page {
            input_path: fifo.clone(),
            analysis_input_path: None,
            analysis_dpi: None,
            trusted_foreground_mask_path: None,
            trusted_mrc_background_path: None,
            outputs: Vec::new(),
            source_page_index: 0,
            page_metadata_path: root.join("page.json"),
            options: crate::CleanupOptions::default(),
            document_prior: None,
            detail_render_plan: None,
        };
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Preview,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: vec![page],
        };
        let producer_path = fifo.clone();
        let producer = thread::spawn(move || {
            let mut source = fs::OpenOptions::new()
                .write(true)
                .open(producer_path)
                .unwrap();
            source.write_all(b"one materialized read").unwrap();
        });

        let reads = manifest
            .run_stream_page_jobs(|(_, descriptor)| {
                assert_ne!(descriptor.input_path, fifo);
                assert!(!descriptor.stream_input);
                Ok::<_, NativeError>(fs::read(&descriptor.input_path).unwrap())
            })
            .unwrap();
        producer.join().unwrap();

        assert_eq!(reads, vec![b"one materialized read".to_vec()]);
        assert!(fs::metadata(&fifo).unwrap().file_type().is_fifo());
        fs::remove_dir_all(root).unwrap();
    }
}
