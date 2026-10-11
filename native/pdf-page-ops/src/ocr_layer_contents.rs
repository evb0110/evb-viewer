//! Page content streams under OCR replacement. Reads how a page paints its
//! text (rendering mode, graphics state across streams) and removes the text an
//! earlier OCR layer or hidden producer text left, keeping every other operator.

use super::*;
use lopdf::content::{Content, Operation as ContentOperation};
use std::path::Path;

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
    input_path: &Path,
    qpdf_path: Option<&Path>,
    object_id: ObjectId,
) -> Result<Option<Vec<u8>>> {
    if !incremental.new_document.has_object(object_id) {
        return incremental.read_base_stream_bounded(
            input_path,
            qpdf_path,
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

/// Remove previous OCR text from a page whose dictionary is already in the
/// incremental revision. EVB layers go by their marker. Hidden text from
/// other producers goes by rendering mode; a stream that holds it is rewritten
/// without those show operators and otherwise unchanged.
pub(crate) fn strip_previous_ocr_text(
    incremental: &mut IncrementalDocument,
    input_path: &Path,
    qpdf_path: Option<&Path>,
    page_id: ObjectId,
) -> Result<()> {
    let content_ids = incremental.new_document.get_page_contents(page_id);
    let mut kept = Vec::with_capacity(content_ids.len());
    let mut changed = false;
    let mut scan = PageTextScan::default();
    for content_id in content_ids {
        let Some(bytes) = read_content_stream(incremental, input_path, qpdf_path, content_id)?
        else {
            kept.push(content_id);
            continue;
        };
        if is_evb_ocr_layer_stream(&bytes) {
            changed = true;
            continue;
        }
        let Ok(content) = Content::decode(&bytes) else {
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
            .filter(|(index, _)| hidden.binary_search(index).is_err())
            .map(|(_, operation)| operation)
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
    input_path: &Path,
    qpdf_path: Option<&Path>,
    source: &Document,
    source_page_id: ObjectId,
    page_id: ObjectId,
    matrix: [f64; 6],
    normalize_greek_micro_sign: bool,
) -> Result<()> {
    strip_previous_ocr_text(incremental, input_path, qpdf_path, page_id)?;
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
    contents.rotate_right(1);
    incremental.new_document.get_dictionary_mut(page_id)?.set(
        "Contents",
        Object::Array(contents.into_iter().map(Object::Reference).collect()),
    );
    Ok(())
}
