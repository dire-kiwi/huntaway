//! Provision only our named tunnels and DNS records. Application traffic goes through Cloudflare,
//! not this client. The API credential stays on the broker; hosts receive only a connector token.

use std::sync::Arc;
use std::time::Duration;
use anyhow::{Context, Result, bail};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use crate::proto::Tunnel;

#[derive(Clone)]
pub struct Cloudflare {
    account: String,
    zone: String,
    domain: String,
    token: String,
    api: String,
    client: Client,
    pub(crate) provisioning: Arc<tokio::sync::Mutex<()>>,
}

impl std::fmt::Debug for Cloudflare {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cloudflare").field("domain", &self.domain).finish_non_exhaustive()
    }
}

impl Cloudflare {
    pub fn new(account: String, zone: String, domain: String, token: String) -> Result<Self> {
        let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
        if ![&account, &zone].iter().all(|s| s.len() == 32 && s.bytes().all(|c| c.is_ascii_hexdigit())) {
            bail!("Cloudflare account and zone ids must each be 32 hexadecimal characters");
        }
        if domain.len() > 200 || !domain.contains('.') || !domain.split('.').all(|p| (1..=63).contains(&p.len())
            && !p.starts_with('-') && !p.ends_with('-') && p.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')) {
            bail!("the tunnel domain must be a DNS name, such as example.com");
        }
        if token.trim().is_empty() { bail!("the Cloudflare API token is empty"); }
        Ok(Self {
            account, zone, domain, token, api: "https://api.cloudflare.com/client/v4".into(),
            client: Client::builder().timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build()?,
            provisioning: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut req = self.client.request(method, format!("{}{path}", self.api)).bearer_auth(&self.token);
        if let Some(body) = body { req = req.json(&body); }
        let res = req.send().await.context("reaching the Cloudflare API")?;
        // Neither response bodies nor request Debug are errors: they can contain credentials.
        let status = res.status();
        if !status.is_success() { bail!("Cloudflare API returned HTTP {status}"); }
        let body: Value = res.json().await.context("reading the Cloudflare API response")?;
        if body["success"] != true { bail!("Cloudflare API refused the operation (check token permissions and tunnel/DNS configuration)"); }
        Ok(body["result"].clone())
    }

    /// Reconcile by a deterministic name so reconnects and broker restarts don't allocate more
    /// tunnels. The owner digest makes a name reused by a different host a different allocation.
    pub(crate) async fn provision(&self, name: &str, owner: &str, port: u16) -> Result<Tunnel> {
        let hostname = format!("{name}.{}", self.domain);
        let digest = crate::hex(crate::hash(&format!("{hostname}/{owner}")));
        let tunnel_name = format!("huntaway-{}", &digest[..40]);
        let root = format!("/accounts/{}/cfd_tunnel", self.account);
        let found = self.call(Method::GET, &format!("{root}?name={tunnel_name}&is_deleted=false"), None).await?;
        let found = found.as_array().context("Cloudflare returned no tunnel list")?;
        let tunnel = match found.iter().find(|t| t["name"] == tunnel_name && t["deleted_at"].is_null()) {
            Some(t) => t.clone(),
            None => self.call(Method::POST, &root, Some(json!({"name": tunnel_name, "config_src": "cloudflare"}))).await?,
        };
        let id = tunnel["id"].as_str().filter(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
            .context("Cloudflare returned an invalid tunnel id")?;
        let target = format!("{id}.cfargotunnel.com");
        let dns_root = format!("/zones/{}/dns_records", self.zone);
        let records = self.call(Method::GET, &format!("{dns_root}?name={hostname}"), None).await?;
        let records = records.as_array().context("Cloudflare returned no DNS record list")?;
        // Never repoint an existing hostname: it may belong to another service or an old owner.
        if records.iter().any(|r| r["type"] != "CNAME" || r["content"] != target || r["proxied"] != true) {
            bail!("{hostname} already has a DNS record that isn't this host's proxied tunnel; remove it or choose another --broker-name");
        }
        self.call(Method::PUT, &format!("{root}/{id}/configurations"), Some(json!({"config": {"ingress": [
            {"hostname": hostname, "service": format!("http://127.0.0.1:{port}")},
            {"service": "http_status:404"}
        ]}}))).await?;
        if records.is_empty() {
            self.call(Method::POST, &dns_root, Some(json!({"type": "CNAME", "name": hostname, "content": target, "proxied": true}))).await?;
        }
        let token = self.call(Method::GET, &format!("{root}/{id}/token"), None).await?;
        let token = token.as_str().filter(|s| !s.is_empty()).context("Cloudflare returned no connector token")?.to_string();
        Ok(Tunnel { url: format!("https://{hostname}"), token })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;
    use axum::{Router, Json, extract::{State, Request}, response::IntoResponse, http::StatusCode};

    #[derive(Default)]
    pub(crate) struct Fake {
        pub calls: Vec<(String, String, Value)>,
        pub tunnel: Option<Value>,
        pub dns: Vec<Value>,
        pub fail: Option<String>,
    }

    pub(crate) async fn fake() -> (Cloudflare, Arc<Mutex<Fake>>) {
        let state = Arc::new(Mutex::new(Fake::default()));
        let app = Router::new().fallback(|State(s): State<Arc<Mutex<Fake>>>, req: Request| async move {
            assert_eq!(req.headers()["authorization"], "Bearer api-secret");
            let method = req.method().to_string();
            let path = req.uri().path().to_string();
            let body = axum::body::to_bytes(req.into_body(), 1 << 20).await.unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let mut s = s.lock().unwrap();
            s.calls.push((method.clone(), path.clone(), body.clone()));
            if s.fail.as_deref() == Some(&path) {
                return (StatusCode::FORBIDDEN, "api-secret must never appear in errors").into_response();
            }
            let result = match (method.as_str(), path.rsplit('/').next().unwrap()) {
                ("GET", "cfd_tunnel") => json!(s.tunnel.iter().collect::<Vec<_>>()),
                ("POST", "cfd_tunnel") => {
                    let t = json!({"id": "12345678-abcd-abcd-abcd-123456789012", "name": body["name"], "config_src": "cloudflare"});
                    s.tunnel = Some(t.clone());
                    t
                }
                ("GET", "dns_records") => json!(s.dns),
                ("POST", "dns_records") => { s.dns.push(body.clone()); body },
                ("PUT", "configurations") => body,
                ("GET", "token") => json!("connector-secret"),
                _ => panic!("unexpected API call {method} {path}"),
            };
            Json(json!({"success": true, "result": result})).into_response()
        }).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut cf = Cloudflare::new("a".repeat(32), "b".repeat(32), "example.com".into(), "api-secret".into()).unwrap();
        cf.api = format!("http://{addr}");
        (cf, state)
    }

    #[test]
    fn provisions_and_reuses_tunnels_and_dns_after_a_partial_failure() {
        crate::tests::run(async {
            let (cf, state) = fake().await;
            let token_path = format!("/accounts/{}/cfd_tunnel/12345678-abcd-abcd-abcd-123456789012/token", "a".repeat(32));
            state.lock().unwrap().fail = Some(token_path);
            let err = cf.provision("desktop", "owner", 12345).await.unwrap_err().to_string();
            assert!(err.contains("403") && !err.contains("api-secret"));
            state.lock().unwrap().fail = None;
            let tunnel = cf.provision("desktop", "owner", 23456).await.unwrap();
            assert_eq!(tunnel.url, "https://desktop.example.com");
            assert_eq!(tunnel.token, "connector-secret");
            assert!(!format!("{tunnel:?} {cf:?}").contains("secret"));
            let state = state.lock().unwrap();
            assert_eq!(state.calls.iter().filter(|(m,p,_)| m == "POST" && p.ends_with("cfd_tunnel")).count(), 1);
            assert_eq!(state.calls.iter().filter(|(m,p,_)| m == "POST" && p.ends_with("dns_records")).count(), 1);
            let (_,_,config) = state.calls.iter().rev().find(|(m,_,_)| m == "PUT").unwrap();
            assert_eq!(config["config"]["ingress"][0]["service"], "http://127.0.0.1:23456");
            assert_eq!(config["config"]["ingress"][1]["service"], "http_status:404");
        });
    }

    #[test]
    fn refuses_to_repoint_existing_dns_records() {
        crate::tests::run(async {
            let (cf, state) = fake().await;
            state.lock().unwrap().dns.push(json!({"type": "CNAME", "content": "someone-else.example.com", "proxied": true}));
            assert!(cf.provision("desktop", "owner", 12345).await.unwrap_err().to_string().contains("already has a DNS record"));
            assert!(!state.lock().unwrap().calls.iter().any(|(m,p,_)| m == "PUT" || (m == "POST" && p.ends_with("dns_records"))));
        });
    }

    #[test]
    fn validates_configuration_before_making_requests() {
        for domain in ["", "localhost", "https://example.com", "x..example.com", "-bad.example.com", "x.example.com/path"] {
            assert!(Cloudflare::new("a".repeat(32), "b".repeat(32), domain.into(), "secret".into()).is_err());
        }
        assert!(Cloudflare::new("bad".into(), "b".repeat(32), "x.example.com".into(), "secret".into()).is_err());
    }
}
