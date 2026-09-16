import type { ActivityImport, AddonContext } from '@wealthfolio/addon-sdk';

export type BunqConfig = {
  baseUrl: 'https://api.bunq.com' | 'https://public-api.sandbox.bunq.com';
  userApiKeyId: string;
  autoAddNewAccounts?: boolean;
};

export type BunqAccountSettings = {
  sync: boolean;
  expenseCategory?: string;
  incomeCategory?: string;
};

export type BunqMonetaryAccount = {
  id: number;
  accountType?: string;
  description?: string;
  currency?: string;
  balance?: { value?: string; currency?: string };
  alias?: Array<{ type?: string; value?: string }>;
};

export type BunqPayment = {
  id: number;
  created?: string;
  updated?: string;
  amount?: { value?: string; currency?: string };
  description?: string;
  type?: string;
  status?: string;
  counterparty_alias?: { value?: string; name?: string; merchant_category_code?: string | number };
  alias?: { iban?: string; display_name?: string; merchant_category_code?: string };
  merchant?: { name?: string; city?: string; country?: string };
  merchant_name?: string;
  merchant_city?: string;
  merchant_country?: string;
  mcc?: string | number;
  merchant_category_code?: string | number;
  category?: string;
  category_name?: string;
  category_description?: string;
  transaction_category?: string | { category?: string; name?: string; description?: string };
  additional_transaction_information?: { category?: string; name?: string; description?: string };
};

type BunqResponse = { body: string; status: number; headers?: Record<string, string> };
type BunqEnvelope = {
  Response?: Array<Record<string, unknown>>;
  Pagination?: { future_url?: string | null };
};
const API_KEY_SECRET = 'bunq-api-key';
const INSTALLATION_SECRET = 'bunq-installation-token';
const PRIVATE_KEY_SECRET = 'bunq-private-key-jwk';
const SESSION_SECRET = 'bunq-session-token';
const ACCOUNT_SETTINGS_STORAGE_KEY = 'account-settings';

const request = async (ctx: AddonContext, config: BunqConfig, path: string, options: {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
} = {}): Promise<BunqResponse> => {
  return ctx.api.network.request({
    url: path.startsWith('http') ? path : `${config.baseUrl}/v1${path}`,
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'wealthfolio-addon-bunq/0.1.0',
      'X-Bunq-Language': 'en_US',
      'X-Bunq-Client-Request-Id': crypto.randomUUID(),
      'X-Bunq-Geolocation': '0 0 0 0 NL',
      'Cache-Control': 'no-cache',
      ...options.headers
    },
    body: options.body
  });
};

const base64 = (bytes: ArrayBuffer) => {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const pem = (bytes: ArrayBuffer) => `-----BEGIN PUBLIC KEY-----\n${base64(bytes).match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;

const jsonResponse = (response: BunqResponse): BunqEnvelope => {
  if (response.status === 429) {
    const retryAfter = response.headers?.['retry-after'];
    throw new Error(`bunq rate limit bereikt${retryAfter ? `; probeer opnieuw over ${retryAfter}s` : ''}`);
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`bunq request failed (${response.status})`);
  return JSON.parse(response.body) as BunqEnvelope;
};

const responseValue = (data: BunqEnvelope, key: string) => {
  const item = data.Response?.find((entry) => key in entry);
  return item?.[key] as Record<string, unknown> | undefined;
};

const extractAccounts = (data: BunqEnvelope): BunqMonetaryAccount[] => {
  const found: BunqMonetaryAccount[] = [];
  for (const entry of data.Response ?? []) {
    for (const value of Object.values(entry)) {
      if (typeof value !== 'object' || value === null) continue;
      const candidate = value as Partial<BunqMonetaryAccount>;
      if (typeof candidate.id !== 'number') continue;
      found.push(candidate as BunqMonetaryAccount);
    }
  }
  return found;
};

const normalizePath = (value: string) => value.startsWith('http') ? value : value.replace(/^\/v1/, '');

const requestWithRetry = async (ctx: AddonContext, config: BunqConfig, path: string, options: Parameters<typeof request>[3] = {}) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await request(ctx, config, path, options);
    } catch (error) {
      if (attempt === 3) throw error;
      ctx.api.logger.warn(`bunq request retry ${attempt}/2 for ${path}: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  throw new Error('bunq request retry failed');
};

const fetchAccountEndpoint = async (ctx: AddonContext, config: BunqConfig, sessionToken: string, endpoint: string) => {
  const accounts: BunqMonetaryAccount[] = [];
  let path = `/user/${encodeURIComponent(config.userApiKeyId)}/${endpoint}`;
  const visited = new Set<string>();
  for (let page = 1; path && page <= 100; page += 1) {
    if (visited.has(path)) break;
    visited.add(path);
    const data = jsonResponse(await requestWithRetry(ctx, config, path, { headers: { 'X-Bunq-Client-Authentication': sessionToken } }));
    accounts.push(...extractAccounts(data));
    if (!data.Response?.length) break;
    path = normalizePath(data.Pagination?.future_url ?? '');
  }
  return accounts;
};

const signedPost = async (ctx: AddonContext, config: BunqConfig, path: string, body: Record<string, unknown>, token: string, key: CryptoKey) => {
  const payload = JSON.stringify(body);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(payload));
  return request(ctx, config, path, {
    method: 'POST',
    body: payload,
    headers: {
      'Content-Type': 'application/json',
      'X-Bunq-Client-Authentication': token,
      'X-Bunq-Client-Signature': base64(signature)
    }
  });
};

export async function authenticate(ctx: AddonContext, baseUrl: BunqConfig['baseUrl'], apiKey: string): Promise<BunqConfig> {
  const config = { baseUrl, userApiKeyId: '' } satisfies BunqConfig;
  const storedJwk = await ctx.api.secrets.get(PRIVATE_KEY_SECRET);
  const storedInstallationToken = await ctx.api.secrets.get(INSTALLATION_SECRET);
  let key: CryptoKey;
  let installationToken = storedInstallationToken;
  let fresh = false;

  if (storedJwk && storedInstallationToken) {
    key = await crypto.subtle.importKey('jwk', JSON.parse(storedJwk) as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    key = pair.privateKey;
    const publicKey = await crypto.subtle.exportKey('spki', pair.publicKey);
    const installation = jsonResponse(await request(ctx, config, '/installation', { method: 'POST', body: JSON.stringify({ client_public_key: pem(publicKey) }), headers: { 'Content-Type': 'application/json' } }));
    installationToken = String(responseValue(installation, 'Token')?.token ?? '');
    if (!installationToken) throw new Error('bunq installation response missing token');
    await signedPost(ctx, config, '/device-server', { description: 'wealthfolio-bunq-addon', secret: apiKey, permitted_ips: [] }, installationToken, key).then(jsonResponse);
    fresh = true;
  }

  const session = jsonResponse(await signedPost(ctx, config, '/session-server', { secret: apiKey }, installationToken!, key));
  const sessionToken = String(responseValue(session, 'Token')?.token ?? '');
  const user = responseValue(session, 'UserPerson') ?? responseValue(session, 'UserCompany');
  const userApiKeyId = String(user?.id ?? '');
  if (!sessionToken || !userApiKeyId) throw new Error('bunq session response missing token or user id');

  await ctx.api.secrets.set(API_KEY_SECRET, apiKey);
  await ctx.api.secrets.set(SESSION_SECRET, sessionToken);
  if (fresh) {
    await ctx.api.secrets.set(INSTALLATION_SECRET, installationToken!);
    await ctx.api.secrets.set(PRIVATE_KEY_SECRET, JSON.stringify(await crypto.subtle.exportKey('jwk', key)));
  }
  const nextConfig = { baseUrl, userApiKeyId, autoAddNewAccounts: true } satisfies BunqConfig;
  await ctx.api.storage.set('config', JSON.stringify(nextConfig));
  return nextConfig;
}

export async function getMonetaryAccounts(ctx: AddonContext, config: BunqConfig) {
  const sessionToken = await ctx.api.secrets.get(SESSION_SECRET);
  if (!sessionToken) throw new Error('bunq session ontbreekt; verbind opnieuw');
  const endpoints = ['monetary-account', 'monetary-account-bank', 'monetary-account-savings', 'monetary-account-joint', 'monetary-account-external', 'monetary-account-external-savings', 'monetary-account-card'];
  const accounts = new Map<number, BunqMonetaryAccount>();
  for (const endpoint of endpoints) {
    try {
      const discovered = await fetchAccountEndpoint(ctx, config, sessionToken, endpoint);
      for (const account of discovered) accounts.set(account.id, { ...accounts.get(account.id), ...account, accountType: endpoint });
      ctx.api.logger.debug(`bunq ${endpoint}: ${discovered.length} account records`);
    } catch (error) {
      // Older bunq environments may not expose every typed endpoint. The
      // aggregate endpoint remains the source of truth in that case.
      ctx.api.logger.warn(`bunq ${endpoint} unavailable: ${String(error)}`);
    }
  }
  ctx.api.logger.info(`bunq account sync fetched ${accounts.size} unique accounts from aggregate and typed endpoints`);
  return [...accounts.values()];
}

const paymentType = (payment: BunqPayment): ActivityImport['activityType'] => {
  const type = payment.type?.toUpperCase();
  if (type === 'INTEREST') return 'INTEREST';
  if (type === 'FEE') return 'FEE';
  if (type === 'DEPOSIT') return 'DEPOSIT';
  if (type === 'TRANSFER') return Number(payment.amount?.value ?? 0) >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT';
  return Number(payment.amount?.value ?? 0) >= 0 ? 'CREDIT' : 'WITHDRAWAL';
};

const paymentDate = (value?: string) => value ? `${value.replace(' ', 'T')}Z` : new Date().toISOString();

export async function getPayments(ctx: AddonContext, config: BunqConfig, accountId: number) {
  const sessionToken = await ctx.api.secrets.get(SESSION_SECRET);
  if (!sessionToken) throw new Error('bunq session ontbreekt; verbind opnieuw');
  const payments: BunqPayment[] = [];
  const visited = new Set<string>();
  let path = `/user/${encodeURIComponent(config.userApiKeyId)}/monetary-account/${accountId}/payment?count=200`;
  let page = 0;
  do {
    if (visited.has(path)) {
      ctx.api.logger.warn(`bunq payment pagination repeated for account ${accountId}; stopping`);
      break;
    }
    visited.add(path);
    page += 1;
    if (page > 100) throw new Error(`bunq payment pagination exceeded 100 pages for account ${accountId}`);
    const data = jsonResponse(await requestWithRetry(ctx, config, path, { headers: { 'X-Bunq-Client-Authentication': sessionToken } }));
    for (const entry of data.Response ?? []) {
      const payment = entry.Payment as BunqPayment | undefined;
      if (payment && typeof payment.id === 'number') payments.push(payment);
    }
    ctx.api.logger.debug(`bunq payment page ${page} for account ${accountId}: ${data.Response?.length ?? 0} records, ${payments.length} payments total`);
    if (!data.Response?.length) break;
    const futureUrl = data.Pagination?.future_url;
    path = normalizePath(futureUrl ?? '');
  } while (path);
  const categorized = payments.filter((payment) => paymentCategory(payment)).length;
  ctx.api.logger.info(`bunq payment sync fetched ${payments.length} payments for account ${accountId}; ${categorized} contain a category`);
  return payments;
}

export function paymentActivity(payment: BunqPayment, wealthfolioAccountId: string, accountName: string, categoryOverride?: string): ActivityImport {
  const amount = Math.abs(Number(payment.amount?.value ?? 0));
  const currency = payment.amount?.currency ?? 'EUR';
  const merchant = payment.merchant;
  const counterparty = payment.counterparty_alias;
  const paymentId = String(payment.id);
  const category = categoryOverride ?? paymentCategory(payment);
  const activity = {
    accountId: wealthfolioAccountId,
    accountName,
    currency,
    activityType: paymentType(payment),
    date: paymentDate(payment.created),
    symbol: '',
    amount,
    quantity: 1,
    unitPrice: 1,
    isValid: true,
    isDraft: false,
    comment: `${payment.description ?? 'bunq payment'}${category ? ` [bunq-category:${category}]` : ''} [bunq-payment:${paymentId}]`,
    metadata: {
      sourceSystem: 'bunq',
      sourceRecordId: paymentId,
      bunqPaymentType: payment.type ?? '',
      bunqStatus: payment.status ?? '',
      counterpartyName: counterparty?.name ?? merchant?.name ?? '',
      counterpartyIban: counterparty?.value ?? '',
      merchantCity: payment.merchant_city ?? merchant?.city ?? '',
      merchantCountry: payment.merchant_country ?? merchant?.country ?? '',
      merchantCategoryCode: String(payment.mcc ?? payment.merchant_category_code ?? payment.alias?.merchant_category_code ?? payment.counterparty_alias?.merchant_category_code ?? ''),
      bunqCategory: category
    }
  } as ActivityImport;
  return activity;
}

export function paymentCategory(payment: BunqPayment): string {
  const value = payment.category ?? payment.category_name ?? payment.category_description ?? payment.transaction_category ?? payment.additional_transaction_information;
  if (typeof value === 'string') return value.trim();
  const explicit = value?.category?.trim() || value?.name?.trim() || value?.description?.trim() || '';
  if (explicit) return explicit;
  const mcc = String(payment.mcc ?? payment.merchant_category_code ?? payment.alias?.merchant_category_code ?? payment.counterparty_alias?.merchant_category_code ?? '').replace(/\.0$/, '');
  const mccCategories: Record<string, string> = {
    '4111': 'Transportation', '4121': 'Transportation', '4131': 'Transportation', '4789': 'Transportation',
    '4900': 'Housing', '5200': 'Shopping', '5311': 'Shopping', '5331': 'Shopping', '5399': 'Shopping',
    '5411': 'Groceries', '5422': 'Groceries', '5441': 'Groceries', '5451': 'Groceries', '5462': 'Groceries', '5499': 'Groceries',
    '5541': 'Transportation', '5542': 'Transportation', '5651': 'Shopping', '5661': 'Shopping',
    '5812': 'Food & Dining', '5813': 'Food & Dining', '5814': 'Food & Dining', '5912': 'Health & Wellness',
    '7011': 'Travel', '7210': 'Personal Care', '7230': 'Personal Care', '7832': 'Entertainment', '7911': 'Entertainment'
  };
  return mccCategories[mcc] ?? '';
}

export function wealthfolioAccountPayload(account: BunqMonetaryAccount) {
  const currency = account.balance?.currency ?? account.currency ?? 'EUR';
  return {
    name: account.description?.trim() || `bunq account ${account.id}`,
    accountType: 'CASH',
    currency,
    balance: Number(account.balance?.value ?? 0),
    isDefault: false,
    isActive: true,
    trackingMode: 'TRANSACTIONS',
    provider: 'bunq',
    providerAccountId: String(account.id),
    accountNumber: account.alias?.find((alias) => alias.type === 'IBAN')?.value,
    meta: JSON.stringify({ source: 'bunq-addon', bunqAccountId: account.id })
  };
}

export async function loadConfig(ctx: AddonContext): Promise<BunqConfig | null> {
  const raw = await ctx.api.storage.get('config');
  if (!raw) return null;
  const config = JSON.parse(raw) as BunqConfig;
  return { ...config, autoAddNewAccounts: config.autoAddNewAccounts ?? true };
}

export async function saveConfig(ctx: AddonContext, config: BunqConfig) {
  await ctx.api.storage.set('config', JSON.stringify(config));
}

export async function loadAccountSettings(ctx: AddonContext): Promise<Record<string, BunqAccountSettings>> {
  const raw = await ctx.api.storage.get(ACCOUNT_SETTINGS_STORAGE_KEY);
  const stored = raw ? JSON.parse(raw) as Record<string, BunqAccountSettings> : {};
  // These are the user-requested defaults for the current production data set.
  return {
    ...stored,
    '926693': { ...stored['926693'], sync: stored['926693']?.sync ?? false },
    // Wealthfolio has Travel as an expense category; income categories are a separate taxonomy.
    '4479323': { expenseCategory: 'Travel', ...stored['4479323'], sync: stored['4479323']?.sync ?? true },
  };
}

export async function saveAccountSettings(ctx: AddonContext, settings: Record<string, BunqAccountSettings>) {
  await ctx.api.storage.set(ACCOUNT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
