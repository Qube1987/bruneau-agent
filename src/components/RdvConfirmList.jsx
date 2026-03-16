import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

/**
 * RdvConfirmList — Shows tomorrow's appointments with SMS confirmation buttons.
 * Displayed when the user clicks the push notification or navigates to ?action=rdv-confirm
 */
export default function RdvConfirmList({ onClose }) {
    const [appointments, setAppointments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [sentSms, setSentSms] = useState({});

    useEffect(() => {
        fetchTomorrowAppointments();
    }, []);

    async function fetchTomorrowAppointments() {
        try {
            setLoading(true);

            // Calculate tomorrow's date
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dateStr = tomorrow.toISOString().split('T')[0];

            // Get the day name in French
            const dayNames = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
            const dayName = dayNames[tomorrow.getDay()];

            // Fetch Quentin's agenda for tomorrow via the agent endpoint
            const { data: sessionData } = await supabase.auth.getSession();
            const token = sessionData?.session?.access_token;

            const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/extrabat-proxy`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token || import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify({
                    endpoint: 'utilisateur/46516/rendez-vous', // Quentin's Extrabat code
                    apiVersion: 'v1',
                    params: {
                        date_debut: dateStr,
                        date_fin: dateStr,
                        include: 'client,telephone',
                    },
                }),
            });

            const result = await response.json();

            if (result.success && result.data) {
                const rdvs = Array.isArray(result.data) ? result.data : Object.values(result.data);

                // Debug: log first appointment to see client data structure
                if (rdvs.length > 0) {
                    console.log('[RdvConfirmList] Sample appointment:', JSON.stringify(rdvs[0], null, 2));
                }

                // Format and sort appointments
                const formatted = rdvs
                    .map((apt) => {
                        const debut = new Date(apt.debut);
                        const fin = new Date(apt.fin);
                        const client = apt.clients?.[0] || apt.client || null;
                        const clientName = client
                            ? `${client.prenom || ''} ${client.nom || ''}`.trim() || client.raisonSociale || ''
                            : '';
                        // Try all possible phone field names from Extrabat API
                        const phone = client?.telephones?.[0]?.number
                            || client?.telephones?.[0]?.numero
                            || client?.telephone
                            || client?.mobile
                            || client?.portable
                            || client?.tel
                            || client?.telPortable
                            || client?.telMobile
                            || apt.telephone
                            || apt.phone
                            || '';

                        return {
                            id: apt.id,
                            objet: apt.objet || 'Sans objet',
                            debut: debut,
                            fin: fin,
                            heureDebut: debut.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
                            heureFin: fin.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
                            clientName,
                            phone,
                            journee: apt.journee,
                            dateStr,
                            dayName,
                        };
                    })
                    .sort((a, b) => a.debut - b.debut);

                setAppointments(formatted);
            }
        } catch (err) {
            console.error('Failed to fetch appointments:', err);
        } finally {
            setLoading(false);
        }
    }

    function handleSendSms(apt) {
        const dateFormatted = new Date(apt.dateStr).toLocaleDateString('fr-FR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
        });
        const body = `Bonjour, nous vous confirmons votre rendez-vous du ${dateFormatted} à ${apt.heureDebut}. Cordialement, Bruneau Protection.`;
        const encodedBody = encodeURIComponent(body);
        const url = `sms:${apt.phone}?body=${encodedBody}`;
        window.open(url, '_self');
        setSentSms((prev) => ({ ...prev, [apt.id]: true }));
    }

    const rdvsWithClients = appointments.filter((apt) => apt.clientName && apt.phone);
    const rdvsWithoutPhone = appointments.filter((apt) => apt.clientName && !apt.phone);
    const rdvsPersonal = appointments.filter((apt) => !apt.clientName);

    return (
        <div className="rdv-confirm-overlay">
            <div className="rdv-confirm-panel">
                <div className="rdv-confirm-header">
                    <div className="rdv-confirm-header__left">
                        <span className="rdv-confirm-header__icon">📋</span>
                        <div>
                            <div className="rdv-confirm-header__title">Confirmations RDV</div>
                            <div className="rdv-confirm-header__subtitle">
                                {appointments.length > 0
                                    ? `${appointments.length} rdv demain ${appointments[0]?.dayName}`
                                    : 'Chargement...'}
                            </div>
                        </div>
                    </div>
                    <button className="rdv-confirm-close" onClick={onClose}>✕</button>
                </div>

                <div className="rdv-confirm-list">
                    {loading && (
                        <div className="rdv-confirm-loading">
                            <div className="typing">
                                <div className="typing__dot"></div>
                                <div className="typing__dot"></div>
                                <div className="typing__dot"></div>
                            </div>
                            Chargement de l'agenda...
                        </div>
                    )}

                    {!loading && appointments.length === 0 && (
                        <div className="rdv-confirm-empty">
                            ✅ Aucun rendez-vous demain
                        </div>
                    )}

                    {rdvsWithClients.length > 0 && (
                        <div className="rdv-confirm-section">
                            <div className="rdv-confirm-section__title">
                                💬 Confirmations à envoyer ({rdvsWithClients.length})
                            </div>
                            {rdvsWithClients.map((apt) => (
                                <div key={apt.id} className="rdv-confirm-item">
                                    <div className="rdv-confirm-item__time">
                                        {apt.journee ? '📅 Journée' : `${apt.heureDebut} - ${apt.heureFin}`}
                                    </div>
                                    <div className="rdv-confirm-item__details">
                                        <div className="rdv-confirm-item__client">{apt.clientName}</div>
                                        <div className="rdv-confirm-item__objet">{apt.objet}</div>
                                    </div>
                                    <button
                                        className={`rdv-confirm-item__sms ${sentSms[apt.id] ? 'rdv-confirm-item__sms--sent' : ''}`}
                                        onClick={() => handleSendSms(apt)}
                                        disabled={sentSms[apt.id]}
                                        title={sentSms[apt.id] ? 'SMS envoyé' : 'Envoyer SMS de confirmation'}
                                    >
                                        {sentSms[apt.id] ? '✓' : '✉️'}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {rdvsWithoutPhone.length > 0 && (
                        <div className="rdv-confirm-section">
                            <div className="rdv-confirm-section__title">
                                ⚠️ Sans numéro ({rdvsWithoutPhone.length})
                            </div>
                            {rdvsWithoutPhone.map((apt) => (
                                <div key={apt.id} className="rdv-confirm-item rdv-confirm-item--no-phone">
                                    <div className="rdv-confirm-item__time">
                                        {apt.journee ? '📅 Journée' : `${apt.heureDebut} - ${apt.heureFin}`}
                                    </div>
                                    <div className="rdv-confirm-item__details">
                                        <div className="rdv-confirm-item__client">{apt.clientName}</div>
                                        <div className="rdv-confirm-item__objet">{apt.objet}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {rdvsPersonal.length > 0 && (
                        <div className="rdv-confirm-section">
                            <div className="rdv-confirm-section__title">
                                👤 Perso/interne ({rdvsPersonal.length})
                            </div>
                            {rdvsPersonal.map((apt) => (
                                <div key={apt.id} className="rdv-confirm-item rdv-confirm-item--personal">
                                    <div className="rdv-confirm-item__time">
                                        {apt.journee ? '📅 Journée' : `${apt.heureDebut} - ${apt.heureFin}`}
                                    </div>
                                    <div className="rdv-confirm-item__details">
                                        <div className="rdv-confirm-item__objet">{apt.objet}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
