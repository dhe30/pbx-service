import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../hooks";

export function AdminRoute() {
    const { user } = useAuth();

    if (user?.role !== "owner") {
        return <Navigate to="/dashboard" replace />;
    }

    return <Outlet />;
}
