// Call handling of one extension (course spec §3): numbers rung together with its phones, ring
// time, voicemail box and forwarding (always / busy / no answer). Pure helpers for the editor in
// ExtensionCallHandling.tsx; the API contract is PUT /extensions/{id} (docs/backend-for-team.md).

/** Forwarding target as the API stores it (mirrors ForwardDestinationSchema in @pbx/shared). */
export type ForwardDestination =
  | { type: "extension"; id: string }
  | { type: "voicemail"; id: string }
  | { type: "external"; number: string };

/** One forwarding rule as the form edits it. */
export interface ForwardForm {
  kind: "none" | ForwardDestination["type"];
  /** Extension id or mailbox id (kinds "extension" and "voicemail"). */
  targetId: string;
  /** Number as typed (kind "external"). */
  number: string;
}

export const MAX_EXTERNAL_NUMBERS = 10;

/**
 * A phone number as people type it, to E.164: 10 digits or 1 + 10 digits (US), +country...,
 * or 011 + country... Spaces, dashes, dots and brackets are ignored. null if it isn't a number.
 */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[^0-9+\s().-]/.test(trimmed)) return null;
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  let e164: string;
  if (plus) e164 = `+${digits}`;
  else if (digits.startsWith("011")) e164 = `+${digits.slice(3)}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else return null;
  return /^\+[1-9][0-9]{6,14}$/.test(e164) ? e164 : null;
}

/** Numbers typed one per line or comma-separated, normalized and de-duplicated. */
export function parseNumberList(text: string): { numbers: string[]; invalid: string[] } {
  const numbers: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\n,;]+/)) {
    if (!part.trim()) continue;
    const e164 = toE164(part);
    if (!e164) invalid.push(part.trim());
    else if (!numbers.includes(e164)) numbers.push(e164);
  }
  return { numbers, invalid };
}

/** The API's value (or anything unexpected) as form fields. */
export function forwardToForm(value: unknown): ForwardForm {
  const empty: ForwardForm = { kind: "none", targetId: "", number: "" };
  if (!value || typeof value !== "object") return empty;
  const v = value as Partial<Record<"type" | "id" | "number", unknown>>;
  if ((v.type === "extension" || v.type === "voicemail") && typeof v.id === "string") {
    return { kind: v.type, targetId: v.id, number: "" };
  }
  if (v.type === "external" && typeof v.number === "string") {
    return { kind: "external", targetId: "", number: v.number };
  }
  return empty;
}

/** Form fields to the API's value, or an error message for the user. */
export function formToForward(form: ForwardForm, label: string): { value: ForwardDestination | null } | { error: string } {
  switch (form.kind) {
    case "none":
      return { value: null };
    case "extension":
    case "voicemail":
      if (!form.targetId) return { error: `${label}: choose ${form.kind === "extension" ? "an extension" : "a voicemail box"}.` };
      return { value: { type: form.kind, id: form.targetId } };
    case "external": {
      const number = toE164(form.number);
      if (!number) return { error: `${label}: "${form.number}" is not a phone number (10 digits, 1 + 10 digits, +country… or 011…).` };
      return { value: { type: "external", number } };
    }
  }
}
