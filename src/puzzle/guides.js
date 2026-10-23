// 2D overlay over the WebGL canvas, LEGO style: numbered pegs on the held part, matching numbered holes where each one
// attaches (real welds, bolts and joints from the FE model), lines from peg to hole, a ring at the part's home while
// it is dragged (easy) or hinted, and bursts at the weld points when a part snaps in. A dozen dots per frame: cheap.
const PARTNER_COLORS = ['#4fc3f7', '#ffb74d', '#ce93d8', '#aed581', '#f48fb1', '#fff176', '#4db6ac', '#ff8a65'];
const FONT = 'bold 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export class Guides {
  constructor(game, canvas) {
    this.game = game;
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.blank = true;
  }

  draw() {
    const { game, canvas, g } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      this.blank = false;
    }
    const pts = game.guidePoints();
    const ring = game.homeRing();
    const bursts = game.bursts;
    if (!pts.length && !ring && !bursts.length) {
      if (!this.blank) g.clearRect(0, 0, w, h);
      this.blank = true;
      return;
    }
    this.blank = false;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const scr = (p) => game.project(game.toWorld(p));

    if (ring?.r) {
      g.beginPath();
      g.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
      g.setLineDash([6, 5]);
      g.lineWidth = 2;
      g.strokeStyle = ring.ok ? '#3ddc84' : '#ffd23f';
      g.stroke();
      g.setLineDash([]);
    }

    const bands = game.rules?.bands;
    const pairs = pts.map((p) => ({ ...p, a: scr(p.peg), b: scr(p.hole), col: PARTNER_COLORS[p.color % PARTNER_COLORS.length] }));
    if (bands) {
      g.lineWidth = 1.5;
      for (const p of pairs) {
        if (!p.a.visible || !p.b.visible) continue;
        g.strokeStyle = `${p.col}aa`;
        g.beginPath();
        g.moveTo(p.a.x, p.a.y);
        g.lineTo(p.b.x, p.b.y);
        g.stroke();
      }
    }
    g.font = FONT;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const p of pairs) {
      if (p.b.visible) {
        // hole: ring
        g.beginPath();
        g.arc(p.b.x, p.b.y, 9, 0, Math.PI * 2);
        g.fillStyle = 'rgba(20, 23, 27, 0.55)';
        g.fill();
        g.lineWidth = 2.5;
        g.strokeStyle = p.col;
        g.stroke();
        g.fillStyle = '#fff';
        g.fillText(String(p.label), p.b.x, p.b.y + 0.5);
      }
      if (p.a.visible) {
        // peg: filled disc
        g.beginPath();
        g.arc(p.a.x, p.a.y, 8, 0, Math.PI * 2);
        g.fillStyle = p.col;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = 'rgba(20, 23, 27, 0.8)';
        g.stroke();
        g.fillStyle = '#14171b';
        g.fillText(String(p.label), p.a.x, p.a.y + 0.5);
      }
    }

    for (const b of bursts) {
      const t = (b.t - b.delay) / 0.7;
      if (t < 0) continue;
      const s = scr(b.point);
      if (!s.visible) continue;
      g.beginPath();
      g.arc(s.x, s.y, 3 + t * 16, 0, Math.PI * 2);
      g.lineWidth = 2.5 * (1 - t);
      g.strokeStyle = `rgba(61, 220, 132, ${1 - t})`;
      g.stroke();
    }
  }
}
