import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authenticateCredentials,
  authenticateRequest,
  assertEntitlement,
  assertResourceAccess,
  authSetupRequired,
  createSession,
  consumeRenderAllowance,
  deleteSession,
  hashPassword,
  registerOwner,
  verifyPassword,
} from "../local-service/auth.mjs";
import {
  closeDatabase,
  getDatabase,
  getDatabasePath,
  initializeDatabase,
  readWorkspaceState,
  writeWorkspaceState,
} from "../local-service/database.mjs";

test("stores the local workspace in SQLite and protects it with subscription entitlements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelio-auth-db-"));
  try {
    initializeDatabase(root);
    assert.equal(authSetupRequired(), true);
    writeWorkspaceState({ jobs: [], automations: [], calendarEntries: [], toolJobs: [], toolInputs: [], brandKit: null });
    assert.deepEqual(readWorkspaceState().jobs, []);

    const user = await registerOwner({
      email: "Creator@Example.com",
      password: "correct horse battery staple",
      displayName: "Reelio Creator",
    });
    assert.equal(user.email, "creator@example.com");
    assert.equal(user.subscription.planCode, "studio");
    assert.ok(user.entitlements.includes("automations.manage"));
    assert.equal(authSetupRequired(), false);
    await assert.rejects(
      registerOwner({ email: "other@example.com", password: "another secure password", displayName: "Other User" }),
      /already has an account/,
    );

    const authenticated = await authenticateCredentials("creator@example.com", "correct horse battery staple");
    assert.equal(authenticated.id, user.id);
    await assert.rejects(authenticateCredentials("creator@example.com", "wrong password"), /incorrect/);

    const session = createSession(user.id);
    const request = { headers: { cookie: `reelio_session=${session.token}` }, socket: {} };
    assert.equal(authenticateRequest(request)?.user.email, "creator@example.com");
    getDatabase().prepare("UPDATE subscriptions SET plan_code = 'free', included_renders = 3 WHERE user_id = ?").run(user.id);
    const freeIdentity = authenticateRequest(request);
    assert.equal(freeIdentity.user.subscription.planCode, "free");
    assert.doesNotThrow(() => assertEntitlement(freeIdentity, "mode.prompt"));
    assert.throws(() => assertEntitlement(freeIdentity, "mode.long"), /free plan does not include/);
    assert.doesNotThrow(() => assertResourceAccess(freeIdentity, { ownerUserId: user.id }));
    assert.throws(() => assertResourceAccess(freeIdentity, { ownerUserId: "another-user" }), /another account/);
    assert.equal(consumeRenderAllowance(user.id).rendersUsed, 1);
    getDatabase().prepare("UPDATE subscriptions SET renders_used = included_renders WHERE user_id = ?").run(user.id);
    assert.throws(() => consumeRenderAllowance(user.id), /3-render limit/);
    deleteSession(request);
    assert.equal(authenticateRequest(request), null);
    await access(getDatabasePath());
  } finally {
    closeDatabase();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses salted scrypt password hashes", async () => {
  const first = await hashPassword("a sufficiently long password");
  const second = await hashPassword("a sufficiently long password");
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("a sufficiently long password", first), true);
  assert.equal(await verifyPassword("not the password", first), false);
});
