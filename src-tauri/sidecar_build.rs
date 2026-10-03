//! Build only the public CLI source, never a private backend or root env file.
use std::{env, fs, path::Path, process::Command};

pub fn go_target(target: &str) -> Option<(&'static str, &'static str)> {
    match target {
        "x86_64-unknown-linux-gnu" | "x86_64-unknown-linux-musl" => Some(("linux", "amd64")),
        "aarch64-unknown-linux-gnu" | "aarch64-unknown-linux-musl" => Some(("linux", "arm64")),
        "x86_64-pc-windows-msvc" | "x86_64-pc-windows-gnu" => Some(("windows", "amd64")),
        "aarch64-pc-windows-msvc" => Some(("windows", "arm64")),
        "x86_64-apple-darwin" => Some(("darwin", "amd64")),
        "aarch64-apple-darwin" => Some(("darwin", "arm64")),
        _ => None,
    }
}

pub fn mobile(target: &str) -> bool {
    target.contains("android") || target.contains("ios")
}

fn watch_tree(path: &Path) {
    println!("cargo:rerun-if-changed={}", path.display());
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                watch_tree(&path);
            } else {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn build(source: &Path, output: &Path, os: &str, arch: &str, version: &str) {
    let status = Command::new("go")
        .current_dir(source)
        .env("CGO_ENABLED", "0")
        .env("GOOS", os)
        .env("GOARCH", arch)
        .args(["build", "-trimpath", "-buildvcs=false", "-ldflags"])
        .arg(format!("-s -w -X main.version={version}"))
        .arg("-o")
        .arg(output)
        .arg("./cmd/tjuclaw")
        .status()
        .expect("desktop packaging requires Go 1.27 on the trusted builder PATH");
    assert!(status.success(), "public tjuclaw sidecar build failed");
}

pub fn prepare() {
    println!("cargo:rerun-if-env-changed=TJUCLAW_CLI_SOURCE_DIR");
    println!("cargo:rerun-if-env-changed=TAURI_ENV_TARGET_TRIPLE");
    let target = env::var("TARGET").expect("Cargo target");
    if mobile(&target) {
        return; // Mobile neither bundles nor registers host execution.
    }
    let (os, arch) = go_target(&target).expect("unsupported desktop CLI packaging target");
    let native = env::current_dir().expect("native source directory");
    // Build-time trusted configuration only; never available through IPC.
    let source = env::var_os("TJUCLAW_CLI_SOURCE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| native.join("../../cli"));
    let source = source.canonicalize().expect(
        "checkout the pinned public CLI at ../cli or set trusted TJUCLAW_CLI_SOURCE_DIR before a desktop build",
    );
    assert!(
        source.join("cmd/tjuclaw/main.go").is_file(),
        "missing public CLI source"
    );
    for name in [
        "go.mod",
        "go.sum",
        "package.json",
        "cmd/tjuclaw",
        "internal",
    ] {
        watch_tree(&source.join(name));
    }
    let package: serde_json::Value =
        serde_json::from_slice(&fs::read(source.join("package.json")).expect("CLI package.json"))
            .expect("CLI package metadata");
    let version = package["version"].as_str().expect("CLI package version");
    assert!(
        !version.is_empty()
            && version.len() <= 64
            && version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b)),
        "invalid CLI version"
    );
    let binaries = native.join("binaries");
    fs::create_dir_all(&binaries).expect("sidecar staging directory");
    let suffix = if os == "windows" { ".exe" } else { "" };
    build(
        &source,
        &binaries.join(format!("tjuclaw-{target}{suffix}")),
        os,
        arch,
        version,
    );
    // Tauri's universal bundle expects a universal sidecar in addition to the
    // two arch-specific sidecars used by its underlying Cargo builds. Those
    // builds run once per architecture and are not told they belong to a
    // universal bundle, so any macOS build on a Mac stages all three: the Go
    // builds take seconds, and the bundler picks the one it needs.
    if target.ends_with("-apple-darwin") && cfg!(target_os = "macos") {
        for (triple, architecture) in [
            ("x86_64-apple-darwin", "amd64"),
            ("aarch64-apple-darwin", "arm64"),
        ] {
            build(
                &source,
                &binaries.join(format!("tjuclaw-{triple}")),
                "darwin",
                architecture,
                version,
            );
        }
        assert!(Command::new("lipo")
            .args(["-create"])
            .arg(binaries.join("tjuclaw-x86_64-apple-darwin"))
            .arg(binaries.join("tjuclaw-aarch64-apple-darwin"))
            .arg("-output")
            .arg(binaries.join("tjuclaw-universal-apple-darwin"))
            .status()
            .expect("macOS universal packaging requires lipo")
            .success());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_reviewed_desktop_targets_build_sidecars() {
        assert_eq!(
            go_target("x86_64-pc-windows-msvc"),
            Some(("windows", "amd64"))
        );
        assert_eq!(go_target("aarch64-apple-darwin"), Some(("darwin", "arm64")));
        assert_eq!(
            go_target("x86_64-unknown-linux-gnu"),
            Some(("linux", "amd64"))
        );
        assert!(mobile("aarch64-linux-android"));
        assert!(mobile("aarch64-apple-ios"));
        assert!(go_target("aarch64-linux-android").is_none());
        assert!(go_target("--arbitrary-command").is_none());
    }
}
