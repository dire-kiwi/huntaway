use std::os::unix::fs::PermissionsExt;

use axum::Router;
use axum::http::Request;
use base64::Engine;
use tower::ServiceExt;

use super::consent::{self, Callback};
use super::*;
use crate::db::insert_profile;
use crate::testing::{self, state};

async fn call(app: &Router, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let req = Request::builder().method(method).uri(path).header("authorization", "Bearer ").header("content-type", "application/json");
    let req = req.body(axum::body::Body::from(body.map(|b| b.to_string()).unwrap_or_default())).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 22).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into())))
}

fn chmod(p: &Path, mode: u32) {
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// A Google server whose files are in `dir` (not the home folder), run by a program that's there.
fn test_config(dir: &Path, email: Option<&str>) -> Value {
    let bin = dir.join("uvx");
    std::fs::write(&bin, "#!/bin/sh\n").unwrap();
    chmod(&bin, 0o755);
    let mut c = server_config(email);
    c["command"] = json!(path_str(&bin));
    c["env"][CLIENT_SECRET_ENV] = json!(path_str(&dir.join("client_secret.json")));
    c["env"][CREDENTIALS_ENV] = json!(path_str(&dir.join("credentials")));
    c
}

const CLIENT: &str = r#"{"installed": {"client_id": "id.apps.googleusercontent.com", "client_secret": "shh", "redirect_uris": ["http://localhost"]}}"#;

fn creds(refresh: Option<&str>, scopes: &[&str]) -> String {
    json!({"token": "at", "refresh_token": refresh, "token_uri": "https://oauth2.googleapis.com/token", "client_id": "id", "client_secret": "shh", "scopes": scopes, "expiry": null})
        .to_string()
}

#[test]
fn credentials_files_are_named_as_workspace_mcp_names_them() {
    assert_eq!(credentials_file("sam@example.com"), "sam@example.com.json");
    assert_eq!(credentials_file("sam+news@example.com"), "sam%2Bnews@example.com.json");
    assert_eq!(account_of("sam%2Bnews@example.com.json").as_deref(), Some("sam+news@example.com"));
    assert_eq!(account_of("sam@example.com.json").as_deref(), Some("sam@example.com"));
    // Its other files aren't accounts.
    assert_eq!(account_of("oauth_states.json"), None);
    assert_eq!(account_of("notes.txt"), None);
    assert_eq!(account_of("a%2@b.json").as_deref(), Some("a%2@b"));
}

#[test]
fn the_server_runs_workspace_mcp_pinned_with_gmail_calendar_and_drive() {
    let c = server_config(Some("sam@example.com"));
    assert_eq!(c["type"], "stdio");
    assert_eq!(c["command"], "uvx");
    assert_eq!(c["args"], json!(["workspace-mcp@2.3.0", "--single-user", "--tools", "gmail", "calendar", "drive", "--tool-tier", "extended"]));
    assert_eq!(c["env"][EMAIL_ENV], "sam@example.com");
    // Absolute paths, as an MCP config doesn't expand ~.
    for k in [CLIENT_SECRET_ENV, CREDENTIALS_ENV] {
        assert!(Path::new(c["env"][k].as_str().unwrap()).is_absolute(), "{k}");
    }
    assert!(server_config(None)["env"].get(EMAIL_ENV).is_none());
}

#[test]
fn the_card_says_what_is_missing_until_google_is_connected() {
    testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let url = format!("/api/profiles/{}/assistant/google", p.id);
        let problem = |v: &Value| v["problem"].as_str().unwrap_or("").to_string();
        // No server yet.
        let (st, v) = call(&app, "GET", &url, None).await;
        assert_eq!(st, 200, "{v}");
        assert_eq!((v["connected"].as_bool(), v["server"].is_null()), (Some(false), true));
        assert!(problem(&v).contains("no Google server"), "{v}");
        assert!(status_line(&s, &p.id).starts_with("not connected: There's no Google server"), "{}", status_line(&s, &p.id));
        // Adding it makes the server and switches it on for the profile.
        let (st, v) = call(&app, "POST", &url, None).await;
        assert_eq!(st, 200, "{v}");
        let server = agent_tools::global_mcp_server(&s.db(), SERVER).unwrap().unwrap();
        assert_eq!(server.config["args"][0], PACKAGE);
        assert_eq!(agent_tools::profile_switch(&s.db(), &p.id, &server.id).unwrap(), Some(true));
        assert_eq!(v["server"]["on"], true);
        // Once more keeps it as it is (here, pointed at a folder of the test's own).
        let dir = testing::temp_dir();
        s.db().execute("UPDATE agent_mcp_servers SET config=?1 WHERE id=?2", rusqlite::params![test_config(&dir, None).to_string(), server.id]).unwrap();
        let (_, v) = call(&app, "POST", &url, None).await;
        assert_eq!(agent_tools::global_mcp_server(&s.db(), SERVER).unwrap().unwrap().config, test_config(&dir, None));
        assert!(problem(&v).contains("no OAuth client"), "{v}");
        // Switched off for the profile.
        agent_tools::set_profile_switch(&s.db(), &p.id, &server.id, false).unwrap();
        assert!(status(&s, &p.id).unwrap().problem.unwrap().contains("isn't switched on for this profile"));
        agent_tools::set_profile_switch(&s.db(), &p.id, &server.id, true).unwrap();
        // The client's there; no one's signed in.
        std::fs::write(dir.join("client_secret.json"), CLIENT).unwrap();
        chmod(&dir.join("client_secret.json"), 0o600);
        let st = status(&s, &p.id).unwrap();
        assert!(st.problem.as_deref().unwrap().contains("Not signed in to Google yet: run huntaway google-auth --client-secret"), "{st:?}");
        assert!(st.consent_command.contains(&path_str(&dir.join("client_secret.json"))));
        // Signed in without a refresh token.
        let cdir = dir.join("credentials");
        std::fs::create_dir(&cdir).unwrap();
        let file = cdir.join("sam@example.com.json");
        std::fs::write(&file, creds(None, SCOPES)).unwrap();
        chmod(&file, 0o600);
        assert!(status(&s, &p.id).unwrap().problem.unwrap().contains("no refresh token"));
        // With one: connected, but its file is readable by others, and it was given less than the brief reads.
        std::fs::write(&file, creds(Some("rt"), &["openid", "https://www.googleapis.com/auth/calendar"])).unwrap();
        chmod(&file, 0o644);
        let (_, v) = call(&app, "GET", &url, None).await;
        assert_eq!((v["connected"].as_bool(), v["account"].as_str()), (Some(true), Some("sam@example.com")), "{v}");
        let warnings = v["warnings"].to_string();
        assert!(warnings.contains("chmod 600") && warnings.contains("gmail.readonly") && warnings.contains("drive.readonly") && !warnings.contains("calendar.readonly"), "{warnings}");
        assert_eq!(status_line(&s, &p.id), "connected as sam@example.com");
        chmod(&file, 0o600);
        std::fs::write(&file, creds(Some("rt"), SCOPES)).unwrap();
        assert!(status(&s, &p.id).unwrap().warnings.is_empty());
        // A second account: the server has to be told which.
        let other = cdir.join("kim@example.com.json");
        std::fs::write(&other, creds(Some("rt"), SCOPES)).unwrap();
        chmod(&other, 0o600);
        assert!(status(&s, &p.id).unwrap().warnings[0].contains(EMAIL_ENV));
        // Told one it has no credentials for.
        s.db().execute("UPDATE agent_mcp_servers SET config=?1 WHERE id=?2", rusqlite::params![test_config(&dir, Some("lee@example.com")).to_string(), server.id]).unwrap();
        assert!(status(&s, &p.id).unwrap().problem.unwrap().contains("no credentials for lee@example.com"));
        s.db().execute("UPDATE agent_mcp_servers SET config=?1 WHERE id=?2", rusqlite::params![test_config(&dir, Some("kim@example.com")).to_string(), server.id]).unwrap();
        assert_eq!(status(&s, &p.id).unwrap().account.as_deref(), Some("kim@example.com"));
        // A program that isn't there.
        let mut c = test_config(&dir, None);
        c["command"] = json!("no-such-uvx-here");
        s.db().execute("UPDATE agent_mcp_servers SET config=?1 WHERE id=?2", rusqlite::params![c.to_string(), server.id]).unwrap();
        assert!(status(&s, &p.id).unwrap().problem.unwrap().contains("no-such-uvx-here isn't on this host's PATH"));
    })
}

#[test]
fn a_profile_whose_assistant_is_elsewhere_has_its_google_there() {
    testing::run(async || {
        let s = state();
        let app = crate::api::router(s.clone());
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        s.db().execute("UPDATE profiles SET assistant_host='elsewhere' WHERE id=?1", [&p.id]).unwrap();
        let url = format!("/api/profiles/{}/assistant/google", p.id);
        assert_eq!(call(&app, "GET", &url, None).await.0, 409);
        assert_eq!(call(&app, "POST", &url, None).await.0, 409);
        // Nothing was added here.
        assert!(agent_tools::global_mcp_server(&s.db(), SERVER).unwrap().is_none());
        assert_eq!(call(&app, "GET", "/api/profiles/nope/assistant/google", None).await.0, 404);
    })
}

#[test]
fn only_the_assistant_gets_the_google_server_not_the_profiles_projects() {
    testing::run(async || {
        let s = state();
        let p = insert_profile(&s.db(), "personal", &[], None).unwrap();
        let np = crate::db::NewProject {
            id: "pr", profile_id: &p.id, name: "Site", key: "SIT", repo_path: "/main", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: true,
        };
        let project = crate::db::insert_project(&s.db(), np).unwrap();
        let dir = testing::temp_dir();
        let google = agent_tools::add_global_mcp_server(&s.db(), SERVER, test_config(&dir, None)).unwrap();
        let other = agent_tools::add_global_mcp_server(&s.db(), "notes", json!({"command": "notes-mcp"})).unwrap();
        for id in [&google.id, &other.id] {
            agent_tools::set_profile_switch(&s.db(), &p.id, id, true).unwrap();
        }
        // The project's switch on too: still not.
        s.db()
            .execute("INSERT INTO agent_tool_switches (scope, scope_id, item_id, enabled) VALUES ('project',?1,?2,1)", [&project.id, &google.id])
            .unwrap();
        let tools = agent_tools::for_preview(&s, &project.id).unwrap();
        assert!(tools.mcp_servers.contains_key("notes") && !tools.mcp_servers.contains_key(SERVER), "{:?}", tools.mcp_servers.keys());
        let assistant = super::super::get_or_create(&s, &p.id).unwrap();
        let tools = agent_tools::for_task_run(&s, &assistant, None).unwrap();
        assert!(tools.mcp_servers.contains_key(SERVER) && tools.mcp_servers.contains_key("notes"), "{:?}", tools.mcp_servers.keys());
        // Codex gets it too, given longer to start.
        let codex = crate::agent::codex::mcp_server_config(SERVER, &tools.mcp_servers[SERVER], false, &[], false).unwrap();
        assert_eq!((codex["command"].as_str(), codex["startup_timeout_sec"].as_i64()), (Some(path_str(&dir.join("uvx")).as_str()), Some(120)));
        assert_eq!(codex["env"][CREDENTIALS_ENV], json!(path_str(&dir.join("credentials"))));
    })
}

// ---------- consent ----------

#[test]
fn the_client_file_is_read_as_google_cloud_downloads_it() {
    let c = consent::read_client(CLIENT).unwrap();
    assert_eq!((c.client_id.as_str(), c.client_secret.as_str(), c.web), ("id.apps.googleusercontent.com", "shh", false));
    assert_eq!((c.auth_uri.as_str(), c.token_uri.as_str()), ("https://accounts.google.com/o/oauth2/auth", "https://oauth2.googleapis.com/token"));
    let web = consent::read_client(r#"{"web": {"client_id": "w", "client_secret": "s", "token_uri": "http://127.0.0.1:1/token"}}"#).unwrap();
    assert!(web.web && web.token_uri == "http://127.0.0.1:1/token");
    for bad in ["nope", "{}", r#"{"installed": {"client_id": "x"}}"#, r#"{"installed": {"client_secret": "x"}}"#] {
        assert!(consent::read_client(bad).is_err(), "{bad}");
    }
}

#[test]
fn the_consent_url_asks_for_offline_access_with_pkce() {
    let c = consent::read_client(CLIENT).unwrap();
    let url = consent::consent_url(&c, "http://127.0.0.1:8765/", "st", "verifier");
    let (base, q) = url.split_once('?').unwrap();
    assert_eq!(base, "https://accounts.google.com/o/oauth2/auth");
    let q: Vec<(String, String)> = serde_urlencoded::from_str(q).unwrap();
    let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap_or("");
    assert_eq!(get("redirect_uri"), "http://127.0.0.1:8765/");
    assert_eq!((get("access_type"), get("prompt"), get("response_type"), get("state")), ("offline", "consent", "code", "st"));
    assert_eq!(get("code_challenge_method"), "S256");
    // RFC 7636's example.
    assert_eq!(consent::challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert_eq!(get("code_challenge"), consent::challenge("verifier"));
    assert_eq!(get("scope").split(' ').collect::<Vec<_>>(), SCOPES);
}

#[test]
fn only_the_flows_own_redirect_is_taken() {
    assert_eq!(consent::read_callback("GET /?state=st&code=4%2Fabc&scope=x HTTP/1.1", "st"), Callback::Code("4/abc".into()));
    assert_eq!(consent::read_callback("GET /?state=st&error=access_denied HTTP/1.1", "st"), Callback::Denied("access_denied".into()));
    // Another flow's state, a favicon, a POST, nothing.
    for line in ["GET /?state=other&code=abc HTTP/1.1", "GET /favicon.ico HTTP/1.1", "POST /?state=st&code=abc HTTP/1.1", "GET /?code=abc HTTP/1.1", ""] {
        assert_eq!(consent::read_callback(line, "st"), Callback::Other, "{line}");
    }
}

fn id_token(email: &str) -> String {
    let b = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    format!("{}.{}.sig", b.encode(r#"{"alg":"RS256"}"#), b.encode(json!({"email": email, "sub": "1"}).to_string()))
}

#[test]
fn credentials_are_written_as_workspace_mcp_reads_them_for_its_user_alone() {
    let c = consent::read_client(CLIENT).unwrap();
    let now = chrono::DateTime::parse_from_rfc3339("2026-11-04T07:00:00Z").unwrap().with_timezone(&chrono::Utc);
    let token = json!({"access_token": "at", "expires_in": 3599, "refresh_token": "rt", "scope": "openid https://www.googleapis.com/auth/gmail.readonly", "id_token": id_token("sam@example.com")});
    let (email, v) = consent::credentials_json(&c, &token, now).unwrap();
    assert_eq!(email, "sam@example.com");
    assert_eq!(
        v,
        json!({"token": "at", "refresh_token": "rt", "token_uri": "https://oauth2.googleapis.com/token", "client_id": "id.apps.googleusercontent.com",
               "client_secret": "shh", "scopes": ["openid", "https://www.googleapis.com/auth/gmail.readonly"], "expiry": "2026-11-04T07:59:59"})
    );
    // Without a refresh token it's no use to a server that runs for longer than an hour.
    let mut no_refresh = token.clone();
    no_refresh.as_object_mut().unwrap().remove("refresh_token");
    assert!(consent::credentials_json(&c, &no_refresh, now).unwrap_err().to_string().contains("no refresh token"));
    let dir = testing::temp_dir();
    let file = dir.join("new").join("credentials").join("sam@example.com.json");
    consent::write_private(&file, "{}").unwrap();
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    // Written over, it stays private, and nothing's left beside it.
    chmod(&file, 0o644);
    consent::write_private(&file, "{\"a\":1}").unwrap();
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
}

/// A token endpoint like Google's: it takes `code` for the flow's tokens (checking the PKCE verifier against what the
/// browser was sent with) and the refresh token `rt`.
async fn fake_google() -> (String, tokio::sync::mpsc::UnboundedReceiver<Vec<(String, String)>>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route(
        "/token",
        axum::routing::post(move |body: String| {
            let tx = tx.clone();
            async move {
                let form: Vec<(String, String)> = serde_urlencoded::from_str(&body).unwrap();
                let get = |k: &str| form.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default();
                let ok = match get("grant_type").as_str() {
                    "authorization_code" => get("code") == "the-code" && !get("code_verifier").is_empty(),
                    "refresh_token" => get("refresh_token") == "rt",
                    _ => false,
                };
                let _ = tx.send(form);
                if !ok {
                    return (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({"error": "invalid_grant", "error_description": "Token has been expired or revoked."})));
                }
                let scope = SCOPES.iter().filter(|s| !s.contains("drive")).copied().collect::<Vec<_>>().join(" ");
                (
                    axum::http::StatusCode::OK,
                    axum::Json(json!({"access_token": "at", "expires_in": 3599, "refresh_token": "rt", "scope": scope, "id_token": id_token("sam@example.com")})),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/token", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, rx)
}

#[test]
fn signing_in_takes_the_browsers_code_to_googles_token_endpoint_and_keeps_the_tokens() {
    testing::run(async || {
        let (token_uri, mut seen) = fake_google().await;
        let c = consent::read_client(&json!({"installed": {"client_id": "id", "client_secret": "shh", "token_uri": token_uri}}).to_string()).unwrap();
        let dir = testing::temp_dir().join("credentials");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let flow = consent::sign_in(&c, &dir, listener, |url, redirect| tx.send((url.to_string(), redirect.to_string())).unwrap());
        let browser = async {
            // The URL, as the user would read it.
            let (url, redirect) = rx.await.unwrap();
            let q: Vec<(String, String)> = serde_urlencoded::from_str(url.split_once('?').unwrap().1).unwrap();
            let state = q.iter().find(|(k, _)| k == "state").unwrap().1.clone();
            let client = reqwest::Client::new();
            // A stray request first, then another flow's answer: neither ends it.
            assert_eq!(client.get(format!("{redirect}favicon.ico")).send().await.unwrap().status(), 404);
            assert_eq!(client.get(format!("{redirect}?state=nope&code=the-code")).send().await.unwrap().status(), 404);
            let page = client.get(format!("{redirect}?state={state}&code=the-code")).send().await.unwrap().text().await.unwrap();
            assert!(page.contains("Signed in"), "{page}");
        };
        let (signed_in, ()) = tokio::join!(flow, browser);
        let signed_in = signed_in.unwrap();
        assert_eq!(signed_in.email, "sam@example.com");
        assert_eq!(signed_in.file, dir.join("sam@example.com.json"));
        // Drive was left unticked.
        assert!(signed_in.missing.iter().all(|s| s.contains("drive")) && signed_in.missing.len() == 3, "{:?}", signed_in.missing);
        let form = seen.recv().await.unwrap();
        let get = |k: &str| form.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str()).unwrap_or("");
        assert!(get("redirect_uri").starts_with("http://127.0.0.1:") && get("client_secret") == "shh", "{form:?}");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&signed_in.file).unwrap()).unwrap();
        assert_eq!((v["refresh_token"].as_str(), v["token_uri"].as_str()), (Some("rt"), Some(token_uri.as_str())));
        assert_eq!(std::fs::metadata(&signed_in.file).unwrap().permissions().mode() & 0o777, 0o600);
        // The card's check uses the refresh token once: it works, then it's been revoked.
        consent::verify(&signed_in.file, None).await.unwrap();
        std::fs::write(&signed_in.file, v.to_string().replace("\"rt\"", "\"revoked\"")).unwrap();
        let err = format!("{:#}", consent::verify(&signed_in.file, None).await.unwrap_err());
        assert!(err.contains("sign in again") && err.contains("invalid_grant"), "{err}");
    })
}

#[test]
fn a_denied_consent_ends_the_flow_and_says_so() {
    testing::run(async || {
        let c = consent::read_client(CLIENT).unwrap();
        let dir = testing::temp_dir();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let flow = consent::sign_in(&c, &dir, listener, |url, redirect| tx.send((url.to_string(), redirect.to_string())).unwrap());
        let browser = async {
            let (url, redirect) = rx.await.unwrap();
            let state = url.split("state=").nth(1).unwrap().split('&').next().unwrap().to_string();
            reqwest::get(format!("{redirect}?state={state}&error=access_denied")).await.unwrap();
        };
        let (r, ()) = tokio::join!(flow, browser);
        assert!(r.unwrap_err().to_string().contains("access_denied"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    })
}
