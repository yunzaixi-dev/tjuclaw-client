//! Device-local SQLite store shared with the Web client's OPFS database: the
//! same `kv` schema, reached through four narrow commands. Values are opaque
//! strings (the client encrypts anything private before it gets here).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS kv (
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
) WITHOUT ROWID;
PRAGMA user_version = 1;
";
const MAX_NAME: usize = 256;
const MAX_VALUE: usize = 4 << 20;

pub struct Store(Mutex<Option<Connection>>);

impl Store {
    pub fn open(dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(dir)?;
        let connection = Connection::open(dir.join("tjuclaw.sqlite3"))?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self(Mutex::new(Some(connection))))
    }

    pub fn open_or_unavailable(dir: Option<&Path>) -> Self {
        dir.and_then(|dir| Self::open(dir).ok()).unwrap_or(Self(Mutex::new(None)))
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let guard = self.0.lock().map_err(|_| "store_unavailable".to_string())?;
        let connection = guard.as_ref().ok_or_else(|| "store_unavailable".to_string())?;
        f(connection).map_err(|_| "store_failed".to_string())
    }
}

fn check(ns: &str, key: Option<&str>) -> Result<(), String> {
    let bad = |s: &str| s.is_empty() || s.len() > MAX_NAME;
    if bad(ns) || key.is_some_and(bad) {
        return Err("store_invalid_key".into());
    }
    Ok(())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn store_get(store: tauri::State<Store>, ns: String, key: String) -> Result<Option<String>, String> {
    check(&ns, Some(&key))?;
    store.with(|c| {
        c.query_row("SELECT value FROM kv WHERE ns = ?1 AND key = ?2", params![ns, key], |row| row.get(0))
            .optional()
    })
}

#[tauri::command]
pub fn store_set(store: tauri::State<Store>, ns: String, key: String, value: String) -> Result<(), String> {
    check(&ns, Some(&key))?;
    if value.len() > MAX_VALUE {
        return Err("store_value_too_large".into());
    }
    store.with(|c| {
        c.execute(
            "INSERT INTO kv (ns, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![ns, key, value, now()],
        )
        .map(|_| ())
    })
}

#[tauri::command]
pub fn store_delete(store: tauri::State<Store>, ns: String, key: String) -> Result<(), String> {
    check(&ns, Some(&key))?;
    store.with(|c| c.execute("DELETE FROM kv WHERE ns = ?1 AND key = ?2", params![ns, key]).map(|_| ()))
}

#[tauri::command]
pub fn store_list(store: tauri::State<Store>, ns: String) -> Result<Vec<(String, String)>, String> {
    check(&ns, None)?;
    store.with(|c| {
        let mut statement = c.prepare("SELECT key, value FROM kv WHERE ns = ?1 ORDER BY key")?;
        let rows = statement.query_map(params![ns], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_round_trips_and_lists_one_namespace() {
        let dir = std::env::temp_dir().join(format!("tjuclaw-store-{}", std::process::id()));
        let store = Store::open(&dir).unwrap();
        store
            .with(|c| {
                c.execute("INSERT INTO kv VALUES ('a', 'k', 'v', 0)", [])?;
                c.execute("INSERT INTO kv VALUES ('b', 'k', 'w', 0)", [])?;
                c.query_row("SELECT count(*) FROM kv WHERE ns = 'a'", [], |r| r.get::<_, i64>(0))
            })
            .map(|n| assert_eq!(n, 1))
            .unwrap();
        assert!(check("", Some("k")).is_err());
        assert!(check("a", Some(&"x".repeat(MAX_NAME + 1))).is_err());
        drop(store);
        assert_eq!(Store::open_or_unavailable(None).with(|_| Ok(())), Err("store_unavailable".into()));
        let _ = std::fs::remove_dir_all(dir);
    }
}
