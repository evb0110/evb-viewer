use fax::{encoder::Encoder as FaxEncoder, slice_bits, Color, VecWriter};
use jbig2_codec::{decode_pdf_generic, encode_pdf_generic, DecodeLimits, OwnedBilevel};

struct Fixture {
    name: &'static str,
    pbm: &'static [u8],
    reference: &'static [u8],
}

const FIXTURES: &[Fixture] = &[
    Fixture {
        name: "scan-page-000-body",
        pbm: include_bytes!("fixtures/scan-page-000-body.pbm"),
        reference: include_bytes!("fixtures/scan-page-000-body.jbig2"),
    },
    Fixture {
        name: "scan-page-002-body",
        pbm: include_bytes!("fixtures/scan-page-002-body.pbm"),
        reference: include_bytes!("fixtures/scan-page-002-body.jbig2"),
    },
    Fixture {
        name: "scan-page-007-notes",
        pbm: include_bytes!("fixtures/scan-page-007-notes.pbm"),
        reference: include_bytes!("fixtures/scan-page-007-notes.jbig2"),
    },
    Fixture {
        name: "scan-page-000-body-509",
        pbm: include_bytes!("fixtures/scan-page-000-body-509.pbm"),
        reference: include_bytes!("fixtures/scan-page-000-body-509.jbig2"),
    },
];

#[test]
fn decodes_checked_in_jbig2enc_streams_pixel_exactly() {
    for fixture in FIXTURES {
        let expected = parse_pbm(fixture.pbm);
        let decoded = decode_pdf_generic(fixture.reference, DecodeLimits::default())
            .unwrap_or_else(|error| panic!("{} failed to decode: {error}", fixture.name));
        assert_eq!(decoded, expected, "{} pixels differ", fixture.name);
    }
}

#[test]
fn matches_jbig2enc_embedded_streams_byte_for_byte() {
    for fixture in FIXTURES {
        let bitmap = parse_pbm(fixture.pbm);
        let encoded = encode_pdf_generic(bitmap.as_bilevel())
            .unwrap_or_else(|error| panic!("{} failed to encode: {error}", fixture.name));
        assert_eq!(
            encoded, fixture.reference,
            "{} differs from jbig2enc 0.30",
            fixture.name
        );
    }
}

#[test]
fn real_scan_crops_are_smaller_than_ccitt_group_4() {
    for fixture in FIXTURES {
        let bitmap = parse_pbm(fixture.pbm);
        let jbig2 = encode_pdf_generic(bitmap.as_bilevel()).unwrap();
        let g4 = encode_g4(&bitmap);
        eprintln!(
            "{}: JBIG2={} bytes, G4={} bytes",
            fixture.name,
            jbig2.len(),
            g4.len()
        );
        assert!(
            jbig2.len() < g4.len(),
            "{} JBIG2={} bytes, G4={} bytes",
            fixture.name,
            jbig2.len(),
            g4.len()
        );
    }
}

#[test]
#[ignore = "requires /opt/homebrew/bin/jbig2 and jbig2dec"]
fn differential_reference_tools_accept_and_reproduce_every_fixture() {
    use std::{
        fs,
        process::{Command, Stdio},
    };

    let directory = std::env::temp_dir().join(format!("jbig2-codec-{}", std::process::id()));
    if directory.exists() {
        fs::remove_dir_all(&directory).unwrap();
    }
    fs::create_dir(&directory).unwrap();

    for fixture in FIXTURES {
        let bitmap = parse_pbm(fixture.pbm);
        let embedded = encode_pdf_generic(bitmap.as_bilevel()).unwrap();
        let full_stream = wrap_sequential_file(&embedded);
        let input = directory.join(format!("{}.jb2", fixture.name));
        let decoded = directory.join(format!("{}.pbm", fixture.name));
        fs::write(&input, full_stream).unwrap();

        let status = Command::new("/opt/homebrew/bin/jbig2dec")
            .args(["-q", "-o"])
            .arg(&decoded)
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success(), "jbig2dec rejected {}", fixture.name);
        assert_eq!(
            parse_pbm(&fs::read(&decoded).unwrap()),
            bitmap,
            "jbig2dec changed {} pixels",
            fixture.name
        );

        let source = directory.join(format!("{}.source.pbm", fixture.name));
        fs::write(&source, fixture.pbm).unwrap();
        let regenerated = Command::new("/opt/homebrew/bin/jbig2")
            .args(["-d", "-p"])
            .arg(source)
            .stdout(Stdio::piped())
            .output()
            .expect("failed to run jbig2");
        assert!(regenerated.status.success());
        assert_eq!(
            regenerated.stdout, fixture.reference,
            "jbig2enc changed reference output for {}",
            fixture.name
        );
    }

    fs::remove_dir_all(directory).unwrap();
}

fn parse_pbm(data: &[u8]) -> OwnedBilevel {
    assert!(data.starts_with(b"P4\n"));
    let header_end = data
        .windows(1)
        .enumerate()
        .filter(|(_, byte)| byte[0] == b'\n')
        .nth(1)
        .map(|(index, _)| index + 1)
        .expect("P4 header");
    let dimensions = std::str::from_utf8(&data[3..header_end - 1]).unwrap();
    let mut dimensions = dimensions.split_ascii_whitespace();
    let width: u32 = dimensions.next().unwrap().parse().unwrap();
    let height: u32 = dimensions.next().unwrap().parse().unwrap();
    assert!(dimensions.next().is_none());
    let rows = data[header_end..].to_vec();
    assert_eq!(rows.len(), width.div_ceil(8) as usize * height as usize);
    OwnedBilevel {
        width,
        height,
        rows,
    }
}

fn encode_g4(bitmap: &OwnedBilevel) -> Vec<u8> {
    let width = u32::from(u16::try_from(bitmap.width).unwrap());
    let stride = bitmap.width.div_ceil(8) as usize;
    let writer = VecWriter::with_capacity(bitmap.rows.len() * 8);
    let mut encoder = FaxEncoder::new(writer);
    for row in bitmap.rows.chunks_exact(stride) {
        let colors = slice_bits(row).take(bitmap.width as usize).map(|bit| {
            if bit {
                Color::Black
            } else {
                Color::White
            }
        });
        encoder.encode_line(colors, width).unwrap();
    }
    encoder.finish().unwrap().finish()
}

fn wrap_sequential_file(embedded: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(13 + embedded.len() + 22);
    output.extend_from_slice(b"\x97JB2\r\n\x1a\n");
    output.push(1);
    output.extend_from_slice(&1u32.to_be_bytes());
    output.extend_from_slice(embedded);
    write_empty_segment(&mut output, 2, 49, 1);
    write_empty_segment(&mut output, 3, 51, 0);
    output
}

fn write_empty_segment(output: &mut Vec<u8>, number: u32, segment_type: u8, page: u8) {
    output.extend_from_slice(&number.to_be_bytes());
    output.push(segment_type);
    output.push(0);
    output.push(page);
    output.extend_from_slice(&0u32.to_be_bytes());
}
