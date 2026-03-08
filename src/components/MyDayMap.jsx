import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const QUENTIN_CODE = '46516';
const SMS_TEMPLATE = `Bonjour, je suis en route et serai chez vous dans XX min.\nCordialement,\nQuentin Bruneau\nSté Bruneau Protection`;

// Sanitize address from Extrabat (can be string or object)
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

// Format duration in minutes to human readable
function formatDuration(mins) {
    if (mins < 60) return `${Math.round(mins)} min`;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return m > 0 ? `${h}h${pad2(m)}` : `${h}h`;
}

export default function MyDayMap({ onClose }) {
    const mapRef = useRef(null);
    const mapInstanceRef = useRef(null);
    const [appointments, setAppointments] = useState([]);
    const [routes, setRoutes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activeApt, setActiveApt] = useState(null);
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
            setActiveApt(null);
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
                                // Try to get phone from client data
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

                    // Sort by start time
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

    // Fetch routes between consecutive appointments with coordinates
    useEffect(() => {
        if (appointments.length < 2) { setRoutes([]); return; }

        const geoApts = appointments.filter(a => a.lat && a.lon);
        if (geoApts.length < 2) { setRoutes([]); return; }

        let cancelled = false;
        const fetchRoutes = async () => {
            const newRoutes = [];
            for (let i = 0; i < geoApts.length - 1; i++) {
                const from = geoApts[i];
                const to = geoApts[i + 1];
                try {
                    const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
                    const resp = await fetch(url);
                    const data = await resp.json();
                    if (data.routes?.[0]) {
                        const route = data.routes[0];
                        newRoutes.push({
                            from: from.id,
                            to: to.id,
                            durationMin: route.duration / 60,
                            distanceKm: route.distance / 1000,
                            geometry: route.geometry,
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

    // Init and update map
    useEffect(() => {
        if (!mapRef.current) return;

        // Create map if not yet
        if (!mapInstanceRef.current) {
            mapInstanceRef.current = L.map(mapRef.current, {
                zoomControl: false,
                attributionControl: false,
            }).setView([46.6, 2.3], 6);

            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                maxZoom: 19,
            }).addTo(mapInstanceRef.current);

            L.control.zoom({ position: 'bottomright' }).addTo(mapInstanceRef.current);
        }

        const map = mapInstanceRef.current;

        // Clear previous layers
        map.eachLayer(layer => {
            if (!(layer instanceof L.TileLayer)) map.removeLayer(layer);
        });

        const geoApts = appointments.filter(a => a.lat && a.lon);
        if (geoApts.length === 0) return;

        // Add markers
        const bounds = [];
        geoApts.forEach((apt, i) => {
            bounds.push([apt.lat, apt.lon]);
            const startStr = `${pad2(apt.start.getHours())}:${pad2(apt.start.getMinutes())}`;

            // Custom numbered marker
            const icon = L.divIcon({
                className: 'myday-marker',
                html: `<div class="myday-marker__circle">${i + 1}</div>`,
                iconSize: [36, 36],
                iconAnchor: [18, 18],
            });

            const marker = L.marker([apt.lat, apt.lon], { icon }).addTo(map);
            marker.on('click', () => setActiveApt(apt));
        });

        // Add route polylines
        routes.forEach(route => {
            if (route.geometry?.coordinates) {
                const latlngs = route.geometry.coordinates.map(c => [c[1], c[0]]);
                L.polyline(latlngs, {
                    color: '#6c5ce7',
                    weight: 3,
                    opacity: 0.7,
                    dashArray: '8, 8',
                }).addTo(map);
            }
        });

        // Fit bounds
        if (bounds.length > 0) {
            map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 });
        }

        // Invalidate size after render
        setTimeout(() => map.invalidateSize(), 200);
    }, [appointments, routes]);

    // Cleanup
    useEffect(() => {
        return () => {
            if (mapInstanceRef.current) {
                mapInstanceRef.current.remove();
                mapInstanceRef.current = null;
            }
        };
    }, []);

    const geoApts = appointments.filter(a => a.lat && a.lon);

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

                {/* Map */}
                <div className="myday__map-container">
                    <div ref={mapRef} className="myday__map" />

                    {loading && (
                        <div className="myday__loading">
                            <div className="myday__loading-spinner" />
                            Chargement de la journée...
                        </div>
                    )}

                    {!loading && appointments.length === 0 && (
                        <div className="myday__empty">
                            <span>📅</span>
                            <p>Aucun rendez-vous ce jour</p>
                        </div>
                    )}
                </div>

                {/* Appointment list with travel times */}
                <div className="myday__list">
                    {appointments.map((apt, i) => {
                        const startStr = `${pad2(apt.start.getHours())}:${pad2(apt.start.getMinutes())}`;
                        const endStr = `${pad2(apt.end.getHours())}:${pad2(apt.end.getMinutes())}`;
                        const isActive = activeApt?.id === apt.id;
                        const routeToNext = routes.find(r => r.from === apt.id);
                        const smsBody = encodeURIComponent(SMS_TEMPLATE);
                        const cleanPhone = apt.phone?.replace(/[\s.]/g, '') || '';

                        return (
                            <div key={apt.id || i}>
                                <div
                                    className={`myday__card ${isActive ? 'myday__card--active' : ''} ${!apt.lat ? 'myday__card--nomap' : ''}`}
                                    onClick={() => {
                                        setActiveApt(apt);
                                        if (apt.lat && apt.lon && mapInstanceRef.current) {
                                            mapInstanceRef.current.flyTo([apt.lat, apt.lon], 14, { duration: 0.8 });
                                        }
                                    }}
                                >
                                    <div className="myday__card-number">{i + 1}</div>
                                    <div className="myday__card-body">
                                        <div className="myday__card-time">{startStr} → {endStr}</div>
                                        <div className="myday__card-client">{apt.clientName || apt.objet || '(sans titre)'}</div>
                                        {apt.objet && apt.clientName && (
                                            <div className="myday__card-objet">{apt.objet}</div>
                                        )}
                                        {apt.address && (
                                            <div className="myday__card-address">📍 {apt.address}</div>
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

                                {/* Travel time badge between appointments */}
                                {routeToNext && (
                                    <div className="myday__travel">
                                        <div className="myday__travel-line" />
                                        <div className="myday__travel-badge">
                                            🚗 {formatDuration(routeToNext.durationMin)} · {routeToNext.distanceKm.toFixed(1)} km
                                        </div>
                                        <div className="myday__travel-line" />
                                    </div>
                                )}
                                {/* If no route but there's a next apt, show a simple separator */}
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
