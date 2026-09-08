use super::*;
use sha2::{Digest, Sha256};

// Keep these aligned with PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS. The PNG decoder
// has its own allocation ceiling; its caller-owned output is bounded as well.
const MAX_IMAGE_PIXELS: u64 = 80_000_000;
const MAX_IMAGE_EDGE: u32 = 32_768;
const MAX_DECODED_BYTES: usize = 80_000_000 * 4;

/// Admit the aggregate decoded size before any image is expanded. Many small
/// highly compressed PNGs must not bypass the mutation's memory ceiling.
pub(crate) fn placed_raster_decoded_bytes(bytes: &[u8], mime_type: &str) -> Result<u64> {
    if mime_type.eq_ignore_ascii_case("image/jpeg") {
        let info = parse_jpeg_info(bytes)?;
        validate_dimensions(u32::from(info.width), u32::from(info.height))?;
        return Ok(0);
    }
    let mut decoder = png::Decoder::new_with_limits(
        std::io::Cursor::new(bytes),
        png::Limits {
            bytes: MAX_PLACED_IMAGE_BYTES as usize,
        },
    );
    let header = decoder.read_header_info()?;
    validate_dimensions(header.width, header.height)?;
    Ok(u64::from(header.width) * u64::from(header.height) * 4)
}

fn validate_dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0
        || height == 0
        || width > MAX_IMAGE_EDGE
        || height > MAX_IMAGE_EDGE
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Placed image dimensions exceed the admission ceiling",
        ));
    }
    Ok(())
}

fn sample_stream(width: u32, height: u32, gray: bool, bytes: Vec<u8>) -> Result<Stream> {
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"XObject".to_vec()));
    dict.set("Subtype", Object::Name(b"Image".to_vec()));
    dict.set("Width", i64::from(width));
    dict.set("Height", i64::from(height));
    dict.set("BitsPerComponent", 8);
    dict.set(
        "ColorSpace",
        Object::Name(if gray {
            b"DeviceGray".to_vec()
        } else {
            b"DeviceRGB".to_vec()
        }),
    );
    let mut stream = Stream::new(dict, bytes);
    stream.compress()?;
    Ok(stream)
}

/// Return an Image XObject and optional alpha XObject. PNG alpha is a PDF soft
/// mask, never a white-background composite. JPEG keeps its original DCT bytes.
pub(crate) fn build_placed_raster_streams(
    bytes: Vec<u8>,
    image: &PlacedImage,
) -> Result<(Stream, Option<Stream>)> {
    if image.mime_type.eq_ignore_ascii_case("image/jpeg") {
        let info = parse_jpeg_info(&bytes)?;
        validate_dimensions(u32::from(info.width), u32::from(info.height))?;
        return Ok((build_jpeg_image_stream(bytes, &info), None));
    }
    if !image.mime_type.eq_ignore_ascii_case("image/png") {
        return Err(domain_error(
            NativeErrorCode::UnsupportedFilter,
            "Unsupported placed image format",
        ));
    }
    let mut decoder = png::Decoder::new_with_limits(
        std::io::Cursor::new(bytes),
        png::Limits {
            bytes: MAX_PLACED_IMAGE_BYTES as usize,
        },
    );
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let header = decoder.read_header_info()?;
    validate_dimensions(header.width, header.height)?;
    let mut reader = decoder.read_info()?;
    if reader.info().animation_control.is_some() {
        return Err(domain_error(
            NativeErrorCode::UnsupportedFilter,
            "Animated PNG placement is not supported",
        ));
    }
    let len = reader
        .output_buffer_size()
        .filter(|len| *len <= MAX_DECODED_BYTES)
        .ok_or_else(|| {
            domain_error(
                NativeErrorCode::TooLarge,
                "Placed image decoded bytes exceed the admission ceiling",
            )
        })?;
    let mut pixels = Vec::new();
    pixels.try_reserve_exact(len)?;
    pixels.resize(len, 0);
    let output = reader.next_frame(&mut pixels)?;
    reader.finish()?;
    pixels.truncate(output.buffer_size());
    let (channels, gray, alpha) = match output.color_type {
        png::ColorType::Grayscale => (1, true, false),
        png::ColorType::Rgb => (3, false, false),
        png::ColorType::GrayscaleAlpha => (2, true, true),
        png::ColorType::Rgba => (4, false, true),
        png::ColorType::Indexed => return Err("PNG palette was not expanded".into()),
    };
    let mask = if alpha {
        let mut opacity = Vec::new();
        opacity.try_reserve_exact(pixels.len() / channels)?;
        let mut color_offset = 0;
        for offset in (0..pixels.len()).step_by(channels) {
            opacity.push(pixels[offset + channels - 1]);
            for channel in 0..channels - 1 {
                pixels[color_offset] = pixels[offset + channel];
                color_offset += 1;
            }
        }
        pixels.truncate(color_offset);
        if opacity.iter().all(|value| *value == 255) {
            None
        } else {
            Some(sample_stream(output.width, output.height, true, opacity)?)
        }
    } else {
        None
    };
    let mut stream = sample_stream(output.width, output.height, gray, pixels)?;
    stream
        .dict
        .set("EVBImageSourceLength", i64::try_from(image.byte_length)?);
    stream.dict.set(
        "EVBImageSourceSHA256",
        Object::string_literal(image.sha256.to_ascii_lowercase()),
    );
    let fingerprint = raster_graph_hash(&stream, mask.as_ref())?;
    stream
        .dict
        .set("EVBImageGraphSHA256", Object::string_literal(fingerprint));
    Ok((stream, mask))
}

fn hash_sample_stream(hasher: &mut Sha256, stream: &Stream) -> Result<()> {
    if stream.dict.get(b"Subtype")?.as_name()? != b"Image"
        || stream.content.len() > MAX_DECODED_BYTES
    {
        return Err("Invalid placed raster image stream".into());
    }
    let width = u32::try_from(stream.dict.get(b"Width")?.as_i64()?)?;
    let height = u32::try_from(stream.dict.get(b"Height")?.as_i64()?)?;
    validate_dimensions(width, height)?;
    if stream.dict.get(b"BitsPerComponent")?.as_i64()? != 8 {
        return Err("Unsupported placed raster sample depth".into());
    }
    let color = stream.dict.get(b"ColorSpace")?.as_name()?;
    if !matches!(color, b"DeviceRGB" | b"DeviceGray") {
        return Err("Unsupported placed raster color space".into());
    }
    // These keys alter interpretation without changing compressed sample bytes.
    if [b"Decode".as_slice(), b"DecodeParms", b"Mask", b"ImageMask"]
        .iter()
        .any(|key| stream.dict.has(key))
    {
        return Err("Unsupported placed raster sample interpretation".into());
    }
    let filter = if stream.dict.has(b"Filter") {
        stream.dict.get(b"Filter")?.as_name()?
    } else {
        b""
    };
    if !matches!(filter, b"" | b"FlateDecode") {
        return Err("Unsupported placed raster compression".into());
    }
    hasher.update(width.to_be_bytes());
    hasher.update(height.to_be_bytes());
    hasher.update([color.len() as u8]);
    hasher.update(color);
    hasher.update([filter.len() as u8]);
    hasher.update(filter);
    hasher.update((stream.content.len() as u64).to_be_bytes());
    hasher.update(&stream.content);
    Ok(())
}

fn raster_graph_hash(stream: &Stream, mask: Option<&Stream>) -> Result<String> {
    let mut hasher = Sha256::new();
    hash_sample_stream(&mut hasher, stream)?;
    hasher.update([u8::from(mask.is_some())]);
    if let Some(mask) = mask {
        if mask.dict.has(b"SMask")
            || mask.dict.get(b"ColorSpace")?.as_name()? != b"DeviceGray"
            || mask.dict.get(b"Width")? != stream.dict.get(b"Width")?
            || mask.dict.get(b"Height")? != stream.dict.get(b"Height")?
        {
            return Err("Invalid placed image soft mask".into());
        }
        hash_sample_stream(&mut hasher, mask)?;
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Encoded source identity survives PNG sample decoding. Bind that identity to
/// the actual color/alpha graph so a changed soft mask cannot pass recovery.
pub(crate) fn placed_raster_source_identity(
    document: &impl PdfObjectSource,
    stream: &Stream,
) -> Result<(u64, String)> {
    let is_jpeg = stream
        .dict
        .get(b"Filter")
        .ok()
        .is_some_and(|value| match value {
            Object::Name(name) => name == b"DCTDecode",
            Object::Array(names) => {
                names.len() == 1 && names[0].as_name().ok() == Some(b"DCTDecode".as_slice())
            }
            _ => false,
        });
    if is_jpeg {
        if [b"SMask".as_slice(), b"Mask", b"Decode", b"DecodeParms"]
            .iter()
            .any(|key| stream.dict.has(key))
        {
            return Err("Unsupported JPEG sample interpretation".into());
        }
        let info = parse_jpeg_info(&stream.content)?;
        validate_dimensions(u32::from(info.width), u32::from(info.height))?;
        if stream.dict.get(b"Subtype")?.as_name()? != b"Image"
            || stream.dict.get(b"Width")?.as_i64()? != i64::from(info.width)
            || stream.dict.get(b"Height")?.as_i64()? != i64::from(info.height)
            || stream.dict.get(b"BitsPerComponent")?.as_i64()? != 8
            || stream.dict.get(b"ColorSpace")?.as_name()?
                != if info.components == 1 {
                    b"DeviceGray".as_slice()
                } else {
                    b"DeviceRGB".as_slice()
                }
        {
            return Err("JPEG image dictionary does not match its encoded samples".into());
        }
        if stream.content.len() as u64 > MAX_PLACED_IMAGE_BYTES {
            return Err("Placed JPEG exceeds the admission ceiling".into());
        }
        return Ok((stream.content.len() as u64, sha256_hex(&stream.content)));
    }
    if !stream.dict.has(b"EVBImageSourceLength") {
        return Err("Stamp image is not JPEG-encoded or an EVB raster".into());
    }
    let byte_length = u64::try_from(stream.dict.get(b"EVBImageSourceLength")?.as_i64()?)?;
    let source_hash = std::str::from_utf8(stream.dict.get(b"EVBImageSourceSHA256")?.as_str()?)?;
    if byte_length == 0
        || byte_length > MAX_PLACED_IMAGE_BYTES
        || source_hash.len() != 64
        || !source_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Invalid placed image source identity".into());
    }
    let mask = if stream.dict.has(b"SMask") {
        Some(
            document
                .object(stream.dict.get(b"SMask")?.as_reference()?)?
                .as_stream()?,
        )
    } else {
        None
    };
    let graph_hash = std::str::from_utf8(stream.dict.get(b"EVBImageGraphSHA256")?.as_str()?)?;
    if raster_graph_hash(stream, mask)? != graph_hash {
        return Err("Placed image color/alpha graph identity does not match".into());
    }
    Ok((byte_length, source_hash.to_ascii_lowercase()))
}
