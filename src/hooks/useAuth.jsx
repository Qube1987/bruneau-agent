import { useState, useEffect, createContext, useContext } from 'react';
import { supabase, auth } from '../lib/supabase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [userProfile, setUserProfile] = useState(null);
    const [loading, setLoading] = useState(true);

    // Load user profile from the `users` table (display_name, extrabat_code, etc.)
    const loadUserProfile = async (authUser) => {
        if (!authUser?.email) {
            setUserProfile(null);
            return;
        }
        try {
            const { data } = await supabase
                .from('users')
                .select('*')
                .eq('email', authUser.email)
                .maybeSingle();
            setUserProfile(data);
        } catch {
            setUserProfile(null);
        }
    };

    useEffect(() => {
        // Get initial user
        auth.getCurrentUser().then(async ({ user: authUser }) => {
            setUser(authUser);
            await loadUserProfile(authUser);
            setLoading(false);
        });

        // Listen for auth changes
        const { data: { subscription } } = auth.onAuthStateChange((event, session) => {
            (async () => {
                const authUser = session?.user ?? null;
                setUser(authUser);
                await loadUserProfile(authUser);
                setLoading(false);
            })();
        });

        return () => subscription.unsubscribe();
    }, []);

    const signIn = async (email, password) => {
        const { error } = await auth.signIn(email, password);
        return { error };
    };

    const signOut = async () => {
        await auth.signOut();
        setUser(null);
        setUserProfile(null);
    };

    // Build a merged currentUser for easy access throughout the app
    const currentUser = user && userProfile ? {
        id: userProfile.id,
        authId: user.id,
        email: user.email,
        display_name: userProfile.display_name,
        role: userProfile.role,
        extrabat_code: userProfile.extrabat_code,
        phone: userProfile.phone,
    } : null;

    return (
        <AuthContext.Provider value={{ user, userProfile, currentUser, loading, signIn, signOut }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
    return ctx;
}
