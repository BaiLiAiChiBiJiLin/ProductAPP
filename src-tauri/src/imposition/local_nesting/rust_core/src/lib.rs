//! Dependency-free, deterministic raster nesting behind a small C ABI.
use std::alloc::{alloc, Layout};
use std::cell::RefCell;
use std::ffi::c_void;
use std::mem::{align_of, size_of};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::slice;
use std::sync::{Condvar, Mutex, MutexGuard, RwLock};

const DEFAULT_BUDGET: usize = 128 * 1024 * 1024;
const ERROR_BYTES: usize = 256;
const THREAD_STACK: usize = 256 * 1024;
type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug)]
struct Error(i32, &'static str);
const INVALID: Error = Error(1, "Invalid argument, dimensions, index, or array length");
const BUDGET: Error = Error(2, "Native nesting memory budget exceeded");
const ALLOCATION: Error = Error(3, "Native nesting allocation failed");
const PANIC: Error = Error(4, "Caught panic in native nesting core");

thread_local! {
    static LAST_ERROR: RefCell<[u8; ERROR_BYTES]> = const { RefCell::new([0; ERROR_BYTES]) };
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct NcSource {
    pub first_mask: u32,
    pub mask_count: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct NcLimit {
    pub max_x: i32,
    pub max_y: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NcPackConfig {
    pub cols: u32,
    pub rows: u32,
    pub lookahead: u32,
    pub reserved: u32,
    pub weight: f64,
    pub height_weight: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NcPlacement {
    pub source_index: u32,
    pub mask_index: u32,
    pub x: u32,
    pub y: u32,
}

pub type NcProgress = Option<extern "C" fn(u64, u64, *mut c_void)>;

struct Mask {
    width: usize,
    height: usize,
    stride: usize,
    words: Vec<u64>,
    active_rows: Vec<u32>,
}

pub struct NcContext {
    masks: Vec<Mask>,
    placements: Vec<NcPlacement>,
    budget: usize,
    requested_workers: usize,
    effective_workers: usize,
    error: [u8; ERROR_BYTES],
}

impl NcContext {
    fn retained_bytes(&self) -> usize {
        size_of::<Self>()
            + self.masks.capacity() * size_of::<Mask>()
            + self.placements.capacity() * size_of::<NcPlacement>()
            + self
                .masks
                .iter()
                .map(|m| m.words.capacity() * 8 + m.active_rows.capacity() * 4)
                .sum::<usize>()
    }
}

fn set_error(buffer: &mut [u8; ERROR_BYTES], message: &str) {
    buffer.fill(0);
    let count = message.len().min(ERROR_BYTES - 1);
    buffer[..count].copy_from_slice(&message.as_bytes()[..count]);
}

fn finish(ctx: Option<&mut NcContext>, result: Result<()>) -> i32 {
    let (code, message) = match result {
        Ok(()) => (0, ""),
        Err(Error(code, message)) => (code, message),
    };
    match ctx {
        Some(ctx) => set_error(&mut ctx.error, message),
        None => LAST_ERROR.with(|error| set_error(&mut error.borrow_mut(), message)),
    }
    code
}

fn checked_bytes(count: usize, item_bytes: usize) -> Result<usize> {
    count
        .checked_mul(item_bytes)
        .filter(|n| *n <= isize::MAX as usize)
        .ok_or(INVALID)
}

fn guard(used: usize, extra: usize, budget: usize) -> Result<()> {
    if used.checked_add(extra).is_some_and(|total| total <= budget) {
        Ok(())
    } else {
        Err(BUDGET)
    }
}

fn zeros<T: Clone + Default>(count: usize) -> Result<Vec<T>> {
    checked_bytes(count, size_of::<T>())?;
    let mut values = Vec::new();
    values.try_reserve_exact(count).map_err(|_| ALLOCATION)?;
    values.resize(count, T::default());
    Ok(values)
}

unsafe fn input_slice<'a, T>(data: *const T, length: usize) -> Result<&'a [T]> {
    checked_bytes(length, size_of::<T>())?;
    if length == 0 {
        return Ok(&[]);
    }
    if data.is_null() || (data as usize) % align_of::<T>() != 0 {
        return Err(INVALID);
    }
    Ok(slice::from_raw_parts(data, length))
}

unsafe fn context<'a>(ctx: *mut NcContext) -> Result<&'a mut NcContext> {
    if ctx.is_null() || (ctx as usize) % align_of::<NcContext>() != 0 {
        Err(INVALID)
    } else {
        Ok(&mut *ctx)
    }
}

#[cfg(windows)]
fn memory_workers(requested: usize) -> usize {
    #[repr(C)]
    struct MemoryStatus {
        length: u32,
        load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }
    let mut status = MemoryStatus {
        length: size_of::<MemoryStatus>() as u32,
        load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    // Failure to read available commit conservatively selects one worker.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0
        || status.avail_phys.min(status.avail_page_file) < 768 * 1024 * 1024
    {
        1
    } else {
        requested
    }
}

#[cfg(not(windows))]
fn memory_workers(requested: usize) -> usize {
    requested
}

#[no_mangle]
pub extern "C" fn nc_abi_version() -> u32 {
    1
}

#[no_mangle]
pub unsafe extern "C" fn nc_create(workers: u32, max_bytes: u64, out: *mut *mut NcContext) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if out.is_null() || (out as usize) % align_of::<*mut NcContext>() != 0 {
            return Err(INVALID);
        }
        *out = ptr::null_mut();
        let requested_workers = match workers {
            0 => 2,
            1 | 2 | 4 => workers as usize,
            _ => return Err(INVALID),
        };
        let budget = if max_bytes == 0 {
            DEFAULT_BUDGET
        } else {
            usize::try_from(max_bytes).map_err(|_| INVALID)?
        };
        guard(0, size_of::<NcContext>(), budget)?;
        let storage = alloc(Layout::new::<NcContext>()) as *mut NcContext;
        if storage.is_null() {
            return Err(ALLOCATION);
        }
        storage.write(NcContext {
            masks: Vec::new(),
            placements: Vec::new(),
            budget,
            requested_workers,
            effective_workers: memory_workers(requested_workers),
            error: [0; ERROR_BYTES],
        });
        *out = storage;
        Ok(())
    }))
    .unwrap_or(Err(PANIC));
    finish(None, result)
}

#[no_mangle]
pub unsafe extern "C" fn nc_add_mask(
    ctx: *mut NcContext,
    data: *const u8,
    data_len: usize,
    width: u32,
    height: u32,
    out_index: *mut u32,
) -> i32 {
    let ctx = match context(ctx) {
        Ok(ctx) => ctx,
        Err(error) => return finish(None, Err(error)),
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        if width == 0
            || height == 0
            || out_index.is_null()
            || (out_index as usize) % align_of::<u32>() != 0
        {
            return Err(INVALID);
        }
        if ctx.masks.len() >= u32::MAX as usize {
            return Err(INVALID);
        }
        let width = width as usize;
        let height = height as usize;
        if checked_bytes(width, height)? != data_len {
            return Err(INVALID);
        }
        let data = input_slice(data, data_len)?;
        let stride = width.div_ceil(64);
        let word_count = checked_bytes(stride, height)?;
        let mask_bytes = checked_bytes(word_count, 8)?
            .checked_add(checked_bytes(height, 4)?)
            .ok_or(INVALID)?;
        guard(
            ctx.retained_bytes(),
            mask_bytes.checked_add(size_of::<Mask>()).ok_or(INVALID)?,
            ctx.budget,
        )?;
        let mut words = zeros::<u64>(word_count)?;
        let mut active_rows = Vec::new();
        active_rows
            .try_reserve_exact(height)
            .map_err(|_| ALLOCATION)?;
        for y in 0..height {
            let mut active = false;
            for x in 0..width {
                match data[y * width + x] {
                    0 => (),
                    1 => {
                        words[y * stride + x / 64] |= 1_u64 << (x % 64);
                        active = true;
                    }
                    _ => return Err(Error(1, "Mask values must be binary uint8 (0 or 1)")),
                }
            }
            if active {
                active_rows.push(y as u32);
            }
        }
        // Central rows tend to reject overlap early; origin enumeration is unchanged.
        active_rows.sort_unstable_by_key(|y| ((2 * *y as i64 - height as i64).abs(), *y));
        ctx.masks.try_reserve_exact(1).map_err(|_| ALLOCATION)?;
        *out_index = ctx.masks.len() as u32;
        ctx.masks.push(Mask {
            width,
            height,
            stride,
            words,
            active_rows,
        });
        Ok(())
    }))
    .unwrap_or(Err(PANIC));
    finish(Some(ctx), result)
}

struct Board {
    width: usize,
    height: usize,
    stride: usize,
    words: Vec<u64>,
    occupied: bool,
}

impl Board {
    /// Return a safe positive skip if blocked, or zero if this origin is legal.
    fn collision_skip(&self, mask: &Mask, x: usize, y: usize) -> usize {
        if !self.occupied {
            return 0;
        }
        let word_offset = x / 64;
        let shift = x % 64;
        for &row in &mask.active_rows {
            let mask_row =
                &mask.words[row as usize * mask.stride..(row as usize + 1) * mask.stride];
            let offset = (y + row as usize) * self.stride;
            let board_row = &self.words[offset..offset + self.stride];
            for (j, &word) in mask_row.iter().enumerate() {
                if word == 0 {
                    continue;
                }
                let k = word_offset + j;
                let occupied = if shift == 0 {
                    board_row[k]
                } else {
                    (board_row[k] >> shift)
                        | (board_row.get(k + 1).copied().unwrap_or(0) << (64 - shift))
                };
                let overlap = occupied & word;
                if overlap == 0 {
                    continue;
                }
                // The same occupied pixel blocks every shift until the mask's
                // contiguous run to its left has passed. Never skip a legal origin.
                let bit = 63 - overlap.leading_zeros();
                let mut skip = (word << (63 - bit)).leading_ones() as usize;
                if skip == bit as usize + 1 {
                    let mut previous = j;
                    while previous > 0 {
                        previous -= 1;
                        let ones = mask_row[previous].leading_ones() as usize;
                        skip += ones;
                        if ones != 64 {
                            break;
                        }
                    }
                }
                return skip;
            }
        }
        0
    }

    fn place(&mut self, mask: &Mask, x: usize, y: usize) {
        let word_offset = x / 64;
        let shift = x % 64;
        for &row in &mask.active_rows {
            let source = &mask.words[row as usize * mask.stride..(row as usize + 1) * mask.stride];
            let offset = (y + row as usize) * self.stride;
            for (j, &word) in source.iter().enumerate() {
                self.words[offset + word_offset + j] |= word << shift;
                if shift != 0 && word_offset + j + 1 < self.stride {
                    self.words[offset + word_offset + j + 1] |= word >> (64 - shift);
                }
            }
        }
        self.occupied |= !mask.active_rows.is_empty();
    }
}

#[derive(Clone, Copy, Default)]
struct Origin {
    x: u32,
    y: u32,
    exhausted: bool,
}

#[derive(Clone, Copy, Default)]
struct SearchTask {
    mask_index: u32,
    limit: NcLimit,
    origin: Origin,
}

fn first_legal(board: &Board, mask: &Mask, task: SearchTask) -> Option<(u32, u32)> {
    if task.origin.exhausted
        || task.limit.max_x < 0
        || task.limit.max_y < 0
        || mask.width > board.width
        || mask.height > board.height
    {
        return None;
    }
    let max_x = (board.width - mask.width).min(task.limit.max_x as usize);
    let max_y = (board.height - mask.height).min(task.limit.max_y as usize);
    let first_x = task.origin.x as usize;
    let first_y = task.origin.y as usize;
    if first_x > max_x || first_y > max_y {
        return None;
    }
    for y in first_y..=max_y {
        let mut x = if y == first_y { first_x } else { 0 };
        while x <= max_x {
            let skip = board.collision_skip(mask, x, y);
            if skip == 0 {
                return Some((x as u32, y as u32));
            }
            x += skip;
        }
    }
    None
}

struct Job {
    epoch: u64,
    stop: bool,
    panicked: bool,
    workers: usize,
    finished: usize,
    length: usize,
    tasks: Vec<SearchTask>,
    results: Vec<Option<(u32, u32)>>,
}

struct Shared {
    job: Mutex<Job>,
    ready: Condvar,
    done: Condvar,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn run_tasks(worker: usize, shared: &Shared, board: &RwLock<Board>, masks: &[Mask]) {
    let (length, workers) = {
        let job = lock(&shared.job);
        (job.length, job.workers)
    };
    let board = board.read().unwrap_or_else(|poison| poison.into_inner());
    for index in (worker..length).step_by(workers) {
        let task = { lock(&shared.job).tasks[index] };
        let result = first_legal(&board, &masks[task.mask_index as usize], task);
        lock(&shared.job).results[index] = result;
    }
}

fn worker_loop(worker: usize, shared: &Shared, board: &RwLock<Board>, masks: &[Mask]) {
    let mut epoch = 0;
    loop {
        let mut job = lock(&shared.job);
        while !job.stop && epoch == job.epoch {
            job = shared
                .ready
                .wait(job)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        if job.stop {
            return;
        }
        epoch = job.epoch;
        drop(job);
        let result = catch_unwind(AssertUnwindSafe(|| run_tasks(worker, shared, board, masks)));
        let mut job = lock(&shared.job);
        job.panicked |= result.is_err();
        job.finished += 1;
        shared.done.notify_one();
    }
}

struct StopWorkers<'a>(&'a Shared);
impl Drop for StopWorkers<'_> {
    fn drop(&mut self) {
        lock(&self.0.job).stop = true;
        self.0.ready.notify_all();
    }
}

struct PackInput<'a> {
    config: NcPackConfig,
    sources: &'a [NcSource],
    mask_indexes: &'a [u32],
    limits: &'a [NcLimit],
    order: &'a [u32],
    quantities: &'a [u64],
    progress: NcProgress,
    user: *mut c_void,
}

fn pack_inner(ctx: &mut NcContext, input: PackInput<'_>) -> Result<Vec<u64>> {
    ctx.placements.clear();
    let config = input.config;
    if config.cols == 0
        || config.rows == 0
        || config.lookahead == 0
        || config.reserved != 0
        || !config.weight.is_finite()
        || !config.height_weight.is_finite()
        || input.sources.len() > u32::MAX as usize
        || input.quantities.len() != input.sources.len()
        || input.order.len() != input.sources.len()
        || input.limits.len() != ctx.masks.len()
    {
        return Err(INVALID);
    }
    let stride = (config.cols as usize).div_ceil(64);
    let board_words = checked_bytes(stride, config.rows as usize)?;
    let max_variants = input
        .sources
        .iter()
        .map(|source| source.mask_count as usize)
        .max()
        .unwrap_or(0);
    for source in input.sources {
        let end = (source.first_mask as usize)
            .checked_add(source.mask_count as usize)
            .ok_or(INVALID)?;
        if end > input.mask_indexes.len() {
            return Err(INVALID);
        }
    }
    if input
        .mask_indexes
        .iter()
        .any(|index| *index as usize >= ctx.masks.len())
    {
        return Err(INVALID);
    }
    let mut total_left = input.quantities.iter().try_fold(0_u64, |total, count| {
        total.checked_add(*count).ok_or(INVALID)
    })?;
    let extra_bytes = checked_bytes(board_words, 8)?
        .checked_add(checked_bytes(ctx.masks.len(), size_of::<Origin>())?)
        .ok_or(INVALID)?
        .checked_add(checked_bytes(input.sources.len(), 10)?)
        .ok_or(INVALID)?
        .checked_add(checked_bytes(
            max_variants,
            size_of::<SearchTask>() + size_of::<Option<(u32, u32)>>(),
        )?)
        .ok_or(INVALID)?;
    guard(ctx.retained_bytes(), extra_bytes, ctx.budget)?;
    let board = RwLock::new(Board {
        width: config.cols as usize,
        height: config.rows as usize,
        stride,
        words: zeros(board_words)?,
        occupied: false,
    });
    let mut origins = zeros::<Origin>(ctx.masks.len())?;
    let mut failed = zeros::<bool>(input.sources.len())?;
    let mut seen = zeros::<bool>(input.sources.len())?;
    let mut quantities = zeros::<u64>(input.sources.len())?;
    quantities.copy_from_slice(input.quantities);
    for &index in input.order {
        let index = index as usize;
        if index >= seen.len() || seen[index] {
            return Err(INVALID);
        }
        seen[index] = true;
    }
    let shared = Shared {
        job: Mutex::new(Job {
            epoch: 0,
            stop: false,
            panicked: false,
            workers: 1,
            finished: 0,
            length: 0,
            tasks: zeros(max_variants)?,
            results: zeros(max_variants)?,
        }),
        ready: Condvar::new(),
        done: Condvar::new(),
    };
    let available_workers = memory_workers(ctx.requested_workers).min(max_variants.max(1));
    let base_bytes = ctx.retained_bytes() - ctx.placements.capacity() * size_of::<NcPlacement>();
    let masks = &ctx.masks;
    let placements = &mut ctx.placements;
    let budget = ctx.budget;
    let result = std::thread::scope(|scope| {
        let stop = StopWorkers(&shared);
        let mut workers = 1;
        for worker in 1..available_workers {
            if guard(
                base_bytes + placements.capacity() * size_of::<NcPlacement>(),
                extra_bytes + worker * THREAD_STACK,
                budget,
            )
            .is_err()
            {
                break;
            }
            let shared_ref = &shared;
            let board_ref = &board;
            match std::thread::Builder::new()
                .stack_size(THREAD_STACK)
                .spawn_scoped(scope, move || {
                    worker_loop(worker, shared_ref, board_ref, masks)
                }) {
                Ok(_) => workers += 1,
                Err(_) => break,
            }
        }
        ctx.effective_workers = workers;
        lock(&shared.job).workers = workers;
        let transient_bytes = extra_bytes + (workers - 1) * THREAD_STACK;
        loop {
            let mut best: Option<(f64, NcPlacement)> = None;
            let mut choices = 0;
            for &source_index in input.order {
                let index = source_index as usize;
                if quantities[index] == 0 || failed[index] {
                    continue;
                }
                let source = input.sources[index];
                let source_masks = &input.mask_indexes[source.first_mask as usize
                    ..source.first_mask as usize + source.mask_count as usize];
                let mut job = lock(&shared.job);
                job.length = source_masks.len();
                job.finished = 0;
                for (offset, &mask_index) in source_masks.iter().enumerate() {
                    job.tasks[offset] = SearchTask {
                        mask_index,
                        limit: input.limits[mask_index as usize],
                        origin: origins[mask_index as usize],
                    };
                }
                job.epoch += 1;
                drop(job);
                if workers > 1 {
                    shared.ready.notify_all();
                }
                run_tasks(0, &shared, &board, masks);
                let mut job = lock(&shared.job);
                while job.finished < workers - 1 {
                    job = shared
                        .done
                        .wait(job)
                        .unwrap_or_else(|poison| poison.into_inner());
                }
                if job.panicked {
                    return Err(PANIC);
                }
                let mut option: Option<(f64, NcPlacement)> = None;
                for (offset, &mask_index) in source_masks.iter().enumerate() {
                    match job.results[offset] {
                        Some((x, y)) => {
                            origins[mask_index as usize] = Origin {
                                x,
                                y,
                                exhausted: false,
                            };
                            // Keep Python's exact operation order, without fused multiply-add.
                            let score = (y as f64
                                + config.height_weight * masks[mask_index as usize].height as f64)
                                + config.weight * x as f64;
                            if option.as_ref().is_none_or(|(old, _)| score < *old) {
                                option = Some((
                                    score,
                                    NcPlacement {
                                        source_index,
                                        mask_index,
                                        x,
                                        y,
                                    },
                                ));
                            }
                        }
                        None => origins[mask_index as usize].exhausted = true,
                    }
                }
                drop(job);
                match option {
                    Some(candidate) => {
                        if best.as_ref().is_none_or(|(old, _)| candidate.0 < *old) {
                            best = Some(candidate);
                        }
                        choices += 1;
                        if choices >= config.lookahead {
                            break;
                        }
                    }
                    None => failed[index] = true,
                }
            }
            let Some((_, placement)) = best else {
                break;
            };
            if placements.len() == placements.capacity() {
                let capacity = placements.capacity();
                let desired = capacity.max(16).checked_mul(2).ok_or(BUDGET)?;
                let required = checked_bytes(desired, size_of::<NcPlacement>())?;
                // Fall back to a single additional result when doubling would exceed budget.
                let new_capacity = if guard(base_bytes + transient_bytes, required, budget).is_ok()
                {
                    desired
                } else {
                    let minimal = capacity.checked_add(1).ok_or(BUDGET)?;
                    guard(
                        base_bytes + transient_bytes,
                        checked_bytes(minimal, size_of::<NcPlacement>())?,
                        budget,
                    )?;
                    minimal
                };
                placements
                    .try_reserve_exact(new_capacity - placements.len())
                    .map_err(|_| ALLOCATION)?;
            }
            board
                .write()
                .unwrap_or_else(|poison| poison.into_inner())
                .place(
                    &masks[placement.mask_index as usize],
                    placement.x as usize,
                    placement.y as usize,
                );
            placements.push(placement);
            quantities[placement.source_index as usize] -= 1;
            total_left -= 1;
            if let Some(progress) = input.progress {
                progress(placements.len() as u64, total_left, input.user);
            }
        }
        drop(stop);
        Ok(())
    });
    result?;
    Ok(quantities)
}

#[no_mangle]
pub unsafe extern "C" fn nc_pack(
    ctx: *mut NcContext,
    config: *const NcPackConfig,
    sources: *const NcSource,
    source_count: usize,
    mask_indexes: *const u32,
    mask_index_count: usize,
    limits: *const NcLimit,
    limit_count: usize,
    order: *const u32,
    order_count: usize,
    quantities: *mut u64,
    quantity_count: usize,
    progress: NcProgress,
    user: *mut c_void,
) -> i32 {
    let ctx = match context(ctx) {
        Ok(ctx) => ctx,
        Err(error) => return finish(None, Err(error)),
    };
    ctx.placements.clear();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let config = *input_slice(config, 1)?.first().ok_or(INVALID)?;
        let result = pack_inner(
            ctx,
            PackInput {
                config,
                sources: input_slice(sources, source_count)?,
                mask_indexes: input_slice(mask_indexes, mask_index_count)?,
                limits: input_slice(limits, limit_count)?,
                order: input_slice(order, order_count)?,
                quantities: input_slice(quantities, quantity_count)?,
                progress,
                user,
            },
        )?;
        if !result.is_empty() {
            ptr::copy_nonoverlapping(result.as_ptr(), quantities, result.len());
        }
        Ok(())
    }))
    .unwrap_or(Err(PANIC));
    if result.is_err() {
        ctx.placements.clear();
    }
    finish(Some(ctx), result)
}

#[no_mangle]
pub unsafe extern "C" fn nc_placement_count(ctx: *const NcContext) -> usize {
    context(ctx as *mut NcContext).map_or(0, |ctx| ctx.placements.len())
}

#[no_mangle]
pub unsafe extern "C" fn nc_copy_placements(
    ctx: *mut NcContext,
    out: *mut NcPlacement,
    capacity: usize,
) -> i32 {
    let ctx = match context(ctx) {
        Ok(ctx) => ctx,
        Err(error) => return finish(None, Err(error)),
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        if capacity < ctx.placements.len() {
            return Err(Error(5, "Placement output buffer is too small"));
        }
        checked_bytes(capacity, size_of::<NcPlacement>())?;
        // C callers may supply uninitialized output memory. Validate it without
        // constructing a Rust reference to uninitialized placement values.
        if capacity != 0 && (out.is_null() || (out as usize) % align_of::<NcPlacement>() != 0) {
            return Err(INVALID);
        }
        if !ctx.placements.is_empty() {
            ptr::copy_nonoverlapping(ctx.placements.as_ptr(), out, ctx.placements.len());
        }
        Ok(())
    }))
    .unwrap_or(Err(PANIC));
    finish(Some(ctx), result)
}

#[no_mangle]
pub unsafe extern "C" fn nc_memory_used(ctx: *const NcContext) -> u64 {
    context(ctx as *mut NcContext).map_or(0, |ctx| ctx.retained_bytes() as u64)
}

#[no_mangle]
pub unsafe extern "C" fn nc_worker_count(ctx: *const NcContext) -> u32 {
    context(ctx as *mut NcContext).map_or(0, |ctx| ctx.effective_workers as u32)
}

#[no_mangle]
pub unsafe extern "C" fn nc_last_error(
    ctx: *const NcContext,
    out: *mut u8,
    capacity: usize,
) -> usize {
    fn copy_error(error: &[u8; ERROR_BYTES], out: *mut u8, capacity: usize) -> usize {
        let length = error
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(ERROR_BYTES - 1);
        if capacity > 0 && !out.is_null() {
            let count = length.min(capacity - 1);
            unsafe {
                ptr::copy_nonoverlapping(error.as_ptr(), out, count);
                *out.add(count) = 0;
            }
        }
        length + 1
    }
    match context(ctx as *mut NcContext) {
        Ok(ctx) => copy_error(&ctx.error, out, capacity),
        Err(_) => LAST_ERROR.with(|error| copy_error(&error.borrow(), out, capacity)),
    }
}

#[no_mangle]
pub unsafe extern "C" fn nc_destroy(ctx: *mut NcContext) {
    if context(ctx).is_ok() {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(Box::from_raw(ctx))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask(width: usize, height: usize, data: &[u8]) -> Mask {
        let stride = width.div_ceil(64);
        let mut words = vec![0; stride * height];
        let mut active_rows = Vec::new();
        for y in 0..height {
            for x in 0..width {
                if data[y * width + x] != 0 {
                    words[y * stride + x / 64] |= 1 << (x % 64);
                }
            }
            if words[y * stride..(y + 1) * stride]
                .iter()
                .any(|word| *word != 0)
            {
                active_rows.push(y as u32);
            }
        }
        Mask {
            width,
            height,
            stride,
            words,
            active_rows,
        }
    }

    fn naive(board: &Board, mask: &Mask, task: SearchTask) -> Option<(u32, u32)> {
        if task.origin.exhausted
            || task.limit.max_x < 0
            || task.limit.max_y < 0
            || mask.width > board.width
            || mask.height > board.height
        {
            return None;
        }
        let mx = (board.width - mask.width).min(task.limit.max_x as usize);
        let my = (board.height - mask.height).min(task.limit.max_y as usize);
        if task.origin.x as usize > mx || task.origin.y as usize > my {
            return None;
        }
        for y in task.origin.y as usize..=my {
            for x in (if y == task.origin.y as usize {
                task.origin.x as usize
            } else {
                0
            })..=mx
            {
                let mut blocked = false;
                for yy in 0..mask.height {
                    for xx in 0..mask.width {
                        let m = mask.words[yy * mask.stride + xx / 64] >> (xx % 64) & 1;
                        let b = board.words[(y + yy) * board.stride + (x + xx) / 64]
                            >> ((x + xx) % 64)
                            & 1;
                        blocked |= m & b != 0;
                    }
                }
                if !blocked {
                    return Some((x as u32, y as u32));
                }
            }
        }
        None
    }

    #[test]
    fn search_matches_bruteforce_across_word_boundaries() {
        let mut seed = 17_u64;
        let mut random = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for case in 0..350 {
            let width = 70 + (random() % 145) as usize;
            let height = 3 + (random() % 10) as usize;
            let mw = 1 + (random() % (width as u64 - 1)) as usize;
            let mh = 1 + (random() % height as u64) as usize;
            let mask_data: Vec<_> = (0..mw * mh).map(|_| (random() % 5 != 0) as u8).collect();
            let mask = mask(mw, mh, &mask_data);
            let mut board = Board {
                width,
                height,
                stride: width.div_ceil(64),
                words: vec![0; width.div_ceil(64) * height],
                occupied: true,
            };
            for y in 0..height {
                for x in 0..width {
                    if random() % 97 < (case % 8) as u64 {
                        board.words[y * board.stride + x / 64] |= 1 << (x % 64);
                    }
                }
            }
            let task = SearchTask {
                mask_index: 0,
                limit: NcLimit {
                    max_x: (width - mw) as i32,
                    max_y: (height - mh) as i32,
                },
                origin: Origin {
                    x: (random() % (width - mw + 1) as u64) as u32,
                    y: (random() % (height - mh + 1) as u64) as u32,
                    exhausted: false,
                },
            };
            assert_eq!(
                first_legal(&board, &mask, task),
                naive(&board, &mask, task),
                "case {case}"
            );
        }
    }

    #[test]
    fn placement_or_matches_pixels_for_every_shift() {
        let data: Vec<_> = (0..137 * 3).map(|i| (i % 7 != 0) as u8).collect();
        let mask = mask(137, 3, &data);
        for x in 0..128 {
            let mut board = Board {
                width: 270,
                height: 5,
                stride: 5,
                words: vec![0; 25],
                occupied: false,
            };
            board.place(&mask, x, 1);
            for y in 0..5 {
                for xx in 0..270 {
                    let actual = (board.words[y * 5 + xx / 64] >> (xx % 64) & 1) as u8;
                    let expected = if (1..4).contains(&y) && xx >= x && xx < x + 137 {
                        data[(y - 1) * 137 + xx - x]
                    } else {
                        0
                    };
                    assert_eq!(actual, expected, "shift={x} at {xx},{y}");
                }
            }
        }
    }

    #[test]
    fn abi_errors_are_recoverable_and_quantities_transactional() {
        unsafe {
            let mut ctx = ptr::null_mut();
            assert_eq!(nc_create(1, 16384, &mut ctx), 0);
            let mut index = 0;
            assert_eq!(nc_add_mask(ctx, [1_u8; 4].as_ptr(), 4, 2, 2, &mut index), 0);
            let config = NcPackConfig {
                cols: 4,
                rows: 4,
                lookahead: 1,
                reserved: 0,
                weight: 0.01,
                height_weight: 1.0,
            };
            let sources = [NcSource {
                first_mask: 0,
                mask_count: 1,
            }];
            let limits = [NcLimit { max_x: 2, max_y: 2 }];
            let mut qty = [7_u64];
            assert_eq!(
                nc_pack(
                    ctx,
                    &config,
                    sources.as_ptr(),
                    1,
                    [4_u32].as_ptr(),
                    1,
                    limits.as_ptr(),
                    1,
                    [0_u32].as_ptr(),
                    1,
                    qty.as_mut_ptr(),
                    1,
                    None,
                    ptr::null_mut()
                ),
                1
            );
            assert_eq!(qty, [7]);
            assert_eq!(nc_placement_count(ctx), 0);
            assert_eq!(
                nc_pack(
                    ctx,
                    &config,
                    sources.as_ptr(),
                    1,
                    [0_u32].as_ptr(),
                    1,
                    limits.as_ptr(),
                    1,
                    [0_u32].as_ptr(),
                    1,
                    qty.as_mut_ptr(),
                    1,
                    None,
                    ptr::null_mut()
                ),
                0
            );
            assert_eq!(qty, [3]);
            assert_eq!(nc_placement_count(ctx), 4);
            nc_destroy(ctx);
        }
    }

    #[test]
    fn parallel_workers_preserve_result_indexes_across_generations() {
        let masks = [mask(65, 2, &[1; 130]), mask(3, 1, &[1, 0, 1])];
        let board = RwLock::new(Board {
            width: 140,
            height: 4,
            stride: 3,
            words: vec![0; 12],
            occupied: true,
        });
        for workers in [1, 2, 4] {
            let shared = Shared {
                job: Mutex::new(Job {
                    epoch: 0,
                    stop: false,
                    panicked: false,
                    workers,
                    finished: 0,
                    length: 8,
                    tasks: vec![SearchTask::default(); 8],
                    results: vec![None; 8],
                }),
                ready: Condvar::new(),
                done: Condvar::new(),
            };
            std::thread::scope(|scope| {
                let _stop = StopWorkers(&shared);
                for worker in 1..workers {
                    let shared_ref = &shared;
                    let board_ref = &board;
                    let masks_ref = &masks;
                    scope.spawn(move || worker_loop(worker, shared_ref, board_ref, masks_ref));
                }
                for generation in 0..24 {
                    {
                        let mut board = board.write().unwrap();
                        board.words.fill(0);
                        board.words[generation % 3] = 0xf0f0_u64.rotate_left(generation as u32);
                    }
                    let mut job = lock(&shared.job);
                    for index in 0..8 {
                        job.tasks[index] = SearchTask {
                            mask_index: (index % 2) as u32,
                            limit: NcLimit {
                                max_x: 100,
                                max_y: 2,
                            },
                            origin: Origin {
                                x: index as u32,
                                y: 0,
                                exhausted: false,
                            },
                        };
                    }
                    job.finished = 0;
                    job.epoch += 1;
                    drop(job);
                    shared.ready.notify_all();
                    run_tasks(0, &shared, &board, &masks);
                    let mut job = lock(&shared.job);
                    while job.finished < workers - 1 {
                        job = shared.done.wait(job).unwrap();
                    }
                    assert!(!job.panicked);
                    let board = board.read().unwrap();
                    for index in 0..8 {
                        let task = job.tasks[index];
                        assert_eq!(
                            job.results[index],
                            naive(&board, &masks[task.mask_index as usize], task)
                        );
                    }
                }
            });
        }
    }

    #[test]
    fn allocation_budget_failure_does_not_partially_commit_quantities() {
        unsafe {
            let mut ctx = ptr::null_mut();
            assert_eq!(nc_create(1, 1024, &mut ctx), 0);
            let mut index = 0;
            assert_eq!(nc_add_mask(ctx, [0_u8].as_ptr(), 1, 1, 1, &mut index), 0);
            let config = NcPackConfig {
                cols: 2,
                rows: 2,
                lookahead: 1,
                reserved: 0,
                weight: 0.01,
                height_weight: 1.0,
            };
            let sources = [NcSource {
                first_mask: 0,
                mask_count: 1,
            }];
            let limits = [NcLimit { max_x: 1, max_y: 1 }];
            let mut qty = [1000_u64];
            assert_eq!(
                nc_pack(
                    ctx,
                    &config,
                    sources.as_ptr(),
                    1,
                    [0_u32].as_ptr(),
                    1,
                    limits.as_ptr(),
                    1,
                    [0_u32].as_ptr(),
                    1,
                    qty.as_mut_ptr(),
                    1,
                    None,
                    ptr::null_mut()
                ),
                2
            );
            assert_eq!(qty, [1000]);
            assert_eq!(nc_placement_count(ctx), 0);
            assert!(nc_memory_used(ctx) <= 1024);
            qty[0] = 1;
            assert_eq!(
                nc_pack(
                    ctx,
                    &config,
                    sources.as_ptr(),
                    1,
                    [0_u32].as_ptr(),
                    1,
                    limits.as_ptr(),
                    1,
                    [0_u32].as_ptr(),
                    1,
                    qty.as_mut_ptr(),
                    1,
                    None,
                    ptr::null_mut()
                ),
                0
            );
            assert_eq!(qty, [0]);
            assert_eq!(nc_placement_count(ctx), 1);
            nc_destroy(ctx);
        }
    }
}
