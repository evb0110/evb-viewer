use super::*;

/// All indirect annotation object IDs listed in `page`'s `/Annots` array.
pub(crate) fn page_listed_annotation_ids(
    source: &Document,
    page: ObjectId,
) -> Result<HashSet<ObjectId>> {
    #[cfg(test)]
    THREAD_OWNER_ANNOTS_SCANS.with(|count| count.set(count.get().saturating_add(1)));
    Ok(page_annotation_array(source, source.get_dictionary(page)?)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| entry.as_reference().ok())
        .collect())
}

#[cfg(test)]
thread_local! {
    static THREAD_OWNER_ANNOTS_SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_thread_owner_annots_scans() {
    THREAD_OWNER_ANNOTS_SCANS.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn thread_owner_annots_scans() -> usize {
    THREAD_OWNER_ANNOTS_SCANS.with(std::cell::Cell::get)
}

/// The terminal owner of an annotation's thread, found by following reply and
/// popup links to the note that every member answers to.
pub(crate) fn thread_owner<'a>(
    source: &'a Document,
    annotation: &'a Dictionary,
    page: ObjectId,
    listed: &HashSet<ObjectId>,
) -> Result<&'a Dictionary> {
    let mut owner = annotation;
    let mut seen = HashSet::new();
    while let Some((id, parent)) = [b"IRT".as_slice(), b"Parent".as_slice()]
        .into_iter()
        .filter_map(|key| annotation_related_ref(owner, key))
        .filter_map(|id| source.get_dictionary(id).ok().map(|parent| (id, parent)))
        .find(|(id, parent)| {
            parent.has(b"Subtype")
                && (listed.contains(id)
                    || parent.get(b"P").and_then(Object::as_reference).ok() == Some(page))
        })
    {
        if !seen.insert(id) {
            break;
        }
        if seen.len() > 127 {
            return Err("annotation ownership is too deep".into());
        }
        owner = parent;
    }
    Ok(owner)
}

/// A note sits on the output that holds its marker centre, as an overlay note
/// does, so a thread is placed as a unit by the centre of its owner. An owner
/// without a readable rectangle is kept rather than dropped.
pub(crate) fn keep_split_annotation(
    source: &Document,
    output: &crate::split_output::SplitOutputPage,
    annotation: &Dictionary,
    listed: &HashSet<ObjectId>,
    source_view: PdfRect,
    source_rotation: i64,
) -> Result<bool> {
    let owner = thread_owner(source, annotation, output.source_id, listed)?;
    let subtype = owner
        .get(b"Subtype")
        .ok()
        .and_then(|object| source.resolved(object).ok())
        .and_then(|object| object.as_name().ok());
    let note_owner = matches!(subtype, Some(b"Text" | b"Popup"))
        || is_free_text_note_marker(source, owner, source_view, source_rotation);
    Ok(!note_owner
        || read_pdf_rect_from_dict(source, owner).is_none_or(|rect| {
            let rect = PdfMatrix::from_values(crate::split_output::split_annotation_matrix(
                output.transform,
            ))
            .bounds(rect);
            let (x, y) = ((rect.x1 + rect.x2) / 2.0, (rect.y1 + rect.y2) / 2.0);
            x >= output.crop.x1 && x < output.crop.x2 && y >= output.crop.y1 && y < output.crop.y2
        }))
}

/// Allocate from all retained page lists before rebinding any thread link.
/// Each related annotation resolves to its listed copy on this output, or to
/// its first listed output on another page. A removed target loses its link,
/// leaving the text intact instead of inventing an unlisted annotation.
pub(crate) fn transform_split_annotations(
    source: &Document,
    target: &mut Document,
    pages: &mut [crate::split_output::SplitOutputPage],
    page_index: &HashMap<ObjectId, usize>,
) -> Result<crate::split_output::SplitAnnotationMap> {
    let (copies, pending) = crate::split_output::allocate_split_annotations(source, target, pages)?;
    for (index, copy_id, mut annotation) in pending {
        let output = &pages[index];
        for key in [b"IRT".as_slice(), b"Parent".as_slice(), b"Popup".as_slice()] {
            let Some(related) = annotation_related_ref(&annotation, key) else {
                continue;
            };
            // Widget /Parent links are field-tree edges, rewritten by the form owner.
            if !source
                .get_dictionary(related)
                .is_ok_and(|member| member.has(b"Subtype"))
            {
                continue;
            }
            match copies.get(&related).and_then(|copies| {
                copies
                    .iter()
                    .find(|(page, _)| *page == output.id)
                    .or_else(|| copies.first())
            }) {
                Some((_, id)) => annotation.set(key, *id),
                None => {
                    annotation.remove(key);
                    if key == b"IRT" {
                        annotation.remove(b"RT");
                    }
                }
            }
        }
        if annotation.has(b"P") {
            annotation.set("P", output.id);
        }
        let note_copy = NoteCopy {
            source,
            source_page_id: output.source_id,
            matrix: crate::split_output::split_annotation_matrix(output.transform),
            view: output.crop,
            rotation: resolve_page_rotation(source, output.source_id)?,
        };
        crate::split_navigation::place_split_copy(
            target,
            &mut annotation,
            source,
            &note_copy,
            page_index,
        )?;
        target.set_object(copy_id, annotation);
    }
    Ok(copies)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    #[test]
    fn thread_ownership_builds_annots_set_once_for_5000_annotations_and_preserves_semantics() {
        let mut source = Document::with_version("1.5");
        let pages_id = source.new_object_id();
        let page_id = source.new_object_id();

        let mut annots = Vec::with_capacity(5_000);
        // 1. Cycle pair (A <-> B) must terminate cleanly.
        let cycle_a = source.new_object_id();
        let cycle_b = source.new_object_id();
        source.objects.insert(
            cycle_a,
            Object::Dictionary(dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => vec![10.into(), 10.into(), 20.into(), 20.into()],
                "IRT" => cycle_b,
                "P" => page_id,
            }),
        );
        source.objects.insert(
            cycle_b,
            Object::Dictionary(dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => vec![10.into(), 10.into(), 20.into(), 20.into()],
                "IRT" => cycle_a,
                "P" => page_id,
            }),
        );
        annots.push(Object::Reference(cycle_a));
        annots.push(Object::Reference(cycle_b));

        // 2. Unlisted root matched only via /P reference.
        let unlisted_owner = source.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "Rect" => vec![15.into(), 15.into(), 25.into(), 25.into()],
            "Contents" => Object::string_literal("Unlisted /P owner"),
            "P" => page_id,
        });
        let reply_to_unlisted = source.add_object(dictionary! {
            "Type" => "Annot",
            "Subtype" => "Text",
            "Rect" => vec![180.into(), 15.into(), 190.into(), 25.into()],
            "IRT" => unlisted_owner,
            "P" => page_id,
        });
        annots.push(Object::Reference(reply_to_unlisted));

        // 3. Fill up to 5,000 annotations with root/reply/popup triples.
        let mut expected_left_threads = 0usize;
        let mut expected_right_threads = 0usize;
        for index in 0..1_665_usize {
            let on_left = index % 2 == 0;
            let x = if on_left { 20 } else { 150 };
            if on_left {
                expected_left_threads += 1;
            } else {
                expected_right_threads += 1;
            }
            let root = source.new_object_id();
            let reply = source.new_object_id();
            let popup = source.new_object_id();
            source.objects.insert(
                root,
                Object::Dictionary(dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Text",
                    "Rect" => vec![x.into(), 20.into(), (x + 10).into(), 30.into()],
                    "Popup" => popup,
                    "P" => page_id,
                }),
            );
            source.objects.insert(
                reply,
                Object::Dictionary(dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Text",
                    // Deliberately place reply on opposite half to prove thread follows owner centre.
                    "Rect" => vec![(170 - x).into(), 20.into(), (180 - x).into(), 30.into()],
                    "IRT" => root,
                    "P" => page_id,
                }),
            );
            source.objects.insert(
                popup,
                Object::Dictionary(dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Popup",
                    "Rect" => vec![(170 - x).into(), 40.into(), (190 - x).into(), 60.into()],
                    "Parent" => root,
                    "P" => page_id,
                }),
            );
            annots.push(Object::Reference(root));
            annots.push(Object::Reference(reply));
            annots.push(Object::Reference(popup));
        }
        assert!(annots.len() >= 4_998);

        source.objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 200.into(), 100.into()],
                "Annots" => annots,
            }),
        );
        source.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = source.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        source.trailer.set("Root", catalog_id);

        let mut target = Document::with_version("1.5");
        let left_id = target.new_object_id();
        let right_id = target.new_object_id();
        let mut split_pages = vec![
            crate::split_output::SplitOutputPage {
                source_id: page_id,
                id: left_id,
                page: dictionary! {
                    "Type" => "Page",
                    "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
                    "Annots" => Vec::<Object>::new(),
                },
                crop: PdfRect {
                    x1: 0.0,
                    y1: 0.0,
                    x2: 100.0,
                    y2: 100.0,
                },
                transform: None,
            },
            crate::split_output::SplitOutputPage {
                source_id: page_id,
                id: right_id,
                page: dictionary! {
                    "Type" => "Page",
                    "MediaBox" => vec![100.into(), 0.into(), 200.into(), 100.into()],
                    "Annots" => Vec::<Object>::new(),
                },
                crop: PdfRect {
                    x1: 100.0,
                    y1: 0.0,
                    x2: 200.0,
                    y2: 100.0,
                },
                transform: None,
            },
        ];

        reset_thread_owner_annots_scans();
        let page_index = HashMap::from([(page_id, 0)]);
        let _copies =
            transform_split_annotations(&source, &mut target, &mut split_pages, &page_index)
                .unwrap();
        // Built ONCE for the shared source page across both split halves (not 10,000 times!).
        assert_eq!(thread_owner_annots_scans(), 1);

        let left_annots = split_pages[0]
            .page
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        let right_annots = split_pages[1]
            .page
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap();
        // Left holds: 2 cycle annots + 1 reply_to_unlisted (whose /P owner is at x=15..25) + 3 * expected_left_threads
        assert_eq!(left_annots.len(), 3 + expected_left_threads * 3);
        // Right holds: 3 * expected_right_threads
        assert_eq!(right_annots.len(), expected_right_threads * 3);
    }
}
