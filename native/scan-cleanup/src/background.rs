use crate::io::png::RgbImage;
use rayon::prelude::*;
use scan_primitives::{morphology::reconstruct_gray, BinaryImage, GrayImage};

const X_TERMS: usize = 8;
const Y_TERMS: usize = 5;
const SURFACE_TERMS: usize = X_TERMS * Y_TERMS;
const MIN_PAPER_BACKGROUND_LUMINANCE: f64 = 128.0;
const MIN_PAPER_LIKE_COVERAGE: f64 = 0.18;
const PAPER_MODEL_TOLERANCE: f64 = 18.0;
const CONSERVATIVE_LEVELS_BLEND: f64 = 0.2;
const LAYOUT_WHITE_TARGET: f64 = 240.0;
const MIN_MATERIAL_SHOULDER_COVERAGE_DENOMINATOR: usize = 32;
// A normalized paper estimate is the display white point. Keeping headroom at
// 240 made every grayscale fallback visibly sit inside a gray rectangle on the
// PDF's white canvas. Robust fitting and the conservative color path handle
// model uncertainty; paper itself must not be redefined as gray.
const PAPER_WHITE_TARGET: f64 = 255.0;

#[derive(Clone, Debug)]
enum BackgroundModel {
    Surface(Vec<f64>),
    Reconstruction { image: GrayImage, floor: f64 },
}

#[derive(Clone, Debug)]
pub(crate) struct ReusableIlluminationModel {
    background: BackgroundModel,
    color_policy: ReusableColorPolicy,
}

#[derive(Clone, Copy, Debug)]
enum ReusableColorPolicy {
    Background,
    Conservative { low: f64, high: f64 },
    Unchanged,
}

#[derive(Clone, Copy, Debug)]
struct SurfaceDiagnostics {
    accepted_samples: usize,
    median_absolute_residual: f64,
    p90_absolute_residual: f64,
    minimum: f64,
    maximum: f64,
}

#[derive(Clone, Debug)]
struct SurfaceFit {
    coefficients: Vec<f64>,
    mask: Vec<bool>,
}

pub(crate) struct IlluminationPreparation {
    small: GrayImage,
    candidate: GrayImage,
    surface_basis: SurfaceBasis,
}

struct SurfaceBasis {
    x: Vec<[f64; X_TERMS]>,
    y: Vec<[f64; Y_TERMS]>,
}

impl SurfaceBasis {
    fn new(width: usize, height: usize) -> Self {
        Self {
            x: precompute_chebyshev::<X_TERMS>(width),
            y: precompute_chebyshev::<Y_TERMS>(height),
        }
    }

    fn at(&self, x: usize, y: usize) -> [f64; SURFACE_TERMS] {
        let mut basis = [0.0; SURFACE_TERMS];
        fill_surface_basis(&mut basis, &self.x[x], &self.y[y], SURFACE_TERMS);
        basis
    }
}

pub fn normalize_illumination(source: &GrayImage, _dpi: f64) -> GrayImage {
    normalize_illumination_with_picture_mask(source, _dpi, None)
}

pub fn normalize_illumination_with_picture_mask(
    source: &GrayImage,
    _dpi: f64,
    picture_mask: Option<&BinaryImage>,
) -> GrayImage {
    let photo_preservation_alpha = picture_mask.and_then(|mask| {
        let preparation = prepare_illumination(source);
        let layout = normalize_illumination_for_layout_prepared(source, &preparation);
        crate::picture::refine_tone_preservation_alpha(&layout, source, Some(mask), None)
    });
    normalize_illumination_with_masks(
        source,
        _dpi,
        picture_mask,
        None,
        photo_preservation_alpha.as_ref(),
    )
}

/// `model_exclusion_mask` may be deliberately coarse because it only removes
/// samples from the paper fit. Semantic tone is restored from the
/// illumination-corrected raster; only true photo regions may restore raw
/// source tone.
pub(crate) fn normalize_illumination_with_masks(
    source: &GrayImage,
    _dpi: f64,
    model_exclusion_mask: Option<&BinaryImage>,
    semantic_preservation_alpha: Option<&GrayImage>,
    photo_preservation_alpha: Option<&GrayImage>,
) -> GrayImage {
    let paper_model = paper_background_model(prepare_illumination(source), model_exclusion_mask);
    let paper_corrected = normalize_with_model(source, &paper_model);
    let semantic_corrected =
        semantic_preservation_alpha.map(|_| normalize_semantic_luminance(source));
    let mut normalized = paper_corrected.clone();
    calibrate_paper_field(&mut normalized, None, model_exclusion_mask, None);
    if let Some(alpha) = semantic_preservation_alpha {
        // Semantic tone uses an exclusion-aware corrected endpoint while
        // ordinary paper keeps the reconstruction model that removes local
        // scanner clouds. Raw source remains photo-only.
        blend_preserved_luminance(
            semantic_corrected.as_ref().unwrap_or(&paper_corrected),
            &mut normalized,
            alpha,
        );
    }
    if let Some(alpha) = photo_preservation_alpha {
        blend_preserved_luminance(source, &mut normalized, alpha);
    }
    normalized
}

#[cfg(test)]
pub(crate) fn normalize_illumination_preserving_tone(
    source: &GrayImage,
    dpi: f64,
    protected_tone_mask: &BinaryImage,
) -> GrayImage {
    normalize_illumination_with_picture_mask(source, dpi, Some(protected_tone_mask))
}

pub fn normalize_illumination_rgb(luminance: &GrayImage, source: &RgbImage, _dpi: f64) -> RgbImage {
    normalize_illumination_rgb_with_picture_mask(luminance, source, _dpi, None)
}

pub fn normalize_illumination_rgb_with_picture_mask(
    luminance: &GrayImage,
    source: &RgbImage,
    _dpi: f64,
    picture_mask: Option<&BinaryImage>,
) -> RgbImage {
    let photo_preservation_alpha = picture_mask.and_then(|mask| {
        let preparation = prepare_illumination(luminance);
        let layout = normalize_illumination_for_layout_prepared(luminance, &preparation);
        crate::picture::refine_tone_preservation_alpha(&layout, luminance, Some(mask), None)
    });
    normalize_illumination_rgb_with_masks(
        luminance,
        source,
        picture_mask,
        None,
        photo_preservation_alpha.as_ref(),
    )
}

pub(crate) fn normalize_illumination_rgb_with_masks(
    luminance: &GrayImage,
    source: &RgbImage,
    model_exclusion_mask: Option<&BinaryImage>,
    semantic_preservation_alpha: Option<&GrayImage>,
    photo_preservation_alpha: Option<&GrayImage>,
) -> RgbImage {
    let paper_model = paper_background_model(prepare_illumination(luminance), model_exclusion_mask);
    let source_median = median_luminance(luminance);
    let paper_is_plausible = source_median >= MIN_PAPER_BACKGROUND_LUMINANCE as u8
        && paper_background_plausible(luminance, &paper_model);
    let paper_corrected = if paper_is_plausible {
        normalize_rgb_with_model(source, &paper_model)
    } else {
        conservative_luminance_levels(luminance, source)
    };
    let semantic_corrected =
        semantic_preservation_alpha.map(|_| normalize_semantic_color(luminance, source));
    let mut normalized = paper_corrected.clone();
    let mut normalized_luminance = normalize_with_model(luminance, &paper_model);
    // A full-bleed photograph or colored cover has no paper field to white
    // balance. Treating its spatially dominant color as paper turns dark art
    // into a pale, noisy rectangle. Mixed output still calibrates outside its
    // explicit picture mask; an unmasked Color page is calibrated only after
    // the background model establishes that paper is actually plausible.
    if paper_is_plausible
        || source_median >= MIN_PAPER_BACKGROUND_LUMINANCE as u8
        || model_exclusion_mask.is_some()
    {
        calibrate_paper_field(
            &mut normalized_luminance,
            Some(&mut normalized),
            model_exclusion_mask,
            None,
        );
    }
    if let Some(alpha) = semantic_preservation_alpha {
        blend_preserved_color(
            semantic_corrected.as_ref().unwrap_or(&paper_corrected),
            &mut normalized,
            alpha,
        );
    }
    if let Some(alpha) = photo_preservation_alpha {
        blend_preserved_color(source, &mut normalized, alpha);
    }
    normalized
}

fn median_luminance(source: &GrayImage) -> u8 {
    let mut histogram = [0usize; 256];
    for &value in source.data() {
        histogram[usize::from(value)] += 1;
    }
    let target = source.data().len().saturating_sub(1) / 2;
    let mut cumulative = 0usize;
    histogram
        .iter()
        .position(|&count| {
            cumulative += count;
            cumulative > target
        })
        .unwrap_or(255) as u8
}

/// Normalize the luminance and RGB views with one fitted paper model. Mixed
/// cleanup consumes both views of the same source raster; fitting the identical
/// model twice made full-resolution pages pay twice for preparation without
/// changing either result.
#[cfg(test)]
pub(crate) fn normalize_illumination_pair_with_picture_mask(
    luminance: &GrayImage,
    source: &RgbImage,
    picture_mask: Option<&BinaryImage>,
) -> (GrayImage, RgbImage) {
    let photo_preservation_alpha = picture_mask.and_then(|mask| {
        let preparation = prepare_illumination(luminance);
        let layout = normalize_illumination_for_layout_prepared(luminance, &preparation);
        crate::picture::refine_tone_preservation_alpha(&layout, luminance, Some(mask), None)
    });
    normalize_illumination_pair_with_masks(
        luminance,
        source,
        picture_mask,
        None,
        photo_preservation_alpha.as_ref(),
    )
}

pub(crate) fn normalize_illumination_pair_with_masks(
    luminance: &GrayImage,
    source: &RgbImage,
    model_exclusion_mask: Option<&BinaryImage>,
    semantic_preservation_alpha: Option<&GrayImage>,
    photo_preservation_alpha: Option<&GrayImage>,
) -> (GrayImage, RgbImage) {
    let paper_model = paper_background_model(prepare_illumination(luminance), model_exclusion_mask);
    let color_page_has_paper = model_exclusion_mask.is_some()
        || median_luminance(luminance) >= MIN_PAPER_BACKGROUND_LUMINANCE as u8;
    let use_background_for_color =
        color_page_has_paper && paper_background_plausible(luminance, &paper_model);
    let (paper_corrected_luminance, paper_corrected_color) = rayon::join(
        || normalize_with_model(luminance, &paper_model),
        || {
            if use_background_for_color {
                normalize_rgb_with_model(source, &paper_model)
            } else {
                conservative_luminance_levels(luminance, source)
            }
        },
    );
    let semantic_corrected = semantic_preservation_alpha.map(|_| {
        rayon::join(
            || normalize_semantic_luminance(luminance),
            || normalize_semantic_color(luminance, source),
        )
    });
    let mut normalized_luminance = paper_corrected_luminance.clone();
    let mut normalized_color = paper_corrected_color.clone();
    if color_page_has_paper {
        calibrate_paper_field(
            &mut normalized_luminance,
            Some(&mut normalized_color),
            model_exclusion_mask,
            None,
        );
    }
    if let Some(alpha) = semantic_preservation_alpha {
        let (semantic_luminance, semantic_color) = semantic_corrected.as_ref().map_or(
            (&paper_corrected_luminance, &paper_corrected_color),
            |(luminance, color)| (luminance, color),
        );
        blend_preserved_luminance(semantic_luminance, &mut normalized_luminance, alpha);
        blend_preserved_color(semantic_color, &mut normalized_color, alpha);
    }
    if let Some(alpha) = photo_preservation_alpha {
        blend_preserved_luminance(luminance, &mut normalized_luminance, alpha);
        blend_preserved_color(source, &mut normalized_color, alpha);
    }
    (normalized_luminance, normalized_color)
}

fn preservation_alpha_at(
    alpha: &GrayImage,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> f64 {
    let source_x = source_coordinate(x, width, alpha.width());
    let source_y = source_coordinate(y, height, alpha.height());
    sample_bilinear(alpha, source_x, source_y) / 255.0
}

fn blend_preserved_luminance(source: &GrayImage, normalized: &mut GrayImage, alpha: &GrayImage) {
    let width = normalized.width();
    let height = normalized.height();
    normalized
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                let weight = preservation_alpha_at(alpha, x, y, width, height);
                *target = (f64::from(*target) * (1.0 - weight)
                    + f64::from(source.get(x, y)) * weight)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        });
}

fn blend_preserved_color(source: &RgbImage, normalized: &mut RgbImage, alpha: &GrayImage) {
    let width = normalized.width();
    let height = normalized.height();
    normalized
        .data_mut()
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.chunks_exact_mut(3).enumerate() {
                let weight = preservation_alpha_at(alpha, x, y, width, height);
                let source_pixel = source.get(x, y);
                for channel in 0..3 {
                    target[channel] = (f64::from(target[channel]) * (1.0 - weight)
                        + f64::from(source_pixel[channel]) * weight)
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
            }
        });
}

fn background_model(source: &GrayImage, picture_mask: Option<&BinaryImage>) -> BackgroundModel {
    background_model_from_preparation(prepare_illumination(source), picture_mask)
}

fn background_model_from_preparation(
    preparation: IlluminationPreparation,
    picture_mask: Option<&BinaryImage>,
) -> BackgroundModel {
    match fit_masked_surface_with_basis(
        &preparation.small,
        &preparation.candidate,
        picture_mask,
        &preparation.surface_basis,
    ) {
        Some(fit) => select_background_model(
            &preparation.small,
            preparation.candidate,
            fit,
            picture_mask.is_none(),
        ),
        None if picture_mask.is_none() => reconstruction_fallback(preparation.candidate),
        None => constant_surface_fallback(&preparation.candidate),
    }
}

/// Builds the spatial paper endpoint. Semantic content uses the separate
/// robust multiplicative endpoint below: fitting a high-order surface from the
/// narrow remainder around a large map is underconstrained.
fn paper_background_model(
    preparation: IlluminationPreparation,
    model_exclusion_mask: Option<&BinaryImage>,
) -> BackgroundModel {
    let protect_content_structure = model_exclusion_mask.is_some_and(|mask| mask.count_black() > 0);
    let surface_model_exclusion = model_exclusion_mask.filter(|mask| {
        mask.count_black() as f64 / (mask.width().saturating_mul(mask.height()).max(1) as f64)
            < 0.60
    });
    let paper_reference =
        robust_image_percentile(&preparation.candidate, 0.95).max(MIN_PAPER_BACKGROUND_LUMINANCE);
    let surface_exclusion = surface_model_exclusion.and_then(|picture_mask| {
        let exclusion = BinaryImage::from_fn_parallel(
            preparation.small.width(),
            preparation.small.height(),
            |x, y| {
                let picture_x = if preparation.small.width() <= 1 {
                    0
                } else {
                    x * picture_mask.width().saturating_sub(1) / (preparation.small.width() - 1)
                };
                let picture_y = if preparation.small.height() <= 1 {
                    0
                } else {
                    y * picture_mask.height().saturating_sub(1) / (preparation.small.height() - 1)
                };
                picture_mask.get(picture_x, picture_y)
                    && f64::from(preparation.small.get(x, y)) + 18.0
                        < paper_reference.max(f64::from(preparation.candidate.get(x, y)))
            },
        );
        (exclusion.count_black() > 0).then_some(exclusion)
    });
    let paper_fit = fit_masked_surface_with_basis(
        &preparation.small,
        &preparation.candidate,
        surface_exclusion.as_ref(),
        &preparation.surface_basis,
    );
    match paper_fit {
        Some(fit) => select_background_model(
            &preparation.small,
            preparation.candidate,
            fit,
            !protect_content_structure,
        ),
        None if !protect_content_structure => reconstruction_fallback(preparation.candidate),
        None => constant_surface_fallback(&preparation.candidate),
    }
}

pub(crate) fn reusable_illumination_model(source: &GrayImage) -> ReusableIlluminationModel {
    let background = background_model(source, None);
    let color_policy = if median_luminance(source) >= MIN_PAPER_BACKGROUND_LUMINANCE as u8
        && paper_background_plausible(source, &background)
    {
        ReusableColorPolicy::Background
    } else {
        let low = robust_image_percentile(source, 0.02);
        let high = robust_image_percentile(source, 0.98);
        if high - low < 48.0 || (low <= 12.0 && high >= 243.0) {
            ReusableColorPolicy::Unchanged
        } else {
            ReusableColorPolicy::Conservative { low, high }
        }
    };
    ReusableIlluminationModel {
        background,
        color_policy,
    }
}

pub(crate) fn normalize_region_with_reusable_model<F>(
    source: &GrayImage,
    model: &ReusableIlluminationModel,
    normalized_coordinate: F,
) -> GrayImage
where
    F: Fn(usize, usize) -> (f64, f64) + Sync,
{
    let mut normalized = GrayImage::new(source.width(), source.height(), 255);
    normalized
        .data_mut()
        .par_chunks_mut(source.width())
        .enumerate()
        .for_each(|(y, output_row)| {
            for (x, target) in output_row.iter_mut().enumerate() {
                let (u, v) = normalized_coordinate(x, y);
                let background = reusable_background_at(&model.background, u, v);
                *target = (f64::from(source.get(x, y)) * PAPER_WHITE_TARGET / background)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        });
    normalized
}

pub(crate) fn normalize_rgb_region_with_reusable_model<F>(
    luminance: &GrayImage,
    source: &RgbImage,
    model: &ReusableIlluminationModel,
    normalized_coordinate: F,
) -> RgbImage
where
    F: Fn(usize, usize) -> (f64, f64) + Sync,
{
    let mut normalized = source.clone();
    normalized
        .data_mut()
        .par_chunks_mut(source.width() * 3)
        .enumerate()
        .for_each(|(y, output_row)| {
            for (x, target) in output_row.chunks_exact_mut(3).enumerate() {
                let source_pixel = source.get(x, y);
                let source_luminance = f64::from(luminance.get(x, y));
                let target_luminance = match model.color_policy {
                    ReusableColorPolicy::Background => {
                        let (u, v) = normalized_coordinate(x, y);
                        source_luminance * PAPER_WHITE_TARGET
                            / reusable_background_at(&model.background, u, v)
                    }
                    ReusableColorPolicy::Conservative { low, high } => {
                        let stretched = (12.0 + (source_luminance - low) * 231.0 / (high - low))
                            .clamp(0.0, 255.0);
                        source_luminance * (1.0 - CONSERVATIVE_LEVELS_BLEND)
                            + stretched * CONSERVATIVE_LEVELS_BLEND
                    }
                    ReusableColorPolicy::Unchanged => source_luminance,
                }
                .clamp(0.0, 255.0);
                if source_luminance <= f64::EPSILON {
                    target.copy_from_slice(&source_pixel);
                    continue;
                }
                let factor = target_luminance / source_luminance;
                for channel in 0..3 {
                    target[channel] = (f64::from(source_pixel[channel]) * factor)
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
            }
        });
    normalized
}

fn reusable_background_at(model: &BackgroundModel, u: f64, v: f64) -> f64 {
    let u = u.clamp(0.0, 1.0);
    let v = v.clamp(0.0, 1.0);
    match model {
        BackgroundModel::Surface(coefficients) => {
            let x_basis = chebyshev_basis::<X_TERMS>(u * 2.0 - 1.0);
            let y_basis = chebyshev_basis::<Y_TERMS>(v * 2.0 - 1.0);
            let mut value = 0.0;
            for y_term in 0..Y_TERMS {
                for x_term in 0..X_TERMS {
                    value +=
                        coefficients[y_term * X_TERMS + x_term] * x_basis[x_term] * y_basis[y_term];
                }
            }
            value
        }
        BackgroundModel::Reconstruction { image, floor } => sample_bilinear(
            image,
            u * image.width().saturating_sub(1) as f64,
            v * image.height().saturating_sub(1) as f64,
        )
        .max(*floor),
    }
    .clamp(32.0, 255.0)
}

/// Stage-B split calibration is intentionally held against the pre-Stage-F
/// surface solve. Final rendering uses the validated Cholesky model above.
#[cfg(test)]
pub(crate) fn normalize_illumination_for_layout(source: &GrayImage) -> GrayImage {
    let preparation = prepare_illumination(source);
    normalize_illumination_for_layout_prepared(source, &preparation)
}

pub(crate) fn prepare_illumination(source: &GrayImage) -> IlluminationPreparation {
    let (small, candidate) = reconstructed_background(source);
    let surface_basis = SurfaceBasis::new(small.width(), small.height());
    IlluminationPreparation {
        small,
        candidate,
        surface_basis,
    }
}

pub(crate) fn normalize_illumination_for_layout_prepared(
    source: &GrayImage,
    preparation: &IlluminationPreparation,
) -> GrayImage {
    let model = fit_masked_surface_legacy_with_basis(
        &preparation.small,
        &preparation.candidate,
        &preparation.surface_basis,
    )
    .map(BackgroundModel::Surface)
    .unwrap_or_else(|| reconstruction_fallback(preparation.candidate.clone()));
    // Layout thresholds, crop geometry, and deskew calibration are frozen to
    // the historical 240 endpoint. The quality raster may map paper to 255,
    // but feeding that display decision back into geometry causes subpixel
    // preview/final shifts and makes exact glyph coordinates disagree across
    // source resolutions.
    normalize_with_model_target(source, &model, LAYOUT_WHITE_TARGET)
}

#[cfg(test)]
pub(crate) fn normalize_illumination_prepared(
    source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    preparation: IlluminationPreparation,
) -> GrayImage {
    let photo_preservation_alpha = picture_mask.and_then(|mask| {
        let layout = normalize_illumination_for_layout_prepared(source, &preparation);
        crate::picture::refine_tone_preservation_alpha(&layout, source, Some(mask), None)
    });
    normalize_illumination_prepared_with_masks(
        source,
        picture_mask,
        None,
        photo_preservation_alpha.as_ref(),
        None,
        preparation,
    )
}

pub(crate) fn normalize_illumination_prepared_with_masks(
    source: &GrayImage,
    model_exclusion_mask: Option<&BinaryImage>,
    semantic_preservation_alpha: Option<&GrayImage>,
    photo_preservation_alpha: Option<&GrayImage>,
    paper_shoulder_protection_mask: Option<&BinaryImage>,
    preparation: IlluminationPreparation,
) -> GrayImage {
    let paper_model = paper_background_model(preparation, model_exclusion_mask);
    let paper_corrected = normalize_with_model(source, &paper_model);
    let semantic_corrected =
        semantic_preservation_alpha.map(|_| normalize_semantic_luminance(source));
    let mut normalized = paper_corrected.clone();
    calibrate_paper_field(
        &mut normalized,
        None,
        model_exclusion_mask,
        paper_shoulder_protection_mask,
    );
    if let Some(alpha) = semantic_preservation_alpha {
        blend_preserved_luminance(
            semantic_corrected.as_ref().unwrap_or(&paper_corrected),
            &mut normalized,
            alpha,
        );
    }
    if let Some(alpha) = photo_preservation_alpha {
        blend_preserved_luminance(source, &mut normalized, alpha);
    }
    normalized
}

fn reconstructed_background(source: &GrayImage) -> (GrayImage, GrayImage) {
    let small = source.downscale_to_fit(300, 300);
    let radius = ((small.width().min(small.height()) as f64 * 0.025).round() as usize).clamp(2, 12);
    let inverted = invert(&small);
    let marker = gray_erode(&inverted, radius);
    let reconstructed = reconstruct_gray(&marker, &inverted);
    let candidate = invert(&reconstructed);
    (small, candidate)
}

fn reconstruction_fallback(candidate: GrayImage) -> BackgroundModel {
    let floor = robust_image_percentile(&candidate, 0.5) * 0.5;
    BackgroundModel::Reconstruction {
        image: candidate,
        floor,
    }
}

/// A quality-render correction field must be smoother than any printable page
/// content. The reconstructed image is useful while selecting paper samples,
/// but using it as the divisor copies maps, halftones, and bleed-through into
/// the correction field and creates bright halos around their boundaries.
///
/// When the robust surface fit is unavailable, prefer one page-wide paper
/// anchor. It cannot remove a local shadow, but it also cannot invent content-
/// shaped illumination. Layout analysis keeps its frozen reconstruction
/// fallback because changing that field would move split/crop calibration.
fn constant_surface_fallback(candidate: &GrayImage) -> BackgroundModel {
    let mut coefficients = vec![0.0; SURFACE_TERMS];
    coefficients[0] = robust_image_percentile(candidate, 0.5).clamp(32.0, 255.0);
    BackgroundModel::Surface(coefficients)
}

fn normalize_with_model(source: &GrayImage, model: &BackgroundModel) -> GrayImage {
    normalize_with_model_target(source, model, PAPER_WHITE_TARGET)
}

fn normalize_with_model_target(
    source: &GrayImage,
    model: &BackgroundModel,
    white_target: f64,
) -> GrayImage {
    let mut normalized = GrayImage::new(source.width(), source.height(), 255);
    let x_basis = precompute_chebyshev::<X_TERMS>(source.width());
    let y_basis = precompute_chebyshev::<Y_TERMS>(source.height());
    normalized
        .data_mut()
        .par_chunks_mut(source.width())
        .enumerate()
        .for_each(|(y, output_row)| {
            let mut row_coefficients = [0.0; X_TERMS];
            if let BackgroundModel::Surface(coefficients) = &model {
                for y_term in 0..Y_TERMS {
                    for x_term in 0..X_TERMS {
                        row_coefficients[x_term] +=
                            coefficients[y_term * X_TERMS + x_term] * y_basis[y][y_term];
                    }
                }
            }
            for (x, target) in output_row.iter_mut().enumerate() {
                let background = match &model {
                    BackgroundModel::Surface(_) => row_coefficients
                        .iter()
                        .zip(&x_basis[x])
                        .map(|(coefficient, basis)| coefficient * basis)
                        .sum::<f64>(),
                    BackgroundModel::Reconstruction { image, floor } => sample_bilinear(
                        image,
                        source_coordinate(x, source.width(), image.width()),
                        source_coordinate(y, source.height(), image.height()),
                    )
                    .max(*floor),
                }
                .clamp(32.0, 255.0);
                *target = (f64::from(source.get(x, y)) * white_target / background)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        });
    normalized
}

fn normalize_rgb_with_model(source: &RgbImage, model: &BackgroundModel) -> RgbImage {
    let mut normalized = RgbImage::new(source.width(), source.height(), [255; 3]);
    let x_basis = precompute_chebyshev::<X_TERMS>(source.width());
    let y_basis = precompute_chebyshev::<Y_TERMS>(source.height());
    normalized
        .data_mut()
        .par_chunks_mut(source.width() * 3)
        .enumerate()
        .for_each(|(y, output_row)| {
            let mut row_coefficients = [0.0; X_TERMS];
            if let BackgroundModel::Surface(coefficients) = model {
                for y_term in 0..Y_TERMS {
                    for x_term in 0..X_TERMS {
                        row_coefficients[x_term] +=
                            coefficients[y_term * X_TERMS + x_term] * y_basis[y][y_term];
                    }
                }
            }
            for (x, target) in output_row.chunks_exact_mut(3).enumerate() {
                let background = match model {
                    BackgroundModel::Surface(_) => row_coefficients
                        .iter()
                        .zip(&x_basis[x])
                        .map(|(coefficient, basis)| coefficient * basis)
                        .sum::<f64>(),
                    BackgroundModel::Reconstruction { image, floor } => sample_bilinear(
                        image,
                        source_coordinate(x, source.width(), image.width()),
                        source_coordinate(y, source.height(), image.height()),
                    )
                    .max(*floor),
                }
                .clamp(32.0, 255.0);
                let factor = PAPER_WHITE_TARGET / background;
                let source_pixel = source.get(x, y);
                for channel in 0..3 {
                    target[channel] = (f64::from(source_pixel[channel]) * factor)
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
            }
        });
    normalized
}

/// Corrects semantic gray/color content with one robust page-white anchor.
///
/// A high-order spatial surface fitted from the thin paper remainder around a
/// large map is underconstrained and can flatten the map into white. The 95th
/// percentile is a shade-independent estimate of the page's light stock: the
/// multiplicative transform keeps relative semantic contrast while mapping
/// the page's light field toward display white.
fn semantic_paper_anchor(source: &GrayImage) -> f64 {
    let mut histogram = [0usize; 256];
    for &value in source.data() {
        histogram[usize::from(value)] += 1;
    }
    let target = source.data().len().saturating_sub(1) * 95 / 100;
    let mut cumulative = 0usize;
    histogram
        .iter()
        .position(|count| {
            cumulative += count;
            cumulative > target
        })
        .unwrap_or(255)
        .max(32) as f64
}

fn normalize_semantic_luminance(source: &GrayImage) -> GrayImage {
    let gain = PAPER_WHITE_TARGET / semantic_paper_anchor(source);
    let mut normalized = source.clone();
    normalized.data_mut().par_iter_mut().for_each(|value| {
        *value = (f64::from(*value) * gain).round().clamp(0.0, 255.0) as u8;
    });
    normalized
}

fn normalize_semantic_color(luminance: &GrayImage, source: &RgbImage) -> RgbImage {
    let gain = PAPER_WHITE_TARGET / semantic_paper_anchor(luminance);
    let mut normalized = source.clone();
    normalized.data_mut().par_iter_mut().for_each(|value| {
        *value = (f64::from(*value) * gain).round().clamp(0.0, 255.0) as u8;
    });
    normalized
}

/// The spatial background solve can flatten illumination while leaving a
/// uniform colored paper cast because it applies one luminance gain to all RGB
/// channels. A second calibration is therefore a required post-condition for
/// color as well as Mixed output: find the dominant, spatially distributed
/// paper cluster, map it to display white, and use the same samples for RGB
/// white balance. When a picture mask exists, protected picture pixels are
/// untouched. Without one, the global per-channel gain is a conventional white
/// balance: it removes the paper cast while retaining independent chroma.
fn calibrate_paper_field(
    normalized_luminance: &mut GrayImage,
    normalized_color: Option<&mut RgbImage>,
    sampling_exclusion_mask: Option<&BinaryImage>,
    paper_shoulder_protection_mask: Option<&BinaryImage>,
) {
    const MAX_SAMPLES: usize = 200_000;
    const CLUSTER_RADIUS: usize = 10;
    const MIN_CLUSTER_COVERAGE_DENOMINATOR: usize = 5;
    const MIN_SPATIAL_EXTENT_DENOMINATOR: usize = 3;

    let width = normalized_luminance.width();
    let height = normalized_luminance.height();
    let sampling_exclusion_mask = sampling_exclusion_mask.filter(|mask| {
        // A near-page-sized map/picture mask has no useful "outside" paper
        // sample. Its renderer ownership field will restore true tone later;
        // paper calibration must still find the dominant light field inside
        // the geometry so the map's unprinted stock can become white.
        mask.count_black() as f64 / (mask.width().saturating_mul(mask.height()).max(1) as f64)
            < 0.60
    });
    debug_assert!(normalized_color
        .as_ref()
        .is_none_or(|color| color.width() == width && color.height() == height));
    let sample_stride = ((width.saturating_mul(height) / MAX_SAMPLES).max(1) as f64)
        .sqrt()
        .ceil() as usize;
    let mask_at = |mask: Option<&BinaryImage>, x: usize, y: usize| {
        mask.is_some_and(|mask| {
            let mask_x = x.saturating_mul(mask.width()) / width.max(1);
            let mask_y = y.saturating_mul(mask.height()) / height.max(1);
            mask.get(
                mask_x.min(mask.width().saturating_sub(1)),
                mask_y.min(mask.height().saturating_sub(1)),
            )
        })
    };
    let mut histogram = [0usize; 256];
    let mut sampled_outside = 0usize;
    for y in (0..height).step_by(sample_stride) {
        for x in (0..width).step_by(sample_stride) {
            if mask_at(sampling_exclusion_mask, x, y)
                || mask_at(paper_shoulder_protection_mask, x, y)
            {
                continue;
            }
            sampled_outside += 1;
            histogram[usize::from(normalized_luminance.get(x, y))] += 1;
        }
    }
    let minimum_samples = 128usize.min(sampled_outside).max(sampled_outside / 100);
    if sampled_outside < minimum_samples || sampled_outside == 0 {
        return;
    }

    let quantile = |numerator: usize, denominator: usize| {
        let target = sampled_outside.saturating_sub(1) * numerator / denominator;
        let mut cumulative = 0usize;
        histogram
            .iter()
            .position(|count| {
                cumulative += count;
                cumulative > target
            })
            .unwrap_or(255)
    };
    let median = quantile(1, 2);
    let first_center = median.saturating_sub(CLUSTER_RADIUS);
    let mut cluster_center = first_center;
    let mut cluster_count = 0usize;
    for center in first_center..=255 {
        let first = center.saturating_sub(CLUSTER_RADIUS);
        let last = (center + CLUSTER_RADIUS).min(255);
        let count = histogram[first..=last].iter().sum::<usize>();
        if count > cluster_count {
            cluster_center = center;
            cluster_count = count;
        }
    }
    if cluster_count < minimum_samples.max(sampled_outside / MIN_CLUSTER_COVERAGE_DENOMINATOR) {
        return;
    }

    let cluster_first = cluster_center.saturating_sub(CLUSTER_RADIUS);
    let cluster_last = (cluster_center + CLUSTER_RADIUS).min(255);
    let mut luminance_samples = Vec::with_capacity(cluster_count);
    let mut channel_samples = [Vec::new(), Vec::new(), Vec::new()];
    let mut minimum_x = width;
    let mut maximum_x = 0usize;
    let mut minimum_y = height;
    let mut maximum_y = 0usize;
    for y in (0..height).step_by(sample_stride) {
        for x in (0..width).step_by(sample_stride) {
            if mask_at(sampling_exclusion_mask, x, y)
                || mask_at(paper_shoulder_protection_mask, x, y)
            {
                continue;
            }
            let luminance = normalized_luminance.get(x, y);
            if usize::from(luminance) < cluster_first || usize::from(luminance) > cluster_last {
                continue;
            }
            luminance_samples.push(luminance);
            if let Some(color) = normalized_color.as_deref() {
                let pixel = color.get(x, y);
                for channel in 0..3 {
                    channel_samples[channel].push(pixel[channel]);
                }
            }
            minimum_x = minimum_x.min(x);
            maximum_x = maximum_x.max(x);
            minimum_y = minimum_y.min(y);
            maximum_y = maximum_y.max(y);
        }
    }
    if luminance_samples.len() < minimum_samples
        || maximum_x.saturating_sub(minimum_x) * MIN_SPATIAL_EXTENT_DENOMINATOR < width
        || maximum_y.saturating_sub(minimum_y) * MIN_SPATIAL_EXTENT_DENOMINATOR < height
    {
        return;
    }
    luminance_samples.sort_unstable();
    for values in &mut channel_samples {
        values.sort_unstable();
    }
    let sample_median = |values: &[u8]| values[values.len() / 2];
    let paper_luminance = sample_median(&luminance_samples);
    let paper_channels = normalized_color.as_ref().map(|_| {
        channel_samples
            .each_ref()
            .map(|values| sample_median(values))
    });
    normalized_color
        .zip(paper_channels)
        .into_iter()
        .for_each(|(color, paper)| {
            if paper.iter().all(|&channel| channel >= 250) {
                return;
            }
            let paper_mean = paper.iter().map(|&channel| f64::from(channel)).sum::<f64>() / 3.0;
            let paper_chroma = paper.map(|channel| f64::from(channel) - paper_mean);
            let paper_chroma_norm = paper_chroma
                .iter()
                .map(|channel| channel * channel)
                .sum::<f64>()
                .sqrt();
            color.data_mut().par_chunks_mut(width * 3).for_each(|row| {
                for pixel in row.chunks_exact_mut(3) {
                    let pixel_mean =
                        pixel.iter().map(|&channel| f64::from(channel)).sum::<f64>() / 3.0;
                    let pixel_chroma = [
                        f64::from(pixel[0]) - pixel_mean,
                        f64::from(pixel[1]) - pixel_mean,
                        f64::from(pixel[2]) - pixel_mean,
                    ];
                    let pixel_chroma_norm = pixel_chroma
                        .iter()
                        .map(|channel| channel * channel)
                        .sum::<f64>()
                        .sqrt();
                    let neutral = pixel_chroma_norm <= 18.0;
                    let follows_paper_tint = paper_chroma_norm >= 8.0
                        && pixel_chroma_norm >= 8.0
                        && paper_chroma
                            .iter()
                            .zip(pixel_chroma)
                            .map(|(left, right)| left * right)
                            .sum::<f64>()
                            / (paper_chroma_norm * pixel_chroma_norm)
                            >= 0.82;
                    if !neutral && !follows_paper_tint {
                        continue;
                    }
                    for channel in 0..3 {
                        pixel[channel] = (f64::from(pixel[channel]) * 255.0
                            / f64::from(paper[channel]).max(1.0))
                        .round()
                        .clamp(0.0, 255.0) as u8;
                    }
                }
            });
        });
    // Scanner show-through and broad lighting bands form a shallow shoulder
    // immediately below the dominant paper mode. A linear white-point gain
    // leaves that shoulder visibly gray. Lift it with a smooth, page-relative
    // knee while keeping deeper ink on the ordinary multiplicative curve.
    // True tone is restored by its ownership field after this paper endpoint
    // is produced; text stays on the monotonic curve and is darkened later.
    let paper = f64::from(paper_luminance).max(1.0);
    let knee_low = (paper - 64.0).max(0.0);
    // A shallow mark is a paper-field artifact only when it occupies material
    // page area. Sparse low-contrast marks may be faint or tiny foreground
    // text and must stay on the ordinary white-point curve.
    let shoulder_first = paper_luminance.saturating_sub(63);
    let shoulder_last = paper_luminance.saturating_sub(10);
    let shoulder_count = if shoulder_first <= shoulder_last {
        histogram[usize::from(shoulder_first)..=usize::from(shoulder_last)]
            .iter()
            .sum::<usize>()
    } else {
        0
    };
    let apply_paper_shoulder = shoulder_count
        .saturating_mul(MIN_MATERIAL_SHOULDER_COVERAGE_DENOMINATOR)
        >= sampled_outside;
    normalized_luminance
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, pixel) in row.iter_mut().enumerate() {
                let value = f64::from(*pixel);
                let scaled = value * 255.0 / paper;
                let normalized = if !apply_paper_shoulder
                    || value <= knee_low
                    || mask_at(paper_shoulder_protection_mask, x, y)
                {
                    scaled
                } else {
                    let t = ((value - knee_low) / (paper - knee_low).max(1.0)).clamp(0.0, 1.0);
                    // Ease out quickly so a broad, low-contrast paper shoulder
                    // reaches white without a hard contour.
                    let weight = 1.0 - (1.0 - t).powi(3);
                    scaled * (1.0 - weight) + 255.0 * weight
                };
                *pixel = normalized.round().clamp(0.0, 255.0) as u8;
            }
        });
}

fn paper_background_plausible(source: &GrayImage, model: &BackgroundModel) -> bool {
    let sample = source.downscale_to_fit(300, 300);
    let x_basis = precompute_chebyshev::<X_TERMS>(sample.width());
    let y_basis = precompute_chebyshev::<Y_TERMS>(sample.height());
    let mut modeled_luminance = Vec::with_capacity(sample.width() * sample.height());
    let mut paper_like = 0usize;
    for (y, y_values) in y_basis.iter().enumerate() {
        let mut row_coefficients = [0.0; X_TERMS];
        if let BackgroundModel::Surface(coefficients) = model {
            for y_term in 0..Y_TERMS {
                for x_term in 0..X_TERMS {
                    row_coefficients[x_term] +=
                        coefficients[y_term * X_TERMS + x_term] * y_values[y_term];
                }
            }
        }
        for (x, x_values) in x_basis.iter().enumerate() {
            let background = match model {
                BackgroundModel::Surface(_) => row_coefficients
                    .iter()
                    .zip(x_values)
                    .map(|(coefficient, basis)| coefficient * basis)
                    .sum::<f64>(),
                BackgroundModel::Reconstruction { image, floor } => sample_bilinear(
                    image,
                    source_coordinate(x, sample.width(), image.width()),
                    source_coordinate(y, sample.height(), image.height()),
                )
                .max(*floor),
            }
            .clamp(0.0, 255.0);
            modeled_luminance.push(background);
            if background >= MIN_PAPER_BACKGROUND_LUMINANCE
                && f64::from(sample.get(x, y)) >= MIN_PAPER_BACKGROUND_LUMINANCE
                && f64::from(sample.get(x, y)) + PAPER_MODEL_TOLERANCE >= background
            {
                paper_like += 1;
            }
        }
    }
    let background_floor = percentile(&mut modeled_luminance, 0.2);
    let paper_like_coverage = paper_like as f64 / modeled_luminance.len().max(1) as f64;
    background_floor >= MIN_PAPER_BACKGROUND_LUMINANCE
        && paper_like_coverage >= MIN_PAPER_LIKE_COVERAGE
}

fn conservative_luminance_levels(luminance: &GrayImage, source: &RgbImage) -> RgbImage {
    let low = robust_image_percentile(luminance, 0.02);
    let high = robust_image_percentile(luminance, 0.98);
    if high - low < 48.0 || (low <= 12.0 && high >= 243.0) {
        return source.clone();
    }
    let width = source.width();
    let mut output = source.clone();
    output
        .data_mut()
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.chunks_exact_mut(3).enumerate() {
                let source_luminance = f64::from(luminance.get(x, y));
                if source_luminance <= f64::EPSILON {
                    continue;
                }
                let stretched =
                    (12.0 + (source_luminance - low) * 231.0 / (high - low)).clamp(0.0, 255.0);
                let target_luminance = (source_luminance * (1.0 - CONSERVATIVE_LEVELS_BLEND)
                    + stretched * CONSERVATIVE_LEVELS_BLEND)
                    .clamp(0.0, 255.0);
                let maximum_channel = f64::from(*target.iter().max().unwrap_or(&0));
                if maximum_channel <= f64::EPSILON {
                    continue;
                }
                let scale = (target_luminance / source_luminance).min(255.0 / maximum_channel);
                for channel in target {
                    *channel = (f64::from(*channel) * scale).round().clamp(0.0, 255.0) as u8;
                }
            }
        });
    output
}

fn invert(image: &GrayImage) -> GrayImage {
    let mut output = image.clone();
    for value in output.data_mut() {
        *value = 255 - *value;
    }
    output
}

/// Erosion by a clamped square window, run as a horizontal minimum followed by a
/// vertical one. `min` is associative and exact on `u8`, so the separable form returns
/// the same image as the square window it replaces, at `O(radius)` per pixel instead of
/// `O(radius²)`.
fn gray_erode(source: &GrayImage, radius: usize) -> GrayImage {
    let (width, height) = (source.width(), source.height());
    let mut horizontal = GrayImage::new(width, height, 0);
    horizontal
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            let source_row = &source.data()[y * width..(y + 1) * width];
            for (x, target) in row.iter_mut().enumerate() {
                *target = source_row[x.saturating_sub(radius)..=(x + radius).min(width - 1)]
                    .iter()
                    .copied()
                    .min()
                    .unwrap_or(u8::MAX);
            }
        });
    let mut output = GrayImage::new(width, height, 0);
    output
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            let first = y.saturating_sub(radius);
            let last = (y + radius).min(height - 1);
            row.copy_from_slice(&horizontal.data()[first * width..(first + 1) * width]);
            for sample_y in first + 1..=last {
                let above = &horizontal.data()[sample_y * width..(sample_y + 1) * width];
                for (target, value) in row.iter_mut().zip(above) {
                    *target = (*target).min(*value);
                }
            }
        });
    output
}

#[cfg(test)]
fn fit_masked_surface(
    source: &GrayImage,
    candidate: &GrayImage,
    picture_mask: Option<&BinaryImage>,
) -> Option<SurfaceFit> {
    let surface_basis = SurfaceBasis::new(source.width(), source.height());
    fit_masked_surface_with_basis(source, candidate, picture_mask, &surface_basis)
}

fn fit_masked_surface_with_basis(
    source: &GrayImage,
    candidate: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    surface_basis: &SurfaceBasis,
) -> Option<SurfaceFit> {
    let mask = refined_surface_mask(source, candidate, picture_mask);
    let accepted = mask.iter().filter(|&&included| included).count();
    if accepted < SURFACE_TERMS * 2 {
        return None;
    }
    let mut robust_weights = vec![1.0; mask.len()];
    let mut coefficients = cholesky_solve_regularized(accumulate_surface_system(
        candidate,
        &mask,
        &robust_weights,
        surface_basis,
    ))?;
    for _ in 0..3 {
        update_huber_weights(
            candidate,
            &mask,
            surface_basis,
            &coefficients,
            &mut robust_weights,
        );
        coefficients = cholesky_solve_regularized(accumulate_surface_system(
            candidate,
            &mask,
            &robust_weights,
            surface_basis,
        ))?;
    }
    let mut residuals = surface_residuals(candidate, &mask, surface_basis, &coefficients);
    let median_absolute_residual = percentile(&mut residuals, 0.5);
    let p90_absolute_residual = percentile(&mut residuals, 0.9);
    let (minimum, maximum) = surface_range(surface_basis, &coefficients);
    let diagnostics = SurfaceDiagnostics {
        accepted_samples: accepted,
        median_absolute_residual,
        p90_absolute_residual,
        minimum,
        maximum,
    };
    validate_surface(diagnostics).then_some(SurfaceFit { coefficients, mask })
}

fn select_background_model(
    source: &GrayImage,
    candidate: GrayImage,
    fit: SurfaceFit,
    allow_reconstruction: bool,
) -> BackgroundModel {
    if !allow_reconstruction {
        return BackgroundModel::Surface(fit.coefficients);
    }
    let surface_basis = SurfaceBasis::new(source.width(), source.height());
    let surface_residual = masked_model_residual(
        source,
        &fit.mask,
        &surface_basis,
        Some(&fit.coefficients),
        None,
    );
    let reconstruction_residual =
        masked_model_residual(source, &fit.mask, &surface_basis, None, Some(&candidate));
    if reconstruction_residual < surface_residual {
        reconstruction_fallback(candidate)
    } else {
        BackgroundModel::Surface(fit.coefficients)
    }
}

/// Removal condition: this frozen pre-Stage-F solve exists only for
/// `normalize_illumination_for_layout`, whose output feeds split calibration
/// (`PageCalibration::estimate`, `detect_content_and_margins_calibrated`,
/// `otsu_threshold`, `detect_text_axis` in `engine/render.rs`). Delete it, and fold the
/// layout normalization onto `fit_masked_surface`, once split calibration is re-derived
/// against the Cholesky/IRLS model — the two differ in mask refinement, in robust
/// re-weighting and in solver, so merging them silently would move every calibrated
/// split. It shares only the deterministic symmetric accumulator; the legacy
/// mask and Gaussian solver remain frozen.
#[cfg(test)]
fn fit_masked_surface_legacy(source: &GrayImage, candidate: &GrayImage) -> Option<Vec<f64>> {
    let surface_basis = SurfaceBasis::new(source.width(), source.height());
    fit_masked_surface_legacy_with_basis(source, candidate, &surface_basis)
}

fn fit_masked_surface_legacy_with_basis(
    source: &GrayImage,
    candidate: &GrayImage,
    surface_basis: &SurfaceBasis,
) -> Option<Vec<f64>> {
    let mask = source
        .data()
        .iter()
        .zip(candidate.data())
        .map(|(&original, &background)| original.saturating_add(18) >= background)
        .collect::<Vec<_>>();
    if mask.iter().filter(|&&included| included).count() < SURFACE_TERMS * 2 {
        return None;
    }
    let system = accumulate_surface_system(candidate, &mask, &vec![1.0; mask.len()], surface_basis);
    solve(system, SURFACE_TERMS)
}

fn refined_surface_mask(
    source: &GrayImage,
    candidate: &GrayImage,
    picture_mask: Option<&BinaryImage>,
) -> Vec<bool> {
    let mut mask = vec![false; source.width() * source.height()];
    mask.par_chunks_mut(source.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, kept) in row.iter_mut().enumerate() {
                let picture = picture_mask.is_some_and(|pictures| {
                    let picture_x = if source.width() <= 1 {
                        0
                    } else {
                        x * pictures.width().saturating_sub(1) / (source.width() - 1)
                    };
                    let picture_y = if source.height() <= 1 {
                        0
                    } else {
                        y * pictures.height().saturating_sub(1) / (source.height() - 1)
                    };
                    pictures.get(picture_x, picture_y)
                });
                *kept = !picture && source.get(x, y).saturating_add(18) >= candidate.get(x, y);
            }
        });
    refine_line_mask(source, &mut mask, true, 3);
    refine_line_mask(source, &mut mask, false, 5);
    mask = erode_mask_3x3(&mask, source.width(), source.height());
    drop_sparse_lines(&mut mask, source.width(), source.height(), true);
    drop_sparse_lines(&mut mask, source.width(), source.height(), false);
    mask
}

fn refine_line_mask(source: &GrayImage, mask: &mut [bool], columns: bool, terms: usize) {
    let line_count = if columns {
        source.width()
    } else {
        source.height()
    };
    let line_length = if columns {
        source.height()
    } else {
        source.width()
    };
    let minimum_survivors = line_length.div_ceil(4);
    for line in 0..line_count {
        let samples = (0..line_length)
            .filter_map(|position| {
                let (x, y) = if columns {
                    (line, position)
                } else {
                    (position, line)
                };
                mask[y * source.width() + x].then_some((position, source.get(x, y)))
            })
            .collect::<Vec<_>>();
        if samples.len() < minimum_survivors.max(terms) {
            set_line(
                mask,
                source.width(),
                line_count,
                line_length,
                line,
                columns,
                false,
            );
            continue;
        }
        let Some(coefficients) = fit_line_polynomial(&samples, line_length, terms) else {
            set_line(
                mask,
                source.width(),
                line_count,
                line_length,
                line,
                columns,
                false,
            );
            continue;
        };
        for position in 0..line_length {
            let (x, y) = if columns {
                (line, position)
            } else {
                (position, line)
            };
            let index = y * source.width() + x;
            if mask[index]
                && f64::from(source.get(x, y)) + 30.0
                    < evaluate_line_polynomial(&coefficients, position, line_length)
            {
                mask[index] = false;
            }
        }
    }
}

fn set_line(
    mask: &mut [bool],
    width: usize,
    _line_count: usize,
    line_length: usize,
    line: usize,
    columns: bool,
    value: bool,
) {
    for position in 0..line_length {
        let (x, y) = if columns {
            (line, position)
        } else {
            (position, line)
        };
        mask[y * width + x] = value;
    }
}

fn fit_line_polynomial(
    samples: &[(usize, u8)],
    line_length: usize,
    terms: usize,
) -> Option<Vec<f64>> {
    let stride = terms + 1;
    let mut normal = vec![0.0; terms * stride];
    let mut powers = vec![1.0; terms];
    for &(position, value) in samples {
        let coordinate = normalized_coordinate(position, line_length);
        for power in 1..terms {
            powers[power] = powers[power - 1] * coordinate;
        }
        for row in 0..terms {
            let start = row * stride;
            for (accumulated, factor) in normal[start..start + terms].iter_mut().zip(&powers) {
                *accumulated += powers[row] * factor;
            }
            normal[start + terms] += powers[row] * f64::from(value);
        }
    }
    solve(normal, terms)
}

fn evaluate_line_polynomial(coefficients: &[f64], position: usize, length: usize) -> f64 {
    let coordinate = normalized_coordinate(position, length);
    coefficients
        .iter()
        .rev()
        .fold(0.0, |value, coefficient| value * coordinate + coefficient)
}

fn erode_mask_3x3(mask: &[bool], width: usize, height: usize) -> Vec<bool> {
    let mut eroded = vec![false; mask.len()];
    if width < 3 || height < 3 {
        return eroded;
    }
    eroded
        .par_chunks_mut(width)
        .enumerate()
        .skip(1)
        .take(height - 2)
        .for_each(|(y, row)| {
            for (x, kept) in row.iter_mut().enumerate().skip(1).take(width - 2) {
                *kept = (y - 1..=y + 1).all(|sample_y| {
                    (x - 1..=x + 1).all(|sample_x| mask[sample_y * width + sample_x])
                });
            }
        });
    eroded
}

fn drop_sparse_lines(mask: &mut [bool], width: usize, height: usize, columns: bool) {
    let line_count = if columns { width } else { height };
    let line_length = if columns { height } else { width };
    let minimum_survivors = line_length.div_ceil(4);
    for line in 0..line_count {
        let survivors = (0..line_length)
            .filter(|&position| {
                let (x, y) = if columns {
                    (line, position)
                } else {
                    (position, line)
                };
                mask[y * width + x]
            })
            .count();
        if survivors < minimum_survivors {
            set_line(mask, width, line_count, line_length, line, columns, false);
        }
    }
}

fn update_huber_weights(
    target: &GrayImage,
    mask: &[bool],
    surface_basis: &SurfaceBasis,
    coefficients: &[f64],
    weights: &mut [f64],
) {
    const HUBER_DELTA: f64 = 10.0;
    weights
        .par_chunks_mut(target.width())
        .zip(mask.par_chunks(target.width()))
        .zip(target.data().par_chunks(target.width()))
        .enumerate()
        .for_each(|(y, ((weight_row, mask_row), target_row))| {
            for x in 0..target.width() {
                if !mask_row[x] {
                    weight_row[x] = 0.0;
                    continue;
                }
                let basis = surface_basis.at(x, y);
                let residual =
                    (evaluate_surface(coefficients, &basis) - f64::from(target_row[x])).abs();
                weight_row[x] = if residual <= HUBER_DELTA {
                    1.0
                } else {
                    HUBER_DELTA / residual
                };
            }
        });
}

fn masked_model_residual(
    source: &GrayImage,
    mask: &[bool],
    surface_basis: &SurfaceBasis,
    coefficients: Option<&[f64]>,
    reconstruction: Option<&GrayImage>,
) -> f64 {
    let mut residual_sum = 0.0;
    let mut count = 0usize;
    for y in 0..source.height() {
        for x in 0..source.width() {
            let index = y * source.width() + x;
            if !mask[index] {
                continue;
            }
            let basis = surface_basis.at(x, y);
            let model_value = coefficients.map_or_else(
                || f64::from(reconstruction.expect("model candidate is required").data()[index]),
                |coefficients| evaluate_surface(coefficients, &basis),
            );
            residual_sum += (model_value - f64::from(source.data()[index])).abs();
            count += 1;
        }
    }
    residual_sum / count.max(1) as f64
}

/// One flat allocation for the whole normal system: row-major, `SURFACE_TERMS` rows of
/// `SURFACE_STRIDE` columns, with the right-hand side living in the last column.
/// `SURFACE_TERMS` separate heap rows were the difference between a bounds-checked
/// scalar accumulation and a vectorised one.
const SURFACE_STRIDE: usize = SURFACE_TERMS + 1;
const SURFACE_SYSTEM_LEN: usize = SURFACE_TERMS * SURFACE_STRIDE;
const SURFACE_SAMPLE_CHUNK: usize = 1_024;

/// Accumulates the weighted normal equations for the tensor Chebyshev surface.
///
/// Fixed sample chunks keep the forty-term basis in cache while accumulating the
/// symmetric normal matrix. Parallel collection preserves chunk order, and the ordered
/// reduction below makes the result deterministic regardless of the Rayon thread count.
/// The previous matrix-row parallelism reread a large per-pixel basis forty times per
/// robust-fit pass, turning a small least-squares problem into gigabytes of memory traffic.
fn accumulate_surface_system(
    target: &GrayImage,
    mask: &[bool],
    robust_weights: &[f64],
    surface_basis: &SurfaceBasis,
) -> Vec<f64> {
    debug_assert_eq!(target.data().len(), mask.len());
    debug_assert_eq!(mask.len(), robust_weights.len());
    let border_x = target.width() / 30;
    let partials = target
        .data()
        .par_chunks(SURFACE_SAMPLE_CHUNK)
        .zip(mask.par_chunks(SURFACE_SAMPLE_CHUNK))
        .zip(robust_weights.par_chunks(SURFACE_SAMPLE_CHUNK))
        .enumerate()
        .map(
            |(chunk_index, ((target_chunk, mask_chunk), weight_chunk))| {
                let mut partial = vec![0.0; SURFACE_SYSTEM_LEN];
                let base = chunk_index * SURFACE_SAMPLE_CHUNK;
                for offset in 0..target_chunk.len() {
                    if !mask_chunk[offset] {
                        continue;
                    }
                    let index = base + offset;
                    let x = index % target.width();
                    let y = index / target.width();
                    let border_weight = if x < border_x || x + border_x >= target.width() {
                        0.4
                    } else {
                        1.0
                    };
                    let sample_weight = border_weight * weight_chunk[offset];
                    let basis = surface_basis.at(x, y);
                    for row in 0..SURFACE_TERMS {
                        let slots = &mut partial[row * SURFACE_STRIDE..(row + 1) * SURFACE_STRIDE];
                        let weighted = sample_weight * basis[row];
                        for (accumulated, factor) in slots[..=row].iter_mut().zip(&basis[..=row]) {
                            *accumulated += weighted * factor;
                        }
                        slots[SURFACE_TERMS] += weighted * f64::from(target_chunk[offset]);
                    }
                }
                partial
            },
        )
        .collect::<Vec<_>>();
    let mut system = vec![0.0; SURFACE_SYSTEM_LEN];
    for partial in partials {
        for (accumulated, value) in system.iter_mut().zip(partial) {
            *accumulated += value;
        }
    }
    for row in 0..SURFACE_TERMS {
        for column in 0..row {
            system[column * SURFACE_STRIDE + row] = system[row * SURFACE_STRIDE + column];
        }
    }
    system
}

fn evaluate_surface_at(
    coefficients: &[f64],
    surface_basis: &SurfaceBasis,
    x: usize,
    y: usize,
) -> f64 {
    let basis = surface_basis.at(x, y);
    evaluate_surface(coefficients, &basis)
}

fn surface_residuals(
    target: &GrayImage,
    mask: &[bool],
    surface_basis: &SurfaceBasis,
    coefficients: &[f64],
) -> Vec<f64> {
    let mut residuals = Vec::new();
    for y in 0..target.height() {
        for x in 0..target.width() {
            let index = y * target.width() + x;
            if mask[index] {
                residuals.push(
                    (evaluate_surface_at(coefficients, surface_basis, x, y)
                        - f64::from(target.data()[index]))
                    .abs(),
                );
            }
        }
    }
    residuals
}

fn fill_surface_basis(
    basis: &mut [f64; SURFACE_TERMS],
    x_values: &[f64; X_TERMS],
    y_values: &[f64; Y_TERMS],
    terms: usize,
) {
    for (term, value) in basis[..terms].iter_mut().enumerate() {
        *value = x_values[term % X_TERMS] * y_values[term / X_TERMS];
    }
}

fn evaluate_surface(coefficients: &[f64], basis: &[f64; SURFACE_TERMS]) -> f64 {
    coefficients
        .iter()
        .zip(basis)
        .map(|(coefficient, value)| coefficient * value)
        .sum()
}

fn surface_range(surface_basis: &SurfaceBasis, coefficients: &[f64]) -> (f64, f64) {
    let mut minimum = f64::INFINITY;
    let mut maximum = f64::NEG_INFINITY;
    for y in 0..surface_basis.y.len() {
        for x in 0..surface_basis.x.len() {
            let value = evaluate_surface_at(coefficients, surface_basis, x, y);
            minimum = minimum.min(value);
            maximum = maximum.max(value);
        }
    }
    (minimum, maximum)
}

fn validate_surface(diagnostics: SurfaceDiagnostics) -> bool {
    diagnostics.accepted_samples >= SURFACE_TERMS * 2
        && diagnostics.median_absolute_residual.is_finite()
        && diagnostics.p90_absolute_residual.is_finite()
        && diagnostics.minimum.is_finite()
        && diagnostics.maximum.is_finite()
        && diagnostics.p90_absolute_residual <= 32.0
        && diagnostics.minimum >= 1.0
        && diagnostics.maximum <= 320.0
        && diagnostics.maximum - diagnostics.minimum <= 255.0
}

fn percentile(values: &mut [f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return f64::INFINITY;
    }
    values.sort_unstable_by(f64::total_cmp);
    let position = (values.len() - 1) as f64 * fraction;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        values[lower]
    } else {
        values[lower] * (upper as f64 - position) + values[upper] * (position - lower as f64)
    }
}

fn robust_image_percentile(image: &GrayImage, fraction: f64) -> f64 {
    let mut histogram = [0usize; 256];
    for &value in image.data() {
        histogram[value as usize] += 1;
    }
    let target =
        ((image.width() * image.height()).saturating_sub(1) as f64 * fraction).round() as usize;
    let mut cumulative = 0usize;
    for (value, count) in histogram.into_iter().enumerate() {
        cumulative += count;
        if cumulative > target {
            return value as f64;
        }
    }
    255.0
}

fn cholesky_solve_regularized(mut system: Vec<f64>) -> Option<Vec<f64>> {
    const SIZE: usize = SURFACE_TERMS;
    let trace = (0..SIZE)
        .map(|index| system[index * SURFACE_STRIDE + index])
        .sum::<f64>();
    let regularization = 1e-4 * trace / SIZE as f64;
    for index in 0..SIZE {
        system[index * SURFACE_STRIDE + index] += regularization;
    }
    let mut lower = vec![0.0; SIZE * SIZE];
    for row in 0..SIZE {
        for column in 0..=row {
            let previous = (0..column)
                .map(|index| lower[row * SIZE + index] * lower[column * SIZE + index])
                .sum::<f64>();
            if row == column {
                let diagonal = system[row * SURFACE_STRIDE + row] - previous;
                if !diagonal.is_finite() || diagonal <= 1e-12 {
                    return None;
                }
                lower[row * SIZE + column] = diagonal.sqrt();
            } else {
                lower[row * SIZE + column] = (system[row * SURFACE_STRIDE + column] - previous)
                    / lower[column * SIZE + column];
            }
        }
    }
    let mut intermediate = [0.0; SIZE];
    for row in 0..SIZE {
        let previous = (0..row)
            .map(|column| lower[row * SIZE + column] * intermediate[column])
            .sum::<f64>();
        intermediate[row] =
            (system[row * SURFACE_STRIDE + SURFACE_TERMS] - previous) / lower[row * SIZE + row];
    }
    let mut solution = vec![0.0; SIZE];
    for row in (0..SIZE).rev() {
        let previous = (row + 1..SIZE)
            .map(|column| lower[column * SIZE + row] * solution[column])
            .sum::<f64>();
        solution[row] = (intermediate[row] - previous) / lower[row * SIZE + row];
    }
    solution
        .iter()
        .all(|value| value.is_finite())
        .then_some(solution)
}

fn source_coordinate(value: usize, source_length: usize, target_length: usize) -> f64 {
    if source_length <= 1 || target_length <= 1 {
        0.0
    } else {
        value as f64 * (target_length - 1) as f64 / (source_length - 1) as f64
    }
}

fn sample_bilinear(image: &GrayImage, x: f64, y: f64) -> f64 {
    let x0 = x.floor().clamp(0.0, image.width().saturating_sub(1) as f64) as usize;
    let y0 = y
        .floor()
        .clamp(0.0, image.height().saturating_sub(1) as f64) as usize;
    let x1 = (x0 + 1).min(image.width().saturating_sub(1));
    let y1 = (y0 + 1).min(image.height().saturating_sub(1));
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let top = f64::from(image.get(x0, y0)) * (1.0 - fx) + f64::from(image.get(x1, y0)) * fx;
    let bottom = f64::from(image.get(x0, y1)) * (1.0 - fx) + f64::from(image.get(x1, y1)) * fx;
    top * (1.0 - fy) + bottom * fy
}

fn normalized_coordinate(value: usize, length: usize) -> f64 {
    if length <= 1 {
        0.0
    } else {
        2.0 * value as f64 / (length - 1) as f64 - 1.0
    }
}
fn chebyshev_basis<const TERMS: usize>(value: f64) -> [f64; TERMS] {
    let mut result = [0.0; TERMS];
    if TERMS > 0 {
        result[0] = 1.0;
    }
    if TERMS > 1 {
        result[1] = value;
    }
    for index in 2..TERMS {
        result[index] = 2.0 * value * result[index - 1] - result[index - 2];
    }
    result
}

fn precompute_chebyshev<const TERMS: usize>(length: usize) -> Vec<[f64; TERMS]> {
    (0..length)
        .map(|value| chebyshev_basis(normalized_coordinate(value, length)))
        .collect()
}

/// Gauss-Jordan with partial pivoting over a row-major augmented matrix of `size` rows
/// and `size + 1` columns, the right-hand side in the last column.
fn solve(mut matrix: Vec<f64>, size: usize) -> Option<Vec<f64>> {
    let stride = size + 1;
    for pivot in 0..size {
        let best = (pivot..size).max_by(|&a, &b| {
            matrix[a * stride + pivot]
                .abs()
                .total_cmp(&matrix[b * stride + pivot].abs())
        })?;
        if matrix[best * stride + pivot].abs() < 1e-9 {
            return None;
        }
        for column in 0..stride {
            matrix.swap(pivot * stride + column, best * stride + column);
        }
        let divisor = matrix[pivot * stride + pivot];
        for column in pivot..stride {
            matrix[pivot * stride + column] /= divisor;
        }
        for row in 0..size {
            if row == pivot {
                continue;
            }
            let factor = matrix[row * stride + pivot];
            for column in pivot..stride {
                matrix[row * stride + column] -= factor * matrix[pivot * stride + column];
            }
        }
    }
    Some((0..size).map(|row| matrix[row * stride + size]).collect())
}

pub(crate) fn smooth_for_binarization(source: &GrayImage, dpi: f64) -> GrayImage {
    let radius = ((dpi / 150.0).round() as usize).clamp(1, 4);
    let coefficients = smoothing_coefficients(radius, 2);
    if coefficients.iter().enumerate().all(|(index, &value)| {
        let expected = f64::from(index == radius);
        (value - expected).abs() < 1e-12
    }) {
        return source.clone();
    }
    let mut horizontal = GrayImage::new(source.width(), source.height(), 255);
    horizontal
        .data_mut()
        .par_chunks_mut(source.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                *target = convolve(source, x, y, true, &coefficients, radius);
            }
        });
    let mut output = GrayImage::new(source.width(), source.height(), 255);
    output
        .data_mut()
        .par_chunks_mut(source.width())
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                *target = convolve(&horizontal, x, y, false, &coefficients, radius);
            }
        });
    output
}

fn smoothing_coefficients(radius: usize, degree: usize) -> Vec<f64> {
    let terms = degree + 1;
    let stride = terms + 1;
    let mut normal = vec![0.0; terms * stride];
    for offset in -(radius as isize)..=radius as isize {
        let x = offset as f64;
        let powers: Vec<f64> = (0..terms).map(|power| x.powi(power as i32)).collect();
        for row in 0..terms {
            let start = row * stride;
            for (accumulated, factor) in normal[start..start + terms].iter_mut().zip(&powers) {
                *accumulated += powers[row] * factor;
            }
            normal[start + terms] += f64::from(row == 0);
        }
    }
    let polynomial =
        solve(normal, terms).unwrap_or_else(|| vec![1.0 / (radius * 2 + 1) as f64; terms]);
    (-(radius as isize)..=radius as isize)
        .map(|offset| {
            polynomial
                .iter()
                .enumerate()
                .map(|(power, coefficient)| coefficient * (offset as f64).powi(power as i32))
                .sum()
        })
        .collect()
}

fn convolve(
    source: &GrayImage,
    x: usize,
    y: usize,
    horizontal: bool,
    coefficients: &[f64],
    radius: usize,
) -> u8 {
    let mut sum = 0.0;
    let mut weight = 0.0;
    for (index, &coefficient) in coefficients.iter().enumerate() {
        let offset = index as isize - radius as isize;
        let sx = if horizontal {
            x.saturating_add_signed(offset).min(source.width() - 1)
        } else {
            x
        };
        let sy = if horizontal {
            y
        } else {
            y.saturating_add_signed(offset).min(source.height() - 1)
        };
        sum += coefficient * f64::from(source.get(sx, sy));
        weight += coefficient;
    }
    (sum / weight.max(1e-9)).round().clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_flattens_a_gradient_without_erasing_ink() {
        let mut image = GrayImage::new(120, 80, 255);
        for y in 0..80 {
            for x in 0..120 {
                let background = 170 + x * 70 / 119;
                image.set(x, y, background as u8);
            }
        }
        for y in 30..35 {
            for x in 20..100 {
                image.set(x, y, 30);
            }
        }
        let normalized = normalize_illumination(&image, 300.0);
        assert!(
            i16::from(normalized.get(10, 10)).abs_diff(i16::from(normalized.get(110, 10))) < 20
        );
        assert!(normalized.get(50, 32) < 80);
    }

    #[test]
    fn masked_semantic_gradient_uses_robust_multiplicative_white_balance() {
        let mut source = GrayImage::new(240, 180, 210);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, (196 + 18 * x / 239 + 8 * y / 179) as u8);
            }
        }
        let mut semantic_mask = BinaryImage::new(source.width(), source.height());
        let mut semantic_alpha = GrayImage::new(source.width(), source.height(), 0);
        let center_x = 120.0;
        let center_y = 90.0;
        for y in 28..152 {
            for x in 48..192 {
                semantic_mask.set(x, y, true);
                semantic_alpha.set(x, y, 255);
                let radius =
                    (((x as f64 - center_x).powi(2) + (y as f64 - center_y).powi(2)).sqrt() / 82.0)
                        .clamp(0.0, 1.0);
                source.set(x, y, (42.0 + 164.0 * radius).round() as u8);
            }
        }

        let normalized = normalize_illumination_with_masks(
            &source,
            300.0,
            Some(&semantic_mask),
            Some(&semantic_alpha),
            None,
        );

        assert!(normalized.get(12, 12) >= 245);
        assert!(normalized.get(120, 90) < 80);
        let middle = normalized.get(160, 90);
        assert!(
            (110..=190).contains(&middle),
            "semantic middle tone was flattened: {middle}"
        );
    }

    #[test]
    fn surface_fit_reports_bounded_residuals_and_sparse_input_uses_fallback() {
        let mut source = GrayImage::new(120, 80, 230);
        let mut candidate = GrayImage::new(120, 80, 230);
        for y in 0..80 {
            for x in 0..120 {
                let value = 175 + (55 * x / 119) + (8 * y / 79);
                source.set(x, y, value as u8);
                candidate.set(x, y, value as u8);
            }
        }
        let fit = fit_masked_surface(&source, &candidate, None).expect("smooth surface must fit");
        let surface_basis = SurfaceBasis::new(source.width(), source.height());
        let mut residuals =
            surface_residuals(&candidate, &fit.mask, &surface_basis, &fit.coefficients);
        assert_eq!(fit.mask.iter().filter(|&&kept| kept).count(), 118 * 78);
        assert!(percentile(&mut residuals, 0.5) < 0.75);
        assert!(percentile(&mut residuals, 0.9) < 1.5);

        let sparse = GrayImage::new(8, 8, 220);
        assert!(fit_masked_surface(&sparse, &sparse, None).is_none());
        let normalized = normalize_illumination(&sparse, 300.0);
        assert!(normalized.data().iter().all(|value| *value >= 230));
    }

    #[test]
    fn ridge_keeps_a_quadrant_only_surface_system_bounded() {
        let mut source = GrayImage::new(120, 80, 0);
        let candidate = GrayImage::new(120, 80, 220);
        for y in 0..40 {
            for x in 0..60 {
                source.set(x, y, 220);
            }
        }
        let surface_basis = SurfaceBasis::new(source.width(), source.height());
        let mask = refined_surface_mask(&source, &candidate, None);
        let accepted = mask.iter().filter(|&&included| included).count();
        let system =
            accumulate_surface_system(&candidate, &mask, &vec![1.0; mask.len()], &surface_basis);
        let coefficients = cholesky_solve_regularized(system)
            .expect("ridge must solve a quadrant-only sample distribution");
        let (minimum, maximum) = surface_range(&surface_basis, &coefficients);

        assert!(accepted >= SURFACE_TERMS * 2);
        assert!(minimum.is_finite() && maximum.is_finite());
        assert!(minimum >= -64.0, "minimum={minimum}");
        assert!(maximum <= 320.0, "maximum={maximum}");
    }

    #[test]
    fn degenerate_picture_mask_keeps_the_selected_background_bounded() {
        let mut source = GrayImage::new(140, 100, 225);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, (180 + 40 * x / (source.width() - 1)) as u8);
            }
        }
        let mut picture_mask = BinaryImage::new(source.width(), source.height());
        for y in 0..source.height() {
            for x in 0..source.width() {
                picture_mask.set(x, y, x >= 42 || y >= 34);
            }
        }
        let normalized =
            normalize_illumination_with_picture_mask(&source, 300.0, Some(&picture_mask));
        let minimum = normalized.data().iter().copied().min().unwrap_or(255);
        assert!(
            normalized.data().iter().all(|&value| value >= 254),
            "a smooth paper field remained visibly shaded: minimum={minimum}"
        );
    }

    #[test]
    fn paper_surface_excludes_a_dark_picture_and_avoids_a_bright_boundary_ring() {
        let mut source = GrayImage::new(240, 180, 230);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, (214 + x * 16 / (source.width() - 1)) as u8);
            }
        }
        let mut picture_mask = BinaryImage::new(source.width(), source.height());
        for y in 42..138 {
            for x in 66..174 {
                picture_mask.set(x, y, true);
                source.set(
                    x,
                    y,
                    if y < 90 {
                        36 + ((x * 13 + y * 7) % 28) as u8
                    } else {
                        190 + ((x * 5 + y * 3) % 20) as u8
                    },
                );
            }
        }

        let normalized =
            normalize_illumination_with_masks(&source, 300.0, Some(&picture_mask), None, None);
        let paper_reference = normalized.get(40, 90);
        let left_boundary = normalized.get(65, 90);
        let right_boundary = normalized.get(174, 90);
        let light_picture = normalized.get(120, 110);

        assert!(
            paper_reference >= 250
                && left_boundary.abs_diff(paper_reference) <= 4
                && right_boundary.abs_diff(paper_reference) <= 4,
            "picture boundary changed the paper endpoint: reference={paper_reference}, left={left_boundary}, right={right_boundary}"
        );
        assert!(
            normalized.get(120, 60) < 120,
            "dark picture tone was brightened by the paper surface: {}",
            normalized.get(120, 60)
        );
        assert!(
            light_picture <= 250,
            "the paper fit brightened a light picture tone to white: {light_picture}"
        );
    }

    #[test]
    fn quality_model_never_applies_content_shaped_reconstruction() {
        let mut source = GrayImage::new(180, 120, 230);
        for y in 25..95 {
            for x in 65..145 {
                let edge_distance = (x - 65).min(144 - x).min((y - 25).min(94 - y));
                let shadow = (edge_distance.min(18) * 24 / 18) as u8;
                source.set(x, y, 230 - shadow);
            }
        }
        let (small, candidate) = reconstructed_background(&source);
        let fit = fit_masked_surface(&small, &candidate, None)
            .expect("the local-shadow fixture must retain enough surface samples");
        let model = select_background_model(&small, candidate, fit, false);
        assert!(matches!(model, BackgroundModel::Surface(_)));
    }

    #[test]
    fn layout_white_point_stays_frozen_while_quality_paper_reaches_display_white() {
        let source = GrayImage::new(180, 120, 184);
        let preparation = prepare_illumination(&source);
        let layout = normalize_illumination_for_layout_prepared(&source, &preparation);
        let quality = normalize_illumination_prepared_with_masks(
            &source,
            None,
            None,
            None,
            None,
            preparation,
        );

        assert_eq!(layout.get(90, 60), LAYOUT_WHITE_TARGET as u8);
        assert_eq!(quality.get(90, 60), PAPER_WHITE_TARGET as u8);
    }

    #[test]
    fn paper_shoulder_removes_low_contrast_show_through_but_keeps_sharp_faint_ink() {
        // The background model normally maps the dominant paper cluster to
        // 255 before this calibration runs. Keep that realistic endpoint here
        // so the test catches an accidental early return before the shoulder.
        let mut normalized = GrayImage::new(240, 180, 255);
        for y in 40..72 {
            for x in 36..92 {
                normalized.set(x, y, 226);
            }
        }
        for y in 104..116 {
            for x in 52..188 {
                normalized.set(x, y, 174);
            }
        }

        calibrate_paper_field(&mut normalized, None, None, None);

        assert!(normalized.get(64, 56) >= 248);
        assert!(normalized.get(120, 110) <= 190);
        assert_eq!(normalized.get(12, 12), 255);
    }

    #[test]
    fn paper_shoulder_keeps_sparse_low_contrast_marks_on_the_base_curve() {
        let mut normalized = GrayImage::new(240, 180, 255);
        for y in 60..72 {
            for x in 80..112 {
                normalized.set(x, y, 220);
            }
        }

        calibrate_paper_field(&mut normalized, None, None, None);

        assert_eq!(normalized.get(90, 66), 220);
        assert_eq!(normalized.get(12, 12), 255);
    }

    #[test]
    fn paper_shoulder_does_not_lift_protected_faint_text() {
        let mut normalized = GrayImage::new(240, 180, 255);
        let mut protected = BinaryImage::new(240, 180);
        for y in 36..104 {
            for x in 28..118 {
                normalized.set(x, y, 220);
            }
        }
        for y in 120..132 {
            for x in 64..176 {
                normalized.set(x, y, 220);
                protected.set(x, y, true);
            }
        }

        calibrate_paper_field(&mut normalized, None, None, Some(&protected));

        assert!(normalized.get(72, 64) >= 246);
        assert_eq!(normalized.get(100, 126), 220);
    }

    #[test]
    fn color_normalization_matches_real_gutter_fixture_golden() {
        let decoded = crate::io::png::decode_image(
            include_bytes!("../tests/fixtures/split/spread-luther-soft-gutter-p00001.png"),
            crate::DEFAULT_MAX_PIXELS,
            crate::DEFAULT_MAX_DIMENSION,
        )
        .unwrap();
        let normalized = normalize_illumination_rgb(&decoded.gray, &decoded.rgb, 300.0);
        let mut checksum = crc32fast::Hasher::new();
        for y in 0..normalized.height() {
            checksum.update(normalized.row(y));
        }

        assert_eq!(checksum.finalize(), 3_785_375_702);
    }

    #[test]
    fn mixed_normalization_whitens_uniform_tinted_paper_outside_protected_color() {
        let mut rgb = RgbImage::new(240, 180, [205, 225, 245]);
        for y in 60..68 {
            for x in 28..132 {
                rgb.set(x, y, [25, 29, 34]);
            }
        }
        for y in 42..128 {
            for x in 160..214 {
                rgb.set(x, y, [220, 48, 42]);
            }
        }
        let mut luminance = GrayImage::new(rgb.width(), rgb.height(), 0);
        for y in 0..rgb.height() {
            for x in 0..rgb.width() {
                let pixel = rgb.get(x, y);
                luminance.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8,
                );
            }
        }
        let mut picture_mask = BinaryImage::new(120, 90);
        for y in 21..64 {
            for x in 80..107 {
                picture_mask.set(x, y, true);
            }
        }

        let (normalized_gray, normalized_rgb) =
            normalize_illumination_pair_with_picture_mask(&luminance, &rgb, Some(&picture_mask));

        assert!(normalized_gray.get(20, 20) >= 250);
        assert!(normalized_rgb
            .get(20, 20)
            .iter()
            .all(|&channel| channel >= 250));
        let ink = normalized_rgb.get(60, 64);
        assert!(ink.iter().copied().max().unwrap_or(255) < 64);
        let protected_red = normalized_rgb.get(180, 80);
        assert!(
            protected_red[0] > protected_red[1].saturating_mul(2),
            "{protected_red:?}"
        );
        assert!(
            protected_red[0] > protected_red[2].saturating_mul(2),
            "{protected_red:?}"
        );
    }

    #[test]
    fn mixed_normalization_recovers_paper_like_pixels_inside_an_overbroad_picture_mask() {
        let mut source = GrayImage::new(240, 180, 220);
        for y in 24..156 {
            for x in 118..228 {
                let edge_distance = (x - 118).min(227 - x).min((y - 24).min(155 - y));
                source.set(x, y, 220_u8.saturating_sub(edge_distance.min(18) as u8));
            }
        }
        for y in 54..126 {
            for x in 146..208 {
                source.set(x, y, 45 + ((x * 7 + y * 11) % 105) as u8);
            }
        }
        let mut picture_mask = BinaryImage::new(120, 90);
        for y in 12..78 {
            for x in 59..114 {
                picture_mask.set(x, y, true);
            }
        }

        let normalized =
            normalize_illumination_with_picture_mask(&source, 300.0, Some(&picture_mask));

        assert!(
            normalized.get(128, 40) >= 250,
            "paper-like mask halo remained gray: {}",
            normalized.get(128, 40)
        );
        assert!(
            normalized.get(176, 90) < 200,
            "the protected photograph was mistaken for paper: {}",
            normalized.get(176, 90)
        );
        assert_eq!(
            normalized.get(176, 90),
            source.get(176, 90),
            "protected grayscale tone must not be flattened by the paper model"
        );
    }

    #[test]
    fn prepared_mixed_normalization_matches_the_final_paper_recovery_path() {
        let mut source = GrayImage::new(240, 180, 218);
        for y in 38..142 {
            for x in 124..220 {
                source.set(x, y, 48 + ((x * 5 + y * 9) % 150) as u8);
            }
        }
        let mut picture_mask = BinaryImage::new(120, 90);
        for y in 16..76 {
            for x in 57..114 {
                picture_mask.set(x, y, true);
            }
        }

        let direct = normalize_illumination_with_picture_mask(&source, 150.0, Some(&picture_mask));
        let prepared = normalize_illumination_prepared(
            &source,
            Some(&picture_mask),
            prepare_illumination(&source),
        );

        assert_eq!(prepared, direct);
        assert!(prepared.get(30, 30) >= 250);
    }

    #[test]
    fn corroborated_tonal_mask_preserves_picture_interior_and_feathers_boundaries() {
        let mut source = GrayImage::new(180, 120, 208);
        let mut protected = BinaryImage::new(180, 120);
        for y in 24..96 {
            for x in 42..138 {
                protected.set(x, y, true);
                source.set(x, y, 18 + ((x * 3 + y * 5) % 208) as u8);
            }
        }

        let normalized = normalize_illumination_preserving_tone(&source, 150.0, &protected);

        assert!(normalized.get(12, 12) >= 250);
        assert_eq!(normalized.get(80, 60), source.get(80, 60));
        for (x, y) in [(42, 24), (137, 95)] {
            assert!(normalized.get(x, y) >= source.get(x, y));
            assert!(normalized.get(x, y) < 200);
        }
    }

    #[test]
    fn mixed_normalization_handles_large_photos_on_varied_uniform_paper_tints() {
        for paper in [
            [176, 176, 176],
            [176, 202, 228],
            [228, 207, 176],
            [180, 222, 194],
        ] {
            let mut rgb = RgbImage::new(360, 240, paper);
            for line in 0..8 {
                let top = 24 + line * 24;
                for y in top..top + 7 {
                    for x in 20..146 {
                        rgb.set(x, y, [28, 31, 35]);
                    }
                }
            }
            for y in 18..222 {
                for x in 170..342 {
                    let horizontal = ((x - 170) * 150 / 171) as u8;
                    let vertical = ((y - 18) * 100 / 203) as u8;
                    rgb.set(
                        x,
                        y,
                        [
                            35_u8.saturating_add(horizontal),
                            26_u8.saturating_add(vertical),
                            112_u8.saturating_add(horizontal / 2),
                        ],
                    );
                }
            }
            let mut luminance = GrayImage::new(rgb.width(), rgb.height(), 0);
            for y in 0..rgb.height() {
                for x in 0..rgb.width() {
                    let pixel = rgb.get(x, y);
                    luminance.set(
                        x,
                        y,
                        ((u32::from(pixel[0]) * 77
                            + u32::from(pixel[1]) * 150
                            + u32::from(pixel[2]) * 29
                            + 128)
                            >> 8) as u8,
                    );
                }
            }
            let mut picture_mask = BinaryImage::new(180, 120);
            for y in 9..111 {
                for x in 85..171 {
                    picture_mask.set(x, y, true);
                }
            }

            let (normalized_gray, normalized_rgb) = normalize_illumination_pair_with_picture_mask(
                &luminance,
                &rgb,
                Some(&picture_mask),
            );

            assert!(
                normalized_gray.get(154, 228) >= 248,
                "paper={paper:?}, gray={}",
                normalized_gray.get(154, 228)
            );
            assert!(
                normalized_rgb
                    .get(154, 228)
                    .iter()
                    .all(|&channel| channel >= 248),
                "paper={paper:?}, rgb={:?}",
                normalized_rgb.get(154, 228)
            );
            assert!(
                normalized_gray.get(80, 75) < 96,
                "paper={paper:?}, ink={}",
                normalized_gray.get(80, 75)
            );
            let protected = normalized_rgb.get(280, 120);
            assert!(
                protected[2] > protected[1] && protected[0] > protected[1],
                "paper={paper:?}, protected={protected:?}"
            );
        }
    }

    #[test]
    fn full_bleed_color_uses_ratio_preserving_conservative_levels() {
        let mut rgb = RgbImage::new(240, 180, [72, 19, 16]);
        for y in 0..rgb.height() {
            for x in 0..rgb.width() {
                let texture = ((x * 17 + y * 11 + x * y % 31) % 35) as u8;
                rgb.set(
                    x,
                    y,
                    [
                        62_u8.saturating_add(texture),
                        15_u8.saturating_add(texture / 4),
                        13_u8.saturating_add(texture / 5),
                    ],
                );
            }
        }
        for y in 35..65 {
            for x in 40..200 {
                rgb.set(x, y, [175, 145, 78]);
            }
        }
        let mut luminance = GrayImage::new(rgb.width(), rgb.height(), 0);
        for y in 0..rgb.height() {
            for x in 0..rgb.width() {
                let pixel = rgb.get(x, y);
                luminance.set(
                    x,
                    y,
                    ((u32::from(pixel[0]) * 77
                        + u32::from(pixel[1]) * 150
                        + u32::from(pixel[2]) * 29
                        + 128)
                        >> 8) as u8,
                );
            }
        }

        let model = background_model(&luminance, None);
        assert!(!paper_background_plausible(&luminance, &model));
        let normalized = normalize_illumination_rgb(&luminance, &rgb, 300.0);
        let mut maximum_ratio_error = 0.0_f64;
        let mut source_luminance_sum = 0_u64;
        let mut output_luminance_sum = 0_u64;
        for y in 0..rgb.height() {
            for x in 0..rgb.width() {
                let before = rgb.get(x, y);
                let after = normalized.get(x, y);
                source_luminance_sum += u64::from(luminance.get(x, y));
                output_luminance_sum += u64::from(
                    ((u32::from(after[0]) * 77
                        + u32::from(after[1]) * 150
                        + u32::from(after[2]) * 29
                        + 128)
                        >> 8) as u8,
                );
                for channel in 1..3 {
                    let before_ratio = f64::from(before[channel]) / f64::from(before[0]).max(1.0);
                    let after_ratio = f64::from(after[channel]) / f64::from(after[0]).max(1.0);
                    maximum_ratio_error =
                        maximum_ratio_error.max((before_ratio - after_ratio).abs());
                }
            }
        }
        assert!(
            maximum_ratio_error < 0.025,
            "channel ratio changed by {maximum_ratio_error}"
        );
        assert!(
            output_luminance_sum < source_luminance_sum * 13 / 10,
            "full-bleed fixture was washed out"
        );
        assert!(
            normalized.get(10, 10)[0] < 130,
            "full-bleed dark color was mistaken for paper: {:?}",
            normalized.get(10, 10)
        );
        let reusable = reusable_illumination_model(&luminance);
        let detail =
            normalize_rgb_region_with_reusable_model(&luminance, &rgb, &reusable, |x, y| {
                (
                    normalized_coordinate(x, rgb.width()),
                    normalized_coordinate(y, rgb.height()),
                )
            });
        assert!(
            detail.get(10, 10)[0] < 130,
            "detail renderer mistook full-bleed dark color for paper: {:?}",
            detail.get(10, 10)
        );
        let (_, paired) = normalize_illumination_pair_with_picture_mask(&luminance, &rgb, None);
        assert!(
            paired.get(10, 10)[0] < 130,
            "paired renderer mistook full-bleed dark color for paper: {:?}",
            paired.get(10, 10)
        );
    }

    #[test]
    fn savgol_is_an_explicit_bw_only_step() {
        let mut source = GrayImage::new(31, 31, 220);
        for y in 8..23 {
            source.set(15, y, if y % 2 == 0 { 15 } else { 75 });
        }
        let normalized = normalize_illumination(&source, 300.0);
        let threshold_input = smooth_for_binarization(&normalized, 300.0);
        assert_ne!(normalized, threshold_input);
        assert!(normalized.get(15, 14).abs_diff(normalized.get(15, 15)) > 20);
    }

    fn gutter_fixture() -> GrayImage {
        crate::io::png::decode_image(
            include_bytes!("../tests/fixtures/split/spread-luther-soft-gutter-p00001.png"),
            crate::DEFAULT_MAX_PIXELS,
            crate::DEFAULT_MAX_DIMENSION,
        )
        .expect("gutter fixture decodes")
        .gray
    }

    fn surface_at(coefficients: &[f64], u: f64, v: f64) -> f64 {
        let mut basis = [0.0; SURFACE_TERMS];
        fill_surface_basis(
            &mut basis,
            &chebyshev_basis::<X_TERMS>(u * 2.0 - 1.0),
            &chebyshev_basis::<Y_TERMS>(v * 2.0 - 1.0),
            SURFACE_TERMS,
        );
        evaluate_surface(coefficients, &basis)
    }

    const SURFACE_PROBES: [(f64, f64); 5] = [
        (0.0, 0.0),
        (0.25, 0.5),
        (0.5, 0.5),
        (0.75, 0.25),
        (1.0, 1.0),
    ];

    /// Both fits stay pinned to the pre-flattening model at a tolerance far
    /// below one output-luminance quantum. The fixed-chunk accumulator changes
    /// only floating-point reduction grouping; the separate thread-count test
    /// requires that grouping to remain deterministic.
    #[test]
    fn both_surface_fits_reproduce_their_pre_flattening_models() {
        const CHOLESKY: [f64; 5] = [
            256.505283631078,
            255.894672768757,
            253.836236216943,
            250.488668187166,
            256.092520277839,
        ];
        const GAUSSIAN: [f64; 5] = [
            254.965646558837,
            253.771107792774,
            252.505474184266,
            253.285006782184,
            257.269583508447,
        ];
        let (small, candidate) = reconstructed_background(&gutter_fixture());
        let fit = fit_masked_surface(&small, &candidate, None).expect("gutter fixture must fit");
        let legacy =
            fit_masked_surface_legacy(&small, &candidate).expect("legacy fit must converge");
        for (index, (u, v)) in SURFACE_PROBES.into_iter().enumerate() {
            let cholesky = surface_at(&fit.coefficients, u, v);
            let gaussian = surface_at(&legacy, u, v);
            assert!(
                (cholesky - CHOLESKY[index]).abs() < 1e-8,
                "cholesky probe {index}: {cholesky} vs {}",
                CHOLESKY[index]
            );
            assert!(
                (gaussian - GAUSSIAN[index]).abs() < 1e-8,
                "gaussian probe {index}: {gaussian} vs {}",
                GAUSSIAN[index]
            );
        }
    }

    /// Fixed sample chunks are collected and reduced in source order, so work
    /// stealing may change which worker computes a chunk but never the model.
    #[test]
    fn surface_fit_does_not_depend_on_the_thread_count() {
        let (small, candidate) = reconstructed_background(&gutter_fixture());
        let single = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .expect("single-threaded pool")
            .install(|| fit_masked_surface(&small, &candidate, None))
            .expect("gutter fixture must fit");
        let parallel = rayon::ThreadPoolBuilder::new()
            .num_threads(8)
            .build()
            .expect("eight-threaded pool")
            .install(|| fit_masked_surface(&small, &candidate, None))
            .expect("gutter fixture must fit");
        assert_eq!(single.coefficients, parallel.coefficients);
        assert_eq!(
            fit_masked_surface_legacy(&small, &candidate),
            rayon::ThreadPoolBuilder::new()
                .num_threads(1)
                .build()
                .expect("single-threaded pool")
                .install(|| fit_masked_surface_legacy(&small, &candidate))
        );
    }

    fn reference_surface(
        coefficients: &[f64],
        x_terms: usize,
        y_terms: usize,
        x: f64,
        y: f64,
    ) -> f64 {
        assert_eq!((x_terms, y_terms), (8, 5));
        let tx = chebyshev_basis::<8>(x);
        let ty = chebyshev_basis::<5>(y);
        let mut index = 0;
        let mut sum = 0.0;
        for y_value in ty {
            for &x_value in &tx {
                sum += coefficients[index] * x_value * y_value;
                index += 1;
            }
        }
        sum
    }

    #[test]
    fn separable_chebyshev_evaluation_matches_reference_tensor_basis() {
        let coefficients = (0..40)
            .map(|index| ((index * 37 % 19) as f64 - 9.0) / 7.0)
            .collect::<Vec<_>>();
        let x_basis = precompute_chebyshev::<8>(113);
        let y_basis = precompute_chebyshev::<5>(79);
        for (y, y_values) in y_basis.iter().enumerate() {
            let mut row_coefficients = [0.0; 8];
            for y_term in 0..5 {
                for x_term in 0..8 {
                    row_coefficients[x_term] +=
                        coefficients[y_term * 8 + x_term] * y_values[y_term];
                }
            }
            for (x, x_values) in x_basis.iter().enumerate() {
                let actual = row_coefficients
                    .iter()
                    .zip(x_values)
                    .map(|(coefficient, basis)| coefficient * basis)
                    .sum::<f64>();
                let expected = reference_surface(
                    &coefficients,
                    8,
                    5,
                    normalized_coordinate(x, 113),
                    normalized_coordinate(y, 79),
                );
                assert!((actual - expected).abs() <= 1e-12);
            }
        }
    }
}
