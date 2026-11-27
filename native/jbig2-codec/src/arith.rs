/// Padded to 64 entries so masking `index & STATE_MASK` proves every lookup
/// in-bounds without runtime panic branches or `unsafe`. Valid T.88 MQ states
/// occupy `0..=46`; padding entries mirror state 46.
const STATE_MASK: u8 = 0x3f;
const STATE_TABLE: [State; 64] = [
    State::new(0x5601, 1, 1, true),
    State::new(0x3401, 2, 6, false),
    State::new(0x1801, 3, 9, false),
    State::new(0x0ac1, 4, 12, false),
    State::new(0x0521, 5, 29, false),
    State::new(0x0221, 38, 33, false),
    State::new(0x5601, 7, 6, true),
    State::new(0x5401, 8, 14, false),
    State::new(0x4801, 9, 14, false),
    State::new(0x3801, 10, 14, false),
    State::new(0x3001, 11, 17, false),
    State::new(0x2401, 12, 18, false),
    State::new(0x1c01, 13, 20, false),
    State::new(0x1601, 29, 21, false),
    State::new(0x5601, 15, 14, true),
    State::new(0x5401, 16, 14, false),
    State::new(0x5101, 17, 15, false),
    State::new(0x4801, 18, 16, false),
    State::new(0x3801, 19, 17, false),
    State::new(0x3401, 20, 18, false),
    State::new(0x3001, 21, 19, false),
    State::new(0x2801, 22, 19, false),
    State::new(0x2401, 23, 20, false),
    State::new(0x2201, 24, 21, false),
    State::new(0x1c01, 25, 22, false),
    State::new(0x1801, 26, 23, false),
    State::new(0x1601, 27, 24, false),
    State::new(0x1401, 28, 25, false),
    State::new(0x1201, 29, 26, false),
    State::new(0x1101, 30, 27, false),
    State::new(0x0ac1, 31, 28, false),
    State::new(0x09c1, 32, 29, false),
    State::new(0x08a1, 33, 30, false),
    State::new(0x0521, 34, 31, false),
    State::new(0x0441, 35, 32, false),
    State::new(0x02a1, 36, 33, false),
    State::new(0x0221, 37, 34, false),
    State::new(0x0141, 38, 35, false),
    State::new(0x0111, 39, 36, false),
    State::new(0x0085, 40, 37, false),
    State::new(0x0049, 41, 38, false),
    State::new(0x0025, 42, 39, false),
    State::new(0x0015, 43, 40, false),
    State::new(0x0009, 44, 41, false),
    State::new(0x0005, 45, 42, false),
    State::new(0x0001, 45, 43, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
    State::new(0x5601, 46, 46, false),
];

#[derive(Clone, Copy)]
struct State {
    qe: u32,
    nmps: u8,
    nlps: u8,
    switch: bool,
}

impl State {
    const fn new(qe: u32, nmps: u8, nlps: u8, switch: bool) -> Self {
        Self {
            qe,
            nmps,
            nlps,
            switch,
        }
    }
}

pub(crate) struct Encoder {
    a: u32,
    c: u32,
    ct: u8,
    buffered_byte: u8,
    has_buffered_byte: bool,
    output: Vec<u8>,
    #[cfg(test)]
    carried_fe: bool,
}

impl Encoder {
    pub(crate) fn new() -> Self {
        Self {
            a: 0x8000,
            c: 0,
            ct: 12,
            buffered_byte: 0,
            has_buffered_byte: false,
            output: Vec::with_capacity(4096),
            #[cfg(test)]
            carried_fe: false,
        }
    }

    #[inline(always)]
    pub(crate) fn encode(&mut self, contexts: &mut [u8], context: usize, bit: u8) {
        let packed = contexts[context];
        let mut index = packed >> 1;
        let mut mps = packed & 1;
        let state = STATE_TABLE[usize::from(index & STATE_MASK)];

        if bit == mps {
            self.a -= state.qe;
            if self.a & 0x8000 == 0 {
                if self.a < state.qe {
                    self.a = state.qe;
                } else {
                    self.c += state.qe;
                }
                index = state.nmps;
                contexts[context] = (index << 1) | mps;
                self.renormalize();
            } else {
                self.c += state.qe;
            }
        } else {
            self.a -= state.qe;
            if self.a < state.qe {
                self.c += state.qe;
            } else {
                self.a = state.qe;
            }
            if state.switch {
                mps ^= 1;
            }
            index = state.nlps;
            contexts[context] = (index << 1) | mps;
            self.renormalize();
        }
    }

    /// Encodes `count` consecutive zero bits in context 0, collapsing runs that
    /// stay above the 0x8000 renormalization threshold into a single subtraction
    /// and producing bit-for-bit identical output to `count` calls to `encode`.
    #[inline]
    pub(crate) fn encode_zero_run_ctx0(&mut self, contexts: &mut [u8], mut count: usize) {
        while count > 0 {
            let packed = contexts[0];
            if packed & 1 == 0 {
                let qe = STATE_TABLE[usize::from((packed >> 1) & STATE_MASK)].qe;
                let max_fast = ((self.a - 0x8000) / qe) as usize;
                if max_fast > 0 {
                    let step = count.min(max_fast);
                    let delta = (step as u32) * qe;
                    self.a -= delta;
                    self.c += delta;
                    count -= step;
                    if count == 0 {
                        return;
                    }
                }
            }
            self.encode(contexts, 0, 0);
            count -= 1;
        }
    }

    pub(crate) fn finish(mut self) -> Vec<u8> {
        let limit = self.c + self.a;
        self.c |= 0xffff;
        if self.c >= limit {
            self.c = self.c.wrapping_sub(0x8000);
        }
        self.c <<= self.ct;
        self.byte_out();
        self.c <<= self.ct;
        self.byte_out();
        self.output.push(self.buffered_byte);
        if self.buffered_byte != 0xff {
            self.output.push(0xff);
        }
        self.output.push(0xac);
        self.output
    }

    #[cold]
    #[inline(never)]
    fn renormalize(&mut self) {
        loop {
            self.a <<= 1;
            self.c <<= 1;
            self.ct -= 1;
            if self.ct == 0 {
                self.byte_out();
            }
            if self.a & 0x8000 != 0 {
                break;
            }
        }
    }

    #[cold]
    #[inline(never)]
    fn byte_out(&mut self) {
        if self.buffered_byte == 0xff {
            self.emit_buffered();
            self.buffered_byte = (self.c >> 20) as u8;
            self.c &= 0x000f_ffff;
            self.ct = 7;
            return;
        }

        if self.c >= 0x0800_0000 {
            #[cfg(test)]
            if self.buffered_byte == 0xfe {
                self.carried_fe = true;
            }
            self.buffered_byte += 1;
            if self.buffered_byte == 0xff {
                self.c &= 0x07ff_ffff;
                self.emit_buffered();
                self.buffered_byte = (self.c >> 20) as u8;
                self.c &= 0x000f_ffff;
                self.ct = 7;
                return;
            }
        }

        self.emit_buffered();
        self.buffered_byte = (self.c >> 19) as u8;
        self.c &= 0x0007_ffff;
        self.ct = 8;
    }

    fn emit_buffered(&mut self) {
        if self.has_buffered_byte {
            self.output.push(self.buffered_byte);
        }
        self.has_buffered_byte = true;
    }
}

pub(crate) struct Decoder<'a> {
    data: &'a [u8],
    byte_position: usize,
    chigh: u32,
    clow: u32,
    ct: u8,
    a: u32,
    stuffed: u32,
}

impl<'a> Decoder<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Option<Self> {
        let &first = data.first()?;
        let mut decoder = Self {
            data,
            byte_position: 0,
            chigh: u32::from(first),
            clow: 0,
            ct: 0,
            a: 0x8000,
            stuffed: 0,
        };
        decoder.byte_in();
        decoder.chigh = ((decoder.chigh << 7) & 0xffff) | (decoder.clow >> 9 & 0x7f);
        decoder.clow = decoder.clow << 7 & 0xffff;
        decoder.ct -= 7;
        Some(decoder)
    }

    #[inline(always)]
    pub(crate) fn decode(&mut self, contexts: &mut [u8], context: usize) -> u8 {
        let packed = contexts[context];
        let mut index = packed >> 1;
        let mut mps = packed & 1;
        let state = STATE_TABLE[usize::from(index & STATE_MASK)];
        let mut a = self.a - state.qe;
        let bit;

        if self.chigh < state.qe {
            if a < state.qe {
                a = state.qe;
                bit = mps;
                index = state.nmps;
            } else {
                a = state.qe;
                bit = mps ^ 1;
                if state.switch {
                    mps = bit;
                }
                index = state.nlps;
            }
        } else {
            self.chigh -= state.qe;
            if a & 0x8000 != 0 {
                self.a = a;
                return mps;
            }
            if a < state.qe {
                bit = mps ^ 1;
                if state.switch {
                    mps = bit;
                }
                index = state.nlps;
            } else {
                bit = mps;
                index = state.nmps;
            }
        }

        loop {
            if self.ct == 0 {
                self.byte_in();
            }
            a <<= 1;
            self.chigh = (self.chigh << 1 & 0xffff) | (self.clow >> 15 & 1);
            self.clow = self.clow << 1 & 0xffff;
            self.ct -= 1;
            if a & 0x8000 != 0 {
                break;
            }
        }
        self.a = a;
        contexts[context] = (index << 1) | mps;
        bit
    }

    /// Decodes up to `max_bits` consecutive zero bits in context 0, collapsing
    /// runs that stay above both `0x8000` (in `a`) and `qe` (in `chigh`) into a
    /// single subtraction. Returns `(zero_bits, hit_one)`: when `hit_one` is
    /// `true`, `zero_bits` leading zeros followed by one `1` bit have been
    /// consumed; when `false`, all `max_bits` bits were zero.
    #[inline]
    pub(crate) fn decode_zero_run_ctx0(
        &mut self,
        contexts: &mut [u8],
        max_bits: usize,
    ) -> (usize, bool) {
        let mut decoded = 0usize;
        while decoded < max_bits {
            let packed = contexts[0];
            if packed & 1 == 0 {
                let qe = STATE_TABLE[usize::from((packed >> 1) & STATE_MASK)].qe;
                let max_fast = ((self.a - 0x8000).min(self.chigh) / qe) as usize;
                if max_fast > 0 {
                    let step = (max_bits - decoded).min(max_fast);
                    let delta = (step as u32) * qe;
                    self.a -= delta;
                    self.chigh -= delta;
                    decoded += step;
                    continue;
                }
            }
            if self.decode(contexts, 0) != 0 {
                return (decoded, true);
            }
            decoded += 1;
        }
        (decoded, false)
    }

    pub(crate) fn stuffed(&self) -> u32 {
        self.stuffed
    }

    #[cold]
    #[inline(never)]
    fn byte_in(&mut self) {
        let current = self.data[self.byte_position];
        if current == 0xff {
            let next = self
                .data
                .get(self.byte_position + 1)
                .copied()
                .unwrap_or(0xff);
            if next > 0x8f {
                self.stuffed += 1;
                self.clow += 0xff00;
                self.ct = 8;
            } else {
                self.byte_position += 1;
                self.clow += u32::from(next) << 9;
                self.ct = 7;
            }
        } else {
            self.byte_position += 1;
            match self.data.get(self.byte_position) {
                Some(next) => self.clow += u32::from(*next) << 8,
                None => {
                    self.stuffed += 1;
                    self.clow += 0xff00;
                }
            }
            self.ct = 8;
        }
        if self.clow > 0xffff {
            self.chigh += self.clow >> 16;
            self.clow &= 0xffff;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLISHED_INPUT: [u8; 32] = [
        0x00, 0x02, 0x00, 0x51, 0x00, 0x00, 0x00, 0xc0, 0x03, 0x52, 0x87, 0x2a, 0xaa, 0xaa, 0xaa,
        0xaa, 0x82, 0xc0, 0x20, 0x00, 0xfc, 0xd7, 0x9e, 0xf6, 0xbf, 0x7f, 0xed, 0x90, 0x4f, 0x46,
        0xa3, 0xbf,
    ];
    const PUBLISHED_STREAM: [u8; 30] = [
        0x84, 0xc7, 0x3b, 0xfc, 0xe1, 0xa1, 0x43, 0x04, 0x02, 0x20, 0x00, 0x00, 0x41, 0x0d, 0xbb,
        0x86, 0xf4, 0x31, 0x7f, 0xff, 0x88, 0xff, 0x37, 0x47, 0x1a, 0xdb, 0x6a, 0xdf, 0xff, 0xac,
    ];

    #[test]
    fn matches_t88_annex_h_mq_vector() {
        let mut encoder = Encoder::new();
        let mut context = [0];
        for byte in PUBLISHED_INPUT {
            for shift in (0..8).rev() {
                encoder.encode(&mut context, 0, byte >> shift & 1);
            }
        }
        assert_eq!(encoder.finish(), PUBLISHED_STREAM);
    }

    #[test]
    fn decodes_t88_annex_h_mq_vector() {
        let mut decoder = Decoder::new(&PUBLISHED_STREAM).unwrap();
        let mut context = [0];
        let mut decoded = [0; 32];
        for (index, byte) in decoded.iter_mut().enumerate() {
            for shift in (0..8).rev() {
                *byte |= decoder.decode(&mut context, 0) << shift;
            }
            assert_eq!(*byte, PUBLISHED_INPUT[index]);
        }
    }

    #[test]
    fn matches_short_message_mq_vectors() {
        assert_eq!(Encoder::new().finish(), [0xff, 0x7f, 0xff, 0xac]);

        for (bit, expected) in [
            (0, &[0x7f, 0xff, 0xac][..]),
            (1, &[0xff, 0x7f, 0xff, 0xac][..]),
        ] {
            let mut encoder = Encoder::new();
            let mut context = [0];
            encoder.encode(&mut context, 0, bit);
            assert_eq!(encoder.finish(), expected);
        }
    }

    #[test]
    fn carries_a_buffered_fe_to_ff() {
        // Each token stores a known MQ context state in bits 0..=6 and the
        // input bit in bit 7. This short sequence reaches Annex E.9's carry
        // branch with B=0xFE.
        const SEQUENCE: [u8; 22] = [
            12, 19, 92, 167, 167, 195, 189, 51, 219, 29, 204, 164, 60, 135, 169, 2, 1, 129, 25,
            171, 12, 214,
        ];
        let mut encoder = Encoder::new();
        let mut context = [0];
        for token in SEQUENCE {
            context[0] = token & 0x7f;
            encoder.encode(&mut context, 0, token >> 7);
        }
        assert!(encoder.carried_fe);
        assert_eq!(encoder.finish(), [0x29, 0xff, 0x05, 0x3f, 0x13, 0xff, 0xac]);
    }

    #[test]
    fn decode_zero_run_ctx0_matches_bit_by_bit_decode() {
        for run_len in [0usize, 1, 7, 8, 9, 31, 64, 513, 4096] {
            for trailing_one in [false, true] {
                let mut encoder = Encoder::new();
                let mut enc_ctx = [0u8; 4];
                encoder.encode_zero_run_ctx0(&mut enc_ctx, run_len);
                if trailing_one {
                    encoder.encode(&mut enc_ctx, 0, 1);
                }
                let stream = encoder.finish();

                let mut fast_dec = Decoder::new(&stream).unwrap();
                let mut ref_dec = Decoder::new(&stream).unwrap();
                let mut fast_ctx = [0u8; 4];
                let mut ref_ctx = [0u8; 4];

                let query_len = run_len + usize::from(trailing_one);
                let (zero_bits, hit_one) = fast_dec.decode_zero_run_ctx0(&mut fast_ctx, query_len);

                let mut ref_zeros = 0usize;
                let mut ref_hit_one = false;
                for _ in 0..query_len {
                    if ref_dec.decode(&mut ref_ctx, 0) != 0 {
                        ref_hit_one = true;
                        break;
                    }
                    ref_zeros += 1;
                }

                assert_eq!((zero_bits, hit_one), (ref_zeros, ref_hit_one));
                assert_eq!((zero_bits, hit_one), (run_len, trailing_one));
                assert_eq!(fast_ctx, ref_ctx);
                assert_eq!(fast_dec.stuffed(), ref_dec.stuffed());
            }
        }
    }
}
