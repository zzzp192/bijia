import fs from 'node:fs/promises';
import { CliError } from '../io/errors.js';
import { configFile } from './paths.js';
const OBJECT_KEYS = new Set([
    'defaultProfile',
    'timeouts',
    'artifacts',
    'daemon',
    'writeActions',
]);
export async function readConfig() {
    let text;
    try {
        text = await fs.readFile(configFile(), 'utf8');
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return {};
        throw new CliError(2, 'CONFIG_ERROR', `Cannot read config: ${e.message}`);
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (e) {
        throw new CliError(2, 'CONFIG_ERROR', `Invalid JSON in config: ${e.message}`);
    }
    return validateConfig(value);
}
export function validateConfig(value) {
    if (!isRecord(value)) {
        throw new CliError(2, 'CONFIG_ERROR', 'Config must be a JSON object.');
    }
    for (const key of Object.keys(value)) {
        if (!OBJECT_KEYS.has(key)) {
            throw new CliError(2, 'CONFIG_ERROR', `Unknown config key: ${key}`);
        }
    }
    const cfg = value;
    if (cfg.defaultProfile !== undefined && typeof cfg.defaultProfile !== 'string') {
        throw new CliError(2, 'CONFIG_ERROR', 'defaultProfile must be a string.');
    }
    validateNumberObject(cfg.timeouts, 'timeouts', [
        'searchMtopMs',
        'headedVerificationMs',
        'navigationMs',
    ]);
    validateNumberObject(cfg.artifacts, 'artifacts', ['retentionDays']);
    validateBooleanObject(cfg.daemon, 'daemon', ['headed']);
    validateBooleanObject(cfg.writeActions, 'writeActions', ['confirmBeforeCheckout']);
    return cfg;
}
function validateNumberObject(value, name, keys) {
    if (value === undefined)
        return;
    if (!isRecord(value))
        throw new CliError(2, 'CONFIG_ERROR', `${name} must be an object.`);
    for (const [key, raw] of Object.entries(value)) {
        if (!keys.includes(key))
            throw new CliError(2, 'CONFIG_ERROR', `Unknown config key: ${name}.${key}`);
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
            throw new CliError(2, 'CONFIG_ERROR', `${name}.${key} must be a non-negative number.`);
        }
    }
}
function validateBooleanObject(value, name, keys) {
    if (value === undefined)
        return;
    if (!isRecord(value))
        throw new CliError(2, 'CONFIG_ERROR', `${name} must be an object.`);
    for (const [key, raw] of Object.entries(value)) {
        if (!keys.includes(key))
            throw new CliError(2, 'CONFIG_ERROR', `Unknown config key: ${name}.${key}`);
        if (typeof raw !== 'boolean') {
            throw new CliError(2, 'CONFIG_ERROR', `${name}.${key} must be a boolean.`);
        }
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=config.js.map