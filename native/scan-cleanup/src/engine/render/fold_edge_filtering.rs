//! Acquisition rails on full pages and foreign fragments at a spread's fold.

use super::*;

pub(crate) struct Input<'a> {
    pub binary: &'a BinaryImage,
    pub picture_mask: Option<&'a BinaryImage>,
    pub text_mask: Option<&'a BinaryImage>,
    pub text_vicinity_mask: Option<&'a BinaryImage>,
    pub half: PageHalf,
    pub split: &'a SplitResult,
    pub region: Rect,
    pub render_plan: &'a ComposedRenderPlan,
    pub source_content_box: Option<Rect>,
    pub blank_leaf: bool,
    pub dpi: f64,
}

pub(crate) struct Output {
    pub kept: BinaryImage,
    pub removed: BinaryImage,
}

struct FoldGeometryInput<'a> {
    half: PageHalf,
    region: Rect,
    render_plan: &'a ComposedRenderPlan,
    source_content_box: Option<Rect>,
}

struct FoldGeometry {
    samples: Vec<(f64, f64)>,
    rendered_content_rect: Option<Rect>,
}

impl FoldGeometry {
    fn edge_x_at(&self, output_y: f64) -> f64 {
        if self.samples.len() == 1 {
            return self.samples[0].1;
        }
        let segment = self.samples.windows(2).find(|window| {
            output_y >= window[0].0.min(window[1].0) && output_y <= window[0].0.max(window[1].0)
        });
        let Some(segment) = segment else {
            return if output_y < self.samples[0].0 {
                self.samples[0].1
            } else {
                self.samples.last().map_or(0.0, |sample| sample.1)
            };
        };
        let delta_y = segment[1].0 - segment[0].0;
        if delta_y.abs() <= f64::EPSILON {
            return segment[0].1.min(segment[1].1);
        }
        let fraction = ((output_y - segment[0].0) / delta_y).clamp(0.0, 1.0);
        segment[0].1 + (segment[1].1 - segment[0].1) * fraction
    }
}

struct FilterContextInput<'a> {
    binary: &'a BinaryImage,
    picture_mask: Option<&'a BinaryImage>,
    text_mask: Option<&'a BinaryImage>,
    text_vicinity_mask: Option<&'a BinaryImage>,
    half: PageHalf,
    fold_geometry: &'a FoldGeometry,
    blank_leaf: bool,
    dpi: f64,
    split: &'a SplitResult,
}

struct FilterContext<'a> {
    binary: &'a BinaryImage,
    picture_mask: Option<&'a BinaryImage>,
    half: PageHalf,
    fold_geometry: &'a FoldGeometry,
    blank_leaf: bool,
    margin: f64,
    contact: f64,
    minimum_rule_major: usize,
    maximum_major: usize,
    maximum_minor: usize,
    maximum_area: usize,
    blank_maximum_major: usize,
    blank_maximum_minor: usize,
    blank_maximum_area: usize,
    components: ComponentMap,
    text_components: Option<ComponentMap>,
    text_vicinity_components: Option<ComponentMap>,
    measured_gutter_band: bool,
    rail_max_width: usize,
    rail_alignment: f64,
    rail_min_single_height: usize,
    rail_min_chain_span: usize,
    rail_min_chain_coverage: usize,
}

fn prepare_filter_context(input: FilterContextInput<'_>) -> FilterContext<'_> {
    let FilterContextInput {
        binary,
        picture_mask,
        text_mask,
        text_vicinity_mask,
        half,
        fold_geometry,
        blank_leaf,
        dpi,
        split,
    } = input;
    let margin = (binary.width() as f64 * FOLD_EDGE_FRAGMENT_MARGIN_FRACTION)
        .ceil()
        .max(1.0);
    let contact = (dpi.max(1.0) * FOLD_EDGE_FRAGMENT_CONTACT_MM / 25.4)
        .round()
        .max(1.0);
    let dpi_scale = dpi.max(1.0) / 25.4;
    let maximum_major = (dpi_scale * FOLD_EDGE_FRAGMENT_MAX_MAJOR_MM)
        .round()
        .max(4.0) as usize;
    let maximum_minor = (dpi_scale * FOLD_EDGE_FRAGMENT_MAX_MINOR_MM)
        .round()
        .max(2.0) as usize;
    let maximum_area = (dpi_scale.powi(2) * FOLD_EDGE_FRAGMENT_MAX_AREA_MM2)
        .round()
        .max(8.0) as usize;
    let minimum_rule_major = (dpi_scale * FOLD_EDGE_RULE_MIN_MAJOR_MM).round().max(4.0) as usize;
    let blank_maximum_major = (dpi_scale * FOLD_EDGE_BLANK_SPECK_MAX_MAJOR_MM)
        .round()
        .max(3.0) as usize;
    let blank_maximum_minor = (dpi_scale * FOLD_EDGE_BLANK_SPECK_MAX_MINOR_MM)
        .round()
        .max(2.0) as usize;
    let blank_maximum_area = (dpi_scale.powi(2) * FOLD_EDGE_BLANK_SPECK_MAX_AREA_MM2)
        .round()
        .max(4.0) as usize;
    let components = ComponentMap::from_binary(binary);
    let text_components = text_mask.map(ComponentMap::from_binary);
    let text_vicinity_components = text_vicinity_mask.map(ComponentMap::from_binary);
    let measured_gutter_band = split
        .cutter_x
        .is_some_and(|cutter| split.diagnostics.fold_band.has_suppression(cutter));
    let rail_max_width = (dpi_scale * FOLD_EDGE_RAIL_MAX_WIDTH_MM).round().max(2.0) as usize;
    let rail_alignment = (dpi_scale * FOLD_EDGE_RAIL_ALIGNMENT_MM).round().max(1.0);
    let rail_min_single_height = (dpi_scale * FOLD_EDGE_RAIL_MIN_SINGLE_HEIGHT_MM)
        .round()
        .max(8.0) as usize;
    let rail_min_chain_span = (dpi_scale * FOLD_EDGE_RAIL_MIN_CHAIN_SPAN_MM)
        .round()
        .max(16.0) as usize;
    let rail_min_chain_coverage = (dpi_scale * FOLD_EDGE_RAIL_MIN_CHAIN_COVERAGE_MM)
        .round()
        .max(8.0) as usize;
    FilterContext {
        binary,
        picture_mask,
        half,
        fold_geometry,
        blank_leaf,
        margin,
        contact,
        minimum_rule_major,
        maximum_major,
        maximum_minor,
        maximum_area,
        blank_maximum_major,
        blank_maximum_minor,
        blank_maximum_area,
        components,
        text_components,
        text_vicinity_components,
        measured_gutter_band,
        rail_max_width,
        rail_alignment,
        rail_min_single_height,
        rail_min_chain_span,
        rail_min_chain_coverage,
    }
}

impl FilterContext<'_> {
    fn overlaps_mask(&self, component: &scan_primitives::Component, mask: &BinaryImage) -> bool {
        (component.top..=component.bottom).any(|y| {
            (component.left..=component.right)
                .any(|x| self.components.label_at(x, y) == component.label && mask.get(x, y))
        })
    }

    fn component_inside(&self, component: &scan_primitives::Component, rect: Rect) -> bool {
        component.left as f64 >= rect.x
            && component.top as f64 >= rect.y
            && component.right as f64 + 1.0 <= rect.right()
            && component.bottom as f64 + 1.0 <= rect.bottom()
    }

    fn ownership_reaches_leaf_interior(
        &self,
        component: &scan_primitives::Component,
        ownership: &ComponentMap,
    ) -> bool {
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if self.components.label_at(x, y) != component.label {
                    continue;
                }
                let label = ownership.label_at(x, y);
                if label == 0 {
                    continue;
                }
                let owner = &ownership.components()[label as usize - 1];
                let rows = [owner.top, (owner.top + owner.bottom) / 2, owner.bottom];
                let reaches_interior = rows.into_iter().any(|row| {
                    let edge = self.fold_geometry.edge_x_at(row as f64);
                    match self.half {
                        PageHalf::Left => (owner.left as f64) < edge - self.margin,
                        PageHalf::Right => owner.right as f64 + 1.0 > edge + self.margin,
                        PageHalf::Full => false,
                    }
                });
                if reaches_interior {
                    return true;
                }
            }
        }
        false
    }

    fn component_has_text_ownership(&self, component: &scan_primitives::Component) -> bool {
        self.text_components
            .as_ref()
            .is_some_and(|mask| self.ownership_reaches_leaf_interior(component, mask))
            || self
                .text_vicinity_components
                .as_ref()
                .is_some_and(|mask| self.ownership_reaches_leaf_interior(component, mask))
    }

    fn fold_geometry(&self, component: &scan_primitives::Component) -> (bool, f64) {
        let sample_rows = [
            component.top,
            (component.top + component.bottom) / 2,
            component.bottom,
        ];
        let mut near_boundary = false;
        let mut inward_depth = 0.0_f64;
        for row in sample_rows {
            let edge = self.fold_geometry.edge_x_at(row as f64);
            let facing_distance = match self.half {
                PageHalf::Left => edge - component.right as f64,
                PageHalf::Right => component.left as f64 - edge,
                PageHalf::Full => f64::INFINITY,
            };
            near_boundary |= facing_distance.abs() <= self.contact
                || match self.half {
                    PageHalf::Left => component.right as f64 >= edge - self.contact,
                    PageHalf::Right => component.left as f64 <= edge + self.contact,
                    PageHalf::Full => false,
                };
            inward_depth = inward_depth.max(match self.half {
                PageHalf::Left => (edge - component.left as f64).max(0.0),
                PageHalf::Right => (component.right as f64 - edge).max(0.0),
                PageHalf::Full => f64::INFINITY,
            });
        }
        (near_boundary, inward_depth)
    }

    fn component_has_content_ownership(&self, component: &scan_primitives::Component) -> bool {
        self.fold_geometry
            .rendered_content_rect
            .is_some_and(|rect| {
                if !self.component_inside(component, rect) {
                    return false;
                }
                let edge = self
                    .fold_geometry
                    .edge_x_at(((component.top + component.bottom) / 2) as f64);
                match self.half {
                    PageHalf::Left => component.right as f64 + 1.0 < edge - self.margin,
                    PageHalf::Right => component.left as f64 > edge + self.margin,
                    PageHalf::Full => true,
                }
            })
    }

    fn touches_non_fold_edge(&self, component: &scan_primitives::Component) -> bool {
        self.touches_horizontal_page_edge(component) || self.touches_outer_leaf_edge(component)
    }

    fn touches_horizontal_page_edge(&self, component: &scan_primitives::Component) -> bool {
        component.top == 0 || component.bottom + 1 == self.binary.height()
    }

    fn touches_outer_leaf_edge(&self, component: &scan_primitives::Component) -> bool {
        match self.half {
            PageHalf::Left => component.left == 0,
            PageHalf::Right => component.right + 1 == self.binary.width(),
            PageHalf::Full => true,
        }
    }
}

#[derive(Clone, Copy)]
struct RailCandidate {
    label: u32,
    distance: f64,
    top: usize,
    bottom: usize,
    height: usize,
    fill: f64,
}

fn prepare_fold_geometry(input: FoldGeometryInput<'_>) -> Option<FoldGeometry> {
    let FoldGeometryInput {
        half,
        region,
        render_plan,
        source_content_box,
    } = input;
    let fold_source_x = match half {
        PageHalf::Left => region.right(),
        PageHalf::Right => region.x,
        PageHalf::Full => return None,
    };
    let mut samples = (0..=8)
        .filter_map(|index| {
            let fraction = index as f64 / 8.0;
            render_plan
                .source_to_output(Point::new(
                    fold_source_x,
                    region.y + region.height * fraction,
                ))
                .map(|point| (point.y, point.x))
        })
        .collect::<Vec<_>>();
    if samples.is_empty() {
        return None;
    }
    samples.sort_unstable_by(|left, right| left.0.total_cmp(&right.0));
    let rendered_content_rect = source_content_box.and_then(|content| {
        let points = [
            Point::new(content.x, content.y),
            Point::new(content.right(), content.y),
            Point::new(content.x, content.bottom()),
            Point::new(content.right(), content.bottom()),
        ]
        .into_iter()
        .filter_map(|point| {
            render_plan.source_to_output(Point::new(point.x + region.x, point.y + region.y))
        })
        .collect::<Vec<_>>();
        (points.len() == 4).then(|| {
            let left = points
                .iter()
                .map(|point| point.x)
                .fold(f64::INFINITY, f64::min);
            let top = points
                .iter()
                .map(|point| point.y)
                .fold(f64::INFINITY, f64::min);
            let right = points
                .iter()
                .map(|point| point.x)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = points
                .iter()
                .map(|point| point.y)
                .fold(f64::NEG_INFINITY, f64::max);
            Rect::new(left, top, right - left, bottom - top)
        })
    });
    Some(FoldGeometry {
        samples,
        rendered_content_rect,
    })
}

pub(crate) fn run(input: Input<'_>) -> Output {
    let Input {
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
    } = input;
    if split.classification != LayoutClassification::TwoPageSpread
        || half == PageHalf::Full
        || binary.width() == 0
        || binary.height() == 0
    {
        let removed = if half == PageHalf::Full && binary.width() > 0 && binary.height() > 0 {
            map_rect_bounds(region, |point| render_plan.source_to_output(point)).map_or_else(
                || BinaryImage::new(binary.width(), binary.height()),
                |page| {
                    let (rails, _) = crate::edge_artifacts::side_edge_rails(binary, Some(page));
                    let components = ComponentMap::from_binary(&rails);
                    components.retain(|component| {
                        ![picture_mask, text_mask, text_vicinity_mask]
                            .into_iter()
                            .flatten()
                            .any(|mask| {
                                (component.top..=component.bottom).any(|y| {
                                    (component.left..=component.right).any(|x| {
                                        components.label_at(x, y) == component.label
                                            && mask.get(x, y)
                                    })
                                })
                            })
                    })
                },
            )
        } else {
            BinaryImage::new(binary.width(), binary.height())
        };
        return Output {
            kept: binary.subtract(&removed),
            removed,
        };
    }
    debug_assert!(picture_mask
        .is_none_or(|mask| (mask.width(), mask.height()) == (binary.width(), binary.height())));
    debug_assert!(text_mask
        .is_none_or(|mask| (mask.width(), mask.height()) == (binary.width(), binary.height())));
    debug_assert!(text_vicinity_mask
        .is_none_or(|mask| (mask.width(), mask.height()) == (binary.width(), binary.height())));

    let Some(fold_geometry) = prepare_fold_geometry(FoldGeometryInput {
        half,
        region,
        render_plan,
        source_content_box,
    }) else {
        return Output {
            kept: binary.clone(),
            removed: BinaryImage::new(binary.width(), binary.height()),
        };
    };
    let filter_context = prepare_filter_context(FilterContextInput {
        binary,
        picture_mask,
        text_mask,
        text_vicinity_mask,
        half,
        fold_geometry: &fold_geometry,
        blank_leaf,
        dpi,
        split,
    });

    let rail_labels = classify_rail_candidates(&filter_context);
    let kept = retain_fragments(&filter_context, &rail_labels);
    let removed = binary.subtract(&kept);
    Output { kept, removed }
}

fn classify_rail_candidates(context: &FilterContext<'_>) -> Vec<bool> {
    let mut rail_labels = vec![false; context.components.components().len() + 1];
    if !context.measured_gutter_band {
        return rail_labels;
    }
    let rail_candidates = context
        .components
        .components()
        .iter()
        .filter_map(|component| {
            let width = component.right - component.left + 1;
            let height = component.bottom - component.top + 1;
            let (near_boundary, inward_depth) = context.fold_geometry(component);
            // The visible end of a binding rail can enter from the top or
            // bottom corner of an otherwise blank leaf. Admit that one
            // geometry to the measured-rail classifier; an outer-edge
            // contact, or the same contact on a nonblank leaf, remains an
            // unconditional preservation boundary.
            if context.touches_outer_leaf_edge(component)
                || (context.touches_horizontal_page_edge(component) && !context.blank_leaf)
                || !near_boundary
                || inward_depth > context.margin
                || width > context.rail_max_width
                || height < width.saturating_mul(2)
                || context
                    .picture_mask
                    .is_some_and(|mask| context.overlaps_mask(component, mask))
                || context.component_has_text_ownership(component)
                || context.component_has_content_ownership(component)
            {
                return None;
            }
            let edge = context
                .fold_geometry
                .edge_x_at(((component.top + component.bottom) / 2) as f64);
            let center = (component.left + component.right) as f64 * 0.5;
            Some(RailCandidate {
                label: component.label,
                distance: (center - edge).abs(),
                top: component.top,
                bottom: component.bottom,
                height,
                fill: component.area as f64 / width.saturating_mul(height).max(1) as f64,
            })
        })
        .collect::<Vec<_>>();
    let mut assigned = vec![false; rail_candidates.len()];
    for anchor in 0..rail_candidates.len() {
        if assigned[anchor] {
            continue;
        }
        let mut group = Vec::new();
        for candidate in anchor..rail_candidates.len() {
            if !assigned[candidate]
                && (rail_candidates[candidate].distance - rail_candidates[anchor].distance).abs()
                    <= context.rail_alignment
            {
                assigned[candidate] = true;
                group.push(rail_candidates[candidate]);
            }
        }
        let mut intervals = group
            .iter()
            .map(|candidate| (candidate.top, candidate.bottom))
            .collect::<Vec<_>>();
        intervals.sort_unstable();
        let mut coverage = 0usize;
        let mut covered: Option<(usize, usize)> = None;
        for (top, bottom) in intervals {
            match covered {
                Some((covered_top, covered_bottom)) if top <= covered_bottom.saturating_add(1) => {
                    covered = Some((covered_top, covered_bottom.max(bottom)));
                }
                Some((covered_top, covered_bottom)) => {
                    coverage += covered_bottom - covered_top + 1;
                    covered = Some((top, bottom));
                }
                None => covered = Some((top, bottom)),
            }
        }
        if let Some((covered_top, covered_bottom)) = covered {
            coverage += covered_bottom - covered_top + 1;
        }
        let top = group
            .iter()
            .map(|candidate| candidate.top)
            .min()
            .unwrap_or(0);
        let bottom = group
            .iter()
            .map(|candidate| candidate.bottom)
            .max()
            .unwrap_or(0);
        let span = bottom.saturating_sub(top) + 1;
        let ragged_single = group.len() == 1
            && group[0].height >= context.rail_min_single_height
            && group[0].fill <= FOLD_EDGE_RAIL_MAX_SINGLE_FILL;
        let broken_chain = group.len() >= 2
            && span >= context.rail_min_chain_span
            && coverage >= context.rail_min_chain_coverage;
        if ragged_single || broken_chain {
            for candidate in group {
                rail_labels[candidate.label as usize] = true;
            }
        }
    }
    rail_labels
}

fn retain_fragments(context: &FilterContext<'_>, rail_labels: &[bool]) -> BinaryImage {
    context.components.retain(|component| {
        let width = component.right - component.left + 1;
        let height = component.bottom - component.top + 1;
        let major = width.max(height);
        let minor = width.min(height);
        // A clipped vertical glyph stem is often much longer than it is wide.
        // It is still a glyph-scale fragment; reserve the rule veto for a
        // high-aspect component at least 3 mm long. Long or chained scanner
        // rails remain outside the fragment envelope altogether.
        let line_like = major >= context.minimum_rule_major && major >= minor.saturating_mul(4);
        let small_fragment = component.area <= context.maximum_area
            && major <= context.maximum_major
            && minor <= context.maximum_minor
            && !line_like;
        let blank_speck = context.blank_leaf
            && component.area <= context.blank_maximum_area
            && major <= context.blank_maximum_major
            && minor <= context.blank_maximum_minor
            && !line_like;
        // Do not treat the physical outer/top/bottom edges as fold edges. This
        // is intentionally checked on the rendered raster as well as against
        // the mapped fold line: a crop margin can move the fold away from the
        // payload boundary without changing which payload edge is outer.
        // A corner rail is removable only after the stricter measured-gutter,
        // blank-leaf, ownership, size, alignment, and raggedness gates above
        // claimed it. Every other top/bottom/outer-edge component stays pinned.
        if rail_labels[component.label as usize] {
            return false;
        }
        if context.touches_non_fold_edge(component) {
            return true;
        }
        let (near_boundary, inward_depth) = context.fold_geometry(component);
        let within_fold_margin = inward_depth <= context.margin;
        if !within_fold_margin {
            return true;
        }
        let picture_ownership = context
            .picture_mask
            .is_some_and(|mask| context.overlaps_mask(component, mask));
        // Text masks are detected on the whole spread, so a facing-page line
        // that crosses the cutter can mark its clipped end as "text" on the
        // wrong leaf. It becomes leaf ownership only when the same connected
        // text or text-vicinity component continues beyond the narrow fold
        // corridor. This is the tight-rebind pin: genuine near-binding text
        // connects inward, while a foreign line end terminates at the fold.
        let text_ownership = context.component_has_text_ownership(component);
        // Content crops can themselves be pulled to the fold by the foreign
        // fragment being rejected. Only the part beyond the independently
        // bounded fold corridor is content interior for this filter.
        let content_ownership = context.component_has_content_ownership(component);
        if (picture_ownership && !blank_speck) || text_ownership || content_ownership {
            return true;
        }
        if !small_fragment && !blank_speck {
            return true;
        }
        if near_boundary && small_fragment {
            return false;
        }
        if blank_speck {
            // Blank leaves get one extra cosmetic pass, but only for isolated
            // sub-glyph-scale marks already confined to the fold corridor.
            return false;
        }
        true
    })
}

#[cfg(test)]
#[path = "fold_edge_filtering_tests.rs"]
mod tests;
