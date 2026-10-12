use super::*;

/// Reads an outline item's action as a value without object references, so
/// that page rewrites, which renumber objects, cannot retarget it. An object
/// the action refers to, such as its file specification, is read in place
/// within the same size and nesting ceilings. An action that refers to a page
/// or holds a stream, or that exceeds a ceiling, is not kept: its entry saves
/// without one, and the reason is logged.
pub(super) fn kept_bookmark_action(
    document: &impl PdfObjectSource,
    action: &Dictionary,
    title: &str,
) -> Option<BookmarkActionValue> {
    let action = Object::Dictionary(action.clone());
    bookmark_action_value(document, &action, 0, &mut { MAX_BOOKMARK_ACTION_SIZE })
        .map_err(|reason| {
            eprintln!(
                "{}",
                serde_json::json!({"level": "warning", "event": "outline_action_not_kept", "title": title, "reason": reason})
            )
        })
        .ok()
}

fn bookmark_action_value<'a>(
    document: &'a impl PdfObjectSource,
    object: &'a Object,
    depth: usize,
    budget: &mut usize,
) -> std::result::Result<BookmarkActionValue, &'static str> {
    use BookmarkActionTag::*;
    if let Object::Reference(_) = object {
        let target = document
            .resolved(object)
            .map_err(|_| "it refers to a missing object")?;
        let kind = target
            .as_dict()
            .and_then(|value| value.get(b"Type")?.as_name());
        if kind.is_ok_and(|kind| kind == b"Page" || kind == b"Pages") {
            return Err("it refers to a page");
        }
        return bookmark_action_value(document, target, depth + 1, budget);
    }
    let own_bytes = match object {
        Object::Name(bytes) | Object::String(bytes, _) => bytes.len(),
        Object::Dictionary(dictionary) => dictionary.iter().map(|(key, _)| key.len()).sum(),
        _ => 0,
    };
    *budget = budget
        .checked_sub(1 + own_bytes)
        .filter(|_| depth <= 16)
        .ok_or("it exceeds the size or nesting ceiling")?;
    let text = |bytes: &[u8]| String::from_utf8(bytes.to_vec()).map_err(|_| "a name is not UTF-8");
    Ok(match object {
        Object::Null => BookmarkActionValue::Null,
        Object::Boolean(value) => BookmarkActionValue::Boolean(*value),
        Object::Integer(value) => BookmarkActionValue::Integer(*value),
        Object::Real(value) => BookmarkActionValue::Tagged(Real(f64::from(*value))),
        Object::Name(name) => BookmarkActionValue::Tagged(Name(text(name)?)),
        Object::String(bytes, StringFormat::Literal) => {
            BookmarkActionValue::Tagged(Literal(bytes.clone()))
        }
        Object::String(bytes, StringFormat::Hexadecimal) => {
            BookmarkActionValue::Tagged(Hex(bytes.clone()))
        }
        Object::Array(items) => BookmarkActionValue::Array(
            items
                .iter()
                .map(|item| bookmark_action_value(document, item, depth + 1, budget))
                .collect::<std::result::Result<_, _>>()?,
        ),
        Object::Dictionary(dictionary) => BookmarkActionValue::Tagged(Dict(
            dictionary
                .iter()
                .map(|(key, value)| {
                    Ok((
                        text(key)?,
                        bookmark_action_value(document, value, depth + 1, budget)?,
                    ))
                })
                .collect::<std::result::Result<_, _>>()?,
        )),
        Object::Stream(_) => return Err("it holds a stream"),
        Object::Reference(_) => unreachable!("references are read in place above"),
    })
}

pub(crate) fn bookmark_action_object(value: &BookmarkActionValue) -> Result<Object> {
    use BookmarkActionTag::*;
    if value.size() > MAX_BOOKMARK_ACTION_SIZE
        || !matches!(value, BookmarkActionValue::Tagged(Dict(_)))
    {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Bookmark action must be a dictionary within the size ceiling",
        ));
    }
    fn object(value: &BookmarkActionValue) -> Result<Object> {
        Ok(match value {
            BookmarkActionValue::Null => Object::Null,
            BookmarkActionValue::Boolean(value) => Object::Boolean(*value),
            BookmarkActionValue::Integer(value) => Object::Integer(*value),
            BookmarkActionValue::Array(items) => {
                Object::Array(items.iter().map(object).collect::<Result<_>>()?)
            }
            BookmarkActionValue::Tagged(Real(value)) if (*value as f32).is_finite() => {
                Object::Real(*value as f32)
            }
            BookmarkActionValue::Tagged(Real(_)) => {
                return Err("Bookmark action number is not finite".into())
            }
            BookmarkActionValue::Tagged(Name(name)) => Object::Name(name.as_bytes().to_vec()),
            BookmarkActionValue::Tagged(Literal(bytes)) => {
                Object::String(bytes.clone(), StringFormat::Literal)
            }
            BookmarkActionValue::Tagged(Hex(bytes)) => {
                Object::String(bytes.clone(), StringFormat::Hexadecimal)
            }
            BookmarkActionValue::Tagged(Dict(entries)) => {
                let mut dictionary = Dictionary::new();
                for (key, value) in entries {
                    dictionary.set(key.as_bytes().to_vec(), object(value)?);
                }
                Object::Dictionary(dictionary)
            }
        })
    }
    object(value)
}
