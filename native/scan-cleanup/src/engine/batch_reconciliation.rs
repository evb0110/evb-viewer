//! Cross-page classification reconciliation.
use crate::engine::page_statistics::{
    bucket_classification, classification_bucket, dimensions_within_tolerance, median, ramp_local,
    robust_typographic_median,
};
use crate::engine::page_workflow::PageResultMetadata;
use crate::split::LayoutClassification;
use serde::{Deserialize, Serialize};
/// A page's first-pass layout verdict, kept as provenance when reconciliation
/// analyzes the page again under the document prior.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Tier1Provenance {
    pub(crate) verdict: LayoutClassification,
    pub(crate) confidence: f64,
    pub(crate) candidate_cutter_ratio: Option<f64>,
    pub(crate) whitespace_score: f64,
}

pub(crate) struct ReconciliationPolicy {
    pub(crate) minimum_confidence: f64,
    pub(crate) minimum_support: usize,
}

/// The policy an analyze manifest reconciles its pages under.
pub(crate) const MANIFEST_RECONCILIATION_POLICY: ReconciliationPolicy = ReconciliationPolicy {
    minimum_confidence: 0.60,
    minimum_support: 2,
};

/// What document reconciliation reads from one analyzed page. The browser
/// engine returns it beside the page's metadata, which does not carry it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReconciliationCandidate {
    pub(crate) cutter_x: Option<f64>,
    pub(crate) tier1_verdict: LayoutClassification,
    pub(crate) tier1_confidence: f64,
    pub(crate) candidate_cutter_ratio: Option<f64>,
    pub(crate) whitespace_score: f64,
    pub(crate) rotated_width: usize,
    pub(crate) rotated_height: usize,
    pub(crate) calibration_stroke_width_px: Option<f64>,
    pub(crate) calibration_x_height_px: Option<f64>,
    pub(crate) reconciliation_eligible: bool,
    pub(crate) excluded: bool,
    pub(crate) document_prior: Option<crate::split::DocumentPrior>,
}

impl ReconciliationCandidate {
    pub(crate) fn of(metadata: &PageResultMetadata) -> Self {
        Self {
            cutter_x: metadata.cutter_x_px,
            tier1_verdict: metadata.tier1_verdict,
            tier1_confidence: metadata.tier1_confidence,
            candidate_cutter_ratio: metadata.candidate_cutter_ratio,
            whitespace_score: metadata.whitespace_score,
            rotated_width: metadata.rotated_width,
            rotated_height: metadata.rotated_height,
            calibration_stroke_width_px: metadata.calibration_stroke_width_px,
            calibration_x_height_px: metadata.calibration_x_height_px,
            reconciliation_eligible: metadata.reconciliation_eligible,
            excluded: metadata.excluded,
            document_prior: metadata.document_prior,
        }
    }

    /// Puts back the reconciliation inputs a page's metadata file does not
    /// carry, when this candidate was taken from that same analysis.
    #[cfg(any(
        test,
        all(
            target_family = "wasm",
            target_os = "unknown",
            feature = "wasm-exports"
        )
    ))]
    pub(crate) fn restore(self, metadata: &mut PageResultMetadata) -> Result<(), String> {
        let restored = Self {
            tier1_confidence: self.tier1_confidence,
            candidate_cutter_ratio: self.candidate_cutter_ratio,
            whitespace_score: self.whitespace_score,
            rotated_width: self.rotated_width,
            rotated_height: self.rotated_height,
            calibration_stroke_width_px: self.calibration_stroke_width_px,
            calibration_x_height_px: self.calibration_x_height_px,
            reconciliation_eligible: self.reconciliation_eligible,
            ..Self::of(metadata)
        };
        if restored != self {
            return Err("A reconciliation candidate does not belong to its page analysis".into());
        }
        metadata.tier1_confidence = self.tier1_confidence;
        metadata.candidate_cutter_ratio = self.candidate_cutter_ratio;
        metadata.whitespace_score = self.whitespace_score;
        metadata.rotated_width = self.rotated_width;
        metadata.rotated_height = self.rotated_height;
        metadata.calibration_stroke_width_px = self.calibration_stroke_width_px;
        metadata.calibration_x_height_px = self.calibration_x_height_px;
        metadata.reconciliation_eligible = self.reconciliation_eligible;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ReconciliationAction {
    pub(crate) index: usize,
    pub(crate) change: PageReconciliation,
}

/// How document reconciliation revises one analyzed page.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum PageReconciliation {
    /// Analyze the page again under the document prior; its first verdict
    /// stays as provenance.
    #[serde(rename_all = "camelCase")]
    Rerun {
        prior: crate::split::DocumentPrior,
        tier1: Tier1Provenance,
    },
    /// Take the document's layout decision without analyzing again.
    #[serde(rename_all = "camelCase")]
    Update {
        prior: crate::split::DocumentPrior,
        classification: LayoutClassification,
        confidence: f64,
        cutter_x: Option<f64>,
        tier1_verdict: LayoutClassification,
        reconciled: bool,
        cluster_agreement: f64,
        output_count: usize,
    },
}

impl PageReconciliation {
    /// Revises one page's analysis: the page's own for an update, the rerun
    /// under the prior for a rerun.
    pub(crate) fn apply(&self, metadata: &mut PageResultMetadata) {
        match *self {
            Self::Rerun { prior, tier1 } => {
                preserve_tier1_provenance_after_rerun(metadata, tier1, prior)
            }
            Self::Update {
                prior,
                classification,
                confidence,
                cutter_x,
                tier1_verdict,
                reconciled,
                cluster_agreement,
                output_count,
            } => {
                metadata.layout_classification = classification;
                metadata.layout_confidence = confidence;
                metadata.cutter_x_px = cutter_x;
                metadata.tier1_verdict = tier1_verdict;
                metadata.reconciled = reconciled;
                metadata.cluster_agreement = cluster_agreement;
                metadata.document_prior = Some(prior);
                metadata.output_count = output_count;
                if classification != LayoutClassification::TwoPageSpread {
                    metadata.split_seam = None;
                }
                if reconciled {
                    metadata.outputs.clear();
                }
            }
        }
    }
}

pub(crate) fn reconcile_classification_batch(
    results: &[ReconciliationCandidate],
    policy: ReconciliationPolicy,
) -> Vec<ReconciliationAction> {
    let mut actions = Vec::new();
    let eligible = results
        .iter()
        .enumerate()
        .filter(|(_, result)| result.reconciliation_eligible && result.document_prior.is_none())
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for index in eligible {
        let metadata = results[index];
        if let Some(cluster) = clusters.iter_mut().find(|cluster| {
            let representative = results[cluster[0]];
            dimensions_within_tolerance(metadata.rotated_width, representative.rotated_width)
                && dimensions_within_tolerance(
                    metadata.rotated_height,
                    representative.rotated_height,
                )
        }) {
            cluster.push(index);
        } else {
            clusters.push(vec![index]);
        }
    }

    for cluster in clusters {
        let confident = cluster
            .iter()
            .copied()
            .filter(|&index| results[index].tier1_confidence >= policy.minimum_confidence)
            .collect::<Vec<_>>();
        let mut support = [0usize; 3];
        let mut confidence_sum = [0.0_f64; 3];
        for &index in &confident {
            let metadata = results[index];
            let bucket = classification_bucket(metadata.tier1_verdict);
            support[bucket] += 1;
            confidence_sum[bucket] += metadata.tier1_confidence;
        }
        let Some(dominant_bucket) = (0..support.len())
            .filter(|&bucket| support[bucket] >= policy.minimum_support)
            .max_by(|&left, &right| {
                support[left]
                    .cmp(&support[right])
                    .then_with(|| confidence_sum[left].total_cmp(&confidence_sum[right]))
            })
        else {
            continue;
        };
        let tied = (0..support.len()).any(|bucket| {
            bucket != dominant_bucket
                && support[bucket] == support[dominant_bucket]
                && (confidence_sum[bucket] - confidence_sum[dominant_bucket]).abs() < 1e-9
        });
        if tied {
            continue;
        }
        let dominant_layout = bucket_classification(dominant_bucket);
        let dominant_count = support[dominant_bucket];
        let consensus = dominant_count as f64 / confident.len().max(1) as f64;
        let mean_confidence = confidence_sum[dominant_bucket] / dominant_count as f64;
        let mut cutter_ratios = confident
            .iter()
            .filter_map(|&index| {
                let metadata = results[index];
                // Layout analysis may use the 150 DPI working raster, but its
                // cutter is scaled back to the rotated input plane before it
                // reaches page metadata. `rotated_width` is that same plane,
                // so this ratio remains comparable across pages.
                (metadata.tier1_verdict == LayoutClassification::TwoPageSpread)
                    .then_some(metadata.cutter_x)
                    .flatten()
                    .map(|cutter| cutter / metadata.rotated_width.max(1) as f64)
            })
            .collect::<Vec<_>>();
        cutter_ratios.sort_by(f64::total_cmp);
        let cutter_ratio_median = (dominant_layout == LayoutClassification::TwoPageSpread)
            .then(|| median(&cutter_ratios))
            .flatten();
        if dominant_layout == LayoutClassification::TwoPageSpread && cutter_ratio_median.is_none() {
            continue;
        }
        let cutter_spread = cutter_ratios
            .first()
            .zip(cutter_ratios.last())
            .map_or(0.0, |(first, last)| last - first);
        let cutter_consistency = 1.0 - ramp_local(cutter_spread, 0.03, 0.12) * 0.40;
        let agreement_strength =
            (consensus * (0.65 + 0.25 * mean_confidence) * cutter_consistency).clamp(0.0, 0.95);
        let mut widths = cluster
            .iter()
            .map(|&index| results[index].rotated_width as f64)
            .collect::<Vec<_>>();
        let mut heights = cluster
            .iter()
            .map(|&index| results[index].rotated_height as f64)
            .collect::<Vec<_>>();
        widths.sort_by(f64::total_cmp);
        heights.sort_by(f64::total_cmp);
        let document_stroke_width_px = robust_typographic_median(
            cluster
                .iter()
                .filter_map(|&index| results[index].calibration_stroke_width_px),
        );
        let document_x_height_px = robust_typographic_median(
            cluster
                .iter()
                .filter_map(|&index| results[index].calibration_x_height_px),
        );
        let prior = crate::split::DocumentPrior {
            dominant_layout,
            cutter_ratio_median,
            cluster_dims: crate::split::ClusterDimensions {
                width: median(&widths).unwrap_or(1.0),
                height: median(&heights).unwrap_or(1.0),
            },
            agreement_strength,
            stroke_width_median_px: document_stroke_width_px,
            x_height_median_px: document_x_height_px,
        };
        if prior.validate().is_err() {
            continue;
        }

        for index in cluster {
            let metadata = results[index];
            let rerun_with_prior = prior.dominant_layout == LayoutClassification::TwoPageSpread
                && metadata.tier1_confidence < policy.minimum_confidence;
            if rerun_with_prior {
                actions.push(ReconciliationAction {
                    index,
                    change: PageReconciliation::Rerun {
                        prior,
                        tier1: Tier1Provenance {
                            verdict: metadata.tier1_verdict,
                            confidence: metadata.tier1_confidence,
                            candidate_cutter_ratio: metadata.candidate_cutter_ratio,
                            whitespace_score: metadata.whitespace_score,
                        },
                    },
                });
                continue;
            }

            let tier1_cutter = (metadata.tier1_verdict == LayoutClassification::TwoPageSpread)
                .then_some(metadata.cutter_x)
                .flatten();
            let decision = crate::split::reconcile_layout_decision(
                metadata.tier1_verdict,
                metadata.tier1_confidence,
                tier1_cutter,
                metadata.candidate_cutter_ratio,
                metadata.whitespace_score,
                metadata.rotated_width,
                metadata.rotated_height,
                prior,
                policy.minimum_confidence,
            );
            actions.push(ReconciliationAction {
                index,
                change: PageReconciliation::Update {
                    prior,
                    classification: decision.classification,
                    confidence: decision.confidence,
                    cutter_x: decision.cutter_x,
                    tier1_verdict: decision.reconciliation.tier1_verdict,
                    reconciled: decision.reconciliation.reconciled,
                    cluster_agreement: decision.reconciliation.cluster_agreement,
                    output_count: if metadata.excluded {
                        0
                    } else if decision.classification == LayoutClassification::TwoPageSpread {
                        2
                    } else {
                        1
                    },
                },
            });
        }
    }
    actions
}

pub(crate) fn preserve_tier1_provenance_after_rerun(
    metadata: &mut PageResultMetadata,
    tier1: crate::engine::batch_reconciliation::Tier1Provenance,
    prior: crate::split::DocumentPrior,
) {
    metadata.tier1_verdict = tier1.verdict;
    metadata.tier1_confidence = tier1.confidence;
    metadata.candidate_cutter_ratio = tier1.candidate_cutter_ratio;
    metadata.whitespace_score = tier1.whitespace_score;
    metadata.reconciled = metadata.layout_classification != tier1.verdict;
    metadata.cluster_agreement = if metadata.layout_classification == prior.dominant_layout {
        prior.agreement_strength
    } else {
        -prior.agreement_strength
    };
    metadata.document_prior = Some(prior);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::split::LayoutClassification;
    fn candidate(
        verdict: LayoutClassification,
        confidence: f64,
        cutter_x: Option<f64>,
        candidate_cutter_ratio: Option<f64>,
    ) -> ReconciliationCandidate {
        ReconciliationCandidate {
            cutter_x,
            tier1_verdict: verdict,
            tier1_confidence: confidence,
            candidate_cutter_ratio,
            whitespace_score: 0.9,
            rotated_width: 240,
            rotated_height: 200,
            calibration_stroke_width_px: None,
            calibration_x_height_px: None,
            reconciliation_eligible: true,
            excluded: false,
            document_prior: None,
        }
    }

    #[test]
    fn batch_policy_threshold_preserves_confident_minority_layouts() {
        for threshold in [0.60, 0.90] {
            for (majority, minority, cutter) in [
                (
                    LayoutClassification::SingleUncutPage,
                    LayoutClassification::TwoPageSpread,
                    Some(120.0),
                ),
                (
                    LayoutClassification::TwoPageSpread,
                    LayoutClassification::SingleUncutPage,
                    None,
                ),
            ] {
                for confidence in [threshold - 0.01, threshold] {
                    let majority_cutter =
                        (majority == LayoutClassification::TwoPageSpread).then_some(120.0);
                    let candidates = [
                        candidate(majority, 1.0, majority_cutter, Some(0.5)),
                        candidate(majority, 1.0, majority_cutter, Some(0.5)),
                        candidate(minority, confidence, cutter, Some(0.5)),
                    ];
                    let actions = reconcile_classification_batch(
                        &candidates,
                        ReconciliationPolicy {
                            minimum_confidence: threshold,
                            minimum_support: 2,
                        },
                    );
                    let change = actions
                        .iter()
                        .find(|action| action.index == 2)
                        .unwrap()
                        .change;
                    if confidence >= threshold {
                        match change {
                            PageReconciliation::Update {
                                classification,
                                cutter_x,
                                output_count,
                                reconciled,
                                ..
                            } => {
                                assert_eq!(classification, minority);
                                assert_eq!(cutter_x, cutter);
                                assert_eq!(output_count, usize::from(cutter.is_some()) + 1);
                                assert!(!reconciled);
                            }
                            PageReconciliation::Rerun { .. } => {
                                panic!("confident minority must not rerun")
                            }
                        }
                    } else if majority == LayoutClassification::TwoPageSpread {
                        assert!(matches!(change, PageReconciliation::Rerun { .. }));
                    } else {
                        assert!(matches!(
                            change,
                            PageReconciliation::Update {
                                classification: LayoutClassification::SingleUncutPage,
                                reconciled: true,
                                ..
                            }
                        ));
                    }
                }
            }
        }
    }

    #[test]
    fn pure_rerun_action_preserves_every_tier1_fact() {
        let candidates = vec![
            candidate(
                LayoutClassification::TwoPageSpread,
                0.92,
                Some(120.0),
                Some(0.5),
            ),
            candidate(
                LayoutClassification::TwoPageSpread,
                0.91,
                Some(120.0),
                Some(0.5),
            ),
            candidate(
                LayoutClassification::TwoPageSpread,
                0.90,
                Some(120.0),
                Some(0.5),
            ),
            candidate(LayoutClassification::SingleUncutPage, 0.40, None, Some(0.5)),
        ];
        let actions = super::reconcile_classification_batch(
            &candidates,
            ReconciliationPolicy {
                minimum_confidence: 0.60,
                minimum_support: 2,
            },
        );
        let rerun = actions
            .iter()
            .find_map(|action| match action.change {
                PageReconciliation::Rerun { prior, tier1 } => Some((action.index, prior, tier1)),
                PageReconciliation::Update { .. } => None,
            })
            .expect("the low-confidence candidate must be rerun");
        assert_eq!(rerun.0, 3);
        assert_eq!(rerun.1.dominant_layout, LayoutClassification::TwoPageSpread);
        assert_eq!(rerun.1.cutter_ratio_median, Some(0.5));
        assert_eq!(rerun.2.verdict, LayoutClassification::SingleUncutPage);
        assert_eq!(rerun.2.confidence, 0.40);
        assert_eq!(rerun.2.candidate_cutter_ratio, Some(0.5));
        assert_eq!(rerun.2.whitespace_score, 0.9);
    }

    #[test]
    fn pure_update_action_contains_publication_facts_without_wire_types() {
        let candidates = vec![
            candidate(
                LayoutClassification::TwoPageSpread,
                0.92,
                Some(120.0),
                Some(0.5),
            ),
            candidate(
                LayoutClassification::TwoPageSpread,
                0.91,
                Some(120.0),
                Some(0.5),
            ),
            candidate(
                LayoutClassification::TwoPageSpread,
                0.90,
                Some(120.0),
                Some(0.5),
            ),
        ];
        let actions = super::reconcile_classification_batch(
            &candidates,
            ReconciliationPolicy {
                minimum_confidence: 0.60,
                minimum_support: 2,
            },
        );
        let update = actions
            .iter()
            .find_map(|action| match action.change {
                PageReconciliation::Update {
                    prior,
                    classification,
                    confidence,
                    cutter_x,
                    tier1_verdict,
                    reconciled,
                    cluster_agreement,
                    output_count,
                } => Some((
                    action.index,
                    prior,
                    classification,
                    confidence,
                    cutter_x,
                    tier1_verdict,
                    reconciled,
                    cluster_agreement,
                    output_count,
                )),
                PageReconciliation::Rerun { .. } => None,
            })
            .expect("a consensus spread must emit an update");
        assert_eq!(update.0, 0);
        assert_eq!(
            update.1.dominant_layout,
            LayoutClassification::TwoPageSpread
        );
        assert_eq!(update.2, LayoutClassification::TwoPageSpread);
        assert_eq!(update.4, Some(120.0));
        assert_eq!(update.5, LayoutClassification::TwoPageSpread);
        assert!(!update.6);
        assert!(update.7 > 0.0);
        assert_eq!(update.8, 2);
    }

    #[test]
    fn invalid_cluster_prior_is_dropped_before_actions_are_built() {
        let mut candidates = vec![
            candidate(
                LayoutClassification::TwoPageSpread,
                0.92,
                Some(120.0),
                Some(0.5),
            ),
            candidate(
                LayoutClassification::TwoPageSpread,
                0.91,
                Some(120.0),
                Some(0.5),
            ),
            candidate(
                LayoutClassification::TwoPageSpread,
                0.90,
                Some(120.0),
                Some(0.5),
            ),
        ];
        for candidate in &mut candidates {
            candidate.rotated_width = 0;
            candidate.rotated_height = 0;
        }

        assert!(reconcile_classification_batch(
            &candidates,
            ReconciliationPolicy {
                minimum_confidence: 0.60,
                minimum_support: 2,
            },
        )
        .is_empty());
    }
}
