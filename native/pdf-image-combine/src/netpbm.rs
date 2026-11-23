use crate::{image::assert_pixel_limit, Result};
use serde::Serialize;
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetpbmProbe {
    pub magic: String,
    pub width: u32,
    pub height: u32,
    pub data_offset: u64,
    pub non_white_ratio: f64,
    pub dark_ratio: f64,
    pub color_ratio: f64,
    pub max_dark_run_ratio: f64,
    pub min_channel: u8,
    pub max_channel: u8,
    pub black_ratio: f64,
    pub max_black_run_ratio: f64,
    pub dominant_color: [u8; 3],
}

struct CountingReader<R: Read> {
    inner: BufReader<R>,
    offset: u64,
}

impl<R: Read> CountingReader<R> {
    fn new(reader: R) -> Self {
        Self {
            inner: BufReader::new(reader),
            offset: 0,
        }
    }

    fn bytes_read(&self) -> u64 {
        self.offset
    }

    fn read_byte(&mut self) -> Result<Option<u8>> {
        let mut byte = [0u8; 1];
        if self.inner.read(&mut byte)? == 0 {
            return Ok(None);
        }
        self.offset += 1;
        Ok(Some(byte[0]))
    }

    fn read_exact_counted(&mut self, bytes: &mut [u8]) -> Result<()> {
        self.inner.read_exact(bytes)?;
        self.offset += bytes.len() as u64;
        Ok(())
    }

    fn read_number(&mut self, label: &str) -> Result<u32> {
        let mut digits = Vec::new();
        loop {
            let byte = self
                .read_byte()?
                .ok_or_else(|| format!("Missing {label} in Netpbm header"))?;
            if byte == b'#' {
                while self.read_byte()?.is_some_and(|value| value != b'\n') {}
            } else if !byte.is_ascii_whitespace() {
                if !byte.is_ascii_digit() {
                    return Err(format!("Invalid {label} in Netpbm header").into());
                }
                digits.push(byte);
                break;
            }
        }
        loop {
            let byte = self
                .read_byte()?
                .ok_or_else(|| format!("Truncated {label} in Netpbm header"))?;
            if byte.is_ascii_digit() {
                digits.push(byte);
                continue;
            }
            if !byte.is_ascii_whitespace() {
                return Err(format!("Invalid {label} terminator in Netpbm header").into());
            }
            if byte == b'\r' && self.inner.fill_buf()?.first() == Some(&b'\n') {
                self.inner.consume(1);
                self.offset += 1;
            }
            break;
        }
        let value = std::str::from_utf8(&digits)?.parse::<u32>()?;
        if value == 0 {
            return Err(format!("Invalid {label} in Netpbm header").into());
        }
        Ok(value)
    }
}

#[derive(Clone, Copy)]
struct NetpbmHeader {
    magic: [u8; 2],
    width: u32,
    height: u32,
    channels: u8,
}

#[derive(Debug)]
pub(crate) struct OwnedNetpbm {
    pub(crate) magic: [u8; 2],
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) channels: u8,
    pub(crate) pixels: Vec<u8>,
}

fn read_netpbm_header<R: Read>(
    reader: &mut CountingReader<R>,
    max_pixels: u64,
) -> Result<NetpbmHeader> {
    let magic = [
        reader.read_byte()?.ok_or("Missing Netpbm magic")?,
        reader.read_byte()?.ok_or("Missing Netpbm magic")?,
    ];
    let channels = match &magic {
        b"P4" => 0,
        b"P5" => 1,
        b"P6" => 3,
        _ => return Err("Unsupported Netpbm format".into()),
    };
    let width = reader.read_number("width")?;
    let height = reader.read_number("height")?;
    assert_pixel_limit(width, height, max_pixels)?;
    if channels > 0 && reader.read_number("maxval")? != 255 {
        return Err("Unsupported Netpbm maxval (only 255 is supported)".into());
    }
    Ok(NetpbmHeader {
        magic,
        width,
        height,
        channels,
    })
}

fn netpbm_payload_size(header: NetpbmHeader) -> Result<usize> {
    let row_bytes = if header.channels == 0 {
        (header.width as usize)
            .checked_add(7)
            .ok_or("Invalid PBM P4 row stride")?
            / 8
    } else {
        (header.width as usize)
            .checked_mul(header.channels as usize)
            .ok_or("Invalid Netpbm row size")?
    };
    row_bytes
        .checked_mul(header.height as usize)
        .ok_or_else(|| "Invalid Netpbm payload size".into())
}

pub(crate) fn read_netpbm_file(file: File, max_pixels: u64) -> Result<OwnedNetpbm> {
    read_netpbm_file_inner(file, max_pixels, false)
}

fn read_netpbm_file_inner(file: File, max_pixels: u64, allow_pbm: bool) -> Result<OwnedNetpbm> {
    let mut reader = CountingReader::new(file);
    let header = read_netpbm_header(&mut reader, max_pixels)?;
    if allow_pbm {
        if header.channels != 0 {
            return Err("Expected a PBM P4 payload".into());
        }
    } else if header.channels == 0 {
        return Err("Expected a PGM P5 or PPM P6 payload".into());
    }
    let payload_size = netpbm_payload_size(header)?;
    let required_bytes = reader
        .bytes_read()
        .checked_add(u64::try_from(payload_size).map_err(|_| "Invalid Netpbm payload size")?)
        .ok_or("Invalid Netpbm payload size")?;
    let file_len = reader.inner.get_ref().metadata()?.len();
    if file_len < required_bytes {
        let message = if allow_pbm {
            "Truncated PBM P4 payload"
        } else {
            "Truncated Netpbm payload"
        };
        return Err(message.into());
    }
    let mut pixels = vec![0u8; payload_size];
    reader.read_exact_counted(&mut pixels)?;
    Ok(OwnedNetpbm {
        magic: header.magic,
        width: header.width,
        height: header.height,
        channels: header.channels,
        pixels,
    })
}

pub(crate) fn read_pbm_p4_file(file: File, max_pixels: u64) -> Result<PbmP4Image> {
    let image = read_netpbm_file_inner(file, max_pixels, true)?;
    if image.magic != *b"P4" {
        return Err("Unsupported PBM format".into());
    }
    Ok(PbmP4Image {
        width: image.width,
        height: image.height,
        row_stride: (image.width as usize).div_ceil(8),
        bitmap: image.pixels,
    })
}

pub fn probe_netpbm_path(path: &Path, max_pixels: u64) -> Result<NetpbmProbe> {
    let mut reader = CountingReader::new(File::open(path)?);
    let header = read_netpbm_header(&mut reader, max_pixels)?;
    let magic = header.magic;
    let channels = header.channels as usize;
    let width = header.width;
    let height = header.height;
    let data_offset = reader.offset;
    let total_pixels = u64::from(width) * u64::from(height);
    let mut non_white = 0u64;
    let mut dark = 0u64;
    let mut color = 0u64;
    let mut black = 0u64;
    let mut max_dark_run = 0u32;
    let mut max_black_run = 0u32;
    let mut min_channel = 255u8;
    let mut max_channel = 0u8;
    let mut dominant_totals = [0u64; 3];
    let mut dominant_weight = 0u64;
    let row_bytes = if channels == 0 {
        (width as usize).div_ceil(8)
    } else {
        width as usize * channels
    };
    let mut row = vec![0u8; row_bytes];
    for _ in 0..height {
        reader.read_exact_counted(&mut row)?;
        let mut dark_run = 0u32;
        let mut black_run = 0u32;
        for x in 0..width as usize {
            if channels == 0 {
                if row[x / 8] & (0x80 >> (x % 8)) != 0 {
                    black += 1;
                    black_run += 1;
                    max_black_run = max_black_run.max(black_run);
                } else {
                    black_run = 0;
                }
                continue;
            }
            let (red, green, blue) = if channels == 1 {
                (row[x], row[x], row[x])
            } else {
                (row[x * 3], row[x * 3 + 1], row[x * 3 + 2])
            };
            let min = red.min(green).min(blue);
            let max = red.max(green).max(blue);
            min_channel = min_channel.min(min);
            max_channel = max_channel.max(max);
            let is_non_white = red < 245 || green < 245 || blue < 245;
            let is_dark = red < 80 && green < 80 && blue < 80;
            if is_non_white {
                non_white += 1;
                if max - min > 12 {
                    color += 1;
                }
            }
            if is_dark {
                dark += 1;
                dark_run += 1;
                max_dark_run = max_dark_run.max(dark_run);
            } else {
                dark_run = 0;
            }
            if max < 230 {
                let weight = u64::from(255 - max);
                dominant_totals[0] += u64::from(red) * weight;
                dominant_totals[1] += u64::from(green) * weight;
                dominant_totals[2] += u64::from(blue) * weight;
                dominant_weight += weight;
            }
        }
    }
    let dominant_color = if dominant_weight == 0 {
        [0, 0, 0]
    } else {
        dominant_totals.map(|total| (total / dominant_weight) as u8)
    };
    Ok(NetpbmProbe {
        magic: String::from_utf8(magic.to_vec())?,
        width,
        height,
        data_offset,
        non_white_ratio: non_white as f64 / total_pixels as f64,
        dark_ratio: dark as f64 / total_pixels as f64,
        color_ratio: color as f64 / non_white.max(1) as f64,
        max_dark_run_ratio: max_dark_run as f64 / f64::from(width),
        min_channel,
        max_channel,
        black_ratio: black as f64 / total_pixels as f64,
        max_black_run_ratio: max_black_run as f64 / f64::from(width),
        dominant_color,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PbmP4Image {
    pub width: u32,
    pub height: u32,
    pub row_stride: usize,
    /// Raw PBM P4 rows. A 1 bit is foreground and is painted black by the PDF mask writer.
    pub bitmap: Vec<u8>,
}

pub(crate) struct NetpbmData<'a> {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) channels: u8,
    pub(crate) pixels: &'a [u8],
}

pub fn parse_pbm_p4(data: &[u8], max_pixels: u64) -> Result<PbmP4Image> {
    if data.len() < 4 {
        return Err("PBM P4 payload is too short".into());
    }
    if data.get(0..2) != Some(b"P4") {
        return Err("Unsupported PBM format".into());
    }

    let mut offset = 2usize;
    let width = read_netpbm_number(data, &mut offset, "width")?;
    let height = read_netpbm_number(data, &mut offset, "height")?;
    // Enforce the pixel ceiling from the parsed header before copying the
    // payload, matching the file reader so a hostile byte input cannot force a
    // large allocation ahead of the guardrail.
    assert_pixel_limit(width, height, max_pixels)?;
    consume_netpbm_header_terminator(data, &mut offset, "PBM P4")?;

    let row_stride = (width as usize)
        .checked_add(7)
        .ok_or("Invalid PBM P4 row stride")?
        / 8;
    let data_size = row_stride
        .checked_mul(height as usize)
        .ok_or("Invalid PBM P4 payload size")?;
    let data_end = offset
        .checked_add(data_size)
        .ok_or("Invalid PBM P4 payload size")?;
    let bitmap = data
        .get(offset..data_end)
        .ok_or("Truncated PBM P4 payload")?
        .to_vec();

    Ok(PbmP4Image {
        width,
        height,
        row_stride,
        bitmap,
    })
}

pub(crate) fn parse_netpbm(data: &[u8], max_pixels: u64) -> Result<NetpbmData<'_>> {
    if data.len() < 4 {
        return Err("Netpbm payload is too short".into());
    }

    let channels = match data.get(0..2) {
        Some(b"P5") => 1,
        Some(b"P6") => 3,
        _ => return Err("Unsupported Netpbm format".into()),
    };

    let mut offset = 2usize;
    let width = read_netpbm_number(data, &mut offset, "width")?;
    let height = read_netpbm_number(data, &mut offset, "height")?;
    assert_pixel_limit(width, height, max_pixels)?;
    let maxval = read_netpbm_number(data, &mut offset, "maxval")?;
    if maxval != 255 {
        return Err(format!("Unsupported maxval {maxval} (only maxval 255 is supported)").into());
    }
    consume_netpbm_header_terminator(data, &mut offset, "Netpbm")?;

    let data_size = (width as usize)
        .checked_mul(height as usize)
        .and_then(|value| value.checked_mul(channels as usize))
        .ok_or("Invalid Netpbm payload size")?;
    let data_end = offset
        .checked_add(data_size)
        .ok_or("Invalid Netpbm payload size")?;
    let pixels = data
        .get(offset..data_end)
        .ok_or("Truncated Netpbm payload")?;

    Ok(NetpbmData {
        width,
        height,
        channels,
        pixels,
    })
}

fn read_netpbm_number(data: &[u8], offset: &mut usize, label: &str) -> Result<u32> {
    skip_netpbm_whitespace_and_comments(data, offset);
    if *offset >= data.len() {
        return Err(format!("Missing {label} in Netpbm header").into());
    }

    let start = *offset;
    while *offset < data.len() && data[*offset].is_ascii_digit() {
        *offset += 1;
    }
    if start == *offset {
        return Err(format!("Invalid {label} in Netpbm header").into());
    }

    let value = std::str::from_utf8(&data[start..*offset])?.parse::<u32>()?;
    if value == 0 {
        return Err(format!("Invalid {label} in Netpbm header").into());
    }
    Ok(value)
}

fn skip_netpbm_whitespace_and_comments(data: &[u8], offset: &mut usize) {
    while *offset < data.len() {
        let byte = data[*offset];
        if byte == b'#' {
            while *offset < data.len() && data[*offset] != b'\n' {
                *offset += 1;
            }
            if *offset < data.len() {
                *offset += 1;
            }
            continue;
        }
        if is_whitespace_byte(byte) {
            *offset += 1;
            continue;
        }
        break;
    }
}

fn consume_netpbm_header_terminator(data: &[u8], offset: &mut usize, label: &str) -> Result<()> {
    if *offset >= data.len() || !is_whitespace_byte(data[*offset]) {
        return Err(format!("Invalid {label} header terminator").into());
    }
    if data[*offset] == b'\r' && data.get(*offset + 1) == Some(&b'\n') {
        *offset += 2;
    } else {
        *offset += 1;
    }
    Ok(())
}

fn is_whitespace_byte(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

pub(crate) fn is_rgb_data_grayscale(pixels: &[u8], total_pixels: usize) -> bool {
    let Some(expected_len) = total_pixels.checked_mul(3) else {
        return false;
    };
    let Some(pixels) = pixels.get(..expected_len) else {
        return false;
    };

    pixels
        .chunks_exact(3)
        .all(|pixel| pixel[0] == pixel[1] && pixel[0] == pixel[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_netpbm_comments_and_payload() {
        let data = b"P6\n# generated by ddjvu\n2 1\n255\n\x01\x01\x01\x02\x03\x04";
        let netpbm = parse_netpbm(data, 1_000_000).unwrap();

        assert_eq!(netpbm.width, 2);
        assert_eq!(netpbm.height, 1);
        assert_eq!(netpbm.channels, 3);
        assert_eq!(netpbm.pixels, &[1, 1, 1, 2, 3, 4]);
    }

    #[test]
    fn rejects_netpbm_maxval_below_255() {
        let result = parse_netpbm(b"P5\n1 1\n15\n\x0f", 1_000_000);

        assert!(result.is_err());
    }

    #[test]
    fn parses_pbm_p4_comments_whitespace_and_row_stride() {
        let data = b"P4\n# generated by ddjvu\n10\t2\r\n\x80\x7f\xff\xaa";
        let mask = parse_pbm_p4(data, u64::MAX).unwrap();

        assert_eq!(mask.width, 10);
        assert_eq!(mask.height, 2);
        assert_eq!(mask.row_stride, 2);
        assert_eq!(mask.bitmap, vec![0x80, 0x7f, 0xff, 0xaa]);
    }

    #[test]
    fn preserves_pbm_p4_padding_bits_for_mask_polarity() {
        let mask = parse_pbm_p4(b"P4\n3 1\n\xe0", u64::MAX).unwrap();

        assert_eq!(mask.row_stride, 1);
        assert_eq!(mask.bitmap, vec![0b1110_0000]);
    }

    #[test]
    fn rejects_malformed_pbm_p4_input() {
        assert!(parse_pbm_p4(b"P1\n1 1\n\x80", u64::MAX).is_err());
        assert!(parse_pbm_p4(b"P4\n1 1\x80", u64::MAX).is_err());
    }

    #[test]
    fn rejects_truncated_pbm_p4_payload() {
        let result = parse_pbm_p4(b"P4\n9 2\n\x80\x00\xff", u64::MAX);

        assert!(result.is_err());
    }

    #[test]
    fn rejects_pbm_p4_bytes_before_copying_over_the_pixel_limit() {
        // A 16x16 header claims 256 pixels but no payload follows. With a
        // 64-pixel ceiling the limit must fire from the header, before the
        // truncated payload is inspected or copied.
        let error = parse_pbm_p4(b"P4\n16 16\n", 64).unwrap_err();

        assert!(
            error.to_string().contains("too large"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn rejects_oversized_netpbm_headers_before_reading_payload() {
        for (extension, header) in [
            ("pgm", b"P5\n11 1\n255\n".as_slice()),
            ("ppm", b"P6\n11 1\n255\n".as_slice()),
            ("pbm", b"P4\n11 1\n".as_slice()),
        ] {
            let path = std::env::temp_dir().join(format!(
                "evb-pdf-image-combine-header-limit-{}-{extension}",
                std::process::id()
            ));
            std::fs::write(&path, header).unwrap();
            let error = if extension == "pbm" {
                read_pbm_p4_file(std::fs::File::open(&path).unwrap(), 10).unwrap_err()
            } else {
                read_netpbm_file(std::fs::File::open(&path).unwrap(), 10).unwrap_err()
            };
            std::fs::remove_file(path).unwrap();
            assert!(error.to_string().contains("11x1"));
        }
    }

    #[test]
    fn rejects_truncated_pgm_file_before_allocating_declared_raster() {
        // 100_000 x 100_000 grayscale declares a 10 GB raster (within
        // max_pixels) in a tiny header-only file; on 32-bit targets use
        // 32_768 x 32_768 (1 GiB) so `netpbm_payload_size` reaches the
        // metadata check rather than overflowing `usize`.
        #[cfg(target_pointer_width = "64")]
        let (dim, header) = (100_000u64, b"P5\n100000 100000\n255\n".as_slice());
        #[cfg(not(target_pointer_width = "64"))]
        let (dim, header) = (32_768u64, b"P5\n32768 32768\n255\n".as_slice());
        let path = std::env::temp_dir().join(format!(
            "evb-pdf-image-combine-truncated-pgm-{}.pgm",
            std::process::id()
        ));
        std::fs::write(&path, header).unwrap();
        let result = read_netpbm_file(std::fs::File::open(&path).unwrap(), dim * dim);
        let _ = std::fs::remove_file(&path);
        let error = result.unwrap_err();
        assert!(
            error.to_string().contains("Truncated"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn reads_crlf_netpbm_payload_after_header() {
        let path =
            std::env::temp_dir().join(format!("evb-pdf-image-combine-crlf-{}", std::process::id()));
        std::fs::write(&path, b"P5\r\n1 1\r\n255\r\n\x7f").unwrap();
        let image = read_netpbm_file(std::fs::File::open(&path).unwrap(), 1).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(image.pixels, vec![0x7f]);
    }

    #[test]
    fn detects_sparse_rgb_color() {
        let total_pixels = 20_000usize;
        let mut pixels = vec![7u8; total_pixels * 3];
        let sparse_color_offset = 3usize;
        pixels[sparse_color_offset + 1] = 8;

        assert!(!is_rgb_data_grayscale(&pixels, total_pixels));
    }
}
