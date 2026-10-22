//! Recompresses the JPEG images that pages draw, leaving everything else as it
//! is. Each image is sized from the largest place a page or a Form XObject on
//! it draws it: an image stored above the target resolution there is shrunk to
//! it, and every candidate is encoded again at the target quality. An image
//! keeps its stream unless the new encoding saves enough bytes, and its object
//! number never changes, so whatever refers to it still does.
//!
//! Only images whose size is known from page content are touched. An image
//! that an annotation appearance, a pattern or a Type 3 glyph also draws
//! keeps its bytes, and so does one drawn by content that cannot be read.

use super::*;
use crate::split_pages::PdfMatrix;
use lopdf::content::Content;
use serde::Serialize;
use std::collections::BTreeSet;

const MAX_CONTENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMAGE_STREAM_BYTES: usize = 256 * 1024 * 1024;
const MAX_FORM_DEPTH: usize = 32;
/// An image is shrunk only when it holds this much more resolution than the
/// target, so a near miss is not resampled for little gain.
const DOWNSAMPLE_ABOVE_TARGET: f64 = 1.2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecompressImagesFile {
    /// Resolution an image needs at the largest size it is drawn.
    pub(crate) target_dpi: f64,
    pub(crate) quality: u8,
    /// A new encoding is kept only when its bytes are at most this fraction
    /// of the image's current bytes.
    pub(crate) max_byte_ratio: f64,
    /// One-based pages whose content is not read: their images are sized by
    /// the other pages only, and are left alone when no other page draws them.
    #[serde(default, deserialize_with = "deserialize_collection")]
    pub(crate) skip_pages: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ImageOutcome {
    Recompressed,
    NotSmaller,
    Unsupported,
}

pub(crate) fn read_recompress_images_file(path: &Path) -> Result<RecompressImagesFile> {
    let instructions: RecompressImagesFile =
        read_json_sidecar(path, "recompress-images instructions")?;
    if !(instructions.max_byte_ratio > 0.0 && instructions.max_byte_ratio <= 1.0) {
        return Err("recompress-images maxByteRatio must be in (0, 1]".into());
    }
    if !(instructions.target_dpi.is_finite() && instructions.target_dpi >= 36.0) {
        return Err("recompress-images targetDpi must be at least 36".into());
    }
    if !(1..=100).contains(&instructions.quality) {
        return Err("recompress-images quality must be in 1..=100".into());
    }
    Ok(instructions)
}

/// What the walk learns about one image.
#[derive(Default)]
struct ImageUse {
    /// Largest fraction of the stored pixels any placement needs, per axis
    /// taken at the target resolution.
    needed_scale: f64,
    pages: BTreeSet<u32>,
}

struct ImageWalk<'a> {
    incremental: &'a IncrementalDocument,
    structural: Option<StructuralSource<'a>>,
    target_dpi: f64,
    uses: HashMap<ObjectId, ImageUse>,
    /// Images drawn somewhere this walk could not follow; they keep their bytes.
    pinned: HashSet<ObjectId>,
}

impl ImageWalk<'_> {
    fn document(&self) -> &Document {
        &self.incremental.previous_document
    }

    fn decoded_stream(&self, id: ObjectId) -> Option<Vec<u8>> {
        self.incremental
            .read_base_stream_bounded(self.structural, id, MAX_CONTENT_BYTES)
            .ok()
            .flatten()
    }

    fn resolved_dict(&self, object: &Object) -> Option<Dictionary> {
        let (_, object) = self.document().dereference(object).ok()?;
        match object {
            Object::Dictionary(dict) => Some(dict.clone()),
            Object::Stream(stream) => Some(stream.dict.clone()),
            _ => None,
        }
    }

    /// The /XObject resources of a form, tiling pattern or Type 3 font
    /// dictionary; `None` when it has no /Resources of its own.
    fn own_xobjects(&self, holder: &Dictionary) -> Option<Option<Dictionary>> {
        let resources = self.resolved_dict(holder.get(b"Resources").ok()?);
        Some(resources.and_then(|resources| self.resolved_dict(resources.get(b"XObject").ok()?)))
    }

    /// Keeps the bytes of `ids` and of every image they draw through their
    /// resources: what draws them was not measured, so they may be shown at
    /// any size.
    fn pin_objects(&mut self, mut pending: Vec<ObjectId>) {
        let mut seen = HashSet::new();
        while let Some(id) = pending.pop() {
            if !seen.insert(id) {
                continue;
            }
            self.pinned.insert(id);
            let nested = self
                .document()
                .get_object(id)
                .ok()
                .and_then(|object| self.resolved_dict(object))
                .and_then(|holder| self.own_xobjects(&holder))
                .flatten();
            pending.extend(nested.iter().flat_map(references));
        }
    }

    fn pin_all(&mut self, xobjects: Option<&Dictionary>) {
        self.pin_objects(xobjects.into_iter().flat_map(references).collect());
    }

    /// Pins what the patterns and Type 3 fonts of `resources` draw.
    fn pin_patterns_and_fonts(&mut self, resources: Option<&Dictionary>) {
        let mut ids = Vec::new();
        for key in [b"Pattern".as_slice(), b"Font"] {
            let entries = resources
                .and_then(|resources| resources.get(key).ok())
                .and_then(|entries| self.resolved_dict(entries));
            for (_, entry) in entries.iter().flat_map(Dictionary::iter) {
                match entry {
                    Object::Reference(id) => ids.push(*id),
                    Object::Dictionary(holder) => {
                        let nested = self.own_xobjects(holder).flatten();
                        ids.extend(nested.iter().flat_map(references));
                    }
                    _ => {}
                }
            }
        }
        self.pin_objects(ids);
    }

    /// Pins what the page's annotation appearances draw, in every state.
    fn pin_annotation_appearances(&mut self, page_id: ObjectId) {
        let document = self.document();
        let annotations = document
            .get_dictionary(page_id)
            .and_then(|page| page.get(b"Annots"))
            .and_then(|annotations| document.dereference(annotations))
            .and_then(|(_, annotations)| annotations.as_array())
            .cloned()
            .unwrap_or_default();
        let mut ids = Vec::new();
        for annotation in &annotations {
            let appearances = self
                .resolved_dict(annotation)
                .and_then(|annotation| self.resolved_dict(annotation.get(b"AP").ok()?));
            for (_, appearance) in appearances.iter().flat_map(Dictionary::iter) {
                match appearance {
                    Object::Reference(id) => match document.get_object(*id) {
                        Ok(Object::Dictionary(states)) => ids.extend(references(states)),
                        _ => ids.push(*id),
                    },
                    Object::Dictionary(states) => ids.extend(references(states)),
                    _ => {}
                }
            }
        }
        self.pin_objects(ids);
    }

    fn walk_page(&mut self, page_number: u32, page_id: ObjectId) -> Result<()> {
        let resources = page_resources(self.document(), page_id).ok();
        self.pin_patterns_and_fonts(resources.as_ref());
        self.pin_annotation_appearances(page_id);
        let xobjects = page_xobjects(self.document(), page_id)?;
        let mut bytes = Vec::new();
        for id in self.document().get_page_contents(page_id) {
            let Some(content) = self.decoded_stream(id) else {
                self.pin_all(xobjects.as_ref());
                return Ok(());
            };
            bytes.extend_from_slice(&content);
            bytes.push(b'\n');
        }
        let mut forms = Vec::new();
        self.walk_content(
            page_number,
            &bytes,
            xobjects.as_ref(),
            PdfMatrix::IDENTITY,
            &mut forms,
        );
        Ok(())
    }

    fn walk_content(
        &mut self,
        page_number: u32,
        bytes: &[u8],
        xobjects: Option<&Dictionary>,
        start: PdfMatrix,
        forms: &mut Vec<ObjectId>,
    ) {
        let Ok(content) = Content::decode(bytes) else {
            self.pin_all(xobjects);
            return;
        };
        let mut placement = start;
        let mut saved = Vec::new();
        for operation in &content.operations {
            match operation.operator.as_str() {
                "q" => saved.push(placement),
                "Q" => placement = saved.pop().unwrap_or(start),
                "cm" => match PdfMatrix::from_operation(operation) {
                    Some(matrix) => placement = placement.concat(matrix),
                    None => return self.pin_all(xobjects),
                },
                "Do" => {
                    let id = operation
                        .operands
                        .first()
                        .and_then(|name| name.as_name().ok())
                        .and_then(|name| xobjects?.get(name).ok())
                        .and_then(|entry| entry.as_reference().ok());
                    if let Some(id) = id {
                        self.draw(page_number, id, placement, xobjects, forms);
                    }
                }
                _ => {}
            }
        }
    }

    fn draw(
        &mut self,
        page_number: u32,
        id: ObjectId,
        placement: PdfMatrix,
        parent_xobjects: Option<&Dictionary>,
        forms: &mut Vec<ObjectId>,
    ) {
        let Ok(stream) = self.document().get_object(id).and_then(Object::as_stream) else {
            return;
        };
        let subtype = stream.dict.get(b"Subtype").and_then(Object::as_name).ok();
        if subtype == Some(b"Image") {
            let size = |key: &[u8]| {
                stream
                    .dict
                    .get(key)
                    .and_then(Object::as_i64)
                    .ok()
                    .filter(|value| *value > 0)
            };
            let (Some(width), Some(height)) = (size(b"Width"), size(b"Height")) else {
                self.pinned.insert(id);
                return;
            };
            // The unit square maps to the two sides of the drawn image.
            let drawn_width = placement.a.hypot(placement.b) / 72.0 * self.target_dpi;
            let drawn_height = placement.c.hypot(placement.d) / 72.0 * self.target_dpi;
            let needed = (drawn_width / width as f64).max(drawn_height / height as f64);
            if !needed.is_finite() {
                self.pinned.insert(id);
                return;
            }
            let usage = self.uses.entry(id).or_default();
            usage.needed_scale = usage.needed_scale.max(needed);
            usage.pages.insert(page_number);
            return;
        }
        if subtype != Some(b"Form") || forms.contains(&id) {
            return;
        }
        let resources = stream
            .dict
            .get(b"Resources")
            .ok()
            .and_then(|resources| self.resolved_dict(resources));
        // A form without its own resources uses those of what draws it.
        let xobjects = self
            .own_xobjects(&stream.dict)
            .unwrap_or_else(|| parent_xobjects.cloned());
        let matrix = stream
            .dict
            .get(b"Matrix")
            .ok()
            .and_then(|matrix| self.document().dereference(matrix).ok())
            .and_then(|(_, matrix)| matrix.as_array().ok())
            .map(|values| {
                let values = values
                    .iter()
                    .map(|value| object_to_f64(value).ok())
                    .collect::<Option<Vec<_>>>()?;
                Some(PdfMatrix::from_values(values.try_into().ok()?))
            })
            .unwrap_or(Some(PdfMatrix::IDENTITY))
            .filter(|_| forms.len() < MAX_FORM_DEPTH);
        self.pin_patterns_and_fonts(resources.as_ref());
        let (Some(matrix), Some(content)) = (matrix, self.decoded_stream(id)) else {
            self.pin_all(xobjects.as_ref());
            return;
        };
        forms.push(id);
        self.walk_content(
            page_number,
            &content,
            xobjects.as_ref(),
            placement.concat(matrix),
            forms,
        );
        forms.pop();
    }
}

/// The objects a dictionary names by reference.
fn references(dict: &Dictionary) -> impl Iterator<Item = ObjectId> + '_ {
    dict.iter()
        .filter_map(|(_, entry)| entry.as_reference().ok())
}

/// A JPEG this pass can rewrite without changing how it is decoded.
struct JpegCandidate {
    bytes: Vec<u8>,
    /// Its color space reads one component.
    gray_space: bool,
}

/// The image's stored bytes when it is a JPEG this pass can rewrite without
/// changing how it is decoded: 8-bit gray or RGB, no decode parameters, no
/// decode array, and no mask whose samples must line up with its own.
fn jpeg_candidate(
    incremental: &IncrementalDocument,
    structural: Option<StructuralSource<'_>>,
    id: ObjectId,
) -> Result<Option<JpegCandidate>> {
    let document = &incremental.previous_document;
    let stream = document.get_object(id)?.as_stream()?;
    let dict = &stream.dict;
    let resolved = |key: &[u8]| {
        dict.get(key)
            .ok()
            .and_then(|value| document.dereference(value).ok())
            .map(|(_, value)| value.clone())
    };
    let filter_is_dct = match resolved(b"Filter") {
        Some(Object::Name(name)) => name == b"DCTDecode",
        Some(Object::Array(filters)) => {
            filters.len() == 1 && filters[0].as_name().ok() == Some(b"DCTDecode")
        }
        _ => false,
    };
    let components = match resolved(b"ColorSpace") {
        Some(Object::Name(name)) if name == b"DeviceRGB" => Some(3),
        Some(Object::Name(name)) if name == b"DeviceGray" => Some(1),
        Some(Object::Array(space))
            if space.first().and_then(|name| name.as_name().ok()) == Some(b"ICCBased") =>
        {
            space
                .get(1)
                .and_then(|profile| document.dereference(profile).ok())
                .and_then(|(_, profile)| profile.as_stream().ok())
                .and_then(|profile| profile.dict.get(b"N").and_then(Object::as_i64).ok())
                .filter(|components| *components == 1 || *components == 3)
        }
        _ => None,
    };
    let matte = resolved(b"SMask")
        .and_then(|mask| match mask {
            Object::Reference(mask_id) => document.get_object(mask_id).ok().cloned(),
            other => Some(other),
        })
        .and_then(|mask| mask.as_stream().ok().map(|mask| mask.dict.has(b"Matte")))
        .unwrap_or(false);
    let supported = filter_is_dct
        && components.is_some()
        && !matte
        && resolved(b"BitsPerComponent").and_then(|bits| bits.as_i64().ok()) == Some(8)
        && !dict.has(b"DecodeParms")
        && !dict.has(b"Decode")
        && !dict.has(b"Mask")
        && !dict.has(b"ImageMask");
    if !supported {
        return Ok(None);
    }
    let bytes = if !incremental.unavailable_base_streams.contains(&id) {
        stream.content.clone()
    } else if let Some(source) = structural {
        // An image the source cannot give back keeps its bytes.
        let Ok(bytes) = read_qpdf_stream_bounded(
            source.input_path,
            source.qpdf_path,
            id,
            MAX_IMAGE_STREAM_BYTES,
        ) else {
            return Ok(None);
        };
        bytes
    } else {
        return Ok(None);
    };
    Ok(Some(JpegCandidate {
        bytes,
        gray_space: components == Some(1),
    }))
}

pub(crate) fn write_recompress_images_path(
    input_path: &Path,
    output_path: &Path,
    instructions: &RecompressImagesFile,
    qpdf_path: Option<&Path>,
) -> Result<()> {
    let mut incremental = load_incremental_pdf_path(input_path, qpdf_path)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    assert_plaintext_base(
        incremental.get_prev_documents(),
        "Encrypted PDFs are not supported by native page ops",
    )?;
    let structural = StructuralSource::for_path(input_path, qpdf_path);
    let resolver = PageTreeResolver::new(&incremental.previous_document)?;
    let skipped: HashSet<u32> = instructions.skip_pages.iter().copied().collect();
    let mut walk = ImageWalk {
        incremental: &incremental,
        structural,
        target_dpi: instructions.target_dpi,
        uses: HashMap::new(),
        pinned: HashSet::new(),
    };
    for page_number in 1..=resolver.page_count() {
        if !skipped.contains(&page_number) {
            let page_id = resolver.page_id(&incremental.previous_document, page_number)?;
            walk.walk_page(page_number, page_id)?;
        }
    }
    let ImageWalk { uses, pinned, .. } = walk;
    let mut uses: Vec<_> = uses
        .into_iter()
        .filter(|(id, _)| !pinned.contains(id))
        .collect();
    uses.sort_by_key(|(id, _)| *id);

    let mut reports = Vec::with_capacity(uses.len());
    let mut pages = BTreeSet::new();
    for (id, usage) in uses {
        let (outcome, source_bytes, new_bytes) =
            recompress_image(&mut incremental, structural, id, &usage, instructions)?;
        if outcome == ImageOutcome::Recompressed {
            pages.extend(usage.pages.iter().copied());
        }
        reports.push(serde_json::json!({
            "objectNumber": id.0, "outcome": outcome,
            "sourceBytes": source_bytes, "recompressedBytes": new_bytes,
        }));
    }

    if !pages.is_empty() {
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
        })?;
    }
    serde_json::to_writer(
        std::io::stdout().lock(),
        &serde_json::json!({
            "format": "evb-pdf-recompress-images",
            "images": reports,
            "pages": pages,
        }),
    )?;
    Ok(())
}

fn recompress_image(
    incremental: &mut IncrementalDocument,
    structural: Option<StructuralSource<'_>>,
    id: ObjectId,
    usage: &ImageUse,
    instructions: &RecompressImagesFile,
) -> Result<(ImageOutcome, u64, u64)> {
    let Some(source) = jpeg_candidate(incremental, structural, id)? else {
        return Ok((ImageOutcome::Unsupported, 0, 0));
    };
    let source_bytes = source.bytes.len() as u64;
    let stream = incremental.previous_document.get_object(id)?.as_stream()?;
    let stored = |key: &[u8]| stream.dict.get(key).and_then(Object::as_i64).unwrap_or(0) as u32;
    let (width, height) = (stored(b"Width"), stored(b"Height"));
    let scale = if usage.needed_scale * DOWNSAMPLE_ABOVE_TARGET < 1.0 {
        usage.needed_scale
    } else {
        1.0
    };
    let target = |size: u32| ((size as f64 * scale).ceil() as u32).clamp(1, size);
    let recompressed = evb_pdf_image_combine::recompress_jpeg(
        &source.bytes,
        target(width),
        target(height),
        instructions.quality,
        evb_pdf_image_combine::DEFAULT_MAX_IMAGE_PIXELS,
    );
    // A gray color space over a color JPEG is read differently by viewers;
    // such an image keeps its bytes.
    let Some(recompressed) = recompressed
        .ok()
        .filter(|jpeg| jpeg.grayscale || !source.gray_space)
    else {
        return Ok((ImageOutcome::Unsupported, source_bytes, 0));
    };
    let new_bytes = recompressed.data.len() as u64;
    if new_bytes as f64 > source_bytes as f64 * instructions.max_byte_ratio {
        return Ok((ImageOutcome::NotSmaller, source_bytes, new_bytes));
    }

    let mut dict = stream.dict.clone();
    dict.set("Width", i64::from(recompressed.width));
    dict.set("Height", i64::from(recompressed.height));
    dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
    // A color space that names three components cannot read one; a neutral
    // image the encoder stored as gray says so plainly.
    if recompressed.grayscale {
        dict.set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
    }
    let mut replacement = Stream::new(dict, recompressed.data);
    replacement.allows_compression = false;
    incremental
        .new_document
        .set_object(id, Object::Stream(replacement));
    Ok((ImageOutcome::Recompressed, source_bytes, new_bytes))
}
