//! Links the prebuilt libjpeg-turbo decoder into wasm32 builds, where PDF DCT
//! samples must be libjpeg's; `scripts/build-libjpeg-wasm32.sh` rebuilds it.
//! The archive links only while every input its receipt names still has the
//! hash it was built from.
use std::path::Path;

use sha2::{Digest, Sha256};

fn main() {
    println!("cargo:rerun-if-changed=src/jpeg_wasm");
    println!("cargo:rerun-if-changed=../../scripts/build-libjpeg-wasm32.sh");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }
    let crate_root = std::env::var("CARGO_MANIFEST_DIR").expect("Cargo sets it");
    let crate_root = Path::new(&crate_root);
    let receipt = std::fs::read(crate_root.join("src/jpeg_wasm/SOURCE.json"))
        .expect("src/jpeg_wasm/SOURCE.json is missing; run scripts/build-libjpeg-wasm32.sh");
    let receipt: serde_json::Value =
        serde_json::from_slice(&receipt).expect("src/jpeg_wasm/SOURCE.json is not JSON");
    for section in ["inputs", "archive"] {
        let files = receipt[section]
            .as_object()
            .unwrap_or_else(|| panic!("SOURCE.json has no {section}"));
        for (file, expected) in files {
            let bytes = std::fs::read(crate_root.join(file))
                .unwrap_or_else(|error| panic!("cannot read {file}: {error}"));
            let actual: String = Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            assert!(
                expected.as_str() == Some(actual.as_str()),
                "{file} differs from the libjpeg archive's receipt; run scripts/build-libjpeg-wasm32.sh"
            );
        }
    }
    println!(
        "cargo:rustc-link-search=native={}",
        crate_root.join("src/jpeg_wasm").display()
    );
    println!("cargo:rustc-link-lib=static=evb_jpeg");
}
