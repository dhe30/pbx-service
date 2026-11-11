import { useNavigate, Link } from "react-router-dom";
import { useState } from "react";
import type { FormEvent } from "react";

import { useAuth } from "../../hooks";
import { TextField } from "../../components";
import { apiErrorMessage } from "../../services";

export function Login() {
    const { login } = useAuth();
    const navigate = useNavigate();
    const [error, setError] = useState("");

    async function handleLogin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError("");

        const formData = new FormData(event.currentTarget);

        const email = formData.get("email") as string;
        const password = formData.get("password") as string;

        try {
            await login({ email, password });
            navigate("/dashboard");
        } catch (error) {
            console.error("Login failed:", error);
            setError(apiErrorMessage(error, "Unable to log in. Please try again."));
        }
    }

    return (
        <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center bg-gray-50 px-4 py-12">
            <div className="w-full max-w-md bg-white p-8 rounded-xl shadow-md border border-gray-200">

                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-900">
                        Welcome back
                    </h1>
                    <p className="text-gray-500 mt-2">
                        Sign in to your PBX account
                    </p>
                </div>

                <form onSubmit={handleLogin} className="space-y-5">
                    {error && (
                        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                            {error}
                        </p>
                    )}
                    <TextField
                        id="email"
                        name="email"
                        label="Email"
                        type="email"
                        placeholder="Enter your email"
                        autoComplete="email"
                        testId="login-email"
                        required
                    />

                    <TextField
                        id="password"
                        name="password"
                        label="Password"
                        type="password"
                        placeholder="Enter your password"
                        autoComplete="current-password"
                        testId="login-password"
                        required
                    />

                    <button
                        type="submit"
                        data-testid="login-submit"
                        className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 active:bg-blue-800 transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                    >
                        Login
                    </button>
                </form>

                <p className="text-center text-sm text-gray-500 mt-6">
                    Don't have an account?{" "}
                    <Link to="/register" className="text-blue-600 font-semibold hover:underline">
                        Sign up
                    </Link>
                </p>
            </div>
        </div>
    );
}