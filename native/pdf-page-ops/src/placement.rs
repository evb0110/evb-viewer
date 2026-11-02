//! The `cm` operator that places copied content on a page. A PDF reader
//! inverts the matrix the file holds, so the check runs on the numbers as
//! written. Exact integers are written as integers and every other value as
//! an f32 real, so neither a large integer nor a tiny scale changes on the way.

use super::*;
use lopdf::content::Operation as ContentOperation;

/// The operand and the value a reader gets back from it.
fn placement_operand(value: f64) -> Option<(Object, f64)> {
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_992.0 {
        return Some((Object::Integer(value as i64), value));
    }
    let real = value as f32;
    real.is_finite()
        .then(|| (Object::Real(real), f64::from(real)))
}

pub(crate) fn placement_cm(matrix: [f64; 6]) -> Result<ContentOperation> {
    let written = matrix.map(placement_operand);
    let operands: Option<Vec<(Object, f64)>> = written.into_iter().collect();
    let writable = operands.as_deref().is_some_and(|operands| {
        let [a, b, c, d] = [0, 1, 2, 3].map(|index| operands[index].1);
        let determinant = a * d - b * c;
        determinant.is_finite() && determinant != 0.0
    });
    match operands.filter(|_| writable) {
        Some(operands) => Ok(ContentOperation::new(
            "cm",
            operands.into_iter().map(|(operand, _)| operand).collect(),
        )),
        None => Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "content placement matrix is not invertible as a PDF can write it",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_exact_integers_and_tiny_scales_and_refuses_what_is_singular_as_written() {
        let operands = |matrix| placement_cm(matrix).map(|operation| operation.operands);
        // Determinant 16777216 survives because the integers stay exact.
        assert_eq!(
            operands([
                16_777_216.0,
                16_777_216.0,
                16_777_216.0,
                16_777_217.0,
                0.0,
                0.0
            ])
            .unwrap()[3],
            Object::Integer(16_777_217)
        );
        // A tiny scale stays a non-zero real.
        assert_eq!(
            operands([5e-7, 0.0, 0.0, 5e-7, 0.0, 0.0]).unwrap()[0],
            Object::Real(5e-7)
        );
        for singular in [
            [1.0, 1.0, 1.0, 1.0, 0.0, 0.0],
            // Invertible in f64, singular once written as f32.
            [1.0, 1.0, 1.0, 1.000_000_01, 0.0, 0.0],
            [1e39, 0.0, 0.0, 1.0, 0.0, 0.0],
            [f64::NAN, 0.0, 0.0, 1.0, 0.0, 0.0],
        ] {
            assert!(operands(singular).is_err(), "{singular:?}");
        }
    }
}
