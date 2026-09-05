mod page_sizes;

use evb_native_support::{
    bounded_io::{deserialize_bounded_vec, deserialize_json_file_bounded, read_file_bounded},
    NativeError, NativeErrorCode,
};
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
use lopdf::dictionary;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use page_geometry::write_page_geometry_path;
use page_sizes::write_page_sizes_path;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BinaryHeap, HashMap, HashSet},
    error::Error,
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

mod annotation_identity;
mod annotation_index;
mod annotation_parse;
mod annotations;
mod catalog;
mod cli;
mod conformance;
mod decrypt;
mod dispatcher;
mod incremental;
mod incremental_document;
mod input;
mod load_policy;
mod markup;
mod markup_hints;
mod page_geometry;
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
mod page_tree_ops;
mod placed_images;
mod postconditions;
mod shape_index;
mod shapes;
mod split_pages;
mod text_layer;
mod types;

const MAX_SIDECAR_BYTES: usize = 256 * 1024 * 1024;
const MAX_COLLECTION_ITEMS: usize = 100_000;
const MAX_AGGREGATE_TEXT_BYTES: usize = 64 * 1024 * 1024;
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
const PAGE_OP_WASM_MUTATION_HEADER_BYTES: usize = 12;
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
const PAGE_OP_WASM_MAX_INPUT_BYTES: usize = 512 * 1024 * 1024;
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
const PAGE_OP_WASM_MAX_OUTPUT_BYTES: usize = 512 * 1024 * 1024;

fn read_json_sidecar<T: DeserializeOwned>(path: &std::path::Path, label: &str) -> Result<T> {
    deserialize_json_file_bounded(path, MAX_SIDECAR_BYTES, label).map_err(|error| {
        if error.code == NativeErrorCode::Io {
            domain_error(NativeErrorCode::InvalidRequest, error.message)
        } else {
            Box::new(error)
        }
    })
}

pub(crate) use annotation_identity::*;
pub(crate) use annotation_index::*;
pub(crate) use annotation_parse::*;
pub(crate) use annotations::*;
pub(crate) use catalog::*;
pub(crate) use cli::*;
pub(crate) use conformance::*;
pub(crate) use decrypt::*;
pub(crate) use dispatcher::*;
pub(crate) use incremental::*;
pub(crate) use incremental_document::*;
pub(crate) use input::*;
pub(crate) use load_policy::*;
pub(crate) use markup::*;
pub(crate) use markup_hints::*;
pub(crate) use page_geometry::*;
#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
pub(crate) use page_tree_ops::*;
pub(crate) use placed_images::*;
pub(crate) use postconditions::*;
pub(crate) use shape_index::*;
pub(crate) use shapes::*;
pub(crate) use split_pages::*;
pub(crate) use text_layer::*;
pub(crate) use types::*;

pub use incremental::{fuzz_parse_incremental_xref_stream, fuzz_parse_incremental_xref_table};
pub use types::Result;

pub fn run_cli_entry(args: Vec<String>) -> Result<()> {
    run(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Object};
    use std::{
        fs::{read, remove_file, write},
        time::{SystemTime, UNIX_EPOCH},
    };

    include!("tests/support.rs");
    include!("tests/decryption.rs");
    include!("tests/crop.rs");
    include!("tests/notes.rs");
    include!("tests/identity_bindings.rs");
    include!("tests/placed_images.rs");
    include!("tests/markup_shapes.rs");
    include!("tests/catalog.rs");
    include!("tests/page_tree_ops.rs");
}

#[cfg(any(test, all(target_family = "wasm", target_os = "unknown")))]
mod wasm;

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
#[no_mangle]
unsafe extern "Rust" fn __getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> std::result::Result<(), getrandom::Error> {
    if dest.is_null() && len > 0 {
        return Err(getrandom::Error::new_custom(1));
    }

    std::slice::from_raw_parts_mut(dest, len).fill(0);
    Ok(())
}
