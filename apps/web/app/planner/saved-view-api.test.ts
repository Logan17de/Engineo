import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ApiError, api, bindSession, clearSessionBinding } from "./api";
import { parseSavedViewJson } from "./saved-view-protocol";

const session = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let cookie = "engineo_csrf=mock-csrf-only";
const policy = { maximumBytes: 65536, parseJson: parseSavedViewJson };
const response = (
  body: string | Uint8Array,
  overrides: { status?: number; headers?: Record<string, string> } = {},
) =>
  new Response(body as BodyInit, {
    status: overrides.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "X-Engineo-Session": session,
      ...overrides.headers,
    },
  });
beforeEach(() => {
  cookie = "engineo_csrf=mock-csrf-only";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() {
        return cookie;
      },
    },
  });
  clearSessionBinding();
  bindSession(session);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSessionBinding();
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});
const rejectsCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error) => error instanceof ApiError && error.code === code);

test("view transport retains bound same-origin cookie/no-store/session/CSRF semantics", async () => {
  const calls: Array<{ url: string; options: RequestInit | undefined }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return response('{"ok":true}');
  };
  const controller = new AbortController();
  assert.deepEqual(
    await api("/organizations/mock/projects/mock/views/plan", {
      method: "POST",
      body: { name: "Private fixture" },
      signal: controller.signal,
      responsePolicy: policy,
    }),
    Object.assign(Object.create(null), { ok: true }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/organizations/mock/projects/mock/views/plan");
  assert.equal(calls[0]?.options?.credentials, "same-origin");
  assert.equal(calls[0]?.options?.cache, "no-store");
  assert.equal(calls[0]?.options?.signal, controller.signal);
  assert.deepEqual(calls[0]?.options?.headers, {
    "X-Engineo-Session": session,
    "Content-Type": "application/json",
    "X-CSRF-Token": "mock-csrf-only",
  });
  assert.equal(calls[0]?.options?.body, '{"name":"Private fixture"}');
});
test("private transport refuses an absent binding before any request", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response("{}");
  };
  clearSessionBinding();
  await rejectsCode(api("/views", { responsePolicy: policy }), "unauthenticated");
  assert.equal(calls, 0);
});
test("changed or removed CSRF cookie refuses request before submission", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response("{}");
  };
  cookie = "engineo_csrf=changed-mock-only";
  await rejectsCode(api("/views", { responsePolicy: policy }), "session_changed");
  cookie = "";
  await rejectsCode(api("/views", { responsePolicy: policy }), "unauthenticated");
  assert.equal(calls, 0);
});
test("an already aborted request never reaches fetch", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response("{}");
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    api("/views", { signal: controller.signal, responsePolicy: policy }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(calls, 0);
});
for (const returned of ["", "22222222-2222-4222-8222-222222222222"])
  test(`mandatory current session response header rejects ${returned ? "foreign" : "absent"} binding`, async () => {
    globalThis.fetch = async () => response("{}", { headers: { "X-Engineo-Session": returned } });
    await rejectsCode(api("/views", { responsePolicy: policy }), "session_changed");
  });
test("rebind while fetch is pending rejects the old response", async () => {
  globalThis.fetch = async () => {
    bindSession("22222222-2222-4222-8222-222222222222");
    return response('{"private":"old actor"}');
  };
  await rejectsCode(api("/views", { responsePolicy: policy }), "session_changed");
});
for (const [header, value] of [
  ["cache-control", "public,max-age=60"],
  ["cache-control", "no-store-ish"],
  ["content-type", "text/json"],
  ["content-type", "application/problem+json"],
  ["content-type", "application/json;charset=latin1"],
  ["content-length", "65537"],
  ["content-length", "not-a-number"],
] as const)
  test(`strict view response refuses unsafe ${header}: ${value}`, async () => {
    globalThis.fetch = async () => response("{}", { headers: { [header]: value } });
    await rejectsCode(api("/views", { responsePolicy: policy }), "view_response_invalid");
  });
test("exact application/json UTF-8 and NO-STORE directive are accepted", async () => {
  globalThis.fetch = async () =>
    response('{"ok":true}', {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, NO-STORE",
      },
    });
  assert.deepEqual(
    await api("/views", { responsePolicy: policy }),
    Object.assign(Object.create(null), { ok: true }),
  );
});
for (const raw of [
  '{"name":"private","name":"duplicate"}',
  '{"n":1e0}',
  '{"__proto__":{}}',
  "\ufeff{}",
  '"\\ud800"',
])
  test("view response strict original-byte parser rejects hostile JSON without echo", async () => {
    globalThis.fetch = async () => response(raw);
    await assert.rejects(
      api("/views", { responsePolicy: policy }),
      (error) =>
        error instanceof ApiError &&
        error.code === "view_response_invalid" &&
        !error.message.includes("duplicate"),
    );
  });
test("malformed UTF-8 view responses fail closed", async () => {
  globalThis.fetch = async () => response(new Uint8Array([0x22, 0xff, 0x22]));
  await rejectsCode(api("/views", { responsePolicy: policy }), "view_response_invalid");
});
test("streaming response byte limit is enforced without trusting content-length", async () => {
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(40000));
          controller.enqueue(new Uint8Array(40000));
        },
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "X-Engineo-Session": session,
        },
      },
    );
  await rejectsCode(api("/views", { responsePolicy: policy }), "view_response_invalid");
  assert.equal(cancelled, true);
});
test("private request bodies exceeding 64 KiB are refused before submission", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response("{}");
  };
  await rejectsCode(
    api("/views/apply", { method: "POST", body: { x: "x".repeat(65536) }, responsePolicy: policy }),
    "view_request_invalid",
  );
  assert.equal(calls, 0);
});
test("private serialization errors do not expose thrown user data", async () => {
  await assert.rejects(
    api("/views/apply", {
      method: "POST",
      body: {
        toJSON() {
          throw new Error("SECRET PRIVATE PAYLOAD");
        },
      },
      responsePolicy: policy,
    }),
    (error) =>
      error instanceof ApiError &&
      error.code === "view_request_invalid" &&
      !error.message.includes("SECRET"),
  );
});
test("unknown error codes and diagnostics are replaced with fixed safe error output", async () => {
  globalThis.fetch = async () =>
    response(
      '{"error":"PRIVATE SEARCH TEXT","message":"PRIVATE DETAIL","issues":[{"path":"private","message":"SECRET"}]}',
      { status: 409 },
    );
  await assert.rejects(
    api("/views", { responsePolicy: policy }),
    (error) =>
      error instanceof ApiError &&
      error.code === "view_request_failed" &&
      error.message === "Private-view request was rejected (409).",
  );
});
test("known view failures use fixed mapped messages", async () => {
  globalThis.fetch = async () =>
    response('{"error":"view_reference_stale","message":"PRIVATE DETAIL"}', { status: 409 });
  await assert.rejects(
    api("/views", { responsePolicy: policy }),
    (error) =>
      error instanceof ApiError &&
      error.code === "view_reference_stale" &&
      !error.message.includes("PRIVATE"),
  );
});
test("null hostile error response does not cause unsafe diagnostic coercion", async () => {
  globalThis.fetch = async () => response("null", { status: 400 });
  await rejectsCode(api("/views", { responsePolicy: policy }), "view_request_failed");
});
test("session change while consuming malformed body takes precedence over protocol failure", async () => {
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          cookie = "engineo_csrf=new-mock-only";
          controller.enqueue(new TextEncoder().encode("bad private data"));
          controller.close();
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "X-Engineo-Session": session,
        },
      },
    );
  await rejectsCode(api("/views", { responsePolicy: policy }), "session_changed");
});
test("non-view API response behavior is unchanged", async () => {
  globalThis.fetch = async () =>
    new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  assert.deepEqual(await api("/organizations"), { ok: true });
});
