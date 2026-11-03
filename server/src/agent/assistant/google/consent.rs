//! `huntaway google-auth`: the Google consent step on a headless assistant host.
//!
//! It's Google's loopback flow for a Desktop app client, with PKCE: it listens on `127.0.0.1:<port>` (8765 by default) on
//! the host, and prints Google's consent URL, whose redirect is that address. With the port forwarded to the user's machine
//! (`ssh -L 8765:127.0.0.1:8765 <host>`), the browser there opens the URL, the user signs in and agrees, and Google sends
//! the browser back to the forwarded port with a code, which this exchanges for tokens. It writes them as workspace-mcp
//! keeps its credentials (`<credentials dir>/<email>.json`, readable by the host's user alone), so the Google server
//! (google.rs) uses them from its next start.

use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{SCOPES, credentials_file, default_client_secret, default_credentials_dir};

const AUTH_URI: &str = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
/// How long it waits for the browser to come back.
const WAIT: Duration = Duration::from_secs(15 * 60);

/// An OAuth client, from the JSON Google Cloud's console downloads for it.
#[derive(Debug, PartialEq)]
pub struct Client {
    pub client_id: String,
    pub client_secret: String,
    pub auth_uri: String,
    pub token_uri: String,
    /// A Web application client rather than a Desktop app one: it takes only the redirects registered for it.
    pub web: bool,
}

/// The client in a `client_secret.json` (`{"installed": {…}}` for a Desktop app client, `{"web": {…}}` for a Web one).
pub fn read_client(text: &str) -> Result<Client> {
    let v: Value = serde_json::from_str(text).context("the client secret file isn't JSON")?;
    let (c, web) = match (v.get("installed"), v.get("web")) {
        (Some(c), _) => (c, false),
        (None, Some(c)) => (c, true),
        _ => bail!("the client secret file has no \"installed\" (Desktop app) or \"web\" client in it"),
    };
    let field = |k: &str| c[k].as_str().map(str::trim).filter(|v| !v.is_empty()).map(String::from);
    Ok(Client {
        client_id: field("client_id").context("the client secret file has no client_id")?,
        client_secret: field("client_secret").context("the client secret file has no client_secret")?,
        auth_uri: field("auth_uri").unwrap_or_else(|| AUTH_URI.into()),
        token_uri: field("token_uri").unwrap_or_else(|| TOKEN_URI.into()),
        web,
    })
}

fn read_client_file(path: &Path) -> Result<Client> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading the OAuth client from {}", path.display()))?;
    read_client(&text).with_context(|| format!("in {}", path.display()))
}

/// A random URL-safe string of `bytes` random bytes.
fn random(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    aws_lc_rs::rand::fill(&mut b).expect("random bytes");
    B64.encode(b)
}

/// PKCE's S256 challenge for a verifier.
pub fn challenge(verifier: &str) -> String {
    B64.encode(aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, verifier.as_bytes()))
}

/// The consent URL: offline access (for a refresh token), and the consent screen every time, so Google gives a new one.
pub fn consent_url(c: &Client, redirect: &str, state: &str, verifier: &str) -> String {
    let q = serde_urlencoded::to_string([
        ("client_id", c.client_id.as_str()),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        ("scope", &SCOPES.join(" ")),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("include_granted_scopes", "true"),
        ("state", state),
        ("code_challenge", &challenge(verifier)),
        ("code_challenge_method", "S256"),
    ])
    .unwrap_or_default();
    format!("{}?{q}", c.auth_uri)
}

/// What the browser brought back to the redirect: the code, or Google's error.
#[derive(Debug, PartialEq)]
pub enum Callback {
    Code(String),
    Denied(String),
    /// Not the redirect (a favicon, say), or another flow's.
    Other,
}

/// Reads a request's first line (`GET /?state=…&code=… HTTP/1.1`) for the redirect's answer, if its state is `state`.
pub fn read_callback(request_line: &str, state: &str) -> Callback {
    let mut parts = request_line.split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else { return Callback::Other };
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/" {
        return Callback::Other;
    }
    let q: Vec<(String, String)> = serde_urlencoded::from_str(query).unwrap_or_default();
    let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    if get("state").as_deref() != Some(state) {
        return Callback::Other;
    }
    match (get("code"), get("error")) {
        (Some(code), _) if !code.is_empty() => Callback::Code(code),
        (_, Some(e)) => Callback::Denied(e),
        _ => Callback::Other,
    }
}

/// The account an ID token is for: its `email` claim. It came from Google's token endpoint over TLS, so it isn't checked
/// again here.
pub fn id_token_email(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = B64.decode(payload.trim_end_matches('=')).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v["email"].as_str().map(String::from)
}

/// Posts a form to the token endpoint, and gives its JSON answer or says why it failed.
async fn token_request(uri: &str, form: &[(&str, &str)]) -> Result<Value> {
    let body = serde_urlencoded::to_string(form)?;
    let res = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?
        .post(uri)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .with_context(|| format!("reaching {uri}"))?;
    let status = res.status();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let why = [v["error"].as_str(), v["error_description"].as_str()].into_iter().flatten().collect::<Vec<_>>().join(": ");
        bail!("Google said {status}{}", if why.is_empty() { String::new() } else { format!(" ({why})") });
    }
    Ok(v)
}

/// The credentials workspace-mcp reads (auth/credential_store.py): the tokens, the client, the scopes granted and when the
/// access token expires (a naive UTC time, as google-auth keeps it).
pub fn credentials_json(c: &Client, token: &Value, now: chrono::DateTime<chrono::Utc>) -> Result<(String, Value)> {
    let refresh = token["refresh_token"].as_str().filter(|t| !t.is_empty());
    let Some(refresh) = refresh else {
        bail!("Google gave no refresh token. Remove the app's access at https://myaccount.google.com/permissions and sign in again.");
    };
    let email = token["id_token"].as_str().and_then(id_token_email).context("Google didn't say which account this is (no email in its ID token)")?;
    let scopes: Vec<&str> = match token["scope"].as_str() {
        Some(s) => s.split_whitespace().collect(),
        None => SCOPES.to_vec(),
    };
    let expiry = token["expires_in"].as_i64().map(|s| (now + chrono::TimeDelta::seconds(s)).naive_utc().format("%Y-%m-%dT%H:%M:%S").to_string());
    Ok((
        email,
        json!({
            "token": token["access_token"],
            "refresh_token": refresh,
            "token_uri": c.token_uri,
            "client_id": c.client_id,
            "client_secret": c.client_secret,
            "scopes": scopes,
            "expiry": expiry,
        }),
    ))
}

/// Writes `content` to `path` readable by its owner alone, by way of a file beside it (so a reader never sees half of it),
/// in a folder made for the owner alone if it isn't there.
pub fn write_private(path: &Path, content: &str) -> Result<()> {
    let dir = path.parent().context("no folder")?;
    if !dir.exists() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).with_context(|| format!("making {}", dir.display()))?;
    }
    let tmp = dir.join(format!(".{}.tmp", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
    f.write_all(content.as_bytes())?;
    f.sync_all()?;
    drop(f);
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Waits on `listener` for the browser to come back from the consent screen with this flow's `state`, answering each request.
async fn wait_for_code(listener: tokio::net::TcpListener, state: &str) -> Result<String> {
    loop {
        let (mut sock, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = tokio::time::timeout(Duration::from_secs(10), sock.read(&mut buf)).await.unwrap_or(Ok(0)).unwrap_or(0);
        let text = String::from_utf8_lossy(&buf[..n]).into_owned();
        let line = text.lines().next().unwrap_or("");
        let (status, body, done) = match read_callback(line, state) {
            Callback::Code(code) => ("200 OK", "Signed in. You can close this tab and go back to the terminal.", Some(Ok(code))),
            Callback::Denied(e) => ("200 OK", "Google didn't sign you in. See the terminal.", Some(Err(anyhow!("Google said: {e}")))),
            Callback::Other => ("404 Not Found", "Not found.", None),
        };
        let page = format!("<!doctype html><meta charset=utf-8><title>Huntaway</title><p style=\"font:16px system-ui;margin:3em\">{body}</p>");
        let reply = format!("HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}", page.len());
        let _ = sock.write_all(reply.as_bytes()).await;
        let _ = sock.shutdown().await;
        if let Some(r) = done {
            return r;
        }
    }
}

/// `huntaway google-auth`: sign in to Google for the assistant's Google server (see the module's doc).
pub async fn run(client_secret: Option<PathBuf>, credentials_dir: Option<PathBuf>, port: u16) -> Result<()> {
    let secret_path = client_secret.unwrap_or_else(default_client_secret);
    let client = read_client_file(&secret_path)?;
    let creds_dir = credentials_dir.unwrap_or_else(default_credentials_dir);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| format!("listening on 127.0.0.1:{port} (pick another with --port, and forward that one)"))?;
    let port = listener.local_addr()?.port();
    let host = hostname();
    println!("Signing in to Google for the assistant's Google server, with the OAuth client in {}.", secret_path.display());
    let web = client.web;
    let signed_in = sign_in(&client, &creds_dir, listener, |url, redirect| {
        if web {
            println!("\nThat's a Web application client: Google sends the browser back only to its registered redirect URIs, so add {redirect} to them (or use a Desktop app client).");
        }
        println!("\n1. Forward this port from the machine your browser is on, if you haven't (in another terminal there):\n\n     ssh -N -L {port}:127.0.0.1:{port} {host}\n");
        println!("2. Open this in that browser, sign in and allow access:\n\n     {url}\n");
        println!("Waiting for Google to send the browser back to {redirect} (up to {} minutes)…", WAIT.as_secs() / 60);
    })
    .await?;
    println!("\nSigned in as {}. Its credentials are in {} (readable by you alone).", signed_in.email, signed_in.file.display());
    if !signed_in.missing.is_empty() {
        println!("Google didn't grant all it was asked for (some boxes were left unticked): {}. Run this again to give them.", signed_in.missing.join(", "));
    }
    println!("The assistant's Google card shows it as connected. The Google server picks it up from its next run.");
    Ok(())
}

/// Who `sign_in` signed in, where their credentials are, and the scopes Google didn't grant.
#[derive(Debug)]
pub struct SignedIn {
    pub email: String,
    pub file: PathBuf,
    pub missing: Vec<String>,
}

/// The flow itself: `show` is given the consent URL and the redirect, then it waits on `listener` for the browser, swaps
/// the code for tokens and writes them to `creds_dir`.
pub async fn sign_in(client: &Client, creds_dir: &Path, listener: tokio::net::TcpListener, show: impl FnOnce(&str, &str)) -> Result<SignedIn> {
    let redirect = format!("http://127.0.0.1:{}/", listener.local_addr()?.port());
    let (state, verifier) = (random(24), random(48));
    show(&consent_url(client, &redirect, &state, &verifier), &redirect);
    let code = tokio::time::timeout(WAIT, wait_for_code(listener, &state)).await.map_err(|_| anyhow!("gave up waiting for the browser"))??;
    let token = token_request(
        &client.token_uri,
        &[
            ("code", code.as_str()),
            ("client_id", &client.client_id),
            ("client_secret", &client.client_secret),
            ("redirect_uri", &redirect),
            ("grant_type", "authorization_code"),
            ("code_verifier", &verifier),
        ],
    )
    .await
    .context("exchanging Google's code for tokens")?;
    let (email, creds) = credentials_json(client, &token, chrono::Utc::now())?;
    let file = creds_dir.join(credentials_file(&email));
    write_private(&file, &serde_json::to_string_pretty(&creds)?)?;
    let granted: Vec<&str> = creds["scopes"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let missing = SCOPES.iter().filter(|s| !granted.contains(s)).map(|s| s.to_string()).collect();
    Ok(SignedIn { email, file, missing })
}

/// Checks that an account's refresh token still works, by using it once (the token it gets isn't kept).
pub async fn verify(credentials: &Path, client_secret: Option<&Path>) -> Result<()> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(credentials).with_context(|| format!("reading {}", credentials.display()))?)?;
    let refresh = v["refresh_token"].as_str().context("its credentials have no refresh token")?;
    let from_file = client_secret.and_then(|p| read_client_file(p).ok());
    let id = v["client_id"].as_str().map(String::from).or_else(|| from_file.as_ref().map(|c| c.client_id.clone())).context("no client id")?;
    let secret = v["client_secret"].as_str().map(String::from).or_else(|| from_file.as_ref().map(|c| c.client_secret.clone())).context("no client secret")?;
    let uri = v["token_uri"].as_str().unwrap_or(TOKEN_URI);
    token_request(uri, &[("refresh_token", refresh), ("client_id", &id), ("client_secret", &secret), ("grant_type", "refresh_token")])
        .await
        .context("Google turned its refresh token away: sign in again")?;
    Ok(())
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname").ok().map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).unwrap_or_else(|| "<this host>".into())
}
