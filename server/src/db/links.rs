//! Links to other hosts (see hub.rs).

use super::*;

// ---------- links (hub) ----------

/// Another host this node shows on its board. `outbound`: we connect to its URL with its
/// token. `inbound`: it dials us (we only remember it). `ssh`: we start it and tunnel to it
/// over SSH.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Link {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub url: Option<String>,
    #[serde(skip_serializing)]
    pub token: Option<String>,
    /// For `ssh` links: the target, as JSON.
    pub ssh: Option<String>,
    pub last_seen: Option<String>,
    pub created_at: String,
}

impl Link {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            name: r.get("name")?,
            mode: r.get("mode")?,
            url: r.get("url")?,
            token: r.get("token")?,
            ssh: r.get("ssh")?,
            last_seen: r.get("last_seen")?,
            created_at: r.get("created_at")?,
        })
    }
}

pub fn list_links(c: &Connection) -> Result<Vec<Link>> {
    let mut st = c.prepare("SELECT * FROM links ORDER BY name COLLATE NOCASE")?;
    let rows = st.query_map([], Link::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_link(c: &Connection, id: &str) -> Result<Option<Link>> {
    Ok(c.query_row("SELECT * FROM links WHERE id=?1", [id], Link::from_row).optional()?)
}

pub fn upsert_link(c: &Connection, id: &str, name: &str, mode: &str, url: Option<&str>, token: Option<&str>) -> Result<Link> {
    c.execute(
        "INSERT INTO links (id,name,mode,url,token,last_seen,created_at) VALUES (?1,?2,?3,?4,?5,?6,?6)
         ON CONFLICT(id) DO UPDATE SET name=?2, mode=?3, url=COALESCE(?4,url), token=COALESCE(?5,token), last_seen=?6",
        params![id, name, mode, url, token, now()],
    )?;
    Ok(get_link(c, id)?.unwrap())
}

/// Note a host that dialled in, keeping how a link we already have to it is made: a host we dial
/// (or reach over SSH) that also dials us is still dialled after a restart.
pub fn note_inbound_link(c: &Connection, id: &str, name: &str) -> Result<()> {
    c.execute(
        "INSERT INTO links (id,name,mode,last_seen,created_at) VALUES (?1,?2,'inbound',?3,?3)
         ON CONFLICT(id) DO UPDATE SET name=?2, last_seen=?3",
        params![id, name, now()],
    )?;
    Ok(())
}
