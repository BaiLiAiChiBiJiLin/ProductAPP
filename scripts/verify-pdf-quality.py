"""Compare original/standard/high schematic exports from the same layout.

Requires pypdf and Pillow. Checks page/text/drawing-stream invariants, raster
dimensions and alpha masks. Rendering is a separate required visual check.
Run: python scripts/verify-pdf-quality.py .test-output/pdf-quality
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ContentStream


def digest(data):
    return hashlib.sha256(data).hexdigest()


def concatenate(parent, local):
    a, b, c, d, e, f = parent
    g, h, i, j, k, l = local
    return (a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f)


def image_placements(page, reader):
    """Measure actual image CTMs in PDF points, including nested form matrices."""
    placements = []

    def walk(stream, resources, matrix, parent):
        stack = []
        for operands, operator in ContentStream(stream, reader).operations:
            if operator == b"q":
                stack.append(matrix)
            elif operator == b"Q":
                matrix = stack.pop()
            elif operator == b"cm":
                matrix = concatenate(matrix, tuple(float(v) for v in operands))
            elif operator == b"Do":
                name = operands[0]
                obj = resources["/XObject"][name].get_object()
                key = f"{parent}/{name}"
                if obj.get("/Subtype") == "/Form":
                    local = tuple(float(v) for v in obj.get("/Matrix", [1, 0, 0, 1, 0, 0]))
                    walk(obj, obj.get("/Resources", resources), concatenate(matrix, local), key)
                elif obj.get("/Subtype") == "/Image":
                    width_points = math.hypot(matrix[0], matrix[1])
                    height_points = math.hypot(matrix[2], matrix[3])
                    if width_points > 0 and height_points > 0:
                        placements.append({"resource": key,
                            "widthMm": width_points / 72 * 25.4,
                            "heightMm": height_points / 72 * 25.4,
                            "xPpi": int(obj["/Width"]) * 72 / width_points,
                            "yPpi": int(obj["/Height"]) * 72 / height_points})

    walk(page.get_contents(), page.get("/Resources", {}), (1, 0, 0, 1, 0, 0), "page")
    return placements


def inspect_pdf(path):
    reader = PdfReader(path)
    pages = []
    for page in reader.pages:
        images = {}
        streams = {"page": digest(page.get_contents().get_data())}

        def visit(resources, parent="page"):
            for name, reference in sorted(resources.get("/XObject", {}).items()):
                obj = reference.get_object()
                key = f"{parent}/{name}"
                if obj.get("/Subtype") == "/Form":
                    streams[key] = digest(obj.get_data())
                    visit(obj.get("/Resources", {}), key)
                elif obj.get("/Subtype") == "/Image":
                    width, height = int(obj["/Width"]), int(obj["/Height"])
                    mask = obj.get("/SMask")
                    info = {"width": width, "height": height,
                            "pixels": width * height, "alpha": bool(mask),
                            "filter": str(obj.get("/Filter", ""))}
                    if mask:
                        mask = mask.get_object()
                        assert (int(mask["/Width"]), int(mask["/Height"])) == (width, height), \
                            f"{path.name}: alpha mask dimensions differ from image"
                        # Reading the mask verifies the compressed data is valid.
                        alpha_data = mask.get_data()
                        info["alphaBytes"] = len(alpha_data)
                        info["alphaSha256"] = digest(alpha_data)
                    # Force image decoding to catch malformed images/incorrect data lengths.
                    image = obj.decode_as_image()
                    image.load()
                    assert image.size == (width, height)
                    info["pixelMode"] = image.mode
                    info["pixelSha256"] = digest(image.tobytes())
                    images[key] = info

        visit(page.get("/Resources", {}))
        pages.append({"mediaBox": [float(n) for n in page.mediabox],
                      "text": page.extract_text(), "drawingStreams": streams,
                      "images": images, "placements": image_placements(page, reader)})
    return {"file": str(path.resolve()), "bytes": path.stat().st_size,
            "pages": pages}


def compare(original, candidate):
    assert len(original["pages"]) == len(candidate["pages"]), "Page count changed"
    image_count = 0
    resized_count = 0
    alpha_count = 0
    pixels = 0
    for index, (old, new) in enumerate(zip(original["pages"], candidate["pages"]), 1):
        assert old["mediaBox"] == new["mediaBox"], f"Page {index}: page size changed"
        assert old["text"] == new["text"], f"Page {index}: text changed"
        assert old["drawingStreams"] == new["drawingStreams"], \
            f"Page {index}: vector/text/placement drawing streams changed"
        assert old["images"].keys() == new["images"].keys(), f"Page {index}: image resources changed"
        for key, before in old["images"].items():
            after = new["images"][key]
            assert after["width"] <= before["width"] and after["height"] <= before["height"], \
                f"Page {index}, {key}: image was upscaled"
            if before["alpha"]:
                assert after["alpha"], f"Page {index}, {key}: transparency mask lost"
            image_count += 1
            resized_count += after["pixels"] < before["pixels"]
            alpha_count += after["alpha"]
            pixels += after["pixels"]
    return {"bytes": candidate["bytes"], "mib": round(candidate["bytes"] / 1024**2, 3),
            "reductionPercent": round((1 - candidate["bytes"] / original["bytes"]) * 100, 2),
            "pages": len(candidate["pages"]), "images": image_count,
            "resizedImages": resized_count, "transparentImages": alpha_count,
            "totalImagePixels": pixels, "sameTextAndDrawingStreams": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    original = inspect_pdf(args.directory / "original.pdf")
    variants = {name: inspect_pdf(args.directory / f"{name}.pdf") for name in ("standard", "high")}
    result = {"original": compare(original, original)}
    for name, pdf in variants.items():
        result[name] = compare(original, pdf)
        target = 200 if name == "standard" else 300
        resized_ppi = []
        for old_page, new_page in zip(original["pages"], pdf["pages"]):
            for placement in new_page["placements"]:
                key = placement["resource"]
                if new_page["images"][key]["pixels"] < old_page["images"][key]["pixels"]:
                    resized_ppi.extend([placement["xPpi"], placement["yPpi"]])
        if resized_ppi:
            assert min(resized_ppi) >= target - 1, "Downsampled image is below target PPI"
            result[name]["resizedMinPpi"] = round(min(resized_ppi), 2)
            result[name]["resizedMaxPpi"] = round(max(resized_ppi), 2)
    for low_page, high_page in zip(variants["standard"]["pages"], variants["high"]["pages"]):
        for key, low in low_page["images"].items():
            high = high_page["images"][key]
            assert low["width"] <= high["width"] and low["height"] <= high["height"], \
                "200 DPI image unexpectedly larger than 300 DPI image"
    (args.directory / "quality-verification.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    (args.directory / "quality-resource-details.json").write_text(
        json.dumps({"original": original, **variants}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
