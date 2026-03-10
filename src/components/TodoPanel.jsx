import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { PRIORITIES, CATEGORIES, RECURRENCE_OPTIONS, REMINDER_SHORTCUTS } from '../utils/todoConstants';
import { computeReminderAt, formatDueDate, formatReminderLabel, isOverdue, computeNextDueDate } from '../utils/todoUtils';
import { useSwipe } from '../hooks/useSwipe';

function SwipeableWrapper({ children, onSwipeLeft, onSwipeRight }) {
    const { elRef, onTouchStart, onTouchMove, onTouchEnd } = useSwipe({ onSwipeLeft, onSwipeRight });
    return (
        <div
            ref={elRef}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            className="todo-item__swipeable"
        >
            {children}
        </div>
    );
}

function Stats({ tasks }) {
    const [open, setOpen] = useState(false);
    const now = new Date();
    const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);

    const doneThisWeek = tasks.filter(t => t.status === 'done' && t.completed_at && new Date(t.completed_at) >= weekAgo);
    const totalDone = tasks.filter(t => t.status === 'done' && t.completed_at && t.created_at);

    // Average completion time
    let avgTime = null;
    if (totalDone.length > 0) {
        const totalMs = totalDone.reduce((sum, t) => sum + (new Date(t.completed_at) - new Date(t.created_at)), 0);
        const avgMs = totalMs / totalDone.length;
        const avgHours = avgMs / (1000 * 60 * 60);
        if (avgHours < 24) avgTime = `${Math.round(avgHours)}h`;
        else avgTime = `${Math.round(avgHours / 24)}j`;
    }

    // Category breakdown for done tasks
    const catBreakdown = {};
    for (const t of doneThisWeek) {
        const cat = t.category || 'general';
        catBreakdown[cat] = (catBreakdown[cat] || 0) + 1;
    }

    return (
        <div className="todo-stats">
            <button className="todo-stats__toggle" onClick={() => setOpen(o => !o)}>
                📊 Statistiques {open ? '▾' : '▸'}
            </button>
            {open && (
                <div className="todo-stats__body">
                    <div className="todo-stats__row">
                        <span className="todo-stats__label">Terminées cette semaine</span>
                        <span className="todo-stats__value">{doneThisWeek.length}</span>
                    </div>
                    <div className="todo-stats__row">
                        <span className="todo-stats__label">Temps moyen de complétion</span>
                        <span className="todo-stats__value">{avgTime || '—'}</span>
                    </div>
                    {Object.keys(catBreakdown).length > 0 && (
                        <div className="todo-stats__breakdown">
                            <span className="todo-stats__label">Par catégorie (semaine)</span>
                            <div className="todo-stats__cats">
                                {Object.entries(catBreakdown).map(([cat, count]) => {
                                    const c = CATEGORIES.find(c => c.value === cat);
                                    return (
                                        <span key={cat} className="todo-stats__cat">
                                            {c ? `${c.label} ${c.name}` : cat}: {count}
                                        </span>
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
    const [newRecurrence, setNewRecurrence] = useState('');
    const [completingIds, setCompletingIds] = useState(new Set());
    const [editingTask, setEditingTask] = useState(null);
    const [taskNotes, setTaskNotes] = useState([]);
    const [newNote, setNewNote] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategories, setSelectedCategories] = useState(new Set());
    const [sortBy, setSortBy] = useState(() => localStorage.getItem('todo-sort') || 'priority');
    const [deletedTask, setDeletedTask] = useState(null);
    const deleteTimerRef = useRef(null);
    const addInputRef = useRef(null);

    const searchInputRef = useRef(null);

    useEffect(() => {
        if (showAddForm && addInputRef.current) {
            addInputRef.current.focus();
        }
    }, [showAddForm]);

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e) => {
            // Ignore when typing in input/textarea/select
            const tag = e.target.tagName;
            const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

            if (e.key === 'Escape') {
                if (editingTask) { setEditingTask(null); e.preventDefault(); }
                else if (showAddForm) { setShowAddForm(false); e.preventDefault(); }
                return;
            }

            if (isInput) return;

            if (e.key === 'n' || e.key === 'N') {
                e.preventDefault();
                addInputRef.current?.focus();
            } else if (e.key === '/') {
                e.preventDefault();
                searchInputRef.current?.focus();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [editingTask, showAddForm]);

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
            recurrence: newRecurrence || null,
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
        setNewRecurrence('');
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

        // Spawn next occurrence for recurring tasks
        if (newStatus === 'done' && task.recurrence && task.due_date) {
            const nextDueDate = computeNextDueDate(task.due_date, task.recurrence);
            if (nextDueDate) {
                const nextTask = {
                    title: task.title,
                    description: task.description || '',
                    priority: task.priority,
                    category: task.category,
                    due_date: nextDueDate,
                    recurrence: task.recurrence,
                    recurrence_source_id: task.recurrence_source_id || task.id,
                    reminder_at: task.reminder_at && task.due_date
                        ? new Date(new Date(nextDueDate).getTime() - (new Date(task.due_date).getTime() - new Date(task.reminder_at).getTime())).toISOString()
                        : null,
                    reminder_sent: false,
                    status: 'pending',
                    checklist: task.checklist ? task.checklist.map(i => ({ ...i, done: false })) : [],
                };
                const { data } = await supabase.from('tasks').insert(nextTask).select().single();
                if (data) setTasks(prev => [data, ...prev]);
            }
        }
    };

    const deleteTask = (id, e) => {
        if (e) e.stopPropagation();
        const taskToDelete = tasks.find(t => t.id === id);
        if (!taskToDelete) return;

        // Cancel any previous pending delete
        if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);

        setTasks(prev => prev.filter(t => t.id !== id));
        if (editingTask?.id === id) setEditingTask(null);
        setDeletedTask(taskToDelete);

        deleteTimerRef.current = setTimeout(async () => {
            await supabase.from('tasks').delete().eq('id', id);
            setDeletedTask(null);
            deleteTimerRef.current = null;
        }, 5000);
    };

    const undoDelete = () => {
        if (!deletedTask) return;
        if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
        setTasks(prev => [deletedTask, ...prev]);
        setDeletedTask(null);
    };

    const toggleMyDay = async (task, e) => {
        e.stopPropagation();
        const today = new Date().toISOString().split('T')[0];
        const newVal = task.my_day_date ? null : today;
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, my_day_date: newVal } : t));
        await supabase.from('tasks').update({ my_day_date: newVal }).eq('id', task.id);
    };

    // Drag & drop for manual ordering
    const dragItem = useRef(null);
    const dragOverItem = useRef(null);

    const handleDragStart = (idx) => { dragItem.current = idx; };
    const handleDragEnter = (idx) => { dragOverItem.current = idx; };
    const handleDragEnd = async () => {
        if (dragItem.current === null || dragOverItem.current === null || dragItem.current === dragOverItem.current) {
            dragItem.current = null;
            dragOverItem.current = null;
            return;
        }
        const reordered = [...filtered];
        const [moved] = reordered.splice(dragItem.current, 1);
        reordered.splice(dragOverItem.current, 0, moved);

        // Assign new positions
        const updates = reordered.map((t, i) => ({ id: t.id, position: i }));
        setTasks(prev => prev.map(t => {
            const u = updates.find(u => u.id === t.id);
            return u ? { ...t, position: u.position } : t;
        }));

        // Batch update DB
        for (const u of updates) {
            supabase.from('tasks').update({ position: u.position }).eq('id', u.id).then(() => {});
        }

        dragItem.current = null;
        dragOverItem.current = null;
    };

    const openEditModal = async (task) => {
        setEditingTask({ ...task });
        setTaskNotes([]);
        setNewNote('');
        const { data } = await supabase
            .from('task_notes')
            .select('*')
            .eq('task_id', task.id)
            .order('created_at', { ascending: true });
        if (data) setTaskNotes(data);
    };

    const addNote = async () => {
        if (!newNote.trim() || !editingTask) return;
        const note = { task_id: editingTask.id, content: newNote.trim() };
        const { data } = await supabase.from('task_notes').insert(note).select().single();
        if (data) setTaskNotes(prev => [...prev, data]);
        setNewNote('');
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
            checklist: editingTask.checklist || [],
            recurrence: editingTask.recurrence || null,
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
    const searchLower = searchQuery.toLowerCase();
    const filtered = tasks
        .filter(t => {
            if (filter === 'active') return t.status !== 'done';
            if (filter === 'done') return t.status === 'done';
            return true;
        })
        .filter(t => {
            if (!searchLower) return true;
            return (t.title || '').toLowerCase().includes(searchLower) ||
                   (t.description || '').toLowerCase().includes(searchLower);
        })
        .filter(t => {
            if (selectedCategories.size === 0) return true;
            return selectedCategories.has(t.category || 'general');
        })
        .sort((a, b) => {
            if (a.status === 'done' && b.status !== 'done') return 1;
            if (a.status !== 'done' && b.status === 'done') return -1;
            const pOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
            if (sortBy === 'priority') {
                if (pOrder[a.priority] !== pOrder[b.priority]) return pOrder[a.priority] - pOrder[b.priority];
                if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
                if (a.due_date) return -1;
                if (b.due_date) return 1;
            } else if (sortBy === 'due_date') {
                if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
                if (a.due_date) return -1;
                if (b.due_date) return 1;
                if (pOrder[a.priority] !== pOrder[b.priority]) return pOrder[a.priority] - pOrder[b.priority];
            } else if (sortBy === 'category') {
                const catOrder = CATEGORIES.map(c => c.value);
                const ai = catOrder.indexOf(a.category || 'general');
                const bi = catOrder.indexOf(b.category || 'general');
                if (ai !== bi) return ai - bi;
            } else if (sortBy === 'created_at') {
                return new Date(b.created_at) - new Date(a.created_at);
            } else if (sortBy === 'manual') {
                const pa = a.position ?? 999999;
                const pb = b.position ?? 999999;
                if (pa !== pb) return pa - pb;
                return new Date(b.created_at) - new Date(a.created_at);
            }
            return new Date(b.created_at) - new Date(a.created_at);
        });

    const activeCount = tasks.filter(t => t.status !== 'done').length;
    const doneCount = tasks.filter(t => t.status === 'done').length;
    const overdueCount = tasks.filter(t => isOverdue(t)).length;

    // Group active tasks by date section
    const groupTasksByDate = (taskList) => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);

        const groups = { overdue: [], today: [], tomorrow: [], thisWeek: [], later: [], noDate: [] };
        for (const t of taskList) {
            if (!t.due_date) { groups.noDate.push(t); continue; }
            const dueDay = new Date(new Date(t.due_date).getFullYear(), new Date(t.due_date).getMonth(), new Date(t.due_date).getDate());
            if (dueDay < today) groups.overdue.push(t);
            else if (dueDay.getTime() === today.getTime()) groups.today.push(t);
            else if (dueDay.getTime() === tomorrow.getTime()) groups.tomorrow.push(t);
            else if (dueDay < weekEnd) groups.thisWeek.push(t);
            else groups.later.push(t);
        }
        return [
            { key: 'overdue', label: '🔥 En retard', tasks: groups.overdue, className: 'todo-group--overdue' },
            { key: 'today', label: "📌 Aujourd'hui", tasks: groups.today },
            { key: 'tomorrow', label: '📅 Demain', tasks: groups.tomorrow },
            { key: 'thisWeek', label: '🗓️ Cette semaine', tasks: groups.thisWeek },
            { key: 'later', label: '📆 Plus tard', tasks: groups.later },
            { key: 'noDate', label: '📝 Sans date', tasks: groups.noDate },
        ].filter(g => g.tasks.length > 0);
    };

    const useGrouping = filter === 'active' && !searchQuery;
    const groups = useGrouping ? groupTasksByDate(filtered) : null;

    const renderTaskItem = (task, idx) => {
        const pri = PRIORITIES.find(p => p.value === task.priority) || PRIORITIES[2];
        const cat = CATEGORIES.find(c => c.value === task.category);
        const overdue = isOverdue(task);
        const completing = completingIds.has(task.id);

        const isManual = sortBy === 'manual';

        return (
            <div
                key={task.id}
                className={`todo-item__swipe-container ${isManual ? 'todo-item__swipe-container--draggable' : ''}`}
                draggable={isManual}
                onDragStart={isManual ? () => handleDragStart(idx) : undefined}
                onDragEnter={isManual ? () => handleDragEnter(idx) : undefined}
                onDragEnd={isManual ? handleDragEnd : undefined}
                onDragOver={isManual ? (e) => e.preventDefault() : undefined}
            >
                <div className="todo-item__swipe-bg todo-item__swipe-bg--complete">✓</div>
                <div className="todo-item__swipe-bg todo-item__swipe-bg--delete">🗑️</div>
                <SwipeableWrapper
                    onSwipeRight={() => toggleComplete(task, { stopPropagation: () => {} })}
                    onSwipeLeft={() => deleteTask(task.id)}
                >
                    <div
                        className={`todo-item ${task.status === 'done' ? 'todo-item--done' : ''} ${overdue ? 'todo-item--overdue' : ''} ${completing ? 'todo-item--completing' : ''}`}
                        onClick={() => openEditModal(task)}
                        style={{ cursor: 'pointer' }}
                    >
                        <button
                            className={`todo-checkbox ${task.status === 'done' ? 'todo-checkbox--checked' : ''}`}
                            style={{ borderColor: pri.color, background: task.status === 'done' ? pri.color : 'transparent' }}
                            onClick={(e) => toggleComplete(task, e)}
                            title={task.status === 'done' ? 'Marquer non terminée' : 'Marquer terminée'}
                        >
                            {task.status === 'done' && <span className="todo-checkbox__check">✓</span>}
                        </button>
                        <div className="todo-item__content">
                            <div className="todo-item__title">{task.title}</div>
                            {task.description && <div className="todo-item__description">{task.description}</div>}
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
                                {task.checklist && task.checklist.length > 0 && (
                                    <span className="todo-item__checklist-progress">
                                        ☑ {task.checklist.filter(i => i.done).length}/{task.checklist.length}
                                    </span>
                                )}
                                {task.recurrence && (
                                    <span className="todo-item__recurrence">
                                        🔁 {RECURRENCE_OPTIONS.find(r => r.value === task.recurrence)?.label || task.recurrence}
                                    </span>
                                )}
                            </div>
                        </div>
                        <button
                            className={`todo-item__myday ${task.my_day_date ? 'todo-item__myday--active' : ''}`}
                            onClick={(e) => toggleMyDay(task, e)}
                            title={task.my_day_date ? 'Retirer de Ma Journée' : 'Ajouter à Ma Journée'}
                        >
                            ☀️
                        </button>
                        <div className="todo-item__priority" style={{ color: pri.color }} title={pri.name}>
                            {pri.label}
                        </div>
                        <div className="todo-item__actions" onClick={e => e.stopPropagation()}>
                            <button className="todo-item__delete" onClick={(e) => deleteTask(task.id, e)} title="Supprimer">🗑️</button>
                        </div>
                    </div>
                </SwipeableWrapper>
            </div>
        );
    };

    return (
        <div className="todo-panel" style={{ overflowY: 'auto', maxHeight: '45vh', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Header bar */}
            <div className="todo-header">
                <div className="todo-header__filters">
                    <button className={`todo-filter ${filter === 'active' ? 'todo-filter--active' : ''}`} onClick={() => setFilter('active')}>
                        En cours {activeCount > 0 && <span className="todo-filter__count">{activeCount}</span>}
                    </button>
                    <button className={`todo-filter ${filter === 'done' ? 'todo-filter--active' : ''}`} onClick={() => setFilter('done')}>
                        Terminées {doneCount > 0 && <span className="todo-filter__count">{doneCount}</span>}
                    </button>
                    <button className={`todo-filter ${filter === 'all' ? 'todo-filter--active' : ''}`} onClick={() => setFilter('all')}>
                        Toutes
                    </button>
                </div>
                <div className="todo-header__right">
                    {overdueCount > 0 && (
                        <span className="todo-overdue-badge">🔥 {overdueCount}</span>
                    )}
                    <select
                        className="todo-sort-select"
                        value={sortBy}
                        onChange={e => { setSortBy(e.target.value); localStorage.setItem('todo-sort', e.target.value); }}
                        title="Trier par"
                    >
                        <option value="priority">↕ Priorité</option>
                        <option value="due_date">↕ Échéance</option>
                        <option value="category">↕ Catégorie</option>
                        <option value="created_at">↕ Récent</option>
                        <option value="manual">↕ Manuel</option>
                    </select>
                </div>
            </div>

            {/* Category chips */}
            <div className="todo-category-chips">
                {CATEGORIES.map(c => {
                    const isSelected = selectedCategories.has(c.value);
                    return (
                        <button
                            key={c.value}
                            className={`todo-category-chip ${isSelected ? 'todo-category-chip--active' : ''}`}
                            onClick={() => setSelectedCategories(prev => {
                                const next = new Set(prev);
                                if (next.has(c.value)) next.delete(c.value); else next.add(c.value);
                                return next;
                            })}
                        >
                            {c.label} {c.name}
                        </button>
                    );
                })}
                {selectedCategories.size > 0 && (
                    <button className="todo-category-chip todo-category-chip--clear" onClick={() => setSelectedCategories(new Set())}>
                        ✕
                    </button>
                )}
            </div>

            {/* Search bar */}
            <div className="todo-search">
                <span className="todo-search__icon">🔍</span>
                <input
                    ref={searchInputRef}
                    className="todo-search__input"
                    type="text"
                    placeholder="Rechercher une tâche... ( / )"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                    <button className="todo-search__clear" onClick={() => setSearchQuery('')}>✕</button>
                )}
            </div>

            {/* Quick-add input (always visible) + expandable options */}
            <div className="todo-add-form">
                <div className="todo-add-form__quick-row">
                    <span className="todo-add-btn__icon">+</span>
                    <input
                        ref={addInputRef}
                        className="todo-add-form__input"
                        type="text"
                        placeholder="Nouvelle tâche... (Entrée pour ajouter)"
                        value={newTitle}
                        onChange={e => setNewTitle(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) addTask(); if (e.key === 'Escape') { setShowAddForm(false); e.target.blur(); } }}
                        onFocus={() => setShowAddForm(true)}
                    />
                    {newTitle.trim() && !showAddForm && (
                        <button className="todo-add-form__submit" onClick={addTask}>Ajouter</button>
                    )}
                </div>
                {showAddForm && (
                    <div className="todo-add-form__expanded">
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
                            <div className="todo-add-form__date-wrapper">
                                <label className="todo-add-form__date-label">🔁 Récurrence</label>
                                <select
                                    className="todo-add-form__select"
                                    value={newRecurrence}
                                    onChange={e => setNewRecurrence(e.target.value)}
                                >
                                    {RECURRENCE_OPTIONS.map(r => (
                                        <option key={r.value} value={r.value}>{r.label}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="todo-add-form__actions">
                            <button className="todo-add-form__submit" onClick={addTask} disabled={!newTitle.trim()}>Ajouter</button>
                            <button className="todo-add-form__cancel" onClick={() => setShowAddForm(false)}>Replier</button>
                        </div>
                    </div>
                )}
            </div>

            {/* Task list */}
            {externalLoading && tasks.length === 0 ? (
                <div className="agenda-panel__empty"><span>⟳</span><p>Chargement...</p></div>
            ) : filtered.length === 0 ? (
                <div className="agenda-panel__empty">
                    <span>{filter === 'done' ? '🎉' : '✨'}</span>
                    <p>{filter === 'done' ? 'Aucune tâche terminée' : 'Aucune tâche en cours'}</p>
                </div>
            ) : useGrouping && groups ? (
                <div className="todo-list">
                    {groups.map(group => (
                        <div key={group.key} className={`todo-group ${group.className || ''}`}>
                            <div className="todo-group__header">
                                <span className="todo-group__label">{group.label}</span>
                                <span className="todo-group__count">{group.tasks.length}</span>
                            </div>
                            {group.tasks.map((task, idx) => renderTaskItem(task, idx))}
                        </div>
                    ))}
                </div>
            ) : (
                <div className="todo-list">
                    {filtered.map((task, idx) => renderTaskItem(task, idx))}
                </div>
            )}

            {/* Undo Delete Toast */}
            {deletedTask && (
                <div className="todo-toast">
                    <span>Tâche supprimée</span>
                    <button className="todo-toast__undo" onClick={undoDelete}>Annuler</button>
                </div>
            )}

            {/* Stats section */}
            <Stats tasks={tasks} />

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

                            {/* Recurrence */}
                            <div className="todo-modal__field">
                                <label className="todo-modal__label">🔁 Récurrence</label>
                                <select
                                    className="todo-modal__select"
                                    value={editingTask.recurrence || ''}
                                    onChange={e => setEditingTask(prev => ({ ...prev, recurrence: e.target.value || null }))}
                                >
                                    {RECURRENCE_OPTIONS.map(r => (
                                        <option key={r.value} value={r.value}>{r.label}</option>
                                    ))}
                                </select>
                            </div>

                            {/* Checklist / Sub-tasks */}
                            <div className="todo-modal__field">
                                <label className="todo-modal__label">☑️ Checklist</label>
                                <div className="todo-checklist">
                                    {(editingTask.checklist || []).map((item, idx) => (
                                        <div key={idx} className="todo-checklist__item">
                                            <button
                                                className={`todo-checklist__check ${item.done ? 'todo-checklist__check--done' : ''}`}
                                                onClick={() => setEditingTask(prev => {
                                                    const cl = [...(prev.checklist || [])];
                                                    cl[idx] = { ...cl[idx], done: !cl[idx].done };
                                                    return { ...prev, checklist: cl };
                                                })}
                                            >
                                                {item.done ? '✓' : ''}
                                            </button>
                                            <input
                                                className={`todo-checklist__text ${item.done ? 'todo-checklist__text--done' : ''}`}
                                                value={item.text}
                                                onChange={e => setEditingTask(prev => {
                                                    const cl = [...(prev.checklist || [])];
                                                    cl[idx] = { ...cl[idx], text: e.target.value };
                                                    return { ...prev, checklist: cl };
                                                })}
                                                placeholder="Sous-tâche..."
                                            />
                                            <button
                                                className="todo-checklist__remove"
                                                onClick={() => setEditingTask(prev => ({
                                                    ...prev,
                                                    checklist: (prev.checklist || []).filter((_, i) => i !== idx),
                                                }))}
                                            >✕</button>
                                        </div>
                                    ))}
                                    <button
                                        className="todo-checklist__add"
                                        onClick={() => setEditingTask(prev => ({
                                            ...prev,
                                            checklist: [...(prev.checklist || []), { text: '', done: false }],
                                        }))}
                                    >
                                        + Ajouter un élément
                                    </button>
                                </div>
                            </div>

                            {/* Notes */}
                            <div className="todo-modal__field">
                                <label className="todo-modal__label">💬 Notes</label>
                                <div className="todo-notes">
                                    {taskNotes.map(note => (
                                        <div key={note.id} className="todo-notes__item">
                                            <div className="todo-notes__content">{note.content}</div>
                                            <div className="todo-notes__time">
                                                {new Date(note.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                                            </div>
                                        </div>
                                    ))}
                                    <div className="todo-notes__add">
                                        <input
                                            className="todo-notes__input"
                                            type="text"
                                            placeholder="Ajouter une note..."
                                            value={newNote}
                                            onChange={e => setNewNote(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') addNote(); }}
                                        />
                                        <button className="todo-notes__btn" onClick={addNote} disabled={!newNote.trim()}>+</button>
                                    </div>
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
