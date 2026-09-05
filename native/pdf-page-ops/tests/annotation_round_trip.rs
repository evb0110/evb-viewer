use lopdf::{Dictionary, Document, Object, ObjectId};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

const MODIFIED_AT: &str = "D:20260831120000Z";
const EDITED_NOTE_TEXT: &str = "Cafe\u{301} note";
const EDITED_HIGHLIGHT_COLOR: &str = "#123456";
const EDITED_HIGHLIGHT_STORED_COLOR: &str = "#acb8c4";
const EDITED_SHAPE_COLOR: &str = "#224466";
const GEOMETRY_QUANTUM: f64 = 10_000.0;
const MAX_REFERENCE_DEPTH: usize = 64;
const LEGACY_MARKER_MAX_NORMALIZED_SIZE: f64 = 0.020_000_000_1;

#[derive(Clone)]
struct FixtureSource {
    label: String,
    bytes: Vec<u8>,
    preserved_keys: Vec<String>,
    declared_kinds: Vec<String>,
}

struct TempPaths {
    root: PathBuf,
    pdf: PathBuf,
    parse_before: PathBuf,
    parse_after: PathBuf,
    mutations: PathBuf,
    image: PathBuf,
}

impl TempPaths {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let short_label = Path::new(label)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(label);
        let root = std::env::temp_dir().join(format!(
            "evb-pdf-page-ops-annotation-round-trip-{}-{nonce}",
            sanitize_label(short_label)
        ));
        fs::create_dir_all(&root).expect("temporary round-trip directory should be created");
        Self {
            pdf: root.join("fixture.pdf"),
            parse_before: root.join("before.jsonl"),
            parse_after: root.join("after.jsonl"),
            mutations: root.join("mutations.json"),
            image: root.join("stamp.jpg"),
            root,
        }
    }
}

impl Drop for TempPaths {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug)]
struct Rect {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
}

impl Rect {
    fn width(self) -> f64 {
        self.x2 - self.x1
    }

    fn height(self) -> f64 {
        self.y2 - self.y1
    }
}

fn object_f64(document: &Document, object: &Object) -> Option<f64> {
    match resolved(document, object)? {
        Object::Integer(value) => Some(*value as f64),
        Object::Real(value) => Some(f64::from(*value)),
        _ => None,
    }
}

fn resolved<'a>(document: &'a Document, object: &'a Object) -> Option<&'a Object> {
    let mut current = object;
    for _ in 0..MAX_REFERENCE_DEPTH {
        let Object::Reference(object_id) = current else {
            return Some(current);
        };
        current = document.get_object(*object_id).ok()?;
    }
    None
}

fn object_rect(document: &Document, object: &Object) -> Option<Rect> {
    let values = resolved(document, object)?.as_array().ok()?;
    if values.len() != 4 {
        return None;
    }
    Some(Rect {
        x1: object_f64(document, &values[0])?,
        y1: object_f64(document, &values[1])?,
        x2: object_f64(document, &values[2])?,
        y2: object_f64(document, &values[3])?,
    })
}

fn inherited_page_value<'a>(
    document: &'a Document,
    page_id: ObjectId,
    key: &[u8],
) -> Option<&'a Object> {
    let mut current = Some(page_id);
    for _ in 0..MAX_REFERENCE_DEPTH {
        let object_id = current?;
        let dictionary = document.get_dictionary(object_id).ok()?;
        if let Ok(value) = dictionary.get(key) {
            return resolved(document, value);
        }
        current = dictionary
            .get(b"Parent")
            .ok()
            .and_then(|value| value.as_reference().ok());
    }
    None
}

fn page_view(document: &Document, page_index: u64) -> Rect {
    let page_id = *document
        .get_pages()
        .get(&(u32::try_from(page_index + 1).expect("page index should fit")))
        .expect("fixture page should exist");
    let media_box = object_rect(
        document,
        inherited_page_value(document, page_id, b"MediaBox")
            .expect("fixture page should have a MediaBox"),
    )
    .expect("fixture MediaBox should be rectangular");
    let Some(crop_box) = inherited_page_value(document, page_id, b"CropBox")
        .and_then(|value| object_rect(document, value))
    else {
        return media_box;
    };
    let clipped = Rect {
        x1: media_box.x1.max(crop_box.x1),
        y1: media_box.y1.max(crop_box.y1),
        x2: media_box.x2.min(crop_box.x2),
        y2: media_box.y2.min(crop_box.y2),
    };
    if clipped.width() > 0.0 && clipped.height() > 0.0 {
        clipped
    } else {
        media_box
    }
}

fn page_rotation(document: &Document, page_index: u64) -> i64 {
    let page_id = *document
        .get_pages()
        .get(&(u32::try_from(page_index + 1).expect("page index should fit")))
        .expect("fixture page should exist");
    inherited_page_value(document, page_id, b"Rotate")
        .and_then(|value| object_f64(document, value))
        .unwrap_or(0.0)
        .round() as i64
}

fn marker_rect_from_pdf(rect: Rect, page: Rect, rotation: i64) -> [f64; 4] {
    let rotation = rotation.rem_euclid(360);
    match rotation {
        90 => [
            (rect.y1 - page.y1) / page.height(),
            (rect.x1 - page.x1) / page.width(),
            rect.height() / page.height(),
            rect.width() / page.width(),
        ],
        180 => [
            1.0 - (rect.x2 - page.x1) / page.width(),
            (rect.y1 - page.y1) / page.height(),
            rect.width() / page.width(),
            rect.height() / page.height(),
        ],
        270 => [
            1.0 - (rect.y2 - page.y1) / page.height(),
            1.0 - (rect.x2 - page.x1) / page.width(),
            rect.height() / page.height(),
            rect.width() / page.width(),
        ],
        _ => [
            (rect.x1 - page.x1) / page.width(),
            1.0 - (rect.y2 - page.y1) / page.height(),
            rect.width() / page.width(),
            rect.height() / page.height(),
        ],
    }
}

fn annotation_rect(document: &Document, dictionary: &Dictionary) -> Rect {
    object_rect(
        document,
        dictionary
            .get(b"Rect")
            .expect("annotation should have a Rect"),
    )
    .expect("annotation Rect should be numeric")
}

fn pdf_ref(object_id: ObjectId) -> String {
    if object_id.1 == 0 {
        format!("{}R", object_id.0)
    } else {
        format!("{}R{}", object_id.0, object_id.1)
    }
}

fn parsed_object_id(entry: &Value) -> ObjectId {
    (
        u32::try_from(entry["objectNumber"].as_u64().expect("object number"))
            .expect("object number should fit"),
        u16::try_from(
            entry["generationNumber"]
                .as_u64()
                .expect("generation number"),
        )
        .expect("generation number should fit"),
    )
}

fn parsed_kind(entry: &Value) -> &str {
    entry["kind"].as_str().expect("parse entry kind")
}

fn parsed_name(entry: &Value) -> &str {
    entry["name"].as_str().expect("parse entry name")
}

fn parsed_page_index(entry: &Value) -> u64 {
    entry["pageIndex"].as_u64().expect("parse page index")
}

fn find_entry<'a>(entries: &'a [Value], kind: &str) -> Option<&'a Value> {
    entries.iter().find(|entry| parsed_kind(entry) == kind)
}

fn parse_rgb(value: &str) -> [u8; 3] {
    let value = value.strip_prefix('#').expect("parser colors are hex");
    assert_eq!(value.len(), 6, "parser colors should have six digits");
    [
        u8::from_str_radix(&value[0..2], 16).expect("red channel"),
        u8::from_str_radix(&value[2..4], 16).expect("green channel"),
        u8::from_str_radix(&value[4..6], 16).expect("blue channel"),
    ]
}

fn canonical_color(value: &Value) -> Value {
    match value {
        Value::String(value) => {
            Value::Array(parse_rgb(value).into_iter().map(Value::from).collect())
        }
        Value::Null => Value::Null,
        _ => panic!("annotation color should be a hex string or null"),
    }
}

fn shift_pdf_rect(rect: Rect, page: Rect) -> Rect {
    let dx = (page.width() * 0.01).max(1.0);
    let dy = (page.height() * 0.01).max(1.0);
    let shifted_x = if rect.x2 + dx <= page.x2 {
        dx
    } else if rect.x1 - dx >= page.x1 {
        -dx
    } else {
        0.0
    };
    let shifted_y = if rect.y2 + dy <= page.y2 {
        dy
    } else if rect.y1 - dy >= page.y1 {
        -dy
    } else {
        0.0
    };
    let shifted = Rect {
        x1: rect.x1 + shifted_x,
        y1: rect.y1 + shifted_y,
        x2: rect.x2 + shifted_x,
        y2: rect.y2 + shifted_y,
    };
    assert!(
        shifted.x1 != rect.x1 || shifted.y1 != rect.y1,
        "text-box fixture must leave room for a move"
    );
    shifted
}

fn page_annotation_dicts(document: &Document) -> BTreeMap<ObjectId, Dictionary> {
    let mut result = BTreeMap::new();
    for page_id in document.get_pages().values().copied() {
        let Some(annots) = document
            .get_dictionary(page_id)
            .ok()
            .and_then(|page| page.get(b"Annots").ok())
            .and_then(|value| resolved(document, value))
            .and_then(|value| value.as_array().ok())
        else {
            continue;
        };
        for object in annots {
            let Ok(object_id) = object.as_reference() else {
                continue;
            };
            if let Ok(dictionary) = document.get_dictionary(object_id) {
                result.insert(object_id, dictionary.clone());
            }
        }
    }
    result
}

fn decode_hex(source: &str) -> Vec<u8> {
    let bytes = source
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    assert_eq!(bytes.len() % 2, 0, "hex fixture should contain whole bytes");
    bytes
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char)
                .to_digit(16)
                .expect("hex fixture should use hexadecimal digits");
            let low = (pair[1] as char)
                .to_digit(16)
                .expect("hex fixture should use hexadecimal digits");
            ((high << 4) | low) as u8
        })
        .collect()
}

fn crate_fixture_sources() -> Vec<FixtureSource> {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut paths = fs::read_dir(&directory)
        .expect("crate fixture directory should exist")
        .map(|entry| entry.expect("fixture directory entry").path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("hex"))
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .into_iter()
        .map(|path| FixtureSource {
            label: path.display().to_string(),
            bytes: decode_hex(&fs::read_to_string(&path).expect("hex fixture should be readable")),
            preserved_keys: Vec::new(),
            declared_kinds: Vec::new(),
        })
        .collect()
}

fn manifest_preserved_keys(entry: &Value) -> Vec<String> {
    match entry.get("preservedKeys") {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .expect("preserved key should be a string")
                    .to_string()
            })
            .collect(),
        Some(Value::Object(values)) => values.keys().cloned().collect(),
        Some(Value::Null) | None => Vec::new(),
        Some(_) => panic!("manifest preservedKeys should be an array or object"),
    }
}

fn interop_fixture_sources() -> Vec<FixtureSource> {
    let directory = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/electron/interop"
    ));
    if !directory.is_dir() {
        println!("skipping absent interop annotation corpus");
        return Vec::new();
    }
    let manifest_path = directory.join("corpus-manifest.json");
    if !manifest_path.is_file() {
        println!("skipping absent interop annotation corpus manifest");
        return Vec::new();
    }
    let manifest: Value = serde_json::from_slice(
        &fs::read(&manifest_path).expect("interop corpus manifest should be readable"),
    )
    .expect("interop corpus manifest should be valid JSON");
    let entries = manifest["entries"]
        .as_array()
        .expect("interop corpus manifest should have an entries array");
    let ready = entries
        .iter()
        .filter(|entry| entry["status"].as_str() == Some("ready"))
        .collect::<Vec<_>>();
    if ready.is_empty() {
        println!("skipping empty interop annotation corpus manifest");
        return Vec::new();
    }
    ready
        .into_iter()
        .map(|entry| {
            let inventory = entry["subtypes"]
                .as_array()
                .expect("ready interop entry should have a subtype inventory");
            assert!(
                !inventory.is_empty(),
                "ready interop entry should have a non-empty subtype inventory"
            );
            let declared_kinds: Vec<String> = entry["kinds"]
                .as_array()
                .expect("ready interop entry should have a kinds inventory")
                .iter()
                .map(|kind| {
                    kind.as_str()
                        .expect("interop kind should be a string")
                        .to_string()
                })
                .collect();
            assert!(
                !declared_kinds.is_empty(),
                "ready interop entry should have a non-empty kind inventory"
            );
            let relative = ["file", "path", "fixture", "filename"]
                .into_iter()
                .find_map(|key| entry.get(key).and_then(Value::as_str))
                .expect("ready interop entry should name a fixture file");
            let relative_path = Path::new(relative);
            assert!(
                !relative_path.is_absolute()
                    && !relative_path
                        .components()
                        .any(|component| matches!(component, std::path::Component::ParentDir)),
                "interop fixture path must stay inside its corpus directory: {relative}"
            );
            let path = directory.join(relative_path);
            assert!(
                path.is_file(),
                "ready interop fixture is missing: {}",
                path.display()
            );
            FixtureSource {
                label: path.display().to_string(),
                bytes: fs::read(&path).expect("interop fixture should be readable"),
                preserved_keys: manifest_preserved_keys(entry),
                declared_kinds,
            }
        })
        .collect()
}

fn run_parse(input: &Path, output: &Path) -> Vec<Value> {
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["parse-annotations", "--input"])
        .arg(input)
        .args(["--output"])
        .arg(output)
        .args(["--modified-at", MODIFIED_AT])
        .output()
        .expect("parse-annotations process should start");
    assert_success(result, "parse-annotations");
    let lines = fs::read_to_string(output).expect("parse sidecar should be readable");
    let mut lines = lines.lines();
    let header: Value = serde_json::from_str(lines.next().expect("parse sidecar header"))
        .expect("parse sidecar header should be JSON");
    assert_eq!(header["format"], "evb-pdf-annotation-parse");
    assert_eq!(header["schemaVersion"], 1);
    let mut entries = Vec::new();
    for line in lines {
        let chunk: Value = serde_json::from_str(line).expect("parse chunk should be JSON");
        entries.extend(
            chunk["entries"]
                .as_array()
                .expect("parse chunk should contain entries")
                .iter()
                .cloned(),
        );
    }
    entries
}

fn assert_success(output: Output, operation: &str) {
    assert!(
        output.status.success(),
        "{operation} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn write_mutations(paths: &TempPaths, mutations: &Value) {
    fs::write(
        &paths.mutations,
        serde_json::to_vec_pretty(mutations).expect("mutations should serialize"),
    )
    .expect("mutation sidecar should be writable");
}

fn run_save(paths: &TempPaths) {
    let result = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["save-mutations", "--input"])
        .arg(&paths.pdf)
        .args(["--output"])
        .arg(&paths.pdf)
        .args(["--mutations-file"])
        .arg(&paths.mutations)
        .args(["--modified-at", MODIFIED_AT, "--append"])
        .output()
        .expect("save-mutations process should start");
    assert_success(result, "save-mutations");
}

fn normalized_text(value: &Value) -> Value {
    value
        .as_str()
        .map(|value| Value::String(value.nfc().collect()))
        .unwrap_or_else(|| value.clone())
}

fn quantize(value: f64) -> f64 {
    (value * GEOMETRY_QUANTUM).round() / GEOMETRY_QUANTUM
}

fn rounded_opacity(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn canonical_number(value: &Value) -> Value {
    Value::from(quantize(value.as_f64().expect("canonical number")))
}

fn canonical_rect(value: &Value) -> Value {
    let object = value.as_object().expect("canonical rectangle object");
    json!({
        "left": quantize(object["left"].as_f64().expect("rectangle left")),
        "top": quantize(object["top"].as_f64().expect("rectangle top")),
        "width": quantize(object["width"].as_f64().expect("rectangle width")),
        "height": quantize(object["height"].as_f64().expect("rectangle height")),
    })
}

fn canonical_point(value: &Value) -> Value {
    let object = value.as_object().expect("canonical point object");
    json!({
        "x": quantize(object["x"].as_f64().expect("point x")),
        "y": quantize(object["y"].as_f64().expect("point y")),
    })
}

fn canonical_optional_points(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_point).collect()),
        Value::Null => Value::Null,
        _ => panic!("shape points should be an array or null"),
    }
}

fn canonical_optional_strokes(value: &Value) -> Value {
    match value {
        Value::Array(strokes) => Value::Array(
            strokes
                .iter()
                .map(|stroke| {
                    Value::Array(
                        stroke
                            .as_array()
                            .expect("shape stroke should be an array")
                            .iter()
                            .map(canonical_point)
                            .collect(),
                    )
                })
                .collect(),
        ),
        Value::Null => Value::Null,
        _ => panic!("shape strokes should be an array or null"),
    }
}

fn canonical_entry(entry: &Value) -> Value {
    let kind = parsed_kind(entry);
    let mut result = Map::new();
    result.insert("kind".to_string(), Value::String(kind.to_string()));
    match kind {
        "text-box" => {
            result.insert("pageIndex".to_string(), entry["pageIndex"].clone());
            result.insert("author".to_string(), normalized_text(&entry["author"]));
            result.insert("text".to_string(), normalized_text(&entry["text"]));
            result.insert("rect".to_string(), canonical_rect(&entry["rect"]));
            result.insert("rotation".to_string(), entry["rotation"].clone());
            result.insert("fontSize".to_string(), canonical_number(&entry["fontSize"]));
            result.insert("color".to_string(), canonical_color(&entry["color"]));
        }
        "note" => {
            result.insert("pageIndex".to_string(), entry["pageIndex"].clone());
            result.insert("author".to_string(), normalized_text(&entry["author"]));
            result.insert("position".to_string(), canonical_rect(&entry["position"]));
            result.insert("contents".to_string(), normalized_text(&entry["contents"]));
            result.insert("color".to_string(), canonical_color(&entry["color"]));
            result.insert("open".to_string(), entry["open"].clone());
        }
        "highlight" => {
            result.insert("pageIndex".to_string(), entry["pageIndex"].clone());
            result.insert("author".to_string(), normalized_text(&entry["author"]));
            result.insert("subtype".to_string(), entry["subtype"].clone());
            result.insert(
                "quadPoints".to_string(),
                Value::Array(
                    entry["quadPoints"]
                        .as_array()
                        .expect("highlight quad points")
                        .iter()
                        .map(canonical_rect)
                        .collect(),
                ),
            );
            result.insert("color".to_string(), canonical_color(&entry["color"]));
            result.insert(
                "opacity".to_string(),
                Value::from(rounded_opacity(
                    entry["opacity"].as_f64().expect("highlight opacity"),
                )),
            );
            result.insert("contents".to_string(), normalized_text(&entry["contents"]));
        }
        "stamp" => {
            result.insert("pageIndex".to_string(), entry["pageIndex"].clone());
            result.insert("author".to_string(), normalized_text(&entry["author"]));
            result.insert("rect".to_string(), canonical_rect(&entry["rect"]));
            result.insert("rotation".to_string(), entry["rotation"].clone());
            let image = entry["image"].as_object().expect("stamp image");
            result.insert(
                "image".to_string(),
                json!({
                    "byteLength": image["byteLength"].clone(),
                    "sha256": image["sha256"].clone(),
                }),
            );
        }
        "shape" => {
            result.insert("pageIndex".to_string(), entry["pageIndex"].clone());
            result.insert("author".to_string(), normalized_text(&entry["author"]));
            result.insert("pdfSubtype".to_string(), entry["pdfSubtype"].clone());
            result.insert("type".to_string(), entry["type"].clone());
            for key in ["x", "y", "width", "height", "x2", "y2"] {
                result.insert(
                    key.to_string(),
                    if entry[key].is_null() {
                        Value::Null
                    } else {
                        canonical_number(&entry[key])
                    },
                );
            }
            result.insert("color".to_string(), canonical_color(&entry["color"]));
            result.insert(
                "fillColor".to_string(),
                canonical_color(&entry["fillColor"]),
            );
            result.insert(
                "opacity".to_string(),
                Value::from(rounded_opacity(
                    entry["opacity"].as_f64().expect("shape opacity"),
                )),
            );
            result.insert(
                "strokeWidth".to_string(),
                canonical_number(&entry["strokeWidth"]),
            );
            result.insert(
                "points".to_string(),
                canonical_optional_points(&entry["points"]),
            );
            result.insert(
                "strokes".to_string(),
                canonical_optional_strokes(&entry["strokes"]),
            );
            result.insert(
                "lineStartStyle".to_string(),
                entry["lineStartStyle"].clone(),
            );
            result.insert("lineEndStyle".to_string(), entry["lineEndStyle"].clone());
        }
        "foreign" => {
            result.insert("subtype".to_string(), entry["subtype"].clone());
        }
        _ => panic!("unknown parser entry kind: {kind}"),
    }
    Value::Object(result)
}

fn canonical_entries(entries: &[Value]) -> BTreeMap<String, Value> {
    let mut result = BTreeMap::new();
    for entry in entries {
        let key = format!("{}:{}", parsed_kind(entry), parsed_name(entry));
        assert!(
            result.insert(key.clone(), canonical_entry(entry)).is_none(),
            "duplicate parsed annotation identity: {key}"
        );
    }
    result
}

#[derive(Default)]
struct Edit {
    object_id: ObjectId,
    kind: &'static str,
    expected_rect: Option<Value>,
    expected_position: Option<Value>,
    expected_color: Option<&'static str>,
    expected_contents: Option<&'static str>,
    expected_rotation: Option<i64>,
    expected_opacity: Option<f64>,
    expected_stroke_width: Option<f64>,
    allowed_keys: BTreeSet<Vec<u8>>,
}

fn apply_expected_edit(entries: &mut [Value], edit: &Edit) {
    let entry = entries
        .iter_mut()
        .find(|entry| parsed_object_id(entry) == edit.object_id)
        .expect("edited annotation should remain in parse output");
    assert_eq!(parsed_kind(entry), edit.kind);
    if let Some(rect) = &edit.expected_rect {
        match edit.kind {
            "text-box" | "stamp" => entry["rect"] = rect.clone(),
            _ => panic!("unexpected rectangle edit kind"),
        }
    }
    if let Some(position) = &edit.expected_position {
        entry["position"] = position.clone();
    }
    if let Some(color) = edit.expected_color {
        if !matches!(edit.kind, "highlight" | "shape") {
            panic!("unexpected color edit kind");
        }
        entry["color"] = Value::String(color.to_string());
    }
    if let Some(contents) = edit.expected_contents {
        entry["contents"] = Value::String(contents.to_string());
    }
    if let Some(rotation) = edit.expected_rotation {
        entry["rotation"] = Value::from(rotation);
    }
    if let Some(opacity) = edit.expected_opacity {
        entry["opacity"] = Value::from(opacity);
    }
    if let Some(stroke_width) = edit.expected_stroke_width {
        entry["strokeWidth"] = Value::from(stroke_width);
    }
}

fn empty_mutations() -> Value {
    json!({
        "updates": [],
        "freeTextNotes": [],
        "textBoxes": [],
        "deletes": [],
        "placedImages": [],
    })
}

fn expected_rect_value(rect: [f64; 4]) -> Value {
    json!({
        "left": rect[0],
        "top": rect[1],
        "width": rect[2],
        "height": rect[3],
    })
}

fn is_legacy_marker(document: &Document, entry: &Value, dictionary: &Dictionary) -> bool {
    if dictionary
        .get(b"Subtype")
        .ok()
        .and_then(|value| value.as_name().ok())
        != Some(b"FreeText")
        || dictionary.get(b"Popup").is_err()
    {
        return false;
    }
    let position = entry["position"].as_object().expect("note position");
    let width = position["width"].as_f64().expect("marker width");
    let height = position["height"].as_f64().expect("marker height");
    if width > LEGACY_MARKER_MAX_NORMALIZED_SIZE || height > LEGACY_MARKER_MAX_NORMALIZED_SIZE {
        return false;
    }
    let Some(appearance) = dictionary
        .get(b"AP")
        .ok()
        .and_then(|value| resolved(document, value))
        .and_then(|value| value.as_dict().ok())
        .and_then(|appearance| appearance.get(b"N").ok())
        .and_then(|value| resolved(document, value))
        .and_then(|value| value.as_stream().ok())
    else {
        return false;
    };
    appearance.content.is_empty()
}

fn push_json_array(parent: &mut Value, key: &str, value: Value) {
    parent[key]
        .as_array_mut()
        .expect("mutation collection should be an array")
        .push(value);
}

fn build_shape_mutation(entry: &Value, object_id: ObjectId, page_count: usize) -> Value {
    let mut shape = json!({
        "type": entry["type"].clone(),
        "pageIndex": entry["pageIndex"].clone(),
        "x": entry["x"].clone(),
        "y": entry["y"].clone(),
        "width": entry["width"].clone(),
        "height": entry["height"].clone(),
        "color": EDITED_SHAPE_COLOR,
        "opacity": entry["opacity"].clone(),
        "strokeWidth": entry["strokeWidth"].as_f64().expect("shape stroke width") + 1.0,
        "annotationId": pdf_ref(object_id),
        "stableKey": parsed_name(entry),
    });
    for key in [
        "x2",
        "y2",
        "fillColor",
        "pdfSubtype",
        "lineStartStyle",
        "lineEndStyle",
    ] {
        if !entry[key].is_null() {
            shape[key] = entry[key].clone();
        }
    }
    if !entry["points"].is_null() {
        shape["points"] = entry["points"].clone();
    }
    if !entry["strokes"].is_null() {
        shape["strokes"] = entry["strokes"].clone();
    }
    json!({
        "totalPages": page_count,
        "shapes": [shape],
        "deletedAnnotationIds": [],
        "deletedStableKeys": [],
    })
}

fn build_mutations(
    entries: &[Value],
    document: &Document,
    paths: &TempPaths,
) -> (Value, Vec<Edit>) {
    let mut mutations = empty_mutations();
    let mut edits = Vec::new();
    let dictionaries = page_annotation_dicts(document);

    if let Some(entry) = find_entry(entries, "text-box") {
        let object_id = parsed_object_id(entry);
        let dictionary = dictionaries
            .get(&object_id)
            .expect("text-box dictionary should be on a page");
        let page = page_view(document, parsed_page_index(entry));
        let old_rect = annotation_rect(document, dictionary);
        let new_rect = shift_pdf_rect(old_rect, page);
        let rotation = page_rotation(document, parsed_page_index(entry));
        let marker_rect = marker_rect_from_pdf(new_rect, page, rotation);
        push_json_array(
            &mut mutations,
            "textBoxes",
            json!({
                "pageIndex": entry["pageIndex"],
                "stableKey": parsed_name(entry),
                "annotationId": pdf_ref(object_id),
                "text": entry["text"],
                "rect": [new_rect.x1, new_rect.y1, new_rect.x2, new_rect.y2],
                "rotation": entry["rotation"],
                "fontSize": entry["fontSize"],
                "color": parse_rgb(entry["color"].as_str().expect("text-box color")),
            }),
        );
        edits.push(Edit {
            object_id,
            kind: "text-box",
            expected_rect: Some(expected_rect_value(marker_rect)),
            allowed_keys: keys(&["Rect", "Contents", "M", "Rotate", "DA", "AP"]),
            ..Edit::default()
        });
    }

    if let Some(entry) = find_entry(entries, "highlight") {
        let object_id = parsed_object_id(entry);
        let marker_rect = entry["quadPoints"]
            .as_array()
            .and_then(|values| values.first())
            .expect("highlight should have geometry")
            .clone();
        mutations["markup"] = json!({
            "overrides": [],
            "hints": [{
                "subtype": entry["subtype"],
                "pageIndex": entry["pageIndex"],
                "markerRect": marker_rect,
                "markupGeometry": entry["quadPoints"],
                "annotationId": pdf_ref(object_id),
                "color": EDITED_HIGHLIGHT_COLOR,
            }],
        });
        edits.push(Edit {
            object_id,
            kind: "highlight",
            expected_color: Some(EDITED_HIGHLIGHT_STORED_COLOR),
            expected_rotation: None,
            expected_opacity: Some(1.0),
            allowed_keys: keys(&["C", "CA", "AP", "M"]),
            ..Edit::default()
        });
    }

    if let Some(entry) = entries
        .iter()
        .filter(|entry| parsed_kind(entry) == "note")
        .find(|entry| parsed_name(entry).contains("marker-edited"))
        .or_else(|| find_entry(entries, "note"))
    {
        let object_id = parsed_object_id(entry);
        let dictionary = dictionaries
            .get(&object_id)
            .expect("note dictionary should be on a page");
        push_json_array(
            &mut mutations,
            "updates",
            json!({
                "objectNumber": object_id.0,
                "generationNumber": object_id.1,
                "text": EDITED_NOTE_TEXT,
            }),
        );
        let legacy_marker = is_legacy_marker(document, entry, dictionary);
        let marker_position = if legacy_marker {
            let page = page_view(document, parsed_page_index(entry));
            let (width, height) =
                match page_rotation(document, parsed_page_index(entry)).rem_euclid(360) {
                    90 | 270 => (20.0 / page.height(), 20.0 / page.width()),
                    _ => (20.0 / page.width(), 20.0 / page.height()),
                };
            let source = entry["position"].as_object().expect("marker position");
            Some(expected_rect_value([
                source["left"]
                    .as_f64()
                    .expect("marker left")
                    .min(1.0 - width),
                source["top"]
                    .as_f64()
                    .expect("marker top")
                    .min(1.0 - height),
                width,
                height,
            ]))
        } else {
            None
        };
        let popup_edit = dictionary
            .get(b"Popup")
            .ok()
            .and_then(|value| value.as_reference().ok())
            .map(|popup_id| (popup_id, keys(&["Contents", "M"])));
        if let Some((popup_id, allowed_keys)) = popup_edit {
            edits.push(Edit {
                object_id: popup_id,
                kind: "note-popup",
                allowed_keys,
                ..Edit::default()
            });
        }
        let allowed_keys = if legacy_marker {
            keys(&[
                "Subtype",
                "Name",
                "F",
                "Rect",
                "Contents",
                "CreationDate",
                "M",
                "AP",
                "DA",
            ])
        } else {
            keys(&["Contents", "M"])
        };
        edits.push(Edit {
            object_id,
            kind: "note",
            expected_position: marker_position,
            expected_contents: Some(EDITED_NOTE_TEXT),
            allowed_keys,
            ..Edit::default()
        });
    }

    if let Some(entry) = find_entry(entries, "stamp") {
        let object_id = parsed_object_id(entry);
        let image = entry["image"].as_object().expect("stamp image");
        let image_id = (
            u32::try_from(
                image["objectNumber"]
                    .as_u64()
                    .expect("stamp image object number"),
            )
            .expect("stamp image object number should fit"),
            u16::try_from(
                image["generationNumber"]
                    .as_u64()
                    .expect("stamp image generation number"),
            )
            .expect("stamp image generation should fit"),
        );
        let bytes = resolved(
            document,
            document
                .get_object(image_id)
                .expect("stamp image object should exist"),
        )
        .and_then(|value| value.as_stream().ok())
        .expect("stamp image should be a stream")
        .content
        .clone();
        fs::write(&paths.image, &bytes).expect("stamp image payload should be writable");
        let x = 0.12;
        let y = 0.17;
        let width = 0.12;
        let height = 0.24;
        push_json_array(
            &mut mutations,
            "placedImages",
            json!({
                "pageIndex": entry["pageIndex"],
                "stableKey": parsed_name(entry),
                "annotationId": pdf_ref(object_id),
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "rotationDegrees": 0,
                "mimeType": "image/jpeg",
                "bytesPath": paths.image,
                "byteLength": bytes.len(),
                "sha256": image["sha256"],
            }),
        );
        edits.push(Edit {
            object_id,
            kind: "stamp",
            expected_rect: Some(expected_rect_value([x, y, width, height])),
            expected_rotation: Some(0),
            allowed_keys: keys(&["Rect", "AP", "F", "M"]),
            ..Edit::default()
        });
    }

    if let Some(entry) = find_entry(entries, "shape") {
        let object_id = parsed_object_id(entry);
        let page_count = document.get_pages().len();
        let shape_mutation = build_shape_mutation(entry, object_id, page_count);
        mutations["shapes"] = shape_mutation;
        edits.push(Edit {
            object_id,
            kind: "shape",
            expected_color: Some(EDITED_SHAPE_COLOR),
            expected_stroke_width: Some(
                entry["strokeWidth"].as_f64().expect("shape stroke width") + 1.0,
            ),
            allowed_keys: keys(&["Rect", "C", "IC", "CA", "Border", "CreationDate", "AP", "M"]),
            ..Edit::default()
        });
    }

    (mutations, edits)
}

fn keys(values: &[&str]) -> BTreeSet<Vec<u8>> {
    values
        .iter()
        .map(|value| value.as_bytes().to_vec())
        .collect()
}

fn changed_keys(before: &Dictionary, after: &Dictionary) -> BTreeSet<Vec<u8>> {
    let mut all_keys = BTreeSet::new();
    all_keys.extend(before.iter().map(|(key, _)| key.to_vec()));
    all_keys.extend(after.iter().map(|(key, _)| key.to_vec()));
    all_keys
        .into_iter()
        .filter(|key| before.get(key).ok() != after.get(key).ok())
        .collect()
}

fn key_name(key: &[u8]) -> String {
    String::from_utf8_lossy(key).into_owned()
}

fn assert_preservation(
    before: &Document,
    after: &Document,
    edits: &[Edit],
    preserved_keys: &[String],
) {
    let before_dicts = page_annotation_dicts(before);
    let after_dicts = page_annotation_dicts(after);
    for (object_id, before_dictionary) in &before_dicts {
        let after_dictionary = after_dicts.get(object_id).unwrap_or_else(|| {
            panic!(
                "annotation {} disappeared after append",
                pdf_ref(*object_id)
            )
        });
        let edit = edits.iter().find(|edit| edit.object_id == *object_id);
        if let Some(edit) = edit {
            let changed = changed_keys(before_dictionary, after_dictionary);
            let unexpected = changed
                .difference(&edit.allowed_keys)
                .map(|key| key_name(key))
                .collect::<Vec<_>>();
            assert!(
                unexpected.is_empty(),
                "{} annotation {} changed unowned keys: {unexpected:?}; all changes: {:?}",
                edit.kind,
                pdf_ref(*object_id),
                changed.iter().map(|key| key_name(key)).collect::<Vec<_>>()
            );
        } else {
            assert_eq!(
                before_dictionary,
                after_dictionary,
                "untouched annotation {} changed during append",
                pdf_ref(*object_id)
            );
        }
    }

    for preserved_key in preserved_keys {
        let key = preserved_key.trim().trim_start_matches('/').as_bytes();
        for (object_id, before_dictionary) in &before_dicts {
            if edits
                .iter()
                .any(|edit| edit.object_id == *object_id && edit.allowed_keys.contains(key))
            {
                continue;
            }
            let Some(before_value) = before_dictionary.get(key).ok() else {
                continue;
            };
            let after_value = after_dicts
                .get(object_id)
                .and_then(|dictionary| dictionary.get(key).ok())
                .unwrap_or_else(|| {
                    panic!(
                        "manifest preserved key {preserved_key} disappeared from annotation {}",
                        pdf_ref(*object_id)
                    )
                });
            assert_eq!(
                before_value,
                after_value,
                "manifest preserved key {preserved_key} changed on annotation {}",
                pdf_ref(*object_id)
            );
        }
    }
}

fn run_fixture_source(source: &FixtureSource) -> BTreeSet<String> {
    let paths = TempPaths::new(&source.label);
    fs::write(&paths.pdf, &source.bytes).expect("fixture should be copied to temporary storage");
    let before_document = Document::load(&paths.pdf).expect("fixture PDF should load");
    let before_entries = run_parse(&paths.pdf, &paths.parse_before);
    let editable_kinds = before_entries
        .iter()
        .filter(|entry| {
            matches!(
                parsed_kind(entry),
                "text-box" | "note" | "highlight" | "stamp" | "shape"
            )
        })
        .map(|entry| parsed_kind(entry).to_string())
        .collect::<BTreeSet<_>>();
    if !source.declared_kinds.is_empty() {
        let declared_kinds = source
            .declared_kinds
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            editable_kinds, declared_kinds,
            "manifest kind inventory does not match parsed fixture {}",
            source.label
        );
    }
    if editable_kinds.is_empty() {
        println!("skipping annotation-free fixture {}", source.label);
        return BTreeSet::new();
    }

    let (mutations, edits) = build_mutations(&before_entries, &before_document, &paths);
    assert!(
        !edits.is_empty(),
        "editable fixture {} should produce at least one mutation",
        source.label
    );
    write_mutations(&paths, &mutations);
    run_save(&paths);

    let after_document = Document::load(&paths.pdf).expect("saved fixture PDF should load");
    let after_entries = run_parse(&paths.pdf, &paths.parse_after);
    let mut expected_entries = before_entries.clone();
    for edit in &edits {
        if edit.kind != "note-popup" {
            apply_expected_edit(&mut expected_entries, edit);
        }
    }
    assert_eq!(
        canonical_entries(&after_entries),
        canonical_entries(&expected_entries),
        "canonical annotation round trip failed for {}",
        source.label
    );
    assert_preservation(
        &before_document,
        &after_document,
        &edits,
        &source.preserved_keys,
    );
    editable_kinds
}

#[test]
fn native_annotation_round_trip_discovers_crate_and_ready_interop_fixtures() {
    let crate_sources = crate_fixture_sources();
    assert!(
        !crate_sources.is_empty(),
        "the crate should provide at least one hex fixture"
    );
    let mut crate_kinds = BTreeSet::new();
    for source in &crate_sources {
        crate_kinds.extend(run_fixture_source(source));
    }
    for kind in ["text-box", "highlight", "note", "stamp", "shape"] {
        assert!(
            crate_kinds.contains(kind),
            "crate fixtures must cover the {kind} annotation kind"
        );
    }

    let interop_sources = interop_fixture_sources();
    if interop_sources.is_empty() {
        return;
    }
    let mut interop_kinds = BTreeSet::new();
    let mut declared_interop_kinds = BTreeSet::new();
    for source in &interop_sources {
        declared_interop_kinds.extend(source.declared_kinds.iter().cloned());
        interop_kinds.extend(run_fixture_source(source));
    }
    for kind in ["text-box", "highlight", "note", "stamp", "shape"] {
        assert!(
            declared_interop_kinds.contains(kind),
            "ready interop manifest entries must declare the {kind} annotation kind"
        );
        assert!(
            interop_kinds.contains(kind),
            "ready interop fixtures must cover the {kind} annotation kind"
        );
    }
}

#[test]
fn canonical_annotation_comparator_has_independent_negative_oracles() {
    let base = json!({
        "kind": "text-box",
        "pageIndex": 0,
        "author": "Author",
        "text": "Cafe\u{301}",
        "rect": {"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.4},
        "rotation": 0,
        "fontSize": 12.0,
        "color": "#112233",
        "name": "oracle",
        "objectNumber": 1,
        "generationNumber": 0,
    });
    let mut coordinate = base.clone();
    coordinate["rect"]["left"] = Value::from(0.1002);
    assert_ne!(
        canonical_entry(&coordinate),
        canonical_entry(&base),
        "a 2e-4 normalized coordinate change must fail the comparator"
    );

    let mut sub_quantum = base.clone();
    sub_quantum["rect"]["left"] = Value::from(0.100_002);
    assert_eq!(
        canonical_entry(&sub_quantum),
        canonical_entry(&base),
        "a sub-quantum normalized coordinate change must compare equal"
    );

    let mut color = base.clone();
    color["color"] = Value::String("#122233".to_string());
    assert_ne!(
        canonical_entry(&color),
        canonical_entry(&base),
        "a one-channel RGB change must fail the comparator"
    );

    let mut composed = base.clone();
    composed["text"] = Value::String("Caf\u{00e9}".to_string());
    assert_eq!(
        canonical_entry(&composed),
        canonical_entry(&base),
        "composed and decomposed text must compare equal after NFC"
    );

    let opacity_base = json!({
        "kind": "highlight",
        "pageIndex": 0,
        "author": "Author",
        "subtype": "Highlight",
        "quadPoints": [{"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.4}],
        "color": "#112233",
        "opacity": 0.42,
        "contents": "note",
    });
    let mut opacity_changed = opacity_base.clone();
    opacity_changed["opacity"] = Value::from(0.43);
    assert_ne!(
        canonical_entry(&opacity_changed),
        canonical_entry(&opacity_base),
        "a 0.01 opacity change must fail the comparator"
    );
}
