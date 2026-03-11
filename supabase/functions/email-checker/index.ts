import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

/**
 * Email Checker v2
 * Uses raw Deno TLS sockets to connect via IMAP.
 * Called by pg_cron every 30 minutes.
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

// ============================================================
// IMAP Client using Deno.connectTls (raw TLS socket)
// ============================================================
class SimpleIMAP {
    private conn: Deno.TlsConn | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private buffer = "";
    private tag = 0;
    private encoder = new TextEncoder();
    private decoder = new TextDecoder();

    async connect(host: string, port: number) {
        this.conn = await Deno.connectTls({ hostname: host, port });
        this.reader = this.conn.readable.getReader();
        // Read server greeting
        await this.readUntilTagged("*");
    }

    private nextTag(): string {
        this.tag++;
        return `A${String(this.tag).padStart(4, '0')}`;
    }

    private async write(data: string) {
        if (!this.conn) throw new Error("Not connected");
        const writer = this.conn.writable.getWriter();
        await writer.write(this.encoder.encode(data + "\r\n"));
        writer.releaseLock();
    }

    private async readMore(): Promise<string> {
        if (!this.reader) throw new Error("No reader");
        const { value, done } = await this.reader.read();
        if (done || !value) return "";
        return this.decoder.decode(value);
    }

    private async readUntilTagged(expectedTag: string): Promise<string> {
        let result = "";
        const timeout = setTimeout(() => { }, 30000);

        while (true) {
            // Check buffer first
            if (this.buffer.length > 0) {
                result += this.buffer;
                this.buffer = "";
            }

            // Check if we have the tagged response
            const lines = result.split("\r\n");
            for (const line of lines) {
                if (line.startsWith(expectedTag + " ") || (expectedTag === "*" && line.startsWith("* OK"))) {
                    clearTimeout(timeout);
                    return result;
                }
            }

            // Read more data
            const data = await this.readMore();
            if (!data) break;
            result += data;
        }

        clearTimeout(timeout);
        return result;
    }

    async command(cmd: string): Promise<string> {
        const tag = this.nextTag();
        await this.write(`${tag} ${cmd}`);
        return await this.readUntilTagged(tag);
    }

    async login(user: string, pass: string): Promise<boolean> {
        const result = await this.command(`LOGIN "${user}" "${pass}"`);
        return result.includes("OK");
    }

    async selectInbox(): Promise<number> {
        const result = await this.command("SELECT INBOX");
        const existsMatch = result.match(/\* (\d+) EXISTS/);
        return existsMatch ? parseInt(existsMatch[1]) : 0;
    }

    async searchUnseen(): Promise<number[]> {
        const result = await this.command("SEARCH UNSEEN");
        const searchLine = result.split("\r\n").find(l => l.startsWith("* SEARCH"));
        if (!searchLine) return [];
        const nums = searchLine.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean).map(Number);
        return nums.filter(n => !isNaN(n));
    }

    async fetchHeaders(seqNums: number[]): Promise<any[]> {
        const emails: any[] = [];
        if (seqNums.length === 0) return emails;

        // Fetch in batches, limited to latest 20
        const toFetch = seqNums.slice(-20);
        const seqSet = toFetch.join(",");

        const result = await this.command(
            `FETCH ${seqSet} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] BODY.PEEK[TEXT]<0.4000>)`
        );

        // Parse the FETCH responses
        const fetchBlocks = result.split(/\* \d+ FETCH/);

        for (const block of fetchBlocks) {
            if (!block.trim()) continue;

            // Extract UID
            const uidMatch = block.match(/UID\s+(\d+)/);
            const uid = uidMatch ? parseInt(uidMatch[1]) : 0;

            // Extract headers
            const headerSection = block;
            const fromMatch = headerSection.match(/From:\s*(.+?)(?:\r\n(?!\s)|\r\n\))/i);
            const subjectMatch = headerSection.match(/Subject:\s*(.+?)(?:\r\n(?!\s)|\r\n\))/i);
            const dateMatch = headerSection.match(/Date:\s*(.+?)(?:\r\n(?!\s)|\r\n\))/i);
            const messageIdMatch = headerSection.match(/Message-ID:\s*(.+?)(?:\r\n(?!\s)|\r\n\))/i);

            let fromRaw = fromMatch ? fromMatch[1].trim() : "unknown";
            const subject = subjectMatch ? decodeHeader(subjectMatch[1].trim()) : "(sans objet)";
            const dateStr = dateMatch ? dateMatch[1].trim() : "";
            const messageId = messageIdMatch ? messageIdMatch[1].trim() : `uid-${uid}`;

            // Parse From field
            let fromName = "";
            let fromEmail = "unknown";
            const emailInAngle = fromRaw.match(/<([^>]+)>/);
            if (emailInAngle) {
                fromEmail = emailInAngle[1];
                fromName = decodeHeader(fromRaw.replace(/<[^>]+>/, "").replace(/"/g, "").trim());
            } else if (fromRaw.includes("@")) {
                fromEmail = fromRaw.trim();
                fromName = fromEmail;
            }
            if (!fromName) fromName = fromEmail;

            // Extract body text (rough)
            let bodyText = "";
            const bodyPeekMatch = block.match(/BODY\[TEXT\]<0>/i);
            if (bodyPeekMatch) {
                const afterBody = block.substring(block.indexOf("BODY[TEXT]"));
                const bodyContent = afterBody.replace(/^BODY\[TEXT\][^{]*\{(\d+)\}\r\n/i, "");
                bodyText = bodyContent.substring(0, 3000)
                    .replace(/<[^>]*>/g, ' ')
                    .replace(/&[a-z]+;/gi, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            }

            if (uid > 0 || fromEmail !== "unknown") {
                emails.push({
                    uid,
                    messageId,
                    fromEmail,
                    fromName,
                    subject,
                    bodyText: bodyText.substring(0, 3000),
                    date: dateStr ? new Date(dateStr) : new Date(),
                });
            }
        }

        return emails;
    }

    async addFlag(seqNums: number[], flag: string) {
        if (seqNums.length === 0) return;
        const seqSet = seqNums.join(",");
        await this.command(`STORE ${seqSet} +FLAGS (${flag})`);
    }

    async logout() {
        try {
            await this.command("LOGOUT");
        } catch { }
        try {
            this.reader?.cancel();
            this.conn?.close();
        } catch { }
    }
}

// Decode MIME encoded headers (=?UTF-8?B?...?= or =?UTF-8?Q?...?=)
function decodeHeader(str: string): string {
    if (!str) return str;
    return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_match, _charset, encoding, data) => {
        try {
            if (encoding.toUpperCase() === 'B') {
                return atob(data);
            } else if (encoding.toUpperCase() === 'Q') {
                return data.replace(/=([0-9A-Fa-f]{2})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/_/g, ' ');
            }
        } catch { }
        return data;
    });
}

// ============================================================
// Gemini AI Analysis
// ============================================================
async function analyzeEmailWithGemini(subject: string, body: string, fromName: string, fromEmail: string): Promise<{
    isNewsletter: boolean;
    isImportant: boolean;
    needsReply: boolean;
    summary: string;
    draftReply: string | null;
}> {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
        return basicAnalysis(subject, body, fromEmail);
    }

    const prompt = `Tu es l'assistant email de Quentin Bruneau, gérant de Bruneau Protection (sécurité : alarmes, vidéosurveillance, contrôle d'accès).

Analyse cet email et réponds en JSON strict (pas de markdown) :

De : ${fromName} <${fromEmail}>
Objet : ${subject}
Contenu : ${body.substring(0, 2000)}

Format JSON exact :
{"isNewsletter":false,"isImportant":true,"needsReply":true,"summary":"résumé concis","draftReply":"brouillon ou null"}

Règles :
- isNewsletter = true pour newsletters, promos, mailings, notifs automatiques
- isImportant = true pour emails clients, fournisseurs, urgences SAV, devis, emails personnels importants
- needsReply = true si une réponse est attendue (question, demande de rappel, devis, réclamation)
- Pour le brouillon : vouvoiement clients, signature "Cordialement, Quentin Bruneau - Bruneau Protection"
- Pas de brouillon pour newsletters`;

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

        if (!response.ok) return basicAnalysis(subject, body, fromEmail);

        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                isNewsletter: !!parsed.isNewsletter,
                isImportant: !!parsed.isImportant,
                needsReply: !!parsed.needsReply,
                summary: parsed.summary || subject || "Pas de résumé",
                draftReply: parsed.draftReply || null,
            };
        }
    } catch (err) {
        console.error("Gemini error:", err);
    }
    return basicAnalysis(subject, body, fromEmail);
}

function basicAnalysis(subject: string, body: string, fromEmail: string) {
    const sl = (subject || "").toLowerCase();
    const bl = (body || "").toLowerCase();
    const fe = fromEmail.toLowerCase();

    const nlWords = ["unsubscribe", "désabonnement", "newsletter", "noreply", "no-reply", "marketing", "promotions", "notification@", "mailing"];
    const isNL = nlWords.some(kw => fe.includes(kw) || sl.includes(kw) || bl.includes(kw));

    const impWords = ["urgent", "devis", "alarme", "panne", "intervention", "contrat", "facture", "réclamation"];
    const isImp = !isNL && impWords.some(kw => sl.includes(kw) || bl.includes(kw));

    return {
        isNewsletter: isNL,
        isImportant: isImp || !isNL,
        needsReply: isImp,
        summary: subject || "Email sans objet",
        draftReply: null,
    };
}

// ============================================================
// Push Notification
// ============================================================
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

// ============================================================
// Main Handler
// ============================================================
Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const db = getDB();

        const { data: accounts, error: accErr } = await db
            .from("email_accounts").select("*").eq("enabled", true);
        if (accErr) throw new Error(`Accounts error: ${accErr.message}`);
        if (!accounts?.length) {
            return new Response(JSON.stringify({ success: true, message: "No accounts" }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // Load known senders
        const { data: knownSenders } = await db.from("email_senders")
            .select("sender_email, classification, is_newsletter");
        const senderMap = new Map<string, any>();
        for (const s of (knownSenders || [])) senderMap.set(s.sender_email.toLowerCase(), s);

        let totalProcessed = 0, totalImportant = 0, totalNewsletters = 0, totalBlocked = 0;

        for (const account of accounts) {
            console.log(`\n=== Processing ${account.email} ===`);

            const imap = new SimpleIMAP();
            let emails: any[] = [];

            try {
                await imap.connect(account.imap_server, account.imap_port);
                console.log(`[IMAP] Connected to ${account.email}`);

                const loggedIn = await imap.login(account.email, account.password);
                if (!loggedIn) {
                    console.error(`[IMAP] Login failed for ${account.email}`);
                    await imap.logout();
                    continue;
                }
                console.log(`[IMAP] Logged in to ${account.email}`);

                const totalMessages = await imap.selectInbox();
                console.log(`[IMAP] INBOX has ${totalMessages} messages`);

                const unseenSeqs = await imap.searchUnseen();
                console.log(`[IMAP] Found ${unseenSeqs.length} unseen email(s)`);

                if (unseenSeqs.length > 0) {
                    emails = await imap.fetchHeaders(unseenSeqs);
                    console.log(`[IMAP] Fetched ${emails.length} email headers`);
                }

                // Track sequence numbers to mark as read for blocked senders
                const seqsToMarkRead: number[] = [];

                for (let i = 0; i < emails.length; i++) {
                    const email = emails[i];
                    const seqNum = unseenSeqs[i] || 0;

                    // Check if already processed
                    const { data: existing } = await db.from("email_messages")
                        .select("id").eq("account_email", account.email)
                        .eq("message_uid", email.uid || seqNum).maybeSingle();

                    if (existing) {
                        const sender = senderMap.get(email.fromEmail.toLowerCase());
                        if (sender?.classification === 'blocked') seqsToMarkRead.push(seqNum);
                        continue;
                    }

                    const senderKey = email.fromEmail.toLowerCase();
                    const knownSender = senderMap.get(senderKey);

                    // Blocked sender → mark read immediately
                    if (knownSender?.classification === 'blocked') {
                        seqsToMarkRead.push(seqNum);
                        totalBlocked++;
                        await db.from("email_messages").upsert({
                            account_email: account.email, message_uid: email.uid || seqNum,
                            message_id: email.messageId, from_email: email.fromEmail,
                            from_name: email.fromName, subject: email.subject,
                            body_preview: (email.bodyText || "").substring(0, 500),
                            received_at: email.date, is_newsletter: true, is_important: false,
                            needs_reply: false, ai_summary: "Newsletter bloquée", notification_sent: true,
                        }, { onConflict: 'account_email,message_uid' });
                        continue;
                    }

                    // Analyze with Gemini
                    const analysis = await analyzeEmailWithGemini(
                        email.subject, email.bodyText || "", email.fromName, email.fromEmail
                    );
                    console.log(`[AI] "${email.subject}" → newsletter:${analysis.isNewsletter} important:${analysis.isImportant} reply:${analysis.needsReply}`);

                    // Save to DB
                    await db.from("email_messages").upsert({
                        account_email: account.email, message_uid: email.uid || seqNum,
                        message_id: email.messageId, from_email: email.fromEmail,
                        from_name: email.fromName, subject: email.subject,
                        body_preview: (email.bodyText || "").substring(0, 500),
                        received_at: email.date, is_newsletter: analysis.isNewsletter,
                        is_important: analysis.isImportant, needs_reply: analysis.needsReply,
                        ai_summary: analysis.summary, draft_reply: analysis.draftReply,
                        notification_sent: false,
                    }, { onConflict: 'account_email,message_uid' });

                    // Register new sender
                    if (!knownSender) {
                        await db.from("email_senders").upsert({
                            sender_email: email.fromEmail, sender_name: email.fromName,
                            classification: analysis.isNewsletter ? 'pending' : 'allowed',
                            is_newsletter: analysis.isNewsletter,
                        }, { onConflict: 'sender_email' });
                        senderMap.set(senderKey, {
                            sender_email: email.fromEmail,
                            classification: analysis.isNewsletter ? 'pending' : 'allowed',
                            is_newsletter: analysis.isNewsletter,
                        });
                    }

                    // Notifications
                    if (analysis.isNewsletter) {
                        totalNewsletters++;
                        if (!knownSender || knownSender?.classification === 'pending') {
                            await sendPush(db, `📰 Newsletter de ${email.fromName}`,
                                `"${email.subject}" — Ouvrez l'app pour garder ou bloquer`,
                                `newsletter-${email.uid}`, "/?action=emails");
                            await db.from("email_messages").update({ notification_sent: true })
                                .eq("account_email", account.email).eq("message_uid", email.uid || seqNum);
                        }
                    } else if (analysis.isImportant || analysis.needsReply) {
                        totalImportant++;
                        const emoji = analysis.needsReply ? "📧" : "📬";
                        const note = analysis.needsReply ? "\nBrouillon de réponse préparé" : "";
                        await sendPush(db, `${emoji} ${email.subject}`,
                            `De: ${email.fromName} (${account.email})\n${analysis.summary}${note}`,
                            `email-${email.uid}`, "/?action=emails");
                        await db.from("email_messages").update({ notification_sent: true })
                            .eq("account_email", account.email).eq("message_uid", email.uid || seqNum);
                    }

                    totalProcessed++;
                    await new Promise(r => setTimeout(r, 300));
                }

                // Mark blocked as read via IMAP
                if (seqsToMarkRead.length > 0) {
                    await imap.addFlag(seqsToMarkRead, "\\Seen");
                    console.log(`[IMAP] Marked ${seqsToMarkRead.length} as read`);
                }

                await imap.logout();
            } catch (imapErr: any) {
                console.error(`[IMAP] Error for ${account.email}:`, imapErr.message || imapErr);
                try { await imap.logout(); } catch { }
            }

            await db.from("email_accounts").update({ last_checked_at: new Date().toISOString() })
                .eq("id", account.id);
        }

        const summary = { success: true, totalProcessed, totalImportant, totalNewsletters, totalBlocked };
        console.log("\n=== Done ===", JSON.stringify(summary));

        return new Response(JSON.stringify(summary),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error: any) {
        console.error("Email checker error:", error.message || error);
        return new Response(JSON.stringify({ success: false, error: error.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
});
