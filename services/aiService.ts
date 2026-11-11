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
      throw new Error(
        `请先填写 ${resolved.providerLabel} 的 API Key，点击右上角「AI 设置」按钮。`
      );
    }
    throw new Error(
      `接口地址或模型名不完整，请在「AI 设置」中补全 ${resolved.providerLabel} 的配置。`
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

    let response = await sendRequest(resolved.jsonMode);

    // 自动降级：某些端点不认 response_format，会回 400/422。
    // 这种时候不打扰用户，直接用严格提示词重试一次。
    if (!response.ok && resolved.jsonMode && [400, 422].includes(response.status)) {
      const firstError = await response.text().catch(() => "");
      const looksLikeFormatIssue = /response_format|json_object|json mode|unsupported/i.test(
        firstError
      );
      if (looksLikeFormatIssue) {
        console.warn("端点不支持 response_format，自动降级重试", firstError.slice(0, 120));
        response = await sendRequest(false);
      } else {
        throw new Error(
          `${resolved.providerLabel} 接口返回 ${response.status}：${
            firstError.slice(0, 200) || response.statusText
          }`
        );
      }
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `${resolved.providerLabel} 接口返回 ${response.status}：${
          detail.slice(0, 200) || response.statusText
        }`
      );
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(`${resolved.providerLabel} 没有返回内容`);
    }

    const data = parseJsonLoose(
      typeof content === "string" ? content : JSON.stringify(content)
    );

    const rows = Number(data.rows);
    const cols = Number(data.cols);
    const totalFrames = Number(data.totalFrames);

    if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) {
      throw new Error("识别结果异常：行数或列数无效");
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
    throw error;
  }
};
