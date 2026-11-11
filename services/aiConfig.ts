/**
 * AI 配置存储：用户在网页上填的 API Key 等信息存在浏览器 localStorage。
 *
 * 优先级：用户填的（localStorage） > .env.local 里配的（import.meta.env）
 * 这样开发时可以预置一个默认 Key 给用户用，用户也能自己覆盖。
 */

export type AiProvider = 'gemini' | 'openai' | 'custom';

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  model: string;
  docs: string;
  docsLabel: string;
}

export const PROVIDERS: Record<AiProvider, ProviderPreset> = {
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    docs: 'https://aistudio.google.com/apikey',
    docsLabel: '前往 Google AI Studio 获取',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    docs: 'https://platform.openai.com/api-keys',
    docsLabel: '前往 OpenAI 平台获取',
  },
  custom: {
    label: '自定义兼容端点',
    baseUrl: '',
    model: '',
    docs: '',
    docsLabel: '需自行填写接口地址与模型',
  },
};

export const PROVIDER_LIST: AiProvider[] = ['gemini', 'openai', 'custom'];

/** 用户在界面上填的配置 */
export interface UserAiConfig {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * 是否发送 response_format: {type:'json_object'}。
   * 不少 Coding Plan 端点不支持这个参数（会 400），所以做成可关。
   */
  jsonMode: boolean;
}

export const EMPTY_USER_CONFIG: UserAiConfig = {
  provider: 'gemini',
  apiKey: '',
  baseUrl: '',
  model: '',
  jsonMode: true,
};

const STORAGE_KEY = 'spritemotion.aiConfig';

// 注意：Vite 在 dev 模式下不替换 process.env.*，浏览器没有 process 对象会直接白屏，
// 所以统一走 import.meta.env。
const env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;

/** 读取 .env.local 里预置的配置（作为默认值） */
export const getEnvConfig = (): UserAiConfig => {
  const rawProvider = (env.VITE_AI_PROVIDER || '').trim().toLowerCase();
  const provider: AiProvider =
    rawProvider && rawProvider in PROVIDERS
      ? (rawProvider as AiProvider)
      : env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY
        ? 'gemini'
        : env.VITE_OPENAI_API_KEY
          ? 'openai'
          : 'gemini';

  const preset = PROVIDERS[provider];
  return {
    provider,
    apiKey: (
      env.VITE_AI_API_KEY ||
      env[`VITE_${provider.toUpperCase()}_API_KEY`] ||
      env.GEMINI_API_KEY ||
      ''
    ).trim(),
    baseUrl: (env.VITE_AI_BASE_URL || preset.baseUrl).replace(/\/+$/, ''),
    model: (env.VITE_AI_MODEL || preset.model).trim(),
    jsonMode: env.VITE_AI_JSON_MODE !== 'false',
  };
};

export const loadUserConfig = (): UserAiConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getEnvConfig();
    const parsed = JSON.parse(raw);
    const envCfg = getEnvConfig();
    return {
      provider: parsed.provider in PROVIDERS ? parsed.provider : envCfg.provider,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : envCfg.apiKey,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : envCfg.baseUrl,
      model: typeof parsed.model === 'string' ? parsed.model : envCfg.model,
      jsonMode:
        typeof parsed.jsonMode === 'boolean' ? parsed.jsonMode : envCfg.jsonMode,
    };
  } catch {
    return getEnvConfig();
  }
};

export const saveUserConfig = (config: UserAiConfig): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.error('保存 AI 配置失败', err);
  }
};

export const clearUserConfig = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
};

/**
 * 把用户配置解析成实际可用的请求参数。
 * 用户填了自定义端点/模型就用用户的，否则用对应厂商的默认值。
 */
export const resolveAiConfig = (config: UserAiConfig) => {
  const preset = PROVIDERS[config.provider];
  const baseUrl = (config.baseUrl.trim() || preset.baseUrl).replace(/\/+$/, '');
  const model = config.model.trim() || preset.model;
  const apiKey = config.apiKey.trim();

  return {
    provider: config.provider,
    providerLabel: preset.label,
    apiKey,
    baseUrl,
    model,
    jsonMode: config.jsonMode,
    hasKey: apiKey.length > 0,
    isComplete: apiKey.length > 0 && baseUrl.length > 0 && model.length > 0,
  };
};
