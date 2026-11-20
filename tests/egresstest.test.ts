// tests/egresstest.test.ts — TEMPORARY (removed in D20-3, D20-0 spike).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleEgressTest,
  type EgressStub,
  type EgressTestEnv,
} from "../src/routes/egresstest.js";

const TOKEN = "egress-admin-token-for-tests";

test("no token header: 403 forbidden, the actor is never touched", async () => {
  let probed = 0;
  const stub: EgressStub = {
    probe: () => {
      probed += 1;
      return Promise.resolve({ status: 401, ms: 1 });
    },
  };
  const env: EgressTestEnv = {
    ADMIN_TOKEN: TOKEN,
    DIRECTORY: { idFromName: () => stub },
  };
  const req = new Request("https://test.invalid/admin/egress-test", {
    method: "POST",
  });
  const res = await handleEgressTest(req, env);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, error: "forbidden" });
  assert.equal(probed, 0);
});
