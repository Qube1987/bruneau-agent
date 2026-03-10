import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

/**
 * Morning Summary
 * Called by pg_cron every day at 05:00 UTC (06:00 CET).
 * Sends a "Ma journée" push notification with today's appointments and tasks.
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

        webpush.setVapidDetails(
            "mailto:quentin@bruneau27.com",
            vapidPublicKey,
            vapidPrivateKey
        );

        // Today's date (CET = UTC+1, at 05:00 UTC it's 06:00 CET)
        const now = new Date();
        const todayStr = now.toISOString().split("T")[0];
        const dayNames = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
        const dayName = dayNames[now.getDay()];

        console.log(`Morning summary for ${todayStr} (${dayName})`);

        // 1. Fetch today's appointments from Extrabat
        const apiKey = Deno.env.get("EXTRABAT_API_KEY");
        const securityKey = Deno.env.get("EXTRABAT_SECURITY");
        let rdvCount = 0;
        let rdvDetails: string[] = [];

        if (apiKey && securityKey) {
            const extrabatUrl = `https://api.extrabat.com/v1/utilisateur/46516/rendez-vous?date_debut=${todayStr}&date_fin=${todayStr}&include=client`;
            const extrabatResponse = await fetch(extrabatUrl, {
                headers: {
                    "Content-Type": "application/json",
                    "X-EXTRABAT-API-KEY": apiKey,
                    "X-EXTRABAT-SECURITY": securityKey,
                },
            });

            if (extrabatResponse.ok) {
                const extrabatData = await extrabatResponse.json();
                const appointments = Array.isArray(extrabatData) ? extrabatData : Object.values(extrabatData || {});
                rdvCount = appointments.length;

                // Build short list of appointments
                const sorted = (appointments as any[]).sort((a: any, b: any) =>
                    new Date(a.debut).getTime() - new Date(b.debut).getTime()
                );
                for (const apt of sorted.slice(0, 5)) {
                    const start = new Date(apt.debut);
                    const heure = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
                    const client = apt.clients?.[0];
                    const clientName = client
                        ? `${client.prenom || ""} ${client.nom || ""}`.trim() || client.raisonSociale || ""
                        : "";
                    const label = clientName || apt.objet || "RDV";
                    rdvDetails.push(`${heure} ${label}`);
                }
                if (sorted.length > 5) {
                    rdvDetails.push(`+ ${sorted.length - 5} autre(s)`);
                }
            }
        }

        // 2. Fetch today's tasks
        const todayStart = `${todayStr}T00:00:00+00:00`;
        const todayEnd = `${todayStr}T23:59:59+00:00`;

        const { data: todayTasks } = await db
            .from("tasks")
            .select("title, priority, due_date")
            .neq("status", "done")
            .lte("due_date", todayEnd)
            .gte("due_date", todayStart);

        const { data: overdueTasks } = await db
            .from("tasks")
            .select("title, priority, due_date")
            .neq("status", "done")
            .lt("due_date", todayStart)
            .not("due_date", "is", null);

        const taskCount = (todayTasks?.length || 0);
        const overdueCount = (overdueTasks?.length || 0);
        const totalTaskCount = taskCount + overdueCount;

        console.log(`Found ${rdvCount} RDV, ${taskCount} tasks today, ${overdueCount} overdue`);

        // 3. Build notification body
        const lines: string[] = [];
        if (rdvCount > 0) {
            lines.push(`📅 ${rdvCount} RDV`);
            for (const d of rdvDetails) {
                lines.push(`  · ${d}`);
            }
        } else {
            lines.push("📅 Aucun RDV");
        }

        if (totalTaskCount > 0) {
            lines.push(`✅ ${totalTaskCount} tâche(s)`);
            if (overdueCount > 0) {
                lines.push(`  🔥 ${overdueCount} en retard`);
            }
        }

        const body = lines.join("\n");
        const title = `☀️ ${dayName.charAt(0).toUpperCase() + dayName.slice(1)} — ${rdvCount} RDV, ${totalTaskCount} tâche(s)`;

        // 4. Get subscriptions
        const { data: subscriptions, error: subError } = await db
            .from("agent_push_subscriptions")
            .select("id, endpoint, p256dh, auth");

        if (subError) throw new Error(`Failed to fetch subscriptions: ${subError.message}`);
        if (!subscriptions || subscriptions.length === 0) {
            console.log("No push subscriptions");
            return new Response(JSON.stringify({
                success: true,
                message: "No subscriptions",
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // 5. Send push
        const payload = JSON.stringify({
            title,
            body,
            tag: "morning-summary",
            url: "/?action=myday",
        });

        const expiredIds: string[] = [];
        let sent = 0;

        for (const sub of subscriptions) {
            try {
                await webpush.sendNotification({
                    endpoint: sub.endpoint,
                    keys: { p256dh: sub.p256dh, auth: sub.auth },
                }, payload);
                sent++;
                console.log(`✅ Push sent to ${sub.endpoint.substring(0, 50)}...`);
            } catch (err: any) {
                console.error(`❌ Push failed:`, err.statusCode, err.body);
                if (err.statusCode === 404 || err.statusCode === 410) {
                    expiredIds.push(sub.id);
                }
            }
        }

        if (expiredIds.length > 0) {
            await db.from("agent_push_subscriptions").delete().in("id", expiredIds);
        }

        return new Response(JSON.stringify({
            success: true,
            rdvCount,
            taskCount: totalTaskCount,
            notificationsSent: sent,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error) {
        console.error("Morning summary error:", error);
        return new Response(JSON.stringify({
            success: false,
            error: error.message,
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
