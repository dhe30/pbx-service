import { NavLink } from "react-router-dom";
import { useAuth } from "../../hooks";

const navItems = [
  { name: "Dashboard", path: "/dashboard" },
  { name: "Phone", path: "/phone" },
  { name: "Call History", path: "/history" },
  { name: "Voicemail", path: "/voicemail" },
  { name: "Recordings", path: "/recordings" },
  { name: "Call Routing", path: "/routing", adminOnly: true },
  { name: "Team Management", path: "/team", adminOnly: true },
  { name: "Purchase", path: "/purchase", adminOnly: true },
  { name: "Billing", path: "/billing", adminOnly: true },
  { name: "Support", path: "/support" },
];

export function BusinessNavbar() {
  const { user } = useAuth();
  const visibleNavItems = navItems.filter(
    (item) => !item.adminOnly || user?.role === "owner",
  );

  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center gap-8 px-6">
        {visibleNavItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `border-b-2 py-4 text-sm font-medium transition-colors ${
                isActive
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-600 hover:text-gray-900"
              }`
            }
          >
            {item.name}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}