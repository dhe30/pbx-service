import { useEffect, useState } from "react";
import { apiAssetUrl, apiErrorMessage, dataService, type VoicemailMessage } from "../../services";

type Filter = "all" | "unheard" | "heard";

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "Unknown duration";
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Voicemail() {
  const [messages, setMessages] = useState<VoicemailMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setMessages([]);
    setNextCursor(null);
    dataService.getVoicemails({ limit: 50, heard: filter === "all" ? undefined : filter === "heard" })
      .then((page) => {
        if (!active) return;
        setMessages(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load voicemail."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filter]);

  async function changePage(next: boolean) {
    if (loadingMore) return;
    const targetCursor = next ? nextCursor : cursorHistory.at(-1);
    if (targetCursor === undefined || (next && !targetCursor)) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await dataService.getVoicemails({
        limit: 50,
        cursor: targetCursor ?? undefined,
        heard: filter === "all" ? undefined : filter === "heard",
      });
      setMessages(page.items);
      setCursor(targetCursor ?? null);
      setNextCursor(page.nextCursor);
      setCursorHistory((current) => next ? [...current, cursor] : current.slice(0, -1));
    } catch (cause) {
      setError(apiErrorMessage(cause, `Could not load ${next ? "next" : "previous"} voicemail.`));
    } finally {
      setLoadingMore(false);
    }
  }

  function resetPagination() {
    setCursor(null);
    setNextCursor(null);
    setCursorHistory([]);
  }

  async function setHeard(message: VoicemailMessage, heard: boolean) {
    setError("");
    try {
      const updated = await dataService.updateVoicemail(message.id, heard);
      setMessages((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not update voicemail."));
    }
  }

  async function deleteMessage(message: VoicemailMessage) {
    setError("");
    try {
      await dataService.deleteVoicemail(message.id);
      setMessages((current) => current.filter((item) => item.id !== message.id));
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not delete voicemail."));
    }
  }

  const filtered = messages.filter((message) =>
    `${message.callerNumber ?? ""} ${message.mailboxName}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">Voicemail</h1>
        <p className="mt-2 text-gray-500">Messages and read status from your PBX mailboxes.</p>
      </header>

      <div className="flex flex-wrap gap-3">
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search caller or mailbox" className="min-w-60 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <select value={filter} onChange={(event) => { resetPagination(); setFilter(event.target.value as Filter); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="all">All messages</option>
          <option value="unheard">Unread</option>
          <option value="heard">Read</option>
        </select>
      </div>

      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        {loading ? <p role="status" className="p-5 text-sm text-gray-500">Loading voicemail…</p> : filtered.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-5 py-3">Caller</th>
                  <th className="px-5 py-3">Mailbox</th>
                  <th className="px-5 py-3">Received</th>
                  <th className="px-5 py-3">Duration</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Audio</th>
                  <th className="px-5 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((message) => (
                  <tr key={message.id} className={!message.heard ? "bg-blue-50/30" : ""}>
                    <td className="whitespace-nowrap px-5 py-4 font-medium text-gray-900">{message.callerNumber ?? "Unknown caller"}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-gray-600">{message.mailboxName}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-gray-600">{new Date(message.createdAt).toLocaleString()}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-gray-600">{formatDuration(message.durationMs)}</td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${message.heard ? "bg-gray-100 text-gray-700" : "bg-blue-50 text-blue-700"}`}>
                        {message.heard ? "Read" : "Unread"}
                      </span>
                    </td>
                    <td className="min-w-56 px-5 py-4">
                      <audio className="w-56" controls preload="none" src={apiAssetUrl(message.audioUrl)}>
                        Your browser does not support audio playback.
                      </audio>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => void setHeard(message, !message.heard)} className="text-sm font-medium text-blue-700">
                          Mark {message.heard ? "unread" : "read"}
                        </button>
                        <a href={apiAssetUrl(message.audioUrl)} download className="text-sm font-medium text-gray-700">Download</a>
                        <button type="button" onClick={() => void deleteMessage(message)} className="text-sm font-medium text-red-600">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !loading && !error && <p className="p-8 text-center text-sm text-gray-500">No voicemail messages found.</p>}
        {(cursorHistory.length > 0 || nextCursor) && (
          <div className="flex items-center justify-between border-t border-gray-100 p-4">
            <button type="button" onClick={() => void changePage(false)} disabled={loadingMore || cursorHistory.length === 0} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">Previous</button>
            <span className="text-sm text-gray-500">Page {cursorHistory.length + 1}</span>
            <button type="button" onClick={() => void changePage(true)} disabled={loadingMore || !nextCursor} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50">{loadingMore ? "Loading…" : "Next"}</button>
          </div>
        )}
      </section>
    </div>
  );
}
