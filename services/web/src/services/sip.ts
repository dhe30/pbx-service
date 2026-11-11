import api from "./api";

export interface SipCredentials {
    wsUri: string;
    sipUri: string;
    username: string;
    password: string;
    extensionId: string;
    extensionNumber: string;
}

export async function fetchSipCredentials(extensionId?: string): Promise<SipCredentials> {
    const { data } = await api.get<unknown>("/me/sip-credentials", {
        params: extensionId ? { extensionId } : undefined,
    });
    if (
        typeof data !== "object" ||
        data === null ||
        !("wsUri" in data) ||
        !("sipUri" in data) ||
        !("username" in data) ||
        !("password" in data) ||
        !("extensionId" in data) ||
        !("extensionNumber" in data) ||
        typeof data.wsUri !== "string" ||
        typeof data.sipUri !== "string" ||
        typeof data.username !== "string" ||
        typeof data.password !== "string" ||
        typeof data.extensionId !== "string" ||
        typeof data.extensionNumber !== "string" ||
        !data.wsUri ||
        !data.sipUri ||
        !data.username ||
        !data.password
    ) {
        throw new Error("The phone credentials response is missing required fields.");
    }

    return {
        wsUri: data.wsUri,
        sipUri: data.sipUri,
        username: data.username,
        password: data.password,
        extensionId: data.extensionId,
        extensionNumber: data.extensionNumber,
    };
}
