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
