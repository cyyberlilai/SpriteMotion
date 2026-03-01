import React, { useRef, useEffect, useState } from 'react';
import { SpriteConfig, ImageDimensions } from '../types';
import { Play, Pause } from 'lucide-react';

interface PreviewPlayerProps {
  imageUrl: string | null;
  config: SpriteConfig;
  dimensions: ImageDimensions;
}

const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
};

export const PreviewPlayer: React.FC<PreviewPlayerProps> = ({ imageUrl, config, dimensions }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentFrameDisplayIndex, setCurrentFrameDisplayIndex] = useState(0); // For display (1-based index of valid frames)
  
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
    img.src = imageUrl;
    
    let transparentRGB: { r: number, g: number, b: number } | null = null;
    if (config.transparent) {
        transparentRGB = hexToRgb(config.transparent);
    }
    const maxDist = 441.67;
    const thresholdSq = Math.pow((config.tolerance / 100) * maxDist, 2);

    const animate = (time: number) => {
      if (!canvasRef.current) return;
      
      const validIndices = getValidFrameIndices();
      if (validIndices.length === 0) return; // Nothing to play

      const { rows, cols, crop, scale, fps, autoAlign, alignMode } = config;
      const frameInterval = 1000 / fps;
      
      const tick = Math.floor(time / frameInterval);
      const indexInValid = tick % validIndices.length;
      const frameIndex = validIndices[indexInValid];
      
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

      if (isPlaying) {
        requestRef.current = requestAnimationFrame(animate);
      }
    };

    if (isPlaying) {
      requestRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [imageUrl, config, dimensions, isPlaying]);

  if (!imageUrl) return null;

  return (
    <div className="flex flex-col items-center space-y-4">
      <div className="relative p-8 bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] bg-slate-800 rounded-lg border border-slate-600 shadow-lg flex items-center justify-center min-h-[200px] w-full overflow-hidden">
        <canvas ref={canvasRef} className="max-w-full max-h-[300px] object-contain shadow-sm" />
        
        {/* Helper lines */}
        {config.autoAlign && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-20">
                {/* Horizontal Center Line */}
                <div className="h-full w-[1px] bg-red-500 absolute"></div>
                
                {/* Vertical Indicator depending on mode */}
                {config.alignMode === 'center' ? (
                   <div className="w-full h-[1px] bg-red-500 absolute"></div>
                ) : (
                   <div className="w-full h-[1px] bg-blue-500 absolute bottom-8"></div> // Rough indicator for bottom
                )}
            </div>
        )}
      </div>
      
      <div className="flex items-center space-x-4 bg-slate-800 p-2 rounded-full border border-slate-700 shadow-lg">
        <button 
          onClick={() => setIsPlaying(!isPlaying)}
          className="p-2 rounded-full bg-indigo-500 hover:bg-indigo-600 text-white transition-colors"
        >
          {isPlaying ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <span className="text-xs font-mono text-slate-400 px-2">
            帧: {currentFrameDisplayIndex} / {getValidFrameIndices().length}
        </span>
      </div>
    </div>
  );
};