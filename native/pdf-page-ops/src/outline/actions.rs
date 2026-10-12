use super::*;

/// Reads a reference-free action within the size and nesting ceilings. Any
/// other action is not kept, so its entry saves without one, as all did before.
pub(super) fn bookmark_action_value(
    object: &Object,
    depth: usize,
    budget: &mut usize,
) -> Option<BookmarkActionValue> {
    use BookmarkActionTag::*;
    let own_bytes = match object {
        Object::Name(bytes) | Object::String(bytes, _) => bytes.len(),
        Object::Dictionary(dictionary) => dictionary.iter().map(|(key, _)| key.len()).sum(),
        _ => 0,
    };
    *budget = budget.checked_sub(1 + own_bytes).filter(|_| depth <= 16)?;
    let text = |bytes: &[u8]| String::from_utf8(bytes.to_vec()).ok();
    Some(match object {
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
                .map(|item| bookmark_action_value(item, depth + 1, budget))
                .collect::<Option<_>>()?,
        ),
        Object::Dictionary(dictionary) => BookmarkActionValue::Tagged(Dict(
            dictionary
                .iter()
                .map(|(key, value)| {
                    Some((text(key)?, bookmark_action_value(value, depth + 1, budget)?))
                })
                .collect::<Option<_>>()?,
        )),
        Object::Reference(_) | Object::Stream(_) => return None,
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
