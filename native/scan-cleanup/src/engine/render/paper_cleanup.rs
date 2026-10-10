//! Paper cleanup for grayscale output.
//!
//! A grayscale page keeps its marks' tone, which is why it was chosen over
//! B&W, but that left its paper as scanned: clouds, edge shading and dust.
//! Cleanup only ever whitens paper. A mark is anything clearly darker than the
//! paper beside it, however faint or small: a rule, small capitals, pencil and
//! show-through all keep every pixel and a halo around it. Paper away from
//! every mark becomes white, and so does a speck too small to be a glyph with
//! no other mark near it. The picture owner is never touched.

use super::*;
use crate::bw::paper_reference;
use scan_primitives::{
    morphology::{dilate, erode_gray},
    Component,
};

/// How much darker than the brightest paper nearby a pixel must be to be a
/// mark. Paper clouds and edge shading change far more slowly than that
/// within a stroke width.
const MARK_CONTRAST: u8 = 24;
/// The inside of a solid mark wider than that neighbourhood, a heading bar
/// or a thick rule, has no paper beside it; it is a mark when it is this much
/// darker than the page's paper.
const SOLID_MARK_CONTRAST: u8 = 64;
/// A page whose paper reference is darker than this has no light paper to
/// clean.
const MIN_PAPER: u8 = 160;

pub(crate) fn whiten_unmarked_paper(
    gray: &mut GrayImage,
    picture: Option<&BinaryImage>,
    calibration: PageCalibration,
    dpi: f64,
) {
    let (width, height) = (gray.width(), gray.height());
    if width == 0 || height == 0 {
        return;
    }
    let scale = dpi.max(1.0) / calibration.effective_dpi.max(1.0);
    let (stroke, x_height) = if calibration.valid {
        (
            calibration.stroke_width_px * scale,
            calibration.x_height_px * scale,
        )
    } else {
        (dpi / 150.0, dpi / 18.0)
    };
    let page_paper = paper_reference(gray);
    if page_paper < MIN_PAPER {
        return;
    }
    let paper_radius = (stroke.round() as usize).max(4);
    // The local maximum: erosion shrinks dark structure in this convention.
    let paper = erode_gray(gray, paper_radius, paper_radius);
    let marks = BinaryImage::from_fn_parallel(width, height, |x, y| {
        let value = gray.get(x, y);
        paper.get(x, y).saturating_sub(value) >= MARK_CONTRAST
            || page_paper.saturating_sub(value) >= SOLID_MARK_CONTRAST
    });
    let speck_area = (stroke * stroke).round().max(4.0) as usize;
    let reach = ((2.0 * x_height).round() as usize).max(4);
    let components = ComponentMap::from_binary(&marks);
    let specks = components.retain(|component| component.area <= speck_area);
    // A speck stays near a larger mark or in a group whose combined ink is
    // larger than a speck. Specks within reach meet after growing by half of it.
    let near_large = dilate(&marks.subtract(&specks), reach, reach);
    let groups = ComponentMap::from_binary(&dilate(&specks, reach.div_ceil(2), reach.div_ceil(2)));
    let mut speck_area_per_group = vec![0usize; groups.components().len() + 1];
    let group_of = |component: &Component| {
        (component.top..=component.bottom)
            .flat_map(|y| (component.left..=component.right).map(move |x| (x, y)))
            .find(|&(x, y)| components.label_at(x, y) == component.label)
            .map_or(0, |(x, y)| groups.label_at(x, y) as usize)
    };
    for component in components.components() {
        if component.area <= speck_area {
            speck_area_per_group[group_of(component)] += component.area;
        }
    }
    let kept = components.retain(|component| {
        component.area > speck_area
            || speck_area_per_group[group_of(component)] > speck_area
            || (component.top..=component.bottom).any(|y| {
                (component.left..=component.right)
                    .any(|x| components.label_at(x, y) == component.label && near_large.get(x, y))
            })
    });
    let halo = ((x_height / 2.0).round() as usize).max(2);
    let keep = dilate(&kept, halo, halo);
    for y in 0..height {
        for x in 0..width {
            if !keep.get(x, y) && !picture.is_some_and(|mask| mask.get(x, y)) {
                gray.set(x, y, 255);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calibration::CalibrationConfig;

    fn calibration() -> PageCalibration {
        PageCalibration {
            effective_dpi: 150.0,
            stroke_width_px: 3.0,
            x_height_px: 12.0,
            valid: true,
            config: CalibrationConfig::default(),
        }
    }

    fn fill(
        image: &mut GrayImage,
        x: std::ops::Range<usize>,
        y: std::ops::Range<usize>,
        value: u8,
    ) {
        for row in y {
            for column in x.clone() {
                image.set(column, row, value);
            }
        }
    }

    #[test]
    fn whitens_binding_shadows_without_losing_faint_strokes() {
        let mut page = GrayImage::new(120, 220, 255);
        for top in [20, 80, 140] {
            for y in top..top + 50 {
                let depth = (y - top).min(top + 49 - y).min(12);
                for x in 0..16 {
                    let shade = (35 * (16 - x) * depth / (16 * 12)) as u8;
                    page.set(x, y, 255 - shade);
                }
            }
        }
        fill(&mut page, 60..90, 100..102, 220);
        fill(&mut page, 80..88, 40..56, 40);
        fill(&mut page, 5..7, 190..192, 220);
        fill(&mut page, 11..13, 202..204, 220);
        for (left, top) in [(40, 200), (46, 205), (52, 210)] {
            fill(&mut page, left..left + 2, top..top + 2, 220);
        }

        whiten_unmarked_paper(&mut page, None, calibration(), 150.0);

        for y in 0..220 {
            for x in 0..16 {
                assert_eq!(page.get(x, y), 255, "binding shadow stayed at ({x}, {y})");
            }
        }
        for y in 100..102 {
            for x in 60..90 {
                assert_eq!(page.get(x, y), 220, "faint stroke lost its tone");
            }
        }
        for y in 40..56 {
            for x in 80..88 {
                assert_eq!(page.get(x, y), 40, "glyph lost its tone");
            }
        }
        for (left, top) in [(40, 200), (46, 205), (52, 210)] {
            for y in top..top + 2 {
                for x in left..left + 2 {
                    assert_eq!(page.get(x, y), 220, "substantial speck group lost its tone");
                }
            }
        }
    }

    #[test]
    fn whitens_paper_away_from_marks_and_keeps_every_mark_pixel() {
        let mut page = GrayImage::new(400, 400, 238);
        // A soft paper cloud far from any mark.
        for y in 250..330 {
            for x in 250..330 {
                let distance = ((x as f64 - 290.0).hypot(y as f64 - 290.0) / 40.0).min(1.0);
                page.set(x, y, (222.0 + 16.0 * distance) as u8);
            }
        }
        // A line of glyphs, a faint pencil stroke beside it, a lone glyph-sized
        // page number and an isolated dust speck.
        for glyph in 0..8 {
            fill(&mut page, 40 + glyph * 14..48 + glyph * 14, 40..56, 30);
        }
        fill(&mut page, 40..120, 70..72, 208);
        fill(&mut page, 190..196, 370..384, 40);
        fill(&mut page, 340..342, 120..122, 60);
        // A solid bar far wider than the paper neighbourhood, and a thin rule
        // along the raster edge, as a table border cut by the scan leaves.
        fill(&mut page, 200..380, 20..90, 20);
        fill(&mut page, 0..2, 10..390, 40);
        // A picture owner with its own tone.
        let mut picture = BinaryImage::new(400, 400);
        for y in 150..220 {
            for x in 40..140 {
                picture.set(x, y, true);
                page.set(x, y, 180);
            }
        }
        let original = page.clone();

        whiten_unmarked_paper(&mut page, Some(&picture), calibration(), 150.0);

        for y in 0..400 {
            for x in 0..400 {
                let before = original.get(x, y);
                let after = page.get(x, y);
                if before <= 208 {
                    if (340..342).contains(&x) && (120..122).contains(&y) {
                        assert_eq!(after, 255, "the isolated speck stayed");
                    } else {
                        assert_eq!(after, before, "mark or picture pixel ({x}, {y}) changed");
                    }
                }
            }
        }
        assert_eq!(page.get(290, 290), 255, "the paper cloud stayed");
        assert_eq!(page.get(300, 140), 255, "plain paper was not whitened");
    }
}
