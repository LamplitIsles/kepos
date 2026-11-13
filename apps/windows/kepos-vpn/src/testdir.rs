//! Test-only temporary directories.
//!
//! Each test creates a directory that cannot already exist: the leaf is created
//! with `create_dir`, so a pre-existing path is never reused, emptied or
//! removed. Cleanup removes only the directory this test created.

use std::path::{Path, PathBuf};

pub struct TestDir {
    path: PathBuf,
}

impl TestDir {
    /// Create a unique directory under the platform temporary directory.
    pub fn create(tag: &str) -> Self {
        let base = std::env::temp_dir();
        for attempt in 0..128u32 {
            let candidate = base.join(format!(
                "kepos-windows-{tag}-{}-{attempt}",
                std::process::id()
            ));
            match std::fs::create_dir(&candidate) {
                Ok(()) => return Self { path: candidate },
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create a test directory: {error}"),
            }
        }
        panic!("cannot create a unique test directory for {tag}");
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_directories_never_collide_and_cleanup_is_own_only() {
        let first = TestDir::create("unique");
        let second = TestDir::create("unique");
        assert_ne!(first.path(), second.path());
        let existing = first.path().join("keep.txt");
        std::fs::write(&existing, b"kept").unwrap();
        drop(second);
        assert!(
            existing.exists(),
            "dropping one test dir must not touch another"
        );
    }
}
