/**
 * 统一的图片文件读取工具。
 * 点击上传、拖拽上传、粘贴上传三条路径都走这里，保证行为一致。
 *
 * 「支持的格式」也只在这里定义一份：上传按钮的提示浮层、拖拽校验、
 * 失败说明、导出文件名都引用同一组常量，避免界面说支持、代码却拒绝。
 */

export interface SupportedImageFormat {
  label: string;
  exts: string[];
  mimes: string[];
}

/** 浏览器普遍可解码的静态图片格式（GIF 只取第一帧，本工具面向精灵图） */
export const SUPPORTED_IMAGE_FORMATS: SupportedImageFormat[] = [
  { label: 'PNG',  exts: ['png'],         mimes: ['image/png'] },
  { label: 'JPG',  exts: ['jpg', 'jpeg'], mimes: ['image/jpeg', 'image/jpg'] },
  { label: 'WebP', exts: ['webp'],        mimes: ['image/webp'] },
  { label: 'GIF',  exts: ['gif'],         mimes: ['image/gif'] },
  { label: 'BMP',  exts: ['bmp'],         mimes: ['image/bmp', 'image/x-ms-bmp'] },
  { label: 'SVG',  exts: ['svg'],         mimes: ['image/svg+xml'] },
  { label: 'AVIF', exts: ['avif'],        mimes: ['image/avif'] },
];

/** 面向用户的格式串：提示浮层、错误说明共用 */
export const SUPPORTED_FORMATS_LABEL = SUPPORTED_IMAGE_FORMATS
  .map((f) => f.label)
  .join(' · ');

const KNOWN_EXTENSIONS = new Set(SUPPORTED_IMAGE_FORMATS.flatMap((f) => f.exts));
const MIME_BY_EXT = new Map(
  SUPPORTED_IMAGE_FORMATS.flatMap((f) => f.exts.map((e) => [e, f.mimes[0]] as const))
);

export const getFileExtension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/**
 * 是否当作图片接收。
 * 优先看 MIME；macOS 从某些 App 拖出来的文件 type 可能是空字符串，
 * 这时用扩展名兜底 —— 否则「明明是 PNG 却拖不进来」还不给任何理由。
 * 其它 image/* 也放行（能否解码交给浏览器和后面的 decode 校验）。
 */
export const isSupportedImage = (file: File): boolean => {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  // type 为空、或被系统标成通用二进制时，按扩展名兜底
  if (type === '' || type === 'application/octet-stream') {
    return KNOWN_EXTENSIONS.has(getFileExtension(file.name));
  }
  return false;
};

/** 把「为什么拖不进来」说清楚：文件名 + 它实际是什么 + 期望是什么 */
export const unsupportedImageMessage = (file: File): string => {
  const ext = getFileExtension(file.name);
  const kind = ext ? `.${ext.toUpperCase()}` : (file.type || '未知类型');
  return `「${file.name}」是 ${kind} 文件，不是支持的图片格式`;
};

export const readImageFile = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (!isSupportedImage(file)) {
      reject(new Error(unsupportedImageMessage(file)));
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result;
      if (typeof result !== 'string') {
        reject(new Error('读取图片失败'));
        return;
      }
      // 没有 MIME 的文件读出来是 data:base64,...，浏览器解不了。
      // 按扩展名补上声明，否则「明明是 PNG 却拖不进来」会变成一句无头的解码错误。
      const mime = MIME_BY_EXT.get(getFileExtension(file.name));
      if (mime && !/^data:image\/[^;,]+;base64,/i.test(result)) {
        resolve(result.replace(/^data:[^,]*,/, `data:${mime};base64,`));
      } else {
        resolve(result);
      }
    };
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
};

/** 从一个事件里找出第一张图片文件（拖拽/粘贴可能带多个文件） */
export const pickImageFile = (items: FileList | null | undefined): File | null => {
  if (!items) return null;
  return Array.from(items).find((f) => isSupportedImage(f)) ?? null;
};

/**
 * 原文件名 → 可用于导出文件名的主干。
 * 去掉扩展名、过滤各系统禁止的字符、空白折叠成下划线并限长；
 * 被过滤空了（或来自剪贴板的匿名文件）时给一个稳定兜底名。
 */
export const toSafeFileStem = (name: string): string => {
  const withoutExt = name.replace(/\.[^./\\]+$/, '');
  const cleaned = withoutExt
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 60);
  return cleaned || 'sprite';
};

/** 源文件名_9帧_234x194.gif —— 名字里就能看出帧数和成品尺寸 */
export const buildExportFileName = ({
  sourceName,
  frames,
  width,
  height,
  extension,
}: {
  sourceName: string;
  frames: number;
  width: number;
  height: number;
  extension: 'gif' | 'zip';
}): string =>
  `${toSafeFileStem(sourceName)}_${frames}帧_${width}x${height}.${extension}`;

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};
