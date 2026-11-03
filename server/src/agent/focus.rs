//! The board's now/later split: a task is in "later" until it's put in "now" (by the user's prompt
//! to its agent, an update to it, or from the board or the API), and goes back after a day with no activity on it.
//! The day is the host's `now_expiry_hours` setting; 0 keeps tasks in "now" until they're moved.
//!
//! A task in "now" has `now_at` set (see `Task::now_at`). Anything that adds to its thread (the agent's
//! output, a prompt, an answer) moves `last_activity_at`, and a task whose agent is running is never
//! taken out, so what a task has to go without for a day is both.

use std::time::Duration;

use serde_json::{json, Value};

use crate::db::{self, Task};
use crate::state::{AppState, Shared};

/// The host setting for how many hours a task in "now" can go without activity before it goes back to "later".
pub const EXPIRY_SETTING: &str = "now_expiry_hours";

/// The hours when the setting isn't set.
pub const DEFAULT_EXPIRY_HOURS: u32 = 24;

/// The longest the setting can be: a year.
pub const MAX_EXPIRY_HOURS: u32 = 24 * 365;

/// How often tasks are looked at.
const SWEEP: Duration = Duration::from_secs(60);

/// The hours the setting gives, 0 for never.
pub fn expiry_hours(c: &rusqlite::Connection) -> u32 {
    db::get_setting(c, EXPIRY_SETTING).ok().flatten().and_then(|v| v.trim().parse().ok()).map_or(DEFAULT_EXPIRY_HOURS, |h: u32| h.min(MAX_EXPIRY_HOURS))
}

/// Puts the task in "now" from this moment (which is also what keeps one already there), unless it's a thread
/// that isn't a task. The task as it is then, if it changed.
pub fn put_in_now(s: &Shared, task_id: &str) -> Option<Task> {
    match s.update_task_if(task_id, &[("now_at", json!(crate::util::now()))], |c| Ok(db::get_task(c, task_id)?.is_some_and(|t| t.kind == "task"))) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(task = %task_id, "putting a task in now failed: {e:#}");
            None
        }
    }
}

/// Task `t` after a change made to it through `update_task` (the API's or the MCP tool's, `body` being what was asked for): a task
/// that's been updated at all, by the user or an agent, is in "now" (for another day). Unless the change itself said where it goes (`now`).
pub fn updated(s: &Shared, t: Task, body: &serde_json::Map<String, Value>) -> Task {
    if body.get("now").is_some_and(|v| !v.is_null()) { t } else { put_in_now(s, &t.id).unwrap_or(t) }
}

/// Sends the tasks in "now" with nothing happening on them since `cutoff` back to "later". How many.
fn expire_before(s: &AppState, cutoff: &str) -> usize {
    let ids = {
        let c = s.db();
        let mut st = match c.prepare("SELECT id FROM tasks WHERE now_at IS NOT NULL AND now_at <= ?1 AND last_activity_at <= ?1 AND running=0") {
            Ok(st) => st,
            Err(e) => {
                tracing::warn!("finding tasks to send back to later failed: {e:#}");
                return 0;
            }
        };
        match st.query_map([cutoff], |r| r.get::<_, String>(0)).and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>()) {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!("finding tasks to send back to later failed: {e:#}");
                return 0;
            }
        }
    };
    let mut n = 0;
    for id in ids {
        // Checked again as it's changed: a prompt since then keeps it.
        let moved = s.update_task_if(&id, &[("now_at", Value::Null)], |c| {
            Ok(db::get_task(c, &id)?.is_some_and(|t| !t.running && t.now_at.as_deref().is_some_and(|at| at <= cutoff) && t.last_activity_at.as_str() <= cutoff))
        });
        match moved {
            Ok(Some(_)) => n += 1,
            Ok(None) => {}
            Err(e) => tracing::warn!(task = %id, "sending a task back to later failed: {e:#}"),
        }
    }
    n
}

/// Sends the tasks that have gone without activity for the setting's hours back to "later". How many.
pub fn expire(s: &AppState) -> usize {
    let hours = expiry_hours(&s.db());
    if hours == 0 {
        return 0;
    }
    let cutoff = (chrono::Utc::now() - chrono::Duration::hours(hours.into())).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    expire_before(s, &cutoff)
}

/// Looks for tasks to send back to "later" when the server starts, then every `SWEEP`.
pub fn start(state: &Shared) {
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP);
        loop {
            tick.tick().await;
            let n = expire(&s);
            if n > 0 {
                tracing::info!("sent {n} idle tasks back to later");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;

    fn task(s: &Shared) -> Task {
        let c = s.db();
        let p = match db::list_profiles(&c).unwrap().into_iter().next() {
            Some(p) => p,
            None => db::insert_profile(&c, "p", &[], None).unwrap(),
        };
        let t = db::NewTask {
            profile_id: &p.id,
            project_id: None,
            kind: "task",
            title: "t",
            description: "",
            status: "in_progress",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: None,
        };
        db::insert_task(&c, t).unwrap()
    }

    fn ago(hours: i64) -> String {
        (chrono::Utc::now() - chrono::Duration::hours(hours)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// Puts the task in "now" and makes its last activity `now_hours_ago` and `activity_hours_ago` hours old.
    fn aged(s: &Shared, t: &Task, now_hours_ago: i64, activity_hours_ago: i64) {
        s.db().execute("UPDATE tasks SET now_at=?1, last_activity_at=?2 WHERE id=?3", rusqlite::params![ago(now_hours_ago), ago(activity_hours_ago), t.id]).unwrap();
    }

    fn now_at(s: &Shared, t: &Task) -> Option<String> {
        db::get_task(&s.db(), &t.id).unwrap().unwrap().now_at
    }

    #[test]
    fn tasks_are_in_later_until_put_in_now() {
        let s = testing::state();
        let t = task(&s);
        assert_eq!(t.now_at, None);
        let t = put_in_now(&s, &t.id).unwrap();
        assert!(t.now_at.is_some());
    }

    #[test]
    fn a_task_with_no_activity_for_a_day_goes_back_to_later() {
        let s = testing::state();
        let (idle, busy, fresh, later) = (task(&s), task(&s), task(&s), task(&s));
        aged(&s, &idle, 30, 30);
        // Put in now long ago, but something happened on its thread since.
        aged(&s, &busy, 30, 2);
        // Prompted a moment ago: put in now again, though its thread is old.
        aged(&s, &fresh, 1, 30);
        assert_eq!(expire(&s), 1);
        assert_eq!(now_at(&s, &idle), None);
        assert!(now_at(&s, &busy).is_some());
        assert!(now_at(&s, &fresh).is_some());
        assert_eq!(now_at(&s, &later), None);
    }

    #[test]
    fn a_task_whose_agent_is_running_stays_in_now() {
        let s = testing::state();
        let t = task(&s);
        aged(&s, &t, 30, 30);
        s.db().execute("UPDATE tasks SET running=1 WHERE id=?1", [&t.id]).unwrap();
        assert_eq!(expire(&s), 0);
        assert!(now_at(&s, &t).is_some());
    }

    #[test]
    fn the_setting_changes_how_long_a_task_stays_in_now() {
        let s = testing::state();
        let t = task(&s);
        aged(&s, &t, 30, 30);
        db::set_setting(&s.db(), EXPIRY_SETTING, Some("48")).unwrap();
        assert_eq!(expire(&s), 0);
        db::set_setting(&s.db(), EXPIRY_SETTING, Some("12")).unwrap();
        assert_eq!(expire(&s), 1);
        assert_eq!(now_at(&s, &t), None);
    }

    #[test]
    fn zero_hours_keeps_tasks_in_now() {
        let s = testing::state();
        let t = task(&s);
        aged(&s, &t, 24 * 100, 24 * 100);
        db::set_setting(&s.db(), EXPIRY_SETTING, Some("0")).unwrap();
        assert_eq!(expire(&s), 0);
        assert!(now_at(&s, &t).is_some());
    }

    #[test]
    fn a_setting_that_is_not_a_number_is_the_default() {
        let s = testing::state();
        assert_eq!(expiry_hours(&s.db()), DEFAULT_EXPIRY_HOURS);
        db::set_setting(&s.db(), EXPIRY_SETTING, Some("soon")).unwrap();
        assert_eq!(expiry_hours(&s.db()), DEFAULT_EXPIRY_HOURS);
        db::set_setting(&s.db(), EXPIRY_SETTING, Some("6")).unwrap();
        assert_eq!(expiry_hours(&s.db()), 6);
    }
}
