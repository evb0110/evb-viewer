use lopdf::{
    dictionary, Document, EncryptionState, EncryptionVersion, Object, Permissions, StringFormat,
};
use serde_json::Value;
use std::{
    env,
    fs::{read, remove_file, write},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::symlink;

const USER_PASSWORD: &str = "s3cret-value";

fn path(label: &str, extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    env::temp_dir().join(format!(
        "evb-pdf-page-ops-decrypt-{label}-{nonce}.{extension}"
    ))
}

fn run_decrypt(input: &Path, output: &Path, password_file: Option<&Path>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"));
    command
        .args(["decrypt", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output);
    if let Some(password_file) = password_file {
        command.arg("--password-file").arg(password_file);
    }
    command.output().unwrap()
}

fn run_append_mutations(input: &Path, output: &Path, mutations: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_evb-pdf-page-ops"))
        .args(["save-mutations", "--input"])
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--mutations-file")
        .arg(mutations)
        .args(["--modified-at", "D:20260809120000Z", "--append"])
        .output()
        .unwrap()
}

/// Builds the R3 (RC4, 128-bit) fixture the same way the unit tests do: an
/// in-process lopdf document encrypted with the standard security handler.
fn rc4_r3_fixture(user_password: &str) -> Vec<u8> {
    let mut document = Document::with_version("1.5");
    document.trailer.set(
        "ID",
        Object::Array(vec![
            Object::String((1u8..=16).collect(), StringFormat::Literal),
            Object::String(((1..=16u8).rev()).collect(), StringFormat::Literal),
        ]),
    );
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
    });
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
    let encryption_state = EncryptionState::try_from(EncryptionVersion::V2 {
        document: &document,
        owner_password: "owner-secret",
        user_password,
        key_length: 128,
        permissions: Permissions::all(),
    })
    .unwrap();
    document.encrypt(&encryption_state).unwrap();
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

fn plaintext_fixture() -> Vec<u8> {
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
    });
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
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).unwrap();
    bytes
}

fn write_password_file(path: &Path, password: &str, trailing_newline: bool) {
    let mut file = std::fs::File::create(path).unwrap();
    file.write_all(password.as_bytes()).unwrap();
    if trailing_newline {
        file.write_all(b"\n").unwrap();
    }
}

fn error_envelope(output: &Output) -> Value {
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("invalid native error envelope ({error}): {stderr}"))
}

#[test]
fn decrypt_exits_with_needs_password_when_no_password_is_supplied() {
    let input = path("needs-password-input", "pdf");
    let output = path("needs-password-output", "pdf");
    write(&input, rc4_r3_fixture(USER_PASSWORD)).unwrap();

    let result = run_decrypt(&input, &output, None);

    let envelope = error_envelope(&result);
    assert_eq!(envelope["code"], "needs-password");
    assert!(
        !output.exists(),
        "a failed decrypt must not create the working copy"
    );

    let _ = remove_file(&input);
}

#[test]
fn decrypt_with_the_correct_password_writes_a_plaintext_rewrite() {
    let input = path("correct-input", "pdf");
    let output = path("correct-output", "pdf");
    let password_file = path("correct-password", "txt");
    write(&input, rc4_r3_fixture(USER_PASSWORD)).unwrap();
    // The trailing newline proves the single-newline trim on the password file.
    write_password_file(&password_file, USER_PASSWORD, true);

    let result = run_decrypt(&input, &output, Some(&password_file));

    assert!(
        result.status.success(),
        "decrypt failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let document =
        Document::load_mem(&read(&output).unwrap()).expect("reload decrypted working copy");
    assert!(!document.was_encrypted());
    assert!(!document.is_encrypted());
    let sidecar_path = output.parent().unwrap().join(format!(
        "{}.decrypt.json",
        output.file_name().unwrap().to_string_lossy()
    ));
    let sidecar: Value = serde_json::from_slice(&read(&sidecar_path).unwrap())
        .expect("parse decrypt outcome sidecar");
    assert_eq!(sidecar["outcome"], "rewritten");
    assert_eq!(sidecar["wasEncrypted"], true);
    assert_eq!(sidecar["revision"], 3);

    for file in [input, output, password_file, sidecar_path] {
        let _ = remove_file(file);
    }
}

#[test]
fn decrypt_reports_needs_password_for_a_wrong_password_without_touching_the_output() {
    let input = path("wrong-input", "pdf");
    let output = path("wrong-output", "pdf");
    let password_file = path("wrong-password", "txt");
    write(&input, rc4_r3_fixture(USER_PASSWORD)).unwrap();
    write(&output, b"sentinel-working-copy").unwrap();
    write_password_file(&password_file, "not-the-password", false);

    let result = run_decrypt(&input, &output, Some(&password_file));

    let envelope = error_envelope(&result);
    assert_eq!(envelope["code"], "needs-password");
    assert_eq!(read(&output).unwrap(), b"sentinel-working-copy");

    for file in [input, output, password_file] {
        let _ = remove_file(file);
    }
}

#[test]
fn decrypt_rejects_a_password_file_that_aliases_the_input_or_output() {
    let input = path("alias-input", "pdf");
    let output = path("alias-output", "pdf");
    write(&input, rc4_r3_fixture(USER_PASSWORD)).unwrap();
    write(&output, b"existing-output").unwrap();

    let input_alias = run_decrypt(&input, &output, Some(&input));
    let input_error = error_envelope(&input_alias);
    assert_eq!(input_error["code"], "native-failure");
    assert_eq!(read(&output).unwrap(), b"existing-output");

    let output_alias = run_decrypt(&input, &output, Some(&output));
    let output_error = error_envelope(&output_alias);
    assert_eq!(output_error["code"], "native-failure");
    assert_eq!(read(&output).unwrap(), b"existing-output");

    for file in [input, output] {
        let _ = remove_file(file);
    }
}

#[cfg(unix)]
#[test]
fn decrypt_rejects_a_symlinked_password_file_that_aliases_the_output() {
    let input = path("symlink-input", "pdf");
    let output = path("symlink-output", "pdf");
    let password_link = path("symlink-password", "txt");
    write(&input, rc4_r3_fixture(USER_PASSWORD)).unwrap();
    write(&output, b"existing-output").unwrap();
    symlink(&output, &password_link).unwrap();

    let result = run_decrypt(&input, &output, Some(&password_link));

    let envelope = error_envelope(&result);
    assert_eq!(envelope["code"], "native-failure");
    assert_eq!(read(&output).unwrap(), b"existing-output");

    for file in [input, output, password_link] {
        let _ = remove_file(file);
    }
}

#[test]
fn decrypt_never_echoes_the_password_in_stdout_or_stderr() {
    let input = path("echo-input", "pdf");
    let output = path("echo-output", "pdf");
    let password_file = path("echo-password", "txt");
    let sidecar_path = output.parent().unwrap().join(format!(
        "{}.decrypt.json",
        output.file_name().unwrap().to_string_lossy()
    ));
    write(&input, rc4_r3_fixture(USER_PASSWORD)).unwrap();
    write_password_file(&password_file, USER_PASSWORD, false);

    let failing = run_decrypt(&input, &output, None);
    let succeeding = run_decrypt(&input, &output, Some(&password_file));

    for result in [failing, succeeding] {
        let stdout = String::from_utf8_lossy(&result.stdout);
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(!stdout.contains(USER_PASSWORD));
        assert!(!stderr.contains(USER_PASSWORD));
    }
    let sidecar_bytes = read(&sidecar_path).expect("read decrypt outcome sidecar");
    assert!(!String::from_utf8_lossy(&sidecar_bytes).contains(USER_PASSWORD));

    for file in [input, output, password_file, sidecar_path] {
        let _ = remove_file(file);
    }
}

#[test]
fn decrypt_opens_an_unencrypted_file_without_writing_output() {
    let input = path("plain-input", "pdf");
    let output = path("plain-output", "pdf");
    write(&input, plaintext_fixture()).unwrap();

    let result = run_decrypt(&input, &output, None);

    assert!(
        result.status.success(),
        "decrypt failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        !output.exists(),
        "an unprotected file must not be reserialized"
    );
    let sidecar_path = output.parent().unwrap().join(format!(
        "{}.decrypt.json",
        output.file_name().unwrap().to_string_lossy()
    ));
    let sidecar: Value = serde_json::from_slice(&read(&sidecar_path).unwrap())
        .expect("parse decrypt outcome sidecar");
    assert_eq!(sidecar["outcome"], "opened");
    assert_eq!(sidecar["wasEncrypted"], false);

    let _ = remove_file(&input);
    let _ = remove_file(sidecar_path);
}

#[test]
fn save_mutations_append_refuses_an_empty_password_encrypted_base() {
    let input = path("append-input", "pdf");
    let output = path("append-output", "pdf");
    let mutations = path("append-mutations", "json");
    write(&input, rc4_r3_fixture("")).unwrap();
    write(
        &mutations,
        // The CLI requires at least one real mutation before it loads the PDF,
        // so the guard probe carries a minimal free-text note.
        r#"{"freeTextNotes":[{"pageIndex":0,"stableKey":"guard-probe","text":"probe","markerRect":{"left":0.1,"top":0.1,"width":0.2,"height":0.2}}]}"#,
    )
    .unwrap();

    let result = run_append_mutations(&input, &output, &mutations);

    let envelope = error_envelope(&result);
    assert_eq!(envelope["code"], "encrypted");

    let _ = remove_file(&input);
    let _ = remove_file(&mutations);
}
