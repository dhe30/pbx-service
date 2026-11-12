import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiErrorMessage, dataService, type CallLeg, type Extension, type PhoneNumber, type Settings } from "../../services";
import { useAuth } from "../../hooks";

interface DashboardData {
  calls: CallLeg[];
  extensions: Extension[];
  numbers: PhoneNumber[];
  settings: Settings;
}

function remoteNumber(call: CallLeg): string {
  return call.direction === "outgoing"
    ? call.toNumber ?? "Unknown number"
    : call.fromNumber ?? "Unknown number";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      dataService.getCalls({ limit: 5 }),
      dataService.getExtensions(),
      dataService.getNumbers(),
      dataService.getSettings(),
    ])
      .then(([calls, extensions, numbers, settings]) => {
        if (active) setData({ calls: calls.items, extensions, numbers, settings });
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load dashboard data."));
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            {user?.tenant?.name ?? "Business"} · {user?.tenant?.timezone}
          </p>
        </div>
        <div className="flex gap-3">
          <Link to="/purchase" className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700">
            Purchase services
          </Link>
          <Link to="/phone" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">
            Open phone
          </Link>
        </div>
      </header>

      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {!data && !error && <p role="status" className="text-sm text-gray-500">Loading dashboard…</p>}
      {data && (
        <>
          {user?.tenant?.status === "past_due" && (
            <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              This account is past due. Outgoing external calls are blocked until billing is resolved.
            </p>
          )}

          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Numbers", data.numbers.length],
              ["Extensions", `${data.settings.extraExtensions + data.settings.includedExtensions} slots · ${data.extensions.length} used`],
              ["Recent call records", data.calls.length],
              ["Recording", data.settings.recordCalls ? "Enabled" : "Not enabled"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-gray-200 bg-white p-5">
                <p className="text-sm text-gray-500">{label}</p>
                <p className="mt-2 text-xl font-semibold text-gray-900">{value}</p>
              </div>
            ))}
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="rounded-xl border border-gray-200 bg-white">
              <div className="flex items-center justify-between border-b border-gray-200 p-5">
                <div>
                  <h2 className="font-semibold text-gray-900">Recent calls</h2>
                  <p className="mt-1 text-sm text-gray-500">Latest call records from the API.</p>
                </div>
                <Link to="/history" className="text-sm font-medium text-blue-600">View history</Link>
              </div>
              {data.calls.length ? (
                <ul className="divide-y divide-gray-100">
                  {data.calls.map((call) => (
                    <li key={call.id} className="flex flex-wrap justify-between gap-2 p-4 text-sm">
                      <span className="font-medium text-gray-900">{remoteNumber(call)}</span>
                      <span className="text-gray-500">{call.direction} · {call.outcome.replace("_", " ")}</span>
                      <time className="text-gray-500">{formatDate(call.startedAt)}</time>
                    </li>
                  ))}
                </ul>
              ) : <p className="p-5 text-sm text-gray-500">No call records yet.</p>}
            </section>

            <section className="rounded-xl border border-gray-200 bg-white">
              <div className="flex items-center justify-between border-b border-gray-200 p-5">
                <div>
                  <h2 className="font-semibold text-gray-900">Extensions</h2>
                  <p className="mt-1 text-sm text-gray-500">Configured extension numbers.</p>
                </div>
                <Link to="/team" className="text-sm font-medium text-blue-600">Manage</Link>
              </div>
              {data.extensions.length ? (
                <ul className="divide-y divide-gray-100">
                  {data.extensions.map((extension) => (
                    <li key={extension.id} className="flex justify-between gap-4 p-4 text-sm">
                      <span className="font-medium text-gray-900">{extension.name}</span>
                      <span className="text-gray-500">Ext. {extension.number}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="p-5 text-sm text-gray-500">No extensions configured.</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
