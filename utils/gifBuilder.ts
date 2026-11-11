import { SpriteConfig, ImageDimensions } from "../types";
import { buildBackgroundMask, despillEdge, mapEditSeeds, effectiveDespillStrength } from "./backgroundRemoval";

// gif.js 是 UMD 脚本（挂到 window.GIF），不是 ES module，所以按需动态加载本地文件。
// 之前从 cdnjs 拉，CDN 一挂导出就废；现在走 public/vendor/ 同源资源。
declare class GIF {
  constructor(options: any);
  addFrame(element: any, options?: any): void;
  on(event: string, callback: (data: any) => void): void;
  render(): void;
}

/** 本地资源根路径，支持部署到子路径 */
const BASE = (((import.meta as any).env?.BASE_URL as string) ?? '/');
const vendorUrl = (file: string) => `${BASE}vendor/${file}`;

let gifLibPromise: Promise<void> | null = null;

/** 确保 gif.js 已加载（只会加载一次） */
const ensureGifLib = (): Promise<void> => {
  if ((window as any).GIF) return Promise.resolve();
  if (!gifLibPromise) {
    gifLibPromise = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = vendorUrl('gif.js');
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        gifLibPromise = null;
        reject(new Error('GIF 编码器加载失败，请检查网络后重试'));
      };
      document.head.appendChild(el);
    });
  }
  return gifLibPromise;
};

/** worker 与页面同源，直接用路径，不需要再转 Blob */
const getWorkerUrl = () => vendorUrl('gif.worker.js');

export const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
};

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/**
 * Calculates the bounding box of the non-transparent/non-background content.
 */
export const getContentBoundingBox = (
  data: Uint8ClampedArray, 
  width: number, 
  height: number, 
  transparentRGB: { r: number, g: number, b: number } | null,
  thresholdSq: number
): BoundingBox | null => {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  const tr = transparentRGB ? transparentRGB.r : 0;
  const tg = transparentRGB ? transparentRGB.g : 0;
  const tb = transparentRGB ? transparentRGB.b : 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];

      let isContent = false;

      if (a === 0) {
        isContent = false;
      } else if (transparentRGB) {
        const distSq = (r - tr) * (r - tr) + (g - tg) * (g - tg) + (b - tb) * (b - tb);
        if (distSq > thresholdSq) {
          isContent = true;
        }
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

  if (!found) return null;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
};

/**
 * Performs a flood fill starting from the edges of the image.
 */
export const applyFloodFill = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  targetRGB: { r: number, g: number, b: number },
  keyColor: { r: number, g: number, b: number },
  thresholdSq: number
) => {
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const tr = targetRGB.r;
  const tg = targetRGB.g;
  const tb = targetRGB.b;

  const matches = (idx: number) => {
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const a = data[idx + 3];

    if (a === 0) return true;

    const distSq = (r - tr) * (r - tr) + (g - tg) * (g - tg) + (b - tb) * (b - tb);
    return distSq <= thresholdSq;
  };

  const addSeed = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    const vIdx = y * width + x;
    if (visited[vIdx]) return;
    
    if (matches(idx)) {
      visited[vIdx] = 1;
      queue.push(vIdx);
    }
  };

  for (let x = 0; x < width; x++) {
    addSeed(x, 0);
    addSeed(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    addSeed(0, y);
    addSeed(width - 1, y);
  }

  let head = 0;
  while (head < queue.length) {
    const vIdx = queue[head++];
    const idx = vIdx * 4;
    
    data[idx] = keyColor.r;
    data[idx + 1] = keyColor.g;
    data[idx + 2] = keyColor.b;
    data[idx + 3] = 255;

    const x = vIdx % width;
    const y = Math.floor(vIdx / width);

    const neighbors = [
      { nx: x + 1, ny: y },
      { nx: x - 1, ny: y },
      { nx: x, ny: y + 1 },
      { nx: x, ny: y - 1 }
    ];

    for (const { nx, ny } of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nVIdx = ny * width + nx;
        if (!visited[nVIdx]) {
           const nIdx = nVIdx * 4;
           if (matches(nIdx)) {
             visited[nVIdx] = 1;
             queue.push(nVIdx);
           }
        }
      }
    }
  }
};

/** 导出结果连同真实规格一起返回，文件名和完成反馈才不会靠猜 */
export interface GifExportResult {
  blob: Blob;
  /** GIF 实际像素尺寸（已含缩放与 1024 限制） */
  width: number;
  height: number;
  /** 实际写入的帧数（已扣除排除帧与超出序列长度的帧） */
  frames: number;
}

export const generateGif = async (
  image: HTMLImageElement,
  config: SpriteConfig,
  dimensions: ImageDimensions,
  onProgress: (pct: number) => void
): Promise<GifExportResult> => {
  await ensureGifLib();
  const workerUrl = getWorkerUrl();

  return new Promise<GifExportResult>((resolve, reject) => {
    const { 
        rows, cols, crop, scale, fps, totalFrames, excludedFrames,
        transparent, tolerance = 0, useFloodFill = true, alphaRatio = true, despillStrength = 80,
        readOrder = 'row-major', autoAlign = false, alignMode = 'center',
        editPoints = [], maxResolution1024 = false
    } = config;
    
    const frameWidthRaw = dimensions.width / cols;
    const frameHeightRaw = dimensions.height / rows;

    // Initial crop size
    const cropWidth = frameWidthRaw - crop.left - crop.right;
    const cropHeight = frameHeightRaw - crop.top - crop.bottom;

    if (cropWidth <= 0 || cropHeight <= 0) {
      reject(new Error("裁剪数值过大，导致画面宽度或高度为0或负数"));
      return;
    }

    // Determine sequence of frames
    // We only collect indices that are < totalFrames AND NOT in excludedFrames
    const validFrameCoordinates: { r: number; c: number; originalIndex: number }[] = [];
    
    // Generate all possible coordinates first in order
    const tempCoords: { r: number; c: number; index: number }[] = [];
    if (readOrder === 'column-major') {
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          tempCoords.push({ r, c, index: c * rows + r });
        }
      }
    } else {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          tempCoords.push({ r, c, index: r * cols + c });
        }
      }
    }

    // Filter
    for (const item of tempCoords) {
        if (item.index < totalFrames && !excludedFrames.includes(item.index)) {
            validFrameCoordinates.push({ r: item.r, c: item.c, originalIndex: item.index });
        }
    }

    if (validFrameCoordinates.length === 0) {
        reject(new Error("没有有效的帧可供生成"));
        return;
    }

    // Prep transparency config
    let transparentRGB: { r: number, g: number, b: number } | null = null;
    let keyColor: { r: number, g: number, b: number } | null = null;
    let thresholdSq = 0;

    if (transparent) {
       transparentRGB = hexToRgb(transparent);
       if (transparentRGB) {
         const distToMagenta = Math.sqrt(
            Math.pow(transparentRGB.r - 255, 2) + 
            Math.pow(transparentRGB.g - 0, 2) + 
            Math.pow(transparentRGB.b - 255, 2)
         );
         keyColor = distToMagenta < 100 ? { r: 0, g: 255, b: 0 } : { r: 255, g: 0, b: 255 };

         const maxDist = 441.67;
         const threshold = (tolerance / 100) * maxDist;
         thresholdSq = threshold * threshold;
       }
    }

    // --- SMART RECONSTRUCTION (Auto Align Analysis) ---
    // Scan valid frames to determine bbox in ORIGINAL RESOLUTION
    
    let finalWidth = cropWidth;
    let finalHeight = cropHeight;
    const frameBBoxes: Map<number, BoundingBox | null> = new Map();

    const analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = cropWidth;
    analysisCanvas.height = cropHeight;
    const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });
    
    if (autoAlign && analysisCtx) {
        let maxW = 0;
        let maxH = 0;

        for (const { r, c, originalIndex } of validFrameCoordinates) {
            analysisCtx.clearRect(0, 0, cropWidth, cropHeight);
            analysisCtx.drawImage(
                image,
                (c * frameWidthRaw) + crop.left, 
                (r * frameHeightRaw) + crop.top,
                cropWidth,
                cropHeight,
                0, 0, cropWidth, cropHeight
            );
            
            const imgData = analysisCtx.getImageData(0, 0, cropWidth, cropHeight);
            const bbox = getContentBoundingBox(imgData.data, cropWidth, cropHeight, transparentRGB, thresholdSq);
            
            frameBBoxes.set(originalIndex, bbox);
            
            if (bbox) {
                maxW = Math.max(maxW, bbox.width);
                maxH = Math.max(maxH, bbox.height);
            }
        }

        if (maxW > 0 && maxH > 0) {
            finalWidth = maxW + 2; 
            finalHeight = maxH + 2;
        }
    }

    // --- DIMENSION CALCULATION ---
    // 1. Calculate the "Logical" dimensions based on user config (scale)
    // This represents the ideal pixel grid as defined by the user (e.g., 4x scale).
    const logicalWidth = Math.floor(finalWidth * scale);
    const logicalHeight = Math.floor(finalHeight * scale);

    // 2. Calculate the "Output" dimensions (constrained by 1024px if enabled)
    // This is the "final adjustment" step.
    let outputWidth = logicalWidth;
    let outputHeight = logicalHeight;
    let resizeRatio = 1.0;

    if (maxResolution1024) {
        const maxSide = Math.max(logicalWidth, logicalHeight);
        if (maxSide > 1024) {
            resizeRatio = 1024 / maxSide;
            outputWidth = Math.floor(logicalWidth * resizeRatio);
            outputHeight = Math.floor(logicalHeight * resizeRatio);
        }
    }

    // --- GIF SETUP ---
    // quality 不是"质量分"，而是 NeuQuant 建调色板时的**像素采样间隔**：
    //   setQuality(q) -> this.sample = q -> samplepixels = 总像素 / q
    // 数字越大采样越稀、越快，但调色板越粗。实测（9 帧，透明，workers:2）：
    //   340×340   q1 369ms/误差0.42   q3 142ms/0.63   q10 69ms/0.73
    //   1024×1024 q1 3337ms/0.79      q3 1121ms/0.49  q10 414ms/0.84
    // 注意 q1 在大图上并非最优（NeuQuant 学习率调度非单调），q2~q3 才是拐点，
    // 故取 3：小图快 2.6 倍、大图快 3 倍且比 q1 更准。误透明/误不透明在
    // 各档位均为 0，说明该参数不影响抠图干净度，只影响 256 色的分配。
    const gifOptions: any = {
      workers: 2,
      quality: 3,
      dither: false,
      width: outputWidth,
      height: outputHeight,
      workerScript: workerUrl,
    };

    if (transparent && keyColor) {
         gifOptions.transparent = (keyColor.r << 16) | (keyColor.g << 8) | keyColor.b;
    }

    const gif = new GIF(gifOptions);
    const delay = 1000 / fps;

    // --- CANVAS SETUP ---
    
    // Buffer Canvas: Renders at logical user-defined scale. 
    // Keeps pixel-perfect alignment logic consistent regardless of final output resizing.
    const bufferCanvas = document.createElement('canvas');
    bufferCanvas.width = logicalWidth;
    bufferCanvas.height = logicalHeight;
    const bufferCtx = bufferCanvas.getContext('2d', { willReadFrequently: true });
    
    if (!bufferCtx) {
      reject("Could not create canvas context");
      return;
    }
    bufferCtx.imageSmoothingEnabled = false; // Always sharp for initial rendering

    // Output Canvas: Used only if resizing is needed (maxResolution1024 active)
    let outputCanvas: HTMLCanvasElement | null = null;
    let outputCtx: CanvasRenderingContext2D | null = null;

    if (resizeRatio !== 1.0) {
        outputCanvas = document.createElement('canvas');
        outputCanvas.width = outputWidth;
        outputCanvas.height = outputHeight;
        outputCtx = outputCanvas.getContext('2d');
        if (outputCtx) {
            // If transparency is used, smoothing must be OFF to prevent halo effects 
            // when blending with the key color. If opaque, smoothing improves downscale quality.
            outputCtx.imageSmoothingEnabled = !transparent; 
        }
    }

    // --- RENDER LOOP ---
    for (const { r, c, originalIndex } of validFrameCoordinates) {
        // 1. Draw to Buffer Canvas
        bufferCtx.clearRect(0, 0, logicalWidth, logicalHeight);
        
        if (!transparent) {
            bufferCtx.fillStyle = "#ffffff";
            bufferCtx.fillRect(0, 0, logicalWidth, logicalHeight);
        }

        // 这一帧实际被画到了缓冲区的哪个矩形（对齐 / 未对齐不同，编辑点要跟着走）
        let drawn = {
            srcX: (c * frameWidthRaw) + crop.left,
            srcY: (r * frameHeightRaw) + crop.top,
            srcW: cropWidth,
            srcH: cropHeight,
            dstX: 0,
            dstY: 0,
            dstW: logicalWidth,
            dstH: logicalHeight,
        };

        if (autoAlign) {
            const bbox = frameBBoxes.get(originalIndex);
            
            if (bbox) {
                // Logic uses logical scaling, ensuring integer consistency with grid
                const scaledBboxW = Math.floor(bbox.width * scale);
                const scaledBboxH = Math.floor(bbox.height * scale);
                
                // Center in the logical canvas
                const destX = Math.floor((logicalWidth - scaledBboxW) / 2);
                
                let destY = 0;
                if (alignMode === 'bottom') {
                    destY = logicalHeight - scaledBboxH;
                } else {
                    destY = Math.floor((logicalHeight - scaledBboxH) / 2);
                }

                bufferCtx.drawImage(
                    image,
                    (c * frameWidthRaw) + crop.left + bbox.minX, 
                    (r * frameHeightRaw) + crop.top + bbox.minY,
                    bbox.width,
                    bbox.height,
                    destX, 
                    destY, 
                    scaledBboxW, 
                    scaledBboxH
                );

                drawn = {
                    srcX: (c * frameWidthRaw) + crop.left + bbox.minX,
                    srcY: (r * frameHeightRaw) + crop.top + bbox.minY,
                    srcW: bbox.width,
                    srcH: bbox.height,
                    dstX: destX,
                    dstY: destY,
                    dstW: scaledBboxW,
                    dstH: scaledBboxH,
                };
            }
        } else {
            // Standard render (no align)
            bufferCtx.drawImage(
              image,
              (c * frameWidthRaw) + crop.left, 
              (r * frameHeightRaw) + crop.top,
              cropWidth,
              cropHeight,
              0, 
              0, 
              logicalWidth, 
              logicalHeight
            );
        }

        // 2. 抠背景：α 比例判定 + 去色溢出，与预览、PNG 导出共用同一套算法
        if (transparentRGB && keyColor) {
           const imgData = bufferCtx.getImageData(0, 0, logicalWidth, logicalHeight);
           const data = imgData.data;

           const mask = buildBackgroundMask(data, logicalWidth, logicalHeight, {
             target: transparentRGB,
             tolerance,
             floodFill: useFloodFill,
             alphaRatio,
             edits: mapEditSeeds(
               editPoints,
               dimensions.width,
               dimensions.height,
               drawn.srcX,
               drawn.srcY,
               drawn.srcW,
               drawn.srcH,
               logicalWidth,
               logicalHeight,
               { x: drawn.dstX, y: drawn.dstY, w: drawn.dstW, h: drawn.dstH }
             ),
           });

           despillEdge(
             data,
             mask.alpha,
             transparentRGB,
             logicalWidth,
             logicalHeight,
             effectiveDespillStrength(alphaRatio, despillStrength)
           );

           // GIF 只有 1-bit alpha，用占位色标记透明区域
           const kr = keyColor.r, kg = keyColor.g, kb = keyColor.b;
           for (let p = 0, i = 0; p < mask.solid.length; p++, i += 4) {
             if (!mask.solid[p]) {
               data[i] = kr;
               data[i + 1] = kg;
               data[i + 2] = kb;
               data[i + 3] = 255;
             }
           }

           bufferCtx.putImageData(imgData, 0, 0);
        }

        // 3. Output to GIF
        if (outputCtx && outputCanvas) {
            // Resizing step
            outputCtx.clearRect(0, 0, outputWidth, outputHeight);
            if (!transparent) {
                 outputCtx.fillStyle = "#ffffff";
                 outputCtx.fillRect(0, 0, outputWidth, outputHeight);
            }
            // Draw the buffer (Logical) to Output (Final), scaling it down
            outputCtx.drawImage(bufferCanvas, 0, 0, outputWidth, outputHeight);
            gif.addFrame(outputCtx, { copy: true, delay: delay });
        } else {
            // Direct output
            gif.addFrame(bufferCtx, { copy: true, delay: delay });
        }
    }

    gif.on('progress', (p: number) => {
      onProgress(Math.round(p * 100));
    });

    gif.on('finished', (blob: Blob) => {
      resolve({
        blob,
        width: outputWidth,
        height: outputHeight,
        frames: validFrameCoordinates.length,
      });
    });

    gif.render();
  });
};