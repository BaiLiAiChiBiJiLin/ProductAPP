//! CPU/memory admission for previews. Cache locks protect only publication and
//! pinning; independent artworks can read and render on different cores.
use std::{
    cell::Cell,
    collections::{HashMap, VecDeque},
    marker::PhantomData,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
};

const MIB: usize = 1024 * 1024;
pub(crate) static CACHE_LOCK: Mutex<()> = Mutex::new(());
/// Pin a sufficiently detailed UI PNG before pruning can remove its cache file.
pub(crate) fn pin_preview(path: &Path, required_edge: u32, output: &Path) -> Result<bool, String> {
    if required_edge > 512 {
        return Ok(false);
    }
    let _cache = CACHE_LOCK.lock().map_err(|_| "图片缓存暂不可用")?;
    if !std::fs::metadata(path).is_ok_and(|info| info.len() <= 4 * 1024 * 1024) {
        return Ok(false);
    }
    let dimensions = image::ImageReader::open(path)
        .ok()
        .and_then(|reader| reader.with_guessed_format().ok())
        .filter(|reader| reader.format() == Some(image::ImageFormat::Png))
        .and_then(|reader| reader.into_dimensions().ok());
    if !dimensions
        .is_some_and(|(w, h)| w > 0 && h > 0 && w <= 512 && h <= 512 && w.max(h) >= required_edge)
    {
        return Ok(false);
    }
    if std::fs::hard_link(path, output).is_err() {
        std::fs::copy(path, output).map_err(|_| "导出缓存图片准备失败")?;
    }
    Ok(true)
}
static GATE: Gate = Gate::new();
thread_local! { static DEPTH: Cell<(usize,usize)> = const { Cell::new((0,0)) }; }

#[derive(Clone, Copy)]
struct Limits {
    workers: usize,
    bytes: usize,
}
fn limits(cores: usize, available: Option<usize>) -> Limits {
    let bytes = available.map(|n| (n.saturating_sub(512 * MIB) / 4).clamp(192 * MIB, 1024 * MIB));
    Limits {
        workers: if bytes.is_some() {
            (cores / 2).clamp(1, 4)
        } else {
            1
        },
        bytes: bytes.unwrap_or(192 * MIB),
    }
}
fn detected_limits() -> Limits {
    limits(
        std::thread::available_parallelism().map_or(1, usize::from),
        crate::imposition_pdf_runtime::available_memory(),
    )
}
// Source XML, parsed vector data, compressed images, and the bounded decoder's
// pixel budget. Oversized/unknown sources run alone when they exceed the budget.
pub(crate) fn estimate(source_bytes: usize) -> usize {
    source_bytes.saturating_mul(4).saturating_add(128 * MIB)
}
pub(crate) fn acquire(source_bytes: usize) -> Result<Permit<'static>, String> {
    GATE.enter(estimate(source_bytes), detected_limits)
}
pub(crate) fn acquire_unknown() -> Result<Permit<'static>, String> {
    acquire(256 * MIB)
}

#[derive(Default)]
struct State {
    jobs: usize,
    bytes: usize,
    next: u64,
    waiting: VecDeque<u64>,
}
struct Gate {
    state: Mutex<State>,
    changed: Condvar,
}
impl Gate {
    const fn new() -> Self {
        Self {
            state: Mutex::new(State {
                jobs: 0,
                bytes: 0,
                next: 0,
                waiting: VecDeque::new(),
            }),
            changed: Condvar::new(),
        }
    }
    fn enter(
        &self,
        bytes: usize,
        mut capacity: impl FnMut() -> Limits,
    ) -> Result<Permit<'_>, String> {
        let address = self as *const Self as usize;
        if DEPTH.with(|depth| {
            let (owner, count) = depth.get();
            if owner == address && count > 0 {
                depth.set((owner, count + 1));
                true
            } else {
                false
            }
        }) {
            return Ok(Permit {
                gate: self,
                bytes: None,
                _thread: PhantomData,
            });
        }
        let mut state = self.state.lock().map_err(|_| "图片处理队列暂不可用")?;
        let ticket = state.next;
        state.next += 1;
        state.waiting.push_back(ticket);
        loop {
            let limit = capacity();
            if state.waiting.front() == Some(&ticket)
                && state.jobs < limit.workers
                && (state.jobs == 0 || state.bytes.saturating_add(bytes) <= limit.bytes)
            {
                break;
            }
            state = self
                .changed
                .wait(state)
                .map_err(|_| "图片处理队列暂不可用")?;
        }
        state.waiting.pop_front();
        state.jobs += 1;
        state.bytes = state.bytes.saturating_add(bytes);
        DEPTH.with(|depth| depth.set((address, 1)));
        self.changed.notify_all();
        Ok(Permit {
            gate: self,
            bytes: Some(bytes),
            _thread: PhantomData,
        })
    }
}
pub(crate) struct Permit<'a> {
    gate: &'a Gate,
    bytes: Option<usize>,
    _thread: PhantomData<Rc<()>>,
}
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        DEPTH.with(|depth| {
            let (owner, count) = depth.get();
            depth.set(if count > 1 {
                (owner, count - 1)
            } else {
                (0, 0)
            });
        });
        if let Some(bytes) = self.bytes {
            let mut state = self
                .gate
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.jobs -= 1;
            state.bytes = state.bytes.saturating_sub(bytes);
            self.gate.changed.notify_all();
        }
    }
}

/** Concurrent subscribers to the same cache entry render it only once. */
pub(crate) fn key_lock(path: &Path) -> Result<Arc<Mutex<()>>, String> {
    static KEYS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut keys = KEYS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "图片缓存暂不可用")?;
    if let Some(lock) = keys.get(path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    if keys.len() > 128 {
        keys.retain(|_, entry| entry.strong_count() > 0);
    }
    let lock = Arc::new(Mutex::new(()));
    keys.insert(path.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrency_uses_available_memory_and_leaves_cpu_headroom() {
        assert_eq!(limits(2, Some(8 * 1024 * MIB)).workers, 1);
        assert_eq!(limits(4, Some(8 * 1024 * MIB)).workers, 2);
        assert_eq!(limits(32, Some(8 * 1024 * MIB)).workers, 4);
        assert_eq!(limits(32, None).workers, 1);
        assert_eq!(limits(32, Some(8 * 1024 * MIB)).bytes, 1024 * MIB);
        assert_eq!(limits(32, Some(256 * MIB)).bytes, 192 * MIB);
    }
    #[test]
    fn independent_jobs_overlap_but_large_sources_wait_and_nested_calls_do_not_deadlock() {
        let gate = Gate::new();
        let capacity = || Limits {
            workers: 4,
            bytes: 800,
        };
        let first = gate.enter(300, capacity).unwrap();
        {
            let _nested = gate.enter(900, capacity).unwrap();
            assert_eq!(gate.state.lock().unwrap().jobs, 1);
        }
        std::thread::scope(|scope| {
            let (tx, rx) = std::sync::mpsc::channel();
            let (finish, hold) = std::sync::mpsc::channel();
            let shared = &gate;
            scope.spawn(move || {
                let _job = shared.enter(300, capacity).unwrap();
                tx.send(()).unwrap();
                hold.recv().unwrap();
            });
            rx.recv_timeout(std::time::Duration::from_secs(2))
                .expect("independent images must overlap");
            assert_eq!(gate.state.lock().unwrap().jobs, 2);
            let (started, wait) = std::sync::mpsc::channel();
            scope.spawn(move || {
                let _large = shared.enter(700, capacity).unwrap();
                started.send(()).unwrap();
            });
            assert!(wait
                .recv_timeout(std::time::Duration::from_millis(40))
                .is_err());
            finish.send(()).unwrap();
            drop(first);
            wait.recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
        });
        assert_eq!(gate.state.lock().unwrap().jobs, 0);
    }
}
