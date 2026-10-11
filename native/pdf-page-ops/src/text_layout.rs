//! Glyph shaping and line breaking, shared by editing and print synthesis.

use super::*;
use harfrust::{Direction, ShapeOptions, Shaper, ShaperData, UnicodeBuffer};
use std::ops::Range;
use unicode_bidi::{BidiInfo, Level, ParagraphInfo};
use unicode_script::{Script, UnicodeScript};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug)]
pub(crate) struct Glyph {
    pub id: u16,
    pub font: usize,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug)]
pub(crate) struct Line {
    pub text: String,
    pub glyphs: Vec<Glyph>,
    pub width: f64,
    pub rtl: bool,
}

// Bidi runs may contain several scripts. HarfBuzz requires one script per run;
// Common/Inherited characters retain their surrounding script.
fn script_runs(text: &str, range: Range<usize>) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = range.start;
    let mut script = Script::Common;
    for (offset, character) in text[range.clone()].char_indices() {
        let next = character.script();
        if matches!(next, Script::Common | Script::Inherited) {
            continue;
        }
        if script != Script::Common && script != next {
            ranges.push(start..range.start + offset);
            start = range.start + offset;
        }
        script = next;
    }
    if start < range.end {
        ranges.push(start..range.end);
    }
    ranges
}

fn shape_line(
    fonts: &[(Shaper<'_>, FontRef<'_>)],
    space_advance: f64,
    text: &str,
    bidi: &BidiInfo<'_>,
    paragraph: &ParagraphInfo,
    range: Range<usize>,
    font_size: f64,
) -> Line {
    if range.is_empty() {
        return Line {
            text: String::new(),
            glyphs: Vec::new(),
            width: 0.0,
            rtl: paragraph.level.is_rtl(),
        };
    }
    let replacement_font = fonts
        .iter()
        .position(|(_, face)| face.charmap().map('�').is_some())
        .unwrap_or(0);
    let logical_text = &text[range.clone()];
    let show_hyphen = range.end < text.len() && logical_text.ends_with('\u{00ad}');
    let rendered_text = if show_hyphen {
        format!("{}-", logical_text.trim_end_matches('\u{00ad}'))
    } else {
        logical_text.to_string()
    };
    let text = rendered_text.as_str();
    // Preserve paragraph-resolved levels across wraps, but only copy the line
    // being measured. visual_runs otherwise copies the entire paragraph for
    // every width probe, which becomes quadratic in narrow text boxes.
    let line_paragraph = ParagraphInfo {
        range: 0..text.len(),
        level: paragraph.level,
    };
    let line_bidi = BidiInfo {
        text,
        original_classes: bidi.original_classes[range.start..range.start + text.len()].to_vec(),
        levels: bidi.levels[range.start..range.start + text.len()].to_vec(),
        paragraphs: vec![line_paragraph.clone()],
    };
    let mut glyphs = Vec::new();
    let mut advance = 0.0;
    let (levels, runs) = line_bidi.visual_runs(&line_paragraph, 0..text.len());
    for run in runs {
        let rtl = levels[run.start].is_rtl();
        let mut scripts = script_runs(text, run);
        if rtl {
            scripts.reverse();
        }
        for script in scripts {
            // Select one font for the whole word, including joining controls
            // and marks. Partial document fonts must not split shaping context.
            let mut font_runs: Vec<(usize, String)> = Vec::new();
            for sequence in text[script].split_inclusive(char::is_whitespace) {
                let sequence: String = sequence
                    .chars()
                    .map(|c| {
                        if fonts
                            .iter()
                            .any(|(_, face)| invisible(c) || face.charmap().map(c).is_some())
                        {
                            c
                        } else {
                            '�'
                        }
                    })
                    .collect();
                let supported = fonts.iter().position(|(_, face)| {
                    sequence
                        .chars()
                        .all(|c| invisible(c) || face.charmap().map(c).is_some())
                });
                for character in sequence.chars() {
                    let index = supported.or_else(|| {
                        fonts.iter().position(|(_, face)| {
                            invisible(character) || face.charmap().map(character).is_some()
                        })
                    });
                    let (index, character) =
                        index.map_or((replacement_font, '�'), |i| (i, character));
                    if let Some((_, run)) = font_runs.last_mut().filter(|(i, _)| *i == index) {
                        run.push(character);
                    } else {
                        font_runs.push((index, character.to_string()));
                    }
                }
            }
            if rtl {
                font_runs.reverse();
            }
            for (index, segment) in font_runs {
                let font = &fonts[index].0;
                let scale = font_size / f64::from(font.units_per_em());
                let mut buffer = UnicodeBuffer::new();
                buffer.push_str(&segment);
                buffer.guess_segment_properties();
                buffer.set_direction(if rtl {
                    Direction::RightToLeft
                } else {
                    Direction::LeftToRight
                });
                let shaped = font.shape(buffer, ShapeOptions::default());
                for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
                    if segment.as_bytes().get(info.cluster as usize) == Some(&b'\t') {
                        let tab_stop = 4.0 * space_advance * scale;
                        if tab_stop > 0.0 {
                            advance = ((advance / tab_stop).floor() + 1.0) * tab_stop;
                        }
                        continue;
                    }
                    glyphs.push(Glyph {
                        id: info.glyph_id as u16,
                        font: index,
                        x: advance + f64::from(position.x_offset) * scale,
                        y: f64::from(position.y_offset) * scale,
                    });
                    advance += f64::from(position.x_advance) * scale;
                }
            }
        }
    }
    Line {
        text: logical_text.to_string(),
        glyphs,
        width: advance,
        rtl: paragraph.level.is_rtl(),
    }
}

pub(crate) fn layout(text: &str, width: f64, font_size: f64) -> Vec<Line> {
    let face = face();
    static DATA: std::sync::OnceLock<ShaperData> = std::sync::OnceLock::new();
    let shaper = DATA
        .get_or_init(|| ShaperData::new(&face))
        .shaper(&face)
        .build();
    layout_shaped(text, width, font_size, &[(shaper, face)], None)
}

pub(crate) fn layout_with_fonts(
    text: &str,
    width: f64,
    font_size: f64,
    programs: &[&[u8]],
) -> Vec<Line> {
    let faces: Vec<_> = programs
        .iter()
        .map(|bytes| FontRef::from_index(bytes, 0).expect("resolved font program"))
        .collect();
    let data: Vec<_> = faces.iter().map(ShaperData::new).collect();
    let shapers: Vec<_> = faces
        .iter()
        .zip(&data)
        .map(|(face, data)| (data.shaper(face).build(), face.clone()))
        .collect();
    // AP-less FreeText uses the viewer's left-to-right canvas paragraph while
    // retaining RTL glyph runs. Editor layout above keeps its auto direction.
    layout_shaped(text, width, font_size, &shapers, Some(Level::ltr()))
}

fn layout_shaped(
    text: &str,
    width: f64,
    font_size: f64,
    shapers: &[(Shaper<'_>, FontRef<'_>)],
    paragraph_level: Option<Level>,
) -> Vec<Line> {
    let font = &shapers[0].1;
    let glyph_metrics = font.glyph_metrics(Size::unscaled(), LocationRef::default());
    let space_advance = f64::from(
        font.charmap()
            .map(' ')
            .and_then(|id| glyph_metrics.advance_width(id))
            .unwrap_or(0.0),
    );
    wrap(
        text,
        width,
        paragraph_level,
        |text, bidi, paragraph, range| {
            shape_line(
                shapers,
                space_advance,
                text,
                bidi,
                paragraph,
                range,
                font_size,
            )
        },
    )
}

pub(crate) fn layout_simple(text: &str, width: f64, size: f64, advances: &[f64; 128]) -> Vec<Line> {
    wrap(
        text,
        width,
        Some(Level::ltr()),
        |text, _, paragraph, range| {
            let text = &text[range];
            Line {
                text: text.to_string(),
                glyphs: Vec::new(),
                width: text
                    .bytes()
                    .map(|c| advances[usize::from(c)] * size / 1000.0)
                    .sum(),
                rtl: paragraph.level.is_rtl(),
            }
        },
    )
}

fn wrap(
    text: &str,
    width: f64,
    paragraph_level: Option<Level>,
    shape: impl Fn(&str, &BidiInfo<'_>, &ParagraphInfo, Range<usize>) -> Line,
) -> Vec<Line> {
    // Match CSS segment-break normalization. Contents retains the original text.
    let normalized = text
        .replace("\r\n", "\n")
        .replace(['\r', '\u{2028}', '\u{2029}'], "\n");
    let mut result = Vec::new();
    for paragraph_text in normalized.split('\n') {
        if paragraph_text.is_empty() {
            result.push(Line {
                text: String::new(),
                glyphs: Vec::new(),
                width: 0.0,
                rtl: false,
            });
            continue;
        }
        let bidi = BidiInfo::new(paragraph_text, paragraph_level);
        let paragraph = &bidi.paragraphs[0];
        let boundaries: Vec<usize> = paragraph_text
            .grapheme_indices(true)
            .map(|(offset, _)| offset)
            .chain(std::iter::once(paragraph_text.len()))
            .collect();
        let breaks: HashSet<usize> = unicode_linebreak::linebreaks(paragraph_text)
            .map(|(offset, _)| offset)
            .collect();
        let mut start = 0;
        while start + 1 < boundaries.len() {
            let fits = |end: usize| {
                let trimmed = paragraph_text[boundaries[start]..boundaries[end]]
                    .trim_end_matches([' ', '\t']);
                shape(
                    paragraph_text,
                    &bidi,
                    paragraph,
                    boundaries[start]..boundaries[start] + trimmed.len(),
                )
                .width
                    <= width
            };
            // Exponential search keeps a 64 KiB paragraph in a narrow box linear
            // in paragraph size, rather than reshaping its entire tail per line.
            let mut fit = start + 1;
            let mut probe = fit;
            let last = boundaries.len() - 1;
            while probe < last && fits(probe) {
                fit = probe;
                probe = (start + 2 * (probe - start)).min(last);
            }
            if fits(probe) {
                fit = probe;
            } else {
                let mut upper = probe;
                while fit + 1 < upper {
                    let middle = fit + (upper - fit) / 2;
                    if fits(middle) {
                        fit = middle;
                    } else {
                        upper = middle;
                    }
                }
            }
            let end = if fit == last {
                last
            } else {
                (start + 1..=fit)
                    .rev()
                    .find(|index| breaks.contains(&boundaries[*index]))
                    .unwrap_or(fit)
            };
            result.push(shape(
                paragraph_text,
                &bidi,
                paragraph,
                boundaries[start]..boundaries[end],
            ));
            start = end;
        }
    }
    result
}
