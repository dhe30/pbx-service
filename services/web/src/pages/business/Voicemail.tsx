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
    setCursor(null);
    dataService.getVoicemails({ limit: 100, heard: filter === "all" ? undefined : filter === "heard" })
      .then((page) => {
        if (!active) return;
        setMessages(page.items);
        setCursor(page.nextCursor);
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

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await dataService.getVoicemails({
        limit: 100,
        cursor,
        heard: filter === "all" ? undefined : filter === "heard",
      });
      setMessages((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not load more voicemail."));
    } finally {
      setLoadingMore(false);
    }
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
        <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="all">All messages</option>
          <option value="unheard">Unread</option>
          <option value="heard">Read</option>
        </select>
      </div>

      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      <section className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
        {loading ? <p role="status" className="p-5 text-sm text-gray-500">Loading voicemail…</p> : filtered.length ? filtered.map((message) => (
          <article key={message.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-gray-900">{message.callerNumber ?? "Unknown caller"}</h2>
              <p className="mt-1 text-sm text-gray-500">{message.mailboxName} · {new Date(message.createdAt).toLocaleString()} · {formatDuration(message.durationMs)}</p>
              <audio className="mt-3 w-full max-w-xl" controls preload="none" src={apiAssetUrl(message.audioUrl)}>
                Your browser does not support audio playback.
              </audio>
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => void setHeard(message, !message.heard)} className="text-sm font-medium text-blue-700">
                Mark {message.heard ? "unread" : "read"}
              </button>
              <a href={apiAssetUrl(message.audioUrl)} download className="text-sm font-medium text-gray-700">Download</a>
              <button type="button" onClick={() => void deleteMessage(message)} className="text-sm font-medium text-red-600">Delete</button>
            </div>
          </article>
        )) : !loading && !error && <p className="p-8 text-center text-sm text-gray-500">No voicemail messages found.</p>}
        {cursor && (
          <div className="border-t border-gray-100 p-4 text-center">
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50">
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
