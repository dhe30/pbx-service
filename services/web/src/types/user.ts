export type UserRole = "owner" | "staff" | "unassigned";

export interface Tenant {
    id: string;
    name: string;
    timezone: string;
    status: "active" | "past_due";
    createdAt: string;
}

export interface User {
    id: string;
    email: string;
    role: UserRole;
    tenant: Tenant | null;
    businessId: string | null;
}
