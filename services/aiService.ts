import { SpriteConfig } from "../types";
import {
  resolveAiConfig,
  type AiProvider,
  type UserAiConfig,
  PROVIDERS,
  PROVIDER_LIST,
  loadUserConfig,
  saveUserConfig,
  clearUserConfig,
  getEnvConfig,
} from "./aiConfig";

export {
  PROVIDERS,
  PROVIDER_LIST,
  loadUserConfig,
  saveUserConfig,
  clearUserConfig,
  resolveAiConfig,
  getEnvConfig,
};
export type { AiProvider, UserAiConfig };

/**
 * 识别失败的原因分类。
 *
 * 分那么细不是为了给用户看错误码，而是为了让界面能给**正确的下一步**：
 * 429 该等一等、断网该重试、Key 无效才该去改配置。
 * 全都归成一个「打开 API 配置」，用户就会白跑。
 */
export type AiErrorKind =
  | 'auth' // 401 / 403：Key 无效或没权限
  | 'notfound' // 404：模型名或接口地址不存在
  | 'quota' // 429：频率或额度
  | 'network' // 请求根本没发出去：断网、代理、跨域拦截
  | 'server' // 5xx / 400 / 其它：服务端或参数问题
  | 'format' // 返回内容不是可解析的 JSON
  | 'invalid-result' // 解析成功但没有有效的行列数
  | 'incomplete'; // 本地配置不完整（缺 Key / 缺地址或模型）

/** 带分类的错误：message 是给人看的一句话，raw 是给「查看详情」的原文 */
export class AiError extends Error {
  kind: AiErrorKind;
  status?: number;
  raw?: string;

  constructor(kind: AiErrorKind, message: string, opts?: { status?: number; raw?: string }) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.status = opts?.status;
    this.raw = opts?.raw;
  }
}

/** 不依赖 instanceof（ES5 target 下原型链会断），按字段判断即可 */
export const isAiError = (e: unknown): e is AiError =>
  !!e && typeof e === 'object' && typeof (e as { kind?: unknown }).kind === 'string';

const kindOfStatus = (status: number): AiErrorKind => {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 429) return 'quota';
  return 'server';
};

/** 从服务商返回体里挖一句人话，挖不到就用原始文本 */
const extractProviderMessage = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw);
    const msg =
      parsed?.error?.message ??
      parsed?.error?.status ??
      parsed?.message ??
      parsed?.detail ??
      null;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    /* 不是 JSON，直接用原文 */
  }
  return raw.trim();
};

const PROMPT = `Analyze this sprite sheet image. It contains a sequence of animation frames arranged in a grid.
Count the number of rows and columns.
Also estimate the total number of valid frames (sometimes the last row is not full).
Return ONLY a JSON object with exactly these fields, no prose, no markdown fence:
{"rows": <integer>, "cols": <integer>, "totalFrames": <integer>}`;

/**
 * 提示词变体：给不认 response_format 的端点用。
 * 额外强调「只输出 JSON」，因为部分模型会习惯性地解释一段再给结果。
 */
const PROMPT_STRICT = `You are analyzing a sprite sheet image. It contains animation frames arranged in a grid.

Task: count the rows and columns, and estimate the total number of valid frames (the last row may be partially filled).

IMPORTANT: Your entire response must be a single JSON object and nothing else. Do not write any explanation, do not use markdown code fences.
Use exactly this shape: {"rows": 4, "cols": 4, "totalFrames": 14}`;

/** 有些厂商即使被要求只返回 JSON，也会包一层 ```json 代码块，这里兜底解析 */
const parseJsonLoose = (raw: string): any => {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        /* 继续尝试 */
      }
    }
    const braced = text.match(/\{[\s\S]*\}/);
    if (braced) {
      try {
        return JSON.parse(braced[0]);
      } catch {
        /* 放弃 */
      }
    }
    throw new Error("模型返回的内容不是合法 JSON");
  }
};

/**
 * 调用视觉模型识别精灵图的网格结构。
 * config 由调用方（界面上的设置面板）传入，API Key 来自用户本地存储。
 */
export const analyzeSpriteSheet = async (
  base64Image: string,
  config: UserAiConfig
): Promise<Partial<SpriteConfig>> => {
  const resolved = resolveAiConfig(config);

  if (!resolved.isComplete) {
    if (!resolved.hasKey) {
      throw new AiError(
        'incomplete',
        `还没有填写 ${resolved.providerLabel} 的 API Key`
      );
    }
    throw new AiError(
      'incomplete',
      '接口地址或模型名为空，配置还不完整'
    );
  }

  try {
    const buildBody = (useJsonMode: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: resolved.model,
        messages: [
          {
            role: "user",
            content: [
              // 关掉 JSON 模式时，改用更强调「只输出 JSON」的提示词，
              // 因为少了 response_format 这层约束，模型更容易啰嗦。
              { type: "text", text: useJsonMode ? PROMPT : PROMPT_STRICT },
              {
                type: "image_url",
                image_url: { url: base64Image },
              },
            ],
          },
        ],
      };

      // response_format 不是所有端点都支持（部分 Coding Plan 会直接 400），
      // 所以只在开启时发送，解析端也已能兜住带 ```json 围栏的返回。
      if (useJsonMode) {
        body.response_format = { type: "json_object" };
      }
      return body;
    };

    const sendRequest = (useJsonMode: boolean) =>
      fetch(`${resolved.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify(buildBody(useJsonMode)),
      });

    // fetch 自己抛错 = 请求压根没发出去（断网 / 代理 / 跨域），
    // 这类错误原文是 "Failed to fetch"，对用户毫无意义，必须翻译。
    const send = async (useJsonMode: boolean) => {
      try {
        return await sendRequest(useJsonMode);
      } catch (err) {
        throw new AiError('network', '连不上接口，请求没有发出去', {
          raw: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
    };

    let response = await send(resolved.jsonMode);

    // 自动降级：某些端点不认 response_format，会回 400/422。
    // 这种时候不打扰用户，直接用严格提示词重试一次。
    if (!response.ok && resolved.jsonMode && [400, 422].includes(response.status)) {
      const firstError = await response.text().catch(() => "");
      const looksLikeFormatIssue = /response_format|json_object|json mode|unsupported/i.test(
        firstError
      );
      if (looksLikeFormatIssue) {
        console.warn("端点不支持 response_format，自动降级重试", firstError.slice(0, 120));
        response = await send(false);
      } else {
        throw new AiError(
          kindOfStatus(response.status),
          `${resolved.providerLabel} 拒绝了这次请求（${response.status}）`,
          { status: response.status, raw: extractProviderMessage(firstError) }
        );
      }
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AiError(
        kindOfStatus(response.status),
        `${resolved.providerLabel} 返回 ${response.status}`,
        { status: response.status, raw: extractProviderMessage(detail) || response.statusText }
      );
    }

    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;

    if (!content) {
      throw new AiError(
        'format',
        `${resolved.providerLabel} 没有返回任何内容`,
        { raw: JSON.stringify(payload ?? {}).slice(0, 400) }
      );
    }

    const contentText = typeof content === "string" ? content : JSON.stringify(content);
    let data: any;
    try {
      data = parseJsonLoose(contentText);
    } catch {
      throw new AiError('format', '模型返回的内容不是合法 JSON', {
        raw: contentText.slice(0, 400),
      });
    }

    if (!data || typeof data !== 'object') {
      throw new AiError('format', '模型返回的内容里没有 JSON', {
        raw: contentText.slice(0, 400),
      });
    }

    const rows = Number(data.rows);
    const cols = Number(data.cols);
    const totalFrames = Number(data.totalFrames);

    if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) {
      throw new AiError('invalid-result', '没能从这张图里认出网格', {
        raw: contentText.slice(0, 400),
      });
    }

    return {
      rows: Math.round(rows),
      cols: Math.round(cols),
      totalFrames:
        Number.isFinite(totalFrames) && totalFrames > 0
          ? Math.round(totalFrames)
          : Math.round(rows) * Math.round(cols),
    };
  } catch (error) {
    console.error(`${resolved.providerLabel} Analysis Error:`, error);
    if (isAiError(error)) throw error;
    // 兜底：任何没被分类的异常都包一层，界面才能统一渲染，
    // 也不会把 "TypeError: xxx is not a function" 这种东西直接丢给用户。
    throw new AiError('server', '识别过程中出现了意外错误', {
      raw: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
};
