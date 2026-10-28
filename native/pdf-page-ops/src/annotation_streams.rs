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

    let (stamp_refs, streams) = {
        let document = AppendedRevision::new(incremental);
        (
            managed_stamp_stream_refs(&document)?,
            note_appearance_streams(&document)?,
        )
    };

    let mut remaining = MAX_PLACED_IMAGE_AGGREGATE_BYTES as usize;
    for (object_id, stream_limit) in stamp_refs {
        if remaining == 0 {
            break;
        }
        // Keep an unsupported or oversized image foreign without withholding
        // otherwise readable annotations from the same document.
        let limit = remaining.min(stream_limit);
        if incremental
            .materialize_base_stream(input_path, qpdf_path, object_id, limit)
            .is_ok()
        {
            let document = incremental.get_prev_documents();
            if let Ok(stream) = document.get_object(object_id).and_then(Object::as_stream) {
                remaining = remaining.saturating_sub(stream.content.len());
            }
        }
    }

    let mut start = 0;
    while start < streams.len() && remaining > 0 {
        let end = batch_end(&streams, start);
        let requested: Vec<ObjectId> = streams[start..end].iter().map(|(id, _)| *id).collect();
        // A run that fails is read one stream at a time, so only the streams
        // qpdf cannot read alone stay unread, and only their notes stay foreign.
        // A few scoped raw reads avoid qpdf JSON's whole-file scan. Larger
        // sets and whole-document consumers retain the shared batch transport.
        let mut bytes_by_object = if incremental.located_pages.is_some() && requested.len() <= 8 {
            read_individual_streams(input_path, qpdf_path, &requested)
        } else {
            read_qpdf_stream_batch(input_path, qpdf_path, &requested)
                .unwrap_or_else(|_| read_individual_streams(input_path, qpdf_path, &requested))
        };
        for (object_id, _) in &streams[start..end] {
            let Some(bytes) = bytes_by_object.remove(object_id) else {
                continue;
            };
            let size = bytes.len();
            if size <= remaining.min(MAX_STAMP_APPEARANCE_STREAM_BYTES)
                && incremental.set_base_stream_bytes(*object_id, bytes).is_ok()
            {
                remaining -= size;
            }
        }
        start = end;
    }
    Ok(())
}

/// The next qpdf run's streams: a contiguous span whose costs fit one run's
/// byte and object budgets. Every listed stream fits a run on its own.
pub(crate) fn batch_end(streams: &[(ObjectId, usize)], start: usize) -> usize {
    let mut end = start;
    let mut batch_bytes = 0;
    while end < streams.len()
        && end - start < MAX_BATCH_OBJECTS
        && batch_bytes + streams[end].1 <= MAX_BATCH_RAW_BYTES
    {
        batch_bytes += streams[end].1;
        end += 1;
    }
    end
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
            if let Ok(mut graph) = stamp_image_graph(document, dictionary) {
                // The raster identity binds its alpha samples as well as its
                // colors. Materialize the soft mask before recognizing it.
                if let Some(mask) = graph
                    .last()
                    .and_then(|(_, stream)| stream.dict.get(b"SMask").ok()?.as_reference().ok())
                {
                    if let Ok(Object::Stream(stream)) = document.object(mask) {
                        graph.push((mask, stream));
                    }
                }
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

/// The unread streams the notes' normal appearances draw on, each once, in
/// first-seen order, with its cost in a qpdf run. Each note-thread appearance
/// walks its complete dependencies along the `/IRT` and `/Popup` links that
/// parsing follows. An appearance whose streams exceed the recovery budget adds
/// none, while a stream it shares still serves the others.
fn note_appearance_streams(document: &impl PdfObjectSource) -> Result<Vec<(ObjectId, usize)>> {
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

    let mut streams = Vec::new();
    for note_id in &page_annotations {
        let Ok(note) = document.dictionary(*note_id) else {
            continue;
        };
        // Parsing lists a reply under its parent, never as a note of its own.
        if !matches!(
            annotation_subtype_name(document, note)
                .to_ascii_lowercase()
                .as_str(),
            "text" | "freetext"
        ) || note.get(b"IRT").is_ok()
        {
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
                let bytes = group
                    .iter()
                    .map(|(_, cost)| *cost)
                    .fold(0, usize::saturating_add);
                if bytes <= MAX_STAMP_APPEARANCE_STREAM_BYTES {
                    streams.extend(group);
                }
            }
            if let Some(popup) = annotation_related_ref(member, b"Popup") {
                thread.push(popup);
            }
            thread.extend(replies.get(&member_id).into_iter().flatten().copied());
        }
    }
    let mut listed = HashSet::new();
    streams.retain(|(object_id, _)| listed.insert(*object_id));
    Ok(streams)
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
                    streams.push((object_id, stream_run_bytes(document, stream)));
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

/// The bytes a stream costs in a qpdf run: its declared length, plus the
/// dictionary qpdf serializes beside it, which note recovery budgets too. A
/// length that is missing or unusable counts as the largest appearance stream,
/// and a dictionary over the recovery budget costs more than any run can hold.
fn stream_run_bytes(document: &impl PdfObjectSource, stream: &Stream) -> usize {
    let length = stream
        .dict
        .get(b"Length")
        .ok()
        .and_then(|length| document.resolved(length).ok())
        .and_then(|length| length.as_i64().ok())
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(MAX_STAMP_APPEARANCE_STREAM_BYTES);
    let mut dictionary_bytes = 0;
    match inspect_recovery_object(
        &Object::Dictionary(stream.dict.clone()),
        0,
        &mut dictionary_bytes,
        &mut |_| {},
    ) {
        Ok(()) => length.saturating_add(dictionary_bytes),
        Err(_) => usize::MAX,
    }
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
    if object_ids.len() > MAX_BATCH_OBJECTS {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Annotation stream batch exceeds its object ceiling",
        ));
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
    let streams: HashMap<_, _> = document
        .objects
        .into_iter()
        .filter(|(object_id, _)| !unavailable.contains(object_id))
        .filter_map(|(object_id, object)| match object {
            Object::Stream(stream) => Some((object_id, stream.content)),
            _ => None,
        })
        .collect();
    let raw_bytes = streams
        .values()
        .map(Vec::len)
        .try_fold(0usize, usize::checked_add);
    if raw_bytes.is_none_or(|bytes| bytes > MAX_BATCH_RAW_BYTES) {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "Annotation stream batch exceeds its raw byte ceiling",
        ));
    }
    Ok(streams)
}

/// Both the small-set transport and failed-batch recovery share one raw
/// byte ceiling. Each read also retains the per-appearance stream ceiling.
fn read_individual_streams(
    path: &Path,
    qpdf: &Path,
    ids: &[ObjectId],
) -> HashMap<ObjectId, Vec<u8>> {
    let mut remaining = MAX_BATCH_RAW_BYTES;
    let mut streams = HashMap::new();
    for id in ids.iter().take(MAX_BATCH_OBJECTS) {
        if remaining == 0 {
            break;
        }
        if let Ok(bytes) = read_qpdf_stream_bounded(
            path,
            qpdf,
            *id,
            remaining.min(MAX_STAMP_APPEARANCE_STREAM_BYTES),
        ) {
            remaining -= bytes.len();
            streams.insert(*id, bytes);
        }
    }
    streams
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
