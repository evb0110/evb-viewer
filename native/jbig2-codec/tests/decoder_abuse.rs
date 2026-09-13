use std::panic::{catch_unwind, AssertUnwindSafe};

use jbig2_codec::{
    decode_pdf_generic, decode_pdf_generic_source, encode_pdf_generic, Bilevel, DecodeLimits,
    Jbig2Error,
};

const PAGE_WIDTH_OFFSET: usize = 11;
const PAGE_HEIGHT_OFFSET: usize = 15;
const FIRST_SEGMENT_LENGTH_OFFSET: usize = 7;
const SECOND_SEGMENT_OFFSET: usize = 30;
const SECOND_SEGMENT_LENGTH_OFFSET: usize = SECOND_SEGMENT_OFFSET + 7;
const REGION_DATA_OFFSET: usize = SECOND_SEGMENT_OFFSET + 11;
const REGION_WIDTH_OFFSET: usize = REGION_DATA_OFFSET;
const REGION_HEIGHT_OFFSET: usize = REGION_DATA_OFFSET + 4;
const GENERIC_REGION_HEADER_LENGTH: usize = 26;
const MQ_DATA_OFFSET: usize = REGION_DATA_OFFSET + GENERIC_REGION_HEADER_LENGTH;

fn valid_stream() -> Vec<u8> {
    let mut state = 0x4d59_5df4_d0f3_3173u64;
    let mut rows = vec![0; 4 * 33];
    for row in rows.chunks_exact_mut(4) {
        for byte in row.iter_mut() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *byte = state as u8;
        }
        row[3] &= 0xfe;
    }
    encode_pdf_generic(Bilevel {
        width: 31,
        height: 33,
        rows: &rows,
    })
    .unwrap()
}

fn assert_decode_error(label: &str, data: &[u8], limits: DecodeLimits) -> Jbig2Error {
    let outcome = catch_unwind(AssertUnwindSafe(|| decode_pdf_generic(data, limits)));
    let result = outcome.unwrap_or_else(|_| panic!("{label} panicked"));
    match result {
        Err(error) => error,
        Ok(_) => panic!("{label} decoded successfully"),
    }
}

fn set_u32(data: &mut [u8], offset: usize, value: u32) {
    data[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

#[test]
fn rejects_dimensions_above_the_caller_and_absolute_hard_caps_without_panicking() {
    let mut maximum_dimensions = valid_stream();
    for offset in [
        PAGE_WIDTH_OFFSET,
        PAGE_HEIGHT_OFFSET,
        REGION_WIDTH_OFFSET,
        REGION_HEIGHT_OFFSET,
    ] {
        set_u32(&mut maximum_dimensions, offset, u32::MAX);
    }
    assert_eq!(
        assert_decode_error(
            "maximum dimensions",
            &maximum_dimensions,
            DecodeLimits::new(u64::MAX).with_max_dimension(u32::MAX)
        ),
        Jbig2Error::PixelLimitExceeded {
            pixels: u64::from(u32::MAX) * u64::from(u32::MAX),
            maximum: DecodeLimits::HARD_MAX_PIXELS,
        }
    );

    let mut above_hard_cap = valid_stream();
    let width = u32::try_from(DecodeLimits::HARD_MAX_PIXELS + 1).unwrap();
    set_u32(&mut above_hard_cap, PAGE_WIDTH_OFFSET, width);
    set_u32(&mut above_hard_cap, PAGE_HEIGHT_OFFSET, 1);
    assert_eq!(
        assert_decode_error(
            "absolute hard cap",
            &above_hard_cap,
            DecodeLimits::new(u64::MAX).with_max_dimension(u32::MAX)
        ),
        Jbig2Error::PixelLimitExceeded {
            pixels: u64::from(width),
            maximum: DecodeLimits::HARD_MAX_PIXELS,
        }
    );

    let mut above_caller_cap = valid_stream();
    set_u32(&mut above_caller_cap, PAGE_WIDTH_OFFSET, 65);
    set_u32(&mut above_caller_cap, PAGE_HEIGHT_OFFSET, 64);
    assert_eq!(
        assert_decode_error(
            "caller pixel cap",
            &above_caller_cap,
            DecodeLimits::new(4_095)
        ),
        Jbig2Error::PixelLimitExceeded {
            pixels: 4_160,
            maximum: 4_095,
        }
    );
}

#[test]
fn default_limits_reject_dimensions_above_the_default_side_ceiling() {
    let mut oversized = valid_stream();
    set_u32(
        &mut oversized,
        PAGE_WIDTH_OFFSET,
        jbig2_codec::DEFAULT_MAX_DIMENSION + 1,
    );
    set_u32(&mut oversized, PAGE_HEIGHT_OFFSET, 1);

    assert_eq!(
        assert_decode_error("default dimension cap", &oversized, DecodeLimits::default()),
        Jbig2Error::InvalidDimensions {
            width: jbig2_codec::DEFAULT_MAX_DIMENSION + 1,
            height: 1,
        }
    );
}

#[test]
fn rejects_overflowing_and_unknown_segment_data_lengths_without_panicking() {
    for (label, offset) in [
        ("page segment length", FIRST_SEGMENT_LENGTH_OFFSET),
        ("region segment length", SECOND_SEGMENT_LENGTH_OFFSET),
    ] {
        for length in [u32::MAX - 1, u32::MAX] {
            let mut mutated = valid_stream();
            set_u32(&mut mutated, offset, length);
            assert_decode_error(label, &mutated, DecodeLimits::default());
        }
    }
}

#[test]
fn rejects_invalid_and_truncated_long_form_page_associations_without_panicking() {
    let valid = valid_stream();
    let mut invalid_page = Vec::with_capacity(valid.len() + 3);
    invalid_page.extend_from_slice(&valid[..4]);
    invalid_page.push(valid[4] | 0x40);
    invalid_page.push(valid[5]);
    invalid_page.extend_from_slice(&2u32.to_be_bytes());
    invalid_page.extend_from_slice(&valid[7..]);
    assert_decode_error(
        "invalid long-form page association",
        &invalid_page,
        DecodeLimits::default(),
    );

    for end in 6..10 {
        let mut truncated = valid[..6].to_vec();
        truncated[4] |= 0x40;
        truncated.extend_from_slice(&[0, 0, 0, 1][..end - 6]);
        assert_decode_error(
            "truncated long-form page association",
            &truncated,
            DecodeLimits::default(),
        );
    }
}

#[test]
fn rejects_every_premature_stream_end_without_panicking() {
    let valid = valid_stream();
    for end in 0..valid.len() {
        assert_decode_error(
            "premature stream end",
            &valid[..end],
            DecodeLimits::default(),
        );
    }
}

#[test]
fn rejects_premature_mq_termination_markers_without_panicking() {
    let valid = valid_stream();
    assert!(valid.ends_with(&[0xff, 0xac]));
    for mq_end in MQ_DATA_OFFSET..valid.len() - 2 {
        let mut premature = valid[..mq_end].to_vec();
        premature.extend_from_slice(&[0xff, 0xac]);
        let region_length =
            u32::try_from(GENERIC_REGION_HEADER_LENGTH + (mq_end - MQ_DATA_OFFSET) + 2).unwrap();
        set_u32(&mut premature, SECOND_SEGMENT_LENGTH_OFFSET, region_length);
        assert_decode_error(
            "premature MQ termination marker",
            &premature,
            DecodeLimits::default(),
        );
    }
}

fn truncated_source_stream(valid: &[u8], mq_end: usize) -> Vec<u8> {
    let mut premature = valid[..mq_end].to_vec();
    premature.extend_from_slice(&[0xff, 0xac]);
    let region_length =
        u32::try_from(GENERIC_REGION_HEADER_LENGTH + (mq_end - MQ_DATA_OFFSET) + 2).unwrap();
    set_u32(&mut premature, SECOND_SEGMENT_LENGTH_OFFSET, region_length);
    premature
}

#[test]
fn source_decoder_rejects_a_grossly_truncated_mq_payload_with_an_appended_marker() {
    // The source decoder skips the canonical re-encode check, so a truncated
    // arithmetic payload with `ff ac` appended must be caught by the decoder's
    // own flush-budget guard rather than decoding to Ok from padded state. A
    // stream that keeps only a quarter of its real MQ bytes cannot decode every
    // pixel without leaning heavily on synthesized padding.
    let valid = valid_stream();
    assert!(valid.ends_with(&[0xff, 0xac]));
    let mq_len = (valid.len() - 2) - MQ_DATA_OFFSET;
    let mq_end = MQ_DATA_OFFSET + mq_len / 4;
    let premature = truncated_source_stream(&valid, mq_end);
    assert_eq!(
        decode_pdf_generic_source(&premature, DecodeLimits::default()),
        Err(Jbig2Error::Truncated)
    );
}

#[test]
fn source_decoder_never_panics_and_rejects_nearly_every_truncated_mq_payload() {
    // Sweeping every truncation point, the source decoder must never panic, and
    // the flush-budget guard must reject the overwhelming majority. A couple of
    // near-complete truncations happen to form a structurally valid alternate
    // encoding of a different bitmap (flush stuffing stays within the T.88
    // bound); those decode to a bounded, correctly-sized image rather than
    // panicking, which is not the padded-state threat this guard targets.
    let valid = valid_stream();
    assert!(valid.ends_with(&[0xff, 0xac]));
    let mut rejected = 0usize;
    let mut total = 0usize;
    for mq_end in MQ_DATA_OFFSET..valid.len() - 2 {
        let premature = truncated_source_stream(&valid, mq_end);
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            decode_pdf_generic_source(&premature, DecodeLimits::default())
        }))
        .unwrap_or_else(|_| panic!("source decode panicked at mq_end {mq_end}"));
        total += 1;
        match outcome {
            Err(_) => rejected += 1,
            Ok(decoded) => assert_eq!((decoded.width, decoded.height), (31, 33)),
        }
    }
    assert!(
        rejected * 10 >= total * 9,
        "flush-budget guard rejected only {rejected} of {total} truncations"
    );
}

#[test]
fn source_decoder_accepts_an_intact_stream() {
    let valid = valid_stream();
    let decoded = decode_pdf_generic_source(&valid, DecodeLimits::default())
        .expect("intact source stream should decode");
    assert_eq!((decoded.width, decoded.height), (31, 33));
}

#[test]
fn rejects_systematic_mq_payload_prefix_and_marker_bit_flips_without_panicking() {
    let valid = valid_stream();
    let prefix_end = (MQ_DATA_OFFSET + 32).min(valid.len() - 2);
    for offset in (MQ_DATA_OFFSET..prefix_end).chain(valid.len() - 2..valid.len()) {
        for bit in 0..8 {
            let mut mutated = valid.clone();
            mutated[offset] ^= 1 << bit;
            assert_decode_error(
                &format!("mutated MQ payload offset {offset} bit {bit}"),
                &mutated,
                DecodeLimits::default(),
            );
        }
    }
}
