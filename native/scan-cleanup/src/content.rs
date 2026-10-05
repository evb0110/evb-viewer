use crate::{
    analysis::build_analysis_level,
    bw::{despeckle_connected_calibrated, rescue_component_scoped_faint_strokes},
    calibration::{CalibrationConfig, PageCalibration},
    protocol::manifest_v3::{
        ContentAcceptedTrim, ContentBlockEvidence, ContentDiagnosticRect, ContentDiagnostics,
        ContentSideConfidence, ContentTextMaskSummary, ContentTrimSide,
    },
    BinarizationMode,
};
use scan_primitives::{
    distance::{find_peaks, squared_euclidean_distance, InfluenceMap},
    morphology::{dilate, open, reconstruct_binary},
    threshold::{threshold_local, LocalThreshold},
    BinaryImage, Component, ComponentMap, GrayImage, Rect,
};

#[derive(Clone, Debug)]
pub struct ContentResult {
    pub content: Option<Rect>,
    pub output_rect: Rect,
    pub margins: [f64; 4],
    pub diagnostics: Option<ContentDiagnostics>,
}

pub(crate) struct ContentAnalysisEvidence {
    pub diagnostics: ContentDiagnostics,
    pub text_mask: BinaryImage,
    pub text_vicinity_mask: BinaryImage,
}

#[derive(Clone, Copy)]
enum ContentAnalysisPurpose<'a> {
    Semantic,
    Crop {
        manual_picture_authority: Option<&'a BinaryImage>,
    },
}

pub fn detect_content_and_margins(
    source: &GrayImage,
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
) -> ContentResult {
    detect_content_and_margins_with_calibration_config(
        source,
        dpi,
        margins_mm,
        margins_pixels,
        CalibrationConfig::default(),
    )
}

#[doc(hidden)]
pub fn detect_content_and_margins_with_calibration_config(
    source: &GrayImage,
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
    calibration_config: CalibrationConfig,
) -> ContentResult {
    let level = build_analysis_level(source, dpi, 150.0);
    let calibration =
        PageCalibration::estimate(&level.image, level.effective_dpi, calibration_config);
    let (detected, diagnostics, _, _) = detect_content_at_analysis_scale(
        &level.image,
        None,
        ContentAnalysisPurpose::Crop {
            manual_picture_authority: None,
        },
        calibration,
    );
    let content = detected.map(|content| {
        Rect::new(
            content.x / level.scale_x,
            content.y / level.scale_y,
            content.width / level.scale_x,
            content.height / level.scale_y,
        )
    });
    let mut result = content_with_margins(source, dpi, content, margins_mm, margins_pixels);
    result.diagnostics = Some(diagnostics);
    result
}

#[cfg(test)]
pub(crate) fn detect_content_and_margins_calibrated(
    source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
    calibration: PageCalibration,
) -> ContentResult {
    detect_content_and_margins_calibrated_with_crop_authority(
        source,
        picture_mask,
        None,
        dpi,
        margins_mm,
        margins_pixels,
        calibration,
    )
}

pub(crate) fn detect_content_and_margins_calibrated_with_crop_authority(
    source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    crop_authoritative_picture_mask: Option<&BinaryImage>,
    dpi: f64,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
    calibration: PageCalibration,
) -> ContentResult {
    let (content, diagnostics, _, _) = detect_content_at_analysis_scale(
        source,
        picture_mask,
        ContentAnalysisPurpose::Crop {
            manual_picture_authority: crop_authoritative_picture_mask,
        },
        calibration,
    );
    let mut result = content_with_margins(source, dpi, content, margins_mm, margins_pixels);
    result.diagnostics = Some(diagnostics);
    result
}

pub(crate) fn analyze_content_evidence_calibrated(
    source: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    calibration: PageCalibration,
) -> ContentAnalysisEvidence {
    let (_, diagnostics, text_mask, text_vicinity_mask) = detect_content_at_analysis_scale(
        source,
        picture_mask,
        ContentAnalysisPurpose::Semantic,
        calibration,
    );
    ContentAnalysisEvidence {
        diagnostics,
        text_mask,
        text_vicinity_mask,
    }
}

fn detect_content_at_analysis_scale(
    working: &GrayImage,
    picture_mask: Option<&BinaryImage>,
    purpose: ContentAnalysisPurpose<'_>,
    calibration: PageCalibration,
) -> (Option<Rect>, ContentDiagnostics, BinaryImage, BinaryImage) {
    if let Some(mask) = picture_mask {
        assert_eq!(
            (working.width(), working.height()),
            (mask.width(), mask.height())
        );
    }
    let manual_picture_authority = match purpose {
        ContentAnalysisPurpose::Semantic => None,
        ContentAnalysisPurpose::Crop {
            manual_picture_authority,
        } => manual_picture_authority,
    };
    if let Some(mask) = manual_picture_authority {
        assert_eq!(
            (working.width(), working.height()),
            (mask.width(), mask.height())
        );
    }
    let binary = threshold_local(
        working,
        25,
        LocalThreshold::Wolf {
            k: 0.5,
            deviation_floor: 3.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        },
    );
    let borders = border_artifact_mask_from_binary(working, &binary);
    // Picture ownership is semantic/render state, but content bounds need a
    // stricter authority. Qualify it after the spread has been split into
    // local pages: a central gutter is not an outer-sheet rail, while each
    // remnant it leaves at the inner edge of a half is. Removing rejected rail
    // pixels before component and text-line construction is essential; if we
    // only ignore their final picture bounds, the same ink can first become a
    // picture-supported, text-protected block that trimming is forbidden to
    // cross. Semantic analysis deliberately keeps the original mask.
    let early_picture_qualification = match purpose {
        ContentAnalysisPurpose::Semantic => None,
        ContentAnalysisPurpose::Crop {
            manual_picture_authority,
        } => picture_mask.map(|mask| {
            let mut qualification = qualify_picture_mask_for_crop_with_authority(
                mask,
                manual_picture_authority,
                0,
                calibration,
            );
            // A vetted owner can contain a detached text-shaped island inside
            // a rejected frame rail. Keep that island out of picture bounds,
            // but do not let the rail veto erase its underlying glyph ink
            // before content blocks can recognize it.
            let faint_stroke_binary = rescue_component_scoped_faint_strokes(
                &binary,
                working,
                Some(&qualification.included),
                None,
                Some(&qualification.excluded),
                BinarizationMode::Wolf,
                BinarizationMode::Wolf,
                calibration.content_despeckle_dpi(),
                false,
            );
            let structured_text = restore_structured_text_from_rejected_picture_rail(
                &faint_stroke_binary.subtract(&qualification.included),
                &qualification.excluded,
                calibration,
            );
            qualification.structured_text = structured_text;
            qualification.structured_text_edge_sides = structured_text_edge_sides(
                &qualification.excluded,
                &qualification.structured_text,
                calibration,
            );
            qualification
        }),
    };
    let analysis_picture_mask = early_picture_qualification
        .as_ref()
        .map(|qualification| &qualification.included)
        .or(picture_mask);
    let crop_artifacts = early_picture_qualification
        .as_ref()
        .map(|qualification| borders.or(&qualification.excluded));
    let mut artifact_free_binary = binary.subtract(crop_artifacts.as_ref().unwrap_or(&borders));
    if let Some(qualification) = early_picture_qualification.as_ref() {
        artifact_free_binary = artifact_free_binary.or(&qualification.structured_text);
    }
    let despeckled = despeckle_connected_calibrated(
        &artifact_free_binary,
        calibration.content_despeckle_dpi(),
        calibration,
    );
    let cleaned = match purpose {
        ContentAnalysisPurpose::Semantic => despeckled,
        ContentAnalysisPurpose::Crop { .. } => {
            let rescued = rescue_component_scoped_faint_strokes(
                &despeckled,
                working,
                picture_mask,
                None,
                Some(crop_artifacts.as_ref().unwrap_or(&borders)),
                BinarizationMode::Wolf,
                BinarizationMode::Wolf,
                calibration.content_despeckle_dpi(),
                false,
            );
            // Rescue restores small print that despeckling dropped, but it also
            // proposes marks the binarizer never selected at all — a faint smudge
            // is enough local contrast to qualify. Ink with no thresholded origin
            // may only set a crop extent if it survives despeckling on its own,
            // so a speck cannot, while a restored glyph or stroke can. Ink the
            // binarizer did select keeps rescue's verdict either way.
            despeckle_connected_calibrated(
                &rescued,
                calibration.content_despeckle_dpi(),
                calibration,
            )
            .or(&rescued.and(&artifact_free_binary))
        }
    };
    let cleaned = if let Some(qualification) = early_picture_qualification.as_ref() {
        cleaned.or(&qualification.structured_text)
    } else {
        cleaned
    };
    let map = ComponentMap::from_binary(&cleaned);
    let distance_to_white = squared_euclidean_distance(&cleaned.invert());
    let mut candidates = Vec::new();
    let (neighborhood_x, neighborhood_y) = calibration.content_neighborhood();
    let dirt_radius_squared = calibration.content_dirt_radius_squared();
    let centers = ComponentCenterGrid::build(map.components(), neighborhood_x, neighborhood_y);
    for (index, component) in map.components().iter().enumerate() {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let solid_rule =
            (width > height * 25 && height <= 3) || (height > width * 25 && width <= 3);
        let nearby_components = centers.neighbor_count(map.components(), index);
        let mut maximum_inscribed_radius_squared = 0u32;
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if map.label_at(x, y) == component.label {
                    maximum_inscribed_radius_squared = maximum_inscribed_radius_squared
                        .max(distance_to_white[y * working.width() + x]);
                }
            }
        }
        let isolated_thick_dirt = nearby_components == 0
            && maximum_inscribed_radius_squared > dirt_radius_squared
            && component.area < working.width().saturating_mul(working.height()) / 20;
        let border_shadow = is_scanner_border_shadow(component, working.width(), working.height());
        let picture_mask_overlap_pixels =
            component_mask_overlap(&map, component, analysis_picture_mask);
        let grayscale_supported =
            (solid_rule || isolated_thick_dirt) && grayscale_structure_evidence(working, component);
        let picture_supported = picture_mask_overlap_pixels != 0;
        if (border_shadow || ((solid_rule || isolated_thick_dirt) && !grayscale_supported))
            && !picture_supported
        {
            continue;
        }
        candidates.push(ContentCandidate {
            component,
            grayscale_supported,
            picture_mask_overlap_pixels,
        });
    }
    let clustered = cluster_content_blocks(
        &map,
        &candidates,
        analysis_picture_mask,
        &distance_to_white,
        calibration,
    );
    let retained = clustered.retained;
    let candidate_image = map.retain(|component| retained[component.label as usize]);
    let (mut blocks, component_blocks) = retained_content_blocks(
        &map,
        &candidates,
        &retained,
        analysis_picture_mask,
        calibration,
    );
    annotate_heading_evidence(&map, &mut blocks, calibration);
    let text = build_text_line_mask(&candidate_image, &blocks, &distance_to_white, calibration);
    annotate_text_evidence(
        &map,
        &component_blocks,
        &mut blocks,
        &text.mask,
        calibration,
    );
    let protected_mask = build_protected_mask(
        working.width(),
        working.height(),
        analysis_picture_mask,
        &blocks,
        calibration,
    );
    let garbage = garbage_seed_labels(&borders, &cleaned, &protected_mask, calibration);
    let (mut bounds, side_confidence, accepted_trims) = trim_content_bounds(
        &candidate_image,
        &map,
        &blocks,
        &component_blocks,
        &text.mask,
        &protected_mask,
        garbage,
        calibration,
    );
    // A side accepted by the trim loop owns its outer bound. Later evidence
    // may still expand untrimmed sides, but it cannot silently reverse an
    // accepted decision on the same side.
    let trim_authority = AcceptedTrimAuthority::new(bounds, &accepted_trims);
    if matches!(purpose, ContentAnalysisPurpose::Crop { .. }) {
        if let Some(qualification) = early_picture_qualification.as_ref() {
            expand_bounds_for_structured_edge_text(
                &mut bounds,
                qualification.structured_text_edge_sides,
                working.width(),
                working.height(),
                trim_authority,
            );
        }
    }
    if matches!(purpose, ContentAnalysisPurpose::Crop { .. }) {
        let retained_ink_pixels = blocks
            .iter()
            .filter(|block| block.initialized)
            .map(|block| block.ink_area)
            .sum();
        let ordinary_evidence = crop_evidence_supports_bounds(
            text.summary.ink_pixels,
            retained_ink_pixels,
            analysis_picture_mask,
            working.width(),
            working.height(),
        );
        let sparse_text_evidence = sparse_text_evidence_supports_bounds(
            text.summary.ink_pixels,
            &map,
            &blocks,
            working.width(),
            working.height(),
            calibration,
        );
        if !ordinary_evidence && !sparse_text_evidence {
            bounds = None;
        }
    }
    if let Some(picture_bounds) = picture_mask.and_then(|mask| {
        crop_qualified_picture_bounds_with_authority(
            mask,
            manual_picture_authority,
            clustered.crop_artifact_sides,
            calibration,
        )
    }) {
        bounds = union_picture_bounds(bounds, picture_bounds, trim_authority);
    }
    if matches!(purpose, ContentAnalysisPurpose::Crop { .. })
        && bounds.is_some_and(|bounds| is_edge_sliver(bounds, working.width(), working.height()))
    {
        bounds = None;
    }
    let protected_blocks = blocks
        .iter()
        .filter(|block| block.initialized && block.protected(calibration))
        .map(block_evidence)
        .collect();
    let diagnostics = ContentDiagnostics {
        side_confidence: ContentSideConfidence {
            left: side_confidence[0],
            top: side_confidence[1],
            right: side_confidence[2],
            bottom: side_confidence[3],
        },
        text_mask: text.summary,
        shipped_bounds: bounds.map(diagnostic_rect),
        accepted_trims,
        protected_blocks,
    };
    (
        bounds.map(|bounds| {
            Rect::new(
                bounds.left as f64,
                bounds.top as f64,
                bounds.width() as f64,
                bounds.height() as f64,
            )
        }),
        diagnostics,
        text.mask,
        text.vicinity_mask,
    )
}

/// Rasterizing a page whose size is not a whole number of pixels leaves a
/// pixel of paper along its edges, so an object that close still touches one.
const RASTER_EDGE_SLIVER_PX: usize = 2;

fn touches_raster_edge(component: &Component, width: usize, height: usize) -> bool {
    component.left <= RASTER_EDGE_SLIVER_PX
        || component.top <= RASTER_EDGE_SLIVER_PX
        || component.right + 1 + RASTER_EDGE_SLIVER_PX >= width
        || component.bottom + 1 + RASTER_EDGE_SLIVER_PX >= height
}

/// A scanner bed, border rail or edge shadow is one large component attached
/// to the raster edge. It is never page content or line art.
pub(crate) fn is_scanner_border_shadow(component: &Component, width: usize, height: usize) -> bool {
    touches_raster_edge(component, width, height) && component.area > width.max(height) / 3
}

/// A leaf with no page content on it still carries a fold shadow, a scanner
/// rail and dust, and that is enough to assemble a content box out of nothing:
/// the crop then follows the shadow and publishes the page as a sliver. A box
/// may drive a crop only once the leaf shows page evidence. Below both floors
/// the box is withdrawn, which costs a crop and never a pixel: the full leaf
/// is emitted instead.
///
/// Glyph ink is the strong signal — a page of prose covers well over a percent
/// of the leaf, a blank verso's shadow specks a fraction of a per mille — so
/// its floor sits an order of magnitude below the sparsest real text page.
const CROP_TEXT_EVIDENCE_MINIMUM_FRACTION: f64 = 0.0005;
/// Rules, diagrams and other line art never reach the text mask, so retained
/// block ink answers for them. It also counts the shadow fragments the text
/// mask ignores, so its floor has to sit above what a blank leaf accumulates
/// (0.47 per mille on the calibration book's page 3 verso) and below the
/// sparsest ruled page (28 per mille across the pinned fixtures).
const CROP_RETAINED_INK_MINIMUM_FRACTION: f64 = 0.002;

fn crop_evidence_supports_bounds(
    text_ink_pixels: usize,
    retained_ink_pixels: usize,
    picture_mask: Option<&BinaryImage>,
    width: usize,
    height: usize,
) -> bool {
    let picture_area = picture_mask.map_or(0, |mask| mask.count_black());
    let area = width.saturating_mul(height) as f64;
    let text_evidence = text_ink_pixels.saturating_add(picture_area) as f64
        >= area * CROP_TEXT_EVIDENCE_MINIMUM_FRACTION;
    let ink_evidence = retained_ink_pixels as f64 >= area * CROP_RETAINED_INK_MINIMUM_FRACTION;
    text_evidence || ink_evidence
}

/// A folio or short running mark can be genuine page content while remaining
/// below every page-wide ink-density floor. Admit that case only when all of
/// the retained evidence is one compact, internally recognized text block.
/// Requiring multiple glyph components and a majority of the block's ink in
/// the text mask keeps isolated dust and blank-leaf fold fragments on the
/// conservative no-crop path.
fn sparse_text_evidence_supports_bounds(
    text_ink_pixels: usize,
    map: &ComponentMap,
    blocks: &[BlockStats],
    width: usize,
    height: usize,
    calibration: PageCalibration,
) -> bool {
    let mut retained = blocks.iter().filter(|block| block.initialized);
    let Some(block) = retained.next() else {
        return false;
    };
    let nominal_height = heading_nominal_glyph_height(calibration);
    let glyph_like_components = map
        .components()
        .iter()
        .filter(|component| block.labels.contains(&component.label))
        .filter(|component| heading_glyph_like(component, nominal_height))
        .count();
    retained.next().is_none()
        && (block.text_evidence || block.heading_evidence)
        && (2..=16).contains(&block.component_count)
        && glyph_like_components == block.component_count
        && block.ink_area > block.component_count.saturating_mul(16)
        && text_ink_pixels.saturating_mul(2) >= block.ink_area
        && block.width().saturating_mul(3) <= width
        && block.height().saturating_mul(3) <= height
}

/// A page never prints a column narrower than a margin, so a box that thin
/// against a leaf edge is the fold shadow or the scanner rail wearing the
/// crop's authority. Withdrawing it costs the crop, never a pixel.
const CROP_SLIVER_MAXIMUM_FRACTION: f64 = 0.05;

fn is_edge_sliver(bounds: PixelBounds, width: usize, height: usize) -> bool {
    let horizontal_margin = (width as f64 * CROP_SLIVER_MAXIMUM_FRACTION) as usize;
    let vertical_margin = (height as f64 * CROP_SLIVER_MAXIMUM_FRACTION) as usize;
    let narrow = bounds.width() <= horizontal_margin
        && (bounds.left <= horizontal_margin || bounds.right + horizontal_margin >= width);
    let short = bounds.height() <= vertical_margin
        && (bounds.top <= vertical_margin || bounds.bottom + vertical_margin >= height);
    narrow || short
}

fn component_center(component: &Component) -> (usize, usize) {
    (
        (component.left + component.right) / 2,
        (component.top + component.bottom) / 2,
    )
}

/// Uniform grid over component centres, bucketed at exactly the neighbourhood
/// extent. The neighbour test is a box test of half-extent `(neighborhood_x,
/// neighborhood_y)`, so with that cell size every match lies in the 3x3 cell
/// block around the query cell: the counts are exact, not approximate, and the
/// scan stops being quadratic in the component count.
struct ComponentCenterGrid {
    neighborhood_x: usize,
    neighborhood_y: usize,
    columns: usize,
    rows: usize,
    cell_starts: Vec<u32>,
    entries: Vec<u32>,
}

impl ComponentCenterGrid {
    fn build(components: &[Component], neighborhood_x: usize, neighborhood_y: usize) -> Self {
        let cell_width = neighborhood_x.max(1);
        let cell_height = neighborhood_y.max(1);
        let mut columns = 1;
        let mut rows = 1;
        let mut placements = Vec::with_capacity(components.len());
        for component in components {
            let (center_x, center_y) = component_center(component);
            let column = center_x / cell_width;
            let row = center_y / cell_height;
            columns = columns.max(column + 1);
            rows = rows.max(row + 1);
            placements.push((column, row));
        }
        let mut cell_starts = vec![0u32; columns * rows + 1];
        for &(column, row) in &placements {
            cell_starts[row * columns + column + 1] += 1;
        }
        for cell in 1..cell_starts.len() {
            cell_starts[cell] += cell_starts[cell - 1];
        }
        let mut cursors = cell_starts.clone();
        let mut entries = vec![0u32; components.len()];
        for (index, &(column, row)) in placements.iter().enumerate() {
            let cell = row * columns + column;
            entries[cursors[cell] as usize] = index as u32;
            cursors[cell] += 1;
        }
        Self {
            neighborhood_x,
            neighborhood_y,
            columns,
            rows,
            cell_starts,
            entries,
        }
    }

    fn neighbor_count(&self, components: &[Component], index: usize) -> usize {
        let component = &components[index];
        let (center_x, center_y) = component_center(component);
        let column = center_x / self.neighborhood_x.max(1);
        let row = center_y / self.neighborhood_y.max(1);
        let mut nearby = 0;
        for cell_row in row.saturating_sub(1)..=(row + 1).min(self.rows - 1) {
            for cell_column in column.saturating_sub(1)..=(column + 1).min(self.columns - 1) {
                let cell = cell_row * self.columns + cell_column;
                let occupants = &self.entries
                    [self.cell_starts[cell] as usize..self.cell_starts[cell + 1] as usize];
                for &entry in occupants {
                    let other = &components[entry as usize];
                    if other.label == component.label {
                        continue;
                    }
                    let (other_x, other_y) = component_center(other);
                    if center_x.abs_diff(other_x) <= self.neighborhood_x
                        && center_y.abs_diff(other_y) <= self.neighborhood_y
                    {
                        nearby += 1;
                    }
                }
            }
        }
        nearby
    }
}

/// Reconstructs the long, edge-attached objects used by content detection as
/// scanner-border evidence. The opening seeds require sustained horizontal or
/// vertical structure before reconstruction, so ordinary edge-touching content
/// is not enough to qualify.
pub(crate) fn border_artifact_mask(working: &GrayImage) -> BinaryImage {
    let binary = threshold_local(
        working,
        25,
        LocalThreshold::Wolf {
            k: 0.5,
            deviation_floor: 3.0,
            minimum_percentile: 0.01,
            hard_ink: 48,
            hard_paper: 248,
        },
    );
    border_artifact_mask_from_binary(working, &binary)
}

fn border_artifact_mask_from_binary(working: &GrayImage, binary: &BinaryImage) -> BinaryImage {
    let horizontal_seed = open(binary, 40, 2);
    let vertical_seed = open(binary, 2, 40);
    let border_candidates = reconstruct_binary(&horizontal_seed, binary)
        .or(&reconstruct_binary(&vertical_seed, binary));
    let retained = ComponentMap::from_binary(&border_candidates).retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        touches_raster_edge(component, working.width(), working.height())
            && (width * 2 >= working.width() || height * 2 >= working.height())
    });
    // A scanner border is usually a thin band hugging the page edge. Threshold
    // bloom on a normalized raster can bridge such a band to the nearest
    // authored structure (observed: a top bar swallowing the running head and
    // its rule through geodesic reconstruction), so the artifact mask is
    // clipped to the same 1/40 edge zone the mode selector uses for border
    // shapes. A solid scanner bed is the exception: rows or columns it covers
    // edge to edge are no authored structure, so the mask follows the bed and
    // its stippled fringe instead of leaving the bed's inner part as content.
    let (width, height) = (working.width(), working.height());
    let row_coverage =
        |y: usize| (0..width).filter(|&x| retained.get(x, y)).count() as f64 / width as f64;
    let column_coverage =
        |x: usize| (0..height).filter(|&y| retained.get(x, y)).count() as f64 / height as f64;
    let left = scanner_bed_depth(width, column_coverage);
    let right = scanner_bed_depth(width, |depth| column_coverage(width - 1 - depth));
    let top = scanner_bed_depth(height, row_coverage);
    let bottom = scanner_bed_depth(height, |depth| row_coverage(height - 1 - depth));
    BinaryImage::from_fn_parallel(width, height, |x, y| {
        retained.get(x, y) && (x < left || x + right >= width || y < top || y + bottom >= height)
    })
}

/// How far from one edge the border mask may reach: the 1/40 edge zone, or a
/// solid scanner bed (lines at least 90% covered by the border component,
/// starting inside that zone) and the stippled fringe after it, whichever is
/// deeper. A bed never claims more than a fifth of the page.
fn scanner_bed_depth(extent: usize, coverage_at_depth: impl Fn(usize) -> f64) -> usize {
    let zone = extent.div_ceil(40).max(1);
    let limit = extent / 5;
    let Some(start) = (0..zone.min(limit)).find(|&depth| coverage_at_depth(depth) >= 0.9) else {
        return zone;
    };
    let solid_end = (start..limit)
        .find(|&depth| coverage_at_depth(depth) < 0.9)
        .unwrap_or(limit);
    let fringe_end = (solid_end..limit)
        .find(|&depth| coverage_at_depth(depth) < 0.2)
        .unwrap_or(limit);
    zone.max(fringe_end)
}

#[derive(Clone, Copy)]
struct ContentCandidate<'a> {
    component: &'a Component,
    grayscale_supported: bool,
    picture_mask_overlap_pixels: usize,
}

#[derive(Clone, Debug, Default)]
struct BlockStats {
    component_count: usize,
    ink_area: usize,
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
    initialized: bool,
    grayscale_supported: bool,
    picture_mask_overlap_pixels: usize,
    heading_evidence: bool,
    text_evidence: bool,
    labels: Vec<u32>,
}

impl BlockStats {
    fn protected(&self, calibration: PageCalibration) -> bool {
        self.grayscale_supported
            || self.picture_mask_overlap_pixels
                >= calibration.content_minimum_picture_overlap_pixels()
            || self.heading_evidence
            || self.text_evidence
    }

    fn width(&self) -> usize {
        self.right - self.left + 1
    }

    fn height(&self) -> usize {
        self.bottom - self.top + 1
    }
}

fn cluster_content_blocks(
    map: &ComponentMap,
    candidates: &[ContentCandidate<'_>],
    picture_mask: Option<&BinaryImage>,
    distance_to_white: &[u32],
    calibration: PageCalibration,
) -> ClusteredContent {
    let mut candidate_labels = vec![false; map.components().len() + 1];
    for candidate in candidates {
        candidate_labels[candidate.component.label as usize] = true;
    }
    let candidate_image = map.retain(|component| candidate_labels[component.label as usize]);
    let (dilation_x, dilation_y) = calibration.content_dilation();
    let block_map = ComponentMap::from_binary(&dilate(&candidate_image, dilation_x, dilation_y));
    let mut blocks = vec![BlockStats::default(); block_map.components().len() + 1];
    let mut component_blocks = vec![0usize; map.components().len() + 1];
    for candidate in candidates {
        let component = candidate.component;
        let center_x = (component.left + component.right) / 2;
        let center_y = (component.top + component.bottom) / 2;
        let block_label = block_map.label_at(center_x, center_y) as usize;
        component_blocks[component.label as usize] = block_label;
        if block_label == 0 {
            continue;
        }
        let block = &mut blocks[block_label];
        if !block.initialized {
            block.left = component.left;
            block.top = component.top;
            block.right = component.right;
            block.bottom = component.bottom;
            block.initialized = true;
        } else {
            block.left = block.left.min(component.left);
            block.top = block.top.min(component.top);
            block.right = block.right.max(component.right);
            block.bottom = block.bottom.max(component.bottom);
        }
        block.component_count += 1;
        block.ink_area += component.area;
        block.grayscale_supported |= candidate.grayscale_supported;
        block.picture_mask_overlap_pixels += candidate.picture_mask_overlap_pixels;
    }
    annotate_picture_overlap(&mut blocks, picture_mask);
    // Text-line evidence has to exist before retention, not after it. Retention
    // decides which components survive into the block set that later grows the
    // text mask, so a block judged only by relative ink mass — a footnote
    // paragraph under a full page of body text — was deleted before it could
    // ever prove it was text, and the crop bound followed the deletion.
    let text_lines =
        build_text_line_mask(&candidate_image, &blocks, distance_to_white, calibration);
    annotate_text_evidence(
        map,
        &component_blocks,
        &mut blocks,
        &text_lines.mask,
        calibration,
    );
    let fragmented_edge_continuations = blocks
        .iter()
        .map(|block| {
            fragmented_edge_continuation_sides(
                block,
                block_map.width(),
                block_map.height(),
                calibration,
            )
        })
        .collect::<Vec<_>>();
    let maximum_area = blocks
        .iter()
        .zip(&fragmented_edge_continuations)
        .filter(|(_, &edge_continuation)| edge_continuation == 0)
        .map(|(block, _)| block.ink_area)
        .max()
        .unwrap_or(0);
    let maximum_count = blocks
        .iter()
        .zip(&fragmented_edge_continuations)
        .filter(|(_, &edge_continuation)| edge_continuation == 0)
        .map(|(block, _)| block.component_count)
        .max()
        .unwrap_or(0);
    let minimum_block_area = calibration.content_min_block_area();
    let dominant = blocks
        .iter()
        .zip(&fragmented_edge_continuations)
        .map(|(block, &edge_continuation)| {
            block.initialized
                && edge_continuation == 0
                && (block.protected(calibration)
                    || block.ink_area >= (maximum_area / 12).max(minimum_block_area)
                    || block.component_count >= (maximum_count / 8).max(3))
        })
        .collect::<Vec<_>>();
    // Running heads, folio lines and chapter ornaments sit above the whole
    // text column, and on chapter openers the whitespace below them exceeds
    // any marginalia gap (16.8-38.8 mm measured against pages 208/339/360
    // of the calibration book) because the only block in between — the
    // chapter heading — is not yet protected at this stage. Positional
    // evidence identifies this furniture directly: a band above the primary
    // block, sharing its horizontal extent, at least half its width, and
    // reaching below the outer 1/20 scanner-junk frame is page content no
    // matter how far the body starts.
    let primary_block = dominant
        .iter()
        .enumerate()
        .filter(|&(_, &is_dominant)| is_dominant)
        .map(|(label, _)| &blocks[label])
        .filter(|block| block.initialized)
        .max_by_key(|block| block.ink_area);
    let frame_band_bottom = block_map.height() / 20;
    let mut retained = vec![false; map.components().len() + 1];
    for candidate in candidates {
        let component = candidate.component;
        let block_label = component_blocks[component.label as usize];
        if block_label == 0 {
            continue;
        }
        let block = &blocks[block_label];
        let supported_marginalia = block.ink_area >= 4
            && blocks.iter().enumerate().any(|(other_label, other)| {
                dominant.get(other_label).copied().unwrap_or(false)
                    && block_is_supported_outlier(block, other, calibration)
            });
        let top_furniture = primary_block.is_some_and(|primary| {
            block.bottom < primary.top
                && block.bottom >= frame_band_bottom
                && axis_gap(block.left, block.right, primary.left, primary.right) == 0
                && block.width().saturating_mul(2) >= primary.width()
        });
        retained[component.label as usize] = fragmented_edge_continuations[block_label] == 0
            && (dominant[block_label]
                || block.protected(calibration)
                || supported_marginalia
                || top_furniture);
    }
    let crop_artifact_sides = fragmented_edge_continuations
        .iter()
        .copied()
        .fold(0, |sides, block_sides| sides | block_sides);
    ClusteredContent {
        retained,
        crop_artifact_sides,
    }
}

struct ClusteredContent {
    retained: Vec<bool>,
    crop_artifact_sides: u8,
}

const CROP_ARTIFACT_LEFT: u8 = 1;
const CROP_ARTIFACT_TOP: u8 = 2;
const CROP_ARTIFACT_RIGHT: u8 = 4;
const CROP_ARTIFACT_BOTTOM: u8 = 8;

/// After the outer 1/40 border mask is subtracted, a broad gutter shadow can
/// survive as hundreds of tiny fragments just inside that clipped zone. The
/// fragments cluster into a "dominant" block despite carrying no authored
/// structure, and its end pieces pin the crop to the top and bottom edges.
///
/// Reject only a fragmented block that is wholly inside an outer 1/8 corridor
/// and attached to the orthogonal page frame. Real marginalia does not usually
/// touch that frame, while clipped running furniture spans beyond the narrow
/// corridor. The calibrated per-component area guard preserves glyph-bearing
/// edge blocks even when their geometry is unusual.
fn fragmented_edge_continuation_sides(
    block: &BlockStats,
    page_width: usize,
    page_height: usize,
    calibration: PageCalibration,
) -> u8 {
    if !block.initialized || block.component_count < 3 {
        return 0;
    }
    let horizontal_corridor = page_width.div_ceil(8).max(1);
    let vertical_corridor = page_height.div_ceil(8).max(1);
    let attached_to_horizontal_frame = block.top == 0 || block.bottom + 1 == page_height;
    let attached_to_vertical_frame = block.left == 0 || block.right + 1 == page_width;
    let nominal_height = if calibration.valid {
        calibration.x_height_px.max(1.0)
    } else {
        (8.0 * calibration.effective_dpi / 150.0).max(4.0)
    };
    let maximum_fragment_area = (0.025 * nominal_height * nominal_height).round().max(4.0) as usize;
    if block.ink_area > block.component_count.saturating_mul(maximum_fragment_area) {
        return 0;
    }
    let mut sides = 0;
    if attached_to_horizontal_frame && block.right < horizontal_corridor {
        sides |= CROP_ARTIFACT_LEFT;
    }
    if attached_to_vertical_frame && block.bottom < vertical_corridor {
        sides |= CROP_ARTIFACT_TOP;
    }
    if attached_to_horizontal_frame && block.left.saturating_add(horizontal_corridor) >= page_width
    {
        sides |= CROP_ARTIFACT_RIGHT;
    }
    if attached_to_vertical_frame && block.top.saturating_add(vertical_corridor) >= page_height {
        sides |= CROP_ARTIFACT_BOTTOM;
    }
    sides
}

#[cfg(test)]
fn crop_qualified_picture_bounds(
    picture_mask: &BinaryImage,
    crop_artifact_sides: u8,
    calibration: PageCalibration,
) -> Option<PixelBounds> {
    crop_qualified_picture_bounds_with_authority(
        picture_mask,
        None,
        crop_artifact_sides,
        calibration,
    )
}

fn crop_qualified_picture_bounds_with_authority(
    picture_mask: &BinaryImage,
    crop_authoritative_picture_mask: Option<&BinaryImage>,
    crop_artifact_sides: u8,
    calibration: PageCalibration,
) -> Option<PixelBounds> {
    binary_bounds(
        &qualify_picture_mask_for_crop_with_authority(
            picture_mask,
            crop_authoritative_picture_mask,
            crop_artifact_sides,
            calibration,
        )
        .included,
    )
}

struct CropPictureQualification {
    included: BinaryImage,
    excluded: BinaryImage,
    structured_text: BinaryImage,
    structured_text_edge_sides: u8,
}

fn qualify_picture_mask_for_crop_with_authority(
    picture_mask: &BinaryImage,
    crop_authoritative_picture_mask: Option<&BinaryImage>,
    crop_artifact_sides: u8,
    calibration: PageCalibration,
) -> CropPictureQualification {
    let nominal_height = if calibration.valid {
        calibration.x_height_px.max(1.0)
    } else {
        (8.0 * calibration.effective_dpi / 150.0).max(4.0)
    };
    // Picture masks deliberately grow around tonal regions. Once independent
    // fragmented-frame evidence has identified a contaminated side, qualify
    // crop bounds against a corridor widened by three x-heights so the grown
    // gutter component cannot escape the stricter 1/8 block gate by a few
    // pixels. Components reaching farther into the page (including full-bleed
    // photos and maps) remain authoritative.
    let picture_growth = (3.0 * nominal_height).round() as usize;
    let horizontal_corridor = picture_mask
        .width()
        .div_ceil(8)
        .saturating_add(picture_growth)
        .max(1);
    let vertical_corridor = picture_mask
        .height()
        .div_ceil(8)
        .saturating_add(picture_growth)
        .max(1);
    let frame_horizontal_corridor = picture_mask.width().div_ceil(8).max(1);
    let frame_vertical_corridor = picture_mask.height().div_ceil(8).max(1);
    let map = ComponentMap::from_binary(picture_mask);
    let corridor_sides = |component: &Component| {
        let mut sides = 0;
        if component.right < frame_horizontal_corridor {
            sides |= CROP_ARTIFACT_LEFT;
        }
        if component.bottom < frame_vertical_corridor {
            sides |= CROP_ARTIFACT_TOP;
        }
        if component.left.saturating_add(frame_horizontal_corridor) >= picture_mask.width() {
            sides |= CROP_ARTIFACT_RIGHT;
        }
        if component.top.saturating_add(frame_vertical_corridor) >= picture_mask.height() {
            sides |= CROP_ARTIFACT_BOTTOM;
        }
        sides
    };
    // One attached owner fragment establishes that the narrow side corridor
    // is a scanner rail. Qualify its detached tiles the same way: the Luther
    // gutter is interrupted vertically, but all tiles belong to one visual
    // frame and otherwise the detached pieces still pin the crop.
    let picture_frame_sides = map.components().iter().fold(0, |sides, component| {
        let attached = component.left == 0
            || component.top == 0
            || component.right + 1 == picture_mask.width()
            || component.bottom + 1 == picture_mask.height();
        if attached {
            sides | corridor_sides(component)
        } else {
            sides
        }
    });
    let included = map.retain(|component| {
        // Picture ownership is semantic/render state and remains untouched.
        // Crop geometry applies one additional trust check: a component wholly
        // inside an outer 1/8 corridor whose picture fragments reach the page
        // frame is scanner gutter/frame tone, even when the grayscale content
        // pass found no fragmented-ink corroboration. A genuine marginal photo
        // floats clear of that frame or leaves the corridor; a full-bleed photo
        // necessarily leaves every corridor.
        let frame_attached_rail = picture_frame_sides & corridor_sides(component) != 0;
        let manually_authoritative = crop_authoritative_picture_mask
            .is_some_and(|mask| component_mask_overlap(&map, component, Some(mask)) > 0);
        let contaminated_side = (crop_artifact_sides & CROP_ARTIFACT_LEFT != 0
            && component.right < horizontal_corridor)
            || (crop_artifact_sides & CROP_ARTIFACT_TOP != 0
                && component.bottom < vertical_corridor)
            || (crop_artifact_sides & CROP_ARTIFACT_RIGHT != 0
                && component.left.saturating_add(horizontal_corridor) >= picture_mask.width())
            || (crop_artifact_sides & CROP_ARTIFACT_BOTTOM != 0
                && component.top.saturating_add(vertical_corridor) >= picture_mask.height());
        let excluded = !manually_authoritative && (frame_attached_rail || contaminated_side);
        !excluded
    });
    let excluded = picture_mask.subtract(&included);
    CropPictureQualification {
        included,
        excluded,
        structured_text: BinaryImage::new(picture_mask.width(), picture_mask.height()),
        structured_text_edge_sides: 0,
    }
}

/// Restores authored glyph components that a rejected picture rail happened
/// to cover. Picture masks are deliberately allowed to grow around tonal
/// evidence, so a sparse margin number can become a detached mask island in
/// the same outer corridor as scanner/fold ink. The island must remain
/// non-authoritative for crop geometry; only its compact, glyph-like source
/// components may return to the content binary.
fn restore_structured_text_from_rejected_picture_rail(
    binary: &BinaryImage,
    excluded_picture: &BinaryImage,
    calibration: PageCalibration,
) -> BinaryImage {
    debug_assert_eq!(
        (binary.width(), binary.height()),
        (excluded_picture.width(), excluded_picture.height())
    );
    let mut restored = BinaryImage::new(binary.width(), binary.height());
    if binary.count_black() == 0 || excluded_picture.count_black() == 0 {
        return restored;
    }

    let nominal_height = if calibration.valid {
        calibration.x_height_px.max(1.0)
    } else {
        (8.0 * calibration.effective_dpi / 150.0).max(4.0)
    };
    let edge_corridor = binary.width().div_ceil(8).max(1);
    // The rejected owner rail can stop several pixels before the authored
    // margin column. Keep the allowance tied to calibrated type height, not
    // to the broad edge corridor: a sparse footnote/line-number column may
    // sit one glyph-width away from the rail after resampling and deskew.
    let maximum_gap = (3.0 * nominal_height).round().max(8.0) as usize;
    let maximum_extent = (4.5 * nominal_height).round().max(8.0) as usize;
    let maximum_area = (8.0 * nominal_height.powi(2)).round().max(32.0) as usize;
    let minimum_row_ink = (nominal_height * 0.75).round().max(8.0) as usize;
    let mut interior_row_ink = vec![0usize; binary.height()];
    for (y, row_ink) in interior_row_ink.iter_mut().enumerate() {
        for x in 0..binary.width() {
            if binary.get(x, y) && !excluded_picture.get(x, y) {
                *row_ink += 1;
            }
        }
    }
    let left_excluded_right = (0..edge_corridor.min(binary.width()))
        .filter(|&x| (0..binary.height()).any(|y| excluded_picture.get(x, y)))
        .max();
    let right_excluded_left = (edge_corridor.min(binary.width())..binary.width())
        .filter(|&x| (0..binary.height()).any(|y| excluded_picture.get(x, y)))
        .min();

    // Do not let the rejected owner rail join authored glyphs into one large
    // edge component. The rail remains an adjacency witness below, but its
    // pixels are never eligible for restoration or crop evidence.
    let candidate_binary = binary.subtract(excluded_picture);
    let map = ComponentMap::from_binary(&candidate_binary);
    let mut candidates = Vec::new();
    for component in map.components() {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let major = width.max(height);
        let minor = width.min(height);
        let box_area = width.saturating_mul(height).max(1);
        let compact_glyph = component.area >= 2
            && major <= maximum_extent
            && minor >= 1
            && component.area <= maximum_area
            && component.area.saturating_mul(100) < box_area.saturating_mul(90)
            && major <= minor.saturating_mul(10);
        let near_left = component.right < edge_corridor.saturating_mul(2);
        let near_right = component
            .left
            .saturating_add(edge_corridor.saturating_mul(2))
            >= binary.width();
        if !near_left && !near_right {
            continue;
        }
        let adjacent_to_excluded = (near_left
            && left_excluded_right.is_some_and(|right| {
                component.left > right && component.left - right - 1 <= maximum_gap
            }))
            || (near_right
                && right_excluded_left.is_some_and(|left| {
                    component.right < left && left - component.right - 1 <= maximum_gap
                }));
        let row_supported =
            (component.top..=component.bottom).any(|y| interior_row_ink[y] >= minimum_row_ink);
        if !compact_glyph
            || component.left == 0
            || component.top == 0
            || component.right + 1 == binary.width()
            || component.bottom + 1 == binary.height()
        {
            continue;
        }
        if !adjacent_to_excluded {
            continue;
        }
        if !row_supported {
            continue;
        }
        candidates.push(component);
    }

    if candidates.len() < 2 {
        return restored;
    }
    for component in &candidates {
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if map.label_at(x, y) == component.label {
                    restored.set(x, y, true);
                }
            }
        }
    }
    restored
}

/// A crop envelope may safely include an excluded frame rail when authored
/// text has been proved to sit immediately on its page-facing side. The rail
/// remains excluded from every ink mask; this only keeps a later render-side
/// remeasurement from moving the crop boundary through the text column.
fn structured_text_edge_sides(
    excluded_picture: &BinaryImage,
    structured_text: &BinaryImage,
    calibration: PageCalibration,
) -> u8 {
    debug_assert_eq!(
        (excluded_picture.width(), excluded_picture.height()),
        (structured_text.width(), structured_text.height())
    );
    if excluded_picture.count_black() == 0 || structured_text.count_black() == 0 {
        return 0;
    }
    let nominal_height = if calibration.valid {
        calibration.x_height_px.max(1.0)
    } else {
        (8.0 * calibration.effective_dpi / 150.0).max(4.0)
    };
    let maximum_gap = (3.0 * nominal_height).round().max(8.0) as usize;
    // Edge authority is local in both axes. A fragmented rail may sit close
    // to a text column along the crop axis while belonging to a wholly
    // different part of the page; one x-height keeps genuine neighbouring
    // fragments connected without letting that rail reopen a distant title.
    let maximum_perpendicular_gap = nominal_height.round().max(4.0) as usize;
    let horizontal_corridor = excluded_picture.width().div_ceil(8).max(1);
    let vertical_corridor = excluded_picture.height().div_ceil(8).max(1);
    let excluded_map = ComponentMap::from_binary(excluded_picture);
    let structured_components = ComponentMap::from_binary(structured_text);
    let mut sides = 0;
    for rail in excluded_map.components() {
        let left_rail = rail.left == 0 && rail.right < horizontal_corridor;
        let right_rail = rail.right + 1 == excluded_picture.width()
            && rail.left.saturating_add(horizontal_corridor) >= excluded_picture.width();
        let top_rail = rail.top == 0 && rail.bottom < vertical_corridor;
        let bottom_rail = rail.bottom + 1 == excluded_picture.height()
            && rail.top.saturating_add(vertical_corridor) >= excluded_picture.height();

        for text in structured_components.components() {
            if left_rail
                && text.left > rail.right
                && text.left - rail.right - 1 <= maximum_gap
                && text.left < horizontal_corridor.saturating_mul(2)
                && intervals_are_local(
                    rail.top,
                    rail.bottom,
                    text.top,
                    text.bottom,
                    maximum_perpendicular_gap,
                )
            {
                sides |= CROP_ARTIFACT_LEFT;
            }
            if right_rail
                && text.right < rail.left
                && rail.left - text.right - 1 <= maximum_gap
                && text
                    .right
                    .saturating_add(horizontal_corridor.saturating_mul(2))
                    >= excluded_picture.width()
                && intervals_are_local(
                    rail.top,
                    rail.bottom,
                    text.top,
                    text.bottom,
                    maximum_perpendicular_gap,
                )
            {
                sides |= CROP_ARTIFACT_RIGHT;
            }
            if top_rail
                && text.top > rail.bottom
                && text.top - rail.bottom - 1 <= maximum_gap
                && text.top < vertical_corridor.saturating_mul(2)
                && intervals_are_local(
                    rail.left,
                    rail.right,
                    text.left,
                    text.right,
                    maximum_perpendicular_gap,
                )
            {
                sides |= CROP_ARTIFACT_TOP;
            }
            if bottom_rail
                && text.bottom < rail.top
                && rail.top - text.bottom - 1 <= maximum_gap
                && text
                    .bottom
                    .saturating_add(vertical_corridor.saturating_mul(2))
                    >= excluded_picture.height()
                && intervals_are_local(
                    rail.left,
                    rail.right,
                    text.left,
                    text.right,
                    maximum_perpendicular_gap,
                )
            {
                sides |= CROP_ARTIFACT_BOTTOM;
            }
        }
    }
    sides
}

fn intervals_are_local(
    first_start: usize,
    first_end: usize,
    second_start: usize,
    second_end: usize,
    maximum_gap: usize,
) -> bool {
    if first_end < second_start {
        second_start - first_end - 1 <= maximum_gap
    } else if second_end < first_start {
        first_start - second_end - 1 <= maximum_gap
    } else {
        true
    }
}

fn expand_bounds_for_structured_edge_text(
    bounds: &mut Option<PixelBounds>,
    edge_sides: u8,
    width: usize,
    height: usize,
    trim_authority: AcceptedTrimAuthority,
) {
    let Some(mut bounds_value) = *bounds else {
        return;
    };
    if edge_sides & CROP_ARTIFACT_LEFT != 0 {
        bounds_value.left = 0;
    }
    if edge_sides & CROP_ARTIFACT_TOP != 0 {
        bounds_value.top = 0;
    }
    if edge_sides & CROP_ARTIFACT_RIGHT != 0 {
        bounds_value.right = width.saturating_sub(1);
    }
    if edge_sides & CROP_ARTIFACT_BOTTOM != 0 {
        bounds_value.bottom = height.saturating_sub(1);
    }
    *bounds = trim_authority.clamp(Some(bounds_value));
}

fn retained_content_blocks(
    map: &ComponentMap,
    candidates: &[ContentCandidate<'_>],
    retained: &[bool],
    picture_mask: Option<&BinaryImage>,
    calibration: PageCalibration,
) -> (Vec<BlockStats>, Vec<usize>) {
    let retained_image = map.retain(|component| retained[component.label as usize]);
    let (dilation_x, dilation_y) = calibration.content_dilation();
    let block_map = ComponentMap::from_binary(&dilate(&retained_image, dilation_x, dilation_y));
    let mut blocks = vec![BlockStats::default(); block_map.components().len() + 1];
    let mut component_blocks = vec![0usize; map.components().len() + 1];
    for candidate in candidates {
        let component = candidate.component;
        if !retained[component.label as usize] {
            continue;
        }
        let center_x = (component.left + component.right) / 2;
        let center_y = (component.top + component.bottom) / 2;
        let block_label = block_map.label_at(center_x, center_y) as usize;
        component_blocks[component.label as usize] = block_label;
        if block_label == 0 {
            continue;
        }
        let block = &mut blocks[block_label];
        if !block.initialized {
            block.left = component.left;
            block.top = component.top;
            block.right = component.right;
            block.bottom = component.bottom;
            block.initialized = true;
        } else {
            block.left = block.left.min(component.left);
            block.top = block.top.min(component.top);
            block.right = block.right.max(component.right);
            block.bottom = block.bottom.max(component.bottom);
        }
        block.component_count += 1;
        block.ink_area += component.area;
        block.grayscale_supported |= candidate.grayscale_supported;
        block.picture_mask_overlap_pixels += candidate.picture_mask_overlap_pixels;
        block.labels.push(component.label);
    }
    annotate_picture_overlap(&mut blocks, picture_mask);
    (blocks, component_blocks)
}

fn annotate_picture_overlap(blocks: &mut [BlockStats], picture_mask: Option<&BinaryImage>) {
    let Some(mask) = picture_mask else {
        return;
    };
    for block in blocks.iter_mut().filter(|block| block.initialized) {
        block.picture_mask_overlap_pixels = (block.top..=block.bottom)
            .flat_map(|y| (block.left..=block.right).map(move |x| (x, y)))
            .filter(|&(x, y)| mask.get(x, y))
            .count();
    }
}

fn component_mask_overlap(
    map: &ComponentMap,
    component: &Component,
    mask: Option<&BinaryImage>,
) -> usize {
    let Some(mask) = mask else {
        return 0;
    };
    let mut overlap = 0usize;
    for y in component.top..=component.bottom {
        for x in component.left..=component.right {
            overlap += usize::from(map.label_at(x, y) == component.label && mask.get(x, y));
        }
    }
    overlap
}

fn annotate_heading_evidence(
    map: &ComponentMap,
    blocks: &mut [BlockStats],
    calibration: PageCalibration,
) {
    let nominal_height = heading_nominal_glyph_height(calibration);
    let maximum_gap = (12.0 * nominal_height).round().max(12.0) as usize;
    let alignment_tolerance = (2.0 * nominal_height).round().max(4.0) as usize;
    let heading_flags = blocks
        .iter()
        .map(|candidate| {
            if !candidate.initialized
                || candidate.component_count < 3
                || candidate.component_count > 64
                || candidate.height() as f64 > 5.0 * nominal_height
            {
                return false;
            }
            let mut component_heights = Vec::new();
            let mut glyph_like = 0usize;
            for component in map
                .components()
                .iter()
                .filter(|component| candidate.labels.contains(&component.label))
            {
                let height = component.bottom - component.top + 1;
                component_heights.push(height);
                if heading_glyph_like(component, nominal_height) {
                    glyph_like += 1;
                }
            }
            if component_heights.is_empty() || glyph_like * 2 < component_heights.len() {
                return false;
            }
            component_heights.sort_unstable();
            let median_height = component_heights[component_heights.len() / 2] as f64;
            // Running heads are often set at the body text's x-height. Requiring
            // a heading to be visibly larger misclassified the narrow header on
            // dictionary pages as scanner-edge garbage, so a text-like line at
            // the same calibrated height remains ownership evidence too.
            if median_height < 0.9 * nominal_height || median_height > 4.0 * nominal_height {
                return false;
            }
            let candidate_center = (candidate.left + candidate.right) / 2;
            let body_envelope = blocks
                .iter()
                .filter(|body| {
                    body.initialized
                        && body.top > candidate.bottom
                        && body.component_count >= 8
                        && (body.height() as f64) >= 2.0 * nominal_height
                        && body.top - candidate.bottom - 1 <= maximum_gap
                })
                .fold(None, |envelope: Option<(usize, usize)>, body| {
                    Some(match envelope {
                        None => (body.left, body.right),
                        Some((left, right)) => (left.min(body.left), right.max(body.right)),
                    })
                });
            body_envelope.is_some_and(|(body_left, body_right)| {
                let overlap = candidate
                    .right
                    .min(body_right)
                    .saturating_sub(candidate.left.max(body_left));
                let aligned_center = candidate_center.saturating_add(alignment_tolerance)
                    >= body_left
                    && candidate_center <= body_right.saturating_add(alignment_tolerance);
                aligned_center || overlap.saturating_mul(4) >= candidate.width()
            })
        })
        .collect::<Vec<_>>();
    for (block, heading_evidence) in blocks.iter_mut().zip(heading_flags) {
        block.heading_evidence = heading_evidence;
    }
}

fn heading_nominal_glyph_height(calibration: PageCalibration) -> f64 {
    if calibration.valid {
        calibration.x_height_px.max(1.0)
    } else {
        (8.0 * calibration.effective_dpi / 150.0).max(4.0)
    }
}

fn heading_glyph_like(component: &Component, nominal_height: f64) -> bool {
    let width = component.right - component.left + 1;
    let height = component.bottom - component.top + 1;
    let height = height as f64;
    height >= 0.7 * nominal_height
        && height <= 4.0 * nominal_height
        && width as f64 <= 4.0 * height
        && component.area >= 3
}

fn build_protected_mask(
    width: usize,
    height: usize,
    picture_mask: Option<&BinaryImage>,
    blocks: &[BlockStats],
    calibration: PageCalibration,
) -> BinaryImage {
    let mut protected = picture_mask
        .cloned()
        .unwrap_or_else(|| BinaryImage::new(width, height));
    for block in blocks
        .iter()
        .filter(|block| block.initialized && block.protected(calibration))
    {
        for y in block.top..=block.bottom {
            for x in block.left..=block.right {
                protected.set(x, y, true);
            }
        }
    }
    protected
}

fn annotate_text_evidence(
    map: &ComponentMap,
    component_blocks: &[usize],
    blocks: &mut [BlockStats],
    text_mask: &BinaryImage,
    calibration: PageCalibration,
) {
    let mut evidence_pixels = vec![0usize; blocks.len()];
    for y in 0..text_mask.height() {
        for x in 0..text_mask.width() {
            if !text_mask.get(x, y) {
                continue;
            }
            let component_label = map.label_at(x, y) as usize;
            let block_label = component_blocks
                .get(component_label)
                .copied()
                .unwrap_or_default();
            if block_label != 0 {
                evidence_pixels[block_label] += 1;
            }
        }
    }
    let minimum = calibration.content_minimum_text_evidence_pixels();
    for (block, pixels) in blocks.iter_mut().zip(evidence_pixels) {
        block.text_evidence = pixels >= minimum;
    }
}

fn block_evidence(block: &BlockStats) -> ContentBlockEvidence {
    ContentBlockEvidence {
        bounds: diagnostic_rect(PixelBounds {
            left: block.left,
            top: block.top,
            right: block.right,
            bottom: block.bottom,
        }),
        picture_mask_overlap_pixels: block.picture_mask_overlap_pixels,
        heading_evidence: block.heading_evidence,
        grayscale_evidence: block.grayscale_supported,
        text_evidence: block.text_evidence,
    }
}

struct TextLineMask {
    mask: BinaryImage,
    vicinity_mask: BinaryImage,
    summary: ContentTextMaskSummary,
}

fn build_text_line_mask(
    content: &BinaryImage,
    blocks: &[BlockStats],
    distance_to_white: &[u32],
    calibration: PageCalibration,
) -> TextLineMask {
    let peaks = find_peaks(distance_to_white, content.width(), content.height());
    let mut mask = BinaryImage::new(content.width(), content.height());
    let mut vicinity_mask = BinaryImage::new(content.width(), content.height());
    let mut line_count = 0usize;
    for block in blocks.iter().filter(|block| block.initialized) {
        let mut histogram = vec![0usize; block.bottom - block.top + 1];
        for y in block.top..=block.bottom {
            histogram[y - block.top] = (block.left..=block.right)
                .filter(|&x| content.get(x, y))
                .count();
        }
        let mut bands = Vec::new();
        split_histogram_bands(
            &histogram,
            0,
            histogram.len(),
            calibration.content_minimum_band_rows(),
            &mut bands,
        );
        for (start, end) in bands {
            let Some(first_row) = (start..end).find(|&row| histogram[row] != 0) else {
                continue;
            };
            let last_row = (start..end)
                .rev()
                .find(|&row| histogram[row] != 0)
                .expect("a nonempty band has a last row");
            let top = block.top + first_row;
            let bottom = block.top + last_row;
            let mut left = block.right;
            let mut right = block.left;
            let mut ink = 0usize;
            for y in top..=bottom {
                for x in block.left..=block.right {
                    if content.get(x, y) {
                        left = left.min(x);
                        right = right.max(x);
                        ink += 1;
                    }
                }
            }
            if ink == 0 || right < left {
                continue;
            }
            let width = right - left + 1;
            let height = bottom - top + 1;
            let fill_ratio = ink as f64 / width.saturating_mul(height).max(1) as f64;
            if !(0.22..=0.65).contains(&fill_ratio) {
                continue;
            }
            let required_peaks = ((0.4 * width as f64 / height.max(1) as f64) as usize).max(2);
            let peak_count = peaks
                .iter()
                .filter(|&&(x, y)| {
                    (left..=right).contains(&x) && (top..=bottom).contains(&y) && content.get(x, y)
                })
                .count();
            if peak_count < required_peaks {
                continue;
            }
            line_count += 1;
            for y in top..=bottom {
                for x in left..=right {
                    // This rectangle is measurement evidence only. Including
                    // inter-glyph and inter-word paper prevents the tonal-page
                    // refusal from mistaking the interior of a recognized text
                    // line for unrelated continuous-tone content.
                    vicinity_mask.set(x, y, true);
                    if content.get(x, y) {
                        mask.set(x, y, true);
                    }
                }
            }
        }
    }
    let bounds = binary_bounds(&mask).map(|bounds| ContentDiagnosticRect {
        x_px: bounds.left,
        y_px: bounds.top,
        width_px: bounds.width(),
        height_px: bounds.height(),
    });
    TextLineMask {
        summary: ContentTextMaskSummary {
            analysis_width_px: content.width(),
            analysis_height_px: content.height(),
            ink_pixels: mask.count_black(),
            line_count,
            bounds,
        },
        mask,
        vicinity_mask,
    }
}

fn split_histogram_bands(
    histogram: &[usize],
    start: usize,
    end: usize,
    minimum_rows: usize,
    output: &mut Vec<(usize, usize)>,
) {
    if end.saturating_sub(start) < minimum_rows.saturating_mul(2) {
        output.push((start, end));
        return;
    }
    let mut best: Option<(usize, f64)> = None;
    for valley in start + minimum_rows..=end - minimum_rows {
        let left_peak = histogram[start..valley].iter().copied().max().unwrap_or(0);
        let right_peak = histogram[valley..end].iter().copied().max().unwrap_or(0);
        let smaller = left_peak.min(right_peak);
        let larger = left_peak.max(right_peak);
        if smaller.saturating_mul(20) < larger || larger == 0 {
            continue;
        }
        let valley_height = histogram[valley];
        if valley_height as f64 * 3.5 > 0.5 * (left_peak + right_peak) as f64 {
            continue;
        }
        let depth = 1.0 - valley_height as f64 / ((left_peak + right_peak) as f64 * 0.5);
        if best.is_none_or(|(_, best_depth)| depth > best_depth) {
            best = Some((valley, depth));
        }
    }
    if let Some((valley, _)) = best {
        split_histogram_bands(histogram, start, valley, minimum_rows, output);
        split_histogram_bands(histogram, valley, end, minimum_rows, output);
    } else {
        output.push((start, end));
    }
}

const HORIZONTAL_GARBAGE: u32 = 1;
const VERTICAL_GARBAGE: u32 = 2;
const REMOVED_GARBAGE: u32 = 3;

fn garbage_seed_labels(
    borders: &BinaryImage,
    cleaned: &BinaryImage,
    protected: &BinaryImage,
    calibration: PageCalibration,
) -> Vec<u32> {
    let width = cleaned.width();
    let height = cleaned.height();
    let (long_size, thin_size) = calibration.content_long_opening_size();
    let long_radius = long_size.saturating_sub(1) / 2;
    let thin_radius = thin_size.saturating_sub(1) / 2;
    let horizontal = border_zone_long_lines(&open(cleaned, long_radius, thin_radius), true);
    let vertical = border_zone_long_lines(&open(cleaned, thin_radius, long_radius), false);
    let border_map = ComponentMap::from_binary(borders);
    let mut border_labels = vec![0u32; border_map.components().len() + 1];
    for component in border_map.components() {
        let component_width = component.right - component.left + 1;
        let component_height = component.bottom - component.top + 1;
        border_labels[component.label as usize] = if component_width >= component_height {
            HORIZONTAL_GARBAGE
        } else {
            VERTICAL_GARBAGE
        };
    }
    let mut labels = vec![0; width.saturating_mul(height)];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if protected.get(x, y) {
                continue;
            }
            let border_label = border_map.label_at(x, y) as usize;
            if border_label != 0 {
                labels[index] = border_labels[border_label];
            }
            if horizontal.get(x, y) {
                labels[index] = HORIZONTAL_GARBAGE;
            }
            if vertical.get(x, y) {
                labels[index] = VERTICAL_GARBAGE;
            }
        }
    }
    labels
}

fn border_zone_long_lines(source: &BinaryImage, horizontal: bool) -> BinaryImage {
    let map = ComponentMap::from_binary(source);
    let horizontal_zone = source.height().div_ceil(10).max(1);
    let vertical_zone = source.width().div_ceil(10).max(1);
    map.retain(|component| {
        if horizontal {
            component.top < horizontal_zone
                || component.bottom.saturating_add(horizontal_zone) >= source.height()
        } else {
            component.left < vertical_zone
                || component.right.saturating_add(vertical_zone) >= source.width()
        }
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PixelBounds {
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
}

impl PixelBounds {
    fn width(self) -> usize {
        self.right - self.left + 1
    }

    fn height(self) -> usize {
        self.bottom - self.top + 1
    }
}

fn diagnostic_rect(bounds: PixelBounds) -> ContentDiagnosticRect {
    ContentDiagnosticRect {
        x_px: bounds.left,
        y_px: bounds.top,
        width_px: bounds.width(),
        height_px: bounds.height(),
    }
}

/// Final authority for the four content-box sides. Every side retracted by an
/// accepted trim owns its new outer limit, including extrema that moved as
/// collateral when the accepted proposal removed a corner-spanning block.
#[derive(Clone, Copy, Debug, Default)]
struct AcceptedTrimAuthority {
    trimmed_bounds: Option<PixelBounds>,
    accepted_sides: [bool; 4],
}

impl AcceptedTrimAuthority {
    fn new(trimmed_bounds: Option<PixelBounds>, accepted_trims: &[ContentAcceptedTrim]) -> Self {
        let mut accepted_sides = [false; 4];
        for trim in accepted_trims {
            let index = match trim.side {
                ContentTrimSide::Left => 0,
                ContentTrimSide::Top => 1,
                ContentTrimSide::Right => 2,
                ContentTrimSide::Bottom => 3,
            };
            accepted_sides[index] = true;
        }
        if let Some(trimmed) = trimmed_bounds {
            let before_trims = accepted_trims
                .iter()
                .flat_map(|trim| &trim.removed_blocks)
                .fold(trimmed, |bounds, block| {
                    let removed = PixelBounds {
                        left: block.bounds.x_px,
                        top: block.bounds.y_px,
                        right: block
                            .bounds
                            .x_px
                            .saturating_add(block.bounds.width_px.saturating_sub(1)),
                        bottom: block
                            .bounds
                            .y_px
                            .saturating_add(block.bounds.height_px.saturating_sub(1)),
                    };
                    PixelBounds {
                        left: bounds.left.min(removed.left),
                        top: bounds.top.min(removed.top),
                        right: bounds.right.max(removed.right),
                        bottom: bounds.bottom.max(removed.bottom),
                    }
                });
            accepted_sides[0] |= trimmed.left > before_trims.left;
            accepted_sides[1] |= trimmed.top > before_trims.top;
            accepted_sides[2] |= trimmed.right < before_trims.right;
            accepted_sides[3] |= trimmed.bottom < before_trims.bottom;
        }
        Self {
            trimmed_bounds,
            accepted_sides,
        }
    }

    fn clamp(self, bounds: Option<PixelBounds>) -> Option<PixelBounds> {
        let mut bounds = bounds?;
        let Some(trimmed) = self.trimmed_bounds else {
            return Some(bounds);
        };
        if self.accepted_sides[0] {
            bounds.left = bounds.left.max(trimmed.left);
        }
        if self.accepted_sides[1] {
            bounds.top = bounds.top.max(trimmed.top);
        }
        if self.accepted_sides[2] {
            bounds.right = bounds.right.min(trimmed.right);
        }
        if self.accepted_sides[3] {
            bounds.bottom = bounds.bottom.min(trimmed.bottom);
        }
        (bounds.left <= bounds.right && bounds.top <= bounds.bottom).then_some(bounds)
    }
}

fn union_picture_bounds(
    bounds: Option<PixelBounds>,
    picture_bounds: PixelBounds,
    trim_authority: AcceptedTrimAuthority,
) -> Option<PixelBounds> {
    trim_authority.clamp(Some(match bounds {
        Some(content_bounds) => PixelBounds {
            left: content_bounds.left.min(picture_bounds.left),
            top: content_bounds.top.min(picture_bounds.top),
            right: content_bounds.right.max(picture_bounds.right),
            bottom: content_bounds.bottom.max(picture_bounds.bottom),
        },
        None => picture_bounds,
    }))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrimSide {
    Left,
    Top,
    Right,
    Bottom,
}

impl TrimSide {
    const ALL: [Self; 4] = [Self::Left, Self::Top, Self::Right, Self::Bottom];

    fn index(self) -> usize {
        match self {
            Self::Left => 0,
            Self::Top => 1,
            Self::Right => 2,
            Self::Bottom => 3,
        }
    }

    fn strip_thickness(self, current: PixelBounds, next: PixelBounds) -> usize {
        match self {
            Self::Left => next.left.saturating_sub(current.left),
            Self::Top => next.top.saturating_sub(current.top),
            Self::Right => current.right.saturating_sub(next.right),
            Self::Bottom => current.bottom.saturating_sub(next.bottom),
        }
    }

    fn diagnostic(self) -> ContentTrimSide {
        match self {
            Self::Left => ContentTrimSide::Left,
            Self::Top => ContentTrimSide::Top,
            Self::Right => ContentTrimSide::Right,
            Self::Bottom => ContentTrimSide::Bottom,
        }
    }
}

struct TrimProposal {
    side: TrimSide,
    removed_blocks: Vec<bool>,
    next_bounds: PixelBounds,
    score: f64,
    threshold: f64,
    content_distance_sum: f64,
    garbage_distance_sum: f64,
}

struct TrimGeometry {
    removed_blocks: Vec<bool>,
    next_bounds: PixelBounds,
}

fn trim_is_frame_admissible(
    side: TrimSide,
    removed_blocks: &[bool],
    blocks: &[BlockStats],
    component_map: &ComponentMap,
    page_width: usize,
    page_height: usize,
) -> bool {
    let horizontal_zone = page_width.div_ceil(20).max(1);
    let vertical_zone = page_height.div_ceil(20).max(1);
    let right_zone_start = page_width.saturating_sub(horizontal_zone);
    let bottom_zone_start = page_height.saturating_sub(vertical_zone);

    blocks.iter().enumerate().all(|(block_label, block)| {
        if !removed_blocks.get(block_label).copied().unwrap_or(false) {
            return true;
        }
        let in_border_zone = match side {
            TrimSide::Left => block.right < horizontal_zone,
            TrimSide::Top => block.bottom < vertical_zone,
            TrimSide::Right => block.left >= right_zone_start,
            TrimSide::Bottom => block.top >= bottom_zone_start,
        };
        let edge_attached = block.labels.iter().any(|&component_label| {
            let Some(component) = component_label
                .checked_sub(1)
                .and_then(|label| component_map.components().get(label as usize))
            else {
                return false;
            };
            match side {
                TrimSide::Left => component.left == 0,
                TrimSide::Top => component.top == 0,
                TrimSide::Right => component.right.saturating_add(1) == page_width,
                TrimSide::Bottom => component.bottom.saturating_add(1) == page_height,
            }
        });
        in_border_zone || edge_attached
    })
}

#[allow(clippy::too_many_arguments)]
fn trim_content_bounds(
    content: &BinaryImage,
    component_map: &ComponentMap,
    blocks: &[BlockStats],
    component_blocks: &[usize],
    text_mask: &BinaryImage,
    protected_mask: &BinaryImage,
    mut garbage_labels: Vec<u32>,
    calibration: PageCalibration,
) -> (Option<PixelBounds>, [f64; 4], Vec<ContentAcceptedTrim>) {
    let mut active = blocks
        .iter()
        .map(|block| block.initialized)
        .collect::<Vec<_>>();
    if let Some(first) = active.first_mut() {
        *first = false;
    }
    let Some(mut bounds) = bounds_for_active_blocks(blocks, &active) else {
        return (None, [0.0; 4], Vec::new());
    };
    let mut confidence = [0.0f64; 4];
    let mut accepted_trims = Vec::new();
    let mut iteration = 1usize;
    loop {
        if active.iter().filter(|&&is_active| is_active).count() <= 1 {
            break;
        }
        if !TrimSide::ALL
            .iter()
            .any(|&side| build_trim_geometry(side, bounds, blocks, &active, calibration).is_some())
        {
            break;
        }
        let Some(garbage_influence) =
            garbage_influence(content.width(), content.height(), &garbage_labels)
        else {
            break;
        };
        let mut best: Option<TrimProposal> = None;
        for side in TrimSide::ALL {
            let Some(proposal) = build_trim_proposal(
                side,
                bounds,
                content,
                component_map,
                blocks,
                component_blocks,
                &active,
                text_mask,
                &garbage_influence,
                calibration,
            ) else {
                continue;
            };
            confidence[side.index()] = confidence[side.index()].max(proposal.score);
            if proposal.score <= proposal.threshold {
                continue;
            }
            if !trim_is_frame_admissible(
                side,
                &proposal.removed_blocks,
                blocks,
                component_map,
                content.width(),
                content.height(),
            ) {
                continue;
            }
            let margin = proposal.score - proposal.threshold;
            if best
                .as_ref()
                .is_none_or(|current| margin > current.score - current.threshold)
            {
                best = Some(proposal);
            }
        }
        let Some(proposal) = best else {
            break;
        };
        for (block_active, remove) in active.iter_mut().zip(&proposal.removed_blocks) {
            if *remove {
                *block_active = false;
            }
        }
        mark_removed_strip(
            &mut garbage_labels,
            content.width(),
            bounds,
            proposal.next_bounds,
            proposal.side,
            protected_mask,
        );
        accepted_trims.push(ContentAcceptedTrim {
            side: proposal.side.diagnostic(),
            iteration,
            score: proposal.score,
            threshold: proposal.threshold,
            content_distance_sum: proposal.content_distance_sum,
            garbage_distance_sum: proposal.garbage_distance_sum,
            removed_blocks: blocks
                .iter()
                .enumerate()
                .filter(|(label, _)| proposal.removed_blocks[*label])
                .map(|(_, block)| block_evidence(block))
                .collect(),
        });
        iteration += 1;
        bounds = bounds_for_active_blocks(blocks, &active)
            .expect("an accepted trim proposal retains at least one content block");
    }
    (Some(bounds), confidence, accepted_trims)
}

#[allow(clippy::too_many_arguments)]
fn build_trim_proposal(
    side: TrimSide,
    current: PixelBounds,
    content: &BinaryImage,
    component_map: &ComponentMap,
    blocks: &[BlockStats],
    component_blocks: &[usize],
    active: &[bool],
    text_mask: &BinaryImage,
    garbage_influence: &InfluenceMap,
    calibration: PageCalibration,
) -> Option<TrimProposal> {
    let geometry = build_trim_geometry(side, current, blocks, active, calibration)?;
    let removed_blocks = geometry.removed_blocks;
    let next = geometry.next_bounds;

    let mut content_seeds = BinaryImage::new(content.width(), content.height());
    let mut removed_pixels = Vec::new();
    let mut text_area = 0usize;
    for y in current.top..=current.bottom {
        for x in current.left..=current.right {
            let component = component_map.label_at(x, y) as usize;
            let block = component_blocks.get(component).copied().unwrap_or(0);
            if content.get(x, y) && block != 0 && active[block] {
                if removed_blocks[block] {
                    removed_pixels.push((x, y));
                    text_area += usize::from(text_mask.get(x, y));
                } else {
                    content_seeds.set(x, y, true);
                }
            }
        }
    }
    if removed_pixels.is_empty() || content_seeds.count_black() == 0 {
        return None;
    }
    let content_influence = squared_euclidean_distance(&content_seeds);
    let mut content_distance_sum = 0.0;
    let mut garbage_distance_sum = 0.0;
    for (x, y) in removed_pixels {
        content_distance_sum += f64::from(content_influence[y * content.width() + x]).sqrt();
        garbage_distance_sum += f64::from(garbage_influence.squared_distance_at(x, y)).sqrt();
    }
    let score = content_distance_sum / (content_distance_sum + garbage_distance_sum).max(1.0);
    let threshold = trimming_bias(side, text_area, calibration.content_text_bias_area_cap());
    Some(TrimProposal {
        side,
        removed_blocks,
        next_bounds: next,
        score,
        threshold,
        content_distance_sum,
        garbage_distance_sum,
    })
}

fn build_trim_geometry(
    side: TrimSide,
    current: PixelBounds,
    blocks: &[BlockStats],
    active: &[bool],
    calibration: PageCalibration,
) -> Option<TrimGeometry> {
    let mut removed_blocks = vec![false; blocks.len()];
    for (label, block) in blocks.iter().enumerate() {
        if !active[label] {
            continue;
        }
        let touches = match side {
            TrimSide::Left => block.left == current.left,
            TrimSide::Top => block.top == current.top,
            TrimSide::Right => block.right == current.right,
            TrimSide::Bottom => block.bottom == current.bottom,
        };
        removed_blocks[label] = touches && !block.protected(calibration);
    }
    if !removed_blocks.iter().any(|&remove| remove) {
        return None;
    }
    let remaining_active = active
        .iter()
        .zip(&removed_blocks)
        .map(|(&is_active, &remove)| is_active && !remove)
        .collect::<Vec<_>>();
    let remaining_bounds = bounds_for_active_blocks(blocks, &remaining_active)?;
    let mut next = current;
    match side {
        TrimSide::Left => next.left = remaining_bounds.left,
        TrimSide::Top => next.top = remaining_bounds.top,
        TrimSide::Right => next.right = remaining_bounds.right,
        TrimSide::Bottom => next.bottom = remaining_bounds.bottom,
    }
    let thickness = side.strip_thickness(current, next);
    if thickness == 0 {
        return None;
    }
    let removed_area = blocks
        .iter()
        .enumerate()
        .filter(|(label, _)| removed_blocks[*label])
        .map(|(_, block)| block.ink_area)
        .sum::<usize>();
    let remaining_area = blocks
        .iter()
        .enumerate()
        .filter(|(label, _)| remaining_active[*label])
        .map(|(_, block)| block.ink_area)
        .sum::<usize>();
    let minimum_strip = calibration.content_minimum_band_rows();
    if thickness >= minimum_strip && removed_area as f64 > 0.3 * remaining_area as f64 {
        return None;
    }
    let (minimum_width, minimum_height, narrow_width) = calibration.content_trim_geometry();
    if next.width() < minimum_width
        || next.height() < minimum_height
        || (next.width() < narrow_width && next.height() > next.width().saturating_mul(20))
    {
        return None;
    }

    Some(TrimGeometry {
        removed_blocks,
        next_bounds: next,
    })
}

fn garbage_influence(width: usize, height: usize, labels: &[u32]) -> Option<InfluenceMap> {
    labels
        .iter()
        .any(|&label| label != 0)
        .then(|| InfluenceMap::from_seed_labels(width, height, labels))
}

fn trimming_bias(side: TrimSide, text_area: usize, text_area_cap: usize) -> f64 {
    let (without_text, with_text) = match side {
        TrimSide::Top | TrimSide::Bottom => (0.4, 0.5),
        TrimSide::Left | TrimSide::Right => (0.5, 0.65),
    };
    let capped = text_area.min(text_area_cap) as f64;
    let increase = (capped + 1.0).ln() / (text_area_cap.max(1) as f64 + 1.0).ln();
    without_text + (with_text - without_text) * increase
}

fn mark_removed_strip(
    labels: &mut [u32],
    width: usize,
    previous: PixelBounds,
    next: PixelBounds,
    side: TrimSide,
    protected: &BinaryImage,
) {
    let (left, top, right, bottom) = match side {
        TrimSide::Left => (previous.left, previous.top, next.left - 1, previous.bottom),
        TrimSide::Top => (previous.left, previous.top, previous.right, next.top - 1),
        TrimSide::Right => (
            next.right + 1,
            previous.top,
            previous.right,
            previous.bottom,
        ),
        TrimSide::Bottom => (
            previous.left,
            next.bottom + 1,
            previous.right,
            previous.bottom,
        ),
    };
    match side {
        TrimSide::Left => {
            for y in top..=bottom {
                for x in left..=right {
                    if protected.get(x, y) {
                        break;
                    }
                    labels[y * width + x] = REMOVED_GARBAGE;
                }
            }
        }
        TrimSide::Top => {
            for x in left..=right {
                for y in top..=bottom {
                    if protected.get(x, y) {
                        break;
                    }
                    labels[y * width + x] = REMOVED_GARBAGE;
                }
            }
        }
        TrimSide::Right => {
            for y in top..=bottom {
                for x in (left..=right).rev() {
                    if protected.get(x, y) {
                        break;
                    }
                    labels[y * width + x] = REMOVED_GARBAGE;
                }
            }
        }
        TrimSide::Bottom => {
            for x in left..=right {
                for y in (top..=bottom).rev() {
                    if protected.get(x, y) {
                        break;
                    }
                    labels[y * width + x] = REMOVED_GARBAGE;
                }
            }
        }
    }
}

fn bounds_for_active_blocks(blocks: &[BlockStats], active: &[bool]) -> Option<PixelBounds> {
    blocks
        .iter()
        .zip(active)
        .filter(|(block, is_active)| **is_active && block.initialized)
        .fold(None, |bounds: Option<PixelBounds>, (block, _)| {
            Some(match bounds {
                None => PixelBounds {
                    left: block.left,
                    top: block.top,
                    right: block.right,
                    bottom: block.bottom,
                },
                Some(bounds) => PixelBounds {
                    left: bounds.left.min(block.left),
                    top: bounds.top.min(block.top),
                    right: bounds.right.max(block.right),
                    bottom: bounds.bottom.max(block.bottom),
                },
            })
        })
}

fn binary_bounds(image: &BinaryImage) -> Option<PixelBounds> {
    let mut bounds: Option<PixelBounds> = None;
    for y in 0..image.height() {
        for x in 0..image.width() {
            if !image.get(x, y) {
                continue;
            }
            bounds = Some(match bounds {
                None => PixelBounds {
                    left: x,
                    top: y,
                    right: x,
                    bottom: y,
                },
                Some(bounds) => PixelBounds {
                    left: bounds.left.min(x),
                    top: bounds.top.min(y),
                    right: bounds.right.max(x),
                    bottom: bounds.bottom.max(y),
                },
            });
        }
    }
    bounds
}

fn block_is_supported_outlier(
    block: &BlockStats,
    dominant: &BlockStats,
    calibration: PageCalibration,
) -> bool {
    let x_gap = axis_gap(block.left, block.right, dominant.left, dominant.right);
    let y_gap = axis_gap(block.top, block.bottom, dominant.top, dominant.bottom);
    let x_overlaps = x_gap == 0;
    let y_overlaps = y_gap == 0;
    let (vertical_gap, horizontal_gap) = calibration.content_block_gaps();
    (x_overlaps && y_gap <= vertical_gap) || (y_overlaps && x_gap <= horizontal_gap)
}

fn axis_gap(first_start: usize, first_end: usize, second_start: usize, second_end: usize) -> usize {
    if first_end < second_start {
        second_start - first_end - 1
    } else if second_end < first_start {
        first_start - second_end - 1
    } else {
        0
    }
}

fn grayscale_structure_evidence(image: &GrayImage, component: &Component) -> bool {
    let left = component.left.saturating_sub(2);
    let top = component.top.saturating_sub(2);
    let right = (component.right + 2).min(image.width() - 1);
    let bottom = (component.bottom + 2).min(image.height() - 1);
    let area = (right - left + 1).saturating_mul(bottom - top + 1);
    if area < 64 {
        return false;
    }
    let mut midtones = 0usize;
    let mut edges = 0usize;
    let mut samples = 0usize;
    for y in top..=bottom {
        for x in left..=right {
            let value = image.get(x, y);
            midtones += usize::from((40..=224).contains(&value));
            if x > left {
                edges += usize::from(value.abs_diff(image.get(x - 1, y)) >= 24);
            }
            if y > top {
                edges += usize::from(value.abs_diff(image.get(x, y - 1)) >= 24);
            }
            samples += 1;
        }
    }
    let midtone_fraction = midtones as f64 / samples.max(1) as f64;
    let edge_fraction = edges as f64 / samples.saturating_mul(2).max(1) as f64;
    (midtone_fraction >= 0.04 && edge_fraction >= 0.03) || edge_fraction >= 0.12
}

pub fn content_with_margins(
    source: &GrayImage,
    dpi: f64,
    content: Option<Rect>,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
) -> ContentResult {
    content_with_margins_for_dimensions(
        source.width(),
        source.height(),
        dpi,
        content,
        margins_mm,
        margins_pixels,
    )
}

pub(crate) fn content_with_margins_for_dimensions(
    width: usize,
    height: usize,
    dpi: f64,
    content: Option<Rect>,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
) -> ContentResult {
    let margins = margins_pixels.unwrap_or_else(|| {
        margins_mm
            .unwrap_or([0.0; 4])
            .map(|millimeters| millimeters * dpi / 25.4)
    });
    let base = content.unwrap_or(Rect::new(0.0, 0.0, width as f64, height as f64));
    let expanded = base.expand(margins[0], margins[1], margins[2], margins[3]);
    // Cropping is a selection, not a geometric transform. Fractional
    // millimetre margins previously made an otherwise unrotated raster pass
    // through subpixel interpolation (5 mm at 100 DPI starts at .685 px),
    // changing every antialiased glyph before it was placed back on the
    // matched canvas. Round outward so the requested margin is never reduced
    // and integer-aligned scans retain their exact sample grid.
    // Margins are output paper, not merely more source pixels to retain. Let
    // the crop extend beyond the scanned sheet so the inverse renderer fills
    // the uncovered area with white. Clamping here silently erased a requested
    // margin whenever detected content reached an edge (most visibly on book
    // covers). Callers that keep intrinsic margins retain this complete padded
    // raster. Matched-canvas callers intentionally omit crop-time margins and
    // let final placement own them; lossless assembly represents the same
    // outward rectangle directly in PDF user space.
    let left = expanded.x.floor();
    let top = expanded.y.floor();
    let right = expanded.right().ceil();
    let bottom = expanded.bottom().ceil();
    let output_rect = Rect::new(left, top, right - left, bottom - top);
    ContentResult {
        content,
        output_rect,
        margins,
        diagnostics: None,
    }
}

/// Computes the content crop using checked floating-point arithmetic.
///
/// This is the native rendering path: callers must reject an overflow rather
/// than allowing Rust's saturating float-to-integer cast to turn it into a
/// tiny, apparently valid raster.
pub(crate) fn checked_content_with_margins_for_dimensions(
    width: usize,
    height: usize,
    dpi: f64,
    content: Option<Rect>,
    margins_mm: Option<[f64; 4]>,
    margins_pixels: Option<[f64; 4]>,
) -> Result<ContentResult, String> {
    let margins = match margins_pixels {
        Some(margins) => margins,
        None => margins_mm
            .unwrap_or([0.0; 4])
            .map(|millimeters| millimeters * dpi / 25.4),
    };
    if !dpi.is_finite()
        || !margins
            .into_iter()
            .all(|margin| margin.is_finite() && margin >= 0.0)
    {
        return Err("Derived margin geometry must be finite and nonnegative".into());
    }
    let base = content.unwrap_or(Rect::new(0.0, 0.0, width as f64, height as f64));
    if ![base.x, base.y, base.width, base.height]
        .into_iter()
        .all(f64::is_finite)
    {
        return Err("Derived content geometry must be finite".into());
    }
    let left = base.x - margins[0];
    let top = base.y - margins[1];
    let right = base.x + base.width + margins[2];
    let bottom = base.y + base.height + margins[3];
    if ![left, top, right, bottom].into_iter().all(f64::is_finite) {
        return Err("Derived content geometry must be finite".into());
    }
    let output_rect = Rect::new(
        left.floor(),
        top.floor(),
        right.ceil() - left.floor(),
        bottom.ceil() - top.floor(),
    );
    if !output_rect.width.is_finite()
        || !output_rect.height.is_finite()
        || output_rect.width <= 0.0
        || output_rect.height <= 0.0
    {
        return Err("Derived content geometry must be positive and finite".into());
    }
    Ok(ContentResult {
        content,
        output_rect,
        margins,
        diagnostics: None,
    })
}

#[cfg(test)]
mod tests {
    /// Developer diagnostic: run content detection on an external page image.
    /// `EVB_CONTENT_IMAGE=/path.png
    /// cargo test -p evb-scan-cleanup dump_external_content_box -- --ignored --nocapture`
    #[test]
    #[ignore = "requires EVB_CONTENT_IMAGE"]
    fn dump_external_content_box() {
        let path = std::env::var("EVB_CONTENT_IMAGE").unwrap();
        let image =
            crate::io::raster::read_image(std::path::Path::new(&path), 40_000_000, 10_000).unwrap();
        let dpi = std::env::var("EVB_CONTENT_DPI")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(360.0);
        let result = detect_content_and_margins(&image.gray, dpi, Some([5.0; 4]), None);
        eprintln!("content result: {:?}", result.content);
    }

    use super::*;
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };

    const CENSUS_NEIGHBORHOOD: (usize, usize) = (40, 24);

    #[test]
    fn physical_margins_expand_outward_to_an_integer_raster_crop() {
        let image = GrayImage::new(850, 1_100, 255);
        let result = content_with_margins(
            &image,
            100.0,
            Some(Rect::new(56.0, 46.0, 745.0, 947.0)),
            Some([5.0; 4]),
            None,
        );

        assert_eq!(result.output_rect, Rect::new(36.0, 26.0, 785.0, 987.0));
        assert_eq!(result.margins, [5.0 / 25.4 * 100.0; 4]);
    }

    #[test]
    fn physical_margins_add_output_paper_beyond_page_edges() {
        let image = GrayImage::new(2_199, 3_279, 255);
        let result = content_with_margins(
            &image,
            400.0,
            Some(Rect::new(50.64, 34.66, 2_097.71, 3_145.71)),
            Some([5.0; 4]),
            None,
        );

        assert_eq!(
            result.output_rect,
            Rect::new(-29.0, -45.0, 2_257.0, 3_305.0)
        );
        assert!(result.output_rect.x < 0.0);
        assert!(result.output_rect.y < 0.0);
        assert!(result.output_rect.right() > image.width() as f64);
    }

    #[test]
    fn checked_margin_geometry_rejects_mm_to_pixel_overflow() {
        let error = checked_content_with_margins_for_dimensions(
            10,
            10,
            300.0,
            Some(Rect::new(0.0, 0.0, 10.0, 10.0)),
            Some([1e308; 4]),
            None,
        )
        .unwrap_err();
        assert!(error.contains("finite"));
    }

    fn component_census(columns: usize, rows: usize) -> Vec<Component> {
        let mut components = Vec::with_capacity(columns * rows);
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut jitter = |bound: u64| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((state >> 33) % bound) as usize
        };
        for row in 0..rows {
            for column in 0..columns {
                let left = column * 9 + jitter(5);
                let top = row * 7 + jitter(4);
                components.push(Component {
                    label: components.len() as u32 + 1,
                    area: 4,
                    left,
                    top,
                    right: left + 1,
                    bottom: top + 1,
                });
            }
        }
        components
    }

    fn all_pairs_neighbor_count(components: &[Component], index: usize) -> usize {
        let component = &components[index];
        let (center_x, center_y) = component_center(component);
        components
            .iter()
            .filter(|other| {
                if other.label == component.label {
                    return false;
                }
                let (other_x, other_y) = component_center(other);
                center_x.abs_diff(other_x) <= CENSUS_NEIGHBORHOOD.0
                    && center_y.abs_diff(other_y) <= CENSUS_NEIGHBORHOOD.1
            })
            .count()
    }

    #[test]
    fn grid_neighbor_counts_match_the_all_pairs_scan() {
        let components = component_census(102, 102);
        assert!(components.len() > 10_000);
        let grid =
            ComponentCenterGrid::build(&components, CENSUS_NEIGHBORHOOD.0, CENSUS_NEIGHBORHOOD.1);
        for index in 0..components.len() {
            assert_eq!(
                grid.neighbor_count(&components, index),
                all_pairs_neighbor_count(&components, index),
                "component {index} at {:?}",
                component_center(&components[index])
            );
        }
    }

    #[test]
    fn grid_neighbor_counts_survive_degenerate_geometries() {
        let empty: Vec<Component> = Vec::new();
        ComponentCenterGrid::build(&empty, 40, 24);

        let stacked = vec![
            Component {
                label: 1,
                area: 1,
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            Component {
                label: 2,
                area: 1,
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            Component {
                label: 3,
                area: 1,
                left: 4_000,
                top: 3_000,
                right: 4_000,
                bottom: 3_000,
            },
        ];
        for (neighborhood_x, neighborhood_y) in [(0usize, 0usize), (1, 1), (40, 24)] {
            let grid = ComponentCenterGrid::build(&stacked, neighborhood_x, neighborhood_y);
            assert_eq!(grid.neighbor_count(&stacked, 0), 1);
            assert_eq!(grid.neighbor_count(&stacked, 1), 1);
            assert_eq!(grid.neighbor_count(&stacked, 2), 0);
        }
    }

    #[test]
    fn a_dense_component_census_does_not_pay_an_all_pairs_neighbor_scan() {
        const DEADLINE: Duration = Duration::from_secs(60);
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let components = component_census(500, 400);
            let started = Instant::now();
            let grid = ComponentCenterGrid::build(
                &components,
                CENSUS_NEIGHBORHOOD.0,
                CENSUS_NEIGHBORHOOD.1,
            );
            let mut nearby = 0usize;
            for index in 0..components.len() {
                nearby += grid.neighbor_count(&components, index);
            }
            let _ = sender.send((components.len(), nearby, started.elapsed()));
        });
        let (count, nearby, elapsed) = receiver.recv_timeout(DEADLINE).unwrap_or_else(|_| {
            panic!(
                "counting neighbours for 200 000 components did not finish within {DEADLINE:?}: \
                 the query is scanning every component for every component \
                 (4 x 10^10 centre comparisons) instead of a 3x3 block of centre-bucketed cells"
            )
        });
        assert!(nearby > count * 10, "the census produced no neighbours");
        assert!(
            elapsed < DEADLINE,
            "{count} components took {elapsed:?} to count neighbours"
        );
    }

    fn draw_glyph_line(
        image: &mut GrayImage,
        left: usize,
        top: usize,
        glyphs: usize,
        glyph_width: usize,
        glyph_height: usize,
        gap: usize,
    ) {
        for glyph in 0..glyphs {
            let glyph_left = left + glyph * (glyph_width + gap);
            for y in top..top + glyph_height {
                for x in glyph_left..glyph_left + glyph_width {
                    if x == glyph_left
                        || x + 1 == glyph_left + glyph_width
                        || y == top
                        || y + 1 == top + glyph_height
                    {
                        image.set(x, y, 24);
                    }
                }
            }
        }
    }

    fn direct_trim_fixture(
        artifact_top: usize,
        artifact_bottom: usize,
    ) -> (Option<PixelBounds>, Vec<ContentAcceptedTrim>) {
        let (bounds, _, accepted_trims) =
            direct_trim_fixture_with_garbage(artifact_top, artifact_bottom, true);
        (bounds, accepted_trims)
    }

    fn direct_trim_fixture_with_garbage(
        artifact_top: usize,
        artifact_bottom: usize,
        artifact_is_garbage: bool,
    ) -> (Option<PixelBounds>, [f64; 4], Vec<ContentAcceptedTrim>) {
        direct_trim_fixture_with_evidence(artifact_top, artifact_bottom, artifact_is_garbage, 0)
    }

    fn direct_trim_fixture_with_evidence(
        artifact_top: usize,
        artifact_bottom: usize,
        artifact_is_garbage: bool,
        picture_mask_overlap_pixels: usize,
    ) -> (Option<PixelBounds>, [f64; 4], Vec<ContentAcceptedTrim>) {
        let width = 200;
        let height = 200;
        let mut content = BinaryImage::new(width, height);
        for y in artifact_top..=artifact_bottom {
            for x in 20..31 {
                content.set(x, y, true);
            }
        }
        for y in 80..161 {
            for x in 60..141 {
                content.set(x, y, true);
            }
        }
        let component_map = ComponentMap::from_binary(&content);
        let artifact_label = component_map.label_at(20, artifact_top) as usize;
        let body_label = component_map.label_at(60, 80) as usize;
        let artifact = &component_map.components()[artifact_label - 1];
        let body = &component_map.components()[body_label - 1];
        let mut blocks = vec![BlockStats::default(); component_map.components().len() + 1];
        blocks[artifact_label] = BlockStats {
            component_count: 1,
            ink_area: artifact.area,
            left: artifact.left,
            top: artifact.top,
            right: artifact.right,
            bottom: artifact.bottom,
            initialized: true,
            picture_mask_overlap_pixels,
            labels: vec![artifact.label],
            ..BlockStats::default()
        };
        blocks[body_label] = BlockStats {
            component_count: 1,
            ink_area: body.area,
            left: body.left,
            top: body.top,
            right: body.right,
            bottom: body.bottom,
            initialized: true,
            labels: vec![body.label],
            ..BlockStats::default()
        };
        let mut component_blocks = vec![0usize; component_map.components().len() + 1];
        component_blocks[artifact_label] = artifact_label;
        component_blocks[body_label] = body_label;
        let mut garbage_labels = vec![0u32; width * height];
        let (garbage_rows, garbage_columns) = if artifact_is_garbage {
            (artifact_top..=artifact_bottom, 20..31)
        } else {
            // Garbage far from the band under test: its distance term is what
            // holds the trim score below the side's threshold.
            (190..=199, 160..200)
        };
        for y in garbage_rows {
            for x in garbage_columns.clone() {
                garbage_labels[y * width + x] = HORIZONTAL_GARBAGE;
            }
        }
        let text_mask = BinaryImage::new(width, height);
        let protected_mask = BinaryImage::new(width, height);
        let calibration =
            PageCalibration::estimate_from_binary(&content, 150.0, CalibrationConfig::default());
        trim_content_bounds(
            &content,
            &component_map,
            &blocks,
            &component_blocks,
            &text_mask,
            &protected_mask,
            garbage_labels,
            calibration,
        )
    }

    fn iou(left: Rect, right: Rect) -> f64 {
        let x0 = left.x.max(right.x);
        let y0 = left.y.max(right.y);
        let x1 = left.right().min(right.right());
        let y1 = left.bottom().min(right.bottom());
        let intersection = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
        intersection / (left.width * left.height + right.width * right.height - intersection)
    }

    #[test]
    fn recursively_splits_balanced_histogram_valleys() {
        let histogram = [8, 9, 8, 9, 8, 9, 0, 0, 0, 10, 9, 10, 9, 10, 9];
        let mut bands = Vec::new();
        split_histogram_bands(&histogram, 0, histogram.len(), 6, &mut bands);
        assert_eq!(bands, vec![(0, 6), (6, 15)]);

        let unbalanced = [1, 1, 1, 1, 1, 1, 0, 0, 0, 30, 30, 30, 30, 30, 30];
        bands.clear();
        split_histogram_bands(&unbalanced, 0, unbalanced.len(), 6, &mut bands);
        assert_eq!(bands, vec![(0, unbalanced.len())]);
    }
    #[test]
    fn recovers_synthetic_content_box_and_ignores_border_shadow() {
        let mut image = GrayImage::new(240, 180, 238);
        for x in 0..240 {
            image.set(x, 3, 30);
            image.set(x, 4, 30);
        }
        for y in (40..140).step_by(14) {
            for word in 0..7 {
                let left = 42 + word * 23;
                for x in left..(left + 18).min(198) {
                    image.set(x, y, 20);
                    image.set(x, y + 1, 20);
                    image.set(x, y + 2, 20);
                }
            }
        }
        image.set(48, 33, 10);
        image.set(49, 33, 10);
        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let expected = Rect::new(42.0, 33.0, 156.0, 96.0);
        assert!(
            iou(result.content.unwrap(), expected) > 0.82,
            "actual={:?}",
            result.content
        );
    }

    #[test]
    fn sedm_scoring_rejects_isolated_scan_bed_dirt_without_losing_marginalia() {
        let mut image = GrayImage::new(320, 220, 245);
        for y in (55..170).step_by(15) {
            for x in 72..245 {
                if x % 28 < 20 {
                    image.set(x, y, 20);
                    image.set(x, y + 1, 20);
                    image.set(x, y + 2, 20);
                }
            }
        }
        for y in 80..100 {
            for x in 18..21 {
                image.set(x, y, 25);
            }
        }
        for y in 190..205 {
            for x in 290..305 {
                image.set(x, y, 5);
            }
        }
        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(bounds.x <= 21.0, "marginalia was lost: {bounds:?}");
        assert!(
            bounds.right() < 270.0,
            "isolated dirt expanded crop: {bounds:?}"
        );
    }

    #[test]
    fn competing_fields_trim_a_remote_long_stain_strip() {
        let mut image = GrayImage::new(420, 320, 245);
        for y in (70..245).step_by(16) {
            for x in 92..300 {
                if x % 31 < 20 {
                    for stroke_y in y..y + 4 {
                        image.set(x, stroke_y, 20);
                    }
                }
            }
        }
        for y in 55..275 {
            for x in 404..412 {
                image.set(x, y, 18);
            }
        }
        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(bounds.right() < 350.0, "remote stain survived: {bounds:?}");
    }

    #[test]
    fn grayscale_evidence_preserves_table_rules_and_photo_blocks() {
        let mut image = GrayImage::new(360, 260, 245);
        for y in (55..155).step_by(14) {
            for x in 72..245 {
                if x % 30 < 21 {
                    image.set(x, y, 18);
                    image.set(x, y + 1, 18);
                    image.set(x, y + 2, 18);
                }
            }
        }
        for x in 48..312 {
            image.set(x, 205, 35);
            image.set(x, 206, 35);
        }
        for y in 76..143 {
            for x in 282..337 {
                image.set(x, y, if (x / 4 + y / 4) % 2 == 0 { 58 } else { 178 });
            }
        }
        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(bounds.right() >= 335.0, "photo block was lost: {bounds:?}");
        assert!(bounds.bottom() >= 206.0, "table rule was lost: {bounds:?}");
    }

    #[test]
    fn display_heading_is_hard_protected_above_body_text() {
        let mut image = GrayImage::new(520, 560, 245);
        for x in 30..490 {
            image.set(x, 24, 18);
            image.set(x, 25, 18);
        }
        draw_glyph_line(&mut image, 196, 116, 8, 11, 24, 6);
        for row in 0..14 {
            let top = 210 + row * 19;
            draw_glyph_line(&mut image, 62, top, 13, 6, 10, 4);
            draw_glyph_line(&mut image, 292, top, 13, 6, 10, 4);
        }

        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(bounds.y <= 116.0, "display heading was trimmed: {bounds:?}");
        let diagnostics = result.diagnostics.unwrap();
        assert!(
            diagnostics
                .protected_blocks
                .iter()
                .any(|block| block.heading_evidence && block.bounds.y_px <= 116),
            "heading evidence was not recorded: {diagnostics:?}"
        );
    }

    #[test]
    fn running_head_is_protected_by_the_page_frame_policy() {
        let mut image = GrayImage::new(700, 1000, 200);
        for y in 40..52 {
            for x in 60..75 {
                image.set(x, y, 20);
            }
            for x in 560..640 {
                image.set(x, y, 20);
            }
        }
        for y in 58..61 {
            for x in 60..641 {
                image.set(x, y, 20);
            }
        }
        for y in (120..900).step_by(18) {
            for line_y in y..y + 2 {
                for x in 60..641 {
                    image.set(x, line_y, 20);
                }
            }
        }

        let result = detect_content_and_margins(&image, 120.0, None, Some([0.0; 4]));
        let bounds = result.content.expect("running head and body are content");
        assert!(bounds.y <= 45.0, "running head was trimmed: {bounds:?}");
        let diagnostics = result.diagnostics.expect("content diagnostics");
        assert!(
            diagnostics
                .accepted_trims
                .iter()
                .flat_map(|trim| trim.removed_blocks.iter())
                .all(|block| block.bounds.y_px > 60),
            "the in-frame running head entered an accepted trim: {diagnostics:?}"
        );
    }

    #[test]
    fn isolated_running_head_and_underline_far_above_body_are_content() {
        let mut image = GrayImage::new(700, 1_000, 236);
        draw_glyph_line(&mut image, 62, 92, 18, 6, 11, 4);
        for x in 60..641 {
            image.set(x, 124, 22);
            image.set(x, 125, 22);
        }
        for row in 0..22 {
            let top = 420 + row * 21;
            draw_glyph_line(&mut image, 62, top, 15, 6, 11, 4);
            draw_glyph_line(&mut image, 360, top, 15, 6, 11, 4);
        }

        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result
            .content
            .expect("header, underline, and body are content");

        assert!(
            bounds.y <= 92.0,
            "isolated running head was trimmed: {bounds:?}"
        );
        assert!(
            bounds.right() >= 640.0,
            "running-head underline was trimmed: {bounds:?}"
        );
    }

    /// A bilevel scan of a bound thesis: the scanner bed lies along the top
    /// and the outer edge far deeper than the 1/40 edge zone, its outermost
    /// row is lighter, and a stippled fringe leads to the paper.
    fn deep_scanner_bed_page() -> GrayImage {
        let mut image = GrayImage::new(700, 1_000, 236);
        for y in 0..70 {
            for x in 0..700 {
                if y > 0 || x % 2 == 0 {
                    image.set(x, y, 0);
                }
            }
        }
        for y in 0..1_000 {
            for x in 610..700 {
                image.set(x, y, 0);
            }
        }
        for y in 70..80 {
            for x in 0..610 {
                if (x + y) % 3 == 0 {
                    image.set(x, y, 0);
                }
            }
        }
        for row in 0..22 {
            let top = 200 + row * 21;
            draw_glyph_line(&mut image, 62, top, 15, 6, 11, 4);
            draw_glyph_line(&mut image, 330, top, 15, 6, 11, 4);
        }
        image
    }

    #[test]
    fn a_scanner_bed_deeper_than_the_edge_zone_is_not_content() {
        let result =
            detect_content_and_margins(&deep_scanner_bed_page(), 150.0, None, Some([0.0; 4]));
        let bounds = result.content.expect("the body is content");

        assert!(
            bounds.y >= 80.0,
            "scanner bed survived above the body: {bounds:?}"
        );
        assert!(
            bounds.right() <= 610.0,
            "scanner bed survived beside the body: {bounds:?}"
        );
        assert!(
            bounds.y <= 200.0 && bounds.x <= 62.0,
            "the body was trimmed: {bounds:?}"
        );
    }

    #[test]
    fn scanner_noise_band_above_running_head_stays_excluded() {
        let mut image = GrayImage::new(700, 1_000, 236);
        for y in 0..10 {
            for x in 0..700 {
                image.set(x, y, 18 + ((x + y) % 9) as u8);
            }
        }
        draw_glyph_line(&mut image, 62, 92, 18, 6, 11, 4);
        for x in 60..641 {
            image.set(x, 124, 22);
            image.set(x, 125, 22);
        }
        for row in 0..22 {
            let top = 420 + row * 21;
            draw_glyph_line(&mut image, 62, top, 15, 6, 11, 4);
            draw_glyph_line(&mut image, 360, top, 15, 6, 11, 4);
        }

        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.expect("running head and body are content");

        assert!(bounds.y > 10.0, "scanner-edge band survived: {bounds:?}");
        assert!(
            bounds.y <= 92.0,
            "running head was trimmed with the band: {bounds:?}"
        );
    }

    #[test]
    fn fragmented_gutter_ends_do_not_expand_the_content_box() {
        let mut image = GrayImage::new(600, 800, 242);
        draw_glyph_line(&mut image, 150, 95, 22, 7, 12, 5);
        for row in 0..18 {
            draw_glyph_line(&mut image, 145, 165 + row * 25, 24, 6, 11, 4);
        }
        draw_glyph_line(&mut image, 205, 720, 12, 7, 12, 5);

        // Thresholded gutter texture is not one solid border component. The
        // clipped border mask leaves small fragments that dilation clusters
        // into tall blocks at the two page-frame ends.
        for top in (0..210).step_by(11) {
            let left = 35 + (top / 11 % 5) * 5;
            for y in top..(top + 8).min(image.height()) {
                for x in left..left + 4 {
                    image.set(x, y, 18);
                }
            }
        }
        for top in (748..800).step_by(10) {
            let left = 32 + (top / 10 % 6) * 5;
            for y in top..(top + 8).min(image.height()) {
                for x in left..left + 4 {
                    image.set(x, y, 18);
                }
            }
        }

        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 40.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let bounds = detect_content_and_margins_calibrated(
            &image,
            None,
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        )
        .content
        .expect("authored text is content");
        assert!(bounds.x >= 140.0, "gutter fragments survived: {bounds:?}");
        assert!(
            bounds.y >= 90.0,
            "top gutter fragments survived: {bounds:?}"
        );
        assert!(
            bounds.bottom() <= 735.0,
            "bottom gutter fragments survived: {bounds:?}"
        );
    }

    fn footnote_page_below_a_fold_shadow() -> GrayImage {
        let mut image = GrayImage::new(1_096, 1_626, 244);
        for row in 0..25 {
            draw_glyph_line(&mut image, 400, 312 + row * 31, 60, 4, 12, 7);
            draw_glyph_line(&mut image, 125, 312 + row * 31, 18, 4, 12, 7);
        }
        for x in 120..522 {
            if x % 3 != 0 {
                image.set(x, 1_484, 70);
            }
        }
        draw_glyph_line(&mut image, 125, 1_500, 33, 2, 6, 7);
        draw_glyph_line(&mut image, 125, 1_526, 33, 2, 6, 7);
        for y in 0..image.height() {
            for x in 0..16 {
                let shading = (40 + x * 9 + (y % 7) * 3).min(244);
                image.set(x, y, shading as u8);
            }
        }
        image
    }

    #[test]
    fn footnotes_near_the_page_edge_survive_a_full_page_of_body_text() {
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 40.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let image = footnote_page_below_a_fold_shadow();
        let result = detect_content_and_margins_calibrated(
            &image,
            None,
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        );
        let bounds = result.content.expect("authored text is content");
        assert!(
            bounds.bottom() >= 1_532.0,
            "footnote block below the body text was cropped away: {bounds:?}"
        );
        assert!(
            bounds.x >= 100.0,
            "the fold shadow was taken for content: {bounds:?}"
        );
        let diagnostics = result.diagnostics.expect("analysis reports diagnostics");
        let text_bounds = diagnostics
            .text_mask
            .bounds
            .expect("text lines were detected");
        assert!(
            text_bounds.y_px + text_bounds.height_px >= 1_532,
            "the footnote lines never earned text evidence: {text_bounds:?}",
        );
    }

    #[test]
    fn a_leaf_carrying_only_a_fold_shadow_yields_no_crop_box() {
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 40.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let mut image = GrayImage::new(600, 800, 244);
        for y in 0..image.height() {
            for x in 0..18 {
                let shading = (26 + x * 11 + (y % 5) * 4).min(244);
                image.set(x, y, shading as u8);
            }
        }
        for speck in 0..12 {
            let x = 120 + speck * 34;
            let y = 90 + (speck % 5) * 130;
            image.set(x, y, 60);
            image.set(x + 1, y, 70);
        }
        for y in (72..744).step_by(28) {
            for x in 24..28 {
                image.set(x, y, 220);
                image.set(x, y + 1, 218);
            }
        }

        let content = detect_content_and_margins_calibrated(
            &image,
            None,
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        )
        .content;
        assert!(
            content.is_none(),
            "a blank leaf's fold shadow was published as a content box: {content:?}",
        );
    }

    #[test]
    fn an_edge_hugging_sliver_is_not_a_content_box() {
        assert!(is_edge_sliver(
            PixelBounds {
                left: 0,
                top: 40,
                right: 14,
                bottom: 2_060,
            },
            2_238,
            3_252,
        ));
        assert!(is_edge_sliver(
            PixelBounds {
                left: 2_200,
                top: 40,
                right: 2_237,
                bottom: 3_000,
            },
            2_238,
            3_252,
        ));
        assert!(!is_edge_sliver(
            PixelBounds {
                left: 0,
                top: 40,
                right: 400,
                bottom: 3_000,
            },
            2_238,
            3_252,
        ));
    }

    #[test]
    fn crop_evidence_requires_page_ink_rather_than_edge_dirt() {
        // Measured on the calibration book's page 3 verso: a blank leaf's fold
        // shadow reaches 0.22 per mille of text ink and 0.47 of retained ink.
        assert!(!crop_evidence_supports_bounds(415, 872, None, 1_138, 1_626));
        // A page of prose on the same leaf.
        assert!(crop_evidence_supports_bounds(
            88_489, 90_767, None, 1_138, 1_626
        ));
        // Line art never enters the text mask; retained ink answers for it.
        assert!(crop_evidence_supports_bounds(0, 51_128, None, 700, 1_000));
        let mut picture = BinaryImage::new(2_238, 3_252);
        for y in 500..1_500 {
            for x in 400..1_400 {
                picture.set(x, y, true);
            }
        }
        assert!(crop_evidence_supports_bounds(
            0,
            0,
            Some(&picture),
            2_238,
            3_252
        ));
    }

    #[test]
    fn isolated_two_glyph_folio_earns_a_sparse_content_box() {
        let mut image = GrayImage::new(360, 480, 246);
        for left in [170, 177] {
            for y in 445..452 {
                for x in left..left + 2 {
                    image.set(x, y, 80);
                }
            }
            for y in 445..447 {
                for x in left..left + 5 {
                    image.set(x, y, 80);
                }
            }
            for x in left..left + 4 {
                image.set(x, 448, 80);
            }
        }

        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let content = result.content.expect("the two-glyph folio is page content");
        assert!(
            content.x <= 170.0,
            "left folio stroke was clipped: {content:?}"
        );
        assert!(
            content.y <= 445.0,
            "top folio stroke was clipped: {content:?}"
        );
        assert!(
            content.right() >= 181.0,
            "folio right edge was clipped: {content:?}"
        );
        assert!(
            content.bottom() >= 452.0,
            "folio bottom edge was clipped: {content:?}"
        );
    }

    #[test]
    fn sparse_speck_groups_never_earn_a_content_box() {
        type SpeckCase<'a> = (&'a str, usize, usize, &'a [(usize, usize)]);
        let cases: &[SpeckCase<'_>] = &[
            ("two-central-5x6", 5, 6, &[(170, 230), (180, 230)]),
            ("three-corner-4x4", 4, 4, &[(8, 8), (16, 8), (24, 8)]),
            (
                "four-fold-5x6",
                5,
                6,
                &[(330, 180), (338, 190), (330, 205), (338, 215)],
            ),
            (
                "four-mixed-5x6",
                5,
                6,
                &[(8, 8), (170, 230), (338, 120), (338, 440)],
            ),
        ];
        for &(name, speck_width, speck_height, positions) in cases {
            let mut image = GrayImage::new(360, 480, 246);
            for &(left, top) in positions {
                for y in top..top + speck_height {
                    for x in left..left + speck_width {
                        image.set(x, y, 70);
                    }
                }
            }

            let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
            assert_eq!(
                result.content, None,
                "{name} dust produced a crop: {:?}",
                result.content
            );
        }
    }

    /// Paper whose local contrast is high enough to feed the faint-stroke
    /// rescue's row-support profile, as a real scan's grain does.
    fn textured_paper(width: usize, height: usize) -> GrayImage {
        let mut image = GrayImage::new(width, height, 246);
        for y in 0..height {
            for x in 0..width {
                if (x * 29 + y * 17) % 11 == 0 {
                    image.set(x, y, 226);
                }
            }
        }
        image
    }

    fn draw_body_text(image: &mut GrayImage, top: usize, bottom: usize) {
        let mut y = top;
        while y + 14 <= bottom {
            let mut x = 60;
            while x + 4 <= 300 {
                for stroke_y in y..y + 14 {
                    for stroke_x in x..x + 4 {
                        image.set(stroke_x, stroke_y, 40);
                    }
                }
                x += 12;
            }
            y += 24;
        }
    }

    /// Faint marks are only ever rescued through their local contrast, so a
    /// synthetic stroke needs the grain a scan has for the rescue to restore
    /// more than its rim.
    fn draw_faint_marks(
        image: &mut GrayImage,
        left: usize,
        top: usize,
        width: usize,
        height: usize,
        advance: usize,
        columns: usize,
    ) {
        for column in 0..columns {
            let start = left + column * advance;
            for y in top..top + height {
                for x in start..start + width {
                    image.set(x, y, if (x + y) % 2 == 0 { 205 } else { 170 });
                }
            }
        }
    }

    #[test]
    fn a_faint_speck_near_the_text_cannot_raise_the_content_box() {
        let mut image = textured_paper(360, 520);
        draw_body_text(&mut image, 240, 430);
        // Close enough to the body block to qualify as supported marginalia,
        // which is what let this mark set the crop before it was required to
        // survive despeckling.
        for y in 150..153 {
            for x in 200..202 {
                image.set(x, y, 212);
            }
        }

        let content = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]))
            .content
            .expect("body text must produce a content box");

        assert!(
            content.y >= 240.0,
            "a speck the page cleanup discards raised the box top to {}",
            content.y
        );
    }

    #[test]
    fn faint_marks_above_the_text_still_set_the_content_box() {
        let mut image = textured_paper(360, 520);
        draw_body_text(&mut image, 240, 430);
        draw_faint_marks(&mut image, 100, 40, 4, 14, 10, 14);

        let content = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]))
            .content
            .expect("body text must produce a content box");

        assert!(
            content.y <= 40.0,
            "a faint heading the binarizer missed was excluded from the box top: {}",
            content.y
        );
    }

    #[test]
    fn edge_continuation_filter_preserves_glyphs_and_running_furniture() {
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 28.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let dust = BlockStats {
            component_count: 162,
            ink_area: 2_008,
            left: 81,
            top: 0,
            right: 130,
            bottom: 436,
            initialized: true,
            ..BlockStats::default()
        };
        assert_eq!(
            fragmented_edge_continuation_sides(&dust, 1_102, 1_573, calibration,),
            CROP_ARTIFACT_LEFT
        );

        let marginal_text = BlockStats {
            component_count: 18,
            ink_area: 1_440,
            left: 70,
            top: 0,
            right: 128,
            bottom: 210,
            initialized: true,
            ..BlockStats::default()
        };
        assert_eq!(
            fragmented_edge_continuation_sides(&marginal_text, 1_102, 1_573, calibration,),
            0
        );

        let running_furniture = BlockStats {
            component_count: 30,
            ink_area: 600,
            left: 70,
            top: 0,
            right: 850,
            bottom: 28,
            initialized: true,
            ..BlockStats::default()
        };
        assert_eq!(
            fragmented_edge_continuation_sides(&running_furniture, 1_102, 1_573, calibration,),
            0
        );
    }

    #[test]
    fn crop_picture_bounds_reject_frame_rail_without_grayscale_artifact_signal() {
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 12.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let mut picture = BinaryImage::new(400, 600);
        // The residual Luther gutter owner is coherent only at the lower
        // right frame, so the gray candidate pass publishes no fragmented
        // crop-artifact side at all.
        for y in 440..600 {
            for x in 364..400 {
                picture.set(x, y, true);
            }
        }
        // Authored central stamp remains crop-authoritative.
        for y in 220..300 {
            for x in 155..245 {
                picture.set(x, y, true);
            }
        }
        let owner_pixels = picture.count_black();
        assert_eq!(
            crop_qualified_picture_bounds(&picture, 0, calibration),
            Some(PixelBounds {
                left: 155,
                top: 220,
                right: 244,
                bottom: 299,
            })
        );
        assert_eq!(
            picture.count_black(),
            owner_pixels,
            "crop-only qualification mutated semantic picture ownership"
        );

        let mut manual = BinaryImage::new(400, 600);
        for y in 440..600 {
            for x in 364..400 {
                manual.set(x, y, true);
            }
        }
        assert_eq!(
            crop_qualified_picture_bounds_with_authority(&picture, Some(&manual), 0, calibration,),
            Some(PixelBounds {
                left: 155,
                top: 220,
                right: 399,
                bottom: 599,
            }),
            "an explicit Painter2 corner photo must remain crop-authoritative"
        );
    }

    #[test]
    fn sparse_numeric_margin_inside_rejected_picture_rail_stays_in_crop_box() {
        let mut image = GrayImage::new(520, 720, 244);
        for row in 0..14 {
            let top = 150 + row * 34;
            draw_glyph_line(&mut image, 120, top, 22, 5, 14, 5);
            if row % 3 == 0 {
                draw_glyph_line(&mut image, 36, top, 2, 5, 12, 2);
            }
        }

        let mut picture = BinaryImage::new(image.width(), image.height());
        // A full-height outer rail is rejected as crop authority. The small
        // rectangles are the owner’s detached edge islands over the sparse
        // numeric margin column; they must remain rejected as picture, while
        // their underlying glyph ink returns as text content.
        for y in 0..image.height() {
            for x in 0..25 {
                picture.set(x, y, true);
            }
        }
        for row in (0..14).step_by(3) {
            let top = 150 + row * 34;
            for y in top..top + 14 {
                for x in 30..35 {
                    picture.set(x, y, true);
                }
            }
        }
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 14.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let qualification =
            qualify_picture_mask_for_crop_with_authority(&picture, None, 0, calibration);
        assert_eq!(binary_bounds(&qualification.included), None);
        assert!(
            qualification.excluded.get(5, 300),
            "the rail was not rejected"
        );
        let thresholded = threshold_local(
            &image,
            25,
            LocalThreshold::Wolf {
                k: 0.5,
                deviation_floor: 3.0,
                minimum_percentile: 0.01,
                hard_ink: 48,
                hard_paper: 248,
            },
        );
        let restored = restore_structured_text_from_rejected_picture_rail(
            &thresholded,
            &qualification.excluded,
            calibration,
        );
        assert!(
            restored.count_black() > 0,
            "the sparse margin column did not earn structured-text rescue"
        );
        assert!(
            (0..25).all(|x| (0..image.height()).all(|y| !restored.get(x, y))),
            "picture-rail pixels were restored as text"
        );
        assert_eq!(
            structured_text_edge_sides(&qualification.excluded, &restored, calibration),
            CROP_ARTIFACT_LEFT,
            "the crop envelope did not recognize text beside the rejected rail"
        );

        let bounds = detect_content_and_margins_calibrated(
            &image,
            Some(&picture),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        )
        .content
        .expect("body and margin text are content");
        assert!(
            bounds.x <= 36.0,
            "the numeric margin was cropped with the rejected rail: {bounds:?}"
        );
        assert!(bounds.right() >= 335.0, "body text was cropped: {bounds:?}");
    }

    #[test]
    fn structured_edge_authority_requires_perpendicular_locality() {
        let mut excluded = BinaryImage::new(300, 400);
        for y in 260..360 {
            for x in 0..10 {
                excluded.set(x, y, true);
            }
        }
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 3.0,
            x_height_px: 12.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let initial = PixelBounds {
            left: 15,
            top: 40,
            right: 180,
            bottom: 320,
        };

        let mut adjacent_text = BinaryImage::new(300, 400);
        for y in 275..291 {
            for x in 15..23 {
                adjacent_text.set(x, y, true);
            }
        }
        let adjacent_sides = structured_text_edge_sides(&excluded, &adjacent_text, calibration);
        assert_eq!(
            adjacent_sides, CROP_ARTIFACT_LEFT,
            "genuine rail-adjacent text lost its edge authority"
        );
        let mut adjacent_bounds = Some(initial);
        expand_bounds_for_structured_edge_text(
            &mut adjacent_bounds,
            adjacent_sides,
            300,
            400,
            AcceptedTrimAuthority::default(),
        );
        assert_eq!(
            adjacent_bounds.expect("adjacent content bounds").left,
            0,
            "genuine rail-adjacent text no longer expands to the physical edge"
        );

        let mut distant_text = BinaryImage::new(300, 400);
        for y in 40..56 {
            for x in 15..23 {
                distant_text.set(x, y, true);
            }
        }
        let distant_sides = structured_text_edge_sides(&excluded, &distant_text, calibration);
        assert_eq!(
            distant_sides, 0,
            "text far along the perpendicular axis borrowed the rail's edge authority"
        );
        let mut distant_bounds = Some(initial);
        expand_bounds_for_structured_edge_text(
            &mut distant_bounds,
            distant_sides,
            300,
            400,
            AcceptedTrimAuthority::default(),
        );
        assert_eq!(
            distant_bounds.expect("distant content bounds").left,
            initial.left,
            "distant text reopened the content box to the physical edge"
        );
    }

    #[test]
    fn rejected_picture_rails_cannot_protect_seam_ink_as_text_content() {
        let mut image = GrayImage::new(600, 800, 244);
        draw_glyph_line(&mut image, 150, 95, 15, 8, 24, 16);
        for row in 0..16 {
            draw_glyph_line(&mut image, 145, 165 + row * 35, 16, 7, 20, 15);
        }
        draw_glyph_line(&mut image, 205, 720, 10, 8, 24, 16);

        // Deskew leaves short coherent ends of the inner gutter near opposite
        // corners. Their row density is text-like enough to be protected if
        // the automatic picture owner is allowed to establish crop authority
        // before its frame-rail qualification is applied.
        for segment in 0..14 {
            let top = 31 + segment * 8;
            for y in top..top + 5 {
                for x in 590..600 {
                    image.set(x, y, 18);
                }
            }
        }
        for segment in 0..4 {
            let top = 760 + segment * 9;
            for y in top..(top + 6).min(image.height()) {
                for x in 3..27 {
                    image.set(x, y, 18);
                }
            }
        }

        let mut picture = BinaryImage::new(image.width(), image.height());
        for y in 0..260 {
            for x in 570..600 {
                picture.set(x, y, true);
            }
        }
        for y in 600..800 {
            for x in 0..35 {
                picture.set(x, y, true);
            }
        }
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 27.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let bounds = detect_content_and_margins_calibrated(
            &image,
            Some(&picture),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        )
        .content
        .expect("authored title text is content");
        assert!(
            bounds.x >= 140.0,
            "lower seam end pinned left crop: {bounds:?}"
        );
        assert!(
            bounds.right() <= 500.0,
            "upper seam end pinned right crop: {bounds:?}"
        );
        assert!(bounds.y <= 100.0, "title was cropped: {bounds:?}");
        assert!(bounds.bottom() >= 740.0, "footer was cropped: {bounds:?}");
    }

    #[test]
    fn crop_picture_bounds_ignore_only_the_contaminated_edge_corridor() {
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 12.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let mut picture = BinaryImage::new(400, 600);
        for (top, bottom) in [(0, 110), (190, 320), (540, 600)] {
            for y in top..bottom {
                for x in 12..38 {
                    picture.set(x, y, true);
                }
            }
        }
        for y in 180..280 {
            for x in 145..255 {
                picture.set(x, y, true);
            }
        }
        assert_eq!(
            crop_qualified_picture_bounds(&picture, CROP_ARTIFACT_LEFT, calibration),
            Some(PixelBounds {
                left: 145,
                top: 180,
                right: 254,
                bottom: 279,
            })
        );

        // A genuine marginal photo that reaches beyond the calibrated gutter
        // corridor remains crop-authoritative even on a contaminated edge.
        let mut edge_photo = BinaryImage::new(400, 600);
        for y in 330..470 {
            for x in 18..125 {
                edge_photo.set(x, y, true);
            }
        }
        assert_eq!(
            crop_qualified_picture_bounds(&edge_photo, CROP_ARTIFACT_LEFT, calibration),
            Some(PixelBounds {
                left: 18,
                top: 330,
                right: 124,
                bottom: 469,
            })
        );
        assert_eq!(
            crop_qualified_picture_bounds(&edge_photo, 0, calibration),
            Some(PixelBounds {
                left: 18,
                top: 330,
                right: 124,
                bottom: 469,
            }),
            "a genuine edge photo floating clear of the frame was rejected"
        );

        let full_bleed = BinaryImage::from_fn_parallel(400, 600, |_, _| true);
        assert_eq!(
            crop_qualified_picture_bounds(&full_bleed, CROP_ARTIFACT_LEFT, calibration),
            Some(PixelBounds {
                left: 0,
                top: 0,
                right: 399,
                bottom: 599,
            })
        );
        assert_eq!(
            crop_qualified_picture_bounds(&full_bleed, 0, calibration),
            Some(PixelBounds {
                left: 0,
                top: 0,
                right: 399,
                bottom: 599,
            }),
            "full-bleed picture ownership must remain crop-authoritative"
        );
    }

    #[test]
    fn crop_only_edge_filter_overrides_false_picture_ownership() {
        let mut image = GrayImage::new(600, 800, 242);
        draw_glyph_line(&mut image, 150, 95, 22, 7, 12, 5);
        for row in 0..18 {
            draw_glyph_line(&mut image, 145, 165 + row * 25, 24, 6, 11, 4);
        }
        draw_glyph_line(&mut image, 205, 720, 12, 7, 12, 5);
        let mut picture = BinaryImage::new(image.width(), image.height());
        for top in (0..210).step_by(11) {
            let left = 35 + (top / 11 % 5) * 5;
            for y in top..(top + 8).min(image.height()) {
                for x in left..left + 4 {
                    image.set(x, y, 18);
                    picture.set(x, y, true);
                }
            }
        }
        for top in (748..800).step_by(10) {
            let left = 32 + (top / 10 % 6) * 5;
            for y in top..(top + 8).min(image.height()) {
                for x in left..left + 4 {
                    image.set(x, y, 18);
                    picture.set(x, y, true);
                }
            }
        }
        // A central stamp remains semantic picture content. The crop-only
        // override must not alter or discard its ownership.
        for y in 510..590 {
            for x in 260..340 {
                if x == 260 || x == 339 || y == 510 || y == 589 {
                    picture.set(x, y, true);
                }
            }
        }
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 40.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let bounds = detect_content_and_margins_calibrated(
            &image,
            Some(&picture),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        )
        .content
        .expect("authored text and stamp are content");
        assert!(
            bounds.x >= 140.0,
            "false picture gutter survived: {bounds:?}"
        );
        assert!(bounds.y >= 90.0, "top picture gutter survived: {bounds:?}");
        assert!(
            bounds.bottom() <= 735.0,
            "bottom picture gutter survived: {bounds:?}"
        );
        assert!(
            bounds.x <= 260.0 && bounds.right() >= 340.0,
            "central stamp was excluded: {bounds:?}"
        );
    }

    #[test]
    fn edge_attached_band_remains_trimmable_beyond_the_border_zone() {
        let (bounds, accepted_trims) = direct_trim_fixture(0, 30);
        let bounds = bounds.expect("edge-attached artifact and body are content");

        assert!(accepted_trims
            .iter()
            .any(|trim| { trim.side == ContentTrimSide::Top && trim.iteration == 1 }));
        assert!(bounds.top >= 80, "edge-attached band survived: {bounds:?}");
    }

    #[test]
    fn calibrated_evidence_ignores_one_picture_pixel_when_trimming() {
        let (bounds, _, accepted_trims) = direct_trim_fixture_with_evidence(0, 30, true, 1);
        let bounds = bounds.expect("edge residue and body are content");

        assert!(accepted_trims
            .iter()
            .any(|trim| trim.side == ContentTrimSide::Top));
        assert!(
            bounds.top >= 80,
            "one overlap pixel vetoed the trim: {bounds:?}"
        );
    }

    #[test]
    fn protected_survivor_at_shared_extreme_degrades_to_no_trim() {
        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 40.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        let blocks = vec![
            BlockStats::default(),
            BlockStats {
                ink_area: 40,
                left: 10,
                top: 0,
                right: 20,
                bottom: 20,
                initialized: true,
                ..BlockStats::default()
            },
            BlockStats {
                ink_area: 40,
                left: 60,
                top: 0,
                right: 70,
                bottom: 20,
                initialized: true,
                grayscale_supported: true,
                ..BlockStats::default()
            },
            BlockStats {
                ink_area: 400,
                left: 40,
                top: 80,
                right: 140,
                bottom: 160,
                initialized: true,
                ..BlockStats::default()
            },
        ];
        let current = PixelBounds {
            left: 10,
            top: 0,
            right: 140,
            bottom: 160,
        };

        assert!(build_trim_geometry(
            TrimSide::Top,
            current,
            &blocks,
            &[false, true, true, true],
            calibration,
        )
        .is_none());
    }

    #[test]
    fn a_side_below_its_trim_threshold_is_left_untrimmed() {
        let (trimmed, trimmed_confidence, trims) = direct_trim_fixture_with_garbage(0, 30, true);
        let trimmed = trimmed.expect("artifact and body are content");
        assert!(
            trimmed.top >= 80,
            "the trimmable band survived: {trimmed:?}"
        );
        let accepted = trims
            .iter()
            .find(|trim| trim.side == ContentTrimSide::Top)
            .expect("the band was trimmed from the top");
        assert!(accepted.score > accepted.threshold);
        assert!(trimmed_confidence[TrimSide::Top.index()] >= accepted.threshold);

        // The same band with the garbage evidence elsewhere: the side scores
        // below its threshold, so nothing is trimmed and the pixels stay.
        let (kept, kept_confidence, kept_trims) = direct_trim_fixture_with_garbage(0, 30, false);
        let kept = kept.expect("artifact and body are content");
        assert!(
            kept_trims.is_empty(),
            "a below-threshold side was trimmed: {kept_trims:?}",
        );
        assert_eq!(kept.top, 0, "an unsupported trim removed content: {kept:?}");
        assert!(
            kept_confidence[TrimSide::Top.index()] < accepted.threshold,
            "the refused side reported trim-worthy confidence: {kept_confidence:?}",
        );
    }

    #[test]
    fn in_frame_floating_artifact_is_not_trimmable_even_with_high_garbage_score() {
        // Every artifact pixel is a garbage seed, so the score would be maximal
        // without the page-frame admissibility filter.
        let (bounds, accepted_trims) = direct_trim_fixture(25, 55);
        let bounds = bounds.expect("floating artifact and body are content");

        assert!(accepted_trims.is_empty());
        assert_eq!(bounds.top, 25, "floating artifact was trimmed: {bounds:?}");
    }

    #[test]
    fn recognized_text_blocks_cannot_be_consumed_by_a_cascading_edge_trim() {
        let mut image = GrayImage::new(620, 760, 245);
        // A scanner-edge rule and running header are legitimate trim
        // candidates. The body above the next chapter is not: once recognized
        // as text it must remain protected even if the first trim makes it the
        // block nearest the same edge.
        for x in 28..592 {
            image.set(x, 24, 18);
            image.set(x, 25, 18);
        }
        draw_glyph_line(&mut image, 52, 46, 18, 5, 8, 3);
        for row in 0..6 {
            let top = 104 + row * 19;
            draw_glyph_line(&mut image, 62, top, 14, 6, 10, 4);
            draw_glyph_line(&mut image, 330, top, 14, 6, 10, 4);
        }
        draw_glyph_line(&mut image, 226, 322, 8, 11, 24, 6);
        for row in 0..16 {
            let top = 388 + row * 19;
            draw_glyph_line(&mut image, 62, top, 14, 6, 10, 4);
            draw_glyph_line(&mut image, 330, top, 14, 6, 10, 4);
        }

        let result = detect_content_and_margins(&image, 150.0, None, Some([0.0; 4]));
        let bounds = result.content.unwrap();
        assert!(
            bounds.y <= 104.0,
            "recognized body text was lost in an edge-trim cascade: {bounds:?}"
        );
        let diagnostics = result.diagnostics.unwrap();
        assert!(
            diagnostics
                .protected_blocks
                .iter()
                .any(|block| block.text_evidence && block.bounds.y_px <= 104),
            "text protection was not recorded: {diagnostics:?}"
        );
    }

    #[test]
    fn calibrated_evidence_ignores_one_text_mask_pixel() {
        let mut components = BinaryImage::new(10, 10);
        components.set(1, 1, true);
        components.set(4, 4, true);
        components.set(8, 8, true);
        let map = ComponentMap::from_binary(&components);

        let mut blocks = vec![BlockStats::default(); 3];
        blocks[1] = BlockStats {
            left: 1,
            top: 1,
            right: 8,
            bottom: 8,
            initialized: true,
            labels: vec![1, 3],
            ..BlockStats::default()
        };
        blocks[2] = BlockStats {
            left: 4,
            top: 4,
            right: 4,
            bottom: 4,
            initialized: true,
            labels: vec![2],
            ..BlockStats::default()
        };
        let component_blocks = vec![0, 1, 2, 1];
        let mut text_mask = BinaryImage::new(10, 10);
        text_mask.set(4, 4, true);

        let calibration = PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 4.0,
            x_height_px: 40.0,
            valid: true,
            config: CalibrationConfig::default(),
        };
        annotate_text_evidence(
            &map,
            &component_blocks,
            &mut blocks,
            &text_mask,
            calibration,
        );

        assert!(
            !blocks[1].text_evidence,
            "a block must not inherit text protection merely because its bounding box contains text"
        );
        assert!(
            !blocks[2].text_evidence,
            "one text-mask pixel must not hard-protect an entire side block"
        );
    }

    fn accepted_top_trim_raster() -> (GrayImage, BinaryImage, PageCalibration) {
        let mut image = GrayImage::new(620, 760, 245);
        for y in 8..18 {
            for x in 32..588 {
                image.set(x, y, 16);
            }
        }
        for y in 44..62 {
            for x in 286..304 {
                image.set(x, y, 20);
            }
        }
        for panel in 0..4 {
            let left = 150 + panel * 74;
            for y in 132..280 {
                for x in left..left + 52 {
                    image.set(x, y, 45 + ((x * 17 + y * 11 + panel * 23) % 165) as u8);
                }
            }
        }
        draw_glyph_line(&mut image, 226, 342, 8, 11, 24, 6);
        for row in 0..16 {
            let top = 408 + row * 19;
            draw_glyph_line(&mut image, 62, top, 14, 6, 10, 4);
            draw_glyph_line(&mut image, 330, top, 14, 6, 10, 4);
        }
        let mut picture_mask = BinaryImage::new(image.width(), image.height());
        for y in 126..286 {
            for x in 144..430 {
                picture_mask.set(x, y, true);
            }
        }
        let calibration = PageCalibration::estimate(&image, 150.0, CalibrationConfig::default());
        (image, picture_mask, calibration)
    }

    #[test]
    fn accepted_artifact_trim_cannot_cascade_through_picture_or_heading() {
        let (image, picture_mask, calibration) = accepted_top_trim_raster();
        let result = detect_content_and_margins_calibrated(
            &image,
            Some(&picture_mask),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        );
        let bounds = result.content.unwrap();
        assert!(
            bounds.y <= 132.0 && bounds.bottom() >= 695.0,
            "protected content was lost after artifact trimming: {bounds:?}"
        );
        let diagnostics = result.diagnostics.unwrap();
        assert!(
            diagnostics
                .accepted_trims
                .iter()
                .any(|trim| trim.side == ContentTrimSide::Top && trim.iteration == 1),
            "top artifact was not removed first: {diagnostics:?}"
        );
        assert!(
            diagnostics
                .protected_blocks
                .iter()
                .any(|block| { block.picture_mask_overlap_pixels > 0 && block.bounds.y_px <= 132 }),
            "picture evidence was not retained: {diagnostics:?}"
        );
        assert!(
            diagnostics
                .protected_blocks
                .iter()
                .any(|block| block.heading_evidence),
            "heading evidence was not retained: {diagnostics:?}"
        );
    }

    #[test]
    fn vetted_picture_geometry_contributes_its_full_extent_to_content_bounds() {
        let mut image = GrayImage::new(320, 420, 245);
        draw_glyph_line(&mut image, 96, 170, 8, 8, 14, 5);
        let mut picture_mask = BinaryImage::new(image.width(), image.height());
        for y in 48..382 {
            for x in 34..286 {
                picture_mask.set(x, y, true);
            }
        }
        let calibration = PageCalibration::estimate(&image, 150.0, CalibrationConfig::default());

        let result = detect_content_and_margins_calibrated(
            &image,
            Some(&picture_mask),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        );
        let bounds = result.content.expect("picture geometry is content");

        assert!(bounds.x <= 34.0);
        assert!(bounds.y <= 48.0);
        assert!(bounds.right() >= 286.0);
        assert!(bounds.bottom() >= 382.0);
        let shipped = result
            .diagnostics
            .expect("content diagnostics")
            .shipped_bounds
            .expect("the shipped crop has diagnostic geometry");
        assert_eq!(shipped.x_px as f64, bounds.x);
        assert_eq!(shipped.y_px as f64, bounds.y);
        assert_eq!(shipped.width_px as f64, bounds.width);
        assert_eq!(shipped.height_px as f64, bounds.height);
    }

    #[test]
    fn accepted_top_trim_owns_the_side_through_qualified_picture_union() {
        let (image, picture_mask, calibration) = accepted_top_trim_raster();
        let baseline = detect_content_and_margins_calibrated(
            &image,
            Some(&picture_mask),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        )
        .content
        .expect("the fixture has retained content");
        let mut expanded_picture = picture_mask.clone();
        let mut manual_authority = BinaryImage::new(image.width(), image.height());
        for y in 70..100 {
            for x in 480..520 {
                expanded_picture.set(x, y, true);
                manual_authority.set(x, y, true);
            }
        }

        let result = detect_content_and_margins_calibrated_with_crop_authority(
            &image,
            Some(&expanded_picture),
            Some(&manual_authority),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        );
        let shipped = result
            .content
            .expect("qualified picture geometry is content");
        let diagnostics = result.diagnostics.expect("content diagnostics");

        assert!(
            70.0 < baseline.y,
            "the picture must reach outside the accepted trim"
        );
        assert!(diagnostics
            .accepted_trims
            .iter()
            .any(|trim| trim.side == ContentTrimSide::Top));
        assert_eq!(shipped.y, baseline.y);
        assert_eq!(diagnostics.shipped_bounds.unwrap().y_px as f64, baseline.y);
    }

    #[test]
    fn collateral_side_retraction_owns_the_side_through_qualified_picture_union() {
        let (image, picture_mask, calibration) = accepted_top_trim_raster();
        let baseline = detect_content_and_margins_calibrated(
            &image,
            Some(&picture_mask),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        );
        let baseline_bounds = baseline.content.expect("the fixture has retained content");
        let mut expanded_picture = picture_mask.clone();
        let mut manual_authority = BinaryImage::new(image.width(), image.height());
        for y in 300..330 {
            for x in 40..52 {
                expanded_picture.set(x, y, true);
                manual_authority.set(x, y, true);
            }
        }

        let result = detect_content_and_margins_calibrated_with_crop_authority(
            &image,
            Some(&expanded_picture),
            Some(&manual_authority),
            150.0,
            None,
            Some([0.0; 4]),
            calibration,
        );
        let shipped = result
            .content
            .expect("qualified picture geometry is content");
        let diagnostics = result.diagnostics.expect("content diagnostics");
        let top_trim = diagnostics
            .accepted_trims
            .iter()
            .find(|trim| trim.side == ContentTrimSide::Top)
            .expect("the top proposal is accepted");

        assert!(
            baseline_bounds.x > 40.0,
            "the picture must reach outside the collateral trim"
        );
        assert!(top_trim
            .removed_blocks
            .iter()
            .any(|block| block.bounds.x_px < baseline_bounds.x as usize));
        assert!(!diagnostics
            .accepted_trims
            .iter()
            .any(|trim| trim.side == ContentTrimSide::Left));
        assert_eq!(shipped.x, baseline_bounds.x);
        assert_eq!(
            diagnostics.shipped_bounds.unwrap().x_px as f64,
            baseline_bounds.x
        );
    }
}
