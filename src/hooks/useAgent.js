import { useState, useRef, useCallback } from 'react';
import { supabase, AGENT_FUNCTION_URL, SUPABASE_ANON } from '../lib/supabase';

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
 * Message types:
 * - { role: 'user', content: string }
 * - { role: 'agent', content: string }
 * - { role: 'agent', type: 'confirm', content: string, details: object, id: string }
 * - { role: 'agent', type: 'select', content: string, options: array, id: string }
 * - { role: 'agent', type: 'success', content: string }
 * - { role: 'agent', type: 'error', content: string }
 * - { role: 'agent', type: 'thinking' }
 */

export function useAgent() {
    const [messages, setMessages] = useState([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const conversationRef = useRef([]);

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
    };
}
