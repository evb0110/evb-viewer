use super::{write_atomic, MAX_COMPRESSED_BYTES};
use evb_native_support::bounded_io::read_file_bounded;
use scan_primitives::{BinaryImage, GrayImage};
use std::path::Path;

pub fn write_p4_atomic(path: &Path, image: &GrayImage) -> Result<(), String> {
    let bytes = evb_raster_io::encode_p4(image).map_err(|error| error.to_string())?;
    write_atomic(path, &bytes)
}

pub fn write_p4_bilevel_atomic(path: &Path, image: &BinaryImage) -> Result<(), String> {
    let bytes = evb_raster_io::encode_p4_bilevel(image).map_err(|error| error.to_string())?;
    write_atomic(path, &bytes)
}

pub fn read_p4(path: &Path, max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    decode_p4(
        &read_file_bounded(path, MAX_COMPRESSED_BYTES, "PBM input")
            .map_err(|error| error.to_string())?,
        max_pixels,
        max_dimension,
    )
}

pub fn decode_p4(bytes: &[u8], max_pixels: u64, max_dimension: u32) -> Result<GrayImage, String> {
    evb_raster_io::decode_p4(bytes, max_pixels, max_dimension).map_err(|error| error.to_string())
}
