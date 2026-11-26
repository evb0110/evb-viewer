//! Missing print appearances: what a stock reader draws for a printed
//! annotation without a usable /AP, stored as its normal appearance.

use super::*;

#[path = "print_free_text.rs"]
mod free_text;
use free_text::missing_free_text_appearance;
pub(crate) use free_text::PrintFonts;

/// The stored normal appearance print draws. Structural sources keep stream
/// dictionaries without reading their bytes.
pub(super) fn annotation_normal_appearance<'a>(
    document: &'a impl PdfObjectSource,
    annotation: &'a Dictionary,
) -> Option<&'a Stream> {
    let appearances = document
        .resolved(annotation.get(b"AP").ok()?)
        .ok()?
        .as_dict()
        .ok()?;
    let normal = document.resolved(appearances.get(b"N").ok()?).ok()?;
    let stream = if let Ok(stream) = normal.as_stream() {
        stream
    } else {
        let state = document
            .resolved(annotation.get(b"AS").ok()?)
            .ok()?
            .as_name()
            .ok()?;
        document
            .resolved(normal.as_dict().ok()?.get(state).ok()?)
            .ok()?
            .as_stream()
            .ok()?
    };
    if !stream.content.is_empty() {
        let bbox = numbers(document, stream.dict.get(b"BBox").ok()?, 4)?;
        if !bbox.iter().all(|v| v.is_finite()) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] {
            return None;
        }
        if let Ok(matrix) = stream.dict.get(b"Matrix") {
            let m = numbers(document, matrix, 6)?;
            if !m.iter().all(|v| v.is_finite()) || m[0] * m[3] - m[1] * m[2] == 0.0 {
                return None;
            }
        }
    }
    Some(stream)
}

/// The subtypes EVB draws itself: FreeText and those `synthesized_appearance`
/// draws. A printer draws any other one, such as a form field from its value.
const EVB_DRAWN_SUBTYPES: [&[u8]; 8] = [
    b"FreeText",
    b"Text",
    b"Square",
    b"Circle",
    b"Line",
    b"PolyLine",
    b"Polygon",
    b"Ink",
];

/// The ceiling for one embedded font program FreeText synthesis reads.
const FONT_PROGRAM_BYTES: usize = 16 * 1024 * 1024;
/// The font program bytes one print job reads in all.
const FONT_PROGRAMS_BYTES: usize = 64 * 1024 * 1024;

/// The font dictionaries a FreeText's text may use, in order: its own /DR, its
/// page's inherited resources and the AcroForm /DR. A page needs no MediaBox.
fn free_text_fonts(
    document: &Document,
    annotation: &Dictionary,
    page_id: ObjectId,
) -> Result<Vec<Dictionary>> {
    let page_resources = resolve_inherited_object(document, page_id, b"Resources")?;
    let acroform = document
        .catalog()?
        .get(b"AcroForm")
        .ok()
        .and_then(|v| document.dereference(v).ok()?.1.as_dict().ok());
    let resources = [
        annotation.get(b"DR").ok(),
        page_resources,
        acroform.and_then(|d| d.get(b"DR").ok()),
    ];
    Ok(resources
        .into_iter()
        .filter_map(|r| {
            let r = document.dereference(r?).ok()?.1.as_dict().ok()?;
            document
                .dereference(r.get(b"Font").ok()?)
                .ok()?
                .1
                .as_dict()
                .ok()
                .cloned()
        })
        .collect())
}

/// A font's embedded TrueType program, through its first descendant font.
fn font_program_id(document: &Document, font: &Object) -> Option<ObjectId> {
    let mut font = document.dereference(font).ok()?.1.as_dict().ok()?;
    if let Ok(descendants) = font.get(b"DescendantFonts") {
        let first = document
            .dereference(descendants)
            .ok()?
            .1
            .as_array()
            .ok()?
            .first()?;
        font = document.dereference(first).ok()?.1.as_dict().ok()?;
    }
    let descriptor = document
        .dereference(font.get(b"FontDescriptor").ok()?)
        .ok()?
        .1;
    descriptor
        .as_dict()
        .ok()?
        .get(b"FontFile2")
        .ok()?
        .as_reference()
        .ok()
}

/// The embedded font programs a missing FreeText appearance on the page may
/// draw with: the only source streams Auto reads from a structural load. A
/// lookup that fails leaves its fonts out, so synthesis uses its fallbacks.
fn free_text_font_programs(document: &Document, page_id: ObjectId) -> Vec<ObjectId> {
    let annots = document
        .get_dictionary(page_id)
        .and_then(|page| page.get(b"Annots"));
    let annots = annots.and_then(|annots| document.dereference(annots));
    let mut programs = Vec::new();
    for item in annots.map_or(&[][..], |(_, a)| {
        a.as_array().map_or(&[][..], Vec::as_slice)
    }) {
        let Ok(annotation) = document.dereference(item).and_then(|(_, v)| v.as_dict()) else {
            continue;
        };
        if annotation.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"FreeText")
            && is_printed(document, annotation)
            && annotation_normal_appearance(document, annotation).is_none()
        {
            for fonts in free_text_fonts(document, annotation, page_id).unwrap_or_default() {
                programs.extend(
                    fonts
                        .iter()
                        .filter_map(|(_, font)| font_program_id(document, font)),
                );
            }
        }
    }
    programs
}

/// Reads the unread font programs that missing FreeText appearances may draw
/// with, each by its byte range, at most `FONT_PROGRAMS_BYTES` in all; a
/// program the annotations share is read once. A program above its own
/// ceiling or past the budget, or one the source cannot read, stays unread,
/// and synthesis skips it as an unusable program.
fn read_font_programs<S: ByteSource>(
    incremental: &mut IncrementalDocument,
    source: &SourcePdf<S>,
    page_ids: &BTreeMap<u32, ObjectId>,
) {
    read_font_programs_within(incremental, source, page_ids, FONT_PROGRAMS_BYTES);
}

fn read_font_programs_within<S: ByteSource>(
    incremental: &mut IncrementalDocument,
    source: &SourcePdf<S>,
    page_ids: &BTreeMap<u32, ObjectId>,
    budget: usize,
) {
    let programs = page_ids
        .values()
        .flat_map(|page_id| free_text_font_programs(&incremental.previous_document, *page_id))
        .collect::<std::collections::BTreeSet<_>>();
    let mut left = budget;
    for id in programs {
        if !incremental.unavailable_base_streams.contains(&id) {
            continue;
        }
        let ceiling = FONT_PROGRAM_BYTES.min(left);
        if incremental
            .materialize_base_stream(source as StructuralSource, id, ceiling)
            .is_ok()
        {
            let read = incremental
                .previous_document
                .get_object(id)
                .and_then(Object::as_stream)
                .map_or(0, |stream| stream.content.len());
            left = left.saturating_sub(read);
        }
    }
}

/// Gives each printed annotation on the page that lacks a usable normal
/// appearance the one a stock reader would draw, with the annotation's opacity
/// and blend mode inside it, as readers expect of a stored appearance. Without
/// `every_subtype` only the subtypes EVB draws get one; composition flattens
/// other subtypes where supported. Returns the objects it
/// rewrote: indirect annotations, or the page or /Annots array holding a direct
/// one. An annotation with no drawable geometry is unchanged. A FreeText draws
/// with the print job's fonts, which the caller embeds after its last page.
pub(crate) fn materialize_print_appearances(
    document: &mut Document,
    page_id: ObjectId,
    every_subtype: bool,
    fonts: &mut PrintFonts,
) -> Result<Vec<ObjectId>> {
    let Ok(annots) = document.get_dictionary(page_id)?.get(b"Annots").cloned() else {
        return Ok(Vec::new());
    };
    let (array_id, mut items) = match document.dereference(&annots)? {
        (array_id, Object::Array(items)) => (array_id, items.clone()),
        _ => return Ok(Vec::new()),
    };
    let mut changed = Vec::new();
    let mut direct_changed = false;
    for item in &mut items {
        let Some(mut annotation) = (match &*item {
            Object::Reference(id) => document.get_dictionary(*id).ok().cloned(),
            Object::Dictionary(annotation) => Some(annotation.clone()),
            _ => None,
        }) else {
            continue;
        };
        if !is_printed(document, &annotation) {
            continue;
        }
        let subtype = annotation
            .get(b"Subtype")
            .and_then(Object::as_name)
            .ok()
            .map(<[u8]>::to_vec);
        let needs_flag =
            !annotation.has(b"F") && read_managed_shape_stable_key(&annotation).is_some();
        let needs_appearance = (every_subtype
            || subtype
                .as_deref()
                .is_some_and(|s| EVB_DRAWN_SUBTYPES.contains(&s)))
            && annotation_normal_appearance(document, &annotation).is_none();
        if !needs_flag && !needs_appearance {
            continue;
        }
        if needs_flag {
            set_print_flag(&mut annotation, ANNOTATION_FLAG_PRINT);
        }
        if needs_appearance {
            if every_subtype
                && subtype.as_deref().is_some_and(|s| {
                    matches!(
                        s,
                        b"Widget" | b"Highlight" | b"Underline" | b"StrikeOut" | b"Squiggly"
                    )
                })
            {
                return Err(format!(
                    "Cannot compose printable {} annotation without its appearance",
                    String::from_utf8_lossy(subtype.as_deref().unwrap_or_default())
                )
                .into());
            }
            let free_text = subtype.as_deref() == Some(b"FreeText");
            if let Some(appearance) = free_text
                .then(|| missing_free_text_appearance(document, &annotation, page_id, fonts).ok())
                .flatten()
                .or_else(|| synthesized_appearance(document, &mut annotation))
            {
                if let Some(state) = annotation_graphics_state(document, &annotation) {
                    let stream = document.get_object_mut(appearance)?.as_stream_mut()?;
                    if let Ok(Object::Dictionary(resources)) = stream.dict.get_mut(b"Resources") {
                        resources.set(
                            "ExtGState",
                            Dictionary::from_iter([("PrintAnnot", Object::Dictionary(state))]),
                        );
                    }
                    let content = [b"/PrintAnnot gs\n".as_slice(), &stream.content].concat();
                    stream.set_content(content);
                }
                annotation.remove(b"CA");
                annotation.remove(b"BM");
                annotation.set(
                    "AP",
                    Dictionary::from_iter([("N", Object::Reference(appearance))]),
                );
            } else if !needs_flag {
                continue;
            }
        }
        if let Object::Reference(id) = item {
            changed.push(*id);
            document.objects.insert(*id, Object::Dictionary(annotation));
        } else {
            *item = Object::Dictionary(annotation);
            direct_changed = true;
        }
    }
    if direct_changed {
        changed.push(array_id.unwrap_or(page_id));
        if let Some(array_id) = array_id {
            document.objects.insert(array_id, Object::Array(items));
        } else {
            document.get_dictionary_mut(page_id)?.set("Annots", items);
        }
    }
    Ok(changed)
}

/// Auto printing keeps every page, box, rotation and content stream: one
/// incremental revision adds only the missing appearances and the objects that
/// name them, so memory follows those annotations rather than the document.
/// Nothing is written when no printed annotation needs an appearance or flag; the
/// caller then prints the source itself.
pub(crate) fn write_print_appearances_path(input_path: &Path, output_path: &Path) -> Result<()> {
    let (source, mut incremental) = SourcePdf::open_append_base_path(input_path)?;
    let base_max_id = incremental.previous_document.max_id;
    let mut changed = Vec::new();
    let page_ids = incremental.previous_document.get_pages();
    read_font_programs(&mut incremental, &source, &page_ids);
    let mut fonts = PrintFonts::default();
    for page_id in page_ids.into_values() {
        changed.extend(materialize_print_appearances(
            &mut incremental.previous_document,
            page_id,
            false,
            &mut fonts,
        )?);
    }
    fonts.embed(&mut incremental.previous_document)?;
    if changed.is_empty() {
        return Ok(());
    }
    // The synthesized objects move into the revision with the rewritten ones.
    let document = &mut incremental.previous_document;
    let added = document.objects.split_off(&(base_max_id + 1, 0));
    let revision = &mut incremental.new_document;
    revision.objects.extend(added);
    for id in changed {
        revision
            .objects
            .insert(id, document.get_object(id)?.clone());
    }
    revision.max_id = document.max_id;
    revision.version = document.version.clone();
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

/// Host-file variant of `write_print_appearances_path`: opens `source` by
/// range, synthesizes missing printed annotation appearances, and calls `write`
/// with the incremental revision bytes only when at least one annotation
/// changed. Returns `(page_count, changed)`.
#[cfg(all(target_family = "wasm", target_os = "unknown"))]
pub(crate) fn write_print_appearances_to_source<S: ByteSource>(
    source: S,
    len: u64,
    write: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
) -> Result<(u32, bool)> {
    let mut pdf = SourcePdf::open_append_base(source, len)
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    let mut incremental = pdf
        .take_append_base()
        .map_err(|error| classify_pdf_load_error(error, "Failed to parse PDF structure"))?;
    let base_max_id = incremental.previous_document.max_id;
    let mut changed = Vec::new();
    let page_ids = incremental.previous_document.get_pages();
    let pages = u32::try_from(page_ids.len())?;
    read_font_programs(&mut incremental, &pdf, &page_ids);
    let mut fonts = PrintFonts::default();
    for page_id in page_ids.into_values() {
        changed.extend(materialize_print_appearances(
            &mut incremental.previous_document,
            page_id,
            false,
            &mut fonts,
        )?);
    }
    fonts.embed(&mut incremental.previous_document)?;
    if changed.is_empty() {
        return Ok((pages, false));
    }
    let document = &mut incremental.previous_document;
    let added = document.objects.split_off(&(base_max_id + 1, 0));
    let revision = &mut incremental.new_document;
    revision.objects.extend(added);
    for id in changed {
        revision
            .objects
            .insert(id, document.get_object(id)?.clone());
    }
    revision.max_id = document.max_id;
    revision.version = document.version.clone();
    let revision_bytes = build_incremental_revision(&mut incremental)?;
    let expected_object_ids = collect_incremental_append_object_ids(&incremental);
    validate_incremental_append_bytes(
        &revision_bytes,
        len,
        incremental.previous_xref_start(),
        &expected_object_ids,
    )?;
    validate_incremental_append_bytes(
        &write(&revision_bytes)?,
        len,
        incremental.previous_xref_start(),
        &expected_object_ids,
    )?;
    Ok((pages, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_programs_a_print_job_reads_stay_within_its_budget() {
        const PROGRAM: usize = 4_096;
        let mut document = Document::with_version("1.7");
        let pages = document.new_object_id();
        let font = |document: &mut Document, name: &str| {
            let program = document.add_object(Stream::new(Dictionary::new(), vec![7; PROGRAM]));
            let descriptor = document.add_object(dictionary! {
                "Type" => "FontDescriptor", "FontName" => name, "FontFile2" => program,
            });
            let font = document.add_object(dictionary! {
                "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => name,
                "FontDescriptor" => descriptor,
            });
            (font, program)
        };
        let (first, first_program) = font(&mut document, "First");
        let (second, second_program) = font(&mut document, "Second");
        let label = |document: &mut Document, name: &str| {
            document.add_object(dictionary! {
                "Type" => "Annot", "Subtype" => "FreeText", "F" => 4,
                "Rect" => vec![10.into(), 10.into(), 90.into(), 30.into()],
                "Contents" => Object::string_literal("label"),
                "DA" => Object::string_literal(format!("/{name} 12 Tf 0 g")),
            })
        };
        let annots = vec![
            label(&mut document, "F1").into(),
            label(&mut document, "F2").into(),
            label(&mut document, "F1").into(),
        ];
        let page = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => first, "F2" => second } },
            "Annots" => annots,
        });
        document.set_object(
            pages,
            dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
        );
        let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        document.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        document.save_to(&mut bytes).unwrap();

        let read = |budget| {
            let mut source = SourcePdf::open_append_base(&bytes[..], bytes.len() as u64).unwrap();
            let mut incremental = source.take_append_base().unwrap();
            let page_ids = incremental.previous_document.get_pages();
            read_font_programs_within(&mut incremental, &source, &page_ids, budget);
            [first_program, second_program].map(|id| {
                let unread = incremental.unavailable_base_streams.contains(&id);
                (!unread).then(|| {
                    incremental
                        .previous_document
                        .get_object(id)
                        .unwrap()
                        .as_stream()
                        .unwrap()
                        .content
                        .len()
                })
            })
        };
        // Both fit, and the program two labels share is read once.
        assert_eq!(read(2 * PROGRAM), [Some(PROGRAM), Some(PROGRAM)]);
        // One and a half programs' budget reads one; the other stays unread.
        let partial = read(PROGRAM + PROGRAM / 2);
        assert_eq!(
            partial.iter().flatten().sum::<usize>(),
            PROGRAM,
            "{partial:?}"
        );
    }
}
