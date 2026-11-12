export function Support() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <h1 className="text-3xl font-bold text-gray-900">Support</h1>
        <p className="mt-2 text-gray-500">Support tickets are not available through the current PBX API.</p>
      </header>
      <section className="rounded-xl border border-gray-200 bg-white p-6">
        <p className="text-sm leading-6 text-gray-700">
          This service does not currently expose an endpoint for creating or listing support tickets.
          No ticket history is shown here.
        </p>
      </section>
    </div>
  );
}
