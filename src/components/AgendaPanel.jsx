import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { supabase } from '../lib/supabase';
import TodoPanel from './TodoPanel';
import CreateAptModal from './CreateAptModal';
import { useOfflineCache } from '../hooks/useOfflineCache';
import {
    isSameDay, formatDateYMD, pad2, getWeekStart,
    DAYS_FR_SHORT, MONTHS_FR,
} from '../utils/agendaUtils';

const TEAM_MEMBERS = [
    { name: 'Quentin', code: '46516', color: '#6c5ce7' },
    { name: 'Paul', code: '218599', color: '#00cec9' },
    { name: 'Cindy', code: '47191', color: '#fdcb6e' },
    { name: 'Téo', code: '485533', color: '#ff6b6b' },
];

const HOUR_START = 7;
const HOUR_END = 19;
const HOUR_HEIGHT = 40;
const TOTAL_HOURS = HOUR_END - HOUR_START;

function parseAptDate(dateStr) {
    if (!dateStr) return null;
    try {
        return new Date(dateStr.replace(' ', 'T'));
    } catch { return null; }
}

function AddressLink({ address }) {
    if (!address) return null;
    const geoUrl = `geo:0,0?q=${encodeURIComponent(address)}`;
    return (
        <a href={geoUrl} className="linkable linkable--address" onClick={(e) => e.stopPropagation()}>
            &#128205; {address}
        </a>
    );
}

const SMS_TEMPLATE = `Bonjour, je suis en route et serai chez vous dans XX min.\nCordialement,\nQuentin Bruneau\nSté Bruneau Protection`;

function PhoneLink({ phone }) {
    if (!phone) return null;
    const cleaned = phone.replace(/[\s.]/g, '');
    const smsBody = encodeURIComponent(SMS_TEMPLATE);
    return (
        <span className="linkable-group" onClick={(e) => e.stopPropagation()}>
            <a href={`tel:${cleaned}`} className="linkable linkable--phone">&#128222; {phone}</a>
            <a href={`sms:${cleaned}?body=${smsBody}`} className="linkable linkable--sms" title="Envoyer un SMS">&#9993;</a>
        </span>
    );
}

function EmailLink({ email }) {
    if (!email) return null;
    return (
        <a href={`mailto:${email}`} className="linkable linkable--email" onClick={(e) => e.stopPropagation()}>
            &#9993; {email}
        </a>
    );
}

function extractAddr(val) {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
        return [val.description, val.codePostal, val.ville].filter(Boolean).join(', ');
    }
    return '';
}

function parseRawApts(rawData, userCode, member) {
    const result = [];
    const apts = Array.isArray(rawData) ? rawData : Object.values(rawData);
    apts.forEach(apt => {
        const objet = apt.objet || apt.titre || apt.title || apt.label || '';
        let clientName = '';
        if (apt.clients && apt.clients.length > 0 && apt.clients[0].nom) {
            clientName = apt.clients[0].nom;
        } else if (apt.rdvClients?.[0]?.nom) {
            clientName = apt.rdvClients[0].nom;
        } else if (apt.client_nom) {
            clientName = apt.client_nom;
        } else if (apt.client?.nom) {
            clientName = apt.client.nom;
        }
        const start = parseAptDate(apt.debut);
        const end = parseAptDate(apt.fin);
        if (start && end) {
            result.push({
                id: apt.id,
                _clientName: clientName,
                _objet: typeof objet === 'string' ? objet : '',
                _title: clientName || (typeof objet === 'string' ? objet : '') || '(sans titre)',
                _userCode: userCode,
                _userName: member?.name || userCode,
                _color: member?.color || '#6c5ce7',
                _start: start,
                _end: end,
                _address: extractAddr(apt.lieu) || extractAddr(apt.adresse) || extractAddr(apt.address) || '',
                _phone: (() => {
                    const p = apt.telephone || apt.phone || '';
                    return typeof p === 'string' ? p : '';
                })(),
            });
        }
    });
    return result;
}

const AgendaPanel = forwardRef(function AgendaPanel({ onDataReady, userCode, userName }, ref) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState('agenda');
    const [savs, setSavs] = useState([]);
    const [opps, setOpps] = useState([]);
    const [selectedUsers, setSelectedUsers] = useState(() => {
        try {
            const saved = localStorage.getItem('agenda_selected_users');
            if (saved) return JSON.parse(saved);
        } catch { }
        return [TEAM_MEMBERS[0].code];
    });
    const [activeAptData, setActiveAptData] = useState(null);
    const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
    const [loading, setLoading] = useState(false);
    const [isFullScreen, setIsFullScreen] = useState(false);
    const [focusedDayIndex, setFocusedDayIndex] = useState(null);
    const [selectedSav, setSelectedSav] = useState(null);
    const [savInterventions, setSavInterventions] = useState([]);
    const [savInterventionsLoading, setSavInterventionsLoading] = useState(false);
    const [dbUsers, setDbUsers] = useState([]);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const panelRef = useRef(null);

    // ── Offline cache ──
    const { cacheAppointments, loadCachedAppointments, cacheTasks, loadCachedTasks } = useOfflineCache();

    // ── Background cache ──
    const [teamAptsCache, setTeamAptsCache] = useState({});
    const [cacheLoading, setCacheLoading] = useState(true);

    useEffect(() => {
        localStorage.setItem('agenda_selected_users', JSON.stringify(selectedUsers));
    }, [selectedUsers]);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 4);

    const weekDays = [];
    for (let i = 0; i < 5; i++) {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        weekDays.push(d);
    }

    const toggleUser = (code) => {
        setSelectedUsers(prev =>
            prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]
        );
    };

    // ── Try loading from offline cache first ──
    useEffect(() => {
        (async () => {
            const cached = await loadCachedAppointments();
            if (cached && Object.keys(cached).length > 0) {
                setTeamAptsCache(cached);
                setCacheLoading(false);
            }
        })();
    }, [loadCachedAppointments]);

    // ── Preload ALL team agendas ──
    useEffect(() => {
        let cancelled = false;
        const startStr = formatDateYMD(weekStart);
        const extendedEnd = new Date(weekStart);
        extendedEnd.setDate(extendedEnd.getDate() + 21);
        const endStr = formatDateYMD(extendedEnd);

        setCacheLoading(true);

        const fetchAll = async () => {
            const newCache = {};
            await Promise.all(
                TEAM_MEMBERS.map(async (member) => {
                    try {
                        const resp = await supabase.functions.invoke('extrabat-proxy', {
                            body: {
                                endpoint: `utilisateur/${member.code}/rendez-vous`,
                                apiVersion: 'v1',
                                params: { date_debut: startStr, date_fin: endStr, include: 'client' },
                            },
                        });
                        if (resp.data?.success && resp.data.data) {
                            newCache[member.code] = parseRawApts(resp.data.data, member.code, member);
                        } else {
                            newCache[member.code] = [];
                        }
                    } catch (e) {
                        console.error(`Error preloading agenda for ${member.name}:`, e);
                        newCache[member.code] = [];
                    }
                })
            );
            if (!cancelled) {
                setTeamAptsCache(newCache);
                setCacheLoading(false);
                cacheAppointments(newCache);
            }
        };

        fetchAll();
        return () => { cancelled = true; };
    }, [weekStart, cacheAppointments]);

    // ── Derive visible appointments from cache ──
    const appointments = (() => {
        if (selectedUsers.length === 0) return [];
        const result = [];
        for (const code of selectedUsers) {
            const cached = teamAptsCache[code];
            if (cached) result.push(...cached);
        }
        return result;
    })();

    // All appointments (for MyDay/agent context)
    const allAppointments = (() => {
        const result = [];
        for (const code of Object.keys(teamAptsCache)) {
            const cached = teamAptsCache[code];
            if (cached) result.push(...cached);
        }
        return result;
    })();

    useEffect(() => {
        setLoading(cacheLoading && Object.keys(teamAptsCache).length === 0);
    }, [cacheLoading, teamAptsCache]);

    // ── Tasks state ──
    const [tasks, setTasks] = useState([]);
    const [tasksLoaded, setTasksLoaded] = useState(false);

    useEffect(() => {
        (async () => {
            const cached = await loadCachedTasks();
            if (cached && cached.length > 0) {
                setTasks(cached);
                setTasksLoaded(true);
            }
        })();

        supabase.from('sav_requests')
            .select('*')
            .neq('status', 'archivee')
            .neq('status', 'terminee')
            .order('requested_at', { ascending: false })
            .limit(50)
            .then(({ data, error }) => {
                if (!error) setSavs(data || []);
            });

        supabase.from('opportunites')
            .select('*')
            .eq('archive', false)
            .order('date_creation', { ascending: false })
            .limit(50)
            .then(({ data, error }) => {
                if (!error) setOpps(data || []);
            });

        supabase.from('tasks')
            .select('*')
            .order('created_at', { ascending: false })
            .then(({ data, error }) => {
                if (!error) {
                    setTasks(data || []);
                    cacheTasks(data || []);
                }
                setTasksLoaded(true);
            });

        const channel = supabase.channel('tasks-realtime')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tasks' }, (payload) => {
                setTasks(prev => {
                    if (prev.some(t => t.id === payload.new.id)) return prev;
                    return [payload.new, ...prev];
                });
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tasks' }, (payload) => {
                setTasks(prev => prev.map(t => t.id === payload.new.id ? { ...t, ...payload.new } : t));
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tasks' }, (payload) => {
                setTasks(prev => prev.filter(t => t.id !== payload.old.id));
            })
            .subscribe();

        return () => { supabase.removeChannel(channel); };
    }, [loadCachedTasks, cacheTasks]);

    // Cache tasks when they change
    useEffect(() => {
        if (tasksLoaded && tasks.length > 0) {
            cacheTasks(tasks);
        }
    }, [tasks, tasksLoaded, cacheTasks]);

    // ── Expose data ──
    useEffect(() => {
        if (onDataReady) {
            onDataReady({ allApts: allAppointments, tasks, setTasks });
        }
    }, [teamAptsCache, tasks, onDataReady]);

    useImperativeHandle(ref, () => ({
        openTab(tab) {
            setActiveTab(tab);
            setIsExpanded(true);
        },
    }));

    const toggleTab = (tab) => {
        if (isExpanded && activeTab === tab) {
            setIsExpanded(false);
        } else {
            setActiveTab(tab);
            setIsExpanded(true);
        }
    };

    useEffect(() => {
        supabase.from('users').select('id, display_name').then(({ data }) => {
            if (data) setDbUsers(data);
        });
    }, []);

    const handleSavClick = async (sav) => {
        setSelectedSav(sav);
        setSavInterventions([]);
        setSavInterventionsLoading(true);
        const { data } = await supabase
            .from('sav_interventions')
            .select('*')
            .eq('sav_request_id', sav.id)
            .order('started_at', { ascending: false });
        if (data) setSavInterventions(data);
        setSavInterventionsLoading(false);
    };

    const goToPrev = () => { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d); setFocusedDayIndex(null); };
    const goToNext = () => { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d); setFocusedDayIndex(null); };
    const goToToday = () => { setWeekStart(getWeekStart(new Date())); setFocusedDayIndex(null); };

    const toggleFullScreen = async () => {
        if (!document.fullscreenElement) {
            try {
                if (panelRef.current?.requestFullscreen) await panelRef.current.requestFullscreen();
                else if (panelRef.current?.webkitRequestFullscreen) await panelRef.current.webkitRequestFullscreen();
                setIsFullScreen(true);
            } catch (err) {
                setIsFullScreen(true);
            }
        } else {
            try {
                if (document.exitFullscreen) await document.exitFullscreen();
                else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
            } catch { /* ignore */ }
            setIsFullScreen(false);
        }
    };

    useEffect(() => {
        const handler = () => {
            setIsFullScreen(!!document.fullscreenElement || !!document.webkitFullscreenElement);
        };
        document.addEventListener('fullscreenchange', handler);
        document.addEventListener('webkitfullscreenchange', handler);
        return () => {
            document.removeEventListener('fullscreenchange', handler);
            document.removeEventListener('webkitfullscreenchange', handler);
        };
    }, []);

    const getAptsForDay = (day) => {
        return appointments.filter(apt => apt._start && isSameDay(apt._start, day)).sort((a, b) => a._start - b._start);
    };

    const getAptStyle = (apt) => {
        const startHours = apt._start.getHours() + apt._start.getMinutes() / 60;
        const endHours = apt._end.getHours() + apt._end.getMinutes() / 60;
        const top = Math.max(0, (startHours - HOUR_START)) * HOUR_HEIGHT;
        const height = Math.max(HOUR_HEIGHT * 0.4, (endHours - startHours) * HOUR_HEIGHT);
        return { top: `${top}px`, height: `${height}px` };
    };

    const layoutAptsForDay = (dayApts) => {
        if (dayApts.length === 0) return [];
        const laid = dayApts.map(apt => ({ apt, col: 0, totalCols: 1 }));
        for (let i = 0; i < laid.length; i++) {
            const usedCols = new Set();
            for (let j = 0; j < i; j++) {
                if (laid[j].apt._start < laid[i].apt._end && laid[j].apt._end > laid[i].apt._start) usedCols.add(laid[j].col);
            }
            let col = 0;
            while (usedCols.has(col)) col++;
            laid[i].col = col;
        }
        for (let i = 0; i < laid.length; i++) {
            let maxCol = laid[i].col;
            for (let j = 0; j < laid.length; j++) {
                if (i !== j && laid[j].apt._start < laid[i].apt._end && laid[j].apt._end > laid[i].apt._start) maxCol = Math.max(maxCol, laid[j].col);
            }
            laid[i].totalCols = maxCol + 1;
        }
        return laid;
    };

    const today = new Date();
    const timeLabels = Array.from({ length: TOTAL_HOURS }, (_, i) => HOUR_START + i);

    const handleCreateAptClose = (created) => {
        setShowCreateModal(false);
        if (created) {
            // Refresh agenda by bumping weekStart
            setWeekStart(prev => new Date(prev));
        }
    };

    return (
        <div
            ref={panelRef}
            className={`agenda-panel ${isExpanded ? 'agenda-panel--expanded' : ''} ${isFullScreen ? 'agenda-panel--fullscreen' : ''}`}
        >
            <div className="agenda-panel__tabs">
                {['agenda', 'sav', 'opp', 'todo'].map(tab => {
                    const icons = { agenda: '\u{1F4C5}', sav: '\u{1F527}', opp: '\u{1F4CB}', todo: '\u2705' };
                    const labels = { agenda: 'Agendas', sav: 'SAV', opp: 'Opps', todo: 'To Do' };
                    return (
                        <button key={tab} className={`agenda-panel__toggle ${activeTab === tab && isExpanded ? 'agenda-panel__toggle--active' : ''}`} onClick={() => toggleTab(tab)} style={{ margin: 0 }}>
                            <span>{icons[tab]}</span>
                            <span>{labels[tab]}</span>
                            {tab === 'todo' && tasks.filter(t => t.status !== 'done').length > 0 && (
                                <span className="agenda-panel__badge">{tasks.filter(t => t.status !== 'done').length}</span>
                            )}
                            <span className={`agenda-panel__arrow ${isExpanded && activeTab === tab ? 'agenda-panel__arrow--open' : ''}`}>{'\u25BE'}</span>
                        </button>
                    );
                })}
            </div>

            {isExpanded && activeTab === 'agenda' && (
                <div className="agenda-panel__content" style={{ position: 'relative' }}>
                    <div className="agenda-panel__nav">
                        <button className="agenda-panel__nav-btn" onClick={goToPrev}>{'\u25C0'}</button>
                        <button className="agenda-panel__nav-btn agenda-panel__nav-btn--today" onClick={goToToday}>Auj.</button>
                        <button className="agenda-panel__nav-btn" onClick={goToNext}>{'\u25B6'}</button>
                        <span className="agenda-panel__date-range">
                            {weekStart.getDate()} {MONTHS_FR[weekStart.getMonth()]} — {weekEnd.getDate()} {MONTHS_FR[weekEnd.getMonth()]}
                        </span>
                        <div style={{ flex: 1 }} />
                        {loading && <span className="agenda-panel__loader">&#10227;</span>}
                        <button className="agenda-panel__nav-btn" onClick={toggleFullScreen} title="Plein écran">
                            {isFullScreen ? '\u29D9' : '\u26F6'}
                        </button>
                    </div>

                    <div className="agenda-panel__users">
                        {TEAM_MEMBERS.map(member => (
                            <label key={member.code} className="agenda-panel__user-label">
                                <input type="checkbox" checked={selectedUsers.includes(member.code)} onChange={() => toggleUser(member.code)} className="agenda-panel__checkbox" />
                                <span className="agenda-panel__user-dot" style={{ background: member.color }} />
                                <span className="agenda-panel__user-name">{member.name}</span>
                            </label>
                        ))}
                    </div>

                    {selectedUsers.length === 0 ? (
                        <div className="agenda-panel__empty"><span>{'\u{1F4C5}'}</span><p>Cochez un ou plusieurs membres</p></div>
                    ) : (
                        <div className="agenda-timeline">
                            <div className={`agenda-timeline__grid ${focusedDayIndex !== null ? 'agenda-timeline__grid--single' : ''}`}>
                                <div className="agenda-timeline__gutter">
                                    <div className="agenda-timeline__gutter-header" />
                                    <div className="agenda-timeline__gutter-body" style={{ height: `${TOTAL_HOURS * HOUR_HEIGHT}px` }}>
                                        {timeLabels.map(h => (
                                            <div key={h} className="agenda-timeline__time-label" style={{ top: `${(h - HOUR_START) * HOUR_HEIGHT}px` }}>{h}:00</div>
                                        ))}
                                    </div>
                                </div>
                                {weekDays.map((day, di) => {
                                    if (focusedDayIndex !== null && focusedDayIndex !== di) return null;
                                    const isDayToday = isSameDay(day, today);
                                    const dayApts = getAptsForDay(day);
                                    const laidOut = layoutAptsForDay(dayApts);
                                    let nowTop = null;
                                    if (isDayToday) {
                                        const nowH = today.getHours() + today.getMinutes() / 60;
                                        if (nowH >= HOUR_START && nowH <= HOUR_END) nowTop = (nowH - HOUR_START) * HOUR_HEIGHT;
                                    }
                                    return (
                                        <div key={di} className={`agenda-timeline__day ${isDayToday ? 'agenda-timeline__day--today' : ''}`}>
                                            <div className={`agenda-timeline__day-header ${isDayToday ? 'agenda-timeline__day-header--today' : ''}`} onClick={() => setFocusedDayIndex(focusedDayIndex === di ? null : di)} style={{ cursor: 'pointer' }}>
                                                <span className="agenda-timeline__day-name">{DAYS_FR_SHORT[day.getDay()]}</span>
                                                <span className={`agenda-timeline__day-num ${isDayToday ? 'agenda-timeline__day-num--today' : ''}`}>{day.getDate()}</span>
                                            </div>
                                            <div className="agenda-timeline__day-body" style={{ height: `${TOTAL_HOURS * HOUR_HEIGHT}px` }}>
                                                {timeLabels.map(h => (<div key={h} className="agenda-timeline__hour-line" style={{ top: `${(h - HOUR_START) * HOUR_HEIGHT}px` }} />))}
                                                {nowTop !== null && (<div className="agenda-timeline__now-line" style={{ top: `${nowTop}px` }}><div className="agenda-timeline__now-dot" /></div>)}
                                                {laidOut.map(({ apt, col, totalCols }, ai) => {
                                                    const style = getAptStyle(apt);
                                                    const widthPct = 100 / totalCols;
                                                    const leftPct = col * widthPct;
                                                    const startStr = `${pad2(apt._start.getHours())}:${pad2(apt._start.getMinutes())}`;
                                                    const endStr = `${pad2(apt._end.getHours())}:${pad2(apt._end.getMinutes())}`;
                                                    const aptId = apt.id || `${di}-${ai}`;
                                                    return (
                                                        <div key={aptId} className="agenda-timeline__apt" style={{ top: style.top, height: style.height, left: `${leftPct}%`, width: `${widthPct - 2}%`, background: `${apt._color}25`, borderLeftColor: apt._color }}
                                                            onClick={(e) => { e.stopPropagation(); setActiveAptData(prev => prev?.id === aptId ? null : { id: aptId, clientName: apt._clientName, objet: apt._objet, userName: apt._userName, color: apt._color, startStr, endStr, address: apt._address, phone: apt._phone }); }}>
                                                            <div className="agenda-timeline__apt-time">{startStr}</div>
                                                            {apt._clientName && <div className="agenda-timeline__apt-client">{apt._clientName}</div>}
                                                            <div className="agenda-timeline__apt-title">{apt._objet}</div>
                                                            {selectedUsers.length > 1 && <div className="agenda-timeline__apt-user" style={{ color: apt._color }}>{apt._userName}</div>}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {activeAptData && (
                        <div className="agenda-detail-overlay" onClick={() => setActiveAptData(null)}>
                            <div className="agenda-detail-sheet" onClick={(e) => e.stopPropagation()}>
                                <div className="agenda-detail-sheet__header">
                                    <div className="agenda-detail-sheet__time">{activeAptData.startStr} → {activeAptData.endStr}</div>
                                    <button className="agenda-detail-sheet__close" onClick={() => setActiveAptData(null)}>✕</button>
                                </div>
                                {activeAptData.clientName && <div className="agenda-detail-sheet__client">{activeAptData.clientName}</div>}
                                <div className="agenda-detail-sheet__objet">{activeAptData.objet}</div>
                                {activeAptData.address && <div style={{ marginBottom: '8px' }}><AddressLink address={activeAptData.address} /></div>}
                                {activeAptData.phone && <div style={{ marginBottom: '8px' }}><PhoneLink phone={activeAptData.phone} /></div>}
                                <div className="agenda-detail-sheet__user" style={{ color: activeAptData.color }}>
                                    <span className="agenda-detail-sheet__dot" style={{ background: activeAptData.color }} />
                                    {activeAptData.userName}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* FAB - Create appointment */}
                    <button className="agenda-fab" onClick={() => setShowCreateModal(true)} title="Nouveau RDV">
                        <span>+</span>
                    </button>
                    {showCreateModal && <CreateAptModal onClose={handleCreateAptClose} userCode={userCode} />}
                </div>
            )}

            {isExpanded && activeTab === 'sav' && (
                <div className="agenda-panel__content sav-panel__content">
                    <div className="agenda-panel__nav">
                        {selectedSav ? (
                            <>
                                <button className="agenda-panel__nav-btn" onClick={() => { setSelectedSav(null); setSavInterventions([]); }}>{'\u25C0'} Retour</button>
                                <span style={{ fontSize: 'var(--font-md)', fontWeight: 'bold', marginLeft: '8px' }}>{selectedSav.client_name || 'SAV'}</span>
                            </>
                        ) : (
                            <span style={{ fontSize: 'var(--font-md)', fontWeight: 'bold' }}>Dernières demandes SAV</span>
                        )}
                        <div style={{ flex: 1 }} />
                        <button className="agenda-panel__nav-btn" onClick={toggleFullScreen}>{isFullScreen ? '\u29D9' : '\u26F6'}</button>
                    </div>
                    {selectedSav ? (
                        <div className="sav-detail" style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '12px', paddingRight: '4px' }}>
                            <div style={{ padding: '12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                                <div style={{ fontSize: 'var(--font-md)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>{selectedSav.client_name || 'Client Inconnu'}</div>
                                {selectedSav.address && <div style={{ marginBottom: '6px' }}><AddressLink address={selectedSav.address} /></div>}
                                {selectedSav.phone && <div style={{ marginBottom: '6px' }}><PhoneLink phone={selectedSav.phone} /></div>}
                                {selectedSav.client_email && <div style={{ marginBottom: '6px' }}><EmailLink email={selectedSav.client_email} /></div>}
                            </div>
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 'var(--font-xs)', padding: '4px 10px', background: 'rgba(255,107,107,0.1)', color: 'var(--danger)', borderRadius: '12px', fontWeight: 600 }}>{selectedSav.status}</span>
                                {selectedSav.urgent && <span style={{ fontSize: 'var(--font-xs)', padding: '4px 10px', background: 'rgba(255,107,107,0.2)', color: 'var(--danger)', borderRadius: '12px', fontWeight: 600 }}>{'\u{1F6A8}'} Urgent</span>}
                                {selectedSav.system_type && <span style={{ fontSize: 'var(--font-xs)', padding: '4px 10px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', color: 'var(--text-secondary)' }}>{'\u{1F6E1}'} {selectedSav.system_type}</span>}
                            </div>
                            <div style={{ padding: '12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Description du problème</div>
                                <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{selectedSav.problem_desc || 'Aucune description'}</div>
                            </div>
                            {selectedSav.prediagnostic && (
                                <div style={{ padding: '12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                                    <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Pré-diagnostic</div>
                                    <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{selectedSav.prediagnostic}</div>
                                </div>
                            )}
                            <div style={{ padding: '12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Interventions</div>
                                {savInterventions.length === 0 && !savInterventionsLoading && <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', fontStyle: 'italic' }}>Aucune intervention</div>}
                                {savInterventions.map((interv, idx) => {
                                    const techName = dbUsers.find(u => u.id === interv.technician_id)?.display_name || 'Technicien';
                                    return (
                                        <div key={interv.id || idx} style={{ padding: '8px', marginBottom: '6px', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                                <span style={{ fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--accent-light)' }}>{techName}</span>
                                                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>{interv.started_at ? new Date(interv.started_at).toLocaleDateString('fr-FR') : '—'}</span>
                                            </div>
                                            {(interv.rapport_reformule || interv.rapport_brut || interv.notes) && <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{interv.rapport_reformule || interv.rapport_brut || interv.notes}</div>}
                                        </div>
                                    );
                                })}
                            </div>
                            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', textAlign: 'right' }}>Demande du {new Date(selectedSav.requested_at).toLocaleDateString('fr-FR')}</div>
                        </div>
                    ) : (
                        <div className="sav-list" style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '4px' }}>
                            {savs.length === 0 && <div className="agenda-panel__empty">Aucun SAV</div>}
                            {savs.map(sav => (
                                <div key={sav.id} style={{ padding: '12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => handleSavClick(sav)}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{sav.client_name || 'Client Inconnu'}</span>
                                        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>{new Date(sav.requested_at).toLocaleDateString('fr-FR')}</span>
                                    </div>
                                    <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', marginBottom: '8px', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{sav.problem_desc}</div>
                                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: 'var(--font-xs)', padding: '2px 8px', background: 'rgba(255,107,107,0.1)', color: 'var(--danger)', borderRadius: '12px' }}>{sav.status}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {isExpanded && activeTab === 'opp' && (
                <div className="agenda-panel__content opp-panel__content">
                    <div className="agenda-panel__nav">
                        <span style={{ fontSize: 'var(--font-md)', fontWeight: 'bold' }}>Dernières Opportunités</span>
                        <div style={{ flex: 1 }} />
                        <button className="agenda-panel__nav-btn" onClick={toggleFullScreen}>{isFullScreen ? '\u29D9' : '\u26F6'}</button>
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '4px' }}>
                        {opps.length === 0 && <div className="agenda-panel__empty">Aucune Opportunité</div>}
                        {opps.map(opp => (
                            <div key={opp.id} style={{ padding: '12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{opp.titre || 'Sans titre'}</span>
                                    <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>{new Date(opp.created_at || opp.date_creation).toLocaleDateString('fr-FR')}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
                                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: 'var(--font-xs)', padding: '2px 8px', background: 'rgba(0,206,201,0.1)', color: 'var(--success)', borderRadius: '12px' }}>{opp.statut}</span>
                                        {opp.suivi_par && <span style={{ fontSize: 'var(--font-xs)', padding: '2px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '12px', color: 'var(--text-secondary)' }}>Par {opp.suivi_par}</span>}
                                    </div>
                                    {opp.montant_estime && <span style={{ fontWeight: 'bold', color: 'var(--accent-light)' }}>{opp.montant_estime}{'\u20AC'}</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {isExpanded && activeTab === 'todo' && (
                <div className="agenda-panel__content todo-panel__content">
                    <div className="agenda-panel__nav">
                        <span style={{ fontSize: 'var(--font-md)', fontWeight: 'bold' }}>{'\u{1F4DD}'} Mes Tâches</span>
                        <div style={{ flex: 1 }} />
                        <button className="agenda-panel__nav-btn" onClick={toggleFullScreen}>{isFullScreen ? '\u29D9' : '\u26F6'}</button>
                    </div>
                    <TodoPanel tasks={tasks} setTasks={setTasks} loading={!tasksLoaded} />
                </div>
            )}
        </div>
    );
});

export default AgendaPanel;
