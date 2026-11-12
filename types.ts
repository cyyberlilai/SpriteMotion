
export interface CropConfig {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type ReadOrder = 'row-major' | 'column-major';
export type AlignMode = 'center' | 'bottom';

/**
 * 一次手动编辑。作用在某个点上，按加入顺序依次回放，所以「先擦后补」和
 * 「先补后擦」能得到不同结果 —— 和用户的操作顺序一致。
 *
 * · erase   = 魔术棒抠除：与种子颜色相近且连通的整块 → 透明
 * · restore = 反向魔术棒：该点附近「当前透明、但原图颜色明显不是背景色」
 *             的整块 → 补回不透明（颜色取自原图，抠图过程从不改写原图 RGB）
 */
export interface EditPoint {
  /** 原图归一化坐标 0~1 */
  x: number;
  y: number;
  /** 缺省按 erase 处理，兼容早期只有抠除点的配置 */
  mode?: 'erase' | 'restore';
}

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
  alphaRatio: boolean; // 按局部对比度归一化决定边缘切点（减少锯齿与白边）
  despillStrength: number; // 去色溢出强度 0-100（0 = 关闭）
  autoAlign: boolean; // Automatically center the subject based on bounding box
  alignMode: AlignMode;
  readOrder: ReadOrder; // Direction to read frames
  crop: CropConfig;
  /** 手动编辑点（原图归一化坐标 0~1），按顺序回放：抠除 / 恢复 */
  editPoints: EditPoint[];
  maxResolution1024: boolean; // Limit output max dimension to 1024px
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ProcessingState {
  status: 'idle' | 'analyzing' | 'rendering' | 'completed';
  progress: number; // 0 to 100
  /**
   * 正在生成的是哪一种导出。
   * 两个按钮共用一套状态，没有这个字段就分不清谁在跑 ——
   * 导出 ZIP 时「导出 GIF」会错显成「生成中」。
   */
  renderingKind?: 'gif' | 'zip';
  /** 刚完成的是哪一种导出，用于让对应按钮短暂显示「已导出」 */
  completedKind?: 'gif' | 'zip';
  // 错误信息不再放这里：一律交给「就近反馈」（scopedError / toast），
  // 避免出现一条离操作点很远的通用报错条。
}