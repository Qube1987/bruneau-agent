import { useState, useRef, useCallback } from 'react';

export function useSpeechRecognition() {
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState('');
    const [interimTranscript, setInterimTranscript] = useState('');
    const recognitionRef = useRef(null);
    const finalTranscriptRef = useRef('');

    const startListening = useCallback(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert("Votre navigateur ne supporte pas la reconnaissance vocale. Utilisez Chrome.");
            return;
        }

        // Reset
        finalTranscriptRef.current = '';
        setTranscript('');
        setInterimTranscript('');

        const recognition = new SpeechRecognition();
        recognition.lang = 'fr-FR';
        recognition.continuous = false;  // Single utterance — stops automatically when user pauses
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
            setIsListening(true);
        };

        recognition.onresult = (event) => {
            let final = '';
            let interim = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) {
                    final += result[0].transcript;
                } else {
                    interim = result[0].transcript;  // Only keep the latest interim, don't accumulate
                }
            }

            if (final) {
                finalTranscriptRef.current += final;
                setTranscript(finalTranscriptRef.current);
                setInterimTranscript('');
            } else {
                setInterimTranscript(interim);
            }
        };

        recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            // Don't stop for "no-speech" — user just hasn't started talking yet
            if (event.error !== 'no-speech') {
                setIsListening(false);
            }
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
        const result = finalTranscriptRef.current || (transcript + ' ' + interimTranscript).trim();
        finalTranscriptRef.current = '';
        setTranscript('');
        setInterimTranscript('');
        return result;
    }, [transcript, interimTranscript]);

    return {
        isListening,
        transcript,
        interimTranscript,
        currentText: (transcript ? transcript + ' ' : '') + interimTranscript,
        toggleListening,
        stopListening,
        getFinalTranscript,
    };
}

export function useSpeechSynthesis() {
    const [isSpeaking, setIsSpeaking] = useState(false);

    const speak = useCallback((text) => {
        if (!('speechSynthesis' in window)) return;

        // Clean text for speech: remove emojis, markdown, and special chars
        let cleanText = text
            // Remove emojis (comprehensive Unicode emoji ranges)
            .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // Emoticons
            .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // Symbols & Pictographs
            .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // Transport & Map
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // Flags
            .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Misc symbols
            .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Dingbats
            .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // Variation selectors
            .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // Supplemental symbols
            .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '') // Chess symbols
            .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '') // Symbols extended
            .replace(/[\u{200D}]/gu, '')             // Zero width joiner
            .replace(/[⚠️✅❌📋📊📦🔧🎙️🤖⬆️⬇️➡️⭐🔴🟢🟡🔵]/g, '') // Common specific emojis
            // Remove markdown bold markers
            .replace(/\*\*/g, '')
            .replace(/__/g, '')
            // Remove bullet characters
            .replace(/^\s*[-•]\s+/gm, '')
            // Clean up multiple spaces and extra whitespace
            .replace(/\s{2,}/g, ' ')
            .replace(/\|\s*/g, ', ')
            .trim();

        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(cleanText);
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
