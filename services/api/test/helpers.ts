import { createDb, type Sql } from '@pbx/shared';
import { buildApp, type AppConfig, type AppDeps } from '../src/app.js';
import { StripeError, type Card, type ChargeResult, type SetupIntent, type StripeClient } from '../src/billing/stripe.js';

export const testConfig: AppConfig = {
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'test-secret-at-least-16-chars',
  ACCESS_TOKEN_TTL_SEC: 900,
  REFRESH_TOKEN_TTL_SEC: 7 * 86400,
  COOKIE_SECURE: true,
  SIP_WS_URI: 'wss://pbx.test/ws',
  SIP_DOMAIN: 'pbx.test',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_fake',
  STRIPE_JS_URL: 'https://stripe.test/v3/',
};

/**
 * In-memory stand-in for the payment gateway. completeSetup() plays the browser's Stripe.js
 * confirmCardSetup; declineWith makes the next charges fail. Like Stripe, a repeated
 * Idempotency-Key returns the first result.
 */
export class FakeStripe implements StripeClient {
  customers = new Map<string, { name: string; email: string; tenantId: string }>();
  setupIntents = new Map<string, SetupIntent>();
  cards = new Map<string, Card>();
  defaults = new Map<string, string>();
  charges: { key: string; customerId: string; paymentMethodId: string; amountCents: number; result: ChargeResult }[] = [];
  declineWith: string | null = null;
  /** Make every call fail (gateway down). */
  down = false;
  private seq = 0;
  private byKey = new Map<string, unknown>();

  private next(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }
  private check() {
    if (this.down) throw new StripeError('gateway down', null);
  }
  private once<T>(key: string, make: () => T): T {
    if (!this.byKey.has(key)) this.byKey.set(key, make());
    return this.byKey.get(key) as T;
  }

  async createCustomer(p: { name: string; email: string; tenantId: string }, key: string) {
    this.check();
    return this.once(key, () => {
      const id = this.next('cus');
      this.customers.set(id, p);
      return { id };
    });
  }
  async createSetupIntent(customerId: string, key: string) {
    this.check();
    return this.once(key, () => {
      const id = this.next('seti');
      const si = { id, clientSecret: `${id}_secret`, status: 'requires_payment_method', customer: customerId, paymentMethod: null };
      this.setupIntents.set(id, si);
      return { ...si };
    });
  }
  async retrieveSetupIntent(id: string) {
    this.check();
    const si = this.setupIntents.get(id);
    if (!si) throw new StripeError('No such setupintent', 404);
    return { ...si };
  }
  async setDefaultPaymentMethod(customerId: string, pm: string) {
    this.check();
    this.defaults.set(customerId, pm);
  }
  async retrieveCard(pm: string) {
    this.check();
    return this.cards.get(pm) ?? { brand: null, last4: null };
  }
  async charge(p: { customerId: string; paymentMethodId: string; amountCents: number }, key: string) {
    this.check();
    return this.once(key, () => {
      const result: ChargeResult = this.declineWith
        ? { ok: false, paymentIntentId: this.next('pi'), message: this.declineWith }
        : { ok: true, paymentIntentId: this.next('pi') };
      this.charges.push({ key, ...p, result });
      return result;
    });
  }

  /** What Stripe.js confirmCardSetup does in the browser. Returns the new payment method id. */
  completeSetup(setupIntentId: string, card: Card = { brand: 'visa', last4: '4242' }): string {
    const si = this.setupIntents.get(setupIntentId)!;
    const pm = this.next('pm');
    this.cards.set(pm, card);
    this.setupIntents.set(setupIntentId, { ...si, status: 'succeeded', paymentMethod: pm });
    return pm;
  }
}

/** Marks a tenant created directly in SQL as paid, with room for `extensions` extensions. */
export async function payPlan(sql: Sql, tenantId: string, extensions = 20): Promise<void> {
  await sql`
    insert into tenant_settings (tenant_id, included_extensions) values (${tenantId}, ${extensions})
    on conflict (tenant_id) do update set included_extensions = excluded.included_extensions`;
  await sql`
    insert into billing_accounts (tenant_id, stripe_customer_id, plan_paid_through)
    values (${tenantId}, ${`cus_test_${tenantId}`}, now() + interval '7 days')
    on conflict (tenant_id) do nothing`;
}

/** Local docker-compose Postgres (npm run dev:up && npm run db:migrate). Override with TEST_DATABASE_URL. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://pbx:pbx@127.0.0.1:5432/pbx?sslmode=disable';

/** postgres.js connects lazily, so this never touches the network unless a query runs. */
export const unusedDb = (): Sql => createDb('postgres://unused@127.0.0.1:1/unused');

export function build(deps: Partial<AppDeps> = {}, cfg: Partial<AppConfig> = {}) {
  return buildApp(
    { ...testConfig, ...cfg },
    {
      sql: unusedDb(),
      readinessChecks: { db: async () => {}, objectStore: async () => {} },
      isDraining: () => false,
      stripe: new FakeStripe(),
      ...deps,
    },
  );
}

/** Returns a connected test DB, or null if it isn't running (DB tests are then skipped). */
export async function connectTestDb(): Promise<Sql | null> {
  const sql = createDb(TEST_DATABASE_URL, { max: 5, applicationName: 'api-test' });
  try {
    await sql`select 1 from users limit 1`; // also proves migrations ran
    return sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    return null;
  }
}
