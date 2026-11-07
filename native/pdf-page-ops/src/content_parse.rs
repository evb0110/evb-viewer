//! The crate's one way into lopdf's content-stream parser. lopdf 0.45 sizes
//! an inline image's data (`BI ... ID ... EI`) from its dictionary with
//! unchecked `usize` arithmetic, so a declared /W of -1, or of 2147483647 on
//! wasm32, overflows: desktop's command aborts and the browser's WebAssembly
//! instance traps. Each dictionary lopdf could read as an inline image is read
//! here first, the way lopdf reads it, and a size lopdf cannot compute is
//! refused before lopdf sees the stream.

use super::*;
use lopdf::content::Content;

/// lopdf nests arrays and dictionaries 100 deep; reading deeper only reads
/// candidates lopdf would reject.
const MAX_NESTING: usize = 128;
/// The token walk is linear: each step advances, and a number's reference
/// lookahead (`obj gen R`) reads at most two more tokens, so a byte is charged
/// a few times. This bound covers that with margin and still stops a stream
/// that would cost more.
const STEPS_PER_BYTE: usize = 16;
const STEP_FLOOR: usize = 1 << 16;

/// Parses a content stream. The outer error refuses an inline image whose
/// size lopdf cannot compute; the inner result is lopdf's own.
pub(crate) fn parse_content(bytes: &[u8]) -> Result<lopdf::Result<Content>> {
    Ok(parse_content_with_inline_images(bytes)?.0)
}

/// An inline image as its dictionary declares it, even where lopdf cannot
/// decode it: width, height, bits per component and whether it is a stencil.
pub(crate) type TInlineImageFacts = Option<(u32, u32, u32, bool)>;

/// [`parse_content`], with each read inline image's declared facts in order.
pub(crate) fn parse_content_with_inline_images(
    bytes: &[u8],
) -> Result<(lopdf::Result<Content>, Vec<TInlineImageFacts>)> {
    let mut reader = CandidateReader {
        bytes,
        steps: bytes
            .len()
            .saturating_mul(STEPS_PER_BYTE)
            .saturating_add(STEP_FLOOR),
        inline_images: Vec::new(),
    };
    // Walk the stream token by token, as lopdf does, so a `BI` inside a
    // string, a comment or an image's data is never read as an image.
    let mut position = reader.space(0)?;
    while position < bytes.len() {
        let rest = reader.rest(position);
        position = if rest.starts_with(b"BI") && !rest.get(2).is_some_and(|byte| is_regular(*byte))
        {
            match reader.check_inline_image(position + 2)? {
                Some(after_data) => after_data,
                None => position + 2,
            }
        } else if let Some((_, end)) = reader.value(position, 0)? {
            end
        } else {
            // An operator, or a token lopdf will reject on its own.
            let operator = rest
                .iter()
                .take_while(|byte| is_regular(**byte))
                .count()
                .max(1);
            reader.charge(operator)?;
            position + operator
        };
        position = reader.space(position)?;
    }
    Ok((Content::decode(bytes), reader.inline_images))
}

fn refusal(detail: &str) -> Box<dyn Error> {
    domain_error(
        NativeErrorCode::CorruptXref,
        format!("PDF content stream declares an inline image {detail}"),
    )
}

enum Value {
    Integer(i64),
    Boolean(bool),
    Name(Vec<u8>),
    Other,
}

fn is_regular(byte: u8) -> bool {
    !b" \t\n\r\0\x0C()<>[]{}/%".contains(&byte)
}

/// Reads PDF objects with lopdf's grammar (`space`, names with `#` escapes,
/// references before numbers), only as far as finding where each one ends.
struct CandidateReader<'a> {
    bytes: &'a [u8],
    steps: usize,
    inline_images: Vec<TInlineImageFacts>,
}

impl<'a> CandidateReader<'a> {
    fn charge(&mut self, steps: usize) -> Result<()> {
        self.steps = self
            .steps
            .checked_sub(steps)
            .ok_or_else(|| refusal("among more candidates than can be checked"))?;
        Ok(())
    }

    fn at(&self, position: usize) -> Option<u8> {
        self.bytes.get(position).copied()
    }

    fn rest(&self, position: usize) -> &'a [u8] {
        self.bytes.get(position..).unwrap_or_default()
    }

    fn digits(&mut self, position: usize) -> Result<usize> {
        let count = self
            .rest(position)
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        self.charge(count)?;
        Ok(count)
    }

    /// lopdf's `space`: white space, NUL, form feed and comments.
    fn space(&mut self, mut position: usize) -> Result<usize> {
        loop {
            self.charge(1)?;
            match self.at(position) {
                Some(b' ' | b'\t' | b'\n' | b'\r' | b'\0' | b'\x0C') => position += 1,
                Some(b'%') => {
                    while !matches!(self.at(position), None | Some(b'\r' | b'\n')) {
                        self.charge(1)?;
                        position += 1;
                    }
                }
                _ => return Ok(position),
            }
        }
    }

    fn content_space(&mut self, position: usize) -> Result<usize> {
        let count = self
            .rest(position)
            .iter()
            .take_while(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
            .count();
        self.charge(count)?;
        Ok(position + count)
    }

    /// A name at its `/`. A `#` without two hex digits ends it, as in lopdf.
    fn name(&mut self, mut position: usize) -> Result<(Vec<u8>, usize)> {
        let mut name = Vec::new();
        position += 1;
        while let Some(byte) = self.at(position).filter(|byte| is_regular(*byte)) {
            self.charge(1)?;
            if byte != b'#' {
                name.push(byte);
                position += 1;
                continue;
            }
            let escaped = self
                .rest(position + 1)
                .get(..2)
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .filter(|hex| hex.bytes().all(|digit| digit.is_ascii_hexdigit()))
                .and_then(|hex| u8::from_str_radix(hex, 16).ok());
            let Some(escaped) = escaped else { break };
            name.push(escaped);
            position += 3;
        }
        Ok((name, position))
    }

    /// The end of a literal string at its `(`. Escaped parentheses do not
    /// nest; this reads any depth, lopdf at most 100.
    fn literal_string(&mut self, mut position: usize) -> Result<Option<usize>> {
        let mut depth = 0usize;
        loop {
            self.charge(1)?;
            match self.at(position) {
                None => return Ok(None),
                Some(b'\\') if self.at(position + 1).is_none() => return Ok(None),
                Some(b'\\') => position += 2,
                Some(b'(') => {
                    depth += 1;
                    position += 1;
                }
                Some(b')') => {
                    depth -= 1;
                    position += 1;
                    if depth == 0 {
                        return Ok(Some(position));
                    }
                }
                Some(_) => position += 1,
            }
        }
    }

    fn hex_string(&mut self, mut position: usize) -> Result<Option<usize>> {
        position += 1;
        loop {
            self.charge(1)?;
            match self.at(position) {
                Some(b'>') => return Ok(Some(position + 1)),
                Some(byte) if byte.is_ascii_hexdigit() || b" \t\n\r\0\x0C".contains(&byte) => {
                    position += 1;
                }
                _ => return Ok(None),
            }
        }
    }

    /// Unsigned digits at `position` that parse as `T`, and their end.
    fn unsigned<T: std::str::FromStr>(&mut self, position: usize) -> Result<Option<usize>> {
        let count = self.digits(position)?;
        let text = std::str::from_utf8(&self.rest(position)[..count]).unwrap_or_default();
        Ok((count > 0 && text.parse::<T>().is_ok()).then_some(position + count))
    }

    /// `object generation R`, which lopdf tries before a number.
    fn reference(&mut self, position: usize) -> Result<Option<usize>> {
        let Some(object_end) = self.unsigned::<u32>(position)? else {
            return Ok(None);
        };
        let generation_at = self.space(object_end)?;
        let Some(generation_end) = self.unsigned::<u16>(generation_at)? else {
            return Ok(None);
        };
        let r_at = self.space(generation_end)?;
        Ok((self.at(r_at) == Some(b'R')).then_some(r_at + 1))
    }

    /// A real (`1.`, `.5`) or an integer, signed or not.
    fn number(&mut self, position: usize) -> Result<Option<(Value, usize)>> {
        let sign = usize::from(matches!(self.at(position), Some(b'+' | b'-')));
        let whole = self.digits(position + sign)?;
        let point = position + sign + whole;
        if self.at(point) == Some(b'.') {
            let fraction = self.digits(point + 1)?;
            return Ok((whole > 0 || fraction > 0).then_some((Value::Other, point + 1 + fraction)));
        }
        let text = std::str::from_utf8(&self.rest(position)[..sign + whole]).unwrap_or_default();
        Ok((whole > 0)
            .then(|| text.parse::<i64>().ok())
            .flatten()
            .map(|value| (Value::Integer(value), point)))
    }

    /// A direct object and the `space` after it.
    fn value(&mut self, position: usize, nesting: usize) -> Result<Option<(Value, usize)>> {
        self.charge(1)?;
        let rest = self.rest(position);
        let parsed = if nesting > MAX_NESTING || rest.is_empty() {
            None
        } else if rest.starts_with(b"null") {
            Some((Value::Other, position + 4))
        } else if rest.starts_with(b"true") {
            Some((Value::Boolean(true), position + 4))
        } else if rest.starts_with(b"false") {
            Some((Value::Boolean(false), position + 5))
        } else {
            match rest[0] {
                b'/' => {
                    let (name, end) = self.name(position)?;
                    Some((Value::Name(name), end))
                }
                b'(' => self
                    .literal_string(position)?
                    .map(|end| (Value::Other, end)),
                b'<' if rest.starts_with(b"<<") => {
                    let first = self.space(position + 2)?;
                    let end = self.entries(first, nesting + 1, None)?;
                    self.rest(end)
                        .starts_with(b">>")
                        .then_some((Value::Other, end + 2))
                }
                b'<' => self.hex_string(position)?.map(|end| (Value::Other, end)),
                b'[' => {
                    let mut at = self.space(position + 1)?;
                    loop {
                        if self.at(at) == Some(b']') {
                            break Some((Value::Other, at + 1));
                        }
                        match self.value(at, nesting + 1)? {
                            Some((_, end)) => at = end,
                            None => break None,
                        }
                    }
                }
                _ => match self.reference(position)? {
                    Some(end) => Some((Value::Other, end)),
                    None => self.number(position)?,
                },
            }
        };
        match parsed {
            Some((value, end)) => Ok(Some((value, self.space(end)?))),
            None => Ok(None),
        }
    }

    /// Reads dictionary entries from `position` and returns the first
    /// position that does not continue them, as lopdf's `inner_dictionary`.
    fn entries(
        &mut self,
        mut position: usize,
        nesting: usize,
        mut read: Option<&mut Vec<(Vec<u8>, Value)>>,
    ) -> Result<usize> {
        while self.at(position) == Some(b'/') {
            let (key, after_key) = self.name(position)?;
            let value_at = self.space(after_key)?;
            let Some((value, end)) = self.value(value_at, nesting)? else {
                break;
            };
            if let Some(read) = read.as_deref_mut() {
                read.push((key, value));
            }
            position = end;
        }
        Ok(position)
    }

    /// The inline image whose dictionary starts after a `BI`, as lopdf sizes
    /// its data: /W, /H and /BPC are integers, components follow /IM or /CS,
    /// and unfiltered data spans `H * ceil(W * components * BPC / 8)` bytes.
    /// Returns where the content continues after the image's data, or `None`
    /// when this is no inline image lopdf would read.
    fn check_inline_image(&mut self, after_bi: usize) -> Result<Option<usize>> {
        let mut read = Vec::new();
        let start = self.content_space(after_bi)?;
        let end = self.entries(start, 0, Some(&mut read))?;
        if !self.rest(end).starts_with(b"ID") {
            return Ok(None);
        }
        let data = self.content_space(end + 2)?;
        // A later entry replaces an earlier one; the short key wins.
        let entry = |short: &[u8], long: &[u8]| -> Option<&Value> {
            let last = |key: &[u8]| read.iter().rev().find(|(name, _)| name == key);
            last(short).or_else(|| last(long)).map(|(_, value)| value)
        };
        let keys: [(&[u8], &[u8]); 3] = [
            (b"W", b"Width"),
            (b"H", b"Height"),
            (b"BPC", b"BitsPerComponent"),
        ];
        let mut sizes = [0u32; 3];
        for (size, (short, long)) in sizes.iter_mut().zip(keys) {
            if let Some(Value::Integer(value)) = entry(short, long) {
                *size = u32::try_from(*value)
                    .ok()
                    .filter(|value| *value > 0)
                    .ok_or_else(|| refusal("whose size is not a positive 32-bit integer"))?;
            }
        }
        let stencil = matches!(entry(b"IM", b"ImageMask"), Some(Value::Boolean(true)));
        let bits = match (stencil, sizes[2]) {
            (true, _) => 1,
            (false, 0) => 8,
            (false, bits) => bits,
        };
        self.inline_images
            .push((sizes[0] > 0 && sizes[1] > 0).then_some((sizes[0], sizes[1], bits, stencil)));
        if sizes.contains(&0) {
            // lopdf stops at a size that is absent or not an integer.
            return self.after_image_data(data);
        }
        let components = if stencil {
            1
        } else {
            match entry(b"CS", b"ColorSpace") {
                Some(Value::Name(name)) => match name.as_slice() {
                    b"DeviceGray" | b"Gray" => 1,
                    b"DeviceRGB" | b"RGB" => 3,
                    b"DeviceRGBA" | b"RGBA" | b"DeviceCMYK" | b"CMYK" => 4,
                    // lopdf refuses other colour spaces before sizing the data.
                    _ => return self.after_image_data(data),
                },
                _ => return self.after_image_data(data),
            }
        };
        let [width, height, bits] = sizes;
        let length = bits
            .checked_mul(components)
            .and_then(|bits| width.checked_mul(bits))
            .map(|bits| bits.div_ceil(8))
            .and_then(|stride| height.checked_mul(stride))
            .ok_or_else(|| refusal("whose data size overflows"))?;
        // lopdf reads unfiltered data of this length; any other image, and
        // data that runs past the stream's end, it skips to its `EI`.
        let unfiltered = entry(b"F", b"Filter").is_none();
        if unfiltered && length as usize <= self.bytes.len() - data {
            // lopdf reads `EI` after the data and may begin the next operation
            // right after it, even another image.
            let end_marker = self.content_space(data + length as usize)?;
            Ok(Some(if self.rest(end_marker).starts_with(b"EI") {
                end_marker + 2
            } else {
                data + length as usize
            }))
        } else {
            self.after_image_data(data)
        }
    }

    /// Where lopdf resumes after an image it skips: right after the first
    /// `EI` with a space, CR or LF on both sides. Without one, lopdf refuses
    /// the stream, so nothing after it is read.
    fn after_image_data(&mut self, data: usize) -> Result<Option<usize>> {
        let skipped = self.rest(data).windows(4).position(|window| {
            matches!(window[0], b' ' | b'\n' | b'\r')
                && &window[1..3] == b"EI"
                && matches!(window[3], b' ' | b'\n' | b'\r')
        });
        self.charge(skipped.unwrap_or(self.bytes.len() - data))?;
        Ok(Some(
            skipped.map_or(self.bytes.len(), |offset| data + offset + 3),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(content: &str) -> bool {
        parse_content(content.as_bytes()).is_err()
    }

    #[test]
    fn parses_inline_images_lopdf_can_size_and_what_only_looks_like_one() {
        assert!(matches!(
            parse_content(b"q BI /W 2 /H 1 /BPC 8 /CS /RGB ID abcdef EI Q"),
            Ok(Ok(_))
        ));
        for content in [
            // A colour space lopdf does not size, and filtered data.
            "BI /W 1 /H 9 /BPC 8 /CS /Indexed ID x EI",
            "BI /W 9 /H 9 /BPC 8 /CS /RGB /F /AHx ID 00> EI",
            // No `ID` follows, or the `BI` is inside a name.
            "BT (x BI /W -1) Tj ET",
            "/NBI /W -1 /H 1 /BPC 8 /CS /RGB ID x EI",
            // Image-like text in a string, a comment or another image's data.
            "BT /F1 9 Tf ( BI /W -1 /H 1 /BPC 8 /CS /RGB ID x EI) Tj ET",
            "% BI /W -1 /H 1 /BPC 8 /CS /RGB ID x EI\nq Q",
            "BI /W 1 /H 1 /BPC 8 /CS /G /F /AHx ID 0 BI /W -1 /H 1 /BPC 8 /CS /G ID x > EI Q",
            // Data running past the stream's end: lopdf skips the image.
            "BI /W 4 /H 4 /BPC 8 /CS /RGB ID x EI ",
        ] {
            assert!(!refused(content), "{content}");
        }
        // Nested image-like text inside one string stays within the scan budget.
        let nested = format!("BT ({}{}) Tj ET", " BI /X (".repeat(80), ")".repeat(80));
        assert!(!refused(&nested));
        // Ordinary drawing with many numeric operands stays within it too.
        let path = format!("0 0 m\n{}S\n", "0 0 0 0 0 0 c\n".repeat(10_000));
        assert!(matches!(parse_content(path.as_bytes()), Ok(Ok(_))));
    }

    #[test]
    fn refuses_inline_images_whose_data_lopdf_cannot_size() {
        for content in [
            "BI /W -1 /H 1 /BPC 8 /CS /RGB ID x EI",
            "BI /Width 2147483647 /H 1 /BPC 8 /CS /RGB ID x EI",
            "BI /W 1 /H 1 /BPC 0 /IM true ID x EI",
            "BI /W 4294967296 /H 1 /BPC 8 /CS /G ID x EI",
            // Overflows u32 even when lopdf would not read the data.
            "BI /W 65536 /H 65536 /BPC 8 /CS /CMYK /F /DCT ID x EI",
            // Read past a reference, an escaped key, a comment and nesting.
            "BI /D 1 0 R /W -1 /H 1 /BPC 8 /CS /G ID x EI",
            "BI /#57 -1 /H 1 /BPC 8 /CS /RGB ID x EI",
            "BI /DP << /K [1 (a\\)b) <0F>] >> % note\n/W -1 /H 1 /BPC 8 /CS /G ID x EI",
            // Right after the previous image's `EI`.
            "BI /W 1 /H 1 /BPC 8 /CS /Gray ID xEIBI /W -1 /H 1 /BPC 8 /CS /G ID x EI",
        ] {
            assert!(refused(content), "{content}");
        }
    }
}
