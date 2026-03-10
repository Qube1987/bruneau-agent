import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

/**
 * Task Reminder
 * Called by pg_cron every minute.
 * Checks for tasks with reminder_at <= now() and reminder_sent = false,
 * then sends push notifications using the web-push library.
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
            .select("id, endpoint, p256dh, auth");

        if (subError) throw new Error(`Failed to fetch subscriptions: ${subError.message}`);
        if (!subscriptions || subscriptions.length === 0) {
            console.log("No push subscriptions found, marking reminders as sent anyway");
            for (const task of pendingTasks) {
                await db.from("tasks").update({ reminder_sent: true }).eq("id", task.id);
            }
            return new Response(JSON.stringify({
                success: true,
                message: "No push subscriptions, reminders marked as sent",
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        console.log(`Sending to ${subscriptions.length} subscription(s)`);

        const expiredIds: string[] = [];
        let totalSent = 0;

        for (const task of pendingTasks) {
            const priorityEmoji = task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟠' : '🔵';
            const payload = JSON.stringify({
                title: `🔔 Rappel : ${task.title}`,
                body: task.description
                    ? `${priorityEmoji} ${task.description}`.trim()
                    : task.due_date
                        ? `${priorityEmoji} Échéance : ${new Date(task.due_date).toLocaleDateString('fr-FR')}`.trim()
                        : `${priorityEmoji} Tâche à faire`.trim(),
                tag: `task-reminder-${task.id}`,
                url: "/",
            });

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
                    totalSent++;
                    console.log(`✅ Push sent for "${task.title}" to ${sub.endpoint.substring(0, 50)}...`);
                } catch (err: any) {
                    console.error(`❌ Push failed:`, err.statusCode, err.body);
                    if (err.statusCode === 404 || err.statusCode === 410) {
                        if (!expiredIds.includes(sub.id)) expiredIds.push(sub.id);
                    }
                }
            }

            // Mark reminder as sent
            await db.from("tasks").update({ reminder_sent: true }).eq("id", task.id);
            console.log(`Reminder processed for task: ${task.title}`);
        }

        // Clean up expired subscriptions
        if (expiredIds.length > 0) {
            await db.from("agent_push_subscriptions")
                .delete()
                .in("id", expiredIds);
            console.log(`Cleaned up ${expiredIds.length} expired subscription(s)`);
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
