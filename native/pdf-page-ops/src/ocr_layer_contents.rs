//! Page content streams under OCR replacement. Reads how a page paints its
//! text (rendering mode, graphics state across streams) and removes the text an
//! earlier OCR layer or hidden producer text left, keeping every other operator.

use super::*;
use lopdf::content::{Content, Operation as ContentOperation};

pub(crate) const EVB_OCR_LAYER_BEGIN: &[u8] = b"% EVB_VIEWER_OCR_LAYER_BEGIN\n";
pub(crate) const EVB_OCR_LAYER_END: &[u8] = b"\n% EVB_VIEWER_OCR_LAYER_END\n";
pub(crate) const MAX_OCR_CONTENT_STREAM_BYTES: usize = 64 * 1024 * 1024;

fn is_text_show(operator: &str) -> bool {
    matches!(operator, "Tj" | "TJ" | "'" | "\"")
}

fn unsupported_replacement(detail: &str) -> Box<dyn Error> {
    domain_error(
        NativeErrorCode::InvalidRequest,
        format!("OCR page replacement is unsupported: {detail}"),
    )
}

/// EVB appends its OCR text as a content stream of its own between the marker
/// comments; earlier versions drew a Form XObject inside the same frame. A
/// comment that only names the marker, or a frame merged into other content,
/// is not an EVB layer, so it is never removed as one.
pub(crate) fn is_evb_ocr_layer_stream(bytes: &[u8]) -> bool {
    fn is_marker_comment(line: Option<&[u8]>, marker: &[u8]) -> bool {
        line.and_then(|line| line.strip_prefix(b"%"))
            .is_some_and(|comment| comment.trim_ascii() == marker)
    }
    let is_line_end = |byte: &u8| matches!(byte, b'\n' | b'\r');
    let framed = bytes.trim_ascii();
    is_marker_comment(
        framed.split(is_line_end).next(),
        b"EVB_VIEWER_OCR_LAYER_BEGIN",
    ) && is_marker_comment(
        framed.rsplit(is_line_end).next(),
        b"EVB_VIEWER_OCR_LAYER_END",
    )
}

fn rendering_mode(operation: &ContentOperation) -> Option<i64> {
    operation
        .operands
        .first()
        .and_then(|value| object_to_f64(value).ok())
        .filter(|value| value.fract() == 0.0 && (0.0..=7.0).contains(value))
        .map(|value| value as i64)
}

/// One page's text read the way a PDF consumer paints it. The rendering mode
/// is graphics state: `q` saves it and `Q` restores it, across the page's
/// content streams as a consumer concatenates them. The writer removes text
/// through this scan and the OCR eligibility inspection reports through it,
/// so a page the inspection offers for replacement is one the writer accepts.
#[derive(Default)]
pub(crate) struct PageTextScan {
    pub(crate) mode: i64,
    pub(crate) saved_modes: Vec<i64>,
    pub(crate) painted: bool,
    pub(crate) hidden: bool,
    /// What the open text object has shown so far. A text object may span
    /// content streams (ISO 32000-1 7.8.2), so this outlives one stream.
    pub(crate) object_hidden: bool,
    pub(crate) object_other: bool,
    /// Why removing this page's hidden text could change what it paints.
    pub(crate) unsupported: Option<&'static str>,
}

impl PageTextScan {
    /// Reads one content stream and returns the indices of its hidden
    /// (`3 Tr`) text-show operations. `on_draw` receives each `Do` operand
    /// with the rendering mode a Form XObject drawn there inherits.
    pub(crate) fn scan_stream(
        &mut self,
        operations: &[ContentOperation],
        mut on_draw: impl FnMut(&Object, i64),
    ) -> Vec<usize> {
        let mut hidden = Vec::new();
        for (index, operation) in operations.iter().enumerate() {
            match operation.operator.as_str() {
                "q" => self.saved_modes.push(self.mode),
                "Q" => self.mode = self.saved_modes.pop().unwrap_or(self.mode),
                "BT" => (self.object_hidden, self.object_other) = (false, false),
                "Tr" => match rendering_mode(operation) {
                    Some(mode) => self.mode = mode,
                    None => self.refuse("a Tr operator is malformed"),
                },
                "Do" => {
                    if let Some(name) = operation.operands.first() {
                        on_draw(name, self.mode);
                    }
                }
                operator if is_text_show(operator) => {
                    if self.mode == 3 {
                        hidden.push(index);
                        self.hidden = true;
                        self.object_hidden = true;
                    } else {
                        // Modes 4 to 6 paint and clip; mode 7 only clips.
                        self.painted |= self.mode != 7;
                        self.object_other = true;
                    }
                    if self.mode >= 4 {
                        self.refuse("text clipping rendering modes cannot be replaced safely");
                    }
                    if self.object_hidden && self.object_other {
                        // Removing part of a text object moves the text after it.
                        self.refuse("hidden and visible text share one text object");
                    }
                }
                _ => {}
            }
        }
        if !hidden.is_empty()
            && operations
                .iter()
                .any(|operation| operation.operator == "BI")
        {
            self.refuse("hidden text shares a content stream with an inline image");
        }
        hidden
    }

    pub(crate) fn refuse(&mut self, reason: &'static str) {
        self.unsupported.get_or_insert(reason);
    }
}

pub(crate) fn read_content_stream(
    incremental: &mut IncrementalDocument,
    structural: Option<StructuralSource<'_>>,
    object_id: ObjectId,
) -> Result<Option<Vec<u8>>> {
    if !incremental.new_document.has_object(object_id) {
        return incremental.read_base_stream_bounded(
            structural,
            object_id,
            MAX_OCR_CONTENT_STREAM_BYTES,
        );
    }
    let document = &incremental.new_document;
    let Ok(Object::Stream(stream)) = document.get_object(object_id) else {
        return Ok(None);
    };
    Ok(crate::plain_stream_with_limit(stream, MAX_OCR_CONTENT_STREAM_BYTES).ok())
}

/// The graphics state a removed show operator leaves for later text. `"` sets
/// word and character spacing (`aw ac "` is `aw Tw ac Tc` then a show), and
/// the spacing persists past the show and its text object. Other show
/// operators only move the text position, which the next text object resets.
fn state_left_by_show(operation: ContentOperation) -> Vec<ContentOperation> {
    if operation.operator != "\"" {
        return Vec::new();
    }
    match <[Object; 3]>::try_from(operation.operands) {
        Ok([word_spacing, character_spacing, _]) => vec![
            ContentOperation::new("Tw", vec![word_spacing]),
            ContentOperation::new("Tc", vec![character_spacing]),
        ],
        Err(_) => Vec::new(),
    }
}

/// Remove previous OCR text from a page whose dictionary is already in the
/// incremental revision. EVB layers go by their marker. Hidden text from
/// other producers goes by rendering mode; a stream that holds it is rewritten
/// without those show operators and otherwise unchanged.
pub(crate) fn strip_previous_ocr_text(
    incremental: &mut IncrementalDocument,
    structural: Option<StructuralSource<'_>>,
    page_id: ObjectId,
) -> Result<()> {
    let content_ids = incremental.new_document.get_page_contents(page_id);
    let mut kept = Vec::with_capacity(content_ids.len());
    let mut changed = false;
    let mut scan = PageTextScan::default();
    for content_id in content_ids {
        let Some(bytes) = read_content_stream(incremental, structural, content_id)? else {
            kept.push(content_id);
            continue;
        };
        if is_evb_ocr_layer_stream(&bytes) {
            changed = true;
            continue;
        }
        let Ok(content) = parse_content(&bytes)? else {
            kept.push(content_id);
            continue;
        };
        let hidden = scan.scan_stream(&content.operations, |_, _| {});
        if let Some(reason) = scan.unsupported {
            return Err(unsupported_replacement(reason));
        }
        if hidden.is_empty() {
            kept.push(content_id);
            continue;
        }
        changed = true;
        // Only the show operators go. The stream's graphics state (cm, clip,
        // Tr, colour, width) may scale or clip a later stream's painting, so
        // the rest of the stream stays even when it paints nothing itself.
        let remaining = content
            .operations
            .into_iter()
            .enumerate()
            .flat_map(|(index, operation)| {
                if hidden.binary_search(&index).is_ok() {
                    state_left_by_show(operation)
                } else {
                    vec![operation]
                }
            })
            .collect::<Vec<_>>();
        let mut stream = Stream::new(
            Dictionary::new(),
            Content {
                operations: remaining,
            }
            .encode()?,
        );
        stream.compress()?;
        kept.push(incremental.new_document.add_object(stream));
    }
    if changed {
        incremental.new_document.get_dictionary_mut(page_id)?.set(
            "Contents",
            Object::Array(kept.into_iter().map(Object::Reference).collect()),
        );
    }
    Ok(())
}

/// Replaces a page's OCR text. The new layer becomes the page's first content
/// stream. The layer's coordinates assume the default graphics state, and the
/// page may leave a cm, clip or text state open, so a layer appended after the
/// page's content would be drawn through it. Placed first, the layer starts in
/// the default state; the page's own streams keep their painting.
pub(crate) fn replace_page_ocr_text(
    incremental: &mut IncrementalDocument,
    structural: Option<StructuralSource<'_>>,
    source: &Document,
    source_page_id: ObjectId,
    page_id: ObjectId,
    matrix: [f64; 6],
    normalize_greek_micro_sign: bool,
) -> Result<()> {
    strip_previous_ocr_text(incremental, structural, page_id)?;
    let streams = incremental.new_document.get_page_contents(page_id).len();
    append_text_layer(
        &mut incremental.new_document,
        source,
        page_id,
        source_page_id,
        matrix,
        false,
        normalize_greek_micro_sign,
        Some((EVB_OCR_LAYER_BEGIN, EVB_OCR_LAYER_END)),
        &mut HashMap::new(),
    )?;
    let mut contents = incremental.new_document.get_page_contents(page_id);
    // A source without text adds no layer, and the page keeps its order.
    if contents.len() == streams {
        return Ok(());
    }
    contents.rotate_right(1);
    incremental.new_document.get_dictionary_mut(page_id)?.set(
        "Contents",
        Object::Array(contents.into_iter().map(Object::Reference).collect()),
    );
    Ok(())
}

/// Form XObjects nest; deeper drawing is unusual and is reported as uncertain.
const MAX_OCR_VISIBILITY_FORM_DEPTH: usize = 16;
/// Decoded Form XObject content one page inspection reads before it stops
/// and reports the rest of the page as uncertain.
const MAX_OCR_VISIBILITY_FORM_BYTES: usize = MAX_OCR_CONTENT_STREAM_BYTES;

/// What one page shows beyond the scan of its own content: text in the Form
/// XObjects it draws, and content that could not be read. The writer leaves
/// forms alone, so their text decides whether the page paints text, and
/// hidden text in a form is text a replacement would keep beside the new layer.
pub(crate) struct PageTextInspection<'a> {
    pub(crate) structural: Option<StructuralSource<'a>>,
    /// Forms read so far, with the rendering mode each draw passed in: the
    /// same form drawn under another mode shows its text differently.
    pub(crate) visited: HashSet<(ObjectId, i64)>,
    pub(crate) decoded_bytes: usize,
    pub(crate) painted: bool,
    pub(crate) uncertain: Option<&'static str>,
}

impl PageTextInspection<'_> {
    pub(crate) fn doubt(&mut self, reason: &'static str) {
        self.uncertain.get_or_insert(reason);
    }

    pub(crate) fn inspect(
        &mut self,
        source: &mut FormInspectionSource<'_>,
        resources: &Dictionary,
        name: &Object,
        mode: i64,
        depth: usize,
    ) -> Result<()> {
        let document = source.document();
        let Some(form_id) = name.as_name().ok().and_then(|name| {
            let xobjects = resources.get(b"XObject").ok()?;
            let (_, xobjects) = document.dereference(xobjects).ok()?;
            xobjects.as_dict().ok()?.get(name).ok()?.as_reference().ok()
        }) else {
            self.doubt("a drawn XObject could not be resolved");
            return Ok(());
        };
        let Ok(Object::Stream(stream)) = document.get_object(form_id) else {
            self.doubt("a drawn XObject could not be read");
            return Ok(());
        };
        match stream.dict.get(b"Subtype").and_then(Object::as_name).ok() {
            Some(b"Form") => {}
            Some(b"Image") => return Ok(()),
            _ => {
                self.doubt("a drawn XObject has an unknown subtype");
                return Ok(());
            }
        }
        if !self.visited.insert((form_id, mode)) {
            return Ok(());
        }
        if depth >= MAX_OCR_VISIBILITY_FORM_DEPTH {
            self.doubt("Form XObjects are nested too deeply to inspect");
            return Ok(());
        }
        // A form without its own resources uses those of the content drawing it.
        let form_resources = match stream.dict.get(b"Resources") {
            Ok(object) => match document
                .dereference(object)
                .ok()
                .and_then(|(_, obj)| obj.as_dict().ok())
            {
                Some(resources) => resources,
                None => {
                    self.doubt("a Form XObject's resources could not be read");
                    return Ok(());
                }
            },
            Err(_) => resources,
        }
        .clone();
        let Some(bytes) = source.read(self.structural, form_id)? else {
            self.doubt("a Form XObject's content could not be read");
            return Ok(());
        };
        self.decoded_bytes = self.decoded_bytes.saturating_add(bytes.len());
        if self.decoded_bytes > MAX_OCR_VISIBILITY_FORM_BYTES {
            self.doubt("the page's Form XObjects exceed the inspection budget");
            return Ok(());
        }
        let Ok(Ok(content)) = parse_content(&bytes) else {
            self.doubt("a Form XObject's content could not be parsed");
            return Ok(());
        };
        if content.operations.iter().any(|op| {
            op.operator == "Do" && (op.operands.len() != 1 || op.operands[0].as_name().is_err())
        }) {
            self.doubt("a Form XObject has a malformed draw");
        }
        // A form starts from the graphics state at its `Do` and cannot change
        // the state of the content that draws it.
        let mut scan = PageTextScan {
            mode,
            ..PageTextScan::default()
        };
        let mut draws = Vec::new();
        scan.scan_stream(&content.operations, |name, mode| {
            draws.push((name.clone(), mode))
        });
        self.painted |= scan.painted;
        if scan.unsupported.is_some() && !scan.painted {
            self.doubt("text inside a Form XObject cannot be preserved");
        }
        if scan.hidden {
            self.doubt("hidden text inside a Form XObject is not removed by OCR replacement");
        }
        for (name, mode) in draws {
            self.inspect(source, &form_resources, &name, mode, depth + 1)?;
        }
        Ok(())
    }
}

pub(crate) enum FormInspectionSource<'a> {
    Incremental(&'a mut IncrementalDocument),
    Document(&'a Document),
}

impl FormInspectionSource<'_> {
    fn document(&self) -> &Document {
        match self {
            Self::Incremental(doc) => &doc.previous_document,
            Self::Document(doc) => doc,
        }
    }

    fn read(
        &mut self,
        structural: Option<StructuralSource<'_>>,
        id: ObjectId,
    ) -> Result<Option<Vec<u8>>> {
        match self {
            Self::Incremental(doc) => read_content_stream(doc, structural, id),
            Self::Document(doc) => Ok(doc
                .get_object(id)
                .ok()
                .and_then(|object| object.as_stream().ok())
                .and_then(|stream| {
                    crate::plain_stream_with_limit(stream, MAX_OCR_CONTENT_STREAM_BYTES).ok()
                })),
        }
    }
}

pub(crate) fn form_text_omission(source: &Document, page_id: ObjectId) -> Result<()> {
    let bytes = crate::page_content_with_limit(source, page_id, MAX_OCR_CONTENT_STREAM_BYTES)?;
    let content = parse_content(&bytes)??;
    let resources = page_resources(source, page_id)?;
    if content.operations.iter().any(|op| {
        op.operator == "Do" && (op.operands.len() != 1 || op.operands[0].as_name().is_err())
    }) {
        return Err("overlay-text cannot inspect a malformed XObject draw".into());
    }
    let mut scan = PageTextScan::default();
    let mut draws = Vec::new();
    scan.scan_stream(&content.operations, |name, mode| {
        draws.push((name.clone(), mode))
    });
    let mut inspection = PageTextInspection {
        structural: None,
        visited: HashSet::new(),
        decoded_bytes: 0,
        painted: false,
        uncertain: None,
    };
    let mut source = FormInspectionSource::Document(source);
    for (name, mode) in draws {
        inspection.inspect(&mut source, &resources, &name, mode, 0)?;
    }
    if inspection.painted || inspection.uncertain.is_some() {
        return Err(format!(
            "overlay-text cannot preserve Form XObject text: {}",
            inspection
                .uncertain
                .unwrap_or("text is drawn inside a Form XObject")
        )
        .into());
    }
    Ok(())
}
