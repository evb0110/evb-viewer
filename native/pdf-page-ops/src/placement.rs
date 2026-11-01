//! The `cm` operator that places copied content on a page. A PDF reader
//! inverts the matrix the file holds, so the check runs on the numbers as
//! written: `number_object` saturates reals to f32 and writes near-integers as
//! integers, either of which can make a matrix invertible in f64 singular in
//! the file.

use super::*;
use lopdf::content::Operation as ContentOperation;

pub(crate) fn placement_cm(matrix: [f64; 6]) -> Result<ContentOperation> {
    let operands = matrix.map(number_object);
    let [a, b, c, d, ..] = operands
        .each_ref()
        .map(|operand| object_to_f64(operand).unwrap_or(f64::NAN));
    let determinant = a * d - b * c;
    let writable = matrix
        .iter()
        .all(|value| value.is_finite() && value.abs() <= f64::from(f32::MAX))
        && determinant.is_finite()
        && determinant.abs() > f64::EPSILON;
    if !writable {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "content placement matrix is not invertible as a PDF can write it",
        ));
    }
    Ok(ContentOperation::new("cm", operands.into()))
}
