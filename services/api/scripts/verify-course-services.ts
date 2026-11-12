// Checks the API's course-service clients against the REAL course services, before any deploy:
// it runs our own client code (src/billing/stripe.ts, src/numbers/didww.ts), not hand-written
// requests, so a pass means the code works against the clones (docs/verify-backlog.md).
//
//   cd services/api
//   npx tsx scripts/verify-course-services.ts stripe            # V-S3, V-S4: free (test mode)
//   npx tsx scripts/verify-course-services.ts didww-buy --yes   # V-D6, V-D7: BUYS one local number
//
// Secrets come from the environment and are never printed. In Git Bash / WSL:
//   read -rsp "Stripe secret key: " STRIPE_SECRET_KEY; echo; export STRIPE_SECRET_KEY
//   read -rsp "Stripe publishable key: " STRIPE_PUBLISHABLE_KEY; echo; export STRIPE_PUBLISHABLE_KEY
//   read -rsp "DIDWW Api-Key: " DID_PROVIDER_API_KEY; echo; export DID_PROVIDER_API_KEY
//
// stripe: creates test-mode customers in the gateway clone and charges $1.00 to Stripe's test
// PaymentMethod tokens (pm_card_visa, pm_card_chargeDeclined): no card numbers, no real money
// ("charges to cards you enter yourself deposit nothing").
// didww-buy: orders ONE local number from the DID provider (spends its prepaid balance: SKU setup
// + one 7-day period) and assigns it to our trunk group. Keep it as the test number (test_did).
import { randomUUID } from 'node:crypto';
import { HttpStripeClient } from '../src/billing/stripe.js';
import { HttpDidwwProvider } from '../src/numbers/didww.js';

const STRIPE_URL = process.env.STRIPE_API_URL ?? 'https://stripe.cse356.compas.cs.stonybrook.edu';
const DIDWW_URL = process.env.DID_PROVIDER_URL ?? 'https://didww.cse356.compas.cs.stonybrook.edu/v3';
const TRUNK_GROUP = process.env.DID_TRUNK_GROUP_ID ?? '4fba3ce0-568d-4a88-879b-d767f26eca4c';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
const need = (name: string) => {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name} in the environment (see the header of this file)`);
    process.exit(2);
  }
  return v;
};
const key = () => randomUUID();

/** What Stripe.js does in the browser: confirm the SetupIntent with the publishable key. */
async function confirmAsBrowser(setupIntentId: string, clientSecret: string, paymentMethod: string, pk: string) {
  const form = new URLSearchParams({ client_secret: clientSecret, payment_method: paymentMethod });
  const res = await fetch(new URL(`/v1/setup_intents/${encodeURIComponent(setupIntentId)}/confirm`, STRIPE_URL), {
    method: 'POST',
    headers: { authorization: `Bearer ${pk}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: { message?: string } };
  return { http: res.status, status: body.status, error: body.error?.message };
}

async function stripe() {
  const sk = need('STRIPE_SECRET_KEY');
  const pk = need('STRIPE_PUBLISHABLE_KEY');
  const s = new HttpStripeClient(STRIPE_URL, sk);
  console.log(`== Stripe clone (${STRIPE_URL}) through HttpStripeClient`);
  const tenantId = `verify-${Date.now()}`;

  /** Saves a card the way the browser + POST /billing/card do. expectDeclined: the clone must refuse it. */
  async function savedCard(pm: string, expectDeclined = false) {
    const cust = await s.createCustomer({ name: 'Verify Co', email: `${tenantId}@example.test`, tenantId }, key());
    check('createCustomer (metadata[tenant_id])', cust.id.startsWith('cus_') || cust.id.length > 0, cust.id);
    const si = await s.createSetupIntent(cust.id, key());
    check('createSetupIntent (usage=off_session, payment_method_types[]=card)', !!si.clientSecret, `status ${si.status}`);
    const conf = await confirmAsBrowser(si.id, si.clientSecret, pm, pk);
    if (expectDeclined) {
      // The clone declines this card when it is SAVED (real Stripe may only decline the charge).
      // POST /billing/card must then answer 400 card_not_saved: it does when the SetupIntent didn't
      // succeed (src/billing/account.ts), which is what we check here.
      const after = await s.retrieveSetupIntent(si.id);
      check(`${pm}: declined when saved, SetupIntent not succeeded (API answers 400 card_not_saved)`, conf.http !== 200 && after.status !== 'succeeded', `${conf.error ?? conf.status}; SetupIntent ${after.status}`);
      return null;
    }
    check(`browser-style confirm with ${pm} (publishable key)`, conf.http === 200, conf.error ?? `status ${conf.status}`);
    const after = await s.retrieveSetupIntent(si.id);
    check('retrieveSetupIntent: succeeded + payment_method', after.status === 'succeeded' && !!after.paymentMethod, `${after.status} ${after.paymentMethod ?? ''}`);
    if (!after.paymentMethod) return null;
    await s.setDefaultPaymentMethod(cust.id, after.paymentMethod, key());
    check('setDefaultPaymentMethod (invoice_settings[default_payment_method])', true);
    const card = await s.retrieveCard(after.paymentMethod);
    check('retrieveCard: brand + last4', !!card.brand && !!card.last4, `${card.brand} ${card.last4}`);
    return { customerId: cust.id, paymentMethodId: after.paymentMethod };
  }

  const good = await savedCard('pm_card_visa');
  if (good) {
    const k = key();
    const r = await s.charge({ ...good, amountCents: 100, description: 'verify: $1.00 test charge', tenantId }, k);
    check('charge off_session + confirm (pm_card_visa) succeeds', r.ok, r.ok ? r.paymentIntentId : r.message);
    const again = await s.charge({ ...good, amountCents: 100, description: 'verify: $1.00 test charge', tenantId }, k);
    check('same Idempotency-Key returns the same PaymentIntent (no double charge)', r.ok && again.ok && again.paymentIntentId === r.paymentIntentId, again.ok ? again.paymentIntentId : again.message);
    const ceil = await s.charge({ ...good, amountCents: 99_999, description: 'verify: large charge', tenantId }, key());
    console.log(`  info  $999.99 to pm_card_visa: ${ceil.ok ? 'succeeded' : `declined (${ceil.message})`} (simulated customers' cards decline above the ceilings; our own test card shouldn't)`);
  }
  // Decline when the card is saved (signup / new card: the API must refuse it, not charge it).
  await savedCard('pm_card_chargeDeclined', true);
  // Saved fine, then the charge fails (renewal / overdue invoice: a decline result, not an
  // exception, so the scheduler retries and past-due logic runs).
  const bad = await savedCard('pm_card_chargeCustomerFail');
  if (bad) {
    const r = await s.charge({ ...bad, amountCents: 100, description: 'verify: declined charge', tenantId }, key());
    check('pm_card_chargeCustomerFail: the charge comes back as a decline result (not an exception)', !r.ok, r.ok ? 'it succeeded!' : r.message);
  }
}

async function didwwBuy() {
  if (!process.argv.includes('--yes')) {
    console.error('didww-buy spends the DID provider balance (one local number). Re-run with --yes.');
    process.exit(2);
  }
  const d = new HttpDidwwProvider({
    baseUrl: DIDWW_URL,
    apiKey: need('DID_PROVIDER_API_KEY'),
    trunk: { type: 'voice_in_trunk_groups', id: TRUNK_GROUP },
  });
  console.log(`== DIDWW clone (${DIDWW_URL}) through HttpDidwwProvider`);
  const offers = await d.searchAvailable({ country: 'US', areaCode: '631', kind: 'local', limit: 3 });
  check('searchAvailable(US, 631, local)', offers.length > 0, offers.map((o) => `${o.number} ${o.city ?? ''}`).join(', '));
  const pick = offers[0];
  if (!pick) return;
  const fresh = await d.getAvailable(pick.id);
  check('getAvailable(offer id)', fresh?.number === pick.number, `${fresh?.number} sku ${fresh?.skuId}`);
  if (!fresh) return;
  let res = await d.order(fresh);
  check('order (did_order_items {sku_id, available_did_id})', !!res.orderId, `order ${res.orderId}, did ${res.did?.number ?? 'pending'}`);
  for (let i = 0; !res.did && i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await d.getOrder(res.orderId);
  }
  check('order completes and the DID is found', !!res.did, res.did ? `${res.did.number} (${res.did.id})` : 'still pending after 20 s');
  if (!res.did) return;
  await d.assignToTrunk(res.did.id);
  check('assignToTrunk (PATCH /dids/:id voice_in_trunk_group)', true, `group ${TRUNK_GROUP}`);
  const owned = await d.findOwnedDid(res.did.number);
  check('findOwnedDid(number)', owned?.id === res.did.id, owned?.number ?? 'not found');
  console.log(`\n  Bought ${res.did.number}. Keep it as the test number: deploy with -e test_did=${res.did.number}`);
  console.log('  Check the assignment: GET /dids/<id>?include=voice_in_trunk_group (verify-backlog V-D7).');
}

const cmd = process.argv[2];
const run = cmd === 'stripe' ? stripe : cmd === 'didww-buy' ? didwwBuy : null;
if (!run) {
  console.error('usage: npx tsx scripts/verify-course-services.ts stripe | didww-buy --yes');
  process.exit(2);
}
run()
  .catch((err: unknown) => {
    failures++;
    // Our clients' errors carry status + the provider's first error message, never the keys.
    console.log(`  FAIL  ${(err as Error).message}`);
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exitCode = failures ? 1 : 0;
  });
