import { useState } from 'react';
import { supabase } from '../lib/supabase';


function AddressLink({ address }) {
    if (!address) return null;
    const geoUrl = `geo:0,0?q=${encodeURIComponent(address)}`;
    return (
        <a href={geoUrl} className="linkable linkable--address" onClick={e => e.stopPropagation()}>
            📍 {address}
        </a>
    );
}

function PhoneLink({ phone, senderName }) {
    if (!phone) return null;
    const cleaned = phone.replace(/[\s.]/g, '');
    const smsText = `Bonjour, je suis en route et serai chez vous dans XX min.\nCordialement,\n${senderName || 'Bruneau Protection'}`;
    const smsBody = encodeURIComponent(smsText);
    return (
        <span className="linkable-group" onClick={e => e.stopPropagation()}>
            <a href={`tel:${cleaned}`} className="linkable linkable--phone">
                📞 {phone}
            </a>
            <a href={`sms:${cleaned}?body=${smsBody}`} className="linkable linkable--sms" title="Envoyer un SMS">
                ✉️
            </a>
        </span>
    );
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatTime(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function isOverdue(task) {
    if (!task.due_date || task.status === 'done') return false;
    return new Date(task.due_date) < new Date(new Date().toDateString());
}

function isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getDate() === d2.getDate();
}

export default function MyDayPanel({ visible, onClose, allApts, tasks, userCode, userName }) {
    const [dayOffset, setDayOffset] = useState(0);

    if (!visible) return null;

    const now = new Date();
    const selectedDate = new Date(now);
    selectedDate.setDate(selectedDate.getDate() + dayOffset);
    const selectedDateStr = selectedDate.toDateString();
    const isToday = dayOffset === 0;

    // Filter appointments for the selected day AND the connected user
    const dayApts = allApts
        .filter(a => {
            const sameDay = a._start.toDateString() === selectedDateStr;
            // Filter by user's extrabat code if provided
            if (userCode && a._userCode) {
                return sameDay && String(a._userCode) === String(userCode);
            }
            return sameDay;
        })
        .sort((a, b) => a._start - b._start);

    // Find upcoming (next) appointment — only relevant for today
    const upcomingApt = isToday ? dayApts.find(a => a._start > now) : dayApts[0];

    // Tasks due on selected day
    const dayTasks = tasks.filter(t => t.status !== 'done' && t.due_date && isSameDay(new Date(t.due_date), selectedDate));
    const overdueTasks = isToday ? tasks.filter(t => isOverdue(t)) : [];

    // Greeting based on time of day (only for today)
    const hour = now.getHours();
    const greeting = isToday
        ? (hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir')
        + (userName ? ` ${userName}` : '')
        : dayOffset === 1 ? 'Demain' : dayOffset === -1 ? 'Hier' : '';

    const dayName = selectedDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

    // Toggle task completion
    const toggleTask = async (task) => {
        const newStatus = task.status === 'done' ? 'pending' : 'done';
        await supabase.from('tasks').update({
            status: newStatus,
            completed_at: newStatus === 'done' ? new Date().toISOString() : null,
        }).eq('id', task.id);
    };

    const goToday = () => setDayOffset(0);

    return (
        <div className="myday-overlay" onClick={onClose}>
            <div className="myday-sheet" onClick={e => e.stopPropagation()}>
                {/* Header with day navigation */}
                <div className="myday-header">
                    <div style={{ flex: 1 }}>
                        {greeting && <div className="myday-greeting">{greeting} 👋</div>}
                        <div className="myday-nav">
                            <button className="myday-nav__btn" onClick={() => setDayOffset(d => d - 1)} title="Jour précédent">◀</button>
                            <span className="myday-date">{dayName}</span>
                            <button className="myday-nav__btn" onClick={() => setDayOffset(d => d + 1)} title="Jour suivant">▶</button>
                            {!isToday && (
                                <button className="myday-nav__today" onClick={goToday}>Aujourd'hui</button>
                            )}
                        </div>
                    </div>
                    <button className="myday-close" onClick={onClose}>✕</button>
                </div>

                {/* Stats strip */}
                <div className="myday-stats">
                    <div className="myday-stat">
                        <span className="myday-stat__num">{dayApts.length}</span>
                        <span className="myday-stat__label">RDV</span>
                    </div>
                    <div className="myday-stat">
                        <span className="myday-stat__num">{dayTasks.length + overdueTasks.length}</span>
                        <span className="myday-stat__label">Tâches</span>
                    </div>
                    {overdueTasks.length > 0 && (
                        <div className="myday-stat myday-stat--danger">
                            <span className="myday-stat__num">{overdueTasks.length}</span>
                            <span className="myday-stat__label">En retard</span>
                        </div>
                    )}
                </div>

                <div className="myday-body">
                    {/* Next appointment highlight */}
                    {upcomingApt && (
                        <div className="myday-next">
                            <div className="myday-section-title">{isToday ? '⏰ Prochain RDV' : '📌 Premier RDV'}</div>
                            <div className="myday-next__card" style={{ borderLeftColor: upcomingApt._color }}>
                                <div className="myday-next__time">{formatTime(upcomingApt._start)} → {formatTime(upcomingApt._end)}</div>
                                <div className="myday-next__title">{upcomingApt._clientName || upcomingApt._objet}</div>
                                {upcomingApt._clientName && upcomingApt._objet && (
                                    <div className="myday-next__objet">{upcomingApt._objet}</div>
                                )}
                                <div className="myday-next__links">
                                    <AddressLink address={upcomingApt._address} />
                                    <PhoneLink phone={upcomingApt._phone} senderName={userName} />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Day's timeline */}
                    {dayApts.length > 0 && (
                        <div className="myday-section">
                            <div className="myday-section-title">📅 Planning du jour</div>
                            <div className="myday-timeline">
                                {dayApts.map((apt, i) => {
                                    const isPast = isToday && apt._end < now;
                                    const isCurrent = isToday && apt._start <= now && apt._end >= now;
                                    return (
                                        <div key={apt.id || i} className={`myday-apt ${isPast ? 'myday-apt--past' : ''} ${isCurrent ? 'myday-apt--current' : ''}`}>
                                            <div className="myday-apt__time-col">
                                                <span className="myday-apt__time">{formatTime(apt._start)}</span>
                                                <div className="myday-apt__line" style={{ background: apt._color }} />
                                            </div>
                                            <div className="myday-apt__info">
                                                <div className="myday-apt__title">
                                                    {apt._clientName || apt._objet}
                                                    {isCurrent && <span className="myday-apt__live">EN COURS</span>}
                                                </div>
                                                {apt._clientName && apt._objet && (
                                                    <div className="myday-apt__desc">{apt._objet}</div>
                                                )}
                                                <div className="myday-apt__links">
                                                    <AddressLink address={apt._address} />
                                                    <PhoneLink phone={apt._phone} senderName={userName} />
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Overdue tasks (only on today) */}
                    {overdueTasks.length > 0 && (
                        <div className="myday-section">
                            <div className="myday-section-title myday-section-title--danger">🔥 En retard</div>
                            {overdueTasks.map(task => (
                                <div key={task.id} className="myday-task myday-task--overdue">
                                    <button className="todo-checkbox" onClick={() => toggleTask(task)} style={{ borderColor: '#ff6b6b' }} />
                                    <div className="myday-task__title">{task.title}</div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Day's tasks */}
                    {dayTasks.length > 0 && (
                        <div className="myday-section">
                            <div className="myday-section-title">✅ Tâches du jour</div>
                            {dayTasks.map(task => (
                                <div key={task.id} className="myday-task">
                                    <button className="todo-checkbox" onClick={() => toggleTask(task)} style={{ borderColor: '#6c5ce7' }} />
                                    <div className="myday-task__title">{task.title}</div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Empty state */}
                    {dayApts.length === 0 && dayTasks.length === 0 && overdueTasks.length === 0 && (
                        <div className="myday-empty">
                            <span>🌤️</span>
                            <p>Journée libre ! Profitez-en ou ajoutez des tâches.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
