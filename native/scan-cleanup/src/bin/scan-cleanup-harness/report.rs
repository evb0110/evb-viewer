use crate::evaluate::{ComparableReport, HarnessReport};
use serde::Deserialize;
use std::{fs, path::Path};

pub fn write_reports(directory: &Path, report: &HarnessReport) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
    let json = serde_json::to_string_pretty(report)
        .map_err(|error| format!("failed to serialize JSON report: {error}"))?;
    fs::write(directory.join("report.json"), format!("{json}\n"))
        .map_err(|error| format!("failed to write JSON report: {error}"))?;
    fs::write(directory.join("report.md"), markdown_report(report))
        .map_err(|error| format!("failed to write markdown report: {error}"))?;
    Ok(())
}

pub fn read_baseline(path: &Path) -> Result<ComparableReport, String> {
    #[derive(Deserialize)]
    struct WrappedBaseline {
        comparable: ComparableReport,
    }

    let bytes = fs::read(path)
        .map_err(|error| format!("failed to read baseline {}: {error}", path.display()))?;
    serde_json::from_slice::<ComparableReport>(&bytes)
        .or_else(|_| {
            serde_json::from_slice::<WrappedBaseline>(&bytes).map(|wrapped| wrapped.comparable)
        })
        .map_err(|error| format!("failed to decode baseline {}: {error}", path.display()))
}

fn markdown_report(report: &HarnessReport) -> String {
    let comparable = &report.comparable;
    let metrics = &comparable.metrics;
    let performance = &report.non_comparable.performance;
    let mut output = String::new();
    output.push_str("# Scan Cleanup Corpus Harness\n\n");
    output.push_str("## Catastrophe headline\n\n");
    output.push_str("| Category | Counter | Count |\n|---|---|---:|\n");
    for (category, counters) in &comparable.catastrophes {
        if counters.is_empty() {
            output.push_str(&format!("| {category} | deferred stub | — |\n"));
        }
        for (counter, value) in counters {
            output.push_str(&format!("| {category} | {counter} | {value} |\n"));
        }
    }

    output.push_str("\n## Corpus\n\n");
    output.push_str(&format!(
        "{} fixtures: {} real and {} synthetic. Category counts overlap when a fixture exercises multiple concerns.\n\n",
        comparable.corpus.total, comparable.corpus.real, comparable.corpus.synthetic
    ));
    output.push_str("| Origin | Category | Count |\n|---|---|---:|\n");
    for (category, count) in &comparable.corpus.real_categories {
        output.push_str(&format!("| real | {category} | {count} |\n"));
    }
    for (category, count) in &comparable.corpus.synthetic_categories {
        output.push_str(&format!("| synthetic | {category} | {count} |\n"));
    }

    output.push_str("\n## Deterministic metrics\n\n");
    output.push_str(&format!(
        "- Split: {}/{} correct ({:.4}); cutter mean {:.3} px ({:.6} of width), max {:.3} px.\n",
        metrics.split.correct,
        metrics.split.evaluated,
        metrics.split.accuracy,
        metrics.split.mean_cutter_error_px,
        metrics.split.mean_cutter_error_width_fraction,
        metrics.split.max_cutter_error_px
    ));
    output.push_str(&format!(
        "- Deskew: {} truth fixtures, mean error {:.3}°, max {:.3}°, {} confident-but-wrong.\n",
        metrics.deskew.evaluated,
        metrics.deskew.mean_angle_error_degrees,
        metrics.deskew.max_angle_error_degrees,
        metrics.deskew.confident_but_wrong
    ));
    output.push_str(&format!(
        "- Content: {} truth fixtures, mean IoU {:.4}, minimum IoU {:.4}, {} lost-ink catastrophes ({} pixels outside detected boxes).\n",
        metrics.content.evaluated,
        metrics.content.mean_iou,
        metrics.content.minimum_iou,
        metrics.content.content_lost_outside_crop,
        metrics.content.lost_ink_pixels
    ));
    output.push_str(&format!(
        "- Despeckle: {}/{} annotated punctuation markers retained ({:.4}); {} erased pages.\n",
        metrics.despeckle.retained_punctuation_markers,
        metrics.despeckle.punctuation_markers,
        metrics.despeckle.retained_punctuation_rate,
        metrics.despeckle.erased_pages
    ));
    output.push_str(&format!(
        "- Binarization: broken-stroke delta {}, pepper density {:.6} ({} / {} blank-region pixels); routes {:?}.\n",
        metrics.binarization.broken_stroke_delta,
        metrics.binarization.pepper_density,
        metrics.binarization.pepper_pixels,
        metrics.binarization.blank_pixels_evaluated,
        metrics.binarization.route_counts
    ));
    output.push_str(&format!(
        "- Dewarp: curled residual {:.6} px → {:.6} px ({:.4} improvement; {}/{} models detected, {} non-improvements); {} catastrophic warps, {}/{} flat guards and {}/{} photo/sparse guards emitted a model.\n",
        metrics.dewarp.identity_mean_residual_px,
        metrics.dewarp.dewarped_mean_residual_px,
        metrics.dewarp.residual_improvement_fraction,
        metrics.dewarp.curled_models_detected,
        metrics.dewarp.curled_evaluated,
        metrics.dewarp.curled_non_improvements,
        metrics.dewarp.catastrophic_warps,
        metrics.dewarp.flat_guard_models,
        metrics.dewarp.flat_guard_evaluated,
        metrics.dewarp.photo_sparse_guard_models,
        metrics.dewarp.photo_sparse_guard_evaluated,
    ));

    output.push_str("\n## Metric definitions\n\n");
    output.push_str(
        "- A split is correct when the auto-layout classification equals fixture truth. Cutter error is absolute x error in pixels and as a fraction of source width.\n\
         - Deskew error is `abs(detected − annotated)`; confident-but-wrong means confidence ≥ 2.0 and error > 1°.\n\
         - Content IoU compares axis-aligned detected and generated truth boxes. A crop catastrophe means more than `max(4 pixels, 1% of truth ink)` lies outside the detected box.\n\
         - Despeckle runs directly on the annotated binary mask. Marker retention means ink remains within the annotation radius; an erased page has input ink and zero output ink.\n\
         - Binarization runs normalization + selected threshold + smoothing with despeckle disabled. Broken-stroke delta is `max(output components − truth components, 0)`. Pepper density is black output pixels divided by pixels in generated known-blank regions.\n\
         - Composed metrics independently sample the actual pipeline output pixels back onto the annotated source grid through each leaf forward transform. Erasure, punctuation loss and component explosions have a zero catastrophe budget; standalone stage metrics above retain their historical definitions. Non-affine geometry fails closed.\n\
         - Dewarp residual is mean absolute distance from each annotated baseline to its fitted straight line, measured in output-height pixels before and after the detected cylindrical mapping. Flat, photo, and sparse guards count any emitted automatic model as catastrophic; Jacobian failures use the same 17×17 grid as C2 validation.\n",
    );

    output.push_str("\n## Non-comparable performance\n\n");
    output.push_str(&format!(
        "Pipeline render wall time at a fixed {} Rayon thread: {:.3} ms total, {:.3} ms/page. Timing is intentionally outside the comparable JSON body.\n",
        performance.rayon_threads,
        performance.total_wall_time_ms,
        performance.mean_wall_time_ms_per_page
    ));
    output.push_str(&format!(
        "Automatic dewarp analysis: {:.3} ms total across {} analysis-scale pages, {:.3} ms/page.\n",
        performance.auto_dewarp.total_wall_time_ms,
        performance.auto_dewarp.pages,
        performance.auto_dewarp.mean_wall_time_ms_per_page,
    ));

    output.push_str("\n## Deferred hooks\n\n");
    output.push_str(&format!(
        "- OCR proxy: {}.\n- Dewarp truth inventory: {} curled fixture, {} annotated baselines.\n",
        comparable.stub_hooks.ocr_proxy,
        comparable.stub_hooks.curled_truth_fixtures,
        comparable.stub_hooks.curled_truth_baseline_count,
    ));
    output
}
