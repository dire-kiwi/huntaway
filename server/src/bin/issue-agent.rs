//! `issue-agent`: the board's binary name before it was renamed to Huntaway. It runs the
//! `huntaway` built next to it with the same arguments, so things that still start
//! `…/target/release/issue-agent` keep working: a host that updates itself with an older build
//! (which restarts that path after building), SSH hosts' `authorized_keys` commands and desktop
//! configs.

use std::path::PathBuf;
use std::process::Command;

fn main() {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("issue-agent"));
    let real = exe.with_file_name(format!("huntaway{}", std::env::consts::EXE_SUFFIX));
    let mut cmd = Command::new(&real);
    cmd.args(std::env::args_os().skip(1));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        eprintln!("issue-agent: failed to run {}: {err}", real.display());
        std::process::exit(127);
    }
    #[cfg(not(unix))]
    match cmd.status() {
        Ok(s) => std::process::exit(s.code().unwrap_or(1)),
        Err(err) => {
            eprintln!("issue-agent: failed to run {}: {err}", real.display());
            std::process::exit(127);
        }
    }
}
