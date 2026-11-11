import React, { useRef, useEffect, useState } from 'react';
import { SpriteConfig, ImageDimensions } from '../types';
import { Play, Pause } from 'lucide-react';
import { buildBackgroundMask, despillEdge, mapEditSeeds, effectiveDespillStrength } from '../utils/backgroundRemoval';

interface PreviewPlayerProps {
  imageUrl: string | null;
  config: SpriteConfig;
  dimensions: ImageDimensions;
  /** card = 竖排卡片；dock = 画布下方的横向停靠条 */
  variant?: 'card' | 'dock';
}

const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
};

export const PreviewPlayer: React.FC<PreviewPlayerProps> = ({ imageUrl, config, dimensions, variant = 'card' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentFrameDisplayIndex, setCurrentFrameDisplayIndex] = useState(0); // For display (1-based index of valid frames)

  // 当前帧在 validIndices 里的下标（而不是从时间反推），
  // 这样暂停后再播放能从停下那一帧继续往后走。
  const frameIdxRef = useRef(0);
  // 上一次推进帧的时间戳，用来算应该前进几帧
  const lastTimeRef = useRef(0);

  // 换图时回到第一帧
  useEffect(() => {
    frameIdxRef.current = 0;
    lastTimeRef.current = 0;
  }, [imageUrl]);
  
  // Helper to get sequence of VALID frame indices
  const getValidFrameIndices = () => {
     const { rows, cols, totalFrames, excludedFrames, readOrder = 'row-major' } = config;
     const indices: number[] = [];
     
     if (readOrder === 'column-major') {
         for (let c = 0; c < cols; c++) {
             for (let r = 0; r < rows; r++) {
                 const i = c * rows + r;
                 if (i < totalFrames && !excludedFrames.includes(i)) indices.push(i);
             }
         }
     } else {
         for (let r = 0; r < rows; r++) {
             for (let c = 0; c < cols; c++) {
                 const i = r * cols + c;
                 if (i < totalFrames && !excludedFrames.includes(i)) indices.push(i);
             }
         }
     }
     return indices;
  };

  useEffect(() => {
    if (!imageUrl || !canvasRef.current || dimensions.width === 0) return;

    const img = new Image();
    
    let transparentRGB: { r: number, g: number, b: number } | null = null;
    if (config.transparent) {
        transparentRGB = hexToRgb(config.transparent);
    }
    const maxDist = 441.67;
    const thresholdSq = Math.pow((config.tolerance / 100) * maxDist, 2);

    // 把某一帧画到 canvas 上（indexInValid 是 validIndices 里的下标）
    const draw = (validIndices: number[], indexInValid: number) => {
      if (!canvasRef.current) return;

      const { rows, cols, crop, scale, autoAlign, alignMode } = config;
      const frameIndex = validIndices[indexInValid];
      if (frameIndex === undefined) return;

      setCurrentFrameDisplayIndex(indexInValid + 1);

      const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      const frameWidthRaw = dimensions.width / cols;
      const frameHeightRaw = dimensions.height / rows;

      // Crop dimensions
      const cropW = Math.max(1, frameWidthRaw - crop.left - crop.right);
      const cropH = Math.max(1, frameHeightRaw - crop.top - crop.bottom);

      // Canvas setup
      canvasRef.current.width = cropW * scale;
      canvasRef.current.height = cropH * scale;
      
      // Calculate row/col
      let col, row;
      if (config.readOrder === 'column-major') {
          // If we are treating the sheet as column major, then index 1 is at r=1, c=0
          row = frameIndex % rows;
          col = Math.floor(frameIndex / rows);
      } else {
          // Row major
          col = frameIndex % cols;
          row = Math.floor(frameIndex / cols);
      }
      
      const srcX = (col * frameWidthRaw) + crop.left;
      const srcY = (row * frameHeightRaw) + crop.top;

      ctx.imageSmoothingEnabled = false;

      // 1. Clear 
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      
      if (!config.transparent) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }

      /**
       * 记下「这一帧实际被画到了缓冲区的哪个矩形」。
       * 未对齐 = 整块裁剪区铺满缓冲；对齐 = 只有内容包围盒，且被缩放居中。
       * 后面抠图时，手动编辑点必须跟着同一套变换走，否则会擦到错误的地方
       * （典型症状：开了智能对齐，之前抠掉的区域又回来了）。
       */
      let drawn = {
        srcX,
        srcY,
        srcW: cropW,
        srcH: cropH,
        dstX: 0,
        dstY: 0,
        dstW: canvasRef.current.width,
        dstH: canvasRef.current.height,
      };

      if (autoAlign) {
          const tempC = document.createElement('canvas');
          tempC.width = cropW;
          tempC.height = cropH;
          const tempCtx = tempC.getContext('2d');
          if (tempCtx) {
              tempCtx.drawImage(img, srcX, srcY, cropW, cropH, 0, 0, cropW, cropH);
              const imgData = tempCtx.getImageData(0, 0, cropW, cropH);
              const data = imgData.data;

              let minX = cropW, minY = cropH, maxX = 0, maxY = 0, found = false;
              const tr = transparentRGB?.r ?? 0;
              const tg = transparentRGB?.g ?? 0;
              const tb = transparentRGB?.b ?? 0;

              for (let y = 0; y < cropH; y++) {
                  for (let x = 0; x < cropW; x++) {
                      const i = (y * cropW + x) * 4;
                      const alpha = data[i+3];
                      
                      let isContent = false;
                      if (alpha === 0) isContent = false;
                      else if (transparentRGB) {
                         const r = data[i], g = data[i+1], b = data[i+2];
                         const distSq = (r-tr)*(r-tr) + (g-tg)*(g-tg) + (b-tb)*(b-tb);
                         if (distSq > thresholdSq) isContent = true;
                      } else {
                         isContent = true;
                      }

                      if (isContent) {
                          if (x < minX) minX = x;
                          if (x > maxX) maxX = x;
                          if (y < minY) minY = y;
                          if (y > maxY) maxY = y;
                          found = true;
                      }
                  }
              }

              if (found) {
                  const bboxW = maxX - minX + 1;
                  const bboxH = maxY - minY + 1;
                  
                  // Calculate Destination based on Align Mode (Integers only to avoid subpixel rendering)
                  const destX = Math.floor((canvasRef.current.width - bboxW * scale) / 2);
                  
                  let destY = 0;
                  if (alignMode === 'bottom') {
                     destY = canvasRef.current.height - bboxH * scale;
                  } else {
                     destY = Math.floor((canvasRef.current.height - bboxH * scale) / 2);
                  }

                  // Draw aligned
                  ctx.drawImage(
                      img,
                      srcX + minX, 
                      srcY + minY,
                      bboxW,
                      bboxH,
                      destX, 
                      destY,
                      bboxW * scale, 
                      bboxH * scale
                  );
                  // 编辑点跟着这块「实际画出来的矩形」走
                  drawn = {
                    srcX: srcX + minX,
                    srcY: srcY + minY,
                    srcW: bboxW,
                    srcH: bboxH,
                    dstX: destX,
                    dstY: destY,
                    dstW: bboxW * scale,
                    dstH: bboxH * scale,
                  };
              }
          }
      } else {
          // Standard Draw
          ctx.drawImage(
            img,
            srcX, 
            srcY,
            cropW, 
            cropH,
            0, 
            0,
          cropW * scale, 
          cropH * scale
          );
      }

      // 2. 抠背景：α 比例判定 + 去色溢出，与导出共用同一套算法
      if (transparentRGB && canvasRef.current) {
        const w = canvasRef.current.width;
        const h = canvasRef.current.height;
        const imgData = ctx.getImageData(0, 0, w, h);

        const mask = buildBackgroundMask(imgData.data, w, h, {
          target: transparentRGB,
          tolerance: config.tolerance,
          floodFill: config.useFloodFill !== false,
          alphaRatio: config.alphaRatio !== false,
          edits: mapEditSeeds(
            config.editPoints,
            dimensions.width,
            dimensions.height,
            drawn.srcX,
            drawn.srcY,
            drawn.srcW,
            drawn.srcH,
            w,
            h,
            { x: drawn.dstX, y: drawn.dstY, w: drawn.dstW, h: drawn.dstH }
          ),
        });

        despillEdge(
          imgData.data,
          mask.alpha,
          transparentRGB,
          w,
          h,
          effectiveDespillStrength(config.alphaRatio, config.despillStrength)
        );

        for (let p = 0, i = 3; p < mask.alpha.length; p++, i += 4) {
          imgData.data[i] = mask.alpha[p];
        }
        ctx.putImageData(imgData, 0, 0);
      }
    };

    // 从当前帧往后推进着播放
    const animate = (time: number) => {
      const validIndices = getValidFrameIndices();
      if (validIndices.length === 0) return; // Nothing to play

      if (frameIdxRef.current >= validIndices.length) frameIdxRef.current = 0;

      const frameInterval = 1000 / Math.max(1, config.fps);
      if (lastTimeRef.current === 0) lastTimeRef.current = time;

      const elapsed = time - lastTimeRef.current;
      if (elapsed >= frameInterval) {
        const steps = Math.floor(elapsed / frameInterval);
        frameIdxRef.current = (frameIdxRef.current + steps) % validIndices.length;
        lastTimeRef.current += steps * frameInterval;
      }

      draw(validIndices, frameIdxRef.current);
      requestRef.current = requestAnimationFrame(animate);
    };

    // 等图片解码完再画。否则暂停时改参数（每次 effect 都会新建 Image）会先清空画布、
    // 再对着还没加载好的图 drawImage，结果就是一片空白。
    let started = false;
    let cancelled = false;

    const start = () => {
      if (started || cancelled || !canvasRef.current) return;
      started = true;

      if (isPlaying) {
        lastTimeRef.current = 0; // 重新计时，续播时不跳帧
        requestRef.current = requestAnimationFrame(animate);
      } else {
        // 暂停时也按最新参数重绘一次，改裁剪 / 缩放 / 帧率能立刻看到效果
        const validIndices = getValidFrameIndices();
        if (validIndices.length > 0) {
          if (frameIdxRef.current >= validIndices.length) frameIdxRef.current = 0;
          draw(validIndices, frameIdxRef.current);
        }
      }
    };

    img.onload = start;
    img.src = imageUrl;
    // 图片可能已在缓存中，此时 onload 不会再触发
    if (img.complete && img.naturalWidth > 0) start();

    return () => {
      cancelled = true;
      img.onload = null;
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [imageUrl, config, dimensions, isPlaying]);

  if (!imageUrl) return null;

  // 停靠条形态：横向一条，占用高度小，放在画布下方
  if (variant === 'dock') {
    return (
      <div className="glass-card flex items-center gap-3 rounded-lg pl-3 pr-2 py-2">
        <div className="flex items-center shrink-0">
          <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full mr-1.5 animate-pulse"></span>
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-[0.08em]">预览</span>
        </div>

        <button
          type="button"
          onClick={() => setIsPlaying(v => !v)}
          title={isPlaying ? '点击暂停，停在当前帧' : '点击从这一帧继续播放'}
          aria-label={isPlaying ? '暂停预览' : '播放预览'}
          className="relative checker rounded border border-slate-800 h-[52px] flex-1 min-w-0 flex items-center justify-center overflow-hidden cursor-pointer transition-colors duration-150 hover:border-slate-600"
        >
          <canvas ref={canvasRef} className="h-[44px] w-auto max-w-full object-contain" style={{ imageRendering: 'pixelated' }} />
          {config.autoAlign && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-25">
              <div className="h-full w-[1px] bg-rose-500 absolute"></div>
              {config.alignMode === 'center'
                ? <div className="w-full h-[1px] bg-rose-500 absolute"></div>
                : <div className="w-full h-[1px] bg-indigo-400 absolute bottom-2"></div>}
            </div>
          )}
        </button>

        <button
          onClick={() => setIsPlaying(v => !v)}
          className="p-1.5 rounded-full btn-accent lift shrink-0"
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <span className="text-[11px] font-mono tnum text-slate-400 shrink-0 pr-1">
          {currentFrameDisplayIndex}/{getValidFrameIndices().length}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2.5">
      {/* 画面：正方形，精灵铺满。点击画面即可播放 / 暂停 */}
      <button
        type="button"
        onClick={() => setIsPlaying(v => !v)}
        title={isPlaying ? '点击暂停，停在当前帧' : '点击从这一帧继续播放'}
        aria-label={isPlaying ? '暂停预览' : '播放预览'}
        className="relative checker rounded-md border border-slate-800 w-full aspect-square overflow-hidden flex items-center justify-center p-3 cursor-pointer transition-colors duration-150 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
      >
        <canvas ref={canvasRef} className="h-full w-full object-contain" style={{ imageRendering: 'pixelated' }} />

        {/* Helper lines */}
        {config.autoAlign && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-25">
                <div className="h-full w-[1px] bg-rose-500 absolute"></div>
                {config.alignMode === 'center' ? (
                   <div className="w-full h-[1px] bg-rose-500 absolute"></div>
                ) : (
                   <div className="w-full h-[1px] bg-indigo-400 absolute bottom-3"></div>
                )}
            </div>
        )}
      </button>

      {/* 控制条放在画面下方，不遮挡精灵 */}
      <div className="flex items-center gap-3 bg-slate-800/60 border border-slate-700 rounded-full pl-1.5 pr-4 py-1.5">
        <button
          onClick={() => setIsPlaying(v => !v)}
          className="w-9 h-9 flex items-center justify-center rounded-full btn-accent lift shrink-0"
          aria-label={isPlaying ? '暂停' : '播放'}
          title={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
        </button>
        <span className="text-[12px] font-mono tnum text-slate-300 whitespace-nowrap">
          帧 <span className="text-slate-100">{currentFrameDisplayIndex}</span>
          <span className="text-slate-500"> / {getValidFrameIndices().length}</span>
        </span>
      </div>
    </div>
  );
};