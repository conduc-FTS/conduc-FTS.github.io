/**
 * signature.js — Capture de signature tactile réutilisable.
 * Usage : FTSSignature.init("idDuCanvas", "idDuHint") puis
 * FTSSignature.getDataUrl(id) / FTSSignature.clear(id) / FTSSignature.hasSignature(id)
 */

const FTSSignature = (() => {
  const instances = {};

  function init(canvasId, hintId) {
    const canvas = document.getElementById(canvasId);
    const hint = hintId ? document.getElementById(hintId) : null;
    const ctx = canvas.getContext("2d");
    const state = { hasSig: false, dataUrl: null, drawing: false };
    instances[canvasId] = state;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const nw = Math.floor(rect.width * dpr), nh = Math.floor(rect.height * dpr);
      if (canvas.width === nw && canvas.height === nh) return;
      canvas.width = nw;
      canvas.height = nh;
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = "#1A1A1A";
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (state.dataUrl) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
        img.src = state.dataUrl;
      }
    }
    resize();
    window.addEventListener("resize", resize);

    function getPos(e) {
      const r = canvas.getBoundingClientRect();
      const s = e.touches ? e.touches[0] : e;
      return { x: s.clientX - r.left, y: s.clientY - r.top };
    }
    function save() {
      const flat = document.createElement("canvas");
      flat.width = canvas.width;
      flat.height = canvas.height;
      const fc = flat.getContext("2d");
      fc.fillStyle = "#FFFFFF";
      fc.fillRect(0, 0, flat.width, flat.height);
      fc.drawImage(canvas, 0, 0);
      state.dataUrl = flat.toDataURL("image/jpeg", 0.95);
      state.hasSig = true;
    }

    canvas.addEventListener("mousedown", (e) => { e.preventDefault(); state.drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); if (hint) hint.style.opacity = "0"; });
    canvas.addEventListener("mousemove", (e) => { e.preventDefault(); if (!state.drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
    canvas.addEventListener("mouseup", (e) => { e.preventDefault(); state.drawing = false; save(); });
    canvas.addEventListener("touchstart", (e) => { e.preventDefault(); state.drawing = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); if (hint) hint.style.opacity = "0"; }, { passive: false });
    canvas.addEventListener("touchmove", (e) => { e.preventDefault(); if (!state.drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); }, { passive: false });
    canvas.addEventListener("touchend", (e) => { e.preventDefault(); state.drawing = false; save(); }, { passive: false });
  }

  function clear(canvasId) {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (instances[canvasId]) {
      instances[canvasId].hasSig = false;
      instances[canvasId].dataUrl = null;
    }
  }

  function getDataUrl(canvasId) {
    return instances[canvasId] ? instances[canvasId].dataUrl : null;
  }

  function hasSignature(canvasId) {
    return instances[canvasId] ? instances[canvasId].hasSig : false;
  }

  return { init, clear, getDataUrl, hasSignature };
})();

// Exposition explicite sur window : une déclaration top-level en const/let
// ne crée PAS de propriété window.FTSSignature automatiquement (contrairement à var),
// alors que tout le reste du code vérifie window.FTSSignature avant utilisation.
window.FTSSignature = FTSSignature;
