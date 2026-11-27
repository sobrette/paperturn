# Paperturn

Turn PDFs into flipbooks and keep them on a personal bookshelf. It's a static app with no build step.

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

- `index.html`, `styles.css`: the shell and visual style
- `js/app.js`: the shelf, adding books (drag & drop / Add PDF), the reader chrome and keyboard controls
- `js/flipbook.js`: the page-curl engine (fold geometry, shadows, drag, snap back or complete)
- `js/db.js`: IndexedDB storage. Each book's id is the SHA-256 hash of its bytes, so the same file is never stored twice.
- `vendor/`: PDF.js 4.10.38 (copied from `pdfjs-dist`)
- `sample.pdf`: the built-in sample book
