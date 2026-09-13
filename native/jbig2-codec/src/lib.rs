//! Pure-Rust lossless JBIG2 generic-region encoding and decoding.
//!
//! Streams use the PDF-embedded sequential layout emitted by `jbig2enc 0.30
//! -p`: segment 0 is page information (type 48), followed by segment 1 as an
//! immediate generic region (type 38). Although type 39 is named "immediate
//! lossless generic region" by T.88, `jbig2enc` uses type 38 and marks the page
//! lossless in its page-information flags; this crate follows that byte layout
//! for PDF interoperability. No file header, end-of-page segment, end-of-file
//! segment, or `/JBIG2Globals` stream is produced.

mod arith;
mod generic;
mod segments;
mod symbol;

pub use symbol::{
    decode_pdf_symbol_page, encode_pdf_symbol_pages_verified, verify_strict_bitmap,
    StrictBitmapPolicy, SymbolDocument, SymbolEncodeLimits, SymbolPage, SymbolPageFallback,
};

use std::{error::Error, fmt};

/// Maximum decoded pixel count used by [`DecodeLimits::default`].
pub const DEFAULT_MAX_PIXELS: u64 = 80_000_000;
pub const DEFAULT_MAX_DIMENSION: u32 = 40_000;

/// A borrowed MSB-first bilevel bitmap using the JBIG2 polarity: one is black.
///
/// Rows have a stride of `ceil(width / 8)` bytes. Unused low bits in the last
/// byte of each row must be zero. PDF consumers decide how these JBIG2 bits map
/// to an image or mask; this crate never applies the DeviceGray polarity used
/// after a PDF `/JBIG2Decode` filter.
#[derive(Clone, Copy, Debug)]
pub struct Bilevel<'a> {
    pub width: u32,
    pub height: u32,
    pub rows: &'a [u8],
}

/// An owned MSB-first bilevel bitmap using the JBIG2 polarity: one is black.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnedBilevel {
    pub width: u32,
    pub height: u32,
    pub rows: Vec<u8>,
}

impl OwnedBilevel {
    /// Borrows this bitmap.
    #[must_use]
    pub fn as_bilevel(&self) -> Bilevel<'_> {
        Bilevel {
            width: self.width,
            height: self.height,
            rows: &self.rows,
        }
    }
}

/// Resource limits applied before allocating a decoded bitmap.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodeLimits {
    pub max_pixels: u64,
    /// Ceiling on either bitmap side, enforced from decoded header values
    /// before any allocation sized from them. [`DecodeLimits::new`] leaves this
    /// set to [`DEFAULT_MAX_DIMENSION`] by [`DecodeLimits::new`].
    pub max_dimension: u32,
}

impl DecodeLimits {
    /// Absolute decoder ceiling, even when a caller supplies a larger limit.
    pub const HARD_MAX_PIXELS: u64 = 512_000_000;

    #[must_use]
    pub const fn new(max_pixels: u64) -> Self {
        Self {
            max_pixels,
            max_dimension: DEFAULT_MAX_DIMENSION,
        }
    }

    /// Narrows the per-side dimension ceiling, rejecting any decoded width or
    /// height above `max_dimension` before its bitmap is allocated.
    #[must_use]
    pub const fn with_max_dimension(self, max_dimension: u32) -> Self {
        Self {
            max_pixels: self.max_pixels,
            max_dimension,
        }
    }
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_PIXELS)
    }
}

/// Failures produced while validating, encoding, or decoding the supported
/// JBIG2 subset.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Jbig2Error {
    InvalidDimensions { width: u32, height: u32 },
    InvalidRowDataLength { expected: usize, actual: usize },
    NonZeroPaddingBits { row: u32 },
    PixelLimitExceeded { pixels: u64, maximum: u64 },
    Truncated,
    InvalidSegment(&'static str),
    Unsupported(&'static str),
    UnsupportedGenericRegionFlags(u8),
    InvalidArithmeticData,
    InvalidMmrData,
    EncodedDataTooLarge,
    AllocationFailed,
    VerificationFailed,
    VerificationFailedReason(&'static str),
}

impl fmt::Display for Jbig2Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions { width, height } => {
                write!(
                    formatter,
                    "invalid JBIG2 bitmap dimensions {width}x{height}"
                )
            }
            Self::InvalidRowDataLength { expected, actual } => write!(
                formatter,
                "invalid bilevel row data length: expected {expected}, got {actual}"
            ),
            Self::NonZeroPaddingBits { row } => {
                write!(formatter, "bilevel row {row} has non-zero padding bits")
            }
            Self::PixelLimitExceeded { pixels, maximum } => write!(
                formatter,
                "decoded bitmap has {pixels} pixels, exceeding the limit of {maximum}"
            ),
            Self::Truncated => formatter.write_str("truncated JBIG2 stream"),
            Self::InvalidSegment(message) => write!(formatter, "invalid JBIG2 segment: {message}"),
            Self::Unsupported(message) => {
                write!(formatter, "unsupported JBIG2 feature: {message}")
            }
            Self::UnsupportedGenericRegionFlags(flags) => write!(
                formatter,
                "unsupported JBIG2 feature: generic region flags 0x{flags:02x} are not MMR or arithmetic template 0"
            ),
            Self::InvalidArithmeticData => formatter.write_str("invalid JBIG2 arithmetic data"),
            Self::InvalidMmrData => formatter.write_str("invalid JBIG2 MMR data"),
            Self::EncodedDataTooLarge => {
                formatter.write_str("encoded JBIG2 segment exceeds the format size limit")
            }
            Self::AllocationFailed => formatter.write_str("failed to allocate JBIG2 bitmap"),
            Self::VerificationFailed => {
                formatter.write_str("JBIG2 encoder verification did not reproduce the input")
            }
            Self::VerificationFailedReason(reason) => {
                write!(formatter, "JBIG2 encoder verification failed: {reason}")
            }
        }
    }
}

impl Error for Jbig2Error {}

/// Encodes one lossless generic-region page as a PDF-embedded JBIG2 stream.
pub fn encode_pdf_generic(image: Bilevel<'_>) -> Result<Vec<u8>, Jbig2Error> {
    let stride = validate_image(image)?;
    segments::encode(image.width, image.height, image.rows, stride)
}

/// Decodes the lossless PDF-embedded generic-region subset emitted by this
/// crate and `jbig2enc -d -p`.
pub fn decode_pdf_generic(data: &[u8], limits: DecodeLimits) -> Result<OwnedBilevel, Jbig2Error> {
    segments::decode(data, limits, true)
}

/// Decodes a structurally valid lossless PDF-embedded generic-region stream
/// without requiring its arithmetic payload to be byte-for-byte identical to
/// this crate's canonical encoder output.
///
/// This is intended for trusted streams extracted from an already-open PDF.
/// Callers still receive all segment, dimension, allocation, and decoder
/// validation; only the encoder-specific canonical byte check is omitted.
pub fn decode_pdf_generic_source(
    data: &[u8],
    limits: DecodeLimits,
) -> Result<OwnedBilevel, Jbig2Error> {
    segments::decode(data, limits, false)
}

/// Encodes and immediately decodes one page, returning an error unless every
/// declared pixel is identical.
pub fn encode_pdf_generic_verified(image: Bilevel<'_>) -> Result<Vec<u8>, Jbig2Error> {
    let encoded = encode_pdf_generic(image)?;
    let pixels = u64::from(image.width) * u64::from(image.height);
    let decoded = segments::decode(&encoded, DecodeLimits::new(pixels), false)?;
    if decoded.width != image.width || decoded.height != image.height || decoded.rows != image.rows
    {
        return Err(Jbig2Error::VerificationFailed);
    }
    Ok(encoded)
}

/// Fuzzing entry point for the segment and arithmetic decoders.
#[doc(hidden)]
pub fn fuzz_decode(data: &[u8]) {
    let _ = decode_pdf_generic(data, DecodeLimits::new(1_000_000));
}

fn validate_image(image: Bilevel<'_>) -> Result<usize, Jbig2Error> {
    if image.width == 0 || image.height == 0 {
        return Err(Jbig2Error::InvalidDimensions {
            width: image.width,
            height: image.height,
        });
    }
    let stride = usize::try_from(u64::from(image.width).div_ceil(8))
        .map_err(|_| Jbig2Error::AllocationFailed)?;
    let expected = stride
        .checked_mul(image.height as usize)
        .ok_or(Jbig2Error::AllocationFailed)?;
    if image.rows.len() != expected {
        return Err(Jbig2Error::InvalidRowDataLength {
            expected,
            actual: image.rows.len(),
        });
    }

    let used_bits = image.width % 8;
    if used_bits != 0 {
        let padding_mask = (1u8 << (8 - used_bits)) - 1;
        for (row, bytes) in image.rows.chunks_exact(stride).enumerate() {
            if bytes[stride - 1] & padding_mask != 0 {
                return Err(Jbig2Error::NonZeroPaddingBits { row: row as u32 });
            }
        }
    }
    Ok(stride)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_source_layout() {
        assert_eq!(
            encode_pdf_generic(Bilevel {
                width: 0,
                height: 1,
                rows: &[],
            }),
            Err(Jbig2Error::InvalidDimensions {
                width: 0,
                height: 1
            })
        );
        assert_eq!(
            encode_pdf_generic(Bilevel {
                width: 9,
                height: 1,
                rows: &[0, 1],
            }),
            Err(Jbig2Error::NonZeroPaddingBits { row: 0 })
        );
    }
}
