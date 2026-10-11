use super::*;

/// The bounded structural reader omits stream bytes from path-backed PDFs
/// above the eager-load ceiling. Annotation parsing still needs the small
/// appearance form and JPEG stream for managed placed images, and each note
/// thread's recovery snapshot, so restore only those reachable streams through
/// qpdf before parsing the annotation graph.
pub(crate) fn materialize_annotation_appearance_streams(
    incremental: &mut IncrementalDocument,
    input_path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let Some(qpdf_path) = qpdf_path else {
        return Ok(());
    };

    let (stamp_refs, note_groups) = {
        let document = AppendedRevision::new(incremental);
        (
            managed_stamp_stream_refs(&document)?,
            note_appearance_groups(&document)?,
        )
    };

    let mut remaining = MAX_PLACED_IMAGE_AGGREGATE_BYTES as usize;
    for (object_id, stream_limit) in stamp_refs {
        if remaining == 0 {
            break;
        }
        // Keep an unsupported or oversized image foreign without withholding
        // otherwise readable annotations from the same document.
        if let Ok(size) = materialize_appearance_stream(
            incremental,
            input_path,
            qpdf_path,
            object_id,
            remaining.min(stream_limit),
        ) {
            remaining = remaining.saturating_sub(size);
        }
    }

    for group in note_groups {
        let mut appearance_remaining = MAX_STAMP_APPEARANCE_STREAM_BYTES;
        for object_id in group {
            let max_bytes = appearance_remaining.min(remaining);
            if max_bytes == 0 {
                break;
            }
            // An unreadable stream leaves its appearance foreign, so the
            // rest of that appearance is not worth another qpdf process.
            let Ok(size) = materialize_appearance_stream(
                incremental,
                input_path,
                qpdf_path,
                object_id,
                max_bytes,
            ) else {
                break;
            };
            appearance_remaining = appearance_remaining.saturating_sub(size);
            remaining = remaining.saturating_sub(size);
        }
    }
    Ok(())
}

fn materialize_appearance_stream(
    incremental: &mut IncrementalDocument,
    input_path: &Path,
    qpdf_path: &Path,
    object_id: ObjectId,
    max_bytes: usize,
) -> Result<usize> {
    incremental.materialize_base_stream(input_path, qpdf_path, object_id, max_bytes)?;
    Ok(incremental
        .get_prev_documents()
        .get_object(object_id)?
        .as_stream()?
        .content
        .len())
}

fn managed_stamp_stream_refs(document: &impl PdfObjectSource) -> Result<Vec<(ObjectId, usize)>> {
    let mut stream_refs = Vec::new();
    let mut seen_streams = HashSet::new();
    for page_id in document.page_ids().into_values() {
        for annotation in get_page_annots(document, page_id)? {
            let Ok(annotation) = document.resolved(&annotation) else {
                continue;
            };
            let Ok(dictionary) = annotation.as_dict() else {
                continue;
            };
            if !is_managed_placed_image_stamp(dictionary) {
                continue;
            }
            if let Ok(graph) = stamp_image_graph(document, dictionary) {
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
    Ok(stream_refs)
}

/// One group per note-thread appearance: the note's, its popup's and each
/// reply's normal appearance, following the same `/IRT` and `/Popup` links
/// that parsing and note recovery follow. A group lists the unread streams
/// its appearance draws on. A stream shared by two appearances is read once,
/// in the first group.
fn note_appearance_groups(document: &impl PdfObjectSource) -> Result<Vec<Vec<ObjectId>>> {
    let mut page_annotations = Vec::new();
    for page_id in document.page_ids().into_values() {
        for annotation in get_page_annots(document, page_id)? {
            if let Ok(object_id) = annotation.as_reference() {
                page_annotations.push(object_id);
            }
        }
    }

    let mut replies: HashMap<ObjectId, Vec<ObjectId>> = HashMap::new();
    for object_id in &page_annotations {
        if let Some(parent) = document
            .dictionary(*object_id)
            .ok()
            .and_then(|dict| annotation_related_ref(dict, b"IRT"))
        {
            replies.entry(parent).or_default().push(*object_id);
        }
    }

    let mut claimed_streams = HashSet::new();
    let mut groups = Vec::new();
    for note_id in &page_annotations {
        let Ok(note) = document.dictionary(*note_id) else {
            continue;
        };
        // Parsing lists a reply under its parent, never as a note of its own.
        if !is_text_annotation(document, note) || note.get(b"IRT").is_ok() {
            continue;
        }
        let mut thread = vec![*note_id];
        let mut thread_seen = HashSet::new();
        while let Some(member_id) = thread.pop() {
            if !thread_seen.insert(member_id) || thread_seen.len() > MAX_RECOVERY_OBJECTS {
                continue;
            }
            let Ok(member) = document.dictionary(member_id) else {
                continue;
            };
            for appearance_id in note_appearance_stream_refs(document, member) {
                let group =
                    unread_appearance_streams(document, appearance_id, &mut claimed_streams);
                if !group.is_empty() {
                    groups.push(group);
                }
            }
            if let Some(popup) = annotation_related_ref(member, b"Popup") {
                thread.push(popup);
            }
            thread.extend(replies.get(&member_id).into_iter().flatten().copied());
        }
    }
    Ok(groups)
}

/// The unread streams an appearance reaches through its dictionaries, which
/// includes resources: form XObjects, their images, and font file streams.
/// Recovery snapshots every object it reaches, so each of these must be read
/// for the note to stay editable. The page tree and a `/P` link are not
/// followed, which recovery would reject anyway.
fn unread_appearance_streams(
    document: &impl PdfObjectSource,
    root: ObjectId,
    claimed_streams: &mut HashSet<ObjectId>,
) -> Vec<ObjectId> {
    let mut streams = Vec::new();
    let mut visited = HashSet::new();
    let mut pending = vec![root];
    while let Some(object_id) = pending.pop() {
        if visited.len() >= MAX_RECOVERY_OBJECTS {
            break;
        }
        if !visited.insert(object_id) {
            continue;
        }
        let Ok(object) = document.object(object_id) else {
            continue;
        };
        let dict = match object {
            Object::Stream(stream) => {
                if claimed_streams.contains(&object_id) {
                    continue;
                }
                if is_unread_base_stream(document, stream) {
                    claimed_streams.insert(object_id);
                    streams.push(object_id);
                }
                &stream.dict
            }
            Object::Dictionary(dict) => dict,
            _ => continue,
        };
        if is_page_tree_dictionary(dict) {
            continue;
        }
        push_dictionary_targets(dict, &mut pending, 0);
    }
    streams
}

fn is_page_tree_dictionary(dict: &Dictionary) -> bool {
    matches!(
        dict.get(b"Type")
            .ok()
            .and_then(|value| value.as_name().ok()),
        Some(b"Page" | b"Pages" | b"Catalog")
    )
}

fn push_dictionary_targets(dict: &Dictionary, targets: &mut Vec<ObjectId>, depth: usize) {
    for (key, value) in dict.iter() {
        if key.as_slice() != b"P" {
            push_object_targets(value, targets, depth);
        }
    }
}

fn push_object_targets(object: &Object, targets: &mut Vec<ObjectId>, depth: usize) {
    if depth > 64 {
        return;
    }
    match object {
        Object::Reference(id) => targets.push(*id),
        Object::Array(values) => {
            for value in values {
                push_object_targets(value, targets, depth + 1);
            }
        }
        Object::Dictionary(dict) => push_dictionary_targets(dict, targets, depth + 1),
        _ => {}
    }
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
