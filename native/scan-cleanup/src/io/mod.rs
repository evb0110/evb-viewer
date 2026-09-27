use evb_raster_io::DecodeLimits;
use std::{
    fmt::Write as FmtWrite,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub mod pbm;
pub mod png;
pub mod raster;

pub(crate) const MAX_COMPRESSED_BYTES: usize = 512 * 1024 * 1024;
const ATOMIC_TEMP_ATTEMPTS: usize = 16;
const ATOMIC_TEMP_RANDOM_BYTES: usize = 16;

pub(crate) fn decode_limits(max_pixels: u64, max_dimension: u32) -> DecodeLimits {
    DecodeLimits {
        max_pixels,
        max_dimension,
        max_compressed_bytes: MAX_COMPRESSED_BYTES,
    }
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_with(path, |file| {
        file.write_all(bytes).map_err(|error| error.to_string())
    })
}

pub(crate) fn write_atomic_with(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    write_atomic_with_random(path, write, |bytes| {
        getrandom::fill(bytes).map_err(|error| format!("unable to obtain random bytes: {error}"))
    })
}

fn randomized_temporary_path(path: &Path, random: &[u8]) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    let mut suffix = String::with_capacity(random.len() * 2);
    for byte in random {
        write!(&mut suffix, "{byte:02x}").expect("writing to a String cannot fail");
    }
    name.push(format!(".evb-tmp-{suffix}"));
    path.with_file_name(PathBuf::from(name))
}

pub(crate) fn open_randomized_temporary(
    path: &Path,
    fill_random: &mut impl FnMut(&mut [u8]) -> Result<(), String>,
) -> Result<(File, PathBuf), String> {
    for _ in 0..ATOMIC_TEMP_ATTEMPTS {
        let mut random = [0u8; ATOMIC_TEMP_RANDOM_BYTES];
        fill_random(&mut random)?;
        let temporary = randomized_temporary_path(path, &random);
        // create_new is one atomic "does not exist + create" operation. An
        // existing symlink is therefore a collision, never something opened
        // and followed between a metadata check and this call.
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((file, temporary)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!(
        "unable to reserve randomized publication temporary after {ATOMIC_TEMP_ATTEMPTS} attempts"
    ))
}

pub(crate) struct StagedFileBackup {
    original: PathBuf,
    backup: Option<PathBuf>,
    permissions: fs::Permissions,
}

impl StagedFileBackup {
    pub(crate) fn stage_with_hook(
        original: &Path,
        before_remove: impl FnOnce(&Path, &Path) -> Result<(), String>,
    ) -> Result<Self, String> {
        let mut source = File::open(original).map_err(|error| error.to_string())?;
        let metadata = source.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            return Err(format!(
                "cannot snapshot non-regular destination {}",
                original.display()
            ));
        }
        let (mut backup_file, backup) = open_randomized_temporary(original, &mut |bytes| {
            getrandom::fill(bytes)
                .map_err(|error| format!("unable to obtain random bytes: {error}"))
        })?;
        let snapshot_result = std::io::copy(&mut source, &mut backup_file)
            .map(|_| ())
            .and_then(|()| backup_file.sync_all());
        // Close both handles before removing the original so staging also
        // works on Windows.
        drop(source);
        drop(backup_file);
        if let Err(error) = snapshot_result {
            let _ = fs::remove_file(&backup);
            return Err(error.to_string());
        }
        if let Err(error) = before_remove(original, &backup) {
            let _ = fs::remove_file(&backup);
            return Err(error);
        }
        if let Err(error) = fs::remove_file(original) {
            let _ = fs::remove_file(&backup);
            return Err(error.to_string());
        }
        Ok(Self {
            original: original.to_path_buf(),
            backup: Some(backup),
            permissions: metadata.permissions(),
        })
    }

    pub(crate) fn original(&self) -> &Path {
        &self.original
    }

    pub(crate) fn restore(mut self) -> Result<(), String> {
        let Some(backup) = self.backup.take() else {
            return Ok(());
        };
        let result = restore_staged_file(&self.original, &backup, &self.permissions);
        if let Err(error) = &result {
            self.backup = Some(backup);
            return Err(error.clone());
        }
        result
    }

    pub(crate) fn discard(mut self) -> Result<(), String> {
        let Some(backup) = self.backup.take() else {
            return Ok(());
        };
        match fs::remove_file(&backup) {
            Ok(()) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn restore_staged_file(
    original: &Path,
    backup: &Path,
    permissions: &fs::Permissions,
) -> Result<(), String> {
    match fs::symlink_metadata(original) {
        Ok(metadata) if metadata.is_dir() => {
            return Err(format!(
                "cannot restore {} over a directory",
                original.display()
            ));
        }
        Ok(_) => fs::remove_file(original).map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    fs::set_permissions(backup, permissions.clone()).map_err(|error| error.to_string())?;
    fs::rename(backup, original).map_err(|error| error.to_string())
}

impl Drop for StagedFileBackup {
    fn drop(&mut self) {
        let Some(backup) = self.backup.take() else {
            return;
        };
        let _ = restore_staged_file(&self.original, &backup, &self.permissions);
    }
}

fn write_atomic_with_random(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), String>,
    mut fill_random: impl FnMut(&mut [u8]) -> Result<(), String>,
) -> Result<(), String> {
    let (mut file, temporary) = open_randomized_temporary(path, &mut fill_random)?;
    let write_result =
        write(&mut file).and_then(|()| file.sync_all().map_err(|error| error.to_string()));
    // Windows cannot unlink an open file. Close before either rename or
    // error cleanup so the no-partial-temp guarantee is cross-platform.
    drop(file);
    let result =
        write_result.and_then(|()| fs::rename(&temporary, path).map_err(|error| error.to_string()));
    // A successful rename consumed the temporary; every other exit removes
    // the partial file. Never leave an attacker-predictable reusable path.
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    fn test_directory(label: &str) -> PathBuf {
        let id = TEST_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "evb-scan-cleanup-atomic-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn staged_backup_drop_restores_the_original_after_unwind() {
        let directory = test_directory("staged-drop");
        let original = directory.join("destination.png");
        fs::write(&original, b"previous destination").unwrap();

        let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _backup =
                StagedFileBackup::stage_with_hook(&original, |_original, _backup| Ok(())).unwrap();
            assert!(!original.exists());
            panic!("operation failed after staging");
        }));

        assert!(unwind.is_err());
        assert_eq!(fs::read(&original).unwrap(), b"previous destination");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_backup_discard_does_not_restore_after_the_original_was_removed() {
        let directory = test_directory("staged-discard-failure");
        let original = directory.join("destination.png");
        fs::write(&original, b"previous destination").unwrap();

        let backup =
            StagedFileBackup::stage_with_hook(&original, |_original, _backup| Ok(())).unwrap();
        let backup_path = backup.backup.as_ref().unwrap().clone();
        fs::remove_file(&backup_path).unwrap();
        fs::create_dir(&backup_path).unwrap();

        let error = backup.discard().unwrap_err();

        assert!(!original.exists());
        assert!(!error.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn atomic_publication_retries_a_preexisting_random_temporary() {
        let directory = test_directory("collision");
        let output = directory.join("page.png");
        let collision = randomized_temporary_path(&output, &[0; ATOMIC_TEMP_RANDOM_BYTES]);
        fs::write(&collision, b"preexisting").unwrap();
        let fills = Cell::new(0usize);

        write_atomic_with_random(
            &output,
            |file| {
                file.write_all(b"published")
                    .map_err(|error| error.to_string())
            },
            |bytes| {
                let value = u8::from(fills.get() > 0);
                fills.set(fills.get() + 1);
                bytes.fill(value);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(fs::read(&output).unwrap(), b"published");
        assert_eq!(fs::read(&collision).unwrap(), b"preexisting");
        assert_eq!(fills.get(), 2);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn atomic_publication_bounds_repeated_collisions_without_touching_them() {
        let directory = test_directory("bounded-collision");
        let output = directory.join("page.png");
        let collision = randomized_temporary_path(&output, &[0; ATOMIC_TEMP_RANDOM_BYTES]);
        fs::write(&collision, b"preexisting").unwrap();
        let wrote = Cell::new(false);

        let error = write_atomic_with_random(
            &output,
            |_| {
                wrote.set(true);
                Ok(())
            },
            |bytes| {
                bytes.fill(0);
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("after 16 attempts"));
        assert!(!wrote.get());
        assert_eq!(fs::read(&collision).unwrap(), b"preexisting");
        assert!(!output.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_publication_never_follows_a_temporary_symlink() {
        use std::os::unix::fs::symlink;

        let directory = test_directory("symlink");
        let output = directory.join("page.png");
        let victim = directory.join("victim");
        fs::write(&victim, b"victim").unwrap();
        let collision = randomized_temporary_path(&output, &[0; ATOMIC_TEMP_RANDOM_BYTES]);
        symlink(&victim, &collision).unwrap();
        let fills = Cell::new(0usize);

        write_atomic_with_random(
            &output,
            |file| {
                file.write_all(b"published")
                    .map_err(|error| error.to_string())
            },
            |bytes| {
                bytes.fill(u8::from(fills.get() > 0));
                fills.set(fills.get() + 1);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(fs::read(&victim).unwrap(), b"victim");
        assert_eq!(fs::read(&output).unwrap(), b"published");
        assert!(fs::symlink_metadata(&collision)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn atomic_publication_removes_partial_files_after_write_and_rename_errors() {
        let directory = test_directory("cleanup");
        let output = directory.join("page.png");
        let random = [7u8; ATOMIC_TEMP_RANDOM_BYTES];
        let temporary = randomized_temporary_path(&output, &random);
        let error = write_atomic_with_random(
            &output,
            |file| {
                file.write_all(b"partial").unwrap();
                Err("forced write failure".into())
            },
            |bytes| {
                bytes.copy_from_slice(&random);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error, "forced write failure");
        assert!(!temporary.exists());
        assert!(!output.exists());

        fs::create_dir(&output).unwrap();
        fs::write(output.join("child"), b"occupied").unwrap();
        let error = write_atomic_with_random(
            &output,
            |file| {
                file.write_all(b"partial")
                    .map_err(|error| error.to_string())
            },
            |bytes| {
                bytes.copy_from_slice(&random);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(!error.is_empty());
        assert!(!temporary.exists());
        assert!(output.join("child").exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
