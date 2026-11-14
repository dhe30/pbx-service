import { useState, type FormEvent } from "react";
import { apiErrorMessage, dataService, type Extension, type Mailbox } from "../../services";
import {
  formToForward,
  forwardToForm,
  MAX_EXTERNAL_NUMBERS,
  parseNumberList,
  type ForwardForm,
} from "./extension-call-handling";

// Course spec §3: an extension has a voicemail box and forwarding (always, busy, no answer) to an
// extension or external number; a call rings all its devices, its softphone and its listed
// external numbers at once. Everything the API can do must be possible on the website (§4).

const RULES = [
  { key: "forwardAlways", label: "Forward always", help: "Every call goes straight here; the phones don't ring." },
  { key: "forwardBusy", label: "When busy", help: "None = the extension's voicemail box (or hang up without one)." },
  { key: "forwardNoAnswer", label: "When not answered", help: "After the ring time. None = the extension's voicemail box." },
] as const;
type RuleKey = (typeof RULES)[number]["key"];

interface Props {
  extension: Extension;
  extensions: Extension[];
  mailboxes: Mailbox[];
  onSaved: (updated: Extension) => void;
}

export function ExtensionCallHandling({ extension, extensions, mailboxes, onSaved }: Props) {
  const [externalText, setExternalText] = useState(extension.externalNumbers.join("\n"));
  const [ringTimeoutSec, setRingTimeoutSec] = useState(String(extension.ringTimeoutSec));
  const [mailboxId, setMailboxId] = useState(extension.mailboxId ?? "");
  const [rules, setRules] = useState<Record<RuleKey, ForwardForm>>({
    forwardAlways: forwardToForm(extension.forwardAlways),
    forwardBusy: forwardToForm(extension.forwardBusy),
    forwardNoAnswer: forwardToForm(extension.forwardNoAnswer),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const otherExtensions = extensions.filter((e) => e.id !== extension.id);
  const idPrefix = `ext-${extension.id}`;

  function setRule(key: RuleKey, patch: Partial<ForwardForm>) {
    setRules((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");

    const { numbers, invalid } = parseNumberList(externalText);
    if (invalid.length) {
      setError(`Not phone numbers: ${invalid.join(", ")}. Use 10 digits, 1 + 10 digits, +country… or 011….`);
      return;
    }
    if (numbers.length > MAX_EXTERNAL_NUMBERS) {
      setError(`At most ${MAX_EXTERNAL_NUMBERS} external numbers.`);
      return;
    }
    const ring = Number(ringTimeoutSec);
    if (!Number.isInteger(ring) || ring < 5 || ring > 120) {
      setError("Ring time must be a whole number of seconds from 5 to 120.");
      return;
    }
    const forwards: Partial<Record<RuleKey, Extension["forwardAlways"]>> = {};
    for (const rule of RULES) {
      const result = formToForward(rules[rule.key], rule.label);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      forwards[rule.key] = result.value;
    }

    setSaving(true);
    try {
      const updated = await dataService.updateExtension(extension.id, {
        ...extension,
        externalNumbers: numbers,
        ringTimeoutSec: ring,
        mailboxId: mailboxId || null,
        forwardAlways: forwards.forwardAlways ?? null,
        forwardBusy: forwards.forwardBusy ?? null,
        forwardNoAnswer: forwards.forwardNoAnswer ?? null,
      });
      onSaved(updated);
      setExternalText(updated.externalNumbers.join("\n"));
      setNotice("Call handling saved.");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not save the call handling."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSave(event)} className="mt-4 space-y-4 rounded-lg bg-gray-50 p-4" aria-label={`Call handling of extension ${extension.number}`}>
      <div className="grid gap-4 md:grid-cols-[2fr_1fr_1fr]">
        <label className="space-y-1" htmlFor={`${idPrefix}-external`}>
          <span className="text-sm font-medium text-gray-700">Also ring these numbers</span>
          <textarea
            id={`${idPrefix}-external`}
            value={externalText}
            onChange={(event) => setExternalText(event.target.value)}
            rows={2}
            placeholder={"(718) 820-6268\n+442071838750"}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
          />
          <span className="block text-xs text-gray-500">
            One per line, up to {MAX_EXTERNAL_NUMBERS}. They ring together with the extension's phones; the first to answer wins. Each is a billed outgoing call.
          </span>
        </label>
        <label className="space-y-1" htmlFor={`${idPrefix}-ring`}>
          <span className="text-sm font-medium text-gray-700">Ring time (seconds)</span>
          <input
            id={`${idPrefix}-ring`}
            type="number"
            min={5}
            max={120}
            value={ringTimeoutSec}
            onChange={(event) => setRingTimeoutSec(event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1" htmlFor={`${idPrefix}-mailbox`}>
          <span className="text-sm font-medium text-gray-700">Voicemail box</span>
          <select
            id={`${idPrefix}-mailbox`}
            value={mailboxId}
            onChange={(event) => setMailboxId(event.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">No voicemail</option>
            {mailboxes.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.name}</option>)}
          </select>
        </label>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-gray-700">Forwarding</legend>
        {RULES.map((rule) => {
          const form = rules[rule.key];
          return (
            <div key={rule.key} className="grid items-start gap-3 md:grid-cols-[10rem_12rem_1fr]">
              <label htmlFor={`${idPrefix}-${rule.key}`} className="pt-2 text-sm text-gray-700">{rule.label}</label>
              <select
                id={`${idPrefix}-${rule.key}`}
                value={form.kind}
                onChange={(event) => setRule(rule.key, { kind: event.target.value as ForwardForm["kind"], targetId: "" })}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="none">None</option>
                <option value="extension">Another extension</option>
                <option value="voicemail">A voicemail box</option>
                <option value="external">An external number</option>
              </select>
              <div className="space-y-1">
                {form.kind === "extension" && (
                  <select
                    aria-label={`${rule.label}: extension`}
                    value={form.targetId}
                    onChange={(event) => setRule(rule.key, { targetId: event.target.value })}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Choose an extension</option>
                    {otherExtensions.map((e) => <option key={e.id} value={e.id}>{e.number} · {e.name}</option>)}
                  </select>
                )}
                {form.kind === "voicemail" && (
                  <select
                    aria-label={`${rule.label}: voicemail box`}
                    value={form.targetId}
                    onChange={(event) => setRule(rule.key, { targetId: event.target.value })}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Choose a voicemail box</option>
                    {mailboxes.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.name}</option>)}
                  </select>
                )}
                {form.kind === "external" && (
                  <input
                    aria-label={`${rule.label}: phone number`}
                    type="tel"
                    value={form.number}
                    onChange={(event) => setRule(rule.key, { number: event.target.value })}
                    placeholder="(718) 820-6268"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                )}
                <p className="text-xs text-gray-500">{rule.help}</p>
              </div>
            </div>
          );
        })}
      </fieldset>

      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-700">{notice}</p>}
      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save call handling"}
      </button>
    </form>
  );
}
