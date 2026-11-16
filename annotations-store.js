'use strict';
// Plan Printer — annotation "sidecar" storage (main process only).
// A document's notes live in a small JSON file right beside it:
//   plan.md  ->  plan.md.annotations.json
// main.js decides which document is open; this module only derives the sidecar
// path from that and reads and writes the one file, defensively. It never
// touches the Markdown document itself.

const fs = require('node:fs');
const path = require('node:path');

const FORMAT = 'plan-printer-annotations';
const VERSION = 1;

const DOC_EXT = new Set(['.md', '.markdown', '.txt']);
const MAX_BYTES = 5 * 1024 * 1024; // a notes file is never this big
const MAX_ANNOTATIONS = 5000;

const errorText = (err) => String(err && err.message ? err.message : err);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// plan.md -> plan.md.annotations.json, always beside the document.
// Keeping ".md" in the name stops plan.md and plan.txt colliding.
function sidecarPath(docPath) {
  if (typeof docPath !== 'string' || docPath === '') return null;
  const ext = path.extname(docPath).toLowerCase();
  return DOC_EXT.has(ext) ? `${docPath}.annotations.json` : null;
}

// True only for data this version of the app can read and write back safely.
function validateSidecar(data) {
  return isPlainObject(data)
    && data.format === FORMAT
    && Number.isInteger(data.version)
    && data.version >= 1
    && data.version <= VERSION
    && Array.isArray(data.annotations)
    && data.annotations.length <= MAX_ANNOTATIONS;
}

// Never throws. Returns one of:
//   { status: 'none' }               no sidecar for this document
//   { status: 'ok', data }           parsed and valid
//   { status: 'newer', version }     written by a newer version of the app
//   { status: 'corrupt', error }     unreadable, not JSON, or the wrong shape
function readSidecar(docPath) {
  const file = sidecarPath(docPath);
  if (!file) return { status: 'none' };
  let raw;
  try {
    // Checked first so a huge stray file cannot stall the main process.
    if (fs.statSync(file).size > MAX_BYTES) {
      return { status: 'corrupt', error: 'The notes file is larger than 5 MB.' };
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { status: 'none' };
    return { status: 'corrupt', error: errorText(err) };
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, '')); // some editors add a BOM (an invisible first character)
  } catch (err) {
    return { status: 'corrupt', error: `The notes file is not valid JSON (${errorText(err)}).` };
  }
  if (validateSidecar(data)) return { status: 'ok', data };
  if (isPlainObject(data) && data.format === FORMAT
    && Number.isInteger(data.version) && data.version > VERSION) {
    return { status: 'newer', version: data.version };
  }
  return { status: 'corrupt', error: 'The notes file is not in the Plan Printer annotations format.' };
}

// Writes the notes beside the document and returns the sidecar path.
// Throws an Error whose message can be shown to the user as it is.
function writeSidecar(docPath, data) {
  const file = sidecarPath(docPath);
  if (!file) throw new Error('Notes can only be saved beside a .md, .markdown or .txt file.');
  if (!validateSidecar(data)) throw new Error('The notes are not in a format this version of Plan Printer can save.');
  let json;
  try {
    json = JSON.stringify(data, null, 2);
  } catch (err) {
    throw new Error(`The notes could not be turned into JSON (${errorText(err)}).`);
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) {
    throw new Error('The notes are too large to save (over 5 MB).');
  }

  // lstat, not stat: a symlink must be seen as a symlink, not followed.
  let existing = null;
  try {
    existing = fs.lstatSync(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw new Error(`Could not save the notes file: ${errorText(err)}`);
  }
  if (existing) {
    // Checked before anything is moved, so a link or folder is left alone.
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('The notes file beside this document is a link or a folder, not an ordinary file, so it was left unchanged.');
    }
    const current = readSidecar(docPath);
    if (current.status === 'newer') {
      throw new Error('The notes file beside this document was written by a newer version of Plan Printer, so it was left unchanged. Update the app to edit these notes.');
    }
    if (current.status === 'corrupt') {
      // Move the damaged file aside instead of overwriting it: nothing is lost.
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch (err) {
        throw new Error(`The damaged notes file could not be set aside, so nothing was saved: ${errorText(err)}`);
      }
    }
  }

  // Write a temp file, then rename it over the real one. A rename is
  // all-or-nothing, so a crash can never leave half a notes file.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // Left over from an earlier failed attempt by this same process. (A run
    // that crashed mid-write leaves "<file>.<its pid>.tmp" behind instead; that
    // file is harmless and can be deleted by hand.)
    fs.rmSync(tmp, { force: true });
    // 'wx' = create only, so we never write through something planted at tmp.
    fs.writeFileSync(tmp, json, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    throw new Error(`Could not save the notes file: ${errorText(err)}`);
  }
  return file;
}

module.exports = { FORMAT, VERSION, sidecarPath, readSidecar, writeSidecar, validateSidecar };
