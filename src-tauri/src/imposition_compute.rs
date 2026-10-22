//! Per-job search concurrency; never change the desktop process environment.
use serde::Serialize;
use std::{process::Command, thread};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpositionComputeInfo {
    logical_cores: usize,
    default_threads: usize,
}

fn resolve_threads(requested: Option<u32>, logical_cores: usize) -> usize {
    let cores = logical_cores.max(1);
    requested
        .filter(|&count| count > 0)
        .map(|count| (count as usize).clamp(1, cores))
        .unwrap_or_else(|| (cores / 2).max(1))
}

#[tauri::command]
pub fn get_imposition_compute_info() -> ImpositionComputeInfo {
    let logical_cores = thread::available_parallelism().map_or(1, usize::from);
    ImpositionComputeInfo {
        logical_cores,
        default_threads: resolve_threads(None, logical_cores),
    }
}

pub fn configure_search_threads(command: &mut Command, requested: Option<u32>) {
    let info = get_imposition_compute_info();
    command.env(
        "PRINTFLOW_NESTING_THREADS",
        resolve_threads(requested, info.logical_cores).to_string(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_uses_half_available_logical_cores_with_a_single_thread_minimum() {
        for (cores, expected) in [(0, 1), (1, 1), (2, 1), (3, 1), (8, 4), (24, 12)] {
            assert_eq!(resolve_threads(None, cores), expected);
            assert_eq!(resolve_threads(Some(0), cores), expected);
        }
    }

    #[test]
    fn explicit_selection_supports_all_core_counts_and_clamps_on_another_pc() {
        assert_eq!(resolve_threads(Some(3), 8), 3);
        assert_eq!(resolve_threads(Some(7), 8), 7);
        assert_eq!(resolve_threads(Some(32), 8), 8);
        assert_eq!(resolve_threads(Some(u32::MAX), 1), 1);
    }

    #[test]
    fn thread_selection_is_isolated_to_the_solver_child_process() {
        let mut first = Command::new("python");
        let mut second = Command::new("python");
        configure_search_threads(&mut first, Some(1));
        configure_search_threads(&mut second, None);
        let configured = |command: &Command| {
            command
                .get_envs()
                .find(|(key, _)| *key == "PRINTFLOW_NESTING_THREADS")
                .and_then(|(_, value)| value)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(configured(&first), "1");
        assert_eq!(
            configured(&second),
            get_imposition_compute_info().default_threads.to_string()
        );
    }
}
