
// driveShared.js
// ===============================
// Google Drive sync (AUTO-FIRST, SAFARI-SAFE)
// ===============================

const DRIVE_ROOT_FOLDER_NAME = "KrisyCalendar";
const RECORD_FILE_NAME = "invoice_records.json";

// ===== Local / Session Storage Keys =====
const LS_ROOT_ID = "krisy_drive_root_id_v1";
const LS_FILE_ID = "krisy_drive_file_id_invoice_records.json";
const LS_EVER_SIGNED_IN = "krisy_drive_ever_signed_in_v1";

const SS_TOKEN = "krisy_drive_token_v1";
const SS_TOKEN_EXP = "krisy_drive_token_exp_v1";

// ===== Google App Tag (avoid folder/file split) =====
const APP_TAG_KEY = "krisyApp";
const APP_TAG_VAL = "KrisyCalendarV1";

// ===== OAuth / API =====
const CLIENT_ID =
  (window.GOOGLE_CLIENT_ID && String(window.GOOGLE_CLIENT_ID).trim()) ||
  "878262614270-u7cslu4of0lef4us7d94aj9m1s6de6hk.apps.googleusercontent.com";

const SCOPES = "https://www.googleapis.com/auth/drive";

let accessToken = null;
let tokenClient = null;
let gapiReady = false;
let gsiReady = false;

// ===============================
// Utils: Token Cache
// ===============================
function cacheToken(token, expiresInSec) {
  try {
    sessionStorage.setItem(SS_TOKEN, token);
    const exp = Date.now() + (Number(expiresInSec || 3600) * 1000);
    sessionStorage.setItem(SS_TOKEN_EXP, String(exp));
  } catch (e) {}
}

function getCachedToken() {
  try {
    const token = sessionStorage.getItem(SS_TOKEN);
    const exp = Number(sessionStorage.getItem(SS_TOKEN_EXP) || 0);
    if (!token) return null;
    return { token, exp };
  } catch (e) {
    return null;
  }
}

// ===============================
// Load Google Scripts
// ===============================
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function initGoogleLibs() {
  if (!gapiReady) {
    await loadScript("https://apis.google.com/js/api.js");
    await new Promise(res => gapi.load("client", res));
    await gapi.client.init({});
    gapiReady = true;
  }

  if (!gsiReady) {
    await loadScript("https://accounts.google.com/gsi/client");
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: () => {}
    });
    gsiReady = true;
  }
}

// ===============================
// Access Token Handling
// ===============================
async function ensureAccessToken(interactive) {
  await initGoogleLibs();

  return new Promise((resolve, reject) => {
    try {
      tokenClient.callback = (resp) => {
        if (resp && resp.access_token) {
          accessToken = resp.access_token;
          cacheToken(resp.access_token, resp.expires_in);
          localStorage.setItem(LS_EVER_SIGNED_IN, "1");
          resolve(resp.access_token);
        } else {
          reject(new Error("No access token"));
        }
      };

      tokenClient.requestAccessToken({
        prompt: interactive ? "consent" : ""
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ⭐ 你真正用的：自动模式
async function ensureAccessTokenAuto() {
  // 1. 优先用缓存
  const cached = getCachedToken();
  if (cached && Date.now() < cached.exp - 60000) {
    accessToken = cached.token;
    return cached.token;
  }

  // 2. 尝试 silent
  try {
    return await ensureAccessToken(false);
  } catch (e) {
    return null; // Safari silent 失败是允许的
  }
}

// ===============================
// Drive Helpers
// ===============================
function authHeaders() {
  return { Authorization: "Bearer " + accessToken };
}

async function driveFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeaders() }
  });
  if (!res.ok) throw new Error(`Drive error ${res.status}`);
  return res.json();
}

async function ensureRootFolder() {
  const cached = localStorage.getItem(LS_ROOT_ID);
  if (cached) return cached;

  const q = [
    `name='${DRIVE_ROOT_FOLDER_NAME}'`,
    "mimeType='application/vnd.google-apps.folder'",
    `appProperties has { key='${APP_TAG_KEY}' and value='${APP_TAG_VAL}' }`,
    "trashed=false"
  ].join(" and ");

  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
  );

  if (res.files && res.files.length) {
    localStorage.setItem(LS_ROOT_ID, res.files[0].id);
    return res.files[0].id;
  }

  const created = await driveFetch(
    "https://www.googleapis.com/drive/v3/files",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: DRIVE_ROOT_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
        appProperties: { [APP_TAG_KEY]: APP_TAG_VAL }
      })
    }
  );

  localStorage.setItem(LS_ROOT_ID, created.id);
  return created.id;
}

async function ensureRecordFile() {
  const cached = localStorage.getItem(LS_FILE_ID);
  if (cached) return cached;

  const parentId = await ensureRootFolder();

  const q = [
    `name='${RECORD_FILE_NAME}'`,
    `'${parentId}' in parents`,
    `appProperties has { key='${APP_TAG_KEY}' and value='${APP_TAG_VAL}' }`,
    "trashed=false"
  ].join(" and ");

  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
  );

  if (res.files && res.files.length) {
  localStorage.setItem(LS_FILE_ID, res.files[0].id);
  return res.files[0].id;
}

// ===== 兼容旧版本（没有 appProperties 的 invoice_records.json）=====
const q2 = [
  `name='${RECORD_FILE_NAME}'`,
  `'${parentId}' in parents`,
  "trashed=false"
].join(" and ");

const res2 = await driveFetch(
  `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q2)}`
);

if (res2.files && res2.files.length) {
  localStorage.setItem(LS_FILE_ID, res2.files[0].id);
  return res2.files[0].id;
}


  const created = await driveFetch(
    "https://www.googleapis.com/drive/v3/files",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: RECORD_FILE_NAME,
        parents: [parentId],
        mimeType: "application/json",
        appProperties: { [APP_TAG_KEY]: APP_TAG_VAL }
      })
    }
  );

  localStorage.setItem(LS_FILE_ID, created.id);
  return created.id;
}

// ===============================
// Public API
// ===============================
async function readJson() {
  const tok = await ensureAccessTokenAuto();
  if (!tok) throw new Error("Not authenticated");

  const fileId = await ensureRecordFile();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: authHeaders() }
  );
  if (!res.ok) return [];
  return res.json();
}

async function writeJson(data) {
  const tok = await ensureAccessTokenAuto();
  if (!tok) throw new Error("Not authenticated");

  const fileId = await ensureRecordFile();
  await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders()
      },
      body: JSON.stringify(data)
    }
  );
}

window.DriveShared = {
  ensureAccessToken,        // 手动点云朵
  ensureAccessTokenAuto,    // 自动同步用
  readJson,
  writeJson
};
