import { APIError } from "@anthropic-ai/sdk";
import { AccountStore, Lease } from "./accounts";
import { buildAuthTokenClient } from "./auth";
import { classifyExhaustion, exhaustionObservation } from "./rate_limit";

export class PoolUnavailableError extends Error {
  constructor(public status: number, public code: string, public retryAfter?: string) { super(code); }
}
/** Derived clients only; configuration and observation authority remains in AccountStore. */
export class AccountRouter {
  private clients = new Map<string, { generation: number; client: ReturnType<typeof buildAuthTokenClient> }>();
  constructor(private store: AccountStore) {}
  private client(lease: Lease) {
    const { id, generation, authToken } = lease.account;
    const ids = new Set(this.store.view().accounts.map(a => a.id));
    for (const key of this.clients.keys()) if (!ids.has(key)) this.clients.delete(key);
    let cached = this.clients.get(id);
    if (!cached || cached.generation !== generation) {
      cached = { generation, client: buildAuthTokenClient(authToken, { maxRetries: 0 }) };
      this.clients.set(id, cached);
    }
    return cached.client;
  }
  async run<T>(signal: AbortSignal | undefined, send: (client: ReturnType<typeof buildAuthTokenClient>, token: string, opened: () => void) => Promise<T>): Promise<T> {
    const ids = this.store.snapshot();
    for (const id of ids) {
      signal?.throwIfAborted();
      const lease = this.store.acquire(id);
      if (!lease) continue;
      let opened = false;
      try {
        const result = await send(this.client(lease), lease.account.authToken, () => { opened = true; });
        signal?.throwIfAborted();
        this.store.succeed(lease);
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        const exhausted = classifyExhaustion(error);
        if (exhausted) {
          this.store.observe(lease, exhaustionObservation(error as APIError, exhausted));
          if (!opened) continue;
        } else if (error instanceof APIError && error.status === 401) {
          this.store.observe(lease, { state: "reauth", reason: "unauthorized", retryAt: null, retryBasis: null, failureCount: 0 });
        }
        throw error;
      }
    }
    const unavailable = this.store.unavailable();
    throw new PoolUnavailableError(unavailable.status, unavailable.code, unavailable.retryAfter);
  }
}
let router: AccountRouter | undefined;
let routerStore: AccountStore | undefined;
export function getAccountRouter(store: AccountStore): AccountRouter {
  if (routerStore !== store) { routerStore = store; router = new AccountRouter(store); }
  return router!;
}
