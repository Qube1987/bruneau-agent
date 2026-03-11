import { useState, useEffect, useRef, useCallback } from 'react';
import { useAgent } from './hooks/useAgent';
import { useAuth } from './hooks/useAuth.jsx';
import { useSpeechRecognition, useSpeechSynthesis } from './hooks/useSpeech';
import { usePushNotifications } from './hooks/usePushNotifications';
import { ChatMessage, TypingIndicator, StatusMessage } from './components/ChatMessage';
import { ConfirmationCard, SelectionCard } from './components/ActionCard';
import { ComposeCard } from './components/ComposeCard';
import NotificationPanel, { getNotifBadgeCount } from './components/NotificationPanel';
import AgendaPanel from './components/AgendaPanel';
import MyDayPanel from './components/MyDayPanel';
import EmailPanel from './components/EmailPanel';
import LoginScreen from './components/LoginScreen';

const SUGGESTIONS = [
  { icon: '\u{1F4C5}', text: 'Résume ma journée' },
  { icon: '\u{23F0}', text: 'Prochain RDV' },
  { icon: '\u{1F4A1}', text: 'Je suis libre quand aujourd\'hui ?' },
  { icon: '\u{1F4CA}', text: 'Résume ma semaine' },
  { icon: '\u{1F527}', text: 'Crée un SAV pour M. Dupont, pile centrale HS' },
  { icon: '\u{1F50D}', text: 'Cherche le client Lefebvre dans le CRM' },
];

export default function App() {
  const { currentUser, loading, signOut } = useAuth();
  const { messages, isProcessing, sendMessage, respondToAction, clearConversation, setAgendaContext } = useAgent();
  const { isListening, currentText, toggleListening, stopListening, getFinalTranscript } = useSpeechRecognition();
  const { speak } = useSpeechSynthesis();
  const [inputText, setInputText] = useState('');
  const [showMyDay, setShowMyDay] = useState(false);
  const [showRdvConfirm, setShowRdvConfirm] = useState(false);
  const [showEmails, setShowEmails] = useState(false);
  const [agendaData, setAgendaData] = useState({ allApts: [], tasks: [], setTasks: null });
  const chatRef = useRef(null);
  const inputRef = useRef(null);
  const agendaRef = useRef(null);

  // Push notifications
  const { isSubscribed, isSupported, subscribing, subscribe, unsubscribe } = usePushNotifications(currentUser?.id);

  // Check for ?action= in URL (from push notification click)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get('action');
    if (action === 'rdv-confirm') {
      setShowRdvConfirm(true);
    } else if (action === 'myday') {
      setShowMyDay(true);
    } else if (action === 'emails') {
      setShowEmails(true);
    }
    if (action) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const handleAgendaData = useCallback((data) => {
    setAgendaData(data);
    setAgendaContext({
      allApts: data.allApts,
      tasks: data.tasks,
      userCode: currentUser?.extrabat_code,
      userName: currentUser?.display_name,
    });
  }, [setAgendaContext, currentUser]);

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

  // When speech recognition ends, keep text in the input for review/editing
  const wasListeningRef = useRef(false);
  useEffect(() => {
    if (wasListeningRef.current && !isListening) {
      const text = getFinalTranscript();
      if (text) {
        setInputText(text);
        // Focus the input so the user can edit immediately
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    }
    wasListeningRef.current = isListening;
  }, [isListening, getFinalTranscript]);

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
      // Text stays in input for review/editing
    } else {
      setInputText('');
      toggleListening();
    }
  };

  const handleSuggestion = (text) => {
    setInputText(text);
    sendMessage(text);
  };

  const [showUserMenu, setShowUserMenu] = useState(false);

  const isEmpty = messages.length === 0;

  // Show loading while checking auth
  if (loading) return <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="login-loading">Chargement...</div></div>;

  // Show login screen if not authenticated
  if (!currentUser) return <LoginScreen />;

  return (
    <div className="app" onClick={() => showUserMenu && setShowUserMenu(false)}>
      {/* Header */}
      <header className="header">
        <div className="header__brand">
          <div className="header__logo">🤖</div>
          <div className="header__title">Bruneau Agent</div>
        </div>
        <div className="header__user-wrapper">
          <button
            className="header__user-btn"
            onClick={(e) => { e.stopPropagation(); setShowUserMenu(!showUserMenu); }}
            title={currentUser.display_name}
          >
            {currentUser.display_name.charAt(0)}
          </button>
          {showUserMenu && (
            <div className="header__dropdown" onClick={(e) => e.stopPropagation()}>
              <div className="header__dropdown-name">{currentUser.display_name}</div>
              <div className="header__dropdown-email">{currentUser.email}</div>
              <div className="header__dropdown-divider" />
              {isSupported && (
                <button
                  className="header__dropdown-item"
                  disabled={subscribing}
                  onClick={async () => {
                    if (isSubscribed) {
                      await unsubscribe();
                    } else {
                      await subscribe();
                    }
                  }}
                >
                  {subscribing
                    ? '⏳ Activation...'
                    : isSubscribed
                      ? '🔔 Notifications activées'
                      : '🔕 Activer les notifications'}
                  {!subscribing && <span className={`header__dropdown-dot ${isSubscribed ? 'header__dropdown-dot--on' : ''}`} />}
                </button>
              )}
              <button className="header__dropdown-item header__dropdown-item--danger" onClick={signOut}>
                🚪 Se déconnecter
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Agenda Panel */}
      <AgendaPanel ref={agendaRef} onDataReady={handleAgendaData} userCode={currentUser.extrabat_code} userName={currentUser.display_name} />

      {/* My Day Overlay */}
      <MyDayPanel
        visible={showMyDay}
        onClose={() => setShowMyDay(false)}
        allApts={agendaData.allApts}
        tasks={agendaData.tasks}
        setTasks={agendaData.setTasks}
        userCode={currentUser.extrabat_code}
        userName={currentUser.display_name}
      />

      {showRdvConfirm && (
        <NotificationPanel
          onClose={() => setShowRdvConfirm(false)}
          tasks={agendaData.tasks}
          onNavigate={(tab) => {
            setShowRdvConfirm(false);
            agendaRef.current?.openTab(tab);
          }}
        />
      )}

      {/* Email Panel */}
      <EmailPanel
        visible={showEmails}
        onClose={() => setShowEmails(false)}
      />

      {/* Chat Area */}
      <div className={`chat ${isEmpty ? 'chat--empty' : ''}`} ref={chatRef}>
        {isEmpty ? (
          <div className="welcome">
            <div className="welcome__icon">🤖</div>
            <h1 className="welcome__title">Bonjour !</h1>
            <p className="welcome__text">
              Je suis votre assistant vocal. Parlez-moi ou tapez une commande.
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
            if (msg.type === 'compose_sms' || msg.type === 'compose_email') {
              return <ComposeCard key={msg.id} message={msg} />;
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
        <div className="input-area__quick-actions">
          <button
            className="input-area__quick-btn"
            onClick={() => setShowMyDay(true)}
            title="Ma journée"
          >
            ☀️
          </button>
          <button
            className="input-area__quick-btn"
            onClick={() => setShowEmails(true)}
            title="Emails"
          >
            📧
          </button>
          <button
            className="input-area__quick-btn input-area__quick-btn--bell"
            onClick={() => setShowRdvConfirm(true)}
            title="Notifications"
          >
            🔔
            {getNotifBadgeCount(agendaData.tasks) > 0 && (
              <span className="input-area__badge">{getNotifBadgeCount(agendaData.tasks)}</span>
            )}
          </button>
          {messages.length > 0 && (
            <button
              className="input-area__quick-btn"
              onClick={clearConversation}
              title="Effacer la conversation"
            >
              🗑️
            </button>
          )}
        </div>
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
