import api from "./api";

export interface CardSetup {
    setupIntentId: string;
    clientSecret: string;
    publishableKey: string;
    stripeJsUrl: string;
}

export const billingService = {
    async createSetupIntent(): Promise<CardSetup> {
        const { data } = await api.post<CardSetup>("/billing/setup-intent");
        return data;
    },

    async saveCard(setupIntentId: string): Promise<void> {
        await api.post("/billing/card", { setupIntentId });
    },
};
