import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountStore } from "./accounts";

function fixture(t: any) {
  const dir = fs.mkdtempSync(join(tmpdir(), "account-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "accounts.json");
  const store = new AccountStore(file);
  store.saveToken({ name: "first", expectedRevision: 0 }, "sk-ant-oat-fake-one");
  return { store, file };
}
test("AccountStore saves 0600, reloads observations and keeps secrets out of views", t => {
  const { store, file } = fixture(t);
  const lease = store.acquire(store.snapshot()[0])!;
  store.observe(lease, { state: "exhausted", reason: "weekly", retryAt: Date.now() + 100000, retryBasis: "provider", failureCount: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(store.view()).includes("sk-ant"), false);
  assert.deepEqual(new AccountStore(file).view(), store.view());
  assert.deepEqual(new AccountStore(file).snapshot(), store.view().accounts.map(a => a.id));
});
test("AccountStore preserves prior configuration on save failure, but retains rejection in memory", t => {
  const { store, file } = fixture(t);
  const before = store.view();
  fs.renameSync(file, file + ".saved"); fs.mkdirSync(file);
  assert.throws(() => store.mutate({ action: "rename", id: before.accounts[0].id, name: "lost", expectedRevision: before.revision }), /credential_save_failed/);
  assert.deepEqual(store.view(), before);
  const lease = store.acquire(store.snapshot()[0])!;
  store.observe(lease, { state: "reauth", reason: "unauthorized", retryAt: null, retryBasis: null, failureCount: 0 });
  assert.equal(store.view().observationSaveFailed, true);
  assert.deepEqual(store.snapshot(), []);
});
test("AccountStore rejects stale revisions, generations and invalid permutations without mutation", t => {
  const { store } = fixture(t);
  const a = store.view().accounts[0];
  store.saveToken({ expectedRevision: 1, id: a.id, generation: 1 }, "sk-ant-oat-fake-two");
  assert.throws(() => store.saveToken({ expectedRevision: 1, id: a.id, generation: 1 }, "sk-ant-oat-stale"), /configuration_changed/);
  assert.throws(() => store.saveToken({ expectedRevision: 2, id: a.id, generation: 1 }, "sk-ant-oat-stale"), /account_changed/);
  assert.throws(() => store.mutate({ expectedRevision: 2, action: "reorder", ids: [] }), /invalid_order/);
  assert.equal(store.acquire(a.id)!.account.authToken, "sk-ant-oat-fake-two");
});
test("AccountStore old successes and replaced generations cannot clear newer rejection; exhausted accounts remain eligible", t => {
  const { store } = fixture(t);
  const id = store.snapshot()[0], old = store.acquire(id)!, reject = store.acquire(id)!;
  store.observe(reject, { state: "exhausted", reason: "session", retryAt: 1, retryBasis: "local_probe", failureCount: 1 });
  store.succeed(old);
  assert.equal(store.view().accounts[0].observed.state, "exhausted");
  const next = store.acquire(id)!;
  assert.ok(store.acquire(id));
  store.succeed(next);
  assert.equal(store.view().accounts[0].observed.state, "available");
  const stale = store.acquire(id)!;
  store.saveToken({ expectedRevision: 1, id, generation: 1 }, "sk-ant-oat-replacement");
  store.observe(stale, { state: "reauth", reason: "unauthorized", retryAt: null, retryBasis: null, failureCount: 0 });
  assert.equal(store.view().accounts[0].observed.state, "unknown");
  store.mutate({ expectedRevision: 2, action: "delete", id });
  store.succeed(stale); assert.equal(store.view().accounts.length, 0);
});
test("AccountStore corrupt file does not fall back to legacy", t => {
  const { file } = fixture(t); fs.writeFileSync(file, '{"schemaVersion":1,"accounts":[]}');
  const store = new AccountStore(file);
  assert.equal(store.view().configError, true);
  assert.throws(() => store.isPool(), /credential_config_error/);
});
