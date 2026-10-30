//! Questions agents ask with the board's `request_user_input` (see tools.rs): the question, and
//! the options to pick from if the agent gave them, as a card in the thread (a `question`
//! message, API 64). The agent ends its turn after asking, so a question isn't waited on like a
//! permission prompt: it stays answerable after the run ends, and answering it sends the user's
//! message that resumes the agent. A reply typed in the thread instead settles it too.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::db::{self, Task};
use crate::state::{ApiError, ApiResult, Shared};

/// The most options a question can have: keys 1–9 pick them.
pub const MAX_OPTIONS: usize = 9;

/// The card for `request_user_input`'s arguments, or why they're wrong: its question, options
/// (each a label and maybe a description), whether more than one can be picked, and whether a
/// free-text answer is offered besides them (by default it is).
pub fn card(args: &Value) -> Result<Value, String> {
    let question = args["question"].as_str().map(str::trim).filter(|q| !q.is_empty()).ok_or("request_user_input needs a question")?;
    let mut options = Vec::new();
    match &args["options"] {
        Value::Null => {}
        Value::Array(list) => {
            for o in list {
                // A plain string is taken as a label.
                let (label, description) = match o {
                    Value::String(l) => (Some(l.as_str()), None),
                    o => (o["label"].as_str(), o["description"].as_str()),
                };
                let label = label.map(str::trim).filter(|l| !l.is_empty()).ok_or("each of request_user_input's options needs a label")?;
                if options.iter().any(|o: &Value| o["label"] == label) {
                    return Err(format!("request_user_input's options must have different labels (\"{label}\" is there twice)"));
                }
                let mut option = json!({"label": label});
                if let Some(d) = description.map(str::trim).filter(|d| !d.is_empty()) {
                    option["description"] = json!(d);
                }
                options.push(option);
            }
        }
        _ => return Err("request_user_input's options must be a list of {label, description}".into()),
    }
    if options.len() > MAX_OPTIONS {
        return Err(format!("request_user_input takes at most {MAX_OPTIONS} options"));
    }
    let flag = |name: &str, default: bool| match &args[name] {
        Value::Null => Ok(default),
        Value::Bool(b) => Ok(*b),
        _ => Err(format!("request_user_input's {name} must be true or false")),
    };
    Ok(json!({
        "question": question,
        "options": options,
        "multi_select": flag("multi_select", false)?,
        "allow_other": flag("allow_other", true)?,
    }))
}

/// Put `card` (see `card`) in `task`'s thread for MCP call `call_id`, once for the call (it's run
/// again if it's cut short by a restart).
pub fn ask(s: &Shared, task: &Task, call_id: &str, mut card: Value) -> anyhow::Result<()> {
    let asked: Option<i64> = s
        .db()
        .query_row(
            "SELECT id FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data, '$.call_id')=?2",
            [&task.id, call_id],
            |r| r.get(0),
        )
        .ok();
    if asked.is_none() {
        card["call_id"] = json!(call_id);
        card["status"] = json!("pending");
        s.add_message(&task.id, "question", card)?;
    }
    Ok(())
}

/// The user's answer to a question from its card.
#[derive(Deserialize, Default)]
pub struct Answer {
    /// The options picked, by label.
    #[serde(default)]
    pub choices: Vec<String>,
    /// What the user typed, if the question takes a free-text answer.
    #[serde(default)]
    pub text: Option<String>,
}

/// Answer the question in message `message_id` of `task_id`'s thread: the answer is sent to the
/// agent as the user's message, which carries the conversation on. Only the first answer counts:
/// another (from another tab, say) is refused. Returns the task, as sending a message does.
pub fn answer(s: &Shared, task_id: &str, message_id: i64, answer: Answer) -> ApiResult<Task> {
    let data: String = s
        .db()
        .query_row("SELECT data FROM messages WHERE id=?1 AND task_id=?2 AND kind='question'", rusqlite::params![message_id, task_id], |r| r.get(0))
        .map_err(|_| ApiError::not_found("question"))?;
    let asked: Value = serde_json::from_str(&data).map_err(anyhow::Error::from)?;
    if asked["status"] != "pending" {
        return Err(ApiError::conflict("this question has been answered already"));
    }
    if crate::permissions::moved_on(s, task_id, message_id)? {
        return Err(ApiError::conflict("the conversation has moved on since this was asked: reply in the thread instead"));
    }
    let options: Vec<&str> = asked["options"].as_array().into_iter().flatten().filter_map(|o| o["label"].as_str()).collect();
    let mut choices: Vec<String> = Vec::new();
    for c in &answer.choices {
        let c = c.trim();
        if !options.contains(&c) {
            return Err(ApiError::bad(format!("\"{c}\" isn't one of the question's options")));
        }
        if !choices.iter().any(|x| x == c) {
            choices.push(c.to_string());
        }
    }
    let text = answer.text.as_deref().map(str::trim).filter(|t| !t.is_empty());
    if text.is_some() && !options.is_empty() && asked["allow_other"] == false {
        return Err(ApiError::bad("this question takes one of its options, not an answer of your own"));
    }
    let picked = choices.len() + usize::from(text.is_some());
    if picked == 0 {
        return Err(ApiError::bad("pick an option or write an answer"));
    }
    if picked > 1 && asked["multi_select"] != true {
        return Err(ApiError::bad("this question takes one answer"));
    }
    let reply = reply_text(asked["question"].as_str().unwrap_or(""), &choices, text);
    let mut answered = asked.clone();
    answered["status"] = json!("answered");
    answered["answer"] = json!({"choices": choices, "text": text});
    // In one statement, so of two answers at once only one is sent.
    let taken = s.db().execute(
        "UPDATE messages SET data=?1 WHERE id=?2 AND json_extract(data, '$.status')='pending'",
        rusqlite::params![answered.to_string(), message_id],
    )?;
    if taken == 0 {
        return Err(ApiError::conflict("this question has been answered already"));
    }
    match crate::runner::send(s, task_id, &reply) {
        Ok(task) => {
            emit(s, message_id);
            // Any other question it was waiting on is settled by this reply.
            replied(s, task_id);
            Ok(task)
        }
        Err(e) => {
            // Answerable again.
            let _ = s.db().execute("UPDATE messages SET data=?1 WHERE id=?2", rusqlite::params![data, message_id]);
            Err(e)
        }
    }
}

/// The message that answers a question: the question, quoted, and the answer (a list for several).
pub fn reply_text(question: &str, choices: &[String], text: Option<&str>) -> String {
    let quoted: Vec<String> = question.lines().map(|l| format!("> {l}").trim_end().to_string()).collect();
    let answers: Vec<&str> = choices.iter().map(String::as_str).chain(text).collect();
    let answer = match answers.as_slice() {
        [one] => one.to_string(),
        many => many.iter().map(|a| format!("- {}", a.replace('\n', "\n  "))).collect::<Vec<_>>().join("\n"),
    };
    format!("{}\n\n{answer}", quoted.join("\n"))
}

/// The user replied in `task_id`'s thread: the questions it was waiting on are settled.
pub fn replied(s: &Shared, task_id: &str) {
    let pending: Vec<(i64, String)> = {
        let c = s.db();
        let Ok(mut st) = c.prepare("SELECT id, data FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data, '$.status')='pending'") else {
            return;
        };
        st.query_map([task_id], |r| Ok((r.get(0)?, r.get(1)?))).map(|it| it.filter_map(Result::ok).collect()).unwrap_or_default()
    };
    for (id, data) in pending {
        let mut v: Value = serde_json::from_str(&data).unwrap_or(json!({}));
        v["status"] = json!("replied");
        // Unless it's been answered since.
        let n = s.db().execute(
            "UPDATE messages SET data=?1 WHERE id=?2 AND json_extract(data, '$.status')='pending'",
            rusqlite::params![v.to_string(), id],
        );
        if n.is_ok_and(|n| n > 0) {
            emit(s, id);
        }
    }
}

fn emit(s: &Shared, message_id: i64) {
    let m = s.db().query_row("SELECT * FROM messages WHERE id=?1", [message_id], db::Message::from_row);
    if let Ok(m) = m {
        s.emit(json!({"type": "message_updated", "task_id": m.task_id, "message": m}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{McpCall, handle_mcp};

    /// A task with a run that's going (a message sent to it is queued for it, as no agent reads its input).
    fn running_task(s: &Shared) -> (Task, db::Run) {
        let profile = db::insert_profile(&s.db(), "p", &[], None).unwrap();
        let t = db::NewTask {
            profile_id: &profile.id,
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
        let task = db::insert_task(&s.db(), t).unwrap();
        let run = db::insert_run(&s.db(), &task.id, "prompt").unwrap();
        s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
        s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
        (task, run)
    }

    async fn ask_with(s: &Shared, run: &db::Run, call_id: &str, args: Value) -> Result<Value, String> {
        handle_mcp(s, McpCall { run_id: run.id.clone(), call_id: call_id.into(), tool: "request_user_input".into(), args, task_fields: true }).await
    }

    fn questions(s: &Shared, task_id: &str) -> Vec<db::Message> {
        db::list_messages(&s.db(), task_id).unwrap().into_iter().filter(|m| m.kind == "question").collect()
    }

    fn pick(choices: &[&str], text: Option<&str>) -> Answer {
        Answer { choices: choices.iter().map(|c| c.to_string()).collect(), text: text.map(String::from) }
    }

    #[test]
    fn checks_what_the_agent_asks() {
        assert!(card(&json!({"question": " "})).is_err());
        let c = card(&json!({"question": "Which?", "options": ["A", {"label": " B ", "description": " the second "}, {"label": "C", "description": ""}]})).unwrap();
        assert_eq!(
            c,
            json!({
                "question": "Which?",
                "options": [{"label": "A"}, {"label": "B", "description": "the second"}, {"label": "C"}],
                "multi_select": false,
                "allow_other": true
            })
        );
        assert!(card(&json!({"question": "Which?", "options": [{"description": "no label"}]})).is_err());
        assert!(card(&json!({"question": "Which?", "options": ["A", "A"]})).is_err());
        assert!(card(&json!({"question": "Which?", "options": (0..10).map(|i| i.to_string()).collect::<Vec<_>>()})).is_err());
        assert!(card(&json!({"question": "Which?", "options": "A, B"})).is_err());
        assert!(card(&json!({"question": "Which?", "multi_select": "yes"})).is_err());
        let c = card(&json!({"question": "Which?", "multi_select": true, "allow_other": false})).unwrap();
        assert_eq!((&c["multi_select"], &c["allow_other"], &c["options"]), (&json!(true), &json!(false), &json!([])));
    }

    #[test]
    fn a_question_with_options_is_answered_from_its_card() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, run) = running_task(&s);
            let args = json!({"question": "Which colour?", "options": [{"label": "Red", "description": "Bold"}, {"label": "Green"}]});
            let v = ask_with(&s, &run, "c1", args.clone()).await.unwrap();
            assert!(v["note"].as_str().unwrap().contains("options"), "{v}");
            // Asked again after a restart: still one card.
            s.db().execute("UPDATE mcp_calls SET status='executing' WHERE id='c1'", []).unwrap();
            ask_with(&s, &run, "c1", args).await.unwrap();
            let asked = questions(&s, &task.id);
            assert_eq!(asked.len(), 1);
            assert_eq!((&asked[0].data["status"], &asked[0].data["call_id"]), (&json!("pending"), &json!("c1")));
            assert_eq!(db::get_run(&s.db(), &run.id).unwrap().unwrap().attention.as_deref(), Some("Which colour?"));
            let id = asked[0].id;

            let bad = axum::http::StatusCode::BAD_REQUEST;
            assert_eq!(answer(&s, &task.id, id, pick(&["Blue"], None)).unwrap_err().0, bad);
            assert_eq!(answer(&s, &task.id, id, pick(&["Red", "Green"], None)).unwrap_err().0, bad);
            assert_eq!(answer(&s, &task.id, id, pick(&["Red"], Some("and blue"))).unwrap_err().0, bad);
            assert_eq!(answer(&s, &task.id, id, pick(&[], Some("  "))).unwrap_err().0, bad);
            // Not another thread's.
            assert_eq!(answer(&s, "other", id, pick(&["Red"], None)).unwrap_err().0, axum::http::StatusCode::NOT_FOUND);

            let t = answer(&s, &task.id, id, pick(&["Red"], None)).unwrap();
            assert_eq!(t.queued_message.as_deref(), Some("> Which colour?\n\nRed"));
            let data = &questions(&s, &task.id)[0].data;
            assert_eq!((&data["status"], &data["answer"]), (&json!("answered"), &json!({"choices": ["Red"], "text": null})));
            // A second answer (another tab's) isn't sent.
            assert_eq!(answer(&s, &task.id, id, pick(&["Green"], None)).unwrap_err().0, axum::http::StatusCode::CONFLICT);
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().queued_message.as_deref(), Some("> Which colour?\n\nRed"));
        });
    }

    #[test]
    fn several_answers_or_ones_own() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, run) = running_task(&s);
            ask_with(&s, &run, "c1", json!({"question": "Which?", "options": ["A", "B", "C"], "multi_select": true})).await.unwrap();
            let id = questions(&s, &task.id)[0].id;
            let t = answer(&s, &task.id, id, pick(&["C", "A", "A"], Some("and D,\nwith E"))).unwrap();
            assert_eq!(t.queued_message.as_deref(), Some("> Which?\n\n- C\n- A\n- and D,\n  with E"));

            // Only the options, when it doesn't take an answer of the user's own.
            ask_with(&s, &run, "c2", json!({"question": "Pick one", "options": ["X"], "allow_other": false})).await.unwrap();
            let id = questions(&s, &task.id)[1].id;
            assert!(answer(&s, &task.id, id, pick(&[], Some("Y"))).is_err());
            // Without options, any answer.
            ask_with(&s, &run, "c3", json!({"question": "What's the URL?"})).await.unwrap();
            let id = questions(&s, &task.id)[2].id;
            s.update_task(&task.id, &[("queued_message", Value::Null)]).unwrap();
            let t = answer(&s, &task.id, id, pick(&[], Some("https://example.com"))).unwrap();
            assert_eq!(t.queued_message.as_deref(), Some("> What's the URL?\n\nhttps://example.com"));
            // That settles the one it was still waiting on as well.
            assert_eq!(questions(&s, &task.id).iter().map(|m| m.data["status"].as_str().unwrap()).collect::<Vec<_>>(), ["answered", "replied", "answered"]);
        });
    }

    #[test]
    fn stays_answerable_after_the_run_and_until_its_answer_is_sent() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, run) = running_task(&s);
            ask_with(&s, &run, "c1", json!({"question": "Which?", "options": ["A", "B"]})).await.unwrap();
            let id = questions(&s, &task.id)[0].id;
            // The run ends (and no agent can start here): the answer can't be sent, so it can be given again.
            s.runs.lock().unwrap().remove(&task.id);
            crate::permissions::expire_for_task(&s, &task.id);
            assert!(answer(&s, &task.id, id, pick(&["A"], None)).is_err());
            assert_eq!(questions(&s, &task.id)[0].data["status"], "pending");
            s.runs.lock().unwrap().insert(task.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
            assert!(answer(&s, &task.id, id, pick(&["B"], None)).is_ok());
        });
    }

    #[test]
    fn a_question_the_conversation_has_moved_past_isnt_answered() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, run) = running_task(&s);
            ask_with(&s, &run, "c1", json!({"question": "Which?", "options": ["A", "B"]})).await.unwrap();
            // A message that doesn't settle it as the user's reply does (the board's own, say).
            db::insert_message(&s.db(), &task.id, "user", &json!({"text": "Merge it", "auto": true})).unwrap();
            let id = questions(&s, &task.id)[0].id;
            assert_eq!(answer(&s, &task.id, id, pick(&["A"], None)).unwrap_err().0, axum::http::StatusCode::CONFLICT);
            assert_eq!(db::get_task(&s.db(), &task.id).unwrap().unwrap().queued_message, None);
        });
    }

    #[test]
    fn a_reply_in_the_thread_settles_its_questions() {
        crate::testing::run(async || {
            let s = crate::testing::state();
            let (task, run) = running_task(&s);
            ask_with(&s, &run, "c1", json!({"question": "Which?", "options": ["A", "B"]})).await.unwrap();
            replied(&s, &task.id);
            let data = &questions(&s, &task.id)[0].data;
            assert_eq!(data["status"], "replied");
            assert_eq!(answer(&s, &task.id, questions(&s, &task.id)[0].id, pick(&["A"], None)).unwrap_err().0, axum::http::StatusCode::CONFLICT);
        });
    }
}
