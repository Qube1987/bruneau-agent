import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

/**
 * EmailPanel — Full-screen overlay for email management
 * Shows important emails, draft replies, and newsletter management
 */

export default function EmailPanel({ visible, onClose }) {
    const [activeTab, setActiveTab] = useState('important'); // 'important', 'newsletters', 'all'
    const [emails, setEmails] = useState([]);
    const [senders, setSenders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedEmail, setExpandedEmail] = useState(null);
    const [expandedDraft, setExpandedDraft] = useState(null);
    const [checkingNow, setCheckingNow] = useState(false);

    const fetchEmails = useCallback(async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('email_messages')
                .select('*')
                .order('received_at', { ascending: false })
                .limit(100);

            if (!error && data) setEmails(data);

            const { data: senderData } = await supabase
                .from('email_senders')
                .select('*')
                .order('first_seen_at', { ascending: false });

            if (senderData) setSenders(senderData);
        } catch (err) {
            console.error('[Emails] Fetch error:', err);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        if (visible) fetchEmails();
    }, [visible, fetchEmails]);

    const handleSenderDecision = async (senderEmail, decision) => {
        const newClassification = decision === 'keep' ? 'allowed' : 'blocked';

        // Update sender classification
        await supabase
            .from('email_senders')
            .update({ classification: newClassification, updated_at: new Date().toISOString() })
            .eq('sender_email', senderEmail);

        // If blocked, mark all their unprocessed emails as read (will be handled by next check)
        if (decision === 'dismiss') {
            // Record the decision
            await supabase.from('email_newsletter_decisions').insert({
                sender_email: senderEmail,
                decision: 'dismiss',
                decided_at: new Date().toISOString(),
            });
        } else {
            await supabase.from('email_newsletter_decisions').insert({
                sender_email: senderEmail,
                decision: 'keep',
                decided_at: new Date().toISOString(),
            });
        }

        // Refresh
        fetchEmails();
    };

    const markAsReplied = async (emailId) => {
        await supabase
            .from('email_messages')
            .update({ replied_at: new Date().toISOString() })
            .eq('id', emailId);
        fetchEmails();
    };

    const daysWaiting = (receivedAt) => {
        if (!receivedAt) return 0;
        return Math.floor((Date.now() - new Date(receivedAt).getTime()) / (1000 * 60 * 60 * 24));
    };

    const triggerManualCheck = async () => {
        setCheckingNow(true);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch(
                `${import.meta.env.VITE_SUPABASE_URL || 'https://rzxisqsdsiiuwaixnneo.supabase.co'}/functions/v1/email-checker`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${session?.access_token}`,
                    },
                }
            );
            const result = await res.json();
            console.log('[Emails] Manual check result:', result);
            // Refresh after check
            await fetchEmails();
        } catch (err) {
            console.error('[Emails] Manual check error:', err);
        }
        setCheckingNow(false);
    };

    if (!visible) return null;

    // Filter emails by tab
    const importantEmails = emails.filter(e => (e.is_important || e.needs_reply) && !e.is_newsletter);
    const newsletterEmails = emails.filter(e => e.is_newsletter);
    const pendingSenders = senders.filter(s => s.is_newsletter && s.classification === 'pending');
    const allEmails = emails;

    const displayEmails = activeTab === 'important' ? importantEmails
        : activeTab === 'newsletters' ? newsletterEmails
            : allEmails;

    // Get sender classification for an email
    const getSenderClassification = (fromEmail) => {
        const sender = senders.find(s => s.sender_email.toLowerCase() === fromEmail?.toLowerCase());
        return sender?.classification || 'unknown';
    };

    const formatDate = (dateStr) => {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        const now = new Date();
        const diffMs = now - d;
        const diffH = Math.floor(diffMs / (1000 * 60 * 60));
        const diffD = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffH < 1) return 'Il y a moins d\'1h';
        if (diffH < 24) return `Il y a ${diffH}h`;
        if (diffD < 7) return `Il y a ${diffD}j`;
        return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    };

    return (
        <div className="email-panel-overlay">
            <div className="email-panel">
                {/* Header */}
                <div className="email-panel__header">
                    <div className="email-panel__header-left">
                        <button className="email-panel__back" onClick={onClose}>←</button>
                        <h2 className="email-panel__title">📧 Emails</h2>
                    </div>
                    <div className="email-panel__header-right">
                        <button
                            className={`email-panel__refresh ${checkingNow ? 'email-panel__refresh--spinning' : ''}`}
                            onClick={triggerManualCheck}
                            disabled={checkingNow}
                            title="Vérifier maintenant"
                        >
                            🔄
                        </button>
                    </div>
                </div>

                {/* Pending newsletter decisions banner */}
                {pendingSenders.length > 0 && (
                    <div className="email-panel__pending-banner">
                        <span>📰 {pendingSenders.length} expéditeur{pendingSenders.length > 1 ? 's' : ''} de newsletter à classer</span>
                    </div>
                )}

                {/* Tabs */}
                <div className="email-panel__tabs">
                    <button
                        className={`email-panel__tab ${activeTab === 'important' ? 'email-panel__tab--active' : ''}`}
                        onClick={() => setActiveTab('important')}
                    >
                        🔴 Important
                        {importantEmails.length > 0 && (
                            <span className="email-panel__tab-badge">{importantEmails.length}</span>
                        )}
                    </button>
                    <button
                        className={`email-panel__tab ${activeTab === 'newsletters' ? 'email-panel__tab--active' : ''}`}
                        onClick={() => setActiveTab('newsletters')}
                    >
                        📰 Newsletters
                        {pendingSenders.length > 0 && (
                            <span className="email-panel__tab-badge email-panel__tab-badge--warning">{pendingSenders.length}</span>
                        )}
                    </button>
                    <button
                        className={`email-panel__tab ${activeTab === 'all' ? 'email-panel__tab--active' : ''}`}
                        onClick={() => setActiveTab('all')}
                    >
                        📥 Tous
                    </button>
                </div>

                {/* Content */}
                <div className="email-panel__content">
                    {loading ? (
                        <div className="email-panel__loading">
                            <div className="email-panel__spinner" />
                            <span>Chargement des emails...</span>
                        </div>
                    ) : displayEmails.length === 0 ? (
                        <div className="email-panel__empty">
                            <span className="email-panel__empty-icon">
                                {activeTab === 'important' ? '✅' : activeTab === 'newsletters' ? '📭' : '📭'}
                            </span>
                            <span className="email-panel__empty-text">
                                {activeTab === 'important'
                                    ? 'Aucun email important en attente'
                                    : activeTab === 'newsletters'
                                        ? 'Aucune newsletter'
                                        : 'Aucun email traité'}
                            </span>
                        </div>
                    ) : (
                        <>
                            {/* Newsletter sender decisions */}
                            {activeTab === 'newsletters' && pendingSenders.length > 0 && (
                                <div className="email-panel__sender-decisions">
                                    <h3 className="email-panel__section-title">Expéditeurs à classer</h3>
                                    {pendingSenders.map(sender => (
                                        <div key={sender.id} className="email-panel__sender-card">
                                            <div className="email-panel__sender-info">
                                                <span className="email-panel__sender-name">{sender.sender_name || sender.sender_email}</span>
                                                <span className="email-panel__sender-email">{sender.sender_email}</span>
                                            </div>
                                            <div className="email-panel__sender-actions">
                                                <button
                                                    className="email-panel__sender-btn email-panel__sender-btn--keep"
                                                    onClick={() => handleSenderDecision(sender.sender_email, 'keep')}
                                                    title="Garder — les prochaines newsletters resteront non lues"
                                                >
                                                    ✅ Garder
                                                </button>
                                                <button
                                                    className="email-panel__sender-btn email-panel__sender-btn--block"
                                                    onClick={() => handleSenderDecision(sender.sender_email, 'dismiss')}
                                                    title="Bloquer — les prochaines seront marquées lues automatiquement"
                                                >
                                                    🚫 Bloquer
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Email list */}
                            <div className="email-panel__list">
                                {activeTab === 'newsletters' && pendingSenders.length > 0 && (
                                    <h3 className="email-panel__section-title">Emails newsletters</h3>
                                )}
                                {displayEmails.map(email => {
                                    const isExpanded = expandedEmail === email.id;
                                    const isDraftExpanded = expandedDraft === email.id;
                                    const senderClass = getSenderClassification(email.from_email);

                                    return (
                                        <div
                                            key={email.id}
                                            className={`email-panel__email ${isExpanded ? 'email-panel__email--expanded' : ''} ${email.needs_reply ? 'email-panel__email--needs-reply' : ''} ${email.is_newsletter ? 'email-panel__email--newsletter' : ''}`}
                                        >
                                            <div
                                                className="email-panel__email-header"
                                                onClick={() => setExpandedEmail(isExpanded ? null : email.id)}
                                            >
                                                <div className="email-panel__email-indicator">
                                                    {email.needs_reply ? '💬' : email.is_important ? '⭐' : email.is_newsletter ? '📰' : '📧'}
                                                </div>
                                                <div className="email-panel__email-main">
                                                    <div className="email-panel__email-top">
                                                        <span className="email-panel__email-from">
                                                            {email.from_name || email.from_email}
                                                        </span>
                                                        <span className="email-panel__email-date">
                                                            {formatDate(email.received_at)}
                                                        </span>
                                                    </div>
                                                    <div className="email-panel__email-subject">{email.subject}</div>
                                                    <div className="email-panel__email-summary">{email.ai_summary}</div>
                                                    <div className="email-panel__email-tags">
                                                        <span className="email-panel__email-account">
                                                            {email.account_email === 'quentin@bruneau27.com' ? '👤 Quentin' : '🏢 Info'}
                                                        </span>
                                                        {email.needs_reply && !email.replied_at && (() => {
                                                            const days = daysWaiting(email.received_at);
                                                            const urgencyClass = days >= 7 ? 'email-panel__tag--urgent' : days >= 3 ? 'email-panel__tag--warning' : 'email-panel__tag--reply';
                                                            return <span className={`email-panel__tag ${urgencyClass}`}>
                                                                {days >= 7 ? '🔴' : days >= 3 ? '🟡' : '💬'} {days > 0 ? `${days}j en attente` : 'Réponse attendue'}
                                                            </span>;
                                                        })()}
                                                        {email.needs_reply && email.replied_at && <span className="email-panel__tag email-panel__tag--allowed">✅ Répondu</span>}
                                                        {email.is_newsletter && senderClass === 'pending' && <span className="email-panel__tag email-panel__tag--pending">À classer</span>}
                                                        {email.is_newsletter && senderClass === 'allowed' && <span className="email-panel__tag email-panel__tag--allowed">Autorisé</span>}
                                                        {email.is_newsletter && senderClass === 'blocked' && <span className="email-panel__tag email-panel__tag--blocked">Bloqué</span>}
                                                    </div>
                                                </div>
                                                <div className="email-panel__email-chevron">
                                                    {isExpanded ? '▲' : '▼'}
                                                </div>
                                            </div>

                                            {isExpanded && (
                                                <div className="email-panel__email-body">
                                                    <div className="email-panel__email-meta">
                                                        <span>De : {email.from_name} &lt;{email.from_email}&gt;</span>
                                                        <span>Reçu : {new Date(email.received_at).toLocaleString('fr-FR')}</span>
                                                        <span>Boîte : {email.account_email}</span>
                                                    </div>

                                                    {email.body_preview && (
                                                        <div className="email-panel__email-preview">
                                                            <h4>Aperçu du contenu</h4>
                                                            <p>{email.body_preview}</p>
                                                        </div>
                                                    )}

                                                    {email.draft_reply && (
                                                        <div className="email-panel__draft">
                                                            <div
                                                                className="email-panel__draft-header"
                                                                onClick={(e) => { e.stopPropagation(); setExpandedDraft(isDraftExpanded ? null : email.id); }}
                                                            >
                                                                <span>✏️ Brouillon de réponse</span>
                                                                <span>{isDraftExpanded ? '▲' : '▼'}</span>
                                                            </div>
                                                            {isDraftExpanded && (
                                                                <div className="email-panel__draft-body">
                                                                    <pre>{email.draft_reply}</pre>
                                                                    <button
                                                                        className="email-panel__draft-copy"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            navigator.clipboard.writeText(email.draft_reply);
                                                                        }}
                                                                    >
                                                                        📋 Copier le brouillon
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}

                                                    {email.needs_reply && !email.replied_at && (
                                                        <div className="email-panel__reply-tracking">
                                                            <button
                                                                className="email-panel__sender-btn email-panel__sender-btn--keep"
                                                                onClick={(e) => { e.stopPropagation(); markAsReplied(email.id); }}
                                                                style={{ marginTop: '8px' }}
                                                            >
                                                                ✅ Marquer comme répondu
                                                            </button>
                                                        </div>
                                                    )}

                                                    {email.is_newsletter && senderClass === 'pending' && (
                                                        <div className="email-panel__newsletter-decision">
                                                            <span>Que faire avec les newsletters de <strong>{email.from_name}</strong> ?</span>
                                                            <div className="email-panel__newsletter-btns">
                                                                <button
                                                                    className="email-panel__sender-btn email-panel__sender-btn--keep"
                                                                    onClick={(e) => { e.stopPropagation(); handleSenderDecision(email.from_email, 'keep'); }}
                                                                >
                                                                    ✅ Garder les prochaines
                                                                </button>
                                                                <button
                                                                    className="email-panel__sender-btn email-panel__sender-btn--block"
                                                                    onClick={(e) => { e.stopPropagation(); handleSenderDecision(email.from_email, 'dismiss'); }}
                                                                >
                                                                    🚫 Marquer comme lu
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
