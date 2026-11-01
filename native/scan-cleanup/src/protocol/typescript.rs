//! The TypeScript declarations of every JSON shape evb-scan-cleanup reads or
//! writes, generated from the Rust types. `cargo test` fails when the checked-in
//! file is stale; `EVB_UPDATE_GENERATED=1 cargo test -p evb-scan-cleanup
//! generated_typescript` rewrites it.
use std::any::TypeId;
use std::collections::BTreeMap;
use std::path::Path;
use ts_rs::{Config, TypeVisitor, TS};

struct Declarations<'a> {
    config: &'a Config,
    seen: Vec<TypeId>,
    declarations: BTreeMap<String, String>,
    preserve_optional_null: bool,
}

impl TypeVisitor for Declarations<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_none() || self.seen.contains(&TypeId::of::<T>()) {
            return;
        }
        self.seen.push(TypeId::of::<T>());
        let docs = T::docs()
            .map(|docs| format!("{docs}\n"))
            .unwrap_or_default();
        let declaration = T::decl(self.config);
        let declaration = if self.preserve_optional_null {
            declaration
        } else {
            omitted_fields_are_never_null(&declaration)
        };
        self.declarations
            .insert(T::ident(self.config), format!("{docs}export {declaration}"));
        T::visit_dependencies(self);
    }
}

/// serde skips `None` outputs; input fields keep nullable omission from ts-rs.
fn omitted_fields_are_never_null(declaration: &str) -> String {
    let bytes = declaration.as_bytes();
    let mut output = String::with_capacity(declaration.len());
    let mut index = 0;
    while let Some(offset) = declaration[index..].find("?: ") {
        let type_start = index + offset + 3;
        output.push_str(&declaration[index..type_start]);
        let mut depth = 0usize;
        let mut end = type_start;
        while end < bytes.len() {
            match bytes[end] {
                b'{' | b'[' | b'(' | b'<' => depth += 1,
                b'}' | b']' | b')' | b'>' if depth == 0 => break,
                b'}' | b']' | b')' | b'>' => depth -= 1,
                b',' if depth == 0 => break,
                _ => {}
            }
            end += 1;
        }
        let field_type = &declaration[type_start..end];
        output.push_str(field_type.strip_suffix(" | null").unwrap_or(field_type));
        index = end;
    }
    output.push_str(&declaration[index..]);
    output
}

fn generated() -> String {
    // Every integer crosses the boundary as a JSON number.
    let config = Config::new().with_large_int("number");
    let mut declarations = Declarations {
        config: &config,
        seen: Vec::new(),
        declarations: BTreeMap::new(),
        preserve_optional_null: false,
    };
    declarations.preserve_optional_null = true;
    declarations.visit::<super::manifest_v3::ManifestV3>();
    // The browser engine's requests reuse the manifest's page shapes.
    declarations.visit::<crate::wasm::WasmRenderPageRequestV2>();
    declarations.visit::<crate::wasm::WasmAnalyzePageRequestV2>();
    declarations.visit::<crate::wasm::WasmReconcileDocumentRequestV2>();
    declarations.visit::<crate::wasm::WasmFinishPageAnalysisRequestV2>();
    declarations.visit::<crate::wasm::WasmSamplePageInkRequestV2>();
    declarations.visit::<crate::wasm::WasmDeriveInkContextsRequestV2>();
    declarations.preserve_optional_null = false;
    declarations.visit::<crate::wasm::WasmAnalyzePageDetailsV2>();
    declarations.visit::<crate::wasm::WasmReconcileDocumentResultV2>();
    declarations.visit::<crate::wasm::WasmSamplePageInkResultV2>();
    declarations.visit::<crate::wasm::WasmDeriveInkContextsResultV2>();
    declarations.visit::<crate::engine::page_workflow::PageResultMetadata>();
    declarations.visit::<crate::engine::render::CleanupMetadata>();
    declarations.visit::<super::progress::ProgressEnvelope>();
    declarations.visit::<super::result::ResultEnvelope>();
    let mut output = String::from(
        "// Generated from the evb-scan-cleanup Rust types; do not edit.\n\
         // Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup generated_typescript`.\n",
    );
    for declaration in declarations.declarations.values() {
        output.push('\n');
        output.push_str(declaration);
        output.push('\n');
    }
    output
}

#[test]
fn generated_typescript_is_current() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/scan-cleanup/nativeWire.generated.ts");
    let current = generated();
    if std::env::var_os("EVB_UPDATE_GENERATED").is_some() {
        std::fs::write(&path, current).unwrap();
        return;
    }
    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        checked_in == current,
        "{} is stale; regenerate it with EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup generated_typescript",
        path.display()
    );
}
