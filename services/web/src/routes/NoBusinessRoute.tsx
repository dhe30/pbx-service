import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../hooks";

export function NoBusinessRoute() {
  const { user, loading } = useAuth();

  if (loading) return <div>Loading...</div>;

  if (user?.businessId) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}