"""Verify a real PNG-in-SVG batch after export; requires pypdf and Pillow.

Compares source PNG pixels (including transparency) to PDF image resources.
Optionally compares baseline resources and already-rendered page PNGs as well.
This checks embedded images, not arbitrary SVG geometry; inspect page renders too.
"""
import argparse
import base64
import hashlib
import io
import json
import re
from pathlib import Path

from PIL import Image, ImageChops
from pypdf import PdfReader


def signature(width, height, rgb, alpha):
    return width, height, hashlib.sha256(rgb).hexdigest(), hashlib.sha256(alpha).hexdigest()


def source_images(svg):
    images = set()
    for encoded in re.findall(r'data:image/png;base64,([^"\']+)', svg):
        with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
            rgba = image.convert('RGBA')
            images.add(signature(*rgba.size, rgba.convert('RGB').tobytes(), rgba.getchannel('A').tobytes()))
    return images


def pdf_images(resources):
    images = []
    for reference in (resources.get('/XObject', {}) or {}).values():
        obj = reference.get_object()
        if obj.get('/Subtype') == '/Form':
            images.extend(pdf_images(obj.get('/Resources', {})))
        elif obj.get('/Subtype') == '/Image':
            width, height = int(obj['/Width']), int(obj['/Height'])
            # Read through Pillow to support both RGB and grayscale PDF images.
            rgba = obj.decode_as_image().convert('RGBA')
            mask = obj.get('/SMask')
            alpha = mask.get_object().get_data() if mask else bytes([255]) * (width * height)
            images.append(signature(width, height, rgba.convert('RGB').tobytes(), alpha))
    return images


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pages', type=Path, help='pages.json from prepare-pdf-benchmark.mjs')
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--render-prefix', type=Path, help='pdftoppm output prefix for new PDF')
    parser.add_argument('--baseline-render-prefix', type=Path)
    args = parser.parse_args()
    pages = json.loads(args.pages.read_text(encoding='utf-8'))
    pdf = PdfReader(args.pdf)
    baseline = PdfReader(args.baseline) if args.baseline else None
    assert len(pdf.pages) == len(pages), 'PDF page count differs from exported layout'
    if baseline:
        assert len(baseline.pages) == len(pages), 'Baseline page count differs'
    report = []
    for index, (svg, page) in enumerate(zip(pages, pdf.pages), 1):
        expected = source_images(svg)
        actual = pdf_images(page['/Resources'])
        missing = expected - set(actual)
        assert expected, f'Page {index}: fixture has no PNG sources; use an appropriate verifier'
        assert not missing, f'Page {index}: {len(missing)} source PNGs missing or pixels changed'
        row = {'page': index, 'sourcePngs': len(expected), 'pdfImages': len(actual), 'sourcePixelsMatch': True}
        if baseline:
            original = pdf_images(baseline.pages[index - 1]['/Resources'])
            assert sorted(original) == sorted(actual), f'Page {index}: image resources changed'
            row['baselineImagesMatch'] = True
            old_text = re.sub(r'\s+', '', baseline.pages[index - 1].extract_text())
            new_text = re.sub(r'\s+', '', page.extract_text())
            assert old_text == new_text, f'Page {index}: exported text changed or disappeared'
            row['baselineTextMatch'] = True
        if args.render_prefix and args.baseline_render_prefix:
            with Image.open(f'{args.render_prefix}-{index}.png') as new, Image.open(f'{args.baseline_render_prefix}-{index}.png') as old:
                assert new.size == old.size and ImageChops.difference(new.convert('RGB'), old.convert('RGB')).getbbox() is None, f'Page {index}: rendered pixels changed'
            row['renderPixelsMatch'] = True
        report.append(row)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
