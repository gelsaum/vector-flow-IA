const telegramAlert = require('./telegramAlert');
const defaultSessionService = require('./sessionService');
const msgs = require('../constants/messages');

const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 600);
const MAX_AUDIO_SECONDS = Number(process.env.MAX_AUDIO_SECONDS || 60);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 8);
const RATE_LIMIT_HOUR_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR || 35);
const BLOCK_DURATION_MS = 24 * 60 * 60 * 1000;
const HUMAN_TAKEOVER_MS = 2 * 60 * 60 * 1000;
const MAX_RATE_KEYS = 10000;

const INJECTION_AND_ABUSE_PATTERNS = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
    /olvida\s+(todas\s+)?(tus|las)\s+instrucciones/i,
    /esque[çc]a\s+(todas\s+)?(as\s+)?instru[çc][õo]es/i,
    /(system\s*prompt|developer\s*mode|jailbreak|\bDAN\b)/i,
    /\b(act\s+as|aja\s+como|act[úu]a\s+como|finja\s+ser|finge\s+ser)\b/i,
    /\b(escreva|escribe|write|gera|genera)\s+(um\s+|un\s+|a\s+)?(c[óo]digo|script|programa|python|javascript|sql|redaci[óo]n|reda[çc][ãa]o|poema|chiste|piada)\b/i,
    /\b(receita\s+de\s+bolo|receta\s+de\s+cocina|trabalho\s+escolar|tarea\s+escolar)\b/i
];

function normalizeForSecurity(text) {
    return String(text || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
        .trim();
}

class GuardrailService {
    constructor() {
        this.rateWindows = new Map(); // phone -> timestamps[]
    }

    resetRateLimits() {
        this.rateWindows.clear();
    }

    _pruneRateWindows(now) {
        if (this.rateWindows.size === 0) return;
        for (const [k, list] of this.rateWindows.entries()) {
            const active = list.filter((ts) => now - ts < RATE_LIMIT_HOUR_MS);
            if (active.length === 0) {
                this.rateWindows.delete(k);
            } else if (active.length !== list.length) {
                this.rateWindows.set(k, active);
            }
        }
        while (this.rateWindows.size > MAX_RATE_KEYS) {
            const oldestKey = this.rateWindows.keys().next().value;
            this.rateWindows.delete(oldestKey);
        }
    }

    detectLanguageWithConfidence(text, fallback = 'es') {
        const raw = normalizeForSecurity(text);
        if (!raw) return { lang: fallback === 'pt' ? 'pt' : 'es', confident: false };

        const lower = raw.toLowerCase();
        let ptScore = 0;
        let esScore = 0;

        if (/[ãõç]/i.test(lower)) ptScore += 3;
        if (/[ñ¿¡]/i.test(lower)) esScore += 3;

        const ptPatterns = [
            /\b(oi|ol[áa]|tudo\s+bem|bom\s+dia|boa\s+tarde|boa\s+noite)\b/g,
            /\b(voc[êe]|quero|gostaria|amanh[ãa]|hor[áa]rio|marcar|remarcar|reagendar)\b/g,
            /\b(obrigad[oa]|pre[çc]o|servi[çc]o|com\s+o|pra\s+mim|meu\s+agendamento|minhas?\s+citas?|tem\s+vaga)\b/g,
            /\b(n[ãa]o|sim|entendi|beleza|valeu|pode\s+ser)\b/g
        ];
        const esPatterns = [
            /\b(hola|buenos\s+d[íi]as|buenas\s+tardes|buenas\s+noches)\b/g,
            /\b(quiero|quisiera|ma[ñn]ana|turno|cita|peluquero|barbero|reservar)\b/g,
            /\b(gracias|precio|servicio|disponibilidad|con\s+el|para\s+m[íi]|mis\s+citas|hay\s+lugar)\b/g,
            /\b(buen[íi]simo|dale|genial|listo|todav[íi]a)\b/g
        ];

        for (const regex of ptPatterns) {
            const matches = lower.match(regex);
            if (matches) ptScore += matches.length * 2;
        }
        for (const regex of esPatterns) {
            const matches = lower.match(regex);
            if (matches) esScore += matches.length * 2;
        }

        if (ptScore === esScore) {
            return { lang: fallback === 'pt' ? 'pt' : 'es', confident: false };
        }
        return { lang: ptScore > esScore ? 'pt' : 'es', confident: true };
    }

    detectLanguage(text, fallback = 'es') {
        return this.detectLanguageWithConfidence(text, fallback).lang;
    }

    isPromptInjectionOrAbuse(text) {
        const clean = normalizeForSecurity(text);
        if (!clean) return false;
        return INJECTION_AND_ABUSE_PATTERNS.some((pattern) => pattern.test(clean));
    }

    isTextWithinLimit(text) {
        return normalizeForSecurity(text).length <= MAX_TEXT_CHARS;
    }

    _checkRateLimit(phone, now) {
        if (this.rateWindows.size > 500) {
            this._pruneRateWindows(now);
        }
        const history = (this.rateWindows.get(phone) || []).filter((ts) => now - ts < RATE_LIMIT_HOUR_MS);
        history.push(now);
        this.rateWindows.set(phone, history);

        const lastMinuteCount = history.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS).length;
        return lastMinuteCount <= RATE_LIMIT_MAX_PER_MIN && history.length <= RATE_LIMIT_MAX_PER_HOUR;
    }

    _isActivelyBlocked(control, now) {
        return Boolean(
            control && (
                control.blocked_until === -1 ||
                control.blocked_until > now
            )
        );
    }

    async checkIncoming(phone, payload, sessionService = defaultSessionService) {
        const now = Date.now();
        const fallbackLang = payload.lang || 'es';
        const text = normalizeForSecurity(payload.body || '');
        const { lang, confident } = this.detectLanguageWithConfidence(text, fallbackLang);

        const control = await sessionService.getAgentControl(phone);

        // Bloqueio ativo independe de control.mode (protege contra regressões)
        if (this._isActivelyBlocked(control, now)) {
            return { allowed: false, silent: true, reason: 'BLOCKED', lang, langConfident: confident };
        }

        if (control.mode === 'BLOCKED' && control.blocked_until > 0 && control.blocked_until <= now) {
            await sessionService.setAgentControl(phone, {
                mode: 'BOT',
                strike_count: 0,
                blocked_until: 0,
                last_reason: null
            });
        }

        if (control.mode === 'HUMAN_TAKEOVER') {
            if (control.paused_until > now) {
                return { allowed: false, silent: true, reason: 'HUMAN_TAKEOVER', lang, langConfident: confident };
            }
            await sessionService.setAgentControl(phone, { mode: 'BOT', paused_until: 0 });
        }

        if (control.mode === 'RATE_LIMITED') {
            if (control.paused_until > now) {
                return { allowed: false, silent: true, reason: 'RATE_LIMITED', lang, langConfident: confident };
            }
            await sessionService.setAgentControl(phone, { mode: 'BOT', paused_until: 0, last_reason: null });
        }

        if (!this._checkRateLimit(phone, now)) {
            const pauseUntil = now + 15 * 60 * 1000;
            await sessionService.setAgentControl(phone, {
                mode: 'RATE_LIMITED',
                paused_until: pauseUntil,
                last_reason: 'FLOOD'
            });
            await sessionService.logSecurityEvent(phone, 'FLOOD', control.strike_count || 0, text, pauseUntil);
            telegramAlert.send('FLOOD DETECTADO', `Número ${phone} pausado por 15 min devido a excesso de mensagens.`);
            return {
                allowed: false,
                silent: false,
                reason: 'RATE_LIMITED',
                lang,
                langConfident: confident,
                reply: msgs.getLocalized(lang, 'RATE_LIMIT')
            };
        }

        if (payload.mediaType === 'sticker') {
            return { allowed: false, silent: true, reason: 'STICKER', lang, langConfident: confident };
        }

        if (payload.mediaType === 'unsupported') {
            return {
                allowed: false,
                silent: false,
                reason: 'UNSUPPORTED_MEDIA',
                lang,
                langConfident: confident,
                reply: msgs.getLocalized(lang, 'UNSUPPORTED_MEDIA')
            };
        }

        if (payload.mediaType === 'audio') {
            const duration = Number(payload.mediaInfo?.seconds || 0);
            if (duration > MAX_AUDIO_SECONDS) {
                return {
                    allowed: false,
                    silent: false,
                    reason: 'AUDIO_TOO_LONG',
                    lang,
                    langConfident: confident,
                    reply: msgs.getLocalized(lang, 'AUDIO_TOO_LONG')
                };
            }
        }

        if (!this.isTextWithinLimit(text)) {
            return {
                allowed: false,
                silent: false,
                reason: 'TEXT_TOO_LONG',
                lang,
                langConfident: confident,
                reply: msgs.getLocalized(lang, 'TEXT_TOO_LONG')
            };
        }

        if (this.isPromptInjectionOrAbuse(text)) {
            const strikeResult = await this.registerStrike(
                phone,
                'PROMPT_INJECTION_OR_ABUSE',
                text,
                lang,
                sessionService
            );
            return {
                allowed: false,
                silent: false,
                reason: 'STRIKE',
                lang,
                langConfident: confident,
                reply: strikeResult.reply,
                strikeResult
            };
        }

        return { allowed: true, lang, langConfident: confident };
    }

    async registerStrike(phone, reason, rawExcerpt, lang = 'es', sessionService = defaultSessionService) {
        const updated = await sessionService.incrementStrike(phone, reason, BLOCK_DURATION_MS);
        const strikeCount = updated?.strike_count || 1;
        const blockedUntil = updated?.blocked_until || 0;
        const isBlocked = strikeCount >= 3 || updated?.mode === 'BLOCKED';

        await sessionService.logSecurityEvent(phone, reason, strikeCount, rawExcerpt, blockedUntil);

        if (isBlocked) {
            telegramAlert.send(
                'USUARIO BLOQUEADO',
                `Número: ${phone}\nMotivo: ${reason}\nStrikes: ${strikeCount}\nTrecho: "${String(rawExcerpt || '').slice(0, 120)}"`
            );

            return {
                blocked: true,
                strikeCount,
                blockedUntil,
                reply: msgs.getLocalized(lang, 'STRIKE_3_BLOCKED')
            };
        }

        const reply = strikeCount === 1
            ? msgs.getLocalized(lang, 'STRIKE_1')
            : msgs.getLocalized(lang, 'STRIKE_2');

        return {
            blocked: false,
            strikeCount,
            blockedUntil: 0,
            reply
        };
    }

    async activateHumanTakeover(phone, sessionService = defaultSessionService, durationMs = HUMAN_TAKEOVER_MS) {
        const current = await sessionService.getAgentControl(phone);
        if (this._isActivelyBlocked(current, Date.now())) {
            return current.blocked_until;
        }
        const pausedUntil = Date.now() + durationMs;
        await sessionService.setAgentControl(phone, {
            mode: 'HUMAN_TAKEOVER',
            paused_until: pausedUntil,
            last_reason: 'HUMAN_REPLY'
        });
        return pausedUntil;
    }

    async releaseHumanTakeover(phone, sessionService = defaultSessionService) {
        const current = await sessionService.getAgentControl(phone);
        if (this._isActivelyBlocked(current, Date.now())) {
            return false;
        }
        await sessionService.setAgentControl(phone, {
            mode: 'BOT',
            paused_until: 0,
            last_reason: null
        });
        return true;
    }

    async unblockUser(phone, sessionService = defaultSessionService) {
        await sessionService.setAgentControl(phone, {
            mode: 'BOT',
            strike_count: 0,
            blocked_until: 0,
            paused_until: 0,
            last_reason: null
        });
    }
}

module.exports = new GuardrailService();
