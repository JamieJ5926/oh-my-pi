//! Cancellation of CPU-bound builtin loops under a saturated tokio runtime.
//!
//! A loop whose body is builtins only (`while :; do :; done`) never awaits
//! anything that returns `Pending`, so it never releases its runtime worker.
//! Enough of them at once starve every worker, and then neither the cancel
//! bridge nor the deadline task can be polled, so the loops run forever and
//! the whole process stops responding. Observed on 2026-09-24 with 40 such
//! loops launched by one bash command: the omp process sat at ~1000% CPU and
//! only a restart cleared it.
#![cfg(unix)]

use std::time::{Duration, Instant};

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

const LOOP_DEADLINE: Duration = Duration::from_secs(2);
const SETTLE_BUDGET: Duration = Duration::from_secs(15);
const WATCHDOG: Duration = Duration::from_secs(20);

fn loop_run(chunks: flume::Sender<String>) -> impl Future<Output = bool> {
	async move {
		execute_shell(
			ShellExecuteOptions { command: "while :; do :; done".to_string(), ..Default::default() },
			Some(chunks),
			CancelToken::with_timeout(Some(LOOP_DEADLINE)),
		)
		.await
		.is_ok()
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn saturated_runtime_still_settles_builtin_loops() {
	let workers = std::thread::available_parallelism().map_or(4, |n| n.get());

	// The watchdog is the only alarm that survives a starved runtime: tokio
	// timers are serviced by the same workers the loops hold.
	std::thread::spawn(move || {
		std::thread::sleep(WATCHDOG);
		eprintln!("watchdog: builtin loops still running after {WATCHDOG:?}; the runtime is starved");
		std::process::exit(101);
	});

	let started = Instant::now();
	let (loop_chunks, _loop_rx) = flume::unbounded::<String>();
	let mut loops = Vec::new();
	for _ in 0..workers + 2 {
		loops.push(tokio::spawn(loop_run(loop_chunks.clone())));
	}
	drop(loop_chunks);

	let (follow_tx, follow_rx) = flume::unbounded::<String>();
	let follow_up = tokio::time::timeout(
		SETTLE_BUDGET,
		execute_shell(
			ShellExecuteOptions { command: "echo follow-up-ok".to_string(), ..Default::default() },
			Some(follow_tx),
			CancelToken::with_timeout(Some(Duration::from_secs(5))),
		),
	)
	.await
	.expect("a follow-up command must be serviced while the loops are live")
	.expect("follow-up run");
	assert_eq!(follow_up.exit_code, Some(0), "follow-up command failed");
	let mut follow_output = String::new();
	while let Ok(chunk) = follow_rx.try_recv() {
		follow_output.push_str(&chunk);
	}
	assert!(follow_output.contains("follow-up-ok"), "follow-up output missing: {follow_output:?}");

	for (index, handle) in loops.into_iter().enumerate() {
		let settled = tokio::time::timeout(SETTLE_BUDGET, handle)
			.await
			.unwrap_or_else(|_| panic!("loop {index} never settled"));
		settled.unwrap_or_else(|err| panic!("loop {index} panicked: {err}"));
	}

	let elapsed = started.elapsed();
	assert!(elapsed < SETTLE_BUDGET, "loops took {elapsed:?} to settle, budget {SETTLE_BUDGET:?}");
}
