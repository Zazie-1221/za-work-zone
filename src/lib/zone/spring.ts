/**
 * 小型弹簧：把一组数值从 from 带到 to，用解析解（欠阻尼二阶系统），不逐帧积分，也不依赖动画库。
 * 默认 stiffness 300 / damping 28 / mass 1：约 1% 过冲，~350ms 落定。
 */
export type SpringOptions = { stiffness?: number; damping?: number; mass?: number };

export const MORPH_SPRING: Required<SpringOptions> = { stiffness: 300, damping: 28, mass: 1 };

/** Collapse spring: critically damped, no overshoot, so nothing wobbles at the end. */
export const COLLAPSE_SPRING: Required<SpringOptions> = { stiffness: 380, damping: 40, mass: 1 };

/** 0 到 1 的弹簧位移（初速度 0）。t 单位秒。 */
export function springProgress(t: number, options: SpringOptions = {}): number {
  const { stiffness, damping, mass } = { ...MORPH_SPRING, ...options };
  if (t <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * w0 * t);
    return 1 - decay * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  // 临界 / 过阻尼：按临界阻尼处理，没有过冲。
  const decay = Math.exp(-w0 * t);
  return 1 - decay * (1 + w0 * t);
}

/** 弹簧基本落定（包络小于 0.15%）所需秒数。 */
export function springDuration(options: SpringOptions = {}): number {
  const { stiffness, damping, mass } = { ...MORPH_SPRING, ...options };
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = Math.min(1, damping / (2 * Math.sqrt(stiffness * mass)));
  return Math.log(1 / 0.0015) / (zeta * w0);
}

export type SpringRun = { done: Promise<void>; cancel: () => void };

/**
 * 跑一次弹簧。onFrame 每帧收到插值后的数组；最后一帧一定是精确的 to，之后不再有任何动画。
 * done 在结束或被 cancel 时 resolve。
 */
export function animateSpring(
  from: number[],
  to: number[],
  onFrame: (values: number[]) => void,
  options: SpringOptions = {},
): SpringRun {
  const total = springDuration(options) * 1000;
  let raf = 0;
  let finished = false;
  let resolve: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const start = performance.now();
  const step = (now: number) => {
    if (finished) return;
    const elapsed = now - start;
    if (elapsed >= total) {
      finished = true;
      onFrame(to.slice());
      resolve();
      return;
    }
    const p = springProgress(elapsed / 1000, options);
    onFrame(from.map((value, index) => value + (to[index] - value) * p));
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return {
    done,
    cancel: () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      resolve();
    },
  };
}
