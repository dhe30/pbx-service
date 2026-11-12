import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TextField } from "../../components";
import { useAuth } from "../../hooks";
import { apiErrorMessage } from "../../services";

export function Register() {
    const navigate = useNavigate();
    const { register } = useAuth();
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    async function handleRegister(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError("");

        const formData = new FormData(event.currentTarget);
        const email = String(formData.get("email") ?? "").trim();
        const password = String(formData.get("password") ?? "");
        const confirmPassword = String(formData.get("confirmPassword") ?? "");

        if (password.length < 8 || password.length > 128) {
            setError("Password must be between 8 and 128 characters.");
            return;
        }
        if (password !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }

        setSubmitting(true);
        try {
            await register({ email, password });
            navigate("/account/create-business", { replace: true });
        } catch (cause) {
            setError(apiErrorMessage(cause, "Could not create your account. Please try again."));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center bg-gray-50 px-4 py-12">
            <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow-md">
                <div className="mb-8 text-center">
                    <h1 className="text-3xl font-bold text-gray-900">Create an account</h1>
                    <p className="mt-2 text-gray-500">Start with your email and password.</p>
                </div>

                <form onSubmit={handleRegister} className="space-y-5">
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
                        testId="register-email"
                        required
                    />
                    <TextField
                        id="password"
                        name="password"
                        label="Password"
                        type="password"
                        placeholder="Create a password"
                        autoComplete="new-password"
                        testId="register-password"
                        minLength={8}
                        maxLength={128}
                        required
                    />
                    <TextField
                        id="confirmPassword"
                        name="confirmPassword"
                        label="Confirm password"
                        type="password"
                        placeholder="Confirm your password"
                        autoComplete="new-password"
                        testId="register-confirm-password"
                        minLength={8}
                        maxLength={128}
                        required
                    />
                    <button
                        type="submit"
                        data-testid="register-submit"
                        disabled={submitting}
                        className="w-full rounded-lg bg-blue-600 py-3 font-semibold text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 active:bg-blue-800"
                    >
                        {submitting ? "Creating account…" : "Continue"}
                    </button>
                </form>

                <p className="mt-6 text-center text-sm text-gray-500">
                    Already have an account?{" "}
                    <Link to="/login" className="font-semibold text-blue-600 hover:underline">
                        Login
                    </Link>
                </p>
            </div>
        </div>
    );
}
