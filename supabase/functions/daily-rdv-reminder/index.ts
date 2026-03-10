import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

/**
 * Daily RDV Reminder
 * Called by pg_cron every day at 19:00 UTC (20:00 CET).
 * Fetches tomorrow's appointments from Extrabat,
 * and sends a push notification to all subscribed devices.
 */

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const db = createClient(
            Deno.env.get("SUPABASE_URL") || "",
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
        );

        const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
        const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";

        if (!vapidPublicKey || !vapidPrivateKey) {
            throw new Error("VAPID keys not configured");
        }

        // Configure web-push
        webpush.setVapidDetails(
            "mailto:quentin@bruneau27.com",
            vapidPublicKey,
            vapidPrivateKey
        );

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
            console.log("No appointments tomorrow, no notification sent");
            return new Response(JSON.stringify({
                success: true,
                message: "No appointments tomorrow",
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Get all push subscriptions
        const { data: subscriptions, error: subError } = await db
            .from("agent_push_subscriptions")
            .select("id, endpoint, p256dh, auth");

        if (subError) throw new Error(`Failed to fetch subscriptions: ${subError.message}`);
        if (!subscriptions || subscriptions.length === 0) {
            console.log("No push subscriptions found");
            return new Response(JSON.stringify({
                success: true,
                message: "No push subscriptions found",
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        console.log(`Sending push to ${subscriptions.length} subscription(s)`);

        // Build notification payload
        const payload = JSON.stringify({
            title: `📋 ${totalRdv} rdv demain (${dayName})`,
            body: clientRdv > 0
                ? `${clientRdv} rdv client(s) à confirmer par SMS`
                : `${totalRdv} rdv internes demain`,
            tag: "daily-rdv-reminder",
            url: "/?action=rdv-confirm",
        });

        // Send push to all subscriptions using web-push library
        const expiredIds: string[] = [];
        let sent = 0;

        for (const sub of subscriptions) {
            try {
                const pushSubscription = {
                    endpoint: sub.endpoint,
                    keys: {
                        p256dh: sub.p256dh,
                        auth: sub.auth,
                    },
                };

                await webpush.sendNotification(pushSubscription, payload);
                sent++;
                console.log(`✅ Push sent to ${sub.endpoint.substring(0, 50)}...`);
            } catch (err: any) {
                console.error(`❌ Push failed for ${sub.endpoint.substring(0, 50)}:`, err.statusCode, err.body);
                // 404 or 410 = subscription expired
                if (err.statusCode === 404 || err.statusCode === 410) {
                    expiredIds.push(sub.id);
                }
            }
        }

        // Clean up expired subscriptions
        if (expiredIds.length > 0) {
            await db.from("agent_push_subscriptions")
                .delete()
                .in("id", expiredIds);
            console.log(`Cleaned up ${expiredIds.length} expired subscription(s)`);
        }

        const result = {
            success: true,
            appointments: totalRdv,
            clientRdv,
            notificationsSent: sent,
            expiredCleaned: expiredIds.length,
        };
        console.log("Result:", JSON.stringify(result));

        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

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
