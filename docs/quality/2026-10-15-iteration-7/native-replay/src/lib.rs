mod backend;
mod layers;
mod resources {
 pub fn backend_script()->std::path::PathBuf {std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("helper.cjs")}
 pub fn node()->std::path::PathBuf {std::path::PathBuf::from("node")}
 pub fn photocraft_cli()->Option<std::path::PathBuf>{None}
}
