//! A page-tree annotation ownership scan kept between saves of a PDF too
//! large to load whole.
//!
//! Proving which pages own an existing annotation and which replies point at
//! it resolves every annotation of the document: on a long report, hundreds
//! of thousands of links and seconds per save. A snapshot keeps what that
//! proof can read: the page tree, and every annotation a reference, name,
//! kind or relation can select, with the objects they point at. A link with
//! nothing but its subtype can be none of these, so it is left out, and a
//! target outside the snapshot falls back to a fresh scan. Each save extends
//! the snapshot of the file version it read with its own revision and files it
//! under the version it wrote. A version is named by the file's metadata, so
//! finding a snapshot reads no PDF bytes.
use super::*;
use evb_native_support::output::AtomicOutput;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

static CACHE: OnceLock<PathBuf> = OnceLock::new();
/// The snapshot of the file version this process appends to, for the successor its save writes.
static INPUT: Mutex<Option<OwnershipSnapshot>> = Mutex::new(None);
const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
const KEPT_SNAPSHOTS: usize = 8;
const FIELDS: [&[u8]; 6] = [
    b"IRT",
    b"Popup",
    b"Parent",
    b"Subtype",
    b"NM",
    b"EVBShapeKey",
];

pub(crate) fn set_annotation_ownership_cache(directory: PathBuf) {
    let _ = CACHE.set(directory);
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
enum Field {
    Reference(ObjectId),
    Name(Vec<u8>),
    Text(Vec<u8>),
    Integer(i64),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct OwnershipSnapshot {
    pages: Vec<ObjectId>,
    /// Each kept annotation with the pages that list it, once per listing.
    owners: Vec<(ObjectId, Vec<ObjectId>)>,
    /// The scanned keys of kept annotations and of the objects they name.
    fields: Vec<(ObjectId, Fields)>,
}

type Fields = Vec<(Vec<u8>, Field)>;

impl OwnershipSnapshot {
    /// What `scan` keeps, or `None` when a scanned key holds a value the
    /// snapshot cannot store.
    fn of_scan(scan: &DeleteScan) -> Option<Self> {
        let mut fields = Vec::new();
        for (id, object) in &scan.document.objects {
            let mut kept = Vec::new();
            for (key, value) in object.as_dict().ok()? {
                kept.push((key.clone(), Field::of(value)?));
            }
            fields.push((*id, kept));
        }
        let mut snapshot = Self {
            pages: scan.pages.clone(),
            owners: scan
                .listing
                .pages
                .iter()
                .map(|(id, pages)| (*id, pages.clone()))
                .collect(),
            fields,
        };
        snapshot.prune();
        Some(snapshot)
    }

    /// Leaves out links that hold only their subtype and that nothing names,
    /// and sorts, so two snapshots of one ownership compare equal.
    fn prune(&mut self) {
        let named = self
            .fields
            .iter()
            .flat_map(|(_, fields)| fields)
            .filter_map(|(key, value)| match value {
                Field::Reference(id) if key.as_slice() != b"Subtype" => Some(*id),
                _ => None,
            })
            .collect::<HashSet<_>>();
        let plain = self
            .fields
            .iter()
            .filter(|(id, fields)| {
                !named.contains(id)
                    && matches!(fields.as_slice(), [(key, Field::Name(name))]
                        if key.as_slice() == b"Subtype" && name.eq_ignore_ascii_case(b"Link"))
            })
            .map(|(id, _)| *id)
            .collect::<HashSet<_>>();
        self.owners
            .retain(|(id, pages)| !plain.contains(id) && !pages.is_empty());
        self.fields.retain(|(id, _)| !plain.contains(id));
        for (_, pages) in &mut self.owners {
            pages.sort_unstable();
        }
        self.owners.sort_unstable();
        self.fields.sort_unstable_by_key(|(id, _)| *id);
    }

    fn scan(&self) -> DeleteScan {
        let mut document = Document::new();
        for (id, fields) in &self.fields {
            let mut dictionary = Dictionary::new();
            for (key, value) in fields {
                dictionary.set(key.clone(), value.object());
            }
            document.objects.insert(*id, Object::Dictionary(dictionary));
        }
        let mut listing = AnnotationListing {
            pages: self.owners.iter().cloned().collect(),
            ..AnnotationListing::default()
        };
        for id in listing.pages.keys() {
            if let Ok(parent) = document
                .get_dictionary(*id)
                .and_then(|dictionary| dictionary.get(b"IRT"))
                .and_then(Object::as_reference)
            {
                listing.replies.entry(parent).or_default().push(*id);
            }
        }
        DeleteScan {
            document,
            listing,
            pages: self.pages.clone(),
        }
    }

    /// This snapshot extended with what `incremental` appended, or `None`
    /// when the revision changes something the snapshot cannot follow: the
    /// page tree, or an object it left out.
    fn successor(mut self, incremental: &IncrementalDocument) -> Option<Self> {
        let previous = incremental.get_prev_documents();
        let appended = &incremental.new_document;
        let current = |id: &ObjectId| appended.objects.get(id).or(previous.objects.get(id));
        let pages = self.pages.iter().copied().collect::<HashSet<_>>();
        for (id, object) in &appended.objects {
            let kind = object
                .as_dict()
                .ok()
                .and_then(|d| d.get(b"Type").ok()?.as_name().ok());
            if kind == Some(b"Pages") || (kind == Some(b"Page") && !pages.contains(id)) {
                return None;
            }
        }
        let mut owners = self.owners.drain(..).collect::<HashMap<_, _>>();
        let mut fields = self.fields.drain(..).collect::<HashMap<_, _>>();
        let mut added = Vec::new();
        let mut arrays = HashSet::new();
        for page in &self.pages {
            let annots_ref = |document: &Document| {
                document
                    .objects
                    .get(page)?
                    .as_dict()
                    .ok()?
                    .get(b"Annots")
                    .ok()?
                    .as_reference()
                    .ok()
            };
            let changed = appended.objects.contains_key(page)
                || [annots_ref(previous), annots_ref(appended)]
                    .iter()
                    .flatten()
                    .any(|id| appended.objects.contains_key(id));
            if !changed {
                continue;
            }
            arrays.extend(
                [annots_ref(previous), annots_ref(appended)]
                    .into_iter()
                    .flatten(),
            );
            let before =
                annotation_refs(previous.objects.get(page), |id| previous.objects.get(id))?;
            let after = annotation_refs(current(page), current)?;
            for id in &before {
                if let Some(listed) = owners.get_mut(id) {
                    listed.retain(|owner| owner != page);
                }
            }
            for id in after {
                if !owners.contains_key(&id) && !appended.objects.contains_key(&id) {
                    // A left-out link stays on its page; any other object is unknown.
                    if !before.contains(&id) {
                        return None;
                    }
                    continue;
                }
                owners.entry(id).or_default().push(*page);
                added.push(id);
            }
        }
        // An appended array that is no page's /Annots may be one the snapshot cannot place.
        if appended
            .objects
            .iter()
            .any(|(id, object)| object.as_array().is_ok() && !arrays.contains(id))
        {
            return None;
        }
        // The scan reads the keys of each listed annotation and of what they name.
        let mut pending = appended
            .objects
            .keys()
            .filter(|id| fields.contains_key(id))
            .chain(&added)
            .copied()
            .collect::<Vec<_>>();
        let mut seen = HashSet::new();
        while let Some(id) = pending.pop() {
            if !seen.insert(id) {
                continue;
            }
            // Unchanged objects keep their keys; a left-out one has unknown owners.
            let Some(object) = appended.objects.get(&id) else {
                if fields.contains_key(&id) {
                    continue;
                }
                return None;
            };
            let Ok(dictionary) = object.as_dict() else {
                fields.remove(&id);
                continue;
            };
            let mut kept = Vec::new();
            for key in FIELDS {
                if let Ok(value) = dictionary.get(key) {
                    kept.push((key.to_vec(), Field::of(value)?));
                    if key != b"Subtype" {
                        pending.extend(value.as_reference().ok());
                    }
                }
            }
            fields.insert(id, kept);
        }
        self.owners = owners.into_iter().collect();
        self.fields = fields.into_iter().collect();
        self.prune();
        Some(self)
    }
}

/// The indirect annotations a page's /Annots lists, as the scan reads them.
fn annotation_refs<'a>(
    page: Option<&'a Object>,
    object: impl Fn(&ObjectId) -> Option<&'a Object>,
) -> Option<Vec<ObjectId>> {
    let annots = match page?.as_dict().ok()?.get(b"Annots") {
        Err(_) => return Some(Vec::new()),
        Ok(Object::Reference(id)) => object(id)?,
        Ok(value) => value,
    };
    let items = annots.as_array().ok()?;
    Some(
        items
            .iter()
            .filter_map(|item| item.as_reference().ok())
            .collect(),
    )
}

impl Field {
    fn of(value: &Object) -> Option<Self> {
        Some(match value {
            Object::Reference(id) => Self::Reference(*id),
            Object::Name(name) => Self::Name(name.clone()),
            Object::String(text, _) => Self::Text(text.clone()),
            Object::Integer(value) => Self::Integer(*value),
            _ => return None,
        })
    }

    fn object(&self) -> Object {
        match self {
            Self::Reference(id) => Object::Reference(*id),
            Self::Name(name) => Object::Name(name.clone()),
            Self::Text(text) => Object::String(text.clone(), StringFormat::Literal),
            Self::Integer(value) => Object::Integer(*value),
        }
    }
}

/// Where the snapshot of the file version at `path` is filed: its path, length
/// and modification time, the facts the app tells file versions apart by. An
/// append changes the time; a revision the document store names never
/// changes. An edit in place that keeps the length and restores the time goes
/// unseen, as it does for the app's own witness.
fn identity(path: &Path) -> Result<PathBuf> {
    let directory = CACHE.get().ok_or("No annotation ownership cache")?;
    let metadata = fs::metadata(path)?;
    let mut hasher = Sha256::new();
    hasher.update(fs::canonicalize(path)?.as_os_str().as_encoded_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(
        metadata
            .modified()?
            .duration_since(UNIX_EPOCH)?
            .as_nanos()
            .to_le_bytes(),
    );
    let hex = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(directory.join(format!("annotation-ownership-{hex}.json")))
}

fn read_snapshot(path: &Path) -> Option<OwnershipSnapshot> {
    let file = File::open(identity(path).ok()?).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_SNAPSHOT_BYTES).read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Keeps the snapshot of the file version at `path`, which a save is about to
/// append to, for `record_annotation_ownership`, unless a scan already did.
pub(crate) fn remember_annotation_ownership_input(path: &Path) {
    if let Ok(mut input) = INPUT.lock() {
        if input.is_none() {
            *input = read_snapshot(path);
        }
    }
}

/// The ownership scan of `path`, from the snapshot of its bytes when `select`
/// finds its targets there, and otherwise from the page tree.
pub(crate) fn annotation_ownership_scan<T>(
    path: &Path,
    qpdf: &Path,
    select: impl Fn(&DeleteScan) -> Result<T>,
) -> Result<(DeleteScan, T)> {
    let kept = read_snapshot(path);
    if let Some(snapshot) = kept {
        let scan = snapshot.scan();
        if let Ok(selected) = select(&scan) {
            if cfg!(debug_assertions) {
                let fresh = scan_qpdf_annotation_deletes(path, qpdf, &[])?.ok_or("No qpdf scan")?;
                assert_eq!(OwnershipSnapshot::of_scan(&fresh).as_ref(), Some(&snapshot));
            }
            *INPUT
                .lock()
                .map_err(|_| "Ownership snapshot lock poisoned")? = Some(snapshot);
            return Ok((scan, selected));
        }
    }
    let scan = scan_qpdf_annotation_deletes(path, qpdf, &[])?
        .ok_or("Bundled qpdf library is required for annotation discovery")?;
    let selected = select(&scan)?;
    *INPUT
        .lock()
        .map_err(|_| "Ownership snapshot lock poisoned")? = OwnershipSnapshot::of_scan(&scan);
    Ok((scan, selected))
}

/// Files the snapshot of the version `incremental` appended to, extended with
/// its revision, under the version of `output`. A cache that cannot be
/// written costs the next save a scan, never this one.
pub(crate) fn record_annotation_ownership(incremental: &IncrementalDocument, output: &Path) {
    let Some(directory) = CACHE.get() else {
        return;
    };
    let input = INPUT.lock().ok().and_then(|mut input| input.take());
    let successor = input.and_then(|snapshot| snapshot.successor(incremental));
    let _ = (|| -> Result<()> {
        let target = identity(output)?;
        let Some(successor) = successor else {
            // No snapshot an earlier write filed under this version may stand for it.
            let _ = fs::remove_file(target);
            return Ok(());
        };
        fs::create_dir_all(directory)?;
        let bytes = serde_json::to_vec(&successor)?;
        if u64::try_from(bytes.len())? > MAX_SNAPSHOT_BYTES {
            return Ok(());
        }
        let mut staged = AtomicOutput::create(&target)?;
        staged.file_mut()?.write_all(&bytes)?;
        staged.publish()?;
        let mut kept = fs::read_dir(directory)?
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("annotation-ownership-")
            })
            .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
            .collect::<Vec<_>>();
        kept.sort_unstable_by(|left, right| right.0.cmp(&left.0));
        for (_, stale) in kept.into_iter().skip(KEPT_SNAPSHOTS) {
            let _ = fs::remove_file(stale);
        }
        Ok(())
    })();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ownership_cache_finds_a_snapshot_only_for_the_version_filed() {
        let directory =
            std::env::temp_dir().join(format!("ownership-identity-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        set_annotation_ownership_cache(directory.clone());
        fs::create_dir_all(CACHE.get().unwrap()).unwrap();
        let pdf = directory.join("document.pdf");
        let mut bytes = vec![b' '; 3 * 64 * 1024];
        bytes[96 * 1024..96 * 1024 + 10].copy_from_slice(b"/IRT 1 0 R");
        fs::write(&pdf, &bytes).unwrap();
        let snapshot = OwnershipSnapshot {
            pages: vec![(1, 0)],
            owners: vec![],
            fields: vec![],
        };
        fs::write(
            identity(&pdf).unwrap(),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .unwrap();
        assert_eq!(read_snapshot(&pdf), Some(snapshot));
        // An edit of equal length is another version: its time differs.
        bytes[96 * 1024 + 5] = b'2';
        fs::write(&pdf, &bytes).unwrap();
        File::options()
            .write(true)
            .open(&pdf)
            .unwrap()
            .set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1))
            .unwrap();
        assert_eq!(read_snapshot(&pdf), None);
        fs::remove_dir_all(directory).unwrap();
    }
}
