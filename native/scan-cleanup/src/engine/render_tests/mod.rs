use super::*;
use crate::background::normalize_illumination;

pub(crate) fn analyze_page_with_document_prior_cached(
    source: &GrayImage,
    options: &CleanupOptions,
    document_prior: Option<DocumentPrior>,
    cache: &PageCache,
    timings: &mut PageStageTimings,
) -> Result<PageAnalysisResult, String> {
    super::analyze_page_with_color_and_document_prior_cached(
        source,
        None,
        options,
        document_prior,
        true,
        true,
        cache,
        timings,
    )
    .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
fn prepare_analysis_page(
    source: &GrayImage,
    color_source: Option<&RgbImage>,
    options: &CleanupOptions,
    prepare_quality_raster: bool,
    render_policy: PageRenderPolicy,
    document_prior: Option<DocumentPrior>,
    calibration_config: CalibrationConfig,
    cache: Option<&PageCache>,
    trusted_mrc_background: Option<&GrayImage>,
    timings: &mut PageStageTimings,
) -> PreparedAnalysis {
    document_analysis::run(document_analysis::Input {
        source,
        color_source,
        options,
        prepare_quality_raster,
        render_policy,
        document_prior,
        calibration_config,
        cache,
        trusted_mrc_background,
        timings,
    })
}

fn crop_gray_to_fit(
    source: &GrayImage,
    rect: Rect,
    max_width: usize,
    max_height: usize,
) -> GrayImage {
    crop_gray(source, rect).downscale_to_fit(max_width, max_height)
}

fn render_affine_gray_supersampled_reference(
    source: &GrayImage,
    width: usize,
    height: usize,
    inverse: Affine,
) -> GrayImage {
    let mut output = GrayImage::new(width, height, 255);
    let offsets = [0.125, 0.375, 0.625, 0.875];
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0u32;
            for &oy in &offsets {
                for &ox in &offsets {
                    let mapped = inverse.apply(Point::new(x as f64 + ox, y as f64 + oy));
                    sum += u32::from(sample_bilinear_white(source, mapped.x, mapped.y));
                }
            }
            output.set(x, y, (sum / 16) as u8);
        }
    }
    output
}

#[allow(clippy::too_many_arguments)]
fn compose_mixed(
    gray: &GrayImage,
    raw_gray: Option<&GrayImage>,
    color: Option<&RgbImage>,
    binary: &BinaryImage,
    picture_mask: &BinaryImage,
    chroma_picture_mask: Option<&BinaryImage>,
    removed_edge_bands: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    dpi: f64,
    preserve_confirmed_photo_tones: bool,
    use_soft_alpha_foreground: bool,
    create_layers: bool,
    create_composite: bool,
) -> (GrayImage, Option<RgbImage>, Option<MixedLayers>) {
    let output = super::final_composition::run(super::final_composition::Input {
        gray,
        raw_gray,
        color,
        binary,
        picture_mask,
        chroma_picture_mask,
        removed_edge_bands,
        text_mask,
        text_vicinity_mask,
        dpi,
        preserve_confirmed_photo_tones,
        use_soft_alpha_foreground,
        create_layers,
        create_composite,
    });
    (output.gray, output.color, output.mixed_layers)
}

#[allow(clippy::too_many_arguments)]
fn filter_fold_edge_fragments(
    binary: &BinaryImage,
    picture_mask: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    half: PageHalf,
    split: &SplitResult,
    region: Rect,
    render_plan: &ComposedRenderPlan,
    source_content_box: Option<Rect>,
    blank_leaf: bool,
    dpi: f64,
) -> BinaryImage {
    super::fold_edge_filtering::run(super::fold_edge_filtering::Input {
        binary,
        picture_mask,
        text_mask,
        text_vicinity_mask,
        half,
        split,
        region,
        render_plan,
        source_content_box,
        blank_leaf,
        dpi,
    })
    .kept
}

#[allow(clippy::too_many_arguments)]
fn filter_fold_edge_fragments_with_removed(
    binary: &BinaryImage,
    picture_mask: Option<&BinaryImage>,
    text_mask: Option<&BinaryImage>,
    text_vicinity_mask: Option<&BinaryImage>,
    half: PageHalf,
    split: &SplitResult,
    region: Rect,
    render_plan: &ComposedRenderPlan,
    source_content_box: Option<Rect>,
    blank_leaf: bool,
    dpi: f64,
) -> (BinaryImage, BinaryImage) {
    let output = super::fold_edge_filtering::run(super::fold_edge_filtering::Input {
        binary,
        picture_mask,
        text_mask,
        text_vicinity_mask,
        half,
        split,
        region,
        render_plan,
        source_content_box,
        blank_leaf,
        dpi,
    });
    (output.kept, output.removed)
}

include!("../render_tests.rs");
