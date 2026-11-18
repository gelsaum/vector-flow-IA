const axios = require('axios');
const { formatWhatsAppJid, normalizePhoneString } = require('./phoneUtils');

class WhatsappService {
    constructor() {
        this.client = true;
        this.handler = null;
        this.sentMessageIds = new Set();
        this.pendingOutbound = new Map(); // canonicalTarget -> expiryTimestamp[]
    }

    _getConfig() {
        return {
            apiUrl: process.env.EVOLUTION_API_URL ? process.env.EVOLUTION_API_URL.replace(/\/$/, '') : '',
            apiKey: process.env.EVOLUTION_API_KEY,
            instanceName: process.env.EVOLUTION_INSTANCE_NAME
        };
    }

    _trackSentId(id) {
        if (!id) return;
        this.sentMessageIds.add(id);
        if (this.sentMessageIds.size > 500) {
            const first = this.sentMessageIds.values().next().value;
            this.sentMessageIds.delete(first);
        }
    }

    _markPendingSend(target) {
        const key = normalizePhoneString(target);
        if (!key) return;
        const now = Date.now();
        const active = (this.pendingOutbound.get(key) || []).filter((exp) => exp > now);
        active.push(now + 15000);
        this.pendingOutbound.set(key, active);
    }

    _consumePendingSend(jid) {
        const key = normalizePhoneString(jid);
        if (!key) return false;
        const now = Date.now();
        const active = (this.pendingOutbound.get(key) || []).filter((exp) => exp > now);
        if (active.length === 0) {
            this.pendingOutbound.delete(key);
            return false;
        }
        active.shift();
        if (active.length === 0) {
            this.pendingOutbound.delete(key);
        } else {
            this.pendingOutbound.set(key, active);
        }
        return true;
    }

    async start(messageHandler) {
        this.handler = messageHandler;
        const { instanceName } = this._getConfig();
        console.log(`[WhatsappService] Configurado para usar Evolution API en instancia: ${instanceName}`);
        console.log('Esperando webhooks en /webhook...');
    }

    async sendText(to, content) {
        const { apiUrl, apiKey, instanceName } = this._getConfig();
        if (!apiUrl || !apiKey || !instanceName) {
            console.error('[WhatsappService] ERRO: Configurações da Evolution API ausentes no .env');
            return null;
        }

        const numberToSend = formatWhatsAppJid(to);
        if (!numberToSend) return null;
        const isGroup = numberToSend.includes('@g.us');

        this._markPendingSend(numberToSend);

        try {
            const res = await axios.post(
                `${apiUrl}/message/sendText/${encodeURIComponent(instanceName)}`,
                { number: numberToSend, text: content },
                { headers: { apikey: apiKey, 'Content-Type': 'application/json' }, timeout: 10000 }
            );
            this._trackSentId(res.data?.key?.id);
            return res.data || { sent: true };
        } catch (error) {
            if (!isGroup && numberToSend.includes('@s.whatsapp.net')) {
                const digitsOnly = numberToSend.replace('@s.whatsapp.net', '');
                try {
                    const retryRes = await axios.post(
                        `${apiUrl}/message/sendText/${encodeURIComponent(instanceName)}`,
                        { number: digitsOnly, text: content },
                        { headers: { apikey: apiKey, 'Content-Type': 'application/json' }, timeout: 10000 }
                    );
                    this._trackSentId(retryRes.data?.key?.id);
                    return retryRes.data || { sent: true };
                } catch {
                    // Falhou em ambos os formatos
                }
            }
            console.error('[WhatsappService] Erro ao enviar mensagem via Evolution API:', error.response ? error.response.data : error.message);
            return null;
        }
    }

    async getContact() {
        return { pushname: 'Cliente' };
    }

    _asString(value) {
        return typeof value === 'string' ? value : '';
    }

    _extractTextAndMedia(data) {
        const msg = (data && typeof data.message === 'object' && data.message) ? data.message : {};
        let body = '';
        let mediaType = null;
        let mediaInfo = null;

        if (typeof msg.conversation === 'string') {
            body = msg.conversation;
        } else if (typeof msg.extendedTextMessage?.text === 'string') {
            body = msg.extendedTextMessage.text;
        } else if (data.messageType === 'conversation' || data.messageType === 'extendedTextMessage') {
            body = this._asString(msg.text) || this._asString(data.body);
        } else if (typeof msg.buttonsResponseMessage?.selectedButtonId === 'string') {
            body = msg.buttonsResponseMessage.selectedButtonId;
        } else if (typeof msg.listResponseMessage?.singleSelectReply?.selectedRowId === 'string') {
            body = msg.listResponseMessage.singleSelectReply.selectedRowId;
        } else if (typeof msg.templateButtonReplyMessage?.selectedId === 'string') {
            body = msg.templateButtonReplyMessage.selectedId;
        } else if (typeof data.body === 'string') {
            body = data.body;
        }

        if (msg.audioMessage) {
            mediaType = 'audio';
            mediaInfo = {
                seconds: Number(msg.audioMessage.seconds || 0),
                ptt: Boolean(msg.audioMessage.ptt),
                mimetype: this._asString(msg.audioMessage.mimetype) || 'audio/ogg; codecs=opus'
            };
        } else if (msg.imageMessage) {
            mediaType = 'image';
            const caption = this._asString(msg.imageMessage.caption);
            if (!body && caption) body = caption;
            mediaInfo = {
                caption,
                mimetype: this._asString(msg.imageMessage.mimetype) || 'image/jpeg'
            };
        } else if (msg.stickerMessage) {
            mediaType = 'sticker';
        } else if (!body && (msg.videoMessage || msg.documentMessage || msg.locationMessage || msg.contactMessage)) {
            mediaType = 'unsupported';
        }

        return { body, mediaType, mediaInfo };
    }

    _dispatchItem(data) {
        if (!data || !data.key) return;

        const from = this._asString(data.key.remoteJid);
        if (!from || from === 'status@broadcast' || from.endsWith('@broadcast') || from.endsWith('@newsletter')) {
            return;
        }

        const isGroupMsg = from.includes('@g.us');
        const { body, mediaType, mediaInfo } = this._extractTextAndMedia(data);

        // Ignorar eventos vazios (protocolMessage, reações, sync) ANTES de verificar fromMe
        if (!body && !mediaType) return;

        if (data.key.fromMe) {
            if (data.key.id && this.sentMessageIds.has(data.key.id)) {
                return;
            }
            if (this._consumePendingSend(from)) {
                return; // Eco do próprio bot antes de finalizar o POST HTTP
            }
            if (!isGroupMsg) {
                Promise.resolve(this.handler({
                    from,
                    body,
                    mediaType,
                    mediaInfo,
                    isGroupMsg,
                    isHumanAttendantReply: true,
                    sender: { id: from },
                    raw: data
                })).catch((err) => {
                    console.error('[WhatsappService] Erro no handler (fromMe):', err);
                });
            }
            return;
        }

        console.log(`[WhatsappService] Processando mensagem de ${from} (${mediaType || 'text'}): "${body.slice(0, 80)}"`);

        Promise.resolve(this.handler({
            from,
            body,
            mediaType,
            mediaInfo,
            isGroupMsg,
            isHumanAttendantReply: false,
            sender: { id: from },
            raw: data
        })).catch((err) => {
            console.error('[WhatsappService] Erro assíncrono no handler:', err);
        });
    }

    handleEvolutionWebhook(payload) {
        if (!this.handler || !payload || typeof payload !== 'object') return;

        const { instanceName } = this._getConfig();
        if (instanceName && payload.instance && payload.instance !== instanceName) {
            return;
        }

        const rawEvent = this._asString(payload.event || payload.type);
        const eventName = rawEvent.toLowerCase().replace(/[-_]/g, '.');
        if (eventName !== 'messages.upsert') return;

        let items = [];
        if (Array.isArray(payload.data)) {
            items = payload.data;
        } else if (Array.isArray(payload.data?.messages)) {
            items = payload.data.messages;
        } else if (payload.data && typeof payload.data === 'object') {
            items = [payload.data];
        }

        for (const item of items) {
            this._dispatchItem(item);
        }
    }
}

module.exports = new WhatsappService();
