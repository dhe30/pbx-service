import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiErrorMessage, dataService, purchaseService, type BillingItem, type BillingPrices, type Country, type PhoneNumber } from "../../services";

interface AvailableNumber {
  id: string;
  number: string;
  kind: "local" | "toll_free";
  country: string;
  region: string | null;
  city: string | null;
  areaCode: string | null;
  priceCents: number;
  dueNowCents: number;
}

function money(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100);
}

export function Purchase() {
  const [countries, setCountries] = useState<Country[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [items, setItems] = useState<BillingItem[]>([]);
  const [prices, setPrices] = useState<BillingPrices | null>(null);
  const [offers, setOffers] = useState<AvailableNumber[]>([]);
  const [country, setCountry] = useState("US");
  const [areaCode, setAreaCode] = useState("");
  const [kind, setKind] = useState<"local" | "toll_free">("local");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [purchaseKeys, setPurchaseKeys] = useState<Record<string, string>>({});

  const refreshAccount = useCallback(async () => {
    const [ownedNumbers, billingItems] = await Promise.all([
      dataService.getNumbers(),
      dataService.getBillingItems(),
    ]);
    setNumbers(ownedNumbers);
    setItems(billingItems);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      dataService.getCountries(),
      dataService.getNumbers(),
      dataService.getBillingItems(),
      dataService.getBillingPrices(),
    ])
      .then(([countryList, ownedNumbers, billingItems, catalog]) => {
        if (!active) return;
        setCountries(countryList);
        setNumbers(ownedNumbers);
        setItems(billingItems);
        setPrices(catalog);
        const firstCountry = countryList[0];
        if (firstCountry && !countryList.some((item) => item.iso === country)) {
          setCountry(firstCountry.iso);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load purchasing options."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function searchNumbers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearching(true);
    setError("");
    setNotice("");
    try {
      const results = await purchaseService.searchNumbers({
        country,
        areaCode: kind === "local" && areaCode ? areaCode : undefined,
        kind,
        limit: 30,
      });
      setOffers(results as AvailableNumber[]);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not search available phone numbers."));
    } finally {
      setSearching(false);
    }
  }

  async function buyNumber(offer: AvailableNumber) {
    const key = purchaseKeys[offer.id] ?? crypto.randomUUID();
    if (!purchaseKeys[offer.id]) {
      setPurchaseKeys((current) => ({ ...current, [offer.id]: key }));
    }
    setBusyAction(offer.id);
    setError("");
    setNotice("");
    try {
      const result = await purchaseService.purchaseNumber(offer.id, key);
      if (result?.status === "processing") {
        setNotice(`The order for ${offer.number} is still processing. Retry this action to check again.`);
        return;
      }
      setNotice(`${offer.number} was purchased.`);
      setPurchaseKeys((current) => {
        const next = { ...current };
        delete next[offer.id];
        return next;
      });
      setOffers((current) => current.filter((item) => item.id !== offer.id));
      await refreshAccount();
    } catch (cause) {
      setError(apiErrorMessage(cause, `Could not purchase ${offer.number}.`));
    } finally {
      setBusyAction("");
    }
  }

  async function buyItem(kindToBuy: "extension" | "intl_calling" | "recording") {
    const key = crypto.randomUUID();
    setBusyAction(kindToBuy);
    setError("");
    setNotice("");
    try {
      await purchaseService.purchaseItem(kindToBuy, key);
      setNotice("Purchase completed.");
      await refreshAccount();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not complete the purchase."));
    } finally {
      setBusyAction("");
    }
  }

  async function cancelItem(item: BillingItem) {
    setBusyAction(item.id);
    setError("");
    setNotice("");
    try {
      await purchaseService.cancelItem(item.id);
      setNotice("Renewal cancelled. Service remains active through its paid period.");
      await refreshAccount();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not cancel this item."));
    } finally {
      setBusyAction("");
    }
  }

  async function releaseNumber(number: PhoneNumber) {
    setBusyAction(number.id);
    setError("");
    setNotice("");
    try {
      await purchaseService.releaseNumber(number.id);
      setNotice(`${number.did} was released.`);
      await refreshAccount();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not release this phone number."));
    } finally {
      setBusyAction("");
    }
  }

  const activeItems = items.filter((item) => item.renews);
  const hasActiveItem = (itemKind: BillingItem["kind"]) => activeItems.some((item) => item.kind === itemKind);

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">Purchase Services</h1>
        <p className="mt-2 text-gray-500">Options and prices are loaded from your PBX account.</p>
      </header>

      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-green-50 p-4 text-sm text-green-800">{notice}</p>}
      {loading && <p role="status" className="text-sm text-gray-500">Loading catalog…</p>}

      {prices && (
        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold text-gray-900">{prices.plan.name}</h2>
            <p className="mt-2 text-2xl font-bold text-gray-900">{money(prices.plan.priceCents)}<span className="text-sm font-normal text-gray-500"> / 7 days</span></p>
            <p className="mt-2 text-sm text-gray-500">{prices.plan.includedExtensions} included extensions · {prices.plan.includedUsMinutes} US minutes</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold text-gray-900">Additional extension</h2>
            <p className="mt-2 text-2xl font-bold text-gray-900">{money(prices.extensionCents)}<span className="text-sm font-normal text-gray-500"> / 7 days</span></p>
            <button type="button" disabled={busyAction === "extension"} onClick={() => void buyItem("extension")} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busyAction === "extension" ? "Processing…" : "Add extension"}
            </button>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold text-gray-900">Call add-ons</h2>
            <p className="mt-2 text-sm text-gray-600">International calling: {money(prices.intlCallingCents)} / 7 days</p>
            <p className="mt-1 text-sm text-gray-600">Call recording: {money(prices.recordingCents)} / 7 days</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" disabled={hasActiveItem("intl_calling") || busyAction === "intl_calling"} onClick={() => void buyItem("intl_calling")} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">
                {hasActiveItem("intl_calling") ? "International active" : "Enable international"}
              </button>
              <button type="button" disabled={hasActiveItem("recording") || busyAction === "recording"} onClick={() => void buyItem("recording")} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">
                {hasActiveItem("recording") ? "Recording active" : "Enable recording"}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Available phone numbers</h2>
          <p className="mt-1 text-sm text-gray-500">Search provider inventory and purchase an available number.</p>
        </div>
        <form onSubmit={(event) => void searchNumbers(event)} className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm text-gray-700">
            Country
            <select value={country} onChange={(event) => setCountry(event.target.value)} className="min-w-44 rounded-lg border border-gray-300 px-3 py-2">
              {countries.map((item) => <option key={item.iso} value={item.iso}>{item.name} (+{item.prefix})</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm text-gray-700">
            Number type
            <select value={kind} onChange={(event) => setKind(event.target.value as "local" | "toll_free")} className="rounded-lg border border-gray-300 px-3 py-2">
              <option value="local">Local</option>
              <option value="toll_free">Toll-free</option>
            </select>
          </label>
          {kind === "local" && (
            <label className="grid gap-1 text-sm text-gray-700">
              Area code (optional)
              <input value={areaCode} onChange={(event) => setAreaCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="w-36 rounded-lg border border-gray-300 px-3 py-2" inputMode="numeric" />
            </label>
          )}
          <button type="submit" disabled={searching || !countries.length} className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50">
            {searching ? "Searching…" : "Search numbers"}
          </button>
        </form>

        {offers.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr><th className="px-4 py-3">Number</th><th className="px-4 py-3">Location</th><th className="px-4 py-3">Price / 7 days</th><th className="px-4 py-3">Due now</th><th /></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {offers.map((offer) => (
                  <tr key={offer.id}>
                    <td className="px-4 py-3 font-medium text-gray-900">{offer.number}</td>
                    <td className="px-4 py-3 text-gray-600">{[offer.city, offer.region, offer.country].filter(Boolean).join(", ")}</td>
                    <td className="px-4 py-3 text-gray-600">{money(offer.priceCents)}</td>
                    <td className="px-4 py-3 text-gray-600">{money(offer.dueNowCents)}</td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" disabled={busyAction === offer.id} onClick={() => void buyNumber(offer)} className="rounded-lg bg-blue-600 px-3 py-2 font-medium text-white disabled:opacity-50">
                        {busyAction === offer.id ? "Processing…" : "Purchase"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!offers.length && !searching && <p className="text-sm text-gray-500">Search for available numbers to view current provider inventory.</p>}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-gray-900">Your numbers</h2>
        {numbers.length ? (
          <ul className="mt-4 divide-y divide-gray-100">
            {numbers.map((number) => (
              <li key={number.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium text-gray-900">{number.did}</p>
                  <p className="text-sm capitalize text-gray-500">{number.kind.replace("_", " ")} · {number.status}</p>
                </div>
                {number.status === "assigned" && (
                  <button type="button" disabled={busyAction === number.id} onClick={() => void releaseNumber(number)} className="text-sm font-medium text-red-600 disabled:opacity-50">
                    {busyAction === number.id ? "Releasing…" : "Release number"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-gray-500">No numbers are currently assigned.</p>}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-gray-900">Recurring items</h2>
        {activeItems.length ? (
          <ul className="mt-4 divide-y divide-gray-100">
            {activeItems.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium text-gray-900">{item.kind.replace("_", " ")}{item.did ? ` · ${item.did}` : ""}</p>
                  <p className="text-sm text-gray-500">{money(item.priceCents)} / 7 days · paid through {new Date(item.paidThrough).toLocaleDateString()}</p>
                </div>
                {item.kind !== "plan" && (
                  <button type="button" disabled={busyAction === item.id} onClick={() => void cancelItem(item)} className="text-sm font-medium text-red-600 disabled:opacity-50">Cancel renewal</button>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-gray-500">No active recurring items.</p>}
      </section>
    </div>
  );
}
