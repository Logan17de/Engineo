use std::io::{self, Read};
use std::process::ExitCode;

use engineo_scheduling::calculate_schedule_json;
use serde_json::json;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let engine_version = env!("ENGINEO_ENGINE_VERSION");
    if args == ["--engine-info"] {
        println!(
            "{}",
            json!({ "engineVersion": engine_version, "engineContractVersion": 1 })
        );
        return ExitCode::SUCCESS;
    }
    if args == ["--time-zones"] {
        let mut zones: Vec<_> = engineo_calendar::supported_time_zones().collect();
        zones.sort_unstable();
        println!("{}", json!(zones));
        return ExitCode::SUCCESS;
    }
    let pinned_version =
        args.len() == 2 && args[0] == "--engine-version" && args[1] == engine_version;
    if !args.is_empty() && !pinned_version {
        eprintln!("{}", json!({ "error": "unsupported_option" }));
        return ExitCode::FAILURE;
    }
    let mut input = String::new();
    if let Err(error) = io::stdin()
        .take(32 * 1024 * 1024 + 1)
        .read_to_string(&mut input)
    {
        eprintln!(
            "{}",
            json!({ "error": "stdin_read_failed", "message": error.to_string() })
        );
        return ExitCode::FAILURE;
    }
    if input.len() > 32 * 1024 * 1024 {
        eprintln!("{}", json!({ "error": "schedule_input_limit" }));
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
