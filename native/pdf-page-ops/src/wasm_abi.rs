//! EPPO binary frame definitions, shared by the Rust codec and generated TS.
//! The worker-message envelope is a separate contract.

pub(crate) const REQUEST_MAGIC: &[u8; 4] = b"EPPO";

// Derive offsets and frame sizes from field widths, then emit the same values
// for the handwritten TypeScript codec. No codec implementation is generated.
macro_rules! abi {
    (
        constants { $($constant:ident: $constant_type:ty = $value:expr;)* }
        operations { $($operation:ident = $code:expr => $ts_operation:literal;)* }
        layouts { $($layout:ident: $layout_type:ident { $($field:ident: $width:expr),+ $(,)? })* }
    ) => {
        $(pub(crate) const $constant: $constant_type = $value;)*
        $(pub(crate) const $operation: u32 = $code;)*
        $(
            pub(crate) struct $layout_type {
                $(pub(crate) $field: usize,)+
                pub(crate) bytes: usize,
            }
            pub(crate) const $layout: $layout_type = {
                let mut offset = 0;
                $(let $field = offset; offset += $width;)+
                $layout_type { $($field,)+ bytes: offset }
            };
        )*

        #[cfg(test)]
        fn generated() -> String {
            use std::fmt::Write;
            let mut output = String::from(
                "// Generated from the evb-pdf-page-ops Rust WASM ABI; do not edit.\n\
                 // Regenerate with `EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops generated_typescript`.\n\
                 // Layout fields are byte offsets; numeric fields are little-endian.\n\n",
            );
            writeln!(output, "export const REQUEST_MAGIC = '{}';", std::str::from_utf8(REQUEST_MAGIC).unwrap()).unwrap();
            $(writeln!(output, "export const {} = {};", stringify!($constant), $constant).unwrap();)*
            writeln!(output, "export const MAX_U32 = {};", u32::MAX).unwrap();
            output.push_str("\nexport const OPERATION_CODES = {\n");
            $(writeln!(output, "    {}: {},", $ts_operation, $operation).unwrap();)*
            output.push_str("} as const;\n");
            $(
                writeln!(output, "\nexport const {} = {{", stringify!($layout)).unwrap();
                $(writeln!(output, "    {}: {},", camel_case(stringify!($field)), $layout.$field).unwrap();)+
                writeln!(output, "    bytes: {},\n}} as const;", $layout.bytes).unwrap();
            )*
            output
        }
    };
}

abi! {
    constants {
        // Version 2 includes the trailing password length for decrypt.
        REQUEST_VERSION: u32 = 2;
        REQUEST_VERSION_DOCUMENT_LIST: u32 = 3;
        U32_BYTES: usize = std::mem::size_of::<u32>();
        F64_BYTES: usize = std::mem::size_of::<f64>();
        MAX_DOCUMENTS: usize = 500;
        RESPONSE_MUTATION: u32 = 1;
        RESPONSE_GEOMETRY: u32 = 2;
        RESPONSE_ANNOTATION_PARSE: u32 = 3;
        RESPONSE_NATIVE_MUTATIONS: u32 = 4;
        RESPONSE_JSON: u32 = 5;
        NATIVE_MUTATION_POSTCONDITIONS_VERIFIED: u32 = 1;
    }
    operations {
        OP_DELETE_PAGES = 1 => "deletePages";
        OP_EXTRACT_PAGES = 2 => "extractPages";
        OP_REORDER_PAGES = 3 => "reorderPages";
        OP_INSERT_PAGES = 4 => "insertPages";
        OP_ROTATE = 5 => "rotate";
        OP_CROP = 6 => "crop";
        OP_REMOVE_CROP = 7 => "removeCrop";
        OP_GET_PAGE_GEOMETRY = 8 => "getPageGeometry";
        OP_DECRYPT = 9 => "decrypt";
        OP_PARSE_ANNOTATIONS = 10 => "parseAnnotations";
        OP_SAVE_MUTATIONS = 11 => "saveMutations";
        OP_READ_CATALOG = 12 => "readCatalog";
        OP_CONFORMANCE = 13 => "conformance";
        OP_MERGE_PAGES = 14 => "mergePages";
        // Selected pages use the page list; insertion data is UTF-8
        // "<view mode> <orientation>".
        OP_PRINT_LAYOUT = 15 => "printLayout";
    }
    layouts {
        REQUEST_HEADER: RequestHeader {
            magic: REQUEST_MAGIC.len(), version: U32_BYTES, operation: U32_BYTES,
            page_count: U32_BYTES, page_number: U32_BYTES, after_page: U32_BYTES,
            angle: U32_BYTES, top: F64_BYTES, bottom: F64_BYTES,
            left: F64_BYTES, right: F64_BYTES, data_length: U32_BYTES,
            insertion_data_length: U32_BYTES, password_length: U32_BYTES,
        }
        DOCUMENT_LIST_HEADER: DocumentListHeader {
            magic: REQUEST_MAGIC.len(), version: U32_BYTES,
            operation: U32_BYTES, document_count: U32_BYTES,
        }
        MUTATION_HEADER: MutationHeader {
            kind: U32_BYTES, page_count: U32_BYTES, data_length: U32_BYTES,
        }
        BOX_LAYOUT: BoxLayout {
            x: F64_BYTES, y: F64_BYTES, width: F64_BYTES, height: F64_BYTES,
        }
        GEOMETRY_HEADER: GeometryHeader {
            kind: U32_BYTES, rotation: U32_BYTES, media_box: BOX_LAYOUT.bytes,
            has_crop_box: U32_BYTES, crop_box: BOX_LAYOUT.bytes,
        }
        BYTES_HEADER: BytesHeader {
            kind: U32_BYTES, data_length: U32_BYTES,
        }
        NATIVE_MUTATION_HEADER: NativeMutationHeader {
            kind: U32_BYTES, page_count: U32_BYTES, data_length: U32_BYTES,
            identity_bindings_length: U32_BYTES, postconditions_verified: U32_BYTES,
        }
    }
}

#[cfg(test)]
fn camel_case(name: &str) -> String {
    let mut upper = false;
    name.chars()
        .filter_map(|character| {
            if character == '_' {
                upper = true;
                None
            } else if upper {
                upper = false;
                Some(character.to_ascii_uppercase())
            } else {
                Some(character)
            }
        })
        .collect()
}

#[test]
fn generated_typescript_is_current() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/browserPageOpsWasm.generated.ts");
    let current = generated();
    if std::env::var_os("EVB_UPDATE_GENERATED").is_some() {
        std::fs::write(&path, current).unwrap();
        return;
    }
    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        checked_in == current,
        "{} is stale; regenerate it with EVB_UPDATE_GENERATED=1 cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops generated_typescript",
        path.display()
    );
}
