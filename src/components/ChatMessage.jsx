export function ChatMessage({ message }) {
    const isUser = message.role === 'user';

    return (
        <div className={`message message--${isUser ? 'user' : 'agent'}`}>
            <span className="message__label">
                {isUser ? '🎙️ Vous' : '🤖 Agent'}
            </span>
            <div className="message__bubble">
                {message.content}
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
