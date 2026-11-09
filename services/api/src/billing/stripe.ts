// Minimal Stripe client for the course payment gateway (a Stripe clone: "Customers,
// PaymentMethods, SetupIntents, PaymentIntents, idempotent requests"). Plain fetch with
// form-encoded bodies, like Stripe's own REST API; no SDK, so the base URL can point at the clone.
//
// The secret key stays on the server. Card numbers never reach us: browsers save cards with
// Stripe.js (confirmCardSetup with the SetupIntent client_secret we return), and we only see ids.
// Every POST carries an Idempotency-Key, so retrying a request can never create or charge twice.
// [VERIFY] the clone's API base URL (default below) and that it accepts these exact parameters.

export interface SetupIntent {
  id: string;
  clientSecret: string;
  status: string;
  customer: string | null;
  paymentMethod: string | null;
}

export interface Card {
  brand: string | null;
  last4: string | null;
}

export type ChargeResult =
  | { ok: true; paymentIntentId: string }
  | { ok: false; paymentIntentId: string | null; message: string };

export interface StripeClient {
  createCustomer(p: { name: string; email: string; tenantId: string }, idempotencyKey: string): Promise<{ id: string }>;
  createSetupIntent(customerId: string, idempotencyKey: string): Promise<SetupIntent>;
  retrieveSetupIntent(id: string): Promise<SetupIntent>;
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string, idempotencyKey: string): Promise<void>;
  retrieveCard(paymentMethodId: string): Promise<Card>;
  /** Off-session charge of a saved card, confirmed immediately. Declines are results, not errors. */
  charge(
    p: { customerId: string; paymentMethodId: string; amountCents: number; description: string; tenantId: string },
    idempotencyKey: string,
  ): Promise<ChargeResult>;
}

/** Stripe answered with an error we don't handle as a result (bad request, auth, 5xx, timeout). */
export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

interface StripeObject {
  id: string;
  status?: string;
  client_secret?: string;
  customer?: string | { id: string } | null;
  payment_method?: string | { id: string } | null;
  card?: { brand?: string; last4?: string };
  last_payment_error?: { message?: string } | null;
}

const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === 'string' ? v : v.id);

const toSetupIntent = (o: StripeObject): SetupIntent => ({
  id: o.id,
  clientSecret: o.client_secret ?? '',
  status: o.status ?? 'unknown',
  customer: idOf(o.customer),
  paymentMethod: idOf(o.payment_method),
});

export class HttpStripeClient implements StripeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async createCustomer(p: { name: string; email: string; tenantId: string }, key: string) {
    const o = await this.request('POST', '/v1/customers', { name: p.name, email: p.email, 'metadata[tenant_id]': p.tenantId }, key);
    return { id: o.id };
  }

  async createSetupIntent(customerId: string, key: string) {
    const o = await this.request(
      'POST',
      '/v1/setup_intents',
      { customer: customerId, usage: 'off_session', 'payment_method_types[]': 'card' },
      key,
    );
    return toSetupIntent(o);
  }

  async retrieveSetupIntent(id: string) {
    return toSetupIntent(await this.request('GET', `/v1/setup_intents/${encodeURIComponent(id)}`));
  }

  async setDefaultPaymentMethod(customerId: string, paymentMethodId: string, key: string) {
    await this.request(
      'POST',
      `/v1/customers/${encodeURIComponent(customerId)}`,
      { 'invoice_settings[default_payment_method]': paymentMethodId },
      key,
    );
  }

  async retrieveCard(paymentMethodId: string) {
    const o = await this.request('GET', `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`);
    return { brand: o.card?.brand ?? null, last4: o.card?.last4 ?? null };
  }

  async charge(
    p: { customerId: string; paymentMethodId: string; amountCents: number; description: string; tenantId: string },
    key: string,
  ): Promise<ChargeResult> {
    try {
      const o = await this.request(
        'POST',
        '/v1/payment_intents',
        {
          amount: p.amountCents,
          currency: 'usd',
          customer: p.customerId,
          payment_method: p.paymentMethodId,
          confirm: true,
          off_session: true,
          description: p.description,
          'metadata[tenant_id]': p.tenantId,
        },
        key,
      );
      if (o.status === 'succeeded') return { ok: true, paymentIntentId: o.id };
      // requires_action (3-D Secure) can't be completed off-session: a failure (billing-flows §8.5).
      return { ok: false, paymentIntentId: o.id, message: o.last_payment_error?.message ?? `payment ${o.status}` };
    } catch (err) {
      // Card errors (declined, authentication_required) come back as HTTP 402.
      if (err instanceof StripeError && err.status === 402) {
        const e = (err.body as { error?: { message?: string; payment_intent?: { id?: string } } } | null)?.error;
        return { ok: false, paymentIntentId: e?.payment_intent?.id ?? null, message: e?.message ?? 'card declined' };
      }
      throw err;
    }
  }

  private async request(method: 'GET' | 'POST', path: string, params?: Params, idempotencyKey?: string): Promise<StripeObject> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.secretKey}` };
    let body: string | undefined;
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) form.append(k, String(v));
      body = form.toString();
    }
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new StripeError(`payment gateway unreachable: ${(err as Error).message}`, null);
    }
    const json = (await res.json().catch(() => null)) as (StripeObject & { error?: { message?: string } }) | null;
    if (!res.ok || !json) {
      throw new StripeError(json?.error?.message ?? `payment gateway answered ${res.status}`, res.status, json);
    }
    return json;
  }
}
