//! A PDF read through its cross-reference index, for page-structure writes.
//!
//! Every object the trailer reaches is parsed at its offset into a skeleton
//! `Document` whose streams keep their dictionaries only: stream data is
//! located, never read, and a writer copies it by byte range. Memory follows
//! the object structure, not the file size. Desktop reads a file and the
//! browser its request buffer, through the same code.
use super::*;
use lopdf::xref::{Xref, XrefType};
use std::io;

/// The largest object, cross-reference section or object stream read whole.
const MAX_OBJECT_BYTES: usize = MAX_DECOMPRESSED_PDF_STREAM_BYTES;
const FIRST_WINDOW_BYTES: usize = 4 * 1024;
const MAX_XREF_SECTIONS: usize = 4_096;
/// Where the terminal `startxref` is looked for, past any trailing padding.
const TAIL_BYTES: usize = 64 * 1024;

/// Bytes read at an offset: a file on desktop, a request buffer in the browser.
pub(crate) trait ByteSource {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()>;
    fn copy_range(&self, offset: u64, len: u64, output: &mut impl Write) -> io::Result<()>;
}

impl<T: ByteSource + ?Sized> ByteSource for &T {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        (**self).read_at(offset, buffer)
    }

    fn copy_range(&self, offset: u64, len: u64, output: &mut impl Write) -> io::Result<()> {
        (**self).copy_range(offset, len, output)
    }
}

fn slice_range(bytes: &[u8], offset: u64, len: u64) -> io::Result<&[u8]> {
    usize::try_from(offset)
        .ok()
        .zip(usize::try_from(len).ok())
        .and_then(|(start, len)| bytes.get(start..start.checked_add(len)?))
        .ok_or_else(|| io::ErrorKind::UnexpectedEof.into())
}

impl ByteSource for [u8] {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        buffer.copy_from_slice(slice_range(self, offset, buffer.len() as u64)?);
        Ok(())
    }

    fn copy_range(&self, offset: u64, len: u64, output: &mut impl Write) -> io::Result<()> {
        output.write_all(slice_range(self, offset, len)?)
    }
}

impl ByteSource for File {
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        let mut file = self;
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(buffer)
    }

    /// `io::copy` from a length-limited file into a buffered file uses the
    /// kernel's file-to-file copy on Linux.
    fn copy_range(&self, offset: u64, len: u64, output: &mut impl Write) -> io::Result<()> {
        let mut file = self;
        file.seek(SeekFrom::Start(offset))?;
        if io::copy(&mut file.take(len), output)? != len {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        Ok(())
    }
}

/// A parsed PDF whose stream data stays in its source.
pub(crate) struct SourcePdf<S> {
    pub(crate) document: Document,
    /// Each stream's data as an absolute byte range of `bytes`.
    streams: HashMap<ObjectId, (u64, u64)>,
    bytes: S,
}

impl<S: ByteSource> SourcePdf<S> {
    /// Indexes `bytes` and parses every object its trailer reaches. An
    /// encrypted input is read decrypted when the empty password opens it;
    /// otherwise it needs a password this route does not take.
    pub(crate) fn open(bytes: S, len: u64) -> Result<Self> {
        let reader = Reader::new(&bytes, len)?;
        let index = reader.index()?;
        if index.trailer.has(b"Encrypt") {
            return Self::open_decrypted(bytes, len);
        }
        let mut document = Document::with_version(reader.version.clone());
        document.max_id = index.entries.keys().copied().max().unwrap_or(0);
        document.reference_table = Xref::new(document.max_id.saturating_add(1), index.xref_type);
        document.trailer = index.trailer.clone();
        let mut loader = Loader {
            reader: &reader,
            index: &index,
            object_streams: HashMap::new(),
            streams: HashMap::new(),
        };
        let mut pending = Vec::new();
        collect_references(&document.trailer, &mut pending);
        while let Some(id) = pending.pop() {
            if document.objects.contains_key(&id) {
                continue;
            }
            if document.objects.len() >= MAX_PDF_OBJECTS {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    format!("PDF exceeds the {MAX_PDF_OBJECTS}-object admission ceiling"),
                ));
            }
            let object = loader.load(id)?;
            collect_object_references(&object, &mut pending);
            document.objects.insert(id, object);
        }
        let pages = document.get_pages().len();
        if pages == 0 {
            return Err(corrupt("PDF has no pages"));
        }
        if pages > MAX_PATH_INPUT_PDF_PAGES {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                format!("PDF page count exceeds the {MAX_PATH_INPUT_PDF_PAGES}-page ceiling"),
            ));
        }
        Ok(Self {
            document,
            streams: loader.streams,
            bytes,
        })
    }

    fn open_decrypted(bytes: S, len: u64) -> Result<Self> {
        let len = usize::try_from(len)
            .ok()
            .filter(|len| *len <= MAX_ENCODED_PDF_BYTES)
            .ok_or_else(|| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "Encrypted PDF input exceeds the byte ceiling of the decrypting reader",
                )
            })?;
        let mut data = vec![0; len];
        bytes.read_at(0, &mut data).map_err(io_domain_error)?;
        let document = load_pdf_bytes_bounded(&data, Some(""))?;
        if document.is_encrypted() {
            return Err(domain_error(
                NativeErrorCode::NeedsPassword,
                "The encrypted PDF requires a password",
            ));
        }
        Ok(Self {
            document,
            streams: HashMap::new(),
            bytes,
        })
    }

    /// The source byte range of a stream whose data this source holds.
    pub(crate) fn stream_range(&self, id: ObjectId) -> Option<(&S, u64, u64)> {
        self.streams
            .get(&id)
            .map(|(offset, len)| (&self.bytes, *offset, *len))
    }
}

/// Bytes compared at each end of a written stream.
const STREAM_SAMPLE_BYTES: u64 = 16;

/// Reopens the written form of `document` (whose streams `raw` locates as
/// the writer took them) and checks what a writer that copies byte ranges can
/// get wrong, in time that follows the object count rather than the bytes:
/// every cross-reference entry names the object at its offset; every
/// stream's length ends at its `endstream`, and its data begins and ends
/// with the bytes it was written from; every object of `document` is there
/// and every reference from the trailer resolves; and the page tree yields
/// `document`'s pages, each with a parent, a media box and resources.
pub(crate) fn verify_written<'a, S: ByteSource + 'a, O: ByteSource>(
    document: &Document,
    raw: impl Fn(ObjectId) -> Option<(&'a S, u64, u64)>,
    output: &O,
    len: u64,
) -> Result<()> {
    let reader = Reader::new(output, len)?;
    if !Reader::read(output, len, len.saturating_sub(6), 6)?.ends_with(b"%%EOF\n") {
        return Err(corrupt("The written PDF does not end with %%EOF"));
    }
    let index = reader.index()?;
    let mut written = Document::with_version(reader.version.clone());
    written.trailer = index.trailer.clone();
    for (&number, entry) in &index.entries {
        let XrefEntry::Offset { offset, generation } = *entry else {
            return Err(corrupt("The written PDF has a compressed object"));
        };
        let id = (number, generation);
        let (_, object, data) = reader.indirect_object(offset, Some(id))?;
        if let (Object::Dictionary(dictionary), Some(data)) = (&object, data) {
            let start = reader.base + data;
            let declared = dictionary
                .get(b"Length")
                .and_then(Object::as_i64)
                .ok()
                .and_then(|length| u64::try_from(length).ok())
                .filter(|length| reader.ends_at_endstream(start, *length).unwrap_or(false))
                .ok_or_else(|| {
                    corrupt(format!(
                        "Written stream {number} does not end at its length"
                    ))
                })?;
            if let Some(Object::Stream(stream)) = document.objects.get(&id) {
                let same = match raw(id).filter(|_| stream.content.is_empty()) {
                    Some((source, origin, source_len)) => {
                        same_ends(output, start, declared, source, origin, source_len)
                    }
                    None => same_ends(
                        output,
                        start,
                        declared,
                        &stream.content[..],
                        0,
                        stream.content.len() as u64,
                    ),
                };
                if !same.map_err(io_domain_error)? {
                    return Err(corrupt(format!(
                        "Written stream {number} differs from its source"
                    )));
                }
            }
        }
        written.objects.insert(id, object);
    }
    if let Some(id) = document
        .objects
        .keys()
        .find(|id| !written.objects.contains_key(id))
    {
        return Err(corrupt(format!(
            "The written PDF lacks object {} {}",
            id.0, id.1
        )));
    }
    let mut pending = Vec::new();
    let mut reached = HashSet::new();
    collect_references(&written.trailer, &mut pending);
    while let Some(id) = pending.pop() {
        if reached.insert(id) {
            let object = written.objects.get(&id).ok_or_else(|| {
                corrupt(format!(
                    "Written reference {} {} R resolves to nothing",
                    id.0, id.1
                ))
            })?;
            collect_object_references(object, &mut pending);
        }
    }
    let pages = written.get_pages();
    if pages.len() != document.get_pages().len() {
        return Err(corrupt("The written page tree lost pages"));
    }
    for page in pages.into_values() {
        let parent = written
            .get_dictionary(page)?
            .get(b"Parent")?
            .as_reference()?;
        written.get_dictionary(parent)?;
        for key in [b"MediaBox".as_slice(), b"Resources"] {
            resolve_inherited_object(&written, page, key)?
                .ok_or_else(|| corrupt("A written page lacks its media box or resources"))?;
        }
    }
    Ok(())
}

/// Whether `len` written bytes at `start` have the length of the `source_len`
/// bytes at `origin` of `source` they were written from, and the same first and
/// last bytes.
fn same_ends<O: ByteSource, S: ByteSource + ?Sized>(
    output: &O,
    start: u64,
    len: u64,
    source: &S,
    origin: u64,
    source_len: u64,
) -> io::Result<bool> {
    if len != source_len {
        return Ok(false);
    }
    let sample = len.min(STREAM_SAMPLE_BYTES);
    for at in [0, len - sample] {
        let (mut written, mut wanted) = (vec![0; sample as usize], vec![0; sample as usize]);
        output.read_at(start + at, &mut written)?;
        source.read_at(origin + at, &mut wanted)?;
        if written != wanted {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Every reference a direct object holds, without following any.
fn collect_object_references(object: &Object, pending: &mut Vec<ObjectId>) {
    match object {
        Object::Reference(id) => pending.push(*id),
        Object::Array(items) => {
            for item in items {
                collect_object_references(item, pending);
            }
        }
        Object::Dictionary(dictionary) => collect_references(dictionary, pending),
        Object::Stream(stream) => collect_references(&stream.dict, pending),
        _ => {}
    }
}

fn collect_references(dictionary: &Dictionary, pending: &mut Vec<ObjectId>) {
    for (_, value) in dictionary.iter() {
        collect_object_references(value, pending);
    }
}

#[derive(Clone, Copy)]
enum XrefEntry {
    Free,
    Offset { offset: u64, generation: u16 },
    InStream { container: u32 },
}

/// One cross-reference section's entries, its trailer and its form.
type XrefSection = (Vec<(u32, XrefEntry)>, Dictionary, XrefType);

struct XrefIndex {
    entries: HashMap<u32, XrefEntry>,
    /// Ascending object offsets, which bound a stream whose length is wrong.
    offsets: Vec<u64>,
    trailer: Dictionary,
    xref_type: XrefType,
}

fn corrupt(message: impl Into<String>) -> Box<dyn Error> {
    domain_error(NativeErrorCode::CorruptXref, message)
}

struct Reader<'a, S> {
    bytes: &'a S,
    len: u64,
    /// Where `%PDF-` starts. Offsets count from it, as lopdf reads them.
    base: u64,
    version: String,
}

impl<'a, S: ByteSource> Reader<'a, S> {
    fn new(bytes: &'a S, len: u64) -> Result<Self> {
        let head = Self::read(bytes, len, 0, 1024)?;
        let base = find_bytes(&head, b"%PDF-").ok_or_else(|| corrupt("PDF header is missing"))?;
        let version = head[base + 5..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit() || **byte == b'.')
            .map(|byte| char::from(*byte))
            .collect::<String>();
        if version.is_empty() {
            return Err(corrupt("PDF header has no version"));
        }
        Ok(Self {
            bytes,
            len,
            base: base as u64,
            version,
        })
    }

    fn read(bytes: &S, len: u64, offset: u64, max: usize) -> Result<Vec<u8>> {
        let available = len.saturating_sub(offset).min(max as u64) as usize;
        let mut buffer = vec![0; available];
        bytes
            .read_at(offset, &mut buffer)
            .map_err(io_domain_error)?;
        Ok(buffer)
    }

    /// Parses from `offset` (counted from the header) through a window that
    /// grows while the parse runs out of input.
    fn parse_at<T>(
        &self,
        offset: u64,
        mut parse: impl FnMut(&mut Cursor) -> ParseResult<T>,
    ) -> Result<T> {
        let start = self
            .base
            .checked_add(offset)
            .filter(|start| *start < self.len)
            .ok_or_else(|| corrupt(format!("PDF offset {offset} is outside the file")))?;
        let mut window = FIRST_WINDOW_BYTES;
        loop {
            let bytes = Self::read(self.bytes, self.len, start, window)?;
            let truncated = (bytes.len() as u64) < self.len - start;
            match parse(&mut Cursor {
                bytes: &bytes,
                pos: 0,
            }) {
                Ok(value) => return Ok(value),
                Err(Incomplete) if truncated && window < MAX_OBJECT_BYTES => {
                    window = window.saturating_mul(8).min(MAX_OBJECT_BYTES);
                }
                Err(Incomplete) if truncated => {
                    return Err(domain_error(
                        NativeErrorCode::TooLarge,
                        format!(
                        "PDF object at offset {offset} exceeds the {MAX_OBJECT_BYTES}-byte ceiling"
                    ),
                    ))
                }
                Err(_) => {
                    return Err(corrupt(format!(
                        "PDF object at offset {offset} is malformed"
                    )))
                }
            }
        }
    }

    fn index(&self) -> Result<XrefIndex> {
        let tail_start = self.len.saturating_sub(TAIL_BYTES as u64);
        let tail = Self::read(self.bytes, self.len, tail_start, TAIL_BYTES)?;
        let marker = find_last_bytes(&tail, b"startxref")
            .ok_or_else(|| corrupt("PDF startxref marker is missing"))?;
        let mut next = parse_u64_token(&tail, marker + b"startxref".len())
            .map(|(offset, _)| offset)
            .ok_or_else(|| corrupt("PDF startxref value is invalid"))?;
        let mut entries = HashMap::new();
        let mut trailers = Vec::new();
        let mut visited = HashSet::new();
        let mut xref_type = None;
        loop {
            if !visited.insert(next) || visited.len() > MAX_XREF_SECTIONS {
                return Err(corrupt("PDF cross-reference chain loops or is too long"));
            }
            let (section, trailer, kind) = self.xref_section(next)?;
            xref_type.get_or_insert(kind);
            // A hybrid file's table lists its compressed objects as free;
            // its XRefStm entries take precedence over those.
            if let Ok(stream) = trailer.get(b"XRefStm").and_then(Object::as_i64) {
                let offset = u64::try_from(stream).map_err(|_| corrupt("Invalid /XRefStm"))?;
                for (number, entry) in self.xref_section(offset)?.0 {
                    entries.entry(number).or_insert(entry);
                }
            }
            for (number, entry) in section {
                entries.entry(number).or_insert(entry);
            }
            if entries.len() > MAX_PDF_OBJECTS {
                return Err(domain_error(
                    NativeErrorCode::TooLarge,
                    format!("PDF exceeds the {MAX_PDF_OBJECTS}-object admission ceiling"),
                ));
            }
            let previous = trailer.get(b"Prev").and_then(Object::as_i64).ok();
            trailers.push(trailer);
            match previous {
                Some(previous) => {
                    next = u64::try_from(previous).map_err(|_| corrupt("Invalid /Prev"))?
                }
                None => break,
            }
        }
        // The newest revision that names a document-level entry decides it.
        let mut trailer = Dictionary::new();
        for key in [b"Root".as_slice(), b"Info", b"Encrypt", b"ID"] {
            if let Some(value) = trailers.iter().find_map(|trailer| trailer.get(key).ok()) {
                trailer.set(key.to_vec(), value.clone());
            }
        }
        if !trailer.has(b"Root") {
            return Err(corrupt("PDF trailer has no /Root"));
        }
        entries.retain(|_, entry| !matches!(entry, XrefEntry::Free));
        let mut offsets = entries
            .values()
            .filter_map(|entry| match entry {
                XrefEntry::Offset { offset, .. } => Some(*offset),
                _ => None,
            })
            .collect::<Vec<_>>();
        offsets.sort_unstable();
        Ok(XrefIndex {
            entries,
            offsets,
            trailer,
            xref_type: xref_type.unwrap_or(XrefType::CrossReferenceTable),
        })
    }

    fn xref_section(&self, offset: u64) -> Result<XrefSection> {
        let classic = self.parse_at(offset, |cursor| {
            if !cursor.keyword(b"xref")? {
                return Ok(None);
            }
            let mut entries = Vec::new();
            while !cursor.keyword(b"trailer")? {
                let start = cursor.unsigned()?;
                let count = cursor.unsigned()?;
                for number in start..start.checked_add(count).ok_or(Invalid)? {
                    let entry_offset = cursor.unsigned()?;
                    let generation = cursor.unsigned()?;
                    let entry = match cursor.token()? {
                        b"n" => XrefEntry::Offset {
                            offset: entry_offset,
                            generation: u16::try_from(generation).map_err(|_| Invalid)?,
                        },
                        b"f" => XrefEntry::Free,
                        _ => return Err(Invalid),
                    };
                    entries.push((u32::try_from(number).map_err(|_| Invalid)?, entry));
                    if entries.len() > MAX_PDF_OBJECTS {
                        return Err(Invalid);
                    }
                }
            }
            match cursor.object(0)? {
                Object::Dictionary(trailer) => Ok(Some((entries, trailer))),
                _ => Err(Invalid),
            }
        })?;
        if let Some((entries, trailer)) = classic {
            return Ok((entries, trailer, XrefType::CrossReferenceTable));
        }
        let (_, dictionary, data) = self.indirect_object(offset, None)?;
        let dictionary = dictionary
            .as_dict()
            .map_err(|_| corrupt("Invalid xref stream"))?;
        if dictionary.get(b"Type").and_then(Object::as_name).ok() != Some(b"XRef") {
            return Err(corrupt(
                "PDF cross-reference offset points at no xref section",
            ));
        }
        let length = match dictionary.get(b"Length") {
            Ok(Object::Integer(length)) => u64::try_from(*length).ok(),
            _ => None,
        };
        let (data_start, data_len) = self.stream_extent(
            data.ok_or_else(|| corrupt("Xref stream has no data"))?,
            length,
            None,
        )?;
        let content = self.stream_content(dictionary, data_start, data_len)?;
        let widths = dictionary
            .get(b"W")
            .and_then(Object::as_array)
            .map_err(|_| corrupt("Xref stream has no /W"))?
            .iter()
            .map(|width| {
                width
                    .as_i64()
                    .ok()
                    .and_then(|width| usize::try_from(width).ok())
                    .filter(|width| *width <= 8)
            })
            .collect::<Option<Vec<_>>>()
            .filter(|widths| widths.len() == 3 && widths.iter().sum::<usize>() > 0)
            .ok_or_else(|| corrupt("Xref stream has invalid /W"))?;
        let size = dictionary
            .get(b"Size")
            .and_then(Object::as_i64)
            .map_err(|_| corrupt("Xref stream has no /Size"))?;
        let index = match dictionary.get(b"Index").and_then(Object::as_array) {
            Ok(index) => index
                .iter()
                .map(|value| {
                    value
                        .as_i64()
                        .ok()
                        .and_then(|value| u32::try_from(value).ok())
                })
                .collect::<Option<Vec<_>>>()
                .filter(|index| index.len() % 2 == 0)
                .ok_or_else(|| corrupt("Xref stream has invalid /Index"))?,
            Err(_) => vec![
                0,
                u32::try_from(size).map_err(|_| corrupt("Invalid xref /Size"))?,
            ],
        };
        let stride = widths.iter().sum::<usize>();
        let mut rows = content.chunks_exact(stride);
        let mut entries = Vec::new();
        for pair in index.chunks_exact(2) {
            for number in pair[0]
                ..pair[0]
                    .checked_add(pair[1])
                    .ok_or_else(|| corrupt("Invalid xref /Index"))?
            {
                let row = rows
                    .next()
                    .ok_or_else(|| corrupt("Xref stream ended early"))?;
                let mut fields = [1_u64, 0, 0];
                let mut cursor = 0;
                for (field, width) in fields.iter_mut().zip(&widths) {
                    if *width > 0 {
                        *field = read_xref_stream_field(row, &mut cursor, *width)?;
                    }
                }
                let entry = match fields[0] {
                    0 => XrefEntry::Free,
                    1 => XrefEntry::Offset {
                        offset: fields[1],
                        generation: u16::try_from(fields[2])
                            .map_err(|_| corrupt("Invalid xref generation"))?,
                    },
                    2 => XrefEntry::InStream {
                        container: u32::try_from(fields[1])
                            .map_err(|_| corrupt("Invalid object stream number"))?,
                    },
                    // Unknown entry types read as null objects.
                    _ => XrefEntry::Free,
                };
                entries.push((number, entry));
                if entries.len() > MAX_PDF_OBJECTS {
                    return Err(domain_error(
                        NativeErrorCode::TooLarge,
                        "Xref stream exceeds the object ceiling",
                    ));
                }
            }
        }
        Ok((entries, dictionary.clone(), XrefType::CrossReferenceStream))
    }

    /// The object at `offset`, its number, and where its stream data starts
    /// when it is a stream.
    fn indirect_object(
        &self,
        offset: u64,
        expected: Option<ObjectId>,
    ) -> Result<(ObjectId, Object, Option<u64>)> {
        let (id, object, data) = self.parse_at(offset, |cursor| {
            let number = u32::try_from(cursor.unsigned()?).map_err(|_| Invalid)?;
            let generation = u16::try_from(cursor.unsigned()?).map_err(|_| Invalid)?;
            if !cursor.keyword(b"obj")? {
                return Err(Invalid);
            }
            let object = cursor.object(0)?;
            let data = match object {
                Object::Dictionary(_) if cursor.keyword(b"stream")? => {
                    Some(cursor.stream_data_start()? as u64)
                }
                _ => None,
            };
            Ok(((number, generation), object, data))
        })?;
        if expected.is_some_and(|expected| expected != id) {
            return Err(corrupt(format!(
                "PDF object {} {} is not at its xref offset",
                id.0, id.1
            )));
        }
        Ok((id, object, data.map(|data| offset + data)))
    }

    /// The data range of a stream starting at `data` (counted from the
    /// header) as absolute file offsets. A declared length must end at
    /// `endstream`; otherwise the data ends at the only `endstream` before
    /// the next object, as lopdf recovers it.
    fn stream_extent(
        &self,
        data: u64,
        declared: Option<u64>,
        bound: Option<u64>,
    ) -> Result<(u64, u64)> {
        let start = self.base + data;
        if let Some(len) = declared {
            if self.ends_at_endstream(start, len)? {
                return Ok((start, len));
            }
        }
        const ENDSTREAM: &[u8] = b"endstream";
        let end = bound.map_or(self.len, |bound| (self.base + bound).min(self.len));
        let mut found = None;
        let mut position = start;
        while position < end {
            let chunk = Self::read(self.bytes, end, position, 1 << 20)?;
            let mut search = 0;
            while let Some(hit) = find_bytes(&chunk[search..], ENDSTREAM) {
                let at = position + (search + hit) as u64;
                search += hit + 1;
                let around = Self::read(self.bytes, self.len, at.saturating_sub(2), 64)?;
                let eol = match &around[..2.min(around.len())] {
                    [b'\r', b'\n'] => 2,
                    [_, b'\n' | b'\r'] => 1,
                    _ => continue,
                };
                let after = &around[(2 + ENDSTREAM.len()).min(around.len())..];
                let skipped = after
                    .iter()
                    .take_while(|byte| is_pdf_whitespace(**byte))
                    .count();
                if at - eol < start || !after[skipped..].starts_with(b"endobj") {
                    continue;
                }
                if found.is_some() {
                    return Err(corrupt(
                        "PDF stream length is wrong and its end is ambiguous",
                    ));
                }
                found = Some(at - eol);
            }
            // Consecutive chunks share all but one byte of a marker, so each
            // marker is found once, whole.
            position += chunk.len().saturating_sub(ENDSTREAM.len() - 1).max(1) as u64;
        }
        found
            .map(|end| (start, end - start))
            .ok_or_else(|| corrupt("PDF stream has no endstream"))
    }

    /// Whether `len` bytes of stream data from absolute offset `start` end
    /// where `endstream` follows.
    fn ends_at_endstream(&self, start: u64, len: u64) -> Result<bool> {
        let Some(end) = start.checked_add(len).filter(|end| *end <= self.len) else {
            return Ok(false);
        };
        let after = Self::read(self.bytes, self.len, end, 64)?;
        let skipped = after
            .iter()
            .take_while(|byte| is_pdf_whitespace(**byte))
            .count();
        Ok(after[skipped..].starts_with(b"endstream"))
    }

    /// A stream's decoded data, for the cross-reference and object streams
    /// this reader decodes itself.
    fn stream_content(&self, dictionary: &Dictionary, start: u64, len: u64) -> Result<Vec<u8>> {
        let len = usize::try_from(len)
            .ok()
            .filter(|len| *len <= MAX_OBJECT_BYTES)
            .ok_or_else(|| {
                domain_error(
                    NativeErrorCode::TooLarge,
                    "PDF structure stream exceeds its ceiling",
                )
            })?;
        let raw = Self::read(self.bytes, self.len, start, len)?;
        Ok(plain_stream_with_limit(
            &Stream::new(dictionary.clone(), raw),
            MAX_OBJECT_BYTES,
        )?)
    }
}

struct Loader<'r, 'a, S> {
    reader: &'r Reader<'a, S>,
    index: &'r XrefIndex,
    object_streams: HashMap<u32, BTreeMap<ObjectId, Object>>,
    streams: HashMap<ObjectId, (u64, u64)>,
}

impl<S: ByteSource> Loader<'_, '_, S> {
    /// One object as the document holds it: a missing or free one reads as
    /// null, a stream as its dictionary with an empty body.
    fn load(&mut self, id: ObjectId) -> Result<Object> {
        match self.index.entries.get(&id.0).copied() {
            Some(XrefEntry::Offset { offset, generation }) if generation == id.1 => {
                let (_, object, data) = self.reader.indirect_object(offset, Some(id))?;
                let (Some(data), Object::Dictionary(mut dict)) = (data, object.clone()) else {
                    return Ok(object);
                };
                let declared = match dict.get(b"Length") {
                    Ok(Object::Reference(length)) => self.length(*length)?,
                    Ok(length) => length.as_i64().ok(),
                    Err(_) => None,
                }
                .and_then(|length| u64::try_from(length).ok());
                let bound = self
                    .index
                    .offsets
                    .get(self.index.offsets.partition_point(|next| *next <= offset))
                    .copied();
                let (start, len) = self.reader.stream_extent(data, declared, bound)?;
                dict.set("Length", i64::try_from(len)?);
                self.streams.insert(id, (start, len));
                Ok(Object::Stream(Stream {
                    dict,
                    content: Vec::new(),
                    allows_compression: false,
                    start_position: None,
                }))
            }
            Some(XrefEntry::InStream { container }) if id.1 == 0 => Ok(self
                .compressed(container)?
                .remove(&id)
                .unwrap_or(Object::Null)),
            _ => Ok(Object::Null),
        }
    }

    /// An indirect `/Length`: read without following it as a stream.
    fn length(&mut self, id: ObjectId) -> Result<Option<i64>> {
        let length = match self.index.entries.get(&id.0).copied() {
            Some(XrefEntry::Offset { offset, generation }) if generation == id.1 => {
                self.reader.indirect_object(offset, Some(id))?.1
            }
            Some(XrefEntry::InStream { container }) if id.1 == 0 => self
                .compressed(container)?
                .get(&id)
                .cloned()
                .unwrap_or(Object::Null),
            _ => Object::Null,
        };
        Ok(length.as_i64().ok())
    }

    /// The objects of one object stream not yet taken. A container being
    /// decoded reads as empty, so a stream that names itself cannot recurse.
    fn compressed(&mut self, container: u32) -> Result<&mut BTreeMap<ObjectId, Object>> {
        if !self.object_streams.contains_key(&container) {
            self.object_streams.insert(container, BTreeMap::new());
            let objects = self.object_stream(container)?;
            self.object_streams.insert(container, objects);
        }
        Ok(self.object_streams.get_mut(&container).unwrap())
    }

    fn object_stream(&mut self, container: u32) -> Result<BTreeMap<ObjectId, Object>> {
        if !matches!(
            self.index.entries.get(&container),
            Some(XrefEntry::Offset { generation: 0, .. })
        ) {
            return Err(corrupt(format!("PDF object stream {container} is missing")));
        }
        let Object::Stream(stream) = self.load((container, 0))? else {
            return Err(corrupt(format!(
                "PDF object stream {container} is not a stream"
            )));
        };
        let (start, len) = self
            .streams
            .remove(&(container, 0))
            .ok_or_else(|| corrupt("PDF object stream has no data"))?;
        let content = self.reader.stream_content(&stream.dict, start, len)?;
        let mut dict = stream.dict;
        dict.remove(b"Filter");
        dict.remove(b"DecodeParms");
        Ok(lopdf::ObjectStream::new(&Stream::new(dict, content))?.objects)
    }
}

#[derive(Debug)]
enum ParseFailure {
    /// The window ended inside the object.
    Incomplete,
    Invalid,
}
use ParseFailure::{Incomplete, Invalid};
type ParseResult<T> = std::result::Result<T, ParseFailure>;

/// A PDF object parser over a window of the file, with lopdf's value rules.
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> ParseResult<u8> {
        self.bytes.get(self.pos).copied().ok_or(Incomplete)
    }

    fn skip_space(&mut self) {
        loop {
            while self
                .bytes
                .get(self.pos)
                .is_some_and(|byte| is_pdf_whitespace(*byte))
            {
                self.pos += 1;
            }
            if self.bytes.get(self.pos) != Some(&b'%') {
                return;
            }
            while self
                .bytes
                .get(self.pos)
                .is_some_and(|byte| !matches!(byte, b'\r' | b'\n'))
            {
                self.pos += 1;
            }
        }
    }

    /// The next run of regular characters, which must end inside the window.
    fn token(&mut self) -> ParseResult<&'a [u8]> {
        self.skip_space();
        let start = self.pos;
        while !is_pdf_whitespace(self.peek()?) && !is_pdf_delimiter(self.peek()?) {
            self.pos += 1;
        }
        Ok(&self.bytes[start..self.pos])
    }

    /// Consumes `word` when it is the next token.
    fn keyword(&mut self, word: &[u8]) -> ParseResult<bool> {
        let start = self.pos;
        if self.token()? == word {
            return Ok(true);
        }
        self.pos = start;
        Ok(false)
    }

    fn unsigned(&mut self) -> ParseResult<u64> {
        let token = self.token()?;
        if token.is_empty() || !token.iter().all(u8::is_ascii_digit) {
            return Err(Invalid);
        }
        std::str::from_utf8(token)
            .ok()
            .and_then(|text| text.parse().ok())
            .ok_or(Invalid)
    }

    /// After `stream`: spaces, then one end of line.
    fn stream_data_start(&mut self) -> ParseResult<usize> {
        while matches!(self.peek()?, b' ' | b'\t') {
            self.pos += 1;
        }
        match self.peek()? {
            b'\n' => self.pos += 1,
            b'\r' => {
                self.pos += 1;
                if self.peek()? == b'\n' {
                    self.pos += 1;
                }
            }
            _ => return Err(Invalid),
        }
        Ok(self.pos)
    }

    fn object(&mut self, depth: usize) -> ParseResult<Object> {
        if depth > MAX_PDF_STRUCTURAL_NESTING {
            return Err(Invalid);
        }
        self.skip_space();
        match self.peek()? {
            b'/' => Ok(Object::Name(self.name()?)),
            b'(' => Ok(Object::string_literal(self.literal_string()?)),
            b'<' if self.bytes.get(self.pos + 1).ok_or(Incomplete)? == &b'<' => {
                self.pos += 2;
                let mut dictionary = Dictionary::new();
                loop {
                    self.skip_space();
                    match self.peek()? {
                        b'>' if *self.bytes.get(self.pos + 1).ok_or(Incomplete)? == b'>' => {
                            self.pos += 2;
                            return Ok(Object::Dictionary(dictionary));
                        }
                        b'/' => {
                            let key = self.name()?;
                            let value = self.object(depth + 1)?;
                            dictionary.set(key, value);
                        }
                        _ => return Err(Invalid),
                    }
                }
            }
            b'<' => self.hex_string(),
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_space();
                    if self.peek()? == b']' {
                        self.pos += 1;
                        return Ok(Object::Array(items));
                    }
                    items.push(self.object(depth + 1)?);
                }
            }
            _ => self.number_or_keyword(),
        }
    }

    fn number_or_keyword(&mut self) -> ParseResult<Object> {
        let token = self.token()?;
        match token {
            b"null" => return Ok(Object::Null),
            b"true" => return Ok(Object::Boolean(true)),
            b"false" => return Ok(Object::Boolean(false)),
            _ => {}
        }
        let text = std::str::from_utf8(token).map_err(|_| Invalid)?;
        let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
        if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
            if let Ok(value) = text.parse::<i64>() {
                if digits.len() == text.len() {
                    if let Some(reference) = self.reference_tail(value)? {
                        return Ok(reference);
                    }
                }
                return Ok(Object::Integer(value));
            }
        }
        let (whole, fraction) = digits.split_once('.').ok_or(Invalid)?;
        if whole.len() + fraction.len() == 0
            || !whole
                .bytes()
                .chain(fraction.bytes())
                .all(|byte| byte.is_ascii_digit())
        {
            return Err(Invalid);
        }
        text.parse::<f32>().map(Object::Real).map_err(|_| Invalid)
    }

    /// `G R` after an object number makes a reference.
    fn reference_tail(&mut self, number: i64) -> ParseResult<Option<Object>> {
        let start = self.pos;
        self.skip_space();
        if self.peek()?.is_ascii_digit() {
            let generation = self.token()?;
            if generation.iter().all(u8::is_ascii_digit) && self.keyword(b"R")? {
                let generation = std::str::from_utf8(generation)
                    .ok()
                    .and_then(|text| text.parse::<u16>().ok());
                if let (Ok(number), Some(generation)) = (u32::try_from(number), generation) {
                    return Ok(Some(Object::Reference((number, generation))));
                }
            }
        }
        self.pos = start;
        Ok(None)
    }

    fn name(&mut self) -> ParseResult<Vec<u8>> {
        self.pos += 1;
        let mut name = Vec::new();
        loop {
            let byte = self.peek()?;
            if is_pdf_whitespace(byte) || is_pdf_delimiter(byte) {
                return Ok(name);
            }
            self.pos += 1;
            let escaped = (byte == b'#')
                .then(|| self.bytes.get(self.pos..self.pos + 2))
                .flatten()
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok());
            match escaped {
                Some(value) => {
                    self.pos += 2;
                    name.push(value);
                }
                None => name.push(byte),
            }
        }
    }

    fn literal_string(&mut self) -> ParseResult<Vec<u8>> {
        self.pos += 1;
        let mut text = Vec::new();
        let mut depth = 1_usize;
        loop {
            let byte = self.peek()?;
            self.pos += 1;
            match byte {
                b'\\' => {
                    let escaped = self.peek()?;
                    self.pos += 1;
                    match escaped {
                        b'0'..=b'7' => {
                            let mut value = u16::from(escaped - b'0');
                            for _ in 0..2 {
                                match self.peek()? {
                                    digit @ b'0'..=b'7' => {
                                        self.pos += 1;
                                        value = value * 8 + u16::from(digit - b'0');
                                    }
                                    _ => break,
                                }
                            }
                            text.push(value as u8);
                        }
                        b'\r' => {
                            if self.peek()? == b'\n' {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {}
                        b'n' => text.push(b'\n'),
                        b'r' => text.push(b'\r'),
                        b't' => text.push(b'\t'),
                        b'b' => text.push(0x08),
                        b'f' => text.push(0x0c),
                        other => text.push(other),
                    }
                }
                b'(' => {
                    depth += 1;
                    text.push(byte);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(text);
                    }
                    text.push(byte);
                }
                _ => text.push(byte),
            }
        }
    }

    fn hex_string(&mut self) -> ParseResult<Object> {
        self.pos += 1;
        let mut bytes = Vec::new();
        let mut high = None;
        loop {
            let byte = self.peek()?;
            self.pos += 1;
            let digit = match byte {
                b'>' => break,
                _ if is_pdf_whitespace(byte) => continue,
                _ => char::from(byte).to_digit(16).ok_or(Invalid)? as u8,
            };
            match high.take() {
                Some(high) => bytes.push(high << 4 | digit),
                None => high = Some(digit),
            }
        }
        if let Some(high) = high {
            bytes.push(high << 4);
        }
        Ok(Object::String(bytes, StringFormat::Hexadecimal))
    }
}
