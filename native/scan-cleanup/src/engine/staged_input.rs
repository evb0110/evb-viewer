//! Staged raster input coordination.
use crate::engine::resource_planning::{
    CleanupOptionsView, PageDescriptor, PlanningManifest, PlanningOperation,
};
use crate::io::raster;
use crate::protocol::manifest_v3::{normalized_path, ManifestV3, Operation, Page};
use evb_native_support::{output::existing_file_identity, NativeError, NativeErrorCode};
use std::collections::HashSet;
use std::error::Error;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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

pub(crate) fn page_from_staged(page: &Page, staged: &PageDescriptor) -> Page {
    let mut translated = page.clone();
    translated.input_path = staged.input_path.clone();
    translated
}

pub(crate) fn run_one_staged_page_job<T, F>(
    manifest: &ManifestV3,
    index: usize,
    is_canceled: &AtomicBool,
    task: F,
) -> Result<T, Box<dyn Error>>
where
    T: Send,
    F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
{
    if is_canceled.load(Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    let descriptor = planning_page(&manifest.pages[index]);
    task((index, &descriptor)).map_err(Into::into)
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

pub(crate) fn assert_paths_within_root(
    paths: &StagedPathPlan,
    root: &Path,
) -> Result<(), NativeError> {
    // This pass answers the allowed-root question using canonical ancestors.
    // preflight_paths below intentionally performs the separate lexical and
    // inode identity checks needed for input/output aliasing.
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
    // The path plan was snapshotted once by staged_path_plan; this pass walks
    // that snapshot for aliases and file identities without rebuilding the
    // manifest's destination list.
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
    is_canceled: &AtomicBool,
) -> Result<(), NativeError> {
    if is_canceled.load(Ordering::Acquire) {
        return Err(crate::engine::cancellation_error());
    }
    if !lease.enabled {
        return Ok(());
    }
    announce(LeaseEvent::Required, lease.page_number, lease.total_pages)?;
    let waited = wait_for_staged_page_input(
        &lease.input_path,
        lease.page_number,
        STAGED_INPUT_WAIT_TIMEOUT,
        STAGED_INPUT_POLL_INTERVAL,
        is_canceled,
    );
    if let Err(error) = waited {
        // The producer must be told that the failed wait no longer owns a
        // lease, including the prompt cancellation path. Preserve the wait
        // error as the primary result if that acknowledgement also fails.
        return match announce(LeaseEvent::Released, lease.page_number, lease.total_pages) {
            Ok(()) => Err(error),
            Err(release_error) => Err(NativeError::new(
                error.code,
                format!(
                    "{}; releasing staged-input lease failed: {}",
                    error.message, release_error.message
                ),
            )),
        };
    }
    Ok(())
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
    is_canceled: &AtomicBool,
) -> Result<(), NativeError> {
    let deadline = Instant::now() + timeout;
    loop {
        if is_canceled.load(Ordering::Acquire) {
            return Err(crate::engine::cancellation_error());
        }
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
    is_canceled: &AtomicBool,
    read: impl FnOnce() -> Result<T, NativeError>,
) -> Result<T, NativeError> {
    acquire_staged_page_input(lease, announce, is_canceled)?;
    let outcome = read();
    // The lease is released even when the read failed: the owning process must
    // be able to reclaim that scratch raster before it rolls the run back.
    let released = release_staged_page_input(lease, announce);
    outcome.and_then(|value| released.map(|()| value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use evb_native_support::{NativeError, NativeErrorCode};
    use std::{
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, AtomicUsize},
            Mutex,
        },
        thread,
        time::Duration,
    };

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
            let bytes = with_announced_staged_page_input(
                &lease,
                &announce,
                &AtomicBool::new(false),
                || Ok(fs::read(&input_path).unwrap()),
            )
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
        let error =
            with_announced_staged_page_input(&lease, &announce, &AtomicBool::new(false), || {
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
        with_announced_staged_page_input(&lease, &announce, &AtomicBool::new(false), || Ok(()))
            .unwrap();
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
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("page 7 input was not published"),
            "{error}"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cancellation_stops_a_staged_input_wait_before_its_timeout() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-staged-cancel-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let canceled = AtomicBool::new(true);
        let error = wait_for_staged_page_input(
            &dir.join("absent.png"),
            7,
            Duration::from_secs(15 * 60),
            Duration::from_millis(5),
            &canceled,
        )
        .unwrap_err();

        assert_eq!(error.code, NativeErrorCode::Io);
        assert_eq!(error.message, crate::engine::CANCELLATION_MESSAGE);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cancellation_during_staged_input_acquisition_releases_its_lease() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-staged-acquire-cancel-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let canceled = AtomicBool::new(false);
        let leases: Mutex<Vec<LeaseEvent>> = Mutex::new(Vec::new());
        let announce = |stage: LeaseEvent, _page: usize, _total: usize| {
            leases.lock().unwrap().push(stage);
            if stage == LeaseEvent::Required {
                canceled.store(true, Ordering::Release);
            }
            Ok(())
        };
        let error = acquire_staged_page_input(
            &staged_lease(dir.join("absent.png"), 7, 1, true),
            &announce,
            &canceled,
        )
        .unwrap_err();

        assert_eq!(error.code, NativeErrorCode::Io);
        assert_eq!(error.message, crate::engine::CANCELLATION_MESSAGE);
        assert_eq!(
            leases.into_inner().unwrap(),
            vec![LeaseEvent::Required, LeaseEvent::Released]
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
        wait_for_staged_page_input(
            &path,
            1,
            Duration::from_secs(30),
            Duration::from_millis(5),
            &AtomicBool::new(false),
        )
        .unwrap();
        producer.join().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"late");
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod moved_tests {
    use crate::protocol::manifest_v3::{
        AnalysisPurpose, CanvasScope, ManifestV3, Operation, Page, PageOutput, RenderMode, VERSION,
    };
    use crate::CleanupOptions;
    use evb_native_support::NativeError;
    use std::{fs, path::PathBuf};

    #[cfg(unix)]
    use crate::protocol::manifest_v3::{DetailPixelRect, DetailRenderPlan};
    #[cfg(unix)]
    use std::path::Path;

    #[cfg(unix)]
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
                pdf_page: None,
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
                pdf_page: None,
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
}
