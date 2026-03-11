import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

/**
 * Email Reply Reminder
 * Checks for emails awaiting reply and sends reminder notifications.
 * Called by pg_cron every 4 hours.
 */

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function getDB() {
    return createClient(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    );
}

async function sendPush(db: any, title: string, body: string, tag: string, url = "/") {
    const vapidPub = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const vapidPriv = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    if (!vapidPub || !vapidPriv) return;

    webpush.setVapidDetails("mailto:quentin@bruneau27.com", vapidPub, vapidPriv);

    const { data: subs } = await db.from("agent_push_subscriptions").select("id, endpoint, p256dh, auth");
    if (!subs?.length) return;

    const payload = JSON.stringify({ title, body, tag, url });
    const expired: string[] = [];

    for (const sub of subs) {
        try {
            await webpush.sendNotification({
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth },
            }, payload);
        } catch (err: any) {
            if (err.statusCode === 404 || err.statusCode === 410) expired.push(sub.id);
        }
    }
    if (expired.length) await db.from("agent_push_subscriptions").delete().in("id", expired);
}

function formatDaysAgo(receivedAt: string): string {
    const diff = Date.now() - new Date(receivedAt).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "aujourd'hui";
    if (days === 1) return "hier";
    return `il y a ${days} jours`;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const db = getDB();

        // Find emails that need reply but haven't been replied to
        const { data: pendingReplies, error } = await db
            .from("email_messages")
            .select("id, from_name, from_email, subject, ai_summary, received_at, account_email, reply_reminder_count, last_reminder_at")
            .eq("needs_reply", true)
            .is("replied_at", null)
            .order("received_at", { ascending: true });

        if (error) throw new Error(`Query error: ${error.message}`);
        if (!pendingReplies?.length) {
            return new Response(JSON.stringify({ success: true, reminders: 0 }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        console.log(`Found ${pendingReplies.length} emails awaiting reply`);

        const now = Date.now();
        let remindersSent = 0;

        for (const email of pendingReplies) {
            const receivedMs = new Date(email.received_at).getTime();
            const daysSinceEmail = Math.floor((now - receivedMs) / (1000 * 60 * 60 * 24));

            // Only remind for emails older than 1 day
            if (daysSinceEmail < 1) continue;

            // Check if we already sent a reminder recently (min 24h between reminders)
            if (email.last_reminder_at) {
                const lastReminderMs = new Date(email.last_reminder_at).getTime();
                const hoursSinceReminder = (now - lastReminderMs) / (1000 * 60 * 60);
                if (hoursSinceReminder < 24) continue;
            }

            // Determine urgency
            let emoji = "📨";
            let urgency = "";
            if (daysSinceEmail >= 7) {
                emoji = "🔴";
                urgency = " — URGENT";
            } else if (daysSinceEmail >= 3) {
                emoji = "🟡";
                urgency = " — À traiter";
            }

            const daysText = formatDaysAgo(email.received_at);
            const fromDisplay = email.from_name || email.from_email;

            await sendPush(
                db,
                `${emoji} Réponse en attente${urgency}`,
                `${fromDisplay} attend votre réponse depuis ${daysText}\n📧 "${email.subject}"\n📝 ${email.ai_summary || ""}`,
                `reply-reminder-${email.id}`,
                "/?action=emails"
            );

            // Update reminder tracking
            await db.from("email_messages").update({
                reply_reminder_sent: true,
                reply_reminder_count: (email.reply_reminder_count || 0) + 1,
                last_reminder_at: new Date().toISOString(),
            }).eq("id", email.id);

            remindersSent++;
            console.log(`[Reminder] ${fromDisplay} — ${daysText} — "${email.subject}"`);
        }

        const summary = { success: true, pendingReplies: pendingReplies.length, remindersSent };
        console.log("Reply reminders done:", JSON.stringify(summary));

        return new Response(JSON.stringify(summary),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error: any) {
        console.error("Reply reminder error:", error.message);
        return new Response(JSON.stringify({ success: false, error: error.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
});
