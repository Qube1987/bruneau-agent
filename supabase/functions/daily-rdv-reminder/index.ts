import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Daily RDV Reminder
 * Called by pg_cron every day at 19:00 UTC (20:00 CET).
 * Fetches tomorrow's appointments from Extrabat, counts client RDVs,
 * and sends a push notification to all subscribed devices.
 */

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Web Push helpers
function base64UrlToBuffer(base64url: string): Uint8Array {
    const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob(base64 + padding);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importVapidKey(privateKeyBase64: string): Promise<CryptoKey> {
    const raw = base64UrlToBuffer(privateKeyBase64);
    return crypto.subtle.importKey(
        "raw",
        raw,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"]
    );
}

async function createVapidJwt(endpoint: string, vapidPrivateKey: string, vapidPublicKey: string): Promise<{ authorization: string; cryptoKey: string }> {
    const audience = new URL(endpoint).origin;
    const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours

    const header = { typ: "JWT", alg: "ES256" };
    const payload = {
        aud: audience,
        exp,
        sub: "mailto:quentin@bruneau27.com",
    };

    const headerB64 = bufferToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
    const payloadB64 = bufferToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const unsignedToken = `${headerB64}.${payloadB64}`;

    const key = await importVapidKey(vapidPrivateKey);
    const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        new TextEncoder().encode(unsignedToken)
    );

    // Convert DER signature to raw r||s format
    const sigArray = new Uint8Array(signature);
    let r: Uint8Array, s: Uint8Array;
    if (sigArray.length === 64) {
        r = sigArray.slice(0, 32);
        s = sigArray.slice(32);
    } else {
        // DER format
        const rLen = sigArray[3];
        const rStart = 4;
        r = sigArray.slice(rStart, rStart + rLen);
        const sLen = sigArray[rStart + rLen + 1];
        const sStart = rStart + rLen + 2;
        s = sigArray.slice(sStart, sStart + sLen);
        // Ensure 32 bytes each
        if (r.length > 32) r = r.slice(r.length - 32);
        if (s.length > 32) s = s.slice(s.length - 32);
        if (r.length < 32) { const t = new Uint8Array(32); t.set(r, 32 - r.length); r = t; }
        if (s.length < 32) { const t = new Uint8Array(32); t.set(s, 32 - s.length); s = t; }
    }
    const rawSig = new Uint8Array(64);
    rawSig.set(r, 0);
    rawSig.set(s, 32);

    const jwt = `${unsignedToken}.${bufferToBase64Url(rawSig.buffer)}`;

    return {
        authorization: `vapid t=${jwt}, k=${vapidPublicKey}`,
        cryptoKey: vapidPublicKey,
    };
}

async function sendPushNotification(
    subscription: { endpoint: string; p256dh: string; auth: string },
    payload: any,
    vapidPrivateKey: string,
    vapidPublicKey: string
): Promise<boolean> {
    try {
        const { authorization } = await createVapidJwt(
            subscription.endpoint,
            vapidPrivateKey,
            vapidPublicKey
        );

        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

        const response = await fetch(subscription.endpoint, {
            method: "POST",
            headers: {
                "Authorization": authorization,
                "TTL": "86400",
                "Content-Type": "application/json",
                "Content-Length": payloadBytes.length.toString(),
            },
            body: JSON.stringify(payload),
        });

        console.log(`Push response: ${response.status} for ${subscription.endpoint.substring(0, 50)}...`);

        if (response.status === 404 || response.status === 410) {
            // Subscription expired, should be cleaned up
            console.log("Subscription expired, should remove");
            return false;
        }

        return response.ok;
    } catch (error) {
        console.error("Push notification error:", error);
        return false;
    }
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const db = createClient(
            Deno.env.get("SUPABASE_URL") || "",
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
        );

        const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
        const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";

        if (!vapidPrivateKey || !vapidPublicKey) {
            throw new Error("VAPID keys not configured");
        }

        // Calculate tomorrow's date
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split("T")[0];

        const dayNames = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
        const dayName = dayNames[tomorrow.getDay()];

        console.log(`Fetching appointments for tomorrow: ${tomorrowStr} (${dayName})`);

        // Fetch Quentin's agenda for tomorrow from Extrabat
        const apiKey = Deno.env.get("EXTRABAT_API_KEY");
        const securityKey = Deno.env.get("EXTRABAT_SECURITY");
        if (!apiKey || !securityKey) throw new Error("Extrabat API keys not configured");

        const extrabatUrl = `https://api.extrabat.com/v1/utilisateur/46516/rendez-vous?date_debut=${tomorrowStr}&date_fin=${tomorrowStr}&include=client`;
        const extrabatResponse = await fetch(extrabatUrl, {
            headers: {
                "Content-Type": "application/json",
                "X-EXTRABAT-API-KEY": apiKey,
                "X-EXTRABAT-SECURITY": securityKey,
            },
        });

        if (!extrabatResponse.ok) {
            throw new Error(`Extrabat API error: ${extrabatResponse.status}`);
        }

        const extrabatData = await extrabatResponse.json();
        const appointments = Array.isArray(extrabatData) ? extrabatData : Object.values(extrabatData || {});

        const totalRdv = appointments.length;
        const clientRdv = (appointments as any[]).filter((apt: any) => apt.clients?.length > 0).length;

        console.log(`Found ${totalRdv} appointments (${clientRdv} with clients)`);

        if (totalRdv === 0) {
            return new Response(JSON.stringify({
                success: true,
                message: "No appointments tomorrow, no notification sent",
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Get all push subscriptions
        const { data: subscriptions, error: subError } = await db
            .from("agent_push_subscriptions")
            .select("endpoint, p256dh, auth");

        if (subError) throw new Error(`Failed to fetch subscriptions: ${subError.message}`);
        if (!subscriptions || subscriptions.length === 0) {
            return new Response(JSON.stringify({
                success: true,
                message: "No push subscriptions found",
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        console.log(`Sending push to ${subscriptions.length} subscription(s)`);

        // Build notification payload
        const payload = {
            title: `📋 ${totalRdv} rdv demain (${dayName})`,
            body: clientRdv > 0
                ? `${clientRdv} rdv clients à confirmer par SMS. Tapez pour voir la liste.`
                : `${totalRdv} rdv internes demain.`,
            tag: "daily-rdv-reminder",
            url: "/?action=rdv-confirm",
        };

        // Send push to all subscriptions
        const expiredEndpoints: string[] = [];
        for (const sub of subscriptions) {
            const success = await sendPushNotification(sub, payload, vapidPrivateKey, vapidPublicKey);
            if (!success) {
                expiredEndpoints.push(sub.endpoint);
            }
        }

        // Clean up expired subscriptions
        if (expiredEndpoints.length > 0) {
            await db.from("agent_push_subscriptions")
                .delete()
                .in("endpoint", expiredEndpoints);
            console.log(`Cleaned up ${expiredEndpoints.length} expired subscription(s)`);
        }

        return new Response(JSON.stringify({
            success: true,
            appointments: totalRdv,
            clientRdv,
            notificationsSent: subscriptions.length - expiredEndpoints.length,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error) {
        console.error("Daily RDV reminder error:", error);
        return new Response(JSON.stringify({
            success: false,
            error: error.message,
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
