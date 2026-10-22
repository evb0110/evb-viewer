use evb_pdf_image_combine::recompress_jpeg;
use jpeg_encoder::{ColorType, Encoder};
use zune_jpeg::{
    zune_core::{colorspace::ColorSpace, options::DecoderOptions},
    JpegDecoder,
};

fn jpeg(neutral: bool) -> Vec<u8> {
    let mut pixels = Vec::new();
    for y in 0..12u8 {
        for x in 0..16u8 {
            let value = 30 + x * 10;
            pixels.extend_from_slice(&[value, if neutral { value } else { 50 + y * 10 }, value]);
        }
    }
    let mut bytes = Vec::new();
    Encoder::new(&mut bytes, 95)
        .encode(&pixels, 16, 12, ColorType::Rgb)
        .unwrap();
    bytes
}

#[test]
fn recompresses_to_requested_dimensions_and_detects_neutral_rgb() {
    for neutral in [false, true] {
        let result = recompress_jpeg(&jpeg(neutral), 8, 6, 82, 192).unwrap();
        assert_eq!((result.width, result.height), (8, 6));
        assert_eq!(result.grayscale, neutral);
        let options = DecoderOptions::default().jpeg_set_out_colorspace(if neutral {
            ColorSpace::Luma
        } else {
            ColorSpace::RGB
        });
        let mut decoder =
            JpegDecoder::new_with_options(std::io::Cursor::new(&result.data), options);
        let decoded = decoder.decode().unwrap();
        let info = decoder.info().unwrap();
        assert_eq!((info.width, info.height), (8, 6));
        assert_eq!(info.components, if neutral { 1 } else { 3 });
        assert_eq!(decoded.len(), 8 * 6 * if neutral { 1 } else { 3 });
    }
}

#[test]
fn refuses_zero_dimensions_upscaling_and_an_exceeded_source_pixel_limit() {
    let source = jpeg(false);
    for (width, height) in [(0, 6), (8, 0), (17, 12), (16, 13)] {
        assert!(
            recompress_jpeg(&source, width, height, 82, 192).is_err(),
            "accepted {width}x{height}"
        );
    }
    assert!(recompress_jpeg(&source, 8, 6, 82, 191).is_err());
    let same_size = recompress_jpeg(&source, 16, 12, 82, 192).unwrap();
    assert_eq!((same_size.width, same_size.height), (16, 12));
}
