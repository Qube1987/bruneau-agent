/**
 * Agenda utilities: conflict detection, travel time, briefing, smart timeline
 */

const DAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAYS_FR_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export { DAYS_FR, DAYS_FR_SHORT, MONTHS_FR };

// ── Date helpers ──

export function isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getDate() === d2.getDate();
}

export function formatDateYMD(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function pad2(n) { return String(n).padStart(2, '0'); }

export function formatTime(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

export function formatDayFull(date) {
    return date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function getGreeting(userName) {
    const hour = new Date().getHours();
    const base = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon aprem' : 'Bonsoir';
    return userName ? `${base} ${userName}` : base;
}

// ── Conflict detection ──

export function detectConflicts(appointments) {
    const conflicts = [];
    const sorted = [...appointments].sort((a, b) => a._start - b._start);

    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            if (sorted[j]._start < sorted[i]._end) {
                conflicts.push({
                    apt1: sorted[i],
                    apt2: sorted[j],
                    overlapMinutes: Math.round((sorted[i]._end - sorted[j]._start) / 60000),
                });
            } else {
                break;
            }
        }
    }
    return conflicts;
}

// ── Gap detection (free slots) ──

export function findFreeSlots(appointments, dayStart = 8, dayEnd = 18, minMinutes = 30) {
    if (appointments.length === 0) {
        return [{ start: dayStart * 60, end: dayEnd * 60, minutes: (dayEnd - dayStart) * 60 }];
    }

    const sorted = [...appointments].sort((a, b) => a._start - b._start);
    const slots = [];
    let lastEnd = dayStart * 60; // in minutes from midnight

    for (const apt of sorted) {
        const aptStartMin = apt._start.getHours() * 60 + apt._start.getMinutes();
        const aptEndMin = apt._end.getHours() * 60 + apt._end.getMinutes();

        if (aptStartMin - lastEnd >= minMinutes) {
            slots.push({
                start: lastEnd,
                end: aptStartMin,
                minutes: aptStartMin - lastEnd,
            });
        }
        lastEnd = Math.max(lastEnd, aptEndMin);
    }

    if (dayEnd * 60 - lastEnd >= minMinutes) {
        slots.push({
            start: lastEnd,
            end: dayEnd * 60,
            minutes: dayEnd * 60 - lastEnd,
        });
    }

    return slots;
}

export function formatSlotTime(minutesFromMidnight) {
    const h = Math.floor(minutesFromMidnight / 60);
    const m = minutesFromMidnight % 60;
    return `${pad2(h)}:${pad2(m)}`;
}

// ── Smart timeline: compute optimal time range ──

export function getSmartTimeRange(appointments, padding = 1) {
    if (appointments.length === 0) return { start: 8, end: 18 };

    let earliest = 23;
    let latest = 0;

    for (const apt of appointments) {
        const startH = apt._start.getHours() + apt._start.getMinutes() / 60;
        const endH = apt._end.getHours() + apt._end.getMinutes() / 60;
        earliest = Math.min(earliest, startH);
        latest = Math.max(latest, endH);
    }

    return {
        start: Math.max(0, Math.floor(earliest) - padding),
        end: Math.min(24, Math.ceil(latest) + padding),
    };
}

// ── Travel time estimation (simple distance-based) ──

const GEOCODE_CACHE = {};

export async function geocodeAddress(address) {
    if (!address) return null;
    if (GEOCODE_CACHE[address]) return GEOCODE_CACHE[address];

    try {
        const resp = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`,
            { headers: { 'User-Agent': 'BruneauAgent/1.0' } }
        );
        const data = await resp.json();
        if (data && data.length > 0) {
            const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
            GEOCODE_CACHE[address] = result;
            return result;
        }
    } catch (e) {
        console.warn('Geocode failed:', e);
    }
    return null;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Estimate travel time between two addresses.
 * Returns { minutes, km } or null.
 */
export async function estimateTravelTime(fromAddr, toAddr) {
    if (!fromAddr || !toAddr) return null;
    const from = await geocodeAddress(fromAddr);
    const to = await geocodeAddress(toAddr);
    if (!from || !to) return null;

    const km = haversineDistance(from.lat, from.lon, to.lat, to.lon);
    // Estimate: 40 km/h average in urban/suburban, add 5 min buffer
    const minutes = Math.round((km / 40) * 60) + 5;
    return { minutes, km: Math.round(km * 10) / 10 };
}

/**
 * Compute travel times between consecutive appointments.
 * Returns array of { fromApt, toApt, minutes, km } for each pair.
 */
export async function computeTravelTimes(appointments) {
    const sorted = [...appointments].sort((a, b) => a._start - b._start);
    const results = [];

    for (let i = 0; i < sorted.length - 1; i++) {
        const fromApt = sorted[i];
        const toApt = sorted[i + 1];
        if (fromApt._address && toApt._address) {
            const travel = await estimateTravelTime(fromApt._address, toApt._address);
            if (travel) {
                const gapMinutes = Math.round((toApt._start - fromApt._end) / 60000);
                results.push({
                    fromApt,
                    toApt,
                    ...travel,
                    gapMinutes,
                    tight: travel.minutes > gapMinutes,
                });
            }
        }
    }
    return results;
}

// ── Briefing generation ──

export function generateBriefing(dayApts, tasks, userName, weather) {
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';

    let text = `${greeting}${userName ? ` ${userName}` : ''} ! `;

    // Appointments summary
    if (dayApts.length === 0) {
        text += `Pas de rendez-vous aujourd'hui. `;
    } else if (dayApts.length === 1) {
        const apt = dayApts[0];
        text += `Tu as 1 rendez-vous aujourd'hui : ${apt._clientName || apt._objet} à ${formatTime(apt._start)}. `;
    } else {
        text += `Tu as ${dayApts.length} rendez-vous aujourd'hui. `;
        const first = dayApts[0];
        text += `Le premier est ${first._clientName ? `chez ${first._clientName}` : first._objet} à ${formatTime(first._start)}. `;
    }

    // Overdue tasks
    const overdue = tasks.filter(t => {
        if (!t.due_date || t.status === 'done') return false;
        return new Date(t.due_date) < new Date(now.toDateString());
    });
    if (overdue.length > 0) {
        text += `Attention, ${overdue.length} tâche${overdue.length > 1 ? 's' : ''} en retard. `;
    }

    // Today's tasks
    const todayTasks = tasks.filter(t => {
        if (!t.due_date || t.status === 'done') return false;
        return isSameDay(new Date(t.due_date), now);
    });
    if (todayTasks.length > 0) {
        text += `${todayTasks.length} tâche${todayTasks.length > 1 ? 's' : ''} à faire aujourd'hui. `;
    }

    // Weather
    if (weather) {
        text += `Météo : ${weather.description}, ${weather.temp}°C. `;
    }

    // Conflicts
    const conflicts = detectConflicts(dayApts);
    if (conflicts.length > 0) {
        text += `Attention, ${conflicts.length} conflit${conflicts.length > 1 ? 's' : ''} horaire${conflicts.length > 1 ? 's' : ''} détecté${conflicts.length > 1 ? 's' : ''} ! `;
    }

    return text;
}
