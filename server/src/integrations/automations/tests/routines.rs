//! Routines: a profile's automations that wake its assistant, and what's new for every automation
//! (cron and at triggers, active hours, prechecks and budgets).

use super::*;
use crate::agent::runner::Outcome as RunOutcome;

fn profile(s: &Shared) -> db::Profile {
    db::insert_profile(&s.db(), "personal", &[], None).unwrap()
}

fn routine(s: &Shared, profile_id: &str, v: Value) -> ApiResult<Automation> {
    create_routine(s, profile_id, v.as_object().unwrap())
}

fn cron(expr: &str) -> Trigger {
    Trigger::Cron { expr: expr.into() }
}

/// Makes `task_id` look as if its agent were running, so a message sent to it is queued.
fn busy(s: &Shared, task_id: &str) {
    s.runs.lock().unwrap().insert(task_id.to_string(), crate::state::RunHandle { run_id: "none".into(), cancel: None });
}

fn last_run(s: &Shared, a: &Automation) -> Run {
    runs(&s.db(), &a.id, 1).unwrap().remove(0)
}

/// The agent's reply in a thread, as Claude Code (and Codex, as the board records it) writes it.
fn said(s: &Shared, task_id: &str, text: &str) {
    db::insert_message(&s.db(), task_id, "user", &json!({"text": "go"})).unwrap();
    db::insert_message(&s.db(), task_id, "claude", &json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})).unwrap();
}

fn reports(s: &Shared, task_id: &str) -> Vec<Value> {
    db::list_messages(&s.db(), task_id).unwrap().into_iter().filter(|m| m.kind == "report").map(|m| m.data).collect()
}

#[test]
fn cron_expressions_follow_their_fields_and_daylight_saving() {
    let next = |e: &str, after: DateTime<Utc>| next_after(&cron(e), after, &Nz).unwrap();
    // 2026-09-25 is a Friday.
    assert_eq!(next("0 8 * * mon-fri", nz("2026-09-25 08:00")), nz("2026-09-28 08:00"));
    assert_eq!(next("*/15 9-17 * * *", nz("2026-09-25 17:50")), nz("2026-09-26 09:00"));
    assert_eq!(next("*/15 9-17 * * *", nz("2026-09-25 10:01")), nz("2026-09-25 10:15"));
    assert_eq!(next("30 7 1 * *", nz("2026-09-25 00:00")), nz("2026-10-01 07:30"));
    assert_eq!(next("0 12 * jan,jul *", nz("2026-09-25 00:00")), nz("2027-01-01 12:00"));
    // Both day fields restricted: either one will do, as in Vixie cron.
    assert_eq!(next("0 9 13 * fri", nz("2026-09-25 10:00")), nz("2026-10-02 09:00"));
    assert_eq!(next("0 9 1 * fri", nz("2026-09-26 10:00")), nz("2026-10-01 09:00"));
    // Sunday is 0 or 7, and @daily is midnight.
    assert_eq!(next("0 10 * * 7", nz("2026-09-25 00:00")), next("0 10 * * sun", nz("2026-09-25 00:00")));
    assert_eq!(next("@daily", nz("2026-09-25 13:00")), nz("2026-09-26 00:00"));
    // 2:30 doesn't exist on 2026-09-27 (the clocks go forward): it runs at 3:00, once.
    assert_eq!(next("30 2 * * *", nz("2026-09-26 03:00")), nz("2026-09-27 03:00"));
    assert_eq!(next("30 2 * * *", nz("2026-09-27 03:00")), nz("2026-09-28 02:30"));
    // 2:30 happens twice on 2027-04-04: the first, and not the second.
    let first = next("30 2 * * *", nz("2027-04-04 01:00"));
    assert_eq!(first, utc("2027-04-03T13:30:00Z"));
    assert_eq!(next("30 2 * * *", first), utc("2027-04-04T14:30:00Z"));
    // A 29 February comes round.
    assert_eq!(next("0 0 29 2 *", nz("2026-09-25 00:00")), nz("2028-02-29 00:00"));

    for bad in ["", "* * * *", "60 * * * *", "* 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 8", "5-1 * * * *", "*/0 * * * *", "0 0 * * someday"] {
        assert!(check_trigger(cron(bad)).is_err(), "{bad}");
    }
    assert!(check_trigger(cron("0 0 30 2 *")).unwrap_err().1.contains("never matches"));
    assert_eq!(check_trigger(cron("  0  8 * *   mon-fri ")).unwrap(), cron("0 8 * * mon-fri"));
}

#[test]
fn active_hours_hold_back_a_schedule_until_they_start() {
    let hours = |start: &str, end: &str, days: &[&str]| ActiveHours { start: start.into(), end: end.into(), weekdays: days.iter().map(|d| d.to_string()).collect() };
    let night = hours("22:00", "06:00", &[]);
    assert!(night.contains(nz("2026-09-25 23:30"), &Nz));
    assert!(night.contains(nz("2026-09-26 05:59"), &Nz));
    assert!(!night.contains(nz("2026-09-26 06:00"), &Nz));
    assert!(!night.contains(nz("2026-09-25 12:00"), &Nz));
    // Past midnight belongs to the day the hours started: Friday night's run into Saturday.
    let friday_night = hours("22:00", "02:00", &["fri"]);
    assert!(friday_night.contains(nz("2026-09-26 01:00"), &Nz));
    assert!(!friday_night.contains(nz("2026-09-27 01:00"), &Nz));

    let day = hours("08:00", "18:00", &["mon", "tue", "wed", "thu", "fri"]);
    let every = Trigger::Interval { every_minutes: 30 };
    // An interval outside them starts again when they do: Friday evening waits for Monday.
    assert_eq!(next_run(&every, Some(&day), nz("2026-09-25 17:45"), &Nz), Some(nz("2026-09-28 08:00")));
    assert_eq!(next_run(&every, Some(&day), nz("2026-09-25 10:00"), &Nz), Some(nz("2026-09-25 10:30")));
    // A cron expression waits for its next time in them.
    assert_eq!(next_run(&cron("15 * * * *"), Some(&day), nz("2026-09-25 17:20"), &Nz), Some(nz("2026-09-28 08:15")));
    // An at keeps its time.
    let at = Trigger::At { at: fmt(nz("2026-09-26 03:00")) };
    assert_eq!(next_run(&at, Some(&day), nz("2026-09-25 17:20"), &Nz), Some(nz("2026-09-26 03:00")));

    assert!(check_active_hours(&json!({"start": "08:00", "end": "08:00"})).is_err());
    assert!(check_active_hours(&json!({"start": "8", "end": "18:00"})).is_err());
    assert_eq!(check_active_hours(&json!({"start": "8:00", "end": "18:00", "weekdays": ["fri", "mon"]})).unwrap(), Some(hours("08:00", "18:00", &["mon", "fri"])));
    assert_eq!(check_active_hours(&Value::Null).unwrap(), None);
}

#[test]
fn an_at_runs_once_however_late_then_turns_itself_off() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        busy(&s, &assistant.id);
        // In the past, it can't be set.
        let past = json!({"name": "Late", "trigger": {"kind": "at", "at": "2020-01-01 09:00"}, "action": {"kind": "message_assistant", "message": "x"}});
        assert!(routine(&s, &p.id, past).unwrap_err().1.contains("passed"));
        let at = (Utc::now() + chrono::TimeDelta::hours(1)).with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string();
        let a = routine(
            &s,
            &p.id,
            json!({"name": "Remind me", "trigger": {"kind": "at", "at": at}, "action": {"kind": "message_assistant", "mode": "thread", "message": "Remind them to call Sam."}}),
        )
        .unwrap();
        // Stored in UTC, and due then.
        let due = parse_time(a.next_run_at.as_deref().unwrap()).unwrap();
        assert_eq!(Some(due), parse_at(&at, &Local));
        assert!(matches!(&a.trigger, Trigger::At { at } if parse_time(at) == Some(due)));
        // Hours late (the server was down), it still runs, once.
        tick(&s, due + chrono::TimeDelta::hours(3)).await;
        tick(&s, due + chrono::TimeDelta::hours(4)).await;
        let a = get(&s.db(), &a.id).unwrap().unwrap();
        assert_eq!((a.enabled, a.next_run_at.as_deref()), (false, None));
        let r = runs(&s.db(), &a.id, 10).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].status.as_str(), r[0].task_id.as_deref()), ("ok", Some(assistant.id.as_str())));
        let queued = db::get_task(&s.db(), &assistant.id).unwrap().unwrap().queued_message.unwrap();
        assert!(queued.starts_with("From your routine \"Remind me\", on its schedule:\n\nRemind them to call Sam."), "{queued}");
        // Turned on again with its time gone, it says so.
        s.db().execute("UPDATE automations SET trigger=?2 WHERE id=?1", params![a.id, json!(Trigger::At { at: fmt(Utc::now() - chrono::TimeDelta::minutes(1)) }).to_string()]).unwrap();
        let on = update_handler(State(s.clone()), Path(a.id.clone()), Json(json!({"enabled": true}).as_object().unwrap().clone())).await;
        assert!(on.unwrap_err().1.contains("passed"));
    })
}

#[test]
fn a_routine_belongs_to_a_profile_and_only_messages_its_assistant() {
    testing::run(async || {
        let (s, project) = setup();
        let p = db::get_profile(&s.db(), &project.profile_id).unwrap().unwrap();
        let msg = json!({"kind": "message_assistant", "message": "Check the mail"});
        // A routine can't make tasks, nor a project's automation wake the assistant.
        let task = json!({"name": "x", "trigger": {"kind": "interval", "every_minutes": 60}, "action": {"kind": "create_task", "title": "x"}});
        assert!(routine(&s, &p.id, task).unwrap_err().1.contains("only message the assistant"));
        let wake = json!({"name": "x", "trigger": {"kind": "interval", "every_minutes": 60}, "action": msg});
        assert!(new(&s, &project.id, wake.clone()).unwrap_err().1.contains("profile's routines"));
        let a = routine(&s, &p.id, wake).unwrap();
        assert_eq!((a.project_id.as_deref(), a.profile_id.as_str(), a.is_routine()), (None, p.id.as_str(), true));
        assert_eq!(a.action, Action::MessageAssistant { message: "Check the mail".into(), mode: AssistantMode::Fresh });
        // Listed with the profile's routines, not the project's automations.
        assert_eq!(list_routines(&s.db(), &p.id).unwrap().iter().map(|a| a.id.clone()).collect::<Vec<_>>(), [a.id.clone()]);
        assert!(list(&s.db(), &project.id).unwrap().is_empty());
        let listed = list_routines_handler(State(s.clone()), Path(p.id.clone())).await.unwrap().0;
        assert_eq!(listed["automations"][0]["profile_id"], json!(p.id));
        assert_eq!(listed["automations"][0]["cost_today_usd"], json!(0.0));
        // Changing its action keeps to the same rule.
        let bad = update_handler(State(s.clone()), Path(a.id.clone()), Json(json!({"action": {"kind": "create_task", "title": "x"}}).as_object().unwrap().clone())).await;
        assert!(bad.is_err());
        // It goes with its profile.
        s.db().execute("DELETE FROM profiles WHERE id=?1", [&p.id]).unwrap();
        assert!(get(&s.db(), &a.id).unwrap().is_none());
    })
}

#[test]
fn a_fresh_run_works_in_a_thread_of_its_own_under_the_assistant() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        s.db().execute("UPDATE tasks SET model='opus', permission_mode='acceptEdits' WHERE id=?1", [&assistant.id]).unwrap();
        let a = routine(&s, &p.id, json!({"name": "Inbox", "trigger": {"kind": "cron", "expr": "0 8 * * *"}, "action": {"kind": "message_assistant", "message": "Anything new in the inbox?"}}))
            .unwrap();
        // Tests can't start agents: here, a send would be refused. It's queued for the thread's (pretend) run.
        let s2 = s.clone();
        testing::when("routine:thread", move || {
            let id: String = s2.db().query_row("SELECT id FROM tasks WHERE task_type='routine' ORDER BY created_at DESC LIMIT 1", [], |r| r.get(0)).unwrap();
            busy(&s2, &id);
        });
        let r = run_handler(State(s.clone()), Path(a.id.clone()), None).await.unwrap().0;
        assert_eq!(r["status"], "ok", "{r}");
        let thread = db::get_task(&s.db(), r["task_id"].as_str().unwrap()).unwrap().unwrap();
        assert!(thread.is_routine() && thread.is_assistants() && !thread.is_assistant());
        assert_eq!((thread.parent_id.as_deref(), thread.project_id.as_deref()), (Some(assistant.id.as_str()), None));
        // Keyed after the assistant, A-2, in its workspace, with its model and permission mode.
        assert_eq!((thread.number, r["task"]["key"].as_str()), (2, Some("A-2")));
        assert_eq!(thread.work_dir, assistant.work_dir);
        assert_eq!(crate::agent::documents::work_dir(&s, &thread), crate::agent::documents::work_dir(&s, &assistant));
        assert!(!crate::agent::documents::documents_only(&thread));
        assert_eq!((thread.model.as_deref(), thread.permission_mode.as_deref(), thread.claude_config_id.clone()), (Some("opus"), Some("acceptEdits"), assistant.claude_config_id.clone()));
        assert!(thread.title.starts_with("Inbox · "), "{}", thread.title);
        // Its prompt is the routine's, with how to stay quiet.
        let text = thread.queued_message.clone().unwrap();
        let text = text.as_str();
        assert!(text.starts_with("This is a run of your routine \"Inbox\", by hand, from the board"), "{text}");
        assert!(text.contains("Anything new in the inbox?") && text.contains("NO_REPLY"), "{text}");
        // Off the board: not in the profile's tasks, nor its tasks in no project, even with the assistant.
        let ids = |ts: Vec<db::Task>| ts.into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert!(!ids(db::list_tasks_for_profile(&s.db(), &p.id, true).unwrap()).contains(&thread.id));
        assert!(!ids(db::list_group_tasks(&s.db(), &p.id, true).unwrap()).contains(&thread.id));
        assert_eq!(db::assistant_task_by_number(&s.db(), &p.id, 2).unwrap().map(|t| t.id), Some(thread.id.clone()));
    })
}

#[test]
fn a_quiet_run_posts_nothing_and_a_report_reaches_the_assistant_once() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        let a = routine(&s, &p.id, json!({"name": "Inbox", "trigger": {"kind": "interval", "every_minutes": 60}, "action": {"kind": "message_assistant", "message": "x"}})).unwrap();
        let thread = |n: &str| {
            let t = db::insert_routine_task(&s.db(), &assistant, n).unwrap();
            let mut r = Run::new(&a.id, "schedule", "ok", Utc::now());
            r.task_id = Some(t.id.clone());
            insert_run(&s.db(), &r).unwrap();
            s.db().execute("UPDATE tasks SET cost_usd=0.25 WHERE id=?1", [&t.id]).unwrap();
            (db::get_task(&s.db(), &t.id).unwrap().unwrap(), r.id)
        };
        for quiet in ["NO_REPLY", "  `NO_REPLY`\n", "Checked: nothing new.\n\n**NO_REPLY**", ""] {
            let (t, run) = thread("q");
            if !quiet.is_empty() {
                said(&s, &t.id, quiet);
            }
            routines::finished(&s, &t, &RunOutcome::Ok, None);
            assert!(reports(&s, &assistant.id).is_empty(), "{quiet:?}");
            let r = get_run(&s.db(), &run).unwrap().unwrap();
            assert_eq!((r.outcome.as_deref(), r.cost_usd), (Some("quiet"), Some(0.25)), "{quiet:?}");
        }
        let (t, run) = thread("r");
        said(&s, &t.id, "Two new mails from the bank; one needs a reply by Friday.");
        routines::finished(&s, &t, &RunOutcome::Ok, None);
        let posted = reports(&s, &assistant.id);
        assert_eq!(posted.len(), 1);
        assert_eq!(posted[0]["text"], "Two new mails from the bank; one needs a reply by Friday.");
        assert_eq!((posted[0]["automation"].as_str(), posted[0]["key"].as_str(), posted[0]["outcome"].as_str()), (Some("Inbox"), Some(format!("A-{}", t.number).as_str()), Some("reported")));
        assert_eq!(get_run(&s.db(), &run).unwrap().unwrap().outcome.as_deref(), Some("reported"));
        // A failure is posted too, so the user knows.
        let (t, _) = thread("f");
        routines::finished(&s, &t, &RunOutcome::Failed("Out of usage\nmore".into()), None);
        assert_eq!(reports(&s, &assistant.id)[1]["outcome"], "failed");
        assert_eq!(reports(&s, &assistant.id)[1]["text"], "Out of usage");
        // The assistant reads them with its next prompt, once.
        let (unread, ids) = routines::unread_reports(&s, &assistant.id).unwrap();
        routines::mark_read(&s, &ids);
        assert!(unread.contains("\"Inbox\" reported") && unread.contains("Two new mails from the bank") && unread.contains("\"Inbox\" failed"), "{unread}");
        assert_eq!(routines::unread_reports(&s, &assistant.id), None);
    })
}

#[test]
fn a_routine_threads_run_ending_marks_it_done_and_reports() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        let t = db::insert_routine_task(&s.db(), &assistant, "Inbox").unwrap();
        let run = db::insert_run(&s.db(), &t.id, "prompt").unwrap();
        s.runs.lock().unwrap().insert(t.id.clone(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
        s.update_task(&t.id, &[("running", json!(true)), ("status", json!("in_progress"))]).unwrap();
        said(&s, &t.id, "The deploy failed overnight.");
        crate::agent::runner::finish(&s, &run.id, RunOutcome::Ok);
        let t = db::get_task(&s.db(), &t.id).unwrap().unwrap();
        assert_eq!((t.status.as_str(), t.running), ("done", false));
        assert_eq!(reports(&s, &assistant.id)[0]["text"], "The deploy failed overnight.");
    })
}

#[test]
fn a_precheck_skips_a_run_or_fills_in_what_it_found() {
    testing::run(async || {
        let (s, p) = setup();
        let dir = testing::temp_dir();
        s.db().execute("UPDATE projects SET repo_path=?2 WHERE id=?1", params![p.id, crate::util::path_str(&dir)]).unwrap();
        std::fs::write(dir.join("feed.txt"), "New: <b>release 2.0</b>").unwrap();
        let t = api::create_task_inner(&s, &p.id, CreateTask { title: "Watch".into(), ..Default::default() }).unwrap();
        busy(&s, &t.id);
        let a = new(
            &s,
            &p.id,
            json!({"name": "Feed", "trigger": {"kind": "interval", "every_minutes": 60}, "precheck": "test -s feed.txt || exit 1; cat feed.txt",
                   "action": {"kind": "send_to_task", "task_id": t.id, "message": "Look: {{precheck}}"}}),
        )
        .unwrap();
        assert_eq!(a.precheck.as_deref(), Some("test -s feed.txt || exit 1; cat feed.txt"));
        set_next(&s, &a, Utc::now() - chrono::TimeDelta::seconds(1));
        tick(&s, Utc::now()).await;
        assert_eq!(last_run(&s, &a).status, "ok");
        let q = db::get_task(&s.db(), &t.id).unwrap().unwrap().queued_message.unwrap();
        // It ran in the project's folder, and what it printed is data from outside.
        assert!(q.contains("Look: <untrusted-data>New: &lt;b&gt;release 2.0&lt;/b&gt;</untrusted-data>"), "{q}");
        assert!(q.contains("**Note:** parts of this come from what the precheck command of the automation \"Feed\" printed"), "{q}");

        // Exit 1: nothing new, so the run is skipped, and says what it printed.
        std::fs::write(dir.join("feed.txt"), "").unwrap();
        let r = run_handler(State(s.clone()), Path(a.id.clone()), None).await.unwrap().0;
        assert_eq!(r["status"], "skipped");
        assert!(r["detail"].as_str().unwrap().starts_with("Skipped: its precheck found nothing to do (exit 1)"), "{r}");
        // Any other exit fails the run.
        let upd = |b: Value| update_handler(State(s.clone()), Path(a.id.clone()), Json(b.as_object().unwrap().clone()));
        let _ = upd(json!({"precheck": "echo broken >&2; exit 3"})).await.unwrap();
        let r = run_handler(State(s.clone()), Path(a.id.clone()), None).await.unwrap().0;
        assert_eq!(r["status"], "failed");
        assert!(r["detail"].as_str().unwrap().contains("broken"), "{r}");
        // Blank clears it.
        assert_eq!(upd(json!({"precheck": "  "})).await.unwrap().0["precheck"], Value::Null);
    })
}

#[test]
fn a_routines_precheck_runs_in_the_assistants_workspace() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        busy(&s, &assistant.id);
        let a = routine(
            &s,
            &p.id,
            json!({"name": "Where", "trigger": {"kind": "interval", "every_minutes": 60}, "precheck": "pwd",
                   "action": {"kind": "message_assistant", "mode": "thread", "message": "{{precheck}}"}}),
        )
        .unwrap();
        let _ = run_handler(State(s.clone()), Path(a.id.clone()), None).await.unwrap();
        let q = db::get_task(&s.db(), &assistant.id).unwrap().unwrap().queued_message.unwrap();
        let ws = crate::agent::documents::work_dir(&s, &assistant).unwrap().canonicalize().unwrap();
        assert!(q.contains(&format!("<untrusted-data>{}</untrusted-data>", ws.display())), "{q}");
    })
}

#[test]
fn a_routine_over_its_budget_today_is_skipped() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        busy(&s, &assistant.id);
        let a = routine(
            &s,
            &p.id,
            json!({"name": "Pricey", "trigger": {"kind": "interval", "every_minutes": 60}, "budget_usd": 1.0,
                   "action": {"kind": "message_assistant", "mode": "thread", "message": "x"}}),
        )
        .unwrap();
        assert_eq!(a.budget_usd, Some(1.0));
        let now = Utc::now();
        // Yesterday's runs don't count; today's do, ended or still working.
        let mut old = Run::new(&a.id, "schedule", "ok", routines_day_start(now) - chrono::TimeDelta::minutes(1));
        old.cost_usd = Some(5.0);
        insert_run(&s.db(), &old).unwrap();
        let mut ended = Run::new(&a.id, "schedule", "ok", now);
        ended.cost_usd = Some(0.6);
        insert_run(&s.db(), &ended).unwrap();
        assert!((routines::spent_today(&s.db(), &a.id, now, &Local).unwrap() - 0.6).abs() < 1e-9);
        set_next(&s, &a, now - chrono::TimeDelta::seconds(1));
        tick(&s, now).await;
        assert_eq!(last_run(&s, &a).status, "ok");

        let working = db::insert_routine_task(&s.db(), &assistant, "w").unwrap();
        s.db().execute("UPDATE tasks SET cost_usd=0.5 WHERE id=?1", [&working.id]).unwrap();
        let mut r = Run::new(&a.id, "schedule", "ok", now);
        r.task_id = Some(working.id.clone());
        insert_run(&s.db(), &r).unwrap();
        set_next(&s, &a, now - chrono::TimeDelta::seconds(1));
        tick(&s, now).await;
        let r = last_run(&s, &a);
        assert_eq!(r.status, "skipped");
        assert!(r.detail.as_deref().unwrap().starts_with("Skipped: over budget (its runs today cost $1.10, and its budget is $1.00 a day)"), "{:?}", r.detail);
        // Run now isn't held to it.
        assert_eq!(run_handler(State(s.clone()), Path(a.id.clone()), None).await.unwrap().0["status"], "ok");
    })
}

fn routines_day_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let date = now.with_timezone(&Local).date_naive();
    Local.from_local_datetime(&date.and_time(NaiveTime::MIN)).earliest().unwrap().with_timezone(&Utc)
}

#[test]
fn deliveries_outside_active_hours_are_skipped_and_a_still_running_thread_holds_the_next_run() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        // Hours that are never now: from an hour from now to two hours from now.
        let local = Local::now();
        let h = |d: i64| (local + chrono::TimeDelta::hours(d)).format("%H:%M").to_string();
        let a = routine(
            &s,
            &p.id,
            json!({"name": "Hook", "trigger": {"kind": "webhook"}, "active_hours": {"start": h(1), "end": h(2)},
                   "action": {"kind": "message_assistant", "message": "{{body.x}}"}}),
        )
        .unwrap();
        let app = api::router(s.clone());
        let (status, v) = deliver(&app, &a.hook_path(), &[], r#"{"x": 1}"#).await;
        assert_eq!(v["status"], "skipped", "{status} {v}");
        assert!(v["detail"].as_str().unwrap().starts_with("Skipped: outside its active hours"), "{v}");
        // In them, a fresh run makes a thread; while it's still working, the next is skipped.
        let _ = update_handler(State(s.clone()), Path(a.id.clone()), Json(json!({"active_hours": null}).as_object().unwrap().clone())).await.unwrap();
        let t = db::insert_routine_task(&s.db(), &assistant, "w").unwrap();
        s.db().execute("UPDATE tasks SET running=1 WHERE id=?1", [&t.id]).unwrap();
        let mut r = Run::new(&a.id, "webhook", "ok", Utc::now());
        r.task_id = Some(t.id.clone());
        insert_run(&s.db(), &r).unwrap();
        let (_, v) = deliver(&app, &a.hook_path(), &[], r#"{"x": 2}"#).await;
        assert_eq!(v["status"], "skipped");
        assert_eq!(v["detail"], format!("Skipped: its last run (A-{}) is still going", t.number));
    })
}

#[test]
fn old_routine_threads_are_pruned_whatever_their_status_and_the_workspace_stays() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        let ws = crate::agent::documents::work_dir(&s, &assistant).unwrap();
        std::fs::write(ws.join("MEMORY.md"), "remember").unwrap();
        let thread = |status: &str, reason: Option<&str>| {
            let t = db::insert_routine_task(&s.db(), &assistant, status).unwrap();
            s.db().execute("UPDATE tasks SET status=?2, attention_reason=?3 WHERE id=?1", params![t.id, status, reason]).unwrap();
            t
        };
        let done = thread("done", None);
        // A run that failed (out of usage, say), one stopped, and one that asked: all left in Needs attention.
        let failed = thread("needs_attention", Some("Run failed: boom"));
        let stopped = thread("needs_attention", Some("Stopped by user"));
        let asked = thread("needs_attention", Some("Which inbox?"));
        let recent = thread("needs_attention", Some("Run failed: boom"));
        let running = thread("in_progress", None);
        let waiting = thread("in_progress", None);
        let long_ago = fmt(Utc::now() - chrono::TimeDelta::days(routines::KEEP_THREAD_DAYS + 1));
        for t in [&done, &failed, &stopped, &asked, &running, &waiting] {
            s.db().execute("UPDATE tasks SET last_activity_at=?2 WHERE id=?1", params![t.id, long_ago]).unwrap();
        }
        s.db().execute("UPDATE tasks SET running=1 WHERE id=?1", [&running.id]).unwrap();
        // Waiting for its usage limit to reset.
        s.db().execute("UPDATE tasks SET waiting=1 WHERE id=?1", [&waiting.id]).unwrap();
        routines::prune_threads(&s, Utc::now()).await;
        let left = |t: &db::Task| db::get_task(&s.db(), &t.id).unwrap().is_some();
        for t in [&done, &failed, &stopped, &asked] {
            assert!(!left(t), "{}", t.title);
        }
        // Recent ones stay, as do ones still going or waiting.
        assert!(left(&recent) && left(&running) && left(&waiting) && left(&assistant));
        assert_eq!(std::fs::read_to_string(ws.join("MEMORY.md")).unwrap(), "remember");
    })
}

#[test]
fn a_database_at_version_78_keeps_its_automations_and_runs() {
    let path = testing::temp_dir().join("huntaway.db");
    {
        let c = crate::db::open(&path).unwrap();
        c.execute_batch(
            "DROP TABLE automation_runs; DROP TABLE automations;
             CREATE TABLE automations (
               id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
               enabled INTEGER NOT NULL DEFAULT 1, trigger TEXT NOT NULL, action TEXT NOT NULL, token TEXT NOT NULL, secret TEXT,
               next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE INDEX automations_project ON automations(project_id);
             CREATE TABLE automation_runs (
               id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, source TEXT NOT NULL,
               status TEXT NOT NULL, detail TEXT, task_id TEXT, delivery_id TEXT, event TEXT, count INTEGER NOT NULL DEFAULT 1,
               batch_key TEXT, batch_id TEXT, payload TEXT, due_at TEXT, created_at TEXT NOT NULL, finished_at TEXT);
             PRAGMA user_version=78;
             INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
             INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at) VALUES ('pr','p','P','P','/x','/s','/w','1');
             INSERT INTO automations VALUES ('a1','pr','Nightly',1,'{\"kind\":\"interval\",\"every_minutes\":60}','{\"kind\":\"create_task\",\"title\":\"x\"}',
               'tok','sec','2026-01-01T00:00:00.000Z','2025-12-31T23:00:00.000Z','2025-01-01','2025-01-02');
             INSERT INTO automation_runs (id,automation_id,source,status,detail,task_id,count,payload,created_at,finished_at)
               VALUES ('r1','a1','schedule','ok','fine','t1',2,'{}','2025-12-31T23:00:00.000Z','2025-12-31T23:00:01.000Z');",
        )
        .unwrap();
    }
    let c = crate::db::open(&path).unwrap();
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), crate::db::VERSION);
    let a = get(&c, "a1").unwrap().unwrap();
    assert_eq!((a.profile_id.as_str(), a.project_id.as_deref(), a.name.as_str(), a.enabled), ("p", Some("pr"), "Nightly", true));
    assert_eq!((a.token.as_str(), a.secret.as_deref()), ("tok", Some("sec")));
    assert_eq!((a.next_run_at.as_deref(), a.last_run_at.as_deref()), (Some("2026-01-01T00:00:00.000Z"), Some("2025-12-31T23:00:00.000Z")));
    assert_eq!((a.created_at.as_str(), a.updated_at.as_str()), ("2025-01-01", "2025-01-02"));
    assert_eq!((a.trigger, a.active_hours, a.precheck, a.budget_usd), (Trigger::Interval { every_minutes: 60 }, None, None, None));
    let r = runs(&c, "a1", 10).unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!((r[0].id.as_str(), r[0].status.as_str(), r[0].detail.as_deref(), r[0].task_id.as_deref(), r[0].count), ("r1", "ok", Some("fine"), Some("t1"), 2));
    assert_eq!((r[0].outcome.as_deref(), r[0].cost_usd), (None, None));
    // Its project's no longer required, and the runs still go with their automation.
    c.execute("INSERT INTO automations (id,profile_id,name,trigger,action,token,created_at,updated_at) VALUES ('a2','p','R','{}','{}','t','1','1')", []).unwrap();
    c.execute("DELETE FROM automations WHERE id='a1'", []).unwrap();
    assert!(runs(&c, "a1", 10).unwrap().is_empty());
    assert_eq!(c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn a_fresh_run_that_cant_start_leaves_no_thread() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let a = routine(&s, &p.id, json!({"name": "Inbox", "trigger": {"kind": "interval", "every_minutes": 60}, "action": {"kind": "message_assistant", "message": "x"}})).unwrap();
        // Tests can't run agents, as a host without them can't.
        let r = run_handler(State(s.clone()), Path(a.id.clone()), None).await.unwrap().0;
        assert_eq!((r["status"].as_str(), r["task_id"].as_str()), (Some("failed"), None), "{r}");
        assert!(r["detail"].as_str().unwrap().contains("can't run agents"), "{r}");
        assert_eq!(s.db().query_row("SELECT COUNT(*) FROM tasks WHERE task_type='routine'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    })
}

#[test]
fn deleting_the_assistant_stops_its_routine_threads_first() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        let t = db::insert_routine_task(&s.db(), &assistant, "w").unwrap();
        busy(&s, &t.id);
        api::delete_task_inner(&s, &assistant, false).await.unwrap();
        assert!(db::get_task(&s.db(), &t.id).unwrap().is_none());
        // Its agent was stopped, not left running for a thread that's gone.
        assert!(!s.is_running(&t.id));
    })
}

/// Makes `task_id` look as if its agent were running a run (`run`) that takes messages as it works.
fn steerable_run(s: &Shared, task_id: &str) -> crate::db::Run {
    let run = db::insert_run(&s.db(), task_id, "prompt").unwrap();
    s.db().execute("UPDATE runs SET status='running' WHERE id=?1", [&run.id]).unwrap();
    let dir = crate::agent::runs::run_dir(s, &run.id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("out.jsonl"), "").unwrap();
    std::fs::write(dir.join("input.jsonl"), "").unwrap();
    s.runs.lock().unwrap().insert(task_id.to_string(), crate::state::RunHandle { run_id: run.id.clone(), cancel: None });
    s.update_task(task_id, &[("running", json!(true))]).unwrap();
    run
}

#[test]
fn a_thread_mode_routines_runs_are_charged_what_the_assistants_run_cost() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        let a = routine(
            &s,
            &p.id,
            json!({"name": "Ping", "trigger": {"kind": "interval", "every_minutes": 60}, "budget_usd": 1.0,
                   "action": {"kind": "message_assistant", "mode": "thread", "message": "ping"}}),
        )
        .unwrap();
        // Steered into the assistant's run that's going: that run is the routine run's.
        let run = steerable_run(&s, &assistant.id);
        let now = Utc::now();
        set_next(&s, &a, now - chrono::TimeDelta::seconds(1));
        tick(&s, now).await;
        let r = last_run(&s, &a);
        assert_eq!((r.status.as_str(), r.task_id.as_deref()), ("ok", Some(assistant.id.as_str())));
        let linked = |id: &str| s.db().query_row("SELECT agent_run_id FROM automation_runs WHERE id=?1", [id], |r| r.get::<_, Option<String>>(0)).unwrap();
        assert_eq!(linked(&r.id).as_deref(), Some(run.id.as_str()));
        // While it works, what it's cost so far counts (and not the assistant's earlier runs).
        s.db().execute("UPDATE tasks SET cost_usd=50 WHERE id=?1", [&assistant.id]).unwrap();
        s.db().execute("UPDATE runs SET cost_usd=0.4 WHERE id=?1", [&run.id]).unwrap();
        assert!((routines::spent_today(&s.db(), &a.id, now, &Local).unwrap() - 0.4).abs() < 1e-9);
        // It ends having cost $1.50, which the routine's run records.
        s.db().execute("UPDATE runs SET cost_usd=1.5 WHERE id=?1", [&run.id]).unwrap();
        crate::agent::runner::finish(&s, &run.id, RunOutcome::Ok);
        assert_eq!(get_run(&s.db(), &r.id).unwrap().unwrap().cost_usd, Some(1.5));
        let listed = list_routines_handler(State(s.clone()), Path(p.id.clone())).await.unwrap().0;
        assert_eq!(listed["automations"][0]["cost_today_usd"], json!(1.5));
        // So the next scheduled run is over budget.
        set_next(&s, &a, now - chrono::TimeDelta::seconds(1));
        tick(&s, now).await;
        let r = last_run(&s, &a);
        assert_eq!(r.status, "skipped");
        assert!(r.detail.as_deref().unwrap().starts_with("Skipped: over budget"), "{:?}", r.detail);

        // Queued behind a run that doesn't take messages, it's the next run's.
        let b = routine(&s, &p.id, json!({"name": "Queued", "trigger": {"kind": "interval", "every_minutes": 60}, "action": {"kind": "message_assistant", "mode": "thread", "message": "q"}}))
            .unwrap();
        busy(&s, &assistant.id);
        let q = run_handler(State(s.clone()), Path(b.id.clone()), None).await.unwrap().0;
        let q = q["id"].as_str().unwrap().to_string();
        assert_eq!(linked(&q).as_deref(), Some("next"));
        let next = db::insert_run(&s.db(), &assistant.id, "prompt").unwrap();
        routines::claim_next(&s.db(), &assistant.id, &next.id).unwrap();
        assert_eq!(linked(&q).as_deref(), Some(next.id.as_str()));
        s.db().execute("UPDATE runs SET cost_usd=0.25 WHERE id=?1", [&next.id]).unwrap();
        routines::assistant_run_ended(&s, &next.id);
        assert_eq!(get_run(&s.db(), &q).unwrap().unwrap().cost_usd, Some(0.25));
    })
}

#[test]
fn a_fresh_run_that_ends_before_its_send_returns_still_records_how_it_went() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let a = routine(&s, &p.id, json!({"name": "Fast", "trigger": {"kind": "interval", "every_minutes": 60}, "action": {"kind": "message_assistant", "message": "x"}})).unwrap();
        // The thread's run ends (on another worker, say) before the send that started it has returned.
        let s2 = s.clone();
        testing::when("routine:thread", move || {
            let id: String = s2.db().query_row("SELECT id FROM tasks WHERE task_type='routine'", [], |r| r.get(0)).unwrap();
            busy(&s2, &id);
            said(&s2, &id, "Done already.");
            let t = db::get_task(&s2.db(), &id).unwrap().unwrap();
            routines::finished(&s2, &t, &RunOutcome::Ok, None);
        });
        let r = run_handler(State(s.clone()), Path(a.id.clone()), None).await.unwrap().0;
        let r = get_run(&s.db(), r["id"].as_str().unwrap()).unwrap().unwrap();
        assert_eq!((r.status.as_str(), r.outcome.as_deref()), ("ok", Some("reported")));
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        assert_eq!(reports(&s, &assistant.id)[0]["automation_id"], json!(a.id));
    })
}

#[test]
fn a_routine_thread_waiting_on_its_usage_limit_holds_back_the_next_run() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        let a = routine(&s, &p.id, json!({"name": "Inbox", "trigger": {"kind": "interval", "every_minutes": 60}, "action": {"kind": "message_assistant", "message": "x"}})).unwrap();
        let t = db::insert_routine_task(&s.db(), &assistant, "w").unwrap();
        s.db().execute("UPDATE tasks SET waiting=1, running=0 WHERE id=?1", [&t.id]).unwrap();
        let mut r = Run::new(&a.id, "schedule", "ok", Utc::now());
        r.task_id = Some(t.id.clone());
        insert_run(&s.db(), &r).unwrap();
        set_next(&s, &a, Utc::now() - chrono::TimeDelta::seconds(1));
        tick(&s, Utc::now()).await;
        let r = last_run(&s, &a);
        assert_eq!((r.status.as_str(), r.detail), ("skipped", Some(format!("Skipped: its last run (A-{}) is still going", t.number))));
    })
}

#[test]
fn no_routine_thread_is_made_under_an_assistant_being_deleted() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        let a = routine(&s, &p.id, json!({"name": "Inbox", "trigger": {"kind": "interval", "every_minutes": 60}, "action": {"kind": "message_assistant", "message": "x"}})).unwrap();
        let deleting = api::Deleting::new(&s, &assistant.id);
        let r = run_handler(State(s.clone()), Path(a.id.clone()), None).await.unwrap().0;
        assert_eq!(r["status"], "failed");
        assert!(r["detail"].as_str().unwrap().contains("being deleted"), "{r}");
        assert_eq!(s.db().query_row("SELECT COUNT(*) FROM tasks WHERE task_type='routine'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        drop(deleting);
    })
}

#[test]
fn reports_stay_unread_until_the_assistant_has_started_with_them() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let assistant = assistant::get_or_create(&s, &p.id).unwrap();
        s.add_message(&assistant.id, "report", json!({"automation": "Inbox", "key": "A-2", "outcome": "reported", "text": "New mail."})).unwrap();
        // A launch that fails before the agent starts reads them again next time.
        let (text, ids) = routines::unread_reports(&s, &assistant.id).unwrap();
        assert!(text.contains("New mail."));
        assert_eq!(routines::unread_reports(&s, &assistant.id).unwrap().1, ids);
        routines::mark_read(&s, &ids);
        assert_eq!(routines::unread_reports(&s, &assistant.id), None);
    })
}

#[test]
fn a_day_field_that_starts_with_a_star_is_unrestricted() {
    // 2026-09-28 is a Monday: `*/2` doesn't make every other day a match beside Mondays.
    let next = |e: &str, after: DateTime<Utc>| next_after(&cron(e), after, &Nz).unwrap();
    assert_eq!(next("0 9 */2 * mon", nz("2026-09-25 10:00")), nz("2026-09-28 09:00"));
    assert_eq!(next("0 9 1 * */2", nz("2026-09-25 10:00")), nz("2026-10-01 09:00"));
}

#[test]
fn a_routine_thread_has_its_assistants_workspace_and_memory() {
    testing::run(async || {
        let s = testing::state();
        let p = profile(&s);
        let a = assistant::get_or_create(&s, &p.id).unwrap();
        let t = db::insert_routine_task(&s.db(), &a, "Inbox").unwrap();
        assert_eq!(assistant::whose_workspace(&t, Some(&a)).unwrap().map(|x| x.id), Some(a.id.clone()));
        assert_eq!(assistant::whose_workspace(&a, None).unwrap().map(|x| x.id), Some(a.id.clone()));
        // So its run is told the assistant's memory, as the assistant's are.
        let told = crate::agent::assistant::memory::for_run(&s, &assistant::whose_workspace(&t, Some(&a)).unwrap().unwrap()).await;
        assert!(told.contains("memory"), "{told}");
        // Without its assistant, or in another folder, it doesn't run.
        assert!(assistant::whose_workspace(&t, None).is_err());
        let moved = db::Task { work_dir: Some("elsewhere".into()), ..t.clone() };
        assert!(assistant::whose_workspace(&moved, Some(&a)).is_err());
        let other = db::Task { task_type: None, ..t };
        assert!(assistant::whose_workspace(&other, None).unwrap().is_none());
    })
}
