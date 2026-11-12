import { useEffect, useState } from "react";
import { useSoftphone } from "../../contexts";
import { apiErrorMessage, dataService, type CallLeg } from "../../services";

// The softphone itself is the panel BusinessLayout shows next to every page (src/softphone).
// This page adds recent calls (click one to put its number in the softphone) and help.
export function Phone() {
  const { setNumber } = useSoftphone();
  const [recentCalls, setRecentCalls] = useState<CallLeg[]>([]);
  const [recentCallError, setRecentCallError] = useState("");

  useEffect(() => {
    let active = true;
    dataService.getCalls({ limit: 10 })
      .then((page) => {
        if (active) setRecentCalls(page.items);
      })
      .catch((cause: unknown) => {
        if (active) setRecentCallError(apiErrorMessage(cause, "Could not load recent calls."));
      });
    return () => {
      active = false;
    };
  }, []);

  function callNumber(call: CallLeg) {
    return call.direction === "outgoing"
      ? call.toNumber ?? ""
      : call.fromNumber ?? "";
  }

  function callDirection(call: CallLeg): string {
    if (call.outcome !== "answered") return "Missed";
    return call.direction === "incoming" ? "Incoming" : "Outgoing";
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Phone</h1>
        <p className="mt-1 text-sm text-gray-500">
          Make and receive calls with the softphone panel. Choose an extension there and it
          registers right away; it stays online while you move between pages.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Recent calls</h2>
          <span className="text-xs text-gray-500">Click one to dial it</span>
        </div>

        {recentCallError && <p role="alert" className="mb-3 text-sm text-red-700">{recentCallError}</p>}
        <div className="space-y-2">
          {recentCalls.map((call) => {
            const direction = callDirection(call);
            const phone = callNumber(call) || "Unknown number";
            return (
              <button
                key={call.id}
                type="button"
                onClick={() => setNumber(callNumber(call))}
                className="flex w-full items-start gap-3 rounded-lg p-2 text-left hover:bg-gray-50"
              >
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                    direction === "Missed"
                      ? "bg-red-100 text-red-700"
                      : direction === "Incoming"
                        ? "bg-green-100 text-green-700"
                        : "bg-blue-100 text-blue-700"
                  }`}
                >
                  {phone.slice(0, 1)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-gray-900">{phone}</p>
                    <span className={`shrink-0 text-xs ${direction === "Missed" ? "text-red-600" : "text-gray-500"}`}>
                      {direction}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    {new Date(call.startedAt).toLocaleString()}
                    {call.billableSec > 0 ? ` · ${Math.floor(call.billableSec / 60)}:${String(call.billableSec % 60).padStart(2, "0")}` : ""}
                  </p>
                </div>
              </button>
            );
          })}
          {!recentCalls.length && !recentCallError && <p className="py-4 text-sm text-gray-500">No recent call records.</p>}
        </div>

        <a
          href="/history"
          className="mt-5 block text-center text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          View all call history →
        </a>
      </div>

      <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
        <p className="text-sm font-medium text-blue-900">Using the softphone</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-blue-700">
          <li>Dial an extension, <code>*98</code> for voicemail, or any phone number.</li>
          <li>Hold puts the caller on music; answering a second call holds the first.</li>
          <li>
            Blind transfer sends the call to the number in the box. Consult holds the call and
            calls that number; Complete transfer then connects the two.
          </li>
          <li>Allow microphone access in your browser, or calls can't be answered.</li>
        </ul>
      </div>
    </div>
  );
}
