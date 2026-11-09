import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAuthFilePath, resolveAuth } from "./auth";

export type Observed = {
  state: "unknown" | "available" | "exhausted" | "reauth";
  reason: "session" | "weekly" | "unauthorized" | null;
  retryAt: number | null;
  retryBasis: "provider" | "local_probe" | null;
  failureCount: number;
};
export type Account = { id: string; name: string; generation: number; authToken: string; appliedAt: number; observed: Observed };
type Config = { schemaVersion: 1; revision: number; mode: "legacy" | "pool"; accounts: Account[] };
export type TokenTarget = { expectedRevision: number; id?: string; generation?: number; name?: string };
export type Lease = { account: Account; observation: number };
export class AccountError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const initialObserved = (): Observed => ({ state: "unknown", reason: null, retryAt: null, retryBasis: null, failureCount: 0 });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function getAccountsFilePath(): string {
  const configured = process.env.HERMIT_ACCOUNTS_FILE;
  if (configured && !path.isAbsolute(configured)) throw new AccountError(503, "credential_config_error");
  return configured || path.join(path.dirname(getAuthFilePath()), ".hermit-accounts.json");
}
function validConfig(c: any): c is Config {
  if (c?.schemaVersion !== 1 || !Number.isSafeInteger(c.revision) || c.revision < 0 || !["legacy", "pool"].includes(c.mode) || !Array.isArray(c.accounts)) return false;
  const ids = new Set(), tokens = new Set();
  return c.accounts.every((a: any) => {
    const o = a?.observed;
    if (!a || typeof a.id !== "string" || !a.id || ids.has(a.id) || typeof a.name !== "string" || !a.name.trim() ||
        !Number.isSafeInteger(a.generation) || a.generation < 1 || typeof a.authToken !== "string" || !a.authToken || tokens.has(a.authToken) ||
        !Number.isFinite(a.appliedAt) || !o || !["unknown", "available", "exhausted", "reauth"].includes(o.state) ||
        ![null, "session", "weekly", "unauthorized"].includes(o.reason) || ![null, "provider", "local_probe"].includes(o.retryBasis) ||
        !(o.retryAt === null || (Number.isSafeInteger(o.retryAt) && o.retryAt >= 0 && o.retryAt <= 8640000000000000)) ||
        !Number.isSafeInteger(o.failureCount) || o.failureCount < 0) return false;
    ids.add(a.id); tokens.add(a.authToken); return true;
  });
}

/** Sole owner of configuration, secrets and observations. Synchronous mutations serialize
 * revision checks and atomic writes; network verification never holds this critical section. */
export class AccountStore {
  private config: Config = { schemaVersion: 1, revision: 0, mode: "legacy", accounts: [] };
  private broken = false;
  private saveFailed = false;
  private observations = new Map<string, number>();
  constructor(readonly filePath: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!validConfig(parsed)) throw new Error("invalid configuration");
      this.config = parsed;
    } catch (e: any) { if (e.code !== "ENOENT") this.broken = true; }
  }
  assertValid() { if (this.broken) throw new AccountError(503, "credential_config_error"); }
  isPool(): boolean { this.assertValid(); return this.config.mode === "pool" && resolveAuth().method !== "env-api-key"; }
  view() {
    const auth = resolveAuth();
    return { revision: this.config.revision, mode: this.config.mode,
      effectiveSource: this.broken ? "credential_config_error" : auth.method === "env-api-key" ? "env-api-key" : this.config.mode === "pool" ? "pool" : auth.method,
      configError: this.broken, observationSaveFailed: this.saveFailed,
      accounts: this.config.accounts.map(({ authToken: _, ...a }) => ({ ...copy(a), credential: "登録済み" })) };
  }
  private persist(next: Config) {
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.filePath);
    } catch { try { fs.unlinkSync(tmp); } catch {} throw new AccountError(503, "credential_save_failed"); }
  }
  private checkRevision(revision: unknown) {
    this.assertValid();
    if (!Number.isSafeInteger(revision)) throw new AccountError(400, "expectedRevision_required");
    if (revision !== this.config.revision) throw new AccountError(409, "configuration_changed");
  }
  checkTarget(target: TokenTarget) {
    this.checkRevision(target.expectedRevision);
    if (target.id !== undefined) {
      const a = this.config.accounts.find(a => a.id === target.id);
      if (!a || a.generation !== target.generation) throw new AccountError(409, "account_changed");
    } else if (typeof target.name !== "string" || !target.name.trim()) throw new AccountError(400, "account_name_required");
  }
  private commit(next: Config) { next.revision++; this.persist(next); this.config = next; this.saveFailed = false; }
  saveToken(target: TokenTarget, token: string) {
    this.checkTarget(target);
    if (this.config.accounts.some(a => a.authToken === token && a.id !== target.id)) throw new AccountError(409, "duplicate_token");
    const next = copy(this.config);
    if (target.id) {
      const a = next.accounts.find(a => a.id === target.id)!;
      a.authToken = token; a.generation++; a.appliedAt = Date.now(); a.observed = initialObserved();
    } else next.accounts.push({ id: randomUUID(), name: target.name!.trim(), generation: 1, authToken: token, appliedAt: Date.now(), observed: initialObserved() });
    this.commit(next);
    if (target.id) { this.observations.delete(target.id); }
  }
  mutate(input: any) {
    if (!input || typeof input !== "object") throw new AccountError(400, "invalid_action");
    this.checkRevision(input.expectedRevision);
    if (input.action === "import") {
      const auth = resolveAuth();
      if (!("authToken" in auth)) throw new AccountError(400, "legacy_bearer_unavailable");
      this.saveToken({ expectedRevision: input.expectedRevision, name: input.name }, auth.authToken); return;
    }
    const next = copy(this.config);
    const account = next.accounts.find(a => a.id === input.id);
    switch (input.action) {
      case "mode":
        if (!["legacy", "pool"].includes(input.mode)) throw new AccountError(400, "invalid_mode");
        if (input.mode === "pool" && resolveAuth().method === "env-api-key") throw new AccountError(409, "api_key_has_priority");
        next.mode = input.mode; break;
      case "rename":
        if (!account || typeof input.name !== "string" || !input.name.trim()) throw new AccountError(400, "invalid_account");
        account.name = input.name.trim(); break;
      case "delete":
        if (!account) throw new AccountError(400, "invalid_account");
        next.accounts = next.accounts.filter(a => a.id !== input.id); break;
      case "reorder":
        if (!Array.isArray(input.ids) || input.ids.length !== next.accounts.length || new Set(input.ids).size !== next.accounts.length || input.ids.some((id: any) => !next.accounts.some(a => a.id === id))) throw new AccountError(400, "invalid_order");
        next.accounts = input.ids.map((id: string) => next.accounts.find(a => a.id === id)!); break;
      default: throw new AccountError(400, "invalid_action");
    }
    this.commit(next);
    if (input.action === "delete") { this.observations.delete(input.id); }
  }
  snapshot(): string[] {
    this.assertValid();
    return this.config.accounts.filter(a => a.observed.state !== "reauth").map(a => a.id);
  }
  acquire(id: string): Lease | undefined {
    const a = this.config.accounts.find(a => a.id === id);
    if (!a || a.observed.state === "reauth") return;
    return { account: copy(a), observation: this.observations.get(id) ?? 0 };
  }
  observe(lease: Lease, observed: Observed, success = false) {
    const a = this.config.accounts.find(a => a.id === lease.account.id && a.generation === lease.account.generation);
    if (!a || (success && (this.observations.get(a.id) ?? 0) !== lease.observation)) return;
    a.observed = observed;
    this.observations.set(a.id, (this.observations.get(a.id) ?? 0) + 1);
    try { this.persist(this.config); this.saveFailed = false; } catch { this.saveFailed = true; }
  }
  succeed(lease: Lease) { this.observe(lease, { ...initialObserved(), state: "available" }, true); }
  unavailable(now = Date.now()): { status: number; code: string; retryAfter?: string } {
    this.assertValid();
    const accounts = this.config.accounts;
    if (accounts.length && accounts.every(a => a.observed.state === "exhausted")) {
      const times = accounts.map(a => a.observed.retryAt).filter((time): time is number => time !== null);
      return { status: 429, code: "all_accounts_exhausted", ...(times.length === accounts.length ? { retryAfter: String(Math.max(1, Math.ceil((Math.min(...times) - now) / 1000))) } : {}) };
    }
    return { status: 503, code: "credentials_unavailable" };
  }
}
let singleton: AccountStore | undefined;
export function getAccountStore(): AccountStore {
  const file = getAccountsFilePath();
  if (!singleton || singleton.filePath !== file) singleton = new AccountStore(file);
  return singleton;
}
