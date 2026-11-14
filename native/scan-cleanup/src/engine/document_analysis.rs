//! The document-level sequence of an analysis, shared by the CLI's analyze
//! manifests and the browser engine.
//!
//! [`next_analysis_step`] is a pure function of the document and of the page
//! analyses its host has run so far. It names the analyses still missing, or,
//! once none are, returns every page's finished metadata. A host therefore
//! drives a whole document by alternating the two: supply the rasters of the
//! jobs it is given, record what the engine returned, ask again. The host keeps
//! no decision of its own and the engine keeps no state between calls, so a
//! run survives a restarted engine and holds no raster longer than one job.
//!
//! The sequence: every page's primary view; document reconciliation and the
//! reruns it asks for; then, for single pages whose primary view may hide a
//! spread, an analysis of their wider alternate view (the PDF MediaBox),
//! reconciled among themselves and accepted only on strong local evidence;
//! finally each page's PDF placement.

use crate::engine::batch_reconciliation::{
    reconcile_classification_batch, PageReconciliation, ReconciliationCandidate,
    MANIFEST_RECONCILIATION_POLICY,
};
use crate::engine::lossless_placement::{plan_lossless_page, PdfPageGeometry};
use crate::engine::page_workflow::PageResultMetadata;
use crate::protocol::manifest_v3::DocumentCanvas;
use crate::split::{DocumentPrior, LayoutClassification};
use crate::CleanupOptions;
use evb_native_support::{NativeError, NativeErrorCode};
use serde::{Deserialize, Serialize};

/// Alternate views one document batch may analyze.
pub(crate) const MAX_ALTERNATE_VIEW_PAGES: usize = 16;
/// A side this much longer than the other makes a view landscape or portrait.
const ORIENTATION_RATIO: f64 = 1.1;
/// A primary view this much smaller than the alternate hides part of the sheet.
const MATERIAL_AREA_RATIO: f64 = 0.8;
/// Spread evidence that justifies analyzing an alternate view.
const ALTERNATE_ASPECT_SPREAD_SCORE: f64 = 0.75;
const ALTERNATE_SPREAD_CUES: usize = 3;
/// What an alternate analysis must show before it replaces the primary one.
const ALTERNATE_MIN_CONFIDENCE: f64 = 0.75;
const ALTERNATE_CENTRAL_BAND: (f64, f64) = (0.15, 0.85);

/// A wider view of the page than the one its primary analysis reads: the PDF
/// MediaBox around a CropBox. Sizes are in PDF points.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlternateView {
    pub primary_width_points: f64,
    pub primary_height_points: f64,
    pub width_points: f64,
    pub height_points: f64,
    /// The options the alternate raster is analyzed with, at its resolution.
    pub options: CleanupOptions,
}

impl AlternateView {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let sides = [
            self.primary_width_points,
            self.primary_height_points,
            self.width_points,
            self.height_points,
        ];
        if sides.iter().all(|side| side.is_finite() && *side > 0.0) {
            Ok(())
        } else {
            Err("An alternate view needs finite positive sizes".to_string())
        }
    }

    /// Whether this single page's primary analysis suggests the wider view
    /// holds a spread. Area alone never qualifies, since an undersized CropBox
    /// is common in hand-authored PDFs; a portrait crop of a landscape sheet is
    /// the one geometry-only case.
    fn worth_analyzing(&self, primary: &PageResultMetadata) -> bool {
        let primary_area = self.primary_width_points * self.primary_height_points;
        let area = self.width_points * self.height_points;
        if primary.layout_classification != LayoutClassification::SingleUncutPage
            || primary_area / area >= MATERIAL_AREA_RATIO
        {
            return false;
        }
        let orientation_mismatch = self.primary_height_points
            >= self.primary_width_points * ORIENTATION_RATIO
            && self.width_points >= self.height_points * ORIENTATION_RATIO;
        let diagnostics = &primary.split_diagnostics;
        orientation_mismatch
            || primary.tier1_verdict == LayoutClassification::TwoPageSpread
            || (diagnostics.aspect_spread_score >= ALTERNATE_ASPECT_SPREAD_SCORE
                && diagnostics.independent_spread_cues >= ALTERNATE_SPREAD_CUES)
    }
}

/// An alternate analysis replaces the primary one only when it proves a
/// spread locally: every split gate passed, and a cutter and decision line
/// well inside the analyzed plane.
fn proves_spread(alternate: &PageResultMetadata) -> bool {
    let diagnostics = &alternate.split_diagnostics;
    let width = alternate.rotated_width as f64;
    let (low, high) = ALTERNATE_CENTRAL_BAND;
    let central = |x: f64| x.is_finite() && x > width * low && x < width * high;
    alternate.tier1_verdict == LayoutClassification::TwoPageSpread
        && alternate.layout_classification == LayoutClassification::TwoPageSpread
        && alternate.layout_confidence >= ALTERNATE_MIN_CONFIDENCE
        && !diagnostics.abstained
        && diagnostics.independent_spread_cues >= ALTERNATE_SPREAD_CUES
        && diagnostics.central_position_gate_passed
        && diagnostics.bilateral_gate_passed
        && diagnostics.aspect_support_gate_passed
        && diagnostics.evidence_agreement_gate_passed
        && alternate.rotated_width > 0
        && alternate.rotated_height > 0
        && alternate.cutter_x_px.is_some_and(central)
        && central(diagnostics.decision_x)
}

/// Which raster of the page a job reads.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AnalysisView {
    Primary,
    Alternate,
}

/// One page analysis the engine needs next.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisJob {
    /// The page's position in the document.
    pub(crate) index: usize,
    pub(crate) view: AnalysisView,
    /// Whether this analyzes the view again under the prior reconciliation chose.
    pub(crate) rerun: bool,
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable))]
    pub(crate) document_prior: Option<DocumentPrior>,
}

/// A job's result: its page metadata, or none where the host could not supply
/// an alternate raster, which keeps the primary analysis.
#[derive(Clone)]
pub(crate) struct PageAnalysis {
    pub(crate) job: AnalysisJob,
    pub(crate) metadata: Option<PageResultMetadata>,
}

/// One page of the document, as its analysis sequence reads it.
pub(crate) struct AnalysisPage<'a> {
    pub(crate) document_prior: Option<DocumentPrior>,
    pub(crate) alternate_view: Option<&'a AlternateView>,
    /// The PDF page the finished analysis is placed on, with the page's options.
    pub(crate) placement: Option<(&'a PdfPageGeometry, &'a CleanupOptions)>,
}

pub(crate) struct AnalysisDocument<'a> {
    pub(crate) pages: Vec<AnalysisPage<'a>>,
    pub(crate) document_canvas: Option<DocumentCanvas>,
    pub(crate) preview: bool,
}

pub(crate) enum AnalysisStep {
    /// Run these jobs, in any order, and ask again.
    Analyze(Vec<AnalysisJob>),
    /// Every page's finished metadata, in document order.
    Finished(Vec<PageResultMetadata>),
}

fn invalid(message: impl Into<String>) -> NativeError {
    NativeError::new(NativeErrorCode::InvalidRequest, message)
}

/// Finds the recorded analysis of one job.
fn recorded(
    analyses: &[PageAnalysis],
    index: usize,
    view: AnalysisView,
    rerun: bool,
) -> Option<&PageAnalysis> {
    analyses.iter().find(|analysis| {
        analysis.job.index == index && analysis.job.view == view && analysis.job.rerun == rerun
    })
}

/// One pass over a set of pages in one view: their first analyses, the
/// reconciliation among them, and the reruns it asks for.
enum Pass {
    Missing(Vec<AnalysisJob>),
    /// Each page's reconciled metadata, by position in the pass.
    Done(Vec<Option<PageResultMetadata>>),
}

fn run_pass(
    analyses: &[PageAnalysis],
    pages: &[(usize, Option<DocumentPrior>)],
    view: AnalysisView,
) -> Result<Pass, NativeError> {
    let mut missing = Vec::new();
    let mut first = Vec::with_capacity(pages.len());
    for &(index, document_prior) in pages {
        match recorded(analyses, index, view, false) {
            Some(analysis) => first.push(analysis),
            None => missing.push(AnalysisJob {
                index,
                view,
                rerun: false,
                document_prior,
            }),
        }
    }
    if !missing.is_empty() {
        return Ok(Pass::Missing(missing));
    }
    // A declined alternate takes no part in its pass.
    let analyzed = first
        .iter()
        .enumerate()
        .filter_map(|(position, analysis)| Some((position, analysis.metadata.as_ref()?)))
        .collect::<Vec<_>>();
    if view == AnalysisView::Primary && analyzed.len() != first.len() {
        return Err(invalid("A primary page analysis has no metadata"));
    }
    let candidates = analyzed
        .iter()
        .map(|(_, metadata)| ReconciliationCandidate::of(metadata))
        .collect::<Vec<_>>();
    let actions = reconcile_classification_batch(&candidates, MANIFEST_RECONCILIATION_POLICY);
    let mut changes = vec![None; first.len()];
    for action in actions {
        let (position, _) = analyzed[action.index];
        let index = first[position].job.index;
        let analysis = match action.change {
            PageReconciliation::Rerun { prior, .. } => {
                match recorded(analyses, index, view, true) {
                    Some(rerun) if rerun.job.document_prior == Some(prior) => rerun,
                    Some(_) => {
                        return Err(invalid(
                            "A rerun analysis does not belong to its reconciliation",
                        ))
                    }
                    None => {
                        missing.push(AnalysisJob {
                            index,
                            view,
                            rerun: true,
                            document_prior: Some(prior),
                        });
                        continue;
                    }
                }
            }
            PageReconciliation::Update { .. } => first[position],
        };
        changes[position] = Some((analysis, action.change));
    }
    if !missing.is_empty() {
        return Ok(Pass::Missing(missing));
    }
    Ok(Pass::Done(
        first
            .iter()
            .zip(changes)
            .map(|(analysis, change)| {
                let (analysis, change) = match change {
                    Some((analysis, change)) => (analysis, Some(change)),
                    None => (*analysis, None),
                };
                let mut metadata = analysis.metadata.clone()?;
                if let Some(change) = change {
                    change.apply(&mut metadata);
                }
                Some(metadata)
            })
            .collect(),
    ))
}

/// The jobs a document still needs, or its finished pages.
pub(crate) fn next_analysis_step(
    document: &AnalysisDocument<'_>,
    analyses: &[PageAnalysis],
) -> Result<AnalysisStep, NativeError> {
    if let Some(analysis) = analyses
        .iter()
        .find(|analysis| analysis.job.index >= document.pages.len())
    {
        return Err(invalid(format!(
            "Page analysis {} is outside the document",
            analysis.job.index
        )));
    }
    let primary_pages = document
        .pages
        .iter()
        .enumerate()
        .map(|(index, page)| (index, page.document_prior))
        .collect::<Vec<_>>();
    let mut finished = match run_pass(analyses, &primary_pages, AnalysisView::Primary)? {
        Pass::Missing(jobs) => return Ok(AnalysisStep::Analyze(jobs)),
        Pass::Done(pages) => pages
            .into_iter()
            .map(|metadata| metadata.expect("a primary pass analyzes every page"))
            .collect::<Vec<_>>(),
    };
    let alternate_pages = finished
        .iter()
        .enumerate()
        .filter(|(index, metadata)| {
            document.pages[*index]
                .alternate_view
                .is_some_and(|view| view.worth_analyzing(metadata))
        })
        .map(|(index, _)| (index, None))
        .take(MAX_ALTERNATE_VIEW_PAGES)
        .collect::<Vec<_>>();
    if !alternate_pages.is_empty() {
        match run_pass(analyses, &alternate_pages, AnalysisView::Alternate)? {
            Pass::Missing(jobs) => return Ok(AnalysisStep::Analyze(jobs)),
            Pass::Done(alternates) => {
                for (&(index, _), alternate) in alternate_pages.iter().zip(alternates) {
                    if let Some(mut alternate) = alternate.filter(proves_spread) {
                        alternate.alternate_view = true;
                        finished[index] = alternate;
                    }
                }
            }
        }
    }
    for (metadata, page) in finished.iter_mut().zip(&document.pages) {
        if let Some((pdf_page, options)) = page.placement {
            plan_lossless_page(
                &mut metadata.outputs,
                pdf_page,
                metadata.rotation_degrees,
                options,
                document.document_canvas,
                document.preview,
            );
        }
    }
    Ok(AnalysisStep::Finished(finished))
}

#[cfg(test)]
#[path = "document_analysis_tests.rs"]
mod tests;
