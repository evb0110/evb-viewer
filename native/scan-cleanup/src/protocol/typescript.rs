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
        let declaration = omitted_fields_are_never_null(&T::decl(self.config));
        self.declarations
            .insert(T::ident(self.config), format!("{docs}export {declaration}"));
        T::visit_dependencies(self);
    }
}

/// serde omits every `Option` field declared `skip_serializing_if`, so such a
/// field is absent rather than null: `name?: T | null` becomes `name?: T`.
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
    };
    declarations.visit::<super::manifest_v3::ManifestV3>();
    declarations.visit::<crate::engine::page_workflow::PageResultMetadata>();
    declarations.visit::<crate::pipeline::CleanupMetadata>();
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
