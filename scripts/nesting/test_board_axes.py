"""True-contour column candidates reuse the same masks and preserve quantities."""
from collections import Counter
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src-tauri/src/imposition/local_nesting'))
from shapely import affinity
from shapely.geometry import Polygon, box
import nesting_common as common
import nesting_rust as native


class BoardAxesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='printflow-board-axes-')
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name)

    def sources(self, polygons):
        result = []
        for index, polygon in enumerate(polygons):
            source = self.cache / f'shape-{index}.txt'
            source.write_text(polygon.wkt)
            result.append(dict(i=index, poly=polygon, frame=box(*polygon.bounds), area=polygon.area,
                               name=str(index), file=str(source)))
        return result

    def valid(self, sources, boards, width, height, gap, margin):
        region = box(margin, margin, width-margin, height-margin).buffer(1e-7)
        for board in boards:
            polygons = []
            for placement in board:
                def transform(shape):
                    return affinity.translate(affinity.rotate(shape, placement['angle'], origin=(0, 0)),
                                              placement['tx'], placement['ty'])
                source = sources[placement['i']]
                polygon = transform(source['poly'])
                self.assertTrue(region.covers(polygon))
                self.assertTrue(region.covers(transform(source['frame'])))
                for other in polygons:
                    self.assertLessEqual(polygon.intersection(other).area, 1e-7)
                    self.assertGreaterEqual(polygon.distance(other), gap-1e-6)
                polygons.append(polygon)

    def test_column_candidate_recovers_twenty_slots_instead_of_eighteen_at_four_mm(self):
        sources = self.sources([box(0, 0, 76, 65)] * 2)
        for backend in ('python', 'rust'):
            with self.subTest(backend=backend), patch.dict(os.environ, PRINTFLOW_NESTING_CORE=backend, PRINTFLOW_NESTING_THREADS='1'):
                with common.make_masks(sources, self.cache, .5, list(range(0, 360, 15)), 4) as bank:
                    row_remaining = [10, 10]
                    rows = common.pack_one(sources, bank, row_remaining, 285, 440, 4, 0, .5, 0)
                    self.assertEqual(len(rows), 18)
                    snapshot = {i: [(id(m), id(m['mask']), m['mask'].copy()) for m in masks] for i, masks in bank.items()}
                    context = getattr(bank, '_native_context', None)
                    remaining = [10, 10]
                    progress = []
                    with patch.object(common, 'make_masks', side_effect=AssertionError('Do not rebuild masks')):
                        columns = common.pack_one_columns(sources, bank, remaining, 285, 440, 4, 0, .5, 0,
                                                          progress=lambda count, left: progress.append((count, left)))
                    self.assertEqual(len(columns), 20)
                    self.assertEqual(remaining, [0, 0])
                    self.assertEqual(Counter(p['i'] for p in columns), {0: 10, 1: 10})
                    self.assertEqual(progress[-1], (20, 0))
                    self.valid(sources, [columns], 285, 440, 4, 0)
                    for i, masks in bank.items():
                        for before, mask in zip(snapshot[i], masks):
                            self.assertEqual(before[:2], (id(mask), id(mask['mask'])))
                            self.assertTrue((before[2] == mask['mask']).all())
                    if backend == 'rust':
                        self.assertIs(bank._native_context, context)
                        self.assertEqual(native.core_status(bank)['backend'], 'rust')

    def test_asymmetric_contour_is_rotated_not_mirrored_and_margins_remain_valid(self):
        polygon = Polygon([(0, 0), (8, 0), (8, 3), (3, 3), (3, 10), (0, 10)])
        sources = self.sources([polygon])
        for backend in ('python', 'rust'):
            with self.subTest(backend=backend), patch.dict(os.environ, PRINTFLOW_NESTING_CORE=backend, PRINTFLOW_NESTING_THREADS='1'):
                with common.make_masks(sources, self.cache, .5, [0], 3) as bank:
                    raw_remaining, remaining = [2], [2]
                    raw = common.pack_one(sources, bank, raw_remaining, 24, 28, 3, 2, .5, 17)
                    columns = common.pack_one_columns(sources, bank, remaining, 28, 24, 3, 2, .5, 17)
                    self.assertEqual(remaining, raw_remaining)
                    self.assertEqual(len(columns), 2)
                    self.valid(sources, [columns], 28, 24, 3, 2)
                    for before, after in zip(raw, columns):
                        raw_shape = affinity.translate(polygon, before['tx'], before['ty'])
                        expected = affinity.affine_transform(raw_shape, [0, -1, 1, 0, 28, 0])
                        actual = affinity.translate(affinity.rotate(polygon, after['angle'], origin=(0, 0)), after['tx'], after['ty'])
                        self.assertLess(expected.symmetric_difference(actual).area, 1e-8)

    def test_material_compares_columns_once_per_board_and_preserves_all_qt(self):
        sources = self.sources([box(0, 0, 76, 65)] * 2)
        args = SimpleNamespace(board_width=285, board_height=440, gap=4, margin=0, resolution=.5,
                               seed=0, runs=3, lookahead=1)
        with patch.dict(os.environ, PRINTFLOW_NESTING_CORE='rust', PRINTFLOW_NESTING_THREADS='1'):
            with common.make_masks(sources, self.cache, .5, list(range(0, 360, 15)), 4) as bank:
                quantities = [30, 30]
                with patch.object(common, 'pack_one_columns', wraps=common.pack_one_columns) as columns:
                    boards = common.pack_material_boards(sources, bank, quantities, args)
                self.assertEqual(len(boards), 3)
                self.assertEqual(Counter(p['i'] for board in boards for p in board), {0: 30, 1: 30})
                self.assertEqual(quantities, [30, 30])
                self.assertLessEqual(columns.call_count, len(boards))
                self.valid(sources, boards, 285, 440, 4, 0)

    def test_optional_column_memory_failure_keeps_complete_material_baseline(self):
        sources = self.sources([box(0, 0, 10, 10)])
        args = SimpleNamespace(board_width=30, board_height=25, gap=4, margin=0, resolution=.5,
                               seed=0, runs=3, lookahead=1)
        with patch.dict(os.environ, PRINTFLOW_NESTING_CORE='rust'):
            with common.make_masks(sources, self.cache, .5, [0, 90, 180, 270], 4) as bank:
                with patch.object(common, 'pack_one_columns', side_effect=MemoryError('optional candidate')):
                    boards = common.pack_material_boards(sources, bank, [10], args)
                self.assertEqual(sum(len(board) for board in boards), 10)
                self.valid(sources, boards, 30, 25, 4, 0)

    def test_column_failure_does_not_mutate_quantities(self):
        remaining = [4]
        def failed(_srcs, _bank, quantities, *_args, **_kwargs):
            quantities[0] -= 1
            raise MemoryError('incomplete search')
        with patch.object(common, 'pack_one', side_effect=failed), self.assertRaises(MemoryError):
            common.pack_one_columns([], {}, remaining, 30, 25, 4, 0, .5, 0)
        self.assertEqual(remaining, [4])


if __name__ == '__main__':
    unittest.main()
