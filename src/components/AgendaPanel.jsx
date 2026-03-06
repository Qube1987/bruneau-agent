import { useState, useEffect, useCallback } from 'react';
import { supabase, SUPABASE_ANON } from '../lib/supabase';

const TEAM_MEMBERS = [
    { name: 'Quentin', code: '46516', color: '#6c5ce7' },
    { name: 'Paul', code: '218599', color: '#00cec9' },
    { name: 'Cindy', code: '47191', color: '#fdcb6e' },
    { name: 'Téo', code: '485533', color: '#ff6b6b' },
];

const DAYS_FR = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const HOUR_START = 7;
const HOUR_END = 19;
const HOUR_HEIGHT = 40; // px per hour
const TOTAL_HOURS = HOUR_END - HOUR_START;

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function formatDateYMD(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getDate() === d2.getDate();
}

function parseAptDate(dateStr) {
    if (!dateStr) return null;
    try {
        return new Date(dateStr.replace(' ', 'T'));
    } catch { return null; }
}

function pad2(n) { return String(n).padStart(2, '0'); }

export default function AgendaPanel() {
    const [isExpanded, setIsExpanded] = useState(false);
    const [selectedUsers, setSelectedUsers] = useState([]);
    const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
    const [appointments, setAppointments] = useState([]);
    const [loading, setLoading] = useState(false);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 4);

    const weekDays = [];
    for (let i = 0; i < 5; i++) {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        weekDays.push(d);
    }

    const toggleUser = (code) => {
        setSelectedUsers(prev =>
            prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]
        );
    };

    const fetchAppointments = useCallback(async () => {
        if (selectedUsers.length === 0) {
            setAppointments([]);
            return;
        }
        setLoading(true);
        try {
            const allApts = [];
            for (const userCode of selectedUsers) {
                const member = TEAM_MEMBERS.find(m => m.code === userCode);
                try {
                    const resp = await supabase.functions.invoke('extrabat-proxy', {
                        body: {
                            endpoint: `utilisateur/${userCode}/rendez-vous`,
                            apiVersion: 'v1',
                            params: {
                                date_debut: formatDateYMD(weekStart),
                                date_fin: formatDateYMD(weekEnd),
                                include: 'client',
                            },
                        },
                    });

                    if (resp.data?.success && resp.data.data) {
                        const raw = resp.data.data;
                        const apts = Array.isArray(raw) ? raw : Object.values(raw);
                        apts.forEach(apt => {
                            const objet = apt.objet || apt.titre || apt.title || apt.label || '';
                            // Try to extract client name from various Extrabat fields
                            let clientName = '';
                            if (apt.rdvClients?.[0]?.nom) clientName = apt.rdvClients[0].nom;
                            else if (apt.client_nom) clientName = apt.client_nom;
                            else if (apt.client?.nom) clientName = apt.client.nom;
                            else if (apt.nom_client) clientName = apt.nom_client;
                            // If no client name found, try to parse from objet ("SAV - ClientName" pattern)
                            else if (objet.includes(' - ')) clientName = objet.split(' - ')[0].trim();

                            const start = parseAptDate(apt.debut);
                            const end = parseAptDate(apt.fin);
                            if (start && end) {
                                allApts.push({
                                    ...apt,
                                    _clientName: clientName,
                                    _objet: objet,
                                    _title: clientName || objet || '(sans titre)',
                                    _userCode: userCode,
                                    _userName: member?.name || userCode,
                                    _color: member?.color || '#6c5ce7',
                                    _start: start,
                                    _end: end,
                                });
                            }
                        });
                    }
                } catch (e) {
                    console.error(`Error fetching agenda for ${userCode}:`, e);
                }
            }
            setAppointments(allApts);
        } catch (e) {
            console.error('Error fetching appointments:', e);
        } finally {
            setLoading(false);
        }
    }, [selectedUsers, weekStart]);

    useEffect(() => {
        if (isExpanded && selectedUsers.length > 0) {
            fetchAppointments();
        }
    }, [isExpanded, selectedUsers, weekStart, fetchAppointments]);

    const goToPrev = () => { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d); };
    const goToNext = () => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d); };
    const goToToday = () => setWeekStart(getWeekStart(new Date()));

    const getAptsForDay = (day) => {
        return appointments
            .filter(apt => apt._start && isSameDay(apt._start, day))
            .sort((a, b) => a._start - b._start);
    };

    // Calculate position and height of an appointment block
    const getAptStyle = (apt) => {
        const startHours = apt._start.getHours() + apt._start.getMinutes() / 60;
        const endHours = apt._end.getHours() + apt._end.getMinutes() / 60;
        const top = Math.max(0, (startHours - HOUR_START)) * HOUR_HEIGHT;
        const height = Math.max(HOUR_HEIGHT * 0.4, (endHours - startHours) * HOUR_HEIGHT);
        return { top: `${top}px`, height: `${height}px` };
    };

    // Detect overlapping appointments and assign columns
    const layoutAptsForDay = (dayApts) => {
        if (dayApts.length === 0) return [];

        const laid = dayApts.map(apt => ({
            apt,
            col: 0,
            totalCols: 1,
        }));

        // Simple greedy column assignment
        for (let i = 0; i < laid.length; i++) {
            const usedCols = new Set();
            for (let j = 0; j < i; j++) {
                // Check overlap
                if (laid[j].apt._start < laid[i].apt._end && laid[j].apt._end > laid[i].apt._start) {
                    usedCols.add(laid[j].col);
                }
            }
            let col = 0;
            while (usedCols.has(col)) col++;
            laid[i].col = col;
        }

        // Compute max overlapping columns for each group
        for (let i = 0; i < laid.length; i++) {
            let maxCol = laid[i].col;
            for (let j = 0; j < laid.length; j++) {
                if (i !== j && laid[j].apt._start < laid[i].apt._end && laid[j].apt._end > laid[i].apt._start) {
                    maxCol = Math.max(maxCol, laid[j].col);
                }
            }
            laid[i].totalCols = maxCol + 1;
        }

        return laid;
    };

    const today = new Date();
    const timeLabels = Array.from({ length: TOTAL_HOURS }, (_, i) => HOUR_START + i);

    return (
        <div className={`agenda-panel ${isExpanded ? 'agenda-panel--expanded' : ''}`}>
            <button className="agenda-panel__toggle" onClick={() => setIsExpanded(!isExpanded)}>
                <span>Agenda</span>
                <span className={`agenda-panel__arrow ${isExpanded ? 'agenda-panel__arrow--open' : ''}`}>▾</span>
                {selectedUsers.length > 0 && !isExpanded && (
                    <span className="agenda-panel__badge">{selectedUsers.length}</span>
                )}
            </button>

            {isExpanded && (
                <div className="agenda-panel__content">
                    {/* Navigation */}
                    <div className="agenda-panel__nav">
                        <button className="agenda-panel__nav-btn" onClick={goToPrev}>◀</button>
                        <button className="agenda-panel__nav-btn agenda-panel__nav-btn--today" onClick={goToToday}>Aujourd'hui</button>
                        <button className="agenda-panel__nav-btn" onClick={goToNext}>▶</button>
                        <span className="agenda-panel__date-range">
                            {weekStart.getDate()} {MONTHS_FR[weekStart.getMonth()]} — {weekEnd.getDate()} {MONTHS_FR[weekEnd.getMonth()]} {weekEnd.getFullYear()}
                        </span>
                        {loading && <span className="agenda-panel__loader">⟳</span>}
                    </div>

                    {/* User checkboxes */}
                    <div className="agenda-panel__users">
                        {TEAM_MEMBERS.map(member => (
                            <label key={member.code} className="agenda-panel__user-label">
                                <input
                                    type="checkbox"
                                    checked={selectedUsers.includes(member.code)}
                                    onChange={() => toggleUser(member.code)}
                                    className="agenda-panel__checkbox"
                                />
                                <span className="agenda-panel__user-dot" style={{ background: member.color }} />
                                <span className="agenda-panel__user-name">{member.name}</span>
                            </label>
                        ))}
                    </div>

                    {/* Timeline Calendar */}
                    {selectedUsers.length === 0 ? (
                        <div className="agenda-panel__empty">
                            <span>📅</span>
                            <p>Cochez un ou plusieurs membres pour afficher leurs agendas</p>
                        </div>
                    ) : (
                        <div className="agenda-timeline">
                            <div className="agenda-timeline__grid">
                                {/* Time gutter */}
                                <div className="agenda-timeline__gutter">
                                    <div className="agenda-timeline__gutter-header" />
                                    <div className="agenda-timeline__gutter-body" style={{ height: `${TOTAL_HOURS * HOUR_HEIGHT}px` }}>
                                        {timeLabels.map(h => (
                                            <div key={h} className="agenda-timeline__time-label" style={{ top: `${(h - HOUR_START) * HOUR_HEIGHT}px` }}>
                                                {h}:00
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Day columns */}
                                {weekDays.map((day, di) => {
                                    const isToday = isSameDay(day, today);
                                    const dayApts = getAptsForDay(day);
                                    const laidOut = layoutAptsForDay(dayApts);

                                    // Current time indicator
                                    let nowIndicatorTop = null;
                                    if (isToday) {
                                        const nowH = today.getHours() + today.getMinutes() / 60;
                                        if (nowH >= HOUR_START && nowH <= HOUR_END) {
                                            nowIndicatorTop = (nowH - HOUR_START) * HOUR_HEIGHT;
                                        }
                                    }

                                    return (
                                        <div key={di} className={`agenda-timeline__day ${isToday ? 'agenda-timeline__day--today' : ''}`}>
                                            <div className={`agenda-timeline__day-header ${isToday ? 'agenda-timeline__day-header--today' : ''}`}>
                                                <span className="agenda-timeline__day-name">{DAYS_FR[day.getDay()]}</span>
                                                <span className={`agenda-timeline__day-num ${isToday ? 'agenda-timeline__day-num--today' : ''}`}>{day.getDate()}</span>
                                            </div>
                                            <div className="agenda-timeline__day-body" style={{ height: `${TOTAL_HOURS * HOUR_HEIGHT}px` }}>
                                                {/* Hour grid lines */}
                                                {timeLabels.map(h => (
                                                    <div key={h} className="agenda-timeline__hour-line" style={{ top: `${(h - HOUR_START) * HOUR_HEIGHT}px` }} />
                                                ))}

                                                {/* Current time red line */}
                                                {nowIndicatorTop !== null && (
                                                    <div className="agenda-timeline__now-line" style={{ top: `${nowIndicatorTop}px` }}>
                                                        <div className="agenda-timeline__now-dot" />
                                                    </div>
                                                )}

                                                {/* Appointment blocks */}
                                                {laidOut.map(({ apt, col, totalCols }, ai) => {
                                                    const style = getAptStyle(apt);
                                                    const widthPct = 100 / totalCols;
                                                    const leftPct = col * widthPct;
                                                    const startStr = `${pad2(apt._start.getHours())}:${pad2(apt._start.getMinutes())}`;
                                                    const endStr = `${pad2(apt._end.getHours())}:${pad2(apt._end.getMinutes())}`;
                                                    return (
                                                        <div
                                                            key={apt.id || ai}
                                                            className="agenda-timeline__apt"
                                                            style={{
                                                                top: style.top,
                                                                height: style.height,
                                                                left: `${leftPct}%`,
                                                                width: `${widthPct - 2}%`,
                                                                background: `${apt._color}25`,
                                                                borderLeftColor: apt._color,
                                                            }}
                                                            title={`${apt._clientName ? apt._clientName + '\n' : ''}${apt._objet}\n${apt._userName}\n${startStr} → ${endStr}`}
                                                        >
                                                            <div className="agenda-timeline__apt-time">{startStr}</div>
                                                            {apt._clientName && <div className="agenda-timeline__apt-client">{apt._clientName}</div>}
                                                            <div className="agenda-timeline__apt-title">{apt._objet}</div>
                                                            {selectedUsers.length > 1 && (
                                                                <div className="agenda-timeline__apt-user" style={{ color: apt._color }}>{apt._userName}</div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
