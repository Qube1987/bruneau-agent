import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

const PRIORITIES = [
    { value: 'urgent', label: '🔴', color: '#ff6b6b', name: 'Urgent' },
    { value: 'high', label: '🟠', color: '#fdcb6e', name: 'Haute' },
    { value: 'medium', label: '🔵', color: '#6c5ce7', name: 'Moyenne' },
    { value: 'low', label: '⚪', color: '#636e72', name: 'Basse' },
];

const CATEGORIES = [
    { value: 'general', label: '📌', name: 'Général' },
    { value: 'client', label: '👤', name: 'Client' },
    { value: 'sav', label: '🔧', name: 'SAV' },
    { value: 'commercial', label: '💼', name: 'Commercial' },
    { value: 'admin', label: '📋', name: 'Admin' },
    { value: 'perso', label: '🏠', name: 'Perso' },
];

const REMINDER_SHORTCUTS = [
    { label: '5 min avant', offset: -5 * 60 * 1000 },
    { label: '15 min avant', offset: -15 * 60 * 1000 },
    { label: '1h avant', offset: -60 * 60 * 1000 },
    { label: 'La veille à 20h', offset: 'veille' },
    { label: '1 semaine avant', offset: -7 * 24 * 60 * 60 * 1000 },
    { label: 'Personnalisé...', offset: 'custom' },
];

function computeReminderAt(dueDate, shortcut) {
    if (!dueDate || !shortcut) return null;
    const due = new Date(dueDate);
    if (shortcut.offset === 'veille') {
        const veille = new Date(due);
        veille.setDate(veille.getDate() - 1);
        veille.setHours(20, 0, 0, 0);
        return veille.toISOString();
    }
    if (typeof shortcut.offset === 'number') {
        return new Date(due.getTime() + shortcut.offset).toISOString();
    }
    return null;
}

function formatDueDate(d) {
    if (!d) return '';
    const date = new Date(d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const taskDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
    const timeSuffix = hasTime ? ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '';

    if (taskDay.getTime() === today.getTime()) return "Aujourd'hui" + timeSuffix;
    if (taskDay.getTime() === tomorrow.getTime()) return 'Demain' + timeSuffix;
    if (taskDay < today) return 'En retard';

    const diff = Math.ceil((taskDay - today) / (1000 * 60 * 60 * 24));
    if (diff <= 7) {
        const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
        return days[date.getDay()] + timeSuffix;
    }
    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + timeSuffix;
}

function formatReminderLabel(reminderAt, dueDate) {
    if (!reminderAt) return '';
    const r = new Date(reminderAt);
    if (!dueDate) return r.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const d = new Date(dueDate);
    const diff = d.getTime() - r.getTime();
    if (diff <= 6 * 60 * 1000) return '5 min avant';
    if (diff <= 16 * 60 * 1000) return '15 min avant';
    if (diff <= 61 * 60 * 1000) return '1h avant';
    if (diff >= 6.5 * 24 * 60 * 60 * 1000) return '1 sem. avant';
    // Check if it's "veille à 20h"
    const veille = new Date(d);
    veille.setDate(veille.getDate() - 1);
    veille.setHours(20, 0, 0, 0);
    if (Math.abs(r.getTime() - veille.getTime()) < 60000) return 'La veille 20h';
    return r.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function isOverdue(task) {
    if (!task.due_date || task.status === 'done') return false;
    return new Date(task.due_date) < new Date(new Date().toDateString());
}

export default function TodoPanel({ tasks, setTasks, loading: externalLoading }) {
    const [filter, setFilter] = useState('active');
    const [showAddForm, setShowAddForm] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newDescription, setNewDescription] = useState('');
    const [newPriority, setNewPriority] = useState('medium');
    const [newCategory, setNewCategory] = useState('general');
    const [newDueDate, setNewDueDate] = useState('');
    const [newDueTime, setNewDueTime] = useState('');
    const [newReminderType, setNewReminderType] = useState('');
    const [newReminderCustom, setNewReminderCustom] = useState('');
    const [completingIds, setCompletingIds] = useState(new Set());
    const [editingTask, setEditingTask] = useState(null);
    const addInputRef = useRef(null);

    useEffect(() => {
        if (showAddForm && addInputRef.current) {
            addInputRef.current.focus();
        }
    }, [showAddForm]);

    const buildDueDateISO = (dateStr, timeStr) => {
        if (!dateStr) return null;
        if (timeStr) {
            return new Date(`${dateStr}T${timeStr}`).toISOString();
        }
        return new Date(dateStr).toISOString();
    };

    const computeNewReminder = () => {
        if (!newReminderType || !newDueDate) return null;
        const shortcut = REMINDER_SHORTCUTS.find(s => s.label === newReminderType);
        if (!shortcut) return null;
        if (shortcut.offset === 'custom') {
            return newReminderCustom ? new Date(newReminderCustom).toISOString() : null;
        }
        const dueDateISO = buildDueDateISO(newDueDate, newDueTime);
        return computeReminderAt(dueDateISO, shortcut);
    };

    const addTask = async () => {
        const title = newTitle.trim();
        if (!title) return;

        const reminder_at = computeNewReminder();

        const newTask = {
            title,
            description: newDescription.trim() || '',
            priority: newPriority,
            category: newCategory,
            due_date: buildDueDateISO(newDueDate, newDueTime),
            reminder_at,
            reminder_sent: false,
            status: 'pending',
        };

        const tempId = 'temp-' + Date.now();
        setTasks(prev => [{ ...newTask, id: tempId, created_at: new Date().toISOString() }, ...prev]);
        setNewTitle('');
        setNewDescription('');
        setNewPriority('medium');
        setNewCategory('general');
        setNewDueDate('');
        setNewDueTime('');
        setNewReminderType('');
        setNewReminderCustom('');
        setShowAddForm(false);

        const { data, error } = await supabase.from('tasks').insert(newTask).select().single();
        if (data) {
            setTasks(prev => prev.map(t => t.id === tempId ? data : t));
        } else if (error) {
            console.error('Error adding task:', error);
            setTasks(prev => prev.filter(t => t.id !== tempId));
        }
    };

    const toggleComplete = async (task, e) => {
        e.stopPropagation();
        const newStatus = task.status === 'done' ? 'pending' : 'done';
        const completedAt = newStatus === 'done' ? new Date().toISOString() : null;

        if (newStatus === 'done') {
            setCompletingIds(prev => new Set([...prev, task.id]));
            setTimeout(() => {
                setCompletingIds(prev => { const next = new Set(prev); next.delete(task.id); return next; });
                setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: newStatus, completed_at: completedAt } : t));
            }, 500);
        } else {
            setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: newStatus, completed_at: completedAt } : t));
        }

        await supabase.from('tasks').update({ status: newStatus, completed_at: completedAt }).eq('id', task.id);
    };

    const deleteTask = async (id, e) => {
        if (e) e.stopPropagation();
        setTasks(prev => prev.filter(t => t.id !== id));
        if (editingTask?.id === id) setEditingTask(null);
        await supabase.from('tasks').delete().eq('id', id);
    };

    const openEditModal = (task) => {
        setEditingTask({ ...task });
    };

    const saveEditModal = async () => {
        if (!editingTask) return;
        const updates = {
            title: editingTask.title?.trim() || '',
            description: editingTask.description?.trim() || '',
            priority: editingTask.priority,
            category: editingTask.category,
            due_date: editingTask.due_date,
            reminder_at: editingTask.reminder_at,
            reminder_sent: editingTask.reminder_at ? false : editingTask.reminder_sent,
        };
        if (!updates.title) return;

        setTasks(prev => prev.map(t => t.id === editingTask.id ? { ...t, ...updates } : t));
        setEditingTask(null);
        await supabase.from('tasks').update(updates).eq('id', editingTask.id);
    };

    const setEditReminder = (shortcutLabel) => {
        if (!editingTask) return;
        if (shortcutLabel === '') {
            setEditingTask(prev => ({ ...prev, reminder_at: null, _reminderType: '' }));
            return;
        }
        const shortcut = REMINDER_SHORTCUTS.find(s => s.label === shortcutLabel);
        if (!shortcut) return;
        if (shortcut.offset === 'custom') {
            setEditingTask(prev => ({ ...prev, _reminderType: 'custom' }));
            return;
        }
        if (!editingTask.due_date) return;
        const reminderAt = computeReminderAt(editingTask.due_date, shortcut);
        setEditingTask(prev => ({ ...prev, reminder_at: reminderAt, _reminderType: shortcutLabel }));
    };

    const setEditCustomReminder = (val) => {
        if (!val) return;
        setEditingTask(prev => ({ ...prev, reminder_at: new Date(val).toISOString(), _reminderType: 'custom' }));
    };

    // Filtered and sorted
    const filtered = tasks
        .filter(t => {
            if (filter === 'active') return t.status !== 'done';
            if (filter === 'done') return t.status === 'done';
            return true;
        })
        .sort((a, b) => {
            if (a.status === 'done' && b.status !== 'done') return 1;
            if (a.status !== 'done' && b.status === 'done') return -1;
            const pOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
            if (pOrder[a.priority] !== pOrder[b.priority]) return pOrder[a.priority] - pOrder[b.priority];
            if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
            if (a.due_date) return -1;
            if (b.due_date) return 1;
            return new Date(b.created_at) - new Date(a.created_at);
        });

    const activeCount = tasks.filter(t => t.status !== 'done').length;
    const overdueCount = tasks.filter(t => isOverdue(t)).length;

    return (
        <div className="todo-panel" style={{ overflowY: 'auto', maxHeight: '45vh', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Header bar */}
            <div className="todo-header">
                <div className="todo-header__filters">
                    <button className={`todo-filter ${filter === 'active' ? 'todo-filter--active' : ''}`} onClick={() => setFilter('active')}>
                        En cours {activeCount > 0 && <span className="todo-filter__count">{activeCount}</span>}
                    </button>
                    <button className={`todo-filter ${filter === 'done' ? 'todo-filter--active' : ''}`} onClick={() => setFilter('done')}>
                        Terminées
                    </button>
                    <button className={`todo-filter ${filter === 'all' ? 'todo-filter--active' : ''}`} onClick={() => setFilter('all')}>
                        Toutes
                    </button>
                </div>
                {overdueCount > 0 && (
                    <span className="todo-overdue-badge">🔥 {overdueCount} en retard</span>
                )}
            </div>

            {/* Add task button / form */}
            {!showAddForm ? (
                <button className="todo-add-btn" onClick={() => setShowAddForm(true)}>
                    <span className="todo-add-btn__icon">+</span>
                    <span>Ajouter une tâche</span>
                </button>
            ) : (
                <div className="todo-add-form">
                    <input
                        ref={addInputRef}
                        className="todo-add-form__input"
                        type="text"
                        placeholder="Objet de la tâche..."
                        value={newTitle}
                        onChange={e => setNewTitle(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) addTask(); if (e.key === 'Escape') setShowAddForm(false); }}
                    />
                    <textarea
                        className="todo-add-form__textarea"
                        placeholder="Description (optionnel)..."
                        value={newDescription}
                        onChange={e => setNewDescription(e.target.value)}
                        rows={2}
                    />
                    <div className="todo-add-form__options">
                        <select className="todo-add-form__select" value={newPriority} onChange={e => setNewPriority(e.target.value)}>
                            {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label} {p.name}</option>)}
                        </select>
                        <select className="todo-add-form__select" value={newCategory} onChange={e => setNewCategory(e.target.value)}>
                            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label} {c.name}</option>)}
                        </select>
                        <div className="todo-add-form__date-wrapper">
                            <label className="todo-add-form__date-label">📅 Échéance</label>
                            <input className="todo-add-form__date" type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)} />
                            <input className="todo-add-form__time" type="time" value={newDueTime} onChange={e => setNewDueTime(e.target.value)} disabled={!newDueDate} title={!newDueDate ? 'Choisissez d\'abord une date' : 'Heure (optionnel)'} />
                        </div>
                        <div className="todo-add-form__date-wrapper">
                            <label className="todo-add-form__date-label">🔔 Rappel</label>
                            <select
                                className="todo-add-form__select"
                                value={newReminderType}
                                onChange={e => setNewReminderType(e.target.value)}
                                disabled={!newDueDate}
                                title={!newDueDate ? 'Choisissez d\'abord une échéance' : ''}
                            >
                                <option value="">Aucun</option>
                                {REMINDER_SHORTCUTS.map(s => (
                                    <option key={s.label} value={s.label}>{s.label}</option>
                                ))}
                            </select>
                        </div>
                        {newReminderType === 'Personnalisé...' && (
                            <input
                                className="todo-add-form__date"
                                type="datetime-local"
                                value={newReminderCustom}
                                onChange={e => setNewReminderCustom(e.target.value)}
                                style={{ minWidth: '160px' }}
                            />
                        )}
                    </div>
                    <div className="todo-add-form__actions">
                        <button className="todo-add-form__submit" onClick={addTask} disabled={!newTitle.trim()}>Ajouter</button>
                        <button className="todo-add-form__cancel" onClick={() => setShowAddForm(false)}>Annuler</button>
                    </div>
                </div>
            )}

            {/* Task list */}
            {externalLoading && tasks.length === 0 ? (
                <div className="agenda-panel__empty"><span>⟳</span><p>Chargement...</p></div>
            ) : filtered.length === 0 ? (
                <div className="agenda-panel__empty">
                    <span>{filter === 'done' ? '🎉' : '✨'}</span>
                    <p>{filter === 'done' ? 'Aucune tâche terminée' : 'Aucune tâche en cours'}</p>
                </div>
            ) : (
                <div className="todo-list">
                    {filtered.map(task => {
                        const pri = PRIORITIES.find(p => p.value === task.priority) || PRIORITIES[2];
                        const cat = CATEGORIES.find(c => c.value === task.category);
                        const overdue = isOverdue(task);
                        const completing = completingIds.has(task.id);

                        return (
                            <div
                                key={task.id}
                                className={`todo-item ${task.status === 'done' ? 'todo-item--done' : ''} ${overdue ? 'todo-item--overdue' : ''} ${completing ? 'todo-item--completing' : ''}`}
                                onClick={() => openEditModal(task)}
                                style={{ cursor: 'pointer' }}
                            >
                                {/* Checkbox */}
                                <button
                                    className={`todo-checkbox ${task.status === 'done' ? 'todo-checkbox--checked' : ''}`}
                                    style={{ borderColor: pri.color, background: task.status === 'done' ? pri.color : 'transparent' }}
                                    onClick={(e) => toggleComplete(task, e)}
                                    title={task.status === 'done' ? 'Marquer non terminée' : 'Marquer terminée'}
                                >
                                    {task.status === 'done' && <span className="todo-checkbox__check">✓</span>}
                                </button>

                                {/* Content */}
                                <div className="todo-item__content">
                                    <div className="todo-item__title">
                                        {task.title}
                                    </div>
                                    {task.description && (
                                        <div className="todo-item__description">{task.description}</div>
                                    )}
                                    <div className="todo-item__meta">
                                        {cat && <span className="todo-item__category">{cat.label} {cat.name}</span>}
                                        {task.due_date && (
                                            <span className={`todo-item__due ${overdue ? 'todo-item__due--overdue' : ''}`}>
                                                📅 {formatDueDate(task.due_date)}
                                            </span>
                                        )}
                                        {task.reminder_at && !task.reminder_sent && (
                                            <span className="todo-item__reminder">
                                                🔔 {formatReminderLabel(task.reminder_at, task.due_date)}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Priority indicator */}
                                <div className="todo-item__priority" style={{ color: pri.color }} title={pri.name}>
                                    {pri.label}
                                </div>

                                {/* Quick delete */}
                                <div className="todo-item__actions" onClick={e => e.stopPropagation()}>
                                    <button className="todo-item__delete" onClick={(e) => deleteTask(task.id, e)} title="Supprimer">🗑️</button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Edit Modal */}
            {editingTask && (
                <div className="todo-modal-overlay" onClick={() => setEditingTask(null)}>
                    <div className="todo-modal" onClick={e => e.stopPropagation()}>
                        <div className="todo-modal__header">
                            <h3 className="todo-modal__title">Modifier la tâche</h3>
                            <button className="todo-modal__close" onClick={() => setEditingTask(null)}>✕</button>
                        </div>

                        <div className="todo-modal__body">
                            {/* Objet */}
                            <div className="todo-modal__field">
                                <label className="todo-modal__label">Objet</label>
                                <input
                                    className="todo-modal__input"
                                    type="text"
                                    value={editingTask.title || ''}
                                    onChange={e => setEditingTask(prev => ({ ...prev, title: e.target.value }))}
                                    autoFocus
                                />
                            </div>

                            {/* Description */}
                            <div className="todo-modal__field">
                                <label className="todo-modal__label">Description</label>
                                <textarea
                                    className="todo-modal__textarea"
                                    value={editingTask.description || ''}
                                    onChange={e => setEditingTask(prev => ({ ...prev, description: e.target.value }))}
                                    rows={3}
                                    placeholder="Ajouter une description..."
                                />
                            </div>

                            {/* Priority & Category */}
                            <div className="todo-modal__row">
                                <div className="todo-modal__field todo-modal__field--half">
                                    <label className="todo-modal__label">Priorité</label>
                                    <select
                                        className="todo-modal__select"
                                        value={editingTask.priority}
                                        onChange={e => setEditingTask(prev => ({ ...prev, priority: e.target.value }))}
                                    >
                                        {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label} {p.name}</option>)}
                                    </select>
                                </div>
                                <div className="todo-modal__field todo-modal__field--half">
                                    <label className="todo-modal__label">Catégorie</label>
                                    <select
                                        className="todo-modal__select"
                                        value={editingTask.category || 'general'}
                                        onChange={e => setEditingTask(prev => ({ ...prev, category: e.target.value }))}
                                    >
                                        {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label} {c.name}</option>)}
                                    </select>
                                </div>
                            </div>

                            {/* Due date + time */}
                            <div className="todo-modal__field">
                                <label className="todo-modal__label">📅 Échéance</label>
                                <div className="todo-modal__row">
                                    <input
                                        className="todo-modal__input"
                                        type="date"
                                        value={editingTask.due_date ? editingTask.due_date.split('T')[0] : ''}
                                        onChange={e => {
                                            if (!e.target.value) {
                                                setEditingTask(prev => ({ ...prev, due_date: null }));
                                                return;
                                            }
                                            // Preserve existing time if any
                                            const existingDate = editingTask.due_date ? new Date(editingTask.due_date) : null;
                                            const newDate = new Date(e.target.value);
                                            if (existingDate && (existingDate.getHours() !== 0 || existingDate.getMinutes() !== 0)) {
                                                newDate.setHours(existingDate.getHours(), existingDate.getMinutes(), 0, 0);
                                            }
                                            setEditingTask(prev => ({ ...prev, due_date: newDate.toISOString() }));
                                        }}
                                        style={{ flex: 1 }}
                                    />
                                    <input
                                        className="todo-modal__input"
                                        type="time"
                                        value={editingTask.due_date ? (() => {
                                            const d = new Date(editingTask.due_date);
                                            return (d.getHours() !== 0 || d.getMinutes() !== 0)
                                                ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                                                : '';
                                        })() : ''}
                                        onChange={e => {
                                            if (!editingTask.due_date) return;
                                            const base = new Date(editingTask.due_date);
                                            if (e.target.value) {
                                                const [h, m] = e.target.value.split(':').map(Number);
                                                base.setHours(h, m, 0, 0);
                                            } else {
                                                base.setHours(0, 0, 0, 0);
                                            }
                                            setEditingTask(prev => ({ ...prev, due_date: base.toISOString() }));
                                        }}
                                        disabled={!editingTask.due_date}
                                        title={!editingTask.due_date ? 'Choisissez d\'abord une date' : 'Heure (optionnel)'}
                                        style={{ width: '110px' }}
                                    />
                                </div>
                            </div>

                            {/* Reminder */}
                            <div className="todo-modal__field">
                                <label className="todo-modal__label">🔔 Rappel</label>
                                {editingTask.reminder_at && (
                                    <div className="todo-modal__reminder-current">
                                        Rappel actuel : {new Date(editingTask.reminder_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                                        <button
                                            className="todo-modal__reminder-remove"
                                            onClick={() => setEditReminder('')}
                                            title="Supprimer le rappel"
                                        >✕</button>
                                    </div>
                                )}
                                <div className="todo-modal__reminder-shortcuts">
                                    {REMINDER_SHORTCUTS.filter(s => s.offset !== 'custom').map(s => (
                                        <button
                                            key={s.label}
                                            className="todo-modal__reminder-btn"
                                            disabled={!editingTask.due_date}
                                            onClick={() => setEditReminder(s.label)}
                                            title={!editingTask.due_date ? 'Choisissez d\'abord une échéance' : ''}
                                        >
                                            {s.label}
                                        </button>
                                    ))}
                                </div>
                                <div className="todo-modal__reminder-custom">
                                    <label className="todo-modal__label-sm">Ou date/heure personnalisée :</label>
                                    <input
                                        className="todo-modal__input"
                                        type="datetime-local"
                                        value={editingTask.reminder_at ? editingTask.reminder_at.slice(0, 16) : ''}
                                        onChange={e => setEditCustomReminder(e.target.value)}
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="todo-modal__footer">
                            <button
                                className="todo-modal__delete-btn"
                                onClick={() => deleteTask(editingTask.id)}
                            >
                                🗑️ Supprimer
                            </button>
                            <div className="todo-modal__footer-right">
                                <button className="todo-add-form__cancel" onClick={() => setEditingTask(null)}>Annuler</button>
                                <button
                                    className="todo-add-form__submit"
                                    onClick={saveEditModal}
                                    disabled={!editingTask.title?.trim()}
                                >
                                    Enregistrer
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
