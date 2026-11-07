//! Source rasters of admitted scan painting programs, pixel for pixel as
//! desktop's bundled `pdftoppm` renders them.
//!
//! Desktop rasterizes a source page with Poppler before cleanup; the browser
//! must hand cleanup the same pixels, or detection, Auto's choice and lossless
//! placement drift. This module covers only the painting programs a scan
//! actually uses: axis-aligned, positively scaled images and image stencils,
//! with an optional same-size one-bit soft mask, painted normally and opaquely
//! onto the page. Its arithmetic follows the measured behavioural contract
//! written for this purpose (exact integer sums and fixed-point divisors,
//! binary64 recurrences, the fused bilinear step, the two paper flattening
//! rules); anything outside it is [`SourceRasterError::Unsupported`], and the
//! caller renders that page with its general renderer instead.

use std::fmt;

/// 2^23, the fixed-point scale of the averaging divisors.
const FIXED_POINT_ONE: u64 = 1 << 23;
/// The largest averaging group whose byte sum fits an unsigned 32-bit sum.
const MAX_GROUP_PIXELS: u64 = 16_843_009;
/// The smallest admitted placement determinant magnitude.
const MIN_DETERMINANT: f64 = 0.000_001;

/// Why a page has no source raster here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceRasterError {
    /// A valid program this module does not reproduce; use the general renderer.
    Unsupported(&'static str),
    /// The request itself is malformed.
    Invalid(String),
    /// The raster or one of its planes exceeds the admitted budget.
    TooLarge(String),
}

impl fmt::Display for SourceRasterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(reason) => write!(formatter, "unsupported scan raster: {reason}"),
            Self::Invalid(reason) => write!(formatter, "invalid scan raster request: {reason}"),
            Self::TooLarge(reason) => write!(formatter, "scan raster too large: {reason}"),
        }
    }
}

impl std::error::Error for SourceRasterError {}

type Result<T> = std::result::Result<T, SourceRasterError>;

/// A PDF affine six-tuple `[a, b, c, d, e, f]`: `x' = a x + c y + e`, `y' = b x + d y + f`.
pub type Affine = [f64; 6];

/// How the page is resolved, as `pdftoppm -r` or `-scale-to` request it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Resolution {
    Dpi(f64),
    ScaleTo(u32),
}

/// An integer region of the rotated, scaled page in top-down device pixels;
/// a zero width or height means the rest of the page in that axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slice {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The page box the raster covers and its rotation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageBox {
    /// `[left, bottom, right, top]` of the selected (crop or media) box.
    pub rect: [f64; 4],
    /// 0, 90, 180 or 270.
    pub rotation: u16,
}

/// The output bitmap and the PDF-user-space to top-down device transform.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageGrid {
    pub width: usize,
    pub height: usize,
    pub device: Affine,
}

/// The output bitmap and device transform for a page box, resolution and slice.
pub fn page_grid(page: PageBox, resolution: Resolution, slice: Option<Slice>) -> Result<PageGrid> {
    let [left, bottom, right, top] = page.rect;
    if !page.rect.iter().all(|value| value.is_finite()) || right <= left || top <= bottom {
        return Err(SourceRasterError::Invalid(
            "page box must be finite and ordered".into(),
        ));
    }
    let rotated = match page.rotation {
        0 | 180 => false,
        90 | 270 => true,
        _ => {
            return Err(SourceRasterError::Unsupported(
                "page rotation is not a quarter turn",
            ))
        }
    };
    let (point_width, point_height) = (right - left, top - bottom);
    // The unrotated extent, as the utility evaluates it.
    let (dpi, mut extent_width, mut extent_height) = match resolution {
        Resolution::Dpi(dpi) => {
            if !(dpi.is_finite() && dpi > 0.0) {
                return Err(SourceRasterError::Invalid(
                    "resolution must be positive".into(),
                ));
            }
            (dpi, (point_width * dpi) / 72.0, (point_height * dpi) / 72.0)
        }
        Resolution::ScaleTo(pixels) => {
            if pixels == 0 {
                return Err(SourceRasterError::Invalid(
                    "scale-to must be positive".into(),
                ));
            }
            let pixels = f64::from(pixels);
            let dpi = (72.0 * pixels) / point_width.max(point_height);
            if point_width > point_height {
                (dpi, pixels, point_height * (dpi / 72.0))
            } else {
                (dpi, point_width * (dpi / 72.0), pixels)
            }
        }
    };
    if rotated {
        std::mem::swap(&mut extent_width, &mut extent_height);
    }
    let full_width = ceil_pixels(extent_width)?;
    let full_height = ceil_pixels(extent_height)?;
    let (x, y, width, height) = match slice {
        None => (0, 0, full_width, full_height),
        Some(slice) => {
            let (x, y) = (slice.x as usize, slice.y as usize);
            if x >= full_width || y >= full_height {
                return Err(SourceRasterError::Invalid(
                    "slice starts outside the page".into(),
                ));
            }
            let clamp =
                |offset: usize, requested: u32, full: usize, extent: f64| -> Result<usize> {
                    let requested = if requested == 0 {
                        full
                    } else {
                        requested as usize
                    };
                    if (offset + requested) as f64 > extent {
                        ceil_pixels(extent - offset as f64)
                    } else {
                        Ok(requested)
                    }
                };
            (
                x,
                y,
                clamp(x, slice.width, full_width, extent_width)?,
                clamp(y, slice.height, full_height, extent_height)?,
            )
        }
    };
    // The PDF-space box of the slice, then the device transform built from it.
    let r = 72.0 / dpi;
    let (sx, sy, sxu, syv) = (x as f64, y as f64, (x + width) as f64, (y + height) as f64);
    let [l, b, rgt, t] = match page.rotation {
        0 => [left + r * sx, top - r * syv, left + r * sxu, top - r * sy],
        90 => [
            left + r * sy,
            bottom + r * sx,
            left + r * syv,
            bottom + r * sxu,
        ],
        180 => [
            right - r * sxu,
            bottom + r * sy,
            right - r * sx,
            bottom + r * syv,
        ],
        _ => [right - r * syv, top - r * sxu, right - r * sy, top - r * sx],
    };
    let s = dpi / 72.0;
    let device = match page.rotation {
        0 => [s, 0.0, 0.0, -s, -s * l, s * t],
        90 => [0.0, s, s, 0.0, -s * b, -s * l],
        180 => [-s, 0.0, 0.0, s, s * rgt, -s * b],
        _ => [0.0, -s, -s, 0.0, s * t, s * rgt],
    };
    Ok(PageGrid {
        width,
        height,
        device,
    })
}

fn ceil_pixels(extent: f64) -> Result<usize> {
    let pixels = extent.ceil();
    if !(pixels.is_finite() && pixels >= 1.0 && pixels <= f64::from(u32::MAX)) {
        return Err(SourceRasterError::Invalid(
            "page extent is empty or unbounded".into(),
        ));
    }
    Ok(pixels as usize)
}

/// A decoded source plane at its original size: one gray byte or three RGB
/// bytes per pixel, rows top to bottom, after the PDF Decode map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plane {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub samples: Vec<u8>,
    pub interpolate: bool,
}

/// One paint of the admitted program, in painting order.
#[derive(Debug, Clone, PartialEq)]
pub enum Paint {
    /// An image painted opaquely, or through its own same-size gray soft mask.
    Image {
        image: Plane,
        soft_mask: Option<Plane>,
        /// The image unit square's placement in PDF user space.
        placement: Affine,
    },
    /// An image stencil: one coverage byte (0 or 1) per source pixel, painted in `fill`.
    Stencil {
        coverage: Plane,
        fill: [u8; 3],
        placement: Affine,
    },
}

/// The page raster for an admitted paint program: `width * height * 3` RGB bytes.
pub fn rasterize(grid: &PageGrid, paints: &[Paint], max_pixels: usize) -> Result<Vec<u8>> {
    let pixels = grid
        .width
        .checked_mul(grid.height)
        .filter(|&pixels| pixels <= max_pixels)
        .ok_or_else(|| {
            SourceRasterError::TooLarge("page raster exceeds its pixel budget".into())
        })?;
    let mut page = Page {
        width: grid.width,
        height: grid.height,
        color: vec![255; pixels * 3],
        alpha: vec![0; pixels],
    };
    for paint in paints {
        match paint {
            Paint::Image {
                image,
                soft_mask,
                placement,
            } => {
                validate_plane(image, &[1, 3])?;
                let target = Target::new(grid, *placement)?;
                let color = target.scale(image, ScaleRule::Image)?;
                match soft_mask {
                    None => page.paint_opaque(&target, &color, image.channels),
                    Some(mask) => {
                        validate_plane(mask, &[1])?;
                        if (mask.width, mask.height) != (image.width, image.height) {
                            return Err(SourceRasterError::Unsupported(
                                "soft mask differs from its image in size",
                            ));
                        }
                        let alpha = target.scale(mask, ScaleRule::Image)?;
                        page.paint_masked(&target, &alpha, |index| {
                            pixel_color(&color, image.channels, index)
                        })?;
                    }
                }
            }
            Paint::Stencil {
                coverage,
                fill,
                placement,
            } => {
                validate_plane(coverage, &[1])?;
                if coverage.samples.iter().any(|&sample| sample > 1) {
                    return Err(SourceRasterError::Invalid(
                        "stencil coverage must be 0 or 1".into(),
                    ));
                }
                let target = Target::new(grid, *placement)?;
                let alpha = target.scale(coverage, ScaleRule::Stencil)?;
                page.paint_masked(&target, &alpha, |_| *fill)?;
            }
        }
    }
    Ok(page.flatten())
}

fn validate_plane(plane: &Plane, channels: &[usize]) -> Result<()> {
    if !channels.contains(&plane.channels) || plane.width == 0 || plane.height == 0 {
        return Err(SourceRasterError::Invalid(
            "plane has no pixels or an unsupported layout".into(),
        ));
    }
    let expected = plane
        .width
        .checked_mul(plane.height)
        .and_then(|pixels| pixels.checked_mul(plane.channels));
    if expected != Some(plane.samples.len()) {
        return Err(SourceRasterError::Invalid(
            "plane samples do not match its size".into(),
        ));
    }
    Ok(())
}

fn pixel_color(values: &[u8], channels: usize, index: usize) -> [u8; 3] {
    if channels == 1 {
        let gray = values[index];
        [gray, gray, gray]
    } else {
        [
            values[index * 3],
            values[index * 3 + 1],
            values[index * 3 + 2],
        ]
    }
}

/// Where a plane lands: its whole integer rectangle in device pixels, and
/// the part of it inside the bitmap. Scaling covers the whole rectangle;
/// only the visible part is produced.
struct Target {
    /// Rectangle origin in device pixels (may be negative).
    left: i64,
    top: i64,
    width: usize,
    height: usize,
    /// Visible window, in rectangle-local coordinates.
    visible_x: std::ops::Range<usize>,
    visible_y: std::ops::Range<usize>,
}

impl Target {
    fn new(grid: &PageGrid, placement: Affine) -> Result<Self> {
        if !placement.iter().all(|value| value.is_finite()) {
            return Err(SourceRasterError::Invalid(
                "placement must be finite".into(),
            ));
        }
        let [a, b, c, d, e, f] = compose(grid.device, placement);
        // The top-down sample matrix of an image whose first row is its top row.
        let (scale_x, shear_y, shear_x, scale_y) = (a, b, -c, -d);
        let (origin_x, origin_y) = (c + e, d + f);
        if shear_y != 0.0 || shear_x != 0.0 || !(scale_x > 0.0 && scale_y > 0.0) {
            return Err(SourceRasterError::Unsupported(
                "image placement is not a positive axis-aligned scale",
            ));
        }
        if !(scale_x * scale_y).is_finite() || (scale_x * scale_y).abs() < MIN_DETERMINANT {
            return Err(SourceRasterError::Unsupported(
                "image placement is degenerate",
            ));
        }
        let edge = |value: f64| -> Result<i64> {
            let value = value.floor();
            if value.abs() > f64::from(i32::MAX) {
                return Err(SourceRasterError::TooLarge(
                    "image rectangle is unbounded".into(),
                ));
            }
            Ok(value as i64)
        };
        let (left, top) = (edge(origin_x)?, edge(origin_y)?);
        let right = edge(scale_x + origin_x)? + 1;
        let bottom = edge(scale_y + origin_y)? + 1;
        let (width, height) = ((right - left) as usize, (bottom - top) as usize);
        let visible = |origin: i64, length: usize, bitmap: usize| {
            let start = (-origin).clamp(0, length as i64) as usize;
            let end = (bitmap as i64 - origin).clamp(0, length as i64) as usize;
            start..end.max(start)
        };
        Ok(Self {
            left,
            top,
            width,
            height,
            visible_x: visible(left, width, grid.width),
            visible_y: visible(top, height, grid.height),
        })
    }

    fn visible_len(&self) -> usize {
        self.visible_x.len() * self.visible_y.len()
    }

    /// The page pixel index of a visible rectangle-local pixel.
    fn page_index(&self, page_width: usize, x: usize, y: usize) -> usize {
        (self.top + y as i64) as usize * page_width + (self.left + x as i64) as usize
    }

    /// Scales a plane to the whole rectangle and returns its visible window,
    /// row-major, `channels` bytes per pixel.
    fn scale(&self, plane: &Plane, rule: ScaleRule) -> Result<Vec<u8>> {
        let (source_width, source_height) = (plane.width, plane.height);
        let shrink = (self.width < source_width, self.height < source_height);
        let grow = (self.width >= source_width, self.height >= source_height);
        let mut output = vec![0; self.visible_len() * plane.channels];
        if output.is_empty() {
            return Ok(output);
        }
        match (shrink, grow, rule) {
            ((true, true), _, _) => self.average(plane, rule, &mut output)?,
            (_, (true, true), ScaleRule::Stencil) => self.replicate(plane, &mut output, 255),
            (_, (true, true), ScaleRule::Image) => {
                let replicate = !plane.interpolate
                    && (self.width / source_width >= 4 || self.height / source_height >= 4);
                if replicate {
                    self.replicate(plane, &mut output, 1);
                } else {
                    self.bilinear(plane, &mut output);
                }
            }
            _ => {
                return Err(SourceRasterError::Unsupported(
                    "plane shrinks in one axis and grows in the other",
                ))
            }
        }
        Ok(output)
    }

    /// Both axes shrink: whole source pixels per output pixel, zero phase,
    /// then the fixed-point divisor of the group's size.
    fn average(&self, plane: &Plane, rule: ScaleRule, output: &mut [u8]) -> Result<()> {
        let columns = partition(plane.width, self.width, &self.visible_x);
        let rows = partition(plane.height, self.height, &self.visible_y);
        let channels = plane.channels;
        let numerator = match rule {
            ScaleRule::Image => FIXED_POINT_ONE,
            ScaleRule::Stencil => 255 * FIXED_POINT_ONE,
        };
        let mut sums = vec![0u64; channels];
        for (out_y, row_group) in rows.iter().enumerate() {
            for (out_x, column_group) in columns.iter().enumerate() {
                let count = (row_group.len() * column_group.len()) as u64;
                if count == 0 || count > MAX_GROUP_PIXELS {
                    return Err(SourceRasterError::Unsupported(
                        "averaging group size is out of range",
                    ));
                }
                sums.fill(0);
                for source_y in row_group.clone() {
                    let row = &plane.samples[source_y * plane.width * channels..];
                    for source_x in column_group.clone() {
                        for channel in 0..channels {
                            sums[channel] += u64::from(row[source_x * channels + channel]);
                        }
                    }
                }
                let divisor = numerator / count;
                let base = (out_y * self.visible_x.len() + out_x) * channels;
                for channel in 0..channels {
                    output[base + channel] = ((sums[channel] * divisor) / FIXED_POINT_ONE) as u8;
                }
            }
        }
        Ok(())
    }

    /// Both axes grow, without interpolation, by at least four in an axis (or
    /// always, for stencil coverage): each source pixel fills its zero-phase run.
    fn replicate(&self, plane: &Plane, output: &mut [u8], gain: u8) {
        let columns = runs(plane.width, self.width, &self.visible_x);
        let rows = runs(plane.height, self.height, &self.visible_y);
        let channels = plane.channels;
        for (out_y, &source_y) in rows.iter().enumerate() {
            let row = &plane.samples[source_y * plane.width * channels..];
            for (out_x, &source_x) in columns.iter().enumerate() {
                let base = (out_y * self.visible_x.len() + out_x) * channels;
                for channel in 0..channels {
                    output[base + channel] = row[source_x * channels + channel] * gain;
                }
            }
        }
    }

    /// Both axes grow otherwise: positions advance by repeated binary64
    /// addition from zero, each axis interpolates with the fused weighted
    /// sum, and each pass truncates to a byte, horizontally first.
    fn bilinear(&self, plane: &Plane, output: &mut [u8]) {
        let columns = positions(plane.width, self.width, &self.visible_x);
        let rows = positions(plane.height, self.height, &self.visible_y);
        let channels = plane.channels;
        let visible_width = self.visible_x.len();
        let expand = |source_y: usize, into: &mut Vec<u8>| {
            into.clear();
            let row = &plane.samples
                [source_y * plane.width * channels..(source_y + 1) * plane.width * channels];
            for &(index, next, fraction) in &columns {
                for channel in 0..channels {
                    into.push(weighted(
                        row[index * channels + channel],
                        row[next * channels + channel],
                        fraction,
                    ));
                }
            }
        };
        let (mut upper, mut lower) = (Vec::new(), Vec::new());
        let (mut upper_row, mut lower_row) = (usize::MAX, usize::MAX);
        for (out_y, &(index, next, fraction)) in rows.iter().enumerate() {
            if upper_row != index {
                if lower_row == index {
                    std::mem::swap(&mut upper, &mut lower);
                    lower_row = usize::MAX;
                } else {
                    expand(index, &mut upper);
                }
                upper_row = index;
            }
            if lower_row != next {
                expand(next, &mut lower);
                lower_row = next;
            }
            let base = out_y * visible_width * channels;
            for byte in 0..visible_width * channels {
                output[base + byte] = weighted(upper[byte], lower[byte], fraction);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScaleRule {
    Image,
    Stencil,
}

/// `content` applied first, then `device`.
fn compose(device: Affine, content: Affine) -> Affine {
    let [da, db, dc, dd, de, df] = device;
    let [ca, cb, cc, cd, ce, cf] = content;
    [
        da * ca + dc * cb,
        db * ca + dd * cb,
        da * cc + dc * cd,
        db * cc + dd * cd,
        da * ce + dc * cf + de,
        db * ce + dd * cf + df,
    ]
}

/// The source pixels averaged into each visible output index: the half-open
/// range `[floor(i * source / target), floor((i + 1) * source / target))`.
fn partition(
    source: usize,
    target: usize,
    visible: &std::ops::Range<usize>,
) -> Vec<std::ops::Range<usize>> {
    let bound = |index: usize| ((index as u128 * source as u128) / target as u128) as usize;
    visible
        .clone()
        .map(|index| bound(index)..bound(index + 1))
        .collect()
}

/// The source pixel each visible output index replicates: source pixel `k`
/// fills `[floor(k * target / source), floor((k + 1) * target / source))`.
fn runs(source: usize, target: usize, visible: &std::ops::Range<usize>) -> Vec<usize> {
    let start = |pixel: usize| ((pixel as u128 * target as u128) / source as u128) as usize;
    let mut sources = Vec::with_capacity(visible.len());
    let mut pixel = 0;
    for index in visible.clone() {
        while pixel + 1 < source && start(pixel + 1) <= index {
            pixel += 1;
        }
        sources.push(pixel);
    }
    sources
}

/// The interpolation endpoints and fraction of each visible output index.
/// Every position is the running binary64 sum of the step from zero, so the
/// recurrence runs over all indices before the visible window.
fn positions(
    source: usize,
    target: usize,
    visible: &std::ops::Range<usize>,
) -> Vec<(usize, usize, f64)> {
    let step = source as f64 / target as f64;
    let last = source - 1;
    let mut position = 0.0f64;
    let mut sampled = Vec::with_capacity(visible.len());
    for index in 0..visible.end {
        if index >= visible.start {
            let whole = position.floor();
            let pixel = (whole as usize).min(last);
            sampled.push((pixel, (pixel + 1).min(last), position - whole));
        }
        position += step;
    }
    sampled
}

/// `first * (1 - fraction) + second * fraction` with `1 - fraction` and
/// `second * fraction` each rounded, the remaining multiply-add fused into
/// one rounding, and the result truncated to a byte.
fn weighted(first: u8, second: u8, fraction: f64) -> u8 {
    let value = f64::from(first).mul_add(1.0 - fraction, f64::from(second) * fraction);
    value as u8
}

/// The page while painting: untouched pixels are transparent paper, an
/// opaque paint makes them opaque, and one partial paint over paper keeps its
/// color and coverage until the page is flattened.
struct Page {
    width: usize,
    height: usize,
    color: Vec<u8>,
    /// 0 untouched paper, 255 opaque, otherwise a partial paint's coverage.
    alpha: Vec<u8>,
}

impl Page {
    fn paint_opaque(&mut self, target: &Target, values: &[u8], channels: usize) {
        let visible_width = target.visible_x.len();
        for (y, local_y) in target.visible_y.clone().enumerate() {
            for (x, local_x) in target.visible_x.clone().enumerate() {
                let pixel = target.page_index(self.width, local_x, local_y);
                let color = pixel_color(values, channels, y * visible_width + x);
                self.color[pixel * 3..pixel * 3 + 3].copy_from_slice(&color);
                self.alpha[pixel] = 255;
            }
        }
    }

    fn paint_masked(
        &mut self,
        target: &Target,
        alpha: &[u8],
        color: impl Fn(usize) -> [u8; 3],
    ) -> Result<()> {
        let visible_width = target.visible_x.len();
        for (y, local_y) in target.visible_y.clone().enumerate() {
            for (x, local_x) in target.visible_x.clone().enumerate() {
                let index = y * visible_width + x;
                let coverage = alpha[index];
                if coverage == 0 {
                    continue;
                }
                let pixel = target.page_index(self.width, local_x, local_y);
                let foreground = color(index);
                match self.alpha[pixel] {
                    0 => {
                        self.color[pixel * 3..pixel * 3 + 3].copy_from_slice(&foreground);
                        self.alpha[pixel] = coverage;
                    }
                    255 => {
                        let inverse = u32::from(255 - coverage);
                        for (channel, &value) in foreground.iter().enumerate() {
                            let background = &mut self.color[pixel * 3 + channel];
                            *background = ((inverse * u32::from(*background)
                                + u32::from(coverage) * u32::from(value))
                                / 255) as u8;
                        }
                    }
                    _ => {
                        return Err(SourceRasterError::Unsupported("partial paints overlap"));
                    }
                }
            }
        }
        Ok(())
    }

    /// The bitmap over white paper: opaque pixels as painted, untouched paper
    /// white, and a partial paint flattened with the page-end rule.
    fn flatten(mut self) -> Vec<u8> {
        debug_assert_eq!(self.alpha.len(), self.width * self.height);
        for (pixel, &coverage) in self.alpha.iter().enumerate() {
            if coverage == 0 || coverage == 255 {
                continue;
            }
            let coverage = u32::from(coverage);
            for channel in &mut self.color[pixel * 3..pixel * 3 + 3] {
                let blended = (255 - coverage) * 255 + coverage * u32::from(*channel);
                *channel = ((blended + blended / 256 + 128) / 256) as u8;
            }
        }
        self.color
    }
}

/// Every measured `pdftoppm` vector reproduced byte for byte. Each fixture
/// holds a tiny page's decoded source planes, painting order and placements,
/// and the PPM the bundled Poppler 26.02.0 `pdftoppm` (macOS ARM64) rendered
/// for it; the raster must equal that PPM exactly.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::{fs, path::Path};

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/source-raster");

    fn numbers(value: &Value) -> Vec<f64> {
        value
            .as_array()
            .expect("number array")
            .iter()
            .map(|number| number.as_f64().expect("number"))
            .collect()
    }

    fn affine(value: &Value) -> Affine {
        numbers(value).try_into().expect("six-tuple")
    }

    fn plane(directory: &Path, layer: &Value, samples_key: &str, channels: usize) -> Plane {
        Plane {
            width: layer["width"].as_u64().unwrap() as usize,
            height: layer["height"].as_u64().unwrap() as usize,
            channels,
            samples: fs::read(directory.join(layer[samples_key].as_str().unwrap())).unwrap(),
            interpolate: layer["interpolate"].as_bool().unwrap(),
        }
    }

    fn channels(layer: &Value) -> usize {
        if layer["color_space"] == "DeviceRGB" {
            3
        } else {
            1
        }
    }

    fn ppm_pixels(bytes: &[u8]) -> (usize, usize, &[u8]) {
        // "P6\n<width> <height>\n255\n" followed by RGB bytes.
        let mut fields = Vec::new();
        let mut start = 0;
        let mut index = 0;
        while fields.len() < 4 {
            if bytes[index].is_ascii_whitespace() {
                if index > start {
                    fields.push(
                        std::str::from_utf8(&bytes[start..index])
                            .unwrap()
                            .to_owned(),
                    );
                }
                start = index + 1;
            }
            index += 1;
        }
        assert_eq!(fields[0], "P6");
        assert_eq!(fields[3], "255");
        (
            fields[1].parse().unwrap(),
            fields[2].parse().unwrap(),
            &bytes[index..],
        )
    }

    fn render(directory: &Path) -> (Vec<u8>, usize, usize, Affine, Value) {
        let vector: Value =
            serde_json::from_slice(&fs::read(directory.join("vector.json")).unwrap()).unwrap();
        let flags: Vec<&str> = vector["command_flags"]
            .as_array()
            .unwrap()
            .iter()
            .map(|flag| flag.as_str().unwrap())
            .collect();
        let rect = numbers(if flags.contains(&"-cropbox") {
            &vector["cropbox"]
        } else {
            &vector["mediabox"]
        });
        let page = PageBox {
            rect: rect.try_into().unwrap(),
            rotation: vector["rotation"].as_u64().unwrap() as u16,
        };
        let resolution = match vector["scale_to"].as_u64() {
            Some(pixels) => Resolution::ScaleTo(pixels as u32),
            None => Resolution::Dpi(vector["requested_dpi"].as_f64().unwrap()),
        };
        let slice = vector["requested_region"].as_array().map(|region| {
            let value = |index: usize| region[index].as_u64().unwrap() as u32;
            Slice {
                x: value(0),
                y: value(1),
                width: value(2),
                height: value(3),
            }
        });
        let grid = page_grid(page, resolution, slice).unwrap();
        let paints: Vec<Paint> = vector["layers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|layer| {
                let placement = affine(&layer["content_ctm"]);
                if layer["image_mask"].as_bool().unwrap() {
                    let fill = numbers(&layer["fill_rgb"]);
                    Paint::Stencil {
                        coverage: plane(directory, layer, "decoded_coverage", 1),
                        fill: [fill[0] as u8, fill[1] as u8, fill[2] as u8],
                        placement,
                    }
                } else {
                    Paint::Image {
                        image: plane(directory, layer, "decoded_samples", channels(layer)),
                        soft_mask: layer
                            .get("soft_mask")
                            .map(|mask| plane(directory, mask, "decoded_samples", 1)),
                        placement,
                    }
                }
            })
            .collect();
        let raster = rasterize(&grid, &paints, 1 << 20).unwrap();
        (raster, grid.width, grid.height, grid.device, vector)
    }

    #[test]
    fn every_measured_vector_reproduces_pdftoppm_exactly() {
        let mut directories: Vec<_> = fs::read_dir(FIXTURES)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        directories.sort();
        assert_eq!(directories.len(), 64, "the measured vector set");
        let mut failures = Vec::new();
        for directory in &directories {
            let name = directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let (raster, width, height, device, vector) = render(directory);
            let expected_device = affine(&vector["geometry"]["page_ctm"]);
            let expected = fs::read(directory.join("expected.ppm")).unwrap();
            let (expected_width, expected_height, expected_pixels) = ppm_pixels(&expected);
            if (width, height) != (expected_width, expected_height) {
                failures.push(format!(
                    "{name}: {width}x{height}, expected {expected_width}x{expected_height}"
                ));
                continue;
            }
            // The device transform is compared bit for bit: its rounding decides edges.
            if device.map(f64::to_bits) != expected_device.map(f64::to_bits) {
                failures.push(format!(
                    "{name}: device {device:?}, expected {expected_device:?}"
                ));
            }
            if let Some(first) = raster
                .iter()
                .zip(expected_pixels)
                .position(|(actual, expected)| actual != expected)
            {
                let pixel = first / 3;
                failures.push(format!(
                    "{name}: pixel ({}, {}) channel {} is {}, expected {}",
                    pixel % width,
                    pixel / width,
                    first % 3,
                    raster[first],
                    expected_pixels[first],
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} vectors differ:\n{}",
            failures.len(),
            directories.len(),
            failures.join("\n")
        );
    }
}
