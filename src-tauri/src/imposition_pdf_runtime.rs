//! Export-wide CPU admission and process isolation. The helper enters before
//! Tauri starts: image decoders and PDF allocations never run in the UI process.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Condvar, Mutex},
};

pub(crate) const RESERVE: usize = 512 * 1024 * 1024;
pub(crate) const PER_WORKER: usize = 256 * 1024 * 1024;
const WORKER_FLAG: &str = "--printflow-imposition-pdf-worker";

pub(crate) fn automatic_workers() -> usize {
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
    (cpus.saturating_mul(4) / 5).max(1)
}

pub(crate) fn memory_workers(pages: usize, ceiling: usize, available: Option<usize>) -> usize {
    let memory = available.map_or(1, |n| n.saturating_sub(RESERVE) / PER_WORKER);
    pages.min(ceiling).min(memory.max(1)).max(1)
}

pub(crate) fn available_memory() -> Option<usize> {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct Status {
            length: u32,
            load: u32,
            total_phys: u64,
            avail_phys: u64,
            total_page: u64,
            avail_page: u64,
            total_virtual: u64,
            avail_virtual: u64,
            extended: u64,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GlobalMemoryStatusEx(status: *mut Status) -> i32;
        }
        let mut status: Status = unsafe { std::mem::zeroed() };
        status.length = std::mem::size_of::<Status>() as u32;
        return (unsafe { GlobalMemoryStatusEx(&mut status) } != 0)
            .then(|| usize::try_from(status.avail_phys.min(status.avail_page)).ok())
            .flatten();
    }
    #[cfg(target_os = "linux")]
    {
        let info = fs::read_to_string("/proc/meminfo").ok()?;
        return info
            .lines()
            .find(|line| line.starts_with("MemAvailable:"))?
            .split_whitespace()
            .nth(1)?
            .parse::<usize>()
            .ok()?
            .checked_mul(1024);
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        None
    }
}

pub(crate) fn worker_memory() -> Option<usize> {
    let available = available_memory();
    #[cfg(windows)]
    if let Ok(limit) = std::env::var("PRINTFLOW_PDF_MEMORY_LIMIT") {
        if let Ok(limit) = limit.parse::<usize>() {
            #[repr(C)]
            #[derive(Default)]
            struct Counters {
                size: u32,
                faults: u32,
                peak_working_set: usize,
                working_set: usize,
                peak_paged: usize,
                paged: usize,
                peak_nonpaged: usize,
                nonpaged: usize,
                pagefile: usize,
                peak_pagefile: usize,
                private_bytes: usize,
            }
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn GetCurrentProcess() -> *mut std::ffi::c_void;
                fn K32GetProcessMemoryInfo(
                    process: *mut std::ffi::c_void,
                    counters: *mut Counters,
                    size: u32,
                ) -> i32;
            }
            let mut counters = Counters::default();
            counters.size = std::mem::size_of::<Counters>() as u32;
            let used = if unsafe {
                K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.size)
            } != 0
            {
                counters.private_bytes
            } else {
                limit / 2
            };
            // Leave space for the final PDF buffer/renumbering as well as pages.
            let headroom = limit.saturating_sub(used).saturating_sub(64 * 1024 * 1024);
            return Some(
                available
                    .unwrap_or(usize::MAX)
                    .min(headroom.saturating_add(RESERVE)),
            );
        }
    }
    available
}

#[derive(Default)]
struct Active {
    files: usize,
    threads: usize,
    memory: usize,
}
static ACTIVE: Mutex<Active> = Mutex::new(Active {
    files: 0,
    threads: 0,
    memory: 0,
});
static CHANGED: Condvar = Condvar::new();
struct Permit {
    workers: usize,
    memory: Option<usize>,
}
impl Permit {
    fn acquire(requested: Option<usize>, estimate: usize) -> Result<Self, String> {
        let ceiling = automatic_workers();
        let requested = requested.unwrap_or(ceiling).clamp(1, ceiling);
        let mut active = ACTIVE.lock().map_err(|_| "PDF 调度器异常")?;
        loop {
            // Conservatively subtract outstanding reservations as well as the
            // OS-reported pressure. Never admit two jobs against the same free RAM.
            let remaining =
                available_memory().map(|n| n.saturating_sub(RESERVE).saturating_sub(active.memory));
            if active.files == 0 && remaining.is_some_and(|n| n < PER_WORKER) {
                return Err("可用内存不足，已安全停止 PDF 导出；请释放内存后重试".into());
            }
            let memory_ready = active.files == 0 || remaining.is_some_and(|n| n >= estimate);
            if active.files < 2 && active.threads < ceiling && memory_ready {
                let threads = requested.min(ceiling - active.threads);
                let memory = remaining.map(|n| estimate.max(n / 2).min(n));
                active.files += 1;
                active.threads += threads;
                active.memory = active.memory.saturating_add(memory.unwrap_or(0));
                return Ok(Self {
                    workers: threads,
                    memory,
                });
            }
            active = CHANGED.wait(active).map_err(|_| "PDF 调度器异常")?;
        }
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            active.files -= 1;
            active.threads -= self.workers;
            active.memory -= self.memory.unwrap_or(0);
            CHANGED.notify_all();
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    page_ids: Vec<String>,
    width: f32,
    height: f32,
    workers: usize,
    #[serde(default)]
    cmyk_job: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Event {
    page: usize,
    phase: String,
    error: Option<String>,
}

struct Scratch(PathBuf);
impl Scratch {
    fn create() -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "printflow-pdf-worker-{}-{stamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).map_err(|e| format!("创建 PDF 工作目录失败：{e}"))?;
        Ok(Self(dir))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        // Delete only the three exact files created by this transaction.
        for name in ["job.json", "result.pdf", "error.log"] {
            let _ = fs::remove_file(self.0.join(name));
        }
        let _ = fs::remove_dir(&self.0);
    }
}
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(crate) fn export_isolated(
    output: &Path,
    page_ids: Vec<String>,
    size: (f32, f32),
    requested: Option<usize>,
    report: impl Fn(usize, &str),
) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let first = export_with_executable(
        &executable,
        output,
        page_ids.clone(),
        size,
        requested,
        &report,
    );
    // An OS/decoder abort cannot unwind. Retry once with a single page worker
    // after the child and its scratch resources have been fully reaped.
    match first {
        Err(error) if error.contains("PDF 转换进程异常退出") && requested != Some(1) => {
            report(1, "resources");
            export_with_executable(&executable, output, page_ids, size, Some(1), report)
        }
        result => result,
    }
}

fn export_with_executable(
    executable: &Path,
    output: &Path,
    page_ids: Vec<String>,
    size: (f32, f32),
    requested: Option<usize>,
    report: impl Fn(usize, &str),
) -> Result<(), String> {
    export_job_with_executable(executable, output, page_ids, size, requested, None, report)
}

pub(crate) fn export_cmyk_isolated(
    output: &Path,
    job_id: String,
    job: &crate::imposition_cmyk::Job,
    report: impl Fn(usize, &str),
) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut ids = job.ids();
    ids.push(job_id.clone());
    export_job_with_executable(
        &executable,
        output,
        ids,
        (
            (job.width_mm * 72. / 25.4) as f32,
            (job.height_mm * 72. / 25.4) as f32,
        ),
        Some(automatic_workers().min(job.sources.len())),
        Some(job_id),
        report,
    )
}

fn export_job_with_executable(
    executable: &Path,
    output: &Path,
    page_ids: Vec<String>,
    size: (f32, f32),
    requested: Option<usize>,
    cmyk_job: Option<String>,
    report: impl Fn(usize, &str),
) -> Result<(), String> {
    report(0, "queue");
    let sizes = page_ids
        .iter()
        .map(|id| {
            fs::metadata(crate::staged_artwork::path(id)?)
                .map(|m| usize::try_from(m.len()).unwrap_or(usize::MAX))
                .map_err(|e| format!("读取 SVG 页面大小失败：{e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    // Base64-compressed artwork can decode to much larger bitmaps. Include room
    // for retained PDF streams and final assembly, not just concurrent SVG text.
    let estimate = sizes
        .iter()
        .copied()
        .max()
        .unwrap_or(0)
        .saturating_mul(24)
        .saturating_add(
            sizes
                .iter()
                .fold(0usize, |sum, n| sum.saturating_add(*n))
                .saturating_mul(3),
        )
        .saturating_add(PER_WORKER);
    let permit = Permit::acquire(
        Some(
            requested
                .unwrap_or_else(automatic_workers)
                .min(page_ids.len()),
        ),
        estimate,
    )?;
    let scratch = Scratch::create()?;
    let manifest = scratch.0.join("job.json");
    let file = fs::File::create(&manifest).map_err(|e| e.to_string())?;
    serde_json::to_writer(
        file,
        &Manifest {
            page_ids,
            width: size.0,
            height: size.1,
            workers: permit.workers,
            cmyk_job,
        },
    )
    .map_err(|e| e.to_string())?;
    // Keep a reserve for the desktop and other applications. A Windows job is a
    // hard per-process commit limit, beyond the adaptive batch concurrency.
    let memory_limit = permit.memory;
    let stderr = fs::File::create(scratch.0.join("error.log")).map_err(|e| e.to_string())?;
    let mut command = Command::new(executable);
    command
        .arg(WORKER_FLAG)
        .arg(&manifest)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr);
    if let Some(limit) = memory_limit {
        command.env("PRINTFLOW_PDF_MEMORY_LIMIT", limit.to_string());
    } else {
        command.env_remove("PRINTFLOW_PDF_MEMORY_LIMIT");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut process = Process(
        command
            .spawn()
            .map_err(|e| format!("启动 PDF 后台进程失败：{e}"))?,
    );
    #[cfg(windows)]
    let _job = windows_job::Job::attach(&process.0, memory_limit)?;
    // The helper cannot decode anything until its resource guard is installed.
    process
        .0
        .stdin
        .take()
        .ok_or("PDF 后台进程输入不可用")?
        .write_all(b"G")
        .map_err(|e| e.to_string())?;
    let stdout = process.0.stdout.take().ok_or("PDF 后台进度不可用")?;
    let mut worker_error = None;
    let mut page = 0;
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = String::new();
        let bytes = (&mut reader)
            .take(64 * 1024)
            .read_line(&mut line)
            .map_err(|e| format!("读取 PDF 后台进度失败：{e}"))?;
        if bytes == 0 {
            break;
        }
        if !line.ends_with('\n') {
            return Err("PDF 后台进度超出安全长度或被中断".into());
        }
        let event: Event =
            serde_json::from_str(&line).map_err(|e| format!("PDF 后台进度格式无效：{e}"))?;
        page = event.page;
        if let Some(error) = event.error {
            worker_error = Some(error);
        } else {
            report(event.page, &event.phase);
        }
    }
    let status = process.0.wait().map_err(|e| e.to_string())?;
    if !status.success() || worker_error.is_some() {
        return Err(worker_error.unwrap_or_else(|| format!(
            "第 {page} 页附近的 PDF 转换进程异常退出（{status}，可能内存不足或图片解码异常）；主程序已保护，可重试导出")));
    }
    report(page, "write");
    crate::imposition_pdf::commit_pdf_file(output, &scratch.0.join("result.pdf"))
}

/// Called by main before creating the Tauri runtime. None means normal launch.
pub fn run_pdf_worker_if_requested() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(WORKER_FLAG)) {
        return None;
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn SetErrorMode(mode: u32) -> u32;
        }
        // A resource failure must return to the parent instead of blocking on
        // a Windows crash/critical-error dialog in this hidden worker.
        unsafe {
            SetErrorMode(0x0001 | 0x0002 | 0x8000);
        }
    }
    let mut gate = [0u8];
    if std::io::stdin().read_exact(&mut gate).is_err() || gate != *b"G" {
        return Some(2);
    }
    let path = match args.next() {
        Some(path) if args.next().is_none() => PathBuf::from(path),
        _ => return Some(2),
    };
    let last_page = std::cell::Cell::new(0);
    let emit = |page: usize, phase: &str, error: Option<String>| {
        let mut out = std::io::stdout().lock();
        if serde_json::to_writer(
            &mut out,
            &Event {
                page,
                phase: phase.into(),
                error,
            },
        )
        .is_ok()
        {
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
    };
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
            let job: Manifest =
                serde_json::from_reader(fs::File::open(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if job.page_ids.is_empty()
                || !job.width.is_finite()
                || !job.height.is_finite()
                || job.width <= 0.0
                || job.height <= 0.0
            {
                return Err("PDF 后台任务参数无效".into());
            }
            let staged = job
                .page_ids
                .iter()
                .map(|id| crate::staged_artwork::path(id))
                .collect::<Result<Vec<_>, _>>()?;
            let bytes = if let Some(id) = &job.cmyk_job {
                let cmyk = crate::imposition_cmyk::Job::load(id)?;
                crate::imposition_cmyk::render_job(&cmyk, job.workers, |page, phase| {
                    last_page.set(page);
                    emit(page, phase, None);
                })?
            } else {
                crate::imposition_pdf::render_staged_pdf(
                    &staged,
                    (job.width, job.height),
                    |page, phase| {
                        last_page.set(page);
                        emit(page, phase, None);
                    },
                    Some(job.workers),
                )?
            };
            // Private scratch only. Destination writing is exclusively in the parent.
            fs::write(path.with_file_name("result.pdf"), bytes)
                .map_err(|e| format!("暂存 PDF 失败：{e}"))
        }))
        .unwrap_or_else(|_| Err("PDF 后台任务异常，已安全回收".into()));
    match result {
        Ok(()) => Some(0),
        Err(error) => {
            emit(last_page.get(), "error", Some(error));
            Some(1)
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::{ffi::c_void, os::windows::io::AsRawHandle, process::Child};
    #[repr(C)]
    #[derive(Default)]
    struct Basic {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Io {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Extended {
        basic: Basic,
        io: Io,
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *const c_void,
            size: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub(super) struct Job(*mut c_void);
    impl Job {
        pub(super) fn attach(child: &Child, limit: Option<usize>) -> Result<Self, String> {
            let job = Self(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
            if job.0.is_null() {
                return Err("无法创建 PDF 内存保护任务".into());
            }
            let mut info = Extended::default();
            info.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE
            if let Some(limit) = limit {
                info.basic.flags |= 0x100;
                info.process_memory = limit;
            }
            if unsafe {
                SetInformationJobObject(
                    job.0,
                    9,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<Extended>() as u32,
                )
            } == 0
                || unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } == 0
            {
                return Err(format!(
                    "启用 PDF 内存保护失败：{}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(job)
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrency_follows_memory_in_both_directions_and_cpu_ceiling() {
        assert_eq!(memory_workers(20, 8, Some(RESERVE + PER_WORKER * 8)), 8);
        assert_eq!(memory_workers(20, 8, Some(RESERVE + PER_WORKER * 2)), 2);
        assert_eq!(memory_workers(20, 8, Some(RESERVE + PER_WORKER * 6)), 6);
        assert_eq!(memory_workers(2, 8, Some(usize::MAX)), 2);
        assert_eq!(memory_workers(20, 8, None), 1);
        assert_eq!(memory_workers(20, 8, Some(0)), 1);
    }
    #[test]
    #[ignore = "set PRINTFLOW_PDF_WORKER_EXE and PRINTFLOW_PDF_WORKER_OUTPUT to test the actual child executable"]
    fn actual_isolated_export() {
        let exe = PathBuf::from(std::env::var("PRINTFLOW_PDF_WORKER_EXE").unwrap());
        let output = PathBuf::from(std::env::var("PRINTFLOW_PDF_WORKER_OUTPUT").unwrap());
        let mut ids = vec![];
        for (index, color) in ["red", "green", "blue", "yellow", "white"]
            .into_iter()
            .enumerate()
        {
            let id = format!("{:x}-{:x}", std::process::id(), index);
            fs::write(crate::staged_artwork::path(&id).unwrap(), format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="464mm" viewBox="0 0 300 464"><rect x="20" y="20" width="80" height="80" fill="{color}"/><circle cx="10" cy="10" r="1.5" fill="none" stroke="black" stroke-width="0.2"/></svg>"#)).unwrap();
            ids.push(id);
        }
        let result = export_with_executable(
            &exe,
            &output,
            ids.clone(),
            (850.3937, 1315.2756),
            Some(4),
            |page, phase| eprintln!("{page}:{phase}"),
        );
        for id in ids {
            let _ = fs::remove_file(crate::staged_artwork::path(&id).unwrap());
        }
        result.unwrap();
    }
    #[test]
    #[ignore = "set PRINTFLOW_PDF_WORKER_EXE, PRINTFLOW_PDF_BENCHMARK_PAGES (JSON paths), PRINTFLOW_PDF_BENCHMARK_DIR"]
    fn benchmark_actual_isolated_pages() {
        let exe = PathBuf::from(std::env::var("PRINTFLOW_PDF_WORKER_EXE").unwrap());
        let dir = PathBuf::from(std::env::var("PRINTFLOW_PDF_BENCHMARK_DIR").unwrap());
        let inputs: Vec<PathBuf> =
            serde_json::from_str(&std::env::var("PRINTFLOW_PDF_BENCHMARK_PAGES").unwrap()).unwrap();
        let ids: Vec<_> = inputs
            .iter()
            .enumerate()
            .map(|(i, path)| {
                let id = format!("{:x}-{:x}-b", std::process::id(), i);
                fs::copy(path, crate::staged_artwork::path(&id).unwrap()).unwrap();
                id
            })
            .collect();
        let result = (|| -> Result<(), String> {
            for (name, workers) in [("serial", 1), ("parallel", automatic_workers())] {
                let started = std::time::Instant::now();
                let output = dir.join(format!("{name}.pdf"));
                export_with_executable(
                    &exe,
                    &output,
                    ids.clone(),
                    (850.3937, 1315.2756),
                    Some(workers),
                    |_, _| {},
                )?;
                eprintln!(
                    "{name}: ceiling={workers}, elapsed_ms={}, bytes={}",
                    started.elapsed().as_millis(),
                    fs::metadata(output).unwrap().len()
                );
            }
            let started = std::time::Instant::now();
            std::thread::scope(|scope| {
                let handles: Vec<_> = ids
                    .chunks(2)
                    .enumerate()
                    .map(|(index, pages)| {
                        let exe = &exe;
                        let output = dir.join(format!("layout-{}.pdf", index + 1));
                        scope.spawn(move || {
                            export_with_executable(
                                exe,
                                &output,
                                pages.to_vec(),
                                (850.3937, 1315.2756),
                                Some((automatic_workers() / 2).max(1)),
                                |_, _| {},
                            )
                        })
                    })
                    .collect();
                for handle in handles {
                    handle.join().unwrap()?;
                }
                Ok::<(), String>(())
            })?;
            eprintln!(
                "bounded parallel layouts: elapsed_ms={}",
                started.elapsed().as_millis()
            );
            // A broken later page must not publish anything or poison admission.
            fs::write(
                crate::staged_artwork::path(ids.last().unwrap())?,
                "<svg broken",
            )
            .unwrap();
            let failed = dir.join("invalid.pdf");
            let error = export_with_executable(
                &exe,
                &failed,
                ids.clone(),
                (850.3937, 1315.2756),
                Some(2),
                |_, _| {},
            )
            .unwrap_err();
            assert!(error.contains("页导出失败"), "{error}");
            assert!(!failed.exists());
            eprintln!("invalid-page isolation: {error}");
            Ok(())
        })();
        for id in ids {
            let _ = fs::remove_file(crate::staged_artwork::path(&id).unwrap());
        }
        result.unwrap();
    }
    #[test]
    #[ignore = "set PRINTFLOW_PDF_WORKER_EXE, PRINTFLOW_CMYK_JOB_ID and PRINTFLOW_CMYK_OUTPUT"]
    fn actual_isolated_cmyk_export() {
        let exe = PathBuf::from(std::env::var("PRINTFLOW_PDF_WORKER_EXE").unwrap());
        let output = PathBuf::from(std::env::var("PRINTFLOW_CMYK_OUTPUT").unwrap());
        let id = std::env::var("PRINTFLOW_CMYK_JOB_ID").unwrap();
        let job = crate::imposition_cmyk::Job::load(&id).unwrap();
        let mut ids = job.ids();
        ids.push(id.clone());
        export_job_with_executable(
            &exe,
            &output,
            ids,
            (
                (job.width_mm * 72. / 25.4) as f32,
                (job.height_mm * 72. / 25.4) as f32,
            ),
            Some(automatic_workers().min(job.sources.len())),
            Some(id),
            |i, p| eprintln!("{i}:{p}"),
        )
        .unwrap();
        assert_eq!(&fs::read(&output).unwrap()[..5], b"%PDF-");
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "set PRINTFLOW_PDF_WORKER_EXE; deliberately exhaust a tiny child-only Windows Job limit"]
    fn windows_memory_abort_is_isolated_and_reaped() {
        use std::os::windows::process::CommandExt;
        let scratch = Scratch::create().unwrap();
        let manifest = scratch.0.join("job.json");
        // Valid JSON forces real allocations before any staged-file validation.
        // The deliberately tiny child-only limit cannot accommodate this job.
        fs::write(
            &manifest,
            serde_json::to_vec(&Manifest {
                page_ids: vec!["a".repeat(80); 100_000],
                width: 850.3937,
                height: 1315.2756,
                workers: 1,
                cmyk_job: None,
            })
            .unwrap(),
        )
        .unwrap();
        let mut process = Process(
            Command::new(std::env::var("PRINTFLOW_PDF_WORKER_EXE").unwrap())
                .arg(WORKER_FLAG)
                .arg(&manifest)
                .creation_flags(0x08000000)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let job = windows_job::Job::attach(&process.0, Some(1024 * 1024));
        if let Ok(_job) = job {
            let _ = process.0.stdin.take().unwrap().write_all(b"G");
            let status = process.0.wait().unwrap();
            assert!(!status.success());
            assert!(
                !matches!(status.code(), Some(0..=2)),
                "expected allocation abort, got {status}"
            );
            eprintln!("child-only memory limit exit: {status}; test host remains alive");
        } else {
            eprintln!("OS rejected the tiny child-only memory limit; startup was safely cancelled");
        }
        assert!(!scratch.0.join("result.pdf").exists());
    }
}
