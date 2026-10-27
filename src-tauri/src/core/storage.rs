//! Versioned JSON storage with atomic replace, a one-step backup of the
//! previous file, and recovery that never throws a damaged file away.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::model::{sanitize, Data, DATA_VERSION};

pub const FILE_NAME: &str = "hydration.json";

pub struct Store {
    dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LoadOutcome {
    Fresh,
    Loaded,
    /// The main file was unreadable; its copy was kept and the backup loaded.
    RecoveredFromBackup { kept: String, reason: String },
    /// The file loaded but some rows were invalid and dropped; the original
    /// is kept aside untouched.
    Repaired { kept: String, dropped: usize },
    /// Neither file was usable; both were kept aside and a fresh file started.
    StartedFresh { kept: String, reason: String },
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Store { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn backup_path(&self) -> PathBuf {
        self.dir.join(format!("{FILE_NAME}.bak"))
    }

    fn tmp_path(&self) -> PathBuf {
        self.dir.join(format!("{FILE_NAME}.tmp"))
    }

    /// Parses a data file and repairs bad rows. Returns the data and how many
    /// items had to be dropped.
    fn read(path: &Path) -> Result<Option<(Data, usize)>, String> {
        let bytes = match fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("could not read: {e}")),
        };
        let mut data: Data = serde_json::from_slice(&bytes).map_err(|e| format!("invalid JSON: {e}"))?;
        if data.version != DATA_VERSION {
            return Err(format!("written by an unsupported version ({})", data.version));
        }
        let dropped = sanitize(&mut data);
        Ok(Some((data, dropped)))
    }

    fn copy_aside(&self, path: &Path, label: &str, now_ms: i64) -> String {
        let kept = self.dir.join(format!("hydration.{label}-{now_ms}.json"));
        match fs::copy(path, &kept) {
            Ok(_) => kept.display().to_string(),
            Err(_) => path.display().to_string(),
        }
    }

    /// Moves a damaged file aside under a timestamped name and returns it.
    fn keep_aside(&self, path: &Path, label: &str, now_ms: i64) -> String {
        let kept = self.dir.join(format!("hydration.{label}-{now_ms}.json"));
        match fs::rename(path, &kept) {
            Ok(()) => kept.display().to_string(),
            Err(_) => path.display().to_string(),
        }
    }

    pub fn load(&self, now_ms: i64) -> (Data, LoadOutcome) {
        let _ = fs::remove_file(self.tmp_path()); // leftover from a crash mid-save
        match Self::read(&self.path()) {
            Ok(Some((d, 0))) => (d, LoadOutcome::Loaded),
            Ok(Some((d, dropped))) => {
                let kept = self.copy_aside(&self.path(), "before-repair", now_ms);
                (d, LoadOutcome::Repaired { kept, dropped })
            }
            Ok(None) => match Self::read(&self.backup_path()) {
                // Main file missing but a backup exists: use it quietly.
                Ok(Some((d, _))) => (d, LoadOutcome::Loaded),
                _ => (Data::default(), LoadOutcome::Fresh),
            },
            Err(reason) => {
                let kept = self.keep_aside(&self.path(), "corrupt", now_ms);
                match Self::read(&self.backup_path()) {
                    Ok(Some((d, _))) => (d, LoadOutcome::RecoveredFromBackup { kept, reason }),
                    _ => {
                        if self.backup_path().exists() {
                            self.keep_aside(&self.backup_path(), "corrupt-backup", now_ms);
                        }
                        (Data::default(), LoadOutcome::StartedFresh { kept, reason })
                    }
                }
            }
        }
    }

    /// Writes to a temp file, fsyncs, copies the current file to `.bak`, then
    /// renames the temp file over the main one (atomic on the same volume).
    pub fn save(&self, data: &Data) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let json = serde_json::to_vec_pretty(data).map_err(io::Error::other)?;
        let tmp = self.tmp_path();
        {
            let mut f = OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
            f.write_all(&json)?;
            f.sync_all()?;
        }
        let main = self.path();
        if main.exists() {
            fs::copy(&main, self.backup_path())?;
        }
        fs::rename(&tmp, &main)?;
        #[cfg(unix)]
        if let Ok(d) = fs::File::open(&self.dir) {
            let _ = d.sync_all();
        }
        Ok(())
    }

    /// Copies the current file aside before a destructive action (reset/import).
    pub fn snapshot_before(&self, label: &str, now_ms: i64) -> io::Result<Option<PathBuf>> {
        let main = self.path();
        if !main.exists() {
            return Ok(None);
        }
        let dest = self.dir.join(format!("hydration.{label}-{now_ms}.json"));
        fs::copy(&main, &dest)?;
        Ok(Some(dest))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model::Entry;

    const NOW: i64 = 1_793_000_000_000;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!("hydration-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample(ml: u32) -> Data {
        let mut d = Data::default();
        d.entries.push(Entry { id: format!("e{ml}"), ts: NOW, date: "2026-10-26".into(), ml, offset_min: 0 });
        d
    }

    #[test]
    fn fresh_then_roundtrip_with_backup() {
        let t = TempDir::new("roundtrip");
        let s = Store::new(t.0.clone());
        let (d, o) = s.load(NOW);
        assert_eq!(o, LoadOutcome::Fresh);
        assert!(d.entries.is_empty());

        s.save(&sample(250)).unwrap();
        assert!(!s.backup_path().exists());
        s.save(&sample(500)).unwrap();
        // Backup holds the previous version, main the new one.
        let bak: Data = serde_json::from_slice(&fs::read(s.backup_path()).unwrap()).unwrap();
        assert_eq!(bak.entries[0].ml, 250);
        let (d, o) = s.load(NOW);
        assert_eq!(o, LoadOutcome::Loaded);
        assert_eq!(d.entries[0].ml, 500);
        assert!(!s.tmp_path().exists());
    }

    #[test]
    fn corrupt_main_recovers_backup_and_keeps_copy() {
        let t = TempDir::new("corrupt");
        let s = Store::new(t.0.clone());
        s.save(&sample(250)).unwrap();
        s.save(&sample(500)).unwrap();
        fs::write(s.path(), b"{ not json").unwrap();
        let (d, o) = s.load(NOW);
        match o {
            LoadOutcome::RecoveredFromBackup { kept, .. } => {
                assert_eq!(fs::read(&kept).unwrap(), b"{ not json");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(d.entries[0].ml, 250);
    }

    #[test]
    fn both_corrupt_starts_fresh_and_keeps_both() {
        let t = TempDir::new("bothcorrupt");
        let s = Store::new(t.0.clone());
        fs::write(s.path(), b"garbage").unwrap();
        fs::write(s.backup_path(), b"also garbage").unwrap();
        let (d, o) = s.load(NOW);
        assert!(matches!(o, LoadOutcome::StartedFresh { .. }));
        assert!(d.entries.is_empty());
        let kept: Vec<_> = fs::read_dir(&t.0).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        assert_eq!(kept.iter().filter(|n| n.contains("corrupt")).count(), 2, "{kept:?}");
    }

    #[test]
    fn one_bad_row_is_repaired_not_fatal() {
        let t = TempDir::new("invalid");
        let s = Store::new(t.0.clone());
        let mut d = sample(250);
        d.entries.push(Entry { id: "bad".into(), ts: NOW, date: "2026-10-26".into(), ml: 9000, offset_min: 0 });
        fs::write(s.path(), serde_json::to_vec(&d).unwrap()).unwrap();
        let (loaded, o) = s.load(NOW);
        assert_eq!(loaded.entries.len(), 1);
        match o {
            LoadOutcome::Repaired { kept, dropped } => {
                assert_eq!(dropped, 1);
                // The untouched original is kept.
                let orig: Data = serde_json::from_slice(&fs::read(kept).unwrap()).unwrap();
                assert_eq!(orig.entries.len(), 2);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn newer_version_is_kept_aside() {
        let t = TempDir::new("version");
        let s = Store::new(t.0.clone());
        let mut d = sample(250);
        d.version = 9;
        fs::write(s.path(), serde_json::to_vec(&d).unwrap()).unwrap();
        let (_, o) = s.load(NOW);
        assert!(matches!(o, LoadOutcome::StartedFresh { .. }));
    }

    #[test]
    fn leftover_tmp_is_ignored() {
        let t = TempDir::new("tmp");
        let s = Store::new(t.0.clone());
        s.save(&sample(250)).unwrap();
        fs::write(s.tmp_path(), b"half written").unwrap();
        let (d, o) = s.load(NOW);
        assert_eq!(o, LoadOutcome::Loaded);
        assert_eq!(d.entries[0].ml, 250);
        assert!(!s.tmp_path().exists());
    }
}
