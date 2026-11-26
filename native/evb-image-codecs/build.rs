//! Links the prebuilt C decoders into wasm32 builds, where PDF image samples
//! must be the ones Poppler decodes: libjpeg-turbo for DCT
//! (`scripts/build-libjpeg-wasm32.sh`) and OpenJPEG for JPX
//! (`scripts/build-openjpeg-wasm32.sh`). Each archive links only while every
//! input its receipt names still has the hash it was built from.
use std::path::Path;

use sha2::{Digest, Sha256};

fn main() {
    for path in [
        "src/jpeg_wasm",
        "src/jpx_wasm",
        "../../scripts/build-libjpeg-wasm32.sh",
        "../../scripts/build-openjpeg-wasm32.sh",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }
    let crate_root = std::env::var("CARGO_MANIFEST_DIR").expect("Cargo sets it");
    let crate_root = Path::new(&crate_root);
    for (directory, library, script) in [
        ("src/jpeg_wasm", "evb_jpeg", "build-libjpeg-wasm32.sh"),
        ("src/jpx_wasm", "evb_jpx", "build-openjpeg-wasm32.sh"),
    ] {
        verify_receipt(crate_root, directory, script);
        println!(
            "cargo:rustc-link-search=native={}",
            crate_root.join(directory).display()
        );
        println!("cargo:rustc-link-lib=static={library}");
    }
}

fn verify_receipt(crate_root: &Path, directory: &str, script: &str) {
    let receipt = std::fs::read(crate_root.join(directory).join("SOURCE.json"))
        .unwrap_or_else(|_| panic!("{directory}/SOURCE.json is missing; run scripts/{script}"));
    let receipt: serde_json::Value = serde_json::from_slice(&receipt)
        .unwrap_or_else(|_| panic!("{directory}/SOURCE.json is not JSON"));
    for section in ["inputs", "archive"] {
        let files = receipt[section]
            .as_object()
            .unwrap_or_else(|| panic!("{directory}/SOURCE.json has no {section}"));
        for (file, expected) in files {
            let bytes = std::fs::read(crate_root.join(file))
                .unwrap_or_else(|error| panic!("cannot read {file}: {error}"));
            let actual: String = Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            assert!(
                expected.as_str() == Some(actual.as_str()),
                "{file} differs from its archive's receipt; run scripts/{script}"
            );
        }
    }
}
