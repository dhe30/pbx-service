import { useEffect, useState } from "react";
import { apiErrorMessage, dataService, type BusinessHours, type Destination, type Extension, type IvrMenu, type Mailbox, type PhoneNumber, type RingGroup } from "../../services";

interface RoutingData {
  numbers: PhoneNumber[];
  extensions: Extension[];
  ringGroups: RingGroup[];
  ivrMenus: IvrMenu[];
  businessHours: BusinessHours[];
  mailboxes: Mailbox[];
}

function destinationLabel(
  destination: Destination | null,
  data: RoutingData,
): string {
  if (!destination) return "Not configured";
  if (destination.type === "external") return `External · ${destination.number}`;
  if (destination.type === "hangup") return "Hang up";

  const collections = {
    extension: data.extensions,
    ring_group: data.ringGroups,
    ivr_menu: data.ivrMenus,
    voicemail: data.mailboxes,
    business_hours: data.businessHours,
  };
  const target = collections[destination.type].find((item) => item.id === destination.id);
  if (!target) return `${destination.type.replace("_", " ")} · target unavailable`;
  const name = "name" in target ? target.name : "";
  const number = "number" in target ? ` · ${target.number}` : "";
  return `${name || destination.type.replace("_", " ")}${number}`;
}

export function CallRouting() {
  const [data, setData] = useState<RoutingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  useEffect(() => {
    let active = true;
    Promise.all([
      dataService.getNumbers(),
      dataService.getExtensions(),
      dataService.getRingGroups(),
      dataService.getIvrMenus(),
      dataService.getBusinessHours(),
      dataService.getMailboxes(),
    ])
      .then(([numbers, extensions, ringGroups, ivrMenus, businessHours, mailboxes]) => {
        if (active) setData({ numbers, extensions, ringGroups, ivrMenus, businessHours, mailboxes });
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load call routing configuration."));
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
        <h1 className="text-3xl font-bold text-gray-900">Call Routing</h1>
        <p className="mt-2 text-gray-500">Current routing destinations and configuration loaded from the API.</p>
        <p className="mt-1 text-sm text-gray-500">This page is read-only; routing edits are not included yet.</p>
      </header>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {loading && <p role="status" className="text-sm text-gray-500">Loading routing configuration…</p>}
      {data && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold text-gray-900">Phone number routes</h2>
            {data.numbers.length ? (
              <ul className="mt-4 divide-y divide-gray-100">
                {data.numbers.map((number) => (
                  <li key={number.id} className="py-3">
                    <p className="font-medium text-gray-900">{number.did}</p>
                    <p className="mt-1 text-sm text-gray-500">{destinationLabel(number.destination, data)}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm text-gray-500">No phone numbers are assigned.</p>}
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold text-gray-900">Ring groups</h2>
            {data.ringGroups.length ? (
              <ul className="mt-4 divide-y divide-gray-100">
                {data.ringGroups.map((group) => (
                  <li key={group.id} className="py-3">
                    <p className="font-medium text-gray-900">{group.name}</p>
                    <p className="mt-1 text-sm capitalize text-gray-500">{group.strategy} · {group.ringTimeoutSec}s timeout</p>
                    <p className="mt-1 text-sm text-gray-500">
                      Members: {group.memberIds.map((id) => {
                        const extension = data.extensions.find((item) => item.id === id);
                        return extension ? `${extension.name} (${extension.number})` : "Unavailable extension";
                      }).join(", ") || "None"}
                    </p>
                    <p className="mt-1 text-sm text-gray-500">No answer: {destinationLabel(group.noAnswerDestination, data)}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm text-gray-500">No ring groups are configured.</p>}
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold text-gray-900">IVR menus</h2>
            {data.ivrMenus.length ? (
              <ul className="mt-4 divide-y divide-gray-100">
                {data.ivrMenus.map((menu) => (
                  <li key={menu.id} className="py-3">
                    <p className="font-medium text-gray-900">{menu.name}</p>
                    <p className="mt-1 text-sm text-gray-500">Timeout: {menu.timeoutSec}s · retries: {menu.maxRetries}</p>
                    <ul className="mt-2 space-y-1 text-sm text-gray-500">
                      {Object.entries(menu.config.options).map(([key, destination]) => (
                        <li key={key}>Key {key}: {destinationLabel(destination, data)}</li>
                      ))}
                    </ul>
                    {menu.config.timeout && <p className="mt-1 text-sm text-gray-500">Timeout destination: {destinationLabel(menu.config.timeout, data)}</p>}
                    {menu.config.invalid && <p className="mt-1 text-sm text-gray-500">Invalid input: {destinationLabel(menu.config.invalid, data)}</p>}
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm text-gray-500">No IVR menus are configured.</p>}
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="font-semibold text-gray-900">Business hours</h2>
            {data.businessHours.length ? (
              <ul className="mt-4 divide-y divide-gray-100">
                {data.businessHours.map((hours) => (
                  <li key={hours.id} className="py-3">
                    <p className="font-medium text-gray-900">{hours.name} · {hours.openNow ? "Open" : "Closed"}</p>
                    <p className="mt-1 text-sm text-gray-500">
                      Hours: {hours.schedule.intervals.map(({ day, start, end }) => `${dayNames[day] ?? "Day"} ${start}–${end}`).join(", ") || "None"}
                    </p>
                    <p className="mt-1 text-sm text-gray-500">Open: {destinationLabel(hours.openDestination, data)}</p>
                    <p className="mt-1 text-sm text-gray-500">Closed: {destinationLabel(hours.closedDestination, data)}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm text-gray-500">No business-hours schedules are configured.</p>}
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5 lg:col-span-2">
            <h2 className="font-semibold text-gray-900">Mailboxes</h2>
            {data.mailboxes.length ? (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {data.mailboxes.map((mailbox) => (
                  <li key={mailbox.id} className="rounded-lg border border-gray-100 p-4">
                    <p className="font-medium text-gray-900">{mailbox.name}</p>
                    <p className="mt-1 text-sm text-gray-500">Greeting: {mailbox.greetingMediaId ? "Configured" : "Default"}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm text-gray-500">No mailboxes are configured.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
