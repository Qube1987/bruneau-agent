import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useSwipe } from '../hooks/useSwipe';
import {
    isSameDay, formatTime, pad2, formatDayFull, DAYS_FR_SHORT,
    detectConflicts, getSmartTimeRange, findFreeSlots, formatSlotTime,
} from '../utils/agendaUtils';

const HOUR_HEIGHT = 60; // taller blocks for mobile readability

function AddressLink({ address }) {
    if (!address) return null;
    const geoUrl = `geo:0,0?q=${encodeURIComponent(address)}`;
    return (
        <a href={geoUrl} className="dv-link dv-link--addr" onClick={e => e.stopPropagation()}>
            <span className="dv-link__icon">&#128205;</span> {address}
        </a>
    );
}

function PhoneLink({ phone, senderName }) {
    if (!phone) return null;
    const cleaned = phone.replace(/[\s.]/g, '');
    const smsText = `Bonjour, je suis en route et serai chez vous dans XX min.\nCordialement,\n${senderName || 'Bruneau Protection'}`;
    return (
        <span className="dv-link-group" onClick={e => e.stopPropagation()}>
            <a href={`tel:${cleaned}`} className="dv-link dv-link--phone">
                <span className="dv-link__icon">&#128222;</span> {phone}
            </a>
            <a href={`sms:${cleaned}?body=${encodeURIComponent(smsText)}`} className="dv-link dv-link--sms" title="SMS">
                &#9993;
            </a>
        </span>
    );
}

export default function DayView({
    appointments,
    tasks,
    setTasks,
    selectedDate,
    onDateChange,
    onAptClick,
    userCode,
    userName,
    travelTimes,
    weather,
    onCreateApt,
}) {
    const now = new Date();
    const isToday = isSameDay(selectedDate, now);
    const timelineRef = useRef(null);
    const [expandedApt, setExpandedApt] = useState(null);

    // Filter appointments for this day and this user
    const dayApts = appointments
        .filter(a => {
            const sameDay = a._start && isSameDay(a._start, selectedDate);
            if (userCode && a._userCode) {
                return sameDay && String(a._userCode) === String(userCode);
            }
            return sameDay;
        })
        .sort((a, b) => a._start - b._start);

    // Smart time range
    const { start: hourStart, end: hourEnd } = getSmartTimeRange(dayApts);
    const totalHours = hourEnd - hourStart;
    const timeLabels = Array.from({ length: totalHours }, (_, i) => hourStart + i);

    // Conflicts
    const conflicts = detectConflicts(dayApts);
    const conflictAptIds = new Set();
    conflicts.forEach(c => {
        conflictAptIds.add(c.apt1.id);
        conflictAptIds.add(c.apt2.id);
    });

    // Free slots
    const freeSlots = findFreeSlots(dayApts, hourStart, hourEnd, 30);

    // Current appointment
    const currentApt = isToday ? dayApts.find(a => a._start <= now && a._end >= now) : null;
    const nextApt = isToday ? dayApts.find(a => a._start > now) : dayApts[0];

    // Tasks for this day
    const todayStr = selectedDate.toISOString().split('T')[0];
    const dayTasks = (tasks || []).filter(t => {
        if (t.status === 'done') return false;
        const dueMatch = t.due_date && isSameDay(new Date(t.due_date), selectedDate);
        const myDayMatch = isToday && t.my_day_date === todayStr;
        return dueMatch || myDayMatch;
    });
    const uniqueTaskIds = new Set();
    const uniqueDayTasks = dayTasks.filter(t => {
        if (uniqueTaskIds.has(t.id)) return false;
        uniqueTaskIds.add(t.id);
        return true;
    });

    // Overdue tasks (only on today)
    const overdueTasks = isToday ? (tasks || []).filter(t => {
        if (!t.due_date || t.status === 'done') return false;
        return new Date(t.due_date) < new Date(now.toDateString());
    }) : [];

    // Swipe navigation
    const { elRef: swipeRef, onTouchStart, onTouchMove, onTouchEnd } = useSwipe({
        onSwipeLeft: () => {
            const next = new Date(selectedDate);
            next.setDate(next.getDate() + 1);
            onDateChange(next);
        },
        onSwipeRight: () => {
            const prev = new Date(selectedDate);
            prev.setDate(prev.getDate() - 1);
            onDateChange(prev);
        },
    });

    // Auto-scroll to current time on mount
    useEffect(() => {
        if (isToday && timelineRef.current) {
            const nowH = now.getHours() + now.getMinutes() / 60;
            const scrollTo = Math.max(0, (nowH - hourStart - 1) * HOUR_HEIGHT);
            timelineRef.current.scrollTop = scrollTo;
        }
    }, [selectedDate]);

    // Mini-calendar: 7 days centered on selected date
    const miniCalDays = [];
    for (let i = -3; i <= 3; i++) {
        const d = new Date(selectedDate);
        d.setDate(d.getDate() + i);
        miniCalDays.push(d);
    }

    const toggleTask = async (task) => {
        const newStatus = task.status === 'done' ? 'pending' : 'done';
        const completedAt = newStatus === 'done' ? new Date().toISOString() : null;
        if (setTasks) {
            setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: newStatus, completed_at: completedAt } : t));
        }
        await supabase.from('tasks').update({ status: newStatus, completed_at: completedAt }).eq('id', task.id);
    };

    // Appointment block position
    const getAptStyle = (apt) => {
        const startH = apt._start.getHours() + apt._start.getMinutes() / 60;
        const endH = apt._end.getHours() + apt._end.getMinutes() / 60;
        const top = Math.max(0, (startH - hourStart)) * HOUR_HEIGHT;
        const height = Math.max(HOUR_HEIGHT * 0.5, (endH - startH) * HOUR_HEIGHT);
        return { top: `${top}px`, height: `${height}px` };
    };

    // Layout overlapping appointments
    const layoutApts = (apts) => {
        const laid = apts.map(apt => ({ apt, col: 0, totalCols: 1 }));
        for (let i = 0; i < laid.length; i++) {
            const usedCols = new Set();
            for (let j = 0; j < i; j++) {
                if (laid[j].apt._start < laid[i].apt._end && laid[j].apt._end > laid[i].apt._start) {
                    usedCols.add(laid[j].col);
                }
            }
            let col = 0;
            while (usedCols.has(col)) col++;
            laid[i].col = col;
        }
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

    const laidOut = layoutApts(dayApts);

    // Now indicator
    let nowTop = null;
    if (isToday) {
        const nowH = now.getHours() + now.getMinutes() / 60;
        if (nowH >= hourStart && nowH <= hourEnd) {
            nowTop = (nowH - hourStart) * HOUR_HEIGHT;
        }
    }

    // Find travel time between specific apts
    const getTravelForApt = (apt) => {
        if (!travelTimes) return null;
        return travelTimes.find(t => t.toApt?.id === apt.id);
    };

    // Weather for selected day
    const dayWeather = weather?.forecast?.find(f => f.date === todayStr) || (isToday ? weather?.today : null);

    return (
        <div className="dv" ref={swipeRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
            {/* Mini calendar strip */}
            <div className="dv-minical">
                {miniCalDays.map((d, i) => {
                    const isSelected = isSameDay(d, selectedDate);
                    const isDayToday = isSameDay(d, now);
                    const hasApts = appointments.some(a => a._start && isSameDay(a._start, d) &&
                        (!userCode || !a._userCode || String(a._userCode) === String(userCode)));
                    return (
                        <button
                            key={i}
                            className={`dv-minical__day ${isSelected ? 'dv-minical__day--selected' : ''} ${isDayToday ? 'dv-minical__day--today' : ''}`}
                            onClick={() => onDateChange(d)}
                        >
                            <span className="dv-minical__dayname">{DAYS_FR_SHORT[d.getDay()]}</span>
                            <span className="dv-minical__daynum">{d.getDate()}</span>
                            {hasApts && <span className="dv-minical__dot" />}
                        </button>
                    );
                })}
            </div>

            {/* Day header with weather */}
            <div className="dv-header">
                <div className="dv-header__info">
                    <div className="dv-header__date">{formatDayFull(selectedDate)}</div>
                    <div className="dv-header__stats">
                        <span>{dayApts.length} RDV</span>
                        {uniqueDayTasks.length > 0 && <span>{uniqueDayTasks.length} tache{uniqueDayTasks.length > 1 ? 's' : ''}</span>}
                        {overdueTasks.length > 0 && <span className="dv-header__overdue">{overdueTasks.length} en retard</span>}
                    </div>
                </div>
                {dayWeather && (
                    <div className="dv-weather">
                        <span className="dv-weather__icon">{dayWeather.icon}</span>
                        <span className="dv-weather__temp">{dayWeather.temp || dayWeather.tempMax}°</span>
                    </div>
                )}
            </div>

            {/* Conflict warnings */}
            {conflicts.length > 0 && (
                <div className="dv-conflicts">
                    {conflicts.map((c, i) => (
                        <div key={i} className="dv-conflict">
                            <span className="dv-conflict__icon">&#9888;</span>
                            Conflit : {c.apt1._clientName || c.apt1._objet} et {c.apt2._clientName || c.apt2._objet} ({c.overlapMinutes}min)
                        </div>
                    ))}
                </div>
            )}

            {/* Next appointment highlight */}
            {nextApt && (
                <div className="dv-next" style={{ borderLeftColor: nextApt._color }}>
                    <div className="dv-next__label">{currentApt ? 'En cours' : isToday ? 'Prochain' : 'Premier'}</div>
                    <div className="dv-next__title">{nextApt._clientName || nextApt._objet}</div>
                    <div className="dv-next__time">{formatTime(nextApt._start)} - {formatTime(nextApt._end)}</div>
                    <div className="dv-next__links">
                        {nextApt._address && <AddressLink address={nextApt._address} />}
                        {nextApt._phone && <PhoneLink phone={nextApt._phone} senderName={userName} />}
                    </div>
                    {(() => {
                        const travel = getTravelForApt(nextApt);
                        if (!travel) return null;
                        return (
                            <div className={`dv-next__travel ${travel.tight ? 'dv-next__travel--tight' : ''}`}>
                                &#128663; {travel.minutes} min de trajet ({travel.km} km)
                                {travel.tight && <span className="dv-next__travel-warn"> - Temps serré !</span>}
                            </div>
                        );
                    })()}
                </div>
            )}

            {/* Timeline */}
            <div className="dv-timeline" ref={timelineRef}>
                <div className="dv-timeline__inner" style={{ height: `${totalHours * HOUR_HEIGHT}px` }}>
                    {/* Hour grid */}
                    {timeLabels.map(h => (
                        <div key={h} className="dv-timeline__hour" style={{ top: `${(h - hourStart) * HOUR_HEIGHT}px` }}>
                            <span className="dv-timeline__hour-label">{h}:00</span>
                            <div className="dv-timeline__hour-line" />
                        </div>
                    ))}

                    {/* Now indicator */}
                    {nowTop !== null && (
                        <div className="dv-timeline__now" style={{ top: `${nowTop}px` }}>
                            <div className="dv-timeline__now-dot" />
                            <div className="dv-timeline__now-line" />
                            <span className="dv-timeline__now-time">{formatTime(now)}</span>
                        </div>
                    )}

                    {/* Appointment blocks */}
                    {laidOut.map(({ apt, col, totalCols }, i) => {
                        const style = getAptStyle(apt);
                        const widthPct = 100 / totalCols;
                        const leftPct = col * widthPct;
                        const isConflict = conflictAptIds.has(apt.id);
                        const isExpanded = expandedApt === apt.id;
                        const isCurrent = isToday && apt._start <= now && apt._end >= now;
                        const isPast = isToday && apt._end < now;

                        return (
                            <div
                                key={apt.id || i}
                                className={`dv-apt ${isConflict ? 'dv-apt--conflict' : ''} ${isCurrent ? 'dv-apt--current' : ''} ${isPast ? 'dv-apt--past' : ''} ${isExpanded ? 'dv-apt--expanded' : ''}`}
                                style={{
                                    top: style.top,
                                    height: isExpanded ? 'auto' : style.height,
                                    minHeight: style.height,
                                    left: `calc(50px + (100% - 54px) * ${leftPct / 100})`,
                                    width: `calc((100% - 54px) * ${widthPct / 100})`,
                                    borderLeftColor: apt._color,
                                    background: `${apt._color}18`,
                                }}
                                onClick={() => setExpandedApt(isExpanded ? null : apt.id)}
                            >
                                <div className="dv-apt__header">
                                    <span className="dv-apt__time">{formatTime(apt._start)}-{formatTime(apt._end)}</span>
                                    {isCurrent && <span className="dv-apt__live">EN COURS</span>}
                                </div>
                                <div className="dv-apt__title">{apt._clientName || apt._objet}</div>
                                {apt._clientName && apt._objet && (
                                    <div className="dv-apt__subtitle">{apt._objet}</div>
                                )}
                                {isExpanded && (
                                    <div className="dv-apt__details">
                                        {apt._address && <AddressLink address={apt._address} />}
                                        {apt._phone && <PhoneLink phone={apt._phone} senderName={userName} />}
                                        {apt._userName && (
                                            <div className="dv-apt__user" style={{ color: apt._color }}>
                                                <span className="dv-apt__user-dot" style={{ background: apt._color }} />
                                                {apt._userName}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {/* Free slot indicators */}
                    {freeSlots.filter(s => s.minutes >= 60).map((slot, i) => (
                        <div
                            key={`slot-${i}`}
                            className="dv-freeslot"
                            style={{
                                top: `${(slot.start / 60 - hourStart) * HOUR_HEIGHT}px`,
                                height: `${(slot.minutes / 60) * HOUR_HEIGHT}px`,
                            }}
                            onClick={() => onCreateApt?.(slot)}
                        >
                            <span className="dv-freeslot__label">
                                {formatSlotTime(slot.start)} - {formatSlotTime(slot.end)}
                                <br />
                                {Math.floor(slot.minutes / 60)}h{slot.minutes % 60 > 0 ? pad2(slot.minutes % 60) : ''} libre
                            </span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Tasks section */}
            {(uniqueDayTasks.length > 0 || overdueTasks.length > 0) && (
                <div className="dv-tasks">
                    {overdueTasks.length > 0 && (
                        <div className="dv-tasks__section">
                            <div className="dv-tasks__title dv-tasks__title--danger">En retard ({overdueTasks.length})</div>
                            {overdueTasks.map(t => (
                                <div key={t.id} className="dv-task dv-task--overdue">
                                    <button className="dv-task__check" onClick={() => toggleTask(t)}>
                                        <span className="dv-task__check-inner" />
                                    </button>
                                    <span className="dv-task__text">{t.title}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {uniqueDayTasks.length > 0 && (
                        <div className="dv-tasks__section">
                            <div className="dv-tasks__title">Taches du jour ({uniqueDayTasks.length})</div>
                            {uniqueDayTasks.map(t => (
                                <div key={t.id} className="dv-task">
                                    <button className="dv-task__check" onClick={() => toggleTask(t)}>
                                        <span className="dv-task__check-inner" />
                                    </button>
                                    <span className="dv-task__text">{t.title}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Empty state */}
            {dayApts.length === 0 && uniqueDayTasks.length === 0 && overdueTasks.length === 0 && (
                <div className="dv-empty">
                    <div className="dv-empty__icon">&#127774;</div>
                    <p>Journée libre !</p>
                </div>
            )}

            {/* FAB - Create appointment */}
            {onCreateApt && (
                <button className="dv-fab" onClick={() => onCreateApt()} title="Nouveau RDV">
                    <span>+</span>
                </button>
            )}
        </div>
    );
}
