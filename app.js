
// Krisy Calendar - app.js (Base: 满意初稿) + Sprint 1 + Sprint 2 (Attachments)
// 原则：不重构、不改框架，只做最小增量改动（UI保持你原来的风格）
//
// Sprint1：日历显示、repeat、未收款、mini 日历点等（保持你原逻辑）
// Sprint2：附件上传/拍照 + 缩略图/大图预览 + 删除/新增 + 云端存储（Google Drive）

// =============================
// Google Drive
// =============================
const GOOGLE_CLIENT_ID = '878262614270-u7cslu4of0lef4us7d94aj9m1s6de6hk.apps.googleusercontent.com';
// ✅ 为了多设备共享“同一份文件”，使用 drive（你自己测试用户 OK）
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

let gAccessToken = '';

// ===== Auto-connect (A方案) 最小增量 =====
let tokenClient = null; // 必须是全局，供静默连接使用
const LS_KEY_EVER_SIGNED_IN = 'krisy_ever_signed_in_v1'; // 记录“曾经成功登录过”

const LS_KEY_PENDING_SYNC = 'krisy_pending_sync_v1';
let bgSyncTimer = null;
// ===== Merge Sync (自动队列合并) =====
const LS_KEY_DEVICE_ID = 'krisy_device_id_v1';
const LS_KEY_OPLOG = 'krisy_oplog_v1';
const LS_KEY_TOMBSTONES = 'krisy_tombstones_v1';
const LS_KEY_EVENTS_PREV = 'krisy_events_prev_v1';
const LS_KEY_DRIVE_CLIENTS_FILE_ID = 'krisy_drive_clients_file_id_v1';
const DRIVE_CLIENTS_FILE_NAME = 'clients.json';


const LS_KEY_DRIVE_ROOT_ID = 'krisy_drive_root_id_v1';
const LS_KEY_DRIVE_EVENTS_FILE_ID = 'krisy_drive_events_file_id_v1';

const DRIVE_ROOT_FOLDER_NAME = 'KrisyCalendar';
const DRIVE_EVENTS_FILE_NAME = 'events.json';
const DRIVE_CONFIG_FILE_NAME = 'krisy_calendar_config_v1.json';
const LS_KEY_DRIVE_CONFIG_FILE_ID = 'krisy_drive_config_file_id_v1';
const DRIVE_DATA_FOLDER_NAME = 'KrisyCalendar_Data';
const DRIVE_RECEIPTS_FOLDER_NAME = 'Receipts';
const DRIVE_WORK_PHOTOS_FOLDER_NAME = 'Work_Photos';

const LS_KEY_LOCAL_UPDATED_AT = 'krisy_local_updated_at_v1';


function setCloudStatus(text, ok = true) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? '#6b7280' : '#ef4444';
  mapCloudDotFromText(text);

}

function mapCloudDotFromText(text){
  const dot = document.getElementById('cloudStatus');
  if(!dot) return;

  const t = String(text || '');

  // 默认黄
  let cls = 'dot-yellow';

  // 红：失败/异常/未授权
  if (/失败|error|初始化失败|未授权|invalid|denied|断开|未登录|请登录/i.test(t)) {
    cls = 'dot-red';
  }

  // 绿：明确在线/已连接/已同步
  if (/已连接|在线|已同步|同步完成|已授权|connected|ready/i.test(t)) {
    cls = 'dot-green';
  }

  dot.classList.remove('dot-red','dot-yellow','dot-green');
  dot.classList.add(cls);

  // 让鼠标悬停还能看到原文字（不占UI）
  dot.title = t;
}


async function driveFetch(url, options = {}) {
  if (!gAccessToken) throw new Error('Not signed in');
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${gAccessToken}`);
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Drive API error ${res.status}: ${t}`);
  }
  return res;
}

async function driveSearchFiles(q, fields = 'files(id,name,modifiedTime,parents)') {
  const params = new URLSearchParams({
    q,
    fields,
    pageSize: '100',
    spaces: 'drive',
    orderBy: 'modifiedTime desc',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });
  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const res = await driveFetch(url, { method: 'GET' });
  const data = await res.json();
  return Array.isArray(data.files) ? data.files : [];
}
async function findRootFolderIdByConfigFile() {
  const q = [
    `name='${DRIVE_CONFIG_FILE_NAME}'`,
    `mimeType='application/json'`,
    'trashed=false'
  ].join(' and ');

  const files = await driveSearchFiles(q);
  if (!files || files.length === 0) return '';

  // ✅ 如果只有一个，直接用它的 parents[0]
  if (files.length === 1) {
    return files[0]?.parents?.[0] || '';
  }

  // ✅ 多个锚点时：选“结构完整”的那个 root（root 下必须有 KrisyCalendar_Data）
  for (const f of files) {
    const rootId = f?.parents?.[0];
    if (!rootId) continue;

    try {
      const qData = [
        `'${rootId}' in parents`,
        `name='${DRIVE_DATA_FOLDER_NAME}'`,
        `mimeType='application/vnd.google-apps.folder'`,
        'trashed=false'
      ].join(' and ');

      const dataFolders = await driveSearchFiles(qData);
      if (dataFolders && dataFolders.length > 0) {
        return rootId;
      }
    } catch (e) {
      // ignore and continue
    }
  }

  // ✅ 都不满足时，退回第一个（兜底）
  return files[0]?.parents?.[0] || '';
}

async function ensureDriveConfigFile(rootFolderId) {
  const cached = localStorage.getItem(LS_KEY_DRIVE_CONFIG_FILE_ID);
  if (cached) return cached;

  // 先查：root 里有没有 config
  const q = [
    `name='${DRIVE_CONFIG_FILE_NAME}'`,
    `'${rootFolderId}' in parents`,
    'trashed=false'
  ].join(' and ');

  const files = await driveSearchFiles(q);
  const existingId = files[0]?.id;
  if (existingId) {
    localStorage.setItem(LS_KEY_DRIVE_CONFIG_FILE_ID, existingId);
    return existingId;
  }

  // 没有就创建一个空的 config 文件，然后写入内容
  setCloudStatus('云端：写入配置锚点…');
  const meta = {
    name: DRIVE_CONFIG_FILE_NAME,
    parents: [rootFolderId],
    mimeType: 'application/json'
  };

  const res = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });

  const created = await res.json();
  const fileId = created.id;
  if (!fileId) throw new Error('创建 config 失败：没有返回 id');

  const payload = {
    app: 'KrisyCalendar',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    note: 'Anchor file used to locate the unique Drive root folder across devices/domains.'
  };

  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`;
  await driveFetch(uploadUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  });

  localStorage.setItem(LS_KEY_DRIVE_CONFIG_FILE_ID, fileId);
  return fileId;
}
async function ensureDriveSubFolder(rootId, folderName) {
  const q = [
    `'${rootId}' in parents`,
    `name='${folderName}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    'trashed=false'
  ].join(' and ');

  const files = await driveSearchFiles(q);
  const foundId = files[0]?.id;
  if (foundId) return foundId;

  const meta = {
    name: folderName,
    parents: [rootId],
    mimeType: 'application/vnd.google-apps.folder'
  };

  const res = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });

  const data = await res.json();
  if (!data.id) throw new Error(`创建 Drive 子文件夹失败：${folderName}`);
  return data.id;
}
async function ensureDriveFolders(rootId) {
  const dataId = await ensureDriveSubFolder(rootId, DRIVE_DATA_FOLDER_NAME);
  const receiptsId = await ensureDriveSubFolder(rootId, DRIVE_RECEIPTS_FOLDER_NAME);
  const workPhotosId = await ensureDriveSubFolder(rootId, DRIVE_WORK_PHOTOS_FOLDER_NAME);
  return { dataId, receiptsId, workPhotosId };
}

async function findExistingRootFolderId() {
  const q = [
    `name='${DRIVE_ROOT_FOLDER_NAME}'`,
    `mimeType='application/vnd.google-apps.folder'`,
    'trashed=false'
  ].join(' and ');
  const files = await driveSearchFiles(q);
  return files[0]?.id || '';
}

async function findExistingClientsFileId(dataFolderId) {
  const q = [
    `name='${DRIVE_CLIENTS_FILE_NAME}'`,
    `'${dataFolderId}' in parents`,
    'trashed=false'
  ].join(' and ');
  const files = await driveSearchFiles(q);
  return files[0]?.id || '';
}

async function ensureDriveRootFolder() {
  const cached = localStorage.getItem(LS_KEY_DRIVE_ROOT_ID);
if (cached) {
  // ✅ 校验：缓存的 root 是否仍然等于“锚点指向的 root”
  try {
    const rootByConfig = await findRootFolderIdByConfigFile();
    if (rootByConfig && rootByConfig !== cached) {
      // 缓存漂移了（跨域名/清缓存/历史遗留导致）
      localStorage.setItem(LS_KEY_DRIVE_ROOT_ID, rootByConfig);
      await ensureDriveConfigFile(rootByConfig);
      return rootByConfig;
    }
    // best-effort：确保锚点存在
    await ensureDriveConfigFile(cached);
  } catch (e) { /* ignore */ }
  return cached;
}


  // ✅ 优先通过 Drive 里的“锚点 config”定位唯一 root（跨设备/跨域名稳定）
  setCloudStatus('云端：定位主目录…');
  const rootByConfig = await findRootFolderIdByConfigFile();
  if (rootByConfig) {
    localStorage.setItem(LS_KEY_DRIVE_ROOT_ID, rootByConfig);
    await ensureDriveConfigFile(rootByConfig);
    return rootByConfig;
  }

  // 旧逻辑：按文件夹名找
  setCloudStatus('云端：查找文件夹…');
  const existingId = await findExistingRootFolderId();
  if (existingId) {
    localStorage.setItem(LS_KEY_DRIVE_ROOT_ID, existingId);
    await ensureDriveConfigFile(existingId);   // ✅ 补上这一行
    return existingId;
  }

  // 找不到就创建
  setCloudStatus('云端：创建文件夹中…');
  const meta = { name: DRIVE_ROOT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' };
  const res = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
  const data = await res.json();
  if (!data.id) throw new Error('创建 Drive 文件夹失败：没有返回 id');

  localStorage.setItem(LS_KEY_DRIVE_ROOT_ID, data.id);
  await ensureDriveConfigFile(data.id);        // ✅ 补上这一行
  return data.id;
}


async function ensureDriveEventsFile(rootFolderId) {
  // ✅ 先拿 Data 文件夹 id（events.json 只允许放这里）
  const { dataId } = await ensureDriveFolders(rootFolderId);

  // ✅ 1) 校验 cached eventsFileId：存在 + 未删除 + 父目录必须是 Data
  const cached = localStorage.getItem(LS_KEY_DRIVE_EVENTS_FILE_ID);
  if (cached) {
    try {
      const res = await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cached)}?fields=id,parents,trashed`,
        { method: 'GET' }
      );
      const info = await res.json();
      if (
        info?.id &&
        !info?.trashed &&
        Array.isArray(info.parents) &&
        info.parents.includes(dataId)
      ) {
        return cached;
      }
    } catch (e) {
      // ignore
    }
    // cached 无效 → 清掉，进入“按名称在 Data 查找”
    localStorage.removeItem(LS_KEY_DRIVE_EVENTS_FILE_ID);
  }

  // ✅ 2) 在 Data 文件夹中按 name 查找 events.json
  setCloudStatus('云端：查找 events.json…');
  const existingId = await findExistingEventsFileId(dataId);
  if (existingId) {
    localStorage.setItem(LS_KEY_DRIVE_EVENTS_FILE_ID, existingId);
    return existingId;
  }

  // ✅ 3) 找不到才创建（创建在 Data）
  setCloudStatus('云端：创建 events.json…');
  const meta = {
    name: DRIVE_EVENTS_FILE_NAME,
    parents: [dataId],
    mimeType: 'application/json'
  };

  const res = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });

  const data = await res.json();
  const id = data?.id;
  if (!id) throw new Error('创建 events.json 失败');

  // 写入空数组
  await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), events: [] })
  });

  localStorage.setItem(LS_KEY_DRIVE_EVENTS_FILE_ID, id);
  return id;
}

async function ensureDriveClientsFile(rootFolderId) {
  // clients.json 也只允许放在 Data 文件夹
  const { dataId } = await ensureDriveFolders(rootFolderId);

  // 1) 校验 cached clientsFileId：存在 + 未删除 + 父目录必须是 Data
  const cached = localStorage.getItem(LS_KEY_DRIVE_CLIENTS_FILE_ID);
  if (cached) {
    try {
      const res = await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cached)}?fields=id,parents,trashed`,
        { method: 'GET' }
      );
      const info = await res.json();
      if (
        info?.id &&
        !info?.trashed &&
        Array.isArray(info.parents) &&
        info.parents.includes(dataId)
      ) {
        return cached;
      }
    } catch (e) {
      // ignore
    }
    localStorage.removeItem(LS_KEY_DRIVE_CLIENTS_FILE_ID);
  }

  // 2) 在 Data 文件夹按 name 查找 clients.json
  setCloudStatus('云端：查找 clients.json…');
  const existingId = await findExistingClientsFileId(dataId);
  if (existingId) {
    localStorage.setItem(LS_KEY_DRIVE_CLIENTS_FILE_ID, existingId);
    return existingId;
  }

  // 3) 找不到才创建（创建在 Data）
  setCloudStatus('云端：创建 clients.json…');
  const meta = {
    name: DRIVE_CLIENTS_FILE_NAME,
    parents: [dataId],
    mimeType: 'application/json'
  };

  const res = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });

  const data = await res.json();
  const id = data?.id;
  if (!id) throw new Error('创建 clients.json 失败');

  // 初始化写入（用对象结构，后续读取更稳）
  const initPayload = { version: 1, updatedAt: new Date().toISOString(), clients: [] };
  await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(initPayload)
  });

  localStorage.setItem(LS_KEY_DRIVE_CLIENTS_FILE_ID, id);
  return id;
}

async function cloudLoadEventsFromDrive() {
  const rootId = await ensureDriveRootFolder();
  const fileId = await ensureDriveEventsFile(rootId);
  setCloudStatus('云端：读取 events.json…');

  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { method: 'GET' }
  );

  const json = await res.json().catch(() => ({}));

  // ✅ 兼容旧格式：纯数组
  if (Array.isArray(json)) return json;

  // ✅ 新格式：对象 { events: [...] }
  if (Array.isArray(json?.events)) return json.events;

  return [];
}
async function syncClientsOnLogin() {
  try {
    // 1) 读取云端 clients
    const cloudClients = await cloudLoadClientsFromDrive();

    // 2) 读取本地 clients（如果你本地有旧客户，第一次要推上云）
    const localClientsRaw = localStorage.getItem(LS_KEY_CLIENTS) || '[]';
    const localClients = safeParse(localClientsRaw, []);
    const localArr = Array.isArray(localClients) ? localClients : [];

// 判断本地是否“真有客户数据”
// （因为你的 loadClients 没数据时会塞默认 3 个客户）
const hasRealLocal = localArr.some(c =>
  c?.clientId && c?.name && !['C001','C002','C003'].includes(c.clientId)
);

    // 情况 1：云端有客户 → 用云端覆盖本地（B 手机最需要这个）
if (Array.isArray(cloudClients) && cloudClients.length > 0) {
  // 合并：云端 + 本地（本地优先，防止离线新增客户丢失）
  const mergedMap = new Map();

  // 先放云端
  cloudClients.forEach(c => { if (c?.clientId) mergedMap.set(c.clientId, c); });

  // 再放本地（同 clientId 用本地覆盖）
  localArr.forEach(c => { if (c?.clientId) mergedMap.set(c.clientId, c); });

  clients = Array.from(mergedMap.values());
  localStorage.setItem(LS_KEY_CLIENTS, JSON.stringify(clients));

  // 合并后写回云端，让云端吸收本地离线新增
  await cloudWriteClientsToDrive(clients);

  renderClients();
  refreshCalendar();
  updateClientAddressUI();
  return;
}

    // 情况 2：云端为空 + 本地有真实客户 → 把本地推上云（A 手机第一次迁移靠这个）
    if ((!cloudClients || cloudClients.length === 0) && hasRealLocal) {
      await cloudWriteClientsToDrive(localArr);

      // 推上云后再读一次（保险）
      const again = await cloudLoadClientsFromDrive();
      if (again && again.length > 0) {
        clients = again;
        localStorage.setItem(LS_KEY_CLIENTS, JSON.stringify(clients));
        renderClients();
        refreshCalendar();
        updateClientAddressUI();
      }
    }
  } catch (e) {
    console.error(e);
    setCloudStatus('云端：客户对齐失败（看控制台）', false);
  }
}

async function cloudLoadClientsFromDrive() {
  const rootId = await ensureDriveRootFolder();
  const fileId = await ensureDriveClientsFile(rootId);
  setCloudStatus('云端：读取 clients.json…');

  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { method: 'GET' }
  );

  const json = await res.json().catch(() => ({}));

  // 兼容：万一某次写成纯数组，也能读
  if (Array.isArray(json)) return json;
  return Array.isArray(json?.clients) ? json.clients : [];
}

async function cloudWriteClientsToDrive(rows) {
  const rootId = await ensureDriveRootFolder();
  const fileId = await ensureDriveClientsFile(rootId);

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    clients: Array.isArray(rows) ? rows : []
  };

  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`;
  await driveFetch(uploadUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  });
}

async function cloudWriteEventsToDrive(events) {
  const rootId = await ensureDriveRootFolder();
  const fileId = await ensureDriveEventsFile(rootId);
  const payload = { version: 1, updatedAt: new Date().toISOString(), events: Array.isArray(events) ? events : [] };

  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`;
  await driveFetch(uploadUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  });
}

let cloudSaveTimer = null;
function cloudQueueSave(events) {
  if (!gAccessToken) return;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);

  cloudSaveTimer = setTimeout(async () => {
    await syncCloudMergeNow('在线保存');
  }, 650);
}

let cloudClientsSaveTimer = null;
function cloudQueueSaveClients(rows) {
  if (!gAccessToken) return;
  if (cloudClientsSaveTimer) clearTimeout(cloudClientsSaveTimer);

  cloudClientsSaveTimer = setTimeout(async () => {
    try {
      await cloudWriteClientsToDrive(rows);
      // 不强刷状态也行；你想看更明确就打开下面这一行
      // setCloudStatus('云端：客户已同步', true);
    } catch (e) {
      console.error(e);
      setCloudStatus('云端：客户同步失败（会自动重试）', false);
    }
  }, 650);
}


function initGoogleLogin() {
  const btn = document.getElementById('googleLoginBtn');
  if (!btn) return;

  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    setTimeout(initGoogleLogin, 250);
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    
    callback: async (resp) => {
  if (!resp || !resp.access_token) {
    setTimeout(autoConnectOnLoad, 200);
    setCloudStatus('云端：登录失败', false);
    return;
  }

  gAccessToken = resp.access_token;

  // 记录：此浏览器曾经成功登录授权过（用于下次静默自动连接）
  try { localStorage.setItem(LS_KEY_EVER_SIGNED_IN, '1'); } catch (e) {}

 try {
  await ensureDriveRootFolder();
  await syncCloudMergeNow('登录后对齐');
  await syncClientsOnLogin(); // ✅ 新增这一行
  setTimeout(backgroundSyncIfNeeded, 300);

} catch (e) {
  console.error(e);
  setCloudStatus('云端：初始化失败（看控制台）', false);
}

},

  });

  btn.addEventListener('click', () => tokenClient.requestAccessToken({ prompt: 'consent' }));
}

// =============================
// Storage
// =============================
const LS_KEY_EVENTS = 'krisy_events_v1';
const LS_KEY_CLIENTS = 'krisy_clients_v1';

const REPEAT_TOTAL = 6; // 生成 6 次（含本次）

function autoConnectOnLoad() {
  // 只有“曾经成功登录过”才尝试静默
  let ever = '';
  try { ever = localStorage.getItem(LS_KEY_EVER_SIGNED_IN) || ''; } catch(e) {}
  if (!ever) return;

  // GIS 还没 ready 或 tokenClient 还没初始化，就不做
  if (!tokenClient) return;

  try {
    // prompt:'' = 尝试静默拿 token（能成功就无感；失败就什么都不做）
    tokenClient.requestAccessToken({ prompt: '' });
  } catch (e) {
    // 静默失败很常见（尤其 iPhone Safari），这里不要 throw
    // 给你一个轻提示：让你点一次登录按钮就好
    if (typeof setCloudStatus === 'function') {
      setCloudStatus('云端：未自动连接（点一次 Google 登录即可）', false);
    }
  }
}

function uid() {
  return 'E' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function getDeviceId() {
  let id = '';
  try { id = localStorage.getItem(LS_KEY_DEVICE_ID) || ''; } catch(e) {}
  if (!id) {
    id = 'D' + Math.random().toString(16).slice(2) + Date.now().toString(16);
    try { localStorage.setItem(LS_KEY_DEVICE_ID, id); } catch(e) {}
  }
  return id;
}

function loadOplog() {
  return safeParse(localStorage.getItem(LS_KEY_OPLOG) || '[]', []);
}
function saveOplog(ops) {
  localStorage.setItem(LS_KEY_OPLOG, JSON.stringify(Array.isArray(ops) ? ops : []));
}
function loadTombstones() {
  return safeParse(localStorage.getItem(LS_KEY_TOMBSTONES) || '[]', []);
}
function saveTombstones(t) {
  localStorage.setItem(LS_KEY_TOMBSTONES, JSON.stringify(Array.isArray(t) ? t : []));
}

// 把“本次保存前后的 events”做 diff，记录成队列（upsert/delete）
function recordOpsFromDiff(prevRows, nextRows) {
  const now = Date.now();
  const dev = getDeviceId();

  const prev = Array.isArray(prevRows) ? prevRows : [];
  const next = Array.isArray(nextRows) ? nextRows : [];

  const prevMap = new Map(prev.map(e => [e.id, e]));
  const nextMap = new Map(next.map(e => [e.id, e]));

  const ops = loadOplog();
  const tomb = loadTombstones();

  // upsert：新增或变更
  for (const [id, e] of nextMap.entries()) {
    const before = prevMap.get(id);
    if (!before || JSON.stringify(before) !== JSON.stringify(e)) {
      const data = { ...e, _updatedMs: now, _dev: dev };
      ops.push({ t: now, dev, op: 'upsert', id, data });
    }
  }

  // delete：之前有、现在没有
  for (const [id] of prevMap.entries()) {
    if (!nextMap.has(id)) {
      tomb.push({ id, deletedMs: now, dev });
      ops.push({ t: now, dev, op: 'delete', id });
    }
  }

  saveOplog(ops);
  saveTombstones(tomb);
}

// 把 oplog 合并到云端 events（LWW + tombstone 防复活）
function mergeEventsByOplog(cloudEvents, ops, tombstones) {
  const base = Array.isArray(cloudEvents) ? cloudEvents : [];
  const map = new Map(base.map(e => [e.id, e]));

  const tomb = Array.isArray(tombstones) ? tombstones : [];
  const tombSet = new Set(tomb.map(x => x.id));

  const list = Array.isArray(ops) ? ops.slice() : [];
  list.sort((a, b) => (a.t || 0) - (b.t || 0));

  for (const o of list) {
    if (!o || !o.id) continue;

    if (o.op === 'delete') {
      map.delete(o.id);
      tombSet.add(o.id);
      continue;
    }

    if (o.op === 'upsert' && o.data) {
      if (tombSet.has(o.id)) {
        // 如果这条 id 已被删除墓碑记录过，upsert 也不让它复活（更稳）
        continue;
      }
      const cur = map.get(o.id);
      const curMs = Number(cur?._updatedMs || 0);
      const nextMs = Number(o.data?._updatedMs || o.t || 0);
      if (!cur || nextMs >= curMs) {
        map.set(o.id, o.data);
      }
    }
  }

  // 删除墓碑最终生效，防止复活
  for (const id of tombSet) {
    map.delete(id);
  }

  return Array.from(map.values());
}

// 核心：在线后一次性“拉云端→合并→写回→本地对齐”
async function syncCloudMergeNow(reason = '') {
  if (!navigator.onLine) return;
  if (!gAccessToken) return;

  try {
    setCloudStatus(reason ? `云端：同步中（${reason}）…` : '云端：同步中…', true);

    const cloudEvents = await cloudLoadEventsFromDrive();
    const ops = loadOplog();
    const tomb = loadTombstones();

    const merged = mergeEventsByOplog(cloudEvents, ops, tomb);

    // 只有需要时才写回（减少写入）
    const cloudStr = JSON.stringify(cloudEvents || []);
    const mergedStr = JSON.stringify(merged || []);
    if (mergedStr !== cloudStr) {
      await cloudWriteEventsToDrive(merged);
    }

    // ✅ 同步成功：云端吸收了本机离线改动 → 清队列/标记
    try { localStorage.removeItem(LS_KEY_PENDING_SYNC); } catch(e) {}
    try { localStorage.removeItem(LS_KEY_LOCAL_UPDATED_AT); } catch(e) {}
    try { localStorage.removeItem(LS_KEY_OPLOG); } catch(e) {}
    try { localStorage.removeItem(LS_KEY_TOMBSTONES); } catch(e) {}

    // ✅ 本地对齐到最终结果（非常关键：让B覆盖旧本地）
    localStorage.setItem(LS_KEY_EVENTS, JSON.stringify(merged));
    allEvents = merged;
    refreshCalendar();
    renderMini(calendar.getDate());

    setCloudStatus('云端：已同步', true);
  } catch (e) {
    console.error(e);
    setCloudStatus('云端：同步失败（会自动重试）', false);
  }
}

function loadClients() {
  let c = safeParse(localStorage.getItem(LS_KEY_CLIENTS) || '[]', []);
  if (!Array.isArray(c) || c.length === 0) {
    c = [
      { clientId: 'C001', name: 'Nancy', address: 'The Gap', note: '', active: true },
      { clientId: 'C002', name: 'Claire', address: 'Ashgrove', note: '', active: true },
      { clientId: 'C003', name: 'Mike', address: 'Paddington', note: '', active: true },
    ];
    localStorage.setItem(LS_KEY_CLIENTS, JSON.stringify(c));
    return c;
  }

  // ✅ 兼容旧数据：补齐 active / note / address
  c = c.map(x => ({ active: true, note: '', address: '', ...x }));
  localStorage.setItem(LS_KEY_CLIENTS, JSON.stringify(c));
  return c;
}

function loadEvents() {
  const rows = safeParse(localStorage.getItem(LS_KEY_EVENTS) || '[]', []);
  return Array.isArray(rows) ? rows : [];
}

// ✅ 保存本地后排队云同步
function saveEvents(rows) {
  const prev = safeParse(localStorage.getItem(LS_KEY_EVENTS) || '[]', []);
  // 先记录队列（离线也能记）
  try { recordOpsFromDiff(prev, rows); } catch(e) { console.warn(e); }

  localStorage.setItem(LS_KEY_EVENTS, JSON.stringify(rows));

  // 只要本地有变更，就标记“待同步”
  try { localStorage.setItem(LS_KEY_PENDING_SYNC, '1'); } catch(e) {}
  try { localStorage.setItem(LS_KEY_LOCAL_UPDATED_AT, Date.now().toString()); } catch(e) {}

  if (!gAccessToken) {
    setCloudStatus('本地：已保存（未连接云端，稍后会自动补同步）', true);
    return;
  }

  // 在线：走合并同步（不是直接覆盖写）
  cloudQueueSave(rows);
}


async function backgroundSyncIfNeeded() {
  if (!navigator.onLine) return;
  if (!gAccessToken) return;

  let pending = '';
  try { pending = localStorage.getItem(LS_KEY_PENDING_SYNC) || ''; } catch(e) {}
  if (!pending) return;

  await syncCloudMergeNow('后台补同步');
}


function startBackgroundSyncLoop() {
  if (bgSyncTimer) return;
  // 每 8 秒检查一次（频率别太高，够用且稳）
  bgSyncTimer = setInterval(backgroundSyncIfNeeded, 8000);

  // 网络恢复时立刻尝试一次
  window.addEventListener('online', () => {
    setTimeout(backgroundSyncIfNeeded, 500);
  });
}

function saveClients(rows) {
  localStorage.setItem(LS_KEY_CLIENTS, JSON.stringify(rows));
  cloudQueueSaveClients(rows); // ✅ 新增：同步到 Drive
}

// =============================
// UI Elements
// =============================
const overlay = document.getElementById('overlay');
const addBtn = document.getElementById('addBtn');
const closeBtn = document.getElementById('closeBtn');
const saveBtn = document.getElementById('saveBtn');
const saveDraftBtn = document.getElementById('saveDraftBtn');
const deleteBtn = document.getElementById('deleteBtn');

const typeEl = document.getElementById('type');
const dateEl = document.getElementById('date');
const startEl = document.getElementById('start');
const durationEl = document.getElementById('duration');
const clientEl = document.getElementById('client');
const titleEl = document.getElementById('title');
const amountEl = document.getElementById('amount');
const categoryEl = document.getElementById('category');

const startField = document.getElementById('startField');
const durationField = document.getElementById('durationField');
const clientField = document.getElementById('clientField');
const amountField = document.getElementById('amountField');
const categoryField = document.getElementById('categoryField');

const repeatField = document.getElementById('repeatField');
const repeatEl = document.getElementById('repeat');

const clientAddressBox = document.getElementById('clientAddressBox');
const clientMapLink = document.getElementById('clientMapLink');

const durationHelp = document.getElementById('durationHelp');
const validationHint = document.getElementById('validationHint');

// ✅ Attachment UI
const attachmentField = document.getElementById('attachmentField');
const attachmentFilesEl = document.getElementById('attachmentFiles');
const attachmentPreviewEl = document.getElementById('attachmentPreview');

const imgViewer = document.getElementById('imgViewer');
const imgViewerImg = document.getElementById('imgViewerImg');
const imgViewerClose = document.getElementById('imgViewerClose');

let allEvents = loadEvents();
let clients = loadClients();

// =============================
// Helpers (time + unpaid)
// =============================
function formatTimeLower(dateObj) {
  if (!dateObj) return '';
  let h = dateObj.getHours();
  const m = String(dateObj.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  const hh = String(h).padStart(2, '0');
  return `${hh}:${m}${ap}`;
}

function isWorkUnpaid(ext) {
  if (!ext) return false;
  if (ext.type !== 'Work') return false;
  return ext.amount === '' || ext.amount == null;
}

// =============================
// Clients
// =============================
function nextClientId() {
  const n = String(Date.now()).slice(-4);
  return 'C' + n;
}

function renderClients() {
  clientEl.innerHTML = '<option value="">请选择客户</option>';

  clients
    .filter(c => c.active !== false)
    .forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.clientId;
      opt.textContent = `${c.name} (${c.clientId})`;
      clientEl.appendChild(opt);
    });

  const optNew = document.createElement('option');
  optNew.value = '__new__';
  optNew.textContent = '+ 新建客户';
  clientEl.appendChild(optNew);
}
renderClients();

function findClient(id) {
  return clients.find((c) => c.clientId === id) || null;
}

function updateClientAddressUI() {
  if (!clientAddressBox || !clientMapLink) return;
  const v = clientEl.value;
  const c = findClient(v);
  if (!c || !c.address) {
    clientAddressBox.style.display = 'none';
    clientMapLink.textContent = '';
    clientMapLink.href = '#';
    return;
  }
  clientAddressBox.style.display = 'block';
  clientMapLink.textContent = `📍 ${c.address}（点我打开 Google Maps）`;
  clientMapLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}`;
}
// =============================
// Client Manager (Edit/Deactivate/Delete)
// =============================
const manageClientsBtn = document.getElementById('manageClientsBtn');

const clientOverlay = document.getElementById('clientOverlay');
const clientCloseBtn = document.getElementById('clientCloseBtn');
const clientSaveBtn  = document.getElementById('clientSaveBtn');
const clientAddBtn   = document.getElementById('clientAddBtn');
const clientList     = document.getElementById('clientList');
const clientHint     = document.getElementById('clientHint');

function openClientManager(){
  if (!clientOverlay) return;
  if (clientHint) clientHint.textContent = '';
  renderClientManager();
  clientOverlay.style.display = 'flex';
}

function closeClientManager(){
  if (!clientOverlay) return;
  clientOverlay.style.display = 'none';
}

function isClientUsed(clientId){
  return Array.isArray(allEvents) && allEvents.some(e => e.clientId === clientId);
}

function renderClientManager(){
  if (!clientList) return;
  clientList.innerHTML = '';

  clients.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'client-row';
    row.dataset.id = c.clientId;

    row.innerHTML = `
      <div>
        <label>客户名</label>
        <input class="cm-name" value="${(c.name||'').replace(/"/g,'&quot;')}" />
      </div>
      <div>
        <label>客户代码</label>
        <input class="cm-id" value="${c.clientId}" disabled />
      </div>

      <div class="full">
        <label>地址</label>
        <input class="cm-address" value="${(c.address||'').replace(/"/g,'&quot;')}" />
      </div>

      <div class="full">
        <label>备注</label>
        <input class="cm-note" value="${(c.note||'').replace(/"/g,'&quot;')}" />
      </div>

      <div class="client-actions">
        <div class="left">
          <div class="cm-toggle">
        <label class="switch">
    <input type="checkbox" class="cm-active" ${c.active !== false ? 'checked' : ''}/>
    <span class="slider"></span>
  </label>
  <span class="cm-state">${c.active !== false ? '启用' : '停用'}</span>
  <span class="help">停用后：下拉隐藏，但历史记录仍显示名字</span>
</div>
          ${isClientUsed(c.clientId) ? '<span class="help">⚠️ 已被历史事件使用：建议停用，不建议删除</span>' : ''}
        </div>
        <button type="button" class="btn danger cm-del">删除</button>
      </div>
    `;
const activeCb = row.querySelector('.cm-active');
const stateEl = row.querySelector('.cm-state');
if (activeCb && stateEl) {
  activeCb.addEventListener('change', () => {
    stateEl.textContent = activeCb.checked ? '启用' : '停用';
  });
}
    row.querySelector('.cm-del').addEventListener('click', () => {
      const id = c.clientId;
      if (isClientUsed(id)) {
        alert('这个客户已被历史事件使用，不能删除。你可以取消“启用”来停用它（下拉隐藏，但历史记录仍显示名字）。');
        return;
      }
      if (!confirm(`确定删除客户：${c.name} (${id}) 吗？`)) return;

      clients = clients.filter(x => x.clientId !== id);
      saveClients(clients);
      renderClients();
      renderClientManager();
      updateClientAddressUI();
    });

    clientList.appendChild(row);
  });
}

function addClientFromManager(){
  const name = (prompt('请输入新客户名字：') || '').trim();
  if (!name) return;
  const address = (prompt('请输入客户地址：') || '').trim();

  const id = nextClientId();
  const newClient = { clientId:id, name, address, note:'', active:true };

  clients = [...clients, newClient];
  saveClients(clients);
  renderClients();
  renderClientManager();
}

function saveClientManagerEdits(){
  const rows = Array.from(clientList.querySelectorAll('.client-row'));

  clients = clients.map(c => {
    const r = rows.find(x => x.dataset.id === c.clientId);
    if (!r) return c;

    const name = (r.querySelector('.cm-name').value || '').trim();
    const address = (r.querySelector('.cm-address').value || '').trim();
    const note = (r.querySelector('.cm-note').value || '').trim();
    const active = r.querySelector('.cm-active').checked;

    return { ...c, name: name || c.name, address, note, active };
  });

  saveClients(clients);
  renderClients();
  updateClientAddressUI();

  // 如果当前选中的客户被停用：清空选择，避免选到隐藏项
  const cur = findClient(clientEl.value);
  if (cur && cur.active === false) {
    clientEl.value = '';
    updateClientAddressUI();
  }

  if (clientHint) {
    clientHint.textContent = '✅ 已保存（登录云端时会同步到 clients.json）';
    setTimeout(() => (clientHint.textContent=''), 2000);
  }
  closeClientManager();
}

// wire
if (manageClientsBtn) manageClientsBtn.addEventListener('click', openClientManager);
if (clientCloseBtn) clientCloseBtn.addEventListener('click', closeClientManager);
if (clientSaveBtn)  clientSaveBtn.addEventListener('click', saveClientManagerEdits);
if (clientAddBtn)   clientAddBtn.addEventListener('click', addClientFromManager);
if (clientOverlay)  clientOverlay.addEventListener('click', (e) => { if (e.target === clientOverlay) closeClientManager(); });

const editClientBtn = document.getElementById('editClientBtn');

function openClientManagerTo(clientId){
  openClientManager(); // 你原本的打开客户管理
  // 等 DOM 渲染完再定位
  setTimeout(() => {
    const row = document.querySelector(`.client-row[data-id="${clientId}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const nameInput = row.querySelector('.cm-name');
      if (nameInput) nameInput.focus();
    }
  }, 50);
}

if (editClientBtn) {
  editClientBtn.addEventListener('click', () => {
    const id = clientEl.value;
    if (!id || id === '__new__') {
      alert('请先在下拉里选择一个客户，再点编辑。');
      return;
    }
    openClientManagerTo(id);
  });
}

clientEl.addEventListener('change', () => {
  if (clientEl.value === '__new__') {
    const name = (prompt('请输入新客户名字：') || '').trim();
    if (!name) {
      clientEl.value = '';
      updateClientAddressUI();
      return;
    }
    const address = (prompt('请输入客户地址：') || '').trim();
    const id = nextClientId();
    const newClient = { clientId: id, name, address, note: '', active: true };  
    clients = [...clients, newClient];
    saveClients(clients);
    renderClients();
    clientEl.value = id;
  }
  updateClientAddressUI();
});

// =============================
// Attachments (Sprint2)
// =============================
// event.attachments: [{ fileId, name, mimeType, createdAt }]
let editingId = null;
let pendingFiles = [];              // File[]
let deletedAttachmentFileIds = new Set(); // fileId

const objectUrlPool = new Map(); // fileId -> objectURL (for cleanup)

function clearAttachmentState() {
  pendingFiles = [];
  deletedAttachmentFileIds = new Set();
  if (attachmentFilesEl) attachmentFilesEl.value = '';
  if (attachmentPreviewEl) attachmentPreviewEl.innerHTML = '';
  // revoke temp urls
  for (const [, url] of objectUrlPool) URL.revokeObjectURL(url);
  objectUrlPool.clear();
}

function openImageViewer(src) {
  imgViewerImg.src = src;
  imgViewer.style.display = 'flex';
}
function closeImageViewer() {
  imgViewerImg.src = '';
  imgViewer.style.display = 'none';
}
if (imgViewerClose) imgViewerClose.addEventListener('click', closeImageViewer);
if (imgViewer) imgViewer.addEventListener('click', (e) => {
  if (e.target === imgViewer) closeImageViewer();
});

function renderThumb({ src, name, onOpen, onRemove }) {
  const wrap = document.createElement('div');
  wrap.className = 'thumb';

  const img = document.createElement('img');
  img.src = src;
  img.alt = name || 'image';
  img.addEventListener('click', onOpen);
  wrap.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'thumb-meta';
  meta.textContent = name || '';
  wrap.appendChild(meta);

  const x = document.createElement('button');
  x.className = 'thumb-x';
  x.type = 'button';
  x.textContent = '×';
  x.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onRemove();
  });
  wrap.appendChild(x);

  return wrap;
}

async function driveDownloadImageAsObjectUrl(fileId) {
  // 读取文件 blob（需要登录）
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    method: 'GET'
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  objectUrlPool.set(fileId, url);
  return url;
}

async function uploadAttachmentFile(file, row) {

  // 文件名带 eventId，便于你在 Drive 里人工排查
  const rootId = await ensureDriveRootFolder();
const { receiptsId, workPhotosId } = await ensureDriveFolders(rootId);

let parentId = rootId;
let safeName = file.name;

if (row?.type === 'Expense') {
  parentId = receiptsId;
  safeName = `R_${row.date}_${row.amount || 'NA'}_${Date.now()}`;
}

if (row?.type === 'Work') {
  parentId = workPhotosId;
  safeName = `W_${row.date}_${row.clientId || 'Client'}_${Date.now()}`;
}

  const meta = {
    name: safeName,
    parents: [parentId],
    mimeType: file.type || 'application/octet-stream'
  };

  // 1) create file
  const createRes = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
  const createData = await createRes.json();
  const fileId = createData.id;
  if (!fileId) throw new Error('上传附件失败：未返回 fileId');

  // 2) upload media
  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`;
  await driveFetch(uploadUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });

  return {
    fileId,
    name: file.name,
    mimeType: file.type || '',
    createdAt: new Date().toISOString()
  };
}

async function deleteAttachmentFile(fileId) {
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE'
  });
}
function collectReferencedAttachmentFileIds(events) {
  const ids = new Set();
  const rows = Array.isArray(events) ? events : [];
  for (const ev of rows) {
    const atts = Array.isArray(ev?.attachments) ? ev.attachments : [];
    for (const a of atts) {
      if (a?.fileId) ids.add(a.fileId);
    }
  }
  return ids;
}

// 列出 KrisyCalendar 文件夹里的所有文件（分页）
async function driveListFilesInFolder(folderId) {
  const all = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,size)',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, { method: 'GET' });
    const data = await res.json();
    if (Array.isArray(data.files)) all.push(...data.files);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return all;
}

async function cleanupOrphanAttachments() {
  if (!gAccessToken) {
    setCloudStatus('云端：未连接（请先点一次 Google 登录）', false);
    return;
  }

  const ok = confirm('智能清理会删除云端中“未被任何事件引用”的附件文件。\n\n确定开始？');
  if (!ok) return;

  try {
    setCloudStatus('云端：扫描中…', true);

    const rootId = await ensureDriveRootFolder();

    // 1) 取本地事件（你的系统本地永远是可用的；云端同步由你现有机制负责）
    await syncCloudMergeNow('清理前对齐');
    const localEvents = loadEvents();
    const referenced = collectReferencedAttachmentFileIds(localEvents);

    // 2) 只扫描附件文件夹（Receipts + Work_Photos），避免误删 Data 里的 json
const { receiptsId, workPhotosId } = await ensureDriveFolders(rootId);

// 只列出两个附件目录的文件
const files = [
  ...(await driveListFilesInFolder(receiptsId)),
  ...(await driveListFilesInFolder(workPhotosId))
];

// 3) 过滤：不删文件夹；只删“没被引用”的附件文件
const candidates = files.filter(f => {
  if (!f?.id) return false;
  if (f.mimeType === 'application/vnd.google-apps.folder') return false;
  return !referenced.has(f.id);
});


    if (candidates.length === 0) {
      setCloudStatus('云端：无需清理（没有孤儿附件）', true);
      alert('无需清理：未发现孤儿附件。');
      return;
    }

    const ok2 = confirm(`发现 ${candidates.length} 个孤儿附件，将从云端删除。\n\n确定删除？`);
    if (!ok2) {
      setCloudStatus('云端：已取消清理', true);
      return;
    }

    // 4) 执行删除
    setCloudStatus(`云端：删除中…(0/${candidates.length})`, true);
    let done = 0;

    for (const f of candidates) {
      try {
        await deleteAttachmentFile(f.id); // 你已有的函数
        done++;
        setCloudStatus(`云端：删除中…(${done}/${candidates.length})`, true);
      } catch (e) {
        console.error('删除失败', f, e);
      }
    }

    setCloudStatus(`云端：清理完成（删除 ${done}/${candidates.length}）`, true);
    alert(`清理完成：已删除 ${done}/${candidates.length} 个孤儿附件。`);
  } catch (e) {
    console.error(e);
    setCloudStatus('云端：清理失败（看控制台）', false);
    alert('清理失败：请打开控制台查看报错。');
  }
}

async function renderAttachmentPreviewForRow(row) {
  if (!attachmentPreviewEl) return;
  attachmentPreviewEl.innerHTML = '';

  const t = typeEl.value;
  if (t === 'Life') return;

  const existing = Array.isArray(row?.attachments) ? row.attachments : [];

  // 1) existing attachments
  for (const att of existing) {
    if (!att?.fileId) continue;
    if (deletedAttachmentFileIds.has(att.fileId)) continue;

    let src = '';
    if (gAccessToken) {
      try {
        src = await driveDownloadImageAsObjectUrl(att.fileId);
      } catch (e) {
        console.error(e);
        src = '';
      }
    }

    const thumb = renderThumb({
      src: src || '',
      name: att.name || att.fileId,
      onOpen: () => src && openImageViewer(src),
      onRemove: () => {
        deletedAttachmentFileIds.add(att.fileId);
        renderAttachmentPreviewForRow(row);
      }
    });
    attachmentPreviewEl.appendChild(thumb);
  }

  // 2) pending local files
  pendingFiles.forEach((f, idx) => {
    const localUrl = URL.createObjectURL(f);
    const key = `pending_${idx}_${f.name}`;
    objectUrlPool.set(key, localUrl);

    const thumb = renderThumb({
      src: localUrl,
      name: f.name,
      onOpen: () => openImageViewer(localUrl),
      onRemove: () => {
        // remove this pending file
        pendingFiles = pendingFiles.filter((_, i) => i !== idx);
        renderAttachmentPreviewForRow(row);
      }
    });
    attachmentPreviewEl.appendChild(thumb);
  });
}

if (attachmentFilesEl) {
  attachmentFilesEl.addEventListener('change', () => {
    const files = Array.from(attachmentFilesEl.files || []);
    if (!files.length) return;
    pendingFiles = pendingFiles.concat(files);
    renderAttachmentPreviewForRow(getEditingRowSnapshot());
  });
}

function getEditingRowSnapshot() {
  if (!editingId) return null;
  return allEvents.find((e) => e.id === editingId) || null;
}

// =============================
// Calendar
// =============================
let calendar;
const titlebar = document.getElementById('titlebar');

function typeColor(t) {
  if (t === 'Work') return '#0a84ff';
  if (t === 'Expense') return '#ff3b30';
  return '#34c759';
}

function addHoursISO(iso, hours) {
  const d = new Date(iso);
  const out = new Date(d.getTime() + hours * 60 * 60 * 1000);
  return out.toISOString().slice(0, 19);
}

function asCalendarEvent(row) {
  const date = row.date;
  const type = row.type;
  const start = row.start || '00:00';

  const clientName = row.clientId
    ? clients.find((c) => c.clientId === row.clientId)?.name || row.clientId
    : '';

  if (type === 'Work') {
    const dur = row.duration != null && row.duration !== '' ? Number(row.duration) : null;
    const shownTitle = `${clientName || 'Work'}`;
    const startISO = `${date}T${start}`;

    return {
      id: row.id,
      title: shownTitle,
      start: startISO,
      end: addHoursISO(startISO, (dur && dur > 0) ? dur : 1),
      allDay: false,
      backgroundColor: typeColor(type),
      borderColor: typeColor(type),
      extendedProps: row,
    };
  }

  if (type === 'Life') {
    const startISO = `${date}T${start}`;
    const label = row.title?.trim() ? row.title.trim() : 'Life';
    return {
      id: row.id,
      title: label,
      start: startISO,
      end: addHoursISO(startISO, 1),
      allDay: false,
      backgroundColor: typeColor(type),
      borderColor: typeColor(type),
      extendedProps: row,
    };
  }

  // Expense all day
  const a = row.amount != null && row.amount !== '' ? Number(row.amount) : 0;
  const neg = -Math.abs(a);
  const cat = row.category || 'Expense';
  const label = row.title?.trim() ? row.title.trim() : cat;
  const shownTitle = `${label} · $${neg.toFixed(2)}`;

  return {
    id: row.id,
    title: shownTitle,
    start: date,
    allDay: true,
    backgroundColor: typeColor(type),
    borderColor: typeColor(type),
    extendedProps: row,
  };
}

function refreshCalendar() {
  calendar.removeAllEvents();
  allEvents.map(asCalendarEvent).forEach((ev) => calendar.addEvent(ev));
}

function syncSegButtons() {
  document.querySelectorAll('.seg button').forEach((b) => b.classList.remove('active'));
  const current = calendar.view.type;
  const btn = document.querySelector(`.seg button[data-view="${current}"]`);
  if (btn) btn.classList.add('active');
}

function initCalendar() {
  const el = document.getElementById('calendar');
  calendar = new FullCalendar.Calendar(el, {
    initialView: 'dayGridMonth',
    height: 'auto',
    nowIndicator: true,
    firstDay: 1,
    selectable: true,
    headerToolbar: false,
    events: allEvents.map(asCalendarEvent),

    eventDisplay: 'block',
    displayEventTime: false,

    slotLabelContent: (arg) => formatTimeLower(arg.date),

    eventContent: (arg) => {
      const ext = arg.event.extendedProps || {};

      if (ext.type === 'Work') {
  const t = formatTimeLower(arg.event.start);

  const clientName = ext.clientId
    ? clients.find((c) => c.clientId === ext.clientId)?.name || ext.clientId
    : 'Work';

  const unpaid = isWorkUnpaid(ext);

  const wrap = document.createElement('div');
  wrap.style.lineHeight = '1.1';

  // 第1行：时间（用 FullCalendar 的 class，CSS更稳）
  const l1 = document.createElement('div');
  l1.className = 'fc-event-time';
  l1.textContent = t || '';
  wrap.appendChild(l1);

  // 第2行：客户名（关键：client-name）
  const l2 = document.createElement('span');
  l2.className = 'client-name';
  l2.textContent = clientName || '';
  wrap.appendChild(l2);

  // 第3行：未收款（如有）
  if (unpaid) {
    const l3 = document.createElement('span');
    l3.className = 'unpaid';
    l3.textContent = 'Unpaid';
    wrap.appendChild(l3);
  }

  return { domNodes: [wrap] };
}


      if (ext.type === 'Life') {
  const t = formatTimeLower(arg.event.start);
  const label = ext.title || ext.name || arg.event.title || 'Life';

  const wrap = document.createElement('div');
  wrap.style.lineHeight = '1.1';

  // 第1行：时间
  const l1 = document.createElement('div');
  l1.className = 'fc-event-time';
  l1.textContent = t || '';
  wrap.appendChild(l1);

  // 第2行：标题（复用你三行CSS里的“第二行”样式）
  const l2 = document.createElement('span');

  l2.textContent = label || 'Life';
  wrap.appendChild(l2);

  return { domNodes: [wrap] };
}


      return true;
    },

    eventClick: (info) => openModal('edit', info.event.extendedProps),
    dateClick: (info) => openModal('new', { date: info.dateStr, type: 'Work', start: '09:00' }),
    datesSet: () => {
      titlebar.textContent = calendar.view.title;
      syncSegButtons();
      renderMini(calendar.getDate());
    },
  });

  calendar.render();
  titlebar.textContent = calendar.view.title;
  renderMini(calendar.getDate());
}

// =============================
// Mini calendar (dots)
// =============================
function renderMini(anchorDate) {
  const box = document.getElementById('miniCal');
  box.innerHTML = '';

  const d = new Date(anchorDate);
  const year = d.getFullYear();
  const month = d.getMonth();
  const monthName = d.toLocaleString('zh-CN', { month: 'long' });

  const head = document.createElement('div');
  head.className = 'mini';
  head.innerHTML = `
    <div class="mini-head">
      <button class="btn btn-ghost" id="miniPrev">◀</button>
      <span>${year}年${monthName}</span>
      <button class="btn btn-ghost" id="miniNext">▶</button>
    </div>
    <div class="grid" id="miniGrid"></div>
  `;
  box.appendChild(head);

  const grid = head.querySelector('#miniGrid');
  const first = new Date(year, month, 1);
  const startWeekday = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const dow = ['一', '二', '三', '四', '五', '六', '日'];
  dow.forEach((x) => {
    const cell = document.createElement('div');
    cell.className = 'd';
    cell.style.cursor = 'default';
    cell.style.color = '#9ca3af';
    cell.textContent = x;
    grid.appendChild(cell);
  });

  for (let i = 0; i < startWeekday; i++) {
    const empty = document.createElement('div');
    empty.className = 'd';
    empty.textContent = '';
    empty.style.cursor = 'default';
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement('div');
    cell.className = 'd';

    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const num = document.createElement('div');
    num.textContent = String(day);
    cell.appendChild(num);

    const types = new Set(allEvents.filter((e) => e.date === iso).map((e) => e.type));
    if (types.size) {
      const dots = document.createElement('div');
      dots.style.display = 'flex';
      dots.style.justifyContent = 'center';
      dots.style.gap = '3px';
      dots.style.marginTop = '2px';

      types.forEach((t) => {
        const dot = document.createElement('span');
        dot.style.width = '6px';
        dot.style.height = '6px';
        dot.style.borderRadius = '50%';
        dot.style.display = 'inline-block';
        dot.style.background = typeColor(t);
        dots.appendChild(dot);
      });

      cell.appendChild(dots);
    }

    cell.onclick = () => calendar.gotoDate(iso);

    const now = new Date();
    if (year === now.getFullYear() && month === now.getMonth() && day === now.getDate()) {
      cell.style.background = 'rgba(10,132,255,.12)';
      cell.style.color = '#111827';
      cell.style.fontWeight = '700';
      cell.style.borderRadius = '10px';
    }

    grid.appendChild(cell);
  }

  head.querySelector('#miniPrev').onclick = () => calendar.gotoDate(new Date(year, month - 1, 1));
  head.querySelector('#miniNext').onclick = () => calendar.gotoDate(new Date(year, month + 1, 1));
}

// =============================
// Modal
// =============================
function clearForm() {
  editingId = null;
  typeEl.value = 'Work';
  dateEl.value = '';
  startEl.value = '';
  durationEl.value = '';
  clientEl.value = '';
  titleEl.value = '';
  amountEl.value = '';
  categoryEl.value = '';
  if (repeatEl) repeatEl.value = 'none';
  validationHint.textContent = '';
  deleteBtn.style.display = 'none';
  updateClientAddressUI();
  clearAttachmentState();
}

function applyTypeUI() {
  const t = typeEl.value;
  // ✅ 只在 Work 显示「排班/草稿」，Life / Expense 隐藏
  if (saveDraftBtn) {
    saveDraftBtn.style.display = (t === 'Work') ? 'inline-flex' : 'none';
  }

  startField.classList.remove('hidden');
  durationField.classList.remove('hidden');
  clientField.classList.remove('hidden');
  amountField.classList.remove('hidden');
  categoryField.classList.remove('hidden');
  if (repeatField) repeatField.classList.remove('hidden');
  if (attachmentField) attachmentField.classList.remove('hidden');

  if (t === 'Work') {
    categoryField.classList.add('hidden');
    durationField.classList.remove('hidden');
    amountField.classList.remove('hidden');
    clientField.classList.remove('hidden');
    if (repeatField) repeatField.classList.remove('hidden');
    durationHelp.textContent = 'Work：完工后必填（排班阶段可先空着）。';
    updateClientAddressUI();
  }

  if (t === 'Expense') {
    startField.classList.add('hidden');
    durationField.classList.add('hidden');
    clientField.classList.add('hidden');
    amountField.classList.remove('hidden');
    categoryField.classList.remove('hidden');
    if (repeatField) repeatField.classList.add('hidden');
    if (clientAddressBox) clientAddressBox.style.display = 'none';
    durationHelp.textContent = '';
  }

  if (t === 'Life') {
    clientField.classList.add('hidden');
    amountField.classList.add('hidden');
    categoryField.classList.add('hidden');

    startField.classList.remove('hidden');
    durationField.classList.add('hidden');
    durationEl.value = '';

    if (repeatField) repeatField.classList.add('hidden');
    if (clientAddressBox) clientAddressBox.style.display = 'none';
    durationHelp.textContent = '';

    // Life 不显示附件
    if (attachmentField) attachmentField.classList.add('hidden');
  }
}

function openModal(mode, preset = {}) {
  clearForm();
  overlay.style.display = 'flex';

  if (mode === 'edit') {
    editingId = preset.id;
    deleteBtn.style.display = 'inline-flex';

    typeEl.value = preset.type || 'Work';
    dateEl.value = preset.date || '';
    startEl.value = preset.start || '';
    durationEl.value = preset.duration ?? '';
    clientEl.value = preset.clientId || '';
    titleEl.value = preset.title || '';
    amountEl.value = preset.amount ?? '';
    categoryEl.value = preset.category || '';
    if (repeatEl) repeatEl.value = 'none';
  } else {
    typeEl.value = preset.type || 'Work';
    dateEl.value = preset.date || new Date().toISOString().slice(0, 10);
    startEl.value = preset.start || '09:00';
    if (repeatEl) repeatEl.value = 'none';
  }

  applyTypeUI();
  updateClientAddressUI();

  // ✅ 显示已存在附件（edit 模式）
  const row = getEditingRowSnapshot();
  renderAttachmentPreviewForRow(row);
}

function closeModal() {
  overlay.style.display = 'none';
  clearAttachmentState();
}

function validate(canDraft = false) {
  const t = typeEl.value;

  if (!dateEl.value) return { ok: false, msg: 'Date 必填。' };

  if (t === 'Work') {
    if (!startEl.value) return { ok: false, msg: 'Work：Start 必填。' };
    if (!clientEl.value || clientEl.value === '__new__') {
      return { ok: false, msg: 'Work：Client 必填（请选择或新建客户）。' };
    }
    if (!canDraft) {
      if (durationEl.value === '' || Number(durationEl.value) <= 0)
        return { ok: false, msg: 'Work：完工保存需要填写 Duration（>0）。' };
      if (amountEl.value === '' || Number(amountEl.value) <= 0)
        return { ok: false, msg: 'Work：完工保存需要填写 Amount（>0）。' };
    }
  }

  if (t === 'Expense') {
    if (amountEl.value === '' || Number(amountEl.value) <= 0)
      return { ok: false, msg: 'Expense：Amount 必填（>0）。' };
    if (!categoryEl.value) return { ok: false, msg: 'Expense：Category 必选。' };

    // ✅ Expense 必须有至少 1 张附件（含已有 + 新选）
    const row = getEditingRowSnapshot();
    const existingCount = Array.isArray(row?.attachments)
      ? row.attachments.filter(a => a?.fileId && !deletedAttachmentFileIds.has(a.fileId)).length
      : 0;
    const total = existingCount + pendingFiles.length;

    if (total <= 0) return { ok: false, msg: 'Expense：请上传至少 1 张票据照片（需要 Google 登录）。' };
    if (!gAccessToken) return { ok: false, msg: '请先点击左上角 Google 登录，再上传票据附件。' };
  }

  if (t === 'Life') {
    if (!startEl.value) return { ok: false, msg: 'Life：Start 必填。' };
  }

  return { ok: true, msg: '' };
}

// Repeat dates
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function generateRepeatDates(baseDate, rule) {
  if (rule === 'weekly') return Array.from({ length: REPEAT_TOTAL }, (_, i) => addDays(baseDate, i * 7));
  if (rule === 'fortnightly') return Array.from({ length: REPEAT_TOTAL }, (_, i) => addDays(baseDate, i * 14));
  return [baseDate];
}

// Build row
function buildRowFromForm(isDraft) {
  const t = typeEl.value;
  const base = {
    id: editingId || uid(),
    type: t,
    date: dateEl.value,
    start: startEl.value || '',
    title: (titleEl.value || '').trim(),
    attachments: [] // Sprint2
  };

  if (t === 'Work') {
    base.clientId = clientEl.value || '';
    base.duration = isDraft ? '' : (durationEl.value ?? '');
    base.amount = (amountEl.value ?? '');
    base.category = '';
  } else if (t === 'Expense') {
    base.amount = amountEl.value ?? '';
    base.category = categoryEl.value || '';
    base.clientId = '';
    base.duration = '';
    base.start = '';
  } else if (t === 'Life') {
    base.clientId = '';
    base.amount = '';
    base.category = '';
    base.duration = '';
  }

  base.isDraft = !!isDraft;
  return base;
}

function upsertRow(row) {
  const idx = allEvents.findIndex((e) => e.id === row.id);
  if (idx >= 0) allEvents[idx] = row;
  else allEvents.push(row);
  saveEvents(allEvents);
}

function removeRow(id) {
  allEvents = allEvents.filter((e) => e.id !== id);
  saveEvents(allEvents);
}

// ✅ 保存：先处理附件（上传/删除）再写入事件
async function handleSave(isDraft) {
  const v = validate(isDraft);
  if (!v.ok) {
    validationHint.textContent = v.msg;
    return;
  }
  validationHint.textContent = '';

  const t = typeEl.value;
  const isNew = !editingId;

  // 先取“旧行”（编辑时需要保留旧附件）
  const oldRow = getEditingRowSnapshot();

  async function composeRowForDate(dateOverride = null) {
    const row = buildRowFromForm(isDraft);
    if (dateOverride) row.date = dateOverride;

    // 1) 合并旧附件（扣掉被删除的）
    const kept = Array.isArray(oldRow?.attachments)
      ? oldRow.attachments.filter(a => a?.fileId && !deletedAttachmentFileIds.has(a.fileId))
      : [];

    // 2) 删除附件：真实删除 Drive 文件（需要登录）
    if (gAccessToken && deletedAttachmentFileIds.size > 0) {
      for (const fid of deletedAttachmentFileIds) {
        try { await deleteAttachmentFile(fid); } catch(e){ console.error(e); }
      }
    }

    // 3) 上传新选择的图片（需要登录）
    let uploaded = [];
    if (pendingFiles.length > 0) {
      if (!gAccessToken) {
        throw new Error('请先 Google 登录后再上传附件。');
      }
      setCloudStatus('云端：上传附件中…');
      for (const f of pendingFiles) {
        const meta = await uploadAttachmentFile(f, row);
        uploaded.push(meta);
      }
      setCloudStatus('云端：附件已上传');
    }

    row.attachments = kept.concat(uploaded);

    // 4) 规则：Life 不保存附件（安全）
    if (row.type === 'Life') row.attachments = [];

    return row;
  }

  try {
    if (t === 'Work' && isNew && repeatEl && repeatEl.value !== 'none') {
      const dates = generateRepeatDates(dateEl.value, repeatEl.value);
      for (const d of dates) {
        const row = await composeRowForDate(d);
        row.id = uid(); // 每条重复都要独立 id
        // ✅ 重复排班只要“时间+客户”，不要把完工数据强行复制
        if (row.type === 'Work') {
          row.duration = '';
          row.amount = '';
          row.isDraft = true;
          row.attachments = []; // 重复排班不复制图片
        }
        upsertRow(row);
      }
    } else {
      const row = await composeRowForDate(null);
      upsertRow(row);
    }

    allEvents = loadEvents();
    refreshCalendar();
    renderMini(calendar.getDate());
    closeModal();
  } catch (e) {
    console.error(e);
    validationHint.textContent = e.message || '保存失败（看控制台）';
    setCloudStatus('云端：操作失败（看控制台）', false);
  }
}

async function handleDelete() {
  if (!editingId) return;
  if (!confirm('确定删除这个事件吗？')) return;

  // 删除事件时：也尽量删掉附件文件（你自己的 Drive 文件，避免堆积）
  const row = getEditingRowSnapshot();
  if (gAccessToken && Array.isArray(row?.attachments)) {
    for (const att of row.attachments) {
      if (!att?.fileId) continue;
      try { await deleteAttachmentFile(att.fileId); } catch(e){ console.error(e); }
    }
  }

  removeRow(editingId);
  allEvents = loadEvents();
  refreshCalendar();
  renderMini(calendar.getDate());
  closeModal();
}

// =============================
// Export CSV（保持你原导出）
// =============================
function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function getExportRangeMs() {
  const s = document.getElementById('exportStart')?.value || '';
  const e = document.getElementById('exportEnd')?.value || '';

  // 都不填 = 不筛选
  if (!s && !e) return { startMs: null, endMs: null };

  // 统一按“日期”比较（包含边界）
  const startMs = s ? new Date(s + 'T00:00:00').getTime() : null;
  const endMs = e ? new Date(e + 'T23:59:59').getTime() : null;
  return { startMs, endMs };
}

function inExportRange(dateStr, range) {
  if (!range || (!range.startMs && !range.endMs)) return true;
  if (!dateStr) return false;
  const ms = new Date(dateStr + 'T12:00:00').getTime(); // 中午避免时区边界问题
  if (range.startMs && ms < range.startMs) return false;
  if (range.endMs && ms > range.endMs) return false;
  return true;
}


function exportMyView() {
  // 更稳：导出前读一次最新本地数据
  allEvents = loadEvents();

  const range = getExportRangeMs();

  // ✅ clientName（不是 clientId） + ✅ attachmentLinks（不是 count）
  const head = [
    'date','type','start','duration',
    'clientName','amount','category','title',
    'isDraft','attachmentLinks'
  ];
  const rows = [head];

  allEvents.forEach((r) => {
    // ✅ 验收关键：按时间范围筛选
    if (!inExportRange(r.date, range)) return;

    const clientName = r.clientId
      ? (findClient(r.clientId)?.name || r.clientId)
      : '';

    // ✅ 附件：导出 Drive 查看链接（多张用 | 分隔）
    const atts = Array.isArray(r.attachments) ? r.attachments : [];
    const links = atts
      .map(a => a?.webViewLink || (a?.fileId ? `https://drive.google.com/file/d/${a.fileId}/view` : ''))
      .filter(Boolean)
      .join(' | ');

    rows.push([
      r.date || '',
      r.type || '',
      r.start || '',
      r.duration ?? '',
      clientName,
      r.amount ?? '',
      r.category || '',
      r.title || '',
      r.isDraft ? '1' : '0',
      links
    ]);
  });

  downloadCSV('My_View.csv', rows);
}



function exportTax() {
  const range = getExportRangeMs();

  // 严格 7 列（验收标准）
  const head = ['Date', 'Type', 'ClientName', 'Duration', 'Amount', 'Category', 'AttachmentLink'];
  const rows = [head];

  allEvents.forEach((r) => {
    if (!inExportRange(r.date, range)) return;

    // 只 Work / Expense
    if (r.type !== 'Work' && r.type !== 'Expense') return;

    const clientName = r.clientId
      ? (clients.find((c) => c.clientId === r.clientId)?.name || '')
      : '';

   if (r.type === 'Work') {
  // ✅ 新规则：只要有 amount（且>0）就导出
  if (r.amount == null || r.amount === '') return;

  const amt = Number(r.amount);
  if (!Number.isFinite(amt) || amt <= 0) return;

  // Duration 允许为空；有就导出数字，没有就空着
  let durStr = '';
  if (r.duration != null && r.duration !== '') {
    const dur = Number(r.duration);
    if (Number.isFinite(dur) && dur > 0) durStr = dur.toString();
  }

  rows.push([r.date || '', 'Work', clientName, durStr, amt.toFixed(2), '', '']);
  return;
}


    if (r.type === 'Expense') {
      // Expense：金额+分类+票据（你的系统里票据现在是 attachments 数组）
      const amt = Number(r.amount);
      if (!Number.isFinite(amt) || amt <= 0) return;
      if (!r.category) return;

      const atts = Array.isArray(r.attachments) ? r.attachments : [];
      if (atts.length === 0) return;

      // 生成可查看链接（优先用 webViewLink，其次拼 fileId）
      const links = atts
        .map(a => a?.webViewLink || (a?.fileId ? `https://drive.google.com/file/d/${a.fileId}/view` : ''))
        .filter(Boolean)
        .join(' | ');

      if (!links) return;

      rows.push([r.date || '', 'Expense', clientName, '', amt.toFixed(2), r.category || '', links]);
    }
  });

  downloadCSV('Tax_Export.csv', rows);
}

// =============================
// Bindings
// =============================
addBtn.addEventListener('click', () => openModal('new', { type: 'Work' }));
closeBtn.addEventListener('click', closeModal);

typeEl.addEventListener('change', () => {
  applyTypeUI();
  validationHint.textContent = '';
  // type 切换时也刷新附件显示
  renderAttachmentPreviewForRow(getEditingRowSnapshot());
});

saveBtn.addEventListener('click', () => handleSave(false));
saveDraftBtn.addEventListener('click', () => handleSave(true));
deleteBtn.addEventListener('click', handleDelete);
const cleanupBtn = document.getElementById('cleanupBtn');
if (cleanupBtn) cleanupBtn.addEventListener('click', cleanupOrphanAttachments);


// 顶部导航
document.getElementById('prevBtn').addEventListener('click', () => calendar.prev());
document.getElementById('nextBtn').addEventListener('click', () => calendar.next());
document.getElementById('todayBtn').addEventListener('click', () => calendar.today());

document.querySelectorAll('.seg button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.getAttribute('data-view');
    calendar.changeView(view);
    syncSegButtons();
  });
});

// 导出
document.getElementById('exportMyViewBtn').addEventListener('click', exportMyView);
document.getElementById('exportTaxBtn').addEventListener('click', exportTax);

// =============================
// Start
// =============================
initCalendar();
initGoogleLogin();
setTimeout(autoConnectOnLoad, 800);
// 页面打开默认提示：不打扰你，但给你安全感
setCloudStatus(gAccessToken ? '云端：已连接' : '本地：未连接（数据会先保存在本地）', !gAccessToken ? true : true);
setCloudStatus('在线：未连接云端（数据会先保存在本地）', true);
window.addEventListener('offline', () => setCloudStatus('离线：本地保存中（联网后自动同步）', true));
window.addEventListener('online',  () => setCloudStatus(gAccessToken ? '云端：已连接' : '在线：未连接云端（点一次登录即可）', true));
// ✅ 新增：启动后台补同步循环
startBackgroundSyncLoop();