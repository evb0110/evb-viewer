use super::*;

/// The bounded structural reader omits stream bytes from path-backed PDFs
/// above the eager-load ceiling. Annotation parsing still needs the small
/// appearance form and JPEG stream for managed placed images, and a note's
/// normal appearance for its recovery snapshot, so restore only those
/// reachable streams through qpdf before parsing the annotation graph.
pub(crate) fn materialize_annotation_appearance_streams(
    incremental: &mut IncrementalDocument,
    input_path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let Some(qpdf_path) = qpdf_path else {
        return Ok(());
    };

    let stream_refs = {
        let document = AppendedRevision::new(incremental);
        let mut stream_refs = Vec::new();
        let mut seen_streams = HashSet::new();
        for page_id in document.page_ids().into_values() {
            for annotation in get_page_annots(&document, page_id)? {
                let Ok(annotation) = document.resolved(&annotation) else {
                    continue;
                };
                let Ok(dictionary) = annotation.as_dict() else {
                    continue;
                };
                if is_managed_placed_image_stamp(dictionary) {
                    if let Ok(graph) = stamp_image_graph(&document, dictionary) {
                        for (object_id, stream) in graph {
                            let is_image = stream
                                .dict
                                .get(b"Subtype")
                                .ok()
                                .and_then(|value| value.as_name().ok())
                                == Some(b"Image".as_slice());
                            if !seen_streams.insert(object_id) {
                                continue;
                            }
                            stream_refs.push((
                                object_id,
                                if is_image {
                                    MAX_PLACED_IMAGE_BYTES as usize
                                } else {
                                    MAX_STAMP_APPEARANCE_STREAM_BYTES
                                },
                            ));
                        }
                    }
                } else if is_text_annotation(&document, dictionary) {
                    for object_id in note_appearance_stream_refs(&document, dictionary) {
                        if seen_streams.insert(object_id) {
                            stream_refs.push((object_id, MAX_STAMP_APPEARANCE_STREAM_BYTES));
                        }
                    }
                }
            }
        }
        stream_refs
    };

    let mut remaining = MAX_PLACED_IMAGE_AGGREGATE_BYTES as usize;
    for (object_id, stream_limit) in stream_refs {
        if remaining == 0 {
            break;
        }
        let max_bytes = remaining.min(stream_limit);
        // Keep an unsupported or oversized image foreign without withholding
        // otherwise readable annotations from the same document.
        if incremental
            .materialize_base_stream(input_path, qpdf_path, object_id, max_bytes)
            .is_err()
        {
            continue;
        }
        let size = incremental
            .get_prev_documents()
            .get_object(object_id)?
            .as_stream()?
            .content
            .len();
        remaining = remaining.saturating_sub(size);
    }
    Ok(())
}

/// The normal appearance streams of a note, direct or one state level down.
/// A reference that is not a stream is left out: the materializer reads
/// streams only, and a non-stream would otherwise fail the whole parse.
fn note_appearance_stream_refs(
    document: &impl PdfObjectSource,
    dictionary: &Dictionary,
) -> Vec<ObjectId> {
    let Some(normal) = dictionary
        .get(b"AP")
        .ok()
        .and_then(|object| document.resolved(object).ok())
        .and_then(|object| object.as_dict().ok())
        .and_then(|appearance| appearance.get(b"N").ok())
    else {
        return Vec::new();
    };
    let references: Vec<ObjectId> = match normal {
        Object::Dictionary(states) => states
            .iter()
            .filter_map(|(_, state)| state.as_reference().ok())
            .collect(),
        reference => reference.as_reference().ok().into_iter().collect(),
    };
    references
        .into_iter()
        .filter(|object_id| matches!(document.object(*object_id), Ok(Object::Stream(_))))
        .collect()
}

fn is_text_annotation(document: &impl PdfObjectSource, dictionary: &Dictionary) -> bool {
    dictionary
        .get(b"Subtype")
        .ok()
        .and_then(|subtype| document.resolved(subtype).ok())
        .and_then(|subtype| subtype.as_name().ok())
        .is_some_and(|name| name.eq_ignore_ascii_case(b"Text"))
}
