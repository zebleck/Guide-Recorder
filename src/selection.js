const overlay = document.getElementById("overlay");
const selectionEl = document.getElementById("selection");
const hud = document.getElementById("hud");

const state = {
  rect: null,
  action: null, // draw|move|resize
  handle: null,
  startX: 0,
  startY: 0,
  originRect: null,
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeRect(r) {
  const minW = 80;
  const minH = 80;
  const x = clamp(Math.round(r.x), 0, window.innerWidth - minW);
  const y = clamp(Math.round(r.y), 0, window.innerHeight - minH);
  const width = clamp(Math.round(r.width), minW, window.innerWidth - x);
  const height = clamp(Math.round(r.height), minH, window.innerHeight - y);
  return { x, y, width, height };
}

function drawRect() {
  if (!state.rect) {
    selectionEl.classList.add("hidden");
    return;
  }

  const r = normalizeRect(state.rect);
  state.rect = r;
  selectionEl.classList.remove("hidden");
  selectionEl.style.left = `${r.x}px`;
  selectionEl.style.top = `${r.y}px`;
  selectionEl.style.width = `${r.width}px`;
  selectionEl.style.height = `${r.height}px`;
  hud.textContent = `Area: x=${r.x}, y=${r.y}, ${r.width}x${r.height}  |  Enter confirm, Esc cancel`;
}

function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

function beginDraw(x, y) {
  state.action = "draw";
  state.startX = x;
  state.startY = y;
  state.rect = { x, y, width: 1, height: 1 };
  drawRect();
}

function beginMove(x, y) {
  state.action = "move";
  state.startX = x;
  state.startY = y;
  state.originRect = { ...state.rect };
}

function beginResize(handle, x, y) {
  state.action = "resize";
  state.handle = handle;
  state.startX = x;
  state.startY = y;
  state.originRect = { ...state.rect };
}

function isCornerHandle(handle) {
  return handle === "nw" || handle === "ne" || handle === "sw" || handle === "se";
}

function aspectLockedResize(handle, x, y, originRect) {
  const minW = 80;
  const minH = 80;
  const aspect = Math.max(0.0001, originRect.width / Math.max(1, originRect.height));

  const anchors = {
    nw: { fx: originRect.x + originRect.width, fy: originRect.y + originRect.height, signX: -1, signY: -1 },
    ne: { fx: originRect.x, fy: originRect.y + originRect.height, signX: +1, signY: -1 },
    sw: { fx: originRect.x + originRect.width, fy: originRect.y, signX: -1, signY: +1 },
    se: { fx: originRect.x, fy: originRect.y, signX: +1, signY: +1 },
  };
  const a = anchors[handle];
  if (!a) return normalizeRect(originRect);

  const rawW = Math.abs(x - a.fx);
  const rawH = Math.abs(y - a.fy);

  // Pick a target size driven by pointer movement while preserving aspect.
  let width = rawW;
  let height = width / aspect;
  if (rawH > 0 && rawW / Math.max(1, rawH) < aspect) {
    height = rawH;
    width = height * aspect;
  }

  // Clamp size to min and available space from the fixed anchor.
  const maxWByX = a.signX < 0 ? a.fx : window.innerWidth - a.fx;
  const maxHByY = a.signY < 0 ? a.fy : window.innerHeight - a.fy;
  const maxW = Math.max(1, Math.min(maxWByX, maxHByY * aspect));
  const minWRequired = Math.max(minW, minH * aspect);
  const targetW = clamp(width, Math.min(minWRequired, maxW), maxW);
  const targetH = targetW / aspect;

  const rx = a.signX < 0 ? a.fx - targetW : a.fx;
  const ry = a.signY < 0 ? a.fy - targetH : a.fy;

  return normalizeRect({
    x: rx,
    y: ry,
    width: targetW,
    height: targetH,
  });
}

function onPointerDown(e) {
  const x = e.clientX;
  const y = e.clientY;

  const handle = e.target?.dataset?.handle;
  if (handle && state.rect) {
    beginResize(handle, x, y);
    return;
  }

  if (state.rect && pointInRect(x, y, state.rect)) {
    beginMove(x, y);
    return;
  }

  beginDraw(x, y);
}

function onPointerMove(e) {
  if (!state.action) return;

  const x = clamp(e.clientX, 0, window.innerWidth);
  const y = clamp(e.clientY, 0, window.innerHeight);

  if (state.action === "draw") {
    const rx = Math.min(state.startX, x);
    const ry = Math.min(state.startY, y);
    const rw = Math.abs(x - state.startX);
    const rh = Math.abs(y - state.startY);
    state.rect = { x: rx, y: ry, width: rw, height: rh };
    drawRect();
    return;
  }

  if (state.action === "move") {
    const dx = x - state.startX;
    const dy = y - state.startY;
    const r = {
      x: state.originRect.x + dx,
      y: state.originRect.y + dy,
      width: state.originRect.width,
      height: state.originRect.height,
    };
    state.rect = normalizeRect(r);
    drawRect();
    return;
  }

  if (state.action === "resize") {
    if (e.shiftKey && isCornerHandle(state.handle)) {
      state.rect = aspectLockedResize(state.handle, x, y, state.originRect);
      drawRect();
      return;
    }

    let { x: rx, y: ry, width: rw, height: rh } = state.originRect;
    const right = rx + rw;
    const bottom = ry + rh;

    if (state.handle.includes("n")) {
      ry = y;
      rh = bottom - y;
    }
    if (state.handle.includes("s")) {
      rh = y - ry;
    }
    if (state.handle.includes("w")) {
      rx = x;
      rw = right - x;
    }
    if (state.handle.includes("e")) {
      rw = x - rx;
    }

    state.rect = normalizeRect({ x: rx, y: ry, width: rw, height: rh });
    drawRect();
  }
}

function onPointerUp() {
  if (!state.action) return;
  state.action = null;
  state.handle = null;
  state.originRect = null;
  if (state.rect) {
    state.rect = normalizeRect(state.rect);
    drawRect();
  }
}

function confirmSelection() {
  if (!state.rect) {
    window.selectionApi.cancel();
    return;
  }
  const r = normalizeRect(state.rect);
  window.selectionApi.confirm(r);
}

function onKeyDown(e) {
  if (e.key === "Escape") {
    window.selectionApi.cancel();
    return;
  }
  if (e.key === "Enter") {
    confirmSelection();
  }
}

async function init() {
  const ctx = await window.selectionApi.getContext();
  if (!ctx) {
    window.selectionApi.cancel();
    return;
  }

  if (ctx.initialRect && Number.isFinite(Number(ctx.initialRect.width)) && Number.isFinite(Number(ctx.initialRect.height))) {
    state.rect = {
      x: Number(ctx.initialRect.x || 0),
      y: Number(ctx.initialRect.y || 0),
      width: Number(ctx.initialRect.width || 0),
      height: Number(ctx.initialRect.height || 0),
    };
  } else {
    // Start with a centered 60% area so user can adjust quickly.
    const w = Math.round(window.innerWidth * 0.6);
    const h = Math.round(window.innerHeight * 0.6);
    state.rect = {
      x: Math.round((window.innerWidth - w) / 2),
      y: Math.round((window.innerHeight - h) / 2),
      width: w,
      height: h,
    };
  }
  drawRect();

  overlay.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
}

init().catch(() => window.selectionApi.cancel());
