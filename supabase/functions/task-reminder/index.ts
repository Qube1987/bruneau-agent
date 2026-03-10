import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Task Reminder
 * Called by pg_cron every minute.
 * Checks for tasks with reminder_at <= now() and reminder_sent = false,
 * then sends push notifications to all subscribed devices.
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
    const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;

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

    const sigArray = new Uint8Array(signature);
    let r: Uint8Array, s: Uint8Array;
    if (sigArray.length === 64) {
        r = sigArray.slice(0, 32);
        s = sigArray.slice(32);
    } else {
        const rLen = sigArray[3];
        const rStart = 4;
        r = sigArray.slice(rStart, rStart + rLen);
        const sLen = sigArray[rStart + rLen + 1];
        const sStart = rStart + rLen + 2;
        s = sigArray.slice(sStart, sStart + sLen);
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

        // Find tasks with reminder_at <= now and not yet sent
        const now = new Date().toISOString();
        const { data: pendingTasks, error: taskError } = await db
            .from("tasks")
            .select("id, title, description, due_date, reminder_at, priority, category")
            .lte("reminder_at", now)
            .eq("reminder_sent", false)
            .neq("status", "done");

        if (taskError) throw new Error(`Failed to fetch tasks: ${taskError.message}`);
        if (!pendingTasks || pendingTasks.length === 0) {
            return new Response(JSON.stringify({
                success: true,
                message: "No pending reminders",
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        console.log(`Found ${pendingTasks.length} task(s) with pending reminders`);

        // Get all push subscriptions
        const { data: subscriptions, error: subError } = await db
            .from("agent_push_subscriptions")
            .select("endpoint, p256dh, auth");

        if (subError) throw new Error(`Failed to fetch subscriptions: ${subError.message}`);
        if (!subscriptions || subscriptions.length === 0) {
            console.log("No push subscriptions found, marking reminders as sent anyway");
            for (const task of pendingTasks) {
                await db.from("tasks").update({ reminder_sent: true }).eq("id", task.id);
            }
            return new Response(JSON.stringify({
                success: true,
                message: "No push subscriptions, reminders marked",
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        console.log(`Sending to ${subscriptions.length} subscription(s)`);

        const expiredEndpoints: string[] = [];
        let totalSent = 0;

        for (const task of pendingTasks) {
            const priorityEmoji = task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟠' : '';
            const payload = {
                title: `🔔 Rappel : ${task.title}`,
                body: task.description
                    ? `${priorityEmoji} ${task.description}`.trim()
                    : task.due_date
                        ? `${priorityEmoji} Échéance : ${new Date(task.due_date).toLocaleDateString('fr-FR')}`.trim()
                        : `${priorityEmoji} Tâche à faire`.trim(),
                tag: `task-reminder-${task.id}`,
                url: "/?tab=todo",
            };

            for (const sub of subscriptions) {
                const success = await sendPushNotification(sub, payload, vapidPrivateKey, vapidPublicKey);
                if (!success) {
                    if (!expiredEndpoints.includes(sub.endpoint)) {
                        expiredEndpoints.push(sub.endpoint);
                    }
                } else {
                    totalSent++;
                }
            }

            // Mark reminder as sent
            await db.from("tasks").update({ reminder_sent: true }).eq("id", task.id);
            console.log(`Reminder sent for task: ${task.title}`);
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
            tasksProcessed: pendingTasks.length,
            notificationsSent: totalSent,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error) {
        console.error("Task reminder error:", error);
        return new Response(JSON.stringify({
            success: false,
            error: error.message,
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
