export function computeReminderAt(dueDate, shortcut) {
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

export function formatDueDate(d) {
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

export function formatReminderLabel(reminderAt, dueDate) {
    if (!reminderAt) return '';
    const r = new Date(reminderAt);
    if (!dueDate) return r.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const d = new Date(dueDate);
    const diff = d.getTime() - r.getTime();
    if (diff <= 6 * 60 * 1000) return '5 min avant';
    if (diff <= 16 * 60 * 1000) return '15 min avant';
    if (diff <= 61 * 60 * 1000) return '1h avant';
    if (diff >= 6.5 * 24 * 60 * 60 * 1000) return '1 sem. avant';
    const veille = new Date(d);
    veille.setDate(veille.getDate() - 1);
    veille.setHours(20, 0, 0, 0);
    if (Math.abs(r.getTime() - veille.getTime()) < 60000) return 'La veille 20h';
    return r.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export function isOverdue(task) {
    if (!task.due_date || task.status === 'done') return false;
    return new Date(task.due_date) < new Date(new Date().toDateString());
}

export function computeNextDueDate(dueDate, recurrence) {
    if (!dueDate || !recurrence) return null;
    const d = new Date(dueDate);
    switch (recurrence) {
        case 'daily': d.setDate(d.getDate() + 1); break;
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'biweekly': d.setDate(d.getDate() + 14); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
        default: return null;
    }
    return d.toISOString();
}
