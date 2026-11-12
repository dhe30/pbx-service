import { useEffect, useState, type FormEvent } from "react";
import {
  apiErrorMessage,
  dataService,
  type BusinessHours,
  type Destination,
  type Extension,
  type GreetingMedia,
  type IvrConfig,
  type IvrMenu,
  type Mailbox,
  type PhoneNumber,
  type RingGroup,
} from "../../services";

interface RoutingData {
  numbers: PhoneNumber[];
  extensions: Extension[];
  ringGroups: RingGroup[];
  ivrMenus: IvrMenu[];
  businessHours: BusinessHours[];
  mailboxes: Mailbox[];
  greetings: GreetingMedia[];
}

interface DestinationOption {
  key: string;
  destination: Destination;
  label: string;
}

interface Interval {
  day: number;
  start: string;
  end: string;
}

function destinationLabel(destination: Destination | null, data: RoutingData): string {
  if (!destination) return "Not configured";
  if (destination.type === "external") return `External · ${destination.number || "number not set"}`;
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

function destinationOptions(data: RoutingData): DestinationOption[] {
  return [
    ...data.extensions.map((item) => ({
      key: `extension:${item.id}`,
      destination: { type: "extension", id: item.id } as const,
      label: `Extension · ${item.name} (${item.number})`,
    })),
    ...data.ringGroups.map((item) => ({
      key: `ring_group:${item.id}`,
      destination: { type: "ring_group", id: item.id } as const,
      label: `Ring group · ${item.name}`,
    })),
    ...data.ivrMenus.map((item) => ({
      key: `ivr_menu:${item.id}`,
      destination: { type: "ivr_menu", id: item.id } as const,
      label: `IVR · ${item.name}`,
    })),
    ...data.businessHours.map((item) => ({
      key: `business_hours:${item.id}`,
      destination: { type: "business_hours", id: item.id } as const,
      label: `Business hours · ${item.name}`,
    })),
    ...data.mailboxes.map((item) => ({
      key: `voicemail:${item.id}`,
      destination: { type: "voicemail", id: item.id } as const,
      label: `Voicemail · ${item.name}`,
    })),
    { key: "external", destination: { type: "external", number: "" }, label: "External number" },
    { key: "hangup", destination: { type: "hangup" }, label: "Hang up" },
  ];
}

function destinationKey(destination: Destination | null): string {
  if (!destination) return "unset";
  if (destination.type === "external") return "external";
  if (destination.type === "hangup") return "hangup";
  return `${destination.type}:${destination.id}`;
}

function DestinationField({
  label,
  value,
  options,
  onChange,
  allowUnset = false,
}: {
  label: string;
  value: Destination | null;
  options: DestinationOption[];
  onChange: (destination: Destination | null) => void;
  allowUnset?: boolean;
}) {
  return (
    <label className="grid gap-1 text-sm text-gray-700">
      {label}
      <select
        value={value ? destinationKey(value) : allowUnset ? "unset" : ""}
        required={!allowUnset}
        onChange={(event) => {
          const selected = event.target.value;
          if (selected === "unset") onChange(null);
          else onChange(options.find((option) => option.key === selected)?.destination ?? null);
        }}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
      >
        {allowUnset && <option value="unset">Not set</option>}
        {!allowUnset && !value && <option value="" disabled>Select a destination</option>}
        {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
      {value?.type === "external" && (
        <input
          aria-label={`${label} external phone number`}
          type="tel"
          inputMode="tel"
          pattern="\\+[1-9][0-9]{6,14}"
          placeholder="+12015550123"
          value={value.number}
          onChange={(event) => onChange({ type: "external", number: event.target.value })}
          required
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
        />
      )}
    </label>
  );
}

function NumberRouteRow({
  number,
  options,
  onSave,
  saving,
}: {
  number: PhoneNumber;
  options: DestinationOption[];
  onSave: (id: string, destination: Destination | null) => void;
  saving: boolean;
}) {
  const [destination, setDestination] = useState<Destination | null>(number.destination);
  useEffect(() => setDestination(number.destination), [number.destination]);
  const unchanged = JSON.stringify(destination) === JSON.stringify(number.destination);

  return (
    <li className="grid gap-3 border-b border-gray-100 py-4 last:border-b-0 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
      <div>
        <p className="font-medium text-gray-900">{number.did}</p>
        <p className="mt-1 text-xs capitalize text-gray-500">{number.kind} number</p>
      </div>
      <DestinationField label="Route incoming calls to" value={destination} options={options} onChange={setDestination} allowUnset />
      <button
        type="button"
        disabled={saving || unchanged}
        onClick={() => onSave(number.id, destination)}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Save route
      </button>
    </li>
  );
}

function RingGroupForm({
  initial,
  extensions,
  options,
  saving,
  onSave,
  onCancel,
}: {
  initial: RingGroup | null;
  extensions: Extension[];
  options: DestinationOption[];
  saving: boolean;
  onSave: (group: Omit<RingGroup, "id">) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [strategy, setStrategy] = useState<RingGroup["strategy"]>(initial?.strategy ?? "all");
  const [ringTimeoutSec, setRingTimeoutSec] = useState(initial?.ringTimeoutSec ?? 20);
  const [noAnswerDestination, setNoAnswerDestination] = useState<Destination | null>(initial?.noAnswerDestination ?? null);
  const [memberIds, setMemberIds] = useState<string[]>(initial?.memberIds ?? []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave({ name: name.trim(), strategy, ringTimeoutSec, noAnswerDestination, memberIds });
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-blue-100 bg-blue-50/40 p-4">
      <h3 className="font-medium text-gray-900">{initial ? "Edit ring group" : "Create ring group"}</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm text-gray-700">
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} className="rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm text-gray-700">
          Ring strategy
          <select value={strategy} onChange={(event) => setStrategy(event.target.value as RingGroup["strategy"])} className="rounded-lg border border-gray-300 bg-white px-3 py-2">
            <option value="all">Ring all together</option>
            <option value="sequential">Ring in order</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm text-gray-700">
          Ring timeout (5–120 sec)
          <input type="number" min={5} max={120} value={ringTimeoutSec} onChange={(event) => setRingTimeoutSec(Number(event.target.value))} required className="rounded-lg border border-gray-300 px-3 py-2" />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">Member extensions</legend>
        {extensions.length ? extensions.map((extension) => (
          <label key={extension.id} className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={memberIds.includes(extension.id)}
              onChange={(event) => setMemberIds((current) => event.target.checked
                ? [...current, extension.id]
                : current.filter((id) => id !== extension.id))}
            />
            {extension.name} ({extension.number})
          </label>
        )) : <p className="text-sm text-gray-500">Create an extension in Team Management first.</p>}
      </fieldset>
      <DestinationField label="If nobody answers" value={noAnswerDestination} options={options} onChange={setNoAnswerDestination} allowUnset />
      <FormActions saving={saving} onCancel={onCancel} />
    </form>
  );
}

interface IvrOptionRow {
  id: string;
  digit: string;
  destination: Destination | null;
}

function IvrMenuForm({
  initial,
  options,
  greetings,
  saving,
  uploadingGreeting,
  onSave,
  onUploadGreeting,
  onCancel,
}: {
  initial: IvrMenu | null;
  options: DestinationOption[];
  greetings: GreetingMedia[];
  saving: boolean;
  uploadingGreeting: boolean;
  onSave: (menu: Omit<IvrMenu, "id">) => void;
  onUploadGreeting: (file: File) => Promise<GreetingMedia>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [timeoutSec, setTimeoutSec] = useState(initial?.timeoutSec ?? 5);
  const [maxRetries, setMaxRetries] = useState(initial?.maxRetries ?? 3);
  const [repeatDigit, setRepeatDigit] = useState(initial?.config.repeat_digit ?? "*");
  const [greetingMediaId, setGreetingMediaId] = useState(initial?.greetingMediaId ?? "");
  const [timeoutDestination, setTimeoutDestination] = useState<Destination | null>(initial?.config.timeout ?? null);
  const [invalidDestination, setInvalidDestination] = useState<Destination | null>(initial?.config.invalid ?? null);
  const [rows, setRows] = useState<IvrOptionRow[]>(() => initial
    ? Object.entries(initial.config.options).map(([digit, destination]) => ({ id: crypto.randomUUID(), digit, destination }))
    : [{ id: crypto.randomUUID(), digit: "1", destination: null }]);
  const [validationError, setValidationError] = useState("");
  const [uploadError, setUploadError] = useState("");

  async function handleGreetingUpload(file: File | undefined) {
    if (!file) return;
    setUploadError("");
    try {
      const greeting = await onUploadGreeting(file);
      setGreetingMediaId(greeting.id);
    } catch (cause) {
      setUploadError(apiErrorMessage(cause, "Could not upload the greeting."));
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const digits = rows.map((row) => row.digit);
    if (rows.some((row) => !/^[0-9*#]$/.test(row.digit) || !row.destination) || new Set(digits).size !== digits.length) {
      setValidationError("Each menu option needs a unique DTMF key and destination.");
      return;
    }
    if (repeatDigit && !/^[0-9*#]$/.test(repeatDigit)) {
      setValidationError("Repeat key must be one DTMF digit.");
      return;
    }
    setValidationError("");
    const optionMap: Record<string, Destination> = {};
    for (const row of rows) optionMap[row.digit] = row.destination!;
    const config: IvrConfig = { options: optionMap };
    if (timeoutDestination) config.timeout = timeoutDestination;
    if (invalidDestination) config.invalid = invalidDestination;
    if (repeatDigit) config.repeat_digit = repeatDigit;
    onSave({
      name: name.trim(),
      greetingMediaId: greetingMediaId || null,
      timeoutSec,
      maxRetries,
      config,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-blue-100 bg-blue-50/40 p-4">
      <h3 className="font-medium text-gray-900">{initial ? "Edit IVR menu" : "Create IVR menu"}</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm text-gray-700">
          Menu name
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} className="rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm text-gray-700">
          Wait for input (1–30 sec)
          <input type="number" min={1} max={30} value={timeoutSec} onChange={(event) => setTimeoutSec(Number(event.target.value))} required className="rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <label className="grid gap-1 text-sm text-gray-700">
          Maximum retries (1–10)
          <input type="number" min={1} max={10} value={maxRetries} onChange={(event) => setMaxRetries(Number(event.target.value))} required className="rounded-lg border border-gray-300 px-3 py-2" />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
        <label className="grid gap-1 text-sm text-gray-700">
          Greeting audio
          <select value={greetingMediaId} onChange={(event) => setGreetingMediaId(event.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2">
            <option value="">Standard greeting</option>
            {greetings.map((greeting) => (
              <option key={greeting.id} value={greeting.id}>
                Uploaded {new Date(greeting.createdAt).toLocaleString()} {greeting.durationMs ? `(${Math.round(greeting.durationMs / 1000)}s)` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm text-gray-700">
          Upload a greeting (audio, up to 5 minutes)
          <input
            type="file"
            accept="audio/*,.mp3,.ogg,.opus,.flac,.m4a,.mp4,.webm,.aac,.aiff"
            disabled={uploadingGreeting || saving}
            onChange={(event) => {
              void handleGreetingUpload(event.target.files?.[0]);
              event.target.value = "";
            }}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1"
          />
        </label>
      </div>
      {uploadingGreeting && <p role="status" className="text-sm text-gray-500">Uploading and converting greeting…</p>}
      {uploadError && <p role="alert" className="text-sm text-red-700">{uploadError}</p>}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-gray-700">Key options</h4>
          <button type="button" onClick={() => setRows((current) => [...current, { id: crypto.randomUUID(), digit: "", destination: null }])} className="text-sm font-medium text-blue-700 hover:text-blue-900">Add key</button>
        </div>
        {rows.map((row) => (
          <div key={row.id} className="grid gap-2 sm:grid-cols-[5rem_1fr_auto] sm:items-end">
            <label className="grid gap-1 text-sm text-gray-700">
              Key
              <input
                aria-label="IVR key"
                value={row.digit}
                onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, digit: event.target.value } : item))}
                pattern="[0-9*#]"
                maxLength={1}
                required
                className="rounded-lg border border-gray-300 px-3 py-2"
              />
            </label>
            <DestinationField
              label="Destination"
              value={row.destination}
              options={options}
              onChange={(destination) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, destination } : item))}
            />
            <button type="button" onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-white">Remove</button>
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <DestinationField label="After retries time out" value={timeoutDestination} options={options} onChange={setTimeoutDestination} allowUnset />
        <DestinationField label="Invalid key action" value={invalidDestination} options={options} onChange={setInvalidDestination} allowUnset />
        <label className="grid gap-1 text-sm text-gray-700">
          Repeat-menu key
          <input value={repeatDigit} onChange={(event) => setRepeatDigit(event.target.value)} pattern="[0-9*#]" maxLength={1} className="rounded-lg border border-gray-300 px-3 py-2" />
        </label>
      </div>
      {validationError && <p role="alert" className="text-sm text-red-700">{validationError}</p>}
      <FormActions saving={saving} onCancel={onCancel} />
    </form>
  );
}

function BusinessHoursForm({
  initial,
  options,
  saving,
  onSave,
  onCancel,
}: {
  initial: BusinessHours | null;
  options: DestinationOption[];
  saving: boolean;
  onSave: (hours: Omit<BusinessHours, "id" | "openNow">) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [intervals, setIntervals] = useState<Interval[]>(initial?.schedule.intervals ?? []);
  const [openDestination, setOpenDestination] = useState<Destination | null>(initial?.openDestination ?? null);
  const [closedDestination, setClosedDestination] = useState<Destination | null>(initial?.closedDestination ?? null);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!openDestination || !closedDestination) return;
    onSave({ name: name.trim(), schedule: { intervals }, openDestination, closedDestination });
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-blue-100 bg-blue-50/40 p-4">
      <h3 className="font-medium text-gray-900">{initial ? "Edit business hours" : "Create business-hours schedule"}</h3>
      <label className="grid max-w-md gap-1 text-sm text-gray-700">
        Schedule name
        <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} className="rounded-lg border border-gray-300 px-3 py-2" />
      </label>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-gray-700">Weekly intervals (business time zone)</h4>
          <button type="button" onClick={() => setIntervals((current) => [...current, { day: 1, start: "09:00", end: "17:00" }])} className="text-sm font-medium text-blue-700 hover:text-blue-900">Add interval</button>
        </div>
        {intervals.map((interval, index) => (
          <div key={`${index}-${interval.day}-${interval.start}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <label className="grid gap-1 text-sm text-gray-700">
              Day
              <select value={interval.day} onChange={(event) => setIntervals((current) => current.map((item, i) => i === index ? { ...item, day: Number(event.target.value) } : item))} className="rounded-lg border border-gray-300 bg-white px-3 py-2">
                {days.map((day, value) => <option key={day} value={value}>{day}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm text-gray-700">
              Opens
              <input type="time" value={interval.start} onChange={(event) => setIntervals((current) => current.map((item, i) => i === index ? { ...item, start: event.target.value } : item))} required className="rounded-lg border border-gray-300 px-3 py-2" />
            </label>
            <label className="grid gap-1 text-sm text-gray-700">
              Closes
              <input type="time" value={interval.end} onChange={(event) => setIntervals((current) => current.map((item, i) => i === index ? { ...item, end: event.target.value } : item))} required className="rounded-lg border border-gray-300 px-3 py-2" />
            </label>
            <button type="button" onClick={() => setIntervals((current) => current.filter((_, i) => i !== index))} className="self-end rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-white">Remove</button>
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <DestinationField label="When open" value={openDestination} options={options} onChange={setOpenDestination} />
        <DestinationField label="When closed" value={closedDestination} options={options} onChange={setClosedDestination} />
      </div>
      <FormActions saving={saving} onCancel={onCancel} />
    </form>
  );
}

function FormActions({ saving, onCancel }: { saving: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onCancel} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-white disabled:opacity-50">Cancel</button>
      <button type="submit" disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
    </div>
  );
}

export function CallRouting() {
  const [data, setData] = useState<RoutingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingGreeting, setUploadingGreeting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ringGroupEditor, setRingGroupEditor] = useState<"new" | string | null>(null);
  const [ivrEditor, setIvrEditor] = useState<"new" | string | null>(null);
  const [hoursEditor, setHoursEditor] = useState<"new" | string | null>(null);
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  async function loadData() {
    const [numbers, extensions, ringGroups, ivrMenus, businessHours, mailboxes, greetings] = await Promise.all([
      dataService.getNumbers(),
      dataService.getExtensions(),
      dataService.getRingGroups(),
      dataService.getIvrMenus(),
      dataService.getBusinessHours(),
      dataService.getMailboxes(),
      dataService.getGreetingMedia(),
    ]);
    setData({ numbers, extensions, ringGroups, ivrMenus, businessHours, mailboxes, greetings });
  }

  useEffect(() => {
    let active = true;
    loadData()
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

  async function mutate<T>(action: () => Promise<T>, successMessage: string, onSuccess: (result: T) => void) {
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const result = await action();
      onSuccess(result);
      setNotice(successMessage);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not save routing configuration."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(action: () => Promise<unknown>, successMessage: string, onSuccess: () => void) {
    if (!window.confirm("Delete this routing configuration?")) return;
    setError("");
    setNotice("");
    setSaving(true);
    try {
      await action();
      onSuccess();
      setNotice(successMessage);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not delete the routing configuration."));
    } finally {
      setSaving(false);
    }
  }

  async function uploadGreeting(file: File): Promise<GreetingMedia> {
    setUploadingGreeting(true);
    setError("");
    try {
      const greeting = await dataService.uploadGreeting(file);
      setData((current) => current ? { ...current, greetings: [greeting, ...current.greetings] } : current);
      setNotice("Greeting uploaded and converted.");
      return greeting;
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not upload the greeting."));
      throw cause;
    } finally {
      setUploadingGreeting(false);
    }
  }

  if (loading) {
    return <div className="mx-auto max-w-7xl"><p role="status" className="text-sm text-gray-500">Loading routing configuration…</p></div>;
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        <h1 className="text-3xl font-bold text-gray-900">Call Routing</h1>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
        <button type="button" onClick={() => { setLoading(true); setError(""); void loadData().catch((cause: unknown) => setError(apiErrorMessage(cause, "Could not load call routing configuration."))).finally(() => setLoading(false)); }} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">Retry</button>
      </div>
    );
  }

  const options = destinationOptions(data);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">Call Routing</h1>
        <p className="mt-2 text-gray-500">Manage incoming number routes, IVR menus, ring groups, and business hours.</p>
      </header>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-green-50 p-4 text-sm text-green-700">{notice}</p>}

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="font-semibold text-gray-900">Phone number routes</h2>
        <p className="mt-1 text-sm text-gray-500">Choose where calls to each purchased number go.</p>
        {data.numbers.length ? (
          <ul className="mt-3">
            {data.numbers.map((number) => (
              <NumberRouteRow
                key={number.id}
                number={number}
                options={options}
                saving={saving}
                onSave={(id, destination) => void mutate(
                  () => dataService.updateNumberRoute(id, destination),
                  "Phone number route saved.",
                  (updated) => setData((current) => current ? { ...current, numbers: current.numbers.map((item) => item.id === updated.id ? updated : item) } : current),
                )}
              />
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-gray-500">No phone numbers are assigned.</p>}
      </section>

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-gray-900">Ring groups</h2>
            <p className="mt-1 text-sm text-gray-500">Ring multiple extensions together or in sequence.</p>
          </div>
          <button type="button" onClick={() => setRingGroupEditor("new")} disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Create ring group</button>
        </div>
        {ringGroupEditor === "new" && (
          <RingGroupForm
            initial={null} extensions={data.extensions} options={options} saving={saving}
            onCancel={() => setRingGroupEditor(null)}
            onSave={(group) => void mutate(
              () => dataService.createRingGroup(group), "Ring group created.",
              (created) => { setData((current) => current ? { ...current, ringGroups: [...current.ringGroups, created] } : current); setRingGroupEditor(null); },
            )}
          />
        )}
        {data.ringGroups.map((group) => (
          <div key={group.id} className="rounded-lg border border-gray-100 p-4">
            {ringGroupEditor === group.id ? (
              <RingGroupForm
                initial={group} extensions={data.extensions} options={options} saving={saving}
                onCancel={() => setRingGroupEditor(null)}
                onSave={(payload) => void mutate(
                  () => dataService.updateRingGroup(group.id, payload), "Ring group updated.",
                  (updated) => { setData((current) => current ? { ...current, ringGroups: current.ringGroups.map((item) => item.id === updated.id ? updated : item) } : current); setRingGroupEditor(null); },
                )}
              />
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-gray-900">{group.name}</p>
                  <p className="mt-1 text-sm capitalize text-gray-500">{group.strategy} · {group.ringTimeoutSec}s timeout</p>
                  <p className="mt-1 text-sm text-gray-500">Members: {group.memberIds.map((id) => {
                    const extension = data.extensions.find((item) => item.id === id);
                    return extension ? `${extension.name} (${extension.number})` : "Unavailable extension";
                  }).join(", ") || "None"}</p>
                  <p className="mt-1 text-sm text-gray-500">No answer: {destinationLabel(group.noAnswerDestination, data)}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setRingGroupEditor(group.id)} disabled={saving} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">Edit</button>
                  <button type="button" onClick={() => void remove(
                    () => dataService.deleteRingGroup(group.id), "Ring group deleted.",
                    () => setData((current) => current ? { ...current, ringGroups: current.ringGroups.filter((item) => item.id !== group.id) } : current),
                  )} disabled={saving} className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700">Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {!data.ringGroups.length && ringGroupEditor !== "new" && <p className="text-sm text-gray-500">No ring groups are configured.</p>}
      </section>

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-gray-900">IVR menus</h2>
            <p className="mt-1 text-sm text-gray-500">Map caller keypad selections to routing destinations.</p>
          </div>
          <button type="button" onClick={() => setIvrEditor("new")} disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Create IVR menu</button>
        </div>
        {ivrEditor === "new" && (
          <IvrMenuForm
            initial={null} options={options} greetings={data.greetings} saving={saving}
            uploadingGreeting={uploadingGreeting} onUploadGreeting={uploadGreeting}
            onCancel={() => setIvrEditor(null)}
            onSave={(menu) => void mutate(
              () => dataService.createIvrMenu(menu), "IVR menu created.",
              (created) => { setData((current) => current ? { ...current, ivrMenus: [...current.ivrMenus, created] } : current); setIvrEditor(null); },
            )}
          />
        )}
        {data.ivrMenus.map((menu) => (
          <div key={menu.id} className="rounded-lg border border-gray-100 p-4">
            {ivrEditor === menu.id ? (
              <IvrMenuForm
                initial={menu} options={options} greetings={data.greetings} saving={saving}
                uploadingGreeting={uploadingGreeting} onUploadGreeting={uploadGreeting}
                onCancel={() => setIvrEditor(null)}
                onSave={(payload) => void mutate(
                  () => dataService.updateIvrMenu(menu.id, payload), "IVR menu updated.",
                  (updated) => { setData((current) => current ? { ...current, ivrMenus: current.ivrMenus.map((item) => item.id === updated.id ? updated : item) } : current); setIvrEditor(null); },
                )}
              />
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-gray-900">{menu.name}</p>
                  <p className="mt-1 text-sm text-gray-500">Wait: {menu.timeoutSec}s · retries: {menu.maxRetries} · repeat key: {menu.config.repeat_digit ?? "*"}</p>
                  <ul className="mt-2 space-y-1 text-sm text-gray-500">
                    {Object.entries(menu.config.options).map(([key, destination]) => <li key={key}>Key {key}: {destinationLabel(destination, data)}</li>)}
                  </ul>
                  {menu.config.timeout && <p className="mt-1 text-sm text-gray-500">Timeout: {destinationLabel(menu.config.timeout, data)}</p>}
                  {menu.config.invalid && <p className="mt-1 text-sm text-gray-500">Invalid key: {destinationLabel(menu.config.invalid, data)}</p>}
                  <p className="mt-1 text-xs text-gray-400">{menu.greetingMediaId ? "Custom greeting configured" : "Default greeting"}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setIvrEditor(menu.id)} disabled={saving} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">Edit</button>
                  <button type="button" onClick={() => void remove(
                    () => dataService.deleteIvrMenu(menu.id), "IVR menu deleted.",
                    () => setData((current) => current ? { ...current, ivrMenus: current.ivrMenus.filter((item) => item.id !== menu.id) } : current),
                  )} disabled={saving} className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700">Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {!data.ivrMenus.length && ivrEditor !== "new" && <p className="text-sm text-gray-500">No IVR menus are configured.</p>}
      </section>

      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-gray-900">Business hours</h2>
            <p className="mt-1 text-sm text-gray-500">Schedules use the business time zone. Configure separate open and closed destinations.</p>
          </div>
          <button type="button" onClick={() => setHoursEditor("new")} disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Create schedule</button>
        </div>
        {hoursEditor === "new" && (
          <BusinessHoursForm
            initial={null} options={options} saving={saving}
            onCancel={() => setHoursEditor(null)}
            onSave={(hours) => void mutate(
              () => dataService.createBusinessHours(hours), "Business-hours schedule created.",
              (created) => { setData((current) => current ? { ...current, businessHours: [...current.businessHours, created] } : current); setHoursEditor(null); },
            )}
          />
        )}
        {data.businessHours.map((hours) => (
          <div key={hours.id} className="rounded-lg border border-gray-100 p-4">
            {hoursEditor === hours.id ? (
              <BusinessHoursForm
                initial={hours} options={options} saving={saving}
                onCancel={() => setHoursEditor(null)}
                onSave={(payload) => void mutate(
                  () => dataService.updateBusinessHours(hours.id, payload), "Business-hours schedule updated.",
                  (updated) => { setData((current) => current ? { ...current, businessHours: current.businessHours.map((item) => item.id === updated.id ? updated : item) } : current); setHoursEditor(null); },
                )}
              />
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-gray-900">{hours.name} · {hours.openNow ? "Open now" : "Closed now"}</p>
                  <p className="mt-1 text-sm text-gray-500">Hours: {hours.schedule.intervals.map(({ day, start, end }) => `${dayNames[day] ?? "Day"} ${start}–${end}`).join(", ") || "No open intervals"}</p>
                  <p className="mt-1 text-sm text-gray-500">Open: {destinationLabel(hours.openDestination, data)} · Closed: {destinationLabel(hours.closedDestination, data)}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setHoursEditor(hours.id)} disabled={saving} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">Edit</button>
                  <button type="button" onClick={() => void remove(
                    () => dataService.deleteBusinessHours(hours.id), "Business-hours schedule deleted.",
                    () => setData((current) => current ? { ...current, businessHours: current.businessHours.filter((item) => item.id !== hours.id) } : current),
                  )} disabled={saving} className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700">Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {!data.businessHours.length && hoursEditor !== "new" && <p className="text-sm text-gray-500">No business-hours schedules are configured.</p>}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="font-semibold text-gray-900">Mailboxes</h2>
        {data.mailboxes.length ? (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {data.mailboxes.map((mailbox: Mailbox) => (
              <li key={mailbox.id} className="rounded-lg border border-gray-100 p-4">
                <p className="font-medium text-gray-900">{mailbox.name}</p>
                <p className="mt-1 text-sm text-gray-500">Greeting: {mailbox.greetingMediaId ? "Configured" : "Default"}</p>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-gray-500">No mailboxes are configured.</p>}
      </section>
    </div>
  );
}
