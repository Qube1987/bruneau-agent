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

    async fetchEmails(seqNums: number[]): Promise<any[]> {
        const emails: any[] = [];
        if (seqNums.length === 0) return emails;

        // Fetch latest 20 max
        const toFetch = seqNums.slice(-20);

        // Fetch one by one for reliability
        for (const seq of toFetch) {
            try {
                const result = await this.command(
                    `FETCH ${seq} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE)] BODY.PEEK[1]<0.8000>)`
                );

                // Extract UID
                const uidMatch = result.match(/UID\s+(\d+)/);
                const uid = uidMatch ? parseInt(uidMatch[1]) : seq;

                // Extract headers - use a proper function to handle multi-line folded headers
                const fromRaw = extractHeader(result, "From") || "unknown";
                const subjectRaw = extractHeader(result, "Subject");
                const subject = subjectRaw ? decodeHeader(subjectRaw) : "(sans objet)";
                const dateStr = extractHeader(result, "Date") || "";
                const messageId = extractHeader(result, "Message-ID") || `uid-${uid}`;

                // Parse From field
                let fromName = "";
                let fromEmail = "unknown";
                const emailInAngle = fromRaw.match(/<([^>]+)>/);
                if (emailInAngle) {
                    fromEmail = emailInAngle[1];
                    fromName = decodeHeader(fromRaw.replace(/<[^>]+>/, "").replace(/\"/g, "").trim());
                } else if (fromRaw.includes("@")) {
                    fromEmail = fromRaw.trim();
                    fromName = fromEmail;
                }
                if (!fromName) fromName = fromEmail;

                // Extract body text from BODY[1] (text/plain part)
                let bodyText = "";
                // Find the literal {size} marker for BODY[1]
                const bodyLiteralMatch = result.match(/BODY\[1\](?:<\d+>)?\s*\{(\d+)\}/i);
                if (bodyLiteralMatch) {
                    const literalStart = result.indexOf(bodyLiteralMatch[0]) + bodyLiteralMatch[0].length;
                    // Skip the \r\n after {size}
                    const contentStart = result.indexOf("\r\n", literalStart) + 2;
                    const size = parseInt(bodyLiteralMatch[1]);
                    bodyText = result.substring(contentStart, contentStart + size);
                }

                // Detect encoding from the body content or headers
                const isQuotedPrintable = result.includes("quoted-printable");
                const isBase64 = result.includes("Content-Transfer-Encoding: base64") ||
                    result.includes("content-transfer-encoding: base64");

                // If body looks like multipart (contains boundaries), try to extract text/plain
                if (bodyText && bodyText.includes("Content-Type:")) {
                    // Find text/plain part within multipart body
                    const textPlainMatch = bodyText.match(/Content-Type:\s*text\/plain[^]*?(?:\r\n\r\n|\n\n)([\s\S]*?)(?:--[-_=a-zA-Z0-9]+|$)/i);
                    if (textPlainMatch && textPlainMatch[1]) {
                        bodyText = textPlainMatch[1].trim();
                    }
                }

                // Decode content
                if (isBase64 && bodyText) {
                    bodyText = decodeBase64(bodyText.replace(/\s+/g, ''));
                } else if (isQuotedPrintable && bodyText) {
                    bodyText = decodeQuotedPrintable(bodyText);
                }

                // Clean up: strip MIME artifacts, HTML, URLs
                bodyText = bodyText
                    .replace(/--[-_=a-zA-Z0-9]{20,}\s*/g, '')  // Strip MIME boundaries
                    .replace(/Content-[A-Za-z-]+:\s*[^\r\n]+[\r\n]*/gi, '')  // Strip Content-* headers
                    .replace(/=\r?\n/g, '')  // QP soft line breaks (in case missed)
                    .replace(/=[0-9A-Fa-f]{2}/g, (m) => {  // Decode remaining QP
                        try { return String.fromCharCode(parseInt(m.slice(1), 16)); } catch { return m; }
                    })
                    .replace(/<[^>]*>/g, ' ')      // Strip HTML tags
                    .replace(/&[a-z]+;/gi, ' ')     // Strip HTML entities
                    .replace(/https?:\/\/\S+/g, '')  // Strip URLs
                    .replace(/\s+/g, ' ')            // Normalize whitespace
                    .trim();

                if (uid > 0 || fromEmail !== "unknown") {
                    emails.push({
                        uid,
                        seqNum: seq,
                        messageId,
                        fromEmail,
                        fromName,
                        subject,
                        bodyText: bodyText.substring(0, 3000),
                        date: dateStr ? new Date(dateStr) : new Date(),
                    });
                }
            } catch (fetchErr: any) {
                console.error(`[IMAP] Error fetching seq ${seq}:`, fetchErr.message);
            }
        }

        return emails;
    }

    async addFlag(seqNums: number[], flag: string) {
        if (seqNums.length === 0) return;
        const seqSet = seqNums.join(",");
        await this.command(`STORE ${seqSet} +FLAGS (${flag})`);
    }

    async markReadByUID(uids: number[]) {
        if (uids.length === 0) return;
        const uidSet = uids.join(",");
        console.log(`[IMAP] Marking UIDs as read: ${uidSet}`);
        await this.command(`UID STORE ${uidSet} +FLAGS (\\Seen)`);
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

// Extract a header value, handling RFC 2822 folding (continuation lines starting with space/tab)
function extractHeader(raw: string, headerName: string): string | null {
    // Match the header name followed by its value, including folded continuation lines
    const regex = new RegExp(`${headerName}:\\s*(.+(?:\\r\\n[ \\t]+.+)*)`, "i");
    const match = raw.match(regex);
    if (!match) return null;
    // Unfold: replace \r\n followed by whitespace with a single space
    return match[1].replace(/\r\n[ \t]+/g, " ").trim();
}

// Decode MIME encoded headers (=?UTF-8?B?...?= or =?UTF-8?Q?...?=)
function decodeHeader(str: string): string {
    if (!str) return str;
    return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_match, charset, encoding, data) => {
        try {
            if (encoding.toUpperCase() === 'B') {
                const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
                return new TextDecoder(charset || 'utf-8').decode(bytes);
            } else if (encoding.toUpperCase() === 'Q') {
                const decoded = data
                    .replace(/_/g, ' ')
                    .replace(/=([0-9A-Fa-f]{2})/g, (_: string, hex: string) =>
                        String.fromCharCode(parseInt(hex, 16)));
                const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
                return new TextDecoder(charset || 'utf-8').decode(bytes);
            }
        } catch { }
        return data;
    });
}

// Decode quoted-printable content
function decodeQuotedPrintable(str: string): string {
    return str
        .replace(/=\r?\n/g, '')  // Soft line breaks
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => {
            const byte = parseInt(hex, 16);
            return String.fromCharCode(byte);
        });
}

// Decode base64 content
function decodeBase64(str: string): string {
    try {
        const clean = str.replace(/[\r\n\s]/g, '');
        const bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return str;
    }
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

    const prompt = `Tu es l'assistant email de Quentin Bruneau, gérant de Bruneau Protection (sécurité/alarmes/vidéosurveillance en Normandie).

ANALYSE cet email. Réponds UNIQUEMENT en JSON, sans aucun markdown ni texte autour.

Expéditeur : ${fromName} <${fromEmail}>
Objet : ${subject}
Contenu (peut être vide ou partiel) : ${body.substring(0, 2500)}

FORMAT EXACT :
{"isNewsletter":bool,"isImportant":bool,"needsReply":bool,"summary":"résumé 1-2 phrases en français","draftReply":"brouillon ou null"}

CLASSIFICATION — Indices de NEWSLETTER (isNewsletter=true) :
- Adresse contenant : noreply, no-reply, newsletter, info@, webmaster@, notif, contact@...service
- Sujets contenant : "nouveautés", "découvrez", "offre", "promo", "actualités", "security alert"
- Emails de services SaaS (Supabase, GitHub, Google, etc.)
- Messagerie vocale orange, notifications automatiques
- Tout ce qui est envoyé en masse sans attendre de réponse personnelle
- Fournisseurs envoyant des catalogues/promos (ex: Francofa Eurodis, Les Echos)

CLASSIFICATION — Emails IMPORTANTS (isNewsletter=false, isImportant=true) :
- Clients particuliers (orange.fr, yahoo.fr, gmail.com) qui écrivent personnellement
- Fournisseurs avec sujet spécifique (facture, commande, devis)
- Comptable (fiteco), gestionnaire immobilier, mairie
- Collègues/employés (Hugo, etc.)
- Demandes de devis, questions sur alarmes

needsReply=true UNIQUEMENT si l'expéditeur attend clairement une réponse (question directe, demande de devis, demande de rappel).

summary : résumé utile en français. Si contenu vide, résume à partir du sujet ET de l'expéditeur.
draftReply : brouillon SEULEMENT si needsReply=true. Vouvoiement. Signature "Cordialement, Quentin Bruneau - Bruneau Protection". null sinon.`;

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
                }),
            }
        );

        if (!response.ok) {
            console.error(`[AI] Gemini HTTP ${response.status}: ${await response.text()}`);
            return basicAnalysis(subject, body, fromEmail);
        }

        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
        console.log(`[AI] Gemini for "${subject}": ${text.substring(0, 200)}`);
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

    // Strong newsletter signals in email address
    const nlAddressPatterns = ["noreply", "no-reply", "newsletter", "notification@", "mailing", "webmaster@", "info-", "marketing", "promotions", "ne-pas-repondre", "nepas-repondre", "messagerievocale", "adhoc@info"];
    const nlSubjectPatterns = ["nouveautés", "nouveautes", "découvrez", "decouvrez", "offre spéciale", "promo", "security vulnerabilities", "unsubscribe", "désabonnement"];
    const nlBodyPatterns = ["unsubscribe", "désabonnement", "se désinscrire", "opt-out", "view in browser", "version en ligne"];

    const isNL = nlAddressPatterns.some(kw => fe.includes(kw))
        || nlSubjectPatterns.some(kw => sl.includes(kw))
        || nlBodyPatterns.some(kw => bl.includes(kw));

    const impWords = ["urgent", "devis", "alarme", "panne", "intervention", "contrat", "facture", "réclamation", "rappel"];
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

        // Check for reanalyze mode (re-classify existing emails with Gemini)
        let body: any = {};
        try { body = await req.json(); } catch { }
        if (body?.reanalyze) {
            return await reanalyzeEmails(db);
        }
        // Mark-read mode: mark specific emails as read on IMAP
        if (body?.markRead && body?.emailIds?.length) {
            return await markEmailsAsRead(db, body.emailIds);
        }
        // Mark-read by sender: mark all emails from a sender as read
        if (body?.markReadBySender && body?.senderEmail) {
            return await markSenderEmailsAsRead(db, body.senderEmail);
        }
        // Refetch mode: delete all emails and re-download from IMAP
        if (body?.refetch) {
            console.log("[Refetch] Deleting all existing emails to re-fetch...");
            await db.from("email_messages").delete().neq("id", "00000000-0000-0000-0000-000000000000");
            await db.from("email_senders").delete().neq("id", "00000000-0000-0000-0000-000000000000");
            console.log("[Refetch] DB cleared, will re-fetch all unseen emails...");
        }

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
                    emails = await imap.fetchEmails(unseenSeqs);
                    console.log(`[IMAP] Fetched ${emails.length} emails`);
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

// ============================================================
// Re-analyze existing emails with Gemini
// ============================================================
async function reanalyzeEmails(db: any) {
    const { data: emails, error } = await db
        .from("email_messages")
        .select("id, from_name, from_email, subject, body_preview")
        .order("received_at", { ascending: false })
        .limit(50);

    if (error) throw new Error(`Reanalyze query error: ${error.message}`);
    if (!emails?.length) {
        return new Response(JSON.stringify({ success: true, reanalyzed: 0 }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let reanalyzed = 0;
    for (const email of emails) {
        const analysis = await analyzeEmailWithGemini(
            email.subject, email.body_preview || "", email.from_name, email.from_email
        );

        await db.from("email_messages").update({
            is_newsletter: analysis.isNewsletter,
            is_important: analysis.isImportant,
            needs_reply: analysis.needsReply,
            ai_summary: analysis.summary,
            draft_reply: analysis.draftReply,
        }).eq("id", email.id);

        // Update sender classification too
        await db.from("email_senders").upsert({
            sender_email: email.from_email,
            sender_name: email.from_name,
            classification: analysis.isNewsletter ? 'pending' : 'allowed',
            is_newsletter: analysis.isNewsletter,
        }, { onConflict: 'sender_email' });

        reanalyzed++;
        console.log(`[Reanalyze] "${email.subject}" => NL:${analysis.isNewsletter} IMP:${analysis.isImportant} REPLY:${analysis.needsReply}`);
        await new Promise(r => setTimeout(r, 500));
    }

    return new Response(JSON.stringify({ success: true, reanalyzed }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Mark specific emails as read on IMAP server, given their DB ids
async function markEmailsAsRead(db: any, emailIds: string[]) {
    console.log(`[MarkRead] Marking ${emailIds.length} emails as read...`);

    // Get emails with their account and UID info
    const { data: emails, error } = await db
        .from("email_messages")
        .select("id, account_email, message_uid")
        .in("id", emailIds);

    if (error || !emails?.length) {
        return new Response(JSON.stringify({ success: false, error: error?.message || "No emails found" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Group by account
    const byAccount = new Map<string, number[]>();
    for (const e of emails) {
        const key = e.account_email;
        if (!byAccount.has(key)) byAccount.set(key, []);
        byAccount.get(key)!.push(e.message_uid);
    }

    // Get accounts
    const { data: accounts } = await db.from("email_accounts").select("*").eq("enabled", true);
    if (!accounts?.length) {
        return new Response(JSON.stringify({ success: false, error: "No accounts" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let totalMarked = 0;
    for (const [accountEmail, uids] of byAccount) {
        const account = accounts.find((a: any) => a.email === accountEmail);
        if (!account) {
            console.error(`[MarkRead] Account not found: ${accountEmail}`);
            continue;
        }

        const imap = new SimpleIMAP();
        try {
            await imap.connect(account.imap_server, account.imap_port);
            const loggedIn = await imap.login(account.email, account.password);
            if (!loggedIn) { console.error(`[MarkRead] Login failed: ${accountEmail}`); await imap.logout(); continue; }
            await imap.selectInbox();
            await imap.markReadByUID(uids);
            totalMarked += uids.length;
            console.log(`[MarkRead] Marked ${uids.length} emails as read in ${accountEmail}`);
            await imap.logout();
        } catch (err: any) {
            console.error(`[MarkRead] Error for ${accountEmail}:`, err.message);
            try { await imap.logout(); } catch { }
        }
    }

    return new Response(JSON.stringify({ success: true, totalMarked }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Mark all emails from a specific sender as read on IMAP
async function markSenderEmailsAsRead(db: any, senderEmail: string) {
    console.log(`[MarkRead] Marking all emails from ${senderEmail} as read...`);

    const { data: emails, error } = await db
        .from("email_messages")
        .select("id, account_email, message_uid")
        .eq("from_email", senderEmail)
        .eq("dismissed", false);

    if (error || !emails?.length) {
        return new Response(JSON.stringify({ success: true, totalMarked: 0 }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Reuse markEmailsAsRead logic
    const emailIds = emails.map((e: any) => e.id);
    return await markEmailsAsRead(db, emailIds);
}
