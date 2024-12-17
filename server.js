// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { CommunicationIdentityClient } = require('@azure/communication-identity');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { PassThrough } = require('stream');
const { SpeechConfig, AudioConfig, SpeechRecognizer, PushAudioInputStream, AudioStreamFormat } = require('microsoft-cognitiveservices-speech-sdk');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());

const connectionString = process.env.ACS_CONNECTION_STRING; 
if (!connectionString) {
    console.error("Please set the ACS_CONNECTION_STRING in your .env file!");
    process.exit(1);
}

const identityClient = new CommunicationIdentityClient(connectionString);
const upload = multer(); // for handling multipart form data in-memory

app.get('/token', async (req, res) => {
  try {
    const user = await identityClient.createUser();
    const tokenResponse = await identityClient.getToken(user, ["voip"]);

    res.json({
      userId: user.communicationUserId,
      token: tokenResponse.token,
      expiresOn: tokenResponse.expiresOn
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error generating token");
  }
});

// Function to convert webm to PCM buffer
const convertWebmToPcm = (webmBuffer) => {
  return new Promise((resolve, reject) => {
    const inputStream = new PassThrough();
    inputStream.end(webmBuffer);

    const pcmChunks = [];

    ffmpeg(inputStream)
      .inputFormat('webm')
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('s16le')
      .on('error', (err) => {
        console.error('Error converting audio:', err);
        reject(err);
      })
      .pipe()
      .on('data', (chunk) => {
        pcmChunks.push(chunk);
      })
      .on('end', () => {
        resolve(Buffer.concat(pcmChunks));
      })
      .on('error', (err) => {
        console.error('Error in ffmpeg pipe:', err);
        reject(err);
      });
  });
};

// STT endpoint
app.post('/stt', upload.single('audio'), async (req, res) => {
  try {
    const speechKey = process.env.SPEECH_KEY;
    const speechRegion = process.env.SPEECH_REGION;

    if (!speechKey || !speechRegion) {
      return res.status(500).json({ error: 'Speech service credentials not set.' });
    }

    const audioBuffer = req.file.buffer;

    // Convert webm to PCM
    const pcmBuffer = await convertWebmToPcm(audioBuffer);

    // Create a push stream with the correct format
    const format = AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
    const pushStream = PushAudioInputStream.createPushStream(format);

    // Write the PCM buffer to the push stream
    pushStream.write(pcmBuffer);
    pushStream.close();

    const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechRecognitionLanguage = "en-US";

    const audioConfig = AudioConfig.fromStreamInput(pushStream);
    const recognizer = new SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizeOnceAsync(result => {
      let text = '';
      if (result && result.text) {
        text = result.text;
      }
      recognizer.close();
      return res.json({ text });
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Transcription error' });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
