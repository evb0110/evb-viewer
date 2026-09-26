use serde::{Deserialize, Serialize};

/// Floating-point point in pixel-center coordinates; integer pixels are centered at `(x + .5, y + .5)`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub start: Point,
    pub end: Point,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Polygon {
    pub points: Vec<Point>,
}

/// Row-major affine mapping whose final row is `[0, 0, 1]`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Affine {
    pub matrix: [[f64; 3]; 3],
}

/// Row-major projective mapping normalized so its bottom-right value is normally one.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Projective {
    pub matrix: [[f64; 3]; 3],
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
    pub fn right(self) -> f64 {
        self.x + self.width
    }
    pub fn bottom(self) -> f64 {
        self.y + self.height
    }
    /// Returns whether the point lies inside the rectangle, including all four edges.
    pub fn contains(self, point: Point) -> bool {
        point.x >= self.x
            && point.y >= self.y
            && point.x <= self.right()
            && point.y <= self.bottom()
    }
    pub fn expand(self, left: f64, top: f64, right: f64, bottom: f64) -> Self {
        Self::new(
            self.x - left,
            self.y - top,
            self.width + left + right,
            self.height + top + bottom,
        )
    }
}

impl Affine {
    pub const IDENTITY: Self = Self {
        matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    };
    pub fn translation(x: f64, y: f64) -> Self {
        Self {
            matrix: [[1.0, 0.0, x], [0.0, 1.0, y], [0.0, 0.0, 1.0]],
        }
    }
    pub fn rotation_radians(angle: f64) -> Self {
        let (s, c) = angle.sin_cos();
        Self {
            matrix: [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]],
        }
    }
    pub fn scaling(x: f64, y: f64) -> Self {
        Self {
            matrix: [[x, 0.0, 0.0], [0.0, y, 0.0], [0.0, 0.0, 1.0]],
        }
    }
    pub fn apply(self, point: Point) -> Point {
        Point::new(
            self.matrix[0][0] * point.x + self.matrix[0][1] * point.y + self.matrix[0][2],
            self.matrix[1][0] * point.x + self.matrix[1][1] * point.y + self.matrix[1][2],
        )
    }
    pub fn then(self, next: Self) -> Self {
        Self {
            matrix: multiply(next.matrix, self.matrix),
        }
    }
    pub fn inverse(self) -> Option<Self> {
        invert(self.matrix).map(|matrix| Self { matrix })
    }
}

impl Projective {
    pub const IDENTITY: Self = Self {
        matrix: Affine::IDENTITY.matrix,
    };
    pub fn apply(self, point: Point) -> Option<Point> {
        let denominator =
            self.matrix[2][0] * point.x + self.matrix[2][1] * point.y + self.matrix[2][2];
        (denominator.abs() > 1e-12).then(|| {
            Point::new(
                (self.matrix[0][0] * point.x + self.matrix[0][1] * point.y + self.matrix[0][2])
                    / denominator,
                (self.matrix[1][0] * point.x + self.matrix[1][1] * point.y + self.matrix[1][2])
                    / denominator,
            )
        })
    }
    pub fn then(self, next: Self) -> Self {
        Self {
            matrix: multiply(next.matrix, self.matrix),
        }
    }
    pub fn inverse(self) -> Option<Self> {
        invert_projective(self.matrix).map(|matrix| Self { matrix })
    }
}

fn multiply(a: [[f64; 3]; 3], b: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut output = [[0.0; 3]; 3];
    for row in 0..3 {
        for column in 0..3 {
            for (index, b_row) in b.iter().enumerate() {
                output[row][column] += a[row][index] * b_row[column];
            }
        }
    }
    output
}

fn invert(matrix: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    invert_with_cutoff(matrix, 1e-12)
}

fn invert_projective(matrix: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let scale = matrix
        .iter()
        .flatten()
        .fold(0.0_f64, |maximum, value| maximum.max(value.abs()));
    invert_with_cutoff(matrix, 1e-12 * scale.powi(3))
}

fn invert_with_cutoff(matrix: [[f64; 3]; 3], determinant_cutoff: f64) -> Option<[[f64; 3]; 3]> {
    let determinant = matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
    if determinant.abs() <= determinant_cutoff {
        return None;
    }
    let m = matrix;
    let cofactors = [
        [
            m[1][1] * m[2][2] - m[1][2] * m[2][1],
            m[0][2] * m[2][1] - m[0][1] * m[2][2],
            m[0][1] * m[1][2] - m[0][2] * m[1][1],
        ],
        [
            m[1][2] * m[2][0] - m[1][0] * m[2][2],
            m[0][0] * m[2][2] - m[0][2] * m[2][0],
            m[0][2] * m[1][0] - m[0][0] * m[1][2],
        ],
        [
            m[1][0] * m[2][1] - m[1][1] * m[2][0],
            m[0][1] * m[2][0] - m[0][0] * m[2][1],
            m[0][0] * m[1][1] - m[0][1] * m[1][0],
        ],
    ];
    Some(cofactors.map(|row| row.map(|value| value / determinant)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn affine_inverse_round_trips_pixel_centers() {
        let transform = Affine::translation(4.0, -2.0).then(Affine::rotation_radians(0.2));
        let point = Point::new(10.5, 8.5);
        let restored = transform.inverse().unwrap().apply(transform.apply(point));
        assert!((restored.x - point.x).abs() < 1e-9);
        assert!((restored.y - point.y).abs() < 1e-9);
    }

    #[test]
    fn projective_inverse_cutoff_is_invariant_to_uniform_matrix_scale() {
        let base = Projective {
            matrix: [[1.0, 0.2, 3.0], [0.1, 0.9, -2.0], [0.001, -0.002, 1.0]],
        };
        let scaled = Projective {
            matrix: base.matrix.map(|row| row.map(|value| value * 1e-6)),
        };
        let point = Point::new(10.5, 8.5);
        let base_restored = base
            .inverse()
            .unwrap()
            .apply(base.apply(point).unwrap())
            .unwrap();
        let scaled_restored = scaled
            .inverse()
            .unwrap()
            .apply(scaled.apply(point).unwrap())
            .unwrap();
        assert!((base_restored.x - point.x).abs() < 1e-9);
        assert!((base_restored.y - point.y).abs() < 1e-9);
        assert!((scaled_restored.x - point.x).abs() < 1e-9);
        assert!((scaled_restored.y - point.y).abs() < 1e-9);
    }

    #[test]
    fn projective_inverse_rejects_large_scaled_near_singular_matrix() {
        let scale = 1e6;
        let transform = Projective {
            matrix: [
                [scale, scale, 0.0],
                [scale, scale * (1.0 + 1e-13), 0.0],
                [0.0, 0.0, scale],
            ],
        };
        assert!(transform.inverse().is_none());
    }
}
