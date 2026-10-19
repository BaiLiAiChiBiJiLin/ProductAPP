"""Real-core regression cases for the separate cross-template transaction."""
import contextlib
import copy
from collections import Counter, defaultdict
import importlib.util
import io
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('local_tools_engine', ROOT / 'src-tauri/src/imposition/local_nesting/local_tools_engine.py')
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)
from shapely import affinity
from shapely.geometry import Polygon, box


def item(ident, quantity, width=10, height=8):
    return dict(id=ident, quantity=quantity, widthMm=width, heightMm=height,
                polygon=[[0, 0], [width, 0], [width, height], [0, height]])


def placed(ident, x=0, y=0, angle=0):
    return dict(sourceId=ident, xMm=x, yMm=y, rotationDeg=angle)


def job(width=100, height=80):
    return dict(plateWidthMm=width, plateHeightMm=height, effectiveWidthMm=width,
                effectiveHeightMm=height, effectiveRightMm=0, spacingMm=3,
                objective='least-cutting', irregularAlgorithm='local-tools',
                items=[item('cat', 10), item('rabbit', 10), item('flower', 5)],
                templateRepack=dict(
                    templates=[dict(id='A', repeatCount=10, placements=[placed('cat'), placed('rabbit', 15)]),
                               dict(id='B', repeatCount=5, placements=[placed('flower')])],
                    sourceTemplateId='A', targetTemplateId='B', sourceSlotIndex=0,
                    targetPlacement=placed('cat', 15)))


def source_id(placement):
    return placement['id'].split('#qt-')[0]


class TemplateReplanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='printflow-replan-')
        self.addCleanup(self.tmp.cleanup)

    def solve(self, request):
        with contextlib.redirect_stderr(io.StringIO()):
            return engine.solve(request, cache_dir=self.tmp.name)

    def verify(self, request, result):
        expected = {entry['id']: entry['quantity'] for entry in request['items']}
        self.assertEqual(Counter(source_id(p) for p in result['placements']), expected)
        self.assertEqual(len({p['id'] for p in result['placements']}), sum(expected.values()))
        self.assertFalse(result['unplaced'])
        self.assertFalse(result['excludedItems'])
        if os.environ.get('PRINTFLOW_NESTING_CORE') == 'rust':
            self.assertEqual(result['searchCore']['backend'], 'rust', result.get('warnings'))
        self.assertIn('template-repack', result['algorithm'])
        sources = {entry['id']: entry for entry in request['items']}
        by_sheet = defaultdict(list)
        width = request['effectiveWidthMm']
        height = request['effectiveHeightMm']
        left = request['plateWidthMm'] - request['effectiveRightMm'] - width
        top = (request['plateHeightMm'] - height) / 2
        region = box(left, top, left + width, top + height).buffer(1e-7)
        for placement in result['placements']:
            source = sources[source_id(placement)]
            frame = affinity.rotate(box(0, 0, source['widthMm'], source['heightMm']), placement['rotationDeg'], origin=(0, 0))
            min_x, min_y, _, _ = frame.bounds
            tx, ty = placement['xMm'] - min_x, placement['yMm'] - min_y
            frame = affinity.translate(frame, tx, ty)
            polygon = affinity.translate(affinity.rotate(Polygon(source['polygon']), placement['rotationDeg'], origin=(0, 0)), tx, ty)
            self.assertTrue(region.covers(frame))
            self.assertTrue(region.covers(polygon))
            for other in by_sheet[placement['sheetIndex']]:
                self.assertLessEqual(polygon.intersection(other).area, 1e-7)
                self.assertGreaterEqual(polygon.distance(other), request['spacingMm'] - 1e-6)
            by_sheet[placement['sheetIndex']].append(polygon)
        self.assertEqual(len(by_sheet), result['sheetsUsed'])

    def test_a10_cat_rabbit_b5_flower_moves_full_quantity_and_recomputes_repetitions(self):
        request = job()
        untouched = copy.deepcopy(request)
        with patch.object(engine, 'make_masks', wraps=engine.make_masks) as masks:
            result = self.solve(request)
        self.verify(request, result)
        self.assertEqual(request, untouched)
        self.assertEqual(masks.call_count, 1, 'Equal contours reuse one mask bank across all QT and search trials')
        self.assertEqual(result['sheetsUsed'], 1)
        self.assertEqual(sum(source_id(p) == 'cat' for p in result['placements'] if p['sheetIndex'] == 0), 10)
        self.assertTrue(any(source_id(p) == 'cat' and p['xMm'] == 15 and p['yMm'] == 0 for p in result['placements']))

    def test_small_target_spills_whole_remaining_quantity_into_other_templates(self):
        request = job(width=25, height=10)
        result = self.solve(request)
        self.verify(request, result)
        anchor_boards = {p['sheetIndex'] for p in result['placements'] if source_id(p) == 'cat' and p['xMm'] == 15 and p['yMm'] == 0}
        self.assertEqual(len(anchor_boards), 5, 'Target flower QT limits this two-piece template to five repeats')
        self.assertEqual(sum(source_id(p) == 'cat' and p['sheetIndex'] in anchor_boards for p in result['placements']), 5)
        self.assertEqual(sum(source_id(p) == 'cat' and p['sheetIndex'] not in anchor_boards for p in result['placements']), 5)
        self.assertLess(result['sheetsUsed'], 15)

    def test_other_existing_template_is_searched_before_opening_new_boards(self):
        request = job(width=40, height=10)
        request['items'].append(item('star', 3))
        request['templateRepack']['templates'].append(dict(id='C', repeatCount=3, placements=[placed('star')]))
        events = []
        class Reporter:
            def emit(self, phase, detail, *args, **kwargs):
                events.append(detail)
        with contextlib.redirect_stderr(io.StringIO()):
            result = engine.solve(request, cache_dir=self.tmp.name, progress=Reporter())
        self.verify(request, result)
        self.assertTrue(any('已有方案 C' in detail for detail in events), events)
        sheets = defaultdict(list)
        for placement in result['placements']:
            sheets[placement['sheetIndex']].append(placement)
        self.assertTrue(any(any(source_id(p) == 'star' and p['xMm'] == 0 and p['yMm'] == 0 for p in sheet)
                            and len(sheet) > 1 for sheet in sheets.values()))

    def test_fractional_non_grid_anchor_and_arbitrary_rotation_remain_exact(self):
        request = job()
        anchor = placed('cat', 19.237, 17.891, 37.25)
        request['templateRepack']['targetPlacement'] = anchor
        result = self.solve(request)
        self.verify(request, result)
        matches = [p for p in result['placements'] if source_id(p) == 'cat' and math.isclose(p['rotationDeg'], 37.25, abs_tol=1e-10)]
        self.assertTrue(matches)
        for placement in matches:
            self.assertAlmostEqual(placement['xMm'], anchor['xMm'], places=9)
            self.assertAlmostEqual(placement['yMm'], anchor['yMm'], places=9)

    def test_nonzero_board_margins_keep_absolute_canvas_coordinates(self):
        request = job()
        request.update(plateWidthMm=115, plateHeightMm=100, effectiveRightMm=5)
        for template in request['templateRepack']['templates']:
            for placement in template['placements']:
                placement['xMm'] += 10
                placement['yMm'] += 10
        request['templateRepack']['targetPlacement'] = placed('cat', 25.127, 10.125)
        result = self.solve(request)
        self.verify(request, result)
        self.assertTrue(any(source_id(p) == 'cat' and math.isclose(p['xMm'], 25.127) and math.isclose(p['yMm'], 10.125)
                            for p in result['placements']))

    def test_invalid_anchor_fails_atomically_instead_of_returning_old_plan(self):
        for anchor in [placed('cat', 2), placed('cat', 95), placed('cat', 12.999)]:
            request = job()
            request['templateRepack']['targetPlacement'] = anchor
            before = copy.deepcopy(request)
            with self.assertRaisesRegex(ValueError, '最终位置越出|间距不足'):
                self.solve(request)
            self.assertEqual(request, before)

    def test_duplicate_or_excessive_template_qt_fails_atomically(self):
        request = job()
        request['templateRepack']['templates'][0]['repeatCount'] = 11
        with self.assertRaisesRegex(ValueError, '超出所选图片 QT'):
            self.solve(request)

    def test_invalid_artwork_does_not_silently_drop_qt_during_transaction(self):
        request = job()
        request['items'][0]['polygon'] = [[0, 0], [10, 8], [0, 8], [10, 0]]
        with self.assertRaisesRegex(ValueError, '完整 QT 包含无效图片'):
            self.solve(request)

    def test_large_qt_reuses_contours_and_templates_without_a_quantity_search_limit(self):
        request = job(width=25, height=10)
        request['items'] = [item('cat', 1201), item('flower', 601)]
        request['templateRepack']['templates'] = [
            dict(id='A', repeatCount=1201, placements=[placed('cat')]),
            dict(id='B', repeatCount=601, placements=[placed('flower')]),
        ]
        with patch.object(engine, 'make_masks', wraps=engine.make_masks) as masks:
            result = self.solve(request)
        self.verify(request, result)
        self.assertEqual(masks.call_count, 1)
        self.assertEqual(result['sheetsUsed'], 901)
        self.assertEqual(sum(source_id(p) == 'cat' and p['xMm'] == 15 for p in result['placements']), 601)


if __name__ == '__main__':
    unittest.main()
