import api from "./api";
import type { CardSetup } from "./billing";

export interface CreateBusinessRequest {
    name: string;
    timezone: string;
}

interface CreateBusinessResponse {
    cardSetup: CardSetup | null;
}

export const businessService = {
    async createBusiness(request: CreateBusinessRequest): Promise<CreateBusinessResponse> {
        const { data } = await api.post<CreateBusinessResponse>("/businesses", request);
        return data;
    },
};
