//! The tokens of the board's own model calls that aren't runs, in `call_usage` (see
//! db::SCHEMA_V80): task titles (see agent/title.rs) and the prompts that restart 5-hour windows
//! (see agent/window.rs). Each call is counted as it ends, from what its reply says it used:
//! Claude Code's `result` (`modelUsage`, which a call with no session kept has from nothing), or
//! Codex's latest `thread/tokenUsage/updated` for its (ephemeral) thread.

use std::collections::BTreeMap;

use rusqlite::params;
use serde_json::Value;

use super::Counts;
use crate::state::Shared;
use crate::util::{new_id, now};

/// What a call used, by model.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Spent {
    pub runtime: &'static str,
    pub models: BTreeMap<String, Counts>,
}

impl Spent {
    /// From a Claude Code `result` (`--output-format json`'s output, or stream-json's last line).
    pub fn claude(result: &Value) -> Spent {
        let models = result["modelUsage"].as_object().into_iter().flatten().map(|(m, u)| (m.clone(), Counts::from_claude(u))).collect();
        Spent { runtime: "claude", models }
    }

    /// From the latest `tokenUsage` of a Codex thread started with `model`.
    pub fn codex(model: &str, usage: &Value) -> Spent {
        let mut models = BTreeMap::new();
        models.insert(model.to_string(), Counts::from_codex(&usage["total"]));
        Spent { runtime: "codex", models }
    }

    /// From the last `result` in Claude Code's stream-json output, if it has one.
    pub fn claude_stream(stdout: &str) -> Option<Spent> {
        stdout.lines().rev().filter(|l| l.contains("\"result\"")).filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|v| v["type"] == "result").map(|v| Spent::claude(&v))
    }
}

/// Keep what a call for `purpose` (`title` or `window`) used, for task `task_id` or with config
/// `config_id`. Logs rather than fails: the call's own work is done.
pub fn record(state: &Shared, purpose: &str, task_id: Option<&str>, config_id: Option<&str>, spent: &Spent) {
    let at = now();
    // The call's rows (one for each model) share it, so they're counted as one call.
    let call_id = new_id();
    let c = state.db();
    for (model, n) in spent.models.iter().filter(|(_, n)| n.total() > 0 || n.cost > 0.0) {
        let r = c.execute(
            "INSERT INTO call_usage (at, purpose, task_id, config_id, model, runtime, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
               reasoning_tokens, cost_usd, call_id)
             SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13 WHERE ?3 IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE id=?3)",
            params![
                at,
                purpose,
                task_id,
                config_id,
                model,
                spent.runtime,
                n.input,
                n.output,
                n.cache_read,
                n.cache_write,
                n.reasoning,
                (spent.runtime == "claude").then_some(n.cost),
                call_id
            ],
        );
        if let Err(e) = r {
            tracing::warn!(purpose, "keeping a model call's tokens: {e:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::db;

    #[test]
    fn reads_what_a_call_used() {
        // What `claude -p --output-format json` prints (cut down).
        let r = json!({"type": "result", "subtype": "success", "is_error": false, "result": "Fix login button", "total_cost_usd": 0.0001565,
            "modelUsage": {"claude-haiku-5-5": {"inputTokens": 2, "outputTokens": 67, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 614,
                "costUSD": 0.0001565, "thinkingTokens": 56, "contextWindow": 1000000}}});
        let c = Counts { input: 2, output: 67, cache_write: 614, reasoning: 56, cost: 0.0001565, ..Default::default() };
        assert_eq!(Spent::claude(&r), Spent { runtime: "claude", models: [("claude-haiku-5-5".to_string(), c)].into() });
        // stream-json's last result, after the rest.
        let stream = format!("{}\n{}\n{r}\n", json!({"type": "rate_limit_event"}), json!({"type": "assistant", "message": {"content": "result"}}));
        assert_eq!(Spent::claude_stream(&stream), Some(Spent::claude(&r)));
        assert_eq!(Spent::claude_stream("{\"type\":\"rate_limit_event\"}\n"), None);
        // Codex counts cached input in the input.
        let u = json!({"total": {"inputTokens": 900, "cachedInputTokens": 800, "outputTokens": 20, "reasoningOutputTokens": 12}, "last": {}});
        let c = Counts { input: 100, output: 20, cache_read: 800, reasoning: 12, ..Default::default() };
        assert_eq!(Spent::codex("gpt-6.1-mini", &u), Spent { runtime: "codex", models: [("gpt-6.1-mini".to_string(), c)].into() });
    }

    #[test]
    fn calls_are_in_the_token_report_of_their_tasks_or_their_configs_profile() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (cfg, other_cfg, unused) = {
                let c = s.db();
                let dir = crate::testing::temp_dir();
                let cfg = |n: &str| db::insert_claude_config(&c, n, &dir.join(n).to_string_lossy(), "claude").unwrap().id;
                (cfg("a"), cfg("b"), cfg("c"))
            };
            let (first, second, task) = {
                let c = s.db();
                let first = db::insert_profile(&c, "first", std::slice::from_ref(&other_cfg), None).unwrap();
                let second = db::insert_profile(&c, "second", &[cfg.clone(), other_cfg.clone()], None).unwrap();
                // Created later, though the first profile's row sorts after it by id.
                c.execute("UPDATE profiles SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?1", [&first.id]).unwrap();
                let new = db::NewTask { profile_id: &second.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
                let task = db::insert_task(&c, new).unwrap();
                (first, second, task)
            };
            let spent = |output| Spent { runtime: "claude", models: [("haiku".to_string(), Counts { output, cost: 0.01, ..Default::default() })].into() };
            record(&s, "title", Some(&task.id), Some(&cfg), &spent(1));
            record(&s, "window", None, Some(&cfg), &spent(2));
            // Used by both profiles: the first one's.
            record(&s, "window", None, Some(&other_cfg), &spent(4));
            // Used by none: the first profile's.
            record(&s, "window", None, Some(&unused), &spent(8));
            // Nothing used: no row.
            record(&s, "window", None, Some(&cfg), &Spent { runtime: "claude", models: [("haiku".to_string(), Counts::default())].into() });
            // A task deleted while its title was written: no row.
            record(&s, "title", Some("gone"), None, &spent(16));
            // A call on two models, and another just like it (in the same millisecond, maybe): a
            // row for each model, which share their call's id.
            let two = Spent { runtime: "claude", models: [("haiku".to_string(), Counts { output: 32, ..Default::default() }), ("opus".to_string(), Counts { output: 64, ..Default::default() })].into() };
            record(&s, "window", None, Some(&unused), &two);
            record(&s, "window", None, Some(&unused), &two);
            let calls = {
                let r = crate::analytics::token_report(&s.db(), &first.id, "2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z").unwrap();
                r.usage.iter().filter(|u| u.output_tokens >= 32).map(|u| u.call_id.clone().unwrap()).collect::<Vec<_>>()
            };
            assert_eq!(calls.len(), 4);
            assert_eq!(calls.iter().collect::<std::collections::HashSet<_>>().len(), 2, "{calls:?}");
            s.db().execute("DELETE FROM call_usage WHERE output_tokens >= 32", []).unwrap();
            let report = |p: &str| {
                let r = crate::analytics::token_report(&s.db(), p, "2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z").unwrap();
                r.usage.iter().map(|u| (u.kind.clone(), u.task_id.clone(), u.run_id.clone(), u.output_tokens)).collect::<Vec<_>>()
            };
            assert_eq!(report(&first.id), vec![("window".into(), None, None, 4), ("window".into(), None, None, 8)]);
            assert_eq!(report(&second.id), vec![("title".into(), Some(task.id.clone()), None, 1), ("window".into(), None, None, 2)]);
            // Deleting the task takes its titles' rows.
            s.db().execute("DELETE FROM tasks WHERE id=?1", [&task.id]).unwrap();
            assert_eq!(report(&second.id), vec![("window".into(), None, None, 2)]);
        })
    }
}
