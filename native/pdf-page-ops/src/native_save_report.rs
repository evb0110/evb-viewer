//! Bounded identity, affected-page and confirmed deletion effects after saves.
use super::*;
const MAX_ANNOTATION_IDENTITY_BINDINGS: usize = 4_096;
const MAX_ANNOTATION_IDENTITY_REPORT_BYTES: usize = 256 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationDeleteEffects {
    affected_page_indices: Vec<u32>,
    deleted_reply_refs: Vec<String>,
}

pub(crate) fn annotation_delete_effects(
    base: &IncrementalDocument,
) -> Result<Option<AnnotationDeleteEffects>> {
    let Some(located) = base.located_pages.as_ref() else {
        return Ok(None);
    };
    let source = AppendedRevision::new(base);
    let mut remaining = HashSet::new();
    for page in located.ids.values() {
        remaining.extend(
            get_page_annots(&source, *page)?
                .iter()
                .filter_map(|object| object.as_reference().ok()),
        );
    }
    let mut replies = AnnotationListing::new_for_pages(base.get_prev_documents(), Some(located))
        .replies
        .into_values()
        .flatten()
        .filter(|id| !remaining.contains(id))
        .collect::<Vec<_>>();
    replies.sort_unstable();
    replies.dedup();
    // Oversized read-back scopes retain the existing whole-parse fallback.
    if located.ids.len() > MAX_ANNOTATION_IDENTITY_BINDINGS
        || replies.len() > MAX_ANNOTATION_IDENTITY_BINDINGS
    {
        return Ok(None);
    }
    Ok(Some(AnnotationDeleteEffects {
        affected_page_indices: located.ids.keys().copied().collect(),
        deleted_reply_refs: replies
            .into_iter()
            .map(|id| format!("{} {} R", id.0, id.1))
            .collect(),
    }))
}

pub(crate) fn serialize_native_save_report(
    bindings: &[AnnotationIdentityBinding],
    effects: Option<&AnnotationDeleteEffects>,
) -> Result<Vec<u8>> {
    let Some(effects) = effects else {
        return serialize_annotation_identity_bindings_report(bindings);
    };
    validate_annotation_identity_bindings(bindings)?;
    let bytes = serde_json::to_vec(
        &serde_json::json!({"identityBindings":bindings,"annotationDeleteEffects":effects}),
    )?;
    if bytes.len() > MAX_ANNOTATION_IDENTITY_REPORT_BYTES {
        return serialize_annotation_identity_bindings_report(bindings);
    }
    Ok(bytes)
}

#[cfg(test)]
pub(crate) fn write_annotation_identity_bindings_report(
    path: &Path,
    bindings: &[AnnotationIdentityBinding],
) -> Result<()> {
    let bytes = serialize_annotation_identity_bindings_report(bindings)?;
    fs::write(path, bytes)?;
    Ok(())
}

pub(crate) fn serialize_annotation_identity_bindings_report(
    bindings: &[AnnotationIdentityBinding],
) -> Result<Vec<u8>> {
    validate_annotation_identity_bindings(bindings)?;
    let bytes = serde_json::to_vec(bindings)?;
    if bytes.len() > MAX_ANNOTATION_IDENTITY_REPORT_BYTES {
        return Err("Native annotation identity binding report is too large".into());
    }
    Ok(bytes)
}

pub(crate) fn validate_annotation_identity_bindings(
    bindings: &[AnnotationIdentityBinding],
) -> Result<()> {
    if bindings.len() > MAX_ANNOTATION_IDENTITY_BINDINGS {
        return Err("Native annotation identity binding report exceeds its item limit".into());
    }
    let mut annotation_ids = HashSet::new();
    let mut pdf_refs = HashSet::new();
    for binding in bindings {
        if binding.annotation_id.trim().is_empty()
            || binding.annotation_id.len() > 2_048
            || !annotation_ids.insert(binding.annotation_id.as_str())
            || !pdf_refs.insert(binding.pdf_ref.as_str())
        {
            return Err(
                "Native annotation identity binding report contains a duplicate or invalid binding"
                    .into(),
            );
        }
        let mut ref_parts = binding.pdf_ref.split(' ');
        let object_number = ref_parts.next().and_then(|value| value.parse::<u64>().ok());
        let generation_number = ref_parts.next().and_then(|value| value.parse::<u64>().ok());
        if object_number.is_none()
            || object_number == Some(0)
            || generation_number.is_none()
            || ref_parts.next() != Some("R")
            || ref_parts.next().is_some()
        {
            return Err(
                "Native annotation identity binding report contains an invalid PDF reference"
                    .into(),
            );
        }
    }
    Ok(())
}
