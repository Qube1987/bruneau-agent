/**
 * phoneUtils.js — Utility functions for phone number extraction & prioritization.
 *
 * When Extrabat returns multiple phone numbers for a client, we want
 * to prefer mobile numbers (06/07/+336/+337) for SMS confirmations.
 */

/**
 * Check if a phone number is a French mobile number.
 * Accepts formats: 06…, 07…, +336…, +337…, 00336…, 00337…
 */
export function isMobileNumber(phone) {
    if (!phone || typeof phone !== 'string') return false;
    const cleaned = phone.replace(/[\s.\-()]/g, '');
    return /^(06|07|\+336|\+337|00336|00337)/.test(cleaned);
}

/**
 * Extract the best phone number from an Extrabat client object
 * and/or appointment object.
 *
 * Priority:
 *   1. Mobile numbers from telephones[] array
 *   2. Mobile numbers from flat fields (telephone, mobile, portable, etc.)
 *   3. First available number from telephones[] array
 *   4. First available flat field
 *
 * @param {object|null} client - The client object from Extrabat
 * @param {object|null} apt    - The appointment object (fallback)
 * @returns {string} The best phone number, or '' if none found
 */
export function extractBestPhone(client, apt) {
    const allNumbers = [];

    // 1. Collect all numbers from telephones[] array (v2 API format)
    if (client?.telephones && Array.isArray(client.telephones)) {
        for (const t of client.telephones) {
            const num = t?.number || t?.numero || '';
            if (num) allNumbers.push(num);
        }
    }

    // 2. Collect flat field numbers from client
    const flatFields = [
        client?.telephone,
        client?.mobile,
        client?.portable,
        client?.tel,
        client?.telPortable,
        client?.telMobile,
    ];
    for (const f of flatFields) {
        if (f && typeof f === 'string' && f.trim()) {
            allNumbers.push(f.trim());
        }
    }

    // 3. Collect from appointment-level fields (fallback)
    const aptFields = [apt?.telephone, apt?.phone];
    for (const f of aptFields) {
        if (f && typeof f === 'string' && f.trim()) {
            allNumbers.push(f.trim());
        }
    }

    // Deduplicate (normalize by removing spaces/dots for comparison)
    const seen = new Set();
    const unique = [];
    for (const num of allNumbers) {
        const key = num.replace(/[\s.\-()]/g, '');
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(num);
        }
    }

    if (unique.length === 0) return '';

    // Prefer mobile numbers
    const mobile = unique.find(n => isMobileNumber(n));
    if (mobile) return mobile;

    // Fallback: return first available number
    return unique[0];
}
