const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const JIO_SEND_OTP = "https://www.jio.com/api/jio-login-service/login/sendOtp";
const JIO_VALIDATE_OTP = "https://www.jio.com/api/jio-login-service/login/validateOtp";
const JIO_CHECK = "https://www.jio.com/api/jio-recharge-service/recharge/mobility/number/";

const JIO_HUNT_ENDPOINTS = [
    ["GET", "https://www.jio.com/api/jio-ott-service/ott/subscription/google-ai"],
    ["POST", "https://www.jio.com/api/jio-ott-service/ott/subscription/google-ai"],
    ["GET", "https://www.jio.com/api/jio-ott-service/ott/subscription/google-lead"],
    ["GET", "https://www.jio.com/api/jio-ott-service/ott/subscription/submit"],
    ["POST", "https://www.jio.com/api/jio-ott-service/ott/subscription/submit"],
    ["GET", "https://www.jio.com/api/jio-ott-service/ott/subscription/activate/googleai"],
    ["POST", "https://www.jio.com/api/jio-ott-service/ott/subscription/activate/googleai"],
];

const RECHARGE_PAGES = [
    "https://tiny.jio.com/loginrecharge",
    "https://tiny.jio.com/loginirecharge",
];

const LINK_MARKERS = [
    "serviceactivation.google.com",
    "one.google.com/activate-plan",
    "one.google.com/promo",
    "one.google.com/offers",
    "partnerPromotionToken",
];

const ASSET_EXTS = [".webp", ".png", ".jpg", ".jpeg", ".svg", ".css", ".js"];

function normalizePhone(raw) {
    const digits = String(raw).replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
}

async function jioCheckSubscriber(phone) {
    try {
        const res = await axios.get(`${JIO_CHECK}${phone}`, {
            headers: {
                "User-Agent": UA,
                "Accept": "application/json",
                "Referer": "https://www.jio.com/",
            },
            timeout: 10000,
        });
        return res.status === 200;
    } catch (e) {
        return false;
    }
}

function createSession() {
    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar }));
    client.defaults.headers.common['User-Agent'] = UA;
    client.defaults.headers.common['Accept'] = "application/json, text/plain, */*";
    client.defaults.headers.common['Accept-Language'] = "en-US,en;q=0.9";
    client.defaults.headers.common['Origin'] = "https://www.jio.com";
    return client;
}

async function jioSendOtp(client, phone) {
    try {
        const res = await client.post(JIO_SEND_OTP, {
            mobileNumber: phone,
            loginFlowType: "MOBILE",
            alternateNumber: "",
        }, {
            headers: { "Referer": "https://www.jio.com/selfcare/login/" },
            timeout: 10000
        });
        return res.status === 200;
    } catch (e) {
        return false;
    }
}

async function jioValidateOtp(client, otp) {
    try {
        const res = await client.post(JIO_VALIDATE_OTP, { otp }, {
            headers: { "Referer": "https://www.jio.com/selfcare/login/" },
            timeout: 10000
        });
        return res.status === 200;
    } catch (e) {
        return false;
    }
}

function findGoogleLinks(text) {
    if (!text) return [];
    const urlRegex = /https?:\/\/[^\s"'<>]+/g;
    const matches = typeof text === 'string' ? text.match(urlRegex) || [] : [];
    const seen = new Set();
    const links = [];

    for (let u of matches) {
        u = u.replace(/['"\\]+$/, '');
        const low = u.toLowerCase();
        const isAsset = ASSET_EXTS.some(ext => low.endsWith(ext));
        if (isAsset || low.includes("myjiostatic.cdn.jio.com")) continue;

        const hasMarker = LINK_MARKERS.some(marker => u.includes(marker));
        if (hasMarker && !seen.has(u)) {
            seen.add(u);
            links.push(u);
        }
    }
    return links;
}

async function huntLink(client) {
    const hdr = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://www.jio.com",
        "Referer": "https://www.jio.com/selfcare/googleai/",
    };

    // 1) subscription endpoints
    for (const [method, url] of JIO_HUNT_ENDPOINTS) {
        try {
            const res = await client({
                method,
                url,
                headers: hdr,
                data: method === 'POST' ? {} : undefined,
                timeout: 15000,
            });

            if (res.status !== 200) continue;

            const textData = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
            let direct = findGoogleLinks(textData);
            if (direct.length > 0) return direct[0];

            // JSON key scan
            try {
                const data = res.data;
                const keys = ["redirectionURL", "redirectUrl", "url"];
                for (const key of keys) {
                    let v = data[key] || (data.data && typeof data.data === 'object' ? data.data[key] : null);
                    if (typeof v === 'string' && LINK_MARKERS.some(m => v.includes(m))) {
                        return v;
                    }
                }
                // Fallback: scan seluruh JSON blob sebagai string
                const blobLinks = findGoogleLinks(JSON.stringify(data));
                if (blobLinks.length > 0) return blobLinks[0];
            } catch (e) {}
        } catch (e) {
            continue;
        }
    }

    // 2) fallback: recharge pages
    for (const page of RECHARGE_PAGES) {
        try {
            const res = await client.get(page, { timeout: 15000 });
            if (res.status === 200) {
                const textData = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                const found = findGoogleLinks(textData);
                if (found.length > 0) return found[0];
            }
        } catch (e) {
            continue;
        }
    }

    return null;
}

module.exports = {
    normalizePhone,
    jioCheckSubscriber,
    createSession,
    jioSendOtp,
    jioValidateOtp,
    huntLink
};
