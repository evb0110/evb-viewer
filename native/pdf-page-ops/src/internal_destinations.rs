use super::*;
use crate::split_pages::PdfMatrix;

const MAX_NAME_TREE_DEPTH: usize = 32;

/// Transform the one surviving output selected by the shared destination policy.
/// The catalog and annotations choose their output before applying coordinates.
pub(crate) fn remap_internal_destination(
    source: &Document,
    mut destination: Vec<Object>,
    selected: &crate::overlay_sources::OverlayPage<'_>,
) -> Result<Option<Object>> {
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
    if selected.2.unmapped_geometry && points.iter().any(|point| point.iter().any(Option::is_some))
    {
        return Ok(None);
    }
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
                return Ok(None);
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
                return Ok(None);
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
                return Ok(None);
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
    Ok(Some(Object::Array(destination)))
}

/// The explicit destination array behind a navigation entry. A name or string
/// is a named destination: it resolves through the catalog, and a name that
/// the catalog does not define yields `None`, like any other destination the
/// document no longer shows.
pub(crate) fn resolve_destination(
    source: &Document,
    destination: &Object,
) -> Result<Option<Vec<Object>>> {
    let mut object = source.dereference(destination)?.1.clone();
    if let Object::Name(name) | Object::String(name, _) = &object {
        let name = name.clone();
        let Some(named) = named_destination(source, &name)? else {
            return Ok(None);
        };
        object = named;
    }
    let object = source.dereference(&object)?.1;
    let object = match object {
        Object::Dictionary(dictionary) => source.dereference(dictionary.get(b"D")?)?.1,
        other => other,
    };
    Ok(Some(object.as_array()?.clone()))
}

/// The catalog's legacy /Dests dictionary first, then the /Names /Dests tree.
fn named_destination(source: &Document, name: &[u8]) -> Result<Option<Object>> {
    let catalog = source.catalog()?;
    if let Ok((_, dests)) = catalog
        .get(b"Dests")
        .and_then(|dests| source.dereference(dests))
    {
        if let Ok(value) = dests.as_dict().and_then(|dests| dests.get(name)) {
            return Ok(Some(value.clone()));
        }
    }
    let Ok((_, names)) = catalog
        .get(b"Names")
        .and_then(|names| source.dereference(names))
    else {
        return Ok(None);
    };
    let Ok(tree) = names.as_dict().and_then(|names| names.get(b"Dests")) else {
        return Ok(None);
    };
    name_tree_value(source, tree, name, 0)
}

/// Depth-bounded search of a name tree, so a cyclic or hostile tree answers
/// "not found" instead of recursing without end.
fn name_tree_value(
    source: &Document,
    node: &Object,
    name: &[u8],
    depth: usize,
) -> Result<Option<Object>> {
    if depth > MAX_NAME_TREE_DEPTH {
        return Ok(None);
    }
    let node = source.dereference(node)?.1.as_dict()?;
    if let Ok(names) = node.get(b"Names") {
        for pair in source.dereference(names)?.1.as_array()?.chunks_exact(2) {
            if source
                .dereference(&pair[0])?
                .1
                .as_str()
                .is_ok_and(|key| key == name)
            {
                return Ok(Some(pair[1].clone()));
            }
        }
    }
    if let Ok(kids) = node.get(b"Kids") {
        for kid in source.dereference(kids)?.1.as_array()? {
            if let Some(value) = name_tree_value(source, kid, name, depth + 1)? {
                return Ok(Some(value));
            }
        }
    }
    Ok(None)
}
