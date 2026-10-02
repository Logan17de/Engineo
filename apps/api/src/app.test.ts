import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

test("health endpoint reports API and contract status", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "GET",
    url: "/health",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    service: "engineo-api",
    status: "ok",
    engineContractVersion: 1,
  });

  await app.close();
});
