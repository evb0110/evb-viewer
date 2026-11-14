#[path = "../../test-support/external_tool.rs"]
mod external_tool;

use lopdf::{Document, Object};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/damaged-recovery")
        .join(name)
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "damaged-recovery-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn edit(command: &str, input: &Path, output: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .arg(command)
        .arg("--input")
        .arg(input)
        .arg("--output")
        .arg(output)
        .args(args)
        .output()
        .unwrap()
}

fn assert_ok(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn object_damage_is_recoverable_only_for_the_edited_document() {
    let scratch = Scratch::new();
    let damaged = fixture("object-identity.pdf");
    let healthy = fixture("healthy.pdf");
    let original = fs::read(&damaged).unwrap();
    let output = scratch.0.join("edited.pdf");
    let pages = scratch.0.join("pages.txt");
    fs::write(&pages, "1\n").unwrap();
    let args = ["--pages-file", pages.to_str().unwrap()];
    let refused = edit("delete-pages", &damaged, &output, &args);
    assert!(!refused.status.success());
    let envelope: serde_json::Value = serde_json::from_slice(&refused.stderr).unwrap();
    assert_eq!(envelope["code"], "corrupt-xref");
    assert!(envelope["message"]
        .as_str()
        .unwrap()
        .contains("not at its xref offset"));
    assert!(
        !output.exists(),
        "a refusal must not publish partial output"
    );

    let inserted = edit(
        "insert-pages",
        &healthy,
        &output,
        &["--source", damaged.to_str().unwrap(), "--after-page", "1"],
    );
    assert!(!inserted.status.success());
    let envelope: serde_json::Value = serde_json::from_slice(&inserted.stderr).unwrap();
    assert_eq!(
        envelope["code"], "invalid-request",
        "damage to an inserted source must not trigger repair of the destination"
    );

    let repaired = scratch.0.join("repaired.pdf");
    let qpdf = external_tool::tool_path("QPDF_PATH", "qpdf", "qpdf");
    let repair = Command::new(&qpdf)
        .arg(&damaged)
        .arg(&repaired)
        .output()
        .unwrap();
    assert!(
        matches!(repair.status.code(), Some(0 | 3)),
        "{}",
        String::from_utf8_lossy(&repair.stderr)
    );
    assert_ok(edit("delete-pages", &repaired, &output, &args));
    let saved = Document::load(&output).unwrap();
    assert_eq!(saved.get_pages().len(), 1);
    assert!(saved.extract_text(&[1]).unwrap().contains("Second page"));
    assert_ok(
        Command::new(&qpdf)
            .arg("--check")
            .arg(&output)
            .output()
            .unwrap(),
    );
    assert_eq!(fs::read(&damaged).unwrap(), original);
}

#[test]
fn inserted_form_drops_non_dictionary_fields_and_keeps_the_valid_field() {
    let scratch = Scratch::new();
    let qpdf = external_tool::tool_path("QPDF_PATH", "qpdf", "qpdf");
    // Both the inserted-form and primary-form traversal must filter invalid entries.
    for (primary, source) in [
        ("healthy.pdf", "invalid-fields.pdf"),
        ("invalid-fields.pdf", "healthy.pdf"),
    ] {
        let output = scratch.0.join(primary);
        assert_ok(edit(
            "insert-pages",
            &fixture(primary),
            &output,
            &[
                "--source",
                fixture(source).to_str().unwrap(),
                "--after-page",
                "1",
            ],
        ));
        let saved = Document::load(&output).unwrap();
        assert_eq!(saved.get_pages().len(), 4);
        let root = saved.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let form = saved
            .get_dictionary(root)
            .unwrap()
            .get(b"AcroForm")
            .unwrap();
        let form = saved.dereference(form).unwrap().1.as_dict().unwrap();
        let fields = saved
            .dereference(form.get(b"Fields").unwrap())
            .unwrap()
            .1
            .as_array()
            .unwrap();
        assert_eq!(fields.len(), 1);
        let field = saved.dereference(&fields[0]).unwrap().1.as_dict().unwrap();
        assert_eq!(field.get(b"T").unwrap().as_str().unwrap(), b"Retained");
        assert_eq!(field.get(b"V").unwrap().as_str().unwrap(), b"value");
        assert!(fields
            .iter()
            .all(|field| matches!(saved.dereference(field).unwrap().1, Object::Dictionary(_))));
        assert_ok(
            Command::new(&qpdf)
                .arg("--check")
                .arg(&output)
                .output()
                .unwrap(),
        );
    }
}
