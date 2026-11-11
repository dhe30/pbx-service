import { useEffect, useState } from "react";
import { apiErrorMessage, dataService, type BillingPrices, type BillingState, type Invoice } from "../../services";

function money(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100);
}

export function Billing() {
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [prices, setPrices] = useState<BillingPrices | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([dataService.getBilling(), dataService.getBillingPrices(), dataService.getInvoices()])
      .then(([state, catalog, invoiceList]) => {
        if (!active) return;
        setBilling(state);
        setPrices(catalog);
        setInvoices(invoiceList);
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load billing information."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">Billing</h1>
        <p className="mt-2 text-gray-500">Current account billing state and invoices from the backend.</p>
      </header>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {loading && <p role="status" className="text-sm text-gray-500">Loading billing information…</p>}

      {billing && prices && (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-500">Payment method</p>
            <p className="mt-2 font-semibold text-gray-900">{billing.card ? `${billing.card.brand ?? "Card"} ending in ${billing.card.last4 ?? "—"}` : "No card on file"}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-500">Current plan</p>
            <p className="mt-2 font-semibold text-gray-900">{prices.plan.name} · {money(prices.plan.priceCents)} / 7 days</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-500">Extensions</p>
            <p className="mt-2 font-semibold text-gray-900">{billing.extensions.used} used / {billing.extensions.allowed} allowed</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-500">Current billing period</p>
            <p className="mt-2 font-semibold text-gray-900">{new Date(billing.currentPeriod.start).toLocaleDateString()} – {new Date(billing.currentPeriod.end).toLocaleDateString()}</p>
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-5">
          <h2 className="font-semibold text-gray-900">Invoices</h2>
          <p className="mt-1 text-sm text-gray-500">Historical invoices returned by the billing API.</p>
        </div>
        {invoices.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr><th className="px-5 py-3">Created</th><th className="px-5 py-3">Period</th><th className="px-5 py-3">Recurring</th><th className="px-5 py-3">Usage</th><th className="px-5 py-3">Total</th><th className="px-5 py-3">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="px-5 py-4 text-gray-700">{new Date(invoice.createdAt).toLocaleDateString()}</td>
                    <td className="px-5 py-4 text-gray-700">{new Date(invoice.periodStart).toLocaleDateString()} – {new Date(invoice.periodEnd).toLocaleDateString()}</td>
                    <td className="px-5 py-4 text-gray-700">{money(invoice.recurringCents)}</td>
                    <td className="px-5 py-4 text-gray-700">{money(invoice.usageCents)}</td>
                    <td className="px-5 py-4 font-medium text-gray-900">{money(invoice.totalCents)}</td>
                    <td className="px-5 py-4 capitalize text-gray-700">{invoice.pastDue ? "past due" : invoice.status.replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !loading && !error && <p className="p-8 text-center text-sm text-gray-500">No invoices are available.</p>}
      </section>

      {!loading && !billing?.card && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No payment method is currently available. Card management is not exposed by the current API.
        </p>
      )}
    </div>
  );
}
