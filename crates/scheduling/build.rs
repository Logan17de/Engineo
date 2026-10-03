use std::fs;
use std::path::{Path, PathBuf};

fn collect_sources(path: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(path).expect("engine source directory must exist") {
        let path = entry.expect("engine source entry must exist").path();
        if path.is_dir() {
            collect_sources(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = vec![root.join("Cargo.toml"), root.join("Cargo.lock")];
    for name in ["calendar", "project-model", "scheduling"] {
        let directory = root.join("crates").join(name);
        println!("cargo:rerun-if-changed={}", directory.join("src").display());
        files.push(directory.join("Cargo.toml"));
        collect_sources(&directory.join("src"), &mut files);
    }
    files.push(root.join("crates/scheduling/build.rs"));
    files.sort();
    // Reproducible source compatibility fingerprint, deliberately not a binary
    // signature or cryptographic attestation. Deployment still trusts the binary.
    let mut fingerprint: u64 = 0xcbf2_9ce4_8422_2325;
    for path in files {
        println!("cargo:rerun-if-changed={}", path.display());
        let relative = path
            .strip_prefix(&root)
            .expect("source is inside repository");
        for byte in relative
            .to_string_lossy()
            .bytes()
            .chain([0])
            .chain(fs::read(&path).expect("engine source must be readable"))
            .chain([0])
        {
            fingerprint ^= u64::from(byte);
            fingerprint = fingerprint.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    println!(
        "cargo:rustc-env=ENGINEO_ENGINE_VERSION=engineo-scheduling/{}+source-fnv1a-{fingerprint:016x}",
        env!("CARGO_PKG_VERSION")
    );
}
