import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runBrowserTests } from "./browser-test-runner.mjs";

function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("interrupt during fixture creation drains setup and cleanup without starting a browser child", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const signals = new EventEmitter();
    const setup = barrier();
    let disposed = 0;
    const running = runBrowserTests({
      signals,
      createFixture: async () => {
        await setup.promise;
        return {
          env: {},
          dispose: async () => {
            disposed++;
          },
        };
      },
      startChild: () => {
        assert.fail("Interrupted setup must not launch a child");
      },
    });
    signals.emit(signal);
    setup.release();
    assert.equal(await running, signal === "SIGINT" ? 130 : 143);
    assert.equal(disposed, 1);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  }
});

test("interrupt during cleanup keeps handlers active until database disposal completes", async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  child.kill = () => {
    assert.fail("An exited child must not be signalled during cleanup");
  };
  const spawned = barrier(),
    disposing = barrier(),
    cleanup = barrier();
  let disposed = false;
  const running = runBrowserTests({
    signals,
    createFixture: async () => ({
      env: {},
      dispose: async () => {
        disposing.release();
        await cleanup.promise;
        disposed = true;
      },
    }),
    startChild: () => {
      spawned.release();
      return child;
    },
  });
  await spawned.promise;
  child.emit("exit", 0);
  await disposing.promise;
  assert.equal(signals.listenerCount("SIGTERM"), 1);
  signals.emit("SIGTERM");
  assert.equal(disposed, false);
  cleanup.release();
  assert.equal(await running, 143);
  assert.equal(disposed, true);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("child interruption is forwarded and failed child startup still disposes its database", async () => {
  for (const failStartup of [false, true]) {
    const signals = new EventEmitter(),
      child = new EventEmitter();
    const spawned = barrier();
    let disposed = 0;
    child.kill = (signal) => {
      assert.equal(signal, "SIGINT");
      child.emit("exit", null);
    };
    const running = runBrowserTests({
      signals,
      createFixture: async () => ({
        env: {},
        dispose: async () => {
          disposed++;
        },
      }),
      startChild: () => {
        spawned.release();
        return child;
      },
    });
    await spawned.promise;
    if (failStartup) {
      child.emit("error", new Error("Cannot spawn pnpm"));
      await assert.rejects(running, /Cannot spawn pnpm/);
    } else {
      signals.emit("SIGINT");
      assert.equal(await running, 130);
    }
    assert.equal(disposed, 1);
    assert.equal(signals.listenerCount("SIGINT"), 0);
  }
});

test("a signal during child creation is forwarded after exit listeners are registered", async () => {
  const signals = new EventEmitter(),
    child = new EventEmitter();
  let disposed = false;
  child.kill = (signal) => {
    assert.equal(signal, "SIGTERM");
    child.emit("exit", null);
  };
  const code = await runBrowserTests({
    signals,
    createFixture: async () => ({
      env: {},
      dispose: async () => {
        disposed = true;
      },
    }),
    startChild: () => {
      signals.emit("SIGTERM");
      return child;
    },
  });
  assert.equal(code, 143);
  assert.equal(disposed, true);
});
