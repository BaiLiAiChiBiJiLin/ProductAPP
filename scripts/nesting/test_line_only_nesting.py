"""Real solver checks for SVG artwork classes sharing geometry but not sheets."""
from collections import Counter, defaultdict
import contextlib
import copy
import io
import math
import os
import tempfile
import unittest
from unittest.mock import patch

from test_local_tools_engine import engine, item, request
from test_template_replan import job, placed
from shapely import affinity
from shapely.geometry import Polygon, box


class LineOnlyNestingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="printflow-line-only-")
        self.addCleanup(self.tmp.cleanup)

    def solve(self, req):
        with contextlib.redirect_stderr(io.StringIO()):
            return engine.solve(req, cache_dir=self.tmp.name)

    def verify(self, req, result, invalid=()):
        sources = {source["id"]: source for source in req["items"] if source["id"] not in invalid}
        expected = {ident: source["quantity"] for ident, source in sources.items()}
        self.assertEqual(Counter(p["id"].split("#qt-")[0] for p in result["placements"]), expected)
        self.assertEqual(len({p["id"] for p in result["placements"]}), sum(expected.values()))
        sheets, classes = defaultdict(list), defaultdict(set)
        left = req["plateWidthMm"] - req["effectiveRightMm"] - req["effectiveWidthMm"]
        top = (req["plateHeightMm"] - req["effectiveHeightMm"]) / 2
        region = box(left, top, left + req["effectiveWidthMm"], top + req["effectiveHeightMm"]).buffer(1e-7)
        for p in result["placements"]:
            source = sources[p["id"].split("#qt-")[0]]
            classes[p["sheetIndex"]].add(source.get("lineOnly", False))
            frame = affinity.rotate(box(0, 0, source["widthMm"], source["heightMm"]), p["rotationDeg"], origin=(0, 0))
            min_x, min_y, _, _ = frame.bounds
            tx, ty = p["xMm"] - min_x, p["yMm"] - min_y
            polygon = affinity.translate(affinity.rotate(Polygon(source["polygon"]), p["rotationDeg"], origin=(0, 0)), tx, ty)
            self.assertTrue(region.covers(polygon))
            self.assertTrue(region.covers(affinity.translate(frame, tx, ty)))
            for other in sheets[p["sheetIndex"]]:
                self.assertLessEqual(polygon.intersection(other).area, 1e-7)
                self.assertGreaterEqual(polygon.distance(other), req["spacingMm"] - 1e-6)
            sheets[p["sheetIndex"]].append(polygon)
        if not req.get("allowBaseMixing", False):
            self.assertTrue(all(len(kinds) == 1 for kinds in classes.values()), classes)
        self.assertEqual(set(sheets), set(range(result["sheetsUsed"])))
        if os.environ.get("PRINTFLOW_NESTING_CORE") == "rust":
            self.assertEqual(result["searchCore"]["backend"], "rust", result.get("warnings"))

    def test_all_strategies_share_masks_but_never_mix_classes(self):
        # Every artwork has the same geometry and all 12 copies would fit on
        # one board; the line-only classification must force exactly two.
        sources = [dict(item("stroke-a", 4), lineOnly=True), item("photo-a", 3),
                   dict(item("stroke-b", 2), lineOnly=True), item("photo-b", 3)]
        for objective in ("least-material", "least-cutting", "combined"):
            with self.subTest(objective=objective):
                req = request(sources, objective)
                before = copy.deepcopy(req)
                with patch.object(engine, "make_masks", wraps=engine.make_masks) as masks:
                    result = self.solve(req)
                self.verify(req, result)
                self.assertEqual(masks.call_count, 1)
                self.assertEqual(result["sheetsUsed"], 2)
                self.assertEqual(req, before)
                self.assertAlmostEqual(result["utilization"], 12 * 10 * 8 / (2 * 80 * 60))
                self.assertFalse(result["unplaced"])
                self.assertFalse(result["excludedItems"])

    def test_single_class_and_legacy_inputs_do_not_open_empty_sheets(self):
        for line_only in (False, True):
            with self.subTest(line_only=line_only):
                source = item("art", 5)
                if line_only:
                    source["lineOnly"] = True
                req = request([source])
                result = self.solve(req)
                self.verify(req, result)
                self.assertEqual(result["sheetsUsed"], 1)

    def test_base_mixing_switch_changes_real_layout_for_all_strategies(self):
        sources = [dict(item("stroke", 4), lineOnly=True), item("photo", 4)]
        for objective in ("least-material", "least-cutting", "combined"):
            with self.subTest(objective=objective):
                req = request(sources, objective)
                req["allowBaseMixing"] = False
                separate = self.solve(req)
                self.verify(req, separate)
                self.assertEqual(separate["sheetsUsed"], 2)
                req["allowBaseMixing"] = True
                before = copy.deepcopy(req)
                with patch.object(engine, "make_masks", wraps=engine.make_masks) as masks:
                    mixed = self.solve(req)
                self.verify(req, mixed)
                self.assertEqual(mixed["sheetsUsed"], 1)
                self.assertEqual(masks.call_count, 1)
                self.assertEqual(req, before)

    def test_mixed_cross_class_and_existing_mixed_templates_can_replan(self):
        for mixed_template in (False, True):
            with self.subTest(mixed_template=mixed_template):
                req = job()
                req["items"][2]["lineOnly"] = True
                if mixed_template:
                    req["items"][1]["lineOnly"] = True
                req["allowBaseMixing"] = True
                before = copy.deepcopy(req)
                result = self.solve(req)
                self.verify(req, result)
                self.assertFalse(result["unplaced"])
                self.assertEqual(req, before)
                anchor = req["templateRepack"]["targetPlacement"]
                self.assertTrue(any(p["id"].split("#qt-")[0] == anchor["sourceId"]
                                    and abs(p["xMm"] - anchor["xMm"]) < 1e-6
                                    and abs(p["yMm"] - anchor["yMm"]) < 1e-6
                                    for p in result["placements"]))

    def test_mixing_still_rejects_insufficient_spacing(self):
        shape = box(0, 0, 10, 8)
        sources = [dict(id="stroke", poly=shape, frame=shape, line_only=True),
                   dict(id="photo", poly=shape, frame=shape, line_only=False)]
        adjacent = [[dict(i=0, angle=0, tx=0, ty=0), dict(i=1, angle=0, tx=10, ty=0)]]
        with self.assertRaisesRegex(ValueError, "间距不足"):
            engine._validate_boards(sources, adjacent, 80, 60, 3, allow_base_mixing=True)

    def test_large_qt_and_repeated_templates_keep_unique_contour_storage(self):
        sources = [dict(item("stroke", 1201, 20.3, 10.7), lineOnly=True),
                   item("photo", 601, 20.3, 10.7)]
        req = request(sources, "least-cutting", 20.3, 10.7)
        with patch.object(engine, "make_masks", wraps=engine.make_masks) as masks:
            result = self.solve(req)
        self.verify(req, result)
        self.assertEqual(masks.call_count, 1)
        self.assertEqual(result["sheetsUsed"], 1802)
        self.assertEqual(len({(p["xMm"], p["yMm"], p["rotationDeg"]) for p in result["placements"]}), 1)

    def test_invalid_sources_in_either_class_are_isolated(self):
        for line_only in (False, True):
            with self.subTest(line_only=line_only):
                bad = dict(item("bad", 2), lineOnly=line_only,
                           polygon=[[0, 0], [10, 8], [0, 8], [10, 0]])
                req = request([bad, dict(item("stroke", 3), lineOnly=True), item("photo", 2)])
                result = self.solve(req)
                self.verify(req, result, invalid={"bad"})
                self.assertEqual([e["id"] for e in result["excludedItems"]], ["bad"])
                self.assertEqual(set(result["unplaced"]), {"bad", "bad#qt-2"})
                self.assertEqual(result["sheetsUsed"], 2)

    def test_same_class_replan_preserves_other_class_coordinates_and_repeats(self):
        for active_line_only in (False, True):
            with self.subTest(active_line_only=active_line_only):
                req = job()
                for source in req["items"]:
                    source["lineOnly"] = active_line_only
                req["items"].append(dict(item("untouched", 2), lineOnly=not active_line_only))
                anchor = placed("untouched", 31.237, 27.891, 37.25)
                req["templateRepack"]["templates"].append(dict(id="C", repeatCount=2, placements=[anchor]))
                before = copy.deepcopy(req)
                result = self.solve(req)
                self.verify(req, result)
                self.assertEqual(req, before)
                preserved = [p for p in result["placements"] if p["id"].split("#qt-")[0] == "untouched"]
                self.assertEqual(len(preserved), 2)
                self.assertEqual(len({p["sheetIndex"] for p in preserved}), 2)
                for p in preserved:
                    for key in ("xMm", "yMm", "rotationDeg"):
                        self.assertTrue(math.isclose(p[key], anchor[key], abs_tol=1e-9))

    def test_cross_class_replan_fails_atomically(self):
        req = job()
        req["items"][2]["lineOnly"] = True
        before = copy.deepcopy(req)
        with self.assertRaisesRegex(ValueError, "不能跨这两类版式移动"):
            self.solve(req)
        self.assertEqual(req, before)


if __name__ == "__main__":
    unittest.main()
