//! Rebuilds field/widget membership and indexed exports as one output graph.
use super::*;
use crate::catalog::CatalogWalkState;
use crate::split_output::SplitAnnotationMap;

pub(crate) fn write_subset_form_path(
    input: &Path,
    output: &Path,
    qpdf: Option<&Path>,
) -> Result<()> {
    let mut incremental = load_dictionary_incremental_pdf_path(input, qpdf)?;
    let source = &incremental.previous_document;
    let updates = page_structure_updates(source)?;
    if updates.is_empty() && !source.catalog()?.has(b"AcroForm") && input == output {
        return Ok(());
    }
    let mut annotations = SplitAnnotationMap::new();
    for page in source.get_pages().values() {
        for entry in crate::split_navigation::source_annotation_entries(source, *page) {
            let (id, object) = source.dereference(&entry)?;
            let dictionary = object.as_dict()?;
            if dictionary.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Widget") {
                let id = id.ok_or("Retained form widget must be indirect")?;
                incremental.new_document.set_object(id, dictionary.clone());
                annotations.entry(id).or_default().push((*page, id));
            }
        }
    }
    incremental.new_document.objects.extend(updates);
    if let Some(form) = split_form(source, &mut incremental.new_document, &annotations)? {
        let root = source.trailer.get(b"Root")?.as_reference()?;
        let mut catalog = incremental
            .new_document
            .catalog()
            .unwrap_or(source.catalog()?)
            .clone();
        catalog.set("AcroForm", form);
        incremental.new_document.set_object(root, catalog);
    }
    incremental.new_document.version = source.version.clone();
    let revision = build_incremental_revision(&mut incremental)?;
    let ids = collect_incremental_append_object_ids(&incremental);
    with_staged_incremental_output(input, output, |staged| {
        write_incremental_revision(staged, &incremental, &revision, &ids)
    })
}

pub(crate) fn split_form(
    source: &Document,
    target: &mut Document,
    annotations: &SplitAnnotationMap,
) -> Result<Option<Dictionary>> {
    split_form_with_copy(source, target, annotations, &mut |object| Ok(object))
}

pub(crate) fn split_form_with_copy(
    source: &Document,
    target: &mut Document,
    annotations: &SplitAnnotationMap,
    copy: &mut impl FnMut(Object) -> Result<Object>,
) -> Result<Option<Dictionary>> {
    let Ok(form) = source.catalog()?.get(b"AcroForm") else {
        return Ok(None);
    };
    let source_form = source.resolved(form)?.as_dict()?;
    let mut form = source_form.clone();
    form.remove(b"Fields");
    form.remove(b"CO");
    let mut form = copy(Object::Dictionary(form))?.as_dict()?.clone();
    let mut state = CatalogWalkState::new();
    let mut fields = HashMap::new();
    let mut roots = Vec::new();
    for field in source_form
        .get(b"Fields")
        .ok()
        .and_then(|fields| source.resolved(fields).ok())
        .and_then(|fields| fields.as_array().ok())
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        for field in split_form_field(
            source,
            target,
            field,
            (None, None),
            annotations,
            &mut fields,
            &mut state,
            copy,
            0,
        )? {
            roots.push(field.into());
        }
    }
    form.set("Fields", roots);
    if let Ok(order) = source_form.get(b"CO") {
        let order = source
            .resolved(order)?
            .as_array()?
            .iter()
            .filter_map(|field| {
                field
                    .as_reference()
                    .ok()
                    .and_then(|id| fields.get(&id))
                    .copied()
                    .map(Object::Reference)
            })
            .collect::<Vec<_>>();
        form.set("CO", order);
    }
    Ok(Some(form))
}

const FIELD_KEYS: &[&[u8]] = &[
    b"FT", b"T", b"TU", b"TM", b"Ff", b"V", b"DV", b"DA", b"Q", b"DS", b"RV", b"Opt", b"MaxLen",
    b"TI", b"I", b"Lock", b"SV",
];

fn split_form_field(
    source: &Document,
    target: &mut Document,
    object: &Object,
    // The parent field and the field type it passes down.
    (parent, field_type): (Option<ObjectId>, Option<&[u8]>),
    annotations: &SplitAnnotationMap,
    fields: &mut HashMap<ObjectId, ObjectId>,
    state: &mut CatalogWalkState,
    copy: &mut impl FnMut(Object) -> Result<Object>,
    depth: usize,
) -> Result<Vec<ObjectId>> {
    if depth >= 256 || !state.enter(object) {
        return Err("Split field tree contains a cycle or exceeds catalog traversal limits".into());
    }
    let (source_id, field) = source.dereference(object)?;
    let field = field.as_dict()?;
    let field_type = field
        .get(b"FT")
        .ok()
        .and_then(|value| source.resolved(value).ok())
        .and_then(|value| value.as_name().ok())
        .or(field_type);
    let source_field = field;
    let widget = source_field
        .get(b"Subtype")
        .ok()
        .and_then(|value| source.resolved(value).ok())
        .and_then(|value| value.as_name().ok())
        == Some(b"Widget");
    let mut field = source_field.clone();
    field.remove(b"Kids");
    field.remove(b"Parent");
    let mut field = copy(Object::Dictionary(field))?.as_dict()?.clone();
    let id = if widget {
        let copies = source_id.and_then(|id| annotations.get(&id));
        let Some(copies) = copies.filter(|copies| !copies.is_empty()) else {
            return Ok(Vec::new());
        };
        if let Some(parent) = parent.filter(|_| !FIELD_KEYS.iter().any(|key| field.has(key))) {
            for (_, id) in copies {
                target.get_dictionary_mut(*id)?.set("Parent", parent);
            }
            if let Some(source_id) = source_id {
                fields.insert(source_id, copies[0].1);
            }
            return Ok(copies.iter().map(|(_, id)| *id).collect());
        }
        if copies.len() == 1 {
            let id = copies[0].1;
            let widget = target.get_dictionary_mut(id)?;
            if let Some(parent) = parent {
                widget.set("Parent", parent);
            } else {
                widget.remove(b"Parent");
            }
            if let Some(source_id) = source_id {
                fields.insert(source_id, id);
            }
            return Ok(vec![id]);
        }
        // A duplicated combined field/widget becomes one field with multiple
        // widget children, preserving its name and value exactly once.
        let id = target.new_object_id();
        let mut combined = Dictionary::new();
        for key in FIELD_KEYS.iter().copied().chain([b"AA".as_slice()]) {
            if let Ok(value) = field.get(key) {
                combined.set(key.to_vec(), value.clone());
            }
        }
        let mut kids = Vec::new();
        for (_, widget) in copies {
            let dictionary = target.get_dictionary_mut(*widget)?;
            for key in FIELD_KEYS {
                dictionary.remove(key);
            }
            dictionary.set("Parent", id);
            kids.push(Object::Reference(*widget));
        }
        combined.set("Kids", kids);
        field = combined;
        id
    } else {
        // Actions already copied by the caller must keep naming this rebuilt field.
        let id = match source_id {
            Some(id) => copy(Object::Reference(id))?.as_reference()?,
            None => target.new_object_id(),
        };
        if let Ok(kids) = source_field.get(b"Kids") {
            let kids = source.resolved(kids)?.as_array()?;
            let options = source_field
                .get(b"Opt")
                .ok()
                .and_then(|value| source.resolved(value).ok())
                .and_then(|value| value.as_array().ok())
                .filter(|options| field_type == Some(b"Btn") && options.len() == kids.len());
            let mut kept = Vec::new();
            let mut kept_options = Vec::new();
            for (index, child) in kids.iter().enumerate() {
                for child in split_form_field(
                    source,
                    target,
                    child,
                    (Some(id), field_type),
                    annotations,
                    fields,
                    state,
                    copy,
                    depth + 1,
                )? {
                    kept.push(Object::Reference(child));
                    if let Some(options) = options {
                        kept_options.push(copy(options[index].clone())?);
                    }
                }
            }
            if options.is_some() {
                field.set("Opt", kept_options);
            }
            if kept.is_empty() {
                return Ok(Vec::new());
            }
            field.set("Kids", kept);
        }
        id
    };
    if let Some(parent) = parent {
        field.set("Parent", parent);
    } else {
        field.remove(b"Parent");
    }
    if let Some(source_id) = source_id {
        fields.insert(source_id, id);
    }
    target.set_object(id, field);
    Ok(vec![id])
}
