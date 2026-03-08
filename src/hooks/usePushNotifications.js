import { useEffect, useState } from 'react';
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

    useEffect(() => {
        const supported = 'serviceWorker' in navigator && 'PushManager' in window;
        setIsSupported(supported);

        if (supported && userId) {
            checkSubscription();
        }
    }, [userId]);

    async function checkSubscription() {
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            setIsSubscribed(!!subscription);
        } catch (err) {
            console.error('Push subscription check failed:', err);
        }
    }

    async function subscribe() {
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                console.log('Notification permission denied');
                return false;
            }

            const registration = await navigator.serviceWorker.ready;

            // Unsubscribe existing if any
            const existing = await registration.pushManager.getSubscription();
            if (existing) await existing.unsubscribe();

            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
            });

            const subJson = subscription.toJSON();

            // Save to Supabase
            const { error } = await supabase.from('agent_push_subscriptions').upsert({
                user_id: userId,
                endpoint: subJson.endpoint,
                p256dh: subJson.keys.p256dh,
                auth: subJson.keys.auth,
            }, { onConflict: 'endpoint' });

            if (error) {
                console.error('Failed to save push subscription:', error);
                return false;
            }

            setIsSubscribed(true);
            console.log('Push subscription saved!');
            return true;
        } catch (err) {
            console.error('Push subscription failed:', err);
            return false;
        }
    }

    async function unsubscribe() {
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();
                // Remove from Supabase
                await supabase.from('agent_push_subscriptions')
                    .delete()
                    .eq('endpoint', subscription.endpoint);
            }
            setIsSubscribed(false);
        } catch (err) {
            console.error('Push unsubscription failed:', err);
        }
    }

    return { isSubscribed, isSupported, subscribe, unsubscribe };
}
