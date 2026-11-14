use super::*;
use crate::protocol::manifest_v3::CanvasScope;
use crate::split::SplitDiagnostics;
use crate::OrthogonalRotation;

fn metadata(index: usize, layout: LayoutClassification, confidence: f64) -> PageResultMetadata {
    let spread = layout == LayoutClassification::TwoPageSpread;
    PageResultMetadata {
        version: crate::protocol::manifest_v3::VERSION,
        source_page_index: index,
        layout_classification: layout,
        layout_confidence: confidence,
        cutter_x_px: spread.then_some(120.0),
        split_seam: None,
        rotation_degrees: OrthogonalRotation::None,
        canvas_scope: CanvasScope::default(),
        excluded: false,
        blank_outputs_skipped: 0,
        output_count: usize::from(spread) + 1,
        outputs: Vec::new(),
        tier1_verdict: layout,
        reconciled: false,
        cluster_agreement: 0.0,
        split_diagnostics: SplitDiagnostics::default(),
        document_prior: None,
        text_axis: None,
        recommended_output_mode: None,
        recommended_output_mode_confidence: None,
        recommended_output_mode_reason: None,
        soft_alpha_foreground_recommendation: None,
        output_mode_diagnostics: None,
        alternate_view: false,
        rotated_width: 240,
        rotated_height: 200,
        candidate_cutter_ratio: Some(0.5),
        whitespace_score: 0.9,
        reconciliation_eligible: true,
        tier1_confidence: confidence,
        calibration_stroke_width_px: None,
        calibration_x_height_px: None,
    }
}

/// A spread every split gate accepted, cut near the middle of its plane.
fn proven_spread(index: usize) -> PageResultMetadata {
    let mut spread = metadata(index, LayoutClassification::TwoPageSpread, 0.9);
    let diagnostics = &mut spread.split_diagnostics;
    diagnostics.independent_spread_cues = 4;
    diagnostics.central_position_gate_passed = true;
    diagnostics.bilateral_gate_passed = true;
    diagnostics.aspect_support_gate_passed = true;
    diagnostics.evidence_agreement_gate_passed = true;
    diagnostics.decision_x = 121.0;
    spread
}

fn plain_page() -> AnalysisPage<'static> {
    AnalysisPage {
        document_prior: None,
        alternate_view: None,
        placement: None,
    }
}

fn document(pages: Vec<AnalysisPage<'_>>) -> AnalysisDocument<'_> {
    AnalysisDocument {
        pages,
        document_canvas: None,
        preview: true,
    }
}

/// A portrait CropBox inside a landscape MediaBox: a geometry-only candidate.
fn portrait_crop_of_landscape_sheet() -> AlternateView {
    AlternateView {
        primary_width_points: 300.0,
        primary_height_points: 420.0,
        width_points: 600.0,
        height_points: 420.0,
        options: CleanupOptions::default(),
    }
}

fn analyzed(job: AnalysisJob, metadata: PageResultMetadata) -> PageAnalysis {
    PageAnalysis {
        job,
        metadata: Some(metadata),
    }
}

fn jobs(step: AnalysisStep) -> Vec<AnalysisJob> {
    match step {
        AnalysisStep::Analyze(jobs) => jobs,
        AnalysisStep::Finished(_) => panic!("the plan finished early"),
    }
}

fn finished(step: AnalysisStep) -> Vec<PageResultMetadata> {
    match step {
        AnalysisStep::Finished(pages) => pages,
        AnalysisStep::Analyze(jobs) => panic!("the plan still asks for {jobs:?}"),
    }
}

#[test]
fn every_page_is_analyzed_on_its_primary_view_first() {
    let document = document(vec![plain_page(), plain_page(), plain_page()]);
    let first = jobs(next_analysis_step(&document, &[]).unwrap());
    assert_eq!(
        first
            .iter()
            .map(|job| (job.index, job.view, job.rerun))
            .collect::<Vec<_>>(),
        (0..3)
            .map(|index| (index, AnalysisView::Primary, false))
            .collect::<Vec<_>>(),
    );
    let analyses = first
        .into_iter()
        .map(|job| {
            analyzed(
                job,
                metadata(job.index, LayoutClassification::SingleUncutPage, 0.9),
            )
        })
        .collect::<Vec<_>>();
    let pages = finished(next_analysis_step(&document, &analyses).unwrap());
    assert_eq!(pages.len(), 3);
    assert!(pages.iter().all(|page| !page.alternate_view));
}

#[test]
fn a_doubtful_minority_page_is_rerun_under_the_prior_and_keeps_its_first_verdict() {
    let document = document((0..4).map(|_| plain_page()).collect());
    let mut analyses = jobs(next_analysis_step(&document, &[]).unwrap())
        .into_iter()
        .map(|job| {
            let page = if job.index == 3 {
                metadata(3, LayoutClassification::SingleUncutPage, 0.4)
            } else {
                metadata(job.index, LayoutClassification::TwoPageSpread, 0.92)
            };
            analyzed(job, page)
        })
        .collect::<Vec<_>>();
    let reruns = jobs(next_analysis_step(&document, &analyses).unwrap());
    assert_eq!(reruns.len(), 1);
    let rerun = reruns[0];
    assert_eq!(
        (rerun.index, rerun.view, rerun.rerun),
        (3, AnalysisView::Primary, true)
    );
    let prior = rerun
        .document_prior
        .expect("a rerun carries the document prior");
    assert_eq!(prior.dominant_layout, LayoutClassification::TwoPageSpread);
    analyses.push(analyzed(
        rerun,
        metadata(3, LayoutClassification::TwoPageSpread, 0.9),
    ));
    let pages = finished(next_analysis_step(&document, &analyses).unwrap());
    let page = &pages[3];
    assert_eq!(
        page.layout_classification,
        LayoutClassification::TwoPageSpread
    );
    assert_eq!(page.tier1_verdict, LayoutClassification::SingleUncutPage);
    assert_eq!(page.tier1_confidence, 0.4);
    assert!(page.reconciled);
    assert_eq!(page.document_prior, Some(prior));
}

#[test]
fn a_rerun_under_another_prior_is_refused() {
    let document = document((0..4).map(|_| plain_page()).collect());
    let mut analyses = jobs(next_analysis_step(&document, &[]).unwrap())
        .into_iter()
        .map(|job| {
            let layout = if job.index == 3 {
                LayoutClassification::SingleUncutPage
            } else {
                LayoutClassification::TwoPageSpread
            };
            analyzed(
                job,
                metadata(job.index, layout, if job.index == 3 { 0.4 } else { 0.92 }),
            )
        })
        .collect::<Vec<_>>();
    let mut rerun = jobs(next_analysis_step(&document, &analyses).unwrap())[0];
    rerun.document_prior = None;
    analyses.push(analyzed(
        rerun,
        metadata(3, LayoutClassification::TwoPageSpread, 0.9),
    ));
    let error = next_analysis_step(&document, &analyses).err().unwrap();
    assert!(
        error.message.contains("does not belong"),
        "{}",
        error.message
    );
}

#[test]
fn a_portrait_crop_of_a_landscape_sheet_is_analyzed_wide_and_kept_only_when_it_proves_a_spread() {
    let view = portrait_crop_of_landscape_sheet();
    let document = document(vec![AnalysisPage {
        document_prior: None,
        alternate_view: Some(&view),
        placement: None,
    }]);
    let primary = jobs(next_analysis_step(&document, &[]).unwrap())[0];
    let analyses = vec![analyzed(
        primary,
        metadata(0, LayoutClassification::SingleUncutPage, 0.8),
    )];
    let alternate = jobs(next_analysis_step(&document, &analyses).unwrap());
    assert_eq!(alternate.len(), 1);
    assert_eq!(
        (
            alternate[0].view,
            alternate[0].rerun,
            alternate[0].document_prior
        ),
        (AnalysisView::Alternate, false, None)
    );

    let mut weak = proven_spread(0);
    weak.split_diagnostics.bilateral_gate_passed = false;
    let mut with_weak = analyses.clone();
    with_weak.push(analyzed(alternate[0], weak));
    let kept = finished(next_analysis_step(&document, &with_weak).unwrap());
    assert_eq!(
        kept[0].layout_classification,
        LayoutClassification::SingleUncutPage
    );
    assert!(!kept[0].alternate_view);

    let mut off_center = proven_spread(0);
    off_center.cutter_x_px = Some(20.0);
    let mut with_off_center = analyses.clone();
    with_off_center.push(analyzed(alternate[0], off_center));
    let kept = finished(next_analysis_step(&document, &with_off_center).unwrap());
    assert!(!kept[0].alternate_view);

    let mut with_proof = analyses.clone();
    with_proof.push(analyzed(alternate[0], proven_spread(0)));
    let accepted = finished(next_analysis_step(&document, &with_proof).unwrap());
    assert_eq!(
        accepted[0].layout_classification,
        LayoutClassification::TwoPageSpread
    );
    assert!(accepted[0].alternate_view);

    let mut declined = analyses.clone();
    declined.push(PageAnalysis {
        job: alternate[0],
        metadata: None,
    });
    let kept = finished(next_analysis_step(&document, &declined).unwrap());
    assert_eq!(
        kept[0].layout_classification,
        LayoutClassification::SingleUncutPage
    );
    assert!(!kept[0].alternate_view);
}

#[test]
fn an_undersized_crop_alone_never_starts_an_alternate_analysis() {
    let view = AlternateView {
        primary_width_points: 300.0,
        primary_height_points: 400.0,
        width_points: 600.0,
        height_points: 800.0,
        options: CleanupOptions::default(),
    };
    let document = document(vec![AnalysisPage {
        document_prior: None,
        alternate_view: Some(&view),
        placement: None,
    }]);
    let primary = jobs(next_analysis_step(&document, &[]).unwrap())[0];
    let single = metadata(0, LayoutClassification::SingleUncutPage, 0.8);
    let pages =
        finished(next_analysis_step(&document, &[analyzed(primary, single.clone())]).unwrap());
    assert!(!pages[0].alternate_view);

    // Spread evidence the first pass overruled does start one.
    let mut evidence = single;
    evidence.split_diagnostics.aspect_spread_score = 0.8;
    evidence.split_diagnostics.independent_spread_cues = 3;
    let step = next_analysis_step(&document, &[analyzed(primary, evidence)]).unwrap();
    assert_eq!(jobs(step)[0].view, AnalysisView::Alternate);
}

#[test]
fn a_batch_analyzes_a_bounded_number_of_alternate_views() {
    let view = portrait_crop_of_landscape_sheet();
    let pages = (0..MAX_ALTERNATE_VIEW_PAGES + 4)
        .map(|_| AnalysisPage {
            document_prior: None,
            alternate_view: Some(&view),
            placement: None,
        })
        .collect();
    let document = document(pages);
    let analyses = jobs(next_analysis_step(&document, &[]).unwrap())
        .into_iter()
        .map(|job| {
            analyzed(
                job,
                metadata(job.index, LayoutClassification::SingleUncutPage, 0.8),
            )
        })
        .collect::<Vec<_>>();
    let alternates = jobs(next_analysis_step(&document, &analyses).unwrap());
    assert_eq!(
        alternates.iter().map(|job| job.index).collect::<Vec<_>>(),
        (0..MAX_ALTERNATE_VIEW_PAGES).collect::<Vec<_>>()
    );
}
