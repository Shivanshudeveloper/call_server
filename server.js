// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CommunicationIdentityClient } = require('@azure/communication-identity');
const { CallAutomationClient } = require('@azure/communication-call-automation');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { PassThrough } = require('stream');
const { SpeechConfig, AudioConfig, SpeechRecognizer, PushAudioInputStream, AudioStreamFormat } = require('microsoft-cognitiveservices-speech-sdk');

ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize Call Automation Client for call transfer
let callAutomationClient = null;

const app = express();
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  req.requestId = requestId;
  const startTime = Date.now();
  
  console.log(`[${requestId}] ${req.method} ${req.path} - Started`);
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`[${requestId}] ${req.method} ${req.path} - Completed ${res.statusCode} (${duration}ms)`);
  });
  
  next();
});

// String
const connectionString = process.env.ACS_CONNECTION_STRING; 
if (!connectionString) {
    console.error("Please set the ACS_CONNECTION_STRING in your .env file!");
    process.exit(1);
}

const identityClient = new CommunicationIdentityClient(connectionString);

// Initialize Call Automation Client
try {
  callAutomationClient = new CallAutomationClient(connectionString);
  console.log('Call Automation Client initialized successfully');
} catch (error) {
  console.error('Failed to initialize Call Automation Client:', error.message);
}

// Configure multer with limits for concurrent uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
    files: 1
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Token generation endpoint - supports concurrent requests
app.get('/token', async (req, res) => {
  const requestId = req.requestId;
  
  try {
    console.log(`[${requestId}] Creating new ACS user and token`);
    
    // Each request gets its own user identity - perfectly fine for concurrent requests
    const user = await identityClient.createUser();
    const tokenResponse = await identityClient.getToken(user, ["voip"]);

    console.log(`[${requestId}] Token generated successfully for user: ${user.communicationUserId}`);

    res.json({
      userId: user.communicationUserId,
      token: tokenResponse.token,
      expiresOn: tokenResponse.expiresOn
    });
  } catch (error) {
    console.error(`[${requestId}] Error generating token:`, error.message);
    res.status(500).json({ 
      error: "Error generating token",
      message: error.message 
    });
  }
});

// Callbacks endpoint for Call Automation events (kept for future use)
app.post('/callbacks', async (req, res) => {
  const requestId = req.requestId;
  
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    
    for (const event of events) {
      console.log(`[${requestId}] Received callback event:`, event.type || 'unknown');
      
      // Handle different event types as needed
      if (event.type === 'Microsoft.Communication.CallConnected') {
        console.log(`[${requestId}] Call connected`);
      } else if (event.type === 'Microsoft.Communication.CallDisconnected') {
        console.log(`[${requestId}] Call disconnected`);
      } else if (event.type === 'Microsoft.Communication.CallTransferAccepted') {
        console.log(`[${requestId}] Call transfer accepted`);
      } else if (event.type === 'Microsoft.Communication.CallTransferFailed') {
        console.log(`[${requestId}] Call transfer failed`);
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error(`[${requestId}] Callback error:`, error);
    res.sendStatus(500);
  }
});

// Function to convert webm to PCM buffer - handles concurrent conversions
const convertWebmToPcm = (webmBuffer, requestId) => {
  return new Promise((resolve, reject) => {
    const timeoutMs = 30000; // 30 second timeout
    let isResolved = false;
    
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.error(`[${requestId}] FFmpeg conversion timeout after ${timeoutMs}ms`);
        reject(new Error('Audio conversion timeout'));
      }
    }, timeoutMs);
    
    const inputStream = new PassThrough();
    inputStream.end(webmBuffer);

    const pcmChunks = [];

    console.log(`[${requestId}] Starting audio conversion (${(webmBuffer.length / 1024).toFixed(2)} KB)`);

    ffmpeg(inputStream)
      .inputFormat('webm')
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('s16le')
      .on('error', (err) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          console.error(`[${requestId}] Error converting audio:`, err.message);
          reject(err);
        }
      })
      .pipe()
      .on('data', (chunk) => {
        pcmChunks.push(chunk);
      })
      .on('end', () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          const totalSize = (Buffer.concat(pcmChunks).length / 1024).toFixed(2);
          console.log(`[${requestId}] Audio conversion completed (${totalSize} KB PCM)`);
          resolve(Buffer.concat(pcmChunks));
        }
      })
      .on('error', (err) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          console.error(`[${requestId}] Error in ffmpeg pipe:`, err.message);
          reject(err);
        }
      });
  });
};

// STT endpoint - handles concurrent transcription requests
app.post('/stt', upload.single('audio'), async (req, res) => {
  const requestId = req.requestId;
  let recognizer = null;
  
  try {
    const speechKey = process.env.SPEECH_KEY;
    const speechRegion = process.env.SPEECH_REGION;

    if (!speechKey || !speechRegion) {
      console.error(`[${requestId}] Speech service credentials not configured`);
      return res.status(500).json({ error: 'Speech service credentials not set.' });
    }

    if (!req.file || !req.file.buffer) {
      console.error(`[${requestId}] No audio file provided`);
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const audioBuffer = req.file.buffer;
    console.log(`[${requestId}] Received audio file: ${req.file.originalname || 'unnamed'} (${(audioBuffer.length / 1024).toFixed(2)} KB)`);

    // Convert webm to PCM - each request gets its own conversion
    const pcmBuffer = await convertWebmToPcm(audioBuffer, requestId);

    // Create a push stream with the correct format
    const format = AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
    const pushStream = PushAudioInputStream.createPushStream(format);

    // Write the PCM buffer to the push stream
    pushStream.write(pcmBuffer);
    pushStream.close();

    const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechRecognitionLanguage = "en-US";

    const audioConfig = AudioConfig.fromStreamInput(pushStream);
    recognizer = new SpeechRecognizer(speechConfig, audioConfig);

    console.log(`[${requestId}] Starting speech recognition`);

    // Wrap in promise with timeout for better error handling
    const transcriptionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Speech recognition timeout'));
      }, 60000); // 60 second timeout

      recognizer.recognizeOnceAsync(
        result => {
          clearTimeout(timeout);
          let text = '';
          if (result && result.text) {
            text = result.text;
          }
          console.log(`[${requestId}] Transcription completed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
          resolve(text);
        },
        error => {
          clearTimeout(timeout);
          console.error(`[${requestId}] Speech recognition error:`, error);
          reject(error);
        }
      );
    });

    const text = await transcriptionPromise;
    
    // Clean up recognizer
    if (recognizer) {
      recognizer.close();
      recognizer = null;
    }

    return res.json({ text, requestId });

  } catch (error) {
    console.error(`[${requestId}] Transcription error:`, error.message);
    
    // Clean up recognizer on error
    if (recognizer) {
      try {
        recognizer.close();
      } catch (closeError) {
        console.error(`[${requestId}] Error closing recognizer:`, closeError.message);
      }
    }
    
    res.status(500).json({ 
      error: 'Transcription error',
      message: error.message,
      requestId
    });
  }
});

// Error handling for uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const port = process.env.PORT || 8080;
const server = app.listen(port, () => {
  console.log(`🚀 Call Server is running on port ${port}`);
  console.log(`📞 Token endpoint: http://localhost:${port}/token`);
  console.log(`🎙️  STT endpoint: http://localhost:${port}/stt`);
  console.log(`📲 Callbacks endpoint: http://localhost:${port}/callbacks`);
  console.log(`💚 Health check: http://localhost:${port}/health`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});