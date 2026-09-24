fn main() {
    evb_native_support::run_native_cli(
        "evb-pdf-page-ops",
        env!("CARGO_PKG_VERSION"),
        option_env!("EVB_NATIVE_BUILD_ID"),
        std::env::args().skip(1),
        evb_pdf_page_ops::run_cli_entry,
    );
}
