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

fn fill(image: &mut GrayImage, x: std::ops::Range<usize>, y: std::ops::Range<usize>, value: u8) {
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
fn keeps_a_blurred_faint_stroke_and_its_tone() {
    let mut page = GrayImage::new(400, 400, 255);
    for y in 40..360 {
        for x in 150..250 {
            let distance = x as f64 - 200.0;
            let shade = (35.0 * (-distance * distance / 32.0).exp()).round() as u8;
            page.set(x, y, 255 - shade);
        }
    }
    let original = page.clone();

    whiten_unmarked_paper(&mut page, None, calibration(), 150.0);

    for y in 40..360 {
        for x in 191..210 {
            assert_eq!(
                page.get(x, y),
                original.get(x, y),
                "blurred ink lost at ({x}, {y})"
            );
        }
    }
    assert_eq!(page.get(200, 200), 220, "the faint core was whitened");
    assert_eq!(page.get(100, 200), 255, "paper away from the stroke stayed");
}

#[test]
fn keeps_a_faint_stroke_with_smoothly_blurred_ends() {
    let mut page = GrayImage::new(400, 400, 255);
    for y in 0..400 {
        for x in 150..250 {
            let across = x as f64 - 200.0;
            let end = (60.0 - y as f64).max(y as f64 - 340.0).max(0.0);
            let shade = (35.0 * (-(across * across + end * end) / 32.0).exp()).round() as u8;
            page.set(x, y, 255 - shade);
        }
    }
    let original = page.clone();

    whiten_unmarked_paper(&mut page, None, calibration(), 150.0);

    for y in 60..341 {
        for x in 191..210 {
            assert_eq!(
                page.get(x, y),
                original.get(x, y),
                "soft ink lost at ({x}, {y})"
            );
        }
    }
    assert_eq!(page.get(100, 200), 255, "paper away from the stroke stayed");
}

#[test]
fn whitens_a_broad_binding_gradient_beside_heading_sized_text() {
    let mut page = GrayImage::new(240, 220, 255);
    for top in [20, 80, 140] {
        for y in top..top + 50 {
            let depth = (y - top).min(top + 49 - y).min(12) as f64 / 12.0;
            for x in 0..100 {
                let distance = x as f64 - 40.0;
                let shade = (35.0 * depth * (-distance * distance / 512.0).exp()).round() as u8;
                page.set(x, y, 255 - shade);
            }
        }
    }
    let heading = PageCalibration {
        x_height_px: 33.0,
        ..calibration()
    };

    whiten_unmarked_paper(&mut page, None, heading, 150.0);

    assert!(
        page.data().iter().all(|&value| value == 255),
        "broad binding shading stayed"
    );
}

#[test]
fn an_isolated_dust_speck_does_not_preserve_a_broad_paper_cloud() {
    let mut page = GrayImage::new(400, 400, 255);
    for y in 0..400 {
        for x in 0..400 {
            let distance = (x as f64 - 200.0).hypot(y as f64 - 200.0);
            let shade = (35.0 * (-distance * distance / 3200.0).exp()).round() as u8;
            page.set(x, y, 255 - shade);
        }
    }
    page.set(200, 200, 60);

    whiten_unmarked_paper(&mut page, None, calibration(), 150.0);

    assert!(
        page.data().iter().all(|&value| value == 255),
        "dust admitted the surrounding paper cloud"
    );
}

#[test]
fn keeps_every_pixel_of_a_filled_faint_rule() {
    for thickness in [22, 48] {
        let mut page = GrayImage::new(400, 400, 255);
        fill(&mut page, 60..340, 100..100 + thickness, 220);

        whiten_unmarked_paper(&mut page, None, calibration(), 150.0);

        for y in 100..100 + thickness {
            for x in 60..340 {
                assert_eq!(page.get(x, y), 220, "filled ink lost at ({x}, {y})");
            }
        }
        assert_eq!(page.get(200, 150), 255, "paper away from the rule stayed");
    }
}

#[test]
fn whitens_a_full_height_scanner_strip_on_the_raster_edge() {
    let mut page = GrayImage::new(1000, 1000, 250);
    // A scanner strip many strokes wide down the right edge, whose shading the
    // picture owner also covers, and a glyph block inside the leaf that must stay.
    fill(&mut page, 986..1000, 5..995, 120);
    fill(&mut page, 300..310, 300..340, 30);
    let mut picture = BinaryImage::new(1000, 1000);
    for y in 5..995 {
        for x in 986..1000 {
            picture.set(x, y, true);
        }
    }

    whiten_unmarked_paper(&mut page, Some(&picture), calibration(), 150.0);

    for y in 0..1000 {
        for x in 986..1000 {
            assert_eq!(page.get(x, y), 255, "scanner strip stayed at ({x}, {y})");
        }
    }
    for y in 300..340 {
        for x in 300..310 {
            assert_eq!(page.get(x, y), 30, "glyph lost its tone at ({x}, {y})");
        }
    }
}

#[test]
fn keeps_an_authored_frame_rule_and_picture_pixels_short_of_the_full_height() {
    let mut page = GrayImage::new(400, 400, 255);
    // A frame rule more than two strokes wide beside the left edge, and a picture
    // owner's dark edge band. Both stop short of the page's height: neither is a
    // scanner strip.
    fill(&mut page, 10..18, 50..350, 80);
    fill(&mut page, 0..8, 100..300, 60);
    let mut picture = BinaryImage::new(400, 400);
    for y in 100..300 {
        for x in 0..8 {
            picture.set(x, y, true);
        }
    }
    let original = page.clone();

    whiten_unmarked_paper(&mut page, Some(&picture), calibration(), 150.0);

    for y in 50..350 {
        for x in 10..18 {
            assert_eq!(
                page.get(x, y),
                original.get(x, y),
                "frame rule lost at ({x}, {y})"
            );
        }
    }
    for y in 100..300 {
        for x in 0..8 {
            assert_eq!(
                page.get(x, y),
                original.get(x, y),
                "picture pixel changed at ({x}, {y})"
            );
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
