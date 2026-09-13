use crate::{
    engine::text_axis::TextAxisHint,
    mode_select::{OutputModeDiagnostics, OutputModeRecommendationReason},
    protocol::manifest_v3::VERSION,
    split::{DocumentPrior, LayoutClassification},
    OutputMode,
};
use serde::Serialize;
use std::ops::AddAssign;
use std::path::PathBuf;

fn serialize_output_paths<S>(paths: &Option<Vec<PathBuf>>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    paths
        .as_ref()
        .map(|paths| {
            paths
                .iter()
                .map(|path| path.to_string_lossy())
                .collect::<Vec<_>>()
        })
        .serialize(serializer)
}

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageStageTimings {
    #[serde(default, skip_serializing_if = "is_zero")]
    pub decode_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub analysis_level_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub normalization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub illumination_preparation_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub layout_normalization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub calibration_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub picture_mask_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub mode_recommendation_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub quality_normalization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub text_axis_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub split_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub deskew_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub content_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rasterization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub mask_rasterization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub binarization_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub threshold_preparation_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub thresholding_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub binary_postprocess_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub mixed_composition_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub output_processing_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub render_ms: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub write_ms: f64,
}

impl PageStageTimings {
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Single owner for timing accumulation. The exhaustive destructuring without
/// `..` is the guard: a new timing field stops compiling here until its
/// accumulation is chosen explicitly.
impl AddAssign for PageStageTimings {
    fn add_assign(&mut self, other: Self) {
        let Self {
            decode_ms,
            analysis_level_ms,
            normalization_ms,
            illumination_preparation_ms,
            layout_normalization_ms,
            calibration_ms,
            picture_mask_ms,
            mode_recommendation_ms,
            quality_normalization_ms,
            text_axis_ms,
            split_ms,
            deskew_ms,
            content_ms,
            rasterization_ms,
            mask_rasterization_ms,
            binarization_ms,
            threshold_preparation_ms,
            thresholding_ms,
            binary_postprocess_ms,
            mixed_composition_ms,
            output_processing_ms,
            render_ms,
            write_ms,
        } = other;
        self.decode_ms += decode_ms;
        self.analysis_level_ms += analysis_level_ms;
        self.normalization_ms += normalization_ms;
        self.illumination_preparation_ms += illumination_preparation_ms;
        self.layout_normalization_ms += layout_normalization_ms;
        self.calibration_ms += calibration_ms;
        self.picture_mask_ms += picture_mask_ms;
        self.mode_recommendation_ms += mode_recommendation_ms;
        self.quality_normalization_ms += quality_normalization_ms;
        self.text_axis_ms += text_axis_ms;
        self.split_ms += split_ms;
        self.deskew_ms += deskew_ms;
        self.content_ms += content_ms;
        self.rasterization_ms += rasterization_ms;
        self.mask_rasterization_ms += mask_rasterization_ms;
        self.binarization_ms += binarization_ms;
        self.threshold_preparation_ms += threshold_preparation_ms;
        self.thresholding_ms += thresholding_ms;
        self.binary_postprocess_ms += binary_postprocess_ms;
        self.mixed_composition_ms += mixed_composition_ms;
        self.output_processing_ms += output_processing_ms;
        self.render_ms += render_ms;
        self.write_ms += write_ms;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProgressStage {
    Started,
    PageAnalyzed,
    PageComplete,
    /// The sidecar is about to read a staged page input that is not on disk
    /// yet. Only manifests that declare `stagedInputWindow` can emit this: the
    /// owning process replies by re-rendering that page's replayable raster to
    /// the manifest path.
    PageInputRequired,
    /// The sidecar has finished every read of a staged page input. The owning
    /// process may drop it; asking for it again is a re-render, never a
    /// different raster.
    PageInputReleased,
    Completed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: ProgressStage,
    pub completed_pages: usize,
    pub total_pages: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_number: Option<usize>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_output_paths"
    )]
    pub output_paths: Option<Vec<PathBuf>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classification: Option<LayoutClassification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cutter_x_px: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier1_verdict: Option<LayoutClassification>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconciled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_agreement: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_prior: Option<DocumentPrior>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_axis: Option<TextAxisHint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_timings: Option<PageStageTimings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_output_mode: Option<OutputMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_output_mode_confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_output_mode_reason: Option<OutputModeRecommendationReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soft_alpha_foreground_recommendation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_mode_diagnostics: Option<OutputModeDiagnostics>,
}

impl Progress {
    /// A staged-input lease frame. It carries page identity only: leases are a
    /// transport concern and must never restate a classification a later
    /// page-analyzed or page-complete frame owns.
    pub fn page_input(stage: ProgressStage, page_number: usize, total_pages: usize) -> Self {
        Self {
            stage,
            completed_pages: 0,
            total_pages,
            page_number: Some(page_number),
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
        }
    }
}

#[derive(Serialize)]
pub struct ProgressEnvelope {
    pub version: u32,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub progress: Progress,
}

impl ProgressEnvelope {
    pub fn new(progress: Progress) -> Self {
        Self {
            version: VERSION,
            kind: "progress",
            progress,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_timings_are_additive_and_omit_default_fields() {
        assert_eq!(
            serde_json::to_value(PageStageTimings::default()).unwrap(),
            serde_json::json!({})
        );
        assert_eq!(
            serde_json::to_value(PageStageTimings {
                layout_normalization_ms: 12.5,
                ..PageStageTimings::default()
            })
            .unwrap(),
            serde_json::json!({"layoutNormalizationMs": 12.5})
        );
    }

    #[test]
    fn stage_timings_add_assign_sums_every_field() {
        let mut total = PageStageTimings {
            decode_ms: 1.5,
            analysis_level_ms: 2.5,
            normalization_ms: 3.5,
            illumination_preparation_ms: 4.5,
            layout_normalization_ms: 5.5,
            calibration_ms: 6.5,
            picture_mask_ms: 7.5,
            mode_recommendation_ms: 8.5,
            quality_normalization_ms: 9.5,
            text_axis_ms: 10.5,
            split_ms: 11.5,
            deskew_ms: 12.5,
            content_ms: 13.5,
            rasterization_ms: 14.5,
            mask_rasterization_ms: 15.5,
            binarization_ms: 16.5,
            threshold_preparation_ms: 17.5,
            thresholding_ms: 18.5,
            binary_postprocess_ms: 19.5,
            mixed_composition_ms: 20.5,
            output_processing_ms: 21.5,
            render_ms: 22.5,
            write_ms: 23.5,
        };
        let addend = PageStageTimings {
            decode_ms: 100.25,
            analysis_level_ms: 200.25,
            normalization_ms: 300.25,
            illumination_preparation_ms: 400.25,
            layout_normalization_ms: 500.25,
            calibration_ms: 600.25,
            picture_mask_ms: 700.25,
            mode_recommendation_ms: 800.25,
            quality_normalization_ms: 900.25,
            text_axis_ms: 1000.25,
            split_ms: 1100.25,
            deskew_ms: 1200.25,
            content_ms: 1300.25,
            rasterization_ms: 1400.25,
            mask_rasterization_ms: 1500.25,
            binarization_ms: 1600.25,
            threshold_preparation_ms: 1700.25,
            thresholding_ms: 1800.25,
            binary_postprocess_ms: 1900.25,
            mixed_composition_ms: 2000.25,
            output_processing_ms: 2100.25,
            render_ms: 2200.25,
            write_ms: 2300.25,
        };

        total += addend;

        assert_eq!(total.decode_ms, 101.75);
        assert_eq!(total.analysis_level_ms, 202.75);
        assert_eq!(total.normalization_ms, 303.75);
        assert_eq!(total.illumination_preparation_ms, 404.75);
        assert_eq!(total.layout_normalization_ms, 505.75);
        assert_eq!(total.calibration_ms, 606.75);
        assert_eq!(total.picture_mask_ms, 707.75);
        assert_eq!(total.mode_recommendation_ms, 808.75);
        assert_eq!(total.quality_normalization_ms, 909.75);
        assert_eq!(total.text_axis_ms, 1010.75);
        assert_eq!(total.split_ms, 1111.75);
        assert_eq!(total.deskew_ms, 1212.75);
        assert_eq!(total.content_ms, 1313.75);
        assert_eq!(total.rasterization_ms, 1414.75);
        assert_eq!(total.mask_rasterization_ms, 1515.75);
        assert_eq!(total.binarization_ms, 1616.75);
        assert_eq!(total.threshold_preparation_ms, 1717.75);
        assert_eq!(total.thresholding_ms, 1818.75);
        assert_eq!(total.binary_postprocess_ms, 1919.75);
        assert_eq!(total.mixed_composition_ms, 2020.75);
        assert_eq!(total.output_processing_ms, 2121.75);
        assert_eq!(total.render_ms, 2222.75);
        assert_eq!(total.write_ms, 2323.75);
        assert_eq!(
            serde_json::to_value(total)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            23,
            "every timing field must accumulate into a nonzero serialized value"
        );
    }

    #[test]
    fn analysis_progress_matches_shared_v3_golden() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/protocol/analysis-progress-v3.json");
        let expected: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
        let actual = serde_json::to_value(ProgressEnvelope::new(Progress {
            stage: ProgressStage::PageAnalyzed,
            completed_pages: 2,
            total_pages: 4,
            page_number: Some(3),
            output_paths: None,
            classification: Some(LayoutClassification::SingleUncutPage),
            confidence: Some(0.91),
            cutter_x_px: None,
            tier1_verdict: Some(LayoutClassification::SingleUncutPage),
            reconciled: Some(false),
            cluster_agreement: Some(0.0),
            document_prior: None,
            text_axis: None,
            stage_timings: None,
            recommended_output_mode: Some(OutputMode::Mixed),
            recommended_output_mode_confidence: Some(0.9),
            recommended_output_mode_reason: Some(OutputModeRecommendationReason::TextWithPictures),
            soft_alpha_foreground_recommendation: None,
            output_mode_diagnostics: None,
        }))
        .unwrap();

        assert_eq!(actual, expected);
    }

    /// The lease frames are transport: they carry page identity and nothing
    /// else, so a bounded staging window can never restate a classification a
    /// page-analyzed or page-complete frame owns.
    #[test]
    fn staged_input_lease_progress_matches_shared_v3_golden() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/protocol/staged-input-lease-progress-v3.json");
        let expected: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
        let actual = serde_json::to_value(ProgressEnvelope::new(Progress::page_input(
            ProgressStage::PageInputRequired,
            147,
            148,
        )))
        .unwrap();

        assert_eq!(actual, expected);
        let released = serde_json::to_value(ProgressEnvelope::new(Progress::page_input(
            ProgressStage::PageInputReleased,
            147,
            148,
        )))
        .unwrap();
        assert_eq!(released["progress"]["stage"], "page-input-released");
        assert_eq!(
            released["progress"].as_object().unwrap().len(),
            4,
            "a lease frame carries stage, page identity and totals only"
        );
    }

    #[test]
    fn page_complete_progress_matches_populated_shared_v3_golden() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/protocol/page-complete-progress-v3.json");
        let expected: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture).unwrap()).unwrap();
        let actual = serde_json::to_value(ProgressEnvelope::new(Progress {
            stage: ProgressStage::PageComplete,
            completed_pages: 2,
            total_pages: 4,
            page_number: Some(2),
            output_paths: Some(vec![
                PathBuf::from("/fixtures/output/page-2-left.png"),
                PathBuf::from("/fixtures/output/page-2-right.png"),
            ]),
            classification: Some(LayoutClassification::TwoPageSpread),
            confidence: Some(0.984),
            cutter_x_px: Some(1180.0),
            tier1_verdict: Some(LayoutClassification::SingleUncutPage),
            reconciled: Some(true),
            cluster_agreement: Some(0.885),
            document_prior: Some(DocumentPrior {
                dominant_layout: LayoutClassification::TwoPageSpread,
                cutter_ratio_median: Some(0.535),
                cluster_dims: crate::split::ClusterDimensions {
                    width: 2203.0,
                    height: 1600.0,
                },
                agreement_strength: 0.885,
                stroke_width_median_px: None,
                x_height_median_px: None,
            }),
            text_axis: Some(TextAxisHint {
                sideways: true,
                confidence: 0.97,
            }),
            stage_timings: Some(PageStageTimings {
                split_ms: 12.5,
                render_ms: 24.0,
                ..PageStageTimings::default()
            }),
            recommended_output_mode: Some(OutputMode::Mixed),
            recommended_output_mode_confidence: Some(0.91),
            recommended_output_mode_reason: Some(OutputModeRecommendationReason::TextWithPictures),
            soft_alpha_foreground_recommendation: None,
            output_mode_diagnostics: None,
        }))
        .unwrap();

        assert_eq!(actual, expected);
    }

    #[cfg(unix)]
    #[test]
    fn page_complete_progress_serializes_non_utf8_output_paths_lossily() {
        use std::os::unix::ffi::OsStringExt;

        let path = PathBuf::from(std::ffi::OsString::from_vec(b"page-\xff.png".to_vec()));
        let progress = Progress {
            stage: ProgressStage::PageComplete,
            completed_pages: 1,
            total_pages: 1,
            page_number: Some(1),
            output_paths: Some(vec![path]),
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
        };

        let actual = serde_json::to_value(ProgressEnvelope::new(progress)).unwrap();
        assert_eq!(
            actual["progress"]["outputPaths"],
            serde_json::json!(["page-�.png"])
        );
    }
}
