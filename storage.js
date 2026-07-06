"use strict";

/* SparkStore — persistence layer.
 * Today: localStorage. This is the seam real-time collaboration plugs into
 * later (same save/load/list/remove surface, different backend).
 * All access is wrapped so a blocked/unavailable localStorage degrades to a
 * no-op instead of throwing (file:// origins, sandboxed frames, etc.). */
window.SparkStore = (() => {
  const PREFIX = "spark.project.";
  const INDEX = "spark.index";

  const get = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } };
  const del = (k) => { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } };

  function readIndex() {
    try { return JSON.parse(get(INDEX) || "[]"); } catch (_) { return []; }
  }
  function writeIndex(idx) { set(INDEX, JSON.stringify(idx)); }

  /** Save a project and update the index (most-recent first). */
  function save(project) {
    if (!project || !project.id) return;
    project.updatedAt = Date.now();
    set(PREFIX + project.id, JSON.stringify(project));
    const idx = readIndex().filter((e) => e.id !== project.id);
    idx.unshift({
      id: project.id,
      name: project.projectName || "Untitled project",
      updatedAt: project.updatedAt,
    });
    writeIndex(idx);
  }

  /** Load one project by id, or null. */
  function load(id) {
    const raw = get(PREFIX + id);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  /** Index entries [{id, name, updatedAt}], most recent first. */
  function list() { return readIndex(); }

  /** Delete a project and its index entry. */
  function remove(id) {
    del(PREFIX + id);
    writeIndex(readIndex().filter((e) => e.id !== id));
  }

  /** Persist without bumping updatedAt — for UI-only state like collapse. */
  function saveQuiet(project) {
    if (!project || !project.id) return;
    set(PREFIX + project.id, JSON.stringify(project));
    const idx = readIndex();
    const e = idx.find((x) => x.id === project.id);
    if (e) { e.name = project.projectName || e.name; writeIndex(idx); }
    else { save(project); }
  }

  /** The most recently updated project, or null. */
  function latest() {
    const idx = readIndex();
    return idx.length ? load(idx[0].id) : null;
  }

  return { save, saveQuiet, load, list, remove, latest };
})();
