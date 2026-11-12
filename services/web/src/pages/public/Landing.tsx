import { Link } from "react-router-dom";

export function Landing() {
    return (
        <div className="flex min-h-[80vh] items-center justify-center px-6">
            <div className="max-w-xl text-center">
                <h1 className="text-4xl font-bold tracking-tight text-gray-900">
                    Welcome to PBX
                </h1>

                <p className="mt-4 text-lg text-gray-600">
                    A simple platform for managing your business phone system.
                    Create an account to get started.
                </p>

                <div className="mt-8 flex justify-center gap-4">
                    <Link
                        to="/register"
                        className="rounded-lg bg-blue-600 px-6 py-3 font-medium text-white transition hover:bg-blue-700"
                    >
                        Create Account
                    </Link>

                    <Link
                        to="/login"
                        className="rounded-lg border border-gray-300 px-6 py-3 font-medium text-gray-700 transition hover:bg-gray-50"
                    >
                        Login
                    </Link>
                </div>
            </div>
        </div>
    );
}