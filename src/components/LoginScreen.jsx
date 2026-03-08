import { useState } from 'react';
import { useAuth } from '../hooks/useAuth.jsx';

export default function LoginScreen() {
    const { signIn } = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!email || !password) return;

        setLoading(true);
        setError('');

        const { error: authError } = await signIn(email, password);
        if (authError) {
            setError('Email ou mot de passe incorrect');
        }
        setLoading(false);
    };

    return (
        <div className="login-screen">
            <div className="login-card">
                <div className="login-header">
                    <div className="login-logo">🤖</div>
                    <h1 className="login-title">Bruneau Agent</h1>
                    <p className="login-subtitle">Connectez-vous pour accéder à votre espace</p>
                </div>

                {error && (
                    <div className="login-error-box">
                        <span>⚠️</span> {error}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="login-form">
                    <div className="login-field">
                        <label className="login-label">Adresse email</label>
                        <div className="login-input-wrap">
                            <span className="login-input-icon">✉️</span>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="login-input"
                                placeholder="votre@email.com"
                                required
                                autoComplete="email"
                            />
                        </div>
                    </div>

                    <div className="login-field">
                        <label className="login-label">Mot de passe</label>
                        <div className="login-input-wrap">
                            <span className="login-input-icon">🔒</span>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="login-input"
                                placeholder="••••••••"
                                required
                                autoComplete="current-password"
                            />
                        </div>
                    </div>

                    <button
                        type="submit"
                        className="login-submit"
                        disabled={loading || !email || !password}
                    >
                        {loading ? (
                            <span className="login-spinner" />
                        ) : null}
                        {loading ? 'Connexion...' : 'Se connecter'}
                    </button>
                </form>

                <div className="login-footer">
                    Accès réservé aux utilisateurs autorisés
                </div>
            </div>
        </div>
    );
}
