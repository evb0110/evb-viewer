use super::*;

const MAX_RECOVERY_BYTES: usize = 1024 * 1024;
const MAX_RECOVERY_OBJECTS: usize = 1024;

/// A bounded, native-owned snapshot lives in annotation undo history. No
/// deleted content is added to the output PDF until the user restores it.
pub(crate) fn capture_note_recovery(
    source: &impl PdfObjectSource,
    root: ObjectId,
    related_notes: &[ObjectId],
) -> Result<String> {
    // The parser already owns the page-local reply index. Visit only this
    // note's descendants instead of rescanning every annotation per note.
    let mut annotation_refs = Vec::new();
    let mut annotation_seen = HashSet::new();
    for id in std::iter::once(root).chain(related_notes.iter().copied()) {
        if annotation_seen.insert(id) {
            annotation_refs.push(id);
        }
        if let Some(popup) = annotation_related_ref(source.dictionary(id)?, b"Popup") {
            if annotation_seen.insert(popup) {
                annotation_refs.push(popup);
            }
        }
    }
    let mut pending = annotation_refs.to_vec();
    let mut graph = Document::with_version("1.7");
    let mut budget = 0usize;
    while let Some(reference) = pending.pop() {
        if graph.objects.contains_key(&reference) {
            continue;
        }
        if graph.objects.len() >= MAX_RECOVERY_OBJECTS {
            return Err("Note recovery graph exceeds the object ceiling".into());
        }
        let source_object = source.object(reference)?;
        if source_object.as_stream().is_ok_and(|stream| {
            stream.content.is_empty()
                && stream.start_position == Some(0)
                && stream
                    .dict
                    .get(b"Length")
                    .ok()
                    .and_then(|value| value.as_i64().ok())
                    != Some(0)
        }) {
            return Err("Note recovery requires unavailable source stream bytes".into());
        }
        if source_object
            .as_stream()
            .is_ok_and(|stream| stream.content.len() > MAX_RECOVERY_BYTES)
        {
            return Err("Note recovery stream exceeds the byte ceiling".into());
        }
        let mut object = source_object.clone();
        if let Object::Dictionary(dict) = &mut object {
            if matches!(
                dict.get(b"Type")
                    .ok()
                    .and_then(|value| value.as_name().ok()),
                Some(b"Page" | b"Pages" | b"Catalog")
            ) {
                return Err("Note recovery graph crosses into the page tree".into());
            }
            dict.remove(b"P");
        }
        inspect_recovery_object(&object, 0, &mut budget, &mut |id| pending.push(id))?;
        graph.set_object(reference, object);
    }
    graph.trailer.set("Root", Object::Reference(root));
    graph.trailer.set(
        "EVBAnnots",
        Object::Array(
            annotation_refs
                .iter()
                .map(|id| Object::Reference(*id))
                .collect(),
        ),
    );
    // History graphs use compact private references. Sparse source object
    // numbers must not inflate their xref table or consume the object budget.
    graph.renumber_objects();
    let mut bytes = Vec::new();
    graph.save_to(&mut bytes)?;
    if bytes.len() > MAX_RECOVERY_BYTES {
        return Err("Note recovery graph exceeds the byte ceiling".into());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn inspect_recovery_object(
    object: &Object,
    depth: usize,
    budget: &mut usize,
    on_ref: &mut impl FnMut(ObjectId),
) -> Result<()> {
    if depth > 64 {
        return Err("Note recovery graph nesting exceeds the ceiling".into());
    }
    *budget = budget.saturating_add(16);
    match object {
        Object::Reference(id) => on_ref(*id),
        Object::Array(values) => {
            for value in values {
                inspect_recovery_object(value, depth + 1, budget, on_ref)?;
            }
        }
        Object::Dictionary(dict) => {
            for (key, value) in dict.iter() {
                *budget = budget.saturating_add(key.len());
                inspect_recovery_object(value, depth + 1, budget, on_ref)?;
            }
        }
        Object::Stream(stream) => {
            *budget = budget.saturating_add(stream.content.len());
            inspect_recovery_object(
                &Object::Dictionary(stream.dict.clone()),
                depth + 1,
                budget,
                on_ref,
            )?;
        }
        Object::String(bytes, _) | Object::Name(bytes) => {
            *budget = budget.saturating_add(bytes.len())
        }
        _ => {}
    }
    if *budget > MAX_RECOVERY_BYTES {
        return Err("Note recovery graph exceeds the byte ceiling".into());
    }
    Ok(())
}

pub(crate) fn decode_note_recovery(data: &str) -> Result<Document> {
    if data.is_empty() || data.len() > MAX_RECOVERY_BYTES * 2 || !data.len().is_multiple_of(2) {
        return Err("Invalid note recovery graph size".into());
    }
    let bytes = data
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => Ok(byte - b'0'),
                b'a'..=b'f' => Ok(byte - b'a' + 10),
                _ => Err("Invalid note recovery graph encoding"),
            };
            Ok((digit(pair[0])? << 4) | digit(pair[1])?)
        })
        .collect::<std::result::Result<Vec<u8>, &str>>()?;
    preflight_pdf_object_graph(&bytes, MAX_RECOVERY_BYTES, MAX_RECOVERY_OBJECTS)?;
    let graph = Document::load_mem_with_options(
        &bytes,
        lopdf::LoadOptions::with_max_decompressed_size(MAX_RECOVERY_BYTES),
    )?;
    if graph.objects.len() > MAX_RECOVERY_OBJECTS {
        return Err("Note recovery graph exceeds the object ceiling".into());
    }
    let root = graph.trailer.get(b"Root")?.as_reference()?;
    if !matches!(
        annotation_subtype(graph.get_dictionary(root)?).as_str(),
        "text" | "freetext"
    ) {
        return Err("Note recovery root is not a note".into());
    }
    let mut budget = 0;
    for object in graph.objects.values() {
        let mut missing = false;
        inspect_recovery_object(object, 0, &mut budget, &mut |id| {
            missing |= !graph.objects.contains_key(&id);
        })?;
        if missing {
            return Err("Note recovery graph has an external reference".into());
        }
        if let Object::Dictionary(dict) = object {
            if dict.has(b"P")
                || matches!(
                    dict.get(b"Type")
                        .ok()
                        .and_then(|value| value.as_name().ok()),
                    Some(b"Page" | b"Pages" | b"Catalog")
                )
            {
                return Err("Note recovery graph contains page ownership".into());
            }
        }
    }
    for object in graph.trailer.get(b"EVBAnnots")?.as_array()? {
        let dict = graph.get_dictionary(object.as_reference()?)?;
        if annotation_subtype(dict).is_empty() {
            return Err("Note recovery annotation is missing its subtype".into());
        }
    }
    Ok(graph)
}

fn remap_recovery_object(object: &mut Object, refs: &HashMap<ObjectId, ObjectId>) {
    match object {
        Object::Reference(id) => *id = refs[id],
        Object::Array(values) => {
            for value in values {
                remap_recovery_object(value, refs);
            }
        }
        Object::Dictionary(dict) => {
            for (_, value) in dict.iter_mut() {
                remap_recovery_object(value, refs);
            }
        }
        Object::Stream(stream) => {
            for (_, value) in stream.dict.iter_mut() {
                remap_recovery_object(value, refs);
            }
        }
        _ => {}
    }
}

/// Clone every object to fresh references, including reply /IRT and popup
/// /Parent links. Retired PDF references are never resurrected as identities.
pub(crate) fn restore_note_recovery(
    document: &mut Document,
    data: &str,
    root: ObjectId,
    popup: ObjectId,
    page: ObjectId,
) -> Result<Vec<ObjectId>> {
    let graph = decode_note_recovery(data)?;
    let old_root = graph.trailer.get(b"Root")?.as_reference()?;
    let old_popup = annotation_related_ref(graph.get_dictionary(old_root)?, b"Popup");
    let mut refs = HashMap::new();
    refs.insert(old_root, root);
    if let Some(old_popup) = old_popup {
        refs.insert(old_popup, popup);
    }
    for id in graph.objects.keys() {
        refs.entry(*id).or_insert_with(|| document.new_object_id());
    }
    let annots = graph
        .trailer
        .get(b"EVBAnnots")?
        .as_array()?
        .iter()
        .map(|object| object.as_reference().map(|id| refs[&id]))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (id, mut object) in graph.objects {
        remap_recovery_object(&mut object, &refs);
        if annots.contains(&refs[&id]) {
            object.as_dict_mut()?.set("P", Object::Reference(page));
        }
        document.set_object(refs[&id], object);
    }
    Ok(annots)
}

pub(crate) fn validate_note_recovery(
    document: &impl PdfObjectSource,
    data: &str,
    root: ObjectId,
    annots: &[Object],
) -> Result<()> {
    let graph = decode_note_recovery(data)?;
    let expected_root = graph.trailer.get(b"Root")?.as_reference()?;
    let expected_annots = graph.trailer.get(b"EVBAnnots")?.as_array()?;
    let expected =
        recovery_reply_signatures(&graph, expected_root, expected_annots, &mut HashSet::new())?;
    let actual = recovery_reply_signatures(document, root, annots, &mut HashSet::new())?;
    if expected != actual {
        return Err("Restored note reply graph differs from its source".into());
    }
    Ok(())
}

fn recovery_reply_signatures(
    source: &impl PdfObjectSource,
    parent: ObjectId,
    annots: &[Object],
    seen: &mut HashSet<ObjectId>,
) -> Result<Vec<String>> {
    if !seen.insert(parent) || seen.len() > MAX_RECOVERY_OBJECTS {
        return Err("Note reply graph contains a cycle or exceeds its ceiling".into());
    }
    let mut signatures = Vec::new();
    for reference in annots
        .iter()
        .filter_map(|object| object.as_reference().ok())
    {
        let dict = source.dictionary(reference)?;
        if annotation_related_ref(dict, b"IRT") != Some(parent) {
            continue;
        }
        if let Some(popup) = annotation_related_ref(dict, b"Popup") {
            if annotation_related_ref(source.dictionary(popup)?, b"Parent") != Some(reference) {
                return Err("Restored reply popup parent differs from its source".into());
            }
        }
        let normalized = recovery_semantic_object(
            source,
            &Object::Dictionary(dict.clone()),
            &mut HashSet::new(),
            0,
        )?;
        let children = recovery_reply_signatures(source, reference, annots, seen)?;
        signatures.push(format!("{normalized:?}:{children:?}"));
    }
    signatures.sort();
    Ok(signatures)
}

fn recovery_semantic_object(
    source: &impl PdfObjectSource,
    object: &Object,
    seen: &mut HashSet<ObjectId>,
    depth: usize,
) -> Result<Object> {
    if depth > 64 {
        return Err("Note graph semantic validation exceeds nesting ceiling".into());
    }
    Ok(match object {
        Object::Reference(id) => {
            if !seen.insert(*id) {
                return Ok(Object::Name(b"EVBCycle".to_vec()));
            }
            let result = recovery_semantic_object(source, source.object(*id)?, seen, depth + 1)?;
            seen.remove(id);
            result
        }
        Object::Dictionary(dict) => {
            let mut result = Dictionary::new();
            for (key, value) in dict.iter() {
                if matches!(key.as_slice(), b"P" | b"IRT" | b"Parent" | b"Length") {
                    continue;
                }
                result.set(
                    key.clone(),
                    recovery_semantic_object(source, value, seen, depth + 1)?,
                );
            }
            Object::Dictionary(result)
        }
        Object::Array(values) => Object::Array(
            values
                .iter()
                .map(|value| recovery_semantic_object(source, value, seen, depth + 1))
                .collect::<Result<Vec<_>>>()?,
        ),
        Object::Stream(stream) => {
            let dict = recovery_semantic_object(
                source,
                &Object::Dictionary(stream.dict.clone()),
                seen,
                depth + 1,
            )?
            .as_dict()?
            .clone();
            Object::Stream(Stream::new(dict, stream.content.clone()))
        }
        value => value.clone(),
    })
}
