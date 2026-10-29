#!/usr/bin/env python3
"""Rendered-photo and embedded-mask metrics for scan-cleanup acceptance runs.

Photo measurements deliberately use rendered PDF pages. Measuring an extracted
MRC plate is incorrect because pixels outside an affine soft mask are commonly
decoded as black. Stroke measurements deliberately select a page's full-DPI,
one-bit JBIG2 row from ``pdfimages -list`` and decode that exact stream. This
avoids silently grading a different same-size image on layered pages.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


@dataclass(frozen=True)
class PdfImage:
    page: int
    number: int
    extraction_index: int
    image_type: str
    width: int
    height: int
    bits_per_component: int
    encoding: str
    object_id: int
    x_dpi: int
    y_dpi: int


@dataclass(frozen=True)
class ToneMetrics:
    near_white_fraction: float
    mean_luminance: float


def run(command: Sequence[str]) -> None:
    subprocess.run(
        command,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def run_text(command: Sequence[str]) -> str:
    return subprocess.run(
        command,
        check=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout


def require_executable(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"{name} is required for scan-cleanup metrics")
    return executable


def parse_pages(value: str) -> list[int]:
    pages: set[int] = set()
    for raw_part in value.split(","):
        part = raw_part.strip()
        if not part:
            continue
        if "-" in part:
            first_text, last_text = part.split("-", 1)
            first = int(first_text)
            last = int(last_text)
            if first < 1 or last < first:
                raise ValueError(f"invalid page range: {part}")
            pages.update(range(first, last + 1))
        else:
            page = int(part)
            if page < 1:
                raise ValueError(f"invalid page number: {part}")
            pages.add(page)
    return sorted(pages)


def parse_pdfimages_listing(output: str) -> list[PdfImage]:
    images: list[PdfImage] = []
    for line in output.splitlines():
        parts = line.strip().split()
        if len(parts) < 14 or not parts[0].isdigit() or not parts[1].isdigit():
            continue
        images.append(
            PdfImage(
                page=int(parts[0]),
                number=int(parts[1]),
                extraction_index=len(images),
                image_type=parts[2],
                width=int(parts[3]),
                height=int(parts[4]),
                bits_per_component=int(parts[7]),
                encoding=parts[8].lower(),
                object_id=int(parts[10]),
                x_dpi=int(parts[12]),
                y_dpi=int(parts[13]),
            )
        )
    return images


def select_full_resolution_jbig2_mask(images: Sequence[PdfImage]) -> PdfImage | None:
    """Return the unique full-resolution 1-bit JBIG2 mask, never a size guess."""

    masks = [
        image
        for image in images
        if image.bits_per_component == 1 and image.encoding == "jbig2"
    ]
    if not masks:
        return None
    maximum_x_dpi = max(image.x_dpi for image in masks)
    maximum_y_dpi = max(image.y_dpi for image in masks)
    full_resolution = [
        image
        for image in masks
        if image.x_dpi == maximum_x_dpi and image.y_dpi == maximum_y_dpi
    ]
    if len(full_resolution) != 1:
        descriptions = ", ".join(
            f"{image.image_type} object {image.object_id} "
            f"{image.width}x{image.height}@{image.x_dpi}x{image.y_dpi}dpi"
            for image in full_resolution
        )
        raise RuntimeError(
            "page has multiple full-resolution 1-bit JBIG2 masks; "
            f"refusing to guess: {descriptions}"
        )
    return full_resolution[0]


def luminance_metrics(image: Image.Image) -> ToneMetrics:
    gray = image.convert("L")
    histogram = gray.histogram()
    pixel_count = max(1, gray.width * gray.height)
    return ToneMetrics(
        near_white_fraction=sum(histogram[250:]) / pixel_count,
        mean_luminance=(
            sum(level * count for level, count in enumerate(histogram)) / pixel_count
        ),
    )


def tile_near_white_deltas(
    expected: Image.Image,
    actual: Image.Image,
    tile_size: int,
) -> list[float]:
    if expected.size != actual.size:
        raise ValueError(
            f"tile inputs must have identical dimensions: {expected.size} != {actual.size}"
        )
    if tile_size < 1:
        raise ValueError("tile size must be positive")
    deltas: list[float] = []
    for top in range(0, expected.height, tile_size):
        for left in range(0, expected.width, tile_size):
            box = (
                left,
                top,
                min(expected.width, left + tile_size),
                min(expected.height, top + tile_size),
            )
            expected_white = luminance_metrics(expected.crop(box)).near_white_fraction
            actual_white = luminance_metrics(actual.crop(box)).near_white_fraction
            deltas.append(abs(actual_white - expected_white))
    return deltas


def stroke_metrics(mask: Image.Image) -> tuple[float, float | None]:
    gray = mask.convert("L")
    pixel_count = max(1, gray.width * gray.height)
    black_fraction = sum(gray.histogram()[:128]) / pixel_count
    # Some producers attach a reversed Decode array. Normalize only when the
    # decoded page is predominantly black; book-page masks are sparse ink.
    if black_fraction > 0.5:
        gray = ImageOps.invert(gray)
        black_fraction = sum(gray.histogram()[:128]) / pixel_count
    if black_fraction == 0:
        return 0.0, None
    eroded = gray.filter(ImageFilter.MaxFilter(3))
    eroded_black_fraction = sum(eroded.histogram()[:128]) / pixel_count
    return black_fraction * 100, eroded_black_fraction / black_fraction * 100


def normalize_sparse_mask(mask: Image.Image) -> Image.Image:
    gray = mask.convert("L")
    pixel_count = max(1, gray.width * gray.height)
    black_fraction = sum(gray.histogram()[:128]) / pixel_count
    return ImageOps.invert(gray) if black_fraction > 0.5 else gray


def exact_mask_difference(original: Image.Image, candidate: Image.Image) -> int:
    expected = normalize_sparse_mask(original)
    actual = normalize_sparse_mask(candidate)
    if expected.size != actual.size:
        raise ValueError(
            f"mask dimensions differ: {expected.size} != {actual.size}"
        )
    histogram = ImageChops.difference(expected, actual).histogram()
    return sum(histogram[1:])


def render_page(pdf: Path, page: int, dpi: int, destination: Path) -> Image.Image:
    destination.mkdir(parents=True, exist_ok=True)
    prefix = destination / f"page-{page}"
    run(
        [
            require_executable("pdftoppm"),
            "-cropbox",
            "-r",
            str(dpi),
            "-f",
            str(page),
            "-l",
            str(page),
            "-singlefile",
            "-png",
            str(pdf),
            str(prefix),
        ]
    )
    path = prefix.with_suffix(".png")
    with Image.open(path) as image:
        return image.convert("RGB")


def parse_box(row: dict[str, str]) -> tuple[str, tuple[float, float, float, float]]:
    raw_box = row.get("bbox") or row.get("bbox_at_box_dpi")
    if not raw_box:
        raise ValueError("boxes CSV must contain bbox or bbox_at_box_dpi")
    values = tuple(float(value.strip()) for value in raw_box.split(","))
    if len(values) != 4:
        raise ValueError(f"bbox must contain four comma-separated values: {raw_box}")
    left, top, right, bottom = values
    if left < 0 or top < 0 or right <= left or bottom <= top:
        raise ValueError(f"invalid bbox: {raw_box}")
    return raw_box, values


def scaled_box(
    box: tuple[float, float, float, float], scale: float
) -> tuple[int, int, int, int]:
    left, top, right, bottom = box
    return (
        round(left * scale),
        round(top * scale),
        round(right * scale),
        round(bottom * scale),
    )


def _positive_number(value: object, field: str, label: str) -> float:
    if not isinstance(value, (int, float)) or value <= 0:
        raise ValueError(f"{label} geometry has invalid {field}: {value!r}")
    return float(value)


def _finite_number(value: object, field: str, label: str) -> float:
    if not isinstance(value, (int, float)):
        raise ValueError(f"{label} geometry has invalid {field}: {value!r}")
    return float(value)


def source_box_to_candidate_affine(
    candidate: Image.Image,
    source_size: tuple[int, int],
    source_box: tuple[int, int, int, int],
    geometry: dict[str, object],
    label: str,
) -> tuple[float, float, float, float, float, float]:
    """Map a source-box-local pixel to the matching candidate render pixel.

    ``forwardTransform`` maps the source input grid into the intrinsic cleanup
    raster. A final conversion can then resize that raster for the matched
    canvas and place it inside the published page. Poppler can introduce a
    fractional-pixel page-size rounding at the requested render DPI, so the
    last scale is derived from the actual rendered candidate dimensions.
    """

    if geometry.get("dewarped") is not False:
        raise ValueError(
            f"{label} page is dewarped; an affine photo comparison is unavailable"
        )
    forward = geometry.get("forwardTransform")
    matrix = forward.get("matrix") if isinstance(forward, dict) else None
    if (
        not isinstance(matrix, list)
        or len(matrix) < 2
        or not isinstance(matrix[0], list)
        or not isinstance(matrix[1], list)
        or len(matrix[0]) < 3
        or len(matrix[1]) < 3
    ):
        raise ValueError(f"{label} geometry has no usable forwardTransform")

    input_width = _positive_number(geometry.get("inputWidthPx"), "inputWidthPx", label)
    input_height = _positive_number(geometry.get("inputHeightPx"), "inputHeightPx", label)
    canvas_width = _positive_number(geometry.get("canvasWidthPx"), "canvasWidthPx", label)
    canvas_height = _positive_number(geometry.get("canvasHeightPx"), "canvasHeightPx", label)
    intrinsic_width = _positive_number(geometry.get("outputWidthPx"), "outputWidthPx", label)
    intrinsic_height = _positive_number(geometry.get("outputHeightPx"), "outputHeightPx", label)
    content_width = _positive_number(
        geometry.get("matchedCanvasContentWidthPx", geometry.get("outputWidthPx")),
        "matchedCanvasContentWidthPx",
        label,
    )
    content_height = _positive_number(
        geometry.get("matchedCanvasContentHeightPx", geometry.get("outputHeightPx")),
        "matchedCanvasContentHeightPx",
        label,
    )
    placement_x = _finite_number(geometry.get("placementOffsetXPx"), "placementOffsetXPx", label)
    placement_y = _finite_number(geometry.get("placementOffsetYPx"), "placementOffsetYPx", label)
    a, b, c = (
        _finite_number(value, f"forwardTransform.matrix[0][{index}]", label)
        for index, value in enumerate(matrix[0][:3])
    )
    d, e, f = (
        _finite_number(value, f"forwardTransform.matrix[1][{index}]", label)
        for index, value in enumerate(matrix[1][:3])
    )

    input_scale_x = input_width / source_size[0]
    input_scale_y = input_height / source_size[1]
    match_scale_x = content_width / intrinsic_width
    match_scale_y = content_height / intrinsic_height
    canvas_scale_x = candidate.width / canvas_width
    canvas_scale_y = candidate.height / canvas_height
    mapped_a = canvas_scale_x * match_scale_x * a * input_scale_x
    mapped_b = canvas_scale_x * match_scale_x * b * input_scale_y
    mapped_c = canvas_scale_x * (placement_x + match_scale_x * c)
    mapped_d = canvas_scale_y * match_scale_y * d * input_scale_x
    mapped_e = canvas_scale_y * match_scale_y * e * input_scale_y
    mapped_f = canvas_scale_y * (placement_y + match_scale_y * f)
    left, top, _, _ = source_box
    return (
        mapped_a,
        mapped_b,
        mapped_a * left + mapped_b * top + mapped_c,
        mapped_d,
        mapped_e,
        mapped_d * left + mapped_e * top + mapped_f,
    )


def crop_aligned_to_source(
    candidate: Image.Image,
    source_size: tuple[int, int],
    source_box: tuple[int, int, int, int],
    geometry: dict[str, object],
    label: str,
) -> Image.Image:
    width = source_box[2] - source_box[0]
    height = source_box[3] - source_box[1]
    affine = source_box_to_candidate_affine(
        candidate, source_size, source_box, geometry, label
    )
    return candidate.transform(
        (width, height),
        Image.Transform.AFFINE,
        affine,
        resample=Image.Resampling.BICUBIC,
        fillcolor="white",
    )


def load_render_geometry(
    summary_path: Path,
    label: str,
) -> dict[int, tuple[int, dict[str, object]]]:
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ValueError(f"could not read {label} summary {summary_path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"could not parse {label} summary {summary_path}: {error}") from error
    rows = summary.get("perPageStreamSizes")
    if not isinstance(rows, list):
        representation = summary.get("representation")
        rows = representation.get("pages") if isinstance(representation, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"{label} summary {summary_path} has no per-page geometry rows")
    result: dict[int, tuple[int, dict[str, object]]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        source_page = row.get("sourcePageNumber", row.get("sourcePage"))
        output_page = row.get("outputPageNumber", row.get("outputPage"))
        geometry = row.get("renderGeometry")
        if (
            not isinstance(source_page, int)
            or source_page < 1
            or not isinstance(output_page, int)
            or output_page < 1
            or not isinstance(geometry, dict)
        ):
            continue
        if source_page in result:
            raise ValueError(
                f"{label} summary maps source page {source_page} to multiple output pages; "
                "photo-box comparison requires a single affine output"
            )
        result[source_page] = (output_page, geometry)
    if not result:
        raise ValueError(f"{label} summary {summary_path} contains no usable renderGeometry")
    return result


def resolve_summary_path(pdf: Path, explicit: Path | None, label: str) -> Path:
    path = explicit if explicit is not None else Path(f"{pdf}.summary.json")
    if not path.is_file():
        raise ValueError(
            f"{label} summary is required for physical crop alignment: {path}; "
            f"pass --{label}-summary"
        )
    return path


def write_comparison_crop(
    path: Path,
    panes: Sequence[tuple[str, Image.Image]],
) -> None:
    label_height = 28
    border = 2
    width = sum(image.width for _, image in panes) + border * (len(panes) - 1)
    height = max(image.height for _, image in panes) + label_height
    comparison = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(comparison)
    left = 0
    for index, (label, pane) in enumerate(panes):
        draw.text((left + 6, 7), label, fill="black")
        comparison.paste(pane, (left, label_height))
        left += pane.width
        if index + 1 < len(panes):
            comparison.paste((0, 0, 0), (left, 0, left + border, height))
            left += border
    comparison.save(path)


PHOTO_FIELDS = [
    "page",
    "reference_page",
    "output_page",
    "bbox_at_box_dpi",
    "source_near_white_fraction",
    "reference_near_white_fraction",
    "output_near_white_fraction",
    "output_minus_source_near_white",
    "output_minus_reference_near_white",
    "source_mean_luminance",
    "reference_mean_luminance",
    "output_mean_luminance",
    "output_minus_source_mean",
    "output_minus_reference_mean",
    "max_tile_near_white_delta_vs_source",
    "tiles_over_limit_vs_source",
    "max_tile_near_white_delta_vs_reference",
    "tiles_over_limit_vs_reference",
    "tile_limit",
    "tile_count",
]


def photo_metrics(args: argparse.Namespace) -> None:
    if args.render_dpi < 1 or args.box_dpi < 1:
        raise ValueError("render and bbox DPI must be positive")
    if args.tile_size < 1:
        raise ValueError("tile size must be positive")
    args.csv.parent.mkdir(parents=True, exist_ok=True)
    if args.crops is not None:
        args.crops.mkdir(parents=True, exist_ok=True)
    with args.boxes.open(newline="", encoding="utf-8") as handle:
        boxes = list(csv.DictReader(handle))
    output_geometry = load_render_geometry(
        resolve_summary_path(args.output, args.output_summary, "output"),
        "output",
    )
    reference_geometry = (
        load_render_geometry(
            resolve_summary_path(args.reference, args.reference_summary, "reference"),
            "reference",
        )
        if args.reference is not None
        else None
    )
    scale = args.render_dpi / args.box_dpi
    with tempfile.TemporaryDirectory(prefix="evb-rendered-photo-") as temporary:
        scratch = Path(temporary)
        with args.csv.open("w", newline="", encoding="utf-8") as output_handle:
            writer = csv.DictWriter(output_handle, fieldnames=PHOTO_FIELDS)
            writer.writeheader()
            for row_index, row in enumerate(boxes, start=1):
                page = int(row["page"])
                raw_box, box_at_box_dpi = parse_box(row)
                source_box = scaled_box(box_at_box_dpi, scale)
                page_dir = scratch / f"page-{page}-box-{row_index}"
                page_dir.mkdir()
                source = render_page(args.source, page, args.render_dpi, page_dir / "source")
                if (
                    source_box[2] > source.width
                    or source_box[3] > source.height
                ):
                    raise ValueError(
                        f"page {page}: bbox {source_box} exceeds source render {source.size}"
                    )
                source_crop = source.crop(source_box)
                try:
                    output_page, output_page_geometry = output_geometry[page]
                except KeyError as error:
                    raise ValueError(
                        f"output summary has no affine geometry for source page {page}"
                    ) from error
                output = render_page(
                    args.output,
                    output_page,
                    args.render_dpi,
                    page_dir / "output",
                )
                output_crop = crop_aligned_to_source(
                    output,
                    source.size,
                    source_box,
                    output_page_geometry,
                    f"output page {output_page}",
                )
                reference_crop: Image.Image | None = None
                reference_page: int | None = None
                if args.reference is not None:
                    assert reference_geometry is not None
                    try:
                        reference_page, reference_page_geometry = reference_geometry[page]
                    except KeyError as error:
                        raise ValueError(
                            f"reference summary has no affine geometry for source page {page}"
                        ) from error
                    reference = render_page(
                        args.reference,
                        reference_page,
                        args.render_dpi,
                        page_dir / "reference",
                    )
                    reference_crop = crop_aligned_to_source(
                        reference,
                        source.size,
                        source_box,
                        reference_page_geometry,
                        f"reference page {reference_page}",
                    )
                source_tone = luminance_metrics(source_crop)
                output_tone = luminance_metrics(output_crop)
                source_tile_deltas = tile_near_white_deltas(
                    source_crop, output_crop, args.tile_size
                )
                reference_tone = (
                    luminance_metrics(reference_crop)
                    if reference_crop is not None
                    else None
                )
                reference_tile_deltas = (
                    tile_near_white_deltas(
                        reference_crop, output_crop, args.tile_size
                    )
                    if reference_crop is not None
                    else []
                )
                writer.writerow(
                    {
                        "page": page,
                        "reference_page": reference_page or "",
                        "output_page": output_page,
                        "bbox_at_box_dpi": raw_box,
                        "source_near_white_fraction": f"{source_tone.near_white_fraction:.6f}",
                        "reference_near_white_fraction": (
                            f"{reference_tone.near_white_fraction:.6f}"
                            if reference_tone is not None
                            else ""
                        ),
                        "output_near_white_fraction": f"{output_tone.near_white_fraction:.6f}",
                        "output_minus_source_near_white": (
                            format(
                                output_tone.near_white_fraction
                                - source_tone.near_white_fraction,
                                ".6f",
                            )
                        ),
                        "output_minus_reference_near_white": (
                            format(
                                output_tone.near_white_fraction
                                - reference_tone.near_white_fraction,
                                ".6f",
                            )
                            if reference_tone is not None
                            else ""
                        ),
                        "source_mean_luminance": f"{source_tone.mean_luminance:.3f}",
                        "reference_mean_luminance": (
                            f"{reference_tone.mean_luminance:.3f}"
                            if reference_tone is not None
                            else ""
                        ),
                        "output_mean_luminance": f"{output_tone.mean_luminance:.3f}",
                        "output_minus_source_mean": (
                            f"{output_tone.mean_luminance - source_tone.mean_luminance:.3f}"
                        ),
                        "output_minus_reference_mean": (
                            f"{output_tone.mean_luminance - reference_tone.mean_luminance:.3f}"
                            if reference_tone is not None
                            else ""
                        ),
                        "max_tile_near_white_delta_vs_source": (
                            f"{max(source_tile_deltas, default=0.0):.6f}"
                        ),
                        "tiles_over_limit_vs_source": sum(
                            delta > args.tile_limit for delta in source_tile_deltas
                        ),
                        "max_tile_near_white_delta_vs_reference": (
                            f"{max(reference_tile_deltas):.6f}"
                            if reference_tile_deltas
                            else ""
                        ),
                        "tiles_over_limit_vs_reference": (
                            sum(
                                delta > args.tile_limit
                                for delta in reference_tile_deltas
                            )
                            if reference_crop is not None
                            else ""
                        ),
                        "tile_limit": f"{args.tile_limit:.6f}",
                        "tile_count": len(source_tile_deltas),
                    }
                )
                if args.crops is not None:
                    panes = [("source", source_crop)]
                    labels = ["source"]
                    if reference_crop is not None:
                        panes.append(("reference", reference_crop))
                        labels.append("reference")
                    panes.append(("output", output_crop))
                    labels.append("output")
                    write_comparison_crop(
                        args.crops
                        / f"photo-{page:03d}-box-{row_index:03d}-{'-'.join(labels)}.png",
                        panes,
                    )


def decoded_page_mask(pdf: Path, page: int, scratch: Path) -> tuple[PdfImage, Image.Image] | None:
    pdfimages = require_executable("pdfimages")
    listing = parse_pdfimages_listing(
        run_text([pdfimages, "-f", str(page), "-l", str(page), "-list", str(pdf)])
    )
    mask = select_full_resolution_jbig2_mask(listing)
    if mask is None:
        return None
    prefix = scratch / f"page-{page}"
    run(
        [
            pdfimages,
            "-f",
            str(page),
            "-l",
            str(page),
            "-jbig2",
            str(pdf),
            str(prefix),
        ]
    )
    stem = Path(f"{prefix}-{mask.extraction_index:03d}")
    page_stream = stem.with_suffix(".jb2e")
    if not page_stream.is_file():
        raise RuntimeError(
            f"page {page}: selected JBIG2 extraction is missing: {page_stream}"
        )
    output_path = scratch / f"page-{page}-mask.pbm"
    command = [require_executable("jbig2dec"), "-q", "-e", "-o", str(output_path)]
    global_stream = stem.with_suffix(".jb2g")
    if global_stream.is_file():
        command.append(str(global_stream))
    command.append(str(page_stream))
    run(command)
    with Image.open(output_path) as image:
        decoded = image.convert("L")
        if decoded.size != (mask.width, mask.height):
            raise RuntimeError(
                f"page {page}: decoded mask {decoded.size} does not match "
                f"pdfimages row {(mask.width, mask.height)}"
            )
        return mask, decoded.copy()


STROKE_FIELDS = [
    "page",
    "status",
    "mask_type",
    "object_id",
    "width",
    "height",
    "x_dpi",
    "y_dpi",
    "black_pct",
    "erosion_survival_pct",
]


def mask_stroke_metrics(args: argparse.Namespace) -> None:
    excluded = set(parse_pages(args.exclude)) if args.exclude else set()
    pages = [page for page in parse_pages(args.pages) if page not in excluded]
    args.csv.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="evb-mask-strokes-") as temporary:
        scratch = Path(temporary)
        with args.csv.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=STROKE_FIELDS)
            writer.writeheader()
            for page in pages:
                decoded = decoded_page_mask(args.pdf, page, scratch)
                if decoded is None:
                    writer.writerow({"page": page, "status": "no-full-resolution-jbig2-mask"})
                    continue
                mask, image = decoded
                black_pct, survival_pct = stroke_metrics(image)
                writer.writerow(
                    {
                        "page": page,
                        "status": "measured",
                        "mask_type": mask.image_type,
                        "object_id": mask.object_id,
                        "width": mask.width,
                        "height": mask.height,
                        "x_dpi": mask.x_dpi,
                        "y_dpi": mask.y_dpi,
                        "black_pct": f"{black_pct:.6f}",
                        "erosion_survival_pct": (
                            f"{survival_pct:.6f}" if survival_pct is not None else ""
                        ),
                    }
                )


SYMBOL_SAFETY_FIELDS = [
    "page",
    "source_page",
    "half",
    "status",
    "different_pixels",
    "width",
    "height",
    "object_id",
]


def symbol_safety_metrics(args: argparse.Namespace) -> None:
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("pages"), list):
        raise ValueError("raw-mask evidence manifest must use schema version 1")
    evidence_by_page = {
        int(item["outputPage"]): item
        for item in manifest["pages"]
        if isinstance(item, dict) and "outputPage" in item
    }
    pages = parse_pages(args.pages) if args.pages else sorted(evidence_by_page)
    missing = [page for page in pages if page not in evidence_by_page]
    if missing:
        raise ValueError(f"raw-mask evidence is missing pages: {missing}")
    args.csv.parent.mkdir(parents=True, exist_ok=True)
    failures: list[int] = []
    with tempfile.TemporaryDirectory(prefix="evb-symbol-safety-") as temporary:
        scratch = Path(temporary)
        with args.csv.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=SYMBOL_SAFETY_FIELDS)
            writer.writeheader()
            for page in pages:
                evidence = evidence_by_page[page]
                raw_path = Path(str(evidence["rawMaskPath"]))
                if not raw_path.is_absolute():
                    raw_path = args.manifest.parent / raw_path
                with Image.open(raw_path) as original:
                    decoded = decoded_page_mask(args.pdf, page, scratch)
                    if decoded is None:
                        raise RuntimeError(f"page {page}: final PDF has no full-resolution JBIG2 mask")
                    mask, candidate = decoded
                    different_pixels = exact_mask_difference(original, candidate)
                    status = "exact" if different_pixels == 0 else "mismatch"
                    if different_pixels:
                        failures.append(page)
                    writer.writerow(
                        {
                            "page": page,
                            "source_page": evidence.get("sourcePage", ""),
                            "half": evidence.get("half", ""),
                            "status": status,
                            "different_pixels": different_pixels,
                            "width": mask.width,
                            "height": mask.height,
                            "object_id": mask.object_id,
                        }
                    )
    if failures:
        raise RuntimeError(f"symbol-coded masks differ from raw input on pages: {failures}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    photos = subparsers.add_parser(
        "photos", help="measure supplied photo boxes in rendered PDF pages"
    )
    photos.add_argument("--source", type=Path, required=True)
    photos.add_argument("--output", type=Path, required=True)
    photos.add_argument(
        "--output-summary",
        type=Path,
        help="conversion summary (defaults to <output>.summary.json)",
    )
    photos.add_argument("--reference", type=Path)
    photos.add_argument(
        "--reference-summary",
        type=Path,
        help="conversion summary (defaults to <reference>.summary.json)",
    )
    photos.add_argument("--boxes", type=Path, required=True)
    photos.add_argument("--csv", type=Path, required=True)
    photos.add_argument("--crops", type=Path)
    photos.add_argument("--render-dpi", type=int, default=360)
    photos.add_argument("--box-dpi", type=int, default=120)
    photos.add_argument("--tile-size", type=int, default=16)
    photos.add_argument("--tile-limit", type=float, default=0.05)
    photos.set_defaults(handler=photo_metrics)

    strokes = subparsers.add_parser(
        "strokes", help="measure exact embedded full-resolution JBIG2 masks"
    )
    strokes.add_argument("--pdf", type=Path, required=True)
    strokes.add_argument("--csv", type=Path, required=True)
    strokes.add_argument("--pages", default="60-80")
    strokes.add_argument("--exclude", default="67,71")
    strokes.set_defaults(handler=mask_stroke_metrics)
    symbol_safety = subparsers.add_parser(
        "symbol-safety",
        help="compare retained raw masks pixel-exactly with final JBIG2 decodes",
    )
    symbol_safety.add_argument("--pdf", type=Path, required=True)
    symbol_safety.add_argument("--manifest", type=Path, required=True)
    symbol_safety.add_argument("--pages")
    symbol_safety.add_argument("--csv", type=Path, required=True)
    symbol_safety.set_defaults(handler=symbol_safety_metrics)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
