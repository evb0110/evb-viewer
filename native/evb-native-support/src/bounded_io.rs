use crate::{NativeError, NativeErrorCode};
use serde::{de::DeserializeOwned, de::Error as _, de::SeqAccess, de::Visitor, Deserializer};
use std::{
    cell::Cell,
    fmt,
    fs::File,
    io::{BufReader, Read, Take},
    marker::PhantomData,
    path::Path,
};

const TOO_LARGE_IO_SENTINEL: &str = "evb bounded reader exceeded admission ceiling";

// serde's `Error::custom` can only carry a rendered string, so a visitor that
// rejects input for exceeding an admission ceiling has no way to hand its error
// code to the caller that will build the `NativeError`. Recovering the code by
// matching on the rendered text is what this channel replaces: the message can
// contain document or request content, which made a crafted payload able to
// pick its own error code. The slot is cleared before a parse and taken after
// it, so it only ever describes the parse that just failed.
thread_local! {
    static DESERIALIZATION_ERROR_CODE: Cell<Option<NativeErrorCode>> = const { Cell::new(None) };
}

pub fn record_deserialization_error(code: NativeErrorCode) {
    DESERIALIZATION_ERROR_CODE.with(|slot| {
        if slot.get().is_none() {
            slot.set(Some(code));
        }
    });
}

pub fn take_deserialization_error() -> Option<NativeErrorCode> {
    DESERIALIZATION_ERROR_CODE.with(|slot| slot.take())
}

pub fn clear_deserialization_error() {
    DESERIALIZATION_ERROR_CODE.with(|slot| slot.set(None));
}

fn io_error(label: &str, error: std::io::Error) -> NativeError {
    NativeError::new(
        NativeErrorCode::Io,
        format!("Unable to read {label}: {error}"),
    )
}

fn too_large(label: &str, max_bytes: usize) -> NativeError {
    NativeError::new(
        NativeErrorCode::TooLarge,
        format!("{label} exceeds the {max_bytes}-byte admission ceiling"),
    )
}

pub fn read_file_bounded(
    path: &Path,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, NativeError> {
    let file = File::open(path).map_err(|error| io_error(label, error))?;
    read_open_file_bounded(file, max_bytes, label)
}

pub fn read_open_file_bounded(
    file: File,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, NativeError> {
    let length = file
        .metadata()
        .map_err(|error| io_error(label, error))?
        .len();
    if length > max_bytes as u64 {
        return Err(too_large(label, max_bytes));
    }

    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length as usize)
        .map_err(|_| too_large(label, max_bytes))?;
    file.take((max_bytes as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(label, error))?;
    if bytes.len() > max_bytes {
        return Err(too_large(label, max_bytes));
    }
    Ok(bytes)
}

pub fn deserialize_json_file_bounded<T: DeserializeOwned>(
    path: &Path,
    max_bytes: usize,
    label: &str,
) -> Result<T, NativeError> {
    clear_deserialization_error();
    let file = File::open(path).map_err(|error| io_error(label, error))?;
    let length = file
        .metadata()
        .map_err(|error| io_error(label, error))?
        .len();
    if length > max_bytes as u64 {
        return Err(too_large(label, max_bytes));
    }
    let mut reader = AdmissionReader {
        inner: BufReader::new(file).take((max_bytes as u64).saturating_add(1)),
        remaining: max_bytes,
        ceiling_hit: false,
    };
    let result = {
        let mut deserializer = serde_json::Deserializer::from_reader(&mut reader);
        // Typed recursive visitors admit depth before entering the next level.
        deserializer.disable_recursion_limit();
        T::deserialize(JsonDepthDeserializer {
            inner: &mut deserializer,
            depth: 0,
        })
        .and_then(|value| deserializer.end().map(|_| value))
    };
    let ceiling_hit = reader.ceiling_hit;
    let deserialization_code = take_deserialization_error();
    result.map_err(|error| {
        json_error(
            label,
            error,
            Some(max_bytes),
            ceiling_hit,
            deserialization_code,
        )
    })
}

pub fn deserialize_json_slice<T: DeserializeOwned>(
    bytes: &[u8],
    label: &str,
) -> Result<T, NativeError> {
    clear_deserialization_error();
    let result = {
        let mut deserializer = serde_json::Deserializer::from_slice(bytes);
        // Typed recursive visitors admit depth before entering the next level.
        deserializer.disable_recursion_limit();
        T::deserialize(JsonDepthDeserializer {
            inner: &mut deserializer,
            depth: 0,
        })
        .and_then(|value| deserializer.end().map(|_| value))
    };
    let deserialization_code = take_deserialization_error();
    result.map_err(|error| json_error(label, error, None, false, deserialization_code))
}

// Each bookmark level has one object and one items array. The request,
// metadata, envelope and original destination add at most six containers.
// Keep generic callers bounded too: an untagged scalar can buffer Content
// before its typed visitor sees an invalid nested object.
const MAX_JSON_DEPTH: usize = 2 * crate::pdf_catalog::MAX_BOOKMARK_DEPTH + 6;

struct JsonDepthDeserializer<D> {
    inner: D,
    depth: usize,
}
struct JsonDepthVisitor<V> {
    inner: V,
    depth: usize,
}
struct JsonDepthSeed<S> {
    inner: S,
    depth: usize,
}
struct JsonDepthAccess<A> {
    inner: A,
    depth: usize,
}

fn admit_json_depth<E: serde::de::Error>(depth: usize) -> Result<(), E> {
    if depth >= MAX_JSON_DEPTH {
        record_deserialization_error(NativeErrorCode::TooLarge);
        return Err(E::custom(format!(
            "JSON exceeds the {MAX_JSON_DEPTH}-container admission ceiling"
        )));
    }
    Ok(())
}

macro_rules! depth_deserialize {
    ($($method:ident $(($($argument:ident: $argument_type:ty),*))?),* $(,)?) => {
        $(fn $method<V: Visitor<'de>>(self, $($($argument: $argument_type,)*)? visitor: V) -> Result<V::Value, D::Error> {
            self.inner.$method($($($argument,)*)? JsonDepthVisitor { inner: visitor, depth: self.depth })
        })*
    };
}

impl<'de, D: Deserializer<'de>> Deserializer<'de> for JsonDepthDeserializer<D> {
    type Error = D::Error;
    depth_deserialize! {
        deserialize_any, deserialize_bool, deserialize_i8, deserialize_i16,
        deserialize_i32, deserialize_i64, deserialize_i128, deserialize_u8,
        deserialize_u16, deserialize_u32, deserialize_u64, deserialize_u128,
        deserialize_f32, deserialize_f64, deserialize_char, deserialize_str,
        deserialize_string, deserialize_bytes, deserialize_byte_buf,
        deserialize_option, deserialize_unit, deserialize_seq, deserialize_map,
        deserialize_identifier, deserialize_ignored_any,
        deserialize_unit_struct(name: &'static str),
        deserialize_newtype_struct(name: &'static str),
        deserialize_tuple(len: usize),
        deserialize_tuple_struct(name: &'static str, len: usize),
        deserialize_struct(name: &'static str, fields: &'static [&'static str]),
        deserialize_enum(name: &'static str, variants: &'static [&'static str]),
    }
    fn is_human_readable(&self) -> bool {
        self.inner.is_human_readable()
    }
}

impl<'de, S: serde::de::DeserializeSeed<'de>> serde::de::DeserializeSeed<'de> for JsonDepthSeed<S> {
    type Value = S::Value;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        self.inner.deserialize(JsonDepthDeserializer {
            inner: deserializer,
            depth: self.depth,
        })
    }
}

macro_rules! depth_visit {
    ($($method:ident($value_type:ty)),* $(,)?) => {
        $(fn $method<E: serde::de::Error>(self, value: $value_type) -> Result<Self::Value, E> {
            self.inner.$method(value)
        })*
    };
}

impl<'de, V: Visitor<'de>> Visitor<'de> for JsonDepthVisitor<V> {
    type Value = V::Value;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.inner.expecting(formatter)
    }
    depth_visit! {
        visit_bool(bool), visit_i8(i8), visit_i16(i16), visit_i32(i32),
        visit_i64(i64), visit_i128(i128), visit_u8(u8), visit_u16(u16),
        visit_u32(u32), visit_u64(u64), visit_u128(u128), visit_f32(f32),
        visit_f64(f64), visit_char(char), visit_str(&str),
        visit_borrowed_str(&'de str), visit_string(String), visit_bytes(&[u8]),
        visit_borrowed_bytes(&'de [u8]), visit_byte_buf(Vec<u8>),
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        self.inner.visit_unit()
    }
    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        self.inner.visit_none()
    }
    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        self.inner.visit_some(JsonDepthDeserializer {
            inner: deserializer,
            depth: self.depth,
        })
    }
    fn visit_newtype_struct<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        self.inner.visit_newtype_struct(JsonDepthDeserializer {
            inner: deserializer,
            depth: self.depth,
        })
    }
    fn visit_seq<A: SeqAccess<'de>>(self, sequence: A) -> Result<Self::Value, A::Error> {
        admit_json_depth(self.depth)?;
        self.inner.visit_seq(JsonDepthAccess {
            inner: sequence,
            depth: self.depth + 1,
        })
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
        admit_json_depth(self.depth)?;
        self.inner.visit_map(JsonDepthAccess {
            inner: map,
            depth: self.depth + 1,
        })
    }
    fn visit_enum<A: serde::de::EnumAccess<'de>>(
        self,
        enumeration: A,
    ) -> Result<Self::Value, A::Error> {
        admit_json_depth(self.depth)?;
        self.inner.visit_enum(JsonDepthAccess {
            inner: enumeration,
            depth: self.depth + 1,
        })
    }
}

impl<'de, A: SeqAccess<'de>> SeqAccess<'de> for JsonDepthAccess<A> {
    type Error = A::Error;
    fn next_element_seed<T: serde::de::DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> Result<Option<T::Value>, Self::Error> {
        self.inner.next_element_seed(JsonDepthSeed {
            inner: seed,
            depth: self.depth,
        })
    }
    fn size_hint(&self) -> Option<usize> {
        self.inner.size_hint()
    }
}
impl<'de, A: serde::de::MapAccess<'de>> serde::de::MapAccess<'de> for JsonDepthAccess<A> {
    type Error = A::Error;
    fn next_key_seed<K: serde::de::DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Self::Error> {
        self.inner.next_key_seed(JsonDepthSeed {
            inner: seed,
            depth: self.depth,
        })
    }
    fn next_value_seed<V: serde::de::DeserializeSeed<'de>>(
        &mut self,
        seed: V,
    ) -> Result<V::Value, Self::Error> {
        self.inner.next_value_seed(JsonDepthSeed {
            inner: seed,
            depth: self.depth,
        })
    }
    fn size_hint(&self) -> Option<usize> {
        self.inner.size_hint()
    }
}
impl<'de, A: serde::de::EnumAccess<'de>> serde::de::EnumAccess<'de> for JsonDepthAccess<A> {
    type Error = A::Error;
    type Variant = JsonDepthAccess<A::Variant>;
    fn variant_seed<V: serde::de::DeserializeSeed<'de>>(
        self,
        seed: V,
    ) -> Result<(V::Value, Self::Variant), Self::Error> {
        let (value, variant) = self.inner.variant_seed(JsonDepthSeed {
            inner: seed,
            depth: self.depth,
        })?;
        Ok((
            value,
            JsonDepthAccess {
                inner: variant,
                depth: self.depth,
            },
        ))
    }
}
impl<'de, A: serde::de::VariantAccess<'de>> serde::de::VariantAccess<'de> for JsonDepthAccess<A> {
    type Error = A::Error;
    fn unit_variant(self) -> Result<(), Self::Error> {
        self.inner.unit_variant()
    }
    fn newtype_variant_seed<T: serde::de::DeserializeSeed<'de>>(
        self,
        seed: T,
    ) -> Result<T::Value, Self::Error> {
        self.inner.newtype_variant_seed(JsonDepthSeed {
            inner: seed,
            depth: self.depth,
        })
    }
    fn tuple_variant<V: Visitor<'de>>(
        self,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.inner.tuple_variant(
            len,
            JsonDepthVisitor {
                inner: visitor,
                depth: self.depth,
            },
        )
    }
    fn struct_variant<V: Visitor<'de>>(
        self,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        self.inner.struct_variant(
            fields,
            JsonDepthVisitor {
                inner: visitor,
                depth: self.depth,
            },
        )
    }
}

fn json_error(
    label: &str,
    error: serde_json::Error,
    max_bytes: Option<usize>,
    ceiling_hit: bool,
    deserialization_code: Option<NativeErrorCode>,
) -> NativeError {
    let message = error.to_string();
    if ceiling_hit {
        if let Some(max_bytes) = max_bytes {
            return too_large(label, max_bytes);
        }
    }
    let code = deserialization_code.unwrap_or(NativeErrorCode::InvalidRequest);
    NativeError::new(code, format!("Invalid {label}: {message}"))
}

struct AdmissionReader {
    inner: Take<BufReader<File>>,
    remaining: usize,
    ceiling_hit: bool,
}

impl Read for AdmissionReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let probe_len = self.remaining.saturating_add(1).min(buffer.len());
        let count = self.inner.read(&mut buffer[..probe_len])?;
        if count > self.remaining {
            self.ceiling_hit = true;
            return Err(std::io::Error::other(TOO_LARGE_IO_SENTINEL));
        }
        self.remaining -= count;
        Ok(count)
    }
}

pub fn deserialize_bounded_vec<'de, D, T, const MAX_ITEMS: usize>(
    deserializer: D,
) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    struct BoundedVecVisitor<T, const MAX_ITEMS: usize>(PhantomData<T>);

    impl<'de, T, const MAX_ITEMS: usize> Visitor<'de> for BoundedVecVisitor<T, MAX_ITEMS>
    where
        T: serde::Deserialize<'de>,
    {
        type Value = Vec<T>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "an array containing at most {MAX_ITEMS} items")
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let capacity = sequence.size_hint().unwrap_or(0).min(MAX_ITEMS);
            let mut values = Vec::with_capacity(capacity);
            while let Some(value) = sequence.next_element()? {
                if values.len() == MAX_ITEMS {
                    record_deserialization_error(NativeErrorCode::TooLarge);
                    return Err(A::Error::custom(format!(
                        "array exceeds the {MAX_ITEMS}-item admission ceiling"
                    )));
                }
                values.push(value);
            }
            Ok(values)
        }
    }

    deserializer.deserialize_seq(BoundedVecVisitor::<T, MAX_ITEMS>(PhantomData))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::{fs, time::SystemTime};

    fn temp_path(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "evb-bounded-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn bounded_read_accepts_exact_limit_and_rejects_one_byte_over() {
        let path = temp_path("read");
        fs::write(&path, b"1234").unwrap();
        assert_eq!(read_file_bounded(&path, 4, "test input").unwrap(), b"1234");

        let error = read_file_bounded(&path, 3, "test input").unwrap_err();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(error.message.contains("3-byte"));
        fs::remove_file(path).unwrap();
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct Envelope {
        #[serde(deserialize_with = "bounded_values")]
        values: Vec<u8>,
    }

    fn bounded_values<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserialize_bounded_vec::<D, u8, 2>(deserializer)
    }

    #[test]
    fn json_reader_rejects_trailing_data_and_collections_during_deserialization() {
        let path = temp_path("json");
        fs::write(&path, br#"{"values":[1,2]}  "#).unwrap();
        assert_eq!(
            deserialize_json_file_bounded::<Envelope>(&path, 64, "test JSON").unwrap(),
            Envelope { values: vec![1, 2] }
        );

        fs::write(&path, br#"{"values":[1,2,3]}"#).unwrap();
        let error = deserialize_json_file_bounded::<Envelope>(&path, 64, "test JSON").unwrap_err();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(error.message.contains("2-item admission ceiling"));

        fs::write(&path, br#"{"values":[1]} {}"#).unwrap();
        assert_eq!(
            deserialize_json_file_bounded::<Envelope>(&path, 64, "test JSON")
                .unwrap_err()
                .code,
            NativeErrorCode::InvalidRequest
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn untagged_values_are_refused_before_they_can_buffer_unbounded_nesting() {
        #[derive(Debug, Deserialize)]
        #[serde(untagged)]
        enum Scalar {
            Number(u16),
            Legacy(String),
        }
        let nested = format!("{}0{}", "[".repeat(100_000), "]".repeat(100_000));
        let error = deserialize_json_slice::<Scalar>(nested.as_bytes(), "scalar").unwrap_err();
        assert_eq!(error.code, NativeErrorCode::TooLarge);
        assert!(error.message.contains("container admission ceiling"));
        for source in ["90", "\"90\""] {
            match deserialize_json_slice::<Scalar>(source.as_bytes(), "scalar").unwrap() {
                Scalar::Number(value) => assert_eq!(value, 90),
                Scalar::Legacy(value) => assert_eq!(value, "90"),
            }
        }
    }

    #[test]
    fn json_slice_treats_reader_sentinel_in_input_as_invalid_request() {
        let error = deserialize_json_slice::<Envelope>(
            br#"{"values":"evb bounded reader exceeded admission ceiling"}"#,
            "test JSON",
        )
        .unwrap_err();

        assert_eq!(error.code, NativeErrorCode::InvalidRequest);
    }

    #[derive(Debug, Deserialize)]
    struct UserMessage {
        #[serde(deserialize_with = "reject_with_user_message")]
        #[serde(rename = "value")]
        _value: String,
    }

    fn reject_with_user_message<'de, D>(deserializer: D) -> Result<String, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Err(D::Error::custom(format!(
            "request value {value} mentions the admission ceiling"
        )))
    }

    #[test]
    fn json_slice_does_not_classify_custom_user_messages_as_too_large() {
        let error = deserialize_json_slice::<UserMessage>(br#"{"value":"crafted"}"#, "test JSON")
            .unwrap_err();

        assert_eq!(error.code, NativeErrorCode::InvalidRequest);
    }
}
