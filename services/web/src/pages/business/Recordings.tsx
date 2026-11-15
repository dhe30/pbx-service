import { useEffect, useState } from "react";
import { apiAssetUrl, apiErrorMessage, dataService, type CallRecording } from "../../services";

function remoteNumber(call: CallRecording): string {
  return call.direction === "outgoing"
    ? call.toNumber ?? "Unknown number"
    : call.fromNumber ?? "Unknown number";
}

export function Recordings() {
  const [recordings, setRecordings] = useState<CallRecording[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(true);
  const [changingPage, setChangingPage] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setRecordings([]);
    setNextCursor(null);
    dataService.getRecordings({ limit: 50 })
      .then((page) => {
        if (!active) return;
        setRecordings(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load recordings."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function changePage(next: boolean) {
    if (changingPage) return;
    const targetCursor = next ? nextCursor : cursorHistory.at(-1);
    if (targetCursor === undefined || (next && !targetCursor)) return;
    setChangingPage(true);
    setError("");
    try {
      const page = await dataService.getRecordings({ limit: 50, cursor: targetCursor ?? undefined });
      setRecordings(page.items);
      setCursor(targetCursor ?? null);
      setNextCursor(page.nextCursor);
      setCursorHistory((current) => next ? [...current, cursor] : current.slice(0, -1));
    } catch (cause) {
      setError(apiErrorMessage(cause, `Could not load ${next ? "next" : "previous"} recordings.`));
    } finally {
      setChangingPage(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">Call Recordings</h1>
        <p className="mt-2 text-gray-500">Recordings linked to call history.</p>
      </header>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        {loading ? <p role="status" className="p-5 text-sm text-gray-500">Loading recordings…</p> : recordings.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-5 py-3">Number</th>
                  <th className="px-5 py-3">Direction</th>
                  <th className="px-5 py-3">Extension</th>
                  <th className="px-5 py-3">Call date</th>
                  <th className="px-5 py-3">Duration</th>
                  <th className="px-5 py-3">Recording</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recordings.map((recording) => (
                  <tr key={recording.id}>
                    <td className="whitespace-nowrap px-5 py-4 font-medium text-gray-900">{remoteNumber(recording)}</td>
                    <td className="whitespace-nowrap px-5 py-4 capitalize text-gray-600">{recording.direction}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-gray-600">{recording.fromExtension ?? recording.toExtension ?? "—"}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-gray-600">{new Date(recording.startedAt).toLocaleString()}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-gray-600">{Math.floor(recording.billableSec / 60)}:{String(recording.billableSec % 60).padStart(2, "0")}</td>
                    <td className="min-w-64 px-5 py-4">
                      <audio className="w-64" controls preload="none" src={apiAssetUrl(recording.audioUrl)}>
                        Your browser does not support audio playback.
                      </audio>
                      <a href={apiAssetUrl(recording.audioUrl)} download className="mt-2 inline-block text-sm font-medium text-blue-700">Download</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !loading && !error && <p className="p-8 text-center text-sm text-gray-500">No recordings are available.</p>}
        {(cursorHistory.length > 0 || nextCursor) && (
          <div className="flex items-center justify-between border-t border-gray-100 p-4">
            <button type="button" onClick={() => void changePage(false)} disabled={changingPage || cursorHistory.length === 0} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">Previous</button>
            <span className="text-sm text-gray-500">Page {cursorHistory.length + 1}</span>
            <button type="button" onClick={() => void changePage(true)} disabled={changingPage || !nextCursor} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">{changingPage ? "Loading…" : "Next"}</button>
          </div>
        )}
      </section>
    </div>
  );
}
