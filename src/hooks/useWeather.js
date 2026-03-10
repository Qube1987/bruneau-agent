import { useState, useEffect } from 'react';

const WEATHER_CODES = {
    0: { desc: 'Ciel dégagé', icon: '☀️' },
    1: { desc: 'Peu nuageux', icon: '🌤️' },
    2: { desc: 'Partiellement nuageux', icon: '⛅' },
    3: { desc: 'Couvert', icon: '☁️' },
    45: { desc: 'Brouillard', icon: '🌫️' },
    48: { desc: 'Brouillard givrant', icon: '🌫️' },
    51: { desc: 'Bruine légère', icon: '🌦️' },
    53: { desc: 'Bruine', icon: '🌦️' },
    55: { desc: 'Bruine forte', icon: '🌧️' },
    61: { desc: 'Pluie légère', icon: '🌦️' },
    63: { desc: 'Pluie', icon: '🌧️' },
    65: { desc: 'Pluie forte', icon: '🌧️' },
    71: { desc: 'Neige légère', icon: '🌨️' },
    73: { desc: 'Neige', icon: '🌨️' },
    75: { desc: 'Neige forte', icon: '❄️' },
    80: { desc: 'Averses légères', icon: '🌦️' },
    81: { desc: 'Averses', icon: '🌧️' },
    82: { desc: 'Averses fortes', icon: '⛈️' },
    95: { desc: 'Orage', icon: '⛈️' },
    96: { desc: 'Orage avec grêle', icon: '⛈️' },
    99: { desc: 'Orage violent', icon: '⛈️' },
};

// Default location: Bordeaux area (for Bruneau Protection)
const DEFAULT_LAT = 44.8378;
const DEFAULT_LON = -0.5792;

/**
 * Fetches weather data from Open-Meteo (free, no API key needed).
 * Returns { today, forecast } where forecast is array of 5 days.
 */
export function useWeather(lat = DEFAULT_LAT, lon = DEFAULT_LON) {
    const [weather, setWeather] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        const cacheKey = `weather_${lat}_${lon}`;
        const cached = sessionStorage.getItem(cacheKey);

        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Date.now() - parsed._ts < 30 * 60 * 1000) {
                    setWeather(parsed);
                    setLoading(false);
                    return;
                }
            } catch { /* ignore */ }
        }

        async function fetchWeather() {
            try {
                const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe/Paris&forecast_days=5`;
                const resp = await fetch(url);
                const data = await resp.json();
                if (cancelled) return;

                const code = data.current?.weather_code ?? 0;
                const info = WEATHER_CODES[code] || { desc: 'Inconnu', icon: '🌡️' };

                const result = {
                    today: {
                        temp: Math.round(data.current?.temperature_2m ?? 0),
                        wind: Math.round(data.current?.wind_speed_10m ?? 0),
                        description: info.desc,
                        icon: info.icon,
                        code,
                    },
                    forecast: (data.daily?.time || []).map((date, i) => {
                        const dayCode = data.daily.weather_code?.[i] ?? 0;
                        const dayInfo = WEATHER_CODES[dayCode] || { desc: 'Inconnu', icon: '🌡️' };
                        return {
                            date,
                            tempMax: Math.round(data.daily.temperature_2m_max?.[i] ?? 0),
                            tempMin: Math.round(data.daily.temperature_2m_min?.[i] ?? 0),
                            description: dayInfo.desc,
                            icon: dayInfo.icon,
                            code: dayCode,
                        };
                    }),
                    _ts: Date.now(),
                };

                setWeather(result);
                sessionStorage.setItem(cacheKey, JSON.stringify(result));
            } catch (e) {
                console.warn('Weather fetch failed:', e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        fetchWeather();
        return () => { cancelled = true; };
    }, [lat, lon]);

    return { weather, loading };
}
