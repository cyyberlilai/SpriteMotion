/**
 * 背景抠除的共用实现：α 比例判定 + 去色溢出（despill）。
 *
 * 预览、GIF 导出、PNG 帧导出三条路径必须用同一套算法，否则会出现
 * 「预览干净、导出来有白边」这种不一致。所有抠图逻辑集中在这里。
 *
 * 为什么不用简单的「距离 ≤ 容差就透明」：
 * 抗锯齿边缘的像素距离背景都很远，硬阈值会把整片边缘判成前景，
 * 于是留下一圈带着背景色的白边。这里用两步解决：
 *
 * 1. α 比例判定：按局部对比度归一化，让 50% 覆盖的像素正好得到 α = 0.5，
 *    切口落在视觉上的真实轮廓，而不是「距离刚好超过容差」的位置。
 *
 * 2. 去色溢出：即使像素被正确保留了，它的颜色本身仍被背景污染过
 *    （白色背景会渗进发丝里）。按 P = α·F + (1−α)·B 反解出真实前景色 F，
 *    把背景成分减掉。
 */

import type { EditPoint } from '../types';

export interface RGB {
  r: number;
  g: number;
  b: number;
}
/** RGB 空间里可能的最大欧氏距离（纯黑 ↔ 纯白） */
export const MAX_RGB_DIST = Math.sqrt(255 * 255 * 3);

/**
 * 边缘带最大宽度（像素，切比雪夫距离），只在 α 比例判定开启时生效。
 *
 * 原来是 3，是按「大片主体」试出来的值，对细结构偏重：手指横向只有 10~14px，
 * 两侧各吃掉 3px，中间就剩不下几像素不透明，观感上轮廓被啃进去一条；
 * 脖子贴着下颌阴影的那一圈同理。
 *
 * 实测（335×335 素材，1×1 切分）从 3 降到 2：
 *   手部半透边缘占比 10.9% → 7.2%，主体内部被误压成半透明的像素 112 → 46；
 * 而真正的抗锯齿软边（切口落在 50% 覆盖处）仍然保留，没有出现硬锯齿。
 *
 * 想要更锐利可传 1（内部误判几乎归零，但软边会变薄），
 * 想更柔可传 3 甚至 4（细结构会明显变虚）。
 */
export const DEFAULT_EDGE_BAND = 2;

/**
 * 魔术棒的容差：种子点颜色与邻居的最大 RGB 欧氏距离。
 * 40 相当于「同一种颜色的轻微明暗差异」——白色口袋内部的渐变能走通，
 * 而一旦碰到轮廓线或皮肤（色差几百）就停住，不会蔓延。
 */
export const MAGIC_WAND_TOLERANCE = 40;

/**
 * 内部一致性守卫的颜色阈值（RGB 欧氏距离）。
 *
 * 判据是：一个半透明像素若 8 邻域全都不透明且与自身色差 ≤ 此值，就把 α 回填 255。
 * 14 对应「人眼几乎看不出差别」的邻近明暗，正好覆盖手指/颈窝那种同一材质内部的
 * 微弱渐变，同时把「头发压着皮肤」这类跨材质边界排除在外（色差远大于 14）。
 * 设为 0 可关闭守卫。
 */
export const DEFAULT_INTERIOR_GUARD_DIST = 14;

/**
 * 孤立白点清理：允许被清掉的最大连通块面积（像素）。
 *
 * 残留白点只有 1~3px。成因是 α 比例判定逐像素独立 —— 同一条轮廓上相邻像素的 α
 * 可能是 40/180/92/210 交替跳变，其中 α<128 的那个恰好被不透明邻居围住，洪水填充
 * 进不去，随后被「未访问且 α<128 → 强制 255」的兜底规则救成完全不透明，颜色却
 * 仍然是背景色，于是成一粒实心白点。GIF 只有 1-bit alpha，过渡层被压掉后它孤立
 * 暴露在轮廓上，放大播放时特别扎眼。
 *
 * 上限取 3 而不是更大的值：之前那版「封闭孔洞清理」的面积下限就是 4，正好把这类
 * 点漏在外面（即使那个开关还在也清不掉），所以这里刻意卡在 3 以内 —— 只收拾
 * 「一两个像素」的碎屑，绝不碰成片的浅色细节。
 */
export const WHITE_SPOT_MAX_AREA = 3;

/**
 * 判定「这像素的颜色就是背景色」的容差（RGB 欧氏距离）。
 *
 * 取 48：实测这批素材里最浅的肤色像素到白底约 55，48 留了余量，不会啃到皮肤；
 * 而真正的残留白点到白底基本在 0~20 之间，判定余量同样充足。
 * 背景不是白色时按 target 自适应，数值含义不变。
 */
export const WHITE_SPOT_COLOR_TOL = 48;

/**
 * 「恢复」判据的下限：原图颜色到背景色的距离超过它，才算「这里本来不是背景」。
 *
 * 取 32，比魔术棒的 40 更低一点点 —— 被削掉的轮廓往往连抗锯齿过渡带一起没了，
 * 那几个像素的距离在 35~60 之间，用 32 能把它们一起捞回来，补出来的边才不硬。
 * 真正的背景像素距离在 0~10，怎么都不会被误捞。
 */
export const RESTORE_BG_TOL = 32;

/**
 * 恢复时的 α 上限门槛：距离达到这个值就直接给 α=255。
 * RESTORE_BG_TOL ~ RESTORE_FULL_TOL 之间线性过渡，避免补出来的轮廓是一刀切。
 * 实测肤色到白底普遍在 150 以上，所以主体几乎都是满 α，只有最外一圈走过渡。
 */
export const RESTORE_FULL_TOL = 80;

export interface BackgroundMask {
  /** 前景透明度，0-255。给 PNG 导出和预览用 */
  alpha: Uint8ClampedArray;
  /** 二值前景掩码，1 = 前景。给 GIF 导出用（GIF 只有 1-bit alpha） */
  solid: Uint8Array;
}

export interface MaskOptions {
  target: RGB;
  /** 颜色容差，0-100。同时作为「局部对比度」的下限，防止平坦区域被噪声放大 */
  tolerance: number;
  /** true = 从四边扩散，只抠连通到边缘的区域 */
  floodFill: boolean;
  /**
   * true = 用 α 比例判定（按局部对比度归一化，切口落在 50% 覆盖处）
   * false = 退回原来的硬阈值（距离 ≤ 容差就透明）
   */
  alphaRatio?: boolean;
  /**
   * 边缘带宽度（像素，切比雪夫距离），只在 alphaRatio 开启时生效。
   * 距离最近背景像素超过这个宽度的前景像素，一律写回 α = 255。
   * 不传则用 DEFAULT_EDGE_BAND（当前 2）。
   */
  edgeBand?: number;
  /**
   * 内部一致性守卫的颜色阈值（RGB 欧氏距离），只在 alphaRatio 开启时生效。
   * 半透明像素若 8 邻域全都不透明且与自身色差 ≤ 此值，回填 α = 255。
   * 不传则用 DEFAULT_INTERIOR_GUARD_DIST（当前 14）；传 0 关闭。
   */
  interiorGuard?: number;
  /**
   * 手动编辑点（本缓冲的像素坐标），按数组顺序依次回放：
   * · erase   = 魔术棒抠除，把「与种子颜色接近且连通」的整块擦成透明
   * · restore = 反向魔术棒，把「当前透明但原图颜色明显不是背景色」的整块补回来
   * 顺序有意义：先擦后补 ≠ 先补后擦，与用户实际点击顺序一致。
   */
  edits?: EditPoint[];
  /**
   * 孤立白点清理（默认开启）：面积 ≤ WHITE_SPOT_MAX_AREA、颜色接近背景色、
   * 且贴着透明区的连通块，一律置为透明。传 false 关闭。
   * 见 4.8 步注释。
   */
  whiteSpotCleanup?: boolean;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * 生成背景抠除掩码。
 */
export const buildBackgroundMask = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts: MaskOptions
): BackgroundMask => {
  const total = width * height;
  const alpha = new Uint8ClampedArray(total);
  const solid = new Uint8Array(total);

  const tolDist = (Math.max(0, Math.min(100, opts.tolerance)) / 100) * MAX_RGB_DIST;
  const tr = opts.target.r, tg = opts.target.g, tb = opts.target.b;

  // 1. 每个像素到背景色的距离
  const dist = new Float32Array(total);
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    if (data[i + 3] === 0) continue; // 已经是透明的，dist 保持 0
    const dr = data[i] - tr;
    const dg = data[i + 1] - tg;
    const db = data[i + 2] - tb;
    dist[p] = Math.sqrt(dr * dr + dg * dg + db * db);
  }

  const useRatio = opts.alphaRatio !== false;

  if (!useRatio) {
    // 旧行为：硬阈值。抗锯齿边缘会被整片判成前景，于是留下带背景色的白边。
    for (let p = 0; p < total; p++) {
      if (data[p * 4 + 3] === 0) continue;
      alpha[p] = dist[p] <= tolDist ? 0 : 255;
    }
  } else {

  // 2. 单位方向向量：颜色偏离背景色的方向
  //    只对 dist > 1 的像素有意义，其余留 0。
  const ux = new Float32Array(total);
  const uy = new Float32Array(total);
  const uz = new Float32Array(total);
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    const d = dist[p];
    if (d <= 1) continue;
    ux[p] = (data[i] - tr) / d;
    uy[p] = (data[i + 1] - tg) / d;
    uz[p] = (data[i + 2] - tb) / d;
  }

  // 3. α 比例判定：按局部对比度归一化，0.5 为界
  //
  // 参照（localMax）只取「颜色方向一致」的邻居，方向相似度 ≥ SIM_T 才算同材质。
  //
  // 不筛方向会出事：肤色到白底的距离约 81，紧挨着的头发约 327。
  // 3×3 最大距离会把头发算成参照，ratio = 81/327 ≈ 0.25 → α ≈ 63 → 判透明，
  // 脖子、手指这些「浅色主体贴着深色物体」的边缘会被整条吃掉。
  //
  // 而真正的抗锯齿白边是背景和前景的混合，颜色方向和前景完全一致，
  // 所以筛掉异材质不会影响白边判定。
  const SIM_T = 0.9;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const dp = dist[p];
      let localMax = dp;

      if (dp > 1) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const q = ny * width + nx;
            const dq = dist[q];
            if (dq <= 1) continue;
            // 比当前参照还近的邻居不可能抬高参照，直接跳过（省掉相似度计算）
            if (dq <= localMax) continue;
            // 方向不一致 → 不同材质，不参与参照
            if (ux[p] * ux[q] + uy[p] * uy[q] + uz[p] * uz[q] < SIM_T) continue;
            localMax = dq;
          }
        }
      }

      const denom = Math.max(localMax, tolDist, 1e-6);
      const ratio = dp / denom;
      alpha[p] = ratio >= 1 ? 255 : Math.round(ratio * 255);
    }
  }
  }

  // 4. 洪水填充：从四边扩散，只把「连通到边缘」的背景抠掉
  if (opts.floodFill) {
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;

    const seed = (p: number) => {
      if (visited[p]) return;
      if (alpha[p] >= 128) return; // 已经是前景，不从这里扩散
      visited[p] = 1;
      queue[tail++] = p;
    };

    for (let x = 0; x < width; x++) {
      seed(x);
      seed((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
      seed(y * width);
      seed(y * width + width - 1);
    }

    while (head < tail) {
      const p = queue[head++];
      alpha[p] = 0;

      const x = p % width;
      const y = (p - x) / width;

      if (x + 1 < width) seed(p + 1);
      if (x > 0) seed(p - 1);
      if (y + 1 < height) seed(p + width);
      if (y > 0) seed(p - width);
    }

    // 被围住、没被扩散到的低透明度像素 → 属于主体内部，强制不透明
    // （眼白、牙齿、白衣服就是靠这条活下来的；闭合的白色口袋也会被一起保留，
    //   那种情况交给界面上的「吸管擦除」手动点掉 —— 在这里做自动判定试过，
    //   判据分不清白缝和眼白，实测两个指标只差几个单位，见 memory 记录）
    for (let p = 0; p < total; p++) {
      if (!visited[p] && alpha[p] < 128) alpha[p] = 255;
    }
  }

  // 4.5 边缘带收尾：只有贴着背景的像素才有资格半透明
  //
  // 为什么需要这一步：α 比例判定的分母是 3×3 邻域里同方向的最大距离，而
  // 「最大」恒 ≥ 自身，所以只有恰好是邻域最大值的像素才能拿到 255。任何有
  // 纹理的表面（发丝、布料褶皱、字边），绝大多数像素都不是局部最大值，于是
  // 整片主体被系统性压在 255 以下 —— 实测一张插画 89.7% 的内部像素平均
  // α = 237，皮肤区低到 226。PNG 是 straight alpha，这些像素叠到白底上等于
  // 每个通道掺进 7%~12% 的背景色，看起来就是整体发灰、发糊。
  //
  // 关键在于：纯前景像素不可能是「前景与背景的混合」，覆盖率这个概念对它
  // 不成立。所以用「到最近背景像素的距离」划出边缘带，带内保留比例 α，
  // 带外一律写不透明。距离场必须排在洪水填充之后 —— 「哪里是背景」是那一步
  // 才定下来的，早了会沿着纹理内部的伪透明一路扩散进主体。
  //
  // 不用 α 自身的落差来判：α 比例的输出把斜坡压得很平（每像素只差 5~10），
  // 跟内部渐变的 2~3 分不开；原始 dist 的落差是 40 对 3，但发丝密集的素材
  // 里内部纹理的落差照样很大，会漏掉一半。距离是唯一稳定的判据。
  if (useRatio) {
    const band = Math.max(1, Math.floor(opts.edgeBand ?? DEFAULT_EDGE_BAND));
    const distToBg = new Int16Array(total).fill(-1);
    const queue = new Int32Array(total);
    let qh = 0;
    let qt = 0;

    for (let p = 0; p < total; p++) {
      if (alpha[p] === 0) {
        distToBg[p] = 0;
        queue[qt++] = p;
      }
    }

    while (qh < qt) {
      const p = queue[qh++];
      const d = distToBg[p];
      if (d >= band) continue;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (distToBg[np] < 0) {
            distToBg[np] = d + 1;
            queue[qt++] = np;
          }
        }
      }
    }

    // 带内（distToBg ∈ [1, band]）保留比例 α；带外（-1）属于主体内部
    for (let p = 0; p < total; p++) {
      if (alpha[p] === 0 || alpha[p] === 255) continue;
      if (distToBg[p] < 0) alpha[p] = 255;
    }
  }

  // 4.6 内部一致性守卫：被邻域参照压低的「实心像素」回填成不透明
  //
  // 边缘带只救得了「距背景超过 band」的那一片，救不了轮廓带内侧的凹陷：
  // 指缝、颈窝、两片皮肤贴在一起的地方，距背景只有 1~2px，但物理上是实心的。
  // 它们被压在 200~240，叠上看就是轮廓被啃掉一条 —— 这正是 edgeBand 从 3
  // 降到 2 之后仍然残留的那部分。
  //
  // 判据：8 邻域全部「不透明且同色」→ 该像素不可能是前景与背景的混合，
  // 覆盖率这个概念对它不成立。真正的抗锯齿像素必然至少有一个邻居是背景，
  // 所以有 α=0 邻居的像素永远不满足，可见轮廓在结构上碰不到。
  //
  // 实测（335×335 素材，edgeBand=2）：判定为「主体内部却是半透」的像素
  // 图1 63 → 1、图2 46 → 1，改动量分别只有 79px / 62px，且贴背景的像素 0 个。
  //
  // 跑两轮：给 2px 宽的半透小簇留一次收敛机会。第一轮的修改不会在同一轮里
  // 被邻域看到（用快照判断），否则会沿着半透链一路扩散。
  const guardDist = opts.interiorGuard ?? DEFAULT_INTERIOR_GUARD_DIST;
  if (useRatio && guardDist > 0) {
    const guardD2 = guardDist * guardDist;
    // 邻居算「实心」的门槛。为什么不是 250：真实的误判像素往往成小片出现，
    // 邻域里本身就带着 200~240 的伙伴（同一片被压低的皮肤），要求 250 会导致
    // 一个都救不回来（实测 112 个误判只触发 0~1 次）。取 160 的效果与取 128 相同，
    // 但更保守：α 低于 160 的邻居自己还在过渡带里，不足以为「这里不是边界」作证。
    const SOLID_T = 160;
    for (let pass = 0; pass < 2; pass++) {
      const snapshot = new Uint8ClampedArray(alpha);
      let changed = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = y * width + x;
          const a = snapshot[p];
          if (a === 0 || a === 255) continue;
          const i = p * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          let enclosed = true;
          for (let dy = -1; dy <= 1 && enclosed; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              if (nx < 0 || nx >= width) continue;
              const q = ny * width + nx;
              if (snapshot[q] < SOLID_T) { enclosed = false; break; }
              const j = q * 4;
              const dr = data[j] - r, dg = data[j + 1] - g, db = data[j + 2] - b;
              if (dr * dr + dg * dg + db * db > guardD2) { enclosed = false; break; }
            }
          }
          if (enclosed) { alpha[p] = 255; changed++; }
        }
      }
      if (changed === 0) break;
    }
  }

  // 4.7 手动编辑：魔术棒抠除 / 反向魔术棒恢复，按用户点击顺序逐个回放
  //
  // 【为什么抠除必须交给用户】被主体完全围住、离真实背景又远的白色口袋（抬起的手臂与
  // 下颌之间夹出的白缝就是典型），在像素层面与眼白、牙齿几乎同构 —— 实测四组
  // 数据全部只差几个单位：
  //    白缝：面积 72、到纯白 10.7、离背景 33、开口瓶颈 α 235
  //    眼白：面积 89、到纯白 10.1、离背景 36、开口瓶颈 α 246
  // 任何自动阈值想清掉白缝都必然连带挖掉眼睛，所以判断权交给使用者。
  //
  // 【为什么还需要恢复】自动判据也会反向出错 —— 手指、拇指这类细结构被多啃掉一块。
  // 这一步之所以可行，是因为整个抠图链路是非破坏性的：每帧都从原图重新 getImageData，
  // 只把算出来的 α 写回去，RGB 从未被改写。所以「补回来」不需要凭空猜颜色，
  // 直接把原图那几个像素的 α 提回去就是它本来的样子。
  //
  // 恢复的扩散必须同时满足两条，否则会顺着连通区域一路蔓延：
  //   ① 当前 α < 255（只补被抠掉/压低的像素，撞到实心主体就停）
  //   ② 原图颜色到背景色距离 > RESTORE_BG_TOL（撞到真背景就停）
  // 这两条墙合起来，恢复范围正好是「被误判成背景的那层皮」。
  //
  // 选区计算抽在 selectMagicWandRegion / selectRestoreRegion 里，画布高亮和实际
  // 生效调用同一个函数 —— 保证「看到的选区」就是「改动的区域」。
  if (opts.edits && opts.edits.length > 0) {
    // 到背景色的距离：恢复判定要用，算一次全图复用
    let distToBg: Float32Array | null = null;
    for (const edit of opts.edits) {
      const seed = { x: edit.x, y: edit.y };
      if (edit.mode === 'restore') {
        if (!distToBg) {
          distToBg = new Float32Array(total);
          for (let p = 0, i = 0; p < total; p++, i += 4) {
            if (data[i + 3] === 0) continue;
            const dr = data[i] - opts.target.r;
            const dg = data[i + 1] - opts.target.g;
            const db = data[i + 2] - opts.target.b;
            distToBg[p] = Math.sqrt(dr * dr + dg * dg + db * db);
          }
        }
        const sel = selectRestoreRegion(distToBg, alpha, width, height, [seed]);
        const span = RESTORE_FULL_TOL - RESTORE_BG_TOL;
        for (let p = 0; p < total; p++) {
          if (!sel[p]) continue;
          const d = distToBg[p];
          const a = d >= RESTORE_FULL_TOL ? 255 : Math.round(((d - RESTORE_BG_TOL) / span) * 255);
          if (a > alpha[p]) alpha[p] = a < 0 ? 0 : a > 255 ? 255 : a;
        }
      } else {
        const sel = selectMagicWandRegion(data, width, height, [seed]);
        for (let p = 0; p < total; p++) {
          if (sel[p]) alpha[p] = 0;
        }
      }
    }
  }

  // 4.8 孤立白点清理：轮廓上 1~3px 的「背景色碎屑」
  //
  // 这些点是 α 比例判定和洪水填充兜底规则撞出来的：逐像素独立的 α 在轮廓带呈锯齿状，
  // 某个 α<128 的像素被不透明邻居围成孤岛 → flood fill 进不去 → 兜底规则把它写成
  // α=255，颜色却还是背景色。预设的三个参数都调不掉它（见文件头 WHITE_SPOT_MAX_AREA
  // 的说明），所以这里单独收一次尾。
  //
  // 三条判据同时成立才动手，缺一不可：
  //   ① 面积 ≤ 3px      —— 只收拾碎屑，成片的浅色细节（衬衫、高光）动不到
  //   ② 颜色贴近背景色   —— 到 target 的距离 ≤ 48，真实的浅肤色在 55 以上
  //   ③ 贴着透明区       —— 块的邻居里必须有 α=0，这才叫「长在轮廓上」。
  //                         眼白、牙齿同样小、同样白，但四周全是皮肤，②③ 都过不了
  //
  // 必须在魔术棒之后跑：用户刚擦出来的新轮廓也可能带碎点，一起收掉才干净。
  if (opts.whiteSpotCleanup !== false) {
    const bgR = opts.target.r;
    const bgG = opts.target.g;
    const bgB = opts.target.b;
    const tolSq = WHITE_SPOT_COLOR_TOL * WHITE_SPOT_COLOR_TOL;
    const seen = new Uint8Array(total);
    const stack: number[] = [];
    const members: number[] = [];

    for (let s = 0; s < total; s++) {
      // α<128 的像素在 GIF 里本来就是透明，PNG 里也已是半透，不是这种「实心白点」
      if (seen[s] || alpha[s] < 128) continue;
      const si = s * 4;
      const sr = data[si] - bgR;
      const sg = data[si + 1] - bgG;
      const sb = data[si + 2] - bgB;
      if (sr * sr + sg * sg + sb * sb > tolSq) continue;

      stack.length = 0;
      members.length = 0;
      stack.push(s);
      seen[s] = 1;
      let touchesBg = false;

      while (stack.length) {
        const p = stack.pop()!;
        members.push(p);
        const x = p % width;
        const y = (p - x) / width;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const q = ny * width + nx;
            if (alpha[q] === 0) { touchesBg = true; continue; }
            if (seen[q] || alpha[q] < 128) continue;
            const j = q * 4;
            const dr = data[j] - bgR;
            const dg = data[j + 1] - bgG;
            const db = data[j + 2] - bgB;
            if (dr * dr + dg * dg + db * db > tolSq) continue;
            seen[q] = 1;
            stack.push(q);
          }
        }
      }

      if (touchesBg && members.length <= WHITE_SPOT_MAX_AREA) {
        for (const p of members) alpha[p] = 0;
      }
    }
  }

  // 5. 二值化（GIF 用）
  for (let p = 0; p < total; p++) {
    solid[p] = alpha[p] >= 128 ? 1 : 0;
  }

  return { alpha, solid };
};

/**
 * 魔术棒选区：从若干种子点出发，收集「与种子颜色接近且 8 连通」的像素。
 *
 * 与 Photoshop 魔术棒的对应关系：
 *   · 容差       → tolerance（默认 MAGIC_WAND_TOLERANCE = 40）
 *   · 连续       → 这里恒为连续（Contiguous），不选不相连的同色区域
 *   · 反选/羽化  → 不提供
 *
 * 画布上的「蚂蚁线框选」和导出时的实际擦除都调这个函数，
 * 保证界面上高亮的区域 == 被抠掉的区域。
 *
 * 返回 1 = 选中。坐标系是传入 data 的那张图（in-canvas 像素）。
 */
export const selectMagicWandRegion = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seeds: { x: number; y: number }[],
  tolerance: number = MAGIC_WAND_TOLERANCE
): Uint8Array => {
  const total = width * height;
  const selected = new Uint8Array(total);
  const tolSq = tolerance * tolerance;

  for (const seed of seeds) {
    const sx = Math.round(seed.x);
    const sy = Math.round(seed.y);
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const sp = sy * width + sx;
    if (selected[sp]) continue; // 已经被前一个种子覆盖
    const si = sp * 4;
    const sr = data[si], sg = data[si + 1], sb = data[si + 2];

    const stack: number[] = [sp];
    selected[sp] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (selected[np]) continue;
          const j = np * 4;
          const dr = data[j] - sr, dg = data[j + 1] - sg, db = data[j + 2] - sb;
          if (dr * dr + dg * dg + db * db > tolSq) continue; // 颜色差太多 → 停
          selected[np] = 1;
          stack.push(np);
        }
      }
    }
  }
  return selected;
};

/**
 * 反向魔术棒：把「被误抠掉的那层皮」选回来。
 *
 * 与 selectMagicWandRegion 的区别在判据 —— 抠除看的是「颜色像不像种子」，
 * 恢复看的是「原图颜色像不像背景」，而且同时要求「当前还不是不透明」。
 *
 * 两道墙缺一不可：
 *   ① alpha[q] >= 255 就停 → 撞到实心主体立刻收手，不会顺着主体内部蔓延
 *   ② distToBg[q] <= RESTORE_BG_TOL 就停 → 撞到真背景立刻收手，不会把背景捞回来
 *
 * 剩下的就是「夹在主体和背景之间、本来该是不透明、却被判成背景」的那一圈，
 * 也正是拇指被啃掉、手指被削细时丢失的部分。
 *
 * 种子点在纯背景上（用户点歪了一点）时会就近 3×3~5×5 吸附到最近的合格像素，
 * 免得点得稍偏就完全没反应。
 */
export const selectRestoreRegion = (
  distToBg: Float32Array,
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  seeds: { x: number; y: number }[]
): Uint8Array => {
  const total = width * height;
  const selected = new Uint8Array(total);
  const ok = (p: number) => alpha[p] < 255 && distToBg[p] > RESTORE_BG_TOL;
  const stack: number[] = [];

  for (const seed of seeds) {
    const sx = Math.round(seed.x);
    const sy = Math.round(seed.y);
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;

    let sp = sy * width + sx;
    if (!ok(sp)) {
      let found = -1;
      for (let r = 1; r <= 2 && found < 0; r++) {
        for (let dy = -r; dy <= r && found < 0; dy++) {
          const ny = sy + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -r; dx <= r; dx++) {
            const nx = sx + dx;
            if (nx < 0 || nx >= width) continue;
            if (dx > -r && dx < r && dy > -r && dy < r) continue; // 只扫这一圈的边框
            const q = ny * width + nx;
            if (ok(q)) { found = q; break; }
          }
        }
      }
      if (found < 0) continue;
      sp = found;
    }
    if (selected[sp]) continue;

    selected[sp] = 1;
    stack.length = 0;
    stack.push(sp);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (selected[q] || !ok(q)) continue;
          selected[q] = 1;
          stack.push(q);
        }
      }
    }
  }
  return selected;
};

/** 去色溢出强度默认值（0-1） */
export const DESPILL_STRENGTH = 0.8;

/**
 * 去色溢出实际生效的强度。
 *
 * 界面上「去色溢出」的滑块在关闭「α 比例判定」时会变灰、不可拖动，
 * 文案也写着「需要开启 α 比例判定才有半透明边缘可以反解」。
 * 所以行为必须跟着一起关 —— 否则用户以为关掉了，实际上算法还在按旧强度改颜色。
 *
 * 早期三者不一致：despillEdge 算覆盖率用的是「到背景色距离的比值」，本身不依赖 mask 的 α，
 * 于是关掉比例判定后它照样生效（实测边缘像素 143,168,238 → 52,98,224）。
 * 这里统一收口，让三条渲染路径与界面说的一致。
 */
export const effectiveDespillStrength = (
  alphaRatio: boolean | undefined,
  strength: number | undefined
): number => {
  if (alphaRatio === false) return 0;
  const s = strength ?? 80;
  return Math.max(0, Math.min(1, s / 100));
};

/**
 * 去色溢出：把轮廓上混进背景色的像素还原成真实前景色。
 *
 * 依据 P = α·F + (1−α)·B，反解 F = (P − (1−α)·B) / α。
 *
 * 关键设计：**只处理轮廓带，并用「紧邻的内部像素」做覆盖率参照**。
 *
 * 为什么不直接用 mask 的 α：
 * α 是按局部对比度归一化的，浅色区域（比如肤色）旁边如果有同材质的深色阴影，
 * 它的 α 会被压到 130 左右 —— 看着像「半透明」，其实只是颜色浅。
 * 直接拿这个 α 去反解，整片皮肤、衣服都会被推成过饱和的颜色。
 *
 * 所以改成：对一个轮廓像素，找它 8 邻域里「不在轮廓带上」的前景像素当参照 Fref，
 * 覆盖率 = dist(P) / dist(Fref)。白边永远是「比旁边更接近背景」的那一圈，这个比值正好。
 *
 * 细发丝这类没有内部参照的结构，退回用「全图最大距离」估算。
 *
 * strength 0 = 完全不动；1 = 最激进。
 */
export const despillEdge = (
  data: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  target: RGB,
  width: number,
  height: number,
  strength: number = DESPILL_STRENGTH
) => {
  const s = Math.max(0, Math.min(1, strength));
  if (s <= 0) return;

  const tr = target.r, tg = target.g, tb = target.b;
  const total = width * height;

  // 每个像素到背景色的距离
  const dist = new Float32Array(total);
  let maxDist = 1;
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    if (data[i + 3] === 0) continue;
    const dr = data[i] - tr;
    const dg = data[i + 1] - tg;
    const db = data[i + 2] - tb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    dist[p] = d;
    if (d > maxDist) maxDist = d;
  }

  // 轮廓带 = 紧邻透明像素（α < 128）的前景像素，8 邻域
  const band = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (alpha[p] === 0 || alpha[p] < 128) continue;
      let touch = false;
      for (let dy = -1; dy <= 1 && !touch; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (alpha[ny * width + nx] < 128) { touch = true; break; }
        }
      }
      if (touch) band[p] = 1;
    }
  }

  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!band[p]) continue; // 主体内部一律不动

      // 找参照：8 邻域里「不在轮廓带上」的前景像素中，颜色方向最接近的那个。
      //
      // 不能取「距离背景最远」的邻居 —— 那样浅色主体旁边的深色阴影会被当成参照，
      // 把本来是纯肤色的像素误判成「只覆盖了一半」。
      const dp = dist[p];
      let refDist = 0;
      let bestSim = -2;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (alpha[q] === 0 || band[q]) continue;
          const dq = dist[q];
          if (dq <= 1 || dp <= 1) continue;

          const i2 = q * 4;
          const ux = (data[i2] - tr) / dq, uy = (data[i2 + 1] - tg) / dq, uz = (data[i2 + 2] - tb) / dq;
          const ip = p * 4;
          const vx = (data[ip] - tr) / dp, vy = (data[ip + 1] - tg) / dp, vz = (data[ip + 2] - tb) / dp;
          const sim = ux * vx + uy * vy + uz * vz;

          if (sim > bestSim) { bestSim = sim; refDist = dq; }
        }
      }
      // 方向差太多就不信任这个参照（换材质了），退回全图估算
      if (bestSim < 0.9) refDist = 0;

      // 有内部参照 → 用它；没有（细发丝）→ 退回全图最大距离
      const c = refDist > 1
        ? clamp(dist[p] / refDist, 0.2, 1)
        : clamp(dist[p] / maxDist, 0.25, 1);

      // 已经和内部参照一样「纯」了（≥92%），说明它本来就不是混合像素，别动它。
      // 不加这一步，浅色主体轮廓上那一圈会被误判成白边而推成过饱和色。
      if (refDist > 1 && c >= 0.92) continue;

      const i = p * 4;
      const fr = (data[i] - (1 - c) * tr) / c;
      const fg = (data[i + 1] - (1 - c) * tg) / c;
      const fb = (data[i + 2] - (1 - c) * tb) / c;

      data[i] = clamp255(data[i] + (fr - data[i]) * s);
      data[i + 1] = clamp255(data[i + 1] + (fg - data[i + 1]) * s);
      data[i + 2] = clamp255(data[i + 2] + (fb - data[i + 2]) * s);
    }
  }
};

/**
 * 把「原图归一化坐标」的手动编辑点，映射到某一次渲染缓冲的像素坐标。
 *
 * 预览、GIF、PNG 三条路径都是「从原图裁一块、画进自己的缓冲」，缩放和偏移各不相同，
 * 所以统一在这里换算，避免三处各写一遍出错。mode 原样带过去 —— 抠除和恢复在同一
 * 次渲染里按顺序回放，顺序不能丢。
 *
 * 【dst 参数是智能对齐的关键】
 * 默认（不传 dst）假设「源区域铺满整个缓冲」，也就是未对齐时的画法。
 * 开了智能对齐后，实际画上去的只是【内容包围盒】那一小块，而且被缩放并挪到了
 * 居中的位置 —— 此时必须把「源矩形」和「目标矩形」都传进来，否则种子点会按
 * 未对齐的老公式换算，落到错误位置：擦的是一块背景，用户抠掉的东西原样还在。
 *
 * 返回空数组表示这一帧里没有编辑点（绝大多数帧都是这种情况，调用方直接用即可）。
 */
export const mapEditSeeds = (
  points: EditPoint[] | undefined,
  sheetW: number,
  sheetH: number,
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
  bufW: number,
  bufH: number,
  /** 源矩形被画到缓冲区的哪一块；省略表示铺满整个缓冲 */
  dst?: { x: number; y: number; w: number; h: number }
): EditPoint[] => {
  if (!points || points.length === 0 || srcW <= 0 || srcH <= 0 || bufW <= 0 || bufH <= 0) return [];
  const dx = dst?.x ?? 0;
  const dy = dst?.y ?? 0;
  const dw = dst?.w ?? bufW;
  const dh = dst?.h ?? bufH;
  if (dw <= 0 || dh <= 0) return [];
  const out: EditPoint[] = [];
  for (const pt of points) {
    const px = pt.x * sheetW;
    const py = pt.y * sheetH;
    // 落在这一帧实际被画出来的源区域之外 → 这一帧不需要改
    if (px < srcX || py < srcY || px >= srcX + srcW || py >= srcY + srcH) continue;
    out.push({
      x: dx + ((px - srcX) / srcW) * dw,
      y: dy + ((py - srcY) / srcH) * dh,
      mode: pt.mode === 'restore' ? 'restore' : 'erase',
    });
  }
  return out;
};
