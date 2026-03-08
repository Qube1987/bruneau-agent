import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const QUENTIN_CODE = '46516';
const SMS_TEMPLATE = `Bonjour, je suis en route et serai chez vous dans XX min.\nCordialement,\nQuentin Bruneau\nSté Bruneau Protection`;

function extractAddr(val) {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
        return [val.description, val.codePostal, val.ville].filter(Boolean).join(', ');
    }
    return '';
}

function formatDateYMD(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDuration(mins) {
    if (mins < 60) return `${Math.round(mins)} min`;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return m > 0 ? `${h}h${pad2(m)}` : `${h}h`;
}

// Build a Google Maps directions URL with all stops
function buildGoogleMapsUrl(geoApts) {
    if (geoApts.length === 0) return null;
    if (geoApts.length === 1) {
        const a = geoApts[0];
        return `https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lon}`;
    }
    // Origin = first, destination = last, waypoints = middle
    const origin = `${geoApts[0].lat},${geoApts[0].lon}`;
    const dest = `${geoApts[geoApts.length - 1].lat},${geoApts[geoApts.length - 1].lon}`;
    const waypoints = geoApts.slice(1, -1).map(a => `${a.lat},${a.lon}`).join('|');
    let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=driving`;
    if (waypoints) url += `&waypoints=${waypoints}`;
    return url;
}

// Build a static map image URL using OpenStreetMap's staticmap service  
function buildStaticMapUrl(geoApts) {
    if (geoApts.length === 0) return null;
    // Use OSM static map API (no key required)
    const markers = geoApts.map((a, i) => `${a.lon},${a.lat},lightblue${i + 1}`).join('|');
    // Center on first apt or average
    const avgLat = geoApts.reduce((s, a) => s + a.lat, 0) / geoApts.length;
    const avgLon = geoApts.reduce((s, a) => s + a.lon, 0) / geoApts.length;
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${avgLat},${avgLon}&zoom=10&size=600x300&maptype=mapnik&markers=${markers}`;
}

export default function MyDayMap({ onClose }) {
    const [appointments, setAppointments] = useState([]);
    const [routes, setRoutes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedDate, setSelectedDate] = useState(() => new Date());

    const goToPrevDay = () => setSelectedDate(d => { const n = new Date(d); n.setDate(n.getDate() - 1); return n; });
    const goToNextDay = () => setSelectedDate(d => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; });
    const goToToday = () => setSelectedDate(new Date());

    const isToday = (() => {
        const now = new Date();
        return selectedDate.getFullYear() === now.getFullYear()
            && selectedDate.getMonth() === now.getMonth()
            && selectedDate.getDate() === now.getDate();
    })();

    // Fetch appointments for selected date
    useEffect(() => {
        let cancelled = false;
        const fetchDay = async () => {
            setLoading(true);
            setAppointments([]);
            setRoutes([]);
            const dayStr = formatDateYMD(selectedDate);

            try {
                const resp = await supabase.functions.invoke('extrabat-proxy', {
                    body: {
                        endpoint: `utilisateur/${QUENTIN_CODE}/rendez-vous`,
                        apiVersion: 'v1',
                        params: {
                            date_debut: dayStr,
                            date_fin: dayStr,
                            include: 'client',
                        },
                    },
                });

                if (!cancelled && resp.data?.success && resp.data.data) {
                    const raw = resp.data.data;
                    const apts = Array.isArray(raw) ? raw : Object.values(raw);
                    const parsed = [];
                    apts.forEach(apt => {
                        const objet = apt.objet || apt.titre || apt.title || apt.label || '';
                        let clientName = '';
                        if (apt.clients?.length > 0 && apt.clients[0].nom) clientName = apt.clients[0].nom;
                        else if (apt.rdvClients?.[0]?.nom) clientName = apt.rdvClients[0].nom;
                        else if (apt.client_nom) clientName = apt.client_nom;
                        else if (apt.client?.nom) clientName = apt.client.nom;

                        const start = apt.debut ? new Date(apt.debut.replace(' ', 'T')) : null;
                        const end = apt.fin ? new Date(apt.fin.replace(' ', 'T')) : null;
                        const lat = parseFloat(apt.lieu?.gpsLat);
                        const lon = parseFloat(apt.lieu?.gpsLon);

                        if (start && end) {
                            const phone = (() => {
                                const p = apt.telephone || apt.phone
                                    || apt.clients?.[0]?.telephone || apt.clients?.[0]?.portable
                                    || apt.rdvClients?.[0]?.telephone || apt.rdvClients?.[0]?.portable
                                    || '';
                                return typeof p === 'string' ? p : '';
                            })();

                            parsed.push({
                                id: apt.id,
                                clientName,
                                objet: typeof objet === 'string' ? objet : '',
                                start,
                                end,
                                lat: isNaN(lat) ? null : lat,
                                lon: isNaN(lon) ? null : lon,
                                address: extractAddr(apt.lieu) || extractAddr(apt.adresse) || extractAddr(apt.address) || '',
                                phone,
                            });
                        }
                    });

                    parsed.sort((a, b) => a.start - b.start);
                    if (!cancelled) setAppointments(parsed);
                }
            } catch (e) {
                console.error('MyDayMap fetch error:', e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchDay();
        return () => { cancelled = true; };
    }, [selectedDate]);

    // Fetch routes between geolocated appointments
    useEffect(() => {
        const geoApts = appointments.filter(a => a.lat && a.lon);
        if (geoApts.length < 2) { setRoutes([]); return; }

        let cancelled = false;
        const fetchRoutes = async () => {
            const newRoutes = [];
            for (let i = 0; i < geoApts.length - 1; i++) {
                const from = geoApts[i];
                const to = geoApts[i + 1];
                try {
                    const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
                    const resp = await fetch(url);
                    const data = await resp.json();
                    if (data.routes?.[0]) {
                        newRoutes.push({
                            from: from.id,
                            to: to.id,
                            durationMin: data.routes[0].duration / 60,
                            distanceKm: data.routes[0].distance / 1000,
                        });
                    }
                } catch (e) {
                    console.error('OSRM route error:', e);
                }
            }
            if (!cancelled) setRoutes(newRoutes);
        };

        fetchRoutes();
        return () => { cancelled = true; };
    }, [appointments]);

    const geoApts = appointments.filter(a => a.lat && a.lon);
    const staticMapUrl = buildStaticMapUrl(geoApts);
    const googleMapsUrl = buildGoogleMapsUrl(geoApts);

    return (
        <div className="myday-overlay" onClick={onClose}>
            <div className="myday" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="myday__header">
                    <div className="myday__header-left">
                        <span className="myday__icon">🗺️</span>
                        <span className="myday__title">Ma Journée</span>
                    </div>
                    <div className="myday__header-nav">
                        <button className="myday__nav-arrow" onClick={goToPrevDay} title="Jour précédent">◀</button>
                        <button className="myday__nav-date" onClick={goToToday} title="Aujourd'hui">
                            {selectedDate.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}
                            {isToday && <span className="myday__today-dot" />}
                        </button>
                        <button className="myday__nav-arrow" onClick={goToNextDay} title="Jour suivant">▶</button>
                    </div>
                    <button className="myday__close" onClick={onClose}>✕</button>
                </div>

                {/* Map area — static image (100% reliable, no JS dependencies) */}
                <div className="myday__map-container">
                    {geoApts.length > 0 && staticMapUrl ? (
                        <a
                            href={googleMapsUrl || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="myday__map-link"
                        >
                            <img
                                src={staticMapUrl}
                                alt="Carte des rendez-vous"
                                className="myday__map-img"
                                onError={(e) => {
                                    // Fallback: if static map fails, show a placeholder
                                    e.target.style.display = 'none';
                                    e.target.nextSibling.style.display = 'flex';
                                }}
                            />
                            <div className="myday__map-fallback" style={{ display: 'none' }}>
                                <span>🗺️</span>
                                <p>Carte non disponible</p>
                            </div>
                            <div className="myday__map-cta">
                                📍 Ouvrir dans Google Maps
                            </div>
                        </a>
                    ) : (
                        <div className="myday__map-placeholder">
                            {loading ? (
                                <>
                                    <div className="myday__loading-spinner" />
                                    <p>Chargement...</p>
                                </>
                            ) : appointments.length === 0 ? (
                                <>
                                    <span>📅</span>
                                    <p>Aucun rendez-vous ce jour</p>
                                </>
                            ) : (
                                <>
                                    <span>📍</span>
                                    <p>Pas de coordonnées GPS pour ces RDV</p>
                                </>
                            )}
                        </div>
                    )}
                </div>

                {/* Appointment list with travel times */}
                <div className="myday__list">
                    {appointments.map((apt, i) => {
                        const startStr = `${pad2(apt.start.getHours())}:${pad2(apt.start.getMinutes())}`;
                        const endStr = `${pad2(apt.end.getHours())}:${pad2(apt.end.getMinutes())}`;
                        const routeToNext = routes.find(r => r.from === apt.id);
                        const smsBody = encodeURIComponent(SMS_TEMPLATE);
                        const cleanPhone = apt.phone?.replace(/[\s.]/g, '') || '';

                        return (
                            <div key={apt.id || i}>
                                <div className="myday__card">
                                    <div className="myday__card-number">{i + 1}</div>
                                    <div className="myday__card-body">
                                        <div className="myday__card-time">{startStr} → {endStr}</div>
                                        <div className="myday__card-client">{apt.clientName || apt.objet || '(sans titre)'}</div>
                                        {apt.objet && apt.clientName && (
                                            <div className="myday__card-objet">{apt.objet}</div>
                                        )}
                                        {apt.address && (
                                            <a
                                                href={apt.lat && apt.lon
                                                    ? `https://www.google.com/maps/search/?api=1&query=${apt.lat},${apt.lon}`
                                                    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(apt.address)}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="myday__card-address"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                📍 {apt.address}
                                            </a>
                                        )}
                                    </div>
                                    <div className="myday__card-actions">
                                        {cleanPhone && (
                                            <a
                                                href={`sms:${cleanPhone}?body=${smsBody}`}
                                                className="myday__sms-btn"
                                                title="SMS: J'arrive dans XX min"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                ✉️
                                            </a>
                                        )}
                                        {apt.lat && apt.lon && (
                                            <a
                                                href={`geo:${apt.lat},${apt.lon}?q=${encodeURIComponent(apt.address || `${apt.lat},${apt.lon}`)}`}
                                                className="myday__nav-btn"
                                                title="Naviguer"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                🧭
                                            </a>
                                        )}
                                    </div>
                                </div>

                                {/* Travel time badge */}
                                {routeToNext && (
                                    <div className="myday__travel">
                                        <div className="myday__travel-line" />
                                        <div className="myday__travel-badge">
                                            🚗 {formatDuration(routeToNext.durationMin)} · {routeToNext.distanceKm.toFixed(1)} km
                                        </div>
                                        <div className="myday__travel-line" />
                                    </div>
                                )}
                                {!routeToNext && i < appointments.length - 1 && (
                                    <div className="myday__separator" />
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
