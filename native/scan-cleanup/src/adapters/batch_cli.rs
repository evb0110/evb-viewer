use crate::adapters::manifest_publication::run_manifest_transaction;
use crate::adapters::single_ocr_cli::{invalid, parse_options};
use crate::engine::batch_reconciliation::{
    apply_reconciliation_actions, reconcile_classification_batch, reconciliation_candidates,
    ReconciliationPolicy,
};
use crate::engine::output_geometry::{match_page_sizes, write_json_atomic};
use crate::engine::page_statistics::{
    derive_page_ink_contexts, derive_page_ink_sample, page_needs_ink_sample,
};
use crate::engine::page_workflow::{run_classification, run_page, PageRunResult};
use crate::engine::resource_planning::{
    manifest_cache, page_cache_for, page_worker_threads, processing_worker_threads, run_page_jobs,
    run_regular_page_jobs, PageDescriptor, PlanningOperation,
};
use crate::engine::staged_input::{
    acquire_staged_page_input, assert_paths_within_root, finish_staged_rerun, page_from_staged,
    planning_operation, planning_page, preflight_paths, release_staged_page_input,
    run_one_staged_page_job, staged_lease, staged_path_plan, with_announced_staged_page_input,
    LeaseEvent,
};
use crate::{
    protocol::{
        manifest_v3::{
            AnalysisPurpose, CanvasScope, ManifestV3, Operation, Page, RenderMode,
            MAX_MANIFEST_PAGES_PER_BATCH,
        },
        progress::{Progress, ProgressEnvelope, ProgressStage},
        result::ResultEnvelope,
    },
    split::LayoutClassification,
};
use evb_native_support::{
    bounded_io::deserialize_json_file_bounded, NativeError, NativeErrorCode, NativeErrorEnvelope,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    error::Error,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

// Keep the materialized compatibility sanitizer bounded by the same page
// admission contract as the wire page vector. Eight KiB per page leaves room
// for normal authored options while preventing a byte-sized manifest from
// turning the additive unknown-field pass into an unbounded allocation.
const MAX_MANIFEST_BYTES: usize = MAX_MANIFEST_PAGES_PER_BATCH * 8 * 1024;
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
    match run_inner(args) {
        // A closed pipe is the host cancelling, not a failure to report: the
        // shared CLI wrapper would otherwise turn it into a native-error exit.
        Err(error) if error.is::<ClosedOutputPipe>() => std::process::exit(CANCELLATION_EXIT_CODE),
        result => result,
    }
}

fn run_inner(args: impl IntoIterator<Item = String>) -> Result<(), Box<dyn Error>> {
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
            } => return run_manifest(&path, allowed_path_root.as_deref()),
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
    };
    let cache = manifest_cache(PlanningOperation::Render, None);
    let page_cache = page_cache_for(&planning_page(&page), &cache)?;
    run_page(
        &page,
        CanvasScope::Page,
        false,
        None,
        Some((&output, &metadata)),
        None,
        &page_cache,
    )
    .map(|_| ())
}

fn run_manifest(path: &Path, allowed_path_root: Option<&Path>) -> Result<(), Box<dyn Error>> {
    let manifest: ManifestV3 =
        deserialize_json_file_bounded(path, MAX_MANIFEST_BYTES, "v3 batch manifest")?;
    manifest.validate_for_execution()?;
    if let Some(root) = allowed_path_root {
        assert_paths_within_root(&staged_path_plan(&manifest), root)?;
    }
    preflight_paths(&staged_path_plan(&manifest))?;
    let total = manifest.pages.len();
    let result = run_manifest_transaction(&manifest, || run_manifest_inner(&manifest));
    match result {
        Ok(()) => {
            write_protocol_line(&ResultEnvelope::success(total, total))?;
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

fn run_manifest_inner(manifest: &ManifestV3) -> Result<(), Box<dyn Error>> {
    write_progress(Progress {
        stage: ProgressStage::Started,
        completed_pages: 0,
        total_pages: manifest.pages.len(),
        page_number: None,
        output_paths: None,
        classification: None,
        confidence: None,
        cutter_x_px: None,
        tier1_verdict: None,
        reconciled: None,
        cluster_agreement: None,
        document_prior: None,
        text_axis: None,
        stage_timings: None,
        recommended_output_mode: None,
        recommended_output_mode_confidence: None,
        recommended_output_mode_reason: None,
        soft_alpha_foreground_recommendation: None,
        output_mode_diagnostics: None,
    })?;
    let cache = manifest_cache(
        planning_operation(manifest.operation),
        manifest.host_memory_bytes,
    );
    let total_pages = manifest.pages.len();
    // Pages finish out of order under the worker pool, but the progress stream is
    // a monotone per-page sequence, so each page's event waits for its
    // predecessors before it is published.
    let pending_progress = Mutex::new((
        manifest.pages.iter().map(|_| None).collect::<Vec<_>>(),
        0usize,
    ));
    let report_page = |index: usize, progress: Progress| -> Result<(), NativeError> {
        let mut state = pending_progress.lock().map_err(|_| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                "Unable to publish scan-cleanup page progress",
            )
        })?;
        state.0[index] = Some(progress);
        loop {
            let cursor = state.1;
            let Some(published) = state.0.get_mut(cursor).and_then(Option::take) else {
                break;
            };
            state.1 = cursor + 1;
            write_progress(published).map_err(|error| {
                NativeError::new(
                    NativeErrorCode::NativeFailure,
                    format!("Unable to publish scan-cleanup page progress: {error}"),
                )
            })?;
        }
        Ok(())
    };
    let announce_lease = |event: LeaseEvent, page_number: usize, total: usize| {
        let stage = match event {
            LeaseEvent::Required => ProgressStage::PageInputRequired,
            LeaseEvent::Released => ProgressStage::PageInputReleased,
        };
        write_progress(Progress::page_input(stage, page_number, total)).map_err(|error| {
            NativeError::new(
                NativeErrorCode::NativeFailure,
                format!("Unable to publish scan-cleanup staged input lease: {error}"),
            )
        })
    };
    let analyzing = manifest.operation == Operation::Analyze;
    let page_ink_contexts = if analyzing {
        vec![None; manifest.pages.len()]
    } else {
        let planning_pages = manifest.pages.iter().map(planning_page).collect::<Vec<_>>();
        let samples = if planning_pages.iter().any(page_needs_ink_sample) {
            let worker_threads = page_worker_threads(manifest)?;
            let processing_threads = processing_worker_threads();
            run_regular_page_jobs(
                manifest,
                |(_, page)| derive_page_ink_sample(page),
                worker_threads,
                processing_threads,
            )?
        } else {
            vec![None; planning_pages.len()]
        };
        derive_page_ink_contexts(&samples)
    };
    let plan_content = manifest.analysis_purpose == AnalysisPurpose::PagePlan;
    let run_analysis =
        |(index, descriptor): (usize, &PageDescriptor)| -> Result<PageRunResult, NativeError> {
            let page = page_from_staged(&manifest.pages[index], descriptor);
            let lease = staged_lease(manifest, index, &page);
            let result = with_announced_staged_page_input(&lease, &announce_lease, || {
                let page_cache = page_cache_for(descriptor, &cache)?;
                run_classification(
                    &page,
                    manifest.canvas_scope,
                    page.document_prior,
                    true,
                    plan_content,
                    &page_cache,
                )
                .map_err(|error| map_page_error(error.as_ref()))
            })?;
            // Publish the page's independent verdict immediately. Document
            // reconciliation may revise it after the batch finishes, at which
            // point PageComplete replaces this provisional result. Keeping the
            // useful fields off PageAnalyzed forced every thumbnail to spin until
            // the slowest page in a large document had finished.
            let mut progress = page_complete_progress(&result, index, total_pages);
            progress.stage = ProgressStage::PageAnalyzed;
            progress.output_paths = None;
            report_page(index, progress)?;
            Ok(result)
        };
    let run_one =
        |(index, descriptor): (usize, &PageDescriptor)| -> Result<PageRunResult, NativeError> {
            let page = page_from_staged(&manifest.pages[index], descriptor);
            let page_cache = page_cache_for(descriptor, &cache)?;
            let result = run_page(
                &page,
                manifest.canvas_scope,
                manifest.render_mode == RenderMode::Final,
                manifest.document_canvas,
                None,
                page_ink_contexts[index],
                &page_cache,
            )
            .map_err(|error| map_page_error(error.as_ref()))?;
            report_page(index, page_complete_progress(&result, index, total_pages))?;
            Ok(result)
        };
    let mut page_results = if analyzing {
        run_page_jobs(manifest, run_analysis)?
    } else {
        run_page_jobs(manifest, run_one)?
    };

    // Reconciliation only ever revises classification-pass results; a render pass
    // has already published its pages by the time it returns.
    if analyzing {
        let candidates = reconciliation_candidates(&page_results);
        let actions = reconcile_classification_batch(
            &candidates,
            ReconciliationPolicy {
                minimum_confidence: 0.60,
                minimum_support: 2,
            },
        );
        let rerun = |index, prior| {
            let page = &manifest.pages[index];
            let lease = staged_lease(manifest, index, page);
            let stream_input = planning_page(page).stream_input;
            acquire_staged_page_input(&lease, &announce_lease)?;
            let rerun_result =
                run_one_staged_page_job(manifest, index, stream_input, |(_, descriptor)| {
                    let page = page_from_staged(&manifest.pages[index], descriptor);
                    let page_cache = page_cache_for(descriptor, &cache)?;
                    run_classification(
                        &page,
                        manifest.canvas_scope,
                        Some(prior),
                        manifest.operation == Operation::Analyze
                            || page.options.output_mode == crate::OutputMode::Auto,
                        manifest.analysis_purpose == AnalysisPurpose::PagePlan,
                        &page_cache,
                    )
                    .map_err(|error| map_page_error(error.as_ref()))
                });
            let released = release_staged_page_input(&lease, &announce_lease);
            finish_staged_rerun(rerun_result, released)
        };
        apply_reconciliation_actions(&mut page_results, &actions, rerun)?;
    }
    for (index, page_result) in page_results.iter().enumerate() {
        write_json_atomic(&page_result.page_metadata_path, &page_result.metadata)?;
        if analyzing {
            write_progress(page_complete_progress(page_result, index, total_pages))?;
        }
    }
    let written_outputs = page_results
        .iter()
        .flat_map(|page_result| page_result.outputs.iter())
        .collect::<Vec<_>>();
    match_page_sizes(&written_outputs, manifest.document_canvas)?;
    write_progress(Progress {
        stage: ProgressStage::Completed,
        completed_pages: manifest.pages.len(),
        total_pages: manifest.pages.len(),
        page_number: None,
        output_paths: None,
        classification: None,
        confidence: None,
        cutter_x_px: None,
        tier1_verdict: None,
        reconciled: None,
        cluster_agreement: None,
        document_prior: None,
        text_axis: None,
        stage_timings: None,
        recommended_output_mode: None,
        recommended_output_mode_confidence: None,
        recommended_output_mode_reason: None,
        soft_alpha_foreground_recommendation: None,
        output_mode_diagnostics: None,
    })?;
    Ok(())
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
}
