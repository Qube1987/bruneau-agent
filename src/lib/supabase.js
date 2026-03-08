import { createClient } from '@supabase/supabase-js';

// Toutes les apps partagent la même base Supabase (Bruneau-Protection)
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://rzxisqsdsiiuwaixnneo.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6eGlzcXNkc2lpdXdhaXhubmVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxOTIyNjcsImV4cCI6MjA4Nzc2ODI2N30._qpwIHvnBCy6SlRugWgUm6ObGT8dOoRkjmaFRuajLhw';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const SUPABASE_ANON = SUPABASE_ANON_KEY;

export const AGENT_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/agent-orchestrator`;

// Auth helpers (same pattern as SAV/CRM apps)
export const auth = {
    signIn: async (email, password) => {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        return { data, error };
    },
    signOut: async () => {
        const { error } = await supabase.auth.signOut();
        return { error };
    },
    getCurrentUser: async () => {
        const { data: { user }, error } = await supabase.auth.getUser();
        return { user, error };
    },
    onAuthStateChange: (callback) => {
        return supabase.auth.onAuthStateChange(callback);
    },
};
