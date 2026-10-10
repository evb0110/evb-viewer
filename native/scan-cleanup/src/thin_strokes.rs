//! Thin-stroke completion for thresholded text.
//!
//! A threshold keeps a stroke only where its gray core is darker than the cut.
//! A hairline narrower than the scanner's blur never reaches that depth, so the
//! cut drops exactly the joins of high-contrast faces: the bowl of `a`, the
//! shoulders of `m` and `n`, the tails of `q` and `r`. The glyph falls apart
//! even though the scan shows the stroke clearly.
//!
//! The scan still records such a stroke as a gray valley: a line of pixels
//! darker than the paper beside them on both sides. This pass restores that
//! valley line, one or two pixels wide, so stems keep the threshold's edge and
//! only the missing hairline comes back. It adds a valley only where it bridges
//! kept ink or runs on as a real tail, because the soft rim around a round dot
//! or a stem end is also darker than paper along its arc and must stay paper.
//!
//! A valley's depth is the pixel's depth below paper plus that of its darker
//! neighbour across the line. A hairline that straddles two pixel rows splits
//! its darkness between them; the sum measures it the same either way.

use crate::{bw::paper_reference, calibration::PageCalibration};
use scan_primitives::{morphology::erode_gray, BinaryImage, ComponentMap, GrayImage};

/// Paper minus ink core below which a page has no print to complete.
const MIN_PAGE_DEPTH: u8 = 48;
/// Shallowest valley depth that can be a printed stroke. Paper grain and
/// show-through on ordinary scans stay below it.
const MIN_VALLEY_DEPTH: i16 = 40;
/// A stroke's valley depth must reach this fraction of the page's ink depth.
const VALLEY_DEPTH_FRACTION: f64 = 0.375;
/// Both sides of a valley must rise by this fraction of the page's ink depth.
/// A weakly printed stem beside a glyph's own interior rises little on that
/// side, yet it is a line; the depth above still keeps show-through out.
const VALLEY_RISE_FRACTION: f64 = 0.08;
/// Each profile direction with the direction along the stroke it would cross.
const DIRECTIONS: [((isize, isize), (isize, isize)); 4] = [
    ((1, 0), (0, 1)),
    ((0, 1), (1, 0)),
    ((1, 1), (1, -1)),
    ((1, -1), (1, 1)),
];

#[derive(Clone, Copy)]
struct ValleyContrast {
    depth: i16,
    rise: i16,
}

struct ValleyScale {
    /// Half-width, in pixels, of the profile a valley must be the minimum of.
    radius: usize,
    /// Radius of the local paper estimate; it must see past a glyph interior.
    paper_radius: usize,
    /// A valley touching kept ink at one place survives only this long.
    tail_length: usize,
}

impl ValleyScale {
    // The page's measured strokes set the scale. The declared DPI cannot: a
    // PDF that places a 300 DPI scan at 72 DPI would shrink every window.
    fn from_calibration(calibration: PageCalibration) -> Self {
        if !calibration.valid {
            return Self {
                radius: 2,
                paper_radius: 8,
                tail_length: 12,
            };
        }
        Self {
            radius: (calibration.stroke_width_px / 3.0).round().clamp(2.0, 4.0) as usize,
            paper_radius: (calibration.x_height_px / 2.0).round().clamp(4.0, 24.0) as usize,
            tail_length: (calibration.x_height_px * 0.4).round().max(8.0) as usize,
        }
    }
}

/// The valley lines of the thin strokes that `binary` dropped.
pub(crate) fn restored_thin_strokes(
    binary: &BinaryImage,
    raw: &GrayImage,
    calibration: PageCalibration,
) -> BinaryImage {
    let none = || BinaryImage::new(binary.width(), binary.height());
    if (binary.width(), binary.height()) != (raw.width(), raw.height()) || binary.count_black() == 0
    {
        return none();
    }
    let Some(contrast) = valley_contrast(binary, raw, paper_reference(raw)) else {
        return none();
    };
    let scale = ValleyScale::from_calibration(calibration);
    let local_paper = erode_gray(raw, scale.paper_radius, scale.paper_radius);
    let valleys = BinaryImage::from_fn_parallel(raw.width(), raw.height(), |x, y| {
        let paper = i16::from(local_paper.get(x, y));
        // The pixel is the darker of its pair, so it holds half the depth.
        !binary.get(x, y)
            && 2 * (paper - i16::from(raw.get(x, y))) >= contrast.depth
            && is_valley(raw, paper, x, y, scale.radius, contrast)
    });
    if valleys.count_black() == 0 {
        return none();
    }
    bridging_valleys(binary, &valleys, &scale)
}

/// The valley contrast for this page, measured from `page_paper` down to the
/// core of its kept ink, or `None` when the page has no print.
fn valley_contrast(
    binary: &BinaryImage,
    raw: &GrayImage,
    page_paper: u8,
) -> Option<ValleyContrast> {
    let mut ink = [0usize; 256];
    for y in 0..raw.height() {
        for (x, &value) in raw.row(y).iter().enumerate() {
            if binary.get(x, y) {
                ink[usize::from(value)] += 1;
            }
        }
    }
    let ink_core = histogram_quantile(&ink, 0.1)?;
    let page_depth = page_paper.checked_sub(ink_core)?;
    let fraction = |value: f64| (f64::from(page_depth) * value).round() as i16;
    (page_depth >= MIN_PAGE_DEPTH).then(|| ValleyContrast {
        depth: fraction(VALLEY_DEPTH_FRACTION).max(MIN_VALLEY_DEPTH),
        rise: fraction(VALLEY_RISE_FRACTION),
    })
}

fn histogram_quantile(histogram: &[usize; 256], fraction: f64) -> Option<u8> {
    let total = histogram.iter().sum::<usize>();
    if total == 0 {
        return None;
    }
    let rank = ((total - 1) as f64 * fraction).floor() as usize;
    let mut cumulative = 0usize;
    histogram
        .iter()
        .position(|&count| {
            cumulative += count;
            cumulative > rank
        })
        .map(|level| level as u8)
}

/// Whether `(x, y)` lies on a line: the darkest point of a profile through it
/// that is deep enough below `paper` and rises on both sides within `radius`
/// pixels. A point that is also darker-flanked along that line is a narrow gap
/// between two inks.
fn is_valley(
    raw: &GrayImage,
    paper: i16,
    x: usize,
    y: usize,
    radius: usize,
    contrast: ValleyContrast,
) -> bool {
    let center = i16::from(raw.get(x, y));
    let sample = |(dx, dy): (isize, isize), step: isize| {
        let sx = x.checked_add_signed(dx * step)?;
        let sy = y.checked_add_signed(dy * step)?;
        (sx < raw.width() && sy < raw.height()).then(|| i16::from(raw.get(sx, sy)))
    };
    let steps = 1..=radius as isize;
    DIRECTIONS.iter().any(|&(across, along)| {
        let mut darker_neighbour = i16::MAX;
        let mut rim = [i16::MAX; 2];
        for step in steps.clone() {
            for (side, sign) in [1isize, -1].into_iter().enumerate() {
                match sample(across, sign * step) {
                    Some(value) if value >= center => rim[side] = value,
                    _ => return false,
                }
                if step == 1 {
                    darker_neighbour = darker_neighbour.min(rim[side]);
                }
            }
        }
        let depth = (paper - center) + (paper - darker_neighbour).max(0);
        let darker_along = |sign: isize| {
            steps.clone().any(|step| {
                sample(along, sign * step).is_some_and(|value| center - value >= contrast.rise)
            })
        };
        depth >= contrast.depth
            && rim[0].min(rim[1]) - center >= contrast.rise
            && !(darker_along(1) && darker_along(-1))
    })
}

/// Keeps the valley components that bridge two kept glyph parts, touch one
/// part at two separate places, or run on as a tail. A short valley touching
/// ink at a single place is the rim of a dot or stem end.
fn bridging_valleys(
    binary: &BinaryImage,
    valleys: &BinaryImage,
    scale: &ValleyScale,
) -> BinaryImage {
    #[derive(Clone, Copy)]
    struct Contact {
        ink_label: u32,
        bridges: bool,
        left: usize,
        top: usize,
        right: usize,
        bottom: usize,
    }
    let ink = ComponentMap::from_binary(binary);
    let valley_map = ComponentMap::from_binary(valleys);
    let mut contacts: Vec<Option<Contact>> = vec![None; valley_map.components().len() + 1];
    for component in valley_map.components() {
        for y in component.top..=component.bottom {
            for x in component.left..=component.right {
                if valley_map.label_at(x, y) != component.label {
                    continue;
                }
                for ny in y.saturating_sub(1)..=(y + 1).min(binary.height() - 1) {
                    for nx in x.saturating_sub(1)..=(x + 1).min(binary.width() - 1) {
                        if !binary.get(nx, ny) {
                            continue;
                        }
                        let ink_label = ink.label_at(nx, ny);
                        let entry = &mut contacts[component.label as usize];
                        match entry {
                            None => {
                                *entry = Some(Contact {
                                    ink_label,
                                    bridges: false,
                                    left: nx,
                                    top: ny,
                                    right: nx,
                                    bottom: ny,
                                });
                            }
                            Some(contact) => {
                                contact.bridges |= contact.ink_label != ink_label;
                                contact.left = contact.left.min(nx);
                                contact.top = contact.top.min(ny);
                                contact.right = contact.right.max(nx);
                                contact.bottom = contact.bottom.max(ny);
                            }
                        }
                    }
                }
            }
        }
    }
    let separate_contacts = 2 * scale.radius + 2;
    valley_map.retain(|component| {
        contacts[component.label as usize].is_some_and(|contact| {
            contact.bridges
                || (contact.right - contact.left).max(contact.bottom - contact.top)
                    >= separate_contacts
                || component.area >= scale.tail_length
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calibration::CalibrationConfig;

    const PAPER: f64 = 225.0;
    const INK: f64 = 60.0;
    const MIDPOINT: u8 = 142;
    /// The narrow blur of a sharp scan.
    const SHARP: [f64; 3] = [1.0, 6.0, 1.0];
    /// The wide blur of ink seen through the paper.
    const SOFT: [f64; 5] = [1.0, 4.0, 6.0, 4.0, 1.0];
    /// A blur between the two, crisp enough for a dot's rim to be a valley.
    const MEDIUM: [f64; 3] = [1.0, 2.0, 1.0];

    fn calibration() -> PageCalibration {
        PageCalibration {
            effective_dpi: 300.0,
            stroke_width_px: 6.0,
            x_height_px: 30.0,
            valid: true,
            config: CalibrationConfig::default(),
        }
    }

    /// Sharp ink coverage, painted in before the scanner blur.
    struct Sheet {
        width: usize,
        height: usize,
        coverage: Vec<f64>,
    }

    impl Sheet {
        fn new(width: usize, height: usize) -> Self {
            Self {
                width,
                height,
                coverage: vec![0.0; width * height],
            }
        }

        fn fill_disk(&mut self, center_x: f64, center_y: f64, radius: f64) {
            for y in 0..self.height {
                for x in 0..self.width {
                    if (x as f64 - center_x).hypot(y as f64 - center_y) <= radius {
                        self.coverage[y * self.width + x] = 1.0;
                    }
                }
            }
        }

        fn fill(&mut self, left: usize, top: usize, right: usize, bottom: usize, coverage: f64) {
            for y in top..=bottom {
                for x in left..=right {
                    let cell = &mut self.coverage[y * self.width + x];
                    *cell = cell.max(coverage);
                }
            }
        }

        /// Scans the sheet through a separable, symmetric blur `kernel`.
        fn scan(&self, kernel: &[f64]) -> GrayImage {
            let reach = (kernel.len() / 2) as isize;
            let total = kernel.iter().sum::<f64>();
            let blur = |source: &[f64], horizontal: bool| {
                let mut output = vec![0.0; source.len()];
                for y in 0..self.height {
                    for x in 0..self.width {
                        let mut sum = 0.0;
                        for (tap, weight) in kernel.iter().enumerate() {
                            let offset = tap as isize - reach;
                            let (sx, sy) = if horizontal {
                                (x as isize + offset, y as isize)
                            } else {
                                (x as isize, y as isize + offset)
                            };
                            if (0..self.width as isize).contains(&sx)
                                && (0..self.height as isize).contains(&sy)
                            {
                                sum += weight * source[sy as usize * self.width + sx as usize];
                            }
                        }
                        output[y * self.width + x] = sum / total;
                    }
                }
                output
            };
            let blurred = blur(&blur(&self.coverage, true), false);
            let mut image = GrayImage::new(self.width, self.height, 0);
            for y in 0..self.height {
                for x in 0..self.width {
                    let value = PAPER - blurred[y * self.width + x] * (PAPER - INK);
                    image.set(x, y, value.round() as u8);
                }
            }
            image
        }
    }

    fn threshold(image: &GrayImage) -> BinaryImage {
        BinaryImage::from_fn_parallel(image.width(), image.height(), |x, y| {
            image.get(x, y) <= MIDPOINT
        })
    }

    fn complete(cut: &BinaryImage, image: &GrayImage) -> BinaryImage {
        cut.or(&restored_thin_strokes(cut, image, calibration()))
    }

    fn component_count(binary: &BinaryImage) -> usize {
        ComponentMap::from_binary(binary).components().len()
    }

    /// Two stems joined near their tops by a one-row hairline, as in `n`.
    fn joined_stems(hairline_coverage: f64, kernel: &[f64]) -> GrayImage {
        let mut sheet = Sheet::new(80, 60);
        sheet.fill(10, 10, 15, 50, 1.0);
        sheet.fill(50, 10, 55, 50, 1.0);
        sheet.fill(16, 14, 49, 14, hairline_coverage);
        sheet.scan(kernel)
    }

    #[test]
    fn restores_a_hairline_that_joins_two_stems() {
        // A sub-pixel hairline: its core stays lighter than the midpoint.
        let image = joined_stems(0.525, &SHARP);
        let cut = threshold(&image);
        assert!(
            component_count(&cut) > 1,
            "the midpoint must drop the hairline"
        );

        let completed = complete(&cut, &image);

        assert_eq!(component_count(&completed), 1);
        // Only the hairline row comes back; the stems keep the threshold's edge.
        for y in 0..60 {
            for x in 0..80 {
                if completed.get(x, y) && !cut.get(x, y) {
                    assert_eq!(y, 14, "added ink at ({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn restores_a_hairline_that_straddles_two_pixel_rows() {
        // A sharp scan splits a sub-pixel hairline between two rows, so
        // neither row alone is as dark as the line.
        let mut sheet = Sheet::new(80, 60);
        sheet.fill(10, 10, 15, 50, 1.0);
        sheet.fill(50, 10, 55, 50, 1.0);
        sheet.fill(16, 14, 49, 15, 0.2625);
        let image = sheet.scan(&SHARP);
        let cut = threshold(&image);
        assert!(
            component_count(&cut) > 1,
            "the midpoint must drop the hairline"
        );

        let completed = complete(&cut, &image);

        assert_eq!(component_count(&completed), 1);
        for y in 0..60 {
            for x in 0..80 {
                if completed.get(x, y) && !cut.get(x, y) {
                    assert!((14..=15).contains(&y), "added ink at ({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn leaves_the_rim_of_a_dot_as_paper() {
        let mut sheet = Sheet::new(40, 40);
        sheet.fill_disk(19.5, 19.5, 5.0);
        let image = sheet.scan(&MEDIUM);
        let cut = threshold(&image);

        assert_eq!(complete(&cut, &image), cut);
    }

    #[test]
    fn leaves_the_gap_between_touching_serifs_open() {
        let mut sheet = Sheet::new(60, 40);
        sheet.fill(10, 20, 25, 21, 1.0);
        sheet.fill(27, 20, 42, 21, 1.0);
        let image = sheet.scan(&SOFT);
        let cut = threshold(&image);
        assert_eq!(
            component_count(&cut),
            2,
            "the midpoint must keep the gap open"
        );

        assert_eq!(complete(&cut, &image), cut);
    }

    #[test]
    fn restores_a_hairline_from_a_blurred_scan() {
        // A softer scan spreads the hairline over more rows; only its valley
        // row comes back.
        let image = joined_stems(1.0, &SOFT);
        let cut = threshold(&image);
        assert!(
            component_count(&cut) > 1,
            "the midpoint must drop the hairline"
        );

        let completed = complete(&cut, &image);

        assert_eq!(component_count(&completed), 1);
        for y in 0..60 {
            for x in 0..80 {
                if completed.get(x, y) && !cut.get(x, y) {
                    assert_eq!(y, 14, "added ink at ({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn restores_a_hairline_that_runs_beside_a_gray_shoulder() {
        // A weakly printed stem rises only a little on the side where the
        // glyph's own blur lies; it is still a line.
        let mut sheet = Sheet::new(80, 60);
        sheet.fill(10, 10, 15, 50, 1.0);
        sheet.fill(50, 10, 55, 50, 1.0);
        sheet.fill(16, 11, 49, 13, 0.33);
        sheet.fill(16, 14, 49, 14, 0.525);
        let image = sheet.scan(&SHARP);
        let cut = threshold(&image);
        assert!(
            component_count(&cut) > 1,
            "the midpoint must drop the hairline"
        );
        let completed = complete(&cut, &image);
        assert_eq!(component_count(&completed), 1);
        for y in 0..60 {
            for x in 0..80 {
                if completed.get(x, y) && !cut.get(x, y) {
                    assert_eq!(y, 14, "added ink at ({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn leaves_shallow_show_through_between_stems_as_paper() {
        let image = joined_stems(0.3, &SHARP);
        let cut = threshold(&image);

        assert_eq!(complete(&cut, &image), cut);
    }
}
