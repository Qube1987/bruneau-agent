import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { useWeather } from '../hooks/useWeather';
import {
    isSameDay, formatTime, findFreeSlots, formatSlotTime,
    generateBriefing, computeTravelTimes,
} from '../utils/agendaUtils';

function AddressLink({ address }) {
    if (!address) return null;
    const geoUrl = `geo:0,0?q=${encodeURIComponent(address)}`;
    return (
        <a href={geoUrl} className="linkable linkable--address" onClick={e => e.stopPropagation()}>
            {'\u{1F4CD}'} {address}
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
            <a href={`tel:${cleaned}`} className="linkable linkable--phone">{'\u{1F4DE}'} {phone}</a>
            <a href={`sms:${cleaned}?body=${smsBody}`} className="linkable linkable--sms" title="SMS">{'\u2709'}</a>
        </span>
    );
}

function isOverdue(task) {
    if (!task.due_date || task.status === 'done') return false;
    return new Date(task.due_date) < new Date(new Date().toDateString());
}

export default function MyDayPanel({ visible, onClose, allApts, tasks, setTasks, userCode, userName }) {
    const [dayOffset, setDayOffset] = useState(0);
    const [travelTimes, setTravelTimes] = useState([]);
    const { weather } = useWeather();

    const now = new Date();
    const selectedDate = new Date(now);
    selectedDate.setDate(selectedDate.getDate() + dayOffset);
    const selectedDateStr = selectedDate.toDateString();
    const isToday = dayOffset === 0;

    // Filter appointments
    const dayApts = allApts
        .filter(a => {
            const sameDay = a._start.toDateString() === selectedDateStr;
            if (userCode && a._userCode) return sameDay && String(a._userCode) === String(userCode);
            return sameDay;
        })
        .sort((a, b) => a._start - b._start);

    // Compute travel times
    useEffect(() => {
        if (!visible || dayApts.length < 2) {
            setTravelTimes([]);
            return;
        }
        computeTravelTimes(dayApts).then(setTravelTimes).catch(() => setTravelTimes([]));
    }, [visible, dayOffset, allApts]);



    // Free slots
    const freeSlots = findFreeSlots(dayApts, 8, 18, 60);

    const upcomingApt = isToday ? dayApts.find(a => a._start > now) : dayApts[0];
    const currentApt = isToday ? dayApts.find(a => a._start <= now && a._end >= now) : null;

    // Tasks
    const todayStr = new Date().toISOString().split('T')[0];
    const dayTasks = tasks.filter(t => {
        if (t.status === 'done') return false;
        const dueMatch = t.due_date && isSameDay(new Date(t.due_date), selectedDate);
        const myDayMatch = isToday && t.my_day_date === todayStr;
        return dueMatch || myDayMatch;
    });
    const dayTaskIds = new Set();
    const uniqueDayTasks = dayTasks.filter(t => {
        if (dayTaskIds.has(t.id)) return false;
        dayTaskIds.add(t.id);
        return true;
    });
    const overdueTasks = isToday ? tasks.filter(t => isOverdue(t)) : [];

    // Greeting + briefing
    const hour = now.getHours();
    const greeting = isToday
        ? (hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon aprem' : 'Bonsoir')
        + (userName ? ` ${userName}` : '')
        : dayOffset === 1 ? 'Demain' : dayOffset === -1 ? 'Hier' : '';

    const dayName = selectedDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

    // Briefing text (for today)
    const briefingText = isToday ? generateBriefing(dayApts, tasks, userName, weather?.today) : null;

    const toggleTask = async (task) => {
        const newStatus = task.status === 'done' ? 'pending' : 'done';
        const completedAt = newStatus === 'done' ? new Date().toISOString() : null;
        if (setTasks) {
            setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: newStatus, completed_at: completedAt } : t));
        }
        await supabase.from('tasks').update({ status: newStatus, completed_at: completedAt }).eq('id', task.id);
    };

    const goToday = () => setDayOffset(0);

    if (!visible) return null;

    return (
        <div className="myday-overlay" onClick={onClose}>
            <div className="myday-sheet" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="myday-header">
                    <div style={{ flex: 1 }}>
                        {greeting && <div className="myday-greeting">{greeting} {'\u{1F44B}'}</div>}
                        <div className="myday-nav">
                            <button className="myday-nav__btn" onClick={() => setDayOffset(d => d - 1)}>{'\u25C0'}</button>
                            <span className="myday-date">{dayName}</span>
                            <button className="myday-nav__btn" onClick={() => setDayOffset(d => d + 1)}>{'\u25B6'}</button>
                            {!isToday && <button className="myday-nav__today" onClick={goToday}>Aujourd'hui</button>}
                        </div>
                    </div>
                    <button className="myday-close" onClick={onClose}>{'\u2715'}</button>
                </div>

                <div className="myday-scroll">
                    {/* Weather bar */}
                    {weather?.today && isToday && (
                        <div className="myday-weather">
                            <span className="myday-weather__icon">{weather.today.icon}</span>
                            <span className="myday-weather__temp">{weather.today.temp}°C</span>
                            <span className="myday-weather__desc">{weather.today.description}</span>
                            {weather.today.wind > 20 && <span className="myday-weather__wind">{'\u{1F4A8}'} {weather.today.wind} km/h</span>}
                        </div>
                    )}

                    {/* Stats strip */}
                    <div className="myday-stats">
                        <div className="myday-stat">
                            <span className="myday-stat__num">{dayApts.length}</span>
                            <span className="myday-stat__label">RDV</span>
                        </div>
                        <div className="myday-stat">
                            <span className="myday-stat__num">{uniqueDayTasks.length + overdueTasks.length}</span>
                            <span className="myday-stat__label">Tâches</span>
                        </div>
                        {overdueTasks.length > 0 && (
                            <div className="myday-stat myday-stat--danger">
                                <span className="myday-stat__num">{overdueTasks.length}</span>
                                <span className="myday-stat__label">En retard</span>
                            </div>
                        )}

                    </div>

                    {/* Briefing (today only) */}
                    {briefingText && (
                        <div className="myday-briefing">
                            <div className="myday-briefing__label">{'\u{1F916}'} Briefing</div>
                            <div className="myday-briefing__text">{briefingText}</div>
                        </div>
                    )}

                    <div className="myday-body">


                        {/* Next appointment highlight */}
                        {(currentApt || upcomingApt) && (
                            <div className="myday-next">
                                <div className="myday-section-title">
                                    {currentApt ? '\u{23F0} En cours' : isToday ? '\u{23F0} Prochain RDV' : '\u{1F4CC} Premier RDV'}
                                </div>
                                <div className="myday-next__card" style={{ borderLeftColor: (currentApt || upcomingApt)._color }}>
                                    <div className="myday-next__time">{formatTime((currentApt || upcomingApt)._start)} → {formatTime((currentApt || upcomingApt)._end)}</div>
                                    <div className="myday-next__title">{(currentApt || upcomingApt)._clientName || (currentApt || upcomingApt)._objet}</div>
                                    {(currentApt || upcomingApt)._clientName && (currentApt || upcomingApt)._objet && (
                                        <div className="myday-next__objet">{(currentApt || upcomingApt)._objet}</div>
                                    )}
                                    <div className="myday-next__links">
                                        <AddressLink address={(currentApt || upcomingApt)._address} />
                                        <PhoneLink phone={(currentApt || upcomingApt)._phone} senderName={userName} />
                                    </div>
                                    {/* Travel time to next */}
                                    {!currentApt && upcomingApt && travelTimes.find(t => t.toApt?.id === upcomingApt.id) && (() => {
                                        const travel = travelTimes.find(t => t.toApt?.id === upcomingApt.id);
                                        return (
                                            <div className={`myday-next__travel ${travel.tight ? 'myday-next__travel--tight' : ''}`}>
                                                {'\u{1F697}'} {travel.minutes} min de trajet ({travel.km} km)
                                                {travel.tight && <span> — Temps serré !</span>}
                                            </div>
                                        );
                                    })()}
                                </div>
                            </div>
                        )}

                        {/* Timeline */}
                        {dayApts.length > 0 && (
                            <div className="myday-section">
                                <div className="myday-section-title">{'\u{1F4C5}'} Planning du jour</div>
                                <div className="myday-timeline">
                                    {dayApts.map((apt, i) => {
                                        const isPast = isToday && apt._end < now;
                                        const isCurrent = isToday && apt._start <= now && apt._end >= now;
                                        const travel = travelTimes.find(t => t.toApt?.id === apt.id);
                                        return (
                                            <div key={apt.id || i}>
                                                {/* Travel indicator between appointments */}
                                                {travel && (
                                                    <div className={`myday-travel ${travel.tight ? 'myday-travel--tight' : ''}`}>
                                                        <span className="myday-travel__icon">{'\u{1F697}'}</span>
                                                        <span>{travel.minutes} min ({travel.km} km)</span>
                                                        {travel.tight && <span className="myday-travel__warn">{'\u26A0'} serré</span>}
                                                    </div>
                                                )}
                                                <div className={`myday-apt ${isPast ? 'myday-apt--past' : ''} ${isCurrent ? 'myday-apt--current' : ''}`}>
                                                    <div className="myday-apt__time-col">
                                                        <span className="myday-apt__time">{formatTime(apt._start)}</span>
                                                        <div className="myday-apt__line" style={{ background: apt._color }} />
                                                    </div>
                                                    <div className="myday-apt__info">
                                                        <div className="myday-apt__title">
                                                            {apt._clientName || apt._objet}
                                                            {isCurrent && <span className="myday-apt__live">EN COURS</span>}
                                                        </div>
                                                        {apt._clientName && apt._objet && <div className="myday-apt__desc">{apt._objet}</div>}
                                                        <div className="myday-apt__links">
                                                            <AddressLink address={apt._address} />
                                                            <PhoneLink phone={apt._phone} senderName={userName} />
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Free slots */}
                        {freeSlots.length > 0 && dayApts.length > 0 && (
                            <div className="myday-section">
                                <div className="myday-section-title">{'\u{1F4A1}'} Créneaux libres</div>
                                <div className="myday-freeslots">
                                    {freeSlots.map((slot, i) => (
                                        <div key={i} className="myday-freeslot">
                                            <span className="myday-freeslot__time">{formatSlotTime(slot.start)} - {formatSlotTime(slot.end)}</span>
                                            <span className="myday-freeslot__dur">{Math.floor(slot.minutes / 60)}h{slot.minutes % 60 > 0 ? String(slot.minutes % 60).padStart(2, '0') : ''}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Overdue tasks */}
                        {overdueTasks.length > 0 && (
                            <div className="myday-section">
                                <div className="myday-section-title myday-section-title--danger">{'\u{1F525}'} En retard</div>
                                {overdueTasks.map(task => (
                                    <div key={task.id} className="myday-task myday-task--overdue">
                                        <button className="todo-checkbox" onClick={() => toggleTask(task)} style={{ borderColor: '#ff6b6b' }} />
                                        <div className="myday-task__title">{task.title}</div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Day's tasks */}
                        {uniqueDayTasks.length > 0 && (
                            <div className="myday-section">
                                <div className="myday-section-title">{'\u2705'} Tâches du jour</div>
                                {uniqueDayTasks.map(task => (
                                    <div key={task.id} className="myday-task">
                                        <button className="todo-checkbox" onClick={() => toggleTask(task)} style={{ borderColor: '#6c5ce7' }} />
                                        <div className="myday-task__title">{task.title}</div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* 5-day forecast */}
                        {weather?.forecast && weather.forecast.length > 0 && (
                            <div className="myday-section">
                                <div className="myday-section-title">{'\u{1F324}'} Prévisions</div>
                                <div className="myday-forecast">
                                    {weather.forecast.map((day, i) => {
                                        const d = new Date(day.date + 'T12:00:00');
                                        const dayName = d.toLocaleDateString('fr-FR', { weekday: 'short' });
                                        return (
                                            <div key={i} className="myday-forecast__day">
                                                <span className="myday-forecast__name">{dayName}</span>
                                                <span className="myday-forecast__icon">{day.icon}</span>
                                                <span className="myday-forecast__temp">{day.tempMax}°/{day.tempMin}°</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Empty state */}
                        {dayApts.length === 0 && uniqueDayTasks.length === 0 && overdueTasks.length === 0 && (
                            <div className="myday-empty">
                                <span>{'\u{1F324}'}</span>
                                <p>Journée libre ! Profitez-en ou ajoutez des tâches.</p>
                            </div>
                        )}
                    </div>
                </div>{/* end myday-scroll */}
            </div>
        </div>
    );
}
