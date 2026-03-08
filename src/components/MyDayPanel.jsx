import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

const HOUR_START = 7;
const HOUR_END = 20;

function pad2(n) { return String(n).padStart(2, '0'); }

function formatTime(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function isOverdue(task) {
    if (!task.due_date || task.status === 'done') return false;
    return new Date(task.due_date) < new Date(new Date().toDateString());
}

function isTodayDate(d) {
    const today = new Date();
    const date = new Date(d);
    return date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate();
}

export default function MyDayPanel({ visible, onClose, todayApts, tasks }) {
    if (!visible) return null;

    const now = new Date();
    const currentHour = now.getHours() + now.getMinutes() / 60;

    // Sort appointments by start time
    const sortedApts = [...todayApts].sort((a, b) => a._start - b._start);

    // Find upcoming (next) appointment
    const upcomingApt = sortedApts.find(a => a._start > now);

    // Tasks due today or overdue
    const todayTasks = tasks.filter(t => t.status !== 'done' && t.due_date && isTodayDate(t.due_date));
    const overdueTasks = tasks.filter(t => isOverdue(t));
    const pendingTasks = tasks.filter(t => t.status !== 'done' && !isOverdue(t));

    // Greeting based on time of day
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';
    const dayName = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

    // Toggle task completion
    const toggleTask = async (task) => {
        const newStatus = task.status === 'done' ? 'pending' : 'done';
        await supabase.from('tasks').update({
            status: newStatus,
            completed_at: newStatus === 'done' ? new Date().toISOString() : null,
        }).eq('id', task.id);
    };

    return (
        <div className="myday-overlay" onClick={onClose}>
            <div className="myday-sheet" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="myday-header">
                    <div>
                        <div className="myday-greeting">{greeting} 👋</div>
                        <div className="myday-date">{dayName}</div>
                    </div>
                    <button className="myday-close" onClick={onClose}>✕</button>
                </div>

                {/* Stats strip */}
                <div className="myday-stats">
                    <div className="myday-stat">
                        <span className="myday-stat__num">{sortedApts.length}</span>
                        <span className="myday-stat__label">RDV</span>
                    </div>
                    <div className="myday-stat">
                        <span className="myday-stat__num">{todayTasks.length + overdueTasks.length}</span>
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
                            <div className="myday-section-title">⏰ Prochain RDV</div>
                            <div className="myday-next__card" style={{ borderLeftColor: upcomingApt._color }}>
                                <div className="myday-next__time">{formatTime(upcomingApt._start)} → {formatTime(upcomingApt._end)}</div>
                                <div className="myday-next__title">{upcomingApt._clientName || upcomingApt._objet}</div>
                                {upcomingApt._address && <div className="myday-next__address">📍 {upcomingApt._address}</div>}
                                {upcomingApt._clientName && upcomingApt._objet && (
                                    <div className="myday-next__objet">{upcomingApt._objet}</div>
                                )}
                                <div className="myday-next__user" style={{ color: upcomingApt._color }}>
                                    <span className="myday-next__dot" style={{ background: upcomingApt._color }} />
                                    {upcomingApt._userName}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Today's timeline */}
                    {sortedApts.length > 0 && (
                        <div className="myday-section">
                            <div className="myday-section-title">📅 Planning du jour</div>
                            <div className="myday-timeline">
                                {sortedApts.map((apt, i) => {
                                    const isPast = apt._end < now;
                                    const isCurrent = apt._start <= now && apt._end >= now;
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
                                                <div className="myday-apt__user" style={{ color: apt._color }}>{apt._userName}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Overdue tasks */}
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

                    {/* Today's tasks */}
                    {todayTasks.length > 0 && (
                        <div className="myday-section">
                            <div className="myday-section-title">✅ Tâches du jour</div>
                            {todayTasks.map(task => (
                                <div key={task.id} className="myday-task">
                                    <button className="todo-checkbox" onClick={() => toggleTask(task)} style={{ borderColor: '#6c5ce7' }} />
                                    <div className="myday-task__title">{task.title}</div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Empty state */}
                    {sortedApts.length === 0 && todayTasks.length === 0 && overdueTasks.length === 0 && (
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
