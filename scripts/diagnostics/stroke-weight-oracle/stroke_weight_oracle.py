#!/usr/bin/env python3
"""Component-granularity stroke-weight oracle.

Decodes a foreground mask (the exact full-resolution JBIG2 mask of each cleaned
PDF page, or a rendered page image; never a thresholded composite render),
finds 8-connected components, measures each component's ridge width from an L2
distance transform, groups components into text lines, and compares every
component with the median ridge width of its local neighbours on the same line.

Calibrated defaults come from calibration.json; provenance and the recorded red
baseline live in README.md. Exit status is 0 when every requested page is
measured with zero offenders, 1 when the gate is red, and 2 for invalid input
or measurement failure.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

MASK_THRESHOLD = 128
MILLIMETRES_PER_INCH = 25.4
# The adjudicated specimen separates the short impressum-like lines (fewer
# than 40 eligible components; the observed short/body split was 37 vs 53)
# from the stable body lines.
# Keep this diagnostic fallback threshold separate from the calibrated local
# neighbourhood minimum: a short line is still measured, but it must borrow a
# page-level reference instead of letting its own small population collapse
# the local median.
SPARSE_LINE_POPULATION_FLOOR = 40
CALIBRATION: dict[str, Any] = {}
cv2: Any = None
np: Any = None
Image: Any = None


def load_pixel_dependencies() -> None:
    global cv2, np, Image
    import cv2 as cv2_module
    import numpy as numpy_module
    from PIL import Image as image_module

    cv2 = cv2_module
    np = numpy_module
    Image = image_module


def parse_pages(value: str | None, page_count: int) -> list[int]:
    if value is None:
        return list(range(1, page_count + 1))
    pages: set[int] = set()
    for raw_token in value.split(','):
        token = raw_token.strip()
        if not token:
            continue
        if '-' in token:
            first_text, last_text = token.split('-', 1)
            first, last = int(first_text), int(last_text)
        else:
            first = last = int(token)
        if first < 1 or last < first or last > page_count:
            raise ValueError(f'invalid page range {token!r} for {page_count} pages')
        pages.update(range(first, last + 1))
    if not pages:
        raise ValueError('page selector is empty')
    return sorted(pages)


def pdf_page_count(pdf: Path) -> int:
    output = subprocess.run(
        ['pdfinfo', str(pdf)], check=True, capture_output=True, text=True
    ).stdout
    for line in output.splitlines():
        if line.startswith('Pages:'):
            return int(line.split(':', 1)[1].strip())
    raise RuntimeError(f'pdfinfo did not report a page count for {pdf}')


def load_rendered_metrics(path: Path):
    spec = importlib.util.spec_from_file_location('evb_rendered_metrics', path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'cannot load rendered metrics module from {path}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    return float(np.percentile(np.asarray(values, dtype=np.float64), quantile))


def rounded(value: float | None, digits: int = 6) -> float | None:
    return None if value is None else round(float(value), digits)


def round_half_away_from_zero(value: float) -> int:
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def scaled_eligibility_bounds(x_dpi: float, y_dpi: float) -> dict[str, int]:
    calibration_dpi = float(CALIBRATION['calibrationDpi'])
    x_scale = x_dpi / calibration_dpi
    y_scale = y_dpi / calibration_dpi
    area_scale = max(0.25, x_scale * y_scale)
    return {
        'minimumArea': max(
            2,
            round_half_away_from_zero(
                float(CALIBRATION['componentAreaMinPx']) * area_scale
            ),
        ),
        'minimumHeight': max(
            1,
            round_half_away_from_zero(
                float(CALIBRATION['componentHeightMinPxAt300Dpi']) * y_scale
            ),
        ),
        'maximumHeight': round_half_away_from_zero(
            float(CALIBRATION['componentHeightMaxPxAt300Dpi']) * y_scale
        ),
        'minimumWidth': max(
            1,
            round_half_away_from_zero(
                float(CALIBRATION['componentWidthMinPxAt300Dpi']) * x_scale
            ),
        ),
        'maximumWidth': round_half_away_from_zero(
            float(CALIBRATION['componentWidthMaxPxAt300Dpi']) * x_scale
        ),
    }


def component_ridge_width(component: np.ndarray) -> float:
    # Every component crop is foreground-tight. A white guard is required or an
    # all-foreground crop makes OpenCV report its effectively-infinite sentinel
    # distance rather than the distance to the component boundary.
    guarded = np.pad(component, 1, mode='constant', constant_values=False)
    distance = cv2.distanceTransform(guarded.astype(np.uint8), cv2.DIST_L2, 5)
    ridge = (distance > 0) & (
        distance >= cv2.dilate(distance, np.ones((3, 3), np.float32)) - 1e-5
    )
    return float(2.0 * np.median(distance[ridge])) if ridge.any() else 0.0


def find_components(
    mask: np.ndarray, x_dpi: float, y_dpi: float
) -> tuple[list[dict[str, Any]], int]:
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(
        mask.astype(np.uint8), 8
    )
    bounds = scaled_eligibility_bounds(x_dpi, y_dpi)
    sub_floor_component_count = sum(
        0 < int(stats[label][cv2.CC_STAT_AREA]) < bounds['minimumArea']
        for label in range(1, count)
    )
    result: list[dict[str, Any]] = []
    for label in range(1, count):
        x, y, width, height, area = map(int, stats[label])
        if area < bounds['minimumArea']:
            continue
        if not bounds['minimumHeight'] <= height <= bounds['maximumHeight']:
            continue
        if not bounds['minimumWidth'] <= width <= bounds['maximumWidth']:
            continue
        component = labels[y:y + height, x:x + width] == label
        stroke_width_px = component_ridge_width(component)
        result.append({
            'label': label,
            'x': x,
            'y': y,
            'width': width,
            'height': height,
            'area': area,
            'centerX': float(centroids[label][0]),
            'centerY': float(centroids[label][1]),
            'strokeWidthPx': stroke_width_px,
            'strokeWidthMm': stroke_width_px * MILLIMETRES_PER_INCH / y_dpi,
        })
    return result, sub_floor_component_count


def group_lines(components: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    if not components:
        return []
    median_height = statistics.median(item['height'] for item in components)
    max_center_gap = max(
        2.0, float(CALIBRATION['lineClusterGapHeightFraction']) * median_height
    )
    groups: list[list[dict[str, Any]]] = []
    for component in sorted(components, key=lambda item: (item['centerY'], item['centerX'])):
        best_index = None
        best_distance = math.inf
        for index, group in enumerate(groups):
            center = statistics.median(item['centerY'] for item in group)
            distance = abs(component['centerY'] - center)
            if distance <= max_center_gap and distance < best_distance:
                best_index = index
                best_distance = distance
        if best_index is None:
            groups.append([component])
        else:
            groups[best_index].append(component)
    return [sorted(group, key=lambda item: item['centerX']) for group in groups]


def output_mapping(summary_path: Path | None) -> dict[int, dict[str, Any]]:
    if summary_path is None:
        return {}
    summary = json.loads(summary_path.read_text(encoding='utf-8'))
    output_page_by_ordinal: dict[int, int] = {}
    representation = summary.get('representation', {})
    for page in representation.get('pages', []):
        if 'outputOrdinal' in page and 'outputPageNumber' in page:
            output_page_by_ordinal[int(page['outputOrdinal'])] = int(page['outputPageNumber'])
    if not output_page_by_ordinal:
        output_page_by_ordinal = {
            index: index for index in range(1, int(summary.get('outputPages', 0)) + 1)
        }
    mapping: dict[int, dict[str, Any]] = {}
    for item in representation.get('outputMappings', []):
        ordinal = item.get('outputOrdinal')
        if ordinal is None:
            continue
        page = output_page_by_ordinal.get(int(ordinal), int(ordinal))
        mapping[page] = {
            'sourcePage': item.get('sourcePage'),
            'half': item.get('half'),
            'outputOrdinal': int(ordinal),
        }
    return mapping


def foreground_mask(image: Image.Image) -> np.ndarray:
    gray = np.asarray(image.convert('L'))
    mask = gray < MASK_THRESHOLD
    # A mostly-dark raster is an inverted rendition of the same page; the
    # oracle measures ink, whichever polarity carries it.
    return ~mask if float(mask.mean()) > 0.5 else mask


def measure_mask(
    identity: dict[str, Any],
    mask: np.ndarray,
    x_dpi: float,
    y_dpi: float,
    window_mm: float,
    ratio_limit: float,
    min_local: int,
) -> dict[str, Any]:
    components, sub_floor_component_count = find_components(mask, x_dpi, y_dpi)
    lines = group_lines(components)
    window_px = window_mm * x_dpi / MILLIMETRES_PER_INCH
    line_reports: list[dict[str, Any]] = []
    page_offenders: list[dict[str, Any]] = []
    sparse_line_count = 0
    minimum_line_components = int(CALIBRATION['minimumLineComponents'])
    sparse_line_population_floor = max(
        minimum_line_components,
        SPARSE_LINE_POPULATION_FLOOR,
    )
    page_widths = [item['strokeWidthMm'] for item in components]
    page_p50 = percentile(page_widths, 50)
    page_p95 = percentile(page_widths, 95)
    page_p95_p50_ratio = (page_p95 or 0.0) / max(page_p50 or 0.0, 1e-9)
    measured_line_population = sum(
        len(line) >= minimum_line_components
        and any(
            sum(
                abs(neighbor['centerX'] - item['centerX']) <= window_px
                for neighbor in line
            ) >= min_local
            for item in line
        )
        for line in lines
    )
    page_fallback_trusted = (
        len(components) >= 64
        and measured_line_population >= 2
        and page_p50 is not None
    )
    for line_index, line in enumerate(lines, start=1):
        sparse_line = len(line) < sparse_line_population_floor
        if sparse_line:
            # A short line cannot supply a stable local population, but it is
            # still useful evidence. A page-level comparison is trusted only
            # when the page has enough independent population to support it,
            # and only when it raises the denominator over the short line's
            # own median. Otherwise preserve the old local comparison (or its
            # minimum-population skip) rather than inventing a new verdict.
            sparse_line_count += 1
            sparse_widths = [item['strokeWidthMm'] for item in line]
            sparse_p50 = percentile(sparse_widths, 50)
            sparse_p95 = percentile(sparse_widths, 95)
            line_p95_p50_ratio = (sparse_p95 or 0.0) / max(sparse_p50 or 0.0, 1e-9)
            use_page_fallback = (
                page_fallback_trusted
                and page_p50 is not None
                and sparse_p50 is not None
                and page_p50 > sparse_p50
            )
            if use_page_fallback:
                reference_p50 = page_p50
                reference_p95_p50_ratio = page_p95_p50_ratio
                line_offenders: list[dict[str, Any]] = []
                for item in line:
                    component_ratio = item['strokeWidthMm'] / max(reference_p50, 1e-9)
                    if component_ratio <= ratio_limit:
                        continue
                    line_offenders.append({
                        'line': line_index,
                        'bbox': [item['x'], item['y'], item['width'], item['height']],
                        'centerX': rounded(item['centerX']),
                        'centerY': rounded(item['centerY']),
                        'strokeWidthPx': rounded(item['strokeWidthPx']),
                        'strokeWidthMm': rounded(item['strokeWidthMm']),
                        'localMedianWidthMm': rounded(reference_p50),
                        'ratio': rounded(component_ratio),
                        'localComponentCount': len(components),
                        'reference': 'page-median-fallback',
                    })
                page_offenders.extend(line_offenders)
                line_reports.append({
                    'line': line_index,
                    'centerY': rounded(statistics.median(item['centerY'] for item in line)),
                    'componentCount': len(line),
                    'status': 'measured-sparse-line-fallback',
                    'comparison': 'page-median-fallback',
                    'p50WidthMm': rounded(sparse_p50),
                    'p95WidthMm': rounded(sparse_p95),
                    'p95P50Ratio': rounded(line_p95_p50_ratio),
                    'referenceP50WidthMm': rounded(reference_p50),
                    'referenceP95P50Ratio': rounded(reference_p95_p50_ratio),
                    'offenderCount': len(line_offenders),
                    'offenders': line_offenders,
                })
                continue
            if len(line) < minimum_line_components:
                line_reports.append({
                    'line': line_index,
                    'centerY': rounded(statistics.median(item['centerY'] for item in line)),
                    'componentCount': len(line),
                    'status': 'measured-sparse-line',
                    'comparison': 'insufficient-local-population',
                    'p50WidthMm': rounded(sparse_p50),
                    'p95WidthMm': rounded(sparse_p95),
                    'p95P50Ratio': rounded(line_p95_p50_ratio),
                    'referenceP50WidthMm': rounded(sparse_p50),
                    'referenceP95P50Ratio': rounded(line_p95_p50_ratio),
                    'offenderCount': 0,
                    'offenders': [],
                })
                continue
        widths = [item['strokeWidthMm'] for item in line]
        p50 = percentile(widths, 50)
        p95 = percentile(widths, 95)
        offenders: list[dict[str, Any]] = []
        for item in line:
            local = [
                neighbor['strokeWidthMm']
                for neighbor in line
                if abs(neighbor['centerX'] - item['centerX']) <= window_px
            ]
            if len(local) < min_local:
                continue
            local_median = percentile(local, 50)
            assert local_median is not None
            component_ratio = item['strokeWidthMm'] / max(local_median, 1e-9)
            if component_ratio > ratio_limit:
                offender = {
                    'line': line_index,
                    'bbox': [item['x'], item['y'], item['width'], item['height']],
                    'centerX': rounded(item['centerX']),
                    'centerY': rounded(item['centerY']),
                    'strokeWidthPx': rounded(item['strokeWidthPx']),
                    'strokeWidthMm': rounded(item['strokeWidthMm']),
                    'localMedianWidthMm': rounded(local_median),
                    'ratio': rounded(component_ratio),
                    'localComponentCount': len(local),
                }
                offenders.append(offender)
                page_offenders.append(offender)
        line_reports.append({
            'line': line_index,
            'centerY': rounded(statistics.median(item['centerY'] for item in line)),
            'componentCount': len(line),
            'status': 'measured',
            'comparison': 'line-local',
            'p50WidthMm': rounded(p50),
            'p95WidthMm': rounded(p95),
            'p95P50Ratio': rounded((p95 or 0.0) / max(p50 or 0.0, 1e-9)),
            'referenceP50WidthMm': rounded(p50),
            'referenceP95P50Ratio': rounded((p95 or 0.0) / max(p50 or 0.0, 1e-9)),
            'offenderCount': len(offenders),
            'offenders': offenders,
        })
    return {
        **identity,
        'status': 'measured',
        'raster': {
            'width': int(mask.shape[1]),
            'height': int(mask.shape[0]),
            'xDpi': x_dpi,
            'yDpi': y_dpi,
        },
        'eligibleComponentCount': len(components),
        'subFloorComponentCount': sub_floor_component_count,
        'measuredLineCount': len(line_reports),
        'sparseLineCount': sparse_line_count,
        'sparseLinePopulationFloor': sparse_line_population_floor,
        'pageMedianWidthMm': rounded(page_p50),
        'pageFallbackMeasuredLineCount': measured_line_population,
        'pageFallbackTrusted': page_fallback_trusted,
        'offenderCount': len(page_offenders),
        'maxLineP95P50Ratio': rounded(
            max((line['referenceP95P50Ratio'] for line in line_reports), default=0.0)
        ),
        'lines': line_reports,
    }


def measure_pdf_page(
    page: int,
    decoded: tuple[Any, Any] | None,
    mapping: dict[int, dict[str, Any]],
    window_mm: float,
    ratio_limit: float,
    min_local: int,
) -> dict[str, Any]:
    identity = {'source': 'pdf-page', 'outputPage': page, **mapping.get(page, {})}
    if decoded is None:
        return {
            **identity,
            'status': 'no-full-resolution-jbig2-mask',
            'offenderCount': 0,
            'lines': [],
        }
    image_row, image = decoded
    measurement = measure_mask(
        identity,
        foreground_mask(image),
        float(image_row.x_dpi),
        float(image_row.y_dpi),
        window_mm,
        ratio_limit,
        min_local,
    )
    measurement['raster']['objectId'] = image_row.object_id
    return measurement


def measure_image(
    path: Path,
    dpi: float,
    window_mm: float,
    ratio_limit: float,
    min_local: int,
) -> dict[str, Any]:
    identity = {'source': 'image', 'imagePath': str(path), 'imageName': path.name}
    with Image.open(path) as image:
        mask = foreground_mask(image)
    return measure_mask(identity, mask, dpi, dpi, window_mm, ratio_limit, min_local)


def measure_pdf(args: argparse.Namespace) -> list[dict[str, Any]]:
    pages = parse_pages(args.pages, pdf_page_count(args.pdf))
    mapping = output_mapping(args.summary)
    rendered_metrics = load_rendered_metrics(args.rendered_metrics)
    results = []
    with tempfile.TemporaryDirectory(prefix='evb-weight-oracle-') as directory:
        scratch = Path(directory)
        for page in pages:
            decoded = rendered_metrics.decoded_page_mask(args.pdf, page, scratch)
            results.append(measure_pdf_page(
                page, decoded, mapping, args.window_mm, args.ratio, args.min_local
            ))
    return results


def positive_number(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError(f'{value!r} must be positive')
    return number


def positive_integer(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError(f'{value!r} must be a positive integer')
    return number


def report_path(path: Path | None) -> str | None:
    """Keeps a committed baseline report free of machine-specific home paths."""
    if path is None:
        return None
    absolute = os.path.abspath(path)
    try:
        relative = os.path.relpath(absolute)
    except ValueError:
        return absolute
    return absolute if relative.startswith('..') or os.path.isabs(relative) else relative


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--out', type=Path, help='report JSON path')
    parser.add_argument('--pdf', type=Path, help="cleaned PDF; each page's JBIG2 mask is measured")
    parser.add_argument('--image', type=Path, action='append', default=[],
                        help='rendered page image; repeat for several pages')
    parser.add_argument('--dpi', type=positive_number, help='image-input resolution')
    parser.add_argument('--summary', type=Path, help='conversion summary for PDF page mapping')
    parser.add_argument('--pages', help='PDF output pages, e.g. 1-8,11 (default: all)')
    parser.add_argument('--label', help='ref/build label stored in the report')
    parser.add_argument('--rendered-metrics', type=Path,
                        default=Path(__file__).resolve().parent.parent / 'scan-cleanup-rendered-metrics.py')
    parser.add_argument('--calibration', type=Path,
                        default=Path(__file__).resolve().parent / 'calibration.json')
    parser.add_argument('--print-eligibility', action='store_true')
    parser.add_argument('--window-mm', type=positive_number, help='local horizontal comparison radius')
    parser.add_argument('--ratio', type=positive_number, help='offender/local-median threshold')
    parser.add_argument('--min-local', type=positive_integer, help='minimum components in local window')
    return parser


def main() -> int:
    global CALIBRATION
    parser = build_parser()
    args = parser.parse_args()
    CALIBRATION = json.loads(args.calibration.read_text(encoding='utf-8'))
    if CALIBRATION.get('roundingRule') != 'half-away-from-zero':
        raise ValueError('calibration roundingRule must be half-away-from-zero')
    if args.dpi is None:
        args.dpi = float(CALIBRATION['calibrationDpi'])
    if args.print_eligibility:
        print(json.dumps(scaled_eligibility_bounds(args.dpi, args.dpi), separators=(',', ':')))
        return 0
    if args.out is None:
        parser.error('--out is required')
    if bool(args.pdf) == bool(args.image):
        parser.error('exactly one of --pdf or --image inputs is required')
    if args.window_mm is None:
        args.window_mm = float(CALIBRATION['localWindowMm'])
    if args.ratio is None:
        args.ratio = float(CALIBRATION['offenderRatio'])
    if args.min_local is None:
        args.min_local = int(CALIBRATION['localWindowMinComponents'])
    load_pixel_dependencies()
    if args.pdf is not None:
        results = measure_pdf(args)
    else:
        results = [
            measure_image(path, args.dpi, args.window_mm, args.ratio, args.min_local)
            for path in args.image
        ]
    for result in results:
        if 'imagePath' in result:
            result['imagePath'] = report_path(Path(result['imagePath']))
    measured = [result for result in results if result['status'] == 'measured']
    offenders = sum(result['offenderCount'] for result in measured)
    corpus_max = max((result['maxLineP95P50Ratio'] for result in measured), default=0.0)
    summary = {
        'pageCountRequested': len(results),
        'pageCountMeasured': len(measured),
        'pageCountUnmeasured': len(results) - len(measured),
        'offenderCount': offenders,
        'subFloorComponentCount': sum(
            result['subFloorComponentCount'] for result in measured
        ),
        'offendingPageCount': sum(result['offenderCount'] > 0 for result in measured),
        'corpusMaxP95P50Ratio': rounded(corpus_max),
        'gatePass': len(measured) == len(results) and offenders == 0,
    }
    report = {
        'schemaVersion': 3,
        'oracle': 'component-ridge-width-local-line-median',
        'label': args.label,
        'inputs': {
            'dpi': None if args.pdf else args.dpi,
            'images': [report_path(path) for path in args.image],
            'pdf': report_path(args.pdf),
            'summary': report_path(args.summary),
        },
        'calibration': {
            **CALIBRATION,
            'localWindowMm': args.window_mm,
            'localWindowMinComponents': args.min_local,
            'offenderRatio': args.ratio,
        },
        'pages': results,
        'summary': summary,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(f'{json.dumps(report, indent=2)}\n', encoding='utf-8')
    print(json.dumps(summary, separators=(',', ':')))
    return 0 if summary['gatePass'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - any measurement failure is exit 2
        print(f'stroke-weight oracle failed: {error!r}', file=sys.stderr)
        sys.exit(2)
