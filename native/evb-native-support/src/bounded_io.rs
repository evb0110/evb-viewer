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
        T::deserialize(&mut deserializer).and_then(|value| deserializer.end().map(|_| value))
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
        T::deserialize(&mut deserializer).and_then(|value| deserializer.end().map(|_| value))
    };
    let deserialization_code = take_deserialization_error();
    result.map_err(|error| json_error(label, error, None, false, deserialization_code))
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
