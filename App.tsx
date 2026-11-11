import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Upload, Download, Sparkles, RefreshCw, Layers, Settings, Scissors, Palette, ShieldCheck, ShieldAlert, ArrowRight, ArrowDown, AlignCenter, ArrowDownToLine, Target, Maximize, Images, ChevronDown, AlertTriangle, Grid2x2, Blend, Eraser, Wand2, PaintBucket, Info, X, CheckCircle2, RotateCcw } from 'lucide-react';
import { SpriteConfig, ImageDimensions, ProcessingState, CropConfig } from './types';
import { SpriteCanvas } from './components/SpriteCanvas';
import { FrameZoomModal } from './components/FrameZoomModal';
import { PreviewPlayer } from './components/PreviewPlayer';
import { AiSettingsModal } from './components/AiSettingsModal';
import { analyzeSpriteSheet, loadUserConfig, saveUserConfig, clearUserConfig, resolveAiConfig } from './services/aiService';
import type { UserAiConfig } from './services/aiConfig';
import { generateGif, hexToRgb } from './utils/gifBuilder';
import { exportFrames } from './utils/frameExporter';
import {
  readImageFile,
  pickImageFile,
  SUPPORTED_IMAGE_FORMATS,
  SUPPORTED_FORMATS_LABEL,
  buildExportFileName,
  formatFileSize,
} from './utils/fileLoader';

/** 每次重置都生成一份全新的对象，避免嵌套的 crop / editPoints 被共享引用 */
const createInitialConfig = (): SpriteConfig => ({
  rows: 3,
  cols: 3,
  totalFrames: 9,
  excludedFrames: [], // Init empty
  fps: 8,
  scale: 1,
  transparent: null,
  tolerance: 10,
  useFloodFill: true,
  alphaRatio: true,
  despillStrength: 80,
  autoAlign: false,
  alignMode: 'center', // Default align mode
  readOrder: 'row-major',
  crop: { top: 3, bottom: 3, left: 3, right: 3 },
  editPoints: [], // 手动编辑点：抠除 / 恢复（原图归一化坐标）
  maxResolution1024: false
});

const INITIAL_CONFIG: SpriteConfig = createInitialConfig();

/**
 * 导出反馈：成功与失败共用同一条「行内状态条」，都长在导出栏里（文档流内），
 * 因此物理上不可能盖住参数面板 —— 这正是换成行内的全部理由。
 * 失败只是长得高一点（多一行原因 + 一个「重试」），不再单独走浮层。
 */
interface StatusNotice {
  id: number;
  kind: 'success' | 'error';
  title: string;
  /** 成功：可点击复制的成品文件名 */
  fileName?: string;
  /** 成功：完整明细 / 窄屏简版 */
  detail?: string;
  shortDetail?: string;
  /** 失败：具体原因 */
  description?: string;
  /** 正在重试中：显示转圈，不自动消失，等结果覆盖 */
  pending?: boolean;
  action?: { label: string; onClick: () => void };
}

/** 参数重置后的「撤销」提示：与导出无关，仍是独立的轻量卡片 */
interface InfoToast {
  id: number;
  duration: number;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

/**
 * 就近错误：锚点决定它挂在哪个控件下面。
 *   upload / analyze = 工具栏里对应按钮正下方，drop = 投放区中央。
 * 导出类错误不在这里，走 toast（停在导出栏上方）。
 */
interface ScopedError {
  message: string;
  anchor: 'upload' | 'analyze' | 'drop';
  hint?: string;
  action?: { label: string; onClick: () => void };
}

interface NumberInputProps {
  label: string;
  value: number;
  onChange: (val: number) => void;
  min?: number;
  max?: number;
}

const NumberInput: React.FC<NumberInputProps> = ({ label, value, onChange, min = 1, max }) => {
  const [localValue, setLocalValue] = useState<string>(value.toString());

  useEffect(() => {
    setLocalValue(value.toString());
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setLocalValue(newVal);
    if (newVal !== '' && !isNaN(Number(newVal))) {
      onChange(Number(newVal));
    }
  };

  const handleBlur = () => {
    if (localValue === '' || isNaN(Number(localValue))) {
      setLocalValue(value.toString());
    } else {
       let num = Number(localValue);
       if (min !== undefined && num < min) num = min;
       if (max !== undefined && num > max) num = max;
       if (num.toString() !== localValue) {
         setLocalValue(num.toString());
       }
       onChange(num);
    }
  };

  return (
    <div className="space-y-1.5">
      <label className="text-[12px] font-medium text-slate-500 uppercase tracking-[0.08em]">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        className="w-full bg-slate-950 border border-slate-700 rounded-md px-2.5 py-2 text-white text-[13px] font-mono tnum focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 outline-none transition-colors duration-150 hover:border-slate-600"
      />
    </div>
  );
};

/** 挂在触发按钮正下方的错误胶囊：原因 + 补充说明 + 一个可点的下一步动作 */
const InlineError: React.FC<{
  message: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
  onClose: () => void;
}> = ({ message, hint, action, onClose }) => (
  <div
    role="alert"
    className="absolute left-0 top-full mt-2 z-40 w-[min(380px,calc(100vw-32px))] flex items-start gap-2.5 rounded-xl glass-pill modal-pop p-3 border border-rose-400/30"
  >
    <AlertTriangle size={15} className="text-rose-300 shrink-0 mt-[2px]" />
    <div className="min-w-0 flex-1">
      <div className="text-[12.5px] font-medium leading-relaxed text-white break-words">{message}</div>
      {hint && <div className="text-[11px] leading-relaxed text-slate-400 mt-1">{hint}</div>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 px-2.5 py-1 min-h-[28px] rounded-md btn-glass text-[11.5px] font-medium text-slate-100 hover:text-white"
        >
          {action.label}
        </button>
      )}
    </div>
    <button
      type="button"
      onClick={onClose}
      className="p-1 -mt-1 -mr-1 rounded text-slate-500 hover:text-white hover:bg-white/10 transition-colors duration-150"
      aria-label="关闭提示"
    >
      <X size={13} />
    </button>
  </div>
);

const App: React.FC = () => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions>({ width: 0, height: 0 });
  const [config, setConfig] = useState<SpriteConfig>(INITIAL_CONFIG);
  const [processingState, setProcessingState] = useState<ProcessingState>({ status: 'idle', progress: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [aiConfig, setAiConfig] = useState<UserAiConfig>(() => loadUserConfig());
  const [showAiSettings, setShowAiSettings] = useState(false);
  // 单帧裁剪是低频操作，默认收起；有值时会在标题上显示提示点
  const [showCrop, setShowCrop] = useState(false);
  // 网格与读取顺序默认收起，把空间让给下面的参数
  const [showGrid, setShowGrid] = useState(false);
  // 边缘处理（α 判定 / 去色溢出）是调一次就不动的专业项，默认收起
  const [showEdge, setShowEdge] = useState(false);
  const [zoomMode, setZoomMode] = useState<'fit' | 'actual'>('fit');
  const [canvasScale, setCanvasScale] = useState(1);
  // 点选修边模式：开启后点击画布会放大那一格去逐处修
  const [eraseMode, setEraseMode] = useState(false);
  // 当前在修哪一头：erase = 抠掉多余背景，restore = 把被误抠的补回来。
  // 提到 App 层而不是放在放大窗里，是为了让「面板上的选择」和「窗口里的选择」是同一个值 ——
  // 用户在哪边切都算数，不会出现「面板显示恢复、窗口实际在抠除」这种错位。
  const [editMode, setEditMode] = useState<'erase' | 'restore'>('erase');
  // 单格放大编辑弹窗：null = 关闭；数字 = 正在编辑的帧序号
  const [zoomFrame, setZoomFrame] = useState<number | null>(null);
  // 源文件名只在导出命名时用，不参与任何图像处理
  const [sourceName, setSourceName] = useState('sprite');
  // 就近错误：只出现在触发它的控件旁边（工具栏按钮下 / 投放区里）
  const [scopedError, setScopedError] = useState<ScopedError | null>(null);
  // 参数重置 / 撤销：与导出无关的轻量提示，仍是浮层卡片
  const [toast, setToast] = useState<InfoToast | null>(null);
  const toastTimer = useRef<number | null>(null);
  // 导出反馈（成功与失败共用）：导出栏里的行内状态条，不浮、不遮挡
  const [notice, setNotice] = useState<StatusNotice | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const noticeFadeTimer = useRef<number | null>(null);
  // 状态条淡出中：内容消失但高度还在，导出栏不会因为提示消失而上下跳
  const [noticeFading, setNoticeFading] = useState(false);
  const exportBarRef = useRef<HTMLDivElement>(null);
  const resetNoticeRef = useRef<HTMLDivElement>(null);
  const scopedErrorTimer = useRef<number | null>(null);
  // 放大窗要按背景色判断「这块本来是不是背景」，才能把被误抠的区域标出来。
  // 没设透明色值时按白色兜底（此时压根不抠图，弹窗也用不到这值）。
  const zoomTarget = useMemo(
    () => (config.transparent ? hexToRgb(config.transparent) : null) ?? { r: 255, g: 255, b: 255 },
    [config.transparent]
  );
  // 面板上的计数分开显示：抠除和恢复是两种相反的操作，混成一个数会看不懂
  const eraseCount = config.editPoints.filter((p) => p.mode !== 'restore').length;
  const restoreCount = config.editPoints.filter((p) => p.mode === 'restore').length;

  // 编辑模式下的键盘：Esc 退出，X / R 切换抠除 / 恢复。
  // 放大窗打开时不接管 Esc —— 那个 Esc 是「关窗口」，不该顺手把整个编辑模式也关掉。
  useEffect(() => {
    if (!eraseMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (zoomFrame === null) setEraseMode(false);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'x' || e.key === 'X') setEditMode('erase');
      if (e.key === 'r' || e.key === 'R') setEditMode('restore');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [eraseMode, zoomFrame]);

  const aiResolved = resolveAiConfig(aiConfig);
  const hasCrop =
    config.crop.top > 0 || config.crop.bottom > 0 ||
    config.crop.left > 0 || config.crop.right > 0;
  const isConfigDirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(INITIAL_CONFIG),
    [config]
  );

  // 计时器统一收口：连续导出 / 连续失败时旧计时器不会把新消息提前关掉
  const showToast = (data: Omit<InfoToast, 'id' | 'duration'>, duration = 8000) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ ...data, id: Date.now(), duration });
    toastTimer.current = window.setTimeout(() => setToast(null), duration);
  };
  const dismissToast = () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(null);
  };
  const showScopedError = (error: ScopedError, duration = 8000) => {
    if (scopedErrorTimer.current) window.clearTimeout(scopedErrorTimer.current);
    setScopedError(error);
    scopedErrorTimer.current = window.setTimeout(() => setScopedError(null), duration);
  };
  const dismissScopedError = () => {
    if (scopedErrorTimer.current) window.clearTimeout(scopedErrorTimer.current);
    setScopedError(null);
  };
  // 导出反馈统一入口：成功与失败同一条通道，只是内容长度不同
  // duration = null 表示「不自动消失」，用于重试中的中间态
  const showNotice = (data: Omit<StatusNotice, 'id'>, duration: number | null = 8000) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (noticeFadeTimer.current) window.clearTimeout(noticeFadeTimer.current);
    // 重试刚开始时如果结果立刻回来，先压一压，让「正在重新导出」至少被看见一眼
    const hold = data.pending ? 0 : noticeHoldUntil.current - Date.now();
    const apply = () => {
      setNoticeFading(false);
      setNotice({ ...data, id: Date.now() });
      if (duration === null) return;
      // 先淡出再摘除，避免内容「啪」地消失
      noticeTimer.current = window.setTimeout(() => setNoticeFading(true), duration);
      noticeFadeTimer.current = window.setTimeout(() => setNotice(null), duration + 400);
    };
    if (hold > 0) {
      noticeTimer.current = window.setTimeout(apply, hold);
      return;
    }
    apply();
  };
  const dismissNotice = () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (noticeFadeTimer.current) window.clearTimeout(noticeFadeTimer.current);
    setNotice(null);
  };
  /**
   * 失败条上的「重试」曾经有个隐蔽 bug：它的回调是在失败那一刻生成的，
   * 闭包里攥着当时的 config —— 用户改完参数再点重试，导出的还是旧参数。
   * 现在改成调用这个 ref 里的「最新版」导出函数，永远读当前参数。
   */
  const exportHandlersRef = useRef<{ gif: (fromRetry?: boolean) => Promise<void>; zip: (fromRetry?: boolean) => Promise<void> }>({
    gif: async () => {},
    zip: async () => {},
  });
  // 「正在重试」的中间态至少停留这么久，避免失败太快时用户看不到任何变化
  const noticeHoldUntil = useRef(0);
  const MIN_RETRY_VISIBLE_MS = 650;

  const retryExport = (kind: 'gif' | 'zip') => {
    const label = kind === 'gif' ? 'GIF' : '逐帧';
    noticeHoldUntil.current = Date.now() + MIN_RETRY_VISIBLE_MS;
    // 先给一个确定可见的状态，再真正重跑 —— 否则瞬时失败在视觉上等于「点了没反应」
    showNotice(
      {
        kind: 'error',
        title: `正在重新导出${label}…`,
        description: '按当前参数重新执行',
        pending: true,
      },
      null
    );
    void (kind === 'gif' ? exportHandlersRef.current.gif(true) : exportHandlersRef.current.zip(true));
  };
  // 窄屏是整页滚动：状态条长出来会把导出按钮往下顶，可能正好顶出视口。
  // 等过渡走完再看一眼，真的露不全就把导出栏轻轻带回视野（桌面是固定高度布局，这里是空操作）。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      const el = exportBarRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const overflow = rect.bottom - window.innerHeight;
      if (overflow > 0) {
        window.scrollBy({ top: overflow + 12, behavior: 'smooth' });
      }
    }, 340);
    return () => window.clearTimeout(timer);
  }, [notice]);
  // 重置提示在参数面板内部，桌面端面板有独立滚动条，提示可能正好落在可见区之外：
  // 出现时把它滚进视野（只滚最近的那个滚动容器，不惊动整页）
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => {
      resetNoticeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 340);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (scopedErrorTimer.current) window.clearTimeout(scopedErrorTimer.current);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (noticeFadeTimer.current) window.clearTimeout(noticeFadeTimer.current);
  }, []);

  const handleSaveAiConfig = (config: UserAiConfig) => {
    setAiConfig(config);
    saveUserConfig(config);
  };

  const handleClearAiConfig = () => {
    // 先删存储再读，否则读回来的还是刚被删掉的那份
    clearUserConfig();
    setAiConfig(loadUserConfig());
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadImageFile(file, 'button');
    }
    // 重置 input value，保证连续选同一个文件也能触发 change
    e.target.value = '';
  };

  /**
   * 三条导入路径共用。失败原因不再丢到画布底部的通用报错条，
   * 而是显示在「刚刚操作的那个地方」：按钮下 / 投放区里。
   */
  const loadImageFile = async (file: File, scope: 'button' | 'drop' | 'paste' = 'button') => {
    try {
      const dataUrl = await readImageFile(file);
      // 有些文件后缀是图片、内容却已损坏（或浏览器解不了）。
      // 先解一次码，失败立刻给原因，避免留下半张空白画布让人摸不着头脑。
      const probe = new Image();
      probe.src = dataUrl;
      try {
        await probe.decode();
      } catch {
        throw new Error(`「${file.name}」无法解码，文件可能已损坏或不是有效的图片`);
      }
      setImageUrl(dataUrl);
      setSourceName(file.name);
      dismissScopedError();
      setProcessingState({ status: 'idle', progress: 0 });
      setConfig(createInitialConfig());
      setZoomFrame(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '读取图片失败';
      showScopedError({
        message: msg,
        anchor: scope === 'drop' ? 'drop' : 'upload',
        hint: `支持 ${SUPPORTED_FORMATS_LABEL}`,
        // 投放区那张卡片自带「改为选择图片文件」，这里只给按钮/粘贴路径补一个动作
        action: scope === 'drop' ? undefined : {
          label: '重新选择',
          onClick: () => {
            dismissScopedError();
            fileInputRef.current?.click();
          },
        },
      });
      setProcessingState({ status: 'idle', progress: 0 });
    }
  };

  // 粘贴上传（Ctrl/⌘ + V）
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      // 输入框里粘贴时不拦截
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const file = pickImageFile(e.clipboardData?.files);
      if (file) {
        e.preventDefault();
        loadImageFile(file, 'paste');
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  // 页面级兜底：拖到画布以外的地方时，阻止浏览器直接打开图片
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }
    };
    const preventDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', preventDrop);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', preventDrop);
    };
  }, []);

  const handleAutoDetect = async () => {
    if (!imageUrl) return;

    // 没配置 Key 时，直接弹出设置面板，不用让用户先读报错
    if (!aiResolved.hasKey) {
      setShowAiSettings(true);
      return;
    }

    dismissScopedError();
    setProcessingState({ status: 'analyzing', progress: 0 });
    try {
      const result = await analyzeSpriteSheet(imageUrl, aiConfig);
      setConfig(prev => ({
        ...prev,
        rows: result.rows ?? prev.rows,
        cols: result.cols ?? prev.cols,
        totalFrames: result.totalFrames ?? ((result.rows || prev.rows) * (result.cols || prev.cols))
      }));
      setProcessingState({ status: 'idle', progress: 0 });
    } catch (error) {
      console.error("Detection failed", error);
      const msg = error instanceof Error ? error.message : 'AI 识别失败，请手动设置。';
      setProcessingState({ status: 'idle', progress: 0 });
      // 错误贴在「自动识别」按钮下方：眼睛不用从工具栏移到画布底部
      showScopedError({
        message: msg,
        anchor: 'analyze',
        hint: '也可以在下方「分帧」里手动填写行数与列数。',
        action: {
          label: '打开 AI 设置',
          onClick: () => {
            dismissScopedError();
            setShowAiSettings(true);
          },
        },
      });
    }
  };

  const handleExportGif = async (fromRetry = false) => {
    if (!imageUrl) return;
    // 从「重试」进来时保留那条「正在重新导出…」，不要先清掉再重画
    if (!fromRetry) dismissNotice();
    setProcessingState({ status: 'rendering', progress: 0 });

    try {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();

      const result = await generateGif(img, config, dimensions, (pct) => {
        setProcessingState(prev => ({ ...prev, progress: pct }));
      });

      // 名字直接用真实结果：原文件名 + 实际写入帧数 + 成品像素尺寸
      const fileName = buildExportFileName({
        sourceName,
        frames: result.frames,
        width: result.width,
        height: result.height,
        extension: 'gif',
      });
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setProcessingState({ status: 'completed', progress: 100, completedKind: 'gif' });
      setTimeout(() => setProcessingState({ status: 'idle', progress: 0 }), 2200);
      showNotice({
        kind: 'success',
        title: 'GIF 已导出',
        fileName,
        detail: `${result.frames} 帧 · ${result.width}×${result.height} px · ${formatFileSize(result.blob.size)}`,
        shortDetail: `${result.width}×${result.height} · ${formatFileSize(result.blob.size)}`,
      }, 7000);

    } catch (e: any) {
      console.error(e);
      setProcessingState({ status: 'idle', progress: 0 });
      // 失败也留在导出栏里 —— 用户的手和眼睛都在这儿，不用再抬头去上面找
      showNotice({
        kind: 'error',
        title: 'GIF 导出失败',
        description: e?.message || '生成 GIF 失败，请检查参数后重试。',
        action: {
          label: '重试',
          onClick: () => retryExport('gif'),
        },
      }, 12000);
    }
  };

  const handleExportFrames = async (fromRetry = false) => {
    if (!imageUrl) return;
    if (!fromRetry) dismissNotice();
    setProcessingState({ status: 'rendering', progress: 0 });

    try {
      const img = new Image();
      img.src = imageUrl;
      await img.decode();

      const result = await exportFrames(img, config, dimensions, (pct) => {
        setProcessingState(prev => ({ ...prev, progress: pct }));
      });

      const fileName = buildExportFileName({
        sourceName,
        frames: result.frames,
        width: result.width,
        height: result.height,
        extension: 'zip',
      });
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setProcessingState({ status: 'completed', progress: 100, completedKind: 'zip' });
      setTimeout(() => setProcessingState({ status: 'idle', progress: 0 }), 2200);
      showNotice({
        kind: 'success',
        title: '逐帧已打包',
        fileName,
        detail: `${result.frames} 张 · 每张 ${result.width}×${result.height} px · ${formatFileSize(result.blob.size)}`,
        shortDetail: `${result.width}×${result.height} · ${formatFileSize(result.blob.size)}`,
      }, 7000);

    } catch (e: any) {
      console.error(e);
      setProcessingState({ status: 'idle', progress: 0 });
      showNotice({
        kind: 'error',
        title: '逐帧导出失败',
        description: e?.message || '导出帧失败，请检查参数后重试。',
        action: {
          label: '重试',
          onClick: () => retryExport('zip'),
        },
      }, 12000);
    }
  };

  // 每次渲染都把「最新版」导出函数挂到 ref 上。
  // 失败条里的重试按钮只认这个 ref，所以永远用的是当前参数，不会是失败那一刻的旧参数。
  exportHandlersRef.current = { gif: handleExportGif, zip: handleExportFrames };

  const updateConfig = (key: keyof SpriteConfig, value: any) => {
    setConfig(prev => {
       const next = { ...prev, [key]: value };
       if (key === 'rows' || key === 'cols') {
          if (prev.totalFrames === prev.rows * prev.cols) {
             next.totalFrames = next.rows * next.cols;
          }
       }
       return next;
    });
  };

  const updateCrop = (key: keyof CropConfig, value: number) => {
    setConfig(prev => ({
      ...prev,
      crop: {
        ...prev.crop,
        [key]: value
      }
    }));
  };

  const handleToggleFrame = (index: number) => {
    setConfig(prev => {
        const isExcluded = prev.excludedFrames.includes(index);
        let newExcluded;
        if (isExcluded) {
            newExcluded = prev.excludedFrames.filter(i => i !== index);
        } else {
            newExcluded = [...prev.excludedFrames, index];
        }
        return { ...prev, excludedFrames: newExcluded };
    });
  };

  /** 一键回到出厂参数。试错成本降为零，但留 8 秒「撤销」兜住误点 */
  const handleResetConfig = () => {
    const snapshot = { config, eraseMode, editMode, zoomFrame };
    setConfig(createInitialConfig());
    setEraseMode(false);
    setEditMode('erase');
    setZoomFrame(null);
    showToast({
      title: '参数已恢复默认',
      description: '分帧、裁剪、抠图、对齐与导出设置全部重置，图片保持不变。',
      action: {
        label: '撤销',
        onClick: () => {
          setConfig(snapshot.config);
          setEraseMode(snapshot.eraseMode);
          setEditMode(snapshot.editMode);
          setZoomFrame(snapshot.zoomFrame);
          showToast({ title: '已恢复重置前的参数' }, 3500);
        },
      },
    }, 8000);
  };

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-transparent text-slate-200 flex flex-col font-sans">
      <header className="shrink-0 glass-header sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center space-x-3">
             <div className="glass-card p-2 rounded-lg">
                <Layers className="text-indigo-300" size={24} strokeWidth={2} />
             </div>
             <div className="leading-none">
               <h1 className="text-[20px] font-semibold tracking-tight text-white">SpriteMotion</h1>
               <p className="text-[12px] text-slate-400 mt-1 tracking-wide">静态精灵图转 GIF 动画</p>
             </div>
          </div>

          <div className="flex items-center space-x-2">
            <a
              href="https://github.com/cyyberlilai/SpriteMotion"
              target="_blank"
              rel="noreferrer"
              className="px-2.5 py-1.5 text-slate-400 hover:text-white transition-colors duration-150 text-[14px]"
            >
              Github
            </a>
            <button
                onClick={() => setShowAiSettings(true)}
                className={`btn-glass lift flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium ${
                  aiResolved.hasKey
                    ? 'text-indigo-300 border-indigo-400/40'
                    : 'text-slate-200'
                }`}
                title={aiResolved.hasKey ? `${aiResolved.providerLabel} 已配置` : '设置 API Key 以启用自动识别'}
            >
                <Settings size={13} className={aiResolved.hasKey ? 'text-indigo-300' : 'text-slate-400'} />
                <span>{aiResolved.hasKey ? aiResolved.providerLabel : 'AI 设置'}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 lg:min-h-0 max-w-7xl w-full mx-auto px-4 md:px-6 py-5 grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 flex flex-col space-y-3 lg:min-h-0">
          {/* z-30：格式浮层和错误提示要压在下方画布之上（玻璃会生成独立层叠上下文） */}
          <div className="relative z-30 flex items-center justify-between px-3 py-2.5 rounded-lg glass">
            <div className="flex items-center space-x-2">
                <div className="relative group/upload">
                    <label className="flex items-center space-x-2 cursor-pointer btn-accent lift px-4 py-2 rounded-md text-[14px] font-medium focus-within:ring-2 focus-within:ring-indigo-300 focus-within:ring-offset-2 focus-within:ring-offset-slate-900">
                        <Upload size={16} />
                        <span>上传图片</span>
                        <Info size={13} className="opacity-60" aria-hidden="true" />
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleFileChange}
                            aria-describedby="upload-format-hint"
                            className="sr-only"
                        />
                    </label>

                    {/* 格式说明贴在按钮正下方：鼠标靠近、或键盘 Tab 聚焦时出现。
                        有就近错误时让位 —— 错误卡片已经占了同样的位置 */}
                    {!scopedError && (
                      <div
                        id="upload-format-hint"
                        role="tooltip"
                        className="pointer-events-none absolute left-0 top-full mt-2 z-40 w-[292px] rounded-xl glass-pill p-3.5 opacity-0 invisible -translate-y-1 transition-all duration-200 group-hover/upload:opacity-100 group-hover/upload:visible group-hover/upload:translate-y-0 group-focus-within/upload:opacity-100 group-focus-within/upload:visible group-focus-within/upload:translate-y-0"
                      >
                        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-white">
                          <Info size={14} className="text-indigo-300" />
                          <span>支持的图片格式</span>
                        </div>
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {SUPPORTED_IMAGE_FORMATS.map((f) => (
                            <span
                              key={f.label}
                              className="px-1.5 py-0.5 rounded bg-white/[0.08] border border-white/[0.10] text-[11px] font-mono text-slate-200"
                            >
                              {f.label}
                            </span>
                          ))}
                        </div>
                        <div className="mt-2.5 text-[11px] leading-relaxed text-slate-400">
                          其它浏览器可识别的图片格式也可导入
                        </div>
                        <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
                          也可拖入画布，或按 ⌘ / Ctrl + V 粘贴
                        </div>
                      </div>
                    )}
                    {scopedError?.anchor === 'upload' && (
                      <InlineError
                        message={scopedError.message}
                        hint={scopedError.hint}
                        action={scopedError.action}
                        onClose={dismissScopedError}
                      />
                    )}
                </div>

                <div className="relative">
                <button
                    onClick={handleAutoDetect}
                    disabled={!imageUrl || processingState.status === 'analyzing'}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-md text-[14px] font-medium transition-colors duration-150 border ${
                      !imageUrl
                        ? 'border-slate-800 text-slate-200 opacity-50 cursor-not-allowed'
                        : 'border-slate-700 text-indigo-300 hover:bg-slate-800 hover:border-slate-600 active:scale-[0.98]'
                    }`}
                >
                    {processingState.status === 'analyzing' ? <RefreshCw className="animate-spin" size={16} /> : <Sparkles size={16} />}
                    <span>自动识别</span>
                </button>
                    {scopedError?.anchor === 'analyze' && (
                      <InlineError
                        message={scopedError.message}
                        hint={scopedError.hint}
                        action={scopedError.action}
                        onClose={dismissScopedError}
                      />
                    )}
                </div>
            </div>
            {imageUrl && (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 bg-slate-950 rounded border border-slate-800 p-0.5">
                  <button
                    onClick={() => setZoomMode('fit')}
                    className={`px-2.5 py-1.5 min-h-[30px] rounded text-[12px] transition-colors duration-150 ${
                      zoomMode === 'fit'
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800'
                    }`}
                    title="缩放到刚好填满可视区域"
                  >
                    适配
                  </button>
                  <button
                    onClick={() => setZoomMode('actual')}
                    className={`px-2.5 py-1.5 min-h-[30px] rounded text-[12px] transition-colors duration-150 ${
                      zoomMode === 'actual'
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800'
                    }`}
                    title="按原始像素显示，1 个像素对应 1 个屏幕像素"
                  >
                    1:1
                  </button>
                </div>
                <div className="hidden sm:block text-[12px] font-mono tnum text-slate-500 tracking-tight">
                  {dimensions.width}x{dimensions.height} · {Math.round(canvasScale * 100)}%
                </div>
              </div>
            )}

          </div>

          <div className="relative flex-1 lg:min-h-0 bg-slate-900/40 rounded-lg border border-slate-800 p-1 flex flex-col h-[60vh] lg:h-auto min-h-[320px]">
             <SpriteCanvas
                imageUrl={imageUrl}
                config={config}
                onDimensionsLoaded={setDimensions}
                onToggleFrame={handleToggleFrame}
                onFileDrop={(file) => loadImageFile(file, 'drop')}
                onRequestPick={() => fileInputRef.current?.click()}
                dropError={scopedError?.anchor === 'drop' ? scopedError.message : null}
                onDropRejected={(message) => showScopedError({
                  message,
                  anchor: 'drop',
                  hint: `支持 ${SUPPORTED_FORMATS_LABEL}`,
                })}
                onDismissDropError={dismissScopedError}
                zoomMode={zoomMode}
                onScaleChange={setCanvasScale}
                eraseMode={eraseMode}
                editPoints={config.editPoints}
                onZoomFrame={setZoomFrame}
            />

            {/* 点选修边：浮在画布右上角，随时可点。开启后按钮直接显示当前模式 */}
            {imageUrl && (
              <div className="absolute right-3 top-3 z-30 flex items-center gap-1.5">
                <button
                  onClick={() => setEraseMode(v => !v)}
                  className={`flex items-center gap-1.5 pl-2 pr-2.5 py-1.5 rounded-md text-[12px] font-medium border shadow-lg backdrop-blur transition-colors duration-150 active:scale-[0.97] ${
                    eraseMode
                      ? editMode === 'erase'
                        ? 'bg-rose-600 border-rose-400 text-white'
                        : 'bg-emerald-600 border-emerald-400 text-white'
                      : 'bg-slate-900/90 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                  title={
                    eraseMode
                      ? `当前在${editMode === 'erase' ? '抠除' : '恢复'}模式，点一下即可关闭`
                      : '点一下画面放大，在放大图里抠除多余背景、或把被误抠掉的部分补回来'
                  }
                >
                  {eraseMode && editMode === 'restore' ? <PaintBucket size={14} /> : <Wand2 size={14} />}
                  <span>点选修边</span>
                  {eraseMode && (
                    <span className="px-1 rounded bg-black/25 text-[10px] leading-tight">
                      {editMode === 'erase' ? '抠除' : '恢复'}
                    </span>
                  )}
                  {config.editPoints.length > 0 && (
                    <span className="px-1 rounded bg-black/30 tnum leading-tight">{config.editPoints.length}</span>
                  )}
                </button>
                {config.editPoints.length > 0 && (
                  <button
                    onClick={() => updateConfig('editPoints', [])}
                    className="px-2 py-1.5 rounded-md text-[12px] bg-slate-900/90 border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white shadow-lg backdrop-blur transition-colors duration-150"
                    title="清空所有编辑（含抠除与恢复）"
                  >
                    清空
                  </button>
                )}
              </div>
            )}

            {/* 点选模式下的操作提示 */}
            {imageUrl && eraseMode && (
              <div className="absolute left-1/2 -translate-x-1/2 top-3 z-30 pointer-events-none">
                <div
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-white text-[12px] shadow-lg ${
                    editMode === 'erase' ? 'bg-rose-600/95' : 'bg-emerald-600/95'
                  }`}
                >
                  {editMode === 'erase' ? <Eraser size={13} /> : <PaintBucket size={13} />}
                  <span className="font-medium">{editMode === 'erase' ? '抠除' : '恢复'}</span>
                  <span className="text-white/60">|</span>
                  <span>
                    {editMode === 'erase'
                      ? '点一下画面放大，再点要抠掉的地方'
                      : '点一下画面放大，橙色区域点一下即可补回'}
                  </span>
                  <span className="text-white/60">· 按 R / X 切换 · Esc 退出</span>
                </div>
              </div>
            )}
          </div>

          {/* 错误不再落在画布底部：三类失败分别回到上传按钮 / 自动识别按钮 / 导出栏 */}
        </div>

        <div className="lg:col-span-5 flex flex-col gap-3 lg:min-h-0">
          <div className="relative lg:flex-1 lg:min-h-0 lg:min-h-0 flex flex-col">
          <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto space-y-3 lg:pr-1.5 lg:-mr-1.5 pb-1">
          <div className="rounded-lg p-3 glass">
            <h2 className="text-[14px] font-semibold text-slate-300 mb-2 flex items-center uppercase tracking-wider">
                <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full mr-2 animate-pulse"></span>
                实时预览
            </h2>
            <PreviewPlayer imageUrl={imageUrl} config={config} dimensions={dimensions} />
          </div>

          <div className="rounded-lg p-4 space-y-4 glass">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center space-x-2">
                    <Settings className="text-indigo-400" size={20} />
                    <h2 className="text-[18px] font-semibold text-white tracking-tight">参数设置</h2>
                </div>
                <button
                    type="button"
                    onClick={handleResetConfig}
                    className="btn-glass lift flex items-center gap-1.5 min-h-[30px] px-2.5 py-1.5 rounded-md text-[12px] font-medium text-slate-300 hover:text-white"
                    title={isConfigDirty ? '当前参数与默认值不同，点一下全部恢复' : '当前已是默认参数，也可点此重新载入'}
                >
                    <RotateCcw size={13} />
                    <span>重置参数</span>
                    {isConfigDirty && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />}
                </button>
            </div>

            {/* 重置后的「撤销」：贴近触发它的按钮，文档流内展开，不遮任何控件 */}
            <div
              ref={resetNoticeRef}
              style={{ scrollMarginBottom: 44 }}
              className={`grid transition-[grid-template-rows,margin] duration-300 ease-out ${
                toast ? 'grid-rows-[1fr] mt-2 mb-1' : 'grid-rows-[0fr] mt-0 mb-0'
              }`}
            >
              <div className="overflow-hidden min-h-0">
                {toast && (
                  <div
                    key={toast.id}
                    role="status"
                    aria-live="polite"
                    className="flex items-start gap-2 px-2.5 py-1.5 rounded-md border border-indigo-400/30 bg-indigo-500/[0.08]"
                  >
                    <RotateCcw size={13} className="text-indigo-300 shrink-0 mt-[3px]" />
                    <div className="min-w-0 flex-1 py-[1px]">
                      <div className="text-[11.5px] font-semibold text-indigo-100">{toast.title}</div>
                      {toast.description && (
                        <div className="mt-0.5 text-[11px] leading-relaxed text-slate-400 break-words">
                          {toast.description}
                        </div>
                      )}
                    </div>
                    {toast.action && (
                      <button
                        type="button"
                        onClick={toast.action?.onClick}
                        className="shrink-0 mt-[1px] px-2 py-0.5 rounded btn-glass text-[11px] font-medium text-slate-100 hover:text-white transition-colors duration-150"
                      >
                        {toast.action.label}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={dismissToast}
                      className="shrink-0 p-0.5 -mr-1 rounded text-slate-500 hover:text-white hover:bg-white/10 transition-colors duration-150"
                      aria-label="关闭提示"
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* 分帧：行列、读取顺序、序列长度合成一个可折叠块 */}
            <div>
               <button
                  onClick={() => setShowGrid(v => !v)}
                  aria-expanded={showGrid}
                  className="w-full flex items-center justify-between text-slate-400 hover:text-slate-200 transition-colors duration-150 py-2"
               >
                   <div className="flex items-center space-x-2">
                      <Grid2x2 size={16} />
                      <h3 className="text-[12px] font-medium uppercase tracking-[0.08em]">分帧</h3>
                      {!showGrid && (
                        <span className="text-[12px] text-slate-500 tracking-normal">
                          <span className="font-mono tnum">{config.rows} × {config.cols}</span>
                          <span className="mx-1 text-slate-600">·</span>
                          {config.readOrder === 'column-major' ? '垂直优先' : '水平优先'}
                        </span>
                      )}
                   </div>
                   <ChevronDown
                     size={16}
                     className={`transition-transform duration-200 ${showGrid ? 'rotate-180' : ''}`}
                   />
               </button>
               {showGrid && (
                 <div className="pt-3 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                       <NumberInput label="行数" value={config.rows} onChange={(val) => updateConfig('rows', val)} />
                       <NumberInput label="列数" value={config.cols} onChange={(val) => updateConfig('cols', val)} />
                    </div>
                    <div>
                       <div className="text-[12px] font-medium text-slate-500 uppercase tracking-[0.08em] mb-1.5">读取顺序</div>
                       <div className="flex bg-slate-950 border border-slate-800 rounded-md p-1 gap-1">
                          <button
                              onClick={() => updateConfig('readOrder', 'row-major')}
                              className={`flex-1 flex items-center justify-center space-x-1 px-2.5 py-1.5 rounded text-[12px] transition-colors duration-150 ${config.readOrder === 'row-major' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                          >
                              <ArrowRight size={14} />
                              <span>水平优先</span>
                          </button>
                          <button
                               onClick={() => updateConfig('readOrder', 'column-major')}
                               className={`flex-1 flex items-center justify-center space-x-1 px-2.5 py-1.5 rounded text-[12px] transition-colors duration-150 ${config.readOrder === 'column-major' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                          >
                              <ArrowDown size={14} />
                              <span>垂直优先</span>
                          </button>
                       </div>
                    </div>
                    <div className="space-y-2">
                         <div className="flex justify-between items-baseline">
                            <label className="text-[12px] font-medium text-slate-500 uppercase tracking-[0.08em]">序列长度</label>
                            <span className="text-[12px] text-slate-500 tnum">最大 {config.rows * config.cols}</span>
                         </div>
                         <input
                            type="range"
                            min="1"
                            max={config.rows * config.cols}
                            value={config.totalFrames}
                            onChange={(e) => updateConfig('totalFrames', parseInt(e.target.value))}
                            className="w-full rounded-full"
                            style={
                              {
                                '--fill': `${((config.totalFrames - 1) / Math.max(1, config.rows * config.cols - 1)) * 100}%`,
                              } as React.CSSProperties
                            }
                         />
                         <div className="flex justify-between text-[12px] text-slate-400 pt-0.5">
                            <span>截取前 {config.totalFrames} 帧</span>
                            <span className="text-indigo-300">实际生成: {config.totalFrames - config.excludedFrames.filter(i => i < config.totalFrames).length} 帧</span>
                         </div>
                    </div>
                 </div>
               )}
            </div>


            <div className="border-t border-slate-800 pt-4">
               <button
                  onClick={() => setShowCrop(v => !v)}
                  aria-expanded={showCrop}
                  className="w-full flex items-center justify-between text-slate-400 hover:text-slate-200 transition-colors duration-150 py-2 group"
               >
                   <div className="flex items-center space-x-2">
                      <Scissors size={16} />
                      <h3 className="text-[12px] font-medium uppercase tracking-[0.08em]">单帧裁剪</h3>
                      {hasCrop && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-indigo-500"
                          title="已有裁剪设置"
                        />
                      )}
                   </div>
                   <ChevronDown
                     size={16}
                     className={`transition-transform duration-200 ${showCrop ? 'rotate-180' : ''}`}
                   />
               </button>
               {showCrop && (
                 <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 pt-3">
                    <NumberInput label="上边距" value={config.crop.top} min={0} onChange={(val) => updateCrop('top', val)} />
                    <NumberInput label="下边距" value={config.crop.bottom} min={0} onChange={(val) => updateCrop('bottom', val)} />
                    <NumberInput label="左边距" value={config.crop.left} min={0} onChange={(val) => updateCrop('left', val)} />
                    <NumberInput label="右边距" value={config.crop.right} min={0} onChange={(val) => updateCrop('right', val)} />
                 </div>
               )}
            </div>

            {/* 背景透明化：抠图主设置（透明色值 / 容差 / 保护内部颜色 / 点选抠除 / 边缘处理） */}
            <div className="pt-4 border-t border-slate-800">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2 text-slate-400">
                         <Palette size={16} />
                        <h3 className="text-[12px] font-medium uppercase tracking-[0.08em]">背景透明化</h3>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={config.transparent !== null} onChange={(e) => updateConfig('transparent', e.target.checked ? '#ffffff' : null)} />
                        <div className="w-9 h-5 bg-slate-700 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-200 after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-transform after:duration-150 toggle-track peer-checked:bg-indigo-500 transition-colors"></div>
                    </label>
                </div>

                {config.transparent !== null && (
                    <div className="bg-slate-950 p-3 rounded-md border border-slate-800 space-y-3">
                        <div className="flex items-center space-x-3">
                             <input type="color" value={config.transparent} onChange={(e) => updateConfig('transparent', e.target.value)} className="h-9 w-12 cursor-pointer rounded bg-transparent border border-slate-700 p-0.5" />
                             <div className="flex-1">
                                 <div className="text-[13px] font-medium text-white">透明色值</div>
                                 <div className="text-[12px] text-slate-500 font-mono uppercase tnum">{config.transparent}</div>
                             </div>
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex justify-between text-[12px] items-baseline">
                                <span className="text-slate-400">颜色容差 (Fuzziness)</span>
                                <span className="font-mono tnum text-indigo-300">{config.tolerance}%</span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="50"
                                step="1"
                                value={config.tolerance}
                                onChange={(e) => updateConfig('tolerance', parseInt(e.target.value))}
                                className="w-full rounded-full"
                                style={
                                  {
                                    '--fill': `${(config.tolerance / 50) * 100}%`,
                                  } as React.CSSProperties
                                }
                            />
                        </div>

                        <div className="flex items-center justify-between px-2.5 py-2 rounded glass-card ">
                             <div className="flex items-center space-x-2 text-[12px] text-slate-300">
                                {config.useFloodFill ? <ShieldCheck size={13} className="text-indigo-400"/> : <ShieldAlert size={13} className="text-warning-400"/>}
                                <span>保护主体内部颜色</span>
                             </div>
                             <label className="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" className="sr-only peer" checked={config.useFloodFill} onChange={(e) => updateConfig('useFloodFill', e.target.checked)} />
                                <div className="w-7 h-4 bg-slate-700 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-200 after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-transform after:duration-150 toggle-track peer-checked:bg-indigo-500 transition-colors"></div>
                             </label>
                        </div>

                        {/* 点选手动修边：自动判据两头都会错 —— 该抠的封闭白口袋抠不掉，
                            该留的细结构（拇指、手指）又可能被啃掉一块。这里把判断权交给用户 */}
                        <div className={`px-2.5 py-2 rounded glass-card space-y-2 transition-all duration-150 ${
                            eraseMode ? 'outline outline-1 outline-rose-600/80' : ''
                        }`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-2 text-[12px] text-slate-300">
                                    <Wand2 size={13} className={eraseMode ? 'text-rose-400' : 'text-slate-500'} />
                                    <span>点选修边</span>
                                    {config.editPoints.length > 0 && (
                                        <button
                                            onClick={() => updateConfig('editPoints', [])}
                                            className="px-1 rounded text-[11px] text-slate-500 hover:text-white hover:bg-slate-800 transition-colors duration-150"
                                            title="清空所有编辑（含抠除与恢复）"
                                        >
                                            清空
                                        </button>
                                    )}
                                </div>
                                <label className={`relative inline-flex items-center cursor-pointer ${imageUrl ? '' : 'opacity-40 cursor-not-allowed'}`}>
                                    <input
                                        type="checkbox"
                                        className="sr-only peer"
                                        checked={eraseMode}
                                        disabled={!imageUrl}
                                        onChange={(e) => setEraseMode(e.target.checked)}
                                    />
                                    <div className="w-7 h-4 bg-slate-700 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-200 after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-transform after:duration-150 toggle-track peer-checked:bg-indigo-500 transition-colors"></div>
                                </label>
                            </div>
                            {/* 模式选择：开着时才出现。和放大窗里那对按钮是同一个状态，改哪边都一样 */}
                            {eraseMode && (
                                <div className="grid grid-cols-2 gap-1">
                                    <button
                                        onClick={() => setEditMode('erase')}
                                        className={`flex items-center justify-center gap-1 py-1 rounded text-[11px] font-medium border transition-colors duration-150 ${
                                            editMode === 'erase'
                                                ? 'bg-rose-600 border-rose-500 text-white'
                                                : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-800'
                                        }`}
                                        title="抠掉与点击处同色且相连的整块（快捷键 X）"
                                    >
                                        <Eraser size={12} />
                                        <span>抠除</span>
                                    </button>
                                    <button
                                        onClick={() => setEditMode('restore')}
                                        className={`flex items-center justify-center gap-1 py-1 rounded text-[11px] font-medium border transition-colors duration-150 ${
                                            editMode === 'restore'
                                                ? 'bg-emerald-600 border-emerald-500 text-white'
                                                : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-800'
                                        }`}
                                        title="把被误抠掉的那一块补回来（快捷键 R）"
                                    >
                                        <PaintBucket size={12} />
                                        <span>恢复</span>
                                    </button>
                                </div>
                            )}
                            <p className="text-[11px] leading-relaxed text-slate-500">
                                {eraseMode
                                    ? editMode === 'erase'
                                        ? '点一下画面先放大，再点要抠掉的地方。第一次点击只放大，不会改动。'
                                        : '点一下画面先放大，橙色区域就是被误抠掉的部分，点它补回来。'
                                    : '自动抠图可能多抠（细结构被啃掉）也可能少抠（封闭白块留着）。开启后放大画面逐处修。'}
                                {config.editPoints.length > 0 && (
                                    <span className="text-rose-300">
                                        {' '}
                                        {eraseCount > 0 && <>已抠除 {eraseCount} 处</>}
                                        {eraseCount > 0 && restoreCount > 0 && ' · '}
                                        {restoreCount > 0 && (
                                            <span className="text-emerald-300">已恢复 {restoreCount} 处</span>
                                        )}
                                    </span>
                                )}
                            </p>
                        </div>

                        <div className="pt-1">
                           <button
                              onClick={() => setShowEdge(v => !v)}
                              aria-expanded={showEdge}
                              className="w-full flex items-center justify-between text-slate-500 hover:text-slate-300 transition-colors duration-150"
                           >
                              <span className="text-[12px] font-medium uppercase tracking-[0.08em]">边缘处理</span>
                              <ChevronDown
                                size={14}
                                className={`transition-transform duration-200 ${showEdge ? 'rotate-180' : ''}`}
                              />
                           </button>
                           {showEdge && (
                             <div className="space-y-2 pt-2">
                          <div className="px-2.5 py-2 rounded glass-card space-y-1" title="按局部对比度决定边缘切点，让切口落在真正轮廓上，减少锯齿和白边">
                               <div className="flex items-center justify-between">
                                 <div className="flex items-center space-x-2 text-[12px] text-slate-300">
                                    <Blend size={13} className={config.alphaRatio ? 'text-indigo-400' : 'text-slate-500'} />
                                    <span>α 比例判定</span>
                                 </div>
                                 <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" className="sr-only peer" checked={config.alphaRatio} onChange={(e) => updateConfig('alphaRatio', e.target.checked)} />
                                    <div className="w-7 h-4 bg-slate-700 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-200 after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-transform after:duration-150 toggle-track peer-checked:bg-indigo-500 transition-colors"></div>
                                  </label>
                               </div>
                               <p className="text-[11px] leading-relaxed text-slate-500">
                                  按局部对比度抠边，抗锯齿图开、像素画可关。
                               </p>
                          </div>

                          <div
                               className="px-2.5 py-2 rounded glass-card space-y-2"
                               title={config.alphaRatio ? '数值越大，边缘残留的背景色压得越狠；头发丝这类细结构需要更高数值。关闭「α 比例判定」时本项一并停用' : '已随「α 比例判定」一起关闭，当前不生效；开启后才按这个强度处理'}
                          >
                               <div className={`flex items-center justify-between transition-opacity duration-200 ${config.alphaRatio ? '' : 'opacity-50'}`}>
                                  <div className="flex items-center space-x-2 text-[12px] text-slate-300">
                                     <Eraser size={13} className={config.despillStrength > 0 && config.alphaRatio ? 'text-indigo-400' : 'text-slate-500'} />
                                     <span>去色溢出</span>
                                  </div>
                                  <span className={`text-[12px] font-mono tnum ${config.alphaRatio ? 'text-indigo-300' : 'text-slate-500'}`}>
                                    {config.alphaRatio ? `${config.despillStrength}%` : '未启用'}
                                  </span>
                               </div>
                               <input
                                  type="range"
                                  min="0"
                                  max="100"
                                  step="5"
                                  value={config.despillStrength}
                                  disabled={!config.alphaRatio}
                                  onChange={(e) => updateConfig('despillStrength', parseInt(e.target.value))}
                                  className={`w-full rounded-full disabled:cursor-not-allowed transition-opacity duration-200 ${config.alphaRatio ? '' : 'opacity-50'}`}
                                  style={
                                    {
                                      '--fill': `${config.despillStrength}%`,
                                    } as React.CSSProperties
                                  }
                               />
                               {/* 这行说明不跟着变暗：它是「为什么现在不可用」的唯一解释，灰掉反而读不清 */}
                               <p className="text-[11px] leading-relaxed text-slate-500">
                                  去掉边缘残留的底色，纯色背景都有效；发丝这类细边最明显，浅色主体调低。
                               </p>
                          </div>
                             </div>
                           )}
                        </div>
                    </div>
                )}
            </div>

            {/* Auto Align Section */}
            <div className="border-t border-slate-800 pt-4">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-2 text-slate-400">
                        <Target size={16} />
                        <h3 className="text-[12px] font-medium uppercase tracking-[0.08em]">智能对齐</h3>
                    </div>
                     <label className="relative inline-flex items-center cursor-pointer">
                        <input
                            type="checkbox"
                            className="sr-only peer"
                            checked={config.autoAlign}
                            onChange={(e) => updateConfig('autoAlign', e.target.checked)}
                        />
                        <div className="w-9 h-5 bg-slate-700 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-200 after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-transform after:duration-150 toggle-track peer-checked:bg-indigo-500 transition-colors"></div>
                    </label>
                </div>

                {config.autoAlign && (
                    <div className="bg-slate-950 p-3 rounded-md border border-slate-800 space-y-2">
                        {config.transparent === null && (
                            <div className="flex items-start gap-1.5 px-2 py-1.5 rounded border border-warning-800/70 bg-warning-900/20">
                                <AlertTriangle size={12} className="text-warning-400 shrink-0 mt-[1px]" />
                                <span className="text-[12px] text-warning-400/90 leading-relaxed">
                                    需先开启下方「背景透明化」才能识别主体，否则对齐不会生效。
                                </span>
                            </div>
                        )}
                        <div className="text-[12px] text-slate-500 leading-relaxed">
                            系统将自动扫描每一帧的主体内容，并重新构建画布以保持动画稳定。
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                onClick={() => updateConfig('alignMode', 'center')}
                                className={`flex flex-col items-center justify-center p-2 rounded border transition-colors duration-150 ${config.alignMode === 'center' ? 'bg-indigo-900/40 border-indigo-600 text-indigo-200' : 'bg-slate-900 border-slate-700 text-slate-500 hover:bg-slate-800'}`}
                            >
                                <AlignCenter size={16} className="mb-1"/>
                                <span className="text-[10px] font-bold">居中对齐</span>
                            </button>
                            <button
                                onClick={() => updateConfig('alignMode', 'bottom')}
                                className={`flex flex-col items-center justify-center p-2 rounded border transition-colors duration-150 ${config.alignMode === 'bottom' ? 'bg-indigo-900/40 border-indigo-600 text-indigo-200' : 'bg-slate-900 border-slate-700 text-slate-500 hover:bg-slate-800'}`}
                            >
                                <ArrowDownToLine size={16} className="mb-1"/>
                                <span className="text-[10px] font-medium">底部对齐 (防抖动)</span>
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-2 gap-3 pt-4 border-t border-slate-800">
                 <NumberInput label="帧率 (FPS)" value={config.fps} min={1} max={60} onChange={(val) => updateConfig('fps', val)} />
                <div className="space-y-2">
                    <label className="text-[12px] font-medium text-slate-500 uppercase tracking-[0.08em]">导出缩放比例</label>
                     <select
                        value={config.scale}
                        onChange={(e) => updateConfig('scale', parseFloat(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-700 rounded-md px-2.5 py-2 text-white text-[13px] focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600 outline-none h-[38px] transition-colors duration-150 cursor-pointer"
                    >
                        <option value={1}>1x (原始大小)</option>
                        <option value={2}>2x (放大)</option>
                        <option value={4}>4x (像素复古)</option>
                        <option value={0.5}>0.5x (缩小)</option>
                    </select>

                     <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center space-x-1 text-slate-500" title="若导出尺寸超过1024px，将自动按比例缩小至1024px以内">
                            <Maximize size={12} />
                            <span className="text-[10px]">限制最大边长 1024px</span>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input
                                type="checkbox"
                                className="sr-only peer"
                                checked={config.maxResolution1024}
                                onChange={(e) => updateConfig('maxResolution1024', e.target.checked)}
                            />
                            <div className="w-7 h-4 bg-slate-700 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-200 after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-transform after:duration-150 toggle-track peer-checked:bg-indigo-500 transition-colors"></div>
                        </label>
                    </div>
                </div>
            </div>

                      </div>
          {/* 滚动到底时提示还有内容 */}
          <div className="hidden lg:block pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-slate-950 to-transparent" />
          </div>
          </div>

          {/* 导出栏：常驻底部，不随参数面板滚动。
              成功与失败共用同一条「行内状态条」，它是导出栏里的普通子元素（文档流内），
              所以物理上不可能盖住任何控件 —— 参数面板只会被正常地挤一下。
              失败只是长得高一点（多一行原因 + 一个「重试」），不再单独弹浮层。 */}
          <div ref={exportBarRef} className="relative z-20 shrink-0 rounded-lg p-2.5 glass">
            {/* 用 grid 的 0fr → 1fr 做高度过渡：内容多高都能量，且不需要预留空白 */}
            <div
              className={`grid transition-[grid-template-rows,margin] duration-300 ease-out ${
                notice ? 'grid-rows-[1fr] mb-2' : 'grid-rows-[0fr] mb-0'
              }`}
            >
              <div className="overflow-hidden min-h-0">
                {notice && (
                  <div
                    key={notice.id}
                    role={notice.kind === 'error' ? 'alert' : 'status'}
                    aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
                    title={
                      notice.kind === 'success'
                        ? `${notice.fileName} · ${notice.detail}`
                        : notice.description
                    }
                    className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md border transition-opacity duration-[380ms] ${
                      noticeFading ? 'opacity-0' : 'opacity-100'
                    } ${
                      notice.kind === 'error'
                        ? 'border-rose-400/30 bg-rose-500/[0.08]'
                        : 'border-emerald-400/25 bg-emerald-500/[0.07]'
                    }`}
                  >
                    {notice.pending ? (
                      <RefreshCw size={14} className="text-rose-300 shrink-0 mt-[3px] animate-spin" />
                    ) : notice.kind === 'error' ? (
                      <AlertTriangle size={14} className="text-rose-300 shrink-0 mt-[3px]" />
                    ) : (
                      <CheckCircle2 size={14} className="text-emerald-300 shrink-0 mt-[3px]" />
                    )}

                    {notice.kind === 'error' ? (
                      // 失败：标题 + 原因，允许折行 —— 信息量本来就比成功大
                      <div className="min-w-0 flex-1 py-[1px]">
                        <div className="text-[11.5px] font-semibold text-rose-100">{notice.title}</div>
                        {notice.description && (
                          <div className="mt-0.5 text-[11px] leading-relaxed text-rose-200/85 break-words">
                            {notice.description}
                          </div>
                        )}
                      </div>
                    ) : (
                      // 成功：单行，标题 · 文件名 · 明细
                      <div className="min-w-0 flex-1 flex items-center gap-2 h-[18px]">
                        <span className="text-[11.5px] font-semibold text-emerald-200 shrink-0">
                          {notice.title}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (notice.fileName) navigator.clipboard?.writeText(notice.fileName).catch(() => {});
                          }}
                          title={`复制文件名：${notice.fileName}`}
                          className="text-[11.5px] font-mono text-slate-200 hover:text-white underline decoration-slate-500/60 underline-offset-2 flex-1 min-w-0 truncate text-left transition-colors duration-150"
                        >
                          {notice.fileName}
                        </button>
                        {/* 窄屏一行放不下完整明细：换成简版，完整信息仍在 title 里 */}
                        <span className="hidden sm:inline text-[11px] text-slate-400 tnum shrink-0">
                          {notice.detail}
                        </span>
                        <span className="sm:hidden text-[11px] text-slate-400 tnum shrink-0">
                          {notice.shortDetail}
                        </span>
                      </div>
                    )}

                    {/* 重试中不显示「重试」（防连点）也不显示关闭，等结果自己回来 */}
                    {notice.action && !notice.pending && (
                      <button
                        type="button"
                        onClick={notice.action?.onClick}
                        className="shrink-0 mt-[1px] px-2 py-0.5 rounded btn-glass text-[11px] font-medium text-slate-100 hover:text-white transition-colors duration-150"
                      >
                        {notice.action.label}
                      </button>
                    )}
                    {!notice.pending && (
                      <button
                        type="button"
                        onClick={dismissNotice}
                        className="shrink-0 p-0.5 -mr-1 rounded text-slate-500 hover:text-white hover:bg-white/10 transition-colors duration-150"
                        aria-label="关闭导出提示"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-2">
                <button
                    onClick={handleExportGif}
                    disabled={!imageUrl || processingState.status === 'rendering'}
                    className={`flex-1 flex items-center justify-center space-x-2 py-3 rounded-md font-semibold text-[16px] transition-colors duration-150 active:scale-[0.99]
                    ${!imageUrl
                  ? 'bg-white/[0.04] text-slate-600 cursor-not-allowed border border-white/[0.06]'
                        : processingState.status === 'rendering'
                  ? 'btn-accent opacity-70 cursor-wait'
                  : 'btn-accent lift'
                    }`}
                >
                    {processingState.status === 'rendering' ? (
                        <>
                            <RefreshCw className="animate-spin" size={18} />
                            <span className="tnum">生成中 {processingState.progress}%</span>
                        </>
                    ) : processingState.status === 'completed' && processingState.completedKind === 'gif' ? (
                        <>
                            <CheckCircle2 size={18} />
                            <span>已导出</span>
                        </>
                    ) : (
                        <>
                            <Download size={18} />
                            <span>导出 GIF</span>
                        </>
                    )}
                </button>

                <button
                    onClick={handleExportFrames}
                    disabled={!imageUrl || processingState.status === 'rendering'}
                    className={`flex-1 flex items-center justify-center space-x-2 py-3 rounded-md font-semibold text-[16px] transition-colors duration-150 active:scale-[0.99]
                    ${!imageUrl
                        ? 'bg-white/[0.04] text-slate-600 border border-white/[0.06] cursor-not-allowed'
                        : processingState.status === 'rendering'
                           ? 'btn-glass opacity-60 text-slate-400 cursor-wait'
                           : 'btn-glass lift text-slate-200'
                    }`}
                >
                     {processingState.status === 'completed' && processingState.completedKind === 'zip'
                       ? <CheckCircle2 size={18} />
                       : <Images size={18} />}
                     <span>{processingState.status === 'completed' && processingState.completedKind === 'zip' ? '已打包' : '导出每一帧 (ZIP)'}</span>
                </button>
            </div>
          </div>
        </div>
      </main>

      <AiSettingsModal
        open={showAiSettings}
        config={aiConfig}
        onClose={() => setShowAiSettings(false)}
        onSave={handleSaveAiConfig}
        onClear={handleClearAiConfig}
      />

      {/* 单格放大编辑：九宫格里每格太小，放大了才好点 */}
      {zoomFrame !== null && imageUrl && (
        <FrameZoomModal
          imageUrl={imageUrl}
          config={config}
          dimensions={dimensions}
          target={zoomTarget}
          frameIndex={zoomFrame}
          mode={editMode}
          onModeChange={setEditMode}
          onAddEditPoint={(pt) => updateConfig('editPoints', [...config.editPoints, pt])}
          onUndo={(index) =>
            updateConfig('editPoints', config.editPoints.filter((_, k) => k !== index))
          }
          onClear={() => updateConfig('editPoints', [])}
          onClose={() => setZoomFrame(null)}
        />
      )}
    </div>
  );
};

export default App;
