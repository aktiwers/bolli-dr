// DR's TV login: the OAuth device flow (RFC 8628). The TV shows a code, the
// user approves it on a phone at dr.dk/aktiver, and the tokens are stored on
// the TV only. It uses login-legacy.dr.dk, as login.dr.dk's certificate chain
// is not trusted by the TV.
//
// A login lasts until the user logs out: tokens are renewed well before they
// expire (at start, hourly while the app runs, and after a 401). A renewal
// that fails on the network keeps the session for the next try; only DR
// refusing the refresh token ends it.

import { errorBody, getJson, HttpError, postForm, postJson, sendRequest } from '../../core/http.js';
import { load, save } from '../../core/store.js';

var OIDC = 'https://login-legacy.dr.dk/oidc';
var API = 'https://production.dr-massive.com/api';
/** OAuth client id of DR's TV login */
var CLIENT_ID = '65c09e7c9e45093875c29879';
var SCOPE = 'openid offline_access profile email roles tracking';
var DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** DR issues catalogue tokens per device type; this is the TV type */
var DEVICE = 'hbbtv';
/** A token is renewed when half its lifetime, or at most this, is left */
var RENEW_MAX_MS = 10 * 60 * 60 * 1000;
var KEEP_ALIVE_MS = 60 * 60 * 1000;
/** RFC 8628: wait 5 s more after each slow_down */
var SLOW_DOWN_MS = 5000;

export interface DeviceCode {
    deviceCode: string;
    /** What the user types, e.g. "ABCD-EFGH" */
    userCode: string;
    /** Where they type it (dr.dk/aktiver) */
    uri: string;
    /** The same address with the code filled in (for a QR code) */
    uriComplete: string;
    expiresAt: number;
    intervalMs: number;
}

export interface Token {
    value: string;
    issued: number;
    expires: number;
    refreshable: boolean;
}

export interface Session {
    /** Renews the login itself (OIDC) */
    refreshToken: string;
    /** DR's catalogue tokens: the account, and its profile */
    account: Token | null;
    profile: Token | null;
    profileId: string;
    /** The profile's name as DR shows it ('' until known) */
    name: string;
}

/** Why waiting for the user ended without a login */
export type LoginFailure = 'expired' | 'denied' | 'cancelled' | 'failed';

interface RawDeviceCode {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
}

interface RawOidcTokens {
    access_token: string;
    id_token: string;
    refresh_token?: string;
}

/** DR's catalogue tokens as /authorization/exchange and /refresh send them */
export interface RawToken {
    Token?: string;
    TokenType?: string;
    Expires?: string;
    IsRefreshable?: boolean;
    value?: string;
    type?: string;
    expirationDate?: string;
    refreshable?: boolean;
    profileId?: string;
    ProfileId?: string;
}

var session: Session | null = load<Session>('session');
var renewing: Promise<void> | null = null;
var onEnded: (() => void) | null = null;

export function profileToken(): string | null {
    return session && session.profile ? session.profile.value : null;
}

export function accountToken(): string | null {
    return session && session.account ? session.account.value : null;
}

export function isLoggedIn(): boolean {
    return profileToken() !== null;
}

/** The login for DR's API (none when logged out) */
export function authHeaders(): { [name: string]: string } | undefined {
    return bearer(profileToken());
}

function bearer(token: string | null): { [name: string]: string } | undefined {
    return token ? { Authorization: 'Bearer ' + token } : undefined;
}

/** GET JSON with the login. After a 401 the login is renewed and the
 * request tried once more. */
export function getWithLogin<T>(url: string): Promise<T> {
    return withRenew(function () { return getJson<T>(url, 10000, authHeaders()); });
}

/** GET JSON with the account token (DR's video lookups want that one) */
export function getWithAccount<T>(url: string): Promise<T> {
    return withRenew(function () { return getJson<T>(url, 10000, bearer(accountToken())); });
}

function withRenew<T>(request: () => Promise<T>): Promise<T> {
    return request().then(null, function (e: HttpError) {
        if (e.status !== 401 || !session) {
            throw e;
        }
        return renew().then(request);
    });
}

/** PUT or DELETE with the login (renewed once after a 401, like getWithLogin) */
export function sendWithLogin(method: string, url: string): Promise<void> {
    return withRenew(function () { return sendRequest(method, url, authHeaders()); });
}

export function profileName(): string {
    return session ? session.name || '' : '';
}

/** Ask DR for the profile's name (after logging in) */
export function loadProfileName(): Promise<string> {
    var token = profileToken();
    if (!token) {
        return Promise.resolve('');
    }
    return getJson<{ name?: string }>(API + '/account/profile', 10000, bearer(token)).then(function (p) {
        if (session && p && p.name) {
            session.name = p.name;
            save('session', session);
        }
        return profileName();
    }, function () {
        return profileName();
    });
}

export function logout(): void {
    session = null;
    save('session', null);
}

/** Called when DR ends the login (refresh refused); the app shows the login again */
export function onLoginEnded(callback: () => void): void {
    onEnded = callback;
}

// ---- logging in

export function startLogin(): Promise<DeviceCode> {
    return postForm<RawDeviceCode>(OIDC + '/device/authorize', { client_id: CLIENT_ID, scope: SCOPE })
        .then(function (raw) { return toDeviceCode(raw, Date.now()); });
}

/** Poll until the user has approved the code (or it ran out, or was denied) */
export function waitForLogin(code: DeviceCode, cancelled: () => boolean): Promise<void> {
    return new Promise<void>(function (resolve, reject) {
        var interval = code.intervalMs;
        var poll = function () {
            if (cancelled()) {
                reject('cancelled' as LoginFailure);
                return;
            }
            if (Date.now() > code.expiresAt) {
                reject('expired' as LoginFailure);
                return;
            }
            postForm<RawOidcTokens>(OIDC + '/token', { grant_type: DEVICE_GRANT, device_code: code.deviceCode, client_id: CLIENT_ID })
                .then(function (oidc) {
                    return exchange(oidc, '').then(function () {
                        resolve();
                    });
                }, function (e: HttpError) {
                    var body = errorBody<{ error?: string }>(e);
                    var step = pollStep(e.status === 0 ? 'network' : (body && body.error) || '');
                    if (step === 'wait' || step === 'slower') {
                        if (step === 'slower') {
                            interval += SLOW_DOWN_MS;
                        }
                        setTimeout(poll, interval);
                    } else {
                        reject(step);
                    }
                }).then(null, function () {
                    reject('failed' as LoginFailure);
                });
        };
        setTimeout(poll, interval);
    });
}

/** What a token-endpoint error means while the code awaits approval. DR
 * answers authorization_pending while waiting, and invalid_grant for a code
 * that can no longer be used (approved with another account, used up),
 * which needs a new code. */
export function pollStep(error: string): 'wait' | 'slower' | LoginFailure {
    switch (error) {
        case 'authorization_pending':
        case 'network':
            return 'wait';
        case 'slow_down':
            return 'slower';
        case 'expired_token':
        case 'invalid_grant':
            return 'expired';
        case 'access_denied':
            return 'denied';
    }
    return 'failed';
}

export function toDeviceCode(raw: RawDeviceCode, now: number): DeviceCode {
    return {
        deviceCode: raw.device_code,
        userCode: raw.user_code,
        uri: raw.verification_uri,
        uriComplete: raw.verification_uri_complete || raw.verification_uri,
        expiresAt: now + (raw.expires_in || 600) * 1000,
        intervalMs: (raw.interval || 5) * 1000
    };
}

/** Trade the login's tokens for DR's catalogue tokens and keep them */
function exchange(oidc: RawOidcTokens, profileId: string): Promise<void> {
    var body: { [key: string]: unknown } = { accessToken: oidc.access_token, identityToken: oidc.id_token, scopes: ['Catalog'], device: DEVICE };
    if (profileId) {
        body.userProfileId = profileId;
    }
    return postJson<RawToken[] | RawToken>(API + '/authorization/exchange', body).then(function (raw) {
        var tokens = toTokens(raw, Date.now());
        var refresh = oidc.refresh_token || (session ? session.refreshToken : '');
        keep({
            refreshToken: refresh, account: tokens.account, profile: tokens.profile,
            profileId: tokens.profileId || profileId, name: session ? session.name : ''
        });
    });
}

/** DR's token list, in either field spelling (PascalCase or camelCase) */
export function toTokens(raw: RawToken[] | RawToken, now: number): { account: Token | null; profile: Token | null; profileId: string } {
    var list = raw instanceof Array ? raw : [raw];
    var out = { account: null as Token | null, profile: null as Token | null, profileId: '' };
    for (var i = 0; i < list.length; i++) {
        var r = list[i];
        var value = r.Token || r.value;
        if (!value) {
            continue;
        }
        var expires = Date.parse(r.Expires || r.expirationDate || '');
        var token: Token = {
            value: value,
            issued: now,
            expires: isNaN(expires) ? now + RENEW_MAX_MS : expires,
            refreshable: r.IsRefreshable === true || r.refreshable === true
        };
        if ((r.TokenType || r.type) === 'UserProfile') {
            out.profile = token;
            out.profileId = r.profileId || r.ProfileId || '';
        } else {
            out.account = token;
        }
    }
    return out;
}

// ---- staying logged in

/** Renew at start and every hour while the app runs */
export function keepAlive(): void {
    renewIfDue();
    setInterval(renewIfDue, KEEP_ALIVE_MS);
}

/** Renew now (e.g. after a 401); resolves when done or when renewal failed */
export function renew(): Promise<void> {
    if (!session) {
        return Promise.resolve();
    }
    if (!renewing) {
        renewing = renewNow().then(function () {
            renewing = null;
        }, function () {
            renewing = null;
        });
    }
    return renewing;
}

export function needsRenew(token: Token | null, now: number): boolean {
    if (!token) {
        return true;
    }
    var margin = Math.min(RENEW_MAX_MS, (token.expires - token.issued) / 2);
    return token.expires - now < margin;
}

function renewIfDue(): void {
    if (session && (needsRenew(session.profile, Date.now()) || needsRenew(session.account, Date.now()))) {
        renew();
    }
}

/** First DR's own token refresh; if DR will not, a fresh login token and a new exchange */
function renewNow(): Promise<void> {
    var s = session as Session;
    var tokens: Token[] = [];
    if (s.profile && s.profile.refreshable) {
        tokens.push(s.profile);
    }
    if (s.account && s.account.refreshable) {
        tokens.push(s.account);
    }
    return Promise.all(tokens.map(function (t) {
        return postJson<RawToken[] | RawToken>(API + '/authorization/refresh', { token: t.value });
    })).then(function (replies) {
        var fresh = { refreshToken: s.refreshToken, account: s.account, profile: s.profile, profileId: s.profileId, name: s.name };
        for (var i = 0; i < replies.length; i++) {
            var got = toTokens(replies[i], Date.now());
            fresh.account = got.account || fresh.account;
            fresh.profile = got.profile || fresh.profile;
        }
        // Either token still due (not refreshable, or missing from DR's reply): a new exchange
        if (!tokens.length || needsRenew(fresh.profile, Date.now()) || needsRenew(fresh.account, Date.now())) {
            throw 'not renewed';
        }
        keep(fresh);
    }).then(null, function () {
        return postForm<RawOidcTokens>(OIDC + '/token', { grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: CLIENT_ID })
            .then(function (oidc) {
                return exchange(oidc, s.profileId);
            }, function (e: HttpError) {
                var body = errorBody<{ error?: string }>(e);
                if (body && body.error === 'invalid_grant') {
                    // DR no longer accepts this login (password changed, device removed)
                    logout();
                    if (onEnded) {
                        onEnded();
                    }
                }
                // Network or DR trouble: keep the session, the next renewal tries again
            });
    });
}

function keep(next: Session): void {
    session = next;
    save('session', next);
}
