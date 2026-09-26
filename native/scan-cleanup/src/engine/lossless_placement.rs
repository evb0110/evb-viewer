//! Matched-canvas placement for the lossless route, in PDF points.
//!
//! The lossless assembler never rasterizes: each output is a window onto the
//! source page, optionally scaled, written by `evb-pdf-page-ops split-pages`.
//! This module decides that window and transform, and projects the same
//! decision onto the preview's pixel canvas, so the preview and the assembled
//! page are one program.
use crate::domain::geometry::{AppliedMargins, PageHalf};
use crate::engine::output_geometry::write_json_atomic;
use crate::engine::render::{quantize_decimal_half_up, CleanupWarningEvent, WarningExtentUnit};
use crate::pipeline::{AnalysisOutputMetadata, CleanupMetadata};
use crate::protocol::manifest_v3::DocumentCanvas;
use crate::{CleanupOptions, OrthogonalRotation, PageAlignment};
use scan_primitives::Rect;
use serde::{Deserialize, Serialize};
use std::{error::Error, fs, path::Path};

/// Paper that is already the canvas needs no scaling at all; anything past
/// this is a real difference in the paper the scanner produced.
const CONTENT_SCALE_EPSILON: f64 = 0.001;
/// A sheet rounded onto the shared grid may land one pixel past the rectangle
/// it is identical to; only paper needing more grid than that is larger.
const GRID_TOLERANCE_PX: f64 = 1.0;

/// The source page's view box in PDF user space, its display rotation, and the
/// resolution of its raster, which is the grid margins are fitted on.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfPageGeometry {
    pub x_points: f64,
    pub y_points: f64,
    pub width_points: f64,
    pub height_points: f64,
    pub rotation: i64,
    pub source_dpi: f64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentTransform {
    pub scale: f64,
    pub translate_x: f64,
    pub translate_y: f64,
}

/// Where one lossless output lands on the preview's pixel canvas.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPlacement {
    pub canvas_width_px: usize,
    pub canvas_height_px: usize,
    pub content_width_px: usize,
    pub content_height_px: usize,
    pub offset_x_px: usize,
    pub offset_y_px: usize,
    pub margins: AppliedMargins,
    pub canvas_overflow: bool,
}

/// The window `split-pages` cuts from the source page and the transform it
/// applies first, plus the conditions the placement had to report.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LosslessPlacement {
    pub crop_rect: PdfRect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_transform: Option<ContentTransform>,
    /// The content changed scale to reach the canvas.
    #[serde(default)]
    pub content_scaled: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warning_events: Vec<CleanupWarningEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<PreviewPlacement>,
}

#[derive(Clone, Copy, Debug)]
struct Insets {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

fn quarter_turns(degrees: f64) -> i64 {
    ((degrees / 90.0).round() as i64).rem_euclid(4)
}

/// Turns margins named on the displayed sheet back into the unrotated page
/// space `split-pages` works in.
fn orient_insets(insets: Insets, degrees: f64) -> Insets {
    let Insets {
        left,
        top,
        right,
        bottom,
    } = insets;
    match quarter_turns(degrees) {
        1 => Insets {
            left: top,
            top: right,
            right: bottom,
            bottom: left,
        },
        2 => Insets {
            left: right,
            top: bottom,
            right: left,
            bottom: top,
        },
        3 => Insets {
            left: bottom,
            top: left,
            right: top,
            bottom: right,
        },
        _ => insets,
    }
}

fn grid_at_dpi(width_points: f64, height_points: f64, dpi: f64) -> (f64, f64) {
    (
        (width_points / 72.0 * dpi).round().max(1.0),
        (height_points / 72.0 * dpi).round().max(1.0),
    )
}

fn fit_scale(box_width: f64, box_height: f64, width: f64, height: f64) -> f64 {
    (box_width / width).min(box_height / height)
}

/// Reduces a margin pair that leaves no content pixel on its axis to the pair
/// that leaves one, keeping the requested ratio. The raster route applies the
/// same rule in `canvas_fit_for`.
fn fit_margin_axis(leading: f64, trailing: f64, total: f64) -> (f64, f64) {
    let sum = leading + trailing;
    if sum < total || sum == 0.0 {
        return (leading, trailing);
    }
    let available = (total - 1.0).max(0.0);
    let fitted = available.min((available * leading / sum).round());
    (fitted, available - fitted)
}

fn alignment_offset(
    available_width: f64,
    available_height: f64,
    alignment: PageAlignment,
    ink: Option<(f64, f64)>,
) -> (f64, f64) {
    use PageAlignment::*;
    if alignment == Ink {
        let y = ink.map_or(0.0, |(anchor, content_height)| {
            (anchor * (available_height + content_height))
                .max(0.0)
                .min(available_height.max(0.0))
        });
        return (available_width / 2.0, y);
    }
    let x = match alignment {
        TopLeft | CenterLeft | BottomLeft => 0.0,
        TopRight | CenterRight | BottomRight => available_width,
        _ => available_width / 2.0,
    };
    let y = match alignment {
        TopLeft | TopCenter | TopRight => 0.0,
        BottomLeft | BottomCenter | BottomRight => available_height,
        _ => available_height / 2.0,
    };
    (x, y)
}

/// Places a box of `width` x `height` around content that keeps its size.
/// Alignment names the edges of the displayed sheet, so the free space is
/// resolved on the presented rectangle and turned back into page space.
fn place_box(
    content: PdfRect,
    width: f64,
    height: f64,
    alignment: PageAlignment,
    anchor: Option<f64>,
    display_degrees: f64,
) -> PdfRect {
    let turns = quarter_turns(display_degrees);
    let swaps_axes = turns % 2 == 1;
    let available_width = if swaps_axes {
        height - content.height
    } else {
        width - content.width
    };
    let available_height = if swaps_axes {
        width - content.width
    } else {
        height - content.height
    };
    let content_height = if swaps_axes {
        content.width
    } else {
        content.height
    };
    let (x, y) = alignment_offset(
        available_width,
        available_height,
        alignment,
        anchor.map(|anchor| (anchor, content_height)),
    );
    let insets = orient_insets(
        Insets {
            left: x,
            top: y,
            right: available_width - x,
            bottom: available_height - y,
        },
        (turns * 90) as f64,
    );
    PdfRect {
        x: content.x - insets.left,
        y: content.y - insets.bottom,
        width,
        height,
    }
}

/// Where a rectangle measured on the rendered analysis raster lands in the
/// page's own PDF user space, through the cleanup rotation and the display
/// rotation the page carries.
pub(crate) fn analysis_rect_to_pdf(
    rect: Rect,
    input_width: f64,
    input_height: f64,
    cleanup_rotation: OrthogonalRotation,
    page: &PdfPageGeometry,
) -> PdfRect {
    let unrotate = |x: f64, y: f64| match cleanup_rotation {
        OrthogonalRotation::Clockwise90 => (y, input_height - x),
        OrthogonalRotation::Clockwise180 => (input_width - x, input_height - y),
        OrthogonalRotation::Clockwise270 => (input_width - y, x),
        OrthogonalRotation::None => (x, y),
    };
    let to_pdf = |(x, y): (f64, f64)| {
        let marker_x = x / input_width;
        let marker_y = y / input_height;
        let (width, height) = (page.width_points, page.height_points);
        match quarter_turns(page.rotation as f64) {
            1 => (
                page.x_points + marker_y * width,
                page.y_points + marker_x * height,
            ),
            2 => (
                page.x_points + (1.0 - marker_x) * width,
                page.y_points + marker_y * height,
            ),
            3 => (
                page.x_points + (1.0 - marker_y) * width,
                page.y_points + (1.0 - marker_x) * height,
            ),
            _ => (
                page.x_points + marker_x * width,
                page.y_points + (1.0 - marker_y) * height,
            ),
        }
    };
    let corners = [
        (rect.x, rect.y),
        (rect.x + rect.width, rect.y),
        (rect.x, rect.y + rect.height),
        (rect.x + rect.width, rect.y + rect.height),
    ]
    .map(|(x, y)| to_pdf(unrotate(x, y)));
    let left = corners
        .iter()
        .map(|point| point.0)
        .fold(f64::INFINITY, f64::min);
    let right = corners
        .iter()
        .map(|point| point.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = corners
        .iter()
        .map(|point| point.1)
        .fold(f64::INFINITY, f64::min);
    let top = corners
        .iter()
        .map(|point| point.1)
        .fold(f64::NEG_INFINITY, f64::max);
    PdfRect {
        x: left,
        y: bottom,
        width: right - left,
        height: top - bottom,
    }
}

struct FittedMargins {
    visual: Insets,
    page_left: f64,
    page_bottom: f64,
    inner_width: f64,
    inner_height: f64,
    reduced: bool,
}

/// Plans every analysis output of one page onto the document canvas, or keeps
/// each output at its own crop when there is no canvas.
pub(crate) fn plan_lossless_page(
    outputs: &mut [AnalysisOutputMetadata],
    page: &PdfPageGeometry,
    cleanup_rotation: OrthogonalRotation,
    options: &CleanupOptions,
    canvas: Option<DocumentCanvas>,
    preview: bool,
) {
    let crops = outputs
        .iter()
        .map(|output| {
            analysis_rect_to_pdf(
                output.crop_rect,
                output.input_width as f64,
                output.input_height as f64,
                cleanup_rotation,
                page,
            )
        })
        .collect::<Vec<_>>();
    let Some(canvas) = canvas else {
        for (output, crop) in outputs.iter_mut().zip(crops) {
            let width_px = output.crop_rect.width.round().max(1.0) as usize;
            let height_px = output.crop_rect.height.round().max(1.0) as usize;
            output.pdf_placement = Some(LosslessPlacement {
                crop_rect: crop,
                content_transform: None,
                content_scaled: false,
                warning_events: Vec::new(),
                preview: preview.then_some(PreviewPlacement {
                    canvas_width_px: width_px,
                    canvas_height_px: height_px,
                    content_width_px: width_px,
                    content_height_px: height_px,
                    offset_x_px: 0,
                    offset_y_px: 0,
                    margins: AppliedMargins::from([0.0; 4]),
                    canvas_overflow: false,
                }),
            });
        }
        return;
    };
    let display_degrees = page.rotation as f64 + f64::from(options.rotation.degrees());
    let turns = quarter_turns(display_degrees);
    let swaps_axes = turns % 2 == 1;
    // The canvas in the page's own unrotated user space, where split-pages
    // writes the MediaBox.
    let (box_width, box_height) = if swaps_axes {
        (canvas.height_points, canvas.width_points)
    } else {
        (canvas.width_points, canvas.height_points)
    };
    // Margins are fitted on the pixel grid this page's raster would carry,
    // which is the grid the raster route fits them on.
    let dpi = page.source_dpi;
    let (grid_width, grid_height) = grid_at_dpi(canvas.width_points, canvas.height_points, dpi);
    let (page_grid_width, page_grid_height) = grid_at_dpi(box_width, box_height, dpi);
    let grid_dpi = grid_width / canvas.width_points * 72.0;
    let points_per_pixel_x = canvas.width_points / grid_width;
    let points_per_pixel_y = canvas.height_points / grid_height;
    let margins_mm = options
        .margins_mm
        .map(crate::MarginsMm::values)
        .unwrap_or([0.0; 4]);
    let requested = margins_mm.map(|millimeters| (millimeters * grid_dpi / 25.4).round().max(0.0));
    let margins_requested = requested.iter().any(|margin| *margin > 0.0);
    let margins_available = options.crop_content;
    let fitted = {
        let [left, top, right, bottom] = if margins_available {
            requested
        } else {
            [0.0; 4]
        };
        let (left_px, right_px) = fit_margin_axis(left, right, grid_width);
        let (top_px, bottom_px) = fit_margin_axis(top, bottom, grid_height);
        let visual = Insets {
            left: left_px * points_per_pixel_x,
            top: top_px * points_per_pixel_y,
            right: right_px * points_per_pixel_x,
            bottom: bottom_px * points_per_pixel_y,
        };
        let oriented = orient_insets(visual, display_degrees);
        FittedMargins {
            visual,
            page_left: oriented.left,
            page_bottom: oriented.bottom,
            inner_width: points_per_pixel_x.max(box_width - oriented.left - oriented.right),
            inner_height: points_per_pixel_y.max(box_height - oriented.top - oriented.bottom),
            reduced: left_px != left || top_px != top || right_px != right || bottom_px != bottom,
        }
    };
    // Split halves share one frame: the oriented sheet divided by output count.
    let paper = |half: PageHalf| {
        let divisor = if half == PageHalf::Full { 1.0 } else { 2.0 };
        if swaps_axes {
            (page.width_points, page.height_points / divisor)
        } else {
            (page.width_points / divisor, page.height_points)
        }
    };
    let scales = outputs
        .iter()
        .zip(&crops)
        .map(|(output, crop)| {
            let (paper_width, paper_height) = paper(output.half);
            let paper_scale = fit_scale(box_width, box_height, paper_width, paper_height);
            let leaf_fit = fit_scale(
                fitted.inner_width,
                fitted.inner_height,
                crop.width * paper_scale,
                crop.height * paper_scale,
            )
            .min(1.0);
            (paper_scale, leaf_fit)
        })
        .collect::<Vec<_>>();
    let shared_spread_scale = (outputs.len() == 2
        && outputs.iter().any(|output| output.half == PageHalf::Left)
        && outputs.iter().any(|output| output.half == PageHalf::Right))
    .then(|| {
        scales
            .iter()
            .map(|(paper_scale, leaf_fit)| paper_scale * leaf_fit)
            .fold(f64::INFINITY, f64::min)
    });
    let preview_grid = preview.then(|| canvas.at_dpi(canvas.dpi().floor().max(1.0)));
    for ((output, crop), (paper_scale, leaf_fit)) in outputs.iter_mut().zip(crops).zip(scales) {
        let (paper_width, paper_height) = paper(output.half);
        let mut warning_events = Vec::new();
        if margins_requested && !margins_available {
            warning_events.push(CleanupWarningEvent::MatchedCanvasMarginsUnavailable);
        }
        if fitted.reduced {
            warning_events.push(CleanupWarningEvent::MatchedCanvasMarginsReduced);
        }
        let scale = shared_spread_scale.unwrap_or(paper_scale * leaf_fit);
        let fit = scale / paper_scale;
        if paper_width / box_width * page_grid_width > page_grid_width + GRID_TOLERANCE_PX
            || paper_height / box_height * page_grid_height > page_grid_height + GRID_TOLERANCE_PX
        {
            warning_events.push(CleanupWarningEvent::MatchedCanvasPaperDownscaled {
                unit: WarningExtentUnit::Pt,
                scale_percent_tenths: quantize_decimal_half_up(paper_scale * 100.0, 1),
                document_canvas_width: box_width,
                document_canvas_height: box_height,
                paper_width: Some(paper_width),
                paper_height: Some(paper_height),
            });
        }
        let canvas_overflow = fit < 1.0 - CONTENT_SCALE_EPSILON;
        if canvas_overflow {
            warning_events.push(CleanupWarningEvent::MatchedCanvasContentFitted {
                unit: WarningExtentUnit::Pt,
                content_width: crop.width * scale,
                content_height: crop.height * scale,
                inner_width: fitted.inner_width,
                inner_height: fitted.inner_height,
                document_canvas_width: None,
                document_canvas_height: None,
            });
        }
        let alignment = options.placement_for(output.half);
        let anchor = options
            .placement_anchor_for(output.half)
            .map(|anchor| anchor.y_normalized);
        let content_scaled = (scale - 1.0).abs() > CONTENT_SCALE_EPSILON;
        let (crop_rect, content_transform, placed_content) = if content_scaled {
            let placed = place_box(
                PdfRect {
                    x: crop.x * scale,
                    y: crop.y * scale,
                    width: crop.width * scale,
                    height: crop.height * scale,
                },
                fitted.inner_width,
                fitted.inner_height,
                alignment,
                anchor,
                display_degrees,
            );
            let transform = ContentTransform {
                scale,
                translate_x: -(placed.x - fitted.page_left),
                translate_y: -(placed.y - fitted.page_bottom),
            };
            let placed_content = PdfRect {
                x: crop.x * scale + transform.translate_x,
                y: crop.y * scale + transform.translate_y,
                width: crop.width * scale,
                height: crop.height * scale,
            };
            let crop_rect = PdfRect {
                x: 0.0,
                y: 0.0,
                width: box_width,
                height: box_height,
            };
            (crop_rect, Some(transform), placed_content)
        } else {
            let inner = place_box(
                crop,
                fitted.inner_width,
                fitted.inner_height,
                alignment,
                anchor,
                display_degrees,
            );
            let crop_rect = PdfRect {
                x: inner.x - fitted.page_left,
                y: inner.y - fitted.page_bottom,
                width: box_width,
                height: box_height,
            };
            let placed_content = PdfRect {
                x: crop.x - crop_rect.x,
                y: crop.y - crop_rect.y,
                width: crop.width,
                height: crop.height,
            };
            (crop_rect, None, placed_content)
        };
        let preview = preview_grid.map(|grid| {
            let display = page_rect_to_display(placed_content, box_width, box_height, turns);
            let scale_x = grid.width_px as f64 / canvas.width_points;
            let scale_y = grid.height_px as f64 / canvas.height_points;
            let content_width_px =
                ((display.width * scale_x).round() as usize).clamp(1, grid.width_px);
            let content_height_px =
                ((display.height * scale_y).round() as usize).clamp(1, grid.height_px);
            PreviewPlacement {
                canvas_width_px: grid.width_px,
                canvas_height_px: grid.height_px,
                content_width_px,
                content_height_px,
                offset_x_px: ((display.x * scale_x).round().max(0.0) as usize)
                    .min(grid.width_px - content_width_px),
                offset_y_px: ((display.y * scale_y).round().max(0.0) as usize)
                    .min(grid.height_px - content_height_px),
                margins: AppliedMargins::from([
                    (fitted.visual.left * scale_x).round(),
                    (fitted.visual.top * scale_y).round(),
                    (fitted.visual.right * scale_x).round(),
                    (fitted.visual.bottom * scale_y).round(),
                ]),
                canvas_overflow,
            }
        });
        output.pdf_placement = Some(LosslessPlacement {
            crop_rect,
            content_transform,
            content_scaled,
            warning_events,
            preview,
        });
    }
}

/// A rectangle on the output page's unrotated user space (origin bottom-left)
/// seen on the displayed sheet (origin top-left) under `turns` clockwise
/// quarter turns.
fn page_rect_to_display(rect: PdfRect, box_width: f64, box_height: f64, turns: i64) -> PdfRect {
    match turns {
        1 => PdfRect {
            x: rect.y,
            y: rect.x,
            width: rect.height,
            height: rect.width,
        },
        2 => PdfRect {
            x: box_width - (rect.x + rect.width),
            y: rect.y,
            width: rect.width,
            height: rect.height,
        },
        3 => PdfRect {
            x: box_height - (rect.y + rect.height),
            y: box_width - (rect.x + rect.width),
            width: rect.height,
            height: rect.width,
        },
        _ => PdfRect {
            x: rect.x,
            y: box_height - (rect.y + rect.height),
            width: rect.width,
            height: rect.height,
        },
    }
}

/// Records, on a whole-page raster output's final metadata, where its source
/// crop lands when the compact source page is kept instead of the cleaned
/// raster: the crop scaled to fill the output page and aligned inside it.
pub(crate) fn record_source_preservation(
    metadata_path: &Path,
    page: &PdfPageGeometry,
    options: &CleanupOptions,
) -> Result<(), Box<dyn Error>> {
    let mut metadata: CleanupMetadata = serde_json::from_slice(&fs::read(metadata_path)?)?;
    if metadata.half != PageHalf::Full {
        return Ok(());
    }
    let crop = analysis_rect_to_pdf(
        metadata.crop_rect,
        metadata.input_width as f64,
        metadata.input_height as f64,
        metadata.rotation,
        page,
    );
    let target_width = metadata
        .matched_canvas_target_width_points
        .unwrap_or(metadata.canvas_width as f64 / metadata.render_dpi * 72.0);
    let target_height = metadata
        .matched_canvas_target_height_points
        .unwrap_or(metadata.canvas_height as f64 / metadata.render_dpi * 72.0);
    metadata.source_pdf_placement =
        plan_source_preservation(crop, target_width, target_height, options);
    write_json_atomic(metadata_path, &metadata)
}

fn plan_source_preservation(
    crop: PdfRect,
    target_width: f64,
    target_height: f64,
    options: &CleanupOptions,
) -> Option<LosslessPlacement> {
    let scale = (target_width / crop.width).min(target_height / crop.height);
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let placed = place_box(
        PdfRect {
            x: crop.x * scale,
            y: crop.y * scale,
            width: crop.width * scale,
            height: crop.height * scale,
        },
        target_width,
        target_height,
        options.placement_for(PageHalf::Full),
        options
            .placement_anchor_for(PageHalf::Full)
            .map(|anchor| anchor.y_normalized),
        0.0,
    );
    Some(LosslessPlacement {
        crop_rect: PdfRect {
            x: 0.0,
            y: 0.0,
            width: target_width,
            height: target_height,
        },
        content_transform: Some(ContentTransform {
            scale,
            translate_x: -placed.x,
            translate_y: -placed.y,
        }),
        content_scaled: true,
        warning_events: Vec::new(),
        preview: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(width: f64, height: f64, rotation: i64) -> PdfPageGeometry {
        PdfPageGeometry {
            x_points: 0.0,
            y_points: 0.0,
            width_points: width,
            height_points: height,
            rotation,
            source_dpi: 300.0,
        }
    }

    fn output(half: PageHalf, crop: Rect, input: (usize, usize)) -> AnalysisOutputMetadata {
        AnalysisOutputMetadata {
            half,
            source_region: crop,
            content_box: Some(crop),
            content_diagnostics: None,
            text_tone_diagnostics: None,
            crop_rect: crop,
            applied_margins: AppliedMargins::from([0.0; 4]),
            input_width: input.0,
            input_height: input.1,
            pdf_placement: None,
        }
    }

    fn options(margins: [f64; 4], alignment: PageAlignment) -> CleanupOptions {
        CleanupOptions {
            page_alignment: alignment,
            margins_mm: Some(crate::MarginsMm {
                left_mm: margins[0],
                top_mm: margins[1],
                right_mm: margins[2],
                bottom_mm: margins[3],
            }),
            ..CleanupOptions::default()
        }
    }

    fn letter() -> DocumentCanvas {
        DocumentCanvas {
            width_points: 612.0,
            height_points: 792.0,
            width_px: 2550,
            height_px: 3300,
        }
    }

    #[test]
    fn maps_an_analysis_rect_through_the_display_rotation() {
        let rect = Rect::new(10.0, 20.0, 30.0, 40.0);
        let upright = analysis_rect_to_pdf(
            rect,
            100.0,
            200.0,
            OrthogonalRotation::None,
            &page(612.0, 792.0, 0),
        );
        assert!((upright.x - 61.2).abs() < 1e-9 && (upright.y - 554.4).abs() < 1e-9);
        assert!((upright.width - 183.6).abs() < 1e-9 && (upright.height - 158.4).abs() < 1e-9);
        let turned = analysis_rect_to_pdf(
            rect,
            100.0,
            200.0,
            OrthogonalRotation::None,
            &page(612.0, 792.0, 90),
        );
        assert!((turned.x - 61.2).abs() < 1e-9 && (turned.y - 79.2).abs() < 1e-9);
        assert!((turned.width - 122.4).abs() < 1e-9 && (turned.height - 237.6).abs() < 1e-9);
    }

    #[test]
    fn maps_a_cleanup_rotated_spread_onto_page_halves() {
        let page = page(200.0, 100.0, 0);
        let left = analysis_rect_to_pdf(
            Rect::new(0.0, 0.0, 250.0, 1000.0),
            1000.0,
            500.0,
            OrthogonalRotation::Clockwise90,
            &page,
        );
        let right = analysis_rect_to_pdf(
            Rect::new(250.0, 0.0, 250.0, 1000.0),
            1000.0,
            500.0,
            OrthogonalRotation::Clockwise90,
            &page,
        );
        assert_eq!(
            (left.x, left.y, left.width, left.height),
            (0.0, 0.0, 200.0, 50.0)
        );
        assert_eq!(
            (right.x, right.y, right.width, right.height),
            (0.0, 50.0, 200.0, 50.0)
        );
    }

    #[test]
    fn keeps_same_scale_paper_unscaled_and_aligns_it_top_center() {
        let mut outputs = [output(
            PageHalf::Full,
            Rect::new(50.0, 50.0, 400.0, 500.0),
            (500, 600),
        )];
        plan_lossless_page(
            &mut outputs,
            &page(612.0, 792.0, 0),
            OrthogonalRotation::None,
            &options([5.0; 4], PageAlignment::TopCenter),
            Some(letter()),
            true,
        );
        let placement = outputs[0].pdf_placement.clone().unwrap();
        assert_eq!(placement.content_transform, None);
        assert!(!placement.content_scaled);
        assert!(placement.warning_events.is_empty());
        assert_eq!(placement.crop_rect.width, 612.0);
        assert_eq!(placement.crop_rect.height, 792.0);
        let preview = placement.preview.unwrap();
        assert_eq!(
            (preview.canvas_width_px, preview.canvas_height_px),
            (2550, 3300)
        );
        // Top margin 5 mm at 300 DPI, centred horizontally.
        assert_eq!(preview.offset_y_px, 59);
        let free = preview.canvas_width_px - preview.content_width_px;
        assert!(preview.offset_x_px.abs_diff(free / 2) <= 1);
    }

    #[test]
    fn scales_a_smaller_sheet_up_to_the_canvas() {
        let mut outputs = [output(
            PageHalf::Full,
            Rect::new(0.0, 0.0, 250.0, 330.0),
            (250, 330),
        )];
        plan_lossless_page(
            &mut outputs,
            &page(306.0, 396.0, 0),
            OrthogonalRotation::None,
            &options([0.0; 4], PageAlignment::Center),
            Some(letter()),
            false,
        );
        let placement = outputs[0].pdf_placement.clone().unwrap();
        let transform = placement.content_transform.unwrap();
        assert!(placement.content_scaled);
        assert!((transform.scale - 2.0).abs() < 1e-12);
        assert!(placement.preview.is_none());
    }

    #[test]
    fn reduces_a_margin_pair_that_leaves_no_content() {
        let mut outputs = [output(
            PageHalf::Full,
            Rect::new(0.0, 0.0, 250.0, 333.0),
            (250, 333),
        )];
        plan_lossless_page(
            &mut outputs,
            &page(60.0, 80.0, 0),
            OrthogonalRotation::None,
            &options([25.0, 1.0, 1.0, 25.0], PageAlignment::TopCenter),
            Some(DocumentCanvas {
                width_points: 60.0,
                height_points: 80.0,
                width_px: 250,
                height_px: 333,
            }),
            false,
        );
        let events = outputs[0].pdf_placement.clone().unwrap().warning_events;
        assert!(events.contains(&CleanupWarningEvent::MatchedCanvasMarginsReduced));
    }

    #[test]
    fn fits_a_margin_axis_keeping_its_ratio() {
        assert_eq!(fit_margin_axis(10.0, 20.0, 100.0), (10.0, 20.0));
        assert_eq!(fit_margin_axis(60.0, 60.0, 100.0), (50.0, 49.0));
        assert_eq!(fit_margin_axis(0.0, 0.0, 1.0), (0.0, 0.0));
    }

    #[test]
    fn places_ink_at_its_anchor_within_the_free_space() {
        let ink =
            |anchor| alignment_offset(100.0, 200.0, PageAlignment::Ink, Some((anchor, 100.0)));
        assert_eq!(ink(0.25), (50.0, 75.0));
        assert_eq!(ink(1.0), (50.0, 200.0));
        assert_eq!(ink(0.0), (50.0, 0.0));
        assert_eq!(
            alignment_offset(100.0, 200.0, PageAlignment::Ink, None),
            alignment_offset(100.0, 200.0, PageAlignment::TopCenter, None)
        );
    }

    #[test]
    fn places_a_quarter_turned_page_against_the_named_visual_edge() {
        let content = PdfRect {
            x: 100.0,
            y: 100.0,
            width: 200.0,
            height: 300.0,
        };
        let upright = place_box(content, 400.0, 500.0, PageAlignment::TopLeft, None, 0.0);
        assert_eq!((upright.x, upright.y), (100.0, -100.0));
        // Turned a quarter clockwise, the displayed top edge is the page's left.
        let turned = place_box(content, 400.0, 500.0, PageAlignment::TopLeft, None, 90.0);
        assert_eq!((turned.x, turned.y), (100.0, 100.0));
    }
}
