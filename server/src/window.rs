//! Restarting 5-hour windows. A plan's session limit (Claude's `five_hour`, Codex's 300-minute
//! window) runs for five hours from the first message after the last window ended, so a window
//! that ends while nothing is running leaves the next one to start whenever work does, and then
//! run five hours from there. For each config with `restart_window` on whose plan has the window,
//! the board sends one short prompt just after it ends (`GRACE` late): Haiku with no tools for
//! Claude, a low-effort turn for Codex, with no session kept. That starts the next window.
//!
//! What it knows of the window is the config's usage (see usage.rs): fetched when the config is
//! first seen with the setting on, again before and after each prompt (another host or a run may
//! have started the window since, and the prompt's own rate limits can still show the window that
//! ended), and kept up to date by agent runs' `rate_limit_event`s, the prompt's own included. A
//! plan whose usage has never shown a session limit is sent nothing, nor is a config that's out of
//! usage. Once a plan has shown one it counts as having it, as its usage may leave the limit out
//! while no window runs; a prompt whose own rate limits show no 5-hour window at all, with usage
//! that doesn't show one either, stops the restarts until the setting is turned on again (or the
//! server restarts). A
//! prompt that fails, or that doesn't leave a window running, is tried again later, backing off
//! from `RETRY` up to `MAX_RETRY`.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, TimeDelta, Utc};
use serde_json::Value;
use tokio::process::Command;

use crate::db::{self, ClaudeConfig};
use crate::state::Shared;
use crate::usage;
use crate::util::expand_tilde;

/// How often the loop looks at the windows.
const TICK: Duration = Duration::from_secs(30);
/// How long after a window's reset the prompt is sent, for clocks that disagree.
const GRACE: TimeDelta = TimeDelta::minutes(1);
/// How long after a failed prompt the next is tried, doubling each time up to `MAX_RETRY`.
const RETRY: TimeDelta = TimeDelta::minutes(5);
const MAX_RETRY: TimeDelta = TimeDelta::hours(1);

const SYSTEM_PROMPT: &str = "Reply with only the word OK.";
const PROMPT: &str = "OK";

/// What the loop knows of one config, while its setting is on.
#[derive(Default)]
struct Watch {
    /// Its usage has been fetched since the setting was seen on.
    fetched: bool,
    /// Its plan has shown a session limit.
    has_window: bool,
    /// A prompt's own rate limits showed no 5-hour window.
    no_window: bool,
    failures: u32,
    retry_at: Option<DateTime<Utc>>,
}

#[derive(Debug, PartialEq)]
enum Window {
    /// The plan has no 5-hour window (or none has been seen yet).
    None,
    /// Running until then.
    Open(DateTime<Utc>),
    /// Ended (`GRACE` ago), and not started again.
    Ended,
}

/// Start the loop that restarts windows.
pub fn start(s: &Shared) {
    let s = s.clone();
    tokio::spawn(async move {
        let mut watches: HashMap<String, Watch> = HashMap::new();
        let mut tick = tokio::time::interval(TICK);
        loop {
            tick.tick().await;
            let configs = match db::list_claude_configs(&s.db()) {
                Ok(c) => c.into_iter().filter(|c| c.restart_window).collect::<Vec<_>>(),
                Err(e) => {
                    tracing::warn!("restarting 5-hour windows: {e:#}");
                    continue;
                }
            };
            // A setting turned off forgets what it knew, so turning it on again starts afresh.
            watches.retain(|id, _| configs.iter().any(|c| &c.id == id));
            for c in configs {
                check(&s, &c, watches.entry(c.id.clone()).or_default(), Utc::now()).await;
            }
        }
    });
}

fn window(s: &Shared, c: &ClaudeConfig, w: &mut Watch, now: DateTime<Utc>) -> Window {
    let session = usage::session_reset(s, &c.id);
    w.has_window |= session.is_some();
    if !w.has_window || w.no_window {
        return Window::None;
    }
    match session.flatten() {
        Some(t) if t + GRACE > now => Window::Open(t),
        _ => Window::Ended,
    }
}

/// Send the prompt if the config's window has ended.
async fn check(s: &Shared, c: &ClaudeConfig, w: &mut Watch, now: DateTime<Utc>) {
    if w.retry_at.is_some_and(|t| t > now) {
        return;
    }
    if !w.fetched {
        w.fetched = true;
        usage::refresh(s, c).await;
    }
    if window(s, c, w, now) != Window::Ended || usage::out_until(s, &c.id).is_some() {
        return;
    }
    // Someone may have started it since the numbers were last updated.
    usage::refresh(s, c).await;
    if window(s, c, w, now) != Window::Ended {
        return;
    }
    let result = ping(s, c).await;
    // The first request after a window ends can still report the old one, or leave the 5-hour
    // window out of its rate limits, so the usage, asked again, says whether the next started.
    let shown = usage::refresh(s, c).await.then(|| usage::session_reset(s, &c.id).is_some());
    let no_window = match result {
        Ok(Some(said)) => !said && shown != Some(true),
        // Codex's prompt doesn't say; its usage does.
        Ok(None) if c.is_codex() => shown == Some(false),
        _ => false,
    };
    if no_window {
        tracing::info!(config = c.name, "not restarting its 5-hour window: its plan doesn't have one");
        w.no_window = true;
        return;
    }
    match (result, window(s, c, w, now)) {
        (Ok(_), Window::Open(t)) => {
            tracing::info!(config = c.name, "started the next 5-hour window, until {t}");
            (w.failures, w.retry_at) = (0, None);
        }
        (r, _) => {
            let wait = (RETRY * 2i32.pow(w.failures.min(4))).min(MAX_RETRY);
            w.failures += 1;
            w.retry_at = Some(now + wait);
            let why = r.err().map(|e| format!("{e:#}")).unwrap_or_else(|| "no window is running after it".into());
            tracing::warn!(config = c.name, "restarting the 5-hour window failed ({why}); trying again in {} minutes", wait.num_minutes());
        }
    }
}

/// Send the prompt that starts a window: whether its rate limits showed a 5-hour window, if it
/// said. Claude's are taken in as an agent run's are.
async fn ping(s: &Shared, c: &ClaudeConfig) -> Result<Option<bool>> {
    #[cfg(test)]
    {
        let out = TEST_OUTPUT.with_borrow_mut(|o| o.pop_front()).context("no prompt in tests")?;
        TEST_PINGS.set(TEST_PINGS.get() + 1);
        return out.map(|o| read_output(s, &c.id, &o)).map_err(anyhow::Error::msg);
    }
    #[cfg_attr(test, allow(unreachable_code))]
    if c.is_codex() {
        // Away from any repository, as titles are.
        crate::codex::task_title(c.dir(), &s.data_dir, SYSTEM_PROMPT, PROMPT).await?;
        return Ok(None);
    }
    let program = std::env::var("IA_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
    let mut cmd = Command::new(program);
    cmd.args(["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config"])
        .args(["--no-session-persistence", "--disable-slash-commands", "--system-prompt", SYSTEM_PROMPT])
        .current_dir(&s.data_dir)
        .env("CLAUDE_CONFIG_DIR", expand_tilde(c.dir()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().context("failed to run claude")?;
    let mut stdin = child.stdin.take().context("no stdin")?;
    tokio::io::AsyncWriteExt::write_all(&mut stdin, PROMPT.as_bytes()).await?;
    drop(stdin);
    let out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await.context("timed out")??;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let reported = read_output(s, &c.id, &stdout);
    if !out.status.success() {
        bail!("claude exited with {}: {}", out.status, String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(reported)
}

/// Take in the `rate_limit_event`s in Claude's stream-json output: whether they showed a
/// 5-hour window, if they showed any rate limits. The first request after a window ends reports
/// it as its `rateLimitType` but leaves it out of `unifiedWindows`, so either counts.
fn read_output(s: &Shared, config_id: &str, stdout: &str) -> Option<bool> {
    let mut reported = None;
    for v in stdout.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|v| v["type"] == "rate_limit_event") {
        usage::on_rate_limit_event(s, config_id, &v);
        let info = &v["rate_limit_info"];
        if info["unifiedWindows"].is_object() || info["rateLimitType"].is_string() {
            reported = Some(reported == Some(true) || info["unifiedWindows"]["five_hour"].is_object() || info["rateLimitType"] == "five_hour");
        }
    }
    reported
}

#[cfg(test)]
thread_local! {
    /// Stands in for the prompt in tests: what each one prints (stream-json lines), or its error.
    static TEST_OUTPUT: std::cell::RefCell<std::collections::VecDeque<Result<String, String>>> = Default::default();
    static TEST_PINGS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::usage::Limit;

    fn at(t: DateTime<Utc>) -> String {
        t.to_rfc3339()
    }

    /// A config with the setting on and no login (so fetching its usage fails without the network).
    fn config(s: &Shared) -> ClaudeConfig {
        let dir = crate::testing::temp_dir().join("claude");
        let c = s.db();
        let cfg = db::insert_claude_config(&c, "work", &dir.to_string_lossy(), "claude").unwrap();
        db::update_claude_config(&c, &cfg.id, &[("restart_window", json!(true))]).unwrap().unwrap()
    }

    fn session(s: &Shared, id: &str, resets_at: Option<DateTime<Utc>>) {
        let l = Limit { id: "session".into(), label: "Session".into(), percent: 40.0, resets_at: resets_at.map(at) };
        usage::set_limits(s, id, vec![l], None);
    }

    fn event(windows: Value) -> String {
        json!({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "unifiedWindows": windows}}).to_string()
    }

    fn five_hour(resets: DateTime<Utc>) -> String {
        let r = resets.timestamp();
        event(json!({"five_hour": {"utilization": 0.01, "resetsAt": r}, "seven_day": {"utilization": 0.3, "resetsAt": r + 86400}}))
    }

    fn pings() -> u32 {
        TEST_PINGS.get()
    }

    #[test]
    fn a_window_that_ended_is_started_again_once() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = config(&s);
            let now = Utc::now();
            let mut w = Watch::default();
            session(&s, &c.id, Some(now + TimeDelta::hours(1)));
            check(&s, &c, &mut w, now).await;
            assert_eq!(pings(), 0, "still running");
            // Not until GRACE after the reset.
            check(&s, &c, &mut w, now + TimeDelta::hours(1) + TimeDelta::seconds(30)).await;
            assert_eq!(pings(), 0);
            let later = now + TimeDelta::hours(1) + TimeDelta::minutes(2);
            let next = later + TimeDelta::hours(5);
            TEST_OUTPUT.with_borrow_mut(|o| o.push_back(Ok(format!("{}\n{{\"type\":\"result\"}}\n", five_hour(next)))));
            check(&s, &c, &mut w, later).await;
            assert_eq!(pings(), 1);
            assert_eq!(usage::session_reset(&s, &c.id), Some(DateTime::from_timestamp(next.timestamp(), 0)));
            check(&s, &c, &mut w, later + TimeDelta::minutes(1)).await;
            assert_eq!(pings(), 1, "the next window is running");
        })
    }

    #[test]
    fn a_plan_without_the_window_is_sent_nothing() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = config(&s);
            let weekly = Limit { id: "weekly".into(), label: "Weekly".into(), percent: 30.0, resets_at: Some(at(Utc::now() + TimeDelta::days(3))) };
            usage::set_limits(&s, &c.id, vec![weekly], None);
            let mut w = Watch::default();
            check(&s, &c, &mut w, Utc::now()).await;
            // Nor is a config whose usage isn't known at all.
            let other = config(&s);
            check(&s, &other, &mut Watch::default(), Utc::now()).await;
            assert_eq!(pings(), 0);
        })
    }

    #[test]
    fn a_window_seen_once_counts_while_its_usage_leaves_it_out() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = config(&s);
            let now = Utc::now();
            let mut w = Watch::default();
            session(&s, &c.id, Some(now - TimeDelta::hours(1)));
            assert_eq!(window(&s, &c, &mut w, now), Window::Ended);
            s.usage.lock().unwrap().get_mut(&c.id).unwrap().limits.clear();
            assert_eq!(window(&s, &c, &mut w, now), Window::Ended);
            assert_eq!(window(&s, &c, &mut Watch::default(), now), Window::None);
            // Nor one with no reset time.
            session(&s, &c.id, None);
            assert_eq!(window(&s, &c, &mut Watch::default(), now), Window::Ended);
        })
    }

    #[test]
    fn a_failed_prompt_is_tried_again_later() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = config(&s);
            let now = Utc::now();
            let mut w = Watch::default();
            session(&s, &c.id, Some(now - TimeDelta::minutes(5)));
            TEST_OUTPUT.with_borrow_mut(|o| o.push_back(Err("claude exited with 1".into())));
            check(&s, &c, &mut w, now).await;
            assert_eq!((pings(), w.failures), (1, 1));
            check(&s, &c, &mut w, now + TimeDelta::minutes(4)).await;
            assert_eq!(pings(), 1, "backing off");
            // A prompt that leaves no window running counts as failed too, and the wait doubles.
            TEST_OUTPUT.with_borrow_mut(|o| o.push_back(Ok("{\"type\":\"result\"}".into())));
            check(&s, &c, &mut w, now + TimeDelta::minutes(5)).await;
            assert_eq!((pings(), w.failures, w.retry_at), (2, 2, Some(now + TimeDelta::minutes(15))));
            let next = now + TimeDelta::hours(5);
            TEST_OUTPUT.with_borrow_mut(|o| o.push_back(Ok(five_hour(next))));
            check(&s, &c, &mut w, now + TimeDelta::minutes(15)).await;
            assert_eq!((pings(), w.failures, w.retry_at), (3, 0, None));
        })
    }

    #[test]
    fn a_prompt_that_shows_no_window_stops_the_restarts() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = config(&s);
            let now = Utc::now();
            let mut w = Watch::default();
            session(&s, &c.id, Some(now - TimeDelta::minutes(5)));
            let weekly = event(json!({"seven_day": {"utilization": 0.3, "resetsAt": (now + TimeDelta::days(3)).timestamp()}}));
            TEST_OUTPUT.with_borrow_mut(|o| o.push_back(Ok(weekly)));
            check(&s, &c, &mut w, now).await;
            assert!(w.no_window);
            check(&s, &c, &mut w, now + TimeDelta::hours(2)).await;
            assert_eq!(pings(), 1);
        })
    }

    #[test]
    fn a_prompt_that_reports_the_window_that_just_ended_carries_on() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = config(&s);
            let now = Utc::now();
            let mut w = Watch::default();
            let ended = now - TimeDelta::minutes(1);
            session(&s, &c.id, Some(ended));
            // What Claude Code prints for the first request after a window ends.
            let stale = json!({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "resetsAt": ended.timestamp(), "rateLimitType": "five_hour",
                "unifiedWindows": {"seven_day": {"utilization": 0.3, "resetsAt": (now + TimeDelta::days(3)).timestamp()}, "seven_day_overage_included": {"utilization": 0.1}}}});
            TEST_OUTPUT.with_borrow_mut(|o| o.push_back(Ok(stale.to_string())));
            check(&s, &c, &mut w, now).await;
            assert!(!w.no_window);
            assert_eq!((pings(), w.failures), (1, 1), "tried again later");
            let next = now + TimeDelta::hours(5);
            TEST_OUTPUT.with_borrow_mut(|o| o.push_back(Ok(five_hour(next))));
            check(&s, &c, &mut w, now + TimeDelta::minutes(5)).await;
            assert_eq!((pings(), w.failures, w.no_window), (2, 0, false));
            assert_eq!(window(&s, &c, &mut w, now + TimeDelta::minutes(5)), Window::Open(DateTime::from_timestamp(next.timestamp(), 0).unwrap()));
        })
    }

    #[test]
    fn a_codex_plan_whose_only_window_is_weekly_is_sent_nothing() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = {
                let c = s.db();
                let cfg = db::insert_claude_config(&c, "codex", "", "codex").unwrap();
                db::update_claude_config(&c, &cfg.id, &[("restart_window", json!(true))]).unwrap().unwrap()
            };
            let past = (Utc::now() - TimeDelta::hours(1)).timestamp();
            let weekly = json!({"primary": {"usedPercent": 10, "windowDurationMins": 10080, "resetsAt": past}, "secondary": null});
            usage::TEST_CODEX.set(Some(weekly));
            let mut w = Watch::default();
            check(&s, &c, &mut w, Utc::now()).await;
            check(&s, &c, &mut w, Utc::now() + TimeDelta::hours(2)).await;
            assert_eq!(pings(), 0);
            assert_eq!(usage::session_reset(&s, &c.id), None);
            // One with a 5-hour window that ended is.
            let both = json!({"primary": {"usedPercent": 0, "windowDurationMins": 300, "resetsAt": past}, "secondary": {"usedPercent": 10, "windowDurationMins": 10080}});
            usage::TEST_CODEX.set(Some(both));
            TEST_OUTPUT.with_borrow_mut(|o| o.push_back(Ok(String::new())));
            check(&s, &c, &mut Watch::default(), Utc::now()).await;
            assert_eq!(pings(), 1);
        })
    }

    #[test]
    fn a_config_out_of_usage_waits_for_its_reset() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let c = config(&s);
            let now = Utc::now();
            session(&s, &c.id, Some(now - TimeDelta::minutes(5)));
            // Refused for its weekly limit, which resets later.
            let soon = (now + TimeDelta::days(1)).timestamp();
            usage::on_rate_limit_event(&s, &c.id, &json!({"rate_limit_info": {"status": "rejected", "resetsAt": soon}}));
            check(&s, &c, &mut Watch::default(), now).await;
            assert_eq!(pings(), 0);
        })
    }
}
