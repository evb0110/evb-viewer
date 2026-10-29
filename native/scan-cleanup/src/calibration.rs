use scan_primitives::{
    distance::squared_euclidean_distance,
    threshold::{otsu_threshold, threshold_global},
    BinaryImage, Component, ComponentMap, GrayImage,
};

const MIN_ESTIMATE_COMPONENTS: usize = 8;
const DESPECKLE_STROKE_AREA_FACTOR: f64 = 0.5;
const DESPECKLE_AREA_FLOOR: usize = 16;
const DIRT_RADIUS_FLOOR_SQUARED: u32 = 4;
const FALLBACK_X_HEIGHT_AT_300_DPI: f64 = 17.0;
const MIN_LOCAL_THRESHOLD_RADIUS: usize = 8;
const MAX_MULTISCALE_THRESHOLD_RADIUS: usize = 256;
const CONTENT_REFERENCE_DPI: f64 = 150.0;

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CalibrationConfig {
    pub content_neighborhood: bool,
    pub content_dilation: bool,
    pub content_block_gaps: bool,
    pub content_min_block_area: bool,
    pub content_dirt_radius: bool,
    pub despeckle_substantial_area: bool,
    pub despeckle_analysis_scale: bool,
    pub local_threshold_radius: bool,
    pub multiscale_local_threshold: bool,
}

impl CalibrationConfig {
    pub const fn legacy() -> Self {
        Self {
            content_neighborhood: false,
            content_dilation: false,
            content_block_gaps: false,
            content_min_block_area: false,
            content_dirt_radius: false,
            despeckle_substantial_area: false,
            despeckle_analysis_scale: false,
            local_threshold_radius: false,
            multiscale_local_threshold: false,
        }
    }
}

impl Default for CalibrationConfig {
    fn default() -> Self {
        Self {
            content_neighborhood: true,
            content_dilation: true,
            content_block_gaps: true,
            content_min_block_area: true,
            content_dirt_radius: true,
            despeckle_substantial_area: true,
            despeckle_analysis_scale: true,
            local_threshold_radius: true,
            multiscale_local_threshold: true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct PageCalibration {
    pub effective_dpi: f64,
    pub stroke_width_px: f64,
    pub x_height_px: f64,
    pub valid: bool,
    pub config: CalibrationConfig,
}

impl PageCalibration {
    pub(crate) fn estimate(
        image: &GrayImage,
        effective_dpi: f64,
        config: CalibrationConfig,
    ) -> Self {
        let threshold = otsu_threshold(image);
        let binary = threshold_global(image, threshold);
        Self::estimate_from_binary(&binary, effective_dpi, config)
    }

    pub(crate) fn estimate_from_binary(
        binary: &BinaryImage,
        effective_dpi: f64,
        config: CalibrationConfig,
    ) -> Self {
        let pixel_count = binary.width().saturating_mul(binary.height()).max(1);
        let ink_fraction = binary.count_black() as f64 / pixel_count as f64;
        let map = ComponentMap::from_binary(binary);
        let distance_to_white = squared_euclidean_distance(&binary.invert());
        Self::estimate_from_components(
            map.components(),
            &map.maximum_values_by_component(&distance_to_white),
            ink_fraction,
            effective_dpi,
            config,
        )
    }

    pub(crate) fn estimate_from_components(
        components: &[Component],
        component_maxima: &[u32],
        ink_fraction: f64,
        effective_dpi: f64,
        config: CalibrationConfig,
    ) -> Self {
        let mut stroke_widths = Vec::new();
        for component in components {
            if component.area < 4 {
                continue;
            }
            let maximum_squared = component_maxima[component.label as usize];
            if maximum_squared > 0 {
                stroke_widths.push(2.0 * f64::from(maximum_squared).sqrt());
            }
        }
        let stroke_width_px = median(&mut stroke_widths).unwrap_or_default();
        let mut x_heights = if stroke_widths.len() >= MIN_ESTIMATE_COMPONENTS {
            components
                .iter()
                .filter_map(|component| {
                    let width = component.right - component.left + 1;
                    let height = component.bottom - component.top + 1;
                    let height_f64 = height as f64;
                    let glyph_like = height_f64 >= stroke_width_px * 2.0
                        && height_f64 <= stroke_width_px * 12.0
                        && width as f64 / height_f64 < 4.0
                        && component.area as f64 >= stroke_width_px * stroke_width_px;
                    glyph_like.then_some(height_f64)
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let x_height_px = median(&mut x_heights).unwrap_or_default();
        let valid = stroke_widths.len() >= MIN_ESTIMATE_COMPONENTS
            && x_heights.len() >= MIN_ESTIMATE_COMPONENTS
            && (0.001..=0.30).contains(&ink_fraction)
            && stroke_width_px.is_finite()
            && x_height_px.is_finite();
        Self {
            effective_dpi: effective_dpi.max(1.0),
            stroke_width_px,
            x_height_px,
            valid,
            config,
        }
    }

    pub(crate) fn content_neighborhood(self) -> (usize, usize) {
        if self.config.content_neighborhood && self.valid {
            (self.mm_to_analysis_px(6.8), self.mm_to_analysis_px(4.1))
        } else {
            (40, 24)
        }
    }

    pub(crate) fn content_dilation(self) -> (usize, usize) {
        if self.config.content_dilation && self.valid {
            (self.mm_to_analysis_px(3.0), self.mm_to_analysis_px(1.4))
        } else {
            (18, 8)
        }
    }

    pub(crate) fn content_block_gaps(self) -> (usize, usize) {
        if self.config.content_block_gaps && self.valid {
            (self.mm_to_analysis_px(16.0), self.mm_to_analysis_px(22.0))
        } else {
            (96, 128)
        }
    }

    pub(crate) fn content_min_block_area(self) -> usize {
        if self.config.content_min_block_area && self.valid {
            self.mm_to_analysis_px(1.4).pow(2)
        } else {
            64
        }
    }

    pub(crate) fn content_dirt_radius_squared(self) -> u32 {
        if self.config.content_dirt_radius && self.valid {
            ((3.0 * self.stroke_width_px).powi(2).round() as u32).max(DIRT_RADIUS_FLOOR_SQUARED)
        } else {
            36
        }
    }

    pub(crate) fn threshold_radius(self, raster_dpi: f64) -> usize {
        if self.config.local_threshold_radius && self.valid {
            (1.5 * self.scaled_x_height(raster_dpi)).round() as usize
        } else {
            (raster_dpi * 25.5 / 300.0).round() as usize
        }
        .clamp(8, 64)
    }

    pub(crate) fn multiscale_threshold_radii(self, raster_dpi: f64) -> [usize; 3] {
        let x_height = if self.valid {
            self.scaled_x_height(raster_dpi)
        } else {
            FALLBACK_X_HEIGHT_AT_300_DPI * raster_dpi.max(1.0) / 300.0
        };
        [1.0, 2.5, 5.0]
            .map(|scale| (scale * x_height).round() as usize)
            .map(|radius| radius.clamp(MIN_LOCAL_THRESHOLD_RADIUS, MAX_MULTISCALE_THRESHOLD_RADIUS))
    }

    pub(crate) fn despeckle_substantial_area(self, raster_dpi: f64) -> usize {
        if self.config.despeckle_substantial_area && self.valid {
            (DESPECKLE_STROKE_AREA_FACTOR * self.scaled_stroke_width(raster_dpi).powi(2))
                .round()
                .max(DESPECKLE_AREA_FLOOR as f64) as usize
        } else {
            let scale = (raster_dpi / 300.0).clamp(0.5, 4.0);
            (32.0 * scale * scale).round().max(16.0) as usize
        }
    }

    pub(crate) fn content_despeckle_dpi(self) -> f64 {
        if self.config.despeckle_analysis_scale {
            self.effective_dpi
        } else {
            150.0
        }
    }

    pub(crate) fn content_long_opening_size(self) -> (usize, usize) {
        (
            self.content_reference_length(200.0),
            self.content_reference_length(1.0),
        )
    }

    pub(crate) fn content_minimum_band_rows(self) -> usize {
        self.content_reference_length(6.0)
    }

    pub(crate) fn content_trim_geometry(self) -> (usize, usize, usize) {
        (
            self.content_reference_length(8.0),
            self.content_reference_length(8.0),
            self.content_reference_length(30.0),
        )
    }

    pub(crate) fn content_text_bias_area_cap(self) -> usize {
        self.content_reference_area(5_000.0)
    }

    /// One text-mask hit is not enough to give an entire clustered block crop
    /// authority. A calibrated stem (stroke width by x-height) is the smallest
    /// repeatable text unit; the fallback preserves the same physical scale at
    /// the analysis DPI. The four-pixel floor comes from the calibration
    /// component census above; the 12-pixel fallback is that floor across the
    /// existing three-component minimum for structured edge text.
    pub(crate) fn content_minimum_text_evidence_pixels(self) -> usize {
        if self.valid {
            (self.stroke_width_px.max(1.0) * self.x_height_px.max(self.stroke_width_px))
                .round()
                .max(4.0) as usize
        } else {
            self.content_reference_area(12.0)
        }
    }

    /// Picture overlap must cover at least one calibrated stroke area before
    /// it can hard-protect a whole content block from trimming. Its four-pixel
    /// floor is the same minimum component area admitted to calibration, so a
    /// fallback means one smallest admitted component rather than a new scale.
    pub(crate) fn content_minimum_picture_overlap_pixels(self) -> usize {
        if self.valid {
            self.stroke_width_px.powi(2).round().max(4.0) as usize
        } else {
            self.content_reference_area(4.0)
        }
    }

    fn content_reference_length(self, pixels_at_150_dpi: f64) -> usize {
        (pixels_at_150_dpi * self.effective_dpi / CONTENT_REFERENCE_DPI)
            .round()
            .max(1.0) as usize
    }

    fn content_reference_area(self, pixels_at_150_dpi: f64) -> usize {
        let scale = self.effective_dpi / CONTENT_REFERENCE_DPI;
        (pixels_at_150_dpi * scale * scale).round().max(1.0) as usize
    }

    fn mm_to_analysis_px(self, millimeters: f64) -> usize {
        (millimeters * self.effective_dpi / 25.4).round().max(1.0) as usize
    }

    fn scaled_stroke_width(self, raster_dpi: f64) -> f64 {
        self.stroke_width_px * raster_dpi.max(1.0) / self.effective_dpi
    }

    fn scaled_x_height(self, raster_dpi: f64) -> f64 {
        self.x_height_px * raster_dpi.max(1.0) / self.effective_dpi
    }
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable_by(f64::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) * 0.5
    } else {
        values[middle]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph_page() -> BinaryImage {
        let mut image = BinaryImage::new(180, 100);
        for row in 0..2 {
            for column in 0..6 {
                let left = 12 + column * 25;
                let top = 15 + row * 38;
                for y in top..top + 18 {
                    for x in left..left + 10 {
                        if x < left + 3 || y < top + 3 || y >= top + 15 {
                            image.set(x, y, true);
                        }
                    }
                }
            }
        }
        image
    }

    #[test]
    fn estimates_stroke_and_x_height_from_glyph_components() {
        let calibration = PageCalibration::estimate_from_binary(
            &glyph_page(),
            150.0,
            CalibrationConfig::default(),
        );
        assert!(calibration.valid);
        assert!((3.0..=5.0).contains(&calibration.stroke_width_px));
        assert_eq!(calibration.x_height_px, 18.0);
        assert_eq!(calibration.threshold_radius(150.0), 27);
        assert_eq!(calibration.multiscale_threshold_radii(150.0), [18, 45, 90]);
    }

    #[test]
    fn insufficient_components_use_legacy_typographic_fallbacks() {
        let mut sparse = BinaryImage::new(40, 30);
        for y in 8..20 {
            for x in 10..14 {
                sparse.set(x, y, true);
            }
        }
        let calibration =
            PageCalibration::estimate_from_binary(&sparse, 90.0, CalibrationConfig::default());
        assert!(!calibration.valid);
        assert_eq!(calibration.content_neighborhood(), (40, 24));
        assert_eq!(calibration.content_dilation(), (18, 8));
        assert_eq!(calibration.content_block_gaps(), (96, 128));
        assert_eq!(calibration.content_min_block_area(), 64);
        assert_eq!(calibration.content_dirt_radius_squared(), 36);
        assert_eq!(calibration.despeckle_substantial_area(90.0), 16);
        assert_eq!(calibration.threshold_radius(90.0), 8);
        assert_eq!(calibration.multiscale_threshold_radii(90.0), [8, 13, 26]);
    }

    #[test]
    fn physical_content_constants_track_effective_dpi_and_legacy_is_exact() {
        let new = PageCalibration::estimate_from_binary(
            &glyph_page(),
            75.0,
            CalibrationConfig::default(),
        );
        assert_eq!(new.content_neighborhood(), (20, 12));
        assert_eq!(new.content_dilation(), (9, 4));
        assert_eq!(new.content_block_gaps(), (47, 65));
        assert_eq!(new.content_min_block_area(), 16);

        let legacy =
            PageCalibration::estimate_from_binary(&glyph_page(), 75.0, CalibrationConfig::legacy());
        assert_eq!(legacy.content_neighborhood(), (40, 24));
        assert_eq!(legacy.content_dilation(), (18, 8));
        assert_eq!(legacy.content_block_gaps(), (96, 128));
        assert_eq!(legacy.content_min_block_area(), 64);
        assert_eq!(legacy.content_dirt_radius_squared(), 36);
        assert_eq!(legacy.content_despeckle_dpi(), 150.0);
        assert!(!legacy.config.multiscale_local_threshold);
    }
}
