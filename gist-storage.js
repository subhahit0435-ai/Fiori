/**
 * gist-storage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared GitHub Gist persistence layer for SAP Fiori Troubleshooter.
 *
 * ARCHITECTURE
 * ┌─────────────┐  admin saves SAP data   ┌───────────────────────┐
 * │  admin.html │ ──────────────────────► │  DATA GIST (private)  │
 * └─────────────┘                         │  sft_data.json        │
 *        │  admin saves audit config      │  sft_config.json      │
 *        └──────────────────────────────► └───────────────────────┘
 *                                                  │ read (raw URL, public)
 *                                    ┌─────────────┴──────────────┐
 *                                    ▼                            ▼
 *                             index.html                  repository.html
 *                          (fetch SAP data)             (fetch audit log)
 *                                    │ append audit entry
 *                                    ▼
 *                         ┌──────────────────────┐
 *                         │  AUDIT GIST (private) │
 *                         │  sft_audit.json       │
 *                         └──────────────────────┘
 *
 * CONFIG STORED IN localStorage (key: sft_gist_config)
 * {
 *   dataGistId:   string  — GitHub Gist ID for SAP data
 *   auditGistId:  string  — GitHub Gist ID for audit log
 *   auditPAT:     string  — GitHub PAT with gist scope (used by end-user to append audit)
 *   adminPAT:     string  — Admin PAT (only stored transiently in admin.html sessionStorage)
 * }
 *
 * SECURITY NOTES
 * • The admin PAT is kept only in sessionStorage (tab-scoped, cleared on close). It is
 *   NEVER written to localStorage or included in any Gist file.
 * • The audit PAT written to config has ONLY the `gist` scope and should be a fine-grained
 *   PAT limited to the two gists. It allows end users to append audit entries.
 * • Gist IDs and the audit PAT are stored in localStorage so they survive page refresh.
 *   Treat the audit PAT as a low-privilege append credential, not a secret.
 * • All data written to Gists is already pruned to minimal columns (no PII beyond user IDs
 *   already present in the SAP exports).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const GistStorage = (() => {
  const CONFIG_KEY  = 'sft_gist_config';
  const API_BASE    = 'https://api.github.com/gists';

  // ── Config helpers ──────────────────────────────────────────────────────────

  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); } catch { return {}; }
  }

  function saveConfig(cfg) {
    // Never persist adminPAT to localStorage
    const safe = Object.assign({}, cfg);
    delete safe.adminPAT;
    localStorage.setItem(CONFIG_KEY, JSON.stringify(safe));
  }

  function getAdminPAT() {
    // Admin PAT lives in sessionStorage only (tab-scoped, not persisted to disk)
    return sessionStorage.getItem('sft_admin_pat') || '';
  }

  function setAdminPAT(pat) {
    sessionStorage.setItem('sft_admin_pat', pat);
  }

  // ── Gist API helpers ────────────────────────────────────────────────────────

  async function fetchGist(gistId, pat) {
    const headers = { 'Accept': 'application/vnd.github+json' };
    if (pat) headers['Authorization'] = 'Bearer ' + pat;
    const resp = await fetch(`${API_BASE}/${gistId}`, { headers });
    if (!resp.ok) throw new Error(`Gist fetch failed: ${resp.status} ${resp.statusText}`);
    return resp.json();
  }

  async function patchGist(gistId, pat, files) {
    // files: { 'filename.json': { content: '...' } }
    if (!pat) throw new Error('No PAT provided. Cannot write to Gist.');
    const resp = await fetch(`${API_BASE}/${gistId}`, {
      method:  'PATCH',
      headers: {
        'Accept':        'application/vnd.github+json',
        'Authorization': 'Bearer ' + pat,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ files })
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Gist write failed: ${resp.status} — ${body}`);
    }
    return resp.json();
  }

  async function createGist(pat, description, files, isPublic = false) {
    if (!pat) throw new Error('No admin PAT. Cannot create Gist.');
    const resp = await fetch(API_BASE, {
      method:  'POST',
      headers: {
        'Accept':        'application/vnd.github+json',
        'Authorization': 'Bearer ' + pat,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ description, public: isPublic, files })
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Gist create failed: ${resp.status} — ${body}`);
    }
    return resp.json();
  }

  // Read a specific file from a Gist by fetching its raw_url (no auth needed for private gists
  // if you have the raw URL, which requires knowing the Gist ID — treated as a capability token)
  async function readGistFile(gistId, fileName, pat) {
    const gist = await fetchGist(gistId, pat);
    const file = gist.files[fileName];
    if (!file) throw new Error(`File "${fileName}" not found in Gist ${gistId}`);
    // If content is truncated, fetch via raw_url
    if (file.truncated) {
      const r = await fetch(file.raw_url);
      if (!r.ok) throw new Error(`Raw content fetch failed: ${r.status}`);
      return r.text();
    }
    return file.content;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Admin: provision the two Gists on first setup and save their IDs to localStorage.
   * Returns { dataGistId, auditGistId }.
   */
  async function adminProvision(adminPAT) {
    setAdminPAT(adminPAT);
    const cfg = loadConfig();

    // Create data gist if not already provisioned.
    // Public:true so end users can read it via the API without a PAT.
    // The data contains only SAP role/user data already visible to your team.
    // Each dataset is stored in its own file to stay within GitHub's 1 MB per-file limit.
    if (!cfg.dataGistId) {
      const g = await createGist(adminPAT, 'SFT — SAP Data Store', {
        'sft_data.json':     { content: '{}' },   // meta / manifest
        'sft_config.json':   { content: '{}' },
        'sft_flpca.json':    { content: '[]' },
        'sft_agrusers.json': { content: '[]' },
        'sft_agragrs.json':  { content: '[]' },
        'sft_agr1251.json':  { content: '[]' }
      }, true);
      cfg.dataGistId = g.id;
    }

    // Create audit gist if not already provisioned
    if (!cfg.auditGistId) {
      const g = await createGist(adminPAT, 'SFT — Audit Log', {
        'sft_audit.json': { content: '[]' }
      });
      cfg.auditGistId = g.id;
    }

    saveConfig(cfg);
    return { dataGistId: cfg.dataGistId, auditGistId: cfg.auditGistId };
  }

  /**
   * Admin: write SAP data payload to the data Gist.
   * payload: { flpca, agrusers, agragrs, agr1251 (optional), _meta, _published }
   *
   * Strategy to avoid GitHub's 1 MB per-file and total-request-body limits:
   *   1. Each dataset is LZ-compressed (base64, ASCII-safe) before writing — typically
   *      60-70 % smaller than raw JSON.
   *   2. Each dataset file is sent in its OWN sequential PATCH request so that no
   *      single HTTP request body is large.
   *   3. sft_data.json holds only the tiny manifest and is written last.
   *
   * Compression uses LZString.compressToBase64 / decompressFromBase64 which is
   * ASCII-safe (no surrogate pairs) and survives JSON transport without corruption.
   */
  async function adminWriteData(payload) {
    const cfg = loadConfig();
    if (!cfg.dataGistId) throw new Error('Data Gist not provisioned. Run setup first.');
    const pat = getAdminPAT();
    const manifest = { _meta: payload._meta, _published: payload._published, _files: [], _compressed: true };

    // Write each dataset in a separate PATCH call to stay within GitHub's request limits
    for (const key of ['flpca', 'agrusers', 'agragrs', 'agr1251']) {
      if (payload[key] && Array.isArray(payload[key])) {
        const compressed = LZString.compressToBase64(JSON.stringify(payload[key]));
        await patchGist(cfg.dataGistId, pat, {
          [`sft_${key}.json`]: { content: compressed }
        });
        manifest._files.push(key);
      }
    }

    // Write manifest last — tiny, no compression needed
    await patchGist(cfg.dataGistId, pat, {
      'sft_data.json': { content: JSON.stringify(manifest) }
    });
  }

  /**
   * Admin: write config (including auditPAT for end-user audit writes) to data Gist config file.
   * configPayload: { auditGistId, auditPAT }
   */
  async function adminWriteConfig(configPayload) {
    const cfg = loadConfig();
    if (!cfg.dataGistId) throw new Error('Data Gist not provisioned. Run setup first.');
    const pat = getAdminPAT();
    await patchGist(cfg.dataGistId, pat, {
      'sft_config.json': { content: JSON.stringify(configPayload) }
    });
  }

  /**
   * End user: fetch SAP data from the data Gist.
   * Reads the manifest (sft_data.json) then fetches each per-dataset file in parallel.
   * Handles three formats for backward compatibility:
   *   • Legacy monolithic  — _files absent: entire payload was in sft_data.json
   *   • Split uncompressed — _files present, _compressed absent/false
   *   • Split compressed   — _files present, _compressed: true  (current format)
   * Returns: { _meta, _published, flpca, agrusers, agragrs, agr1251? }
   */
  async function fetchData(dataGistId) {
    const manifestRaw = await readGistFile(dataGistId, 'sft_data.json', '');
    const manifest    = JSON.parse(manifestRaw);

    // Legacy monolithic format
    if (!manifest._files) return manifest;

    // Split format — fetch all dataset files in parallel
    const payload = { _meta: manifest._meta, _published: manifest._published };
    await Promise.all(manifest._files.map(async key => {
      const raw = await readGistFile(dataGistId, `sft_${key}.json`, '');
      // Decompress if the manifest says files are compressed
      payload[key] = manifest._compressed
        ? JSON.parse(LZString.decompressFromBase64(raw))
        : JSON.parse(raw);
    }));
    return payload;
  }

  /**
   * End user: fetch the runtime config (auditGistId + auditPAT) from data Gist config file.
   */
  async function fetchRuntimeConfig(dataGistId) {
    const raw = await readGistFile(dataGistId, 'sft_config.json', '');
    return JSON.parse(raw);
  }

  /**
   * Any page: append one audit entry to the shared audit Gist.
   * Reads current log, appends, writes back. Fire-and-forget safe (errors are swallowed).
   */
  async function appendAuditEntry(auditGistId, auditPAT, entry) {
    if (!auditGistId || !auditPAT) return; // Gist not configured — fall back silently
    const raw     = await readGistFile(auditGistId, 'sft_audit.json', auditPAT);
    const log     = JSON.parse(raw);
    log.push(entry);
    if (log.length > 5000) log.splice(0, log.length - 5000);
    await patchGist(auditGistId, auditPAT, {
      'sft_audit.json': { content: JSON.stringify(log) }
    });
  }

  /**
   * Repository page: read the full audit log from the audit Gist.
   */
  async function fetchAuditLog(auditGistId, auditPAT) {
    const raw = await readGistFile(auditGistId, 'sft_audit.json', auditPAT);
    return JSON.parse(raw);
  }

  return {
    loadConfig,
    saveConfig,
    setAdminPAT,
    getAdminPAT,
    adminProvision,
    adminWriteData,
    adminWriteConfig,
    fetchData,
    fetchRuntimeConfig,
    appendAuditEntry,
    fetchAuditLog
  };
})();
