use super::*;

pub(crate) fn run(args: Vec<String>) -> Result<()> {
    let config = parse_args(args.into_iter())
        .map_err(|error| reclassify_domain_error(error, NativeErrorCode::InvalidRequest))?;
    mutate_pdf(config)
}

pub(crate) fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Config> {
    let command = args.next().ok_or("Missing command")?;
    let mut input_path = None;
    let mut source_path = None;
    let mut output_path = None;
    let mut pages_file = None;
    let mut updates_file = None;
    let mut changes_file = None;
    let mut mutations_file = None;
    let mut password_file = None;
    let mut identity_bindings_file = None;
    let mut instructions_file = None;
    let mut modified_at = None;
    let mut top = None;
    let mut bottom = None;
    let mut left = None;
    let mut right = None;
    let mut page_number = None;
    let mut qpdf_path = None;
    let mut append = false;
    let mut append_in_place = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" => {
                input_path = Some(PathBuf::from(args.next().ok_or("Missing --input value")?))
            }
            "--source" => {
                source_path = Some(PathBuf::from(args.next().ok_or("Missing --source value")?))
            }
            "--output" => {
                output_path = Some(PathBuf::from(args.next().ok_or("Missing --output value")?))
            }
            "--pages-file" => {
                pages_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --pages-file value")?,
                ))
            }
            "--updates-file" => {
                updates_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --updates-file value")?,
                ))
            }
            "--changes-file" => {
                changes_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --changes-file value")?,
                ))
            }
            "--mutations-file" => {
                mutations_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --mutations-file value")?,
                ))
            }
            "--identity-bindings-file" => {
                identity_bindings_file = Some(PathBuf::from(
                    args.next()
                        .ok_or("Missing --identity-bindings-file value")?,
                ))
            }
            "--password-file" => {
                password_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --password-file value")?,
                ))
            }
            "--instructions-file" => {
                instructions_file = Some(PathBuf::from(
                    args.next().ok_or("Missing --instructions-file value")?,
                ))
            }
            "--modified-at" => {
                modified_at = Some(args.next().ok_or("Missing --modified-at value")?)
            }
            "--top" => {
                top = Some(parse_margin(
                    &args.next().ok_or("Missing --top value")?,
                    "top",
                )?)
            }
            "--bottom" => {
                bottom = Some(parse_margin(
                    &args.next().ok_or("Missing --bottom value")?,
                    "bottom",
                )?)
            }
            "--left" => {
                left = Some(parse_margin(
                    &args.next().ok_or("Missing --left value")?,
                    "left",
                )?)
            }
            "--right" => {
                right = Some(parse_margin(
                    &args.next().ok_or("Missing --right value")?,
                    "right",
                )?)
            }
            "--page" | "--page-number" => {
                let value = args.next().ok_or("Missing --page value")?;
                let parsed = value.parse::<u32>()?;
                if parsed == 0 {
                    return Err("Page number must be positive".into());
                }
                page_number = Some(parsed);
            }
            "--qpdf" | "--qpdf-path" => {
                qpdf_path = Some(PathBuf::from(args.next().ok_or("Missing --qpdf value")?))
            }
            "--append" => {
                append = true;
            }
            "--append-in-place" => {
                append_in_place = true;
            }
            _ => return Err(format!("Unknown argument: {arg}").into()),
        }
    }

    if append_in_place && !append {
        return Err("--append-in-place requires --append".into());
    }
    if append_in_place
        && !matches!(
            command.as_str(),
            "update-note-text" | "save-note-changes" | "save-mutations"
        )
    {
        return Err("--append-in-place is only valid for native mutation saves".into());
    }

    if identity_bindings_file.is_some() && command != "save-mutations" {
        return Err("--identity-bindings-file is only valid for save-mutations".into());
    }

    if password_file.is_some() && command != "decrypt" {
        return Err("--password-file is only valid for decrypt".into());
    }

    let operation = match command.as_str() {
        "split-pages" => Operation::SplitPages {
            instructions_file: instructions_file.ok_or("Missing --instructions-file value")?,
        },
        "overlay-text" => Operation::OverlayText {
            source_path: source_path.ok_or("Missing --source value")?,
            instructions_file: instructions_file.ok_or("Missing --instructions-file value")?,
        },
        "crop" => Operation::Crop {
            pages_file: pages_file.ok_or("Missing --pages-file value")?,
            margins: CropMargins {
                top: top.ok_or("Missing --top value")?,
                bottom: bottom.ok_or("Missing --bottom value")?,
                left: left.ok_or("Missing --left value")?,
                right: right.ok_or("Missing --right value")?,
            },
        },
        "remove-crop" => Operation::RemoveCrop {
            pages_file: pages_file.ok_or("Missing --pages-file value")?,
        },
        "update-note-text" => Operation::UpdateNoteText {
            updates_file: updates_file.ok_or("Missing --updates-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
            append_in_place,
        },
        "save-note-changes" => Operation::SaveNoteChanges {
            changes_file: changes_file.ok_or("Missing --changes-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
            append_in_place,
        },
        "save-mutations" => Operation::SaveMutations {
            mutations_file: mutations_file.ok_or("Missing --mutations-file value")?,
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
            append,
            append_in_place,
            identity_bindings_file,
        },
        "parse-annotations" => Operation::ParseAnnotations {
            modified_at: modified_at.ok_or("Missing --modified-at value")?,
        },
        "annotation-index" | "annotation-name-index" => Operation::AnnotationNameIndex,
        "embedded-shape-index" | "shape-index" => Operation::EmbeddedShapeIndex,
        "pdf-conformance" | "conformance" => Operation::PdfConformance,
        "decrypt" => Operation::Decrypt { password_file },
        "page-geometry" | "get-page-geometry" => Operation::PageGeometry {
            page_number: page_number.ok_or("Missing --page value")?,
        },
        "page-sizes" => Operation::PageSizes,
        "read-catalog" => Operation::ReadCatalog,
        _ => return Err(format!("Unknown command: {command}").into()),
    };

    Ok(Config {
        operation,
        input_path: input_path.ok_or("Missing --input value")?,
        output_path: output_path.ok_or("Missing --output value")?,
        qpdf_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_decrypt_request_with_an_optional_password_file() {
        let config = parse_args(
            [
                "decrypt",
                "--input",
                "encrypted.pdf",
                "--output",
                "decrypted.pdf",
                "--password-file",
                "password.txt",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();

        assert!(matches!(
            config.operation,
            Operation::Decrypt {
                password_file: Some(_)
            }
        ));
        assert_eq!(config.input_path, PathBuf::from("encrypted.pdf"));
        assert_eq!(config.output_path, PathBuf::from("decrypted.pdf"));
    }

    #[test]
    fn rejects_the_password_file_flag_outside_decrypt() {
        let error = parse_args(
            [
                "page-sizes",
                "--input",
                "input.pdf",
                "--output",
                "sizes.json",
                "--password-file",
                "password.txt",
            ]
            .into_iter()
            .map(String::from),
        )
        .err()
        .expect("password file outside decrypt should be rejected")
        .to_string();

        assert!(error.contains("--password-file is only valid for decrypt"));
    }

    #[test]
    fn parses_page_geometry_request() {
        let config = parse_args(
            [
                "page-geometry",
                "--input",
                "input.pdf",
                "--output",
                "geometry.json",
                "--page",
                "7",
                "--qpdf",
                "qpdf",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();

        assert!(matches!(
            config.operation,
            Operation::PageGeometry { page_number: 7 }
        ));
        assert_eq!(config.input_path, PathBuf::from("input.pdf"));
        assert_eq!(config.output_path, PathBuf::from("geometry.json"));
        assert_eq!(config.qpdf_path, Some(PathBuf::from("qpdf")));
    }

    #[test]
    fn rejects_page_zero_for_page_geometry() {
        let error = parse_args(
            [
                "page-geometry",
                "--input",
                "input.pdf",
                "--output",
                "geometry.json",
                "--page",
                "0",
            ]
            .into_iter()
            .map(String::from),
        )
        .err()
        .expect("page zero should be rejected")
        .to_string();

        assert!(error.contains("Page number must be positive"));
    }

    #[test]
    fn parses_private_staged_append_mode() {
        let config = parse_args(
            [
                "save-mutations",
                "--input",
                "staged.pdf",
                "--output",
                "staged.pdf",
                "--mutations-file",
                "mutations.json",
                "--modified-at",
                "D:20260829120000Z",
                "--append",
                "--append-in-place",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();

        assert!(matches!(
            config.operation,
            Operation::SaveMutations {
                append: true,
                append_in_place: true,
                ..
            }
        ));
    }

    #[test]
    fn rejects_private_staged_append_without_append_mode() {
        let error = parse_args(
            [
                "save-mutations",
                "--input",
                "staged.pdf",
                "--output",
                "staged.pdf",
                "--mutations-file",
                "mutations.json",
                "--modified-at",
                "D:20260829120000Z",
                "--append-in-place",
            ]
            .into_iter()
            .map(String::from),
        )
        .err()
        .expect("private staged mode without append should be rejected")
        .to_string();

        assert!(error.contains("requires --append"));
    }

    #[test]
    fn parses_annotation_parse_request_with_modified_at() {
        let config = parse_args(
            [
                "parse-annotations",
                "--input",
                "input.pdf",
                "--output",
                "annotations.jsonl",
                "--modified-at",
                "D:20260830130000Z",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();

        assert!(matches!(
            config.operation,
            Operation::ParseAnnotations { ref modified_at }
                if modified_at == "D:20260830130000Z"
        ));
    }

    #[test]
    fn annotation_parse_requires_modified_at() {
        let error = parse_args(
            [
                "parse-annotations",
                "--input",
                "input.pdf",
                "--output",
                "annotations.jsonl",
            ]
            .into_iter()
            .map(String::from),
        )
        .err()
        .expect("annotation parse should require its deterministic identity timestamp")
        .to_string();

        assert!(error.contains("Missing --modified-at value"));
    }
}
