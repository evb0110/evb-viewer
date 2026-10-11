use super::*;
use evb_native_support::output::AtomicOutput;
use lopdf::dictionary;
use std::path::Path;

pub(crate) fn read_split_pages_file(path: &Path) -> Result<SplitPagesFile> {
    let instructions: SplitPagesFile = read_json_sidecar(path, "split-pages instructions")?;
    if instructions.pages.is_empty() {
        return Err("split-pages requires at least one source-page instruction".into());
    }
    if let Some(stamp) = instructions.provenance_stamp_hex.as_deref() {
        validate_provenance_stamp_hex(stamp)?;
    }
    let output_count = instructions
        .pages
        .iter()
        .try_fold(0usize, |total, page| total.checked_add(page.outputs.len()));
    if output_count.is_none_or(|count| count > MAX_COLLECTION_ITEMS) {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            format!("split-pages outputs exceed the {MAX_COLLECTION_ITEMS}-item admission ceiling"),
        ));
    }
    Ok(instructions)
}

fn validate_provenance_stamp_hex(stamp: &str) -> Result<()> {
    if stamp.is_empty()
        || !stamp.len().is_multiple_of(2)
        || stamp
            .bytes()
            .any(|byte| !matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("provenanceStampHex must be a non-empty lowercase hexadecimal string".into());
    }
    Ok(())
}

pub(crate) fn validate_crop_rect(rect: SplitCropRect) -> Result<PdfRect> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        return Err("split-pages cropRect must contain finite positive dimensions".into());
    }
    Ok(PdfRect {
        x1: rect.x,
        y1: rect.y,
        x2: rect.x + rect.width,
        y2: rect.y + rect.height,
    })
}

pub(crate) fn materialized_page_dictionary(
    document: &Document,
    page_id: ObjectId,
) -> Result<Dictionary> {
    let mut page = document.get_dictionary(page_id)?.clone();
    for (key, required) in [
        (b"MediaBox".as_slice(), true),
        (b"CropBox".as_slice(), false),
        (b"Resources".as_slice(), false),
        (b"Rotate".as_slice(), false),
    ] {
        if page.get(key).is_ok() {
            continue;
        }
        let mut current_id = Some(page_id);
        let mut inherited = None;
        let mut seen = HashSet::new();
        while let Some(object_id) = current_id {
            if !seen.insert(object_id) {
                return Err("Page tree cycle while materializing split page".into());
            }
            let dictionary = document.get_dictionary(object_id)?;
            if let Ok(value) = dictionary.get(key) {
                inherited = Some(value.clone());
                break;
            }
            current_id = dictionary
                .get(b"Parent")
                .and_then(Object::as_reference)
                .ok();
        }
        if let Some(value) = inherited {
            page.set(key.to_vec(), value);
        } else if required {
            return Err(format!("Missing inherited {}", String::from_utf8_lossy(key)).into());
        }
    }
    page.remove(b"Parent");
    page.set("Type", "Page");
    Ok(page)
}

pub(crate) fn validate_content_transform(
    transform: SplitContentTransform,
) -> Result<SplitContentTransform> {
    if !transform.scale.is_finite()
        || transform.scale <= 0.0
        || !transform.translate_x.is_finite()
        || !transform.translate_y.is_finite()
    {
        return Err(
            "split-pages contentTransform must be a finite positive scale with finite translation"
                .into(),
        );
    }
    Ok(transform)
}

/// A legal `/Contents` is a stream or an array of streams, and either of those
/// — and every entry of the array — may be reached through an indirect
/// reference. Four levels is past every shape PDF defines and stops a document
/// whose arrays point at each other from recursing without end; lopdf's own
/// dereference limit stops a chain of references before that.
const MAX_CONTENTS_NESTING: usize = 4;

/// The annotation entries that are page coordinates: every one of them is a
/// flat list of (x, y) pairs in the same user space as the content.
///
/// `Rect`, appearance placement, and point arrays share the same transform.
/// Moving only the rectangle leaves a rotated appearance or an ink stroke
/// in its old orientation.
/// Whether an array of this length is the shape PDF defines for its key.
type AnnotationArrayShape = fn(usize) -> bool;

const ANNOTATION_POINT_KEYS: [(&[u8], AnnotationArrayShape); 4] = [
    (b"QuadPoints", |len| len % 8 == 0),
    // Line endpoints, and the leader line of a callout: four numbers, or six
    // when the callout bends once.
    (b"L", |len| len == 4),
    (b"CL", |len| len == 4 || len == 6),
    (b"Vertices", |len| len % 2 == 0),
];

/// One coordinate array, scaled and translated as (x, y) pairs. An array whose
/// shape is not the one PDF defines for its key — an odd length, a non-numeric
/// entry — is refused rather than half-transformed: the annotation is left
/// exactly as it was instead of being corrupted into a shape no reader accepts.
fn transformed_point_array(
    document: &impl PdfObjectSource,
    values: &[Object],
    matrix: [f64; 6],
    shape_is_valid: impl Fn(usize) -> bool,
) -> Option<Vec<Object>> {
    if values.is_empty() || values.len() % 2 != 0 || !shape_is_valid(values.len()) {
        return None;
    }
    values
        .chunks_exact(2)
        .flat_map(|pair| {
            let point = (|| {
                let x = f64::from(document.resolved(&pair[0]).ok()?.as_float().ok()?);
                let y = f64::from(document.resolved(&pair[1]).ok()?.as_float().ok()?);
                let tx = matrix[0] * x + matrix[2] * y + matrix[4];
                let ty = matrix[1] * x + matrix[3] * y + matrix[5];
                (tx.is_finite() && ty.is_finite()).then_some([number_object(tx), number_object(ty)])
            })();
            match point {
                Some(point) => point.map(Some),
                None => [None, None],
            }
        })
        .collect()
}

/// `InkList` is a list of strokes, each its own flat list of points, so it is
/// transformed one stroke at a time. A stroke this tool cannot read leaves the
/// whole list alone: a half-moved drawing is worse than one that did not move.
fn transformed_ink_list(
    document: &impl PdfObjectSource,
    strokes: &[Object],
    matrix: [f64; 6],
) -> Option<Vec<Object>> {
    if strokes.is_empty() {
        return None;
    }
    strokes
        .iter()
        .map(|stroke| {
            let stroke = document.resolved(stroke).ok()?;
            let points =
                transformed_point_array(document, stroke.as_array().ok()?, matrix, |_| true)?;
            Some(Object::Array(points))
        })
        .collect()
}

/// One coordinate entry of an annotation, read through however many references
/// the writer put between the annotation and its numbers. qpdf and the app both
/// write indirect arrays, and reading only the direct form leaves those
/// coordinates where the untransformed content used to be.
fn annotation_array(
    document: &impl PdfObjectSource,
    annotation: &Dictionary,
    key: &[u8],
) -> Option<Vec<Object>> {
    let resolved = document.resolved(annotation.get(key).ok()?).ok()?;
    resolved.as_array().ok().cloned()
}

/// Share the page-ops coordinate writer with raster cleanup's affine overlay.
/// Rectangles are bounds of all four transformed corners; markup retains its
/// point order, including rotations and shear.
pub(crate) fn transform_annotation_geometry(
    document: &mut Document,
    annotation: &mut Dictionary,
    matrix: [f64; 6],
    base: Option<&Document>,
    page_rotation: i64,
) -> Result<()> {
    let source = AppendedRevision::from_documents(base.unwrap_or(document), document);
    let old_rect = annotation_array(&source, annotation, b"Rect")
        .and_then(|rect| parse_rect(&Object::Array(rect)).ok());
    if let Some(rect) = old_rect {
        crate::text_box_font::transform_editor_geometry(
            &source,
            annotation,
            rect,
            matrix,
            page_rotation,
        )?;
        annotation.set(
            "Rect",
            rect_object(PdfMatrix::from_values(matrix).bounds(rect)),
        );
    }
    for (key, shape_is_valid) in ANNOTATION_POINT_KEYS {
        if let Some(values) = annotation_array(&source, annotation, key) {
            if let Some(points) = transformed_point_array(&source, &values, matrix, shape_is_valid)
            {
                annotation.set(key.to_vec(), Object::Array(points));
            }
        }
    }
    if let Some(strokes) = annotation_array(&source, annotation, b"InkList") {
        if let Some(ink) = transformed_ink_list(&source, &strokes, matrix) {
            annotation.set("InkList", ink);
        }
    }
    if let (Some(rect), Ok(appearance)) = (old_rect, annotation.get(b"AP")) {
        let appearance = appearance.clone();
        annotation.set(
            "AP",
            transform_appearance(
                document,
                base,
                &appearance,
                rect,
                PdfMatrix::from_values(matrix),
                0,
            )?,
        );
    }
    Ok(())
}

/// The page's annotation list, whether the page holds the array itself or
/// points at one. qpdf writes the indirect form, and reading only the direct
/// one leaves every coordinate array on such a page unscaled — the annotations
/// stay where the untransformed content used to be.
pub(crate) fn page_annotation_array(document: &Document, page: &Dictionary) -> Option<Vec<Object>> {
    let annotations = page.get(b"Annots").ok()?;
    // lopdf's dereference is bounded, so a reference that points at itself
    // answers an error rather than looping; a page whose list cannot be read is
    // left exactly as it is.
    let (_, resolved) = document.dereference(annotations).ok()?;
    resolved.as_array().ok().cloned()
}

/// Collect the existing page content references without copying their stream
/// bodies into the incremental revision. qpdf's structural reader represents
/// those bodies as unavailable streams, but the original PDF already contains
/// them and the appended page can keep referring to their object numbers.
pub(crate) fn content_stream_ids_from_base(
    base: &Document,
    target: &mut Document,
    page: &Dictionary,
) -> Result<Vec<ObjectId>> {
    let contents = match page.get(b"Contents") {
        Ok(value) => value.clone(),
        Err(_) => return Ok(Vec::new()),
    };
    let mut ids = Vec::new();
    collect_content_streams_from_base(base, target, contents, &mut ids, 0)?;
    Ok(ids)
}

fn collect_content_streams_from_base(
    base: &Document,
    target: &mut Document,
    object: Object,
    ids: &mut Vec<ObjectId>,
    depth: usize,
) -> Result<()> {
    if depth > MAX_CONTENTS_NESTING {
        return Err("split-pages found a Contents entry nested past any legal shape".into());
    }
    let object_id = match object {
        Object::Stream(stream) => {
            ids.push(target.add_object(Object::Stream(stream)));
            return Ok(());
        }
        Object::Array(items) => {
            for item in items {
                collect_content_streams_from_base(base, target, item, ids, depth + 1)?;
            }
            return Ok(());
        }
        Object::Reference(object_id) => object_id,
        _ => return Err("split-pages found an unsupported Contents entry".into()),
    };
    match base.dereference(&Object::Reference(object_id)) {
        Ok((resolved_id, Object::Stream(_))) => {
            ids.push(resolved_id.unwrap_or(object_id));
        }
        Ok((_, Object::Array(items))) => {
            for item in items.clone() {
                collect_content_streams_from_base(base, target, item, ids, depth + 1)?;
            }
        }
        // Preserve an unresolved stream reference just as the eager path does.
        Err(_) => ids.push(object_id),
        Ok(_) => return Err("split-pages found an unsupported Contents entry".into()),
    }
    Ok(())
}

pub(crate) fn split_pages(
    mut source: Document,
    instructions: &SplitPagesFile,
    output_path: &Path,
) -> Result<()> {
    let mut document = Document::with_version(source.version.clone());
    document.max_id = source.max_id;
    let catalog_id = source.trailer.get(b"Root")?.as_reference()?;
    document.trailer = split_trailer(&source, catalog_id, instructions.catalog);
    crate::split_output::build_split_output(&source, &mut document, instructions)?;
    for (id, object) in std::mem::take(&mut source.objects) {
        document.objects.entry(id).or_insert(object);
    }
    document.prune_objects();
    let mut output = AtomicOutput::create(output_path)?;
    document.save_to(output.file_mut()?)?;
    output.publish_if_unchanged()?;
    Ok(())
}

/// Split a path-backed PDF by appending a new page tree. Existing page and
/// stream objects stay in the source revision, so a large image stream never
/// crosses the native heap merely because the page boxes changed.
pub(crate) fn write_split_pages_path(
    input_path: &Path,
    output_path: &Path,
    instructions: &SplitPagesFile,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    // Keep the established full-rewrite semantics for compatibility-sized
    // documents. In particular, split-pages intentionally prunes source page
    // objects that are no longer reachable from the replacement page tree.
    // Once the encoded input crosses the byte compatibility budget, use the
    // append-only path below. An incremental PDF cannot delete objects from an
    // earlier revision, but it can change the active page tree without reading
    // the large stream bodies into memory.
    let encoded_len = fs::metadata(input_path)
        .map_err(|error| domain_error(NativeErrorCode::Io, error.to_string()))?
        .len();
    if encoded_len <= MAX_ENCODED_PDF_BYTES as u64 {
        let document = load_pdf_path(input_path)
            .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
        assert_plaintext_base(
            &document,
            "Encrypted PDFs are not supported by native page ops",
        )?;
        split_pages(document, instructions, output_path)?;
        return Ok(());
    }

    let mut incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;

    split_pages_incremental(&mut incremental, instructions)?;
    incremental.new_document.version = incremental.get_prev_documents().version.clone();
    let revision_bytes = build_incremental_revision(&mut incremental)?;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);
    with_staged_incremental_output(input_path, output_path, |staged_output_path| {
        write_incremental_revision(
            staged_output_path,
            &incremental,
            &revision_bytes,
            &expected_object_ids,
        )
    })
}

pub(crate) fn split_pages_incremental(
    incremental: &mut IncrementalDocument,
    instructions: &SplitPagesFile,
) -> Result<()> {
    crate::split_output::build_split_output(
        &incremental.previous_document,
        &mut incremental.new_document,
        instructions,
    )
}

#[derive(Clone, Copy)]
pub(crate) struct PdfMatrix {
    pub(crate) a: f64,
    pub(crate) b: f64,
    pub(crate) c: f64,
    pub(crate) d: f64,
    pub(crate) e: f64,
    pub(crate) f: f64,
}

impl PdfMatrix {
    pub(crate) const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    pub(crate) fn from_values(values: [f64; 6]) -> Self {
        Self {
            a: values[0],
            b: values[1],
            c: values[2],
            d: values[3],
            e: values[4],
            f: values[5],
        }
    }

    pub(crate) fn from_operation(operation: &lopdf::content::Operation) -> Option<Self> {
        let values = operation
            .operands
            .iter()
            .map(|operand| object_to_f64(operand).ok())
            .collect::<Option<Vec<_>>>()?;
        let values: [f64; 6] = values.try_into().ok()?;
        Some(Self::from_values(values))
    }

    pub(crate) fn concat(self, rhs: Self) -> Self {
        Self {
            a: self.a * rhs.a + self.c * rhs.b,
            b: self.b * rhs.a + self.d * rhs.b,
            c: self.a * rhs.c + self.c * rhs.d,
            d: self.b * rhs.c + self.d * rhs.d,
            e: self.a * rhs.e + self.c * rhs.f + self.e,
            f: self.b * rhs.e + self.d * rhs.f + self.f,
        }
    }

    pub(crate) fn translation(x: f64, y: f64) -> Self {
        Self {
            e: x,
            f: y,
            ..Self::IDENTITY
        }
    }

    pub(crate) fn transform(self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }

    pub(crate) fn operands(self) -> Vec<Object> {
        [self.a, self.b, self.c, self.d, self.e, self.f]
            .into_iter()
            .map(number_object)
            .collect()
    }

    pub(crate) fn local_horizontal_offset(self, line: Self) -> Option<f64> {
        let determinant = line.a * line.d - line.b * line.c;
        if determinant.abs() <= f64::EPSILON {
            return None;
        }
        let delta_x = self.e - line.e;
        let delta_y = self.f - line.f;
        Some((delta_x * line.d - line.c * delta_y) / determinant)
    }

    pub(crate) fn bounds(self, rect: PdfRect) -> PdfRect {
        let points = [
            (rect.x1, rect.y1),
            (rect.x1, rect.y2),
            (rect.x2, rect.y1),
            (rect.x2, rect.y2),
        ]
        .map(|(x, y)| self.transform(x, y));
        PdfRect {
            x1: points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min),
            y1: points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min),
            x2: points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max),
            y2: points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max),
        }
    }
}

/// Copy appearance containers per annotation so a shared form cannot be moved
/// twice. Stream resources retain their existing identity in the same revision.
fn transform_appearance(
    target: &mut Document,
    base: Option<&Document>,
    object: &Object,
    rect: PdfRect,
    matrix: PdfMatrix,
    depth: usize,
) -> Result<Object> {
    if depth > 3 {
        return Err("Annotation appearance is nested beyond its supported shape".into());
    }
    let source = AppendedRevision::from_documents(base.unwrap_or(target), target);
    let object = source.resolved(object)?.clone();
    match object {
        Object::Stream(mut stream) => {
            let bbox = parse_rect(source.resolved(stream.dict.get(b"BBox")?)?)?;
            let appearance_matrix = match stream.dict.get(b"Matrix") {
                Ok(value) => PdfMatrix::from_values(
                    source
                        .resolved(value)?
                        .as_array()?
                        .iter()
                        .map(object_to_f64)
                        .collect::<Result<Vec<_>>>()?
                        .try_into()
                        .map_err(|_| "Appearance Matrix must contain six numbers")?,
                ),
                Err(_) => PdfMatrix::IDENTITY,
            };
            let bounds = appearance_matrix.bounds(bbox);
            if bounds.width() <= 0.0 || bounds.height() <= 0.0 {
                return Err("Invalid annotation appearance bounds".into());
            }
            let sx = rect.width() / bounds.width();
            let sy = rect.height() / bounds.height();
            let placement = PdfMatrix::from_values([
                sx,
                0.0,
                0.0,
                sy,
                rect.x1 - sx * bounds.x1,
                rect.y1 - sy * bounds.y1,
            ]);
            let composed = matrix.concat(placement);
            if ![
                composed.a, composed.b, composed.c, composed.d, composed.e, composed.f,
            ]
            .iter()
            .all(|value| value.is_finite())
            {
                return Err("Invalid transformed annotation appearance".into());
            }
            // A transformed form's bounding box need not fill the transformed
            // annotation rectangle (for example a rotated form under shear).
            // Clip in the new rectangle, so PDF's appearance-to-Rect fitting
            // does not apply another scale to the transformed source form.
            // A blank appearance draws nothing; keep its wrapper blank too.
            let blank = stream.content.is_empty() && !is_unread_base_stream(&source, &stream);
            stream.start_position = None;
            let source_form = target.add_object(stream);
            let content = format!(
                "q {} {} {} {} {} {} cm /EVBSourceAppearance Do Q",
                number_to_content(composed.a),
                number_to_content(composed.b),
                number_to_content(composed.c),
                number_to_content(composed.d),
                number_to_content(composed.e),
                number_to_content(composed.f)
            );
            Ok(Object::Reference(target.add_object(Stream::new(dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_object(matrix.bounds(rect)),
                "Resources" => dictionary! {"XObject" => dictionary! {"EVBSourceAppearance" => source_form}},
            }, if blank { Vec::new() } else { content.into_bytes() }))))
        }
        Object::Dictionary(mut dict) => {
            for (key, value) in dict.clone().iter() {
                dict.set(
                    key.clone(),
                    transform_appearance(target, base, value, rect, matrix, depth + 1)?,
                );
            }
            Ok(Object::Dictionary(dict))
        }
        _ => Err("Unsupported annotation appearance shape".into()),
    }
}
