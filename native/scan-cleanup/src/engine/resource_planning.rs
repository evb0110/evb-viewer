//! Memory and worker planning for batch page processing.
use crate::cache::{ByteLru, PageCache, SourceFingerprint, DEFAULT_CACHE_BUDGET_BYTES};
use crate::domain::options::OutputMode;
use crate::engine::staged_input::{invalid, map_raster_error};
use crate::io::raster;
use evb_native_support::{NativeError, MAX_WORKER_THREADS};
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PlanningOperation {
    Analyze,
    Render,
}

#[derive(Clone, Debug)]
pub(crate) struct PageDescriptor {
    pub(crate) input_path: PathBuf,
    pub(crate) source_page_index: usize,
    pub(crate) options: CleanupOptionsView,
    pub(crate) stream_input: bool,
    pub(crate) trusted_foreground_mask_path: Option<PathBuf>,
    pub(crate) trusted_mrc_background_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub(crate) struct CleanupOptionsView {
    pub(crate) max_pixels: u64,
    pub(crate) max_dimension: u32,
    pub(crate) output_mode: OutputMode,
    pub(crate) source_has_bilevel_layer: bool,
    pub(crate) thickness: i8,
}

pub(crate) trait PlanningManifest {
    fn operation(&self) -> PlanningOperation;
    fn host_memory_bytes(&self) -> Option<u64>;
    fn staged_input_window(&self) -> Option<usize>;
    fn staged_input_peak_pixels(&self) -> Option<u64>;
    fn page_count(&self) -> usize;
    fn page(&self, index: usize) -> PageDescriptor;

    fn run_stream_page_jobs<T, F>(&self, task: F) -> Result<Vec<T>, Box<dyn Error>>
    where
        T: Send,
        F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync;
}

pub(crate) fn manifest_cache(
    operation: PlanningOperation,
    host_memory_bytes: Option<u64>,
) -> Arc<Mutex<ByteLru>> {
    Arc::new(Mutex::new(ByteLru::new(cache_budget_bytes(
        operation,
        host_memory_bytes,
    ))))
}

pub(crate) fn page_cache_for(
    page: &PageDescriptor,
    shared: &Arc<Mutex<ByteLru>>,
) -> Result<PageCache, NativeError> {
    let source = SourceFingerprint::from_path(&page.input_path, page.source_page_index).map_err(
        |error| {
            NativeError::new(
                evb_native_support::NativeErrorCode::Io,
                format!(
                    "Unable to read scan-cleanup input for page {} ({}): {error}",
                    page.source_page_index + 1,
                    page.input_path.display(),
                ),
            )
        },
    )?;
    Ok(PageCache::new(Arc::clone(shared), source))
}
pub(crate) fn run_page_jobs<M, T, F>(manifest: &M, task: F) -> Result<Vec<T>, Box<dyn Error>>
where
    M: PlanningManifest + Sync,
    T: Send,
    F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
{
    if (0..manifest.page_count()).any(|index| manifest.page(index).stream_input) {
        return manifest.run_stream_page_jobs(task);
    }
    let worker_threads = page_worker_threads(manifest)?;
    let processing_threads = processing_worker_threads();
    run_regular_page_jobs(manifest, task, worker_threads, processing_threads)
}

pub(crate) fn processing_worker_threads() -> usize {
    capped_worker_threads(std::thread::available_parallelism().map_or(1, usize::from))
}

fn capped_worker_threads(available: usize) -> usize {
    available.clamp(1, MAX_WORKER_THREADS)
}

pub(crate) fn run_regular_page_jobs<M, T, F>(
    manifest: &M,
    task: F,
    worker_threads: usize,
    processing_threads: usize,
) -> Result<Vec<T>, Box<dyn Error>>
where
    M: PlanningManifest + Sync,
    T: Send,
    F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
{
    let results: Vec<Result<T, NativeError>> = if worker_threads > 1 {
        let pool = rayon::ThreadPoolBuilder::new()
            // `worker_threads` is a memory-derived limit on pages in flight,
            // not the size of the processing pool. Each page contains nested
            // Rayon stages (thresholding, morphology, composition, and
            // resampling) which must retain access to the host's CPU threads.
            // Building a pool with only the page limit made two large pages
            // run every heavy stage on two total threads.
            .num_threads(processing_threads)
            .thread_name(|index| format!("scan-cleanup-processing-{index}"))
            .build()
            .map_err(|error| invalid(format!("Unable to initialize page workers: {error}")))?;
        type PageOutcome<T> = Result<Result<T, NativeError>, Box<dyn std::any::Any + Send>>;
        struct DispatchState<T> {
            next_page: usize,
            failure_observed: bool,
            outcomes: Vec<Option<PageOutcome<T>>>,
        }
        let state = Mutex::new(DispatchState {
            next_page: 0,
            failure_observed: false,
            outcomes: (0..manifest.page_count()).map(|_| None).collect(),
        });

        // The bounded page workers are ordinary scoped OS threads. They wait
        // outside Rayon, while each admitted page enters the processing pool
        // through `install`; even a one-thread pool therefore always has a
        // worker available to execute the page and its nested Rayon stages.
        thread::scope(|scope| {
            for _ in 0..worker_threads.min(manifest.page_count()) {
                let state = &state;
                let pool = &pool;
                let task = &task;
                scope.spawn(move || loop {
                    let index = {
                        let mut state = state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if state.failure_observed || state.next_page >= manifest.page_count() {
                            return;
                        }
                        let index = state.next_page;
                        state.next_page += 1;
                        index
                    };
                    let page = manifest.page(index);
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        pool.install(|| task((index, &page)))
                    }));
                    let mut state = state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state.failure_observed |= outcome.as_ref().map_or(true, Result::is_err);
                    state.outcomes[index] = Some(outcome);
                });
            }
        });
        let DispatchState {
            outcomes,
            failure_observed,
            ..
        } = state
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        if failure_observed {
            // The cancellation decision is made as soon as any page fails,
            // but retain the old ordered-result contract when multiple active
            // pages fail at different times. Panics are captured only long
            // enough to guarantee every submitted page reports completion;
            // the earliest submitted panic is then resumed.
            for outcome in outcomes.into_iter().flatten() {
                match outcome {
                    Err(panic) => std::panic::resume_unwind(panic),
                    Ok(Err(error)) => return Err(error.into()),
                    Ok(Ok(_)) => {}
                }
            }
            unreachable!("page dispatcher observed a failure without recording it");
        }
        outcomes
            .into_iter()
            .map(|outcome| {
                outcome
                    .expect("page dispatcher completed every submitted page")
                    .expect("successful page dispatcher cannot retain a panic")
            })
            .collect()
    } else {
        (0..manifest.page_count())
            .map(|index| {
                let page = manifest.page(index);
                task((index, &page))
            })
            .collect()
    };
    results
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

pub(crate) fn page_worker_threads<M: PlanningManifest>(manifest: &M) -> Result<usize, NativeError> {
    if (0..manifest.page_count()).any(|index| manifest.page(index).stream_input) {
        // FIFO readers block an OS thread until their producer opens the
        // matching pipe. Running a page-sized Rayon pool over ordered streams
        // can occupy the whole pool with future readers while the current page
        // needs nested Rayon work to finish: a real circular wait observed as
        // 180-second pdftoppm timeouts near the end of large documents.
        Ok(1)
    } else if manifest.page_count() > 1 {
        let threads = manifest_worker_threads(manifest)?;
        // Never lease more staged inputs than the owning process promised to
        // keep on disk: a wider page pool would demand a wider raster window
        // than the scratch budget admitted.
        Ok(manifest
            .staged_input_window()
            .map_or(threads, |window| threads.min(window.max(1))))
    } else {
        Ok(1)
    }
}
pub(crate) const FALLBACK_SYSTEM_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(crate) const GRAY_PEAK_BYTES_PER_PIXEL: u64 = 40;
pub(crate) const COLOR_PEAK_BYTES_PER_PIXEL: u64 = 80;

pub(crate) fn manifest_worker_threads<M: PlanningManifest>(
    manifest: &M,
) -> Result<usize, NativeError> {
    let available = std::thread::available_parallelism().map_or(2, usize::from);
    let staged_inputs = manifest.staged_input_window().is_some();
    let measured_peak_page_bytes = (0..manifest.page_count())
        .map(|index| {
            let page = manifest.page(index);
            let options = &page.options;
            // Do not synchronously open pipes or other streaming inputs while
            // sizing the worker pool. Doing so would prevent completed regular
            // pages from reporting analysis progress until every stream opens.
            if page.stream_input {
                return Ok(0);
            }
            // A staged window renders page rasters on request, so most inputs
            // are legitimately absent here. Those pages are measured by the
            // producer's declared document peak below rather than by opening a
            // file that does not exist yet.
            if staged_inputs && !page.input_path.exists() {
                return Ok(0);
            }
            let (width, height) = raster::read_dimensions(
                &page.input_path,
                options.max_pixels,
                options.max_dimension,
            )
            .map_err(|error| map_raster_error(error, &page.input_path, page.source_page_index))?;
            Ok(estimate_peak_page_bytes(
                width,
                height,
                manifest.operation(),
                options.output_mode,
            ))
        })
        .collect::<Result<Vec<_>, NativeError>>()?
        .into_iter()
        .max()
        .unwrap_or(1);
    let declared_peak_page_bytes = manifest.staged_input_peak_pixels().map_or(0, |pixels| {
        peak_page_bytes_for_pixels(pixels, manifest.operation(), OutputMode::Auto)
    });
    let peak_page_bytes = measured_peak_page_bytes.max(declared_peak_page_bytes);
    let total_memory = manifest
        .host_memory_bytes()
        .unwrap_or(FALLBACK_SYSTEM_MEMORY_BYTES);
    let process_budget = total_memory.saturating_mul(40) / 100;
    let worker_budget = process_budget
        .saturating_sub(
            cache_budget_bytes(manifest.operation(), manifest.host_memory_bytes()) as u64,
        );
    Ok(adaptive_thread_count(
        available,
        manifest.page_count(),
        worker_budget,
        peak_page_bytes,
    ))
}

/// Calibrated against the resident high-water mark a page actually reaches,
/// not against a sum of the live buffers `run_page` and `clean_region` name.
/// Counting only the named buffers modelled a gray page at twelve bytes per
/// pixel and missed real peak RSS by ~3.3x, because the high-water mark also
/// carries transient scratch inside the stage pipeline and pages the allocator
/// has freed but not returned to the OS. A worker budget divided by an
/// optimistic figure admits threads the host cannot hold, so the multiplier
/// used for sizing is the measured one.
pub(crate) fn estimate_peak_page_bytes(
    width: usize,
    height: usize,
    operation: PlanningOperation,
    output_mode: OutputMode,
) -> u64 {
    peak_page_bytes_for_pixels(
        (width as u64).saturating_mul(height as u64),
        operation,
        output_mode,
    )
}

pub(crate) fn peak_page_bytes_for_pixels(
    pixels: u64,
    operation: PlanningOperation,
    output_mode: OutputMode,
) -> u64 {
    let decodes_color = operation == PlanningOperation::Analyze
        || matches!(
            output_mode,
            OutputMode::Color | OutputMode::Mixed | OutputMode::Auto
        );
    let multiplier = if decodes_color {
        COLOR_PEAK_BYTES_PER_PIXEL
    } else {
        GRAY_PEAK_BYTES_PER_PIXEL
    };
    pixels.saturating_mul(multiplier)
}

pub(crate) fn adaptive_thread_count(
    available_parallelism: usize,
    page_count: usize,
    memory_budget_bytes: u64,
    peak_page_bytes: u64,
) -> usize {
    if page_count == 0 {
        return 1;
    }
    let cpu_limit = (available_parallelism / 2).max(2).min(page_count.max(1));
    let memory_limit = if peak_page_bytes == 0 {
        page_count
    } else {
        (memory_budget_bytes / peak_page_bytes).max(1) as usize
    };
    cpu_limit.min(memory_limit).min(page_count).max(1)
}

pub(crate) fn cache_budget_bytes(
    operation: PlanningOperation,
    host_memory_bytes: Option<u64>,
) -> usize {
    let total_memory = host_memory_bytes.unwrap_or(FALLBACK_SYSTEM_MEMORY_BYTES);
    // Analyze retains decoded sources because reconciliation may replay them.
    // Render retains analysis-stage artifacts but deliberately does not retain
    // decoded page inputs, so reserve half as much cache memory while keeping
    // a non-zero budget for those reusable stages.
    let denominator = match operation {
        PlanningOperation::Analyze => 10,
        PlanningOperation::Render => 20,
    };
    let cap = match operation {
        PlanningOperation::Analyze => DEFAULT_CACHE_BUDGET_BYTES,
        // Stage artifacts remain reusable during a render, but decoded page
        // inputs no longer occupy this shared LRU. Keep half the normal cap
        // available for those artifacts instead of reserving no cache at all.
        PlanningOperation::Render => DEFAULT_CACHE_BUDGET_BYTES / 2,
    };
    cap.min(memory_budget_as_usize(
        total_memory as u128,
        denominator as u128,
    ))
}

fn memory_budget_as_usize(total_memory: u128, denominator: u128) -> usize {
    usize::try_from(total_memory / denominator).unwrap_or(usize::MAX)
}
#[cfg(test)]
mod tests {
    use super::manifest_cache;
    use super::*;
    use crate::engine::page_statistics::{derive_page_ink_contexts, derive_page_ink_sample};
    use crate::engine::staged_input::{
        with_announced_staged_page_input, LeaseEvent, StagedInputBatch, StagedLeaseDescriptor,
        StagedPageDescriptor,
    };
    use crate::{CleanupOptions, OutputMode};
    use evb_native_support::{NativeError, NativeErrorCode};
    use scan_primitives::GrayImage;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc, Arc, Mutex,
        },
        thread,
        time::Duration,
    };

    #[derive(Clone)]
    struct TypedTestManifest {
        operation: PlanningOperation,
        host_memory_bytes: Option<u64>,
        staged_input_window: Option<usize>,
        staged_input_peak_pixels: Option<u64>,
        raster_window: usize,
        pages: Vec<PageDescriptor>,
    }

    impl PlanningManifest for TypedTestManifest {
        fn operation(&self) -> PlanningOperation {
            self.operation
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
            self.pages[index].clone()
        }

        fn run_stream_page_jobs<T, F>(&self, task: F) -> Result<Vec<T>, Box<dyn Error>>
        where
            T: Send,
            F: Fn((usize, &PageDescriptor)) -> Result<T, NativeError> + Send + Sync,
        {
            let batch = StagedInputBatch {
                raster_window: self.raster_window,
                pages: self
                    .pages
                    .iter()
                    .map(|page| StagedPageDescriptor {
                        input_path: page.input_path.clone(),
                        metadata_path: page.input_path.with_extension("json"),
                        source_page_index: page.source_page_index,
                        max_bytes: crate::io::MAX_STREAM_INPUT_BYTES,
                        stream_input: page.stream_input,
                    })
                    .collect(),
            };
            crate::engine::staged_input::run_stream_page_jobs(&batch, move |(index, staged)| {
                let original = &self.pages[index];
                let descriptor = PageDescriptor {
                    input_path: staged.input_path.clone(),
                    stream_input: false,
                    ..original.clone()
                };
                task((index, &descriptor))
            })
        }
    }

    fn typed_test_manifest(
        dir: &Path,
        page_count: usize,
        raster_window: usize,
        stream_input: bool,
        staged_input_window: Option<usize>,
    ) -> TypedTestManifest {
        TypedTestManifest {
            operation: PlanningOperation::Analyze,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            staged_input_window,
            staged_input_peak_pixels: None,
            raster_window,
            pages: (0..page_count)
                .map(|index| PageDescriptor {
                    input_path: dir.join(format!("page-{index}.png")),
                    source_page_index: index,
                    options: CleanupOptionsView {
                        max_pixels: 1_000_000,
                        max_dimension: 4_096,
                        output_mode: OutputMode::Bw,
                        source_has_bilevel_layer: false,
                        thickness: 0,
                    },
                    stream_input,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                })
                .collect(),
        }
    }

    fn typed_manifest_with(
        operation: PlanningOperation,
        host_memory_bytes: Option<u64>,
        pages: Vec<PageDescriptor>,
    ) -> TypedTestManifest {
        TypedTestManifest {
            operation,
            host_memory_bytes,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            raster_window: 1,
            pages,
        }
    }

    fn typed_page(
        input_path: PathBuf,
        source_page_index: usize,
        output_mode: OutputMode,
    ) -> PageDescriptor {
        PageDescriptor {
            input_path,
            source_page_index,
            options: CleanupOptionsView {
                max_pixels: 1_000_000_000,
                max_dimension: 100_000,
                output_mode,
                source_has_bilevel_layer: false,
                thickness: 0,
            },
            stream_input: false,
            trusted_foreground_mask_path: None,
            trusted_mrc_background_path: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn streamed_inputs_use_one_page_worker_to_avoid_fifo_pool_deadlock() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-stream-worker-sizing-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let fifo = dir.join("page.fifo");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let manifest = TypedTestManifest {
            operation: PlanningOperation::Analyze,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            staged_input_window: None,
            staged_input_peak_pixels: None,
            raster_window: 1,
            pages: (0..8)
                .map(|source_page_index| PageDescriptor {
                    input_path: fifo.clone(),
                    source_page_index,
                    options: CleanupOptionsView {
                        max_pixels: 1_000_000_000,
                        max_dimension: 100_000,
                        output_mode: OutputMode::Bw,
                        source_has_bilevel_layer: false,
                        thickness: 0,
                    },
                    stream_input: true,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                })
                .collect(),
        };
        assert_eq!(page_worker_threads(&manifest).unwrap(), 1);
        let _ = fs::remove_file(fifo);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn processing_worker_threads_share_the_native_worker_ceiling() {
        assert_eq!(
            capped_worker_threads(32),
            evb_native_support::MAX_WORKER_THREADS
        );
        assert_eq!(capped_worker_threads(0), 1);
    }

    #[test]
    fn staged_page_inputs_are_produced_on_demand_within_the_window() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-staged-window-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let window = 2usize;
        let manifest = typed_test_manifest(&dir, 8, 1, false, Some(window));
        let leases: Mutex<Vec<(LeaseEvent, usize)>> = Mutex::new(Vec::new());
        /// What a real producer keeps: which rasters are on disk, and which of
        /// them the sidecar currently holds a lease on. Both live under one
        /// lock so an eviction decision cannot race a lease it must honour.
        #[derive(Default)]
        struct ProducerWindow {
            resident: Vec<usize>,
            leased: Vec<usize>,
        }
        let producer: Mutex<ProducerWindow> = Mutex::new(ProducerWindow::default());
        let peak_resident = AtomicUsize::new(0);
        let announce = |stage: LeaseEvent, page_number: usize, total_pages: usize| {
            assert_eq!(total_pages, 8);
            leases.lock().unwrap().push((stage, page_number));
            let page_index = page_number - 1;
            match stage {
                LeaseEvent::Required => {
                    // The producer window: publish the requested page, first
                    // evicting a resident raster nothing holds a lease on. Pages
                    // can be analysed concurrently, so evicting the oldest
                    // resident page regardless of its lease would delete a
                    // raster another worker is still reading.
                    let mut producer = producer.lock().unwrap();
                    while producer.resident.len() >= window {
                        let Some(victim) = producer
                            .resident
                            .iter()
                            .position(|resident| !producer.leased.contains(resident))
                        else {
                            // Every resident raster is leased. The peak
                            // assertion below is what reports the overshoot;
                            // dropping a leased raster here would hide it as a
                            // read failure instead.
                            break;
                        };
                        let evicted = producer.resident.remove(victim);
                        fs::remove_file(dir.join(format!("page-{evicted}.png"))).unwrap();
                    }
                    fs::write(
                        dir.join(format!("page-{page_index}.png")),
                        format!("page-{page_index}"),
                    )
                    .unwrap();
                    if !producer.resident.contains(&page_index) {
                        producer.resident.push(page_index);
                    }
                    producer.leased.push(page_index);
                    peak_resident.fetch_max(producer.resident.len(), Ordering::AcqRel);
                }
                LeaseEvent::Released => {
                    let mut producer = producer.lock().unwrap();
                    let held = producer
                        .leased
                        .iter()
                        .position(|leased| *leased == page_index)
                        .expect("a release must name a page this producer leased");
                    producer.leased.remove(held);
                }
            }
            Ok(())
        };

        let processed = run_page_jobs(&manifest, |(index, page)| {
            let page_descriptor = &manifest.pages[index];
            with_announced_staged_page_input(
                &StagedLeaseDescriptor {
                    input_path: page_descriptor.input_path.clone(),
                    page_number: page_descriptor.source_page_index.saturating_add(1),
                    total_pages: manifest.pages.len(),
                    enabled: manifest.staged_input_window.is_some(),
                },
                &announce,
                || {
                    let bytes = fs::read(&page.input_path).map_err(|error| {
                        NativeError::new(NativeErrorCode::Io, format!("page {index}: {error}"))
                    })?;
                    assert_eq!(bytes, format!("page-{index}").as_bytes());
                    Ok(index)
                },
            )
        })
        .unwrap();

        assert_eq!(processed, (0..8).collect::<Vec<_>>());
        assert!(
            peak_resident.load(Ordering::Acquire) <= window,
            "the producer must never exceed the staged window"
        );
        let leases = leases.into_inner().unwrap();
        // Every acquisition is paired with exactly one release, and no page is
        // read without announcing its lease first.
        for page_number in 1..=8 {
            let required = leases
                .iter()
                .filter(|(stage, number)| *stage == LeaseEvent::Required && *number == page_number)
                .count();
            let released = leases
                .iter()
                .filter(|(stage, number)| *stage == LeaseEvent::Released && *number == page_number)
                .count();
            assert_eq!((page_number, required), (page_number, 1));
            assert_eq!((page_number, released), (page_number, 1));
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_page_pool_never_exceeds_the_staged_window() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-staged-threads-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut manifest = typed_test_manifest(&dir, 64, 1, false, Some(2));
        // The unbounded baseline needs measurable inputs; the staged variants
        // below are the ones that must hold with the rasters still unrendered.
        for page in &manifest.pages {
            fs::write(
                &page.input_path,
                crate::png::encode_gray(&GrayImage::new(64, 64, 240)).unwrap(),
            )
            .unwrap();
        }
        let unbounded = {
            let mut manifest = manifest.clone();
            manifest.staged_input_window = None;
            page_worker_threads(&manifest).unwrap()
        };
        assert!(unbounded >= 1);
        assert_eq!(
            page_worker_threads(&manifest).unwrap(),
            unbounded.min(2),
            "a two-page window may never lease more than two pages"
        );
        manifest.staged_input_window = Some(1);
        assert_eq!(page_worker_threads(&manifest).unwrap(), 1);

        // With the rasters not yet staged the pool is still sized, and the
        // producer's declared document peak is what bounds it.
        manifest.staged_input_window = Some(16);
        for page in &manifest.pages {
            fs::remove_file(&page.input_path).unwrap();
        }
        let unmeasured = page_worker_threads(&manifest).unwrap();
        assert!(unmeasured >= 1);
        manifest.staged_input_peak_pixels = Some(1_000_000_000);
        assert_eq!(
            page_worker_threads(&manifest).unwrap(),
            1,
            "a declared gigapixel peak must collapse the pool to one page"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn adaptive_threads_respect_cpu_pages_and_memory() {
        assert_eq!(adaptive_thread_count(16, 20, 10_000, 1_000), 8);
        assert_eq!(adaptive_thread_count(16, 3, 10_000, 1_000), 3);
        assert_eq!(adaptive_thread_count(2, 20, 10_000, 1_000), 2);
        assert_eq!(adaptive_thread_count(16, 20, 1_500, 1_000), 1);
        assert_eq!(adaptive_thread_count(16, 0, 10_000, 1_000), 1);
    }

    #[test]
    fn operation_aware_cache_reservation_keeps_render_stage_budget() {
        let analyze = cache_budget_bytes(PlanningOperation::Analyze, Some(8 * 1024 * 1024 * 1024));
        let render = cache_budget_bytes(PlanningOperation::Render, Some(8 * 1024 * 1024 * 1024));

        assert!(render > 0);
        assert!(render < analyze);
    }

    #[test]
    fn cache_budget_saturates_when_the_quotient_exceeds_usize() {
        let quotient_above_usize = usize::MAX as u128 + 1;
        assert_eq!(memory_budget_as_usize(quotient_above_usize, 1), usize::MAX);
    }

    #[test]
    fn page_cache_paths_are_stable_without_decoder_policy() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-decode-cache-policy-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(32, 24, 240)).unwrap(),
        )
        .unwrap();
        let page = typed_page(input, 0, OutputMode::Color);
        let render_cache = manifest_cache(PlanningOperation::Render, None);
        let render_page_cache = page_cache_for(&page, &render_cache).unwrap();
        let render_key = crate::cache::StageCacheKey::decoded(
            &render_page_cache.source,
            true,
            &CleanupOptions::default(),
        );
        assert!(render_cache
            .lock()
            .unwrap()
            .get::<crate::io::raster::DecodedRaster>(&render_key)
            .is_none());

        let analyze_cache = manifest_cache(PlanningOperation::Analyze, None);
        let analyze_page_cache = page_cache_for(&page, &analyze_cache).unwrap();
        assert_eq!(analyze_page_cache.source, render_page_cache.source);
        assert!(analyze_cache
            .lock()
            .unwrap()
            .get::<crate::io::raster::DecodedRaster>(&render_key)
            .is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn trusted_ink_prepass_uses_the_bounded_page_pool() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-ink-prepass-bound-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        let mask = dir.join("foreground.png");
        let background = dir.join("background.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(100, 50, 240)).unwrap(),
        )
        .unwrap();
        let mut selection = GrayImage::new(100, 50, 0);
        for y in 4..14 {
            for x in 10..90 {
                selection.set(x, y, 255);
            }
        }
        crate::png::write_gray_atomic(&mask, &selection).unwrap();
        crate::png::write_gray_atomic(&background, &GrayImage::new(50, 25, 240)).unwrap();
        let manifest = TypedTestManifest {
            operation: PlanningOperation::Render,
            host_memory_bytes: Some(32 * 1024 * 1024 * 1024),
            staged_input_window: None,
            staged_input_peak_pixels: None,
            raster_window: 1,
            pages: (0..12)
                .map(|index| PageDescriptor {
                    input_path: input.clone(),
                    source_page_index: index,
                    options: CleanupOptionsView {
                        max_pixels: 1_000_000_000,
                        max_dimension: 100_000,
                        output_mode: OutputMode::Bw,
                        source_has_bilevel_layer: true,
                        thickness: 0,
                    },
                    stream_input: false,
                    trusted_foreground_mask_path: Some(mask.clone()),
                    trusted_mrc_background_path: Some(background.clone()),
                })
                .collect(),
        };

        assert!(manifest_worker_threads(&manifest).unwrap() > 1);
        let samples = run_page_jobs(&manifest, |(_, page)| derive_page_ink_sample(page)).unwrap();
        let contexts = derive_page_ink_contexts(&samples);
        assert_eq!(contexts.len(), 12);
        assert!(contexts.iter().all(Option::is_some));
        assert_eq!(contexts[0], contexts[11]);
        let _ = fs::remove_dir_all(dir);
    }

    fn scheduler_test_manifest(dir: &Path, page_count: usize) -> TypedTestManifest {
        let input = dir.join("scheduler-input.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(100, 50, 240)).unwrap(),
        )
        .unwrap();
        typed_manifest_with(
            PlanningOperation::Render,
            Some(1_400_000),
            (0..page_count)
                .map(|index| typed_page(input.clone(), index, OutputMode::Bw))
                .collect(),
        )
    }

    #[test]
    fn page_dispatcher_maintains_a_sliding_bound_and_ordered_results() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-dispatcher-window-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = scheduler_test_manifest(&dir, 4);
        assert_eq!(page_worker_threads(&manifest).unwrap(), 2);

        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let later_page_started_while_first_was_live = Arc::new(AtomicBool::new(false));
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (second_started_tx, second_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let (later_started_tx, later_started_rx) = mpsc::channel();
        let (release_second_tx, release_second_rx) = mpsc::channel();
        let release_first_rx = Arc::new(Mutex::new(release_first_rx));
        let release_second_rx = Arc::new(Mutex::new(release_second_rx));
        let dispatcher = thread::spawn({
            let live = Arc::clone(&live);
            let peak = Arc::clone(&peak);
            let later_page_started_while_first_was_live =
                Arc::clone(&later_page_started_while_first_was_live);
            let release_first_rx = Arc::clone(&release_first_rx);
            let release_second_rx = Arc::clone(&release_second_rx);
            move || {
                run_regular_page_jobs(
                    &manifest,
                    move |(index, _)| {
                        let current = live.fetch_add(1, Ordering::AcqRel) + 1;
                        peak.fetch_max(current, Ordering::AcqRel);
                        match index {
                            0 => {
                                first_started_tx.send(()).unwrap();
                                release_first_rx
                                    .lock()
                                    .unwrap()
                                    .recv_timeout(Duration::from_secs(2))
                                    .unwrap();
                            }
                            1 => {
                                second_started_tx.send(()).unwrap();
                                release_second_rx
                                    .lock()
                                    .unwrap()
                                    .recv_timeout(Duration::from_secs(2))
                                    .unwrap();
                            }
                            2 if current >= 2 => {
                                later_page_started_while_first_was_live
                                    .store(true, Ordering::Release);
                                later_started_tx.send(()).unwrap();
                            }
                            _ => {}
                        }
                        live.fetch_sub(1, Ordering::AcqRel);
                        Ok::<_, NativeError>(index)
                    },
                    2,
                    2,
                )
                .map_err(|error| error.to_string())
            }
        });
        first_started_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        second_started_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        release_first_tx.send(()).unwrap();
        later_started_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        release_second_tx.send(()).unwrap();
        let run = dispatcher.join().unwrap().unwrap();

        assert_eq!(run, vec![0, 1, 2, 3]);
        assert!(later_page_started_while_first_was_live.load(Ordering::Acquire));
        assert!(peak.load(Ordering::Acquire) <= 2);
        assert_eq!(live.load(Ordering::Acquire), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn page_dispatcher_completes_with_one_processing_thread() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-dispatcher-single-cpu-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = scheduler_test_manifest(&dir, 4);

        let run = run_regular_page_jobs(&manifest, |(index, _)| Ok::<_, NativeError>(index), 2, 1)
            .unwrap();

        assert_eq!(run, vec![0, 1, 2, 3]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn page_dispatcher_cancels_admission_and_settles_active_failures_in_order() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-dispatcher-failure-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = scheduler_test_manifest(&dir, 5);
        assert_eq!(page_worker_threads(&manifest).unwrap(), 2);

        let live = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Mutex::new(Vec::new()));
        let error = run_regular_page_jobs(
            &manifest,
            {
                let live = Arc::clone(&live);
                let started = Arc::clone(&started);
                move |(index, _)| {
                    live.fetch_add(1, Ordering::AcqRel);
                    started.lock().unwrap().push(index);
                    if index == 0 {
                        // Page one fails first in wall-clock time, while page zero
                        // remains an earlier submitted failure. The dispatcher
                        // must cancel page admission immediately, drain both
                        // active jobs, and retain the ordered error contract.
                        thread::sleep(Duration::from_millis(100));
                        live.fetch_sub(1, Ordering::AcqRel);
                        return Err(NativeError::new(
                            NativeErrorCode::NativeFailure,
                            "page 0 failed",
                        ));
                    }
                    if index == 1 {
                        live.fetch_sub(1, Ordering::AcqRel);
                        return Err(NativeError::new(
                            NativeErrorCode::NativeFailure,
                            "page 1 failed",
                        ));
                    }
                    live.fetch_sub(1, Ordering::AcqRel);
                    Ok(index)
                }
            },
            2,
            2,
        )
        .unwrap_err();

        assert!(error.to_string().contains("page 0 failed"));
        assert!(started.lock().unwrap().iter().all(|&index| index < 2));
        assert_eq!(live.load(Ordering::Acquire), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn page_dispatcher_settles_active_jobs_before_resuming_a_panic() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-page-dispatcher-panic-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manifest = scheduler_test_manifest(&dir, 5);
        assert_eq!(page_worker_threads(&manifest).unwrap(), 2);

        let live = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Mutex::new(Vec::new()));
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
            let live = Arc::clone(&live);
            let started = Arc::clone(&started);
            move || {
                let _ = run_regular_page_jobs(
                    &manifest,
                    move |(index, _)| {
                        live.fetch_add(1, Ordering::AcqRel);
                        started.lock().unwrap().push(index);
                        if index == 0 {
                            live.fetch_sub(1, Ordering::AcqRel);
                            panic!("page 0 panicked");
                        }
                        thread::sleep(Duration::from_millis(50));
                        live.fetch_sub(1, Ordering::AcqRel);
                        Ok::<_, NativeError>(index)
                    },
                    2,
                    2,
                );
            }
        }));

        let payload = panic.expect_err("dispatcher swallowed a page panic");
        assert_eq!(payload.downcast_ref::<&str>(), Some(&"page 0 panicked"));
        assert!(started.lock().unwrap().iter().all(|&index| index < 2));
        assert_eq!(live.load(Ordering::Acquire), 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn peak_page_estimate_tracks_measured_resident_high_water() {
        // Reference document, 2119x3204 gray page, 32-page Bw batch at five
        // workers, measured peak RSS 1.60 GB (audit-jul-25 U22 / SCP3). The
        // sizing model is cache budget plus one peak page per worker; it has to
        // land within +/-25 % of that or the worker budget admits threads the
        // host cannot hold.
        const MEASURED_PEAK_BYTES: f64 = 1.60e9;
        let modelled = cache_budget_bytes(PlanningOperation::Render, None) as f64
            + 5.0
                * estimate_peak_page_bytes(2119, 3204, PlanningOperation::Render, OutputMode::Bw)
                    as f64;
        let ratio = modelled / MEASURED_PEAK_BYTES;
        assert!(
            (0.75..=1.25).contains(&ratio),
            "modelled {modelled:.0} B is {ratio:.2}x the measured 1.60 GB peak",
        );
    }

    #[test]
    fn peak_page_estimate_accounts_for_rgb_analysis_and_auto_render() {
        let pixels = 2_000 * 1_500;
        let gray_render =
            estimate_peak_page_bytes(2_000, 1_500, PlanningOperation::Render, OutputMode::Bw);
        let analysis =
            estimate_peak_page_bytes(2_000, 1_500, PlanningOperation::Analyze, OutputMode::Bw);
        let auto_render =
            estimate_peak_page_bytes(2_000, 1_500, PlanningOperation::Render, OutputMode::Auto);

        assert_eq!(gray_render, pixels * 40);
        assert_eq!(analysis, pixels * 80);
        assert_eq!(auto_render, pixels * 80);
    }

    #[test]
    fn manifest_worker_sizing_applies_the_decode_policy() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-decode-policy-sizing-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(100, 50, 240)).unwrap(),
        )
        .unwrap();
        let manifest = |operation, output_mode| {
            typed_manifest_with(
                operation,
                Some(2_000_000),
                (0..2)
                    .map(|source_page_index| {
                        typed_page(input.clone(), source_page_index, output_mode)
                    })
                    .collect(),
            )
        };

        assert_eq!(
            manifest_worker_threads(&manifest(PlanningOperation::Render, OutputMode::Bw)).unwrap(),
            2
        );
        assert_eq!(
            manifest_worker_threads(&manifest(PlanningOperation::Analyze, OutputMode::Bw)).unwrap(),
            1
        );
        assert_eq!(
            manifest_worker_threads(&manifest(PlanningOperation::Render, OutputMode::Auto))
                .unwrap(),
            1
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn worker_sizing_follows_the_host_memory_the_manifest_reports() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-worker-sizing-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("page.png");
        fs::write(
            &input,
            crate::png::encode_gray(&GrayImage::new(2_000, 1_500, 240)).unwrap(),
        )
        .unwrap();
        let manifest = |host_memory_bytes| {
            typed_manifest_with(
                PlanningOperation::Render,
                host_memory_bytes,
                (0..8)
                    .map(|index| typed_page(input.clone(), index, OutputMode::Bw))
                    .collect(),
            )
        };
        let constrained = manifest_worker_threads(&manifest(Some(64 * 1024 * 1024))).unwrap();
        let roomy = manifest_worker_threads(&manifest(Some(32 * 1024 * 1024 * 1024))).unwrap();

        assert_eq!(constrained, 1);
        assert!(
            roomy > constrained,
            "a roomy host must not be sized like a 64 MiB one (roomy={roomy})"
        );
        assert_eq!(
            manifest_worker_threads(&manifest(None)).unwrap(),
            manifest_worker_threads(&manifest(Some(FALLBACK_SYSTEM_MEMORY_BYTES))).unwrap()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn color_peak_estimate_accounts_for_rgb_working_copies() {
        assert_eq!(
            estimate_peak_page_bytes(100, 50, PlanningOperation::Render, OutputMode::Bw),
            200_000
        );
        assert_eq!(
            estimate_peak_page_bytes(100, 50, PlanningOperation::Render, OutputMode::Color),
            400_000
        );
    }
}
