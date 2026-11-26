use crate::{
    arith::{Decoder, Encoder},
    Jbig2Error, OwnedBilevel,
};
use fax::{
    decoder::{decode_g4, pels},
    Color,
};

const CONTEXT_COUNT: usize = 1 << 16;
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
    let mut ltp = false;
    let width = width as usize;
    let full_bytes = width >> 3;
    let tail_bits = width & 7;
    let zero_row = vec![0u8; stride];

    for y in 0..height as usize {
        let row_start = y * stride;
        let current = &rows[row_start..row_start + stride];
        let duplicate = y > 0 && current == &rows[row_start - stride..row_start];
        let sltp = if duplicate { !ltp } else { ltp };
        ltp = duplicate;
        coder.encode(&mut contexts, TPGD_CONTEXT, u8::from(sltp));
        if ltp {
            continue;
        }

        let above0 = if y >= 2 {
            &rows[row_start - 2 * stride..row_start - stride]
        } else {
            &zero_row
        };
        let above1 = if y >= 1 {
            &rows[row_start - stride..row_start]
        } else {
            &zero_row
        };
        let (mut c1, mut c2, mut c3) = initial_contexts_slices(above0, above1);

        let mut byte_idx = 0;
        while byte_idx < full_bytes {
            let next_a0 = if byte_idx + 1 < stride {
                above0[byte_idx + 1]
            } else {
                0
            };
            let next_a1 = if byte_idx + 1 < stride {
                above1[byte_idx + 1]
            } else {
                0
            };
            let cur_byte = current[byte_idx];
            let next_c1 = (((u16::from(above0[byte_idx]) << 8) | u16::from(next_a0)) >> 5) as u8;
            let next_c2 = (((u16::from(above1[byte_idx]) << 8) | u16::from(next_a1)) >> 4) as u8;

            if c1 == 0 && c2 == 0 && c3 == 0 && cur_byte == 0 && next_c1 == 0 && next_c2 == 0 {
                let run_start = byte_idx;
                byte_idx += 1;
                while byte_idx < full_bytes {
                    if current[byte_idx] != 0 {
                        break;
                    }
                    let n_a0 = if byte_idx + 1 < stride {
                        above0[byte_idx + 1]
                    } else {
                        0
                    };
                    if above0[byte_idx] != 0 || (n_a0 & 0xe0) != 0 {
                        break;
                    }
                    let n_a1 = if byte_idx + 1 < stride {
                        above1[byte_idx + 1]
                    } else {
                        0
                    };
                    if above1[byte_idx] != 0 || (n_a1 & 0xf0) != 0 {
                        break;
                    }
                    byte_idx += 1;
                }
                coder.encode_zero_run_ctx0(&mut contexts, (byte_idx - run_start) * 8);
                continue;
            }

            let mut cur = cur_byte;
            let mut n1 = next_c1;
            let mut n2 = next_c2;
            for _ in 0..8 {
                let context = usize::from((c1 << 11) | (c2 << 4) | c3);
                let bit = cur >> 7;
                coder.encode(&mut contexts, context, bit);
                c1 = ((c1 << 1) | u16::from(n1 >> 7)) & 0x1f;
                c2 = ((c2 << 1) | u16::from(n2 >> 7)) & 0x7f;
                c3 = ((c3 << 1) | u16::from(bit)) & 0x0f;
                cur <<= 1;
                n1 <<= 1;
                n2 <<= 1;
            }
            byte_idx += 1;
        }

        if tail_bits > 0 {
            let mut cur = current[full_bytes];
            let mut n1 = above0[full_bytes] << 3;
            let mut n2 = above1[full_bytes] << 4;
            for _ in 0..tail_bits {
                let context = usize::from((c1 << 11) | (c2 << 4) | c3);
                let bit = cur >> 7;
                coder.encode(&mut contexts, context, bit);
                c1 = ((c1 << 1) | u16::from(n1 >> 7)) & 0x1f;
                c2 = ((c2 << 1) | u16::from(n2 >> 7)) & 0x7f;
                c3 = ((c3 << 1) | u16::from(bit)) & 0x0f;
                cur <<= 1;
                n1 <<= 1;
                n2 <<= 1;
            }
        }
    }
    coder.finish()
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
    let mut ltp = false;
    let pixel_width = width as usize;
    let full_bytes = pixel_width >> 3;
    let tail_bits = pixel_width & 7;
    let zero_row = vec![0u8; stride];

    for y in 0..height as usize {
        if typical_prediction {
            ltp ^= coder.decode(&mut contexts, TPGD_CONTEXT) != 0;
        }
        let (before, current_and_after) = rows.split_at_mut(y * stride);
        if ltp {
            if y > 0 {
                current_and_after[..stride].copy_from_slice(&before[(y - 1) * stride..y * stride]);
            }
            continue;
        }

        let current = &mut current_and_after[..stride];
        let above0 = if y >= 2 {
            &before[(y - 2) * stride..(y - 1) * stride]
        } else {
            &zero_row
        };
        let above1 = if y >= 1 {
            &before[(y - 1) * stride..y * stride]
        } else {
            &zero_row
        };
        let (mut c1, mut c2, mut c3) = initial_contexts_slices(above0, above1);

        for byte_idx in 0..full_bytes {
            let next_a0 = if byte_idx + 1 < stride {
                above0[byte_idx + 1]
            } else {
                0
            };
            let next_a1 = if byte_idx + 1 < stride {
                above1[byte_idx + 1]
            } else {
                0
            };
            let mut n1 = (((u16::from(above0[byte_idx]) << 8) | u16::from(next_a0)) >> 5) as u8;
            let mut n2 = (((u16::from(above1[byte_idx]) << 8) | u16::from(next_a1)) >> 4) as u8;
            let mut out_byte = 0u8;
            for _ in 0..8 {
                let context = usize::from((c1 << 11) | (c2 << 4) | c3);
                let bit = coder.decode(&mut contexts, context);
                out_byte = (out_byte << 1) | bit;
                c1 = ((c1 << 1) | u16::from(n1 >> 7)) & 0x1f;
                c2 = ((c2 << 1) | u16::from(n2 >> 7)) & 0x7f;
                c3 = ((c3 << 1) | u16::from(bit)) & 0x0f;
                n1 <<= 1;
                n2 <<= 1;
            }
            current[byte_idx] = out_byte;
        }

        if tail_bits > 0 {
            let mut n1 = above0[full_bytes] << 3;
            let mut n2 = above1[full_bytes] << 4;
            let mut out_byte = 0u8;
            for shift in (8 - tail_bits..8).rev() {
                let context = usize::from((c1 << 11) | (c2 << 4) | c3);
                let bit = coder.decode(&mut contexts, context);
                out_byte |= bit << shift;
                c1 = ((c1 << 1) | u16::from(n1 >> 7)) & 0x1f;
                c2 = ((c2 << 1) | u16::from(n2 >> 7)) & 0x7f;
                c3 = ((c3 << 1) | u16::from(bit)) & 0x0f;
                n1 <<= 1;
                n2 <<= 1;
            }
            current[full_bytes] = out_byte;
        }
    }

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

fn allocate_zeroed(stride: usize, height: u32) -> Result<Vec<u8>, Jbig2Error> {
    let length = stride
        .checked_mul(height as usize)
        .ok_or(Jbig2Error::AllocationFailed)?;
    let mut rows = Vec::new();
    rows.try_reserve_exact(length)
        .map_err(|_| Jbig2Error::AllocationFailed)?;
    rows.resize(length, 0);
    Ok(rows)
}

#[inline]
fn initial_contexts_slices(above0: &[u8], above1: &[u8]) -> (u16, u16, u16) {
    (u16::from(above0[0] >> 5), u16::from(above1[0] >> 4), 0)
}
