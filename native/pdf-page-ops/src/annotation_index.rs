use super::*;
use evb_native_support::output::AtomicOutput;
use serde::Serialize;
use std::{fs, io::Write, path::Path};

const ANNOTATION_INDEX_FORMAT: &str = "evb-pdf-annotation-name-index";
const ANNOTATION_INDEX_SCHEMA_VERSION: u64 = 1;
const ANNOTATION_INDEX_CHUNK_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationIndexReference {
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
}

impl From<ObjectId> for AnnotationIndexReference {
    fn from(object_id: ObjectId) -> Self {
        Self {
            object_number: u64::from(object_id.0),
            generation_number: u64::from(object_id.1),
        }
    }
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationIndexEntry {
    pub(crate) page_index: u64,
    pub(crate) object_number: u64,
    pub(crate) generation_number: u64,
    pub(crate) subtype: String,
    pub(crate) name: Option<String>,
    pub(crate) popup_ref: Option<AnnotationIndexReference>,
    pub(crate) parent_ref: Option<AnnotationIndexReference>,
}

fn annotation_index_entry(
    page_index: u64,
    object_number: u64,
    generation_number: u64,
    annotation: &Dictionary,
) -> AnnotationIndexEntry {
    AnnotationIndexEntry {
        page_index,
        object_number,
        generation_number,
        subtype: annotation_subtype_text(annotation),
        name: annotation
            .get(b"NM")
            .ok()
            .and_then(annotation_string_to_text),
        popup_ref: annotation
            .get(b"Popup")
            .ok()
            .and_then(annotation_reference)
            .map(AnnotationIndexReference::from),
        parent_ref: annotation
            .get(b"Parent")
            .ok()
            .and_then(annotation_reference)
            .map(AnnotationIndexReference::from),
    }
}

/// Build the private annotation index sidecar without loading the source path
/// here. Callers that have already selected a structural source can use this
/// function directly in tests and in future native bridges.
pub(crate) fn write_annotation_name_index(
    document: &impl PdfObjectSource,
    output_path: &Path,
) -> Result<()> {
    write_annotation_name_index_with_chunk_limit(
        document,
        output_path,
        ANNOTATION_INDEX_CHUNK_BYTES,
    )
}

pub(crate) fn write_annotation_name_index_path(
    input_path: &Path,
    output_path: &Path,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    if annotation_index_paths_alias(input_path, output_path)? {
        return Err(domain_error(
            NativeErrorCode::InvalidRequest,
            "Annotation index output must not alias the PDF input",
        ));
    }

    let incremental = load_annotation_index_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by the annotation index operation",
    )?;

    write_annotation_name_index(&AppendedRevision::new(&incremental), output_path)
}

pub(crate) fn annotation_index_paths_alias(input_path: &Path, output_path: &Path) -> Result<bool> {
    if input_path == output_path {
        return Ok(true);
    }

    let input_path = fs::canonicalize(input_path).map_err(|error| {
        domain_error(
            NativeErrorCode::Io,
            format!("Failed to resolve PDF input path: {error}"),
        )
    })?;
    let output_path = match fs::canonicalize(output_path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(domain_error(
                NativeErrorCode::Io,
                format!("Failed to resolve annotation index output path: {error}"),
            ))
        }
    };
    Ok(input_path == output_path)
}

fn write_annotation_name_index_with_chunk_limit(
    document: &impl PdfObjectSource,
    output_path: &Path,
    chunk_limit: usize,
) -> Result<()> {
    let page_ids = document.page_ids();
    let page_count = u64::try_from(page_ids.len())?;
    let mut writer = AnnotationIndexWriter::new(output_path, page_count, chunk_limit)?;

    for (page_number, page_id) in page_ids {
        let page_index = u64::from(
            page_number
                .checked_sub(1)
                .ok_or("PDF page numbering must start at one")?,
        );
        for object in page_annotation_objects(document, page_id)? {
            if let Ok(object_id) = object.as_reference() {
                let Ok(annotation) = document.dictionary(object_id) else {
                    continue;
                };
                writer.push(annotation_index_entry(
                    page_index,
                    u64::from(object_id.0),
                    u64::from(object_id.1),
                    annotation,
                ))?;
                continue;
            }

            // Object number zero is a reserved page-presence marker for a
            // direct annotation dictionary. It lets the renderer skip only
            // pages that the structural scan proved have no annotations,
            // without inventing a PDF.js identity for an unreferenced object.
            if let Ok(annotation) = object.as_dict() {
                writer.push(annotation_index_entry(page_index, 0, 0, annotation))?;
            }
        }
    }

    writer.finish()
}

fn page_annotation_objects(
    document: &impl PdfObjectSource,
    page_id: ObjectId,
) -> Result<Vec<Object>> {
    let page = document.dictionary(page_id)?;
    let Ok(annots) = page.get(b"Annots") else {
        return Ok(Vec::new());
    };
    let annots = document.resolved(annots)?;
    Ok(annots.as_array().cloned().unwrap_or_default())
}

fn annotation_reference(object: &Object) -> Option<ObjectId> {
    object.as_reference().ok()
}

fn annotation_subtype_text(annotation: &Dictionary) -> String {
    annotation
        .get(b"Subtype")
        .ok()
        .and_then(|object| object.as_name().ok())
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Unknown".to_string())
}

fn annotation_string_to_text(object: &Object) -> Option<String> {
    let bytes = object.as_str().ok()?;
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units).ok();
    }
    Some(String::from_utf8_lossy(bytes).into_owned())
}

struct AnnotationIndexWriter {
    output: AtomicOutput,
    chunk_limit: usize,
    chunk: AnnotationIndexChunk,
    next_chunk_index: u64,
    total_bytes: u64,
}

impl AnnotationIndexWriter {
    fn new(output_path: &Path, page_count: u64, chunk_limit: usize) -> Result<Self> {
        if !(64..=ANNOTATION_INDEX_CHUNK_BYTES).contains(&chunk_limit) {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "Annotation index chunk limit must fit its JSON envelope and stay within 4 MiB",
            ));
        }

        let output = AtomicOutput::create(output_path)?;
        #[cfg(unix)]
        output
            .file()?
            .set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;

        let mut writer = Self {
            output,
            chunk_limit,
            chunk: AnnotationIndexChunk::new(0),
            next_chunk_index: 0,
            total_bytes: 0,
        };
        let header = format!(
            "{{\"format\":\"{ANNOTATION_INDEX_FORMAT}\",\"schemaVersion\":{ANNOTATION_INDEX_SCHEMA_VERSION},\"pageCount\":{page_count},\"chunkBytes\":{chunk_limit}}}\n"
        );
        writer.write_bounded(header.as_bytes())?;
        Ok(writer)
    }

    fn push(&mut self, entry: AnnotationIndexEntry) -> Result<()> {
        let encoded_entry = serde_json::to_vec(&entry)?;
        if !self.chunk.try_push(&encoded_entry, self.chunk_limit) {
            if self.chunk.entry_count == 0 {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation index entry exceeds the 4 MiB chunk limit",
                ));
            }
            self.flush_chunk()?;
            if !self.chunk.try_push(&encoded_entry, self.chunk_limit) {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    "Annotation index entry exceeds the 4 MiB chunk limit",
                ));
            }
        }
        Ok(())
    }

    fn flush_chunk(&mut self) -> Result<()> {
        if self.chunk.entry_count == 0 {
            return Ok(());
        }
        let chunk = std::mem::replace(
            &mut self.chunk,
            AnnotationIndexChunk::new(self.next_chunk_index),
        )
        .finish();
        self.write_bounded(&chunk)?;
        self.next_chunk_index = self
            .next_chunk_index
            .checked_add(1)
            .ok_or("Annotation index chunk number overflow")?;
        self.chunk = AnnotationIndexChunk::new(self.next_chunk_index);
        Ok(())
    }

    fn write_bounded(&mut self, bytes: &[u8]) -> Result<()> {
        let next_total = self
            .total_bytes
            .checked_add(u64::try_from(bytes.len())?)
            .ok_or("Annotation index sidecar byte count overflow")?;
        self.output.file_mut()?.write_all(bytes)?;
        self.total_bytes = next_total;
        Ok(())
    }

    fn finish(mut self) -> Result<()> {
        self.flush_chunk()?;
        self.output.publish()?;
        Ok(())
    }
}

struct AnnotationIndexChunk {
    bytes: Vec<u8>,
    entry_count: usize,
}

impl AnnotationIndexChunk {
    fn new(index: u64) -> Self {
        Self {
            bytes: format!("{{\"chunkIndex\":{index},\"entries\":[").into_bytes(),
            entry_count: 0,
        }
    }

    fn try_push(&mut self, entry: &[u8], chunk_limit: usize) -> bool {
        let separator_bytes = usize::from(self.entry_count > 0);
        let Some(candidate_len) = self
            .bytes
            .len()
            .checked_add(separator_bytes)
            .and_then(|length| length.checked_add(entry.len()))
            .and_then(|length| length.checked_add(3))
        else {
            return false;
        };
        if candidate_len > chunk_limit {
            return false;
        }
        if separator_bytes != 0 {
            self.bytes.push(b',');
        }
        self.bytes.extend_from_slice(entry);
        self.entry_count += 1;
        true
    }

    fn finish(mut self) -> Vec<u8> {
        self.bytes.extend_from_slice(b"]}\n");
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object, Stream};
    use serde_json::Value;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::{
        collections::{BTreeMap, HashMap},
        fs::{self, File},
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temporary_path(label: &str, extension: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "evb-pdf-page-ops-annotation-index-{label}-{nonce}.{extension}"
        ))
    }

    fn document_with_annotations(annotation_count: usize) -> (Document, ObjectId, Vec<ObjectId>) {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
        });
        let mut annotation_ids = Vec::with_capacity(annotation_count);
        let mut page_annots = Vec::with_capacity(annotation_count);
        for index in 0..annotation_count {
            let annotation_id = document.add_object(dictionary! {
                "Type" => "Annot",
                "Subtype" => "FreeText",
                "NM" => Object::string_literal(format!("note-{index}")),
            });
            annotation_ids.push(annotation_id);
            page_annots.push(Object::Reference(annotation_id));
        }
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", Object::Array(page_annots));
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        (document, page_id, annotation_ids)
    }

    fn read_sidecar(path: &Path) -> Vec<Value> {
        String::from_utf8(fs::read(path).unwrap())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn entries(sidecar: &[Value]) -> Vec<&Value> {
        sidecar
            .iter()
            .skip(1)
            .flat_map(|chunk| chunk["entries"].as_array().unwrap())
            .collect()
    }

    fn chunks(sidecar: &[Value]) -> &[Value] {
        // The first JSONL record is the header. Every following record is a
        // self-contained chunk that can be parsed without reading later lines.
        sidecar.get(1..).unwrap_or_default()
    }

    #[test]
    fn indexes_named_free_text_and_popup_parent_references() {
        let (mut document, page_id, _) = document_with_annotations(0);
        let popup_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Popup",
            "Parent" => Object::Reference((99, 0)),
        });
        let free_text_id = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "FreeText",
            "NM" => Object::string_literal("named-free-text"),
            "Popup" => popup_id,
        });
        document
            .get_dictionary_mut(popup_id)
            .unwrap()
            .set("Parent", Object::Reference(free_text_id));
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            Object::Array(vec![
                Object::Reference(free_text_id),
                Object::Reference(popup_id),
            ]),
        );
        let output = temporary_path("named", "json");

        write_annotation_name_index(&document, &output).unwrap();

        let sidecar = read_sidecar(&output);
        assert_eq!(sidecar[0]["format"], ANNOTATION_INDEX_FORMAT);
        assert_eq!(sidecar[0]["schemaVersion"], ANNOTATION_INDEX_SCHEMA_VERSION);
        assert_eq!(sidecar[0]["pageCount"], 1);
        let entries = entries(&sidecar);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["pageIndex"], 0);
        assert_eq!(entries[0]["objectNumber"], free_text_id.0);
        assert_eq!(entries[0]["generationNumber"], free_text_id.1);
        assert_eq!(entries[0]["subtype"], "FreeText");
        assert_eq!(entries[0]["name"], "named-free-text");
        assert_eq!(entries[0]["popupRef"]["objectNumber"], popup_id.0);
        assert_eq!(entries[0]["popupRef"]["generationNumber"], popup_id.1);
        assert_eq!(entries[0]["parentRef"], Value::Null);
        assert_eq!(entries[1]["subtype"], "Popup");
        assert_eq!(entries[1]["name"], Value::Null);
        assert_eq!(entries[1]["parentRef"]["objectNumber"], free_text_id.0);
        assert_eq!(entries[1]["parentRef"]["generationNumber"], free_text_id.1);
        assert!(!String::from_utf8_lossy(&fs::read(&output).unwrap()).contains("stream"));

        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn emits_a_reserved_presence_marker_for_direct_annotations() {
        let (mut document, page_id, _) = document_with_annotations(0);
        document.get_dictionary_mut(page_id).unwrap().set(
            "Annots",
            Object::Array(vec![Object::Dictionary(dictionary! {
                "Type" => "Annot",
                "Subtype" => "Link",
            })]),
        );
        let output = temporary_path("direct", "json");

        write_annotation_name_index(&document, &output).unwrap();

        let sidecar = read_sidecar(&output);
        let entries = entries(&sidecar);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["pageIndex"], 0);
        assert_eq!(entries[0]["objectNumber"], 0);
        assert_eq!(entries[0]["generationNumber"], 0);
        assert_eq!(entries[0]["subtype"], "Link");
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn splits_chunks_at_the_bound_and_preserves_page_order() {
        let (document, _, annotation_ids) = document_with_annotations(32);
        let output = temporary_path("chunks", "json");
        write_annotation_name_index_with_chunk_limit(&document, &output, 512).unwrap();

        let sidecar = read_sidecar(&output);
        let chunks = chunks(&sidecar);
        assert!(chunks.len() > 1);
        assert_eq!(sidecar[0]["chunkBytes"], 512);
        for chunk in chunks {
            assert!(serde_json::to_vec(chunk).unwrap().len() < 512);
        }
        let entries = entries(&sidecar);
        assert_eq!(entries.len(), annotation_ids.len());
        for (entry, object_id) in entries.into_iter().zip(annotation_ids) {
            assert_eq!(entry["pageIndex"], 0);
            assert_eq!(entry["objectNumber"], object_id.0);
        }
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn emits_safe_page_indexes_beyond_one_hundred_thousand() {
        let page_id = (7, 0);
        let annotation_id = (8, 0);
        let mut objects = HashMap::new();
        objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Annots" => vec![Object::Reference(annotation_id)],
            }),
        );
        objects.insert(
            annotation_id,
            Object::Dictionary(dictionary! {
                "Subtype" => "FreeText",
                "NM" => Object::string_literal("large-page-index"),
            }),
        );
        let source = SparsePdfObjectSource {
            objects,
            pages: BTreeMap::from([(100_001, page_id)]),
        };
        let output = temporary_path("large-page-index", "json");

        write_annotation_name_index(&source, &output).unwrap();

        let sidecar = read_sidecar(&output);
        assert_eq!(entries(&sidecar)[0]["pageIndex"], 100_000);
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn large_path_requires_qpdf_before_attempting_an_eager_read() {
        let input = temporary_path("large-dispatch", "pdf");
        let output = temporary_path("large-dispatch", "json");
        let file = File::create(&input).unwrap();
        file.set_len(512 * 1024 * 1024 + 1).unwrap();

        let error = mutate_pdf(Config {
            operation: Operation::AnnotationNameIndex,
            input_path: input.clone(),
            output_path: output.clone(),
            qpdf_path: None,
        })
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("Large incremental PDF input requires the bundled qpdf structural reader"));
        assert!(!output.exists());
        fs::remove_file(input).unwrap();
    }

    #[test]
    fn stream_contents_are_not_copied_into_the_index() {
        let (mut document, page_id, _) = document_with_annotations(0);
        let stream_id = document.add_object(Stream::new(
            dictionary! {"Length" => 22},
            b"secret stream payload".to_vec(),
        ));
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Contents", Object::Reference(stream_id));
        let output = temporary_path("stream", "json");

        write_annotation_name_index(&document, &output).unwrap();

        let bytes = fs::read(&output).unwrap();
        assert!(!bytes
            .windows(b"secret stream payload".len())
            .any(|window| window == b"secret stream payload"));
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn path_operation_loads_a_small_pdf_and_writes_the_private_sidecar() {
        let (mut document, _, annotation_ids) = document_with_annotations(1);
        let input = temporary_path("small-input", "pdf");
        let output = temporary_path("small-output", "json");
        document.save(&input).unwrap();

        write_annotation_name_index_path(&input, &output, None).unwrap();

        let sidecar = read_sidecar(&output);
        assert_eq!(entries(&sidecar).len(), annotation_ids.len());
        assert_eq!(entries(&sidecar)[0]["name"], "note-0");
        fs::remove_file(input).unwrap();
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn path_index_accepts_more_than_one_hundred_thousand_pages() {
        let page_count = 100_001_usize;
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let mut kids = Vec::with_capacity(page_count);
        for _ in 0..page_count {
            let page_id = document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
            });
            kids.push(Object::Reference(page_id));
        }
        document.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => i64::try_from(page_count).unwrap(),
            },
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);

        let input = temporary_path("large-page-count-input", "pdf");
        let output = temporary_path("large-page-count-output", "json");
        document.save(&input).unwrap();

        write_annotation_name_index_path(&input, &output, None).unwrap();

        let sidecar = read_sidecar(&output);
        assert_eq!(sidecar[0]["pageCount"], page_count);
        assert_eq!(entries(&sidecar).len(), 0);
        fs::remove_file(input).unwrap();
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn parses_annotation_name_index_command_and_qpdf_path() {
        let config = parse_args(
            [
                "annotation-name-index".to_string(),
                "--input".to_string(),
                "/tmp/input.pdf".to_string(),
                "--output".to_string(),
                "/tmp/index.json".to_string(),
                "--qpdf".to_string(),
                "/opt/qpdf".to_string(),
            ]
            .into_iter(),
        )
        .unwrap();

        assert!(matches!(config.operation, Operation::AnnotationNameIndex));
        assert_eq!(config.qpdf_path, Some(PathBuf::from("/opt/qpdf")));
    }

    struct SparsePdfObjectSource {
        objects: HashMap<ObjectId, Object>,
        pages: BTreeMap<u32, ObjectId>,
    }

    impl PdfObjectSource for SparsePdfObjectSource {
        fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
            self.objects.get(&object_id)
        }

        fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
            self.pages.clone()
        }

        fn root_id(&self) -> Result<ObjectId> {
            Ok((1, 0))
        }
    }
}
