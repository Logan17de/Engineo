// Keep signal handling active through setup and disposal. An interruption drains
// in-flight fixture work, skips new child work and then removes only its own DB.
export async function runBrowserTests({ createFixture, startChild, signals = process }) {
  let interrupted = null;
  let child = null;
  let fixture = null;
  let exitCode = 1;
  const recordSignal = (signal) => {
    interrupted ??= signal;
    child?.kill(signal);
  };
  const interrupt = () => recordSignal("SIGINT");
  const terminate = () => recordSignal("SIGTERM");
  signals.on("SIGINT", interrupt);
  signals.on("SIGTERM", terminate);
  try {
    fixture = await createFixture();
    if (!interrupted) {
      child = startChild(fixture.env);
      try {
        const finished = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => resolve(code ?? 1));
        });
        // A signal may arrive synchronously while the child is being created.
        if (interrupted) child.kill(interrupted);
        exitCode = await finished;
      } finally {
        child = null;
      }
    }
  } finally {
    try {
      if (fixture) await fixture.dispose();
    } finally {
      signals.off("SIGINT", interrupt);
      signals.off("SIGTERM", terminate);
    }
  }
  return interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : exitCode;
}
