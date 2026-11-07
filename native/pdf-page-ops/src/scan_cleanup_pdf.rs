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
    reclassify_domain_error, resolve_page_rotation, resolve_page_view, NativeErrorCode,
    PageTreeResolver, PdfObjectSource, Result, MAX_DECOMPRESSED_PDF_STREAM_BYTES,
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

fn read_matrix(object: Option<&Object>) -> Option<Matrix> {
    object
        .and_then(|object| object.as_array().ok())
        .and_then(|values| values.iter().map(object_number).collect::<Option<Vec<_>>>())
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
}
