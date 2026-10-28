import express from 'express';
import { ethers } from 'ethers';
import axios from 'axios';
import cors from 'cors';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import FormData from 'form-data';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Response helpers

function toJsonSafe(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonSafe(item)]));
  }
  return value;
}

const ok = (res, data) => res.status(200).json({ success: true, ...toJsonSafe(data) });

const sendError = (res, message, statusCode = 500) => {
  res.status(statusCode).json({ success: false, error: message });
};

const handle = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((error) => {
    console.error(`[ERROR] ${req.method} ${req.path}:`, error.message);
    if (error.statusCode) {
      return sendError(res, error.message, error.statusCode);
    }
    if (error.code === 'CALL_EXCEPTION') {
      const reason = error.reason || error.message || 'Unknown blockchain error';
      return sendError(res, `Blockchain error: ${reason}`, 502);
    }
    if (error.code === 'INSUFFICIENT_FUNDS') return sendError(res, 'Insufficient funds', 400);
    if (error.code === 'NETWORK_ERROR') return sendError(res, 'Network error, please retry', 503);
    return sendError(res, error.message || 'Internal server error', 500);
  });
};

// App setup

const app = express();
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
if (TRUST_PROXY) {
  app.set('trust proxy', true);
}

app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:5175')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function isPrivateDevOrigin(origin) {
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  } catch {
    return false;
  }

  return false;
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || isPrivateDevOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  }
}));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const CONFIGURED_JWT_SECRET = typeof process.env.JWT_SECRET === 'string' ? process.env.JWT_SECRET.trim() : '';
const JWT_SECRET_MIN_LENGTH = 32;
const JWT_SECRET_MODE = CONFIGURED_JWT_SECRET ? 'configured' : 'ephemeral';
const JWT_SECRET = CONFIGURED_JWT_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL_SECONDS || 8 * 60 * 60);
const WRITE_RATE_LIMIT_WINDOW_MS = Number(process.env.WRITE_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const WRITE_RATE_LIMIT_MAX = Number(process.env.WRITE_RATE_LIMIT_MAX || 30);
const rateLimitStore = new Map();

function nowMs() {
  return Date.now();
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function cleanupMap(store, timeKey, onChange) {
  const current = nowMs();
  let changed = false;
  for (const [key, value] of store.entries()) {
    if (!value || value[timeKey] <= current) {
      store.delete(key);
      changed = true;
    }
  }
  if (changed && onChange) {
    onChange();
  }
}

function validateWriteRateLimit(req, res) {
  cleanupMap(rateLimitStore, 'resetAt');
  const clientIp = getClientIp(req);
  const key = `${clientIp}:${req.path}`;
  const current = nowMs();
  const existing = rateLimitStore.get(key);

  if (!existing || existing.resetAt <= current) {
    rateLimitStore.set(key, { count: 1, resetAt: current + WRITE_RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (existing.count >= WRITE_RATE_LIMIT_MAX) {
    res.set('Retry-After', Math.ceil((existing.resetAt - current) / 1000).toString());
    sendError(res, 'Write rate limit exceeded', 429);
    return false;
  }

  existing.count += 1;
  return true;
}

function requireString(value, fieldName, { optional = false, maxLength = 2000 } = {}) {
  if (optional && (value === undefined || value === null || value === '')) {
    return null;
  }
  if (typeof value !== 'string') {
    const error = new Error(`${fieldName} must be a string`);
    error.statusCode = 400;
    throw error;
  }
  const trimmed = value.trim();
  if (!optional && !trimmed) {
    const error = new Error(`${fieldName} is required`);
    error.statusCode = 400;
    throw error;
  }
  if (trimmed.length > maxLength) {
    const error = new Error(`${fieldName} is too long`);
    error.statusCode = 400;
    throw error;
  }
  return trimmed;
}

function requirePositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${fieldName} must be a positive integer`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function requirePlainObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error(`${fieldName} must be an object`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function computeStatementHash(canonicalMetadata) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(canonicalMetadata));
  return BigInt(hash) % SNARK_SCALAR_FIELD;
}

function parseBigNumberish(value, fieldName) {
  try {
    return BigInt(value);
  } catch {
    const error = new Error(`${fieldName} must be a valid bigint-compatible value`);
    error.statusCode = 400;
    throw error;
  }
}

function requireArray(value, fieldName, expectedLength) {
  if (!Array.isArray(value) || (expectedLength !== undefined && value.length !== expectedLength)) {
    const error = new Error(
      expectedLength === undefined
        ? `${fieldName} must be an array`
        : `${fieldName} must be an array of length ${expectedLength}`
    );
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function parseCanonicalMetadataOrThrow(value) {
  const canonicalMetadata = requireString(value, 'canonicalMetadata', { maxLength: 50000 });
  let parsed;

  try {
    parsed = JSON.parse(canonicalMetadata);
  } catch {
    const error = new Error('canonicalMetadata must be valid JSON');
    error.statusCode = 400;
    throw error;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('canonicalMetadata must encode a JSON object');
    error.statusCode = 400;
    throw error;
  }

  return { canonicalMetadata, parsed };
}

function validateCanonicalMetadataShape(metadata, { modelName, chain }) {
  const requiredFields = [
    'action',
    'artifactCid',
    'chain',
    'commit',
    'modelHash',
    'modelName',
    'sender',
    'submittedAt',
    'trainingMetadata',
    'versionTag'
  ];

  for (const field of requiredFields) {
    if (!(field in metadata)) {
      const error = new Error(`canonicalMetadata is missing required field: ${field}`);
      error.statusCode = 400;
      throw error;
    }
  }

  requireString(metadata.action, 'canonicalMetadata.action', { maxLength: 64 });
  requireString(metadata.artifactCid, 'canonicalMetadata.artifactCid', { maxLength: 256 });
  requireString(metadata.chain, 'canonicalMetadata.chain', { maxLength: 64 });
  requireString(metadata.commit, 'canonicalMetadata.commit', { maxLength: 2048 });
  requireString(metadata.modelHash, 'canonicalMetadata.modelHash', { maxLength: 256 });
  requireString(metadata.modelName, 'canonicalMetadata.modelName', { maxLength: 256 });
  requireString(metadata.sender, 'canonicalMetadata.sender', { maxLength: 256 });
  requireString(metadata.submittedAt, 'canonicalMetadata.submittedAt', { maxLength: 128 });
  requireString(metadata.versionTag, 'canonicalMetadata.versionTag', { maxLength: 64 });
  requirePlainObject(metadata.trainingMetadata, 'canonicalMetadata.trainingMetadata');

  if (metadata.modelName !== modelName) {
    const error = new Error('modelName does not match canonicalMetadata.modelName');
    error.statusCode = 400;
    throw error;
  }

  if (metadata.chain !== chain) {
    const error = new Error('chain does not match canonicalMetadata.chain');
    error.statusCode = 400;
    throw error;
  }

  const forbiddenFields = ['zkProof', 'zk_public_signals', 'zk_calldata', 'proof', 'publicSignals'];
  for (const field of forbiddenFields) {
    if (field in metadata || field in metadata.trainingMetadata) {
      const error = new Error(`canonicalMetadata must not include proof field: ${field}`);
      error.statusCode = 400;
      throw error;
    }
  }

  return metadata;
}

function normalizeZKProof(zkProof) {
  const proof = requirePlainObject(zkProof, 'zkProof');
  const pA = requireArray(proof.pA, 'zkProof.pA', 2).map((value, index) =>
    parseBigNumberish(value, `zkProof.pA[${index}]`).toString()
  );
  const pB = requireArray(proof.pB, 'zkProof.pB', 2).map((row, rowIndex) =>
    requireArray(row, `zkProof.pB[${rowIndex}]`, 2).map((value, colIndex) =>
      parseBigNumberish(value, `zkProof.pB[${rowIndex}][${colIndex}]`).toString()
    )
  );
  const pC = requireArray(proof.pC, 'zkProof.pC', 2).map((value, index) =>
    parseBigNumberish(value, `zkProof.pC[${index}]`).toString()
  );
  const publicSignals = requireArray(proof.publicSignals, 'zkProof.publicSignals', 3).map((value, index) =>
    parseBigNumberish(value, `zkProof.publicSignals[${index}]`)
  );

  return { pA, pB, pC, publicSignals };
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ADDR_FILE = path.join(PROJECT_ROOT, 'address_v2_multi.json');
const MODEL_INDEX_FILE = path.join(PROJECT_ROOT, 'model_name_map.json');
const SECRETS_FILE = path.join(PROJECT_ROOT, 'model_secrets', 'secrets.json');
const LEGACY_USERS_FILE = path.join(__dirname, 'users.json');
const AUTH_STORE_FILE = path.resolve(
  process.env.AUTH_USER_STORE_FILE || path.join(__dirname, 'data', 'auth_store.json')
);
const LEGACY_OWNER_KEY = '__legacy__';
const DEFAULT_USERS = [
  {
    username: 'researcher',
    password: 'researcher-demo-pass',
    walletAddress: '0xEF8a56C4040Bf0E3f2cEC1eBFf244bd77d04d5E1',
    role: 'researcher'
  }
];
const ALLOWED_USER_ROLES = new Set(['researcher', 'admin']);
const ALLOWED_USER_STATUSES = new Set(['active', 'disabled']);
const AUTH_TOKEN_ISSUER = String(process.env.AUTH_TOKEN_ISSUER || 'ai-provenance-backend').trim() || 'ai-provenance-backend';
const AUTH_TOKEN_AUDIENCE = String(process.env.AUTH_TOKEN_AUDIENCE || 'ai-provenance-sdk').trim() || 'ai-provenance-sdk';
const AUTH_LOCKOUT_THRESHOLD = Math.max(1, Number(process.env.AUTH_LOCKOUT_THRESHOLD || 5));
const AUTH_LOCKOUT_DURATION_SECONDS = Math.max(60, Number(process.env.AUTH_LOCKOUT_DURATION_SECONDS || 15 * 60));

let addrs;
try {
  addrs = JSON.parse(fs.readFileSync(ADDR_FILE, 'utf8'));
} catch (error) {
  console.error('Failed to load address file:', ADDR_FILE);
  process.exit(1);
}

function createEmptyModelIndex() {
  return {
    version: 2,
    chains: {}
  };
}

function normalizeModelNameKey(modelName) {
  return String(modelName || '').trim().toLowerCase();
}

function tryNormalizeWalletAddress(value) {
  if (!value || value === LEGACY_OWNER_KEY) {
    return null;
  }

  try {
    return ethers.getAddress(String(value));
  } catch {
    return null;
  }
}

function normalizeWalletAddress(value, fieldName = 'walletAddress') {
  try {
    return ethers.getAddress(String(value));
  } catch {
    const error = new Error(`${fieldName} must be a valid EVM address`);
    error.statusCode = 400;
    throw error;
  }
}

function ensureChainIndex(index, chain) {
  if (!index.chains[chain]) {
    index.chains[chain] = { owners: {} };
  }
  return index.chains[chain];
}

function ensureOwnerBucket(index, chain, owner) {
  const chainEntry = ensureChainIndex(index, chain);
  const ownerKey = tryNormalizeWalletAddress(owner) || LEGACY_OWNER_KEY;
  if (!chainEntry.owners[ownerKey]) {
    chainEntry.owners[ownerKey] = {};
  }
  return { ownerKey, bucket: chainEntry.owners[ownerKey] };
}

function upsertModelIndexEntry(index, { chain, owner, modelName, modelId, createdAt = null }) {
  const normalizedName = normalizeModelNameKey(modelName);
  if (!normalizedName) {
    return null;
  }

  const normalizedOwner = tryNormalizeWalletAddress(owner);
  const { bucket } = ensureOwnerBucket(index, chain, normalizedOwner);
  bucket[normalizedName] = {
    id: Number(modelId),
    name: String(modelName).trim(),
    owner: normalizedOwner,
    createdAt: createdAt || bucket[normalizedName]?.createdAt || new Date().toISOString()
  };
  return bucket[normalizedName];
}

function findIndexedModel(chain, owner, modelName) {
  const chainEntry = modelIndex.chains?.[chain];
  if (!chainEntry) {
    return null;
  }

  const ownerKey = tryNormalizeWalletAddress(owner) || LEGACY_OWNER_KEY;
  const normalizedName = normalizeModelNameKey(modelName);
  const entry = chainEntry.owners?.[ownerKey]?.[normalizedName];
  if (!entry) {
    return null;
  }

  return {
    ...entry,
    chain,
    ownerKey,
    modelNameKey: normalizedName
  };
}

function removeIndexedModel(chain, owner, modelName) {
  const chainEntry = modelIndex.chains?.[chain];
  if (!chainEntry) {
    return;
  }

  const ownerKey = tryNormalizeWalletAddress(owner) || LEGACY_OWNER_KEY;
  const normalizedName = normalizeModelNameKey(modelName);
  if (!chainEntry.owners?.[ownerKey]?.[normalizedName]) {
    return;
  }

  delete chainEntry.owners[ownerKey][normalizedName];
  if (Object.keys(chainEntry.owners[ownerKey]).length === 0) {
    delete chainEntry.owners[ownerKey];
  }
  if (Object.keys(chainEntry.owners).length === 0) {
    delete modelIndex.chains[chain];
  }
  saveModelIndex(modelIndex);
}

function migrateIndexedModelOwner(chain, entry, resolvedOwner) {
  const normalizedOwner = tryNormalizeWalletAddress(resolvedOwner);
  if (!entry || !normalizedOwner || entry.ownerKey === normalizedOwner) {
    return;
  }

  removeIndexedModel(chain, entry.ownerKey === LEGACY_OWNER_KEY ? null : entry.ownerKey, entry.name || entry.modelNameKey);
  upsertModelIndexEntry(modelIndex, {
    chain,
    owner: normalizedOwner,
    modelName: entry.name || entry.modelNameKey,
    modelId: entry.id,
    createdAt: entry.createdAt || null
  });
  saveModelIndex(modelIndex);
}

function loadModelIndex() {
  try {
    if (!fs.existsSync(MODEL_INDEX_FILE)) {
      return createEmptyModelIndex();
    }

    const parsed = JSON.parse(fs.readFileSync(MODEL_INDEX_FILE, 'utf8'));
    if (parsed?.version === 2 && parsed?.chains) {
      return parsed;
    }

    const converted = createEmptyModelIndex();
    for (const [key, modelId] of Object.entries(parsed || {})) {
      const separatorIndex = key.indexOf(':');
      if (separatorIndex === -1) continue;

      const chain = key.slice(0, separatorIndex);
      const modelName = key.slice(separatorIndex + 1);
      const numericId = Number(modelId);
      if (!chain || !modelName || !Number.isInteger(numericId) || numericId <= 0) continue;

      upsertModelIndexEntry(converted, {
        chain,
        owner: null,
        modelName,
        modelId: numericId
      });
    }

    return converted;
  } catch {}
  return createEmptyModelIndex();
}

function saveModelIndex(index) {
  fs.writeFileSync(MODEL_INDEX_FILE, JSON.stringify(index, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, saltHex, digestHex] = String(storedHash || '').split('$');
  if (algorithm !== 'scrypt' || !saltHex || !digestHex) {
    return false;
  }

  const expected = Buffer.from(digestHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isoNow() {
  return new Date().toISOString();
}

function normalizeUserStatus(status, fieldName = 'status') {
  const normalized = requireString(status || 'active', fieldName, { maxLength: 64 }).toLowerCase();
  if (!ALLOWED_USER_STATUSES.has(normalized)) {
    const error = new Error(`${fieldName} must be one of: ${Array.from(ALLOWED_USER_STATUSES).join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeTokenVersion(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeTimestamp(value, { allowNull = true } = {}) {
  if (value === undefined || value === null || value === '') {
    return allowNull ? null : isoNow();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return allowNull ? null : isoNow();
  }
  return parsed.toISOString();
}

function normalizeFailedLoginCount(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function createStoredUserRecord({
  username,
  passwordHash,
  walletAddress,
  role = 'researcher',
  status = 'active',
  tokenVersion = 1,
  createdAt = null,
  updatedAt = null,
  passwordChangedAt = null,
  lastLoginAt = null,
  failedLoginCount = 0,
  lockedUntil = null
}) {
  const now = isoNow();
  return {
    username: requireString(username, 'username', { maxLength: 64 }).toLowerCase(),
    passwordHash: requireString(passwordHash, 'passwordHash', { maxLength: 512 }),
    walletAddress: normalizeWalletAddress(walletAddress),
    role: normalizeUserRole(role || 'researcher'),
    status: normalizeUserStatus(status || 'active'),
    tokenVersion: normalizeTokenVersion(tokenVersion),
    createdAt: normalizeTimestamp(createdAt, { allowNull: false }) || now,
    updatedAt: normalizeTimestamp(updatedAt, { allowNull: false }) || now,
    passwordChangedAt: normalizeTimestamp(passwordChangedAt, { allowNull: false }) || now,
    lastLoginAt: normalizeTimestamp(lastLoginAt),
    failedLoginCount: normalizeFailedLoginCount(failedLoginCount),
    lockedUntil: normalizeTimestamp(lockedUntil)
  };
}

function createDefaultStoredUsers() {
  return DEFAULT_USERS.map((user) => createStoredUserRecord({
    username: user.username,
    passwordHash: hashPassword(user.password),
    walletAddress: user.walletAddress,
    role: user.role
  }));
}

function ensureUserStoreFile() {
  fs.mkdirSync(path.dirname(AUTH_STORE_FILE), { recursive: true });
  if (fs.existsSync(AUTH_STORE_FILE)) {
    return;
  }

  let source = null;
  if (fs.existsSync(LEGACY_USERS_FILE)) {
    try {
      source = JSON.parse(fs.readFileSync(LEGACY_USERS_FILE, 'utf8'));
    } catch {
      source = null;
    }
  }

  const seeded = {
    version: 2,
    users: Array.isArray(source?.users) && source.users.length > 0
      ? source.users.map((user) => createStoredUserRecord({
        username: user.username,
        passwordHash: user.passwordHash || hashPassword(user.password || 'change-me'),
        walletAddress: user.walletAddress,
        role: user.role || 'researcher',
        status: user.status || 'active',
        tokenVersion: user.tokenVersion,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        passwordChangedAt: user.passwordChangedAt,
        lastLoginAt: user.lastLoginAt,
        failedLoginCount: user.failedLoginCount,
        lockedUntil: user.lockedUntil
      }))
      : createDefaultStoredUsers()
  };
  fs.writeFileSync(AUTH_STORE_FILE, `${JSON.stringify(seeded, null, 2)}\n`);
}

function loadUserStore() {
  ensureUserStoreFile();
  const parsed = JSON.parse(fs.readFileSync(AUTH_STORE_FILE, 'utf8'));
  return {
    version: parsed?.version || 2,
    users: (parsed?.users || []).map((user) => ({
      ...createStoredUserRecord({
        username: user.username,
        passwordHash: user.passwordHash,
        walletAddress: user.walletAddress,
        role: user.role || 'researcher',
        status: user.status || 'active',
        tokenVersion: user.tokenVersion,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        passwordChangedAt: user.passwordChangedAt,
        lastLoginAt: user.lastLoginAt,
        failedLoginCount: user.failedLoginCount,
        lockedUntil: user.lockedUntil
      })
    }))
  };
}

function saveUserStore(store = userStore) {
  fs.mkdirSync(path.dirname(AUTH_STORE_FILE), { recursive: true });
  fs.writeFileSync(AUTH_STORE_FILE, `${JSON.stringify({
    version: store.version || 2,
    users: store.users
  }, null, 2)}\n`);
}

function normalizeUserRole(role, fieldName = 'role') {
  const normalized = requireString(role || 'researcher', fieldName, { maxLength: 64 }).toLowerCase();
  if (!ALLOWED_USER_ROLES.has(normalized)) {
    const error = new Error(`${fieldName} must be one of: ${Array.from(ALLOWED_USER_ROLES).join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function refreshUserStoreFromDisk() {
  const latest = loadUserStore();
  userStore.version = latest.version;
  userStore.users = latest.users;
  return userStore;
}

function findStoredUserByUsername(normalizedUsername) {
  return userStore.users.find((user) => user.username === normalizedUsername) || null;
}

function findStoredUserByWalletAddress(walletAddress) {
  return userStore.users.find((user) => user.walletAddress === walletAddress) || null;
}

function findUserByUsername(username) {
  refreshUserStoreFromDisk();
  const normalizedUsername = String(username || '').trim().toLowerCase();
  return findStoredUserByUsername(normalizedUsername);
}

function listPublicUsers() {
  refreshUserStoreFromDisk();
  return userStore.users
    .slice()
    .sort((left, right) => left.username.localeCompare(right.username))
    .map((user) => buildPublicUser(user));
}

function createLocalUser({ username, password, walletAddress, role, status }) {
  refreshUserStoreFromDisk();

  const normalizedUsername = requireString(username, 'username', { maxLength: 64 }).toLowerCase();
  if (findStoredUserByUsername(normalizedUsername)) {
    const error = new Error(`User '${normalizedUsername}' already exists`);
    error.statusCode = 409;
    throw error;
  }

  const normalizedPassword = requireString(password, 'password', { maxLength: 256 });
  const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
  const normalizedRole = normalizeUserRole(role || 'researcher');
  const normalizedStatus = normalizeUserStatus(status || 'active');
  if (findStoredUserByWalletAddress(normalizedWalletAddress)) {
    const error = new Error(`Wallet '${normalizedWalletAddress}' is already bound to another user`);
    error.statusCode = 409;
    throw error;
  }

  const nextUser = createStoredUserRecord({
    username: normalizedUsername,
    passwordHash: hashPassword(normalizedPassword),
    walletAddress: normalizedWalletAddress,
    role: normalizedRole,
    status: normalizedStatus
  });

  userStore.users.push(nextUser);
  saveUserStore(userStore);
  return buildPublicUser(nextUser);
}

function deleteLocalUser(username, { requestedBy = null } = {}) {
  refreshUserStoreFromDisk();

  const normalizedUsername = requireString(username, 'username', { maxLength: 64 }).toLowerCase();
  const existing = findStoredUserByUsername(normalizedUsername);
  if (!existing) {
    const error = new Error(`User '${normalizedUsername}' was not found`);
    error.statusCode = 404;
    throw error;
  }

  if (requestedBy && normalizedUsername === String(requestedBy).trim().toLowerCase()) {
    const error = new Error('Admin users cannot delete their own active account via the API');
    error.statusCode = 400;
    throw error;
  }

  if (existing.role === 'admin' && existing.status === 'active') {
    const adminCount = userStore.users.filter((user) => user.role === 'admin' && user.status === 'active').length;
    if (adminCount <= 1) {
      const error = new Error('At least one admin user must remain');
      error.statusCode = 400;
      throw error;
    }
  }

  userStore.users = userStore.users.filter((user) => user.username !== normalizedUsername);
  saveUserStore(userStore);
  return buildPublicUser(existing);
}

function isUserLocked(user) {
  return Boolean(user?.lockedUntil) && new Date(user.lockedUntil).valueOf() > nowMs();
}

function markFailedLogin(username) {
  refreshUserStoreFromDisk();
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const user = findStoredUserByUsername(normalizedUsername);
  if (!user) {
    return null;
  }

  user.failedLoginCount = normalizeFailedLoginCount(user.failedLoginCount) + 1;
  if (user.failedLoginCount >= AUTH_LOCKOUT_THRESHOLD) {
    user.lockedUntil = new Date(nowMs() + AUTH_LOCKOUT_DURATION_SECONDS * 1000).toISOString();
    user.failedLoginCount = 0;
  }
  user.updatedAt = isoNow();
  saveUserStore(userStore);
  return user;
}

function markSuccessfulLogin(username) {
  refreshUserStoreFromDisk();
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const user = findStoredUserByUsername(normalizedUsername);
  if (!user) {
    return null;
  }

  user.failedLoginCount = 0;
  user.lockedUntil = null;
  user.lastLoginAt = isoNow();
  user.updatedAt = isoNow();
  saveUserStore(userStore);
  return user;
}

function updateLocalUser(username, updates, { requestedBy = null } = {}) {
  refreshUserStoreFromDisk();

  const normalizedUsername = requireString(username, 'username', { maxLength: 64 }).toLowerCase();
  const existing = findStoredUserByUsername(normalizedUsername);
  if (!existing) {
    const error = new Error(`User '${normalizedUsername}' was not found`);
    error.statusCode = 404;
    throw error;
  }

  const nextRole = updates.role !== undefined ? normalizeUserRole(updates.role) : existing.role;
  const nextStatus = updates.status !== undefined ? normalizeUserStatus(updates.status) : existing.status;
  const requestedWallet = updates.walletAddress !== undefined ? updates.walletAddress : updates.wallet;
  const nextWalletAddress = requestedWallet !== undefined ? normalizeWalletAddress(requestedWallet) : existing.walletAddress;
  const nextPassword = updates.password !== undefined
    ? requireString(updates.password, 'password', { maxLength: 256 })
    : null;

  const walletConflict = userStore.users.find(
    (user) => user.username !== normalizedUsername && user.walletAddress === nextWalletAddress
  );
  if (walletConflict) {
    const error = new Error(`Wallet '${nextWalletAddress}' is already bound to another user`);
    error.statusCode = 409;
    throw error;
  }

  const requestedByUsername = requestedBy ? String(requestedBy).trim().toLowerCase() : null;
  if (requestedByUsername && requestedByUsername === normalizedUsername && nextStatus !== 'active') {
    const error = new Error('Admin users cannot disable their own active account via the API');
    error.statusCode = 400;
    throw error;
  }

  const activeAdminsExcludingCurrent = userStore.users.filter(
    (user) => user.username !== normalizedUsername && user.role === 'admin' && user.status === 'active'
  ).length;
  if (existing.role === 'admin' && existing.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active') && activeAdminsExcludingCurrent < 1) {
    const error = new Error('At least one active admin user must remain');
    error.statusCode = 400;
    throw error;
  }

  const securityRelevantChange = (
    existing.role !== nextRole
    || existing.status !== nextStatus
    || existing.walletAddress !== nextWalletAddress
    || nextPassword !== null
  );

  existing.role = nextRole;
  existing.status = nextStatus;
  existing.walletAddress = nextWalletAddress;
  existing.updatedAt = isoNow();

  if (nextPassword !== null) {
    existing.passwordHash = hashPassword(nextPassword);
    existing.passwordChangedAt = isoNow();
    existing.failedLoginCount = 0;
    existing.lockedUntil = null;
  }

  if (securityRelevantChange) {
    existing.tokenVersion = normalizeTokenVersion(existing.tokenVersion) + 1;
  }

  saveUserStore(userStore);
  return buildPublicUser(existing);
}

function base64urlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecode(value) {
  const normalized = String(value)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64');
}

function signAuthToken(payload) {
  const headerSegment = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadSegment = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(signingInput).digest();
  return `${signingInput}.${base64urlEncode(signature)}`;
}

function verifyAuthToken(token) {
  const segments = String(token || '').split('.');
  if (segments.length !== 3) {
    const error = new Error('Malformed token');
    error.statusCode = 401;
    throw error;
  }

  const [headerSegment, payloadSegment, signatureSegment] = segments;
  const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(`${headerSegment}.${payloadSegment}`).digest();
  const providedSignature = base64urlDecode(signatureSegment);
  if (
    expectedSignature.length !== providedSignature.length ||
    !crypto.timingSafeEqual(expectedSignature, providedSignature)
  ) {
    const error = new Error('Invalid token signature');
    error.statusCode = 401;
    throw error;
  }

  const payload = JSON.parse(base64urlDecode(payloadSegment).toString('utf8'));
  const currentEpoch = Math.floor(nowMs() / 1000);
  if (payload?.iss !== AUTH_TOKEN_ISSUER) {
    const error = new Error('Invalid token issuer');
    error.statusCode = 401;
    throw error;
  }
  if (payload?.aud !== AUTH_TOKEN_AUDIENCE) {
    const error = new Error('Invalid token audience');
    error.statusCode = 401;
    throw error;
  }
  if (payload?.nbf && Number(payload.nbf) > currentEpoch) {
    const error = new Error('Authentication token is not active yet');
    error.statusCode = 401;
    throw error;
  }
  if (!payload?.exp || Number(payload.exp) <= currentEpoch) {
    const error = new Error('Authentication token expired');
    error.statusCode = 401;
    throw error;
  }

  return payload;
}

function buildPublicUser(user) {
  return {
    username: user.username,
    walletAddress: normalizeWalletAddress(user.walletAddress),
    role: user.role,
    status: normalizeUserStatus(user.status || 'active'),
    createdAt: normalizeTimestamp(user.createdAt),
    updatedAt: normalizeTimestamp(user.updatedAt),
    lastLoginAt: normalizeTimestamp(user.lastLoginAt)
  };
}

function issueSessionForUser(user) {
  const nowEpoch = Math.floor(nowMs() / 1000);
  const payload = {
    sub: user.username,
    username: user.username,
    walletAddress: normalizeWalletAddress(user.walletAddress),
    role: user.role,
    status: normalizeUserStatus(user.status || 'active'),
    ver: normalizeTokenVersion(user.tokenVersion),
    iss: AUTH_TOKEN_ISSUER,
    aud: AUTH_TOKEN_AUDIENCE,
    jti: crypto.randomUUID(),
    iat: nowEpoch,
    nbf: nowEpoch,
    exp: nowEpoch + AUTH_TOKEN_TTL_SECONDS
  };

  return {
    token: signAuthToken(payload),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    user: buildPublicUser(payload)
  };
}

function requireAuth(req, res, next) {
  if (!validateWriteRateLimit(req, res)) {
    return;
  }

  const authorization = req.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    return sendError(res, 'Missing bearer token', 401);
  }

  try {
    const payload = verifyAuthToken(authorization.slice(7));
    const currentUser = findUserByUsername(payload.sub || payload.username);
    if (!currentUser) {
      return sendError(res, 'Authentication token no longer maps to a user', 401);
    }
    if (currentUser.status !== 'active') {
      return sendError(res, 'User account is disabled', 403);
    }
    if (normalizeTokenVersion(currentUser.tokenVersion) !== normalizeTokenVersion(payload.ver)) {
      return sendError(res, 'Authentication token has been revoked', 401);
    }
    req.auth = buildPublicUser(currentUser);
    next();
  } catch (error) {
    return sendError(res, error.message || 'Invalid authentication token', error.statusCode || 401);
  }
}

function requireRole(expectedRole) {
  return (req, res, next) => {
    if (!req.auth) {
      return sendError(res, 'Authentication is required', 401);
    }

    if (req.auth.role !== expectedRole) {
      return sendError(res, `This route requires role: ${expectedRole}`, 403);
    }

    next();
  };
}

const modelIndex = loadModelIndex();
const userStore = loadUserStore();

function loadSecretStore() {
  try {
    if (!fs.existsSync(SECRETS_FILE)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    return raw?.series || raw || {};
  } catch {
    return {};
  }
}

function decryptSecretCiphertext(ciphertext) {
  if (process.platform !== 'win32') {
    throw new Error('Encrypted secret lookup currently requires Windows DPAPI');
  }

  const env = {
    ...process.env,
    MODEL_SECRET_CIPHERTEXT_B64: Buffer.from(String(ciphertext), 'utf8').toString('base64')
  };

  const script =
    "$cipher = [System.Text.Encoding]::UTF8.GetString(" +
    "[System.Convert]::FromBase64String($env:MODEL_SECRET_CIPHERTEXT_B64));" +
    "$secure = ConvertTo-SecureString $cipher;" +
    "$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);" +
    "try { [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } " +
    "finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }";

  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    env,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || 'Failed to decrypt secret ciphertext');
  }

  return result.stdout.trim();
}

function resolveSeriesSecret(entry) {
  if (entry?.secret !== undefined && entry?.secret !== null) {
    return String(entry.secret);
  }

  if (entry?.secret_ciphertext) {
    try {
      return decryptSecretCiphertext(entry.secret_ciphertext);
    } catch {
      return null;
    }
  }

  return null;
}

function findSeriesBySecret(secret) {
  const seriesStore = loadSecretStore();
  const target = String(secret);

  for (const [seriesName, entry] of Object.entries(seriesStore)) {
    const resolved = resolveSeriesSecret(entry);
    if (resolved !== null && String(resolved) === target) {
      return {
        seriesName,
        entry,
        storageMode: entry?.secret_ciphertext ? 'encrypted' : 'plaintext-legacy'
      };
    }
  }

  return null;
}

function parseMetadataString(value) {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getRecordMetadata(record) {
  const metadataRaw = record?.ipfsMetadata ?? record?.[3];
  return parseMetadataString(metadataRaw);
}

function getArtifactCid(metadata) {
  return metadata?.artifactCid || metadata?.ipfsHash || metadata?.metadataCid || null;
}

function buildLifecycleFilename(seriesName, versionEntry, metadata) {
  if (versionEntry?.artifact_filename) {
    return versionEntry.artifact_filename;
  }

  const weightsPath = metadata?.trainingMetadata?.weights_path;
  if (weightsPath) {
    return path.basename(weightsPath);
  }

  const safeSeries = String(seriesName || 'model').replace(/[^\w.-]+/g, '_');
  const safeVersion = String(versionEntry?.version || 'version').replace(/[^\w.-]+/g, '_');
  return `${safeSeries}-${safeVersion}.bin`;
}

async function enrichLifecycleVersion(versionEntry) {
  const enriched = {
    version: versionEntry.version,
    modelId: versionEntry.model_id,
    modelHash: versionEntry.model_hash,
    timestamp: versionEntry.timestamp,
    modelName: versionEntry.model_name || null,
    chain: versionEntry.chain || null,
    ipfsCid: versionEntry.ipfs_cid || null,
    txHash: versionEntry.tx_hash || null,
    artifactFileName: versionEntry.artifact_filename || null,
    downloadReady: false,
    downloadSource: null
  };

  const modelId = Number(versionEntry.model_id);
  if (!Number.isInteger(modelId) || modelId <= 0) {
    if (enriched.ipfsCid) {
      enriched.downloadReady = true;
      enriched.downloadSource = 'ipfs';
    }
    return enriched;
  }

  const chainCandidates = versionEntry.chain ? [versionEntry.chain] : ['sepolia', 'tbnb'];

  async function tryResolveFromHistory(chain, history) {
    const matchingRecord = [...history].reverse().find((record) => {
      const metadata = getRecordMetadata(record);
      if (!metadata) return false;
      return (
        metadata.modelHash === versionEntry.model_hash ||
        metadata.versionTag === versionEntry.version
      );
    });

    if (!matchingRecord) {
      return false;
    }

    const metadata = getRecordMetadata(matchingRecord);
    const artifactCid = getArtifactCid(metadata);
    if (artifactCid && !enriched.ipfsCid) {
      enriched.ipfsCid = artifactCid;
    }
    if (!enriched.modelName && (metadata?.modelName || metadata?.trainingMetadata?.model_name)) {
      enriched.modelName = metadata.modelName || metadata.trainingMetadata.model_name;
    }
    if (!enriched.chain) {
      enriched.chain = chain;
    }
    if (!enriched.artifactFileName) {
      enriched.artifactFileName = buildLifecycleFilename(null, versionEntry, metadata);
    }
    if (enriched.ipfsCid) {
      enriched.downloadReady = true;
      enriched.downloadSource = 'ipfs';
    }
    return enriched.downloadReady;
  }

  for (const chain of chainCandidates) {
    if (!chains[chain]) continue;

    try {
      const { mpt } = getContracts(chain);
      const history = await mpt.getModelHistory(modelId);
      if (await tryResolveFromHistory(chain, history)) {
        return enriched;
      }
    } catch {
      continue;
    }
  }

  for (const chain of chainCandidates) {
    if (!chains[chain]) continue;

    try {
      const { mpt } = getContracts(chain);
      const knownModels = getKnownModels(chain);
      for (const knownModel of knownModels) {
        const history = await mpt.getModelHistory(knownModel.id);
        if (await tryResolveFromHistory(chain, history)) {
          return enriched;
        }
      }
    } catch {
      continue;
    }
  }

  return enriched;
}

async function fetchIpfsBinary(cid) {
  const gateways = [
    `https://gateway.pinata.cloud/ipfs/${cid}`,
    `https://ipfs.io/ipfs/${cid}`
  ];

  for (const url of gateways) {
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
      return Buffer.from(response.data);
    } catch {}
  }

  return null;
}

saveModelIndex(modelIndex);

const SEPOLIA_RPC =
  process.env.SEPOLIA_RPC ||
  process.env.SEPOLIA_URL ||
  (process.env.INFURA_API_KEY
    ? `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`
    : 'https://rpc.sepolia.org');
const TBNB_RPC = process.env.BNB_TESTNET_URL || 'https://bsc-testnet.publicnode.com';

const pk = process.env.PRIVATE_KEY?.trim() || '';
const bootWarnings = [];
if (!pk) {
  bootWarnings.push('PRIVATE_KEY missing: backend will start in read-only mode and write routes will be unavailable.');
}
if (!CONFIGURED_JWT_SECRET) {
  bootWarnings.push('JWT_SECRET missing: backend generated an ephemeral signing secret for this process. Set JWT_SECRET for demo, shared, or persistent environments.');
} else if (CONFIGURED_JWT_SECRET.length < JWT_SECRET_MIN_LENGTH) {
  bootWarnings.push(`JWT_SECRET is shorter than the recommended ${JWT_SECRET_MIN_LENGTH} characters. Use a long random secret for demo and production-like environments.`);
}

const sepProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
const bnbProvider = new ethers.JsonRpcProvider(TBNB_RPC);
const sepWallet = pk ? new ethers.Wallet(pk, sepProvider) : null;
const bnbWallet = pk ? new ethers.Wallet(pk, bnbProvider) : null;

const chains = {
  sepolia: { provider: sepProvider, wallet: sepWallet, addr: addrs.sepolia },
  tbnb: { provider: bnbProvider, wallet: bnbWallet, addr: addrs.tbnb }
};

const MR_ABI = [
  'function registerModel(string memory _name, string memory _description,' +
    ' string memory _ipfsCid, string memory _checksum, string memory _framework,' +
    ' string memory _license) external returns (uint256)',
  'function registerModelFor(address _owner, string memory _name, string memory _description,' +
    ' string memory _ipfsCid, string memory _checksum, string memory _framework,' +
    ' string memory _license) external returns (uint256)',
  'function activateModel(uint256 _id) external',
  'function getModelOwner(uint256 _id) view returns (address)',
  'function getModelStatus(uint256 _id) view returns (uint8)',
  'function isModelStaked(uint256 _id) view returns (bool)',
  'function accessControl() view returns (address)',
  'event ModelRegistered(uint256 indexed id, address indexed owner)'
];

const MAC_ABI = [
  'function ADMIN() view returns (bytes32)',
  'function REGISTRAR() view returns (bytes32)',
  'function hasRole(bytes32 role, address addr) view returns (bool)',
  'function grantRole(bytes32 role, address addr)'
];

const ZKPT_ABI = [
  'function addVerifiedRecord(uint256 _modelId, uint8 _eventType,' +
    ' string calldata _canonicalMetadata, uint256[2] calldata _pA,' +
    ' uint256[2][2] calldata _pB, uint256[2] calldata _pC,' +
    ' uint256[3] calldata _pubSignals) external returns (uint256)',
  'function getModelHistory(uint256 _modelId) view returns' +
    ' (tuple(uint256,uint256,uint8,string,uint256,address,bytes32,bytes32)[])',
  'function verifyChain(uint256 _modelId) view returns (bool)',
  'function modelChainHead(uint256 _modelId) view returns (bytes32)',
  'function modelBlacklist(uint256 _modelId) view returns (bool)',
  'function nullifierUsed(uint256 _nullifier) view returns (bool)',
  'function computeStatementHash(string calldata _canonicalMetadata) view returns (uint256)',
  'event RecordAdded(uint256 indexed recordId,uint256 indexed modelId,uint8 indexed eventType,address operator)'
];

const MAL_ABI = [
  'event AuditEntryAdded(uint256 indexed entryId,uint8 indexed action,address indexed actor,uint256 targetId)'
];

const VERIFIER_ABI = [
  'function verifyProof(uint256[2] calldata _pA, uint256[2][2] calldata _pB,' +
    ' uint256[2] calldata _pC, uint256[3] calldata _pubSignals) view returns (bool)'
];

const SIGNATURE_PT_ABI = [
  'function addSignedRecord(uint256 _modelId,uint8 _eventType,string calldata _canonicalMetadata,uint256 _nonce,bytes calldata _signature) returns (uint256)',
  'function nonceUsed(uint256 _nonce) view returns (bool)',
  'function registry() view returns (address)',
  'event RecordAdded(uint256 indexed recordId,uint256 indexed modelId,uint8 eventType,address indexed operator)',
  'event SubmissionAuthorised(uint256 indexed modelId,address indexed signer,uint256 nonce,uint256 statementHash)'
];

const EIP712_TYPES = {
  ProvenanceSubmission: [
    { name: 'modelId', type: 'uint256' },
    { name: 'eventType', type: 'uint8' },
    { name: 'statementHash', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }
  ]
};

function getSignatureContract(chain, signer = null) {
  const selected = chains[chain];
  const address = selected?.addr?.contracts?.SignatureGatedProvenanceTracker;
  if (!selected || !address) {
    const error = new Error(`Chain ${chain} is not configured for EIP-712 provenance`);
    error.statusCode = 503;
    throw error;
  }
  return new ethers.Contract(address, SIGNATURE_PT_ABI, signer || selected.provider);
}

async function buildEip712Domain(chain) {
  const selected = chains[chain];
  const contract = getSignatureContract(chain);
  const network = await selected.provider.getNetwork();
  return {
    contract,
    domain: {
      name: 'ModelProvenance',
      version: '1',
      chainId: Number(network.chainId),
      verifyingContract: await contract.getAddress()
    }
  };
}

function getContracts(chain) {
  const c = chains[chain];
  if (!c || !c.addr?.contracts) {
    const error = new Error(`Chain ${chain} is not configured`);
    error.statusCode = 503;
    throw error;
  }
  const a = c.addr.contracts;
  const reader = c.wallet || c.provider;
  if (!reader) {
    const error = new Error(`Chain ${chain} has no available provider`);
    error.statusCode = 503;
    throw error;
  }
  const provenanceAddress = a.ZKProvenanceTracker || a.ModelProvenanceTracker;
  if (!provenanceAddress) {
    const error = new Error(`Chain ${chain} is missing a provenance tracker address`);
    error.statusCode = 503;
    throw error;
  }
  return {
    mr: new ethers.Contract(a.ModelRegistry, MR_ABI, reader),
    mac: new ethers.Contract(a.ModelAccessControl, MAC_ABI, reader),
    mpt: new ethers.Contract(provenanceAddress, ZKPT_ABI, reader),
    mal: new ethers.Contract(a.ModelAuditLog, MAL_ABI, reader),
    verifier: a.Groth16Verifier ? new ethers.Contract(a.Groth16Verifier, VERIFIER_ABI, reader) : null,
    provenanceAddress,
    provenanceMode: a.ZKProvenanceTracker ? 'verifier-gated' : 'legacy'
  };
}

function requireWriteChain(chain) {
  const selected = chains[chain];
  if (!selected) {
    const error = new Error(`Invalid chain: ${chain}`);
    error.statusCode = 400;
    throw error;
  }
  if (!selected.wallet) {
    const error = new Error(`Chain ${chain} is running in read-only mode because PRIVATE_KEY is not configured`);
    error.statusCode = 503;
    throw error;
  }
  return selected;
}

async function getChainStatus(chain) {
  const c = chains[chain];
  const knownModels = getKnownModels(chain);
  const contracts = c.addr?.contracts || {};
  const payload = {
    blockNumber: null,
    connected: false,
    balance: null,
    knownModels: knownModels.length,
    zkEnforced: Boolean(contracts.ZKProvenanceTracker && contracts.Groth16Verifier),
    provenanceMode: contracts.ZKProvenanceTracker ? 'verifier-gated' : 'legacy'
  };

  try {
    payload.blockNumber = await c.provider.getBlockNumber();
    payload.connected = true;
  } catch (error) {
    payload.error = `RPC unavailable: ${error.message}`;
    return payload;
  }

  if (c.wallet) {
    try {
      const balance = await c.provider.getBalance(c.wallet.address);
      payload.balance = ethers.formatEther(balance);
      payload.walletAddress = c.wallet.address;
    } catch (error) {
      payload.balance = null;
      payload.balanceError = error.message;
    }
  } else {
    payload.balance = 'read-only';
  }

  return payload;
}

const ACTION_MAP = {
  REGISTERED: 0,
  ACTIVATED: 1,
  UPDATED: 2,
  TRAINING_COMPLETED: 2,
  DEPRECATED: 3,
  REVOKED: 4,
  VERSION_RELEASED: 5,
  TRANSFERRED: 6,
  STAKED: 7,
  UNSTAKED: 8,
  SLASHED: 9,
  ZK_PROOF_VERIFIED: 10
};

function getStatusName(status) {
  return ['REGISTERED', 'ACTIVE', 'DEPRECATED', 'REVOKED'][Number(status)] || 'UNKNOWN';
}

function getKnownModels(chain) {
  const chainEntry = modelIndex.chains?.[chain];
  if (!chainEntry?.owners) {
    return [];
  }

  const deduplicated = new Map();
  for (const [ownerKey, bucket] of Object.entries(chainEntry.owners)) {
    for (const [modelNameKey, record] of Object.entries(bucket || {})) {
      const numericId = Number(record?.id);
      if (!Number.isInteger(numericId) || numericId <= 0) continue;

      const dedupeKey = `${chain}:${numericId}`;
      if (deduplicated.has(dedupeKey)) continue;

      deduplicated.set(dedupeKey, {
        chain,
        id: numericId,
        name: record?.name || modelNameKey,
        ownerKey,
        indexedOwner: tryNormalizeWalletAddress(record?.owner) || (ownerKey === LEGACY_OWNER_KEY ? null : ownerKey),
        createdAt: record?.createdAt || null
      });
    }
  }

  return Array.from(deduplicated.values());
}

function findKnownModelById(chain, id) {
  return getKnownModels(chain).find((entry) => Number(entry.id) === Number(id)) || null;
}

function buildIndexedModelFallbackSummary(chain, entry) {
  return {
    id: String(entry.id),
    numericId: entry.id,
    name: entry.name,
    description: 'Indexed by the backend-managed registry cache. On-chain status could not be refreshed for this request.',
    chain,
    owner: entry.indexedOwner || null,
    status: 'INDEXED',
    isActive: false,
    staked: false,
    rpcRefreshFailed: true
  };
}

async function getModelOwnerOrNull(contract, modelId) {
  const owner = await contract.getModelOwner(modelId);
  return owner === ethers.ZeroAddress ? null : owner;
}

function pickContracts(contractSet = {}, keys = []) {
  return keys.reduce((accumulator, key) => {
    if (contractSet[key]) {
      accumulator[key] = contractSet[key];
    }
    return accumulator;
  }, {});
}

async function buildStatusPayload() {
  refreshUserStoreFromDisk();
  const chainsPayload = {};
  let totalModels = 0;
  const contractsPayload = {};
  const optionalExtensionsPayload = {};
  let zkEnforced = true;

  for (const chain of ['sepolia', 'tbnb']) {
    const knownModels = getKnownModels(chain);
    totalModels += knownModels.length;
    chainsPayload[chain] = await getChainStatus(chain);
    const chainContracts = addrs?.[chain]?.contracts || {};
    contractsPayload[chain] = pickContracts(chainContracts, [
      'ModelAccessControl',
      'ModelRegistry',
      'Groth16Verifier',
      'ZKProvenanceTracker',
      'ModelAuditLog'
    ]);
    optionalExtensionsPayload[chain] = pickContracts(chainContracts, [
      'ModelProvenanceTracker',
      'ModelNFT',
      'ModelStaking',
      'RealZKBridge',
      'Verifier'
    ]);
    if (!contractsPayload[chain]?.ZKProvenanceTracker || !contractsPayload[chain]?.Groth16Verifier) {
      zkEnforced = false;
    }
  }

  return {
    chains: chainsPayload,
    contracts: contractsPayload,
    optionalExtensions: optionalExtensionsPayload,
    totalModels,
    totalAudits: totalModels,
    zkReady: zkEnforced,
    zkEnforced,
    inventoryMode: 'backend-index',
    inventoryScope: 'owner-scoped-known-models',
    authStoreMode: 'stateful-file-store',
    authStoreVersion: userStore.version,
    jwtSecretMode: JWT_SECRET_MODE,
    authLockoutPolicy: {
      threshold: AUTH_LOCKOUT_THRESHOLD,
      durationSeconds: AUTH_LOCKOUT_DURATION_SECONDS
    },
    authMode: 'jwt',
    relayMode: pk ? 'relay-enabled' : 'read-only',
    warnings: bootWarnings
  };
}

async function getModelSummary(chain, entry) {
  const { mr } = getContracts(chain);
  try {
    const owner = await getModelOwnerOrNull(mr, entry.id);
    if (!owner) {
      return {
        id: String(entry.id),
        numericId: entry.id,
        name: entry.name,
        description: 'Indexed by the backend-managed registry cache.',
        chain,
        owner: null,
        status: 'PENDING_REGISTRATION',
        isActive: false,
        staked: false,
        pending: true
      };
    }

    if (owner) {
      migrateIndexedModelOwner(chain, entry, owner);
    }

    const [status, staked] = await Promise.all([
      mr.getModelStatus(entry.id),
      mr.isModelStaked(entry.id)
    ]);
    return {
      id: String(entry.id),
      numericId: entry.id,
      name: entry.name,
      description: 'Indexed by the backend-managed registry cache.',
      chain,
      owner,
      status: getStatusName(status),
      isActive: Number(status) === 1,
      staked
    };
  } catch (error) {
    console.log(`[MODELS] Summary refresh failed for ${chain} #${entry.id}: ${error.message.slice(0, 80)}`);
    return buildIndexedModelFallbackSummary(chain, entry);
  }
}

// Health and status

app.get('/api/health', (req, res) => {
  ok(res, {
    status: bootWarnings.length === 0 ? 'ok' : 'degraded',
    timestamp: Date.now(),
    jwtSecretMode: JWT_SECRET_MODE,
    warnings: bootWarnings
  });
});

app.get('/api/v2/status', handle(async (req, res) => {
  ok(res, await buildStatusPayload());
}));

app.get('/api/status', handle(async (req, res) => {
  ok(res, await buildStatusPayload());
}));

app.post('/api/auth/login', handle(async (req, res) => {
  const username = requireString(req.body?.username, 'username', { maxLength: 64 }).toLowerCase();
  const password = requireString(req.body?.password, 'password', { maxLength: 256 });

  const user = findUserByUsername(username);
  if (!user) {
    return sendError(res, 'Invalid username or password', 401);
  }

  if (user.status !== 'active') {
    return sendError(res, 'User account is disabled', 403);
  }

  if (isUserLocked(user)) {
    return sendError(res, `User account is temporarily locked until ${user.lockedUntil}`, 423);
  }

  if (!verifyPassword(password, user.passwordHash)) {
    markFailedLogin(username);
    return sendError(res, 'Invalid username or password', 401);
  }

  const authenticatedUser = markSuccessfulLogin(username) || user;
  const session = issueSessionForUser(authenticatedUser);
  ok(res, session);
}));

app.get('/api/auth/me', requireAuth, handle(async (req, res) => {
  ok(res, {
    user: buildPublicUser(req.auth)
  });
}));

app.get('/api/admin/users', requireAuth, requireRole('admin'), handle(async (req, res) => {
  ok(res, {
    users: listPublicUsers()
  });
}));

app.post('/api/admin/users', requireAuth, requireRole('admin'), handle(async (req, res) => {
  const user = createLocalUser({
    username: req.body?.username,
    password: req.body?.password,
    walletAddress: req.body?.walletAddress || req.body?.wallet,
    role: req.body?.role || 'researcher',
    status: req.body?.status || 'active'
  });

  res.status(201).json({
    success: true,
    user
  });
}));

app.patch('/api/admin/users/:username', requireAuth, requireRole('admin'), handle(async (req, res) => {
  const updatedUser = updateLocalUser(req.params.username, req.body || {}, {
    requestedBy: req.auth.username
  });

  ok(res, {
    user: updatedUser
  });
}));

app.delete('/api/admin/users/:username', requireAuth, requireRole('admin'), handle(async (req, res) => {
  const deletedUser = deleteLocalUser(req.params.username, {
    requestedBy: req.auth.username
  });

  ok(res, {
    user: deletedUser
  });
}));

// Audit events

app.get('/api/v2/audit/recent', handle(async (req, res) => {
  const chain = req.query.chain || 'sepolia';
  if (!chains[chain]) return sendError(res, `Invalid chain: ${chain}`, 400);
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);

  const { mal } = getContracts(chain);
  const addr = chains[chain].addr.contracts.ModelAuditLog;
  const currentBlock = await chains[chain].provider.getBlockNumber();
  const fromBlock = Math.max(currentBlock - 50, 1);

  let logs = [];
  try {
    logs = await chains[chain].provider.getLogs({ address: addr, fromBlock, toBlock: currentBlock });
  } catch (error) {
    console.log(`[AUDIT] Fetch error: ${error.message.slice(0, 80)}`);
  }

  const events = logs
    .map((log) => {
      try {
        const parsed = mal.interface.parseLog(log);
        return {
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          contractAddress: log.address,
          event: parsed.name,
          args: Object.fromEntries(parsed.args.map((value, index) => [index, String(value)]))
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(-limit);

  ok(res, { events, blockRange: { from: fromBlock, to: currentBlock } });
}));

app.get('/api/v2/audit/verify/:id', handle(async (req, res) => {
  const chain = req.query.chain || 'sepolia';
  if (!chains[chain]) return sendError(res, `Invalid chain: ${chain}`, 400);
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id <= 0) return sendError(res, 'Invalid model ID', 400);

  const { mpt } = getContracts(chain);
  const history = await mpt.getModelHistory(id);
  const chainVerified = await mpt.verifyChain(id);
  ok(res, {
    modelId: id,
    chain,
    chainVerified,
    recordCount: history.length,
    latestRecord: history.length > 0 ? history[history.length - 1] : null
  });
}));

app.post('/api/audit', handle(async (req, res) => {
  const { modelId, chain } = req.body;
  if (!modelId) return sendError(res, 'modelId is required', 400);
  const targetChain = chain || 'sepolia';
  if (!chains[targetChain]) return sendError(res, `Invalid chain: ${targetChain}`, 400);

  const id = requirePositiveInt(modelId, 'modelId');

  const { mpt } = getContracts(targetChain);
  const history = await mpt.getModelHistory(id);
  const chainVerified = await mpt.verifyChain(id);
  ok(res, {
    modelId: id,
    chain: targetChain,
    chainVerified,
    recordCount: history.length
  });
}));

// Models

app.get('/api/v2/models/resolve', handle(async (req, res) => {
  const chain = requireString(req.query.chain || 'sepolia', 'chain', { maxLength: 64 });
  if (!chains[chain]) return sendError(res, `Invalid chain: ${chain}`, 400);

  const owner = normalizeWalletAddress(requireString(req.query.owner, 'owner', { maxLength: 128 }), 'owner');
  const modelName = requireString(req.query.name || req.query.modelName, 'name', { maxLength: 256 });
  let entry = findIndexedModel(chain, owner, modelName);

  if (!entry) {
    const legacyEntry = findIndexedModel(chain, null, modelName);
    if (legacyEntry) {
      const { mr } = getContracts(chain);
      const actualOwner = await getModelOwnerOrNull(mr, legacyEntry.id);
      if (actualOwner && actualOwner === owner) {
        migrateIndexedModelOwner(chain, legacyEntry, actualOwner);
        entry = findIndexedModel(chain, owner, modelName);
      }
    }
  }

  if (!entry) {
    return sendError(res, `No indexed model named '${modelName}' was found for owner ${owner} on ${chain}`, 404);
  }

  const summary = await getModelSummary(chain, entry);
  if (!summary) {
    return sendError(res, 'Indexed model no longer resolves on-chain', 404);
  }
  if (summary.owner && summary.owner !== owner) {
    return sendError(res, `Model '${modelName}' is not owned by ${owner} on ${chain}`, 404);
  }

  ok(res, {
    resolutionMode: 'owner-scoped-backend-index',
    model: summary
  });
}));

app.get('/api/v2/models/:id', handle(async (req, res) => {
  const chain = req.query.chain || 'sepolia';
  if (!chains[chain]) return sendError(res, `Invalid chain: ${chain}`, 400);
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id) || id <= 0) return sendError(res, 'Invalid model ID', 400);

  const { mr } = getContracts(chain);
  try {
    const owner = await getModelOwnerOrNull(mr, id);
    if (!owner) {
      return sendError(res, 'Model not found', 404);
    }

    const status = await mr.getModelStatus(id);
    const staked = await mr.isModelStaked(id);
    ok(res, {
      id,
      chain,
      owner,
      status: getStatusName(status),
      isActive: Number(status) === 1,
      staked
    });
  } catch (error) {
    const indexedEntry = findKnownModelById(chain, id);
    if (!indexedEntry) {
      throw error;
    }
    console.log(`[MODELS] Detail refresh failed for ${chain} #${id}: ${error.message.slice(0, 80)}`);
    ok(res, buildIndexedModelFallbackSummary(chain, indexedEntry));
  }
}));

app.get('/api/v2/models', handle(async (req, res) => {
  const requestedChain = req.query.chain;
  const chainList = requestedChain ? [requestedChain] : ['sepolia', 'tbnb'];

  for (const chain of chainList) {
    if (!chains[chain]) return sendError(res, `Invalid chain: ${chain}`, 400);
  }

  const groupedModels = await Promise.all(chainList.map(async (chain) => {
    const entries = getKnownModels(chain);
    const summaries = await Promise.all(entries.map((entry) => getModelSummary(chain, entry)));
    return summaries.filter(Boolean);
  }));

  const models = groupedModels.flat();

  ok(res, {
    inventoryMode: 'backend-index',
    inventoryScope: 'owner-scoped-known-models',
    isCompleteInventory: false,
    models
  });
}));

app.get('/api/models', handle(async (req, res) => {
  const requestedChain = req.query.chain;
  const chainList = requestedChain ? [requestedChain] : ['sepolia', 'tbnb'];
  const models = [];
  for (const chain of chainList) {
    if (!chains[chain]) return sendError(res, `Invalid chain: ${chain}`, 400);
    const entries = getKnownModels(chain);
    for (const entry of entries) {
      const summary = await getModelSummary(chain, entry);
      if (summary) models.push(summary);
    }
  }
  ok(res, {
    inventoryMode: 'backend-index',
    inventoryScope: 'owner-scoped-known-models',
    isCompleteInventory: false,
    models
  });
}));

app.post('/api/v2/lifecycle/query', requireAuth, handle(async (req, res) => {
  const secret = requireString(req.body?.secret, 'secret', { maxLength: 512 });
  const match = findSeriesBySecret(secret);

  if (!match) {
    return sendError(res, 'No lifecycle found for this secret', 404);
  }

  const versions = await Promise.all(
    (match.entry?.versions || []).map((versionEntry) => enrichLifecycleVersion(versionEntry))
  );

  ok(res, {
    series: match.seriesName,
    storageMode: match.storageMode,
    createdAt: match.entry?.created_at || null,
    versions
  });
}));

app.post('/api/v2/lifecycle/download', requireAuth, handle(async (req, res) => {
  const secret = requireString(req.body?.secret, 'secret', { maxLength: 512 });
  const modelHash = requireString(req.body?.modelHash, 'modelHash', { maxLength: 128 });
  const match = findSeriesBySecret(secret);

  if (!match) {
    return sendError(res, 'No lifecycle found for this secret', 404);
  }

  const versionEntry = (match.entry?.versions || []).find(
    (item) => String(item?.model_hash) === String(modelHash)
  );
  if (!versionEntry) {
    return sendError(res, 'Requested version was not found for this secret', 404);
  }

  const enriched = await enrichLifecycleVersion(versionEntry);
  if (enriched.ipfsCid) {
    const binary = await fetchIpfsBinary(enriched.ipfsCid);
    if (!binary) {
      return sendError(res, 'Failed to fetch model artifact from IPFS gateways', 502);
    }

    const filename = enriched.artifactFileName || buildLifecycleFilename(match.seriesName, versionEntry, null);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(binary);
  }

  return sendError(res, 'This version does not currently resolve to an IPFS artifact', 404);
}));

app.get('/api/v2/lifecycle', (req, res) => {
  sendError(res, 'Use POST /api/v2/lifecycle/query', 410);
});

app.get('/api/v2/lifecycle/download', (req, res) => {
  sendError(res, 'Use POST /api/v2/lifecycle/download', 410);
});

// Provenance tracking

app.get('/api/sdk/eip712/config', requireAuth, handle(async (req, res) => {
  const targetChain = requireString(req.query.chain || 'sepolia', 'chain', { maxLength: 64 });
  if (!chains[targetChain]) return sendError(res, `Invalid chain: ${targetChain}`, 400);
  const modelId = requirePositiveInt(req.query.modelId, 'modelId');
  const { mr } = getContracts(targetChain);
  const owner = await getModelOwnerOrNull(mr, modelId);
  if (!owner) return sendError(res, `Model ${modelId} is not registered on ${targetChain}`, 404);
  if (owner !== req.auth.walletAddress) {
    return sendError(res, `Authenticated submitter does not own model ${modelId}`, 403);
  }
  const { domain } = await buildEip712Domain(targetChain);
  ok(res, { chain: targetChain, domain, types: EIP712_TYPES, owner });
}));

app.post('/api/sdk/provenance/eip712', requireAuth, handle(async (req, res) => {
  const modelId = requirePositiveInt(req.body.modelId, 'modelId');
  const modelName = requireString(req.body.modelName, 'modelName', { maxLength: 256 });
  const targetChain = requireString(req.body.chain || 'sepolia', 'chain', { maxLength: 64 });
  if (!chains[targetChain]) return sendError(res, `Invalid chain: ${targetChain}`, 400);
  const { canonicalMetadata, parsed: parsedMetadata } = parseCanonicalMetadataOrThrow(req.body.canonicalMetadata);
  validateCanonicalMetadataShape(parsedMetadata, { modelName, chain: targetChain });
  const nonce = parseBigNumberish(req.body.nonce, 'nonce');
  if (nonce < 0n || nonce >= 2n ** 256n) return sendError(res, 'nonce must be a uint256', 400);
  const signature = requireString(req.body.signature, 'signature', { maxLength: 132 });
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return sendError(res, 'signature must be 65 bytes', 400);

  const writableChain = requireWriteChain(targetChain);
  const { mr } = getContracts(targetChain);
  const owner = await getModelOwnerOrNull(mr, modelId);
  if (!owner) return sendError(res, `Model ${modelId} is not registered on ${targetChain}`, 404);
  if (owner !== req.auth.walletAddress) {
    return sendError(res, `Authenticated submitter does not own model ${modelId}`, 403);
  }
  const eventType = ACTION_MAP[parsedMetadata.action];
  if (eventType === undefined) return sendError(res, `Unsupported action: ${parsedMetadata.action}`, 400);
  const statementHash = computeStatementHash(canonicalMetadata);
  const { contract, domain } = await buildEip712Domain(targetChain);
  const message = { modelId, eventType, statementHash, nonce };
  let recovered;
  try {
    recovered = normalizeWalletAddress(ethers.verifyTypedData(domain, EIP712_TYPES, message, signature));
  } catch {
    return sendError(res, 'Invalid EIP-712 signature', 400);
  }
  if (recovered !== owner || recovered !== req.auth.walletAddress) {
    return sendError(res, 'EIP-712 signer does not match the authenticated registry owner', 403);
  }
  if (await contract.nonceUsed(nonce)) return sendError(res, 'EIP-712 nonce has already been used', 409);

  const writer = getSignatureContract(targetChain, writableChain.wallet);
  const tx = await writer.addSignedRecord(modelId, eventType, canonicalMetadata, nonce, signature);
  const receipt = await tx.wait();
  ok(res, {
    tx: tx.hash,
    blockNumber: receipt.blockNumber,
    modelId,
    eventType,
    owner: recovered,
    relay: writableChain.wallet.address,
    statementHash: statementHash.toString(),
    nonce: nonce.toString(),
    signatureVerified: true
  });
}));

app.post('/api/sdk/provenance', requireAuth, handle(async (req, res) => {
  const modelId = requirePositiveInt(req.body.modelId, 'modelId');
  const modelName = requireString(req.body.modelName, 'modelName', { maxLength: 256 });
  const targetChain = requireString(req.body.chain || 'sepolia', 'chain', { maxLength: 64 });
  if (!chains[targetChain]) return sendError(res, `Invalid chain: ${targetChain}`, 400);
  const { canonicalMetadata, parsed: parsedMetadata } = parseCanonicalMetadataOrThrow(req.body.canonicalMetadata);
  validateCanonicalMetadataShape(parsedMetadata, { modelName, chain: targetChain });
  const normalizedProof = normalizeZKProof(req.body.zkProof);

  const writableChain = requireWriteChain(targetChain);
  const { mr, mpt, provenanceMode } = getContracts(targetChain);
  if (provenanceMode !== 'verifier-gated') {
    return sendError(res, `Chain ${targetChain} is not configured for verifier-gated provenance`, 503);
  }
  const mrWriter = mr.connect(writableChain.wallet);
  const mptWriter = mpt.connect(writableChain.wallet);

  const owner = await getModelOwnerOrNull(mr, modelId);
  if (!owner) {
    return sendError(res, `Model ${modelId} is not registered on ${targetChain}`, 404);
  }
  if (owner !== req.auth.walletAddress) {
    return sendError(res, `Authenticated submitter does not own model ${modelId}`, 403);
  }

  const eventType = ACTION_MAP[parsedMetadata.action];
  if (eventType === undefined) {
    return sendError(res, `Unsupported action: ${parsedMetadata.action}`, 400);
  }

  const statementHash = computeStatementHash(canonicalMetadata);
  const nullifier = normalizedProof.publicSignals[0];
  const signalModelId = normalizedProof.publicSignals[1];
  const signalStatementHash = normalizedProof.publicSignals[2];

  if (signalModelId !== BigInt(modelId)) {
    return sendError(res, 'zkProof.publicSignals[1] does not match modelId', 400);
  }

  if (signalStatementHash !== statementHash) {
    return sendError(res, 'zkProof.publicSignals[2] does not match canonicalMetadata statementHash', 400);
  }

  const tx = await mptWriter.addVerifiedRecord(
    modelId,
    eventType,
    canonicalMetadata,
    normalizedProof.pA,
    normalizedProof.pB,
    normalizedProof.pC,
    normalizedProof.publicSignals.map((value) => value.toString())
  );
  await tx.wait();
  ok(res, {
    tx: tx.hash,
    modelId,
    eventType,
    owner,
    statementHash: statementHash.toString(),
    nullifier: nullifier.toString(),
    proofVerified: true
  });
}));

app.post('/api/register', requireAuth, handle(async (req, res) => {
  const { name, description, ipfsCid, checksum, framework, license, chain } = req.body;
  const modelName = requireString(name, 'name', { maxLength: 256 });

  const targetChain = chain || 'sepolia';
  if (!chains[targetChain]) return sendError(res, `Invalid chain: ${targetChain}`, 400);
  const writableChain = requireWriteChain(targetChain);
  const owner = req.auth.walletAddress;

  const { mr } = getContracts(targetChain);
  let existingEntry = findIndexedModel(targetChain, owner, modelName);
  if (!existingEntry) {
    const legacyEntry = findIndexedModel(targetChain, null, modelName);
    if (legacyEntry) {
      const actualOwner = await getModelOwnerOrNull(mr, legacyEntry.id);
      if (actualOwner && actualOwner === owner) {
        migrateIndexedModelOwner(targetChain, legacyEntry, actualOwner);
        existingEntry = findIndexedModel(targetChain, owner, modelName);
      }
    }
  }

  if (existingEntry) {
    const existingOwner = await getModelOwnerOrNull(mr, existingEntry.id);
    if (existingOwner === owner) {
      return ok(res, {
        id: String(existingEntry.id),
        numericId: existingEntry.id,
        name: modelName,
        description: description || '',
        chain: targetChain,
        owner: existingOwner,
        isActive: false,
        existing: true
      });
    }

    if (!existingOwner) {
      return ok(res, {
        id: String(existingEntry.id),
        numericId: existingEntry.id,
        name: modelName,
        description: description || '',
        chain: targetChain,
        owner: null,
        isActive: false,
        existing: true,
        pending: true
      });
    }

    removeIndexedModel(targetChain, owner, modelName);
  }

  const writer = mr.connect(writableChain.wallet);
  const registrationArgs = [
    owner,
    modelName,
    requireString(description, 'description', { optional: true, maxLength: 2048 }) || '',
    requireString(ipfsCid, 'ipfsCid', { optional: true, maxLength: 256 }) || '',
    requireString(checksum, 'checksum', { optional: true, maxLength: 256 }) || '',
    requireString(framework, 'framework', { optional: true, maxLength: 128 }) || 'PyTorch',
    requireString(license, 'license', { optional: true, maxLength: 128 }) || 'MIT'
  ];

  const predictedModelId = Number(await writer.registerModelFor.staticCall(...registrationArgs));
  const tx = await writer.registerModelFor(...registrationArgs);
  await tx.wait();

  upsertModelIndexEntry(modelIndex, {
    chain: targetChain,
    owner,
    modelName,
    modelId: predictedModelId
  });
  saveModelIndex(modelIndex);

  ok(res, {
    id: String(predictedModelId),
    numericId: predictedModelId,
    name: modelName,
    description: description || '',
    chain: targetChain,
    owner,
    isActive: false,
    pending: true,
    txHash: tx.hash
  });
}));

// IPFS

app.post('/api/ipfs/upload/file', requireAuth, handle(async (req, res) => {
  const { data, fileName } = req.body;
  if (!data) return sendError(res, 'Missing data field', 400);
  requireString(fileName, 'fileName', { optional: true, maxLength: 256 });

  const apiKey = process.env.PINATA_API_KEY;
  const apiSecret = process.env.PINATA_SECRET;
  if (!apiKey || !apiSecret) {
    return sendError(res, 'Pinata credentials not configured', 503);
  }

  const buf = Buffer.from(data, 'base64');
  const formData = new FormData();
  formData.append('file', buf, { filename: fileName || 'file' });

  const headers = {
    ...formData.getHeaders(),
    pinata_api_key: apiKey,
    pinata_secret_api_key: apiSecret
  };

  const resp = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', formData, {
    headers,
    timeout: 15000
  });
  const cid = resp.data.IpfsHash;
  ok(res, { cid, gatewayUrl: `https://gateway.pinata.cloud/ipfs/${cid}` });
}));

app.post('/api/ipfs/upload/metadata', requireAuth, handle(async (req, res) => {
  const { metadata } = req.body;
  if (!metadata) return sendError(res, 'Missing metadata field', 400);
  requirePlainObject(metadata, 'metadata');

  const apiKey = process.env.PINATA_API_KEY;
  const apiSecret = process.env.PINATA_SECRET;
  if (!apiKey || !apiSecret) {
    return sendError(res, 'Pinata credentials not configured', 503);
  }

  const resp = await axios.post(
    'https://api.pinata.cloud/pinning/pinJSONToIPFS',
    { pinataContent: metadata, pinataMetadata: { name: 'metadata' } },
    {
      headers: { pinata_api_key: apiKey, pinata_secret_api_key: apiSecret },
      timeout: 15000
    }
  );

  const cid = resp.data.IpfsHash;
  ok(res, { cid, gatewayUrl: `https://gateway.pinata.cloud/ipfs/${cid}` });
}));

app.get('/api/ipfs/cat/:cid', handle(async (req, res) => {
  const { cid } = req.params;
  if (!cid) return sendError(res, 'Missing CID', 400);

  const gateways = [
    `https://gateway.pinata.cloud/ipfs/${cid}`,
    `https://ipfs.io/ipfs/${cid}`
  ];

  for (const url of gateways) {
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
      return ok(res, { content: Buffer.from(response.data).toString('base64') });
    } catch {}
  }

  return sendError(res, 'Failed to fetch from all gateways', 502);
}));

// Global handlers

app.use((req, res) => {
  sendError(res, `Route not found: ${req.method} ${req.path}`, 404);
});

app.use((error, req, res, next) => {
  console.error('[UNHANDLED ERROR]', error.message);
  if (!error.isOperational) {
    console.error(error.stack);
  }
  sendError(res, 'Internal server error', 500);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on port', PORT));
