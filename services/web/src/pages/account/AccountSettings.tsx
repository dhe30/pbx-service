import { useAuth } from "../../hooks";

export function AccountSettings() {
    const { user } = useAuth();

    return (
        <div className="min-h-[calc(100vh-4rem)] bg-gray-50 px-4 py-10">
            <div className="mx-auto max-w-3xl">
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-gray-900">Account Settings</h1>
                    <p className="mt-2 text-gray-500">View your account and business information.</p>
                </div>

                <section className="mb-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 className="mb-6 text-xl font-semibold text-gray-900">Account</h2>
                    <dl className="grid gap-4 sm:grid-cols-2">
                        <div>
                            <dt className="text-sm text-gray-500">Email</dt>
                            <dd className="mt-1 font-medium text-gray-900">{user?.email}</dd>
                        </div>
                        <div>
                            <dt className="text-sm text-gray-500">Role</dt>
                            <dd className="mt-1 font-medium capitalize text-gray-900">{user?.role}</dd>
                        </div>
                    </dl>
                </section>

                <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 className="mb-6 text-xl font-semibold text-gray-900">Business</h2>
                    {user?.tenant ? (
                        <dl className="grid gap-4 sm:grid-cols-2">
                            <div>
                                <dt className="text-sm text-gray-500">Business name</dt>
                                <dd className="mt-1 font-medium text-gray-900">{user.tenant.name}</dd>
                            </div>
                            <div>
                                <dt className="text-sm text-gray-500">Time zone</dt>
                                <dd className="mt-1 font-medium text-gray-900">{user.tenant.timezone}</dd>
                            </div>
                        </dl>
                    ) : (
                        <p className="text-sm text-gray-500">No business is associated with this account yet.</p>
                    )}
                    <p className="mt-5 text-sm text-gray-500">
                        Email and password changes are not currently supported by the API.
                    </p>
                </section>
            </div>
        </div>
    );
}
