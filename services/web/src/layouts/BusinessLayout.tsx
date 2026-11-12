import { Outlet } from "react-router-dom";
import { BusinessNavbar } from "../components";

export function BusinessLayout() {
    return (
        <div className="min-h-screen bg-gray-50">
            <BusinessNavbar />

            <main className="max-w-7xl mx-auto px-6 py-8">
                <Outlet />
            </main>
        </div>
    );
}