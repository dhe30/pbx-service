import { useEffect, useState } from "react";
import { apiErrorMessage, dataService, type CallLeg } from "../../services";

type Direction = "all" | CallLeg["direction"];
type DateRange = "all" | "today" | "week" | "month";

function dateStart(range: DateRange): string | undefined {
  if (range === "all") return undefined;
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  if (range === "week") date.setDate(date.getDate() - 7);
  if (range === "month") date.setDate(date.getDate() - 30);
  return date.toISOString();
}

function remoteNumber(call: CallLeg): string {
  return call.direction === "outgoing"
    ? call.toNumber ?? "Unknown number"
    : call.fromNumber ?? "Unknown number";
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function CallHistory() {
  const [calls, setCalls] = useState<CallLeg[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("all");
  const [range, setRange] = useState<DateRange>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setCalls([]);
    setCursor(null);
    const digits = search.replace(/\D/g, "");
    if (search.trim() && !digits) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    dataService.getCalls({
      limit: 50,
      direction: direction === "all" ? undefined : direction,
      from: dateStart(range),
      number: digits || undefined,
    })
      .then((page) => {
        if (!active) return;
        setCalls(page.items);
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load call history."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [direction, range, search]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const digits = search.replace(/\D/g, "");
      const page = await dataService.getCalls({
        limit: 50,
        cursor,
        direction: direction === "all" ? undefined : direction,
        from: dateStart(range),
        number: digits || undefined,
      });
      setCalls((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not load more call records."));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">Call History</h1>
        <p className="mt-2 text-gray-500">Call records retrieved from your PBX account.</p>
      </header>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap gap-3">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search phone number"
            aria-label="Search phone number"
            className="min-w-60 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <select value={direction} onChange={(event) => setDirection(event.target.value as Direction)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="all">All directions</option>
            <option value="incoming">Incoming</option>
            <option value="outgoing">Outgoing</option>
            <option value="internal">Internal</option>
          </select>
          <select value={range} onChange={(event) => setRange(event.target.value as DateRange)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option>
          </select>
        </div>
      </section>

      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        {loading ? <p role="status" className="p-5 text-sm text-gray-500">Loading calls…</p> : calls.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-5 py-3">Number</th>
                  <th className="px-5 py-3">Direction</th>
                  <th className="px-5 py-3">Extension</th>
                  <th className="px-5 py-3">Started</th>
                  <th className="px-5 py-3">Duration</th>
                  <th className="px-5 py-3">Outcome</th>
                  <th className="px-5 py-3">Charge</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {calls.map((call) => (
                  <tr key={call.id}>
                    <td className="px-5 py-4 font-medium text-gray-900">{remoteNumber(call)}</td>
                    <td className="px-5 py-4 capitalize text-gray-600">{call.direction}</td>
                    <td className="px-5 py-4 text-gray-600">{call.fromExtension ?? call.toExtension ?? "—"}</td>
                    <td className="px-5 py-4 text-gray-600">{new Date(call.startedAt).toLocaleString()}</td>
                    <td className="px-5 py-4 text-gray-600">{formatDuration(call.billableSec)}</td>
                    <td className="px-5 py-4 capitalize text-gray-600">{call.voicemail ? "voicemail" : call.outcome.replace("_", " ")}</td>
                    <td className="px-5 py-4 text-gray-600">${call.charge.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !loading && !error && <p className="p-8 text-center text-sm text-gray-500">No call records match these filters.</p>}
        {cursor && (
          <div className="border-t border-gray-100 p-4 text-center">
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
