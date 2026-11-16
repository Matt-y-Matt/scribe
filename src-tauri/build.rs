use std::{env, path::PathBuf};

fn main() {
    // Tauri imports Common Controls v6 functions, which Windows only resolves
    // when the executable carries a manifest asking for them. tauri-build puts
    // that manifest in a resource it links into the app binary alone, so every
    // test binary that links Tauri dies at load with STATUS_ENTRYPOINT_NOT_FOUND
    // (0xc0000139). Tauri works around this for its own tests the same way:
    // leave the manifest out of the resource and have the linker embed it into
    // every artifact of this crate, the app and the test binaries alike.
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attributes).expect("the Tauri build script must succeed");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("set by cargo"))
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
