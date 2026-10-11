use super::*;

/// The bounded structural reader omits stream bytes from path-backed PDFs
/// above the eager-load ceiling. Annotation parsing still needs the small
/// appearance form and JPEG stream for managed placed images, so restore only
/// those reachable streams through qpdf before parsing the annotation graph.
pub(crate) fn materialize_managed_stamp_streams(
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
                if !is_managed_placed_image_stamp(dictionary) {
                    continue;
                }
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
