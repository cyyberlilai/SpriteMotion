import React, { useEffect, useRef, useState } from 'react';
import { SpriteConfig, ImageDimensions, EditPoint } from '../types';
import { X, Wand2, Undo2, Eraser, PaintBucket } from 'lucide-react';
import {
  buildBackgroundMask,
  mapEditSeeds,
  selectMagicWandRegion,
  RESTORE_BG_TOL,
  RGB,
} from '../utils/backgroundRemoval';

type EditMode = 'erase' | 'restore';

interface FrameZoomModalProps {
  imageUrl: string;
  config: SpriteConfig;
  dimensions: ImageDimensions;
  /** 透明色值（背景色）。用来判断「这块本来是不是背景」 */
  target: RGB;
  /** 要编辑的帧序号（0 基，和总帧数同一套编号） */
  frameIndex: number;
  /** 当前模式：抠除 / 恢复。由外层持有，和面板上的选择保持同步 */
  mode: EditMode;
  onModeChange: (mode: EditMode) => void;
  onAddEditPoint: (pt: EditPoint) => void;
  /** 撤销上一步（按索引从 editPoints 里移除） */
  onUndo: (index: number) => void;
  onClear: () => void;
  onClose: () => void;
}

/**
 * 单格放大编辑弹窗。
 *
 * 为什么要它：九宫格素材在画布里每一格只有几十像素，魔术棒点不准。
 * 这里把选中那一格按窗口大小等比放大后铺满，点选精度直接跟格子实际像素一一对应。
 *
 * 两种编辑：
 * · 抠除 —— 与点击处颜色相近且连通的整块 → 透明（去掉多余背景／白缝）
 * · 恢复 —— 被误抠掉的那层皮 → 补回不透明（拇指、手指被削细时用）
 * 恢复之所以可行，是因为抠图链路不写原图：每帧都重新 getImageData，只把 α 写回，
 * RGB 从未被破坏，所以补回来就是它本来的颜色。
 *
 * 画面上的配色：
 * 蓝 = 本次要抠掉的选区，橙 = 当前被抠掉但原图颜色并不是背景的地方（该恢复的区域），
 * 绿环 = 已经做过的恢复点。
 *
 * 坐标约定：点击 → 帧内相对坐标 → 换回原图归一化坐标存进 config.editPoints，
 * 所以放大窗里改的和预览 / 导出改的是同一处。
 */
export const FrameZoomModal: React.FC<FrameZoomModalProps> = ({
  imageUrl,
  config,
  dimensions,
  target,
  frameIndex,
  mode,
  onModeChange,
  onAddEditPoint,
  onUndo,
  onClear,
  onClose,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const baseDataRef = useRef<Uint8ClampedArray | null>(null);
  // 重画函数放在 ref 里：图片加载完和选区变化时都要调，避免两个 effect 互相依赖
  const paintRef = useRef<() => void>(() => {});
  const [box, setBox] = useState({ w: 0, h: 0 });
  // 撤销 / 操作反馈，1.6s 自动消失
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1600);
  };

  const { rows, cols, crop, readOrder = 'row-major' } = config;
  const frameWidthRaw = dimensions.width / Math.max(1, cols);
  const frameHeightRaw = dimensions.height / Math.max(1, rows);
  const cropW = Math.max(1, Math.floor(frameWidthRaw - crop.left - crop.right));
  const cropH = Math.max(1, Math.floor(frameHeightRaw - crop.top - crop.bottom));

  let col: number;
  let row: number;
  if (readOrder === 'column-major') {
    row = frameIndex % Math.max(1, rows);
    col = Math.floor(frameIndex / Math.max(1, rows));
  } else {
    col = frameIndex % Math.max(1, cols);
    row = Math.floor(frameIndex / Math.max(1, cols));
  }
  const srcX = col * frameWidthRaw + crop.left;
  const srcY = row * frameHeightRaw + crop.top;

  // 落在这个格子里、按点击顺序排好的编辑点索引。
  // 撤销只作用于「本帧最后一次操作」——在一个「帧 N 放大」的窗口里按 Ctrl+Z，
  // 用户期望撤回的是自己刚在这一帧做的事，而不是别的帧里的。
  const pointsInFrame: number[] = [];
  for (let i = 0; i < config.editPoints.length; i++) {
    const pt = config.editPoints[i];
    const px = pt.x * dimensions.width;
    const py = pt.y * dimensions.height;
    if (px >= srcX && py >= srcY && px < srcX + cropW && py < srcY + cropH) {
      pointsInFrame.push(i);
    }
  }
  const canUndo = pointsInFrame.length > 0;
  const restoredInFrame = pointsInFrame.filter((i) => config.editPoints[i].mode === 'restore').length;

  // 快捷键提示按平台显示，Mac 写 ⌘Z、其他写 Ctrl+Z
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
  const undoKeyLabel = isMac ? '⌘Z' : 'Ctrl+Z';

  const handleUndo = () => {
    if (!canUndo) {
      showToast('这一帧还没有操作可撤销');
      return;
    }
    onUndo(pointsInFrame[pointsInFrame.length - 1]);
    showToast('已撤销上一步 · 该操作已取消');
  };

  // 键盘：Esc 关闭，Ctrl/⌘+Z 撤销，X / R 切模式。
  // 故意不传依赖数组：每次渲染都重新订阅，避免闭包里拿到旧的 canUndo / onUndo。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        handleUndo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'x' || e.key === 'X') onModeChange('erase');
      if (e.key === 'r' || e.key === 'R') onModeChange('restore');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 卸载时清掉 toast 定时器
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
  }, []);

  // 计算画布显示尺寸：等比放大到刚好铺满可用区域
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const recalc = () => {
      const availW = el.clientWidth;
      const availH = el.clientHeight;
      if (availW <= 0 || availH <= 0) return;
      const k = Math.min(availW / cropW, availH / cropH);
      setBox({ w: Math.max(1, Math.round(cropW * k)), h: Math.max(1, Math.round(cropH * k)) });
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cropW, cropH]);

  // 载入这一格的像素
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || dimensions.width === 0) return;
    cv.width = cropW;
    cv.height = cropH;

    const img = new Image();
    img.onload = () => {
      const base = document.createElement('canvas');
      base.width = cropW;
      base.height = cropH;
      const bctx = base.getContext('2d', { willReadFrequently: true });
      if (!bctx) return;
      bctx.imageSmoothingEnabled = false;
      bctx.drawImage(img, srcX, srcY, cropW, cropH, 0, 0, cropW, cropH);
      baseRef.current = base;
      baseDataRef.current = bctx.getImageData(0, 0, cropW, cropH).data;
      paintRef.current();
    };
    img.src = imageUrl;
  }, [imageUrl, srcX, srcY, cropW, cropH, dimensions.width]);

  // 编辑点变化时重画
  useEffect(() => {
    paintRef.current = () => {
      const cv = canvasRef.current;
      const base = baseRef.current;
      const data = baseDataRef.current;
      if (!cv || !base || !data) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, cropW, cropH);
      ctx.drawImage(base, 0, 0);

      // 本帧内的编辑点（帧内像素坐标）
      const seeds = mapEditSeeds(
        config.editPoints,
        dimensions.width,
        dimensions.height,
        srcX,
        srcY,
        cropW,
        cropH,
        cropW,
        cropH
      );

      // 跑一遍这一帧的真实抠图结果，用来标出「被抠掉、但原图并不是背景」的地方。
      // 用户就是照这个标记去点恢复的，比凭手感在棋盘格里猜准得多。
      const mask = buildBackgroundMask(new Uint8ClampedArray(data), cropW, cropH, {
        target,
        tolerance: config.tolerance,
        floodFill: config.useFloodFill !== false,
        alphaRatio: config.alphaRatio !== false,
        edits: seeds,
      });

      // 抠除选区（只在有 erase 点时才需要算）
      const eraseSeeds = seeds.filter((s) => s.mode !== 'restore');
      const wand = eraseSeeds.length > 0
        ? selectMagicWandRegion(data, cropW, cropH, eraseSeeds)
        : null;

      // 叠加层一次画完：橙 = 被误抠，蓝 = 待抠除
      const layer = ctx.createImageData(cropW, cropH);
      let painted = 0;
      for (let y = 0; y < cropH; y++) {
        for (let x = 0; x < cropW; x++) {
          const p = y * cropW + x;
          const i = p * 4;
          const isWand = wand ? wand[p] === 1 : false;
          let color: [number, number, number, number] | null = null;
          if (isWand) {
            color = [56, 189, 248, 96]; // 蓝：待抠除
          } else if (mask.alpha[p] < 128) {
            // 当前透明 —— 但原图颜色明显不是背景 → 这里本来该有东西，是被误抠的
            const dr = data[i] - target.r;
            const dg = data[i + 1] - target.g;
            const db = data[i + 2] - target.b;
            if (dr * dr + dg * dg + db * db > RESTORE_BG_TOL * RESTORE_BG_TOL && data[i + 3] > 0) {
              color = [251, 146, 60, 92]; // 橙：被误抠
            }
          }
          if (!color) continue;
          layer.data[i] = color[0];
          layer.data[i + 1] = color[1];
          layer.data[i + 2] = color[2];
          layer.data[i + 3] = color[3];
          painted++;
        }
      }
      if (painted > 0) {
        const tmp = document.createElement('canvas');
        tmp.width = cropW;
        tmp.height = cropH;
        const tctx = tmp.getContext('2d');
        if (tctx) {
          tctx.putImageData(layer, 0, 0);
          ctx.drawImage(tmp, 0, 0);
        }
      }

      // 抠除选区的边界蚂蚁线（静态，避免额外 rAF）
      if (wand) {
        for (let y = 0; y < cropH; y++) {
          for (let x = 0; x < cropW; x++) {
            if (!wand[y * cropW + x]) continue;
            let isEdge = false;
            for (let dy = -1; dy <= 1 && !isEdge; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= cropH) { isEdge = true; break; }
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= cropW || !wand[ny * cropW + nx]) { isEdge = true; break; }
              }
            }
            if (!isEdge) continue;
            ctx.fillStyle = (x + y) % 8 < 4 ? 'rgba(255,255,255,0.95)' : 'rgba(14,15,18,0.9)';
            ctx.fillRect(x, y, 1, 1);
          }
        }
      }

      // 恢复点标记：绿色双环
      for (const s of seeds) {
        if (s.mode !== 'restore') continue;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(14,15,18,0.6)';
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(52,211,153,0.98)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };
    paintRef.current();
  }, [
    config.editPoints,
    config.tolerance,
    config.useFloodFill,
    config.alphaRatio,
    target,
    cropW,
    cropH,
    srcX,
    srcY,
    dimensions.width,
    dimensions.height,
  ]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    // 帧内相对坐标 → 原图归一化坐标
    onAddEditPoint({
      x: (srcX + nx * cropW) / dimensions.width,
      y: (srcY + ny * cropH) / dimensions.height,
      mode,
    });
    showToast(mode === 'restore' ? '已恢复此处 · 撤销按 ' + undoKeyLabel : '已抠除此处 · 撤销按 ' + undoKeyLabel);
  };

  const inThisFrame = pointsInFrame.length;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 md:p-8"
      onClick={onClose}
    >
      <div
        className="modal-pop glass relative rounded-[22px] flex flex-col w-full h-full max-w-[900px] max-h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
          <div className="flex items-center gap-2.5 shrink-0">
            <Wand2 size={15} className="text-indigo-300 shrink-0" />
            <span className="text-[13px] font-medium text-slate-100 whitespace-nowrap">
              帧 {frameIndex + 1}
            </span>
            {/* 模式切换：iOS 分段控件，凹陷轨道 + 会滑动的指示块，颜色跟模式走 */}
            <div className="seg" data-mode={mode}>
              <button
                onClick={() => onModeChange('erase')}
                className={`seg-btn flex items-center gap-1.5 px-3 py-1 text-[12px] font-medium ${
                  mode === 'erase' ? 'seg-btn-on-danger' : 'seg-btn-off'
                }`}
                title="抠除：点一下，与它同色且相连的整块会变透明（快捷键 X）"
              >
                <Eraser size={13} />
                <span>抠除</span>
              </button>
              <button
                onClick={() => onModeChange('restore')}
                className={`seg-btn flex items-center gap-1.5 px-3 py-1 text-[12px] font-medium ${
                  mode === 'restore' ? 'seg-btn-on-success' : 'seg-btn-off'
                }`}
                title="恢复：点一下，把被误抠掉的那一块补回来（快捷键 R）"
              >
                <PaintBucket size={13} />
                <span>恢复</span>
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              className="btn-glass lift flex items-center gap-1 pl-2 pr-1.5 py-1 rounded-lg text-[12px] text-slate-200 disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-white/[0.055]"
              title="撤销上一步操作（Ctrl / ⌘ + Z）"
            >
              <Undo2 size={13} />
              <span>撤销</span>
              <kbd className="kbd ml-0.5 px-1.5 py-px text-[10px] text-slate-400 font-mono leading-tight">{undoKeyLabel}</kbd>
            </button>
            {canUndo && (
              <button
                onClick={onClear}
                className="lift px-2.5 py-1 rounded-lg text-[12px] text-slate-400 hover:text-slate-100 hover:bg-white/[0.07] transition-colors duration-150"
                title="清空所有编辑（含其他帧）"
              >
                清空全部
              </button>
            )}
            <button
              onClick={onClose}
              className="btn-glass lift p-1.5 rounded-full text-slate-400 hover:text-slate-100"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* 画面 */}
        <div ref={wrapRef} className="flex-1 min-h-0 flex items-center justify-center p-4 checker">
          {/* 边框 + 左上角角标都跟着模式变色：不用回忆，扫一眼就知道现在点下去是抠还是补 */}
          <div
            className={`relative rounded-md shadow-2xl ${
              mode === 'erase' ? 'ring-2 ring-rose-500/90' : 'ring-2 ring-emerald-500/90'
            }`}
          >
            <canvas
              ref={canvasRef}
              onClick={handleClick}
              className={`block rounded-md ${mode === 'erase' ? 'cursor-crosshair' : 'cursor-copy'}`}
              style={{ width: box.w, height: box.h, imageRendering: 'pixelated' }}
            />
            <div
              className={`absolute left-0 top-0 px-2 py-0.5 text-[10px] font-medium rounded-bl-md rounded-tl-md leading-tight pointer-events-none ${
                mode === 'erase'
                  ? 'bg-gradient-to-b from-rose-400 to-rose-600 text-white'
                  : 'bg-gradient-to-b from-emerald-400 to-emerald-600 text-white'
              }`}
            >
              {mode === 'erase' ? '抠除中' : '恢复中'}
            </div>
          </div>
        </div>

        {/* 底部提示 */}
        <div className="shrink-0 px-4 py-2.5 border-t border-white/[0.06] bg-white/[0.02] flex items-center justify-between gap-2 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5 truncate">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                mode === 'erase' ? 'bg-rose-500' : 'bg-emerald-500'
              }`}
            />
            <span className={`shrink-0 font-medium ${mode === 'erase' ? 'text-rose-300' : 'text-emerald-300'}`}>
              {mode === 'erase' ? '抠除' : '恢复'}
            </span>
            <span className="text-slate-700 shrink-0">—</span>
            {mode === 'erase' ? (
              <span className="truncate">点一下要抠掉的地方，与它同色且相连的整块会一起变透明</span>
            ) : (
              <span className="truncate">
                <span className="text-orange-300">橙色</span> = 被抠掉但原本是主体的部分，点它补回来
              </span>
            )}
          </span>
          <span className="flex items-center gap-2 shrink-0">
            <span className="text-slate-400">
              本帧 <span className="text-rose-300 tnum">{inThisFrame - restoredInFrame}</span> 抠除
              {restoredInFrame > 0 && (
                <> · <span className="text-emerald-300 tnum">{restoredInFrame}</span> 恢复</>
              )}
              {' '}· 共 {config.editPoints.length} 处
            </span>
            <span className="text-slate-700">|</span>
            <span>{undoKeyLabel} 撤销</span>
            <span className="text-slate-700">·</span>
            <span>Esc 关闭</span>
          </span>
        </div>

        {/* 操作反馈 */}
        {toast && (
          <div className="fade-in absolute left-1/2 -translate-x-1/2 bottom-14 z-10 pointer-events-none">
            <div className="glass-pill flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-slate-100 text-[12px] whitespace-nowrap">
              <Undo2 size={12} className="text-indigo-300" />
              <span>{toast}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
