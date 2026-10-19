"""Independent real-core tests for 60:40 scoring and occupied-tail repair."""
from collections import Counter, defaultdict
import contextlib
import copy
import importlib.util
import io
import math
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import weakref
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('local_tools_engine', ROOT / 'src-tauri/src/imposition/local_nesting/local_tools_engine.py')
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)
import nest_combined
from nesting_rust import core_status
from shapely import affinity
from shapely.geometry import Polygon, box


def item(ident, quantity, width=10, height=8):
    return dict(id=ident, quantity=quantity, widthMm=width, heightMm=height,
                polygon=[[0, 0], [width, 0], [width, height], [0, height]])


def request(items, width=50, height=35, objective='combined'):
    return dict(plateWidthMm=width + 15, plateHeightMm=height + 20,
                effectiveWidthMm=width, effectiveHeightMm=height, effectiveRightMm=5,
                spacingMm=3, objective=objective, items=items)


def round_ui(value):
    return math.floor(value * 100 + .5) / 100


def result_score(req, result):
    sources = {entry['id']: entry for entry in req['items']}
    pages = defaultdict(list)
    for placement in result['placements']:
        source = sources[placement['id'].split('#qt-')[0]]
        shape = tuple((round_ui(x), round_ui(y)) for x, y in source['polygon'])
        pages[placement['sheetIndex']].append((shape, round_ui(source['widthMm']), round_ui(source['heightMm']),
                                              round_ui(placement['xMm']), round_ui(placement['yMm']),
                                              round_ui(placement['rotationDeg'] % 360)))
    programs = {tuple(sorted(page)) for page in pages.values()}
    return 3 * len(pages) + 2 * len(programs), len(pages), len(programs)


class CombinedNestingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='printflow-combined-')
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name)

    def solve(self, req):
        with contextlib.redirect_stderr(io.StringIO()):
            return engine.solve(req, cache_dir=self.cache)

    def setup_core(self, items, width=50, height=35):
        srcs = [engine._source(entry, index, self.cache) for index, entry in enumerate(items)]
        bank = engine.make_masks(srcs, self.cache, .5, list(range(0, 360, 15)), 3)
        self.addCleanup(bank.close)
        args = SimpleNamespace(board_width=width, board_height=height, gap=3, margin=0,
                               resolution=.5, seed=0, runs=3, lookahead=1)
        job = dict(srcs=srcs, bank=bank, quantities=[entry['quantity'] for entry in items])
        validate = lambda boards: engine._validate_boards(srcs, boards, width, height, 3)
        return job, args, validate

    def verify(self, req, result):
        expected = {entry['id']: entry['quantity'] for entry in req['items']}
        actual = Counter(p['id'].split('#qt-')[0] for p in result['placements'])
        self.assertEqual(actual, expected)
        self.assertEqual(len({p['id'] for p in result['placements']}), sum(expected.values()))
        self.assertFalse(result['unplaced'])
        self.assertFalse(result['excludedItems'])
        if os.environ.get('PRINTFLOW_NESTING_CORE') == 'rust':
            self.assertEqual(result['searchCore']['backend'], 'rust', result.get('warnings'))
        sources = {entry['id']: entry for entry in req['items']}
        left = req['plateWidthMm'] - req['effectiveRightMm'] - req['effectiveWidthMm']
        top = (req['plateHeightMm'] - req['effectiveHeightMm']) / 2
        region = box(left, top, left + req['effectiveWidthMm'], top + req['effectiveHeightMm']).buffer(1e-7)
        pages = defaultdict(list)
        for placement in result['placements']:
            source = sources[placement['id'].split('#qt-')[0]]
            frame = affinity.rotate(box(0, 0, source['widthMm'], source['heightMm']), placement['rotationDeg'], origin=(0, 0))
            min_x, min_y, _, _ = frame.bounds
            tx, ty = placement['xMm'] - min_x, placement['yMm'] - min_y
            polygon = affinity.translate(affinity.rotate(Polygon(source['polygon']), placement['rotationDeg'], origin=(0, 0)), tx, ty)
            self.assertTrue(region.covers(affinity.translate(frame, tx, ty)))
            self.assertTrue(region.covers(polygon))
            for other in pages[placement['sheetIndex']]:
                self.assertLessEqual(polygon.intersection(other).area, 1e-7)
                self.assertGreaterEqual(polygon.distance(other), req['spacingMm'] - 1e-6)
            pages[placement['sheetIndex']].append(polygon)

    def test_real_combined_result_never_worse_than_either_complete_baseline(self):
        req = request([item('a', 23, 10, 8), item('b', 12, 13, 7), item('c', 7, 8, 17)])
        material = self.solve(dict(req, objective='least-material'))
        uniform = self.solve(dict(req, objective='least-cutting'))
        with patch.object(engine, 'make_masks', wraps=engine.make_masks) as masks:
            combined = self.solve(req)
        self.verify(req, combined)
        self.assertTrue(combined['algorithm'].startswith('tools/combined'))
        self.assertNotIn('旧综合最少', ' '.join(combined['warnings']))
        self.assertLessEqual(result_score(req, combined), min(result_score(req, material), result_score(req, uniform)))
        self.assertEqual(masks.call_count, 3, 'Each unique contour is built once for both baselines and repair')
        metrics = combined['combinedDiagnostics']
        self.assertEqual(metrics['weights'], {'sheets': 3, 'cuttingLayouts': 2})
        self.assertEqual(set(metrics['baselines']), {'uniform', 'material'})
        self.assertEqual((metrics['final']['score'], metrics['final']['sheets'], metrics['final']['cuttingLayouts']), result_score(req, combined))
        self.assertLessEqual(metrics['seededSearches'], nest_combined.MAX_REPAIR_SEARCHES)

    def test_true_occupied_search_improves_a_constructed_valid_two_sheet_plan(self):
        job, args, validate = self.setup_core([item('a', 1), item('b', 1)], width=25, height=10)
        before = [[dict(i=0, angle=0, tx=0, ty=0)], [dict(i=1, angle=0, tx=0, ty=0)]]
        original = copy.deepcopy(before)
        diagnostics = {}
        after = nest_combined.improve_occupied_boards(job, args, before, validate=validate, diagnostics=diagnostics)
        self.assertEqual(before, original)
        self.assertEqual(Counter(p['i'] for board in after for p in board), {0: 1, 1: 1})
        self.assertEqual(len(after), 1)
        self.assertEqual(diagnostics['acceptedRepairs'], 1)
        self.assertGreater(diagnostics['seededSearches'], 0)
        self.assertEqual(diagnostics['final']['score'], 5)
        validate(after)
        if os.environ.get('PRINTFLOW_NESTING_CORE') == 'rust':
            self.assertEqual(core_status(job['bank'])['backend'], 'rust')

    def test_repeated_receivers_do_not_hide_a_different_feasible_template(self):
        job, args, validate = self.setup_core([item('blocked', 9), item('open', 1), item('tail', 1)], width=25, height=10)
        blocked = [dict(i=0, angle=0, tx=7.5, ty=0)]
        before = [blocked] * 9 + [[dict(i=1, angle=0, tx=0, ty=0)], [dict(i=2, angle=0, tx=7.5, ty=0)]]
        after = nest_combined.improve_occupied_boards(job, args, before, validate=validate)
        self.assertLess(len(after), len(before), 'Identical blocked receivers must not consume all distinct-template search slots')
        validate(after)

    def test_template_repair_releases_fixed_positions_to_remove_fragmented_space(self):
        job, args, validate = self.setup_core([item('a', 1), item('b', 1)], width=25, height=10)
        before = [[dict(i=0, angle=0, tx=7.5, ty=0)], [dict(i=1, angle=0, tx=7.5, ty=0)]]
        original = copy.deepcopy(before)
        fixed_only = nest_combined.improve_occupied_boards(job, args, before, validate=validate)
        self.assertEqual(len(fixed_only), 2)
        after = nest_combined.improve_template_boards(job, args, before, validate=validate)
        self.assertEqual(len(after), 1)
        self.assertEqual(Counter(p['i'] for board in after for p in board), {0: 1, 1: 1})
        self.assertEqual(before, original)
        validate(after)

    def test_template_repair_reallocates_repeats_without_mixing_artwork_quantities(self):
        job, args, validate = self.setup_core([item('red', 6), item('blue', 6)], width=25, height=20)
        red = [dict(i=0, angle=0, tx=7.5, ty=y) for y in (0, 11)]
        blue = [dict(i=1, angle=0, tx=7.5, ty=y) for y in (0, 11)]
        before = [red] * 3 + [blue] * 3
        original = copy.deepcopy(before)
        diagnostics = {}
        after = nest_combined.improve_template_boards(job, args, before, validate=validate, diagnostics=diagnostics)
        self.assertEqual(len(after), 3)
        self.assertEqual(Counter(p['i'] for board in after for p in board), {0: 6, 1: 6})
        self.assertEqual(before, original)
        self.assertGreater(diagnostics['acceptedTemplateRepairs'], 0)
        self.assertLessEqual(diagnostics['templateSearches'], nest_combined.MAX_TEMPLATE_SEARCHES)
        self.assertTrue(diagnostics['templateImprovements'])
        validate(after)

    def test_template_repair_rejects_invalid_search_and_retains_complete_baseline(self):
        job, args, validate = self.setup_core([item('a', 1), item('b', 1)], width=25, height=10)
        before = [[dict(i=0, angle=0, tx=7.5, ty=0)], [dict(i=1, angle=0, tx=7.5, ty=0)]]
        def overlapping(_srcs, _bank, remaining, *_args, **_kwargs):
            remaining[:] = [0, 0]
            return [dict(i=i, angle=0, tx=0, ty=0) for i in (0, 1)]
        with patch.object(nest_combined, 'pack_one', side_effect=overlapping):
            after = nest_combined.improve_template_boards(job, args, before, validate=validate)
        self.assertIs(after, before)
        validate(after)

    def test_cutting_key_uses_original_contour_dimensions_normalized_rotation_and_canvas_origin(self):
        a, b, c = item('a', 1), item('b', 1), item('c', 1, 12, 8)
        c['polygon'] = a['polygon']
        job, args, validate = self.setup_core([a, b, c])
        scorer = nest_combined.CuttingScore(job['srcs'], origin=(10.127, 10.891))
        a_board = [dict(i=0, angle=0, tx=3.127, ty=2.891)]
        b_board = [dict(i=1, angle=360, tx=3.127, ty=2.891)]
        c_board = [dict(i=2, angle=0, tx=3.127, ty=2.891)]
        self.assertEqual(scorer.score([a_board, b_board])[:3], (8, 2, 1))
        self.assertEqual(scorer.score([a_board, c_board])[:3], (10, 2, 2))
        key, _ = scorer.board(a_board)
        self.assertEqual(key[0][1:3], (round_ui(13.254), round_ui(13.782)))
        self.assertEqual(scorer.score([a_board] * 50 + [c_board] * 19)[0], 211)
        # The requested 60:40 tradeoff chooses 45/9 over 48/8 and 50/19.
        self.assertEqual(min((3*50 + 2*19, 50, 19), (3*48 + 2*8, 48, 8), (3*45 + 2*9, 45, 9)), (153, 45, 9))
        # Equal cost prefers fewer sheets, rather than renormalizing baselines.
        self.assertLess((3*10 + 2*5, 10, 5), (3*12 + 2*2, 12, 2))

    def test_invalid_repair_is_discarded_and_valid_baseline_survives(self):
        job, args, validate = self.setup_core([item('a', 2)], width=25, height=10)
        before = [[dict(i=0, angle=0, tx=0, ty=0)], [dict(i=0, angle=0, tx=0, ty=0)]]
        def overlapping(_srcs, _bank, remaining, *_args, **_kwargs):
            remaining[:] = [0]
            return [dict(i=0, angle=0, tx=0, ty=0)]
        diagnostics = {}
        with patch.object(nest_combined, 'pack_one', side_effect=overlapping):
            after = nest_combined.improve_occupied_boards(job, args, before, validate=validate, diagnostics=diagnostics)
        self.assertIs(after, before)
        self.assertGreater(diagnostics['rejectedCandidates'], 0)
        validate(after)

    def test_one_failed_baseline_keeps_the_other_valid_complete_plan(self):
        req = request([item('a', 5)])
        with patch.object(nest_combined, 'pack_material_boards', side_effect=ValueError('material failed')):
            result = self.solve(req)
        self.verify(req, result)
        self.assertIn('uniform', result['combinedDiagnostics']['baselines'])
        self.assertIn('material failed', result['combinedDiagnostics']['baselineFailures'][0])

    def test_search_memory_pressure_retries_the_whole_job_at_one_mm(self):
        req = request([item('a', 5)], width=25, height=10)
        uniform, material = nest_combined.pack_uniform_boards, nest_combined.pack_material_boards
        resolutions = []
        def uniform_with_pressure(job, args, progress=None):
            resolutions.append(('uniform', args.resolution))
            if args.resolution == .5:
                raise MemoryError('simulated uniform search allocation')
            return uniform(job, args, progress)
        def material_with_pressure(srcs, bank, quantities, args, **kwargs):
            resolutions.append(('material', args.resolution))
            if args.resolution == .5:
                raise MemoryError('simulated material search allocation')
            return material(srcs, bank, quantities, args, **kwargs)
        with patch.object(nest_combined, 'pack_uniform_boards', side_effect=uniform_with_pressure), \
                patch.object(nest_combined, 'pack_material_boards', side_effect=material_with_pressure), \
                patch.object(engine, 'make_masks', wraps=engine.make_masks) as masks:
            result = self.solve(req)
        self.verify(req, result)
        self.assertEqual(resolutions, [('uniform', .5), ('material', .5), ('uniform', 1.), ('material', 1.)])
        self.assertEqual([call.args[2] for call in masks.call_args_list], [.5, 1.])
        self.assertTrue(any('1 mm' in warning for warning in result['warnings']))
        self.assertEqual(set(result['combinedDiagnostics']['baselines']), {'uniform', 'material'})

    def test_memory_pressure_in_one_baseline_keeps_the_other_without_restarting(self):
        req = request([item('a', 5)], width=25, height=10)
        with patch.object(nest_combined, 'pack_material_boards', side_effect=MemoryError('material allocation')), \
                patch.object(engine, 'make_masks', wraps=engine.make_masks) as masks:
            result = self.solve(req)
        self.verify(req, result)
        self.assertEqual([call.args[2] for call in masks.call_args_list], [.5])
        self.assertEqual(set(result['combinedDiagnostics']['baselines']), {'uniform'})
        self.assertIn('material allocation', result['combinedDiagnostics']['baselineFailures'][0])

    def test_coarse_retry_releases_failed_search_traceback_before_reallocating(self):
        class SearchBuffers:
            pass
        buffer_refs = []
        resolutions = []
        def failing_then_successful(_request, **kwargs):
            resolution = kwargs.get('resolution', .5)
            resolutions.append(resolution)
            if resolution == .5:
                buffers = SearchBuffers()
                buffer_refs.append(weakref.ref(buffers))
                raise MemoryError('search buffers could not grow')
            self.assertIsNone(buffer_refs[0](), 'The failed 0.5 mm search frame must be released before 1 mm allocations')
            return dict(warnings=[])
        with patch.object(engine, '_solve', side_effect=failing_then_successful):
            result = self.solve(request([item('a', 1)]))
        self.assertEqual(resolutions, [.5, 1.])
        self.assertTrue(any('1 mm' in warning for warning in result['warnings']))

    def test_1800_qt_of_different_artwork_with_equal_contours_share_cutting_programs(self):
        req = request([item('red-art', 900), item('blue-art', 900)], width=25, height=10)
        with patch.object(engine, 'make_masks', wraps=engine.make_masks) as masks:
            result = self.solve(req)
        self.verify(req, result)
        self.assertEqual(masks.call_count, 1)
        self.assertEqual(result_score(req, result), (2702, 900, 1))
        self.assertLessEqual(result['combinedDiagnostics']['seededSearches'], 32)

    def test_arbitrary_angle_fixed_frame_is_preserved_by_additional_search(self):
        job, args, validate = self.setup_core([item('a', 1), item('b', 1)], width=100, height=80)
        angle = 37.25
        frame = affinity.rotate(job['srcs'][0]['frame'], angle, origin=(0, 0))
        min_x, min_y, _, _ = frame.bounds
        anchor = dict(i=0, angle=angle, tx=19.237 - min_x, ty=17.891 - min_y)
        before = [[anchor], [dict(i=1, angle=0, tx=0, ty=0)]]
        after = nest_combined.improve_occupied_boards(job, args, before, validate=validate)
        self.assertEqual(len(after), 1)
        self.assertIn(anchor, after[0])
        validate(after)

    def test_combined_alias_and_template_repack_tail_use_actual_combined_solver(self):
        req = request([item('cat', 5), item('flower', 2)], width=25, height=10, objective='least-combined')
        normal = self.solve(req)
        self.assertTrue(normal['algorithm'].startswith('tools/combined'))
        position = lambda ident, x: dict(sourceId=ident, xMm=x + 10, yMm=10, rotationDeg=0)
        req['objective'] = 'combined'
        req['templateRepack'] = dict(templates=[
            dict(id='A', repeatCount=5, placements=[position('cat', 0)]),
            dict(id='B', repeatCount=2, placements=[position('flower', 0)]),
        ], sourceTemplateId='A', targetTemplateId='B', sourceSlotIndex=0,
            targetPlacement=position('cat', 15))
        with patch.object(nest_combined, 'pack_combined_boards', wraps=nest_combined.pack_combined_boards) as combined:
            result = self.solve(req)
        self.assertEqual(combined.call_count, 1)
        self.verify(req, result)
        self.assertTrue(any(p['id'].split('#qt-')[0] == 'cat' and p['xMm'] == 25 and p['yMm'] == 10 for p in result['placements']))

    def assert_monotone_search_progress(self, events):
        self.assertTrue(events)
        self.assertEqual({total for _, _, total in events}, {1000})
        done = [value for _, value, _ in events]
        self.assertEqual(done, sorted(done))
        self.assertEqual(done[0], 0)
        self.assertEqual(done[-1], 1000)
        self.assertIn(400, done)
        self.assertIn(800, done)
        self.assertTrue(all(detail.startswith('搜索进度 · ') for detail, _, _ in events))

    def test_progress_names_both_baselines_reports_counts_and_preserves_result(self):
        job, args, validate = self.setup_core([item('a', 23), item('b', 12, 13, 7), item('c', 7, 8, 17)])
        expected = nest_combined.pack_combined_boards(job, args, validate=validate)
        events = []
        actual = nest_combined.pack_combined_boards(job, args, lambda *event: events.append(event), validate=validate)
        self.assertEqual(actual, expected, 'Progress reporting must not change any placements or trial decisions')
        self.assert_monotone_search_progress(events)
        uniform = [(text, done) for text, done, _ in events if '切割方案优先基线：第 ' in text]
        material = [(text, done) for text, done, _ in events if '节省板材基线：第 ' in text]
        self.assertTrue(uniform)
        self.assertTrue(material)
        self.assertTrue(any(0 < done < 400 for _, done in uniform))
        self.assertTrue(any(400 < done < 800 for _, done in material))
        for detail, _ in uniform:
            self.assertRegex(detail, r'第 \d+ 套方案，尝试复用 \d+ 块；单板放入 \d+ 张，尚余 \d+ QT')
        for detail, _ in material:
            self.assertRegex(detail, r'第 \d+ 块板材，第 \d+ 次试排；本板放入 \d+ 张，本轮尚余 \d+ QT')
        self.assertTrue(any(800 < done < 1000 for _, done, _ in events))

    def test_failed_baseline_advances_to_next_phase_without_regressing(self):
        for strategy in ('uniform', 'material'):
            with self.subTest(strategy=strategy):
                job, args, validate = self.setup_core([item('a', 5)], width=25, height=10)
                events = []
                method = 'pack_uniform_boards' if strategy == 'uniform' else 'pack_material_boards'
                def fail(*call_args, **kwargs):
                    callback = call_args[2] if strategy == 'uniform' else kwargs['progress']
                    callback(0, 1, 3, 2)
                    callback(0, 2, 1, 4)  # A new trial can report more remaining QT.
                    raise ValueError('intentional baseline failure')
                with patch.object(nest_combined, method, side_effect=fail):
                    result = nest_combined.pack_combined_boards(job, args, lambda *event: events.append(event), validate=validate)
                self.assertEqual(sum(map(len, result)), 5)
                self.assert_monotone_search_progress(events)
                errors = [(text, done) for text, done, _ in events if '未形成合法结果' in text]
                self.assertEqual(len(errors), 1)
                self.assertEqual(errors[0][1], 400 if strategy == 'uniform' else 800)


if __name__ == '__main__':
    unittest.main()
