//! Links the prebuilt libjpeg-turbo decoder into wasm32 builds, where PDF DCT
//! samples must be libjpeg's; `scripts/build-libjpeg-wasm32.sh` rebuilds it.
fn main() {
    println!("cargo:rerun-if-changed=src/jpeg_wasm/libevb_jpeg.a");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        let directory =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("Cargo sets it"))
                .join("src/jpeg_wasm");
        assert!(
            directory.join("libevb_jpeg.a").is_file(),
            "src/jpeg_wasm/libevb_jpeg.a is missing; run scripts/build-libjpeg-wasm32.sh"
        );
        println!("cargo:rustc-link-search=native={}", directory.display());
        println!("cargo:rustc-link-lib=static=evb_jpeg");
    }
}
