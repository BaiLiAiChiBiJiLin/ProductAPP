import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "src-tauri/src/imposition/local_nesting"
SPEC = importlib.util.spec_from_file_location("local_tools_engine", RUNTIME / "local_tools_engine.py")
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)


def request(items, objective="least-material", width=80, height=60):
    return dict(plateWidthMm=width + 15, plateHeightMm=height + 20,
                effectiveWidthMm=width, effectiveHeightMm=height,
                effectiveRightMm=5, spacingMm=3, objective=objective, items=items)


def item(ident="a", quantity=1, width=10, height=8):
    return dict(id=ident, quantity=quantity, widthMm=width, heightMm=height,
                polygon=[[0, 0], [width, 0], [width, height], [0, height]])


class LocalToolsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def solve(self, req):
        with contextlib.redirect_stderr(io.StringIO()):
            return engine.solve(req, cache_dir=self.tmp.name)

    def test_material_preserves_quantities_and_reuses_masks_for_equal_shapes(self):
        with patch.object(engine, "make_masks", wraps=engine.make_masks) as build:
            result = self.solve(request([item(quantity=5), item("b", 4)]))
        self.assertEqual(build.call_count, 1)
        self.assertEqual(result["sheetsUsed"], 1)
        self.assertEqual(len(result["placements"]), 9)
        self.assertEqual({p["id"] for p in result["placements"]},
                         {"a", "a#qt-2", "a#qt-3", "a#qt-4", "a#qt-5", "b", "b#qt-2", "b#qt-3", "b#qt-4"})
        self.assertFalse(result["unplaced"])
        self.assertTrue(all(p["xMm"] >= 10 and p["yMm"] >= 10 for p in result["placements"]))

    def test_uniform_fills_a_board_instead_of_one_copy_per_quantity_layer(self):
        result = self.solve(request([item(quantity=5), item("b", 3), item("c", 1)], "least-cutting"))
        self.assertEqual(len(result["placements"]), 9)
        self.assertEqual(result["sheetsUsed"], 1)
        self.assertIn("tools/uniform", result["algorithm"])

    def test_uniform_repeats_dense_boards_and_keeps_exact_unequal_remainders(self):
        from collections import Counter
        sources = [item("a", 20), item("b", 20), item("c", 30), item("d", 25)]
        with patch.object(engine, "make_masks", wraps=engine.make_masks) as build:
            result = self.solve(request(sources, "least-cutting", width=104.5, height=54))
        self.assertEqual(build.call_count, 1)
        self.assertEqual(len(result["placements"]), 95)
        self.assertEqual(result["sheetsUsed"], 3)
        counts = Counter(p["id"].split("#qt-")[0] for p in result["placements"])
        self.assertEqual(counts, {"a": 20, "b": 20, "c": 30, "d": 25})
        by_sheet = {}
        for p in result["placements"]:
            by_sheet.setdefault(p["sheetIndex"], []).append((p["id"].split("#qt-")[0], p["xMm"], p["yMm"], p["rotationDeg"]))
        self.assertEqual([len(page) for page in by_sheet.values()], [40, 40, 15])
        self.assertEqual(by_sheet[0], by_sheet[1])
        self.assertEqual(len({tuple(sorted(page)) for page in by_sheet.values()}), 2)
        self.assertFalse(result["unplaced"])

    def test_rotation_fits_an_image_that_cannot_fit_upright(self):
        result = self.solve(request([item(width=10, height=30)], width=40, height=20))
        p = result["placements"][0]
        self.assertIn(p["rotationDeg"], [75, 90, 105, 255, 270, 285])
        self.assertEqual(p["widthMm"], 10)
        self.assertEqual(p["heightMm"], 30)
        self.assertFalse(result["excludedItems"])

    def test_uniform_large_qt_reuses_one_dense_template_and_one_geometry_bank(self):
        with patch.object(engine, "make_masks", wraps=engine.make_masks) as build:
            result = self.solve(request([item(quantity=1201, width=20.3, height=10.7)],
                                        "least-cutting", width=20.3, height=10.7))
        self.assertEqual(build.call_count, 1)
        self.assertEqual(len(result["placements"]), 1201)
        self.assertEqual(result["sheetsUsed"], 1201)
        self.assertEqual(len({(p["xMm"], p["yMm"], p["rotationDeg"]) for p in result["placements"]}), 1)
        self.assertFalse(result["unplaced"])

    def test_uniform_compares_complete_demand_instead_of_only_single_board_density(self):
        from collections import Counter
        sources = [item("a", 30, 10, 8), item("b", 30, 11, 8), item("c", 30, 12, 8)]
        result = self.solve(request(sources, "least-cutting", width=104.5, height=54))
        self.assertEqual(result["sheetsUsed"], 3)
        pages = {}
        for p in result["placements"]:
            pages.setdefault(p["sheetIndex"], []).append(
                (p["id"].split("#qt-")[0], p["xMm"], p["yMm"], p["rotationDeg"]))
        self.assertEqual(len({tuple(sorted(page)) for page in pages.values()}), 1)
        self.assertEqual(Counter(p["id"].split("#qt-")[0] for p in result["placements"]),
                         {"a": 30, "b": 30, "c": 30})

    def test_uniform_real_mixed_contours_thirty_each_fit_five_identical_boards(self):
        from collections import Counter
        req = json.loads((Path(__file__).parent / "fixtures/repeated-mixed-contours.json").read_text())
        with patch.object(engine, "make_masks", wraps=engine.make_masks) as build:
            result = self.solve(req)
        self.assertEqual(build.call_count, len(req["items"]))
        self.assertEqual(result["sheetsUsed"], 5)
        self.assertFalse(result["unplaced"])
        self.assertFalse(result["excludedItems"])
        pages = {}
        for p in result["placements"]:
            pages.setdefault(p["sheetIndex"], []).append(
                (p["id"].split("#qt-")[0], p["xMm"], p["yMm"], p["rotationDeg"]))
        self.assertEqual(len({tuple(sorted(page)) for page in pages.values()}), 1)
        for page in pages.values():
            self.assertEqual(Counter(p[0] for p in page), {i["id"]: 6 for i in req["items"]})
        # Independent frame/contour boundary and 3 mm pair-distance checks.
        import test_combined_nesting as checks
        checks.CombinedNestingTests().verify(req, result)

    def test_uniform_keeps_complete_dense_plan_when_shared_quota_cannot_fit(self):
        first, second = item("a", 2, 10, 10), item("b", 2, 10, 10)
        first["polygon"] = [[0, 0], [10, 0], [0, 10]]
        second["polygon"] = [[0, 0], [10, 0], [5, 10]]
        req = request([first, second], "least-cutting", width=10.2, height=10.2)
        result = self.solve(req)
        self.assertEqual(result["sheetsUsed"], 4)
        self.assertEqual(len(result["placements"]), 4)
        self.assertFalse(result["unplaced"])
        import test_combined_nesting as checks
        checks.CombinedNestingTests().verify(req, result)

    def test_one_off_tail_does_not_destroy_repeated_bulk_layout(self):
        from collections import Counter
        req = json.loads((Path(__file__).parent / 'fixtures/repeated-mixed-contours.json').read_text())
        req['allowBaseMixing'] = True
        req['items'].append(item('one-off-tail', 1, 12, 8))
        with patch.object(engine, 'make_masks', wraps=engine.make_masks) as build:
            result = self.solve(req)
        self.assertEqual(build.call_count, len(req['items']))
        self.assertEqual(result['sheetsUsed'], 5)
        pages = {}
        for p in result['placements']:
            pages.setdefault(p['sheetIndex'], []).append(
                (p['id'].split('#qt-')[0], p['xMm'], p['yMm'], p['rotationDeg']))
        self.assertLessEqual(len({tuple(sorted(page)) for page in pages.values()}), 2)
        self.assertEqual(Counter(p['id'].split('#qt-')[0] for p in result['placements']),
                         {i['id']: i['quantity'] for i in req['items']})
        import test_combined_nesting as checks
        checks.CombinedNestingTests().verify(req, result)

    def test_real_unequal_lots_and_one_offs_reduce_whole_job_templates(self):
        from collections import Counter
        req = json.loads((Path(__file__).parent / 'fixtures/repeated-lots-with-tails.json').read_text())
        with patch.object(engine, 'make_masks', wraps=engine.make_masks) as build:
            result = self.solve(req)
        self.assertEqual(build.call_count, len(req['items']))
        self.assertLessEqual(result['sheetsUsed'], 91)  # Previous complete plan: 95 / 19.
        pages = {}
        for p in result['placements']:
            pages.setdefault(p['sheetIndex'], []).append(
                (p['id'].split('#qt-')[0], p['xMm'], p['yMm'], p['rotationDeg']))
        self.assertLessEqual(len({tuple(sorted(page)) for page in pages.values()}), 11)
        self.assertEqual(Counter(p['id'].split('#qt-')[0] for p in result['placements']),
                         {i['id']: i['quantity'] for i in req['items']})
        self.assertFalse(result['unplaced'])
        self.assertFalse(result['excludedItems'])
        import test_combined_nesting as checks
        checks.CombinedNestingTests().verify(req, result)

    def test_invalid_lot_tail_preserves_the_original_complete_plan(self):
        req = json.loads((Path(__file__).parent / 'fixtures/repeated-mixed-contours.json').read_text())
        req['items'].append(item('tail', 1, 12, 8))
        def overlapping(job, args, boards, remaining, progress):
            boards = list(boards)
            boards[0] = boards[0] + [dict(boards[0][0], i=8)]
            return boards
        with patch('nest_repeat_lots._insert_tails', side_effect=overlapping):
            result = self.solve(req)
        self.assertEqual(len(result['placements']), 241)
        self.assertEqual(result['sheetsUsed'], 5)
        import test_combined_nesting as checks
        checks.CombinedNestingTests().verify(req, result)

    def test_dense_frontier_does_not_trade_piece_count_and_area_for_sparse_repeats(self):
        from nest_uniform import _dense_frontier
        sources = [{"area": 2}, {"area": 4}]
        small_dense = [{"i": 0}] * 80
        large_dense = [{"i": 1}] * 50
        sparse = [{"i": 0}] * 30
        # Neither dense board dominates the other: retain both for repeat
        # comparison, but reject the 30-piece sparse template unconditionally.
        self.assertEqual(_dense_frontier([small_dense, large_dense, sparse], sources),
                         [small_dense, large_dense])

    def test_bad_source_does_not_stop_valid_sources(self):
        bad = item("bad", quantity=2)
        bad["polygon"] = [[0, 0], [10, 8], [0, 8], [10, 0]]
        result = self.solve(request([bad, item("oversized", width=300, height=300), item("good", quantity=3)]))
        self.assertEqual(len(result["placements"]), 3)
        self.assertEqual({p["id"] for p in result["excludedItems"]}, {"bad", "oversized"})
        self.assertEqual(set(result["unplaced"]), {"bad", "bad#qt-2", "oversized"})

    def test_aabb_mapping_uses_full_frame_without_reflection(self):
        source = item(width=20, height=10)
        source["polygon"] = [[0, 0], [16, 0], [0, 8]]
        placement = dict(i=0, angle=180, tx=30, ty=20)
        with patch.object(engine, "pack_material_boards", return_value=[[placement]]):
            result = self.solve(request([source]))
        p = result["placements"][0]
        self.assertAlmostEqual(p["xMm"], 20)
        self.assertAlmostEqual(p["yMm"], 20)
        self.assertEqual(p["rotationDeg"], 180)

    def test_memory_pressure_retries_whole_bank_without_excluding_valid_art(self):
        original = engine.make_masks
        calls = []
        def allocate(srcs, cache, resolution, angles, gap, progress):
            calls.append(resolution)
            if len(calls) == 1:
                raise MemoryError("simulated mask allocation failure")
            return original(srcs, cache, resolution, angles, gap, progress)
        with patch.object(engine, "make_masks", side_effect=allocate):
            result = self.solve(request([item(quantity=3)]))
        self.assertEqual(calls, [.5, 1.])
        self.assertEqual(len(result["placements"]), 3)
        self.assertFalse(result["excludedItems"])
        self.assertTrue(any("1 mm" in warning for warning in result["warnings"]))

    def test_full_size_image_can_touch_every_effective_edge(self):
        # Deliberately not multiples of the 0.5 mm search resolution.
        for objective in ("least-material", "least-cutting"):
            with self.subTest(objective=objective):
                result = self.solve(request([item(quantity=2, width=20.3, height=10.7)],
                                            objective, width=20.3, height=10.7))
                self.assertFalse(result["excludedItems"])
                self.assertEqual(len(result["placements"]), 2)
                self.assertEqual(result["sheetsUsed"], 2)
                for p in result["placements"]:
                    self.assertAlmostEqual(p["xMm"], 10)
                    self.assertAlmostEqual(p["yMm"], 10)
                    self.assertIn(p["rotationDeg"], [0, 180])

    def test_zero_spacing_allows_touching_but_rejects_overlap(self):
        source = engine._source(item(), 0, Path(self.tmp.name))
        touching = [[dict(i=0, angle=0, tx=0, ty=0), dict(i=0, angle=0, tx=10, ty=0)]]
        engine._validate_boards([source], touching, 20, 8, 0)
        overlap = [[dict(i=0, angle=0, tx=0, ty=0), dict(i=0, angle=0, tx=9.999, ty=0)]]
        with self.assertRaisesRegex(ValueError, "间距不足"):
            engine._validate_boards([source], overlap, 20, 8, 0)

    def test_floating_point_edge_tolerance_does_not_make_an_empty_board(self):
        result = self.solve(request([item(width=20.26000005, height=10.26000005)],
                                    width=20.26, height=10.26))
        self.assertEqual(len(result["placements"]), 1)
        self.assertFalse(result["excludedItems"])

    def test_changed_outline_with_same_id_and_byte_length_gets_new_cache(self):
        first = item()
        second = item()
        second["polygon"] = [[0, 0], [10, 0], [10, 1], [0, 4]]
        first_source = engine._source(first, 0, Path(self.tmp.name))
        second_source = engine._source(second, 0, Path(self.tmp.name))
        self.assertEqual(first_source["file"].stat().st_size, second_source["file"].stat().st_size)
        self.solve(request([first]))
        self.solve(request([second]))
        self.assertEqual(len(list(Path(self.tmp.name).glob("masks_*.pkl"))), 2)

    def test_monotone_search_cache_matches_full_search_at_every_step(self):
        import numpy as np
        import nesting_common
        rng = np.random.default_rng(291)
        for case in range(20):
            occ = np.zeros((41, 53), dtype=np.uint8)
            mask = (rng.random((7, 9)) < .7).astype(np.uint8)
            origin = (0, 0)
            for step in range(30):
                full = nesting_common._first_legal_position(occ, mask)
                cached = nesting_common._first_legal_position(occ, mask, origin) if origin is not None else None
                self.assertEqual(cached, full, (case, step))
                if cached is None:
                    break
                x, y = cached
                occ[y:y + 7, x:x + 9] |= mask
                # Also emulate another product blocking a disjoint region.
                occ[rng.integers(0, 41, 5), rng.integers(0, 53, 5)] = 1
                origin = cached

    def test_complete_board_is_identical_with_and_without_search_lower_bounds(self):
        import nesting_common
        srcs = [engine._source(item("a", 15, 12, 8), 0, Path(self.tmp.name)),
                engine._source(item("b", 12, 7, 15), 1, Path(self.tmp.name))]
        bank = engine.make_masks(srcs, Path(self.tmp.name), .5, list(range(0, 360, 15)), 3)
        original = nesting_common._first_legal_position
        def full_search(occ, mask, start_origin=None):
            return original(occ, mask)
        for seed, mode in enumerate(("top", "bl", "low")):
            baseline_remaining = [15, 12]
            fast_remaining = baseline_remaining.copy()
            with patch.object(nesting_common, "_first_legal_position", side_effect=full_search):
                baseline = nesting_common._pack_one_python(srcs, bank, baseline_remaining, 75, 60, 3, 0, .5, seed, mode, "mixed")
            fast = nesting_common._pack_one_python(srcs, bank, fast_remaining, 75, 60, 3, 0, .5, seed, mode, "mixed")
            self.assertEqual(fast, baseline)
            self.assertEqual(fast_remaining, baseline_remaining)


if __name__ == "__main__":
    unittest.main()
