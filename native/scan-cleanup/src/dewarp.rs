use crate::{io::png::RgbImage, DewarpOptions};
use rayon::prelude::*;
use scan_primitives::{GrayImage, Point, Projective};
use thiserror::Error;

pub const DEWARP_GRID_SIZE: usize = 17;
const MIN_CURVE_SEPARATION: f64 = 0.05;
const MIN_ENDPOINT_CROSS_RATIO: f64 = 0.01;
const MAX_JACOBIAN_RATIO: f64 = 20.0;

#[derive(Clone, Debug, Error, PartialEq)]
pub enum DewarpModelError {
    #[error("dewarp-model-insufficient-points: each directrix requires at least two points")]
    InsufficientPoints,
    #[error("dewarp-model-invalid-depth: depth must be finite and between -0.9 and 4.0")]
    InvalidDepth,
    #[error("dewarp-model-endpoint-order: endpoint quadrilateral must be convex TL/TR/BR/BL with consistent orientation")]
    EndpointOrder,
    #[error("dewarp-model-degenerate-endpoints: endpoint quadrilateral is degenerate")]
    DegenerateEndpoints,
    #[error("dewarp-model-noninvertible-homography: endpoint homography is not invertible")]
    NoninvertibleHomography,
    #[error("dewarp-model-invalid-point: {directrix} directrix contains a point that cannot be normalized")]
    InvalidPoint { directrix: &'static str },
    #[error("dewarp-model-zero-length: {directrix} directrix has zero length")]
    ZeroLength { directrix: &'static str },
    #[error("dewarp-model-nonmonotonic-x: {directrix} directrix does not progress monotonically in normalized x")]
    NonMonotonicX { directrix: &'static str },
    #[error(
        "dewarp-model-curve-separation: directrices cross or fall below 5% vertical separation"
    )]
    CurveSeparation,
    #[error("dewarp-model-nonpositive-jacobian: mapping folds or reverses orientation on the 17x17 validity grid")]
    NonPositiveJacobian,
    #[error("dewarp-model-excessive-magnification: Jacobian magnitude ratio exceeds 20x on the 17x17 validity grid")]
    ExcessiveMagnification,
}

#[derive(Clone, Debug)]
pub struct DewarpModel {
    homography: Projective,
    inverse_homography: Projective,
    top: ArcPolyline,
    bottom: ArcPolyline,
    depth: f64,
}

#[derive(Clone, Debug)]
struct ArcPolyline {
    points: Vec<Point>,
    cumulative: Vec<f64>,
    length: f64,
}

impl DewarpModel {
    pub fn from_options(options: &DewarpOptions) -> Result<Self, DewarpModelError> {
        if options.top_curve.len() < 2 || options.bottom_curve.len() < 2 {
            return Err(DewarpModelError::InsufficientPoints);
        }
        if !options.depth.is_finite() || !(-0.9..=4.0).contains(&options.depth) {
            return Err(DewarpModelError::InvalidDepth);
        }
        let corners = [
            options.top_curve[0],
            *options.top_curve.last().unwrap(),
            *options.bottom_curve.last().unwrap(),
            options.bottom_curve[0],
        ];
        validate_endpoint_order(corners)?;
        let unit = [
            Point::new(0.0, 0.0),
            Point::new(1.0, 0.0),
            Point::new(1.0, 1.0),
            Point::new(0.0, 1.0),
        ];
        let homography =
            homography_from_four(corners, unit).ok_or(DewarpModelError::DegenerateEndpoints)?;
        let inverse_homography = homography
            .inverse()
            .ok_or(DewarpModelError::NoninvertibleHomography)?;
        let top_points = options
            .top_curve
            .iter()
            .map(|&point| {
                homography
                    .apply(point)
                    .ok_or(DewarpModelError::InvalidPoint { directrix: "top" })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let bottom_points = options
            .bottom_curve
            .iter()
            .map(|&point| {
                homography
                    .apply(point)
                    .ok_or(DewarpModelError::InvalidPoint {
                        directrix: "bottom",
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        validate_monotonic_x(&top_points, "top")?;
        validate_monotonic_x(&bottom_points, "bottom")?;
        validate_curve_separation(&top_points, &bottom_points)?;
        let model = Self {
            homography,
            inverse_homography,
            top: ArcPolyline::new(top_points, "top")?,
            bottom: ArcPolyline::new(bottom_points, "bottom")?,
            depth: options.depth,
        };
        model.validate_jacobian()?;
        Ok(model)
    }

    pub fn map_unit_to_source(&self, u: f64, v: f64) -> Option<Point> {
        let top = self.top.sample(u.clamp(0.0, 1.0));
        let bottom = self.bottom.sample(u.clamp(0.0, 1.0));
        let denominator = 1.0 + self.depth * (1.0 - v);
        if denominator.abs() < 1e-9 {
            return None;
        }
        let projected_v = (v / denominator).clamp(0.0, 1.0);
        let normalized = Point::new(
            top.x + (bottom.x - top.x) * projected_v,
            top.y + (bottom.y - top.y) * projected_v,
        );
        self.inverse_homography.apply(normalized)
    }

    pub fn map_source_to_unit_approx(&self, source: Point) -> Option<Point> {
        let normalized = self.homography.apply(source)?;
        let mut best = Point::new(0.0, 0.0);
        let mut best_distance = f64::INFINITY;
        for step in 0..=256 {
            let u = step as f64 / 256.0;
            let top = self.top.sample(u);
            let bottom = self.bottom.sample(u);
            let dx = bottom.x - top.x;
            let dy = bottom.y - top.y;
            let length2 = dx * dx + dy * dy;
            if length2 <= 1e-12 {
                continue;
            }
            let projected = ((normalized.x - top.x) * dx + (normalized.y - top.y) * dy) / length2;
            let point = Point::new(top.x + dx * projected, top.y + dy * projected);
            let distance = (point.x - normalized.x).powi(2) + (point.y - normalized.y).powi(2);
            if distance < best_distance {
                let p = projected.clamp(0.0, 1.0);
                let v = p * (1.0 + self.depth) / (1.0 + p * self.depth);
                best = Point::new(u, v);
                best_distance = distance;
            }
        }
        Some(best)
    }

    /// Counts non-positive or non-finite samples on the same 17x17 Jacobian
    /// grid used by C2 model validation. Validated models necessarily return
    /// zero; the harness keeps this explicit counter as a catastrophic-warp
    /// regression metric.
    pub fn sampled_jacobian_failures(&self) -> usize {
        let mut failures = 0;
        for row in 0..DEWARP_GRID_SIZE {
            for column in 0..DEWARP_GRID_SIZE {
                let u = column as f64 / (DEWARP_GRID_SIZE - 1) as f64;
                let v = row as f64 / (DEWARP_GRID_SIZE - 1) as f64;
                if numerical_jacobian(self, u, v)
                    .is_none_or(|value| !value.is_finite() || value <= 1e-12)
                {
                    failures += 1;
                }
            }
        }
        failures
    }

    fn validate_jacobian(&self) -> Result<(), DewarpModelError> {
        let mut minimum = f64::INFINITY;
        let mut maximum: f64 = 0.0;
        for row in 0..DEWARP_GRID_SIZE {
            for column in 0..DEWARP_GRID_SIZE {
                let u = column as f64 / (DEWARP_GRID_SIZE - 1) as f64;
                let v = row as f64 / (DEWARP_GRID_SIZE - 1) as f64;
                let determinant = numerical_jacobian(self, u, v)
                    .filter(|value| value.is_finite() && *value > 1e-12)
                    .ok_or(DewarpModelError::NonPositiveJacobian)?;
                minimum = minimum.min(determinant);
                maximum = maximum.max(determinant);
            }
        }
        if maximum / minimum > MAX_JACOBIAN_RATIO {
            return Err(DewarpModelError::ExcessiveMagnification);
        }
        Ok(())
    }
}

impl ArcPolyline {
    fn new(points: Vec<Point>, directrix: &'static str) -> Result<Self, DewarpModelError> {
        let mut cumulative = vec![0.0];
        for pair in points.windows(2) {
            let length = ((pair[1].x - pair[0].x).powi(2) + (pair[1].y - pair[0].y).powi(2)).sqrt();
            cumulative.push(cumulative.last().copied().unwrap() + length);
        }
        let length = *cumulative.last().unwrap();
        if length <= 1e-9 {
            return Err(DewarpModelError::ZeroLength { directrix });
        }
        Ok(Self {
            points,
            cumulative,
            length,
        })
    }
    fn sample(&self, position: f64) -> Point {
        let target = position * self.length;
        let segment = self
            .cumulative
            .partition_point(|&distance| distance < target)
            .clamp(1, self.points.len() - 1)
            - 1;
        let start = self.cumulative[segment];
        let end = self.cumulative[segment + 1];
        let amount = if end > start {
            (target - start) / (end - start)
        } else {
            0.0
        };
        Point::new(
            self.points[segment].x + (self.points[segment + 1].x - self.points[segment].x) * amount,
            self.points[segment].y + (self.points[segment + 1].y - self.points[segment].y) * amount,
        )
    }
}

fn validate_endpoint_order(corners: [Point; 4]) -> Result<(), DewarpModelError> {
    let crosses = std::array::from_fn::<_, 4, _>(|index| {
        let a = corners[index];
        let b = corners[(index + 1) % corners.len()];
        let c = corners[(index + 2) % corners.len()];
        (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    });
    let minimum = crosses
        .iter()
        .map(|value| value.abs())
        .fold(f64::INFINITY, f64::min);
    let maximum = crosses.iter().map(|value| value.abs()).fold(0.0, f64::max);
    if crosses
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
        || maximum <= 1e-12
        || minimum / maximum < MIN_ENDPOINT_CROSS_RATIO
    {
        return Err(DewarpModelError::EndpointOrder);
    }
    Ok(())
}

fn validate_monotonic_x(points: &[Point], directrix: &'static str) -> Result<(), DewarpModelError> {
    if points.windows(2).any(|pair| pair[1].x - pair[0].x <= 1e-9) {
        return Err(DewarpModelError::NonMonotonicX { directrix });
    }
    Ok(())
}

fn validate_curve_separation(top: &[Point], bottom: &[Point]) -> Result<(), DewarpModelError> {
    // Both curves are piecewise linear and monotonic in x, so their vertical
    // separation is linear between the union of their x breakpoints. Checking
    // every breakpoint proves the minimum over the full width, rather than
    // relying on a sampling interval that could miss a narrow crossing.
    let mut breakpoints = top
        .iter()
        .chain(bottom)
        .map(|point| point.x.clamp(0.0, 1.0))
        .collect::<Vec<_>>();
    breakpoints.push(0.0);
    breakpoints.push(1.0);
    breakpoints.sort_by(f64::total_cmp);
    breakpoints.dedup_by(|left, right| (*left - *right).abs() <= 1e-12);
    for x in breakpoints {
        let top_y = sample_polyline_at_x(top, x).ok_or(DewarpModelError::CurveSeparation)?;
        let bottom_y = sample_polyline_at_x(bottom, x).ok_or(DewarpModelError::CurveSeparation)?;
        if bottom_y - top_y < MIN_CURVE_SEPARATION {
            return Err(DewarpModelError::CurveSeparation);
        }
    }
    Ok(())
}

fn sample_polyline_at_x(points: &[Point], x: f64) -> Option<f64> {
    let first = *points.first()?;
    let last = *points.last()?;
    if x <= first.x {
        return Some(first.y);
    }
    if x >= last.x {
        return Some(last.y);
    }
    let pair = points.windows(2).find(|pair| pair[1].x >= x)?;
    let amount = (x - pair[0].x) / (pair[1].x - pair[0].x);
    Some(pair[0].y + (pair[1].y - pair[0].y) * amount)
}

fn numerical_jacobian(model: &DewarpModel, u: f64, v: f64) -> Option<f64> {
    const STEP: f64 = 1.0 / 4096.0;
    let u0 = (u - STEP).max(0.0);
    let u1 = (u + STEP).min(1.0);
    let v0 = (v - STEP).max(0.0);
    let v1 = (v + STEP).min(1.0);
    let left = model.map_unit_to_source(u0, v)?;
    let right = model.map_unit_to_source(u1, v)?;
    let top = model.map_unit_to_source(u, v0)?;
    let bottom = model.map_unit_to_source(u, v1)?;
    let du = u1 - u0;
    let dv = v1 - v0;
    if du <= 0.0 || dv <= 0.0 {
        return None;
    }
    let dx_du = (right.x - left.x) / du;
    let dy_du = (right.y - left.y) / du;
    let dx_dv = (bottom.x - top.x) / dv;
    let dy_dv = (bottom.y - top.y) / dv;
    Some(dx_du * dy_dv - dy_du * dx_dv)
}

pub fn rasterize_inverse_area(
    source: &GrayImage,
    model: &DewarpModel,
    width: usize,
    height: usize,
) -> GrayImage {
    rasterize_inverse_area_with(source, width, height, |point| {
        model.map_unit_to_source(point.x / width as f64, point.y / height as f64)
    })
}

pub fn rasterize_inverse_area_with<F>(
    source: &GrayImage,
    width: usize,
    height: usize,
    output_to_source: F,
) -> GrayImage
where
    F: Fn(Point) -> Option<Point> + Sync,
{
    rasterize_inverse_area_impl(source, width, height, output_to_source)
}

pub fn rasterize_inverse_area_rgb_with<F>(
    source: &RgbImage,
    width: usize,
    height: usize,
    output_to_source: F,
) -> RgbImage
where
    F: Fn(Point) -> Option<Point> + Sync,
{
    rasterize_inverse_area_impl(source, width, height, output_to_source)
}

trait RasterPixel: Copy + Send {
    type Accumulator;

    fn white() -> Self;
    fn accumulator() -> Self::Accumulator;
    fn add_weighted(accumulator: &mut Self::Accumulator, pixel: Self, weight: f64);
    fn resolve(accumulator: Self::Accumulator, area: f64) -> Self;
}

impl RasterPixel for u8 {
    type Accumulator = f64;

    fn white() -> Self {
        255
    }

    fn accumulator() -> Self::Accumulator {
        0.0
    }

    fn add_weighted(accumulator: &mut Self::Accumulator, pixel: Self, weight: f64) {
        *accumulator += weight * f64::from(pixel);
    }

    fn resolve(accumulator: Self::Accumulator, area: f64) -> Self {
        (accumulator / area).round().clamp(0.0, 255.0) as u8
    }
}

impl RasterPixel for [u8; 3] {
    type Accumulator = [f64; 3];

    fn white() -> Self {
        [255; 3]
    }

    fn accumulator() -> Self::Accumulator {
        [0.0; 3]
    }

    fn add_weighted(accumulator: &mut Self::Accumulator, pixel: Self, weight: f64) {
        for channel in 0..3 {
            accumulator[channel] += weight * f64::from(pixel[channel]);
        }
    }

    fn resolve(accumulator: Self::Accumulator, area: f64) -> Self {
        accumulator.map(|value| (value / area).round().clamp(0.0, 255.0) as u8)
    }
}

trait RasterImage: Sized + Sync {
    type Pixel: RasterPixel;

    fn new_white(width: usize, height: usize) -> Self;
    fn width(&self) -> usize;
    fn height(&self) -> usize;
    fn get(&self, x: usize, y: usize) -> Self::Pixel;
    fn data_mut(&mut self) -> &mut [u8];
    fn row_len(width: usize) -> usize;
    fn write_pixel(row: &mut [u8], x: usize, pixel: Self::Pixel);
}

impl RasterImage for GrayImage {
    type Pixel = u8;

    fn new_white(width: usize, height: usize) -> Self {
        Self::new(width, height, 255)
    }

    fn width(&self) -> usize {
        GrayImage::width(self)
    }

    fn height(&self) -> usize {
        GrayImage::height(self)
    }

    fn get(&self, x: usize, y: usize) -> Self::Pixel {
        GrayImage::get(self, x, y)
    }

    fn data_mut(&mut self) -> &mut [u8] {
        GrayImage::data_mut(self)
    }

    fn row_len(width: usize) -> usize {
        width
    }

    fn write_pixel(row: &mut [u8], x: usize, pixel: Self::Pixel) {
        row[x] = pixel;
    }
}

impl RasterImage for RgbImage {
    type Pixel = [u8; 3];

    fn new_white(width: usize, height: usize) -> Self {
        Self::new(width, height, [255; 3])
    }

    fn width(&self) -> usize {
        RgbImage::width(self)
    }

    fn height(&self) -> usize {
        RgbImage::height(self)
    }

    fn get(&self, x: usize, y: usize) -> Self::Pixel {
        RgbImage::get(self, x, y)
    }

    fn data_mut(&mut self) -> &mut [u8] {
        RgbImage::data_mut(self)
    }

    fn row_len(width: usize) -> usize {
        width.saturating_mul(3)
    }

    fn write_pixel(row: &mut [u8], x: usize, pixel: Self::Pixel) {
        row[x * 3..x * 3 + 3].copy_from_slice(&pixel);
    }
}

fn rasterize_inverse_area_impl<I, F>(
    source: &I,
    width: usize,
    height: usize,
    output_to_source: F,
) -> I
where
    I: RasterImage,
    F: Fn(Point) -> Option<Point> + Sync,
{
    let mut output = I::new_white(width, height);
    if width == 0 || height == 0 {
        return output;
    }
    let row_len = I::row_len(width);
    let rows_per_batch = rayon::current_num_threads().max(1).saturating_mul(2);
    // Adjacent pixels share quad corners, so each batch maps the shared
    // (width+1) x (rows+1) corner grid once instead of evaluating the warp
    // model four times per pixel, and the mapping runs across rows in
    // parallel (it dominates wall time; sampling has a bilinear fast path).
    let map_corner_row = |y: usize| {
        (0..=width)
            .map(|x| output_to_source(Point::new(x as f64, y as f64)))
            .collect::<Vec<_>>()
    };
    for (batch_index, output_rows) in output
        .data_mut()
        .chunks_mut(row_len.saturating_mul(rows_per_batch))
        .enumerate()
    {
        let first_y = batch_index * rows_per_batch;
        let batch_rows = output_rows.len() / row_len;
        let corner_rows = (first_y..=first_y + batch_rows)
            .collect::<Vec<_>>()
            .into_par_iter()
            .map(map_corner_row)
            .collect::<Vec<_>>();
        output_rows
            .par_chunks_mut(row_len)
            .enumerate()
            .for_each(|(row_offset, output_row)| {
                let top = &corner_rows[row_offset];
                let bottom = &corner_rows[row_offset + 1];
                for x in 0..width {
                    let quad = match (top[x], top[x + 1], bottom[x + 1], bottom[x]) {
                        (
                            Some(top_left),
                            Some(top_right),
                            Some(bottom_right),
                            Some(bottom_left),
                        ) => [top_left, top_right, bottom_right, bottom_left],
                        _ => continue,
                    };
                    I::write_pixel(output_row, x, sample_quad(source, &quad));
                }
            });
    }
    output
}

#[cfg(test)]
fn mapped_quad_with<F>(output_to_source: &F, x: usize, y: usize) -> Option<[Point; 4]>
where
    F: Fn(Point) -> Option<Point>,
{
    Some([
        output_to_source(Point::new(x as f64, y as f64))?,
        output_to_source(Point::new((x + 1) as f64, y as f64))?,
        output_to_source(Point::new((x + 1) as f64, (y + 1) as f64))?,
        output_to_source(Point::new(x as f64, (y + 1) as f64))?,
    ])
}

#[derive(Clone, Copy)]
struct QuadBounds {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

impl QuadBounds {
    fn from_quad(quad: &[Point; 4]) -> Self {
        Self {
            min_x: quad
                .iter()
                .map(|point| point.x)
                .fold(f64::INFINITY, f64::min),
            max_x: quad
                .iter()
                .map(|point| point.x)
                .fold(f64::NEG_INFINITY, f64::max),
            min_y: quad
                .iter()
                .map(|point| point.y)
                .fold(f64::INFINITY, f64::min),
            max_y: quad
                .iter()
                .map(|point| point.y)
                .fold(f64::NEG_INFINITY, f64::max),
        }
    }

    fn uses_bilinear(self) -> bool {
        self.max_x - self.min_x <= 1.05 && self.max_y - self.min_y <= 1.05
    }
}

fn sample_quad<I: RasterImage>(source: &I, quad: &[Point; 4]) -> I::Pixel {
    let bounds = QuadBounds::from_quad(quad);
    if bounds.uses_bilinear() {
        let center = Point::new(
            quad.iter().map(|point| point.x).sum::<f64>() * 0.25,
            quad.iter().map(|point| point.y).sum::<f64>() * 0.25,
        );
        sample_bilinear(source, center, bounds)
    } else {
        integrate_quad(source, quad, bounds)
    }
}

fn sample_bilinear<I: RasterImage>(source: &I, point: Point, bounds: QuadBounds) -> I::Pixel {
    if source.width() == 0
        || source.height() == 0
        || bounds.max_x <= 0.0
        || bounds.max_y <= 0.0
        || bounds.min_x >= source.width() as f64
        || bounds.min_y >= source.height() as f64
    {
        return I::Pixel::white();
    }
    let x = (point.x - 0.5).clamp(0.0, source.width().saturating_sub(1) as f64);
    let y = (point.y - 0.5).clamp(0.0, source.height().saturating_sub(1) as f64);
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(source.width() - 1);
    let y1 = (y0 + 1).min(source.height() - 1);
    let x_amount = x - x0 as f64;
    let y_amount = y - y0 as f64;
    let mut accumulator = I::Pixel::accumulator();
    I::Pixel::add_weighted(
        &mut accumulator,
        source.get(x0, y0),
        (1.0 - x_amount) * (1.0 - y_amount),
    );
    I::Pixel::add_weighted(
        &mut accumulator,
        source.get(x1, y0),
        x_amount * (1.0 - y_amount),
    );
    I::Pixel::add_weighted(
        &mut accumulator,
        source.get(x0, y1),
        (1.0 - x_amount) * y_amount,
    );
    I::Pixel::add_weighted(&mut accumulator, source.get(x1, y1), x_amount * y_amount);
    I::Pixel::resolve(accumulator, 1.0)
}

fn integrate_quad<I: RasterImage>(source: &I, quad: &[Point; 4], bounds: QuadBounds) -> I::Pixel {
    let min_x = bounds.min_x.floor().max(0.0) as usize;
    let max_x = bounds.max_x.ceil().min(source.width() as f64) as usize;
    let min_y = bounds.min_y.floor().max(0.0) as usize;
    let max_y = bounds.max_y.ceil().min(source.height() as f64) as usize;
    let mut weighted = I::Pixel::accumulator();
    let mut area = 0.0;
    for sy in min_y..max_y {
        for sx in min_x..max_x {
            let clipped =
                clip_to_rect(quad, sx as f64, sy as f64, (sx + 1) as f64, (sy + 1) as f64);
            let coverage = polygon_area(clipped.as_slice());
            if coverage > 1e-12 {
                I::Pixel::add_weighted(&mut weighted, source.get(sx, sy), coverage);
                area += coverage;
            }
        }
    }
    if area > 1e-12 {
        I::Pixel::resolve(weighted, area)
    } else {
        I::Pixel::white()
    }
}

const MAX_CLIP_VERTICES: usize = 12;

#[derive(Clone, Copy)]
struct ClipPolygon {
    points: [Point; MAX_CLIP_VERTICES],
    len: usize,
}

impl ClipPolygon {
    fn from_quad(quad: &[Point; 4]) -> Self {
        let mut polygon = Self::default();
        for &point in quad {
            polygon.push(point);
        }
        polygon
    }

    fn clear(&mut self) {
        self.len = 0;
    }

    fn push(&mut self, point: Point) {
        self.points[self.len] = point;
        self.len += 1;
    }

    fn as_slice(&self) -> &[Point] {
        &self.points[..self.len]
    }
}

impl Default for ClipPolygon {
    fn default() -> Self {
        Self {
            points: [Point::default(); MAX_CLIP_VERTICES],
            len: 0,
        }
    }
}

fn clip_to_rect(quad: &[Point; 4], left: f64, top: f64, right: f64, bottom: f64) -> ClipPolygon {
    let mut polygon = ClipPolygon::from_quad(quad);
    let mut output = ClipPolygon::default();
    for (axis, bound, keep_greater) in [
        (0, left, true),
        (0, right, false),
        (1, top, true),
        (1, bottom, false),
    ] {
        if polygon.len == 0 {
            break;
        }
        output.clear();
        for index in 0..polygon.len {
            let current = polygon.points[index];
            let previous = polygon.points[(index + polygon.len - 1) % polygon.len];
            let current_value = if axis == 0 { current.x } else { current.y };
            let previous_value = if axis == 0 { previous.x } else { previous.y };
            let current_inside = if keep_greater {
                current_value >= bound
            } else {
                current_value <= bound
            };
            let previous_inside = if keep_greater {
                previous_value >= bound
            } else {
                previous_value <= bound
            };
            if current_inside != previous_inside {
                let amount = (bound - previous_value) / (current_value - previous_value);
                output.push(Point::new(
                    previous.x + (current.x - previous.x) * amount,
                    previous.y + (current.y - previous.y) * amount,
                ));
            }
            if current_inside {
                output.push(current);
            }
        }
        std::mem::swap(&mut polygon, &mut output);
    }
    polygon
}

fn polygon_area(points: &[Point]) -> f64 {
    if points.len() < 3 {
        return 0.0;
    }
    points
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let next = points[(index + 1) % points.len()];
            point.x * next.y - next.x * point.y
        })
        .sum::<f64>()
        .abs()
        * 0.5
}

fn homography_from_four(source: [Point; 4], target: [Point; 4]) -> Option<Projective> {
    let mut equations = vec![vec![0.0; 9]; 8];
    for index in 0..4 {
        let x = source[index].x;
        let y = source[index].y;
        let u = target[index].x;
        let v = target[index].y;
        equations[index * 2][0] = x;
        equations[index * 2][1] = y;
        equations[index * 2][2] = 1.0;
        equations[index * 2][6] = -u * x;
        equations[index * 2][7] = -u * y;
        equations[index * 2][8] = u;
        equations[index * 2 + 1][3] = x;
        equations[index * 2 + 1][4] = y;
        equations[index * 2 + 1][5] = 1.0;
        equations[index * 2 + 1][6] = -v * x;
        equations[index * 2 + 1][7] = -v * y;
        equations[index * 2 + 1][8] = v;
    }
    let values = solve(equations)?;
    Some(Projective {
        matrix: [
            [values[0], values[1], values[2]],
            [values[3], values[4], values[5]],
            [values[6], values[7], 1.0],
        ],
    })
}

fn solve(mut matrix: Vec<Vec<f64>>) -> Option<Vec<f64>> {
    let size = matrix.len();
    for pivot in 0..size {
        let best = (pivot..size)
            .max_by(|&a, &b| matrix[a][pivot].abs().total_cmp(&matrix[b][pivot].abs()))?;
        if matrix[best][pivot].abs() < 1e-12 {
            return None;
        }
        matrix.swap(pivot, best);
        let divisor = matrix[pivot][pivot];
        for column in pivot..=size {
            matrix[pivot][column] /= divisor;
        }
        for row in 0..size {
            if row == pivot {
                continue;
            }
            let factor = matrix[row][pivot];
            for column in pivot..=size {
                matrix[row][column] -= factor * matrix[pivot][column];
            }
        }
    }
    Some(matrix.into_iter().map(|row| row[size]).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curves() -> DewarpOptions {
        DewarpOptions {
            top_curve: (0..=8)
                .map(|step| {
                    let x = 10.0 + step as f64 * 20.0;
                    Point::new(
                        x,
                        15.0 + 10.0 * ((step as f64 / 8.0 - 0.5) * std::f64::consts::PI).cos(),
                    )
                })
                .collect(),
            bottom_curve: (0..=8)
                .map(|step| {
                    let x = 10.0 + step as f64 * 20.0;
                    Point::new(
                        x,
                        125.0 + 10.0 * ((step as f64 / 8.0 - 0.5) * std::f64::consts::PI).cos(),
                    )
                })
                .collect(),
            depth: 0.15,
        }
    }

    fn rasterize_serial<I, F>(source: &I, width: usize, height: usize, output_to_source: F) -> I
    where
        I: RasterImage,
        F: Fn(Point) -> Option<Point>,
    {
        let mut output = I::new_white(width, height);
        if width == 0 || height == 0 {
            return output;
        }
        for (y, output_row) in output.data_mut().chunks_mut(I::row_len(width)).enumerate() {
            for x in 0..width {
                let Some(quad) = mapped_quad_with(&output_to_source, x, y) else {
                    continue;
                };
                I::write_pixel(output_row, x, sample_quad(source, &quad));
            }
        }
        output
    }

    fn nontrivial_warp(point: Point) -> Option<Point> {
        Some(Point::new(
            1.5 + point.x * (1.08 + 0.018 * point.y) + 0.04 * point.y,
            1.0 + point.y * (1.12 + 0.008 * point.x) + 0.18 * (point.x * 0.35).sin(),
        ))
    }

    #[test]
    fn endpoints_and_inverse_mapping_round_trip() {
        let model = DewarpModel::from_options(&curves()).unwrap();
        for &(u, v) in &[(0.0, 0.0), (1.0, 1.0), (0.35, 0.6)] {
            let source = model.map_unit_to_source(u, v).unwrap();
            let restored = model.map_source_to_unit_approx(source).unwrap();
            assert!((restored.x - u).abs() < 0.006);
            assert!((restored.y - v).abs() < 0.015);
        }
    }

    #[test]
    fn parallel_rasterizers_match_serial_reference_for_nontrivial_warp() {
        let mut gray = GrayImage::new(48, 36, 255);
        let mut rgb = RgbImage::new(48, 36, [255; 3]);
        for y in 0..36 {
            for x in 0..48 {
                let value = ((x * 37 + y * 61 + x * y * 3) % 256) as u8;
                gray.set(x, y, value);
                rgb.set(x, y, [value, value.wrapping_mul(3), value.wrapping_add(91)]);
            }
        }
        let expected_gray = rasterize_serial(&gray, 24, 20, nontrivial_warp);
        let expected_rgb = rasterize_serial(&rgb, 24, 20, nontrivial_warp);

        for thread_count in [1, 4] {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(thread_count)
                .build()
                .unwrap();
            let actual_gray =
                pool.install(|| rasterize_inverse_area_with(&gray, 24, 20, nontrivial_warp));
            let actual_rgb =
                pool.install(|| rasterize_inverse_area_rgb_with(&rgb, 24, 20, nontrivial_warp));
            assert_eq!(actual_gray, expected_gray, "thread_count={thread_count}");
            assert_eq!(actual_rgb, expected_rgb, "thread_count={thread_count}");
        }
    }

    #[test]
    fn bilinear_fast_path_agrees_with_area_integration_near_identity() {
        let mut source = GrayImage::new(22, 18, 255);
        for y in 0..source.height() {
            for x in 0..source.width() {
                source.set(x, y, (x * 5 + y * 7 + x * y % 5) as u8);
            }
        }
        let near_identity = |point: Point| {
            Some(Point::new(
                1.0 + point.x * 0.995 + point.y * 0.004,
                1.0 + point.y * 1.002 + point.x * 0.003,
            ))
        };
        let adaptive = rasterize_inverse_area_with(&source, 18, 14, near_identity);
        let mut exact = GrayImage::new(18, 14, 255);
        for y in 0..14 {
            for x in 0..18 {
                let quad = mapped_quad_with(&near_identity, x, y).unwrap();
                let bounds = QuadBounds::from_quad(&quad);
                assert!(bounds.uses_bilinear());
                exact.set(x, y, integrate_quad(&source, &quad, bounds));
            }
        }
        let max_difference = adaptive
            .data()
            .iter()
            .zip(exact.data())
            .map(|(&left, &right)| left.abs_diff(right))
            .max()
            .unwrap();
        assert!(max_difference <= 2, "max_difference={max_difference}");
    }

    #[test]
    fn inverse_area_rasterizer_straightens_known_curves() {
        let model = DewarpModel::from_options(&curves()).unwrap();
        let mut source = GrayImage::new(180, 150, 255);
        for line in 1..5 {
            let v = line as f64 / 5.0;
            for step in 0..800 {
                let point = model.map_unit_to_source(step as f64 / 799.0, v).unwrap();
                let x = point.x.round() as usize;
                let y = point.y.round() as usize;
                if x < 180 && y < 150 {
                    source.set(x, y, 0);
                    if y + 1 < 150 {
                        source.set(x, y + 1, 0);
                    }
                }
            }
        }
        let output = rasterize_inverse_area(&source, &model, 160, 110);
        for line in 1..5 {
            let expected: usize = line * 22;
            let deviations: Vec<f64> = (5..155)
                .filter_map(|x| {
                    (expected.saturating_sub(3)..=(expected + 3).min(109))
                        .min_by_key(|&y| output.get(x, y))
                        .map(|y| y as f64 - expected as f64)
                })
                .collect();
            let rms = (deviations.iter().map(|value| value * value).sum::<f64>()
                / deviations.len() as f64)
                .sqrt();
            assert!(rms < 1.8, "rms={rms}");
        }
    }

    #[test]
    fn rejects_folded_crossing_and_reversed_directrices_with_specific_errors() {
        for folded_x in [35.0, 45.0, 55.0] {
            let folded = DewarpOptions {
                top_curve: vec![
                    Point::new(0.0, 0.0),
                    Point::new(70.0, 4.0),
                    Point::new(folded_x, 2.0),
                    Point::new(100.0, 0.0),
                ],
                bottom_curve: vec![Point::new(0.0, 100.0), Point::new(100.0, 100.0)],
                depth: 0.0,
            };
            assert!(matches!(
                DewarpModel::from_options(&folded),
                Err(DewarpModelError::NonMonotonicX { directrix: "top" })
            ));
        }

        for overlap in [0.0, -5.0, -20.0] {
            let crossing = DewarpOptions {
                top_curve: vec![
                    Point::new(0.0, 0.0),
                    Point::new(50.0, 55.0),
                    Point::new(100.0, 0.0),
                ],
                bottom_curve: vec![
                    Point::new(0.0, 100.0),
                    Point::new(50.0, 55.0 + overlap),
                    Point::new(100.0, 100.0),
                ],
                depth: 0.0,
            };
            assert!(matches!(
                DewarpModel::from_options(&crossing),
                Err(DewarpModelError::CurveSeparation)
            ));
        }

        let mut reversed = curves();
        reversed.top_curve.reverse();
        reversed.bottom_curve.reverse();
        assert!(matches!(
            DewarpModel::from_options(&reversed),
            Err(DewarpModelError::EndpointOrder)
        ));
    }

    #[test]
    fn rejects_weak_endpoint_order_jacobian_folds_and_excessive_magnification() {
        let weak_corner = DewarpOptions {
            top_curve: vec![Point::new(0.0, 0.0), Point::new(100.0, 0.0)],
            bottom_curve: vec![Point::new(99.9, 100.0), Point::new(100.0, 100.0)],
            depth: 0.0,
        };
        assert!(matches!(
            DewarpModel::from_options(&weak_corner),
            Err(DewarpModelError::EndpointOrder)
        ));

        let jacobian_fold = DewarpOptions {
            top_curve: vec![
                Point::new(0.0, 0.0),
                Point::new(1.0, 10.0),
                Point::new(100.0, 0.0),
            ],
            bottom_curve: vec![
                Point::new(0.0, 20.0),
                Point::new(99.0, 10.1),
                Point::new(100.0, 20.0),
            ],
            depth: 0.0,
        };
        assert!(matches!(
            DewarpModel::from_options(&jacobian_fold),
            Err(DewarpModelError::NonPositiveJacobian)
        ));

        let excessive = DewarpOptions {
            top_curve: vec![Point::new(0.0, 0.0), Point::new(100.0, 0.0)],
            bottom_curve: vec![Point::new(0.0, 100.0), Point::new(100.0, 100.0)],
            depth: -0.9,
        };
        assert!(matches!(
            DewarpModel::from_options(&excessive),
            Err(DewarpModelError::ExcessiveMagnification)
        ));
    }

    #[test]
    fn valid_fixture_models_remain_valid_across_safe_depths() {
        for depth in [-0.5, 0.0, 0.15, 0.5, 1.0] {
            let mut fixture = curves();
            fixture.depth = depth;
            DewarpModel::from_options(&fixture)
                .unwrap_or_else(|error| panic!("depth={depth} unexpectedly failed: {error}"));
        }
    }
}
