import { Navigate } from "react-router-dom";
import { useAuth } from "../hooks";

export function AccountRedirect() {
  const { user } = useAuth();

  return (
    <Navigate
      to={user?.businessId ? "/account/settings" : "/account/create-business"}
      replace
    />
  );
}