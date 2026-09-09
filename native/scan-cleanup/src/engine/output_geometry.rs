//! Matched-canvas planning and raster placement geometry.
use crate::bw::binary_to_gray;
use crate::bw::paper_reference;
use crate::domain::geometry::PageHalf;
use crate::domain::options::OutputMode;
#[cfg(test)]
use crate::engine::render::CleanupRaster;
use crate::png::RgbImage;
use crate::{CleanupOptions, OrthogonalRotation};
use evb_native_support::{NativeError, NativeErrorCode};
use rayon::prelude::*;
use scan_primitives::{BinaryImage, GrayImage};
use std::borrow::Cow;
use std::collections::HashMap;

pub(crate) const FOLD_TAIL_NEAR_PAPER_FLOOR: u8 = 250;

#[derive(Clone, Debug, PartialEq)]
#[allow(clippy::enum_variant_names)]
pub(crate) enum CanvasWarning {
    MatchedCanvasContentFitted {
        content_width: f64,
        content_height: f64,
        inner_width: f64,
        inner_height: f64,
        document_canvas_width: Option<f64>,
        document_canvas_height: Option<f64>,
    },
    MatchedCanvasMarginsReduced,
    MatchedCanvasMarginsUnavailable,
    MatchedCanvasPaperDownscaled {
        paper_scale: f64,
        document_canvas_width: f64,
        document_canvas_height: f64,
        paper_width: Option<f64>,
        paper_height: Option<f64>,
    },
    MatchedCanvasOpticalCenteringFallback,
    MatchedCanvasIntrinsicOverflow {
        left_px: usize,
        right_px: usize,
    },
    MatchedCanvasSpreadHeadroomTrimmed {
        top_px: usize,
    },
    MatchedCanvasFoldColumnsDiscarded {
        left_columns: usize,
        right_columns: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GeometryCanvas {
    pub(crate) width_points: f64,
    pub(crate) height_points: f64,
    pub(crate) width_px: usize,
    pub(crate) height_px: usize,
}

impl GeometryCanvas {
    pub(crate) fn dpi(self) -> f64 {
        self.width_px as f64 / self.width_points * 72.0
    }

    pub(crate) fn at_dpi(self, dpi: f64) -> Self {
        Self {
            width_px: ((self.width_points / 72.0 * dpi).round() as usize).max(1),
            height_px: ((self.height_points / 72.0 * dpi).round() as usize).max(1),
            ..self
        }
    }
}

pub(crate) fn layered_background_dpi(options: &CleanupOptions, confirmed_picture: bool) -> f64 {
    let max_dpi = if confirmed_picture { 300.0 } else { 200.0 };
    options
        .source_background_dpi()
        .min(options.dpi)
        .min(max_dpi)
}

pub(crate) fn background_canvas_dimensions(
    canvas: &GeometryCanvas,
    background_dpi: f64,
) -> (usize, usize) {
    let background_canvas = canvas.at_dpi(background_dpi);
    (background_canvas.width_px, background_canvas.height_px)
}

pub(crate) fn background_dimensions_to_publish(
    actual_width: usize,
    actual_height: usize,
    target_width: usize,
    target_height: usize,
) -> (usize, usize) {
    if actual_width == target_width && actual_height == target_height {
        (actual_width, actual_height)
    } else {
        (target_width, target_height)
    }
}

pub(crate) const CANVAS_GRID_TOLERANCE_PX: f64 = 1.0;
pub(crate) const PLACEMENT_CENTERING_BOUNDS_X: Option<(f64, f64)> = None;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct NearPaperEdgeRuns {
    pub(crate) left: usize,
    pub(crate) right: usize,
}

pub(crate) struct GeometryOutput {
    pub(crate) options: CleanupOptions,
    pub(crate) source_page_index: usize,
    pub(crate) half: PageHalf,
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) paper_width: f64,
    pub(crate) paper_height: f64,
    pub(crate) content_detected: bool,
    pub(crate) spread_content_top: Option<f64>,
    pub(crate) optical_content_bounds_x: Option<(f64, f64)>,
    pub(crate) fold_side_near_paper_run: usize,
    pub(crate) outer_near_paper_edge_runs: NearPaperEdgeRuns,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum GeometryRaster {
    Gray(GrayImage),
    Bilevel(BinaryImage),
}

pub(crate) struct GeometryMixedLayers {
    pub(crate) foreground_mask: BinaryImage,
    pub(crate) foreground_alpha: Option<GrayImage>,
    pub(crate) background: GrayImage,
    pub(crate) color_background: Option<RgbImage>,
    pub(crate) source_mrc: bool,
}

pub(crate) enum GeometryRasterView<'a> {
    Gray(&'a GrayImage),
    Bilevel(&'a BinaryImage),
}

impl GeometryRasterView<'_> {
    fn to_gray(&self) -> Cow<'_, GrayImage> {
        match self {
            Self::Gray(image) => Cow::Borrowed(image),
            Self::Bilevel(image) => Cow::Owned(binary_to_gray(image)),
        }
    }
}

pub(crate) struct GeometryMixedLayersView<'a> {
    pub(crate) foreground_mask: &'a BinaryImage,
    pub(crate) foreground_alpha: Option<&'a GrayImage>,
    pub(crate) background: &'a GrayImage,
    pub(crate) color_background: Option<&'a RgbImage>,
}

pub(crate) struct GeometryPlaneView<'a> {
    pub(crate) image: GeometryRasterView<'a>,
    pub(crate) color_image: Option<&'a RgbImage>,
    pub(crate) picture_mask: Option<&'a BinaryImage>,
    pub(crate) tone_preservation_alpha: Option<&'a GrayImage>,
    pub(crate) mixed_layers: Option<GeometryMixedLayersView<'a>>,
    pub(crate) output_mode: OutputMode,
    pub(crate) half: PageHalf,
    pub(crate) fallback_content_top: Option<f64>,
}

pub(crate) fn compose_primary_raster(
    image: GeometryRaster,
    color_image: Option<RgbImage>,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) -> (GeometryRaster, Option<RgbImage>) {
    let image = match &image {
        GeometryRaster::Gray(image) => {
            GeometryRaster::Gray(materialize_gray_primary_on_canvas(image, placement, canvas))
        }
        GeometryRaster::Bilevel(image) => {
            GeometryRaster::Bilevel(materialize_binary_on_canvas(image, placement, canvas))
        }
    };
    let color_image = color_image.map(|color| {
        place_rgb_on_white_canvas_with_source_window(
            &resample_rgb_if_needed(&color, placement.content_width, placement.content_height),
            canvas.width_px,
            canvas.height_px,
            placement.materialization_left,
            placement.top,
            placement.materialization_source_offset_left,
            placement.materialization_source_offset_right,
            placement.intrinsic_overflow_top,
        )
    });
    (image, color_image)
}

pub(crate) fn compose_picture_mask(
    picture_mask: Option<BinaryImage>,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) -> Option<BinaryImage> {
    let picture_mask = picture_mask?;
    Some(materialize_binary_on_canvas(
        &picture_mask,
        placement,
        canvas,
    ))
}

fn materialize_binary_on_canvas(
    source: &BinaryImage,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) -> BinaryImage {
    let gray = binary_to_gray(source);
    let placed = place_on_white_canvas_with_source_window(
        &resample_bilevel(&gray, placement.content_width, placement.content_height),
        canvas.width_px,
        canvas.height_px,
        placement.materialization_left,
        placement.top,
        placement.materialization_source_offset_left,
        placement.materialization_source_offset_right,
        placement.intrinsic_overflow_top,
    );
    BinaryImage::from_fn_parallel(canvas.width_px, canvas.height_px, |x, y| {
        placed.get(x, y) < 128
    })
}

pub(crate) fn compose_tone_preservation_alpha(
    alpha: Option<GrayImage>,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) -> Option<GrayImage> {
    let alpha = alpha?;
    Some(place_on_gray_canvas_with_source_window(
        &resample_gray_if_needed(&alpha, placement.content_width, placement.content_height),
        canvas.width_px,
        canvas.height_px,
        placement.materialization_left,
        placement.top,
        0,
        placement.materialization_source_offset_left,
        placement.intrinsic_overflow_top,
        placement.materialization_source_offset_right,
    ))
}

pub(crate) fn restore_mixed_composite(
    layers: Option<GeometryMixedLayersView<'_>>,
) -> Option<(GeometryRaster, Option<RgbImage>)> {
    let layers = layers?;
    let mask = &layers.foreground_mask;
    let mut image = resample_gray_if_needed(layers.background, mask.width(), mask.height());
    let alpha = layers
        .foreground_alpha
        .as_ref()
        .map(|alpha| resample_gray_if_needed(alpha, mask.width(), mask.height()));
    let width = image.width();
    image
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            for (x, target) in row.iter_mut().enumerate() {
                if let Some(alpha) = alpha.as_ref() {
                    let opacity = alpha.get(x, y);
                    if opacity > 0 {
                        *target =
                            ((u16::from(*target) * u16::from(255 - opacity) + 127) / 255) as u8;
                    }
                } else if mask.get(x, y) {
                    *target = 0;
                }
            }
        });
    let color_image = layers.color_background.map(|background| {
        let mut color = resample_rgb_if_needed(background, mask.width(), mask.height());
        let row_bytes = color.width() * 3;
        color
            .data_mut()
            .par_chunks_mut(row_bytes)
            .enumerate()
            .for_each(|(y, row)| {
                for (x, target) in row.chunks_exact_mut(3).enumerate() {
                    if let Some(alpha) = alpha.as_ref() {
                        let opacity = alpha.get(x, y);
                        if opacity > 0 {
                            for channel in target {
                                *channel = ((u16::from(*channel) * u16::from(255 - opacity) + 127)
                                    / 255) as u8;
                            }
                        }
                    } else if mask.get(x, y) {
                        target.fill(0);
                    }
                }
            });
        color
    });
    Some((GeometryRaster::Gray(image), color_image))
}

pub(crate) fn compose_layers(
    picture_mask: Option<&BinaryImage>,
    mixed_layers: Option<GeometryMixedLayers>,
    options: &CleanupOptions,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) -> Option<GeometryMixedLayers> {
    let confirmed_picture = picture_mask.is_some_and(|mask| mask.count_black() > 0)
        && !mixed_layers
            .as_ref()
            .is_some_and(|layers| layers.source_mrc);
    let mut layers = mixed_layers?;
    layers.foreground_mask =
        materialize_binary_on_canvas(&layers.foreground_mask, placement, canvas);
    if let Some(alpha) = layers.foreground_alpha.as_ref() {
        layers.foreground_alpha = Some(place_on_gray_canvas_with_source_window(
            &resample_gray_if_needed(alpha, placement.content_width, placement.content_height),
            canvas.width_px,
            canvas.height_px,
            placement.materialization_left,
            placement.top,
            0,
            placement.materialization_source_offset_left,
            placement.intrinsic_overflow_top,
            placement.materialization_source_offset_right,
        ));
    }
    let background_dpi = layered_background_dpi(options, confirmed_picture);
    let (background_width, background_height) =
        background_canvas_dimensions(canvas, background_dpi);
    let scale_x = background_width as f64 / canvas.width_px.max(1) as f64;
    let scale_y = background_height as f64 / canvas.height_px.max(1) as f64;
    let content_width = ((placement.content_width as f64 * scale_x).round() as usize).max(1);
    let content_height = ((placement.content_height as f64 * scale_y).round() as usize)
        .max(1)
        .min(background_height);
    let left = (placement.materialization_left as f64 * scale_x).round() as usize;
    let source_offset_left = ((placement.materialization_source_offset_left as f64 * scale_x)
        .round() as usize)
        .min(content_width);
    let source_offset_right = ((placement.materialization_source_offset_right as f64 * scale_x)
        .round() as usize)
        .min(content_width.saturating_sub(source_offset_left));
    let top =
        ((placement.top as f64 * scale_y).round() as usize).min(background_height - content_height);
    layers.background = place_on_white_canvas_with_source_window(
        &resample_gray_if_needed(&layers.background, content_width, content_height),
        background_width,
        background_height,
        left,
        top,
        source_offset_left,
        source_offset_right,
        (placement.intrinsic_overflow_top as f64 * scale_y).round() as usize,
    );
    if let Some(color) = layers.color_background.as_ref() {
        layers.color_background = Some(place_rgb_on_white_canvas_with_source_window(
            &resample_rgb_if_needed(color, content_width, content_height),
            background_width,
            background_height,
            left,
            top,
            source_offset_left,
            source_offset_right,
            (placement.intrinsic_overflow_top as f64 * scale_y).round() as usize,
        ));
    }
    Some(layers)
}

fn edge_near_paper_run_with_reference(
    planes: &GeometryPlaneView<'_>,
    edge: HorizontalEdge,
    gray: &GrayImage,
    near_paper_threshold: u8,
) -> usize {
    let width = gray.width();
    edge_column_order(width, edge)
        .take_while(|&x| {
            if !(0..gray.height()).all(|y| gray.get(x, y) >= near_paper_threshold) {
                return false;
            }
            if planes.output_mode == OutputMode::Bw {
                return true;
            }
            if let Some(color) = planes.color_image.as_ref() {
                let (start, end) = mapped_column_range(x, width, color.width());
                if (0..color.height()).any(|y| {
                    (start..end).any(|plane_x| {
                        color
                            .get(plane_x, y)
                            .iter()
                            .any(|&sample| sample < near_paper_threshold)
                    })
                }) {
                    return false;
                }
            }
            if let Some(layers) = planes.mixed_layers.as_ref() {
                let (start, end) = mapped_column_range(x, width, layers.foreground_mask.width());
                if (0..layers.foreground_mask.height())
                    .any(|y| (start..end).any(|plane_x| layers.foreground_mask.get(plane_x, y)))
                {
                    return false;
                }
                if let Some(alpha) = layers.foreground_alpha.as_ref() {
                    let (start, end) = mapped_column_range(x, width, alpha.width());
                    if (0..alpha.height())
                        .any(|y| (start..end).any(|plane_x| alpha.get(plane_x, y) > 0))
                    {
                        return false;
                    }
                }
                let (start, end) = mapped_column_range(x, width, layers.background.width());
                if (0..layers.background.height()).any(|y| {
                    (start..end)
                        .any(|plane_x| layers.background.get(plane_x, y) < near_paper_threshold)
                }) {
                    return false;
                }
                if let Some(color) = layers.color_background.as_ref() {
                    let (start, end) = mapped_column_range(x, width, color.width());
                    if (0..color.height()).any(|y| {
                        (start..end).any(|plane_x| {
                            color
                                .get(plane_x, y)
                                .iter()
                                .any(|&sample| sample < near_paper_threshold)
                        })
                    }) {
                        return false;
                    }
                }
            }
            if let Some(mask) = planes.picture_mask.as_ref() {
                let (start, end) = mapped_column_range(x, width, mask.width());
                if (0..mask.height()).any(|y| (start..end).any(|plane_x| mask.get(plane_x, y))) {
                    return false;
                }
            }
            if let Some(alpha) = planes.tone_preservation_alpha.as_ref() {
                let (start, end) = mapped_column_range(x, width, alpha.width());
                if (0..alpha.height())
                    .any(|y| (start..end).any(|plane_x| alpha.get(plane_x, y) > 0))
                {
                    return false;
                }
            }
            true
        })
        .count()
}

fn outer_near_paper_edge_runs_with_reference(
    planes: &GeometryPlaneView<'_>,
    gray: &GrayImage,
    near_paper_threshold: u8,
) -> NearPaperEdgeRuns {
    match planes.half {
        PageHalf::Left => NearPaperEdgeRuns {
            left: edge_near_paper_run_with_reference(
                planes,
                HorizontalEdge::Left,
                gray,
                near_paper_threshold,
            ),
            right: 0,
        },
        PageHalf::Right => NearPaperEdgeRuns {
            left: 0,
            right: edge_near_paper_run_with_reference(
                planes,
                HorizontalEdge::Right,
                gray,
                near_paper_threshold,
            ),
        },
        PageHalf::Full => NearPaperEdgeRuns {
            left: edge_near_paper_run_with_reference(
                planes,
                HorizontalEdge::Left,
                gray,
                near_paper_threshold,
            ),
            right: edge_near_paper_run_with_reference(
                planes,
                HorizontalEdge::Right,
                gray,
                near_paper_threshold,
            ),
        },
    }
}

pub(crate) fn paper_edge_runs(planes: &GeometryPlaneView<'_>) -> (usize, NearPaperEdgeRuns) {
    let gray = planes.image.to_gray();
    let near_paper_threshold = paper_reference(&gray).min(FOLD_TAIL_NEAR_PAPER_FLOOR);
    let outer = outer_near_paper_edge_runs_with_reference(planes, &gray, near_paper_threshold);
    let fold = match planes.half {
        PageHalf::Left => edge_near_paper_run_with_reference(
            planes,
            HorizontalEdge::Right,
            &gray,
            near_paper_threshold,
        ),
        PageHalf::Right => edge_near_paper_run_with_reference(
            planes,
            HorizontalEdge::Left,
            &gray,
            near_paper_threshold,
        ),
        PageHalf::Full => 0,
    };
    (fold, outer)
}

pub(crate) fn content_ownership(planes: &GeometryPlaneView<'_>) -> Option<BinaryImage> {
    let mut ownership = match &planes.image {
        GeometryRasterView::Gray(_) => None,
        GeometryRasterView::Bilevel(image) => Some((*image).clone()),
    };
    if planes.output_mode == OutputMode::Bw {
        return ownership;
    }
    if let Some(picture_mask) = planes.picture_mask.as_ref() {
        ownership = Some(match ownership {
            Some(existing) => existing.or(picture_mask),
            None => (*picture_mask).clone(),
        });
    }
    if let Some(foreground_mask) = planes
        .mixed_layers
        .as_ref()
        .map(|layers| &layers.foreground_mask)
    {
        ownership = Some(match ownership {
            Some(existing) => existing.or(foreground_mask),
            None => (*foreground_mask).clone(),
        });
    }
    if let Some(tone_alpha) = planes.tone_preservation_alpha.as_ref() {
        let tone_owner =
            BinaryImage::from_fn_parallel(tone_alpha.width(), tone_alpha.height(), |x, y| {
                tone_alpha.get(x, y) > 0
            });
        ownership = Some(match ownership {
            Some(existing) => existing.or(&tone_owner),
            None => tone_owner,
        });
    }
    ownership
}

pub(crate) fn planes_optical_content_bounds_x(
    planes: &GeometryPlaneView<'_>,
) -> Option<(f64, f64)> {
    content_ownership(planes)
        .as_ref()
        .and_then(optical_binary_bounds_x)
}

pub(crate) fn spread_content_top(planes: &GeometryPlaneView<'_>) -> Option<f64> {
    let raster_top = gray_content_bounds_y(&planes.image.to_gray()).map(|(top, _)| top);
    let layered_top = planes
        .mixed_layers
        .as_ref()
        .and_then(|layers| gray_content_bounds_y(layers.background).map(|(top, _)| top));
    [raster_top, layered_top]
        .into_iter()
        .flatten()
        .min_by(f64::total_cmp)
        .or(planes.fallback_content_top)
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CanvasPlacement {
    pub(crate) content_width: usize,
    pub(crate) content_height: usize,
    pub(crate) left: usize,
    pub(crate) top: usize,
    /// Requested physical margin inset on the final canvas grid.
    pub(crate) requested_margins: [usize; 4],
    /// The horizontal placement was chosen from the transformed optical
    /// content box.
    pub(crate) optical_content_centered: bool,
    /// Optical bounds were available, but could not fit inside the requested
    /// canvas margins. The caller keeps raster alignment and publishes a
    /// page-level warning instead of silently losing the reason.
    pub(crate) optical_content_fit_failed: bool,
    pub(crate) optical_content_bounds_x: Option<(f64, f64)>,
    pub(crate) intrinsic_overflow_left: usize,
    pub(crate) intrinsic_overflow_right: usize,
    /// Source rows trimmed above the canvas origin by a spread-level anchor.
    /// This is white crop headroom, not content clipping: the effective
    /// signed placement remains available to the materializer while the
    /// public canvas offset stays non-negative.
    pub(crate) intrinsic_overflow_top: usize,
    /// Provably-paper source columns excluded at the fold edge. These stay in
    /// intrinsic coordinates; the materializer maps them onto its target grid.
    pub(crate) fold_trim_left: usize,
    pub(crate) fold_trim_right: usize,
    /// Fold-edge crop already scaled onto the canvas/materialization grid.
    pub(crate) fold_clip_left: usize,
    pub(crate) fold_clip_right: usize,
    /// Horizontal source window and destination after scaling. The public
    /// placement continues to describe the complete intrinsic raster so OCR
    /// and preview geometry retain the document's paper scale.
    pub(crate) materialization_left: usize,
    pub(crate) materialization_source_offset_left: usize,
    pub(crate) materialization_source_offset_right: usize,
    pub(crate) margins_reduced: bool,
    pub(crate) margins_unavailable: bool,
    /// The page could not hold the document's scale and was fitted below it,
    /// which happens when margins push content past the paper it was measured
    /// on. Nothing is clipped; the page is simply smaller than its neighbours.
    pub(crate) overflow: bool,
    /// What the paper this output was cut from is worth on the canvas. Above 1
    /// a smaller sheet is resampled up to the document's scale, which is the
    /// point of matching; below 1 the sheet is larger than the rectangle the
    /// document was measured onto, so this page alone lands below that scale.
    pub(crate) paper_scale: f64,
    /// Placed against a caller-supplied ink anchor. The caller measured this
    /// leaf's ink and owns the document-wide vertical answer, so the spread
    /// equalizer must not re-anchor a pair containing such a leaf.
    pub(crate) ink_aligned: bool,
    /// The paper is larger than the canvas by more than the grid's rounding:
    /// the sheet was cut into fewer pages than the rectangle was measured for,
    /// so this page is letterboxed below the document's scale while the grid
    /// and every neighbouring page stay exactly as they were.
    pub(crate) undersized_paper: bool,
}

pub(crate) struct CanvasMetadataFacts {
    pub(crate) soft_margins_pixels: [usize; 4],
    pub(crate) canvas_overflow: bool,
}

pub(crate) fn canvas_metadata_facts(
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) -> CanvasMetadataFacts {
    let effective_left = placement.left as isize - placement.intrinsic_overflow_left as isize;
    let effective_right = effective_left + placement.content_width as isize;
    let effective_top = placement.top as isize - placement.intrinsic_overflow_top as isize;
    let effective_bottom = effective_top + placement.content_height as isize;
    CanvasMetadataFacts {
        soft_margins_pixels: [
            effective_left.max(0) as usize,
            effective_top.max(0) as usize,
            (canvas.width_px as isize - effective_right).max(0) as usize,
            (canvas.height_px as isize - effective_bottom).max(0) as usize,
        ],
        canvas_overflow: placement.overflow
            || placement.intrinsic_overflow_left > 0
            || placement.intrinsic_overflow_right > 0
            || placement.intrinsic_overflow_top > 0,
    }
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct CanvasFit {
    requested_margins: [usize; 4],
    margins_reduced: bool,
    margins_unavailable: bool,
    inner_width: usize,
    inner_height: usize,
    paper_scale: f64,
    pixel_scale: f64,
    overflow_fit: f64,
    overflow: bool,
    undersized_paper: bool,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct FoldSideTrim {
    left: usize,
    right: usize,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HorizontalEdge {
    Left,
    Right,
}

impl FoldSideTrim {
    fn total(self) -> usize {
        self.left.saturating_add(self.right)
    }

    fn effective_width(self, width: usize) -> usize {
        width.saturating_sub(self.total()).max(1)
    }
}
#[derive(Clone, Debug)]
pub(crate) struct SharedSpreadOverflowPlan {
    pub(crate) shared_fit: f64,
    pub(crate) trims: Vec<FoldSideTrim>,
}
pub(crate) fn matched_output_paper_dimensions_for(
    input_width: usize,
    input_height: usize,
    rotation: OrthogonalRotation,
    half: PageHalf,
) -> (f64, f64) {
    let swaps_axes = matches!(
        rotation,
        OrthogonalRotation::Clockwise90 | OrthogonalRotation::Clockwise270
    );
    let (oriented_width, oriented_height) = if swaps_axes {
        (input_height, input_width)
    } else {
        (input_width, input_height)
    };
    let shares = if half == PageHalf::Full { 1.0 } else { 2.0 };
    (oriented_width as f64 / shares, oriented_height as f64)
}
pub(crate) fn canvas_fit_for(
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    canvas: &GeometryCanvas,
) -> CanvasFit {
    let configured_margins = if let Some(margins) = options.margins_pixels {
        margins.map(|pixels| (pixels * canvas.dpi() / options.dpi).round().max(0.0) as usize)
    } else {
        options
            .margins_mm
            .map(crate::MarginsMm::values)
            .unwrap_or([0.0; 4])
            .map(|millimeters| (millimeters * canvas.dpi() / 25.4).round() as usize)
    };
    let margins_unavailable = configured_margins.iter().any(|margin| *margin > 0)
        && (!content_detected || !options.crop_content);
    let mut requested_margins = if margins_unavailable {
        [0; 4]
    } else {
        configured_margins
    };
    let requested_before_fit = requested_margins;
    let fit_margin_axis = |leading: &mut usize, trailing: &mut usize, total: usize| {
        let sum = leading.saturating_add(*trailing);
        if sum < total || sum == 0 {
            return;
        }
        let available = total.saturating_sub(1);
        let fitted_leading =
            ((available as f64 * *leading as f64 / sum as f64).round() as usize).min(available);
        *leading = fitted_leading;
        *trailing = available - fitted_leading;
    };
    let [ref mut margin_left, ref mut margin_top, ref mut margin_right, ref mut margin_bottom] =
        requested_margins;
    fit_margin_axis(margin_left, margin_right, canvas.width_px);
    fit_margin_axis(margin_top, margin_bottom, canvas.height_px);
    let margins_reduced = requested_margins != requested_before_fit;
    let [margin_left, margin_top, margin_right, margin_bottom] = requested_margins;
    let inner_width = canvas
        .width_px
        .saturating_sub(margin_left)
        .saturating_sub(margin_right)
        .max(1);
    let inner_height = canvas
        .height_px
        .saturating_sub(margin_top)
        .saturating_sub(margin_bottom)
        .max(1);
    let paper_width_points = paper_width.max(1.0) / options.dpi * 72.0;
    let paper_height_points = paper_height.max(1.0) / options.dpi * 72.0;
    let paper_scale =
        (canvas.width_points / paper_width_points).min(canvas.height_points / paper_height_points);
    // Paper rounded onto the canvas grid, against the grid itself: a page
    // measured to the pixel of the canvas is the page the canvas was measured
    // from, and only paper that needs more grid than there is — a sheet cut
    // into fewer pages than the rectangle expected — is a real difference.
    let undersized_paper = paper_width_points / canvas.width_points * canvas.width_px as f64
        > canvas.width_px as f64 + CANVAS_GRID_TOLERANCE_PX
        || paper_height_points / canvas.height_points * canvas.height_px as f64
            > canvas.height_px as f64 + CANVAS_GRID_TOLERANCE_PX;
    let pixel_scale = paper_scale * canvas.dpi() / options.dpi;
    let scaled_width = width as f64 * pixel_scale;
    let scaled_height = height as f64 * pixel_scale;
    let overflow = scaled_width > inner_width as f64 + CANVAS_GRID_TOLERANCE_PX
        || scaled_height > inner_height as f64 + CANVAS_GRID_TOLERANCE_PX;
    let overflow_fit = if overflow {
        (inner_width as f64 / scaled_width.max(1.0))
            .min(inner_height as f64 / scaled_height.max(1.0))
    } else {
        1.0
    };
    CanvasFit {
        requested_margins,
        margins_reduced,
        margins_unavailable,
        inner_width,
        inner_height,
        paper_scale,
        pixel_scale,
        overflow_fit,
        overflow,
        undersized_paper,
    }
}
pub(crate) fn edge_column_order(
    width: usize,
    edge: HorizontalEdge,
) -> Box<dyn Iterator<Item = usize>> {
    match edge {
        HorizontalEdge::Left => Box::new(0..width),
        HorizontalEdge::Right => Box::new((0..width).rev()),
    }
}
#[cfg(test)]
pub(crate) fn edge_near_paper_run_in_gray(image: &GrayImage, edge: HorizontalEdge) -> usize {
    let near_paper_threshold = paper_reference(image).min(FOLD_TAIL_NEAR_PAPER_FLOOR);
    edge_column_order(image.width(), edge)
        .take_while(|&x| (0..image.height()).all(|y| image.get(x, y) >= near_paper_threshold))
        .count()
}
#[cfg(test)]
pub(crate) fn fold_side_near_paper_run_in_gray(image: &GrayImage, half: PageHalf) -> usize {
    match half {
        PageHalf::Left => edge_near_paper_run_in_gray(image, HorizontalEdge::Right),
        PageHalf::Right => edge_near_paper_run_in_gray(image, HorizontalEdge::Left),
        PageHalf::Full => 0,
    }
}
pub(crate) fn mapped_column_range(
    x: usize,
    source_width: usize,
    plane_width: usize,
) -> (usize, usize) {
    let start = x.saturating_mul(plane_width) / source_width.max(1);
    let end = (x + 1)
        .saturating_mul(plane_width)
        .div_ceil(source_width.max(1))
        .max(start + 1)
        .min(plane_width);
    (start.min(plane_width), end)
}
pub(crate) fn near_paper_edge_runs_with_fold_side(
    mut runs: NearPaperEdgeRuns,
    half: PageHalf,
    fold_side_run: usize,
) -> NearPaperEdgeRuns {
    match half {
        PageHalf::Left => runs.right = runs.right.max(fold_side_run),
        PageHalf::Right => runs.left = runs.left.max(fold_side_run),
        PageHalf::Full => {}
    }
    runs
}
pub(crate) fn fold_trim_for(
    width: usize,
    half: PageHalf,
    near_paper_run: usize,
    fit: CanvasFit,
) -> FoldSideTrim {
    if width <= 1 || !horizontal_overflow_requires_fold_scan(width, half, fit) {
        return FoldSideTrim::default();
    }
    let maximum_fitting_width = ((fit.inner_width as f64 + CANVAS_GRID_TOLERANCE_PX)
        / fit.pixel_scale.max(f64::EPSILON))
    .floor()
    .max(1.0) as usize;
    let needed = width.saturating_sub(maximum_fitting_width).min(width - 1);
    let trim = needed.min(near_paper_run).min(width - 1);
    match half {
        PageHalf::Left => FoldSideTrim {
            left: 0,
            right: trim,
        },
        PageHalf::Right => FoldSideTrim {
            left: trim,
            right: 0,
        },
        PageHalf::Full => FoldSideTrim::default(),
    }
}
pub(crate) fn horizontal_overflow_requires_fold_scan(
    width: usize,
    half: PageHalf,
    fit: CanvasFit,
) -> bool {
    matches!(half, PageHalf::Left | PageHalf::Right)
        && width as f64 * fit.pixel_scale > fit.inner_width as f64 + CANVAS_GRID_TOLERANCE_PX
}
pub(crate) fn shared_spread_overflow_fits_for_geometry_outputs(
    outputs: &[GeometryOutput],
    canvas: &GeometryCanvas,
) -> HashMap<usize, SharedSpreadOverflowPlan> {
    let mut by_source_page = HashMap::<usize, Vec<&GeometryOutput>>::new();
    for output in outputs {
        by_source_page
            .entry(output.source_page_index)
            .or_default()
            .push(output);
    }
    by_source_page
        .into_iter()
        .filter_map(|(source_page_index, pair)| {
            if pair.len() != 2
                || !pair.iter().any(|output| output.half == PageHalf::Left)
                || !pair.iter().any(|output| output.half == PageHalf::Right)
            {
                return None;
            }
            let trims = pair
                .iter()
                .map(|output| {
                    let fit = canvas_fit_for(
                        output.width,
                        output.height,
                        output.paper_width,
                        output.paper_height,
                        output.content_detected,
                        &output.options,
                        canvas,
                    );
                    fold_trim_for(
                        output.width,
                        output.half,
                        output.fold_side_near_paper_run,
                        fit,
                    )
                })
                .collect::<Vec<_>>();
            let shared_fit = pair
                .iter()
                .zip(&trims)
                .map(|(output, trim)| {
                    canvas_fit_for(
                        trim.effective_width(output.width),
                        output.height,
                        output.paper_width,
                        output.paper_height,
                        output.content_detected,
                        &output.options,
                        canvas,
                    )
                    .overflow_fit
                })
                .reduce(f64::min)?;
            Some((
                source_page_index,
                SharedSpreadOverflowPlan { shared_fit, trims },
            ))
        })
        .collect()
}

pub(crate) fn plan_canvas_placements(
    outputs: &[GeometryOutput],
    canvas: &GeometryCanvas,
) -> Vec<CanvasPlacement> {
    let shared_fits = shared_spread_overflow_fits_for_geometry_outputs(outputs, canvas);
    let mut trim_indices = HashMap::<usize, usize>::new();
    let mut placements = outputs
        .iter()
        .map(|output| {
            let trim_index = trim_indices.entry(output.source_page_index).or_default();
            let fold_trim = shared_fits
                .get(&output.source_page_index)
                .and_then(|plan| plan.trims.get(*trim_index).copied());
            *trim_index += 1;
            plan_canvas_placement_with_shared_fit(
                output,
                canvas,
                shared_fits.get(&output.source_page_index),
                fold_trim,
            )
        })
        .collect::<Vec<_>>();
    align_deferred_spread_vertical_placements(&mut placements, outputs, &shared_fits, canvas);
    placements
}

pub(crate) fn plan_canvas_placement_with_shared_fit(
    output: &GeometryOutput,
    canvas: &GeometryCanvas,
    shared_overflow_plan: Option<&SharedSpreadOverflowPlan>,
    shared_fold_trim: Option<FoldSideTrim>,
) -> CanvasPlacement {
    if shared_overflow_plan.is_none() && output.optical_content_bounds_x.is_none() {
        return plan_canvas_placement(
            CanvasPlacementRequest {
                width: output.width,
                height: output.height,
                paper_width: output.paper_width,
                paper_height: output.paper_height,
                content_detected: output.content_detected,
                options: &output.options,
                half: output.half,
                optical_content_bounds_x: PLACEMENT_CENTERING_BOUNDS_X,
                shared_overflow_fit: None,
                fold_trim: FoldSideTrim::default(),
                outer_near_paper_runs: NearPaperEdgeRuns::default(),
            },
            canvas,
        );
    }
    let fold_trim = shared_fold_trim.or_else(|| {
        shared_overflow_plan.map(|_| {
            let own_fit = canvas_fit_for(
                output.width,
                output.height,
                output.paper_width,
                output.paper_height,
                output.content_detected,
                &output.options,
                canvas,
            );
            fold_trim_for(
                output.width,
                output.half,
                output.fold_side_near_paper_run,
                own_fit,
            )
        })
    });
    let placement_near_paper_edge_runs = near_paper_edge_runs_with_fold_side(
        output.outer_near_paper_edge_runs,
        output.half,
        output.fold_side_near_paper_run,
    );
    let mut placement = plan_canvas_placement(
        CanvasPlacementRequest {
            width: output.width,
            height: output.height,
            paper_width: output.paper_width,
            paper_height: output.paper_height,
            content_detected: output.content_detected,
            options: &output.options,
            half: output.half,
            optical_content_bounds_x: PLACEMENT_CENTERING_BOUNDS_X,
            shared_overflow_fit: shared_overflow_plan.map(|plan| plan.shared_fit),
            fold_trim: fold_trim.unwrap_or_default(),
            outer_near_paper_runs: placement_near_paper_edge_runs,
        },
        canvas,
    );
    placement.optical_content_bounds_x = output.optical_content_bounds_x;
    placement
}
#[cfg(test)]
pub(crate) fn plan_canvas_placement_for(
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    half: PageHalf,
    canvas: &GeometryCanvas,
) -> CanvasPlacement {
    plan_canvas_placement_for_with_optical_center(
        width,
        height,
        paper_width,
        paper_height,
        content_detected,
        options,
        half,
        canvas,
        None,
    )
}
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_canvas_placement_for_with_optical_center(
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    half: PageHalf,
    canvas: &GeometryCanvas,
    optical_content_bounds_x: Option<(f64, f64)>,
) -> CanvasPlacement {
    plan_canvas_placement_for_with_optical_center_and_fit(
        width,
        height,
        paper_width,
        paper_height,
        content_detected,
        options,
        half,
        canvas,
        optical_content_bounds_x,
        None,
    )
}
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_canvas_placement_for_with_optical_center_and_fit(
    width: usize,
    height: usize,
    paper_width: f64,
    paper_height: f64,
    content_detected: bool,
    options: &CleanupOptions,
    half: PageHalf,
    canvas: &GeometryCanvas,
    optical_content_bounds_x: Option<(f64, f64)>,
    shared_overflow_fit: Option<f64>,
) -> CanvasPlacement {
    plan_canvas_placement(
        CanvasPlacementRequest {
            width,
            height,
            paper_width,
            paper_height,
            content_detected,
            options,
            half,
            optical_content_bounds_x,
            shared_overflow_fit,
            fold_trim: FoldSideTrim::default(),
            outer_near_paper_runs: NearPaperEdgeRuns::default(),
        },
        canvas,
    )
}
pub(crate) struct CanvasPlacementRequest<'a> {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) paper_width: f64,
    pub(crate) paper_height: f64,
    pub(crate) content_detected: bool,
    pub(crate) options: &'a CleanupOptions,
    pub(crate) half: PageHalf,
    pub(crate) optical_content_bounds_x: Option<(f64, f64)>,
    pub(crate) shared_overflow_fit: Option<f64>,
    pub(crate) fold_trim: FoldSideTrim,
    pub(crate) outer_near_paper_runs: NearPaperEdgeRuns,
}

pub(crate) fn plan_canvas_placement(
    request: CanvasPlacementRequest<'_>,
    canvas: &GeometryCanvas,
) -> CanvasPlacement {
    let CanvasPlacementRequest {
        width,
        height,
        paper_width,
        paper_height,
        content_detected,
        options,
        half,
        optical_content_bounds_x,
        shared_overflow_fit,
        fold_trim,
        outer_near_paper_runs,
    } = request;
    let effective_width = fold_trim.effective_width(width);
    let CanvasFit {
        requested_margins,
        margins_reduced,
        margins_unavailable,
        inner_width,
        inner_height,
        paper_scale,
        pixel_scale,
        overflow_fit,
        overflow: own_overflow,
        undersized_paper,
    } = canvas_fit_for(
        effective_width,
        height,
        paper_width,
        paper_height,
        content_detected,
        options,
        canvas,
    );
    let [margin_left, margin_top, margin_right, _margin_bottom] = requested_margins;
    let fit = shared_overflow_fit
        .map(|shared| shared.clamp(0.0, 1.0).min(overflow_fit))
        .unwrap_or(overflow_fit);
    let scaled_width = width as f64 * pixel_scale * fit;
    let scaled_height = height as f64 * pixel_scale * fit;
    let overflow = own_overflow || fit < 1.0;
    // Keep the complete intrinsic width at the paper scale. Only the proven
    // fold-side window is omitted by the materializer; retaining the full
    // scaled extent here keeps preview, OCR, and source text geometry honest.
    let content_width = if fold_trim.total() > 0 {
        (scaled_width.round() as usize).max(1)
    } else {
        // The zero-trim path remains byte-for-byte compatible with the shared
        // overflow fit: its raster is already wholly represented by the
        // fitted inner box, including the one-pixel grid tolerance.
        (scaled_width.round() as usize).clamp(1, inner_width)
    };
    let content_height = (scaled_height.round() as usize).clamp(1, inner_height);
    let scaled_boundary = |source_x: usize| {
        ((source_x.min(width) as f64 * pixel_scale * fit).round() as usize).min(content_width)
    };
    let fold_clip_left = scaled_boundary(fold_trim.left);
    let retained_right = scaled_boundary(width.saturating_sub(fold_trim.right));
    let fold_clip_right = content_width.saturating_sub(retained_right);
    let effective_content_width = content_width
        .saturating_sub(fold_clip_left)
        .saturating_sub(fold_clip_right)
        .max(1);
    // Paper geometry owns scale; the intrinsic cleaned raster owns placement.
    // Keeping source crop coordinates out of this calculation makes native
    // final output follow the same Content placement contract as preview and
    // lossless output: align the raster inside the requested margin box.
    let alignment = options.placement_for(half);
    let (aligned_x, mut aligned_y) = alignment.offset(
        inner_width.saturating_sub(effective_content_width),
        inner_height.saturating_sub(content_height),
    );
    // Ink placement puts this leaf's content at the height the caller measured
    // its ink at, and nowhere else: horizontally it is centred exactly like
    // `top-center`, and the paper scale and the overflow fit above stay
    // exactly as any other alignment planned them, so an anchored page is
    // never resampled differently from the document it belongs to.
    let ink_anchor = matches!(alignment, crate::PageAlignment::Ink)
        .then(|| options.placement_anchor_for(half))
        .flatten();
    if let Some(anchor) = ink_anchor {
        aligned_y = ((anchor.y_normalized * inner_height as f64).round().max(0.0) as usize)
            .min(inner_height.saturating_sub(content_height));
    }
    let target_center = margin_left as f64 + inner_width as f64 / 2.0;
    // Keep the effective source origin signed. Optical centering may place a
    // retained white raster tail just outside the canvas; clamping that
    // origin to zero would leave the optical box visibly off-center and make
    // the clipped source pixels impossible to account for in metadata.
    let retained_left = margin_left as isize + aligned_x as isize;
    let mut effective_left = retained_left - fold_clip_left as isize;
    let mut optical_content_centered = false;
    let mut optical_content_fit_failed = false;
    let centering_bounds = optical_content_bounds_x.filter(|(left, right)| {
        left.is_finite()
            && right.is_finite()
            && *left >= 0.0
            && *left < *right
            && *right <= width.max(1) as f64
            && matches!(
                alignment,
                crate::PageAlignment::TopCenter
                    | crate::PageAlignment::Center
                    | crate::PageAlignment::BottomCenter
                    | crate::PageAlignment::Ink
            )
    });
    if let Some((optical_left, optical_right)) = centering_bounds {
        let scale = content_width as f64 / width.max(1) as f64;
        let optical_center_x = (optical_left + optical_right) * 0.5;
        let scaled_optical_center = optical_center_x * scale;
        // Constrain the optical box to the requested margins. A retained
        // white raster tail may overhang the canvas, but the optical box may
        // not; an impossible box is reported and keeps the ordinary raster
        // alignment instead of inventing a placement that destroys a leaf.
        let minimum_left = (margin_left as f64 - optical_left * scale).ceil();
        let maximum_left =
            (canvas.width_px as f64 - margin_right as f64 - optical_right * scale).floor();
        let desired_left = (target_center - scaled_optical_center).round() as isize;
        if maximum_left >= minimum_left && maximum_left >= 0.0 {
            let minimum_left = minimum_left as isize;
            let maximum_left = maximum_left as isize;
            let candidate = desired_left.clamp(minimum_left, maximum_left);
            optical_content_centered = candidate != effective_left;
            effective_left = candidate;
        } else {
            optical_content_fit_failed = true;
        }
    }
    // Preserve a signed optical origin only when every overhung column is
    // proven paper across every materialized plane. Otherwise slide the
    // retained interval back inside exactly as before: conservation outranks
    // centering when even one sample could be writing.
    let proven_left_overhang = scaled_boundary(outer_near_paper_runs.left);
    let proven_right_overhang = content_width.saturating_sub(scaled_boundary(
        width.saturating_sub(outer_near_paper_runs.right),
    ));
    let retained_left_from_source = effective_left + fold_clip_left as isize;
    let retained_right_from_source = effective_left + retained_right as isize;
    if retained_left_from_source < 0 && (-retained_left_from_source) as usize > proven_left_overhang
    {
        effective_left -= retained_left_from_source;
    } else if retained_right_from_source > canvas.width_px as isize
        && (retained_right_from_source - canvas.width_px as isize) as usize > proven_right_overhang
    {
        effective_left -= retained_right_from_source - canvas.width_px as isize;
    }
    let top = margin_top + aligned_y;
    let intrinsic_overflow_left = if effective_left < 0 {
        (-effective_left) as usize
    } else {
        0
    };
    let left = effective_left.max(0) as usize;
    let intrinsic_overflow_right = (effective_left + content_width as isize)
        .saturating_sub(canvas.width_px as isize)
        .max(0) as usize;
    CanvasPlacement {
        content_width,
        content_height,
        left,
        top,
        requested_margins,
        optical_content_centered,
        optical_content_fit_failed,
        optical_content_bounds_x,
        intrinsic_overflow_left,
        intrinsic_overflow_right,
        intrinsic_overflow_top: 0,
        fold_trim_left: fold_trim.left,
        fold_trim_right: fold_trim.right,
        fold_clip_left,
        fold_clip_right,
        materialization_left: (effective_left + fold_clip_left as isize).max(0) as usize,
        materialization_source_offset_left: fold_clip_left.max(intrinsic_overflow_left),
        materialization_source_offset_right: fold_clip_right.max(intrinsic_overflow_right),
        margins_reduced,
        margins_unavailable,
        overflow,
        ink_aligned: ink_anchor.is_some(),
        paper_scale,
        undersized_paper,
    }
}
pub(crate) fn canvas_placement_warning_events(
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
    content_box_detected: bool,
) -> Vec<CanvasWarning> {
    let mut events = Vec::new();
    if placement.overflow {
        let [margin_left, margin_top, margin_right, margin_bottom] = placement.requested_margins;
        let inner_width = canvas
            .width_px
            .saturating_sub(margin_left)
            .saturating_sub(margin_right)
            .max(1);
        let inner_height = canvas
            .height_px
            .saturating_sub(margin_top)
            .saturating_sub(margin_bottom)
            .max(1);
        events.push(CanvasWarning::MatchedCanvasContentFitted {
            content_width: placement.content_width as f64,
            content_height: placement.content_height as f64,
            inner_width: inner_width as f64,
            inner_height: inner_height as f64,
            document_canvas_width: Some(canvas.width_px as f64),
            document_canvas_height: Some(canvas.height_px as f64),
        });
    }
    if placement.intrinsic_overflow_left > 0 || placement.intrinsic_overflow_right > 0 {
        events.push(CanvasWarning::MatchedCanvasIntrinsicOverflow {
            left_px: placement.intrinsic_overflow_left,
            right_px: placement.intrinsic_overflow_right,
        });
    }
    if placement.intrinsic_overflow_top > 0 {
        events.push(CanvasWarning::MatchedCanvasSpreadHeadroomTrimmed {
            top_px: placement.intrinsic_overflow_top,
        });
    }
    if placement.fold_trim_left > 0 || placement.fold_trim_right > 0 {
        events.push(CanvasWarning::MatchedCanvasFoldColumnsDiscarded {
            left_columns: placement.fold_trim_left,
            right_columns: placement.fold_trim_right,
        });
    }
    if placement.optical_content_fit_failed && content_box_detected {
        events.push(CanvasWarning::MatchedCanvasOpticalCenteringFallback);
    }
    if placement.margins_reduced {
        events.push(CanvasWarning::MatchedCanvasMarginsReduced);
    }
    if placement.margins_unavailable {
        events.push(CanvasWarning::MatchedCanvasMarginsUnavailable);
    }
    if placement.undersized_paper {
        events.push(CanvasWarning::MatchedCanvasPaperDownscaled {
            paper_scale: placement.paper_scale,
            document_canvas_width: canvas.width_px as f64,
            document_canvas_height: canvas.height_px as f64,
            paper_width: None,
            paper_height: None,
        });
    }
    events
}
pub(crate) fn materialize_gray_primary_on_canvas(
    source: &GrayImage,
    placement: CanvasPlacement,
    canvas: &GeometryCanvas,
) -> GrayImage {
    place_on_white_canvas_with_source_window(
        &resample_gray_if_needed(source, placement.content_width, placement.content_height),
        canvas.width_px,
        canvas.height_px,
        placement.materialization_left,
        placement.top,
        placement.materialization_source_offset_left,
        placement.materialization_source_offset_right,
        placement.intrinsic_overflow_top,
    )
}
pub(crate) fn resample_gray_if_needed(
    source: &GrayImage,
    width: usize,
    height: usize,
) -> GrayImage {
    if source.width() == width && source.height() == height {
        source.clone()
    } else {
        source.resample_to_dimensions(width, height)
    }
}
pub(crate) fn resample_rgb_if_needed(source: &RgbImage, width: usize, height: usize) -> RgbImage {
    if source.width() == width && source.height() == height {
        source.clone()
    } else {
        source.resample_to_dimensions(width, height)
    }
}
pub(crate) fn align_deferred_spread_vertical_placements<T>(
    placements: &mut [CanvasPlacement],
    outputs: &[GeometryOutput],
    shared_spread_fits: &HashMap<usize, T>,
    canvas: &GeometryCanvas,
) {
    if placements.len() != outputs.len() {
        return;
    }
    for source_page_index in shared_spread_fits.keys() {
        let pair = outputs
            .iter()
            .enumerate()
            .filter(|(_, output)| output.source_page_index == *source_page_index)
            .collect::<Vec<_>>();
        if pair.len() != 2
            || !pair.iter().any(|(_, output)| output.half == PageHalf::Left)
            || !pair
                .iter()
                .any(|(_, output)| output.half == PageHalf::Right)
        {
            continue;
        }
        let mut pair_placements = vec![
            Some((placements[pair[0].0], *canvas)),
            Some((placements[pair[1].0], *canvas)),
        ];
        align_spread_vertical_placements(
            &mut pair_placements,
            &[pair[0].1.height, pair[1].1.height],
            &[pair[0].1.spread_content_top, pair[1].1.spread_content_top],
            canvas,
        );
        for ((index, _), aligned) in pair.into_iter().zip(pair_placements) {
            let Some((placement, _)) = aligned else {
                continue;
            };
            placements[index] = placement;
        }
    }
}
pub(crate) fn validate_canvas_for_options(
    width: usize,
    height: usize,
    options: &CleanupOptions,
) -> Result<(), NativeError> {
    let pixels = (width as u64).saturating_mul(height as u64);
    if width > options.max_dimension as usize
        || height > options.max_dimension as usize
        || pixels > options.max_pixels
    {
        return Err(NativeError::new(
            NativeErrorCode::TooLarge,
            format!("Uniform page canvas {width}x{height} exceeds cleanup guardrails"),
        ));
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn robust_quantile_dimension(values: impl Iterator<Item = usize>) -> usize {
    let mut values = values.collect::<Vec<_>>();
    values.sort_unstable();
    let rank = values.len().saturating_mul(9).div_ceil(10).max(1);
    values[rank - 1]
}
pub(crate) fn resample_bilevel(source: &GrayImage, width: usize, height: usize) -> GrayImage {
    let mut resampled = source.resample_to_dimensions(width, height);
    resampled
        .data_mut()
        .par_iter_mut()
        .for_each(|value| *value = if *value < 128 { 0 } else { 255 });
    resampled
}
#[cfg(test)]
pub(crate) fn optical_content_bounds_x(raster: &CleanupRaster) -> Option<(f64, f64)> {
    raster.bilevel().and_then(optical_binary_bounds_x)
}
#[cfg(test)]
pub(crate) fn optical_content_center_x(raster: &CleanupRaster) -> Option<f64> {
    optical_content_bounds_x(raster).map(|(left, right)| (left + right) * 0.5)
}
pub(crate) fn optical_binary_bounds_x(binary: &BinaryImage) -> Option<(f64, f64)> {
    let mut columns = vec![0usize; binary.width()];
    let mut ink = 0usize;
    for y in 0..binary.height() {
        for (x, column) in columns.iter_mut().enumerate() {
            if binary.get(x, y) {
                *column += 1;
                ink += 1;
            }
        }
    }
    if ink == 0 {
        return None;
    }
    let lower_rank = ((ink - 1) as f64 * 0.01).floor() as usize;
    let upper_rank = ((ink - 1) as f64 * 0.99).ceil() as usize;
    let percentile_column = |rank: usize| {
        let mut cumulative = 0usize;
        columns.iter().position(|count| {
            cumulative += *count;
            cumulative > rank
        })
    };
    let left = percentile_column(lower_rank)?;
    let right = percentile_column(upper_rank)?;
    (left <= right).then_some((left as f64, right as f64 + 1.0))
}
pub(crate) fn gray_content_bounds_y(gray: &GrayImage) -> Option<(f64, f64)> {
    // The cleaned raster sits on a white canvas, so anything meaningfully
    // below paper is content - a pale photo sky included. An ink-dark
    // threshold here anchored photo leaves to their first *dark* region
    // instead of their visual top, misaligning facing plates. A small
    // per-row count guards against a stray dust pixel defining the bound.
    const CONTENT_BELOW_PAPER: u8 = 245;
    const MINIMUM_ROW_PIXELS: usize = 3;
    let mut first = None;
    let mut last = None;
    for y in 0..gray.height() {
        let mut row_pixels = 0usize;
        for x in 0..gray.width() {
            if gray.get(x, y) < CONTENT_BELOW_PAPER {
                row_pixels += 1;
                if row_pixels >= MINIMUM_ROW_PIXELS {
                    break;
                }
            }
        }
        if row_pixels >= MINIMUM_ROW_PIXELS {
            first.get_or_insert(y);
            last = Some(y);
        }
    }
    Some((first? as f64, last? as f64 + 1.0))
}
pub(crate) fn align_spread_vertical_placements(
    placements: &mut [Option<(CanvasPlacement, GeometryCanvas)>],
    intrinsic_heights: &[usize],
    content_tops: &[Option<f64>],
    canvas: &GeometryCanvas,
) {
    if placements.len() != 2
        || intrinsic_heights.len() != placements.len()
        || content_tops.len() != placements.len()
    {
        return;
    }
    let [Some((first, _)), Some((second, _))] = placements else {
        return;
    };
    // A leaf placed against the caller's ink anchor already answers the spread
    // question across the whole document. Re-anchoring the pair here would
    // overwrite that answer with a two-page one.
    if first.ink_aligned || second.ink_aligned {
        return;
    }
    let Some(first_content_top) = content_tops[0] else {
        return;
    };
    let Some(second_content_top) = content_tops[1] else {
        return;
    };
    if !first_content_top.is_finite() || !second_content_top.is_finite() {
        return;
    }
    let first_scale = first.content_height as f64 / intrinsic_heights[0].max(1) as f64;
    let second_scale = second.content_height as f64 / intrinsic_heights[1].max(1) as f64;
    let first_scaled_top = first_content_top * first_scale;
    let second_scaled_top = second_content_top * second_scale;
    // The union's top is the later of the two local anchors: this reserves
    // enough headroom for both leaves' first meaningful content row without
    // allowing a leaf with a shorter crop to start visibly lower.
    let current_target =
        (first.top as f64 + first_scaled_top).max(second.top as f64 + second_scaled_top);
    // A spread may need to trim white crop headroom above a leaf's effective
    // origin. Allowing that signed origin makes the shared content anchor
    // feasible even when one leaf already occupies the full margin box; the
    // materializer records the trimmed source rows and never clips ink.
    let first_min = -(first.content_height.saturating_sub(1) as f64) + first_scaled_top;
    let second_min = -(second.content_height.saturating_sub(1) as f64) + second_scaled_top;
    let first_max_top = canvas
        .height_px
        .saturating_sub(first.requested_margins[3])
        .saturating_sub(first.content_height) as f64;
    let second_max_top = canvas
        .height_px
        .saturating_sub(second.requested_margins[3])
        .saturating_sub(second.content_height) as f64;
    let shared_min = first_min.max(second_min);
    let shared_max = (first_max_top + first_scaled_top).min(second_max_top + second_scaled_top);
    if shared_min > shared_max {
        return;
    }
    let target = current_target.clamp(shared_min, shared_max);
    let set_effective_top = |placement: &mut CanvasPlacement, desired: f64, max_top: f64| {
        let minimum_top = -(placement.content_height.saturating_sub(1) as isize);
        let effective_top = (desired.round() as isize).clamp(minimum_top, max_top as isize);
        if effective_top < 0 {
            placement.top = 0;
            placement.intrinsic_overflow_top = (-effective_top) as usize;
        } else {
            placement.top = effective_top as usize;
            placement.intrinsic_overflow_top = 0;
        }
    };
    set_effective_top(first, target - first_scaled_top, first_max_top);
    set_effective_top(second, target - second_scaled_top, second_max_top);
}
#[cfg(test)]
pub(crate) fn place_on_white_canvas(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
) -> GrayImage {
    place_on_white_canvas_with_source_offset(source, width, height, left, top, 0)
}
#[cfg(test)]
pub(crate) fn place_on_white_canvas_with_source_offset(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    source_offset_x: usize,
) -> GrayImage {
    place_on_white_canvas_with_source_offsets(source, width, height, left, top, source_offset_x, 0)
}
#[cfg(test)]
pub(crate) fn place_on_white_canvas_with_source_offsets(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    source_offset_x: usize,
    source_offset_y: usize,
) -> GrayImage {
    place_on_white_canvas_with_source_window(
        source,
        width,
        height,
        left,
        top,
        source_offset_x,
        0,
        source_offset_y,
    )
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn place_on_white_canvas_with_source_window(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    source_offset_x: usize,
    source_offset_right: usize,
    source_offset_y: usize,
) -> GrayImage {
    place_on_gray_canvas_with_source_window(
        source,
        width,
        height,
        left,
        top,
        255,
        source_offset_x,
        source_offset_y,
        source_offset_right,
    )
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn place_on_gray_canvas_with_source_window(
    source: &GrayImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    fill: u8,
    source_offset_x: usize,
    source_offset_y: usize,
    source_offset_right: usize,
) -> GrayImage {
    assert!(
        left < width || source.width() == 0,
        "canvas placement offset {left} is outside width {width}"
    );
    assert!(
        top < height || source.height() == 0,
        "canvas placement offset {top} is outside height {height}"
    );
    assert!(
        source_offset_x <= source.width(),
        "canvas source offset {source_offset_x} is outside source width {}",
        source.width()
    );
    assert!(
        source_offset_y <= source.height(),
        "canvas source offset {source_offset_y} is outside source height {}",
        source.height()
    );
    assert!(
        source_offset_x.saturating_add(source_offset_right) <= source.width(),
        "canvas source window {source_offset_x}..-{} is outside source width {}",
        source_offset_right,
        source.width()
    );
    let mut canvas = GrayImage::new(width, height, fill);
    canvas
        .data_mut()
        .par_chunks_mut(width)
        .enumerate()
        .for_each(|(y, row)| {
            if let Some(source_y) = y
                .checked_sub(top)
                .and_then(|y| y.checked_add(source_offset_y))
                .filter(|&y| y < source.height())
            {
                let copy_width = width.saturating_sub(left).min(
                    source
                        .width()
                        .saturating_sub(source_offset_x)
                        .saturating_sub(source_offset_right),
                );
                if copy_width > 0 {
                    row[left..left + copy_width].copy_from_slice(
                        &source.row(source_y)[source_offset_x..source_offset_x + copy_width],
                    );
                }
            }
        });
    canvas
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn place_rgb_on_white_canvas_with_source_window(
    source: &RgbImage,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    source_offset_x: usize,
    source_offset_right: usize,
    source_offset_y: usize,
) -> RgbImage {
    assert!(
        left < width || source.width() == 0,
        "canvas placement offset {left} is outside width {width}"
    );
    assert!(
        top < height || source.height() == 0,
        "canvas placement offset {top} is outside height {height}"
    );
    assert!(
        source_offset_x <= source.width(),
        "canvas source offset {source_offset_x} is outside source width {}",
        source.width()
    );
    assert!(
        source_offset_y <= source.height(),
        "canvas source offset {source_offset_y} is outside source height {}",
        source.height()
    );
    assert!(
        source_offset_x.saturating_add(source_offset_right) <= source.width(),
        "canvas source window {source_offset_x}..-{} is outside source width {}",
        source_offset_right,
        source.width()
    );
    let mut canvas = RgbImage::new(width, height, [255; 3]);
    canvas
        .data_mut()
        .par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            if let Some(source_y) = y
                .checked_sub(top)
                .and_then(|y| y.checked_add(source_offset_y))
                .filter(|&y| y < source.height())
            {
                let copy_width = width.saturating_sub(left).min(
                    source
                        .width()
                        .saturating_sub(source_offset_x)
                        .saturating_sub(source_offset_right),
                );
                if copy_width > 0 {
                    let start = left * 3;
                    row[start..start + copy_width * 3].copy_from_slice(
                        &source.row(source_y)
                            [source_offset_x * 3..(source_offset_x + copy_width) * 3],
                    );
                }
            }
        });
    canvas
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CleanupOptions;
    use scan_primitives::{BinaryImage, GrayImage};

    fn deferred_output(
        source_page_index: usize,
        half: PageHalf,
        height: usize,
        spread_content_top: Option<f64>,
    ) -> GeometryOutput {
        GeometryOutput {
            options: CleanupOptions::default(),
            source_page_index,
            half,
            width: 700,
            height,
            paper_width: 700.0,
            paper_height: height as f64,
            content_detected: false,
            spread_content_top,
            optical_content_bounds_x: None,
            fold_side_near_paper_run: 0,
            outer_near_paper_edge_runs: NearPaperEdgeRuns::default(),
        }
    }

    #[test]
    fn matched_canvas_dimension_uses_nearest_rank_ninetieth_percentile() {
        assert_eq!(robust_quantile_dimension([60, 60].into_iter()), 60);
        assert_eq!(
            robust_quantile_dimension([80, 80, 80, 80, 80, 80, 80, 80, 80, 140].into_iter()),
            80
        );
    }

    #[test]
    fn background_publication_guard_handles_coarse_grid_rounding_boundary() {
        let canvas = GeometryCanvas {
            width_points: 411.0,
            height_points: 595.0,
            width_px: 1_713,
            height_px: 2_479,
        };
        let expected = background_canvas_dimensions(&canvas, 150.0);
        assert_eq!(expected, (856, 1_240));
        for (actual, expected_target) in [
            (expected, expected),
            ((855, 1_239), expected),
            ((857, 1_241), expected),
        ] {
            assert_eq!(
                background_dimensions_to_publish(
                    actual.0,
                    actual.1,
                    expected_target.0,
                    expected_target.1,
                ),
                expected,
                "actual background dimensions: {actual:?}",
            );
        }
    }

    #[test]
    fn matched_canvas_uses_one_paper_scale_across_an_off_center_spread_cutter() {
        let options = CleanupOptions {
            dpi: 150.0,
            margins_pixels: Some([30.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 1_102.0 / 150.0 * 72.0,
            height_points: 1_626.0 / 150.0 * 72.0,
            width_px: 1_102,
            height_px: 1_626,
        };
        let left_paper = matched_output_paper_dimensions_for(
            2_203,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Left,
        );
        let right_paper = matched_output_paper_dimensions_for(
            2_203,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Right,
        );
        assert_eq!(left_paper, (1_101.5, 1_573.0));
        assert_eq!(right_paper, left_paper);

        let left = plan_canvas_placement_for(
            876,
            1_407,
            left_paper.0,
            left_paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Left,
            &canvas,
        );
        let right = plan_canvas_placement_for(
            607,
            1_405,
            right_paper.0,
            right_paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Right,
            &canvas,
        );

        assert_eq!(left.paper_scale, right.paper_scale);
        assert!(left.content_height.abs_diff(right.content_height) <= 2);
        assert_eq!((left.content_width, left.content_height), (876, 1_408));
        assert_eq!((right.content_width, right.content_height), (607, 1_406));
        assert_eq!((left.left, left.top), (113, 30));
        assert_eq!((right.left, right.top), (247, 30));
        assert_eq!(canvas.width_px - left.left - left.content_width, left.left);
        assert!((canvas.width_px - right.left - right.content_width).abs_diff(right.left) <= 1);
    }

    #[test]
    fn matched_canvas_uses_one_overflow_fit_across_an_off_center_spread_cutter() {
        let options = CleanupOptions {
            dpi: 150.0,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 1_102.0 / 150.0 * 72.0,
            height_points: 1_626.0 / 150.0 * 72.0,
            width_px: 1_102,
            height_px: 1_626,
        };
        let paper = matched_output_paper_dimensions_for(
            2_261,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Left,
        );
        let leaves = [(1_198, 1_198), (599, 599)];
        let shared_fit = leaves
            .into_iter()
            .map(|(width, height)| {
                canvas_fit_for(width, height, paper.0, paper.1, true, &options, &canvas)
                    .overflow_fit
            })
            .reduce(f64::min)
            .unwrap();
        assert!(shared_fit < 1.0);

        let left = plan_canvas_placement_for_with_optical_center_and_fit(
            leaves[0].0,
            leaves[0].1,
            paper.0,
            paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Left,
            &canvas,
            None,
            Some(shared_fit),
        );
        let right = plan_canvas_placement_for_with_optical_center_and_fit(
            leaves[1].0,
            leaves[1].1,
            paper.0,
            paper.1,
            true,
            &options,
            crate::pipeline::PageHalf::Right,
            &canvas,
            None,
            Some(shared_fit),
        );

        assert!(left.overflow);
        assert!(right.overflow);
        assert_eq!(
            left.content_width * leaves[1].0,
            right.content_width * leaves[0].0
        );
        assert_eq!(
            left.content_height * leaves[1].1,
            right.content_height * leaves[0].1
        );
    }

    #[test]
    fn fold_tail_with_pale_edge_glyph_is_never_trimmed() {
        let options = CleanupOptions {
            dpi: 150.0,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 1_102.0 / 150.0 * 72.0,
            height_points: 1_626.0 / 150.0 * 72.0,
            width_px: 1_102,
            height_px: 1_626,
        };
        let paper = matched_output_paper_dimensions_for(
            2_261,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Left,
        );
        let mut leaf = GrayImage::new(1_198, 64, 255);
        // Reviewer regression: a pale gray-246 glyph reaching the fold-side
        // edge is still writing, not disposable paper. No later white column
        // may be skipped over even though fitting requires horizontal trim.
        for y in 20..44 {
            leaf.set(1_197, y, 246);
        }
        let run = fold_side_near_paper_run_in_gray(&leaf, crate::pipeline::PageHalf::Left);
        let fit = canvas_fit_for(
            leaf.width(),
            leaf.height(),
            paper.0,
            paper.1,
            true,
            &options,
            &canvas,
        );
        let trim = fold_trim_for(leaf.width(), crate::pipeline::PageHalf::Left, run, fit);

        assert_eq!(run, 0);
        assert_eq!(trim.total(), 0);
        assert!(fit.overflow_fit < 1.0);
    }

    #[test]
    fn provably_white_fold_tail_restores_shared_fit_without_changing_leaf_scale() {
        let options = CleanupOptions {
            dpi: 150.0,
            margins_pixels: Some([0.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 1_102.0 / 150.0 * 72.0,
            height_points: 1_626.0 / 150.0 * 72.0,
            width_px: 1_102,
            height_px: 1_626,
        };
        let paper = matched_output_paper_dimensions_for(
            2_261,
            1_573,
            OrthogonalRotation::None,
            crate::pipeline::PageHalf::Left,
        );
        let mut left_raster = GrayImage::new(1_198, 1_198, 0);
        for y in 0..left_raster.height() {
            for x in 1_118..left_raster.width() {
                left_raster.set(x, y, 255);
            }
        }
        let left_fit = canvas_fit_for(
            left_raster.width(),
            left_raster.height(),
            paper.0,
            paper.1,
            true,
            &options,
            &canvas,
        );
        let left_trim = fold_trim_for(
            left_raster.width(),
            crate::pipeline::PageHalf::Left,
            fold_side_near_paper_run_in_gray(&left_raster, crate::pipeline::PageHalf::Left),
            left_fit,
        );
        let shared_fit = canvas_fit_for(
            left_trim.effective_width(left_raster.width()),
            left_raster.height(),
            paper.0,
            paper.1,
            true,
            &options,
            &canvas,
        )
        .overflow_fit
        .min(canvas_fit_for(599, 599, paper.0, paper.1, true, &options, &canvas).overflow_fit);

        let left = plan_canvas_placement(
            CanvasPlacementRequest {
                width: 1_198,
                height: 1_198,
                paper_width: paper.0,
                paper_height: paper.1,
                content_detected: true,
                options: &options,
                half: crate::pipeline::PageHalf::Left,
                optical_content_bounds_x: None,
                shared_overflow_fit: Some(shared_fit),
                fold_trim: left_trim,
                outer_near_paper_runs: Default::default(),
            },
            &canvas,
        );
        let right = plan_canvas_placement(
            CanvasPlacementRequest {
                width: 599,
                height: 599,
                paper_width: paper.0,
                paper_height: paper.1,
                content_detected: true,
                options: &options,
                half: crate::pipeline::PageHalf::Right,
                optical_content_bounds_x: None,
                shared_overflow_fit: Some(shared_fit),
                fold_trim: Default::default(),
                outer_near_paper_runs: Default::default(),
            },
            &canvas,
        );

        assert_eq!(shared_fit, 1.0);
        assert!(left_trim.right > 0);
        assert!(!left.overflow);
        assert!(!right.overflow);
        let left_scale = left.content_width as f64 / 1_198.0;
        let right_scale = right.content_width as f64 / 599.0;
        assert!((left_scale - right_scale).abs() < 0.001);
        assert_eq!(left.fold_trim_right, left_trim.right);
        assert!(left.fold_clip_right > 0);
        assert_eq!(left.fold_clip_left, 0);
        assert!(left.materialization_source_offset_right > 0);
    }

    #[test]
    fn matched_canvas_aligns_the_intrinsic_raster_inside_the_canvas() {
        let options = CleanupOptions {
            dpi: 360.0,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 700.0 / 360.0 * 72.0,
            height_points: 1_000.0 / 360.0 * 72.0,
            width_px: 700,
            height_px: 1_000,
        };

        let cropped = plan_canvas_placement_for(
            580,
            820,
            700.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );
        let uncropped = plan_canvas_placement_for(
            700,
            1_000,
            700.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        assert_eq!((cropped.left, cropped.top), (60, 0));
        assert_eq!((uncropped.left, uncropped.top), (0, 0));
        assert_eq!(cropped.content_width, 580);
        assert_eq!(cropped.content_height, 820);
    }

    #[test]
    fn spread_vertical_alignment_pins_asymmetric_crop_headroom_to_one_anchor() {
        let canvas = GeometryCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };
        let placement = |top| CanvasPlacement {
            content_width: 700,
            content_height: 700,
            left: 0,
            top,
            requested_margins: [0; 4],
            optical_content_centered: false,
            optical_content_fit_failed: false,
            optical_content_bounds_x: None,
            intrinsic_overflow_left: 0,
            intrinsic_overflow_right: 0,
            intrinsic_overflow_top: 0,
            fold_trim_left: 0,
            fold_trim_right: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            materialization_left: 0,
            materialization_source_offset_left: 0,
            materialization_source_offset_right: 0,
            margins_reduced: false,
            margins_unavailable: false,
            overflow: false,
            ink_aligned: false,
            paper_scale: 1.0,
            undersized_paper: false,
        };
        let mut placements = vec![
            Some((placement(100), canvas)),
            Some((placement(100), canvas)),
        ];

        align_spread_vertical_placements(
            &mut placements,
            &[1_000, 1_000],
            &[Some(20.0), Some(120.0)],
            &canvas,
        );

        let first = placements[0].as_ref().unwrap().0;
        let second = placements[1].as_ref().unwrap().0;
        let first_content_top = first.top as f64 + 20.0 * 0.7;
        let second_content_top = second.top as f64 + 120.0 * 0.7;
        assert_eq!(first.top, 170);
        assert_eq!(second.top, 100);
        assert!((first_content_top - second_content_top).abs() <= 0.5);
    }

    #[test]
    fn deferred_spread_placement_uses_the_shared_vertical_content_anchor() {
        let canvas = GeometryCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };
        let placement = |top| CanvasPlacement {
            content_width: 700,
            content_height: 700,
            left: 0,
            top,
            requested_margins: [0; 4],
            optical_content_centered: false,
            optical_content_fit_failed: false,
            optical_content_bounds_x: None,
            intrinsic_overflow_left: 0,
            intrinsic_overflow_right: 0,
            intrinsic_overflow_top: 0,
            fold_trim_left: 0,
            fold_trim_right: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            materialization_left: 0,
            materialization_source_offset_left: 0,
            materialization_source_offset_right: 0,
            margins_reduced: false,
            margins_unavailable: false,
            overflow: false,
            ink_aligned: false,
            paper_scale: 1.0,
            undersized_paper: false,
        };
        let mut placements = vec![placement(100), placement(100)];
        let outputs = [
            deferred_output(7, PageHalf::Left, 1_000, Some(20.0)),
            deferred_output(7, PageHalf::Right, 1_000, Some(120.0)),
        ];

        align_deferred_spread_vertical_placements(
            &mut placements,
            &outputs,
            &HashMap::from([(7, 1.0)]),
            &canvas,
        );

        assert_eq!(placements[0].top, 170);
        assert_eq!(placements[1].top, 100);
        assert_eq!(placements[0].intrinsic_overflow_top, 0);
        assert_eq!(placements[1].intrinsic_overflow_top, 0);
    }

    #[test]
    fn deferred_vertical_alignment_leaves_a_single_page_unchanged() {
        let canvas = GeometryCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };
        let original = CanvasPlacement {
            content_width: 700,
            content_height: 700,
            left: 150,
            top: 125,
            requested_margins: [10, 20, 30, 40],
            optical_content_centered: false,
            optical_content_fit_failed: false,
            optical_content_bounds_x: None,
            intrinsic_overflow_left: 0,
            intrinsic_overflow_right: 0,
            intrinsic_overflow_top: 0,
            fold_trim_left: 0,
            fold_trim_right: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            materialization_left: 150,
            materialization_source_offset_left: 0,
            materialization_source_offset_right: 0,
            margins_reduced: false,
            margins_unavailable: false,
            overflow: false,
            ink_aligned: false,
            paper_scale: 1.0,
            undersized_paper: false,
        };
        let mut placements = vec![original];
        let outputs = [deferred_output(3, PageHalf::Full, 1_000, Some(60.0))];

        align_deferred_spread_vertical_placements(
            &mut placements,
            &outputs,
            &HashMap::<usize, f64>::new(),
            &canvas,
        );

        assert_eq!(placements, [original]);
    }

    #[test]
    fn matched_canvas_aligns_intrinsic_whitespace_with_the_raster() {
        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };

        // The intrinsic raster carries 50 px of synthetic paper to its left.
        // Placement aligns that raster as one unit; source-space crop origins
        // remain mapping metadata and cannot move the raster on the canvas.
        let placement = plan_canvas_placement_for(
            850,
            1_000,
            800.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );
        assert_eq!(placement.left, 75);

        let mut intrinsic = GrayImage::new(850, 1_000, 255);
        intrinsic.set(50, 100, 0);
        let composed = place_on_white_canvas(
            &intrinsic,
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
        );
        assert_eq!(composed.get(100, 100), 255);
        assert_eq!(composed.get(125, 100), 0);
    }

    #[test]
    fn matched_canvas_centers_transformed_optical_ink_not_intrinsic_raster() {
        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };
        let mut binary = BinaryImage::new(580, 820);
        binary.set(100, 100, true);
        binary.set(120, 100, true);
        let optical_raster = CleanupRaster::Bilevel(binary);
        let optical_bounds = optical_content_bounds_x(&optical_raster);
        assert_eq!(optical_bounds, Some((100.0, 121.0)));
        let optical_center = optical_content_center_x(&optical_raster);
        assert_eq!(optical_center, Some(110.5));

        let placement = plan_canvas_placement_for_with_optical_center(
            580,
            820,
            700.0,
            1_000.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            optical_bounds,
        );

        assert_eq!(placement.left, 390);
        let scaled_center = optical_center.unwrap() * placement.content_width as f64 / 580.0;
        let placed_center = placement.left as f64 + scaled_center;
        assert!((placed_center - 500.0).abs() <= 0.5);
    }

    #[test]
    fn optical_bounds_ignore_a_sparse_corner_folio() {
        let mut binary = BinaryImage::new(400, 240);
        for y in 90..150 {
            for x in 100..300 {
                binary.set(x, y, true);
            }
        }
        binary.set(4, 4, true);
        let bounds = optical_binary_bounds_x(&binary).expect("title ink");
        assert!(bounds.0 >= 100.0);
        assert!(bounds.1 <= 300.0);

        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 480.0,
            height_points: 288.0,
            width_px: 480,
            height_px: 288,
        };
        let placement = plan_canvas_placement_for_with_optical_center(
            400,
            240,
            400.0,
            240.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            Some(bounds),
        );
        let scale = placement.content_width as f64 / 400.0;
        let center = placement.left as f64 + (bounds.0 + bounds.1) * 0.5 * scale;
        assert!((center - canvas.width_px as f64 / 2.0).abs() <= 0.5);
    }

    #[test]
    fn optical_placement_boundary_handles_empty_and_full_bleed_pages() {
        let options = CleanupOptions {
            dpi: 100.0,
            margins_pixels: Some([20.0; 4]),
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 480.0,
            height_points: 288.0,
            width_px: 480,
            height_px: 288,
        };
        let empty = BinaryImage::new(400, 240);
        let empty_placement = plan_canvas_placement_for_with_optical_center(
            400,
            240,
            400.0,
            240.0,
            false,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            optical_binary_bounds_x(&empty),
        );
        assert!(!empty_placement.optical_content_centered);
        assert_eq!(empty_placement.optical_content_bounds_x, None);

        let full_bleed = plan_canvas_placement_for_with_optical_center(
            400,
            240,
            400.0,
            240.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            Some((0.0, 400.0)),
        );
        let scale = full_bleed.content_width as f64 / 400.0;
        assert!(
            full_bleed.left as f64 + 400.0 * scale
                <= canvas.width_px as f64 - options.margins_pixels.unwrap()[2] + 0.5
        );
        assert_eq!(full_bleed.intrinsic_overflow_right, 0);
    }

    #[test]
    fn matched_canvas_centers_optical_box_when_white_raster_tail_overhangs() {
        let options = CleanupOptions {
            dpi: 299.0,
            margins_mm: None,
            margins_pixels: Some([59.0; 4]),
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 2_196.0 / 299.0 * 72.0,
            height_points: 3_241.0 / 299.0 * 72.0,
            width_px: 2_196,
            height_px: 3_241,
        };
        let optical_bounds = Some((10.0, 1_811.0));
        let placement = plan_canvas_placement_for_with_optical_center(
            2_038,
            2_940,
            2_196.0,
            3_241.0,
            true,
            &options,
            crate::pipeline::PageHalf::Left,
            &canvas,
            optical_bounds,
        );

        // The white tail may not push the payload past the canvas: the raster
        // slides back inside, and the ink center drifts from ideal by at most
        // the tail width it displaced.
        assert!(placement.left + placement.content_width <= canvas.width_px);
        assert_eq!(placement.left, canvas.width_px - placement.content_width);
        assert_eq!(placement.intrinsic_overflow_right, 0);
        let scaled_center = 910.5 * placement.content_width as f64 / 2_038.0;
        let drift = (placement.left as f64 + scaled_center - 1_098.0).abs();
        assert!(
            drift <= 30.0,
            "center drift {drift} exceeds the displaced tail"
        );
    }

    #[test]
    fn sparse_left_title_leaf_centers_visible_stencil_with_proven_outer_overhang() {
        let options = CleanupOptions {
            dpi: 299.0,
            margins_mm: None,
            margins_pixels: Some([59.0; 4]),
            page_alignment: crate::PageAlignment::TopCenter,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 2_196.0 / 299.0 * 72.0,
            height_points: 3_241.0 / 299.0 * 72.0,
            width_px: 2_196,
            height_px: 3_241,
        };
        let left = plan_canvas_placement(
            CanvasPlacementRequest {
                width: 2_298,
                height: 2_810,
                paper_width: 2_196.0,
                paper_height: 3_136.0,
                content_detected: true,
                options: &options,
                half: crate::pipeline::PageHalf::Left,
                optical_content_bounds_x: Some((336.0, 2_002.0)),
                shared_overflow_fit: Some(1.0),
                fold_trim: FoldSideTrim {
                    left: 0,
                    right: 219,
                },
                outer_near_paper_runs: NearPaperEdgeRuns {
                    left: 300,
                    right: 0,
                },
            },
            &canvas,
        );
        let right = plan_canvas_placement(
            CanvasPlacementRequest {
                width: 1_605,
                height: 3_098,
                paper_width: 2_196.0,
                paper_height: 3_136.0,
                content_detected: true,
                options: &options,
                half: crate::pipeline::PageHalf::Right,
                optical_content_bounds_x: Some((175.0, 1_301.0)),
                shared_overflow_fit: Some(1.0),
                fold_trim: FoldSideTrim::default(),
                outer_near_paper_runs: NearPaperEdgeRuns::default(),
            },
            &canvas,
        );

        assert_eq!(left.intrinsic_overflow_left, 71);
        assert_eq!(left.intrinsic_overflow_right, 31);
        assert_eq!(left.materialization_source_offset_left, 71);
        assert_eq!(left.materialization_source_offset_right, 219);
        let left_optical_center = -71.0 + (336.0 + 2_002.0) * 0.5;
        assert_eq!(left_optical_center, canvas.width_px as f64 * 0.5);
        // The balanced facing leaf is pinned to its pre-fix placement.
        assert_eq!(right.left, 360);
        assert_eq!(right.intrinsic_overflow_left, 0);
        assert_eq!(right.intrinsic_overflow_right, 0);
    }

    #[test]
    fn a_measured_optical_box_is_published_without_moving_the_placement() {
        let options = CleanupOptions {
            dpi: 100.0,
            margins_mm: None,
            margins_pixels: Some([20.0; 4]),
            page_alignment: crate::PageAlignment::TopCenter,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 480.0,
            height_points: 288.0,
            width_px: 480,
            height_px: 288,
        };
        // Ink that sits well left of the middle of its retained raster: the
        // condition that used to pull the whole leaf sideways.
        let optical_content_bounds_x = Some((10.0, 200.0));
        let output = GeometryOutput {
            options: options.clone(),
            source_page_index: 0,
            half: crate::pipeline::PageHalf::Full,
            width: 400,
            height: 240,
            paper_width: 400.0,
            paper_height: 240.0,
            content_detected: true,
            spread_content_top: None,
            optical_content_bounds_x,
            fold_side_near_paper_run: 0,
            outer_near_paper_edge_runs: NearPaperEdgeRuns::default(),
        };

        let placed = plan_canvas_placement_with_shared_fit(&output, &canvas, None, None);
        let geometric = plan_canvas_placement_for(
            output.width,
            output.height,
            output.paper_width,
            output.paper_height,
            output.content_detected,
            &options,
            output.half,
            &canvas,
        );

        // One physical placement policy: the retained content rectangle is
        // aligned inside the requested margin box, and a measurement only this
        // raster can make does not move it away from where the lossless
        // assembler and the preview fitter place the same page.
        assert_eq!(
            placed,
            CanvasPlacement {
                optical_content_bounds_x,
                ..geometric
            }
        );
        assert!(!placed.optical_content_centered);
        assert_eq!(placed.intrinsic_overflow_left, 0);
        assert_eq!(placed.intrinsic_overflow_right, 0);
        // The measurement itself is still published for this output.
        assert_eq!(placed.optical_content_bounds_x, optical_content_bounds_x);
    }

    #[test]
    fn deferred_sparse_leaf_uses_carried_optical_bounds_and_outer_edge_proof() {
        let options = CleanupOptions {
            dpi: 299.0,
            margins_mm: None,
            margins_pixels: Some([59.0; 4]),
            page_alignment: crate::PageAlignment::TopCenter,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 2_196.0 / 299.0 * 72.0,
            height_points: 3_241.0 / 299.0 * 72.0,
            width_px: 2_196,
            height_px: 3_241,
        };
        let output = GeometryOutput {
            options: options.clone(),
            source_page_index: 0,
            half: crate::pipeline::PageHalf::Left,
            width: 2_298,
            height: 2_810,
            paper_width: 2_196.0,
            paper_height: 3_136.0,
            content_detected: true,
            spread_content_top: None,
            optical_content_bounds_x: Some((336.0, 2_002.0)),
            fold_side_near_paper_run: 219,
            outer_near_paper_edge_runs: NearPaperEdgeRuns {
                left: 300,
                right: 0,
            },
        };
        let shared_plan = SharedSpreadOverflowPlan {
            shared_fit: 1.0,
            trims: vec![FoldSideTrim {
                left: 0,
                right: 219,
            }],
        };

        let deferred = plan_canvas_placement_with_shared_fit(
            &output,
            &canvas,
            Some(&shared_plan),
            Some(shared_plan.trims[0]),
        );
        let in_memory = plan_canvas_placement(
            CanvasPlacementRequest {
                width: output.width,
                height: output.height,
                paper_width: output.paper_width,
                paper_height: output.paper_height,
                content_detected: output.content_detected,
                options: &options,
                half: output.half,
                optical_content_bounds_x: PLACEMENT_CENTERING_BOUNDS_X,
                shared_overflow_fit: Some(shared_plan.shared_fit),
                fold_trim: shared_plan.trims[0],
                outer_near_paper_runs: output.outer_near_paper_edge_runs,
            },
            &canvas,
        );

        assert_eq!(
            deferred,
            CanvasPlacement {
                optical_content_bounds_x: output.optical_content_bounds_x,
                ..in_memory
            }
        );
        // The carried ownership box is still published for this leaf even
        // though it no longer moves it.
        assert_eq!(deferred.optical_content_bounds_x, Some((336.0, 2_002.0)));
        // The retained raster is aligned inside the requested margin box. Its
        // fold-side tail is still conserved rather than clipped away, so the
        // overhang the materializer has to account for is reported and the
        // published origin stays inside the canvas.
        assert_eq!(deferred.left, 59);
        assert_eq!(deferred.intrinsic_overflow_left, 0);
        assert_eq!(deferred.intrinsic_overflow_right, 161);
        assert_eq!(deferred.materialization_source_offset_right, 219);
    }

    #[test]
    fn outer_edge_glyph_blocks_optical_overhang() {
        let options = CleanupOptions {
            dpi: 100.0,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 720.0,
            height_points: 360.0,
            width_px: 1_000,
            height_px: 500,
        };
        let mut leaf = GrayImage::new(1_000, 500, 255);
        leaf.set(0, 250, 0);
        let outer_run = edge_near_paper_run_in_gray(&leaf, HorizontalEdge::Left);
        let placement = plan_canvas_placement(
            CanvasPlacementRequest {
                width: 1_000,
                height: 500,
                paper_width: 1_000.0,
                paper_height: 500.0,
                content_detected: true,
                options: &options,
                half: crate::pipeline::PageHalf::Full,
                optical_content_bounds_x: Some((300.0, 950.0)),
                shared_overflow_fit: None,
                fold_trim: FoldSideTrim::default(),
                outer_near_paper_runs: NearPaperEdgeRuns {
                    left: outer_run,
                    right: 0,
                },
            },
            &canvas,
        );

        assert_eq!(outer_run, 0);
        assert_eq!(placement.left, 0);
        assert_eq!(placement.intrinsic_overflow_left, 0);
        assert_eq!(placement.intrinsic_overflow_right, 0);
    }

    #[test]
    fn matched_canvas_records_and_clips_a_white_left_raster_tail() {
        let options = CleanupOptions {
            dpi: 100.0,
            margins_mm: None,
            margins_pixels: Some([0.0; 4]),
            page_alignment: crate::PageAlignment::Center,
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 720.0,
            height_points: 360.0,
            width_px: 1_000,
            height_px: 500,
        };
        let placement = plan_canvas_placement_for_with_optical_center(
            1_000,
            500,
            1_000.0,
            500.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
            Some((300.0, 950.0)),
        );

        // A full-width raster cannot shift at all: it stays at the origin
        // with no overhang, and every source pixel keeps its coordinate.
        assert_eq!(placement.left, 0);
        assert_eq!(placement.intrinsic_overflow_left, 0);
        assert_eq!(placement.intrinsic_overflow_right, 0);

        let mut source = GrayImage::new(1_000, 500, 255);
        source.set(625, 250, 0);
        let materialized = place_on_white_canvas_with_source_offset(
            &source,
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
            placement.intrinsic_overflow_left,
        );
        assert_eq!(materialized.get(625, 250), 0);
    }

    #[test]
    fn matched_gray_primary_with_intrinsic_margins_is_materialized_on_canvas() {
        let canvas = GeometryCanvas {
            width_points: 720.0,
            height_points: 600.0,
            width_px: 12,
            height_px: 10,
        };
        let placement = CanvasPlacement {
            content_width: 6,
            content_height: 4,
            left: 3,
            top: 2,
            requested_margins: [0; 4],
            optical_content_centered: false,
            optical_content_fit_failed: false,
            optical_content_bounds_x: None,
            intrinsic_overflow_left: 0,
            intrinsic_overflow_right: 0,
            intrinsic_overflow_top: 0,
            fold_trim_left: 0,
            fold_trim_right: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            materialization_left: 3,
            materialization_source_offset_left: 0,
            materialization_source_offset_right: 0,
            margins_reduced: false,
            margins_unavailable: false,
            overflow: false,
            ink_aligned: false,
            paper_scale: 1.0,
            undersized_paper: false,
        };
        let source = GrayImage::new(10, 8, 0);
        let materialized = materialize_gray_primary_on_canvas(&source, placement, &canvas);

        assert_eq!((materialized.width(), materialized.height()), (12, 10));
        assert_eq!(materialized.get(2, 2), 255);
        assert_eq!(materialized.get(3, 2), 0);
        assert_eq!(materialized.get(8, 5), 0);
        assert_eq!(materialized.get(9, 2), 255);
    }

    #[test]
    fn matched_canvas_keeps_requested_margins_on_the_final_grid() {
        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::Center,
            margins_pixels: Some([20.0; 4]),
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        };

        let placement = plan_canvas_placement_for(
            1_000,
            1_000,
            1_000.0,
            1_000.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        assert_eq!(placement.requested_margins, [20; 4]);
        assert_eq!((placement.left, placement.top), (20, 20));
        assert_eq!(
            (placement.content_width, placement.content_height),
            (960, 960)
        );
        let intrinsic = GrayImage::new(1_000, 1_000, 0);
        let composed = place_on_white_canvas(
            &intrinsic.resample_to_dimensions(placement.content_width, placement.content_height),
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
        );
        assert_eq!(composed.get(19, 20), 255);
        assert_eq!(composed.get(20, 20), 0);
        assert_eq!(composed.get(979, 979), 0);
        assert_eq!(composed.get(980, 979), 255);
    }

    #[test]
    fn matched_canvas_converts_millimeter_margins_on_the_final_grid() {
        let options = CleanupOptions {
            dpi: 360.0,
            page_alignment: crate::PageAlignment::Center,
            margins_mm: Some(crate::MarginsMm {
                left_mm: 5.0,
                top_mm: 5.0,
                right_mm: 5.0,
                bottom_mm: 5.0,
            }),
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 200.0,
            height_points: 200.0,
            width_px: 1_000,
            height_px: 1_000,
        };

        let placement = plan_canvas_placement_for(
            1_000,
            1_000,
            1_000.0,
            1_000.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        // 5 mm at 360 DPI is 70.866 px: reserve the nearest final-grid
        // pixel. Alignment/cropping may leave a larger band, never a smaller
        // one.
        assert_eq!(placement.requested_margins, [71; 4]);
        assert_eq!((placement.left, placement.top), (71, 71));
        assert_eq!(
            (placement.content_width, placement.content_height),
            (858, 858)
        );
        let intrinsic = GrayImage::new(1_000, 1_000, 0);
        let composed = place_on_white_canvas(
            &intrinsic.resample_to_dimensions(placement.content_width, placement.content_height),
            canvas.width_px,
            canvas.height_px,
            placement.left,
            placement.top,
        );
        assert_eq!(composed.get(70, 71), 255);
        assert_eq!(composed.get(71, 71), 0);
        assert_eq!(composed.get(928, 928), 0);
        assert_eq!(composed.get(929, 928), 255);
    }

    #[test]
    fn matched_canvas_honors_every_alignment_inside_asymmetric_margins() {
        let canvas = GeometryCanvas {
            width_points: 144.0,
            height_points: 129.6,
            width_px: 200,
            height_px: 180,
        };
        let cases = [
            (crate::PageAlignment::TopLeft, (11, 13)),
            (crate::PageAlignment::TopCenter, (67, 13)),
            (crate::PageAlignment::TopRight, (123, 13)),
            (crate::PageAlignment::CenterLeft, (11, 67)),
            (crate::PageAlignment::Center, (67, 67)),
            (crate::PageAlignment::CenterRight, (123, 67)),
            (crate::PageAlignment::BottomLeft, (11, 121)),
            (crate::PageAlignment::BottomCenter, (67, 121)),
            (crate::PageAlignment::BottomRight, (123, 121)),
        ];

        for (page_alignment, expected) in cases {
            let options = CleanupOptions {
                dpi: 100.0,
                page_alignment,
                margins_pixels: Some([11.0, 13.0, 17.0, 19.0]),
                ..CleanupOptions::default()
            };
            let placement = plan_canvas_placement_for(
                60,
                40,
                200.0,
                180.0,
                true,
                &options,
                crate::pipeline::PageHalf::Full,
                &canvas,
            );

            assert_eq!(placement.requested_margins, [11, 13, 17, 19]);
            assert_eq!(
                (placement.content_width, placement.content_height),
                (60, 40)
            );
            assert_eq!((placement.left, placement.top), expected);
        }
    }

    #[test]
    fn matched_canvas_keeps_bottom_right_alignment_when_margins_are_reduced() {
        let options = CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::BottomRight,
            margins_pixels: Some([8.0, 9.0, 4.0, 3.0]),
            ..CleanupOptions::default()
        };
        let canvas = GeometryCanvas {
            width_points: 7.2,
            height_points: 5.76,
            width_px: 10,
            height_px: 8,
        };

        let placement = plan_canvas_placement_for(
            4,
            4,
            10.0,
            8.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        assert!(placement.margins_reduced);
        assert_eq!(placement.requested_margins, [6, 5, 3, 2]);
        assert_eq!((placement.content_width, placement.content_height), (1, 1));
        assert_eq!((placement.left, placement.top), (6, 5));
    }

    fn ink_anchor_canvas() -> GeometryCanvas {
        GeometryCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        }
    }

    fn ink_anchor_options(anchor: Option<crate::PlacementAnchor>) -> CleanupOptions {
        CleanupOptions {
            dpi: 100.0,
            page_alignment: crate::PageAlignment::Ink,
            margins_pixels: Some([20.0; 4]),
            placement_anchors: crate::PlacementAnchors {
                full: anchor,
                ..crate::PlacementAnchors::default()
            },
            ..CleanupOptions::default()
        }
    }

    fn ink_anchored_placement(
        anchor: Option<crate::PlacementAnchor>,
        height: usize,
        optical_content_bounds_x: Option<(f64, f64)>,
    ) -> CanvasPlacement {
        let canvas = ink_anchor_canvas();
        plan_canvas_placement_for_with_optical_center(
            600,
            height,
            1_000.0,
            1_000.0,
            true,
            &ink_anchor_options(anchor),
            crate::pipeline::PageHalf::Full,
            &canvas,
            optical_content_bounds_x,
        )
    }

    #[test]
    fn ink_anchor_places_the_leaf_vertically_where_its_source_ink_sat() {
        let anchored = |y_normalized| {
            ink_anchored_placement(Some(crate::PlacementAnchor { y_normalized }), 400, None)
        };

        // Margins bound the inner box to 960 px; the anchor is a fraction of
        // that box, measured from its top edge.
        assert_eq!(anchored(0.0).top, 20);
        assert_eq!(anchored(0.5).top, 500);
        assert_eq!(anchored(1.0).top, 580);

        // A page whose content is too tall to start where its ink sat keeps
        // the requested bottom margin instead of overhanging it.
        let tall = ink_anchored_placement(
            Some(crate::PlacementAnchor { y_normalized: 0.9 }),
            800,
            None,
        );
        assert_eq!(tall.content_height, 800);
        assert_eq!(tall.top, 180);
        assert_eq!(tall.top + tall.content_height, 980);
    }

    #[test]
    fn ink_anchor_leaves_the_horizontal_placement_to_top_center() {
        let placed = |page_alignment, optical| {
            let canvas = ink_anchor_canvas();
            let placement = plan_canvas_placement_for_with_optical_center(
                600,
                400,
                1_000.0,
                1_000.0,
                true,
                &CleanupOptions {
                    page_alignment,
                    ..ink_anchor_options(Some(crate::PlacementAnchor { y_normalized: 0.3 }))
                },
                crate::pipeline::PageHalf::Full,
                &canvas,
                optical,
            );
            (
                placement.left,
                placement.content_width,
                placement.optical_content_centered,
                placement.optical_content_fit_failed,
            )
        };

        // Ink only moves content vertically. Whatever the ink's horizontal
        // position was on the source, the raster is centred like top-center —
        // and so is the optical ink box when native measured one — because a
        // page's horizontal answer is not something a scanner's gutter offset
        // should be allowed to keep.
        for optical in [None, Some((100.0, 200.0)), Some((0.0, 80.0))] {
            assert_eq!(
                placed(crate::PageAlignment::Ink, optical),
                placed(crate::PageAlignment::TopCenter, optical),
                "{optical:?}"
            );
        }
        let anchored = ink_anchored_placement(
            Some(crate::PlacementAnchor { y_normalized: 0.3 }),
            400,
            None,
        );
        assert_eq!(anchored.left + anchored.content_width / 2, 500);
        assert_eq!(anchored.top, 308);
    }

    #[test]
    fn ink_alignment_without_an_anchor_places_exactly_like_top_center() {
        let canvas = ink_anchor_canvas();
        let placed = |page_alignment| {
            let options = CleanupOptions {
                page_alignment,
                ..ink_anchor_options(None)
            };
            let placement = plan_canvas_placement_for(
                600,
                400,
                1_000.0,
                1_000.0,
                true,
                &options,
                crate::pipeline::PageHalf::Full,
                &canvas,
            );
            (
                placement.left,
                placement.top,
                placement.content_width,
                placement.content_height,
                placement.ink_aligned,
            )
        };

        assert_eq!(
            placed(crate::PageAlignment::Ink),
            placed(crate::PageAlignment::TopCenter)
        );
    }

    #[test]
    fn manual_placement_override_outranks_the_ink_anchor() {
        let canvas = ink_anchor_canvas();
        let options = CleanupOptions {
            placement_overrides: crate::PlacementOverrides {
                full: Some(crate::PageAlignment::BottomRight),
                ..crate::PlacementOverrides::default()
            },
            ..ink_anchor_options(Some(crate::PlacementAnchor { y_normalized: 0.1 }))
        };

        let placement = plan_canvas_placement_for(
            600,
            400,
            1_000.0,
            1_000.0,
            true,
            &options,
            crate::pipeline::PageHalf::Full,
            &canvas,
        );

        assert!(!placement.ink_aligned);
        assert_eq!((placement.left, placement.top), (380, 580));
    }

    #[test]
    fn ink_anchored_spread_keeps_the_document_wide_vertical_answer() {
        let canvas = ink_anchor_canvas();
        let leaf = |y_normalized| {
            ink_anchored_placement(Some(crate::PlacementAnchor { y_normalized }), 400, None)
        };
        let first = leaf(0.1);
        let second = leaf(0.3);
        assert_eq!((first.top, second.top), (116, 308));

        let mut placements = vec![Some((first, canvas)), Some((second, canvas))];
        align_spread_vertical_placements(
            &mut placements,
            &[400, 400],
            &[Some(20.0), Some(120.0)],
            &canvas,
        );
        assert_eq!(placements[0].unwrap().0, first);
        assert_eq!(placements[1].unwrap().0, second);

        let mut deferred = vec![first, second];
        align_deferred_spread_vertical_placements(
            &mut deferred,
            &[
                deferred_output(4, PageHalf::Left, 400, Some(20.0)),
                deferred_output(4, PageHalf::Right, 400, Some(120.0)),
            ],
            &HashMap::from([(4, 1.0)]),
            &canvas,
        );
        assert_eq!(deferred, [first, second]);

        // The same pair without ink alignment is still equalized, so the
        // no-op above is the Ink contract and not an inert call.
        let unanchored = |top| CanvasPlacement {
            ink_aligned: false,
            top,
            ..first
        };
        let mut equalized = vec![
            Some((unanchored(first.top), canvas)),
            Some((unanchored(second.top), canvas)),
        ];
        align_spread_vertical_placements(
            &mut equalized,
            &[400, 400],
            &[Some(20.0), Some(120.0)],
            &canvas,
        );
        assert_ne!(equalized[0].unwrap().0.top, first.top);
    }

    fn warning_event_canvas() -> GeometryCanvas {
        GeometryCanvas {
            width_points: 720.0,
            height_points: 720.0,
            width_px: 1_000,
            height_px: 1_000,
        }
    }

    fn warning_event_placement() -> CanvasPlacement {
        CanvasPlacement {
            content_width: 700,
            content_height: 700,
            left: 0,
            top: 0,
            requested_margins: [0; 4],
            optical_content_centered: false,
            optical_content_fit_failed: false,
            optical_content_bounds_x: None,
            intrinsic_overflow_left: 0,
            intrinsic_overflow_right: 0,
            intrinsic_overflow_top: 0,
            fold_trim_left: 0,
            fold_trim_right: 0,
            fold_clip_left: 0,
            fold_clip_right: 0,
            materialization_left: 0,
            materialization_source_offset_left: 0,
            materialization_source_offset_right: 0,
            margins_reduced: false,
            margins_unavailable: false,
            overflow: false,
            ink_aligned: false,
            paper_scale: 1.0,
            undersized_paper: false,
        }
    }

    #[test]
    fn placement_without_conditions_reports_no_warning_events() {
        assert_eq!(
            canvas_placement_warning_events(
                warning_event_placement(),
                &warning_event_canvas(),
                true
            ),
            Vec::new()
        );
    }

    #[test]
    fn fitted_placement_reports_the_margin_box_it_was_fitted_into() {
        let placement = CanvasPlacement {
            overflow: true,
            content_width: 600,
            content_height: 500,
            requested_margins: [24, 24, 24, 24],
            ..warning_event_placement()
        };

        assert_eq!(
            canvas_placement_warning_events(placement, &warning_event_canvas(), true),
            vec![CanvasWarning::MatchedCanvasContentFitted {
                content_width: 600.0,
                content_height: 500.0,
                inner_width: 952.0,
                inner_height: 952.0,
                document_canvas_width: Some(1_000.0),
                document_canvas_height: Some(1_000.0),
            }]
        );
    }

    #[test]
    fn intrinsic_overflow_reports_both_sides_it_extends_past() {
        let placement = CanvasPlacement {
            intrinsic_overflow_left: 7,
            intrinsic_overflow_right: 3,
            ..warning_event_placement()
        };

        assert_eq!(
            canvas_placement_warning_events(placement, &warning_event_canvas(), true),
            vec![CanvasWarning::MatchedCanvasIntrinsicOverflow {
                left_px: 7,
                right_px: 3,
            }]
        );
    }

    #[test]
    fn spread_headroom_trim_reports_the_rows_above_the_shared_anchor() {
        let placement = CanvasPlacement {
            intrinsic_overflow_top: 12,
            ..warning_event_placement()
        };

        assert_eq!(
            canvas_placement_warning_events(placement, &warning_event_canvas(), true),
            vec![CanvasWarning::MatchedCanvasSpreadHeadroomTrimmed { top_px: 12 }]
        );
    }

    #[test]
    fn fold_side_trim_reports_the_columns_each_leaf_lost() {
        let placement = CanvasPlacement {
            fold_trim_left: 5,
            fold_trim_right: 9,
            ..warning_event_placement()
        };

        assert_eq!(
            canvas_placement_warning_events(placement, &warning_event_canvas(), true),
            vec![CanvasWarning::MatchedCanvasFoldColumnsDiscarded {
                left_columns: 5,
                right_columns: 9,
            }]
        );
    }

    #[test]
    fn optical_centering_fallback_is_reported_only_with_detected_content() {
        let placement = CanvasPlacement {
            optical_content_fit_failed: true,
            ..warning_event_placement()
        };

        assert_eq!(
            canvas_placement_warning_events(placement, &warning_event_canvas(), true),
            vec![CanvasWarning::MatchedCanvasOpticalCenteringFallback]
        );
        assert_eq!(
            canvas_placement_warning_events(placement, &warning_event_canvas(), false),
            Vec::new()
        );
    }

    #[test]
    fn reduced_and_unavailable_margins_report_their_own_codes() {
        let placement = CanvasPlacement {
            margins_reduced: true,
            margins_unavailable: true,
            ..warning_event_placement()
        };

        assert_eq!(
            canvas_placement_warning_events(placement, &warning_event_canvas(), true),
            vec![
                CanvasWarning::MatchedCanvasMarginsReduced,
                CanvasWarning::MatchedCanvasMarginsUnavailable,
            ]
        );
    }

    #[test]
    fn undersized_paper_reports_the_scale_it_was_placed_at() {
        let placement = CanvasPlacement {
            undersized_paper: true,
            paper_scale: 0.5,
            ..warning_event_placement()
        };

        assert_eq!(
            canvas_placement_warning_events(placement, &warning_event_canvas(), true),
            vec![CanvasWarning::MatchedCanvasPaperDownscaled {
                paper_scale: 0.5,
                document_canvas_width: 1_000.0,
                document_canvas_height: 1_000.0,
                paper_width: None,
                paper_height: None,
            }]
        );
    }

    #[test]
    fn plain_geometry_planes_drive_ownership_and_mask_composition() {
        let canvas = warning_event_canvas();
        let placement = warning_event_placement();
        let mut mask = BinaryImage::new(8, 6);
        mask.set(2, 3, true);
        let planes = GeometryPlaneView {
            image: GeometryRasterView::Bilevel(&mask),
            color_image: None,
            picture_mask: Some(&mask),
            tone_preservation_alpha: None,
            mixed_layers: None,
            output_mode: OutputMode::Mixed,
            half: PageHalf::Full,
            fallback_content_top: None,
        };

        let ownership = content_ownership(&planes).unwrap();
        assert!(ownership.get(2, 3));
        assert_eq!(planes_optical_content_bounds_x(&planes), Some((2.0, 3.0)));

        let composed_mask = compose_picture_mask(Some(mask.clone()), placement, &canvas);
        assert_eq!(composed_mask.as_ref().unwrap().width(), canvas.width_px);
        assert_eq!(composed_mask.as_ref().unwrap().height(), canvas.height_px);
        assert!(composed_mask.as_ref().unwrap().count_black() > 0);
    }

    #[test]
    fn composition_preserves_primary_and_tone_pixels() {
        let canvas = GeometryCanvas {
            width_points: 4.0,
            height_points: 4.0,
            width_px: 4,
            height_px: 4,
        };
        let mut placement = warning_event_placement();
        placement.content_width = 2;
        placement.content_height = 2;
        placement.left = 1;
        placement.top = 1;
        placement.materialization_left = 1;
        let mut source = GrayImage::new(2, 2, 0);
        source.set(0, 0, 10);
        source.set(1, 0, 20);
        source.set(0, 1, 30);
        source.set(1, 1, 40);
        let (GeometryRaster::Gray(primary), _) =
            compose_primary_raster(GeometryRaster::Gray(source), None, placement, &canvas)
        else {
            panic!("expected gray primary");
        };
        assert_eq!(primary.get(1, 1), 10);
        assert_eq!(primary.get(2, 1), 20);
        assert_eq!(primary.get(1, 2), 30);
        assert_eq!(primary.get(2, 2), 40);

        let mut alpha = GrayImage::new(2, 2, 0);
        alpha.set(1, 1, 200);
        let placed_alpha =
            compose_tone_preservation_alpha(Some(alpha), placement, &canvas).unwrap();
        assert_eq!(placed_alpha.get(2, 2), 200);
        assert_eq!(placed_alpha.get(0, 0), 0);
    }

    #[test]
    fn mixed_restore_changes_owned_pixels_in_gray_and_color_planes() {
        let mut mask = BinaryImage::new(2, 1);
        mask.set(1, 0, true);
        let background = GrayImage::new(2, 1, 100);
        let mut color = RgbImage::new(2, 1, [20, 30, 40]);
        color.set(1, 0, [90, 80, 70]);
        let restored = restore_mixed_composite(Some(GeometryMixedLayersView {
            foreground_mask: &mask,
            foreground_alpha: None,
            background: &background,
            color_background: Some(&color),
        }))
        .unwrap();
        let (GeometryRaster::Gray(gray), Some(color)) = restored else {
            panic!("expected gray and color composite");
        };
        assert_eq!(gray.get(0, 0), 100);
        assert_eq!(gray.get(1, 0), 0);
        assert_eq!(color.get(0, 0), [20, 30, 40]);
        assert_eq!(color.get(1, 0), [0, 0, 0]);
    }

    #[test]
    fn canvas_metadata_facts_keep_margin_and_overflow_math_plain() {
        let mut placement = warning_event_placement();
        placement.content_width = 900;
        placement.content_height = 700;
        placement.left = 10;
        placement.top = 20;
        placement.intrinsic_overflow_left = 15;
        placement.intrinsic_overflow_top = 5;
        let facts = canvas_metadata_facts(placement, &warning_event_canvas());

        assert_eq!(facts.soft_margins_pixels, [0, 15, 105, 285]);
        assert!(facts.canvas_overflow);
        assert_eq!(placement.content_width, 900);
        assert_eq!(placement.top, 20);
    }
}
