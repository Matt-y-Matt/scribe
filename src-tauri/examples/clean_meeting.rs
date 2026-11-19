//! Runs the clean-up pass (session/cleanup.rs) over one meeting and prints
//! every line it changes, old text over new. Writes the result only when
//! `--save` is given; point `--db` at a copy to try it without touching the
//! real database.
//!
//! `clean_meeting --data <app data folder> --db <scribe.db> --meeting <id> [--save]`

use std::path::PathBuf;
use std::time::Instant;

use scribe_lib::session::cleanup::clean_lines;
use scribe_lib::store::Store;
use scribe_lib::stt::models::{self, CLEANUP_MODEL};
use scribe_lib::stt::{default_threads, LocalSherpa};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1).cloned())
}

#[tokio::main]
async fn main() {
    let data = PathBuf::from(arg("--data").expect("--data <app data folder>"));
    let db = PathBuf::from(arg("--db").expect("--db <scribe.db>"));
    let meeting = arg("--meeting").expect("--meeting <id>");
    let save = std::env::args().any(|value| value == "--save");

    let store = Store::open(&db).await.expect("the database opens");
    let segments = store.segments(&meeting).await.expect("the transcript");
    let spec = models::spec(CLEANUP_MODEL).expect("the clean-up model");
    let model = LocalSherpa::load(spec, &data, default_threads(), "cpu").expect("it is installed");

    let started = Instant::now();
    let changes = clean_lines(&data, &segments, &model, &|done, total| {
        if done % 50 == 0 {
            eprintln!("{done} of {total}");
        }
    });
    let seconds = started.elapsed().as_secs_f64();
    for (id, text) in &changes {
        if let Some(segment) = segments.iter().find(|segment| &segment.id == id) {
            let t = segment.t0_ms / 1000;
            println!("{:02}:{:02} {}", t / 60, t % 60, segment.source);
            println!("  live   {}", segment.text);
            println!("  clean  {text}");
        }
    }
    println!(
        "\n{} of {} lines changed in {seconds:.0} s",
        changes.len(),
        segments.len()
    );
    if save {
        store
            .clean_segments(&meeting, &changes)
            .await
            .expect("the lines are saved");
        println!("saved");
    }
}
