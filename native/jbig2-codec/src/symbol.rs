// Portions of the arithmetic symbol sequencing in this module are derived
// from jbig2enc (Copyright 2006 Google Inc.), Apache License 2.0. The bitmap
// classifier and all verification code are original and deliberately stricter.

use std::collections::{HashMap, VecDeque};

#[cfg(not(target_family = "wasm"))]
use rayon::prelude::*;

use crate::{
    arith::{Decoder, Encoder},
    generic, validate_image, Bilevel, DecodeLimits, Jbig2Error, OwnedBilevel,
};

const SYMBOL_DICTIONARY: u8 = 0;
const IMMEDIATE_TEXT_REGION: u8 = 6;
const PAGE_INFORMATION: u8 = 48;
const PAGE_INFORMATION_LENGTH: usize = 19;
const SYMBOL_DICTIONARY_HEADER_LENGTH: usize = 18;
const TEXT_REGION_HEADER_LENGTH: usize = 23;
const REFINED_TEXT_REGION_HEADER_LENGTH: usize = 27;
const NOMINAL_AT: [u8; 8] = [3, 0xff, 0xfd, 0xff, 2, 0xfe, 0xfe, 0xfe];
const INTEGER_CONTEXT_COUNT: usize = 512;
/// Classification never goes below the conservative jbig2enc 0.80 reference
/// point. Every non-exact class member is refinement-coded against its class
/// exemplar, while the hard 2x2 veto prevents visibly different glyphs from
/// sharing a class even though transport remains pixel-exact.
const MIN_CLASSIFIER_AGREEMENT_PER_MILLE: usize = 800;
const MAX_NEAR_MATCH_COMPONENT_AREA: usize = 16_384;
/// Hard ceiling on the number of symbols a decoded dictionary may declare,
/// enforced before reserving. It matches the encoder's default
/// [`SymbolEncodeLimits::max_symbols`], so every stream this crate produces
/// still decodes, while a hostile count such as `0xffffffff` is rejected before
/// any allocation.
const MAX_DICTIONARY_SYMBOLS: usize = 500_000;
/// Upper bound on the synthesized bits an intact text region consumes past its
/// arithmetic payload while the MQ decoder drains its C register at the
/// terminating marker (T.88 Annex E).
///
/// This was measured across roughly fifty thousand decoded pages: the
/// checked-in scans plus randomized glyph layouts from 40x40 to 440x440, with
/// and without refinement. The largest draw a well-formed page ever made was
/// exactly three bits, and only once its region had ended. Three is therefore
/// the tightest bound that still admits every intact page. A stream that
/// fabricates placements its payload never encoded runs well past it, because
/// each fabricated placement keeps shifting bits out of a register that no
/// real byte refills.
///
/// The allowance belongs to that closing drain alone, so
/// [`check_placement_budget`] spends one bit less than
/// [`check_final_termination_budget`]: over the same layouts no intact page
/// ever reached a placement having drawn more than two.
const MAX_TERMINATION_SYNTHESIZED_BITS: u32 = 3;

/// Defensive limits for lossless symbol extraction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SymbolEncodeLimits {
    /// Maximum connected components across one shared-dictionary chunk.
    pub max_components: usize,
    /// Maximum distinct, strictly verified exemplars in one shared dictionary.
    pub max_symbols: usize,
    /// Maximum near-class exemplar comparisons in one dictionary chunk.
    pub max_class_comparisons: usize,
    /// Maximum near-class exemplar comparisons for one component. Reaching
    /// this fence starts a new exact exemplar instead of scanning an
    /// adversarial same-size bucket to completion.
    pub max_class_comparisons_per_component: usize,
}

impl Default for SymbolEncodeLimits {
    fn default() -> Self {
        Self {
            max_components: 500_000,
            max_symbols: 500_000,
            // One bounded document chunk contains at most 50 pages. The two
            // explicit caps prevent a same-size-component adversary from
            // turning classification into an unbounded quadratic scan.
            max_class_comparisons: 25_000_000,
            max_class_comparisons_per_component: 128,
        }
    }
}

/// A page stream that refers to [`SymbolDocument::globals`] through PDF's
/// `/JBIG2Globals` decode parameter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SymbolPage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    pub component_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SymbolPageFallback {
    pub page_index: usize,
    pub reason: Jbig2Error,
}

/// One shared, strictly verified symbol dictionary and its page streams.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SymbolDocument {
    pub globals: Vec<u8>,
    /// Verified symbol pages. `None` means the caller must retain its generic
    /// lossless payload for this page.
    pub pages: Vec<Option<SymbolPage>>,
    pub fallback_pages: Vec<SymbolPageFallback>,
    pub symbol_count: usize,
    pub component_count: usize,
    /// Deterministic near-class work consumed by this chunk. Exact hash hits
    /// do not consume this budget.
    pub class_comparison_count: usize,
}

/// Strict bitmap comparison policy retained as the permanent audit/test
/// utility. Production symbol pages use pixel-exact post-decode verification.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrictBitmapPolicy {
    pub max_diff_fraction: f64,
}

impl Default for StrictBitmapPolicy {
    fn default() -> Self {
        Self {
            max_diff_fraction: 0.05,
        }
    }
}

/// Encodes a chunk of pages using a cross-page symbol dictionary.
///
/// Classification is intentionally conservative: exact matches are preferred;
/// near matches allow dimensions to vary by at most two pixels, require at
/// least 80% bitmap agreement,
/// and no solid 2x2 difference cluster. Non-exact members use T.88 per-instance
/// refinement coding. Each encoded page is then decoded by this crate and
/// required to match the input pixel-exactly. Any failure rejects that page so
/// callers can retain generic coding.
pub fn encode_pdf_symbol_pages_verified(
    pages: &[Bilevel<'_>],
    limits: SymbolEncodeLimits,
) -> Result<SymbolDocument, Jbig2Error> {
    if pages.is_empty() {
        return Err(Jbig2Error::InvalidSegment(
            "a symbol dictionary needs at least one page",
        ));
    }

    let mut extracted_pages = Vec::with_capacity(pages.len());
    let mut component_count = 0usize;
    for page in pages {
        let stride = validate_image(*page)?;
        let components = extract_components(*page, stride)?;
        component_count = component_count
            .checked_add(components.len())
            .ok_or(Jbig2Error::EncodedDataTooLarge)?;
        if component_count > limits.max_components {
            return Err(Jbig2Error::Unsupported(
                "symbol component count exceeds the configured limit",
            ));
        }
        extracted_pages.push(components);
    }

    if component_count == 0 {
        return Err(Jbig2Error::Unsupported(
            "empty pages are smaller with a non-symbol encoding",
        ));
    }

    let mut symbols = Vec::<Symbol>::new();
    // Buckets keyed by a cheap sampled digest. Class assignment still requires
    // full bitmap equality inside the bucket, so a digest collision costs one
    // extra comparison and never changes classification.
    let mut exact_classes = HashMap::<u64, Vec<(SymbolKey, (usize, i32, i32))>>::new();
    let mut near_classes = HashMap::<(u32, u32), Vec<usize>>::new();
    let mut class_comparisons = 0usize;
    let mut class_budget_exhausted = false;
    let mut placements_by_page = Vec::with_capacity(extracted_pages.len());
    for components in extracted_pages {
        let mut placements = Vec::with_capacity(components.len());
        for component in components {
            let digest = symbol_key_digest(
                component.symbol.width,
                component.symbol.height,
                &component.symbol.rows,
            );
            let bucket = exact_classes.entry(digest).or_default();
            let exact_match = bucket
                .iter()
                .find(|(key, _)| {
                    key.width == component.symbol.width
                        && key.height == component.symbol.height
                        && key.rows == component.symbol.rows
                })
                .map(|&(_, class)| class);
            let (symbol, alignment_x, alignment_y) = match exact_match {
                Some(class) => class,
                None => {
                    let area = component.symbol.width as usize * component.symbol.height as usize;
                    let mut near_match = None;
                    let mut component_comparisons = 0usize;
                    if area <= MAX_NEAR_MATCH_COMPONENT_AREA {
                        'near_class: for width in component.symbol.width.saturating_sub(2)
                            ..=component.symbol.width.saturating_add(2)
                        {
                            for height in component.symbol.height.saturating_sub(2)
                                ..=component.symbol.height.saturating_add(2)
                            {
                                let Some(candidates) = near_classes.get(&(width, height)) else {
                                    continue;
                                };
                                for &candidate in candidates {
                                    if component_comparisons
                                        >= limits.max_class_comparisons_per_component
                                    {
                                        break 'near_class;
                                    }
                                    if class_comparisons >= limits.max_class_comparisons {
                                        class_budget_exhausted = true;
                                        break 'near_class;
                                    }
                                    component_comparisons += 1;
                                    class_comparisons += 1;
                                    if let Some(alignment) = strict_symbol_class_alignment(
                                        &component.symbol,
                                        &symbols[candidate],
                                    ) {
                                        near_match = Some((candidate, alignment));
                                        break 'near_class;
                                    }
                                }
                            }
                        }
                    }
                    if class_budget_exhausted {
                        return Err(Jbig2Error::Unsupported(
                            "symbol classifier comparison budget exceeded",
                        ));
                    }
                    let key = SymbolKey {
                        width: component.symbol.width,
                        height: component.symbol.height,
                        rows: component.symbol.rows.clone(),
                    };
                    match near_match {
                        Some((symbol, (alignment_x, alignment_y))) => {
                            bucket.push((key, (symbol, alignment_x, alignment_y)));
                            (symbol, alignment_x, alignment_y)
                        }
                        None => {
                            if symbols.len() >= limits.max_symbols {
                                return Err(Jbig2Error::Unsupported(
                                    "symbol dictionary exceeds the configured limit",
                                ));
                            }
                            let symbol = symbols.len();
                            bucket.push((key, (symbol, 0, 0)));
                            near_classes
                                .entry((component.symbol.width, component.symbol.height))
                                .or_default()
                                .push(symbol);
                            symbols.push(component.symbol.clone());
                            (symbol, 0, 0)
                        }
                    }
                }
            };
            placements.push(Placement {
                x: component.x,
                bottom: component.y + component.symbol.height - 1,
                symbol,
                source: component.symbol,
                alignment_x,
                alignment_y,
            });
        }
        placements_by_page.push(placements);
    }

    // T.88 symbol dictionaries assign IDs in height-class and then width
    // order. Remap the exact classifier's stable IDs into that wire order.
    let mut order = (0..symbols.len()).collect::<Vec<_>>();
    order.sort_by_key(|&index| (symbols[index].height, symbols[index].width, index));
    let mut remap = vec![0usize; symbols.len()];
    let mut wire_symbols = Vec::with_capacity(symbols.len());
    for (wire_id, original_id) in order.into_iter().enumerate() {
        remap[original_id] = wire_id;
        wire_symbols.push(symbols[original_id].clone());
    }
    for placements in &mut placements_by_page {
        for placement in placements {
            placement.symbol = remap[placement.symbol];
        }
    }

    let globals = encode_symbol_dictionary(&wire_symbols)?;
    let symbol_code_length = log2_up(wire_symbols.len());
    // Every page encodes against the same immutable dictionary with
    // per-invocation coder state, so the verified roundtrips are independent
    // and the indexed collect keeps the exact serial page order and bytes.
    let encode_one = |page: &Bilevel<'_>, placements: &[Placement]| {
        encode_symbol_page(*page, placements, &wire_symbols, symbol_code_length).and_then(|data| {
            let decoded = decode_pdf_symbol_page(
                &globals,
                &data,
                DecodeLimits::new(u64::from(page.width) * u64::from(page.height)),
            )?;
            verify_exact_bitmap(*page, decoded.as_bilevel())?;
            Ok(SymbolPage {
                width: page.width,
                height: page.height,
                data,
                component_count: placements.len(),
            })
        })
    };
    #[cfg(not(target_family = "wasm"))]
    let page_results: Vec<Result<SymbolPage, Jbig2Error>> = pages
        .par_iter()
        .zip(placements_by_page.par_iter())
        .map(|(page, placements)| encode_one(page, placements))
        .collect();
    #[cfg(target_family = "wasm")]
    let page_results: Vec<Result<SymbolPage, Jbig2Error>> = pages
        .iter()
        .zip(placements_by_page.iter())
        .map(|(page, placements)| encode_one(page, placements))
        .collect();
    let mut encoded_pages = Vec::with_capacity(pages.len());
    let mut fallback_pages = Vec::new();
    for (page_index, result) in page_results.into_iter().enumerate() {
        match result {
            Ok(page) => encoded_pages.push(Some(page)),
            Err(reason) => {
                encoded_pages.push(None);
                fallback_pages.push(SymbolPageFallback { page_index, reason });
            }
        }
    }

    Ok(SymbolDocument {
        globals,
        pages: encoded_pages,
        fallback_pages,
        symbol_count: wire_symbols.len(),
        component_count,
        class_comparison_count: class_comparisons,
    })
}

/// Decodes the symbol-dictionary/text-region subset emitted by this module.
/// This is kept public so acceptance and regression tests verify encoded page
/// streams independently from the encoder's in-memory representation.
///
/// This is deliberately not a general T.88 decoder. The arithmetic payload
/// must use the encoder's exact `ff ac` termination and reach it on payload
/// bits, with at most the three-bit closing C-register drain defined by
/// `MAX_TERMINATION_SYNTHESIZED_BITS`. The MQ decoder still supplies 1 bits
/// past end-of-data as T.88 requires; the separate budget rejects a payload
/// that no longer matches its declared placements as [`Jbig2Error::Truncated`].
pub fn decode_pdf_symbol_page(
    globals: &[u8],
    page: &[u8],
    limits: DecodeLimits,
) -> Result<OwnedBilevel, Jbig2Error> {
    let symbols = decode_symbol_dictionary(globals, limits)?;
    if symbols.is_empty() {
        return Err(Jbig2Error::InvalidSegment("empty symbol dictionary"));
    }

    let (page_header, page_info, remaining) = read_segment(page)?;
    if page_header.number != 1
        || page_header.segment_type != PAGE_INFORMATION
        || page_header.page != 1
        || page_info.len() != PAGE_INFORMATION_LENGTH
    {
        return Err(Jbig2Error::InvalidSegment("expected page information"));
    }
    let width = read_u32(page_info, 0)?;
    let height = read_u32(page_info, 4)?;
    if page_info[16] & 0x04 != 0 {
        return Err(Jbig2Error::Unsupported(
            "symbol page default pixel is not white",
        ));
    }
    let stride = validate_dimensions(width, height, limits)?;

    let (text_header, text, trailing) = read_segment(remaining)?;
    if text_header.number != 2
        || text_header.segment_type != IMMEDIATE_TEXT_REGION
        || text_header.page != 1
        || text_header.referred != [0]
    {
        return Err(Jbig2Error::InvalidSegment(
            "expected text region referring to global dictionary 0",
        ));
    }
    if text.len() < TEXT_REGION_HEADER_LENGTH
        || read_u32(text, 0)? != width
        || read_u32(text, 4)? != height
        || text[8..16] != [0; 8]
        || text[16] != 0
    {
        return Err(Jbig2Error::Unsupported(
            "text region is not the full-page arithmetic subset",
        ));
    }
    let flags = u16::from_be_bytes([text[17], text[18]]);
    if !matches!(flags, 0 | 2) {
        return Err(Jbig2Error::Unsupported(
            "text region uses unsupported refinement flags",
        ));
    }
    let refined = flags == 2;
    let header_length = if refined {
        if text.len() < REFINED_TEXT_REGION_HEADER_LENGTH || text[19..23] != [0xff; 4] {
            return Err(Jbig2Error::Unsupported(
                "text region uses unsupported refinement template",
            ));
        }
        REFINED_TEXT_REGION_HEADER_LENGTH
    } else {
        TEXT_REGION_HEADER_LENGTH
    };
    let instances = usize::try_from(read_u32(text, header_length - 4)?)
        .map_err(|_| Jbig2Error::EncodedDataTooLarge)?;
    let arithmetic = &text[header_length..];
    if arithmetic.len() < 2 || !arithmetic.ends_with(&[0xff, 0xac]) {
        return Err(Jbig2Error::InvalidArithmeticData);
    }
    let mut decoder = Decoder::new(arithmetic).ok_or(Jbig2Error::InvalidArithmeticData)?;
    let mut integer_contexts = IntegerContexts::new();
    let mut iaid_contexts = vec![0; 1usize << log2_up(symbols.len())];
    let mut refinement_contexts = vec![0; 1 << 13];
    let mut rows = generic::allocate_zeroed(stride, height)?;

    let initial_t = decode_integer(&mut decoder, integer_contexts.get_mut(IntegerProc::Dt))?
        .ok_or(Jbig2Error::InvalidArithmeticData)?;
    if initial_t != 0 {
        return Err(Jbig2Error::InvalidArithmeticData);
    }
    let mut decoded_instances = 0usize;
    let mut strip_t = 0i64;
    let mut first_s = 0i64;
    let symbol_bits = log2_up(symbols.len());
    while decoded_instances < instances {
        let delta_t = decode_integer(&mut decoder, integer_contexts.get_mut(IntegerProc::Dt))?
            .ok_or(Jbig2Error::InvalidArithmeticData)?;
        strip_t = checked_add_i64(strip_t, delta_t)?;
        let delta_first = decode_integer(&mut decoder, integer_contexts.get_mut(IntegerProc::Fs))?
            .ok_or(Jbig2Error::InvalidArithmeticData)?;
        first_s = checked_add_i64(first_s, delta_first)?;
        let mut current_s = first_s;
        loop {
            let symbol_id = decode_iaid(&mut decoder, &mut iaid_contexts, symbol_bits);
            let exemplar = symbols
                .get(symbol_id)
                .ok_or(Jbig2Error::InvalidArithmeticData)?;
            let refined_symbol;
            let symbol = if refined {
                let indicator =
                    decode_integer(&mut decoder, integer_contexts.get_mut(IntegerProc::Ri))?
                        .ok_or(Jbig2Error::InvalidArithmeticData)?;
                match indicator {
                    0 => exemplar,
                    1 => {
                        let rdw = decode_integer(
                            &mut decoder,
                            integer_contexts.get_mut(IntegerProc::Rdw),
                        )?
                        .ok_or(Jbig2Error::InvalidArithmeticData)?;
                        let rdh = decode_integer(
                            &mut decoder,
                            integer_contexts.get_mut(IntegerProc::Rdh),
                        )?
                        .ok_or(Jbig2Error::InvalidArithmeticData)?;
                        let rdx = decode_integer(
                            &mut decoder,
                            integer_contexts.get_mut(IntegerProc::Rdx),
                        )?
                        .ok_or(Jbig2Error::InvalidArithmeticData)?;
                        let rdy = decode_integer(
                            &mut decoder,
                            integer_contexts.get_mut(IntegerProc::Rdy),
                        )?
                        .ok_or(Jbig2Error::InvalidArithmeticData)?;
                        if !(-2..=2).contains(&rdw)
                            || !(-2..=2).contains(&rdh)
                            || rdx != 0
                            || rdy != 0
                        {
                            return Err(Jbig2Error::Unsupported(
                                "refined symbol exceeds supported geometry delta",
                            ));
                        }
                        let target_width = u32::try_from(exemplar.width as i64 + i64::from(rdw))
                            .map_err(|_| Jbig2Error::InvalidArithmeticData)?;
                        let target_height = u32::try_from(exemplar.height as i64 + i64::from(rdh))
                            .map_err(|_| Jbig2Error::InvalidArithmeticData)?;
                        if target_width == 0 || target_height == 0 {
                            return Err(Jbig2Error::InvalidArithmeticData);
                        }
                        // A positive refinement delta can push a symbol that was
                        // exactly at the per-side ceiling past it, so re-check the
                        // refined target before allocating it.
                        if target_width > limits.max_dimension
                            || target_height > limits.max_dimension
                        {
                            return Err(Jbig2Error::InvalidDimensions {
                                width: target_width,
                                height: target_height,
                            });
                        }
                        refined_symbol = decode_refinement(
                            &mut decoder,
                            &mut refinement_contexts,
                            exemplar,
                            target_width,
                            target_height,
                            rdw >> 1,
                            rdh >> 1,
                        )?;
                        &refined_symbol
                    }
                    _ => return Err(Jbig2Error::InvalidArithmeticData),
                }
            } else {
                exemplar
            };
            check_placement_budget(&decoder)?;
            place_symbol(&mut rows, width, height, stride, current_s, strip_t, symbol)?;
            decoded_instances += 1;
            if decoded_instances > instances {
                return Err(Jbig2Error::InvalidArithmeticData);
            }
            let symbol_width =
                i32::try_from(symbol.width - 1).map_err(|_| Jbig2Error::InvalidArithmeticData)?;
            current_s = checked_add_i64(current_s, symbol_width)?;
            let Some(delta_s) =
                decode_integer(&mut decoder, integer_contexts.get_mut(IntegerProc::Ds))?
            else {
                break;
            };
            current_s = checked_add_i64(current_s, delta_s)?;
        }
    }
    check_final_termination_budget(&decoder)?;

    if !trailing.is_empty() {
        return Err(Jbig2Error::InvalidSegment(
            "unexpected segment after symbol text region",
        ));
    }

    Ok(OwnedBilevel {
        width,
        height,
        rows,
    })
}

/// Rejects a placement whose own decisions were read off synthesized padding
/// rather than off the arithmetic payload's bytes.
///
/// The generic-region path bounds the same padding at byte resolution, which
/// is enough there because its iteration count comes from validated region
/// dimensions. The text-region loop instead runs for the instance count read
/// off the wire, and a placement can cost far less than a byte: measured
/// against this crate's own pages, two fabricated placements fit inside a
/// two-byte flush allowance. Bounding the padding in bits closes that gap
/// while leaving intact pages untouched.
///
/// The call site sits immediately before [`place_symbol`], after this
/// instance's symbol id and refinement have been decoded, because those
/// decisions are the ones a fabricated placement pays for. Checking earlier
/// would let a placement be committed on bits drawn after the check passed.
///
/// The bound here is one bit tighter than [`check_final_termination_budget`]:
/// the three-bit allowance exists for the drain that follows the *last* real
/// placement, so a decode still owing a placement must not have spent it.
fn check_placement_budget(decoder: &Decoder<'_>) -> Result<(), Jbig2Error> {
    if decoder.synthesized_bits() >= MAX_TERMINATION_SYNTHESIZED_BITS {
        return Err(Jbig2Error::Truncated);
    }
    Ok(())
}

/// Rejects a completed text region that drained more synthesized padding than
/// a well-formed stream's terminating flush accounts for.
///
/// This is the post-loop counterpart to [`check_placement_budget`] and spends
/// the full allowance, since by this point every declared placement is done
/// and the remaining draws are the flush itself.
fn check_final_termination_budget(decoder: &Decoder<'_>) -> Result<(), Jbig2Error> {
    if decoder.synthesized_bits() > MAX_TERMINATION_SYNTHESIZED_BITS {
        return Err(Jbig2Error::Truncated);
    }
    Ok(())
}

/// Verifies dimensions, per-component difference density, and the absence of
/// every solid 2x2 difference cluster. This catches precisely the local stroke
/// changes which can turn one Cyrillic glyph into another.
pub fn verify_strict_bitmap(
    original: Bilevel<'_>,
    candidate: Bilevel<'_>,
    policy: StrictBitmapPolicy,
) -> Result<(), Jbig2Error> {
    let original_stride = validate_image(original)?;
    let candidate_stride = validate_image(candidate)?;
    if (original.width, original.height) != (candidate.width, candidate.height)
        || !policy.max_diff_fraction.is_finite()
        || !(0.0..=1.0).contains(&policy.max_diff_fraction)
    {
        return Err(Jbig2Error::VerificationFailedReason(
            "page dimensions or verification policy are invalid",
        ));
    }
    if original.rows == candidate.rows {
        return Ok(());
    }

    let components = extract_components(original, original_stride)?;
    let mut covered_differences = vec![false; original.width as usize * original.height as usize];
    for component in &components {
        let mut differences = 0usize;
        for y in component.y..component.y + component.symbol.height {
            for x in component.x..component.x + component.symbol.width {
                let differs = bit(original.rows, original_stride, x, y)
                    != bit(candidate.rows, candidate_stride, x, y);
                differences += usize::from(differs);
                if differs {
                    covered_differences[y as usize * original.width as usize + x as usize] = true;
                }
            }
        }
        let area =
            usize::try_from(u64::from(component.symbol.width) * u64::from(component.symbol.height))
                .map_err(|_| Jbig2Error::EncodedDataTooLarge)?;
        if differences as f64 > area as f64 * policy.max_diff_fraction {
            return Err(Jbig2Error::VerificationFailedReason(
                "component difference fraction exceeded the limit",
            ));
        }
    }

    for y in 0..original.height.saturating_sub(1) {
        for x in 0..original.width.saturating_sub(1) {
            if [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)]
                .into_iter()
                .all(|(x, y)| {
                    bit(original.rows, original_stride, x, y)
                        != bit(candidate.rows, candidate_stride, x, y)
                })
            {
                return Err(Jbig2Error::VerificationFailedReason(
                    "solid 2x2 difference cluster detected",
                ));
            }
        }
    }

    // A changed pixel must belong to a checked source-component rectangle;
    // otherwise symbol placement introduced an unverified mark in whitespace.
    for y in 0..original.height {
        for x in 0..original.width {
            if bit(original.rows, original_stride, x, y)
                != bit(candidate.rows, candidate_stride, x, y)
                && !covered_differences[y as usize * original.width as usize + x as usize]
            {
                return Err(Jbig2Error::VerificationFailedReason(
                    "difference appeared outside a source component",
                ));
            }
        }
    }
    Ok(())
}

fn verify_exact_bitmap(original: Bilevel<'_>, candidate: Bilevel<'_>) -> Result<(), Jbig2Error> {
    let original_stride = validate_image(original)?;
    let candidate_stride = validate_image(candidate)?;
    if (original.width, original.height) != (candidate.width, candidate.height) {
        return Err(Jbig2Error::VerificationFailedReason(
            "whole-page decoded dimensions differ from the source",
        ));
    }
    let tail_mask = if original.width.is_multiple_of(8) {
        0xff
    } else {
        0xff << (8 - original.width % 8)
    };
    for y in 0..original.height as usize {
        let original_row = &original.rows[y * original_stride..(y + 1) * original_stride];
        let candidate_row = &candidate.rows[y * candidate_stride..(y + 1) * candidate_stride];
        if original_stride > 1
            && original_row[..original_stride - 1] != candidate_row[..candidate_stride - 1]
        {
            return Err(Jbig2Error::VerificationFailedReason(
                "whole-page decoded pixels differ from the source",
            ));
        }
        if (original_row[original_stride - 1] ^ candidate_row[candidate_stride - 1]) & tail_mask
            != 0
        {
            return Err(Jbig2Error::VerificationFailedReason(
                "whole-page decoded pixels differ from the source",
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SymbolKey {
    width: u32,
    height: u32,
    rows: Vec<u8>,
}

/// FNV-1a over the dimensions, row length, and up to 32 sampled row bytes.
/// Cheap enough to probe with borrowed data; exactness comes from the full
/// bitmap comparison inside the digest bucket, not from this hash.
fn symbol_key_digest(width: u32, height: u32, rows: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    const SAMPLES: usize = 32;
    let mut hash = OFFSET_BASIS;
    let mut mix = |value: u64| {
        hash ^= value;
        hash = hash.wrapping_mul(PRIME);
    };
    mix(u64::from(width));
    mix(u64::from(height));
    mix(rows.len() as u64);
    if rows.len() <= SAMPLES {
        for &byte in rows {
            mix(u64::from(byte));
        }
    } else {
        let step = rows.len() / SAMPLES;
        for index in 0..SAMPLES {
            mix(u64::from(rows[index * step]));
        }
    }
    hash
}

impl From<&Symbol> for SymbolKey {
    fn from(symbol: &Symbol) -> Self {
        Self {
            width: symbol.width,
            height: symbol.height,
            rows: symbol.rows.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Symbol {
    width: u32,
    height: u32,
    stride: usize,
    rows: Vec<u8>,
}

struct Component {
    x: u32,
    y: u32,
    symbol: Symbol,
}

#[derive(Clone)]
struct Placement {
    x: u32,
    bottom: u32,
    symbol: usize,
    source: Symbol,
    alignment_x: i32,
    alignment_y: i32,
}

#[cfg(test)]
fn strict_symbol_class_match(candidate: &Symbol, exemplar: &Symbol) -> bool {
    strict_symbol_class_alignment(candidate, exemplar).is_some()
}

fn strict_symbol_class_alignment(candidate: &Symbol, exemplar: &Symbol) -> Option<(i32, i32)> {
    if candidate.width.abs_diff(exemplar.width) > 2
        || candidate.height.abs_diff(exemplar.height) > 2
    {
        return None;
    }
    let centered_x = (candidate.width as i32 - exemplar.width as i32) >> 1;
    let centered_y = (candidate.height as i32 - exemplar.height as i32) >> 1;
    if strict_symbol_class_match_at(candidate, exemplar, centered_x, centered_y) {
        return Some((centered_x, centered_y));
    }
    None
}

fn strict_symbol_class_match_at(candidate: &Symbol, exemplar: &Symbol, dx: i32, dy: i32) -> bool {
    let left = 0.min(dx);
    let top = 0.min(dy);
    let right = (candidate.width as i32).max(dx + exemplar.width as i32);
    let bottom = (candidate.height as i32).max(dy + exemplar.height as i32);
    let area = (right - left) as usize * (bottom - top) as usize;
    let maximum_differences = classifier_maximum_differences(area);
    let mut differences = 0usize;
    for y in top..bottom {
        for x in left..right {
            differences += usize::from(
                symbol_bit_signed(candidate, x, y) != symbol_bit_signed(exemplar, x - dx, y - dy),
            );
            if differences > maximum_differences {
                return false;
            }
        }
    }
    for y in top..bottom - 1 {
        for x in left..right - 1 {
            if [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)]
                .into_iter()
                .all(|(x, y)| {
                    symbol_bit_signed(candidate, x, y)
                        != symbol_bit_signed(exemplar, x - dx, y - dy)
                })
            {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
fn topology_signature(symbol: &Symbol) -> (usize, usize) {
    let width = symbol.width as i32;
    let height = symbol.height as i32;
    let mut visited = vec![false; (width * height) as usize];
    let mut black_components = 0usize;
    let mut enclosed_white = 0usize;
    let mut queue = VecDeque::new();
    for y in 0..height {
        for x in 0..width {
            let index = (y * width + x) as usize;
            if visited[index] {
                continue;
            }
            let black = symbol_bit_signed(symbol, x, y) != 0;
            visited[index] = true;
            queue.push_back((x, y));
            let mut touches_edge = false;
            while let Some((cx, cy)) = queue.pop_front() {
                touches_edge |= cx == 0 || cy == 0 || cx == width - 1 || cy == height - 1;
                for (nx, ny) in [(cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)] {
                    if nx < 0 || ny < 0 || nx >= width || ny >= height {
                        continue;
                    }
                    let next = (ny * width + nx) as usize;
                    if !visited[next] && (symbol_bit_signed(symbol, nx, ny) != 0) == black {
                        visited[next] = true;
                        queue.push_back((nx, ny));
                    }
                }
            }
            if black {
                black_components += 1;
            } else if !touches_edge {
                enclosed_white += 1;
            }
        }
    }
    (black_components, enclosed_white)
}

fn encode_refinement(
    encoder: &mut Encoder,
    contexts: &mut [u8],
    reference: &Symbol,
    target: &Symbol,
    reference_dx: i32,
    reference_dy: i32,
) {
    for y in 0..target.height as i32 {
        for x in 0..target.width as i32 {
            let context = refinement_context(target, reference, x, y, reference_dx, reference_dy);
            let value = symbol_bit_signed(target, x, y);
            encoder.encode(contexts, context, value);
        }
    }
}

fn decode_refinement(
    decoder: &mut Decoder<'_>,
    contexts: &mut [u8],
    reference: &Symbol,
    width: u32,
    height: u32,
    reference_dx: i32,
    reference_dy: i32,
) -> Result<Symbol, Jbig2Error> {
    let stride = width.div_ceil(8) as usize;
    let mut target = Symbol {
        width,
        height,
        stride,
        rows: generic::allocate_zeroed(stride, height)?,
    };
    for y in 0..target.height as i32 {
        for x in 0..target.width as i32 {
            let context = refinement_context(&target, reference, x, y, reference_dx, reference_dy);
            if decoder.decode(contexts, context) != 0 {
                set_bit(&mut target.rows, target.stride, x as u32, y as u32);
            }
        }
    }
    Ok(target)
}

// T.88 template 0 with the standard text-region adaptive pixels (-1,-1).
fn refinement_context(
    target: &Symbol,
    reference: &Symbol,
    x: i32,
    y: i32,
    reference_dx: i32,
    reference_dy: i32,
) -> usize {
    let positions = [
        (false, -1, 0),
        (false, 1, -1),
        (false, 0, -1),
        (false, -1, -1),
        (true, 1, 1),
        (true, 0, 1),
        (true, -1, 1),
        (true, 1, 0),
        (true, 0, 0),
        (true, -1, 0),
        (true, 1, -1),
        (true, 0, -1),
        (true, -1, -1),
    ];
    positions
        .into_iter()
        .enumerate()
        .fold(0usize, |context, (shift, (from_reference, dx, dy))| {
            let value = if from_reference {
                symbol_bit_signed(reference, x - reference_dx + dx, y - reference_dy + dy)
            } else {
                symbol_bit_signed(target, x + dx, y + dy)
            };
            context | (usize::from(value) << shift)
        })
}

fn symbol_bit_signed(symbol: &Symbol, x: i32, y: i32) -> u8 {
    if x < 0 || y < 0 || x >= symbol.width as i32 || y >= symbol.height as i32 {
        0
    } else {
        bit(&symbol.rows, symbol.stride, x as u32, y as u32)
    }
}

fn classifier_maximum_differences(area: usize) -> usize {
    if area < 64 {
        0
    } else {
        area.saturating_mul(1_000 - MIN_CLASSIFIER_AGREEMENT_PER_MILLE) / 1_000
    }
}

fn extract_components(image: Bilevel<'_>, stride: usize) -> Result<Vec<Component>, Jbig2Error> {
    let pixel_count = usize::try_from(u64::from(image.width) * u64::from(image.height))
        .map_err(|_| Jbig2Error::AllocationFailed)?;
    let mut visited = vec![false; pixel_count];
    let mut components = Vec::new();
    let mut queue = VecDeque::new();

    for y in 0..image.height {
        for x in 0..image.width {
            let index = y as usize * image.width as usize + x as usize;
            if visited[index] || bit(image.rows, stride, x, y) == 0 {
                continue;
            }
            visited[index] = true;
            queue.push_back((x, y));
            let (mut min_x, mut max_x, mut min_y, mut max_y) = (x, x, y, y);
            let mut pixels = Vec::new();
            while let Some((current_x, current_y)) = queue.pop_front() {
                pixels.push((current_x, current_y));
                min_x = min_x.min(current_x);
                max_x = max_x.max(current_x);
                min_y = min_y.min(current_y);
                max_y = max_y.max(current_y);
                for delta_y in -1i32..=1 {
                    for delta_x in -1i32..=1 {
                        if delta_x == 0 && delta_y == 0 {
                            continue;
                        }
                        let next_x = current_x as i64 + i64::from(delta_x);
                        let next_y = current_y as i64 + i64::from(delta_y);
                        if next_x < 0
                            || next_y < 0
                            || next_x >= i64::from(image.width)
                            || next_y >= i64::from(image.height)
                        {
                            continue;
                        }
                        let (next_x, next_y) = (next_x as u32, next_y as u32);
                        let next_index = next_y as usize * image.width as usize + next_x as usize;
                        if !visited[next_index] && bit(image.rows, stride, next_x, next_y) != 0 {
                            visited[next_index] = true;
                            queue.push_back((next_x, next_y));
                        }
                    }
                }
            }

            let width = max_x - min_x + 1;
            let height = max_y - min_y + 1;
            let symbol_stride = width.div_ceil(8) as usize;
            let mut rows = vec![0u8; symbol_stride * height as usize];
            for (pixel_x, pixel_y) in pixels {
                set_bit(&mut rows, symbol_stride, pixel_x - min_x, pixel_y - min_y);
            }
            components.push(Component {
                x: min_x,
                y: min_y,
                symbol: Symbol {
                    width,
                    height,
                    stride: symbol_stride,
                    rows,
                },
            });
        }
    }
    Ok(components)
}

fn encode_symbol_dictionary(symbols: &[Symbol]) -> Result<Vec<u8>, Jbig2Error> {
    let mut encoder = Encoder::new();
    let mut integers = IntegerContexts::new();
    let mut bitmap_contexts = vec![0; generic::CONTEXT_COUNT];
    let mut previous_height = 0i32;
    let mut index = 0usize;
    while index < symbols.len() {
        let height =
            i32::try_from(symbols[index].height).map_err(|_| Jbig2Error::EncodedDataTooLarge)?;
        encode_integer(
            &mut encoder,
            integers.get_mut(IntegerProc::Dh),
            height - previous_height,
        );
        previous_height = height;
        let mut previous_width = 0i32;
        while index < symbols.len() && symbols[index].height as i32 == height {
            let symbol = &symbols[index];
            let width = i32::try_from(symbol.width).map_err(|_| Jbig2Error::EncodedDataTooLarge)?;
            encode_integer(
                &mut encoder,
                integers.get_mut(IntegerProc::Dw),
                width - previous_width,
            );
            previous_width = width;
            generic::encode_with_coder(
                &mut encoder,
                &mut bitmap_contexts,
                symbol.width,
                symbol.height,
                &symbol.rows,
                symbol.stride,
                false,
            );
            index += 1;
        }
        encode_oob(&mut encoder, integers.get_mut(IntegerProc::Dw));
    }
    encode_integer(&mut encoder, integers.get_mut(IntegerProc::Ex), 0);
    encode_integer(
        &mut encoder,
        integers.get_mut(IntegerProc::Ex),
        i32::try_from(symbols.len()).map_err(|_| Jbig2Error::EncodedDataTooLarge)?,
    );
    let arithmetic = encoder.finish();
    let length = SYMBOL_DICTIONARY_HEADER_LENGTH
        .checked_add(arithmetic.len())
        .and_then(|length| u32::try_from(length).ok())
        .ok_or(Jbig2Error::EncodedDataTooLarge)?;
    let mut output = Vec::new();
    write_segment_header(&mut output, 0, SYMBOL_DICTIONARY, &[], 0, length)?;
    output.extend_from_slice(&[0, 0]);
    output.extend_from_slice(&NOMINAL_AT);
    output.extend_from_slice(&(symbols.len() as u32).to_be_bytes());
    output.extend_from_slice(&(symbols.len() as u32).to_be_bytes());
    output.extend_from_slice(&arithmetic);
    Ok(output)
}

fn encode_symbol_page(
    page: Bilevel<'_>,
    placements: &[Placement],
    symbols: &[Symbol],
    symbol_bits: usize,
) -> Result<Vec<u8>, Jbig2Error> {
    let mut sorted = placements.to_vec();
    sorted.sort_by_key(|placement| (placement.bottom, placement.x, placement.symbol));

    let mut encoder = Encoder::new();
    let mut integers = IntegerContexts::new();
    let mut iaid_contexts = vec![0; 1usize << symbol_bits];
    let mut refinement_contexts = vec![0; 1 << 13];
    let refined = sorted
        .iter()
        .any(|placement| placement.source != symbols[placement.symbol]);
    encode_integer(&mut encoder, integers.get_mut(IntegerProc::Dt), 0);
    let mut strip_t = 0i32;
    let mut first_s = 0i32;
    let mut index = 0usize;
    while index < sorted.len() {
        let bottom =
            i32::try_from(sorted[index].bottom).map_err(|_| Jbig2Error::EncodedDataTooLarge)?;
        encode_integer(
            &mut encoder,
            integers.get_mut(IntegerProc::Dt),
            bottom - strip_t,
        );
        strip_t = bottom;
        let row_start = index;
        while index < sorted.len() && sorted[index].bottom as i32 == bottom {
            index += 1;
        }
        let mut current_s = 0i32;
        for (row_offset, placement) in sorted[row_start..index].iter().enumerate() {
            let x = i32::try_from(placement.x).map_err(|_| Jbig2Error::EncodedDataTooLarge)?;
            if row_offset == 0 {
                encode_integer(&mut encoder, integers.get_mut(IntegerProc::Fs), x - first_s);
                first_s = x;
                current_s = x;
            } else {
                encode_integer(
                    &mut encoder,
                    integers.get_mut(IntegerProc::Ds),
                    x - current_s,
                );
                current_s = x;
            }
            encode_iaid(
                &mut encoder,
                &mut iaid_contexts,
                symbol_bits,
                placement.symbol,
            );
            if refined {
                let needs_refinement = placement.source != symbols[placement.symbol];
                encode_integer(
                    &mut encoder,
                    integers.get_mut(IntegerProc::Ri),
                    i32::from(needs_refinement),
                );
                if needs_refinement {
                    let exemplar = &symbols[placement.symbol];
                    let rdw = placement.source.width as i32 - exemplar.width as i32;
                    let rdh = placement.source.height as i32 - exemplar.height as i32;
                    encode_integer(&mut encoder, integers.get_mut(IntegerProc::Rdw), rdw);
                    encode_integer(&mut encoder, integers.get_mut(IntegerProc::Rdh), rdh);
                    // Center the reference in the target. Table 12 turns these
                    // zero offsets into floor(delta/2) reference displacement.
                    encode_integer(&mut encoder, integers.get_mut(IntegerProc::Rdx), 0);
                    encode_integer(&mut encoder, integers.get_mut(IntegerProc::Rdy), 0);
                    encode_refinement(
                        &mut encoder,
                        &mut refinement_contexts,
                        exemplar,
                        &placement.source,
                        placement.alignment_x,
                        placement.alignment_y,
                    );
                }
            }
            current_s = current_s
                .checked_add(i32::try_from(placement.source.width - 1).unwrap())
                .ok_or(Jbig2Error::EncodedDataTooLarge)?;
        }
        encode_oob(&mut encoder, integers.get_mut(IntegerProc::Ds));
    }
    let arithmetic = encoder.finish();

    let header_length = if refined {
        REFINED_TEXT_REGION_HEADER_LENGTH
    } else {
        TEXT_REGION_HEADER_LENGTH
    };
    let text_length = header_length
        .checked_add(arithmetic.len())
        .and_then(|length| u32::try_from(length).ok())
        .ok_or(Jbig2Error::EncodedDataTooLarge)?;
    let mut output = Vec::new();
    write_segment_header(
        &mut output,
        1,
        PAGE_INFORMATION,
        &[],
        1,
        PAGE_INFORMATION_LENGTH as u32,
    )?;
    output.extend_from_slice(&page.width.to_be_bytes());
    output.extend_from_slice(&page.height.to_be_bytes());
    output.extend_from_slice(&0u32.to_be_bytes());
    output.extend_from_slice(&0u32.to_be_bytes());
    output.push(1);
    output.extend_from_slice(&0u16.to_be_bytes());
    write_segment_header(&mut output, 2, IMMEDIATE_TEXT_REGION, &[0], 1, text_length)?;
    output.extend_from_slice(&page.width.to_be_bytes());
    output.extend_from_slice(&page.height.to_be_bytes());
    output.extend_from_slice(&0u32.to_be_bytes());
    output.extend_from_slice(&0u32.to_be_bytes());
    output.push(0);
    output.extend_from_slice(&(if refined { 2u16 } else { 0 }).to_be_bytes());
    if refined {
        output.extend_from_slice(&[0xff; 4]);
    }
    output.extend_from_slice(&(placements.len() as u32).to_be_bytes());
    output.extend_from_slice(&arithmetic);
    Ok(output)
}

fn decode_symbol_dictionary(data: &[u8], limits: DecodeLimits) -> Result<Vec<Symbol>, Jbig2Error> {
    let (header, dictionary, trailing) = read_segment(data)?;
    if header.number != 0
        || header.segment_type != SYMBOL_DICTIONARY
        || header.page != 0
        || !header.referred.is_empty()
        || !trailing.is_empty()
        || dictionary.len() < SYMBOL_DICTIONARY_HEADER_LENGTH
        || dictionary[..2] != [0, 0]
        || dictionary[2..10] != NOMINAL_AT
    {
        return Err(Jbig2Error::InvalidSegment(
            "unsupported global symbol dictionary",
        ));
    }
    let exported =
        usize::try_from(read_u32(dictionary, 10)?).map_err(|_| Jbig2Error::EncodedDataTooLarge)?;
    let new =
        usize::try_from(read_u32(dictionary, 14)?).map_err(|_| Jbig2Error::EncodedDataTooLarge)?;
    if exported != new || new == 0 {
        return Err(Jbig2Error::Unsupported(
            "symbol dictionary does not export every new symbol",
        ));
    }
    // The declared symbol count is attacker-controlled and reaches allocation
    // before any bitmap is decoded, so cap it before reserving. A dictionary
    // claiming millions of symbols cannot be produced by the bounded encoder
    // and would only serve to exhaust memory.
    if new > MAX_DICTIONARY_SYMBOLS {
        return Err(Jbig2Error::Unsupported(
            "symbol dictionary exports more symbols than the decoder allows",
        ));
    }
    let arithmetic = &dictionary[SYMBOL_DICTIONARY_HEADER_LENGTH..];
    if arithmetic.len() < 2 || !arithmetic.ends_with(&[0xff, 0xac]) {
        return Err(Jbig2Error::InvalidArithmeticData);
    }
    let mut decoder = Decoder::new(arithmetic).ok_or(Jbig2Error::InvalidArithmeticData)?;
    let mut integers = IntegerContexts::new();
    let mut bitmap_contexts = vec![0; generic::CONTEXT_COUNT];
    let mut symbols = Vec::new();
    symbols
        .try_reserve_exact(new)
        .map_err(|_| Jbig2Error::AllocationFailed)?;
    let mut height = 0i64;
    // The count ceiling bounds the symbol metadata vector. The aggregate pixel
    // ceiling bounds all bitmap row storage because a one-bit bitmap never uses
    // more bytes than pixels. Together they bound every allocation retained by
    // the decoded dictionary.
    let mut total_pixels = 0u64;
    let pixel_ceiling = limits.max_pixels.min(DecodeLimits::HARD_MAX_PIXELS);
    while symbols.len() < new {
        let delta_height = decode_integer(&mut decoder, integers.get_mut(IntegerProc::Dh))?
            .ok_or(Jbig2Error::InvalidArithmeticData)?;
        height = checked_add_i64(height, delta_height)?;
        if height <= 0 || height > i64::from(u32::MAX) {
            return Err(Jbig2Error::InvalidArithmeticData);
        }
        let mut width = 0i64;
        loop {
            let Some(delta_width) =
                decode_integer(&mut decoder, integers.get_mut(IntegerProc::Dw))?
            else {
                break;
            };
            width = checked_add_i64(width, delta_width)?;
            if width <= 0 || width > i64::from(u32::MAX) || symbols.len() >= new {
                return Err(Jbig2Error::InvalidArithmeticData);
            }
            let (width, height) = (width as u32, height as u32);
            if width > limits.max_dimension || height > limits.max_dimension {
                return Err(Jbig2Error::InvalidDimensions { width, height });
            }
            total_pixels = total_pixels
                .checked_add(u64::from(width) * u64::from(height))
                .ok_or(Jbig2Error::AllocationFailed)?;
            if total_pixels > pixel_ceiling {
                return Err(Jbig2Error::PixelLimitExceeded {
                    pixels: total_pixels,
                    maximum: pixel_ceiling,
                });
            }
            let stride = width.div_ceil(8) as usize;
            let mut rows = generic::allocate_zeroed(stride, height)?;
            generic::decode_with_coder(
                &mut decoder,
                &mut bitmap_contexts,
                width,
                height,
                stride,
                &mut rows,
                false,
            );
            symbols.push(Symbol {
                width,
                height,
                stride,
                rows,
            });
        }
    }
    let excluded = decode_integer(&mut decoder, integers.get_mut(IntegerProc::Ex))?
        .ok_or(Jbig2Error::InvalidArithmeticData)?;
    let included = decode_integer(&mut decoder, integers.get_mut(IntegerProc::Ex))?
        .ok_or(Jbig2Error::InvalidArithmeticData)?;
    if excluded != 0 || included != i32::try_from(new).unwrap() {
        return Err(Jbig2Error::InvalidArithmeticData);
    }
    Ok(symbols)
}

#[derive(Clone, Copy)]
enum IntegerProc {
    Dh = 0,
    Ds = 1,
    Dt = 2,
    Dw = 3,
    Ex = 4,
    Fs = 5,
    Rdh = 6,
    Rdw = 7,
    Rdx = 8,
    Rdy = 9,
    Ri = 10,
}

struct IntegerContexts([[u8; INTEGER_CONTEXT_COUNT]; 11]);

impl IntegerContexts {
    fn new() -> Self {
        Self([[0; INTEGER_CONTEXT_COUNT]; 11])
    }

    fn get_mut(&mut self, procedure: IntegerProc) -> &mut [u8] {
        &mut self.0[procedure as usize]
    }
}

struct IntegerRange {
    bottom: i32,
    top: i32,
    prefix: u8,
    prefix_bits: u8,
    delta: u32,
    value_bits: u8,
}

const INTEGER_RANGES: [IntegerRange; 13] = [
    IntegerRange {
        bottom: 0,
        top: 3,
        prefix: 0,
        prefix_bits: 2,
        delta: 0,
        value_bits: 2,
    },
    IntegerRange {
        bottom: -1,
        top: -1,
        prefix: 9,
        prefix_bits: 4,
        delta: 0,
        value_bits: 0,
    },
    IntegerRange {
        bottom: -3,
        top: -2,
        prefix: 5,
        prefix_bits: 3,
        delta: 2,
        value_bits: 1,
    },
    IntegerRange {
        bottom: 4,
        top: 19,
        prefix: 2,
        prefix_bits: 3,
        delta: 4,
        value_bits: 4,
    },
    IntegerRange {
        bottom: -19,
        top: -4,
        prefix: 3,
        prefix_bits: 3,
        delta: 4,
        value_bits: 4,
    },
    IntegerRange {
        bottom: 20,
        top: 83,
        prefix: 6,
        prefix_bits: 4,
        delta: 20,
        value_bits: 6,
    },
    IntegerRange {
        bottom: -83,
        top: -20,
        prefix: 7,
        prefix_bits: 4,
        delta: 20,
        value_bits: 6,
    },
    IntegerRange {
        bottom: 84,
        top: 339,
        prefix: 14,
        prefix_bits: 5,
        delta: 84,
        value_bits: 8,
    },
    IntegerRange {
        bottom: -339,
        top: -84,
        prefix: 15,
        prefix_bits: 5,
        delta: 84,
        value_bits: 8,
    },
    IntegerRange {
        bottom: 340,
        top: 4435,
        prefix: 30,
        prefix_bits: 6,
        delta: 340,
        value_bits: 12,
    },
    IntegerRange {
        bottom: -4435,
        top: -340,
        prefix: 31,
        prefix_bits: 6,
        delta: 340,
        value_bits: 12,
    },
    IntegerRange {
        bottom: 4436,
        top: 2_000_000_000,
        prefix: 62,
        prefix_bits: 6,
        delta: 4436,
        value_bits: 32,
    },
    IntegerRange {
        bottom: -2_000_000_000,
        top: -4436,
        prefix: 63,
        prefix_bits: 6,
        delta: 4436,
        value_bits: 32,
    },
];

fn encode_integer(encoder: &mut Encoder, contexts: &mut [u8], value: i32) {
    let range = INTEGER_RANGES
        .iter()
        .find(|range| (range.bottom..=range.top).contains(&value))
        .expect("validated JBIG2 integer range");
    let mut previous = 1usize;
    for bit_index in 0..range.prefix_bits {
        let value_bit = range.prefix >> bit_index & 1;
        encoder.encode(contexts, previous, value_bit);
        previous = integer_context(previous, value_bit);
    }
    let magnitude = value.unsigned_abs() - range.delta;
    for bit_index in (0..range.value_bits).rev() {
        let value_bit = (magnitude >> bit_index) as u8 & 1;
        encoder.encode(contexts, previous, value_bit);
        previous = integer_context(previous, value_bit);
    }
}

fn encode_oob(encoder: &mut Encoder, contexts: &mut [u8]) {
    let mut previous = 1usize;
    for bit in [1, 0, 0, 0] {
        encoder.encode(contexts, previous, bit);
        previous = integer_context(previous, bit);
    }
}

fn decode_integer(
    decoder: &mut Decoder<'_>,
    contexts: &mut [u8],
) -> Result<Option<i32>, Jbig2Error> {
    let mut previous = 1usize;
    let sign = decoder.decode(contexts, previous);
    previous = previous << 1 | usize::from(sign);

    let decision = decoder.decode(contexts, previous);
    previous = previous << 1 | usize::from(decision);
    let (value_bits, offset) = if decision == 0 {
        (2u8, 0u32)
    } else {
        let decision = decoder.decode(contexts, previous);
        previous = previous << 1 | usize::from(decision);
        if decision == 0 {
            (4, 4)
        } else {
            let decision = decoder.decode(contexts, previous);
            previous = previous << 1 | usize::from(decision);
            if decision == 0 {
                (6, 20)
            } else {
                let decision = decoder.decode(contexts, previous);
                previous = previous << 1 | usize::from(decision);
                if decision == 0 {
                    (8, 84)
                } else {
                    let decision = decoder.decode(contexts, previous);
                    previous = previous << 1 | usize::from(decision);
                    if decision == 0 {
                        (12, 340)
                    } else {
                        (32, 4436)
                    }
                }
            }
        }
    };

    let mut magnitude = 0u32;
    for _ in 0..value_bits {
        let bit = decoder.decode(contexts, previous);
        previous = integer_context(previous, bit);
        magnitude = magnitude.wrapping_shl(1) | u32::from(bit);
    }
    magnitude = magnitude.saturating_add(offset).min(i32::MAX as u32);
    if sign != 0 && magnitude == 0 {
        return Ok(None);
    }
    let value = i32::try_from(magnitude).map_err(|_| Jbig2Error::InvalidArithmeticData)?;
    Ok(Some(if sign == 0 { value } else { -value }))
}

fn integer_context(previous: usize, bit: u8) -> usize {
    if previous & 0x100 != 0 {
        ((previous << 1 | usize::from(bit)) & 0x1ff) | 0x100
    } else {
        previous << 1 | usize::from(bit)
    }
}

fn encode_iaid(encoder: &mut Encoder, contexts: &mut [u8], bits: usize, value: usize) {
    let mut previous = 1usize;
    for bit_index in (0..bits).rev() {
        let bit = (value >> bit_index & 1) as u8;
        encoder.encode(contexts, previous, bit);
        previous = previous << 1 | usize::from(bit);
    }
}

fn decode_iaid(decoder: &mut Decoder<'_>, contexts: &mut [u8], bits: usize) -> usize {
    let mut previous = 1usize;
    let mut value = 0usize;
    for _ in 0..bits {
        let bit = decoder.decode(contexts, previous);
        previous = previous << 1 | usize::from(bit);
        value = value << 1 | usize::from(bit);
    }
    value
}

fn place_symbol(
    page: &mut [u8],
    page_width: u32,
    page_height: u32,
    stride: usize,
    x: i64,
    bottom: i64,
    symbol: &Symbol,
) -> Result<(), Jbig2Error> {
    let top = bottom - i64::from(symbol.height) + 1;
    if x < 0
        || top < 0
        || x + i64::from(symbol.width) > i64::from(page_width)
        || top + i64::from(symbol.height) > i64::from(page_height)
    {
        return Err(Jbig2Error::InvalidArithmeticData);
    }
    for symbol_y in 0..symbol.height {
        for symbol_x in 0..symbol.width {
            if bit(&symbol.rows, symbol.stride, symbol_x, symbol_y) != 0 {
                set_bit(page, stride, x as u32 + symbol_x, top as u32 + symbol_y);
            }
        }
    }
    Ok(())
}

fn log2_up(value: usize) -> usize {
    usize::try_from(usize::BITS - value.saturating_sub(1).leading_zeros()).unwrap()
}

fn checked_add_i64(value: i64, delta: i32) -> Result<i64, Jbig2Error> {
    value
        .checked_add(i64::from(delta))
        .ok_or(Jbig2Error::InvalidArithmeticData)
}

fn bit(rows: &[u8], stride: usize, x: u32, y: u32) -> u8 {
    rows[y as usize * stride + x as usize / 8] >> (7 - (x as usize & 7)) & 1
}

fn set_bit(rows: &mut [u8], stride: usize, x: u32, y: u32) {
    rows[y as usize * stride + x as usize / 8] |= 0x80 >> (x as usize & 7);
}

fn validate_dimensions(width: u32, height: u32, limits: DecodeLimits) -> Result<usize, Jbig2Error> {
    if width == 0 || height == 0 || width > limits.max_dimension || height > limits.max_dimension {
        return Err(Jbig2Error::InvalidDimensions { width, height });
    }
    let pixels = u64::from(width) * u64::from(height);
    let maximum = limits.max_pixels.min(DecodeLimits::HARD_MAX_PIXELS);
    if pixels > maximum {
        return Err(Jbig2Error::PixelLimitExceeded { pixels, maximum });
    }
    usize::try_from(width.div_ceil(8)).map_err(|_| Jbig2Error::AllocationFailed)
}

fn write_segment_header(
    output: &mut Vec<u8>,
    number: u32,
    segment_type: u8,
    referred: &[u32],
    page: u32,
    length: u32,
) -> Result<(), Jbig2Error> {
    if referred.len() > 4 || page > 255 || number > 256 {
        return Err(Jbig2Error::Unsupported(
            "symbol encoder segment header exceeds the compact subset",
        ));
    }
    output.extend_from_slice(&number.to_be_bytes());
    output.push(segment_type);
    output.push((referred.len() as u8) << 5 | if referred.is_empty() { 0 } else { 2 });
    for &reference in referred {
        output.push(u8::try_from(reference).map_err(|_| Jbig2Error::EncodedDataTooLarge)?);
    }
    output.push(page as u8);
    output.extend_from_slice(&length.to_be_bytes());
    Ok(())
}

struct SegmentHeader {
    number: u32,
    segment_type: u8,
    referred: Vec<u32>,
    page: u32,
}

fn read_segment(data: &[u8]) -> Result<(SegmentHeader, &[u8], &[u8]), Jbig2Error> {
    if data.len() < 6 {
        return Err(Jbig2Error::Truncated);
    }
    let number = read_u32(data, 0)?;
    let flags = data[4];
    if flags & 0xc0 != 0 {
        return Err(Jbig2Error::Unsupported(
            "long page associations are not supported in symbol streams",
        ));
    }
    let referred_count = usize::from(data[5] >> 5);
    if referred_count > 4 {
        return Err(Jbig2Error::Unsupported(
            "long referred-to segment lists are not supported",
        ));
    }
    let reference_size = if number <= 256 {
        1
    } else if number <= 65_536 {
        2
    } else {
        4
    };
    let mut position = 6usize;
    let mut referred = Vec::with_capacity(referred_count);
    for _ in 0..referred_count {
        let reference = match reference_size {
            1 => u32::from(*data.get(position).ok_or(Jbig2Error::Truncated)?),
            2 => u32::from(u16::from_be_bytes(
                data.get(position..position + 2)
                    .ok_or(Jbig2Error::Truncated)?
                    .try_into()
                    .map_err(|_| Jbig2Error::Truncated)?,
            )),
            _ => read_u32(data, position)?,
        };
        position += reference_size;
        referred.push(reference);
    }
    let page = u32::from(*data.get(position).ok_or(Jbig2Error::Truncated)?);
    position += 1;
    let length =
        usize::try_from(read_u32(data, position)?).map_err(|_| Jbig2Error::EncodedDataTooLarge)?;
    position += 4;
    let end = position
        .checked_add(length)
        .filter(|&end| end <= data.len())
        .ok_or(Jbig2Error::Truncated)?;
    Ok((
        SegmentHeader {
            number,
            segment_type: flags & 0x3f,
            referred,
            page,
        },
        &data[position..end],
        &data[end..],
    ))
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, Jbig2Error> {
    Ok(u32::from_be_bytes(
        data.get(offset..offset + 4)
            .ok_or(Jbig2Error::Truncated)?
            .try_into()
            .map_err(|_| Jbig2Error::Truncated)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(rows: &[u8]) -> Bilevel<'_> {
        Bilevel {
            width: 16,
            height: 8,
            rows,
        }
    }

    #[test]
    fn shared_dictionary_round_trips_repeated_components() {
        let first = [
            0,
            0,
            0b0110_0110,
            0,
            0b1111_1111,
            0,
            0b1001_1001,
            0,
            0b1001_1001,
            0,
            0b1111_1111,
            0,
            0,
            0,
            0,
            0,
        ];
        let second = [
            0,
            0,
            0,
            0,
            0b0110_0110,
            0,
            0b1111_1111,
            0,
            0b1001_1001,
            0,
            0b1001_1001,
            0,
            0b1111_1111,
            0,
            0,
            0,
        ];
        let encoded = encode_pdf_symbol_pages_verified(
            &[page(&first), page(&second)],
            SymbolEncodeLimits::default(),
        )
        .unwrap();

        assert!(encoded.symbol_count < encoded.component_count);
        for (source, encoded_page) in [page(&first), page(&second)].into_iter().zip(encoded.pages) {
            let encoded_page = encoded_page.unwrap();
            let decoded = decode_pdf_symbol_page(
                &encoded.globals,
                &encoded_page.data,
                DecodeLimits::default(),
            )
            .unwrap();
            assert_eq!(decoded.as_bilevel().rows, source.rows);
        }
    }

    #[test]
    fn tiny_glyph_classes_remain_pixel_exact() {
        let first = [
            0,
            0,
            0b0110_0000,
            0,
            0b1111_0000,
            0,
            0b1001_0000,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ];
        let second = [
            0,
            0,
            0b0110_0000,
            0,
            0b1111_0000,
            0,
            0b1011_0000,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ];
        let encoded = encode_pdf_symbol_pages_verified(
            &[page(&first), page(&second)],
            SymbolEncodeLimits::default(),
        )
        .unwrap();

        assert_eq!(encoded.symbol_count, 2);
    }

    #[test]
    fn cyrillic_vertical_stroke_merge_is_restored_pixel_exactly() {
        let width = 16u32;
        let height = 24u32;
        let stride = width.div_ceil(8) as usize;
        let mut clean = vec![0u8; stride * height as usize];
        // One connected 10x20 outline gives both candidates the same component
        // bounds. The second candidate's one-pixel vertical stroke is a 9%
        // bitmap change with no solid 2x2 difference cluster. The conservative
        // 80% transport classifier may share the exemplar, but the permanent
        // strict audit rejects it and exact residual-symbol placement restores
        // the stroke without a lossy substitution.
        for x in 2..12 {
            set_bit(&mut clean, stride, x, 2);
            set_bit(&mut clean, stride, x, 21);
        }
        for y in 2..22 {
            set_bit(&mut clean, stride, 2, y);
            set_bit(&mut clean, stride, 11, y);
        }
        let mut stroked = clean.clone();
        for y in 3..21 {
            set_bit(&mut stroked, stride, 6, y);
        }
        let clean_page = Bilevel {
            width,
            height,
            rows: &clean,
        };
        let stroked_page = Bilevel {
            width,
            height,
            rows: &stroked,
        };

        verify_strict_bitmap(
            stroked_page,
            clean_page,
            StrictBitmapPolicy {
                max_diff_fraction: 0.20,
            },
        )
        .unwrap();
        assert_eq!(
            verify_strict_bitmap(stroked_page, clean_page, StrictBitmapPolicy::default()),
            Err(Jbig2Error::VerificationFailedReason(
                "component difference fraction exceeded the limit"
            ))
        );

        let encoded = encode_pdf_symbol_pages_verified(
            &[clean_page, stroked_page],
            SymbolEncodeLimits::default(),
        )
        .unwrap();
        assert_eq!(encoded.symbol_count, 1);
        for (source, encoded_page) in [clean_page, stroked_page].into_iter().zip(encoded.pages) {
            let decoded = decode_pdf_symbol_page(
                &encoded.globals,
                &encoded_page.unwrap().data,
                DecodeLimits::default(),
            )
            .unwrap();
            assert_eq!(decoded.as_bilevel().rows, source.rows);
        }
    }

    #[test]
    fn cyrillic_horizontal_bar_merge_is_restored_pixel_exactly() {
        let width = 32u32;
        let height = 32u32;
        let stride = width.div_ceil(8) as usize;
        let mut open = vec![0u8; stride * height as usize];
        for y in 2..30 {
            set_bit(&mut open, stride, 2, y);
        }
        for x in 2..30 {
            set_bit(&mut open, stride, x, 2);
            set_bit(&mut open, stride, x, 29);
        }
        let mut barred = open.clone();
        for x in 3..19 {
            set_bit(&mut barred, stride, x, 15);
        }
        let open_symbol = extract_components(
            Bilevel {
                width,
                height,
                rows: &open,
            },
            stride,
        )
        .unwrap()
        .remove(0)
        .symbol;
        let barred_symbol = extract_components(
            Bilevel {
                width,
                height,
                rows: &barred,
            },
            stride,
        )
        .unwrap()
        .remove(0)
        .symbol;
        assert_eq!(
            topology_signature(&open_symbol),
            topology_signature(&barred_symbol)
        );
        assert!(strict_symbol_class_match(&open_symbol, &barred_symbol));

        let encoded = encode_pdf_symbol_pages_verified(
            &[
                Bilevel {
                    width,
                    height,
                    rows: &open,
                },
                Bilevel {
                    width,
                    height,
                    rows: &barred,
                },
            ],
            SymbolEncodeLimits::default(),
        )
        .unwrap();
        assert_eq!(encoded.symbol_count, 1);
        for (source, page) in [&open, &barred].into_iter().zip(encoded.pages) {
            let decoded = decode_pdf_symbol_page(
                &encoded.globals,
                &page.unwrap().data,
                DecodeLimits::default(),
            )
            .unwrap();
            assert_eq!(decoded.rows, *source);
        }
    }

    #[test]
    fn conservative_classifier_refines_sparse_holes_but_rejects_a_solid_cluster() {
        let width = 24u32;
        let height = 24u32;
        let stride = width.div_ceil(8) as usize;
        let mut clean = vec![0u8; stride * height as usize];
        for y in 2..22 {
            for x in 2..22 {
                set_bit(&mut clean, stride, x, y);
            }
        }
        let mut sparse = clean.clone();
        for (x, y) in [(6u32, 6u32), (17, 17)] {
            sparse[y as usize * stride + x as usize / 8] &= !(0x80 >> (x as usize & 7));
        }
        let sparse_document = encode_pdf_symbol_pages_verified(
            &[
                Bilevel {
                    width,
                    height,
                    rows: &clean,
                },
                Bilevel {
                    width,
                    height,
                    rows: &sparse,
                },
            ],
            SymbolEncodeLimits::default(),
        )
        .unwrap();
        assert_eq!(sparse_document.symbol_count, 1);
        let decoded_sparse = decode_pdf_symbol_page(
            &sparse_document.globals,
            &sparse_document.pages[1].as_ref().unwrap().data,
            DecodeLimits::default(),
        )
        .unwrap();
        assert_eq!(decoded_sparse.rows, sparse);

        let mut clustered = clean.clone();
        for y in 6..8 {
            for x in 6..8 {
                clustered[y as usize * stride + x as usize / 8] &= !(0x80 >> (x as usize & 7));
            }
        }
        let clustered_document = encode_pdf_symbol_pages_verified(
            &[
                Bilevel {
                    width,
                    height,
                    rows: &clean,
                },
                Bilevel {
                    width,
                    height,
                    rows: &clustered,
                },
            ],
            SymbolEncodeLimits::default(),
        )
        .unwrap();
        assert_eq!(clustered_document.symbol_count, 2);
    }

    #[test]
    fn strict_verifier_rejects_solid_difference_clusters() {
        let source = [0u8; 16];
        let mut candidate = source;
        candidate[0] = 0b1100_0000;
        candidate[2] = 0b1100_0000;
        assert_eq!(
            verify_strict_bitmap(
                page(&source),
                page(&candidate),
                StrictBitmapPolicy {
                    max_diff_fraction: 1.0,
                },
            ),
            Err(Jbig2Error::VerificationFailedReason(
                "solid 2x2 difference cluster detected"
            ))
        );
    }

    #[test]
    fn classifier_budget_bounds_adversarial_same_size_components() {
        let width = 24u32;
        let height = 24u32;
        let stride = width.div_ceil(8) as usize;
        let mut first = vec![0u8; stride * height as usize];
        let mut second = first.clone();
        let mut third = first.clone();
        for y in 2..22 {
            for x in 2..22 {
                set_bit(&mut first, stride, x, y);
                set_bit(&mut second, stride, x, y);
                set_bit(&mut third, stride, x, y);
            }
        }
        // Distinct 2x2 holes keep every component connected but force each
        // same-size candidate into the hard visual-difference veto. Without
        // the deterministic comparison budget this bucket grows quadratically.
        for y in 8..10 {
            for x in 8..10 {
                second[y as usize * stride + x as usize / 8] &= !(0x80 >> (x as usize % 8));
            }
        }
        for y in 14..16 {
            for x in 14..16 {
                third[y as usize * stride + x as usize / 8] &= !(0x80 >> (x as usize % 8));
            }
        }
        let pages = [
            Bilevel {
                width,
                height,
                rows: &first,
            },
            Bilevel {
                width,
                height,
                rows: &second,
            },
            Bilevel {
                width,
                height,
                rows: &third,
            },
        ];
        let locally_bounded = encode_pdf_symbol_pages_verified(
            &pages,
            SymbolEncodeLimits {
                max_class_comparisons_per_component: 0,
                ..SymbolEncodeLimits::default()
            },
        )
        .unwrap();
        assert_eq!(locally_bounded.symbol_count, 3);
        assert_eq!(locally_bounded.class_comparison_count, 0);

        assert_eq!(
            encode_pdf_symbol_pages_verified(
                &pages,
                SymbolEncodeLimits {
                    max_class_comparisons: 1,
                    ..SymbolEncodeLimits::default()
                },
            ),
            Err(Jbig2Error::Unsupported(
                "symbol classifier comparison budget exceeded"
            ))
        );
    }

    #[test]
    fn integer_coder_round_trips_boundaries_and_oob() {
        let mut reference_encoder = Encoder::new();
        let mut reference_contexts = [0; INTEGER_CONTEXT_COUNT];
        encode_integer(&mut reference_encoder, &mut reference_contexts, 0);
        encode_integer(&mut reference_encoder, &mut reference_contexts, -1);
        encode_oob(&mut reference_encoder, &mut reference_contexts);
        assert_eq!(reference_encoder.finish(), [0x9c, 0xd7, 0xff, 0xac]);
        let values = [
            0, 3, 4, 19, 20, 83, 84, 339, 340, 4435, 4436, -1, -2, -3, -4, -19, -20, -83, -84,
            -339, -340, -4435, -4436,
        ];
        let mut encoder = Encoder::new();
        let mut contexts = [0; INTEGER_CONTEXT_COUNT];
        for value in values {
            encode_integer(&mut encoder, &mut contexts, value);
        }
        encode_oob(&mut encoder, &mut contexts);
        let bytes = encoder.finish();
        let mut decoder = Decoder::new(&bytes).unwrap();
        let mut contexts = [0; INTEGER_CONTEXT_COUNT];
        for value in values {
            assert_eq!(
                decode_integer(&mut decoder, &mut contexts).unwrap(),
                Some(value)
            );
        }
        assert_eq!(decode_integer(&mut decoder, &mut contexts).unwrap(), None);
    }
}
