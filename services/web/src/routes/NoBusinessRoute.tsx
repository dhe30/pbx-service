import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../hooks";
import { apiErrorMessage, authService } from "../services";

export function NoBusinessRoute() {
  const { user, loading, updateUser } = useAuth();
  const [checkedUserId, setCheckedUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (loading || !user) return;

    let active = true;
    let checking = false;
    const refreshMembership = async () => {
      if (checking) return;
      checking = true;
      try {
        const currentUser = await authService.getCurrentUser();
        if (!active) return;
        updateUser(currentUser);
        setCheckedUserId(currentUser.id);
        setError("");
      } catch (cause) {
        if (active) setError(apiErrorMessage(cause, "Could not check business membership."));
      } finally {
        checking = false;
      }
    };

    void refreshMembership();
    const interval = window.setInterval(() => void refreshMembership(), 10_000);
    window.addEventListener("focus", refreshMembership);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshMembership);
    };
  }, [loading, retry, updateUser, user?.id]);

  if (loading || (user && checkedUserId !== user.id && !error)) {
    return <p role="status" className="p-8 text-center text-gray-500">Checking business membership…</p>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (error && checkedUserId !== user.id) {
    return (
      <div role="alert" className="mx-auto mt-8 max-w-xl rounded-lg bg-red-50 p-4 text-sm text-red-700">
        <p>{error}</p>
        <button type="button" className="mt-3 font-semibold underline" onClick={() => setRetry((value) => value + 1)}>
          Retry
        </button>
      </div>
    );
  }

  if (user.role === "staff" && user.businessId) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}