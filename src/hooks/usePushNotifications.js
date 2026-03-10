import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const VAPID_PUBLIC_KEY = 'BH2A-EIhJE7x_DcWaYZoIc_HemxXXnPSc1r0wFjNwvkjUFpzT5IXrPHvT_ck2zkoIi8YwrUdIYRJ0rjmwUg-8ws';

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

export function usePushNotifications(userId) {
    const [isSubscribed, setIsSubscribed] = useState(false);
    const [isSupported, setIsSupported] = useState(false);
    const [subscribing, setSubscribing] = useState(false);

    useEffect(() => {
        const supported = 'serviceWorker' in navigator && 'PushManager' in window;
        setIsSupported(supported);

        if (supported && userId) {
            checkAndSync();
        }
    }, [userId]);

    async function checkAndSync() {
        try {
            const registration = await navigator.serviceWorker.ready;
            const sub = await registration.pushManager.getSubscription();

            if (sub) {
                const subJson = sub.toJSON();
                // Check if it's saved in DB
                const { data } = await supabase
                    .from('agent_push_subscriptions')
                    .select('id')
                    .eq('endpoint', subJson.endpoint)
                    .maybeSingle();

                if (data) {
                    // Already synced
                    console.log('[Push] ✅ Subscription synced with DB');
                    setIsSubscribed(true);
                } else {
                    // In browser but not in DB — try to save it
                    console.log('[Push] Subscription in browser but not in DB, saving...');
                    const { error } = await supabase.from('agent_push_subscriptions').upsert({
                        user_id: userId,
                        endpoint: subJson.endpoint,
                        p256dh: subJson.keys.p256dh,
                        auth: subJson.keys.auth,
                    }, { onConflict: 'endpoint' });

                    if (error) {
                        console.error('[Push] Failed to sync:', error);
                        setIsSubscribed(false);
                    } else {
                        console.log('[Push] ✅ Synced to DB!');
                        setIsSubscribed(true);
                    }
                }
            } else {
                console.log('[Push] No browser subscription');
                setIsSubscribed(false);
            }
        } catch (err) {
            console.error('[Push] Check error:', err);
        }
    }

    const subscribe = useCallback(async () => {
        console.log('[Push] subscribe() called');
        setSubscribing(true);

        try {
            // Step 1: Permission
            const permission = await Notification.requestPermission();
            console.log('[Push] Permission:', permission);
            if (permission !== 'granted') {
                alert('Notifications refusées. Activez-les dans les paramètres du navigateur.');
                setSubscribing(false);
                return false;
            }

            // Step 2: SW ready
            const registration = await navigator.serviceWorker.ready;

            // Step 3: Remove old subscription entirely
            const existing = await registration.pushManager.getSubscription();
            if (existing) {
                console.log('[Push] Removing old subscription...');
                // Also remove from DB
                const oldJson = existing.toJSON();
                await supabase.from('agent_push_subscriptions')
                    .delete()
                    .eq('endpoint', oldJson.endpoint);
                await existing.unsubscribe();
            }

            // Step 4: Create fresh subscription
            console.log('[Push] Creating new subscription...');
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
            });
            const subJson = subscription.toJSON();
            console.log('[Push] Created:', subJson.endpoint?.substring(0, 60));

            // Step 5: Save to DB
            const { error } = await supabase.from('agent_push_subscriptions').upsert({
                user_id: userId,
                endpoint: subJson.endpoint,
                p256dh: subJson.keys.p256dh,
                auth: subJson.keys.auth,
            }, { onConflict: 'endpoint' });

            if (error) {
                console.error('[Push] ❌ DB error:', JSON.stringify(error));
                alert('Erreur sauvegarde: ' + error.message);
                setSubscribing(false);
                return false;
            }

            console.log('[Push] ✅ Saved to DB!');
            setIsSubscribed(true);
            setSubscribing(false);
            return true;
        } catch (err) {
            console.error('[Push] ❌ Error:', err);
            alert('Erreur: ' + err.message);
            setSubscribing(false);
            return false;
        }
    }, [userId]);

    const unsubscribe = useCallback(async () => {
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                const endpoint = subscription.endpoint;
                await subscription.unsubscribe();
                await supabase.from('agent_push_subscriptions')
                    .delete()
                    .eq('endpoint', endpoint);
            }
            setIsSubscribed(false);
            console.log('[Push] Unsubscribed');
        } catch (err) {
            console.error('[Push] Unsubscribe error:', err);
        }
    }, []);

    return { isSubscribed, isSupported, subscribing, subscribe, unsubscribe };
}
