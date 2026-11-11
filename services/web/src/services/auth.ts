import api from "./api";
import type { User } from "../types";

export type { User } from "../types";

export interface LoginRequest {
    email: string;
    password: string;
}

export interface RegisterRequest {
    email: string;
    password: string;
}

interface MeResponse {
    user: Pick<User, "id" | "email" | "role">;
    tenant: User["tenant"];
}

async function getCurrentUser(): Promise<User> {
    const { data } = await api.get<MeResponse>("/me");
    return {
        ...data.user,
        tenant: data.tenant,
        businessId: data.tenant?.id ?? null,
    };
}

export const authService = {
    async login(credentials: LoginRequest): Promise<User> {
        await api.post("/auth/login", credentials);
        return getCurrentUser();
    },

    async register(credentials: RegisterRequest): Promise<User> {
        await api.post("/auth/signup", credentials);
        return getCurrentUser();
    },

    async logout(): Promise<void> {
        await api.post<void>("/auth/logout");
    },

    getCurrentUser,
};
