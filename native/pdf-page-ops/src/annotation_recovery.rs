use super::*;
use std::borrow::Cow;

pub(crate) const MAX_RECOVERY_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_RECOVERY_OBJECTS: usize = 1024;

/// A bounded, native-owned snapshot lives in annotation undo history. No
/// deleted content is added to the output PDF until the user restores it.
/// Each reply keeps its page, as an offset from the note's page.
pub(crate) fn capture_note_recovery(
    source: &impl PdfObjectSource,
    (root, page): (ObjectId, u64),
    replies: &BTreeMap<ObjectId, u64>,
) -> Result<String> {
    let replies: Vec<_> = replies
        .iter()
        .map(|(&id, &at)| (id, at as i64 - page as i64))
        .collect();
    capture_annotation_recovery(source, root, &replies, false, MAX_RECOVERY_BYTES)
}

pub(crate) fn capture_text_box_recovery(
    source: &impl PdfObjectSource,
    root: ObjectId,
    remaining_bytes: &mut usize,
) -> Result<String> {
    if *remaining_bytes == 0 {
        return Err("Text box inline recovery budget is exhausted".into());
    }
    let data = capture_annotation_recovery(
        source,
        root,
        &[],
        true,
        (*remaining_bytes).min(MAX_RECOVERY_BYTES),
    )?;
    *remaining_bytes -= data.len() / 2;
    Ok(data)
}

fn capture_annotation_recovery(
    source: &impl PdfObjectSource,
    root: ObjectId,
    related_notes: &[(ObjectId, i64)],
    appearance_only: bool,
    max_bytes: usize,
) -> Result<String> {
    let mut graph = capture_annotation_graph(
        source,
        root,
        related_notes,
        appearance_only,
        max_bytes,
        MAX_RECOVERY_OBJECTS,
        false,
    )?;
    graph.renumber_objects();
    let mut bytes = Vec::new();
    graph.save_to(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err("Note recovery graph exceeds the byte ceiling".into());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn capture_annotation_graph(
    source: &impl PdfObjectSource,
    root: ObjectId,
    related_notes: &[(ObjectId, i64)],
    appearance_only: bool,
    max_bytes: usize,
    max_objects: usize,
    allow_unavailable: bool,
) -> Result<Document> {
    // The parser already owns the document's reply index. Visit only this
    // note's descendants instead of rescanning every annotation per note. A
    // popup sits on its annotation's page.
    let mut annotation_refs = Vec::new();
    let mut annotation_seen = HashSet::new();
    for (id, page) in std::iter::once((root, 0)).chain(related_notes.iter().copied()) {
        let popup = (!appearance_only)
            .then(|| annotation_related_ref(source.dictionary(id).ok()?, b"Popup"))
            .flatten();
        for id in std::iter::once(id).chain(popup) {
            if annotation_seen.insert(id) {
                annotation_refs.push((id, page));
            }
        }
    }
    let mut pending: Vec<_> = annotation_refs.iter().map(|(id, _)| *id).collect();
    let mut graph = Document::with_version("1.7");
    let mut budget = 0usize;
    while let Some(reference) = pending.pop() {
        if graph.objects.contains_key(&reference) {
            continue;
        }
        if graph.objects.len() >= max_objects {
            return Err("Note recovery graph exceeds the object ceiling".into());
        }
        let source_object = source.object(reference)?;
        if !allow_unavailable
            && source_object
                .as_stream()
                .is_ok_and(|stream| is_unread_base_stream(source, stream))
        {
            return Err("Note recovery requires unavailable source stream bytes".into());
        }
        if source_object
            .as_stream()
            .is_ok_and(|stream| stream.content.len() > max_bytes)
        {
            return Err("Note recovery stream exceeds the byte ceiling".into());
        }
        let mut object = source_object.clone();
        if let Object::Dictionary(dict) = &mut object {
            let kind = dict.get(b"Type").and_then(Object::as_name);
            if matches!(kind, Ok(b"Page" | b"Pages" | b"Catalog")) {
                return Err("Note recovery graph crosses into the page tree".into());
            }
            if annotation_seen.contains(&reference) {
                dict.remove(b"P");
            }
            if appearance_only && reference == root {
                for key in TEXT_BOX_METADATA_FIELDS {
                    dict.remove(key);
                }
            }
        }
        inspect_recovery_object_with_limit(&object, 0, &mut budget, max_bytes, &mut |id| {
            pending.push(id)
        })?;
        graph.set_object(reference, object);
    }
    let (annots, pages): (Vec<_>, Vec<_>) = annotation_refs
        .into_iter()
        .map(|(id, page)| (Object::Reference(id), Object::Integer(page)))
        .unzip();
    graph.trailer.set("Root", Object::Reference(root));
    graph.trailer.set("EVBAnnots", annots);
    graph.trailer.set("EVBPages", pages);
    Ok(graph)
}

/// Each recovered annotation and its page's offset from the root's page.
fn recovery_members(graph: &Document) -> Result<Vec<(ObjectId, i64)>> {
    let annots = graph.trailer.get(b"EVBAnnots")?.as_array()?;
    // Older graphs have no offsets: all sat on the root's page.
    let zeros = vec![Object::Integer(0); annots.len()];
    let pages = graph
        .trailer
        .get(b"EVBPages")
        .map_or(Ok(&zeros), Object::as_array)?;
    if annots.len() != pages.len() {
        return Err("Note recovery pages do not match its annotations".into());
    }
    let member =
        |(id, page): (&Object, &Object)| -> Result<_> { Ok((id.as_reference()?, page.as_i64()?)) };
    annots.iter().zip(pages).map(member).collect()
}

/// Source extraction is used only at Save, from the parent's immutable lease.
/// Its graph admission matches the existing retained native document budgets;
/// ordinary inline undo snapshots keep their smaller 1 MiB/1024-object limits.
pub(crate) fn hydrate_text_box_original_appearances(
    mutations: &mut NativeMutationsFile,
    source: &impl PdfObjectSource,
) -> Result<()> {
    let mut remaining = MAX_SIDECAR_BYTES;
    for editor in &mut mutations.text_boxes {
        let Some(original) = &mut editor.original_appearance else {
            continue;
        };
        let Some(id) = original.source_annotation_id.as_deref() else {
            continue;
        };
        let root = parse_pdfjs_annotation_object_id(id)
            .ok_or("Invalid original appearance source annotation id")?;
        if annotation_subtype(source.dictionary(root)?) != "freetext" {
            return Err("Original appearance source is not FreeText".into());
        }
        let graph = capture_annotation_graph(
            source,
            root,
            &[],
            true,
            remaining,
            MAX_COLLECTION_ITEMS,
            false,
        )?;
        let mut bytes = 0;
        for object in graph.objects.values() {
            inspect_recovery_object_with_limit(object, 0, &mut bytes, remaining, &mut |_| {})?;
        }
        remaining = remaining.saturating_sub(bytes);
        original.source_graph = Some(graph);
    }
    Ok(())
}

pub(crate) fn hydrate_text_box_original_appearances_path(
    mutations: &mut NativeMutationsFile,
    path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let mut source = load_dictionary_incremental_pdf_path(path, qpdf_path)?;
    let mut pending = HashSet::new();
    for editor in &mutations.text_boxes {
        let Some(id) = editor
            .original_appearance
            .as_ref()
            .and_then(|a| a.source_annotation_id.as_deref())
        else {
            continue;
        };
        let root = parse_pdfjs_annotation_object_id(id)
            .ok_or("Invalid original appearance source annotation id")?;
        let graph = capture_annotation_graph(
            &AppendedRevision::new(&source),
            root,
            &[],
            true,
            MAX_SIDECAR_BYTES,
            MAX_COLLECTION_ITEMS,
            true,
        )?;
        pending.extend(
            graph
                .objects
                .keys()
                .copied()
                .filter(|id| source.unavailable_base_streams.contains(id)),
        );
    }
    let mut remaining = MAX_SIDECAR_BYTES;
    for id in pending {
        source.materialize_base_stream(
            path,
            qpdf_path.ok_or("Original appearance source requires qpdf stream access")?,
            id,
            remaining.min(MAX_DECOMPRESSED_PDF_STREAM_BYTES),
        )?;
        let stream = source.get_prev_documents().get_object(id)?.as_stream()?;
        remaining = remaining
            .checked_sub(stream.content.len())
            .ok_or("Original appearance source streams exceed their byte ceiling")?;
    }
    hydrate_text_box_original_appearances(mutations, &AppendedRevision::new(&source))
}

pub(crate) fn original_text_box_graph(
    original: &TextBoxOriginalAppearance,
) -> Result<Cow<'_, Document>> {
    if let Some(graph) = &original.source_graph {
        return Ok(Cow::Borrowed(graph));
    }
    if let Some(data) = &original.recovery_data {
        return Ok(Cow::Owned(decode_note_recovery(data)?));
    }
    Err("Original appearance requires its retained immutable source".into())
}

// Appearance restoration owns the original painting/geometry wrapper and text
// encoding. Identity, thread links and descriptive metadata belong to Save.
pub(crate) const TEXT_BOX_METADATA_FIELDS: &[&[u8]] = &[
    b"NM",
    b"T",
    b"CreationDate",
    b"M",
    b"Subj",
    b"Popup",
    b"IRT",
    b"RT",
    b"State",
    b"StateModel",
    b"ExData",
];

pub(crate) fn restore_text_box_recovery(
    document: &mut Document,
    original: &TextBoxOriginalAppearance,
    root: ObjectId,
    page: ObjectId,
    current: Option<&Dictionary>,
    editor: &TextBoxMutation,
    modified_at: &str,
) -> Result<()> {
    let popup = document.new_object_id();
    let graph = original_text_box_graph(original)?;
    restore_recovery_graph(document, &graph, root, popup, |_, _| Ok(page))?;
    let contents = document
        .get_dictionary(root)?
        .get(b"Contents")
        .ok()
        .and_then(|value| document.resolved(value).ok())
        .filter(|value| pdf_string_to_text(value).as_deref() == Some(editor.text.as_str()))
        .cloned()
        .unwrap_or_else(|| text_object(&editor.text));
    let dict = document.get_dictionary_mut(root)?;
    if annotation_subtype(dict) != "freetext" {
        return Err("Original appearance root is not FreeText".into());
    }
    for key in TEXT_BOX_METADATA_FIELDS {
        dict.remove(key);
        if let Some(value) = current.and_then(|dict| dict.get(key).ok()) {
            dict.set(key.to_vec(), value.clone());
        }
    }
    dict.set("Contents", contents);
    if read_annotation_name(dict).is_none() {
        write_annotation_name(dict, &text_box_name(editor));
    }
    dict.set(
        "M",
        Object::string_literal(shape_pdf_date(editor.modified_at, modified_at)),
    );
    if let Some(author) = &editor.author {
        dict.set("T", text_object(author));
    }
    if let Some(created) = editor.created_at {
        dict.set(
            "CreationDate",
            Object::string_literal(shape_pdf_date(Some(created), modified_at)),
        );
    }
    Ok(())
}

pub(crate) fn inspect_recovery_object(
    object: &Object,
    depth: usize,
    budget: &mut usize,
    on_ref: &mut impl FnMut(ObjectId),
) -> Result<()> {
    inspect_recovery_object_with_limit(object, depth, budget, MAX_RECOVERY_BYTES, on_ref)
}

fn inspect_recovery_object_with_limit(
    object: &Object,
    depth: usize,
    budget: &mut usize,
    max_bytes: usize,
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
                inspect_recovery_object_with_limit(value, depth + 1, budget, max_bytes, on_ref)?;
            }
        }
        Object::Dictionary(dict) => {
            for (key, value) in dict.iter() {
                *budget = budget.saturating_add(key.len());
                inspect_recovery_object_with_limit(value, depth + 1, budget, max_bytes, on_ref)?;
            }
        }
        Object::Stream(stream) => {
            *budget = budget.saturating_add(stream.content.len());
            inspect_recovery_object_with_limit(
                &Object::Dictionary(stream.dict.clone()),
                depth + 1,
                budget,
                max_bytes,
                on_ref,
            )?;
        }
        Object::String(bytes, _) | Object::Name(bytes) => {
            *budget = budget.saturating_add(bytes.len())
        }
        _ => {}
    }
    if *budget > max_bytes {
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
    let members = recovery_members(&graph)?;
    let annotation_refs: HashSet<_> = members.iter().map(|(id, _)| *id).collect();
    let mut budget = 0;
    for (id, object) in &graph.objects {
        let mut missing = false;
        inspect_recovery_object(object, 0, &mut budget, &mut |id| {
            missing |= !graph.objects.contains_key(&id);
        })?;
        if missing {
            return Err("Note recovery graph has an external reference".into());
        }
        if let Object::Dictionary(dict) = object {
            let kind = dict.get(b"Type").and_then(Object::as_name);
            if (annotation_refs.contains(id) && dict.has(b"P"))
                || matches!(kind, Ok(b"Page" | b"Pages" | b"Catalog"))
            {
                return Err("Note recovery graph contains page ownership".into());
            }
        }
    }
    for (id, _) in members {
        if annotation_subtype(graph.get_dictionary(id)?).is_empty() {
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
        Object::Dictionary(dict) | Object::Stream(Stream { dict, .. }) => {
            for (_, value) in dict.iter_mut() {
                remap_recovery_object(value, refs);
            }
        }
        _ => {}
    }
}

/// Clone every object to fresh references, including reply /IRT and popup
/// /Parent links. Retired PDF references are never resurrected as identities.
/// Each annotation returns to its own page, as far from the note's page as it
/// was; `page_id` resolves a page number in the document being written.
pub(crate) fn restore_note_recovery(
    document: &mut Document,
    data: &str,
    (root, popup): (ObjectId, ObjectId),
    page_number: u32,
    mut page_id: impl FnMut(&Document, u32) -> Result<ObjectId>,
) -> Result<Vec<(ObjectId, ObjectId)>> {
    let graph = decode_note_recovery(data)?;
    restore_recovery_graph(document, &graph, root, popup, |document, offset| {
        let number = u32::try_from(i64::from(page_number) + offset).unwrap_or(0);
        page_id(document, number)
    })
}

fn restore_recovery_graph(
    document: &mut Document,
    graph: &Document,
    root: ObjectId,
    popup: ObjectId,
    mut page_of: impl FnMut(&Document, i64) -> Result<ObjectId>,
) -> Result<Vec<(ObjectId, ObjectId)>> {
    let old_root = graph.trailer.get(b"Root")?.as_reference()?;
    let old_popup = annotation_related_ref(graph.get_dictionary(old_root)?, b"Popup");
    let mut refs = HashMap::from([(old_root, root)]);
    refs.extend(old_popup.map(|old_popup| (old_popup, popup)));
    for id in graph.objects.keys() {
        refs.entry(*id).or_insert_with(|| document.new_object_id());
    }
    let mut members = Vec::new();
    for (id, offset) in recovery_members(graph)? {
        members.push((refs[&id], page_of(document, offset)?));
    }
    for (id, source_object) in &graph.objects {
        let mut object = source_object.clone();
        remap_recovery_object(&mut object, &refs);
        if let Some((_, page)) = members.iter().find(|(member, _)| *member == refs[id]) {
            object.as_dict_mut()?.set("P", Object::Reference(*page));
        }
        document.set_object(refs[id], object);
    }
    Ok(members)
}
