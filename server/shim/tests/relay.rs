//! The shim passes `input.jsonl` on to the program as it grows, and ends its input once
//! `input.closed` appears.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn wait_for(path: &Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(start.elapsed() < Duration::from_secs(10), "{} never appeared", path.display());
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A run folder, removed when it's dropped (when the test ends, panics included).
struct RunDir(PathBuf);

impl std::ops::Deref for RunDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for RunDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run_dir() -> RunDir {
    let dir = std::env::temp_dir().join(format!("ia-shim-test-{}-{:?}", std::process::id(), Instant::now()));
    fs::create_dir_all(&dir).unwrap();
    RunDir(dir)
}

#[test]
fn relays_input_until_it_is_closed() {
    let dir = run_dir();
    fs::write(dir.join("prompt"), "first\n").unwrap();
    fs::write(dir.join("input.jsonl"), "").unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_ia-shim")).arg(&*dir).args(["--", "cat"]).status().unwrap();
    assert!(status.success());
    wait_for(&dir.join("pid"));

    let mut input = fs::OpenOptions::new().append(true).open(dir.join("input.jsonl")).unwrap();
    input.write_all(b"second\n").unwrap();
    // Still reading: cat hasn't seen the end of its input.
    std::thread::sleep(Duration::from_millis(300));
    assert!(!dir.join("exit").exists());
    assert_eq!(fs::read_to_string(dir.join("out.jsonl")).unwrap(), "first\nsecond\n");

    // Written just before the marker, it still gets through.
    input.write_all(b"third\n").unwrap();
    fs::write(dir.join("input.closed"), "").unwrap();
    wait_for(&dir.join("exit"));
    assert_eq!(fs::read_to_string(dir.join("out.jsonl")).unwrap(), "first\nsecond\nthird\n");
    assert_eq!(fs::read_to_string(dir.join("exit")).unwrap(), r#"{"code":0,"signal":null}"#);
}

#[test]
fn without_input_reads_the_prompt_file() {
    let dir = run_dir();
    fs::write(dir.join("prompt"), "only\n").unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_ia-shim")).arg(&*dir).args(["--", "cat"]).status().unwrap();
    assert!(status.success());
    wait_for(&dir.join("exit"));
    assert_eq!(fs::read_to_string(dir.join("out.jsonl")).unwrap(), "only\n");
}
