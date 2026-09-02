const axios = require('axios');
const https = require('https');

let cachedGrizzlyIp = null;
let customHttpsAgent = null;

async function getGrizzlyAgent() {
    if (customHttpsAgent) return customHttpsAgent;
    
    // Resolve via DoH to bypass ISP DNS block (Internet Positif)
    try {
        const res = await axios.get('https://cloudflare-dns.com/dns-query?name=api.grizzlysms.com&type=A', {
            headers: { 'accept': 'application/dns-json' },
            timeout: 5000
        });
        if (res.data && res.data.Answer && res.data.Answer.length > 0) {
            cachedGrizzlyIp = res.data.Answer[0].data;
        }
    } catch (e) {
        // Fallback to known Cloudflare anycast IP for grizzlysms
        cachedGrizzlyIp = '104.26.8.234'; 
    }

    if (!cachedGrizzlyIp) cachedGrizzlyIp = '104.26.8.234';

    customHttpsAgent = new https.Agent({
        lookup: (hostname, options, callback) => {
            if (hostname === 'api.grizzlysms.com') {
                if (options.all) {
                    callback(null, [{ address: cachedGrizzlyIp, family: 4 }]);
                } else {
                    callback(null, cachedGrizzlyIp, 4);
                }
            } else {
                const dns = require('dns');
                dns.lookup(hostname, options, callback);
            }
        }
    });

    return customHttpsAgent;
}

class GrizzlyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GrizzlyError';
    }
}

class GrizzlySMS {
    constructor(apiKey) {
        this.key = apiKey;
        this.base = 'https://api.grizzlysms.com/stubs/handler_api.php';
        this.lastCall = 0;
        this.minGap = 1200; // 1.2 seconds in ms
    }

    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async _get(params, retries = 2) {
        const queryParams = { api_key: this.key, ...params };
        const agent = await getGrizzlyAgent();
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            const now = Date.now();
            const wait = this.minGap - (now - this.lastCall);
            if (wait > 0) {
                await this._delay(wait);
            }
            this.lastCall = Date.now();

            try {
                const res = await axios.get(this.base, { 
                    params: queryParams, 
                    timeout: 8000,
                    httpsAgent: agent
                });
                return typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data);
            } catch (e) {
                if (e.response && e.response.status === 429) {
                    await this._delay(attempt * 2000);
                    continue;
                }
                if (attempt === retries) {
                    throw e;
                }
                await this._delay(2000);
            }
        }
        throw new GrizzlyError("GrizzlySMS request failed after retries.");
    }

    async balance() {
        const out = await this._get({ action: 'getBalance' });
        if (out.startsWith('ACCESS_BALANCE:')) {
            return parseFloat(out.split(':')[1]);
        }
        throw new GrizzlyError(`balance error: ${out}`);
    }

    async getPrices(country = 22, service = 'jio') {
        const out = await this._get({ action: 'getPrices', service: service, country: country });
        try {
            return JSON.parse(out);
        } catch (e) {
            throw new GrizzlyError(`Failed to parse getPrices: ${out}`);
        }
    }

    async rent(maxPrice = null) {
        const p = { action: 'getNumber', service: 'jio', country: 22 };
        if (maxPrice !== null) p.maxPrice = maxPrice;
        
        const out = await this._get(p);
        
        if (out.startsWith('ACCESS_NUMBER:')) {
            const parts = out.split(':');
            return { act_id: parts[1], phone: parts[2] };
        }
        
        // Error handling sesuai dokumentasi Grizzly SMS
        if (out === 'NO_NUMBERS') throw new GrizzlyError('NO_NUMBERS');
        if (out === 'NO_BALANCE') throw new GrizzlyError('NO_BALANCE');
        if (out === 'BAD_KEY') throw new GrizzlyError('BAD_KEY');
        if (out === 'SERVICE_UNAVAILABLE_REGION') throw new GrizzlyError('SERVICE_UNAVAILABLE_REGION');
        
        throw new GrizzlyError(out);
    }

    async status(act_id) {
        const out = await this._get({ action: 'getStatus', id: act_id });
        if (out === 'STATUS_WAIT_CODE') return { state: 'WAIT', code: null };
        if (out.startsWith('STATUS_OK:')) return { state: 'OK', code: out.split(':')[1] };
        if (out === 'STATUS_CANCEL') return { state: 'CANCEL', code: null };
        throw new GrizzlyError(`status error: ${out}`);
    }

    async ready(act_id) {
        const out = await this._get({ action: 'setStatus', id: act_id, status: 1 });
        if (out !== 'ACCESS_READY') {
            // Optional: Handle non-ready responses
        }
    }

    async complete(act_id) {
        await this._get({ action: 'setStatus', id: act_id, status: 6 });
    }

    async cancel(act_id) {
        const out = await this._get({ action: 'setStatus', id: act_id, status: 8 });
        if (out !== 'ACCESS_CANCEL') {
            throw new GrizzlyError(`cancel error: ${out}`);
        }
    }
}

// Refund Worker logic
const AGGRESSIVE_INTERVAL = 30; // seconds

class RefundWorker {
    constructor(sms, log = () => {}) {
        this.sms = sms;
        this.log = log;
        this.queue = [];
        this.pending = 0;
        this.timer = setInterval(() => this._loop(), 2000);
    }

    schedule(act_id, delay, aggressive = false) {
        this.pending++;
        this.queue.push({ act_id, fire_at: Date.now() + (delay * 1000), aggressive });
        const mode = aggressive ? 'aggressive' : 'normal';
        this.log(`refund #${act_id.slice(-8)} dijadwalkan (${mode}, ${Math.floor(delay)}s)`);
    }

    async _loop() {
        const now = Date.now();
        const batch = [...this.queue];
        this.queue = [];
        const remaining = [];

        for (const item of batch) {
            const { act_id, fire_at, aggressive } = item;
            if (now >= fire_at) {
                try {
                    await this.sms.cancel(act_id);
                    this.log(`refund #${act_id.slice(-8)} berhasil ✓`);
                    this.pending--;
                } catch (e) {
                    const err = e.message;
                    if (err.includes('BAD_ACTION') || err.includes('NO_ACTIVATION') || err.includes('BAD_STATUS')) {
                        this.log(`refund #${act_id.slice(-8)} diabaikan (permanen): ${err}`);
                        this.pending--;
                    } else {
                        const retryDelay = aggressive ? AGGRESSIVE_INTERVAL : 10;
                        this.log(`refund #${act_id.slice(-8)} gagal: ${err} - retry ${retryDelay}s`);
                        remaining.push({ act_id, fire_at: Date.now() + (retryDelay * 1000), aggressive });
                    }
                }
            } else {
                remaining.push(item);
            }
        }
        this.queue = [...this.queue, ...remaining];
    }

    async waitAll() {
        while (this.pending > 0) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    stop() {
        clearInterval(this.timer);
    }
}

module.exports = { GrizzlySMS, GrizzlyError, RefundWorker };
