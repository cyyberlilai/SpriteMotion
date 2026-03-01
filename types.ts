
export interface CropConfig {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type ReadOrder = 'row-major' | 'column-major';
export type AlignMode = 'center' | 'bottom';

export interface SpriteConfig {
  rows: number;
  cols: number;
  totalFrames: number; // Useful if the last row isn't full
  excludedFrames: number[]; // Specific indices to skip within the totalFrames
  fps: number;
  scale: number;
  transparent: string | null; // Hex color for transparency replacement if needed, usually null
  tolerance: number; // 0-100 tolerance for color matching
  useFloodFill: boolean; // Use contiguous flood fill from edges (protects inner colors)
  autoAlign: boolean; // Automatically center the subject based on bounding box
  alignMode: AlignMode;
  readOrder: ReadOrder; // Direction to read frames
  crop: CropConfig;
  maxResolution1024: boolean; // Limit output max dimension to 1024px
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ProcessingState {
  status: 'idle' | 'analyzing' | 'rendering' | 'completed';
  progress: number; // 0 to 100
  error?: string;
}