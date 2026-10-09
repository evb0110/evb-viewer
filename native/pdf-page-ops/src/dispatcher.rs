use super::*;

pub(crate) fn mutate_pdf(config: Config) -> Result<()> {
    match &config.operation {
        Operation::PdfConformance => {
            return write_pdf_conformance(
                &config.input_path,
                config.qpdf_path.as_deref(),
                &mut std::io::stdout().lock(),
            )
        }
        Operation::AppendAdmission => {
            return write_append_admission(
                &config.input_path,
                config.qpdf_path.as_deref(),
                &mut std::io::stdout().lock(),
            )
        }
        Operation::ReadCatalog => {
            return write_pdf_combine_catalog(
                &config.input_path,
                config.qpdf_path.as_deref(),
                &mut std::io::stdout().lock(),
            )
        }
        Operation::PageGeometry { page_number } => {
            return write_page_geometry(
                &config.input_path,
                *page_number,
                config.qpdf_path.as_deref(),
                &mut std::io::stdout().lock(),
            )
        }
        Operation::OcrTextVisibility {
            pages_file,
            with_evb_ocr_text,
        } => {
            let mut input = std::io::stdin().lock();
            let requests: Box<dyn Iterator<Item = Result<Vec<u32>>> + '_> = match pages_file {
                Some(path) => Box::new(std::iter::once(Ok(read_pages_file(path).map_err(
                    |error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest),
                )?))),
                None => {
                    Box::new(std::iter::from_fn(|| {
                        use std::io::BufRead;
                        let mut bytes = Vec::new();
                        match (&mut input).take(4097).read_until(b'\n', &mut bytes) {
                        Ok(0) => None,
                        Ok(_) => Some((|| {
                            if bytes.len() > 4096 || bytes.last() != Some(&b'\n') {
                                return Err(domain_error(NativeErrorCode::TooLarge, "Visibility request exceeds 4096 bytes or is unterminated"));
                            }
                            let pages: Vec<u32> = serde_json::from_slice(&bytes)?;
                            if pages.is_empty() || pages.len() > 256 || pages.contains(&0) {
                                return Err("Visibility request must select 1 to 256 positive pages".into());
                            }
                            Ok(pages)
                        })().map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))),
                        Err(error) => Some(Err(error.into())),
                    }
                    }))
                }
            };
            let mut output = std::io::stdout().lock();
            inspect_ocr_text_visibility(
                &config.input_path,
                requests,
                *with_evb_ocr_text,
                config.qpdf_path.as_deref(),
                |report| {
                    let bytes = serde_json::to_vec(report)?;
                    if pages_file.is_none() && bytes.len() > MAX_AGGREGATE_TEXT_BYTES {
                        return Err(domain_error(
                            NativeErrorCode::TooLarge,
                            "Visibility report exceeds its byte ceiling",
                        ));
                    }
                    output.write_all(&bytes)?;
                    if pages_file.is_none() {
                        output.write_all(b"\n")?;
                    }
                    output.flush()?;
                    Ok(())
                },
            )?;
            return Ok(());
        }
        _ => {}
    }
    let output_path = config
        .output_path
        .as_deref()
        .ok_or("Missing --output value")?;

    match &config.operation {
        Operation::Crop {
            pages_file,
            margins,
        } => {
            let pages = read_pages_file(pages_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_crop_pages_path(
                &config.input_path,
                output_path,
                &pages,
                *margins,
                config.qpdf_path.as_deref(),
            );
        }
        Operation::PrintLayout {
            pages_file,
            view_mode,
            orientation,
        } => {
            let pages = pages_file
                .as_deref()
                .map(read_pages_file)
                .transpose()
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_print_layout_path(
                &config.input_path,
                output_path,
                pages.as_deref(),
                *view_mode,
                *orientation,
            );
        }
        Operation::RemoveCrop { pages_file } => {
            let pages = read_pages_file(pages_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_remove_crop_pages_path(
                &config.input_path,
                output_path,
                &pages,
                config.qpdf_path.as_deref(),
            );
        }
        _ => {}
    }

    match &config.operation {
        Operation::SplitPages { instructions_file } => {
            let instructions = read_split_pages_file(instructions_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_split_pages_path(
                &config.input_path,
                output_path,
                &instructions,
                config.qpdf_path.as_deref(),
            );
        }
        Operation::OverlayText {
            source_path,
            instructions_file,
        } => {
            let instructions = read_text_layer_file(instructions_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_overlay_text_layers_path(
                &config.input_path,
                source_path,
                output_path,
                &instructions,
                config.qpdf_path.as_deref(),
            );
        }
        Operation::OcrTextLayer { instructions_file } => {
            let instructions = read_ocr_text_layer_file(instructions_file)
                .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
            return write_ocr_text_layer_path(
                &config.input_path,
                output_path,
                &instructions,
                config.qpdf_path.as_deref(),
            );
        }
        _ => {}
    }

    match &config.operation {
        Operation::AnnotationNameIndex => {
            return write_annotation_name_index_path(
                &config.input_path,
                output_path,
                config.qpdf_path.as_deref(),
            )
        }
        Operation::EmbeddedShapeIndex => {
            return write_embedded_shape_index_path(
                &config.input_path,
                output_path,
                config.qpdf_path.as_deref(),
            )
        }
        Operation::ParseAnnotations { modified_at } => {
            return write_annotation_parse_path(
                &config.input_path,
                output_path,
                modified_at,
                config.qpdf_path.as_deref(),
            )
        }
        Operation::PageSizes { metadata_only } => {
            return write_page_sizes_path(
                &config.input_path,
                output_path,
                config.qpdf_path.as_deref(),
                *metadata_only,
            )
        }
        Operation::Decrypt { password_file } => {
            return write_decrypted_pdf_path(
                &config.input_path,
                output_path,
                password_file.as_deref(),
            );
        }
        _ => {}
    }

    let appended = read_append_mutations(&config.operation)
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
    if let Some((mutations, modified_at)) = appended {
        let identity_bindings_path = match &config.operation {
            Operation::SaveMutations {
                identity_bindings_file,
                ..
            } => identity_bindings_file.as_deref(),
            _ => None,
        };
        let append_in_place = match &config.operation {
            Operation::SaveMutations {
                append_in_place, ..
            } => *append_in_place,
            _ => false,
        };
        if append_in_place {
            return append_native_mutations_in_place_with_qpdf(
                &config.input_path,
                output_path,
                &mutations,
                modified_at,
                config.qpdf_path.as_deref(),
                identity_bindings_path,
            );
        }
        return append_native_mutations_with_qpdf(
            &config.input_path,
            output_path,
            &mutations,
            modified_at,
            config.qpdf_path.as_deref(),
            identity_bindings_path,
        );
    }

    if let Some((mutations, modified_at)) = read_non_append_mutations(&config.operation)
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?
    {
        let identity_bindings_path = match &config.operation {
            Operation::SaveMutations {
                identity_bindings_file,
                ..
            } => identity_bindings_file.as_deref(),
            _ => None,
        };
        return write_native_mutations_path(
            &config.input_path,
            output_path,
            &mutations,
            modified_at,
            config.qpdf_path.as_deref(),
            identity_bindings_path,
        );
    }

    unreachable!("all PDF page operations must be dispatched before this point")
}

pub(crate) fn classify_pdf_load_error(error: Box<dyn Error>, context: &str) -> Box<dyn Error> {
    if error.downcast_ref::<NativeError>().is_some() {
        error
    } else {
        domain_error(NativeErrorCode::CorruptXref, format!("{context}: {error}"))
    }
}

/// `save-mutations` is the only note-writing command, so the append path reads
/// the same payload that the non-append path reads.
pub(crate) fn read_append_mutations(
    operation: &Operation,
) -> Result<Option<(NativeMutationsFile, &str)>> {
    let mutations = match operation {
        Operation::SaveMutations {
            mutations_file,
            modified_at,
            append: true,
            ..
        } => (read_native_mutations(mutations_file)?, modified_at.as_str()),
        _ => return Ok(None),
    };
    Ok(Some(mutations))
}

pub(crate) fn read_non_append_mutations(
    operation: &Operation,
) -> Result<Option<(NativeMutationsFile, &str)>> {
    let mutations = match operation {
        Operation::SaveMutations {
            mutations_file,
            modified_at,
            append: false,
            ..
        } => (read_native_mutations(mutations_file)?, modified_at.as_str()),
        _ => return Ok(None),
    };
    Ok(Some(mutations))
}
