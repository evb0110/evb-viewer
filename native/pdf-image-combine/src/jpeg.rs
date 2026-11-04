use std::io::Cursor;

use zune_jpeg::{
    zune_core::{colorspace::ColorSpace, options::DecoderOptions},
    JpegDecoder,
};

use crate::{binary::read_u16_be, Result, CM_PER_INCH};

const JPEG_APP0_MARKER: u8 = 0xE0;
const JPEG_APP2_MARKER: u8 = 0xE2;
const JPEG_START_OF_SCAN_MARKER: u8 = 0xDA;

#[derive(Debug)]
pub(crate) struct JpegMetadata {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) components: u8,
    /// Horizontal and vertical density, each from its own JFIF axis.
    pub(crate) dpi: Option<(u32, u32)>,
    pub(crate) icc_profile: Option<Vec<u8>>,
}

pub(crate) fn parse_jpeg_metadata(bytes: &[u8]) -> Result<JpegMetadata> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("Invalid JPEG payload".into());
    }

    let mut offset = 2usize;
    let mut dpi = None;
    let mut dimensions = None;
    let mut frame_component_ids = None;
    let mut saw_scan = false;
    let mut pending_marker = None;
    let mut icc_chunks: Vec<(u8, u8, Vec<u8>)> = Vec::new();

    loop {
        let marker = match pending_marker.take() {
            Some(marker) => marker,
            None => read_jpeg_marker(bytes, &mut offset)?,
        };

        if marker == 0xD9 {
            if !saw_scan {
                return Err("JPEG ended before its first scan".into());
            }
            break;
        }
        if marker == 0xD8 {
            return Err("Unexpected JPEG SOI marker".into());
        }
        if marker == 0x01 {
            continue;
        }
        if (0xD0..=0xD7).contains(&marker) {
            return Err("JPEG restart marker appeared outside scan data".into());
        }

        let segment_length = read_u16_be(bytes, offset).ok_or("Truncated JPEG segment")? as usize;
        let segment_end = offset
            .checked_add(segment_length)
            .ok_or("Invalid JPEG segment length")?;
        if segment_length < 2 || segment_end > bytes.len() {
            return Err("Invalid JPEG segment length".into());
        }

        if marker == JPEG_START_OF_SCAN_MARKER {
            validate_start_of_scan(
                bytes,
                offset,
                segment_length,
                dimensions,
                frame_component_ids.as_deref(),
            )?;
            offset = segment_end;
            saw_scan = true;
            pending_marker = Some(read_marker_after_scan(bytes, &mut offset)?);
            continue;
        }

        if marker == JPEG_APP0_MARKER {
            dpi = dpi.or_else(|| read_jfif_dpi(bytes, offset, segment_length));
        }
        if marker == JPEG_APP2_MARKER && segment_length >= 16 {
            let payload = &bytes[offset + 2..segment_end];
            if payload.starts_with(b"ICC_PROFILE\0") {
                let sequence = payload[12];
                let total = payload[13];
                if sequence > 0 && total > 0 && sequence <= total {
                    icc_chunks.push((sequence, total, payload[14..].to_vec()));
                }
            }
        }

        if is_jpeg_sof_marker(marker) {
            if dimensions.is_some() {
                return Err("JPEG contains multiple frame headers".into());
            }
            if segment_length < 8 {
                return Err("Invalid JPEG SOF segment".into());
            }
            let precision = *bytes.get(offset + 2).ok_or("Missing JPEG precision")?;
            if precision != 8 {
                return Err(format!(
                    "Unsupported JPEG SOF precision: {precision} (only 8-bit supported)"
                )
                .into());
            }
            let height = read_u16_be(bytes, offset + 3).ok_or("Missing JPEG height")? as u32;
            let width = read_u16_be(bytes, offset + 5).ok_or("Missing JPEG width")? as u32;
            let components = *bytes
                .get(offset + 7)
                .ok_or("Missing JPEG component count")?;
            let expected_length = 8usize
                .checked_add(
                    (components as usize)
                        .checked_mul(3)
                        .ok_or("Invalid JPEG component count")?,
                )
                .ok_or("Invalid JPEG SOF segment")?;
            if components == 0 || segment_length != expected_length {
                return Err("Invalid JPEG SOF component table".into());
            }
            let mut component_ids = Vec::new();
            component_ids
                .try_reserve_exact(components as usize)
                .map_err(|_| "Unable to reserve JPEG component table")?;
            for component_index in 0..components as usize {
                let component_id = bytes[offset + 8 + component_index * 3];
                if component_ids.contains(&component_id) {
                    return Err("JPEG frame contains duplicate component identifiers".into());
                }
                component_ids.push(component_id);
            }
            dimensions = Some((width, height, components));
            frame_component_ids = Some(component_ids);
        }

        offset = segment_end;
    }

    let (width, height, components) = dimensions.ok_or("Missing JPEG dimensions")?;
    if !matches!(components, 1 | 3) {
        return Err(format!("Unsupported JPEG component count: {components}").into());
    }
    let icc_profile = assemble_icc_profile(icc_chunks)?;
    Ok(JpegMetadata {
        width,
        height,
        components,
        dpi,
        icc_profile,
    })
}

pub(crate) fn validate_jpeg_decodable(bytes: &[u8], width: u32, height: u32) -> Result<()> {
    let options = DecoderOptions::default()
        .set_strict_mode(true)
        .set_max_width(width as usize)
        .set_max_height(height as usize)
        .jpeg_set_out_colorspace(ColorSpace::Luma);
    let mut decoder = JpegDecoder::new_with_options(Cursor::new(bytes), options);
    decoder
        .decode()
        .map(|_| ())
        .map_err(|error| format!("JPEG scan data is not decodable: {error}").into())
}

fn assemble_icc_profile(mut chunks: Vec<(u8, u8, Vec<u8>)>) -> Result<Option<Vec<u8>>> {
    if chunks.is_empty() {
        return Ok(None);
    }
    let expected = chunks[0].1;
    if chunks.len() != expected as usize || chunks.iter().any(|chunk| chunk.1 != expected) {
        return Err("Incomplete JPEG ICC profile".into());
    }
    chunks.sort_by_key(|chunk| chunk.0);
    if chunks
        .iter()
        .enumerate()
        .any(|(index, chunk)| chunk.0 as usize != index + 1)
    {
        return Err("Invalid JPEG ICC profile sequence".into());
    }
    let total_len = chunks
        .iter()
        .try_fold(0usize, |total, chunk| total.checked_add(chunk.2.len()))
        .ok_or("JPEG ICC profile is too large")?;
    if total_len > 16 * 1024 * 1024 {
        return Err("JPEG ICC profile exceeds the 16 MiB safety limit".into());
    }
    let mut profile = Vec::with_capacity(total_len);
    for (_, _, chunk) in chunks {
        profile.extend_from_slice(&chunk);
    }
    Ok(Some(profile))
}

fn read_jpeg_marker(bytes: &[u8], offset: &mut usize) -> Result<u8> {
    if bytes.get(*offset) != Some(&0xFF) {
        return Err("Invalid JPEG marker prefix".into());
    }
    while bytes.get(*offset) == Some(&0xFF) {
        *offset += 1;
    }
    let marker = *bytes.get(*offset).ok_or("Truncated JPEG marker")?;
    *offset += 1;
    if marker == 0x00 || marker == 0xFF {
        return Err("Invalid JPEG marker".into());
    }
    Ok(marker)
}

fn validate_start_of_scan(
    bytes: &[u8],
    offset: usize,
    segment_length: usize,
    dimensions: Option<(u32, u32, u8)>,
    frame_component_ids: Option<&[u8]>,
) -> Result<()> {
    let (_, _, frame_components) = dimensions.ok_or("JPEG scan appeared before dimensions")?;
    let scan_components = *bytes.get(offset + 2).ok_or("Invalid JPEG SOS segment")?;
    let expected_length = 6usize
        .checked_add(
            (scan_components as usize)
                .checked_mul(2)
                .ok_or("Invalid JPEG SOS component count")?,
        )
        .ok_or("Invalid JPEG SOS segment")?;
    if scan_components == 0
        || scan_components > frame_components
        || segment_length != expected_length
    {
        return Err("Invalid JPEG SOS component table".into());
    }
    let frame_component_ids = frame_component_ids.ok_or("Missing JPEG frame component table")?;
    let mut scan_component_ids = Vec::new();
    scan_component_ids
        .try_reserve_exact(scan_components as usize)
        .map_err(|_| "Unable to reserve JPEG scan component table")?;
    for component_index in 0..scan_components as usize {
        let component_id = bytes[offset + 3 + component_index * 2];
        if !frame_component_ids.contains(&component_id) {
            return Err("JPEG scan references an unknown frame component".into());
        }
        if scan_component_ids.contains(&component_id) {
            return Err("JPEG scan contains duplicate component identifiers".into());
        }
        scan_component_ids.push(component_id);
    }
    Ok(())
}

fn read_marker_after_scan(bytes: &[u8], offset: &mut usize) -> Result<u8> {
    loop {
        while bytes.get(*offset).is_some_and(|byte| *byte != 0xFF) {
            *offset += 1;
        }
        if *offset >= bytes.len() {
            return Err("JPEG scan is missing an EOI marker".into());
        }
        while bytes.get(*offset) == Some(&0xFF) {
            *offset += 1;
        }
        let marker = *bytes.get(*offset).ok_or("Truncated JPEG scan marker")?;
        *offset += 1;
        match marker {
            0x00 | 0xD0..=0xD7 => continue,
            0xFF => continue,
            _ => return Ok(marker),
        }
    }
}

fn is_jpeg_sof_marker(marker: u8) -> bool {
    matches!(
        marker,
        0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
    )
}

fn read_jfif_dpi(bytes: &[u8], offset: usize, segment_length: usize) -> Option<(u32, u32)> {
    if segment_length < 16 {
        return None;
    }
    if bytes.get(offset + 2..offset + 7)? != b"JFIF\0" {
        return None;
    }

    let units = *bytes.get(offset + 9)?;
    let x_density = read_u16_be(bytes, offset + 10)? as u32;
    let y_density = read_u16_be(bytes, offset + 12)? as u32;
    // A zero axis takes the other's density; with neither there is none.
    let (x_density, y_density) = match (x_density, y_density) {
        (0, 0) => return None,
        (0, y) => (y, y),
        (x, 0) => (x, x),
        axes => axes,
    };
    let per_inch = |density: u32| match units {
        1 => Some(density),
        2 => Some((density as f64 * CM_PER_INCH).round() as u32),
        _ => None,
    };
    Some((per_inch(x_density)?, per_inch(y_density)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_eight_bit_jpeg_sof_precision() {
        let metadata = parse_jpeg_metadata(&jpeg_with_sof_precision(8)).unwrap();

        assert_eq!(metadata.width, 2);
        assert_eq!(metadata.height, 1);
        assert_eq!(metadata.components, 1);
    }

    #[test]
    fn keeps_each_jfif_density_axis() {
        let mut bytes = jpeg_with_sof_precision(8);
        // APP0 JFIF 1.1 in dots per inch: 300 across, 150 down.
        let app0 = [
            0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01, 0x01, 0x01, 0x01, 0x2C,
            0x00, 0x96, 0x00, 0x00,
        ];
        bytes.splice(2..2, app0);
        assert_eq!(parse_jpeg_metadata(&bytes).unwrap().dpi, Some((300, 150)));
        // Dots per centimeter convert each axis on its own.
        bytes[13] = 0x02;
        assert_eq!(parse_jpeg_metadata(&bytes).unwrap().dpi, Some((762, 381)));
        // A zero axis takes the other's density.
        bytes[13] = 0x01;
        bytes[16] = 0x00;
        bytes[17] = 0x00;
        assert_eq!(parse_jpeg_metadata(&bytes).unwrap().dpi, Some((300, 300)));
    }

    #[test]
    fn rejects_non_eight_bit_jpeg_sof_precision() {
        let result = parse_jpeg_metadata(&jpeg_with_sof_precision(12));

        assert!(result.is_err());
    }

    #[test]
    fn rejects_jpeg_truncated_after_sof() {
        let mut jpeg = jpeg_with_sof_precision(8);
        jpeg.truncate(jpeg.len() - 2);

        let error = parse_jpeg_metadata(&jpeg).unwrap_err();

        assert!(error.to_string().contains("EOI") || error.to_string().contains("Truncated"));
    }

    #[test]
    fn rejects_jpeg_with_truncated_scan_marker() {
        let mut jpeg = jpeg_with_sof_precision(8);
        jpeg.truncate(jpeg.len() - 2);
        jpeg.push(0xff);

        let error = parse_jpeg_metadata(&jpeg).unwrap_err();

        assert!(error.to_string().contains("Truncated JPEG scan marker"));
    }

    #[test]
    fn accepts_structurally_complete_progressive_jpeg_scans() {
        let jpeg = jpeg_with_scans(0xc2, 8, true);

        let metadata = parse_jpeg_metadata(&jpeg).unwrap();

        assert_eq!((metadata.width, metadata.height), (2, 1));
    }

    #[test]
    fn rejects_scan_that_references_unknown_frame_component() {
        let mut jpeg = jpeg_with_sof_precision(8);
        let scan_component_id = jpeg
            .windows(2)
            .position(|window| window == [0xff, 0xda])
            .unwrap()
            + 5;
        jpeg[scan_component_id] = 2;

        let error = parse_jpeg_metadata(&jpeg).unwrap_err();

        assert!(error.to_string().contains("unknown frame component"));
    }

    fn jpeg_with_sof_precision(precision: u8) -> Vec<u8> {
        jpeg_with_scans(0xc0, precision, false)
    }

    fn jpeg_with_scans(sof_marker: u8, precision: u8, progressive: bool) -> Vec<u8> {
        let mut jpeg = vec![
            0xff, 0xd8, 0xff, sof_marker, 0x00, 0x0b, precision, 0x00, 0x01, 0x00, 0x02, 0x01,
            0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00,
        ];
        jpeg.extend_from_slice(if progressive {
            &[
                0x00, 0x00, 0x11, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3f, 0x00, 0x22,
                0xff, 0xd9,
            ]
        } else {
            &[0x3f, 0x00, 0x11, 0xff, 0xd9]
        });
        jpeg
    }
}
