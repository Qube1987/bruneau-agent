import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://rzxisqsdsiiuwaixnneo.supabase.co';
const PROXY_URL = `${SUPABASE_URL}/functions/v1/extrabat-proxy`;

const TEAM_MEMBERS = [
    { name: 'Quentin', code: '46516', color: '#6c5ce7' },
    { name: 'Paul', code: '218599', color: '#00cec9' },
    { name: 'Cindy', code: '47191', color: '#fdcb6e' },
    { name: 'Téo', code: '485533', color: '#ff6b6b' },
];

function pad2(n) { return String(n).padStart(2, '0'); }

function toLocalStr(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function defaultStart() {
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    return toLocalStr(d);
}

function defaultEnd() {
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    d.setHours(d.getHours() + 1);
    return toLocalStr(d);
}

function addOneHour(dtStr) {
    const d = new Date(dtStr);
    if (isNaN(d)) return '';
    d.setHours(d.getHours() + 1);
    return toLocalStr(d);
}

export default function CreateAptModal({ onClose, userCode }) {
    const [clientName, setClientName] = useState('');
    const [objet, setObjet] = useState('');
    const [address, setAddress] = useState('');
    const [dateStart, setDateStart] = useState(defaultStart);
    const [dateEnd, setDateEnd] = useState(defaultEnd);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [extrabatClientId, setExtrabatClientId] = useState(null);
    const [supabaseClientId, setSupabaseClientId] = useState(null);

    // Team member selection
    const currentUserCode = userCode || '46516';
    const [selectedCodes, setSelectedCodes] = useState([currentUserCode]);
    const [showTeamPicker, setShowTeamPicker] = useState(false);

    // Client search state
    const [suggestions, setSuggestions] = useState([]);
    const [searching, setSearching] = useState(false);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const debounceRef = useRef(null);
    const skipSearchRef = useRef(false);
    const nameInputRef = useRef(null);

    const canSubmit = dateStart && dateEnd && (clientName.trim() || objet.trim());

    const currentMember = TEAM_MEMBERS.find(m => m.code === currentUserCode) || TEAM_MEMBERS[0];
    const otherMembers = TEAM_MEMBERS.filter(m => m.code !== currentUserCode);

    const toggleTeamMember = (code) => {
        setSelectedCodes(prev => {
            if (prev.includes(code)) {
                // Don't allow removing the last one
                if (prev.length <= 1) return prev;
                return prev.filter(c => c !== code);
            }
            return [...prev, code];
        });
    };

    // ── Auto-sync end = start + 1h ──
    const handleStartChange = (val) => {
        setDateStart(val);
        if (val) setDateEnd(addOneHour(val));
    };

    // ── Client search with debounce ──
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (skipSearchRef.current) { skipSearchRef.current = false; return; }
        const q = clientName.trim();
        if (q.length < 2) { setSuggestions([]); setShowSuggestions(false); return; }

        debounceRef.current = setTimeout(async () => {
            setSearching(true);
            try {
                const { data: { session } } = await supabase.auth.getSession();
                const token = session?.access_token;
                if (!token) { setSearching(false); return; }

                // Split query into words for multi-word search (e.g. "Jean Dupont" → search "Jean" AND "Dupont")
                const words = q.split(/\s+/).filter(w => w.length >= 2);
                const searchWord = words.length > 0 ? words[0] : q;
                // Build safe or-filter using individual words (avoids PostgREST syntax issues with . , ( ) in values)
                const safeWord = searchWord.replace(/[.,()%]/g, '');

                // Search Supabase clients first
                let sbClients = null;
                if (safeWord.length >= 2) {
                    const { data } = await supabase
                        .from('clients')
                        .select('id, nom, prenom, extrabat_id, adresse, code_postal, ville')
                        .or(`nom.ilike.%${safeWord}%,prenom.ilike.%${safeWord}%`)
                        .limit(15);
                    sbClients = data;
                }

                // Client-side filter: if multiple words, filter results to match ALL words
                const qLower = q.toLowerCase();
                const wordsLower = words.map(w => w.toLowerCase());

                const results = [];
                if (sbClients) {
                    sbClients.forEach(c => {
                        const fullName = [c.prenom, c.nom].filter(Boolean).join(' ');
                        const fullNameLower = fullName.toLowerCase();
                        // Client-side: check ALL query words match the full name
                        if (wordsLower.length > 1 && !wordsLower.every(w => fullNameLower.includes(w))) return;
                        const addr = [c.adresse, c.code_postal, c.ville].filter(Boolean).join(', ');
                        results.push({
                            name: fullName,
                            address: addr,
                            extrabatId: c.extrabat_id,
                            supabaseId: c.id,
                            source: 'supabase',
                        });
                    });
                }

                // Also search Extrabat (use first word only — Extrabat API may not handle multi-word well)
                try {
                    const res = await fetch(PROXY_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': token },
                        body: JSON.stringify({ endpoint: 'clients', apiVersion: 'v2', params: { nomraisonsociale: searchWord } }),
                    });
                    const data = await res.json();
                    if (data.success && Array.isArray(data.data)) {
                        data.data.forEach(c => {
                            // Skip duplicates already found in Supabase
                            if (results.some(r => r.extrabatId && r.extrabatId === c.id)) return;
                            // Client-side filter: only keep results that actually match the typed query
                            const extName = (c.nomraisonsociale || c.nom || '').toLowerCase();
                            if (!wordsLower.some(w => extName.includes(w))) return;
                            if (results.length >= 8) return; // cap total results
                            const addr = [c.adresse, c.codePostal, c.ville].filter(Boolean).join(', ');
                            results.push({
                                name: c.nomraisonsociale || c.nom || '',
                                address: addr,
                                extrabatId: c.id,
                                supabaseId: null,
                                source: 'extrabat',
                                _raw: {
                                    nom: c.nomraisonsociale || c.nom || '',
                                    adresse: c.adresse || '',
                                    code_postal: c.codePostal || '',
                                    ville: c.ville || '',
                                    telephone: c.telephone || c.telephones?.[0]?.numero || '',
                                    email: c.email || '',
                                },
                            });
                        });
                    }
                } catch (extErr) {
                    console.warn('[CreateApt] Extrabat search failed:', extErr);
                }

                // Final client-side sort: exact prefix matches first
                results.sort((a, b) => {
                    const aStarts = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
                    const bStarts = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
                    return aStarts - bStarts;
                });

                setSuggestions(results.slice(0, 8));
                setShowSuggestions(results.length > 0);
            } catch (err) {
                console.warn('[CreateApt] Search error:', err);
                setSuggestions([]);
                setShowSuggestions(false);
            }
            setSearching(false);
        }, 350);

        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [clientName]);

    const selectedRawRef = useRef(null);

    const selectClient = (client) => {
        skipSearchRef.current = true;
        setClientName(client.name);
        if (client.address) setAddress(client.address);
        setExtrabatClientId(client.extrabatId || null);
        setSupabaseClientId(client.supabaseId || null);
        selectedRawRef.current = client._raw || null;
        setSuggestions([]);
        setShowSuggestions(false);
    };

    // Ensure the client exists in Supabase (upsert if from Extrabat only)
    const ensureClientInSupabase = async () => {
        // Already in Supabase
        if (supabaseClientId) return supabaseClientId;
        // No Extrabat ID → nothing to link
        if (!extrabatClientId) return null;

        // Client from Extrabat only → upsert into Supabase
        const raw = selectedRawRef.current || {};
        const row = {
            extrabat_id: extrabatClientId,
            nom: raw.nom || clientName.trim(),
            adresse: raw.adresse || address.trim() || null,
            code_postal: raw.code_postal || null,
            ville: raw.ville || null,
            telephone: raw.telephone || null,
            email: raw.email || null,
        };

        const { data, error: upsErr } = await supabase
            .from('clients')
            .upsert(row, { onConflict: 'extrabat_id' })
            .select('id')
            .single();

        if (upsErr) console.warn('[CreateApt] Client upsert failed:', upsErr);
        return data?.id || null;
    };

    const handleSubmit = async () => {
        if (!canSubmit || submitting) return;
        setError('');
        setSubmitting(true);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            const token = session?.access_token;
            if (!token) { setError('Non authentifié'); setSubmitting(false); return; }

            // 1) Ensure client exists in Supabase for traceability
            const sbClientId = await ensureClientInSupabase();

            // 2) Create RDV in Extrabat (linked to extrabat client ID, with all selected technicians)
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
                    technicianCodes: selectedCodes,
                    interventionData: {
                        clientName: clientName.trim() || objet.trim(),
                        systemType: 'rdv',
                        problemDesc: objet.trim(),
                        startedAt,
                        endedAt,
                        address: address.trim() || undefined,
                    },
                    clientId: extrabatClientId || undefined,
                }),
            });

            const data = await res.json();
            if (data.success) {
                // 3) Log RDV in Supabase for local traceability (upsert to avoid duplicates)
                const rdvId = data.data?.id || data.id || null;
                const logRow = {
                    client_id: sbClientId || null,
                    extrabat_client_id: extrabatClientId || null,
                    extrabat_rdv_id: rdvId ? Number(rdvId) : null,
                    objet: objet.trim() || clientName.trim(),
                    started_at: startedAt,
                    ended_at: endedAt,
                    created_by: selectedCodes.join(','),
                };
                if (logRow.extrabat_rdv_id) {
                    await supabase.from('rdv_logs').upsert(logRow, { onConflict: 'extrabat_rdv_id' })
                        .then(({ error: logErr }) => {
                            if (logErr) console.warn('[CreateApt] rdv_logs upsert failed:', logErr.message);
                        });
                } else {
                    await supabase.from('rdv_logs').insert(logRow)
                        .then(({ error: logErr }) => {
                            if (logErr) console.warn('[CreateApt] rdv_logs insert failed:', logErr.message);
                        });
                }
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

    // Selected members summary for display
    const selectedNames = selectedCodes.map(code => {
        const m = TEAM_MEMBERS.find(tm => tm.code === code);
        return m ? m.name : code;
    });

    return (
        <div className="todo-modal-overlay" onClick={() => !submitting && onClose(false)}>
            <div className="todo-modal" onClick={e => e.stopPropagation()}>
                <div className="todo-modal__header">
                    <span className="todo-modal__title">{'\u{1F4C5}'} Nouveau RDV</span>
                    <button className="todo-modal__close" onClick={() => !submitting && onClose(false)}>{'\u2715'}</button>
                </div>
                <div className="todo-modal__body">
                    {/* Team member selector */}
                    <div className="apt-form__field">
                        <label className="apt-form__label">Attribué à</label>
                        <div className="apt-team-selector">
                            <div className="apt-team-selector__main">
                                <div className="apt-team-selector__selected">
                                    {selectedCodes.map(code => {
                                        const m = TEAM_MEMBERS.find(tm => tm.code === code);
                                        if (!m) return null;
                                        return (
                                            <span
                                                key={code}
                                                className="apt-team-selector__chip"
                                                style={{ '--chip-color': m.color }}
                                            >
                                                <span className="apt-team-selector__chip-dot" style={{ background: m.color }} />
                                                {m.name}
                                                {selectedCodes.length > 1 && (
                                                    <button
                                                        className="apt-team-selector__chip-remove"
                                                        onClick={(e) => { e.stopPropagation(); toggleTeamMember(code); }}
                                                        title={`Retirer ${m.name}`}
                                                    >×</button>
                                                )}
                                            </span>
                                        );
                                    })}
                                </div>
                                <button
                                    className={`apt-team-selector__toggle ${showTeamPicker ? 'apt-team-selector__toggle--active' : ''}`}
                                    onClick={() => setShowTeamPicker(!showTeamPicker)}
                                    title="Ajouter des membres"
                                    type="button"
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                        <circle cx="9" cy="7" r="4" />
                                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                                    </svg>
                                </button>
                            </div>
                            {showTeamPicker && (
                                <div className="apt-team-selector__dropdown">
                                    {otherMembers.map(m => {
                                        const isSelected = selectedCodes.includes(m.code);
                                        return (
                                            <button
                                                key={m.code}
                                                className={`apt-team-selector__option ${isSelected ? 'apt-team-selector__option--active' : ''}`}
                                                onClick={() => toggleTeamMember(m.code)}
                                                type="button"
                                            >
                                                <span className="apt-team-selector__option-dot" style={{ background: m.color }} />
                                                <span className="apt-team-selector__option-name">{m.name}</span>
                                                {isSelected && <span className="apt-team-selector__option-check">✓</span>}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="apt-form__field" style={{ position: 'relative' }}>
                        <label className="apt-form__label">Nom client</label>
                        <input
                            ref={nameInputRef}
                            className="todo-modal__input"
                            type="text"
                            placeholder="Ex: M. Dupont"
                            value={clientName}
                            onChange={e => { setClientName(e.target.value); setExtrabatClientId(null); setSupabaseClientId(null); selectedRawRef.current = null; setShowSuggestions(true); }}
                            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                            autoFocus
                        />
                        {searching && <span className="apt-form__search-indicator">{'\u{1F50D}'}</span>}
                        {showSuggestions && suggestions.length > 0 && (
                            <div className="apt-form__suggestions">
                                {suggestions.map((s, i) => (
                                    <button key={i} className="apt-form__suggestion" onClick={() => selectClient(s)}>
                                        <span className="apt-form__suggestion-name">{s.name}</span>
                                        {s.address && <span className="apt-form__suggestion-addr">{s.address}</span>}
                                    </button>
                                ))}
                            </div>
                        )}
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
                                onChange={e => handleStartChange(e.target.value)}
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
