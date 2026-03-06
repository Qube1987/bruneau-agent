import { useState } from 'react';

export function ConfirmationCard({ message, onRespond, disabled }) {
    const [responded, setResponded] = useState(false);

    const handleResponse = (confirmed) => {
        setResponded(true);
        onRespond('confirm', {
            confirmed,
            pendingAction: message.pendingAction,
        });
    };

    return (
        <div className="action-card">
            <div className="action-card__header">
                <div className="action-card__icon action-card__icon--confirm">✅</div>
                <div className="action-card__title">Confirmation requise</div>
            </div>

            <div className="action-card__body">
                <p style={{ fontSize: 'var(--font-sm)', marginBottom: 'var(--space-md)', color: 'var(--text-primary)' }}>
                    {message.content}
                </p>

                {message.details && Object.keys(message.details).length > 0 && (
                    <div>
                        {Object.entries(message.details).map(([key, value]) => (
                            <div className="action-card__detail" key={key}>
                                <span className="action-card__detail-label">{key}</span>
                                <span className="action-card__detail-value">{String(value)}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="action-card__actions">
                <button
                    className="btn btn--cancel"
                    onClick={() => handleResponse(false)}
                    disabled={responded || disabled}
                >
                    ✕ Annuler
                </button>
                <button
                    className="btn btn--confirm"
                    onClick={() => handleResponse(true)}
                    disabled={responded || disabled}
                >
                    ✓ Confirmer
                </button>
            </div>
        </div>
    );
}

export function SelectionCard({ message, onRespond, disabled }) {
    const [selectedIndex, setSelectedIndex] = useState(null);
    const [responded, setResponded] = useState(false);

    const handleSelect = (index) => {
        if (responded || disabled) return;
        setSelectedIndex(index);
    };

    const handleConfirm = () => {
        if (selectedIndex === null) return;
        setResponded(true);
        const selected = message.options[selectedIndex];
        onRespond('select', {
            selectedIndex,
            selectedValue: selected.value || selected,
            selectedLabel: selected.label || selected.name || JSON.stringify(selected),
            pendingAction: message.pendingAction,
        });
    };

    return (
        <div className="action-card">
            <div className="action-card__header">
                <div className="action-card__icon action-card__icon--select">🔍</div>
                <div className="action-card__title">Choix requis</div>
            </div>

            <p style={{ fontSize: 'var(--font-sm)', marginBottom: 'var(--space-md)', color: 'var(--text-primary)' }}>
                {message.content}
            </p>

            <div className="action-card__options">
                {message.options.map((option, index) => {
                    const label = option.label || option.name || option;
                    const subtitle = option.subtitle || option.address || option.detail || '';
                    return (
                        <button
                            key={index}
                            className={`action-card__option ${selectedIndex === index ? 'action-card__option--selected' : ''}`}
                            onClick={() => handleSelect(index)}
                            disabled={responded || disabled}
                        >
                            <div style={{ fontWeight: 500 }}>{typeof label === 'string' ? label : JSON.stringify(label)}</div>
                            {subtitle && (
                                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', marginTop: 4 }}>
                                    {subtitle}
                                </div>
                            )}
                        </button>
                    );
                })}
            </div>

            <div className="action-card__actions">
                <button
                    className="btn btn--confirm"
                    onClick={handleConfirm}
                    disabled={selectedIndex === null || responded || disabled}
                >
                    ✓ Valider mon choix
                </button>
            </div>
        </div>
    );
}
