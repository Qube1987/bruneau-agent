import { useState } from 'react';
import { supabase, AGENT_FUNCTION_URL, SUPABASE_ANON } from '../lib/supabase';

export function StockCard({ products, onStockUpdated }) {
    const [quantities, setQuantities] = useState({});
    const [updating, setUpdating] = useState(null);
    const [localProducts, setLocalProducts] = useState(products);
    const [feedback, setFeedback] = useState(null);

    const getQty = (id) => quantities[id] ?? 1;

    const setQty = (id, val) => {
        const n = Math.max(1, parseInt(val) || 1);
        setQuantities(prev => ({ ...prev, [id]: n }));
    };

    const updateStock = async (product, change) => {
        const qty = getQty(product.id);
        const actualChange = change > 0 ? qty : -qty;
        const location = 'depot';
        const currentQty = product.depot_quantity || 0;
        const newQty = currentQty + actualChange;

        if (newQty < 0) {
            setFeedback({ id: product.id, type: 'error', msg: `Stock insuffisant (${currentQty})` });
            setTimeout(() => setFeedback(null), 3000);
            return;
        }

        setUpdating(product.id + (change > 0 ? '+' : '-'));

        try {
            const { data: { session } } = await supabase.auth.getSession();
            const token = session?.access_token;

            const response = await fetch(AGENT_FUNCTION_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token || SUPABASE_ANON}`,
                    'apikey': SUPABASE_ANON,
                },
                body: JSON.stringify({
                    message: `${change > 0 ? 'Ajoute' : 'Retire'} ${qty} unité(s) de ${product.name}`,
                    conversation: [],
                    actionResponse: {
                        type: 'confirm',
                        confirmed: true,
                        pendingAction: 'update_stock',
                        details: {
                            product_id: product.id,
                            product_name: product.name,
                            location,
                            quantity_change: actualChange,
                            current_quantity: currentQty,
                            new_quantity: newQty,
                            comment: `Modification rapide via bouton`,
                        },
                    },
                }),
            });

            const result = await response.json();

            if (result.type === 'success') {
                // Update local state
                setLocalProducts(prev => prev.map(p =>
                    p.id === product.id
                        ? { ...p, depot_quantity: newQty, total_quantity: newQty + (p.paul_truck_quantity || 0) + (p.quentin_truck_quantity || 0) }
                        : p
                ));
                setFeedback({ id: product.id, type: 'success', msg: `${currentQty} → ${newQty}` });
                if (onStockUpdated) onStockUpdated(product.id, newQty);
            } else {
                setFeedback({ id: product.id, type: 'error', msg: result.message || 'Erreur' });
            }
        } catch (e) {
            setFeedback({ id: product.id, type: 'error', msg: 'Erreur réseau' });
        } finally {
            setUpdating(null);
            setTimeout(() => setFeedback(null), 3000);
        }
    };

    if (!localProducts?.length) return null;

    return (
        <div className="stock-card">
            <div className="stock-card__header">
                <span className="stock-card__icon">📦</span>
                <span>{localProducts.length} produit{localProducts.length > 1 ? 's' : ''}</span>
            </div>
            <div className="stock-card__list">
                {localProducts.map(product => {
                    const isLow = product.total_quantity < (product.min_quantity || 0) && product.min_quantity > 0;
                    const fb = feedback?.id === product.id ? feedback : null;

                    return (
                        <div
                            key={product.id}
                            className={`stock-item ${isLow ? 'stock-item--low' : ''}`}
                        >
                            <div className="stock-item__info">
                                <div className="stock-item__name">{product.name}</div>
                                <div className="stock-item__details">
                                    <span className="stock-item__qty">
                                        Dépôt: <strong>{product.depot_quantity}</strong>
                                    </span>
                                    {product.paul_truck_quantity > 0 && (
                                        <span className="stock-item__qty">Paul: {product.paul_truck_quantity}</span>
                                    )}
                                    {product.quentin_truck_quantity > 0 && (
                                        <span className="stock-item__qty">Quentin: {product.quentin_truck_quantity}</span>
                                    )}
                                    {isLow && <span className="stock-item__badge">⚠️ Bas</span>}
                                </div>
                            </div>
                            <div className="stock-item__controls">
                                <button
                                    className="stock-btn stock-btn--minus"
                                    onClick={() => updateStock(product, -1)}
                                    disabled={updating !== null}
                                    title="Retirer"
                                >
                                    {updating === product.id + '-' ? '⏳' : '−'}
                                </button>
                                <input
                                    className="stock-input"
                                    type="number"
                                    min="1"
                                    value={getQty(product.id)}
                                    onChange={(e) => setQty(product.id, e.target.value)}
                                    disabled={updating !== null}
                                />
                                <button
                                    className="stock-btn stock-btn--plus"
                                    onClick={() => updateStock(product, 1)}
                                    disabled={updating !== null}
                                    title="Ajouter"
                                >
                                    {updating === product.id + '+' ? '⏳' : '+'}
                                </button>
                            </div>
                            {fb && (
                                <div className={`stock-item__feedback stock-item__feedback--${fb.type}`}>
                                    {fb.type === 'success' ? '✅' : '❌'} {fb.msg}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
