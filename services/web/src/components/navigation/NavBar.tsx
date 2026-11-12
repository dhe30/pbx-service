import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";

import { useAuth } from "../../hooks";

export function NavBar() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const [accountMenuOpen, setAccountMenuOpen] = useState(false);

    async function handleLogout() {
        await logout();
        setAccountMenuOpen(false);
        navigate("/");
    }

    return (
        <nav className="w-full bg-white border-b border-gray-200 shadow-sm">
            <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">

                {/* Brand / Home */}
                <Link
                    to={user?.businessId ? "/dashboard" : user ? "/account/create-business" : "/"}
                    className="text-xl font-bold text-gray-900 hover:text-blue-600 transition"
                >
                    PBX Service
                </Link>

                {/* Authentication */}
                <div className="flex items-center gap-4">
                    {user ? (
                        <div className="relative">
                            <button
                                type="button"
                                aria-label="Open account menu"
                                aria-haspopup="menu"
                                aria-expanded={accountMenuOpen}
                                onClick={() => setAccountMenuOpen((open) => !open)}
                                className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center font-semibold text-lg hover:bg-blue-700 transition"
                            >
                                {user.email?.charAt(0).toUpperCase() ?? "U"}
                            </button>
                            {accountMenuOpen && (
                                <div
                                    role="menu"
                                    className="absolute right-0 z-10 mt-2 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                                >
                                    <Link
                                        to="/account/settings"
                                        role="menuitem"
                                        onClick={() => setAccountMenuOpen(false)}
                                        className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                                    >
                                        Edit account
                                    </Link>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={handleLogout}
                                        className="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                                    >
                                        Logout
                                    </button>
                                </div>
                            )}
                        </div>
                    ) : (
                        // Logged out: Show login/signup
                        <>
                            <Link
                                to="/login"
                                className="text-gray-600 font-medium hover:text-blue-600 transition"
                            >
                                Login
                            </Link>

                            <Link
                                to="/register"
                                className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition"
                            >
                                Sign Up
                            </Link>
                        </>
                    )}
                </div>
            </div>
        </nav>
    );
}
