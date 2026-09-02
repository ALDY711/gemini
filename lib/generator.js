const fs = require('fs');
const path = require('path');
const { GrizzlySMS, RefundWorker } = require('./grizzly');
const { normalizePhone, jioCheckSubscriber, createSession, jioSendOtp, jioValidateOtp, huntLink } = require('./jio-api');

const LINKS_FILE = path.join(__dirname, '../data/links.json');
const DATA_DIR = path.dirname(LINKS_FILE);

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure links file exists
if (!fs.existsSync(LINKS_FILE)) {
    fs.writeFileSync(LINKS_FILE, JSON.stringify([]));
}

function saveLink(linkObj) {
    let links = [];
    try {
        links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    } catch(e) {}
    links.push(linkObj);
    fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}

async function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollOtp(provider, act_id, timeout = 120, interval = 5, log = () => {}) {
    const deadline = Date.now() + (timeout * 1000);
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 5;

    while (Date.now() < deadline) {
        try {
            const res = await provider.status(act_id);
            const state = res.state;
            const code = res.code;
            consecutiveErrors = 0; // reset on success

            if (state === 'OK' && code) return code;
            if (state === 'CANCEL') throw new Error('activation cancelled upstream');
        } catch (e) {
            // Jika error adalah cancel upstream, lempar langsung
            if (e.message === 'activation cancelled upstream') throw e;
            
            consecutiveErrors++;
            log(`[OTP Poll] Error dari Grizzly (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${e.message}`);
            
            // Hanya menyerah jika sudah terlalu banyak error berturut-turut
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                throw new Error(`OTP polling gagal setelah ${MAX_CONSECUTIVE_ERRORS} error berturut-turut: ${e.message}`);
            }
        }
        await _delay(interval * 1000);
    }
    throw new Error(`OTP timeout setelah ${timeout}s`);
}

class GeminiGenerator {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.running = false;
        this.stopFlag = false;
        this.provider = new GrizzlySMS(apiKey);
        this.refunds = new RefundWorker(this.provider, (msg) => this._log(`[Refund] ${msg}`));
        this.state = {
            phase: 'IDLE',
            phone: '',
            error: '',
            attempts: 0
        };
        this.config = {
            max_price: 0.208,
            otp_fail_delay: 15,
            cancel_delay: 60
        };
        this.logs = [];
        this._log("Generator initialized.");
    }

    _log(msg) {
        const time = new Date().toLocaleTimeString();
        const line = `[${time}] ${msg}`;
        console.log(line);
        this.logs.unshift(line);
        if (this.logs.length > 50) this.logs.pop(); // keep last 50
    }

    getLogs() {
        return this.logs;
    }

    getStatus() {
        return {
            running: this.running,
            phase: this.state.phase,
            phone: this.state.phone,
            error: this.state.error,
            attempts: this.state.attempts
        };
    }

    getLinks() {
        try {
            return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
        } catch(e) {
            return [];
        }
    }

    start() {
        if (this.running) return { status: 'already running' };
        if (!this.apiKey) return { status: 'error', message: 'API Key not set' };
        
        this.running = true;
        this.stopFlag = false;
        this.state.attempts = 0;
        this._loop(); // run in background
        return { status: 'started' };
    }

    stop() {
        if (!this.running) return { status: 'not running' };
        this.stopFlag = true;
        return { status: 'stopping' };
    }

    async _loop() {
        while (!this.stopFlag) {
            this.state.attempts++;
            try {
                await this._huntOnce();
            } catch (err) {
                this._log(`[Fatal Loop Error] ${err.message}`);
            }
            if (!this.stopFlag) await _delay(3000);
        }
        this.running = false;
        this._log("Generator stopped.");
    }

    async _huntOnce() {
        this.state.phase = 'RENTING';
        this.state.phone = '';
        this.state.error = '';
        let act_id = '';

        try {
            // 1. Rent
            let rentResult;
            try {
                rentResult = await this.provider.rent(this.config.max_price);
            } catch (rentErr) {
                this.state.phase = 'ERROR';
                this.state.error = rentErr.message || 'Gagal mendapat nomor';
                this._log(`[Rent Error] ${this.state.error}`);
                return;
            }
            
            act_id = rentResult.act_id;
            this.state.phone = normalizePhone(rentResult.phone);
            this._log(`[Worker] Got number: ${this.state.phone}`);

            // 2. Check
            this.state.phase = 'CHECKING';
            const isSubscriber = await jioCheckSubscriber(this.state.phone);
            if (!isSubscriber) {
                this.state.phase = 'ERROR';
                this.state.error = 'Bukan pelanggan Jio';
                this._log(`[Check] ${this.state.phone} - Bukan pelanggan Jio`);
                this.refunds.schedule(act_id, 0, true);
                return;
            }

            // 3. Send OTP
            this.state.phase = 'SENDING_OTP';
            this._log(`[OTP] Sending OTP to ${this.state.phone}...`);
            const session = createSession();
            const sent = await jioSendOtp(session, this.state.phone);
            if (!sent) {
                this.state.phase = 'ERROR';
                this.state.error = 'OTP gagal dikirim';
                this._log(`[OTP Error] Gagal mengirim OTP ke ${this.state.phone}`);
                this.refunds.schedule(act_id, this.config.otp_fail_delay);
                return;
            }

            await this.provider.ready(act_id);

            // 4. Wait OTP
            this.state.phase = 'WAITING_OTP';
            this._log(`[OTP] Waiting for OTP code...`);
            const otp = await pollOtp(this.provider, act_id, 45, 5, (msg) => this._log(msg));

            // 5. Validate OTP
            this.state.phase = 'VALIDATING';
            const valid = await jioValidateOtp(session, otp);
            if (!valid) {
                this.state.phase = 'ERROR';
                this.state.error = 'OTP invalid';
                this.refunds.schedule(act_id, this.config.cancel_delay);
                return;
            }

            // 6. Hunt
            this.state.phase = 'HUNTING';
            const link = await huntLink(session);

            if (link) {
                if (link.toLowerCase().includes('google')) {
                    await this.provider.complete(act_id);
                    this.state.phase = 'DONE';
                    this._log(`🎉 LINK PREMIUM DITEMUKAN: ${link}`);
                    saveLink({
                        phone: this.state.phone,
                        link: link,
                        date: new Date().toISOString()
                    });
                } else {
                    await this.provider.cancel(act_id);
                    this.state.phase = 'ERROR';
                    this.state.error = 'Bukan promo Google';
                }
            } else {
                await this.provider.cancel(act_id);
                this.state.phase = 'ERROR';
                this.state.error = 'Tidak ada promo aktif';
            }

        } catch (e) {
            this.state.phase = 'ERROR';
            this.state.error = e.message;
            this._log(`[Error] ${e.message}`);
            if (act_id) {
                this.refunds.schedule(act_id, this.config.cancel_delay);
            }
        }
    }
}

module.exports = { GeminiGenerator };
