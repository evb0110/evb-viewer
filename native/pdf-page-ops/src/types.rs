use super::*;
pub(crate) use evb_native_support::pdf_catalog::{
    deserialize_bounded_bookmark_items, BookmarkEntry, PageLabelRange,
};
use evb_native_support::{bounded_io::record_deserialization_error, NativeErrorCode};
use serde::Serialize;

pub(crate) fn deserialize_collection<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Vec<T>, D::Error>
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
                        record_deserialization_error(NativeErrorCode::TooLarge);
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
            record_deserialization_error(NativeErrorCode::TooLarge);
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
    PageRotations,
    PageCrops,
    PageCropRemovals,
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
                    record_deserialization_error(NativeErrorCode::TooLarge);
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
                    record_deserialization_error(NativeErrorCode::TooLarge);
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

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageRotationMutation {
    /// Zero-based page index, matching the renderer's native mutation schema.
    pub(crate) page_index: u32,
    /// Clockwise quarter-turn increment. The effective inherited rotation is
    /// normalized before this increment is applied.
    pub(crate) angle: i64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageCropMutation {
    /// Zero-based page index, matching `PageRotationMutation`.
    pub(crate) page_index: u32,
    pub(crate) top: f64,
    pub(crate) bottom: f64,
    pub(crate) left: f64,
    pub(crate) right: f64,
    #[serde(default)]
    pub(crate) physical: bool,
}

impl PageCropMutation {
    pub(crate) fn margins(self) -> CropMargins {
        CropMargins {
            top: self.top,
            bottom: self.bottom,
            left: self.left,
            right: self.right,
            physical: self.physical,
        }
    }
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

pub(crate) fn read_normalized_rect(
    document: &impl PdfObjectSource,
    object: &Object,
) -> Result<Option<PdfRect>> {
    let values = document.resolved(object)?.as_array()?;
    if values.len() != 4 {
        return Ok(None);
    }
    let mut numbers = [0.0; 4];
    for (slot, value) in numbers.iter_mut().zip(values) {
        *slot = object_to_f64(document.resolved(value)?)?;
    }
    let rect = PdfRect {
        x1: numbers[0].min(numbers[2]),
        y1: numbers[1].min(numbers[3]),
        x2: numbers[0].max(numbers[2]),
        y2: numbers[1].max(numbers[3]),
    };
    Ok((rect.width() > 0.0 && rect.height() > 0.0).then_some(rect))
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

/// A page tree that does not resolve is refused, not repaired: a repair
/// would pick one numbering, so the refusal is not `CorruptXref`.
pub(crate) fn page_tree_damaged(error: Box<dyn Error>) -> Box<dyn Error> {
    domain_error(
        NativeErrorCode::InvalidRequest,
        format!("The page tree is damaged: {error}"),
    )
}

#[derive(Clone, Debug)]
pub(crate) struct PageTreeResolver {
    root_pages_id: ObjectId,
    page_count: u32,
    validated_pages: Option<Vec<ObjectId>>,
    child_prefixes: std::cell::RefCell<HashMap<ObjectId, PageTreePrefixCache>>,
}

#[derive(Clone, Debug, Default)]
struct PageTreePrefixCache {
    /// Cumulative exclusive leaf count and child id for each scanned kid.
    entries: Vec<(u64, ObjectId)>,
    /// Next unscanned index in the node's `/Kids` array.
    next_kid: usize,
    /// True when `declared_count != kids.len()` so direct indexing never applies
    /// and cached prefix lookups can bypass reading the node dictionary again.
    skip_direct_index: bool,
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
            validated_pages: None,
            child_prefixes: std::cell::RefCell::new(HashMap::new()),
        })
    }

    /// The resolver every page edit numbers pages through. It refuses a tree
    /// whose pages a reader could number differently: every leaf is a page,
    /// appears once, has no cycles or shared branches, and every subtree's
    /// declared `/Count` matches its actual leaf count — checked in one O(P) walk.
    pub(crate) fn validated(document: &impl PdfObjectSource) -> Result<Self> {
        let tree = Self::new(document).map_err(page_tree_damaged)?;
        let mut in_path = HashSet::new();
        let mut visited = HashSet::new();
        let mut pages =
            Vec::with_capacity(usize::try_from(tree.page_count).unwrap_or(0).min(16_384));
        let count = validate_page_tree_node(
            document,
            tree.root_pages_id,
            &mut in_path,
            &mut visited,
            0,
            &mut pages,
        )
        .map_err(page_tree_damaged)?;
        if count != u64::from(tree.page_count) {
            return Err(page_tree_damaged(
                format!(
                    "PDF page tree declared {} pages but contains {count}",
                    tree.page_count
                )
                .into(),
            ));
        }
        Ok(Self {
            validated_pages: Some(pages),
            ..tree
        })
    }

    /// The resolver once both ends of the declared tree resolve, checked
    /// without iterating every leaf. This catches a stale /Count or an
    /// unreachable branch while keeping path-backed admission independent of
    /// document page count.
    pub(crate) fn with_both_ends(document: &impl PdfObjectSource) -> Result<Self> {
        let tree = Self::new(document)?;
        for page_number in [1, tree.page_count].into_iter().filter(|page| *page > 0) {
            tree.page_id(document, page_number)?;
        }
        Ok(tree)
    }

    pub(crate) fn page_count(&self) -> u32 {
        self.page_count
    }

    pub(crate) fn validated_pages(&self) -> Option<&[ObjectId]> {
        self.validated_pages.as_deref()
    }

    pub(crate) fn page_id(
        &self,
        document: &impl PdfObjectSource,
        page_number: u32,
    ) -> Result<ObjectId> {
        if page_number == 0 || page_number > self.page_count {
            return Err(page_range_error(page_number, self.page_count));
        }
        if let Some(pages) = &self.validated_pages {
            return pages
                .get((page_number - 1) as usize)
                .copied()
                .ok_or_else(|| page_range_error(page_number, self.page_count));
        }
        let mut seen = HashSet::new();
        resolve_page_tree_id(
            document,
            self.root_pages_id,
            u64::from(page_number - 1),
            &mut seen,
            0,
            &self.child_prefixes,
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
    /// Visits every reachable page leaf in tree order and verifies the total
    /// matches the root `/Count` declaration.
    ///
    /// Tracks both the active structural path (`in_path`, for reference cycles)
    /// and every node visited across the whole traversal (`visited`, rejecting
    /// shared `/Kids` DAG nodes on the first duplicate edge per ISO 32000-1
    /// section 7.7.3). A mismatch fails before the caller can publish its
    /// output.
    pub(crate) fn for_each_page_id_with_count<F>(
        &self,
        document: &impl PdfObjectSource,
        mut visit: F,
    ) -> Result<u64>
    where
        F: FnMut(ObjectId) -> Result<()>,
    {
        let mut in_path = HashSet::new();
        let mut visited = HashSet::new();
        let count = walk_page_tree(
            document,
            self.root_pages_id,
            &mut in_path,
            &mut visited,
            0,
            &mut visit,
        )?;
        if count != u64::from(self.page_count) {
            return Err(format!(
                "PDF page tree declared {} pages but contains {count}",
                self.page_count
            )
            .into());
        }
        Ok(count)
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
    child_prefixes: &std::cell::RefCell<HashMap<ObjectId, PageTreePrefixCache>>,
) -> Result<ObjectId> {
    if depth >= PAGE_TREE_DEPTH_LIMIT {
        return Err("PDF page tree exceeded the structural depth limit".into());
    }
    if !seen.insert(node_id) {
        return Err("PDF page tree contains a reference cycle".into());
    }

    let cached_hit = {
        let prefixes = child_prefixes.borrow();
        prefixes
            .get(&node_id)
            .filter(|cache| cache.skip_direct_index)
            .and_then(|cache| {
                let pos = cache
                    .entries
                    .partition_point(|&(end, _)| end <= target_page_index);
                cache.entries.get(pos).map(|&(_, kid_id)| {
                    let skipped = if pos == 0 {
                        0
                    } else {
                        cache.entries[pos - 1].0
                    };
                    (kid_id, target_page_index - skipped)
                })
            })
    };
    if let Some((kid_id, sub_index)) = cached_hit {
        let result =
            resolve_page_tree_id(document, kid_id, sub_index, seen, depth + 1, child_prefixes);
        seen.remove(&node_id);
        return result;
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
            let count_matches_kids =
                declared_count == u64::try_from(kids.len()).unwrap_or(u64::MAX);
            // A /Kids array whose length equals /Count has one page per child
            // in a well-formed tree. Check direct indexing before consulting
            // the prefix cache so ordinal resolution never depends on which
            // pages were queried earlier; a non-unit child falls through to
            // the count-aware prefix walk below.
            if count_matches_kids {
                if let Ok(kid_index) = usize::try_from(target_page_index) {
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
                                let result = resolve_page_tree_id(
                                    document,
                                    kid_id,
                                    0,
                                    seen,
                                    depth + 1,
                                    child_prefixes,
                                );
                                seen.remove(&node_id);
                                return result;
                            }
                            PageTreeNodeKind::Pages => {}
                        }
                    }
                }
            }
            let target_child = {
                let mut prefixes = child_prefixes.borrow_mut();
                let cache = prefixes.entry(node_id).or_default();
                cache.skip_direct_index = !count_matches_kids;
                let pos = cache
                    .entries
                    .partition_point(|&(end, _)| end <= target_page_index);
                if let Some(&(_, kid_id)) = cache.entries.get(pos) {
                    let skipped = if pos == 0 {
                        0
                    } else {
                        cache.entries[pos - 1].0
                    };
                    Some((kid_id, target_page_index - skipped))
                } else {
                    let mut skipped_pages = cache.entries.last().map_or(0, |&(end, _)| end);
                    let mut found = None;
                    while cache.next_kid < kids.len() {
                        let kid = &kids[cache.next_kid];
                        let kid_id = page_tree_child_id(kid)?;
                        let kid_dictionary = page_tree_dictionary(document, kid_id)?;
                        let kid_count = match page_tree_node_kind(kid_dictionary)? {
                            PageTreeNodeKind::Page => 1,
                            PageTreeNodeKind::Pages => page_tree_count(document, kid_dictionary)?,
                        };
                        let end = skipped_pages
                            .checked_add(kid_count)
                            .ok_or("PDF page tree page count overflow")?;
                        cache.entries.push((end, kid_id));
                        cache.next_kid += 1;
                        if target_page_index < end {
                            found = Some((kid_id, target_page_index - skipped_pages));
                            break;
                        }
                        skipped_pages = end;
                    }
                    found
                }
            };
            match target_child {
                Some((kid_id, sub_index)) => resolve_page_tree_id(
                    document,
                    kid_id,
                    sub_index,
                    seen,
                    depth + 1,
                    child_prefixes,
                ),
                None => Err("PDF page tree did not contain the requested page".into()),
            }
        }
    };
    seen.remove(&node_id);
    result
}

fn validate_page_tree_node(
    document: &impl PdfObjectSource,
    node_id: ObjectId,
    in_path: &mut HashSet<ObjectId>,
    visited: &mut HashSet<ObjectId>,
    depth: usize,
    pages: &mut Vec<ObjectId>,
) -> Result<u64> {
    if depth >= PAGE_TREE_DEPTH_LIMIT {
        return Err("PDF page tree exceeded the structural depth limit".into());
    }
    if !in_path.insert(node_id) {
        return Err("PDF page tree contains a reference cycle".into());
    }
    if !visited.insert(node_id) {
        in_path.remove(&node_id);
        return Err("PDF page tree shares a node across multiple branches".into());
    }

    let dictionary = page_tree_dictionary(document, node_id)?;
    let result = match page_tree_node_kind(dictionary)? {
        PageTreeNodeKind::Page => {
            pages.push(node_id);
            Ok(1)
        }
        PageTreeNodeKind::Pages => {
            let declared_count = page_tree_count(document, dictionary)?;
            let kids = page_tree_kids(document, dictionary)?;
            let flat_candidate = declared_count == u64::try_from(kids.len()).unwrap_or(u64::MAX);
            let mut actual_count = 0_u64;
            for (kid_index, kid) in kids.iter().enumerate() {
                let kid_id = page_tree_child_id(kid)?;
                let running_before = actual_count;
                let kid_count =
                    validate_page_tree_node(document, kid_id, in_path, visited, depth + 1, pages)?;
                if flat_candidate && kid_count == 1 && running_before != kid_index as u64 {
                    return Err(
                        format!("its counts place another page at {}", running_before + 1).into(),
                    );
                }
                actual_count = actual_count
                    .checked_add(kid_count)
                    .ok_or("PDF page tree page count overflow")?;
            }
            if actual_count != declared_count {
                Err(format!(
                    "PDF page tree node {} {} R declared {declared_count} pages but contains {actual_count}",
                    node_id.0, node_id.1
                )
                .into())
            } else {
                Ok(actual_count)
            }
        }
    };
    in_path.remove(&node_id);
    result
}

fn walk_page_tree<F>(
    document: &impl PdfObjectSource,
    node_id: ObjectId,
    in_path: &mut HashSet<ObjectId>,
    visited: &mut HashSet<ObjectId>,
    depth: usize,
    visit: &mut F,
) -> Result<u64>
where
    F: FnMut(ObjectId) -> Result<()>,
{
    if depth >= PAGE_TREE_DEPTH_LIMIT {
        return Err("PDF page tree exceeded the structural depth limit".into());
    }
    if !in_path.insert(node_id) {
        return Err("PDF page tree contains a reference cycle".into());
    }
    if !visited.insert(node_id) {
        in_path.remove(&node_id);
        return Err("PDF page tree shares a node across multiple branches".into());
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
                    .checked_add(walk_page_tree(
                        document,
                        kid_id,
                        in_path,
                        visited,
                        depth + 1,
                        visit,
                    )?)
                    .ok_or("PDF page tree page count overflow")?;
            }
            Ok(count)
        }
    };
    in_path.remove(&node_id);
    result
}

pub(crate) trait PdfObjectSource {
    fn located_pages(&self) -> Option<&LocatedPages> {
        None
    }

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

/// The read seam made writable for one output strategy. A mutation written
/// against it serves both: a loaded document changes in place for a full
/// rewrite, an incremental one copies each written object into the revision
/// it appends. Reads see the writes already made.
pub(crate) trait PdfObjectStore: PdfObjectSource {
    fn object_mut(&mut self, object_id: ObjectId) -> Result<&mut Object>;

    /// Drops an object: a loaded document forgets it, an appended revision
    /// frees it as `null` over the base revision that still holds it.
    fn delete_object(&mut self, object_id: ObjectId);

    /// Every object a reader of this state finds, each once.
    fn stored_objects(&self) -> impl Iterator<Item = (ObjectId, &Object)>;

    /// The highest object number in use; new objects are numbered past it.
    fn max_id(&self) -> u32;

    /// Reserves the next object number past `max_id`.
    fn new_object_id(&mut self) -> ObjectId;

    /// Stores `object` as `object_id`: a new number from `new_object_id`, or
    /// one whose whole object it replaces.
    fn put_object(&mut self, object_id: ObjectId, object: Object);

    fn add_object(&mut self, object: impl Into<Object>) -> ObjectId {
        let object_id = self.new_object_id();
        self.put_object(object_id, object.into());
        object_id
    }

    fn dictionary_mut(&mut self, object_id: ObjectId) -> Result<&mut Dictionary> {
        Ok(self.object_mut(object_id)?.as_dict_mut()?)
    }
}

impl PdfObjectStore for Document {
    fn object_mut(&mut self, object_id: ObjectId) -> Result<&mut Object> {
        Ok(self.get_object_mut(object_id)?)
    }

    fn delete_object(&mut self, object_id: ObjectId) {
        self.objects.remove(&object_id);
    }

    fn stored_objects(&self) -> impl Iterator<Item = (ObjectId, &Object)> {
        self.objects.iter().map(|(id, object)| (*id, object))
    }

    fn max_id(&self) -> u32 {
        self.max_id
    }

    fn new_object_id(&mut self) -> ObjectId {
        Document::new_object_id(self)
    }

    fn put_object(&mut self, object_id: ObjectId, object: Object) {
        self.max_id = self.max_id.max(object_id.0);
        self.objects.insert(object_id, object);
    }
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SplitPagesFile {
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) pages: Vec<SplitPageInstruction>,
    #[serde(default)]
    pub(crate) provenance_stamp_hex: Option<String>,
    #[serde(default)]
    pub(crate) catalog: SplitCatalog,
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
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) page_rotations: Vec<PageRotationMutation>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) page_crops: Vec<PageCropMutation>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_collection")]
    pub(crate) page_crop_removals: Vec<u32>,
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
    #[serde(default)]
    pub(crate) author: Option<String>,
    #[serde(default)]
    pub(crate) source_image: Option<PdfAnnotationParseStampImage>,
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
    /// `None` leaves an imported note's existing color untouched. `Some(None)`
    /// removes `/C`, which represents the canonical null color.
    #[serde(default)]
    pub(crate) color: Option<Option<String>>,
    #[serde(default)]
    pub(crate) open: Option<bool>,
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
    #[serde(default)]
    pub(crate) recovery_data: Option<String>,
    pub(crate) page_index: u32,
    pub(crate) stable_key: String,
    pub(crate) text: String,
    pub(crate) marker_rect: MarkerRect,
    pub(crate) author: Option<String>,
    pub(crate) color: Option<String>,
    pub(crate) created_at: Option<u64>,
    #[serde(default)]
    pub(crate) open: bool,
}

/// Legacy mutation callers still send `freeTextNotes`. Keep the old Rust name
/// as an alias while `/Text` is now the only note representation written.
pub(crate) type FreeTextNote = TextNote;

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
    #[serde(deserialize_with = "deserialize_markup_hints")]
    pub(crate) hints: Vec<MarkupSubtypeHint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlacedImage {
    #[serde(default)]
    pub(crate) author: Option<String>,
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
    #[serde(default)]
    pub(crate) bytes_path: PathBuf,
    #[serde(default)]
    pub(crate) bytes_base64: Option<String>,
    #[serde(default)]
    #[cfg_attr(
        not(all(target_family = "wasm", target_os = "unknown")),
        allow(dead_code)
    )]
    pub(crate) bytes_source_index: Option<u32>,
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
    pub(crate) opacity: Option<f64>,
    #[serde(default)]
    pub(crate) contents: Option<String>,
    #[serde(default)]
    pub(crate) author: Option<String>,
    #[serde(default)]
    pub(crate) created_at: Option<u64>,
    #[serde(default)]
    pub(crate) modified_at: Option<u64>,
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
    #[serde(default)]
    pub(crate) author: Option<String>,
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

    #[test]
    fn multi_shape_payload_at_100000_points_deserializes_cleanly() {
        let point = r#"{"x":0.2,"y":0.2}"#;
        let stroke = format!(
            "[{}]",
            std::iter::repeat_n(point, MAX_SHAPE_MUTATION_POINTS)
                .collect::<Vec<_>>()
                .join(",")
        );
        let shape = format!(
            r##"{{"type":"polyline","pageIndex":0,"x":0.1,"y":0.1,"width":0.3,"height":0.3,"color":"#336699","opacity":1,"strokeWidth":1,"pdfSubtype":"Ink","strokes":[{stroke}]}}"##,
        );
        let shapes = std::iter::repeat_n(shape.as_str(), 5)
            .collect::<Vec<_>>()
            .join(",");
        let source = format!(
            r#"{{"shapes":{{"totalPages":1,"rewriteShapeState":false,"shapes":[{shapes}],"deletedAnnotationIds":[],"deletedStableKeys":[]}}}}"#,
        );

        let parsed: NativeMutationsFile = serde_json::from_str(&source)
            .expect("a 100,000-point multi-shape payload must deserialize cleanly");
        let shapes_mutation = parsed.shapes.expect("shapes mutation must be present");
        assert_eq!(shapes_mutation.shapes.len(), 5);
        let total_points: usize = shapes_mutation
            .shapes
            .iter()
            .flat_map(|item| item.strokes.iter())
            .map(Vec::len)
            .sum();
        assert_eq!(total_points, 100_000);

        // 5 shapes * (1 shape + 1 stroke + 19,998 points) = 100,000 sidecar items (exact admission ceiling).
        let admissible_stroke = format!(
            "[{}]",
            std::iter::repeat_n(point, MAX_SHAPE_MUTATION_POINTS - 2)
                .collect::<Vec<_>>()
                .join(",")
        );
        let admissible_shape = format!(
            r##"{{"type":"polyline","pageIndex":0,"x":0.1,"y":0.1,"width":0.3,"height":0.3,"color":"#336699","opacity":1,"strokeWidth":1,"pdfSubtype":"Ink","strokes":[{admissible_stroke}]}}"##,
        );
        let admissible_shapes = std::iter::repeat_n(admissible_shape.as_str(), 5)
            .collect::<Vec<_>>()
            .join(",");
        let admissible_source = format!(
            r#"{{"shapes":{{"totalPages":1,"rewriteShapeState":false,"shapes":[{admissible_shapes}],"deletedAnnotationIds":[],"deletedStableKeys":[]}}}}"#,
        );
        let admitted = input::read_native_mutations_bytes(admissible_source.as_bytes())
            .expect("a 100,000-item multi-shape boundary payload must pass native admission");
        let admitted_shapes = admitted.shapes.expect("admitted shapes must be present");
        assert_eq!(admitted_shapes.shapes.len(), 5);
        let admitted_points: usize = admitted_shapes
            .shapes
            .iter()
            .flat_map(|item| item.strokes.iter())
            .map(Vec::len)
            .sum();
        assert_eq!(admitted_points, 99_990);
    }

    fn build_grouped_page_tree_document(page_count: u32, group_size: u32) -> Document {
        assert!(page_count > 0 && group_size > 0);
        let mut doc = Document::with_version("1.5");
        let root_pages_id = doc.new_object_id();
        let mut branch_kids = Vec::new();
        let mut remaining = page_count;
        while remaining > 0 {
            let chunk = remaining.min(group_size);
            remaining -= chunk;
            let branch_id = doc.new_object_id();
            let mut leaf_kids = Vec::with_capacity(chunk as usize);
            for _ in 0..chunk {
                let page_id = doc.new_object_id();
                doc.objects.insert(
                    page_id,
                    Object::Dictionary(dictionary! {
                        "Type" => "Page",
                        "Parent" => branch_id,
                        "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
                    }),
                );
                leaf_kids.push(Object::Reference(page_id));
            }
            doc.objects.insert(
                branch_id,
                Object::Dictionary(dictionary! {
                    "Type" => "Pages",
                    "Parent" => root_pages_id,
                    "Kids" => leaf_kids,
                    "Count" => i64::from(chunk),
                }),
            );
            branch_kids.push(Object::Reference(branch_id));
        }
        doc.objects.insert(
            root_pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => branch_kids,
                "Count" => i64::from(page_count),
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => root_pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc
    }

    #[test]
    fn validated_page_tree_scales_linearly_on_wide_non_flat_trees() {
        let mut reads_by_size = Vec::new();
        for page_count in [2_500_u32, 5_000_u32, 10_000_u32] {
            let doc = build_grouped_page_tree_document(page_count, 2);
            reset_page_tree_node_read_count();
            let validated = PageTreeResolver::validated(&doc).unwrap();
            let validate_reads = page_tree_node_read_count();
            assert_eq!(validated.page_count(), page_count);
            assert_eq!(
                validated.validated_pages().unwrap().len(),
                page_count as usize
            );
            // 1 root (new) + 1 root (walk) + P/2 branches + P leaves = 1.5*P + 2
            let expected_max = (page_count as usize) * 2 + 10;
            assert!(
                validate_reads <= expected_max,
                "expected O(P) reads for {page_count} pages, got {validate_reads}"
            );
            reads_by_size.push((page_count, validate_reads));

            // Subsequent ordinal lookups on a validated resolver take 0 tree reads.
            reset_page_tree_node_read_count();
            let first = validated.page_id(&doc, 1).unwrap();
            let mid = validated.page_id(&doc, page_count / 2).unwrap();
            let last = validated.page_id(&doc, page_count).unwrap();
            assert_eq!(page_tree_node_read_count(), 0);

            // Unvalidated resolver uses cached child prefixes + binary search.
            reset_page_tree_node_read_count();
            let resolver = PageTreeResolver::new(&doc).unwrap();
            assert_eq!(resolver.page_id(&doc, 1).unwrap(), first);
            assert_eq!(resolver.page_id(&doc, page_count / 2).unwrap(), mid);
            assert_eq!(resolver.page_id(&doc, page_count).unwrap(), last);
            for page in (1..=page_count).step_by(17) {
                assert_eq!(
                    resolver.page_id(&doc, page).unwrap(),
                    validated.page_id(&doc, page).unwrap()
                );
            }
            let cached_lookup_reads = page_tree_node_read_count();
            assert!(
                cached_lookup_reads <= (page_count as usize) * 2 + 10,
                "expected O(P) prefix-cached reads for {page_count} pages, got {cached_lookup_reads}"
            );
        }
        // 4x page count (2.5k -> 10k) must produce ~4x reads, never 16x (O(P^2)).
        let reads_2500 = reads_by_size[0].1;
        let reads_10000 = reads_by_size[2].1;
        assert!(
            reads_10000 <= reads_2500 * 5,
            "non-linear growth: 2.5k={reads_2500}, 10k={reads_10000}"
        );
    }

    #[test]
    fn validated_page_tree_rejects_cycles_count_mismatches_and_duplicate_leaves() {
        // 1. Cycle: root -> branch -> root
        let mut cyclic = build_grouped_page_tree_document(2, 2);
        let root_id = cyclic
            .catalog()
            .unwrap()
            .get(b"Pages")
            .unwrap()
            .as_reference()
            .unwrap();
        let branch_id = cyclic
            .get_dictionary(root_id)
            .unwrap()
            .get(b"Kids")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .as_reference()
            .unwrap();
        cyclic
            .get_dictionary_mut(branch_id)
            .unwrap()
            .set("Kids", vec![Object::Reference(root_id)]);
        let err = PageTreeResolver::validated(&cyclic)
            .unwrap_err()
            .to_string();
        assert!(err.contains("cycle"), "expected cycle error, got: {err}");

        // 2. Intermediate count mismatch (even with cancelling siblings so root /Count matches!)
        let mut mismatched = build_grouped_page_tree_document(4, 2);
        let root_id = mismatched
            .catalog()
            .unwrap()
            .get(b"Pages")
            .unwrap()
            .as_reference()
            .unwrap();
        let kids = mismatched
            .get_dictionary(root_id)
            .unwrap()
            .get(b"Kids")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        let branch_a = kids[0].as_reference().unwrap();
        let branch_b = kids[1].as_reference().unwrap();
        mismatched
            .get_dictionary_mut(branch_a)
            .unwrap()
            .set("Count", 1);
        mismatched
            .get_dictionary_mut(branch_b)
            .unwrap()
            .set("Count", 3);
        let err = PageTreeResolver::validated(&mismatched)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("declared 1 pages but contains 2"),
            "expected subtree count mismatch error, got: {err}"
        );

        // 3. Duplicate leaf referenced from two branches
        let mut dup = build_grouped_page_tree_document(4, 2);
        let root_id = dup
            .catalog()
            .unwrap()
            .get(b"Pages")
            .unwrap()
            .as_reference()
            .unwrap();
        let kids = dup
            .get_dictionary(root_id)
            .unwrap()
            .get(b"Kids")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        let branch_a = kids[0].as_reference().unwrap();
        let branch_b = kids[1].as_reference().unwrap();
        let shared_leaf = dup
            .get_dictionary(branch_a)
            .unwrap()
            .get(b"Kids")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .clone();
        let mut b_kids = dup
            .get_dictionary(branch_b)
            .unwrap()
            .get(b"Kids")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        b_kids[0] = shared_leaf;
        dup.get_dictionary_mut(branch_b)
            .unwrap()
            .set("Kids", b_kids);
        let err = PageTreeResolver::validated(&dup).unwrap_err().to_string();
        assert!(
            err.contains("shares a node"),
            "expected duplicate leaf rejection, got: {err}"
        );

        // 4. Flat-count ambiguity: /Kids [A, empty /Pages, B, /Pages(C,D)] has kids.len() == Count == 4,
        // where direct indexing at ordinal 3 would return B instead of C.
        let mut ambiguous = Document::with_version("1.5");
        let root_id = ambiguous.new_object_id();
        let page_a = ambiguous.new_object_id();
        let empty_branch = ambiguous.new_object_id();
        let page_b = ambiguous.new_object_id();
        let pair_branch = ambiguous.new_object_id();
        let page_c = ambiguous.new_object_id();
        let page_d = ambiguous.new_object_id();
        for (pid, parent) in [
            (page_a, root_id),
            (page_b, root_id),
            (page_c, pair_branch),
            (page_d, pair_branch),
        ] {
            ambiguous.objects.insert(
                pid,
                Object::Dictionary(dictionary! {
                    "Type" => "Page",
                    "Parent" => parent,
                    "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
                }),
            );
        }
        ambiguous.objects.insert(
            empty_branch,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Parent" => root_id,
                "Kids" => Vec::<Object>::new(),
                "Count" => 0,
            }),
        );
        ambiguous.objects.insert(
            pair_branch,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Parent" => root_id,
                "Kids" => vec![Object::Reference(page_c), Object::Reference(page_d)],
                "Count" => 2,
            }),
        );
        ambiguous.objects.insert(
            root_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![
                    Object::Reference(page_a),
                    Object::Reference(empty_branch),
                    Object::Reference(page_b),
                    Object::Reference(pair_branch),
                ],
                "Count" => 4,
            }),
        );
        let catalog_id = ambiguous.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => root_id,
        });
        ambiguous.trailer.set("Root", catalog_id);
        let err = PageTreeResolver::validated(&ambiguous)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("its counts place another page"),
            "expected flat-count ambiguity rejection, got: {err}"
        );

        // Sparse unvalidated lookup must be independent of prior query order
        // (warming the prefix cache via page 2 or page 4 must not change what
        // page 3 or page 2 resolves to).
        let fresh = PageTreeResolver::new(&ambiguous).unwrap();
        let page3_alone = fresh.page_id(&ambiguous, 3).unwrap();
        let warmed = PageTreeResolver::new(&ambiguous).unwrap();
        let page2_first = warmed.page_id(&ambiguous, 2).unwrap();
        let page3_after_2 = warmed.page_id(&ambiguous, 3).unwrap();
        let page4_after_2 = warmed.page_id(&ambiguous, 4).unwrap();
        let reverse = PageTreeResolver::new(&ambiguous).unwrap();
        let page4_first = reverse.page_id(&ambiguous, 4).unwrap();
        let page2_after_4 = reverse.page_id(&ambiguous, 2).unwrap();
        assert_eq!(page3_after_2, page3_alone);
        assert_eq!(page2_after_4, page2_first);
        assert_eq!(page4_first, page4_after_2);
    }
}
