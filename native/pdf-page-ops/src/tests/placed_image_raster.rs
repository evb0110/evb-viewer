fn raster_png_bytes(color: png::ColorType, pixels: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(pixels).unwrap();
    }
    bytes
}

fn inline_raster_mutations(bytes: &[u8], mime: &str) -> NativeMutationsFile {
    try_inline_raster_mutations(bytes, mime).unwrap()
}

fn try_inline_raster_mutations(bytes: &[u8], mime: &str) -> Result<NativeMutationsFile> {
    use base64::Engine;
    read_native_mutations_bytes(&serde_json::to_vec(&serde_json::json!({
        "placedImages": [{
            "pageIndex": 0, "stableKey": "inline-raster", "x": 0.1, "y": 0.1,
            "width": 0.5, "height": 0.5, "rotationDegrees": 0,
            "mimeType": mime, "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "byteLength": bytes.len(), "sha256": sha256_hex(bytes)
        }]
    })).unwrap())
}

fn assert_png_saved_graph(document: &Document, bytes: &[u8]) -> ObjectId {
    let entries = collect_parsed_annotations(document, "D:20260908120000Z").unwrap();
    let stamp = entries
        .iter()
        .find_map(|entry| match entry {
            PdfAnnotationParseEntry::Stamp(stamp) => Some(stamp),
            _ => None,
        })
        .expect("PNG must reparse as an editable stamp");
    assert_eq!(stamp.image.byte_length, bytes.len() as u64);
    assert_eq!(stamp.image.sha256, sha256_hex(bytes));
    let image_ref = validate_recovery_image(document, &stamp.image).unwrap();
    let stream = document.get_object(image_ref).unwrap().as_stream().unwrap();
    let samples = stream.get_plain_content().unwrap();
    assert_eq!(samples, [255, 0, 0, 0, 0, 255]);
    let mask_ref = stream.dict.get(b"SMask").unwrap().as_reference().unwrap();
    let mask = document.get_object(mask_ref).unwrap().as_stream().unwrap();
    assert_eq!(mask.get_plain_content().unwrap(), [255, 0]);
    image_ref
}

#[test]
fn inline_png_alpha_survives_full_and_portable_incremental_save_reparse() {
    let bytes = raster_png_bytes(png::ColorType::Rgba, &[255, 0, 0, 255, 0, 0, 255, 0]);
    let (mut document, _) = create_test_document();
    let mut original = Vec::new();
    document.save_to(&mut original).unwrap();
    apply_native_mutations(
        &mut document,
        &inline_raster_mutations(&bytes, "image/png"),
        "D:20260908120000Z",
    )
    .unwrap();
    let mut saved = Vec::new();
    document.save_to(&mut saved).unwrap();
    let loaded = Document::load_mem(&saved).unwrap();
    assert_png_saved_graph(&loaded, &bytes);

    let result = append_native_mutations_to_bytes(
        &original,
        &inline_raster_mutations(&bytes, "image/png"),
        "D:20260908120000Z",
    )
    .unwrap();
    assert!(result.data.starts_with(&original));
    assert_eq!(result.identity_bindings.len(), 1);
    let mut loaded = Document::load_mem(&result.data).unwrap();
    let image_ref = assert_png_saved_graph(&loaded, &bytes);
    let source = collect_parsed_annotations(&loaded, "D:20260908120000Z")
        .unwrap()
        .into_iter()
        .find_map(|entry| match entry {
            PdfAnnotationParseEntry::Stamp(stamp) => Some(stamp.image),
            _ => None,
        })
        .unwrap();
    let mask_ref = loaded
        .get_object(image_ref)
        .unwrap()
        .as_stream()
        .unwrap()
        .dict
        .get(b"SMask")
        .unwrap()
        .as_reference()
        .unwrap();
    loaded
        .get_object_mut(mask_ref)
        .unwrap()
        .as_stream_mut()
        .unwrap()
        .content
        .push(0);
    assert!(
        validate_recovery_image(&loaded, &source).is_err(),
        "changed alpha must invalidate source recovery"
    );
    assert!(collect_parsed_annotations(&loaded, "D:20260908120000Z")
        .unwrap()
        .iter()
        .all(|entry| !matches!(entry, PdfAnnotationParseEntry::Stamp(_))));
}

#[test]
fn inline_jpeg_keeps_original_compressed_bytes() {
    let bytes = minimal_jpeg_bytes();
    let (mut document, page_id) = create_test_document();
    apply_native_mutations(
        &mut document,
        &inline_raster_mutations(&bytes, "image/jpeg"),
        "D:20260908120000Z",
    )
    .unwrap();
    let stamp = get_page_annots(&document, page_id).unwrap()[0]
        .as_reference()
        .unwrap();
    let (_, image_ref) = placed_image_appearance_refs(&document, stamp).unwrap();
    let stream = document.get_object(image_ref).unwrap().as_stream().unwrap();
    assert_eq!(stream.content, bytes);
    assert_eq!(
        stream.dict.get(b"Filter").unwrap().as_name().unwrap(),
        b"DCTDecode"
    );
}

#[test]
fn png_palette_transparency_expands_without_flattening() {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::One);
        encoder.set_palette(vec![255, 0, 0, 0, 0, 255]);
        encoder.set_trns(vec![255, 0]);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0b0100_0000]).unwrap();
    }
    let (mut document, _) = create_test_document();
    apply_native_mutations(
        &mut document,
        &inline_raster_mutations(&bytes, "image/png"),
        "D:20260908120000Z",
    )
    .unwrap();
    assert_png_saved_graph(&document, &bytes);
}

#[test]
fn inline_raster_rejects_corruption_ambiguous_sources_and_bombs() {
    let bytes = raster_png_bytes(png::ColorType::Rgb, &[255, 0, 0, 0, 0, 255]);
    let mut mutations = inline_raster_mutations(&bytes, "image/png");
    let image = &mut mutations.placed_images[0];
    image.bytes_path = PathBuf::from("must-not-be-opened");
    assert!(validate_placed_images(&mutations.placed_images).is_err());
    let mut mutations = inline_raster_mutations(&bytes, "image/png");
    mutations.placed_images[0].sha256 = "0".repeat(64);
    assert!(validate_placed_images(&mutations.placed_images).is_err());
    let mut corrupted = bytes.clone();
    corrupted.truncate(corrupted.len() - 5);
    let (mut document, _) = create_test_document();
    assert!(apply_native_mutations(
        &mut document,
        &inline_raster_mutations(&corrupted, "image/png"),
        "D:20260908120000Z"
    )
    .is_err());
    let bomb = include_bytes!("../../../evb-raster-io/tests/fixtures/oversized-dimensions.png");
    assert!(try_inline_raster_mutations(bomb, "image/png").is_err());
    assert!(try_inline_raster_mutations(&bytes, "image/jpeg").is_err());
}

#[test]
fn png_saved_deletion_recovery_keeps_color_and_soft_mask() {
    let bytes = raster_png_bytes(png::ColorType::Rgba, &[255, 0, 0, 255, 0, 0, 255, 0]);
    for append in [false, true] {
        let (document, _) = create_test_document();
        let mut document = recovery_save(
            document,
            &inline_raster_mutations(&bytes, "image/png"),
            append,
        );
        let stamp = collect_parsed_annotations(&document, "")
            .unwrap()
            .into_iter()
            .find_map(|entry| match entry {
                PdfAnnotationParseEntry::Stamp(stamp) => Some(stamp),
                _ => None,
            })
            .unwrap();
        document = recovery_save(
            document,
            &NativeMutationsFile {
                deletes: vec![AnnotationDelete {
                    page_index: 0,
                    object_number: Some(stamp.object_number as u32),
                    generation_number: Some(stamp.generation_number as u16),
                    stable_key: Some("inline-raster".to_string()),
                    created_at: None,
                }],
                ..Default::default()
            },
            append,
        );
        assert!(collect_parsed_annotations(&document, "")
            .unwrap()
            .is_empty());
        let update = serde_json::from_value(serde_json::json!({
            "pageIndex": 0, "stableKey": "inline-raster", "sourceImage": stamp.image,
            "x": 0.2, "y": 0.2, "width": 0.5, "height": 0.5, "rotationDegrees": 0,
        }))
        .unwrap();
        document = recovery_save(
            document,
            &NativeMutationsFile {
                placed_image_geometry_updates: vec![update],
                ..Default::default()
            },
            append,
        );
        assert_png_saved_graph(&document, &bytes);
    }
}

#[test]
fn png_aggregate_decode_budget_rejects_small_compressed_headers_before_expansion() {
    let mut header = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut header, 8192, 8192);
        encoder.set_color(png::ColorType::Rgba);
        encoder.write_header().unwrap();
    }
    let images = (0..3)
        .map(|_| {
            inline_raster_mutations(&header, "image/png")
                .placed_images
                .remove(0)
        })
        .collect::<Vec<_>>();
    let error = validate_placed_images(&images).unwrap_err();
    assert!(error.to_string().contains("aggregate decoded-byte"));
}
