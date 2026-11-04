//! Workflows: a project's automations that act on its tasks, as graphs of nodes (HA-173, API 107).
//!
//! A workflow's **trigger** node starts a run on a task: when the task enters a column (such as *In review*, which is
//! where its agent's finished work goes), or only when it's run by hand (`POST /workflows/{id}/run`, `run_workflow`).
//! From there the run follows the graph's edges, out of the **port** each node ends on:
//!
//! - a **condition** checks the task (`yes` or `no`): has its work changed since the workflow last ran on it, has
//!   its branch commits of its own, has it a pull request, or a type or label;
//! - an **agent** step runs an agent in a thread of its own, read-only in the task's worktree, as a reviewer does
//!   (a `review` thread of type `workflow` whose parent is the task, kept from one run to the next). Its output is
//!   its last message (`done`), or a verdict it reports with `submit_review` (`pass` or `issues`), or it `failed`.
//!   With a `tab`, its output shows in a tab of that name in the task's panel;
//! - **send to the task's agent** sends a message (by default the issues the run's agents found) to the task's
//!   agent: at most `max_rounds` runs in a row (`sent`), then `exhausted`, which with nothing after it leaves the
//!   task in *Needs attention*. Sending ends the run, as the agent's work changes under it;
//! - **move the task** to another column (`out`).
//!
//! A node runs once every node with an edge into it has finished, when one of those edges was taken (`join: any`,
//! the default) or all of them (`join: all`); otherwise it's skipped, and so are the nodes only it leads to. Nodes
//! with several outputs side by side run at once, so two agent steps after the trigger review together.
//!
//! A run keeps the graph as it was when it started, so changing a workflow doesn't change runs in progress. A run in
//! progress is stopped when the task's agent starts working again (its work is changing) or the task is stopped.

use std::collections::{BTreeMap, HashMap};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::db;
use crate::state::{ApiError, ApiResult, Shared};
use crate::util::{new_id, now};

mod engine;
mod handlers;
mod prompt;

pub use engine::*;
pub use handlers::*;

/// The task type of a workflow's agent thread.
pub const WORKFLOW: &str = "workflow";
/// Most nodes a workflow can have, and agent steps among them.
pub const MAX_NODES: usize = 40;
pub const MAX_AGENTS: usize = 8;
/// Most rounds a send can be given.
pub const MAX_ROUNDS: u32 = 20;
const MAX_TEXT: usize = 20_000;

// ---------- what a workflow is ----------

/// A workflow's nodes and the edges between them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Graph {
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
}

/// An edge from `from`'s `port` to `to`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Edge {
    pub from: String,
    #[serde(default = "out")]
    pub port: String,
    pub to: String,
}

fn out() -> String {
    "out".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Node {
    pub id: String,
    #[serde(flatten)]
    pub kind: NodeKind,
    /// With several edges into it: run when `any` of them is taken, or only when `all` are.
    #[serde(default, skip_serializing_if = "Join::is_any")]
    pub join: Join,
    /// Where the editor draws it.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Join {
    #[default]
    Any,
    All,
}

impl Join {
    fn is_any(&self) -> bool {
        *self == Join::Any
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NodeKind {
    /// What starts a run: the task entering `status` (`on: status`), or only a run by hand (`on: manual`).
    Trigger {
        on: TriggerOn,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
    },
    /// A check on the task: `yes` or `no`. `value` is the type or label for `task_type` and `label`.
    Condition {
        check: Check,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    /// An agent in a thread of its own, read-only in the task's worktree.
    Agent {
        /// What it's called on the board, e.g. "Reviewer".
        name: String,
        /// What it's asked to do (the board adds where the work is and how to report).
        #[serde(default)]
        prompt: String,
        #[serde(default)]
        output: Output,
        /// None uses the task's config.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        claude_config_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
        /// Skills it's asked to use (the board's among them are on in its thread).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        skills: Vec<String>,
        /// The task panel tab its output shows in, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
    },
    /// A message to the task's agent; empty sends the issues the run's agent steps found.
    SendToTask {
        #[serde(default)]
        message: String,
        #[serde(default = "two")]
        max_rounds: u32,
    },
    /// Moves the task to another column.
    SetStatus { status: String },
}

fn two() -> u32 {
    2
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TriggerOn {
    Status,
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Check {
    /// The workflow hasn't finished a run on the task, or its commit or its agent's work changed since.
    Changed,
    /// Its branch has commits of its own.
    HasCommits,
    /// It has a pull request.
    HasPr,
    /// It's of type `value` (`code` for a code task).
    TaskType,
    /// It has label `value`.
    Label,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Output {
    /// Its last message.
    #[default]
    Text,
    /// `pass` or `issues`, reported with `submit_review`.
    Verdict,
}

impl NodeKind {
    /// The ports a node of this kind can end on.
    pub fn ports(&self) -> &'static [&'static str] {
        match self {
            NodeKind::Trigger { .. } | NodeKind::SetStatus { .. } => &["out"],
            NodeKind::Condition { .. } => &["yes", "no"],
            NodeKind::Agent { output: Output::Text, .. } => &["done", "failed"],
            NodeKind::Agent { output: Output::Verdict, .. } => &["pass", "issues", "failed"],
            NodeKind::SendToTask { .. } => &["sent", "exhausted"],
        }
    }
}

impl Graph {
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn trigger(&self) -> Option<&Node> {
        self.nodes.iter().find(|n| matches!(n.kind, NodeKind::Trigger { .. }))
    }

    /// The column whose tasks entering it start a run, if its trigger is one.
    pub fn trigger_status(&self) -> Option<&str> {
        match self.trigger().map(|n| &n.kind) {
            Some(NodeKind::Trigger { on: TriggerOn::Status, status }) => status.as_deref(),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Workflow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub enabled: bool,
    pub graph: Graph,
    pub created_at: String,
    pub updated_at: String,
}

impl Workflow {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            project_id: r.get("project_id")?,
            name: r.get("name")?,
            enabled: r.get("enabled")?,
            graph: from_json(r, "graph")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
        })
    }
}

/// One node's part of a run.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct NodeRun {
    /// pending, running, done, skipped, failed or stopped
    pub state: String,
    /// The port it ended on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
    /// An agent step's thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Who works an agent step, e.g. "Claude · haiku".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// An agent step's output (its last message, or its verdict's summary), or why a node failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// A verdict step's verdict (pass or issues), set by `submit_review` while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub issues: Vec<String>,
    /// The thread's last run before this step's (empty if it had none), so an earlier run's late end doesn't end it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_run: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

impl NodeRun {
    pub fn settled(&self) -> bool {
        !matches!(self.state.as_str(), "pending" | "running")
    }
}

/// A workflow's run on a task.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Run {
    pub id: String,
    pub workflow_id: String,
    pub task_id: String,
    /// `status` (its trigger) or `manual`.
    pub source: String,
    /// running, done or stopped
    pub state: String,
    /// The task's commit when it started.
    pub head: Option<String>,
    /// The task's latest run when it started, which tells whether its agent worked since.
    #[serde(skip)]
    pub task_run: Option<String>,
    /// The workflow's graph as it was when it started.
    pub graph: Graph,
    pub nodes: BTreeMap<String, NodeRun>,
    /// Sends in a row per send node, carried from one run to the next.
    pub rounds: BTreeMap<String, u32>,
    pub detail: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

impl Run {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            workflow_id: r.get("workflow_id")?,
            task_id: r.get("task_id")?,
            source: r.get("source")?,
            state: r.get("state")?,
            head: r.get("head")?,
            task_run: r.get("task_run")?,
            graph: from_json(r, "graph")?,
            nodes: from_json(r, "nodes")?,
            rounds: from_json(r, "rounds")?,
            detail: r.get("detail")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
            finished_at: r.get("finished_at")?,
        })
    }

    pub fn node(&self, id: &str) -> NodeRun {
        self.nodes.get(id).cloned().unwrap_or_else(|| NodeRun { state: "pending".into(), ..Default::default() })
    }
}

fn from_json<T: serde::de::DeserializeOwned>(r: &Row, col: &str) -> rusqlite::Result<T> {
    let s: String = r.get(col)?;
    serde_json::from_str(&s).map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

// ---------- the database ----------

pub fn get(c: &Connection, id: &str) -> rusqlite::Result<Option<Workflow>> {
    c.query_row("SELECT * FROM workflows WHERE id=?1", [id], Workflow::from_row).optional()
}

pub fn list(c: &Connection, project_id: &str) -> rusqlite::Result<Vec<Workflow>> {
    let mut st = c.prepare("SELECT * FROM workflows WHERE project_id=?1 ORDER BY created_at, id")?;
    st.query_map([project_id], Workflow::from_row)?.collect()
}

pub fn get_run(c: &Connection, id: &str) -> rusqlite::Result<Option<Run>> {
    c.query_row("SELECT * FROM workflow_runs WHERE id=?1", [id], Run::from_row).optional()
}

/// The latest run of each workflow on the task, newest first.
pub fn latest_runs(c: &Connection, task_id: &str) -> rusqlite::Result<Vec<Run>> {
    let mut st = c.prepare(
        "SELECT * FROM workflow_runs r WHERE task_id=?1 AND rowid = (SELECT MAX(rowid) FROM workflow_runs WHERE task_id=?1 AND workflow_id=r.workflow_id)
         ORDER BY created_at DESC, rowid DESC",
    )?;
    st.query_map([task_id], Run::from_row)?.collect()
}

/// The workflow's latest run on the task.
pub fn latest_run(c: &Connection, workflow_id: &str, task_id: &str) -> rusqlite::Result<Option<Run>> {
    c.query_row("SELECT * FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 ORDER BY rowid DESC LIMIT 1", [workflow_id, task_id], Run::from_row).optional()
}

/// Runs in progress, on one task or every one.
pub fn running(c: &Connection, task_id: Option<&str>) -> rusqlite::Result<Vec<Run>> {
    let mut st = c.prepare("SELECT * FROM workflow_runs WHERE state='running' AND (?1 IS NULL OR task_id=?1) ORDER BY rowid")?;
    st.query_map([task_id], Run::from_row)?.collect()
}

fn insert_run(c: &Connection, r: &Run) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO workflow_runs (id,workflow_id,task_id,source,state,head,task_run,graph,nodes,rounds,detail,created_at,updated_at,finished_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            r.id,
            r.workflow_id,
            r.task_id,
            r.source,
            r.state,
            r.head,
            r.task_run,
            json!(r.graph).to_string(),
            json!(r.nodes).to_string(),
            json!(r.rounds).to_string(),
            r.detail,
            r.created_at,
            r.updated_at,
            r.finished_at
        ],
    )?;
    // Each workflow keeps its latest runs on each task.
    c.execute(
        "DELETE FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 AND state!='running' AND rowid NOT IN
           (SELECT rowid FROM workflow_runs WHERE workflow_id=?1 AND task_id=?2 ORDER BY rowid DESC LIMIT 20)",
        [&r.workflow_id, &r.task_id],
    )?;
    Ok(())
}

fn save_run(c: &Connection, r: &Run) -> rusqlite::Result<()> {
    c.execute(
        "UPDATE workflow_runs SET state=?2, nodes=?3, rounds=?4, detail=?5, updated_at=?6, finished_at=?7 WHERE id=?1",
        params![r.id, r.state, json!(r.nodes).to_string(), json!(r.rounds).to_string(), r.detail, r.updated_at, r.finished_at],
    )?;
    Ok(())
}

// ---------- checking what's given ----------

fn bad(m: impl Into<String>) -> ApiError {
    ApiError::bad(m)
}

pub fn check_name(v: &Value) -> ApiResult<String> {
    match v.as_str().map(str::trim) {
        Some(n) if !n.is_empty() && n.chars().count() <= 100 => Ok(n.to_string()),
        _ => Err(bad("name must be 1 to 100 characters")),
    }
}

fn trimmed(v: &Option<String>) -> Option<String> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// The graph as given, checked against project `p`, and tidied (blank settings dropped).
pub fn check_graph(c: &Connection, p: &db::Project, v: &Value) -> ApiResult<Graph> {
    let mut g: Graph = serde_json::from_value(v.clone()).map_err(|e| bad(format!("graph: {e}")))?;
    if g.nodes.len() > MAX_NODES {
        return Err(bad(format!("a workflow has at most {MAX_NODES} nodes")));
    }
    let mut ids = std::collections::HashSet::new();
    let (mut triggers, mut agents) = (0, 0);
    for n in g.nodes.iter_mut() {
        n.id = n.id.trim().to_string();
        if n.id.is_empty() || n.id.len() > 40 || !n.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(bad(format!("node id {:?} must be 1 to 40 letters, digits, - or _", n.id)));
        }
        if !ids.insert(n.id.clone()) {
            return Err(bad(format!("two nodes have the id {}", n.id)));
        }
        if !n.x.is_finite() || !n.y.is_finite() {
            n.x = 0.0;
            n.y = 0.0;
        }
        let id = n.id.clone();
        match &mut n.kind {
            NodeKind::Trigger { on, status } => {
                triggers += 1;
                *status = trimmed(status);
                match (on, status.as_deref()) {
                    (TriggerOn::Status, Some(s)) if db::STATUSES.contains(&s) => {}
                    (TriggerOn::Status, _) => return Err(bad(format!("trigger {id} needs the column (status) whose tasks entering it start a run"))),
                    (TriggerOn::Manual, _) => *status = None,
                }
            }
            NodeKind::Condition { check, value } => {
                *value = trimmed(value);
                match check {
                    Check::TaskType => {
                        let ok = value.as_deref().is_some_and(|t| t == "code" || db::TASK_TYPES.contains(&t));
                        if !ok {
                            return Err(bad(format!("condition {id} needs a task type: code or {}", db::TASK_TYPES.join(", "))));
                        }
                    }
                    Check::Label => {
                        if !value.as_deref().is_some_and(|l| db::LABELS.contains(&l)) {
                            return Err(bad(format!("condition {id} needs a label: {}", db::LABELS.join(", "))));
                        }
                    }
                    _ => *value = None,
                }
            }
            NodeKind::Agent { name, prompt, claude_config_id, model, effort, skills, tab, .. } => {
                agents += 1;
                *name = name.trim().to_string();
                if name.is_empty() || name.chars().count() > 60 {
                    return Err(bad(format!("agent step {id} needs a name of 1 to 60 characters")));
                }
                if prompt.len() > MAX_TEXT {
                    return Err(bad(format!("agent step {id}'s prompt is longer than {MAX_TEXT} bytes")));
                }
                *claude_config_id = trimmed(claude_config_id);
                if let Some(cid) = claude_config_id.as_deref() {
                    if !db::available_configs(c, &p.profile_id, Some(p))?.iter().any(|cfg| cfg.id == cid) {
                        return Err(bad(format!("agent step {id}'s claude_config_id {cid} isn't one of the project's (or profile's) agent configs")));
                    }
                }
                *model = trimmed(model);
                *effort = trimmed(effort);
                skills.retain(|s| !s.trim().is_empty());
                for s in skills.iter_mut() {
                    *s = s.trim().trim_start_matches(['/', '$']).to_string();
                }
                if skills.len() > 10 {
                    return Err(bad(format!("agent step {id} has more than 10 skills")));
                }
                *tab = trimmed(tab);
                if tab.as_deref().is_some_and(|t| t.chars().count() > 30) {
                    return Err(bad(format!("agent step {id}'s tab name is longer than 30 characters")));
                }
            }
            NodeKind::SendToTask { message, max_rounds } => {
                if message.len() > MAX_TEXT {
                    return Err(bad(format!("send step {id}'s message is longer than {MAX_TEXT} bytes")));
                }
                if *max_rounds > MAX_ROUNDS {
                    return Err(bad(format!("send step {id} can have at most {MAX_ROUNDS} rounds")));
                }
            }
            NodeKind::SetStatus { status } => {
                *status = status.trim().to_string();
                if !db::STATUSES.contains(&status.as_str()) || status == "done" {
                    return Err(bad(format!("move step {id} needs a column: one of {}", db::STATUSES.iter().filter(|s| **s != "done").copied().collect::<Vec<_>>().join(", "))));
                }
            }
        }
    }
    if triggers != 1 {
        return Err(bad("a workflow needs exactly one trigger node"));
    }
    if agents > MAX_AGENTS {
        return Err(bad(format!("a workflow has at most {MAX_AGENTS} agent steps")));
    }
    let mut seen = std::collections::HashSet::new();
    for e in &g.edges {
        let from = g.node(&e.from).ok_or_else(|| bad(format!("an edge comes from node {}, which isn't in the graph", e.from)))?;
        let to = g.node(&e.to).ok_or_else(|| bad(format!("an edge goes to node {}, which isn't in the graph", e.to)))?;
        if !from.kind.ports().contains(&e.port.as_str()) {
            return Err(bad(format!("node {} has no port {} (it has {})", e.from, e.port, from.kind.ports().join(", "))));
        }
        if matches!(to.kind, NodeKind::Trigger { .. }) {
            return Err(bad("no edge can go into the trigger"));
        }
        if !seen.insert((e.from.clone(), e.port.clone(), e.to.clone())) {
            return Err(bad(format!("the edge from {}.{} to {} is there twice", e.from, e.port, e.to)));
        }
    }
    if let Some(cycle) = cycle(&g) {
        return Err(bad(format!("the graph goes round in a loop through {cycle}: a workflow runs from its trigger forward (send to the task's agent to go round again)")));
    }
    Ok(g)
}

/// A node on a cycle, if the graph has one.
fn cycle(g: &Graph) -> Option<String> {
    let mut indegree: HashMap<&str, usize> = g.nodes.iter().map(|n| (n.id.as_str(), 0)).collect();
    for e in &g.edges {
        *indegree.entry(e.to.as_str()).or_default() += 1;
    }
    let mut ready: Vec<&str> = indegree.iter().filter(|(_, d)| **d == 0).map(|(n, _)| *n).collect();
    let mut done = 0;
    while let Some(n) = ready.pop() {
        done += 1;
        for e in g.edges.iter().filter(|e| e.from == n) {
            let d = indegree.get_mut(e.to.as_str()).unwrap();
            *d -= 1;
            if *d == 0 {
                ready.push(e.to.as_str());
            }
        }
    }
    (done < g.nodes.len()).then(|| indegree.iter().filter(|(_, d)| **d > 0).map(|(n, _)| n.to_string()).min().unwrap_or_default())
}

// ---------- changing workflows ----------

fn changed(s: &Shared, project_id: &str, id: &str) {
    s.emit(json!({"type": "workflows_changed", "project_id": project_id, "workflow_id": id}));
}

/// A new workflow in project `project_id`: `{name, graph, enabled?}`.
pub fn create(s: &Shared, project_id: &str, b: &Map<String, Value>) -> ApiResult<Workflow> {
    let p = db::get_project(&s.db(), project_id)?.ok_or_else(|| ApiError::not_found("project"))?;
    let name = check_name(b.get("name").unwrap_or(&Value::Null))?;
    let graph = check_graph(&s.db(), &p, b.get("graph").unwrap_or(&Value::Null))?;
    let enabled = match b.get("enabled") {
        None | Some(Value::Null) => true,
        Some(v) => v.as_bool().ok_or_else(|| bad("enabled must be true or false"))?,
    };
    let (id, at) = (new_id(), now());
    s.db().execute(
        "INSERT INTO workflows (id,project_id,name,enabled,graph,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
        params![id, p.id, name, enabled, json!(graph).to_string(), at],
    )?;
    changed(s, &p.id, &id);
    Ok(get(&s.db(), &id)?.expect("just made"))
}

/// Changes a workflow: any of `name`, `graph` and `enabled`.
pub fn update(s: &Shared, id: &str, b: &Map<String, Value>) -> ApiResult<Workflow> {
    let w = get(&s.db(), id)?.ok_or_else(|| ApiError::not_found("workflow"))?;
    let p = db::get_project(&s.db(), &w.project_id)?.ok_or_else(|| ApiError::not_found("project"))?;
    let name = match b.get("name") {
        None | Some(Value::Null) => w.name.clone(),
        Some(v) => check_name(v)?,
    };
    let graph = match b.get("graph") {
        None | Some(Value::Null) => w.graph.clone(),
        Some(v) => check_graph(&s.db(), &p, v)?,
    };
    let enabled = match b.get("enabled") {
        None | Some(Value::Null) => w.enabled,
        Some(v) => v.as_bool().ok_or_else(|| bad("enabled must be true or false"))?,
    };
    s.db().execute(
        "UPDATE workflows SET name=?2, graph=?3, enabled=?4, updated_at=?5 WHERE id=?1",
        params![id, name, json!(graph).to_string(), enabled, now()],
    )?;
    changed(s, &w.project_id, id);
    Ok(get(&s.db(), id)?.ok_or_else(|| ApiError::not_found("workflow"))?)
}

/// Deletes a workflow, stopping its runs in progress. Its threads stay with their tasks.
pub fn delete(s: &Shared, id: &str) -> ApiResult<Workflow> {
    let w = get(&s.db(), id)?.ok_or_else(|| ApiError::not_found("workflow"))?;
    let runs: Vec<Run> = running(&s.db(), None)?.into_iter().filter(|r| r.workflow_id == id).collect();
    for r in runs {
        engine::stop_run(s, &r.id, "Stopped because the workflow was deleted.");
    }
    let tasks: Vec<String> = {
        let c = s.db();
        let mut st = c.prepare("SELECT DISTINCT task_id FROM workflow_runs WHERE workflow_id=?1")?;
        st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    s.db().execute("DELETE FROM workflows WHERE id=?1", [id])?;
    crate::mcp::permissions::expire_for_workflow(s, id);
    changed(s, &w.project_id, id);
    for t in tasks {
        engine::runs_changed(s, &t);
    }
    Ok(w)
}

#[cfg(test)]
mod tests;
