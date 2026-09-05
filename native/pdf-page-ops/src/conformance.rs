use super::*;
use evb_native_support::output::write_bytes_atomically;
use serde::Serialize;

const PDF_REFERENCE_LIMIT: usize = 128;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfConformanceFacts {
    is_signed: bool,
    is_encrypted: bool,
    is_tagged: bool,
    has_acro_form: bool,
    has_xfa: bool,
}

fn resolved_object<'a>(document: &'a Document, object: &'a Object) -> Result<&'a Object> {
    let mut current = object;
    for _ in 0..PDF_REFERENCE_LIMIT {
        let Ok(object_id) = current.as_reference() else {
            return Ok(current);
        };
        current = document
            .get_object(object_id)
            .map_err(|error| format!("Failed to resolve PDF object {object_id:?}: {error}"))?;
    }
    Err("PDF reference chain exceeded the conformance dereference limit".into())
}

fn dictionary_is_signature(document: &Document, dictionary: &Dictionary) -> bool {
    let is_signature_dictionary = |candidate: &Dictionary| {
        candidate
            .get(b"Type")
            .ok()
            .and_then(|value| value.as_name().ok())
            .is_some_and(|value| value == b"Sig")
            || (candidate.has(b"ByteRange") && candidate.has(b"Contents"))
    };
    is_signature_dictionary(dictionary)
        || dictionary
            .get(b"V")
            .ok()
            .and_then(|value| resolved_object(document, value).ok())
            .and_then(|value| value.as_dict().ok())
            .is_some_and(is_signature_dictionary)
}

fn optional_dictionary<'a>(
    document: &'a Document,
    value: Option<&'a Object>,
    field_name: &str,
) -> Result<Option<&'a Dictionary>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if matches!(value, Object::Null) {
        return Ok(None);
    }
    let object = resolved_object(document, value)?;
    if matches!(object, Object::Null) {
        return Ok(None);
    }
    object.as_dict().map(Some).map_err(|error| {
        format!("PDF conformance {field_name} is not a dictionary: {error}").into()
    })
}

pub(crate) fn pdf_conformance_facts(document: &Document) -> Result<PdfConformanceFacts> {
    let root = document
        .trailer
        .get(b"Root")
        .map_err(|error| format!("PDF trailer is missing /Root: {error}"))?;
    let catalog =
        optional_dictionary(document, Some(root), "catalog")?.ok_or("PDF catalog is missing")?;
    let acro_form = optional_dictionary(document, catalog.get(b"AcroForm").ok(), "AcroForm")?;
    let struct_tree_root = optional_dictionary(
        document,
        catalog.get(b"StructTreeRoot").ok(),
        "StructTreeRoot",
    )?;
    Ok(PdfConformanceFacts {
        is_signed: document.objects.values().any(|object| match object {
            Object::Dictionary(dictionary) => dictionary_is_signature(document, dictionary),
            Object::Stream(stream) => dictionary_is_signature(document, &stream.dict),
            _ => false,
        }),
        is_encrypted: document
            .trailer
            .get(b"Encrypt")
            .is_ok_and(|value| !matches!(value, Object::Null)),
        is_tagged: struct_tree_root.is_some(),
        has_acro_form: acro_form.is_some(),
        has_xfa: acro_form.is_some_and(|dictionary| dictionary.has(b"XFA")),
    })
}

pub(crate) fn write_pdf_conformance_path(
    input_path: &Path,
    output_path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let qpdf_path = qpdf_path.ok_or_else(|| {
        domain_error(
            NativeErrorCode::InvalidRequest,
            "PDF conformance requires the bundled qpdf structural reader",
        )
    })?;
    let incremental = load_qpdf_structural_incremental_pdf(input_path, qpdf_path)?;
    let document = incremental.get_prev_documents();
    let facts = pdf_conformance_facts(document)?;
    write_bytes_atomically(output_path, &serde_json::to_vec(&facts)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsigned_signature_field_is_not_a_signed_document() {
        let document = Document::with_version("1.7");
        let mut field = Dictionary::new();
        field.set("FT", Object::Name(b"Sig".to_vec()));

        assert!(!dictionary_is_signature(&document, &field));
    }

    #[test]
    fn populated_signature_field_is_a_signed_document() {
        let mut document = Document::with_version("1.7");
        let signature_id = document.add_object(dictionary! {
            "Type" => "Sig",
            "ByteRange" => vec![0.into(), 10.into(), 20.into(), 30.into()],
            "Contents" => Object::String(Vec::new(), StringFormat::Hexadecimal),
        });
        let mut field = Dictionary::new();
        field.set("FT", Object::Name(b"Sig".to_vec()));
        field.set("V", Object::Reference(signature_id));

        assert!(dictionary_is_signature(&document, &field));
    }
}
