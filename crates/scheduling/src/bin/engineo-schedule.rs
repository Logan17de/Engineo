use std::io::{self, Read};
use std::process::ExitCode;

use engineo_scheduling::calculate_schedule_json;
use serde_json::json;

fn main() -> ExitCode {
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        eprintln!("{}", json!({ "error": "stdin_read_failed", "message": error.to_string() }));
        return ExitCode::FAILURE;
    }

    match calculate_schedule_json(&input) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!(
                "{}",
                json!({ "error": "schedule_calculation_failed", "message": error.to_string() })
            );
            ExitCode::FAILURE
        }
    }
}
