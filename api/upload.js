const APPSHEET_APP_ID  = 'e7f17c0c-6128-4a5f-9b6a-70253a7dd589';
const APPSHEET_API_KEY = process.env.APPSHEET_API_KEY;
const APPSHEET_TABLE   = 'Form Data';

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY    = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

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

  // Step 2: Build row
  const now     = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0];

  const isEdit = !!(planInfo.formId);
  const action = isEdit ? 'Edit' : 'Add';
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
    rowData['_ComputedKey'] = planInfo.computedKey;
    // Also set Time? to the original time so _ComputedKey stays consistent
    // computedKey format is "HH:MM:SS: formId"
    const originalTime = planInfo.computedKey.split(': ')[0].trim();
    rowData['Time?'] = originalTime;
}

  if (planInfo.roadType)      rowData['Road Type?']      = planInfo.roadType;
  if (planInfo.roadComponent) rowData['Road Component?'] = planInfo.roadComponent;

  console.log('Keys being sent:', Object.keys(rowData).join(', '));

  // Step 3: Send to AppSheet
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

async function uploadToCloudinary(base64Image) {
  const timestamp = Math.round(Date.now() / 1000);
  const folder    = 'emg-traffic-plans';
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
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Cloudinary error ${response.status}`);
  }
  return data.secure_url;
}

async function sha1(message) {
  const msgBuffer  = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function uploadToAppSheet(rowData, action = 'Add') {
  const url = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/${encodeURIComponent(APPSHEET_TABLE)}/Action`;

  const payload = {
    Action:     action,
    Properties: {},
    Rows:       [rowData],
  };

  let response;
  try {
    response = await fetch(url, {
      method:  'POST',
      headers: {
        'applicationAccessKey': APPSHEET_API_KEY,
        'Content-Type':         'application/json',
      },
      body: JSON.stringify(payload),
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
