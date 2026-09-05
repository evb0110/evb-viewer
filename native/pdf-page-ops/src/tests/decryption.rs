// Fixtures and regression proofs for the decrypt operation (#171). All
// fixtures are generated in-process with the pinned lopdf, so the tests stay
// hermetic and cover the revisions the writer claims to support: R3 (RC4),
// R4 (AESV2) and R6 (AESV3).

fn decryption_fixture_document() -> Document {
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
    document
}

fn encrypt_fixture(version: lopdf::EncryptionVersion) -> Vec<u8> {
    let mut document = decryption_fixture_document();
    let encryption_state =
        lopdf::EncryptionState::try_from(version).expect("build encryption state");
    document.encrypt(&encryption_state).expect("encrypt fixture");
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).expect("serialize fixture");
    bytes
}

fn rc4_r3_fixture(user_password: &str) -> Vec<u8> {
    encrypt_fixture(
        lopdf::EncryptionVersion::V2 {
            document: &decryption_fixture_document(),
            owner_password: "owner-secret",
            user_password,
            key_length: 128,
            permissions: lopdf::Permissions::all(),
        },
    )
}

fn aesv2_r4_fixture(user_password: &str) -> Vec<u8> {
    use lopdf::encryption::crypt_filters::{Aes128CryptFilter, CryptFilter};
    let mut crypt_filters = BTreeMap::new();
    crypt_filters.insert(
        b"StdCF".to_vec(),
        std::sync::Arc::new(Aes128CryptFilter) as std::sync::Arc<dyn CryptFilter>,
    );
    encrypt_fixture(
        lopdf::EncryptionVersion::V4 {
            document: &decryption_fixture_document(),
            encrypt_metadata: true,
            crypt_filters,
            stream_filter: b"StdCF".to_vec(),
            string_filter: b"StdCF".to_vec(),
            owner_password: "owner-secret",
            user_password,
            permissions: lopdf::Permissions::all(),
        },
    )
}

fn aesv3_r6_fixture(user_password: &str) -> Vec<u8> {
    use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
    let mut crypt_filters = BTreeMap::new();
    crypt_filters.insert(
        b"StdCF".to_vec(),
        std::sync::Arc::new(Aes256CryptFilter) as std::sync::Arc<dyn CryptFilter>,
    );
    encrypt_fixture(
        lopdf::EncryptionVersion::V5 {
            encrypt_metadata: true,
            crypt_filters,
            file_encryption_key: &[7u8; 32],
            stream_filter: b"StdCF".to_vec(),
            string_filter: b"StdCF".to_vec(),
            owner_password: "owner-secret",
            user_password,
            permissions: lopdf::Permissions::all(),
        },
    )
}

fn write_fixture(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).expect("write encrypted fixture");
}

#[test]
fn structural_encryption_probe_ignores_an_encrypt_token_in_pdf_content() {
    let input_path = temp_pdf_path("decrypt-structural-probe");
    let mut document = decryption_fixture_document();
    document.add_object(Object::string_literal("page content says /Encrypt"));
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).expect("serialize plaintext fixture");
    write_fixture(&input_path, &bytes);

    assert!(!path_has_encryption_entry(&input_path).expect("probe plaintext trailer"));

    let _ = std::fs::remove_file(&input_path);
}

fn read_outcome_report(output_path: &Path) -> serde_json::Value {
    let sidecar_path = decrypt_outcome_sidecar_path(output_path);
    let bytes = std::fs::read(&sidecar_path)
        .unwrap_or_else(|error| panic!("decrypt outcome sidecar missing: {error}"));
    serde_json::from_slice(&bytes).expect("parse decrypt outcome sidecar")
}

fn assert_encryption_dropped_and_id_preserved(input_path: &Path, output_path: &Path) {
    let input = Document::load_mem_with_options(
        &std::fs::read(input_path).expect("read encrypted input"),
        lopdf::LoadOptions::with_password("user-secret"),
    )
    .expect("reload encrypted input with its password");
    let output = Document::load_mem(&std::fs::read(output_path).expect("read decrypted output"))
        .expect("reload decrypted output");
    assert!(!output.was_encrypted(), "output must not carry encryption state");
    assert!(!output.is_encrypted(), "output trailer must have no /Encrypt entry");
    let input_id = input.trailer.get(b"ID").expect("input trailer /ID");
    let output_id = output.trailer.get(b"ID").expect("output trailer /ID");
    assert_eq!(input_id, output_id, "/ID must survive the decrypt rewrite byte-identical");
    assert!(output.get_pages().contains_key(&1), "page tree must survive the rewrite");
}

#[test]
fn decrypts_an_rc4_r3_user_password_file_and_drops_the_encrypt_dictionary() {
    let input_path = temp_pdf_path("decrypt-r3-input");
    let output_path = temp_pdf_path("decrypt-r3-output");
    write_fixture(&input_path, &rc4_r3_fixture("user-secret"));

    write_decrypted_pdf_with_password(&input_path, &output_path, Some("user-secret"))
        .expect("decrypt R3");

    let report = read_outcome_report(&output_path);
    assert_eq!(report["outcome"], "rewritten");
    assert_eq!(report["wasEncrypted"], true);
    assert_eq!(report["revision"], 3);
    assert_eq!(report["format"], "evb-pdf-decrypt");
    assert_encryption_dropped_and_id_preserved(&input_path, &output_path);

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);
    let _ = std::fs::remove_file(decrypt_outcome_sidecar_path(&output_path));
}

#[test]
fn decrypts_an_aesv2_r4_user_password_file() {
    let input_path = temp_pdf_path("decrypt-r4-input");
    let output_path = temp_pdf_path("decrypt-r4-output");
    write_fixture(&input_path, &aesv2_r4_fixture("user-secret"));

    write_decrypted_pdf_with_password(&input_path, &output_path, Some("user-secret"))
        .expect("decrypt R4");

    let report = read_outcome_report(&output_path);
    assert_eq!(report["outcome"], "rewritten");
    assert_eq!(report["revision"], 4);
    assert_encryption_dropped_and_id_preserved(&input_path, &output_path);

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);
    let _ = std::fs::remove_file(decrypt_outcome_sidecar_path(&output_path));
}

#[test]
fn removes_the_published_pdf_when_its_outcome_sidecar_cannot_be_written() {
    let input_path = temp_pdf_path("decrypt-sidecar-failure-input");
    let output_path = temp_pdf_path("decrypt-sidecar-failure-output");
    let sidecar_path = decrypt_outcome_sidecar_path(&output_path);
    write_fixture(&input_path, &rc4_r3_fixture("user-secret"));
    std::fs::create_dir(&sidecar_path).expect("reserve the sidecar path as a directory");

    let error = write_decrypted_pdf_with_password(&input_path, &output_path, Some("user-secret"))
        .expect_err("sidecar directory must make the decrypt operation fail");
    assert_eq!(
        error.downcast_ref::<NativeError>().unwrap().code,
        NativeErrorCode::Io
    );
    assert!(
        !output_path.exists(),
        "a failed outcome sidecar must not leave a published plaintext PDF"
    );
    assert!(sidecar_path.is_dir());

    let _ = std::fs::remove_dir(&sidecar_path);
    let _ = std::fs::remove_file(&input_path);
}

#[test]
fn decrypts_an_aes256_r6_file_with_the_user_password() {
    let input_path = temp_pdf_path("decrypt-r6-user-input");
    let output_path = temp_pdf_path("decrypt-r6-user-output");
    write_fixture(&input_path, &aesv3_r6_fixture("user-secret"));

    write_decrypted_pdf_with_password(&input_path, &output_path, Some("user-secret"))
        .expect("decrypt R6");

    let report = read_outcome_report(&output_path);
    assert_eq!(report["outcome"], "rewritten");
    assert_eq!(report["revision"], 6);
    assert_encryption_dropped_and_id_preserved(&input_path, &output_path);

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);
    let _ = std::fs::remove_file(decrypt_outcome_sidecar_path(&output_path));
}

#[test]
fn decrypts_an_aes256_r6_file_with_the_owner_password() {
    let input_path = temp_pdf_path("decrypt-r6-owner-input");
    let output_path = temp_pdf_path("decrypt-r6-owner-output");
    write_fixture(&input_path, &aesv3_r6_fixture("user-secret"));

    // Revisions 5 and 6 accept the owner password as well as the user password.
    write_decrypted_pdf_with_password(&input_path, &output_path, Some("owner-secret"))
        .expect("decrypt R6 with the owner password");

    let report = read_outcome_report(&output_path);
    assert_eq!(report["outcome"], "rewritten");
    assert_eq!(report["wasEncrypted"], true);
    let output = Document::load_mem(&std::fs::read(&output_path).expect("read output"))
        .expect("reload decrypted output");
    assert!(!output.is_encrypted());

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);
    let _ = std::fs::remove_file(decrypt_outcome_sidecar_path(&output_path));
}

#[test]
fn reports_needs_password_when_the_password_is_wrong_or_missing() {
    let input_path = temp_pdf_path("decrypt-wrong-input");
    let output_path = temp_pdf_path("decrypt-wrong-output");
    write_fixture(&input_path, &rc4_r3_fixture("user-secret"));

    for password in [Some("wrong"), None] {
        let error = write_decrypted_pdf_with_password(&input_path, &output_path, password)
            .expect_err("wrong or missing password must fail");
        let native_error = error
            .downcast_ref::<NativeError>()
            .unwrap_or_else(|| panic!("expected a typed native error, got {error}"));
        assert_eq!(native_error.code, NativeErrorCode::NeedsPassword);
        assert!(!output_path.exists(), "working copy must stay unmodified");
        assert!(
            !decrypt_outcome_sidecar_path(&output_path).exists(),
            "no sidecar may be written on failure"
        );
    }

    let _ = std::fs::remove_file(&input_path);
}

#[test]
fn reports_unsupported_filter_for_a_public_key_handler() {
    let input_path = temp_pdf_path("decrypt-pubsec-input");
    let output_path = temp_pdf_path("decrypt-pubsec-output");
    let mut document = decryption_fixture_document();
    let encrypt_dict = dictionary! {
        "Filter" => "Adobe.PubSec",
        "V" => 4,
        "R" => 4,
        "O" => Object::String(vec![0u8; 32], StringFormat::Literal),
        "U" => Object::String(vec![0u8; 32], StringFormat::Literal),
        "P" => -1,
    };
    let encrypt_id = document.add_object(encrypt_dict);
    document.trailer.set("Encrypt", Object::Reference(encrypt_id));
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).expect("serialize fixture");
    write_fixture(&input_path, &bytes);

    let error = write_decrypted_pdf_with_password(&input_path, &output_path, None)
        .expect_err("public-key security handler must fail");
    let native_error = error
        .downcast_ref::<NativeError>()
        .unwrap_or_else(|| panic!("expected a typed native error, got {error}"));
    assert_eq!(native_error.code, NativeErrorCode::UnsupportedFilter);

    let _ = std::fs::remove_file(&input_path);
}

#[test]
fn opens_an_owner_restricted_file_silently_by_decrypting_the_working_copy() {
    // Owner-only restriction: an empty user password. lopdf authenticates the
    // empty password at load, so no password needs to reach the user and the
    // working copy is still rewritten to plaintext (never left encrypted).
    let input_path = temp_pdf_path("decrypt-owner-only-input");
    let output_path = temp_pdf_path("decrypt-owner-only-output");
    write_fixture(&input_path, &aesv3_r6_fixture(""));

    write_decrypted_pdf_with_password(&input_path, &output_path, None)
        .expect("owner-restricted file must open silently");

    let report = read_outcome_report(&output_path);
    assert_eq!(report["outcome"], "rewritten");
    assert_eq!(report["wasEncrypted"], true);
    assert_eq!(report["revision"], 6);
    let output = Document::load_mem(&std::fs::read(&output_path).expect("read output"))
        .expect("reload decrypted output");
    assert!(!output.is_encrypted());

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);
    let _ = std::fs::remove_file(decrypt_outcome_sidecar_path(&output_path));
}

#[test]
fn opens_an_unencrypted_file_silently_without_rewriting() {
    let input_path = temp_pdf_path("decrypt-plain-input");
    let output_path = temp_pdf_path("decrypt-plain-output");
    let mut document = decryption_fixture_document();
    let mut bytes = Vec::new();
    document.save_to(&mut bytes).expect("serialize fixture");
    write_fixture(&input_path, &bytes);

    write_decrypted_pdf_with_password(&input_path, &output_path, Some("ignored"))
        .expect("unencrypted input must open without a rewrite");

    let report = read_outcome_report(&output_path);
    assert_eq!(report["outcome"], "opened");
    assert_eq!(report["wasEncrypted"], false);
    assert_eq!(report["revision"], serde_json::Value::Null);
    assert!(!output_path.exists(), "unprotected files are never reserialized");

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(decrypt_outcome_sidecar_path(&output_path));
}

#[test]
fn refuses_to_decrypt_when_the_output_aliases_the_input() {
    let input_path = temp_pdf_path("decrypt-alias-input");
    let input = rc4_r3_fixture("user-secret");
    write_fixture(&input_path, &input);

    let error = write_decrypted_pdf_with_password(&input_path, &input_path, Some("user-secret"))
        .expect_err("decrypt must reject an aliased output path");
    assert!(error.to_string().contains("Output aliases an input file"));
    assert_eq!(std::fs::read(&input_path).unwrap(), input);

    let _ = std::fs::remove_file(&input_path);
}

#[test]
fn refuses_an_incremental_append_onto_an_empty_password_encrypted_base() {
    // #154 hazard: lopdf auto-decrypts empty-password files, so is_encrypted()
    // is false after load. The widened guard must still refuse the append.
    let input_path = temp_pdf_path("decrypt-append-input");
    let output_path = temp_pdf_path("decrypt-append-output");
    write_fixture(&input_path, &aesv2_r4_fixture(""));

    let error = append_native_mutations_with_qpdf(
        &input_path,
        &output_path,
        &NativeMutationsFile::default(),
        "D:20260809120000Z",
        None,
        None,
    )
    .expect_err("an encrypted base must refuse incremental appends");
    let native_error = error
        .downcast_ref::<NativeError>()
        .unwrap_or_else(|| panic!("expected a typed native error, got {error}"));
    assert_eq!(native_error.code, NativeErrorCode::Encrypted);

    let _ = std::fs::remove_file(&input_path);
}
