//! ia-shim: supervises one agent run so it outlives the huntaway server and host.
//!
//! Usage: `ia-shim <run-dir> -- <program> [args...]`
//!
//! Detaches into its own session, then runs the program with stdin from `<run-dir>/prompt`,
//! stdout appended to `<run-dir>/out.jsonl` and stderr to `<run-dir>/err.log`. If the run dir
//! has an `input.jsonl`, stdin is a pipe instead: the shim writes `prompt` to it, then whatever
//! is appended to `input.jsonl` as it arrives, and closes it once `input.closed` exists and
//! everything before it has been passed on. It records the
//! program's pid (also its process group id) in `<run-dir>/pid` and, once it exits, the status
//! in `<run-dir>/exit` as JSON. The working directory and environment are inherited.
//!
//! Running shims are never upgraded, so this file is kept small, dependency-free apart from
//! libc, and should rarely change.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 || args[1] != "--" {
        eprintln!("usage: ia-shim <run-dir> -- <program> [args...]");
        std::process::exit(2);
    }
    let run_dir = Path::new(&args[0]);
    let (program, program_args) = (&args[2], &args[3..]);

    // The launcher gets control back immediately; the new session drops any controlling
    // terminal and process group, so nothing the launcher does later can signal us.
    unsafe {
        match libc::fork() {
            -1 => fail(run_dir, "fork failed"),
            0 => {}
            _ => std::process::exit(0),
        }
        libc::setsid();
    }
    write_atomic(run_dir, "shim.pid", &std::process::id().to_string());

    let append = |name: &str| OpenOptions::new().create(true).append(true).open(run_dir.join(name));
    let (out, err) = match (append("out.jsonl"), append("err.log")) {
        (Ok(o), Ok(e)) => (o, e),
        _ => fail(run_dir, "cannot open output files"),
    };
    let relay = run_dir.join("input.jsonl").exists();
    let stdin = if relay {
        Stdio::piped()
    } else {
        File::open(run_dir.join("prompt")).map(Stdio::from).unwrap_or_else(|_| Stdio::null())
    };
    let mut child = match Command::new(program)
        .args(program_args)
        .stdin(stdin)
        .stdout(out)
        .stderr(err)
        // Own process group, so the whole tree can be stopped with kill(-pid).
        .process_group(0)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => fail(run_dir, &format!("failed to start {program}: {e}")),
    };
    write_atomic(run_dir, "pid", &child.id().to_string());
    if let Some(pipe) = child.stdin.take() {
        let dir = run_dir.to_path_buf();
        std::thread::spawn(move || relay_input(&dir, pipe));
    }
    let exit = match child.wait() {
        Ok(s) => format!(r#"{{"code":{},"signal":{}}}"#, opt(s.code()), opt(s.signal())),
        Err(e) => format!(r#"{{"code":null,"signal":null,"error":{}}}"#, json_string(&e.to_string())),
    };
    write_atomic(run_dir, "exit", &exit);
}

/// Feed the program `prompt`, then `input.jsonl` as it grows, until `input.closed` appears.
/// Returns (closing the pipe) once that's done or the program stops reading.
fn relay_input(dir: &Path, mut pipe: ChildStdin) {
    let file = |name: &str| -> PathBuf { dir.join(name) };
    let Ok(prompt) = fs::read(file("prompt")) else { return };
    let Ok(mut input) = File::open(file("input.jsonl")) else { return };
    if pipe.write_all(&prompt).is_err() {
        return;
    }
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        // Checked before reading, so everything written ahead of the marker gets through.
        let closed = file("input.closed").exists();
        loop {
            match input.read(&mut buf) {
                Ok(0) => break,
                Ok(n) if pipe.write_all(&buf[..n]).is_ok() => {}
                _ => return,
            }
        }
        if closed {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn fail(run_dir: &Path, msg: &str) -> ! {
    write_atomic(run_dir, "exit", &format!(r#"{{"code":null,"signal":null,"error":{}}}"#, json_string(msg)));
    std::process::exit(1);
}

/// Readers poll for these files, so they must never see a partial write.
fn write_atomic(dir: &Path, name: &str, content: &str) {
    let tmp = dir.join(format!(".{name}.tmp"));
    if fs::write(&tmp, content).is_ok() {
        let _ = fs::rename(tmp, dir.join(name));
    }
}

fn opt(v: Option<i32>) -> String {
    v.map(|n| n.to_string()).unwrap_or_else(|| "null".into())
}

fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
