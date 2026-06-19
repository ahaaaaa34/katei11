/**
 * TRIG MASTER — app.js
 * Main application module for the Trigonometry Learning PWA.
 *
 * Architecture:
 *  - ProblemManager   : Problem dataset + progression
 *  - AnswerEditor     : Inline token-based answer expression builder
 *                       with fraction state-machine (denominator → numerator → exit)
 *  - CanvasManager    : Pressure-sensitive drawing canvas with tools
 *  - KeyboardManager  : Custom keyboard binding & ripple effects
 *  - AppController    : Orchestrates all modules + UI state (fullscreen, panels)
 */

"use strict";

/* =======================================================
   SECTION 1: CATEGORIES & PROBLEM GENERATOR
   ======================================================= */

const CATEGORIES = [
  { id: "all",         label: "全て" },
  { id: "basic",       label: "基本値" },
  { id: "equation",    label: "方程式" },
  { id: "maxmin",      label: "最大最小" },
  { id: "relation",    label: "相互関係" },
  { id: "graph",       label: "グラフ" },
  { id: "composition", label: "合成" },
  { id: "inequality",  label: "不等式" },
  { id: "addition",    label: "加法定理" },
];

/* Trig value lookup: text (for answer check) + katex (for display) */
const V = {
  "0":      { t: "0",      k: "0" },
  "1":      { t: "1",      k: "1" },
  "-1":     { t: "-1",     k: "-1" },
  "1/2":    { t: "1/2",    k: "\\dfrac{1}{2}" },
  "-1/2":   { t: "-1/2",   k: "-\\dfrac{1}{2}" },
  "√2/2":   { t: "√2/2",   k: "\\dfrac{\\sqrt{2}}{2}" },
  "-√2/2":  { t: "-√2/2",  k: "-\\dfrac{\\sqrt{2}}{2}" },
  "√3/2":   { t: "√3/2",   k: "\\dfrac{\\sqrt{3}}{2}" },
  "-√3/2":  { t: "-√3/2",  k: "-\\dfrac{\\sqrt{3}}{2}" },
  "√3":     { t: "√3",     k: "\\sqrt{3}" },
  "-√3":    { t: "-√3",    k: "-\\sqrt{3}" },
  "√3/3":   { t: "√3/3",   k: "\\dfrac{\\sqrt{3}}{3}" },
  "-√3/3":  { t: "-√3/3",  k: "-\\dfrac{\\sqrt{3}}{3}" },
};

/* 16 standard angles with their exact trig values (keys into V) */
const ANGLES = [
  { rad: "0",     deg: 0,   rk: "0",                      sin: "0",     cos: "1",     tan: "0" },
  { rad: "π/6",   deg: 30,  rk: "\\dfrac{\\pi}{6}",       sin: "1/2",   cos: "√3/2",  tan: "√3/3" },
  { rad: "π/4",   deg: 45,  rk: "\\dfrac{\\pi}{4}",       sin: "√2/2",  cos: "√2/2",  tan: "1" },
  { rad: "π/3",   deg: 60,  rk: "\\dfrac{\\pi}{3}",       sin: "√3/2",  cos: "1/2",   tan: "√3" },
  { rad: "π/2",   deg: 90,  rk: "\\dfrac{\\pi}{2}",       sin: "1",     cos: "0",     tan: null },
  { rad: "2π/3",  deg: 120, rk: "\\dfrac{2\\pi}{3}",      sin: "√3/2",  cos: "-1/2",  tan: "-√3" },
  { rad: "3π/4",  deg: 135, rk: "\\dfrac{3\\pi}{4}",      sin: "√2/2",  cos: "-√2/2", tan: "-1" },
  { rad: "5π/6",  deg: 150, rk: "\\dfrac{5\\pi}{6}",      sin: "1/2",   cos: "-√3/2", tan: "-√3/3" },
  { rad: "π",     deg: 180, rk: "\\pi",                    sin: "0",     cos: "-1",    tan: "0" },
  { rad: "7π/6",  deg: 210, rk: "\\dfrac{7\\pi}{6}",      sin: "-1/2",  cos: "-√3/2", tan: "√3/3" },
  { rad: "5π/4",  deg: 225, rk: "\\dfrac{5\\pi}{4}",      sin: "-√2/2", cos: "-√2/2", tan: "1" },
  { rad: "4π/3",  deg: 240, rk: "\\dfrac{4\\pi}{3}",      sin: "-√3/2", cos: "-1/2",  tan: "√3" },
  { rad: "3π/2",  deg: 270, rk: "\\dfrac{3\\pi}{2}",      sin: "-1",    cos: "0",     tan: null },
  { rad: "5π/3",  deg: 300, rk: "\\dfrac{5\\pi}{3}",      sin: "-√3/2", cos: "1/2",   tan: "-√3" },
  { rad: "7π/4",  deg: 315, rk: "\\dfrac{7\\pi}{4}",      sin: "-√2/2", cos: "√2/2",  tan: "-1" },
  { rad: "11π/6", deg: 330, rk: "\\dfrac{11\\pi}{6}",     sin: "-1/2",  cos: "√3/2",  tan: "-√3/3" },
];

class ProblemGenerator {
  static _pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  static generate(catId, angleNotation = "random") {
    if (catId === "all") {
      catId = ProblemGenerator._pick(CATEGORIES.filter(c => c.id !== "all")).id;
    }
    return ProblemGenerator["_" + catId](angleNotation);
  }

  /* ---- 基本値: pick angle × function, return value ---- */
  static _basic(angleNotation = "random") {
    const fn = ProblemGenerator._pick(["sin", "cos", "tan"]);
    let pool = ANGLES.filter(a => a.deg > 0); // exclude 0
    if (fn === "tan") pool = pool.filter(a => a.tan !== null);
    const ang = ProblemGenerator._pick(pool);
    const val = V[ang[fn]];
    let useDeg;
    if (angleNotation === "degree") useDeg = true;
    else if (angleNotation === "radian") useDeg = false;
    else useDeg = Math.random() < 0.35;
    const aDisp = useDeg ? `${ang.deg}°` : ang.rk;
    // --- 途中式 ---
    const aRad = ang.rk; // ラジアン表記
    let steps;
    if (fn === "sin") {
      steps = [
        `単位円上で $\\theta = ${aDisp}$ の点を考えます。`,
        `$\\theta = ${aRad}$ は第 ${ang.deg <= 90 ? 1 : ang.deg <= 180 ? 2 : ang.deg <= 270 ? 3 : 4} 象限の角です。`,
        `$\\sin \\theta$ は単位円上の点の $y$ 座標です。`,
        `$\\therefore \\sin ${aDisp} = ${val.k}$`,
      ];
    } else if (fn === "cos") {
      steps = [
        `単位円上で $\\theta = ${aDisp}$ の点を考えます。`,
        `$\\theta = ${aRad}$ は第 ${ang.deg <= 90 ? 1 : ang.deg <= 180 ? 2 : ang.deg <= 270 ? 3 : 4} 象限の角です。`,
        `$\\cos \\theta$ は単位円上の点の $x$ 座標です。`,
        `$\\therefore \\cos ${aDisp} = ${val.k}$`,
      ];
    } else {
      const sv = V[ang.sin]; const cv = V[ang.cos];
      steps = [
        `$\\tan \\theta = \\dfrac{\\sin \\theta}{\\cos \\theta}$ を利用します。`,
        `$\\sin ${aDisp} = ${sv.k},\\quad \\cos ${aDisp} = ${cv.k}$`,
        `$\\tan ${aDisp} = \\dfrac{${sv.k}}{${cv.k}}$`,
        `$\\therefore \\tan ${aDisp} = ${val.k}$`,
      ];
    }
    return {
      category: "基本値",
      text: `$\\${fn}\\,${aDisp}$ の値を求めなさい。`,
      hint: `単位円上で角度の位置を確認し、${fn === "sin" ? "y 座標" : fn === "cos" ? "x 座標" : "y/x の比"}を読み取ろう。`,
      answer: val.t,
      answerDisplay: val.k,
      steps,
    };
  }

  /* ---- 方程式: sin θ = v → find all θ ---- */
  static _equation(_angleNotation) {
    const fn = ProblemGenerator._pick(["sin", "cos"]);
    const targetKey = ProblemGenerator._pick(["1/2", "-1/2", "√2/2", "-√2/2", "√3/2", "-√3/2"]);
    const val = V[targetKey];
    const solutions = ANGLES.filter(a => a[fn] === targetKey);
    if (solutions.length === 0) return ProblemGenerator._basic();
    const ansText = solutions.map(s => s.rad).join(",");
    const ansKatex = solutions.map(s => s.rk).join(",\\;");
    const coord = fn === "sin" ? "y 座標" : "x 座標";
    const solList = solutions.map(s => `$\\theta = ${s.rk}$`).join("、");
    const steps = [
      `$\\${fn}\\,\\theta = ${val.k}$ となる $\\theta$ を $0 \\leqq \\theta < 2\\pi$ の範囲で探します。`,
      `単位円で ${coord} が $${val.k}$ になる点を確認します。`,
      `該当する角度は ${solList} です。`,
      `$\\therefore \\theta = ${ansKatex}$`,
    ];
    return {
      category: "方程式",
      text: `$0 \\leqq \\theta < 2\\pi$ のとき、$\\${fn}\\,\\theta = ${val.k}$ を満たす $\\theta$ をすべて求めなさい。`,
      hint: `${fn} θ が ${targetKey} になる角度を単位円で探そう。`,
      answer: ansText,
      answerDisplay: `\\theta = ${ansKatex}`,
      steps,
    };
  }

  /* ---- 最大最小: y = a sin θ + b ---- */
  static _maxmin(_angleNotation) {
    const a = ProblemGenerator._pick([1, 2, 3]);
    const b = ProblemGenerator._pick([-3, -2, -1, 0, 1, 2, 3]);
    const full = Math.random() < 0.5;
    const maxV = (full ? a : a) + b;
    const minV = (full ? -a : 0) + b;
    const rng = full ? "0 \\leqq \\theta \\leqq 2\\pi" : "0 \\leqq \\theta \\leqq \\pi";
    const aS = a === 1 ? "" : String(a);
    const bS = b > 0 ? ` + ${b}` : b < 0 ? ` - ${Math.abs(b)}` : "";
    const sinRange = full ? "-1 \\leqq \\sin \\theta \\leqq 1" : "0 \\leqq \\sin \\theta \\leqq 1";
    const sinRangeMulti = full
      ? `-${a} \\leqq ${aS}\\sin \\theta \\leqq ${a}`
      : `0 \\leqq ${aS}\\sin \\theta \\leqq ${a}`;
    const bTerm = b !== 0 ? ` ${b > 0 ? "+" : "-"} ${Math.abs(b)}` : "";
    const steps = [
      `$\\sin \\theta$ の範囲を求めます：$${sinRange}$`,
      `各辺に $${a === 1 ? "" : a}$ を掛けます：$${sinRangeMulti}$`,
      b !== 0
        ? `各辺に $${b > 0 ? "+" : ""}${b}$ を加えます：$${minV} \\leqq ${aS}\\sin\\theta${bS} \\leqq ${maxV}$`
        : `よって $y = ${aS}\\sin\\theta$ の範囲：$${minV} \\leqq y \\leqq ${maxV}$`,
      `$\\therefore$ 最大値 $= ${maxV}$、最小値 $= ${minV}$`,
    ];
    return {
      category: "最大最小",
      text: `$${rng}$ のとき、$y = ${aS}\\sin \\theta${bS}$ の最大値と最小値を求めなさい。`,
      hint: `sin θ の範囲は ${full ? "-1 ≦ sin θ ≦ 1" : "0 ≦ sin θ ≦ 1（この区間では）"}。`,
      answer: `最大値${maxV},最小値${minV}`,
      answerDisplay: `\\text{最大値} = ${maxV},\\; \\text{最小値} = ${minV}`,
      steps,
    };
  }

  /* ---- 相互関係: sin θ + cos θ = S → sin θ cos θ ---- */
  static _relation(_angleNotation) {
    const pool = [
      { s: "\\dfrac{1}{2}",  sv: "1/2",  ans: "-3/8",  ak: "-\\dfrac{3}{8}" },
      { s: "-\\dfrac{1}{2}", sv: "-1/2", ans: "-3/8",  ak: "-\\dfrac{3}{8}" },
      { s: "1",              sv: "1",    ans: "0",     ak: "0" },
      { s: "-1",             sv: "-1",   ans: "0",     ak: "0" },
      { s: "0",              sv: "0",    ans: "-1/2",  ak: "-\\dfrac{1}{2}" },
    ];
    const p = ProblemGenerator._pick(pool);
    // s^2 = sv^2
    const sq = (sv) => { try { const n = eval(sv.replace("√","Math.sqrt(")+")"); return String(Math.round(n*n*100)/100); } catch(e){ return sv+"²"; } };
    const sSquared = p.sv === "1/2" || p.sv === "-1/2" ? "\\dfrac{1}{4}"
                   : p.sv === "0" ? "0" : p.sv === "1" || p.sv === "-1" ? "1" : p.sv+"^2";
    const steps = [
      `$\\sin \\theta + \\cos \\theta = ${p.s}$ の両辺を $2$ 乗します。`,
      `$(\\sin \\theta + \\cos \\theta)^2 = ${sSquared}$`,
      `$\\sin^2 \\theta + 2\\sin \\theta \\cos \\theta + \\cos^2 \\theta = ${sSquared}$`,
      `$\\sin^2 \\theta + \\cos^2 \\theta = 1$ を代入します：`,
      `$1 + 2\\sin \\theta \\cos \\theta = ${sSquared}$`,
      `$2\\sin \\theta \\cos \\theta = ${sSquared} - 1$`,
      `$\\therefore \\sin \\theta \\cos \\theta = ${p.ak}$`,
    ];
    return {
      category: "相互関係",
      text: `$\\sin \\theta + \\cos \\theta = ${p.s}$ のとき、$\\sin \\theta \\cos \\theta$ の値を求めなさい。`,
      hint: "両辺を 2 乗すると sin²θ + 2sinθcosθ + cos²θ = …。sin²θ + cos²θ = 1 を使おう。",
      answer: p.ans,
      answerDisplay: p.ak,
      steps,
    };
  }

  /* ---- グラフ: period of y = sin(aθ + b) ---- */
  static _graph(_angleNotation) {
    const a = ProblemGenerator._pick([2, 3, 4]);
    const periods = { 2: { t: "π", k: "\\pi" }, 3: { t: "2π/3", k: "\\dfrac{2\\pi}{3}" }, 4: { t: "π/2", k: "\\dfrac{\\pi}{2}" } };
    const period = periods[a];
    const phases = [
      { k: "" },
      { k: " - \\dfrac{\\pi}{3}" },
      { k: " + \\dfrac{\\pi}{4}" },
      { k: " - \\dfrac{\\pi}{6}" },
    ];
    const phase = ProblemGenerator._pick(phases);
    const steps = [
      `$y = \\sin(a\\theta + b)$ の周期は $\\dfrac{2\\pi}{|a|}$ です。`,
      `この問題では $a = ${a}$ です。`,
      `周期 $= \\dfrac{2\\pi}{${a}} = ${period.k}$`,
      `$\\therefore$ 周期 $= ${period.k}$`,
    ];
    return {
      category: "グラフ",
      text: `$y = \\sin(${a}\\theta${phase.k})$ の周期を求めなさい。`,
      hint: `y = sin(aθ + b) の周期は 2π / |a|。ここでは a = ${a}。`,
      answer: period.t,
      answerDisplay: period.k,
      steps,
    };
  }

  /* ---- 合成: a sinθ + b cosθ = R sin(θ + φ) ---- */
  static _composition(_angleNotation) {
    const pool = [
      { expr: "\\sin \\theta + \\sqrt{3}\\cos \\theta",     a:1, b:"√3", bk:"\\sqrt{3}", R:"2", Rk:"2",            phi:"+\\dfrac{\\pi}{3}",  ans: "2sin(θ+π/3)",  ak: "2\\sin\\!\\left(\\theta + \\dfrac{\\pi}{3}\\right)" },
      { expr: "\\sin \\theta + \\cos \\theta",               a:1, b:"1",  bk:"1",          R:"√2", Rk:"\\sqrt{2}",  phi:"+\\dfrac{\\pi}{4}",  ans: "√2sin(θ+π/4)", ak: "\\sqrt{2}\\sin\\!\\left(\\theta + \\dfrac{\\pi}{4}\\right)" },
      { expr: "\\sqrt{3}\\sin \\theta + \\cos \\theta",     a:"√3", b:"1", bk:"1",        R:"2", Rk:"2",            phi:"+\\dfrac{\\pi}{6}",  ans: "2sin(θ+π/6)",  ak: "2\\sin\\!\\left(\\theta + \\dfrac{\\pi}{6}\\right)" },
      { expr: "\\sin \\theta - \\cos \\theta",               a:1, b:"-1", bk:"-1",         R:"√2", Rk:"\\sqrt{2}",  phi:"-\\dfrac{\\pi}{4}",  ans: "√2sin(θ-π/4)", ak: "\\sqrt{2}\\sin\\!\\left(\\theta - \\dfrac{\\pi}{4}\\right)" },
      { expr: "\\sqrt{3}\\sin \\theta - \\cos \\theta",     a:"√3", b:"-1", bk:"-1",       R:"2", Rk:"2",            phi:"-\\dfrac{\\pi}{6}",  ans: "2sin(θ-π/6)",  ak: "2\\sin\\!\\left(\\theta - \\dfrac{\\pi}{6}\\right)" },
    ];
    const p = ProblemGenerator._pick(pool);
    const steps = [
      `$a\\sin\\theta + b\\cos\\theta = R\\sin(\\theta + \\varphi)$ の公式を使います。`,
      `$R = \\sqrt{a^2 + b^2} = \\sqrt{${p.a}^2 + (${p.b})^2} = ${p.Rk}$`,
      `$\\tan\\varphi = \\dfrac{b}{a} = \\dfrac{${p.bk}}{${p.a === 1 ? "1" : p.a}}$ より $\\varphi = ${p.phi}$`,
      `$\\therefore ${p.expr} = ${p.ak}$`,
    ];
    return {
      category: "合成",
      text: `$${p.expr}$ を $R\\sin(\\theta + \\varphi)$ の形に変換しなさい（$R > 0$）。`,
      hint: "R = √(a² + b²)、tan φ = b/a を利用しよう。",
      answer: p.ans,
      answerDisplay: p.ak,
      steps,
    };
  }

  /* ---- 不等式: trig inequality → range of θ ---- */
  static _inequality(_angleNotation) {
    const pool = [
      { text: "$0 \\leqq \\theta < 2\\pi$ のとき、$\\cos \\theta \\geqq \\dfrac{\\sqrt{2}}{2}$ を満たす $\\theta$ の範囲を求めなさい。",
        hint: "cos θ = √2/2 となる θ = π/4, 7π/4 を境界にして考えよう。",
        answer: "0≦θ≦π/4,7π/4≦θ<2π", answerDisplay: "0 \\leqq \\theta \\leqq \\dfrac{\\pi}{4},\\; \\dfrac{7\\pi}{4} \\leqq \\theta < 2\\pi",
        steps: [
          "$\\cos \\theta = \\dfrac{\\sqrt{2}}{2}$ となる角度を求めます。",
          "$\\theta = \\dfrac{\\pi}{4},\\; \\dfrac{7\\pi}{4}$ が境界です。",
          "単位円で $x$ 座標 $\\geqq \\dfrac{\\sqrt{2}}{2}$ の範囲を確認します。",
          "$\\therefore 0 \\leqq \\theta \\leqq \\dfrac{\\pi}{4},\\; \\dfrac{7\\pi}{4} \\leqq \\theta < 2\\pi$",
        ] },
      { text: "$0 \\leqq \\theta < 2\\pi$ のとき、$\\sin \\theta \\geqq \\dfrac{1}{2}$ を満たす $\\theta$ の範囲を求めなさい。",
        hint: "sin θ = 1/2 となる θ = π/6, 5π/6 を境界に。",
        answer: "π/6≦θ≦5π/6", answerDisplay: "\\dfrac{\\pi}{6} \\leqq \\theta \\leqq \\dfrac{5\\pi}{6}",
        steps: [
          "$\\sin \\theta = \\dfrac{1}{2}$ となる角度を求めます。",
          "$\\theta = \\dfrac{\\pi}{6},\\; \\dfrac{5\\pi}{6}$ が境界です。",
          "単位円で $y$ 座標 $\\geqq \\dfrac{1}{2}$ の範囲（上半分）を確認します。",
          "$\\therefore \\dfrac{\\pi}{6} \\leqq \\theta \\leqq \\dfrac{5\\pi}{6}$",
        ] },
      { text: "$0 \\leqq \\theta < 2\\pi$ のとき、$\\cos \\theta < -\\dfrac{1}{2}$ を満たす $\\theta$ の範囲を求めなさい。",
        hint: "cos θ = -1/2 となる θ = 2π/3, 4π/3 を境界に。",
        answer: "2π/3<θ<4π/3", answerDisplay: "\\dfrac{2\\pi}{3} < \\theta < \\dfrac{4\\pi}{3}",
        steps: [
          "$\\cos \\theta = -\\dfrac{1}{2}$ となる角度を求めます。",
          "$\\theta = \\dfrac{2\\pi}{3},\\; \\dfrac{4\\pi}{3}$ が境界です。",
          "単位円で $x$ 座標 $< -\\dfrac{1}{2}$ の範囲（左側）を確認します。",
          "$\\therefore \\dfrac{2\\pi}{3} < \\theta < \\dfrac{4\\pi}{3}$",
        ] },
      { text: "$0 \\leqq \\theta < 2\\pi$ のとき、$\\sin \\theta \\leqq -\\dfrac{\\sqrt{3}}{2}$ を満たす $\\theta$ の範囲を求めなさい。",
        hint: "sin θ = -√3/2 となる θ = 4π/3, 5π/3 を境界に。",
        answer: "4π/3≦θ≦5π/3", answerDisplay: "\\dfrac{4\\pi}{3} \\leqq \\theta \\leqq \\dfrac{5\\pi}{3}",
        steps: [
          "$\\sin \\theta = -\\dfrac{\\sqrt{3}}{2}$ となる角度を求めます。",
          "$\\theta = \\dfrac{4\\pi}{3},\\; \\dfrac{5\\pi}{3}$ が境界です。",
          "単位円で $y$ 座標 $\\leqq -\\dfrac{\\sqrt{3}}{2}$ の範囲（下方）を確認します。",
          "$\\therefore \\dfrac{4\\pi}{3} \\leqq \\theta \\leqq \\dfrac{5\\pi}{3}$",
        ] },
      { text: "$0 \\leqq \\theta < 2\\pi$ のとき、$\\sin \\theta > \\dfrac{\\sqrt{2}}{2}$ を満たす $\\theta$ の範囲を求めなさい。",
        hint: "sin θ = √2/2 となる θ = π/4, 3π/4 を境界に。",
        answer: "π/4<θ<3π/4", answerDisplay: "\\dfrac{\\pi}{4} < \\theta < \\dfrac{3\\pi}{4}",
        steps: [
          "$\\sin \\theta = \\dfrac{\\sqrt{2}}{2}$ となる角度を求めます。",
          "$\\theta = \\dfrac{\\pi}{4},\\; \\dfrac{3\\pi}{4}$ が境界です。",
          "単位円で $y$ 座標 $> \\dfrac{\\sqrt{2}}{2}$ の範囲（上方）を確認します。",
          "$\\therefore \\dfrac{\\pi}{4} < \\theta < \\dfrac{3\\pi}{4}$",
        ] },
    ];
    const p = ProblemGenerator._pick(pool);
    return { category: "不等式", text: p.text, hint: p.hint, answer: p.answer, answerDisplay: p.answerDisplay, steps: p.steps };
  }

  /* ---- 加法定理: sin/cos of compound angle ---- */
  static _addition(_angleNotation) {
    const pool = [
      { text: "$\\sin 75°$ の値を加法定理を用いて求めなさい。",   hint: "75° = 45° + 30°。sin(A+B) = sinA cosB + cosA sinB", answer: "√6+√2/4", answerDisplay: "\\dfrac{\\sqrt{6}+\\sqrt{2}}{4}",
        steps: ["$75° = 45° + 30°$ と分解します。","$\\sin(A+B) = \\sin A\\cos B + \\cos A\\sin B$ を適用します。","$\\sin 75° = \\sin 45°\\cos 30° + \\cos 45°\\sin 30°$","$= \\dfrac{\\sqrt{2}}{2}\\cdot\\dfrac{\\sqrt{3}}{2} + \\dfrac{\\sqrt{2}}{2}\\cdot\\dfrac{1}{2} = \\dfrac{\\sqrt{6}}{4} + \\dfrac{\\sqrt{2}}{4}$","$\\therefore \\sin 75° = \\dfrac{\\sqrt{6}+\\sqrt{2}}{4}$"] },
      { text: "$\\cos 75°$ の値を加法定理を用いて求めなさい。",   hint: "75° = 45° + 30°。cos(A+B) = cosA cosB - sinA sinB", answer: "√6-√2/4", answerDisplay: "\\dfrac{\\sqrt{6}-\\sqrt{2}}{4}",
        steps: ["$75° = 45° + 30°$ と分解します。","$\\cos(A+B) = \\cos A\\cos B - \\sin A\\sin B$ を適用します。","$\\cos 75° = \\cos 45°\\cos 30° - \\sin 45°\\sin 30°$","$= \\dfrac{\\sqrt{2}}{2}\\cdot\\dfrac{\\sqrt{3}}{2} - \\dfrac{\\sqrt{2}}{2}\\cdot\\dfrac{1}{2} = \\dfrac{\\sqrt{6}}{4} - \\dfrac{\\sqrt{2}}{4}$","$\\therefore \\cos 75° = \\dfrac{\\sqrt{6}-\\sqrt{2}}{4}$"] },
      { text: "$\\sin 15°$ の値を加法定理を用いて求めなさい。",   hint: "15° = 45° - 30°。sin(A-B) = sinA cosB - cosA sinB", answer: "√6-√2/4", answerDisplay: "\\dfrac{\\sqrt{6}-\\sqrt{2}}{4}",
        steps: ["$15° = 45° - 30°$ と分解します。","$\\sin(A-B) = \\sin A\\cos B - \\cos A\\sin B$ を適用します。","$\\sin 15° = \\sin 45°\\cos 30° - \\cos 45°\\sin 30°$","$= \\dfrac{\\sqrt{2}}{2}\\cdot\\dfrac{\\sqrt{3}}{2} - \\dfrac{\\sqrt{2}}{2}\\cdot\\dfrac{1}{2} = \\dfrac{\\sqrt{6}}{4} - \\dfrac{\\sqrt{2}}{4}$","$\\therefore \\sin 15° = \\dfrac{\\sqrt{6}-\\sqrt{2}}{4}$"] },
      { text: "$\\cos 15°$ の値を加法定理を用いて求めなさい。",   hint: "15° = 45° - 30°。cos(A-B) = cosA cosB + sinA sinB", answer: "√6+√2/4", answerDisplay: "\\dfrac{\\sqrt{6}+\\sqrt{2}}{4}",
        steps: ["$15° = 45° - 30°$ と分解します。","$\\cos(A-B) = \\cos A\\cos B + \\sin A\\sin B$ を適用します。","$\\cos 15° = \\cos 45°\\cos 30° + \\sin 45°\\sin 30°$","$= \\dfrac{\\sqrt{2}}{2}\\cdot\\dfrac{\\sqrt{3}}{2} + \\dfrac{\\sqrt{2}}{2}\\cdot\\dfrac{1}{2} = \\dfrac{\\sqrt{6}}{4} + \\dfrac{\\sqrt{2}}{4}$","$\\therefore \\cos 15° = \\dfrac{\\sqrt{6}+\\sqrt{2}}{4}$"] },
      { text: "$\\cos 105°$ の値を加法定理を用いて求めなさい。",  hint: "105° = 60° + 45°。cos(A+B) = cosA cosB - sinA sinB", answer: "√2-√6/4", answerDisplay: "\\dfrac{\\sqrt{2}-\\sqrt{6}}{4}",
        steps: ["$105° = 60° + 45°$ と分解します。","$\\cos(A+B) = \\cos A\\cos B - \\sin A\\sin B$ を適用します。","$\\cos 105° = \\cos 60°\\cos 45° - \\sin 60°\\sin 45°$","$= \\dfrac{1}{2}\\cdot\\dfrac{\\sqrt{2}}{2} - \\dfrac{\\sqrt{3}}{2}\\cdot\\dfrac{\\sqrt{2}}{2} = \\dfrac{\\sqrt{2}}{4} - \\dfrac{\\sqrt{6}}{4}$","$\\therefore \\cos 105° = \\dfrac{\\sqrt{2}-\\sqrt{6}}{4}$"] },
      { text: "$\\tan 75°$ の値を加法定理を用いて求めなさい。",   hint: "75° = 45° + 30°。tan(A+B) = (tanA + tanB)/(1 - tanA tanB)", answer: "2+√3", answerDisplay: "2+\\sqrt{3}",
        steps: ["$75° = 45° + 30°$ と分解します。","$\\tan(A+B) = \\dfrac{\\tan A + \\tan B}{1 - \\tan A\\tan B}$ を適用します。","$\\tan 75° = \\dfrac{\\tan 45° + \\tan 30°}{1 - \\tan 45°\\cdot\\tan 30°} = \\dfrac{1 + \\frac{\\sqrt{3}}{3}}{1 - \\frac{\\sqrt{3}}{3}}$","分子・分母に $3$ を掛けて $\\dfrac{3+\\sqrt{3}}{3-\\sqrt{3}}$、有理化すると","$\\therefore \\tan 75° = 2+\\sqrt{3}$"] },
    ];
    const p = ProblemGenerator._pick(pool);
    return { category: "加法定理", text: p.text, hint: p.hint, answer: p.answer, answerDisplay: p.answerDisplay, steps: p.steps };
  }
}

/* (Legacy PROBLEMS array removed — problems are now auto-generated by ProblemGenerator) */

/* =======================================================
   SECTION 2: ANSWER EDITOR
   State machine for token-based answer input with
   special fraction entry flow.

   Fraction Focus State:
     NONE         → normal token append
     DENOMINATOR  → typing fills frac.denominator (Enter → NUMERATOR)
     NUMERATOR    → typing fills frac.numerator   (Enter → NONE / exit)
   ======================================================= */

class AnswerEditor {
  constructor(tokensContainer, caretEl, displayEl) {
    this.tokensContainer = tokensContainer;
    this.caretEl         = caretEl;
    this.displayEl       = displayEl;

    this.tokens    = [];
    this.editMode  = "NONE"; // "NONE"|"FRAC_DEN"|"FRAC_NUM"|"EXPONENT"|"SQRT"|"ABS"
    this.activeTokenIndex = -1;
    this.onEditModeChange = null;
  }

  /* ---- Public: insert a plain character/string ---- */
  insertChar(ch) {
    if (this.editMode !== "NONE") {
      this._appendToActiveSlot(ch);
      return;
    }
    // Normal mode: merge into last text token if possible
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.type === "text") {
      last.value += ch;
    } else {
      this.tokens.push({ type: "text", value: ch });
    }
    this._render();
  }

  /* ---- Public: insert a typed symbol (sin, cos, π etc.) ---- */
  insertSymbol(sym, tokenType = "text") {
    if (this.editMode !== "NONE") {
      this._appendToActiveSlot(sym);
      return;
    }
    this.tokens.push({ type: tokenType, value: sym });
    this._render();
  }

  /* ---- Public: insert special-word token (最大値/最小値) ---- */
  insertWord(word) {
    if (this.editMode !== "NONE") {
      this._appendToActiveSlot(word);
      return;
    }
    this.tokens.push({ type: "special-word", value: word });
    this._render();
  }

  /* ---- Public: handle fraction key (cycles: NONE→DEN→NUM→NONE) ---- */
  handleFraction() {
    if (this.editMode === "NONE") {
      const fracToken = { type: "fraction", denominator: "", numerator: "" };
      this.tokens.push(fracToken);
      this.activeTokenIndex = this.tokens.length - 1;
      this.editMode = "FRAC_DEN";
    } else if (this.editMode === "FRAC_DEN") {
      this.editMode = "FRAC_NUM";
    } else if (this.editMode === "FRAC_NUM") {
      this.editMode = "NONE";
      this.activeTokenIndex = -1;
    } else {
      this._appendToActiveSlot("/");
      return;
    }
    this._render();
    this._updateEditMode();
  }

  /* ---- Public: handle exponent key (cycles: NONE→EXPONENT→NONE) ---- */
  handleExponent() {
    if (this.editMode === "NONE") {
      this.tokens.push({ type: "exponent", power: "" });
      this.activeTokenIndex = this.tokens.length - 1;
      this.editMode = "EXPONENT";
    } else if (this.editMode === "EXPONENT") {
      this.editMode = "NONE";
      this.activeTokenIndex = -1;
    } else {
      this._appendToActiveSlot("^");
      return;
    }
    this._render();
    this._updateEditMode();
  }

  /* ---- Public: handle sqrt key (cycles: NONE→SQRT→NONE) ---- */
  handleSqrt() {
    if (this.editMode === "NONE") {
      this.tokens.push({ type: "sqrt", content: "" });
      this.activeTokenIndex = this.tokens.length - 1;
      this.editMode = "SQRT";
    } else if (this.editMode === "SQRT") {
      this.editMode = "NONE";
      this.activeTokenIndex = -1;
    } else {
      this._appendToActiveSlot("√");
      return;
    }
    this._render();
    this._updateEditMode();
  }

  /* ---- Public: handle abs key (cycles: NONE→ABS→NONE) ---- */
  handleAbs() {
    if (this.editMode === "NONE") {
      this.tokens.push({ type: "abs", content: "" });
      this.activeTokenIndex = this.tokens.length - 1;
      this.editMode = "ABS";
    } else if (this.editMode === "ABS") {
      this.editMode = "NONE";
      this.activeTokenIndex = -1;
    } else {
      this._appendToActiveSlot("|");
      return;
    }
    this._render();
    this._updateEditMode();
  }

  /* ---- Public: handle Enter key (exits any current edit mode) ---- */
  handleEnter() {
    if (this.editMode !== "NONE") {
      this.editMode = "NONE";
      this.activeTokenIndex = -1;
      this._render();
      this._updateEditMode();
    }
  }

  /* ---- Public: backspace ---- */
  backspace() {
    if (this.editMode !== "NONE") {
      const token = this.tokens[this.activeTokenIndex];
      const field = this._getActiveField();
      if (token[field].length > 0) {
        token[field] = token[field].slice(0, -1);
        this._render();
        return;
      }
      if (this.editMode === "FRAC_NUM") {
        this.editMode = "FRAC_DEN";
        this._render();
        this._updateEditMode();
        return;
      }
      this.tokens.splice(this.activeTokenIndex, 1);
      this.editMode = "NONE";
      this.activeTokenIndex = -1;
      this._render();
      this._updateEditMode();
      return;
    }
    // Normal mode
    if (this.tokens.length === 0) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last.type === "text" || last.type === "special-word") {
      if (last.value.length > 1) {
        last.value = last.value.slice(0, -1);
      } else {
        this.tokens.pop();
      }
    } else {
      this.tokens.pop();
    }
    this._render();
  }

  /* ---- Public: remove the just-inserted toggle value (length-aware) ---- */
  removeValue(val) {
    const n = (val || "").length || 1;
    if (this.editMode !== "NONE") {
      const field = this._getActiveField();
      const token = this.tokens[this.activeTokenIndex];
      if (token && field) { token[field] = token[field].slice(0, -n); this._render(); }
      return;
    }
    // Normal mode: the toggle value was pushed as its own token → drop it
    if (this.tokens.length) { this.tokens.pop(); this._render(); }
  }

  /* ---- Public: clear all ---- */
  clear() {
    this.tokens = [];
    this.editMode = "NONE";
    this.activeTokenIndex = -1;
    this._render();
    this._updateEditMode();
  }

  /* ---- Public: get plain text representation ---- */
  getText() {
    return this.tokens.map(t => {
      if (t.type === "fraction") return `${t.numerator}/${t.denominator}`;
      if (t.type === "exponent") return `^${t.power}`;
      if (t.type === "sqrt") return `√${t.content}`;
      if (t.type === "abs") return `|${t.content}|`;
      return t.value || "";
    }).join("").trim();
  }

  /* ---- Public: get state description (for hint overlay) ---- */
  getEditModeLabel() {
    switch (this.editMode) {
      case "FRAC_DEN":  return "分母を入力中 → 分数キーで分子へ";
      case "FRAC_NUM":  return "分子を入力中 → 分数キーで終了";
      case "EXPONENT":  return "指数を入力中 → xⁿキーで終了";
      case "SQRT":      return "√の中身を入力中 → √キーで終了";
      case "ABS":       return "絶対値の中身を入力中 → ||キーで終了";
      default:          return "";
    }
  }

  /* ---- Private: get field name for active edit mode ---- */
  _getActiveField() {
    switch (this.editMode) {
      case "FRAC_DEN": return "denominator";
      case "FRAC_NUM": return "numerator";
      case "EXPONENT": return "power";
      case "SQRT":     return "content";
      case "ABS":      return "content";
      default:         return null;
    }
  }

  /* ---- Private: append a character to the active slot ---- */
  _appendToActiveSlot(ch) {
    const token = this.tokens[this.activeTokenIndex];
    if (!token) return;
    const field = this._getActiveField();
    if (field) token[field] += ch;
    this._render();
  }

  /* ---- Private: update edit mode UI ---- */
  _updateEditMode() {
    this.displayEl.classList.toggle("struct-mode", this.editMode !== "NONE");
    this._updateEditHint();
    if (this.onEditModeChange) this.onEditModeChange(this.editMode);
  }

  /* ---- Private: show/hide edit mode hint ---- */
  _updateEditHint() {
    let hint = document.getElementById("edit-state-hint");
    if (!hint) {
      hint = document.createElement("div");
      hint.id = "edit-state-hint";
      hint.style.cssText = `
        font-size:10px; color:#133463; padding:2px 14px 4px;
        font-family: var(--font-main); letter-spacing:0.3px;
        transition: opacity 0.2s;
      `;
      this.displayEl.parentElement.insertBefore(hint, this.displayEl.nextSibling);
    }
    const label = this.getEditModeLabel();
    hint.textContent = label;
    hint.style.opacity = label ? "1" : "0";
  }

  /* ---- Private: render all tokens into DOM ---- */
  _render() {
    this.tokensContainer.innerHTML = "";

    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      const el = this._createTokenEl(token, i);
      this.tokensContainer.appendChild(el);
    }
  }

  /* ---- Private: create DOM element for a token ---- */
  _createTokenEl(token, index) {
    if (token.type === "fraction") return this._createFractionEl(token, index);
    if (token.type === "exponent") return this._createExponentEl(token, index);
    if (token.type === "sqrt")     return this._createSqrtEl(token, index);
    if (token.type === "abs")      return this._createAbsEl(token, index);

    const span = document.createElement("span");
    span.className = "token";

    const typeClass = {
      "text":         "number",
      "special-word": "special-word",
      "trig":         "trig-fn",
      "greek":        "greek",
      "operator":     "operator",
    }[token.type] || "number";

    span.classList.add(typeClass);
    span.textContent = token.value;
    return span;
  }

  /* ---- Private: create fraction element ---- */
  _createFractionEl(token, index) {
    const isActive = ((this.editMode === "FRAC_DEN" || this.editMode === "FRAC_NUM") && index === this.activeTokenIndex);
    const isNumerFocused = isActive && this.editMode === "FRAC_NUM";
    const isDenomFocused = isActive && this.editMode === "FRAC_DEN";

    const wrap = document.createElement("span");
    wrap.className = "token fraction";

    const numEl  = document.createElement("span");
    numEl.className = "frac-slot frac-numerator";
    numEl.classList.toggle("focused", isNumerFocused);
    numEl.classList.toggle("empty", !token.numerator);
    numEl.textContent = token.numerator || "□";

    const barEl  = document.createElement("span");
    barEl.className = "frac-bar-line";
    // make bar as wide as the wider slot
    const contentWidth = Math.max(
      (token.numerator || "□").length,
      (token.denominator || "□").length
    );
    barEl.style.minWidth = `${Math.max(24, contentWidth * 11)}px`;

    const denEl  = document.createElement("span");
    denEl.className = "frac-slot frac-denominator";
    denEl.classList.toggle("focused", isDenomFocused);
    denEl.classList.toggle("empty", !token.denominator);
    denEl.textContent = token.denominator || "□";

    wrap.appendChild(numEl);
    wrap.appendChild(barEl);
    wrap.appendChild(denEl);

    return wrap;
  }

  /* ---- Private: create exponent element ---- */
  _createExponentEl(token, index) {
    const isActive = this.editMode === "EXPONENT" && index === this.activeTokenIndex;
    const wrap = document.createElement("span");
    wrap.className = "token exponent";
    const slot = document.createElement("span");
    slot.className = "exp-slot";
    slot.classList.toggle("focused", isActive);
    slot.classList.toggle("empty", !token.power);
    slot.textContent = token.power || "□";
    wrap.appendChild(slot);
    return wrap;
  }

  /* ---- Private: create sqrt element ---- */
  _createSqrtEl(token, index) {
    const isActive = this.editMode === "SQRT" && index === this.activeTokenIndex;
    const wrap = document.createElement("span");
    wrap.className = "token sqrt-token";
    const sign = document.createElement("span");
    sign.className = "sqrt-sign";
    sign.textContent = "√";
    const content = document.createElement("span");
    content.className = "sqrt-slot";
    content.classList.toggle("focused", isActive);
    content.classList.toggle("empty", !token.content);
    content.textContent = token.content || "□";
    wrap.appendChild(sign);
    wrap.appendChild(content);
    return wrap;
  }

  /* ---- Private: create abs element ---- */
  _createAbsEl(token, index) {
    const isActive = this.editMode === "ABS" && index === this.activeTokenIndex;
    const wrap = document.createElement("span");
    wrap.className = "token abs-token";
    const barL = document.createElement("span");
    barL.className = "abs-bar";
    barL.textContent = "|";
    const content = document.createElement("span");
    content.className = "abs-slot";
    content.classList.toggle("focused", isActive);
    content.classList.toggle("empty", !token.content);
    content.textContent = token.content || "□";
    const barR = document.createElement("span");
    barR.className = "abs-bar";
    barR.textContent = "|";
    wrap.appendChild(barL);
    wrap.appendChild(content);
    wrap.appendChild(barR);
    return wrap;
  }
}

/* =======================================================
   SECTION 3: CANVAS MANAGER
   Handles stylus / touch / mouse drawing, unit-circle
   stamp, undo history, tool switching.
   ======================================================= */

class CanvasManager {
  constructor(canvas) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext("2d");
    this.tool     = "pen";   // "pen" | "eraser" | "circle"
    this.color    = "#1a1a1a";
    this.penSize  = 2.5;
    this.eraserSize = 24;

    this.isDrawing = false;
    this.history   = [];   // Array of ImageData snapshots
    this.MAX_UNDO  = 20;

    this._lastX = 0;
    this._lastY = 0;
    this._circleStart = null;

    // Answer-region marking ("囲む" tool)
    this.answerRegion   = null;  // { x, y, w, h } in CSS px
    this.onRegionMarked = null;  // callback fired after a region is drawn
    this._regionBox     = null;
    this._regionClean   = null;  // canvas copy taken before the circle stroke

    this._bindEvents();
    this.resize();
    this._drawGrid();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    // Capture the CURRENT canvas state (includes strokes not yet in history)
    let snapshot = null;
    if (this.canvas.width > 0 && this.canvas.height > 0) {
      snapshot = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    }

    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width  = rect.width  + "px";
    this.canvas.style.height = rect.height + "px";
    this.ctx.scale(dpr, dpr);

    this._drawGrid();
    if (snapshot) {
      this.ctx.putImageData(snapshot, 0, 0);
    }
  }

  setTool(t) {
    if (t === "eraser-sm") {
      this.tool = "eraser";
      this.eraserSize = 12;
    } else if (t === "eraser-lg") {
      this.tool = "eraser";
      this.eraserSize = 38;
    } else {
      this.tool = t;
    }
  }
  setColor(c) { this.color = c; }

  undo() {
    if (this.history.length === 0) return;
    this.history.pop();
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    this.ctx.save();
    this.ctx.setTransform(1,0,0,1,0,0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this._drawGrid();
    if (this.history.length > 0) {
      this.ctx.save();
      this.ctx.setTransform(1,0,0,1,0,0);
      this.ctx.putImageData(this.history[this.history.length - 1], 0, 0);
      this.ctx.restore();
    }
  }

  clearAll() {
    this._saveHistory();
    const dpr = window.devicePixelRatio || 1;
    this.ctx.save();
    this.ctx.setTransform(1,0,0,1,0,0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this._drawGrid();
    this.answerRegion = null;
    this._regionClean = null;
  }

  clearRegion() { this.answerRegion = null; this._regionClean = null; }

  /* ---- Crop the circled region into a data URL (for the reference card) ---- */
  /* Full-canvas copy (device-pixel resolution) */
  _snapshotCanvas() {
    const snap = document.createElement("canvas");
    snap.width  = this.canvas.width;
    snap.height = this.canvas.height;
    snap.getContext("2d").drawImage(this.canvas, 0, 0);
    return snap;
  }

  getRegionImage(pad = 14) {
    if (!this.answerRegion) return null;
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.width / dpr;
    const cssH = this.canvas.height / dpr;

    let { x, y, w, h } = this.answerRegion;
    x = Math.max(0, x - pad);
    y = Math.max(0, y - pad);
    w = Math.min(cssW - x, w + pad * 2);
    h = Math.min(cssH - y, h + pad * 2);
    if (w <= 0 || h <= 0) return null;

    const sx = x * dpr, sy = y * dpr, sw = w * dpr, sh = h * dpr;
    const tmp  = document.createElement("canvas");
    tmp.width  = sw;
    tmp.height = sh;
    const tctx = tmp.getContext("2d");

    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue("--canvas-bg").trim() || "#0a0a18";
    tctx.fillStyle = bg;
    tctx.fillRect(0, 0, sw, sh);
    // Use the current canvas so content drawn AFTER circling is included
    const src = this.canvas;
    tctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    return tmp.toDataURL("image/png");
  }

  stampUnitCircle() {
    this._saveHistory();
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const r  = Math.min(rect.width, rect.height) * 0.38;
    const ctx = this.ctx;

    ctx.save();
    ctx.strokeStyle = "rgba(19,52,99,0.75)";
    ctx.lineWidth   = 1.5;

    // Circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Axes
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(cx - r * 1.3, cy); ctx.lineTo(cx + r * 1.3, cy); // x-axis
    ctx.moveTo(cx, cy - r * 1.3); ctx.lineTo(cx, cy + r * 1.3); // y-axis
    ctx.stroke();

    // Labels
    ctx.fillStyle   = "rgba(0,0,0,0.55)";
    ctx.font        = "12px JetBrains Mono, monospace";
    ctx.textAlign   = "center";
    ctx.fillText("1",  cx + r + 14, cy - 6);
    ctx.fillText("-1", cx - r - 16, cy - 6);
    ctx.fillText("1",  cx + 6, cy - r - 6);
    ctx.fillText("-1", cx + 6, cy + r + 14);
    ctx.fillText("x",  cx + r * 1.3 + 14, cy + 4);
    ctx.fillText("y",  cx + 6,             cy - r * 1.3 - 8);

    // Tick marks at 30°, 45°, 60° etc
    const angles = [30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];
    ctx.strokeStyle = "rgba(19,52,99,0.4)";
    ctx.lineWidth   = 0.8;
    for (const deg of angles) {
      const rad = deg * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(rad) * r * 0.94, cy - Math.sin(rad) * r * 0.94);
      ctx.lineTo(cx + Math.cos(rad) * r,        cy - Math.sin(rad) * r);
      ctx.stroke();
    }

    ctx.restore();
  }

  /* ---- Events ---- */
  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("pointerdown",  e => this._onDown(e),  { passive: false });
    c.addEventListener("pointermove",  e => this._onMove(e),  { passive: false });
    c.addEventListener("pointerup",    e => this._onUp(e),    { passive: false });
    c.addEventListener("pointercancel",e => this._onUp(e),    { passive: false });
    c.addEventListener("pointerleave", e => this._onUp(e),    { passive: false });
  }

  _getPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _getPressure(e) {
    // Use stylus pressure if available, fallback to 0.5
    return (e.pointerType === "pen" && e.pressure > 0) ? e.pressure : 0.5;
  }

  _onDown(e) {
    e.preventDefault();
    this._saveHistory();
    const pos = this._getPos(e);
    this._lastX = pos.x;
    this._lastY = pos.y;
    this.isDrawing = true;

    if (this.tool === "circle") {
      this._circleStart = pos;
      return;
    }

    if (this.tool === "region") {
      this._regionBox = { minX: pos.x, minY: pos.y, maxX: pos.x, maxY: pos.y };
      // Snapshot the canvas BEFORE the circling stroke is drawn, so the
      // cropped self-judge image shows only the answer (no circle line).
      this._regionClean = this._snapshotCanvas();
      this.ctx.beginPath();
      this.ctx.moveTo(pos.x, pos.y);
      return;
    }

    this.ctx.beginPath();
    this.ctx.moveTo(pos.x, pos.y);
  }

  _onMove(e) {
    if (!this.isDrawing) return;
    e.preventDefault();
    const pos      = this._getPos(e);
    const pressure = this._getPressure(e);
    const ctx      = this.ctx;

    if (this.tool === "circle") {
      // Preview: restore last state and draw temporary circle
      if (this.history.length > 0) {
        ctx.save();
        ctx.setTransform(1,0,0,1,0,0);
        const dpr = window.devicePixelRatio || 1;
        ctx.clearRect(0,0,this.canvas.width, this.canvas.height);
        ctx.restore();
        this._drawGrid();
        ctx.save();
        ctx.setTransform(1,0,0,1,0,0);
        ctx.putImageData(this.history[this.history.length-1], 0, 0);
        ctx.restore();
      }
      const dx = pos.x - this._circleStart.x;
      const dy = pos.y - this._circleStart.y;
      const r  = Math.hypot(dx, dy);
      ctx.save();
      ctx.strokeStyle = this.color;
      ctx.lineWidth   = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(this._circleStart.x, this._circleStart.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    if (this.tool === "region") {
      // Draw a highlight loop and grow the bounding box
      ctx.save();
      ctx.strokeStyle = "rgba(19,52,99,0.9)";
      ctx.lineWidth   = 2.5;
      ctx.lineCap     = "round";
      ctx.lineJoin    = "round";
      ctx.beginPath();
      ctx.moveTo(this._lastX, this._lastY);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      ctx.restore();
      const b = this._regionBox;
      if (b) {
        b.minX = Math.min(b.minX, pos.x); b.minY = Math.min(b.minY, pos.y);
        b.maxX = Math.max(b.maxX, pos.x); b.maxY = Math.max(b.maxY, pos.y);
      }
      this._lastX = pos.x;
      this._lastY = pos.y;
      return;
    }

    if (this.tool === "eraser") {
      // Use destination-out compositing for clean erasing
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, this.eraserSize * pressure * 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Redraw grid on top so erasing never removes grid lines permanently
      this._drawGrid();
      this._lastX = pos.x;
      this._lastY = pos.y;
      return;
    }

    // Pen with pressure sensitivity
    const lineWidth = this.penSize + pressure * 3;
    ctx.save();
    ctx.strokeStyle = this.color;
    ctx.lineWidth   = lineWidth;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.beginPath();
    ctx.moveTo(this._lastX, this._lastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    ctx.restore();

    this._lastX = pos.x;
    this._lastY = pos.y;
  }

  _onUp(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    if (this.tool === "region" && this._regionBox) {
      const b = this._regionBox;
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      this._regionBox = null;
      if (w > 8 && h > 8) {
        this.answerRegion = { x: b.minX, y: b.minY, w, h };
        if (this.onRegionMarked) this.onRegionMarked();
      }
      return;
    }

    if (this.tool === "circle" && this._circleStart) {
      const pos = this._getPos(e);
      const dx  = pos.x - this._circleStart.x;
      const dy  = pos.y - this._circleStart.y;
      const r   = Math.hypot(dx, dy);
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = this.color;
      ctx.lineWidth   = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(this._circleStart.x, this._circleStart.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      this._circleStart = null;
    }
  }

  _saveHistory() {
    if (this.canvas.width === 0 || this.canvas.height === 0) return;
    const snap = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.history.push(snap);
    if (this.history.length > this.MAX_UNDO) this.history.shift();
  }

  _drawGrid() {
    // Grid removed
  }
}

/* =======================================================
   SECTION 4: APP CONTROLLER
   ======================================================= */

/* --- Default Settings --- */
const DEFAULT_SETTINGS = {
  enabledCategories: ["basic","equation","maxmin","relation","graph","composition","inequality","addition"],
  countMode: "endless",   // "endless" | "10" | "20" | "30"
  angleNotation: "random", // "random" | "degree" | "radian"
};

class AppController {
  constructor() {
    this.currentProblem   = null;  // The problem currently shown
    this.currentCatId     = "all"; // Selected category tab
    this.editor           = null;
    this.canvasMgr        = null;
    this.isFullscreen     = false;
    this.isProblemCollapsed = false;
    this.mode             = "solve"; // "solve" | "answer"
    this._toastTimer      = null;
    this._toggleKeyId     = null;
    this._toggleIndex     = 0;

    /* Stats */
    this.correctCount  = 0;
    this.totalCount    = 0;

    /* Session: for "指定数モード" */
    this.sessionLimit   = null;   // null = endless
    this.sessionCorrect = 0;
    this.sessionTotal   = 0;

    /* Settings */
    this.settings = this._loadSettings();

    /* Recent problem hashes for de-dup (last 6) */
    this._recentHashes = [];

    this._init();
  }

  /* ---- Settings: load / save ---- */
  _loadSettings() {
    try {
      const raw = localStorage.getItem("trigmaster_settings");
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch(e) {}
    return { ...DEFAULT_SETTINGS };
  }
  _saveSettings() {
    localStorage.setItem("trigmaster_settings", JSON.stringify(this.settings));
  }

  _init() {
    // Setup editor (for the old answer-panel, kept for compatibility)
    this.editor = new AnswerEditor(
      document.getElementById("answer-tokens"),
      document.getElementById("input-caret"),
      document.getElementById("answer-display")
    );

    // Setup overlay editor (used in the answer-only overlay)
    this.overlayEditor = new AnswerEditor(
      document.getElementById("overlay-answer-tokens"),
      document.getElementById("overlay-input-caret"),
      document.getElementById("overlay-answer-display")
    );
    this._overlayToggleKeyId  = null;
    this._overlayToggleIndex  = 0;

    // Setup canvas
    this.canvasMgr = new CanvasManager(document.getElementById("drawing-canvas"));
    this.canvasMgr.onRegionMarked = () => this._onRegionMarked();
    this.editor.onEditModeChange = (mode) => this._updateStructKeyHighlights(mode);

    // Apply settings-driven session limit
    this._applySessionLimit();

    // Render category tabs
    this._renderCategoryTabs();

    // Populate settings modal with saved values
    this._populateSettingsModal();

    // Generate and load the first problem
    this._generateNextProblem();

    // Bind all UI events
    this._bindKeyboard();
    this._bindToolbar();
    this._bindAppButtons();
    this._bindModals();
    this._bindAnswerOverlay();
    this._bindHome();
    this._syncHomeMode();   // home screen is visible at launch (default markup)

    // Resize handler
    window.addEventListener("resize", () => this.canvasMgr.resize());

    // Render KaTeX after a tick (fonts loaded)
    setTimeout(() => {
      if (window.renderMathInElement) {
        renderMathInElement(document.body, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$",  right: "$",  display: false },
          ],
          throwOnError: false,
        });
      }
    }, 500);
  }

  /* ---- Session limit helper ---- */
  _applySessionLimit() {
    const mode = this.settings.countMode;
    this.sessionLimit   = (mode === "endless") ? null : parseInt(mode, 10);
    this.sessionCorrect = 0;
    this.sessionTotal   = 0;
  }

  /* ---- Category Tabs ---- */
  _renderCategoryTabs() {
    const nav = document.getElementById("category-tabs");
    nav.innerHTML = "";
    CATEGORIES.forEach(cat => {
      const btn = document.createElement("button");
      btn.className = "cat-tab" + (cat.id === this.currentCatId ? " active" : "");
      btn.textContent = cat.label;
      btn.dataset.cat = cat.id;
      btn.addEventListener("click", () => this._selectCategory(cat.id));
      nav.appendChild(btn);
    });
  }

  _selectCategory(catId) {
    this.currentCatId = catId;
    document.querySelectorAll(".cat-tab").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.cat === catId);
    });
    // New category → generate a new problem immediately
    this._recentHashes = [];
    this._generateNextProblem();
  }

  /* ---- Home screen (problem-type picker) ---- */
  _bindHome() {
    this._renderHomeCategories();

    // Count-mode toggle
    document.querySelectorAll("#home-count-mode .home-mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this.settings.countMode = btn.dataset.mode;
        this._saveSettings();
        this._applySessionLimit();
        this._syncHomeMode();
        this._updateCounter();
      });
    });

    // Buttons that re-open the home screen (header + problem panel)
    ["btn-home", "btn-home-panel"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => this._showHome());
    });

    // Back button on the home screen → return to the current practice
    const homeClose = document.getElementById("btn-home-close");
    if (homeClose) homeClose.addEventListener("click", () => {
      document.getElementById("home-screen").classList.add("hidden");
    });
  }

  _renderHomeCategories() {
    const grid = document.getElementById("home-categories");
    if (!grid) return;
    const desc = {
      all:         "すべての種類から出題",
      basic:       "sin・cos・tan の値",
      equation:    "三角方程式を解く",
      maxmin:      "最大値・最小値",
      relation:    "相互関係の利用",
      graph:       "周期・グラフ",
      composition: "三角関数の合成",
      inequality:  "三角不等式",
      addition:    "加法定理",
    };
    grid.innerHTML = "";
    CATEGORIES.forEach(cat => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "home-cat-card" + (cat.id === "all" ? " featured" : "");
      card.dataset.cat = cat.id;
      card.innerHTML =
        `<span class="home-cat-label">${cat.id === "all" ? "おまかせ" : cat.label}</span>` +
        `<span class="home-cat-desc">${desc[cat.id] || ""}</span>`;
      card.addEventListener("click", () => this._startFromHome(cat.id));
      grid.appendChild(card);
    });
  }

  _syncHomeMode() {
    document.querySelectorAll("#home-count-mode .home-mode-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === this.settings.countMode);
    });
  }

  _showHome() {
    this._syncHomeMode();
    // The back button is meaningful only when reopening home mid-practice
    document.getElementById("btn-home-close").classList.remove("hidden");
    document.getElementById("home-screen").classList.remove("hidden");
  }

  _startFromHome(catId) {
    // Fresh session for the chosen category
    this._applySessionLimit();
    this.currentCatId = catId;
    this._recentHashes = [];
    this._enterSolveMode();
    this._generateNextProblem();
    document.getElementById("home-screen").classList.add("hidden");
  }

  /* ---- Problem generation ---- */
  _generateNextProblem() {
    // Pick effective category
    let catId = this.currentCatId;
    if (catId === "all") {
      const enabled = this.settings.enabledCategories;
      catId = enabled.length > 0
        ? enabled[Math.floor(Math.random() * enabled.length)]
        : ProblemGenerator._pick(CATEGORIES.filter(c => c.id !== "all")).id;
    }

    // Generate with de-dup (try up to 8 times)
    let problem;
    for (let i = 0; i < 8; i++) {
      problem = ProblemGenerator.generate(catId, this.settings.angleNotation);
      const hash = problem.text.slice(0, 60);
      if (!this._recentHashes.includes(hash)) {
        this._recentHashes.push(hash);
        if (this._recentHashes.length > 6) this._recentHashes.shift();
        break;
      }
    }

    this.currentProblem = problem;
    this._displayProblem(problem);
  }

  _displayProblem(problem) {
    document.getElementById("problem-text").innerHTML = problem.text;
    document.getElementById("hint-box").classList.add("hidden");
    document.getElementById("hint-box").innerHTML = "";

    this._updateCounter();

    this.editor.clear();
    this.canvasMgr.clearAll();

    document.getElementById("answer-ref-card").classList.add("hidden");
    document.getElementById("btn-enter-answer").classList.remove("pulse");
    this._enterSolveMode();

    // Re-render KaTeX
    setTimeout(() => {
      if (window.renderMathInElement) {
        renderMathInElement(document.getElementById("problem-text"), {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$",  right: "$",  display: false },
          ],
          throwOnError: false,
        });
      }
    }, 100);
  }

  /* ---- Counter display ---- */
  _updateCounter() {
    const counter = document.getElementById("problem-counter");
    if (this.sessionLimit) {
      counter.textContent = `${this.sessionTotal} / ${this.sessionLimit} 問`;
      // Progress bar for limited mode
      document.getElementById("progress-bar").style.width =
        `${(this.sessionTotal / this.sessionLimit) * 100}%`;
    } else {
      counter.textContent = `正解 ${this.sessionCorrect} / ${this.sessionTotal} 問`;
      document.getElementById("progress-bar").style.width = "0%";
    }
  }

  /* ---- Settings Modal: populate from saved settings ---- */
  _populateSettingsModal() {
    // Checkboxes for categories
    const container = document.getElementById("settings-categories");
    if (container) {
      container.innerHTML = "";
      CATEGORIES.filter(c => c.id !== "all").forEach(cat => {
        const checked = this.settings.enabledCategories.includes(cat.id);
        const label = document.createElement("label");
        label.className = "settings-checkbox" + (checked ? " checked" : "");
        label.innerHTML = `
          <input type="checkbox" value="${cat.id}" ${checked ? "checked" : ""}/>
          <span>${cat.label}</span>
        `;
        label.querySelector("input").addEventListener("change", e => {
          label.classList.toggle("checked", e.target.checked);
        });
        container.appendChild(label);
      });
    }

    // Count mode radio
    const countMode = this.settings.countMode;
    document.querySelectorAll("input[name='countMode']").forEach(r => {
      r.checked = (r.value === countMode);
    });

    // Angle notation radio
    const angleNotation = this.settings.angleNotation;
    document.querySelectorAll("input[name='angleNotation']").forEach(r => {
      r.checked = (r.value === angleNotation);
    });
  }

  /* ---- Keyboard binding ---- */
  _bindKeyboard() {
    document.getElementById("custom-keyboard").addEventListener("pointerdown", e => {
      const btn = e.target.closest(".kb-key");
      if (!btn) return;

      // Ripple effect
      this._addRipple(btn, e);

      const action = btn.dataset.action;
      const value  = btn.dataset.value;

      // Any key other than a repeat of the same toggle ends a toggle run
      if (!(action === "toggle" && btn.id === this._toggleKeyId)) {
        this._toggleKeyId = null;
      }

      switch (action) {
        case "insert":
          this._handleInsert(value);
          break;
        case "insert-text":
          this.editor.insertWord(value);
          break;
        case "toggle":
          this._handleToggle(btn);
          break;
        case "fraction":
          this.editor.handleFraction();
          break;
        case "sqrt":
          this.editor.handleSqrt();
          break;
        case "exponent":
          this.editor.handleExponent();
          break;
        case "abs":
          this.editor.handleAbs();
          break;
        case "backspace":
          this.editor.backspace();
          break;
        case "enter":
          this.editor.handleEnter();
          break;
      }

      // Haptic feedback (if supported)
      if (navigator.vibrate) navigator.vibrate(12);
    });
  }

  _handleInsert(value) {
    const trigFns = ["sin", "cos", "tan"];
    const greeks  = ["θ", "π", "α", "β", "n"];
    const ops     = ["-", "+", ",", "，", "≦", "≧", "<", ">", "=", "(", ")", "°"];

    if (trigFns.includes(value)) {
      this.editor.insertSymbol(value, "trig");
    } else if (greeks.includes(value)) {
      this.editor.insertSymbol(value, "greek");
    } else if (ops.includes(value)) {
      this.editor.insertSymbol(value, "operator");
    } else {
      this.editor.insertChar(value);
    }
  }

  /* ---- Multi-tap toggle keys (e.g. + / −, ( / ), 最大値 / 最小値) ----
     First press inserts option A. Pressing the SAME key again (with no key
     in between) replaces it with option B, then A, … cycling each press. */
  _handleToggle(btn) {
    const values = (btn.dataset.values || "").split("|");
    const kind   = btn.dataset.kind || "operator";
    let index;

    if (this._toggleKeyId === btn.id) {
      // consecutive press → swap the value we just inserted
      this.editor.removeValue(values[this._toggleIndex]);
      index = (this._toggleIndex + 1) % values.length;
    } else {
      index = 0;
    }

    this._insertToggleValue(values[index], kind);
    this._toggleKeyId  = btn.id;
    this._toggleIndex  = index;
  }

  _insertToggleValue(val, kind) {
    if (kind === "word") this.editor.insertWord(val);
    else                 this.editor.insertSymbol(val, kind);
  }

  _addRipple(btn, e) {
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    ripple.style.left = (e.clientX - rect.left) + "px";
    ripple.style.top  = (e.clientY - rect.top)  + "px";
    btn.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());
  }

  /* ---- Toolbar binding ---- */
  _bindToolbar() {
    // Tool buttons
    document.querySelectorAll(".tool-btn[data-tool]").forEach(btn => {
      btn.addEventListener("click", () => {
        const tool = btn.dataset.tool;
        if (tool === "circle") {
          this.canvasMgr.stampUnitCircle();
          // Flash the button
          btn.classList.add("active");
          setTimeout(() => btn.classList.remove("active"), 600);
          return;
        }
        document.querySelectorAll(".tool-btn[data-tool]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.canvasMgr.setTool(tool);
      });
    });

    // Undo
    document.getElementById("tool-undo").addEventListener("click", () => {
      this.canvasMgr.undo();
    });

    // Clear canvas
    document.getElementById("tool-clear").addEventListener("click", () => {
      this.canvasMgr.clearAll();
    });

    // Color buttons
    document.querySelectorAll(".color-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".color-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.canvasMgr.setColor(btn.dataset.color);
      });
    });
  }

  /* ---- App button binding ---- */
  _bindAppButtons() {
    // Grid button (出題を選ぶ) → open the settings / problem-selection modal
    document.getElementById("btn-minimize-problem").addEventListener("click", () => {
      this._populateSettingsModal();
      document.getElementById("settings-modal").classList.remove("hidden");
    });

    // Fullscreen canvas toggle
    document.getElementById("btn-fullscreen-canvas").addEventListener("click", () => {
      this._enterFullscreenCanvas();
    });

    document.getElementById("btn-exit-fullscreen").addEventListener("click", () => {
      this._exitFullscreenCanvas();
    });

    // Enter answer mode (reveal overlay)
    document.getElementById("btn-enter-answer").addEventListener("click", () => {
      this._openAnswerOverlay();
    });

    // Back to solving from the old answer panel (keep for safety)
    document.getElementById("btn-back-to-solve").addEventListener("click", () => {
      this._enterSolveMode();
    });

    // Hide the reference crop card
    document.getElementById("btn-hide-ref").addEventListener("click", () => {
      document.getElementById("answer-ref-card").classList.add("hidden");
    });

    // Clear answer
    document.getElementById("btn-clear-answer").addEventListener("click", () => {
      this.editor.clear();
    });

    // Submit answer (old panel – keep wired)
    document.getElementById("btn-submit").addEventListener("click", () => {
      this._checkAnswer();
    });

    // Hint button
    document.getElementById("btn-hint").addEventListener("click", () => {
      const problem = this.currentProblem;
      if (!problem) return;
      document.getElementById("hint-content").innerHTML = problem.hint;
      document.getElementById("hint-modal").classList.remove("hidden");
    });

    // Settings button (open modal)
    document.getElementById("btn-settings").addEventListener("click", () => {
      this._populateSettingsModal();
      document.getElementById("settings-modal").classList.remove("hidden");
    });
  }

  _bindAnswerOverlay() {
    // Overlay keyboard — delegated handler bound ONCE. The key elements are
    // (re)cloned into #overlay-keyboard on each open; delegation survives that.
    document.getElementById("overlay-keyboard").addEventListener("pointerdown", e => {
      const btn = e.target.closest(".kb-key");
      if (!btn) return;
      this._addRipple(btn, e);
      const action = btn.dataset.action;
      const value  = btn.dataset.value;
      if (!(action === "toggle" && btn.id === this._overlayToggleKeyId)) {
        this._overlayToggleKeyId = null;
      }
      switch (action) {
        case "insert":      this._handleInsertOverlay(value); break;
        case "insert-text": this.overlayEditor.insertWord(value); break;
        case "toggle":      this._handleToggleOverlay(btn); break;
        case "fraction":    this.overlayEditor.handleFraction(); break;
        case "sqrt":        this.overlayEditor.handleSqrt(); break;
        case "exponent":    this.overlayEditor.handleExponent(); break;
        case "abs":         this.overlayEditor.handleAbs(); break;
        case "backspace":   this.overlayEditor.backspace(); break;
        case "enter":       this._checkAnswerOverlay(); break;  // Enter = 答え確認
      }
      if (navigator.vibrate) navigator.vibrate(12);
    });

    // Back button
    document.getElementById("btn-overlay-back").addEventListener("click", () => {
      this._closeAnswerOverlay();
    });

    // Submit button in overlay
    document.getElementById("btn-overlay-submit").addEventListener("click", () => {
      this._checkAnswerOverlay();
    });

    // Clear button in overlay
    document.getElementById("btn-overlay-clear").addEventListener("click", () => {
      this.overlayEditor.clear();
    });

    // Hide reference in overlay
    document.getElementById("btn-overlay-hide-ref").addEventListener("click", () => {
      document.getElementById("overlay-ref-card").classList.add("hidden");
    });
  }

  /* ---- Normalise an answer for comparison.
     Comma-separated answers (solution sets / ranges) are compared
     order-independently, so a correct answer written in a different
     order still counts. ---- */
  _normaliseAnswer(s) {
    let n = (s || "")
      .replace(/\s/g, "")
      .toLowerCase()
      .replace(/[，,]/g, ",")
      .replace(/ｐｉ|ぱい/g, "π")
      .replace(/°/g, "");    // °の有無を無視
    if (n.includes(",")) {
      n = n.split(",").filter(x => x !== "").sort().join(",");
    }
    return n;
  }

  _checkAnswerOverlay() {
    const problem = this.currentProblem;
    if (!problem) return;

    const isCorrect = this._normaliseAnswer(this.overlayEditor.getText())
                   === this._normaliseAnswer(problem.answer);

    // Close overlay first
    this._closeAnswerOverlay();

    // Update session stats
    this.sessionTotal++;
    if (isCorrect) this.sessionCorrect++;
    this._updateCounter();

    const sessionDone = this.sessionLimit && this.sessionTotal >= this.sessionLimit;

    // バナー
    const banner = document.getElementById("rs-banner");
    const rsIcon = document.getElementById("rs-icon");
    const rsTitle = document.getElementById("rs-title");
    banner.className = "rs-banner " + (isCorrect ? "correct" : "incorrect");
    rsIcon.textContent  = isCorrect ? "○" : "×";
    rsTitle.textContent = isCorrect ? "正解！" : "不正解";

    // 問題文
    document.getElementById("rs-problem").innerHTML = problem.text;

    // 正解
    const rsAnswer = document.getElementById("rs-answer");
    rsAnswer.className = "rs-answer-box " + (isCorrect ? "user-correct" : "user-incorrect");
    rsAnswer.innerHTML = `$${problem.answerDisplay}$`;

    // 途中式
    const rsStepsSection = document.getElementById("rs-steps-section");
    const rsSteps = document.getElementById("rs-steps");
    if (problem.steps && problem.steps.length) {
      rsStepsSection.style.display = "";
      rsSteps.innerHTML = problem.steps.map((s, i) =>
        `<div class="rs-step-item">
          <span class="rs-step-num">${i + 1}</span>
          <span class="rs-step-body">${s}</span>
        </div>`
      ).join("");
    } else {
      rsStepsSection.style.display = "none";
    }

    document.getElementById("btn-next-problem").textContent =
      sessionDone ? "結果を見る" : "次の問題へ";

    // 自動採点モード: 自己判定ボタン・囲み画像は出さず、通常フッターを表示
    document.getElementById("rs-region-section").classList.add("hidden");
    document.getElementById("rs-footer-judge").classList.add("hidden");
    document.getElementById("rs-footer-normal").classList.remove("hidden");

    this._showResultScreen();

    // KaTeX レンダリング
    setTimeout(() => {
      if (window.renderMathInElement) {
        renderMathInElement(document.getElementById("result-screen"), {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
          ],
          throwOnError: false,
        });
      }
    }, 100);

    // Clear overlay editor for next use
    this.overlayEditor.clear();
  }

  /* ---- Category picker dropdown ---- */
  _toggleCategoryDropdown() {
    let dropdown = document.getElementById("cat-picker-dropdown");
    if (dropdown) {
      dropdown.remove();
      return;
    }
    // Build dropdown
    dropdown = document.createElement("div");
    dropdown.id = "cat-picker-dropdown";
    dropdown.className = "cat-dropdown";

    CATEGORIES.forEach(cat => {
      const btn = document.createElement("button");
      btn.className = "cat-tab" + (cat.id === this.currentCatId ? " active" : "");
      btn.textContent = cat.label;
      btn.addEventListener("click", () => {
        dropdown.remove();
        this._selectCategory(cat.id);
      });
      dropdown.appendChild(btn);
    });

    document.getElementById("problem-panel").appendChild(dropdown);

    // Close on outside tap
    const close = (e) => {
      if (!dropdown.contains(e.target) && e.target.id !== "btn-minimize-problem") {
        dropdown.remove();
        document.removeEventListener("pointerdown", close, true);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
  }

  /* ---- Answer overlay (full-screen answer input) ---- */
  _openAnswerOverlay() {
    const overlay = document.getElementById("answer-overlay");
    if (!overlay) return;

    // Always start the answer screen fresh
    this.overlayEditor.clear();
    this._overlayToggleKeyId = null;
    this._overlayToggleIndex = 0;

    // Populate problem text in overlay
    const problem = this.currentProblem;
    if (problem) {
      document.getElementById("overlay-category").textContent = problem.category;
      const pt = document.getElementById("overlay-problem-text");
      pt.innerHTML = problem.text;
      setTimeout(() => {
        if (window.renderMathInElement) {
          renderMathInElement(pt, {
            delimiters: [{left:"$$",right:"$$",display:true},{left:"$",right:"$",display:false}],
            throwOnError: false,
          });
        }
      }, 80);
    }

    // Show region image LARGE or placeholder
    const regionDisplay = document.getElementById("overlay-region-display");
    const noRegion      = document.getElementById("overlay-no-region");
    const refImg        = document.getElementById("overlay-ref-img");
    const regionData = this.canvasMgr.getRegionImage();
    if (regionData) {
      refImg.src = regionData;
      regionDisplay.classList.remove("hidden");
      noRegion.classList.add("hidden");
    } else {
      regionDisplay.classList.add("hidden");
      noRegion.classList.remove("hidden");
    }

    // Populate the overlay keyboard (clone main keyboard HTML).
    // The pointerdown handler is delegated and bound ONCE in _bindAnswerOverlay,
    // so it keeps working as these children are replaced.
    const overlayKb = document.getElementById("overlay-keyboard");
    const mainKb    = document.getElementById("custom-keyboard");
    overlayKb.innerHTML = mainKb.innerHTML;

    overlay.classList.remove("hidden");
    this.mode = "answer";
  }

  _closeAnswerOverlay() {
    document.getElementById("answer-overlay").classList.add("hidden");
    this.mode = "solve";
  }

  _handleInsertOverlay(value) {
    const trigFns = ["sin", "cos", "tan"];
    const greeks  = ["θ", "π", "α", "β", "n"];
    const ops     = ["-", "+", ",", "，", "≦", "≧", "<", ">", "=", "(", ")", "°"];
    if (trigFns.includes(value))  this.overlayEditor.insertSymbol(value, "trig");
    else if (greeks.includes(value)) this.overlayEditor.insertSymbol(value, "greek");
    else if (ops.includes(value)) this.overlayEditor.insertSymbol(value, "operator");
    else                          this.overlayEditor.insertChar(value);
  }

  _handleToggleOverlay(btn) {
    const values = (btn.dataset.values || "").split("|");
    const kind   = btn.dataset.kind || "operator";
    let index;
    if (this._overlayToggleKeyId === btn.id) {
      this.overlayEditor.removeValue(values[this._overlayToggleIndex]);
      index = (this._overlayToggleIndex + 1) % values.length;
    } else {
      index = 0;
    }
    if (kind === "word") this.overlayEditor.insertWord(values[index]);
    else                 this.overlayEditor.insertSymbol(values[index], kind);
    this._overlayToggleKeyId    = btn.id;
    this._overlayToggleIndex    = index;
  }

  _bindModals() {
    // Back button → return to the problem / whiteboard (keeps the current problem)
    document.getElementById("btn-result-back").addEventListener("click", () => {
      this._hideResultScreen();
    });

    // Next problem
    document.getElementById("btn-next-problem").addEventListener("click", () => {
      this._hideResultScreen();
      // Check if session limit reached
      if (this.sessionLimit && this.sessionTotal >= this.sessionLimit) {
        this._showCompletionScreen();
        return;
      }
      this._generateNextProblem();
    });

    // Retry
    document.getElementById("btn-retry").addEventListener("click", () => {
      this._hideResultScreen();
      this.editor.clear();
    });

    // Close hint
    document.getElementById("btn-close-hint").addEventListener("click", () => {
      document.getElementById("hint-modal").classList.add("hidden");
    });

    // Close settings
    document.getElementById("btn-close-settings").addEventListener("click", () => {
      document.getElementById("settings-modal").classList.add("hidden");
    });

    // Save settings
    document.getElementById("btn-save-settings").addEventListener("click", () => {
      // Read enabled categories
      const checked = [];
      document.querySelectorAll("#settings-categories input[type='checkbox']:checked").forEach(cb => {
        checked.push(cb.value);
      });
      this.settings.enabledCategories = checked.length > 0 ? checked : [...DEFAULT_SETTINGS.enabledCategories];

      // Read count mode
      const countModeEl = document.querySelector("input[name='countMode']:checked");
      this.settings.countMode = countModeEl ? countModeEl.value : "endless";

      // Read angle notation
      const angleEl = document.querySelector("input[name='angleNotation']:checked");
      this.settings.angleNotation = angleEl ? angleEl.value : "random";

      this._saveSettings();
      this._applySessionLimit();

      // Practice from the chosen set of categories (the selected pool)
      this.currentCatId = "all";
      this._recentHashes = [];
      this._generateNextProblem();   // also refreshes counter + enters solve mode

      document.getElementById("settings-modal").classList.add("hidden");
      this._toast("設定を保存しました ✓");
    });

    // Backdrop click (hint/settings only)
    document.querySelectorAll(".modal-backdrop").forEach(bd => {
      bd.addEventListener("click", () => {
        bd.closest(".modal").classList.add("hidden");
      });
    });

    // 自己判定ボタン（メインパネル）
    document.getElementById("btn-self-judge").addEventListener("click", () => {
      this._startSelfJudge();
    });

    // 自己判定ボタン（オーバーレイ）
    document.getElementById("btn-overlay-self-judge").addEventListener("click", () => {
      this._closeAnswerOverlay();
      this._startSelfJudge();
    });

    // ○正解 ボタン
    document.getElementById("btn-judge-correct").addEventListener("click", () => {
      this._completeSelfJudge(true);
    });

    // ×不正解 ボタン
    document.getElementById("btn-judge-wrong").addEventListener("click", () => {
      this._completeSelfJudge(false);
    });
  }

  /* ---- 自己判定: 囲み画像+正解を表示して○×を待つ ---- */
  _startSelfJudge() {
    const problem = this.currentProblem;
    if (!problem) return;

    // バナー: 判定待ち
    document.getElementById("rs-banner").className = "rs-banner";
    document.getElementById("rs-banner").style.background = "var(--bg)";
    document.getElementById("rs-icon").textContent = "👁";
    document.getElementById("rs-title").textContent = "自己判定";
    document.getElementById("rs-title").style.color = "var(--tx)";

    // 囲み画像セクションを表示
    const regionSection = document.getElementById("rs-region-section");
    const regionImg     = document.getElementById("rs-region-img");
    const noRegion      = document.getElementById("rs-no-region");
    regionSection.classList.remove("hidden");
    const regionData = this.canvasMgr.getRegionImage();
    if (regionData) {
      regionImg.src = regionData;
      regionImg.classList.remove("hidden");
      noRegion.classList.add("hidden");
    } else {
      regionImg.classList.add("hidden");
      noRegion.classList.remove("hidden");
    }

    // 問題文
    document.getElementById("rs-problem").innerHTML = problem.text;

    // 正解
    const rsAnswer = document.getElementById("rs-answer");
    rsAnswer.className = "rs-answer-box";
    rsAnswer.innerHTML = `$${problem.answerDisplay}$`;

    // 途中式は非表示
    document.getElementById("rs-steps-section").style.display = "none";

    // フッター切り替え: 自己判定ボタンを表示、通常フッターは隠す
    document.getElementById("rs-footer-judge").classList.remove("hidden");
    document.getElementById("rs-footer-normal").classList.add("hidden");

    this._showResultScreen();

    // KaTeX レンダリング
    setTimeout(() => {
      if (window.renderMathInElement) {
        renderMathInElement(document.getElementById("result-screen"), {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
          ],
          throwOnError: false,
        });
      }
    }, 50);
  }

  /* ---- 自己判定: ○×選択後 → 結果画面に切り替え ---- */
  _completeSelfJudge(isCorrect) {
    const problem = this.currentProblem;
    if (!problem) return;

    // 統計更新
    this.sessionTotal++;
    if (isCorrect) this.sessionCorrect++;
    this._updateCounter();

    const sessionDone = this.sessionLimit && this.sessionTotal >= this.sessionLimit;

    // バナー更新
    const banner = document.getElementById("rs-banner");
    banner.className = "rs-banner " + (isCorrect ? "correct" : "incorrect");
    banner.style.background = "";
    document.getElementById("rs-icon").textContent  = isCorrect ? "○" : "×";
    document.getElementById("rs-title").textContent = isCorrect ? "正解！" : "不正解";
    document.getElementById("rs-title").style.color = "";

    // 正解の色
    document.getElementById("rs-answer").className =
      "rs-answer-box " + (isCorrect ? "user-correct" : "user-incorrect");

    // 囲み画像セクションは残したまま

    // 途中式を表示
    const rsStepsSection = document.getElementById("rs-steps-section");
    const rsSteps = document.getElementById("rs-steps");
    if (problem.steps && problem.steps.length) {
      rsStepsSection.style.display = "";
      rsSteps.innerHTML = problem.steps.map((s, i) =>
        `<div class="rs-step-item">
          <span class="rs-step-num">${i + 1}</span>
          <span class="rs-step-body">${s}</span>
        </div>`
      ).join("");
      // KaTeX
      setTimeout(() => {
        if (window.renderMathInElement) {
          renderMathInElement(rsSteps, {
            delimiters: [
              { left: "$$", right: "$$", display: true },
              { left: "$", right: "$", display: false },
            ],
            throwOnError: false,
          });
        }
      }, 30);
    } else {
      rsStepsSection.style.display = "none";
    }

    // フッター切り替え: 通常フッターへ
    document.getElementById("rs-footer-judge").classList.add("hidden");
    document.getElementById("rs-footer-normal").classList.remove("hidden");
    document.getElementById("btn-next-problem").textContent =
      sessionDone ? "結果を見る" : "次の問題へ";

    // スクロールトップに戻す
    document.querySelector(".rs-body").scrollTop = 0;
  }

  /* ---- 結果スクリーン 表示/非表示 ---- */
  _showResultScreen() {
    // 通常モードの時は囲みセクション非表示・通常フッター表示
    document.getElementById("result-screen").classList.remove("hidden");

  }

  _hideResultScreen() {
    document.getElementById("result-screen").classList.add("hidden");
  }


  /* ---- Canvas fullscreen ---- */
  _enterFullscreenCanvas() {
    document.getElementById("app").classList.add("canvas-fullscreen");
    document.getElementById("btn-exit-fullscreen").classList.remove("hidden");
    this.isFullscreen = true;
    setTimeout(() => this.canvasMgr.resize(), 50);
  }

  _exitFullscreenCanvas() {
    document.getElementById("app").classList.remove("canvas-fullscreen");
    document.getElementById("btn-exit-fullscreen").classList.add("hidden");
    this.isFullscreen = false;
    setTimeout(() => this.canvasMgr.resize(), 50);
  }

  /* ---- Mode switching: solve (whiteboard) ⇄ answer (keyboard) ---- */
  _enterAnswerMode() {
    this.mode = "answer";
    const app = document.getElementById("app");
    app.classList.remove("mode-solve");
    app.classList.add("mode-answer");
    document.getElementById("btn-enter-answer").classList.remove("pulse");

    // Collapse the problem panel to make room for the keyboard
    this.isProblemCollapsed = true;
    document.getElementById("problem-panel").classList.add("collapsed");

    this._updateRefCard();
    setTimeout(() => this.canvasMgr.resize(), 60);
  }

  _enterSolveMode() {
    this.mode = "solve";
    const app = document.getElementById("app");
    app.classList.remove("mode-answer");
    app.classList.add("mode-solve");

    this.isProblemCollapsed = false;
    document.getElementById("problem-panel").classList.remove("collapsed");

    setTimeout(() => this.canvasMgr.resize(), 60);
  }

  /* ---- Populate the reference card with the circled region ---- */
  _updateRefCard() {
    const card = document.getElementById("answer-ref-card");
    const img  = document.getElementById("answer-ref-img");
    const data = this.canvasMgr.getRegionImage();
    if (data) {
      img.src = data;
      card.classList.remove("hidden");
    } else {
      card.classList.add("hidden");
    }
  }

  /* ---- Fired when a region is circled on the whiteboard ---- */
  _onRegionMarked() {
    // Revert to the pen so the next stroke is normal drawing
    this.canvasMgr.setTool("pen");
    document.querySelectorAll(".tool-btn[data-tool]").forEach(b =>
      b.classList.toggle("active", b.dataset.tool === "pen"));

    // If already answering, refresh the crop live
    if (this.mode === "answer") this._updateRefCard();
    else document.getElementById("btn-enter-answer").classList.add("pulse");

    this._toast("答えの範囲を記録しました ✓");
    if (navigator.vibrate) navigator.vibrate(20);
  }

  /* ---- Highlight active structure key ---- */
  _updateStructKeyHighlights(mode) {
    const ids = { "kb-frac": ["FRAC_DEN","FRAC_NUM"], "kb-sqrt": ["SQRT"], "kb-exp": ["EXPONENT"], "kb-abs": ["ABS"] };
    for (const [id, modes] of Object.entries(ids)) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("active", modes.includes(mode));
    }
  }

  /* ---- Transient toast message ---- */
  _toast(msg) {
    let t = document.getElementById("app-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "app-toast";
      t.className = "app-toast";
      document.getElementById("app").appendChild(t);
    }
    t.textContent = msg;
    // reflow to restart transition reliably
    void t.offsetWidth;
    t.classList.add("show");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  /* ---- Answer checking ---- */
  _checkAnswer() {
    const problem = this.currentProblem;
    if (!problem) return;

    const isCorrect = this._normaliseAnswer(this.editor.getText())
                   === this._normaliseAnswer(problem.answer);

    // Update session stats
    this.sessionTotal++;
    if (isCorrect) this.sessionCorrect++;
    this._updateCounter();

    const sessionDone = this.sessionLimit && this.sessionTotal >= this.sessionLimit;

    // アニメーション
    const dispEl = document.getElementById("answer-display");
    dispEl.classList.add(isCorrect ? "flash-correct" : "flash-wrong");
    setTimeout(() => dispEl.classList.remove("flash-correct", "flash-wrong"), 500);

    // バナー
    const banner = document.getElementById("rs-banner");
    const rsIcon = document.getElementById("rs-icon");
    const rsTitle = document.getElementById("rs-title");
    banner.className = "rs-banner " + (isCorrect ? "correct" : "incorrect");
    rsIcon.textContent  = isCorrect ? "○" : "×";
    rsTitle.textContent = isCorrect ? "正解！" : "不正解";

    // 問題文
    const rsProblem = document.getElementById("rs-problem");
    rsProblem.innerHTML = problem.text;

    // 正解
    const rsAnswer = document.getElementById("rs-answer");
    rsAnswer.className = "rs-answer-box " + (isCorrect ? "user-correct" : "user-incorrect");
    rsAnswer.innerHTML = `$${problem.answerDisplay}$`;

    // 途中式
    const rsStepsSection = document.getElementById("rs-steps-section");
    const rsSteps = document.getElementById("rs-steps");
    if (problem.steps && problem.steps.length) {
      rsStepsSection.style.display = "";
      rsSteps.innerHTML = problem.steps.map((s, i) =>
        `<div class="rs-step-item">
          <span class="rs-step-num">${i + 1}</span>
          <span class="rs-step-body">${s}</span>
        </div>`
      ).join("");
    } else {
      rsStepsSection.style.display = "none";
    }

    // 次へボタンのラベル
    document.getElementById("btn-next-problem").textContent =
      sessionDone ? "結果を見る" : "次の問題へ";

    // 自動採点モード: 自己判定ボタン・囲み画像は出さず、通常フッターを表示
    document.getElementById("rs-region-section").classList.add("hidden");
    document.getElementById("rs-footer-judge").classList.add("hidden");
    document.getElementById("rs-footer-normal").classList.remove("hidden");

    // 表示
    this._showResultScreen();

    // KaTeX レンダリング（スライドイン後）
    setTimeout(() => {
      if (window.renderMathInElement) {
        renderMathInElement(document.getElementById("result-screen"), {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
          ],
          throwOnError: false,
        });
      }
    }, 100);
  }

  _showCompletionScreen() {
    const pct = this.sessionTotal > 0
      ? Math.round((this.sessionCorrect / this.sessionTotal) * 100) : 0;

    // バナー
    document.getElementById("rs-banner").className = "rs-banner correct";
    document.getElementById("rs-icon").textContent  = "🎉";
    document.getElementById("rs-title").textContent = "セッション終了";

    // 問題文エリアを流用してスコア表示
    document.getElementById("rs-problem").innerHTML =
      `正解 <strong>${this.sessionCorrect}</strong> / ${this.sessionTotal} 問`;
    document.getElementById("rs-answer").innerHTML = `${pct}%`;
    document.getElementById("rs-answer").className = "rs-answer-box user-correct";
    document.getElementById("rs-steps-section").style.display = "none";

    // 次へボタンを「もう一周する」に変更
    const nextBtn = document.getElementById("btn-next-problem");
    nextBtn.textContent = "もう一周する";
    nextBtn.onclick = () => {
      this._hideResultScreen();
      nextBtn.textContent = "次の問題へ";
      nextBtn.onclick = null;
      this._applySessionLimit();
      this._updateCounter();
      this._generateNextProblem();
    };

    this._showResultScreen();
  }
}

/* =======================================================
   SECTION 5: PWA SERVICE WORKER REGISTRATION
   ======================================================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .catch(err => console.warn("SW registration failed:", err));
  });
}

/* =======================================================
   SECTION 6: BOOT
   ======================================================= */
function boot() {
  window._app = new AppController();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
