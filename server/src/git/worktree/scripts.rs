//! Running a project's setup and teardown scripts.

use super::*;

/// How long a setup or teardown script may run (an install or a build, say): it holds the task's
/// setup lock and its project's folder in place meanwhile, so one that hangs is stopped.
pub const SCRIPT_LIMIT: Duration = Duration::from_secs(30 * 60);

/// Run a project script with bash. With a time limit, it's stopped (with everything it started)
/// if it runs over.
pub async fn run_script(script: &str, cwd: &Path, env: &[(&str, String)], limit: Option<Duration>) -> Result<String> {
    let mut cmd = Command::new("bash");
    cmd.arg("-c").arg(script).current_dir(cwd).stdin(Stdio::null());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = match limit {
        Some(limit) => run_limited(cmd, limit).await?,
        None => cmd.output().await.context("failed to run script")?,
    };
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        bail!("script exited with {}\n{}", out.status, truncate(&log, 8000));
    }
    Ok(log)
}

/// Kills a process group when dropped.
pub(crate) struct KillGroup(pub(crate) i32);

impl Drop for KillGroup {
    fn drop(&mut self) {
        unsafe { libc::kill(-self.0, libc::SIGKILL) };
    }
}

/// Run a script in a process group of its own, which is killed if the script runs over `limit`
/// or isn't waited for to the end (e.g. the server is shutting down), so nothing it started
/// keeps running.
pub(crate) async fn run_limited(mut cmd: Command, limit: Duration) -> Result<std::process::Output> {
    cmd.process_group(0).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().context("failed to run script")?;
    let pid = child.id().context("failed to run script")? as i32;
    // Dropped before `child`, while the shell isn't reaped, so its group id can't have been reused.
    let group = KillGroup(pid);
    let (mut stdout, mut stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let ran = tokio::time::timeout(limit, async {
        let (_, _, status) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err), child.wait());
        status
    })
    .await;
    match ran {
        Ok(status) => {
            // It finished: anything it left running was started to outlive it.
            std::mem::forget(group);
            Ok(std::process::Output { status: status.context("failed to run script")?, stdout: out, stderr: err })
        }
        Err(_) => {
            drop(group);
            let _ = child.wait().await;
            let log = format!("{}{}", String::from_utf8_lossy(&out), String::from_utf8_lossy(&err));
            bail!("script still running after {limit:?}; stopped it\n{}", truncate(&log, 8000))
        }
    }
}

pub fn script_env(project: &Project, task: &Task, wt: &Path, branch: &str) -> Vec<(&'static str, String)> {
    vec![
        ("IA_REPO_PATH", project.repo_path.clone()),
        ("IA_WORKTREE_PATH", path_str(wt)),
        ("IA_BRANCH", branch.to_string()),
        ("IA_TASK_ID", task.id.clone()),
        ("IA_TASK_NUMBER", task.number.to_string()),
        ("IA_PROJECT_KEY", project.key.clone()),
    ]
}
