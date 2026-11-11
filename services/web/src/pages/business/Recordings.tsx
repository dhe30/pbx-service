import { useEffect, useState } from "react";
import { apiAssetUrl, apiErrorMessage, dataService, type CallLeg } from "../../services";

function remoteNumber(call: CallLeg): string {
  return call.direction === "outgoing"
    ? call.toNumber ?? "Unknown number"
    : call.fromNumber ?? "Unknown number";
}

export function Recordings() {
  const [calls, setCalls] = useState<CallLeg[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    dataService.getCalls({ limit: 100 })
      .then((page) => {
        if (!active) return;
        setCalls(page.items);
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load call recordings."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await dataService.getCalls({ limit: 100, cursor });
      setCalls((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not load more recordings."));
    } finally {
      setLoadingMore(false);
    }
  }

  const recordings = [...new Map(
    calls.filter((call) => call.recordingUrl).map((call) => [call.callId, call]),
  ).values()];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">Call Recordings</h1>
        <p className="mt-2 text-gray-500">Recordings linked to call history.</p>
      </header>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      <section className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
        {loading ? <p role="status" className="p-5 text-sm text-gray-500">Loading recordings…</p> : recordings.length ? recordings.map((call) => (
          <article key={call.id} className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold text-gray-900">{remoteNumber(call)}</h2>
                <p className="mt-1 text-sm capitalize text-gray-500">
                  {call.direction} · {new Date(call.startedAt).toLocaleString()} · {Math.floor(call.billableSec / 60)}:{String(call.billableSec % 60).padStart(2, "0")}
                </p>
              </div>
              <a href={apiAssetUrl(call.recordingUrl!)} download className="text-sm font-medium text-blue-700">Download recording</a>
            </div>
            <audio className="mt-4 w-full" controls preload="none" src={apiAssetUrl(call.recordingUrl!)}>
              Your browser does not support audio playback.
            </audio>
          </article>
        )) : !loading && !error && <p className="p-8 text-center text-sm text-gray-500">No recordings are available in the call records returned.</p>}
        {cursor && (
          <div className="p-4 text-center">
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50">
              {loadingMore ? "Loading…" : "Load more call records"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
