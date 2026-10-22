"""Regenerate optimize-typeset-photo.pdf with Python 3 and Pillow.

One base-14 Helvetica text page and a 1200x900, quality-96 RGB JPEG drawn at
144x108 points (600 DPI). The smooth color field and mild deterministic texture
make a compact photo surrogate without external/copyrighted source material.
"""
from io import BytesIO
from pathlib import Path

from PIL import Image

width, height = 1200, 900
pixels = bytearray()
for y in range(height):
    for x in range(width):
        texture = (x * 17 + y * 31 + x * y % 23) % 13
        pixels.extend((
            30 + x * 160 // width + texture,
            40 + y * 150 // height + texture,
            50 + (x + y) * 120 // (width + height) + texture,
        ))
image = BytesIO()
Image.frombytes("RGB", (width, height), bytes(pixels)).save(
    image, format="JPEG", quality=96, subsampling=2, optimize=True,
)
jpeg = image.getvalue()
content = b"""BT /F1 22 Tf 50 730 Td (A typeset book with a photograph) Tj ET
BT /F1 12 Tf 50 700 Td (This is visible, searchable text, not a rasterized scan.) Tj ET
BT /F1 12 Tf 50 680 Td (Optimizing the photograph must preserve every word.) Tj ET
q 144 0 0 108 50 520 cm /Photo Do Q
BT /F1 12 Tf 50 495 Td (Figure 1. A smooth color field with mild texture.) Tj ET
"""
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
    b"/Resources << /Font << /F1 4 0 R >> /XObject << /Photo 5 0 R >> >> /Contents 6 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    (f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
     f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(jpeg)} >>\nstream\n").encode()
    + jpeg + b"\nendstream",
    f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream",
]
pdf = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
offsets = [0]
for number, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
xref = len(pdf)
pdf.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode())
pdf.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
assert len(pdf) < 400_000, len(pdf)
path = Path(__file__).with_name("optimize-typeset-photo.pdf")
path.write_bytes(pdf)
print(f"{path}: {len(pdf)} bytes")
