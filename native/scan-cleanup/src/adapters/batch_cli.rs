use crate::adapters::manifest_publication::{
    publication_journal_path, recover_direct_publication, run_manifest_transaction,
    run_publication_transaction,
};
use crate::adapters::single_ocr_cli::{invalid, parse_options};
use crate::cache::ByteLru;
use crate::engine::document_analysis::{
    next_analysis_step, AnalysisDocument, AnalysisPage, AnalysisStep, AnalysisView, PageAnalysis,
};
use crate::engine::lossless_placement::{plan_lossless_page, record_source_preservation};
use crate::engine::output_geometry::{match_page_sizes, write_json_atomic};
use crate::engine::page_statistics::{
    derive_ink_sample_from_paths, derive_page_ink_contexts, derive_page_ink_contexts_with_prior,
    derive_page_ink_sample, page_needs_ink_sample,
};
use crate::engine::page_workflow::{run_classification, run_page, suffixed_path, PageRunResult};
use crate::engine::resource_planning::{
    manifest_cache, page_cache_for, page_worker_threads, processing_worker_threads,
    run_page_jobs_with_worker_threads, run_regular_page_jobs, PageDescriptor, PlanningOperation,
};
use crate::engine::staged_input::{
    assert_paths_within_root, planning_operation, planning_page, preflight_paths, staged_lease,
    staged_path_plan, with_announced_staged_page_input, LeaseAnnouncer, LeaseEvent,
    StagedLeaseDescriptor, StagedPathPlan,
};
use crate::{
    ink_consistency::{DocumentInkPrior, DocumentInkSample},
    protocol::{
        manifest_v3::{
            AnalysisPurpose, CanvasScope, InkCalibrationPage, ManifestV3, Operation, Page,
            RenderMode, ResolvedDocumentInkPrior, MAX_MANIFEST_BYTES,
        },
        progress::{PageStageTimings, Progress, ProgressEnvelope, ProgressStage},
        result::ResultEnvelope,
    },
    split::LayoutClassification,
    sub_page_progress::{with_sub_page_progress_observer, SubPageStage},
};
use evb_native_support::{
    bounded_io::deserialize_json_file_bounded, NativeError, NativeErrorCode, NativeErrorEnvelope,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    error::Error,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
};

const CANCELLATION_EXIT_CODE: i32 = 130;

#[derive(Debug, Eq, PartialEq)]
enum ScanCleanupCliInvocation {
    Direct {
        input: PathBuf,
        output: PathBuf,
        metadata: PathBuf,
        options: Option<String>,
        ocr_mode: bool,
        experimental_auto_dewarp: bool,
    },
    Manifest {
        path: PathBuf,
        // A root is a manifest-sidecar containment affordance. Direct mode
        // intentionally retains its exit-code-only CLI contract for callers
        // that already own the input and output paths.
        allowed_path_root: Option<PathBuf>,
    },
}

fn cli_value<'a>(
    args: &'a [String],
    index: &mut usize,
    flag: &str,
) -> Result<&'a str, NativeError> {
    let value = args
        .get(*index + 1)
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| invalid(format!("{flag} requires a value")))?;
    *index += 2;
    Ok(value)
}

fn parse_cli_args(args: &[String]) -> Result<ScanCleanupCliInvocation, NativeError> {
    let mut seen = HashSet::new();
    let mut manifest = None;
    let mut allowed_path_root = None;
    let mut input = None;
    let mut output = None;
    let mut metadata = None;
    let mut options = None;
    let mut ocr_mode = false;
    let mut experimental_auto_dewarp = false;
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !flag.starts_with("--") {
            return Err(invalid(format!(
                "Unexpected positional argument {}",
                args[index]
            )));
        }
        if !seen.insert(flag) {
            return Err(invalid(format!("Duplicate argument {flag}")));
        }
        match flag {
            "--manifest" => manifest = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--allowed-path-root" => {
                allowed_path_root = Some(PathBuf::from(cli_value(args, &mut index, flag)?))
            }
            "--input" => input = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--output" => output = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--metadata" => metadata = Some(PathBuf::from(cli_value(args, &mut index, flag)?)),
            "--options" => options = Some(cli_value(args, &mut index, flag)?.to_string()),
            "--ocr-mode" => {
                ocr_mode = true;
                index += 1;
            }
            "--experimental-auto-dewarp" => {
                experimental_auto_dewarp = true;
                index += 1;
            }
            _ => return Err(invalid(format!("Unknown argument {flag}"))),
        }
    }

    if let Some(path) = manifest {
        if input.is_some()
            || output.is_some()
            || metadata.is_some()
            || options.is_some()
            || ocr_mode
            || experimental_auto_dewarp
        {
            return Err(invalid(
                "--manifest cannot be combined with direct-mode arguments",
            ));
        }
        return Ok(ScanCleanupCliInvocation::Manifest {
            path,
            allowed_path_root,
        });
    }

    if allowed_path_root.is_some() {
        return Err(invalid("--allowed-path-root requires --manifest"));
    }

    Ok(ScanCleanupCliInvocation::Direct {
        input: input.ok_or_else(|| invalid("Missing required argument --input"))?,
        output: output.ok_or_else(|| invalid("Missing required argument --output"))?,
        metadata: metadata.ok_or_else(|| invalid("Missing required argument --metadata"))?,
        options,
        ocr_mode,
        experimental_auto_dewarp,
    })
}

pub fn run(args: impl IntoIterator<Item = String>) -> Result<(), Box<dyn Error>> {
    static NEVER_CANCELED: AtomicBool = AtomicBool::new(false);
    run_with_cancellation(args, &NEVER_CANCELED)
}

pub fn run_with_cancellation(
    args: impl IntoIterator<Item = String>,
    is_canceled: &AtomicBool,
) -> Result<(), Box<dyn Error>> {
    match run_inner(args, is_canceled) {
        // A closed pipe is the host cancelling, not a failure to report: the
        // shared CLI wrapper would otherwise turn it into a native-error exit.
        Err(error) if error.is::<ClosedOutputPipe>() => std::process::exit(CANCELLATION_EXIT_CODE),
        result => result,
    }
}

fn run_inner(
    args: impl IntoIterator<Item = String>,
    is_canceled: &AtomicBool,
) -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = args.into_iter().collect();
    let (input, output, metadata, options, ocr_mode, experimental_auto_dewarp) =
        match parse_cli_args(&args)? {
            ScanCleanupCliInvocation::Direct {
                input,
                output,
                metadata,
                options,
                ocr_mode,
                experimental_auto_dewarp,
            } => (
                input,
                output,
                metadata,
                options,
                ocr_mode,
                experimental_auto_dewarp,
            ),
            ScanCleanupCliInvocation::Manifest {
                path,
                allowed_path_root,
            } => return run_manifest(&path, allowed_path_root.as_deref(), is_canceled),
        };
    let mut options = options
        .as_deref()
        .map(parse_options)
        .transpose()?
        .unwrap_or_default();
    if ocr_mode {
        options.ocr_mode = true;
    }
    if experimental_auto_dewarp {
        options.experimental.auto_dewarp = true;
    }
    let page = Page {
        input_path: input,
        analysis_input_path: None,
        analysis_dpi: None,
        trusted_foreground_mask_path: None,
        trusted_mrc_background_path: None,
        outputs: Vec::new(),
        source_page_index: 0,
        page_metadata_path: metadata.clone(),
        options,
        document_prior: None,
        detail_render_plan: None,
        pdf_page: None,
        alternate_input_path: None,
        alternate_view: None,
    };
    let cache = manifest_cache(PlanningOperation::Render, None);
    let page_cache = page_cache_for(&planning_page(&page), &cache)?;
    // The manifest route's admission and publication, for one page: aliases
    // are refused before anything is written, and a failure restores whatever
    // the destinations held. A split page writes suffixed left and right
    // files instead, so those are admitted and protected too; whichever set
    // the page does not write keeps its content. Direct mode stays an
    // exit-code-only CLI; only manifest mode emits the sidecar ResultEnvelope
    // protocol line.
    let destination_paths = [&output, &metadata]
        .into_iter()
        .flat_map(|path| [path.clone(), suffixed_path(path, 0), suffixed_path(path, 1)])
        .collect::<Vec<_>>();
    let paths = StagedPathPlan {
        input_paths: vec![page.input_path.clone()],
        destination_paths,
    };
    let mut admission = paths.clone();
    admission
        .destination_paths
        .push(publication_journal_path(&output));
    preflight_paths(&admission)?;
    recover_direct_publication(&output, &page.input_path)?;
    preflight_paths(&admission)?;
    run_publication_transaction(&output, paths.destination_paths, true, || {
        run_page(
            &page,
            CanvasScope::Page,
            false,
            None,
            Some((&output, &metadata)),
            None,
            &page_cache,
            is_canceled,
        )
        .map(|_| ())
    })
}

fn run_manifest(
    path: &Path,
    allowed_path_root: Option<&Path>,
    is_canceled: &AtomicBool,
) -> Result<(), Box<dyn Error>> {
    // Rootless manifest execution remains a direct-CLI affordance; sidecar
    // callers provide the process-owned root through their adapter contract.
    let manifest: ManifestV3 =
        deserialize_json_file_bounded(path, MAX_MANIFEST_BYTES, "v3 batch manifest")?;
    manifest.validate_for_execution()?;
    if let Some(root) = allowed_path_root {
        assert_paths_within_root(&staged_path_plan(&manifest), root)?;
    }
    preflight_paths(&staged_path_plan(&manifest))?;
    let total = manifest.pages.len();
    let mut resolved_ink_prior = None;
    let result = run_manifest_transaction(path, &manifest, || {
        run_manifest_inner(&manifest, is_canceled, &mut resolved_ink_prior)
    });
    match result {
        Ok(()) => {
            write_protocol_line(&ResultEnvelope::success_with_ink_prior(
                total,
                total,
                resolved_ink_prior,
            ))?;
            Ok(())
        }
        Err(error) => {
            // Reporting a failure down a pipe nobody reads would only replace the
            // real cause with a second broken-pipe error.
            if error.is::<ClosedOutputPipe>() {
                return Err(error);
            }
            let envelope = NativeErrorEnvelope::from_error(error.as_ref());
            write_protocol_line(&ResultEnvelope::failure(&envelope))?;
            Err(error)
        }
    }
}

fn map_page_error(error: &(dyn Error + 'static)) -> NativeError {
    let envelope = NativeErrorEnvelope::from_error(error);
    NativeError::new(envelope.code, envelope.message)
}

fn derive_calibration_samples(
    calibration_pages: &[InkCalibrationPage],
    is_canceled: &AtomicBool,
    worker_threads: usize,
) -> Result<Vec<Option<DocumentInkSample>>, Box<dyn Error>> {
    if calibration_pages.is_empty() {
        return Ok(Vec::new());
    }
    type CalibrationSampleOutcome = Result<Option<DocumentInkSample>, NativeError>;
    let next_index = std::sync::atomic::AtomicUsize::new(0);
    let failure_observed = AtomicBool::new(false);
    let outcomes: Vec<Mutex<Option<CalibrationSampleOutcome>>> = (0..calibration_pages.len())
        .map(|_| Mutex::new(None))
        .collect();
    let workers = worker_threads.clamp(1, calibration_pages.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let next_index = &next_index;
            let failure_observed = &failure_observed;
            let outcomes = &outcomes;
            scope.spawn(move || loop {
                if failure_observed.load(std::sync::atomic::Ordering::Acquire)
                    || is_canceled.load(std::sync::atomic::Ordering::Acquire)
                {
                    return;
                }
                let index = next_index.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                if index >= calibration_pages.len() {
                    return;
                }
                let page = &calibration_pages[index];
                let outcome = derive_ink_sample_from_paths(
                    &page.trusted_foreground_mask_path,
                    &page.trusted_mrc_background_path,
                    page.source_page_index,
                    page.max_pixels,
                    page.max_dimension,
                );
                if outcome.is_err() {
                    failure_observed.store(true, std::sync::atomic::Ordering::Release);
                }
                *outcomes[index]
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(outcome);
            });
        }
    });
    let mut samples = Vec::with_capacity(calibration_pages.len());
    for outcome in outcomes {
        let Some(result) = outcome
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
        else {
            if is_canceled.load(std::sync::atomic::Ordering::Acquire) {
                return Err(crate::engine::cancellation_error().into());
            }
            return Err(NativeError::new(
                NativeErrorCode::NativeFailure,
                "Ink calibration worker exited before completing every page",
            )
            .into());
        };
        samples.push(result?);
    }
    if is_canceled.load(std::sync::atomic::Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    Ok(samples)
}

fn run_manifest_inner(
    manifest: &ManifestV3,
    is_canceled: &AtomicBool,
    resolved_ink_prior: &mut Option<ResolvedDocumentInkPrior>,
) -> Result<(), Box<dyn Error>> {
    if is_canceled.load(std::sync::atomic::Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    let cache = manifest_cache(
        planning_operation(manifest.operation),
        manifest.host_memory_bytes,
    );
    // Compute the memory-derived page pool once. The render prepass and the
    // final page run share this plan so a batch does not reread every raster
    // header merely to arrive at the same worker count.
    let worker_threads = page_worker_threads(manifest)?;
    let processing_threads = processing_worker_threads();
    let total_pages = manifest.pages.len();
    // Publish all progress off the worker threads so a slow stdout reader
    // cannot stall unrelated page workers behind JSON serialization or pipe
    // writes. Reliable lifecycle events preserve arrival order with monotone
    // `completedPages`, while rapid sub-page stage transitions coalesce per page.
    let publisher = ProgressPublisher::spawn(total_pages, write_progress);
    publisher.publish_reliable(Progress::new(ProgressStage::Started, 0, total_pages))?;
    let report_page_started =
        |index: usize| -> Result<(), NativeError> { publisher.publish_page_started(index) };
    let report_page_stage = |index: usize, sub_page_stage: SubPageStage| {
        publisher.publish_page_stage(index, sub_page_stage);
    };
    let report_page_done = |index: usize, progress: Progress| -> Result<(), NativeError> {
        publisher.publish_page_done(index, progress)
    };
    let report_recheck_done =
        |index: usize| -> Result<(), NativeError> { publisher.publish_recheck_done(index) };
    let announce_lease = |event: LeaseEvent, page_number: usize, total: usize| {
        let stage = match event {
            LeaseEvent::Required => ProgressStage::PageInputRequired,
            LeaseEvent::Released => ProgressStage::PageInputReleased,
        };
        publisher.publish_lease(Progress::page_input(stage, page_number, total, false))
    };
    let announce_alternate = |event: LeaseEvent, page_number: usize, total: usize| {
        let stage = match event {
            LeaseEvent::Required => ProgressStage::PageInputRequired,
            LeaseEvent::Released => ProgressStage::PageInputReleased,
        };
        publisher.publish_lease(Progress::page_input(stage, page_number, total, true))
    };
    let analyzing = manifest.operation == Operation::Analyze;
    let plan_content = manifest.analysis_purpose == AnalysisPurpose::PagePlan;
    let mut page_results = if analyzing {
        let run_primary =
            |(index, descriptor): (usize, &PageDescriptor)| -> Result<PageRunResult, NativeError> {
                let page = &manifest.pages[index];
                let lease = staged_lease(manifest, index, page);
                let result =
                    with_announced_staged_page_input(&lease, &announce_lease, is_canceled, || {
                        report_page_started(index)?;
                        let page_cache = page_cache_for(descriptor, &cache)?;
                        with_sub_page_progress_observer(
                            &|sub_stage, _, _| report_page_stage(index, sub_stage),
                            || {
                                run_classification(
                                    page,
                                    manifest.canvas_scope,
                                    page.document_prior,
                                    true,
                                    plan_content,
                                    &page_cache,
                                    is_canceled,
                                )
                            },
                        )
                        .map_err(|error| map_page_error(error.as_ref()))
                    })?;
                // The same page plan backs previews before and after reconciliation.
                write_json_atomic(&result.page_metadata_path, &result.metadata)
                    .map_err(|error| map_page_error(error.as_ref()))?;
                let mut progress = page_complete_progress(&result, index, total_pages);
                progress.stage = ProgressStage::PageAnalyzed;
                progress.output_paths = None;
                report_page_done(index, progress)?;
                Ok(result)
            };
        analyze_document(
            manifest,
            is_canceled,
            &cache,
            &announce_lease,
            &announce_alternate,
            &report_page_started,
            &report_page_stage,
            &report_recheck_done,
            || {
                run_page_jobs_with_worker_threads(
                    manifest,
                    is_canceled,
                    run_primary,
                    worker_threads,
                    processing_threads,
                )
            },
        )?
    } else {
        let page_ink_contexts = {
            let planning_pages = manifest.pages.iter().map(planning_page).collect::<Vec<_>>();
            if let Some(given_prior) = manifest.document_ink_prior {
                let prior = given_prior.as_prior();
                *resolved_ink_prior = Some(given_prior);
                let samples = if prior.is_some() && planning_pages.iter().any(page_needs_ink_sample)
                {
                    run_regular_page_jobs(
                        manifest,
                        is_canceled,
                        |(_, page)| derive_page_ink_sample(page),
                        worker_threads,
                        processing_threads,
                    )?
                } else {
                    vec![None; planning_pages.len()]
                };
                derive_page_ink_contexts_with_prior(&samples, prior)
            } else if let Some(cal_pages) = manifest.ink_calibration_pages.as_deref() {
                let cal_samples =
                    derive_calibration_samples(cal_pages, is_canceled, worker_threads)?;
                let prior =
                    DocumentInkPrior::from_page_samples(cal_samples.iter().flatten().copied());
                *resolved_ink_prior = Some(ResolvedDocumentInkPrior::from_option(prior));
                if prior.is_some() && planning_pages.iter().any(page_needs_ink_sample) {
                    let cached_samples: HashMap<(usize, &Path, &Path), Option<DocumentInkSample>> =
                        cal_pages
                            .iter()
                            .zip(cal_samples.iter().copied())
                            .map(|(page, sample)| {
                                (
                                    (
                                        page.source_page_index,
                                        page.trusted_foreground_mask_path.as_path(),
                                        page.trusted_mrc_background_path.as_path(),
                                    ),
                                    sample,
                                )
                            })
                            .collect();
                    let samples = run_regular_page_jobs(
                        manifest,
                        is_canceled,
                        |(_, page)| {
                            if !page_needs_ink_sample(page) {
                                return Ok(None);
                            }
                            if let (Some(mask), Some(bg)) = (
                                page.trusted_foreground_mask_path.as_deref(),
                                page.trusted_mrc_background_path.as_deref(),
                            ) {
                                if let Some(&cached) =
                                    cached_samples.get(&(page.source_page_index, mask, bg))
                                {
                                    return Ok(cached);
                                }
                            }
                            derive_page_ink_sample(page)
                        },
                        worker_threads,
                        processing_threads,
                    )?;
                    derive_page_ink_contexts_with_prior(&samples, prior)
                } else {
                    vec![None; planning_pages.len()]
                }
            } else {
                let samples = if planning_pages.iter().any(page_needs_ink_sample) {
                    run_regular_page_jobs(
                        manifest,
                        is_canceled,
                        |(_, page)| derive_page_ink_sample(page),
                        worker_threads,
                        processing_threads,
                    )?
                } else {
                    vec![None; planning_pages.len()]
                };
                derive_page_ink_contexts(&samples)
            }
        };
        let run_one =
            |(index, descriptor): (usize, &PageDescriptor)| -> Result<PageRunResult, NativeError> {
                let page = &manifest.pages[index];
                report_page_started(index)?;
                let page_cache = page_cache_for(descriptor, &cache)?;
                let result = with_sub_page_progress_observer(
                    &|sub_stage, _, _| report_page_stage(index, sub_stage),
                    || {
                        run_page(
                            page,
                            manifest.canvas_scope,
                            manifest.render_mode == RenderMode::Final,
                            manifest.document_canvas,
                            None,
                            page_ink_contexts[index],
                            &page_cache,
                            is_canceled,
                        )
                    },
                )
                .map_err(|error| map_page_error(error.as_ref()))?;
                report_page_done(index, page_complete_progress(&result, index, total_pages))?;
                Ok(result)
            };
        let mut page_results = run_page_jobs_with_worker_threads(
            manifest,
            is_canceled,
            run_one,
            worker_threads,
            processing_threads,
        )?;
        for (page, page_result) in manifest.pages.iter().zip(&mut page_results) {
            if let Some(pdf_page) = &page.pdf_page {
                plan_lossless_page(
                    &mut page_result.metadata.outputs,
                    pdf_page,
                    page_result.metadata.rotation_degrees,
                    &page.options,
                    manifest.document_canvas,
                    manifest.render_mode == RenderMode::Preview,
                );
            }
        }
        page_results
    };
    for (index, page_result) in page_results.iter_mut().enumerate() {
        if is_canceled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(crate::engine::cancellation_error().into());
        }
        write_json_atomic(&page_result.page_metadata_path, &page_result.metadata)?;
        if analyzing {
            publisher.publish_reliable(page_complete_progress(page_result, index, total_pages))?;
        }
    }
    let written_outputs = page_results
        .iter()
        .flat_map(|page_result| page_result.outputs.iter())
        .collect::<Vec<_>>();
    if is_canceled.load(std::sync::atomic::Ordering::Acquire) {
        return Err(crate::engine::cancellation_error().into());
    }
    match_page_sizes(&written_outputs, manifest.document_canvas)?;
    for (page, page_result) in manifest.pages.iter().zip(&page_results) {
        if let Some(pdf_page) = &page.pdf_page {
            for output in &page_result.outputs {
                record_source_preservation(&output.metadata_path, pdf_page, &page.options)?;
            }
        }
    }
    publisher.publish_reliable(Progress::new(
        ProgressStage::Completed,
        manifest.pages.len(),
        manifest.pages.len(),
    ))?;
    publisher.finish()?;
    Ok(())
}

/// Runs an analyze manifest's document sequence as the engine plans it: the
/// primary pass over every page in parallel, then each rerun and alternate
/// view the plan asks for, one at a time under its own staged lease.
#[allow(clippy::too_many_arguments)]
fn analyze_document(
    manifest: &ManifestV3,
    is_canceled: &AtomicBool,
    cache: &Arc<Mutex<ByteLru>>,
    announce_lease: LeaseAnnouncer<'_>,
    announce_alternate: LeaseAnnouncer<'_>,
    report_page_started: &(dyn Fn(usize) -> Result<(), NativeError> + Sync),
    report_page_stage: &(dyn Fn(usize, SubPageStage) + Sync),
    report_recheck_done: &(dyn Fn(usize) -> Result<(), NativeError> + Sync),
    primary_pass: impl FnOnce() -> Result<Vec<PageRunResult>, Box<dyn Error>>,
) -> Result<Vec<PageRunResult>, Box<dyn Error>> {
    let document = AnalysisDocument {
        pages: manifest
            .pages
            .iter()
            .map(|page| AnalysisPage {
                document_prior: page.document_prior,
                alternate_view: page.alternate_view.as_ref(),
                placement: page
                    .pdf_page
                    .as_ref()
                    .map(|pdf_page| (pdf_page, &page.options)),
            })
            .collect(),
        document_canvas: manifest.document_canvas,
        preview: manifest.render_mode == RenderMode::Preview,
    };
    let mut timings = vec![PageStageTimings::default(); manifest.pages.len()];
    let mut analyses = Vec::<PageAnalysis>::new();
    let mut primary_pass = Some(primary_pass);
    loop {
        let jobs = match next_analysis_step(&document, &analyses)? {
            AnalysisStep::Analyze(jobs) => jobs,
            AnalysisStep::Finished(pages) => {
                return Ok(pages
                    .into_iter()
                    .zip(timings)
                    .zip(&manifest.pages)
                    .map(|((metadata, timings), page)| PageRunResult {
                        outputs: Vec::new(),
                        metadata,
                        page_metadata_path: page.page_metadata_path.clone(),
                        timings,
                    })
                    .collect());
            }
        };
        if let Some(primary_pass) = primary_pass.take() {
            // The first step is every page's primary view, in page order.
            for (job, result) in jobs.into_iter().zip(primary_pass()?) {
                timings[job.index] += result.timings;
                analyses.push(PageAnalysis {
                    job,
                    metadata: Some(result.metadata),
                });
            }
            continue;
        }
        for job in jobs {
            let manifest_page = &manifest.pages[job.index];
            let alternate = job.view == AnalysisView::Alternate;
            let mut page = manifest_page.clone();
            if alternate {
                let (Some(path), Some(view)) = (
                    &manifest_page.alternate_input_path,
                    &manifest_page.alternate_view,
                ) else {
                    return Err(
                        invalid("An alternate analysis needs the page's alternate view").into(),
                    );
                };
                page.input_path = path.clone();
                page.options = view.options.clone();
            }
            let lease = StagedLeaseDescriptor {
                enabled: alternate || manifest.staged_input_window.is_some(),
                ..staged_lease(manifest, job.index, &page)
            };
            let announce: LeaseAnnouncer<'_> = if alternate {
                announce_alternate
            } else {
                announce_lease
            };
            let analyzed = with_announced_staged_page_input(&lease, announce, is_canceled, || {
                // An empty alternate raster is the owning process declining it.
                if alternate
                    && fs::metadata(&page.input_path)
                        .map_err(|error| {
                            NativeError::new(
                                NativeErrorCode::Io,
                                format!(
                                    "Unable to read the alternate view of page {}: {error}",
                                    lease.page_number
                                ),
                            )
                        })?
                        .len()
                        == 0
                {
                    return Ok(None);
                }
                report_page_started(job.index)?;
                let page_cache = page_cache_for(&planning_page(&page), cache)?;
                let result = with_sub_page_progress_observer(
                    &|sub_stage, _, _| report_page_stage(job.index, sub_stage),
                    || {
                        run_classification(
                            &page,
                            manifest.canvas_scope,
                            job.document_prior,
                            true,
                            manifest.analysis_purpose == AnalysisPurpose::PagePlan,
                            &page_cache,
                            is_canceled,
                        )
                    },
                )
                .map(Some)
                .map_err(|error| map_page_error(error.as_ref()));
                if result.is_ok() {
                    report_recheck_done(job.index)?;
                }
                result
            })?;
            if let Some(result) = &analyzed {
                timings[job.index] += result.timings;
            }
            analyses.push(PageAnalysis {
                job,
                metadata: analyzed.map(|result| result.metadata),
            });
        }
    }
}

enum ProgressWriteError {
    BrokenPipe,
    Other(String),
}

struct ProgressPublisherState {
    reported_done: Vec<bool>,
    completed_pages: usize,
    total_pages: usize,
    reliable: VecDeque<(u64, Progress)>,
    pending_stages: BTreeMap<usize, SubPageStage>,
    enqueued_seq: u64,
    flushed_seq: u64,
    closed: bool,
    error: Option<ProgressWriteError>,
}

struct ProgressPublisher {
    shared: Arc<(Mutex<ProgressPublisherState>, Condvar)>,
    writer: Option<JoinHandle<()>>,
}

impl ProgressPublisher {
    fn spawn<F>(total_pages: usize, write_fn: F) -> Self
    where
        F: Fn(Progress) -> Result<(), Box<dyn Error>> + Send + 'static,
    {
        let shared = Arc::new((
            Mutex::new(ProgressPublisherState {
                reported_done: vec![false; total_pages],
                completed_pages: 0,
                total_pages,
                reliable: VecDeque::new(),
                pending_stages: BTreeMap::new(),
                enqueued_seq: 0,
                flushed_seq: 0,
                closed: false,
                error: None,
            }),
            Condvar::new(),
        ));
        let worker_shared = Arc::clone(&shared);
        let writer = thread::spawn(move || {
            let (lock, notify) = &*worker_shared;
            loop {
                let (reliable_batch, stage_batch, total_pages, completed_pages) = {
                    let mut state = match lock.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };
                    while state.reliable.is_empty()
                        && state.pending_stages.is_empty()
                        && !state.closed
                        && state.error.is_none()
                    {
                        state = match notify.wait(state) {
                            Ok(guard) => guard,
                            Err(_) => return,
                        };
                    }
                    if state.error.is_some()
                        || (state.closed
                            && state.reliable.is_empty()
                            && state.pending_stages.is_empty())
                    {
                        return;
                    }
                    let reliable_batch: Vec<(u64, Progress)> = state.reliable.drain(..).collect();
                    let stage_batch: Vec<(usize, SubPageStage)> = if state.closed {
                        state.pending_stages.clear();
                        Vec::new()
                    } else {
                        std::mem::take(&mut state.pending_stages)
                            .into_iter()
                            .collect()
                    };
                    (
                        reliable_batch,
                        stage_batch,
                        state.total_pages,
                        state.completed_pages,
                    )
                };

                let mut write_failure: Option<ProgressWriteError> = None;
                let mut highest_flushed_seq: Option<u64> = None;
                for (seq, frame) in reliable_batch {
                    if let Err(error) = write_fn(frame) {
                        write_failure = Some(if error.is::<ClosedOutputPipe>() {
                            ProgressWriteError::BrokenPipe
                        } else {
                            ProgressWriteError::Other(error.to_string())
                        });
                        break;
                    }
                    highest_flushed_seq = Some(seq);
                }
                if write_failure.is_none() {
                    for (index, stage) in stage_batch {
                        if let Err(error) = write_fn(Progress::page_stage(
                            index + 1,
                            stage,
                            completed_pages,
                            total_pages,
                        )) {
                            write_failure = Some(if error.is::<ClosedOutputPipe>() {
                                ProgressWriteError::BrokenPipe
                            } else {
                                ProgressWriteError::Other(error.to_string())
                            });
                            break;
                        }
                    }
                }

                if let Ok(mut state) = lock.lock() {
                    if let Some(seq) = highest_flushed_seq {
                        state.flushed_seq = state.flushed_seq.max(seq);
                    }
                    if let Some(failure) = write_failure {
                        state.error = Some(failure);
                        state.reliable.clear();
                        state.pending_stages.clear();
                        notify.notify_all();
                        return;
                    }
                    notify.notify_all();
                } else {
                    return;
                }
            }
        });
        Self {
            shared,
            writer: Some(writer),
        }
    }

    fn map_state_error(error: &ProgressWriteError, context: &str) -> NativeError {
        match error {
            ProgressWriteError::BrokenPipe => NativeError::new(
                NativeErrorCode::NativeFailure,
                format!("{context}: {}", ClosedOutputPipe),
            ),
            ProgressWriteError::Other(message) => NativeError::new(
                NativeErrorCode::NativeFailure,
                format!("{context}: {message}"),
            ),
        }
    }

    fn publish_reliable(&self, progress: Progress) -> Result<(), NativeError> {
        let (lock, notify) = &*self.shared;
        let mut state = lock.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup progress",
            )
        })?;
        if let Some(error) = &state.error {
            return Err(Self::map_state_error(
                error,
                "Unable to publish scan-cleanup progress",
            ));
        }
        state.enqueued_seq += 1;
        let seq = state.enqueued_seq;
        state.reliable.push_back((seq, progress));
        notify.notify_all();
        Ok(())
    }

    fn publish_lease(&self, progress: Progress) -> Result<(), NativeError> {
        let (lock, notify) = &*self.shared;
        let mut state = lock.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup staged input lease",
            )
        })?;
        if let Some(error) = &state.error {
            return Err(Self::map_state_error(
                error,
                "Unable to publish scan-cleanup staged input lease",
            ));
        }
        state.enqueued_seq += 1;
        let target_seq = state.enqueued_seq;
        state.reliable.push_back((target_seq, progress));
        notify.notify_all();
        while state.flushed_seq < target_seq && state.error.is_none() && !state.closed {
            state = notify.wait(state).map_err(|_| {
                NativeError::new(
                    NativeErrorCode::NativeFailure,
                    "Unable to flush scan-cleanup staged input lease",
                )
            })?;
        }
        if state.flushed_seq >= target_seq {
            return Ok(());
        }
        if let Some(error) = &state.error {
            return Err(Self::map_state_error(
                error,
                "Unable to publish scan-cleanup staged input lease",
            ));
        }
        Ok(())
    }

    fn publish_page_started(&self, index: usize) -> Result<(), NativeError> {
        let (lock, notify) = &*self.shared;
        let mut state = lock.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup page start progress",
            )
        })?;
        if let Some(error) = &state.error {
            return Err(Self::map_state_error(
                error,
                "Unable to publish scan-cleanup page start progress",
            ));
        }
        let completed = state.completed_pages;
        let total = state.total_pages;
        state.enqueued_seq += 1;
        let seq = state.enqueued_seq;
        state
            .reliable
            .push_back((seq, Progress::page_started(index + 1, completed, total)));
        notify.notify_all();
        Ok(())
    }

    fn publish_page_stage(&self, index: usize, sub_page_stage: SubPageStage) {
        let (lock, notify) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            if state.error.is_none() && !state.closed {
                state.pending_stages.insert(index, sub_page_stage);
                notify.notify_all();
            }
        }
    }

    fn publish_page_done(&self, index: usize, mut progress: Progress) -> Result<(), NativeError> {
        let (lock, notify) = &*self.shared;
        let mut state = lock.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup page progress",
            )
        })?;
        if let Some(error) = &state.error {
            return Err(Self::map_state_error(
                error,
                "Unable to publish scan-cleanup page progress",
            ));
        }
        let Some(reported) = state.reported_done.get_mut(index) else {
            return Err(NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup progress for an unknown page",
            ));
        };
        if !*reported {
            *reported = true;
            state.completed_pages += 1;
        }
        state.pending_stages.remove(&index);
        progress.completed_pages = state.completed_pages;
        state.enqueued_seq += 1;
        let seq = state.enqueued_seq;
        state.reliable.push_back((seq, progress));
        notify.notify_all();
        Ok(())
    }

    fn publish_recheck_done(&self, index: usize) -> Result<(), NativeError> {
        let (lock, notify) = &*self.shared;
        let mut state = lock.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup recheck completion",
            )
        })?;
        if let Some(error) = &state.error {
            return Err(Self::map_state_error(
                error,
                "Unable to publish scan-cleanup recheck completion",
            ));
        }
        state.pending_stages.remove(&index);
        let mut progress = Progress::new(
            ProgressStage::PageAnalyzed,
            state.completed_pages,
            state.total_pages,
        );
        progress.page_number = Some(index + 1);
        state.enqueued_seq += 1;
        let seq = state.enqueued_seq;
        state.reliable.push_back((seq, progress));
        notify.notify_all();
        Ok(())
    }

    fn finish(mut self) -> Result<(), Box<dyn Error>> {
        self.shutdown();
        let (lock, _) = &*self.shared;
        let state = lock.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to finalize scan-cleanup progress stream",
            )
        })?;
        match &state.error {
            None => Ok(()),
            Some(ProgressWriteError::BrokenPipe) => Err(ClosedOutputPipe.into()),
            Some(ProgressWriteError::Other(message)) => {
                Err(NativeError::new(NativeErrorCode::NativeFailure, message.clone()).into())
            }
        }
    }

    fn shutdown(&mut self) {
        let (lock, notify) = &*self.shared;
        if let Ok(mut state) = lock.lock() {
            state.closed = true;
            notify.notify_all();
        }
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

impl Drop for ProgressPublisher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(crate) fn write_progress(progress: Progress) -> Result<(), Box<dyn Error>> {
    write_protocol_line(&ProgressEnvelope::new(progress))
}

/// Raised when the host has stopped reading our stdout, which is how a
/// cancelled run reaches us. It travels as an ordinary error so the manifest
/// transaction still rolls back the half-written outputs before `run` turns it
/// into the cancellation exit code.
#[derive(Debug)]
struct ClosedOutputPipe;

impl std::fmt::Display for ClosedOutputPipe {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the host stopped reading scan-cleanup output")
    }
}

impl Error for ClosedOutputPipe {}

fn write_protocol_line(value: &impl Serialize) -> Result<(), Box<dyn Error>> {
    let bytes = serde_json::to_vec(value)?;
    let mut stdout = io::stdout().lock();
    let result = stdout
        .write_all(&bytes)
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush());
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Err(ClosedOutputPipe.into()),
        Err(error) => Err(error.into()),
    }
}

fn page_complete_progress(result: &PageRunResult, index: usize, total_pages: usize) -> Progress {
    let metadata = &result.metadata;
    let stage_timings = result.timings;
    Progress {
        stage: ProgressStage::PageComplete,
        completed_pages: index + 1,
        total_pages,
        page_number: Some(index + 1),
        sub_page_stage: None,
        output_paths: Some(
            result
                .outputs
                .iter()
                .map(|output| output.output_path.clone())
                .collect(),
        ),
        classification: Some(metadata.layout_classification),
        confidence: Some(metadata.layout_confidence),
        cutter_x_px: (metadata.layout_classification == LayoutClassification::TwoPageSpread)
            .then_some(metadata.cutter_x_px)
            .flatten(),
        tier1_verdict: Some(metadata.tier1_verdict),
        reconciled: Some(metadata.reconciled),
        cluster_agreement: Some(metadata.cluster_agreement),
        document_prior: metadata.document_prior,
        text_axis: metadata.text_axis,
        stage_timings: (!stage_timings.is_empty()).then_some(stage_timings),
        recommended_output_mode: metadata.recommended_output_mode,
        recommended_output_mode_confidence: metadata.recommended_output_mode_confidence,
        recommended_output_mode_reason: metadata.recommended_output_mode_reason,
        soft_alpha_foreground_recommendation: metadata.soft_alpha_foreground_recommendation,
        output_mode_diagnostics: metadata.output_mode_diagnostics,
        alternate_view: false,
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_cli_args, ScanCleanupCliInvocation};
    use evb_native_support::NativeErrorCode;
    use std::path::PathBuf;

    fn cli_args(args: &[&str]) -> Vec<String> {
        args.iter()
            .map(|argument| (*argument).to_string())
            .collect()
    }

    #[test]
    fn warning_mapping_keeps_wire_shape_and_rounds_scale_at_adapter_boundary() {
        use crate::engine::output_geometry::CanvasWarning;

        let warning = CanvasWarning::MatchedCanvasPaperDownscaled {
            paper_scale: 1.2345,
            document_canvas_width: 1000.0,
            document_canvas_height: 800.0,
            paper_width: Some(1100.0),
            paper_height: Some(900.0),
        };
        let json = serde_json::to_value(
            crate::engine::output_geometry::canvas_warning_to_protocol(warning),
        )
        .unwrap();

        assert_eq!(json["code"], "matched-canvas-paper-downscaled");
        assert_eq!(json["unit"], "px");
        assert_eq!(json["scalePercentTenths"], 1234);
        assert_eq!(json["documentCanvasWidth"], 1000.0);
        assert_eq!(json["paperHeight"], 900.0);

        let fitted = CanvasWarning::MatchedCanvasContentFitted {
            content_width: 600.0,
            content_height: 500.0,
            inner_width: 952.0,
            inner_height: 952.0,
            document_canvas_width: Some(1000.0),
            document_canvas_height: Some(1000.0),
        };
        let fitted_json = serde_json::to_value(
            crate::engine::output_geometry::canvas_warning_to_protocol(fitted),
        )
        .unwrap();
        assert_eq!(fitted_json["code"], "matched-canvas-content-fitted");
        assert_eq!(fitted_json["unit"], "px");
        assert_eq!(fitted_json["contentWidth"], 600.0);
        assert_eq!(fitted_json["documentCanvasHeight"], 1000.0);

        let margins = vec![
            crate::engine::output_geometry::canvas_warning_to_protocol(
                CanvasWarning::MatchedCanvasMarginsReduced,
            ),
            crate::engine::output_geometry::canvas_warning_to_protocol(
                CanvasWarning::MatchedCanvasMarginsUnavailable,
            ),
        ];
        let margins_json = serde_json::to_value(margins).unwrap();
        assert_eq!(margins_json[0]["code"], "matched-canvas-margins-reduced");
        assert_eq!(
            margins_json[1]["code"],
            "matched-canvas-margins-unavailable"
        );

        let edge = CanvasWarning::MatchedCanvasPaperDownscaled {
            paper_scale: 1.225,
            document_canvas_width: 1.0,
            document_canvas_height: 1.0,
            paper_width: None,
            paper_height: None,
        };
        let edge_json = serde_json::to_value(
            crate::engine::output_geometry::canvas_warning_to_protocol(edge),
        )
        .unwrap();
        assert_eq!(edge_json["scalePercentTenths"], 1225);
    }

    #[test]
    fn strict_cli_parser_preserves_documented_invocations() {
        assert_eq!(
            parse_cli_args(&cli_args(&["--manifest", "/tmp/manifest.json"])).unwrap(),
            ScanCleanupCliInvocation::Manifest {
                path: PathBuf::from("/tmp/manifest.json"),
                allowed_path_root: None,
            },
        );
        assert_eq!(
            parse_cli_args(&cli_args(&[
                "--manifest",
                "/tmp/manifest.json",
                "--allowed-path-root",
                "/tmp/run-root",
            ]))
            .unwrap(),
            ScanCleanupCliInvocation::Manifest {
                path: PathBuf::from("/tmp/manifest.json"),
                allowed_path_root: Some(PathBuf::from("/tmp/run-root")),
            },
        );
        assert_eq!(
            parse_cli_args(&cli_args(&[
                "--ocr-mode",
                "--metadata",
                "/tmp/page.json",
                "--output",
                "/tmp/page.png",
                "--experimental-auto-dewarp",
                "--input",
                "/tmp/page.ppm",
                "--options",
                "{}",
            ]))
            .unwrap(),
            ScanCleanupCliInvocation::Direct {
                input: PathBuf::from("/tmp/page.ppm"),
                output: PathBuf::from("/tmp/page.png"),
                metadata: PathBuf::from("/tmp/page.json"),
                options: Some("{}".to_string()),
                ocr_mode: true,
                experimental_auto_dewarp: true,
            },
        );
    }

    #[test]
    fn strict_cli_parser_rejects_unknown_duplicate_missing_and_invalid_arguments() {
        let cases: &[(&[&str], &str)] = &[
            (&["--manifest"], "--manifest requires a value"),
            (&["--manifest", ""], "--manifest requires a value"),
            (
                &["--manifest", "/tmp/a.json", "--manifest", "/tmp/b.json"],
                "Duplicate argument --manifest",
            ),
            (
                &["--manifest", "/tmp/a.json", "--unknown"],
                "Unknown argument --unknown",
            ),
            (
                &["--manifest", "/tmp/a.json", "--input", "/tmp/page.ppm"],
                "--manifest cannot be combined with direct-mode arguments",
            ),
            (
                &["--input", "/tmp/page.ppm", "--output"],
                "--output requires a value",
            ),
            (
                &[
                    "--input",
                    "/tmp/page.ppm",
                    "--input",
                    "/tmp/other.ppm",
                    "--output",
                    "/tmp/page.png",
                    "--metadata",
                    "/tmp/page.json",
                ],
                "Duplicate argument --input",
            ),
            (
                &[
                    "--input",
                    "/tmp/page.ppm",
                    "--output",
                    "/tmp/page.png",
                    "--metadata",
                    "/tmp/page.json",
                    "--ocr-mode",
                    "true",
                ],
                "Unexpected positional argument true",
            ),
            (
                &["--allowed-path-root"],
                "--allowed-path-root requires a value",
            ),
            (
                &[
                    "--manifest",
                    "/tmp/a.json",
                    "--allowed-path-root",
                    "/tmp/root",
                    "--allowed-path-root",
                    "/tmp/other",
                ],
                "Duplicate argument --allowed-path-root",
            ),
            (
                &[
                    "--input",
                    "/tmp/page.ppm",
                    "--output",
                    "/tmp/page.png",
                    "--metadata",
                    "/tmp/page.json",
                    "--allowed-path-root",
                    "/tmp/root",
                ],
                "--allowed-path-root requires --manifest",
            ),
            (&["--input=page.ppm"], "Unknown argument --input=page.ppm"),
            (&["--version"], "Unknown argument --version"),
            (&["-V"], "Unexpected positional argument -V"),
            (&["unflagged"], "Unexpected positional argument unflagged"),
        ];

        for (args, expected) in cases {
            let error = parse_cli_args(&cli_args(args)).unwrap_err();
            assert_eq!(
                error.code,
                NativeErrorCode::InvalidRequest,
                "args: {args:?}"
            );
            assert_eq!(error.message, *expected, "args: {args:?}");
        }
    }

    #[test]
    fn strict_direct_cli_reports_each_required_value() {
        for (args, missing) in [
            (vec![], "--input"),
            (vec!["--input", "in.ppm"], "--output"),
            (
                vec!["--input", "in.ppm", "--output", "out.png"],
                "--metadata",
            ),
        ] {
            let error = parse_cli_args(&cli_args(&args)).unwrap_err();
            assert_eq!(error.code, NativeErrorCode::InvalidRequest);
            assert_eq!(
                error.message,
                format!("Missing required argument {missing}")
            );
        }
    }

    #[test]
    fn rejects_outside_root_ink_calibration_path_before_sampling() {
        let base =
            std::env::temp_dir().join(format!("evb-scan-cleanup-cal-root-{}", std::process::id()));
        let allowed_root = base.join("allowed");
        let outside_dir = base.join("outside");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&allowed_root).expect("create allowed root");
        std::fs::create_dir_all(&outside_dir).expect("create outside dir");

        let page_input = allowed_root.join("source-1.ppm");
        let page_output = allowed_root.join("clean-1-0.png");
        let page_output_meta = allowed_root.join("clean-1-0.json");
        let page_meta = allowed_root.join("clean-1-page.json");
        let outside_mask = outside_dir.join("outside-mask.png");
        let inside_bg = allowed_root.join("bg.ppm");

        // Write valid minimal PPM headers so validation passes regular-file checks
        // and only allowed_path_root confinement rejects the outside calibration file.
        let tiny_ppm = b"P6\n1 1\n255\n\x00\x00\x00";
        std::fs::write(&page_input, tiny_ppm).expect("write input");
        std::fs::write(&outside_mask, tiny_ppm).expect("write outside mask");
        std::fs::write(&inside_bg, tiny_ppm).expect("write bg");

        let manifest_path = allowed_root.join("manifest.json");
        let manifest_json = serde_json::json!({
            "version": 3,
            "operation": "render",
            "renderMode": "final",
            "canvasScope": "page",
            "inkCalibrationPages": [{
                "sourcePageIndex": 0,
                "trustedForegroundMaskPath": outside_mask,
                "trustedMrcBackgroundPath": inside_bg,
            }],
            "pages": [{
                "sourcePageIndex": 0,
                "inputPath": page_input,
                "pageMetadataPath": page_meta,
                "options": {
                    "dpi": 300,
                    "despeckle": false,
                    "outputMode": "bw",
                    "cropContent": false,
                    "matchPageSize": false,
                    "pageAlignment": "top-center",
                },
                "outputs": [{
                    "outputPath": page_output,
                    "metadataPath": page_output_meta,
                }],
            }],
        });
        std::fs::write(&manifest_path, manifest_json.to_string()).expect("write manifest");

        let error = super::run_manifest(
            &manifest_path,
            Some(&allowed_root),
            &std::sync::atomic::AtomicBool::new(false),
        )
        .expect_err("outside-root calibration path must be rejected");
        let message = error.to_string();
        assert!(
            message.contains("outside") || message.contains("allowed") || message.contains("root"),
            "unexpected error message: {message}"
        );
        assert!(
            !page_output.exists() && !page_meta.exists(),
            "no outputs may be written when calibration path escapes allowed root"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn progress_publisher_streams_out_of_order_completions_and_coalesces_stages() {
        use std::sync::{Arc, Condvar, Mutex};
        use std::time::{Duration, Instant};

        struct GateUnlockGuard(Arc<(Mutex<(bool, bool)>, Condvar)>);
        impl Drop for GateUnlockGuard {
            fn drop(&mut self) {
                let (lock, notify) = &*self.0;
                if let Ok(mut state) = lock.lock() {
                    state.1 = true;
                    notify.notify_all();
                }
            }
        }

        let gate = Arc::new((Mutex::new((false, false)), Condvar::new()));
        let _unlock_guard = GateUnlockGuard(Arc::clone(&gate));
        let recorded = Arc::new((
            Mutex::new(Vec::<(
                super::ProgressStage,
                Option<usize>,
                usize,
                Option<super::SubPageStage>,
            )>::new()),
            Condvar::new(),
        ));
        let gate_for_writer = Arc::clone(&gate);
        let recorded_for_writer = Arc::clone(&recorded);
        let publisher = super::ProgressPublisher::spawn(2, move |frame| {
            let (lock, notify) = &*gate_for_writer;
            let mut state = lock.lock().expect("lock gate");
            state.0 = true;
            notify.notify_all();
            while !state.1 {
                state = notify.wait(state).expect("wait gate");
            }
            drop(state);
            let (rec_lock, rec_notify) = &*recorded_for_writer;
            rec_lock.lock().expect("lock recorded").push((
                frame.stage,
                frame.page_number,
                frame.completed_pages,
                frame.sub_page_stage,
            ));
            rec_notify.notify_all();
            Ok(())
        });

        // Queue a sentinel frame first and wait until the writer is blocked
        // inside the write callback so subsequent queue updates cannot be
        // drained early.
        publisher
            .publish_reliable(super::Progress::new(super::ProgressStage::Started, 0, 2))
            .expect("publish started sentinel");
        {
            let (lock, notify) = &*gate;
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut state = lock.lock().expect("lock gate wait");
            while !state.0 {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(!remaining.is_zero(), "timed out waiting for writer entry");
                let (next, _) = notify
                    .wait_timeout(state, remaining)
                    .expect("wait writer entry");
                state = next;
            }
        }

        // While the writer is blocked behind stdout, workers enqueue rapid
        // stages and page 2 finishes before page 1 without stalling.
        publisher.publish_page_started(0).expect("start page 1");
        publisher.publish_page_started(1).expect("start page 2");
        publisher.publish_page_stage(0, super::SubPageStage::Decode);
        publisher.publish_page_stage(0, super::SubPageStage::Deskew);
        publisher.publish_page_stage(1, super::SubPageStage::Render);
        publisher
            .publish_page_done(
                1,
                super::Progress {
                    page_number: Some(2),
                    ..super::Progress::new(super::ProgressStage::PageComplete, 0, 2)
                },
            )
            .expect("finish page 2 first");

        // Open stdout and wait until page 1's coalesced Deskew stage has been
        // written before finishing page 1.
        {
            let (lock, notify) = &*gate;
            lock.lock().expect("unlock gate").1 = true;
            notify.notify_all();
        }
        {
            let (rec_lock, rec_notify) = &*recorded;
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut frames = rec_lock.lock().expect("wait stage frame");
            while !frames.iter().any(|(stage, page, _, sub)| {
                *stage == super::ProgressStage::PageStage
                    && *page == Some(1)
                    && *sub == Some(super::SubPageStage::Deskew)
            }) {
                let remaining = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !remaining.is_zero(),
                    "timed out waiting for page 1 Deskew stage; recorded frames: {:?}",
                    *frames
                );
                let (next, _) = rec_notify
                    .wait_timeout(frames, remaining)
                    .expect("wait deskew emission");
                frames = next;
            }
        }
        publisher
            .publish_page_done(
                0,
                super::Progress {
                    page_number: Some(1),
                    ..super::Progress::new(super::ProgressStage::PageComplete, 0, 2)
                },
            )
            .expect("finish page 1 second");
        publisher.finish().expect("finish publisher");

        let frames = recorded.0.lock().expect("read recorded");
        let completions: Vec<(Option<usize>, usize)> = frames
            .iter()
            .filter(|(stage, _, _, _)| *stage == super::ProgressStage::PageComplete)
            .map(|(_, page, completed, _)| (*page, *completed))
            .collect();
        assert_eq!(completions, vec![(Some(2), 1), (Some(1), 2)]);
        // Page 1's rapid Decode -> Deskew transitions coalesced to Deskew only.
        let page1_stages: Vec<Option<super::SubPageStage>> = frames
            .iter()
            .filter(|(stage, page, _, _)| {
                *stage == super::ProgressStage::PageStage && *page == Some(1)
            })
            .map(|(_, _, _, sub)| *sub)
            .collect();
        assert_eq!(page1_stages, vec![Some(super::SubPageStage::Deskew)]);
        // Page 2 finished before flush, so its pending Render stage must not emit.
        assert!(!frames.iter().any(|(stage, page, _, _)| {
            *stage == super::ProgressStage::PageStage && *page == Some(2)
        }));
    }
}
