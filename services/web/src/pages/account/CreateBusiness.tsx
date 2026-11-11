import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks";
import {
    apiErrorMessage,
    authService,
    billingService,
    businessService,
    dataService,
    type CardSetup,
} from "../../services";

interface StripeCardField {
    mount(target: HTMLElement): void;
    unmount(): void;
}

interface StripeClient {
    elements(): {
        create(type: "card"): StripeCardField;
    };
    confirmCardSetup(
        clientSecret: string,
        data: { payment_method: { card: StripeCardField } },
    ): Promise<{
        setupIntent?: { id: string; status: string };
        error?: { message?: string };
    }>;
}

declare global {
    interface Window {
        Stripe?: (publishableKey: string) => StripeClient;
    }
}

let stripeScriptUrl = "";
let stripeScriptPromise: Promise<void> | null = null;

function loadStripeScript(url: string): Promise<void> {
    if (window.Stripe) return Promise.resolve();
    if (stripeScriptPromise && stripeScriptUrl === url) return stripeScriptPromise;

    stripeScriptUrl = url;
    stripeScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
            stripeScriptPromise = null;
            reject(new Error("Could not load the secure card form."));
        };
        document.head.appendChild(script);
    });
    return stripeScriptPromise;
}

const timeZones = Intl.supportedValuesOf("timeZone");

export function CreateBusiness() {
    const navigate = useNavigate();
    const { user, loading: authLoading, updateUser } = useAuth();
    const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    const [businessName, setBusinessName] = useState(user?.tenant?.name ?? "");
    const [timezone, setTimezone] = useState(user?.tenant?.timezone ?? defaultTimeZone);
    const [businessCreated, setBusinessCreated] = useState(false);
    const [cardSetup, setCardSetup] = useState<CardSetup | null>(null);
    const [stripeLoading, setStripeLoading] = useState(false);
    const [stripeLoadVersion, setStripeLoadVersion] = useState(0);
    const [restoringAccount, setRestoringAccount] = useState(false);
    const [savingCard, setSavingCard] = useState(false);
    const [creatingBusiness, setCreatingBusiness] = useState(false);
    const [error, setError] = useState("");

    const cardContainer = useRef<HTMLDivElement>(null);
    const stripe = useRef<StripeClient | null>(null);
    const cardField = useRef<StripeCardField | null>(null);
    const initializedForUser = useRef<string | null>(null);

    useEffect(() => {
        if (authLoading) return;
        if (!user) {
            navigate("/login", { replace: true });
            return;
        }
        if (initializedForUser.current === user.id) return;

        initializedForUser.current = user.id;
        setBusinessName(user.tenant?.name ?? "");
        setTimezone(user.tenant?.timezone ?? defaultTimeZone);
        if (!user.businessId) {
            setBusinessCreated(false);
            return;
        }

        setRestoringAccount(true);
        let active = true;
        async function restorePendingPayment() {
            try {
                const billing = await dataService.getBilling();
                if (!active) return;
                if (billing.card && billing.planPaidThrough) {
                    navigate("/dashboard", { replace: true });
                    return;
                }

                setBusinessCreated(true);
                setCardSetup(await billingService.createSetupIntent());
            } catch (cause) {
                if (active) {
                    setBusinessCreated(true);
                    setError(apiErrorMessage(cause, "Could not restore business payment setup. Please try again."));
                }
            } finally {
                if (active) setRestoringAccount(false);
            }
        }

        void restorePendingPayment();
        return () => {
            active = false;
        };
    }, [authLoading, defaultTimeZone, navigate, user]);

    useEffect(() => {
        if (!cardSetup || !businessCreated || !cardContainer.current) return;
        const setup = cardSetup;
        let active = true;
        setStripeLoading(true);

        async function mountCardField() {
            try {
                await loadStripeScript(setup.stripeJsUrl);
                if (!active || !cardContainer.current || !window.Stripe) return;
                const stripeClient = window.Stripe(setup.publishableKey);
                const field = stripeClient.elements().create("card");
                field.mount(cardContainer.current);
                stripe.current = stripeClient;
                cardField.current = field;
            } catch (cause) {
                if (active) setError(apiErrorMessage(cause, "Could not load secure card entry."));
            } finally {
                if (active) setStripeLoading(false);
            }
        }

        void mountCardField();
        return () => {
            active = false;
            cardField.current?.unmount();
            cardField.current = null;
            stripe.current = null;
        };
    }, [businessCreated, cardSetup, stripeLoadVersion]);

    async function handleCreateBusiness(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError("");
        if (!user || user.businessId) {
            setError("This account already belongs to a business. Reload the page to continue.");
            return;
        }

        setCreatingBusiness(true);
        try {
            const result = await businessService.createBusiness({
                name: businessName.trim(),
                timezone,
            });
            setBusinessCreated(true);
            try {
                updateUser(await authService.getCurrentUser());
            } catch (cause) {
                setError(apiErrorMessage(cause, "Business created, but account details could not be refreshed. Reload to continue."));
            }
            if (result.cardSetup) {
                setCardSetup(result.cardSetup);
            } else {
                setCardSetup(await billingService.createSetupIntent());
            }
        } catch (cause) {
            setError(
                apiErrorMessage(
                    cause,
                    businessCreated
                        ? "Business created, but secure card setup could not start. Please retry."
                        : "Could not create your business. Please try again.",
                ),
            );
        } finally {
            setCreatingBusiness(false);
        }
    }

    async function handleSaveCard(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!cardSetup || !stripe.current || !cardField.current) {
            setError("Secure card entry is not ready yet. Please wait and try again.");
            return;
        }

        setSavingCard(true);
        setError("");
        let cardSaved = false;
        try {
            const result = await stripe.current.confirmCardSetup(cardSetup.clientSecret, {
                payment_method: { card: cardField.current },
            });
            if (result.error) {
                setError(result.error.message ?? "Card confirmation failed. Check the card details and try again.");
                return;
            }
            if (!result.setupIntent || result.setupIntent.status !== "succeeded") {
                setError("Card setup was not confirmed. Please try again.");
                return;
            }

            await billingService.saveCard(result.setupIntent.id);
            cardSaved = true;
            updateUser(await authService.getCurrentUser());
            navigate("/dashboard", { replace: true });
        } catch (cause) {
            const message = cardSaved
                ? "Your card was saved, but we could not refresh your account. Reload this page to continue."
                : apiErrorMessage(cause, "Could not save your card. Please try again.");
            setError(message);
            if (!cardSaved) {
                try {
                    setCardSetup(await billingService.createSetupIntent());
                } catch (setupCause) {
                    setError(`${message} ${apiErrorMessage(setupCause, "A new card setup could not be started.")}`);
                }
            }
        } finally {
            setSavingCard(false);
        }
    }

    async function retryCardSetup() {
        setError("");
        try {
            setCardSetup(await billingService.createSetupIntent());
        } catch (cause) {
            setError(apiErrorMessage(cause, "Could not start secure card setup. Please try again."));
        }
    }

    if (authLoading || restoringAccount || !user) {
        return <p role="status" className="p-8 text-center text-gray-500">Loading…</p>;
    }

    return (
        <div className="min-h-[calc(100vh-4rem)] bg-gray-50 px-4 py-10">
            <div className="mx-auto w-full max-w-xl rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
                <header className="mb-8">
                    <p className="text-sm font-semibold text-blue-600">{businessCreated ? "Step 2 of 2" : "Step 1 of 2"}</p>
                    <h1 className="mt-2 text-3xl font-bold text-gray-900">
                        {businessCreated ? "Add a payment method" : "Create your business"}
                    </h1>
                    <p className="mt-2 text-sm text-gray-500">
                        {businessCreated
                            ? "Your business is set up. Add a card to activate the plan."
                            : "Enter your business details. Your card will be collected securely in the next step."}
                    </p>
                </header>

                {error && (
                    <p role="alert" className="mb-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                        {error}
                    </p>
                )}

                {!businessCreated ? (
                    <form onSubmit={(event) => void handleCreateBusiness(event)} className="space-y-5">
                        <p className="text-sm text-gray-600">
                            Account email: <span className="font-medium text-gray-900">{user.email}</span>
                        </p>
                        <label className="block space-y-2">
                            <span className="text-sm font-medium text-gray-700">Business name</span>
                            <input
                                name="businessName"
                                value={businessName}
                                onChange={(event) => setBusinessName(event.target.value)}
                                maxLength={100}
                                required
                                autoComplete="organization"
                                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                            />
                        </label>
                        <label className="block space-y-2">
                            <span className="text-sm font-medium text-gray-700">Business time zone</span>
                            <select
                                value={timezone}
                                onChange={(event) => setTimezone(event.target.value)}
                                required
                                className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                            >
                                {!timeZones.includes(timezone) && <option value={timezone}>{timezone}</option>}
                                {timeZones.map((zone) => (
                                    <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>
                                ))}
                            </select>
                        </label>
                        <button
                            type="submit"
                            disabled={creatingBusiness}
                            className="w-full rounded-lg bg-blue-600 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                            {creatingBusiness ? "Creating business…" : "Create business and continue"}
                        </button>
                    </form>
                ) : cardSetup ? (
                    <form onSubmit={(event) => void handleSaveCard(event)} className="space-y-5">
                        <p className="text-sm text-gray-600">
                            Business: <span className="font-medium text-gray-900">{businessName || user.tenant?.name}</span>
                        </p>
                        <div className="rounded-lg border border-gray-300 px-4 py-4">
                            <div ref={cardContainer} aria-label="Credit or debit card" />
                        </div>
                        {stripeLoading && <p role="status" className="text-sm text-gray-500">Loading secure card entry…</p>}
                        <p className="text-xs leading-5 text-gray-500">
                            Card details are entered securely with the payment provider and are not sent to this app.
                        </p>
                        {!stripeLoading && !stripe.current && (
                            <button
                                type="button"
                                onClick={() => setStripeLoadVersion((version) => version + 1)}
                                className="text-sm font-medium text-blue-700"
                            >
                                Retry secure card entry
                            </button>
                        )}
                        <button
                            type="submit"
                            disabled={stripeLoading || savingCard || !stripe.current}
                            className="w-full rounded-lg bg-blue-600 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                            {savingCard ? "Saving card…" : "Save card and activate plan"}
                        </button>
                    </form>
                ) : businessCreated ? (
                    <button
                        type="button"
                        onClick={() => void retryCardSetup()}
                        className="w-full rounded-lg bg-blue-600 py-3 font-semibold text-white hover:bg-blue-700"
                    >
                        Retry secure card setup
                    </button>
                ) : null}
            </div>
        </div>
    );
}
