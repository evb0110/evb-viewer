//! CCITT Group 3 (T.4, one- and two-dimensional) and Group 4 (T.6) row
//! decoding for 1-bit TIFF strips.
//!
//! The `tiff` decoder handles neither Group 3 nor the bit order of
//! FillOrder 2 strips, so 1-bit CCITT frames are decoded here from their raw
//! strip bytes. Rows come out as packed bitmaps in which a set bit marks a
//! pixel coded black.

use std::io;

use fax::{
    decoder::{DecodeStatus, Group4Decoder},
    maps::{black, mode, white, Mode},
    BitReader, ByteReader,
};

use crate::Result;

/// Zero bytes appended to every strip. A code table peeks up to 13 bits even
/// when the last code of a strip is shorter, and a strip need not end with
/// RTC or EOFB padding.
const STRIP_PADDING_BYTES: usize = 4;
const EOL_BITS: u8 = 12;

fn padded(bytes: impl Iterator<Item = io::Result<u8>>) -> impl Iterator<Item = io::Result<u8>> {
    bytes.chain(std::iter::repeat_n(0, STRIP_PADDING_BYTES).map(Ok))
}

/// Decodes `rows` Group 4 rows into `bitmap`, `row_stride` bytes per row.
pub(crate) fn decode_g4_rows(
    bytes: impl Iterator<Item = io::Result<u8>>,
    width: u32,
    row_stride: usize,
    bitmap: &mut [u8],
) -> Result<()> {
    let mut decoder = Group4Decoder::new(padded(bytes), width)?;
    for row in bitmap.chunks_exact_mut(row_stride) {
        match decoder
            .advance()
            .map_err(|error| format!("Invalid CCITT Group 4 data: {error:?}"))?
        {
            DecodeStatus::Incomplete => fill_black_runs(row, decoder.transition(), width),
            // Encoders may end a strip before its trailing all-white rows.
            DecodeStatus::End => break,
        }
    }
    Ok(())
}

/// Decodes `rows` Group 3 rows into `bitmap`. With `two_dimensional`, each
/// row's EOL is followed by a tag bit that selects one-dimensional (1) or
/// two-dimensional (0) coding against the previous row.
pub(crate) fn decode_g3_rows(
    bytes: impl Iterator<Item = io::Result<u8>>,
    width: u32,
    two_dimensional: bool,
    row_stride: usize,
    bitmap: &mut [u8],
) -> Result<()> {
    let mut reader = ByteReader::new(padded(bytes))?;
    let mut reference = Vec::new();
    let mut current = Vec::new();
    for row in bitmap.chunks_exact_mut(row_stride) {
        skip_fill_and_eol(&mut reader)?;
        current.clear();
        let one_dimensional = !two_dimensional || {
            let tag = reader.peek(1).ok_or("Truncated CCITT Group 3 data")?;
            reader.consume(1)?;
            tag == 1
        };
        if one_dimensional {
            decode_one_dimensional_row(&mut reader, width, &mut current)?;
        } else {
            decode_two_dimensional_row(&mut reader, width, &reference, &mut current)?;
        }
        fill_black_runs(row, &current, width);
        std::mem::swap(&mut reference, &mut current);
    }
    Ok(())
}

/// Consumes any zero fill bits and the EOL code in front of a row. Rows
/// without an EOL are accepted as well.
fn skip_fill_and_eol<R: BitReader>(reader: &mut R) -> Result<()>
where
    R::Error: std::error::Error + 'static,
{
    loop {
        match reader.peek(EOL_BITS) {
            Some(0) => reader.consume(1)?,
            Some(1) => return Ok(reader.consume(EOL_BITS)?),
            _ => return Ok(()),
        }
    }
}

fn run_length<R: BitReader>(reader: &mut R, black_run: bool) -> Result<u32> {
    let mut length = 0u32;
    loop {
        let code = if black_run {
            black::decode(reader)
        } else {
            white::decode(reader)
        }
        .ok_or("Invalid CCITT run-length code")?;
        length = length
            .checked_add(u32::from(code))
            .ok_or("Invalid CCITT run length")?;
        // Makeup codes (multiples of 64) are followed by a terminating code.
        if code < 64 {
            return Ok(length);
        }
    }
}

fn push_change(changes: &mut Vec<u32>, position: u32, width: u32) {
    if position < width {
        changes.push(position);
    }
}

fn decode_one_dimensional_row<R: BitReader>(
    reader: &mut R,
    width: u32,
    changes: &mut Vec<u32>,
) -> Result<()> {
    let mut position = 0u32;
    let mut black_run = false;
    while position < width {
        position = position
            .checked_add(run_length(reader, black_run)?)
            .filter(|end| *end <= width)
            .ok_or("CCITT run exceeds the row width")?;
        push_change(changes, position, width);
        black_run = !black_run;
    }
    Ok(())
}

/// The first change on `reference` after `a0` (at or after the row start for
/// the imaginary `a0` before it) that turns the line `to_black` or white,
/// and the change after it. Changes alternate, starting with a turn to black.
fn reference_changes(reference: &[u32], a0: Option<u32>, to_black: bool, width: u32) -> (u32, u32) {
    let start = reference.partition_point(|&change| a0.is_some_and(|a0| change <= a0));
    let b1_index = (start..reference.len()).find(|index| (index % 2 == 0) == to_black);
    match b1_index {
        Some(index) => (
            reference[index],
            reference.get(index + 1).copied().unwrap_or(width),
        ),
        None => (width, width),
    }
}

fn decode_two_dimensional_row<R: BitReader>(
    reader: &mut R,
    width: u32,
    reference: &[u32],
    changes: &mut Vec<u32>,
) -> Result<()> {
    // `None` is the imaginary white pixel in front of the row.
    let mut a0: Option<u32> = None;
    let mut black = false;
    loop {
        let (b1, b2) = reference_changes(reference, a0, !black, width);
        let start = a0.unwrap_or(0);
        match mode::decode(reader).ok_or("Invalid CCITT Group 3 mode code")? {
            Mode::Pass => a0 = Some(b2),
            Mode::Horizontal => {
                let a1 = start
                    .checked_add(run_length(reader, black)?)
                    .ok_or("CCITT run exceeds the row width")?;
                let a2 = a1
                    .checked_add(run_length(reader, !black)?)
                    .filter(|end| *end <= width)
                    .ok_or("CCITT run exceeds the row width")?;
                push_change(changes, a1, width);
                push_change(changes, a2, width);
                a0 = Some(a2);
            }
            Mode::Vertical(delta) => {
                let a1 = i64::from(b1) + i64::from(delta);
                let after_a0 = a0.map_or(a1 >= 0, |a0| a1 > i64::from(a0));
                if !after_a0 || a1 > i64::from(width) {
                    return Err("Invalid CCITT Group 3 vertical code".into());
                }
                let a1 = a1 as u32;
                push_change(changes, a1, width);
                a0 = Some(a1);
                black = !black;
            }
            Mode::Extension | Mode::EOF => {
                return Err("Unsupported CCITT Group 3 code in a two-dimensional row".into())
            }
        }
        if a0.is_some_and(|a0| a0 >= width) {
            return Ok(());
        }
    }
}

/// Sets the bits of the black runs that `changes` describe. Changes
/// alternate between turning the row black and white, starting white.
fn fill_black_runs(row: &mut [u8], changes: &[u32], width: u32) {
    for run in changes.chunks(2) {
        let start = run[0] as usize;
        let end = run.get(1).map_or(width, |end| (*end).min(width)) as usize;
        for x in start..end {
            row[x / 8] |= 0x80 >> (x % 8);
        }
    }
}
