import { useState, useEffect, useRef } from 'react';
import { useAgent } from './hooks/useAgent';
import { useSpeechRecognition, useSpeechSynthesis } from './hooks/useSpeech';
import { ChatMessage, TypingIndicator, StatusMessage } from './components/ChatMessage';
import { ConfirmationCard, SelectionCard } from './components/ActionCard';
import AgendaPanel from './components/AgendaPanel';

const SUGGESTIONS = [
  { icon: '🔧', text: 'Crée un SAV pour M. Dupont, pile centrale HS' },
  { icon: '📋', text: 'Crée une opportunité pour Mme Martin, installation alarme' },
  { icon: '📊', text: 'Combien de SAV en cours cette semaine ?' },
  { icon: '🔍', text: 'Cherche le client Lefebvre dans le CRM' },
];

export default function App() {
  const { messages, isProcessing, sendMessage, respondToAction, clearConversation } = useAgent();
  const { isListening, currentText, toggleListening, stopListening, getFinalTranscript } = useSpeechRecognition();
  const { speak } = useSpeechSynthesis();
  const [inputText, setInputText] = useState('');
  const chatRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  // When voice input updates, sync to the text field
  useEffect(() => {
    if (isListening && currentText) {
      setInputText(currentText);
    }
  }, [isListening, currentText]);

  // Auto-send when speech recognition ends naturally (continuous=false)
  const wasListeningRef = useRef(false);
  useEffect(() => {
    if (wasListeningRef.current && !isListening && !isProcessing) {
      // Speech just stopped — auto-send if there's text
      const text = getFinalTranscript();
      if (text) {
        setInputText('');
        sendMessage(text);
      }
    }
    wasListeningRef.current = isListening;
  }, [isListening, isProcessing, getFinalTranscript, sendMessage]);

  // Speak agent responses
  useEffect(() => {
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'agent' && lastMsg.content && lastMsg.type !== 'thinking') {
        speak(lastMsg.content);
      }
    }
  }, [messages, speak]);

  const handleSend = () => {
    let text = inputText.trim();
    if (isListening) {
      stopListening();
      text = getFinalTranscript() || text;
    }
    if (!text) return;
    setInputText('');
    sendMessage(text);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleVoiceToggle = () => {
    if (isListening) {
      stopListening();
      // The auto-send effect will handle sending
    } else {
      setInputText('');
      toggleListening();
    }
  };

  const handleSuggestion = (text) => {
    setInputText(text);
    sendMessage(text);
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header__brand">
          <div className="header__logo">🤖</div>
          <div>
            <div className="header__title">Bruneau Agent</div>
            <div className="header__subtitle">Assistant vocal intelligent</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {messages.length > 0 && (
            <button
              onClick={clearConversation}
              style={{
                background: 'var(--bg-glass)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: 'var(--font-xs)',
                fontFamily: 'var(--font-family)',
              }}
            >
              🗑️ Nouveau
            </button>
          )}
          <div className="header__status">
            <div className="header__status-dot" />
            En ligne
          </div>
        </div>
      </header>

      {/* Agenda Panel */}
      <AgendaPanel />

      {/* Chat Area */}
      <div className={`chat ${isEmpty ? 'chat--empty' : ''}`} ref={chatRef}>
        {isEmpty ? (
          <div className="welcome">
            <div className="welcome__icon">🤖</div>
            <h1 className="welcome__title">Bonjour !</h1>
            <p className="welcome__text">
              Je suis votre assistant vocal. Parlez-moi ou tapez une commande pour gérer vos applications SAV et CRM.
            </p>
            <div className="welcome__suggestions">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  className="welcome__suggestion"
                  onClick={() => handleSuggestion(s.text)}
                >
                  <span className="welcome__suggestion-icon">{s.icon}</span>
                  <span>{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.type === 'thinking') {
              return <TypingIndicator key="thinking" />;
            }
            if (msg.type === 'confirm') {
              return (
                <ConfirmationCard
                  key={msg.id}
                  message={msg}
                  onRespond={respondToAction}
                  disabled={isProcessing}
                />
              );
            }
            if (msg.type === 'select') {
              return (
                <SelectionCard
                  key={msg.id}
                  message={msg}
                  onRespond={respondToAction}
                  disabled={isProcessing}
                />
              );
            }
            if (msg.type === 'success' || msg.type === 'error') {
              return <StatusMessage key={msg.id} message={msg} />;
            }
            return <ChatMessage key={msg.id} message={msg} />;
          })
        )}
      </div>

      {/* Input Area */}
      <div className="input-area">
        {isListening && (
          <div className="listening-indicator">
            <span className="listening-indicator__pulse" />
            Écoute en cours... {currentText && `"${currentText}"`}
          </div>
        )}
        <div className="input-area__row">
          <input
            ref={inputRef}
            className="input-area__field"
            type="text"
            placeholder={isListening ? 'Parlez maintenant...' : 'Tapez ou utilisez le micro...'}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isProcessing}
          />
          <button
            className={`voice-btn voice-btn--${isListening ? 'listening' : 'idle'}`}
            onClick={handleVoiceToggle}
            disabled={isProcessing}
            title={isListening ? 'Arrêter l\'écoute' : 'Parler'}
          >
            <span className="voice-btn__icon">
              {isListening ? '⏹️' : '🎙️'}
            </span>
          </button>
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={isProcessing || (!inputText.trim() && !isListening)}
            title="Envoyer"
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}
