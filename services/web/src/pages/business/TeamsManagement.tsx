import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../hooks";
import { apiErrorMessage, dataService, type Extension, type Mailbox, type StaffMember } from "../../services";
import { ExtensionCallHandling } from "./ExtensionCallHandling";

export function TeamsManagement() {
  const { user } = useAuth();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [openExtensionId, setOpenExtensionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [staffEmail, setStaffEmail] = useState("");
  const [staffPassword, setStaffPassword] = useState("");
  const [addingStaff, setAddingStaff] = useState(false);
  const [extensionNumber, setExtensionNumber] = useState("");
  const [extensionName, setExtensionName] = useState("");
  const [extensionUserId, setExtensionUserId] = useState("");
  const [creatingExtension, setCreatingExtension] = useState(false);
  const [savingExtensionId, setSavingExtensionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([dataService.getStaff(), dataService.getExtensions(), dataService.getMailboxes()])
      .then(([members, extensionList, mailboxList]) => {
        if (!active) return;
        setStaff(members);
        setExtensions(extensionList);
        setMailboxes(mailboxList);
      })
      .catch((cause: unknown) => {
        if (active) setError(apiErrorMessage(cause, "Could not load team information."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const extensionsByUser = new Map<string, Extension[]>();
  for (const extension of extensions) {
    if (!extension.userId) continue;
    extensionsByUser.set(extension.userId, [...(extensionsByUser.get(extension.userId) ?? []), extension]);
  }

  async function handleExtensionAssignment(extension: Extension, userId: string) {
    setError("");
    setNotice("");
    setSavingExtensionId(extension.id);
    try {
      const updated = await dataService.updateExtension(extension.id, {
        ...extension,
        userId: userId || null,
      });
      setExtensions((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(`${extension.name} assignment updated.`);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not update the extension assignment."));
    } finally {
      setSavingExtensionId(null);
    }
  }

  async function handleCreateExtension(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setCreatingExtension(true);
    try {
      const extension = await dataService.createExtension(
        extensionNumber.trim(),
        extensionName.trim(),
        extensionUserId || null,
      );
      setExtensions((current) => [...current, extension]);
      setExtensionNumber("");
      setExtensionName("");
      setExtensionUserId("");
      setNotice(`Extension ${extension.number} created.`);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not create the extension."));
    } finally {
      setCreatingExtension(false);
    }
  }

  async function handleAddStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setAddingStaff(true);
    try {
      const member = await dataService.createStaff(staffEmail.trim(), staffPassword || undefined);
      setStaff((current) => [...current.filter((existing) => existing.id !== member.id), member]);
      setStaffEmail("");
      setStaffPassword("");
      setNotice("Staff account added.");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not add the staff account."));
    } finally {
      setAddingStaff(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">Team Management</h1>
        <p className="mt-2 text-gray-500">Manage staff accounts and assign business extensions to team members.</p>
      </header>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-green-50 p-4 text-sm text-green-700">{notice}</p>}
      {loading && <p role="status" className="text-sm text-gray-500">Loading team…</p>}

      <form onSubmit={(event) => void handleAddStaff(event)} className="grid gap-4 rounded-xl border border-gray-200 bg-white p-5 sm:grid-cols-[1fr_1fr_auto]">
        <label className="space-y-2">
          <span className="text-sm font-medium text-gray-700">Staff email</span>
          <input
            type="email"
            value={staffEmail}
            onChange={(event) => setStaffEmail(event.target.value)}
            required
            autoComplete="email"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-2">
          <span className="text-sm font-medium text-gray-700">New account password (optional)</span>
          <input
            type="password"
            value={staffPassword}
            onChange={(event) => setStaffPassword(event.target.value)}
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={addingStaff}
          className="self-end rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {addingStaff ? "Adding…" : "Add staff"}
        </button>
        <p className="text-sm text-gray-500 sm:col-span-3">
          Leave the password blank to attach an existing account; enter one to create a new login.
        </p>
      </form>

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-5">
          <h2 className="font-semibold text-gray-900">Staff accounts</h2>
        </div>
        {staff.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr><th className="px-5 py-3">Email</th><th className="px-5 py-3">Role</th><th className="px-5 py-3">Extension</th><th className="px-5 py-3">Created</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {staff.map((member) => {
                  const assignedExtensions = extensionsByUser.get(member.id) ?? [];
                  return (
                    <tr key={member.id}>
                      <td className="px-5 py-4 font-medium text-gray-900">{member.email}</td>
                      <td className="px-5 py-4 capitalize text-gray-600">{member.role}</td>
                      <td className="px-5 py-4 text-gray-600">
                        {assignedExtensions.length ? assignedExtensions.map((extension) => `${extension.name} · ${extension.number}`).join(", ") : "Not assigned"}
                      </td>
                      <td className="px-5 py-4 text-gray-600">{new Date(member.createdAt).toLocaleDateString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : !loading && !error && <p className="p-6 text-sm text-gray-500">No staff accounts are configured.</p>}
      </section>

      <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-5">
          <h2 className="font-semibold text-gray-900">Extensions</h2>
          <p className="mt-1 text-sm text-gray-500">Create phone extensions and assign them to team members.</p>
        </div>
        <form onSubmit={(event) => void handleCreateExtension(event)} className="grid gap-4 border-b border-gray-200 p-5 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <label className="space-y-2">
            <span className="text-sm font-medium text-gray-700">Extension number</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{1,8}"
              maxLength={8}
              value={extensionNumber}
              onChange={(event) => setExtensionNumber(event.target.value)}
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-2">
            <span className="text-sm font-medium text-gray-700">Name</span>
            <input
              type="text"
              value={extensionName}
              onChange={(event) => setExtensionName(event.target.value)}
              required
              maxLength={120}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-2">
            <span className="text-sm font-medium text-gray-700">Assign to (optional)</span>
            <select
              value={extensionUserId}
              onChange={(event) => setExtensionUserId(event.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Unassigned</option>
              {user && <option value={user.id}>{user.email} (you)</option>}
              {staff.map((member) => <option key={member.id} value={member.id}>{member.email}</option>)}
            </select>
          </label>
          <button
            type="submit"
            disabled={creatingExtension}
            className="self-end rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {creatingExtension ? "Creating…" : "Create extension"}
          </button>
        </form>
        {extensions.length ? (
          <ul className="divide-y divide-gray-100">
            {extensions.map((extension) => (
              <li key={extension.id} className="p-5">
                <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <p className="font-medium text-gray-900">{extension.name}</p>
                  <p className="mt-1 text-sm text-gray-500">Extension {extension.number} · SIP user {extension.sipUsername}</p>
                  <p className="mt-1 text-sm text-gray-500">{callHandlingSummary(extension, extensions, mailboxes)}</p>
                  <button
                    type="button"
                    onClick={() => setOpenExtensionId((current) => current === extension.id ? null : extension.id)}
                    aria-expanded={openExtensionId === extension.id}
                    className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-800"
                  >
                    {openExtensionId === extension.id ? "Close call handling" : "Edit call handling"}
                  </button>
                </div>
                <label className="flex items-center gap-3 text-sm text-gray-600">
                  <span>Assigned to</span>
                  <select
                    aria-label={`Assign extension ${extension.number}`}
                    value={extension.userId ?? ""}
                    onChange={(event) => void handleExtensionAssignment(extension, event.target.value)}
                    disabled={savingExtensionId !== null}
                    className="min-w-48 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:bg-gray-100"
                  >
                    <option value="">Unassigned</option>
                    {user && <option value={user.id}>{user.email} (you)</option>}
                    {staff.map((member) => (
                      <option key={member.id} value={member.id}>{member.email}</option>
                    ))}
                  </select>
                </label>
                </div>
                {openExtensionId === extension.id && (
                  <ExtensionCallHandling
                    extension={extension}
                    extensions={extensions}
                    mailboxes={mailboxes}
                    onSaved={(updated) => setExtensions((current) => current.map((item) => item.id === updated.id ? updated : item))}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : !loading && !error && <p className="p-6 text-sm text-gray-500">No extensions are configured.</p>}
      </section>
    </div>
  );
}

/** One line under each extension: what its calls do besides ringing its phones. */
function callHandlingSummary(extension: Extension, extensions: Extension[], mailboxes: Mailbox[]): string {
  const describe = (value: unknown): string => {
    if (!value || typeof value !== "object") return "";
    const v = value as { type?: string; id?: string; number?: string };
    if (v.type === "external") return v.number ?? "";
    if (v.type === "extension") return `extension ${extensions.find((e) => e.id === v.id)?.number ?? "?"}`;
    if (v.type === "voicemail") return `voicemail (${mailboxes.find((m) => m.id === v.id)?.name ?? "?"})`;
    return "";
  };
  const parts: string[] = [];
  if (extension.forwardAlways) parts.push(`forwards every call to ${describe(extension.forwardAlways)}`);
  if (extension.externalNumbers.length) parts.push(`also rings ${extension.externalNumbers.join(", ")}`);
  if (extension.forwardBusy) parts.push(`busy → ${describe(extension.forwardBusy)}`);
  if (extension.forwardNoAnswer) parts.push(`no answer → ${describe(extension.forwardNoAnswer)}`);
  if (!parts.length) parts.push(extension.mailboxId ? "Rings its phones, then voicemail" : "Rings its phones");
  return parts.join(" · ").replace(/^./, (c) => c.toUpperCase());
}

export { TeamsManagement as TeamManagement };
