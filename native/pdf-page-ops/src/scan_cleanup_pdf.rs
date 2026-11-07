//! Scan cleanup's browser inspection of a PDF: each page's geometry record,
//! with the rasters it paints as `pdfimages -list` reports them and whether
//! it has annotations. Desktop reads the same facts from its page-size
//! sidecar, pdfimages and the annotation index.

use lopdf::{content::Operation, Dictionary, Document, Object, ObjectId};
use serde::Serialize;
use std::collections::HashMap;

use crate::page_sizes::{
    decode_page_content_with_inline_images, dominant_full_page_image, object_number,
    page_size_entry, resolved_dictionary, Matrix, PageSizeEntry,
};
use crate::{
    domain_error, reclassify_domain_error, resolve_page_rotation, resolve_page_view,
    NativeErrorCode, PageTreeResolver, PdfObjectSource, Result, MAX_DECOMPRESSED_PDF_STREAM_BYTES,
};

/// One image a page paints, as `pdfimages -list` reports it: an image or
/// stencil, or the active soft or explicit mask attached to an image, which
/// carries its parent image's object number (zero for an inline image).
/// Resolution is the image's pixels over the placement it is painted at, as
/// the listing prints it and desktop parses it back.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct RasterUse {
    kind: &'static str,
    width_px: i64,
    height_px: i64,
    bits_per_component: i64,
    object_number: u32,
    x_ppi: i64,
    y_ppi: i64,
}

const MAX_FORM_XOBJECT_DEPTH: usize = 12;

struct RasterInventory {
    uses: Vec<RasterUse>,
    /// False where the page may paint images this walk could not read or
    /// measure, as where pdfimages skips content.
    complete: bool,
}

/// The names a content stream resolves: its XObjects and marked-content properties.
struct ResourceScope<'a> {
    xobjects: HashMap<Vec<u8>, &'a Object>,
    properties: HashMap<Vec<u8>, &'a Object>,
}

fn resource_scope<'a>(
    document: &'a Document,
    resources: impl Iterator<Item = &'a Dictionary>,
) -> ResourceScope<'a> {
    let mut scope = ResourceScope {
        xobjects: HashMap::new(),
        properties: HashMap::new(),
    };
    for resources in resources {
        for (key, names) in [
            (b"XObject".as_slice(), &mut scope.xobjects),
            (b"Properties".as_slice(), &mut scope.properties),
        ] {
            if let Some(dictionary) = resources
                .get(key)
                .ok()
                .and_then(|object| resolved_dictionary(document, object))
            {
                for (name, object) in dictionary {
                    names.insert(name.clone(), object);
                }
            }
        }
    }
    scope
}

/// The document's default optional-content configuration, which decides
/// whether marked content and XObjects in a layer are painted at all.
struct OptionalContent {
    base_off: bool,
    on: Vec<ObjectId>,
    off: Vec<ObjectId>,
}

impl OptionalContent {
    fn read(document: &Document) -> Self {
        let configuration = document
            .catalog()
            .ok()
            .and_then(|catalog| catalog.get(b"OCProperties").ok())
            .and_then(|object| resolved_dictionary(document, object))
            .and_then(|properties| properties.get(b"D").ok())
            .and_then(|object| resolved_dictionary(document, object));
        let references = |key: &[u8]| {
            configuration
                .and_then(|configuration| configuration.get(key).ok())
                .and_then(|object| document.resolved(object).ok())
                .and_then(|object| object.as_array().ok())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_reference().ok())
                        .collect()
                })
                .unwrap_or_default()
        };
        Self {
            base_off: configuration
                .and_then(|configuration| configuration.get(b"BaseState").ok())
                .and_then(|object| object.as_name().ok())
                == Some(b"OFF".as_slice()),
            on: references(b"ON"),
            off: references(b"OFF"),
        }
    }

    fn group_visible(&self, id: ObjectId) -> bool {
        if self.base_off {
            self.on.contains(&id)
        } else {
            !self.off.contains(&id)
        }
    }

    /// Whether an optional-content group or membership dictionary is shown.
    fn visible(&self, document: &Document, object: &Object, complete: &mut bool) -> bool {
        let Some(dictionary) = resolved_dictionary(document, object) else {
            return true;
        };
        match dictionary.get(b"Type").and_then(Object::as_name).ok() {
            Some(b"OCG") => object
                .as_reference()
                .map_or(true, |id| self.group_visible(id)),
            Some(b"OCMD") => {
                if dictionary.has(b"VE") {
                    *complete = false;
                    return true;
                }
                let groups: Vec<ObjectId> = match dictionary.get(b"OCGs").ok().and_then(|object| {
                    document
                        .resolved(object)
                        .ok()
                        .map(|resolved| (object, resolved))
                }) {
                    Some((_, Object::Array(values))) => values
                        .iter()
                        .filter_map(|value| value.as_reference().ok())
                        .collect(),
                    Some((Object::Reference(id), _)) => vec![*id],
                    _ => return true,
                };
                let shown = groups.iter().map(|id| self.group_visible(*id));
                match dictionary.get(b"P").and_then(Object::as_name).ok() {
                    Some(b"AllOn") => shown.into_iter().all(|on| on),
                    Some(b"AnyOff") => shown.into_iter().any(|on| !on),
                    Some(b"AllOff") => shown.into_iter().all(|on| !on),
                    _ => shown.into_iter().any(|on| on),
                }
            }
            _ => true,
        }
    }
}

fn dictionary_value<'a>(
    document: &'a Document,
    dictionary: &'a Dictionary,
    keys: &[&[u8]],
) -> Option<&'a Object> {
    keys.iter()
        .find_map(|key| dictionary.get(key).ok())
        .and_then(|object| document.resolved(object).ok())
}

/// Pixels over painted points, as pdfimages prints it and desktop parses it
/// back: a whole number rounded half to even, and zero below one.
fn image_ppi(pixels: i64, matrix_x: f64, matrix_y: f64) -> i64 {
    let points = matrix_x.hypot(matrix_y);
    if points <= 0.0 || !points.is_finite() {
        return 0;
    }
    let ppi = pixels as f64 * 72.0 / points;
    if ppi >= 1.0 {
        ppi.round_ties_even() as i64
    } else {
        0
    }
}

fn push_raster_use(
    document: &Document,
    inventory: &mut RasterInventory,
    kind: &'static str,
    dictionary: &Dictionary,
    bits_per_component: i64,
    object_number: u32,
    matrix: Matrix,
) {
    let dimension = |keys: &[&[u8]]| {
        dictionary_value(document, dictionary, keys)
            .and_then(|object| object.as_i64().ok())
            .filter(|value| *value > 0)
    };
    let (Some(width_px), Some(height_px)) =
        (dimension(&[b"Width", b"W"]), dimension(&[b"Height", b"H"]))
    else {
        inventory.complete = false;
        return;
    };
    inventory.uses.push(RasterUse {
        kind,
        width_px,
        height_px,
        bits_per_component,
        object_number,
        x_ppi: image_ppi(width_px, matrix.a, matrix.b),
        y_ppi: image_ppi(height_px, matrix.c, matrix.d),
    });
}

fn image_bits(document: &Document, dictionary: &Dictionary, default_bits: i64) -> (bool, i64) {
    let stencil = dictionary_value(document, dictionary, &[b"ImageMask", b"IM"])
        .and_then(|object| object.as_bool().ok())
        .unwrap_or(false);
    let bits = dictionary_value(document, dictionary, &[b"BitsPerComponent", b"BPC"])
        .and_then(|object| object.as_i64().ok())
        .unwrap_or(default_bits);
    (stencil, if stencil { 1 } else { bits })
}

fn record_image_use(
    document: &Document,
    inventory: &mut RasterInventory,
    dictionary: &Dictionary,
    object_number: u32,
    matrix: Matrix,
) {
    let (stencil, bits) = image_bits(document, dictionary, 8);
    push_raster_use(
        document,
        inventory,
        if stencil { "stencil" } else { "image" },
        dictionary,
        bits,
        object_number,
        matrix,
    );
    // A soft mask takes the place of an explicit one; only the active mask is painted.
    let mask = |key: &[u8]| {
        dictionary_value(document, dictionary, &[key]).and_then(|object| object.as_stream().ok())
    };
    let active = mask(b"SMask")
        .map(|stream| ("smask", stream))
        .or_else(|| mask(b"Mask").map(|stream| ("mask", stream)));
    if let Some((kind, stream)) = active {
        let (_, mask_bits) = image_bits(document, &stream.dict, 1);
        push_raster_use(
            document,
            inventory,
            kind,
            &stream.dict,
            mask_bits,
            object_number,
            matrix,
        );
    }
}

/// A PDF number as the double Poppler parses from its text. lopdf keeps
/// reals as `f32`, which turns 418.08 into 418.0799865...; the shortest
/// decimal naming that `f32` is the number its producer wrote, for any number
/// written with up to seven significant digits.
fn written_real(value: f64) -> f64 {
    let single = value as f32;
    if f64::from(single) != value {
        return value;
    }
    single.to_string().parse().unwrap_or(value)
}

fn read_matrix(object: Option<&Object>) -> Option<Matrix> {
    object
        .and_then(|object| object.as_array().ok())
        .and_then(|values| {
            values
                .iter()
                .map(|value| object_number(value).map(written_real))
                .collect::<Option<Vec<_>>>()
        })
        .filter(|values| values.len() == 6)
        .map(|values| Matrix {
            a: values[0],
            b: values[1],
            c: values[2],
            d: values[3],
            e: values[4],
            f: values[5],
        })
}

struct InventoryWalk<'a> {
    document: &'a Document,
    optional_content: OptionalContent,
    form_path: Vec<ObjectId>,
    max_decompressed_bytes: usize,
    inventory: RasterInventory,
}

impl InventoryWalk<'_> {
    fn walk(
        &mut self,
        operations: &[Operation],
        inline_images: &[crate::content_parse::TInlineImageFacts],
        scope: &ResourceScope<'_>,
        base: Matrix,
    ) -> Result<()> {
        let mut inline_images = inline_images.iter();
        let document = self.document;
        let mut matrix = base;
        let mut stack = Vec::new();
        // Each open marked-content sequence, true where its layer is hidden.
        let mut hidden = Vec::<bool>::new();
        for operation in operations {
            let is_hidden = hidden.last().copied().unwrap_or(false);
            match operation.operator.as_str() {
                "q" => stack.push(matrix),
                "Q" => matrix = stack.pop().unwrap_or(base),
                "cm" => {
                    if let Some(values) =
                        read_matrix(Some(&Object::Array(operation.operands.clone())))
                    {
                        matrix = values.concat_onto(matrix);
                    }
                }
                "BMC" => hidden.push(is_hidden),
                "BDC" => {
                    let layer = (operation
                        .operands
                        .first()
                        .and_then(|tag| tag.as_name().ok())
                        == Some(b"OC".as_slice()))
                    .then(|| operation.operands.get(1))
                    .flatten();
                    let shown = match layer {
                        Some(Object::Name(name)) => {
                            scope.properties.get(name).is_none_or(|object| {
                                self.optional_content.visible(
                                    document,
                                    object,
                                    &mut self.inventory.complete,
                                )
                            })
                        }
                        Some(object) => self.optional_content.visible(
                            document,
                            object,
                            &mut self.inventory.complete,
                        ),
                        None => true,
                    };
                    hidden.push(is_hidden || !shown);
                }
                "EMC" => {
                    hidden.pop();
                }
                // The dictionary's declared facts, as pdfimages lists them,
                // whether or not lopdf could decode the image itself.
                "BI" => match inline_images.next() {
                    _ if is_hidden => {}
                    Some(&Some((width, height, bits, stencil))) => {
                        self.inventory.uses.push(RasterUse {
                            kind: if stencil { "stencil" } else { "image" },
                            width_px: i64::from(width),
                            height_px: i64::from(height),
                            bits_per_component: i64::from(bits),
                            object_number: 0,
                            x_ppi: image_ppi(i64::from(width), matrix.a, matrix.b),
                            y_ppi: image_ppi(i64::from(height), matrix.c, matrix.d),
                        })
                    }
                    _ => self.inventory.complete = false,
                },
                _ if is_hidden => {}
                "Do" if operation.operands.len() == 1 => {
                    let Ok(name) = operation.operands[0].as_name() else {
                        continue;
                    };
                    let Some(&object) = scope.xobjects.get(name) else {
                        self.inventory.complete = false;
                        continue;
                    };
                    let object_id = object.as_reference().ok();
                    let Some(stream) = document
                        .resolved(object)
                        .ok()
                        .and_then(|object| object.as_stream().ok())
                    else {
                        self.inventory.complete = false;
                        continue;
                    };
                    if let Ok(layer) = stream.dict.get(b"OC") {
                        if !self.optional_content.visible(
                            document,
                            layer,
                            &mut self.inventory.complete,
                        ) {
                            continue;
                        }
                    }
                    match stream.dict.get(b"Subtype").and_then(Object::as_name).ok() {
                        Some(b"Image") => record_image_use(
                            document,
                            &mut self.inventory,
                            &stream.dict,
                            object_id.map_or(0, |id| id.0),
                            matrix,
                        ),
                        Some(b"Form") => self.walk_form(stream, object_id, matrix, scope)?,
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn walk_form(
        &mut self,
        stream: &lopdf::Stream,
        object_id: Option<ObjectId>,
        outer: Matrix,
        parent_scope: &ResourceScope<'_>,
    ) -> Result<()> {
        // A cycle is a repeat along the current path, not a form painted
        // twice: both uses of a repeated form are real images.
        if object_id.is_some_and(|id| self.form_path.contains(&id))
            || self.form_path.len() >= MAX_FORM_XOBJECT_DEPTH
        {
            self.inventory.complete = false;
            return Ok(());
        }
        let document = self.document;
        let form_matrix = read_matrix(stream.dict.get(b"Matrix").ok()).unwrap_or(Matrix::IDENTITY);
        let own_scope = stream
            .dict
            .get(b"Resources")
            .ok()
            .and_then(|object| resolved_dictionary(document, object))
            .map(|resources| resource_scope(document, std::iter::once(resources)));
        let Ok(bytes) =
            crate::load_policy::plain_stream_with_limit(stream, self.max_decompressed_bytes)
        else {
            self.inventory.complete = false;
            return Ok(());
        };
        let Ok((Ok(content), inline_images)) =
            crate::content_parse::parse_content_with_inline_images(&bytes)
        else {
            self.inventory.complete = false;
            return Ok(());
        };
        self.form_path.extend(object_id);
        let walked = self.walk(
            &content.operations,
            &inline_images,
            own_scope.as_ref().unwrap_or(parent_scope),
            form_matrix.concat_onto(outer),
        );
        if object_id.is_some() {
            self.form_path.pop();
        }
        walked
    }

    /// The images a page's visible annotation appearances paint, placed as
    /// a viewer places them: the appearance box mapped onto the annotation's rectangle.
    fn walk_annotations(
        &mut self,
        page: &Dictionary,
        page_scope: &ResourceScope<'_>,
    ) -> Result<()> {
        const HIDDEN: i64 = 2;
        const NO_VIEW: i64 = 32;
        let document = self.document;
        let Some(annotations) = page
            .get(b"Annots")
            .ok()
            .and_then(|object| document.resolved(object).ok())
            .and_then(|object| object.as_array().ok())
        else {
            return Ok(());
        };
        for annotation in annotations {
            let Some(annotation) = resolved_dictionary(document, annotation) else {
                continue;
            };
            let flags = annotation.get(b"F").and_then(Object::as_i64).unwrap_or(0);
            if flags & (HIDDEN | NO_VIEW) != 0 {
                continue;
            }
            if let Ok(layer) = annotation.get(b"OC") {
                if !self
                    .optional_content
                    .visible(document, layer, &mut self.inventory.complete)
                {
                    continue;
                }
            }
            let Some(normal) = annotation
                .get(b"AP")
                .ok()
                .and_then(|object| resolved_dictionary(document, object))
                .and_then(|appearances| appearances.get(b"N").ok())
            else {
                continue;
            };
            // A normal appearance is a form, or one form per appearance state.
            let appearance = match document.resolved(normal).ok() {
                Some(Object::Stream(_)) => normal,
                Some(Object::Dictionary(states)) => {
                    // Without a state, viewers such as Poppler show the Off appearance.
                    let state = annotation
                        .get(b"AS")
                        .and_then(Object::as_name)
                        .unwrap_or(b"Off");
                    let Ok(appearance) = states.get(state) else {
                        continue;
                    };
                    appearance
                }
                _ => continue,
            };
            let object_id = appearance.as_reference().ok();
            let Some(stream) = document
                .resolved(appearance)
                .ok()
                .and_then(|object| object.as_stream().ok())
            else {
                continue;
            };
            let rect = annotation
                .get(b"Rect")
                .ok()
                .and_then(|object| object.as_array().ok())
                .and_then(|values| values.iter().map(object_number).collect::<Option<Vec<_>>>())
                .filter(|values| values.len() == 4);
            let bbox = stream
                .dict
                .get(b"BBox")
                .ok()
                .and_then(|object| object.as_array().ok())
                .and_then(|values| values.iter().map(object_number).collect::<Option<Vec<_>>>())
                .filter(|values| values.len() == 4);
            let (Some(rect), Some(bbox)) = (rect, bbox) else {
                self.inventory.complete = false;
                continue;
            };
            let form_matrix =
                read_matrix(stream.dict.get(b"Matrix").ok()).unwrap_or(Matrix::IDENTITY);
            let corners = [
                form_matrix.transform(bbox[0], bbox[1]),
                form_matrix.transform(bbox[2], bbox[1]),
                form_matrix.transform(bbox[0], bbox[3]),
                form_matrix.transform(bbox[2], bbox[3]),
            ];
            let (min_x, max_x, min_y, max_y) = corners.iter().fold(
                (
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                ),
                |(min_x, max_x, min_y, max_y), (x, y)| {
                    (min_x.min(*x), max_x.max(*x), min_y.min(*y), max_y.max(*y))
                },
            );
            let (rect_x, rect_y) = (rect[0].min(rect[2]), rect[1].min(rect[3]));
            let (rect_width, rect_height) = ((rect[2] - rect[0]).abs(), (rect[3] - rect[1]).abs());
            if max_x <= min_x || max_y <= min_y {
                continue;
            }
            let scale_x = rect_width / (max_x - min_x);
            let scale_y = rect_height / (max_y - min_y);
            let placement = Matrix {
                a: scale_x,
                b: 0.0,
                c: 0.0,
                d: scale_y,
                e: rect_x - scale_x * min_x,
                f: rect_y - scale_y * min_y,
            };
            self.walk_form(stream, object_id, placement, page_scope)?;
        }
        Ok(())
    }
}

fn page_raster_inventory(
    document: &Document,
    page_id: ObjectId,
    max_decompressed_bytes: usize,
) -> Result<RasterInventory> {
    let (direct_resources, resource_ids) = document
        .get_page_resources(page_id)
        .map_err(|error| reclassify_domain_error(error.into(), NativeErrorCode::CorruptXref))?;
    // Inherited resources are the fallback; nearer page resources override them.
    let inherited = resource_ids
        .into_iter()
        .rev()
        .filter_map(|id| document.get_dictionary(id).ok());
    let scope = resource_scope(document, inherited.chain(direct_resources));
    let mut walk = InventoryWalk {
        document,
        optional_content: OptionalContent::read(document),
        form_path: Vec::new(),
        max_decompressed_bytes,
        inventory: RasterInventory {
            uses: Vec::new(),
            complete: true,
        },
    };
    match decode_page_content_with_inline_images(document, page_id, max_decompressed_bytes) {
        Ok((content, images)) => {
            walk.walk(&content.operations, &images, &scope, Matrix::IDENTITY)?
        }
        Err(_) => walk.inventory.complete = false,
    }
    if let Ok(page) = document.get_dictionary(page_id) {
        walk.walk_annotations(page, &scope)?;
    }
    Ok(walk.inventory)
}

fn page_has_annotations(document: &Document, page_id: ObjectId) -> bool {
    document
        .get_dictionary(page_id)
        .ok()
        .and_then(|page| page.get(b"Annots").ok())
        .and_then(|annotations| document.resolved(annotations).ok())
        .and_then(|annotations| annotations.as_array().ok())
        .is_some_and(|annotations| !annotations.is_empty())
}

/// Scan cleanup's page facts for the browser, which has no sidecar file: the
/// requested pages' records exactly as `write_page_sizes_sidecar_document` writes them,
/// under the document's page count. No requested pages lists every page.
pub(crate) fn inspect_scan_cleanup_pdf_bytes(data: &[u8], page_numbers: &[u32]) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InspectedPage {
        #[serde(flatten)]
        entry: PageSizeEntry,
        raster_uses: Vec<RasterUse>,
        raster_inventory_complete: bool,
        has_annotations: bool,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InspectedPages {
        page_count: u32,
        pages: Vec<InspectedPage>,
    }

    let document = crate::load_browser_pdf(data)?;
    let resolver = PageTreeResolver::new(&document)?;
    let entry = |page_number: u32, page_id: ObjectId| {
        let page_view = resolve_page_view(&document, page_id)?;
        let rotation = resolve_page_rotation(&document, page_id)?;
        let dominant_image = dominant_full_page_image(&document, page_id, page_view)?;
        let inventory =
            page_raster_inventory(&document, page_id, MAX_DECOMPRESSED_PDF_STREAM_BYTES)?;
        Ok::<_, Box<dyn std::error::Error>>(InspectedPage {
            entry: page_size_entry(
                &document,
                page_number,
                page_id,
                rotation,
                page_view,
                dominant_image,
            )?,
            raster_uses: inventory.uses,
            raster_inventory_complete: inventory.complete,
            has_annotations: page_has_annotations(&document, page_id),
        })
    };
    let mut pages = Vec::new();
    if page_numbers.is_empty() {
        resolver.for_each_page_id(&document, |page_id| {
            let page_number =
                u32::try_from(pages.len() + 1).map_err(|_| "Page-size page number overflow")?;
            pages.push(entry(page_number, page_id)?);
            Ok(())
        })?;
    } else {
        for &page_number in page_numbers {
            pages.push(entry(
                page_number,
                resolver.page_id(&document, page_number)?,
            )?);
        }
    }
    Ok(serde_json::to_vec(&InspectedPages {
        page_count: resolver.page_count(),
        pages,
    })?)
}

/// How closely a page's source raster matches desktop's: `Exact` when every
/// image decodes to the samples Poppler decodes, `Near` when a JPEG or JPEG
/// 2000 image went through a decoder not proven sample-identical: native
/// builds' Rust decoders, or a variant the browser's C decoders leave to them.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SampleCompatibility {
    Exact,
    Near,
}

/// A request for one page's scan source raster, as desktop's renderer asks
/// `pdftoppm` for it.
#[derive(serde::Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScanRasterRequest {
    pub(crate) page_number: u32,
    pub(crate) dpi: f64,
    /// Fit the page's longer side to this many pixels instead of `dpi`, as `-scale-to` does.
    #[serde(default)]
    pub(crate) scale_to: Option<u32>,
    pub(crate) render_box: ScanRasterBox,
    #[serde(default)]
    pub(crate) include_annotations: bool,
    #[serde(default)]
    pub(crate) slice: Option<ScanRasterSlice>,
    pub(crate) max_pixels: u64,
}

#[derive(serde::Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ScanRasterBox {
    CropBox,
    MediaBox,
}

#[derive(serde::Deserialize, Debug, Clone, Copy)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScanRasterSlice {
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// The page raster (RGB, top-down rows) or why this page is drawn by the
/// general renderer instead.
#[derive(Debug, PartialEq)]
pub(crate) enum ScanRaster {
    Raster {
        width: usize,
        height: usize,
        rgb: Vec<u8>,
        compatibility: SampleCompatibility,
    },
    Unsupported(&'static str),
}

/// The raster of a scanned page, pixel for pixel as desktop's bundled
/// `pdftoppm` draws it, when its painting program is one the scan kernel
/// reproduces.
pub(crate) fn render_scan_cleanup_raster(
    document: &Document,
    request: ScanRasterRequest,
) -> Result<ScanRaster> {
    use evb_scan_cleanup::io::source_raster::{
        page_grid, rasterize, PageBox, Resolution, Slice, SourceRasterError,
    };

    let resolver = PageTreeResolver::new(document)?;
    let page_id = resolver.page_id(document, request.page_number)?;
    if (crate::resolve_page_user_unit(document, page_id)? - 1.0).abs() > 0.0 {
        return Ok(ScanRaster::Unsupported("page user unit is not one"));
    }
    if request.include_annotations && page_has_annotations(document, page_id) {
        return Ok(ScanRaster::Unsupported("page has annotations to draw"));
    }
    let rect = match request.render_box {
        ScanRasterBox::CropBox => resolve_page_view(document, page_id)?,
        ScanRasterBox::MediaBox => crate::resolve_inherited_box(document, page_id, b"MediaBox")?,
    };
    let rotation = resolve_page_rotation(document, page_id)?.rem_euclid(360);
    let Ok(rotation) = u16::try_from(rotation) else {
        return Ok(ScanRaster::Unsupported("page rotation is out of range"));
    };
    let slice = request.slice.map(|slice| Slice {
        x: slice.x,
        y: slice.y,
        width: slice.width,
        height: slice.height,
    });
    let page = PageBox {
        rect: [rect.x1, rect.y1, rect.x2, rect.y2].map(written_real),
        rotation,
    };
    let resolution = request
        .scale_to
        .map_or(Resolution::Dpi(request.dpi), Resolution::ScaleTo);
    let grid = match page_grid(page, resolution, slice) {
        Ok(grid) => grid,
        Err(SourceRasterError::Unsupported(reason)) => return Ok(ScanRaster::Unsupported(reason)),
        Err(error) => return Err(error.to_string().into()),
    };
    let max_pixels = usize::try_from(request.max_pixels).unwrap_or(usize::MAX);
    let program = match scan_paint_program(document, page_id, &grid, request.max_pixels)? {
        Ok(program) => program,
        Err(reason) => return Ok(ScanRaster::Unsupported(reason)),
    };
    match rasterize(&grid, &program.paints, max_pixels) {
        Ok(rgb) => Ok(ScanRaster::Raster {
            width: grid.width,
            height: grid.height,
            rgb,
            compatibility: program.compatibility,
        }),
        Err(SourceRasterError::Unsupported(reason)) => Ok(ScanRaster::Unsupported(reason)),
        Err(error) => Err(error.to_string().into()),
    }
}

/// The raster operation over request bytes: the page's RGB rows with a
/// report of their size and sample compatibility, or no rows and a report of
/// why the page is drawn by the general renderer.
pub(crate) fn render_scan_cleanup_raster_bytes(
    data: &[u8],
    instructions: &[u8],
) -> Result<crate::ReportedBytes> {
    let request: ScanRasterRequest =
        crate::parse_json_sidecar_bytes(instructions, "scan raster request")?;
    let document = crate::load_browser_pdf(data)?;
    Ok(match render_scan_cleanup_raster(&document, request)? {
        ScanRaster::Raster {
            width,
            height,
            rgb,
            compatibility,
        } => crate::ReportedBytes {
            data: rgb,
            page_count: 1,
            report: serde_json::to_vec(&serde_json::json!({
                "width": width,
                "height": height,
                "compatibility": compatibility,
            }))?,
        },
        ScanRaster::Unsupported(reason) => crate::ReportedBytes {
            data: Vec::new(),
            page_count: 0,
            report: serde_json::to_vec(&serde_json::json!({ "unsupported": reason }))?,
        },
    })
}

struct ScanPaintProgram {
    paints: Vec<evb_scan_cleanup::io::source_raster::Paint>,
    compatibility: SampleCompatibility,
}

/// The graphics state the scan program tracks.
#[derive(Default)]
struct PaintState {
    ctm: Matrix,
    fill: Option<[u8; 3]>,
    text_render_mode: i64,
}

impl Default for Matrix {
    fn default() -> Self {
        Matrix::IDENTITY
    }
}

/// The page's painting program in the kernel's terms, or the first reason it
/// is not one. Unknown paints (vectors, visible text, shadings) are allowed
/// only when a later normal opaque image covers the whole bitmap.
fn scan_paint_program(
    document: &Document,
    page_id: ObjectId,
    grid: &evb_scan_cleanup::io::source_raster::PageGrid,
    max_pixels: u64,
) -> Result<std::result::Result<ScanPaintProgram, &'static str>> {
    use evb_scan_cleanup::io::source_raster::Paint;

    let (direct_resources, resource_ids) = document
        .get_page_resources(page_id)
        .map_err(|error| reclassify_domain_error(error.into(), NativeErrorCode::CorruptXref))?;
    let inherited = resource_ids
        .into_iter()
        .rev()
        .filter_map(|id| document.get_dictionary(id).ok());
    let resources: Vec<&Dictionary> = inherited.chain(direct_resources).collect();
    let scope = resource_scope(document, resources.iter().copied());
    let states = ext_g_states(document, &resources);
    let (content, inline_images) = decode_page_content_with_inline_images(
        document,
        page_id,
        MAX_DECOMPRESSED_PDF_STREAM_BYTES,
    )?;
    if !inline_images.is_empty() {
        return Ok(Err("page paints inline images"));
    }
    let mut paints: Vec<Paint> = Vec::new();
    let mut unknown_paint = false;
    let mut compatibility = SampleCompatibility::Exact;
    let mut state = PaintState::default();
    let mut stack: Vec<PaintState> = Vec::new();
    for operation in &content.operations {
        let operands = &operation.operands;
        match operation.operator.as_str() {
            "q" => stack.push(PaintState { ..state }),
            "Q" => match stack.pop() {
                Some(saved) => state = saved,
                None => return Ok(Err("graphics state restore without save")),
            },
            "cm" => {
                let Some(matrix) = read_matrix(Some(&Object::Array(operands.clone()))) else {
                    return Ok(Err("unreadable transform"));
                };
                state.ctm = matrix.concat_onto(state.ctm);
            }
            "g" => state.fill = gray_fill(operands),
            "rg" => state.fill = rgb_fill(operands),
            // Any other fill color space leaves a stencil's fill unknown.
            "cs" | "sc" | "scn" | "k" => state.fill = None,
            "gs" => {
                let Some(name) = operands.first().and_then(|operand| operand.as_name().ok()) else {
                    return Ok(Err("unreadable graphics state"));
                };
                match states.get(name) {
                    Some(dictionary) if normal_opaque_state(document, dictionary) => {}
                    _ => return Ok(Err("graphics state is not normal opaque painting")),
                }
            }
            "W" | "W*" => return Ok(Err("page clips")),
            "Tr" => {
                state.text_render_mode = operands
                    .first()
                    .and_then(|mode| mode.as_i64().ok())
                    .unwrap_or(-1);
                if (4..=7).contains(&state.text_render_mode) {
                    return Ok(Err("text clips"));
                }
            }
            "Tj" | "TJ" | "'" | "\"" if state.text_render_mode != 3 => unknown_paint = true,
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "sh" => unknown_paint = true,
            "BDC"
                if operands.first().and_then(|tag| tag.as_name().ok())
                    == Some(b"OC".as_slice()) =>
            {
                return Ok(Err("page uses optional content"));
            }
            "BX" | "EX" | "d0" | "d1" => return Ok(Err("page uses an unsupported operator")),
            "Do" => {
                let Some(name) = operands.first().and_then(|operand| operand.as_name().ok()) else {
                    return Ok(Err("unreadable XObject name"));
                };
                let Some(&object) = scope.xobjects.get(name) else {
                    return Ok(Err("XObject is not in the page resources"));
                };
                let Some(stream) = document
                    .resolved(object)
                    .ok()
                    .and_then(|object| object.as_stream().ok())
                else {
                    return Ok(Err("XObject is not a stream"));
                };
                if stream.dict.get(b"Subtype").and_then(Object::as_name).ok()
                    != Some(b"Image".as_slice())
                {
                    return Ok(Err("page draws a form or other XObject"));
                }
                if stream.dict.has(b"OC") {
                    return Ok(Err("page uses optional content"));
                }
                let placement = [
                    state.ctm.a,
                    state.ctm.b,
                    state.ctm.c,
                    state.ctm.d,
                    state.ctm.e,
                    state.ctm.f,
                ];
                let paint = match image_paint(
                    document,
                    stream,
                    placement,
                    state.fill,
                    max_pixels,
                    &mut compatibility,
                )? {
                    Ok(paint) => paint,
                    Err(reason) => return Ok(Err(reason)),
                };
                // A normal opaque image covering the whole bitmap hides everything before it.
                if let Paint::Image {
                    soft_mask: None, ..
                } = paint
                {
                    if covers_bitmap(grid, placement) {
                        paints.clear();
                        unknown_paint = false;
                    }
                }
                paints.push(paint);
            }
            _ => {}
        }
    }
    if unknown_paint {
        return Ok(Err("page paints vectors or visible text over its images"));
    }
    if paints.is_empty() {
        return Ok(Err("page paints no image"));
    }
    Ok(Ok(ScanPaintProgram {
        paints,
        compatibility,
    }))
}

fn gray_fill(operands: &[Object]) -> Option<[u8; 3]> {
    let gray = operands
        .first()
        .and_then(object_number)
        .filter(|value| (0.0..=1.0).contains(value))?;
    let byte = (gray * 255.0).round() as u8;
    Some([byte; 3])
}

fn rgb_fill(operands: &[Object]) -> Option<[u8; 3]> {
    let channel = |index: usize| {
        operands
            .get(index)
            .and_then(object_number)
            .filter(|value| (0.0..=1.0).contains(value))
            .map(|value| (value * 255.0).round() as u8)
    };
    Some([channel(0)?, channel(1)?, channel(2)?])
}

/// The page's named graphics states.
fn ext_g_states<'a>(
    document: &'a Document,
    resources: &[&'a Dictionary],
) -> HashMap<Vec<u8>, &'a Dictionary> {
    let mut states = HashMap::new();
    for resources in resources {
        if let Some(dictionary) = resources
            .get(b"ExtGState")
            .ok()
            .and_then(|object| resolved_dictionary(document, object))
        {
            for (name, object) in dictionary {
                if let Some(state) = resolved_dictionary(document, object) {
                    states.insert(name.clone(), state);
                }
            }
        }
    }
    states
}

/// Whether a graphics state keeps painting normal and opaque: full opacity,
/// the normal blend, no soft mask, no transfer function and no overprint.
fn normal_opaque_state(document: &Document, state: &Dictionary) -> bool {
    let value = |key: &[u8]| {
        state
            .get(key)
            .ok()
            .and_then(|object| document.resolved(object).ok())
    };
    let opaque = |key: &[u8]| value(key).is_none_or(|object| object_number(object) == Some(1.0));
    let named = |key: &[u8], allowed: &[&[u8]]| {
        value(key).is_none_or(|object| object.as_name().is_ok_and(|name| allowed.contains(&name)))
    };
    let off = |key: &[u8]| value(key).is_none_or(|object| matches!(object.as_bool(), Ok(false)));
    opaque(b"CA")
        && opaque(b"ca")
        && named(b"BM", &[b"Normal", b"Compatible"])
        && named(b"SMask", &[b"None"])
        && named(b"TR", &[b"Identity"])
        && named(b"TR2", &[b"Identity", b"Default"])
        && off(b"OP")
        && off(b"op")
        && off(b"AIS")
}

/// Whether an image placement's integer rectangle covers the whole bitmap.
fn covers_bitmap(
    grid: &evb_scan_cleanup::io::source_raster::PageGrid,
    placement: [f64; 6],
) -> bool {
    let [da, db, dc, dd, de, df] = grid.device;
    let [a, b, c, d, e, f] = placement;
    let device = [
        da * a + dc * b,
        db * a + dd * b,
        da * c + dc * d,
        db * c + dd * d,
        da * e + dc * f + de,
        db * e + dd * f + df,
    ];
    let (scale_x, shear_y, shear_x, scale_y) = (device[0], device[1], -device[2], -device[3]);
    let (origin_x, origin_y) = (device[2] + device[4], device[3] + device[5]);
    if shear_x != 0.0 || shear_y != 0.0 || !(scale_x > 0.0 && scale_y > 0.0) {
        return false;
    }
    origin_x.floor() <= 0.0
        && origin_y.floor() <= 0.0
        && (scale_x + origin_x).floor() + 1.0 >= grid.width as f64
        && (scale_y + origin_y).floor() + 1.0 >= grid.height as f64
}

/// An image XObject as a kernel paint, or why the kernel cannot draw it.
fn image_paint(
    document: &Document,
    stream: &lopdf::Stream,
    placement: [f64; 6],
    fill: Option<[u8; 3]>,
    max_pixels: u64,
    compatibility: &mut SampleCompatibility,
) -> Result<std::result::Result<evb_scan_cleanup::io::source_raster::Paint, &'static str>> {
    use evb_scan_cleanup::io::source_raster::Paint;

    let dictionary = &stream.dict;
    let (stencil, bits) = image_bits(document, dictionary, 8);
    // A JPEG 2000 stream carries its own precision, which its decoder maps to
    // 8-bit samples; the dictionary's BitsPerComponent is optional and unused.
    let jpx = matches!(
        dictionary_value(document, dictionary, &[b"Filter", b"F"]),
        Some(Object::Name(name)) if name == b"JPXDecode"
    );
    let bits = if jpx && !stencil { 8 } else { bits };
    if stencil {
        let Some(fill) = fill else {
            return Ok(Err("stencil fill color is not gray or RGB"));
        };
        let inverted = match decode_polarity(document, dictionary, 1) {
            Some(inverted) => inverted,
            None => return Ok(Err("stencil Decode is not default or inverted")),
        };
        let Some(samples) = image_samples(document, stream, 1, 1, max_pixels, compatibility)?
        else {
            return Ok(Err("stencil filter is not supported"));
        };
        // Coverage is one where the stencil paints: bit zero by default.
        let coverage = unpack_bits(&samples, |bit| u8::from(bit == inverted));
        return Ok(Ok(Paint::Stencil {
            coverage,
            fill,
            placement,
        }));
    }
    if dictionary.has(b"Mask") {
        return Ok(Err("image has an explicit or color-key mask"));
    }
    let components = match dictionary_value(document, dictionary, &[b"ColorSpace", b"CS"])
        .and_then(|object| object.as_name().ok())
    {
        Some(b"DeviceGray" | b"G") => 1,
        Some(b"DeviceRGB" | b"RGB") => 3,
        _ => return Ok(Err("image color space is not DeviceGray or DeviceRGB")),
    };
    if !(bits == 8 || (bits == 1 && components == 1)) {
        return Ok(Err("image bit depth is not supported"));
    }
    let Some(inverted) = decode_polarity(document, dictionary, components) else {
        return Ok(Err("image Decode is not supported"));
    };
    if inverted && components == 3 {
        return Ok(Err("RGB image Decode is not identity"));
    }
    let Some(samples) = image_samples(
        document,
        stream,
        components,
        bits as u8,
        max_pixels,
        compatibility,
    )?
    else {
        return Ok(Err("image filter is not supported"));
    };
    let mut image = if bits == 1 {
        unpack_bits(&samples, |bit| if bit != inverted { 255 } else { 0 })
    } else {
        let mut plane = plane_of(&samples, components);
        if inverted {
            plane
                .samples
                .iter_mut()
                .for_each(|sample| *sample = 255 - *sample);
        }
        plane
    };
    image.interpolate = interpolate(dictionary);
    let soft_mask = match dictionary_value(document, dictionary, &[b"SMask"]) {
        None => None,
        Some(Object::Name(name)) if name == b"None" => None,
        Some(object) => {
            let Ok(mask) = object.as_stream() else {
                return Ok(Err("image soft mask is not a stream"));
            };
            let (_, mask_bits) = image_bits(document, &mask.dict, 1);
            let gray = dictionary_value(document, &mask.dict, &[b"ColorSpace"])
                .and_then(|object| object.as_name().ok());
            if mask_bits != 1
                || gray.is_some_and(|name| name != b"DeviceGray")
                || mask.dict.has(b"Matte")
            {
                return Ok(Err("image soft mask is not a one-bit gray mask"));
            }
            let Some(inverted) = decode_polarity(document, &mask.dict, 1) else {
                return Ok(Err("soft mask Decode is not supported"));
            };
            let Some(samples) = image_samples(document, mask, 1, 1, max_pixels, compatibility)?
            else {
                return Ok(Err("soft mask filter is not supported"));
            };
            let mut mask_plane = unpack_bits(&samples, |bit| if bit != inverted { 255 } else { 0 });
            mask_plane.interpolate = interpolate(&mask.dict);
            Some(mask_plane)
        }
    };
    if let Some(mask) = &soft_mask {
        if (mask.width, mask.height) != (image.width, image.height) {
            return Ok(Err("soft mask differs from its image in size"));
        }
    }
    Ok(Ok(Paint::Image {
        image,
        soft_mask,
        placement,
    }))
}

/// Whether an image's Decode inverts it: `Some(false)` for default or
/// identity, `Some(true)` for the inverted one-channel map, `None` otherwise.
fn decode_polarity(
    document: &Document,
    dictionary: &Dictionary,
    components: usize,
) -> Option<bool> {
    let Some(decode) = dictionary_value(document, dictionary, &[b"Decode", b"D"]) else {
        return Some(false);
    };
    let values = decode
        .as_array()
        .ok()?
        .iter()
        .map(object_number)
        .collect::<Option<Vec<_>>>()?;
    let identity: Vec<f64> = (0..components).flat_map(|_| [0.0, 1.0]).collect();
    if values == identity {
        Some(false)
    } else if components == 1 && values == [1.0, 0.0] {
        Some(true)
    } else {
        None
    }
}

fn interpolate(dictionary: &Dictionary) -> bool {
    dictionary
        .get(b"Interpolate")
        .or_else(|_| dictionary.get(b"I"))
        .and_then(Object::as_bool)
        .unwrap_or(false)
}

/// An image stream's samples before Decode, through the one filter the scan
/// kernel admits for it, or `None` for a filter it does not.
fn image_samples(
    document: &Document,
    stream: &lopdf::Stream,
    components: usize,
    bits: u8,
    max_pixels: u64,
    compatibility: &mut SampleCompatibility,
) -> Result<Option<evb_pdf_image_combine::pdf_image_samples::DecodedSamples>> {
    use evb_pdf_image_combine::pdf_image_samples::{
        decode_ccitt_g4, decode_dct, decode_dct_rust, decode_jbig2_generic, decode_jpx,
        DecodedSamples,
    };

    let dictionary = &stream.dict;
    let dimension = |keys: &[&[u8]]| {
        dictionary_value(document, dictionary, keys)
            .and_then(|object| object.as_i64().ok())
            .and_then(|value| u32::try_from(value).ok())
            .filter(|&value| value > 0)
    };
    let (Some(width), Some(height)) = (dimension(&[b"Width", b"W"]), dimension(&[b"Height", b"H"]))
    else {
        return Err("image has no valid size".into());
    };
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(domain_error(
            NativeErrorCode::TooLarge,
            "image exceeds the raster pixel budget",
        ));
    }
    let filters: Vec<&[u8]> = match dictionary_value(document, dictionary, &[b"Filter", b"F"]) {
        None => Vec::new(),
        Some(Object::Name(name)) => vec![name.as_slice()],
        Some(Object::Array(values)) => match values
            .iter()
            .map(|value| value.as_name().ok())
            .collect::<Option<Vec<_>>>()
        {
            Some(names) => names,
            None => return Ok(None),
        },
        Some(_) => return Ok(None),
    };
    let parameters =
        dictionary_value(document, dictionary, &[b"DecodeParms", b"DP"]).and_then(|object| {
            match object {
                Object::Array(values) => values
                    .first()
                    .and_then(|value| document.resolved(value).ok()),
                other => Some(other),
            }
        });
    let parameter = |key: &[u8]| {
        parameters
            .and_then(|object| object.as_dict().ok())
            .and_then(|parameters| parameters.get(key).ok())
            .and_then(|object| document.resolved(object).ok())
    };
    let samples = match filters.as_slice() {
        [] | [b"FlateDecode" | b"Fl"] => {
            let data = crate::load_policy::plain_stream_with_limit(
                stream,
                MAX_DECOMPRESSED_PDF_STREAM_BYTES,
            )
            .map_err(|error| format!("image stream is not decodable: {error}"))?;
            let stride = (width as usize * components * usize::from(bits)).div_ceil(8);
            if data.len() < stride * height as usize {
                return Err("image stream is shorter than its size".into());
            }
            Some(DecodedSamples {
                width,
                height,
                components: components as u8,
                bits_per_component: bits,
                data: data[..stride * height as usize].to_vec(),
                matches_poppler: true,
            })
        }
        [b"CCITTFaxDecode" | b"CCF"] => {
            let k = parameter(b"K")
                .and_then(|object| object.as_i64().ok())
                .unwrap_or(0);
            let columns = parameter(b"Columns")
                .and_then(|object| object.as_i64().ok())
                .unwrap_or(1728);
            let rows = parameter(b"Rows")
                .and_then(|object| object.as_i64().ok())
                .unwrap_or(i64::from(height));
            let black_is_1 = parameter(b"BlackIs1")
                .and_then(|object| object.as_bool().ok())
                .unwrap_or(false);
            let aligned = parameter(b"EncodedByteAlign")
                .and_then(|object| object.as_bool().ok())
                .unwrap_or(false);
            if k >= 0
                || aligned
                || columns != i64::from(width)
                || rows != i64::from(height)
                || bits != 1
            {
                return Ok(None);
            }
            Some(decode_ccitt_g4(
                &stream.content,
                width,
                height,
                black_is_1,
                max_pixels,
            )?)
        }
        [b"JBIG2Decode"] => {
            if parameter(b"JBIG2Globals").is_some() || bits != 1 {
                return Ok(None);
            }
            // The decoder covers the generic-region streams scans carry; a
            // valid stream outside that subset is drawn by the general renderer.
            decode_jbig2_generic(&stream.content, width, height, max_pixels).ok()
        }
        [b"DCTDecode" | b"DCT"] if bits == 8 => {
            // libjpeg applies the stream's own color transform; a PDF
            // override of it is decoded without that guarantee.
            if components == 3 && parameter(b"ColorTransform").is_some() {
                decode_dct_rust(&stream.content, width, height, 3, max_pixels)?
            } else {
                decode_dct(&stream.content, width, height, components as u8, max_pixels)?
            }
        }
        [b"JPXDecode"] if bits == 8 => {
            decode_jpx(&stream.content, width, height, components as u8, max_pixels)?
        }
        _ => None,
    };
    if samples
        .as_ref()
        .is_some_and(|samples| !samples.matches_poppler)
    {
        *compatibility = SampleCompatibility::Near;
    }
    // A codec that decoded a different component count does not match the dictionary.
    Ok(samples.filter(|samples| usize::from(samples.components) == components))
}

/// An 8-bit plane in kernel layout.
fn plane_of(
    samples: &evb_pdf_image_combine::pdf_image_samples::DecodedSamples,
    components: usize,
) -> evb_scan_cleanup::io::source_raster::Plane {
    evb_scan_cleanup::io::source_raster::Plane {
        width: samples.width as usize,
        height: samples.height as usize,
        channels: components,
        samples: samples.data.clone(),
        interpolate: false,
    }
}

/// A one-bit plane unpacked to one byte per pixel through `map`.
fn unpack_bits(
    samples: &evb_pdf_image_combine::pdf_image_samples::DecodedSamples,
    map: impl Fn(bool) -> u8,
) -> evb_scan_cleanup::io::source_raster::Plane {
    let (width, height) = (samples.width as usize, samples.height as usize);
    let stride = width.div_ceil(8);
    let mut unpacked = Vec::with_capacity(width * height);
    for row in samples.data.chunks_exact(stride).take(height) {
        for x in 0..width {
            unpacked.push(map(row[x / 8] & (0x80 >> (x % 8)) != 0));
        }
    }
    evb_scan_cleanup::io::source_raster::Plane {
        width,
        height,
        channels: 1,
        samples: unpacked,
        interpolate: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    use crate::page_sizes::{
        collect_page_sizes,
        tests::{create_test_document, create_test_document_with_pages},
    };

    #[test]
    fn inspects_the_pages_a_browser_asks_for_as_the_sidecar_records_them() {
        let mut document = create_test_document_with_pages(3);
        // The browser record is the sidecar record plus the facts desktop
        // reads from pdfimages and the annotation index.
        let sidecar = serde_json::Value::Array(
            serde_json::to_value(collect_page_sizes(&document).unwrap().pages)
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|page| {
                    let mut page = page.clone();
                    let record = page.as_object_mut().unwrap();
                    record.insert("rasterUses".into(), serde_json::json!([]));
                    record.insert("rasterInventoryComplete".into(), true.into());
                    record.insert("hasAnnotations".into(), false.into());
                    page
                })
                .collect(),
        );
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let every_page: serde_json::Value =
            serde_json::from_slice(&inspect_scan_cleanup_pdf_bytes(&bytes, &[]).unwrap()).unwrap();
        assert_eq!(every_page["pageCount"], 3);
        assert_eq!(every_page["pages"], sidecar);

        let selected: serde_json::Value =
            serde_json::from_slice(&inspect_scan_cleanup_pdf_bytes(&bytes, &[3, 1]).unwrap())
                .unwrap();
        assert_eq!(selected["pageCount"], 3);
        assert_eq!(
            selected["pages"],
            serde_json::json!([sidecar[2], sidecar[0]])
        );
        assert!(inspect_scan_cleanup_pdf_bytes(&bytes, &[4]).is_err());
    }

    #[test]
    fn inventories_masked_layers_inside_forms_like_pdfimages() {
        let (mut document, page_id) = create_test_document();
        let mask_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 2000,
                "Height" => 1000,
                "ImageMask" => true,
            },
            Vec::new(),
        ));
        let foreground_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 100,
                "Height" => 50,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Mask" => mask_id,
            },
            Vec::new(),
        ));
        let background_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 500,
                "Height" => 250,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
            },
            Vec::new(),
        ));
        let form_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                "Matrix" => vec![2.into(), 0.into(), 0.into(), 2.into(), 0.into(), 0.into()],
                "Resources" => dictionary! {"XObject" => dictionary! {"Fg" => foreground_id}},
            },
            b"/Fg Do".to_vec(),
        ));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 200 0 0 100 0 0 cm /Bg Do Q q 100 0 0 50 0 0 cm /Layer Do /Layer Do Q".to_vec(),
        ));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set(
            "Resources",
            dictionary! {"XObject" => dictionary! {"Bg" => background_id, "Layer" => form_id}},
        );
        page.set("Contents", content_id);
        page.set("Annots", vec![]);

        let inventory = page_raster_inventory(&document, page_id, 1 << 20).unwrap();

        assert!(inventory.complete);
        assert!(!page_has_annotations(&document, page_id));
        let row = |kind, width_px, height_px, bits_per_component, object_number, ppi| RasterUse {
            kind,
            width_px,
            height_px,
            bits_per_component,
            object_number,
            x_ppi: ppi,
            y_ppi: ppi,
        };
        let foreground = row("image", 100, 50, 8, foreground_id.0, 36);
        let mask = row("mask", 2000, 1000, 1, foreground_id.0, 720);
        assert_eq!(
            inventory.uses,
            vec![
                row("image", 500, 250, 8, background_id.0, 180),
                foreground,
                mask,
                row("image", 100, 50, 8, foreground_id.0, 36),
                row("mask", 2000, 1000, 1, foreground_id.0, 720),
            ],
        );
    }

    #[test]
    fn inventories_what_pdfimages_lists_beyond_page_content() {
        let (mut document, page_id) = create_test_document();
        let image = |document: &mut Document, extra: Dictionary| {
            let mut dictionary = dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 10,
                "Height" => 10,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            };
            for (key, value) in extra {
                dictionary.set(key, value);
            }
            document.add_object(Stream::new(dictionary, Vec::new()))
        };
        // Indirect facts: a one-bit image whose size and depth are references.
        let width_id = document.add_object(10);
        let bits_id = document.add_object(1);
        let indirect = image(
            &mut document,
            dictionary! {"Width" => width_id, "BitsPerComponent" => bits_id},
        );
        // An explicit mask overridden by a soft mask is not painted.
        let hard_mask = image(&mut document, dictionary! {"ImageMask" => true});
        let soft_mask = image(&mut document, Dictionary::new());
        let masked = image(
            &mut document,
            dictionary! {"Mask" => hard_mask, "SMask" => soft_mask},
        );
        // An image in a layer the default configuration turns off.
        let layer = document.add_object(dictionary! {"Type" => "OCG", "Name" => "Hidden"});
        let hidden = image(&mut document, Dictionary::new());
        document.objects.insert(
            document
                .trailer
                .get(b"Root")
                .unwrap()
                .as_reference()
                .unwrap(),
            Object::Dictionary({
                let mut catalog = document.catalog().unwrap().clone();
                catalog.set(
                    "OCProperties",
                    dictionary! {
                        "OCGs" => vec![layer.into()],
                        "D" => dictionary! {"OFF" => vec![layer.into()]},
                    },
                );
                catalog
            }),
        );
        // A stamp's appearance painting an image at 36 points per 10 pixels.
        let stamp_image = image(&mut document, Dictionary::new());
        let appearance = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                "Resources" => dictionary! {"XObject" => dictionary! {"S" => stamp_image}},
            },
            b"/S Do".to_vec(),
        ));
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            [
                b"q 7.2 0 0 7.2 0 0 cm /I Do Q".as_slice(),
                b"q 288 0 0 288 0 0 cm /M Do Q",
                b"/OC /L BDC q 72 0 0 72 0 0 cm /H Do BI /W 5 /H 5 /BPC 1 /CS /G ID \x00\x00\x00\x00\x00 EI Q EMC",
                b"q 1440 0 0 1440 0 0 cm BI /W 2 /H 2 /BPC 8 /CS /DeviceGray ID \x00\x00\x00\x00 EI Q",
            ]
            .join(&b' '),
        ));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! {"I" => indirect, "M" => masked, "H" => hidden},
                "Properties" => dictionary! {"L" => layer},
            },
        );
        page.set("Contents", content_id);
        page.set(
            "Annots",
            vec![dictionary! {
                "Subtype" => "Stamp",
                "Rect" => vec![0.into(), 0.into(), 36.into(), 36.into()],
                "AP" => dictionary! {"N" => appearance},
            }
            .into()],
        );

        let inventory = page_raster_inventory(&document, page_id, 1 << 20).unwrap();

        assert!(inventory.complete);
        let row = |kind, bits, object_number: u32, ppi| RasterUse {
            kind,
            width_px: 10,
            height_px: 10,
            bits_per_component: bits,
            object_number,
            x_ppi: ppi,
            y_ppi: ppi,
        };
        let mut inline = row("image", 8, 0, 0);
        inline.width_px = 2;
        inline.height_px = 2;
        assert_eq!(
            inventory.uses,
            vec![
                row("image", 1, indirect.0, 100),
                // 10 pixels over 288 points is 2.5, printed as 2.
                row("image", 8, masked.0, 2),
                row("smask", 8, masked.0, 2),
                // 2 pixels over 1,440 points prints below one, parsed as zero.
                inline,
                row("image", 8, stamp_image.0, 20),
            ],
        );
    }

    #[test]
    fn lists_inline_images_lopdf_cannot_decode_and_off_appearances() {
        let (mut document, page_id) = create_test_document();
        let image = |document: &mut Document, width: i64| {
            document.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Image",
                    "Width" => width,
                    "Height" => 10,
                    "ColorSpace" => "DeviceGray",
                    "BitsPerComponent" => 8,
                },
                Vec::new(),
            ))
        };
        let form = |document: &mut Document, image_id: ObjectId| {
            document.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Form",
                    "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                    "Resources" => dictionary! {"XObject" => dictionary! {"S" => image_id}},
                },
                b"/S Do".to_vec(),
            ))
        };
        let on_image = image(&mut document, 20);
        let off_image = image(&mut document, 30);
        let on = form(&mut document, on_image);
        let off = form(&mut document, off_image);
        // An abbreviated colour space and a filter: lopdf skips this image.
        let content_id = document.add_object(Stream::new(
            Dictionary::new(),
            b"q 72 0 0 72 0 0 cm BI /W 3 /H 4 /BPC 8 /CS /G /F /DCT ID \xff\xd8\xff\xd9 EI Q"
                .to_vec(),
        ));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set("Contents", content_id);
        page.set(
            "Annots",
            vec![dictionary! {
                "Subtype" => "Widget",
                "Rect" => vec![0.into(), 0.into(), 72.into(), 72.into()],
                "AP" => dictionary! {"N" => dictionary! {"On" => on, "Off" => off}},
            }
            .into()],
        );

        let inventory = page_raster_inventory(&document, page_id, 1 << 20).unwrap();

        assert!(inventory.complete);
        assert_eq!(
            inventory.uses,
            vec![
                RasterUse {
                    kind: "image",
                    width_px: 3,
                    height_px: 4,
                    bits_per_component: 8,
                    object_number: 0,
                    x_ppi: 3,
                    y_ppi: 4,
                },
                // Without /AS the Off appearance is the one shown.
                RasterUse {
                    kind: "image",
                    width_px: 30,
                    height_px: 10,
                    bits_per_component: 8,
                    object_number: off_image.0,
                    x_ppi: 30,
                    y_ppi: 10,
                },
            ],
        );
    }

    #[test]
    fn marks_inline_images_and_form_cycles_as_unmeasured() {
        let (mut document, page_id) = create_test_document();
        let form_id = document.new_object_id();
        document.objects.insert(
            form_id,
            Object::Stream(Stream::new(
                dictionary! {
                    "Type" => "XObject",
                    "Subtype" => "Form",
                    "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                    "Resources" => dictionary! {"XObject" => dictionary! {"Self" => form_id}},
                },
                b"/Self Do".to_vec(),
            )),
        );
        let content_id = document.add_object(Stream::new(Dictionary::new(), b"/Loop Do".to_vec()));
        let page = document.get_dictionary_mut(page_id).unwrap();
        page.set(
            "Resources",
            dictionary! {"XObject" => dictionary! {"Loop" => form_id}},
        );
        page.set("Contents", content_id);
        page.set("Annots", vec![dictionary! {"Subtype" => "Link"}.into()]);

        let inventory = page_raster_inventory(&document, page_id, 1 << 20).unwrap();

        assert!(!inventory.complete);
        assert!(inventory.uses.is_empty());
        assert!(page_has_annotations(&document, page_id));
    }

    /// Every measured pdftoppm vector, from its PDF through the page's paint
    /// program, decoding and the scan kernel: exact pixels for every filter
    /// except JPEG, which is reported as near.
    #[test]
    fn leaves_an_image_under_optional_content_to_the_general_renderer() {
        let input = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scan-cleanup/tests/fixtures/source-raster/gray8-false/input.pdf"
        );
        let mut document = Document::load_mem(&std::fs::read(input).unwrap()).unwrap();
        let request = || ScanRasterRequest {
            page_number: 1,
            dpi: 72.0,
            scale_to: None,
            render_box: ScanRasterBox::CropBox,
            include_annotations: false,
            slice: None,
            max_pixels: 1 << 20,
        };
        assert!(matches!(
            render_scan_cleanup_raster(&document, request()),
            Ok(ScanRaster::Raster { .. })
        ));
        // Poppler hides the image when its group is off; only a general
        // renderer evaluates the group.
        let group = document
            .add_object(dictionary! {"Type" => "OCG", "Name" => Object::string_literal("Scan")});
        for object in document.objects.values_mut() {
            if let Ok(stream) = object.as_stream_mut() {
                if stream.dict.get(b"Subtype").and_then(Object::as_name).ok()
                    == Some(b"Image".as_slice())
                {
                    stream.dict.set("OC", group);
                }
            }
        }
        assert!(matches!(
            render_scan_cleanup_raster(&document, request()),
            Ok(ScanRaster::Unsupported("page uses optional content"))
        ));
    }

    #[test]
    fn places_an_image_by_the_reals_its_producer_wrote() {
        // A 576 x 418.08 pt page scales its 8 x 6 image to 1201 x 872 at
        // 150 DPI only when 418.08 is read as the double Poppler parses; its
        // f32 neighbour gives 871 rows and moves the row boundary at 436.
        // `expected.ppm` is bundled Poppler 26.02.0 `pdftoppm -cropbox
        // -hide-annotations -r 150 -x 0 -y 433 -W 2 -H 6`.
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/scan-raster-written-real"
        );
        let document =
            Document::load_mem(&std::fs::read(format!("{fixture}/input.pdf")).unwrap()).unwrap();
        let expected = std::fs::read(format!("{fixture}/expected.ppm")).unwrap();
        let request = ScanRasterRequest {
            page_number: 1,
            dpi: 150.0,
            scale_to: None,
            render_box: ScanRasterBox::CropBox,
            include_annotations: false,
            slice: Some(ScanRasterSlice {
                x: 0,
                y: 433,
                width: 2,
                height: 6,
            }),
            max_pixels: 1 << 20,
        };
        let ScanRaster::Raster { rgb, .. } =
            render_scan_cleanup_raster(&document, request).unwrap()
        else {
            panic!("the page is a scan the kernel paints");
        };
        assert_eq!(rgb, expected[expected.len() - 2 * 6 * 3..]);
    }

    #[test]
    fn renders_every_measured_vector_pdf_as_pdftoppm_does() {
        let fixtures = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scan-cleanup/tests/fixtures/source-raster"
        );
        let mut directories: Vec<_> = std::fs::read_dir(fixtures)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        directories.sort();
        assert_eq!(directories.len(), 64);
        let mut failures = Vec::new();
        for directory in &directories {
            let name = directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let vector: serde_json::Value =
                serde_json::from_slice(&std::fs::read(directory.join("vector.json")).unwrap())
                    .unwrap();
            let flags: Vec<&str> = vector["command_flags"]
                .as_array()
                .unwrap()
                .iter()
                .map(|flag| flag.as_str().unwrap())
                .collect();
            let region = vector["requested_region"].as_array().map(|region| {
                let value = |index: usize| region[index].as_u64().unwrap() as u32;
                ScanRasterSlice {
                    x: value(0),
                    y: value(1),
                    width: value(2),
                    height: value(3),
                }
            });
            let request = ScanRasterRequest {
                page_number: 1,
                dpi: vector["requested_dpi"].as_f64().unwrap(),
                scale_to: vector["scale_to"].as_u64().map(|pixels| pixels as u32),
                render_box: if flags.contains(&"-cropbox") {
                    ScanRasterBox::CropBox
                } else {
                    ScanRasterBox::MediaBox
                },
                include_annotations: false,
                slice: region,
                max_pixels: 1 << 20,
            };
            let document =
                Document::load_mem(&std::fs::read(directory.join("input.pdf")).unwrap()).unwrap();
            let expected = std::fs::read(directory.join("expected.ppm")).unwrap();
            let header_end = expected
                .iter()
                .enumerate()
                .filter(|(_, byte)| byte.is_ascii_whitespace())
                .nth(3)
                .unwrap()
                .0
                + 1;
            let filters = |filter: &str| {
                vector["layers"].as_array().unwrap().iter().any(|layer| {
                    layer["filter"] == filter || layer["soft_mask"]["filter"] == filter
                })
            };
            let near = filters("DCTDecode");
            // These vectors' streams have no page-information segment, which
            // the generic-region decoder requires; such a page falls back.
            if filters("JBIG2Decode") {
                if !matches!(
                    render_scan_cleanup_raster(&document, request),
                    Ok(ScanRaster::Unsupported(_))
                ) {
                    failures.push(format!("{name}: expected the general renderer"));
                }
                continue;
            }
            match render_scan_cleanup_raster(&document, request).unwrap() {
                ScanRaster::Raster {
                    rgb, compatibility, ..
                } => {
                    let expected_compatibility = if near {
                        SampleCompatibility::Near
                    } else {
                        SampleCompatibility::Exact
                    };
                    if compatibility != expected_compatibility {
                        failures.push(format!("{name}: compatibility {compatibility:?}"));
                    } else if !near && rgb != expected[header_end..] {
                        failures.push(format!("{name}: pixels differ"));
                    }
                }
                ScanRaster::Unsupported(reason) => {
                    failures.push(format!("{name}: unsupported ({reason})"))
                }
            }
        }
        assert!(
            failures.is_empty(),
            "{} vectors failed:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
}
