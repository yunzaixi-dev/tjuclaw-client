fn main() {
    // The desktop sandbox pulls these public, digest-pinned images.
    for (key, value) in [
        (
            "TJUCLAW_LOCAL_GATEWAY_IMAGE",
            "harbor.agentwego.com/tjuclaw-desktop/tjuclaw-local-gateway@sha256:02b06ae2e32246416a8cd4d38ea90228aaa086c4565d4e9bb1d35a2aa97203e1",
        ),
        (
            "TJUCLAW_LOCAL_CONTROLLER_IMAGE",
            "harbor.agentwego.com/tjuclaw-desktop/tjuclaw-sandbox-controller@sha256:262c33b47d0e45edeccaedffd4f34ab617d72894447faec82012dd3c4a7a2f4f",
        ),
    ] {
        println!("cargo:rustc-env={key}={value}");
    }
    // App commands are declared so each capability grants them explicitly;
    // the remote web app gets only the ones listed in capabilities/.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "store_get",
            "store_set",
            "store_delete",
            "store_list",
            "local_sandbox_status",
            "local_sandbox_prepare",
            "local_sandbox_start",
            "local_sandbox_stop",
            "local_sandbox_turn",
        ]),
    ))
    .expect("failed to run tauri build script");
}
