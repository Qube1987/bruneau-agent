import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { ImapFlow } from "npm:imapflow@1.0.171";

/**
 * Email Checker
 * Called by pg_cron every 30 minutes.
 * Connects to IMAP accounts, fetches unread emails, analyzes them with Gemini,
 * sends push notifications for important emails, prepares draft replies,
 * and handles newsletter classification.
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

// --- Gemini API for email analysis ---
async function analyzeEmailWithGemini(subject: string, body: string, fromName: string, fromEmail: string): Promise<{
    isNewsletter: boolean;
    isImportant: boolean;
    needsReply: boolean;
    summary: string;
    draftReply: string | null;
}> {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
        console.error("GEMINI_API_KEY not configured, using basic heuristics");
        return basicAnalysis(subject, body, fromEmail);
    }

    const prompt = `Tu es l'assistant email de Quentin Bruneau, gérant de Bruneau Protection (entreprise de sécurité : alarmes, vidéosurveillance, contrôle d'accès).

Analyse cet email et réponds en JSON strict (pas de markdown, pas de backticks) :

De : ${fromName} <${fromEmail}>
Objet : ${subject}
Contenu : ${body.substring(0, 3000)}

Réponds EXACTEMENT avec ce format JSON :
{
    "isNewsletter": true/false,
    "isImportant": true/false,
    "needsReply": true/false,
    "summary": "résumé concis en 1-2 phrases",
    "draftReply": "brouillon de réponse si needsReply=true, sinon null"
}

Règles :
- isNewsletter = true si c'est une newsletter, promo, mailing commercial, notification automatique de service
- isImportant = true si c'est un email client, un fournisseur important, une urgence SAV, une demande de devis, un email personnel important
- needsReply = true si l'email attend clairement une réponse (question directe, demande de rappel, demande de devis, réclamation)
- Pour le brouillon de réponse : ton professionnel, vouvoiement pour les clients, signature "Cordialement, Quentin Bruneau - Bruneau Protection"
- Ne PAS inclure de brouillon pour les newsletters ou emails sans besoin de réponse`;

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
                }),
            }
        );

        if (!response.ok) {
            console.error("Gemini API error:", response.status);
            return basicAnalysis(subject, body, fromEmail);
        }

        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // Extract JSON from response (handle possible markdown wrapping)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                isNewsletter: !!parsed.isNewsletter,
                isImportant: !!parsed.isImportant,
                needsReply: !!parsed.needsReply,
                summary: parsed.summary || "Pas de résumé disponible",
                draftReply: parsed.draftReply || null,
            };
        }
    } catch (err) {
        console.error("Gemini analysis error:", err);
    }

    return basicAnalysis(subject, body, fromEmail);
}

// Basic heuristic fallback
function basicAnalysis(subject: string, body: string, fromEmail: string) {
    const subjectLower = (subject || "").toLowerCase();
    const bodyLower = (body || "").toLowerCase();

    const newsletterKeywords = ["unsubscribe", "désabonnement", "se désinscrire", "newsletter", "mailing", "no-reply", "noreply", "notification@", "marketing", "promotions"];
    const isNewsletter = newsletterKeywords.some(kw =>
        fromEmail.toLowerCase().includes(kw) || subjectLower.includes(kw) || bodyLower.includes(kw)
    );

    const importantKeywords = ["urgent", "devis", "alarme", "panne", "intervention", "contrat", "rendez-vous", "facture", "réclamation", "rappel"];
    const isImportant = !isNewsletter && importantKeywords.some(kw => subjectLower.includes(kw) || bodyLower.includes(kw));

    return {
        isNewsletter,
        isImportant: isImportant || !isNewsletter,
        needsReply: isImportant,
        summary: subject || "Email sans objet",
        draftReply: null,
    };
}

// --- Fetch emails via IMAP ---
async function fetchNewEmails(account: any): Promise<any[]> {
    const emails: any[] = [];

    const client = new ImapFlow({
        host: account.imap_server,
        port: account.imap_port,
        secure: account.imap_security === 'SSL',
        auth: {
            user: account.email,
            pass: account.password,
        },
        logger: false,
    });

    try {
        await client.connect();
        console.log(`[IMAP] Connected to ${account.email}`);

        const lock = await client.getMailboxLock('INBOX');
        try {
            // Search for unseen emails
            const searchResult = await client.search({ seen: false });

            if (!searchResult || searchResult.length === 0) {
                console.log(`[IMAP] No unread emails in ${account.email}`);
                return emails;
            }

            console.log(`[IMAP] Found ${searchResult.length} unread email(s) in ${account.email}`);

            // Fetch email details (limit to latest 20 to avoid overload)
            const uidsToFetch = searchResult.slice(-20);

            for await (const message of client.fetch(uidsToFetch, {
                uid: true,
                envelope: true,
                bodyStructure: true,
                source: { maxBytes: 50000 }, // Limit body size
            })) {
                const from = message.envelope?.from?.[0];
                const fromEmail = from ? `${from.mailbox}@${from.host}` : "unknown";
                const fromName = from?.name || fromEmail;
                const subject = message.envelope?.subject || "(sans objet)";
                const date = message.envelope?.date;

                // Try to extract body text
                let bodyText = "";
                if (message.source) {
                    const rawSource = message.source.toString();
                    // Simple body extraction - get text after headers
                    const bodyStart = rawSource.indexOf("\r\n\r\n");
                    if (bodyStart > -1) {
                        bodyText = rawSource.substring(bodyStart + 4, bodyStart + 5000);
                        // Strip HTML tags for basic text
                        bodyText = bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                    }
                }

                emails.push({
                    uid: message.uid,
                    messageId: message.envelope?.messageId || `${message.uid}`,
                    fromEmail,
                    fromName,
                    subject,
                    bodyText: bodyText.substring(0, 3000),
                    date: date || new Date(),
                });
            }
        } finally {
            lock.release();
        }

        await client.logout();
    } catch (err: any) {
        console.error(`[IMAP] Error for ${account.email}:`, err.message);
        try { await client.logout(); } catch { }
    }

    return emails;
}

// --- Mark email as read via IMAP ---
async function markAsRead(account: any, uids: number[]): Promise<void> {
    if (uids.length === 0) return;

    const client = new ImapFlow({
        host: account.imap_server,
        port: account.imap_port,
        secure: account.imap_security === 'SSL',
        auth: {
            user: account.email,
            pass: account.password,
        },
        logger: false,
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
            console.log(`[IMAP] Marked ${uids.length} email(s) as read in ${account.email}`);
        } finally {
            lock.release();
        }
        await client.logout();
    } catch (err: any) {
        console.error(`[IMAP] Error marking as read for ${account.email}:`, err.message);
        try { await client.logout(); } catch { }
    }
}

// --- Send push notification ---
async function sendPushNotification(db: any, title: string, body: string, tag: string, url: string = "/") {
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";

    if (!vapidPublicKey || !vapidPrivateKey) {
        console.log("[Push] VAPID keys not configured, skipping push");
        return;
    }

    webpush.setVapidDetails(
        "mailto:quentin@bruneau27.com",
        vapidPublicKey,
        vapidPrivateKey
    );

    const { data: subscriptions } = await db
        .from("agent_push_subscriptions")
        .select("id, endpoint, p256dh, auth");

    if (!subscriptions || subscriptions.length === 0) {
        console.log("[Push] No subscriptions found");
        return;
    }

    const payload = JSON.stringify({ title, body, tag, url });
    const expiredIds: string[] = [];

    for (const sub of subscriptions) {
        try {
            await webpush.sendNotification({
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth },
            }, payload);
            console.log(`[Push] ✅ Sent: ${title}`);
        } catch (err: any) {
            console.error(`[Push] ❌ Failed:`, err.statusCode);
            if (err.statusCode === 404 || err.statusCode === 410) {
                expiredIds.push(sub.id);
            }
        }
    }

    if (expiredIds.length > 0) {
        await db.from("agent_push_subscriptions").delete().in("id", expiredIds);
    }
}

// --- Main handler ---
Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const db = getDB();

        // Get all enabled email accounts
        const { data: accounts, error: accError } = await db
            .from("email_accounts")
            .select("*")
            .eq("enabled", true);

        if (accError) throw new Error(`Failed to fetch accounts: ${accError.message}`);
        if (!accounts || accounts.length === 0) {
            return new Response(JSON.stringify({
                success: true,
                message: "No email accounts configured",
            }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Get all classified senders
        const { data: knownSenders } = await db
            .from("email_senders")
            .select("sender_email, classification, is_newsletter");
        const senderMap = new Map<string, any>();
        for (const s of (knownSenders || [])) {
            senderMap.set(s.sender_email.toLowerCase(), s);
        }

        let totalProcessed = 0;
        let totalImportant = 0;
        let totalNewsletters = 0;
        let totalBlocked = 0;

        for (const account of accounts) {
            console.log(`\n=== Processing ${account.email} ===`);

            // Fetch unread emails
            const newEmails = await fetchNewEmails(account);
            console.log(`Fetched ${newEmails.length} unread emails from ${account.email}`);

            const uidsToMarkRead: number[] = [];

            for (const email of newEmails) {
                // Check if already processed
                const { data: existing } = await db
                    .from("email_messages")
                    .select("id")
                    .eq("account_email", account.email)
                    .eq("message_uid", email.uid)
                    .maybeSingle();

                if (existing) {
                    // Already processed, check if it's a blocked newsletter to re-mark as read
                    const sender = senderMap.get(email.fromEmail.toLowerCase());
                    if (sender?.classification === 'blocked') {
                        uidsToMarkRead.push(email.uid);
                    }
                    continue;
                }

                // Check sender classification
                const senderKey = email.fromEmail.toLowerCase();
                const knownSender = senderMap.get(senderKey);

                // If sender is blocked, mark as read and skip
                if (knownSender?.classification === 'blocked') {
                    console.log(`[Skip] Blocked sender: ${email.fromEmail}`);
                    uidsToMarkRead.push(email.uid);
                    totalBlocked++;

                    // Still record the message
                    await db.from("email_messages").upsert({
                        account_email: account.email,
                        message_uid: email.uid,
                        message_id: email.messageId,
                        from_email: email.fromEmail,
                        from_name: email.fromName,
                        subject: email.subject,
                        body_preview: email.bodyText.substring(0, 500),
                        received_at: email.date,
                        is_newsletter: true,
                        is_important: false,
                        needs_reply: false,
                        ai_summary: "Newsletter bloquée",
                        notification_sent: true,
                    }, { onConflict: 'account_email,message_uid' });

                    continue;
                }

                // Analyze with Gemini
                const analysis = await analyzeEmailWithGemini(
                    email.subject,
                    email.bodyText,
                    email.fromName,
                    email.fromEmail
                );

                console.log(`[Analysis] "${email.subject}" — newsletter:${analysis.isNewsletter}, important:${analysis.isImportant}, needsReply:${analysis.needsReply}`);

                // Save email to DB
                await db.from("email_messages").upsert({
                    account_email: account.email,
                    message_uid: email.uid,
                    message_id: email.messageId,
                    from_email: email.fromEmail,
                    from_name: email.fromName,
                    subject: email.subject,
                    body_preview: email.bodyText.substring(0, 500),
                    received_at: email.date,
                    is_newsletter: analysis.isNewsletter,
                    is_important: analysis.isImportant,
                    needs_reply: analysis.needsReply,
                    ai_summary: analysis.summary,
                    draft_reply: analysis.draftReply,
                    notification_sent: false,
                }, { onConflict: 'account_email,message_uid' });

                // Register sender if new
                if (!knownSender) {
                    await db.from("email_senders").upsert({
                        sender_email: email.fromEmail,
                        sender_name: email.fromName,
                        classification: analysis.isNewsletter ? 'pending' : 'allowed',
                        is_newsletter: analysis.isNewsletter,
                    }, { onConflict: 'sender_email' });

                    senderMap.set(senderKey, {
                        sender_email: email.fromEmail,
                        classification: analysis.isNewsletter ? 'pending' : 'allowed',
                        is_newsletter: analysis.isNewsletter,
                    });
                }

                // Handle based on analysis
                if (analysis.isNewsletter) {
                    totalNewsletters++;

                    if (knownSender?.classification === 'allowed') {
                        // Allowed newsletter — keep unread, no notification
                        console.log(`[Newsletter] Allowed: ${email.fromEmail}`);
                    } else if (!knownSender || knownSender?.classification === 'pending') {
                        // New/pending newsletter — send notification asking for classification
                        await sendPushNotification(
                            db,
                            `📰 Newsletter de ${email.fromName}`,
                            `"${email.subject}" — Ouvrez l'app pour garder ou bloquer cet expéditeur`,
                            `newsletter-${email.uid}`,
                            "/?action=emails"
                        );
                        await db.from("email_messages")
                            .update({ notification_sent: true })
                            .eq("account_email", account.email)
                            .eq("message_uid", email.uid);
                    }
                } else if (analysis.isImportant || analysis.needsReply) {
                    totalImportant++;

                    // Send push notification for important emails
                    const emoji = analysis.needsReply ? "📧" : "📬";
                    const replyNote = analysis.needsReply ? " — Brouillon de réponse préparé" : "";
                    await sendPushNotification(
                        db,
                        `${emoji} ${email.subject}`,
                        `De: ${email.fromName} (${account.email})\n${analysis.summary}${replyNote}`,
                        `email-${email.uid}`,
                        "/?action=emails"
                    );
                    await db.from("email_messages")
                        .update({ notification_sent: true })
                        .eq("account_email", account.email)
                        .eq("message_uid", email.uid);
                }

                totalProcessed++;

                // Small delay to avoid rate-limiting Gemini
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Mark blocked newsletters as read
            if (uidsToMarkRead.length > 0) {
                await markAsRead(account, uidsToMarkRead);
            }

            // Update last checked time
            await db.from("email_accounts")
                .update({ last_checked_at: new Date().toISOString() })
                .eq("id", account.id);
        }

        const summary = {
            success: true,
            totalProcessed,
            totalImportant,
            totalNewsletters,
            totalBlocked,
            checkedAt: new Date().toISOString(),
        };

        console.log("\n=== Email check complete ===", JSON.stringify(summary));

        return new Response(JSON.stringify(summary), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        console.error("Email checker error:", error);
        return new Response(JSON.stringify({
            success: false,
            error: error.message,
        }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
