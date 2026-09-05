use super::*;
use sha2::{Digest, Sha256};

/// Read the document's durable annotation name, treating an empty or
/// whitespace-only PDF string as absent while preserving every character of
/// a nonblank name.
pub(crate) fn read_annotation_name(dict: &Dictionary) -> Option<String> {
    dict.get(b"NM")
        .ok()
        .and_then(pdf_string_to_text)
        .and_then(|name| (!name.trim().is_empty()).then_some(name))
}

/// Match a current identity against a name written by an older EVB writer.
/// New writes use the supplied identity verbatim, but existing prefixed names
/// remain valid lookup keys after the prefix removal.
pub(crate) fn annotation_names_match(
    actual: &str,
    requested: &str,
    legacy_prefixes: &[&str],
) -> bool {
    actual == requested
        || legacy_prefixes.iter().any(|prefix| {
            actual.strip_prefix(prefix) == Some(requested)
                || requested.strip_prefix(prefix) == Some(actual)
        })
}

pub(crate) fn text_note_names_match(actual: &str, requested: &str) -> bool {
    annotation_names_match(actual, requested, &["evb-note:"]) || {
        let requested_key = requested.strip_prefix("evb-note:").unwrap_or(requested);
        actual
            .strip_prefix("evb-note:")
            .is_some_and(|legacy| legacy.starts_with(&format!("{requested_key}:created:")))
    }
}

pub(crate) fn text_note_delete_name_matches(
    actual: &str,
    requested: &str,
    created_at: Option<u64>,
) -> bool {
    if annotation_names_match(actual, requested, &["evb-note:"]) {
        return true;
    }
    let requested_key = requested.strip_prefix("evb-note:").unwrap_or(requested);
    let Some(legacy) = actual.strip_prefix("evb-note:") else {
        return false;
    };
    match created_at.filter(|value| *value > 0) {
        Some(created_at) => legacy == format!("{requested_key}:created:{created_at}"),
        None => legacy.starts_with(&format!("{requested_key}:created:")),
    }
}

/// Append a newly created annotation's durable identity when either of its
/// identity candidates is present. The primary candidate always wins after
/// trimming, unless it is blank, in which case the fallback is considered.
pub(crate) fn append_annotation_identity_binding(
    identity_bindings: &mut Option<&mut Vec<AnnotationIdentityBinding>>,
    primary_identity: Option<&str>,
    fallback_identity: Option<&str>,
    object_id: ObjectId,
) {
    let annotation_id = primary_identity
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            fallback_identity
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });
    if let (Some(annotation_id), Some(bindings)) = (annotation_id, identity_bindings) {
        bindings.push(AnnotationIdentityBinding {
            annotation_id: annotation_id.to_string(),
            pdf_ref: format!("{} {} R", object_id.0, object_id.1),
        });
    }
}

/// Store an annotation identity in the PDF's `/NM` string.
pub(crate) fn write_annotation_name(dict: &mut Dictionary, id: &str) {
    dict.set(
        "NM",
        Object::String(encode_pdf_text_string(id), StringFormat::Hexadecimal),
    );
}

/// Reuse a unique `/NM` value or mint a deterministic UUID-shaped identity.
///
/// The wasm build deliberately uses a zero-filling getrandom backend, so a
/// random UUID would repeat there. Hashing the page/object/subtype gives each
/// annotation a stable identity without adding a randomness dependency or
/// making the result depend on a parse request's timestamp. A collision suffix
/// handles duplicate `/NM` values and the otherwise possible direct-dictionary
/// object `0R0`.
pub(crate) fn resolve_or_mint_name(
    dict: &Dictionary,
    existing_names: &HashSet<String>,
    page_index: u64,
    object_id: ObjectId,
    subtype: &str,
) -> String {
    if let Some(name) = read_annotation_name(dict) {
        if !existing_names.contains(&name) {
            return name;
        }
    }

    let seed = format!("{page_index}:{}:{}:{subtype}", object_id.0, object_id.1);
    for collision in 0_u64.. {
        let candidate = mint_uuid(&seed, collision);
        if !existing_names.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("annotation identity collision counter exhausted")
}

fn mint_uuid(seed: &str, collision: u64) -> String {
    let digest = Sha256::digest(format!("{seed}:{collision}").as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // UUID version 4 and RFC 4122 variant bits make the wire value familiar
    // to consumers while keeping the bytes deterministic.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_nonblank_names_and_rejects_blank_names() {
        let mut dict = Dictionary::new();
        dict.set("NM", Object::string_literal("  name  "));
        assert_eq!(read_annotation_name(&dict).as_deref(), Some("  name  "));

        dict.set("NM", Object::string_literal(" \t\n "));
        assert_eq!(read_annotation_name(&dict), None);

        write_annotation_name(&mut dict, "new-name");
        assert_eq!(read_annotation_name(&dict).as_deref(), Some("new-name"));
    }

    #[test]
    fn mints_a_deterministic_uuid_for_missing_and_duplicate_names() {
        let dict = Dictionary::new();
        let empty = HashSet::new();
        let first = resolve_or_mint_name(&dict, &empty, 2, (17, 0), "FreeText");
        assert_eq!(first.len(), 36);
        assert_eq!(first.as_bytes()[14], b'4');
        assert!(matches!(first.as_bytes()[19], b'8'..=b'b'));

        let again = resolve_or_mint_name(&dict, &empty, 2, (17, 0), "FreeText");
        assert_eq!(first, again);

        let used = HashSet::from([first.clone()]);
        let second = resolve_or_mint_name(&dict, &used, 2, (17, 0), "FreeText");
        assert_ne!(first, second);
    }

    #[test]
    fn keeps_the_first_occurrence_of_a_document_name() {
        let mut dict = Dictionary::new();
        dict.set("NM", Object::string_literal("foreign-name"));
        let empty = HashSet::new();
        assert_eq!(
            resolve_or_mint_name(&dict, &empty, 0, (4, 0), "Link"),
            "foreign-name"
        );
        let used = HashSet::from(["foreign-name".to_string()]);
        assert_ne!(
            resolve_or_mint_name(&dict, &used, 0, (5, 0), "Link"),
            "foreign-name"
        );
    }
}
