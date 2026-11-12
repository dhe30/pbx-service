import { Outlet } from "react-router-dom";
import { AccountNavbar } from "../components";

export function AccountLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <AccountNavbar />

      <main className="mx-auto max-w-7xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}