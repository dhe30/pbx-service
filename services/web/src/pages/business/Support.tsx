import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiErrorMessage, dataService, type SupportTicket } from "../../services";

type StatusFilter = "all" | SupportTicket["status"];

const statusStyles: Record<SupportTicket["status"], string> = {
  open: "bg-blue-50 text-blue-700",
  closed: "bg-green-50 text-green-700",
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function shortId(id: string): string {
  return `#${id.slice(0, 8).toUpperCase()}`;
}

function StatusBadge({ status }: { status: SupportTicket["status"] }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusStyles[status]}`}>
      {status === "open" ? "Open" : "Closed"}
    </span>
  );
}

export function Support() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [ticketSummary, setTicketSummary] = useState<{ open: number; closed: number } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [closingTicketId, setClosingTicketId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refreshTicketSummary() {
    try {
      setTicketSummary(await dataService.getTicketSummary());
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not load ticket totals."));
    }
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setTickets([]);
    setNextCursor(null);
    dataService.getTickets({
      limit: 50,
      status: statusFilter === "all" ? undefined : statusFilter,
    })
      .then((page) => {
        if (!active) return;
        setTickets(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load support tickets."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [statusFilter]);

  useEffect(() => {
    void refreshTicketSummary();
  }, []);

  const filteredTickets = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return tickets;
    return tickets.filter((ticket) =>
      ticket.subject.toLowerCase().includes(query)
      || ticket.description.toLowerCase().includes(query)
      || ticket.id.toLowerCase().includes(query)
      || ticket.createdByEmail?.toLowerCase().includes(query),
    );
  }, [search, tickets]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await dataService.getTickets({
        limit: 50,
        cursor: nextCursor,
        status: statusFilter === "all" ? undefined : statusFilter,
      });
      setTickets((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not load more support tickets."));
    } finally {
      setLoadingMore(false);
    }
  }

  async function submitTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const ticket = await dataService.createTicket(subject.trim(), description.trim());
      setTickets((current) => [ticket, ...current.filter((item) => item.id !== ticket.id)]);
      setTicketSummary((current) => current ? { ...current, open: current.open + 1 } : current);
      void refreshTicketSummary();
      setSubject("");
      setDescription("");
      setShowForm(false);
      if (statusFilter === "closed") setStatusFilter("all");
      setNotice("Your support ticket was submitted.");
      setSelectedTicket(ticket);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not submit your support ticket."));
    } finally {
      setSubmitting(false);
    }
  }

  async function closeTicket(ticket: SupportTicket) {
    setClosingTicketId(ticket.id);
    setError("");
    setNotice("");
    try {
      const closed = await dataService.closeTicket(ticket.id);
      setTickets((current) => current.map((item) => item.id === closed.id ? closed : item));
      setSelectedTicket((current) => current?.id === closed.id ? closed : current);
      if (ticket.status === "open") {
        setTicketSummary((current) => current
          ? { open: Math.max(0, current.open - 1), closed: current.closed + 1 }
          : current);
        void refreshTicketSummary();
      }
      setNotice("Ticket marked as closed.");
      if (statusFilter === "open") {
        setTickets((current) => current.filter((item) => item.id !== closed.id));
        setSelectedTicket(null);
      }
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not close the support ticket."));
    } finally {
      setClosingTicketId(null);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Support</h1>
          <p className="mt-2 text-gray-500">Submit an issue and track support requests for your business.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowForm((current) => !current);
            setSelectedTicket(null);
            setSubject("");
            setDescription("");
            setError("");
          }}
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          {showForm ? "Cancel" : "+ Create a ticket"}
        </button>
      </header>

      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-green-50 p-4 text-sm text-green-700">{notice}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-sm font-medium text-gray-500">Open tickets</p>
          <p className="mt-2 text-3xl font-bold text-blue-600">{ticketSummary?.open ?? "—"}</p>
          <p className="mt-1 text-xs text-gray-400">All open tickets for this business</p>
        </section>
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-sm font-medium text-gray-500">Closed tickets</p>
          <p className="mt-2 text-3xl font-bold text-green-600">{ticketSummary?.closed ?? "—"}</p>
          <p className="mt-1 text-xs text-gray-400">All closed tickets for this business</p>
        </section>
      </div>

      {showForm && (
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-gray-900">Submit a support ticket</h2>
            <p className="mt-1 text-sm text-gray-500">Describe the issue. Tickets are visible to other users in your business.</p>
          </div>
          <form onSubmit={(event) => void submitTicket(event)} className="space-y-5">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-gray-700">Subject</span>
              <input
                type="text"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="Briefly summarize the issue"
                minLength={1}
                maxLength={200}
                required
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-gray-700">Description</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Include what happened, any error messages, and the steps to reproduce it."
                rows={6}
                minLength={1}
                maxLength={10_000}
                required
                className="w-full resize-y rounded-lg border border-gray-300 px-4 py-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
              <span className="mt-1 block text-right text-xs text-gray-400">{description.length}/10,000</span>
            </label>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setShowForm(false)} disabled={submitting} className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
              <button type="submit" disabled={submitting} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {submitting ? "Submitting…" : "Submit ticket"}
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="flex flex-col justify-between gap-4 border-b border-gray-200 p-5 lg:flex-row lg:items-center">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Business tickets</h2>
            <p className="mt-1 text-sm text-gray-500">Ticket history shared by your business users.</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search loaded tickets"
              aria-label="Search tickets"
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm sm:w-64"
            />
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              aria-label="Filter tickets by status"
              className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-700"
            >
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </div>
        </div>

        {loading ? (
          <p role="status" className="p-8 text-center text-sm text-gray-500">Loading support tickets…</p>
        ) : filteredTickets.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-5 py-4 font-medium">Ticket</th>
                  <th className="px-5 py-4 font-medium">Submitted by</th>
                  <th className="px-5 py-4 font-medium">Date</th>
                  <th className="px-5 py-4 font-medium">Status</th>
                  <th className="px-5 py-4 text-right font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredTickets.map((ticket) => (
                  <tr key={ticket.id} className="hover:bg-gray-50">
                    <td className="max-w-md px-5 py-4">
                      <p className="font-medium text-gray-900">{ticket.subject}</p>
                      <p className="mt-1 text-xs text-gray-500">{shortId(ticket.id)}</p>
                    </td>
                    <td className="px-5 py-4 text-gray-600">{ticket.createdByEmail ?? "Account user"}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-gray-600">{formatDate(ticket.createdAt)}</td>
                    <td className="px-5 py-4"><StatusBadge status={ticket.status} /></td>
                    <td className="px-5 py-4 text-right">
                      <button type="button" onClick={() => { setSelectedTicket(ticket); setShowForm(false); }} className="font-medium text-blue-600 hover:text-blue-800">View details</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-16 text-center">
            <h3 className="font-semibold text-gray-900">{tickets.length ? "No tickets match your search" : "No tickets yet"}</h3>
            <p className="mt-1 text-sm text-gray-500">{tickets.length ? "Try another search or status filter." : "Create a ticket if you need help from support."}</p>
          </div>
        )}
        {nextCursor && !loading && (
          <div className="border-t border-gray-100 p-4 text-center">
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {loadingMore ? "Loading…" : "Load more tickets"}
            </button>
          </div>
        )}
      </section>

      {selectedTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedTicket(null);
        }}>
          <section role="dialog" aria-modal="true" aria-labelledby="ticket-detail-title" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-gray-400">{shortId(selectedTicket.id)}</p>
                <h2 id="ticket-detail-title" className="mt-1 text-xl font-bold text-gray-900">{selectedTicket.subject}</h2>
              </div>
              <button type="button" onClick={() => setSelectedTicket(null)} className="text-gray-400 hover:text-gray-600" aria-label="Close ticket details">✕</button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <StatusBadge status={selectedTicket.status} />
              <span className="text-sm text-gray-500">Submitted {formatDate(selectedTicket.createdAt)}</span>
              {selectedTicket.createdByEmail && <span className="text-sm text-gray-500">by {selectedTicket.createdByEmail}</span>}
            </div>
            <div className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Description</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-gray-700">{selectedTicket.description}</p>
            </div>
            {selectedTicket.closedAt && <p className="mt-5 text-sm text-gray-500">Closed {formatDate(selectedTicket.closedAt)}.</p>}
            <div className="mt-7 flex justify-end gap-3">
              <button type="button" onClick={() => setSelectedTicket(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Close</button>
              {selectedTicket.status === "open" && (
                <button
                  type="button"
                  onClick={() => void closeTicket(selectedTicket)}
                  disabled={closingTicketId === selectedTicket.id}
                  className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {closingTicketId === selectedTicket.id ? "Updating…" : "Mark resolved"}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
