use super::*;
use serde::de::{self, MapAccess, Visitor};
use serde_json::{value::RawValue, Value};
use std::{
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_QPDF_STRUCTURE_BYTES: usize = 512 * 1024 * 1024;
const MAX_QPDF_RETAINED_STRUCTURE_BYTES: usize = 256 * 1024 * 1024;
const MAX_QPDF_OBJECT_BYTES: usize = 64 * 1024 * 1024;
const MAX_QPDF_OBJECT_ELEMENTS: usize = 1_000_000;
const QPDF_ESTIMATED_BYTES_PER_VALUE: usize = 64;
const MAX_QPDF_NEW_OBJECT_HEADROOM: u32 = 1_000_000;
const MAX_QPDF_DIAGNOSTIC_BYTES: usize = 1024 * 1024;
const QPDF_STRUCTURE_TIMEOUT: Duration = Duration::from_secs(110);
const QPDF_STALE_FILE_AGE: Duration = Duration::from_secs(10 * 60);
const QPDF_TEMP_PREFIX: &str = "evb-qpdf-structure-";
static QPDF_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
// Keep this argument set compatible with the oldest qpdf shipped by the
// supported Linux packaging image. qpdf 10 rejects the newer
// --decode-level/--json-stream-data options; the JSON object section already
// omits stream bytes in the qpdf 10 and qpdf 12 formats we parse below.
const QPDF_STRUCTURE_ARGS: &[&str] = &["--suppress-recovery", "--json", "--"];

#[derive(Debug, Clone)]
pub(crate) struct IncrementalDocument {
    previous_len: u64,
    previous_last_byte: Option<u8>,
    pub(crate) previous_document: Document,
    unavailable_base_streams: HashSet<ObjectId>,
    pub(crate) new_document: Document,
}

impl IncrementalDocument {
    pub(crate) fn from_document(
        document: Document,
        previous_len: u64,
        previous_last_byte: Option<u8>,
    ) -> Self {
        let new_document = Document::new_from_prev(&document);
        Self {
            previous_len,
            previous_last_byte,
            previous_document: document,
            unavailable_base_streams: HashSet::new(),
            new_document,
        }
    }

    #[cfg(test)]
    pub(crate) fn load(path: &Path) -> Result<Self> {
        let document = Document::load(path)?;
        let metadata = fs::metadata(path)?;
        let previous_last_byte = read_last_byte(path, metadata.len())?;
        Ok(Self::from_document(
            document,
            metadata.len(),
            previous_last_byte,
        ))
    }

    pub(crate) fn get_prev_documents(&self) -> &Document {
        &self.previous_document
    }

    pub(crate) fn previous_len(&self) -> u64 {
        self.previous_len
    }

    pub(crate) fn previous_last_byte(&self) -> Option<u8> {
        self.previous_last_byte
    }

    pub(crate) fn opt_clone_object_to_new_document(&mut self, object_id: ObjectId) -> Result<()> {
        if self.new_document.has_object(object_id) {
            return Ok(());
        }
        if self.unavailable_base_streams.contains(&object_id) {
            return Err(format!(
                "Cannot rewrite unavailable base stream object {} {}",
                object_id.0, object_id.1
            )
            .into());
        }
        let old_object = self.previous_document.get_object(object_id)?;
        self.new_document.set_object(object_id, old_object.clone());
        Ok(())
    }
}

struct TempQpdfFiles {
    structure: PathBuf,
    diagnostics: PathBuf,
}

impl TempQpdfFiles {
    fn create() -> Result<Self> {
        remove_stale_qpdf_files(&std::env::temp_dir(), SystemTime::now());
        let nonce = qpdf_temp_nonce()?;
        let stem = format!("{QPDF_TEMP_PREFIX}{nonce}");
        Ok(Self {
            structure: std::env::temp_dir().join(format!("{stem}.json")),
            diagnostics: std::env::temp_dir().join(format!("{stem}.stderr")),
        })
    }
}

fn qpdf_temp_nonce() -> Result<String> {
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let sequence = QPDF_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(format!("{}-{timestamp}-{sequence}", std::process::id()))
}

fn remove_stale_qpdf_files(directory: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(QPDF_TEMP_PREFIX)
            || !(name.ends_with(".json") || name.ends_with(".stderr"))
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let is_stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= QPDF_STALE_FILE_AGE);
        if metadata.is_file() && is_stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

impl Drop for TempQpdfFiles {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.structure);
        let _ = fs::remove_file(&self.diagnostics);
    }
}

pub(crate) fn load_qpdf_structural_incremental_pdf(
    path: &Path,
    qpdf_path: &Path,
) -> Result<IncrementalDocument> {
    let initial_metadata = fs::metadata(path).map_err(io_domain_error)?;
    let previous_len = initial_metadata.len();
    if previous_len == 0 {
        return Err(domain_error(
            NativeErrorCode::CorruptXref,
            "PDF input is empty",
        ));
    }
    let temp = TempQpdfFiles::create()?;
    let structure_output = create_private_temp_file(&temp.structure)?;
    let diagnostic_output = create_private_temp_file(&temp.diagnostics)?;
    let mut child = Command::new(qpdf_path)
        .args(QPDF_STRUCTURE_ARGS)
        .arg(path)
        .stdout(Stdio::from(structure_output))
        .stderr(Stdio::from(diagnostic_output))
        .spawn()
        .map_err(io_domain_error)?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(io_domain_error)? {
            break status;
        }
        if started.elapsed() > QPDF_STRUCTURE_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "qpdf structural parsing exceeded the 110-second resource limit",
            ));
        }
        if fs::metadata(&temp.structure)
            .map(|metadata| metadata.len() > MAX_QPDF_STRUCTURE_BYTES as u64)
            .unwrap_or(false)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!(
                    "qpdf structural output exceeds the {MAX_QPDF_STRUCTURE_BYTES}-byte resource limit"
                ),
            ));
        }
        if fs::metadata(&temp.diagnostics)
            .map(|metadata| metadata.len() > MAX_QPDF_DIAGNOSTIC_BYTES as u64)
            .unwrap_or(false)
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "qpdf diagnostics exceeded the 1048576-byte resource limit",
            ));
        }
        thread::sleep(Duration::from_millis(25));
    };
    // qpdf uses exit code 3 for warnings that did not prevent JSON generation.
    // Keep that output on the normal bounded parse and structural-validation
    // path. Any malformed or incomplete JSON still fails below; only a clean
    // exit or qpdf's warning-only exit may reach the structural loader.
    if !status.success() && status.code() != Some(3) {
        let diagnostics = read_file_bounded(
            &temp.diagnostics,
            MAX_QPDF_DIAGNOSTIC_BYTES,
            "qpdf diagnostics",
        )
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .unwrap_or_else(|error| error.to_string());
        return Err(domain_error(
            NativeErrorCode::CorruptXref,
            if diagnostics.is_empty() {
                format!("qpdf structural parsing failed with status {status}")
            } else {
                format!("qpdf structural parsing failed: {diagnostics}")
            },
        ));
    }

    let (mut document, unavailable_base_streams) =
        parse_qpdf_structure(&temp.structure, Some(path))?;
    let (previous_xref_start, xref_type) = read_terminal_xref(path, previous_len)?;
    document.xref_start = usize::try_from(previous_xref_start)
        .map_err(|_| "Previous PDF xref offset exceeds this platform's address space")?;
    document.reference_table = lopdf::xref::Xref::new(document.max_id.saturating_add(1), xref_type);
    let current_metadata = fs::metadata(path).map_err(io_domain_error)?;
    if current_metadata.len() != previous_len
        || current_metadata.modified().ok() != initial_metadata.modified().ok()
    {
        return Err("PDF input changed while qpdf was reading its structure".into());
    }
    let previous_last_byte = read_last_byte(path, previous_len)?;
    let new_document = Document::new_from_prev(&document);
    Ok(IncrementalDocument {
        previous_len,
        previous_last_byte,
        previous_document: document,
        unavailable_base_streams,
        new_document,
    })
}

fn create_private_temp_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io_domain_error)
}

enum QpdfRoot {
    V2(QpdfRootV2),
    V1(QpdfRootV1),
}

#[derive(Deserialize)]
struct QpdfRootV2 {
    qpdf: (QpdfMetadata, QpdfObjects),
}

#[derive(Deserialize)]
struct QpdfRootV1 {
    version: u64,
    objects: QpdfLegacyObjects,
}

impl<'de> Deserialize<'de> for QpdfRoot {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct QpdfRootVisitor;

        impl<'de> Visitor<'de> for QpdfRootVisitor {
            type Value = QpdfRoot;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("qpdf JSON version 1 or 2")
            }

            fn visit_map<M>(self, mut map: M) -> std::result::Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut qpdf = None;
                let mut version = None;
                let mut objects = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "qpdf" => {
                            if qpdf.is_some() {
                                return Err(de::Error::duplicate_field("qpdf"));
                            }
                            qpdf = Some(map.next_value::<(QpdfMetadata, QpdfObjects)>()?);
                        }
                        "version" => {
                            if version.is_some() {
                                return Err(de::Error::duplicate_field("version"));
                            }
                            version = Some(map.next_value::<u64>()?);
                        }
                        "objects" => {
                            if objects.is_some() {
                                return Err(de::Error::duplicate_field("objects"));
                            }
                            objects = Some(map.next_value::<QpdfLegacyObjects>()?);
                        }
                        _ => {
                            let _: serde::de::IgnoredAny = map.next_value()?;
                        }
                    }
                }
                if let Some(qpdf) = qpdf {
                    return Ok(QpdfRoot::V2(QpdfRootV2 { qpdf }));
                }
                if let (Some(version), Some(objects)) = (version, objects) {
                    return Ok(QpdfRoot::V1(QpdfRootV1 { version, objects }));
                }
                Err(de::Error::custom(
                    "qpdf JSON is missing its versioned object section",
                ))
            }
        }

        deserializer.deserialize_map(QpdfRootVisitor)
    }
}

#[derive(Deserialize)]
struct QpdfMetadata {
    jsonversion: u64,
    pdfversion: String,
    maxobjectid: u64,
}

struct QpdfObjects {
    document: Document,
    unavailable_base_streams: HashSet<ObjectId>,
}

struct QpdfLegacyObjects(QpdfObjects);

impl<'de> Deserialize<'de> for QpdfObjects {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserialize_qpdf_objects(deserializer, false)
    }
}

impl<'de> Deserialize<'de> for QpdfLegacyObjects {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserialize_qpdf_objects(deserializer, true).map(Self)
    }
}

fn deserialize_qpdf_objects<'de, D>(
    deserializer: D,
    allow_legacy_encoding: bool,
) -> std::result::Result<QpdfObjects, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct QpdfObjectsVisitor {
        allow_legacy_encoding: bool,
    }

    impl<'de> Visitor<'de> for QpdfObjectsVisitor {
        type Value = QpdfObjects;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a qpdf JSON object section")
        }

        fn visit_map<M>(self, mut map: M) -> std::result::Result<Self::Value, M::Error>
        where
            M: MapAccess<'de>,
        {
            let mut document = Document::with_version("1.7");
            let mut unavailable_base_streams = HashSet::new();
            let mut trailer_seen = false;
            let mut retained_structure_cost = 0_usize;
            while let Some((key, raw_envelope)) = map.next_entry::<String, Box<RawValue>>()? {
                let object_bytes =
                    key.len()
                        .checked_add(raw_envelope.get().len())
                        .ok_or_else(|| {
                            de::Error::custom("resource-limit: qpdf object size overflow")
                        })?;
                if object_bytes > MAX_QPDF_OBJECT_BYTES {
                    return Err(de::Error::custom(format!(
                        "resource-limit: qpdf object exceeds the {MAX_QPDF_OBJECT_BYTES}-byte resource limit"
                    )));
                }
                let envelope: Value =
                    serde_json::from_str(raw_envelope.get()).map_err(de::Error::custom)?;
                let Some(envelope_cost) =
                    qpdf_value_retained_cost(&envelope, MAX_QPDF_OBJECT_ELEMENTS)
                else {
                    return Err(de::Error::custom(format!(
                        "resource-limit: qpdf object exceeds the {MAX_QPDF_OBJECT_ELEMENTS}-element resource limit"
                    )));
                };
                retained_structure_cost = retained_structure_cost
                    .checked_add(key.len())
                    .and_then(|cost| cost.checked_add(envelope_cost))
                    .ok_or_else(|| {
                        de::Error::custom("resource-limit: qpdf structural size overflow")
                    })?;
                if retained_structure_cost > MAX_QPDF_RETAINED_STRUCTURE_BYTES {
                    return Err(de::Error::custom(format!(
                        "resource-limit: retained qpdf structure exceeds the {MAX_QPDF_RETAINED_STRUCTURE_BYTES}-byte estimated memory limit"
                    )));
                }
                if key == "trailer" {
                    if trailer_seen {
                        return Err(de::Error::custom("qpdf JSON contains two trailers"));
                    }
                    let value = if self.allow_legacy_encoding {
                        &envelope
                    } else {
                        envelope
                            .get("value")
                            .ok_or_else(|| de::Error::custom("qpdf trailer is missing its value"))?
                    };
                    document.trailer = qpdf_dictionary_with_mode(value, self.allow_legacy_encoding)
                        .map_err(de::Error::custom)?;
                    trailer_seen = true;
                    continue;
                }
                if document.objects.len() == 1_000_000 {
                    return Err(de::Error::custom(
                        "resource-limit: qpdf structural output exceeds the 1000000-object resource limit",
                    ));
                }
                let object_id = parse_qpdf_object_key(&key, self.allow_legacy_encoding)
                    .map_err(de::Error::custom)?;
                if document.objects.contains_key(&object_id) {
                    return Err(de::Error::custom(format!(
                        "qpdf JSON repeats object {} {}",
                        object_id.0, object_id.1
                    )));
                }
                let object = if let Some(value) = envelope.get("value") {
                    qpdf_object(value).map_err(de::Error::custom)?
                } else if let Some(stream) = envelope.get("stream") {
                    let dict = stream.get("dict").ok_or_else(|| {
                        de::Error::custom(format!(
                            "qpdf stream object {} {} is missing its dictionary",
                            object_id.0, object_id.1
                        ))
                    })?;
                    unavailable_base_streams.insert(object_id);
                    Object::Stream(Stream::with_position(
                        qpdf_dictionary(dict).map_err(de::Error::custom)?,
                        0,
                    ))
                } else if self.allow_legacy_encoding {
                    let is_stream = envelope
                        .as_object()
                        .is_some_and(|values| values.contains_key("/Length"));
                    if is_stream {
                        unavailable_base_streams.insert(object_id);
                        Object::Stream(Stream::with_position(
                            qpdf_dictionary_with_mode(&envelope, true)
                                .map_err(de::Error::custom)?,
                            0,
                        ))
                    } else {
                        qpdf_object_with_mode(&envelope, true).map_err(de::Error::custom)?
                    }
                } else {
                    return Err(de::Error::custom(format!(
                        "qpdf object {key} has no value or stream"
                    )));
                };
                document.objects.insert(object_id, object);
            }
            if !trailer_seen {
                return Err(de::Error::custom("qpdf JSON is missing its trailer"));
            }
            Ok(QpdfObjects {
                document,
                unavailable_base_streams,
            })
        }
    }

    deserializer.deserialize_map(QpdfObjectsVisitor {
        allow_legacy_encoding,
    })
}

fn qpdf_value_retained_cost(value: &Value, element_limit: usize) -> Option<usize> {
    let mut pending = vec![value];
    let mut count = 0_usize;
    let mut estimated_bytes = 0_usize;
    while let Some(value) = pending.pop() {
        count = count.checked_add(1)?;
        if count > element_limit {
            return None;
        }
        estimated_bytes = estimated_bytes.checked_add(QPDF_ESTIMATED_BYTES_PER_VALUE)?;
        match value {
            Value::Array(values) => pending.extend(values),
            Value::Object(values) => {
                for (key, value) in values {
                    estimated_bytes = estimated_bytes.checked_add(key.len())?;
                    pending.push(value);
                }
            }
            Value::String(value) => {
                estimated_bytes = estimated_bytes.checked_add(value.len())?;
            }
            _ => {}
        }
    }
    Some(estimated_bytes)
}

fn parse_qpdf_structure(
    path: &Path,
    source_pdf_path: Option<&Path>,
) -> Result<(Document, HashSet<ObjectId>)> {
    let file = File::open(path).map_err(io_domain_error)?;
    if file.metadata().map_err(io_domain_error)?.len() > MAX_QPDF_STRUCTURE_BYTES as u64 {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!(
                "qpdf structural output exceeds the {MAX_QPDF_STRUCTURE_BYTES}-byte resource limit"
            ),
        ));
    }
    let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
    let root = QpdfRoot::deserialize(&mut deserializer).map_err(|error| {
        if error.to_string().contains("resource-limit:") {
            domain_error(
                NativeErrorCode::TooLarge,
                error.to_string().replace("resource-limit: ", ""),
            )
        } else {
            Box::new(error)
        }
    })?;
    deserializer.end()?;
    let (mut document, unavailable_base_streams, max_id, pdf_version) = match root {
        QpdfRoot::V2(QpdfRootV2 {
            qpdf: (metadata, objects),
        }) => {
            if metadata.jsonversion != 2 {
                return Err("qpdf JSON version is not 2".into());
            }
            let max_id = checked_qpdf_max_id(metadata.maxobjectid)?;
            let QpdfObjects {
                document,
                unavailable_base_streams,
            } = objects;
            (
                document,
                unavailable_base_streams,
                max_id,
                metadata.pdfversion,
            )
        }
        QpdfRoot::V1(QpdfRootV1 { version, objects }) => {
            if version != 1 {
                return Err("qpdf JSON version is not 1 or 2".into());
            }
            let QpdfObjects {
                document,
                unavailable_base_streams,
            } = objects.0;
            let parsed_max_id = max_qpdf_object_id(&document)?;
            let trailer_size = document
                .trailer
                .get(b"Size")
                .map_err(|_| "qpdf legacy JSON trailer is missing /Size")?
                .as_i64()
                .map_err(|_| "qpdf legacy JSON trailer /Size is not an integer")?;
            if trailer_size <= 0 {
                return Err("qpdf legacy JSON trailer /Size must be positive".into());
            }
            let trailer_max_id = u64::try_from(trailer_size - 1)
                .map_err(|_| "qpdf legacy JSON trailer /Size is invalid")?;
            if trailer_max_id < u64::from(parsed_max_id) {
                return Err(
                    "qpdf legacy JSON trailer /Size is lower than a returned object number".into(),
                );
            }
            let max_id = checked_qpdf_max_id(trailer_max_id)?;
            let source_pdf_path =
                source_pdf_path.ok_or("qpdf legacy JSON requires the source PDF path")?;
            let pdf_version = read_pdf_version(source_pdf_path)?;
            (document, unavailable_base_streams, max_id, pdf_version)
        }
    };
    if document
        .objects
        .keys()
        .any(|object_id| object_id.0 > max_id)
    {
        return Err("qpdf maxobjectid is lower than a returned object number".into());
    }
    document.version = pdf_version;
    document.max_id = max_id;
    if document.trailer.get(b"Root").is_err() {
        return Err("qpdf trailer is missing /Root".into());
    }
    Ok((document, unavailable_base_streams))
}

fn max_qpdf_object_id(document: &Document) -> Result<u32> {
    let max_id = document
        .objects
        .keys()
        .map(|object_id| u64::from(object_id.0))
        .max()
        .unwrap_or(0);
    checked_qpdf_max_id(max_id)
}

fn read_pdf_version(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(io_domain_error)?;
    let mut header = [0_u8; 1024];
    let bytes_read = file.read(&mut header).map_err(io_domain_error)?;
    let header = &header[..bytes_read];
    let marker = b"%PDF-";
    let start = header
        .windows(marker.len())
        .position(|window| window == marker)
        .ok_or("PDF header is missing its version marker")?;
    let version = header
        .get(start + marker.len()..start + marker.len() + 3)
        .ok_or("PDF header version is incomplete")?;
    if !version[0].is_ascii_digit() || version[1] != b'.' || !version[2].is_ascii_digit() {
        return Err("PDF header version is invalid".into());
    }
    Ok(format!("{}.{}", version[0] - b'0', version[2] - b'0'))
}

fn checked_qpdf_max_id(value: u64) -> Result<u32> {
    let max_id = u32::try_from(value).map_err(|_| "qpdf maxobjectid exceeds the PDF limit")?;
    if max_id > u32::MAX - MAX_QPDF_NEW_OBJECT_HEADROOM {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!(
                "qpdf maxobjectid leaves fewer than {MAX_QPDF_NEW_OBJECT_HEADROOM} IDs for native mutations"
            ),
        ));
    }
    Ok(max_id)
}

fn parse_qpdf_object_key(key: &str, allow_legacy_encoding: bool) -> Result<ObjectId> {
    let reference = match key.strip_prefix("obj:") {
        Some(reference) => reference,
        None if allow_legacy_encoding => key,
        None => return Err("qpdf object key is missing obj prefix".into()),
    };
    parse_qpdf_reference(reference)
        .ok_or_else(|| format!("qpdf object key is invalid: {key}").into())
}

fn parse_qpdf_reference(value: &str) -> Option<ObjectId> {
    let mut parts = value.split_ascii_whitespace();
    let object_number = parts.next()?.parse().ok()?;
    let generation = parts.next()?.parse().ok()?;
    (parts.next() == Some("R") && parts.next().is_none()).then_some((object_number, generation))
}

fn qpdf_dictionary(value: &Value) -> Result<Dictionary> {
    qpdf_dictionary_with_mode(value, false)
}

fn qpdf_dictionary_with_mode(value: &Value, allow_legacy_encoding: bool) -> Result<Dictionary> {
    let values = value
        .as_object()
        .ok_or("qpdf dictionary value is not an object")?;
    let mut dictionary = Dictionary::new();
    for (key, value) in values {
        let decoded_key = decode_qpdf_name(key)?;
        dictionary.set(
            decoded_key.clone(),
            if decoded_key == b"DA" {
                qpdf_default_appearance_object(value, allow_legacy_encoding)?
            } else {
                qpdf_object_with_mode(value, allow_legacy_encoding)?
            },
        );
    }
    Ok(dictionary)
}

fn qpdf_object(value: &Value) -> Result<Object> {
    qpdf_object_with_mode(value, false)
}

fn qpdf_object_with_mode(value: &Value, allow_legacy_encoding: bool) -> Result<Object> {
    Ok(match value {
        Value::Null => Object::Null,
        Value::Bool(value) => Object::Boolean(*value),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                Object::Integer(integer)
            } else if let Some(integer) = value.as_u64() {
                Object::Integer(i64::try_from(integer).map_err(|_| "PDF integer exceeds i64")?)
            } else {
                let real = value
                    .as_f64()
                    .filter(|real| real.is_finite())
                    .ok_or("PDF real number is not finite")?;
                let real = real as f32;
                if !real.is_finite() {
                    return Err("PDF real number exceeds f32".into());
                }
                Object::Real(real)
            }
        }
        Value::String(value) => {
            if allow_legacy_encoding {
                qpdf_string_object_with_mode(value, true)?
            } else {
                qpdf_string_object(value)?
            }
        }
        Value::Array(values) => Object::Array(
            values
                .iter()
                .map(|value| qpdf_object_with_mode(value, allow_legacy_encoding))
                .collect::<Result<Vec<_>>>()?,
        ),
        Value::Object(_) => {
            Object::Dictionary(qpdf_dictionary_with_mode(value, allow_legacy_encoding)?)
        }
    })
}

fn qpdf_string_object(value: &str) -> Result<Object> {
    qpdf_string_object_with_mode(value, false)
}

fn qpdf_string_object_with_mode(value: &str, allow_legacy_encoding: bool) -> Result<Object> {
    if let Some(reference) = parse_qpdf_reference(value) {
        return Ok(Object::Reference(reference));
    }
    if value.starts_with('/') || value.starts_with("n:/") {
        return Ok(Object::Name(decode_qpdf_name(value)?));
    }
    if let Some(text) = value.strip_prefix("u:") {
        return Ok(Object::String(
            encode_pdf_text_string(text),
            StringFormat::Hexadecimal,
        ));
    }
    if let Some(hex) = value.strip_prefix("b:") {
        return Ok(Object::String(
            decode_hex_bytes(hex)?,
            StringFormat::Hexadecimal,
        ));
    }
    if allow_legacy_encoding {
        return Ok(Object::String(
            value.as_bytes().to_vec(),
            StringFormat::Literal,
        ));
    }
    Err("qpdf JSON string has an unknown PDF encoding".into())
}

fn qpdf_default_appearance_object(value: &Value, allow_legacy_encoding: bool) -> Result<Object> {
    if let Value::String(value) = value {
        if let Some(appearance) = value.strip_prefix("u:") {
            return Ok(Object::String(
                appearance.as_bytes().to_vec(),
                StringFormat::Literal,
            ));
        }
    }
    qpdf_object_with_mode(value, allow_legacy_encoding)
}

fn decode_qpdf_name(value: &str) -> Result<Vec<u8>> {
    let encoded = value.strip_prefix("n:").unwrap_or(value);
    let encoded = encoded
        .strip_prefix('/')
        .ok_or("qpdf name is missing its slash")?
        .as_bytes();
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'#' {
            let high = *encoded
                .get(index + 1)
                .ok_or("qpdf name escape ended early")?;
            let low = *encoded
                .get(index + 2)
                .ok_or("qpdf name escape ended early")?;
            decoded.push((hex_value(high)? << 4) | hex_value(low)?);
            index += 3;
        } else {
            decoded.push(encoded[index]);
            index += 1;
        }
    }
    Ok(decoded)
}

fn decode_hex_bytes(hex: &str) -> Result<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return Err("qpdf binary string has an odd hex length".into());
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| Ok((hex_value(pair[0])? << 4) | hex_value(pair[1])?))
        .collect()
}

fn hex_value(value: u8) -> Result<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("qpdf JSON contains invalid hex".into()),
    }
}

pub(crate) fn read_terminal_xref(
    path: &Path,
    file_len: u64,
) -> Result<(u64, lopdf::xref::XrefType)> {
    let mut file = File::open(path).map_err(io_domain_error)?;
    read_terminal_xref_from_file(&mut file, file_len)
}

pub(crate) fn read_terminal_xref_from_file(
    file: &mut File,
    file_len: u64,
) -> Result<(u64, lopdf::xref::XrefType)> {
    const TAIL_BYTES: u64 = 1024 * 1024;
    let tail_start = file_len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(tail_start))?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail)?;
    let eof = find_last_bytes(&tail, b"%%EOF").ok_or("PDF terminal EOF marker is missing")?;
    if tail[eof + b"%%EOF".len()..]
        .iter()
        .any(|byte| !byte.is_ascii_whitespace())
    {
        return Err("PDF has non-whitespace data after its terminal EOF marker".into());
    }
    let marker = find_last_bytes(&tail[..eof], b"startxref")
        .ok_or("PDF terminal startxref marker is missing")?;
    let relative = parse_u64_token(&tail, marker + b"startxref".len())
        .map(|(value, _)| value)
        .ok_or("PDF terminal startxref value is invalid")?;
    if relative >= file_len {
        return Err("PDF terminal startxref points outside the file".into());
    }
    file.seek(SeekFrom::Start(relative))?;
    let mut marker = [0_u8; 4];
    let count = file.read(&mut marker)?;
    let xref_type = if marker[..count].starts_with(b"xref") {
        lopdf::xref::XrefType::CrossReferenceTable
    } else {
        lopdf::xref::XrefType::CrossReferenceStream
    };
    Ok((relative, xref_type))
}

fn read_last_byte(path: &Path, len: u64) -> Result<Option<u8>> {
    let mut file = File::open(path).map_err(io_domain_error)?;
    read_last_byte_from_file(&mut file, len)
}

pub(crate) fn read_last_byte_from_file(file: &mut File, len: u64) -> Result<Option<u8>> {
    if len == 0 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(len - 1))?;
    let mut byte = [0_u8; 1];
    file.read_exact(&mut byte)?;
    Ok(Some(byte[0]))
}

fn io_domain_error(error: std::io::Error) -> Box<dyn Error> {
    domain_error(NativeErrorCode::Io, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_qpdf_names_references_and_strings() {
        assert_eq!(decode_qpdf_name("/text/plain").unwrap(), b"text/plain");
        assert_eq!(decode_qpdf_name("n:/one#a0two").unwrap(), b"one\xa0two");
        assert_eq!(parse_qpdf_reference("12 3 R"), Some((12, 3)));
        assert_eq!(
            qpdf_string_object("b:00ff").unwrap(),
            Object::String(vec![0, 255], StringFormat::Hexadecimal)
        );
    }

    #[test]
    fn preserves_default_appearance_operators_from_qpdf_unicode_strings() {
        let dictionary = qpdf_dictionary(&serde_json::json!({
            "/DA": "u:/Helv 22 Tf 0.0667 0.0941 0.1529 rg",
            "/Contents": "u:canonical text box",
        }))
        .unwrap();

        assert_eq!(
            dictionary.get(b"DA").unwrap().as_str().unwrap(),
            b"/Helv 22 Tf 0.0667 0.0941 0.1529 rg",
        );
        assert_eq!(
            dictionary.get(b"Contents").unwrap().as_str().unwrap(),
            encode_pdf_text_string("canonical text box"),
        );
    }

    #[test]
    fn uses_structural_qpdf_arguments_supported_by_qpdf_ten_and_newer() {
        assert_eq!(
            QPDF_STRUCTURE_ARGS,
            &["--suppress-recovery", "--json", "--"]
        );
    }

    #[test]
    fn qpdf_retained_cost_stops_at_the_per_object_limit() {
        let value = serde_json::json!({"a": [1, 2, {"b": true}]});
        assert_eq!(
            qpdf_value_retained_cost(&value, 6),
            Some(6 * QPDF_ESTIMATED_BYTES_PER_VALUE + 2)
        );
        assert_eq!(qpdf_value_retained_cost(&value, 5), None);
    }

    #[test]
    fn qpdf_maxobjectid_reserves_native_mutation_headroom() {
        assert_eq!(
            checked_qpdf_max_id(u64::from(u32::MAX - MAX_QPDF_NEW_OBJECT_HEADROOM)).unwrap(),
            u32::MAX - MAX_QPDF_NEW_OBJECT_HEADROOM
        );
        let error = checked_qpdf_max_id(u64::from(u32::MAX - MAX_QPDF_NEW_OBJECT_HEADROOM + 1))
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::TooLarge
        );
    }

    #[test]
    fn accepts_structural_sidecar_larger_than_the_old_eight_megabyte_cap() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("evb-qpdf-structural-output-test-{nonce}.json"));
        let mut file = File::create(&path).unwrap();
        file.write_all(
            br#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.7","maxobjectid":1},{"trailer":{"value":{"/Root":"1 0 R","/Producer":"u:"#,
        )
        .unwrap();
        let filler = vec![b'a'; 1024 * 1024];
        for _ in 0..9 {
            file.write_all(&filler).unwrap();
        }
        file.write_all(br#""}},"obj:1 0 R":{"value":{"/Type":"/Catalog"}}}]}"#)
            .unwrap();
        file.sync_all().unwrap();

        let metadata = file.metadata().unwrap();
        assert!(metadata.len() > 8 * 1024 * 1024);
        drop(file);
        let parsed = parse_qpdf_structure(&path, None).unwrap();
        assert_eq!(
            parsed
                .0
                .trailer
                .get(b"Root")
                .unwrap()
                .as_reference()
                .unwrap(),
            (1, 0)
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn stale_qpdf_sidecars_are_removed_without_touching_other_temp_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("evb-qpdf-cleanup-test-{nonce}"));
        fs::create_dir(&directory).unwrap();
        let sidecar = directory.join(format!("{QPDF_TEMP_PREFIX}1-2.json"));
        let unrelated = directory.join("keep.json");
        fs::write(&sidecar, b"sidecar").unwrap();
        fs::write(&unrelated, b"unrelated").unwrap();

        let now = SystemTime::now();
        remove_stale_qpdf_files(&directory, now);
        assert!(sidecar.exists());
        remove_stale_qpdf_files(&directory, now + QPDF_STALE_FILE_AGE);
        assert!(!sidecar.exists());
        assert!(unrelated.exists());

        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    fn load_with_fake_qpdf(status: i32, structure: &str) -> Result<IncrementalDocument> {
        use std::os::unix::fs::PermissionsExt;

        let nonce = qpdf_temp_nonce()?;
        let input_path = std::env::temp_dir().join(format!("evb-qpdf-status-input-{nonce}.pdf"));
        let qpdf_path = std::env::temp_dir().join(format!("evb-qpdf-status-command-{nonce}"));

        let mut input = Document::with_version("1.4");
        let catalog_id = input.add_object(dictionary! { "Type" => "Catalog" });
        input.trailer.set("Root", catalog_id);
        input.save(&input_path)?;

        let script = format!("#!/bin/sh\nprintf '%s' '{structure}'\nexit {status}\n");
        fs::write(&qpdf_path, script)?;
        fs::set_permissions(&qpdf_path, fs::Permissions::from_mode(0o700))?;

        let result = load_qpdf_structural_incremental_pdf(&input_path, &qpdf_path);
        let _ = fs::remove_file(&input_path);
        let _ = fs::remove_file(&qpdf_path);
        result
    }

    #[cfg(unix)]
    #[test]
    fn qpdf_warning_exit_with_valid_json_loads_the_structural_document() {
        let result = load_with_fake_qpdf(
            3,
            r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"/Root":"1 0 R"}},"obj:1 0 R":{"value":{"/Type":"/Catalog"}}}]}"#,
        )
        .expect("qpdf warning-only output with valid JSON should load");

        assert_eq!(result.previous_document.max_id, 1);
        assert_eq!(result.previous_document.root_id().unwrap(), (1, 0));
    }

    #[cfg(unix)]
    #[test]
    fn qpdf_legacy_json_loads_plain_strings_and_marks_streams_unavailable() {
        let mut result = load_with_fake_qpdf(
            0,
            r#"{"version":1,"objects":{"trailer":{"/Size":3,"/Root":"1 0 R"},"1 0 R":{"/Type":"/Catalog","/Title":"Legacy title"},"2 0 R":{"/Length":4,"/Filter":"/FlateDecode"}}}"#,
        )
        .expect("qpdf legacy JSON should load");

        assert_eq!(result.previous_document.version, "1.4");
        assert_eq!(result.previous_document.max_id, 2);
        assert_eq!(result.previous_document.root_id().unwrap(), (1, 0));
        assert_eq!(
            result
                .previous_document
                .get_object((1, 0))
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"Title")
                .unwrap()
                .as_str()
                .unwrap(),
            b"Legacy title"
        );
        assert!(matches!(
            result.previous_document.get_object((2, 0)).unwrap(),
            Object::Stream(_)
        ));
        assert!(result.opt_clone_object_to_new_document((2, 0)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn qpdf_warning_exit_with_truncated_json_fails_closed() {
        let error = load_with_fake_qpdf(
            3,
            r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"#,
        )
            .expect_err("truncated qpdf JSON must fail closed");

        let message = error.to_string();
        assert!(
            message.contains("EOF") || message.contains("expected"),
            "unexpected qpdf JSON parse error: {message}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn qpdf_error_exit_fails_before_accepting_valid_json() {
        let error = load_with_fake_qpdf(
            2,
            r#"{"qpdf":[{"jsonversion":2,"pdfversion":"1.4","maxobjectid":1},{"trailer":{"value":{"/Root":"1 0 R"}},"obj:1 0 R":{"value":{"/Type":"/Catalog"}}}]}"#,
        )
        .expect_err("qpdf error exit must fail closed");

        let native_error = error
            .downcast_ref::<NativeError>()
            .expect("qpdf process failures should carry a native error");
        assert_eq!(native_error.code, NativeErrorCode::CorruptXref);
    }

    #[test]
    fn terminal_xref_rejects_a_later_marker_after_eof() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("evb-terminal-xref-test-{nonce}.pdf"));
        fs::write(
            &path,
            b"%PDF-1.4\nxref\nstartxref\n9\n%%EOF\n% startxref\n1\n",
        )
        .unwrap();
        let mut file = File::open(&path).unwrap();
        let len = file.metadata().unwrap().len();
        let error = read_terminal_xref_from_file(&mut file, len).unwrap_err();
        assert!(error.to_string().contains("after its terminal EOF"));
        fs::remove_file(path).unwrap();
    }
}
