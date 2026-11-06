//! The compact manifest page grammar shared by the desktop CLI and the
//! browser WASM request: one tab-separated line per page.

use crate::{
    FramePolicy, ImageCompression, ImageProcessing, ImageSpec, JpegSizeGuardrail, PageSpec,
    PdfBilevelDecode, PdfImagePlacement, PdfPageSize, Result,
};

/// Parses one compact manifest line, the page grammar desktop Scan Cleanup
/// writes, resolving each named plane through `resolve`. Desktop resolves a
/// file path; the browser resolves a request attachment.
pub fn parse_compact_manifest_line_with<S>(
    line: &str,
    line_number: usize,
    page_number: usize,
    resolve: &dyn Fn(&str, usize) -> Result<S>,
) -> Result<PageSpec<S>> {
    let parts = line.split('\t').collect::<Vec<_>>();
    let kind = parts
        .first()
        .copied()
        .ok_or_else(|| format!("Invalid compact manifest line {line_number}"))?;
    let page_size = PdfPageSize {
        width_points: parse_positive_f64(parts.get(1).copied(), "width points", line_number)?,
        height_points: parse_positive_f64(parts.get(2).copied(), "height points", line_number)?,
    };
    let image = |source, compression, processing, size_guardrail, placement| PageSpec::Image {
        page_size: Some(page_size),
        placement,
        rotation_degrees: 0,
        image: ImageSpec {
            source,
            compression,
            processing,
            size_guardrail,
        },
        frames: FramePolicy::ExactlyOne,
    };
    let source = |index: usize| resolve(parts[index], line_number);

    match kind {
        "image" | "image-bilevel" if parts.len() == 4 => Ok(image(
            source(3)?,
            ImageCompression::Auto,
            ImageProcessing::None,
            None,
            None,
        )),
        "image-bw" if parts.len() == 4 => Ok(image(
            source(3)?,
            ImageCompression::Auto,
            ImageProcessing::BlackAndWhite,
            None,
            None,
        )),
        "image" if parts.len() == 8 => Ok(image(
            source(3)?,
            ImageCompression::Auto,
            ImageProcessing::None,
            None,
            Some(parse_image_placement(&parts, 4, &page_size, line_number)?),
        )),
        "image-jpeg" if parts.len() == 5 || parts.len() == 9 => Ok(image(
            source(4)?,
            ImageCompression::JpegWithFlateFallback {
                quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
            },
            ImageProcessing::None,
            None,
            (parts.len() == 9)
                .then(|| parse_image_placement(&parts, 5, &page_size, line_number))
                .transpose()?,
        )),
        "photo-jpeg" if parts.len() == 6 || parts.len() == 7 => Ok(image(
            source(parts.len() - 1)?,
            ImageCompression::Jpeg {
                quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
            },
            ImageProcessing::DownscaleToPpi {
                ppi_cap: parse_u16_range(
                    parts.get(4).copied(),
                    "photo PPI cap",
                    line_number,
                    1,
                    1200,
                )?,
            },
            Some(JpegSizeGuardrail {
                page: page_number,
                log_json_progress: true,
            }),
            None,
        )),
        "layered" if parts.len() == 5 => Ok(PageSpec::Layered {
            page_size,
            background: image_spec(source(3)?, ImageCompression::Auto),
            foreground_mask: source(4)?,
            foreground_color: None,
        }),
        "layered-jpeg" if parts.len() == 6 => Ok(PageSpec::Layered {
            page_size,
            background: image_spec(
                source(4)?,
                ImageCompression::JpegWithFlateFallback {
                    quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
                },
            ),
            foreground_mask: source(5)?,
            foreground_color: None,
        }),
        "soft-layered-jpeg" if parts.len() == 6 => Ok(PageSpec::SoftLayered {
            page_size,
            background: image_spec(
                source(4)?,
                ImageCompression::JpegWithFlateFallback {
                    quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
                },
            ),
            foreground_alpha: source(5)?,
            foreground_color: None,
        }),
        "affine-masked-layered-jpeg" if parts.len() == 13 || parts.len() == 14 => {
            let parse_matrix = |index: usize| -> Result<f64> {
                let value = parts[index].parse::<f64>()?;
                if !value.is_finite() {
                    return Err(format!(
                        "Invalid foreground matrix on compact manifest line {line_number}"
                    )
                    .into());
                }
                Ok(value)
            };
            Ok(PageSpec::AffineMaskedLayered {
                page_size,
                background: image_spec(
                    source(4)?,
                    ImageCompression::JpegWithFlateFallback {
                        quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
                    },
                ),
                foreground: image_spec(source(5)?, ImageCompression::Auto),
                foreground_mask: source(6)?,
                foreground_mask_decode: match parts.get(13).copied().unwrap_or("default") {
                    "default" => PdfBilevelDecode::Default,
                    "inverted" => PdfBilevelDecode::Inverted,
                    _ => {
                        return Err(format!(
                            "Invalid source mask decode on compact manifest line {line_number}"
                        )
                        .into())
                    }
                },
                foreground_matrix: [
                    parse_matrix(7)?,
                    parse_matrix(8)?,
                    parse_matrix(9)?,
                    parse_matrix(10)?,
                    parse_matrix(11)?,
                    parse_matrix(12)?,
                ],
            })
        }
        "layered-color-jpeg" if parts.len() == 9 => Ok(PageSpec::Layered {
            page_size,
            background: image_spec(
                source(4)?,
                ImageCompression::JpegWithFlateFallback {
                    quality: parse_jpeg_quality(parts.get(3).copied(), line_number)?,
                },
            ),
            foreground_mask: source(5)?,
            foreground_color: Some([
                parse_u8_range(parts.get(6).copied(), "foreground red", line_number)?,
                parse_u8_range(parts.get(7).copied(), "foreground green", line_number)?,
                parse_u8_range(parts.get(8).copied(), "foreground blue", line_number)?,
            ]),
        }),
        "mask" if parts.len() == 4 => Ok(PageSpec::Mask {
            page_size,
            foreground_mask: source(3)?,
        }),
        "image"
        | "image-bilevel"
        | "image-bw"
        | "image-jpeg"
        | "photo-jpeg"
        | "layered"
        | "layered-jpeg"
        | "soft-layered-jpeg"
        | "affine-masked-layered-jpeg"
        | "layered-color-jpeg"
        | "mask" => {
            Err(format!("Invalid compact manifest field count on line {line_number}").into())
        }
        _ => {
            Err(format!("Invalid compact manifest page kind on line {line_number}: {kind}").into())
        }
    }
}

fn parse_image_placement(
    parts: &[&str],
    offset: usize,
    page_size: &PdfPageSize,
    line_number: usize,
) -> Result<PdfImagePlacement> {
    let placement = PdfImagePlacement {
        x_points: parse_non_negative_f64(parts.get(offset).copied(), "placement x", line_number)?,
        y_points: parse_non_negative_f64(
            parts.get(offset + 1).copied(),
            "placement y",
            line_number,
        )?,
        width_points: parse_positive_f64(
            parts.get(offset + 2).copied(),
            "placement width",
            line_number,
        )?,
        height_points: parse_positive_f64(
            parts.get(offset + 3).copied(),
            "placement height",
            line_number,
        )?,
    };
    if placement.x_points + placement.width_points > page_size.width_points + 0.0001
        || placement.y_points + placement.height_points > page_size.height_points + 0.0001
    {
        return Err(format!(
            "Image placement exceeds the page on compact manifest line {line_number}"
        )
        .into());
    }
    Ok(placement)
}

fn image_spec<S>(source: S, compression: ImageCompression) -> ImageSpec<S> {
    ImageSpec {
        source,
        compression,
        processing: ImageProcessing::None,
        size_guardrail: None,
    }
}

fn parse_positive_f64(value: Option<&str>, label: &str, line_number: usize) -> Result<f64> {
    let parsed = value
        .ok_or_else(|| format!("Missing {label} on compact manifest line {line_number}"))?
        .parse::<f64>()?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return Err(format!("Invalid {label} on compact manifest line {line_number}").into());
    }
    Ok(parsed)
}

fn parse_non_negative_f64(value: Option<&str>, label: &str, line_number: usize) -> Result<f64> {
    let parsed = value
        .ok_or_else(|| format!("Missing {label} on compact manifest line {line_number}"))?
        .parse::<f64>()?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(format!("Invalid {label} on compact manifest line {line_number}").into());
    }
    Ok(parsed)
}

fn parse_jpeg_quality(value: Option<&str>, line_number: usize) -> Result<u8> {
    let parsed = value
        .ok_or_else(|| format!("Missing JPEG quality on compact manifest line {line_number}"))?
        .parse::<u8>()?;
    if !(1..=100).contains(&parsed) {
        return Err(format!("Invalid JPEG quality on compact manifest line {line_number}").into());
    }
    Ok(parsed)
}

fn parse_u16_range(
    value: Option<&str>,
    label: &str,
    line_number: usize,
    min_value: u16,
    max_value: u16,
) -> Result<u16> {
    let parsed = value
        .ok_or_else(|| format!("Missing {label} on compact manifest line {line_number}"))?
        .parse::<u16>()?;
    if parsed < min_value || parsed > max_value {
        return Err(format!("Invalid {label} on compact manifest line {line_number}").into());
    }
    Ok(parsed)
}

fn parse_u8_range(value: Option<&str>, label: &str, line_number: usize) -> Result<u8> {
    value
        .ok_or_else(|| format!("Missing {label} on compact manifest line {line_number}"))?
        .parse::<u8>()
        .map_err(Into::into)
}
