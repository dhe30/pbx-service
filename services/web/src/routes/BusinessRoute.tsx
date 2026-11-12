import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../hooks";

export function BusinessRoute() {
    const { user, loading } = useAuth();

    // Wait until authentication state is determined
    if (loading) {
        return <div>Loading...</div>;
    }
    if (!user?.businessId) {
        return <Navigate to="/account/create-business" replace />;
    }

    return <Outlet />;
}