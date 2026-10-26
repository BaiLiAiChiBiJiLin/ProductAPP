"""Optional native single-sheet search; geometry and heuristics stay in Python.

MaskBank owns its native context for one job. Plain dictionaries are supported
with a temporary context, so no global cache keeps artwork or jobs alive.
"""
from __future__ import annotations

import ctypes as ct
import json
import math
import operator
import os
from pathlib import Path
import random
import sys
import threading
import time
from functools import lru_cache

import numpy as np

_MIB = 1024 * 1024
_U32 = 2**32 - 1
_U64 = 2**64 - 1
_I32 = 2**31 - 1
_ROOT = Path(__file__).resolve().parents[4]


class NativeCoreError(RuntimeError):
    """Recoverable native allocation, ABI, or execution failure."""


class RustUnavailable(NativeCoreError):
    """The requested native library cannot be loaded."""


class NativeResourceError(NativeCoreError):
    """Temporary allocation pressure; never disable Rust for the whole job."""

    def __init__(self, message, minimum_available=260 * _MIB):
        super().__init__(message)
        self.minimum_available = minimum_available


class _RetryNative(BaseException):
    """Unwind a Python trial before retrying its original quantity vector."""


class _CallbackFailure(BaseException):
    def __init__(self, error):
        self.error = error


class _Source(ct.Structure):
    _fields_ = [('first_mask', ct.c_uint32), ('mask_count', ct.c_uint32)]


class _Limit(ct.Structure):
    _fields_ = [('max_x', ct.c_int32), ('max_y', ct.c_int32)]


class _Config(ct.Structure):
    _fields_ = [('cols', ct.c_uint32), ('rows', ct.c_uint32),
                ('lookahead', ct.c_uint32), ('reserved', ct.c_uint32),
                ('weight', ct.c_double), ('height_weight', ct.c_double)]


class _Placement(ct.Structure):
    _fields_ = [('source_index', ct.c_uint32), ('mask_index', ct.c_uint32),
                ('x', ct.c_uint32), ('y', ct.c_uint32)]


_Progress = ct.CFUNCTYPE(None, ct.c_uint64, ct.c_uint64, ct.c_void_p)


class MaskBank(dict):
    """A job-scoped mask dictionary; do not mutate masks after first search."""

    def close(self):
        context = getattr(self, '_native_context', None)
        if context is not None:
            context.close()
            self._native_context = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def __reduce_ex__(self, _protocol):
        # Cached masks never serialize a DLL handle, failure, or job status.
        return MaskBank, (dict(self),)


def core_status(bank):
    """Return a copy of this job's actual backend status for UI/reporting."""
    return dict(getattr(bank, '_native_status', dict(
        requested=os.environ.get('PRINTFLOW_NESTING_CORE', 'auto').lower(),
        backend='python', threads=1, reason=None, mask_count=0, bank_bytes=0)))


def _record_status(bank, status):
    status['current_backend'] = status['backend']
    if isinstance(bank, MaskBank):
        counts = getattr(bank, '_native_calls', {'rust': 0, 'python': 0})
        counts[status['backend']] += 1
        bank._native_calls = counts
        status.update(rust_calls=counts['rust'], python_calls=counts['python'])
        if counts['rust'] and counts['python']:
            status['backend'] = 'mixed'
        bank._native_status = status


def _library_path():
    override = os.environ.get('PRINTFLOW_NESTING_CORE_LIBRARY')
    if override:
        return str(Path(override).expanduser().resolve())
    name = 'printflow_nesting_core.dll' if os.name == 'nt' else (
        'libprintflow_nesting_core.dylib' if sys.platform == 'darwin' else 'libprintflow_nesting_core.so')
    return str(_ROOT / '.tools' / 'nesting' / 'native' / name)


@lru_cache(maxsize=4)
def _load_library(path):
    try:
        lib = ct.CDLL(path)
        lib.nc_abi_version.argtypes = []
        lib.nc_abi_version.restype = ct.c_uint32
        if lib.nc_abi_version() != 1:
            raise RustUnavailable(f'Unsupported Rust nesting ABI: {path}')
        functions = {
            'nc_create': ([ct.c_uint32, ct.c_uint64, ct.POINTER(ct.c_void_p)], ct.c_int32),
            'nc_add_mask': ([ct.c_void_p, ct.POINTER(ct.c_uint8), ct.c_size_t,
                             ct.c_uint32, ct.c_uint32, ct.POINTER(ct.c_uint32)], ct.c_int32),
            'nc_pack': ([ct.c_void_p, ct.POINTER(_Config), ct.POINTER(_Source), ct.c_size_t,
                        ct.POINTER(ct.c_uint32), ct.c_size_t, ct.POINTER(_Limit), ct.c_size_t,
                        ct.POINTER(ct.c_uint32), ct.c_size_t, ct.POINTER(ct.c_uint64),
                        ct.c_size_t, _Progress, ct.c_void_p], ct.c_int32),
            'nc_placement_count': ([ct.c_void_p], ct.c_size_t),
            'nc_copy_placements': ([ct.c_void_p, ct.POINTER(_Placement), ct.c_size_t], ct.c_int32),
            'nc_destroy': ([ct.c_void_p], None),
            'nc_last_error': ([ct.c_void_p, ct.POINTER(ct.c_uint8), ct.c_size_t], ct.c_size_t),
            'nc_memory_used': ([ct.c_void_p], ct.c_uint64),
            'nc_worker_count': ([ct.c_void_p], ct.c_uint32),
        }
        for name, (args, result) in functions.items():
            function = getattr(lib, name)
            function.argtypes, function.restype = args, result
        seeded = getattr(lib, 'nc_pack_seeded', None)
        if seeded is not None:
            seeded.argtypes = functions['nc_pack'][0][:-2] + [ct.POINTER(ct.c_uint8), ct.c_size_t] + functions['nc_pack'][0][-2:]
            seeded.restype = ct.c_int32
        return lib
    except (OSError, AttributeError) as exc:
        raise RustUnavailable(f'Rust nesting library unavailable: {path} ({exc})') from exc


def _available_memory():
    if os.name == 'nt':
        class MemoryStatus(ct.Structure):
            _fields_ = [('length', ct.c_uint32), ('load', ct.c_uint32)] + [
                (name, ct.c_uint64) for name in ('total_phys', 'avail_phys', 'total_page',
                                               'avail_page', 'total_virtual', 'avail_virtual', 'avail_extended')]
        status = MemoryStatus()
        status.length = ct.sizeof(status)
        function = ct.windll.kernel32.GlobalMemoryStatusEx
        function.argtypes, function.restype = [ct.POINTER(MemoryStatus)], ct.c_int
        if function(ct.byref(status)):
            return min(status.avail_phys, status.avail_page)
    else:
        try:
            return os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
        except (AttributeError, OSError, ValueError):
            pass
    # Unknown memory availability gets a conservative budget and one worker.
    return 384 * _MIB


def _available_cpu_count():
    """Honor process CPU availability when supported, with a one-CPU fallback."""
    process_count = getattr(os, 'process_cpu_count', None)
    affinity = getattr(os, 'sched_getaffinity', None)
    readers = ([process_count] if process_count is not None else [])
    if affinity is not None:
        readers.append(lambda: len(affinity(0)))
    readers.append(os.cpu_count)
    for reader in readers:
        try:
            count = reader()
            if count is not None and count > 0:
                return int(count)
        except (OSError, ValueError, NotImplementedError):
            pass
    return 1


def _resource_limits(estimated_bank, worker_limit=None):
    available_cpus = _available_cpu_count()
    value = os.environ.get('PRINTFLOW_NESTING_THREADS')
    if value is None:
        workers = available_cpus
    else:
        try:
            workers = max(1, min(available_cpus, int(value)))
        except ValueError as exc:
            raise ValueError('PRINTFLOW_NESTING_THREADS must be a positive integer CPU count') from exc
    available = _available_memory()
    budget = max(0, available - 256 * _MIB)
    if estimated_bank + 4 * _MIB > budget:
        raise NativeResourceError('Insufficient available physical/commit memory for the Rust mask bank',
                                  estimated_bank + 260 * _MIB)
    if available < 768 * _MIB:
        workers = 1
    else:
        # Masks are shared, but retain headroom for stacks, allocator overhead,
        # Python validation and the UI instead of multiplying copies per QT.
        workers = min(workers, max(1, (budget - estimated_bank) // (32 * _MIB)))
    if worker_limit is not None:
        workers = min(workers, worker_limit)
    return workers, budget


def _integer(value, label, maximum=_U32):
    try:
        result = operator.index(value)
    except TypeError as exc:
        raise ValueError(f'{label} must be an integer') from exc
    if result < 0 or result > maximum:
        raise ValueError(f'{label} is out of range')
    return result



def collision_grid(srcs, board_w, board_h, gap, margin, res):
    """Shared world-to-raster contract for empty and seeded single-sheet search."""
    for value, label in ((board_w, 'Board width'), (board_h, 'Board height'),
                         (gap, 'Gap'), (margin, 'Margin'), (res, 'Resolution')):
        if not math.isfinite(float(value)):
            raise ValueError(f'{label} must be finite')
    if board_w <= 0 or board_h <= 0 or res <= 0 or gap < 0 or margin < 0:
        raise ValueError('Board dimensions/resolution must be positive and gap/margin nonnegative')
    if any(s.get('frame') is not None for s in srcs):
        origin = margin - (gap / 2 + .12)
        cols = math.ceil((board_w - 2 * origin + 1e-7) / res)
        rows = math.ceil((board_h - 2 * origin + 1e-7) / res)
    else:
        origin = margin + .12 - (gap / 2 + .12)
        cols = int((board_w - 2 * origin) // res)
        rows = int((board_h - 2 * origin) // res)
    _integer(cols, 'Grid columns', _I32)
    _integer(rows, 'Grid rows', _I32)
    return origin, cols, rows


def validated_occupancy(value, rows, cols):
    """Return the caller-owned grid without mutating it or silently dropping invalid seeds."""
    if value is None:
        return None
    if not isinstance(value, np.ndarray) or value.shape != (rows, cols):
        raise ValueError('Initial occupancy shape must match the full board grid (rows, columns)')
    if value.dtype not in (np.dtype(np.uint8), np.dtype(bool)):
        raise ValueError('Initial occupancy must be a binary uint8/bool array')
    # Allow one private Python/contiguous copy while retaining a process reserve.
    if value.size > max(0, _available_memory() - 256 * _MIB):
        raise MemoryError('Insufficient available memory for the initial board occupancy')
    if value.size and int(value.max()) > 1:
        raise ValueError('Initial occupancy must contain only 0 and 1')
    return value


def _bank_signature(bank):
    return tuple((source, tuple(id(item) for item in items)) for source, items in bank.items())


class _NativeBank:
    def __init__(self, bank, worker_limit=None):
        self._lock = threading.RLock()
        self._packing = False
        self.handle = ct.c_void_p()
        self.lib = _load_library(_library_path())
        self.signature = _bank_signature(bank)
        self.items, self.indexes = [], {}
        estimate = 0
        for items in bank.values():
            for item in items:
                if id(item) in self.indexes:
                    continue
                width = _integer(item['w'], 'Mask width', _I32)
                height = _integer(item['h'], 'Mask height', _I32)
                mask = item['mask']
                if width == 0 or height == 0 or not isinstance(mask, np.ndarray) or mask.shape != (height, width):
                    raise ValueError('Mask dimensions must match a nonempty two-dimensional NumPy array')
                if mask.dtype not in (np.dtype(np.uint8), np.dtype(bool)) or int(mask.max()) > 1:
                    raise ValueError('Native nesting requires binary uint8/bool collision masks')
                for key in ('bx', 'by', 'angle'):
                    if not math.isfinite(float(item[key])):
                        raise ValueError(f'Mask {key} must be finite')
                self.indexes[id(item)] = len(self.items)
                self.items.append(item)
                estimate += ((width + 63) // 64) * height * 8 + height * 4 + 160
        workers, budget = _resource_limits(estimate, worker_limit)
        self.estimated_bank = estimate
        self.worker_limit = worker_limit
        self.configured_workers = workers
        self.worker_upgrade_after = time.monotonic() + 2.
        self.budget = budget
        self._check(self.lib.nc_create(workers, budget, ct.byref(self.handle)), 'create')
        try:
            for expected, item in enumerate(self.items):
                # This is a no-copy view for the normal contiguous uint8 bank.
                # The local reference stays alive through the complete upload.
                mask = np.ascontiguousarray(item['mask'], dtype=np.uint8)
                index = ct.c_uint32()
                self._check(self.lib.nc_add_mask(self.handle, mask.ctypes.data_as(ct.POINTER(ct.c_uint8)),
                                                mask.size, item['w'], item['h'], ct.byref(index)), 'upload mask')
                if index.value != expected:
                    raise NativeCoreError('Native mask indices are inconsistent')
        except BaseException:
            self.close()
            raise

    def _check(self, result, operation):
        if result:
            buf = (ct.c_uint8 * 2048)()
            self.lib.nc_last_error(self.handle, buf, len(buf))
            detail = bytes(buf).split(b'\0', 1)[0].decode('utf-8', errors='replace')
            error_type = NativeResourceError if result in (2, 3) else NativeCoreError
            raise error_type(f'Rust nesting {operation} failed ({result}): {detail}')

    def close(self):
        with self._lock:
            if self._packing:
                raise NativeCoreError('Cannot close a native context from its progress callback')
            if self.handle:
                handle, self.handle = self.handle, ct.c_void_p()
                self.lib.nc_destroy(handle)

    def __del__(self):
        self.close()

    def status(self):
        with self._lock:
            if self._packing:
                raise NativeCoreError('Cannot inspect a native context from its progress callback')
            if not self.handle:
                raise NativeCoreError('Native context was closed before its result was read')
            return dict(backend='rust', threads=int(self.lib.nc_worker_count(self.handle)),
                        mask_count=len(self.items), bank_bytes=int(self.lib.nc_memory_used(self.handle)))

    def can_restore_workers(self):
        """Only rebuild a temporary one-worker context after headroom returns."""
        if time.monotonic() < self.worker_upgrade_after:
            return False
        self.worker_upgrade_after = time.monotonic() + 2.
        try:
            workers, _budget = _resource_limits(self.estimated_bank)
        except NativeResourceError:
            return False
        return workers > self.configured_workers

    def pack(self, *args, **kwargs):
        with self._lock:
            if self._packing:
                raise NativeCoreError('Cannot reenter a native context from its progress callback')
            self._packing = True
            try:
                return self._pack(*args, **kwargs)
            finally:
                self._packing = False

    def _pack(self, srcs, bank, remaining, board_w, board_h, gap, margin, res, seed,
             mode='top', order_mode='small', lookahead=1, progress=None, initial_occupancy=None):
        if self.signature != _bank_signature(bank):
            raise NativeCoreError('Mask bank changed after native upload; recreate its job context')
        grid_origin, cols, rows = collision_grid(srcs, board_w, board_h, gap, margin, res)
        initial_occupancy = validated_occupancy(initial_occupancy, rows, cols)
        seeded_function = getattr(self.lib, 'nc_pack_seeded', None)
        if initial_occupancy is not None and seeded_function is None:
            raise NativeCoreError('Native nesting library lacks seeded occupancy support; keeping fixed pieces in Python')
        if cols == 0 or rows == 0:
            return []
        lookahead = max(1, _integer(lookahead, 'Lookahead'))
        source_ids = [_integer(s['i'], 'Source index', len(remaining) - 1) for s in srcs]
        if len(source_ids) != len(set(source_ids)):
            raise ValueError('Source indices must be unique')
        quantities = []
        for i in source_ids:
            value = operator.index(remaining[i])
            if value < 0:
                raise ValueError('Remaining quantities must be nonnegative')
            if value > _U64:
                raise NativeCoreError('Quantity exceeds the native integer range')
            quantities.append(value)
        if sum(quantities) > _U64:
            raise NativeCoreError('Total quantity exceeds the native integer range')
        rng = random.Random(seed)
        order = list(range(len(srcs)))
        if order_mode == 'small':
            order.sort(key=lambda j: srcs[j]['area'])
        elif order_mode == 'large':
            order.sort(key=lambda j: -srcs[j]['area'])
        elif order_mode == 'random':
            rng.shuffle(order)
        elif order_mode == 'balanced':
            order.sort(key=lambda j: -remaining[srcs[j]['i']])
        elif order_mode == 'input':
            pass  # The supplied source priority is independent of true area.
        else:
            order.sort(key=lambda j: srcs[j]['area'] * (.7 + .6 * rng.random()))
        weight = .002 + rng.random() * .014
        sources, indexes = [], []
        allowed = []
        for i in source_ids:
            variants = [self.indexes[id(item)] for item in bank[i]]
            sources.append(_Source(len(indexes), len(variants)))
            indexes.extend(variants)
            allowed.append(set(variants))
        limits = []
        for item in self.items:
            max_x, max_y = cols - item['w'], rows - item['h']
            if 'frame_width' in item:
                fw, fh = item['frame_width'], item['frame_height']
                if not math.isfinite(float(fw)) or not math.isfinite(float(fh)) or fw < 0 or fh < 0:
                    raise ValueError('Rotated frame dimensions must be finite and nonnegative')
                max_x = min(max_x, math.floor((board_w - 2 * margin - fw + 1e-7) / res))
                max_y = min(max_y, math.floor((board_h - 2 * margin - fh + 1e-7) / res))
            limits.append(_Limit(max(-1, max_x), max(-1, max_y)))
        config = _Config(cols, rows, lookahead, 0, weight, .65 if mode == 'bl' else (1. if mode == 'top' else .35))
        c_sources = (_Source * len(sources))(*sources)
        c_indexes = (ct.c_uint32 * len(indexes))(*indexes)
        c_limits = (_Limit * len(limits))(*limits)
        c_order = (ct.c_uint32 * len(order))(*order)
        c_quantities = (ct.c_uint64 * len(quantities))(*quantities)
        callback_errors = []
        untouched = sum(remaining) - sum(quantities)

        def report(count, left, _user):
            if not callback_errors:
                try:
                    progress(count, left + untouched)
                except BaseException as exc:
                    callback_errors.append(exc)

        callback = _Progress(report) if progress else _Progress()
        # All ctypes buffers, mask metadata and callback references remain live
        # until nc_pack joins its bounded workers and returns.
        pack_args = (self.handle, ct.byref(config), c_sources, len(sources),
                     c_indexes, len(indexes), c_limits, len(limits), c_order, len(order),
                     c_quantities, len(quantities))
        if initial_occupancy is None:
            result = self.lib.nc_pack(*pack_args, callback, None)
        else:
            occupancy = np.ascontiguousarray(initial_occupancy, dtype=np.uint8)
            result = seeded_function(*pack_args, occupancy.ctypes.data_as(ct.POINTER(ct.c_uint8)),
                                     occupancy.size, callback, None)
        if callback_errors:
            raise _CallbackFailure(callback_errors[0])
        self._check(result, 'pack')
        count = self.lib.nc_placement_count(self.handle)
        if count > sum(quantities) or count * ct.sizeof(_Placement) > self.budget:
            raise NativeCoreError('Native placement count exceeds its valid bounds')
        raw = (_Placement * count)()
        self._check(self.lib.nc_copy_placements(self.handle, raw, count), 'copy placements')
        placed, used = [], [0] * len(srcs)
        for entry in raw:
            j, m = entry.source_index, entry.mask_index
            if j >= len(srcs) or m not in allowed[j]:
                raise NativeCoreError('Native placement references an invalid source/mask')
            item, limit = self.items[m], limits[m]
            if entry.x > limit.max_x or entry.y > limit.max_y:
                raise NativeCoreError('Native placement exceeds its sheet/frame bounds')
            placed.append(dict(i=source_ids[j], angle=item['angle'],
                               tx=grid_origin + entry.x * res - item['bx'],
                               ty=grid_origin + entry.y * res - item['by']))
            used[j] += 1
        if any(quantities[j] - used[j] != c_quantities[j] for j in range(len(srcs))):
            raise NativeCoreError('Native placement quantities are inconsistent')
        for j, i in enumerate(source_ids):
            remaining[i] = int(c_quantities[j])
        return placed


def dispatch(python_impl, srcs, bank, remaining, board_w, board_h, gap, margin, res, seed,
             mode='top', order_mode='small', lookahead=1, progress=None, initial_occupancy=None):
    """Run a complete sheet atomically, recovering Rust after temporary pressure."""
    requested = os.environ.get('PRINTFLOW_NESTING_CORE', 'auto').strip().lower()
    if requested not in ('auto', 'rust', 'python'):
        raise ValueError('PRINTFLOW_NESTING_CORE must be auto, rust, or python')
    persistent = isinstance(bank, MaskBank)
    status = dict(requested=requested, backend='python', current_backend='python', threads=1,
                  reason=None, mask_count=0, bank_bytes=0)
    args = (srcs, bank, remaining, board_w, board_h, gap, margin, res, seed,
            mode, order_mode, lookahead, progress, initial_occupancy)
    if requested == 'python':
        placed = python_impl(*args)
        _record_status(bank, status)
        return placed
    initial_remaining = list(remaining)
    library_path = _library_path()
    recovered = bool(getattr(bank, '_native_recovered', False))

    def attempt(worker_limit=None):
        # Return only scalar failure details. Leaving this frame releases the
        # exception traceback and its buffers before the retry/fallback starts.
        context = None
        try:
            context = getattr(bank, '_native_context', None) if persistent else None
            if (context is not None and worker_limit is None
                    and isinstance(context, _NativeBank) and context.handle
                    and context.can_restore_workers()):
                bank.close()
                context = None
            if context is None:
                context = _NativeBank(bank, worker_limit=worker_limit)
                if persistent:
                    bank._native_context = context
            if persistent:
                active = dict(status, backend='rust', current_backend='rust', reason=None,
                              resource_recovery=False, recovered=recovered)
                # Existing test doubles need only pack/close. Real contexts
                # expose their worker count before invoking any progress hook.
                if isinstance(context, _NativeBank) and context.handle:
                    active.update(context.status())
                bank._native_status = active
            placed = context.pack(*args)
            status.update(context.status(), current_backend='rust', reason=None,
                          resource_recovery=False, recovered=recovered)
            if persistent:
                bank._native_recovered = recovered
                if hasattr(bank, '_native_resource_failure'):
                    del bank._native_resource_failure
            _record_status(bank, status)
            return placed, None
        except _CallbackFailure as exc:
            remaining[:] = initial_remaining
            raise exc.error
        except (NativeCoreError, MemoryError) as exc:
            remaining[:] = initial_remaining
            if persistent:
                bank.close()
            if requested == 'rust' and isinstance(exc, RustUnavailable):
                raise
            return None, (isinstance(exc, (NativeResourceError, MemoryError)),
                          isinstance(exc, RustUnavailable), str(exc) or type(exc).__name__,
                          getattr(exc, 'minimum_available', 260 * _MIB))
        finally:
            if not persistent and context is not None:
                context.close()

    def recovery_ready(retry):
        # Hysteresis and a short probe interval prevent repeated upload attempts
        # when the machine is hovering at the memory reserve boundary.
        return time.monotonic() >= retry[3] and _available_memory() >= retry[2] + 16 * _MIB

    def remember_failure(failure, pending_retry=None):
        resource, unavailable, reason, minimum = failure
        status.update(backend='python', current_backend='python', threads=1, reason=reason,
                      resource_recovery=resource)
        retry = pending_retry or (library_path, reason, minimum, time.monotonic() + 1.)
        if persistent:
            bank._native_status = dict(status)
            if resource:
                bank._native_resource_failure = retry
            else:
                # Missing/invalid native capabilities retain the existing
                # job-wide fallback, without retaining any exception object.
                bank._native_failure = (library_path, unavailable, reason)
        if not getattr(bank, '_native_warning_emitted', False):
            print('PRINTFLOW_NESTING_CORE ' + json.dumps(status, ensure_ascii=True), file=sys.stderr, flush=True)
            if persistent:
                bank._native_warning_emitted = True
        return retry

    previous_failure = getattr(bank, '_native_failure', None)
    previous_resource = getattr(bank, '_native_resource_failure', None)
    pending_retry = None
    if previous_failure is not None and previous_failure[0] == library_path:
        if requested == 'rust' and previous_failure[1]:
            raise RustUnavailable(previous_failure[2])
        failure = (False, previous_failure[1], previous_failure[2], 0)
    elif (previous_resource is not None and previous_resource[0] == library_path
          and not recovery_ready(previous_resource)):
        failure = (True, False, previous_resource[1], previous_resource[2])
        pending_retry = previous_resource
    else:
        recovered |= previous_resource is not None and previous_resource[0] == library_path
        placed, failure = attempt()
        if failure is None:
            return placed
        if failure[0]:
            # A fresh, single-worker context can recover from native allocation
            # pressure without changing the grid, angles, or search candidates.
            recovered = True
            placed, failure = attempt(worker_limit=1)
            if failure is None:
                return placed
    retry = remember_failure(failure, pending_retry)

    if not failure[0]:
        placed = python_impl(*args)
        _record_status(bank, status)
        return placed

    next_probe = retry[3]
    allow_recovery = True
    def recovery_progress(count, left):
        nonlocal next_probe
        if progress:
            try:
                progress(count, left)
            except BaseException as exc:
                raise _CallbackFailure(exc)
        now = time.monotonic()
        if allow_recovery and now >= next_probe:
            next_probe = now + 1.
            if _available_memory() >= retry[2] + 16 * _MIB:
                raise _RetryNative()

    fallback_args = (*args[:12], recovery_progress, initial_occupancy)
    interrupted = False
    try:
        placed = python_impl(*fallback_args)
    except _CallbackFailure as exc:
        remaining[:] = initial_remaining
        raise exc.error
    except _RetryNative:
        # Finish unwinding the discarded Python board (and its occupancy)
        # before allocating a native context. No partial QT result is committed.
        interrupted = True
    if interrupted:
        remaining[:] = initial_remaining
        recovered = True
        placed, failure = attempt()
        if failure is not None:
            remember_failure(failure)
            # Bound recovery work to one mid-board restart. If native allocation
            # still fails, finish this Python board and retry on a later board.
            allow_recovery = False
            try:
                placed = python_impl(*fallback_args)
            except _CallbackFailure as exc:
                remaining[:] = initial_remaining
                raise exc.error
        else:
            return placed
    _record_status(bank, status)
    return placed
