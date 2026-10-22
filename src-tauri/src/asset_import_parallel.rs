//! Bounded parallel work for SVG imports, with delivery in source order.
//!
//! A window contains at most one item per worker. The next window starts only
//! after the current one has been delivered, so a slow first item cannot build
//! up an unbounded queue of completed SVG resources.

use std::{panic::AssertUnwindSafe, sync::mpsc, thread};

fn workers_for_cores(logical_cores: usize) -> usize {
    (logical_cores / 2).max(1)
}

pub(super) fn default_workers() -> usize {
    workers_for_cores(thread::available_parallelism().map_or(1, usize::from))
}

pub(super) fn for_each_ordered<T: Send, R: Send>(
    items: Vec<T>,
    workers: usize,
    work: impl Fn(usize, T) -> Result<R, String> + Sync,
    mut emit: impl FnMut(usize, R) -> Result<(), String>,
) -> Result<(), String> {
    let workers = workers.max(1).min(items.len());
    if workers <= 1 {
        for (index, item) in items.into_iter().enumerate() {
            emit(index, work(index, item)?)?;
        }
        return Ok(());
    }

    thread::scope(|scope| {
        // Every outstanding task can publish its result even when an error
        // makes the caller stop receiving. Dropping the task senders then
        // releases idle workers before the scope waits for them to exit.
        let (result_sender, result_receiver) = mpsc::sync_channel(workers);
        let mut task_senders = Vec::with_capacity(workers);
        for worker in 0..workers {
            let (task_sender, task_receiver) = mpsc::sync_channel::<(usize, T)>(1);
            let result_sender = result_sender.clone();
            let work = &work;
            thread::Builder::new()
                .name(format!("svg-import-{worker}"))
                .spawn_scoped(scope, move || {
                    while let Ok((index, item)) = task_receiver.recv() {
                        let result =
                            std::panic::catch_unwind(AssertUnwindSafe(|| work(index, item)))
                                .unwrap_or_else(|_| Err("图片解析工作线程意外终止".into()));
                        if result_sender.send((index, result)).is_err() {
                            break;
                        }
                    }
                })
                .map_err(|error| format!("无法启动图片解析工作线程：{error}"))?;
            task_senders.push(task_sender);
        }
        drop(result_sender);

        let mut items = items.into_iter().enumerate();
        let mut window_start = 0;
        loop {
            let mut count = 0;
            for sender in &task_senders {
                let Some(item) = items.next() else {
                    break;
                };
                sender
                    .send(item)
                    .map_err(|_| "图片解析工作线程已退出".to_owned())?;
                count += 1;
            }
            if count == 0 {
                break;
            }

            let mut results: Vec<Option<Result<R, String>>> =
                std::iter::repeat_with(|| None).take(count).collect();
            for _ in 0..count {
                let (index, result) = result_receiver
                    .recv()
                    .map_err(|_| "图片解析工作线程未返回结果".to_owned())?;
                results[index - window_start] = Some(result);
            }
            for (offset, result) in results.into_iter().enumerate() {
                let result = result.ok_or("图片解析结果缺失")??;
                emit(window_start + offset, result)?;
            }
            window_start += count;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        collections::HashSet,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Condvar, Mutex,
        },
        time::Duration,
    };

    #[test]
    fn defaults_to_half_available_cores_with_a_single_worker_minimum() {
        for (cores, expected) in [(0, 1), (1, 1), (2, 1), (3, 1), (4, 2), (8, 4), (24, 12)] {
            assert_eq!(workers_for_cores(cores), expected);
        }
        assert_eq!(
            default_workers(),
            workers_for_cores(thread::available_parallelism().map_or(1, usize::from))
        );
    }

    #[test]
    fn uses_a_fixed_pool_and_never_exceeds_the_requested_concurrency() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let started = Mutex::new(0);
        let wake = Condvar::new();
        let worker_ids = Mutex::new(HashSet::new());
        let caller = thread::current().id();
        let mut emitted = Vec::new();
        for_each_ordered(
            (0..10).collect(),
            3,
            |index, item| {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                assert!(count <= 3);
                worker_ids.lock().unwrap().insert(thread::current().id());
                if index < 3 {
                    let mut started = started.lock().unwrap();
                    *started += 1;
                    wake.notify_all();
                    let (started, _) = wake
                        .wait_timeout_while(started, Duration::from_secs(2), |count| *count < 3)
                        .unwrap();
                    if *started != 3 {
                        active.fetch_sub(1, Ordering::SeqCst);
                        return Err("first window did not execute concurrently".into());
                    }
                }
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(item)
            },
            |index, item| {
                assert_eq!(thread::current().id(), caller);
                assert_eq!(index, item);
                emitted.push(item);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), 3);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(worker_ids.into_inner().unwrap().len(), 3);
        assert_eq!(emitted, (0..10).collect::<Vec<_>>());
    }

    #[test]
    fn reversely_completed_windows_are_emitted_in_source_order() {
        let next_to_finish = Mutex::new(2);
        let wake = Condvar::new();
        let completion_order = Mutex::new(Vec::new());
        let mut emission_order = Vec::new();
        for_each_ordered(
            (0..6).collect(),
            3,
            |index, item| {
                let next = next_to_finish.lock().unwrap();
                let (mut next, _) = wake
                    .wait_timeout_while(next, Duration::from_secs(2), |next| *next != index)
                    .unwrap();
                if *next != index {
                    return Err("workers did not complete the expected window".into());
                }
                completion_order.lock().unwrap().push(index);
                *next = if index == 0 { 5 } else { index - 1 };
                wake.notify_all();
                Ok(item)
            },
            |index, item| {
                emission_order.push((index, item));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(completion_order.into_inner().unwrap(), [2, 1, 0, 5, 4, 3]);
        assert_eq!(emission_order, (0..6).map(|i| (i, i)).collect::<Vec<_>>());
    }

    fn finishes_without_deadlock(
        run: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || sender.send(run()).unwrap());
        let result = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("parallel import must terminate after an error");
        handle.join().unwrap();
        result
    }

    #[test]
    fn work_failure_stops_before_the_next_window_and_joins_workers() {
        let processed = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&processed);
        let result = finishes_without_deadlock(move || {
            for_each_ordered(
                (0..12).collect(),
                3,
                |index, item| {
                    count.fetch_add(1, Ordering::SeqCst);
                    if index == 1 {
                        Err("invalid SVG".into())
                    } else {
                        Ok(item)
                    }
                },
                |index, _| {
                    assert_eq!(index, 0);
                    Ok(())
                },
            )
        });
        assert_eq!(result.unwrap_err(), "invalid SVG");
        assert_eq!(processed.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn delivery_failure_stops_before_the_next_window_and_joins_workers() {
        let processed = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&processed);
        let result = finishes_without_deadlock(move || {
            for_each_ordered(
                (0..12).collect(),
                3,
                |_, item| {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(item)
                },
                |index, _| {
                    if index == 1 {
                        Err("delivery failed".into())
                    } else {
                        assert_eq!(index, 0);
                        Ok(())
                    }
                },
            )
        });
        assert_eq!(result.unwrap_err(), "delivery failed");
        assert_eq!(processed.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn worker_panic_is_reported_without_blocking_the_other_workers() {
        let result = finishes_without_deadlock(|| {
            for_each_ordered(
                vec![0, 1, 2],
                2,
                |index, item| {
                    assert_ne!(index, 0, "broken parser");
                    Ok(item)
                },
                |_, _| panic!("nothing should be delivered after the first item fails"),
            )
        });
        assert_eq!(result.unwrap_err(), "图片解析工作线程意外终止");
    }

    #[test]
    fn empty_input_does_not_execute_or_deliver_work() {
        for_each_ordered(
            Vec::<usize>::new(),
            8,
            |_, item| Ok(item),
            |_, _| panic!("empty input must not emit"),
        )
        .unwrap();
    }

    #[test]
    fn one_worker_runs_on_the_caller_and_accepts_a_non_sync_callback() {
        let caller = thread::current().id();
        for workers in [0, 1] {
            let values = RefCell::new(Vec::new());
            for_each_ordered(
                vec![4, 5, 6],
                workers,
                |_, item| {
                    assert_eq!(thread::current().id(), caller);
                    Ok(item)
                },
                |index, item| {
                    values.borrow_mut().push((index, item));
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(values.into_inner(), [(0, 4), (1, 5), (2, 6)]);
        }
        for_each_ordered(
            vec![1],
            64,
            |_, item| {
                assert_eq!(thread::current().id(), caller);
                Ok(item)
            },
            |_, _| Ok(()),
        )
        .unwrap();
    }
}
