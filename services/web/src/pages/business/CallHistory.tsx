import { useEffect, useState } from "react";
import { apiErrorMessage, dataService, type CallLeg, type Extension } from "../../services";

type Direction = "all" | CallLeg["direction"];
type DateRange = "all" | "today" | "week" | "month";
type Outcome = "all" | CallLeg["outcome"];

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
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [direction, setDirection] = useState<Direction>("all");
  const [range, setRange] = useState<DateRange>("all");
  const [extension, setExtension] = useState("all");
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [extensionsError, setExtensionsError] = useState("");

  useEffect(() => {
    let active = true;
    dataService.getExtensions()
      .then((items) => {
        if (active) setExtensions(items);
      })
      .catch((cause: unknown) => {
        if (active) setExtensionsError(apiErrorMessage(cause, "Could not load extensions."));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setCalls([]);
    setNextCursor(null);
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
      extension: extension === "all" ? undefined : extension,
      number: digits || undefined,
      outcome: outcome === "all" ? undefined : outcome,
    })
      .then((page) => {
        if (!active) return;
        setCalls(page.items);
        setNextCursor(page.nextCursor);
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
  }, [direction, extension, outcome, range, search]);

  async function changePage(next: boolean) {
    if (loadingMore) return;
    const targetCursor = next ? nextCursor : cursorHistory.at(-1);
    if (targetCursor === undefined || (next && !targetCursor)) return;
    setLoadingMore(true);
    setError("");
    try {
      const digits = search.replace(/\D/g, "");
      const page = await dataService.getCalls({
        limit: 50,
        cursor: targetCursor ?? undefined,
        direction: direction === "all" ? undefined : direction,
        from: dateStart(range),
        extension: extension === "all" ? undefined : extension,
        number: digits || undefined,
        outcome: outcome === "all" ? undefined : outcome,
      });
      setCalls(page.items);
      setCursor(targetCursor ?? null);
      setNextCursor(page.nextCursor);
      setCursorHistory((current) => next ? [...current, cursor] : current.slice(0, -1));
    } catch (cause) {
      setError(apiErrorMessage(cause, `Could not load ${next ? "next" : "previous"} call records.`));
    } finally {
      setLoadingMore(false);
    }
  }

  function resetPagination() {
    setCursor(null);
    setNextCursor(null);
    setCursorHistory([]);
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
            onChange={(event) => { resetPagination(); setSearch(event.target.value); }}
            placeholder="Search phone number"
            aria-label="Search phone number"
            className="min-w-60 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <select value={direction} onChange={(event) => { resetPagination(); setDirection(event.target.value as Direction); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="all">All directions</option>
            <option value="incoming">Incoming</option>
            <option value="outgoing">Outgoing</option>
            <option value="internal">Internal</option>
          </select>
          <select value={range} onChange={(event) => { resetPagination(); setRange(event.target.value as DateRange); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option>
          </select>
          <select
            value={extension}
            onChange={(event) => { resetPagination(); setExtension(event.target.value); }}
            aria-label="Filter by extension"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="all">All extensions</option>
            {extensions.map((item) => (
              <option key={item.id} value={item.number}>{item.number}</option>
            ))}
          </select>
          <select
            value={outcome}
            onChange={(event) => { resetPagination(); setOutcome(event.target.value as Outcome); }}
            aria-label="Filter by outcome"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="all">All outcomes</option>
            <option value="answered">Answered</option>
            <option value="busy">Busy</option>
            <option value="no_answer">No answer</option>
            <option value="failed">Failed</option>
            <option value="blocked">Blocked</option>
          </select>
        </div>
        {extensionsError && <p role="alert" className="mt-3 text-sm text-red-700">{extensionsError}</p>}
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
        {(cursorHistory.length > 0 || nextCursor) && (
          <div className="flex items-center justify-between border-t border-gray-100 p-4">
            <button type="button" onClick={() => void changePage(false)} disabled={loadingMore || cursorHistory.length === 0} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">
              Previous
            </button>
            <span className="text-sm text-gray-500">Page {cursorHistory.length + 1}</span>
            <button type="button" onClick={() => void changePage(true)} disabled={loadingMore || !nextCursor} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">
              {loadingMore ? "Loading…" : "Next"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
