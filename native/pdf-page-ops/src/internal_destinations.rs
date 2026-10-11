use super::*;
use crate::split_pages::{validate_crop_rect, PdfMatrix};

/// Resolve navigation through the destination page's geometry, independently
/// of the page which owns the annotation. A split must identify one output.
pub(crate) fn remap_internal_destination(
    source: &Document,
    destination: &Object,
    pages: &[crate::text_layer::OverlayPage<'_>],
) -> Result<Object> {
    let mut destination = source.dereference(destination)?.1.as_array()?.clone();
    let source_page = destination
        .first()
        .ok_or("Missing internal destination page")?
        .as_reference()?;
    let mode = source
        .dereference(
            destination
                .get(1)
                .ok_or("Missing internal destination mode")?,
        )?
        .1
        .as_name()?;
    let coordinate = |index: usize| -> Result<Option<f64>> {
        let value = source
            .dereference(
                destination
                    .get(index)
                    .ok_or("Missing destination coordinate")?,
            )?
            .1;
        if value.is_null() {
            return Ok(None);
        }
        let value = f64::from(value.as_float()?);
        if !value.is_finite() {
            return Err("Non-finite destination coordinate".into());
        }
        Ok(Some(value))
    };
    let point = match mode {
        b"XYZ" if destination.len() == 5 => [coordinate(2)?, coordinate(3)?],
        b"FitH" | b"FitBH" if destination.len() == 3 => [None, coordinate(2)?],
        b"FitV" | b"FitBV" if destination.len() == 3 => [coordinate(2)?, None],
        b"Fit" | b"FitB" if destination.len() == 2 => [None, None],
        b"FitR" if destination.len() == 6 => [None, None],
        _ => return Err("overlay-text cannot resolve an internal destination".into()),
    };
    let transform = |matrix: [f64; 6], point: [Option<f64>; 2]| {
        let term = |factor: f64, value: Option<f64>| {
            if factor == 0.0 {
                Some(0.0)
            } else {
                value.map(|value| factor * value)
            }
        };
        [
            term(matrix[0], point[0])
                .zip(term(matrix[2], point[1]))
                .map(|(x, y)| x + y + matrix[4]),
            term(matrix[1], point[0])
                .zip(term(matrix[3], point[1]))
                .map(|(x, y)| x + y + matrix[5]),
        ]
    };
    let points = if mode == b"FitR" {
        let (left, bottom, right, top) = (
            coordinate(2)?,
            coordinate(3)?,
            coordinate(4)?,
            coordinate(5)?,
        );
        if [left, bottom, right, top].iter().any(Option::is_none) {
            return Err("Missing FitR destination coordinate".into());
        }
        vec![[left, bottom], [left, top], [right, bottom], [right, top]]
    } else {
        vec![point]
    };
    let mut outputs = pages.iter().filter(|page| page.0 == source_page);
    let first = outputs
        .next()
        .ok_or("overlay-text references an unmapped source page or tree")?;
    let selected = if outputs.next().is_none() {
        first
    } else {
        let mut matches = Vec::new();
        for output in pages.iter().filter(|page| page.0 == source_page) {
            let (matrix, view) = match output.2.source_region {
                Some(region) => (region.matrix, validate_crop_rect(region.rect)?),
                None => (output.2.matrix, output.3),
            };
            if points.iter().all(|point| {
                let [x, y] = transform(matrix, *point);
                x.is_none_or(|x| x >= view.x1 && x <= view.x2)
                    && y.is_none_or(|y| y >= view.y1 && y <= view.y2)
            }) {
                matches.push(output);
            }
        }
        match matches.as_slice() {
            [output] => *output,
            [] => {
                return Err(
                    "overlay-text cannot resolve an internal destination to an output region"
                        .into(),
                )
            }
            _ => return Err("overlay-text has an ambiguous internal destination".into()),
        }
    };
    let matrix = selected.2.matrix;
    let [x, y] = transform(matrix, point);
    let nullable = |value: Option<f64>| -> Result<Object> {
        match value {
            Some(value) if value.is_finite() => Ok(number_object(value)),
            Some(_) => Err("Non-finite transformed destination coordinate".into()),
            None => Ok(Object::Null),
        }
    };
    let mut values = match mode {
        b"XYZ" => {
            if point.iter().any(Option::is_some) && x.is_none() && y.is_none() {
                return Err(
                    "overlay-text cannot represent the transformed partial destination".into(),
                );
            }
            vec![
                "XYZ".into(),
                nullable(x)?,
                nullable(y)?,
                nullable(coordinate(4)?)?,
            ]
        }
        b"FitH" | b"FitBH" => {
            if matrix[1] == 0.0 {
                vec![Object::Name(mode.to_vec()), nullable(y)?]
            } else if matrix[0] == 0.0 {
                vec![
                    Object::Name(if mode == b"FitH" {
                        b"FitV".to_vec()
                    } else {
                        b"FitBV".to_vec()
                    }),
                    nullable(x)?,
                ]
            } else {
                return Err(
                    "overlay-text cannot represent the transformed horizontal destination".into(),
                );
            }
        }
        b"FitV" | b"FitBV" => {
            if matrix[2] == 0.0 {
                vec![Object::Name(mode.to_vec()), nullable(x)?]
            } else if matrix[3] == 0.0 {
                vec![
                    Object::Name(if mode == b"FitV" {
                        b"FitH".to_vec()
                    } else {
                        b"FitBH".to_vec()
                    }),
                    nullable(y)?,
                ]
            } else {
                return Err(
                    "overlay-text cannot represent the transformed vertical destination".into(),
                );
            }
        }
        b"FitR" => {
            let rect = PdfRect {
                x1: coordinate(2)?.ok_or("Missing FitR left")?,
                y1: coordinate(3)?.ok_or("Missing FitR bottom")?,
                x2: coordinate(4)?.ok_or("Missing FitR right")?,
                y2: coordinate(5)?.ok_or("Missing FitR top")?,
            };
            let bounds = PdfMatrix::from_values(matrix).bounds(rect);
            vec![
                "FitR".into(),
                nullable(Some(bounds.x1))?,
                nullable(Some(bounds.y1))?,
                nullable(Some(bounds.x2))?,
                nullable(Some(bounds.y2))?,
            ]
        }
        _ => vec![Object::Name(mode.to_vec())],
    };
    destination.clear();
    destination.push(Object::Reference(selected.1));
    destination.append(&mut values);
    Ok(Object::Array(destination))
}
