function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function redactTelegramSecret(text) {
    return String(text || '').replace(/bot[^\s/]+/gi, 'bot[REDACTED]');
}

class TelegramAlert {
    constructor() {
        this.lastAlert = new Map();
        this.COOLDOWN_MS = 5 * 60 * 1000;
    }

    getConfig() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        return { token, chatId, enabled: Boolean(token && chatId) };
    }

    async send(tipo, mensagem) {
        const { token, chatId, enabled } = this.getConfig();
        if (!enabled) return false;

        const now = Date.now();
        const lastSent = this.lastAlert.get(tipo);
        if (lastSent && (now - lastSent) < this.COOLDOWN_MS) {
            return false;
        }

        const hora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Asuncion' });
        const texto = `🚨 <b>ALERTA — Studio Ferreira Bot</b>\n\n` +
            `<b>Tipo:</b> ${escapeHtml(tipo)}\n` +
            `<b>Hora:</b> ${escapeHtml(hora)}\n\n` +
            `${escapeHtml(String(mensagem || '').slice(0, 1500))}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: texto,
                    parse_mode: 'HTML'
                }),
                signal: controller.signal
            });

            if (response.ok) {
                this.lastAlert.set(tipo, now);
                return true;
            }
            const errBody = await response.text().catch(() => '');
            console.error(`[TelegramAlert] HTTP ${response.status}:`, redactTelegramSecret(errBody).slice(0, 200));
            return false;
        } catch (err) {
            console.error('[TelegramAlert] Falha ao enviar alerta:', redactTelegramSecret(err.message));
            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}

module.exports = new TelegramAlert();
