export const PRIORITIES = [
    { value: 'urgent', label: '🔴', color: '#ff6b6b', name: 'Urgent' },
    { value: 'high', label: '🟠', color: '#fdcb6e', name: 'Haute' },
    { value: 'medium', label: '🔵', color: '#6c5ce7', name: 'Moyenne' },
    { value: 'low', label: '⚪', color: '#636e72', name: 'Basse' },
];

export const CATEGORIES = [
    { value: 'general', label: '📌', name: 'Général' },
    { value: 'client', label: '👤', name: 'Client' },
    { value: 'sav', label: '🔧', name: 'SAV' },
    { value: 'commercial', label: '💼', name: 'Commercial' },
    { value: 'admin', label: '📋', name: 'Admin' },
    { value: 'perso', label: '🏠', name: 'Perso' },
];

export const RECURRENCE_OPTIONS = [
    { value: '', label: 'Aucune' },
    { value: 'daily', label: 'Chaque jour' },
    { value: 'weekly', label: 'Chaque semaine' },
    { value: 'biweekly', label: 'Toutes les 2 sem.' },
    { value: 'monthly', label: 'Chaque mois' },
];

export const REMINDER_SHORTCUTS = [
    { label: '5 min avant', offset: -5 * 60 * 1000 },
    { label: '15 min avant', offset: -15 * 60 * 1000 },
    { label: '1h avant', offset: -60 * 60 * 1000 },
    { label: 'La veille à 20h', offset: 'veille' },
    { label: '1 semaine avant', offset: -7 * 24 * 60 * 60 * 1000 },
    { label: 'Personnalisé...', offset: 'custom' },
];
