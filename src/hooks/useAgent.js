import { useState, useRef, useCallback } from 'react';
import { supabase, AGENT_FUNCTION_URL, SUPABASE_ANON } from '../lib/supabase';

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
            const result = await callAgent({
                message: text,
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
