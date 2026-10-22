use jpeg_encoder::{ColorType, Encoder};
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
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
            "evb-recompress-images-{label}-{}-{nonce}",
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

// A smooth color field with low-amplitude, deterministic texture. Unlike white
// noise, it has the spatial redundancy of a photo at normal JPEG qualities.
fn photo_jpeg(width: u16, height: u16, quality: u8, neutral: bool, cmyk: bool) -> Vec<u8> {
    let mut pixels = Vec::new();
    for y in 0..u32::from(height) {
        for x in 0..u32::from(width) {
            let texture = ((x * 17 + y * 31 + x * y % 23) % 13) as u8;
            let r = (30 + x * 160 / u32::from(width)) as u8 + texture;
            let g = if neutral {
                r
            } else {
                (40 + y * 150 / u32::from(height)) as u8 + texture
            };
            let b = if neutral {
                r
            } else {
                (50 + (x + y) * 120 / (u32::from(width) + u32::from(height))) as u8 + texture
            };
            pixels.extend_from_slice(&[r, g, b]);
            if cmyk {
                pixels.push(15);
            }
        }
    }
    let mut bytes = Vec::new();
    Encoder::new(&mut bytes, quality)
        .encode(
            &pixels,
            width,
            height,
            if cmyk {
                ColorType::Cmyk
            } else {
                ColorType::Rgb
            },
        )
        .unwrap();
    bytes
}

struct Pdf {
    document: Document,
    pages: ObjectId,
    font: ObjectId,
    page_ids: Vec<ObjectId>,
}

impl Pdf {
    fn new() -> Self {
        let mut document = Document::with_version("1.7");
        let pages = document.new_object_id();
        let font = document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        });
        Self {
            document,
            pages,
            font,
            page_ids: Vec::new(),
        }
    }

    fn image(
        &mut self,
        width: u16,
        height: u16,
        quality: u8,
        neutral: bool,
        cmyk: bool,
    ) -> ObjectId {
        let mut stream = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => i64::from(width),
                "Height" => i64::from(height), "BitsPerComponent" => 8,
                "Filter" => "DCTDecode", "ColorSpace" => if cmyk { "DeviceCMYK" } else { "DeviceRGB" },
            },
            photo_jpeg(width, height, quality, neutral, cmyk),
        );
        stream.allows_compression = false;
        self.document.add_object(stream)
    }

    fn page(&mut self, xobjects: lopdf::Dictionary, draw: &str) -> ObjectId {
        let content = format!(
            "{draw}\nBT /F1 16 Tf 40 730 Td (Typeset photo book: searchable text.) Tj ET\n"
        );
        let contents = self
            .document
            .add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page = self.document.add_object(dictionary! {
            "Type" => "Page", "Parent" => self.pages,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => self.font }, "XObject" => xobjects },
            "Contents" => contents,
        });
        self.page_ids.push(page);
        page
    }

    fn save(&mut self, path: &Path) {
        self.document.set_object(
            self.pages,
            dictionary! {
                "Type" => "Pages", "Count" => self.page_ids.len() as i64,
                "Kids" => self.page_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
            },
        );
        let catalog = self
            .document
            .add_object(dictionary! { "Type" => "Catalog", "Pages" => self.pages });
        self.document.trailer.set("Root", catalog);
        self.document.save(path).unwrap();
    }
}

fn run(scratch: &Scratch, skip_pages: &[u32]) -> Value {
    fs::write(
        scratch.path("instructions.json"),
        serde_json::to_vec(&json!({
            "targetDpi": 200, "quality": 82, "maxByteRatio": 0.98, "skipPages": skip_pages,
        }))
        .unwrap(),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .arg("recompress-images")
        .arg("--input")
        .arg(scratch.path("source.pdf"))
        .arg("--output")
        .arg(scratch.path("output.pdf"))
        .arg("--instructions-file")
        .arg(scratch.path("instructions.json"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["format"], "evb-pdf-recompress-images");
    report
}

fn image_report(report: &Value, image: ObjectId, outcome: &str) -> Value {
    let row = report["images"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["objectNumber"] == image.0)
        .expect("image in CLI report");
    assert_eq!(row["outcome"], outcome, "{report}");
    row.clone()
}

fn stream(document: &Document, id: ObjectId) -> &Stream {
    document.get_object(id).unwrap().as_stream().unwrap()
}

fn assert_stream_kept(before: &Document, after: &Document, id: ObjectId) {
    let before = stream(before, id);
    let after = stream(after, id);
    assert_eq!(after.dict, before.dict);
    assert!(
        after.content == before.content,
        "stream {id:?} bytes changed"
    );
}

fn assert_dimensions(document: &Document, image: ObjectId, width: i64, height: i64) {
    let image = stream(document, image);
    assert_eq!(image.dict.get(b"Width").unwrap().as_i64().unwrap(), width);
    assert_eq!(image.dict.get(b"Height").unwrap().as_i64().unwrap(), height);
}

#[test]
fn typeset_page_downsamples_photo_and_keeps_text_page_identity_and_link() {
    let scratch = Scratch::new("typeset");
    let mut pdf = Pdf::new();
    let image = pdf.image(1200, 900, 96, false, false);
    let page = pdf.page(
        dictionary! { "Photo" => image },
        "q 144 0 0 108 40 500 cm /Photo Do Q",
    );
    let link = pdf.document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link",
        "Rect" => vec![40.into(), 720.into(), 320.into(), 750.into()],
        "A" => dictionary! { "S" => "URI", "URI" => Object::string_literal("https://example.org/book") },
    });
    pdf.document
        .get_dictionary_mut(page)
        .unwrap()
        .set("Annots", vec![Object::Reference(link)]);
    pdf.save(&scratch.path("source.pdf"));
    let before = Document::load(scratch.path("source.pdf")).unwrap();

    let report = run(&scratch, &[]);

    assert_eq!(report["pages"], json!([1]));
    let row = image_report(&report, image, "recompressed");
    let after = Document::load(scratch.path("output.pdf")).unwrap();
    assert_dimensions(&after, image, 400, 300);
    assert!(stream(&after, image).content.len() < stream(&before, image).content.len());
    assert_eq!(row["sourceBytes"], stream(&before, image).content.len());
    assert_eq!(
        row["recompressedBytes"],
        stream(&after, image).content.len()
    );
    assert_eq!(after.get_pages(), before.get_pages());
    assert_eq!(
        after.get_dictionary(page).unwrap(),
        before.get_dictionary(page).unwrap()
    );
    assert_eq!(
        after.get_object(link).unwrap(),
        before.get_object(link).unwrap()
    );
    assert_eq!(
        after.extract_text(&[1]).unwrap(),
        before.extract_text(&[1]).unwrap()
    );
    assert!(after
        .extract_text(&[1])
        .unwrap()
        .contains("Typeset photo book: searchable text."));
    // The CLI appends an incremental revision. Compare the live image bytes;
    // the app's final qpdf rewrite removes superseded streams (covered in E2E).
    assert!(fs::read(scratch.path("output.pdf"))
        .unwrap()
        .starts_with(&fs::read(scratch.path("source.pdf")).unwrap()));
}

#[test]
fn near_target_low_quality_photo_is_not_replaced_by_a_larger_encoding() {
    let scratch = Scratch::new("not-smaller");
    let mut pdf = Pdf::new();
    let image = pdf.image(420, 280, 40, false, false);
    pdf.page(
        dictionary! { "Photo" => image },
        "q 144 0 0 96 40 500 cm /Photo Do Q",
    );
    pdf.save(&scratch.path("source.pdf"));
    let original = fs::read(scratch.path("source.pdf")).unwrap();

    let report = run(&scratch, &[]);

    let row = image_report(&report, image, "not-smaller");
    assert!(row["recompressedBytes"].as_u64().unwrap() > row["sourceBytes"].as_u64().unwrap());
    assert_eq!(report["pages"], json!([]));
    assert!(!scratch.path("output.pdf").exists());
    assert_eq!(fs::read(scratch.path("source.pdf")).unwrap(), original);
}

#[test]
fn shared_photo_uses_the_largest_placement_across_pages() {
    let scratch = Scratch::new("shared");
    let mut pdf = Pdf::new();
    let image = pdf.image(1200, 900, 96, false, false);
    pdf.page(
        dictionary! { "Photo" => image },
        "q 144 0 0 108 40 500 cm /Photo Do Q",
    );
    pdf.page(
        dictionary! { "Photo" => image },
        "q 216 0 0 162 40 500 cm /Photo Do Q",
    );
    pdf.save(&scratch.path("source.pdf"));

    let report = run(&scratch, &[]);

    image_report(&report, image, "recompressed");
    assert_eq!(report["pages"], json!([1, 2]));
    let output = Document::load(scratch.path("output.pdf")).unwrap();
    assert_dimensions(&output, image, 600, 450);
    assert_eq!(
        output.get_pages().values().copied().collect::<Vec<_>>(),
        pdf.page_ids
    );
}

#[test]
fn form_matrix_contributes_to_the_photos_drawn_size() {
    let scratch = Scratch::new("form");
    let mut pdf = Pdf::new();
    let image = pdf.image(1200, 900, 96, false, false);
    let form = pdf.document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Matrix" => vec![2.into(), 0.into(), 0.into(), 3.into(), 0.into(), 0.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Photo" => image } },
        },
        b"q 72 0 0 36 0 0 cm /Photo Do Q\n".to_vec(),
    ));
    pdf.page(
        dictionary! { "Panel" => form },
        "q 1 0 0 1 40 400 cm /Panel Do Q",
    );
    pdf.save(&scratch.path("source.pdf"));

    let report = run(&scratch, &[]);

    image_report(&report, image, "recompressed");
    assert_eq!(report["pages"], json!([1]));
    let output = Document::load(scratch.path("output.pdf")).unwrap();
    assert_dimensions(&output, image, 400, 300);
    assert_stream_kept(&pdf.document, &output, form);
}

#[test]
fn form_without_resources_draws_from_the_resources_of_its_page() {
    let scratch = Scratch::new("form-inherits");
    let mut pdf = Pdf::new();
    let image = pdf.image(1200, 900, 96, false, false);
    let form = pdf.document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Matrix" => vec![2.into(), 0.into(), 0.into(), 3.into(), 0.into(), 0.into()],
        },
        b"q 72 0 0 36 0 0 cm /Photo Do Q\n".to_vec(),
    ));
    pdf.page(
        dictionary! { "Panel" => form, "Photo" => image },
        "q 1 0 0 1 40 400 cm /Panel Do Q",
    );
    pdf.save(&scratch.path("source.pdf"));

    let report = run(&scratch, &[]);

    image_report(&report, image, "recompressed");
    let output = Document::load(scratch.path("output.pdf")).unwrap();
    assert_dimensions(&output, image, 400, 300);
}

#[test]
fn photo_inside_a_form_that_cannot_be_read_keeps_its_bytes() {
    let scratch = Scratch::new("form-unread");
    let mut pdf = Pdf::new();
    let image = pdf.image(1200, 900, 96, false, false);
    let inner = pdf.document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Photo" => image } },
        },
        b"q 600 0 0 450 0 0 cm /Photo Do Q\n".to_vec(),
    ));
    // A form whose placement cannot be read: what it draws may be any size.
    let outer = pdf.document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Matrix" => vec!["a".into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Inner" => inner } },
        },
        b"/Inner Do\n".to_vec(),
    ));
    pdf.page(
        dictionary! { "Photo" => image },
        "q 144 0 0 108 40 500 cm /Photo Do Q",
    );
    pdf.page(dictionary! { "Outer" => outer }, "/Outer Do");
    pdf.save(&scratch.path("source.pdf"));

    let report = run(&scratch, &[]);

    assert!(
        report["images"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["objectNumber"] != image.0),
        "{report}"
    );
    assert!(!scratch.path("output.pdf").exists());
}

fn assert_pinned(scratch: &Scratch, report: &Value, image: ObjectId) {
    assert!(
        report["images"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["objectNumber"] != image.0),
        "{report}"
    );
    assert!(!scratch.path("output.pdf").exists());
}

fn form_drawing_photo(pdf: &mut Pdf, image: ObjectId, extra: lopdf::Dictionary) -> ObjectId {
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Form",
        "BBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => dictionary! { "XObject" => dictionary! { "Photo" => image } },
    };
    dict.extend(&extra);
    pdf.document.add_object(Stream::new(
        dict,
        b"q 600 0 0 450 0 0 cm /Photo Do Q\n".to_vec(),
    ))
}

#[test]
fn photo_an_annotation_appearance_also_draws_keeps_its_bytes() {
    let scratch = Scratch::new("annotation");
    let mut pdf = Pdf::new();
    let image = pdf.image(1200, 900, 96, false, false);
    let appearance = form_drawing_photo(&mut pdf, image, dictionary! {});
    let annotation = pdf.document.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Stamp",
        "Rect" => vec![0.into(), 0.into(), 600.into(), 450.into()],
        "AP" => dictionary! { "N" => appearance },
    });
    let page = pdf.page(
        dictionary! { "Photo" => image },
        "q 144 0 0 108 40 500 cm /Photo Do Q",
    );
    pdf.document
        .get_dictionary_mut(page)
        .unwrap()
        .set("Annots", vec![Object::Reference(annotation)]);
    pdf.save(&scratch.path("source.pdf"));

    let report = run(&scratch, &[]);

    assert_pinned(&scratch, &report, image);
}

#[test]
fn photo_a_tiling_pattern_also_draws_keeps_its_bytes() {
    let scratch = Scratch::new("pattern");
    let mut pdf = Pdf::new();
    let image = pdf.image(1200, 900, 96, false, false);
    let pattern = form_drawing_photo(
        &mut pdf,
        image,
        dictionary! {
            "Type" => "Pattern", "PatternType" => 1, "PaintType" => 1, "TilingType" => 1,
            "XStep" => 612, "YStep" => 792,
        },
    );
    let page = pdf.page(
        dictionary! { "Photo" => image },
        "q 144 0 0 108 40 500 cm /Photo Do Q",
    );
    let resources = pdf
        .document
        .get_dictionary_mut(page)
        .unwrap()
        .get_mut(b"Resources")
        .unwrap()
        .as_dict_mut()
        .unwrap();
    resources.set("Pattern", dictionary! { "P1" => pattern });
    pdf.save(&scratch.path("source.pdf"));

    let report = run(&scratch, &[]);

    assert_pinned(&scratch, &report, image);
}

#[test]
fn photo_drawn_only_on_a_skipped_page_keeps_its_bytes() {
    let scratch = Scratch::new("skipped");
    let mut pdf = Pdf::new();
    let skipped = pdf.image(1200, 900, 96, false, false);
    let optimized = pdf.image(1200, 900, 96, false, false);
    pdf.page(
        dictionary! { "Photo" => skipped },
        "q 144 0 0 108 40 500 cm /Photo Do Q",
    );
    pdf.page(
        dictionary! { "Photo" => optimized },
        "q 144 0 0 108 40 500 cm /Photo Do Q",
    );
    pdf.save(&scratch.path("source.pdf"));

    let report = run(&scratch, &[1]);

    assert_eq!(report["images"].as_array().unwrap().len(), 1);
    image_report(&report, optimized, "recompressed");
    assert_eq!(report["pages"], json!([2]));
    let output = Document::load(scratch.path("output.pdf")).unwrap();
    assert_stream_kept(&pdf.document, &output, skipped);
    assert_dimensions(&output, optimized, 400, 300);
}

fn unsupported_keeps_bytes(label: &str, modify: impl FnOnce(&mut Pdf, ObjectId), cmyk: bool) {
    let scratch = Scratch::new(label);
    let mut pdf = Pdf::new();
    let unsupported = pdf.image(1200, 900, 96, false, cmyk);
    modify(&mut pdf, unsupported);
    // An eligible neighbor forces an output, allowing a byte-for-byte check of
    // the unsupported image in the saved revision, not just a report assertion.
    let eligible = pdf.image(1200, 900, 96, false, false);
    pdf.page(
        dictionary! { "Photo" => unsupported, "Other" => eligible },
        "q 144 0 0 108 40 500 cm /Photo Do Q\nq 144 0 0 108 220 500 cm /Other Do Q",
    );
    pdf.save(&scratch.path("source.pdf"));

    let report = run(&scratch, &[]);

    image_report(&report, unsupported, "unsupported");
    image_report(&report, eligible, "recompressed");
    let output = Document::load(scratch.path("output.pdf")).unwrap();
    assert_stream_kept(&pdf.document, &output, unsupported);
    assert_dimensions(&output, eligible, 400, 300);
}

#[test]
fn soft_mask_with_matte_keeps_the_original_image() {
    unsupported_keeps_bytes(
        "matte",
        |pdf, image| {
            let mask = pdf.document.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => 1200, "Height" => 900,
                    "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                    "Matte" => vec![1.into(), 1.into(), 1.into()],
                },
                vec![255; 1200 * 900],
            ));
            pdf.document
                .get_object_mut(image)
                .unwrap()
                .as_stream_mut()
                .unwrap()
                .dict
                .set("SMask", mask);
        },
        false,
    );
}

#[test]
fn decode_array_keeps_the_original_image() {
    unsupported_keeps_bytes(
        "decode",
        |pdf, image| {
            pdf.document
                .get_object_mut(image)
                .unwrap()
                .as_stream_mut()
                .unwrap()
                .dict
                .set(
                    "Decode",
                    vec![1.into(), 0.into(), 1.into(), 0.into(), 1.into(), 0.into()],
                );
        },
        false,
    );
}

#[test]
fn gray_color_space_over_a_color_jpeg_keeps_the_original_image() {
    unsupported_keeps_bytes(
        "gray-over-color",
        |pdf, image| {
            pdf.document
                .get_object_mut(image)
                .unwrap()
                .as_stream_mut()
                .unwrap()
                .dict
                .set("ColorSpace", "DeviceGray");
        },
        false,
    );
}

#[test]
fn cmyk_jpeg_keeps_the_original_image() {
    unsupported_keeps_bytes("cmyk", |_, _| {}, true);
}

#[test]
fn four_component_jpeg_keeps_the_original_image_even_with_an_rgb_dictionary() {
    unsupported_keeps_bytes(
        "cmyk-as-rgb",
        |pdf, image| {
            // Use an eligible dictionary so the actual four-component JPEG is
            // examined, rather than rejected just because /DeviceCMYK is unsupported.
            pdf.document
                .get_object_mut(image)
                .unwrap()
                .as_stream_mut()
                .unwrap()
                .dict
                .set("ColorSpace", "DeviceRGB");
        },
        true,
    );
}

#[test]
fn neutral_icc_rgb_photo_is_saved_as_one_component_device_gray() {
    let scratch = Scratch::new("icc-gray");
    let mut pdf = Pdf::new();
    let image = pdf.image(1200, 900, 96, true, false);
    let profile = pdf.document.add_object(Stream::new(
        dictionary! { "N" => 3, "Alternate" => "DeviceRGB" },
        vec![],
    ));
    pdf.document
        .get_object_mut(image)
        .unwrap()
        .as_stream_mut()
        .unwrap()
        .dict
        .set(
            "ColorSpace",
            vec![
                Object::Name(b"ICCBased".to_vec()),
                Object::Reference(profile),
            ],
        );
    pdf.page(
        dictionary! { "Photo" => image },
        "q 144 0 0 108 40 500 cm /Photo Do Q",
    );
    pdf.save(&scratch.path("source.pdf"));

    let report = run(&scratch, &[]);

    image_report(&report, image, "recompressed");
    let output = Document::load(scratch.path("output.pdf")).unwrap();
    assert_dimensions(&output, image, 400, 300);
    let image = stream(&output, image);
    assert_eq!(
        image.dict.get(b"ColorSpace").unwrap().as_name().unwrap(),
        b"DeviceGray"
    );
    // JPEG SOF0 stores precision, height, width, then component count.
    let sof = image
        .content
        .windows(2)
        .position(|bytes| bytes == [0xff, 0xc0])
        .unwrap();
    assert_eq!(image.content[sof + 9], 1);
}
