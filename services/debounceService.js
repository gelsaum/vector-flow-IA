class DebounceService {
    constructor() {
        this.buffers = new Map();
        this.phoneLocks = new Map();
    }

    getDelayMs() {
        const val = Number(process.env.DEBOUNCE_MS);
        return Number.isFinite(val) && val >= 0 ? val : 3500;
    }

    runExclusive(phone, fn) {
        const previous = this.phoneLocks.get(phone) || Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(() => fn());

        const cleanup = next.finally(() => {
            if (this.phoneLocks.get(phone) === cleanup) {
                this.phoneLocks.delete(phone);
            }
        });
        this.phoneLocks.set(phone, cleanup);
        return next;
    }

    enqueue(phone, item, onFlush) {
        const delayMs = this.getDelayMs();

        if (!this.buffers.has(phone)) {
            this.buffers.set(phone, {
                texts: [],
                images: [],
                audioTexts: [],
                meta: {},
                timer: null,
                resolvers: []
            });
        }

        const bucket = this.buffers.get(phone);
        if (item.text) bucket.texts.push(item.text);
        if (item.audioText) bucket.audioTexts.push(item.audioText);
        if (item.image) bucket.images.push(item.image);
        bucket.meta = { ...bucket.meta, ...(item.meta || {}) };

        if (bucket.timer) {
            clearTimeout(bucket.timer);
        }

        return new Promise((resolve, reject) => {
            bucket.resolvers.push({ resolve, reject });
            bucket.timer = setTimeout(() => {
                this.buffers.delete(phone);
                const mergedTexts = [...bucket.texts, ...bucket.audioTexts].filter(Boolean);
                const payload = {
                    phone,
                    combinedText: mergedTexts.join('\n'),
                    images: bucket.images,
                    hasAudio: bucket.audioTexts.length > 0,
                    meta: bucket.meta
                };

                this.runExclusive(phone, () => onFlush(payload))
                    .then((result) => {
                        for (const r of bucket.resolvers) r.resolve(result);
                    })
                    .catch((err) => {
                        for (const r of bucket.resolvers) r.reject(err);
                    });
            }, delayMs);

            if (typeof bucket.timer.unref === 'function') {
                bucket.timer.unref();
            }
        });
    }

    clearAll() {
        for (const bucket of this.buffers.values()) {
            if (bucket.timer) clearTimeout(bucket.timer);
            for (const r of bucket.resolvers) {
                r.resolve(null);
            }
        }
        this.buffers.clear();
        this.phoneLocks.clear();
    }
}

module.exports = new DebounceService();
