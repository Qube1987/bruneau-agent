import { useRef, useCallback } from 'react';

const THRESHOLD = 80;

export function useSwipe({ onSwipeLeft, onSwipeRight }) {
    const startX = useRef(0);
    const currentX = useRef(0);
    const swiping = useRef(false);
    const elRef = useRef(null);

    const onTouchStart = useCallback((e) => {
        startX.current = e.touches[0].clientX;
        currentX.current = startX.current;
        swiping.current = true;
    }, []);

    const onTouchMove = useCallback((e) => {
        if (!swiping.current || !elRef.current) return;
        currentX.current = e.touches[0].clientX;
        const dx = currentX.current - startX.current;
        const clamped = Math.max(-120, Math.min(120, dx));
        elRef.current.style.transform = `translateX(${clamped}px)`;
        elRef.current.style.transition = 'none';
    }, []);

    const onTouchEnd = useCallback(() => {
        if (!swiping.current || !elRef.current) return;
        swiping.current = false;
        const dx = currentX.current - startX.current;
        elRef.current.style.transition = 'transform 200ms ease';
        elRef.current.style.transform = 'translateX(0)';

        if (dx > THRESHOLD && onSwipeRight) {
            onSwipeRight();
        } else if (dx < -THRESHOLD && onSwipeLeft) {
            onSwipeLeft();
        }
    }, [onSwipeLeft, onSwipeRight]);

    return { elRef, onTouchStart, onTouchMove, onTouchEnd };
}
