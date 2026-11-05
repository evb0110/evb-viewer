    fn minimal_jpeg_bytes() -> Vec<u8> {
        vec![
            0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01,
            0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xFF, 0xD9,
        ]
    }

    thread_local! {
        static PLACED_IMAGE_TEMP_FILES: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    struct PlacedImageTestCleanup;

    impl Drop for PlacedImageTestCleanup {
        fn drop(&mut self) {
            let paths = PLACED_IMAGE_TEMP_FILES.with(|files| std::mem::take(&mut *files.borrow_mut()));
            for path in paths {
                let _ = remove_file(path);
            }
        }
    }

    struct PlacedImageContinuationCleanup {
        pdf_path: PathBuf,
    }

    impl Drop for PlacedImageContinuationCleanup {
        fn drop(&mut self) {
            let _ = remove_file(&self.pdf_path);
        }
    }

    fn placed_jpeg_mutation() -> PlacedImage {
        let bytes_path = temp_pdf_path("placed-image-jpeg");
        let bytes = minimal_jpeg_bytes();
        write(&bytes_path, &bytes).unwrap();
        PLACED_IMAGE_TEMP_FILES.with(|files| files.borrow_mut().push(bytes_path.clone()));
        PlacedImage {
            author: None,
            bytes_base64: None,
            page_index: 0,
            stable_key: None,
            annotation_id: None,
            x: 0.1,
            y: 0.25,
            width: 0.3,
            height: 0.2,
            rotation_degrees: Some(15.0),
            mime_type: "image/jpeg".to_string(),
            bytes_path,
            byte_length: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
            validated_bytes: std::cell::RefCell::new(None),
        }
    }

    #[test]
    fn rejects_placed_image_sidecars_whose_manifest_no_longer_matches() {
        let _sidecar_cleanup = PlacedImageTestCleanup;
        let mut image = placed_jpeg_mutation();
        image.sha256 = "0".repeat(64);
        let error = validate_placed_images(&[image]).unwrap_err();
        let native_error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::InvalidRequest);
    }

    #[test]
    fn placed_image_metadata_limits_reject_before_opening_payloads() {
        let _sidecar_cleanup = PlacedImageTestCleanup;
        use std::cell::Cell;
        use std::fs::File;

        let mut image = placed_jpeg_mutation();
        File::options()
            .write(true)
            .open(&image.bytes_path)
            .unwrap()
            .set_len(5)
            .unwrap();
        image.byte_length = 4;
        let open_count = Cell::new(0usize);
        let error = validate_placed_image_payloads_with_limits_and_open(
            &[image],
            4,
            8,
            |path| {
                open_count.set(open_count.get() + 1);
                File::open(path)
            },
        )
        .unwrap_err();

        assert_eq!(
            error.downcast_ref::<NativeError>().unwrap().code,
            NativeErrorCode::TooLarge
        );
        assert_eq!(open_count.get(), 0);
    }

    #[test]
    fn placed_image_aggregate_limit_is_checked_before_any_payload_read() {
        let _sidecar_cleanup = PlacedImageTestCleanup;
        use std::cell::Cell;
        use std::fs::File;

        let mut images = [placed_jpeg_mutation(), placed_jpeg_mutation()];
        for image in &mut images {
            write(&image.bytes_path, b"ab").unwrap();
            image.byte_length = 2;
            image.sha256 = sha256_hex(b"ab");
        }
        let open_count = Cell::new(0usize);
        let error = validate_placed_image_payloads_with_limits_and_open(
            &images,
            4,
            3,
            |path| {
                open_count.set(open_count.get() + 1);
                File::open(path)
            },
        )
        .unwrap_err();

        let native_error = error.downcast_ref::<NativeError>().unwrap();
        assert_eq!(native_error.code, NativeErrorCode::TooLarge);
        assert!(native_error.message.contains("3-byte aggregate admission ceiling"));
        assert_eq!(open_count.get(), 0);
    }

    #[test]
    fn placed_image_apply_reuses_validated_bytes_after_sidecar_removal() {
        let _sidecar_cleanup = PlacedImageTestCleanup;
        let (mut document, page_id) = create_test_document();
        let image = placed_jpeg_mutation();
        let image_path = image.bytes_path.clone();
        let mutations = NativeMutationsFile {
            placed_images: vec![image],
            ..NativeMutationsFile::default()
        };
        validate_placed_images(&mutations.placed_images).unwrap();
        remove_file(&image_path).unwrap();

        apply_native_mutations(&mut document, &mutations, "D:20260609123456Z").unwrap();

        assert_eq!(get_page_annots(&document, page_id).unwrap().len(), 1);
    }

    #[test]
    fn patches_an_existing_stamp_without_dropping_foreign_keys() {
        let (mut document, page_id) = create_test_document();
        let first = placed_jpeg_mutation();
        let first_path = first.bytes_path.clone();
        let mut first = first;
        first.stable_key = Some("stamp-preserve".to_string());
        let first_bytes = read(&first_path).unwrap();
        apply_placed_images(
            &mut document,
            std::slice::from_ref(&first),
            vec![first_bytes],
            0,
            "D:20260831130000Z",
            &mut None,
        )
        .unwrap();
        let stamp_ref = get_page_annots(&document, page_id).unwrap()[0]
            .as_reference()
            .unwrap();
        let stamp = document.get_dictionary_mut(stamp_ref).unwrap();
        stamp.set(
            "NM",
            Object::string_literal("placed-image-native:stamp-preserve"),
        );
        stamp.set("RC", Object::string_literal("<p>rich stamp</p>"));
        stamp.set("State", Object::Name(b"Accepted".to_vec()));
        stamp.set("IRT", Object::Reference((900, 0)));
        stamp.set("UnknownKey", Object::Integer(77));
        let before = stamp.clone();

        let updated = placed_jpeg_mutation();
        let updated_path = updated.bytes_path.clone();
        let mut updated = updated;
        updated.stable_key = Some("stamp-preserve".to_string());
        updated.annotation_id = Some(format!("{} {} R", stamp_ref.0, stamp_ref.1));
        updated.x = 0.5;
        let updated_bytes = read(&updated_path).unwrap();
        apply_placed_images(
            &mut document,
            std::slice::from_ref(&updated),
            vec![updated_bytes],
            0,
            "D:20260831130100Z",
            &mut None,
        )
        .unwrap();

        let after = document.get_dictionary(stamp_ref).unwrap();
        assert_unowned_keys_unchanged(
            &before,
            after,
            &[b"Rect", b"AP", b"F", b"NM", b"M"],
        )
        .unwrap();
        assert_eq!(
            read_annotation_name(after).as_deref(),
            Some("placed-image-native:stamp-preserve")
        );
        let _ = remove_file(first_path);
        let _ = remove_file(updated_path);
    }

    #[test]
    fn deleting_a_foreign_stamp_keeps_a_shared_placed_image_appearance() {
        let (mut document, page_id) = create_test_document();
        let managed = placed_jpeg_mutation();
        let managed_path = managed.bytes_path.clone();
        let managed_bytes = read(&managed_path).unwrap();
        apply_placed_images(
            &mut document,
            std::slice::from_ref(&managed),
            vec![managed_bytes],
            0,
            "D:20260831130000Z",
            &mut None,
        )
        .unwrap();
        let managed_ref = get_page_annots(&document, page_id).unwrap()[0]
            .as_reference()
            .unwrap();
        let (appearance_ref, image_ref) = placed_image_appearance_refs(&document, managed_ref)
            .expect("managed stamp appearance graph");

        let foreign_ref = document.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Stamp",
            "Rect" => vec![30.into(), 30.into(), 60.into(), 60.into()],
            "NM" => Object::string_literal("foreign-stamp"),
            "AP" => dictionary! { "N" => Object::Reference(appearance_ref) },
        });
        let mut annots = get_page_annots(&document, page_id).unwrap();
        annots.push(Object::Reference(foreign_ref));
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", Object::Array(annots));

        delete_annotations(
            &mut document,
            &[AnnotationDelete {
                page_index: 0,
                object_number: Some(foreign_ref.0),
                generation_number: Some(foreign_ref.1),
                stable_key: None,
                created_at: None,
            }],
        )
        .unwrap();

        assert_eq!(
            get_page_annots(&document, page_id).unwrap(),
            vec![Object::Reference(managed_ref)]
        );
        assert!(document.get_dictionary(managed_ref).is_ok());
        assert!(document.get_object(appearance_ref).is_ok());
        assert!(document.get_object(image_ref).is_ok());
        assert!(document.get_object(foreign_ref).is_err());
        let _ = remove_file(managed_path);
    }

    #[test]
    fn rejects_duplicate_stable_placed_image_targets_without_an_exact_ref() {
        let _sidecar_cleanup = PlacedImageTestCleanup;
        let (mut document, page_id) = create_test_document();
        let stable_key = "placed-image-duplicate";
        let stamp_ids = (0..2)
            .map(|_| {
                document.add_object(dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Stamp",
                    "Rect" => vec![10.into(), 10.into(), 20.into(), 20.into()],
                    "NM" => Object::string_literal(stable_key),
                })
            })
            .collect::<Vec<_>>();
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .set("Annots", stamp_ids.iter().copied().map(Object::Reference).collect::<Vec<_>>());
        let mut image = placed_jpeg_mutation();
        image.stable_key = Some(stable_key.to_string());

        let error = apply_native_mutations(
            &mut document,
            &NativeMutationsFile {
                placed_images: vec![image],
                ..NativeMutationsFile::default()
            },
            "D:20260829120500+04'00'",
        )
        .expect_err("duplicate stable Stamp identity must fail closed");

        assert!(error.to_string().contains("more than one Stamp"));
    }

    #[test]
    fn appends_placed_jpeg_as_incremental_stamp_annotation() {
        let _sidecar_cleanup = PlacedImageTestCleanup;
        let (mut document, page_id) = create_test_document();
        let input_path = temp_pdf_path("append-placed-image-input");
        let output_path = temp_pdf_path("append-placed-image-output");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&input_path, &original_bytes).unwrap();
        write(&output_path, &original_bytes).unwrap();
        let placed_image = placed_jpeg_mutation();
        let modified_at = "D:20260609123456+03'00'";
        let mutations = NativeMutationsFile {
            updates: Vec::new(),
            geometry_updates: Vec::new(),
            notes: Vec::new(),
            free_text_notes: Vec::new(),
            text_boxes: Vec::new(),
            deletes: Vec::new(),
            page_rotations: Vec::new(),
            page_labels: None,
            bookmarks: None,
            shapes: None,
            markup: None,
            placed_images: vec![placed_image],
            placed_image_geometry_updates: Vec::new(),
            continuation: None,
        };
        append_native_mutations(
            &input_path,
            &output_path,
            &mutations,
            modified_at,
        )
        .unwrap();

        let output_bytes = read(&output_path).unwrap();
        assert!(output_bytes.starts_with(&original_bytes));
        assert!(output_bytes.len() > original_bytes.len());
        assert!(output_bytes
            .windows(b"/Prev".len())
            .any(|window| window == b"/Prev"));

        let loaded = Document::load(&output_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        assert_eq!(annots.len(), 1);
        let stamp_id = annots[0].as_reference().unwrap();
        let stamp = loaded.get_dictionary(stamp_id).unwrap();
        assert_eq!(annotation_subtype(stamp), "stamp");
        assert_eq!(
            stamp.get(b"NM").ok().and_then(pdf_string_to_text).as_deref(),
            Some("0:0:D:20260609123456+03'00'")
        );
        assert_eq!(
            stamp.get(b"M").ok().and_then(pdf_string_to_text).as_deref(),
            Some(modified_at)
        );

        let expected = placed_image_geometry(
            &placed_jpeg_mutation(),
            resolve_page_view(&loaded, page_id).unwrap(),
            resolve_page_rotation(&loaded, page_id).unwrap(),
        )
        .unwrap();
        validate_rect_approximately(
            parse_rect(stamp.get(b"Rect").unwrap()).unwrap(),
            expected.rect,
            "placed image test rect",
        )
        .unwrap();

        let ap = stamp.get(b"AP").unwrap().as_dict().unwrap();
        let normal_ref = ap.get(b"N").unwrap().as_reference().unwrap();
        assert!(matches!(
            loaded.get_object(normal_ref).unwrap(),
            Object::Stream(_)
        ));

        let _ = remove_file(input_path);
        let _ = remove_file(output_path);
    }

    #[test]
    fn keeps_fallback_names_unique_when_placed_images_continue_across_chunks() {
        let _sidecar_cleanup = PlacedImageTestCleanup;
        let (mut document, page_id) = create_test_document();
        let pdf_path = temp_pdf_path("continued-placed-images");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        let mut images = (0..17).map(|_| placed_jpeg_mutation()).collect::<Vec<_>>();
        let trailing_images = images.split_off(16);
        let _cleanup = PlacedImageContinuationCleanup {
            pdf_path: pdf_path.clone(),
        };
        let modified_at = "D:20260829121300+04'00'";
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                placed_images: images,
                ..NativeMutationsFile::default()
            },
            modified_at,
        )
        .unwrap();
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                placed_images: trailing_images,
                continuation: Some(NativeMutationContinuation {
                    family: NativeMutationContinuationFamily::PlacedImages,
                    chunk_index: 1,
                    chunk_count: 2,
                    bookmark_path: Vec::new(),
                }),
                ..NativeMutationsFile::default()
            },
            modified_at,
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let mut names = get_page_annots(&loaded, page_id)
            .unwrap()
            .iter()
            .filter_map(|annotation| annotation.as_reference().ok())
            .filter_map(|annotation_id| loaded.get_dictionary(annotation_id).ok())
            .filter_map(|annotation| annotation.get(b"NM").ok().and_then(pdf_string_to_text))
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 17);
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 17);
        assert!(names.iter().any(|name| {
            name == "0:16:D:20260829121300+04'00'"
        }));

    }

    #[test]
    fn reopens_updates_and_deletes_a_placed_image_without_orphan_stamps() {
        let _sidecar_cleanup = PlacedImageTestCleanup;
        let (mut document, page_id) = create_test_document();
        let pdf_path = temp_pdf_path("update-canonical-placed-image");
        let mut original_bytes = Vec::new();
        document.save_to(&mut original_bytes).unwrap();
        write(&pdf_path, &original_bytes).unwrap();

        let mut first = placed_jpeg_mutation();
        first.stable_key = Some("placed-image-app-1".to_string());
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                placed_images: vec![first],
                ..NativeMutationsFile::default()
            },
            "D:20260829121000+04'00'",
        )
        .unwrap();

        let seeded = Document::load(&pdf_path).unwrap();
        let stamp_ref = get_page_annots(&seeded, page_id).unwrap()[0]
            .as_reference()
            .unwrap();
        let appearance_refs = placed_image_appearance_refs(&seeded, stamp_ref).unwrap();
        drop(seeded);

        let mut mismatched = placed_jpeg_mutation();
        mismatched.stable_key = Some("placed-image-other".to_string());
        mismatched.annotation_id = Some(format!("{} {} R", stamp_ref.0, stamp_ref.1));
        let error = append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                placed_images: vec![mismatched],
                ..NativeMutationsFile::default()
            },
            "D:20260829121030+04'00'",
        )
        .unwrap_err();
        assert!(error.to_string().contains("stable identity does not match"));

        let mut updated = placed_jpeg_mutation();
        updated.stable_key = Some("placed-image-app-1".to_string());
        updated.annotation_id = Some(format!("{} {} R", stamp_ref.0, stamp_ref.1));
        updated.x = 0.5;
        updated.width = 0.2;
        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                placed_images: vec![updated],
                ..NativeMutationsFile::default()
            },
            "D:20260829121100+04'00'",
        )
        .unwrap();

        let loaded = Document::load(&pdf_path).unwrap();
        let annots = get_page_annots(&loaded, page_id).unwrap();
        assert_eq!(annots.len(), 1);
        let updated_stamp_ref = annots[0].as_reference().unwrap();
        assert_eq!(updated_stamp_ref, stamp_ref);
        let stamp = loaded
            .get_dictionary(updated_stamp_ref)
            .unwrap();
        assert_eq!(
            placed_image_appearance_refs(&loaded, updated_stamp_ref),
            Some(appearance_refs),
        );
        assert_eq!(
            stamp.get(b"NM").ok().and_then(pdf_string_to_text).as_deref(),
            Some("placed-image-app-1"),
        );
        assert_eq!(
            stamp.get(b"M").ok().and_then(pdf_string_to_text).as_deref(),
            Some("D:20260829121100+04'00'"),
        );
        drop(loaded);

        append_native_mutations(
            &pdf_path,
            &pdf_path,
            &NativeMutationsFile {
                deletes: vec![AnnotationDelete {
                    page_index: 0,
                    object_number: Some(updated_stamp_ref.0),
                    generation_number: Some(updated_stamp_ref.1),
                    stable_key: Some("placed-image-app-1".to_string()),
                    created_at: None,
                }],
                ..NativeMutationsFile::default()
            },
            "D:20260829121200+04'00'",
        )
        .unwrap();

        let deleted = Document::load(&pdf_path).unwrap();
        assert!(get_page_annots(&deleted, page_id).unwrap().is_empty());
        assert!(matches!(deleted.get_object(stamp_ref), Ok(Object::Null) | Err(_)));
        // Appearance and image XObjects can be shared by surviving stamps.
        assert!(deleted.get_object(appearance_refs.0).unwrap().as_stream().is_ok());
        assert!(deleted.get_object(appearance_refs.1).unwrap().as_stream().is_ok());

        let _ = remove_file(pdf_path);
    }

#[test]
fn editing_a_stamp_preserves_shared_appearance_and_raster_pixels_in_both_writers() {
    let _cleanup = PlacedImageTestCleanup;
    for append in [false, true] {
        for raster in [false, true] {
            for shared_form in [false, true] {
                let (mut source, page) = create_test_document();
                source
                    .get_dictionary_mut(page)
                    .unwrap()
                    .set("Resources", Dictionary::new());
                let mut jpeg = Vec::new();
                jpeg_encoder::Encoder::new(&mut jpeg, 100)
                    .encode(&[255, 0, 0, 0, 0, 255], 2, 1, jpeg_encoder::ColorType::Rgb)
                    .unwrap();
                let mut image = placed_jpeg_mutation();
                write(&image.bytes_path, &jpeg).unwrap();
                image.byte_length = jpeg.len() as u64;
                image.sha256 = sha256_hex(&jpeg);
                image.stable_key = Some("edited-stamp".into());
                image.rotation_degrees = Some(0.0);
                apply_placed_images(
                    &mut source,
                    std::slice::from_ref(&image),
                    vec![jpeg],
                    0,
                    "D:20261105000000Z",
                    &mut None,
                )
                .unwrap();
                let edited = get_page_annots(&source, page).unwrap()[0]
                    .as_reference()
                    .unwrap();
                let (form, pixels) = placed_image_appearance_refs(&source, edited).unwrap();
                let other_form = if shared_form {
                    form
                } else {
                    source.add_object(source.get_object(form).unwrap().clone())
                };
                let mut other = source.get_dictionary(edited).unwrap().clone();
                other.set("NM", Object::string_literal("other-stamp"));
                other.set("Rect", vec![130.into(), 55.into(), 190.into(), 75.into()]);
                other.set("AP", dictionary! {"N" => other_form});
                let other = source.add_object(other);
                source.get_dictionary_mut(page).unwrap().set(
                    "Annots",
                    vec![Object::Reference(edited), Object::Reference(other)],
                );
                let before = temp_pdf_path("shared-stamp-before");
                let after = temp_pdf_path("shared-stamp-after");
                source.save(&before).unwrap();
                let form_bytes = source
                    .get_object(other_form)
                    .unwrap()
                    .as_stream()
                    .unwrap()
                    .content
                    .clone();
                let image_bytes = source
                    .get_object(pixels)
                    .unwrap()
                    .as_stream()
                    .unwrap()
                    .content
                    .clone();
                let mutation = if raster {
                    let mut replacement = Vec::new();
                    jpeg_encoder::Encoder::new(&mut replacement, 100)
                        .encode(
                            &[0, 255, 0, 255, 255, 0],
                            2,
                            1,
                            jpeg_encoder::ColorType::Rgb,
                        )
                        .unwrap();
                    write(&image.bytes_path, &replacement).unwrap();
                    image.byte_length = replacement.len() as u64;
                    image.sha256 = sha256_hex(&replacement);
                    NativeMutationsFile {
                        placed_images: vec![image],
                        ..Default::default()
                    }
                } else {
                    let update = serde_json::from_value(serde_json::json!({
                        "pageIndex": 0, "stableKey": "edited-stamp", "x": 0.1, "y": 0.25,
                        "width": 0.3, "height": 0.2, "rotationDegrees": 90,
                    }))
                    .unwrap();
                    NativeMutationsFile {
                        placed_image_geometry_updates: vec![update],
                        ..Default::default()
                    }
                };
                let mut saved = recovery_save(source, &mutation, append);
                saved.save(&after).unwrap();
                let reopened = Document::load(&after).unwrap();
                let other_refs = placed_image_appearance_refs(&reopened, other).unwrap();
                assert_eq!(other_refs, (other_form, pixels));
                assert_eq!(reopened.get_object(other_form).unwrap().as_stream().unwrap().content, form_bytes,
                    "other stamp appearance changed: append={append}, raster={raster}, shared_form={shared_form}");
                assert_eq!(
                    reopened
                        .get_object(pixels)
                        .unwrap()
                        .as_stream()
                        .unwrap()
                        .content,
                    image_bytes
                );
                let render = |path: &Path, x: &str| {
                    let rendered = std::process::Command::new("pdftoppm")
                        .args([
                            "-singlefile",
                            "-r",
                            "72",
                            "-x",
                            x,
                            "-y",
                            "0",
                            "-W",
                            "80",
                            "-H",
                            "100",
                        ])
                        .arg(path)
                        .output()
                        .unwrap();
                    assert!(
                        rendered.status.success(),
                        "{}",
                        String::from_utf8_lossy(&rendered.stderr)
                    );
                    rendered.stdout
                };
                assert_eq!(
                    render(&before, "120"),
                    render(&after, "120"),
                    "untouched stamp's pixels changed"
                );
                assert_ne!(
                    render(&before, "0"),
                    render(&after, "0"),
                    "edited stamp did not change"
                );
                // After detaching, a second identical edit must reuse its private graph.
                let private = placed_image_appearance_refs(&reopened, edited).unwrap();
                let again = recovery_save(reopened, &mutation, append);
                assert_eq!(
                    placed_image_appearance_refs(&again, edited).unwrap(),
                    private
                );
                remove_file(before).unwrap();
                remove_file(after).unwrap();
            }
        }
    }
}
