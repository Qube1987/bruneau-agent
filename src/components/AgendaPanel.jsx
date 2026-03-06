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
            const { data: { session } } = await supabase.auth.getSession();
            const token = session?.access_token || SUPABASE_ANON;

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
                        const apts = Array.isArray(resp.data.data) ? resp.data.data : Object.values(resp.data.data);
                        apts.forEach(apt => {
                            allApts.push({ ...apt, _userCode: userCode, _userName: member?.name || userCode, _color: member?.color || '#6c5ce7' });
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

    const getAptsForDayAndHour = (day, hour) => {
        return appointments.filter(apt => {
            try {
                const start = new Date(apt.debut.replace(' ', 'T'));
                const end = new Date(apt.fin.replace(' ', 'T'));
                if (!isSameDay(start, day)) return false;
                const startH = start.getHours();
                const endH = end.getHours() + (end.getMinutes() > 0 ? 1 : 0);
                return startH <= hour && hour < endH;
            } catch { return false; }
        });
    };

    const getAptsForDay = (day) => {
        return appointments.filter(apt => {
            try {
                const start = new Date(apt.debut.replace(' ', 'T'));
                return isSameDay(start, day);
            } catch { return false; }
        }).sort((a, b) => new Date(a.debut.replace(' ', 'T')) - new Date(b.debut.replace(' ', 'T')));
    };

    const timeSlots = Array.from({ length: 11 }, (_, i) => i + 7); // 7h → 17h

    const today = new Date();

    return (
        <div className="agenda-panel">
            <button className="agenda-panel__header" onClick={() => setIsExpanded(!isExpanded)}>
                <div className="agenda-panel__header-left">
                    <span className="agenda-panel__icon">📅</span>
                    <span className="agenda-panel__title">Agendas</span>
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

                    {/* Calendar grid */}
                    {selectedUsers.length === 0 ? (
                        <div className="agenda-panel__empty">
                            <span>📅</span>
                            <p>Cochez un ou plusieurs membres pour afficher leurs agendas</p>
                        </div>
                    ) : (
                        <div className="agenda-panel__grid-wrapper">
                            <div className="agenda-panel__grid">
                                {/* Header row */}
                                <div className="agenda-panel__grid-header agenda-panel__grid-time" />
                                {weekDays.map((day, i) => {
                                    const isToday = isSameDay(day, today);
                                    return (
                                        <div key={i} className={`agenda-panel__grid-header ${isToday ? 'agenda-panel__grid-header--today' : ''}`}>
                                            <span className="agenda-panel__day-name">{DAYS_FR[day.getDay()]}</span>
                                            <span className="agenda-panel__day-num">{day.getDate()}</span>
                                        </div>
                                    );
                                })}

                                {/* Time rows */}
                                {timeSlots.map(hour => (
                                    <>
                                        <div key={`t-${hour}`} className="agenda-panel__grid-time">
                                            {hour}:00
                                        </div>
                                        {weekDays.map((day, di) => {
                                            const apts = getAptsForDayAndHour(day, hour);
                                            const isToday = isSameDay(day, today);
                                            return (
                                                <div key={`${hour}-${di}`} className={`agenda-panel__grid-cell ${isToday ? 'agenda-panel__grid-cell--today' : ''}`}>
                                                    {apts.map((apt, ai) => (
                                                        <div
                                                            key={ai}
                                                            className="agenda-panel__apt"
                                                            style={{ borderLeftColor: apt._color, background: `${apt._color}18` }}
                                                            title={`${apt.objet}\n${apt._userName}\n${apt.debut} → ${apt.fin}`}
                                                        >
                                                            <span className="agenda-panel__apt-time">
                                                                {new Date(apt.debut.replace(' ', 'T')).getHours()}:{String(new Date(apt.debut.replace(' ', 'T')).getMinutes()).padStart(2, '0')}
                                                            </span>
                                                            <span className="agenda-panel__apt-title">{apt.objet}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            );
                                        })}
                                    </>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
