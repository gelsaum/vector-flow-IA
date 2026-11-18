const apiService = require('./apiService');
const sessionService = require('./sessionService');
const whatsappService = require('./whatsappService');
const msgs = require('../constants/messages');
const { format, parse, isValid } = require('date-fns');
const { getAsuncionDateTimeParts, normalizePhoneString } = require('./phoneUtils');

class ReminderService {
    constructor() {
        this.activeTimers = new Map();
        this.REMINDER_MINUTES = 20;
        this.SYNC_INTERVAL_MS = 15 * 60 * 1000;
        this._syncInterval = null;
        this._bootTimer = null;
    }

    async init() {
        console.log('[ReminderService] Inicializando...');

        const reminders = await sessionService.getReminders();
        const now = Date.now();

        for (const r of reminders) {
            if (r.target_time > now) {
                this.setTimer(r.id_agendamento, r.phone, r.target_time, r.hora_inicio, r.profesional_nombre);
            } else {
                await sessionService.deleteReminder(r.id_agendamento);
            }
        }

        console.log(`[ReminderService] Restabelecidos ${this.activeTimers.size} alarmes salvos.`);

        this._syncInterval = setInterval(() => this.syncAppointments(), this.SYNC_INTERVAL_MS);
        if (typeof this._syncInterval.unref === 'function') this._syncInterval.unref();

        this._bootTimer = setTimeout(() => this.syncAppointments(), 5000);
        if (typeof this._bootTimer.unref === 'function') this._bootTimer.unref();
    }

    cancelTimer(cita_id) {
        const key = String(cita_id);
        if (this.activeTimers.has(key)) {
            clearTimeout(this.activeTimers.get(key));
            this.activeTimers.delete(key);
        }
    }

    _toAsuncionEpochMs(fechaStr, horaInicioStr) {
        // America/Asuncion (-03:00 ou -04:00 dependendo da estação, usando offset real via Intl)
        const baseLocal = parse(`${fechaStr} ${horaInicioStr}`, 'yyyy-MM-dd HH:mm:ss', new Date());
        if (!isValid(baseLocal)) return NaN;

        try {
            const targetParts = getAsuncionDateTimeParts(baseLocal);
            const targetInAsuncion = parse(`${targetParts.dateStr} ${targetParts.timeStr}`, 'yyyy-MM-dd HH:mm:ss', new Date());
            const offsetDiff = baseLocal.getTime() - targetInAsuncion.getTime();
            return baseLocal.getTime() + offsetDiff;
        } catch {
            return baseLocal.getTime();
        }
    }

    async scheduleReminder(cita_id, phone, fechaStr, horaInicioStr, profesional_nombre) {
        try {
            const canonicalPhone = normalizePhoneString(phone);
            if (!canonicalPhone) return;

            const appointmentMs = this._toAsuncionEpochMs(fechaStr, horaInicioStr);
            if (!Number.isFinite(appointmentMs)) return;

            const targetTime = appointmentMs - (this.REMINDER_MINUTES * 60 * 1000);

            if (targetTime > Date.now()) {
                await sessionService.addReminder(
                    cita_id,
                    canonicalPhone,
                    targetTime,
                    horaInicioStr.substring(0, 5),
                    profesional_nombre,
                    fechaStr
                );
                this.setTimer(cita_id, canonicalPhone, targetTime, horaInicioStr.substring(0, 5), profesional_nombre);
                console.log(`[ReminderService] Lembrete agendado para cita ${cita_id} às ${format(new Date(targetTime), 'HH:mm:ss')}`);
            }
        } catch (error) {
            console.error('[ReminderService] Erro ao agendar lembrete:', error);
        }
    }

    setTimer(cita_id, phone, targetTime, hora_inicio, profesional_nombre) {
        const key = String(cita_id);
        this.cancelTimer(key);

        const delay = Math.max(0, targetTime - Date.now());
        const timer = setTimeout(() => {
            this.triggerReminder(key, phone, hora_inicio, profesional_nombre);
        }, delay);
        if (typeof timer.unref === 'function') timer.unref();

        this.activeTimers.set(key, timer);
    }

    async triggerReminder(cita_id, phone, hora_inicio, profesional_nombre) {
        console.log(`[ReminderService] Disparando lembrete para cita ${cita_id}...`);
        const key = String(cita_id);
        this.activeTimers.delete(key);

        const canonicalPhone = normalizePhoneString(phone);
        try {
            const { dateStr: todayStr } = getAsuncionDateTimeParts();
            const citasHoje = await apiService.getReporteDiario(todayStr);

            const citaAtiva = citasHoje.find((c) => String(c.cita_id) === key && c.estado !== 'cancelada');

            if (citaAtiva) {
                const session = await sessionService.getSession(canonicalPhone);
                const customer = await sessionService.getCustomer(canonicalPhone);
                const lang = customer?.preferred_lang || 'es';

                session.step = 'AWAITING_REMINDER_REPLY';
                session.data = {
                    ...session.data,
                    cancelCitaId: cita_id,
                    cancelFecha: citaAtiva.fecha || todayStr
                };

                await sessionService.saveSession(canonicalPhone, session);

                const msg = msgs.getLocalized(lang, 'REMINDER_MSG', this.REMINDER_MINUTES, hora_inicio, profesional_nombre);
                await whatsappService.sendText(canonicalPhone, msg);
            } else {
                console.log(`[ReminderService] Cita ${cita_id} não encontrada ou cancelada. Abortando lembrete.`);
            }
        } catch (error) {
            console.error('[ReminderService] Erro ao disparar lembrete:', error);
        } finally {
            await sessionService.deleteReminder(key);
        }
    }

    async syncAppointments() {
        const asuncionNow = getAsuncionDateTimeParts();
        if (asuncionNow.hour < 6 || asuncionNow.hour >= 20) {
            console.log('[ReminderService] Fora do horário comercial (America/Asuncion). Sincronização pulada.');
            return;
        }

        console.log('[ReminderService] Iniciando sincronização de agendamentos do dia...');
        try {
            const todayStr = asuncionNow.dateStr;
            const citasHoje = await apiService.getReporteDiario(todayStr);
            const nowMs = Date.now();

            let addedCount = 0;
            for (const cita of citasHoje) {
                if (cita.estado === 'cancelada') continue;

                const citaIdStr = String(cita.cita_id);
                if (!this.activeTimers.has(citaIdStr)) {
                    const citaFecha = cita.fecha || todayStr;
                    const appointmentMs = this._toAsuncionEpochMs(citaFecha, cita.hora_inicio);

                    if (Number.isFinite(appointmentMs) && appointmentMs > nowMs) {
                        const phone = normalizePhoneString(cita.cliente?.telefono);
                        if (!phone) continue;

                        await this.scheduleReminder(
                            cita.cita_id,
                            phone,
                            citaFecha,
                            cita.hora_inicio,
                            cita.profesional?.nombre || 'Profissional'
                        );
                        addedCount++;
                    }
                }
            }
            if (addedCount > 0) {
                console.log(`[ReminderService] Sincronização concluída: ${addedCount} novos lembretes agendados.`);
            }
        } catch (error) {
            console.error('[ReminderService] Erro na sincronização:', error.message);
        }
    }
}

module.exports = new ReminderService();
