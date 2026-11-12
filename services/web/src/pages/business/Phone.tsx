import { useEffect, useState } from "react";
import { useSoftphone } from "../../contexts";
import { useAuth } from "../../hooks";
import { apiErrorMessage, dataService, type CallLeg, type Extension } from "../../services";

const dialPad = [
  { digit: "1", letters: "" },
  { digit: "2", letters: "ABC" },
  { digit: "3", letters: "DEF" },
  { digit: "4", letters: "GHI" },
  { digit: "5", letters: "JKL" },
  { digit: "6", letters: "MNO" },
  { digit: "7", letters: "PQRS" },
  { digit: "8", letters: "TUV" },
  { digit: "9", letters: "WXYZ" },
  { digit: "*", letters: "" },
  { digit: "0", letters: "+" },
  { digit: "#", letters: "" },
];

export function Phone() {
  const { user } = useAuth();
  const [number, setNumber] = useState("");
  const [keypadVisible, setKeypadVisible] = useState(false);
  const [recentCalls, setRecentCalls] = useState<CallLeg[]>([]);
  const [recentCallError, setRecentCallError] = useState("");
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [selectedExtensionId, setSelectedExtensionId] = useState("");
  const [extensionsLoading, setExtensionsLoading] = useState(true);
  const [extensionsError, setExtensionsError] = useState("");
  const {
    connectionStatus,
    connectionRequested,
    connectionError,
    call,
    callError,
    connect,
    disconnect,
    makeCall,
    hangUp,
    sendDtmf,
  } = useSoftphone();
  const isActive = call !== null;

  useEffect(() => {
    let active = true;
    dataService.getExtensions()
      .then((items) => {
        if (!active) return;
        const assignedExtensions = items.filter((extension) => extension.userId === user?.id);
        setExtensions(assignedExtensions);
        setSelectedExtensionId((current) =>
          assignedExtensions.some((extension) => extension.id === current)
            ? current
            : assignedExtensions[0]?.id ?? "",
        );
      })
      .catch((cause: unknown) => {
        if (active) setExtensionsError(apiErrorMessage(cause, "Could not load business extensions."));
      })
      .finally(() => {
        if (active) setExtensionsLoading(false);
      });

    dataService.getCalls({ limit: 5 })
      .then((page) => {
        if (active) setRecentCalls(page.items);
      })
      .catch((cause: unknown) => {
        if (active) setRecentCallError(apiErrorMessage(cause, "Could not load recent calls."));
      });
    return () => {
      active = false;
    };
  }, [user?.id]);

  function handleDigit(digit: string) {
    if (isActive) sendDtmf(digit);
    else setNumber((current) => current + digit);
  }

  function handleDeleteDigit() {
    setNumber((current) => current.slice(0, -1));
  }

  function callNumber(call: CallLeg) {
    return call.direction === "outgoing"
      ? call.toNumber ?? ""
      : call.fromNumber ?? "";
  }

  function callDirection(call: CallLeg): string {
    if (call.outcome !== "answered") return "Missed";
    return call.direction === "incoming" ? "Incoming" : "Outgoing";
  }

  function handleSelectRecentCall(recentCall: CallLeg) {
    setNumber(callNumber(recentCall));
  }
  const statusLabels = {
    offline: "Phone offline",
    connecting: "Connecting phone...",
    online: "Ready to make and receive calls",
    reconnecting: "Connection lost. Reconnecting...",
    error: "Phone connection failed",
  } as const;
  const phoneIsOnline = connectionStatus === "online";

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Phone</h1>
        <p className="mt-1 text-sm text-gray-500">
          Make and receive calls from your business phone line.
        </p>
      </div>

      {/* Phone connection status */}
      <div className="flex flex-col gap-4 rounded-xl border border-gray-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-gray-500">Softphone account</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">
            {phoneIsOnline ? "Registered and ready" : "Not connected"}
          </p>
          <p className="text-sm text-gray-500">Connect to make and receive calls.</p>
        </div>

        <div className="flex flex-col items-start gap-3 sm:items-end">
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
            phoneIsOnline ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-700"
          }`}>
            <span className={`h-2 w-2 rounded-full ${phoneIsOnline ? "bg-green-500" : "bg-gray-400"}`} />
            {statusLabels[connectionStatus]}
          </div>
          <button
            onClick={() => void (connectionRequested ? disconnect() : connect(selectedExtensionId))}
            disabled={!connectionRequested && (!selectedExtensionId || extensionsLoading || connectionStatus === "connecting")}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-50"
          >
            {connectionRequested ? "Go offline" : "Connect phone"}
          </button>
        </div>
      </div>
      <div className="max-w-md rounded-xl border border-gray-200 bg-white p-5">
        <label htmlFor="softphone-extension" className="block text-sm font-medium text-gray-700">
          Phone extension
        </label>
        <select
          id="softphone-extension"
          data-testid="softphone-extension"
          value={selectedExtensionId}
          onChange={(event) => setSelectedExtensionId(event.target.value)}
          disabled={connectionRequested || extensionsLoading || extensions.length === 0}
          className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:bg-gray-100"
        >
          <option value="" disabled>
            {extensionsLoading ? "Loading extensions…" : "Select an extension"}
          </option>
          {extensions.map((extension) => (
            <option key={extension.id} value={extension.id}>
              {extension.number} · {extension.name}
              {extension.userId === user?.id ? " (assigned to you)" : ""}
            </option>
          ))}
        </select>
        {extensionsError && <p role="alert" className="mt-2 text-sm text-red-700">{extensionsError}</p>}
        {!extensionsLoading && !extensionsError && extensions.length === 0 && (
          <p role="status" className="mt-2 text-sm text-gray-500">
            No extension is assigned to your account. Ask an owner to assign one in Team Management.
          </p>
        )}
      </div>
      {(connectionError || callError) && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {connectionError || callError}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Main phone interface */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                Softphone
              </h2>
              <span className="text-xs font-medium text-gray-500">
                {phoneIsOnline ? "Registered" : "Not registered"}
              </span>
            </div>

            {isActive && (
              <p className="mb-6 rounded-lg bg-blue-50 p-4 text-center text-sm text-blue-800">
                {call.status === "calling" ? "Calling" : call.status === "answering" ? "Answering" : call.status === "ringing" ? "Incoming call" : "On call"} with {call.remoteName}. Use the call dialog to manage this call.
              </p>
            )}

            {/* Number display */}
            <div className="mb-6">
              <label
                htmlFor="softphone-number"
                className="mb-2 block text-sm font-medium text-gray-700"
              >
                Phone number
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="softphone-number"
                  data-testid="softphone-number"
                  type="tel"
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                  placeholder="Enter a phone number"
                  disabled={isActive}
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 text-center text-xl font-medium tracking-wide text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-100"
                />
                <button
                  onClick={handleDeleteDigit}
                  disabled={!number || isActive}
                  className="rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                  aria-label="Delete last digit"
                >
                  ⌫
                </button>
              </div>
            </div>

            {/* Dial pad */}
            {(!isActive || keypadVisible) && (
              <div className="mx-auto grid max-w-sm grid-cols-3 gap-3">
                {dialPad.map(({ digit, letters }) => (
                  <button
                    key={digit}
                    onClick={() =>
                      handleDigit(digit)
                    }
                    className="flex h-16 flex-col items-center justify-center rounded-xl border border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50"
                  >
                    <span className="text-xl font-semibold text-gray-900">
                      {digit}
                    </span>
                    <span className="text-[10px] tracking-widest text-gray-400">
                      {letters}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Call controls */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {!isActive ? (
                <button
                  data-testid="softphone-call"
                  onClick={() => void makeCall(number)}
                  disabled={!number.trim() || !phoneIsOnline}
                  className="rounded-full bg-green-600 px-10 py-3 font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Call
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setKeypadVisible((visible) => !visible)}
                    className="rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {keypadVisible ? "Hide keypad" : "Keypad"}
                  </button>
                  <button
                    data-testid="softphone-hangup"
                    onClick={() => void hangUp()}
                    disabled={call?.status === "answering"}
                    className="rounded-full bg-red-600 px-8 py-3 font-semibold text-white hover:bg-red-700"
                  >
                    Hang up
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Recent calls */}
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">
              Recent calls
            </h2>
            <span className="text-xs text-gray-500">Latest</span>
          </div>

          {recentCallError && <p role="alert" className="mb-3 text-sm text-red-700">{recentCallError}</p>}
          <div className="space-y-4">
            {recentCalls.map((call) => {
              const direction = callDirection(call);
              const phone = callNumber(call) || "Unknown number";
              return (
              <button
                key={call.id}
                onClick={() => handleSelectRecentCall(call)}
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
      </div>

      {/* Bottom information */}
      <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
        <p className="text-sm font-medium text-blue-900">
          Having trouble making calls?
        </p>
        <p className="mt-1 text-sm text-blue-700">
          Make sure your browser has permission to access your microphone and
          that your device audio is configured correctly.
        </p>
      </div>
    </div>
  );
}
