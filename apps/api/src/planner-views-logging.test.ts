import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** Exercises the production build/logger, without PostgreSQL or any listener. */
test("production request logging suppresses private-view URLs and original bytes only in that scope", () => {
  const appModule = new URL("../dist/app.js", import.meta.url).href;
  const queryMarker = "PRIVATE_VIEW_QUERY_LOG_SECRET_1739";
  const bodyMarker = "PRIVATE_VIEW_BODY_LOG_SECRET_2840";
  const source = `
    import { createHash } from 'node:crypto';
    import { buildApp } from ${JSON.stringify(appModule)};
    const organizationId='10000000-0000-4000-8000-000000000001';
    const projectId='10000000-0000-4000-8000-000000000002';
    const actorId='10000000-0000-4000-8000-000000000003';
    const sessionId='10000000-0000-4000-8000-000000000004';
    const csrf='logger-only-fixture-csrf';
    const expiresAt=new Date(Date.now()+3600000);
    let readAdmissions=0;
    // Logger-only fake SQL gives this request a live owner session. It never
    // contacts PostgreSQL and is not evidence for authorization correctness.
    const db=async(parts)=>{
      const statement=parts.join(' ');
      if(statement.includes('engineo_planner_view_charge_rate')){readAdmissions++;return [];}
      if(/FROM auth_sessions s/.test(statement))return [{session_id:sessionId,user_id:actorId,email:'logger@example.test',display_name:null,expires_at:expiresAt}];
      if(/SELECT csrf_hash_sha256/.test(statement))return [{csrf_hash_sha256:createHash('sha256').update(csrf).digest('hex')}];
      if(/FROM auth_sessions/.test(statement))return [{id:sessionId,expires_at:expiresAt}];
      if(/UPDATE auth_sessions/.test(statement))return [];
      if(/FROM organization_memberships/.test(statement))return [{role:'owner'}];
      if(/FROM project_memberships/.test(statement))return [];
      if(/FROM projects/.test(statement))return [{id:projectId}];
      throw new Error('Unexpected logger-fixture SQL boundary');
    };
    db.begin=async(callback)=>callback(db);
    const app=buildApp({database:db,scheduleRunner:{getEngineVersion:async()=>null,calculate:async()=>{throw new Error('Unexpected schedule calculation');}}});
    const base='/organizations/'+organizationId+'/projects/'+projectId+'/views';
    const unknownQuery=await app.inject({method:'GET',url:base+'?'+${JSON.stringify(queryMarker)}+'=unknown'});
    const malformedBody=await app.inject({method:'POST',url:base+'/validate',headers:{origin:process.env.APP_ORIGIN,
      cookie:'engineo_session=logger-only-token; engineo_csrf='+csrf,'x-csrf-token':csrf,'x-engineo-session':sessionId,
      'content-type':'application/json'},payload:'{"configuration":{"name":"'+${JSON.stringify(bodyMarker)}+'",}}'});
    const legacy=await app.inject({method:'GET',url:'/health'});
    await app.close();
    await new Promise(resolve=>setImmediate(resolve));
    process.stdout.write(JSON.stringify({probeStatuses:[unknownQuery.statusCode,malformedBody.statusCode,legacy.statusCode],readAdmissions})+'\\n');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "production",
      APP_ORIGIN: "https://engineo.example.test",
      COOKIE_SECURE: "true",
    },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(child.status, 0, "Production logger fixture child must complete successfully");
  assert.equal(child.signal, null);
  assert.equal(child.stderr.includes(queryMarker), false);
  assert.equal(child.stderr.includes(bodyMarker), false);
  assert.equal(
    child.stdout.includes(queryMarker),
    false,
    "Private query text must never enter default request logs",
  );
  assert.equal(
    child.stdout.includes(bodyMarker),
    false,
    "Original private-view source bytes must never enter default logs",
  );
  const records = child.stdout
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          probeStatuses?: number[];
          readAdmissions?: number;
          req?: { url?: string };
          msg?: string;
        },
    );
  const probe = records.find((record) => record.probeStatuses);
  assert.ok(probe);
  assert.deepEqual(probe.probeStatuses, [401, 422, 200]);
  assert.equal(
    probe.readAdmissions,
    1,
    "Authenticated malformed body reaches shared read admission before parsing",
  );
  assert.ok(
    records.some((record) => record.req?.url === "/health" && record.msg === "incoming request"),
    "Legacy request logging stays enabled outside the private-view scope",
  );
  assert.equal(
    records.some((record) => record.req?.url?.includes("/views")),
    false,
  );
});
