import { SpriteConfig, ImageDimensions } from "../types";
import { hexToRgb, getContentBoundingBox, BoundingBox } from './gifBuilder';
import { buildBackgroundMask, despillEdge, mapEditSeeds, effectiveDespillStrength } from './backgroundRemoval';
import JSZip from 'jszip';

/** 与 GIF 导出同结构：ZIP 名字和完成反馈也用真实规格 */
export interface FramesExportResult {
  blob: Blob;
  /** 单帧 PNG 的实际像素尺寸 */
  width: number;
  height: number;
  frames: number;
}

export const exportFrames = async (
  image: HTMLImageElement,
  config: SpriteConfig,
  dimensions: ImageDimensions,
  onProgress: (pct: number) => void
): Promise<FramesExportResult> => {
  return new Promise<FramesExportResult>(async (resolve, reject) => {
    try {
      const zip = new JSZip();
      
      const { 
          rows, cols, crop, scale, totalFrames, excludedFrames,
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
        throw new Error("裁剪数值过大，导致画面宽度或高度为0或负数");
      }

      // Determine sequence of frames
      const validFrameCoordinates: { r: number; c: number; originalIndex: number }[] = [];
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

      for (const item of tempCoords) {
          if (item.index < totalFrames && !excludedFrames.includes(item.index)) {
              validFrameCoordinates.push({ r: item.r, c: item.c, originalIndex: item.index });
          }
      }

      if (validFrameCoordinates.length === 0) {
          throw new Error("没有有效的帧可供生成");
      }

      // Prep transparency config
      let transparentRGB: { r: number, g: number, b: number } | null = null;
      let thresholdSq = 0;

      if (transparent) {
         transparentRGB = hexToRgb(transparent);
         if (transparentRGB) {
           const maxDist = 441.67;
           const threshold = (tolerance / 100) * maxDist;
           thresholdSq = threshold * threshold;
         }
      }

      // --- SMART RECONSTRUCTION (Auto Align Analysis) ---
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

          // Notify analyzing
          onProgress(5);

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
      const logicalWidth = Math.floor(finalWidth * scale);
      const logicalHeight = Math.floor(finalHeight * scale);

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

      // --- CANVAS SETUP ---
      const bufferCanvas = document.createElement('canvas');
      bufferCanvas.width = logicalWidth;
      bufferCanvas.height = logicalHeight;
      const bufferCtx = bufferCanvas.getContext('2d', { willReadFrequently: true });
      
      if (!bufferCtx) {
        throw new Error("Could not create canvas context");
      }
      bufferCtx.imageSmoothingEnabled = false;

      let outputCanvas: HTMLCanvasElement | null = null;
      let outputCtx: CanvasRenderingContext2D | null = null;

      if (resizeRatio !== 1.0) {
          outputCanvas = document.createElement('canvas');
          outputCanvas.width = outputWidth;
          outputCanvas.height = outputHeight;
          outputCtx = outputCanvas.getContext('2d');
          if (outputCtx) {
              outputCtx.imageSmoothingEnabled = !transparent; 
          }
      }

      // --- RENDER LOOP ---
      let processedCount = 0;
      const totalToProcess = validFrameCoordinates.length;

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
                  const scaledBboxW = Math.floor(bbox.width * scale);
                  const scaledBboxH = Math.floor(bbox.height * scale);
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
              bufferCtx.drawImage(
                image,
                (c * frameWidthRaw) + crop.left, 
                (r * frameHeightRaw) + crop.top,
                cropWidth,
                cropHeight,
                0, 0, logicalWidth, logicalHeight
              );
          }

          // 2. 抠背景：α 比例判定 + 去色溢出，与预览、GIF 导出共用同一套算法
          if (transparent && transparentRGB) {
             const imgData = bufferCtx.getImageData(0, 0, logicalWidth, logicalHeight);

             const mask = buildBackgroundMask(imgData.data, logicalWidth, logicalHeight, {
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
               imgData.data,
               mask.alpha,
               transparentRGB,
               logicalWidth,
               logicalHeight,
               effectiveDespillStrength(alphaRatio, despillStrength)
             );

             // PNG 支持 8-bit alpha，直接写软 alpha，边缘过渡更自然
             for (let p = 0, i = 3; p < mask.alpha.length; p++, i += 4) {
               imgData.data[i] = mask.alpha[p];
             }

             bufferCtx.putImageData(imgData, 0, 0);
          }

          // 3. Export to Blob
          let blob: Blob | null = null;
          
          if (outputCtx && outputCanvas) {
              outputCtx.clearRect(0, 0, outputWidth, outputHeight);
              if (!transparent) {
                   outputCtx.fillStyle = "#ffffff";
                   outputCtx.fillRect(0, 0, outputWidth, outputHeight);
              }
              outputCtx.drawImage(bufferCanvas, 0, 0, outputWidth, outputHeight);
              blob = await new Promise(r => outputCanvas?.toBlob(r, 'image/png'));
          } else {
              blob = await new Promise(r => bufferCanvas.toBlob(r, 'image/png'));
          }

          if (blob) {
              const fileName = `frame_${originalIndex.toString().padStart(3, '0')}.png`;
              zip.file(fileName, blob);
          }

          processedCount++;
          onProgress(10 + Math.round((processedCount / totalToProcess) * 80));
      }

      // Generate ZIP
      onProgress(95);
      const content = await zip.generateAsync({ type: "blob" });
      onProgress(100);
      resolve({
        blob: content,
        width: outputWidth,
        height: outputHeight,
        frames: validFrameCoordinates.length,
      });

    } catch (e) {
      reject(e);
    }
  });
};
