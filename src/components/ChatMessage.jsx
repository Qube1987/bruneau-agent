import { StockCard } from './StockCard';

export function ChatMessage({ message }) {
    const isUser = message.role === 'user';

    // Convert markdown-like formatting to HTML for agent messages
    const formatContent = (text) => {
        if (isUser || !text) return text;

        // Process the text line by line
        const lines = text.split('\n');
        const formatted = lines.map((line, i) => {
            // Bold: **text** or __text__
            line = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            line = line.replace(/__(.*?)__/g, '<strong>$1</strong>');

            // Auto-link French phone numbers (06, 07, 01-05, 09)
            line = line.replace(
                /(0[1-9][\s.]?\d{2}[\s.]?\d{2}[\s.]?\d{2}[\s.]?\d{2})/g,
                (match) => {
                    const cleaned = match.replace(/[\s.]/g, '');
                    return `<a href="tel:${cleaned}" class="linkable linkable--phone" style="display:inline;padding:2px 4px;">📞 ${match}</a>`;
                }
            );

            // Auto-link addresses (lines that look like "number street, postal city")
            line = line.replace(
                /(\d+[\s,]+[\w\s]+,?\s*\d{5}\s+[\w\s-]+)/g,
                (match) => {
                    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(match.trim())}`;
                    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="linkable linkable--address" style="display:inline;padding:2px 4px;">📍 ${match}</a>`;
                }
            );

            // Bullet points: - item or • item or * item
            if (/^\s*[-•*]\s+/.test(line)) {
                const content = line.replace(/^\s*[-•*]\s+/, '');
                return `<div class="message__list-item">${content}</div>`;
            }

            // Empty line = spacer
            if (line.trim() === '') {
                return '<div class="message__spacer"></div>';
            }

            return `<div>${line}</div>`;
        });

        return formatted.join('');
    };

    return (
        <div className={`message message--${isUser ? 'user' : 'agent'}`}>
            <span className="message__label">
                {isUser ? '🎙️ Vous' : '🤖 Agent'}
            </span>
            <div className="message__bubble">
                {isUser ? (
                    message.content
                ) : (
                    <>
                        <div
                            className="message__formatted"
                            dangerouslySetInnerHTML={{ __html: formatContent(message.content) }}
                        />
                        {message.stockProducts && message.stockProducts.length > 0 && (
                            <StockCard products={message.stockProducts} />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

export function TypingIndicator() {
    return (
        <div className="typing">
            <div className="typing__dot" />
            <div className="typing__dot" />
            <div className="typing__dot" />
        </div>
    );
}

export function StatusMessage({ message }) {
    const isSuccess = message.type === 'success';
    return (
        <div className={`status-message status-message--${isSuccess ? 'success' : 'error'}`}>
            <span>{isSuccess ? '✅' : '❌'}</span>
            <span>{message.content}</span>
        </div>
    );
}
