"""Python/Rust differential and ABI ownership checks for the shared core.

Build a candidate with build_rust_core.ps1 -SkipDeploy, then set
PRINTFLOW_NESTING_CORE_LIBRARY to that candidate to run the native checks.
"""
from __future__ import annotations

import contextlib
import ctypes as ct
import gc
import io
import math
import os
from pathlib import Path
import pickle
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import weakref

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'src-tauri/src/imposition/local_nesting'))
import numpy as np
import nesting_common as common
import nesting_rust as native
from svg_benchmark_geometry import parse_sources


def mask_item(mask, angle=0, **extra):
    mask = np.asarray(mask, dtype=np.uint8)
    return dict(mask=mask, h=mask.shape[0], w=mask.shape[1], angle=angle, bx=.25, by=-.75, **extra)


def python_pack(*args, **kwargs):
    return getattr(common, '_pack_one_python', common.pack_one)(*args, **kwargs)


def run_native(*args, **kwargs):
    return native.dispatch(python_pack, *args, **kwargs)


class NativeFallbackTests(unittest.TestCase):
    def test_compact_template_search_fallback_is_included_after_context_close(self):
        bank = native.MaskBank()
        bank._native_status = dict(backend='rust', current_backend='rust', threads=8,
                                   rust_calls=3, python_calls=0, reason=None)
        bank._child_core_status = [dict(backend='mixed', rust_calls=2, python_calls=1,
                                       reason='temporary memory pressure', recovered=True)]
        bank.close()
        for _ in range(2):
            status = native.core_status(bank)
            self.assertEqual(status['backend'], 'mixed')
            self.assertEqual((status['rust_calls'], status['python_calls']), (5, 1))
            self.assertEqual(status['reason'], 'temporary memory pressure')
            self.assertTrue(status['recovered'])
        # Taking a snapshot must not fold counters back into the parent again.
        self.assertEqual(bank._native_status['rust_calls'], 3)

    def test_active_template_trial_reports_its_actual_backend_and_threads(self):
        parent, child = native.MaskBank(), native.MaskBank()
        parent._native_status = dict(backend='rust', current_backend='rust', threads=8,
                                    rust_calls=3, python_calls=0, reason=None)
        child._native_status = dict(backend='python', current_backend='python', threads=1,
                                   rust_calls=0, python_calls=2, reason='temporary memory pressure')
        parent._active_child_bank = child
        status = native.core_status(parent)
        self.assertEqual((status['backend'], status['current_backend']), ('mixed', 'python'))
        self.assertEqual(status['threads'], 1)
        self.assertEqual((status['rust_calls'], status['python_calls']), (3, 2))
        del parent._active_child_bank
        self.assertEqual(native.core_status(parent)['backend'], 'rust')

    def setUp(self):
        self.srcs = [dict(i=0, area=4)]
        self.bank = native.MaskBank({0: [mask_item(np.ones((2, 2), np.uint8))]})
        self.addCleanup(self.bank.close)

    def call(self, remaining, progress=None):
        return run_native(self.srcs, self.bank, remaining, 8, 7, 0, 0, 1, 42, progress=progress)

    def test_explicit_python_never_loads_native_library(self):
        with patch.dict(os.environ, PRINTFLOW_NESTING_CORE='python'), patch.object(native, '_load_library') as load:
            self.assertEqual(len(self.call([5])), 5)
        load.assert_not_called()
        self.assertEqual(native.core_status(self.bank)['backend'], 'python')

    def test_missing_library_is_explicit_in_rust_mode(self):
        with patch.dict(os.environ, PRINTFLOW_NESTING_CORE='rust', PRINTFLOW_NESTING_CORE_LIBRARY=str(ROOT / 'missing-native-core.dll')):
            with self.assertRaises(native.RustUnavailable):
                self.call([5])

    def test_auto_missing_library_falls_back_once_per_bank(self):
        log = io.StringIO()
        with (patch.dict(os.environ, PRINTFLOW_NESTING_CORE='auto', PRINTFLOW_NESTING_CORE_LIBRARY=str(ROOT / 'missing-native-core.dll')),
              contextlib.redirect_stderr(log)):
            first, second = self.call([5]), self.call([5])
        self.assertEqual(first, second)
        self.assertEqual(log.getvalue().count('PRINTFLOW_NESTING_CORE '), 1)
        self.assertEqual(native.core_status(self.bank)['backend'], 'python')
        self.assertIn('unavailable', native.core_status(self.bank)['reason'])

    def test_partial_native_failure_restarts_with_original_quantities(self):
        class FailingContext:
            closed = False
            def pack(_self, _sources, _bank, remaining, *_args):
                remaining[0] -= 2
                raise native.NativeCoreError('injected board failure')
            def close(_self):
                _self.closed = True
        context = FailingContext()
        self.bank._native_context = context
        baseline_remaining = [5]
        expected = python_pack(self.srcs, self.bank, baseline_remaining, 8, 7, 0, 0, 1, 42)
        remaining = [5]
        with patch.dict(os.environ, PRINTFLOW_NESTING_CORE='auto'), contextlib.redirect_stderr(io.StringIO()):
            actual = self.call(remaining)
        self.assertEqual(actual, expected)
        self.assertEqual(remaining, baseline_remaining)
        self.assertTrue(context.closed)
        self.assertIsNone(self.bank._native_context)

    def test_resource_guard_respects_commit_reserve_and_thread_cap(self):
        with patch.object(native, '_available_memory', return_value=400 * 1024**2), patch.dict(os.environ, PRINTFLOW_NESTING_THREADS='4'):
            workers, budget = native._resource_limits(1024)
            self.assertEqual(workers, 1)
            self.assertEqual(budget, 144 * 1024**2)
        with patch.object(native, '_available_memory', return_value=260 * 1024**2):
            with self.assertRaises(native.NativeResourceError):
                native._resource_limits(1024**2)
        with (patch.object(native, '_available_memory', return_value=4 * 1024**3),
              patch.object(native, '_available_cpu_count', return_value=8),
              patch.dict(os.environ, PRINTFLOW_NESTING_THREADS='999')):
            self.assertEqual(native._resource_limits(1024)[0], 8)

    def test_native_memory_codes_are_recoverable_but_invalid_arguments_are_not(self):
        context = native._NativeBank.__new__(native._NativeBank)
        context._lock, context._packing = native.threading.RLock(), False
        context.handle = ct.c_void_p()
        context.lib = types.SimpleNamespace(nc_last_error=lambda *_args: 0)
        for code in (2, 3):
            with self.subTest(code=code), self.assertRaises(native.NativeResourceError):
                context._check(code, 'pack')
        with self.assertRaises(native.NativeCoreError) as raised:
            context._check(1, 'pack')
        self.assertNotIsInstance(raised.exception, native.NativeResourceError)

    def test_repeated_fallback_does_not_retain_tracebacks_or_board_buffers(self):
        scratch_refs = []
        class FailingContext:
            def pack(_self, _sources, _bank, remaining, *_args):
                scratch = np.ones((32, 32), np.uint8)
                scratch_refs.append(weakref.ref(scratch))
                remaining[0] -= 1
                raise native.NativeCoreError('simulated native allocation failure')
            def close(_self):
                pass
        self.bank._native_context = FailingContext()
        expected = python_pack(self.srcs, self.bank, [5], 8, 7, 0, 0, 1, 42)
        with patch.dict(os.environ, PRINTFLOW_NESTING_CORE='auto'), contextlib.redirect_stderr(io.StringIO()):
            for _ in range(24):
                remaining = [5]
                self.assertEqual(self.call(remaining), expected)
                self.assertEqual(remaining, [0])
                failure = self.bank._native_failure
                self.assertEqual(len(failure), 3)
                self.assertFalse(any(isinstance(value, (BaseException, types.TracebackType)) for value in failure))
                self.assertIs(failure[1], False)
        gc.collect()
        self.assertEqual(len(scratch_refs), 1)
        self.assertIsNone(scratch_refs[0]())
        self.assertEqual(native.core_status(self.bank)['python_calls'], 24)

    def test_cached_missing_library_still_fails_explicit_rust_selection(self):
        with (patch.dict(os.environ, PRINTFLOW_NESTING_CORE='auto', PRINTFLOW_NESTING_CORE_LIBRARY=str(ROOT / 'missing-native-core.dll')),
              contextlib.redirect_stderr(io.StringIO())):
            self.call([5])
            self.assertIs(self.bank._native_failure[1], True)
            with patch.dict(os.environ, PRINTFLOW_NESTING_CORE='rust'):
                with self.assertRaises(native.RustUnavailable) as first:
                    self.call([5])
                with self.assertRaises(native.RustUnavailable) as second:
                    self.call([5])
                self.assertIsNot(first.exception, second.exception)

    def test_seeded_python_and_old_native_fallback_preserve_fixed_occupancy(self):
        seed = np.ones((7, 8), np.uint8)
        seed[1:3, 4:6] = 0
        snapshot = seed.copy()
        expected_remaining = [5]
        expected = python_pack(self.srcs, self.bank, expected_remaining, 8, 7, 0, 0, 1, 42,
                               initial_occupancy=seed)
        self.assertEqual(len(expected), 1)
        self.assertEqual(expected_remaining, [4])
        self.assertEqual((expected[0]['tx'], expected[0]['ty']), (3.75, 1.75))
        np.testing.assert_array_equal(seed, snapshot)
        class OldLibrary:
            pass
        context = native._NativeBank.__new__(native._NativeBank)
        # Call the actual symbol-selection path against an ABI 1 library that lacks only the extension.
        context.signature = native._bank_signature(self.bank)
        context.lib = OldLibrary()
        context.handle = ct.c_void_p()
        context._lock = native.threading.RLock()
        context._packing = False
        self.bank._native_context = context
        remaining = [5]
        with patch.dict(os.environ, PRINTFLOW_NESTING_CORE='rust'), contextlib.redirect_stderr(io.StringIO()):
            actual = run_native(self.srcs, self.bank, remaining, 8, 7, 0, 0, 1, 42, initial_occupancy=seed)
        self.assertEqual(actual, expected)
        self.assertEqual(remaining, [4])
        self.assertIn('seeded occupancy', native.core_status(self.bank)['reason'])
        np.testing.assert_array_equal(seed, snapshot)

    def test_seeded_validation_rejects_shape_dtype_values_and_memory_without_mutation(self):
        invalid = [np.zeros((7, 7), np.uint8), np.zeros((7, 8), np.float64), np.full((7, 8), 2, np.uint8)]
        for seed in invalid:
            remaining = [5]
            with self.subTest(shape=seed.shape, dtype=str(seed.dtype)), patch.dict(os.environ, PRINTFLOW_NESTING_CORE='python'):
                with self.assertRaises(ValueError):
                    common.pack_one(self.srcs, self.bank, remaining, 8, 7, 0, 0, 1, 42, initial_occupancy=seed)
            self.assertEqual(remaining, [5])
        with patch.object(native, '_available_memory', return_value=256 * 1024**2), patch.dict(os.environ, PRINTFLOW_NESTING_CORE='python'):
            with self.assertRaises(MemoryError):
                common.pack_one(self.srcs, self.bank, [5], 8, 7, 0, 0, 1, 42, initial_occupancy=np.zeros((7, 8), np.uint8))

    def test_pickled_bank_does_not_keep_native_handles_or_failures(self):
        self.bank._native_context = object()
        self.bank._native_failure = ('x', native.NativeCoreError('not persisted'))
        clone = pickle.loads(pickle.dumps(self.bank))
        self.bank._native_context = None
        self.assertIsInstance(clone, native.MaskBank)
        self.assertFalse(hasattr(clone, '_native_context'))
        self.assertFalse(hasattr(clone, '_native_failure'))


class NativeThreadPolicyTests(unittest.TestCase):
    def test_default_uses_all_available_logical_cpus_at_least_one(self):
        for available, expected in ((1, 1), (2, 2), (3, 3), (7, 7), (8, 8), (24, 24)):
            with (self.subTest(cpus=available), patch.dict(os.environ, {}, clear=True),
                  patch.object(native, '_available_cpu_count', return_value=available),
                  patch.object(native, '_available_memory', return_value=8 * 1024**3)):
                self.assertEqual(native._resource_limits(1024)[0], expected)

    def test_cpu_detection_uses_process_limit_and_unknown_is_one(self):
        with (patch.object(os, 'process_cpu_count', return_value=7, create=True),
              patch.object(os, 'cpu_count', return_value=24)):
            self.assertEqual(native._available_cpu_count(), 7)
        with (patch.object(os, 'process_cpu_count', return_value=None, create=True),
              patch.object(os, 'sched_getaffinity', side_effect=OSError('unavailable'), create=True),
              patch.object(os, 'cpu_count', return_value=None)):
            self.assertEqual(native._available_cpu_count(), 1)

    def test_manual_worker_count_accepts_all_integers_and_caps_at_cpu_count(self):
        for requested, expected in (('7', 7), ('8', 8), ('999', 12), ('0', 1)):
            with (self.subTest(requested=requested), patch.dict(os.environ, PRINTFLOW_NESTING_THREADS=requested),
                  patch.object(native, '_available_cpu_count', return_value=12),
                  patch.object(native, '_available_memory', return_value=8 * 1024**3)):
                self.assertEqual(native._resource_limits(1024)[0], expected)
        with patch.dict(os.environ, PRINTFLOW_NESTING_THREADS='four'):
            with self.assertRaisesRegex(ValueError, 'integer'):
                native._resource_limits(1024)

    def test_memory_headroom_reduces_workers_gradually(self):
        with (patch.dict(os.environ, PRINTFLOW_NESTING_THREADS='8'),
              patch.object(native, '_available_cpu_count', return_value=16),
              patch.object(native, '_available_memory', return_value=1024 * 1024**2)):
            # 768 MiB job budget - 600 MiB bank leaves room for five workers.
            workers, budget = native._resource_limits(600 * 1024**2)
            self.assertEqual(workers, 5)
            self.assertEqual(budget, 768 * 1024**2)


@unittest.skipUnless(Path(native._library_path()).is_file(), 'Build the native candidate and set PRINTFLOW_NESTING_CORE_LIBRARY')
class NativeDifferentialTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, PRINTFLOW_NESTING_CORE='rust')
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_memory_guard_recovers_during_python_sheet_without_changing_result(self):
        srcs = [dict(i=0, area=4)]
        bank = native.MaskBank({0: [mask_item(np.ones((2, 2), np.uint8))]})
        reference = native.MaskBank(dict(bank))
        self.addCleanup(bank.close)
        self.addCleanup(reference.close)
        expected_remaining = [5]
        expected = run_native(srcs, reference, expected_remaining, 8, 7, 0, 0, 1, 42)
        memory, clock = [120 * 1024**2], [0.]
        started = []
        def fallback(*args):
            started.append(True)
            forwarded = list(args)
            callback = forwarded[12]
            def after_one_placement(*counts):
                memory[0], clock[0] = 2 * 1024**3, 10.
                if callback:
                    callback(*counts)
            forwarded[12] = after_one_placement
            return python_pack(*forwarded)
        remaining = [5]
        with (patch.object(native, '_available_memory', side_effect=lambda: memory[0]),
              patch('time.monotonic', side_effect=lambda: clock[0]),
              contextlib.redirect_stderr(io.StringIO())):
            actual = native.dispatch(fallback, srcs, bank, remaining, 8, 7, 0, 0, 1, 42)
        self.assertEqual(actual, expected)
        self.assertEqual(remaining, expected_remaining)
        self.assertEqual(len(started), 1)
        self.assertEqual(native.core_status(bank)['backend'], 'rust')
        self.assertTrue(native.core_status(bank)['recovered'])
        self.assertFalse(hasattr(bank, '_native_failure'))

    def test_native_allocation_retries_one_worker_then_restores_requested_workers(self):
        srcs = [dict(i=0, area=4)]
        bank = native.MaskBank({0: [mask_item(np.ones((2, 2), np.uint8), angle)
                                   for angle in (0, 90, 180, 270)]})
        self.addCleanup(bank.close)
        clock = [0.]
        with (patch.dict(os.environ, PRINTFLOW_NESTING_THREADS='4'),
              patch.object(native, '_available_memory', return_value=2 * 1024**3),
              patch.object(native, '_available_cpu_count', return_value=4),
              patch('time.monotonic', side_effect=lambda: clock[0]),
              contextlib.redirect_stderr(io.StringIO())):
            expected = run_native(srcs, bank, [5], 8, 7, 0, 0, 1, 42)
            original = bank._native_context
            scratch_refs = []
            def fail(*args):
                scratch = np.ones((16, 16), np.uint8)
                scratch_refs.append(weakref.ref(scratch))
                args[2][0] -= 1
                raise native.NativeResourceError('simulated allocation failure')
            remaining = [5]
            with patch.object(original, 'pack', side_effect=fail):
                self.assertEqual(run_native(srcs, bank, remaining, 8, 7, 0, 0, 1, 42), expected)
            self.assertEqual(remaining, [0])
            limited = bank._native_context
            self.assertEqual(limited.worker_limit, 1)
            self.assertFalse(original.handle)
            self.assertTrue(native.core_status(bank)['recovered'])
            self.assertEqual(native.core_status(bank)['threads'], 1)
            self.assertEqual(native.core_status(bank)['python_calls'], 0)
            gc.collect()
            self.assertIsNone(scratch_refs[0]())
            clock[0] = 3.
            self.assertEqual(run_native(srcs, bank, [5], 8, 7, 0, 0, 1, 42), expected)
            self.assertIsNone(bank._native_context.worker_limit)
            self.assertFalse(limited.handle)
            self.assertEqual(bank._native_context.configured_workers, 4)

    def test_initial_memory_limited_context_recovers_workers_but_manual_one_is_preserved(self):
        srcs = [dict(i=0, area=4)]
        for requested, expected_workers in (('4', 4), ('1', 1)):
            with self.subTest(requested=requested):
                bank = native.MaskBank({0: [mask_item(np.ones((2, 2), np.uint8), angle)
                                           for angle in (0, 90, 180, 270)]})
                self.addCleanup(bank.close)
                memory, clock = [400 * 1024**2], [0.]
                with (patch.dict(os.environ, PRINTFLOW_NESTING_THREADS=requested),
                      patch.object(native, '_available_memory', side_effect=lambda: memory[0]),
                      patch.object(native, '_available_cpu_count', return_value=4),
                      patch('time.monotonic', side_effect=lambda: clock[0])):
                    first = run_native(srcs, bank, [5], 8, 7, 0, 0, 1, 42)
                    limited = bank._native_context
                    self.assertEqual(limited.configured_workers, 1)
                    self.assertIsNone(limited.worker_limit)
                    clock[0], memory[0] = 3., 2 * 1024**3
                    self.assertEqual(run_native(srcs, bank, [5], 8, 7, 0, 0, 1, 42), first)
                    self.assertEqual(bank._native_context.configured_workers, expected_workers)
                    if requested == '1':
                        self.assertIs(bank._native_context, limited)
                    else:
                        self.assertIsNot(bank._native_context, limited)
                        self.assertFalse(limited.handle)

    def test_short_python_sheets_do_not_postpone_memory_recovery_deadline(self):
        srcs = [dict(i=0, area=4)]
        bank = native.MaskBank({0: [mask_item(np.ones((2, 2), np.uint8))]})
        self.addCleanup(bank.close)
        memory, clock = [120 * 1024**2], [0.]
        with (patch.object(native, '_available_memory', side_effect=lambda: memory[0]),
              patch('time.monotonic', side_effect=lambda: clock[0]),
              contextlib.redirect_stderr(io.StringIO())):
            first = run_native(srcs, bank, [5], 8, 7, 0, 0, 1, 42)
            deadline = bank._native_resource_failure[3]
            for now in (.2, .4, .6, .8):
                clock[0] = now
                self.assertEqual(run_native(srcs, bank, [5], 8, 7, 0, 0, 1, 42), first)
                self.assertEqual(bank._native_resource_failure[3], deadline)
                self.assertFalse(hasattr(bank, '_native_failure'))
                self.assertFalse(any(isinstance(value, (BaseException, types.TracebackType))
                                     for value in bank._native_resource_failure))
            clock[0], memory[0] = 2., 2 * 1024**3
            self.assertEqual(run_native(srcs, bank, [5], 8, 7, 0, 0, 1, 42), first)
        status = native.core_status(bank)
        self.assertEqual(status['backend'], 'mixed')
        self.assertEqual(status['current_backend'], 'rust')
        self.assertEqual((status['rust_calls'], status['python_calls']), (1, 5))
        self.assertTrue(status['recovered'])
        self.assertFalse(hasattr(bank, '_native_resource_failure'))

    def test_python_recovery_callback_errors_propagate_without_committing_quantities(self):
        srcs = [dict(i=0, area=4)]
        bank = native.MaskBank({0: [mask_item(np.ones((2, 2), np.uint8))]})
        self.addCleanup(bank.close)
        remaining = [5]
        def progress(*_counts):
            raise MemoryError('user progress failure')
        with (patch.object(native, '_available_memory', return_value=120 * 1024**2),
              contextlib.redirect_stderr(io.StringIO()),
              self.assertRaisesRegex(MemoryError, 'user progress failure')):
            run_native(srcs, bank, remaining, 8, 7, 0, 0, 1, 42, progress=progress)
        self.assertEqual(remaining, [5])
        self.assertFalse(hasattr(bank, '_native_calls'))

    def test_recovery_during_a_sheet_is_bounded_when_native_allocation_keeps_failing(self):
        srcs = [dict(i=0, area=4)]
        bank = native.MaskBank({0: [mask_item(np.ones((2, 2), np.uint8))]})
        self.addCleanup(bank.close)
        clock, started = [0.], []
        def fallback(*args):
            started.append(True)
            clock[0] += 2.
            return python_pack(*args)
        with (patch.object(native, '_available_memory', return_value=2 * 1024**3),
              patch('time.monotonic', side_effect=lambda: clock[0]),
              patch.object(native._NativeBank, '_pack', side_effect=native.NativeResourceError('allocation')) as failed,
              contextlib.redirect_stderr(io.StringIO())):
            remaining = [5]
            result = native.dispatch(fallback, srcs, bank, remaining, 8, 7, 0, 0, 1, 42)
        self.assertEqual(len(result), 5)
        self.assertEqual(remaining, [0])
        self.assertEqual(failed.call_count, 3)
        self.assertEqual(len(started), 2)
        self.assertEqual(native.core_status(bank)['python_calls'], 1)
        self.assertFalse(hasattr(bank, '_native_failure'))

    def compare(self, srcs, bank, quantities, width=83, height=67, gap=0, margin=0,
                resolution=1, seed=0, mode='top', order='small', lookahead=1, threads='1', initial_occupancy=None):
        baseline_remaining, actual_remaining = list(quantities), list(quantities)
        baseline_progress, actual_progress = [], []
        args = (width, height, gap, margin, resolution, seed, mode, order, lookahead)
        expected = python_pack(srcs, bank, baseline_remaining, *args,
                               progress=lambda *values: baseline_progress.append(values), initial_occupancy=initial_occupancy)
        with patch.dict(os.environ, PRINTFLOW_NESTING_THREADS=threads):
            actual = run_native(srcs, bank, actual_remaining, *args,
                                progress=lambda *values: actual_progress.append(values), initial_occupancy=initial_occupancy)
        self.assertEqual(actual, expected)
        self.assertEqual(actual_remaining, baseline_remaining)
        self.assertEqual(actual_progress, baseline_progress)
        if isinstance(bank, native.MaskBank):
            self.assertEqual(native.core_status(bank)['backend'], 'rust', native.core_status(bank))
        return actual

    def test_seeded_search_matches_python_across_words_frames_and_threads(self):
        for width in (63, 64, 65, 129):
            for threads in ('1', '2', '4'):
                for frame in (False, True):
                    with self.subTest(width=width, threads=threads, frame=frame):
                        srcs = [dict(i=0, area=4, **({'frame': (2, 2)} if frame else {}))]
                        variants = [mask_item([[1, 1], [1, 1]], angle=k*90, **({'frame_width': 2, 'frame_height': 2} if frame else {})) for k in range(4)]
                        with native.MaskBank({0: variants}) as bank:
                            _, cols, rows = native.collision_grid(srcs, width, 7, 3, 0, .5)
                            # A noncontiguous view exercises the contiguous FFI conversion.
                            seed = np.ones((rows, cols * 2), np.uint8)[:, ::2]
                            seed[3:5, 63:65] = 0
                            snapshot = seed.copy()
                            result = self.compare(srcs, bank, [7], width=width, height=7, gap=3,
                                                  resolution=.5, threads=threads, initial_occupancy=seed)
                            self.assertEqual(len(result), 1)
                            np.testing.assert_array_equal(seed, snapshot)
                            # Reusing the native context must not retain last board's seed.
                            empty = self.compare(srcs, bank, [7], width=width, height=7, gap=3, resolution=.5)
                            self.assertEqual(len(empty), 7)

    def test_seeded_subset_source_keeps_other_source_quantities_untouched(self):
        srcs = [dict(i=3, area=4)]
        with native.MaskBank({0: [mask_item([[1]])], 3: [mask_item([[1, 1], [1, 1]])]}) as bank:
            seed = np.ones((7, 8), np.uint8)
            seed[1:3, 4:6] = 0
            remaining = [5, 11, 99, 7]
            result = run_native(srcs, bank, remaining, 8, 7, 0, 0, 1, 42, initial_occupancy=seed)
            self.assertEqual([entry['i'] for entry in result], [3])
            self.assertEqual(remaining, [5, 11, 99, 6])
            self.assertEqual(native.core_status(bank)['backend'], 'rust')

    def test_random_binary_masks_modes_orders_lookahead_and_rotations(self):
        rng = np.random.default_rng(7812)
        orders = ('small', 'large', 'random', 'balanced', 'mixed')
        for case in range(36):
            srcs, bank = [], native.MaskBank()
            for source in range(3):
                h, w = rng.integers(1, 18, size=2)
                mask = (rng.random((h, w)) < rng.uniform(.1, .95)).astype(np.uint8)
                srcs.append(dict(i=source, area=float(mask.sum())))
                bank[source] = [mask_item(np.rot90(mask, k), 90*k) for k in range(4)]
            try:
                with self.subTest(case=case):
                    self.compare(srcs, bank, [12, 9, 7], width=51 + case % 17, height=39 + case % 11,
                                 seed=case, mode=('top', 'bl', 'low')[case % 3],
                                 order=orders[case % 5], lookahead=1 + case % 4)
            finally:
                bank.close()

    def test_word_boundaries_and_all_zero_masks(self):
        for width in (1, 63, 64, 65, 127, 128, 129):
            masks = [np.ones((2, width), np.uint8), np.zeros((1, width), np.uint8)]
            for mask in masks:
                with self.subTest(width=width, empty=not mask.any()):
                    bank = native.MaskBank({0: [mask_item(mask)]})
                    try:
                        self.compare([dict(i=0, area=float(mask.sum()))], bank, [9], width=width * 2 + 1, height=5)
                    finally:
                        bank.close()

    def test_sparse_sources_shared_rotation_cache_and_thread_determinism(self):
        mask = np.array([[1, 1, 0], [1, 0, 0], [1, 1, 1]], np.uint8)
        variants = [mask_item(np.rot90(mask, k), (k % 4)*90) for k in range(8)]
        srcs = [dict(i=3, area=6), dict(i=1, area=6), dict(i=0, area=2)]
        results = []
        for threads in ('1', '2', '4', '7', '8'):
            bank = native.MaskBank({3: variants, 1: variants, 0: [mask_item([[1, 1]])]})
            try:
                results.append(self.compare(srcs, bank, [8, 20, 7, 30], width=29, height=17,
                                            order='random', seed=76, lookahead=3, threads=threads))
                self.assertEqual(native.core_status(bank)['mask_count'], 9)
                self.assertLessEqual(native.core_status(bank)['threads'], int(threads))
            finally:
                bank.close()
        self.assertTrue(all(result == results[0] for result in results[1:]))

    def test_quantity_above_1200_and_trials_share_one_native_bank(self):
        bank = native.MaskBank({0: [mask_item([[1]])]})
        try:
            self.compare([dict(i=0, area=1)], bank, [1201], width=35, height=35)
            first = bank._native_context
            first_memory = native.core_status(bank)['bank_bytes']
            self.compare([dict(i=0, area=1)], bank, [1230], width=35, height=35, seed=5)
            self.assertIs(bank._native_context, first)
            self.assertEqual(native.core_status(bank)['mask_count'], 1)
            self.assertLess(native.core_status(bank)['bank_bytes'] - first_memory, 4096)
        finally:
            bank.close()

    def test_input_order_preserves_sparse_source_mapping_and_shared_bank(self):
        sources = {i: dict(i=i, area=(4 - i) * 10) for i in (0, 1, 3)}
        with native.MaskBank({i: [mask_item([[1, 1], [1, 1]])] for i in sources}) as bank:
            context = None
            for order in ((3, 1, 0), (1, 0, 3), (0, 3, 1)):
                srcs = [sources[i] for i in order]
                result = self.compare(srcs, bank, [2, 2, 99, 2], width=6, height=4,
                                      order='input', lookahead=1, seed=123)
                self.assertEqual(result[0]['i'], order[0])
                remaining = [2, 2, 99, 2]
                run_native(srcs, bank, remaining, 6, 4, 0, 0, 1, 123, 'top', 'input', 1)
                self.assertEqual(remaining[2], 99)
                if context is not None:
                    self.assertIs(bank._native_context, context)
                context = bank._native_context

    def test_frame_edge_limits_nonintegral_grid_and_full_board_fit(self):
        srcs = [dict(i=0, area=217.21, frame=object())]
        bank = native.MaskBank({0: [mask_item(np.ones((22, 42), np.uint8),
                                             frame_width=20.3, frame_height=10.7)]})
        try:
            placed = self.compare(srcs, bank, [2], width=20.3, height=10.7, resolution=.5)
            self.assertEqual(len(placed), 1)
        finally:
            bank.close()

    def test_ties_keep_source_and_variant_order(self):
        variants = [mask_item([[1, 1]], 270), mask_item([[1, 1]], 90)]
        srcs = [dict(i=1, area=2), dict(i=0, area=2)]
        bank = native.MaskBank({0: variants, 1: variants})
        try:
            result = self.compare(srcs, bank, [4, 4], width=6, height=3, lookahead=2)
            self.assertEqual(result[0]['i'], 1)
            self.assertTrue(all(entry['angle'] == 270 for entry in result))
        finally:
            bank.close()

    def test_invalid_geometry_and_callback_exceptions_are_not_fallbacks(self):
        bank = native.MaskBank({0: [mask_item([[1]])]})
        srcs = [dict(i=0, area=1)]
        try:
            with self.assertRaisesRegex(ValueError, 'finite'):
                run_native(srcs, bank, [2], math.inf, 3, 0, 0, 1, 1)
            remaining = [2]
            def fail_progress(*_args):
                raise ValueError('progress consumer failed')
            with self.assertRaisesRegex(ValueError, 'progress consumer failed'):
                run_native(srcs, bank, remaining, 3, 3, 0, 0, 1, 1, progress=fail_progress)
            self.assertEqual(remaining, [2])
            self.compare(srcs, bank, [2], width=3, height=3)
        finally:
            bank.close()

    def test_context_destruction_plain_dict_and_bank_lifetime(self):
        srcs = [dict(i=0, area=1)]
        bank = native.MaskBank({0: [mask_item([[1]])]})
        self.compare(srcs, bank, [2], width=3, height=3)
        reference = weakref.ref(bank._native_context)
        del bank
        gc.collect()
        self.assertIsNone(reference())
        plain = {0: [mask_item([[1]])]}
        closed = []
        original_close = native._NativeBank.close
        def close(context):
            original_close(context)
            closed.append(context.handle.value)
        with patch.object(native._NativeBank, 'close', close):
            self.compare(srcs, plain, [2], width=3, height=3)
        self.assertTrue(closed)
        self.assertTrue(all(handle is None for handle in closed))

    def test_small_output_buffer_returns_error_and_context_can_be_reused(self):
        bank = native.MaskBank({0: [mask_item([[1]])]})
        try:
            self.compare([dict(i=0, area=1)], bank, [3], width=3, height=3)
            context = bank._native_context
            output = (native._Placement * 1)()
            self.assertNotEqual(context.lib.nc_copy_placements(context.handle, output, 1), 0)
            self.compare([dict(i=0, area=1)], bank, [2], width=3, height=3)
        finally:
            bank.close()

    def test_later_fallback_marks_the_job_mixed_and_releases_context(self):
        bank = native.MaskBank({0: [mask_item([[1]])]})
        srcs = [dict(i=0, area=1)]
        try:
            self.compare(srcs, bank, [3], width=3, height=3)
            context = bank._native_context
            with (patch.object(context, 'pack', side_effect=native.NativeCoreError('injected native error')),
                  contextlib.redirect_stderr(io.StringIO())):
                self.assertEqual(len(run_native(srcs, bank, [3], 3, 3, 0, 0, 1, 0)), 3)
            status = native.core_status(bank)
            self.assertEqual(status['backend'], 'mixed')
            self.assertEqual((status['rust_calls'], status['python_calls']), (1, 1))
            self.assertFalse(context.handle)
        finally:
            bank.close()

    def test_progress_callback_cannot_destroy_active_context(self):
        bank = native.MaskBank({0: [mask_item([[1]])]})
        srcs, remaining = [dict(i=0, area=1)], [3]
        try:
            with self.assertRaisesRegex(native.NativeCoreError, 'Cannot close'):
                run_native(srcs, bank, remaining, 3, 3, 0, 0, 1, 0, progress=lambda *_args: bank.close())
            self.assertEqual(remaining, [3])
            self.compare(srcs, bank, [3], width=3, height=3)
        finally:
            bank.close()

    def test_progress_callback_cannot_call_native_status_on_active_context(self):
        bank = native.MaskBank({0: [mask_item([[1]])]})
        srcs, remaining = [dict(i=0, area=1)], [3]
        try:
            with self.assertRaisesRegex(native.NativeCoreError, 'Cannot inspect'):
                run_native(srcs, bank, remaining, 3, 3, 0, 0, 1, 0,
                           progress=lambda *_args: bank._native_context.status())
            self.assertEqual(remaining, [3])
            self.compare(srcs, bank, [3], width=3, height=3)
        finally:
            bank.close()

    def test_real_svg_contours_match_python(self):
        fixtures = ROOT / 'printflow-data' / 'assets'
        paths = sorted(fixtures.glob('*/*.svg'), key=lambda p: p.stat().st_size)[:2]
        if not paths:
            self.skipTest('Production SVG fixtures are not present')
        sources = parse_sources(paths)
        with tempfile.TemporaryDirectory() as directory:
            bank = native.MaskBank(common.make_masks(sources, Path(directory), 2, [0, 90, 180, 270], 3))
            try:
                for mode in ('top', 'bl', 'low'):
                    self.compare(sources, bank, [4, 5], width=464, height=300, gap=3, margin=2,
                                 resolution=2, order='mixed', lookahead=2, mode=mode, seed=31)
            finally:
                bank.close()


if __name__ == '__main__':
    unittest.main()
