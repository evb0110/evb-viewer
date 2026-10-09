mod corpus;
mod evaluate;
mod report;

use evaluate::{compare_catastrophes, evaluate_corpus};
use evb_scan_cleanup::calibration::CalibrationConfig;
use rayon::ThreadPoolBuilder;
use report::{read_baseline, write_reports};
use std::{env, path::PathBuf, process::ExitCode};

const DEFAULT_THREADS: usize = 1;

#[derive(Debug)]
struct Arguments {
    out: PathBuf,
    baseline: Option<PathBuf>,
    calibration: CalibrationConfig,
}

fn main() -> ExitCode {
    let arguments = match parse_arguments() {
        Ok(Some(arguments)) => arguments,
        Ok(None) => return ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("scan-cleanup-harness: {error}");
            return ExitCode::from(2);
        }
    };
    match run(arguments) {
        Ok(regressions) if regressions.is_empty() => ExitCode::SUCCESS,
        Ok(regressions) => {
            eprintln!("catastrophe budget exceeded:");
            for regression in regressions {
                eprintln!("  {regression}");
            }
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("scan-cleanup-harness: {error}");
            ExitCode::from(2)
        }
    }
}

fn run(arguments: Arguments) -> Result<Vec<String>, String> {
    let corpus = corpus::build_corpus()?;
    let pool = ThreadPoolBuilder::new()
        .num_threads(DEFAULT_THREADS)
        .build()
        .map_err(|error| format!("failed to build fixed-size thread pool: {error}"))?;
    let report =
        pool.install(|| evaluate_corpus(&corpus, DEFAULT_THREADS, arguments.calibration))?;
    write_reports(&arguments.out, &report)?;

    println!(
        "wrote {} and {}",
        arguments.out.join("report.md").display(),
        arguments.out.join("report.json").display()
    );
    println!("catastrophes: {}", report.comparable.total_catastrophes());

    arguments
        .baseline
        .map(|path| {
            let baseline = read_baseline(&path)?;
            compare_catastrophes(&report.comparable, &baseline)
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

fn parse_arguments() -> Result<Option<Arguments>, String> {
    let mut out = default_output_directory();
    let mut baseline = None;
    let mut calibration = CalibrationConfig::default();
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--" => continue,
            "--out" => {
                out = PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--out requires a directory".to_string())?,
                );
            }
            "--baseline" => {
                baseline =
                    Some(PathBuf::from(arguments.next().ok_or_else(|| {
                        "--baseline requires a JSON path".to_string()
                    })?));
            }
            "--legacy-calibration" => calibration = CalibrationConfig::legacy(),
            "--help" | "-h" => {
                println!(
                    "Usage: scan-cleanup-harness [--out <directory>] [--baseline <report.json>] [--legacy-calibration]\n\
                     Default output: <repository>/.devkit/scratch/scan-cleanup-harness/"
                );
                return Ok(None);
            }
            _ => return Err(format!("unknown argument: {argument}")),
        }
    }
    Ok(Some(Arguments {
        out,
        baseline,
        calibration,
    }))
}

fn default_output_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".devkit/scratch/scan-cleanup-harness")
}

#[cfg(test)]
mod tests {
    use super::corpus;
    use evb_scan_cleanup::engine::render::{
        clean_page_with_canonical_analysis, CanonicalAnalysisPlane,
    };

    #[test]
    #[ignore = "the complete 51-page corpus across three render DPIs is release-only"]
    fn tracked_corpus_routes_reconciliation_and_leaf_resolution_are_dpi_identical() {
        for entry in corpus::build_corpus().unwrap() {
            let mut identities = Vec::new();
            for dpi in [298.0, 299.0, 300.0] {
                let mut options = entry.options.clone();
                options.dpi = dpi;
                options.skip_blank_pages = true;
                let scale = dpi / entry.dpi.max(1.0);
                let working = entry.image.resample_to_dimensions(
                    ((entry.image.width() as f64 * scale).round() as usize).max(1),
                    ((entry.image.height() as f64 * scale).round() as usize).max(1),
                );
                let result = clean_page_with_canonical_analysis(
                    &working,
                    CanonicalAnalysisPlane {
                        gray: &entry.image,
                        color: None,
                        dpi: entry.dpi,
                    },
                    &options,
                    0,
                )
                .unwrap_or_else(|error| panic!("{} at {dpi} DPI: {error}", entry.id));
                identities.push((
                    result.blank_outputs_skipped,
                    result
                        .outputs
                        .iter()
                        .map(|output| {
                            let source_region = output.metadata.source_region;
                            let canonical_x = |value: f64| {
                                (value * entry.image.width() as f64 / working.width() as f64)
                                    .round() as usize
                            };
                            let canonical_y = |value: f64| {
                                (value * entry.image.height() as f64 / working.height() as f64)
                                    .round() as usize
                            };
                            (
                                output.metadata.half,
                                output.metadata.binarization_mode,
                                output
                                    .metadata
                                    .binarization_diagnostics
                                    .and_then(|diagnostics| diagnostics.spread_plan)
                                    .map(|plan| plan.decision),
                                (
                                    canonical_x(source_region.x),
                                    canonical_y(source_region.y),
                                    canonical_x(source_region.width),
                                    canonical_y(source_region.height),
                                ),
                                (
                                    canonical_x(output.metadata.output_width as f64),
                                    canonical_y(output.metadata.output_height as f64),
                                ),
                            )
                        })
                        .collect::<Vec<_>>(),
                ));
            }
            assert!(
                identities.windows(2).all(|pair| pair[0] == pair[1]),
                "{} changed route/reconciliation/leaf resolution: {identities:?}",
                entry.id,
            );
        }
    }
}
