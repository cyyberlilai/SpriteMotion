import React, { useState, useEffect } from "react";
import { X, KeyRound, ExternalLink, Eye, EyeOff, Check, Trash2 } from "lucide-react";
import {
  PROVIDERS,
  PROVIDER_LIST,
  type AiProvider,
  type UserAiConfig,
} from "../services/aiConfig";

interface AiSettingsModalProps {
  open: boolean;
  config: UserAiConfig;
  onClose: () => void;
  onSave: (config: UserAiConfig) => void;
  onClear: () => void;
}

export const AiSettingsModal: React.FC<AiSettingsModalProps> = ({
  open,
  config,
  onClose,
  onSave,
  onClear,
}) => {
  const [draft, setDraft] = useState<UserAiConfig>(config);
  const [showKey, setShowKey] = useState(false);

  // 每次打开时同步最新的已保存配置
  useEffect(() => {
    if (open) {
      setDraft(config);
      setShowKey(false);
    }
  }, [open, config]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const preset = PROVIDERS[draft.provider];
  const isCustom = draft.provider === "custom";

  const handleProviderChange = (provider: AiProvider) => {
    const next = PROVIDERS[provider];
    setDraft((prev) => {
      // 判断依据是「目标厂商」而不是「切换前的厂商」。
      // 目标是内置厂商时，直接填上它的默认端点/模型；
      // 目标是自定义时，保留用户已经填好的内容（可能是自己敲的地址）。
      if (provider === "custom") {
        return { ...prev, provider };
      }
      return {
        ...prev,
        provider,
        baseUrl: next.baseUrl,
        model: next.model,
      };
    });
  };

  const handleSave = () => {
    onSave(draft);
    onClose();
  };

  const handleClear = () => {
    onClear();
    onClose();
  };

  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xl p-4"
      onClick={onClose}
    >
      <div
        className="modal-pop glass w-full max-w-lg rounded-[22px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] bg-white/[0.02]">
          <div className="flex items-center space-x-2">
            <KeyRound className="text-indigo-300" size={16} />
            <h3 className="text-[14px] font-semibold text-slate-100 tracking-tight">AI 识别设置</h3>
          </div>
          <button
            onClick={onClose}
            className="btn-glass lift p-1.5 rounded-full text-slate-400 hover:text-slate-100"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* 说明 */}
          <p className="text-[11.5px] text-slate-400 leading-relaxed">
            API Key 只保存在你自己浏览器的本地存储里，不会发送到任何第三方服务器，
            仅在调用「自动识别」时直接发给你所选的服务商。
          </p>

          {/* 服务商选择 */}
          <div className="space-y-2">
            <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
              服务商
            </label>
            <div className="grid grid-cols-3 gap-2">
              {PROVIDER_LIST.map((p) => (
                <button
                  key={p}
                  onClick={() => handleProviderChange(p)}
                  className={`px-3 py-2 rounded-md border text-[12.5px] transition-colors duration-150 text-left ${
                    draft.provider === p
                      ? "bg-indigo-600 border-indigo-500 text-white"
                      : "bg-slate-950 border-slate-700 text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  {PROVIDERS[p].label}
                </button>
              ))}
            </div>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500 flex items-center justify-between">
              <span>API Key</span>
              {preset.docs && (
                <a
                  href={preset.docs}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 normal-case font-normal transition-colors"
                >
                  {preset.docsLabel}
                  <ExternalLink size={12} />
                </a>
              )}
            </label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={draft.apiKey}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, apiKey: e.target.value }))
                }
                placeholder="粘贴你的 API Key"
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-slate-950 border border-slate-700 rounded-md px-2.5 py-2 pr-10 text-slate-100 font-mono text-[12.5px] focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 outline-none transition-colors duration-150 placeholder:text-slate-600"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-slate-500 hover:text-slate-300 transition-colors"
                title={showKey ? "隐藏" : "显示"}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* 接口地址 */}
          <div className="space-y-2">
            <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
              接口地址 {isCustom && <span className="text-indigo-400 normal-case">（必填）</span>}
            </label>
            <input
              type="text"
              value={draft.baseUrl}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))
              }
              placeholder={preset.baseUrl || "https://your-endpoint/v1"}
              spellCheck={false}
              className="w-full bg-slate-950 border border-slate-700 rounded-md px-2.5 py-2 text-slate-100 font-mono text-[11.5px] focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 outline-none transition-colors duration-150 placeholder:text-slate-600"
            />
          </div>

          {/* 模型 */}
          <div className="space-y-2">
            <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">
              模型 {isCustom && <span className="text-indigo-400 normal-case">（必填）</span>}
            </label>
            <input
              type="text"
              value={draft.model}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, model: e.target.value }))
              }
              placeholder={preset.model || "your-model-id"}
              spellCheck={false}
              className="w-full bg-slate-950 border border-slate-700 rounded-md px-2.5 py-2 text-slate-100 font-mono text-[11.5px] focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 outline-none transition-colors duration-150 placeholder:text-slate-600"
            />
          </div>

          {/* JSON 模式开关 */}
          <div className="flex items-center justify-between px-3 py-2.5 bg-slate-950 rounded-md border border-slate-800">
            <div className="pr-3">
              <div className="text-[12.5px] text-slate-200">JSON 模式</div>
              <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                发送 response_format 参数，让模型直接返回 JSON。
                部分 Coding Plan 端点不支持，关闭即可。
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={draft.jsonMode}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, jsonMode: e.target.checked }))
                }
              />
              <div className="w-9 h-5 bg-slate-700 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-200 after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-transform after:duration-150 toggle-track peer-checked:bg-indigo-500 transition-colors"></div>
            </label>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-white/[0.06] bg-white/[0.02]">
          <button
            onClick={handleClear}
            className="flex items-center space-x-1.5 px-3 py-2 rounded-md text-xs text-slate-500 hover:text-rose-400 hover:bg-rose-600/12 transition-colors"
          >
            <Trash2 size={13} />
            <span>清除已保存的 Key</span>
          </button>
          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md text-sm text-slate-400 hover:text-white transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="flex items-center space-x-1.5 px-3.5 py-2 rounded-md btn-accent lift text-[12.5px] font-medium"
            >
              <Check size={15} />
              <span>保存</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
