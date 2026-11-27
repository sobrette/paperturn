import * as pdfjs from '../vendor/pdf.min.mjs';
import * as db from './db.js';
import { Flipbook } from './flipbook.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
};

const $ = s => document.querySelector(s);
const SAMPLE = { id: 'sample', title: 'The Paperturn Companion', sample: true, pageCount: 12, url: 'sample.pdf' };

const PALETTE = [
  { bg: '#2f5d46', ink: '#f3ead6', band: '#c8962e' }, // forest
  { bg: '#7a2e2a', ink: '#f3e4cf', band: '#d9b36a' }, // oxblood
  { bg: '#c8962e', ink: '#2a2017', band: '#7a2e2a' }, // mustard
  { bg: '#2b3f5c', ink: '#efe6d2', band: '#c8962e' }, // navy
  { bg: '#b5603a', ink: '#fbefdf', band: '#2a2622' }, // terracotta
  { bg: '#2f6f6a', ink: '#f1e8d4', band: '#e6d6b0' }, // teal
  { bg: '#5b3a55', ink: '#f2e5d8', band: '#d7a85a' }, // plum
  { bg: '#e6d6b0', ink: '#2f3b2f', band: '#2f5d46' }, // cream
  { bg: '#4a5560', ink: '#efe9dc', band: '#b5603a' }, // slate
  { bg: '#8c4a2f', ink: '#f6e9d6', band: '#e6d6b0' }, // rust
  { bg: '#3f4a2c', ink: '#efe5c9', band: '#c8962e' }, // olive
];
const SPINE_STYLES = ['bands', 'block', 'rule', 'dots'];

let books = [];
let current = null; // { meta, pdf, flip }
let reducedMotion = readMotionPref();

// ---------------------------------------------------------------- helpers
function seed(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822519) ^ Math.imul(h ^ (h >>> 13), 3266489917)) >>> 0) / 4294967296;
}
function spineLook(book) {
  const r = seed(book.id);
  const pal = book.sample ? PALETTE[0] : PALETTE[Math.floor(r() * PALETTE.length)];
  const pages = book.pageCount || 20;
  return {
    ...pal,
    height: 0.74 + r() * 0.22,
    width: Math.round(Math.min(68, Math.max(34, 26 + Math.sqrt(pages) * 4.2 + r() * 6))),
    style: book.sample ? 'bands' : SPINE_STYLES[Math.floor(r() * SPINE_STYLES.length)],
  };
}
function titleFromFile(name) {
  return (name || 'Untitled').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
}
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, 3200);
}
function readMotionPref() {
  try {
    const v = localStorage.getItem('paperturn.reducedMotion');
    if (v !== null) return v === '1';
  } catch {}
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------- shelf
async function loadShelf() {
  try {
    books = (await db.listBooks()).sort((a, b) => a.addedAt - b.addedAt);
  } catch (err) {
    console.error(err);
    books = [];
    toast('Your browser blocked local storage, so books won’t be saved.', 'warn');
  }
  renderShelf();
}

function shelfItems() { return [SAMPLE, ...books]; }

function makeSpine(book) {
  const look = spineLook(book);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `spine spine-${look.style}`;
  b.setAttribute('role', 'listitem');
  b.dataset.id = book.id;
  b.style.setProperty('--bg', look.bg);
  b.style.setProperty('--ink', look.ink);
  b.style.setProperty('--band', look.band);
  b.style.setProperty('--h', look.height);
  b.style.width = look.width + 'px';
  const pages = book.pageCount ? `${book.pageCount} pages` : '';
  b.setAttribute('aria-label', `Open ${book.title}${book.sample ? ' (sample)' : ''}${pages ? ', ' + pages : ''}`);
  b.title = book.title;
  b.innerHTML = `<span class="spine-top"></span><span class="spine-title"></span><span class="spine-foot">${book.sample ? 'Sample' : (book.pageCount || '')}</span>`;
  b.querySelector('.spine-title').textContent = book.title;
  b.addEventListener('click', () => openBook(book.id));
  b._w = look.width;
  return b;
}

function makeAddSpine() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'spine spine-add';
  b.setAttribute('role', 'listitem');
  b.setAttribute('aria-label', 'Add a PDF to the shelf');
  b.innerHTML = '<span class="plus" aria-hidden="true">+</span><span class="spine-title">Add PDF</span>';
  b.addEventListener('click', () => $('#file-input').click());
  b._w = 46;
  return b;
}

let lastShelfWidth = 0;
function renderShelf() {
  const host = $('#shelves');
  const width = host.clientWidth - 2 * parseFloat(getComputedStyle(host).paddingLeft || 0);
  lastShelfWidth = host.clientWidth;
  const inner = Math.max(200, width - 24);
  const items = [...shelfItems().map(makeSpine), makeAddSpine()];
  const rows = [[]];
  let used = 0;
  const gap = 3;
  for (const it of items) {
    if (used + it._w > inner && rows[rows.length - 1].length) { rows.push([]); used = 0; }
    rows[rows.length - 1].push(it);
    used += it._w + gap;
  }
  const minRows = window.innerWidth < 600 ? 2 : 3;
  while (rows.length < minRows) rows.push([]);
  host.innerHTML = '';
  rows.forEach((row, i) => {
    const shelf = document.createElement('div');
    shelf.className = 'shelf';
    const booksEl = document.createElement('div');
    booksEl.className = 'shelf-books';
    row.forEach(b => booksEl.appendChild(b));
    // decoration: bookend after the last book, or a plant on an empty shelf
    if (row.length && i === rows.findLastIndex(r => r.length)) {
      const end = document.createElement('span');
      end.className = 'bookend';
      end.setAttribute('aria-hidden', 'true');
      booksEl.appendChild(end);
    }
    if (!row.length && i === rows.length - 1) {
      booksEl.insertAdjacentHTML('beforeend', `<svg class="plant" viewBox="0 0 80 110" aria-hidden="true">
        <path d="M40 70 C30 50 14 46 8 30 C24 32 36 44 40 62 Z" fill="#3f7a55"/>
        <path d="M40 70 C48 44 64 38 74 22 C60 22 46 38 40 60 Z" fill="#2f5d46"/>
        <path d="M40 72 C38 46 40 26 44 8 C50 30 46 50 41 72 Z" fill="#4f8a60"/>
        <path d="M22 70 h36 l-5 36 h-26 z" fill="#b5603a"/><rect x="19" y="66" width="42" height="8" rx="2" fill="#9c4f2f"/></svg>
        <span class="shelf-note">Room for more</span>`);
    }
    const board = document.createElement('div');
    board.className = 'shelf-board';
    board.setAttribute('aria-hidden', 'true');
    shelf.append(booksEl, board);
    host.appendChild(shelf);
  });
  fitSpineTitles(host);
  const n = books.length;
  $('#shelf-count').textContent = n ? `${n} book${n === 1 ? '' : 's'} + sample` : 'Just the sample, for now';
}

function fitSpineTitles(root) {
  // shrink long titles a little before falling back to an ellipsis
  root.querySelectorAll('.spine:not(.spine-add) .spine-title').forEach(el => {
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollHeight > el.clientHeight + 1 && fs > 11.5) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
  });
}

window.addEventListener('resize', () => {
  if (Math.abs($('#shelves').clientWidth - lastShelfWidth) > 4) renderShelf();
});

// ---------------------------------------------------------------- adding
async function addFiles(fileList) {
  const files = [...fileList].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) { toast('That doesn’t look like a PDF.', 'warn'); return; }
  let toOpen = null;
  const added = [];
  const quiet = files.length > 1;
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
      if (!String.fromCharCode(...head).includes('%PDF')) { toast(`“${file.name}” isn’t a valid PDF.`, 'warn'); continue; }
      const id = await db.hashBytes(buf);
      const existing = books.find(b => b.id === id);
      if (existing) {
        if (!quiet) toast(`“${existing.title}” is already on your shelf.`);
        toOpen = { id, buf };
        continue;
      }
      // read the page count so the spine can reflect the book's thickness
      let pageCount = 0;
      const pdf = await pdfjs.getDocument({ ...PDF_OPTS, data: new Uint8Array(buf.slice(0)) }).promise;
      pageCount = pdf.numPages;
      const meta = { id, title: titleFromFile(file.name), fileName: file.name, size: file.size, pageCount, addedAt: Date.now(), lastPage: 1 };
      try {
        await db.putBook(meta, buf);
      } catch (err) {
        console.error(err);
        toast(err && err.name === 'QuotaExceededError' ? 'Not enough storage space to keep this PDF.' : 'Couldn’t save this PDF to the shelf.', 'warn');
      }
      books.push(meta);
      toOpen = { id, buf, pdf };
      added.push(meta.title);
      if (!quiet) toast(`Shelved “${meta.title}”.`);
    } catch (err) {
      console.error(err);
      toast(`Couldn’t open “${file.name}”.`, 'warn');
    }
  }
  if (quiet && added.length) toast(`Shelved ${added.length} PDF${added.length === 1 ? '' : 's'}.`);
  else if (quiet && toOpen) toast('Those PDFs are already on your shelf.');
  renderShelf();
  if (toOpen) openBook(toOpen.id, toOpen);
}

$('#add-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', e => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ''; });

// drag & drop anywhere
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; });
window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------- reader
function makeRenderer(pdf) {
  let chain = Promise.resolve();
  return (n, w, h) => {
    // render one page at a time to keep the main thread responsive
    const job = chain.then(async () => {
      const page = await pdf.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(w / vp1.width, h / vp1.height);
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return c;
    });
    chain = job.catch(() => {});
    return job;
  };
}

async function openBook(id, preload) {
  const isSample = id === SAMPLE.id;
  const meta = isSample ? SAMPLE : books.find(b => b.id === id);
  if (!meta) return;
  if (current && current.meta.id === id) { showReader(); return; }
  closeBook(false);
  current = { meta };
  showReader();
  $('#reader-title').textContent = meta.title;
  $('#reader-loading').hidden = false;
  $('#more-btn').hidden = isSample;
  try {
    let pdf = preload && preload.pdf;
    if (!pdf) {
      let data = preload && preload.buf;
      if (!data) data = isSample ? await (await fetch(SAMPLE.url)).arrayBuffer() : await db.getFile(id);
      if (!data) throw new Error('File missing from storage');
      pdf = await pdfjs.getDocument({ ...PDF_OPTS, data: new Uint8Array(data.slice(0)) }).promise;
    }
    if (current?.meta !== meta) { pdf.destroy(); return; }
    const page1 = await pdf.getPage(1);
    const vp = page1.getViewport({ scale: 1 });
    $('#reader-loading').hidden = true;
    const stage = $('#reader-stage');
    const host = document.createElement('div');
    host.className = 'fb-host';
    stage.appendChild(host);
    const range = $('#page-range');
    range.max = pdf.numPages;
    const flip = new Flipbook(host, {
      pageCount: pdf.numPages,
      aspect: vp.width / vp.height,
      startPage: meta.lastPage || 1,
      reducedMotion,
      renderPage: makeRenderer(pdf),
      onChange: s => onPageChange(s),
    });
    current.pdf = pdf;
    current.flip = flip;
    if (!isSample && meta.pageCount !== pdf.numPages) { meta.pageCount = pdf.numPages; db.updateBook(id, { pageCount: pdf.numPages }).catch(() => {}); }
    if (!isSample) db.updateBook(id, { lastOpened: Date.now() }).catch(() => {});
  } catch (err) {
    console.error(err);
    $('#reader-loading').hidden = true;
    toast('Sorry, this PDF couldn’t be opened.', 'warn');
    closeBook();
  }
}

let saveTimer = null;
function onPageChange(s) {
  const label = s.pages.length > 1 ? `${s.first}–${s.last}` : `${s.first}`;
  $('#page-label').innerHTML = `<span class="pg">${label}</span> <span class="of">of ${s.total}</span>`;
  $('#page-range').value = s.first;
  $('#page-range').style.setProperty('--fill', ((s.first - 1) / Math.max(1, s.total - 1)) * 100 + '%');
  $('#prev-btn').disabled = !s.canPrev;
  $('#next-btn').disabled = !s.canNext;
  if (current && !current.meta.sample) {
    current.meta.lastPage = s.first;
    clearTimeout(saveTimer);
    const id = current.meta.id, pg = s.first;
    saveTimer = setTimeout(() => db.updateBook(id, { lastPage: pg }).catch(() => {}), 400);
  }
}

function showReader() {
  $('#shelf-view').hidden = true;
  $('#reader-view').hidden = false;
  document.body.classList.add('reading');
  if (!history.state || !history.state.reader) history.pushState({ reader: true }, '');
  requestAnimationFrame(() => $('#reader-stage').focus({ preventScroll: true }));
}

function closeBook(toShelf = true) {
  if (current) {
    current.flip && current.flip.destroy();
    current.pdf && current.pdf.destroy();
    $('#reader-stage').querySelectorAll('.fb-host').forEach(n => n.remove());
    const id = current.meta.id;
    current = null;
    if (toShelf) {
      $('#reader-view').hidden = true;
      $('#shelf-view').hidden = false;
      document.body.classList.remove('reading');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      renderShelf();
      const spine = document.querySelector(`.spine[data-id="${CSS.escape(id)}"]`);
      spine && spine.focus({ preventScroll: false });
    }
  } else if (toShelf) {
    $('#reader-view').hidden = true;
    $('#shelf-view').hidden = false;
    document.body.classList.remove('reading');
  }
}

function backToShelf() {
  if (history.state && history.state.reader) history.back();
  else closeBook();
}
window.addEventListener('popstate', () => { if (current || !$('#reader-view').hidden) closeBook(); });

$('#back-btn').addEventListener('click', backToShelf);
$('#prev-btn').addEventListener('click', () => current?.flip?.prev());
$('#next-btn').addEventListener('click', () => current?.flip?.next());
$('#page-range').addEventListener('input', e => current?.flip?.goTo(+e.target.value));

// motion
function applyMotion() {
  $('#motion-btn').setAttribute('aria-pressed', String(reducedMotion));
  $('#motion-btn').title = reducedMotion ? 'Reduced motion is on' : 'Reduce motion';
  document.documentElement.classList.toggle('reduce-motion', reducedMotion);
  current?.flip?.setReducedMotion(reducedMotion);
}
$('#motion-btn').addEventListener('click', () => {
  reducedMotion = !reducedMotion;
  try { localStorage.setItem('paperturn.reducedMotion', reducedMotion ? '1' : '0'); } catch {}
  applyMotion();
  toast(reducedMotion ? 'Reduced motion on: pages fade instead of turning.' : 'Page turns are animated.');
});
applyMotion();

// fullscreen
const fsSupported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
if (!fsSupported) $('#fs-btn').hidden = true;
function toggleFullscreen() {
  if (!fsSupported) return;
  const el = $('#reader-view');
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (el.requestFullscreen || el.webkitRequestFullscreen).call(el).catch?.(() => {});
}
$('#fs-btn').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement));

// menu
const menu = $('#more-menu');
function setMenu(open) {
  menu.hidden = !open;
  $('#more-btn').setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('button').focus();
}
$('#more-btn').addEventListener('click', e => { e.stopPropagation(); setMenu(menu.hidden); });
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });

function ask({ title, text = '', field = null, ok = 'Save', danger = false }) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-text').textContent = text;
  $('#dialog-text').hidden = !text;
  $('#dialog-field').hidden = field === null;
  $('#dialog-input').value = field ?? '';
  $('#dialog-ok').textContent = ok;
  $('#dialog-ok').classList.toggle('btn-danger', danger);
  dlg.returnValue = '';
  dlg.showModal();
  if (field !== null) { $('#dialog-input').focus(); $('#dialog-input').select(); }
  return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok' ? (field !== null ? $('#dialog-input').value : true) : null), { once: true }));
}

$('#rename-btn').addEventListener('click', async () => {
  setMenu(false);
  if (!current || current.meta.sample) return;
  const val = await ask({ title: 'Rename book', field: current.meta.title, ok: 'Save' });
  if (val === null) return;
  const title = val.trim() || titleFromFile(current.meta.fileName);
  current.meta.title = title;
  $('#reader-title').textContent = title;
  await db.updateBook(current.meta.id, { title }).catch(() => toast('Couldn’t save the new title.', 'warn'));
});
$('#remove-btn').addEventListener('click', async () => {
  setMenu(false);
  if (!current || current.meta.sample) return;
  const meta = current.meta;
  const ok = await ask({ title: 'Remove from shelf?', text: `“${meta.title}” will be deleted from this device. The original file isn’t affected.`, ok: 'Remove', danger: true });
  if (!ok) return;
  await db.deleteBook(meta.id).catch(() => {});
  books = books.filter(b => b.id !== meta.id);
  backToShelf();
  toast(`Removed “${meta.title}”.`);
});

// keyboard
document.addEventListener('keydown', e => {
  if (!current || !current.flip || $('#reader-view').hidden) return;
  if ($('#dialog').open || e.target.closest?.('input[type=text], .menu')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const f = current.flip;
  const onRange = e.target.id === 'page-range';
  switch (e.key) {
    case 'ArrowRight': case 'PageDown': if (onRange) return; e.preventDefault(); f.next(); break;
    case 'ArrowLeft': case 'PageUp': if (onRange) return; e.preventDefault(); f.prev(); break;
    case ' ': if (e.target.closest('button')) return; e.preventDefault(); e.shiftKey ? f.prev() : f.next(); break;
    case 'Home': if (onRange) return; e.preventDefault(); f.goTo(1); break;
    case 'End': if (onRange) return; e.preventDefault(); f.goTo(f.n); break;
    case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break;
    case 'Escape':
      if (!menu.hidden) { setMenu(false); $('#more-btn').focus(); break; }
      if (!document.fullscreenElement) backToShelf();
      break;
  }
});

// ---------------------------------------------------------------- boot
if (history.state && history.state.reader) history.replaceState(null, '');
loadShelf();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
