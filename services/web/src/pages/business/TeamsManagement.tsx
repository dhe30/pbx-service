import { useEffect, useState, type FormEvent } from "react";
import { apiErrorMessage, dataService, type Extension, type StaffMember } from "../../services";

export function TeamsManagement() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [loading, setLoading] = useState(true);
  const [staffEmail, setStaffEmail] = useState("");
  const [staffPassword, setStaffPassword] = useState("");
  const [addingStaff, setAddingStaff] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([dataService.getStaff(), dataService.getExtensions()])
      .then(([members, extensionList]) => {
        if (!active) return;
        setStaff(members);
        setExtensions(extensionList);
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

  const extensionByUser = new Map(extensions.filter((extension) => extension.userId).map((extension) => [extension.userId, extension]));

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
        <p className="mt-2 text-gray-500">Staff and extension assignments currently configured in the PBX.</p>
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
                  const extension = extensionByUser.get(member.id);
                  return (
                    <tr key={member.id}>
                      <td className="px-5 py-4 font-medium text-gray-900">{member.email}</td>
                      <td className="px-5 py-4 capitalize text-gray-600">{member.role}</td>
                      <td className="px-5 py-4 text-gray-600">{extension ? `${extension.name} · ${extension.number}` : "Not assigned"}</td>
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
        </div>
        {extensions.length ? (
          <ul className="divide-y divide-gray-100">
            {extensions.map((extension) => (
              <li key={extension.id} className="flex flex-wrap justify-between gap-3 p-5">
                <div>
                  <p className="font-medium text-gray-900">{extension.name}</p>
                  <p className="mt-1 text-sm text-gray-500">Extension {extension.number} · SIP user {extension.sipUsername}</p>
                </div>
                <p className="text-sm text-gray-500">{extension.userId ? staff.find((member) => member.id === extension.userId)?.email ?? "Assigned user" : "Unassigned"}</p>
              </li>
            ))}
          </ul>
        ) : !loading && !error && <p className="p-6 text-sm text-gray-500">No extensions are configured.</p>}
      </section>
    </div>
  );
}

export { TeamsManagement as TeamManagement };
