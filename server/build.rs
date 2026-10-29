// Gives every build a distinct id. With no rerun-if-changed lines, cargo reruns this
// whenever any file in the package changes, so the id changes with the code.
fn main() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    println!("cargo:rustc-env=IA_BUILD_ID={nanos:x}");
}
