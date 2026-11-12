import api from "./api";

type NumberKind = "local" | "toll_free";
type BillingItemKind = "extension" | "intl_calling" | "recording";

async function purchaseItem(kind: BillingItemKind, idempotencyKey: string) {
  const response = await api.post(
    "/billing/items",
    { kind },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
  return response.data;
}

export const purchaseService = {
  async getCatalog() {
    const { data } = await api.get("/billing/prices");
    return data;
  },

  async getOwnedNumbers() {
    const { data } = await api.get("/numbers");
    return data;
  },

  async searchNumbers(params: {
    country: string;
    regionId?: string;
    cityId?: string;
    areaCode?: string;
    kind?: NumberKind;
    limit?: number;
  }) {
    const { data } = await api.get("/numbers/available", {
      params,
    });
    return data;
  },

  async purchaseNumber(availableNumberId: string, idempotencyKey: string) {
    const response = await api.post(
      "/numbers/purchase",
      { availableNumberId },
      { headers: { "Idempotency-Key": idempotencyKey } },
    );
    return response.data;
  },

  purchaseItem,

  purchaseAddon(
    addon: "internationalCalling" | "callRecording",
    idempotencyKey: string,
  ) {
    return purchaseItem(
      addon === "internationalCalling" ? "intl_calling" : "recording",
      idempotencyKey,
    );
  },

  async releaseNumber(numberId: string) {
    const response = await api.delete(`/numbers/${numberId}`);
    return response.data;
  },

  async cancelItem(itemId: string) {
    const response = await api.delete(`/billing/items/${itemId}`);
    return response.data;
  },
};