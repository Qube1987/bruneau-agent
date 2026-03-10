import { useCallback, useEffect, useRef } from 'react';

const DB_NAME = 'bruneau-agent-cache';
const DB_VERSION = 1;
const STORES = {
    appointments: 'appointments',
    tasks: 'tasks',
    meta: 'meta',
};

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORES.appointments)) {
                db.createObjectStore(STORES.appointments, { keyPath: '_cacheKey' });
            }
            if (!db.objectStoreNames.contains(STORES.tasks)) {
                db.createObjectStore(STORES.tasks, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORES.meta)) {
                db.createObjectStore(STORES.meta, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function putAll(storeName, items) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const item of items) {
            store.put(item);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getAll(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getMeta(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.meta, 'readonly');
        const store = tx.objectStore(STORES.meta);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result?.value);
        req.onerror = () => reject(req.error);
    });
}

async function setMeta(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.meta, 'readwrite');
        const store = tx.objectStore(STORES.meta);
        store.put({ key, value, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function clearStore(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Hook for offline caching of appointments and tasks using IndexedDB.
 * Provides save/load functions and automatic background syncing.
 */
export function useOfflineCache() {
    const isOnline = useRef(navigator.onLine);

    useEffect(() => {
        const handleOnline = () => { isOnline.current = true; };
        const handleOffline = () => { isOnline.current = false; };
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    const cacheAppointments = useCallback(async (teamAptsCache) => {
        try {
            const items = [];
            for (const [code, apts] of Object.entries(teamAptsCache)) {
                for (const apt of apts) {
                    items.push({
                        ...apt,
                        _cacheKey: `${code}_${apt.id}`,
                        _start: apt._start.toISOString(),
                        _end: apt._end.toISOString(),
                    });
                }
            }
            await clearStore(STORES.appointments);
            await putAll(STORES.appointments, items);
            await setMeta('appointments_cached_at', Date.now());
        } catch (e) {
            console.warn('Failed to cache appointments:', e);
        }
    }, []);

    const loadCachedAppointments = useCallback(async () => {
        try {
            const cachedAt = await getMeta('appointments_cached_at');
            if (!cachedAt || Date.now() - cachedAt > 24 * 60 * 60 * 1000) {
                return null; // Cache too old
            }

            const items = await getAll(STORES.appointments);
            const cache = {};
            for (const item of items) {
                const code = item._userCode;
                if (!cache[code]) cache[code] = [];
                cache[code].push({
                    ...item,
                    _start: new Date(item._start),
                    _end: new Date(item._end),
                });
            }
            return cache;
        } catch (e) {
            console.warn('Failed to load cached appointments:', e);
            return null;
        }
    }, []);

    const cacheTasks = useCallback(async (tasks) => {
        try {
            await clearStore(STORES.tasks);
            await putAll(STORES.tasks, tasks);
            await setMeta('tasks_cached_at', Date.now());
        } catch (e) {
            console.warn('Failed to cache tasks:', e);
        }
    }, []);

    const loadCachedTasks = useCallback(async () => {
        try {
            const cachedAt = await getMeta('tasks_cached_at');
            if (!cachedAt || Date.now() - cachedAt > 24 * 60 * 60 * 1000) {
                return null;
            }
            return await getAll(STORES.tasks);
        } catch (e) {
            console.warn('Failed to load cached tasks:', e);
            return null;
        }
    }, []);

    return {
        cacheAppointments,
        loadCachedAppointments,
        cacheTasks,
        loadCachedTasks,
        isOnline: () => isOnline.current,
    };
}
