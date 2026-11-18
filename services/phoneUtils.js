/**
 * Canonical WhatsApp / Urutau phone and JID normalization utilities.
 */

function getAsuncionDateTimeParts(date = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Asuncion',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).formatToParts(date);
        const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
        const hour = map.hour === '24' ? '00' : map.hour;
        return {
            dateStr: `${map.year}-${map.month}-${map.day}`,
            timeStr: `${hour}:${map.minute}:${map.second}`,
            hour: Number(hour),
            minute: Number(map.minute)
        };
    } catch {
        const pad = (n) => String(n).padStart(2, '0');
        return {
            dateStr: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
            timeStr: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
            hour: date.getHours(),
            minute: date.getMinutes()
        };
    }
}

function normalizePhoneString(rawValue) {
    if (!rawValue) return '';
    const str = String(rawValue).trim();
    if (!str) return '';

    if (str.startsWith('lid:')) {
        const digits = str.slice(4).replace(/\D/g, '');
        return digits ? `lid:${digits}` : '';
    }

    if (str.includes('@lid')) {
        const lidUser = str.split('@')[0].split(':')[0].replace(/\D/g, '');
        return lidUser ? `lid:${lidUser}` : '';
    }

    const beforeAt = str.split('@')[0];
    const beforeDevice = beforeAt.split(':')[0];
    return beforeDevice.replace(/\D/g, '');
}

function getCanonicalPhone(messageOrRaw) {
    if (!messageOrRaw) return '';
    if (typeof messageOrRaw === 'string') {
        return normalizePhoneString(messageOrRaw);
    }

    let rawJid = String(messageOrRaw.from || '');
    if (rawJid.includes('@lid')) {
        const alt = messageOrRaw.raw?.key?.remoteJidAlt || messageOrRaw.raw?.senderPn;
        const senderId = typeof messageOrRaw.sender?.id === 'string'
            ? messageOrRaw.sender.id
            : (messageOrRaw.sender?.id?._serialized || messageOrRaw.sender?.id?.user || '');
        const resolved = [alt, senderId].find(
            (candidate) => typeof candidate === 'string' && (candidate.includes('@s.whatsapp.net') || candidate.includes('@c.us'))
        );
        if (resolved) {
            rawJid = resolved;
        }
    }
    return normalizePhoneString(rawJid);
}

function formatWhatsAppJid(target) {
    const str = String(target || '').trim();
    if (!str) return '';
    if (str.includes('@g.us') || str.includes('@lid')) return str;
    if (str.startsWith('lid:')) return `${str.slice(4)}@lid`;
    const digits = normalizePhoneString(str);
    return digits ? `${digits}@s.whatsapp.net` : '';
}

function formatUrutauPhone(phone) {
    const normalized = normalizePhoneString(phone);
    if (!normalized || normalized.startsWith('lid:')) return normalized;
    return `+${normalized}`;
}

module.exports = {
    getAsuncionDateTimeParts,
    normalizePhoneString,
    getCanonicalPhone,
    formatWhatsAppJid,
    formatUrutauPhone
};
