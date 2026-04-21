const APPSHEET_APP_ID  = 'e7f17c0c-6128-4a5f-9b6a-70253a7dd589';
const APPSHEET_API_KEY = process.env.APPSHEET_API_KEY;
const APPSHEET_TABLE   = 'Form Data';

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET')     return res.status(200).json({ success: true, message: 'EMG Traffic Plan API is running' });
  if (req.method !== 'POST')    return res.status(405).json({ success: false, error: 'Method not allowed' });

  // ── Parse body ─────────────────────────────────────────────────────────────
  const { planImageBase64, planInfo = {}, placedSigns = [] } = req.body;

  if (!planImageBase64) {
    return res.status(400).json({ success: false, error: 'No image data provided' });
  }

  console.log('Received plan. Image chars:', planImageBase64.length);

  // ── Timestamps ─────────────────────────────────────────────────────────────
  const now       = new Date();
  const dateStr   = now.toISOString().split('T')[0];
  const timeStr   = now.toTimeString().split(' ')[0];
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const filename  = `TrafficPlan_${timestamp}.jpeg`;

  // ── Row data — only fields we know AppSheet accepts ───────────────────────
  const rowData = {
    'Date?':               dateStr,
    'Time?':               timeStr,
    'Work Zone Location?': planInfo.workZoneLocation || '43.6532,-79.3832',
    'Posted Speed?':       '60 km/hr',
    'Typical Layout Used': planInfo.layoutTitle || 'Custom',
    'Modified?':           'Yes',
    'Layout Modification': {
      FileName:      filename,
      FileExtension: 'jpeg',
      FileData:      planImageBase64,
    },
    'Safety Talk?':        'No',
    'Notes':               placedSigns.length
                             ? `Signs placed: ${placedSigns.map(s => s.id).join(', ')}`
                             : '',
  };

  // Add optional fields only if they have values
  if (planInfo.roadType)      rowData['Road Type?']      = planInfo.roadType;
  if (planInfo.roadComponent) rowData['Road Component?'] = planInfo.roadComponent;

  console.log('Keys being sent:', Object.keys(rowData).join(', '));

  // ── Call AppSheet ──────────────────────────────────────────────────────────
  const result = await uploadToAppSheet(rowData);
  console.log('AppSheet result:', JSON.stringify(result).slice(0, 300));

  if (result.success) {
    return res.status(200).json({ success: true, message: 'Traffic plan uploaded successfully' });
  }

  return res.status(500).json({
    success: false,
    error:   result.error   || 'AppSheet upload failed',
    details: result.details || null,
  });
}

// ── AppSheet API ───────────────────────────────────────────────────────────
async function uploadToAppSheet(rowData) {
  const url = `https://api.appsheet.com/api/v2/apps/${APPSHEET_APP_ID}/tables/${encodeURIComponent(APPSHEET_TABLE)}/Action`;

  const payload = {
    Action:     'Add',
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
