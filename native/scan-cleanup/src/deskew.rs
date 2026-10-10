use crate::engine::prepare::build_analysis_level;
use scan_primitives::{
    morphology::{open, reconstruct_binary},
    threshold::{otsu_threshold, threshold_global},
    BinaryImage, GrayImage,
};

const LOW_SCORE_FLOOR: f64 = 1_000.0;
const ACCEPTANCE_CONFIDENCE: f64 = 2.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DeskewResult {
    pub angle_degrees: f64,
    pub confidence: f64,
    pub accepted: bool,
}

pub fn detect_skew(source: &GrayImage, dpi: f64) -> DeskewResult {
    let working = build_analysis_level(source, dpi, 150.0).image;
    let binary = threshold_global(&working, otsu_threshold(&working));
    let shadow_seed = open(&binary, 75, 5);
    let without_shadows = binary.subtract(&reconstruct_binary(&shadow_seed, &binary));
    score_skew(&without_shadows)
}

pub fn score_skew(binary: &BinaryImage) -> DeskewResult {
    let ink_points = collect_ink_points(binary);
    if ink_points.len() < 32 {
        return DeskewResult::default();
    }
    let coarse: Vec<(f64, f64)> = (-7..=7)
        .map(|angle| {
            (
                f64::from(angle),
                projection_score_points(
                    binary.width(),
                    binary.height(),
                    &ink_points,
                    f64::from(angle),
                ),
            )
        })
        .collect();
    let average = coarse.iter().map(|entry| entry.1).sum::<f64>() / coarse.len() as f64;
    let &(mut best_angle, mut best_score) = coarse
        .iter()
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .unwrap();
    let mut step = 0.5;
    for _ in 0..10 {
        for candidate in [best_angle - step, best_angle + step] {
            if !(-7.0..=7.0).contains(&candidate) {
                continue;
            }
            let score =
                projection_score_points(binary.width(), binary.height(), &ink_points, candidate);
            if score > best_score {
                best_angle = candidate;
                best_score = score;
            }
        }
        step *= 0.5;
    }
    let confidence = if best_score > LOW_SCORE_FLOOR && average > 0.0 {
        best_score / average - 1.0
    } else {
        0.0
    };
    let accepted = confidence >= ACCEPTANCE_CONFIDENCE;
    DeskewResult {
        angle_degrees: if accepted { -best_angle } else { 0.0 },
        confidence,
        accepted,
    }
}

#[cfg(test)]
fn projection_score(binary: &BinaryImage, correction_degrees: f64) -> f64 {
    let ink_points = collect_ink_points(binary);
    projection_score_points(
        binary.width(),
        binary.height(),
        &ink_points,
        correction_degrees,
    )
}

fn collect_ink_points(binary: &BinaryImage) -> Vec<(usize, usize)> {
    let mut points = Vec::with_capacity(binary.count_black());
    for y in 0..binary.height() {
        let row_start = y * binary.words_per_line();
        for (word_x, &packed) in binary.words()[row_start..row_start + binary.words_per_line()]
            .iter()
            .enumerate()
        {
            let mut remaining = packed;
            while remaining != 0 {
                let bit_x = remaining.leading_zeros() as usize;
                points.push((word_x * 32 + bit_x, y));
                remaining &= !(1 << (31 - bit_x));
            }
        }
    }
    points
}

fn projection_score_points(
    width: usize,
    height: usize,
    ink_points: &[(usize, usize)],
    correction_degrees: f64,
) -> f64 {
    let tangent = correction_degrees.to_radians().tan();
    let center_x = width as f64 * 0.5;
    let padding = (width as f64 * 7.0f64.to_radians().tan()).ceil() as isize + 2;
    let mut profile = vec![0u32; height + (padding * 2) as usize];
    for &(x, y) in ink_points {
        let shifted = (y as f64 + tangent * (x as f64 - center_x)).round() as isize + padding;
        if shifted >= 0 && shifted < profile.len() as isize {
            profile[shifted as usize] += 1;
        }
    }
    profile
        .windows(2)
        .map(|rows| {
            let difference = f64::from(rows[1]) - f64::from(rows[0]);
            difference * difference
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_page(width: usize, height: usize) -> BinaryImage {
        let mut page = BinaryImage::new(width, height);
        for line in 0..10 {
            let top = 20 + line * 18;
            for word in 0..6 {
                let left = 16 + word * 28 + line % 3;
                let word_width = 17 + (word * 7 + line) % 9;
                for y in top..top + 5 {
                    for x in left..(left + word_width).min(width - 5) {
                        page.set(x, y, true);
                    }
                }
            }
        }
        page
    }

    fn rotate(source: &BinaryImage, angle_degrees: f64) -> BinaryImage {
        let mut output = BinaryImage::new(source.width(), source.height());
        let angle = angle_degrees.to_radians();
        let (sine, cosine) = angle.sin_cos();
        let cx = source.width() as f64 * 0.5;
        let cy = source.height() as f64 * 0.5;
        for y in 0..output.height() {
            for x in 0..output.width() {
                let dx = x as f64 - cx;
                let dy = y as f64 - cy;
                let sx = cosine * dx + sine * dy + cx;
                let sy = -sine * dx + cosine * dy + cy;
                if sx >= 0.0
                    && sy >= 0.0
                    && sx < source.width() as f64
                    && sy < source.height() as f64
                {
                    output.set(
                        x,
                        y,
                        source.get(
                            sx.round().min((source.width() - 1) as f64) as usize,
                            sy.round().min((source.height() - 1) as f64) as usize,
                        ),
                    );
                }
            }
        }
        output
    }

    #[test]
    fn recovers_known_rotation_with_high_confidence() {
        let page = rotate(&text_page(220, 220), 3.25);
        let result = score_skew(&page);
        assert!(result.accepted, "confidence={}", result.confidence);
        assert!(
            (result.angle_degrees - 3.25).abs() <= 0.15,
            "angle={}",
            result.angle_degrees
        );
        let coarse_mean = (-7..=7)
            .map(|angle| projection_score(&page, f64::from(angle)))
            .sum::<f64>()
            / 15.0;
        let best_score = projection_score(&page, -result.angle_degrees);
        assert!((result.confidence - (best_score / coarse_mean - 1.0)).abs() < 1e-8);
    }

    #[test]
    fn rejects_low_information_page() {
        let result = score_skew(&BinaryImage::new(100, 100));
        assert!(!result.accepted);
        assert_eq!(result.angle_degrees, 0.0);
    }

    #[test]
    fn absolute_score_floor_rejects_a_flat_low_energy_profile() {
        let mut page = BinaryImage::new(160, 160);
        for index in 0..40 {
            page.set(20 + index * 3, 20 + index * 3, true);
        }
        let maximum_score = (-7..=7)
            .map(|angle| projection_score(&page, f64::from(angle)))
            .fold(0.0, f64::max);
        assert!(maximum_score <= LOW_SCORE_FLOOR, "score={maximum_score}");
        let result = score_skew(&page);
        assert!(!result.accepted);
        assert_eq!(result.confidence, 0.0);
        assert_eq!(result.angle_degrees, 0.0);
    }
}
