//! Rebuilds field/widget membership and indexed exports as one output graph.
use super::*;
use crate::catalog::CatalogWalkState;
use crate::split_output::SplitAnnotationMap;

pub(crate) fn split_form(
    source: &Document,
    target: &mut Document,
    annotations: &SplitAnnotationMap,
) -> Result<Option<Dictionary>> {
    if let Ok(form) = source.catalog()?.get(b"AcroForm") {
        let mut form = source.resolved(form)?.as_dict()?.clone();
        let mut state = CatalogWalkState::new();
        let mut fields = HashMap::new();
        let mut roots = Vec::new();
        for field in source.resolved(form.get(b"Fields")?)?.as_array()? {
            for field in split_form_field(
                source,
                target,
                field,
                None,
                annotations,
                &mut fields,
                &mut state,
                0,
            )? {
                roots.push(field.into());
            }
        }
        form.set("Fields", roots);
        if let Ok(order) = form.get(b"CO") {
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
        return Ok(Some(form));
    }
    Ok(None)
}

const FIELD_KEYS: &[&[u8]] = &[
    b"FT", b"T", b"TU", b"TM", b"Ff", b"V", b"DV", b"DA", b"Q", b"DS", b"RV", b"Opt", b"MaxLen",
    b"TI", b"I", b"Lock", b"SV",
];

fn split_form_field(
    source: &Document,
    target: &mut Document,
    object: &Object,
    parent: Option<ObjectId>,
    annotations: &SplitAnnotationMap,
    fields: &mut HashMap<ObjectId, ObjectId>,
    state: &mut CatalogWalkState,
    depth: usize,
) -> Result<Vec<ObjectId>> {
    if depth >= 256 || !state.enter(object) {
        return Err("Split field tree contains a cycle or exceeds catalog traversal limits".into());
    }
    let (source_id, field) = source.dereference(object)?;
    let mut field = field.as_dict()?.clone();
    let widget = field
        .get(b"Subtype")
        .ok()
        .and_then(|value| source.resolved(value).ok())
        .and_then(|value| value.as_name().ok())
        == Some(b"Widget");
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
        for key in FIELD_KEYS {
            if let Ok(value) = field.get(key) {
                combined.set(key.to_vec(), value.clone());
            }
        }
        if let Ok(actions) = field.get(b"AA") {
            combined.set("AA", actions.clone());
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
        let id = target.new_object_id();
        if let Ok(kids) = field.get(b"Kids") {
            let kids = source.resolved(kids)?.as_array()?;
            let options = field
                .get(b"Opt")
                .ok()
                .and_then(|value| source.resolved(value).ok())
                .and_then(|value| value.as_array().ok())
                .filter(|options| options.len() == kids.len());
            let mut kept = Vec::new();
            let mut kept_options = Vec::new();
            for (index, child) in kids.iter().enumerate() {
                for child in split_form_field(
                    source,
                    target,
                    child,
                    Some(id),
                    annotations,
                    fields,
                    state,
                    depth + 1,
                )? {
                    kept.push(Object::Reference(child));
                    if let Some(options) = options {
                        kept_options.push(options[index].clone());
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
