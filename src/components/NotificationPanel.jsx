import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

/**
 * NotificationPanel — Shows:
 * 1. Tomorrow's appointments with SMS confirmation buttons
 * 2. Pending task reminders
 * 3. Tasks due within 3 days
 */
export default function NotificationPanel({ onClose, tasks = [], onNavigate }) {
    const [appointments, setAppointments] = useState([]);
    const [loadingRdv, setLoadingRdv] = useState(true);
    const [sentSms, setSentSms] = useState({});

    useEffect(() => {
        fetchTomorrowAppointments();
    }, []);

    async function fetchTomorrowAppointments() {
        try {
            setLoadingRdv(true);
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateStr = tomorrow.toISOString().split('T')[0];
            const dayNames = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
            const dayName = dayNames[tomorrow.getDay()];

            const { data: sessionData } = await supabase.auth.getSession();
            const token = sessionData?.session?.access_token;

            const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/extrabat-proxy`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token || import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify({
                    endpoint: 'utilisateur/46516/rendez-vous',
                    apiVersion: 'v1',
                    params: { date_debut: dateStr, date_fin: dateStr, include: 'client' },
                }),
            });

            const result = await response.json();
            if (result.success && result.data) {
                const rdvs = Array.isArray(result.data) ? result.data : Object.values(result.data);
                const formatted = rdvs
                    .map((apt) => {
                        const debut = new Date(apt.debut);
                        const fin = new Date(apt.fin);
                        const client = apt.clients?.[0] || null;
                        const clientName = client
                            ? `${client.prenom || ''} ${client.nom || ''}`.trim() || client.raisonSociale || ''
                            : '';
                        const phone = client?.telephones?.[0]?.number || client?.telephones?.[0]?.numero || '';
                        return {
                            id: apt.id, objet: apt.objet || 'Sans objet',
                            debut, fin,
                            heureDebut: debut.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
                            heureFin: fin.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
                            clientName, phone, journee: apt.journee, dateStr, dayName,
                        };
                    })
                    .sort((a, b) => a.debut - b.debut);
                setAppointments(formatted);
            }
        } catch (err) {
            console.error('Failed to fetch appointments:', err);
        } finally {
            setLoadingRdv(false);
        }
    }

    function handleSendSms(apt) {
        const dateFormatted = new Date(apt.dateStr).toLocaleDateString('fr-FR', {
            weekday: 'long', day: 'numeric', month: 'long',
        });
        const body = `Bonjour, nous vous confirmons votre rendez-vous du ${dateFormatted} à ${apt.heureDebut}. Cordialement, Bruneau Protection.`;
        window.open(`sms:${apt.phone}?body=${encodeURIComponent(body)}`, '_self');
        setSentSms((prev) => ({ ...prev, [apt.id]: true }));
    }

    // Compute notification sections
    const now = new Date();
    const in3Days = new Date(now); in3Days.setDate(in3Days.getDate() + 3);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const rdvsWithClients = appointments.filter(a => a.clientName && a.phone);
    const rdvsWithoutPhone = appointments.filter(a => a.clientName && !a.phone);
    const rdvsPersonal = appointments.filter(a => !a.clientName);

    const pendingReminders = tasks.filter(t =>
        t.reminder_at && !t.reminder_sent && t.status !== 'done' && new Date(t.reminder_at) <= now
    );

    const upcomingTasks = tasks.filter(t => {
        if (t.status === 'done' || !t.due_date) return false;
        const due = new Date(t.due_date);
        const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
        return dueDay >= today && dueDay <= in3Days;
    }).sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

    const overdueTasks = tasks.filter(t => {
        if (t.status === 'done' || !t.due_date) return false;
        const dueDay = new Date(new Date(t.due_date).getFullYear(), new Date(t.due_date).getMonth(), new Date(t.due_date).getDate());
        return dueDay < today;
    }).sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

    const totalBadge = rdvsWithClients.length + pendingReminders.length + overdueTasks.length + upcomingTasks.length;

    function formatDueLabel(d) {
        const date = new Date(d);
        const dueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const todayD = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrowD = new Date(todayD); tomorrowD.setDate(todayD.getDate() + 1);
        const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
        const timePart = hasTime ? ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '';

        if (dueDay.getTime() === todayD.getTime()) return "Aujourd'hui" + timePart;
        if (dueDay.getTime() === tomorrowD.getTime()) return 'Demain' + timePart;
        if (dueDay < todayD) {
            const diff = Math.ceil((todayD - dueDay) / (1000 * 60 * 60 * 24));
            return `Il y a ${diff}j`;
        }
        const diff = Math.ceil((dueDay - todayD) / (1000 * 60 * 60 * 24));
        return `Dans ${diff}j` + timePart;
    }

    const PRIORITY_MAP = {
        urgent: { emoji: '🔴', name: 'Urgent' },
        high: { emoji: '🟠', name: 'Haute' },
        medium: { emoji: '🔵', name: 'Moyenne' },
        low: { emoji: '⚪', name: 'Basse' },
    };

    return (
        <div className="notif-overlay" onClick={onClose}>
            <div className="notif-panel" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="notif-header">
                    <div className="notif-header__left">
                        <span className="notif-header__icon">🔔</span>
                        <div>
                            <div className="notif-header__title">Notifications</div>
                            <div className="notif-header__subtitle">
                                {totalBadge > 0 ? `${totalBadge} élément(s)` : 'Tout est à jour'}
                            </div>
                        </div>
                    </div>
                    <button className="notif-close" onClick={onClose}>✕</button>
                </div>

                <div className="notif-body">
                    {loadingRdv && (
                        <div className="notif-loading">
                            <div className="typing"><div className="typing__dot" /><div className="typing__dot" /><div className="typing__dot" /></div>
                            Chargement...
                        </div>
                    )}

                    {/* === Overdue Tasks === */}
                    {overdueTasks.length > 0 && (
                        <div className="notif-section">
                            <div className="notif-section__title notif-section__title--danger">
                                🔥 En retard ({overdueTasks.length})
                            </div>
                            {overdueTasks.map(task => (
                                <div key={task.id} className="notif-item notif-item--overdue notif-item--clickable" onClick={() => onNavigate?.('todo')}>
                                    <div className="notif-item__icon">{PRIORITY_MAP[task.priority]?.emoji || '🔵'}</div>
                                    <div className="notif-item__content">
                                        <div className="notif-item__title">{task.title}</div>
                                        <div className="notif-item__meta">📅 {formatDueLabel(task.due_date)}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* === Pending Reminders === */}
                    {pendingReminders.length > 0 && (
                        <div className="notif-section">
                            <div className="notif-section__title">
                                🔔 Rappels ({pendingReminders.length})
                            </div>
                            {pendingReminders.map(task => (
                                <div key={task.id} className="notif-item notif-item--clickable" onClick={() => onNavigate?.('todo')}>
                                    <div className="notif-item__icon">{PRIORITY_MAP[task.priority]?.emoji || '🔵'}</div>
                                    <div className="notif-item__content">
                                        <div className="notif-item__title">{task.title}</div>
                                        {task.description && <div className="notif-item__desc">{task.description}</div>}
                                        {task.due_date && <div className="notif-item__meta">📅 {formatDueLabel(task.due_date)}</div>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* === RDV to confirm === */}
                    {!loadingRdv && rdvsWithClients.length > 0 && (
                        <div className="notif-section">
                            <div className="notif-section__title">
                                💬 RDV à confirmer ({rdvsWithClients.length})
                            </div>
                            {rdvsWithClients.map(apt => (
                                <div key={apt.id} className="notif-item notif-item--rdv notif-item--clickable" onClick={() => onNavigate?.('agenda')}>
                                    <div className="notif-item__icon">📋</div>
                                    <div className="notif-item__content">
                                        <div className="notif-item__title">{apt.clientName}</div>
                                        <div className="notif-item__meta">
                                            {apt.journee ? '📅 Journée' : `${apt.heureDebut} - ${apt.heureFin}`} · {apt.objet}
                                        </div>
                                    </div>
                                    <button
                                        className={`notif-item__sms ${sentSms[apt.id] ? 'notif-item__sms--sent' : ''}`}
                                        onClick={() => handleSendSms(apt)}
                                        disabled={sentSms[apt.id]}
                                        title={sentSms[apt.id] ? 'SMS envoyé' : 'Envoyer SMS'}
                                    >
                                        {sentSms[apt.id] ? '✓' : '✉️'}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* === Upcoming tasks (3 days) === */}
                    {upcomingTasks.length > 0 && (
                        <div className="notif-section">
                            <div className="notif-section__title">
                                ⏰ Échéances proches ({upcomingTasks.length})
                            </div>
                            {upcomingTasks.map(task => (
                                <div key={task.id} className="notif-item notif-item--clickable" onClick={() => onNavigate?.('todo')}>
                                    <div className="notif-item__icon">{PRIORITY_MAP[task.priority]?.emoji || '🔵'}</div>
                                    <div className="notif-item__content">
                                        <div className="notif-item__title">{task.title}</div>
                                        <div className="notif-item__meta">📅 {formatDueLabel(task.due_date)}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* === RDV without phone === */}
                    {!loadingRdv && rdvsWithoutPhone.length > 0 && (
                        <div className="notif-section">
                            <div className="notif-section__title notif-section__title--muted">
                                ⚠️ RDV sans numéro ({rdvsWithoutPhone.length})
                            </div>
                            {rdvsWithoutPhone.map(apt => (
                                <div key={apt.id} className="notif-item notif-item--muted notif-item--clickable" onClick={() => onNavigate?.('agenda')}>
                                    <div className="notif-item__icon">📋</div>
                                    <div className="notif-item__content">
                                        <div className="notif-item__title">{apt.clientName}</div>
                                        <div className="notif-item__meta">
                                            {apt.journee ? '📅 Journée' : `${apt.heureDebut} - ${apt.heureFin}`} · {apt.objet}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* === Personal RDV === */}
                    {!loadingRdv && rdvsPersonal.length > 0 && (
                        <div className="notif-section">
                            <div className="notif-section__title notif-section__title--muted">
                                👤 Perso/interne ({rdvsPersonal.length})
                            </div>
                            {rdvsPersonal.map(apt => (
                                <div key={apt.id} className="notif-item notif-item--muted notif-item--clickable" onClick={() => onNavigate?.('agenda')}>
                                    <div className="notif-item__icon">📋</div>
                                    <div className="notif-item__content">
                                        <div className="notif-item__title">{apt.objet}</div>
                                        <div className="notif-item__meta">
                                            {apt.journee ? '📅 Journée' : `${apt.heureDebut} - ${apt.heureFin}`}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* === Empty state === */}
                    {!loadingRdv && totalBadge === 0 && rdvsPersonal.length === 0 && rdvsWithoutPhone.length === 0 && (
                        <div className="notif-empty">
                            ✅ Aucune notification
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * Returns the badge count for the bell icon.
 * Can be imported and used from App.jsx
 */
export function getNotifBadgeCount(tasks = []) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const in3Days = new Date(today); in3Days.setDate(in3Days.getDate() + 3);

    const overdue = tasks.filter(t => {
        if (t.status === 'done' || !t.due_date) return false;
        const dueDay = new Date(new Date(t.due_date).getFullYear(), new Date(t.due_date).getMonth(), new Date(t.due_date).getDate());
        return dueDay < today;
    }).length;

    const reminders = tasks.filter(t =>
        t.reminder_at && !t.reminder_sent && t.status !== 'done' && new Date(t.reminder_at) <= now
    ).length;

    const upcoming = tasks.filter(t => {
        if (t.status === 'done' || !t.due_date) return false;
        const due = new Date(t.due_date);
        const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
        return dueDay >= today && dueDay <= in3Days;
    }).length;

    return overdue + reminders + upcoming;
}
