// driveShared.js
// Shared Google Drive helpers for Krisy Calendar + Invoice pages
// Goal: keep minimal, reuse existing Drive folder "KrisyCalendar", store JSON files.

(function(){
  const DEFAULT_CLIENT_ID = '878262614270-u7cslu4of0lef4us7d94aj9m1s6de6hk.apps.googleusercontent.com';
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

  const DRIVE_ROOT_FOLDER_NAME = 'KrisyCalendar';
  const LS_KEY_EVER_SIGNED_IN = 'krisy_ever_signed_in_v1';
  const LS_KEY_DRIVE_ROOT_ID = 'krisy_drive_root_id_v1';

  // cache per json file name
  const fileIdKey = (name)=> `krisy_drive_file_id_${name}`;

  let clientId = DEFAULT_CLIENT_ID;
  let accessToken = '';
  let tokenClient = null;
  let initDone = false;

  function log(...args){ /* console.log('[DriveShared]', ...args); */ }
  function err(...args){ console.warn('[DriveShared]', ...args); }

  function isGsiReady(){
    return typeof window.google !== 'undefined' && window.google.accounts && window.google.accounts.oauth2;
  }

  function ensureTokenClient(){
    if (tokenClient || !isGsiReady()) return tokenClient;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp && resp.access_token){
          accessToken = resp.access_token;
          localStorage.setItem(LS_KEY_EVER_SIGNED_IN, '1');
        }
      }
    });
    return tokenClient;
  }

  async function ensureAccessToken(interactive=false){
    if (accessToken) return accessToken;
    ensureTokenClient();
    if (!tokenClient) throw new Error('Google Identity Services not ready');

    // If user never signed in before, silent request likely fails; avoid spam.
    if (!interactive && !localStorage.getItem(LS_KEY_EVER_SIGNED_IN)){
      throw new Error('Not signed in yet');
    }

    return await new Promise((resolve, reject)=>{
      const prevCb = tokenClient.callback;
      tokenClient.callback = (resp)=>{
        // restore
        tokenClient.callback = prevCb;
        if (resp && resp.access_token){
          accessToken = resp.access_token;
          localStorage.setItem(LS_KEY_EVER_SIGNED_IN, '1');
          resolve(accessToken);
        }else{
          reject(new Error(resp?.error || 'Token error'));
        }
      };
      try{
        tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      }catch(e){
        tokenClient.callback = prevCb;
        reject(e);
      }
    });
  }

  async function driveFetch(url, options={}){
    const token = await ensureAccessToken(false);
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(url, { ...options, headers });
    if (!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error(`Drive API ${res.status}: ${t}`);
    }
    return res;
  }

  async function driveSearchFiles(q, fields='files(id,name,modifiedTime,parents)'){
    const params = new URLSearchParams({
      q,
      fields,
      pageSize: '10',
      spaces: 'drive',
      orderBy: 'modifiedTime desc',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
    });
    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
    const res = await driveFetch(url);
    const data = await res.json();
    return data.files || [];
  }

  async function driveCreateFolder(name){
    const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
    const res = await driveFetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta)
    });
    const data = await res.json();
    return data.id;
  }

  async function ensureRootFolder(){
    const cached = localStorage.getItem(LS_KEY_DRIVE_ROOT_ID);
    if (cached) return cached;

    const q = [
      `name='${DRIVE_ROOT_FOLDER_NAME}'`,
      "mimeType='application/vnd.google-apps.folder'",
      'trashed=false'
    ].join(' and ');
    const files = await driveSearchFiles(q);
    if (files[0]?.id){
      localStorage.setItem(LS_KEY_DRIVE_ROOT_ID, files[0].id);
      return files[0].id;
    }
    const id = await driveCreateFolder(DRIVE_ROOT_FOLDER_NAME);
    localStorage.setItem(LS_KEY_DRIVE_ROOT_ID, id);
    return id;
  }

  async function findJsonFileId(fileName, parentId){
    const q = [
      `name='${fileName}'`,
      `'${parentId}' in parents`,
      'trashed=false'
    ].join(' and ');
    const files = await driveSearchFiles(q);
    return files[0]?.id || '';
  }

  async function driveCreateJsonFile(fileName, parentId, jsonObj){
    const boundary = '-------314159265358979323846';
    const metadata = {
      name: fileName,
      parents: [parentId],
      mimeType: 'application/json'
    };
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${JSON.stringify(jsonObj ?? [])}\r\n` +
      `--${boundary}--`;

    const res = await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      }
    );
    const data = await res.json();
    return data.id;
  }

  async function ensureJsonFile(fileName){
    const cached = localStorage.getItem(fileIdKey(fileName));
    if (cached) return cached;

    const rootId = await ensureRootFolder();
    const existingId = await findJsonFileId(fileName, rootId);
    if (existingId){
      localStorage.setItem(fileIdKey(fileName), existingId);
      return existingId;
    }
    const createdId = await driveCreateJsonFile(fileName, rootId, []);
    localStorage.setItem(fileIdKey(fileName), createdId);
    return createdId;
  }

  async function readJson(fileName){
    try{
      const fileId = await ensureJsonFile(fileName);
      const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`);
      const text = await res.text();
      return text ? JSON.parse(text) : [];
    }catch(e){
      err('readJson failed', e);
      throw e;
    }
  }

  async function writeJson(fileName, data){
    try{
      const fileId = await ensureJsonFile(fileName);
      const res = await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data ?? [])
        }
      );
      await res.json().catch(()=> ({}));
      return true;
    }catch(e){
      err('writeJson failed', e);
      throw e;
    }
  }

  async function trySyncJson(fileName, data){
    try{
      await writeJson(fileName, data);
      return true;
    }catch(_e){
      return false;
    }
  }

  function init(opts={}){
    if (initDone) return;
    initDone = true;

    clientId = opts.clientId || DEFAULT_CLIENT_ID;

    // Optional: if a login button exists, wire it.
    const loginBtnId = opts.loginBtnId;
    const statusElId = opts.statusElId;

    const statusEl = statusElId ? document.getElementById(statusElId) : null;
    const setStatus = (txt)=> { if(statusEl) statusEl.textContent = txt; };

    const btn = loginBtnId ? document.getElementById(loginBtnId) : null;
    if (btn){
      btn.addEventListener('click', async ()=>{
        try{
          setStatus('云端：连接中…');
          await ensureAccessToken(true);
          setStatus('云端：已连接');
        }catch(e){
          setStatus('云端：连接失败');
          alert('Google 登录失败：' + (e?.message || e));
        }
      });
    }

    // Silent attempt if ever signed in
    if (localStorage.getItem(LS_KEY_EVER_SIGNED_IN)){
      ensureAccessToken(false).then(()=>{
        setStatus('云端：已连接');
      }).catch(()=>{
        // keep quiet; user can click login if available
      });
    }
  }

  // Public API
  window.DriveShared = {
    init,
    ensureAccessToken,
    readJson,
    writeJson,
    trySyncJson
  };
})();
