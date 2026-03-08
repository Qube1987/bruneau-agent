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

function formatDueDate(d) {
    if (!d) return '';
    const date = new Date(d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const taskDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (taskDay.getTime() === today.getTime()) return "Aujourd'hui";
    if (taskDay.getTime() === tomorrow.getTime()) return 'Demain';
    if (taskDay < today) return 'En retard';

    const diff = Math.ceil((taskDay - today) / (1000 * 60 * 60 * 24));
    if (diff <= 7) {
        const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
        return days[date.getDay()];
    }
    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function isOverdue(task) {
    if (!task.due_date || task.status === 'done') return false;
    return new Date(task.due_date) < new Date(new Date().toDateString());
}

export default function TodoPanel({ tasks, setTasks, loading: externalLoading }) {
    const [filter, setFilter] = useState('active'); // active, done, all
    const [showAddForm, setShowAddForm] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newPriority, setNewPriority] = useState('medium');
    const [newCategory, setNewCategory] = useState('general');
    const [newDueDate, setNewDueDate] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [editTitle, setEditTitle] = useState('');
    const [completingIds, setCompletingIds] = useState(new Set());
    const addInputRef = useRef(null);

    useEffect(() => {
        if (showAddForm && addInputRef.current) {
            addInputRef.current.focus();
        }
    }, [showAddForm]);

    const addTask = async () => {
        const title = newTitle.trim();
        if (!title) return;

        const newTask = {
            title,
            priority: newPriority,
            category: newCategory,
            due_date: newDueDate ? new Date(newDueDate).toISOString() : null,
            status: 'pending',
        };

        // Optimistic add
        const tempId = 'temp-' + Date.now();
        setTasks(prev => [{ ...newTask, id: tempId, created_at: new Date().toISOString() }, ...prev]);
        setNewTitle('');
        setNewPriority('medium');
        setNewCategory('general');
        setNewDueDate('');
        setShowAddForm(false);

        const { data, error } = await supabase.from('tasks').insert(newTask).select().single();
        if (data) {
            setTasks(prev => prev.map(t => t.id === tempId ? data : t));
        } else if (error) {
            console.error('Error adding task:', error);
            setTasks(prev => prev.filter(t => t.id !== tempId));
        }
    };

    const toggleComplete = async (task) => {
        const newStatus = task.status === 'done' ? 'pending' : 'done';
        const completedAt = newStatus === 'done' ? new Date().toISOString() : null;

        if (newStatus === 'done') {
            // Animate before removing
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

    const deleteTask = async (id) => {
        setTasks(prev => prev.filter(t => t.id !== id));
        await supabase.from('tasks').delete().eq('id', id);
    };

    const startEdit = (task) => {
        setEditingId(task.id);
        setEditTitle(task.title);
    };

    const saveEdit = async (task) => {
        const title = editTitle.trim();
        if (!title) return;
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, title } : t));
        setEditingId(null);
        await supabase.from('tasks').update({ title }).eq('id', task.id);
    };

    const updatePriority = async (task, priority) => {
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, priority } : t));
        await supabase.from('tasks').update({ priority }).eq('id', task.id);
    };

    const updateDueDate = async (task, due_date) => {
        const val = due_date ? new Date(due_date).toISOString() : null;
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, due_date: val } : t));
        await supabase.from('tasks').update({ due_date: val }).eq('id', task.id);
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
                        placeholder="Titre de la tâche..."
                        value={newTitle}
                        onChange={e => setNewTitle(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') addTask(); if (e.key === 'Escape') setShowAddForm(false); }}
                    />
                    <div className="todo-add-form__options">
                        <select className="todo-add-form__select" value={newPriority} onChange={e => setNewPriority(e.target.value)}>
                            {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label} {p.name}</option>)}
                        </select>
                        <select className="todo-add-form__select" value={newCategory} onChange={e => setNewCategory(e.target.value)}>
                            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label} {c.name}</option>)}
                        </select>
                        <input className="todo-add-form__date" type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)} />
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
                            >
                                {/* Checkbox */}
                                <button
                                    className={`todo-checkbox ${task.status === 'done' ? 'todo-checkbox--checked' : ''}`}
                                    style={{ borderColor: pri.color, background: task.status === 'done' ? pri.color : 'transparent' }}
                                    onClick={() => toggleComplete(task)}
                                    title={task.status === 'done' ? 'Marquer non terminée' : 'Marquer terminée'}
                                >
                                    {task.status === 'done' && <span className="todo-checkbox__check">✓</span>}
                                </button>

                                {/* Content */}
                                <div className="todo-item__content">
                                    {editingId === task.id ? (
                                        <input
                                            className="todo-item__edit-input"
                                            value={editTitle}
                                            onChange={e => setEditTitle(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') saveEdit(task); if (e.key === 'Escape') setEditingId(null); }}
                                            onBlur={() => saveEdit(task)}
                                            autoFocus
                                        />
                                    ) : (
                                        <div className="todo-item__title" onDoubleClick={() => startEdit(task)}>
                                            {task.title}
                                        </div>
                                    )}
                                    <div className="todo-item__meta">
                                        {cat && <span className="todo-item__category">{cat.label} {cat.name}</span>}
                                        {task.due_date && (
                                            <span className={`todo-item__due ${overdue ? 'todo-item__due--overdue' : ''}`}>
                                                📅 {formatDueDate(task.due_date)}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Priority indicator */}
                                <div className="todo-item__priority" style={{ color: pri.color }} title={pri.name}>
                                    {pri.label}
                                </div>

                                {/* Actions */}
                                <div className="todo-item__actions">
                                    <input
                                        type="date"
                                        className="todo-item__date-picker"
                                        value={task.due_date ? task.due_date.split('T')[0] : ''}
                                        onChange={e => updateDueDate(task, e.target.value)}
                                        title="Échéance"
                                    />
                                    <select
                                        className="todo-item__priority-select"
                                        value={task.priority}
                                        onChange={e => updatePriority(task, e.target.value)}
                                        title="Priorité"
                                    >
                                        {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                                    </select>
                                    <button className="todo-item__delete" onClick={() => deleteTask(task.id)} title="Supprimer">🗑️</button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
