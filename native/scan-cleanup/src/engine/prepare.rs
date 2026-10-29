use scan_primitives::GrayImage;

/// Analysis is deliberately capped independently of declared DPI. Some corpus
/// PDFs describe source pixels as PDF points, so a nominal 150-DPI raster can
/// otherwise exceed one hundred megapixels.
pub const MAX_ANALYSIS_EDGE: usize = 2_400;
pub const MAX_ANALYSIS_PIXELS: usize = 4_500_000;

pub struct AnalysisLevel {
    pub image: GrayImage,
    pub scale_x: f64,
    pub scale_y: f64,
    pub effective_dpi: f64,
}

pub fn build_analysis_level(source: &GrayImage, source_dpi: f64, target_dpi: f64) -> AnalysisLevel {
    let dpi_scale = (target_dpi / source_dpi.max(1.0)).min(1.0);
    let edge_scale = (MAX_ANALYSIS_EDGE as f64 / source.width().max(1) as f64)
        .min(MAX_ANALYSIS_EDGE as f64 / source.height().max(1) as f64)
        .min(1.0);
    let pixels = source.width().saturating_mul(source.height()).max(1);
    let pixel_scale = (MAX_ANALYSIS_PIXELS as f64 / pixels as f64).sqrt().min(1.0);
    let scale = dpi_scale.min(edge_scale).min(pixel_scale);
    let max_width = (source.width() as f64 * scale).round().max(1.0) as usize;
    let max_height = (source.height() as f64 * scale).round().max(1.0) as usize;
    let image = source.downscale_to_fit(max_width, max_height);
    let scale_x = image.width() as f64 / source.width().max(1) as f64;
    let scale_y = image.height() as f64 / source.height().max(1) as f64;
    AnalysisLevel {
        effective_dpi: (source_dpi * scale_x.min(scale_y)).clamp(1.0, target_dpi),
        image,
        scale_x,
        scale_y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_300_and_600_dpi_replications_have_identical_analysis_pixels() {
        let mut source_300 = GrayImage::new(5, 5, 255);
        let mut source_600 = GrayImage::new(10, 10, 255);
        for y in 0..5 {
            source_300.set(0, y, 0);
        }
        for y in 0..10 {
            source_600.set(0, y, 0);
            source_600.set(1, y, 0);
        }
        let level_300 = build_analysis_level(&source_300, 300.0, 150.0);
        let level_600 = build_analysis_level(&source_600, 600.0, 150.0);
        assert_eq!((level_300.image.width(), level_300.image.height()), (3, 3));
        assert_eq!((level_600.image.width(), level_600.image.height()), (3, 3));
        assert_eq!(
            level_300.image.data(),
            level_600.image.data(),
            "the same physical pixel cells at 300 and 600 DPI must yield identical analysis"
        );
        assert_eq!(
            level_300.image.data(),
            &[102, 255, 255, 102, 255, 255, 102, 255, 255]
        );
    }

    #[test]
    fn caps_malformed_dpi_large_pages_by_pixels_and_edge() {
        let source = GrayImage::new(6_000, 4_200, 255);
        let level = build_analysis_level(&source, 150.0, 150.0);
        assert!(level.image.width() <= MAX_ANALYSIS_EDGE);
        assert!(level.image.height() <= MAX_ANALYSIS_EDGE);
        assert!(level.image.width() * level.image.height() <= MAX_ANALYSIS_PIXELS);
        assert!(level.scale_x < 0.41 && level.scale_y < 0.41);
        assert!((level.effective_dpi - 60.0).abs() < 0.1);
    }
}
