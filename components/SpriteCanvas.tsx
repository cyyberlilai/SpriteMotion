import React, { useRef, useState, useCallback, useEffect } from 'react';
import { SpriteConfig, ImageDimensions, EditPoint } from '../types';
import { EyeOff, Upload, ImageIcon, Maximize2, AlertTriangle, X } from 'lucide-react';
import { selectMagicWandRegion } from '../utils/backgroundRemoval';
import {
  SUPPORTED_FORMATS_LABEL,
  pickImageFile,
  unsupportedImageMessage,
} from '../utils/fileLoader';

interface SpriteCanvasProps {
  imageUrl: string | null;
  config: SpriteConfig;
  onDimensionsLoaded: (dims: ImageDimensions) => void;
  onToggleFrame: (index: number) => void;
  onFileDrop: (file: File) => void;
  onRequestPick?: () => void;
  /** 拖拽失败的原因：直接显示在投放区里，不跑到画布下方去 */
  dropError?: string | null;
  onDropRejected?: (message: string) => void;
  onDismissDropError?: () => void;
  /** fit = 适配窗口；actual = 1:1 原始像素 */
  zoomMode?: 'fit' | 'actual';
  /** 把实际缩放倍数回传给外层，用于显示百分比 */
  onScaleChange?: (scale: number) => void;
  /** 魔术棒模式：开启后点格子＝放大那一格去点选（不直接产生选区） */
  eraseMode?: boolean;
  editPoints?: EditPoint[];
  /** 放大单格编辑（多格素材在画布里每格太小，点不准） */
  onZoomFrame?: (index: number) => void;
}

export const SpriteCanvas: React.FC<SpriteCanvasProps> = ({
  imageUrl,
  config,
  onDimensionsLoaded,
  onToggleFrame,
  onFileDrop,
  onRequestPick,
  dropError = null,
  onDropRejected,
  onDismissDropError,
  zoomMode = 'fit',
  onScaleChange,
  eraseMode = false,
  editPoints = [],
  onZoomFrame,
}) => {
  const imgRef = useRef<HTMLImageElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  // 拖拽途中就能预判「这东西放不进来」，不用等松手才知道
  const [dragWarning, setDragWarning] = useState<string | null>(null);
  // 用 ref 记录拖拽进入的层级，避免子元素反复触发 enter/leave 导致状态抖动
  const dragDepth = useRef(0);

  // Handle image load to set dimensions
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    setNatural({ w: naturalWidth, h: naturalHeight });
    onDimensionsLoaded({ width: naturalWidth, height: naturalHeight });
  };

  // 计算「适配窗口」的缩放倍数：图片和网格覆盖层是同一个包裹元素，
  // 缩放作用在包裹层上，两者永远同步，不会错位。
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !natural.w || !natural.h) return;
    const recalc = () => {
      const pad = 32; // p-4 左右各 16px
      const availW = el.clientWidth - pad;
      const availH = el.clientHeight - pad;
      if (availW <= 0 || availH <= 0) return;
      // 上限 8 倍，避免 16px 的小图被放大成马赛克墙
      const k = Math.min(availW / natural.w, availH / natural.h, 8);
      setFitScale(k);
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural.w, natural.h, imageUrl]);

  const scale = zoomMode === 'actual' ? 1 : fitScale;

  useEffect(() => {
    onScaleChange?.(scale);
  }, [scale, onScaleChange]);

  // 魔术棒选区高亮：点一下就把选中的区域框出来（淡色填充 + 蚂蚁线），
  // 用的和导出擦除是同一个 selectMagicWandRegion，所见即所擦。
  // 「恢复」点不参与抠除高亮 —— 它是把东西补回来，不存在可见的选区边界，
  // 效果直接体现在预览里。这里只给它画一个绿色小环，方便回头找到改过哪里。
  useEffect(() => {
    const img = imgRef.current;
    const cv = overlayRef.current;
    if (!img || !cv || !natural.w || !natural.h) return;

    const w = natural.w;
    const h = natural.h;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (editPoints.length === 0) return;

    // 取原图像素（一次）
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d', { willReadFrequently: true });
    if (!octx) return;
    octx.drawImage(img, 0, 0, w, h);
    const data = octx.getImageData(0, 0, w, h).data;

    // 静态层：抠除选区的淡蓝填充 + 恢复点的绿色小环。
    // 绿环必须画在这层上而不是 ctx 上 —— 蚂蚁线动画每 6 帧会 clearRect 整张覆盖层。
    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    const bctx = base.getContext('2d');
    if (!bctx) return;

    const eraseSeeds = editPoints
      .filter((p) => p.mode !== 'restore')
      .map((p) => ({ x: p.x * w, y: p.y * h }));

    let mask: Uint8Array | null = null;
    let count = 0;
    if (eraseSeeds.length > 0) {
      mask = selectMagicWandRegion(data, w, h, eraseSeeds);
      const layer = bctx.createImageData(w, h);
      for (let p = 0; p < w * h; p++) {
        if (!mask[p]) continue;
        const i = p * 4;
        layer.data[i] = 56;
        layer.data[i + 1] = 189;
        layer.data[i + 2] = 248;
        layer.data[i + 3] = 96;
        count++;
      }
      if (count > 0) bctx.putImageData(layer, 0, 0);
    }

    // 恢复点标记：绿色双环（外亮内暗），压在任何底色上都看得见
    for (const pt of editPoints) {
      if (pt.mode !== 'restore') continue;
      const cx = pt.x * w;
      const cy = pt.y * h;
      bctx.beginPath();
      bctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      bctx.strokeStyle = 'rgba(14,15,18,0.6)';
      bctx.lineWidth = 1.6;
      bctx.stroke();
      bctx.beginPath();
      bctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      bctx.strokeStyle = 'rgba(52,211,153,0.98)';
      bctx.lineWidth = 0.9;
      bctx.stroke();
    }

    // 没有抠除选区（只有恢复点，或选区算出来是空）→ 静态贴一层就够
    if (!mask || count === 0) {
      ctx.drawImage(base, 0, 0);
      return;
    }

    // 边界像素（蚂蚁线就画在这些点上）
    const edge: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        let isEdge = false;
        for (let dy = -1; dy <= 1 && !isEdge; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) { isEdge = true; break; }
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= w || !mask[ny * w + nx]) { isEdge = true; break; }
          }
        }
        if (isEdge) edge.push(p);
      }
    }

    let raf = 0;
    let frame = 0;
    let offset = 0;
    const paintAnts = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(base, 0, 0);
      for (const p of edge) {
        const x = p % w;
        const y = (p - x) / w;
        ctx.fillStyle = (x + y + offset) % 8 < 4 ? 'rgba(255,255,255,0.95)' : 'rgba(14,15,18,0.9)';
        ctx.fillRect(x, y, 1, 1);
      }
    };

    // 边界特别长（大图 / 复杂形状）就不做动画，静态画一次，免得 rAF 空转
    if (edge.length > 4000) {
      paintAnts();
      return;
    }

    const paint = () => {
      frame++;
      // 每 6 帧走一格，蚂蚁线滑动但不过分耗性能
      if (frame % 6 === 0) {
        offset = (offset + 1) % 8;
        paintAnts();
      }
      raf = requestAnimationFrame(paint);
    };
    paint();

    return () => cancelAnimationFrame(raf);
  }, [imageUrl, editPoints, natural.w, natural.h]);

  // --- 拖拽上传 ---
  // dragover 阶段能读到 items 的 kind/type（出于安全读不到文件名），
  // 足够判断「拖的是文字链接」还是「拖的文件不是图片」。type 为空时不做判断，
  // 留给 drop 阶段按扩展名兜底，避免误报。
  const inspectDrag = useCallback((e: React.DragEvent) => {
    const items = Array.from(e.dataTransfer.items ?? []) as DataTransferItem[];
    const fileItems = items.filter((i) => i.kind === 'file');
    if (items.length > 0 && fileItems.length === 0) {
      setDragWarning('拖入的是文字或链接，不是图片文件');
      return;
    }
    const known = fileItems.map((i) => (i.type || '').toLowerCase()).filter(Boolean);
    if (known.length > 0 && known.every((t) => !t.startsWith('image/'))) {
      setDragWarning('这个格式不受支持，松开后看具体原因');
      return;
    }
    setDragWarning(null);
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current += 1;
    setIsDragging(true);
    inspectDrag(e);
  }, [inspectDrag]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // 必须阻止默认行为，否则浏览器会直接打开图片而不是接收 drop
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    inspectDrag(e);
  }, [inspectDrag]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragging(false);
      setDragWarning(null);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setIsDragging(false);
      setDragWarning(null);

      const files = Array.from(e.dataTransfer.files ?? []) as File[];
      if (files.length === 0) {
        onDropRejected?.('没有检测到文件。请拖入图片文件，或点下方按钮选择文件。');
        return;
      }
      const file = pickImageFile(e.dataTransfer.files);
      if (!file) {
        onDropRejected?.(unsupportedImageMessage(files[0]));
        return;
      }
      onDismissDropError?.();
      onFileDrop(file);
    },
    [onFileDrop, onDropRejected, onDismissDropError]
  );

  // 投放失败时，说明卡片就压在用户刚松手的地方：一句原因 + 一个下一步动作
  const renderDropError = () => {
    if (!dropError) return null;
    return (
      <div
        className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-sm fade-in"
        onClick={(e) => {
          e.stopPropagation();
          onDismissDropError?.();
        }}
      >
        <div
          role="alert"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-[380px] rounded-xl glass-pill modal-pop p-4 border border-rose-400/30"
        >
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 shrink-0 rounded-lg bg-rose-500/15 border border-rose-400/30 flex items-center justify-center">
              <AlertTriangle size={17} className="text-rose-300" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-white">这张图片没能导入</div>
              {/* 这里不再重复格式列表：标题和原因已经说清问题，下一步按钮直接带他去选图，
                  关掉卡片后投放区里那行常驻格式也立刻回到视野。 */}
              <p className="text-[12px] leading-relaxed text-slate-300 mt-1 break-words">{dropError}</p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDismissDropError?.();
              }}
              className="p-1 -mt-1 -mr-1 rounded text-slate-500 hover:text-white hover:bg-white/10 transition-colors duration-150"
              aria-label="关闭提示"
            >
              <X size={14} />
            </button>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDismissDropError?.();
              onRequestPick?.();
            }}
            className="mt-3.5 w-full py-2 rounded-md btn-glass text-[12.5px] font-medium text-slate-100 hover:text-white active:scale-[0.99]"
          >
            改为选择图片文件
          </button>
        </div>
      </div>
    );
  };

  // CSS Grid overlay generator
  const renderGridOverlay = () => {
    if (!imageUrl || config.cols <= 0 || config.rows <= 0) return null;

    return (
      <div
        className="absolute inset-0 z-10"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${config.cols}, 1fr)`,
          gridTemplateRows: `repeat(${config.rows}, 1fr)`,
        }}
      >
        {Array.from({ length: config.rows * config.cols }).map((_, i) => {
          // Calculate current grid cell coordinates
          const r = Math.floor(i / config.cols);
          const c = i % config.cols;

          // Determine sequence index based on readOrder
          let seqIndex;
          if (config.readOrder === 'column-major') {
            seqIndex = c * config.rows + r;
          } else {
            seqIndex = r * config.cols + c;
          }

          const isExcluded = config.excludedFrames.includes(seqIndex);
          const isOutOfRange = seqIndex >= config.totalFrames;

          return (
            <div
              key={i}
              onClick={(e) => {
                // 格子里的点击一律就地消化：否则会冒泡到外层画布，
                // 在抠除模式下顺手给这个坐标加一个选区（点了格子就出现框选）。
                e.stopPropagation();
                if (isOutOfRange) return;
                // 抠除模式：点格子只做放大，不选中任何东西；选区要在放大窗里点
                if (eraseMode && onZoomFrame) {
                  onZoomFrame(seqIndex);
                  return;
                }
                onToggleFrame(seqIndex);
              }}
              className={`
                border-r border-b border-white/25 relative cursor-pointer group
                ${isOutOfRange ? 'bg-black/65 cursor-not-allowed' : 'hover:bg-white/10 transition-colors duration-150'}
                ${isExcluded ? 'bg-rose-500/25' : ''}
              `}
              title={
                isOutOfRange
                  ? '超出总帧数范围'
                  : eraseMode && onZoomFrame
                  ? `放大第 ${seqIndex + 1} 帧去点选抠除`
                  : `帧 ${seqIndex + 1} (点击${isExcluded ? '恢复' : '剔除'})`
              }
            >
              {/* Index Number */}
              <span className="absolute top-0 left-0 text-[10px] leading-tight bg-black/60 text-slate-100 px-1 py-0.5 font-mono tnum rounded-br-sm z-10 pointer-events-none">
                {seqIndex + 1}
              </span>

              {/* Excluded Icon */}
              {isExcluded && !isOutOfRange && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <EyeOff className="text-rose-300 w-1/3 h-1/3" />
                </div>
              )}

              {/* 放大编辑（悬停出现，任何时候都能用） */}
              {!isOutOfRange && onZoomFrame && (
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onZoomFrame(seqIndex);
                  }}
                  className="absolute bottom-1 right-1 z-20 flex items-center justify-center w-7 h-7 rounded-md bg-black/65 border border-white/25 text-slate-200 opacity-70 hover:opacity-100 hover:bg-black/85 transition-opacity duration-150"
                  title={`放大第 ${seqIndex + 1} 帧`}
                >
                  <Maximize2 size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  if (!imageUrl) {
    return (
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={onRequestPick}
        className={`
          relative w-full h-full min-h-[400px] flex flex-col items-center justify-center
          rounded-md transition-colors duration-150 cursor-pointer group
          ${
            isDragging
              ? dragWarning
                ? 'bg-rose-500/8 border border-dashed border-rose-500/70'
                : 'bg-indigo-500/8 border border-dashed border-indigo-500'
              : 'bg-slate-950/40 border border-dashed border-slate-700 hover:border-slate-600 hover:bg-slate-900/50'
          }
        `}
      >
        {/* 拖拽悬停时就把结论说出来：能放下 / 放不下，不用等松手 */}
        {isDragging && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 rounded-md z-20 pointer-events-none">
            <div className={`w-14 h-14 rounded-md flex items-center justify-center mb-3 ${dragWarning ? 'bg-rose-500/15' : 'bg-indigo-500/15'}`}>
              {dragWarning
                ? <AlertTriangle className="text-rose-300" size={26} />
                : <Upload className="text-indigo-300" size={26} />}
            </div>
            <div className={`font-medium text-[15px] ${dragWarning ? 'text-rose-200' : 'text-indigo-200'}`}>
              {dragWarning ?? '松开即可上传'}
            </div>
            <div className="text-slate-500 text-[12px] mt-1 px-6 text-center leading-relaxed">
              {dragWarning ? '支持 ' + SUPPORTED_FORMATS_LABEL : '常用图片格式均支持'}
            </div>
          </div>
        )}

        <div
          className={`w-14 h-14 rounded-md flex items-center justify-center mb-4 transition-colors duration-150 ${
            isDragging ? (dragWarning ? 'bg-rose-500/15' : 'bg-indigo-500/15') : 'bg-slate-800 group-hover:bg-slate-700/80'
          }`}
        >
          <ImageIcon className={isDragging ? (dragWarning ? 'text-rose-300' : 'text-indigo-300') : 'text-slate-500 group-hover:text-slate-400'} size={24} />
        </div>

        <div className="text-slate-200 font-medium text-[14px] mb-1.5">拖拽图片到此处上传</div>
        <div className="text-slate-500 text-[12px]">或点击此处 / 上方「上传图片」按钮选择文件</div>
        <div className="text-slate-500 text-[11px] mt-4 tracking-[0.10em] text-center px-4">
          {SUPPORTED_FORMATS_LABEL}
        </div>
        {renderDropError()}
      </div>
    );
  }

  return (
    // Fixed container. flex layout centers the inner content. overflow-hidden prevents scrollbars.
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative w-full h-full bg-slate-950/50 rounded-md border border-slate-800 overflow-hidden"
    >
      {/*
        滚动视口：用 margin:auto 居中而不是 justify-center，
        否则放大到超出容器时左上角会被裁掉（flex 居中 + overflow 的经典坑）。
      */}
      <div ref={viewportRef} className="w-full h-full overflow-auto flex p-4">
      {/*
        Wrapper 的宽高就是图片的显示尺寸，网格覆盖层用 inset-0 贴合它。
        尺寸变化时两者一起变，所以网格永远对齐。
      */}
      <div
        className="relative shrink-0 m-auto checker"
        style={{
          width: natural.w ? Math.round(natural.w * scale) : undefined,
          height: natural.h ? Math.round(natural.h * scale) : undefined,
          cursor: eraseMode ? 'zoom-in' : undefined,
        }}
      >
          <img
            ref={imgRef}
            src={imageUrl}
            alt="Sprite Sheet"
            className="block w-full h-full"
            style={{ imageRendering: 'pixelated' }} // Critical for pixel art sharpness
            onLoad={handleImageLoad}
          />
          {/* Outer Border to frame the image nicely */}
          <div className="absolute top-0 left-0 w-full h-full border border-white/20 pointer-events-none"></div>
          {renderGridOverlay()}
          {/* 魔术棒选区（蚂蚁线 + 淡蓝填充） */}
          <canvas
            ref={overlayRef}
            className="absolute inset-0 w-full h-full pointer-events-none z-20"
            style={{ imageRendering: 'pixelated' }}
          />
       </div>
       </div>

       {/* 已有图片时的拖拽悬停提示 */}
       {isDragging && (
         <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950 rounded-md pointer-events-none">
           <div className={`w-14 h-14 rounded-md flex items-center justify-center mb-3 ${dragWarning ? 'bg-rose-500/15' : 'bg-indigo-500/15'}`}>
             {dragWarning
               ? <AlertTriangle className="text-rose-300" size={24} />
               : <Upload className="text-indigo-300" size={24} />}
           </div>
           <div className={`font-medium text-[14px] ${dragWarning ? 'text-rose-200' : 'text-indigo-200'}`}>
             {dragWarning ?? '松开即可替换图片'}
           </div>
           {dragWarning && (
             <div className="text-slate-500 text-[12px] mt-1 px-6 text-center leading-relaxed">
               支持 {SUPPORTED_FORMATS_LABEL}
             </div>
           )}
         </div>
       )}
       {renderDropError()}
    </div>
  );
};
