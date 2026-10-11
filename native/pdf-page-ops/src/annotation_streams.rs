use super::*;
use base64::Engine;
use serde_json::Value;

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

    let streams: Vec<(usize, ObjectId, usize)> = note_groups
        .iter()
        .enumerate()
        .flat_map(|(group, streams)| {
            streams
                .iter()
                .map(move |(object_id, declared)| (group, *object_id, *declared))
        })
        .collect();
    // Each appearance keeps its own budget and stops at its first stream that
    // cannot be read, so the rest of it stays foreign.
    let mut appearances = vec![(MAX_STAMP_APPEARANCE_STREAM_BYTES, false); note_groups.len()];
    let mut start = 0;
    while start < streams.len() && remaining > 0 {
        let end = batch_end(&streams, start);
        let requested: Vec<ObjectId> = streams[start..end]
            .iter()
            .filter(|(_, _, declared)| *declared <= MAX_STAMP_APPEARANCE_STREAM_BYTES)
            .map(|(_, object_id, _)| *object_id)
            .collect();
        // A failed run leaves every appearance in it foreign, as one
        // unreadable stream would.
        let mut bytes_by_object =
            read_qpdf_stream_batch(input_path, qpdf_path, &requested).unwrap_or_default();
        for (group, object_id, _) in &streams[start..end] {
            let (appearance_remaining, stopped) = &mut appearances[*group];
            if *stopped {
                continue;
            }
            // An earlier appearance loaded this shared stream and charged it.
            if !incremental.unavailable_base_streams.contains(object_id) {
                continue;
            }
            let max_bytes = (*appearance_remaining).min(remaining);
            let Some(bytes) = bytes_by_object
                .remove(object_id)
                .filter(|bytes| max_bytes > 0 && bytes.len() <= max_bytes)
            else {
                *stopped = true;
                continue;
            };
            let size = bytes.len();
            if incremental
                .set_base_stream_bytes(*object_id, bytes)
                .is_err()
            {
                *stopped = true;
                continue;
            }
            *appearance_remaining -= size;
            remaining -= size;
        }
        start = end;
    }
    Ok(())
}

/// The next qpdf run's streams: a contiguous span whose declared sizes fit
/// one run's byte and object budgets. A stream declared above the
/// per-appearance limit is never requested, so its appearance stops there.
fn batch_end(streams: &[(usize, ObjectId, usize)], start: usize) -> usize {
    let mut end = start;
    let mut batch_bytes = 0;
    while end < streams.len() && end - start < MAX_BATCH_OBJECTS {
        let declared = streams[end].2;
        if declared <= MAX_STAMP_APPEARANCE_STREAM_BYTES {
            if batch_bytes + declared > MAX_BATCH_RAW_BYTES {
                break;
            }
            batch_bytes += declared;
        }
        end += 1;
    }
    end
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
/// its appearance draws on, with each stream's declared size. Every group walks
/// its complete dependencies, so a stream shared by two appearances is listed in both.
fn note_appearance_groups(document: &impl PdfObjectSource) -> Result<Vec<Vec<(ObjectId, usize)>>> {
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
                let group = unread_appearance_streams(document, appearance_id);
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
) -> Vec<(ObjectId, usize)> {
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
                if is_unread_base_stream(document, stream) {
                    streams.push((object_id, declared_stream_bytes(document, stream)));
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

/// The length a stream declares, which sizes its share of a qpdf run. A length
/// that is missing or unusable counts as the largest appearance stream.
fn declared_stream_bytes(document: &impl PdfObjectSource, stream: &Stream) -> usize {
    stream
        .dict
        .get(b"Length")
        .ok()
        .and_then(|length| document.resolved(length).ok())
        .and_then(|length| length.as_i64().ok())
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(MAX_STAMP_APPEARANCE_STREAM_BYTES)
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
    let references: Vec<ObjectId> = match document.resolved(normal) {
        Ok(Object::Dictionary(states)) => states
            .iter()
            .filter_map(|(_, state)| state.as_reference().ok())
            .collect(),
        _ => normal.as_reference().ok().into_iter().collect(),
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

/// Each run's stream bytes stay well under the structural reader's object
/// ceiling once qpdf base64-encodes them, and its output stays bounded.
pub(crate) const MAX_BATCH_RAW_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_BATCH_OBJECTS: usize = 2_048;
const MAX_BATCH_OUTPUT_BYTES: usize = 2 * MAX_BATCH_RAW_BYTES;

/// Reads the unread streams in `object_ids` with one qpdf run, returning the
/// raw (undecoded) bytes of each stream qpdf could read. A missing object, or a
/// stream qpdf did not emit, is left out, so its caller keeps it unavailable.
pub(crate) fn read_qpdf_stream_batch(
    path: &Path,
    qpdf_path: &Path,
    object_ids: &[ObjectId],
) -> Result<HashMap<ObjectId, Vec<u8>>> {
    if object_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut arguments = vec![
        "--suppress-recovery".to_string(),
        "--json".to_string(),
        "--json-key=qpdf".to_string(),
        "--json-stream-data=inline".to_string(),
        "--decode-level=none".to_string(),
        "--json-object=trailer".to_string(),
    ];
    for (object_number, generation_number) in object_ids {
        arguments.push(format!("--json-object={object_number},{generation_number}"));
    }
    let temp = TempQpdfFiles::create()?;
    run_qpdf_bounded(
        path,
        qpdf_path,
        &arguments.iter().map(String::as_str).collect::<Vec<_>>(),
        &temp,
        MAX_BATCH_OUTPUT_BYTES,
    )?;
    let (document, unavailable) = parse_qpdf_structure(&temp.structure, Some(path))?;
    Ok(document
        .objects
        .into_iter()
        .filter(|(object_id, _)| !unavailable.contains(object_id))
        .filter_map(|(object_id, object)| match object {
            Object::Stream(stream) => Some((object_id, stream.content)),
            _ => None,
        })
        .collect())
}

/// A stream in qpdf's JSON. Inline data is the stream's raw bytes, which a
/// batch read requested. Without data the structural stand-in stands in for
/// bytes that are not read, so the caller must record it as unavailable.
pub(crate) fn qpdf_stream_from_json(stream: &Value, object_id: ObjectId) -> Result<(Stream, bool)> {
    let dict = stream.get("dict").ok_or_else(|| {
        format!(
            "qpdf stream object {} {} is missing its dictionary",
            object_id.0, object_id.1
        )
    })?;
    let dict = qpdf_dictionary(dict)?;
    let Some(data) = stream.get("data").and_then(Value::as_str) else {
        return Ok((Stream::with_position(dict, 0), true));
    };
    Ok((
        Stream::new(
            dict,
            base64::engine::general_purpose::STANDARD.decode(data)?,
        ),
        false,
    ))
}

impl IncrementalDocument {
    /// Stores the bytes read for an unavailable base stream. The stream's
    /// bytes are set without decoding, so the saved bytes stay the original's.
    pub(crate) fn set_base_stream_bytes(
        &mut self,
        object_id: ObjectId,
        bytes: Vec<u8>,
    ) -> Result<()> {
        self.previous_document
            .get_object_mut(object_id)?
            .as_stream_mut()?
            .set_content(bytes);
        self.unavailable_base_streams.remove(&object_id);
        Ok(())
    }
}
