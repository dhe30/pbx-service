import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../hooks";

export function GuestRoute() {
    const { user, loading } = useAuth();

    if (loading) {
        return <div>Loading...</div>;
    }

    if (user) {
        return <Navigate to={user.businessId ? "/dashboard" : "/account/create-business"} replace />;
    }

    return <Outlet />;
}
