use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

pub fn open(dir: PathBuf) -> Result<Db, String> {
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let conn = Connection::open(dir.join("zone.db")).map_err(|err| err.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|err| err.to_string())?;
    Ok(Db(Mutex::new(conn)))
}

pub fn load(db: &Db) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare("SELECT value FROM kv WHERE key = 'zone'")
        .map_err(|err| err.to_string())?;
    let mut rows = stmt.query([]).map_err(|err| err.to_string())?;
    if let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let value: String = row.get(0).map_err(|err| err.to_string())?;
        if value.trim().is_empty() {
            return Ok(None);
        }
        return Ok(Some(value));
    }
    Ok(None)
}

pub fn save(db: &Db, value: &str) -> Result<(), String> {
    let conn = db.0.lock().map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO kv (key, value) VALUES ('zone', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![value],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}
