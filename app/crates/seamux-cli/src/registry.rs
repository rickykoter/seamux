//! Every tool `seamux` runs, by name.
//!
//! A tool is `(name, run)`: `name` is the Python script's basename it replaces
//! (`crew-sync`, `triage`, `statusline`, ...), and `run` takes the arguments
//! after the name and returns the exit code. It reads stdin and writes
//! stdout and stderr itself, exactly as the Python did, since one probe runs
//! either implementation.
//!
//! A crate registers by exporting a table and adding ONE line to `TABLES`:
//!
//! ```ignore
//! // in crew-store/src/lib.rs
//! pub const TOOLS: &[(&str, fn(&[String]) -> i32)] = &[("crew-artifacts", cli::main)];
//! ```
//! ```ignore
//! // here
//!     crew_store::TOOLS,
//! ```
//!
//! The entry type is a plain tuple so a port crate needs no dependency on
//! this one. `seamux --tools` lists the names; the CREW_IMPL helper reads that
//! list to decide which tools run as Rust.

/// One tool: its name and its entry point (args after the name -> exit code).
pub type Tool = (&'static str, fn(&[String]) -> i32);

/// Each crate's tool table. One line per crate; keep them sorted to ease merges.
pub const TABLES: &[&[Tool]] = &[
    crate::cmux_tool::TOOLS,
    crew_board::TOOLS,
    crew_core::TOOLS,
];

/// Every registered tool, in name order.
pub fn all() -> Vec<Tool> {
    let mut v: Vec<Tool> = TABLES.iter().flat_map(|t| t.iter().copied()).collect();
    v.sort_by_key(|t| t.0);
    v
}

pub fn find(name: &str) -> Option<Tool> {
    TABLES.iter().flat_map(|t| t.iter().copied()).find(|t| t.0 == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique() {
        let names: Vec<&str> = all().iter().map(|t| t.0).collect();
        let mut d = names.clone();
        d.dedup();
        assert_eq!(names, d, "two crates register the same tool name");
    }
}
