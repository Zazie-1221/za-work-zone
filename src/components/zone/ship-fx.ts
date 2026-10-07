/** 交付完成庆祝。调参只改这里。颜色全部来自冷色板。 */
export const SHIP_FX = {
  count: 36,
  gravity: 980,
  drag: 2.2,
  duration: 2000,
  particleStart: 600,
  particleEnd: 1800,
  sizeMin: 3,
  sizeMax: 7,
  silver: "#E8EEF0",
  ash: "#AFB3B7",
  ice: "#7FD6D9",
  ink: "#16333B",
  colors: [
    { color: "#E8EEF0", until: 0.6 },
    { color: "#7FD6D9", until: 0.9 },
    { color: "#AFB3B7", until: 1 },
  ],
} as const;

export type MotionLevel = "full" | "lite" | "off";

const MOTION_KEY = "za-motion";

export function readMotion(): MotionLevel {
  const stored = localStorage.getItem(MOTION_KEY);
  if (stored === "lite" || stored === "off" || stored === "full") return stored;
  return "full";
}

export function writeMotion(level: MotionLevel) {
  localStorage.setItem(MOTION_KEY, level);
}

export function nextMotion(level: MotionLevel): MotionLevel {
  if (level === "full") return "lite";
  if (level === "lite") return "off";
  return "full";
}

/** 系统开了减少动态效果时，一律当作关闭。 */
export function effectiveMotion(level: MotionLevel): MotionLevel {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "off";
  return level;
}

export function shipSeenKey(workspaceId: string) {
  return `za-shipped:${workspaceId}`;
}

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  gem: boolean;
  color: string;
  rot: number;
  spin: number;
  born: number;
  life: number;
};

function pickColor() {
  const roll = Math.random();
  return SHIP_FX.colors.find((item) => roll <= item.until)?.color ?? SHIP_FX.silver;
}

export function startShipParticles(rail: HTMLElement | null): () => void {
  const panel = rail?.closest(".zone-panel");
  const origin = rail?.querySelector<HTMLElement>("[data-ship='delivery'] .ship-box");
  if (!rail || !(panel instanceof HTMLElement) || !origin) return () => {};

  const canvas = document.createElement("canvas");
  canvas.className = "ship-canvas";
  canvas.setAttribute("aria-hidden", "true");
  panel.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return () => {};
  }

  const panelBox = () => panel.getBoundingClientRect();
  const placeCanvas = () => {
    const box = panelBox();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(box.width * dpr));
    canvas.height = Math.max(1, Math.floor(box.height * dpr));
    canvas.style.width = `${box.width}px`;
    canvas.style.height = `${box.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  placeCanvas();

  const box = panelBox();
  const icon = origin.getBoundingClientRect();
  const scale = Math.min(1, Math.max(0.45, box.width / 360));
  const ox = icon.left - box.left + icon.width / 2;
  const oy = icon.top - box.top + icon.height / 2;
  const life = (SHIP_FX.particleEnd - SHIP_FX.particleStart) / 1000;
  const particles: Particle[] = Array.from({ length: SHIP_FX.count }, () => {
    const angle = -Math.PI * (0.08 + Math.random() * 0.84);
    const speed = (90 + Math.random() * 260) * scale;
    return {
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r: SHIP_FX.sizeMin + Math.random() * (SHIP_FX.sizeMax - SHIP_FX.sizeMin),
      gem: Math.random() > 0.55,
      color: pickColor(),
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 6,
      born: Math.random() * 0.08,
      life,
    };
  });

  let raf = 0;
  let dead = false;
  let last = performance.now();
  const started = last;
  const draw = (now: number) => {
    if (dead) return;
    const bounds = panelBox();
    const dt = Math.min(0.032, (now - last) / 1000);
    last = now;
    const elapsed = (now - started) / 1000;
    ctx.clearRect(0, 0, bounds.width, bounds.height);
    let alive = false;
    for (const particle of particles) {
      const age = elapsed - particle.born;
      if (age < 0) {
        alive = true;
        continue;
      }
      if (age > particle.life) continue;
      alive = true;
      const damp = Math.exp(-SHIP_FX.drag * dt);
      particle.vx *= damp;
      particle.vy *= damp;
      particle.vy += SHIP_FX.gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.rot += particle.spin * dt;
      if (particle.x < -20 || particle.y < -20 || particle.x > bounds.width + 20 || particle.y > bounds.height + 20) continue;
      const fade = age > particle.life * 0.5 ? 1 - (age - particle.life * 0.5) / (particle.life * 0.5) : 1;
      const radius = particle.r * (0.45 + 0.55 * fade);
      ctx.save();
      ctx.translate(particle.x, particle.y + 1.5);
      ctx.rotate(particle.rot);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = fade * 0.28;
      ctx.fillStyle = SHIP_FX.ink;
      paintShape(ctx, particle.gem, radius);
      ctx.translate(0, -1.5);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = fade;
      ctx.fillStyle = particle.color;
      paintShape(ctx, particle.gem, radius);
      ctx.restore();
    }
    if (alive && elapsed < life + 0.1) raf = requestAnimationFrame(draw);
    else canvas.remove();
  };
  raf = requestAnimationFrame(draw);

  return () => {
    dead = true;
    cancelAnimationFrame(raf);
    canvas.remove();
  };
}

function paintShape(ctx: CanvasRenderingContext2D, gem: boolean, radius: number) {
  if (!gem) {
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.save();
  ctx.scale(0.42, 1);
  ctx.beginPath();
  ctx.moveTo(0, -radius);
  ctx.lineTo(radius, 0);
  ctx.lineTo(0, radius);
  ctx.lineTo(-radius, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
