/* ============================================================
   Bunk Buddy — attendance calculator
   Upload photo → preprocess → OCR (Tesseract.js, in-browser,
   word positions via TSV) → locate the TH / AH / DL rows of
   the course-wise table → editable table → per-course verdict.
   Effective attendance = (AH + DL) / TH.
   ============================================================ */

const $ = (id) => document.getElementById(id);

const dropzone = $('dropzone');
const fileInput = $('fileInput');
const dzInner = $('dzInner');
const previewImg = $('previewImg');
const ocrStatus = $('ocrStatus');
const ocrLabel = $('ocrLabel');
const ocrProgress = $('ocrProgress');
const changeImageBtn = $('changeImageBtn');
const manualBtn = $('manualBtn');
const notReport = $('notReport');
const tableCard = $('tableCard');
const tableHint = $('tableHint');
const subjectBody = $('subjectBody');
const addRowBtn = $('addRowBtn');
const calcBtn = $('calcBtn');
const resultsSection = $('resultsSection');
const overallCard = $('overallCard');
const resultsGrid = $('resultsGrid');
const targetInput = $('targetInput');

/* ---------------- Upload handling ---------------- */

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) handleImage(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleImage(fileInput.files[0]);
});

// Paste a screenshot anywhere on the page
document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      handleImage(item.getAsFile());
      break;
    }
  }
});

changeImageBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.value = '';
  fileInput.click();
});

manualBtn.addEventListener('click', () => {
  subjectBody.innerHTML = '';
  for (let i = 0; i < 3; i++) addRow();
  tableHint.textContent = 'Enter each course with attended hours (AH), duty leave (DL — leave 0 if none) and total hours (TH).';
  showTable();
  subjectBody.querySelector('input').focus();
});

function handleImage(file) {
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  previewImg.hidden = false;
  dzInner.hidden = true;
  changeImageBtn.hidden = false;
  resultsSection.hidden = true;
  notReport.hidden = true;
  runOCR(file);
}

/* Does the OCR text look like a course attendance report at all?
   Scores the markers these reports always carry; a random screenshot
   (chat, meme, game…) lands well under the threshold. */
function reportScore(text) {
  const t = (text || '').toLowerCase();
  let score = 0;
  if (/attendance/.test(t)) score += 3;
  if (/report/.test(t)) score += 1;
  if (/\bth\b|™/i.test(text || '')) score += 1;
  if (/\bah\b/i.test(text || '')) score += 1;
  if (/\bdl\b/i.test(text || '')) score += 1;
  if (/percentage|%/.test(t)) score += 1;
  if (/course|subject/.test(t)) score += 1;
  if (/total\s+hours|attended\s+hours|duty\s+leave/.test(t)) score += 2;
  if (/\bterm\b|semester|\bsem\b|roll/.test(t)) score += 1;
  return score;
}
const REPORT_SCORE_MIN = 4;

/* ---------------- Image preprocessing ----------------
   Phone photos of printed reports OCR far better after
   upscaling + grayscale + contrast stretch; a second
   adaptive-threshold pass handles shadows/low contrast.  */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function preprocess(img, mode) {
  const scale = Math.min(3, Math.max(1, 1700 / img.naturalWidth));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    gray[i] = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
  }

  if (mode === 'enhance') {
    // contrast stretch between the 2nd and 98th percentile
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[gray[i]]++;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) {
      const v = ((gray[i] - lo) / range) * 255;
      const j = i * 4;
      d[j] = d[j + 1] = d[j + 2] = v;
    }
  } else {
    // adaptive (mean) threshold via integral image — robust to shadows
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    const win = Math.max(15, (Math.round(w / 32) | 1));
    const half = win >> 1;
    const mask = new Uint8Array(n); // 1 = dark (ink)
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum =
          integral[(y1 + 1) * (w + 1) + (x1 + 1)] -
          integral[y0 * (w + 1) + (x1 + 1)] -
          integral[(y1 + 1) * (w + 1) + x0] +
          integral[y0 * (w + 1) + x0];
        mask[y * w + x] = gray[y * w + x] < (sum / count) * 0.92 ? 1 : 0;
      }
    }

    // Erase table grid lines: long horizontal / vertical runs of ink
    // wreck Tesseract's segmentation, and every college report has them.
    const hMin = Math.round(w * 0.08);
    for (let y = 0; y < h; y++) {
      let runStart = -1;
      for (let x = 0; x <= w; x++) {
        const dark = x < w && mask[y * w + x];
        if (dark && runStart < 0) runStart = x;
        else if (!dark && runStart >= 0) {
          if (x - runStart >= hMin) for (let k = runStart; k < x; k++) mask[y * w + k] = 0;
          runStart = -1;
        }
      }
    }
    const vMin = Math.round(h * 0.05);
    for (let x = 0; x < w; x++) {
      let runStart = -1;
      for (let y = 0; y <= h; y++) {
        const dark = y < h && mask[y * w + x];
        if (dark && runStart < 0) runStart = y;
        else if (!dark && runStart >= 0) {
          if (y - runStart >= vMin) for (let k = runStart; k < y; k++) mask[k * w + x] = 0;
          runStart = -1;
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const v = mask[i] ? 0 : 255;
      const j = i * 4;
      d[j] = d[j + 1] = d[j + 2] = v;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/* ---------------- OCR ---------------- */

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          ocrProgress.style.width = Math.round(m.progress * 100) + '%';
        }
      },
    });
  }
  return workerPromise;
}

async function runOCR(file) {
  ocrStatus.hidden = false;
  ocrProgress.style.width = '0%';
  ocrLabel.textContent = 'Warming up the text reader…';
  calcBtn.disabled = true;

  try {
    const worker = await getWorker();
    const img = await loadImage(file);

    let rows = null;
    let fallbackText = '';
    // pass 1: binarized + grid lines erased, table-friendly PSM;
    // pass 2: gentle contrast enhance + auto PSM (for sheets where
    // binarization hurts, e.g. screenshots)
    const passes = [
      { mode: 'clean', psm: '6' },
      { mode: 'enhance', psm: '3' },
    ];
    for (let p = 0; p < passes.length; p++) {
      ocrLabel.textContent = `Reading your attendance sheet… (pass ${p + 1}/${passes.length})`;
      ocrProgress.style.width = '0%';
      await worker.setParameters({ tessedit_pageseg_mode: passes[p].psm });
      const canvas = preprocess(img, passes[p].mode);
      const { data } = await worker.recognize(canvas, {}, { text: true, tsv: true });
      if (data.text) fallbackText += '\n' + data.text;
      rows = parseStructured(data.tsv, canvas.width);
      if (rows.length) break;
    }

    if (!rows.length) {
      // not a single TH/AH table found — is this even an attendance report?
      if (reportScore(fallbackText) < REPORT_SCORE_MIN) {
        ocrStatus.hidden = true;
        calcBtn.disabled = false;
        tableCard.hidden = true;
        notReport.hidden = false;
        return;
      }
      // it smells like a report, the table just didn't parse —
      // last resort: old line-based text heuristics
      rows = parseAttendanceText(fallbackText).map((r) => ({
        subject: r.subject, ah: r.attended, dl: 0, th: r.total,
      }));
    }

    ocrStatus.hidden = true;
    calcBtn.disabled = false;
    subjectBody.innerHTML = '';

    if (rows.length === 0) {
      for (let i = 0; i < 3; i++) addRow();
      tableHint.textContent =
        "We couldn't find the TH / AH / DL table in that photo. Try a sharper, straight-on shot — or type the numbers in below.";
    } else {
      rows.forEach((r) => addRow(r.subject, r.ah, r.dl, r.th));
      // flag cells that look like OCR dropped a digit (TH far below the others)
      const ths = rows.map((r) => r.th).sort((a, b) => a - b);
      const medTh = ths[ths.length >> 1];
      let suspects = 0;
      subjectBody.querySelectorAll('tr').forEach((tr, i) => {
        if (rows[i].th < medTh * 0.4) {
          tr.querySelector('.total').classList.add('suspect');
          tr.querySelector('.attended').classList.add('suspect');
          suspects++;
        }
      });
      tableHint.textContent =
        `Found ${rows.length} course${rows.length > 1 ? 's' : ''} (TH = total hours, AH = attended, DL counts toward attendance). ` +
        (suspects
          ? `⚠️ ${suspects} value${suspects > 1 ? 's look' : ' looks'} misread (highlighted orange) — please fix from your photo.`
          : 'Double-check the numbers against your photo before calculating.');
    }
    showTable();
  } catch (err) {
    console.error('OCR failed:', err);
    ocrStatus.hidden = true;
    calcBtn.disabled = false;
    subjectBody.innerHTML = '';
    for (let i = 0; i < 3; i++) addRow();
    tableHint.textContent = 'Something went wrong while reading the image — enter your courses manually below.';
    showTable();
  }
}

/* ---------------- Structured (positional) parsing ----------------
   Works from Tesseract's TSV output: every word with its bounding
   box. Strategy:
   1. Cluster words into visual rows by y-position.
   2. ROW layout (labels down the side):  "TH | 45 52 60 …",
      "AH | 40 50 55 …", "DL | 0 2 1 …" — pair numbers by column x.
   3. COLUMN layout (labels across the top): header line contains
      TH / AH / DL — assign each row's numbers to the nearest
      header column.
   Everything else on the sheet (college name, student details,
   percentage rows…) is ignored.                                    */

const alphaOf = (t) => t.toUpperCase().replace(/[^A-Z]/g, '');
// short labels get mangled by OCR (DL → "nL", TH → "TII"…): accept variants
const LABEL_VARIANTS = {
  th: new Set(['TH', 'TII', 'IH', 'FH', 'TB', 'TR']),
  ah: new Set(['AH', 'AN', 'AB', 'AR', 'AHL']),
  dl: new Set(['DL', 'NL', 'OL', 'BL', 'DI', 'DT', 'OI', 'DU']),
};
function labelOf(text) {
  if (text.includes('™')) return 'th'; // OCR reads the "TH" header as ™
  const a = alphaOf(text);
  for (const key of ['th', 'ah', 'dl']) if (LABEL_VARIANTS[key].has(a)) return key;
  return null;
}
const PCT_ALPHAS = new Set(['PERCENTAGE', 'PERCENT', 'PERC', 'PER', 'PCT', 'ATTPERCENTAGE']);
const SERIAL_ALPHAS = new Set(['SL', 'SLNO', 'SNO', 'SINO', 'SRNO', 'NO', 'SERIALNO']);
const COURSE_ALPHAS = new Set(['COURSE', 'COURSES', 'SUBJECT', 'SUBJECTS', 'PAPER', 'COURSENAME', 'SUBJECTNAME']);

// percentages often lose their decimal point ("96.2" → "962")
function normalizePct(v) {
  if (v > 100 && v <= 1000) v /= 10;
  else if (v > 1000 && v <= 10000) v /= 100;
  return v >= 0 && v <= 100 ? v : null;
}

// reading order for name fragments: line by line, then left to right
// (plain yc sort shuffles words whose baselines jitter by a few px)
function readingOrder(a, b) {
  return Math.abs(a.yc - b.yc) > Math.max(a.h, b.h) * 0.6 ? a.yc - b.yc : a.x0 - b.x0;
}

// is `s` a subsequence of `t`? ("4" ⊂ "41" — digit dropped by OCR)
function isSubseq(s, t) {
  let i = 0;
  for (const ch of t) if (ch === s[i]) i++;
  return i === s.length;
}

// cross-check AH against the report's own % column/row: recover digits
// the OCR dropped ("41" → "4") or cells it missed entirely
function reconcileAH(ah, dl, th, pct) {
  if (pct === null || th <= 0) return ah;
  const expected = Math.round((pct / 100) * th) - dl;
  if (expected < 0 || expected > th) return ah;
  if (ah === null) return expected;
  const consistent = Math.abs((ah + dl) - (pct / 100) * th) <= Math.max(1.5, th * 0.03);
  if (!consistent && isSubseq(String(ah), String(expected))) return expected;
  return ah;
}

// Drop the course code that trails the name in brackets — "COMPUTER
// ORGANIZATION ( CSA1201 )" → "COMPUTER ORGANIZATION". OCR often loses a
// bracket, so we also strip a bare trailing code token and any leftover
// parens, not just well-formed "( … )" pairs.
function cleanCourseName(name) {
  return name
    .replace(/\([^)]*\)/g, ' ')                  // ( CSA1201 )
    .replace(/\(?\s*[A-Z]{2,4}\s*\d{3,4}[A-Z]?\s*\)?/g, ' ') // bare/half-bracketed code
    .replace(/[()\[\]]/g, ' ')                   // stray brackets left behind
    .replace(/\s+/g, ' ')
    .trim();
}

function numValueOf(text) {
  let m = text.replace(/[^0-9.]/g, '').replace(/^\.+|\.+$/g, '');
  if (!m || !/^\d+(\.\d+)?$/.test(m)) return null;
  // reject if the original token is mostly letters (e.g. course code "CST201")
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (letters > 1) return null;
  return parseFloat(m);
}

function parseTSV(tsv) {
  const words = [];
  for (const line of (tsv || '').split('\n')) {
    const f = line.split('\t');
    if (f.length < 12 || f[0] !== '5') continue; // level 5 = word
    const text = f.slice(11).join('\t').trim();
    if (!text) continue;
    const left = +f[6], top = +f[7], width = +f[8], height = +f[9], conf = +f[10];
    if (conf < 15) continue; // drop pure noise
    words.push({ text, x0: left, y0: top, x1: left + width, y1: top + height, xc: left + width / 2, yc: top + height / 2, h: height });
  }
  return words;
}

function clusterRows(words) {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.yc - b.yc);
  const heights = sorted.map((w) => w.h).sort((a, b) => a - b);
  const medH = heights[heights.length >> 1] || 20;
  const tol = medH * 0.7;
  const rows = [];
  let current = null;
  for (const w of sorted) {
    if (current && Math.abs(w.yc - current.yc) <= tol) {
      current.words.push(w);
      current.yc = current.words.reduce((s, x) => s + x.yc, 0) / current.words.length;
    } else {
      current = { yc: w.yc, words: [w] };
      rows.push(current);
    }
  }
  rows.forEach((r) => r.words.sort((a, b) => a.x0 - b.x0));
  return rows;
}

function numbersIn(row) {
  return row.words
    .map((w) => ({ w, value: numValueOf(w.text) }))
    .filter((x) => x.value !== null);
}

// match candidate number-words to a set of column anchor x-centers
function alignToAnchors(anchorXs, numWords, tol) {
  const used = new Set();
  return anchorXs.map((ax) => {
    let best = null;
    for (const nw of numWords) {
      if (used.has(nw)) continue;
      const dist = Math.abs(nw.w.xc - ax);
      if (dist <= tol && (best === null || dist < Math.abs(best.w.xc - ax))) best = nw;
    }
    if (best) used.add(best);
    return best;
  });
}

function parseStructured(tsv, imgWidth) {
  const words = parseTSV(tsv);
  const rows = clusterRows(words);
  if (!rows.length) return [];

  const rowLayout = parseRowLayout(rows, imgWidth);
  if (rowLayout.length) return rowLayout;
  return parseColumnLayout(rows, imgWidth);
}

/* --- layout A: TH / AH / DL are row labels, courses are columns --- */
function parseRowLayout(rows, imgWidth) {
  const labelRows = {};
  let pctRow = null;
  for (const row of rows) {
    // label must be one of the first words, left of the numbers
    for (const w of row.words.slice(0, 3)) {
      const key = labelOf(w.text);
      if (key && !labelRows[key]) {
        const nums = numbersIn(row).filter((x) => x.w.x0 > w.x1 - 5);
        if (nums.length >= 2 || (key === 'dl' && nums.length >= 1)) {
          labelRows[key] = { row, labelWord: w, nums };
        }
      }
      if (!pctRow && (PCT_ALPHAS.has(alphaOf(w.text)) || w.text.includes('%'))) {
        const nums = numbersIn(row).filter((x) => x.w.x0 > w.x1 - 5);
        if (nums.length >= 2) pctRow = { labelWord: w, nums };
      }
    }
  }
  if (!labelRows.th || !labelRows.ah) return [];

  const totals = labelRows.th.nums;
  const anchorXs = totals.map((t) => t.w.xc);
  const gaps = anchorXs.slice(1).map((x, i) => x - anchorXs[i]).sort((a, b) => a - b);
  const medGap = gaps[gaps.length >> 1] || imgWidth * 0.1;
  const tol = medGap * 0.55;

  let attended = alignToAnchors(anchorXs, labelRows.ah.nums, tol);
  // x-alignment failed (skewed photo) but counts match → pair by index
  if (attended.filter(Boolean).length < totals.length * 0.6 &&
      labelRows.ah.nums.length === totals.length) {
    attended = labelRows.ah.nums;
  }
  let dls = labelRows.dl
    ? alignToAnchors(anchorXs, labelRows.dl.nums, tol)
    : totals.map(() => null);
  if (labelRows.dl && dls.filter(Boolean).length === 0 &&
      labelRows.dl.nums.length === totals.length) {
    dls = labelRows.dl.nums;
  }
  const pcts = pctRow ? alignToAnchors(anchorXs, pctRow.nums, tol) : totals.map(() => null);

  // serial row: consecutive integers starting at 1, above the TH row
  let serialRow = null;
  for (const row of rows) {
    if (row.yc >= labelRows.th.row.yc) continue;
    const nums = numbersIn(row).map((x) => x.value);
    if (nums.length >= Math.min(3, totals.length) && nums[0] === 1 &&
        nums.every((v, i) => v === i + 1)) {
      serialRow = row;
    }
  }

  // course names: words between the serial row and the TH row, bucketed
  // to the nearest column anchor. Without a serial row, reach up at most
  // ~2.5 table-row heights so college/student header text stays out.
  const names = totals.map(() => []);
  const rowH = labelRows.ah.row.yc - labelRows.th.row.yc;
  const reach = rowH > 0 ? rowH * 2.6 : medGap;
  const yTop = serialRow ? serialRow.yc : labelRows.th.row.yc - reach;
  for (const row of rows) {
    if (row.yc <= yTop + 2 || row.yc >= labelRows.th.row.yc - 2) continue;
    if (row === labelRows.ah.row || (labelRows.dl && row === labelRows.dl.row)) continue;
    for (const w of row.words) {
      const a = alphaOf(w.text);
      if (COURSE_ALPHAS.has(a) || SERIAL_ALPHAS.has(a) || labelOf(w.text)) continue;
      if (!/[A-Za-z]/.test(w.text)) continue;
      let bi = 0, bd = Infinity;
      anchorXs.forEach((ax, i) => {
        const dist = Math.abs(w.xc - ax);
        if (dist < bd) { bd = dist; bi = i; }
      });
      if (bd <= medGap * 0.7) names[bi].push(w);
    }
  }

  const out = [];
  totals.forEach((t, i) => {
    const th = t.value;
    let ah = attended[i] ? attended[i].value : null;
    const dl = dls[i] ? dls[i].value : 0;
    if (th === null || th <= 0 || th > 3000) return;

    const pct = pcts[i] ? normalizePct(pcts[i].value) : null;
    ah = reconcileAH(ah, dl, th, pct);
    if (ah === null || ah < 0) return;

    const name = cleanCourseName(
      names[i].sort(readingOrder).map((w) => w.text).join(' ')
    );
    out.push({ subject: name.length >= 2 ? name : `Course ${i + 1}`, ah, dl, th });
  });
  return out;
}

/* --- layout B: TH / AH / DL are column headers, courses are rows ---
   Real sheets (e.g. Presidency University) add traps: a legend line
   ("TH : Total Hours AH : …") that also contains the label words, extra
   AH+DL / AH% / AH+DL% columns, course names wrapping over several
   text lines inside one table row, and a TOTAL row at the bottom.     */
function parseColumnLayout(rows, imgWidth) {
  // candidate header rows: contain plain TH + AH words ("AH%" / "AH+DL"
  // don't count). The legend line also qualifies — so we try every
  // candidate and keep whichever parse yields the most courses.
  const candidates = [];
  for (const row of rows) {
    const cols = {};
    let pctX = null, ahdlX = null;
    for (const w of row.words) {
      if (w.text.includes('%')) { pctX = w.xc; continue; } // rightmost % column wins
      if (w.text.includes('+')) {
        if (alphaOf(w.text) === 'AHDL') ahdlX = w.xc; // "AH+DL" column
        continue;
      }
      const key = labelOf(w.text);
      if (key && cols[key] === undefined) cols[key] = w.xc;
    }
    if (cols.ah !== undefined && (cols.th !== undefined || pctX !== null)) {
      candidates.push({ header: row, cols, pctX, ahdlX });
    }
  }

  let best = [];
  for (const cand of candidates) {
    const parsed = parseWithHeader(rows, cand, imgWidth);
    if (parsed.length > best.length) best = parsed;
  }
  return best;
}

function parseWithHeader(rows, { header, cols, pctX, ahdlX }, imgWidth) {
  const centers = Object.values(cols).sort((a, b) => a - b);
  const gaps = centers.slice(1).map((x, i) => x - centers[i]);
  const minGap = gaps.length ? Math.min(...gaps) : imgWidth * 0.12;
  const tol = Math.max(minGap * 0.55, imgWidth * 0.03);
  const leftEdge = Math.min(...centers) - minGap * 0.5;

  const nameWordsOf = (row) =>
    row.words.filter((w) => {
      if (w.xc >= leftEdge || !/[A-Za-z]/.test(w.text)) return false;
      const a = alphaOf(w.text);
      return !SERIAL_ALPHAS.has(a) && !COURSE_ALPHAS.has(a);
    });

  // split rows below the header into table rows (have TH+AH numbers in
  // the right columns) and loose text lines (wrapped course names)
  const bands = [];
  const loose = [];
  for (const row of rows) {
    if (row === header || row.yc <= header.yc) continue;
    const nums = numbersIn(row);
    const pickAt = (x) => {
      if (x === undefined || x === null) return null;
      let bestW = null;
      for (const nw of nums) {
        const dist = Math.abs(nw.w.xc - x);
        if (dist <= tol && (bestW === null || dist < Math.abs(bestW.w.xc - x))) bestW = nw;
      }
      return bestW;
    };
    const thW = pickAt(cols.th);
    const ahW = pickAt(cols.ah);
    const dlW = pickAt(cols.dl);
    const ahdlW = pickAt(ahdlX);
    const pctW = pickAt(pctX);

    const dl = dlW && dlW !== thW && dlW !== ahW ? dlW.value : 0;
    const pct = pctW ? normalizePct(pctW.value) : null;
    const ahdl = ahdlW && ahdlW !== ahW && ahdlW !== pctW ? ahdlW.value : null;
    let ah = ahW && ahW !== thW ? ahW.value : null;
    if (ah === null && ahdl !== null) ah = Math.max(0, ahdl - dl);

    let th = thW && thW !== ahW ? thW.value : null;
    // TH column unreadable (header often OCRs badly) → rebuild it from
    // the sheet's own percentage: th = (AH+DL) / pct
    if (th === null && pct !== null && pct > 0) {
      th = Math.round(((ahdl !== null ? ahdl : (ah || 0) + dl) / pct) * 100);
    }

    if (ah !== null && th !== null && th > 0 && th <= 3000) {
      bands.push({ yc: row.yc, th, ah, dl, ahdl, pct, names: nameWordsOf(row) });
    } else {
      loose.push(row);
    }
  }
  if (!bands.length) return [];

  // drop the summary TOTAL row BEFORE attaching name fragments, so a
  // course's wrapped last line can't get attached to it. A real course
  // named "TOTAL …" survives via the magnitude guard.
  const summaryFree = bands.filter((b, i) => {
    const hasTotal = b.names.some((w) => ['TOTAL', 'GRANDTOTAL'].includes(alphaOf(w.text)));
    if (!hasTotal || bands.length < 2) return true;
    const maxOther = Math.max(...bands.filter((_, j) => j !== i).map((x) => x.th));
    return b.th < maxOther * 1.2;
  });
  if (summaryFree.length) bands.length = 0, bands.push(...summaryFree);

  // attach wrapped course-name lines to the nearest table row
  const bandYs = bands.map((b) => b.yc);
  const bandGaps = bandYs.slice(1).map((y, i) => y - bandYs[i]).sort((a, b) => a - b);
  const medBand = bandGaps[bandGaps.length >> 1] || imgWidth * 0.06;
  for (const row of loose) {
    let bi = -1, bd = Infinity;
    bands.forEach((b, i) => {
      const d = Math.abs(row.yc - b.yc);
      if (d < bd) { bd = d; bi = i; }
    });
    if (bi >= 0 && bd <= medBand * 0.55) bands[bi].names.push(...nameWordsOf(row));
  }

  const out = [];
  for (const b of bands) {
    const rawName = b.names.sort(readingOrder).map((w) => w.text).join(' ');
    if (alphaOf(rawName) === 'TOTAL') continue; // summary row, not a course
    const name = cleanCourseName(rawName);
    let ah = b.ah;
    // when the AH+DL column and the % column agree with each other,
    // they outvote a misread AH cell
    if (b.ahdl !== null && b.pct !== null &&
        Math.abs((b.ahdl / b.th) * 100 - b.pct) <= 1.2) {
      const cand = b.ahdl - b.dl;
      if (cand >= 0 && cand <= b.th) ah = cand;
    } else {
      ah = reconcileAH(ah, b.dl, b.th, b.pct);
    }
    if (ah === null || ah < 0) continue;
    out.push({ subject: name.length >= 2 ? name : `Course ${out.length + 1}`, ah, dl: b.dl, th: b.th });
  }
  return out;
}

/* ---------------- Plain-text fallback parser ---------------- */

const HEADER_WORDS = /\b(subject|course|attended|present|absent|conducted|held|total|percentage|perc|att%|sl\.?\s*no|s\.?\s*no|code|semester|branch|roll)\b/i;

function parseAttendanceText(text) {
  const out = [];
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const headerHits = (line.match(new RegExp(HEADER_WORDS.source, 'gi')) || []).length;
    if (headerHits >= 2) continue;
    const parsed = parseLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseLine(line) {
  const cleaned = line.replace(/[|]/g, ' ');
  const frac = cleaned.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
  const numTokens = [...cleaned.matchAll(/\d+(?:\.\d+)?/g)].map((m) => ({
    value: parseFloat(m[0]), raw: m[0], index: m.index,
  }));
  if (numTokens.length < 2 && !frac) return null;

  let pct = null;
  const pctMatch = cleaned.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) pct = parseFloat(pctMatch[1]);
  else {
    const dec = numTokens.filter((t) => t.raw.includes('.') && t.value <= 100);
    if (dec.length) pct = dec[dec.length - 1].value;
  }

  let attended = null, total = null;
  if (frac) {
    attended = parseInt(frac[1], 10);
    total = parseInt(frac[2], 10);
  } else {
    const ints = numTokens.filter((t) => !t.raw.includes('.'));
    const candidates = ints.map((t) => t.value);
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        const a = candidates[i], t = candidates[j];
        if (a > t || t === 0 || t > 2000) continue;
        const impliedPct = (a / t) * 100;
        if (pct !== null) {
          const diff = Math.abs(impliedPct - pct);
          if (diff < 2.5 && (best === null || diff < best.diff)) best = { a, t, diff };
        } else if (best === null && j === i + 1) {
          best = { a, t, diff: 99 };
        }
      }
    }
    if (!best && pct !== null) {
      for (const t of candidates) {
        if (t === 0 || t > 2000) continue;
        const a = Math.round((pct / 100) * t);
        const diff = Math.abs((a / t) * 100 - pct);
        if (a <= t && diff < 1 && (best === null || diff < best.diff)) best = { a, t, diff };
      }
    }
    if (best) { attended = best.a; total = best.t; }
  }

  if (attended === null || total === null || total === 0 || attended > total) return null;

  const firstNumIdx = cleaned.search(/\d/);
  let subject = (firstNumIdx > 0 ? cleaned.slice(0, firstNumIdx) : '')
    .replace(/[^A-Za-z&().\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (subject.length < 2) subject = '';
  return { subject, attended, total };
}

/* ---------------- Editable table ---------------- */

function showTable() {
  tableCard.hidden = false;
  tableCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function addRow(subject = '', ah = '', dl = '', th = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="subj" placeholder="e.g. Mathematics" value="${escapeAttr(subject)}"></td>
    <td><input type="number" class="num attended" min="0" placeholder="0" value="${ah}"></td>
    <td><input type="number" class="num dl" min="0" placeholder="0" value="${dl}"></td>
    <td><input type="number" class="num total" min="0" placeholder="0" value="${th}"></td>
    <td class="pct-cell">—</td>
    <td><button class="del-btn" title="Remove course" aria-label="Remove course">✕</button></td>
  `;
  tr.querySelector('.del-btn').addEventListener('click', () => tr.remove());
  tr.querySelectorAll('input.num').forEach((inp) =>
    inp.addEventListener('input', () => { inp.classList.remove('suspect'); updateRowPct(tr); })
  );
  subjectBody.appendChild(tr);
  updateRowPct(tr);
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function rowValues(tr) {
  const ah = parseFloat(tr.querySelector('.attended').value);
  const dl = parseFloat(tr.querySelector('.dl').value || '0');
  const th = parseFloat(tr.querySelector('.total').value);
  return { ah, dl: isNaN(dl) ? 0 : dl, th };
}

function updateRowPct(tr) {
  const { ah, dl, th } = rowValues(tr);
  const cell = tr.querySelector('.pct-cell');
  const target = getTarget();
  const a = ah + dl;
  if (!isNaN(ah) && !isNaN(th) && th > 0 && a <= th) {
    const pct = (a / th) * 100;
    cell.textContent = pct.toFixed(1) + '%';
    cell.classList.toggle('good', pct >= target);
    cell.classList.toggle('bad', pct < target);
  } else {
    cell.textContent = '—';
    cell.classList.remove('good', 'bad');
  }
}

addRowBtn.addEventListener('click', () => {
  addRow();
  const inputs = subjectBody.querySelectorAll('tr:last-child input');
  if (inputs[0]) inputs[0].focus();
});

function getTarget() {
  const v = parseFloat(targetInput.value);
  return isNaN(v) || v <= 0 || v >= 100 ? 75 : v;
}

targetInput.addEventListener('input', () => {
  subjectBody.querySelectorAll('tr').forEach(updateRowPct);
  if (!resultsSection.hidden) calculate();
});

/* ---------------- The math ----------------
   target fraction p, effective attended a = AH + DL, total t = TH:
   • Need to reach p:   (a+x)/(t+x) ≥ p  →  x = ceil((p·t − a)/(1 − p))
   • Can bunk:          a/(t+y) ≥ p      →  y = floor(a/p − t)          */

function classesNeeded(a, t, p) {
  return Math.max(0, Math.ceil((p * t - a) / (1 - p)));
}

function classesBunkable(a, t, p) {
  return Math.max(0, Math.floor(a / p - t));
}

/* ---------------- Visual helpers ---------------- */

// animate a number from 0 → value
function countUp(el, to, { decimals = 1, suffix = '%', dur = 900 } = {}) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = (eased * to).toFixed(decimals) + suffix;
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = to.toFixed(decimals) + suffix;
  }
  requestAnimationFrame(tick);
}

// point on the semicircular gauge for a 0..100 value
function gaugePoint(cx, cy, R, v) {
  const ang = Math.PI - (Math.max(0, Math.min(100, v)) / 100) * Math.PI;
  return [cx + R * Math.cos(ang), cy - R * Math.sin(ang)];
}
function gaugeArc(cx, cy, R, v0, v1) {
  const steps = Math.max(2, Math.round(Math.abs(v1 - v0) / 2));
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const [x, y] = gaugePoint(cx, cy, R, v0 + (v1 - v0) * (i / steps));
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
  }
  return d.trim();
}

// Build the bunk-o-meter. Returns {html, needleAngle, color, word}.
function buildGauge(overallPct, target, riskColor, word) {
  const cx = 115, cy = 118, R = 95;
  const amberEnd = Math.min(target + 8, 100);
  const zones = [
    { from: 0, to: target, color: '#f87171' },
    { from: target, to: amberEnd, color: '#fbbf24' },
    { from: amberEnd, to: 100, color: '#34d399' },
  ].filter((z) => z.to > z.from);
  const bands = zones
    .map((z) => `<path d="${gaugeArc(cx, cy, R, z.from, z.to)}" stroke="${z.color}" stroke-width="15" fill="none" stroke-linecap="round" opacity="0.92"/>`)
    .join('');
  // target tick
  const [tx0, ty0] = gaugePoint(cx, cy, R + 11, target);
  const [tx1, ty1] = gaugePoint(cx, cy, R - 11, target);
  const tick = `<line x1="${tx0.toFixed(1)}" y1="${ty0.toFixed(1)}" x2="${tx1.toFixed(1)}" y2="${ty1.toFixed(1)}" stroke="var(--text)" stroke-width="2" opacity="0.6"/>`;
  const angle = (Math.max(0, Math.min(100, overallPct)) - 50) * 1.8;
  // Resting state is correct via the inline transform / text; the CSS
  // keyframes only add the sweep + count-up when the tab is visible.
  const html = `
    <svg viewBox="0 0 230 190" role="img" aria-label="Overall attendance gauge">
      ${bands}${tick}
      <g class="gauge-needle" id="gaugeNeedle" style="transform: rotate(${angle}deg)">
        <line x1="115" y1="118" x2="115" y2="34" stroke="${riskColor}" stroke-width="4" stroke-linecap="round"/>
        <circle cx="115" cy="118" r="8" fill="${riskColor}"/>
        <circle cx="115" cy="118" r="3.5" fill="var(--bg)"/>
      </g>
    </svg>
    <div class="gauge-readout">
      <div class="gauge-pct" id="gaugePct" style="color:${riskColor}">${overallPct.toFixed(1)}%</div>
      <div class="gauge-word" style="color:${riskColor}">${word}</div>
    </div>`;
  return { html, angle };
}

// lightweight confetti burst (self-contained, removes itself)
function fireConfetti() {
  const cv = document.createElement('canvas');
  cv.className = 'confetti-canvas';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight;
  const colors = ['#6c8cff', '#9d6cff', '#34d399', '#fbbf24', '#f87171', '#ffffff'];
  const parts = Array.from({ length: 150 }, (_, i) => ({
    x: Math.random() * cv.width,
    y: -20 - Math.random() * cv.height * 0.4,
    vx: (Math.random() - 0.5) * 6,
    vy: 2 + Math.random() * 4,
    s: 4 + Math.random() * 5,
    c: colors[i % colors.length],
    rot: Math.random() * 6.28,
    vr: (Math.random() - 0.5) * 0.3,
  }));
  let frame = 0; const max = 140;
  (function loop() {
    frame++;
    ctx.clearRect(0, 0, cv.width, cv.height);
    parts.forEach((p) => {
      p.vy += 0.12; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - frame / max);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 1.5);
      ctx.restore();
    });
    if (frame < max) requestAnimationFrame(loop);
    else cv.remove();
  })();
}

/* ---------------- Results ---------------- */

const shareBar = $('shareBar');
const shareBtn = $('shareBtn');
const downloadBtn = $('downloadBtn');
const startOverBtn = $('startOverBtn');
let lastVerdict = null;
let suppressEffects = false; // true while auto-restoring on load

calcBtn.addEventListener('click', calculate);

function readRows() {
  const rows = [];
  let autoIdx = 1;
  subjectBody.querySelectorAll('tr').forEach((tr) => {
    const subjInput = tr.querySelector('.subj');
    const aInput = tr.querySelector('.attended');
    const dInput = tr.querySelector('.dl');
    const tInput = tr.querySelector('.total');
    const { ah, dl, th } = rowValues(tr);
    [aInput, dInput, tInput].forEach((i) => i.classList.remove('invalid'));

    const empty = [subjInput, aInput, dInput, tInput].every((i) => i.value.trim() === '');
    if (empty) return;

    const a = ah + dl;
    if (isNaN(ah) || isNaN(th) || th <= 0 || ah < 0 || dl < 0 || a > th) {
      if (isNaN(ah) || ah < 0 || a > th) aInput.classList.add('invalid');
      if (dl < 0 || a > th) dInput.classList.add('invalid');
      if (isNaN(th) || th <= 0) tInput.classList.add('invalid');
      rows.push(null); // marks invalid
      return;
    }
    rows.push({
      subject: subjInput.value.trim() || `Course ${autoIdx++}`,
      ah, dl, th, attended: a,
    });
  });
  return rows;
}

function calculate() {
  const rows = readRows();
  if (rows.some((r) => r === null)) {
    tableHint.textContent = '⚠️ Fix the highlighted numbers first (AH + DL can’t exceed TH).';
    return;
  }
  const valid = rows.filter(Boolean);
  if (valid.length === 0) {
    tableHint.textContent = '⚠️ Add at least one course with attended and total hours.';
    return;
  }

  const target = getTarget();
  const p = target / 100;

  /* --- overall summary --- */
  const sumA = valid.reduce((s, r) => s + r.attended, 0);
  const sumT = valid.reduce((s, r) => s + r.th, 0);
  const overallPct = (sumA / sumT) * 100;
  const below = valid.filter((r) => (r.attended / r.th) * 100 < target);

  const allSafe = below.length === 0;
  const ringColor = allSafe ? 'var(--good)' : overallPct >= target ? 'var(--warn)' : 'var(--bad)';
  const word = allSafe ? 'SAFE ZONE' : overallPct >= target ? 'ON EDGE' : 'DANGER ZONE';

  let headline, sub;
  if (allSafe) {
    headline = 'You’re safe — bunk responsibly 😎';
    sub = `All ${valid.length} course${valid.length > 1 ? 's are' : ' is'} at or above ${target}% (duty leave included). The cards below show how many hours you can miss in each before dropping under the line.`;
  } else {
    headline = `${below.length} course${below.length > 1 ? 's' : ''} below ${target}% 🚨`;
    sub = `No bunking in: ${below.map((r) => r.subject).join(', ')}. The cards below show exactly how many consecutive hours you must attend to climb back over ${target}%.`;
  }

  const gauge = buildGauge(overallPct, target, ringColor, word);
  overallCard.innerHTML = `
    <div class="gauge">${gauge.html}</div>
    <div class="overall-info">
      <h2>${headline}</h2>
      <p>${sub}</p>
    </div>
  `;
  // count-up the gauge number when the tab is visible (cosmetic only —
  // the resting value is already painted by buildGauge)
  requestAnimationFrame(() => {
    const pctEl = document.getElementById('gaugePct');
    if (pctEl) countUp(pctEl, overallPct);
  });

  /* --- per-course cards --- */
  resultsGrid.innerHTML = '';
  const verdictCourses = [];
  valid.forEach((r, i) => {
    const pct = (r.attended / r.th) * 100;
    const card = document.createElement('div');
    let cls, verdict, meta, action;
    const dlNote = r.dl > 0 ? ` (${r.ah} AH + ${r.dl} DL)` : '';

    if (pct >= target) {
      const bunk = classesBunkable(r.attended, r.th, p);
      if (bunk === 0) {
        cls = 'edge'; action = 'on the edge';
        verdict = `⚠️ Right on the edge — <strong>don’t miss</strong> the next hour.`;
        meta = `Missing even 1 hour drops you below ${target}%.`;
      } else {
        cls = 'safe'; action = `bunk ${bunk}h`;
        verdict = `😎 You can bunk <strong>${bunk}</strong> ${bunk === 1 ? 'hour' : 'hours'} and stay above ${target}%.`;
        meta = `After bunking ${bunk}: ${r.attended}/${r.th + bunk} = ${((r.attended / (r.th + bunk)) * 100).toFixed(1)}%`;
      }
    } else {
      const need = classesNeeded(r.attended, r.th, p);
      cls = 'danger'; action = `attend ${need}h`;
      verdict = `📚 Attend the next <strong>${need}</strong> ${need === 1 ? 'hour' : 'hours'} to reach ${target}%.`;
      meta = `After attending ${need}: ${r.attended + need}/${r.th + need} = ${(((r.attended + need) / (r.th + need)) * 100).toFixed(1)}%`;
    }

    verdictCourses.push({ subject: r.subject, pct, status: cls, action });

    card.className = `result-card ${cls}`;
    card.style.setProperty('--i', i);
    card.innerHTML = `
      <div class="rc-head">
        <span class="rc-subject">${escapeAttr(r.subject)}</span>
        <span class="rc-pct">${pct.toFixed(1)}%</span>
      </div>
      <div class="rc-meter">
        <div class="fill" style="width:${Math.min(pct, 100)}%"></div>
        <div class="target-line" style="left:${target}%"></div>
      </div>
      <div class="rc-verdict">${verdict}</div>
      <div class="rc-meta">Attended ${r.attended}${dlNote} of ${r.th} · ${meta}</div>
    `;
    resultsGrid.appendChild(card);
    requestAnimationFrame(() => countUp(card.querySelector('.rc-pct'), pct, { dur: 700 }));
  });

  /* --- comparison bar chart (riskiest first) --- */
  buildChart(verdictCourses, target);

  /* --- stash for sharing + persist --- */
  lastVerdict = { overallPct, target, headline, allSafe, courses: verdictCourses };
  saveState();

  shareBar.hidden = false;
  resultsSection.hidden = false;
  if (!suppressEffects) resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (allSafe && !suppressEffects) fireConfetti();
}

/* ---------------- Comparison chart ---------------- */

const chartCard = $('chartCard');
const chartEl = $('chart');
const chartTargetLabel = $('chartTargetLabel');

function buildChart(courses, target) {
  chartTargetLabel.textContent = target + '%';
  const sorted = [...courses].sort((a, b) => a.pct - b.pct);
  chartEl.innerHTML = sorted
    .map((c, i) => `
      <div class="chart-row" style="--i:${i}">
        <span class="chart-label" title="${escapeAttr(c.subject)}">${escapeAttr(c.subject)}</span>
        <div class="chart-track">
          <div class="chart-fill ${c.status}" style="width:${Math.min(c.pct, 100)}%"></div>
          <div class="chart-target" style="left:${target}%"></div>
        </div>
        <span class="chart-val ${c.status}">${c.pct.toFixed(1)}%</span>
      </div>`)
    .join('');
  chartCard.hidden = false;
}

/* ---------------- Shareable verdict image ---------------- */

const PALETTE = {
  bg0: '#0b0e14', bg1: '#141a28', card: '#151a26', edge: '#232b3d',
  text: '#e8ecf4', dim: '#94a0b8', accent: '#6c8cff', accent2: '#9d6cff',
  good: '#34d399', warn: '#fbbf24', bad: '#f87171',
};
const STATUS_COLOR = { safe: PALETTE.good, edge: PALETTE.warn, danger: PALETTE.bad };

async function drawVerdictCard(v) {
  try { await document.fonts.ready; } catch (e) { /* fonts optional */ }
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, PALETTE.bg0); bg.addColorStop(1, PALETTE.bg1);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.2, 120, 0, W * 0.2, 120, W);
  glow.addColorStop(0, 'rgba(108,140,255,0.20)'); glow.addColorStop(1, 'rgba(108,140,255,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  const PAD = 80;
  // header
  ctx.textBaseline = 'alphabetic';
  ctx.font = '800 52px Sora, sans-serif';
  ctx.fillStyle = PALETTE.text;
  ctx.fillText('🎓 Bunk', PAD, 110);
  const bunkW = ctx.measureText('🎓 Bunk').width;
  ctx.fillStyle = PALETTE.accent;
  ctx.fillText('Buddy', PAD + bunkW, 110);
  ctx.font = '600 30px Inter, sans-serif';
  ctx.fillStyle = PALETTE.dim;
  ctx.textAlign = 'right';
  ctx.fillText('@4wsjad', W - PAD, 104);
  ctx.textAlign = 'left';

  // overall ring
  const color = v.allSafe ? PALETTE.good : v.overallPct >= v.target ? PALETTE.warn : PALETTE.bad;
  const cx = W / 2, cy = 420, R = 166;
  ctx.lineWidth = 24; ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.edge;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + (Math.min(v.overallPct, 100) / 100) * Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.font = '800 84px Sora, sans-serif';
  ctx.fillText(v.overallPct.toFixed(1) + '%', cx, cy + 18);
  ctx.font = '700 26px Sora, sans-serif';
  ctx.fillStyle = PALETTE.dim;
  ctx.fillText('OVERALL · TARGET ' + v.target + '%', cx, cy + 64);

  // headline
  ctx.font = '700 40px Sora, sans-serif';
  ctx.fillStyle = PALETTE.text;
  const dangerCount = v.courses.filter((x) => x.status === 'danger').length;
  const headline = v.allSafe
    ? 'All clear — bunk responsibly 😎'
    : `${dangerCount} course${dangerCount === 1 ? '' : 's'} below ${v.target}% 🚨`;
  ctx.fillText(headline, cx, 660);
  ctx.textAlign = 'left';

  // course rows
  const rows = v.courses.slice(0, 9);
  let y = 730;
  const rowH = Math.min(62, (H - 180 - y) / Math.max(rows.length, 1));
  ctx.font = '600 30px Inter, sans-serif';
  rows.forEach((co) => {
    const sc = STATUS_COLOR[co.status];
    ctx.fillStyle = sc;
    ctx.beginPath(); ctx.arc(PAD + 12, y - 9, 11, 0, Math.PI * 2); ctx.fill();
    // name (truncate)
    ctx.fillStyle = PALETTE.text;
    let name = co.subject;
    const maxNameW = W - PAD * 2 - 360;
    while (ctx.measureText(name).width > maxNameW && name.length > 4) name = name.slice(0, -2);
    if (name !== co.subject) name += '…';
    ctx.fillText(name, PAD + 40, y);
    // pct + action right-aligned
    ctx.textAlign = 'right';
    ctx.fillStyle = sc;
    ctx.font = '700 30px Sora, sans-serif';
    ctx.fillText(`${co.pct.toFixed(1)}%  ·  ${co.action}`, W - PAD, y);
    ctx.font = '600 30px Inter, sans-serif';
    ctx.textAlign = 'left';
    y += rowH;
  });

  // footer
  ctx.textAlign = 'center';
  ctx.font = '500 24px Inter, sans-serif';
  ctx.fillStyle = PALETTE.dim;
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  ctx.fillText(`Calculated ${date} · effective attendance includes duty leave`, cx, H - 96);
  ctx.font = '600 26px Sora, sans-serif';
  ctx.fillStyle = PALETTE.accent;
  ctx.fillText('Can I bunk today?  ·  bunk buddy', cx, H - 56);
  ctx.textAlign = 'left';

  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

async function shareOrDownload(mode) {
  if (!lastVerdict) return;
  const blob = await drawVerdictCard(lastVerdict);
  const file = new File([blob], 'bunk-buddy-verdict.png', { type: 'image/png' });

  if (mode === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'My attendance verdict',
        text: `My overall attendance is ${lastVerdict.overallPct.toFixed(1)}% — checked with Bunk Buddy 🎓`,
      });
      return;
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  // download fallback
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'bunk-buddy-verdict.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

shareBtn.addEventListener('click', () => shareOrDownload('share'));
downloadBtn.addEventListener('click', () => shareOrDownload('download'));

/* ---------------- Persistence (localStorage) ---------------- */

const LS_KEY = 'bunkbuddy:v1';

function saveState() {
  const rows = [...subjectBody.querySelectorAll('tr')]
    .map((tr) => ({
      subject: tr.querySelector('.subj').value,
      ah: tr.querySelector('.attended').value,
      dl: tr.querySelector('.dl').value,
      th: tr.querySelector('.total').value,
    }))
    .filter((r) => r.subject || r.ah || r.dl || r.th);
  if (!rows.length) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify({ target: targetInput.value, rows })); } catch (e) { /* private mode */ }
}

function clearState() { try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ } }

function restoreState() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { data = null; }
  if (!data || !Array.isArray(data.rows) || !data.rows.length) return false;
  subjectBody.innerHTML = '';
  data.rows.forEach((r) => addRow(r.subject, r.ah, r.dl, r.th));
  if (data.target) targetInput.value = data.target;
  showTable();
  suppressEffects = true;
  calculate();
  suppressEffects = false;
  tableHint.textContent = '↩️ Restored your last entry — edit anything and recalculate, or hit “Start over”.';
  return true;
}

let saveTimer;
const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 600); };
subjectBody.addEventListener('input', queueSave);
targetInput.addEventListener('input', queueSave);

startOverBtn.addEventListener('click', () => {
  clearState();
  lastVerdict = null;
  subjectBody.innerHTML = '';
  resultsSection.hidden = true;
  shareBar.hidden = true;
  chartCard.hidden = true;
  tableCard.hidden = true;
  notReport.hidden = true;
  previewImg.hidden = true;
  previewImg.removeAttribute('src');
  dzInner.hidden = false;
  changeImageBtn.hidden = true;
  fileInput.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ---------------- Fun facts ---------------- */

const FUN_FACTS = [
  'If you have exactly 75% attendance, missing just one class means you need to attend THREE in a row to get back to 75%. The math is brutal: it\'s always 3 classes attended per class bunked.',
  'At 75%, your attendance drops faster than it climbs — going from 76% to 74% can take a single missed day, but climbing back can take a whole week.',
  'A student with 80% attendance in a 60-hour course can bunk 4 hours. A student with 90% can bunk 12. Those 6 percentage points triple your freedom.',
  'The word "bunk" meaning to skip class comes from "bunk off", British slang dating back to the 1870s — students have been doing this for at least 150 years.',
  'If your attendance is 74.5%, most colleges round DOWN, not up. That 0.5% has ended more movie plans than any strict professor.',
  'Duty leave (DL) is the only attendance you earn while having fun at a fest. Volunteer wisely — it counts toward your percentage just like sitting in class.',
  'Students who track their attendance bunk more efficiently — they skip when it\'s safe and show up when it counts. You\'re literally doing that right now.',
  'In a typical 5-day college week, one "safe bunk day" costs about 6-7 hours across subjects. Spread your bunks across different subjects instead — same rest, less risk.',
  'A 100% attendance student and a 76% attendance student get the same hall ticket. Efficiency is a virtue.',
  'If every subject sits at exactly 75%, your "bunkable hours" are zero across the board — the scariest dashboard a student can see. Keep a 2-3 hour buffer per subject.',
  'Bunking the class right before an internal exam is statistically the worst bunk possible — that\'s usually when professors reveal what\'s coming. Bunk the week after instead.',
  'Your attendance percentage can never recover to 100% after a single bunk. Perfection is fragile; 80% is sustainable. Choose sustainability.',
  'Labs are attendance gold: usually 2-3 hours credited for one session. Missing one lab can hurt more than missing three lectures.',
  'The longer the semester runs, the less each class moves your percentage. A bunk in week 2 swings your attendance several percent — the same bunk in week 14 barely moves it.',
  'Reverse-engineering works: with a 60-hour course, you can compute your entire semester\'s "bunk budget" on day one — it\'s 15 hours at the 75% rule. Spend it like pocket money.',
  'Friendship math: if your friend has 85% and you have 74%, you are not "basically the same". They can bunk 8 classes. You can bunk none. Different species entirely.',
  'A 9 AM class with 75% attendance needed is the universe\'s way of testing your character. The universe usually wins.',
  'Condonation (the mercy pass for 65-74%) often costs a fee and a medical certificate. A planned bunk is free. Plan accordingly.',
  'If you attend everything for the first month of a semester, you bank enough buffer to survive almost any emergency, fest, or "emergency fest" later.',
  'The fastest attendance climb is mathematically right after a holiday week — classes resume, totals rise slowly, and every hour you attend punches above its weight.',
];

const funFactText = $('funFactText');
const newFactBtn = $('newFactBtn');
let lastFactIdx = -1;

function showFunFact() {
  let idx;
  do { idx = Math.floor(Math.random() * FUN_FACTS.length); } while (idx === lastFactIdx);
  lastFactIdx = idx;
  funFactText.style.animation = 'none';
  void funFactText.offsetWidth; // restart the entry animation
  funFactText.style.animation = '';
  funFactText.textContent = FUN_FACTS[idx];
}

newFactBtn.addEventListener('click', showFunFact);
showFunFact();

/* ---------------- PWA: install + offline ---------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed:', err));
  });
}

const installBtn = $('installBtn');
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
  deferredInstallPrompt = null;
});

/* ---------------- Restore last session ---------------- */
restoreState();
