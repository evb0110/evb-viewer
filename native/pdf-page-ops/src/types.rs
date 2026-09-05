use super::*;
pub(crate) use evb_native_support::pdf_catalog::{
    deserialize_bounded_bookmark_items, BookmarkEntry, PageLabelRange,
};
use serde::Serialize;

fn deserialize_collection<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    deserialize_bounded_vec::<D, T, MAX_COLLECTION_ITEMS>(deserializer)
}

fn deserialize_shape_items<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    deserialize_bounded_vec::<D, T, 4_096>(deserializer)
}

fn deserialize_shape_points<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<ShapePoint>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec::<D, ShapePoint, MAX_SHAPE_MUTATION_POINTS>(deserializer)
}

struct BoundedShapeStrokeSeed {
    remaining_points: usize,
}

impl<'de> serde::de::DeserializeSeed<'de> for BoundedShapeStrokeSeed {
    type Value = Vec<ShapePoint>;

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct BoundedShapeStrokeVisitor {
            remaining_points: usize,
        }

        impl<'de> serde::de::Visitor<'de> for BoundedShapeStrokeVisitor {
            type Value = Vec<ShapePoint>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an array of bounded shape points")
            }

            fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let capacity = sequence.size_hint().unwrap_or(0).min(self.remaining_points);
                let mut points = Vec::with_capacity(capacity);
                while let Some(point) = sequence.next_element::<ShapePoint>()? {
                    if points.len() == self.remaining_points {
                        return Err(serde::de::Error::custom(format!(
                            "shape strokes exceed the {MAX_SHAPE_MUTATION_POINTS}-point admission ceiling"
                        )));
                    }
                    points.push(point);
                }
                Ok(points)
            }
        }

        deserializer.deserialize_seq(BoundedShapeStrokeVisitor {
            remaining_points: self.remaining_points,
        })
    }
}

struct ShapeStrokesVisitor;

impl<'de> serde::de::Visitor<'de> for ShapeStrokesVisitor {
    type Value = Vec<Vec<ShapePoint>>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an array containing bounded shape strokes")
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        let capacity = sequence
            .size_hint()
            .unwrap_or(0)
            .min(MAX_SHAPE_MUTATION_STROKES);
        let mut strokes = Vec::with_capacity(capacity);
        let mut point_count = 0usize;
        while strokes.len() < MAX_SHAPE_MUTATION_STROKES {
            let remaining_points = MAX_SHAPE_MUTATION_POINTS.saturating_sub(point_count);
            let Some(stroke) =
                sequence.next_element_seed(BoundedShapeStrokeSeed { remaining_points })?
            else {
                return Ok(strokes);
            };
            point_count = point_count.saturating_add(stroke.len());
            strokes.push(stroke);
        }

        if sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {
            return Err(serde::de::Error::custom(format!(
                "array exceeds the {MAX_SHAPE_MUTATION_STROKES}-item admission ceiling"
            )));
        }
        Ok(strokes)
    }
}

fn deserialize_shape_strokes<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<Vec<ShapePoint>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserializer.deserialize_seq(ShapeStrokesVisitor)
}

fn deserialize_placed_images<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<PlacedImage>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec::<D, PlacedImage, MAX_PLACED_IMAGE_MUTATIONS>(deserializer)
}

fn deserialize_placed_image_geometry_updates<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<PlacedImageGeometryUpdate>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec::<D, PlacedImageGeometryUpdate, MAX_PLACED_IMAGE_GEOMETRY_UPDATES>(
        deserializer,
    )
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeMutationContinuation {
    pub(crate) family: NativeMutationContinuationFamily,
    pub(crate) chunk_index: u32,
    pub(crate) chunk_count: u32,
    #[serde(default)]
    pub(crate) bookmark_path: Vec<u32>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeMutationContinuationFamily {
    Notes,
    #[serde(alias = "freeTextEditors")]
    TextBoxes,
    PageLabels,
    Bookmarks,
    Shapes,
    Markup,
    PlacedImages,
}

pub(crate) const MAX_MARKUP_GEOMETRY_ITEMS: usize = 512;
pub(crate) const MAX_PLACED_IMAGE_MUTATIONS: usize = 16;
pub(crate) const MAX_PLACED_IMAGE_GEOMETRY_UPDATES: usize = 256;
pub(crate) const MAX_SHAPE_MUTATION_POINTS: usize = 20_000;
pub(crate) const MAX_SHAPE_MUTATION_STROKES: usize = 4_096;

fn deserialize_optional_markup_geometry<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Vec<MarkerRect>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct OptionalMarkupGeometryVisitor;

    impl<'de> serde::de::Visitor<'de> for OptionalMarkupGeometryVisitor {
        type Value = Option<Vec<MarkerRect>>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("null or an array of text-markup geometry rectangles")
        }

        fn visit_none<E>(self) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            deserialize_bounded_vec::<D, MarkerRect, MAX_MARKUP_GEOMETRY_ITEMS>(deserializer)
                .map(Some)
        }
    }

    deserializer.deserialize_option(OptionalMarkupGeometryVisitor)
}

fn deserialize_markup_hints<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<MarkupSubtypeHint>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct MarkupHintsVisitor;

    impl<'de> serde::de::Visitor<'de> for MarkupHintsVisitor {
        type Value = Vec<MarkupSubtypeHint>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an array containing bounded text-markup hints")
        }

        fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            let capacity = sequence
                .size_hint()
                .unwrap_or(0)
                .min(MAX_MARKUP_SUBTYPE_HINTS);
            let mut hints = Vec::with_capacity(capacity);
            let mut geometry_count = 0usize;
            while let Some(hint) = sequence.next_element::<MarkupSubtypeHint>()? {
                if hints.len() == MAX_MARKUP_SUBTYPE_HINTS {
                    return Err(serde::de::Error::custom(format!(
                        "array exceeds the {MAX_MARKUP_SUBTYPE_HINTS}-item admission ceiling"
                    )));
                }
                geometry_count = geometry_count
                    .checked_add(hint.markup_geometry.as_ref().map_or(0, Vec::len))
                    .ok_or_else(|| {
                        serde::de::Error::custom("text-markup geometry item count overflowed")
                    })?;
                if geometry_count > MAX_MARKUP_GEOMETRY_ITEMS {
                    return Err(serde::de::Error::custom(format!(
                        "text-markup geometry exceeds the {MAX_MARKUP_GEOMETRY_ITEMS}-item admission ceiling"
                    )));
                }
                hints.push(hint);
            }
            Ok(hints)
        }
    }

    deserializer.deserialize_seq(MarkupHintsVisitor)
}

pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub(crate) fn domain_error(code: NativeErrorCode, message: impl Into<String>) -> Box<dyn Error> {
    Box::new(NativeError::new(code, message))
}

pub(crate) fn reclassify_domain_error(
    error: Box<dyn Error>,
    fallback_code: NativeErrorCode,
) -> Box<dyn Error> {
    if error.downcast_ref::<NativeError>().is_some() {
        error
    } else {
        domain_error(fallback_code, error.to_string())
    }
}

#[derive(Clone, Copy)]
pub(crate) struct CropMargins {
    pub(crate) top: f64,
    pub(crate) bottom: f64,
    pub(crate) left: f64,
    pub(crate) right: f64,
}

#[derive(Clone, Copy)]
pub(crate) struct PdfRect {
    pub(crate) x1: f64,
    pub(crate) y1: f64,
    pub(crate) x2: f64,
    pub(crate) y2: f64,
}

impl PdfRect {
    pub(crate) fn width(self) -> f64 {
        self.x2 - self.x1
    }

    pub(crate) fn height(self) -> f64 {
        self.y2 - self.y1
    }
}

const PDF_REFERENCE_LIMIT: usize = 128;
const PAGE_TREE_DEPTH_LIMIT: usize = 256;

#[cfg(test)]
thread_local! {
    static PAGE_TREE_NODE_READ_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_page_tree_node_read_count() {
    PAGE_TREE_NODE_READ_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn page_tree_node_read_count() -> usize {
    PAGE_TREE_NODE_READ_COUNT.with(std::cell::Cell::get)
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct PageTreeResolver {
    root_pages_id: ObjectId,
    page_count: u32,
}

impl PageTreeResolver {
    pub(crate) fn new(document: &impl PdfObjectSource) -> Result<Self> {
        let catalog = document.dictionary(document.root_id()?)?;
        let root_pages_id = catalog
            .get(b"Pages")?
            .as_reference()
            .map_err(|_| "PDF catalog /Pages must be an indirect reference")?;
        let root_pages = page_tree_dictionary(document, root_pages_id)?;
        if page_tree_node_kind(root_pages)? != PageTreeNodeKind::Pages {
            return Err("PDF catalog /Pages must reference a /Pages node".into());
        }
        let page_count = page_tree_count(document, root_pages)?;
        let page_count = u32::try_from(page_count)
            .map_err(|_| "PDF page count exceeds the supported integer range")?;
        Ok(Self {
            root_pages_id,
            page_count,
        })
    }

    pub(crate) fn page_count(&self) -> u32 {
        self.page_count
    }

    /// Return the root `/Pages /Count` declaration. Consumers that enumerate
    /// the tree should compare it with `for_each_page_id_with_count` rather
    /// than treating it as proof that every leaf is reachable.
    pub(crate) fn declared_page_count(&self) -> u32 {
        self.page_count
    }

    pub(crate) fn page_id(
        &self,
        document: &impl PdfObjectSource,
        page_number: u32,
    ) -> Result<ObjectId> {
        if page_number == 0 || page_number > self.page_count {
            return Err(page_range_error(page_number, self.page_count));
        }
        let mut seen = HashSet::new();
        resolve_page_tree_id(
            document,
            self.root_pages_id,
            u64::from(page_number - 1),
            &mut seen,
            0,
        )
    }

    /// Visit every leaf page without retaining a page-number-to-object map.
    /// Callers should use this only for checks whose result depends on every
    /// page, such as proving that a deleted annotation is no longer referenced.
    pub(crate) fn for_each_page_id<F>(
        &self,
        document: &impl PdfObjectSource,
        visit: F,
    ) -> Result<()>
    where
        F: FnMut(ObjectId) -> Result<()>,
    {
        self.for_each_page_id_with_count(document, visit)
            .map(|_| ())
    }

    /// Visit every leaf page and return the number of reachable leaves.
    ///
    /// The walk keeps only the current structural path in `seen`; callers can
    /// use the returned count to distinguish the root `/Count` declaration
    /// from the pages that were actually reachable without building a dense
    /// page map. A mismatch fails before the caller can publish its output.
    pub(crate) fn for_each_page_id_with_count<F>(
        &self,
        document: &impl PdfObjectSource,
        mut visit: F,
    ) -> Result<u64>
    where
        F: FnMut(ObjectId) -> Result<()>,
    {
        let mut seen = HashSet::new();
        let visited = walk_page_tree(document, self.root_pages_id, &mut seen, 0, &mut visit)?;
        if visited != u64::from(self.page_count) {
            return Err(format!(
                "PDF page tree declared {} pages but contains {visited}",
                self.page_count
            )
            .into());
        }
        Ok(visited)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PageTreeNodeKind {
    Page,
    Pages,
}

fn page_tree_node_kind(dictionary: &Dictionary) -> Result<PageTreeNodeKind> {
    match dictionary.get(b"Type")?.as_name()? {
        b"Page" => Ok(PageTreeNodeKind::Page),
        b"Pages" => Ok(PageTreeNodeKind::Pages),
        type_name => Err(format!(
            "PDF page tree node has unsupported /Type /{}",
            String::from_utf8_lossy(type_name)
        )
        .into()),
    }
}

fn page_tree_count(document: &impl PdfObjectSource, dictionary: &Dictionary) -> Result<u64> {
    let count = document.resolved(dictionary.get(b"Count")?)?.as_i64()?;
    if count < 0 {
        return Err("PDF page tree /Count must not be negative".into());
    }
    u64::try_from(count).map_err(|_| "PDF page tree /Count is invalid".into())
}

fn page_tree_dictionary(document: &impl PdfObjectSource, node_id: ObjectId) -> Result<&Dictionary> {
    let dictionary = document.dictionary(node_id)?;
    #[cfg(test)]
    if dictionary
        .get(b"Type")
        .ok()
        .and_then(|object| object.as_name().ok())
        .is_some_and(|name| name == b"Page" || name == b"Pages")
    {
        PAGE_TREE_NODE_READ_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    }
    Ok(dictionary)
}

fn page_tree_kids<'a>(
    document: &'a impl PdfObjectSource,
    dictionary: &'a Dictionary,
) -> Result<&'a [Object]> {
    Ok(document
        .resolved(dictionary.get(b"Kids")?)?
        .as_array()?
        .as_slice())
}

fn page_tree_child_id(object: &Object) -> Result<ObjectId> {
    object
        .as_reference()
        .map_err(|_| "PDF page tree /Kids must contain indirect references".into())
}

fn page_range_error(page_number: u32, page_count: u32) -> Box<dyn Error> {
    format!("Page {page_number} is outside the document page range 1-{page_count}").into()
}

fn resolve_page_tree_id(
    document: &impl PdfObjectSource,
    node_id: ObjectId,
    target_page_index: u64,
    seen: &mut HashSet<ObjectId>,
    depth: usize,
) -> Result<ObjectId> {
    if depth >= PAGE_TREE_DEPTH_LIMIT {
        return Err("PDF page tree exceeded the structural depth limit".into());
    }
    if !seen.insert(node_id) {
        return Err("PDF page tree contains a reference cycle".into());
    }

    let dictionary = page_tree_dictionary(document, node_id)?;
    let result = match page_tree_node_kind(dictionary)? {
        PageTreeNodeKind::Page => {
            if target_page_index == 0 {
                Ok(node_id)
            } else {
                Err("PDF page tree did not contain the requested page".into())
            }
        }
        PageTreeNodeKind::Pages => {
            let kids = page_tree_kids(document, dictionary)?;
            let declared_count = page_tree_count(document, dictionary)?;
            // A /Kids array whose length equals /Count has one page per child
            // in a well-formed tree. Indexing that array directly keeps flat
            // million-page trees sparse; a multi-page child falls through to
            // the count-aware walk below.
            if let Ok(kid_index) = usize::try_from(target_page_index) {
                if declared_count == u64::try_from(kids.len()).unwrap_or(u64::MAX) {
                    if let Some(kid) = kids.get(kid_index) {
                        let kid_id = page_tree_child_id(kid)?;
                        let kid_dictionary = page_tree_dictionary(document, kid_id)?;
                        match page_tree_node_kind(kid_dictionary)? {
                            PageTreeNodeKind::Page => {
                                seen.remove(&node_id);
                                return Ok(kid_id);
                            }
                            PageTreeNodeKind::Pages
                                if page_tree_count(document, kid_dictionary)? == 1 =>
                            {
                                let result =
                                    resolve_page_tree_id(document, kid_id, 0, seen, depth + 1);
                                seen.remove(&node_id);
                                return result;
                            }
                            PageTreeNodeKind::Pages => {}
                        }
                    }
                }
            }
            let mut skipped_pages = 0_u64;
            let mut result = Err("PDF page tree did not contain the requested page".into());
            for kid in kids {
                let kid_id = page_tree_child_id(kid)?;
                let kid_dictionary = page_tree_dictionary(document, kid_id)?;
                let kid_count = match page_tree_node_kind(kid_dictionary)? {
                    PageTreeNodeKind::Page => 1,
                    PageTreeNodeKind::Pages => page_tree_count(document, kid_dictionary)?,
                };
                let end = skipped_pages
                    .checked_add(kid_count)
                    .ok_or("PDF page tree page count overflow")?;
                if target_page_index < end {
                    result = resolve_page_tree_id(
                        document,
                        kid_id,
                        target_page_index - skipped_pages,
                        seen,
                        depth + 1,
                    );
                    break;
                }
                skipped_pages = end;
            }
            result
        }
    };
    seen.remove(&node_id);
    result
}

fn walk_page_tree<F>(
    document: &impl PdfObjectSource,
    node_id: ObjectId,
    seen: &mut HashSet<ObjectId>,
    depth: usize,
    visit: &mut F,
) -> Result<u64>
where
    F: FnMut(ObjectId) -> Result<()>,
{
    if depth >= PAGE_TREE_DEPTH_LIMIT {
        return Err("PDF page tree exceeded the structural depth limit".into());
    }
    if !seen.insert(node_id) {
        return Err("PDF page tree contains a reference cycle".into());
    }

    let dictionary = page_tree_dictionary(document, node_id)?;
    let result = match page_tree_node_kind(dictionary)? {
        PageTreeNodeKind::Page => {
            visit(node_id)?;
            Ok(1)
        }
        PageTreeNodeKind::Pages => {
            let mut count = 0_u64;
            for kid in page_tree_kids(document, dictionary)? {
                let kid_id = page_tree_child_id(kid)?;
                count = count
                    .checked_add(walk_page_tree(document, kid_id, seen, depth + 1, visit)?)
                    .ok_or("PDF page tree page count overflow")?;
            }
            Ok(count)
        }
    };
    seen.remove(&node_id);
    result
}

pub(crate) trait PdfObjectSource {
    fn stored_object(&self, object_id: ObjectId) -> Option<&Object>;

    fn page_ids(&self) -> BTreeMap<u32, ObjectId>;

    fn root_id(&self) -> Result<ObjectId>;

    fn resolved<'a>(&'a self, object: &'a Object) -> Result<&'a Object> {
        let mut object = object;
        for _ in 0..PDF_REFERENCE_LIMIT {
            let Ok(object_id) = object.as_reference() else {
                return Ok(object);
            };
            object = self
                .stored_object(object_id)
                .ok_or_else(|| missing_object_message(object_id))?;
        }
        Err("PDF reference chain exceeded the dereference limit".into())
    }

    fn object(&self, object_id: ObjectId) -> Result<&Object> {
        let object = self
            .stored_object(object_id)
            .ok_or_else(|| missing_object_message(object_id))?;
        self.resolved(object)
    }

    fn dictionary(&self, object_id: ObjectId) -> Result<&Dictionary> {
        Ok(self.object(object_id)?.as_dict()?)
    }
}

fn missing_object_message(object_id: ObjectId) -> String {
    format!("Object {}R{} was not found", object_id.0, object_id.1)
}

impl PdfObjectSource for Document {
    fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
        self.objects.get(&object_id)
    }

    fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
        self.get_pages()
    }

    fn root_id(&self) -> Result<ObjectId> {
        Ok(self.trailer.get(b"Root")?.as_reference()?)
    }
}

/// What a fresh reader sees after an incremental append: the objects the
/// appended revision rewrote, over the base revision that is still in memory.
pub(crate) struct AppendedRevision<'a> {
    base: &'a Document,
    appended: &'a Document,
}

impl<'a> AppendedRevision<'a> {
    pub(crate) fn new(incremental: &'a IncrementalDocument) -> Self {
        Self {
            base: incremental.get_prev_documents(),
            appended: &incremental.new_document,
        }
    }
}

impl PdfObjectSource for AppendedRevision<'_> {
    fn stored_object(&self, object_id: ObjectId) -> Option<&Object> {
        self.appended
            .objects
            .get(&object_id)
            .or_else(|| self.base.objects.get(&object_id))
    }

    /// Appends rewrite page dictionaries, the catalog and annotation objects but
    /// never restructure the page tree, so page identity comes from the base
    /// revision. A mutation that adds or removes pages would have to walk the
    /// appended tree instead.
    fn page_ids(&self) -> BTreeMap<u32, ObjectId> {
        self.base.get_pages()
    }

    fn root_id(&self) -> Result<ObjectId> {
        Ok(self.appended.trailer.get(b"Root")?.as_reference()?)
    }
}

pub(crate) enum Operation {
    SplitPages {
        instructions_file: PathBuf,
    },
    OverlayText {
        source_path: PathBuf,
        instructions_file: PathBuf,
    },
    Crop {
        pages_file: PathBuf,
        margins: CropMargins,
    },
    RemoveCrop {
        pages_file: PathBuf,
    },
    UpdateNoteText {
        updates_file: PathBuf,
        modified_at: String,
        append: bool,
        append_in_place: bool,
    },
    SaveNoteChanges {
        changes_file: PathBuf,
        modified_at: String,
        append: bool,
        append_in_place: bool,
    },
    SaveMutations {
        mutations_file: PathBuf,
        modified_at: String,
        append: bool,
        append_in_place: bool,
        identity_bindings_file: Option<PathBuf>,
    },
    ParseAnnotations {
        modified_at: String,
    },
    AnnotationNameIndex,
    EmbeddedShapeIndex,
    PdfConformance,
    Decrypt {
        password_file: Option<PathBuf>,
    },
    PageGeometry {
        page_number: u32,
    },
    PageSizes,
    ReadCatalog,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitPagesFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) pages: Vec<SplitPageInstruction>,
    #[serde(default)]
    pub(crate) provenance_stamp_hex: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitPageInstruction {
    pub(crate) source_page_index: usize,
    pub(crate) rotation_quarter_turns: i64,
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) outputs: Vec<SplitPageOutput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitPageOutput {
    pub(crate) crop_rect: SplitCropRect,
    #[serde(default)]
    pub(crate) content_transform: Option<SplitContentTransform>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextLayerFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) pages: Vec<TextLayerInstruction>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextLayerInstruction {
    pub(crate) source_page_index: usize,
    pub(crate) output_page_index: usize,
    /// PDF `cm` operands mapping source-page user space into output-page user space.
    pub(crate) matrix: [f64; 6],
    /// PDF text extraction commonly ignores clipping. Split pages therefore
    /// filter show operators by their positioned origin in target-page space.
    #[serde(default)]
    pub(crate) filter_to_output_page: bool,
}

/// Scales the source page's own content into the output page box, so a page
/// that is physically smaller than the document it belongs to is enlarged
/// rather than parked in a corner of an enlarged sheet. `cropRect` is read in
/// the transformed space when this is present, which is where the caller
/// already laid the output out.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitContentTransform {
    pub(crate) scale: f64,
    pub(crate) translate_x: f64,
    pub(crate) translate_y: f64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitCropRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

pub(crate) struct Config {
    pub(crate) operation: Operation,
    pub(crate) input_path: PathBuf,
    pub(crate) output_path: PathBuf,
    pub(crate) qpdf_path: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NoteTextUpdatesFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) updates: Vec<NoteTextUpdate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoteChangesFile {
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) updates: Vec<NoteTextUpdate>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) geometry_updates: Vec<NoteGeometryUpdate>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) notes: Vec<TextNote>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) free_text_notes: Vec<FreeTextNote>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) deletes: Vec<AnnotationDelete>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeMutationsFile {
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) updates: Vec<NoteTextUpdate>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) geometry_updates: Vec<NoteGeometryUpdate>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) notes: Vec<TextNote>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) free_text_notes: Vec<FreeTextNote>,
    #[serde(default)]
    #[serde(rename = "textBoxes", alias = "freeTextEditors")]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) text_boxes: Vec<TextBoxMutation>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) deletes: Vec<AnnotationDelete>,
    pub(crate) page_labels: Option<PageLabelsMutation>,
    pub(crate) bookmarks: Option<BookmarksMutation>,
    pub(crate) shapes: Option<ShapesMutation>,
    pub(crate) markup: Option<MarkupMutation>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_placed_images")]
    pub(crate) placed_images: Vec<PlacedImage>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_placed_image_geometry_updates")]
    pub(crate) placed_image_geometry_updates: Vec<PlacedImageGeometryUpdate>,
    #[serde(default)]
    pub(crate) continuation: Option<NativeMutationContinuation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlacedImageGeometryUpdate {
    pub(crate) page_index: u32,
    #[serde(default)]
    pub(crate) stable_key: Option<String>,
    #[serde(default)]
    pub(crate) annotation_id: Option<String>,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    #[serde(default)]
    pub(crate) rotation_degrees: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoteTextUpdate {
    pub(crate) object_number: u32,
    pub(crate) generation_number: u16,
    pub(crate) text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NoteGeometryUpdate {
    pub(crate) object_number: u32,
    pub(crate) generation_number: u16,
    pub(crate) page_index: u32,
    pub(crate) marker_rect: MarkerRect,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MarkerRect {
    pub(crate) left: f64,
    pub(crate) top: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextNote {
    pub(crate) page_index: u32,
    pub(crate) stable_key: String,
    pub(crate) text: String,
    pub(crate) marker_rect: MarkerRect,
    pub(crate) author: Option<String>,
    pub(crate) color: Option<String>,
    pub(crate) created_at: Option<u64>,
}

/// Legacy mutation callers still send `freeTextNotes`. Keep the old Rust name
/// as an alias while `/Text` is now the only note representation written.
pub(crate) type FreeTextNote = TextNote;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextBoxMutation {
    pub(crate) page_index: u32,
    pub(crate) stable_key: String,
    #[serde(default)]
    pub(crate) annotation_id: Option<String>,
    pub(crate) text: String,
    pub(crate) rect: [f64; 4],
    pub(crate) rotation: u16,
    pub(crate) font_size: f64,
    pub(crate) color: [u8; 3],
    #[serde(default)]
    pub(crate) author: Option<String>,
    #[serde(default)]
    pub(crate) created_at: Option<u64>,
    #[serde(default)]
    pub(crate) modified_at: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageLabelsMutation {
    pub(crate) total_pages: u32,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) ranges: Vec<PageLabelRange>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BookmarksMutation {
    pub(crate) total_pages: u32,
    pub(crate) untitled_label: String,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_bounded_bookmark_items")]
    pub(crate) items: Vec<BookmarkEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShapesMutation {
    pub(crate) total_pages: u32,
    #[serde(default)]
    pub(crate) rewrite_shape_state: bool,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) shapes: Vec<ShapeAnnotation>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) deleted_annotation_ids: Vec<String>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) deleted_stable_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MarkupMutation {
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_items")]
    pub(crate) overrides: Vec<(String, String)>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_markup_hints")]
    pub(crate) hints: Vec<MarkupSubtypeHint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlacedImage {
    pub(crate) page_index: u32,
    #[serde(default)]
    pub(crate) stable_key: Option<String>,
    #[serde(default)]
    pub(crate) annotation_id: Option<String>,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) rotation_degrees: Option<f64>,
    pub(crate) mime_type: String,
    pub(crate) bytes_path: PathBuf,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
    #[serde(skip)]
    pub(crate) validated_bytes: std::cell::RefCell<Option<Vec<u8>>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MarkupSubtypeHint {
    pub(crate) subtype: String,
    pub(crate) page_index: u32,
    pub(crate) marker_rect: MarkerRect,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_optional_markup_geometry")]
    pub(crate) markup_geometry: Option<Vec<MarkerRect>>,
    #[serde(default)]
    pub(crate) annotation_id: Option<String>,
    #[serde(default)]
    pub(crate) app_annotation_id: Option<String>,
    #[serde(default)]
    pub(crate) color: Option<String>,
    #[serde(default)]
    pub(crate) contents: Option<String>,
    #[serde(default)]
    pub(crate) id: Option<String>,
    #[serde(default)]
    pub(crate) page_markup_index: Option<u32>,
    #[serde(default)]
    pub(crate) source: Option<String>,
}

/// One identity report entry: the caller's canonical annotation identity and
/// the PDF object reference the writer produced for it. Every writer family
/// (markup, notes, text boxes, stamps and shapes) pushes into the same report.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationIdentityBinding {
    pub(crate) annotation_id: String,
    pub(crate) pdf_ref: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShapePoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShapeAnnotation {
    #[serde(rename = "type")]
    pub(crate) shape_type: String,
    pub(crate) page_index: u32,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    #[serde(default)]
    pub(crate) x2: Option<f64>,
    #[serde(default)]
    pub(crate) y2: Option<f64>,
    pub(crate) color: String,
    #[serde(default)]
    pub(crate) fill_color: Option<String>,
    pub(crate) opacity: f64,
    pub(crate) stroke_width: f64,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_points")]
    pub(crate) points: Vec<ShapePoint>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_shape_strokes")]
    pub(crate) strokes: Vec<Vec<ShapePoint>>,
    #[serde(default)]
    pub(crate) annotation_id: Option<String>,
    #[serde(default)]
    pub(crate) stable_key: Option<String>,
    #[serde(default)]
    pub(crate) pdf_subtype: Option<String>,
    #[serde(default)]
    pub(crate) line_start_style: Option<String>,
    #[serde(default)]
    pub(crate) line_end_style: Option<String>,
    #[serde(default)]
    pub(crate) created_at: Option<u64>,
    #[serde(default)]
    pub(crate) modified_at: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnnotationDelete {
    pub(crate) page_index: u32,
    pub(crate) object_number: Option<u32>,
    pub(crate) generation_number: Option<u16>,
    pub(crate) stable_key: Option<String>,
    pub(crate) created_at: Option<u64>,
}

#[cfg(test)]
mod protocol_schema_tests {
    use super::*;

    #[test]
    fn canonical_mutation_fixture_round_trips_and_rejects_unknown_fields() {
        let source = include_str!("../../protocol-fixtures/pdf-page-ops-save-mutations.json");
        let parsed: NativeMutationsFile = serde_json::from_str(source).unwrap();
        assert_eq!(parsed.text_boxes.len(), 1);
        assert_eq!(parsed.placed_images.len(), 1);

        let with_unknown = source.replacen("{", r#"{"unknownField":true,"#, 1);
        assert!(serde_json::from_str::<NativeMutationsFile>(&with_unknown).is_err());
    }

    #[test]
    fn shape_stroke_sidecars_reject_an_oversized_nested_collection() {
        let strokes = std::iter::repeat_n("[]", MAX_SHAPE_MUTATION_STROKES + 1)
            .collect::<Vec<_>>()
            .join(",");
        let source = format!(
            r##"{{"type":"polyline","pageIndex":0,"x":0.1,"y":0.1,"width":0.3,"height":0.3,"color":"#336699","opacity":1,"strokeWidth":1,"strokes":[{strokes}]}}"##,
        );

        let error = match serde_json::from_str::<ShapeAnnotation>(&source) {
            Ok(_) => panic!("the nested ink stroke array must be bounded during decoding"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("4096-item admission ceiling"));
    }

    #[test]
    fn shape_stroke_sidecars_reject_cumulative_points_during_decoding() {
        let point = r#"{"x":0.2,"y":0.2}"#;
        let stroke_point_count = MAX_SHAPE_MUTATION_POINTS / 2 + 1;
        let stroke = format!(
            "[{}]",
            std::iter::repeat_n(point, stroke_point_count)
                .collect::<Vec<_>>()
                .join(",")
        );
        let source = format!(
            r##"{{"type":"polyline","pageIndex":0,"x":0.1,"y":0.1,"width":0.3,"height":0.3,"color":"#336699","opacity":1,"strokeWidth":1,"strokes":[{stroke},{stroke}]}}"##,
        );

        let error = match serde_json::from_str::<ShapeAnnotation>(&source) {
            Ok(_) => panic!("cumulative stroke points must be bounded during decoding"),
            Err(error) => error,
        };
        assert!(error
            .to_string()
            .contains("shape strokes exceed the 20000-point admission ceiling"));
    }
}
