//! Writes a document as one fresh revision. Dictionaries are serialized with
//! lopdf's syntax, each real as its source spelled it while it holds the number
//! read there; a stream held without its data is copied from its source byte
//! range.
use super::*;

/// The largest offset a classic cross-reference entry's ten digits hold.
const MAX_CLASSIC_XREF_OFFSET: u64 = 9_999_999_999;
/// Room left for dictionaries when stream bytes decide the xref form.
const DICTIONARY_BYTES_ALLOWANCE: u64 = 1 << 30;

struct Counting<W> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Writes `document`; `raw(id)` names the source range of a stream that the
/// document holds as a dictionary with an empty body, and `spelling(id, path,
/// value)` the source token of the real at `path` in object `id`.
pub(crate) fn write_document<'a, 's, S: ByteSource + 'a, W: Write>(
    document: &Document,
    raw: impl Fn(ObjectId) -> Option<(&'a S, u64, u64)>,
    spelling: impl Fn(ObjectId, &[u8], f32) -> Option<&'s str>,
    output: W,
) -> Result<W> {
    let stream_len = |id: &ObjectId, stream: &Stream| match raw(*id) {
        Some((_, _, len)) if stream.content.is_empty() => len,
        _ => stream.content.len() as u64,
    };
    let stream_bytes = document
        .objects
        .iter()
        .filter_map(|(id, object)| object.as_stream().ok().map(|stream| stream_len(id, stream)))
        .sum::<u64>();
    let xref_stream = stream_bytes + DICTIONARY_BYTES_ALLOWANCE > MAX_CLASSIC_XREF_OFFSET;
    let version = if xref_stream && document.version.as_str() < "1.5" {
        "1.5"
    } else {
        document.version.as_str()
    };
    let mut out = Counting {
        inner: output,
        written: 0,
    };
    writeln!(out, "%PDF-{version}")?;
    out.write_all(b"%\xE2\xE3\xCF\xD3\n")?;
    let mut offsets = Vec::with_capacity(document.objects.len() + 1);
    let mut path = Vec::new();
    for (id, object) in &document.objects {
        let real = |path: &[u8], value| spelling(*id, path, value);
        offsets.push((*id, out.written));
        writeln!(out, "{} {} obj", id.0, id.1)?;
        if let Object::Stream(stream) = object {
            let mut dictionary = stream.dict.clone();
            dictionary.set("Length", i64::try_from(stream_len(id, stream))?);
            write_dictionary(&mut out, &dictionary, &mut path, &real)?;
            out.write_all(b"stream\n")?;
            match raw(*id).filter(|_| stream.content.is_empty()) {
                Some((source, offset, len)) => {
                    source.copy_range(offset, len, &mut out.inner)?;
                    out.written += len;
                }
                None => out.write_all(&stream.content)?,
            }
            out.write_all(b"\nendstream")?;
        } else {
            write_object(&mut out, object, &mut path, &real)?;
        }
        out.write_all(b"\nendobj\n")?;
    }
    let size = document
        .max_id
        .max(offsets.last().map_or(0, |(id, _)| id.0))
        + 1;
    let xref_offset = out.written;
    let mut trailer = Dictionary::new();
    for key in [b"Root".as_slice(), b"Info", b"ID"] {
        if let Ok(value) = document.trailer.get(key) {
            trailer.set(key.to_vec(), value.clone());
        }
    }
    if xref_stream {
        offsets.push(((size, 0), xref_offset));
        let mut content = Vec::with_capacity((offsets.len() + 1) * 11);
        content.extend_from_slice(&[0; 9]);
        content.extend_from_slice(&u16::MAX.to_be_bytes());
        let mut index = vec![Object::Integer(0), Object::Integer(1)];
        for run in consecutive_object_runs(&offsets) {
            index.extend([
                Object::Integer(i64::from(run[0].0 .0)),
                Object::Integer(run.len() as i64),
            ]);
            for (id, offset) in run {
                content.push(1);
                content.extend_from_slice(&offset.to_be_bytes());
                content.extend_from_slice(&id.1.to_be_bytes());
            }
        }
        trailer.set("Type", Object::Name(b"XRef".to_vec()));
        trailer.set("Size", i64::from(size) + 1);
        trailer.set("W", vec![1.into(), 8.into(), 2.into()]);
        trailer.set("Index", index);
        trailer.set("Length", content.len() as i64);
        writeln!(out, "{size} 0 obj")?;
        write_dictionary(&mut out, &trailer, &mut path, &|_, _| None)?;
        out.write_all(b"stream\n")?;
        out.write_all(&content)?;
        out.write_all(b"\nendstream\nendobj\n")?;
    } else {
        if xref_offset > MAX_CLASSIC_XREF_OFFSET {
            return Err(domain_error(
                NativeErrorCode::TooLarge,
                "PDF output outgrew its classic cross-reference table",
            ));
        }
        out.write_all(b"xref\n0 1\n0000000000 65535 f \n")?;
        for run in consecutive_object_runs(&offsets) {
            writeln!(out, "{} {}", run[0].0 .0, run.len())?;
            for (id, offset) in run {
                writeln!(out, "{offset:010} {:05} n ", id.1)?;
            }
        }
        trailer.set("Size", i64::from(size));
        out.write_all(b"trailer\n")?;
        write_dictionary(&mut out, &trailer, &mut path, &|_, _| None)?;
        out.write_all(b"\n")?;
    }
    write!(out, "startxref\n{xref_offset}\n%%EOF\n")?;
    out.flush()?;
    Ok(out.inner)
}

fn need_separator(object: &Object) -> bool {
    matches!(
        object,
        Object::Null
            | Object::Boolean(_)
            | Object::Integer(_)
            | Object::Real(_)
            | Object::Reference(_)
    )
}

/// How the source spelled the real at a path of the object being written.
type Spelling<'r, 's> = &'r dyn Fn(&[u8], f32) -> Option<&'s str>;

fn write_object(
    out: &mut impl Write,
    object: &Object,
    path: &mut Vec<u8>,
    real: Spelling,
) -> Result<()> {
    match object {
        Object::Null => out.write_all(b"null")?,
        Object::Boolean(value) => out.write_all(if *value { b"true" } else { b"false" })?,
        Object::Integer(value) => write!(out, "{value}")?,
        Object::Real(value) => match real(path, *value) {
            Some(text) => out.write_all(text.as_bytes())?,
            None => write!(out, "{value}")?,
        },
        Object::Name(name) => write_name(out, name)?,
        Object::String(text, StringFormat::Literal) => write_literal_string(out, text)?,
        Object::String(text, StringFormat::Hexadecimal) => {
            out.write_all(b"<")?;
            for byte in text {
                write!(out, "{byte:02X}")?;
            }
            out.write_all(b">")?;
        }
        Object::Array(items) => {
            out.write_all(b"[")?;
            for (index, item) in items.iter().enumerate() {
                if index > 0 && need_separator(item) {
                    out.write_all(b" ")?;
                }
                let mark = path.len();
                path_index(path, index);
                write_object(out, item, path, real)?;
                path.truncate(mark);
            }
            out.write_all(b"]")?;
        }
        Object::Dictionary(dictionary) => write_dictionary(out, dictionary, path, real)?,
        Object::Stream(_) => return Err("A stream cannot be written as a direct object".into()),
        Object::Reference(id) => write!(out, "{} {} R", id.0, id.1)?,
    }
    Ok(())
}

fn write_dictionary(
    out: &mut impl Write,
    dictionary: &Dictionary,
    path: &mut Vec<u8>,
    real: Spelling,
) -> Result<()> {
    out.write_all(b"<<")?;
    for (key, value) in dictionary.iter() {
        write_name(out, key)?;
        if need_separator(value) {
            out.write_all(b" ")?;
        }
        let mark = path.len();
        path_key(path, key);
        write_object(out, value, path, real)?;
        path.truncate(mark);
    }
    out.write_all(b">>")?;
    Ok(())
}

fn write_name(out: &mut impl Write, name: &[u8]) -> std::io::Result<()> {
    out.write_all(b"/")?;
    for &byte in name {
        if b" \t\n\r\x0C()<>[]{}/%#".contains(&byte) || !(33..=126).contains(&byte) {
            write!(out, "#{byte:02X}")?;
        } else {
            out.write_all(&[byte])?;
        }
    }
    Ok(())
}

/// lopdf's literal form: backslashes, carriage returns and unbalanced
/// parentheses are escaped.
fn write_literal_string(out: &mut impl Write, text: &[u8]) -> std::io::Result<()> {
    let mut escaped = vec![false; text.len()];
    let mut open = Vec::new();
    for (index, byte) in text.iter().enumerate() {
        match byte {
            b'(' => open.push(index),
            b')' => {
                if open.pop().is_none() {
                    escaped[index] = true;
                }
            }
            b'\\' | b'\r' => escaped[index] = true,
            _ => {}
        }
    }
    for index in open {
        escaped[index] = true;
    }
    out.write_all(b"(")?;
    for (byte, escape) in text.iter().zip(escaped) {
        if escape {
            out.write_all(b"\\")?;
            out.write_all(&[if *byte == b'\r' { b'r' } else { *byte }])?;
        } else {
            out.write_all(&[*byte])?;
        }
    }
    out.write_all(b")")
}
