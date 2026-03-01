import { SpriteConfig, ImageDimensions } from "../types";
import { hexToRgb, getContentBoundingBox, applyFloodFill, BoundingBox } from './gifBuilder';

declare var JSZip: any;

export const exportFrames = async (
  image: HTMLImageElement,
  config: SpriteConfig,
  dimensions: ImageDimensions,
  onProgress: (pct: number) => void
): Promise<Blob> => {
  return new Promise(async (resolve, reject) => {
    try {
      if (typeof JSZip === 'undefined') {
        throw new Error('JSZip library not loaded');
      }

      const zip = new JSZip();
      
      const { 
          rows, cols, crop, scale, totalFrames, excludedFrames,
          transparent, tolerance = 0, useFloodFill = true, 
          readOrder = 'row-major', autoAlign = false, alignMode = 'center',
          maxResolution1024 = false
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

          // 2. Apply Transparency Processing
          if (transparent && transparentRGB) {
             const imgData = bufferCtx.getImageData(0, 0, logicalWidth, logicalHeight);
             const data = imgData.data;

             if (useFloodFill) {
                // For PNG export, we want real transparency (alpha=0), not a key color.
                // We reuse applyFloodFill but logic needs to be slightly different:
                // applyFloodFill in gifBuilder sets color to keyColor (e.g. green).
                // Here we want to set alpha to 0.
                
                // Since applyFloodFill is hardcoded to set a key color, we have to modify it or 
                // replicate logic. For cleanliness, we'll replicate the simple loop logic here 
                // but optimized for alpha=0 channel.
                
                // Let's implement a specific alpha-erasing flood fill here to avoid modifying shared code
                // too much or handling green-screen effects in PNG.
                
                const visited = new Uint8Array(logicalWidth * logicalHeight);
                const queue: number[] = [];
                const tr = transparentRGB.r, tg = transparentRGB.g, tb = transparentRGB.b;

                const matches = (idx: number) => {
                  const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
                  if (a === 0) return true;
                  const distSq = (r - tr)*(r - tr) + (g - tg)*(g - tg) + (b - tb)*(b - tb);
                  return distSq <= thresholdSq;
                };

                const addSeed = (x: number, y: number) => {
                  const idx = (y * logicalWidth + x) * 4;
                  const vIdx = y * logicalWidth + x;
                  if (!visited[vIdx] && matches(idx)) {
                    visited[vIdx] = 1;
                    queue.push(vIdx);
                  }
                };

                // Seed edges
                for (let x = 0; x < logicalWidth; x++) { addSeed(x, 0); addSeed(x, logicalHeight - 1); }
                for (let y = 1; y < logicalHeight - 1; y++) { addSeed(0, y); addSeed(logicalWidth - 1, y); }

                let head = 0;
                while (head < queue.length) {
                   const vIdx = queue[head++];
                   const idx = vIdx * 4;
                   data[idx + 3] = 0; // Set Alpha to 0

                   const x = vIdx % logicalWidth;
                   const y = Math.floor(vIdx / logicalWidth);
                   
                   const neighbors = [{nx:x+1,ny:y}, {nx:x-1,ny:y}, {nx:x,ny:y+1}, {nx:x,ny:y-1}];
                   for (const {nx, ny} of neighbors) {
                      if (nx>=0 && nx<logicalWidth && ny>=0 && ny<logicalHeight) {
                         const nVIdx = ny * logicalWidth + nx;
                         if (!visited[nVIdx]) {
                             if (matches(nVIdx*4)) {
                                 visited[nVIdx] = 1;
                                 queue.push(nVIdx);
                             }
                         }
                      }
                   }
                }
             } else {
               // Simple replacement
               const tr = transparentRGB.r, tg = transparentRGB.g, tb = transparentRGB.b;
               for (let p = 0; p < data.length; p += 4) {
                  const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3];
                  if (a === 0) continue;
                  const distSq = (r - tr)*(r - tr) + (g - tg)*(g - tg) + (b - tb)*(b - tb);
                  if (distSq <= thresholdSq) {
                     data[p+3] = 0; // Alpha 0
                  }
               }
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
      resolve(content);

    } catch (e) {
      reject(e);
    }
  });
};
