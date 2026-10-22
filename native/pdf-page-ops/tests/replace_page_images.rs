use lopdf::{content::Content, dictionary, Document, Object, ObjectId, Stream};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "evb-replace-page-images-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Source {
    page: ObjectId,
    image: ObjectId,
    outline: ObjectId,
    link: ObjectId,
    stream_bytes: usize,
}

fn save_source(path: &Path, text_after_image: bool, form: bool, rotated: bool) -> Source {
    let mut document = Document::with_version("1.7");
    let pages = document.new_object_id();
    let font = document.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    });
    let pixels = vec![220; 200 * 120];
    let image_bytes = pixels.len();
    let image = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 200,
            "Height" => 120, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        },
        pixels,
    ));
    let drawable = if form {
        document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                "Resources" => dictionary! {},
            },
            b"0 0 1 1 re f\n".to_vec(),
        ))
    } else {
        image
    };
    let text = "BT /F1 12 Tf 0 Tr 1 0 0 1 50 60 Tm (Searchable scan text) Tj ET\n";
    let draw = "q 200 0 0 120 0 0 cm /Scan Do Q\n";
    let content = if text_after_image {
        format!("{draw}{text}")
    } else {
        format!("{text}{draw}")
    };
    let stream_bytes = image_bytes + content.len();
    let contents = document.add_object(Stream::new(dictionary! {}, content.into_bytes()));
    let page = document.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 120.into()],
        "Resources" => dictionary! {
            "Font" => dictionary! { "F1" => font },
            "XObject" => dictionary! { "Scan" => drawable },
        },
        "Contents" => contents,
    });
    if rotated {
        let dictionary = document.get_dictionary_mut(page).unwrap();
        dictionary.set("Rotate", 90);
        dictionary.set(
            "CropBox",
            vec![30.into(), 40.into(), 190.into(), 100.into()],
        );
    }
    let link = document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link",
        "Rect" => vec![50.into(), 50.into(), 100.into(), 70.into()],
        "A" => dictionary! {
            "S" => "GoTo", "D" => vec![Object::Reference(page), "Fit".into()],
        },
    });
    document
        .get_dictionary_mut(page)
        .unwrap()
        .set("Annots", vec![Object::Reference(link)]);
    document.set_object(
        pages,
        dictionary! {
            "Type" => "Pages", "Count" => 1, "Kids" => vec![Object::Reference(page)],
        },
    );
    let outlines = document.new_object_id();
    let outline = document.add_object(dictionary! {
        "Title" => Object::string_literal("Scan"), "Parent" => outlines,
        "Dest" => vec![Object::Reference(page), "Fit".into()],
    });
    document.set_object(
        outlines,
        dictionary! {
            "Type" => "Outlines", "First" => outline, "Last" => outline, "Count" => 1,
        },
    );
    let catalog = document.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => pages, "Outlines" => outlines,
    });
    document.trailer.set("Root", catalog);
    document.save(path).unwrap();
    Source {
        page,
        image,
        outline,
        link,
        stream_bytes,
    }
}

fn save_replacement(path: &Path, large: bool, rotated_view: bool) {
    let mut document = Document::with_version("1.7");
    let pages = document.new_object_id();
    let side = if large { 400 } else { 1 };
    let image = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => side,
            "Height" => side, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        },
        vec![220; (side * side) as usize],
    ));
    let (bbox, draw) = if rotated_view {
        ([11, 17, 71, 177], "q 60 0 0 160 11 17 cm /Im Do Q\n")
    } else {
        ([0, 0, 200, 120], "q 200 0 0 120 0 0 cm /Im Do Q\n")
    };
    let contents = document.add_object(Stream::new(dictionary! {}, draw.as_bytes().to_vec()));
    let page = document.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages,
        "MediaBox" => bbox.into_iter().map(Object::from).collect::<Vec<_>>(),
        "Resources" => dictionary! { "XObject" => dictionary! { "Im" => image } },
        "Contents" => contents,
    });
    document.set_object(
        pages,
        dictionary! {
            "Type" => "Pages", "Count" => 1, "Kids" => vec![Object::Reference(page)],
        },
    );
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    document.trailer.set("Root", catalog);
    document.save(path).unwrap();
}

fn run(scratch: &Scratch, instructions: Value) -> Output {
    let instructions_path = scratch.path("instructions.json");
    fs::write(&instructions_path, instructions.to_string()).unwrap();
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["replace-page-images", "--input"])
        .arg(scratch.path("source.pdf"))
        .arg("--output")
        .arg(scratch.path("output.pdf"))
        .arg("--instructions-file")
        .arg(instructions_path)
        .output()
        .unwrap()
}

fn instructions(scratch: &Scratch) -> Value {
    json!({
        "maxByteRatio": 0.9,
        "pages": [{ "pageNumber": 1, "replacement": scratch.path("replacement.pdf"),
                    "replacementPageNumber": 1 }],
    })
}

fn report(output: &Output, outcome: &str) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["format"], "evb-pdf-replace-page-images");
    assert_eq!(report["pages"].as_array().unwrap().len(), 1);
    assert_eq!(report["pages"][0]["pageNumber"], 1);
    assert_eq!(report["pages"][0]["outcome"], outcome);
    assert!(report["pages"][0]["sourceBytes"].as_u64().unwrap() > 0);
    report["pages"][0].clone()
}

fn referenced_objects(document: &Document, object: &Object, seen: &mut HashSet<ObjectId>) {
    match object {
        Object::Reference(id) if seen.insert(*id) => {
            referenced_objects(document, document.get_object(*id).unwrap(), seen);
        }
        Object::Array(items) => {
            for item in items {
                referenced_objects(document, item, seen);
            }
        }
        Object::Dictionary(dictionary) => {
            for (_, item) in dictionary.iter() {
                referenced_objects(document, item, seen);
            }
        }
        Object::Stream(stream) => {
            for (_, item) in stream.dict.iter() {
                referenced_objects(document, item, seen);
            }
        }
        _ => {}
    }
}

#[test]
fn searchable_image_replacement_preserves_navigation_and_invisible_extractable_text() {
    let scratch = Scratch::new("searchable-image");
    let source_path = scratch.path("source.pdf");
    let source = save_source(&source_path, false, false, false);
    let before = Document::load(&source_path).unwrap();
    assert_eq!(
        before.extract_text(&[1]).unwrap().trim(),
        "Searchable scan text"
    );
    save_replacement(&scratch.path("replacement.pdf"), false, false);

    let page_report = report(&run(&scratch, instructions(&scratch)), "replaced");
    assert_eq!(page_report["sourceBytes"], source.stream_bytes as u64);
    assert!(
        page_report["replacementBytes"].as_u64().unwrap() as f64
            <= source.stream_bytes as f64 * 0.9
    );
    let bytes = fs::read(scratch.path("output.pdf")).unwrap();
    assert!(bytes.starts_with(&fs::read(&source_path).unwrap()));
    let output = Document::load_mem(&bytes).unwrap();
    assert_eq!(
        output.get_pages().into_values().collect::<Vec<_>>(),
        vec![source.page]
    );
    let catalog = output.catalog().unwrap();
    let outlines = output
        .get_dictionary(catalog.get(b"Outlines").unwrap().as_reference().unwrap())
        .unwrap();
    assert_eq!(
        outlines.get(b"First").unwrap().as_reference().unwrap(),
        source.outline
    );
    let destination = output
        .get_dictionary(source.outline)
        .unwrap()
        .get(b"Dest")
        .unwrap()
        .as_array()
        .unwrap();
    assert_eq!(destination[0].as_reference().unwrap(), source.page);
    let page = output.get_dictionary(source.page).unwrap();
    assert_eq!(
        page.get(b"Annots").unwrap().as_array().unwrap()[0]
            .as_reference()
            .unwrap(),
        source.link
    );
    let action = output
        .get_dictionary(source.link)
        .unwrap()
        .get(b"A")
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(
        action.get(b"D").unwrap().as_array().unwrap()[0]
            .as_reference()
            .unwrap(),
        source.page
    );
    assert_eq!(
        output.extract_text(&[1]).unwrap().trim(),
        "Searchable scan text"
    );

    let content = Content::decode(&output.get_page_content(source.page)).unwrap();
    let mut mode = 0;
    let mut modes = Vec::new();
    let mut text_shows = 0;
    for operation in content.operations {
        match operation.operator.as_str() {
            "q" => modes.push(mode),
            "Q" => mode = modes.pop().unwrap(),
            "Tr" => mode = operation.operands[0].as_i64().unwrap(),
            "Tj" | "TJ" | "'" | "\"" => {
                assert_eq!(mode, 3, "retained text must not paint over the replacement");
                text_shows += 1;
            }
            "Do" => assert_eq!(
                operation.operands[0].as_name().unwrap(),
                b"EvbOptimizedPage"
            ),
            _ => {}
        }
    }
    assert!(text_shows > 0);
    let mut referenced = HashSet::new();
    for key in [b"Contents".as_slice(), b"Resources".as_slice()] {
        referenced_objects(&output, page.get(key).unwrap(), &mut referenced);
    }
    assert!(
        !referenced.contains(&source.image),
        "old image is still reachable from the page"
    );
}

#[test]
fn larger_replacement_reports_not_smaller_without_writing_output() {
    let scratch = Scratch::new("larger");
    let source = save_source(&scratch.path("source.pdf"), false, false, false);
    save_replacement(&scratch.path("replacement.pdf"), true, false);
    let page_report = report(&run(&scratch, instructions(&scratch)), "not-smaller");
    assert_eq!(page_report["sourceBytes"], source.stream_bytes as u64);
    assert!(page_report["replacementBytes"].as_u64().unwrap() > source.stream_bytes as u64);
    assert!(!scratch.path("output.pdf").exists());
}

#[test]
fn text_drawn_after_image_reports_visible_text_without_writing_output() {
    let scratch = Scratch::new("visible-text");
    save_source(&scratch.path("source.pdf"), true, false, false);
    save_replacement(&scratch.path("replacement.pdf"), false, false);
    let page_report = report(&run(&scratch, instructions(&scratch)), "visible-text");
    assert_eq!(page_report["replacementBytes"], 0);
    assert!(!scratch.path("output.pdf").exists());
}

#[test]
fn drawn_form_reports_form_xobject_without_writing_output() {
    let scratch = Scratch::new("form");
    save_source(&scratch.path("source.pdf"), false, true, false);
    save_replacement(&scratch.path("replacement.pdf"), false, false);
    let page_report = report(&run(&scratch, instructions(&scratch)), "form-xobject");
    assert_eq!(page_report["replacementBytes"], 0);
    assert!(!scratch.path("output.pdf").exists());
}

#[test]
fn rotated_offset_crop_maps_replacement_bbox_exactly_to_page_view() {
    let scratch = Scratch::new("rotated-crop");
    let source = save_source(&scratch.path("source.pdf"), false, false, true);
    save_replacement(&scratch.path("replacement.pdf"), false, true);
    report(&run(&scratch, instructions(&scratch)), "replaced");
    let output = Document::load(scratch.path("output.pdf")).unwrap();
    let page = output.get_dictionary(source.page).unwrap();
    assert_eq!(page.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
    let numbers = |objects: &[Object]| {
        objects
            .iter()
            .map(|object| f64::from(object.as_float().unwrap()))
            .collect::<Vec<_>>()
    };
    let view = numbers(page.get(b"CropBox").unwrap().as_array().unwrap());
    assert_eq!(view, vec![30.0, 40.0, 190.0, 100.0]);
    let xobjects = page
        .get(b"Resources")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"XObject")
        .unwrap()
        .as_dict()
        .unwrap();
    let form = output
        .get_object(
            xobjects
                .get(b"EvbOptimizedPage")
                .unwrap()
                .as_reference()
                .unwrap(),
        )
        .unwrap()
        .as_stream()
        .unwrap();
    assert_eq!(
        form.dict.get(b"Subtype").unwrap().as_name().unwrap(),
        b"Form"
    );
    let bbox = numbers(form.dict.get(b"BBox").unwrap().as_array().unwrap());
    assert_eq!(bbox, vec![11.0, 17.0, 71.0, 177.0]);
    let content = Content::decode(&output.get_page_content(source.page)).unwrap();
    let draw = content
        .operations
        .iter()
        .position(|operation| operation.operator == "Do")
        .unwrap();
    let placement = &content.operations[draw - 1];
    assert_eq!(placement.operator, "cm");
    let matrix = numbers(&placement.operands);
    let corners = |rect: &[f64]| {
        [
            (rect[0], rect[1]),
            (rect[2], rect[1]),
            (rect[2], rect[3]),
            (rect[0], rect[3]),
        ]
    };
    let expected = corners(&view);
    let mut matched = HashSet::new();
    for (x, y) in corners(&bbox) {
        let point = (
            matrix[0] * x + matrix[2] * y + matrix[4],
            matrix[1] * x + matrix[3] * y + matrix[5],
        );
        let index = expected
            .iter()
            .position(|&(x, y)| (point.0 - x).abs() < 0.001 && (point.1 - y).abs() < 0.001)
            .unwrap_or_else(|| {
                panic!("transformed BBox corner {point:?} is outside page view {view:?}")
            });
        assert!(
            matched.insert(index),
            "two corners mapped onto the same page-view corner"
        );
    }
    assert_eq!(matched.len(), 4);
}

#[test]
fn invalid_instructions_report_invalid_request_without_writing_output() {
    let scratch = Scratch::new("invalid-instructions");
    save_source(&scratch.path("source.pdf"), false, false, false);
    save_replacement(&scratch.path("replacement.pdf"), false, false);
    let valid = instructions(&scratch);
    let mut cases = Vec::new();
    let mut duplicate = valid.clone();
    duplicate["pages"]
        .as_array_mut()
        .unwrap()
        .push(valid["pages"][0].clone());
    cases.push(duplicate);
    for field in ["pageNumber", "replacementPageNumber"] {
        let mut zero = valid.clone();
        zero["pages"][0][field] = json!(0);
        cases.push(zero);
    }
    for ratio in [-0.1, 0.0, 1.01] {
        let mut invalid_ratio = valid.clone();
        invalid_ratio["maxByteRatio"] = json!(ratio);
        cases.push(invalid_ratio);
    }
    for case in cases {
        let output = run(&scratch, case.clone());
        assert!(
            !output.status.success(),
            "accepted invalid instructions: {case}"
        );
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["code"], "invalid-request", "{case}: {error}");
        assert!(!scratch.path("output.pdf").exists());
    }
}

fn rewrite_page_content(path: &Path, page: ObjectId, content: &str) {
    let mut document = Document::load(path).unwrap();
    let contents = document.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    document
        .get_dictionary_mut(page)
        .unwrap()
        .set("Contents", contents);
    document.save(path).unwrap();
}

#[test]
fn drawing_over_the_scan_keeps_the_page_and_drawing_under_it_does_not() {
    let scratch = Scratch::new("drawing");
    let source_path = scratch.path("source.pdf");
    let source = save_source(&source_path, false, false, false);
    save_replacement(&scratch.path("replacement.pdf"), false, false);
    rewrite_page_content(
        &source_path,
        source.page,
        "q 200 0 0 120 0 0 cm /Scan Do Q\n0 0 1 RG 10 60 m 190 60 l S\n",
    );
    let page_report = report(&run(&scratch, instructions(&scratch)), "visible-drawing");
    assert_eq!(page_report["replacementBytes"], 0);
    assert!(!scratch.path("output.pdf").exists());

    // A background fill the opaque scan covers is not part of what the page shows.
    rewrite_page_content(
        &source_path,
        source.page,
        "1 1 1 rg 0 0 200 120 re f\nq 200 0 0 120 0 0 cm /Scan Do Q\n",
    );
    report(&run(&scratch, instructions(&scratch)), "replaced");
    assert!(scratch.path("output.pdf").exists());
}
