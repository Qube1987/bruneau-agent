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
        // Handle both "YYYY-MM-DD HH:MM:SS" and ISO format
        return new Date(dateStr.replace(' ', 'T'));
    } catch { return null; }
}

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
                        console.log(`Agenda ${member?.name}: ${apts.length} RDV, sample:`, apts[0]);
                        apts.forEach(apt => {
                            // Extrabat returns objet/titre — map both
                            const title = apt.objet || apt.titre || apt.title || apt.label || '(sans titre)';
                            allApts.push({
                                ...apt,
                                _title: title,
                                _userCode: userCode,
                                _userName: member?.name || userCode,
                                _color: member?.color || '#6c5ce7',
                                _start: parseAptDate(apt.debut),
                                _end: parseAptDate(apt.fin),
                            });
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

    const goToPrev = () => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() - 7);
        setWeekStart(d);
    };

    const goToNext = () => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + 7);
        setWeekStart(d);
    };

    const goToToday = () => setWeekStart(getWeekStart(new Date()));

    // Group appointments by day — only show at start hour, not every hour
    const getAptsForDay = (day) => {
        return appointments
            .filter(apt => apt._start && isSameDay(apt._start, day))
            .sort((a, b) => a._start - b._start);
    };

    const today = new Date();

    return (
        <div className="agenda-panel">
            <button className="agenda-panel__header" onClick={() => setIsExpanded(!isExpanded)}>
                <div className="agenda-panel__header-left">
                    <span className="agenda-panel__icon">📅</span>
                    <span className="agenda-panel__title">Agendas</span>
                    {selectedUsers.length > 0 && !isExpanded && (
                        <span className="agenda-panel__badge">{selectedUsers.length}</span>
                    )}
                </div>
                <span className={`agenda-panel__chevron ${isExpanded ? 'agenda-panel__chevron--open' : ''}`}>▾</span>
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

                    {/* Calendar — simple list view per day */}
                    {selectedUsers.length === 0 ? (
                        <div className="agenda-panel__empty">
                            <span>📅</span>
                            <p>Cochez un ou plusieurs membres pour afficher leurs agendas</p>
                        </div>
                    ) : (
                        <div className="agenda-panel__week">
                            {weekDays.map((day, i) => {
                                const isToday = isSameDay(day, today);
                                const dayApts = getAptsForDay(day);
                                return (
                                    <div key={i} className={`agenda-panel__day ${isToday ? 'agenda-panel__day--today' : ''}`}>
                                        <div className="agenda-panel__day-header">
                                            <span className="agenda-panel__day-name">{DAYS_FR[day.getDay()]}</span>
                                            <span className="agenda-panel__day-num">{day.getDate()}</span>
                                        </div>
                                        <div className="agenda-panel__day-list">
                                            {dayApts.length === 0 ? (
                                                <div className="agenda-panel__no-apt">—</div>
                                            ) : (
                                                dayApts.map((apt, ai) => {
                                                    const startH = apt._start ? `${String(apt._start.getHours()).padStart(2, '0')}:${String(apt._start.getMinutes()).padStart(2, '0')}` : '';
                                                    const endH = apt._end ? `${String(apt._end.getHours()).padStart(2, '0')}:${String(apt._end.getMinutes()).padStart(2, '0')}` : '';
                                                    return (
                                                        <div
                                                            key={apt.id || ai}
                                                            className="agenda-panel__apt"
                                                            style={{ borderLeftColor: apt._color, background: `${apt._color}15` }}
                                                            title={`${apt._title}\n${apt._userName}\n${startH} → ${endH}`}
                                                        >
                                                            <div className="agenda-panel__apt-time">{startH} - {endH}</div>
                                                            <div className="agenda-panel__apt-title">{apt._title}</div>
                                                            {selectedUsers.length > 1 && (
                                                                <div className="agenda-panel__apt-user" style={{ color: apt._color }}>{apt._userName}</div>
                                                            )}
                                                        </div>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
