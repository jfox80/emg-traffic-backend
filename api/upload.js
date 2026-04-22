const APPSHEET_APP_ID  = 'e7f17c0c-6128-4a5f-9b6a-70253a7dd589';
const APPSHEET_API_KEY = process.env.APPSHEET_API_KEY;
const APPSHEET_TABLE   = 'Form Data';

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY    = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const GOOGLE_SHEET_ID           = '11tHHhooqQ7tE1sbXQA_hVZKk2WIOoTqGQqQnqwF2kxI';
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY           = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const SHEET_NAME                = 'Form Data';
const LAYOUT_MOD_COLUMN         = 'S';
const FORM_ID_COLUMN            = 'AO';

// ── Service Account OAuth2 token ──────────────────────────────────────────────
async function getServiceAccountToken() {
  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    iss:   GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };

  // Encode JWT header and payload
  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body    = base64url(JSON.stringify(payload));
  const signing = `${header}.${body}`;

  // Sign with private key using RS256
  const keyData    = GOOGLE_PRIVATE_KEY;
  const cryptoKey  = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(keyData),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature  = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signing)
  );
  const jwt = `${signing}.${base64url(signature)}`;

  // Exchange JWT for access token
  const tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(`Token error: ${tokenData.error_description}`);
  return tokenData.access_token;
}

function base64url(data) {
  let str;
  if (typeof data === 'string') {
    str = btoa(unescape(encodeURIComponent(data)));
  } else {
    // ArrayBuffer
    const bytes = new Uint8Array(data);
    let binary  = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    str = btoa(binary);
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN[^-]+-----/, '')
    .replace(/-----END[^-]+-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── Write image URL directly to Google Sheet ──────────────────────────────────
async function writeImageUrlToSheet(formId, imageUrl) {
  try {
    const token = await getServiceAccountToken();

    // Read FormID column to find matching row
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${SHEET_NAME}!${FORM_ID_COLUMN}:${FORM_ID_COLUMN}`;
    const readRes = await fetch(readUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const readData = await readRes.json();

    if (!readData.values) {
      console.error('No values found in FormID column');
      return false;
    }

    // Find matching row (1-based)
    let rowIndex = -1;
    for (let i = 0; i < readData.values.length; i++) {
      if (readData.values[i][0] && readData.values[i][0].trim() === formId.trim()) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      console.error('FormID not found in sheet:', formId);
      return false;
    }

    console.log(`Found FormID ${formId} at row ${rowIndex}, writing to column S`);

    // Write image URL to column S
    const range    = `${SHEET_NAME}!${LAYOUT_MOD_COLUMN}${rowIndex}`;
    const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    const writeRes = await fetch(writeUrl, {
      method:  'PUT',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ range, values: [[imageUrl]] }),
    });

    const writeData = await writeRes.json();
    if (writeData.error) {
      console.error('Sheets write error:', JSON.stringify(writeData.error));
      return false;
    }

    console.log('Sheet write success:', writeData.updatedRange);
    return true;
  } catch (err) {
    console.error('writeImageUrlToSheet error:', err.message);
    return false;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET')     return res.status(200).json({ success: true, message: 'EMG Traffic Plan API is running' });
  if (req.method !== 'POST')    return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { planImageBase64, planInfo = {}, placedSigns = [] } = req.body;

  if (!planImageBase64) {
    return res.status(400).json({ success: false, error: 'No image data provided' });
  }

  console.log('Received plan. Image chars:', planImageBase64.length);
  console.log('FormID received:', planInfo.formId || 'none — will Add new row');
  console.log('computedKey received:', planInfo.computedKey);

  // Step 1: Upload to Cloudinary
  let imageUrl = null;
  try {
    imageUrl = await uploadToCloudinary(planImageBase64);
    console.log('Cloudinary upload success:', imageUrl);
  } catch (err) {
    console.error('Cloudinary upload failed:', err.message);
    return res.status(500).json({ success: false, error: 'Image upload failed: ' + err.message });
  }

  const isEdit = !!(planInfo.formId);

  // Step 2: Write image URL directly to Google Sheet if editing
  if (isEdit) {
    const sheetWriteSuccess = await writeImageUrlToSheet(planInfo.formId, imageUrl);
    console.log('Sheet write result:', sheetWriteSuccess);

    if (sheetWriteSuccess) {
      return res.status(200).json({
        success: true,
        message: 'Traffic plan updated successfully',
        imageUrl,
      });
    }
  }

  // Step 3: Build AppSheet row (for new Add, or if sheet write failed)
  const now     = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0];
  const action  = isEdit ? 'Edit' : 'Add';
  console.log('AppSheet action:', action);

  const rowData = {
    'Date?':               dateStr,
    'Time?':               timeStr,
    'Work Zone Location?': planInfo.workZoneLocation || '43.6532,-79.3832',
    'Posted Speed?':       '60 km/hr',
    'Typical Layout Used': planInfo.layoutTitle      || 'Custom',
    'Modified?':           'Yes',
    'Layout Modification': imageUrl,
    'Safety Talk?':        'No',
    'Notes':               placedSigns.length
                             ? `Signs placed: ${placedSigns.map(s => s.id).join(', ')}`
                             : '',
  };

  if (isEdit) {
    rowData['FormID'] = planInfo.formId;
    delete rowData['Date?'];
    delete rowData['Time?'];
  }

  if (planInfo.roadType)      rowData['Road Type?']      = planInfo.roadType;
  if (planInfo.roadComponent) rowData['Road Component?'] = planInfo.roadComponent;

  console.log('Keys being sent:', Object.keys(rowData).join(', '));

  // Step 4: Send to AppSheet
  const result = await uploadToAppSheet(rowData, action);
  console.log('AppSheet result:', JSON.stringify(result).slice(0, 300));

  if (result.success) {
    return res.status(200).json({
      success: true,
      message: `Traffic plan ${isEdit ? 'updated' : 'uploaded'} successfully`,
      imageUrl,
    });
  }

  return res.status(500).json({
    success: false,
    error:   result.error   || 'AppSheet upload failed',
    details: result.details || null,
  });
}

// ── Cloudinary ────────────────────────────────────────────────────────────────
async function uploadToCloudinary(base64Image) {
  const timestamp    = Math.round(Date.now() / 1000);
  const folder       = 'emg-traffic-plans';
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature    = await sha1(paramsToSign);

  const formData = new URLSearchParams();
  formData.append('file',      `data:image/jpeg;base64,${base64Image}`);
  formData.append('api_key',   CLOUDINARY_API_KEY);
  formData.append('timestamp', timestamp.toString());
  formData.append('signature', signature);
  formData.append('folder',    folder);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: 'POST', body: formData }
  );
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || `Cloudinary error ${response.status}`);
  return data.secure_url;
}

// ── SHA-1 ─────────────────────────────────────────────────────────────────────
async function sha1(message) {
  const msgBuffer  = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── AppSheet API ──────────────────────────────────────────────────────────────
async function uploadToAppSheet(rowData, action = 'Add') {
  const url     = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/${encodeURIComponent(APPSHEET_TABLE)}/Action`;
  const payload = {
    Action:     action,
    Properties: { Locale: 'en-US', RunAsUserEmail: 'jmfox14@asu.edu' },
    Rows:       [rowData],
  };

  let response;
  try {
    response = await fetch(url, {
      method:  'POST',
      headers: { 'applicationAccessKey': APPSHEET_API_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Network error calling AppSheet:', err);
    return { success: false, error: err.message };
  }

  const responseText = await response.text();
  console.log('AppSheet status:', response.status);
  console.log('AppSheet body:',   responseText.slice(0, 500));

  if (response.status === 200) {
    try   { return { success: true, appsheetResponse: JSON.parse(responseText) }; }
    catch { return { success: true, appsheetResponse: responseText }; }
  }

  const statusMessages = {
    400: 'Bad request — a required column may be missing or misnamed',
    401: 'Unauthorised — API key is wrong or revoked',
    403: 'Forbidden — API key does not match, or API not enabled in AppSheet',
    404: 'Not found — check APP_ID and table name',
    429: 'Rate limited — try again in a moment',
  };

  return {
    success: false,
    error:   statusMessages[response.status] || `AppSheet returned status ${response.status}`,
    details: responseText,
  };
}
