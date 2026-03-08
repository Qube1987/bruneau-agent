import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';

const VAPID_PUBLIC_KEY = 'BIGnllFX9mg5QCQMgKA752WNmFo99E2DEFxP6bxsa4HE5kfhIy_VOW8bUpDhCD167I6zDow967Kqwr0gIIAz7N4M';

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
    const subscribingRef = useRef(false); // prevent double-subscribe

    useEffect(() => {
        const supported = 'serviceWorker' in navigator && 'PushManager' in window;
        setIsSupported(supported);

        if (supported && userId) {
            checkExistingSubscription();
        }
    }, [userId]);

    async function checkExistingSubscription() {
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                console.log('[Push] Existing subscription found');
                setIsSubscribed(true);

                // Verify it's in the database too
                const subJson = subscription.toJSON();
                const { data } = await supabase
                    .from('agent_push_subscriptions')
                    .select('id')
                    .eq('endpoint', subJson.endpoint)
                    .maybeSingle();

                if (!data) {
                    console.log('[Push] Subscription exists in browser but not in DB, saving...');
                    await saveSubscriptionToDb(userId, subJson);
                }
            } else {
                console.log('[Push] No existing subscription');
                setIsSubscribed(false);
            }
        } catch (err) {
            console.error('[Push] Check failed:', err);
        }
    }

    async function saveSubscriptionToDb(uid, subJson) {
        try {
            const { error } = await supabase.from('agent_push_subscriptions').upsert({
                user_id: uid,
                endpoint: subJson.endpoint,
                p256dh: subJson.keys.p256dh,
                auth: subJson.keys.auth,
            }, { onConflict: 'endpoint' });

            if (error) {
                console.error('[Push] DB save error:', error);
                return false;
            }
            console.log('[Push] Subscription saved to DB!');
            return true;
        } catch (err) {
            console.error('[Push] DB save exception:', err);
            return false;
        }
    }

    const subscribe = useCallback(async () => {
        if (subscribingRef.current) {
            console.log('[Push] Already subscribing, skipping...');
            return false;
        }
        subscribingRef.current = true;

        try {
            console.log('[Push] Requesting notification permission...');
            const permission = await Notification.requestPermission();
            console.log('[Push] Permission result:', permission);

            if (permission !== 'granted') {
                console.log('[Push] Permission denied');
                subscribingRef.current = false;
                return false;
            }

            console.log('[Push] Waiting for service worker ready...');
            const registration = await navigator.serviceWorker.ready;
            console.log('[Push] Service worker ready');

            // Unsubscribe existing if any
            const existing = await registration.pushManager.getSubscription();
            if (existing) {
                console.log('[Push] Unsubscribing existing...');
                await existing.unsubscribe();
            }

            console.log('[Push] Creating new subscription with VAPID key...');
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
            });

            console.log('[Push] Subscription created:', subscription.endpoint.substring(0, 60) + '...');

            const subJson = subscription.toJSON();
            console.log('[Push] Keys:', { p256dh: subJson.keys?.p256dh?.substring(0, 20), auth: subJson.keys?.auth?.substring(0, 10) });

            // Save to Supabase
            const saved = await saveSubscriptionToDb(userId, subJson);
            if (saved) {
                setIsSubscribed(true);
                console.log('[Push] ✅ Fully subscribed!');
            }

            subscribingRef.current = false;
            return saved;
        } catch (err) {
            console.error('[Push] Subscribe error:', err);
            subscribingRef.current = false;
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
                console.log('[Push] Unsubscribed and removed from DB');
            }
            setIsSubscribed(false);
        } catch (err) {
            console.error('[Push] Unsubscribe error:', err);
        }
    }, []);

    return { isSubscribed, isSupported, subscribe, unsubscribe };
}
