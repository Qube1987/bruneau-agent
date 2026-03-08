import { useState } from 'react';

/**
 * ComposeCard — Card to compose and send SMS or Email via native smartphone apps.
 * Uses sms: and mailto: URI schemes to open the device's native apps.
 */
export function ComposeCard({ message }) {
    const [sent, setSent] = useState(false);
    const [editMode, setEditMode] = useState(false);
    const [body, setBody] = useState(message.body || '');
    const [subject, setSubject] = useState(message.subject || '');

    const isEmail = message.composeType === 'email';
    const isSms = message.composeType === 'sms';

    const recipientName = message.recipientName || 'Destinataire';
    const recipientContact = message.recipientContact || '';
    const recipientRole = message.recipientRole || '';

    const handleSend = () => {
        let url = '';
        if (isSms) {
            // sms: URI — works on iOS and Android
            const encodedBody = encodeURIComponent(body);
            // iOS uses &body=, Android uses ?body=
            // Using ? for broader compatibility
            url = `sms:${recipientContact}?body=${encodedBody}`;
        } else if (isEmail) {
            const encodedSubject = encodeURIComponent(subject);
            const encodedBody = encodeURIComponent(body);
            url = `mailto:${recipientContact}?subject=${encodedSubject}&body=${encodedBody}`;
        }

        if (url) {
            window.open(url, '_self');
            setSent(true);
        }
    };

    const handleEdit = () => {
        setEditMode(!editMode);
    };

    const handleSaveEdit = () => {
        setEditMode(false);
    };

    return (
        <div className={`compose-card compose-card--${isEmail ? 'email' : 'sms'}`}>
            <div className="compose-card__header">
                <div className={`compose-card__icon compose-card__icon--${isEmail ? 'email' : 'sms'}`}>
                    {isEmail ? '✉️' : '💬'}
                </div>
                <div className="compose-card__header-text">
                    <div className="compose-card__title">
                        {isEmail ? 'Envoyer un email' : 'Envoyer un SMS'}
                    </div>
                    <div className="compose-card__subtitle">
                        via l'application {isEmail ? 'mail' : 'SMS'} de votre téléphone
                    </div>
                </div>
            </div>

            <div className="compose-card__recipient">
                <span className="compose-card__recipient-label">À :</span>
                <span className="compose-card__recipient-name">{recipientName}</span>
                {recipientRole && (
                    <span className="compose-card__recipient-role">({recipientRole})</span>
                )}
                <span className="compose-card__recipient-contact">{recipientContact}</span>
            </div>

            {isEmail && (
                <div className="compose-card__field">
                    <span className="compose-card__field-label">Objet :</span>
                    {editMode ? (
                        <input
                            className="compose-card__input"
                            type="text"
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                        />
                    ) : (
                        <span className="compose-card__field-value">{subject}</span>
                    )}
                </div>
            )}

            <div className="compose-card__body">
                <span className="compose-card__field-label">Message :</span>
                {editMode ? (
                    <textarea
                        className="compose-card__textarea"
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        rows={4}
                    />
                ) : (
                    <div className="compose-card__body-preview">{body}</div>
                )}
            </div>

            <div className="compose-card__actions">
                {editMode ? (
                    <button className="btn btn--confirm" onClick={handleSaveEdit}>
                        ✓ Valider les modifications
                    </button>
                ) : (
                    <>
                        <button
                            className="btn btn--cancel"
                            onClick={handleEdit}
                            disabled={sent}
                        >
                            ✏️ Modifier
                        </button>
                        <button
                            className={`btn btn--${isEmail ? 'email' : 'sms'}`}
                            onClick={handleSend}
                            disabled={sent || !recipientContact}
                        >
                            {sent
                                ? '✓ Ouvert'
                                : isEmail
                                    ? '✉️ Envoyer l\'email'
                                    : '💬 Envoyer le SMS'}
                        </button>
                    </>
                )}
            </div>

            {sent && (
                <div className="compose-card__sent-notice">
                    L'application {isEmail ? 'mail' : 'SMS'} s'est ouverte avec le message pré-rempli.
                </div>
            )}
        </div>
    );
}
