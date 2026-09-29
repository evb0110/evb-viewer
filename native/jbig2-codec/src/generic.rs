use crate::{
    arith::{Decoder, Encoder},
    Jbig2Error, OwnedBilevel,
};
use fax::{
    decoder::{decode_g4, pels},
    Color,
};

pub(crate) const CONTEXT_COUNT: usize = 1 << 16;
const TPGD_CONTEXT: usize = 0x9b25;

/// Upper bound on synthesized (stuffed) bytes an intact arithmetic stream needs
/// while draining the C register at its terminating marker. The MQ decoder
/// reads at most two synthetic bytes past the real payload during termination
/// (T.88 Annex E), so a conformant stream stuffs at most twice regardless of
/// image size; this was confirmed empirically across thousands of random
/// streams from 1x1 to 400x400. A truncation that leans on the appended marker
/// to fabricate missing arithmetic bytes stuffs more, so anything above this
/// bound is a padded-state decode.
const MAX_FLUSH_STUFFED_BYTES: u32 = 2;

pub(crate) fn encode(width: u32, height: u32, rows: &[u8], stride: usize) -> Vec<u8> {
    let mut coder = Encoder::new();
    let mut contexts = vec![0; CONTEXT_COUNT];
    encode_with_coder(&mut coder, &mut contexts, width, height, rows, stride, true);
    coder.finish()
}

/// Encodes a bitmap into an existing arithmetic coding stream. Symbol
/// dictionaries use this form because all directly-coded symbol bitmaps in a
/// dictionary share one arithmetic coder and one generic-region context.
pub(crate) fn encode_with_coder(
    coder: &mut Encoder,
    contexts: &mut [u8],
    width: u32,
    height: u32,
    rows: &[u8],
    stride: usize,
    typical_prediction: bool,
) {
    let mut ltp = false;
    let width = width as usize;

    for y in 0..height as usize {
        let duplicate =
            y > 0 && rows[y * stride..(y + 1) * stride] == rows[(y - 1) * stride..y * stride];
        if typical_prediction {
            let sltp = if duplicate { !ltp } else { ltp };
            ltp = duplicate;
            coder.encode(contexts, TPGD_CONTEXT, u8::from(sltp));
        }
        if ltp {
            continue;
        }

        let current = &rows[y * stride..y * stride + stride];
        let above = neighbor_rows(&rows[..y * stride], stride, y);
        let (mut c1, mut c2, mut c3) = initial_contexts(above, width);

        for x in 0..width {
            let context = usize::from((c1 << 11) | (c2 << 4) | c3);
            let bit = current[x >> 3] >> (7 - (x & 7)) & 1;
            coder.encode(contexts, context, bit);
            c1 = ((c1 << 1) | u16::from(bit_at(above.0, x + 3, width))) & 0x1f;
            c2 = ((c2 << 1) | u16::from(bit_at(above.1, x + 4, width))) & 0x7f;
            c3 = ((c3 << 1) | u16::from(bit)) & 0x0f;
        }
    }
}

pub(crate) fn decode(
    width: u32,
    height: u32,
    stride: usize,
    data: &[u8],
    typical_prediction: bool,
    require_canonical_arithmetic: bool,
) -> Result<OwnedBilevel, Jbig2Error> {
    if data.len() < 2 || !data.ends_with(&[0xff, 0xac]) {
        return Err(Jbig2Error::InvalidArithmeticData);
    }
    let mut coder = Decoder::new(data).ok_or(Jbig2Error::InvalidArithmeticData)?;
    let mut contexts = vec![0; CONTEXT_COUNT];
    let mut rows = allocate_zeroed(stride, height)?;
    decode_with_coder(
        &mut coder,
        &mut contexts,
        width,
        height,
        stride,
        &mut rows,
        typical_prediction,
    );

    // A complete stream reaches its terminating `ff ac` marker only for the
    // final C-register flush, which stuffs at most two synthesized bytes
    // regardless of image size. A truncated payload with a marker appended
    // forces the decoder to fabricate the missing arithmetic bytes, producing
    // pixels from padded state. The canonical decoder catches this by
    // re-encoding, but the source decoder disables that check, so reject a
    // stream that leans on more than a small flush budget of stuffed bytes.
    if coder.stuffed() > MAX_FLUSH_STUFFED_BYTES {
        return Err(Jbig2Error::Truncated);
    }

    if require_canonical_arithmetic && encode(width, height, &rows, stride) != data {
        return Err(Jbig2Error::InvalidArithmeticData);
    }

    Ok(OwnedBilevel {
        width,
        height,
        rows,
    })
}

/// Decodes one directly-coded bitmap from an existing arithmetic stream.
pub(crate) fn decode_with_coder(
    coder: &mut Decoder<'_>,
    contexts: &mut [u8],
    width: u32,
    height: u32,
    stride: usize,
    rows: &mut [u8],
    typical_prediction: bool,
) {
    let mut ltp = false;
    let pixel_width = width as usize;

    for y in 0..height as usize {
        if typical_prediction {
            ltp ^= coder.decode(contexts, TPGD_CONTEXT) != 0;
        }
        let (before, current_and_after) = rows.split_at_mut(y * stride);
        if ltp {
            if y > 0 {
                current_and_after[..stride].copy_from_slice(&before[(y - 1) * stride..y * stride]);
            }
            continue;
        }

        let current = &mut current_and_after[..stride];
        let above = neighbor_rows(before, stride, y);
        let (mut c1, mut c2, mut c3) = initial_contexts(above, pixel_width);

        for x in 0..pixel_width {
            let context = usize::from((c1 << 11) | (c2 << 4) | c3);
            let bit = coder.decode(contexts, context);
            current[x >> 3] |= bit << (7 - (x & 7));
            c1 = ((c1 << 1) | u16::from(bit_at(above.0, x + 3, pixel_width))) & 0x1f;
            c2 = ((c2 << 1) | u16::from(bit_at(above.1, x + 4, pixel_width))) & 0x7f;
            c3 = ((c3 << 1) | u16::from(bit)) & 0x0f;
        }
    }
}

pub(crate) fn decode_mmr(
    width: u32,
    height: u32,
    stride: usize,
    data: &[u8],
) -> Result<OwnedBilevel, Jbig2Error> {
    let fax_width = u16::try_from(width)
        .map(u32::from)
        .map_err(|_| Jbig2Error::Unsupported("MMR bitmap width exceeds the decoder limit"))?;
    let fax_height = u16::try_from(height)
        .map(u32::from)
        .map_err(|_| Jbig2Error::Unsupported("MMR bitmap height exceeds the decoder limit"))?;
    let mut rows = allocate_zeroed(stride, height)?;
    let mut decoded_rows = 0usize;
    let decoded = decode_g4(
        data.iter().copied(),
        fax_width,
        Some(fax_height),
        |transitions| {
            if decoded_rows >= height as usize {
                return;
            }
            let row = &mut rows[decoded_rows * stride..(decoded_rows + 1) * stride];
            for (x, color) in pels(transitions, fax_width)
                .take(width as usize)
                .enumerate()
            {
                if color == Color::Black {
                    row[x >> 3] |= 0x80 >> (x & 7);
                }
            }
            decoded_rows += 1;
        },
    );
    if decoded.is_none() || decoded_rows != height as usize {
        return Err(Jbig2Error::InvalidMmrData);
    }
    Ok(OwnedBilevel {
        width,
        height,
        rows,
    })
}

pub(crate) fn allocate_zeroed(stride: usize, height: u32) -> Result<Vec<u8>, Jbig2Error> {
    let length = stride
        .checked_mul(height as usize)
        .ok_or(Jbig2Error::AllocationFailed)?;
    let mut rows = Vec::new();
    rows.try_reserve_exact(length)
        .map_err(|_| Jbig2Error::AllocationFailed)?;
    rows.resize(length, 0);
    Ok(rows)
}

/// The two rows above `y`, in template order: two rows up, then one row up.
/// Rows above the bitmap read as all-zero, so they are absent rather than
/// clamped.
type NeighborRows<'a> = (Option<&'a [u8]>, Option<&'a [u8]>);

fn neighbor_rows(preceding: &[u8], stride: usize, y: usize) -> NeighborRows<'_> {
    (
        (y >= 2).then(|| &preceding[(y - 2) * stride..(y - 1) * stride]),
        (y >= 1).then(|| &preceding[(y - 1) * stride..y * stride]),
    )
}

fn initial_contexts(above: NeighborRows<'_>, width: usize) -> (u16, u16, u16) {
    let two_up = |x| u16::from(bit_at(above.0, x, width));
    let one_up = |x| u16::from(bit_at(above.1, x, width));
    (
        (two_up(0) << 2) | (two_up(1) << 1) | two_up(2),
        (one_up(0) << 3) | (one_up(1) << 2) | (one_up(2) << 1) | one_up(3),
        0,
    )
}

fn bit_at(row: Option<&[u8]>, x: usize, width: usize) -> u8 {
    match row {
        Some(row) if x < width => row[x >> 3] >> (7 - (x & 7)) & 1,
        _ => 0,
    }
}
