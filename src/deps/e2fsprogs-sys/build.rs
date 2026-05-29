//! Build script for e2fsprogs-sys
//!
//! Builds mke2fs from the vendored e2fsprogs submodule.

use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=vendor/e2fsprogs");
    println!("cargo:rerun-if-env-changed=BOXLITE_DEPS_STUB");

    // Auto-detect crates.io download: Cargo injects .cargo_vcs_info.json into
    // published packages. When present, enter stub mode since vendor sources are
    // excluded from the package and building from source is not possible.
    if env::var("BOXLITE_DEPS_STUB").is_err() {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        if manifest_dir.join(".cargo_vcs_info.json").exists() {
            // SAFETY: build.rs is single-threaded; no concurrent env var access.
            unsafe { env::set_var("BOXLITE_DEPS_STUB", "1") };
        }
    }

    // Check for stub mode (for CI linting or crates.io install)
    if env::var("BOXLITE_DEPS_STUB").is_ok() {
        println!("cargo:warning=BOXLITE_DEPS_STUB mode: skipping e2fsprogs build");
        println!("cargo:mke2fs_BOXLITE_DEP=/nonexistent");
        println!("cargo:debugfs_BOXLITE_DEP=/nonexistent");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor_dir = manifest_dir.join("vendor/e2fsprogs");
    let build_dir = out_dir.join("e2fsprogs-build");

    let mke2fs_path = build_dir.join("misc/mke2fs");
    let debugfs_path = build_dir.join("debugfs/debugfs");

    build_e2fsprogs(&vendor_dir, &build_dir);

    println!("cargo:mke2fs_BOXLITE_DEP={}", mke2fs_path.display());
    println!("cargo:debugfs_BOXLITE_DEP={}", debugfs_path.display());
}

fn build_e2fsprogs(vendor_dir: &Path, build_dir: &Path) {
    println!("cargo:warning=Building e2fsprogs tools...");

    std::fs::create_dir_all(build_dir).expect("Failed to create build directory");

    let configure_path = vendor_dir.join("configure");
    if !configure_path.exists() {
        panic!(
            "e2fsprogs configure not found at {}. Initialize submodule?",
            configure_path.display()
        );
    }

    // Configure
    let status = Command::new(&configure_path)
        .current_dir(build_dir)
        .args([
            "--disable-nls",
            "--disable-threads",
            "--disable-tdb",
            "--disable-imager",
            "--disable-resizer",
            "--disable-defrag",
            "--disable-fsck",
            "--disable-e2initrd-helper",
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("Failed to run configure");

    if !status.success() {
        panic!("configure failed");
    }

    let jobs = num_cpus::get().to_string();

    // Build libs (required for tools)
    // Build-stability fix (unrelated to box backup/restore): the libs build is
    // serialized to dodge a parallel-make codegen race — see NOTE below.
    // NOTE: serial (-j1) — the ext2fs crc32 tables are code-generated at build
    // time (gen_crc32ctable → crc32c_table.h); the vendored Makefile does not
    // declare crc32c.c's dependency on that generated header, so parallel make
    // can compile crc32c.c before the header exists → "use of undeclared
    // identifier 'crc32ctable_le' / 'crc32table_be'". Serializing the libs
    // build forces the generator to run first. (If a stale half-built dir
    // from a prior parallel failure lingers, also `cargo clean -p
    // e2fsprogs-sys` before rebuilding.)
    let status = Command::new("make")
        .current_dir(build_dir)
        .args(["-j", "1", "libs"])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("Failed to run make libs");

    if !status.success() {
        panic!("make libs failed");
    }

    // Build mke2fs
    let status = Command::new("make")
        .current_dir(build_dir.join("misc"))
        .args(["-j", &jobs, "mke2fs"])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("Failed to run make mke2fs");

    if !status.success() {
        panic!("make mke2fs failed");
    }

    // Build debugfs
    let status = Command::new("make")
        .current_dir(build_dir.join("debugfs"))
        .args(["-j", &jobs, "debugfs"])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .expect("Failed to run make debugfs");

    if !status.success() {
        panic!("make debugfs failed");
    }

    println!("cargo:warning=e2fsprogs build complete");
}
