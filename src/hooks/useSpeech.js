import { useState, useRef, useCallback } from 'react';

export function useSpeechRecognition() {
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState('');
    const [interimTranscript, setInterimTranscript] = useState('');
    const recognitionRef = useRef(null);

    const startListening = useCallback(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert("Votre navigateur ne supporte pas la reconnaissance vocale. Utilisez Chrome.");
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.lang = 'fr-FR';
        recognition.continuous = true;
        recognition.interimResults = true;

        recognition.onstart = () => {
            setIsListening(true);
            setTranscript('');
            setInterimTranscript('');
        };

        recognition.onresult = (event) => {
            let finalText = '';
            let interimText = '';

            for (let i = 0; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) {
                    finalText += result[0].transcript;
                } else {
                    interimText += result[0].transcript;
                }
            }

            setTranscript(finalText);
            setInterimTranscript(interimText);
        };

        recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            setIsListening(false);
        };

        recognition.onend = () => {
            setIsListening(false);
        };

        recognitionRef.current = recognition;
        recognition.start();
    }, []);

    const stopListening = useCallback(() => {
        if (recognitionRef.current) {
            recognitionRef.current.stop();
            recognitionRef.current = null;
        }
        setIsListening(false);
    }, []);

    const toggleListening = useCallback(() => {
        if (isListening) {
            stopListening();
        } else {
            startListening();
        }
    }, [isListening, startListening, stopListening]);

    const getFinalTranscript = useCallback(() => {
        const result = (transcript + ' ' + interimTranscript).trim();
        setTranscript('');
        setInterimTranscript('');
        return result;
    }, [transcript, interimTranscript]);

    return {
        isListening,
        transcript,
        interimTranscript,
        currentText: (transcript + ' ' + interimTranscript).trim(),
        toggleListening,
        stopListening,
        getFinalTranscript,
    };
}

export function useSpeechSynthesis() {
    const [isSpeaking, setIsSpeaking] = useState(false);

    const speak = useCallback((text) => {
        if (!('speechSynthesis' in window)) return;

        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'fr-FR';
        utterance.rate = 1.05;
        utterance.pitch = 1;

        // Try to get a French voice
        const voices = window.speechSynthesis.getVoices();
        const frVoice = voices.find(v => v.lang.startsWith('fr'));
        if (frVoice) utterance.voice = frVoice;

        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = () => setIsSpeaking(false);

        window.speechSynthesis.speak(utterance);
    }, []);

    const stop = useCallback(() => {
        window.speechSynthesis.cancel();
        setIsSpeaking(false);
    }, []);

    return { isSpeaking, speak, stop };
}
