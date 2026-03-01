import React, { useRef } from 'react';
import { SpriteConfig, ImageDimensions } from '../types';
import { EyeOff } from 'lucide-react';

interface SpriteCanvasProps {
  imageUrl: string | null;
  config: SpriteConfig;
  onDimensionsLoaded: (dims: ImageDimensions) => void;
  onToggleFrame: (index: number) => void;
}

export const SpriteCanvas: React.FC<SpriteCanvasProps> = ({ imageUrl, config, onDimensionsLoaded, onToggleFrame }) => {
  const imgRef = useRef<HTMLImageElement>(null);

  // Handle image load to set dimensions
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    onDimensionsLoaded({ width: naturalWidth, height: naturalHeight });
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
              onClick={() => !isOutOfRange && onToggleFrame(seqIndex)}
              className={`
                border-r border-b border-blue-400/50 relative cursor-pointer group
                ${isOutOfRange ? 'bg-black/60 cursor-not-allowed' : 'hover:bg-blue-500/20 transition-colors'}
                ${isExcluded ? 'bg-red-500/30' : ''}
              `}
              title={isOutOfRange ? "超出总帧数范围" : `帧 ${seqIndex + 1} (点击${isExcluded ? '恢复' : '剔除'})`}
            >
              {/* Index Number */}
              <span className="absolute top-0 left-0 text-[10px] bg-black/50 text-white px-1 font-mono rounded-br shadow-sm z-10 pointer-events-none">
                {seqIndex + 1}
              </span>

              {/* Excluded Icon */}
              {isExcluded && !isOutOfRange && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <EyeOff className="text-red-200 drop-shadow-md w-1/3 h-1/3" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  if (!imageUrl) {
    return (
      <div className="w-full h-full min-h-[400px] flex items-center justify-center text-slate-500 border-2 border-dashed border-slate-700 rounded-lg bg-slate-900/30">
        上传图片以开始
      </div>
    );
  }

  return (
    // Fixed container. flex layout centers the inner content. overflow-hidden prevents scrollbars.
    <div className="w-full h-full bg-slate-900/50 rounded-lg border border-slate-700 shadow-inner overflow-hidden flex items-center justify-center p-4">
       {/* 
          Wrapper: 
          - relative: allows absolute positioning of the grid overlay.
          - flex: shrink-wraps the image dimensions (crucial so the grid matches the image exactly).
          - max-w/max-h: ensures it never exceeds the parent container.
       */}
       <div className="relative flex max-w-full max-h-full shadow-2xl bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] bg-slate-800">
          <img
            ref={imgRef}
            src={imageUrl}
            alt="Sprite Sheet"
            // w-auto h-auto max-w-full max-h-full object-contain allows the image to scale down to fit,
            // while preserving its aspect ratio. 
            // `block` removes bottom ghost spacing.
            className="block w-auto h-auto max-w-full max-h-full object-contain"
            style={{ imageRendering: 'pixelated' }} // Critical for pixel art sharpness
            onLoad={handleImageLoad}
          />
          {/* Outer Border to frame the image nicely */}
          <div className="absolute top-0 left-0 w-full h-full border border-blue-400/50 pointer-events-none"></div>
          {renderGridOverlay()}
       </div>
    </div>
  );
};