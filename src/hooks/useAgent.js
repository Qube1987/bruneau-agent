import { useState, useRef, useCallback } from 'react';
import { supabase, AGENT_FUNCTION_URL, SUPABASE_ANON } from '../lib/supabase';
import { isSameDay, formatTime, detectConflicts, findFreeSlots, formatSlotTime, generateBriefing } from '../utils/agendaUtils';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://rzxisqsdsiiuwaixnneo.supabase.co';
const PROXY_URL = `${SUPABASE_URL}/functions/v1/extrabat-proxy`;

/**
 * Parse a natural-language RDV request and create it directly via extrabat-proxy.
 * Returns { success, message } or null if the message is not an RDV request.
 */
async function tryDirectRdvCreation(text, token) {
    const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Only handle appointment creation requests
    const isCreate = /\b(ajoute|ajout|cree|planifie|programme|mets|pose|fixe|cale|bloque|reserve|prevois|note)\b/.test(lower);
    const isRdv = /\b(rdv|rendez|reunion|meeting|visite|creneau)\b/.test(lower);
    if (!isCreate || !isRdv) return null;

    // Extract time: "15h30", "15:30", "15 h 30", "15h"
    const timeMatch = text.match(/(\d{1,2})\s*[h:]\s*(\d{2})?/);
    if (!timeMatch) return null;
    const hour = timeMatch[1].padStart(2, '0');
    const min = (timeMatch[2] || '00').padStart(2, '0');

    // Extract date relative to NOW (French timezone)
    const now = new Date();
    // Convert to French time
    const fr = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    let targetDate = null;

    if (/\bdemain\b/.test(lower)) {
        targetDate = new Date(fr);
        targetDate.setDate(targetDate.getDate() + 1);
    } else if (/\baprès[- ]?demain\b/.test(lower) || /\bapres[- ]?demain\b/.test(lower)) {
        targetDate = new Date(fr);
        targetDate.setDate(targetDate.getDate() + 2);
    } else if (/\baujourd'?hui\b/.test(lower) || /\bce (matin|soir|midi)\b/.test(lower)) {
        targetDate = new Date(fr);
    } else {
        // Check for day names: "lundi", "mardi", etc.
        const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
        const dayIdx = days.findIndex(d => lower.includes(d));
        if (dayIdx >= 0) {
            targetDate = new Date(fr);
            let diff = dayIdx - fr.getDay();
            if (diff <= 0) diff += 7; // next week
            targetDate.setDate(targetDate.getDate() + diff);
        }
    }

    // Check for explicit date: "le 15 mars", "10/03", "2026-03-15"
    if (!targetDate) {
        const explicitDate = text.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (explicitDate) {
            targetDate = new Date(parseInt(explicitDate[1]), parseInt(explicitDate[2]) - 1, parseInt(explicitDate[3]));
        }
    }

    if (!targetDate) return null;

    const y = targetDate.getFullYear();
    const m = String(targetDate.getMonth() + 1).padStart(2, '0');
    const d = String(targetDate.getDate()).padStart(2, '0');
    const debut = `${y}-${m}-${d} ${hour}:${min}:00`;
    const endHour = String(Math.min(parseInt(hour) + 1, 23)).padStart(2, '0');
    const fin = `${y}-${m}-${d} ${endHour}:${min}:00`;

    // Extract client name: "avec le client X", "avec X", "chez X"
    let clientName = null;
    const clientMatch = text.match(/(?:avec\s+(?:le\s+client\s+)?|chez\s+)(.+?)$/i);
    if (clientMatch) clientName = clientMatch[1].trim();

    // Extract objet - use client name or everything after the time
    const objet = clientName || text.replace(/.*\d{1,2}\s*[h:]\s*\d{0,2}\s*/, '').trim() || 'RDV';

    console.log(`[DirectRDV] Creating: debut=${debut}, fin=${fin}, objet=${objet}, client=${clientName}`);

    // Search for client in Extrabat if client_name provided
    let clientId = null;
    if (clientName) {
        try {
            // 1) Search in Supabase first (has proper ILIKE fuzzy matching)
            const { data: sbClients } = await supabase
                .from('clients')
                .select('id, nom, prenom, extrabat_id')
                .or(`nom.ilike.%${clientName}%,prenom.ilike.%${clientName}%`)
                .limit(5);

            if (sbClients && sbClients.length > 0) {
                // Find best match - prefer exact name match
                const best = sbClients.find(c =>
                    (c.nom || '').toLowerCase().includes(clientName.toLowerCase()) ||
                    clientName.toLowerCase().includes((c.nom || '').toLowerCase())
                ) || sbClients[0];
                if (best.extrabat_id) {
                    clientId = best.extrabat_id;
                    console.log(`[DirectRDV] Found client in Supabase: ${best.nom} -> Extrabat ID ${clientId}`);
                }
            }

            // 2) Fallback: search in Extrabat with exact name filter
            if (!clientId) {
                const searchRes = await fetch(PROXY_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': token },
                    body: JSON.stringify({ endpoint: 'clients', apiVersion: 'v2', params: { nomraisonsociale: clientName } }),
                });
                const searchData = await searchRes.json();
                if (searchData.success && Array.isArray(searchData.data) && searchData.data.length > 0) {
                    // Only use if the name actually matches (not just first alphabetical result)
                    const match = searchData.data.find(c =>
                        (c.nomraisonsociale || '').toLowerCase().includes(clientName.toLowerCase()) ||
                        clientName.toLowerCase().includes((c.nomraisonsociale || '').toLowerCase())
                    );
                    if (match) {
                        clientId = match.id;
                        console.log(`[DirectRDV] Found client in Extrabat: ${match.nomraisonsociale} -> ID ${clientId}`);
                    }
                }
            }
        } catch (e) { console.warn('[DirectRDV] Client search failed:', e); }
    }

    // Create appointment via proxy
    const res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': token },
        body: JSON.stringify({
            technicianCodes: ['46516'], // Quentin
            interventionData: {
                clientName: clientName || objet,
                systemType: 'rdv',
                problemDesc: objet,
                startedAt: debut,
                endedAt: fin,
            },
            clientId: clientId,
        }),
    });
    const data = await res.json();

    if (data.success) {
        const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
        const dayName = days[targetDate.getDay()];
        return {
            success: true,
            message: `✅ Rendez-vous créé : "${objet}" ${dayName} ${d}/${m} de ${hour}:${min} à ${endHour}:${min}${clientName ? ` (client: ${clientName})` : ''}`,
        };
    } else {
        return { success: false, message: `❌ Erreur création RDV: ${data.error || 'Erreur inconnue'}` };
    }
}

/**
 * Parse a natural-language task/reminder request and create it directly via Supabase.
 * Handles:
 *   - Relative: "rappelle-moi dans 5 minutes d'appeler Cindy"
 *   - Relative: "rappelle-moi dans 1 heure"
 *   - Relative: "rappelle-moi dans une demi-heure"
 *   - Absolute: "rappelle-moi demain 8h d'appeler le client"
 *   - Absolute: "mets un rappel lundi 14h réunion"
 *   - Task: "ajoute une tâche appeler Dupont demain 9h"
 * Returns { success, message } or null if the message is not a task/reminder request.
 */
async function tryDirectTaskCreation(text) {
    const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Detect reminder / task creation intent (broad coverage for vocal transcription variants)
    const isReminder = /\b(rappel|rappelle|rappeler|alarme|alerte|notifie|previens|remind)\b/.test(lower)
        || /n'?oublie\s*pas/.test(lower)
        || /faut\s+que\s+je\s+pense/.test(lower)
        || /pense\s*a\s+(rappeler|appeler|faire|envoyer|commander|verifier)/.test(lower);
    const isTask = /\b(ajoute|ajout|cree|note|mets|pose)\b/.test(lower)
        && /\b(tache|task|todo|rappel)\b/.test(lower);

    if (!isReminder && !isTask) return null;

    const now = new Date();
    const fr = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));

    let reminderDate = null;  // The exact Date when the reminder should fire
    let dayLabel = '';
    let isRelative = false;   // "dans X minutes" mode vs absolute mode

    // ══════════════════════════════════════════════════════
    // 1) RELATIVE DURATION: "dans 5 minutes", "dans 1 heure", "dans une demi-heure"
    // ══════════════════════════════════════════════════════
    // "dans X min(utes)"
    const relMinMatch = lower.match(/dans\s+(\d+)\s*(?:min(?:utes?)?|mn)/);
    // "dans X heure(s)"
    const relHourMatch = lower.match(/dans\s+(\d+)\s*(?:h(?:eure)?s?)\b/);
    // "dans une heure"
    const relUneHeureMatch = /dans\s+une?\s+heure/.test(lower);
    // "dans une demi-heure" / "dans 30 min"
    const relDemiHeureMatch = /dans\s+une?\s+demi[- ]?heure/.test(lower);
    // "dans X heure(s) et Y min"
    const relHourMinMatch = lower.match(/dans\s+(\d+)\s*h(?:eures?)?\s+(?:et\s+)?(\d+)\s*(?:min(?:utes?)?|mn)/);

    if (relHourMinMatch) {
        const offsetMs = (parseInt(relHourMinMatch[1]) * 60 + parseInt(relHourMinMatch[2])) * 60 * 1000;
        reminderDate = new Date(now.getTime() + offsetMs);
        dayLabel = `dans ${relHourMinMatch[1]}h${relHourMinMatch[2]}`;
        isRelative = true;
    } else if (relDemiHeureMatch) {
        reminderDate = new Date(now.getTime() + 30 * 60 * 1000);
        dayLabel = 'dans 30 minutes';
        isRelative = true;
    } else if (relMinMatch) {
        const minutes = parseInt(relMinMatch[1]);
        reminderDate = new Date(now.getTime() + minutes * 60 * 1000);
        dayLabel = `dans ${minutes} minute${minutes > 1 ? 's' : ''}`;
        isRelative = true;
    } else if (relUneHeureMatch) {
        reminderDate = new Date(now.getTime() + 60 * 60 * 1000);
        dayLabel = 'dans 1 heure';
        isRelative = true;
    } else if (relHourMatch) {
        const hours = parseInt(relHourMatch[1]);
        reminderDate = new Date(now.getTime() + hours * 60 * 60 * 1000);
        dayLabel = `dans ${hours} heure${hours > 1 ? 's' : ''}`;
        isRelative = true;
    }

    // ══════════════════════════════════════════════════════
    // 2) ABSOLUTE DATE + TIME: "demain 8h", "lundi 14h30", etc.
    // ══════════════════════════════════════════════════════
    if (!isRelative) {
        // Extract time: "15h30", "15:30", "15 h 30", "15h", "8h"
        const timeMatch = text.match(/(\d{1,2})\s*[h:]\s*(\d{2})?/);
        let hour = null;
        let minute = '00';
        if (timeMatch) {
            hour = timeMatch[1].padStart(2, '0');
            minute = (timeMatch[2] || '00').padStart(2, '0');
        }

        // Extract date
        let targetDate = null;

        if (/\bdemain\b/.test(lower)) {
            targetDate = new Date(fr);
            targetDate.setDate(targetDate.getDate() + 1);
            dayLabel = 'demain';
        } else if (/\bapres[- ]?demain\b/.test(lower)) {
            targetDate = new Date(fr);
            targetDate.setDate(targetDate.getDate() + 2);
            dayLabel = 'après-demain';
        } else if (/\baujourd'?hui\b/.test(lower) || /\bce (matin|soir|midi)\b/.test(lower)) {
            targetDate = new Date(fr);
            dayLabel = "aujourd'hui";
        } else {
            const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
            const dayIdx = days.findIndex(d => lower.includes(d));
            if (dayIdx >= 0) {
                targetDate = new Date(fr);
                let diff = dayIdx - fr.getDay();
                if (diff <= 0) diff += 7;
                targetDate.setDate(targetDate.getDate() + diff);
                dayLabel = days[dayIdx];
            }
        }

        // Check explicit dates: "2026-03-15", "15/03"
        if (!targetDate) {
            const isoDate = text.match(/(\d{4})-(\d{2})-(\d{2})/);
            if (isoDate) {
                targetDate = new Date(parseInt(isoDate[1]), parseInt(isoDate[2]) - 1, parseInt(isoDate[3]));
                dayLabel = `${isoDate[3]}/${isoDate[2]}`;
            }
            const frDate = text.match(/(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?/);
            if (!targetDate && frDate) {
                const year = frDate[3] ? (frDate[3].length === 2 ? 2000 + parseInt(frDate[3]) : parseInt(frDate[3])) : fr.getFullYear();
                targetDate = new Date(year, parseInt(frDate[2]) - 1, parseInt(frDate[1]));
                dayLabel = `${frDate[1]}/${frDate[2]}`;
            }
        }

        // If we have neither a date nor a time, we can't create a reminder
        if (!targetDate && !hour) return null;

        // Defaults
        if (!targetDate) { targetDate = new Date(fr); dayLabel = "aujourd'hui"; }
        if (!hour) { hour = '09'; minute = '00'; }

        const y = targetDate.getFullYear();
        const m = String(targetDate.getMonth() + 1).padStart(2, '0');
        const d = String(targetDate.getDate()).padStart(2, '0');
        reminderDate = new Date(`${y}-${m}-${d}T${hour}:${minute}:00`);
        dayLabel = `${dayLabel} à ${hour}:${minute}`;
    }

    // ══════════════════════════════════════════════════════
    // 3) EXTRACT TITLE
    // ══════════════════════════════════════════════════════
    let title = text;
    // Remove trigger prefixes
    title = title.replace(/^(rappelle[- ]?moi|mets[- ]?(moi\s+)?un\s+rappel|ajoute\s+une?\s+t[aâ]che|cree\s+une?\s+t[aâ]che|note\s+une?\s+t[aâ]che|mets\s+une?\s+t[aâ]che)\s*/i, '');
    // Remove relative duration phrases
    title = title.replace(/\bdans\s+\d+\s*(?:min(?:utes?)?|mn|h(?:eures?)?s?)\b/gi, '');
    title = title.replace(/\bdans\s+une?\s+(?:demi[- ]?)?heure\b/gi, '');
    title = title.replace(/\bdans\s+\d+\s*h(?:eures?)?\s+(?:et\s+)?\d+\s*(?:min(?:utes?)?|mn)\b/gi, '');
    // Remove date strings
    title = title.replace(/\b(demain|aujourd'?hui|apr[eè]s[- ]?demain|ce (matin|soir|midi)|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/gi, '');
    // Remove time strings (8h, 14h30, etc.)
    title = title.replace(/\b\d{1,2}\s*[h:]\s*\d{0,2}\b/g, '');
    // Remove explicit dates
    title = title.replace(/\d{4}-\d{2}-\d{2}/g, '');
    title = title.replace(/\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?/g, '');
    // Remove filler words (keep meaningful ones)
    title = title.replace(/\b(a|à|de|d'|du|le|la|les|pour|que|qu'|un|une|vers|sur|dans)\b/gi, '');
    // Clean up
    title = title.replace(/^\s*[,:;.!?-]+\s*/, '').replace(/\s*[,:;.!?-]+\s*$/, '').replace(/\s{2,}/g, ' ').trim();

    if (!title || title.length < 2) title = 'Rappel';
    title = title.charAt(0).toUpperCase() + title.slice(1);

    // ══════════════════════════════════════════════════════
    // 4) CREATE TASK IN SUPABASE
    // ══════════════════════════════════════════════════════
    const dueDateISO = reminderDate.toISOString();
    const reminderAtISO = dueDateISO;

    try {
        const { data, error } = await supabase
            .from('tasks')
            .insert({
                title,
                description: '',
                priority: 'medium',
                category: 'general',
                due_date: dueDateISO,
                reminder_at: reminderAtISO,
                reminder_sent: false,
                status: 'pending',
            })
            .select()
            .single();

        if (error) {
            console.error('[DirectTask] Insert error:', error);
            return { success: false, message: `❌ Erreur création rappel: ${error.message}` };
        }

        // Format the confirmation message
        const reminderTime = reminderDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
        const confirmLabel = isRelative
            ? `${dayLabel} (à ${reminderTime})`
            : dayLabel;

        return {
            success: true,
            message: `✅ Rappel créé : "${title}" — ${confirmLabel}. Tu recevras une notification push 🔔`,
        };
    } catch (e) {
        console.error('[DirectTask] Error:', e);
        return { success: false, message: `❌ Erreur: ${e.message}` };
    }
}

/**
 * Message types:
 * - { role: 'user', content: string }
 * - { role: 'agent', content: string }
 * - { role: 'agent', type: 'confirm', content: string, details: object, id: string }
 * - { role: 'agent', type: 'select', content: string, options: array, id: string }
 * - { role: 'agent', type: 'success', content: string }
 * - { role: 'agent', type: 'error', content: string }
 * - { role: 'agent', type: 'thinking' }
 */

/**
 * Handle local agenda queries directly without calling the AI.
 * Returns { handled, message } or null if not an agenda query.
 */
function tryLocalAgendaQuery(text, agendaContext) {
    if (!agendaContext) return null;
    const { allApts, tasks, userCode, userName } = agendaContext;
    const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const now = new Date();

    // Filter user's appointments for today
    const todayApts = (allApts || [])
        .filter(a => a._start && isSameDay(a._start, now) &&
            (!userCode || !a._userCode || String(a._userCode) === String(userCode)))
        .sort((a, b) => a._start - b._start);

    // "Prochain RDV" / "next appointment"
    if (/\b(prochain|next)\b.*\b(rdv|rendez|appointment)\b/.test(lower) || /\b(rdv|rendez)\b.*\b(prochain|suivant)\b/.test(lower) || lower === 'prochain rdv') {
        const next = todayApts.find(a => a._start > now);
        if (!next) return { handled: true, message: "Pas de prochain rendez-vous aujourd'hui." };
        let msg = `Prochain RDV : ${next._clientName || next._objet} de ${formatTime(next._start)} a ${formatTime(next._end)}.`;
        if (next._address) msg += ` Adresse : ${next._address}.`;
        if (next._phone) msg += ` Tel : ${next._phone}.`;
        return { handled: true, message: msg };
    }

    // "Résume ma journée" / "briefing"
    if (/\b(resum|briefing|journee|ma journ)\b/.test(lower)) {
        const briefing = generateBriefing(todayApts, tasks || [], userName, null);
        return { handled: true, message: briefing };
    }

    // "Résume ma semaine"
    if (/\b(resum|bilan).*\b(semaine|week)\b/.test(lower)) {
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 5);

        const weekApts = (allApts || [])
            .filter(a => a._start && a._start >= weekStart && a._start < weekEnd &&
                (!userCode || !a._userCode || String(a._userCode) === String(userCode)))
            .sort((a, b) => a._start - b._start);

        const days = {};
        weekApts.forEach(a => {
            const dayKey = a._start.toLocaleDateString('fr-FR', { weekday: 'long' });
            if (!days[dayKey]) days[dayKey] = 0;
            days[dayKey]++;
        });

        let msg = `Cette semaine : ${weekApts.length} RDV au total. `;
        for (const [day, count] of Object.entries(days)) {
            msg += `${day} : ${count} RDV. `;
        }

        const pendingTasks = (tasks || []).filter(t => t.status !== 'done').length;
        if (pendingTasks > 0) msg += `${pendingTasks} tache${pendingTasks > 1 ? 's' : ''} en cours.`;

        return { handled: true, message: msg };
    }

    // "Je suis libre quand" / "créneaux libres"
    if (/\b(libre|disponible|creneau|dispo)\b/.test(lower)) {
        // Determine which day
        let targetDate = now;
        let dayLabel = "aujourd'hui";
        if (/demain/.test(lower)) {
            targetDate = new Date(now);
            targetDate.setDate(targetDate.getDate() + 1);
            dayLabel = 'demain';
        }
        const dayApts = (allApts || [])
            .filter(a => a._start && isSameDay(a._start, targetDate) &&
                (!userCode || !a._userCode || String(a._userCode) === String(userCode)))
            .sort((a, b) => a._start - b._start);

        const slots = findFreeSlots(dayApts, 8, 18, 30);
        if (slots.length === 0) return { handled: true, message: `Pas de créneau libre ${dayLabel}.` };

        let msg = `Créneaux libres ${dayLabel} : `;
        msg += slots.map(s => `${formatSlotTime(s.start)}-${formatSlotTime(s.end)} (${Math.floor(s.minutes / 60)}h${s.minutes % 60 > 0 ? String(s.minutes % 60).padStart(2, '0') : ''})`).join(', ');
        msg += '.';
        return { handled: true, message: msg };
    }

    // "Navigue vers" / "GPS" / "itinéraire"
    if (/\b(navigue|gps|itineraire|route|aller chez|direction)\b/.test(lower)) {
        const next = todayApts.find(a => a._start > now) || todayApts[0];
        if (!next || !next._address) return { handled: true, message: "Pas d'adresse trouvée pour le prochain RDV." };
        return {
            handled: true,
            message: `Navigation vers ${next._clientName || next._objet} : ${next._address}`,
            navigateTo: next._address,
        };
    }

    // "Conflits" / "chevauchement"
    if (/\b(conflit|chevauch|overlap)\b/.test(lower)) {
        const conflicts = detectConflicts(todayApts);
        if (conflicts.length === 0) return { handled: true, message: "Aucun conflit horaire aujourd'hui." };
        let msg = `${conflicts.length} conflit${conflicts.length > 1 ? 's' : ''} détecté${conflicts.length > 1 ? 's' : ''} : `;
        msg += conflicts.map(c => `${formatTime(c.apt1._start)} ${c.apt1._clientName || c.apt1._objet} chevauche ${formatTime(c.apt2._start)} ${c.apt2._clientName || c.apt2._objet} (${c.overlapMinutes}min)`).join(' | ');
        return { handled: true, message: msg };
    }

    return null;
}

export function useAgent() {
    const [messages, setMessages] = useState([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const conversationRef = useRef([]);
    const agendaContextRef = useRef(null);

    // Allow external components to set agenda context for local queries
    const setAgendaContext = useCallback((ctx) => {
        agendaContextRef.current = ctx;
    }, []);

    const addMessage = useCallback((msg) => {
        setMessages(prev => [...prev.filter(m => m.type !== 'thinking'), msg]);
    }, []);

    const showThinking = useCallback(() => {
        setMessages(prev => [...prev, { role: 'agent', type: 'thinking', id: 'thinking' }]);
    }, []);

    const removeThinking = useCallback(() => {
        setMessages(prev => prev.filter(m => m.type !== 'thinking'));
    }, []);

    const callAgent = useCallback(async (payload) => {
        try {
            // Use session token if available, otherwise anon key (both are valid Supabase JWTs)
            const { data: { session } } = await supabase.auth.getSession();
            const token = session?.access_token || SUPABASE_ANON;

            const response = await fetch(AGENT_FUNCTION_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'apikey': SUPABASE_ANON,
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Erreur serveur: ${response.status} - ${errorText}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Agent call error:', error);
            throw error;
        }
    }, []);

    const sendMessage = useCallback(async (text) => {
        if (!text.trim() || isProcessing) return;

        // Add user message
        const userMsg = { role: 'user', content: text, id: Date.now().toString() };
        addMessage(userMsg);
        conversationRef.current.push({ role: 'user', content: text });

        setIsProcessing(true);
        showThinking();

        try {
            // === LOCAL AGENDA QUERIES: instant response without AI ===
            const localResult = tryLocalAgendaQuery(text, agendaContextRef.current);
            if (localResult?.handled) {
                removeThinking();
                const agentMsg = {
                    role: 'agent',
                    content: localResult.message,
                    id: Date.now().toString(),
                };
                addMessage(agentMsg);
                conversationRef.current.push({ role: 'assistant', content: localResult.message });
                // If navigation requested, open geo URI
                if (localResult.navigateTo) {
                    window.open(`geo:0,0?q=${encodeURIComponent(localResult.navigateTo)}`, '_self');
                }
                setIsProcessing(false);
                return;
            }

            // === DIRECT RDV CREATION: bypass Gemini entirely for appointment requests ===
            const { data: { session: rdvSession } } = await supabase.auth.getSession();
            const rdvToken = rdvSession?.access_token || SUPABASE_ANON;
            const directResult = await tryDirectRdvCreation(text, rdvToken);
            if (directResult) {
                removeThinking();
                const agentMsg = {
                    role: 'agent',
                    type: directResult.success ? 'success' : 'error',
                    content: directResult.message,
                    id: Date.now().toString(),
                };
                addMessage(agentMsg);
                conversationRef.current.push({ role: 'assistant', content: directResult.message });
                setIsProcessing(false);
                return;
            }

            // === DIRECT TASK/REMINDER CREATION: bypass Gemini for reminder requests ===
            const taskResult = await tryDirectTaskCreation(text);
            if (taskResult) {
                removeThinking();
                const agentMsg = {
                    role: 'agent',
                    type: taskResult.success ? 'success' : 'error',
                    content: taskResult.message,
                    id: Date.now().toString(),
                };
                addMessage(agentMsg);
                conversationRef.current.push({ role: 'assistant', content: taskResult.message });
                setIsProcessing(false);
                return;
            }

            // Hint the agent to use search_client for contact info queries
            let messageToSend = text;
            const lower = text.toLowerCase();
            const isContactQuery = /\b(num[ée]ro|t[ée]l[ée]phone|coordonn[ée]es|adresse|mail|email|contact|infos?)\b/.test(lower)
                || /\b(qui est|connais|trouv)\b/.test(lower);
            const hasName = /\b(de |du |d')\s*[A-ZÀ-Ü]/i.test(text);
            if (isContactQuery && hasName) {
                messageToSend = text + '\n\n[INSTRUCTION SYSTÈME OBLIGATOIRE : Tu DOIS appeler l\'outil search_client avec le nom mentionné AVANT de répondre. Ne réponds JAMAIS sans avoir fait un function call search_client. C\'est OBLIGATOIRE.]';
            }

            const result = await callAgent({
                message: messageToSend,
                conversation: conversationRef.current,
            });

            removeThinking();

            if (result.type === 'confirm') {
                // Agent wants confirmation
                const agentMsg = {
                    role: 'agent',
                    type: 'confirm',
                    content: result.message,
                    details: result.details || {},
                    pendingAction: result.pendingAction,
                    id: Date.now().toString(),
                };
                addMessage(agentMsg);
                conversationRef.current.push({ role: 'assistant', content: result.message });
            } else if (result.type === 'select') {
                // Agent wants user to select from options
                const agentMsg = {
                    role: 'agent',
                    type: 'select',
                    content: result.message,
                    options: result.options || [],
                    pendingAction: result.pendingAction,
                    id: Date.now().toString(),
                };
                addMessage(agentMsg);
                conversationRef.current.push({ role: 'assistant', content: result.message });
            } else if (result.type === 'success') {
                const agentMsg = {
                    role: 'agent',
                    type: 'success',
                    content: result.message,
                    id: Date.now().toString(),
                };
                addMessage(agentMsg);
                conversationRef.current.push({ role: 'assistant', content: result.message });
            } else if (result.type === 'error') {
                const agentMsg = {
                    role: 'agent',
                    type: 'error',
                    content: result.message,
                    id: Date.now().toString(),
                };
                addMessage(agentMsg);
            } else if (result.type === 'compose_sms' || result.type === 'compose_email') {
                // Compose SMS or Email card
                const agentMsg = {
                    role: 'agent',
                    type: result.type,
                    content: result.message || '',
                    composeType: result.type === 'compose_sms' ? 'sms' : 'email',
                    recipientName: result.recipientName || '',
                    recipientContact: result.recipientContact || '',
                    recipientRole: result.recipientRole || '',
                    subject: result.subject || '',
                    body: result.body || '',
                    id: Date.now().toString(),
                };
                addMessage(agentMsg);
                conversationRef.current.push({ role: 'assistant', content: result.message || `${result.type === 'compose_sms' ? 'SMS' : 'Email'} préparé pour ${result.recipientName}` });
            } else {
                // Normal text response
                const agentMsg = {
                    role: 'agent',
                    content: result.message || result.content || 'Je n\'ai pas compris.',
                    id: Date.now().toString(),
                    stockProducts: result.stockProducts || null,
                };
                addMessage(agentMsg);
                conversationRef.current.push({ role: 'assistant', content: agentMsg.content });
            }
        } catch (error) {
            removeThinking();
            addMessage({
                role: 'agent',
                type: 'error',
                content: `Erreur de connexion : ${error.message}`,
                id: Date.now().toString(),
            });
        } finally {
            setIsProcessing(false);
        }
    }, [isProcessing, addMessage, showThinking, removeThinking, callAgent]);

    const respondToAction = useCallback(async (actionType, data) => {
        setIsProcessing(true);
        showThinking();

        // Add user response to conversation
        const userResponse = actionType === 'confirm'
            ? (data.confirmed ? 'Oui, je confirme' : 'Non, annuler')
            : `J'ai choisi : ${data.selectedLabel || data.selectedIndex}`;

        conversationRef.current.push({ role: 'user', content: userResponse });

        try {
            const result = await callAgent({
                message: userResponse,
                conversation: conversationRef.current,
                actionResponse: {
                    type: actionType,
                    ...data,
                },
            });

            removeThinking();

            if (result.type === 'success') {
                addMessage({
                    role: 'agent',
                    type: 'success',
                    content: result.message,
                    id: Date.now().toString(),
                });
            } else if (result.type === 'confirm') {
                addMessage({
                    role: 'agent',
                    type: 'confirm',
                    content: result.message,
                    details: result.details || {},
                    pendingAction: result.pendingAction,
                    id: Date.now().toString(),
                });
            } else if (result.type === 'select') {
                addMessage({
                    role: 'agent',
                    type: 'select',
                    content: result.message,
                    options: result.options || [],
                    pendingAction: result.pendingAction,
                    id: Date.now().toString(),
                });
            } else if (result.type === 'error') {
                addMessage({
                    role: 'agent',
                    type: 'error',
                    content: result.message,
                    id: Date.now().toString(),
                });
            } else if (result.type === 'compose_sms' || result.type === 'compose_email') {
                addMessage({
                    role: 'agent',
                    type: result.type,
                    content: result.message || '',
                    composeType: result.type === 'compose_sms' ? 'sms' : 'email',
                    recipientName: result.recipientName || '',
                    recipientContact: result.recipientContact || '',
                    recipientRole: result.recipientRole || '',
                    subject: result.subject || '',
                    body: result.body || '',
                    id: Date.now().toString(),
                });
            } else {
                addMessage({
                    role: 'agent',
                    content: result.message || 'Action traitée.',
                    id: Date.now().toString(),
                });
            }

            conversationRef.current.push({ role: 'assistant', content: result.message });
        } catch (error) {
            removeThinking();
            addMessage({
                role: 'agent',
                type: 'error',
                content: `Erreur : ${error.message}`,
                id: Date.now().toString(),
            });
        } finally {
            setIsProcessing(false);
        }
    }, [addMessage, showThinking, removeThinking, callAgent]);

    const clearConversation = useCallback(() => {
        setMessages([]);
        conversationRef.current = [];
    }, []);

    return {
        messages,
        isProcessing,
        sendMessage,
        respondToAction,
        clearConversation,
        setAgendaContext,
    };
}
