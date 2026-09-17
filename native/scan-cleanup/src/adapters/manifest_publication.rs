use crate::{
    io::{write_atomic, StagedFileBackup},
    protocol::manifest_v3::ManifestV3,
};
use evb_native_support::{NativeError, NativeErrorCode};
use serde::Serialize;
use std::{
    collections::HashSet,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

const PUBLICATION_JOURNAL_VERSION: u32 = 1;
const PUBLICATION_JOURNAL_SUFFIX: &str = ".evb-publication-journal.json";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationJournalEntry {
    original: PathBuf,
    backup: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationJournal {
    version: u32,
    manifest_path: PathBuf,
    entries: Vec<PublicationJournalEntry>,
}

fn publication_journal_path(manifest_path: &Path) -> PathBuf {
    let mut journal_path = manifest_path.as_os_str().to_os_string();
    journal_path.push(PUBLICATION_JOURNAL_SUFFIX);
    PathBuf::from(journal_path)
}

fn remove_publication_journal(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_publication_journal(
    path: &Path,
    manifest_path: &Path,
    entries: &[PublicationJournalEntry],
) -> Result<(), String> {
    let journal = PublicationJournal {
        version: PUBLICATION_JOURNAL_VERSION,
        manifest_path: manifest_path.to_path_buf(),
        entries: entries.to_vec(),
    };
    let bytes = serde_json::to_vec(&journal).map_err(|error| error.to_string())?;
    write_atomic(path, &bytes)
}

struct ManifestPublicationTransaction {
    destinations: Vec<PathBuf>,
    backups: Vec<StagedFileBackup>,
    journal_path: PathBuf,
    manifest_path: PathBuf,
    journal_entries: Vec<PublicationJournalEntry>,
}

impl ManifestPublicationTransaction {
    fn begin(manifest_path: &Path, manifest: &ManifestV3) -> Result<Self, String> {
        let journal_path = publication_journal_path(manifest_path);
        match fs::symlink_metadata(&journal_path) {
            Ok(_) => {
                return Err(format!(
                    "publication recovery journal already exists: {}",
                    journal_path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "unable to inspect publication recovery journal {}: {error}",
                    journal_path.display()
                ));
            }
        }
        let destinations = manifest
            .destination_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        let mut transaction = Self {
            destinations,
            backups: Vec::new(),
            journal_path,
            manifest_path: manifest_path.to_path_buf(),
            journal_entries: Vec::new(),
        };
        for path in transaction.destinations.clone() {
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() => {
                    match StagedFileBackup::stage_with_hook(&path, |original, backup| {
                        transaction.journal_entries.push(PublicationJournalEntry {
                            original: original.to_path_buf(),
                            backup: backup.to_path_buf(),
                        });
                        if let Err(error) = write_publication_journal(
                            &transaction.journal_path,
                            &transaction.manifest_path,
                            &transaction.journal_entries,
                        ) {
                            transaction.journal_entries.pop();
                            return Err(error);
                        }
                        Ok(())
                    }) {
                        Ok(backup) => transaction.backups.push(backup),
                        Err(error) => {
                            return Err(transaction.abort_begin(format!(
                                "Unable to snapshot existing output destination {}: {error}",
                                path.display()
                            )));
                        }
                    }
                }
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => {
                    return Err(transaction.abort_begin(format!(
                        "Output destination is not a regular file or directory: {}",
                        path.display()
                    )));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(transaction.abort_begin(format!(
                        "Unable to inspect output destination {}: {error}",
                        path.display()
                    )));
                }
            }
        }
        Ok(transaction)
    }

    fn abort_begin(&mut self, reason: String) -> String {
        let restore_error = self.restore_backups();
        match restore_error {
            Ok(()) => match remove_publication_journal(&self.journal_path) {
                Ok(()) => reason,
                Err(journal_error) => format!(
                    "{reason}; removing publication recovery journal was incomplete: {journal_error}"
                ),
            },
            Err(restore_error) => format!(
                "{reason}; restoring prior snapshots was incomplete: {restore_error}"
            ),
        }
    }

    fn restore_backups(&mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        while let Some(backup) = self.backups.pop() {
            let original = backup.original().to_path_buf();
            if let Err(error) = backup.restore() {
                failures.push(format!("{}: {error}", original.display()));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn commit(mut self) -> Result<(), String> {
        let mut failures = Vec::new();
        for backup in self.backups.drain(..) {
            let original = backup.original().to_path_buf();
            if let Err(error) = backup.discard() {
                failures.push(format!("{}: {error}", original.display()));
            }
        }
        if failures.is_empty() {
            remove_publication_journal(&self.journal_path)
                .map_err(|error| format!("removing publication recovery journal failed: {error}"))
        } else {
            Err(failures.join("; "))
        }
    }

    fn rollback(mut self) -> Result<(), String> {
        let backed_up = self
            .backups
            .iter()
            .map(|backup| backup.original().to_path_buf())
            .collect::<HashSet<_>>();
        let mut failures = Vec::new();
        for path in &self.destinations {
            if backed_up.contains(path) {
                continue;
            }
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_dir() => continue,
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    failures.push(format!("{}: {error}", path.display()));
                    continue;
                }
            }
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => failures.push(format!("{}: {error}", path.display())),
            }
        }
        if let Err(error) = self.restore_backups() {
            failures.push(error);
        }
        if failures.is_empty() {
            if let Err(error) = remove_publication_journal(&self.journal_path) {
                failures.push(format!(
                    "removing publication recovery journal failed: {error}"
                ));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

pub(super) fn run_manifest_transaction(
    manifest_path: &Path,
    manifest: &ManifestV3,
    operation: impl FnOnce() -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    let transaction =
        ManifestPublicationTransaction::begin(manifest_path, manifest).map_err(|error| {
            NativeError::new(
                NativeErrorCode::Io,
                format!("Unable to prepare scan-cleanup output transaction: {error}"),
            )
        })?;
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)) {
        Err(panic) => {
            if let Err(rollback_error) = transaction.rollback() {
                std::panic::resume_unwind(Box::new(format!(
                    "Scan-cleanup batch panicked; rollback was incomplete: {rollback_error}"
                )));
            }
            std::panic::resume_unwind(panic);
        }
        Ok(Ok(())) => transaction.commit().map_err(|error| {
            NativeError::new(
                NativeErrorCode::Io,
                format!("Unable to finalize scan-cleanup output transaction: {error}"),
            )
            .into()
        }),
        Ok(Err(operation_error)) => match transaction.rollback() {
            Ok(()) => Err(operation_error),
            Err(rollback_error) => Err(NativeError::new(
                NativeErrorCode::NativeFailure,
                format!(
                    "Scan-cleanup batch failed ({operation_error}); rollback was incomplete: {rollback_error}"
                ),
            )
            .into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::run_manifest_transaction;
    use crate::{
        protocol::manifest_v3::{
            AnalysisPurpose, CanvasScope, ManifestV3, Operation, Page, PageOutput, RenderMode,
            VERSION,
        },
        CleanupOptions,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    #[test]
    fn batch_failure_rolls_back_every_declared_destination_across_pages() {
        let dir = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-transaction-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("input.png");
        fs::write(&input, b"input must survive rollback").unwrap();
        let output = |page: usize| PageOutput {
            output_path: dir.join(format!("page-{page}.png")),
            metadata_path: dir.join(format!("page-{page}-output.json")),
            bilevel_output_path: Some(dir.join(format!("page-{page}.pbm"))),
            background_output_path: Some(dir.join(format!("page-{page}-background.png"))),
            foreground_mask_output_path: Some(dir.join(format!("page-{page}-foreground.pbm"))),
            foreground_alpha_output_path: Some(dir.join(format!("page-{page}-foreground.png"))),
            picture_mask_output_path: Some(dir.join(format!("page-{page}-picture.pbm"))),
            tone_preservation_alpha_output_path: Some(dir.join(format!("page-{page}-tone.png"))),
        };
        let manifest = ManifestV3 {
            version: VERSION,
            operation: Operation::Render,
            analysis_purpose: AnalysisPurpose::PagePlan,
            render_mode: RenderMode::Final,
            canvas_scope: CanvasScope::Page,
            document_canvas: None,
            host_memory_bytes: None,
            raster_window: 1,
            staged_input_window: None,
            staged_input_peak_pixels: None,
            pages: (0..2)
                .map(|page| Page {
                    input_path: input.clone(),
                    analysis_input_path: None,
                    analysis_dpi: None,
                    trusted_foreground_mask_path: None,
                    trusted_mrc_background_path: None,
                    source_page_index: page,
                    page_metadata_path: dir.join(format!("page-{page}-page.json")),
                    options: CleanupOptions::default(),
                    document_prior: None,
                    detail_render_plan: None,
                    outputs: vec![output(page)],
                })
                .collect(),
        };
        let destinations = manifest
            .destination_paths()
            .into_iter()
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        assert_eq!(destinations.len(), 18);

        let manifest_path = dir.join("manifest.json");
        let journal_path = PathBuf::from(format!(
            "{}{}",
            manifest_path.display(),
            ".evb-publication-journal.json"
        ));
        let error = run_manifest_transaction(&manifest_path, &manifest, || {
            // Page one publishes every raster/layer/metadata role. Page two
            // then leaves a partial publication before processing fails.
            for path in &destinations[..9] {
                fs::write(path, b"page one published")?;
            }
            for path in &destinations[9..12] {
                fs::write(path, b"page two partial")?;
            }
            Err(std::io::Error::other("page two failed").into())
        })
        .unwrap_err();

        assert!(error.to_string().contains("page two failed"));
        assert_eq!(fs::read(&input).unwrap(), b"input must survive rollback");
        for path in &destinations {
            assert!(!path.exists(), "rollback left {}", path.display());
        }
        assert!(!journal_path.exists());

        for (index, path) in destinations.iter().enumerate() {
            fs::write(path, format!("previous destination {index}").as_bytes()).unwrap();
        }
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = run_manifest_transaction(&manifest_path, &manifest, || {
                for path in &destinations[..4] {
                    fs::write(path, b"partial replacement")?;
                }
                panic!("page worker panicked");
            });
        }));
        assert_eq!(
            panic
                .expect_err("transaction swallowed the page panic")
                .downcast_ref::<&str>(),
            Some(&"page worker panicked")
        );
        for (index, path) in destinations.iter().enumerate() {
            assert_eq!(
                fs::read(path).unwrap(),
                format!("previous destination {index}").as_bytes()
            );
        }
        assert!(!journal_path.exists());
        run_manifest_transaction(&manifest_path, &manifest, || {
            fs::write(&destinations[0], b"successful replacement")?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            fs::read(&destinations[0]).unwrap(),
            b"successful replacement"
        );
        assert!(!journal_path.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
