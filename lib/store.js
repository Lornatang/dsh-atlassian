import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
/** Compare the bearer and refresh credentials, not object identity across reloads. */
export function sameTokens(left, right) {
    return left === right || !!left && !!right && left.access_token === right.access_token && left.refresh_token === right.refresh_token;
}
/** Keep credentials separate for each DSH profile and server. */
export function sessionFileFor(serverName, url, patchPath) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverName)) {
        throw new Error('atlassian: serverName must contain only letters, numbers, underscores or hyphens');
    }
    const profilePatch = patchPath ?? join(process.env['DSH_HOME'] || join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml');
    const digest = createHash('sha256').update(url).digest('hex').slice(0, 12);
    return join(dirname(profilePatch), 'data', `atlassian-bridge-${serverName}-${digest}.json`);
}
/** Reject symlinks and files that cannot be restricted to the service user. */
async function secureExistingFile(file) {
    let info;
    try {
        info = await lstat(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    if (!info.isFile())
        throw new Error(`atlassian: credential file must be a regular file: ${file}`);
    let handle;
    try {
        handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        if (error.code === 'ELOOP')
            throw new Error(`atlassian: credential file must be a regular file: ${file}`);
        throw error;
    }
    try {
        info = await handle.stat();
        if (!info.isFile())
            throw new Error(`atlassian: credential file must be a regular file: ${file}`);
        if (process.platform !== 'win32') {
            if (typeof process.geteuid === 'function' && info.uid !== process.geteuid()) {
                throw new Error(`atlassian: credential file must be owned by the service user: ${file}`);
            }
            await handle.chmod(0o600);
            info = await handle.stat();
            if ((info.mode & 0o077) !== 0)
                throw new Error(`atlassian: cannot secure credential file: ${file}`);
        }
        return handle;
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}
/** Serialize state changes and replace the file only after a complete write. */
export class SessionStore {
    #file;
    #value = { version: 1 };
    constructor(file) { this.#file = file; }
    get file() { return this.#file; }
    get current() { return this.#value; }
    /** Hold an OS-backed lock across the complete OAuth refresh exchange. */
    async acquire(signal) {
        const lockFile = `${this.#file}.lock.sqlite`;
        await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
        try {
            await (await open(lockFile, 'wx', 0o600)).close();
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        // Opening and closing the lock database outside SQLite can drop every
        // POSIX advisory lock that this process holds on the same inode.
        const info = await lstat(lockFile);
        if (!info.isFile())
            throw new Error(`atlassian: session lock must be a regular file: ${lockFile}`);
        if (process.platform !== 'win32') {
            if (typeof process.geteuid === 'function' && info.uid !== process.geteuid())
                throw new Error(`atlassian: session lock must be owned by the service user: ${lockFile}`);
            if ((info.mode & 0o077) !== 0)
                throw new Error(`atlassian: session lock must not be accessible to other users: ${lockFile}`);
        }
        const db = new DatabaseSync(lockFile);
        let locked = false;
        try {
            for (;;) {
                if (signal?.aborted)
                    throw new Error('atlassian: connection cancelled');
                try {
                    db.exec('BEGIN IMMEDIATE');
                    locked = true;
                    break;
                }
                catch (error) {
                    const code = error.errcode;
                    if (code === undefined || (code & 0xff) !== 5)
                        throw error;
                    try {
                        await delay(25, undefined, { signal });
                    }
                    catch {
                        throw new Error('atlassian: connection cancelled');
                    }
                }
            }
            await this.#read();
            let active = true;
            let running = 0;
            let closed = false;
            const close = () => {
                if (closed || active || running)
                    return;
                closed = true;
                try {
                    db.exec('ROLLBACK');
                }
                finally {
                    db.close();
                }
            };
            return {
                owner: this,
                get active() { return active; },
                async run(work) {
                    if (!active)
                        throw new Error('atlassian: invalid session lock');
                    running++;
                    try {
                        return await work();
                    }
                    finally {
                        running--;
                        close();
                    }
                },
                release() {
                    if (!active)
                        return;
                    active = false;
                    close();
                },
            };
        }
        catch (error) {
            if (locked) {
                try {
                    db.exec('ROLLBACK');
                }
                catch { /* closing also releases the lock */ }
            }
            db.close();
            throw error;
        }
    }
    async #withLease(work, lease, signal) {
        if (lease) {
            if (lease.owner !== this || !lease.active)
                throw new Error('atlassian: invalid session lock');
            return lease.run(work);
        }
        const acquired = await this.acquire(signal);
        try {
            return await work();
        }
        finally {
            acquired.release();
        }
    }
    async load(signal) {
        return this.#withLease(async () => this.#value, undefined, signal);
    }
    async #read() {
        const handle = await secureExistingFile(this.#file);
        if (!handle)
            return this.#value = { version: 1 };
        let raw;
        try {
            raw = await handle.readFile('utf8');
        }
        finally {
            await handle.close();
        }
        let parsed;
        try {
            parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
        }
        catch (error) {
            throw new Error(`atlassian: invalid credential file: ${this.#file}`, { cause: error });
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) {
            throw new Error(`atlassian: invalid credential file: ${this.#file}`);
        }
        this.#value = parsed;
        return this.#value;
    }
    async patch(patch, active, lease, expected, signal, guard = false) {
        await this.#withLease(async () => {
            if (active && !active())
                throw new Error('atlassian: connection cancelled');
            if ((expected || guard) && !sameTokens(this.#value.tokens, expected))
                throw new Error('atlassian: credentials changed; reconnect to continue');
            const next = { ...this.#value, ...patch, version: 1 };
            await this.#flush(next);
            this.#value = next;
        }, lease, signal);
    }
    /** A secondary process must not discard credentials merely because its callback port is busy. */
    async prepareRedirect(actual, signal) {
        await this.#withLease(async () => {
            const previous = this.#value.redirectUri;
            if (previous && previous !== actual && this.#value.tokens)
                return;
            const next = { ...this.#value, redirectUri: actual, version: 1 };
            if (previous && previous !== actual) {
                delete next.clientInformation;
                delete next.tokens;
                delete next.codeVerifier;
            }
            await this.#flush(next);
            this.#value = next;
        }, undefined, signal);
    }
    /** Re-register only when a new interactive flow needs a different callback. */
    async rebindRedirect(actual, expected, active, lease, signal) {
        await this.#withLease(async () => {
            if (!active())
                throw new Error('atlassian: connection cancelled');
            if (this.#value.tokens && !sameTokens(this.#value.tokens, expected))
                return;
            const next = { ...this.#value, redirectUri: actual, version: 1 };
            delete next.clientInformation;
            delete next.tokens;
            delete next.codeVerifier;
            await this.#flush(next);
            this.#value = next;
        }, lease, signal);
    }
    async saveTokens(tokens, active, expected, lease, signal, guard = false) {
        await this.#withLease(async () => {
            if (!active())
                throw new Error('atlassian: connection cancelled');
            if ((expected || guard) && !sameTokens(this.#value.tokens, expected) && !sameTokens(this.#value.tokens, tokens))
                return;
            const next = { ...this.#value, tokens, version: 1 };
            await this.#flush(next);
            this.#value = next;
        }, lease, signal);
    }
    async clearCredentialsIf(active, expected, lease, signal, guard, ...fields) {
        await this.#withLease(async () => {
            if (!active())
                throw new Error('atlassian: connection cancelled');
            if ((expected || guard) && !sameTokens(this.#value.tokens, expected))
                return;
            const next = { ...this.#value, version: 1 };
            for (const field of fields)
                if (field !== 'version')
                    delete next[field];
            await this.#flush(next);
            this.#value = next;
        }, lease, signal);
    }
    async clear(...fields) {
        await this.#withLease(async () => {
            const next = { ...this.#value, version: 1 };
            for (const field of fields)
                if (field !== 'version')
                    delete next[field];
            await this.#flush(next);
            this.#value = next;
        });
    }
    async destroy() {
        await this.#withLease(async () => {
            await (await secureExistingFile(this.#file))?.close();
            await rm(this.#file, { force: true });
            this.#value = { version: 1 };
        });
    }
    async #flush(value) {
        await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
        await (await secureExistingFile(this.#file))?.close();
        const temporary = `${this.#file}.${randomBytes(12).toString('hex')}.tmp`;
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await rename(temporary, this.#file);
        }
        finally {
            await rm(temporary, { force: true });
        }
    }
}
