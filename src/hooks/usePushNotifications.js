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
            // Check browser subscription on mount
            navigator.serviceWorker.ready.then(async (reg) => {
                const sub = await reg.pushManager.getSubscription();
                setIsSubscribed(!!sub);
                console.log('[Push] Init check — subscribed:', !!sub);
            }).catch(e => console.error('[Push] Init check error:', e));
        }
    }, [userId]);

    const subscribe = useCallback(async () => {
        console.log('[Push] subscribe() called, userId:', userId);
        setSubscribing(true);

        try {
            // Step 1: Permission
            console.log('[Push] Step 1: Requesting permission...');
            const permission = await Notification.requestPermission();
            console.log('[Push] Permission:', permission);
            if (permission !== 'granted') {
                alert('Notifications refusées. Vérifiez les paramètres du navigateur.');
                setSubscribing(false);
                return false;
            }

            // Step 2: Wait for SW
            console.log('[Push] Step 2: Waiting for service worker...');
            const registration = await navigator.serviceWorker.ready;
            console.log('[Push] SW ready, scope:', registration.scope);

            // Step 3: Unsubscribe existing
            const existing = await registration.pushManager.getSubscription();
            if (existing) {
                console.log('[Push] Step 3: Removing existing subscription...');
                await existing.unsubscribe();
            }

            // Step 4: Create push subscription
            console.log('[Push] Step 4: Creating push subscription...');
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
            });
            const subJson = subscription.toJSON();
            console.log('[Push] Subscription created!', subJson.endpoint?.substring(0, 50));

            // Step 5: Save to DB
            console.log('[Push] Step 5: Saving to Supabase...');
            const { error } = await supabase.from('agent_push_subscriptions').upsert({
                user_id: userId,
                endpoint: subJson.endpoint,
                p256dh: subJson.keys.p256dh,
                auth: subJson.keys.auth,
            }, { onConflict: 'endpoint' });

            if (error) {
                console.error('[Push] ❌ DB save error:', JSON.stringify(error));
                alert('Erreur de sauvegarde: ' + error.message);
                setSubscribing(false);
                return false;
            }

            console.log('[Push] ✅ Subscription saved to DB!');
            setIsSubscribed(true);
            setSubscribing(false);
            return true;
        } catch (err) {
            console.error('[Push] ❌ Error:', err);
            alert('Erreur notifications: ' + err.message);
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
                console.log('[Push] Unsubscribed');
            }
            setIsSubscribed(false);
        } catch (err) {
            console.error('[Push] Unsubscribe error:', err);
        }
    }, []);

    return { isSubscribed, isSupported, subscribing, subscribe, unsubscribe };
}
