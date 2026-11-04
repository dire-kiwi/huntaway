//! Reading a pull request as a task's GitHub account (`Watcher`, `graphql`), and polling it for a
//! wait (`watch`) until there's news.

use super::*;

/// Reads one pull request for a task, as its GitHub account.
pub struct Watcher {
    pub target: Target,
    pub(super) account: Option<String>,
    /// gh's environment for the account, kept between reads (and made again after one fails).
    pub(super) env: Option<GhEnv>,
}

impl Watcher {
    pub fn new(s: &Shared, task: &Task, target: Target) -> anyhow::Result<Self> {
        Ok(Self { target, account: crate::agent::runner::task_github_account(s, task)?, env: None })
    }

    /// The pull request as GitHub has it now.
    pub(super) async fn read(&mut self) -> Result<Pr, String> {
        Pr::parse(&self.read_all().await?)
    }

    /// The query's response, with the review threads past its first page (`THREAD_PAGES` at most).
    async fn read_all(&mut self) -> Result<Value, String> {
        let mut v = self.query(QUERY, None).await?;
        for _ in 1..THREAD_PAGES {
            let threads = &v["data"]["repository"]["pullRequest"]["reviewThreads"];
            let Some(after) = threads["pageInfo"]["endCursor"].as_str().filter(|_| threads["pageInfo"]["hasNextPage"] == true).map(String::from) else {
                break;
            };
            let page = self.query(THREADS, Some(&after)).await?;
            let more = &page["data"]["repository"]["pullRequest"]["reviewThreads"];
            let Some(nodes) = more["nodes"].as_array().cloned() else {
                return Err(Pr::parse(&page).err().unwrap_or_else(|| "GitHub didn't return the pull request's review threads".into()));
            };
            let threads = &mut v["data"]["repository"]["pullRequest"]["reviewThreads"];
            if let Some(list) = threads["nodes"].as_array_mut() {
                list.extend(nodes);
            }
            threads["pageInfo"] = more["pageInfo"].clone();
        }
        Ok(v)
    }

    /// A GraphQL query's response: `query`, for the pull request's threads `after` a cursor if given.
    async fn query(&mut self, query: &str, after: Option<&str>) -> Result<Value, String> {
        #[cfg(test)]
        if let Some(r) = FAKE.with_borrow(|f| f.as_ref().map(|f| f(self.account.as_deref(), &self.target, after))) {
            return r;
        }
        let t = &self.target;
        let mut vars = vec![("owner", t.owner.clone()), ("name", t.name.clone())];
        vars.extend(after.map(|a| ("after", a.to_string())));
        graphql(self.account.as_deref(), &mut self.env, &t.host, query, &vars, &[("number", t.number)]).await
    }

    /// Read the pull request and see what's news to the agent of `task_id` since it was last told
    /// (`events` only, see `compare`). What isn't news (its own comments, a conflict that's
    /// gone) is stored as seen now; news, for the call `call_id` to report, is stored apart until
    /// it does (see `delivered`). Returns the news, if any.
    pub async fn poll(&mut self, s: &Shared, task_id: &str, call_id: &str, events: &[String]) -> Result<Option<Value>, String> {
        let pr = self.read().await?;
        if pr.state == "open" {
            record_checks(s, task_id, &self.target, &pr.head, &pr.checks);
        }
        let key = self.target.key();
        let c = s.db();
        let row = load(&c, task_id, &key).map_err(|e| format!("{e:#}"))?;
        let first = row.is_none();
        let mut row = row.unwrap_or_default();
        let (quiet, news) = compare((!first).then_some(&row.seen), &pr, events);
        row.pending = news.as_ref().map(|(_, told)| Pending { call_id: call_id.into(), told: told.clone(), superseded: false });
        (row.seen, row.last, row.polled_at) = (quiet, summary(&pr), crate::util::now());
        store(&c, task_id, &key, &row).map_err(|e| format!("{e:#}"))?;
        Ok(news.map(|(report, _)| report))
    }
}

/// Run the GraphQL `query` on `host` with string `vars` and number `numbers`, as `account` (gh's
/// active account when None, see Watcher). `env` keeps gh's environment for the account between
/// calls; it's made when missing, and dropped when a call fails so the next one makes it again.
pub async fn graphql(
    account: Option<&str>,
    env: &mut Option<GhEnv>,
    host: &str,
    query: &str,
    vars: &[(&str, String)],
    numbers: &[(&str, u64)],
) -> Result<Value, String> {
    let r = graphql_once(account, env, host, query, vars, numbers).await;
    if r.is_err() {
        *env = None;
    }
    r
}

async fn graphql_once(
    account: Option<&str>,
    env: &mut Option<GhEnv>,
    host: &str,
    query: &str,
    vars: &[(&str, String)],
    numbers: &[(&str, u64)],
) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["api".into(), "graphql".into(), "-f".into(), format!("query={query}")];
    for (k, v) in vars {
        args.extend(["-f".into(), format!("{k}={v}")]);
    }
    for (k, n) in numbers {
        args.extend(["-F".into(), format!("{k}={n}")]);
    }
    if host != "github.com" {
        args.extend(["--hostname".into(), host.to_string()]);
    }
    let out = gh(account, env, &args).await?;
    // gh prints GraphQL errors' response too, and exits with 1.
    match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(v) if v.is_object() => Ok(v),
        _ => Err(gh_error(&out)),
    }
}

/// Run gh with `args` as `account` (gh's active account when None), making its environment in
/// `env` if it's missing (see `graphql`).
pub(super) async fn gh(account: Option<&str>, env: &mut Option<GhEnv>, args: &[String]) -> Result<std::process::Output, String> {
    let mut cmd = tokio::process::Command::new(crate::mcp::gh_mcp::gh_program());
    if let Some(account) = account {
        if env.is_none() {
            *env = crate::mcp::gh_mcp::account_env(Some(account)).await.map_err(|e| format!("{e:#}"))?;
        }
        let env = env.as_ref().with_context(|| format!("{account} isn't a GitHub account")).map_err(|e| format!("{e:#}"))?;
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        env.check(&arg_refs, None).map_err(|e| format!("{e:#}"))?;
        env.apply(&mut cmd);
    } else {
        cmd.env_remove("GH_REPO");
    }
    cmd.args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    tokio::time::timeout(GH_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("gh timed out after {} seconds", GH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("couldn't run gh: {e}"))
}

pub(super) fn gh_error(out: &std::process::Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr);
    format!("gh failed: {}", err.trim().trim_start_matches("gh: "))
}

/// Poll `w` for the wait `call_id` of `task_id` (after `delay`, then every `POLL`) until there's
/// news, which it records in the wait, or it has failed `GIVE_UP` times in a row.
pub async fn watch(s: &Shared, task_id: &str, call_id: &str, events: &[String], mut w: Watcher, mut delay: Duration) {
    let mut failures = 0;
    loop {
        tokio::time::sleep(delay).await;
        match w.poll(s, task_id, call_id, events).await {
            Ok(Some(news)) => return record(s, task_id, call_id, news),
            Ok(None) => {
                failures = 0;
                delay = POLL;
            }
            Err(e) => {
                failures += 1;
                tracing::warn!(task = task_id, pr = %w.target.label(), failures, "reading a pull request: {e}");
                if failures >= GIVE_UP {
                    let news = json!({
                        "events": ["unreadable"],
                        "url": w.target.url(),
                        "number": w.target.number,
                        "error": format!("{} couldn't be read {GIVE_UP} times in a row: {e}", w.target.label()),
                    });
                    return record(s, task_id, call_id, news);
                }
                delay = backoff(failures);
            }
        }
    }
}

/// How long to wait before reading again after `failures` failed reads in a row.
pub fn backoff(failures: u32) -> Duration {
    POLL.saturating_mul(1 << failures.min(4)).min(POLL * 10)
}

/// Keep `news` in the wait `call_id` (if it's still waiting), which ends it.
fn record(s: &Shared, task_id: &str, call_id: &str, news: Value) {
    let changed = (|| -> anyhow::Result<Option<Task>> {
        // One lock for the read and write, as for a subagent's completion (see mcp/wait.rs).
        let c = s.db();
        let waiting = db::get_task(&c, task_id)?.and_then(|t| t.agent_wait);
        let Some(mut w) = waiting.filter(|w| w.call_id == call_id) else { return Ok(None) };
        let Some(pr) = w.pull_request.as_mut().filter(|p| p.news.is_none()) else { return Ok(None) };
        pr.news = Some(news);
        db::update_task(&c, task_id, &[("agent_wait", json!(w))])
    })();
    match changed {
        Ok(Some(t)) => s.emit_task(&t),
        Ok(None) => {}
        Err(e) => tracing::error!(task = task_id, "recording a pull request's news: {e:#}"),
    }
}

/// The news that the wait `call_id` on `w` found has reached the agent: it's been told.
pub fn delivered(s: &Shared, task_id: &str, call_id: &str, w: &WaitPr) {
    let Some(target) = Target::of(w) else { return };
    told(s, task_id, &target.key(), call_id, |_| {});
}

/// The news that `call_id` found about the pull request `key` has reached `task_id`'s agent, if
/// it's still the news kept for it: it's been told. `also` changes the row with it.
pub(super) fn told(s: &Shared, task_id: &str, key: &str, call_id: &str, also: impl FnOnce(&mut Row)) {
    let r = (|| -> anyhow::Result<()> {
        let c = s.db();
        let Some(mut row) = load(&c, task_id, key)? else { return Ok(()) };
        if let Some(p) = row.pending.take().filter(|p| p.call_id == call_id) {
            row.seen = p.told;
            also(&mut row);
            store(&c, task_id, key, &row)?;
        }
        Ok(())
    })();
    if let Err(e) = r {
        tracing::error!(task = task_id, "recording what the agent was told about a pull request: {e:#}");
    }
}

/// What the last read of `w` for `task_id` found, for a wait that ended otherwise.
pub fn last(s: &Shared, task_id: &str, w: &WaitPr) -> Option<Value> {
    let row = load(&s.db(), task_id, &Target::of(w)?.key()).ok().flatten()?;
    let mut last = row.last;
    last["read_at"] = json!(row.polled_at);
    Some(last)
}
