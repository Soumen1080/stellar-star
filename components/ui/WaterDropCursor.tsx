"use client";

import { useEffect, useCallback, useRef } from "react";

interface Ripple {
  id: number;
  x: number;
  y: number;
  startTime: number;
}

const RIPPLE_DURATION = 900; // ms
const MAX_RIPPLE_RADIUS = 80;
const RIPPLE_COUNT = 3; // concentric rings per click
const RING_DELAY = 80; // ms stagger between rings

export default function WaterDropCursor() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ripplesRef = useRef<Ripple[]>([]);
  const nextIdRef = useRef(0);
  const rafRef = useRef<number>(0);

  // ---------- resize canvas to viewport ----------
  const resize = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = window.innerWidth;
    c.height = window.innerHeight;
  }, []);

  // ---------- animation loop ----------
  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, c.width, c.height);

    const now = performance.now();
    const alive: Ripple[] = [];

    for (const r of ripplesRef.current) {
      const elapsed = now - r.startTime;
      if (elapsed > RIPPLE_DURATION) continue;
      alive.push(r);

      const progress = elapsed / RIPPLE_DURATION; // 0 → 1
      const easedProgress = 1 - Math.pow(1 - progress, 3); // ease-out cubic

      const radius = easedProgress * MAX_RIPPLE_RADIUS;
      const opacity = 1 - easedProgress;

      // outer glow
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(45, 212, 191, ${opacity * 0.35})`;
      ctx.lineWidth = 2 + (1 - easedProgress) * 3;
      ctx.stroke();

      // inner highlight
      if (progress < 0.5) {
        const innerOpacity = 1 - progress * 2;
        const grad = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, radius * 0.5);
        grad.addColorStop(0, `rgba(45, 212, 191, ${innerOpacity * 0.18})`);
        grad.addColorStop(1, `rgba(45, 212, 191, 0)`);
        ctx.beginPath();
        ctx.arc(r.x, r.y, radius * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    ripplesRef.current = alive;
    rafRef.current = requestAnimationFrame(draw);
  }, []);

  // ---------- spawn ripples on click ----------
  const handleClick = useCallback((e: MouseEvent) => {
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      ripplesRef.current.push({
        id: nextIdRef.current++,
        x: e.clientX,
        y: e.clientY,
        startTime: performance.now() + i * RING_DELAY,
      });
    }
  }, []);

  // ---------- spawn subtle ripple on move (throttled) ----------
  const lastMoveRef = useRef(0);
  const handleMove = useCallback((e: MouseEvent) => {
    const now = performance.now();
    if (now - lastMoveRef.current < 120) return; // throttle
    lastMoveRef.current = now;

    ripplesRef.current.push({
      id: nextIdRef.current++,
      x: e.clientX,
      y: e.clientY,
      startTime: now,
    });
  }, []);

  // ---------- lifecycle ----------
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = `
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: 99999;
    `;
    document.body.appendChild(canvas);
    canvasRef.current = canvas;

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("click", handleClick);
    window.addEventListener("mousemove", handleMove);
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("click", handleClick);
      window.removeEventListener("mousemove", handleMove);
      canvas.remove();
    };
  }, [resize, handleClick, handleMove, draw]);

  return null; // renders nothing in React tree — uses a raw canvas overlay
}
