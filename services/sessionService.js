const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

class SessionService {
    constructor() {
        this.db = null;
        this.initPromise = null;
        this._cleanupInterval = null;
    }

    async init(customDbPath = null) {
        if (this.initPromise && !customDbPath) return this.initPromise;

        this.initPromise = (async () => {
            try {
                const dbPath = customDbPath || process.env.DATABASE_PATH || path.join(__dirname, '..', 'sessions.sqlite');
                this.db = await open({
                    filename: dbPath,
                    driver: sqlite3.Database
                });

                // Configurações avançadas de alta disponibilidade para SQLite em Node.js
                await this.db.exec('PRAGMA journal_mode = WAL;');
                await this.db.exec('PRAGMA synchronous = NORMAL;');
                await this.db.exec('PRAGMA busy_timeout = 5000;');

                await this.db.exec(`
                    CREATE TABLE IF NOT EXISTS UserSessions (
                        phone TEXT PRIMARY KEY,
                        step TEXT,
                        data TEXT,
                        lastActivity INTEGER
                    );

                    CREATE TABLE IF NOT EXISTS Reminders (
                        id_agendamento TEXT PRIMARY KEY,
                        phone TEXT,
                        target_time INTEGER,
                        hora_inicio TEXT,
                        profesional_nombre TEXT,
                        data TEXT
                    );

                    CREATE TABLE IF NOT EXISTS Customers (
                        phone TEXT PRIMARY KEY,
                        full_name TEXT,
                        preferred_lang TEXT DEFAULT 'es',
                        preferred_pro_id INTEGER,
                        preferred_service_id INTEGER,
                        notes TEXT,
                        total_appointments INTEGER DEFAULT 0,
                        created_at INTEGER,
                        updated_at INTEGER
                    );

                    CREATE TABLE IF NOT EXISTS ConversationHistory (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        phone TEXT NOT NULL,
                        role TEXT NOT NULL,
                        content TEXT NOT NULL,
                        media_type TEXT DEFAULT 'text',
                        created_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_history_phone_time
                        ON ConversationHistory(phone, created_at);

                    CREATE TABLE IF NOT EXISTS AgentControl (
                        phone TEXT PRIMARY KEY,
                        mode TEXT DEFAULT 'BOT',
                        strike_count INTEGER DEFAULT 0,
                        paused_until INTEGER DEFAULT 0,
                        blocked_until INTEGER DEFAULT 0,
                        last_reason TEXT,
                        updated_at INTEGER
                    );

                    CREATE TABLE IF NOT EXISTS SecurityLogs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        phone TEXT NOT NULL,
                        reason TEXT NOT NULL,
                        strike_count INTEGER NOT NULL,
                        raw_excerpt TEXT,
                        blocked_until INTEGER DEFAULT 0,
                        created_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_security_phone_time
                        ON SecurityLogs(phone, created_at);

                    CREATE TABLE IF NOT EXISTS Waitlist (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        phone TEXT NOT NULL,
                        customer_name TEXT,
                        desired_date TEXT NOT NULL,
                        desired_time TEXT,
                        profesional_id INTEGER,
                        servicio_id INTEGER,
                        lang TEXT DEFAULT 'es',
                        notified INTEGER DEFAULT 0,
                        created_at INTEGER NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_waitlist_date_notified
                        ON Waitlist(desired_date, notified);
                `);
                console.log('[SessionService] Base de dados SQLite conectada e tabelas criadas.');

                // Limpeza inicial + periódica a cada 6 horas
                await this.cleanupOldSessions();
                if (!this._cleanupInterval) {
                    this._cleanupInterval = setInterval(() => this.cleanupOldSessions(), 6 * 60 * 60 * 1000);
                    if (typeof this._cleanupInterval.unref === 'function') {
                        this._cleanupInterval.unref();
                    }
                }
            } catch (error) {
                console.error('[SessionService] Erro crítico ao conectar com SQLite:', error);
                this.initPromise = null;
                throw error;
            }
        })();

        return this.initPromise;
    }

    async close() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
        this.initPromise = null;
    }

    async cleanupOldSessions() {
        if (!this.db) return;
        const now = Date.now();
        const sessionCutoff = now - 24 * 60 * 60 * 1000;
        const historyCutoff = now - 30 * 24 * 60 * 60 * 1000;
        const logsCutoff = now - 90 * 24 * 60 * 60 * 1000;
        const waitlistCutoff = now - 7 * 24 * 60 * 60 * 1000;
        try {
            const result = await this.db.run('DELETE FROM UserSessions WHERE lastActivity < ?', sessionCutoff);
            await this.db.run('DELETE FROM ConversationHistory WHERE created_at < ?', historyCutoff);
            await this.db.run('DELETE FROM SecurityLogs WHERE created_at < ?', logsCutoff);
            await this.db.run('DELETE FROM Waitlist WHERE created_at < ? OR notified = 1', waitlistCutoff);
            if (result.changes > 0) {
                console.log(`[SessionService] 🧹 Limpeza: ${result.changes} sessão(ões) antiga(s) removida(s).`);
            }
        } catch (error) {
            console.error('[SessionService] Erro na limpeza de sessões:', error.message);
        }
    }

    async getSession(from) {
        if (!this.db) await this.init();

        const now = Date.now();
        const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos timeout

        try {
            let row = await this.db.get('SELECT * FROM UserSessions WHERE phone = ?', from);

            if (!row) {
                const defaultData = {};
                // INSERT OR IGNORE evita erros quando duas mensagens simultâneas tentam "criar" a sessão juntas
                await this.db.run(
                    'INSERT OR IGNORE INTO UserSessions (phone, step, data, lastActivity) VALUES (?, ?, ?, ?)', 
                    [from, 'START', JSON.stringify(defaultData), now]
                );
                
                return { step: 'START', data: defaultData, lastActivity: now };
            } 

            if (now - row.lastActivity > TIMEOUT_MS) {
                console.log(`[Session] Sessão de ${from} expirou por inatividade. Reiniciando...`);
                row = { step: 'START', data: '{}', lastActivity: now };
                await this.db.run(
                    'UPDATE UserSessions SET step = ?, data = ?, lastActivity = ? WHERE phone = ?',
                    [row.step, row.data, row.lastActivity, from]
                );
            } else {
                row.lastActivity = now;
                await this.db.run(
                    'UPDATE UserSessions SET lastActivity = ? WHERE phone = ?', 
                    [now, from]
                );
            }

            let parsedData = {};
            try {
                parsedData = JSON.parse(row.data);
            } catch (e) {
                console.warn(`[Session] Os dados em banco do usuário ${from} estavam corrompidos. Mantendo objeto vazio.`);
            }

            return { step: row.step, data: parsedData, lastActivity: row.lastActivity };

        } catch (error) {
            console.error(`[SessionService Error] Falha de leitura/escrita ao recuperar sessão para ${from}:`, error);
            // Retorna Fallback: mesmo com falha no banco o bot segue para responder a mensagem
            return { step: 'START', data: {}, lastActivity: now }; 
        }
    }

    async saveSession(from, sessionData) {
        const now = sessionData.lastActivity || Date.now();
        try {
            if (!this.db) await this.init();
            await this.db.run(
                `INSERT INTO UserSessions (phone, step, data, lastActivity)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(phone) DO UPDATE SET
                    step = excluded.step,
                    data = excluded.data,
                    lastActivity = excluded.lastActivity`,
                [from, sessionData.step, JSON.stringify(sessionData.data || {}), now]
            );
        } catch (error) {
            console.error(`[SessionService Error] Falha ao salvar sessão para ${from}:`, error);
        }
    }

    async resetSession(from) {
        const now = Date.now();
        try {
            if (!this.db) await this.init();
            await this.db.run(
                `INSERT INTO UserSessions (phone, step, data, lastActivity)
                 VALUES (?, 'START', '{}', ?)
                 ON CONFLICT(phone) DO UPDATE SET
                    step = 'START',
                    data = '{}',
                    lastActivity = excluded.lastActivity`,
                [from, now]
            );
        } catch (error) {
            console.error(`[SessionService Error] Falha ao resetar sessão para ${from}:`, error);
        }
    }

    // --- REMINDERS METHODS ---
    async addReminder(id_agendamento, phone, target_time, hora_inicio, profesional_nombre, dataStr) {
        if (!this.db) await this.init();
        try {
            await this.db.run(
                'INSERT OR REPLACE INTO Reminders (id_agendamento, phone, target_time, hora_inicio, profesional_nombre, data) VALUES (?, ?, ?, ?, ?, ?)',
                [String(id_agendamento), phone, target_time, hora_inicio, profesional_nombre, dataStr]
            );
        } catch (error) {
            console.error('[SessionService Error] Falha ao salvar reminder:', error);
        }
    }

    async getReminders() {
        if (!this.db) await this.init();
        try {
            return await this.db.all('SELECT * FROM Reminders');
        } catch (error) {
            console.error('[SessionService Error] Falha ao listar reminders:', error);
            return [];
        }
    }

    async deleteReminder(id_agendamento) {
        if (!this.db) await this.init();
        try {
            await this.db.run('DELETE FROM Reminders WHERE id_agendamento = ?', [String(id_agendamento)]);
        } catch (error) {
            console.error('[SessionService Error] Falha ao deletar reminder:', error);
        }
    }

    // --- CUSTOMERS METHODS ---
    async getCustomer(phone) {
        try {
            if (!this.db) await this.init();
            return (await this.db.get('SELECT * FROM Customers WHERE phone = ?', [phone])) || null;
        } catch (error) {
            console.error('[SessionService Error] Falha ao buscar cliente:', error);
            return null;
        }
    }

    async upsertCustomer(phone, data = {}) {
        const now = Date.now();
        try {
            if (!this.db) await this.init();
            await this.db.run(
                `INSERT INTO Customers (
                    phone, full_name, preferred_lang, preferred_pro_id,
                    preferred_service_id, notes, total_appointments, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(phone) DO UPDATE SET
                    full_name = COALESCE(excluded.full_name, Customers.full_name),
                    preferred_lang = COALESCE(?, Customers.preferred_lang),
                    preferred_pro_id = COALESCE(excluded.preferred_pro_id, Customers.preferred_pro_id),
                    preferred_service_id = COALESCE(excluded.preferred_service_id, Customers.preferred_service_id),
                    notes = COALESCE(excluded.notes, Customers.notes),
                    total_appointments = COALESCE(?, Customers.total_appointments),
                    updated_at = excluded.updated_at`,
                [
                    phone,
                    data.full_name ?? null,
                    data.preferred_lang || 'es',
                    data.preferred_pro_id ?? null,
                    data.preferred_service_id ?? null,
                    data.notes ?? null,
                    data.total_appointments ?? 0,
                    now,
                    now,
                    data.preferred_lang ?? null,
                    data.total_appointments ?? null
                ]
            );
            return await this.getCustomer(phone);
        } catch (error) {
            console.error('[SessionService Error] Falha ao atualizar cliente:', error);
            return null;
        }
    }

    // --- CONVERSATION HISTORY METHODS ---
    async addHistory(phone, role, content, mediaType = 'text') {
        const now = Date.now();
        try {
            if (!this.db) await this.init();
            await this.db.run(
                'INSERT INTO ConversationHistory (phone, role, content, media_type, created_at) VALUES (?, ?, ?, ?, ?)',
                [phone, role, String(content), mediaType, now]
            );
        } catch (error) {
            console.error('[SessionService Error] Falha ao registrar histórico:', error);
        }
    }

    async getRecentHistory(phone, limit = 12, maxAgeMs = 24 * 60 * 60 * 1000) {
        try {
            if (!this.db) await this.init();
            const cutoff = Date.now() - maxAgeMs;
            const rows = await this.db.all(
                'SELECT role, content, media_type, created_at FROM ConversationHistory WHERE phone = ? AND created_at >= ? ORDER BY id DESC LIMIT ?',
                [phone, cutoff, limit]
            );
            return rows.reverse();
        } catch (error) {
            console.error('[SessionService Error] Falha ao ler histórico:', error);
            return [];
        }
    }

    async clearHistory(phone) {
        try {
            if (!this.db) await this.init();
            await this.db.run('DELETE FROM ConversationHistory WHERE phone = ?', [phone]);
        } catch (error) {
            console.error('[SessionService Error] Falha ao limpar histórico:', error);
        }
    }

    // --- AGENT CONTROL & SECURITY METHODS ---
    async getAgentControl(phone) {
        try {
            if (!this.db) await this.init();
            const row = await this.db.get('SELECT * FROM AgentControl WHERE phone = ?', [phone]);
            return row || {
                phone,
                mode: 'BOT',
                strike_count: 0,
                paused_until: 0,
                blocked_until: 0,
                last_reason: null,
                updated_at: 0
            };
        } catch (error) {
            console.error('[SessionService Error] Falha ao buscar AgentControl:', error);
            return { phone, mode: 'BOT', strike_count: 0, paused_until: 0, blocked_until: 0 };
        }
    }

    async incrementStrike(phone, reason, blockDurationMs) {
        const now = Date.now();
        const blockAt = now + blockDurationMs;
        try {
            if (!this.db) await this.init();
            const row = await this.db.get(
                `INSERT INTO AgentControl (
                    phone, mode, strike_count, paused_until, blocked_until, last_reason, updated_at
                ) VALUES (?, 'BOT', 1, 0, 0, ?, ?)
                ON CONFLICT(phone) DO UPDATE SET
                    strike_count = AgentControl.strike_count + 1,
                    mode = CASE WHEN AgentControl.strike_count + 1 >= 3 THEN 'BLOCKED' ELSE AgentControl.mode END,
                    blocked_until = CASE
                        WHEN AgentControl.strike_count + 1 >= 3 THEN MAX(AgentControl.blocked_until, ?)
                        ELSE AgentControl.blocked_until
                    END,
                    last_reason = ?,
                    updated_at = ?
                RETURNING strike_count, mode, blocked_until`,
                [phone, reason, now, blockAt, reason, now]
            );
            return row;
        } catch (error) {
            console.error('[SessionService Error] Falha ao incrementar strike:', error);
            return { strike_count: 1, mode: 'BOT', blocked_until: 0 };
        }
    }

    async setAgentControl(phone, updates = {}) {
        const now = Date.now();
        try {
            if (!this.db) await this.init();
            const current = await this.getAgentControl(phone);
            const next = {
                mode: updates.mode !== undefined ? updates.mode : current.mode,
                strike_count: updates.strike_count !== undefined ? updates.strike_count : current.strike_count,
                paused_until: updates.paused_until !== undefined ? updates.paused_until : current.paused_until,
                blocked_until: updates.blocked_until !== undefined ? updates.blocked_until : current.blocked_until,
                last_reason: updates.last_reason !== undefined ? updates.last_reason : current.last_reason
            };
            await this.db.run(
                `INSERT OR REPLACE INTO AgentControl (
                    phone, mode, strike_count, paused_until, blocked_until, last_reason, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    phone,
                    next.mode,
                    next.strike_count,
                    next.paused_until,
                    next.blocked_until,
                    next.last_reason || null,
                    now
                ]
            );
            return { phone, ...next, updated_at: now };
        } catch (error) {
            console.error('[SessionService Error] Falha ao salvar AgentControl:', error);
            return null;
        }
    }

    async logSecurityEvent(phone, reason, strikeCount, rawExcerpt = '', blockedUntil = 0) {
        const now = Date.now();
        const safeExcerpt = String(rawExcerpt || '').slice(0, 240);
        try {
            if (!this.db) await this.init();
            await this.db.run(
                'INSERT INTO SecurityLogs (phone, reason, strike_count, raw_excerpt, blocked_until, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                [phone, reason, strikeCount, safeExcerpt, blockedUntil, now]
            );
        } catch (error) {
            console.error('[SessionService Error] Falha ao gravar SecurityLogs:', error);
        }
    }

    // --- WAITLIST METHODS ---
    async addToWaitlist(entry) {
        const now = Date.now();
        try {
            if (!this.db) await this.init();
            const existing = await this.db.get(
                'SELECT id FROM Waitlist WHERE phone = ? AND desired_date = ? AND notified = 0',
                [entry.phone, entry.desired_date]
            );
            if (existing) return existing.id;

            const countRow = await this.db.get(
                'SELECT COUNT(*) AS cnt FROM Waitlist WHERE phone = ? AND notified = 0',
                [entry.phone]
            );
            if ((countRow?.cnt || 0) >= 5) return null;

            const res = await this.db.run(
                `INSERT INTO Waitlist (
                    phone, customer_name, desired_date, desired_time, profesional_id, servicio_id, lang, notified, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
                [
                    entry.phone,
                    entry.customer_name || null,
                    entry.desired_date,
                    entry.desired_time || null,
                    entry.profesional_id || null,
                    entry.servicio_id || null,
                    entry.lang || 'es',
                    now
                ]
            );
            return res.lastID;
        } catch (error) {
            console.error('[SessionService Error] Falha ao adicionar na lista de espera:', error);
            return null;
        }
    }

    async getWaitlistForDate(dateStr) {
        try {
            if (!this.db) await this.init();
            return await this.db.all(
                'SELECT * FROM Waitlist WHERE desired_date = ? AND notified = 0 ORDER BY created_at ASC',
                [dateStr]
            );
        } catch (error) {
            console.error('[SessionService Error] Falha ao buscar lista de espera:', error);
            return [];
        }
    }

    async markWaitlistNotified(id) {
        try {
            if (!this.db) await this.init();
            await this.db.run('UPDATE Waitlist SET notified = 1 WHERE id = ?', [id]);
        } catch (error) {
            console.error('[SessionService Error] Falha ao atualizar lista de espera:', error);
        }
    }
}

module.exports = new SessionService();
