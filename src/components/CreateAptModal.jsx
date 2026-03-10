import { useState } from 'react';
import { supabase } from '../lib/supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://rzxisqsdsiiuwaixnneo.supabase.co';
const PROXY_URL = `${SUPABASE_URL}/functions/v1/extrabat-proxy`;

function pad2(n) { return String(n).padStart(2, '0'); }

function defaultStart() {
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function defaultEnd() {
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    d.setHours(d.getHours() + 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export default function CreateAptModal({ onClose, userCode }) {
    const [clientName, setClientName] = useState('');
    const [objet, setObjet] = useState('');
    const [address, setAddress] = useState('');
    const [dateStart, setDateStart] = useState(defaultStart);
    const [dateEnd, setDateEnd] = useState(defaultEnd);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const canSubmit = dateStart && dateEnd && (clientName.trim() || objet.trim());

    const handleSubmit = async () => {
        if (!canSubmit || submitting) return;
        setError('');
        setSubmitting(true);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            const token = session?.access_token;
            if (!token) { setError('Non authentifié'); setSubmitting(false); return; }

            const startedAt = dateStart.replace('T', ' ') + ':00';
            const endedAt = dateEnd.replace('T', ' ') + ':00';

            const res = await fetch(PROXY_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'apikey': token,
                },
                body: JSON.stringify({
                    technicianCodes: [userCode || '46516'],
                    interventionData: {
                        clientName: clientName.trim() || objet.trim(),
                        systemType: 'rdv',
                        problemDesc: objet.trim(),
                        startedAt,
                        endedAt,
                        address: address.trim() || undefined,
                    },
                }),
            });

            const data = await res.json();
            if (data.success) {
                onClose(true);
            } else {
                setError(data.error || 'Erreur inconnue');
            }
        } catch (e) {
            setError(e.message || 'Erreur réseau');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="todo-modal-overlay" onClick={() => !submitting && onClose(false)}>
            <div className="todo-modal" onClick={e => e.stopPropagation()}>
                <div className="todo-modal__header">
                    <span className="todo-modal__title">{'\u{1F4C5}'} Nouveau RDV</span>
                    <button className="todo-modal__close" onClick={() => !submitting && onClose(false)}>{'\u2715'}</button>
                </div>
                <div className="todo-modal__body">
                    <div className="apt-form__field">
                        <label className="apt-form__label">Nom client</label>
                        <input
                            className="todo-modal__input"
                            type="text"
                            placeholder="Ex: M. Dupont"
                            value={clientName}
                            onChange={e => setClientName(e.target.value)}
                            autoFocus
                        />
                    </div>
                    <div className="apt-form__field">
                        <label className="apt-form__label">Objet</label>
                        <input
                            className="todo-modal__input"
                            type="text"
                            placeholder="Ex: Installation alarme"
                            value={objet}
                            onChange={e => setObjet(e.target.value)}
                        />
                    </div>
                    <div className="apt-form__field">
                        <label className="apt-form__label">Adresse</label>
                        <input
                            className="todo-modal__input"
                            type="text"
                            placeholder="Optionnel"
                            value={address}
                            onChange={e => setAddress(e.target.value)}
                        />
                    </div>
                    <div className="apt-form__row">
                        <div className="apt-form__field" style={{ flex: 1 }}>
                            <label className="apt-form__label">Début *</label>
                            <input
                                className="todo-modal__input"
                                type="datetime-local"
                                value={dateStart}
                                onChange={e => setDateStart(e.target.value)}
                                required
                            />
                        </div>
                        <div className="apt-form__field" style={{ flex: 1 }}>
                            <label className="apt-form__label">Fin *</label>
                            <input
                                className="todo-modal__input"
                                type="datetime-local"
                                value={dateEnd}
                                onChange={e => setDateEnd(e.target.value)}
                                required
                            />
                        </div>
                    </div>
                    {!clientName.trim() && !objet.trim() && (
                        <div className="apt-form__hint">* Nom ou objet requis</div>
                    )}
                    {error && <div className="apt-form__error">{error}</div>}
                </div>
                <div className="todo-modal__footer">
                    <button className="btn btn--cancel" onClick={() => !submitting && onClose(false)} disabled={submitting}>
                        Annuler
                    </button>
                    <button className="btn btn--confirm" onClick={handleSubmit} disabled={!canSubmit || submitting}>
                        {submitting ? 'Création...' : 'Créer le RDV'}
                    </button>
                </div>
            </div>
        </div>
    );
}
