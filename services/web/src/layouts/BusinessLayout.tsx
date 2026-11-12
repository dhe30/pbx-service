import { Outlet } from "react-router-dom";
import { BusinessNavbar } from "../components";
import { Softphone } from "../softphone/Softphone";

// The softphone sits beside every business page (spec §4: on the page shown after login), in the
// normal page flow so it never covers the page's own controls.
export function BusinessLayout() {
    return (
        <div className="min-h-screen bg-gray-50">
            <BusinessNavbar />

            <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <aside className="lg:order-2">
                    <div className="lg:sticky lg:top-4">
                        <Softphone />
                    </div>
                </aside>
                <main className="min-w-0 lg:order-1">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
