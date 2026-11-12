import { NavLink } from "react-router-dom";
import { useAuth } from "../../hooks";

export function AccountNavbar() {
  const { user } = useAuth();

  if (user?.businessId) return null;

  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-7xl gap-8 px-6">
        <NavLink
          to="/account/create-business"
          className={({ isActive }) =>
            `border-b-2 py-4 text-sm font-medium transition-colors ${
              isActive
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`
          }
        >
          Create Business
        </NavLink>
      </div>
    </nav>
  );
}