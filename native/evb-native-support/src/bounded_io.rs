use crate::{NativeError, NativeErrorCode};
use serde::{de::DeserializeOwned, de::Error as _, de::SeqAccess, de::Visitor, Deserializer};
use std::{
    fmt,
    fs::File,
    io::{BufReader, Read, Take},
    marker::PhantomData,
    path::Path,
};

const TOO_LARGE_IO_SENTINEL: &str = "evb bounded reader exceeded admission ceiling";

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
    result.map_err(|error| json_error(label, error, Some(max_bytes), ceiling_hit))
}

pub fn deserialize_json_slice<T: DeserializeOwned>(
    bytes: &[u8],
    label: &str,
) -> Result<T, NativeError> {
    let result = {
        let mut deserializer = serde_json::Deserializer::from_slice(bytes);
        T::deserialize(&mut deserializer).and_then(|value| deserializer.end().map(|_| value))
    };
    result.map_err(|error| json_error(label, error, None, false))
}

fn json_error(
    label: &str,
    error: serde_json::Error,
    max_bytes: Option<usize>,
    ceiling_hit: bool,
) -> NativeError {
    let message = error.to_string();
    if ceiling_hit {
        if let Some(max_bytes) = max_bytes {
            return too_large(label, max_bytes);
        }
    }
    // Nested ceilings (bounded vectors, bookmark depth, markup geometry, manifest
    // paths) are plain serde custom errors with no typed channel, so they still have
    // to be recognised by text. A payload can carry the same words, but serde only
    // ever renders untrusted input inside quotes, so a quote ahead of the phrase
    // means the caller wrote it rather than a ceiling firing.
    let ceiling_phrase = message.find("admission ceiling");
    let code = match ceiling_phrase {
        Some(index) if !message[..index].contains('"') => NativeErrorCode::TooLarge,
        _ => NativeErrorCode::InvalidRequest,
    };
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
}
