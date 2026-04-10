const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { createServer } = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const httpServer = createServer(app);
const uploadsDir = path.join(__dirname, 'uploads');
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000
});

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const IMAGE_MODEL = process.env.IMAGE_MODEL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.AUDIO_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const AUDIO_MODEL = process.env.AUDIO_MODEL || GEMINI_MODEL;
const DEFAULT_SESSION_ID = 'default-session';
const OPENROUTER_TIMEOUT_MS = 90000;
const OPENROUTER_FALLBACK_MODEL = 'openrouter/free';

async function callOpenRouter(messages, model = IMAGE_MODEL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'Unable to generate a response.';
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(parts, model = GEMINI_MODEL) {
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API key is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts,
            }
          ]
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim();

    if (!text) {
      throw new Error('Gemini returned an empty response');
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function callTextModel(prompt) {
  if (GEMINI_API_KEY) {
    try {
      return await callGemini([{ text: prompt }], GEMINI_MODEL);
    } catch (error) {
      console.error('Gemini text request failed, falling back to OpenRouter:', error);
    }
  }

  const preferredModel = process.env.TEXT_MODEL || OPENROUTER_FALLBACK_MODEL;

  try {
    return await callOpenRouter([{ role: 'user', content: prompt }], preferredModel);
  } catch (error) {
    if (preferredModel !== OPENROUTER_FALLBACK_MODEL) {
      console.error('Primary OpenRouter model failed, retrying with free router:', error);
      return callOpenRouter([{ role: 'user', content: prompt }], OPENROUTER_FALLBACK_MODEL);
    }
    throw error;
  }
}

async function extractCleanQuestion(text) {
  const prompt = `The following text is raw OCR output from a camera image. Clean up the typos, identify the core question, and ignore any background noise text. Return only the sanitized question. Text: ${text}`;
  return await callTextModel(prompt);
}

function detectQuestionType(question) {
  const normalizedQuestion = question.toLowerCase();
  const codingSignals = [
    'javascript',
    'python',
    'java',
    'c++',
    'debug',
    'bug',
    'leetcode',
    'algorithm',
    'function',
    'array',
    'linked list',
    'binary tree',
    'stack',
    'queue',
    'complexity',
    'code',
    'runtime error',
    'compile',
    'test case'
  ];
  const academicSignals = [
    'finance',
    'management',
    'economics',
    'biology',
    'physics',
    'chemistry',
    'history',
    'capital budgeting',
    'npv',
    'irr',
    'strategy',
    'marketing',
    'accounting'
  ];

  if (codingSignals.some((signal) => normalizedQuestion.includes(signal))) {
    return 'coding';
  }

  if (academicSignals.some((signal) => normalizedQuestion.includes(signal))) {
    return 'academic';
  }

  return 'general';
}

function buildCodingPrompt(question) {
  return `/*
You are a senior software engineer helping with a coding or debugging problem.

Question:
${question}


Response Format (STRICT — follow exactly):

1. Explanation
- Write a clear, concise explanation of the approach.
- Keep it readable (2–4 short paragraphs max).
- Do NOT compress everything into one paragraph.
- Use spacing between paragraphs.

2. Code
- Provide the solution inside a proper fenced code block using triple backticks.
- Use the correct language tag (e.g., \`\`\`javascript).
- Preserve clean indentation and spacing exactly like production-quality code.
- Each statement should be on its own line.
- Avoid long horizontal lines.

- For comments:
  - Prefer line-by-line comments ABOVE the code line (not inline at the end).
  - Keep comments short and readable.
  
Example style:

\`\`\`javascript
// Explain what this line does
const x = 10;

// Explain next step
function test() {
  return x;
}
\`\`\`

3. Complexity
- Add a short section at the end:
Time Complexity: ...
Space Complexity: ...


Formatting Rules (VERY IMPORTANT):
- Always use proper markdown.
- Always use fenced code blocks (no plain text code).
- Always leave a blank line between sections.
- Do NOT collapse spacing.
- Do NOT write everything in one paragraph.
- Output should look clean and well-spaced, like in VS Code.

Tone:
- Keep it sharp, practical, and technically strong.
*/`
}


function buildAcademicPrompt(question, sourceMode) {
  if (sourceMode === 'audio') {
    return `/*
You are answering this in a high-level interview as a polished human candidate.

Question:
${question}


Response Structure (STRICT):

1. Direct Answer
- Start with a clear, confident answer in 2–3 lines.

2. Explanation
- Break into 2–4 short paragraphs.
- Each paragraph should focus on one idea.
- Maintain spacing between paragraphs.

3. Insight
- Add 1–2 thoughtful insights, trade-offs, or real-world implications.
- This should feel like something beyond a textbook answer.

4. Closing (optional)
- A short concluding line if it adds clarity.


Formatting Rules (CRITICAL):
- Do NOT write everything in one block.
- Use proper paragraph spacing.
- Keep sentences readable (avoid overly long lines).
- Maintain a natural speaking flow, but visually structured.

Constraints:
- Keep under 450 words.
- Avoid robotic phrasing.
- Avoid over-compression.


Goal:
- The answer should read like a strong candidate speaking clearly,
  while also looking clean and well-structured on screen.
*/`;
  }

  return `/*
You are a top-tier tutor answering an academic or factual question.

Question:
${question}


Response Structure (STRICT):

1. Core Answer
- Start with a clear definition or direct answer.

2. Explanation
- Break into 2–4 short paragraphs.
- Each paragraph should explain one part of the concept.
- Use spacing between paragraphs.

3. Insight / Nuance
- Add one strong insight, edge case, or real-world implication.

4. Optional Example
- Include a short example if it improves clarity.


Formatting Rules (CRITICAL):
- Do NOT compress into a single paragraph.
- Use proper paragraph breaks.
- Keep the structure clean and readable.
- Avoid dense, wall-of-text responses.

Constraints:
- Keep under 450 words.
- Be concise but not visually cramped.


Goal:
- The answer should feel authoritative, structured, and easy to read.
*/`;
}


async function solveQuestion(question, sourceMode = 'image') {
  const questionType = detectQuestionType(question);
  const prompt = questionType === 'coding'
    ? buildCodingPrompt(question)
    : buildAcademicPrompt(question, sourceMode);
  return await callTextModel(prompt);
}

const mimeTypeToAudioFormat = (mimeType, originalName = '') => {
  const normalizedMime = (mimeType || '').toLowerCase();
  const normalizedName = originalName.toLowerCase();

  if (normalizedMime.includes('wav') || normalizedName.endsWith('.wav')) {
    return 'wav';
  }
  if (normalizedMime.includes('mpeg') || normalizedMime.includes('mp3') || normalizedName.endsWith('.mp3')) {
    return 'mp3';
  }
  if (normalizedMime.includes('ogg') || normalizedName.endsWith('.ogg')) {
    return 'ogg';
  }
  if (normalizedMime.includes('aac') || normalizedName.endsWith('.aac')) {
    return 'aac';
  }
  if (normalizedMime.includes('m4a') || normalizedName.endsWith('.m4a')) {
    return 'm4a';
  }

  return 'wav';
};

async function transcribeAudioFile(filePath, mimeType, originalName) {
  const base64Audio = fs.readFileSync(filePath).toString('base64');
  const mimeTypeByFormat = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
    m4a: 'audio/mp4'
  };
  const format = mimeTypeToAudioFormat(mimeType, originalName);
  const resolvedMimeType = mimeTypeByFormat[format] || 'audio/wav';

  if (GEMINI_API_KEY) {
    return callGemini([
      { text: 'Generate a transcript of the speech. Return only the spoken words without commentary.' },
      {
        inline_data: {
          mime_type: resolvedMimeType,
          data: base64Audio
        }
      }
    ], AUDIO_MODEL);
  }

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Please transcribe this audio file. Return only the spoken words without commentary.'
        },
        {
          type: 'input_audio',
          input_audio: {
            data: base64Audio,
            format
          }
        }
      ]
    }
  ];

  return callOpenRouter(messages, AUDIO_MODEL);
}

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

const COOLDOWN_MS = 2000;
const MAX_AUDIO_SECONDS = 50;
const MAX_IMAGE_FILE_SIZE_BYTES = 8 * 1024 * 1024;

const users = {
  rec: { password: '1234', role: 'receiver' },
  tra: { password: '5678', role: 'transmitter' }
};

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : true
}));
app.use(express.json());

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = decoded;
    next();
  });
};

const requireRole = (role) => (req, res, next) => {
  if (req.user?.role !== role) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};

const safeUnlink = (filePath) => {
  if (!filePath) {
    return;
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error(`Failed to remove temp file ${filePath}:`, error);
  }
};

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ token, role: user.role });
});

app.get('/api/health', (req, res) => {
  res.send('OK');
});

app.get('/api/receiver-data', verifyToken, (req, res) => {
  if (req.user.role !== 'receiver') {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json({ message: 'Receiver data', role: req.user.role });
});

app.get('/api/transmitter-data', verifyToken, (req, res) => {
  if (req.user.role !== 'transmitter') {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json({ message: 'Transmitter data', role: req.user.role });
});

app.post('/api/upload', verifyToken, requireRole('transmitter'), upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const { requestId } = req.body;
  const requestEntry = requestId ? activeRequests.get(requestId) : null;

  if (!requestId || !requestEntry) {
    safeUnlink(req.file.path);
    return res.status(400).json({ error: 'Invalid request context' });
  }

  if (requestEntry.transmitterUsername !== req.user.username) {
    safeUnlink(req.file.path);
    return res.status(403).json({ error: 'Request does not belong to this transmitter' });
  }

  if (Date.now() - requestEntry.createdAt > REQUEST_TTL_MS) {
    activeRequests.delete(requestId);
    safeUnlink(req.file.path);
    emitRequestState(requestEntry.transmitterSocketId, 'request_complete', {
      requestId,
      mode: 'image'
    });
    return res.status(410).json({ error: 'Request expired' });
  }

  if (requestEntry.status !== 'capture_requested') {
    safeUnlink(req.file.path);
    return res.status(409).json({ error: 'Request is not ready for image upload' });
  }

  if ((requestEntry.lastActionAt || 0) + COOLDOWN_MS > Date.now()) {
    safeUnlink(req.file.path);
    return res.status(429).json({ error: 'Cooldown active. Please wait.' });
  }

  if (req.file.size > MAX_IMAGE_FILE_SIZE_BYTES) {
    safeUnlink(req.file.path);
    return res.status(400).json({ error: 'Image file too large' });
  }

  requestEntry.status = 'ocr_processing';
  requestEntry.lastActionAt = Date.now();
  emitRequestState(requestEntry.receiverSocketId, 'processing_started', {
    requestId,
    mode: 'image',
    stage: 'ocr'
  });

  let tempPath = null;

  try {
    const processedBuffer = await sharp(req.file.path)
      .grayscale()
      .linear(1.5, 0)
      .resize(2000)
      .toBuffer();

    tempPath = path.join(uploadsDir, `processed_${Date.now()}.jpg`);
    await sharp(processedBuffer).toFile(tempPath);

    const { data: { text } } = await Tesseract.recognize(tempPath, 'eng');

    requestEntry.status = 'ocr_complete';
    res.json({ requestId, text, message: 'OCR completed successfully' });
  } catch (error) {
    console.error('OCR error:', error);
    activeRequests.delete(requestId);
    emitRequestState(requestEntry.receiverSocketId, 'processing_failed', {
      requestId,
      mode: 'image',
      error: 'OCR processing failed'
    });
    emitRequestState(requestEntry.transmitterSocketId, 'request_complete', {
      requestId,
      mode: 'image'
    });
    res.status(500).json({ error: 'OCR processing failed' });
  } finally {
    safeUnlink(req.file.path);
    safeUnlink(tempPath);
  }
});

app.post('/api/audio', verifyToken, requireRole('transmitter'), upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio provided' });
  }

  const { requestId } = req.body;
  const requestEntry = requestId ? activeRequests.get(requestId) : null;

  if (!requestId || !requestEntry) {
    safeUnlink(req.file.path);
    return res.status(400).json({ error: 'Invalid request context' });
  }

  if (requestEntry.transmitterUsername !== req.user.username) {
    safeUnlink(req.file.path);
    return res.status(403).json({ error: 'Request does not belong to this transmitter' });
  }

  if (Date.now() - requestEntry.createdAt > REQUEST_TTL_MS) {
    activeRequests.delete(requestId);
    safeUnlink(req.file.path);
    emitRequestState(requestEntry.transmitterSocketId, 'request_complete', {
      requestId,
      mode: 'audio'
    });
    return res.status(410).json({ error: 'Request expired' });
  }

  if (requestEntry.status !== 'audio_requested') {
    safeUnlink(req.file.path);
    return res.status(409).json({ error: 'Request is not ready for audio upload' });
  }

  if ((requestEntry.lastActionAt || 0) + COOLDOWN_MS > Date.now()) {
    safeUnlink(req.file.path);
    return res.status(429).json({ error: 'Cooldown active. Please wait.' });
  }

  const stats = fs.statSync(req.file.path);
  const maxSizeBytes = MAX_AUDIO_SECONDS * 16000 * 2;
  if (stats.size > maxSizeBytes) {
    safeUnlink(req.file.path);
    return res.status(400).json({ error: `Audio max ${MAX_AUDIO_SECONDS} seconds` });
  }

  requestEntry.status = 'transcription_processing';
  requestEntry.lastActionAt = Date.now();
  emitRequestState(requestEntry.receiverSocketId, 'processing_started', {
    requestId,
    mode: 'audio',
    stage: 'transcription'
  });

  try {
    const text = await transcribeAudioFile(req.file.path, req.file.mimetype, req.file.originalname);
    requestEntry.status = 'transcription_complete';
    res.json({ requestId, text, message: 'Audio transcription completed' });
  } catch (error) {
    console.error('Audio processing error:', error);
    activeRequests.delete(requestId);
    emitRequestState(requestEntry.receiverSocketId, 'processing_failed', {
      requestId,
      mode: 'audio',
      error: 'Audio processing failed'
    });
    emitRequestState(requestEntry.transmitterSocketId, 'request_complete', {
      requestId,
      mode: 'audio'
    });
    res.status(500).json({ error: 'Audio processing failed' });
  } finally {
    safeUnlink(req.file.path);
  }
});

const socketSessions = new Map();
const transmitterBySession = new Map();
const receiverBySession = new Map();
const activeRequests = new Map();
const REQUEST_TTL_MS = 2 * 60 * 1000;

const emitRequestState = (socketId, event, payload) => {
  if (socketId) {
    io.to(socketId).emit(event, payload);
  }
};

const cleanupExpiredRequests = () => {
  const now = Date.now();

  for (const [requestId, requestEntry] of activeRequests.entries()) {
    if (now - requestEntry.createdAt <= REQUEST_TTL_MS) {
      continue;
    }

    emitRequestState(requestEntry.receiverSocketId, 'processing_failed', {
      requestId,
      mode: requestEntry.mode,
      error: 'Request timed out'
    });
    emitRequestState(requestEntry.transmitterSocketId, 'request_complete', {
      requestId,
      mode: requestEntry.mode
    });
    activeRequests.delete(requestId);
  }
};

setInterval(cleanupExpiredRequests, 30000).unref();

const buildRequest = ({ receiverSocketId, transmitterSocketId, transmitterUsername, sessionId, mode }) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const initialStatus = mode === 'image' ? 'capture_requested' : 'audio_requested';

  const requestEntry = {
    requestId,
    receiverSocketId,
    transmitterSocketId,
    transmitterUsername,
    sessionId,
    mode,
    status: initialStatus,
    createdAt: Date.now(),
    lastActionAt: 0
  };

  activeRequests.set(requestId, requestEntry);
  return requestEntry;
};

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const requestedSessionId = socket.handshake.auth?.sessionId || DEFAULT_SESSION_ID;

  if (!token) {
    return next(new Error('Authentication required'));
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return next(new Error('Invalid token'));
    }

    socket.user = decoded;
    socket.sessionId = requestedSessionId;
    next();
  });
});

io.on('connection', (socket) => {
  const metadata = {
    role: socket.user.role,
    username: socket.user.username,
    sessionId: socket.sessionId
  };

  socketSessions.set(socket.id, metadata);

  if (metadata.role === 'receiver') {
    receiverBySession.set(metadata.sessionId, socket.id);
  }

  if (metadata.role === 'transmitter') {
    transmitterBySession.set(metadata.sessionId, {
      socketId: socket.id,
      username: metadata.username
    });
  }

  socket.join(`session:${metadata.sessionId}`);
  console.log(`Client connected: ${socket.id} (${metadata.role}, ${metadata.sessionId})`);

  socket.emit('session_ready', {
    role: metadata.role,
    sessionId: metadata.sessionId
  });

  socket.on('trigger_capture', () => {
    if (metadata.role !== 'receiver') {
      return;
    }

    const transmitter = transmitterBySession.get(metadata.sessionId);
    if (!transmitter) {
      return emitRequestState(socket.id, 'processing_failed', {
        mode: 'image',
        error: 'No transmitter connected for this session'
      });
    }

    const requestEntry = buildRequest({
      receiverSocketId: socket.id,
      transmitterSocketId: transmitter.socketId,
      transmitterUsername: transmitter.username,
      sessionId: metadata.sessionId,
      mode: 'image'
    });

    emitRequestState(socket.id, 'capture_started', {
      requestId: requestEntry.requestId,
      mode: 'image'
    });
    io.to(transmitter.socketId).emit('do_capture', {
      requestId: requestEntry.requestId,
      sessionId: metadata.sessionId
    });
  });

  socket.on('trigger_audio', () => {
    if (metadata.role !== 'receiver') {
      return;
    }

    const transmitter = transmitterBySession.get(metadata.sessionId);
    if (!transmitter) {
      return emitRequestState(socket.id, 'processing_failed', {
        mode: 'audio',
        error: 'No transmitter connected for this session'
      });
    }

    const requestEntry = buildRequest({
      receiverSocketId: socket.id,
      transmitterSocketId: transmitter.socketId,
      transmitterUsername: transmitter.username,
      sessionId: metadata.sessionId,
      mode: 'audio'
    });

    emitRequestState(socket.id, 'capture_started', {
      requestId: requestEntry.requestId,
      mode: 'audio'
    });
    io.to(transmitter.socketId).emit('do_audio', {
      requestId: requestEntry.requestId,
      sessionId: metadata.sessionId
    });
  });

  socket.on('process_text', async (data) => {
    try {
      if (metadata.role !== 'transmitter') {
        return;
      }

      const { text, requestId } = data;
      const requestEntry = activeRequests.get(requestId);

      if (!requestEntry || requestEntry.transmitterSocketId !== socket.id) {
        return;
      }

      requestEntry.status = 'ai_processing';
      emitRequestState(requestEntry.receiverSocketId, 'processing_started', {
        requestId,
        mode: requestEntry.mode,
        stage: 'ai'
      });

      const cleanQuestion = text; // Bypass cleaning
      const answer = await solveQuestion(cleanQuestion, requestEntry.mode);

      emitRequestState(requestEntry.receiverSocketId, 'result', {
        requestId,
        mode: requestEntry.mode,
        question: cleanQuestion,
        answer
      });
      emitRequestState(requestEntry.transmitterSocketId, 'request_complete', {
        requestId,
        mode: requestEntry.mode
      });
      activeRequests.delete(requestId);
    } catch (error) {
      console.error('AI processing error:', error);
      const { text, requestId } = data;
      const requestEntry = activeRequests.get(requestId);

      if (requestEntry) {
        emitRequestState(requestEntry.receiverSocketId, 'result', {
          requestId,
          mode: requestEntry.mode,
          question: text,
          answer: 'Error processing question'
        });
        emitRequestState(requestEntry.transmitterSocketId, 'request_complete', {
          requestId,
          mode: requestEntry.mode
        });
        activeRequests.delete(requestId);
      } else {
        io.to(socket.id).emit('processing_failed', {
          requestId,
          error: 'Error processing question'
        });
      }
    }
  });

  socket.on('capture_failed', ({ requestId, error }) => {
    const requestEntry = activeRequests.get(requestId);

    if (!requestEntry || requestEntry.transmitterSocketId !== socket.id) {
      return;
    }

    emitRequestState(requestEntry.receiverSocketId, 'processing_failed', {
      requestId,
      mode: requestEntry.mode,
      error: error || 'Capture failed on transmitter'
    });
    emitRequestState(requestEntry.transmitterSocketId, 'request_complete', {
      requestId,
      mode: requestEntry.mode
    });
    activeRequests.delete(requestId);
  });

  socket.on('disconnect', () => {
    socketSessions.delete(socket.id);

    if (metadata.role === 'receiver' && receiverBySession.get(metadata.sessionId) === socket.id) {
      receiverBySession.delete(metadata.sessionId);
    }

    if (metadata.role === 'transmitter') {
      const activeTransmitter = transmitterBySession.get(metadata.sessionId);
      if (activeTransmitter?.socketId === socket.id) {
        transmitterBySession.delete(metadata.sessionId);
      }
    }

    for (const [requestId, requestEntry] of activeRequests.entries()) {
      if (requestEntry.receiverSocketId === socket.id || requestEntry.transmitterSocketId === socket.id) {
        emitRequestState(requestEntry.receiverSocketId, 'processing_failed', {
          requestId,
          mode: requestEntry.mode,
          error: 'Request interrupted by disconnection'
        });
        emitRequestState(requestEntry.transmitterSocketId, 'request_complete', {
          requestId,
          mode: requestEntry.mode
        });
        activeRequests.delete(requestId);
      }
    }

    console.log(`Client disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
